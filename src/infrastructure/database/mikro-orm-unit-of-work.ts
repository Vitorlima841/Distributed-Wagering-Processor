import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { TransactionScope, UnitOfWork } from '../../application/ports';
import { translatePersistenceError } from './persistence-error-translator';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './repositories';

export interface UnitOfWorkOptions {
  /** `SET LOCAL lock_timeout`: quanto uma transação espera por um lock antes de desistir. */
  lockTimeoutMs: number;
  /**
   * `SET LOCAL idle_in_transaction_session_timeout`: uma sessão parada no meio da transação (processo
   * congelado, partição de rede) é derrubada pelo Postgres, que desfaz a transação e solta os locks.
   */
  idleInTransactionTimeoutMs?: number;
}

/**
 * UnitOfWork sobre `em.transactional()`. Cada `run` usa um fork novo do EntityManager (identity
 * map vazio) e uma transação READ COMMITTED: depois do `FOR UPDATE` na wallet, cada comando lê o
 * último estado confirmado. Em REPEATABLE READ, o `FOR UPDATE` falharia com erro de serialização
 * sempre que outra instância tivesse alterado a wallet depois do início da transação.
 *
 * O flush (INSERTs/UPDATEs) acontece no fim do callback, antes do COMMIT; FKs e triggers diferidos
 * são checados no COMMIT. Qualquer falha vira rollback e um `PersistenceError`.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly lockTimeoutMs: number;
  private readonly idleInTransactionTimeoutMs: number | undefined;

  constructor(
    private readonly orm: MikroORM,
    options: UnitOfWorkOptions,
  ) {
    if (!Number.isInteger(options.lockTimeoutMs) || options.lockTimeoutMs <= 0) {
      throw new Error('lockTimeoutMs deve ser um inteiro positivo');
    }
    this.lockTimeoutMs = options.lockTimeoutMs;
    const idle = options.idleInTransactionTimeoutMs;
    if (idle !== undefined && (!Number.isInteger(idle) || idle <= 0)) {
      throw new Error('idleInTransactionTimeoutMs deve ser um inteiro positivo');
    }
    this.idleInTransactionTimeoutMs = idle;
  }

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          await em.execute(`set local lock_timeout = ${this.lockTimeoutMs}`);
          if (this.idleInTransactionTimeoutMs !== undefined) {
            await em.execute(
              `set local idle_in_transaction_session_timeout = ${this.idleInTransactionTimeoutMs}`,
            );
          }
          return work(createScope(em));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}

function createScope(em: EntityManager): TransactionScope {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
