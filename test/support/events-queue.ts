import { randomBytes } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { testSqsClient } from './sqs';

/** Um evento como o consumidor o recebe da fila `wagering-events`. */
export interface ReceivedEvent {
  eventId: string;
  eventType: string;
  body: string;
  // biome-ignore lint/suspicious/noExplicitAny: envelope JSON livre nas asserções
  envelope: any;
  attributes: Record<string, string>;
}

/**
 * Fila standard própria de cada arquivo de teste, no lugar de `wagering-events`: os testes não
 * leem eventos uns dos outros nem os do container `app`.
 */
export class TestEventsQueue {
  private constructor(
    readonly client: SQSClient,
    readonly name: string,
    readonly url: string,
  ) {}

  static async create(): Promise<TestEventsQueue> {
    const client = testSqsClient();
    const name = `t${randomBytes(5).toString('hex')}-events`;
    const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: name }));
    if (!QueueUrl) {
      throw new Error('LocalStack não devolveu a URL da fila de eventos');
    }
    return new TestEventsQueue(client, name, QueueUrl);
  }

  /** Ambiente de um publisher (em processo ou não) apontando para esta fila. */
  publisherEnv(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      ROLE: 'outbox',
      SQS_EVENTS_QUEUE_NAME: this.name,
      OUTBOX_POLL_INTERVAL_MS: '50',
      ...overrides,
    };
  }

  /**
   * Recebe (e apaga) até ter pelo menos `expected` mensagens; depois continua lendo até a fila
   * ficar quieta, para que uma cópia a mais apareça na asserção em vez de passar despercebida.
   */
  async drain(expected: number, timeoutMs = 20_000): Promise<ReceivedEvent[]> {
    const received: ReceivedEvent[] = [];
    const deadline = Date.now() + timeoutMs;
    let quietPolls = 0;
    while (Date.now() < deadline) {
      const batch = await this.receiveBatch(received.length >= expected ? 1 : 0);
      received.push(...batch);
      if (received.length >= expected) {
        quietPolls = batch.length === 0 ? quietPolls + 1 : 0;
        if (quietPolls >= 2) {
          return received;
        }
      } else if (batch.length === 0) {
        await Bun.sleep(20);
      }
    }
    if (received.length < expected) {
      throw new Error(`esperava ${expected} eventos na fila, chegaram ${received.length}`);
    }
    return received;
  }

  async destroy(): Promise<void> {
    await this.client.send(new DeleteQueueCommand({ QueueUrl: this.url })).catch(() => undefined);
    this.client.destroy();
  }

  private async receiveBatch(waitTimeSeconds: number): Promise<ReceivedEvent[]> {
    const { Messages = [] } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitTimeSeconds,
        MessageAttributeNames: ['All'],
      }),
    );
    if (Messages.length === 0) {
      return [];
    }
    await this.client.send(
      new DeleteMessageBatchCommand({
        QueueUrl: this.url,
        Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
      }),
    );
    return Messages.map((message) => {
      const body = message.Body ?? '';
      const envelope = JSON.parse(body);
      const attributes: Record<string, string> = {};
      for (const [key, value] of Object.entries(message.MessageAttributes ?? {})) {
        if (value.StringValue !== undefined) {
          attributes[key] = value.StringValue;
        }
      }
      return {
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        body,
        envelope,
        attributes,
      };
    });
  }
}
