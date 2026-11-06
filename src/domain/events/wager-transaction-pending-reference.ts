import { InvalidTransactionStateError } from '../errors';
import type { MoneyProps } from '../money/money';
import { type WagerTransaction, WagerTransactionStatus } from '../wager/wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string;
  nextAttemptAt: string; // ISO-8601
}

/** Referência ausente: a transação aguarda reprocessamento. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const reference = tx.referenceExternalTransactionId;
    const next = tx.nextAttemptAt;
    if (
      tx.status !== WagerTransactionStatus.PendingReference ||
      reference === undefined ||
      next === undefined
    ) {
      throw new InvalidTransactionStateError(tx.status, 'WagerTransactionPendingReference.from');
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceExternalTransactionId: reference,
        nextAttemptAt: next.toISOString(),
      },
    });
  }
}
