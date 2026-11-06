import { describe, expect, test } from 'bun:test';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  RequestValidationError,
} from '../../../src/application';

const WALLET = '01a1b1d0-34b1-74f3-a456-f46092eeccf1';
const OTHER = '01a1b1d0-34b1-74f3-a456-f46092eeccf2';

const expectInvalid = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RequestValidationError);
    expect((error as RequestValidationError).code).toBe('INVALID_CURSOR');
    return;
  }
  throw new Error('era esperado INVALID_CURSOR');
};

describe('cursor do ledger', () => {
  test('ida e volta: o cursor guarda a última walletVersion entregue', () => {
    const cursor = encodeLedgerCursor(WALLET, 42);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLedgerCursor(WALLET, cursor)).toBe(42);
  });

  test('sem cursor começa do início', () => {
    expect(decodeLedgerCursor(WALLET, undefined)).toBe(0);
  });

  test('cursor de outra wallet é inválido', () => {
    expectInvalid(() => decodeLedgerCursor(OTHER, encodeLedgerCursor(WALLET, 3)));
  });

  test.each([
    ['vazio', ''],
    ['fora do alfabeto base64url', 'abc+/='],
    ['não é JSON', Buffer.from('oi').toString('base64url')],
    [
      'versão desconhecida',
      Buffer.from(JSON.stringify({ v: 2, w: WALLET, after: 1 })).toString('base64url'),
    ],
    [
      'after zero',
      Buffer.from(JSON.stringify({ v: 1, w: WALLET, after: 0 })).toString('base64url'),
    ],
    [
      'after fracionário',
      Buffer.from(JSON.stringify({ v: 1, w: WALLET, after: 1.5 })).toString('base64url'),
    ],
    [
      'after texto',
      Buffer.from(JSON.stringify({ v: 1, w: WALLET, after: '3' })).toString('base64url'),
    ],
    ['JSON null', Buffer.from('null').toString('base64url')],
  ])('%s → INVALID_CURSOR', (_, cursor) => {
    expectInvalid(() => decodeLedgerCursor(WALLET, cursor));
  });
});
