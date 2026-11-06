import type {
  InboxMessage,
  OutboxMessage,
  WagerTransaction,
  Wallet,
  WalletLedgerEntry,
} from '../../domain';

/**
 * Repositórios só existem dentro de uma UnitOfWork (ver `unit-of-work.ts`): tudo o que eles
 * gravam vai para a mesma transação SQL e é confirmado junto, ou nada é.
 *
 * `add`/`save` registram a mudança; a escrita no banco acontece no commit da UnitOfWork.
 */

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /**
   * `SELECT … FOR UPDATE`: trava a linha até o fim da transação. É o ponto de serialização de
   * tudo o que mexe na wallet; sempre vem antes do lock de qualquer `wager_transactions`.
   */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): Promise<void>;
  /** Grava saldo, version e updatedAt. Exige que a wallet tenha sido travada nesta UnitOfWork. */
  save(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** Para o worker de PENDING_REFERENCE; chamar só depois de travar a wallet (ordem de lock). */
  findByIdForUpdate(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Reversões (REFUND/ROLLBACK) PROCESSED que apontam para a transação informada. */
  findProcessedReversalsOf(referenceTransactionId: string): Promise<WagerTransaction[]>;
  add(transaction: WagerTransaction): Promise<void>;
  /** Grava o estado mutável (status, snapshot, tentativas). Exige que a transação tenha sido lida ou adicionada nesta UnitOfWork. */
  save(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerPageQuery {
  /** Devolve só lançamentos com `walletVersion` maior que este (0 = desde o início). */
  afterWalletVersion: number;
  limit: number;
}

/** Ledger append-only: não há update nem delete. */
export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined>;
  /**
   * Lançamentos da wallet em ordem de `walletVersion` crescente (paginação por chave). A versão é
   * contígua por wallet e só cresce, então páginas não se repetem nem pulam lançamentos.
   */
  listByWallet(walletId: string, page: LedgerPageQuery): Promise<WalletLedgerEntry[]>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  add(message: InboxMessage): Promise<void>;
  save(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  findById(id: string): Promise<OutboxMessage | undefined>;
}
