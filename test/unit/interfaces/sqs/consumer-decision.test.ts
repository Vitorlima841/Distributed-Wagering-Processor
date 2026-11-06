import { describe, expect, test } from 'bun:test';
import {
  classifyError,
  ExternalTransactionConflictError,
  IntegrityViolationError,
  RequestValidationError,
  TransientPersistenceError,
  UniqueViolationError,
  WalletNotFoundError,
} from '../../../../src/application';
import {
  IdempotencyConflictError,
  InboxMessageConflictError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidTransactionStateError,
} from '../../../../src/domain';
import {
  decideForError,
  retryDelaySeconds,
} from '../../../../src/interfaces/sqs/consumer-decision';

const policy = { baseDelayS: 2, maxDelayS: 60 };

describe('retryDelaySeconds (backoff pela contagem de recebimentos do SQS)', () => {
  test('dobra a cada recebimento até o teto', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => retryDelaySeconds(n, policy))).toEqual([
      2, 4, 8, 16, 32, 60, 60,
    ]);
  });

  test('contagem inválida conta como primeira; contagem enorme não estoura', () => {
    expect(retryDelaySeconds(0, policy)).toBe(2);
    expect(retryDelaySeconds(10_000, policy)).toBe(60);
  });

  test('base 0 devolve na hora (útil só em teste)', () => {
    expect(retryDelaySeconds(3, { baseDelayS: 0, maxDelayS: 0 })).toBe(0);
  });
});

describe('decideForError (o que nada gravou no banco)', () => {
  const decide = (error: unknown, receiveCount = 1) =>
    decideForError(classifyError(error), receiveCount, policy);

  test.each([
    [new RequestValidationError('MALFORMED_MESSAGE', 'x'), 'validation', 'MALFORMED_MESSAGE'],
    [new InvalidMoneyError('x'), 'validation', 'INVALID_MONEY'],
    [new WalletNotFoundError('w'), 'not_found', 'WALLET_NOT_FOUND'],
    [new IdempotencyConflictError('k'), 'conflict', 'IDEMPOTENCY_CONFLICT'],
    [new ExternalTransactionConflictError('p', 'e'), 'conflict', 'EXTERNAL_TRANSACTION_CONFLICT'],
    [new InboxMessageConflictError('c', 'm'), 'conflict', 'INBOX_MESSAGE_CONFLICT'],
  ])('permanente %p → DLQ na hora', (error, kind, code) => {
    expect(decide(error)).toEqual({ action: 'dead-letter', kind, code });
  });

  test.each([
    [new TransientPersistenceError('lock_timeout'), 'transient', 'LOCK_TIMEOUT'],
    [new TransientPersistenceError('deadlock'), 'transient', 'LOCK_CONFLICT'],
    [new TransientPersistenceError('connection'), 'transient', 'DATABASE_UNAVAILABLE'],
    [new UniqueViolationError('ux_x'), 'conflict', 'CONCURRENT_CONFLICT'],
    [new IntegrityViolationError('ck_x', 'x'), 'invariant', 'INTERNAL_ERROR'],
    [new InvalidTransactionStateError('PROCESSED', 'reject'), 'invariant', 'INTERNAL_ERROR'],
    [new Error('boom'), 'unknown', 'INTERNAL_ERROR'],
  ])('%p → retry com backoff (limitado pelo redrive)', (error, kind, code) => {
    expect(decide(error, 3)).toEqual({ action: 'retry', delaySeconds: 8, kind, code });
  });

  test('erro de negócio lançado → ack (resultado terminal)', () => {
    expect(decide(new InsufficientFundsError('1.00', '0.00'))).toEqual({ action: 'ack' });
  });
});
