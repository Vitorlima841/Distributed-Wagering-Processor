import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { expectBalanceMatchesLedger } from '../../support/database';
import { createWallet, startTestApp, type TestApp } from '../../support/http-app';
import {
  ledgerOf,
  outboxOfTransaction,
  transactionsOfWallet,
  walletExistsForPlayer,
  walletState,
} from '../../support/inspect';

describe('wallets (HTTP + Postgres real)', () => {
  let app: TestApp;
  const wallets = new Set<string>();

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('POST', '/wallets', { body, headers });

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

  test('saldo inicial > 0: OPENING PROCESSED + lançamento CREDIT + eventos, numa transação só', async () => {
    const playerId = randomUUID();
    const correlationId = `corr-${randomUUID()}`;
    const res = await post(
      { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
      { 'X-Correlation-Id': correlationId },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('x-correlation-id')).toBe(correlationId);
    expect(res.body).toMatchObject({
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const walletId: string = res.body.id;
    wallets.add(walletId);

    const [opening, ...others] = await transactionsOfWallet(app.orm, walletId);
    expect(others).toHaveLength(0);
    expect(opening).toMatchObject({
      providerId: 'internal',
      idempotencyKey: `opening:${walletId}`,
      kind: 'OPENING',
      amount: '1000.00',
      status: 'PROCESSED',
      balanceAfter: '1000.00',
    });
    expect(await ledgerOf(app.orm, walletId)).toEqual([
      {
        transactionId: opening?.id as string,
        direction: 'CREDIT',
        amount: '1000.00',
        balanceBefore: '0.00',
        balanceAfter: '1000.00',
        walletVersion: 1,
      },
    ]);
    const events = await outboxOfTransaction(app.orm, opening?.id as string);
    expect(events.map((e) => e.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const event of events) {
      expect(event.payload.correlationId).toBe(correlationId);
      expect(event.publishedAt).toBeNull();
    }
    expect(events[1]?.payload.data).toMatchObject({
      walletId,
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    });

    const got = await app.request('GET', `/wallets/${walletId}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: walletId, playerId, version: 1 });
    expect(got.body.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
  });

  test('saldo inicial zero: sem OPENING, sem lançamento, version 1', async () => {
    const wallet = await createWallet(app, '0');
    wallets.add(wallet.id);
    expect(await walletState(app.orm, wallet.id)).toEqual({
      balance: '0.00',
      currency: 'BRL',
      version: 1,
    });
    expect(await transactionsOfWallet(app.orm, wallet.id)).toHaveLength(0);
    expect(await ledgerOf(app.orm, wallet.id)).toHaveLength(0);
  });

  test('wallet duplicada (player + moeda) → 409 com o id existente; outra moeda é permitida', async () => {
    const first = await createWallet(app, '10.00');
    wallets.add(first.id);

    const duplicate = await post({
      playerId: first.playerId,
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatchObject({
      code: 'WALLET_ALREADY_EXISTS',
      category: 'conflict',
      retryable: false,
      walletId: first.id,
    });
    // nada da tentativa duplicada ficou gravado
    expect(await walletState(app.orm, first.id)).toMatchObject({ balance: '10.00', version: 1 });
    expect(await transactionsOfWallet(app.orm, first.id)).toHaveLength(1);

    const usd = await createWallet(app, '5.00', { playerId: first.playerId, currency: 'USD' });
    wallets.add(usd.id);
    expect(usd.id).not.toBe(first.id);
  });

  test('playerId em maiúsculas é normalizado (não vira outra wallet)', async () => {
    const playerId = randomUUID();
    const res = await post({
      playerId: playerId.toUpperCase(),
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    expect(res.status).toBe(201);
    expect(res.body.playerId).toBe(playerId);
    wallets.add(res.body.id);

    const again = await post({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(again.status).toBe(409);
  });

  test.each([
    ['amount numérico', { amount: 10, currency: 'BRL' }, 'INVALID_REQUEST'],
    ['amount negativo', { amount: '-1.00', currency: 'BRL' }, 'INVALID_MONEY'],
    ['mais de 2 casas', { amount: '10.005', currency: 'BRL' }, 'INVALID_MONEY'],
    ['notação científica', { amount: '1e3', currency: 'BRL' }, 'INVALID_MONEY'],
    ['moeda minúscula', { amount: '10.00', currency: 'brl' }, 'INVALID_MONEY'],
    ['sem initialBalance', undefined, 'INVALID_REQUEST'],
  ])('payload inválido (%s) → 400 sem gravar nada', async (_, initialBalance, code) => {
    const playerId = randomUUID();
    const res = await post({ playerId, initialBalance });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code, category: 'validation', retryable: false });
    expect(await walletExistsForPlayer(app.orm, playerId)).toBe(false);
  });

  test('playerId que não é UUID → 400', async () => {
    const res = await post({
      playerId: 'player-1',
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FIELD');
  });

  test('JSON malformado → 400 no mesmo envelope de erro', async () => {
    const res = await app.request('POST', '/wallets', { rawBody: '{"playerId":' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_REQUEST', category: 'validation' });
    expect(typeof res.body.correlationId).toBe('string');
  });

  test('GET de wallet inexistente → 404; id que não é UUID → 400', async () => {
    const missing = await app.request('GET', `/wallets/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: 'WALLET_NOT_FOUND', category: 'not_found' });

    const invalid = await app.request('GET', '/wallets/not-a-uuid');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_FIELD');
  });

  test('rota inexistente → 404 no mesmo envelope', async () => {
    const res = await app.request('GET', '/nada-aqui');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'ROUTE_NOT_FOUND', category: 'not_found' });
  });
});
