import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { AppInstance } from '../support/cluster';
import { CONCURRENCY_TIMEOUT_MS } from '../support/concurrency-suite';
import { expectConsistentWallets } from '../support/consistency';
import { type CreatedWallet, createWallet, startTestApp, type TestApp } from '../support/http-app';
import { inboxOf, ledgerOf, transactionsByKey, walletState } from '../support/inspect';
import { TestQueues, type WagerMessage, wagerMessage } from '../support/sqs';
import { SqsProxy } from '../support/sqs-proxy';
import { backendsOf, waitUntil } from '../support/sync';

/**
 * Consumers em processos reais (`bun src/main.ts`, papel `consumer`) contra LocalStack e Postgres.
 * O único estado compartilhado entre eles é o banco e a fila.
 */

const suffix = () => randomBytes(3).toString('hex');

describe('consumer SQS em processos reais', () => {
  let api: TestApp;
  const wallets = new Set<string>();
  const cleanups: (() => Promise<void> | void)[] = [];

  const open = async (initial: string): Promise<CreatedWallet> => {
    const wallet = await createWallet(api, initial);
    wallets.add(wallet.id);
    return wallet;
  };

  beforeAll(async () => {
    api = await startTestApp();
  });

  afterEach(async () => {
    try {
      await expectConsistentWallets(api.orm, wallets);
    } finally {
      wallets.clear();
      for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
      }
    }
  }, CONCURRENCY_TIMEOUT_MS);

  afterAll(async () => {
    await api?.close();
  });

  test(
    'consumer morto depois do COMMIT e antes do ack: outra instância recebe de novo e não repete o efeito',
    async () => {
      const queues = await TestQueues.create();
      // o proxy segura o primeiro DeleteMessage: o ack sai, mas nunca chega ao SQS
      const proxy = SqsProxy.start();
      cleanups.push(async () => {
        proxy.stop();
        await queues.destroy();
      });
      const ack = proxy.hold('DeleteMessage');
      const first = await AppInstance.start(
        `crash-a-${suffix()}`,
        queues.consumerEnv({ SQS_ENDPOINT: proxy.url, SQS_VISIBILITY_TIMEOUT_S: '2' }),
      );
      cleanups.push(() => first.kill());

      const wallet = await open('100.00');
      const message = wagerMessage(wallet, { kind: 'BET', amount: '25.00' });
      await queues.sendWager(message);

      const held = await ack.arrived;
      // o ack só é pedido depois do COMMIT: transação, lançamento e inbox já estão no banco
      const [tx, ...others] = await transactionsByKey(api.orm, message.idempotencyKey);
      expect(others).toEqual([]);
      expect(tx).toMatchObject({ status: 'PROCESSED', balanceAfter: '75.00' });
      expect(await inboxOf(api.orm, queues.consumerName, [message.messageId])).toHaveLength(1);
      expect(held.input.ReceiptHandle).toBeString();

      // queda real, sem shutdown gracioso
      await first.kill();
      await waitUntil(
        'conexões da instância morta encerradas',
        async () => (await backendsOf(api.orm, first.applicationName)) === 0,
      );
      // a mensagem continua na fila (em voo até vencer a visibilidade de 2s)
      expect(await queues.isEmpty()).toBe(false);

      const second = await AppInstance.start(
        `crash-b-${suffix()}`,
        queues.consumerEnv({ SQS_ENDPOINT: proxy.url, SQS_VISIBILITY_TIMEOUT_S: '2' }),
      );
      cleanups.push(() => second.kill());
      await waitUntil('fila vazia', () => queues.isEmpty(), CONCURRENCY_TIMEOUT_MS);

      // o segundo recebimento foi a reentrega (contagem 2), tratada como duplicada e apagada
      const redelivery = proxy
        .of('ReceiveMessage')
        .flatMap((call) => call.received ?? [])
        .filter((received) => received.messageId === message.messageId);
      expect(redelivery.map((received) => received.receiveCount)).toEqual([1, 2]);
      await waitUntil('log da reentrega', async () =>
        second
          .jsonLogs()
          .some(
            (log) =>
              log.msg === 'message processed' &&
              log.messageId === message.messageId &&
              log.duplicateDelivery === true &&
              log.receiveCount === 2,
          ),
      );
      expect(await transactionsByKey(api.orm, message.idempotencyKey)).toHaveLength(1);
      expect(await inboxOf(api.orm, queues.consumerName, [message.messageId])).toHaveLength(1);
      expect(await ledgerOf(api.orm, wallet.id)).toHaveLength(2);
      expect(await walletState(api.orm, wallet.id)).toMatchObject({ balance: '75.00', version: 2 });
    },
    CONCURRENCY_TIMEOUT_MS,
  );

  test(
    '3 consumers (processos) com carga misturada, duplicatas e reenvios: cada operação aplicada uma vez',
    async () => {
      const queues = await TestQueues.create();
      cleanups.push(() => queues.destroy());
      const instances = await Promise.all(
        [0, 1, 2].map((index) =>
          // uma mensagem por recebimento espalha o trabalho entre os processos
          AppInstance.start(
            `multi-${index}-${suffix()}`,
            queues.consumerEnv({ SQS_MAX_MESSAGES: '1' }),
          ),
        ),
      );
      cleanups.push(() => Promise.all(instances.map((instance) => instance.kill())).then(() => {}));

      interface Planned {
        message: WagerMessage;
        status: string;
      }
      const plan: { wallet: CreatedWallet; ops: Planned[]; finalBalance: string }[] = [];
      for (let w = 0; w < 4; w += 1) {
        const wallet = await open('100.00');
        const op = (input: Parameters<typeof wagerMessage>[1], status: string): Planned => ({
          message: wagerMessage(wallet, { roundId: `round-${w}`, ...input }),
          status,
        });
        const bet = op({ kind: 'BET', amount: '30.00' }, 'PROCESSED');
        const win = op({ kind: 'WIN', amount: '12.50' }, 'PROCESSED');
        const big = op({ kind: 'BET', amount: '500.00' }, 'REJECTED');
        const refund = op(
          {
            kind: 'REFUND',
            amount: '30.00',
            referenceExternalTransactionId: bet.message.externalTransactionId,
          },
          'PROCESSED',
        );
        const loss = op({ kind: 'LOSS', amount: '0.00' }, 'PROCESSED');
        const bet2 = op({ kind: 'BET', amount: '45.25' }, 'PROCESSED');
        // 100 − 30 + 12.50 + 30 − 45.25
        plan.push({ wallet, ops: [bet, win, big, refund, loss, bet2], finalBalance: '67.25' });
      }

      // cada mensagem vai duas vezes (dedup ids diferentes: o FIFO não descarta), e cada operação
      // ainda é reenviada como outra mensagem (outro messageId, mesma key) → replay
      let sent = 0;
      for (const { wallet, ops } of plan) {
        for (const { message } of ops) {
          await queues.sendWager(message, { deduplicationId: `${message.messageId}-1` });
          await queues.sendWager(message, { deduplicationId: `${message.messageId}-2` });
          const resent = wagerMessage(wallet, {
            kind: message.envelope.data.kind,
            amount: message.envelope.data.money.amount,
            externalTransactionId: message.externalTransactionId,
            roundId: message.envelope.data.roundId,
            referenceExternalTransactionId: message.envelope.data.referenceExternalTransactionId,
          });
          await queues.sendWager(resent);
          sent += 3;
        }
      }

      await waitUntil('fila vazia', () => queues.isEmpty(), CONCURRENCY_TIMEOUT_MS);
      expect(await queues.isEmpty('dlq')).toBe(true);

      for (const { wallet, ops, finalBalance } of plan) {
        for (const { message, status } of ops) {
          expect(
            (await transactionsByKey(api.orm, message.idempotencyKey)).map((tx) => tx.status),
          ).toEqual([status]);
        }
        expect((await walletState(api.orm, wallet.id)).balance).toBe(finalBalance);
      }
      // uma linha de inbox por messageId distinto (2 por operação), nenhuma a mais
      const inbox = await inboxOf(api.orm, queues.consumerName);
      expect(inbox).toHaveLength((sent / 3) * 2);

      // as três instâncias processaram mensagens (todas ao mesmo tempo, sobre as mesmas wallets)
      const workers = instances.filter((instance) =>
        instance.jsonLogs().some((log) => log.msg === 'message processed'),
      );
      expect(workers.length).toBeGreaterThanOrEqual(2);
    },
    CONCURRENCY_TIMEOUT_MS,
  );
});
