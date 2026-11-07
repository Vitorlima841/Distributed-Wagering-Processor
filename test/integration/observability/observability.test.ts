import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../src/app.module';
import { parseConfig } from '../../../src/infrastructure/config/app-config';
import {
  createIsolatedDatabase,
  expectBalanceMatchesLedger,
  type IsolatedDatabase,
  inTransaction,
} from '../../support/database';
import { TestEventsQueue } from '../../support/events-queue';
import {
  type CreatedWallet,
  createWallet,
  type HttpTarget,
  httpRequest,
  submitWager,
} from '../../support/http-app';
import { LogCapture, type Scrape, scrape } from '../../support/metrics';
import { TestQueues, wagerMessage } from '../../support/sqs';
import { holdWalletLock, waitUntil } from '../../support/sync';

/**
 * Observabilidade (fase 8) contra Postgres e LocalStack reais: um processo `ROLE=all` passa por
 * cada caminho que as métricas precisam contar (transação nova, replay, reentrega, conflito, lock
 * timeout no HTTP e no consumer, DLQ, PENDING_REFERENCE, reconciliação divergente, outbox) e o
 * teste confere `/metrics` e as linhas de log capturadas.
 *
 * Valores em dinheiro pouco comuns de propósito: o teste de vazamento procura essas strings nos logs.
 */
const AMOUNTS = {
  initial: '137.29',
  httpBet: '12.34',
  conflict: '4.56',
  lockedHttp: '7.89',
  lockedSqs: '2.22',
  sqsBet: '3.21',
  refund: '1.11',
  // saldos depois de cada débito confirmado
  afterHttpBet: '124.95',
  afterLockedSqs: '122.73',
  afterSqsBet: '119.52',
} as const;
const TAMPER_DELTA = '0.77';

const TIMEOUT_MS = 60_000;

describe('observabilidade: métricas e logs', () => {
  let app: INestApplication;
  let target: HttpTarget;
  let queues: TestQueues;
  let events: TestEventsQueue;
  let db: IsolatedDatabase;
  const logs = new LogCapture();
  let wallet: CreatedWallet;
  let metrics: Scrape;
  const httpCorrelation = `corr-http-${randomUUID()}`;
  const lockCorrelation = `corr-lock-${randomUUID()}`;
  const sqsCorrelation = `corr-sqs-${randomUUID()}`;
  let sqsMessageId = '';
  let httpTransactionId = '';

  const metricsNow = () => scrape(target.baseUrl);
  const until = (description: string, check: (m: Scrape) => boolean) =>
    waitUntil(description, async () => check(await metricsNow()), 30_000);

  beforeAll(async () => {
    queues = await TestQueues.create();
    events = await TestEventsQueue.create();
    db = await createIsolatedDatabase();
    const config = parseConfig({
      ...process.env,
      ...queues.consumerEnv(),
      ...events.publisherEnv(),
      DATABASE_URL: db.url,
      ROLE: 'all',
      LOG_LEVEL: 'debug',
      DB_LOCK_TIMEOUT_MS: '300',
      SQS_RETRY_BASE_DELAY_S: '1',
      PENDING_REF_POLL_INTERVAL_MS: '50',
    });
    app = await NestFactory.create(AppModule.forRole(config, { logDestination: logs }), {
      logger: false,
    });
    await app.listen(0);
    const baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
    target = {
      baseUrl,
      request: (method, path, options) => httpRequest(baseUrl, method, path, options),
    };
  });

  afterAll(async () => {
    await app.close();
    await queues.destroy();
    await events.destroy();
    await db.drop();
  });

  test(
    'cada caminho conta na métrica certa',
    async () => {
      wallet = await createWallet(target, AMOUNTS.initial);

      // HTTP: transação nova, replay e conflito de idempotência
      const bet = await submitWager(target, wallet, {
        kind: 'BET',
        amount: AMOUNTS.httpBet,
        correlationId: httpCorrelation,
      });
      expect(bet.status).toBe(201);
      httpTransactionId = bet.body.transactionId;
      const key = `provider-a:${bet.externalTransactionId}`;
      const replay = await submitWager(target, wallet, {
        kind: 'BET',
        amount: AMOUNTS.httpBet,
        externalTransactionId: bet.externalTransactionId,
      });
      expect(replay.status).toBe(200);
      const conflict = await submitWager(target, wallet, {
        kind: 'BET',
        amount: AMOUNTS.conflict,
        idempotencyKey: key,
      });
      expect(conflict.status).toBe(409);

      // lock: a wallet travada por fora → 503 no HTTP e retry no consumer
      const hold = await holdWalletLock(db.orm, wallet.id);
      const lockedSqs = wagerMessage(wallet, { kind: 'BET', amount: AMOUNTS.lockedSqs });
      try {
        const locked = await submitWager(target, wallet, {
          kind: 'BET',
          amount: AMOUNTS.lockedHttp,
          correlationId: lockCorrelation,
        });
        expect(locked.status).toBe(503);
        await queues.sendWager(lockedSqs);
        await until(
          'retry do consumer por lock timeout',
          (m) =>
            m.sum('wagering_retries_total', {
              component: 'sqs_consumer',
              reason: 'LOCK_TIMEOUT',
            }) >= 1,
        );
      } finally {
        await hold.release();
      }
      await until(
        'mensagem travada processada depois do lock',
        (m) => m.sum('wagering_transactions_total', { source: 'sqs' }) === 1,
      );

      // SQS: transação nova e a mesma mensagem de novo (reentrega → inbox)
      const message = wagerMessage(wallet, {
        kind: 'BET',
        amount: AMOUNTS.sqsBet,
        correlationId: sqsCorrelation,
      });
      sqsMessageId = message.messageId;
      await queues.sendWager(message);
      await until(
        'mensagem SQS processada',
        (m) => m.sum('wagering_transactions_total', { source: 'sqs' }) === 2,
      );
      await queues.sendWager(message, { deduplicationId: `again-${randomUUID()}` });
      await until(
        'reentrega detectada',
        (m) =>
          m.sum('wagering_duplicates_total', { source: 'sqs', type: 'duplicate_delivery' }) === 1,
      );

      // mensagem malformada: erro permanente → DLQ na hora
      await queues.send('isto não é json', {
        groupId: `bad-${randomUUID()}`,
        deduplicationId: randomUUID(),
      });
      await until('mensagem na DLQ', (m) => m.sum('wagering_dlq_messages_total') === 1);

      // REFUND sem a referência → PENDING_REFERENCE e retry agendado pelo worker
      const refund = await submitWager(target, wallet, {
        kind: 'REFUND',
        amount: AMOUNTS.refund,
        referenceExternalTransactionId: `missing-${randomUUID()}`,
      });
      expect(refund.status).toBe(202);
      await until(
        'nova tentativa de PENDING_REFERENCE',
        (m) =>
          m.sum('wagering_retries_total', {
            component: 'pending_reference',
            reason: 'REFERENCE_NOT_FOUND',
          }) >= 1,
      );

      // reconciliação com o saldo adulterado (triggers desligados só nesta sessão)
      const tampered = await createWallet(target, '50.00');
      await inTransaction(db.orm, async (em) => {
        await em.execute('set local session_replication_role = replica');
        await em.execute('update wallets set balance = balance + ?::numeric where id = ?', [
          TAMPER_DELTA,
          tampered.id,
        ]);
      });
      const reconciliation = await target.request('POST', `/wallets/${tampered.id}/reconciliation`);
      expect(reconciliation.body.consistent).toBe(false);

      // outbox: tudo publicado, backlog zerado; a DLQ aparece no gauge
      await until(
        'outbox vazia e DLQ contada',
        (m) =>
          m.value('wagering_outbox_pending_messages') === 0 && m.value('wagering_dlq_depth') === 1,
      );
      metrics = await metricsNow();

      const count = (name: string, labels: Record<string, string> = {}) =>
        metrics.sum(name, labels);
      expect(
        count('wagering_transactions_total', { source: 'http', kind: 'BET', status: 'PROCESSED' }),
      ).toBe(1);
      expect(
        count('wagering_transactions_total', {
          source: 'http',
          kind: 'REFUND',
          status: 'PENDING_REFERENCE',
        }),
      ).toBe(1);
      expect(
        count('wagering_transactions_total', { source: 'sqs', kind: 'BET', status: 'PROCESSED' }),
      ).toBe(2);
      expect(
        count('wagering_duplicates_total', { source: 'http', type: 'idempotent_replay' }),
      ).toBe(1);
      expect(
        count('wagering_duplicates_total', { source: 'sqs', type: 'duplicate_delivery' }),
      ).toBe(1);
      expect(
        count('wagering_transaction_errors_total', {
          source: 'http',
          kind: 'conflict',
          code: 'IDEMPOTENCY_CONFLICT',
        }),
      ).toBe(1);
      expect(count('wagering_lock_failures_total', { source: 'http', code: 'LOCK_TIMEOUT' })).toBe(
        1,
      );
      expect(
        count('wagering_lock_failures_total', { source: 'sqs', code: 'LOCK_TIMEOUT' }),
      ).toBeGreaterThanOrEqual(1);
      expect(count('wagering_retries_total', { component: 'sqs_consumer' })).toBeGreaterThanOrEqual(
        1,
      );
      expect(count('wagering_dlq_messages_total', { code: 'MALFORMED_MESSAGE' })).toBe(1);
      expect(metrics.value('wagering_dlq_depth')).toBe(1);
      expect(count('wagering_reconciliation_divergences_total')).toBe(1);

      // latência por origem e resultado
      expect(
        count('wagering_processing_duration_seconds_count', {
          source: 'http',
          result: 'PROCESSED',
        }),
      ).toBe(1);
      expect(
        count('wagering_processing_duration_seconds_count', { source: 'http', result: 'error' }),
      ).toBe(2);
      expect(
        count('wagering_processing_duration_seconds_count', { source: 'sqs', result: 'PROCESSED' }),
      ).toBe(2);

      // outbox: eventos publicados, lag observado, backlog zerado
      const published = count('wagering_outbox_events_published_total');
      expect(published).toBeGreaterThanOrEqual(6);
      expect(count('wagering_outbox_lag_seconds_count')).toBe(published);
      expect(metrics.value('wagering_outbox_oldest_pending_age_seconds')).toBe(0);

      // HTTP por rota modelo, nunca pela URL com ids
      expect(
        count('wagering_http_request_duration_seconds_count', {
          method: 'POST',
          route: '/wagering/transactions',
          status: '201',
        }),
      ).toBe(1);
      expect(metrics.samples.some((s) => s.labels.route?.includes(wallet.id))).toBe(false);

      await expectBalanceMatchesLedger(db.orm, [wallet.id]);
      expect((await target.request('GET', `/wallets/${wallet.id}`)).body.balance.amount).toBe(
        AMOUNTS.afterSqsBet,
      );
    },
    TIMEOUT_MS,
  );

  test('logs JSON trazem o contexto de correlação de cada entrada', () => {
    const entries = logs.entries();

    // HTTP: a requisição, com ids e status no mesmo log
    const request = entries.find(
      (e) =>
        e.msg === 'request completed' &&
        e.correlationId === httpCorrelation &&
        e.route === '/wagering/transactions',
    );
    expect(request).toMatchObject({
      level: 30,
      method: 'POST',
      statusCode: 201,
      walletId: wallet.id,
      providerId: 'provider-a',
      kind: 'BET',
      transactionId: httpTransactionId,
      status: 'PROCESSED',
      idempotentReplay: false,
    });
    expect(typeof request.durationMs).toBe('number');

    // o filtro de erros loga dentro do contexto da requisição (sem repassar nada)
    expect(
      entries.find((e) => e.msg === 'request failed' && e.correlationId === lockCorrelation),
    ).toMatchObject({ code: 'LOCK_TIMEOUT', walletId: wallet.id, providerId: 'provider-a' });

    // SQS: a mensagem, com o id do envelope e a correlação que veio nele
    expect(
      entries.find((e) => e.msg === 'message processed' && e.messageId === sqsMessageId),
    ).toMatchObject({
      correlationId: sqsCorrelation,
      walletId: wallet.id,
      providerId: 'provider-a',
      status: 'PROCESSED',
      duplicateDelivery: false,
      component: 'sqs-consumer',
    });

    // o fio até o evento: o publisher loga a mesma correlação da requisição HTTP
    const published = entries.filter(
      (e) => e.msg === 'event published' && e.correlationId === httpCorrelation,
    );
    expect(published.map((e) => e.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(published.every((e) => typeof e.lagMs === 'number')).toBe(true);

    // worker de PENDING_REFERENCE: transação, wallet e correlação
    expect(entries.find((e) => e.msg === 'reference still missing')).toMatchObject({
      walletId: wallet.id,
      kind: 'REFUND',
      outcome: 'PENDING_REFERENCE',
    });

    // reconciliação divergente: só wallet, diferença e contagem
    const divergence = entries.find((e) => e.event === 'reconciliation_divergence');
    expect(Object.keys(divergence).sort()).toEqual(
      [
        'checkedEntries',
        'correlationId',
        'difference',
        'event',
        'level',
        'msg',
        'time',
        'walletId',
      ].sort(),
    );
  });

  test('nenhum log traz valores da transação nem saldo', () => {
    const leaks = logs.lines.filter((line) =>
      Object.values(AMOUNTS).some((amount) => line.includes(`"${amount}"`)),
    );
    expect(leaks).toEqual([]);
    for (const entry of logs.entries()) {
      if (entry.event === 'reconciliation_divergence') {
        continue;
      }
      for (const key of ['amount', 'money', 'balance', 'payload', 'data', 'body']) {
        expect(JSON.stringify(entry)).not.toContain(`"${key}"`);
      }
    }
  });
});
