import { PersistenceError } from '../../application/ports';

/**
 * Campos de log seguros para um erro inesperado. Mensagens de erro do banco/driver trazem o SQL
 * com os parâmetros (valores financeiros, ids de player): ficam de fora; sobram nome, SQLSTATE e
 * constraint. Usado pelo filtro HTTP e pelo consumer SQS.
 */
export function safeErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorType: typeof error };
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  const fromDatabase = error instanceof PersistenceError || typeof code === 'string';
  return {
    errorName: error.name,
    ...(typeof code === 'string' ? { errorCode: code } : {}),
    ...(typeof constraint === 'string' ? { constraint } : {}),
    ...(fromDatabase ? {} : { errorMessage: error.message, stack: error.stack }),
  };
}
