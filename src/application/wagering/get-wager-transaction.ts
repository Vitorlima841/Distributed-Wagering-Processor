import { WagerTransactionNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports';
import { normalizeUuid } from '../shared/identifiers';
import { toTransactionView, type WagerTransactionView } from './views';

/** Consultas de transação, por id interno ou por `(providerId, externalTransactionId)`. */
export class GetWagerTransaction {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    const id = normalizeUuid('transactionId', transactionId);
    const tx = await this.uow.run((scope) => scope.transactions.findById(id));
    if (!tx) {
      throw new WagerTransactionNotFoundError(`id ${id}`);
    }
    return toTransactionView(tx);
  }

  async byProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const tx = await this.uow.run((scope) =>
      scope.transactions.findByProviderAndExternalId(providerId, externalTransactionId),
    );
    if (!tx) {
      throw new WagerTransactionNotFoundError(
        `provedor ${providerId}, externalTransactionId ${externalTransactionId}`,
      );
    }
    return toTransactionView(tx);
  }
}
