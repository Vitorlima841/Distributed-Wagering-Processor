import { z } from 'zod';
import { type ProcessWagerTransactionCommand, RequestValidationError } from '../../application';
import { isValidIdempotencyKey, submitWagerSchema } from '../contracts/wager-contract';

/** Único tipo de mensagem aceito em `wager-transactions.fifo` (CHALLENGE §10). */
export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

/**
 * Envelope:
 * `{ messageId, type, occurredAt, correlationId?, data: { ...corpo do POST, idempotencyKey } }`.
 * O `data` tem a mesma forma do corpo HTTP; `idempotencyKey` é obrigatório, como o header.
 */
const envelopeSchema = z.object({
  messageId: z.string(),
  type: z.string(),
  occurredAt: z.string(),
  correlationId: z.string().optional(),
  data: submitWagerSchema.extend({ idempotencyKey: z.string() }),
});

/** Mesmas restrições do `MessageDeduplicationId` do SQS: até 128 caracteres ASCII visíveis. */
const MESSAGE_ID_PATTERN = /^[\x21-\x7E]{1,128}$/;
/** Mesmo formato aceito no `X-Correlation-Id` do HTTP. */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ParsedWagerMessage {
  messageId: string;
  type: string;
  command: ProcessWagerTransactionCommand;
}

/**
 * Valida a forma da mensagem (JSON, envelope, tipos). Qualquer falha é `RequestValidationError`:
 * erro permanente, que o consumer manda para a DLQ sem tocar no banco. As regras de conteúdo
 * (dinheiro, UUID, kind, referência) são do use case, as mesmas do HTTP.
 *
 * `correlationId`: o do envelope, se vier num formato válido; senão o `messageId`. O `messageId`
 * é também o `causationId` dos eventos (a mensagem é a causa).
 */
export function parseWagerMessage(body: string): ParsedWagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw invalid('MALFORMED_MESSAGE', 'Corpo da mensagem não é JSON válido');
  }
  const result = envelopeSchema.safeParse(json);
  if (!result.success) {
    throw new RequestValidationError(
      'MALFORMED_MESSAGE',
      'Envelope da mensagem inválido',
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(message)',
        message: issue.message,
      })),
    );
  }
  const { messageId, type, occurredAt, correlationId, data } = result.data;
  if (type !== WAGER_MESSAGE_TYPE) {
    throw invalid('UNSUPPORTED_MESSAGE_TYPE', `Tipo de mensagem não suportado: ${type}`);
  }
  if (!MESSAGE_ID_PATTERN.test(messageId)) {
    throw invalid('INVALID_MESSAGE_ID', 'messageId deve ter de 1 a 128 caracteres ASCII visíveis');
  }
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw invalid('MALFORMED_MESSAGE', 'occurredAt deve ser uma data ISO-8601');
  }
  if (!isValidIdempotencyKey(data.idempotencyKey)) {
    throw invalid(
      'INVALID_IDEMPOTENCY_KEY',
      'idempotencyKey deve ter de 1 a 255 caracteres ASCII visíveis, sem espaços nas pontas',
    );
  }
  return {
    messageId,
    type,
    command: {
      ...data,
      referenceExternalTransactionId: data.referenceExternalTransactionId ?? undefined,
      correlationId:
        correlationId !== undefined && CORRELATION_ID_PATTERN.test(correlationId)
          ? correlationId
          : messageId,
      causationId: messageId,
    },
  };
}

function invalid(code: string, message: string): RequestValidationError {
  return new RequestValidationError(code, message);
}
