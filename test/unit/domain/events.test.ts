import { describe, expect, test } from 'bun:test';
import { IntegrationEvent } from '../../../src/domain/events/integration-event';
import { WagerTransactionPendingReference } from '../../../src/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../../src/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../../src/domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { Money } from '../../../src/domain/money/money';
import { FailureCode } from '../../../src/domain/wager/failure-code';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';
import { at, brl, T0, WALLET_ID } from './builders';
import { Harness } from './harness';

const ctx = {
  eventId: 'evt-1',
  correlationId: 'corr-1',
  causationId: 'tx-cause',
  occurredAt: at(10),
};

/** Nenhuma instância de Money pode vazar para o payload: só MoneyProps (strings). */
function assertNoMoneyInstances(value: unknown): void {
  if (value instanceof Money) throw new Error('Money vazou para o payload do evento');
  if (value && typeof value === 'object') {
    if ('amount' in value) expect(typeof (value as { amount: unknown }).amount).toBe('string');
    for (const v of Object.values(value)) assertNoMoneyInstances(v);
  }
}

describe('IntegrationEvent', () => {
  test('eventType e version vivem no tipo de cada subclasse', () => {
    const h = new Harness('100.00');
    const tx = h.bet('bet-1', '25.00');
    const result = h.submit(tx);
    expect(result.outcome).toBe('PROCESSED');
    const processed = WagerTransactionProcessed.from(tx, ctx);
    expect(processed).toBeInstanceOf(IntegrationEvent);
    expect(processed.eventType).toBe('WagerTransactionProcessed');
    expect(processed.version).toBe(1);
  });
});

describe('WagerTransactionProcessed', () => {
  test('inclui LOSS (sem mudança de saldo) e carrega MoneyProps', () => {
    const h = new Harness('100.00');
    const loss = h.loss('loss-1', '25.00');
    h.submit(loss);
    const event = WagerTransactionProcessed.from(loss, ctx);
    expect(event.aggregateId).toBe(loss.id);
    expect(event.data).toEqual({
      transactionId: loss.id,
      providerId: 'provider-a',
      externalTransactionId: 'loss-1',
      walletId: WALLET_ID,
      kind: 'LOSS',
      money: { amount: '25.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
    });
    assertNoMoneyInstances(event.data);
  });

  test('inclui referenceTransactionId quando houver', () => {
    const h = new Harness('100.00');
    const bet = h.bet('bet-1', '25.00');
    h.submit(bet);
    const refund = h.refund('refund-1', 'bet-1', '25.00');
    h.submit(refund);
    expect(WagerTransactionProcessed.from(refund, ctx).data.referenceTransactionId).toBe(bet.id);
  });
});

describe('WagerTransactionRejected', () => {
  test('carrega failureCode e a orientação ao provedor', () => {
    const h = new Harness('10.00');
    const bet = h.bet('bet-1', '25.00');
    h.submit(bet);
    const event = WagerTransactionRejected.from(bet, ctx);
    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(event.data.providerAction).toBe('give_up');
    expect(event.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    assertNoMoneyInstances(event.data);
  });

  test('exige transação REJECTED', () => {
    const h = new Harness('100.00');
    expect(() => WagerTransactionRejected.from(h.bet('bet-1', '1.00'), ctx)).toThrow();
  });
});

describe('WagerTransactionPendingReference', () => {
  test('carrega a referência esperada e o instante da próxima tentativa', () => {
    const h = new Harness('100.00');
    const refund = h.refund('refund-1', 'bet-1', '25.00');
    h.submit(refund);
    const event = WagerTransactionPendingReference.from(refund, ctx);
    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.data.referenceExternalTransactionId).toBe('bet-1');
    expect(event.data.nextAttemptAt).toBe((refund.nextAttemptAt as Date).toISOString());
    assertNoMoneyInstances(event.data);
  });
});

describe('WalletBalanceChanged', () => {
  test('só existe com lançamento: carrega direção, valor, saldos e versão da wallet', () => {
    const h = new Harness('100.00');
    const bet = h.bet('bet-1', '80.00');
    const result = h.submit(bet);
    if (result.outcome !== 'PROCESSED' || !result.ledgerEntry)
      throw new Error('esperava lançamento');
    const event = WalletBalanceChanged.from(h.wallet, result.ledgerEntry, ctx);
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.aggregateId).toBe(WALLET_ID);
    expect(event.data).toEqual({
      walletId: WALLET_ID,
      transactionId: bet.id,
      direction: LedgerDirection.Debit,
      money: { amount: '80.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '20.00', currency: 'BRL' },
      walletVersion: 2,
    });
    assertNoMoneyInstances(event.data);
  });
});

describe('toJSON do envelope', () => {
  test('é serializável, estável e com occurredAt ISO-8601', () => {
    const h = new Harness('100.00');
    const loss = h.loss('loss-1', '25.00');
    h.submit(loss);
    const json = WagerTransactionProcessed.from(loss, ctx).toJSON();
    expect(json).toMatchObject({
      eventId: 'evt-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: loss.id,
      correlationId: 'corr-1',
      causationId: 'tx-cause',
      occurredAt: at(10).toISOString(),
      version: 1,
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('causationId é opcional e omitido quando ausente', () => {
    const h = new Harness('100.00');
    const loss = h.loss('loss-1', '25.00');
    h.submit(loss);
    const { causationId: _omit, ...withoutCausation } = ctx;
    const json = WagerTransactionProcessed.from(loss, withoutCausation).toJSON();
    expect('causationId' in json).toBe(false);
  });

  test('data é somente leitura (congelada)', () => {
    const h = new Harness('100.00');
    const loss = h.loss('loss-1', '25.00');
    h.submit(loss);
    const event = WagerTransactionProcessed.from(loss, ctx);
    expect(Object.isFrozen(event.data)).toBe(true);
  });

  test('ids vazios são rejeitados', () => {
    const h = new Harness('100.00');
    const loss = h.loss('loss-1', '25.00');
    h.submit(loss);
    expect(() => WagerTransactionProcessed.from(loss, { ...ctx, correlationId: '' })).toThrow();
  });
});

// referência usada só para silenciar import de T0/brl se o teste mudar
void T0;
void brl;
