import { describe, expect, test } from 'bun:test';
import { InvalidMessageStateError } from '../../../src/domain/errors';
import { WagerTransactionProcessed } from '../../../src/domain/events/wager-transaction-processed';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { at } from './builders';
import { Harness } from './harness';

function event() {
  const h = new Harness('100.00');
  const loss = h.loss('loss-1', '25.00');
  h.submit(loss);
  return WagerTransactionProcessed.from(loss, {
    eventId: 'evt-1',
    correlationId: 'corr-1',
    occurredAt: at(10),
  });
}

const secondsUntilNext = (m: OutboxMessage, now: Date) =>
  ((m.nextAttemptAt as Date).getTime() - now.getTime()) / 1000;

describe('OutboxMessage.enqueue', () => {
  test('usa o eventId como id e grava o envelope serializado no payload', () => {
    const e = event();
    const msg = OutboxMessage.enqueue(e);
    expect(msg.id).toBe('evt-1');
    expect(msg.aggregateId).toBe(e.aggregateId);
    expect(msg.eventType).toBe('WagerTransactionProcessed');
    expect(msg.occurredAt).toEqual(at(10));
    expect(msg.payload).toEqual(e.toJSON() as unknown as Record<string, unknown>);
    expect(msg.attempts).toBe(0);
    expect(msg.publishedAt).toBeUndefined();
  });

  test('nasce pendente e vencida no instante do evento', () => {
    const msg = OutboxMessage.enqueue(event());
    expect(msg.isPending()).toBe(true);
    expect(msg.nextAttemptAt).toEqual(at(10));
    expect(msg.isDue(at(9))).toBe(false);
    expect(msg.isDue(at(10))).toBe(true);
    expect(msg.isDue(at(11))).toBe(true);
  });

  test('o payload é imutável (não muda se o objeto original mudar)', () => {
    const msg = OutboxMessage.enqueue(event());
    expect(Object.isFrozen(msg.payload)).toBe(true);
  });
});

describe('OutboxMessage.scheduleRetry', () => {
  test('incrementa attempts e aplica backoff 1s, 2s, 4s… com teto de 60s', () => {
    const msg = OutboxMessage.enqueue(event());
    const now = at(100);
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      msg.scheduleRetry(now);
      delays.push(secondsUntilNext(msg, now));
    }
    expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
    expect(msg.attempts).toBe(9);
  });

  test('uma mensagem com retry agendado não está vencida até o instante marcado', () => {
    const msg = OutboxMessage.enqueue(event());
    msg.scheduleRetry(at(100));
    expect(msg.isDue(at(100))).toBe(false);
    expect(msg.isDue(at(101))).toBe(true);
  });

  test('mensagem publicada não agenda retry', () => {
    const msg = OutboxMessage.enqueue(event());
    msg.markPublished(at(11));
    expect(() => msg.scheduleRetry(at(12))).toThrow(InvalidMessageStateError);
  });
});

describe('OutboxMessage.markPublished', () => {
  test('marca como publicada, deixa de ser pendente e de ser vencida', () => {
    const msg = OutboxMessage.enqueue(event());
    msg.markPublished(at(11));
    expect(msg.publishedAt).toEqual(at(11));
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(at(1000))).toBe(false);
  });

  test('publicar duas vezes é erro de programação', () => {
    const msg = OutboxMessage.enqueue(event());
    msg.markPublished(at(11));
    expect(() => msg.markPublished(at(12))).toThrow(InvalidMessageStateError);
  });
});

describe('OutboxMessage.rehydrate', () => {
  test('reconstrói estado persistido', () => {
    const msg = OutboxMessage.rehydrate({
      id: 'evt-9',
      aggregateId: 'agg',
      eventType: 'WalletBalanceChanged',
      payload: { a: 1 },
      occurredAt: at(1),
      attempts: 3,
      nextAttemptAt: at(50),
      publishedAt: undefined,
    });
    expect(msg.attempts).toBe(3);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(at(49))).toBe(false);
    expect(msg.isDue(at(50))).toBe(true);
  });
});
