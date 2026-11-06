import type { ClassifiedError } from '../../application';

/**
 * O que fazer com uma mensagem depois de tentar processá-la (ARCHITECTURE §9 e §18):
 *  - ack: o resultado está confirmado no banco (inclusive REJECTED, PENDING_REFERENCE e replay);
 *  - retry: nada foi confirmado e repetir pode dar certo; a mensagem volta depois do backoff e o
 *    redrive do SQS (`maxReceiveCount`) limita as tentativas;
 *  - dead-letter: repetir não muda o resultado; vai para a DLQ na hora, sem gastar tentativas.
 */
export type ConsumerDecision =
  | { action: 'ack' }
  | { action: 'retry'; delaySeconds: number; kind: string; code: string }
  | { action: 'dead-letter'; kind: string; code: string };

export interface RetryPolicy {
  baseDelayS: number;
  maxDelayS: number;
}

/**
 * Backoff exponencial pela contagem de recebimentos do próprio SQS (`ApproximateReceiveCount`),
 * então vale para qualquer instância e sobrevive a reinícios: min(base × 2^(n−1), máximo).
 */
export function retryDelaySeconds(receiveCount: number, policy: RetryPolicy): number {
  const exponent = Math.min(Math.max(receiveCount, 1) - 1, 30);
  return Math.min(policy.baseDelayS * 2 ** exponent, policy.maxDelayS);
}

/** Códigos de conflito que uma nova tentativa resolve (vira replay ou conflito definitivo). */
const RETRYABLE_CONFLICTS: ReadonlySet<string> = new Set(['CONCURRENT_CONFLICT']);

/**
 * Decisão para um erro lançado pelo processamento (a transação fez rollback; nada foi gravado):
 *  - validation (envelope, dinheiro, UUID, kind…), conflict (IDEMPOTENCY_CONFLICT,
 *    EXTERNAL_TRANSACTION_CONFLICT, INBOX_MESSAGE_CONFLICT) e not_found (WALLET_NOT_FOUND):
 *    permanentes → DLQ;
 *  - business: o resultado de negócio é terminal → ack (o caminho normal devolve REJECTED, não
 *    lança; isto é só a regra do desafio aplicada a um eventual erro de negócio lançado);
 *  - transient e conflito de corrida → retry com backoff;
 *  - invariant/unknown (bug, falha não mapeada) → retry: limitado pelo redrive, termina na DLQ.
 */
export function decideForError(
  error: ClassifiedError,
  receiveCount: number,
  policy: RetryPolicy,
): ConsumerDecision {
  const retry = (): ConsumerDecision => ({
    action: 'retry',
    delaySeconds: retryDelaySeconds(receiveCount, policy),
    kind: error.kind,
    code: error.code,
  });
  switch (error.kind) {
    case 'business':
      return { action: 'ack' };
    case 'validation':
    case 'not_found':
      return { action: 'dead-letter', kind: error.kind, code: error.code };
    case 'conflict':
      return RETRYABLE_CONFLICTS.has(error.code)
        ? retry()
        : { action: 'dead-letter', kind: error.kind, code: error.code };
    case 'transient':
    case 'invariant':
    case 'unknown':
      return retry();
  }
}
