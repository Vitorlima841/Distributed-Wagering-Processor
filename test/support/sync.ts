import type { MikroORM } from '@mikro-orm/postgresql';

/** Promessa controlada de fora: sincroniza transações concorrentes sem sleeps arbitrários. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Espera até existir um backend do banco de teste bloqueado num lock enquanto executa um comando
 * que contém `queryFragment`. É a condição observável de "a requisição chegou ao ponto de espera";
 * o poll tem prazo, então um teste quebrado falha em vez de travar.
 */
export async function waitForBlockedQuery(
  orm: MikroORM,
  queryFragment: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await orm.em.fork().execute<{ n: number }[]>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query ilike ?`,
      [`%${queryFragment}%`],
    );
    if ((rows[0]?.n ?? 0) > 0) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`nenhuma consulta com "${queryFragment}" ficou bloqueada em ${timeoutMs}ms`);
}
