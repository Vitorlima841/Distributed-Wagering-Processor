import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migration20261106000000Init } from '../../../migrations/Migration20261106000000_init';
import { Migration20261106120000WageringSchema } from '../../../migrations/Migration20261106120000_wagering_schema';
import { Migration20261106180000OutboxAndPendingReference } from '../../../migrations/Migration20261106180000_outbox_and_pending_reference';
import { ENTITY_SCHEMAS } from './entity-schemas';

/** Todas as migrations entram aqui, explicitamente (evita glob de arquivos sob Bun). */
export const migrationsList = [
  { name: 'Migration20261106000000_init', class: Migration20261106000000Init },
  { name: 'Migration20261106120000_wagering_schema', class: Migration20261106120000WageringSchema },
  {
    name: 'Migration20261106180000_outbox_and_pending_reference',
    class: Migration20261106180000OutboxAndPendingReference,
  },
];

export interface OrmConnectionOptions {
  /** Máximo de conexões do pool (padrão do `pg`: 10). */
  poolMax?: number;
  /** `application_name` das conexões, visível no `pg_stat_activity`. */
  applicationName?: string;
}

export function buildOrmConfig(databaseUrl: string, options: OrmConnectionOptions = {}) {
  return defineConfig({
    clientUrl: databaseUrl,
    ...(options.poolMax === undefined ? {} : { pool: { max: options.poolMax } }),
    // repassado ao Pool do `pg` (o MikroORM ignora parâmetros de query na clientUrl)
    ...(options.applicationName === undefined
      ? {}
      : { driverOptions: { application_name: options.applicationName } }),
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
