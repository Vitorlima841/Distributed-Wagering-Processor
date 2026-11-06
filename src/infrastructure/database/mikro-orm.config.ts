import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migration20261106000000Init } from '../../../migrations/Migration20261106000000_init';
import { Migration20261106120000WageringSchema } from '../../../migrations/Migration20261106120000_wagering_schema';
import { ENTITY_SCHEMAS } from './entity-schemas';

/** Todas as migrations entram aqui, explicitamente (evita glob de arquivos sob Bun). */
export const migrationsList = [
  { name: 'Migration20261106000000_init', class: Migration20261106000000Init },
  { name: 'Migration20261106120000_wagering_schema', class: Migration20261106120000WageringSchema },
];

export function buildOrmConfig(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    // Records de persistência; o DDL vem das migrations (não usamos o schema generator).
    entities: ENTITY_SCHEMAS,
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
