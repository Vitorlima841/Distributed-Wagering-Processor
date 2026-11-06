import {
  GetQueueUrlCommand,
  type MessageAttributeValue,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishFailure, PublishResult } from '../../application/ports';
import type { OutboxMessage } from '../../domain';

export interface SqsEventPublisherOptions {
  /** Fila de destino dos eventos de integração (`wagering-events`, standard). */
  queueName: string;
  /** Prazo de cada `SendMessageBatch`; estourado, as mensagens do lote contam como falha. */
  publishTimeoutMs: number;
}

/** Limite do `SendMessageBatch`. */
const SQS_BATCH_LIMIT = 10;

/** Atributos de cada mensagem: o consumidor filtra e deduplica sem abrir o corpo. */
export const EVENT_ATTRIBUTES = {
  eventId: 'event-id',
  eventType: 'event-type',
  aggregateId: 'aggregate-id',
  correlationId: 'correlation-id',
} as const;

/**
 * Publica os envelopes da outbox na fila de eventos, em lotes de 10 (`SendMessageBatch`).
 *
 * - Corpo = envelope gravado na outbox (`eventId`, `eventType`, `version`, `data`…), sem mudanças.
 * - Fila standard: sem ordem nem deduplicação. A garantia é at-least-once e o consumidor
 *   deduplica pelo `eventId` (também nos atributos). A ordem por wallet sai do `walletVersion`
 *   do `WalletBalanceChanged` (ARCHITECTURE §19).
 * - Resultado por mensagem: um lote que falha inteiro (timeout, SQS fora do ar) marca as suas
 *   mensagens como falha e não impede os outros lotes.
 */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly options: SqsEventPublisherOptions,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    if (messages.length === 0) {
      return { published: [], failed: [] };
    }
    const queueUrl = await this.url();
    const batches: OutboxMessage[][] = [];
    for (let i = 0; i < messages.length; i += SQS_BATCH_LIMIT) {
      batches.push(messages.slice(i, i + SQS_BATCH_LIMIT));
    }
    const results = await Promise.all(batches.map((batch) => this.sendBatch(queueUrl, batch)));
    return {
      published: results.flatMap((r) => r.published),
      failed: results.flatMap((r) => r.failed),
    };
  }

  private async sendBatch(queueUrl: string, batch: OutboxMessage[]): Promise<PublishResult> {
    try {
      const response = await this.client.send(
        new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: batch.map(toEntry) }),
        { abortSignal: AbortSignal.timeout(this.options.publishTimeoutMs) },
      );
      const published = (response.Successful ?? []).flatMap((s) => (s.Id ? [s.Id] : []));
      const failed: PublishFailure[] = (response.Failed ?? []).flatMap((f) =>
        f.Id ? [{ messageId: f.Id, reason: f.Code ?? 'SQS_BATCH_ENTRY_FAILED' }] : [],
      );
      return { published, failed };
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'UNKNOWN';
      return { published: [], failed: batch.map((m) => ({ messageId: m.id, reason })) };
    }
  }

  /** Resolvida uma vez; uma falha (SQS fora do ar) é tentada de novo na próxima chamada. */
  private url(): Promise<string> {
    if (!this.queueUrl) {
      const pending = this.client
        .send(new GetQueueUrlCommand({ QueueName: this.options.queueName }), {
          abortSignal: AbortSignal.timeout(this.options.publishTimeoutMs),
        })
        .then(({ QueueUrl }) => {
          if (!QueueUrl) {
            throw new Error(`Fila ${this.options.queueName} sem URL`);
          }
          return QueueUrl;
        });
      pending.catch(() => {
        if (this.queueUrl === pending) {
          this.queueUrl = undefined;
        }
      });
      this.queueUrl = pending;
    }
    return this.queueUrl;
  }
}

/** O `Id` da entrada é o `eventId` (UUID: cabe na regra `[A-Za-z0-9_-]{1,80}` do SQS). */
function toEntry(message: OutboxMessage): SendMessageBatchRequestEntry {
  const attributes: Record<string, MessageAttributeValue> = {
    [EVENT_ATTRIBUTES.eventId]: { DataType: 'String', StringValue: message.id },
    [EVENT_ATTRIBUTES.eventType]: { DataType: 'String', StringValue: message.eventType },
    [EVENT_ATTRIBUTES.aggregateId]: { DataType: 'String', StringValue: message.aggregateId },
  };
  const correlationId = message.payload.correlationId;
  if (typeof correlationId === 'string' && correlationId !== '') {
    attributes[EVENT_ATTRIBUTES.correlationId] = { DataType: 'String', StringValue: correlationId };
  }
  return {
    Id: message.id,
    MessageBody: JSON.stringify(message.payload),
    MessageAttributes: attributes,
  };
}
