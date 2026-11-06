import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';
import { createThrowawayDatabase } from '../support/database';

const TABLES = [
  'inbox_messages',
  'outbox_messages',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];

const TRIGGERS = [
  'tg_ledger_append_only',
  'tg_ledger_consistency',
  'tg_ledger_no_truncate',
  'tg_wager_tx_guard_update',
  'tg_wager_tx_has_entry',
  'tg_wager_tx_no_delete',
  'tg_wager_tx_no_truncate',
  'tg_wallet_matches_ledger',
  'tg_wallets_guard_update',
];

/** Roda num banco descartável: up/down não interfere nos dados dos outros testes. */
describe('migrations (banco descartável)', () => {
  let orm: MikroORM;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const db = await createThrowawayDatabase();
    drop = db.drop;
    orm = await MikroORM.init(buildOrmConfig(db.url));
  });

  afterAll(async () => {
    await orm.close(true);
    await drop();
  });

  const query = <T>(sql: string) => orm.em.fork().execute<T[]>(sql);

  const tables = async () =>
    (
      await query<{ name: string }>(
        `select table_name as name from information_schema.tables
          where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by 1`,
      )
    ).map((r) => r.name);

  const triggers = async () =>
    (
      await query<{ name: string }>(
        'select tgname as name from pg_trigger where not tgisinternal order by 1',
      )
    ).map((r) => r.name);

  const functions = async () =>
    (
      await query<{ name: string }>(
        `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' order by 1`,
      )
    ).map((r) => r.name);

  test('up cria tabelas, constraints, índices e triggers', async () => {
    await orm.migrator.up();
    expect(await orm.migrator.getPending()).toHaveLength(0);
    expect(await tables()).toEqual(TABLES);
    expect(await triggers()).toEqual(TRIGGERS);

    const constraints = (
      await query<{ name: string }>(
        `select conname as name from pg_constraint c join pg_namespace n on n.oid = c.connamespace
          where n.nspname = 'public'`,
      )
    ).map((r) => r.name);
    expect(constraints).toEqual(
      expect.arrayContaining([
        'ck_wallets_balance_non_negative',
        'ux_wallets_player_currency',
        'ux_wager_tx_idempotency_key',
        'ux_wager_tx_provider_external',
        'ck_ledger_arithmetic',
        'ux_ledger_transaction',
        'ux_ledger_wallet_version',
        'fk_ledger_wallet_currency',
        'fk_ledger_transaction_wallet',
        'fk_wager_tx_reference_same_wallet',
      ]),
    );

    const [reversalIndex] = await query<{ def: string }>(
      `select indexdef as def from pg_indexes where indexname = 'ux_wager_tx_reversal_once'`,
    );
    expect(reversalIndex?.def).toContain('CREATE UNIQUE INDEX');
    expect(reversalIndex?.def).toContain("WHERE ((status = 'PROCESSED'::text)");

    // FKs conferidas no COMMIT (o flush do MikroORM não garante a ordem entre tabelas)
    const deferred = await query<{ name: string; deferred: boolean }>(
      `select conname as name, condeferred as deferred from pg_constraint where contype = 'f' order by 1`,
    );
    expect(deferred).toEqual([
      { name: 'fk_ledger_transaction_wallet', deferred: true },
      { name: 'fk_ledger_wallet_currency', deferred: true },
      { name: 'fk_wager_tx_reference_same_wallet', deferred: true },
      { name: 'fk_wager_tx_wallet', deferred: true },
    ]);
  });

  test('down da última migration remove tudo o que ela criou', async () => {
    await orm.migrator.down();
    expect(await tables()).toEqual([]);
    expect(await triggers()).toEqual([]);
    expect(await functions()).not.toEqual(
      expect.arrayContaining(['forbid_mutation', 'wallets_guard_update']),
    );
    // a migration inicial continua aplicada
    expect((await orm.migrator.getExecuted()).map((m) => m.name)).toEqual([
      'Migration20261106000000_init',
    ]);
  });

  test('down até o início e up de novo (reversível nos dois sentidos)', async () => {
    await orm.migrator.down({ to: 0 });
    expect(await orm.migrator.getExecuted()).toHaveLength(0);
    expect(await functions()).toEqual([]);

    await orm.migrator.up();
    expect(await tables()).toEqual(TABLES);
    expect(await triggers()).toEqual(TRIGGERS);
  });
});
