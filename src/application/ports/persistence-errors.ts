/**
 * Erros que a persistência devolve ao use case, sem vazar tipos do ORM ou do driver.
 * A borda (HTTP, consumer SQS) classifica por `category`, como nos erros de domínio.
 */
export abstract class PersistenceError extends Error {
  abstract readonly category: 'conflict' | 'transient' | 'invariant';

  protected constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
  }
}

/** Nomes das constraints únicas que o use case precisa distinguir. */
export const UniqueConstraint = {
  WalletPlayerCurrency: 'ux_wallets_player_currency',
  IdempotencyKey: 'ux_wager_tx_idempotency_key',
  ProviderExternalId: 'ux_wager_tx_provider_external',
  ReversalOnce: 'ux_wager_tx_reversal_once',
  LedgerTransaction: 'ux_ledger_transaction',
  LedgerWalletVersion: 'ux_ledger_wallet_version',
  InboxMessage: 'pk_inbox_messages',
} as const;

/**
 * Violação de unicidade. Não é necessariamente bug: numa corrida, quem perde faz rollback,
 * relê e responde replay ou conflito (ARCHITECTURE §5).
 */
export class UniqueViolationError extends PersistenceError {
  readonly category = 'conflict';

  constructor(
    readonly constraint: string,
    cause?: unknown,
  ) {
    super(`Violação de unicidade: ${constraint}`, cause);
  }
}

export type TransientReason = 'deadlock' | 'serialization' | 'lock_timeout' | 'connection';

/** Falha passageira (lock, deadlock, conexão): a operação inteira pode ser repetida. */
export class TransientPersistenceError extends PersistenceError {
  readonly category = 'transient';

  constructor(
    readonly reason: TransientReason,
    cause?: unknown,
  ) {
    super(`Falha transitória de persistência: ${reason}`, cause);
  }
}

/**
 * O banco barrou um dado que o código deveria ter impedido (CHECK, FK, trigger de guarda ou
 * de consistência). É erro de programação: nada foi gravado.
 */
export class IntegrityViolationError extends PersistenceError {
  readonly category = 'invariant';

  constructor(
    readonly constraint: string | undefined,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/** Uso incorreto de um repositório (por exemplo, salvar wallet sem lock). Erro de programação. */
export class RepositoryMisuseError extends PersistenceError {
  readonly category = 'invariant';

  constructor(message: string) {
    super(message);
  }
}
