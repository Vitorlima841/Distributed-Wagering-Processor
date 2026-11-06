import type { MikroORM } from '@mikro-orm/postgresql';

/**
 * Leituras diretas no Postgres (SQL, sem passar pela aplicação) para os testes conferirem o que
 * foi de fato gravado. Valores monetários chegam como string (`numeric::text`).
 */

const query = <T>(orm: MikroORM, sql: string, params: unknown[] = []): Promise<T[]> =>
  orm.em.fork().execute<T[]>(sql, params);

export interface WalletState {
  balance: string;
  currency: string;
  version: number;
}

export async function walletState(orm: MikroORM, walletId: string): Promise<WalletState> {
  const [row] = await query<WalletState>(
    orm,
    'select balance::text as balance, currency, version from wallets where id = ?',
    [walletId],
  );
  if (!row) {
    throw new Error(`wallet ${walletId} não existe`);
  }
  return row;
}

export async function walletExistsForPlayer(orm: MikroORM, playerId: string): Promise<boolean> {
  const rows = await query(orm, 'select 1 from wallets where player_id = ?', [playerId]);
  return rows.length > 0;
}

export interface TransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  kind: string;
  amount: string;
  status: string;
  failureCode: string | null;
  balanceAfter: string | null;
  balanceAfterCurrency: string | null;
  referenceTransactionId: string | null;
  referenceAttempts: number;
  /** timestamptz cru (string), como o driver devolve em `execute`. */
  nextAttemptAt: string | null;
}

const TX_COLUMNS = `id, provider_id as "providerId", external_transaction_id as "externalTransactionId",
  idempotency_key as "idempotencyKey", kind, amount::text as amount, status,
  failure_code as "failureCode", balance_after::text as "balanceAfter",
  balance_after_currency as "balanceAfterCurrency",
  reference_transaction_id as "referenceTransactionId", reference_attempts as "referenceAttempts",
  next_attempt_at as "nextAttemptAt"`;

export async function transactionState(orm: MikroORM, id: string): Promise<TransactionState> {
  const [row] = await query<TransactionState>(
    orm,
    `select ${TX_COLUMNS} from wager_transactions where id = ?`,
    [id],
  );
  if (!row) {
    throw new Error(`transação ${id} não existe`);
  }
  return row;
}

export function transactionsOfWallet(orm: MikroORM, walletId: string): Promise<TransactionState[]> {
  return query<TransactionState>(
    orm,
    `select ${TX_COLUMNS} from wager_transactions where wallet_id = ? order by created_at, id`,
    [walletId],
  );
}

export function transactionsByKey(
  orm: MikroORM,
  idempotencyKey: string,
): Promise<TransactionState[]> {
  return query<TransactionState>(
    orm,
    `select ${TX_COLUMNS} from wager_transactions where idempotency_key = ?`,
    [idempotencyKey],
  );
}

export interface LedgerState {
  transactionId: string;
  direction: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
}

export function ledgerOf(orm: MikroORM, walletId: string): Promise<LedgerState[]> {
  return query<LedgerState>(
    orm,
    `select transaction_id as "transactionId", direction, amount::text as amount,
            balance_before::text as "balanceBefore", balance_after::text as "balanceAfter",
            wallet_version as "walletVersion"
       from wallet_ledger_entries where wallet_id = ? order by wallet_version`,
    [walletId],
  );
}

export interface OutboxState {
  eventType: string;
  aggregateId: string;
  // biome-ignore lint/suspicious/noExplicitAny: envelope JSON livre nas asserções
  payload: any;
  publishedAt: string | null;
}

/** Eventos da outbox ligados a uma transação (todos os 4 tipos carregam `data.transactionId`). */
export function outboxOfTransaction(orm: MikroORM, transactionId: string): Promise<OutboxState[]> {
  return query<OutboxState>(
    orm,
    `select event_type as "eventType", aggregate_id as "aggregateId", payload,
            published_at as "publishedAt"
       from outbox_messages where payload -> 'data' ->> 'transactionId' = ?
      order by event_type`,
    [transactionId],
  );
}

export async function outboxEventTypes(orm: MikroORM, transactionId: string): Promise<string[]> {
  return (await outboxOfTransaction(orm, transactionId)).map((row) => row.eventType);
}

export function outboxByCorrelation(orm: MikroORM, correlationId: string): Promise<OutboxState[]> {
  return query<OutboxState>(
    orm,
    `select event_type as "eventType", aggregate_id as "aggregateId", payload,
            published_at as "publishedAt"
       from outbox_messages where payload ->> 'correlationId' = ?`,
    [correlationId],
  );
}

export interface InboxState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  /** timestamptz cru (string), como o driver devolve em `execute`. */
  processedAt: string | null;
}

/** Linhas da inbox de um consumer (todas, ou só as dos messageIds informados). */
export function inboxOf(
  orm: MikroORM,
  consumerName: string,
  messageIds?: readonly string[],
): Promise<InboxState[]> {
  return query<InboxState>(
    orm,
    `select consumer_name as "consumerName", message_id as "messageId",
            payload_hash as "payloadHash", processed_at as "processedAt"
       from inbox_messages
      where consumer_name = ? ${messageIds ? "and message_id = any(string_to_array(?, ','))" : ''}
      order by received_at, message_id`,
    messageIds ? [consumerName, messageIds.join(',')] : [consumerName],
  );
}
