import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { parseConfig } from '../../src/infrastructure/config/app-config';
import { createIsolatedDatabase, type IsolatedDatabase } from '../support/database';
import { TestEventsQueue } from '../support/events-queue';
import { TestQueues } from '../support/sqs';

describe('GET /health/live', () => {
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
    const config = parseConfig({
      ...process.env,
      ...queues.consumerEnv(),
      ...events.publisherEnv(),
      DATABASE_URL: db.url,
      ROLE: 'all',
      LOG_LEVEL: 'silent',
    });
    app = await NestFactory.create(AppModule.forRole(config), { logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    await queues.destroy();
    await events.destroy();
    await db.drop();
  });

  test('responde 200 sem autenticação', async () => {
    const res = await fetch(`${baseUrl.replace('[::1]', 'localhost')}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
