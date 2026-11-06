import { afterEach, describe, expect, test } from 'bun:test';
import {
  type MessageDelivery,
  type ProcessWagerTransactionCommand,
  TransientPersistenceError,
  type WagerTransactionOutcome,
  WalletNotFoundError,
} from '../../../../src/application';
import { WagerTransactionStatus } from '../../../../src/domain';
import { createLogger } from '../../../../src/infrastructure/logging/logger';
import {
  type WagerConsumerOptions,
  WagerMessageConsumer,
} from '../../../../src/interfaces/sqs/wager-message-consumer';
import type {
  DeadLetterReason,
  QueueMessage,
  WagerQueue,
} from '../../../../src/interfaces/sqs/wager-queue';

/**
 * Loop do consumer com uma fila em memória (teste unitário: o SQS real é coberto em
 * test/integration/sqs). O use case é um dublê que o teste controla mensagem a mensagem.
 */

type QueueCall =
  | { op: 'ack'; id: string }
  | { op: 'retry'; id: string; seconds: number }
  | { op: 'dlq'; id: string; reason: DeadLetterReason };

class FakeQueue implements WagerQueue {
  readonly calls: QueueCall[] = [];
  receives = 0;
  failNextReceives = 0;
  /** Duração do long poll sem mensagens (o SQS devolve vazio no fim do WaitTimeSeconds). */
  waitMs = 30;
  aborted = false;
  readonly receiveTimes: number[] = [];
  private readonly pending: QueueMessage[][] = [];
  private waiter: ((batch: QueueMessage[]) => void) | undefined;

  push(batch: QueueMessage[]): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve(batch);
    } else {
      this.pending.push(batch);
    }
  }

  receive(signal: AbortSignal): Promise<QueueMessage[]> {
    this.receives += 1;
    this.receiveTimes.push(performance.now());
    if (this.failNextReceives > 0) {
      this.failNextReceives -= 1;
      return Promise.reject(new Error('sqs indisponível'));
    }
    const next = this.pending.shift();
    if (next) {
      return Promise.resolve(next);
    }
    // long polling: espera um lote novo, o fim do prazo ou um abort
    return new Promise((resolve) => {
      const finish = (batch: QueueMessage[]): void => {
        clearTimeout(timer);
        if (this.waiter === finish) {
          this.waiter = undefined;
        }
        resolve(batch);
      };
      const timer = setTimeout(() => finish([]), this.waitMs);
      signal.addEventListener(
        'abort',
        () => {
          this.aborted = true;
          finish([]);
        },
        { once: true },
      );
      this.waiter = finish;
    });
  }

  async ack(message: QueueMessage): Promise<void> {
    this.calls.push({ op: 'ack', id: idOf(message) });
  }

  async retryAfter(message: QueueMessage, seconds: number): Promise<void> {
    this.calls.push({ op: 'retry', id: idOf(message), seconds });
  }

  async deadLetter(message: QueueMessage, reason: DeadLetterReason): Promise<void> {
    this.calls.push({ op: 'dlq', id: idOf(message), reason });
  }
}

const idOf = (message: QueueMessage): string => message.sqsMessageId.replace(/^sqs-/, '');

function message(id: string, group: string, receiveCount = 1): QueueMessage {
  return {
    sqsMessageId: `sqs-${id}`,
    receiptHandle: `rh-${id}-${receiveCount}`,
    body: JSON.stringify({
      messageId: id,
      type: 'WagerTransactionRequested',
      occurredAt: '2026-07-29T15:00:00.000Z',
      data: {
        providerId: 'provider-a',
        externalTransactionId: id,
        idempotencyKey: `provider-a:${id}`,
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        walletId: group,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    }),
    groupId: group,
    receiveCount,
  };
}

interface Deferred {
  resolve: (outcome?: WagerTransactionOutcome) => void;
  reject: (error: unknown) => void;
}

/** Dublê do use case: cada messageId pode ser resolvido na hora ou segurado pelo teste. */
class ScriptedUseCase {
  readonly started: string[] = [];
  readonly deliveries: MessageDelivery[] = [];
  readonly held = new Map<string, Deferred>();
  readonly failures = new Map<string, unknown>();
  readonly holds = new Set<string>();
  /** Ordem em que as chamadas terminaram (o ack tem que vir depois). */
  readonly finished: string[] = [];

  execute = (
    command: ProcessWagerTransactionCommand,
    delivery?: MessageDelivery,
  ): Promise<WagerTransactionOutcome> => {
    const id = command.externalTransactionId;
    this.started.push(id);
    if (delivery) {
      this.deliveries.push(delivery);
    }
    const done = (outcome?: WagerTransactionOutcome): WagerTransactionOutcome => {
      this.finished.push(id);
      return outcome ?? processed(id);
    };
    const failure = this.failures.get(id);
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    if (!this.holds.has(id)) {
      return Promise.resolve(done());
    }
    return new Promise((resolve, reject) => {
      this.held.set(id, { resolve: (outcome) => resolve(done(outcome)), reject });
    });
  };
}

const processed = (id: string): WagerTransactionOutcome => ({
  transactionId: `tx-${id}`,
  status: WagerTransactionStatus.Processed,
  balance: { amount: '75.00', currency: 'BRL' },
  idempotentReplay: false,
});

/** Espera uma condição (o consumer roda em microtasks/timers próprios). */
async function until(description: string, condition: () => boolean, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error(`não aconteceu em ${timeoutMs}ms: ${description}`);
    }
    await Bun.sleep(1);
  }
}

const clock = { now: () => new Date('2026-11-06T12:00:00.000Z') };
const silent = createLogger('silent');

describe('WagerMessageConsumer (fila em memória)', () => {
  let queue: FakeQueue;
  let useCase: ScriptedUseCase;
  let consumer: WagerMessageConsumer;

  const start = (
    options: Partial<WagerConsumerOptions> = {},
    prepare: (fake: FakeQueue) => void = () => {},
  ) => {
    queue = new FakeQueue();
    prepare(queue);
    useCase = new ScriptedUseCase();
    consumer = new WagerMessageConsumer(queue, useCase, clock, silent, {
      consumerName: 'wager-consumer',
      retry: { baseDelayS: 2, maxDelayS: 60 },
      shutdownTimeoutMs: 1_000,
      idleBackoff: { initialMs: 50, maxMs: 200 },
      ...options,
    });
    consumer.start();
  };

  afterEach(async () => {
    await consumer?.stop();
  });

  test('ack só depois que o use case termina, com a entrega certa para a inbox', async () => {
    start();
    useCase.holds.add('m1');
    queue.push([message('m1', 'w1')]);
    await until('m1 em processamento', () => useCase.held.has('m1'));
    expect(queue.calls).toEqual([]);

    useCase.held.get('m1')?.resolve();
    await until('ack de m1', () => queue.calls.length === 1);
    expect(queue.calls).toEqual([{ op: 'ack', id: 'm1' }]);
    expect(useCase.deliveries).toEqual([
      {
        consumerName: 'wager-consumer',
        messageId: 'm1',
        messageType: 'WagerTransactionRequested',
        receivedAt: clock.now(),
      },
    ]);
  });

  test('REJECTED e PENDING_REFERENCE também recebem ack (resultado já gravado)', async () => {
    start();
    useCase.holds.add('r1');
    useCase.holds.add('p1');
    queue.push([message('r1', 'w1'), message('p1', 'w2')]);
    await until('ambas em processamento', () => useCase.held.size === 2);
    useCase.held.get('r1')?.resolve({
      ...processed('r1'),
      status: WagerTransactionStatus.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS' as never,
    });
    useCase.held
      .get('p1')
      ?.resolve({ ...processed('p1'), status: WagerTransactionStatus.PendingReference });
    await until('dois acks', () => queue.calls.length === 2);
    expect(queue.calls.map((c) => c.op)).toEqual(['ack', 'ack']);
  });

  test('permanente → DLQ; transitório → visibilidade com backoff pela contagem do SQS', async () => {
    start();
    useCase.failures.set('nf', new WalletNotFoundError('w'));
    useCase.failures.set('lt', new TransientPersistenceError('lock_timeout'));
    queue.push([
      { ...message('bad', 'w0'), body: '{' },
      message('nf', 'w1'),
      message('lt', 'w2', 3),
    ]);
    await until('três decisões', () => queue.calls.length === 3);
    expect(queue.calls).toContainEqual({
      op: 'dlq',
      id: 'bad',
      reason: { kind: 'validation', code: 'MALFORMED_MESSAGE' },
    });
    expect(queue.calls).toContainEqual({
      op: 'dlq',
      id: 'nf',
      reason: { kind: 'not_found', code: 'WALLET_NOT_FOUND' },
    });
    expect(queue.calls).toContainEqual({ op: 'retry', id: 'lt', seconds: 8 });
    // mensagem malformada nem chega ao use case
    expect(useCase.started).not.toContain('bad');
  });

  test('mesmo grupo em ordem, grupos diferentes em paralelo', async () => {
    start();
    for (const id of ['a1', 'a2', 'b1']) {
      useCase.holds.add(id);
    }
    queue.push([message('a1', 'wa'), message('a2', 'wa'), message('b1', 'wb')]);
    await until('a1 e b1 juntas', () => useCase.held.has('a1') && useCase.held.has('b1'));
    expect(useCase.started).not.toContain('a2');

    useCase.held.get('a1')?.resolve();
    await until('a2 depois de a1', () => useCase.held.has('a2'));
    useCase.held.get('a2')?.resolve();
    useCase.held.get('b1')?.resolve();
    await until('três acks', () => queue.calls.length === 3);
    const acks = queue.calls.map((c) => c.id);
    expect(acks.indexOf('a1')).toBeLessThan(acks.indexOf('a2'));
  });

  test('retry no meio do grupo: as seguintes voltam com o mesmo atraso, sem processar', async () => {
    start();
    useCase.failures.set('a1', new TransientPersistenceError('lock_timeout'));
    queue.push([
      message('a1', 'wa', 2),
      message('a2', 'wa'),
      message('a3', 'wa'),
      message('b1', 'wb'),
    ]);
    await until('quatro decisões', () => queue.calls.length === 4);
    expect(queue.calls).toContainEqual({ op: 'retry', id: 'a1', seconds: 4 });
    expect(queue.calls).toContainEqual({ op: 'retry', id: 'a2', seconds: 4 });
    expect(queue.calls).toContainEqual({ op: 'retry', id: 'a3', seconds: 4 });
    expect(queue.calls).toContainEqual({ op: 'ack', id: 'b1' });
    expect(useCase.started.sort()).toEqual(['a1', 'b1']);
  });

  test('SIGTERM: termina a mensagem em andamento, devolve as que não começaram e para de buscar', async () => {
    start();
    useCase.holds.add('a1');
    queue.push([message('a1', 'wa'), message('a2', 'wa'), message('a3', 'wa')]);
    await until('a1 em processamento', () => useCase.held.has('a1'));
    const receivesBefore = queue.receives;

    const stopped = consumer.stop();
    let stopDone = false;
    void stopped.then(() => {
      stopDone = true;
    });
    await Bun.sleep(20);
    // a em andamento segura o shutdown
    expect(stopDone).toBe(false);
    expect(consumer.isRunning).toBe(false);

    useCase.held.get('a1')?.resolve();
    await stopped;
    expect(queue.calls).toEqual([
      { op: 'ack', id: 'a1' },
      { op: 'retry', id: 'a2', seconds: 0 },
      { op: 'retry', id: 'a3', seconds: 0 },
    ]);
    expect(useCase.started).toEqual(['a1']);
    expect(queue.receives).toBe(receivesBefore);
  });

  test('SIGTERM durante o long poll: não cancela; o que chegar nele volta na hora', async () => {
    start({}, (fake) => {
      fake.waitMs = 300;
    });
    await until('long poll aberto', () => queue.receives === 1);
    const stopped = consumer.stop();
    // o SQS entrega na requisição que continua aberta do lado dele
    queue.push([message('a1', 'wa'), message('b1', 'wb')]);
    await stopped;
    expect(queue.calls).toContainEqual({ op: 'retry', id: 'a1', seconds: 0 });
    expect(queue.calls).toContainEqual({ op: 'retry', id: 'b1', seconds: 0 });
    expect(queue.calls).toHaveLength(2);
    expect(useCase.started).toEqual([]);
    expect(queue.aborted).toBe(false);
    expect(queue.receives).toBe(1);
  });

  test('SIGTERM com prazo estourado: devolve também a em andamento e ignora o desfecho tardio', async () => {
    start({ shutdownTimeoutMs: 50 });
    useCase.holds.add('a1');
    queue.push([message('a1', 'wa'), message('a2', 'wa')]);
    await until('a1 em processamento', () => useCase.held.has('a1'));

    await consumer.stop();
    expect(queue.calls).toContainEqual({ op: 'retry', id: 'a1', seconds: 0 });
    expect(queue.calls).toContainEqual({ op: 'retry', id: 'a2', seconds: 0 });

    // o COMMIT veio depois: sem ack (a reentrega cai na inbox)
    useCase.held.get('a1')?.resolve();
    await Bun.sleep(10);
    expect(queue.calls.filter((c) => c.id === 'a1')).toEqual([
      { op: 'retry', id: 'a1', seconds: 0 },
    ]);
  });

  test('SQS fora do ar: o loop pausa com backoff em vez de girar', async () => {
    start({ idleBackoff: { initialMs: 40, maxMs: 80 } }, (fake) => {
      fake.failNextReceives = 3;
    });
    await until('quatro buscas', () => queue.receives >= 4, 3_000);
    const gaps = queue.receiveTimes.slice(1, 4).map((t, i) => t - (queue.receiveTimes[i] ?? 0));
    // 40ms, 80ms, 80ms (teto), com folga para o timer
    expect(gaps[0]).toBeGreaterThanOrEqual(35);
    expect(gaps[1]).toBeGreaterThanOrEqual(75);
    expect(gaps[2]).toBeGreaterThanOrEqual(75);
  });

  test('banco fora do ar (DATABASE_UNAVAILABLE): pausa antes de buscar o próximo lote', async () => {
    start({ idleBackoff: { initialMs: 60, maxMs: 60 } });
    useCase.failures.set('c1', new TransientPersistenceError('connection'));
    queue.push([message('c1', 'wa')]);
    await until('retry de c1', () => queue.calls.length === 1);
    const afterBatch = performance.now();
    await until('próxima busca', () => queue.receives >= 2);
    expect(queue.receiveTimes[1] ?? 0).toBeGreaterThanOrEqual(afterBatch + 50);
  });
});
