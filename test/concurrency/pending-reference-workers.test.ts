import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { AppInstance } from '../support/cluster';
import { CONCURRENCY_TIMEOUT_MS } from '../support/concurrency-suite';
import { expectConsistentWallets } from '../support/consistency';
import { createIsolatedDatabase, type IsolatedDatabase } from '../support/database';
import { transactionState, walletState } from '../support/inspect';
import { waitUntil } from '../support/sync';
import { allWalletIds, type FixtureWallet, wageringFixture } from '../support/wagering-fixture';

/**
 * Dois workers de PENDING_REFERENCE em processos reais (papel `pending-ref`) sobre os mesmos
 * candidatos, com relógio real. Lotes pequenos e poll curto fazem os dois disputarem as mesmas
 * transações o tempo todo. Limite de 3 tentativas: a rejeição sai em ~7 s (1 + 2 + 4).
 */

const suffix = () => randomBytes(3).toString('hex');

describe('worker de PENDING_REFERENCE em processos reais', () => {
  let db: IsolatedDatabase;
  let fixture: ReturnType<typeof wageringFixture>;
  const instances: AppInstance[] = [];

  beforeAll(async () => {
    db = await createIsolatedDatabase();
    fixture = wageringFixture(db.orm);
  }, CONCURRENCY_TIMEOUT_MS);

  afterEach(async () => {
    for (const instance of instances.splice(0)) {
      await instance.kill();
    }
    await expectConsistentWallets(db.orm, await allWalletIds(db.orm));
  }, CONCURRENCY_TIMEOUT_MS);

  afterAll(async () => {
    await db.drop();
  });

  test(
    'REFUND/ROLLBACK antes da referência e referências que nunca chegam: cada uma resolvida uma vez',
    async () => {
      const env = {
        ROLE: 'pending-ref',
        DATABASE_URL: db.url,
        PENDING_REF_POLL_INTERVAL_MS: '20',
        PENDING_REF_BATCH_SIZE: '5',
        PENDING_REF_MAX_ATTEMPTS: '3',
      };
      const prefix = `pr${suffix()}`;
      instances.push(
        ...(await Promise.all([
          AppInstance.start(`${prefix}-1`, env),
          AppInstance.start(`${prefix}-2`, env),
        ])),
      );

      // 20 wallets: a reversão chega antes da referência, que chega logo depois
      const resolved: { wallet: FixtureWallet; reversalId: string; expectedBalance: string }[] = [];
      for (let i = 0; i < 20; i += 1) {
        const wallet = await fixture.openWallet('100.00');
        const referenceId = `ref-${randomUUID()}`;
        const isRefund = i % 2 === 0;
        const reversal = await fixture.wager(wallet, {
          kind: isRefund ? 'REFUND' : 'ROLLBACK',
          amount: '20.00',
          referenceExternalTransactionId: referenceId,
        });
        expect(reversal.status as string).toBe('PENDING_REFERENCE');
        await fixture.wager(wallet, {
          kind: isRefund ? 'BET' : 'WIN',
          amount: '20.00',
          externalTransactionId: referenceId,
        });
        resolved.push({ wallet, reversalId: reversal.transactionId, expectedBalance: '100.00' });
      }
      // 10 wallets: a referência nunca chega
      const lost: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const wallet = await fixture.openWallet('100.00');
        const refund = await fixture.wager(wallet, {
          kind: 'REFUND',
          amount: '5.00',
          referenceExternalTransactionId: `never-${randomUUID()}`,
        });
        lost.push(refund.transactionId);
      }

      await waitUntil(
        'nenhuma transação em PENDING_REFERENCE',
        async () => {
          const [row] = await db.orm.em
            .fork()
            .execute<{ n: number }[]>(
              `select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE'`,
            );
          return row?.n === 0;
        },
        25_000,
      );

      for (const { wallet, reversalId, expectedBalance } of resolved) {
        expect(await transactionState(db.orm, reversalId)).toMatchObject({
          status: 'PROCESSED',
          referenceAttempts: 0,
        });
        expect((await walletState(db.orm, wallet.walletId)).balance).toBe(expectedBalance);
      }
      for (const refundId of lost) {
        // dois workers disputando: cada tentativa contada uma vez (nem 4, nem 6)
        expect(await transactionState(db.orm, refundId)).toMatchObject({
          status: 'REJECTED',
          failureCode: 'REFERENCE_NOT_FOUND',
          referenceAttempts: 3,
          nextAttemptAt: null,
        });
      }
      expect(instances.every((instance) => instance.alive)).toBe(true);
      // a checagem final (afterEach) confere os eventos exatos de cada desfecho: PendingReference
      // + Processed + BalanceChanged, ou PendingReference + Rejected, sem duplicatas
    },
    CONCURRENCY_TIMEOUT_MS,
  );
});
