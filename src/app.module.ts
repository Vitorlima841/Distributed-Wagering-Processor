import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig, type Role } from './infrastructure/config/app-config';
import { DatabaseModule } from './infrastructure/database/database.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { ApiModule, HttpModule } from './interfaces/http/http.module';
import { UseCasesModule } from './interfaces/use-cases.module';
import {
  ConsumerModule,
  OutboxModule,
  PendingRefModule,
} from './interfaces/workers/workers.module';

const MODULES_BY_ROLE: Record<Exclude<Role, 'all'>, unknown[]> = {
  api: [ApiModule],
  consumer: [ConsumerModule],
  outbox: [OutboxModule],
  'pending-ref': [PendingRefModule],
};

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: padrão de módulo dinâmico do NestJS
export class AppModule {
  /** Monta o grafo de módulos conforme o papel (ROLE) do processo. */
  static forRole(config: AppConfig): DynamicModule {
    const roleModules =
      config.role === 'all' ? Object.values(MODULES_BY_ROLE).flat() : MODULES_BY_ROLE[config.role];
    return {
      module: AppModule,
      global: true,
      imports: [
        DatabaseModule,
        InfrastructureModule,
        UseCasesModule,
        HttpModule,
        ...(roleModules as DynamicModule[]),
      ],
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
