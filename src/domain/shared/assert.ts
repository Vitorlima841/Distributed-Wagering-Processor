import { InvalidFieldError } from '../errors';

/** Identificadores e textos obrigatórios: string não vazia (sem espaços nas pontas). */
export function assertNonEmpty(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidFieldError(field, 'deve ser uma string não vazia');
  }
  if (value !== value.trim()) {
    throw new InvalidFieldError(field, 'não pode ter espaços no início ou no fim');
  }
}
