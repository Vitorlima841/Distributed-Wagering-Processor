import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { UNIT_OF_WORK } from '../../application/ports';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { buildOrmConfig } from './mikro-orm.config';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work';

@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => MikroORM.init(buildOrmConfig(config.databaseUrl)),
    },
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM, APP_CONFIG],
      useFactory: (orm: MikroORM, config: AppConfig) =>
        new MikroOrmUnitOfWork(orm, { lockTimeoutMs: config.dbLockTimeoutMs }),
    },
  ],
  exports: [MikroORM, UNIT_OF_WORK],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
