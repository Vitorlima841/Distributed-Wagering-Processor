import { DomainError } from '../domain';
import { PersistenceError, TransientPersistenceError, UniqueViolationError } from './ports';

/**
 * Erros da camada de aplicação: situações que o domínio não enxerga (recurso inexistente,
 * unicidade entre agregados). Como os erros de domínio, carregam `code` estável e `category`.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly category: 'validation' | 'not_found' | 'conflict';

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
  readonly category = 'not_found';
  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} não encontrada`);
  }
}

export class WagerTransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
  readonly category = 'not_found';
  constructor(description: string) {
    super(`Transação não encontrada: ${description}`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  readonly category = 'conflict';
  constructor(
    readonly playerId: string,
    readonly currency: string,
    /** Id da wallet que já existe (permite ao cliente se recuperar de um retry). */
    readonly existingWalletId: string | undefined,
  ) {
    super(`Já existe wallet para o player ${playerId} na moeda ${currency}`);
  }
}

/**
 * Mesmo `(providerId, externalTransactionId)` chegou com outra `Idempotency-Key`. O header é a
 * fonte da verdade: outra key é outra requisição, e o id externo já foi usado. Não é replay.
 */
export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';
  readonly category = 'conflict';
  constructor(providerId: string, externalTransactionId: string) {
    super(
      `externalTransactionId "${externalTransactionId}" do provedor "${providerId}" já foi usado com outra Idempotency-Key`,
    );
  }
}

/** Erro de validação detectado fora do domínio (cursor, limite, payload de transporte). */
export class RequestValidationError extends ApplicationError {
  readonly category = 'validation';
  constructor(
    readonly code: string,
    message: string,
    readonly details?: readonly { path: string; message: string }[],
  ) {
    super(message);
  }
}

export type ErrorKind =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'business'
  | 'transient'
  | 'invariant'
  | 'unknown';

export interface ClassifiedError {
  kind: ErrorKind;
  code: string;
  /** Mensagem segura para o cliente (erros internos ganham mensagem genérica). */
  message: string;
  /** Repetir a mesma requisição pode dar certo. */
  retryable: boolean;
  details?: readonly { path: string; message: string }[];
  /** Dados extras para o cliente se recuperar (ex.: id da wallet que já existe). */
  context?: Readonly<Record<string, string>>;
}

const TRANSIENT_CODES = {
  lock_timeout: 'LOCK_TIMEOUT',
  deadlock: 'LOCK_CONFLICT',
  serialization: 'LOCK_CONFLICT',
  connection: 'DATABASE_UNAVAILABLE',
} as const;

const INTERNAL_MESSAGE = 'Erro interno inesperado';

/**
 * Classificação única de erros para todas as entradas: o filtro HTTP traduz `kind` em status, e o
 * consumer SQS (fase 6) em ack / retry / DLQ. Erros de programação nunca vazam detalhes.
 */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof DomainError) {
    if (error.category === 'invariant') {
      return internal();
    }
    return { kind: error.category, code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof ApplicationError) {
    return {
      kind: error.category,
      code: error.code,
      message: error.message,
      retryable: false,
      ...(error instanceof RequestValidationError && error.details
        ? { details: error.details }
        : {}),
      ...(error instanceof WalletAlreadyExistsError && error.existingWalletId
        ? { context: { walletId: error.existingWalletId } }
        : {}),
    };
  }
  if (error instanceof TransientPersistenceError) {
    return {
      kind: 'transient',
      code: TRANSIENT_CODES[error.reason],
      message: 'Falha transitória de infraestrutura; repita a requisição',
      retryable: true,
    };
  }
  if (error instanceof UniqueViolationError) {
    // Corrida que sobreviveu ao retry interno: o estado gravado é de outra requisição.
    return {
      kind: 'conflict',
      code: 'CONCURRENT_CONFLICT',
      message: 'Conflito com uma operação concorrente; consulte o estado antes de repetir',
      retryable: false,
    };
  }
  if (error instanceof PersistenceError) {
    return internal();
  }
  return { ...internal(), kind: 'unknown' };
}

function internal(): ClassifiedError {
  return { kind: 'invariant', code: 'INTERNAL_ERROR', message: INTERNAL_MESSAGE, retryable: false };
}
