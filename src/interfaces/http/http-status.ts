import type { ErrorKind, WagerTransactionOutcome } from '../../application';
import { WagerTransactionStatus } from '../../domain';

/**
 * Mapeamento HTTP único da API (ARCHITECTURE §8). Cada situação que o provedor precisa
 * distinguir para decidir se reenvia tem um status próprio.
 */
export const HTTP_STATUS_BY_ERROR_KIND: Readonly<Record<ErrorKind, number>> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  business: 422,
  transient: 503,
  invariant: 500,
  unknown: 500,
};

/** Segundos sugeridos no `Retry-After` de uma falha transitória. */
export const TRANSIENT_RETRY_AFTER_SECONDS = 1;

/** Status do resultado de uma transação submetida (sucesso, pendência ou rejeição persistida). */
export function httpStatusForOutcome(outcome: WagerTransactionOutcome): number {
  switch (outcome.status) {
    case WagerTransactionStatus.Processed:
      return outcome.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
    case WagerTransactionStatus.Pending:
      // FAILED é erro permanente de infraestrutura; PENDING nunca é persistido.
      return 500;
  }
}
