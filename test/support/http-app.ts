import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { parseConfig } from '../../src/infrastructure/config/app-config';
import { ensureTestDatabase } from './database';

/** Qualquer alvo HTTP dos testes: o app em processo ou uma instância em outro processo. */
export interface HttpTarget {
  baseUrl: string;
  request(method: string, path: string, options?: RequestOptions): Promise<TestResponse>;
}

/**
 * App Nest real (grafo completo, papel `api`) numa porta aleatória, contra o Postgres do docker
 * compose (banco `wagering_test`). Os testes falam HTTP de verdade com ele.
 */
export interface TestApp extends HttpTarget {
  orm: MikroORM;
  /** Instância do container do Nest (use cases reais, para testes que chamam a application). */
  get<T>(token: abstract new (...args: never[]) => T): T;
  close(): Promise<void>;
}

export interface RequestOptions {
  body?: unknown;
  /** Corpo cru (para testar JSON malformado). */
  rawBody?: string;
  headers?: Record<string, string>;
}

export interface TestResponse {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: corpo JSON livre nas asserções dos testes
  body: any;
}

export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  await ensureTestDatabase();
  const config = parseConfig({ ...process.env, ROLE: 'api', LOG_LEVEL: 'silent', ...env });
  const app: INestApplication = await NestFactory.create(AppModule.forRole(config), {
    logger: false,
  });
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');

  return {
    baseUrl,
    orm: app.get(MikroORM),
    get: <T>(token: abstract new (...args: never[]) => T): T => app.get<T>(token as never),
    close: () => app.close(),
    request: (method, path, options) => httpRequest(baseUrl, method, path, options),
  };
}

/** Requisição HTTP real; o corpo da resposta vem parseado como JSON (ou undefined se vazio). */
export async function httpRequest(
  baseUrl: string,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<TestResponse> {
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(hasBody ? { body: options.rawBody ?? JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}

/** Atalhos da API usados por vários arquivos de teste. Dinheiro sempre como string. */
export interface CreatedWallet {
  id: string;
  playerId: string;
  currency: string;
}

export async function createWallet(
  app: HttpTarget,
  initial: string,
  { currency = 'BRL', playerId = randomUUID() }: { currency?: string; playerId?: string } = {},
): Promise<CreatedWallet> {
  const res = await app.request('POST', '/wallets', {
    body: { playerId, initialBalance: { amount: initial, currency } },
  });
  if (res.status !== 201) {
    throw new Error(`criação de wallet falhou: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.id, playerId, currency };
}

export interface WagerRequest {
  kind: string;
  amount: string;
  currency?: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  providerId?: string;
  roundId?: string;
  playerId?: string;
  idempotencyKey?: string;
  correlationId?: string;
}

export function wagerBody(wallet: CreatedWallet, input: WagerRequest): Record<string, unknown> {
  return {
    providerId: input.providerId ?? 'provider-a',
    externalTransactionId: input.externalTransactionId ?? `ext-${randomUUID()}`,
    playerId: input.playerId ?? wallet.playerId,
    walletId: wallet.id,
    roundId: input.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind: input.kind,
    money: { amount: input.amount, currency: input.currency ?? wallet.currency },
    ...(input.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: input.referenceExternalTransactionId }),
  };
}

/** Submete uma transação; a key padrão é `{providerId}:{externalTransactionId}`. */
export function submitWager(
  app: HttpTarget,
  wallet: CreatedWallet,
  input: WagerRequest,
): Promise<TestResponse & { externalTransactionId: string }> {
  const body = wagerBody(wallet, input);
  const key = input.idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}`;
  return submitRaw(app, body, key, input.correlationId).then((res) => ({
    ...res,
    externalTransactionId: body.externalTransactionId as string,
  }));
}

export function submitRaw(
  app: HttpTarget,
  body: unknown,
  idempotencyKey: string | undefined,
  correlationId?: string,
): Promise<TestResponse> {
  return app.request('POST', '/wagering/transactions', {
    body,
    headers: {
      ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
      ...(correlationId === undefined ? {} : { 'X-Correlation-Id': correlationId }),
    },
  });
}
