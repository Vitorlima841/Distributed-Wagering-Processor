import { InvalidFieldError } from '../../domain';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valida um UUID no formato canônico e normaliza para minúsculas. O Postgres devolve UUID em
 * minúsculas: sem isso, um UUID em maiúsculas viraria falso `WALLET_PLAYER_MISMATCH`, hash
 * diferente no replay ou erro 22P02 (ARCHITECTURE §15.10).
 */
export function normalizeUuid(field: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidFieldError(field, 'deve ser um UUID (8-4-4-4-12 hexadecimal)');
  }
  return value.toLowerCase();
}
