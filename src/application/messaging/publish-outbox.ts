import type { OutboxMessage } from '../../domain';
import type { Clock, EventPublisher, PublishFailure, UnitOfWork } from '../ports';

export interface PublishOutboxOptions {
  /** Mensagens travadas e publicadas por ciclo (uma transação SQL por ciclo). */
  batchSize: number;
}

/** Metadados de um evento publicado neste ciclo (logs e outbox lag; sem o conteúdo do evento). */
export interface PublishedEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId?: string;
  occurredAt: Date;
  publishedAt: Date;
}

export interface PublishOutboxSummary {
  /** Mensagens travadas neste ciclo (0 = nada vencido ou tudo travado por outros publishers). */
  claimed: number;
  published: number;
  /** Voltaram para a outbox com backoff (`scheduleRetry`). */
  failed: PublishFailure[];
  /** As publicadas: `publishedAt − occurredAt` é o outbox lag de cada uma. */
  publishedEvents: PublishedEvent[];
}

/**
 * Um ciclo do outbox publisher, numa transação SQL (ARCHITECTURE §9 e §19):
 *  1. `SELECT … FOR UPDATE SKIP LOCKED` das mensagens vencidas (só as já confirmadas);
 *  2. publica no broker;
 *  3. `markPublished` nas aceitas e `scheduleRetry` (backoff) nas que falharam;
 *  4. COMMIT.
 *
 * Se o processo morrer em qualquer ponto antes do COMMIT, a transação é desfeita, os locks são
 * soltos e outra instância pega as mesmas mensagens. Se morrer depois de publicar e antes do
 * COMMIT, a mensagem sai de novo com o mesmo `eventId` (at-least-once; o consumidor deduplica).
 * Não há limite de tentativas: desistir seria perder um evento confirmado.
 */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly options: PublishOutboxOptions,
  ) {
    if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
      throw new Error('batchSize deve ser um inteiro positivo');
    }
  }

  publishDue(): Promise<PublishOutboxSummary> {
    return this.uow.run(async (scope) => {
      const due = await scope.outbox.claimDue(this.clock.now(), this.options.batchSize);
      if (due.length === 0) {
        return { claimed: 0, published: 0, failed: [], publishedEvents: [] };
      }

      let published: Set<string>;
      let failed: PublishFailure[];
      try {
        const result = await this.publisher.publish(due);
        published = new Set(result.published);
        // mensagem sem confirmação explícita conta como falha (volta com backoff)
        const reported = new Map(result.failed.map((f) => [f.messageId, f]));
        failed = due
          .filter((m) => !published.has(m.id))
          .map((m) => reported.get(m.id) ?? { messageId: m.id, reason: 'NOT_ACKNOWLEDGED' });
      } catch (error) {
        published = new Set();
        failed = due.map((m) => ({ messageId: m.id, reason: reasonOf(error) }));
      }

      const now = this.clock.now();
      const publishedEvents: PublishedEvent[] = [];
      for (const message of due) {
        if (published.has(message.id)) {
          message.markPublished(now);
          publishedEvents.push(publishedEventOf(message, now));
        } else {
          message.scheduleRetry(now);
        }
        await scope.outbox.save(message);
      }
      return {
        claimed: due.length,
        published: due.length - failed.length,
        failed,
        publishedEvents,
      };
    });
  }
}

function publishedEventOf(message: OutboxMessage, publishedAt: Date): PublishedEvent {
  const { correlationId } = message.payload;
  return {
    eventId: message.id,
    eventType: message.eventType,
    aggregateId: message.aggregateId,
    ...(typeof correlationId === 'string' ? { correlationId } : {}),
    occurredAt: message.occurredAt,
    publishedAt,
  };
}

/** Só o nome/código do erro: a mensagem do SDK pode trazer o conteúdo enviado. */
function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { Code?: unknown }).Code;
    return typeof code === 'string' && code !== '' ? code : error.name;
  }
  return 'UNKNOWN';
}
