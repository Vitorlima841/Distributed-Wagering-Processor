/**
 * O que o consumer precisa da fila `wager-transactions.fifo`. A implementação real fala com o SQS
 * (`infrastructure/messaging/sqs-wager-queue.ts`); os testes unitários usam uma fila em memória.
 */

export interface QueueMessage {
  /** MessageId do SQS: muda a cada envio, não serve para deduplicar (a inbox usa o do envelope). */
  sqsMessageId: string;
  /** Identifica este recebimento; ack e visibilidade usam o handle. */
  receiptHandle: string;
  body: string;
  /** MessageGroupId (walletId no FIFO). */
  groupId: string | undefined;
  /** ApproximateReceiveCount: 1 na primeira entrega. É do SQS, não da memória do processo. */
  receiveCount: number;
}

export interface DeadLetterReason {
  /** Categoria do erro (`validation`, `conflict`, `not_found`…). */
  kind: string;
  /** Código estável (`MALFORMED_MESSAGE`, `WALLET_NOT_FOUND`…). */
  code: string;
}

export interface WagerQueue {
  /** ReceiveMessage com long polling. Abortado pelo sinal, devolve lista vazia. */
  receive(signal: AbortSignal): Promise<QueueMessage[]>;
  /** DeleteMessage. Só depois do COMMIT. */
  ack(message: QueueMessage): Promise<void>;
  /** ChangeMessageVisibility: a mensagem volta depois de `seconds` (0 = já). */
  retryAfter(message: QueueMessage, seconds: number): Promise<void>;
  /** Copia para a DLQ (corpo intacto + motivo) e depois apaga da fila principal. */
  deadLetter(message: QueueMessage, reason: DeadLetterReason): Promise<void>;
}

export const WAGER_QUEUE = Symbol('WAGER_QUEUE');
