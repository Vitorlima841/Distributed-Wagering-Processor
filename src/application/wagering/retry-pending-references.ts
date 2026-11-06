import { DEFAULT_MAX_REFERENCE_ATTEMPTS, type FailureCode } from '../../domain';
import type { Clock, IdGenerator, PendingReferenceCandidate, UnitOfWork } from '../ports';
import { applyWager } from './apply-wager';

export interface RetryPendingReferencesOptions {
  /** Candidatos lidos por ciclo. */
  batchSize: number;
  /** Tentativas antes de REJECTED / REFERENCE_NOT_FOUND (ARCHITECTURE §19). */
  maxAttempts?: number;
}

export type PendingReferenceRetryOutcome =
  | { transactionId: string; outcome: 'PROCESSED' }
  | { transactionId: string; outcome: 'REJECTED'; failureCode: FailureCode }
  | { transactionId: string; outcome: 'PENDING_REFERENCE'; attempts: number; nextAttemptAt: Date }
  /** Outro worker (ou o próprio relógio) já tirou a transação da fila depois da leitura. */
  | { transactionId: string; outcome: 'SKIPPED' };

export interface PendingReferenceRetryError {
  transactionId: string;
  error: unknown;
}

export interface RetryPendingReferencesSummary {
  candidates: number;
  results: PendingReferenceRetryOutcome[];
  /** Falhas por candidato (ex.: lock timeout): nada foi gravado, e ele volta no próximo ciclo. */
  errors: PendingReferenceRetryError[];
}

/**
 * Worker de PENDING_REFERENCE (desafio §7.1, ARCHITECTURE §19). Reutiliza o núcleo do use case
 * (`applyWager` com `isNew: false`): referência, regra de negócio, saldo, ledger e outbox na
 * mesma transação SQL.
 *
 * Por candidato, numa transação:
 *  1. `FOR UPDATE` na wallet (ordem de lock: wallet antes da transação, como no use case);
 *  2. `FOR UPDATE` na transação;
 *  3. ainda PENDING_REFERENCE e vencida? Senão, outro worker já tratou: pula. Isso impede que
 *     dois workers contem a mesma tentativa duas vezes;
 *  4. `applyWager`: PROCESSED, REJECTED (inclusive REFERENCE_NOT_FOUND ao esgotar as tentativas,
 *     com `WagerTransactionRejected`) ou nova tentativa agendada com backoff.
 */
export class RetryPendingReferences {
  private readonly maxAttempts: number;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: RetryPendingReferencesOptions,
  ) {
    if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
      throw new Error('batchSize deve ser um inteiro positivo');
    }
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_REFERENCE_ATTEMPTS;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts <= 0) {
      throw new Error('maxAttempts deve ser um inteiro positivo');
    }
  }

  /** Um ciclo: lê os candidatos vencidos e tenta cada um na sua própria transação. */
  async runOnce(): Promise<RetryPendingReferencesSummary> {
    const now = this.clock.now();
    const candidates = await this.uow.run((scope) =>
      scope.transactions.findDuePendingReferences(now, this.options.batchSize),
    );
    const results: PendingReferenceRetryOutcome[] = [];
    const errors: PendingReferenceRetryError[] = [];
    for (const candidate of candidates) {
      try {
        results.push(await this.retry(candidate));
      } catch (error) {
        errors.push({ transactionId: candidate.transactionId, error });
      }
    }
    return { candidates: candidates.length, results, errors };
  }

  /** Reprocessa um candidato numa transação própria. */
  retry(candidate: PendingReferenceCandidate): Promise<PendingReferenceRetryOutcome> {
    const { transactionId } = candidate;
    return this.uow.run(async (scope) => {
      const wallet = await scope.wallets.findByIdForUpdate(candidate.walletId);
      const tx = wallet ? await scope.transactions.findByIdForUpdate(transactionId) : undefined;
      // o relógio é lido depois dos locks: quem esperou outro worker enxerga o agendamento novo
      const now = this.clock.now();
      if (!wallet || !tx || tx.walletId !== wallet.id || !tx.isReferenceRetryDue(now)) {
        return { transactionId, outcome: 'SKIPPED' };
      }
      const result = await applyWager(scope, this.ids, {
        wallet,
        transaction: tx,
        isNew: false,
        now,
        // a correlação da requisição original; transações anteriores à coluna usam o próprio id
        correlation: { correlationId: tx.correlationId ?? tx.id },
        maxReferenceAttempts: this.maxAttempts,
      });
      switch (result.outcome) {
        case 'PROCESSED':
          return { transactionId, outcome: 'PROCESSED' };
        case 'REJECTED':
          return { transactionId, outcome: 'REJECTED', failureCode: result.failureCode };
        case 'PENDING_REFERENCE':
          return {
            transactionId,
            outcome: 'PENDING_REFERENCE',
            attempts: tx.referenceAttempts,
            nextAttemptAt: tx.nextAttemptAt ?? now,
          };
      }
    });
  }
}
