import {
  InsufficientFundsError,
  InvalidFieldError,
  InvalidTransactionKindError,
  InvalidTransactionStateError,
} from '../errors';
import type { Wallet } from '../wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import { ReferenceRules } from './reference-rules';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from './wager-transaction';

/**
 * Reprocessamentos de PENDING_REFERENCE antes de REJECTED / REFERENCE_NOT_FOUND. Com o backoff de
 * 1s, 2s, 4s… (teto de 60s), a 10ª tentativa acontece cerca de 5 min depois da chegada
 * (justificativa em ARCHITECTURE §19).
 */
export const DEFAULT_MAX_REFERENCE_ATTEMPTS = 10;

export interface WagerPolicyContext {
  /** Wallet já carregada com lock (a serialização é da persistência). */
  wallet: Wallet;
  /** PENDING (primeira vez) ou PENDING_REFERENCE (reprocessamento). */
  transaction: WagerTransaction;
  /** Referência resolvida por (providerId, referenceExternalTransactionId), se existir. */
  reference: WagerTransaction | undefined;
  /** Reversões PROCESSED já ligadas a essa referência. */
  processedReversals: readonly WagerTransaction[];
  /** Id do lançamento, usado só se a transação mover saldo. */
  entryId: string;
  now: Date;
  maxReferenceAttempts?: number;
}

export type WagerProcessingResult =
  | { outcome: 'PROCESSED'; ledgerEntry?: WalletLedgerEntry }
  | { outcome: 'REJECTED'; failureCode: FailureCode }
  | { outcome: 'PENDING_REFERENCE' };

/**
 * Aplica uma transação a uma wallet (BET, WIN, LOSS, REFUND, ROLLBACK) e deixa a
 * transação no estado certo. Pura: não faz I/O; o use case persiste o resultado.
 * Rejeição de negócio vira estado REJECTED (auditável), nunca exceção.
 */
export const WagerPolicy = {
  apply(ctx: WagerPolicyContext): WagerProcessingResult {
    const { wallet, transaction: tx, now } = ctx;

    if (tx.kind === Kind.Opening) {
      throw new InvalidTransactionKindError(Kind.Opening);
    }
    if (tx.isTerminal()) {
      throw new InvalidTransactionStateError(tx.status, 'apply');
    }
    if (tx.walletId !== wallet.id) {
      throw new InvalidFieldError('walletId', 'a transação pertence a outra wallet');
    }
    if (tx.playerId !== wallet.playerId) {
      return rejected(ctx, FailureCode.WalletPlayerMismatch);
    }
    if (tx.money.currency !== wallet.currency) {
      return rejected(ctx, FailureCode.CurrencyMismatch);
    }

    const decision = ReferenceRules.evaluate(tx, ctx.reference, ctx.processedReversals);
    if (decision.outcome === 'REJECT') {
      return rejected(ctx, decision.code);
    }
    if (decision.outcome === 'PENDING_REFERENCE') {
      return waitForReference(ctx);
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(undefined, wallet.balance, now);
      return { outcome: 'PROCESSED' };
    }

    const movement = { money: tx.money, transactionId: tx.id, entryId: ctx.entryId, now };
    let ledgerEntry: WalletLedgerEntry;
    try {
      ledgerEntry =
        tx.ledgerDirectionFor(decision.reference) === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // Aposta sem saldo e reversão que deixaria saldo negativo são situações operacionais diferentes.
        return rejected(
          ctx,
          tx.kind === Kind.Rollback
            ? FailureCode.ReversalInsufficientFunds
            : FailureCode.InsufficientFunds,
        );
      }
      throw error;
    }
    tx.markProcessed(decision.reference?.id, wallet.balance, now);
    return { outcome: 'PROCESSED', ledgerEntry };
  },
} as const;

function rejected(ctx: WagerPolicyContext, code: FailureCode): WagerProcessingResult {
  ctx.transaction.reject(code, ctx.wallet.balance, ctx.now);
  return { outcome: 'REJECTED', failureCode: code };
}

function waitForReference(ctx: WagerPolicyContext): WagerProcessingResult {
  const { transaction: tx, wallet, now } = ctx;
  if (tx.status === Status.Pending) {
    tx.markPendingReference(wallet.balance, now);
    return { outcome: 'PENDING_REFERENCE' };
  }
  tx.scheduleReferenceRetry(now);
  if (
    tx.hasExhaustedReferenceAttempts(ctx.maxReferenceAttempts ?? DEFAULT_MAX_REFERENCE_ATTEMPTS)
  ) {
    return rejected(ctx, FailureCode.ReferenceNotFound);
  }
  return { outcome: 'PENDING_REFERENCE' };
}
