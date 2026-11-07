import pino, { type DestinationStream } from 'pino';
import { currentLogContext } from './log-context';

/**
 * Logger JSON estruturado. Cada linha leva os campos do contexto atual (`log-context.ts`): quem
 * loga dentro de uma requisição ou mensagem não precisa repassar o `correlationId`. Os campos do
 * próprio log têm precedência sobre os do contexto. Nunca logar payload financeiro completo.
 *
 * `destination` existe para os testes capturarem as linhas; o padrão é stdout.
 */
export function createLogger(level: string, destination?: DestinationStream) {
  const options = {
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin: currentLogContext,
  };
  return destination ? pino(options, destination) : pino(options);
}

export type Logger = ReturnType<typeof createLogger>;

export const LOGGER = Symbol('LOGGER');

/** Destino opcional dos logs (testes); sem ele, stdout. */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');
