import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Module } from '@nestjs/common';
import type { DestinationStream } from 'pino';
import {
  CLOCK,
  ID_GENERATOR,
  RECONCILIATION_MONITOR,
  RECONCILIATION_READER,
} from '../application/ports';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { MikroOrmReconciliationReader } from './database/reconciliation-reader';
import { createLogger, LOG_DESTINATION, LOGGER, type Logger } from './logging/logger';
import { LoggingReconciliationMonitor } from './logging/reconciliation-monitor';
import { SQS_CLIENT } from './messaging/sqs-client';
import { METRICS, WageringMetrics } from './observability/metrics';
import {
  postgresCheck,
  queuesForRole,
  READINESS,
  Readiness,
  sqsCheck,
} from './observability/readiness';
import { SystemClock, UuidV7Generator } from './system';

/**
 * Adapters dos ports que não pertencem à UnitOfWork (relógio, ids, logger, reconciliação) e a
 * observabilidade do processo (métricas e readiness).
 */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    {
      provide: LOGGER,
      inject: [APP_CONFIG, LOG_DESTINATION],
      useFactory: (config: AppConfig, destination: DestinationStream | null) =>
        createLogger(config.logLevel, destination ?? undefined),
    },
    { provide: METRICS, useFactory: () => new WageringMetrics() },
    {
      provide: RECONCILIATION_READER,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new MikroOrmReconciliationReader(orm),
    },
    {
      provide: RECONCILIATION_MONITOR,
      inject: [LOGGER, METRICS],
      useFactory: (logger: Logger, metrics: WageringMetrics) =>
        new LoggingReconciliationMonitor(logger, metrics),
    },
    {
      provide: READINESS,
      inject: [MikroORM, SQS_CLIENT, APP_CONFIG],
      useFactory: (orm: MikroORM, sqs: SQSClient, config: AppConfig) => {
        const queues = queuesForRole(config);
        return new Readiness(
          [postgresCheck(orm), ...(queues.length > 0 ? [sqsCheck(sqs, queues)] : [])],
          config.healthCheckTimeoutMs,
        );
      },
    },
  ],
  exports: [
    CLOCK,
    ID_GENERATOR,
    LOGGER,
    METRICS,
    RECONCILIATION_READER,
    RECONCILIATION_MONITOR,
    READINESS,
  ],
})
export class InfrastructureModule {}
