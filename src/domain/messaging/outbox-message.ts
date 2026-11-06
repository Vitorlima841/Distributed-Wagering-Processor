import { InvalidMessageStateError } from '../errors';
import { deepFreeze, type IntegrationEvent } from '../events/integration-event';

/** Backoff de publicação: 1s, 2s, 4s… com teto de 60s (sem jitter: determinístico e testável). */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da mensagem é o eventId (consumidores deduplicam por ele). Vence assim que o evento ocorre. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      deepFreeze(envelope),
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
    );
  }

  /** Reconstrução a partir da persistência — não revalida. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`Mensagem ${this.id} já foi publicada`);
    }
    this._publishedAt = at;
  }

  /** Incrementa `attempts` e calcula o próximo `nextAttemptAt` (backoff exponencial com teto). */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`Mensagem ${this.id} já foi publicada; não há retry`);
    }
    this._attempts += 1;
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (this._attempts - 1));
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
