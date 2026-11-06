import { z } from 'zod';
import { RequestValidationError } from '../../application';
import { isValidIdempotencyKey, moneySchema } from '../contracts/wager-contract';

/**
 * Validação de forma dos contratos HTTP (tipos e tamanhos). O corpo de `POST /wagering/transactions`
 * é o mesmo do `data` da mensagem SQS (`../contracts/wager-contract`). Regras de conteúdo ficam no
 * domínio e na application, compartilhadas com o consumer SQS.
 */

export { submitWagerSchema } from '../contracts/wager-contract';

export const createWalletSchema = z.object({
  playerId: z.string(),
  initialBalance: moneySchema,
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

export function parseIdempotencyKey(header: unknown): string {
  if (header === undefined || header === '') {
    throw new RequestValidationError(
      'MISSING_IDEMPOTENCY_KEY',
      'O header Idempotency-Key é obrigatório',
    );
  }
  if (typeof header !== 'string' || !isValidIdempotencyKey(header)) {
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
