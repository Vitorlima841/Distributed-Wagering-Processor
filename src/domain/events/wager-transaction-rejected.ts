import { InvalidTransactionStateError } from '../errors';
import type { MoneyProps } from '../money/money';
import {
  FAILURE_CODE_GUIDANCE,
  type FailureCode,
  type ProviderAction,
} from '../wager/failure-code';
import { type WagerTransaction, WagerTransactionStatus } from '../wager/wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
  failureCode: FailureCode;
  /** O que o provedor deve fazer (reenviar corrigido, desistir, investigar...). */
  providerAction: ProviderAction;
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const code = tx.failureCode;
    if (tx.status !== WagerTransactionStatus.Rejected || code === undefined) {
      throw new InvalidTransactionStateError(tx.status, 'WagerTransactionRejected.from');
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: code,
        providerAction: FAILURE_CODE_GUIDANCE[code],
      },
    });
  }
}
