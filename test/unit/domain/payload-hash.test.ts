import { describe, expect, test } from 'bun:test';
import { InvalidFieldError } from '../../../src/domain/errors';
import {
  canonicalJson,
  computeWagerPayloadHash,
  sha256Hex,
  type WagerPayloadInput,
} from '../../../src/domain/wager/payload-hash';
import { brl, PLAYER_ID, WALLET_ID } from './builders';

const payload = (over: Partial<WagerPayloadInput> = {}): WagerPayloadInput => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: PLAYER_ID,
  walletId: WALLET_ID,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: brl('25.00'),
  ...over,
});

describe('canonicalJson', () => {
  test('ordena chaves recursivamente e não usa espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[2,{"y":2,"z":1}],"d":"x"},"b":1}',
    );
  });

  test('omite undefined e null (mesmo hash vindo de HTTP ou SQS)', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: null })).toBe('{"a":1}');
  });

  test('preserva a ordem de arrays e escapa strings como JSON', () => {
    expect(canonicalJson({ l: ['b', 'a'], s: 'a"b' })).toBe('{"l":["b","a"],"s":"a\\"b"}');
  });

  test('rejeita valores não serializáveis de forma estável', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(InvalidFieldError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(InvalidFieldError);
  });
});

describe('sha256Hex', () => {
  test('vetor conhecido', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('computeWagerPayloadHash', () => {
  test('é SHA-256 hex de 64 caracteres e determinístico', () => {
    const hash = computeWagerPayloadHash(payload());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeWagerPayloadHash(payload())).toBe(hash);
  });

  test('é o SHA-256 do JSON canônico dos campos de negócio', () => {
    const expected = sha256Hex(
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
        `"money":{"amount":"25.00","currency":"BRL"},"playerId":"${PLAYER_ID}","providerId":"provider-a",` +
        `"roundId":"round-987","walletId":"${WALLET_ID}"}`,
    );
    expect(computeWagerPayloadHash(payload())).toBe(expected);
  });

  test('amount normalizado: "25" e "25.00" geram o mesmo hash', () => {
    expect(computeWagerPayloadHash(payload({ money: brl('25') }))).toBe(
      computeWagerPayloadHash(payload({ money: brl('25.00') })),
    );
  });

  test('referência ausente (undefined/null) não altera o hash', () => {
    expect(computeWagerPayloadHash(payload({ referenceExternalTransactionId: undefined }))).toBe(
      computeWagerPayloadHash(payload()),
    );
  });

  test.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: 'outro-player' }],
    ['walletId', { walletId: 'outra-wallet' }],
    ['roundId', { roundId: 'round-1' }],
    ['gameId', { gameId: 'outro-jogo' }],
    ['kind', { kind: 'WIN' }],
    ['amount', { money: brl('25.01') }],
    ['currency', { money: { ...brl('25.00').toJSON(), currency: 'USD' } }],
    ['referência', { referenceExternalTransactionId: 'bet-1' }],
  ] as Array<[string, Partial<WagerPayloadInput>]>)('mudar %s muda o hash', (_name, change) => {
    const input = payload(change);
    // money pode vir como MoneyProps no teste de moeda; o hash aceita Money ou MoneyProps
    expect(computeWagerPayloadHash(input)).not.toBe(computeWagerPayloadHash(payload()));
  });

  test('a ordem das chaves do objeto de entrada não importa', () => {
    const a = payload();
    const reordered = Object.fromEntries(
      Object.entries(a).reverse(),
    ) as unknown as WagerPayloadInput;
    expect(computeWagerPayloadHash(reordered)).toBe(computeWagerPayloadHash(a));
  });

  test('campos fora do contrato de negócio (transporte) são ignorados', () => {
    const withExtras = {
      ...payload(),
      idempotencyKey: 'k',
      traceparent: 'abc',
    } as unknown as WagerPayloadInput;
    expect(computeWagerPayloadHash(withExtras)).toBe(computeWagerPayloadHash(payload()));
  });
});
