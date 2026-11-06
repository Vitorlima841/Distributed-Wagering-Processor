import {
  FAILURE_CODE_GUIDANCE,
  type FailureCode,
  type MoneyProps,
  type ProviderAction,
  type WagerTransaction,
  type WagerTransactionStatus,
} from '../../domain';

/**
 * Resultado de `ProcessWagerTransaction`, independente de transporte (HTTP e SQS). Rejeição de
 * negócio é um resultado persistido (REJECTED), não uma exceção.
 */
export interface WagerTransactionOutcome {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo observado quando a transação foi resolvida (snapshot usado no replay). */
  balance?: MoneyProps;
  failureCode?: FailureCode;
  providerAction?: ProviderAction;
  idempotentReplay: boolean;
}

export function toOutcome(
  tx: WagerTransaction,
  idempotentReplay: boolean,
): WagerTransactionOutcome {
  const code = tx.failureCode;
  return {
    transactionId: tx.id,
    status: tx.status,
    ...(tx.balanceAfter ? { balance: tx.balanceAfter.toJSON() } : {}),
    ...(code ? { failureCode: code, providerAction: FAILURE_CODE_GUIDANCE[code] } : {}),
    idempotentReplay,
  };
}

/** Visão completa de uma transação para as consultas. Datas em ISO-8601. */
export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  providerAction?: ProviderAction;
  balanceAfter?: MoneyProps;
  referenceAttempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  processedAt?: string;
}

export function toTransactionView(tx: WagerTransaction): WagerTransactionView {
  const code = tx.failureCode;
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
    ...(tx.referenceTransactionId === undefined
      ? {}
      : { referenceTransactionId: tx.referenceTransactionId }),
    status: tx.status,
    ...(code ? { failureCode: code, providerAction: FAILURE_CODE_GUIDANCE[code] } : {}),
    ...(tx.balanceAfter ? { balanceAfter: tx.balanceAfter.toJSON() } : {}),
    referenceAttempts: tx.referenceAttempts,
    ...(tx.nextAttemptAt ? { nextAttemptAt: tx.nextAttemptAt.toISOString() } : {}),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
  };
}
