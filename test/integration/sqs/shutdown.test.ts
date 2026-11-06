import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { WagerMessageConsumer } from '../../../src/interfaces/sqs/wager-message-consumer';
import { AppInstance } from '../../support/cluster';
import { expectConsistentWallets } from '../../support/consistency';
import {
  type CreatedWallet,
  createWallet,
  startTestApp,
  type TestApp,
} from '../../support/http-app';
import { ledgerOf, transactionsByKey } from '../../support/inspect';
import { TestQueues, type WagerMessage, wagerMessage } from '../../support/sqs';
import { SqsProxy } from '../../support/sqs-proxy';
import { holdWalletLock, waitForWalletLockWaiters, waitUntil } from '../../support/sync';

/**
 * Desligamento gracioso do consumer. Três mensagens da mesma wallet chegam no mesmo lote; a
 * primeira fica parada no lock da wallet (barreira do teste) quando o desligamento começa.
 * Esperado: a primeira termina e recebe ack, as outras voltam para a fila na hora (não depois dos
 * 30s de visibilidade), nenhuma busca nova é feita, e um consumer novo processa o resto: nada se
 * perde e nada se repete.
 *
 * `app.close()` é o que o Nest executa no SIGTERM (`enableShutdownHooks` em `main.ts`). O teste com
 * sinal real num processo separado só roda em Linux/macOS: no Windows, `kill` sempre encerra à
 * força (ARCHITECTURE §18).
 */

const TIMEOUT_MS = 60_000;

describe('shutdown gracioso do consumer (LocalStack + Postgres reais)', () => {
  let api: TestApp;
  const wallets = new Set<string>();
  const cleanups: (() => Promise<void> | void)[] = [];

  const open = async (initial: string): Promise<CreatedWallet> => {
    const wallet = await createWallet(api, initial);
    wallets.add(wallet.id);
    return wallet;
  };

  const threeBets = async (wallet: CreatedWallet, queues: TestQueues): Promise<WagerMessage[]> => {
    const messages = ['m1', 'm2', 'm3'].map((name) =>
      wagerMessage(wallet, {
        kind: 'BET',
        amount: '10.00',
        externalTransactionId: `${name}-${randomBytes(4).toString('hex')}`,
      }),
    );
    for (const message of messages) {
      await queues.sendWager(message);
    }
    return messages;
  };

  /** Consumer novo processa o que sobrou: as três aplicadas uma vez, na ordem do grupo. */
  const finishWithNewConsumer = async (
    queues: TestQueues,
    wallet: CreatedWallet,
    messages: WagerMessage[],
  ) => {
    const next = await startTestApp(queues.consumerEnv());
    try {
      await waitUntil('fila vazia', () => queues.isEmpty(), TIMEOUT_MS);
    } finally {
      await next.close();
    }
    const ids: string[] = [];
    for (const message of messages) {
      const [tx, ...others] = await transactionsByKey(api.orm, message.idempotencyKey);
      expect(others).toEqual([]);
      expect(tx?.status).toBe('PROCESSED');
      ids.push(tx?.id ?? '');
    }
    const ledger = await ledgerOf(api.orm, wallet.id);
    expect(ledger.slice(1).map((entry) => entry.transactionId)).toEqual(ids);
    expect(ledger.at(-1)?.balanceAfter).toBe('70.00');
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
    'app.close() (caminho do SIGTERM): termina a em andamento, devolve as outras na hora, não busca mais',
    async () => {
      const queues = await TestQueues.create();
      const proxy = SqsProxy.start();
      cleanups.push(async () => {
        proxy.stop();
        await queues.destroy();
      });
      const consumer = await startTestApp(
        queues.consumerEnv({ SQS_ENDPOINT: proxy.url, DB_APPLICATION_NAME: 'sqs-shutdown' }),
      );
      const loop = consumer.get(WagerMessageConsumer);
      const wallet = await open('100.00');

      const lock = await holdWalletLock(api.orm, wallet.id);
      let closing: Promise<void> | undefined;
      let receivesAtClose = 0;
      let messages: WagerMessage[] = [];
      try {
        messages = await threeBets(wallet, queues);
        await waitForWalletLockWaiters(api.orm, 'sqs-shutdown', 1, { timeoutMs: TIMEOUT_MS });

        receivesAtClose = proxy.of('ReceiveMessage').length;
        closing = consumer.close();
        await waitUntil('consumer parou de buscar', async () => !loop.isRunning);
        // a mensagem em andamento segura o desligamento
        let closed = false;
        void closing.then(() => {
          closed = true;
        });
        await Bun.sleep(50);
        expect(closed).toBe(false);
      } finally {
        await lock.release();
      }
      await closing;

      const [m1, m2, m3] = messages as [WagerMessage, WagerMessage, WagerMessage];
      expect(await transactionsByKey(api.orm, m1.idempotencyKey)).toMatchObject([
        { status: 'PROCESSED' },
      ]);
      expect(await transactionsByKey(api.orm, m2.idempotencyKey)).toEqual([]);
      expect(await transactionsByKey(api.orm, m3.idempotencyKey)).toEqual([]);
      expect(proxy.of('DeleteMessage')).toHaveLength(1);
      expect(proxy.of('ReceiveMessage')).toHaveLength(receivesAtClose);

      // as que chegaram no lote e não começaram voltaram com visibilidade 0 ...
      const released = new Set(
        proxy
          .of('ChangeMessageVisibility')
          .filter((call) => call.input.VisibilityTimeout === 0)
          .map((call) => call.input.ReceiptHandle as string),
      );
      const receivedOthers = proxy
        .of('ReceiveMessage')
        .flatMap((call) => call.received ?? [])
        .filter((received) => received.messageId !== m1.messageId);
      for (const received of receivedOthers) {
        expect(released.has(received.receiptHandle)).toBe(true);
      }
      // ... então estão visíveis já, e não presas em voo pelos 30s de visibilidade
      expect(await queues.counts()).toEqual({ visible: 2, inFlight: 0 });

      await finishWithNewConsumer(queues, wallet, messages);
    },
    TIMEOUT_MS,
  );

  test.skipIf(process.platform === 'win32')(
    'SIGTERM real num processo: mesmo comportamento, e o processo termina',
    async () => {
      const queues = await TestQueues.create();
      cleanups.push(() => queues.destroy());
      const name = `sigterm-${randomBytes(3).toString('hex')}`;
      const instance = await AppInstance.start(name, queues.consumerEnv());
      cleanups.push(() => instance.kill());
      const wallet = await open('100.00');

      const lock = await holdWalletLock(api.orm, wallet.id);
      let messages: WagerMessage[] = [];
      let exited: Promise<void> | undefined;
      try {
        messages = await threeBets(wallet, queues);
        await waitForWalletLockWaiters(api.orm, name, 1, { timeoutMs: TIMEOUT_MS });
        exited = instance.terminate();
        const logged = (msg: string) => instance.jsonLogs().some((log) => log.msg === msg);
        await waitUntil('SIGTERM tratado', async () => logged('consumer stopping'), TIMEOUT_MS);
        // a mensagem em andamento segura o processo
        expect(instance.alive).toBe(true);
        expect(logged('consumer stopped')).toBe(false);
      } finally {
        await lock.release();
      }
      await exited;
      await waitUntil(
        'log final do consumer',
        async () =>
          instance.jsonLogs().some((log) => log.msg === 'consumer stopped' && log.drained === true),
        TIMEOUT_MS,
      );

      const [m1] = messages as [WagerMessage];
      expect(await transactionsByKey(api.orm, m1.idempotencyKey)).toMatchObject([
        { status: 'PROCESSED' },
      ]);
      expect(await queues.counts()).toEqual({ visible: 2, inFlight: 0 });
      await finishWithNewConsumer(queues, wallet, messages);
    },
    TIMEOUT_MS,
  );
});
