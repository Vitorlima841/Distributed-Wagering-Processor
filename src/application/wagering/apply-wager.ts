import {
  type EventContext,
  type IntegrationEvent,
  OutboxMessage,
  WagerPolicy,
  type WagerProcessingResult,
  type WagerTransaction,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionStatus,
  type Wallet,
  WalletBalanceChanged,
} from '../../domain';
import type { IdGenerator, TransactionScope, WagerTransactionRepository } from '../ports';

export interface EventCorrelation {
  correlationId: string;
  causationId?: string | undefined;
}

export interface ApplyWagerInput {
  /** Wallet travada (`FOR UPDATE`) nesta mesma transação. */
  wallet: Wallet;
  /** PENDING (primeira vez) ou PENDING_REFERENCE (reprocessamento pelo worker). */
  transaction: WagerTransaction;
  /** true: a transação é nova (INSERT); false: já existe e foi travada depois da wallet (UPDATE). */
  isNew: boolean;
  now: Date;
  correlation: EventCorrelation;
  maxReferenceAttempts?: number;
}

/**
 * Núcleo do processamento, compartilhado pelo use case e pelo worker de PENDING_REFERENCE:
 * resolve a referência, aplica a regra no domínio e registra transação, saldo, ledger e outbox
 * no mesmo `TransactionScope` (uma transação SQL; tudo é confirmado junto ou nada é).
 *
 * Pressupõe a wallet já travada. A linha da referência não é travada: uma referência válida é da
 * mesma wallet, e toda mudança em transações de uma wallet exige o lock dessa wallet. O índice
 * `ux_wager_tx_reversal_once` é a rede de segurança contra reversão dupla.
 */
export async function applyWager(
  scope: TransactionScope,
  ids: IdGenerator,
  input: ApplyWagerInput,
): Promise<WagerProcessingResult> {
  const { wallet, transaction: tx, now } = input;
  const previousStatus = tx.status;
  const { reference, processedReversals } = await resolveReference(scope.transactions, tx);

  const result = WagerPolicy.apply({
    wallet,
    transaction: tx,
    reference,
    processedReversals,
    entryId: ids.newId(),
    now,
    maxReferenceAttempts: input.maxReferenceAttempts,
  });

  if (input.isNew) {
    await scope.transactions.add(tx);
  } else {
    await scope.transactions.save(tx);
  }
  if (result.outcome === 'PROCESSED' && result.ledgerEntry) {
    await scope.wallets.save(wallet);
    await scope.ledger.append(result.ledgerEntry);
  }

  const context = eventContextFactory(ids, now, input.correlation);
  await enqueueEvents(scope, eventsFor(result, previousStatus, wallet, tx, context));
  return result;
}

/**
 * Referência por `(providerId, referenceExternalTransactionId)` (regra 2) e as reversões já
 * PROCESSED dela. Auto-referência devolve a própria transação, e a policy rejeita na hora com
 * `REFERENCE_INVALID_KIND` (sem isso, ela esperaria por si mesma como PENDING_REFERENCE).
 */
async function resolveReference(
  repository: WagerTransactionRepository,
  tx: WagerTransaction,
): Promise<{ reference: WagerTransaction | undefined; processedReversals: WagerTransaction[] }> {
  const referenceExternalId = tx.referenceExternalTransactionId;
  if (!tx.requiresReference() || referenceExternalId === undefined) {
    return { reference: undefined, processedReversals: [] };
  }
  if (referenceExternalId === tx.externalTransactionId) {
    return { reference: tx, processedReversals: [] };
  }
  const reference = await repository.findByProviderAndExternalId(
    tx.providerId,
    referenceExternalId,
  );
  if (!reference) {
    return { reference: undefined, processedReversals: [] };
  }
  return { reference, processedReversals: await repository.findProcessedReversalsOf(reference.id) };
}

/**
 * Eventos de cada desfecho:
 *  - PROCESSED → WagerTransactionProcessed (+ WalletBalanceChanged quando há lançamento)
 *  - REJECTED → WagerTransactionRejected
 *  - PENDING_REFERENCE → WagerTransactionPendingReference, só na entrada no estado (um retry
 *    sem sucesso do worker não repete o evento)
 */
function eventsFor(
  result: WagerProcessingResult,
  previousStatus: WagerTransactionStatus,
  wallet: Wallet,
  tx: WagerTransaction,
  context: () => EventContext,
): IntegrationEvent<unknown>[] {
  switch (result.outcome) {
    case 'PROCESSED':
      return [
        WagerTransactionProcessed.from(tx, context()),
        ...(result.ledgerEntry
          ? [WalletBalanceChanged.from(wallet, result.ledgerEntry, context())]
          : []),
      ];
    case 'REJECTED':
      return [WagerTransactionRejected.from(tx, context())];
    case 'PENDING_REFERENCE':
      return previousStatus === WagerTransactionStatus.Pending
        ? [WagerTransactionPendingReference.from(tx, context())]
        : [];
  }
}

/** Cada evento ganha um `eventId` novo; correlação e instante são os da operação. */
export function eventContextFactory(
  ids: IdGenerator,
  now: Date,
  correlation: EventCorrelation,
): () => EventContext {
  return () => ({
    eventId: ids.newId(),
    correlationId: correlation.correlationId,
    ...(correlation.causationId === undefined ? {} : { causationId: correlation.causationId }),
    occurredAt: now,
  });
}

export async function enqueueEvents(
  scope: TransactionScope,
  events: readonly IntegrationEvent<unknown>[],
): Promise<void> {
  for (const event of events) {
    await scope.outbox.add(OutboxMessage.enqueue(event));
  }
}
