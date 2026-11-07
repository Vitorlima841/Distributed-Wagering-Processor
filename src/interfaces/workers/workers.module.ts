import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  CLOCK,
  type Clock,
  classifyError,
  EVENT_PUBLISHER,
  type EventPublisher,
  ID_GENERATOR,
  type IdGenerator,
  PublishOutbox,
  RetryPendingReferences,
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../application';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/app-config';
import { OutboxBacklogReader } from '../../infrastructure/database/outbox-backlog-reader';
import { LOGGER, type Logger } from '../../infrastructure/logging/logger';
import { safeErrorFields } from '../../infrastructure/logging/safe-error-fields';
import { SQS_CLIENT } from '../../infrastructure/messaging/sqs-client';
import { SqsEventPublisher } from '../../infrastructure/messaging/sqs-event-publisher';
import { METRICS, type WageringMetrics } from '../../infrastructure/observability/metrics';
import { errorCodeOf, withTimeout } from '../../infrastructure/observability/timeout';
import { PollingWorker } from './polling-worker';

export const OUTBOX_WORKER = Symbol('OUTBOX_WORKER');
export const PENDING_REFERENCE_WORKER = Symbol('PENDING_REFERENCE_WORKER');

/**
 * Liga um `PollingWorker` ao ciclo de vida do Nest: começa no bootstrap e, no SIGTERM
 * (`enableShutdownHooks`), termina o ciclo em andamento antes de o ORM e o cliente SQS fecharem.
 */
function workerLifecycle(token: symbol) {
  @Injectable()
  class WorkerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
    constructor(@Inject(token) readonly worker: PollingWorker) {}

    onApplicationBootstrap(): void {
      this.worker.start();
    }

    async beforeApplicationShutdown(): Promise<void> {
      await this.worker.stop();
    }
  }
  return WorkerLifecycle;
}

/**
 * Ciclo do publisher: um lote por transação; falhas por mensagem voltam com backoff. Cada evento
 * publicado vira um log com o `correlationId` da requisição ou mensagem que o gerou (o fio
 * HTTP/SQS → transação → evento) e uma amostra de `wagering_outbox_lag_seconds`.
 */
export function outboxCycle(
  publishOutbox: PublishOutbox,
  batchSize: number,
  logger: Logger,
  metrics: WageringMetrics,
) {
  return async () => {
    const summary = await publishOutbox.publishDue();
    if (summary.claimed > 0) {
      logger.debug(
        { claimed: summary.claimed, published: summary.published, failed: summary.failed.length },
        'outbox batch',
      );
    }
    for (const event of summary.publishedEvents) {
      const lagMs = event.publishedAt.getTime() - event.occurredAt.getTime();
      metrics.recordEventPublished(event.eventType, lagMs / 1000);
      logger.info(
        {
          eventId: event.eventId,
          eventType: event.eventType,
          aggregateId: event.aggregateId,
          ...(event.correlationId ? { correlationId: event.correlationId } : {}),
          lagMs,
        },
        'event published',
      );
    }
    for (const failure of summary.failed) {
      metrics.recordPublishFailure(failure.reason);
      logger.warn(
        { eventId: failure.messageId, reason: failure.reason },
        'event publish failed; scheduled for retry',
      );
    }
    return { busy: summary.claimed >= batchSize };
  };
}

/** Ciclo do worker de PENDING_REFERENCE: uma transação por candidato. */
export function pendingReferenceCycle(
  retry: RetryPendingReferences,
  batchSize: number,
  logger: Logger,
  metrics: WageringMetrics,
) {
  return async () => {
    const summary = await retry.runOnce();
    for (const result of summary.results) {
      if (result.outcome === 'SKIPPED') {
        continue;
      }
      if (result.outcome === 'PENDING_REFERENCE') {
        metrics.recordRetry('pending_reference', 'REFERENCE_NOT_FOUND');
      } else {
        metrics.recordResolution(result.kind, result.outcome);
      }
      const fields = {
        transactionId: result.transactionId,
        walletId: result.walletId,
        correlationId: result.correlationId,
        kind: result.kind,
        outcome: result.outcome,
        ...(result.outcome === 'REJECTED' ? { failureCode: result.failureCode } : {}),
        ...(result.outcome === 'PENDING_REFERENCE'
          ? { attempts: result.attempts, nextAttemptAt: result.nextAttemptAt.toISOString() }
          : {}),
      };
      if (result.outcome === 'PENDING_REFERENCE') {
        logger.debug(fields, 'reference still missing');
      } else {
        logger.info(fields, 'pending reference resolved');
      }
    }
    for (const { transactionId, error } of summary.errors) {
      const classified = classifyError(error);
      metrics.recordFailure('pending_reference', classified);
      metrics.recordRetry('pending_reference', classified.code);
      logger.warn(
        { transactionId, code: classified.code, ...safeErrorFields(error) },
        'pending reference retry failed; will retry next cycle',
      );
    }
    return { busy: summary.candidates >= batchSize };
  };
}

/**
 * Gauges do backlog da outbox, lidos do banco a cada scrape (uma consulta para os dois). Mostram
 * também o evento que o broker recusa para sempre: ele fica pendente e a idade só cresce.
 */
function registerOutboxBacklogGauges(
  metrics: WageringMetrics,
  reader: OutboxBacklogReader,
  config: AppConfig,
  logger: Logger,
): void {
  let last: { at: number; backlog: ReturnType<OutboxBacklogReader['read']> } | undefined;
  // os dois gauges do mesmo scrape compartilham a leitura
  const backlog = () => {
    if (!last || performance.now() - last.at > 1000) {
      last = {
        at: performance.now(),
        backlog: withTimeout(config.healthCheckTimeoutMs, () => reader.read()),
      };
    }
    return last.backlog;
  };
  const onError = (error: unknown) =>
    logger.warn({ errorCode: errorCodeOf(error) }, 'outbox backlog unavailable');
  metrics.registerScrapeGauge(
    'wagering_outbox_pending_messages',
    'Eventos da outbox ainda não publicados (banco, lido no scrape)',
    async () => (await backlog()).pending,
    onError,
  );
  metrics.registerScrapeGauge(
    'wagering_outbox_oldest_pending_age_seconds',
    'Idade do evento não publicado mais antigo (0 sem backlog): o outbox lag atual',
    async () => (await backlog()).oldestAgeSeconds,
    onError,
  );
}

/** Papel `outbox`: publica `outbox_messages` em `wagering-events` (ARCHITECTURE §9 e §19). */
@Module({
  providers: [
    {
      provide: EVENT_PUBLISHER,
      inject: [SQS_CLIENT, APP_CONFIG],
      useFactory: (client: SQSClient, config: AppConfig) =>
        new SqsEventPublisher(client, {
          queueName: config.queues.events,
          publishTimeoutMs: config.outbox.publishTimeoutMs,
        }),
    },
    {
      provide: PublishOutbox,
      inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, APP_CONFIG],
      useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock, config: AppConfig) =>
        new PublishOutbox(uow, publisher, clock, { batchSize: config.outbox.batchSize }),
    },
    {
      provide: OUTBOX_WORKER,
      inject: [PublishOutbox, LOGGER, APP_CONFIG, METRICS, MikroORM],
      useFactory: (
        publishOutbox: PublishOutbox,
        logger: Logger,
        config: AppConfig,
        metrics: WageringMetrics,
        orm: MikroORM,
      ) => {
        const workerLogger = logger.child({ component: 'outbox-publisher' });
        registerOutboxBacklogGauges(metrics, new OutboxBacklogReader(orm), config, workerLogger);
        return new PollingWorker(
          'outbox-publisher',
          outboxCycle(publishOutbox, config.outbox.batchSize, workerLogger, metrics),
          workerLogger,
          { pollIntervalMs: config.outbox.pollIntervalMs },
        );
      },
    },
    workerLifecycle(OUTBOX_WORKER),
  ],
  exports: [PublishOutbox, OUTBOX_WORKER],
})
export class OutboxModule {}

/** Papel `pending-ref`: reprocessa PENDING_REFERENCE com backoff (ARCHITECTURE §9 e §19). */
@Module({
  providers: [
    {
      provide: RetryPendingReferences,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, APP_CONFIG],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, config: AppConfig) =>
        new RetryPendingReferences(uow, clock, ids, {
          batchSize: config.pendingReference.batchSize,
          maxAttempts: config.pendingReference.maxAttempts,
        }),
    },
    {
      provide: PENDING_REFERENCE_WORKER,
      inject: [RetryPendingReferences, LOGGER, APP_CONFIG, METRICS],
      useFactory: (
        retry: RetryPendingReferences,
        logger: Logger,
        config: AppConfig,
        metrics: WageringMetrics,
      ) => {
        const workerLogger = logger.child({ component: 'pending-reference-worker' });
        return new PollingWorker(
          'pending-reference-worker',
          pendingReferenceCycle(retry, config.pendingReference.batchSize, workerLogger, metrics),
          workerLogger,
          { pollIntervalMs: config.pendingReference.pollIntervalMs },
        );
      },
    },
    workerLifecycle(PENDING_REFERENCE_WORKER),
  ],
  exports: [RetryPendingReferences, PENDING_REFERENCE_WORKER],
})
export class PendingRefModule {}
