import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** Presente em todos os papéis: todo processo expõe health (e, depois, /metrics). */
@Module({ controllers: [HealthController] })
export class HttpModule {}
