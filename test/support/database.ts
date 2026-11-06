import { expect } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { defineConfig, type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';

/**
 * Helpers de integração contra o Postgres real do docker compose.
 * Os testes usam o banco `wagering_test` (DATABASE_URL do test/setup.ts), criado e migrado sob
 * demanda. O ledger é append-only: em vez de limpar tabelas, cada teste usa ids novos.
 */

export const testDatabaseUrl = (): string => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL não definida (test/setup.ts define o default)');
  }
  return url;
};

const withDatabase = (url: string, database: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

const databaseName = (url: string): string => {
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Nome de banco inesperado: "${name}"`);
  }
  return name;
};

/** Conexão ao banco de manutenção `postgres`, para criar/apagar bancos. */
async function withAdmin<T>(url: string, fn: (em: EntityManager) => Promise<T>): Promise<T> {
  const admin = await MikroORM.init(
    defineConfig({
      clientUrl: withDatabase(url, 'postgres'),
      entities: [],
      discovery: { warnWhenNoEntities: false },
    }),
  );
  try {
    return await fn(admin.em.fork());
  } finally {
    await admin.close(true);
  }
}

export async function createDatabaseIfMissing(url: string): Promise<void> {
  const name = databaseName(url);
  await withAdmin(url, async (em) => {
    const rows = await em.execute('select 1 from pg_database where datname = ?', [name]);
    if (rows.length > 0) {
      return;
    }
    try {
      await em.execute(`create database "${name}"`);
    } catch (error) {
      // outro arquivo de teste criou ao mesmo tempo
      if ((error as { code?: string }).code !== '42P04') {
        throw error;
      }
    }
  });
}

let testDatabaseReady: Promise<void> | undefined;

/** Garante que `wagering_test` existe e está com todas as migrations aplicadas (uma vez por processo). */
export function ensureTestDatabase(): Promise<void> {
  testDatabaseReady ??= (async () => {
    const url = testDatabaseUrl();
    await createDatabaseIfMissing(url);
    const orm = await MikroORM.init(buildOrmConfig(url));
    try {
      await orm.migrator.up();
    } finally {
      await orm.close(true);
    }
  })();
  return testDatabaseReady;
}

export async function createTestOrm(): Promise<MikroORM> {
  await ensureTestDatabase();
  return MikroORM.init(buildOrmConfig(testDatabaseUrl()));
}

/** Banco vazio e descartável (teste de migrations não mexe no banco compartilhado). */
export async function createThrowawayDatabase(): Promise<{
  url: string;
  drop: () => Promise<void>;
}> {
  const name = `wagering_tmp_${randomBytes(6).toString('hex')}`;
  const url = withDatabase(testDatabaseUrl(), name);
  await createDatabaseIfMissing(url);
  return {
    url,
    drop: async () => {
      await withAdmin(url, (em) => em.execute(`drop database if exists "${name}" with (force)`));
    },
  };
}

/** Executa `fn` numa transação própria; FKs e triggers diferidos são checados no COMMIT. */
export function inTransaction<T>(orm: MikroORM, fn: (em: EntityManager) => Promise<T>): Promise<T> {
  return orm.em.fork().transactional(fn);
}

/** Executa um comando SQL numa transação própria. */
export function exec(orm: MikroORM, sql: string, params: unknown[] = []): Promise<unknown> {
  return inTransaction(orm, (em) => em.execute(sql, params));
}

export async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('Era esperado um erro, mas a operação passou');
}

/** Afirma que o banco barrou a operação com a constraint (ou trigger) e o SQLSTATE esperados. */
export async function expectViolation(
  fn: () => Promise<unknown>,
  expected: { constraint: string; code: string },
): Promise<void> {
  const error = (await catchError(fn)) as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };
  expect({ code: error.code, constraint: error.constraint }).toEqual(expected);
}

export const SQLSTATE = {
  check: '23514',
  unique: '23505',
  foreignKey: '23503',
  /** Triggers de guarda e de consistência. */
  trigger: '23000',
} as const;

/**
 * Invariante final de todo teste de integração: saldo materializado == saldo reconstruído pelo
 * ledger. Compara strings vindas do Postgres (sem number).
 */
export async function expectBalanceMatchesLedger(
  orm: MikroORM,
  walletIds: Iterable<string>,
): Promise<void> {
  const ids = [...walletIds];
  if (ids.length === 0) {
    return;
  }
  const rows = await orm.em
    .fork()
    .execute<{ id: string; balance: string; reconstructed: string }[]>(
      `select w.id, w.balance::text as balance,
            coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text
              as reconstructed
       from wallets w
       left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = any(string_to_array(?, ',')::uuid[])
      group by w.id, w.balance`,
      [ids.join(',')],
    );
  expect(rows).toHaveLength(ids.length);
  for (const row of rows) {
    expect({ id: row.id, balance: row.reconstructed }).toEqual({
      id: row.id,
      balance: row.balance,
    });
  }
}
