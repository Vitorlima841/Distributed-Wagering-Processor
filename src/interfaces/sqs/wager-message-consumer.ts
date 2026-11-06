import {
  type Clock,
  classifyError,
  type ProcessWagerTransaction,
  type WagerTransactionOutcome,
} from '../../application';
import type { Logger } from '../../infrastructure/logging/logger';
import { safeErrorFields } from '../../infrastructure/logging/safe-error-fields';
import { type ConsumerDecision, decideForError, type RetryPolicy } from './consumer-decision';
import { parseWagerMessage } from './wager-message';
import type { QueueMessage, WagerQueue } from './wager-queue';

export interface WagerConsumerOptions {
  /** Nome lógico gravado na inbox (o mesmo em todas as instâncias). */
  consumerName: string;
  retry: RetryPolicy;
  /** Prazo para terminar as mensagens em andamento no shutdown. */
  shutdownTimeoutMs: number;
  /** Pausa do loop depois de uma falha de infraestrutura (SQS ou banco fora do ar). */
  idleBackoff?: { initialMs: number; maxMs: number };
}

type ProcessWager = Pick<ProcessWagerTransaction, 'execute'>;

interface Tracked {
  message: QueueMessage;
  /** Já recebeu ack, retry, DLQ ou foi devolvida: nenhuma outra operação na fila. */
  settled: boolean;
}

const DEFAULT_IDLE_BACKOFF = { initialMs: 500, maxMs: 30_000 };

/**
 * Consumer de `wager-transactions.fifo`. Chama o mesmo `ProcessWagerTransaction` do HTTP, com a
 * inbox na mesma transação SQL, e só faz ack depois que o use case volta (depois do COMMIT).
 *
 * - Lote de até 10 mensagens; grupos (walletId) em paralelo, mensagens do mesmo grupo em ordem.
 *   Se uma mensagem do grupo vai para retry, as seguintes do mesmo grupo no lote voltam com o
 *   mesmo atraso (no LocalStack, devolvê-las na hora inverteria a ordem). A ordem é otimização:
 *   a correção vem do banco (idempotência, inbox, PENDING_REFERENCE).
 * - Decisão por mensagem em `consumer-decision.ts` (ack / retry com backoff / DLQ).
 * - SQS ou banco fora do ar: o loop pausa com backoff antes de buscar mais, para não gastar
 *   tentativas de mensagens que nem chegou a receber.
 * - `stop()` (SIGTERM): não busca mais, termina a mensagem em andamento de cada grupo e devolve as
 *   que não começaram (visibilidade 0). O long poll em andamento não é cancelado: o SQS continua
 *   com a requisição aberta e entregaria mensagens a um cliente que já desistiu (elas sumiriam até
 *   o fim da visibilidade). Ele termina sozinho (até `SQS_WAIT_TIME_SECONDS`) e o que trouxer volta
 *   na hora. Estourado o prazo, cancela o long poll e devolve também as em andamento: se uma delas
 *   ainda confirmar, a reentrega cai na inbox e não repete o efeito.
 */
export class WagerMessageConsumer {
  private state: 'idle' | 'running' | 'stopping' | 'stopped' = 'idle';
  private readonly receiveAbort = new AbortController();
  private loop: Promise<void> | undefined;
  private readonly inFlight = new Map<string, Tracked>();
  private readonly idleBackoff: { initialMs: number; maxMs: number };
  private pauseMs = 0;
  private wakeUp: (() => void) | undefined;
  private infraFailureInBatch = false;
  private readonly logger: Logger;

  constructor(
    private readonly queue: WagerQueue,
    private readonly processWager: ProcessWager,
    private readonly clock: Clock,
    logger: Logger,
    private readonly options: WagerConsumerOptions,
  ) {
    this.idleBackoff = options.idleBackoff ?? DEFAULT_IDLE_BACKOFF;
    this.logger = logger.child({ component: 'sqs-consumer', consumer: options.consumerName });
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }

  start(): void {
    if (this.state !== 'idle') {
      throw new Error(`consumer não pode iniciar no estado ${this.state}`);
    }
    this.state = 'running';
    this.loop = this.run();
    this.logger.info('consumer started');
  }

  async stop(): Promise<void> {
    if (this.state !== 'running') {
      await this.loop;
      return;
    }
    this.state = 'stopping';
    this.logger.info({ inFlight: this.inFlight.size }, 'consumer stopping');
    this.wakeUp?.();
    const drained = await settlesWithin(this.loop, this.options.shutdownTimeoutMs);
    if (!drained) {
      this.receiveAbort.abort();
      const pending = [...this.inFlight.values()];
      this.logger.warn(
        { pending: pending.length, timeoutMs: this.options.shutdownTimeoutMs },
        'shutdown timeout: returning in-flight messages to the queue',
      );
      await Promise.all(pending.map((tracked) => this.release(tracked, 0)));
    }
    this.state = 'stopped';
    this.logger.info({ drained }, 'consumer stopped');
  }

  private async run(): Promise<void> {
    while (this.state === 'running') {
      let messages: QueueMessage[];
      try {
        messages = await this.queue.receive(this.receiveAbort.signal);
      } catch (error) {
        this.logger.warn({ ...safeErrorFields(error) }, 'sqs receive failed');
        await this.pause();
        continue;
      }
      if (messages.length === 0) {
        continue;
      }
      this.infraFailureInBatch = false;
      try {
        await this.handleBatch(messages);
      } catch (error) {
        // não deveria acontecer (cada mensagem trata os próprios erros); o loop não pode morrer
        this.infraFailureInBatch = true;
        this.logger.error({ ...safeErrorFields(error) }, 'unexpected error handling batch');
      }
      if (this.infraFailureInBatch) {
        await this.pause();
      } else {
        this.pauseMs = 0;
      }
    }
  }

  private async handleBatch(messages: QueueMessage[]): Promise<void> {
    const receivedAt = this.clock.now();
    const groups = new Map<string, Tracked[]>();
    for (const message of messages) {
      const tracked: Tracked = { message, settled: false };
      this.inFlight.set(message.receiptHandle, tracked);
      const key = message.groupId ?? message.sqsMessageId;
      groups.set(key, [...(groups.get(key) ?? []), tracked]);
    }
    await Promise.all([...groups.values()].map((group) => this.handleGroup(group, receivedAt)));
  }

  private async handleGroup(group: Tracked[], receivedAt: Date): Promise<void> {
    for (const [index, tracked] of group.entries()) {
      if (this.state !== 'running') {
        // shutdown: as que não começaram voltam já para a fila
        await Promise.all(group.slice(index).map((rest) => this.release(rest, 0)));
        return;
      }
      const decision = await this.handleMessage(tracked, receivedAt);
      if (decision.action === 'retry') {
        const rest = group.slice(index + 1);
        await Promise.all(rest.map((next) => this.release(next, decision.delaySeconds)));
        return;
      }
    }
  }

  private async handleMessage(tracked: Tracked, receivedAt: Date): Promise<ConsumerDecision> {
    const { message } = tracked;
    const startedAt = performance.now();
    const context: Record<string, unknown> = {
      sqsMessageId: message.sqsMessageId,
      receiveCount: message.receiveCount,
    };
    let decision: ConsumerDecision;
    try {
      const parsed = parseWagerMessage(message.body);
      Object.assign(context, {
        messageId: parsed.messageId,
        correlationId: parsed.command.correlationId,
        walletId: parsed.command.walletId,
        providerId: parsed.command.providerId,
      });
      const outcome = await this.processWager.execute(parsed.command, {
        consumerName: this.options.consumerName,
        messageId: parsed.messageId,
        messageType: parsed.type,
        receivedAt,
      });
      Object.assign(context, outcomeFields(outcome));
      decision = { action: 'ack' };
    } catch (error) {
      const classified = classifyError(error);
      decision = decideForError(classified, message.receiveCount, this.options.retry);
      Object.assign(context, { errorKind: classified.kind, errorCode: classified.code });
      if (classified.kind === 'invariant' || classified.kind === 'unknown') {
        Object.assign(context, safeErrorFields(error));
      }
      if (classified.code === 'DATABASE_UNAVAILABLE') {
        this.infraFailureInBatch = true;
      }
    }

    const applied = await this.apply(tracked, decision);
    const fields = {
      ...context,
      decision: decision.action,
      ...(decision.action === 'retry' ? { delaySeconds: decision.delaySeconds } : {}),
      applied,
      durationMs: Math.round(performance.now() - startedAt),
    };
    if (decision.action === 'dead-letter') {
      this.logger.error(fields, 'message sent to dead-letter queue');
    } else if (decision.action === 'retry') {
      this.logger.warn(fields, 'message will be retried');
    } else {
      this.logger.info(fields, 'message processed');
    }
    return decision;
  }

  private apply(tracked: Tracked, decision: ConsumerDecision): Promise<boolean> {
    switch (decision.action) {
      case 'ack':
        return this.settle(tracked, 'ack', () => this.queue.ack(tracked.message));
      case 'retry':
        return this.release(tracked, decision.delaySeconds);
      case 'dead-letter':
        return this.settle(tracked, 'dead-letter', () =>
          this.queue.deadLetter(tracked.message, { kind: decision.kind, code: decision.code }),
        );
    }
  }

  private release(tracked: Tracked, delaySeconds: number): Promise<boolean> {
    return this.settle(tracked, 'change-visibility', () =>
      this.queue.retryAfter(tracked.message, delaySeconds),
    );
  }

  /**
   * Uma única operação de fila por recebimento. Falha do SQS só atrasa: sem ack, a mensagem
   * volta depois da visibilidade e a inbox impede um segundo efeito.
   */
  private async settle(
    tracked: Tracked,
    operation: string,
    run: () => Promise<void>,
  ): Promise<boolean> {
    if (tracked.settled) {
      return false;
    }
    tracked.settled = true;
    this.inFlight.delete(tracked.message.receiptHandle);
    try {
      await run();
      return true;
    } catch (error) {
      this.infraFailureInBatch = true;
      this.logger.warn(
        { sqsMessageId: tracked.message.sqsMessageId, operation, ...safeErrorFields(error) },
        'sqs operation failed',
      );
      return false;
    }
  }

  /** Espera com backoff exponencial; `stop()` acorda na hora. */
  private pause(): Promise<void> {
    this.pauseMs =
      this.pauseMs === 0
        ? this.idleBackoff.initialMs
        : Math.min(this.pauseMs * 2, this.idleBackoff.maxMs);
    if (this.state !== 'running') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wakeUp = undefined;
        resolve();
      };
      const timer = setTimeout(done, this.pauseMs);
      this.wakeUp = done;
    });
  }
}

function outcomeFields(outcome: WagerTransactionOutcome): Record<string, unknown> {
  return {
    transactionId: outcome.transactionId,
    status: outcome.status,
    idempotentReplay: outcome.idempotentReplay,
    duplicateDelivery: outcome.duplicateDelivery ?? false,
    ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
  };
}

/** true se a promessa terminou dentro do prazo. */
async function settlesWithin(
  promise: Promise<void> | undefined,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([(promise ?? Promise.resolve()).then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
