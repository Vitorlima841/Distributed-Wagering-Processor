import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { CorrelationIdInterceptor } from './correlation';
import { HealthController } from './health.controller';
import { HttpErrorFilter } from './http-error.filter';
import { ProviderAuthGuard } from './provider-auth.guard';
import { WageringController } from './wagering.controller';
import { WalletsController } from './wallets.controller';

/**
 * Presente em todos os papéis: health (e, depois, /metrics), o envelope de erro único e o
 * correlationId valem para qualquer rota.
 */
@Module({
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    { provide: APP_INTERCEPTOR, useClass: CorrelationIdInterceptor },
  ],
})
export class HttpModule {}

/** API de negócio (papel `api`): wallets, transações, consultas e reconciliação. */
@Module({
  controllers: [WalletsController, WageringController],
  providers: [ProviderAuthGuard],
})
export class ApiModule {}
