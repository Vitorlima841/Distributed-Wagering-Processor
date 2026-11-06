import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  type Clock,
  CreateWallet,
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
  type WagerTransactionOutcome,
} from '../../src/application';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system';

export interface FixtureWallet {
  walletId: string;
  playerId: string;
}

export interface FixtureWager {
  kind: string;
  amount: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  roundId?: string;
  correlationId?: string;
}

/**
 * Os use cases reais (`CreateWallet`, `ProcessWagerTransaction`) sobre um ORM qualquer (em geral
 * um banco isolado), sem subir HTTP: produzem transações, ledger e eventos como em produção.
 */
export function wageringFixture(orm: MikroORM, clock: Clock = new SystemClock()) {
  const uow = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 5_000 });
  const ids = new UuidV7Generator();
  const createWallet = new CreateWallet(uow, clock, ids);
  const processWager = new ProcessWagerTransaction(uow, clock, ids);

  return {
    uow,
    async openWallet(initial: string): Promise<FixtureWallet> {
      const playerId = randomUUID();
      const view = await createWallet.execute({
        playerId,
        initialBalance: { amount: initial, currency: 'BRL' },
        correlationId: `open-${randomUUID()}`,
      });
      return { walletId: view.id, playerId };
    },
    wager(
      wallet: FixtureWallet,
      input: FixtureWager,
    ): Promise<WagerTransactionOutcome & { externalTransactionId: string }> {
      const externalTransactionId = input.externalTransactionId ?? `ext-${randomUUID()}`;
      const command: ProcessWagerTransactionCommand = {
        idempotencyKey: `provider-a:${externalTransactionId}`,
        providerId: 'provider-a',
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: input.roundId ?? 'round-1',
        gameId: 'fortune-chimp',
        kind: input.kind,
        money: { amount: input.amount, currency: 'BRL' },
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        correlationId: input.correlationId ?? `corr-${randomUUID()}`,
      };
      return processWager
        .execute(command)
        .then((outcome) => ({ ...outcome, externalTransactionId }));
    },
  };
}

/** Linhas da outbox pendentes (o banco isolado só tem os eventos do próprio arquivo). */
export async function pendingOutboxCount(orm: MikroORM): Promise<number> {
  const [row] = await orm.em
    .fork()
    .execute<{ n: number }[]>(
      'select count(*)::int as n from outbox_messages where published_at is null',
    );
  return row?.n ?? 0;
}

export interface OutboxRow {
  id: string;
  eventType: string;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
  // biome-ignore lint/suspicious/noExplicitAny: envelope JSON livre nas asserções
  payload: any;
}

/** Linhas da outbox (todas, ou só as `ids` informadas), na ordem em que o publisher as pega. */
export async function outboxRows(orm: MikroORM, ids?: readonly string[]): Promise<OutboxRow[]> {
  const rows = await orm.em.fork().execute<
    (Omit<OutboxRow, 'nextAttemptAt' | 'publishedAt'> & {
      nextAttemptAt: string | Date;
      publishedAt: string | Date | null;
    })[]
  >(
    `select id::text as id, event_type as "eventType", attempts, next_attempt_at as "nextAttemptAt",
            published_at as "publishedAt", payload
       from outbox_messages
      where ?::text is null or id = any(string_to_array(?::text, ',')::uuid[])
      order by next_attempt_at, id`,
    [ids ? ids.join(',') : null, ids ? ids.join(',') : null],
  );
  return rows.map((row) => ({
    ...row,
    nextAttemptAt: new Date(row.nextAttemptAt),
    publishedAt: row.publishedAt === null ? null : new Date(row.publishedAt),
  }));
}

/** Ids das mensagens ainda não publicadas. */
export async function pendingOutboxIds(orm: MikroORM): Promise<string[]> {
  return (await outboxRows(orm)).filter((row) => row.publishedAt === null).map((row) => row.id);
}

/** Ids de todas as wallets do banco isolado (para a checagem final de consistência). */
export async function allWalletIds(orm: MikroORM): Promise<string[]> {
  const rows = await orm.em.fork().execute<{ id: string }[]>('select id::text as id from wallets');
  return rows.map((row) => row.id);
}
