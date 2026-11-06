import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain';
import {
  CONCURRENCY_TIMEOUT_MS,
  fireThroughWalletLock,
  statusCounts,
  useConcurrencySuite,
} from '../support/concurrency-suite';
import { submitRaw, submitWager, wagerBody } from '../support/http-app';
import { ledgerOf, transactionsOfWallet, walletState } from '../support/inspect';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

/**
 * Hot wallet: muitas operações diferentes disputando o mesmo saldo, de 3 processos ao mesmo
 * tempo. A ordem em que o Postgres entrega o lock varia de execução para execução; as asserções
 * valem para qualquer ordem (sem lost update, sem saldo negativo, cada rejeição justificada pelo
 * saldo daquele instante, um lançamento por transação aplicada).
 */
describe('hot wallet (3 instâncias, Postgres real)', () => {
  const suite = useConcurrencySuite();

  test(
    '45 operações (BET, WIN, LOSS) presas no lock ao mesmo tempo → saldo e ledger exatos para a ordem que aconteceu',
    async () => {
      const wallet = await suite.openWallet('100.00');
      // BET de 10.00, WIN de 5.00 e LOSS intercalados: débitos possíveis (240.00) passam muito
      // do que existe (100.00 + 60.00), então parte das BET é rejeitada conforme a ordem
      const kinds = Array.from({ length: 45 }, (_, i) =>
        i % 5 === 4 ? 'LOSS' : i % 3 === 1 ? 'WIN' : 'BET',
      );
      expect(['BET', 'WIN', 'LOSS'].map((k) => kinds.filter((kind) => kind === k).length)).toEqual([
        24, 12, 9,
      ]);
      const amountOf: Record<string, string> = { BET: '10.00', WIN: '5.00', LOSS: '0.00' };
      const bodies = kinds.map((kind) =>
        wagerBody(wallet, { kind, amount: amountOf[kind] ?? '0.00' }),
      );

      const { responses, waitersByInstance } = await fireThroughWalletLock(
        suite,
        wallet.id,
        bodies.map(
          (body, i) => () =>
            submitRaw(
              suite.cluster.pick(i),
              body,
              `${body.providerId}:${body.externalTransactionId}`,
            ),
        ),
      );
      expect([...waitersByInstance.values()].sort()).toEqual([15, 15, 15]);

      let expected = brl('100.00');
      let processedMovements = 0;
      const ledger = await ledgerOf(suite.orm, wallet.id);
      const entryOf = new Map(ledger.map((entry) => [entry.transactionId, entry]));
      for (const [i, kind] of kinds.entries()) {
        const res = responses[i];
        if (!res) {
          throw new Error(`sem resposta para a operação ${i}`);
        }
        if (kind === 'BET' && res.status === 422) {
          // rejeição justificada: o saldo daquele instante não cobria a aposta
          expect(res.body.failureCode).toBe('INSUFFICIENT_FUNDS');
          expect(brl(res.body.balance.amount).isLessThan(brl('10.00'))).toBe(true);
          continue;
        }
        expect({ i, kind, status: res.status }).toEqual({ i, kind, status: 201 });
        if (kind === 'LOSS') {
          expect(entryOf.has(res.body.transactionId)).toBe(false);
          continue;
        }
        processedMovements += 1;
        expected = kind === 'BET' ? expected.subtract(brl('10.00')) : expected.add(brl('5.00'));
        // o saldo devolvido é o saldo depois do próprio lançamento
        expect(res.body.balance.amount).toBe(entryOf.get(res.body.transactionId)?.balanceAfter);
      }

      expect(ledger).toHaveLength(1 + processedMovements);
      expect(await walletState(suite.orm, wallet.id)).toMatchObject({
        balance: expected.toJSON().amount,
        version: 1 + processedMovements,
      });
    },
    CONCURRENCY_TIMEOUT_MS,
  );

  test(
    'REFUND, ROLLBACK e um REFUND duplicado da mesma BET ao mesmo tempo → um único crédito',
    async () => {
      const wallet = await suite.openWallet('100.00');
      const bet = await submitWager(suite.cluster.pick(0), wallet, {
        kind: 'BET',
        amount: '30.00',
      });
      expect(bet.status).toBe(201);

      const reversal = (kind: 'REFUND' | 'ROLLBACK') =>
        wagerBody(wallet, {
          kind,
          amount: '30.00',
          referenceExternalTransactionId: bet.externalTransactionId,
        });
      const refund = reversal('REFUND');
      const rollback = reversal('ROLLBACK');
      const keyOf = (body: Record<string, unknown>) =>
        `${body.providerId}:${body.externalTransactionId}`;

      const { responses, waitersByInstance } = await fireThroughWalletLock(suite, wallet.id, [
        () => submitRaw(suite.cluster.pick(0), refund, keyOf(refund)),
        () => submitRaw(suite.cluster.pick(1), rollback, keyOf(rollback)),
        () => submitRaw(suite.cluster.pick(2), refund, keyOf(refund)),
      ]);
      expect(waitersByInstance.size).toBe(3);
      const [refundA, rollbackRes, refundB] = responses;

      // as duas cópias do REFUND são a mesma transação (uma criou, a outra é replay)
      expect(refundA?.body.transactionId).toBe(refundB?.body.transactionId);
      expect([refundA?.body.idempotentReplay, refundB?.body.idempotentReplay].sort()).toEqual([
        false,
        true,
      ]);
      // exatamente uma reversão aplicada; a outra rejeitada como já revertida
      const outcomes = [refundA?.body.status, rollbackRes?.body.status];
      expect(outcomes.sort()).toEqual(['PROCESSED', 'REJECTED']);
      const loser = refundA?.body.status === 'REJECTED' ? refundA : rollbackRes;
      expect(loser?.body.failureCode).toBe('ALREADY_REVERSED');

      const reversals = (await transactionsOfWallet(suite.orm, wallet.id)).filter(
        (t) => t.kind === 'REFUND' || t.kind === 'ROLLBACK',
      );
      expect(reversals.map((t) => t.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
      expect((await ledgerOf(suite.orm, wallet.id)).map((e) => [e.direction, e.amount])).toEqual([
        ['CREDIT', '100.00'],
        ['DEBIT', '30.00'],
        ['CREDIT', '30.00'],
      ]);
      expect(await walletState(suite.orm, wallet.id)).toMatchObject({
        balance: '100.00',
        version: 3,
      });
    },
    CONCURRENCY_TIMEOUT_MS,
  );

  test(
    'ROLLBACK de um WIN e uma BET disputando o mesmo saldo → um débito; a outra rejeitada com o código do seu tipo',
    async () => {
      const wallet = await suite.openWallet('0.00');
      const win = await submitWager(suite.cluster.pick(0), wallet, {
        kind: 'WIN',
        amount: '50.00',
      });
      expect(win.status).toBe(201);
      const rollback = wagerBody(wallet, {
        kind: 'ROLLBACK',
        amount: '50.00',
        referenceExternalTransactionId: win.externalTransactionId,
      });
      const betBody = wagerBody(wallet, { kind: 'BET', amount: '50.00' });
      const keyOf = (body: Record<string, unknown>) =>
        `${body.providerId}:${body.externalTransactionId}`;

      const { responses } = await fireThroughWalletLock(suite, wallet.id, [
        () => submitRaw(suite.cluster.pick(1), rollback, keyOf(rollback)),
        () => submitRaw(suite.cluster.pick(2), betBody, keyOf(betBody)),
      ]);
      const [rollbackRes, betRes] = responses;
      expect(statusCounts(responses)).toEqual({ 201: 1, 422: 1 });
      // reversão sem saldo tem código próprio, distinto de aposta sem saldo (regra 9)
      if (rollbackRes?.status === 201) {
        expect(betRes?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      } else {
        expect(rollbackRes?.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
      }
      expect((await ledgerOf(suite.orm, wallet.id)).map((e) => e.direction)).toEqual([
        'CREDIT',
        'DEBIT',
      ]);
      expect(await walletState(suite.orm, wallet.id)).toMatchObject({
        balance: '0.00',
        version: 3,
      });
    },
    CONCURRENCY_TIMEOUT_MS,
  );
});
