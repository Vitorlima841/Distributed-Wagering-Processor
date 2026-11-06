import { randomBytes, randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { type CreatedWallet, type WagerRequest, wagerBody } from './http-app';

/**
 * SQS real (LocalStack do docker compose) nos testes. Cada arquivo cria as próprias filas
 * (`t<hex>.fifo` + DLQ com redrive), espelhando `docker/localstack/init-queues.sh`: os testes não
 * disputam mensagens entre si nem com o container `app` (que roda `ROLE=all`).
 */

export const sqsEndpoint = (): string => process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

export function testSqsClient(endpoint = sqsEndpoint()): SQSClient {
  return createSqsClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    sqsEndpoint: endpoint,
  });
}

export interface QueueCounts {
  visible: number;
  inFlight: number;
}

export interface DeadLetter {
  body: string;
  groupId: string | undefined;
  attributes: Record<string, string>;
}

export class TestQueues {
  private constructor(
    readonly client: SQSClient,
    readonly name: string,
    readonly dlqName: string,
    readonly url: string,
    readonly dlqUrl: string,
    /** Nome lógico do consumer nos testes deste arquivo (escopo das linhas de inbox). */
    readonly consumerName: string,
  ) {}

  static async create({
    maxReceiveCount = 5,
    visibilityTimeoutS = 30,
  }: {
    maxReceiveCount?: number;
    visibilityTimeoutS?: number;
  } = {}): Promise<TestQueues> {
    const client = testSqsClient();
    const id = `t${randomBytes(5).toString('hex')}`;
    const dlqName = `${id}-dlq.fifo`;
    const name = `${id}.fifo`;
    const dlq = await client.send(
      new CreateQueueCommand({
        QueueName: dlqName,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
    );
    const dlqArn = (
      await client.send(
        new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
      )
    ).Attributes?.QueueArn;
    const main = await client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: String(visibilityTimeoutS),
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: String(maxReceiveCount),
          }),
        },
      }),
    );
    if (!main.QueueUrl || !dlq.QueueUrl) {
      throw new Error('LocalStack não devolveu a URL das filas');
    }
    return new TestQueues(client, name, dlqName, main.QueueUrl, dlq.QueueUrl, `consumer-${id}`);
  }

  /** Ambiente de um consumer (em processo ou não) apontando para estas filas. */
  consumerEnv(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      ROLE: 'consumer',
      SQS_WAGER_QUEUE_NAME: this.name,
      SQS_WAGER_DLQ_NAME: this.dlqName,
      SQS_CONSUMER_NAME: this.consumerName,
      // long poll curto: o shutdown aborta, mas um teste parado não segura 20s de requisição
      SQS_WAIT_TIME_SECONDS: '1',
      ...overrides,
    };
  }

  /** Envia como um produtor FIFO: grupo = wallet, dedup = messageId (salvo override). */
  async send(
    body: string,
    { groupId, deduplicationId }: { groupId: string; deduplicationId: string },
  ): Promise<string> {
    const result = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.url,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
    if (!result.MessageId) {
      throw new Error('SendMessage sem MessageId');
    }
    return result.MessageId;
  }

  sendWager(
    message: WagerMessage,
    options: { groupId?: string; deduplicationId?: string } = {},
  ): Promise<string> {
    return this.send(JSON.stringify(message.envelope), {
      groupId: options.groupId ?? message.walletId,
      deduplicationId: options.deduplicationId ?? message.messageId,
    });
  }

  counts(which: 'main' | 'dlq' = 'main'): Promise<QueueCounts> {
    return this.client
      .send(
        new GetQueueAttributesCommand({
          QueueUrl: which === 'main' ? this.url : this.dlqUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      )
      .then(({ Attributes }) => ({
        visible: Number(Attributes?.ApproximateNumberOfMessages ?? 0),
        inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
      }));
  }

  async isEmpty(which: 'main' | 'dlq' = 'main'): Promise<boolean> {
    const { visible, inFlight } = await this.counts(which);
    return visible === 0 && inFlight === 0;
  }

  /** Lê e apaga tudo o que está visível na DLQ (o "operador" inspecionando). */
  async drainDeadLetters(): Promise<DeadLetter[]> {
    const drained: DeadLetter[] = [];
    for (;;) {
      const { Messages } = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.dlqUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['MessageGroupId'],
        }),
      );
      if (!Messages || Messages.length === 0) {
        return drained;
      }
      for (const message of Messages) {
        drained.push(toDeadLetter(message));
        await this.client.send(
          new DeleteMessageCommand({ QueueUrl: this.dlqUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      }
    }
  }

  async destroy(): Promise<void> {
    await Promise.allSettled([
      this.client.send(new DeleteQueueCommand({ QueueUrl: this.url })),
      this.client.send(new DeleteQueueCommand({ QueueUrl: this.dlqUrl })),
    ]);
    this.client.destroy();
  }
}

function toDeadLetter(message: Message): DeadLetter {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.MessageAttributes ?? {})) {
    if (value.StringValue !== undefined) {
      attributes[key] = value.StringValue;
    }
  }
  return {
    body: message.Body ?? '',
    groupId: message.Attributes?.MessageGroupId,
    attributes,
  };
}

export interface WagerMessageInput extends WagerRequest {
  messageId?: string;
  type?: string;
  correlationId?: string;
}

export interface WagerMessage {
  messageId: string;
  walletId: string;
  idempotencyKey: string;
  externalTransactionId: string;
  // biome-ignore lint/suspicious/noExplicitAny: envelope JSON livre (testes também mandam lixo)
  envelope: any;
}

/** Envelope da seção 10 do desafio; `data` é o mesmo corpo do POST, mais a idempotencyKey. */
export function wagerMessage(wallet: CreatedWallet, input: WagerMessageInput): WagerMessage {
  const data = wagerBody(wallet, input);
  const externalTransactionId = data.externalTransactionId as string;
  const idempotencyKey = input.idempotencyKey ?? `${data.providerId}:${externalTransactionId}`;
  const messageId = input.messageId ?? `msg-${randomUUID()}`;
  return {
    messageId,
    walletId: wallet.id,
    idempotencyKey,
    externalTransactionId,
    envelope: {
      messageId,
      type: input.type ?? 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      data: { ...data, idempotencyKey },
    },
  };
}
