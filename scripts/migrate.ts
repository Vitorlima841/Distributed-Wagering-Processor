import { MikroORM } from '@mikro-orm/postgresql';
import { parseConfig } from '../src/infrastructure/config/app-config';
import { buildOrmConfig } from '../src/infrastructure/database/mikro-orm.config';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('uso: bun scripts/migrate.ts <up|down>');
  process.exit(1);
}

const config = parseConfig(process.env);
const orm = await MikroORM.init(buildOrmConfig(config.databaseUrl));
try {
  const executed = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  console.log(
    `migration ${direction}: ${executed.map((m) => m.name).join(', ') || 'nada a fazer'}`,
  );
} finally {
  await orm.close(true);
}
