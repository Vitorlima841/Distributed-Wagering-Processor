import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Module } from '@nestjs/common';
import {
  CLOCK,
  ID_GENERATOR,
  RECONCILIATION_MONITOR,
  RECONCILIATION_READER,
} from '../application/ports';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { MikroOrmReconciliationReader } from './database/reconciliation-reader';
import { createLogger, LOGGER, type Logger } from './logging/logger';
import { LoggingReconciliationMonitor } from './logging/reconciliation-monitor';
import { SystemClock, UuidV7Generator } from './system';

/** Adapters dos ports que não pertencem à UnitOfWork (relógio, ids, logger, reconciliação). */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    {
      provide: LOGGER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createLogger(config.logLevel),
    },
    {
      provide: RECONCILIATION_READER,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new MikroOrmReconciliationReader(orm),
    },
    {
      provide: RECONCILIATION_MONITOR,
      inject: [LOGGER],
      useFactory: (logger: Logger) => new LoggingReconciliationMonitor(logger),
    },
  ],
  exports: [CLOCK, ID_GENERATOR, LOGGER, RECONCILIATION_READER, RECONCILIATION_MONITOR],
})
export class InfrastructureModule {}
