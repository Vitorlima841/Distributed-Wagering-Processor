import { Controller, Get, Inject, Res } from '@nestjs/common';
import { METRICS, type WageringMetrics } from '../../infrastructure/observability/metrics';
import type { HttpResponse } from './http-types';

/**
 * `GET /metrics` no formato de texto do Prometheus, em todos os papéis, sem autenticação (como o
 * health; ARCHITECTURE §11). As métricas são deste processo.
 */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: WageringMetrics) {}

  @Get()
  async scrape(@Res() response: HttpResponse): Promise<void> {
    const body = await this.metrics.metrics();
    response.setHeader('Content-Type', this.metrics.contentType);
    response.status(200).send(body);
  }
}
