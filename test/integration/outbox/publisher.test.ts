import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { type Clock, PublishOutbox } from '../../../src/application';
import { buildOrmConfig } from '../../../src/infrastructure/database/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/database/mikro-orm-unit-of-work';
import {
  EVENT_ATTRIBUTES,
  SqsEventPublisher,
} from '../../../src/infrastructure/messaging/sqs-event-publisher';
import { SystemClock } from '../../../src/infrastructure/system';
import { ManualClock } from '../../support/clock';
import { expectConsistentWallets } from '../../support/consistency';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
  inTransaction,
} from '../../support/database';
import { TestEventsQueue } from '../../support/events-queue';
import { sqsEndpoint, testSqsClient } from '../../support/sqs';
import { SqsProxy } from '../../support/sqs-proxy';
import { gate, waitUntil } from '../../support/sync';
import {
  allWalletIds,
  outboxRows,
  pendingOutboxCount,
  pendingOutboxIds,
  wageringFixture,
} from '../../support/wagering-fixture';

/**
 * Outbox publisher em processo: `PublishOutbox` real sobre Postgres real (banco isolado, só com os
 * eventos deste arquivo) e LocalStack real (fila de eventos própria). O proxy do SQS deixa o teste
 * segurar ou derrubar a publicação. Os testes com processos separados ficam em
 * `test/concurrency/outbox-publishers.test.ts`.
 */

const TIMEOUT_MS = 30_000;

describe('outbox publisher (Postgres + LocalStack reais)', () => {
  let db: IsolatedDatabase;
  /** Segundo pool para o mesmo banco: outra "instância" do publisher. */
  let otherOrm: MikroORM;
  let events: TestEventsQueue;
  let proxy: SqsProxy;
  let fixture: ReturnType<typeof wageringFixture>;

  const publisherOn = (
    orm: MikroORM,
    {
      endpoint = sqsEndpoint(),
      batchSize = 50,
      clock = new SystemClock(),
    }: { endpoint?: string; batchSize?: number; clock?: Clock } = {},
  ) =>
    new PublishOutbox(
      new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 5_000 }),
      new SqsEventPublisher(testSqsClient(endpoint), {
        queueName: events.name,
        publishTimeoutMs: 5_000,
      }),
      clock,
      { batchSize },
    );

  /** Publica tudo o que estiver pendente (o banco isolado só tem eventos deste arquivo). */
  const flushOutbox = async () => {
    const publisher = publisherOn(db.orm);
    while ((await publisher.publishDue()).claimed > 0) {
      // repete até esvaziar
    }
  };

  beforeAll(async () => {
    db = await createIsolatedDatabase();
    otherOrm = await MikroORM.init(buildOrmConfig(db.url));
    events = await TestEventsQueue.create();
    proxy = SqsProxy.start();
    fixture = wageringFixture(db.orm);
  }, TIMEOUT_MS);

  afterEach(async () => {
    // cada teste começa sem pendências e sem mensagens na fila
    await flushOutbox();
    await events.drain(0, 5_000);
    await expectConsistentWallets(db.orm, await allWalletIds(db.orm));
  }, TIMEOUT_MS);

  afterAll(async () => {
    proxy.stop();
    await events.destroy();
    await otherOrm.close(true);
    await db.drop();
  });

  test(
    'publica eventos confirmados com o envelope intacto e marca published_at',
    async () => {
      const wallet = await fixture.openWallet('100.00');
      const bet = await fixture.wager(wallet, {
        kind: 'BET',
        amount: '10.00',
        correlationId: 'c-bet-1',
      });
      const pending = await outboxRows(db.orm);
      expect(pending).toHaveLength(4);
      expect(pending.every((row) => row.publishedAt === null && row.attempts === 0)).toBe(true);

      const summary = await publisherOn(db.orm).publishDue();
      expect({
        claimed: summary.claimed,
        published: summary.published,
        failed: summary.failed,
      }).toEqual({ claimed: 4, published: 4, failed: [] });

      const received = await events.drain(4);
      expect(received.map((e) => e.eventId).sort()).toEqual(pending.map((row) => row.id).sort());
      for (const event of received) {
        const row = pending.find((candidate) => candidate.id === event.eventId);
        // o corpo é o envelope gravado na outbox, sem mudança
        expect(event.envelope).toEqual(row?.payload);
        expect(event.attributes[EVENT_ATTRIBUTES.eventId]).toBe(event.eventId);
        expect(event.attributes[EVENT_ATTRIBUTES.eventType]).toBe(event.eventType);
        expect(event.attributes[EVENT_ATTRIBUTES.aggregateId]).toBe(event.envelope.aggregateId);
        expect(event.attributes[EVENT_ATTRIBUTES.correlationId]).toBe(event.envelope.correlationId);
      }
      const betEvents = received.filter((e) => e.envelope.data.transactionId === bet.transactionId);
      expect(betEvents.map((e) => e.eventType).sort()).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      expect(betEvents.every((e) => e.envelope.correlationId === 'c-bet-1')).toBe(true);

      const after = await outboxRows(db.orm);
      expect(after.every((row) => row.publishedAt !== null && row.attempts === 0)).toBe(true);
      expect((await publisherOn(db.orm).publishDue()).claimed).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    'nunca publica antes do COMMIT: transação financeira presa no COMMIT não é vista',
    async () => {
      const wallet = await fixture.openWallet('100.00');
      await flushOutbox();
      await events.drain(2);

      // trigger diferido de teste: no COMMIT, a transação que gravou outbox espera um advisory lock
      // que o teste segura. Assim a BET fica com tudo escrito (transação, saldo, ledger, outbox) e
      // ainda sem COMMIT pelo tempo que o teste quiser.
      const exec = (sql: string) => db.orm.em.fork().execute(sql);
      await exec(`create function test_wait_on_commit() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(7007); return null; end $$`);
      await exec(`create constraint trigger tg_test_wait_on_commit after insert on outbox_messages
      deferrable initially deferred for each row execute function test_wait_on_commit()`);
      const holding = gate();
      const release = gate();
      const holder = inTransaction(otherOrm, async (em) => {
        await em.execute('select pg_advisory_xact_lock(7007)');
        holding.open();
        await release.promise;
      });
      try {
        await holding.promise;
        const bet = fixture.wager(wallet, { kind: 'BET', amount: '30.00' });
        await waitUntil('BET parada no COMMIT', async () => {
          const [row] = await db.orm.em.fork().execute<{ n: number }[]>(
            `select count(*)::int as n from pg_stat_activity
              where datname = current_database() and wait_event = 'advisory'`,
          );
          return (row?.n ?? 0) > 0;
        });

        // os INSERTs da BET existem, mas não estão confirmados: o publisher não os enxerga
        const blocked = await publisherOn(db.orm).publishDue();
        expect(blocked.claimed).toBe(0);
        expect(await pendingOutboxCount(db.orm)).toBe(0);

        release.open();
        await holder;
        const outcome = await bet;
        expect(outcome.status as string).toBe('PROCESSED');
      } finally {
        release.open();
        await holder.catch(() => undefined);
        await exec('drop trigger if exists tg_test_wait_on_commit on outbox_messages');
        await exec('drop function if exists test_wait_on_commit()');
      }

      // depois do COMMIT, os dois eventos da BET saem
      expect(await pendingOutboxCount(db.orm)).toBe(2);
      expect((await publisherOn(db.orm).publishDue()).published).toBe(2);
      expect((await events.drain(2)).map((e) => e.eventType).sort()).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    'dois publishers: o lote travado por um é pulado pelo outro (SKIP LOCKED), sem duplicar',
    async () => {
      for (let i = 0; i < 6; i += 1) {
        await fixture.openWallet('10.00'); // 2 eventos cada
      }
      const all = await pendingOutboxIds(db.orm);
      expect(all).toHaveLength(12);

      // A trava os 5 mais antigos e fica parado no SendMessageBatch (antes de chegar ao SQS)
      const held = proxy.hold('SendMessageBatch');
      const publisherA = publisherOn(db.orm, { endpoint: proxy.url, batchSize: 5 });
      const runA = publisherA.publishDue();
      const call = await held.arrived;
      const lockedByA: string[] = call.input.Entries.map((entry: { Id: string }) => entry.Id);
      expect(lockedByA.sort()).toEqual(all.slice(0, 5).sort());

      // B, com outro pool, não espera os locks de A: pega só as outras 7 e publica
      const summaryB = await publisherOn(otherOrm, { batchSize: 50 }).publishDue();
      expect(summaryB.claimed).toBe(7);
      expect(summaryB.published).toBe(7);
      const publishedByB = (await outboxRows(db.orm, all))
        .filter((row) => row.publishedAt !== null)
        .map((row) => row.id);
      expect(publishedByB.sort()).toEqual(all.slice(5).sort());

      held.release();
      expect((await runA).published).toBe(5);

      const received = await events.drain(12);
      expect(received.map((e) => e.eventId).sort()).toEqual([...all].sort());
      expect(await pendingOutboxCount(db.orm)).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    'SQS recusando: attempts sobe com backoff de 1s, 2s, 4s; quando volta, publica',
    async () => {
      await fixture.openWallet('50.00');
      const clock = new ManualClock();
      const publisher = publisherOn(db.orm, { endpoint: proxy.url, clock });
      const callsBefore = proxy.calls.length;
      const ids = await pendingOutboxIds(db.orm);
      expect(ids).toHaveLength(2);
      const failure = proxy.fail('SendMessageBatch');
      const at = (ms: number) => new Date(clock.now().getTime() + ms).toISOString();
      const schedule = async () =>
        (await outboxRows(db.orm, ids)).map((row) => ({
          attempts: row.attempts,
          next: row.nextAttemptAt.toISOString(),
          published: row.publishedAt !== null,
        }));
      try {
        const first = await publisher.publishDue();
        expect(first.claimed).toBe(2);
        expect(first.published).toBe(0);
        expect(first.failed.map((f) => f.reason)).toEqual(['InjectedFailure', 'InjectedFailure']);
        expect(await schedule()).toEqual([
          { attempts: 1, next: at(1_000), published: false },
          { attempts: 1, next: at(1_000), published: false },
        ]);

        // antes de vencer, ninguém pega
        clock.advance(999);
        expect((await publisher.publishDue()).claimed).toBe(0);

        clock.advance(1);
        expect((await publisher.publishDue()).failed).toHaveLength(2);
        expect((await schedule()).map((s) => [s.attempts, s.next])).toEqual([
          [2, at(2_000)],
          [2, at(2_000)],
        ]);

        clock.advance(2_000);
        expect((await publisher.publishDue()).failed).toHaveLength(2);
        expect((await schedule()).map((s) => [s.attempts, s.next])).toEqual([
          [3, at(4_000)],
          [3, at(4_000)],
        ]);
      } finally {
        failure.restore();
      }

      clock.advance(4_000);
      const recovered = await publisher.publishDue();
      expect(recovered.published).toBe(2);
      expect((await schedule()).map((s) => [s.attempts, s.published])).toEqual([
        [3, true],
        [3, true],
      ]);
      const received = await events.drain(2);
      expect(received).toHaveLength(2);
      // as tentativas recusadas não chegaram ao SQS
      const batches = proxy.calls
        .slice(callsBefore)
        .filter((c) => c.operation === 'SendMessageBatch');
      expect(batches.map((c) => c.failed === true)).toEqual([true, true, true, false]);
    },
    TIMEOUT_MS,
  );
});
