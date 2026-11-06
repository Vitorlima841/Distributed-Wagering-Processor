import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from '@nestjs/common';
import {
  type ClassifiedError,
  classifyError,
  ID_GENERATOR,
  type IdGenerator,
} from '../../application';
import { LOGGER, type Logger } from '../../infrastructure/logging/logger';
import { safeErrorFields } from '../../infrastructure/logging/safe-error-fields';
import { CORRELATION_HEADER, correlationIdOf } from './correlation';
import { HTTP_STATUS_BY_ERROR_KIND, TRANSIENT_RETRY_AFTER_SECONDS } from './http-status';
import type { HttpRequest, HttpResponse } from './http-types';

export interface ErrorBody {
  error: {
    code: string;
    category: string;
    message: string;
    retryable: boolean;
    details?: readonly { path: string; message: string }[];
  } & Record<string, unknown>;
  correlationId: string;
}

interface HttpError {
  status: number;
  classified: ClassifiedError;
}

/**
 * Filtro global: toda exceção vira o mesmo envelope `{ error: { code, category, message,
 * retryable }, correlationId }`, com o status de `HTTP_STATUS_BY_ERROR_KIND`. Erros internos
 * respondem mensagem genérica e são logados sem SQL nem valores.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const correlationId = correlationIdOf(request, this.ids);
    const { status, classified } = toHttpError(exception);

    if (status >= 500) {
      this.logger.error(
        { correlationId, status, code: classified.code, ...safeErrorFields(exception) },
        'request failed',
      );
    }
    if (response.headersSent) {
      return;
    }
    response.setHeader(CORRELATION_HEADER, correlationId);
    if (classified.kind === 'transient') {
      response.setHeader('Retry-After', String(TRANSIENT_RETRY_AFTER_SECONDS));
    }
    const body: ErrorBody = {
      error: {
        code: classified.code,
        category: categoryOf(classified),
        message: classified.message,
        retryable: classified.retryable,
        ...(classified.details ? { details: classified.details } : {}),
        ...classified.context,
      },
      correlationId,
    };
    response.status(status).json(body);
  }
}

export function toHttpError(exception: unknown): HttpError {
  const transport = transportError(exception);
  if (transport) {
    return transport;
  }
  const classified = classifyError(exception);
  return { status: HTTP_STATUS_BY_ERROR_KIND[classified.kind], classified };
}

/**
 * Erros do próprio HTTP: rota inexistente, JSON malformado, corpo grande demais. O adapter
 * Express do Nest já converte os erros do body-parser (< 500) em `HttpException`.
 */
function transportError(exception: unknown): HttpError | undefined {
  return exception instanceof HttpException
    ? fromStatus(exception.getStatus(), exception.message)
    : undefined;
}

function fromStatus(status: number, message: string): HttpError {
  if (status === 404) {
    return {
      status,
      classified: { kind: 'not_found', code: 'ROUTE_NOT_FOUND', message, retryable: false },
    };
  }
  if (status === 413) {
    return validation(413, 'PAYLOAD_TOO_LARGE', 'Corpo da requisição grande demais');
  }
  if (status >= 400 && status < 500) {
    return validation(status, 'INVALID_REQUEST', message);
  }
  return {
    status: 500,
    classified: {
      kind: 'unknown',
      code: 'INTERNAL_ERROR',
      message: 'Erro interno inesperado',
      retryable: false,
    },
  };
}

function validation(status: number, code: string, message: string): HttpError {
  return { status, classified: { kind: 'validation', code, message, retryable: false } };
}

function categoryOf(classified: ClassifiedError): string {
  return classified.kind === 'invariant' || classified.kind === 'unknown'
    ? 'internal'
    : classified.kind;
}
