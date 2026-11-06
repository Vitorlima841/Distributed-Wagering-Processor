import type { SQSClient } from '@aws-sdk/client-sqs';
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
import { LOGGER, type Logger } from '../../infrastructure/logging/logger';
import { safeErrorFields } from '../../infrastructure/logging/safe-error-fields';
import { SQS_CLIENT } from '../../infrastructure/messaging/sqs-client';
import { SqsEventPublisher } from '../../infrastructure/messaging/sqs-event-publisher';
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

/** Ciclo do publisher: um lote por transação; falhas por mensagem voltam com backoff. */
export function outboxCycle(publishOutbox: PublishOutbox, batchSize: number, logger: Logger) {
  return async () => {
    const summary = await publishOutbox.publishDue();
    if (summary.claimed > 0) {
      logger.debug(
        { claimed: summary.claimed, published: summary.published, failed: summary.failed.length },
        'outbox batch',
      );
    }
    for (const failure of summary.failed) {
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
) {
  return async () => {
    const summary = await retry.runOnce();
    for (const result of summary.results) {
      if (result.outcome === 'SKIPPED') {
        continue;
      }
      const fields = {
        transactionId: result.transactionId,
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
      logger.warn(
        { transactionId, code: classifyError(error).code, ...safeErrorFields(error) },
        'pending reference retry failed; will retry next cycle',
      );
    }
    return { busy: summary.candidates >= batchSize };
  };
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
      inject: [PublishOutbox, LOGGER, APP_CONFIG],
      useFactory: (publishOutbox: PublishOutbox, logger: Logger, config: AppConfig) => {
        const workerLogger = logger.child({ component: 'outbox-publisher' });
        return new PollingWorker(
          'outbox-publisher',
          outboxCycle(publishOutbox, config.outbox.batchSize, workerLogger),
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
      inject: [RetryPendingReferences, LOGGER, APP_CONFIG],
      useFactory: (retry: RetryPendingReferences, logger: Logger, config: AppConfig) => {
        const workerLogger = logger.child({ component: 'pending-reference-worker' });
        return new PollingWorker(
          'pending-reference-worker',
          pendingReferenceCycle(retry, config.pendingReference.batchSize, workerLogger),
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
