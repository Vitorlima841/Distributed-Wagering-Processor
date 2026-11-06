import { describe, expect, test } from 'bun:test';
import {
  InvalidFieldError,
  InvalidTransactionKindError,
  InvalidTransactionStateError,
} from '../../../src/domain/errors';
import { FailureCode } from '../../../src/domain/wager/failure-code';
import { WagerPolicy } from '../../../src/domain/wager/wager-policy';
import {
  WagerTransactionStatus as Status,
  WagerTransaction,
} from '../../../src/domain/wager/wager-transaction';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';
import { at, brl, nextId, PLAYER_ID, T0, usd, WALLET_ID } from './builders';
import { Harness } from './harness';

const balance = (h: Harness) => h.wallet.balance.toString();

describe('BET', () => {
  test('debita, gera 1 lançamento DEBIT e guarda o snapshot', () => {
    const h = new Harness('100.00');
    const bet = h.bet('bet-1', '25.00');
    const result = h.submit(bet);
    expect(result.outcome).toBe('PROCESSED');
    expect(bet.status).toBe(Status.Processed);
    expect(bet.balanceAfter?.toString()).toBe('75.00 BRL');
    expect(balance(h)).toBe('75.00 BRL');
    expect(h.wallet.version).toBe(2);
    expect(h.entries).toHaveLength(2); // opening + débito
    expect(h.entries[1]?.direction).toBe(LedgerDirection.Debit);
    expect(h.entries[1]?.transactionId).toBe(bet.id);
    h.expectConsistent(expect);
  });

  test('saldo insuficiente → REJECTED/INSUFFICIENT_FUNDS, sem lançamento e sem tocar na wallet', () => {
    const h = new Harness('10.00');
    const bet = h.bet('bet-1', '10.01');
    const result = h.submit(bet);
    expect(result).toEqual({ outcome: 'REJECTED', failureCode: FailureCode.InsufficientFunds });
    expect(bet.status).toBe(Status.Rejected);
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(bet.balanceAfter?.toString()).toBe('10.00 BRL');
    expect(balance(h)).toBe('10.00 BRL');
    expect(h.wallet.version).toBe(1);
    expect(h.entries).toHaveLength(1);
    h.expectConsistent(expect);
  });

  test('aposta de todo o saldo é aceita e zera a wallet', () => {
    const h = new Harness('80.00');
    expect(h.submit(h.bet('bet-1', '80.00')).outcome).toBe('PROCESSED');
    expect(balance(h)).toBe('0.00 BRL');
  });

  test('cenário obrigatório (sequencial): 100.00 e duas BET de 80.00 → 1 PROCESSED, 1 REJECTED, saldo 20.00', () => {
    const h = new Harness('100.00');
    const a = h.bet('bet-a', '80.00');
    const b = h.bet('bet-b', '80.00');
    const outcomes = [h.submit(a).outcome, h.submit(b).outcome].sort();
    expect(outcomes).toEqual(['PROCESSED', 'REJECTED']);
    expect(balance(h)).toBe('20.00 BRL');
    expect(h.entries.filter((e) => e.direction === LedgerDirection.Debit)).toHaveLength(1);
    h.expectConsistent(expect);
  });
});

describe('WIN', () => {
  test('credita e gera 1 lançamento CREDIT', () => {
    const h = new Harness('100.00');
    const win = h.win('win-1', '50.50');
    expect(h.submit(win).outcome).toBe('PROCESSED');
    expect(balance(h)).toBe('150.50 BRL');
    expect(h.entries[1]?.direction).toBe(LedgerDirection.Credit);
    h.expectConsistent(expect);
  });

  test('referência informada em WIN é só informativa (não bloqueia nem vira PENDING_REFERENCE)', () => {
    const h = new Harness('100.00');
    const win = h.win('win-1', '10.00', { referenceExternalTransactionId: 'bet-inexistente' });
    expect(h.submit(win).outcome).toBe('PROCESSED');
    expect(win.referenceTransactionId).toBeUndefined();
  });
});

describe('LOSS', () => {
  test('PROCESSED sem mover saldo e sem lançamento; version não muda', () => {
    const h = new Harness('100.00');
    const loss = h.loss('loss-1', '25.00');
    expect(h.submit(loss)).toEqual({ outcome: 'PROCESSED' });
    expect(loss.status).toBe(Status.Processed);
    expect(loss.balanceAfter?.toString()).toBe('100.00 BRL');
    expect(balance(h)).toBe('100.00 BRL');
    expect(h.wallet.version).toBe(1);
    expect(h.entries).toHaveLength(1);
    h.expectConsistent(expect);
  });
});

describe('REFUND', () => {
  test('reverte uma BET PROCESSED: credita o valor e liga à referência', () => {
    const h = new Harness('100.00');
    const bet = h.bet('bet-1', '30.00');
    h.submit(bet);
    const refund = h.refund('refund-1', 'bet-1', '30.00');
    const result = h.submit(refund);
    expect(result.outcome).toBe('PROCESSED');
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(balance(h)).toBe('100.00 BRL');
    expect(h.entries.at(-1)?.direction).toBe(LedgerDirection.Credit);
    h.expectConsistent(expect);
  });

  test('segunda reversão da mesma BET → ALREADY_REVERSED, sem novo lançamento', () => {
    const h = new Harness('100.00');
    h.submit(h.bet('bet-1', '30.00'));
    h.submit(h.refund('refund-1', 'bet-1', '30.00'));
    const entriesBefore = h.entries.length;
    const second = h.refund('refund-2', 'bet-1', '30.00');
    expect(h.submit(second)).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.AlreadyReversed,
    });
    expect(h.entries).toHaveLength(entriesBefore);
    expect(balance(h)).toBe('100.00 BRL');
    h.expectConsistent(expect);
  });

  test('REFUND de WIN → REFERENCE_INVALID_KIND', () => {
    const h = new Harness('100.00');
    h.submit(h.win('win-1', '10.00'));
    expect(h.submit(h.refund('refund-1', 'win-1', '10.00'))).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.ReferenceInvalidKind,
    });
    expect(balance(h)).toBe('110.00 BRL');
  });

  test('valor diferente → AMOUNT_MISMATCH', () => {
    const h = new Harness('100.00');
    h.submit(h.bet('bet-1', '30.00'));
    expect(h.submit(h.refund('refund-1', 'bet-1', '29.99'))).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.AmountMismatch,
    });
  });

  test('referência de outra rodada → REFERENCE_MISMATCH', () => {
    const h = new Harness('100.00');
    h.submit(h.bet('bet-1', '30.00', { roundId: 'round-A' }));
    expect(h.submit(h.refund('refund-1', 'bet-1', '30.00', { roundId: 'round-B' }))).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.ReferenceMismatch,
    });
  });

  test('BET rejeitada não pode ser reembolsada → REFERENCE_NOT_PROCESSED', () => {
    const h = new Harness('10.00');
    h.submit(h.bet('bet-1', '30.00'));
    expect(h.submit(h.refund('refund-1', 'bet-1', '30.00'))).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.ReferenceNotProcessed,
    });
    expect(balance(h)).toBe('10.00 BRL');
  });
});

describe('ROLLBACK', () => {
  test('de BET: inverte o débito (CREDIT)', () => {
    const h = new Harness('100.00');
    h.submit(h.bet('bet-1', '40.00'));
    expect(h.submit(h.rollback('rb-1', 'bet-1', '40.00')).outcome).toBe('PROCESSED');
    expect(balance(h)).toBe('100.00 BRL');
    expect(h.entries.at(-1)?.direction).toBe(LedgerDirection.Credit);
    h.expectConsistent(expect);
  });

  test('de WIN: inverte o crédito (DEBIT)', () => {
    const h = new Harness('100.00');
    h.submit(h.win('win-1', '40.00'));
    expect(h.submit(h.rollback('rb-1', 'win-1', '40.00')).outcome).toBe('PROCESSED');
    expect(balance(h)).toBe('100.00 BRL');
    expect(h.entries.at(-1)?.direction).toBe(LedgerDirection.Debit);
    h.expectConsistent(expect);
  });

  test('de REFUND: inverte o crédito do reembolso (DEBIT)', () => {
    const h = new Harness('100.00');
    h.submit(h.bet('bet-1', '40.00'));
    h.submit(h.refund('refund-1', 'bet-1', '40.00'));
    expect(h.submit(h.rollback('rb-1', 'refund-1', '40.00')).outcome).toBe('PROCESSED');
    expect(balance(h)).toBe('60.00 BRL');
    h.expectConsistent(expect);
  });

  test('de LOSS ou de ROLLBACK → REFERENCE_INVALID_KIND', () => {
    const h = new Harness('100.00');
    h.submit(h.loss('loss-1', '10.00'));
    expect(h.submit(h.rollback('rb-1', 'loss-1', '10.00'))).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.ReferenceInvalidKind,
    });
    h.submit(h.win('win-1', '10.00'));
    h.submit(h.rollback('rb-2', 'win-1', '10.00'));
    expect(h.submit(h.rollback('rb-3', 'rb-2', '10.00'))).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.ReferenceInvalidKind,
    });
  });

  test('reversão que deixaria saldo negativo → REVERSAL_INSUFFICIENT_FUNDS (≠ INSUFFICIENT_FUNDS)', () => {
    const h = new Harness('0.00');
    h.submit(h.win('win-1', '50.00')); // saldo 50
    h.submit(h.bet('bet-1', '50.00')); // saldo 0
    const rollback = h.rollback('rb-1', 'win-1', '50.00');
    const result = h.submit(rollback);
    expect(result).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.ReversalInsufficientFunds,
    });
    expect(rollback.status).toBe(Status.Rejected); // permanece auditável
    expect(balance(h)).toBe('0.00 BRL');
    expect(h.entries.filter((e) => e.transactionId === rollback.id)).toHaveLength(0);
    h.expectConsistent(expect);
  });

  test('REFUND + ROLLBACK da mesma BET não creditam duas vezes', () => {
    const h = new Harness('100.00');
    h.submit(h.bet('bet-1', '30.00'));
    h.submit(h.refund('refund-1', 'bet-1', '30.00'));
    expect(h.submit(h.rollback('rb-1', 'bet-1', '30.00'))).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.AlreadyReversed,
    });
    expect(balance(h)).toBe('100.00 BRL');
    h.expectConsistent(expect);
  });
});

describe('referência fora de ordem (PENDING_REFERENCE)', () => {
  test('REFUND antes da BET → PENDING_REFERENCE, sem mexer na wallet', () => {
    const h = new Harness('100.00');
    const refund = h.refund('refund-1', 'bet-1', '30.00');
    expect(h.submit(refund)).toEqual({ outcome: 'PENDING_REFERENCE' });
    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.balanceAfter?.toString()).toBe('100.00 BRL');
    expect(h.wallet.version).toBe(1);
    expect(h.entries).toHaveLength(1);
  });

  test('reprocessamento depois que a referência chega → PROCESSED', () => {
    const h = new Harness('100.00');
    const refund = h.refund('refund-1', 'bet-1', '30.00');
    h.submit(refund);
    h.submit(h.bet('bet-1', '30.00'));
    expect(balance(h)).toBe('70.00 BRL');
    expect(h.submit(refund).outcome).toBe('PROCESSED');
    expect(refund.status).toBe(Status.Processed);
    expect(balance(h)).toBe('100.00 BRL');
    h.expectConsistent(expect);
  });

  test('referência ainda ausente na nova tentativa: continua pendente, com backoff e contador', () => {
    const h = new Harness('100.00');
    const refund = h.refund('refund-1', 'bet-1', '30.00');
    h.submit(refund);
    expect(h.submit(refund, 3)).toEqual({ outcome: 'PENDING_REFERENCE' });
    expect(refund.referenceAttempts).toBe(1);
    expect(refund.status).toBe(Status.PendingReference);
  });

  test('esgotadas as tentativas → REJECTED/REFERENCE_NOT_FOUND', () => {
    const h = new Harness('100.00');
    const refund = h.refund('refund-1', 'bet-1', '30.00');
    h.submit(refund);
    h.submit(refund, 3);
    h.submit(refund, 3);
    const last = h.submit(refund, 3);
    expect(last).toEqual({ outcome: 'REJECTED', failureCode: FailureCode.ReferenceNotFound });
    expect(refund.status).toBe(Status.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(refund.nextAttemptAt).toBeUndefined();
    h.expectConsistent(expect);
  });

  test('reprocessar após a referência chegar mas inválida → REJECTED com o código certo', () => {
    const h = new Harness('100.00');
    const refund = h.refund('refund-1', 'win-1', '30.00');
    h.submit(refund);
    h.submit(h.win('win-1', '30.00'));
    expect(h.submit(refund)).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.ReferenceInvalidKind,
    });
  });
});

describe('validações da wallet (rejeição auditável, sem tocar no saldo)', () => {
  test('moeda diferente da wallet → CURRENCY_MISMATCH', () => {
    const h = new Harness('100.00');
    const bet = h.bet('bet-1', '10.00', { money: usd('10.00') });
    expect(h.submit(bet)).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.CurrencyMismatch,
    });
    expect(balance(h)).toBe('100.00 BRL');
    expect(h.wallet.version).toBe(1);
  });

  test('wallet de outro player → WALLET_PLAYER_MISMATCH', () => {
    const h = new Harness('100.00');
    const bet = h.bet('bet-1', '10.00', { playerId: 'outro-player' });
    expect(h.submit(bet)).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.WalletPlayerMismatch,
    });
    expect(balance(h)).toBe('100.00 BRL');
  });

  test('transação de outra wallet é erro de programação, não rejeição', () => {
    const h = new Harness('100.00');
    const bet = h.bet('bet-1', '10.00', { walletId: 'outra-wallet' });
    expect(() => h.submit(bet)).toThrow(InvalidFieldError);
    expect(bet.status).toBe(Status.Pending);
  });
});

describe('guardas', () => {
  test('transação em estado terminal não é reprocessada', () => {
    const h = new Harness('100.00');
    const bet = h.bet('bet-1', '10.00');
    h.submit(bet);
    expect(() => h.submit(bet)).toThrow(InvalidTransactionStateError);
    expect(balance(h)).toBe('90.00 BRL');
  });

  test('OPENING não passa pela policy (é criada junto com a wallet)', () => {
    const h = new Harness('100.00');
    const opening = WagerTransaction.opening({
      id: nextId('tx'),
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      money: brl('5.00'),
      now: T0,
    });
    expect(() =>
      WagerPolicy.apply({
        wallet: h.wallet,
        transaction: opening,
        reference: undefined,
        processedReversals: [],
        entryId: 'e',
        now: at(1),
      }),
    ).toThrow(InvalidTransactionKindError);
  });
});

describe('sequência longa mantém wallet == ledger', () => {
  test('mistura de BET, WIN, LOSS, REFUND e ROLLBACK', () => {
    const h = new Harness('200.00');
    h.submit(h.bet('b1', '50.00'));
    h.submit(h.win('w1', '120.00', { referenceExternalTransactionId: 'b1' }));
    h.submit(h.bet('b2', '70.00'));
    h.submit(h.loss('l2', '70.00', { referenceExternalTransactionId: 'b2' }));
    h.submit(h.bet('b3', '10.00'));
    h.submit(h.refund('r3', 'b3', '10.00'));
    h.submit(h.rollback('rb1', 'w1', '120.00'));
    h.submit(h.bet('b4', '999.00')); // rejeitada
    expect(balance(h)).toBe('80.00 BRL');
    h.expectConsistent(expect);
    // cada transação que move saldo tem no máximo 1 lançamento
    const perTx = new Map<string, number>();
    for (const e of h.entries) perTx.set(e.transactionId, (perTx.get(e.transactionId) ?? 0) + 1);
    expect([...perTx.values()].every((n) => n === 1)).toBe(true);
  });
});
