import { describe, expect, test } from 'bun:test';
import { InvalidFieldError, InvalidMessageStateError } from '../../../src/domain/errors';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { at, T0 } from './builders';

const hash = 'a'.repeat(64);

describe('InboxMessage', () => {
  test('receive: nasce não processada', () => {
    const msg = InboxMessage.receive({
      messageId: 'msg-123',
      consumerName: 'wager-consumer',
      payloadHash: hash,
      receivedAt: T0,
    });
    expect(msg.messageId).toBe('msg-123');
    expect(msg.consumerName).toBe('wager-consumer');
    expect(msg.payloadHash).toBe(hash);
    expect(msg.receivedAt).toEqual(T0);
    expect(msg.isProcessed()).toBe(false);
    expect(msg.processedAt).toBeUndefined();
  });

  test('markProcessed registra o instante', () => {
    const msg = InboxMessage.receive({
      messageId: 'msg-123',
      consumerName: 'wager-consumer',
      payloadHash: hash,
      receivedAt: T0,
    });
    msg.markProcessed(at(2));
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(at(2));
  });

  test('processar duas vezes é erro de programação e não muda o instante', () => {
    const msg = InboxMessage.receive({
      messageId: 'msg-123',
      consumerName: 'wager-consumer',
      payloadHash: hash,
      receivedAt: T0,
    });
    msg.markProcessed(at(2));
    expect(() => msg.markProcessed(at(3))).toThrow(InvalidMessageStateError);
    expect(msg.processedAt).toEqual(at(2));
  });

  test('valida campos obrigatórios e o formato do hash', () => {
    const ok = { messageId: 'm', consumerName: 'c', payloadHash: hash, receivedAt: T0 };
    expect(() => InboxMessage.receive({ ...ok, messageId: '' })).toThrow(InvalidFieldError);
    expect(() => InboxMessage.receive({ ...ok, consumerName: '' })).toThrow(InvalidFieldError);
    expect(() => InboxMessage.receive({ ...ok, payloadHash: 'xyz' })).toThrow(InvalidFieldError);
  });

  test('rehydrate reconstrói sem revalidar', () => {
    const msg = InboxMessage.rehydrate({
      messageId: 'msg-1',
      consumerName: 'c',
      payloadHash: hash,
      receivedAt: T0,
      processedAt: at(1),
    });
    expect(msg.isProcessed()).toBe(true);
    expect(() => msg.markProcessed(at(2))).toThrow(InvalidMessageStateError);
  });
});
