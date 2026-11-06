// `node:crypto` é a única dependência além de decimal.js: stdlib, síncrona e determinística.
import { createHash } from 'node:crypto';
import { InvalidFieldError } from '../errors';
import { Money, type MoneyProps } from '../money/money';

/** Campos de negócio que entram no hash. Header e metadados de transporte ficam de fora. */
export interface WagerPayloadInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money | MoneyProps;
  referenceExternalTransactionId?: string | null;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * JSON canônico: chaves ordenadas recursivamente, sem espaços; `undefined` e `null` em
 * propriedades de objeto são omitidos (HTTP e SQS produzem o mesmo hash para "sem referência").
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidFieldError('payload', 'número não finito não é serializável');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item ?? null));
  }
  if (typeof value === 'object' && value !== undefined) {
    const withToJson = value as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === 'function') {
      return canonicalize(withToJson.toJSON());
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || item === null) continue;
      sorted[key] = canonicalize(item);
    }
    return sorted;
  }
  throw new InvalidFieldError('payload', `tipo não serializável: ${typeof value}`);
}

/**
 * SHA-256 (hex, 64 chars) do JSON canônico dos campos de negócio.
 * O amount entra normalizado (escala 2), então "25" e "25.00" produzem o mesmo hash.
 */
export function computeWagerPayloadHash(input: WagerPayloadInput): string {
  const money = (input.money instanceof Money ? input.money : Money.from(input.money)).toJSON();
  return sha256Hex(
    canonicalJson({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    }),
  );
}
