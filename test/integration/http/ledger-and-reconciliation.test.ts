import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  ReconcileWallet,
  type ReconciliationDivergence,
  type ReconciliationMonitor,
} from '../../../src/application';
import { MikroOrmReconciliationReader } from '../../../src/infrastructure/database/reconciliation-reader';
import { expectBalanceMatchesLedger, inTransaction } from '../../support/database';
import {
  type CreatedWallet,
  createWallet,
  startTestApp,
  submitWager,
  type TestApp,
} from '../../support/http-app';
import { walletState } from '../../support/inspect';

describe('ledger e reconciliação (HTTP + Postgres real)', () => {
  let app: TestApp;
  const wallets = new Set<string>();

  const open = async (initial: string): Promise<CreatedWallet> => {
    const wallet = await createWallet(app, initial);
    wallets.add(wallet.id);
    return wallet;
  };
  const ledgerPage = (walletId: string, query = '') =>
    app.request('GET', `/wallets/${walletId}/ledger${query}`);

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterEach(async () => {
    await expectBalanceMatchesLedger(app.orm, wallets);
    wallets.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /wallets/:id/ledger', () => {
    test('lista do mais antigo ao mais novo; sem limit usa o padrão e não há próxima página', async () => {
      const wallet = await open('100.00');
      await submitWager(app, wallet, { kind: 'BET', amount: '30.00' });
      await submitWager(app, wallet, { kind: 'WIN', amount: '5.50' });
      const res = await ledgerPage(wallet.id);
      expect(res.status).toBe(200);
      expect(res.body.walletId).toBe(wallet.id);
      expect(res.body.nextCursor).toBeNull();
      expect(res.body.entries).toHaveLength(3);
      expect(res.body.entries[1]).toEqual({
        id: expect.any(String),
        transactionId: expect.any(String),
        direction: 'DEBIT',
        money: { amount: '30.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '70.00', currency: 'BRL' },
        walletVersion: 2,
        createdAt: expect.any(String),
      });
      expect(res.body.entries.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([
        1, 2, 3,
      ]);
    });

    test('cursor é estável: lançamentos novos no meio da paginação não repetem nem pulam', async () => {
      const wallet = await open('100.00');
      for (let i = 0; i < 4; i += 1) {
        await submitWager(app, wallet, { kind: 'BET', amount: '1.00' });
      }
      const versions: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await ledgerPage(wallet.id, query);
        expect(res.status).toBe(200);
        expect(res.body.entries.length).toBeLessThanOrEqual(2);
        versions.push(...res.body.entries.map((e: { walletVersion: number }) => e.walletVersion));
        cursor = res.body.nextCursor;
        pages += 1;
        if (pages === 1) {
          // chega um lançamento novo depois da primeira página
          await submitWager(app, wallet, { kind: 'WIN', amount: '2.00' });
        }
      } while (cursor !== null);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6]);
      expect(pages).toBe(3);
    });

    test('wallet sem lançamentos → lista vazia', async () => {
      const wallet = await open('0.00');
      const res = await ledgerPage(wallet.id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ walletId: wallet.id, entries: [], nextCursor: null });
    });

    test('cursor inválido, adulterado ou de outra wallet → 400 INVALID_CURSOR', async () => {
      const wallet = await open('100.00');
      const other = await open('100.00');
      await submitWager(app, other, { kind: 'BET', amount: '1.00' });
      const otherCursor = (await ledgerPage(other.id, '?limit=1')).body.nextCursor as string;
      const forged = Buffer.from(JSON.stringify({ v: 1, w: wallet.id, after: 0 })).toString(
        'base64url',
      );
      for (const cursor of ['nao-e-base64!', 'eyJ2Ijo', otherCursor, forged]) {
        const res = await ledgerPage(wallet.id, `?cursor=${encodeURIComponent(cursor)}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({ code: 'INVALID_CURSOR', category: 'validation' });
      }
    });

    test.each(['0', '201', 'x', '-1', '1.5'])('limit=%s → 400 INVALID_LIMIT', async (limit) => {
      const wallet = await open('1.00');
      const res = await ledgerPage(wallet.id, `?limit=${limit}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_LIMIT');
    });

    test('wallet inexistente → 404', async () => {
      const res = await ledgerPage(randomUUID());
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
    });
  });

  describe('POST /wallets/:id/reconciliation', () => {
    const reconcile = (walletId: string) =>
      app.request('POST', `/wallets/${walletId}/reconciliation`);

    test('wallet consistente: saldo == créditos − débitos, diferença 0.00', async () => {
      const wallet = await open('100.00');
      await submitWager(app, wallet, { kind: 'BET', amount: '30.00' });
      await submitWager(app, wallet, { kind: 'WIN', amount: '10.25' });
      await submitWager(app, wallet, { kind: 'LOSS', amount: '0.00' });
      await submitWager(app, wallet, { kind: 'BET', amount: '500.00' }); // REJECTED: sem lançamento
      const res = await reconcile(wallet.id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        walletId: wallet.id,
        storedBalance: { amount: '80.25', currency: 'BRL' },
        calculatedBalance: { amount: '80.25', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 3,
      });
    });

    test('wallet sem lançamentos é consistente com 0 lançamentos conferidos', async () => {
      const wallet = await open('0.00');
      const res = await reconcile(wallet.id);
      expect(res.body).toMatchObject({
        storedBalance: { amount: '0.00' },
        calculatedBalance: { amount: '0.00' },
        consistent: true,
        checkedEntries: 0,
      });
    });

    describe('divergência simulada (triggers desligados só na sessão que adultera)', () => {
      // A wallet adulterada fica inconsistente de propósito: não entra na checagem do afterEach.
      const tamper = async (delta: string, direction: '+' | '-') => {
        const wallet = await createWallet(app, '100.00');
        await submitWager(app, wallet, { kind: 'BET', amount: '20.00' });
        await inTransaction(app.orm, async (em) => {
          await em.execute('set local session_replication_role = replica');
          await em.execute(
            `update wallets set balance = balance ${direction} ?::numeric where id = ?`,
            [delta, wallet.id],
          );
        });
        return wallet;
      };

      test('saldo acima do ledger → consistent false, diferença positiva, nada corrigido', async () => {
        const wallet = await tamper('1.50', '+');
        const res = await reconcile(wallet.id);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          walletId: wallet.id,
          storedBalance: { amount: '81.50', currency: 'BRL' },
          calculatedBalance: { amount: '80.00', currency: 'BRL' },
          difference: { amount: '1.50', currency: 'BRL' },
          consistent: false,
          checkedEntries: 2,
        });
        // divergência não é corrigida silenciosamente
        expect((await walletState(app.orm, wallet.id)).balance).toBe('81.50');
      });

      test('saldo abaixo do ledger → diferença negativa, e o monitor é avisado', async () => {
        const wallet = await tamper('5.00', '-');
        const seen: ReconciliationDivergence[] = [];
        const monitor: ReconciliationMonitor = { divergenceDetected: (d) => seen.push(d) };
        const useCase = new ReconcileWallet(new MikroOrmReconciliationReader(app.orm), monitor);

        const report = await useCase.execute(wallet.id);
        expect(report).toMatchObject({
          storedBalance: { amount: '75.00' },
          calculatedBalance: { amount: '80.00' },
          difference: { amount: '-5.00', currency: 'BRL' },
          consistent: false,
        });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.walletId).toBe(wallet.id);
        expect(seen[0]?.difference.toJSON()).toEqual({ amount: '-5.00', currency: 'BRL' });
      });
    });

    test('wallet inexistente → 404; id que não é UUID → 400', async () => {
      expect((await reconcile(randomUUID())).status).toBe(404);
      expect((await reconcile('abc')).status).toBe(400);
    });
  });
});
