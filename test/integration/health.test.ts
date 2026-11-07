import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { parseConfig } from '../../src/infrastructure/config/app-config';
import type { ReadinessReport } from '../../src/infrastructure/observability/readiness';
import { createIsolatedDatabase, type IsolatedDatabase } from '../support/database';
import { TestEventsQueue } from '../support/events-queue';
import { TestQueues } from '../support/sqs';

/** App Nest real numa porta aleatória; devolve a URL base. */
async function start(env: Record<string, string>): Promise<{ app: INestApplication; url: string }> {
  const config = parseConfig({ ...process.env, LOG_LEVEL: 'silent', ...env });
  const app = await NestFactory.create(AppModule.forRole(config), { logger: false });
  await app.listen(0);
  return { app, url: (await app.getUrl()).replace('[::1]', 'localhost') };
}

describe('health: tudo de pé (ROLE=all)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let queues: TestQueues;
  let events: TestEventsQueue;
  let db: IsolatedDatabase;

  beforeAll(async () => {
    // ROLE=all liga consumer, outbox publisher e worker de PENDING_REFERENCE de verdade: filas e
    // banco próprios, para não consumir a fila do ambiente nem mexer nos dados de outros testes
    queues = await TestQueues.create();
    events = await TestEventsQueue.create();
    db = await createIsolatedDatabase();
    ({ app, url: baseUrl } = await start({
      ...queues.consumerEnv(),
      ...events.publisherEnv(),
      DATABASE_URL: db.url,
      ROLE: 'all',
    }));
  });

  afterAll(async () => {
    await app.close();
    await queues.destroy();
    await events.destroy();
    await db.drop();
  });

  test('GET /health/live responde 200 sem autenticação', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('GET /health/ready responde 200 com Postgres e SQS de pé', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadinessReport;
    expect(body).toMatchObject({
      status: 'ready',
      checks: { postgres: { status: 'up' }, sqs: { status: 'up' } },
    });
    expect(typeof body.checks.postgres?.durationMs).toBe('number');
  });

  test('GET /metrics responde no formato do Prometheus, sem autenticação', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('# TYPE wagering_transactions_total counter');
    expect(text).toContain('# TYPE wagering_outbox_oldest_pending_age_seconds gauge');
    expect(text).toContain('# TYPE wagering_dlq_depth gauge');
  });
});

describe('health: Postgres fora do ar', () => {
  test('readiness 503 com o Postgres marcado down; liveness continua 200', async () => {
    const db = await createIsolatedDatabase();
    const { app, url } = await start({ DATABASE_URL: db.url, ROLE: 'api' });
    try {
      expect((await fetch(`${url}/health/ready`)).status).toBe(200);
      // derruba as conexões do app e apaga o banco: a próxima consulta falha de verdade
      await db.drop();

      const res = await fetch(`${url}/health/ready`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as ReadinessReport;
      expect(body.status).toBe('not_ready');
      expect(body.checks.postgres?.status).toBe('down');
      expect(typeof body.checks.postgres?.error).toBe('string');
      // api não depende do SQS: não entra no readiness dele
      expect(body.checks.sqs).toBeUndefined();
      expect((await fetch(`${url}/health/live`)).status).toBe(200);
    } finally {
      await app.close().catch(() => undefined);
    }
  }, 30_000);
});

describe('health: SQS fora do ar', () => {
  test('readiness 503 com o SQS marcado down e o Postgres up', async () => {
    const db = await createIsolatedDatabase();
    // porta sem ninguém escutando; ROLE=outbox depende da fila de eventos
    const { app, url } = await start({
      DATABASE_URL: db.url,
      ROLE: 'outbox',
      SQS_ENDPOINT: 'http://127.0.0.1:9',
      HEALTH_CHECK_TIMEOUT_MS: '1000',
      OUTBOX_POLL_INTERVAL_MS: '1000',
    });
    try {
      const res = await fetch(`${url}/health/ready`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as ReadinessReport;
      expect(body.status).toBe('not_ready');
      expect(body.checks.postgres?.status).toBe('up');
      expect(body.checks.sqs?.status).toBe('down');
      expect(typeof body.checks.sqs?.error).toBe('string');
    } finally {
      await app.close();
      await db.drop();
    }
  }, 30_000);
});

describe('health: shutdown', () => {
  test('readiness 503 enquanto o consumer termina o que está fazendo', async () => {
    const queues = await TestQueues.create();
    const db = await createIsolatedDatabase();
    // long poll de 3s: o shutdown espera ele terminar antes de fechar o HTTP
    const { app, url } = await start({
      ...queues.consumerEnv({ SQS_WAIT_TIME_SECONDS: '3' }),
      DATABASE_URL: db.url,
    });
    try {
      expect((await fetch(`${url}/health/ready`)).status).toBe(200);
      const closing = app.close();
      const res = await fetch(`${url}/health/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'shutting_down', checks: {} });
      await closing;
    } finally {
      await queues.destroy();
      await db.drop();
    }
  }, 30_000);
});
