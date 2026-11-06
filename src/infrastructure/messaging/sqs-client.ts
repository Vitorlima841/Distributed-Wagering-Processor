import { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

/**
 * Cliente SQS da configuração. Com `SQS_ENDPOINT` (LocalStack), toda chamada vai para esse
 * endpoint: sem ele o SDK usaria o host da QueueUrl.
 */
export function createSqsClient(aws: AppConfig['aws']): SQSClient {
  return new SQSClient({
    region: aws.region,
    ...(aws.sqsEndpoint ? { endpoint: aws.sqsEndpoint } : {}),
    credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey },
  });
}

export const SQS_CLIENT = Symbol('SQS_CLIENT');

/** Um cliente por processo, compartilhado pelo consumer (fase 6) e pelo publisher (fase 7). */
@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createSqsClient(config.aws),
    },
  ],
  exports: [SQS_CLIENT],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  /** Depois do `beforeApplicationShutdown` do consumer, que ainda usa o cliente. */
  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
