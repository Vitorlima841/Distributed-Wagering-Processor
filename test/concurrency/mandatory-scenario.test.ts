import { describe, expect, test } from 'bun:test';
import {
  CONCURRENCY_TIMEOUT_MS,
  fireThroughWalletLock,
  statusCounts,
  useConcurrencySuite,
} from '../support/concurrency-suite';
import { type CreatedWallet, submitRaw, type TestResponse, wagerBody } from '../support/http-app';
import { ledgerOf, transactionsOfWallet, walletState } from '../support/inspect';

/**
 * Seção 8, cenário obrigatório: saldo 100.00 BRL e duas apostas de 80.00 simultâneas.
 * Esperado: exatamente uma PROCESSED, a outra REJECTED por saldo insuficiente, saldo final 20.00,
 * exatamente um DEBIT no ledger, e nenhum retry duplica o débito.
 */
describe('cenário obrigatório: 100.00 e duas BET de 80.00 (3 instâncias, Postgres real)', () => {
  const suite = useConcurrencySuite();

  const twoBets = (wallet: CreatedWallet) => {
    const bodies = [0, 1].map(() => wagerBody(wallet, { kind: 'BET', amount: '80.00' }));
    return bodies.map((body) => ({
      body,
      key: `${body.providerId}:${body.externalTransactionId}`,
    }));
  };

  const expectOneProcessedOneRejected = async (
    wallet: CreatedWallet,
    responses: readonly TestResponse[],
  ): Promise<void> => {
    expect(statusCounts(responses)).toEqual({ 201: 1, 422: 1 });
    const processed = responses.find((r) => r.status === 201)?.body;
    const rejected = responses.find((r) => r.status === 422)?.body;
    expect(processed).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '20.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    // a rejeitada viu o saldo depois do débito da outra (o lock serializou as duas)
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      providerAction: 'give_up',
      balance: { amount: '20.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    expect(await walletState(suite.orm, wallet.id)).toMatchObject({
      balance: '20.00',
      version: 2,
    });
    const ledger = await ledgerOf(suite.orm, wallet.id);
    expect(ledger.filter((e) => e.direction === 'DEBIT')).toEqual([
      expect.objectContaining({
        transactionId: processed.transactionId,
        amount: '80.00',
        balanceBefore: '100.00',
        balanceAfter: '20.00',
      }),
    ]);
    const bets = (await transactionsOfWallet(suite.orm, wallet.id)).filter((t) => t.kind === 'BET');
    expect(bets.map((t) => [t.id, t.status, t.failureCode]).sort()).toEqual(
      [
        [processed.transactionId, 'PROCESSED', null],
        [rejected.transactionId, 'REJECTED', 'INSUFFICIENT_FUNDS'],
      ].sort(),
    );
  };

  test(
    'as duas esperam o lock ao mesmo tempo, vindas de instâncias diferentes; retries não duplicam o débito',
    async () => {
      const wallet = await suite.openWallet('100.00');
      const bets = twoBets(wallet);

      const { responses, waitersByInstance } = await fireThroughWalletLock(
        suite,
        wallet.id,
        bets.map(
          ({ body, key }, i) =>
            () =>
              submitRaw(suite.cluster.pick(i), body, key),
        ),
      );
      expect([...waitersByInstance.values()]).toEqual([1, 1]);
      await expectOneProcessedOneRejected(wallet, responses);

      // retries das duas (at-least-once), cada uma por todas as instâncias ao mesmo tempo
      const retries = await Promise.all(
        bets.flatMap(({ body, key }) =>
          suite.cluster.instances.map((instance) => submitRaw(instance, body, key)),
        ),
      );
      const originalOf = (key: string) => {
        const index = bets.findIndex((bet) => bet.key === key);
        return responses[index];
      };
      bets.forEach(({ key }, b) => {
        const original = originalOf(key);
        for (const retry of retries.slice(b * 3, (b + 1) * 3)) {
          // replay: mesmo resultado e mesmo saldo observado; 201 vira 200, 422 continua 422
          expect(retry.status).toBe(original?.status === 201 ? 200 : 422);
          expect(retry.body).toEqual({ ...original?.body, idempotentReplay: true });
        }
      });
      expect((await ledgerOf(suite.orm, wallet.id)).map((e) => e.direction)).toEqual([
        'CREDIT',
        'DEBIT',
      ]);
      expect(await walletState(suite.orm, wallet.id)).toMatchObject({ balance: '20.00' });
    },
    CONCURRENCY_TIMEOUT_MS,
  );

  test(
    'em rajada, sem barreira, em 20 wallets ao mesmo tempo → o mesmo resultado em todas',
    async () => {
      const wallets = await Promise.all(
        Array.from({ length: 20 }, (_, i) => suite.openWallet('100.00', i)),
      );
      const perWallet = wallets.map(twoBets);
      const responses = await Promise.all(
        perWallet.flatMap((bets, w) =>
          bets.map(({ body, key }, i) => submitRaw(suite.cluster.pick(w + i), body, key)),
        ),
      );
      for (const [w, wallet] of wallets.entries()) {
        await expectOneProcessedOneRejected(wallet, responses.slice(w * 2, w * 2 + 2));
      }
    },
    CONCURRENCY_TIMEOUT_MS,
  );
});
