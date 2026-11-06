import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { parseConfig } from '../../src/infrastructure/config/app-config';
import { buildOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';

describe('Postgres real', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    const config = parseConfig(process.env);
    orm = await MikroORM.init(buildOrmConfig(config.databaseUrl));
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('conecta e executa SELECT 1', async () => {
    const rows = await orm.em.getConnection().execute<{ ok: number }[]>('select 1 as ok');
    expect(rows[0]?.ok).toBe(1);
  });

  test('migrations: up -> down -> up (reversível)', async () => {
    await orm.migrator.up();
    expect(await orm.migrator.getExecuted()).toHaveLength(1);

    await orm.migrator.down();
    expect(await orm.migrator.getExecuted()).toHaveLength(0);

    await orm.migrator.up();
    expect(await orm.migrator.getExecuted()).toHaveLength(1);
  });
});
