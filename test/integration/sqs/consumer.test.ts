import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { expectConsistentWallets } from '../../support/consistency';
import {
  type CreatedWallet,
  createWallet,
  startTestApp,
  submitWager,
  type TestApp,
} from '../../support/http-app';
import {
  inboxOf,
  outboxOfTransaction,
  transactionsByKey,
  walletState,
} from '../../support/inspect';
import { TestQueues, wagerMessage } from '../../support/sqs';
import { holdWalletLock, waitForWalletLockWaiters, waitUntil } from '../../support/sync';

/**
 * Consumer SQS de ponta a ponta: app Nest real no papel `consumer` (em processo), LocalStack real
 * e Postgres real. As wallets são criadas pela API (outro app em processo).
 */

const TIMEOUT_MS = 30_000;

describe('consumer SQS (LocalStack + Postgres reais)', () => {
  let api: TestApp;
  let consumer: TestApp;
  let queues: TestQueues;
  const wallets = new Set<string>();

  const open = async (initial: string): Promise<CreatedWallet> => {
    const wallet = await createWallet(api, initial);
    wallets.add(wallet.id);
    return wallet;
  };

  /** Espera a fila esvaziar: tudo recebeu ack (ou foi para a DLQ). */
  const drained = () => waitUntil('fila principal vazia', () => queues.isEmpty(), TIMEOUT_MS);

  const settled = async (idempotencyKey: string) => {
    await waitUntil(
      `transação ${idempotencyKey} gravada`,
      async () => (await transactionsByKey(api.orm, idempotencyKey)).length > 0,
      TIMEOUT_MS,
    );
    const [tx] = await transactionsByKey(api.orm, idempotencyKey);
    if (!tx) {
      throw new Error('inalcançável');
    }
    return tx;
  };

  beforeAll(async () => {
    queues = await TestQueues.create();
    api = await startTestApp();
    consumer = await startTestApp(queues.consumerEnv());
  }, TIMEOUT_MS);

  afterEach(async () => {
    await expectConsistentWallets(api.orm, wallets);
    wallets.clear();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await consumer?.close();
    await api?.close();
    await queues?.destroy();
  }, TIMEOUT_MS);

  test(
    'BET pela fila: processada, ack depois do COMMIT, inbox e eventos com a correlação da mensagem',
    async () => {
      const wallet = await open('100.00');
      const message = wagerMessage(wallet, { kind: 'BET', amount: '25.00' });
      await queues.sendWager(message);

      const tx = await settled(message.idempotencyKey);
      expect(tx).toMatchObject({ kind: 'BET', status: 'PROCESSED', balanceAfter: '75.00' });
      await drained();
      expect(await queues.isEmpty('dlq')).toBe(true);
      expect(await walletState(api.orm, wallet.id)).toMatchObject({ balance: '75.00', version: 2 });

      const [inbox, ...others] = await inboxOf(api.orm, queues.consumerName, [message.messageId]);
      expect(others).toEqual([]);
      expect(inbox?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(inbox?.processedAt).not.toBeNull();

      const events = await outboxOfTransaction(api.orm, tx.id);
      expect(events.map((event) => event.eventType)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      for (const event of events) {
        expect(event.payload.correlationId).toBe(message.messageId);
        expect(event.payload.causationId).toBe(message.messageId);
      }
    },
    TIMEOUT_MS,
  );

  test(
    'REJECTED (saldo insuficiente) e PENDING_REFERENCE recebem ack: o resultado já está gravado',
    async () => {
      const wallet = await open('10.00');
      const bet = wagerMessage(wallet, { kind: 'BET', amount: '50.00' });
      const refund = wagerMessage(wallet, {
        kind: 'REFUND',
        amount: '5.00',
        referenceExternalTransactionId: `missing-${randomUUID()}`,
      });
      await queues.sendWager(bet);
      await queues.sendWager(refund);

      expect(await settled(bet.idempotencyKey)).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balanceAfter: '10.00',
      });
      expect(await settled(refund.idempotencyKey)).toMatchObject({
        status: 'PENDING_REFERENCE',
      });
      await drained();
      expect(await queues.isEmpty('dlq')).toBe(true);
      expect(
        await inboxOf(api.orm, queues.consumerName, [bet.messageId, refund.messageId]),
      ).toHaveLength(2);
    },
    TIMEOUT_MS,
  );

  test(
    'mesma operação pelo HTTP e depois pela fila: o consumer recebe o replay, sem segundo efeito',
    async () => {
      const wallet = await open('100.00');
      const http = await submitWager(api, wallet, { kind: 'BET', amount: '30.00' });
      expect(http.status).toBe(201);

      const message = wagerMessage(wallet, {
        kind: 'BET',
        amount: '30.00',
        externalTransactionId: http.externalTransactionId,
      });
      await queues.sendWager(message);
      await waitUntil(
        'inbox da mensagem',
        async () => (await inboxOf(api.orm, queues.consumerName, [message.messageId])).length === 1,
        TIMEOUT_MS,
      );
      await drained();
      expect(await transactionsByKey(api.orm, message.idempotencyKey)).toHaveLength(1);
      expect(await walletState(api.orm, wallet.id)).toMatchObject({ balance: '70.00', version: 2 });
    },
    TIMEOUT_MS,
  );

  test(
    'redelivery: a mesma mensagem de novo (fora da dedup do FIFO) não repete o efeito',
    async () => {
      const wallet = await open('100.00');
      const message = wagerMessage(wallet, { kind: 'BET', amount: '40.00' });
      // dedup ids diferentes: o FIFO não descarta; quem garante é a inbox no banco
      await queues.sendWager(message, { deduplicationId: `${message.messageId}-a` });
      await queues.sendWager(message, { deduplicationId: `${message.messageId}-b` });

      await settled(message.idempotencyKey);
      await drained();
      expect(await transactionsByKey(api.orm, message.idempotencyKey)).toHaveLength(1);
      expect(await inboxOf(api.orm, queues.consumerName, [message.messageId])).toHaveLength(1);
      expect(await walletState(api.orm, wallet.id)).toMatchObject({ balance: '60.00', version: 2 });
    },
    TIMEOUT_MS,
  );

  test(
    'duas instâncias do consumer com a mesma mensagem ao mesmo tempo: um efeito só',
    async () => {
      // uma mensagem por recebimento: cada cópia fica com uma instância
      const one = await startTestApp(
        queues.consumerEnv({ SQS_MAX_MESSAGES: '1', DB_APPLICATION_NAME: 'sqs-dup-1' }),
      );
      const two = await startTestApp(
        queues.consumerEnv({ SQS_MAX_MESSAGES: '1', DB_APPLICATION_NAME: 'sqs-dup-2' }),
      );
      // o consumer principal do arquivo sai do caminho para as duas cópias irem para one e two
      await consumer.close();
      try {
        const wallet = await open('100.00');
        const message = wagerMessage(wallet, { kind: 'BET', amount: '10.00' });
        const lock = await holdWalletLock(api.orm, wallet.id);
        try {
          // grupos diferentes: o FIFO não serializa as cópias (simula a reentrega concorrente)
          await queues.sendWager(message, { groupId: `${wallet.id}-a`, deduplicationId: 'a' });
          await queues.sendWager(message, { groupId: `${wallet.id}-b`, deduplicationId: 'b' });
          const waiting = await waitForWalletLockWaiters(api.orm, 'sqs-dup-', 2, {
            timeoutMs: TIMEOUT_MS,
          });
          expect(Object.fromEntries(waiting)).toEqual({ 'sqs-dup-1': 1, 'sqs-dup-2': 1 });
        } finally {
          await lock.release();
        }
        await drained();
        expect(await transactionsByKey(api.orm, message.idempotencyKey)).toHaveLength(1);
        expect(await inboxOf(api.orm, queues.consumerName, [message.messageId])).toHaveLength(1);
        expect(await walletState(api.orm, wallet.id)).toMatchObject({ balance: '90.00' });
      } finally {
        await Promise.all([one.close(), two.close()]);
        consumer = await startTestApp(queues.consumerEnv());
      }
    },
    TIMEOUT_MS,
  );
});
