import { describe, expect, test } from 'bun:test';
import {
  classifyError,
  ExternalTransactionConflictError,
  IntegrityViolationError,
  RepositoryMisuseError,
  RequestValidationError,
  TransientPersistenceError,
  UniqueViolationError,
  WagerTransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../src/application';
import {
  CurrencyMismatchError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidTransactionStateError,
} from '../../../src/domain';

describe('classifyError (uma classificação para HTTP e SQS)', () => {
  test.each([
    [new InvalidMoneyError('x'), 'validation', 'INVALID_MONEY'],
    [new RequestValidationError('INVALID_CURSOR', 'x'), 'validation', 'INVALID_CURSOR'],
    [new WalletNotFoundError('w'), 'not_found', 'WALLET_NOT_FOUND'],
    [new WagerTransactionNotFoundError('t'), 'not_found', 'TRANSACTION_NOT_FOUND'],
    [new IdempotencyConflictError('k'), 'conflict', 'IDEMPOTENCY_CONFLICT'],
    [new ExternalTransactionConflictError('p', 'e'), 'conflict', 'EXTERNAL_TRANSACTION_CONFLICT'],
    [new WalletAlreadyExistsError('p', 'BRL', undefined), 'conflict', 'WALLET_ALREADY_EXISTS'],
    [new UniqueViolationError('ux_x'), 'conflict', 'CONCURRENT_CONFLICT'],
    [new InsufficientFundsError('1', '0'), 'business', 'INSUFFICIENT_FUNDS'],
  ])('%p → %s / %s, sem retry', (error, kind, code) => {
    expect(classifyError(error)).toMatchObject({ kind, code, retryable: false });
  });

  test.each([
    ['lock_timeout', 'LOCK_TIMEOUT'],
    ['deadlock', 'LOCK_CONFLICT'],
    ['serialization', 'LOCK_CONFLICT'],
    ['connection', 'DATABASE_UNAVAILABLE'],
  ] as const)('transitório (%s) → %s, retryable', (reason, code) => {
    expect(classifyError(new TransientPersistenceError(reason))).toMatchObject({
      kind: 'transient',
      code,
      retryable: true,
    });
  });

  test('erros de programação viram INTERNAL_ERROR sem vazar a mensagem original', () => {
    for (const error of [
      new InvalidTransactionStateError('PROCESSED', 'reject'),
      new CurrencyMismatchError('BRL', 'USD'),
      new IntegrityViolationError('ck_x', 'insert into ... values (25.00)'),
      new RepositoryMisuseError('save sem lock'),
    ]) {
      const classified = classifyError(error);
      expect(classified).toMatchObject({ kind: 'invariant', code: 'INTERNAL_ERROR' });
      expect(classified.message).toBe('Erro interno inesperado');
    }
    expect(classifyError(new Error('boom'))).toMatchObject({
      kind: 'unknown',
      code: 'INTERNAL_ERROR',
      message: 'Erro interno inesperado',
    });
  });

  test('carrega detalhes de validação e o id da wallet que já existe', () => {
    const details = [{ path: 'money.amount', message: 'expected string' }];
    expect(
      classifyError(new RequestValidationError('INVALID_REQUEST', 'x', details)).details,
    ).toEqual(details);
    expect(classifyError(new WalletAlreadyExistsError('p', 'BRL', 'w-1')).context).toEqual({
      walletId: 'w-1',
    });
  });
});
