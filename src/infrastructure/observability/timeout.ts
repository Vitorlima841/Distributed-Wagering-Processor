/** Erro de prazo dos health checks e dos gauges lidos no scrape. */
export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
}

/**
 * Corre `run` contra um prazo. O `AbortSignal` é abortado no prazo, para quem souber cancelar
 * (SDK da AWS); quem não souber (consulta ao banco) só deixa de ser esperado.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`excedeu ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Código curto e seguro de um erro (SQLSTATE, código/nome do SDK); nunca a mensagem. */
export function errorCodeOf(error: unknown): string {
  if (error instanceof Error) {
    const { code, Code } = error as { code?: unknown; Code?: unknown };
    if (typeof code === 'string' && code !== '') {
      return code;
    }
    if (typeof Code === 'string' && Code !== '') {
      return Code;
    }
    return error.name;
  }
  return 'UNKNOWN';
}
