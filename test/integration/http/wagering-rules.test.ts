import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { expectBalanceMatchesLedger } from '../../support/database';
import {
  type CreatedWallet,
  createWallet,
  startTestApp,
  submitRaw,
  submitWager,
  type TestApp,
  type TestResponse,
  type WagerRequest,
  wagerBody,
} from '../../support/http-app';
import {
  ledgerOf,
  outboxEventTypes,
  outboxOfTransaction,
  transactionState,
  transactionsByKey,
  walletState,
} from '../../support/inspect';

describe('regras de negócio de ProcessWagerTransaction (HTTP + Postgres real)', () => {
  let app: TestApp;
  const wallets = new Set<string>();

  const open = async (
    initial: string,
    options?: { currency?: string; playerId?: string },
  ): Promise<CreatedWallet> => {
    const wallet = await createWallet(app, initial, options);
    wallets.add(wallet.id);
    return wallet;
  };
  const submit = (wallet: CreatedWallet, input: WagerRequest) => submitWager(app, wallet, input);

  const expectProcessed = (res: TestResponse, balance: string): string => {
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: balance },
      idempotentReplay: false,
    });
    return res.body.transactionId;
  };

  const expectRejected = (res: TestResponse, failureCode: string, balance: string): string => {
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      failureCode,
      balance: { amount: balance },
      idempotentReplay: false,
    });
    return res.body.transactionId;
  };

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

  describe('BET', () => {
    test('debita: 201, lançamento DEBIT, version + 1, eventos Processed e BalanceChanged', async () => {
      const wallet = await open('100.00');
      const res = await submit(wallet, { kind: 'BET', amount: '25.00' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        transactionId: expect.any(String),
        status: 'PROCESSED',
        balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      const id: string = res.body.transactionId;

      expect(await walletState(app.orm, wallet.id)).toEqual({
        balance: '75.00',
        currency: 'BRL',
        version: 2,
      });
      expect((await ledgerOf(app.orm, wallet.id)).at(-1)).toEqual({
        transactionId: id,
        direction: 'DEBIT',
        amount: '25.00',
        balanceBefore: '100.00',
        balanceAfter: '75.00',
        walletVersion: 2,
      });
      expect(await transactionState(app.orm, id)).toMatchObject({
        status: 'PROCESSED',
        balanceAfter: '75.00',
        failureCode: null,
      });
      const events = await outboxOfTransaction(app.orm, id);
      expect(events.map((e) => e.eventType)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      expect(events[1]?.aggregateId).toBe(wallet.id);
      expect(events[1]?.payload.data).toMatchObject({
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      });
    });

    test('apostar o saldo inteiro deixa 0.00', async () => {
      const wallet = await open('10.00');
      expectProcessed(await submit(wallet, { kind: 'BET', amount: '10.00' }), '0.00');
    });

    test('sem saldo → 422 INSUFFICIENT_FUNDS: REJECTED auditável, sem lançamento e sem version', async () => {
      const wallet = await open('10.00');
      const res = await submit(wallet, { kind: 'BET', amount: '10.01' });
      expect(res.body).toEqual({
        transactionId: expect.any(String),
        status: 'REJECTED',
        balance: { amount: '10.00', currency: 'BRL' },
        failureCode: 'INSUFFICIENT_FUNDS',
        providerAction: 'give_up',
        idempotentReplay: false,
      });
      const id = expectRejected(res, 'INSUFFICIENT_FUNDS', '10.00');

      expect(await walletState(app.orm, wallet.id)).toMatchObject({ balance: '10.00', version: 1 });
      expect(await ledgerOf(app.orm, wallet.id)).toHaveLength(1);
      expect(await transactionState(app.orm, id)).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balanceAfter: '10.00',
      });
      const events = await outboxOfTransaction(app.orm, id);
      expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionRejected']);
      expect(events[0]?.payload.data).toMatchObject({
        failureCode: 'INSUFFICIENT_FUNDS',
        providerAction: 'give_up',
      });
    });
  });

  describe('WIN', () => {
    test('credita: lançamento CREDIT', async () => {
      const wallet = await open('100.00');
      expectProcessed(await submit(wallet, { kind: 'BET', amount: '30.00' }), '70.00');
      const id = expectProcessed(await submit(wallet, { kind: 'WIN', amount: '50.00' }), '120.00');
      expect((await ledgerOf(app.orm, wallet.id)).at(-1)).toMatchObject({
        transactionId: id,
        direction: 'CREDIT',
        balanceBefore: '70.00',
        balanceAfter: '120.00',
        walletVersion: 3,
      });
    });

    test('referência à BET é informativa: não é resolvida nem exigida', async () => {
      const wallet = await open('100.00');
      const bet = await submit(wallet, { kind: 'BET', amount: '10.00' });
      const win = await submit(wallet, {
        kind: 'WIN',
        amount: '20.00',
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      const id = expectProcessed(win, '110.00');
      expect((await transactionState(app.orm, id)).referenceTransactionId).toBeNull();

      // referência a uma BET que não existe também não deixa o WIN pendente
      expectProcessed(
        await submit(wallet, {
          kind: 'WIN',
          amount: '5.00',
          referenceExternalTransactionId: 'bet-que-nao-existe',
        }),
        '115.00',
      );
    });
  });

  describe('LOSS', () => {
    test('registra sem mover saldo: 201, sem lançamento, version igual, só WagerTransactionProcessed', async () => {
      const wallet = await open('100.00');
      expectProcessed(await submit(wallet, { kind: 'BET', amount: '20.00' }), '80.00');
      const id = expectProcessed(await submit(wallet, { kind: 'LOSS', amount: '0.00' }), '80.00');

      expect(await walletState(app.orm, wallet.id)).toMatchObject({ balance: '80.00', version: 2 });
      expect(await ledgerOf(app.orm, wallet.id)).toHaveLength(2);
      expect(await outboxEventTypes(app.orm, id)).toEqual(['WagerTransactionProcessed']);
    });

    test('LOSS com valor > 0 também não move saldo', async () => {
      const wallet = await open('50.00');
      expectProcessed(await submit(wallet, { kind: 'LOSS', amount: '20.00' }), '50.00');
      expect(await walletState(app.orm, wallet.id)).toMatchObject({ balance: '50.00', version: 1 });
    });
  });

  describe('REFUND', () => {
    test('de uma BET PROCESSED: credita o mesmo valor e liga a referência', async () => {
      const wallet = await open('100.00');
      const bet = await submit(wallet, { kind: 'BET', amount: '40.00' });
      const betId = expectProcessed(bet, '60.00');
      const id = expectProcessed(
        await submit(wallet, {
          kind: 'REFUND',
          amount: '40.00',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
        '100.00',
      );
      expect((await transactionState(app.orm, id)).referenceTransactionId).toBe(betId);
      expect((await ledgerOf(app.orm, wallet.id)).at(-1)).toMatchObject({
        transactionId: id,
        direction: 'CREDIT',
        amount: '40.00',
      });
      expect(await outboxEventTypes(app.orm, id)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
    });

    test('segundo REFUND da mesma BET → 422 ALREADY_REVERSED, sem crédito duplicado', async () => {
      const wallet = await open('100.00');
      const bet = await submit(wallet, { kind: 'BET', amount: '40.00' });
      const refund = {
        kind: 'REFUND',
        amount: '40.00',
        referenceExternalTransactionId: bet.externalTransactionId,
      };
      expectProcessed(await submit(wallet, refund), '100.00');
      expectRejected(await submit(wallet, refund), 'ALREADY_REVERSED', '100.00');
      expect(await ledgerOf(app.orm, wallet.id)).toHaveLength(3);
    });

    test('de um WIN → 422 REFERENCE_INVALID_KIND', async () => {
      const wallet = await open('100.00');
      const win = await submit(wallet, { kind: 'WIN', amount: '10.00' });
      expectRejected(
        await submit(wallet, {
          kind: 'REFUND',
          amount: '10.00',
          referenceExternalTransactionId: win.externalTransactionId,
        }),
        'REFERENCE_INVALID_KIND',
        '110.00',
      );
    });

    test('valor diferente da BET → 422 AMOUNT_MISMATCH (reversão parcial fora de escopo)', async () => {
      const wallet = await open('100.00');
      const bet = await submit(wallet, { kind: 'BET', amount: '40.00' });
      expectRejected(
        await submit(wallet, {
          kind: 'REFUND',
          amount: '39.99',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
        'AMOUNT_MISMATCH',
        '60.00',
      );
    });

    test('outra rodada → 422 REFERENCE_MISMATCH', async () => {
      const wallet = await open('100.00');
      const bet = await submit(wallet, { kind: 'BET', amount: '40.00', roundId: 'round-1' });
      expectRejected(
        await submit(wallet, {
          kind: 'REFUND',
          amount: '40.00',
          roundId: 'round-2',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
        'REFERENCE_MISMATCH',
        '60.00',
      );
    });

    test('BET de outra wallet do mesmo provedor → 422 REFERENCE_MISMATCH', async () => {
      const walletA = await open('100.00');
      const walletB = await open('100.00');
      const betOnA = await submit(walletA, { kind: 'BET', amount: '40.00' });
      const id = expectRejected(
        await submit(walletB, {
          kind: 'REFUND',
          amount: '40.00',
          referenceExternalTransactionId: betOnA.externalTransactionId,
        }),
        'REFERENCE_MISMATCH',
        '100.00',
      );
      expect((await transactionState(app.orm, id)).referenceTransactionId).toBeNull();
    });

    test('BET REJECTED → 422 REFERENCE_NOT_PROCESSED', async () => {
      const wallet = await open('10.00');
      const bet = await submit(wallet, { kind: 'BET', amount: '50.00' });
      expectRejected(bet, 'INSUFFICIENT_FUNDS', '10.00');
      expectRejected(
        await submit(wallet, {
          kind: 'REFUND',
          amount: '50.00',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
        'REFERENCE_NOT_PROCESSED',
        '10.00',
      );
    });
  });

  describe('ROLLBACK', () => {
    test('de uma BET: credita (inverso do débito)', async () => {
      const wallet = await open('100.00');
      const bet = await submit(wallet, { kind: 'BET', amount: '25.00' });
      const id = expectProcessed(
        await submit(wallet, {
          kind: 'ROLLBACK',
          amount: '25.00',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
        '100.00',
      );
      expect((await ledgerOf(app.orm, wallet.id)).at(-1)).toMatchObject({
        transactionId: id,
        direction: 'CREDIT',
      });
    });

    test('de um WIN: debita (inverso do crédito)', async () => {
      const wallet = await open('100.00');
      const win = await submit(wallet, { kind: 'WIN', amount: '30.00' });
      const id = expectProcessed(
        await submit(wallet, {
          kind: 'ROLLBACK',
          amount: '30.00',
          referenceExternalTransactionId: win.externalTransactionId,
        }),
        '100.00',
      );
      expect((await ledgerOf(app.orm, wallet.id)).at(-1)).toMatchObject({
        transactionId: id,
        direction: 'DEBIT',
        balanceBefore: '130.00',
        balanceAfter: '100.00',
      });
    });

    test('que deixaria saldo negativo → 422 REVERSAL_INSUFFICIENT_FUNDS (≠ INSUFFICIENT_FUNDS)', async () => {
      const wallet = await open('0.00');
      const win = await submit(wallet, { kind: 'WIN', amount: '50.00' });
      expectProcessed(await submit(wallet, { kind: 'BET', amount: '40.00' }), '10.00');
      const res = await submit(wallet, {
        kind: 'ROLLBACK',
        amount: '50.00',
        referenceExternalTransactionId: win.externalTransactionId,
      });
      const id = expectRejected(res, 'REVERSAL_INSUFFICIENT_FUNDS', '10.00');
      expect(res.body.providerAction).toBe('investigate');
      expect(await transactionState(app.orm, id)).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
      });
      expect(await walletState(app.orm, wallet.id)).toMatchObject({ balance: '10.00', version: 3 });
    });

    test('de um REFUND: debita (desfaz o estorno)', async () => {
      const wallet = await open('100.00');
      const bet = await submit(wallet, { kind: 'BET', amount: '30.00' });
      const refund = await submit(wallet, {
        kind: 'REFUND',
        amount: '30.00',
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expectProcessed(refund, '100.00');
      const id = expectProcessed(
        await submit(wallet, {
          kind: 'ROLLBACK',
          amount: '30.00',
          referenceExternalTransactionId: refund.externalTransactionId,
        }),
        '70.00',
      );
      expect((await ledgerOf(app.orm, wallet.id)).at(-1)).toMatchObject({
        transactionId: id,
        direction: 'DEBIT',
      });
    });

    test('depois de um REFUND da mesma BET → 422 ALREADY_REVERSED (não credita duas vezes)', async () => {
      const wallet = await open('100.00');
      const bet = await submit(wallet, { kind: 'BET', amount: '30.00' });
      const reference = {
        amount: '30.00',
        referenceExternalTransactionId: bet.externalTransactionId,
      };
      expectProcessed(await submit(wallet, { kind: 'REFUND', ...reference }), '100.00');
      expectRejected(
        await submit(wallet, { kind: 'ROLLBACK', ...reference }),
        'ALREADY_REVERSED',
        '100.00',
      );
    });

    test('de um LOSS → 422 REFERENCE_INVALID_KIND', async () => {
      const wallet = await open('100.00');
      const loss = await submit(wallet, { kind: 'LOSS', amount: '0.00' });
      expectRejected(
        await submit(wallet, {
          kind: 'ROLLBACK',
          amount: '0.01',
          referenceExternalTransactionId: loss.externalTransactionId,
        }),
        'REFERENCE_INVALID_KIND',
        '100.00',
      );
    });

    test('auto-referência → 422 REFERENCE_INVALID_KIND na hora (não fica esperando a si mesma)', async () => {
      const wallet = await open('100.00');
      const externalTransactionId = `ext-${randomUUID()}`;
      expectRejected(
        await submit(wallet, {
          kind: 'ROLLBACK',
          amount: '10.00',
          externalTransactionId,
          referenceExternalTransactionId: externalTransactionId,
        }),
        'REFERENCE_INVALID_KIND',
        '100.00',
      );
    });
  });

  describe('PENDING_REFERENCE', () => {
    test('REFUND antes da BET → 202: sem lançamento, retry agendado, evento PendingReference', async () => {
      const wallet = await open('100.00');
      const betExternalId = `bet-${randomUUID()}`;
      const res = await submit(wallet, {
        kind: 'REFUND',
        amount: '10.00',
        referenceExternalTransactionId: betExternalId,
      });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        transactionId: expect.any(String),
        status: 'PENDING_REFERENCE',
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      const id: string = res.body.transactionId;
      const state = await transactionState(app.orm, id);
      expect(state).toMatchObject({
        status: 'PENDING_REFERENCE',
        referenceAttempts: 0,
        referenceTransactionId: null,
      });
      expect(Date.parse(state.nextAttemptAt ?? '')).toBeGreaterThan(0);
      expect(await ledgerOf(app.orm, wallet.id)).toHaveLength(1);
      expect(await outboxEventTypes(app.orm, id)).toEqual(['WagerTransactionPendingReference']);

      // A BET chega depois e é processada normalmente; o REFUND fica para o worker (fase 7).
      expectProcessed(
        await submit(wallet, {
          kind: 'BET',
          amount: '10.00',
          externalTransactionId: betExternalId,
        }),
        '90.00',
      );
      expect((await transactionState(app.orm, id)).status).toBe('PENDING_REFERENCE');
    });

    test('a referência é resolvida dentro do provedor: BET do provider-a não serve ao provider-b', async () => {
      const wallet = await open('100.00');
      const bet = await submit(wallet, { kind: 'BET', amount: '10.00', providerId: 'provider-a' });
      const res = await submit(wallet, {
        kind: 'REFUND',
        amount: '10.00',
        providerId: 'provider-b',
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expect(res.status).toBe(202);
      expect(res.body.status).toBe('PENDING_REFERENCE');
    });
  });

  describe('wallet', () => {
    test('moeda diferente da wallet → 422 CURRENCY_MISMATCH, snapshot na moeda da wallet', async () => {
      const wallet = await open('50.00', { currency: 'USD' });
      const res = await submit(wallet, { kind: 'BET', amount: '10.00', currency: 'BRL' });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'CURRENCY_MISMATCH',
        balance: { amount: '50.00', currency: 'USD' },
      });
      expect(await transactionState(app.orm, res.body.transactionId)).toMatchObject({
        balanceAfter: '50.00',
        balanceAfterCurrency: 'USD',
      });
      expect(await walletState(app.orm, wallet.id)).toMatchObject({ balance: '50.00', version: 1 });
    });

    test('wallet de outro player → 422 WALLET_PLAYER_MISMATCH', async () => {
      const wallet = await open('50.00');
      expectRejected(
        await submit(wallet, { kind: 'BET', amount: '10.00', playerId: randomUUID() }),
        'WALLET_PLAYER_MISMATCH',
        '50.00',
      );
    });

    test('wallet inexistente → 404 sem gravar nada', async () => {
      const ghost: CreatedWallet = { id: randomUUID(), playerId: randomUUID(), currency: 'BRL' };
      const body = wagerBody(ghost, { kind: 'BET', amount: '10.00' });
      const key = `provider-a:${body.externalTransactionId}`;
      const res = await submitRaw(app, body, key);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({ code: 'WALLET_NOT_FOUND', retryable: false });
      expect(await transactionsByKey(app.orm, key)).toHaveLength(0);
    });
  });

  describe('payload inválido → 400 e nada gravado', () => {
    test.each([
      ['kind OPENING (interno)', { kind: 'OPENING' }, 'INVALID_TRANSACTION_KIND'],
      ['kind desconhecido', { kind: 'JACKPOT' }, 'INVALID_TRANSACTION_KIND'],
      ['providerId reservado', { providerId: 'internal' }, 'INVALID_FIELD'],
      ['REFUND sem referência', { kind: 'REFUND' }, 'MISSING_REFERENCE'],
      ['BET com referência', { referenceExternalTransactionId: 'x' }, 'INVALID_FIELD'],
      ['BET de 0.00', { money: { amount: '0.00', currency: 'BRL' } }, 'INVALID_AMOUNT'],
      ['amount numérico', { money: { amount: 10, currency: 'BRL' } }, 'INVALID_REQUEST'],
      ['amount com 3 casas', { money: { amount: '1.001', currency: 'BRL' } }, 'INVALID_MONEY'],
      ['amount negativo', { money: { amount: '-5.00', currency: 'BRL' } }, 'INVALID_MONEY'],
      ['walletId que não é UUID', { walletId: 'wallet-1' }, 'INVALID_FIELD'],
      ['roundId vazio', { roundId: '' }, 'INVALID_FIELD'],
      ['gameId ausente', { gameId: undefined }, 'INVALID_REQUEST'],
    ])('%s', async (_, override, code) => {
      const wallet = await open('100.00');
      const base = wagerBody(wallet, { kind: 'BET', amount: '10.00' });
      const body: Record<string, unknown> = { ...base, ...override };
      const key = `${body.providerId}:${body.externalTransactionId}`;
      const res = await submitRaw(app, body, key);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code, category: 'validation', retryable: false });
      expect(await transactionsByKey(app.orm, key)).toHaveLength(0);
      expect(await walletState(app.orm, wallet.id)).toMatchObject({
        balance: '100.00',
        version: 1,
      });
    });
  });
});
