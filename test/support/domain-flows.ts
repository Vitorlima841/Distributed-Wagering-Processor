import { randomUUID } from 'node:crypto';
import type { UnitOfWork } from '../../src/application/ports';
import {
  Money,
  WagerPolicy,
  type WagerProcessingResult,
  WagerTransaction,
  type WagerTransactionKind,
  Wallet,
} from '../../src/domain';

/**
 * Fluxos de domínio sobre a UnitOfWork real, no formato que o use case da fase 4 vai seguir
 * (lock da wallet → regra no domínio → grava tudo na mesma transação). Servem para provar que
 * domínio, mappers, repositórios e triggers do banco concordam.
 */

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export interface OpenedWallet {
  walletId: string;
  playerId: string;
  openingTransactionId: string;
}

export async function openWalletViaDomain(
  uow: UnitOfWork,
  initial: string,
  { playerId = randomUUID(), now = new Date() }: { playerId?: string; now?: Date } = {},
): Promise<OpenedWallet> {
  const walletId = randomUUID();
  const openingTransactionId = randomUUID();
  const initialBalance = brl(initial);
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId,
    initialBalance,
    openingTransactionId,
    openingEntryId: randomUUID(),
    now,
  });
  await uow.run(async (scope) => {
    await scope.wallets.add(wallet);
    if (openingEntry) {
      const opening = WagerTransaction.opening({
        id: openingTransactionId,
        walletId,
        playerId,
        money: initialBalance,
        now,
      });
      opening.markProcessed(undefined, wallet.balance, now);
      await scope.transactions.add(opening);
      await scope.ledger.append(openingEntry);
    }
  });
  return { walletId, playerId, openingTransactionId };
}

export interface WagerInput {
  kind: WagerTransactionKind;
  amount: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  providerId?: string;
  now?: Date;
}

export async function processWager(
  uow: UnitOfWork,
  target: OpenedWallet,
  input: WagerInput,
): Promise<{ transaction: WagerTransaction; result: WagerProcessingResult }> {
  const providerId = input.providerId ?? 'provider-a';
  const externalTransactionId = input.externalTransactionId ?? `ext-${randomUUID()}`;
  const now = input.now ?? new Date();
  return uow.run(async (scope) => {
    const wallet = await scope.wallets.findByIdForUpdate(target.walletId);
    if (!wallet) {
      throw new Error(`wallet ${target.walletId} não existe`);
    }
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId,
      externalTransactionId,
      idempotencyKey: `${providerId}:${externalTransactionId}`,
      playerId: target.playerId,
      walletId: target.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: input.kind,
      money: brl(input.amount),
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      now,
    });
    const reference = input.referenceExternalTransactionId
      ? await scope.transactions.findByProviderAndExternalId(
          providerId,
          input.referenceExternalTransactionId,
        )
      : undefined;
    const processedReversals = reference
      ? await scope.transactions.findProcessedReversalsOf(reference.id)
      : [];
    const result = WagerPolicy.apply({
      wallet,
      transaction,
      reference,
      processedReversals,
      entryId: randomUUID(),
      now,
    });
    await scope.transactions.add(transaction);
    if (result.outcome === 'PROCESSED' && result.ledgerEntry) {
      await scope.wallets.save(wallet);
      await scope.ledger.append(result.ledgerEntry);
    }
    return { transaction, result };
  });
}

/** Reprocessa uma PENDING_REFERENCE como o worker da fase 7: wallet travada antes da transação. */
export async function retryPendingReference(
  uow: UnitOfWork,
  target: OpenedWallet,
  transactionId: string,
  now = new Date(),
): Promise<WagerProcessingResult> {
  return uow.run(async (scope) => {
    const wallet = await scope.wallets.findByIdForUpdate(target.walletId);
    const transaction = await scope.transactions.findByIdForUpdate(transactionId);
    if (!wallet || !transaction?.referenceExternalTransactionId) {
      throw new Error('estado inesperado para o reprocessamento');
    }
    const reference = await scope.transactions.findByProviderAndExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId,
    );
    const processedReversals = reference
      ? await scope.transactions.findProcessedReversalsOf(reference.id)
      : [];
    const result = WagerPolicy.apply({
      wallet,
      transaction,
      reference,
      processedReversals,
      entryId: randomUUID(),
      now,
    });
    await scope.transactions.save(transaction);
    if (result.outcome === 'PROCESSED' && result.ledgerEntry) {
      await scope.wallets.save(wallet);
      await scope.ledger.append(result.ledgerEntry);
    }
    return result;
  });
}
