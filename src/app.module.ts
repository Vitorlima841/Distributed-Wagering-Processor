import { type DynamicModule, Module } from '@nestjs/common';
import type { DestinationStream } from 'pino';
import { APP_CONFIG, type AppConfig, type Role } from './infrastructure/config/app-config';
import { DatabaseModule } from './infrastructure/database/database.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { LOG_DESTINATION } from './infrastructure/logging/logger';
import { MessagingModule } from './infrastructure/messaging/sqs-client';
import { ApiModule, HttpModule } from './interfaces/http/http.module';
import { ConsumerModule } from './interfaces/sqs/consumer.module';
import { UseCasesModule } from './interfaces/use-cases.module';
import { OutboxModule, PendingRefModule } from './interfaces/workers/workers.module';

const MODULES_BY_ROLE: Record<Exclude<Role, 'all'>, unknown[]> = {
  api: [ApiModule],
  consumer: [ConsumerModule],
  outbox: [OutboxModule],
  'pending-ref': [PendingRefModule],
};

export interface AppModuleOptions {
  /** Destino dos logs JSON (os testes capturam as linhas); padrão: stdout. */
  logDestination?: DestinationStream;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: padrão de módulo dinâmico do NestJS
export class AppModule {
  /** Monta o grafo de módulos conforme o papel (ROLE) do processo. */
  static forRole(config: AppConfig, options: AppModuleOptions = {}): DynamicModule {
    const roleModules =
      config.role === 'all' ? Object.values(MODULES_BY_ROLE).flat() : MODULES_BY_ROLE[config.role];
    return {
      module: AppModule,
      global: true,
      imports: [
        DatabaseModule,
        InfrastructureModule,
        MessagingModule,
        UseCasesModule,
        HttpModule,
        ...(roleModules as DynamicModule[]),
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOG_DESTINATION, useValue: options.logDestination ?? null },
      ],
      exports: [APP_CONFIG, LOG_DESTINATION],
    };
  }
}
