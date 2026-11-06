import type { OutboxMessage } from '../../domain';

export interface PublishFailure {
  messageId: string;
  /** Código curto do motivo (ex.: código de erro do broker), sem conteúdo do evento. */
  reason: string;
}

export interface PublishResult {
  /** Ids (= eventId) aceitos pelo broker. */
  published: string[];
  /** Ids recusados ou sem confirmação; voltam para a outbox com backoff. */
  failed: PublishFailure[];
}

/**
 * Publica envelopes de eventos de integração no broker. At-least-once: uma mensagem pode ter
 * sido entregue mesmo quando aparece em `failed` (timeout, resposta perdida), e o consumidor
 * deduplica pelo `eventId`. Uma falha geral (broker fora do ar) pode ser lançada como exceção.
 */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
