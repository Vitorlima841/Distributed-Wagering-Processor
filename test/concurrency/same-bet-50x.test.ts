import { describe, expect, test } from 'bun:test';
import {
  CONCURRENCY_TIMEOUT_MS,
  fireThroughWalletLock,
  statusCounts,
  useConcurrencySuite,
} from '../support/concurrency-suite';
import { submitRaw, wagerBody } from '../support/http-app';
import { ledgerOf, outboxEventTypes, transactionsByKey, walletState } from '../support/inspect';

/**
 * Seção 13, concorrência 1: a mesma aposta enviada 50 vezes em paralelo → um único débito.
 * As 50 cópias (mesma Idempotency-Key, mesmo payload) saem por 3 processos diferentes.
 */
describe('mesma aposta 50x em paralelo (3 instâncias, Postgres real)', () => {
  const suite = useConcurrencySuite();
  const COPIES = 50;

  test(
    'todas esperam o lock da wallet ao mesmo tempo → um 201, 49 replays, um débito',
    async () => {
      const wallet = await suite.openWallet('100.00');
      const body = wagerBody(wallet, { kind: 'BET', amount: '10.00' });
      const key = `${body.providerId}:${body.externalTransactionId}`;

      const { responses, waitersByInstance } = await fireThroughWalletLock(
        suite,
        wallet.id,
        Array.from({ length: COPIES }, (_, i) => () => submitRaw(suite.cluster.pick(i), body, key)),
      );

      // simultaneidade comprovada: as 50 estavam paradas no lock, vindas das 3 instâncias
      expect(waitersByInstance.size).toBe(3);
      expect([...waitersByInstance.values()].reduce((a, b) => a + b, 0)).toBe(COPIES);

      expect(statusCounts(responses)).toEqual({ 201: 1, 200: COPIES - 1 });
      const original = responses.find((r) => r.status === 201)?.body;
      expect(original).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '90.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      for (const replay of responses.filter((r) => r.status === 200)) {
        expect(replay.body).toEqual({ ...original, idempotentReplay: true });
      }

      expect(await transactionsByKey(suite.orm, key)).toHaveLength(1);
      const ledger = await ledgerOf(suite.orm, wallet.id);
      expect(ledger.map((e) => [e.direction, e.amount])).toEqual([
        ['CREDIT', '100.00'],
        ['DEBIT', '10.00'],
      ]);
      expect(await walletState(suite.orm, wallet.id)).toMatchObject({
        balance: '90.00',
        version: 2,
      });
      expect(await outboxEventTypes(suite.orm, original.transactionId)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
    },
    CONCURRENCY_TIMEOUT_MS,
  );

  test(
    'em rajada, sem barreira (parte cai no replay sem lock), repetida em 10 wallets → um débito cada',
    async () => {
      const wallets = await Promise.all(
        Array.from({ length: 10 }, (_, i) => suite.openWallet('100.00', i)),
      );
      const bodies = wallets.map((wallet) => wagerBody(wallet, { kind: 'BET', amount: '10.00' }));
      const keyOf = (body: Record<string, unknown>) =>
        `${body.providerId}:${body.externalTransactionId}`;

      // 10 wallets × 50 cópias = 500 requisições disparadas juntas pelas 3 instâncias
      const responses = await Promise.all(
        bodies.flatMap((body, w) =>
          Array.from({ length: COPIES }, (_, i) =>
            submitRaw(suite.cluster.pick(w + i), body, keyOf(body)),
          ),
        ),
      );

      for (const [w, wallet] of wallets.entries()) {
        const ofWallet = responses.slice(w * COPIES, (w + 1) * COPIES);
        expect(statusCounts(ofWallet)).toEqual({ 201: 1, 200: COPIES - 1 });
        expect(new Set(ofWallet.map((r) => r.body.transactionId)).size).toBe(1);
        expect(await walletState(suite.orm, wallet.id)).toMatchObject({
          balance: '90.00',
          version: 2,
        });
      }
    },
    CONCURRENCY_TIMEOUT_MS,
  );
});
