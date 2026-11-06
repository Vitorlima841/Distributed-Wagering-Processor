import {
  FailureCode,
  InboxMessage,
  LedgerDirection,
  Money,
  OutboxMessage,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  Wallet,
  WalletLedgerEntry,
} from '../../domain';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './entity-schemas';

/**
 * Domínio ↔ record. A volta para o domínio é sempre por `rehydrate` (não revalida transições);
 * `Money` é montado com o valor (string de `numeric(20,2)`) e a coluna de moeda.
 */

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });

const optionalMoney = (amount: string | null, currency: string | null): Money | undefined => {
  if (amount === null && currency === null) {
    return undefined;
  }
  if (amount === null || currency === null) {
    throw new Error('Snapshot de saldo incompleto no banco (valor e moeda vêm juntos)');
  }
  return money(amount, currency);
};

/** O CHECK do banco garante o domínio do valor; isto só protege contra schema e código fora de sincronia. */
function enumValue<E extends Record<string, string>>(
  enumeration: E,
  value: string,
  column: string,
): E[keyof E] {
  if (!(Object.values(enumeration) as string[]).includes(value)) {
    throw new Error(`Valor desconhecido em ${column}: "${value}"`);
  }
  return value as E[keyof E];
}

export const WalletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency,
      balance: money(r.balance, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },

  toRecord(w: Wallet): WalletRecord {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balance: w.balance.toJSON().amount,
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },

  /** Campos que mudam depois da criação. */
  mutable(w: Wallet): Pick<WalletRecord, 'balance' | 'version' | 'updatedAt'> {
    return { balance: w.balance.toJSON().amount, version: w.version, updatedAt: w.updatedAt };
  },
};

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: enumValue(WagerTransactionKind, r.kind, 'wager_transactions.kind'),
      money: money(r.amount, r.currency),
      referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
      createdAt: r.createdAt,
      status: enumValue(WagerTransactionStatus, r.status, 'wager_transactions.status'),
      referenceTransactionId: r.referenceTransactionId ?? undefined,
      failureCode:
        r.failureCode === null
          ? undefined
          : enumValue(FailureCode, r.failureCode, 'wager_transactions.failure_code'),
      processedAt: r.processedAt ?? undefined,
      balanceAfter: optionalMoney(r.balanceAfter, r.balanceAfterCurrency),
      referenceAttempts: r.referenceAttempts,
      nextAttemptAt: r.nextAttemptAt ?? undefined,
    });
  },

  toRecord(t: WagerTransaction): WagerTransactionRecord {
    const amount = t.money.toJSON();
    return {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      idempotencyKey: t.idempotencyKey,
      payloadHash: t.payloadHash,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: amount.amount,
      currency: amount.currency,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      createdAt: t.createdAt,
      ...WagerTransactionMapper.mutable(t),
    };
  },

  /** Estado que muda depois da criação (status, snapshot, tentativas de referência). */
  mutable(
    t: WagerTransaction,
  ): Pick<
    WagerTransactionRecord,
    | 'status'
    | 'referenceTransactionId'
    | 'failureCode'
    | 'processedAt'
    | 'balanceAfter'
    | 'balanceAfterCurrency'
    | 'referenceAttempts'
    | 'nextAttemptAt'
  > {
    const snapshot = t.balanceAfter?.toJSON();
    return {
      status: t.status,
      referenceTransactionId: t.referenceTransactionId ?? null,
      failureCode: t.failureCode ?? null,
      processedAt: t.processedAt ?? null,
      balanceAfter: snapshot?.amount ?? null,
      balanceAfterCurrency: snapshot?.currency ?? null,
      referenceAttempts: t.referenceAttempts,
      nextAttemptAt: t.nextAttemptAt ?? null,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: enumValue(LedgerDirection, r.direction, 'wallet_ledger_entries.direction'),
      money: money(r.amount, r.currency),
      balanceBefore: money(r.balanceBefore, r.currency),
      balanceAfter: money(r.balanceAfter, r.currency),
      walletVersion: r.walletVersion,
      createdAt: r.createdAt,
    });
  },

  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.toJSON().amount,
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.toJSON().amount,
      balanceAfter: e.balanceAfter.toJSON().amount,
      walletVersion: e.walletVersion,
      createdAt: e.createdAt,
    };
  },
};

export const InboxMessageMapper = {
  toDomain(r: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: r.consumerName,
      messageId: r.messageId,
      payloadHash: r.payloadHash,
      receivedAt: r.receivedAt,
      processedAt: r.processedAt ?? undefined,
    });
  },

  toRecord(m: InboxMessage): InboxMessageRecord {
    return {
      consumerName: m.consumerName,
      messageId: m.messageId,
      payloadHash: m.payloadHash,
      receivedAt: m.receivedAt,
      processedAt: m.processedAt ?? null,
    };
  },
};

export const OutboxMessageMapper = {
  toDomain(r: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregateId,
      eventType: r.eventType,
      payload: r.payload,
      occurredAt: r.occurredAt,
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt,
      publishedAt: r.publishedAt ?? undefined,
    });
  },

  toRecord(m: OutboxMessage): OutboxMessageRecord {
    if (m.nextAttemptAt === undefined) {
      throw new Error(`Outbox ${m.id} sem nextAttemptAt (enqueue sempre define)`);
    }
    return {
      id: m.id,
      aggregateId: m.aggregateId,
      eventType: m.eventType,
      payload: { ...m.payload },
      occurredAt: m.occurredAt,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt,
      publishedAt: m.publishedAt ?? null,
    };
  },
};
