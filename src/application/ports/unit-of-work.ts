import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from './repositories';

/** Repositórios ligados a uma única transação SQL. */
export interface TransactionScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface UnitOfWork {
  /**
   * Executa `work` numa transação SQL (READ COMMITTED). Commit se `work` resolver, rollback se
   * lançar. Falhas do banco chegam como `PersistenceError` (unicidade, transitória ou integridade);
   * erros de domínio lançados por `work` passam intactos.
   */
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
