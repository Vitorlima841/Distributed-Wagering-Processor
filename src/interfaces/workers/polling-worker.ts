import type { Logger } from '../../infrastructure/logging/logger';
import { safeErrorFields } from '../../infrastructure/logging/safe-error-fields';

export interface PollingWorkerOptions {
  /** Espera entre ciclos quando o ciclo anterior não encontrou trabalho (ou não encheu o lote). */
  pollIntervalMs: number;
  /** Pausa depois de um ciclo que falhou inteiro (banco fora do ar): dobra até o máximo. */
  failureBackoff?: { initialMs: number; maxMs: number };
}

export interface CycleResult {
  /** true: o lote veio cheio, roda o próximo ciclo sem esperar. */
  busy: boolean;
}

const DEFAULT_FAILURE_BACKOFF = { initialMs: 500, maxMs: 30_000 };

/**
 * Loop de um worker agendado (outbox publisher, PENDING_REFERENCE). Nada de estado de negócio em
 * memória: cada ciclo lê do banco o que está vencido, então qualquer instância pode assumir.
 *
 * - Lote cheio → próximo ciclo na hora; senão espera `pollIntervalMs`.
 * - Ciclo que lança (banco fora do ar) → log e pausa com backoff; o loop não morre.
 * - `stop()` (SIGTERM): não começa outro ciclo e espera o ciclo em andamento terminar. Um ciclo é
 *   uma ou mais transações curtas; o que não confirmou é desfeito e outra instância refaz.
 */
export class PollingWorker {
  private state: 'idle' | 'running' | 'stopping' | 'stopped' = 'idle';
  private loop: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;
  private failurePauseMs = 0;
  private readonly failureBackoff: { initialMs: number; maxMs: number };

  constructor(
    private readonly name: string,
    private readonly cycle: () => Promise<CycleResult>,
    private readonly logger: Logger,
    private readonly options: PollingWorkerOptions,
  ) {
    this.failureBackoff = options.failureBackoff ?? DEFAULT_FAILURE_BACKOFF;
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }

  start(): void {
    if (this.state !== 'idle') {
      throw new Error(`${this.name} não pode iniciar no estado ${this.state}`);
    }
    this.state = 'running';
    this.loop = this.run();
    this.logger.info('worker started');
  }

  async stop(): Promise<void> {
    if (this.state === 'idle') {
      this.state = 'stopped';
      return;
    }
    if (this.state === 'running') {
      this.state = 'stopping';
      this.wakeUp?.();
    }
    await this.loop;
    this.state = 'stopped';
    this.logger.info('worker stopped');
  }

  private async run(): Promise<void> {
    while (this.state === 'running') {
      let busy = false;
      try {
        ({ busy } = await this.cycle());
        this.failurePauseMs = 0;
      } catch (error) {
        this.failurePauseMs = Math.min(
          this.failureBackoff.maxMs,
          this.failurePauseMs === 0 ? this.failureBackoff.initialMs : this.failurePauseMs * 2,
        );
        this.logger.warn(
          { ...safeErrorFields(error), pauseMs: this.failurePauseMs },
          'worker cycle failed',
        );
        await this.sleep(this.failurePauseMs);
        continue;
      }
      if (!busy) {
        await this.sleep(this.options.pollIntervalMs);
      }
    }
  }

  /** Espera interrompível pelo `stop()`. */
  private sleep(ms: number): Promise<void> {
    if (this.state !== 'running') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done(): void {
        clearTimeout(timer);
        self.wakeUp = undefined;
        resolve();
      }
      this.wakeUp = done;
    });
  }
}
