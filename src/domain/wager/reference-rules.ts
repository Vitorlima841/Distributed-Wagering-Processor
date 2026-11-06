import { FailureCode } from './failure-code';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from './wager-transaction';

export type ReferenceDecision =
  | { outcome: 'APPLY'; reference: WagerTransaction | undefined }
  | { outcome: 'PENDING_REFERENCE' }
  | { outcome: 'REJECT'; code: FailureCode };

const REVERSAL_KINDS: readonly Kind[] = [Kind.Refund, Kind.Rollback];

/** Tipos de referência aceitos por cada tipo de reversão. */
const REVERSIBLE_KINDS: Readonly<Partial<Record<Kind, readonly Kind[]>>> = {
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
};

/**
 * Regras de referência de REFUND/ROLLBACK (função pura: não acessa repositório).
 * Quem chama resolve a referência por `(providerId, referenceExternalTransactionId)` e
 * as reversões já PROCESSED dela, e passa os dois aqui.
 *
 * Ordem de checagem (a primeira que falha decide):
 *  1. referência ausente → PENDING_REFERENCE
 *  2. auto-referência → REFERENCE_INVALID_KIND
 *  3. referência ainda não terminal → PENDING_REFERENCE
 *  4. referência REJECTED/FAILED → REFERENCE_NOT_PROCESSED
 *  5. tipo da referência inválido para esta reversão → REFERENCE_INVALID_KIND
 *  6. outro provedor, player, wallet, moeda ou rodada → REFERENCE_MISMATCH
 *  7. referência já revertida (por qualquer tipo de reversão) → ALREADY_REVERSED
 *  8. valor diferente do da referência → AMOUNT_MISMATCH
 */
export const ReferenceRules = {
  evaluate(
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    processedReversals: readonly WagerTransaction[],
  ): ReferenceDecision {
    // Kinds sem exigência de referência (a de WIN/LOSS é só informativa).
    if (!transaction.requiresReference()) {
      return { outcome: 'APPLY', reference: undefined };
    }
    if (reference === undefined) {
      return { outcome: 'PENDING_REFERENCE' };
    }
    if (reference.id === transaction.id) {
      return reject(FailureCode.ReferenceInvalidKind);
    }
    if (!reference.isTerminal()) {
      return { outcome: 'PENDING_REFERENCE' };
    }
    if (reference.status !== Status.Processed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }
    if (!REVERSIBLE_KINDS[transaction.kind]?.includes(reference.kind)) {
      return reject(FailureCode.ReferenceInvalidKind);
    }
    if (
      reference.providerId !== transaction.providerId ||
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.money.currency !== transaction.money.currency ||
      reference.roundId !== transaction.roundId
    ) {
      return reject(FailureCode.ReferenceMismatch);
    }
    // Uma referência é revertida no máximo uma vez, por REFUND ou ROLLBACK: aceitar
    // REFUND e depois ROLLBACK da mesma BET creditaria duas vezes.
    const alreadyReversed = processedReversals.some(
      (r) =>
        r.id !== transaction.id &&
        r.status === Status.Processed &&
        REVERSAL_KINDS.includes(r.kind) &&
        r.referenceTransactionId === reference.id,
    );
    if (alreadyReversed) {
      return reject(FailureCode.AlreadyReversed);
    }
    if (!transaction.money.equals(reference.money)) {
      return reject(FailureCode.AmountMismatch);
    }
    return { outcome: 'APPLY', reference };
  },
} as const;

function reject(code: FailureCode): ReferenceDecision {
  return { outcome: 'REJECT', code };
}
