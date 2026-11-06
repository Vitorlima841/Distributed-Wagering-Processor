import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DEAD_LETTER_ATTRIBUTES } from '../../../src/infrastructure/messaging/sqs-wager-queue';
import { expectConsistentWallets } from '../../support/consistency';
import {
  type CreatedWallet,
  createWallet,
  startTestApp,
  submitWager,
  type TestApp,
} from '../../support/http-app';
import { inboxOf, transactionsByKey, walletState } from '../../support/inspect';
import { TestQueues, wagerMessage } from '../../support/sqs';
import { SqsProxy } from '../../support/sqs-proxy';
import { holdWalletLock, waitUntil } from '../../support/sync';

/**
 * Retry, backoff e DLQ contra o LocalStack real. O consumer fala com o SQS por um proxy que só
 * observa: o teste vê cada ChangeMessageVisibility (o backoff), cada DeleteMessage (o ack) e cada
 * recebimento. A falha transitória é real: o teste trava a wallet no Postgres e o consumer roda
 * com `lock_timeout` curto (LOCK_TIMEOUT).
 */

const TIMEOUT_MS = 60_000;
const LOCK_TIMEOUT_MS = '200';

describe('retry e DLQ (LocalStack + Postgres reais)', () => {
  let api: TestApp;
  const wallets = new Set<string>();
  const cleanups: (() => Promise<void> | void)[] = [];

  const open = async (initial: string): Promise<CreatedWallet> => {
    const wallet = await createWallet(api, initial);
    wallets.add(wallet.id);
    return wallet;
  };

  /** Filas novas + proxy + consumer em processo, desfeitos no fim do teste. */
  const setup = async (env: Record<string, string> = {}) => {
    const queues = await TestQueues.create({ maxReceiveCount: 5 });
    const proxy = SqsProxy.start();
    const consumer = await startTestApp(
      queues.consumerEnv({ SQS_ENDPOINT: proxy.url, DB_LOCK_TIMEOUT_MS: LOCK_TIMEOUT_MS, ...env }),
    );
    cleanups.push(async () => {
      await consumer.close();
      proxy.stop();
      await queues.destroy();
    });
    /** Chamadas que tocaram esta mensagem (pelo ReceiptHandle de cada recebimento). */
    const visibilityChanges = () =>
      proxy.of('ChangeMessageVisibility').map((call) => ({
        seconds: call.input.VisibilityTimeout as number,
        at: call.at,
      }));
    return { queues, proxy, consumer, visibilityChanges };
  };

  beforeAll(async () => {
    api = await startTestApp();
  });

  afterEach(async () => {
    try {
      await expectConsistentWallets(api.orm, wallets);
    } finally {
      wallets.clear();
      for (const cleanup of cleanups.splice(0)) {
        await cleanup();
      }
    }
  }, TIMEOUT_MS);

  afterAll(async () => {
    await api?.close();
  });

  test(
    'transitório: sem ack, volta com backoff 1s, 2s, 4s (pela contagem do SQS); liberado, processa uma vez',
    async () => {
      const { queues, proxy, visibilityChanges } = await setup({
        SQS_RETRY_BASE_DELAY_S: '1',
        SQS_RETRY_MAX_DELAY_S: '4',
      });
      const wallet = await open('100.00');
      const message = wagerMessage(wallet, { kind: 'BET', amount: '25.00' });

      const lock = await holdWalletLock(api.orm, wallet.id);
      try {
        await queues.sendWager(message);
        await waitUntil('três retries', async () => visibilityChanges().length >= 3, TIMEOUT_MS);
        const changes = visibilityChanges();
        expect(changes.map((change) => change.seconds)).toEqual([1, 2, 4]);
        // cada tentativa só começa depois de vencer a visibilidade anterior
        for (let i = 1; i < changes.length; i += 1) {
          const gapMs = (changes[i]?.at ?? 0) - (changes[i - 1]?.at ?? 0);
          expect(gapMs).toBeGreaterThanOrEqual((changes[i - 1]?.seconds ?? 0) * 1000 - 50);
        }
        // a contagem que define o backoff vem do SQS (1, 2, 3)
        const counts = proxy
          .of('ReceiveMessage')
          .flatMap((call) => call.received ?? [])
          .map((received) => received.receiveCount);
        expect(counts.slice(0, 3)).toEqual([1, 2, 3]);
        // nada confirmado → nenhum ack
        expect(proxy.of('DeleteMessage')).toEqual([]);
        expect(await transactionsByKey(api.orm, message.idempotencyKey)).toEqual([]);
      } finally {
        await lock.release();
      }

      await waitUntil('fila vazia', () => queues.isEmpty(), TIMEOUT_MS);
      const [tx, ...others] = await transactionsByKey(api.orm, message.idempotencyKey);
      expect(others).toEqual([]);
      expect(tx).toMatchObject({ status: 'PROCESSED', balanceAfter: '75.00' });
      expect(proxy.of('DeleteMessage')).toHaveLength(1);
      expect(await queues.isEmpty('dlq')).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    'tentativas esgotadas: depois de maxReceiveCount (5) o SQS move para a DLQ, sem nada gravado; reenviada pelo operador, processa uma vez',
    async () => {
      const { queues, proxy, visibilityChanges } = await setup({
        SQS_RETRY_BASE_DELAY_S: '1',
        SQS_RETRY_MAX_DELAY_S: '1',
      });
      const wallet = await open('100.00');
      const message = wagerMessage(wallet, { kind: 'BET', amount: '25.00' });

      const lock = await holdWalletLock(api.orm, wallet.id);
      try {
        await queues.sendWager(message);
        await waitUntil(
          'mensagem na DLQ',
          async () => (await queues.counts('dlq')).visible === 1,
          TIMEOUT_MS,
        );
      } finally {
        await lock.release();
      }
      // cinco recebimentos, cinco retries, nenhum ack; o sexto recebimento a moveu
      expect(visibilityChanges().map((change) => change.seconds)).toEqual([1, 1, 1, 1, 1]);
      expect(proxy.of('DeleteMessage')).toEqual([]);
      expect(await queues.isEmpty('main')).toBe(true);
      expect(await transactionsByKey(api.orm, message.idempotencyKey)).toEqual([]);
      expect(await inboxOf(api.orm, queues.consumerName, [message.messageId])).toEqual([]);

      // o operador reenvia o corpo intacto (outro dedup id: a janela de dedup do FIFO ainda vale)
      const [dead, ...rest] = await queues.drainDeadLetters();
      expect(rest).toEqual([]);
      expect(JSON.parse(dead?.body ?? '{}')).toEqual(message.envelope);
      await queues.send(dead?.body ?? '', {
        groupId: wallet.id,
        deduplicationId: `${message.messageId}-redrive`,
      });

      await waitUntil('fila vazia', () => queues.isEmpty(), TIMEOUT_MS);
      expect(await transactionsByKey(api.orm, message.idempotencyKey)).toHaveLength(1);
      expect(await inboxOf(api.orm, queues.consumerName, [message.messageId])).toHaveLength(1);
      expect(await walletState(api.orm, wallet.id)).toMatchObject({ balance: '75.00' });
    },
    TIMEOUT_MS,
  );

  test(
    'permanentes vão para a DLQ no primeiro recebimento, com o motivo; nada é gravado',
    async () => {
      const { queues, proxy } = await setup();
      const wallet = await open('100.00');
      const http = await submitWager(api, wallet, { kind: 'BET', amount: '10.00' });
      expect(http.status).toBe(201);

      const base = (input: Parameters<typeof wagerMessage>[1]) => wagerMessage(wallet, input);
      const numberMoney = base({ kind: 'BET', amount: '1.00' });
      numberMoney.envelope.data.money.amount = 1;
      const badUuid = base({ kind: 'BET', amount: '1.00' });
      badUuid.envelope.data.walletId = 'not-a-uuid';
      const missingWallet = wagerMessage(
        { ...wallet, id: randomUUID() },
        { kind: 'BET', amount: '1.00' },
      );
      const cases = [
        { body: '{ não é json', code: 'MALFORMED_MESSAGE', kind: 'validation' },
        {
          body: JSON.stringify(base({ kind: 'BET', amount: '1.00', type: 'Other' }).envelope),
          code: 'UNSUPPORTED_MESSAGE_TYPE',
          kind: 'validation',
        },
        {
          body: JSON.stringify(numberMoney.envelope),
          code: 'MALFORMED_MESSAGE',
          kind: 'validation',
        },
        { body: JSON.stringify(badUuid.envelope), code: 'INVALID_FIELD', kind: 'validation' },
        {
          body: JSON.stringify(base({ kind: 'OPENING', amount: '1.00' }).envelope),
          code: 'INVALID_TRANSACTION_KIND',
          kind: 'validation',
        },
        {
          body: JSON.stringify(base({ kind: 'BET', amount: '1.005' }).envelope),
          code: 'INVALID_MONEY',
          kind: 'validation',
        },
        {
          body: JSON.stringify(missingWallet.envelope),
          code: 'WALLET_NOT_FOUND',
          kind: 'not_found',
        },
        {
          // mesma key do POST, outro valor
          body: JSON.stringify(
            base({
              kind: 'BET',
              amount: '99.00',
              externalTransactionId: http.externalTransactionId,
            }).envelope,
          ),
          code: 'IDEMPOTENCY_CONFLICT',
          kind: 'conflict',
        },
      ];
      for (const [index, item] of cases.entries()) {
        await queues.send(item.body, { groupId: `g-${index}`, deduplicationId: `d-${index}` });
      }

      await waitUntil(
        'todas na DLQ',
        async () => (await queues.counts('dlq')).visible === cases.length,
        TIMEOUT_MS,
      );
      await waitUntil('fila principal vazia', () => queues.isEmpty(), TIMEOUT_MS);
      const dead = await queues.drainDeadLetters();
      expect(
        dead
          .map((letter) => ({
            body: letter.body,
            code: letter.attributes[DEAD_LETTER_ATTRIBUTES.code],
            kind: letter.attributes[DEAD_LETTER_ATTRIBUTES.kind],
            receiveCount: letter.attributes[DEAD_LETTER_ATTRIBUTES.receiveCount],
          }))
          .sort((a, b) => a.body.localeCompare(b.body)),
      ).toEqual(
        cases
          .map((item) => ({ ...item, receiveCount: '1' }))
          .sort((a, b) => a.body.localeCompare(b.body)),
      );
      // direto para a DLQ: nenhuma tentativa gasta com backoff
      expect(proxy.of('ChangeMessageVisibility')).toEqual([]);
      // só a transação do POST existe nesta wallet
      expect(await walletState(api.orm, wallet.id)).toMatchObject({ balance: '90.00', version: 2 });
      expect(await inboxOf(api.orm, queues.consumerName)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    'regra de negócio (INSUFFICIENT_FUNDS) recebe ack e fica gravada; não vai para a DLQ',
    async () => {
      const { queues, proxy } = await setup();
      const wallet = await open('5.00');
      const message = wagerMessage(wallet, { kind: 'BET', amount: '50.00' });
      await queues.sendWager(message);

      await waitUntil('fila vazia', () => queues.isEmpty(), TIMEOUT_MS);
      expect(await transactionsByKey(api.orm, message.idempotencyKey)).toMatchObject([
        { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' },
      ]);
      expect(proxy.of('DeleteMessage')).toHaveLength(1);
      expect(proxy.of('SendMessage')).toEqual([]);
      expect(await queues.isEmpty('dlq')).toBe(true);
    },
    TIMEOUT_MS,
  );
});
