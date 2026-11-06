import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { parseConfig } from '../../src/infrastructure/config/app-config';
import { ensureTestDatabase } from '../support/database';

describe('GET /health/live', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    await ensureTestDatabase();
    const config = parseConfig({ ...process.env, ROLE: 'all' });
    app = await NestFactory.create(AppModule.forRole(config), { logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  test('responde 200 sem autenticação', async () => {
    const res = await fetch(`${baseUrl.replace('[::1]', 'localhost')}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
