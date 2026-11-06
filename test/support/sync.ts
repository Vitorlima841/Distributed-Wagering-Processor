import type { MikroORM } from '@mikro-orm/postgresql';
import { inTransaction } from './database';

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

export interface WalletLockHold {
  /** COMMIT da transação que segura o lock (idempotente). */
  release(): Promise<void>;
}

/**
 * Barreira: uma conexão do teste trava a wallet (`SELECT … FOR UPDATE`) e segura o lock até
 * `release()`. Toda requisição que chegar à wallet nesse meio-tempo fica parada no mesmo ponto do
 * use case, e o teste pode conferir quantas estão ali antes de soltar.
 */
export async function holdWalletLock(orm: MikroORM, walletId: string): Promise<WalletLockHold> {
  const locked = gate();
  const release = gate();
  const done = inTransaction(orm, async (em) => {
    await em.execute('select id from wallets where id = ? for update', [walletId]);
    locked.open();
    await release.promise;
  });
  await Promise.race([locked.promise, done]);
  return {
    release: async () => {
      release.open();
      await done;
    },
  };
}

/**
 * Espera até exatamente `expected` conexões do cluster (`application_name` começando com
 * `appNamePrefix`) estarem bloqueadas esperando o lock da wallet ao mesmo tempo. Devolve quantas
 * vieram de cada instância. Poll com prazo: um teste quebrado falha em vez de travar.
 */
export async function waitForWalletLockWaiters(
  orm: MikroORM,
  appNamePrefix: string,
  expected: number,
  { timeoutMs = 15_000, settled }: { timeoutMs?: number; settled?: () => number } = {},
): Promise<Map<string, number>> {
  const deadline = Date.now() + timeoutMs;
  let last = new Map<string, number>();
  while (Date.now() < deadline) {
    last = await lockWaitersByInstance(orm, appNamePrefix);
    const total = [...last.values()].reduce((sum, n) => sum + n, 0);
    if (total === expected) {
      return last;
    }
    if (total > expected) {
      throw new Error(`esperava ${expected} conexões bloqueadas, há ${total}`);
    }
    // uma requisição que terminou com o lock fechado não passou pela barreira (erro, 4xx…)
    const finished = settled?.() ?? 0;
    if (finished > 0) {
      throw new Error(`${finished} requisição(ões) terminaram sem esperar o lock da wallet`);
    }
    await Bun.sleep(10);
  }
  throw new Error(
    `esperava ${expected} conexões bloqueadas no lock em ${timeoutMs}ms; última leitura: ${JSON.stringify(
      Object.fromEntries(last),
    )}`,
  );
}

/** Conexões do cluster bloqueadas no `FOR UPDATE` da wallet, por `application_name`. */
export async function lockWaitersByInstance(
  orm: MikroORM,
  appNamePrefix: string,
): Promise<Map<string, number>> {
  const rows = await orm.em.fork().execute<{ app: string; n: number }[]>(
    `select application_name as app, count(*)::int as n
       from pg_stat_activity
      where datname = current_database()
        and starts_with(application_name, ?)
        and wait_event_type = 'Lock'
        and query ilike '%from "wallets"%for update%'
      group by application_name`,
    [appNamePrefix],
  );
  return new Map(rows.map((row) => [row.app, row.n]));
}

/** Conexões abertas no Postgres com esse `application_name` (para esperar o fim de uma instância morta). */
export async function backendsOf(orm: MikroORM, applicationName: string): Promise<number> {
  const rows = await orm.em.fork().execute<{ n: number }[]>(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and application_name = ?`,
    [applicationName],
  );
  return rows[0]?.n ?? 0;
}

/** Espera uma condição observável (poll com prazo, sem sleep fixo). */
export async function waitUntil(
  description: string,
  condition: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`condição não atingida em ${timeoutMs}ms: ${description}`);
}
