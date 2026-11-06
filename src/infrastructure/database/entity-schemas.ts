import { BigIntType, EntitySchema, PrimaryKeyProp } from '@mikro-orm/core';
import { DecimalAmountType } from './types/decimal-amount.type';

/**
 * Records de persistência: classes planas, só com colunas. O domínio não é mapeado direto pelo
 * ORM; os mappers convertem record ↔ domínio usando `rehydrate`. Não há relações declaradas
 * (FKs são diferidas no banco, ver a migration), e o DDL vem das migrations, não destes schemas.
 *
 * Dinheiro: colunas `numeric(20,2)` usam `DecimalAmountType` (string, nunca number).
 */

const timestamptz = { type: 'datetime', columnType: 'timestamptz' } as const;
const money = { type: DecimalAmountType } as const;
const char3 = { type: 'string', columnType: 'char(3)' } as const;

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: char3,
    balance: money,
    version: { type: 'integer' },
    createdAt: timestamptz,
    updatedAt: timestamptz,
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  balanceAfter!: string | null;
  balanceAfterCurrency!: string | null;
  referenceAttempts!: number;
  nextAttemptAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
  correlationId!: string | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'text' },
    gameId: { type: 'text' },
    kind: { type: 'text' },
    amount: money,
    currency: char3,
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'text' },
    failureCode: { type: 'text', nullable: true },
    balanceAfter: { ...money, nullable: true },
    balanceAfterCurrency: { ...char3, nullable: true },
    referenceAttempts: { type: 'integer' },
    nextAttemptAt: { ...timestamptz, nullable: true },
    createdAt: timestamptz,
    processedAt: { ...timestamptz, nullable: true },
    correlationId: { type: 'text', nullable: true },
  },
});

export class LedgerEntryRecord {
  id!: string;
  /** Gerado pelo banco (identity); usado como cursor da paginação. */
  seq?: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    // `generated`: o MikroORM não envia a coluna no INSERT e lê o valor de volta
    seq: { type: new BigIntType('string'), generated: 'identity', nullable: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'text' },
    amount: money,
    currency: char3,
    balanceBefore: money,
    balanceAfter: money,
    walletVersion: { type: 'integer' },
    createdAt: timestamptz,
  },
});

export class InboxMessageRecord {
  [PrimaryKeyProp]?: ['consumerName', 'messageId'];
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    receivedAt: timestamptz,
    processedAt: { ...timestamptz, nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt!: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: timestamptz,
    attempts: { type: 'integer' },
    nextAttemptAt: timestamptz,
    publishedAt: { ...timestamptz, nullable: true },
  },
});

export const ENTITY_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
