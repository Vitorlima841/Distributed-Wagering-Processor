import { InvalidTransactionStateError } from '../errors';
import type { MoneyProps } from '../money/money';
import { type WagerTransaction, WagerTransactionStatus } from '../wager/wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
  /** Saldo observado ao aplicar a transação (inalterado para LOSS). */
  balanceAfter: MoneyProps;
  referenceTransactionId?: string;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (tx.status !== WagerTransactionStatus.Processed || tx.balanceAfter === undefined) {
      throw new InvalidTransactionStateError(tx.status, 'WagerTransactionProcessed.from');
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        balanceAfter: tx.balanceAfter.toJSON(),
        ...(tx.referenceTransactionId === undefined
          ? {}
          : { referenceTransactionId: tx.referenceTransactionId }),
      },
    });
  }
}
