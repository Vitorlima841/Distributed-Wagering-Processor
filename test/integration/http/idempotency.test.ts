import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { computeWagerPayloadHash } from '../../../src/domain';
import { expectBalanceMatchesLedger, inTransaction } from '../../support/database';
import {
  type CreatedWallet,
  createWallet,
  startTestApp,
  submitRaw,
  submitWager,
  type TestApp,
  wagerBody,
} from '../../support/http-app';
import { ledgerOf, outboxEventTypes, transactionsByKey, walletState } from '../../support/inspect';
import { insertTx, txRow, type WalletRow } from '../../support/sql-fixtures';
import { gate, waitForBlockedQuery } from '../../support/sync';

describe('idempotência (HTTP + Postgres real)', () => {
  let app: TestApp;
  const wallets = new Set<string>();

  const open = async (initial: string): Promise<CreatedWallet> => {
    const wallet = await createWallet(app, initial);
    wallets.add(wallet.id);
    return wallet;
  };
  const keyOf = (body: Record<string, unknown>) =>
    `${body.providerId}:${body.externalTransactionId}`;

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

  describe('replay', () => {
    test('requisição idêntica → 200 com o resultado original e o saldo daquele momento', async () => {
      const wallet = await open('100.00');
      const body = wagerBody(wallet, { kind: 'BET', amount: '25.00' });
      const first = await submitRaw(app, body, keyOf(body));
      expect(first.status).toBe(201);

      // o saldo muda depois; o replay devolve o snapshot da primeira execução
      await submitWager(app, wallet, { kind: 'BET', amount: '5.00' });
      const replay = await submitRaw(app, body, keyOf(body));
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(replay.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });

      expect(await transactionsByKey(app.orm, keyOf(body))).toHaveLength(1);
      expect(await ledgerOf(app.orm, wallet.id)).toHaveLength(3);
      expect(await walletState(app.orm, wallet.id)).toMatchObject({ balance: '70.00', version: 3 });
      // o replay não enfileira eventos de novo
      expect(await outboxEventTypes(app.orm, first.body.transactionId)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
    });

    test('de uma rejeição → 422 de novo, sem reavaliar (mesmo que agora houvesse saldo)', async () => {
      const wallet = await open('10.00');
      const body = wagerBody(wallet, { kind: 'BET', amount: '50.00' });
      const first = await submitRaw(app, body, keyOf(body));
      expect(first.status).toBe(422);

      await submitWager(app, wallet, { kind: 'WIN', amount: '100.00' });
      const replay = await submitRaw(app, body, keyOf(body));
      expect(replay.status).toBe(422);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(replay.body).toMatchObject({
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '10.00' },
      });
      expect(await walletState(app.orm, wallet.id)).toMatchObject({ balance: '110.00' });
    });

    test('de uma PENDING_REFERENCE → 202 com idempotentReplay', async () => {
      const wallet = await open('10.00');
      const body = wagerBody(wallet, {
        kind: 'REFUND',
        amount: '5.00',
        referenceExternalTransactionId: `missing-${randomUUID()}`,
      });
      const first = await submitRaw(app, body, keyOf(body));
      expect(first.status).toBe(202);
      const replay = await submitRaw(app, body, keyOf(body));
      expect(replay.status).toBe(202);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    });

    test('"25" e "25.00" são o mesmo payload (hash do valor normalizado)', async () => {
      const wallet = await open('100.00');
      const body = wagerBody(wallet, { kind: 'BET', amount: '25' });
      expect((await submitRaw(app, body, keyOf(body))).status).toBe(201);
      const replay = await submitRaw(
        app,
        { ...body, money: { amount: '25.00', currency: 'BRL' } },
        keyOf(body),
      );
      expect(replay.status).toBe(200);
      expect(replay.body.idempotentReplay).toBe(true);
    });

    test('UUIDs em maiúsculas são o mesmo payload (normalizados antes do hash)', async () => {
      const wallet = await open('100.00');
      const body = wagerBody(wallet, { kind: 'BET', amount: '1.00' });
      expect((await submitRaw(app, body, keyOf(body))).status).toBe(201);
      const upper = {
        ...body,
        walletId: wallet.id.toUpperCase(),
        playerId: wallet.playerId.toUpperCase(),
      };
      const replay = await submitRaw(app, upper, keyOf(body));
      expect(replay.status).toBe(200);
      expect(replay.body.idempotentReplay).toBe(true);
    });

    test('a mesma requisição 5x em paralelo → um 201, quatro replays, um débito', async () => {
      const wallet = await open('100.00');
      const body = wagerBody(wallet, { kind: 'BET', amount: '10.00' });
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => submitRaw(app, body, keyOf(body))),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
      expect(await ledgerOf(app.orm, wallet.id)).toHaveLength(2);
      expect(await walletState(app.orm, wallet.id)).toMatchObject({ balance: '90.00', version: 2 });
    });

    test('key fora do formato padrão é aceita (o header é a fonte da verdade)', async () => {
      const wallet = await open('100.00');
      const body = wagerBody(wallet, { kind: 'BET', amount: '1.00' });
      const key = `custom key ${randomUUID()}`;
      expect((await submitRaw(app, body, key)).status).toBe(201);
      expect((await submitRaw(app, body, key)).status).toBe(200);
    });
  });

  describe('conflito', () => {
    test('mesma key com payload diferente → 409 IDEMPOTENCY_CONFLICT e nada gravado', async () => {
      const wallet = await open('100.00');
      const body = wagerBody(wallet, { kind: 'BET', amount: '25.00' });
      expect((await submitRaw(app, body, keyOf(body))).status).toBe(201);

      const conflict = await submitRaw(
        app,
        { ...body, money: { amount: '26.00', currency: 'BRL' } },
        keyOf(body),
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
        category: 'conflict',
        retryable: false,
      });
      expect(conflict.body.idempotentReplay).toBeUndefined();
      expect(await transactionsByKey(app.orm, keyOf(body))).toHaveLength(1);
      expect(await walletState(app.orm, wallet.id)).toMatchObject({ balance: '75.00', version: 2 });
    });

    test('mesma key apontando para outra wallet → 409', async () => {
      const walletA = await open('100.00');
      const walletB = await open('100.00');
      const body = wagerBody(walletA, { kind: 'BET', amount: '10.00' });
      expect((await submitRaw(app, body, keyOf(body))).status).toBe(201);
      const other = { ...body, walletId: walletB.id, playerId: walletB.playerId };
      expect((await submitRaw(app, other, keyOf(body))).status).toBe(409);
      expect(await walletState(app.orm, walletB.id)).toMatchObject({ balance: '100.00' });
    });

    test('mesmo externalTransactionId com outra key → 409 EXTERNAL_TRANSACTION_CONFLICT (não é replay)', async () => {
      const wallet = await open('100.00');
      const body = wagerBody(wallet, { kind: 'BET', amount: '10.00' });
      expect((await submitRaw(app, body, keyOf(body))).status).toBe(201);
      const res = await submitRaw(app, body, `outra-key-${randomUUID()}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
      expect(await ledgerOf(app.orm, wallet.id)).toHaveLength(2);
    });
  });

  describe('header Idempotency-Key', () => {
    test.each([
      ['ausente', undefined, 'MISSING_IDEMPOTENCY_KEY'],
      ['vazio', '', 'MISSING_IDEMPOTENCY_KEY'],
      ['maior que 255', 'k'.repeat(256), 'INVALID_IDEMPOTENCY_KEY'],
    ])('%s → 400', async (_, key, code) => {
      const wallet = await open('100.00');
      const body = wagerBody(wallet, { kind: 'BET', amount: '1.00' });
      const res = await submitRaw(app, body, key);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code, category: 'validation' });
      expect(await walletState(app.orm, wallet.id)).toMatchObject({ version: 1 });
    });
  });

  describe('corridas (determinísticas)', () => {
    const asRow = (wallet: CreatedWallet): WalletRow => ({
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: '100.00',
      version: 1,
    });

    test('quem espera o lock da wallet acha a transação que o dono do lock confirmou → replay', async () => {
      const wallet = await open('100.00');
      const body = wagerBody(wallet, { kind: 'LOSS', amount: '0.00' });
      const key = keyOf(body);
      const existingId = randomUUID();
      const locked = gate();
      const release = gate();
      // "Dono do lock": trava a wallet e grava a mesma operação (mesmo hash), ainda sem commit.
      const owner = inTransaction(app.orm, async (em) => {
        await em.execute('select id from wallets where id = ? for update', [wallet.id]);
        await insertTx(
          em,
          txRow(asRow(wallet), {
            id: existingId,
            externalTransactionId: body.externalTransactionId as string,
            idempotencyKey: key,
            gameId: body.gameId as string,
            kind: 'LOSS',
            amount: '0.00',
            payloadHash: computeWagerPayloadHash({
              ...(body as { providerId: string; externalTransactionId: string }),
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: body.roundId as string,
              gameId: body.gameId as string,
              kind: 'LOSS',
              money: { amount: '0.00', currency: 'BRL' },
            }),
          }),
        );
        locked.open();
        await release.promise;
      });
      await locked.promise;

      const pending = submitRaw(app, body, key);
      await waitForBlockedQuery(app.orm, 'for update');
      release.open();
      await owner;

      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ transactionId: existingId, idempotentReplay: true });
      expect(await transactionsByKey(app.orm, key)).toHaveLength(1);
    });

    test('mesma key confirmada em outra wallet enquanto esta espera no índice único → rollback, releitura e 409', async () => {
      const walletA = await open('100.00');
      const walletB = await open('100.00');
      const body = wagerBody(walletA, { kind: 'BET', amount: '10.00' });
      const key = `provider-a:race-${randomUUID()}`;
      const inserted = gate();
      const release = gate();
      // Outra requisição (na wallet B, então sem disputar o lock da A) já inseriu a key, sem commit.
      const other = inTransaction(app.orm, async (em) => {
        await insertTx(
          em,
          txRow(asRow(walletB), { idempotencyKey: key, kind: 'LOSS', amount: '0.00' }),
        );
        inserted.open();
        await release.promise;
      });
      await inserted.promise;

      const pending = submitRaw(app, body, key);
      // passou pelas buscas, travou a wallet A e agora espera no índice único da key
      await waitForBlockedQuery(app.orm, 'insert into "wager_transactions"');
      release.open();
      await other;

      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await transactionsByKey(app.orm, key)).toHaveLength(1);
      expect(await walletState(app.orm, walletA.id)).toMatchObject({
        balance: '100.00',
        version: 1,
      });
      expect(await ledgerOf(app.orm, walletA.id)).toHaveLength(1);
    });
  });
});
