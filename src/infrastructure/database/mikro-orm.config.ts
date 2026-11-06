import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migration20261106000000Init } from '../../../migrations/Migration20261106000000_init';

/** Todas as migrations entram aqui, explicitamente (evita glob de arquivos sob Bun). */
export const migrationsList = [
  { name: 'Migration20261106000000_init', class: Migration20261106000000Init },
];

export function buildOrmConfig(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    // EntitySchemas são adicionados nas fases seguintes (fase 3).
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
