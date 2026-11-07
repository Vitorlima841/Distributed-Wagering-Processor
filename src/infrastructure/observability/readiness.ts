import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig } from '../config/app-config';
import { errorCodeOf, withTimeout } from './timeout';

/** Uma dependência que o processo precisa para trabalhar. */
export interface DependencyCheck {
  name: string;
  check(signal: AbortSignal): Promise<void>;
}

export interface CheckResult {
  status: 'up' | 'down';
  durationMs: number;
  /** Só o código do erro (SQLSTATE, código do SDK, `TimeoutError`), nunca a mensagem. */
  error?: string;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready' | 'shutting_down';
  checks: Record<string, CheckResult>;
}

/**
 * Readiness (`GET /health/ready`): cada dependência do papel é checada na hora, em paralelo, com
 * prazo. Depois do início do shutdown responde `shutting_down` sem checar nada, para o balanceador
 * parar de mandar tráfego enquanto o consumer e os workers terminam o que estão fazendo.
 */
export class Readiness {
  private shuttingDown = false;

  constructor(
    private readonly checks: readonly DependencyCheck[],
    private readonly timeoutMs: number,
  ) {}

  /**
   * Chamado pelo Nest no começo do `app.close()` (antes de `beforeApplicationShutdown`, onde o
   * consumer drena as mensagens): o readiness já cai enquanto o processo termina.
   */
  onModuleDestroy(): void {
    this.shuttingDown = true;
  }

  async report(): Promise<ReadinessReport> {
    if (this.shuttingDown) {
      return { status: 'shutting_down', checks: {} };
    }
    const results = await Promise.all(
      this.checks.map(async (dependency) => [dependency.name, await this.run(dependency)] as const),
    );
    const checks = Object.fromEntries(results);
    const ready = results.every(([, result]) => result.status === 'up');
    return { status: ready ? 'ready' : 'not_ready', checks };
  }

  private async run(dependency: DependencyCheck): Promise<CheckResult> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    try {
      await withTimeout(this.timeoutMs, (signal) => dependency.check(signal));
      return { status: 'up', durationMs: elapsed() };
    } catch (error) {
      return { status: 'down', durationMs: elapsed(), error: errorCodeOf(error) };
    }
  }
}

/** `SELECT 1` numa conexão do pool. */
export function postgresCheck(orm: MikroORM): DependencyCheck {
  return {
    name: 'postgres',
    check: async () => {
      await orm.em.fork().execute('select 1');
    },
  };
}

/** As filas existem e o SQS responde (`GetQueueUrl` de cada uma). */
export function sqsCheck(client: SQSClient, queueNames: readonly string[]): DependencyCheck {
  return {
    name: 'sqs',
    check: async (signal) => {
      await Promise.all(
        queueNames.map((QueueName) =>
          client.send(new GetQueueUrlCommand({ QueueName }), { abortSignal: signal }),
        ),
      );
    },
  };
}

/**
 * Filas de que cada papel depende. `api` e `pending-ref` não usam SQS: um SQS fora do ar não os
 * impede de trabalhar, então não entram no readiness deles.
 */
export function queuesForRole(config: AppConfig): string[] {
  const { wager, wagerDlq, events } = config.queues;
  switch (config.role) {
    case 'consumer':
      return [wager, wagerDlq];
    case 'outbox':
      return [events];
    case 'all':
      return [wager, wagerDlq, events];
    case 'api':
    case 'pending-ref':
      return [];
  }
}

export const READINESS = Symbol('READINESS');
