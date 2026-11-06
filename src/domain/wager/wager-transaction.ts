import {
  IdempotencyConflictError,
  InvalidAmountError,
  InvalidFailureCodeError,
  InvalidFieldError,
  InvalidTransactionKindError,
  InvalidTransactionStateError,
  MissingReferenceError,
} from '../errors';
import type { Money } from '../money/money';
import { assertNonEmpty } from '../shared/assert';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { BUSINESS_FAILURE_CODES, FailureCode } from './failure-code';
import { computeWagerPayloadHash } from './payload-hash';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED', // terminal
  Rejected = 'REJECTED', // terminal
  Failed = 'FAILED', // terminal
}

const Kind = WagerTransactionKind;
const Status = WagerTransactionStatus;

/** Backoff do reprocessamento de referência: 1s, 2s, 4s… com teto de 60s. */
const REFERENCE_BACKOFF_BASE_MS = 1_000;
const REFERENCE_BACKOFF_CAP_MS = 60_000;

export const INTERNAL_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  /**
   * Correlação da requisição/mensagem que criou a transação. Metadado: não entra no payloadHash,
   * mas é guardado para os eventos emitidos depois (worker de PENDING_REFERENCE).
   */
  correlationId?: string;
  now: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  correlationId?: string;
  now: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Snapshot do saldo observado na resolução (usado no replay idempotente). */
  balanceAfter?: Money;
  referenceAttempts: number;
  nextAttemptAt?: Date;
  correlationId?: string;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _balanceAfter: Money | undefined,
    private _referenceAttempts: number,
    private _nextAttemptAt: Date | undefined,
    /** Correlação da origem (metadado; fora do payloadHash e imutável). */
    public readonly correlationId: string | undefined,
  ) {}

  /** Nasce em PENDING. OPENING é interno e não pode ser criado por aqui. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const submittable = [Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback];
    if (!submittable.includes(props.kind)) {
      throw new InvalidTransactionKindError(String(props.kind));
    }
    assertNonEmpty('id', props.id);
    assertNonEmpty('providerId', props.providerId);
    assertNonEmpty('externalTransactionId', props.externalTransactionId);
    assertNonEmpty('idempotencyKey', props.idempotencyKey);
    assertNonEmpty('playerId', props.playerId);
    assertNonEmpty('walletId', props.walletId);
    assertNonEmpty('roundId', props.roundId);
    assertNonEmpty('gameId', props.gameId);

    const reference = props.referenceExternalTransactionId;
    if (props.kind === Kind.Refund || props.kind === Kind.Rollback) {
      if (reference === undefined || reference === null || reference === '') {
        throw new MissingReferenceError(props.kind);
      }
    }
    if (reference !== undefined && reference !== null) {
      assertNonEmpty('referenceExternalTransactionId', reference);
      if (props.kind === Kind.Bet) {
        throw new InvalidFieldError('referenceExternalTransactionId', 'BET não aceita referência');
      }
    }
    // LOSS não move saldo e pode vir com 0.00; os demais exigem valor positivo.
    if (props.kind !== Kind.Loss && !props.money.isPositive()) {
      throw new InvalidAmountError(`${props.kind} exige valor positivo, recebido ${props.money}`);
    }
    return WagerTransaction.build({
      ...props,
      referenceExternalTransactionId: reference ?? undefined,
    });
  }

  /** Crédito de abertura da wallet: interno, chave `opening:{walletId}`. */
  static opening(props: CreateOpeningTransactionProps): WagerTransaction {
    assertNonEmpty('id', props.id);
    assertNonEmpty('walletId', props.walletId);
    assertNonEmpty('playerId', props.playerId);
    if (!props.money.isPositive()) {
      throw new InvalidAmountError(`OPENING exige valor positivo, recebido ${props.money}`);
    }
    const key = `opening:${props.walletId}`;
    return WagerTransaction.build({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: key,
      idempotencyKey: key,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: 'opening',
      gameId: INTERNAL_PROVIDER_ID,
      kind: Kind.Opening,
      money: props.money,
      ...(props.correlationId === undefined ? {} : { correlationId: props.correlationId }),
      now: props.now,
    });
  }

  /** Reconstrução a partir da persistência — não revalida regras de transição. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfter,
      state.referenceAttempts,
      state.nextAttemptAt,
      state.correlationId,
    );
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const payloadHash = computeWagerPayloadHash({
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId: props.referenceExternalTransactionId,
    });
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.now,
      Status.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      props.correlationId,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  /** Momento em que a transação chegou a um estado terminal. */
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)

  markProcessed(referenceTransactionId: string | undefined, balanceAfter: Money, at: Date): void {
    this.assertOpen('markProcessed');
    this._status = Status.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this.finish(at);
  }

  /** PENDING → PENDING_REFERENCE. A primeira tentativa fica agendada para 1s depois. */
  markPendingReference(observedBalance: Money, now: Date): void {
    if (this._status !== Status.Pending || !this.requiresReference()) {
      throw new InvalidTransactionStateError(this._status, `markPendingReference (${this.kind})`);
    }
    this._status = Status.PendingReference;
    this._balanceAfter = observedBalance;
    this._referenceAttempts = 0;
    this._nextAttemptAt = new Date(now.getTime() + referenceBackoffMs(0));
  }

  /** Registra uma tentativa sem sucesso e agenda a próxima com backoff exponencial. */
  scheduleReferenceRetry(now: Date): void {
    if (this._status !== Status.PendingReference) {
      throw new InvalidTransactionStateError(this._status, 'scheduleReferenceRetry');
    }
    this._referenceAttempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + referenceBackoffMs(this._referenceAttempts));
  }

  /** PENDING_REFERENCE com a próxima tentativa vencida (o worker confere de novo depois do lock). */
  isReferenceRetryDue(now: Date): boolean {
    return (
      this._status === Status.PendingReference &&
      this._nextAttemptAt !== undefined &&
      this._nextAttemptAt <= now
    );
  }

  hasExhaustedReferenceAttempts(maxAttempts: number): boolean {
    return this._referenceAttempts >= maxAttempts;
  }

  reject(code: FailureCode, observedBalance: Money, at: Date): void {
    this.assertOpen('reject');
    if (!BUSINESS_FAILURE_CODES.includes(code)) {
      throw new InvalidFailureCodeError(
        `reject() não aceita ${code}; use fail() para erro de infraestrutura`,
      );
    }
    this._status = Status.Rejected;
    this._failureCode = code;
    this._balanceAfter = observedBalance;
    this.finish(at);
  }

  fail(code: FailureCode, at: Date): void {
    this.assertOpen('fail');
    if (code !== FailureCode.InfraPermanentError) {
      throw new InvalidFailureCodeError(
        `fail() só aceita ${FailureCode.InfraPermanentError}, recebido ${code}`,
      );
    }
    this._status = Status.Failed;
    this._failureCode = code;
    this.finish(at);
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return (
      this._status === Status.Processed ||
      this._status === Status.Rejected ||
      this._status === Status.Failed
    );
  }

  /** LOSS registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== Kind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === Kind.Refund || this.kind === Kind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Mesma key com payload diferente é conflito, não replay. */
  assertReplayOf(payloadHash: string): void {
    if (!this.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(this.idempotencyKey);
    }
  }

  /**
   * Direção do lançamento no ledger. BET debita; WIN, REFUND e OPENING creditam;
   * ROLLBACK é o inverso da direção da referência (BET, WIN ou REFUND).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Win:
      case Kind.Refund:
      case Kind.Opening:
        return LedgerDirection.Credit;
      case Kind.Loss:
        throw new InvalidTransactionStateError(
          this._status,
          'ledgerDirectionFor (LOSS não move saldo)',
        );
      case Kind.Rollback: {
        if (!reference) {
          throw new MissingReferenceError(Kind.Rollback);
        }
        if (
          reference.kind !== Kind.Bet &&
          reference.kind !== Kind.Win &&
          reference.kind !== Kind.Refund
        ) {
          throw new InvalidTransactionKindError(reference.kind);
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  private assertOpen(attempted: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, attempted);
    }
  }

  private finish(at: Date): void {
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }
}

function referenceBackoffMs(attempts: number): number {
  return Math.min(REFERENCE_BACKOFF_CAP_MS, REFERENCE_BACKOFF_BASE_MS * 2 ** attempts);
}
