import { describe, expect, test } from 'bun:test';
import {
  InboxMessageConflictError,
  InvalidFieldError,
  InvalidMessageStateError,
} from '../../../src/domain/errors';
import { computeInboxPayloadHash, InboxMessage } from '../../../src/domain/messaging/inbox-message';
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

  test('reentrega com o mesmo conteúdo passa; outro conteúdo com o mesmo id é conflito', () => {
    const msg = InboxMessage.receive({
      messageId: 'msg-123',
      consumerName: 'wager-consumer',
      payloadHash: hash,
      receivedAt: T0,
    });
    expect(() => msg.assertRedeliveryOf(hash)).not.toThrow();
    expect(() => msg.assertRedeliveryOf('b'.repeat(64))).toThrow(InboxMessageConflictError);
  });
});

describe('computeInboxPayloadHash', () => {
  const input = {
    messageType: 'WagerTransactionRequested',
    idempotencyKey: 'provider-a:tx-1',
    wagerPayloadHash: 'c'.repeat(64),
  };

  test('SHA-256 hex, determinístico', () => {
    const value = computeInboxPayloadHash(input);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(computeInboxPayloadHash({ ...input })).toBe(value);
  });

  test('muda com o tipo, a key ou o conteúdo da transação', () => {
    const value = computeInboxPayloadHash(input);
    expect(computeInboxPayloadHash({ ...input, messageType: 'Other' })).not.toBe(value);
    expect(computeInboxPayloadHash({ ...input, idempotencyKey: 'provider-a:tx-2' })).not.toBe(
      value,
    );
    expect(computeInboxPayloadHash({ ...input, wagerPayloadHash: 'd'.repeat(64) })).not.toBe(value);
  });
});
