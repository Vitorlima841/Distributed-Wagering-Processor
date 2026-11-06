import { InvalidFieldError, InvalidMessageStateError } from '../errors';
import { assertNonEmpty } from '../shared/assert';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date | undefined;
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
}
