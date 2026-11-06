import { describe, expect, test } from 'bun:test';
import { ConfigError, parseConfig } from '../../src/infrastructure/config/app-config';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
};

describe('parseConfig', () => {
  test('aplica defaults', () => {
    const cfg = parseConfig(base);
    expect(cfg.role).toBe('all');
    expect(cfg.port).toBe(3000);
    expect(cfg.queues.wager).toBe('wager-transactions.fifo');
    expect(cfg.queues.wagerDlq).toBe('wager-transactions-dlq.fifo');
    expect(cfg.queues.events).toBe('wagering-events');
    expect(cfg.dbLockTimeoutMs).toBe(5000);
    expect(cfg.dbPoolMax).toBe(10);
    expect(cfg.dbApplicationName).toBe('wagering-all');
  });

  test('PORT=0 (porta efêmera) é aceito; fora de 0..65535 não', () => {
    expect(parseConfig({ ...base, PORT: '0' }).port).toBe(0);
    expect(() => parseConfig({ ...base, PORT: '-1' })).toThrow(/PORT/);
    expect(() => parseConfig({ ...base, PORT: '65536' })).toThrow(/PORT/);
  });

  test('pool e application_name configuráveis', () => {
    const cfg = parseConfig({
      ...base,
      ROLE: 'api',
      DB_POOL_MAX: '25',
      DB_APPLICATION_NAME: 'cluster-a.1',
    });
    expect(cfg.dbPoolMax).toBe(25);
    expect(cfg.dbApplicationName).toBe('cluster-a.1');
    expect(parseConfig({ ...base, ROLE: 'api' }).dbApplicationName).toBe('wagering-api');
    expect(() => parseConfig({ ...base, DB_POOL_MAX: '0' })).toThrow(/DB_POOL_MAX/);
    expect(() => parseConfig({ ...base, DB_APPLICATION_NAME: 'com espaço' })).toThrow(
      /DB_APPLICATION_NAME/,
    );
  });

  test('falha com DB_LOCK_TIMEOUT_MS inválido', () => {
    expect(() => parseConfig({ ...base, DB_LOCK_TIMEOUT_MS: '0' })).toThrow(/DB_LOCK_TIMEOUT_MS/);
    expect(() => parseConfig({ ...base, DB_LOCK_TIMEOUT_MS: '1.5' })).toThrow(ConfigError);
  });

  test('aceita cada ROLE válido', () => {
    for (const role of ['api', 'consumer', 'outbox', 'pending-ref', 'all']) {
      expect(parseConfig({ ...base, ROLE: role }).role).toBe(role as never);
    }
  });

  test('falha com ROLE inválido', () => {
    expect(() => parseConfig({ ...base, ROLE: 'worker' })).toThrow(ConfigError);
  });

  test('falha sem DATABASE_URL e lista o campo', () => {
    const { DATABASE_URL: _omit, ...rest } = base;
    expect(() => parseConfig(rest)).toThrow(/DATABASE_URL/);
  });

  test('consumer SQS: defaults e validação', () => {
    expect(parseConfig(base).consumer).toEqual({
      name: 'wager-transactions-consumer',
      waitTimeSeconds: 10,
      maxMessages: 10,
      visibilityTimeoutS: 30,
      retryBaseDelayS: 2,
      retryMaxDelayS: 60,
      shutdownTimeoutMs: 15_000,
    });
    const custom = parseConfig({
      ...base,
      SQS_CONSUMER_NAME: 'consumer-b',
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_MAX_MESSAGES: '5',
      SQS_VISIBILITY_TIMEOUT_S: '3',
      SQS_RETRY_BASE_DELAY_S: '1',
      SQS_RETRY_MAX_DELAY_S: '1',
      SQS_SHUTDOWN_TIMEOUT_MS: '500',
    }).consumer;
    expect(custom).toMatchObject({ name: 'consumer-b', waitTimeSeconds: 1, retryMaxDelayS: 1 });
    expect(() => parseConfig({ ...base, SQS_WAIT_TIME_SECONDS: '21' })).toThrow(
      /SQS_WAIT_TIME_SECONDS/,
    );
    expect(() => parseConfig({ ...base, SQS_MAX_MESSAGES: '11' })).toThrow(/SQS_MAX_MESSAGES/);
    expect(() => parseConfig({ ...base, SQS_CONSUMER_NAME: 'com espaço' })).toThrow(
      /SQS_CONSUMER_NAME/,
    );
    expect(() =>
      parseConfig({ ...base, SQS_RETRY_BASE_DELAY_S: '10', SQS_RETRY_MAX_DELAY_S: '5' }),
    ).toThrow(/SQS_RETRY_MAX_DELAY_S/);
  });

  test('falha com DATABASE_URL que não é postgres', () => {
    expect(() => parseConfig({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(ConfigError);
  });
});
