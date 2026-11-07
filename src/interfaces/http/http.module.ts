import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RequestContextMiddleware } from './correlation';
import { HealthController } from './health.controller';
import { HttpErrorFilter } from './http-error.filter';
import { MetricsController } from './metrics.controller';
import { ProviderAuthGuard } from './provider-auth.guard';
import { WageringController } from './wagering.controller';
import { WalletsController } from './wallets.controller';

/**
 * Presente em todos os papéis: health, `/metrics`, o envelope de erro único e o contexto da
 * requisição (correlationId, log e métrica) valem para qualquer rota.
 */
@Module({
  controllers: [HealthController, MetricsController],
  providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }, RequestContextMiddleware],
})
export class HttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
  }
}

/** API de negócio (papel `api`): wallets, transações, consultas e reconciliação. */
@Module({
  controllers: [WalletsController, WageringController],
  providers: [ProviderAuthGuard],
})
export class ApiModule {}
