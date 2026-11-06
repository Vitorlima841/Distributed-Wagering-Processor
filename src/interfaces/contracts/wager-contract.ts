import { z } from 'zod';

/**
 * Forma do pedido de transação, a mesma no corpo HTTP e no `data` da mensagem SQS (tipos e
 * tamanhos). Regras de conteúdo (formato do dinheiro, UUID, referência obrigatória…) ficam no
 * domínio e na application. Dinheiro é `string`: número JSON é rejeitado aqui.
 */

const MAX_TEXT = 255;
const text = z.string().max(MAX_TEXT);

export const moneySchema = z.object({ amount: z.string(), currency: z.string() });

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

/** ASCII visível e espaço, até 255 caracteres, sem espaços nas pontas (o domínio os recusa). */
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7E]{1,255}$/;

export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value) && value.trim() === value;
}
