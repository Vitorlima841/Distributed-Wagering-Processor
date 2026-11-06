import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { AppInstance } from '../support/cluster';
import {
  CONCURRENCY_TIMEOUT_MS,
  type ConcurrencySuite,
  statusCounts,
  useConcurrencySuite,
} from '../support/concurrency-suite';
import {
  type CreatedWallet,
  type HttpTarget,
  submitRaw,
  type TestResponse,
  type WagerRequest,
  wagerBody,
} from '../support/http-app';
import { outboxByCorrelation, transactionsByKey, walletState } from '../support/inspect';
import { backendsOf, holdWalletLock, waitForWalletLockWaiters, waitUntil } from '../support/sync';

/** Uma operação do provedor: corpo, key e correlationId fixos, para poder reenviar igual. */
interface Operation {
  body: Record<string, unknown>;
  key: string;
  correlationId: string;
}

const operation = (wallet: CreatedWallet, input: WagerRequest): Operation => {
  const body = wagerBody(wallet, input);
  return {
    body,
    key: `${body.providerId}:${body.externalTransactionId}`,
    correlationId: `corr-${randomUUID()}`,
  };
};

const send = (target: HttpTarget, op: Operation): Promise<TestResponse> =>
  submitRaw(target, op.body, op.key, op.correlationId);

/** Espera o Postgres encerrar as conexões das instâncias mortas (transações abertas viram rollback). */
async function waitForBackendsGone(suite: ConcurrencySuite, dead: readonly AppInstance[]) {
  await waitUntil('conexões das instâncias mortas encerradas no Postgres', async () => {
    const counts = await Promise.all(dead.map((i) => backendsOf(suite.orm, i.applicationName)));
    return counts.every((n) => n === 0);
  });
}

/**
 * Seção 13, concorrência 8: reinício do serviço com comprovação da consistência final.
 * As instâncias morrem sem aviso (SIGKILL; TerminateProcess no Windows), como numa queda real:
 * o Postgres desfaz as transações abertas delas e solta os locks; o provedor reenvia com a mesma
 * Idempotency-Key, e cada operação termina aplicada exatamente uma vez.
 */
describe('queda e reinício das instâncias (3 instâncias, Postgres real)', () => {
  const suite = useConcurrencySuite();

  test(
    'instância morta com requisições paradas no lock: nada dela é gravado, as outras seguem, e o retry aplica uma vez',
    async () => {
      const wallet = await suite.openWallet('100.00');
      const victim = suite.cluster.instance(1);
      // 5 apostas pela instância que vai cair, 3 por cada uma das outras
      const plan = [0, 1, 1, 2, 1, 0, 1, 2, 1, 0, 2].map((instance) => ({
        instance,
        op: operation(wallet, { kind: 'BET', amount: '5.00' }),
      }));

      const lock = await holdWalletLock(suite.orm, wallet.id);
      const pending = plan.map(({ instance, op }) =>
        send(suite.cluster.instance(instance), op).then(
          (res) => ({ ok: true as const, res }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      try {
        const waiters = await waitForWalletLockWaiters(suite.orm, `${suite.cluster.id}-`, 11);
        expect(waiters.get(victim.applicationName)).toBe(5);
        await victim.kill();
      } finally {
        await lock.release();
      }
      const results = await Promise.all(pending);
      await waitForBackendsGone(suite, [victim]);

      const victimOps = plan.filter((p) => p.instance === 1).map((p) => p.op);
      results.forEach((result, i) => {
        // quem estava na instância morta perdeu a conexão; as outras responderam normalmente
        expect({ i, ok: result.ok }).toEqual({ i, ok: plan[i]?.instance !== 1 });
        if (result.ok) {
          expect(result.res.status).toBe(201);
        }
      });
      for (const op of victimOps) {
        // a transação da instância morta foi desfeita: nem transação nem evento
        expect(await transactionsByKey(suite.orm, op.key)).toHaveLength(0);
        expect(await outboxByCorrelation(suite.orm, op.correlationId)).toHaveLength(0);
      }
      expect(await walletState(suite.orm, wallet.id)).toMatchObject({
        balance: '70.00',
        version: 7,
      });

      // a instância volta (outra porta, outro processo) e o provedor reenvia o que perdeu
      await suite.cluster.restart(1);
      const retried = await Promise.all(victimOps.map((op, i) => send(suite.cluster.pick(i), op)));
      expect(statusCounts(retried)).toEqual({ 201: 5 });
      const again = await Promise.all(
        victimOps.map((op, i) => send(suite.cluster.pick(i + 1), op)),
      );
      expect(statusCounts(again)).toEqual({ 200: 5 });

      expect(await walletState(suite.orm, wallet.id)).toMatchObject({
        balance: '45.00',
        version: 12,
      });
    },
    CONCURRENCY_TIMEOUT_MS,
  );

  test(
    'reinício completo (mata as 3, sobe 3 novas): replays idênticos, reconciliação consistente e operações novas corretas',
    async () => {
      const wallets = await Promise.all(
        Array.from({ length: 6 }, (_, i) => suite.openWallet('100.00', i)),
      );
      const journal: { op: Operation; first: TestResponse }[] = [];

      // cada wallet percorre todos os desfechos (201, 422, 202), wallets em paralelo
      await Promise.all(
        wallets.map(async (wallet, w) => {
          const run = async (input: WagerRequest, expectedStatus: number) => {
            const op = operation(wallet, input);
            const first = await send(suite.cluster.pick(w + journal.length), op);
            expect({ kind: input.kind, status: first.status }).toEqual({
              kind: input.kind,
              status: expectedStatus,
            });
            journal.push({ op, first });
            return op;
          };
          const bet = await run({ kind: 'BET', amount: '30.00' }, 201);
          const betId = bet.body.externalTransactionId as string;
          const win = await run(
            { kind: 'WIN', amount: '50.00', referenceExternalTransactionId: betId },
            201,
          );
          await run({ kind: 'LOSS', amount: '0.00' }, 201);
          await run({ kind: 'BET', amount: '500.00' }, 422);
          await run(
            { kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: betId },
            201,
          );
          await run(
            {
              kind: 'ROLLBACK',
              amount: '50.00',
              referenceExternalTransactionId: win.body.externalTransactionId as string,
            },
            201,
          );
          await run(
            { kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: `missing-${w}` },
            202,
          );
        }),
      );
      // 100 − 30 + 50 + 30 − 50 = 100.00, com 4 lançamentos depois da abertura (LOSS, a
      // rejeitada e a pendente não movem saldo)
      for (const wallet of wallets) {
        expect(await walletState(suite.orm, wallet.id)).toMatchObject({
          balance: '100.00',
          version: 5,
        });
      }

      const before = [...suite.cluster.instances];
      await suite.cluster.restartAll();
      await waitForBackendsGone(suite, before);
      expect(suite.cluster.instances.every((i) => !before.includes(i))).toBe(true);

      // a idempotência está no Postgres, não na memória dos processos que morreram
      const replays = await Promise.all(
        journal.map(({ op }, i) => send(suite.cluster.pick(i), op)),
      );
      journal.forEach(({ first }, i) => {
        const replay = replays[i];
        expect(replay?.status).toBe(first.status === 201 ? 200 : first.status);
        expect(replay?.body).toEqual({ ...first.body, idempotentReplay: true });
      });

      for (const [w, wallet] of wallets.entries()) {
        const report = await suite.cluster
          .pick(w)
          .request('POST', `/wallets/${wallet.id}/reconciliation`);
        expect(report.status).toBe(200);
        expect(report.body).toMatchObject({
          storedBalance: { amount: '100.00', currency: 'BRL' },
          calculatedBalance: { amount: '100.00', currency: 'BRL' },
          difference: { amount: '0.00', currency: 'BRL' },
          consistent: true,
          checkedEntries: 5,
        });
      }

      // o serviço reiniciado continua processando normalmente
      const after = await Promise.all(
        wallets.map((wallet, w) =>
          send(suite.cluster.pick(w), operation(wallet, { kind: 'BET', amount: '1.00' })),
        ),
      );
      for (const res of after) {
        expect(res.status).toBe(201);
        expect(res.body.balance).toEqual({ amount: '99.00', currency: 'BRL' });
      }
    },
    CONCURRENCY_TIMEOUT_MS,
  );

  test(
    'as 3 instâncias caem no meio de uma carga; o retry de tudo aplica cada operação exatamente uma vez',
    async () => {
      // carga: 10 wallets × 12 operações; nenhuma rejeição possível em qualquer ordem, então o
      // final é um só: 100.00 − 6 × 5.00 + 6 × 2.50 = 85.00
      const loadWallets = await Promise.all(
        Array.from({ length: 10 }, (_, i) => suite.openWallet('100.00', i)),
      );
      const load = loadWallets.flatMap((wallet) =>
        Array.from({ length: 12 }, (_, k) =>
          operation(
            wallet,
            k % 2 === 0 ? { kind: 'BET', amount: '5.00' } : { kind: 'WIN', amount: '2.50' },
          ),
        ),
      );
      // uma wallet travada pelo teste garante requisições em voo no momento da queda
      const pinned = await suite.openWallet('100.00');
      const pinnedOps = [0, 1, 2].map(() => operation(pinned, { kind: 'BET', amount: '5.00' }));

      const lock = await holdWalletLock(suite.orm, pinned.id);
      const capture = (promise: Promise<TestResponse>) =>
        promise.then(
          (res) => ({ ok: true as const, res }),
          () => ({ ok: false as const }),
        );
      let pinnedResults: { ok: boolean }[] = [];
      let loadResults: { ok: boolean; res?: TestResponse }[] = [];
      const before = [...suite.cluster.instances];
      try {
        const pinnedPending = pinnedOps.map((op, i) => capture(send(suite.cluster.pick(i), op)));
        await waitForWalletLockWaiters(suite.orm, `${suite.cluster.id}-`, 3);

        let answered = 0;
        const firstAnswers = Promise.withResolvers<void>();
        const loadPending = load.map((op, i) =>
          capture(send(suite.cluster.pick(i), op)).then((result) => {
            answered += 1;
            if (answered === 30) {
              firstAnswers.resolve();
            }
            return result;
          }),
        );
        // queda num ponto arbitrário da carga: depois das 30 primeiras respostas
        await firstAnswers.promise;
        await Promise.all(before.map((instance) => instance.kill()));
        [pinnedResults, loadResults] = await Promise.all([
          Promise.all(pinnedPending),
          Promise.all(loadPending),
        ]);
      } finally {
        await lock.release();
      }
      await waitForBackendsGone(suite, before);

      // as requisições presas no lock da wallet travada não chegaram ao commit
      expect(pinnedResults.map((r) => r.ok)).toEqual([false, false, false]);
      for (const op of pinnedOps) {
        expect(await transactionsByKey(suite.orm, op.key)).toHaveLength(0);
      }
      expect(loadResults.filter((r) => r.ok).length).toBeGreaterThanOrEqual(30);

      // sobe a geração nova e o provedor reenvia tudo, com as mesmas keys
      await suite.cluster.restartAll();
      const all = [...load, ...pinnedOps];
      const retried = await Promise.all(all.map((op, i) => send(suite.cluster.pick(i), op)));
      retried.forEach((res, i) => {
        const earlier = i < load.length ? loadResults[i] : undefined;
        if (earlier?.ok) {
          // já tinha resposta: o retry é replay do mesmo resultado
          expect(res.status).toBe(200);
          expect(res.body).toEqual({ ...earlier.res?.body, idempotentReplay: true });
        } else {
          // perdeu a resposta: ou não chegou ao commit (201 agora) ou chegou e a resposta se
          // perdeu na queda (200, replay); nunca uma segunda aplicação
          expect([200, 201]).toContain(res.status);
        }
      });

      for (const op of all) {
        expect(await transactionsByKey(suite.orm, op.key)).toHaveLength(1);
      }
      for (const wallet of [...loadWallets, pinned]) {
        const expected =
          wallet === pinned ? { balance: '85.00', version: 4 } : { balance: '85.00', version: 13 };
        expect(await walletState(suite.orm, wallet.id)).toMatchObject(expected);
      }
    },
    CONCURRENCY_TIMEOUT_MS,
  );
});
