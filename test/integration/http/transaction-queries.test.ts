import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { expectBalanceMatchesLedger } from '../../support/database';
import {
  type CreatedWallet,
  createWallet,
  startTestApp,
  submitWager,
  type TestApp,
} from '../../support/http-app';

describe('consultas de transação (HTTP + Postgres real)', () => {
  let app: TestApp;
  const wallets = new Set<string>();

  const open = async (initial: string): Promise<CreatedWallet> => {
    const wallet = await createWallet(app, initial);
    wallets.add(wallet.id);
    return wallet;
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

  test('por id e por (providerId, externalTransactionId) devolvem a mesma visão completa', async () => {
    const wallet = await open('100.00');
    const bet = await submitWager(app, wallet, { kind: 'BET', amount: '40.00' });
    const refund = await submitWager(app, wallet, {
      kind: 'REFUND',
      amount: '40.00',
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const byId = await app.request('GET', `/wagering/transactions/${refund.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual({
      transactionId: refund.body.transactionId,
      providerId: 'provider-a',
      externalTransactionId: refund.externalTransactionId,
      idempotencyKey: `provider-a:${refund.externalTransactionId}`,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'REFUND',
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
      referenceTransactionId: bet.body.transactionId,
      status: 'PROCESSED',
      balanceAfter: { amount: '100.00', currency: 'BRL' },
      referenceAttempts: 0,
      createdAt: expect.any(String),
      processedAt: expect.any(String),
    });

    const byExternal = await app.request(
      'GET',
      `/providers/provider-a/wagering/transactions/${encodeURIComponent(refund.externalTransactionId)}`,
    );
    expect(byExternal.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
  });

  test('rejeitada mostra failureCode e providerAction; pendente mostra o próximo retry', async () => {
    const wallet = await open('5.00');
    const rejected = await submitWager(app, wallet, { kind: 'BET', amount: '10.00' });
    const rejectedView = await app.request(
      'GET',
      `/wagering/transactions/${rejected.body.transactionId}`,
    );
    expect(rejectedView.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      providerAction: 'give_up',
      balanceAfter: { amount: '5.00', currency: 'BRL' },
    });

    const pending = await submitWager(app, wallet, {
      kind: 'ROLLBACK',
      amount: '1.00',
      referenceExternalTransactionId: `missing-${randomUUID()}`,
    });
    const pendingView = await app.request(
      'GET',
      `/wagering/transactions/${pending.body.transactionId}`,
    );
    expect(pendingView.body).toMatchObject({ status: 'PENDING_REFERENCE', referenceAttempts: 0 });
    expect(Date.parse(pendingView.body.nextAttemptAt)).toBeGreaterThan(0);
    expect(pendingView.body.processedAt).toBeUndefined();
  });

  test('a abertura da wallet é consultável pelo provedor interno', async () => {
    const wallet = await open('10.00');
    const res = await app.request(
      'GET',
      `/providers/internal/wagering/transactions/${encodeURIComponent(`opening:${wallet.id}`)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'OPENING', status: 'PROCESSED', walletId: wallet.id });
  });

  test('inexistente → 404 TRANSACTION_NOT_FOUND; id que não é UUID → 400', async () => {
    const missing = await app.request('GET', `/wagering/transactions/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({
      code: 'TRANSACTION_NOT_FOUND',
      category: 'not_found',
    });

    const missingExternal = await app.request(
      'GET',
      '/providers/provider-a/wagering/transactions/nao-existe',
    );
    expect(missingExternal.status).toBe(404);

    const invalid = await app.request('GET', '/wagering/transactions/123');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_FIELD');
  });
});
