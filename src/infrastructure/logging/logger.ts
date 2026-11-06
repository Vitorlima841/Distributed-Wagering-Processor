import pino from 'pino';

/** Logger JSON estruturado. Nunca logar payload financeiro completo. */
export function createLogger(level: string) {
  return pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime });
}

export type Logger = ReturnType<typeof createLogger>;
