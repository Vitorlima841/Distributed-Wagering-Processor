/**
 * Categoria do erro. Permite que a borda (filtro HTTP, consumer SQS) classifique sem conhecer
 * cada classe:
 *  - validation: payload inválido (HTTP 400; no SQS, erro permanente → DLQ)
 *  - business:   regra de negócio violada (HTTP 422; no SQS, ack)
 *  - conflict:   conflito de idempotência/unicidade (HTTP 409)
 *  - invariant:  erro de programação ou estado impossível (HTTP 500; nunca é caminho de negócio)
 */
export type ErrorCategory = 'validation' | 'business' | 'conflict' | 'invariant';

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
  readonly category = 'validation';
  constructor(message: string) {
    super(message);
  }
}

export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';
  readonly category = 'validation';
  constructor(message: string) {
    super(message);
  }
}

export class InvalidFieldError extends DomainError {
  readonly code = 'INVALID_FIELD';
  readonly category = 'validation';
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Campo inválido "${field}": ${reason}`);
  }
}

export class InvalidTransactionKindError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_KIND';
  readonly category = 'validation';
  constructor(kind: string) {
    super(`Tipo de transação não permitido nesta entrada: ${kind}`);
  }
}

export class MissingReferenceError extends DomainError {
  readonly code = 'MISSING_REFERENCE';
  readonly category = 'validation';
  constructor(kind: string) {
    super(`${kind} exige referenceExternalTransactionId`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
  readonly category = 'business';
  constructor(requested: string, available: string) {
    super(`Saldo insuficiente: solicitado ${requested}, disponível ${available}`);
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly category = 'conflict';
  constructor(idempotencyKey: string) {
    super(`Idempotency-Key "${idempotencyKey}" já usada com payload diferente`);
  }
}

/**
 * O mesmo `(consumerName, messageId)` chegou com outro conteúdo: o produtor reutilizou o id de
 * uma mensagem. Não é reentrega (que traria o mesmo conteúdo) nem pode ser processada.
 */
export class InboxMessageConflictError extends DomainError {
  readonly code = 'INBOX_MESSAGE_CONFLICT';
  readonly category = 'conflict';
  constructor(consumerName: string, messageId: string) {
    super(`Mensagem "${messageId}" já recebida por ${consumerName} com outro conteúdo`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  readonly category = 'invariant';
  constructor(expected: string, actual: string) {
    super(`Moedas diferentes: ${expected} vs ${actual}`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  readonly category = 'invariant';
  constructor(status: string, attempted: string) {
    super(`Transição "${attempted}" inválida a partir do estado ${status}`);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';
  readonly category = 'invariant';
  constructor(message: string) {
    super(message);
  }
}

export class InvalidFailureCodeError extends DomainError {
  readonly code = 'INVALID_FAILURE_CODE';
  readonly category = 'invariant';
  constructor(message: string) {
    super(message);
  }
}

export class InvalidMessageStateError extends DomainError {
  readonly code = 'INVALID_MESSAGE_STATE';
  readonly category = 'invariant';
  constructor(message: string) {
    super(message);
  }
}
