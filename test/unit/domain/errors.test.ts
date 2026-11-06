import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  DomainError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidAmountError,
  InvalidFailureCodeError,
  InvalidFieldError,
  InvalidMessageStateError,
  InvalidMoneyError,
  InvalidTransactionKindError,
  InvalidTransactionStateError,
  MissingReferenceError,
  UnbalancedLedgerEntryError,
} from '../../../src/domain/errors';
import {
  BUSINESS_FAILURE_CODES,
  FAILURE_CODE_GUIDANCE,
  FailureCode,
  isBusinessFailureCode,
} from '../../../src/domain/wager/failure-code';

describe('erros de domínio', () => {
  const cases: Array<[DomainError, string, string]> = [
    [new InvalidMoneyError('x'), 'INVALID_MONEY', 'validation'],
    [new InvalidAmountError('x'), 'INVALID_AMOUNT', 'validation'],
    [new InvalidFieldError('roundId', 'vazio'), 'INVALID_FIELD', 'validation'],
    [new InvalidTransactionKindError('OPENING'), 'INVALID_TRANSACTION_KIND', 'validation'],
    [new MissingReferenceError('REFUND'), 'MISSING_REFERENCE', 'validation'],
    [new InsufficientFundsError('10.00', '20.00'), 'INSUFFICIENT_FUNDS', 'business'],
    [new IdempotencyConflictError('k'), 'IDEMPOTENCY_CONFLICT', 'conflict'],
    [new CurrencyMismatchError('BRL', 'USD'), 'CURRENCY_MISMATCH', 'invariant'],
    [
      new InvalidTransactionStateError('PROCESSED', 'reject'),
      'INVALID_TRANSACTION_STATE',
      'invariant',
    ],
    [new UnbalancedLedgerEntryError('x'), 'UNBALANCED_LEDGER_ENTRY', 'invariant'],
    [new InvalidFailureCodeError('x'), 'INVALID_FAILURE_CODE', 'invariant'],
    [new InvalidMessageStateError('x'), 'INVALID_MESSAGE_STATE', 'invariant'],
  ];

  for (const [error, code, category] of cases) {
    test(`${error.constructor.name} tem code=${code} e category=${category}`, () => {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.category).toBe(category as never);
      expect(error.name).toBe(error.constructor.name);
    });
  }
});

describe('FailureCode', () => {
  test('contém a taxonomia documentada', () => {
    expect(Object.values(FailureCode).map(String).sort()).toEqual(
      [
        'INSUFFICIENT_FUNDS',
        'REVERSAL_INSUFFICIENT_FUNDS',
        'REFERENCE_NOT_FOUND',
        'REFERENCE_MISMATCH',
        'REFERENCE_INVALID_KIND',
        'REFERENCE_NOT_PROCESSED',
        'ALREADY_REVERSED',
        'AMOUNT_MISMATCH',
        'CURRENCY_MISMATCH',
        'WALLET_PLAYER_MISMATCH',
        'INFRA_PERMANENT_ERROR',
      ].sort(),
    );
  });

  test('todo código tem orientação para o provedor', () => {
    for (const code of Object.values(FailureCode)) {
      expect(FAILURE_CODE_GUIDANCE[code]).toBeDefined();
    }
  });

  test('INFRA_PERMANENT_ERROR não é código de negócio', () => {
    expect(isBusinessFailureCode(FailureCode.InfraPermanentError)).toBe(false);
    expect(BUSINESS_FAILURE_CODES).not.toContain(FailureCode.InfraPermanentError);
    expect(isBusinessFailureCode(FailureCode.InsufficientFunds)).toBe(true);
  });
});
