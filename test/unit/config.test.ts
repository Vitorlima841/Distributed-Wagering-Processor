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

  test('falha com DATABASE_URL que não é postgres', () => {
    expect(() => parseConfig({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(ConfigError);
  });
});
