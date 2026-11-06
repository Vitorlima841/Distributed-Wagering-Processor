import { describe, expect, test } from 'bun:test';
import {
  CONCURRENCY_TIMEOUT_MS,
  statusCounts,
  useConcurrencySuite,
} from '../support/concurrency-suite';
import { submitWager, type TestResponse } from '../support/http-app';
import { ledgerOf, walletState } from '../support/inspect';
import { holdWalletLock, lockWaitersByInstance, waitForWalletLockWaiters } from '../support/sync';

/**
 * Seção 13, concorrência 3: wallets distintas processadas em paralelo. O lock é por linha da
 * wallet (restrição 6: nada de lock global), então uma wallet travada não segura as outras.
 */
describe('wallets distintas em paralelo (3 instâncias, Postgres real)', () => {
  const suite = useConcurrencySuite();

  test(
    'com a wallet A travada e uma requisição esperando por ela, 27 operações em outras 9 wallets terminam',
    async () => {
      const [walletA, ...others] = await Promise.all(
        Array.from({ length: 10 }, (_, i) => suite.openWallet('100.00', i)),
      );
      if (!walletA) {
        throw new Error('wallet A não criada');
      }

      const lock = await holdWalletLock(suite.orm, walletA.id);
      let blockedSettled = false;
      const blocked = submitWager(suite.cluster.pick(0), walletA, {
        kind: 'BET',
        amount: '10.00',
      }).finally(() => {
        blockedSettled = true;
      });
      try {
        await waitForWalletLockWaiters(suite.orm, `${suite.cluster.id}-`, 1, {
          settled: () => (blockedSettled ? 1 : 0),
        });

        // inclusive pela instância 0, que tem uma requisição parada no lock de A
        const responses = await Promise.all(
          others.flatMap((wallet, w) =>
            (['BET', 'WIN', 'LOSS'] as const).map((kind, k) =>
              submitWager(suite.cluster.pick(w + k), wallet, {
                kind,
                amount: kind === 'LOSS' ? '0.00' : '10.00',
              }),
            ),
          ),
        );
        expect(statusCounts(responses)).toEqual({ 201: 27 });

        // A continua travada e a requisição dela continua esperando
        expect(blockedSettled).toBe(false);
        expect([
          ...(await lockWaitersByInstance(suite.orm, `${suite.cluster.id}-`)).values(),
        ]).toEqual([1]);
        for (const wallet of others) {
          expect(await walletState(suite.orm, wallet.id)).toMatchObject({
            balance: '100.00',
            version: 3,
          });
        }
      } finally {
        await lock.release();
      }

      const resA = await blocked;
      expect(resA.status).toBe(201);
      expect(resA.body.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    },
    CONCURRENCY_TIMEOUT_MS,
  );

  test(
    '20 wallets × 10 operações disparadas juntas pelas 3 instâncias → saldo final exato em cada',
    async () => {
      const wallets = await Promise.all(
        Array.from({ length: 20 }, (_, i) => suite.openWallet('100.00', i)),
      );
      // 5 BET de 10.00 e 5 WIN de 7.50 por wallet: nenhuma rejeição possível em qualquer ordem,
      // então o resultado final é um só: 100.00 − 50.00 + 37.50 = 87.50
      const plan = wallets.flatMap((wallet, w) =>
        Array.from({ length: 10 }, (_, k) => ({
          wallet,
          instance: w * 10 + k,
          kind: k % 2 === 0 ? 'BET' : 'WIN',
          amount: k % 2 === 0 ? '10.00' : '7.50',
        })),
      );
      const responses: TestResponse[] = await Promise.all(
        plan.map(({ wallet, instance, kind, amount }) =>
          submitWager(suite.cluster.pick(instance), wallet, { kind, amount }),
        ),
      );
      expect(statusCounts(responses)).toEqual({ 201: 200 });
      for (const wallet of wallets) {
        expect(await walletState(suite.orm, wallet.id)).toMatchObject({
          balance: '87.50',
          version: 11,
        });
        expect(await ledgerOf(suite.orm, wallet.id)).toHaveLength(11);
      }
    },
    CONCURRENCY_TIMEOUT_MS,
  );
});
