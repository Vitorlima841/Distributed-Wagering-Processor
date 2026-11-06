import { ConnectionException } from '@mikro-orm/core';
import {
  IntegrityViolationError,
  PersistenceError,
  TransientPersistenceError,
  UniqueViolationError,
} from '../../application/ports';
import { DomainError } from '../../domain';

/** Erros de rede do driver `pg` (vêm com `code` do Node, não SQLSTATE). */
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

/**
 * Converte erros do MikroORM / `pg` em erros da aplicação, pelo SQLSTATE e pelo nome da
 * constraint (as exceções do MikroORM copiam `code` e `constraint` do erro original).
 * Erros que não vêm do banco (domínio, programação) passam intactos.
 */
export function translatePersistenceError(error: unknown): unknown {
  if (error instanceof DomainError || error instanceof PersistenceError) {
    return error;
  }
  if (error instanceof ConnectionException) {
    return new TransientPersistenceError('connection', error);
  }
  if (typeof error !== 'object' || error === null) {
    return error;
  }
  const { code, constraint, message } = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };
  if (typeof code !== 'string') {
    return error;
  }
  const constraintName = typeof constraint === 'string' ? constraint : undefined;

  switch (code) {
    case '23505':
      return new UniqueViolationError(constraintName ?? 'desconhecida', error);
    case '40P01':
      return new TransientPersistenceError('deadlock', error);
    case '40001':
      return new TransientPersistenceError('serialization', error);
    case '55P03':
      return new TransientPersistenceError('lock_timeout', error);
  }
  // 08xxx: conexão; 57P01-57P03: servidor desligando/reiniciando
  if (
    code.startsWith('08') ||
    ['57P01', '57P02', '57P03'].includes(code) ||
    NETWORK_CODES.has(code)
  ) {
    return new TransientPersistenceError('connection', error);
  }
  // 23xxx: CHECK, FK, NOT NULL e os triggers de guarda/consistência (23000)
  if (code.startsWith('23')) {
    return new IntegrityViolationError(
      constraintName,
      `O banco barrou um dado inválido (${constraintName ?? code}): ${String(message)}`,
      error,
    );
  }
  return error;
}
