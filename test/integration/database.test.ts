import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';

describe('Postgres real', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('conecta no banco de teste e executa SELECT 1', async () => {
    const rows = await orm.em.fork().execute<{ ok: number }[]>('select 1 as ok');
    expect(rows[0]?.ok).toBe(1);
  });

  test('todas as migrations estão aplicadas', async () => {
    expect(await orm.migrator.getPending()).toHaveLength(0);
  });
});
