import { InboxMessageConflictError, InvalidFieldError, InvalidMessageStateError } from '../errors';
import { assertNonEmpty } from '../shared/assert';
import { canonicalJson, sha256Hex } from '../wager/payload-hash';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date | undefined;
}

/** O que identifica o conteúdo de uma mensagem de transação, independente do transporte. */
export interface InboxPayloadInput {
  /** `type` do envelope (ex.: `WagerTransactionRequested`). */
  messageType: string;
  idempotencyKey: string;
  /** `payloadHash` da transação (JSON canônico dos campos de negócio, amount normalizado). */
  wagerPayloadHash: string;
}

/**
 * Hash do conteúdo da mensagem gravado na inbox: SHA-256 (hex) do JSON canônico de
 * `{ type, idempotencyKey, payloadHash }`. Reaproveita o hash da transação, então "25" e "25.00"
 * dão o mesmo resultado; o `messageId`, o `occurredAt` e os metadados do SQS ficam de fora.
 */
export function computeInboxPayloadHash(input: InboxPayloadInput): string {
  return sha256Hex(
    canonicalJson({
      type: input.messageType,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.wagerPayloadHash,
    }),
  );
}

/** Registro de dedup por `(consumerName, messageId)`, gravado na mesma transação SQL do efeito. */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    assertNonEmpty('messageId', props.messageId);
    assertNonEmpty('consumerName', props.consumerName);
    if (!/^[0-9a-f]{64}$/.test(props.payloadHash)) {
      throw new InvalidFieldError('payloadHash', 'esperado SHA-256 em hex (64 caracteres)');
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
    );
  }

  /** Reconstrução a partir da persistência — não revalida. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError(`Mensagem ${this.messageId} já foi processada`);
    }
    this._processedAt = at;
  }

  /**
   * Reentrega legítima traz o mesmo conteúdo. Conteúdo diferente com o mesmo id é conflito
   * (`InboxMessageConflictError`), nunca uma segunda execução.
   */
  assertRedeliveryOf(payloadHash: string): void {
    if (this.payloadHash !== payloadHash) {
      throw new InboxMessageConflictError(this.consumerName, this.messageId);
    }
  }
}
