import { describe, expect, test } from 'bun:test';
import { RequestValidationError } from '../../../../src/application';
import { parseWagerMessage } from '../../../../src/interfaces/sqs/wager-message';

const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

/** Exemplo da seção 10 do desafio. */
const sample = () => ({
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: PLAYER,
    walletId: WALLET,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
});

const codeOf = (body: string): string => {
  try {
    parseWagerMessage(body);
  } catch (error) {
    expect(error).toBeInstanceOf(RequestValidationError);
    return (error as RequestValidationError).code;
  }
  throw new Error('era esperado erro de validação');
};

describe('parseWagerMessage', () => {
  test('envelope do desafio vira o mesmo comando do HTTP; messageId é correlação e causa', () => {
    const parsed = parseWagerMessage(JSON.stringify(sample()));
    expect(parsed.messageId).toBe('msg-123');
    expect(parsed.type).toBe('WagerTransactionRequested');
    expect(parsed.command).toEqual({
      ...sample().data,
      referenceExternalTransactionId: undefined,
      correlationId: 'msg-123',
      causationId: 'msg-123',
    });
  });

  test('correlationId do envelope é usado quando válido; inválido é ignorado', () => {
    const valid = parseWagerMessage(JSON.stringify({ ...sample(), correlationId: 'corr-1' }));
    expect(valid.command.correlationId).toBe('corr-1');
    const invalid = parseWagerMessage(JSON.stringify({ ...sample(), correlationId: 'com espaço' }));
    expect(invalid.command.correlationId).toBe('msg-123');
  });

  test('referência e campos desconhecidos', () => {
    const body = sample();
    const parsed = parseWagerMessage(
      JSON.stringify({
        ...body,
        extra: true,
        data: { ...body.data, kind: 'REFUND', referenceExternalTransactionId: 'bet-1', x: 1 },
      }),
    );
    expect(parsed.command.referenceExternalTransactionId).toBe('bet-1');
    expect(parsed.command).not.toHaveProperty('x');
  });

  test.each([
    ['não é JSON', '{', 'MALFORMED_MESSAGE'],
    ['JSON que não é objeto', '[]', 'MALFORMED_MESSAGE'],
    [
      'tipo desconhecido',
      JSON.stringify({ ...sample(), type: 'Other' }),
      'UNSUPPORTED_MESSAGE_TYPE',
    ],
    ['sem messageId', JSON.stringify({ ...sample(), messageId: undefined }), 'MALFORMED_MESSAGE'],
    ['messageId vazio', JSON.stringify({ ...sample(), messageId: '' }), 'INVALID_MESSAGE_ID'],
    [
      'messageId com espaço',
      JSON.stringify({ ...sample(), messageId: 'a b' }),
      'INVALID_MESSAGE_ID',
    ],
    [
      'occurredAt inválido',
      JSON.stringify({ ...sample(), occurredAt: 'ontem' }),
      'MALFORMED_MESSAGE',
    ],
    [
      'dinheiro como número',
      JSON.stringify({
        ...sample(),
        data: { ...sample().data, money: { amount: 25, currency: 'BRL' } },
      }),
      'MALFORMED_MESSAGE',
    ],
    [
      'sem idempotencyKey',
      JSON.stringify({ ...sample(), data: { ...sample().data, idempotencyKey: undefined } }),
      'MALFORMED_MESSAGE',
    ],
    [
      'idempotencyKey com espaço na ponta',
      JSON.stringify({ ...sample(), data: { ...sample().data, idempotencyKey: ' k' } }),
      'INVALID_IDEMPOTENCY_KEY',
    ],
  ])('%s → %s', (_label, body, code) => {
    expect(codeOf(body)).toBe(code);
  });
});
