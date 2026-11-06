import { afterAll, afterEach, beforeAll } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Cluster } from './cluster';
import { expectConsistentWallets } from './consistency';
import { createTestOrm } from './database';
import { type CreatedWallet, createWallet, type TestResponse } from './http-app';
import { holdWalletLock, waitForWalletLockWaiters } from './sync';

/** Prazo dos testes de concorrência (sobem processos e disparam centenas de requisições). */
export const CONCURRENCY_TIMEOUT_MS = 60_000;

export interface ConcurrencySuite {
  readonly cluster: Cluster;
  /** Conexão própria do teste: barreira de lock e leituras diretas no Postgres. */
  readonly orm: MikroORM;
  /** Cria a wallet pela API (instância `via`) e a inclui na checagem final. */
  openWallet(initial: string, via?: number): Promise<CreatedWallet>;
  /** Inclui na checagem final uma wallet criada por outro caminho. */
  track(walletId: string): void;
}

/**
 * Registra os hooks de uma suíte de concorrência: sobe o cluster (3 instâncias por padrão) e a
 * conexão do teste, e depois de cada teste confere a consistência de todas as wallets usadas
 * (`expectConsistentWallets`, que inclui `wallet.balance == saldo reconstruído pelo ledger`).
 */
export function useConcurrencySuite({ size = 3 }: { size?: number } = {}): ConcurrencySuite {
  let cluster: Cluster | undefined;
  let orm: MikroORM | undefined;
  const wallets = new Set<string>();

  const required = <T>(value: T | undefined, name: string): T => {
    if (value === undefined) {
      throw new Error(`${name} não foi iniciado (beforeAll falhou?)`);
    }
    return value;
  };

  beforeAll(async () => {
    [orm, cluster] = await Promise.all([createTestOrm(), Cluster.start({ size })]);
  }, CONCURRENCY_TIMEOUT_MS);

  afterEach(async () => {
    try {
      await expectConsistentWallets(required(orm, 'orm'), wallets);
    } finally {
      wallets.clear();
    }
  }, CONCURRENCY_TIMEOUT_MS);

  afterAll(async () => {
    await cluster?.stop();
    await orm?.close(true);
  }, CONCURRENCY_TIMEOUT_MS);

  return {
    get cluster() {
      return required(cluster, 'cluster');
    },
    get orm() {
      return required(orm, 'orm');
    },
    async openWallet(initial, via = 0) {
      const wallet = await createWallet(required(cluster, 'cluster').pick(via), initial);
      wallets.add(wallet.id);
      return wallet;
    },
    track(walletId) {
      wallets.add(walletId);
    },
  };
}

export interface BarrierResult {
  responses: TestResponse[];
  /** Quantas requisições de cada instância esperavam o lock ao mesmo tempo. */
  waitersByInstance: Map<string, number>;
}

/**
 * Dispara todas as requisições com a wallet travada pelo teste, espera até TODAS estarem paradas
 * no `FOR UPDATE` da wallet ao mesmo tempo (prova de simultaneidade, lida no `pg_stat_activity`)
 * e só então solta o lock. O lock é solto mesmo se algo falhar no meio.
 */
export async function fireThroughWalletLock(
  suite: ConcurrencySuite,
  walletId: string,
  requests: readonly (() => Promise<TestResponse>)[],
): Promise<BarrierResult> {
  const lock = await holdWalletLock(suite.orm, walletId);
  let settled = 0;
  let pending: Promise<TestResponse>[] = [];
  try {
    pending = requests.map((send) =>
      send().finally(() => {
        settled += 1;
      }),
    );
    const waitersByInstance = await waitForWalletLockWaiters(
      suite.orm,
      `${suite.cluster.id}-`,
      requests.length,
      { settled: () => settled },
    );
    await lock.release();
    return { responses: await Promise.all(pending), waitersByInstance };
  } finally {
    await lock.release();
    await Promise.allSettled(pending);
  }
}

/** Contagem de status HTTP, para asserções independentes da ordem. */
export function statusCounts(responses: readonly TestResponse[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const { status } of responses) {
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}
