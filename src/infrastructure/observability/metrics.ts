import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { ClassifiedError, WagerTransactionOutcome } from '../../application';

/** Por onde a transação entrou (ou quem a resolveu, no caso do worker). */
export type MetricSource = 'http' | 'sqs' | 'pending_reference';

/** Quem agenda uma nova tentativa. */
export type RetryComponent = 'sqs_consumer' | 'outbox_publisher' | 'pending_reference';

const WAGER_KINDS: ReadonlySet<string> = new Set(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']);
const LOCK_CODES: ReadonlySet<string> = new Set(['LOCK_TIMEOUT', 'LOCK_CONFLICT']);

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LAG_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900];

/**
 * Métricas Prometheus deste processo (`GET /metrics`). Contadores e histogramas são por processo:
 * com várias instâncias, quem agrega é o Prometheus. Nada aqui é garantia de nada: a correção
 * vem do banco. Labels só com valores de um conjunto fechado (status, códigos de erro, tipo de
 * evento); nunca ids, que explodiriam a cardinalidade.
 *
 * Os gauges de backlog (outbox pendente, profundidade da DLQ) são lidos na hora do scrape e são
 * globais: réplicas do mesmo papel reportam o mesmo valor.
 */
export class WageringMetrics {
  /** Um registry por instância (e não o global do prom-client): vários apps no mesmo processo de teste. */
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Transações decididas (primeira vez; replays e reentregas ficam em wagering_duplicates_total)',
    labelNames: ['source', 'kind', 'status'] as const,
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_total',
    help: 'Duplicatas detectadas: replay por Idempotency-Key ou reentrega de mensagem já na inbox',
    labelNames: ['source', 'type'] as const,
    registers: [this.registry],
  });

  private readonly errors = new Counter({
    name: 'wagering_transaction_errors_total',
    help: 'Falhas ao processar uma transação (nada foi gravado), por categoria e código',
    labelNames: ['source', 'kind', 'code'] as const,
    registers: [this.registry],
  });

  private readonly lockFailures = new Counter({
    name: 'wagering_lock_failures_total',
    help: 'Conflitos de lock: LOCK_TIMEOUT (lock_timeout) e LOCK_CONFLICT (deadlock/serialização)',
    labelNames: ['source', 'code'] as const,
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Novas tentativas agendadas (mensagem SQS, evento da outbox, PENDING_REFERENCE)',
    labelNames: ['component', 'reason'] as const,
    registers: [this.registry],
  });

  private readonly deadLetters = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Mensagens que este consumer mandou para a DLQ (erro permanente). O redrive nativo do SQS não passa por aqui: ver wagering_dlq_depth',
    labelNames: ['code'] as const,
    registers: [this.registry],
  });

  private readonly processingDuration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Latência do processamento de uma transação (validação, transação SQL e COMMIT)',
    labelNames: ['source', 'result'] as const,
    buckets: DURATION_BUCKETS,
    registers: [this.registry],
  });

  private readonly eventsPublished = new Counter({
    name: 'wagering_outbox_events_published_total',
    help: 'Eventos da outbox aceitos pelo broker',
    labelNames: ['event_type'] as const,
    registers: [this.registry],
  });

  private readonly publishFailures = new Counter({
    name: 'wagering_outbox_publish_failures_total',
    help: 'Eventos que o broker não aceitou (voltam para a outbox com backoff)',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly outboxLag = new Histogram({
    name: 'wagering_outbox_lag_seconds',
    help: 'Tempo entre o evento ser gravado (occurredAt) e ser publicado',
    buckets: LAG_BUCKETS,
    registers: [this.registry],
  });

  private readonly divergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Reconciliações em que o saldo materializado divergiu do ledger',
    registers: [this.registry],
  });

  private readonly httpDuration = new Histogram({
    name: 'wagering_http_request_duration_seconds',
    help: 'Duração das requisições HTTP',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: DURATION_BUCKETS,
    registers: [this.registry],
  });

  private readonly collectFailures = new Counter({
    name: 'wagering_metric_collect_failures_total',
    help: 'Falhas ao ler um gauge de backlog no scrape (o gauge sai NaN)',
    labelNames: ['gauge'] as const,
    registers: [this.registry],
  });

  /** Resultado confirmado de uma submissão (HTTP ou SQS). */
  recordOutcome(
    source: Exclude<MetricSource, 'pending_reference'>,
    kind: string,
    outcome: WagerTransactionOutcome,
    durationSeconds: number,
  ): void {
    let result: string;
    if (outcome.duplicateDelivery) {
      result = 'duplicate_delivery';
      this.duplicates.inc({ source, type: result });
    } else if (outcome.idempotentReplay) {
      result = 'idempotent_replay';
      this.duplicates.inc({ source, type: result });
    } else {
      result = outcome.status;
      this.transactions.inc({ source, kind: kindLabel(kind), status: outcome.status });
    }
    this.processingDuration.observe({ source, result }, durationSeconds);
  }

  /** PENDING_REFERENCE resolvida (ou rejeitada ao esgotar as tentativas) pelo worker. */
  recordResolution(kind: string, status: string): void {
    this.transactions.inc({ source: 'pending_reference', kind: kindLabel(kind), status });
  }

  /** Processamento que lançou (rollback): validação, conflito, lock, banco fora… */
  recordFailure(source: MetricSource, error: ClassifiedError, durationSeconds?: number): void {
    this.errors.inc({ source, kind: error.kind, code: error.code });
    if (LOCK_CODES.has(error.code)) {
      this.lockFailures.inc({ source, code: error.code });
    }
    if (durationSeconds !== undefined) {
      this.processingDuration.observe({ source, result: 'error' }, durationSeconds);
    }
  }

  recordRetry(component: RetryComponent, reason: string): void {
    this.retries.inc({ component, reason });
  }

  recordDeadLetter(code: string): void {
    this.deadLetters.inc({ code });
  }

  recordEventPublished(eventType: string, lagSeconds: number): void {
    this.eventsPublished.inc({ event_type: eventType });
    this.outboxLag.observe(Math.max(lagSeconds, 0));
  }

  recordPublishFailure(reason: string): void {
    this.publishFailures.inc({ reason });
    this.retries.inc({ component: 'outbox_publisher', reason });
  }

  recordReconciliationDivergence(): void {
    this.divergences.inc();
  }

  observeHttpRequest(method: string, route: string, status: number, seconds: number): void {
    this.httpDuration.observe({ method, route, status: String(status) }, seconds);
  }

  /**
   * Gauge lido a cada scrape. Se a leitura falhar (banco ou SQS fora, timeout), o gauge sai NaN e
   * `onError` é chamado: um número velho ou zero esconderia o problema.
   */
  registerScrapeGauge(
    name: string,
    help: string,
    read: () => Promise<number>,
    onError: (error: unknown) => void,
  ): void {
    const failures = this.collectFailures;
    new Gauge({
      name,
      help,
      registers: [this.registry],
      async collect() {
        try {
          this.set(await read());
        } catch (error) {
          this.set(Number.NaN);
          failures.inc({ gauge: name });
          onError(error);
        }
      },
    });
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}

/** `kind` vem do cliente: fora dos tipos conhecidos não vira label. */
function kindLabel(kind: string): string {
  return WAGER_KINDS.has(kind) ? kind : 'OTHER';
}

export const METRICS = Symbol('METRICS');
