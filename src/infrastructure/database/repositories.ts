import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  type InboxRepository,
  type LedgerPageQuery,
  type LedgerRepository,
  type OutboxRepository,
  type PendingReferenceCandidate,
  RepositoryMisuseError,
  type WagerTransactionRepository,
  type WalletRepository,
} from '../../application/ports';
import {
  type InboxMessage,
  type OutboxMessage,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type Wallet,
  type WalletLedgerEntry,
} from '../../domain';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './entity-schemas';
import {
  InboxMessageMapper,
  LedgerEntryMapper,
  OutboxMessageMapper,
  WagerTransactionMapper,
  WalletMapper,
} from './mappers';

/**
 * Repositórios MikroORM. Cada instância vive numa única UnitOfWork (um `EntityManager` de
 * transação): os records lidos ou criados ficam guardados aqui para que `save` altere o record
 * gerenciado, e o MikroORM grava a diferença no commit.
 *
 * Leituras com lock usam `refresh: true`: se o record já estava no identity map, os valores
 * travados (os mais recentes) substituem os antigos.
 */

const FOR_UPDATE = { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true } as const;

/** Candidatos do worker, pelo índice parcial `ix_wager_tx_pending_reference_due`. Sem lock. */
const DUE_PENDING_REFERENCES_SQL = /* sql */ `
select id::text as "transactionId", wallet_id::text as "walletId"
  from wager_transactions
 where status = 'PENDING_REFERENCE' and next_attempt_at <= ?
 order by next_attempt_at, id
 limit ?`;

export class MikroOrmWalletRepository implements WalletRepository {
  private readonly records = new Map<string, WalletRecord>();
  /** Wallets travadas (ou criadas) nesta transação: só elas podem ser salvas. */
  private readonly writable = new Set<string>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    return this.track(await this.em.findOne(WalletRecord, { id }));
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const wallet = this.track(await this.em.findOne(WalletRecord, { id }, FOR_UPDATE));
    if (wallet) {
      this.writable.add(id);
    }
    return wallet;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    return this.track(await this.em.findOne(WalletRecord, { playerId, currency }));
  }

  async add(wallet: Wallet): Promise<void> {
    const record = this.em.create(WalletRecord, WalletMapper.toRecord(wallet));
    this.em.persist(record);
    this.records.set(wallet.id, record);
    this.writable.add(wallet.id);
  }

  async save(wallet: Wallet): Promise<void> {
    const record = this.records.get(wallet.id);
    if (!record || !this.writable.has(wallet.id)) {
      // read → calculate → update sem lock é proibido (restrição 7)
      throw new RepositoryMisuseError(
        `Wallet ${wallet.id} precisa ser carregada com findByIdForUpdate nesta UnitOfWork antes de save`,
      );
    }
    Object.assign(record, WalletMapper.mutable(wallet));
  }

  private track(record: WalletRecord | null): Wallet | undefined {
    if (!record) {
      return undefined;
    }
    this.records.set(record.id, record);
    return WalletMapper.toDomain(record);
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly records = new Map<string, WagerTransactionRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { id }));
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { id }, FOR_UPDATE));
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { idempotencyKey }));
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]> {
    return this.em.execute<PendingReferenceCandidate[]>(DUE_PENDING_REFERENCES_SQL, [now, limit]);
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.track(
      await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }),
    );
  }

  async findProcessedReversalsOf(referenceTransactionId: string): Promise<WagerTransaction[]> {
    const records = await this.em.find(WagerTransactionRecord, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return records.map((record) => this.track(record) as WagerTransaction);
  }

  async add(transaction: WagerTransaction): Promise<void> {
    const record = this.em.create(
      WagerTransactionRecord,
      WagerTransactionMapper.toRecord(transaction),
    );
    this.em.persist(record);
    this.records.set(transaction.id, record);
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const record = this.records.get(transaction.id);
    if (!record) {
      throw new RepositoryMisuseError(
        `Transação ${transaction.id} precisa ser lida ou adicionada nesta UnitOfWork antes de save`,
      );
    }
    Object.assign(record, WagerTransactionMapper.mutable(transaction));
  }

  private track(record: WagerTransactionRecord | null): WagerTransaction | undefined {
    if (!record) {
      return undefined;
    }
    this.records.set(record.id, record);
    return WagerTransactionMapper.toDomain(record);
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(this.em.create(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry)));
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined> {
    const record = await this.em.findOne(LedgerEntryRecord, { transactionId });
    return record ? LedgerEntryMapper.toDomain(record) : undefined;
  }

  /** Usa o índice único `ux_ledger_wallet_version (wallet_id, wallet_version)`. */
  async listByWallet(walletId: string, page: LedgerPageQuery): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: page.afterWalletVersion } },
      { orderBy: { walletVersion: 'asc' }, limit: page.limit },
    );
    return records.map((record) => LedgerEntryMapper.toDomain(record));
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  private readonly records = new Map<string, InboxMessageRecord>();

  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageRecord, { consumerName, messageId });
    if (!record) {
      return undefined;
    }
    this.records.set(key(consumerName, messageId), record);
    return InboxMessageMapper.toDomain(record);
  }

  async add(message: InboxMessage): Promise<void> {
    const record = this.em.create(InboxMessageRecord, InboxMessageMapper.toRecord(message));
    this.em.persist(record);
    this.records.set(key(message.consumerName, message.messageId), record);
  }

  async save(message: InboxMessage): Promise<void> {
    const record = this.records.get(key(message.consumerName, message.messageId));
    if (!record) {
      throw new RepositoryMisuseError(
        `Mensagem ${message.messageId} precisa ser lida ou adicionada nesta UnitOfWork antes de save`,
      );
    }
    record.processedAt = message.processedAt ?? null;
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  private readonly records = new Map<string, OutboxMessageRecord>();

  constructor(private readonly em: EntityManager) {}

  async add(message: OutboxMessage): Promise<void> {
    this.em.persist(this.em.create(OutboxMessageRecord, OutboxMessageMapper.toRecord(message)));
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const record = await this.em.findOne(OutboxMessageRecord, { id });
    return record ? this.track(record) : undefined;
  }

  /** `FOR UPDATE SKIP LOCKED` pelo índice parcial `ix_outbox_due`, os mais atrasados primeiro. */
  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        orderBy: { nextAttemptAt: 'asc', id: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        refresh: true,
      },
    );
    return records.map((record) => this.track(record));
  }

  async save(message: OutboxMessage): Promise<void> {
    const record = this.records.get(message.id);
    if (!record) {
      throw new RepositoryMisuseError(
        `Mensagem de outbox ${message.id} precisa ser lida nesta UnitOfWork antes de save`,
      );
    }
    // só o estado de entrega muda; o envelope é imutável (tg_outbox_guard_update)
    record.attempts = message.attempts;
    record.publishedAt = message.publishedAt ?? null;
    if (message.nextAttemptAt !== undefined) {
      record.nextAttemptAt = message.nextAttemptAt;
    }
  }

  private track(record: OutboxMessageRecord): OutboxMessage {
    this.records.set(record.id, record);
    return OutboxMessageMapper.toDomain(record);
  }
}

const key = (consumerName: string, messageId: string): string =>
  JSON.stringify([consumerName, messageId]);
