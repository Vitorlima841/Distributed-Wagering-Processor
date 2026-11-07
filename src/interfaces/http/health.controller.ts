import { Controller, Get, Inject, Res } from '@nestjs/common';
import {
  READINESS,
  type Readiness,
  type ReadinessReport,
} from '../../infrastructure/observability/readiness';
import type { HttpResponse } from './http-types';

/** Health checks sem autenticação (fora do `ProviderAuthGuard`). */
@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS) private readonly readiness: Readiness) {}

  /** Liveness: o processo está de pé. Não toca em dependências (banco fora não reinicia o processo). */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: 200 se o Postgres e as filas SQS de que o papel depende respondem; 503 se alguma
   * não responde ou se o processo está desligando.
   */
  @Get('ready')
  async ready(@Res() response: HttpResponse): Promise<void> {
    const report: ReadinessReport = await this.readiness.report();
    response.status(report.status === 'ready' ? 200 : 503).json(report);
  }
}
