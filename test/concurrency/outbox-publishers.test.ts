import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { InboxMessage } from '../../src/domain';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import { AppInstance } from '../support/cluster';
import { CONCURRENCY_TIMEOUT_MS } from '../support/concurrency-suite';
import { expectConsistentWallets } from '../support/consistency';
import { createIsolatedDatabase, type IsolatedDatabase } from '../support/database';
import { type ReceivedEvent, TestEventsQueue } from '../support/events-queue';
import { createWallet, submitWager } from '../support/http-app';
import { SqsProxy } from '../support/sqs-proxy';
import { backendsOf, waitUntil } from '../support/sync';
import {
  allWalletIds,
  outboxRows,
  pendingOutboxCount,
  pendingOutboxIds,
  wageringFixture,
} from '../support/wagering-fixture';

/**
 * Outbox publisher em processos reais (`bun src/main.ts`, papel `outbox`) contra Postgres (banco
 * isolado) e LocalStack. Cada processo fala com o SQS por um proxy próprio: o teste vê cada
 * `SendMessageBatch` (quais eventos cada instância enviou) e pode segurar a chamada para matar o
 * processo no ponto exato (desafio §11).
 */

const suffix = () => randomBytes(3).toString('hex');

/** Ids enviados nos `SendMessageBatch` que passaram por um proxy. */
const sentIds = (proxy: SqsProxy): string[] =>
  proxy
    .of('SendMessageBatch')
    .flatMap((call) => call.input.Entries.map((entry: { Id: string }) => entry.Id));

const countBy = (ids: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const id of ids) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
};

describe('outbox publisher em processos reais', () => {
  let db: IsolatedDatabase;
  let events: TestEventsQueue;
  let fixture: ReturnType<typeof wageringFixture>;
  const cleanups: (() => Promise<void> | void)[] = [];

  /** Publisher num processo próprio, falando com o SQS por um proxy próprio. */
  const startPublisher = async (name: string, env: Record<string, string> = {}) => {
    const proxy = SqsProxy.start();
    const instance = await AppInstance.start(name, {
      ...events.publisherEnv(),
      DATABASE_URL: db.url,
      SQS_ENDPOINT: proxy.url,
      ...env,
    });
    cleanups.push(
      () => instance.kill(),
      () => proxy.stop(),
    );
    return { instance, proxy };
  };

  /** SIGKILL e espera o Postgres desfazer a transação da instância (as conexões somem). */
  const crash = async (instance: AppInstance) => {
    await instance.kill();
    await waitUntil(
      `conexões de ${instance.applicationName} encerradas`,
      async () => (await backendsOf(db.orm, instance.applicationName)) === 0,
    );
  };

  const outboxDrained = () =>
    waitUntil(
      'outbox sem pendências',
      async () => (await pendingOutboxCount(db.orm)) === 0,
      20_000,
    );

  beforeAll(async () => {
    db = await createIsolatedDatabase();
    events = await TestEventsQueue.create();
    fixture = wageringFixture(db.orm);
  }, CONCURRENCY_TIMEOUT_MS);

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
    await expectConsistentWallets(db.orm, await allWalletIds(db.orm));
  }, CONCURRENCY_TIMEOUT_MS);

  afterAll(async () => {
    await events.destroy();
    await db.drop();
  });

  test(
    'dois publishers na mesma outbox: o lote travado por A é pulado por B; cada evento sai uma vez',
    async () => {
      for (let i = 0; i < 100; i += 1) {
        await fixture.openWallet('10.00'); // 2 eventos cada
      }
      const all = await pendingOutboxIds(db.orm);
      expect(all).toHaveLength(200);

      // A trava um lote de 10 e fica parado no SendMessageBatch, com a transação aberta
      const a = await startPublisher(`ob${suffix()}-a`, { OUTBOX_BATCH_SIZE: '10' });
      const held = a.proxy.hold('SendMessageBatch');
      const call = await held.arrived;
      const lockedByA: string[] = call.input.Entries.map((entry: { Id: string }) => entry.Id);
      expect(lockedByA).toHaveLength(10);

      // B, outro processo, publica tudo o que não está travado, sem esperar por A
      const b = await startPublisher(`ob${suffix()}-b`, { OUTBOX_BATCH_SIZE: '50' });
      await waitUntil(
        'só o lote de A pendente',
        async () => (await pendingOutboxCount(db.orm)) === 10,
        20_000,
      );
      expect((await pendingOutboxIds(db.orm)).sort()).toEqual([...lockedByA].sort());
      const sentByB = sentIds(b.proxy);
      expect(sentByB.filter((id) => lockedByA.includes(id))).toEqual([]);

      held.release();
      await outboxDrained();

      // cada evento enviado por exatamente uma instância, e recebido uma vez
      const sent = [...sentIds(a.proxy), ...sentByB];
      expect([...countBy(sent).values()].every((n) => n === 1)).toBe(true);
      expect([...sent].sort()).toEqual([...all].sort());
      const received = await events.drain(200);
      expect(received.map((e) => e.eventId).sort()).toEqual([...all].sort());
    },
    CONCURRENCY_TIMEOUT_MS,
  );

  test(
    'commit confirmado e processo morto antes de publicar: outra instância publica',
    async () => {
      // 1. a API confirma (COMMIT) e morre; nenhum publisher está rodando
      const api = await AppInstance.start(`ob${suffix()}-api`, {
        ROLE: 'api',
        DATABASE_URL: db.url,
      });
      cleanups.push(() => api.kill());
      const wallet = await createWallet(api, '100.00');
      const bet = await submitWager(api, wallet, { kind: 'BET', amount: '40.00' });
      expect(bet.status).toBe(201);
      await crash(api);
      const pending = await pendingOutboxIds(db.orm);
      expect(pending).toHaveLength(4);

      // 2. o publisher A pega o lote e morre antes de a chamada chegar ao SQS
      const a = await startPublisher(`ob${suffix()}-a`);
      const held = a.proxy.hold('SendMessageBatch');
      await held.arrived;
      await crash(a.instance);
      // o rollback desfez a tentativa de A: nada publicado, nenhuma tentativa contada
      expect(
        (await outboxRows(db.orm, pending)).map((row) => [row.attempts, row.publishedAt]),
      ).toEqual(pending.map(() => [0, null]));

      // 3. outra instância assume e publica
      const b = await startPublisher(`ob${suffix()}-b`);
      await outboxDrained();
      expect([...sentIds(b.proxy)].sort()).toEqual([...pending].sort());
      const received = await events.drain(4);
      expect(received.map((e) => e.eventId).sort()).toEqual([...pending].sort());
      expect(
        received.filter((e) => e.envelope.data.transactionId === bet.body.transactionId),
      ).toHaveLength(2);
    },
    CONCURRENCY_TIMEOUT_MS,
  );

  test(
    'publicou e morreu antes do COMMIT: o evento sai duas vezes, e o consumidor deduplica pelo eventId',
    async () => {
      const wallet = await fixture.openWallet('100.00');
      await fixture.wager(wallet, { kind: 'BET', amount: '10.00' });
      await fixture.wager(wallet, { kind: 'WIN', amount: '30.00' });
      const pending = await pendingOutboxIds(db.orm);
      expect(pending).toHaveLength(6);

      // A envia ao SQS (o SQS aceita), mas morre antes de receber a resposta e confirmar
      const a = await startPublisher(`ob${suffix()}-a`);
      const held = a.proxy.holdResponse('SendMessageBatch');
      await held.arrived;
      await crash(a.instance);
      expect(await pendingOutboxCount(db.orm)).toBe(6);

      // B publica de novo: at-least-once
      await startPublisher(`ob${suffix()}-b`);
      await outboxDrained();
      const received = await events.drain(12);
      const copies = countBy(received.map((e) => e.eventId));
      expect([...copies.keys()].sort()).toEqual([...pending].sort());
      expect([...copies.values()].every((n) => n === 2)).toBe(true);
      // as duas cópias são idênticas (mesmo envelope gravado na outbox)
      for (const id of pending) {
        const bodies = new Set(received.filter((e) => e.eventId === id).map((e) => e.body));
        expect(bodies.size).toBe(1);
      }

      // consumidor de referência: inbox persistente por (consumer, eventId) na mesma transação
      // do efeito. Cada evento produz um efeito só, em qualquer ordem de chegada.
      const uow = new MikroOrmUnitOfWork(db.orm, { lockTimeoutMs: 5_000 });
      const consumerName = `events-consumer-${suffix()}`;
      const consume = (event: ReceivedEvent) =>
        uow.run(async (scope) => {
          const hash = createHash('sha256').update(event.body).digest('hex');
          const seen = await scope.inbox.find(consumerName, event.eventId);
          if (seen) {
            seen.assertRedeliveryOf(hash);
            return 'duplicate' as const;
          }
          const inbox = InboxMessage.receive({
            consumerName,
            messageId: event.eventId,
            payloadHash: hash,
            receivedAt: new Date(),
          });
          inbox.markProcessed(new Date());
          await scope.inbox.add(inbox);
          return 'applied' as const;
        });
      const results = [];
      for (const event of received) {
        results.push(await consume(event));
      }
      expect(results.filter((r) => r === 'applied')).toHaveLength(6);
      expect(results.filter((r) => r === 'duplicate')).toHaveLength(6);
    },
    CONCURRENCY_TIMEOUT_MS,
  );
});
