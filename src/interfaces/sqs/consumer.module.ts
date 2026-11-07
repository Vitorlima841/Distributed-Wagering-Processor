import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CLOCK, type Clock, ProcessWagerTransaction } from '../../application';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/app-config';
import { LOGGER, type Logger } from '../../infrastructure/logging/logger';
import { SQS_CLIENT } from '../../infrastructure/messaging/sqs-client';
import { SqsWagerQueue } from '../../infrastructure/messaging/sqs-wager-queue';
import { METRICS, type WageringMetrics } from '../../infrastructure/observability/metrics';
import { errorCodeOf, withTimeout } from '../../infrastructure/observability/timeout';
import { WagerMessageConsumer } from './wager-message-consumer';
import { WAGER_QUEUE, type WagerQueue } from './wager-queue';

/**
 * Liga o consumer ao ciclo de vida do Nest. `main.ts` chama `enableShutdownHooks()`: no SIGTERM o
 * Nest roda `beforeApplicationShutdown` (o consumer termina o que está em andamento) antes de
 * `onApplicationShutdown` (fecha o ORM e o cliente SQS).
 */
@Injectable()
export class WagerConsumerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(WagerMessageConsumer) private readonly consumer: WagerMessageConsumer) {}

  onApplicationBootstrap(): void {
    this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }
}

/** Papel `consumer`: consome `wager-transactions.fifo` (ARCHITECTURE §9 e §18). */
@Module({
  providers: [
    {
      provide: WAGER_QUEUE,
      inject: [SQS_CLIENT, APP_CONFIG, METRICS, LOGGER],
      useFactory: (
        client: SQSClient,
        config: AppConfig,
        metrics: WageringMetrics,
        logger: Logger,
      ) => {
        const queue = new SqsWagerQueue(client, {
          queueName: config.queues.wager,
          deadLetterQueueName: config.queues.wagerDlq,
          waitTimeSeconds: config.consumer.waitTimeSeconds,
          maxMessages: config.consumer.maxMessages,
          visibilityTimeoutS: config.consumer.visibilityTimeoutS,
        });
        metrics.registerScrapeGauge(
          'wagering_dlq_depth',
          'Mensagens na DLQ de wager-transactions (visíveis + em voo), lidas do SQS no scrape; inclui o redrive nativo',
          () => withTimeout(config.healthCheckTimeoutMs, (signal) => queue.deadLetterDepth(signal)),
          (error) => logger.warn({ errorCode: errorCodeOf(error) }, 'dlq depth unavailable'),
        );
        return queue;
      },
    },
    {
      provide: WagerMessageConsumer,
      inject: [WAGER_QUEUE, ProcessWagerTransaction, CLOCK, LOGGER, APP_CONFIG, METRICS],
      useFactory: (
        queue: WagerQueue,
        processWager: ProcessWagerTransaction,
        clock: Clock,
        logger: Logger,
        config: AppConfig,
        metrics: WageringMetrics,
      ) =>
        new WagerMessageConsumer(queue, processWager, clock, logger, {
          consumerName: config.consumer.name,
          retry: {
            baseDelayS: config.consumer.retryBaseDelayS,
            maxDelayS: config.consumer.retryMaxDelayS,
          },
          shutdownTimeoutMs: config.consumer.shutdownTimeoutMs,
          metrics,
        }),
    },
    WagerConsumerLifecycle,
  ],
  exports: [WagerMessageConsumer],
})
export class ConsumerModule {}
