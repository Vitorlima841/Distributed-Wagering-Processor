import {
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestMiddleware,
} from '@nestjs/common';
import { ID_GENERATOR, type IdGenerator } from '../../application';
import { type LogContext, runWithLogContext } from '../../infrastructure/logging/log-context';
import { LOGGER, type Logger } from '../../infrastructure/logging/logger';
import { METRICS, type WageringMetrics } from '../../infrastructure/observability/metrics';
import type { HttpRequest, HttpResponse } from './http-types';

export const CORRELATION_HEADER = 'X-Correlation-Id';
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CORRELATION_ID = Symbol('correlationId');

/** Rotas de infraestrutura: log em `debug` (o scrape e o probe rodam a cada poucos segundos). */
const QUIET_ROUTES: ReadonlySet<string> = new Set(['/health/live', '/health/ready', '/metrics']);

type RequestWithCorrelation = HttpRequest & { [CORRELATION_ID]?: string };

/**
 * `X-Correlation-Id` do cliente (se válido) ou um id novo; calculado uma vez por requisição e
 * reaproveitado pelo controller, pelos eventos da outbox, pelos logs e pelo filtro de erros.
 */
export function correlationIdOf(request: HttpRequest, ids: IdGenerator): string {
  const req = request as RequestWithCorrelation;
  if (req[CORRELATION_ID] === undefined) {
    const header = req.headers[CORRELATION_HEADER.toLowerCase()];
    req[CORRELATION_ID] =
      typeof header === 'string' && VALID_CORRELATION_ID.test(header) ? header : ids.newId();
  }
  return req[CORRELATION_ID];
}

/**
 * Primeira coisa de toda requisição (inclusive rota inexistente):
 *  - resolve o correlationId e o devolve no header da resposta;
 *  - abre o contexto de log da requisição: tudo o que for logado até a resposta sai com o
 *    `correlationId` e com o que o controller acrescentar (`walletId`, `transactionId`…);
 *  - no fim, um log `request completed` (método, rota modelo, status, duração) e a métrica
 *    `wagering_http_request_duration_seconds`. A URL crua não é logada: a query pode trazer cursor.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: WageringMetrics,
  ) {}

  use(request: HttpRequest, response: HttpResponse, next: () => void): void {
    const correlationId = correlationIdOf(request, this.ids);
    response.setHeader(CORRELATION_HEADER, correlationId);
    const context: LogContext = { correlationId };
    const startedAt = performance.now();
    response.on('finish', () => {
      const seconds = (performance.now() - startedAt) / 1000;
      const route = typeof request.route?.path === 'string' ? request.route.path : 'unmatched';
      this.metrics.observeHttpRequest(request.method, route, response.statusCode, seconds);
      const fields = {
        ...context,
        method: request.method,
        route,
        statusCode: response.statusCode,
        durationMs: Math.round(seconds * 1000),
      };
      if (QUIET_ROUTES.has(route)) {
        this.logger.debug(fields, 'request completed');
      } else {
        this.logger.info(fields, 'request completed');
      }
    });
    runWithLogContext(context, next);
  }
}

/** Parâmetro de handler com o correlationId (resolvido pelo middleware, que roda antes). */
export const CorrelationId = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const id = context.switchToHttp().getRequest<RequestWithCorrelation>()[CORRELATION_ID];
  if (id === undefined) {
    throw new Error('RequestContextMiddleware não registrado');
  }
  return id;
});
