import { z } from 'zod';
import { RequestValidationError } from '../../application';

/**
 * Validação de forma dos contratos HTTP (tipos e tamanhos). Regras de conteúdo (formato do
 * dinheiro, UUID, referência obrigatória…) ficam no domínio e na application, compartilhadas com
 * o consumer SQS. Dinheiro é `string`: número JSON é rejeitado aqui.
 */

const MAX_TEXT = 255;
const text = z.string().max(MAX_TEXT);

export const moneySchema = z.object({ amount: z.string(), currency: z.string() });

export const createWalletSchema = z.object({
  playerId: z.string(),
  initialBalance: moneySchema,
});

export const submitWagerSchema = z.object({
  providerId: text,
  externalTransactionId: text,
  playerId: z.string(),
  walletId: z.string(),
  roundId: text,
  gameId: text,
  kind: z.string(),
  money: moneySchema,
  referenceExternalTransactionId: text.nullish(),
});

export function parseRequest<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RequestValidationError(
      'INVALID_REQUEST',
      'Corpo da requisição inválido',
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(body)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** ASCII visível e espaço, até 255 caracteres. Espaços nas pontas o domínio recusa. */
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7E]{1,255}$/;

export function parseIdempotencyKey(header: unknown): string {
  if (header === undefined || header === '') {
    throw new RequestValidationError(
      'MISSING_IDEMPOTENCY_KEY',
      'O header Idempotency-Key é obrigatório',
    );
  }
  if (
    typeof header !== 'string' ||
    !IDEMPOTENCY_KEY_PATTERN.test(header) ||
    header.trim() !== header
  ) {
    throw new RequestValidationError(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key deve ter de 1 a 255 caracteres ASCII visíveis, sem espaços nas pontas',
    );
  }
  return header;
}

/** `limit` da query: inteiro decimal; o intervalo válido é checado no use case. */
export function parseLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^\d{1,4}$/.test(value)) {
    throw new RequestValidationError('INVALID_LIMIT', 'limit deve ser um inteiro positivo');
  }
  return Number(value);
}

export function parseCursor(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new RequestValidationError('INVALID_CURSOR', 'Cursor de paginação inválido');
  }
  return value;
}
