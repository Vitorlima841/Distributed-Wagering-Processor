import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { DeadLetterReason, QueueMessage, WagerQueue } from '../../interfaces/sqs/wager-queue';

export interface SqsWagerQueueOptions {
  queueName: string;
  deadLetterQueueName: string;
  waitTimeSeconds: number;
  maxMessages: number;
  visibilityTimeoutS: number;
}

interface QueueUrls {
  main: string;
  deadLetter: string;
}

/** Atributos que acompanham a cópia na DLQ (o corpo segue intacto, para reprocessar depois). */
export const DEAD_LETTER_ATTRIBUTES = {
  kind: 'failure-kind',
  code: 'failure-code',
  sourceMessageId: 'source-message-id',
  receiveCount: 'receive-count',
} as const;

/** `wager-transactions.fifo` e a sua DLQ sobre o SDK da AWS (SQS real ou LocalStack). */
export class SqsWagerQueue implements WagerQueue {
  private urls: Promise<QueueUrls> | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly options: SqsWagerQueueOptions,
  ) {}

  async receive(signal: AbortSignal): Promise<QueueMessage[]> {
    if (signal.aborted) {
      return [];
    }
    const { main } = await this.queueUrls();
    try {
      const result = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: main,
          MaxNumberOfMessages: this.options.maxMessages,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          VisibilityTimeout: this.options.visibilityTimeoutS,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        { abortSignal: signal },
      );
      return (result.Messages ?? []).flatMap(toQueueMessage);
    } catch (error) {
      // shutdown: o long poll foi cancelado; o que o SQS tenha separado volta depois da visibilidade
      if (signal.aborted) {
        return [];
      }
      throw error;
    }
  }

  async ack(message: QueueMessage): Promise<void> {
    const { main } = await this.queueUrls();
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: main, ReceiptHandle: message.receiptHandle }),
    );
  }

  async retryAfter(message: QueueMessage, seconds: number): Promise<void> {
    const { main } = await this.queueUrls();
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: main,
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  /**
   * Envia e depois apaga: não é atômico. Se o processo morrer entre os dois, a reentrega cai no
   * mesmo erro e envia de novo com o mesmo `MessageDeduplicationId` (o MessageId do SQS, que não
   * muda entre reentregas): a dedup do FIFO descarta a cópia dentro da janela de 5 minutos.
   */
  async deadLetter(message: QueueMessage, reason: DeadLetterReason): Promise<void> {
    const { main, deadLetter } = await this.queueUrls();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: deadLetter,
        MessageBody: message.body,
        MessageGroupId: message.groupId ?? message.sqsMessageId,
        MessageDeduplicationId: message.sqsMessageId,
        MessageAttributes: {
          [DEAD_LETTER_ATTRIBUTES.kind]: { DataType: 'String', StringValue: reason.kind },
          [DEAD_LETTER_ATTRIBUTES.code]: { DataType: 'String', StringValue: reason.code },
          [DEAD_LETTER_ATTRIBUTES.sourceMessageId]: {
            DataType: 'String',
            StringValue: message.sqsMessageId,
          },
          [DEAD_LETTER_ATTRIBUTES.receiveCount]: {
            DataType: 'Number',
            StringValue: String(message.receiveCount),
          },
        },
      }),
    );
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: main, ReceiptHandle: message.receiptHandle }),
    );
  }

  /**
   * Mensagens na DLQ (visíveis + em voo), para o gauge `wagering_dlq_depth`. Conta também as que
   * o redrive nativo do SQS moveu, que o consumer nunca vê. Valor aproximado (atributo do SQS).
   */
  async deadLetterDepth(signal?: AbortSignal): Promise<number> {
    const { deadLetter } = await this.queueUrls();
    const { Attributes } = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: deadLetter,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
      signal ? { abortSignal: signal } : {},
    );
    return (
      Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
      Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
    );
  }

  /** Resolvidas uma vez; uma falha (SQS fora do ar) é tentada de novo na próxima chamada. */
  private queueUrls(): Promise<QueueUrls> {
    if (!this.urls) {
      const pending = Promise.all([
        this.urlOf(this.options.queueName),
        this.urlOf(this.options.deadLetterQueueName),
      ]).then(([main, deadLetter]) => ({ main, deadLetter }));
      pending.catch(() => {
        if (this.urls === pending) {
          this.urls = undefined;
        }
      });
      this.urls = pending;
    }
    return this.urls;
  }

  private async urlOf(queueName: string): Promise<string> {
    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (!QueueUrl) {
      throw new Error(`Fila ${queueName} sem URL`);
    }
    return QueueUrl;
  }
}

function toQueueMessage(message: Message): QueueMessage[] {
  if (!message.MessageId || !message.ReceiptHandle) {
    return [];
  }
  const count = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
  return [
    {
      sqsMessageId: message.MessageId,
      receiptHandle: message.ReceiptHandle,
      body: message.Body ?? '',
      groupId: message.Attributes?.MessageGroupId,
      receiveCount: Number.isInteger(count) && count > 0 ? count : 1,
    },
  ];
}
