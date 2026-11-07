import { describe, expect, test } from 'bun:test';
import {
  type EventPublisher,
  PublishOutbox,
  type PublishResult,
  type TransactionScope,
  type UnitOfWork,
} from '../../../src/application';
import { WagerTransactionProcessed } from '../../../src/domain/events/wager-transaction-processed';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { at } from '../domain/builders';
import { Harness } from '../domain/harness';

/** Mensagens de outbox reais (do domínio), vencidas em at(10). */
function messages(count: number): OutboxMessage[] {
  const h = new Harness('100.00');
  return Array.from({ length: count }, (_, i) => {
    const loss = h.loss(`loss-${i}`, '1.00');
    h.submit(loss);
    return OutboxMessage.enqueue(
      WagerTransactionProcessed.from(loss, {
        eventId: `evt-${i}`,
        correlationId: 'corr',
        occurredAt: at(10),
      }),
    );
  });
}

/** UnitOfWork em memória: só a outbox, que devolve as mensagens dadas e registra os saves. */
function fakeUow(due: OutboxMessage[]) {
  const saved: OutboxMessage[] = [];
  const uow: UnitOfWork = {
    run: (work) =>
      work({
        outbox: {
          claimDue: async () => due,
          save: async (message: OutboxMessage) => {
            saved.push(message);
          },
        },
      } as unknown as TransactionScope),
  };
  return { uow, saved };
}

const clock = { now: () => at(20) };

const publisher = (
  fn: (m: readonly OutboxMessage[]) => Promise<PublishResult>,
): EventPublisher & {
  calls: number;
} => {
  const p = {
    calls: 0,
    publish: (m: readonly OutboxMessage[]) => {
      p.calls += 1;
      return fn(m);
    },
  };
  return p;
};

describe('PublishOutbox', () => {
  test('nada vencido: não chama o broker', async () => {
    const { uow } = fakeUow([]);
    const broker = publisher(async () => ({ published: [], failed: [] }));
    const summary = await new PublishOutbox(uow, broker, clock, { batchSize: 10 }).publishDue();
    expect(summary).toEqual({ claimed: 0, published: 0, failed: [], publishedEvents: [] });
    expect(broker.calls).toBe(0);
  });

  test('falha parcial: aceitas são marcadas, recusadas e sem confirmação voltam com backoff', async () => {
    const due = messages(3);
    const { uow, saved } = fakeUow(due);
    const broker = publisher(async () => ({
      published: ['evt-0'],
      failed: [{ messageId: 'evt-1', reason: 'InvalidMessageContents' }],
      // evt-2 não aparece em nenhuma lista
    }));
    const summary = await new PublishOutbox(uow, broker, clock, { batchSize: 10 }).publishDue();

    expect(summary).toEqual({
      claimed: 3,
      published: 1,
      failed: [
        { messageId: 'evt-1', reason: 'InvalidMessageContents' },
        { messageId: 'evt-2', reason: 'NOT_ACKNOWLEDGED' },
      ],
      publishedEvents: [
        {
          eventId: 'evt-0',
          eventType: 'WagerTransactionProcessed',
          aggregateId: due[0]?.aggregateId ?? '',
          correlationId: 'corr',
          occurredAt: at(10),
          publishedAt: at(20),
        },
      ],
    });
    expect(saved.map((m) => m.id)).toEqual(['evt-0', 'evt-1', 'evt-2']);
    const [ok, refused, silent] = due;
    expect(ok?.publishedAt).toEqual(at(20));
    for (const m of [refused, silent]) {
      expect(m?.publishedAt).toBeUndefined();
      expect(m?.attempts).toBe(1);
      expect(m?.nextAttemptAt).toEqual(at(21));
    }
  });

  test('broker fora do ar (exceção): todas voltam com backoff e o motivo é só o nome do erro', async () => {
    const due = messages(2);
    const { uow, saved } = fakeUow(due);
    const broker = publisher(async () => {
      const error = new Error('corpo com dados do evento');
      error.name = 'TimeoutError';
      throw error;
    });
    const summary = await new PublishOutbox(uow, broker, clock, { batchSize: 10 }).publishDue();
    expect(summary.published).toBe(0);
    expect(summary.failed).toEqual([
      { messageId: 'evt-0', reason: 'TimeoutError' },
      { messageId: 'evt-1', reason: 'TimeoutError' },
    ]);
    expect(saved.every((m) => m.attempts === 1 && m.publishedAt === undefined)).toBe(true);
  });

  test('batchSize inválido é erro de configuração', () => {
    const { uow } = fakeUow([]);
    const broker = publisher(async () => ({ published: [], failed: [] }));
    expect(() => new PublishOutbox(uow, broker, clock, { batchSize: 0 })).toThrow();
  });
});
