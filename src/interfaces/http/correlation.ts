import {
  type CallHandler,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { ID_GENERATOR, type IdGenerator } from '../../application';
import type { HttpRequest, HttpResponse } from './http-types';

export const CORRELATION_HEADER = 'X-Correlation-Id';
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CORRELATION_ID = Symbol('correlationId');

type RequestWithCorrelation = HttpRequest & { [CORRELATION_ID]?: string };

/**
 * `X-Correlation-Id` do cliente (se válido) ou um id novo; calculado uma vez por requisição e
 * reaproveitado pelo controller, pelos eventos da outbox e pelo filtro de erros.
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

/** Resolve o correlationId antes do handler e o devolve no header da resposta. */
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  constructor(@Inject(ID_GENERATOR) private readonly ids: IdGenerator) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const correlationId = correlationIdOf(http.getRequest<HttpRequest>(), this.ids);
    http.getResponse<HttpResponse>().setHeader(CORRELATION_HEADER, correlationId);
    return next.handle();
  }
}

/** Parâmetro de handler com o correlationId (resolvido pelo interceptor, que roda antes). */
export const CorrelationId = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const id = context.switchToHttp().getRequest<RequestWithCorrelation>()[CORRELATION_ID];
  if (id === undefined) {
    throw new Error('CorrelationIdInterceptor não registrado');
  }
  return id;
});
