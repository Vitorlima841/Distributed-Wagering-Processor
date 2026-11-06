import { describe, expect, test } from 'bun:test';
import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import {
  type ErrorKind,
  TransientPersistenceError,
  type WagerTransactionOutcome,
  WalletNotFoundError,
} from '../../../src/application';
import {
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidMoneyError,
  WagerTransactionStatus as Status,
} from '../../../src/domain';
import { toHttpError } from '../../../src/interfaces/http/http-error.filter';
import { httpStatusForOutcome } from '../../../src/interfaces/http/http-status';

const outcome = (status: Status, idempotentReplay = false): WagerTransactionOutcome => ({
  transactionId: 't',
  status,
  idempotentReplay,
});

describe('mapeamento HTTP', () => {
  test('resultado da transação: 201 / 200 (replay) / 202 / 422', () => {
    expect(httpStatusForOutcome(outcome(Status.Processed))).toBe(201);
    expect(httpStatusForOutcome(outcome(Status.Processed, true))).toBe(200);
    expect(httpStatusForOutcome(outcome(Status.PendingReference))).toBe(202);
    expect(httpStatusForOutcome(outcome(Status.PendingReference, true))).toBe(202);
    expect(httpStatusForOutcome(outcome(Status.Rejected))).toBe(422);
    expect(httpStatusForOutcome(outcome(Status.Rejected, true))).toBe(422);
    expect(httpStatusForOutcome(outcome(Status.Failed))).toBe(500);
  });

  test.each([
    [new InvalidMoneyError('x'), 400, 'validation'],
    [new WalletNotFoundError('w'), 404, 'not_found'],
    [new IdempotencyConflictError('k'), 409, 'conflict'],
    [new InsufficientFundsError('1', '0'), 422, 'business'],
    [new TransientPersistenceError('lock_timeout'), 503, 'transient'],
    [new Error('boom'), 500, 'unknown'],
  ] as [Error, number, ErrorKind][])('erro %p → %i', (error, status, kind) => {
    const http = toHttpError(error);
    expect(http.status).toBe(status);
    expect(http.classified.kind).toBe(kind);
  });

  test('exceções do próprio HTTP (rota, JSON, tamanho) usam o mesmo envelope', () => {
    expect(toHttpError(new NotFoundException('Cannot GET /x'))).toMatchObject({
      status: 404,
      classified: { code: 'ROUTE_NOT_FOUND', kind: 'not_found' },
    });
    expect(toHttpError(new BadRequestException('JSON Parse error'))).toMatchObject({
      status: 400,
      classified: { code: 'INVALID_REQUEST', kind: 'validation' },
    });
    expect(toHttpError(new PayloadTooLargeException())).toMatchObject({
      status: 413,
      classified: { code: 'PAYLOAD_TOO_LARGE', kind: 'validation' },
    });
  });
});
