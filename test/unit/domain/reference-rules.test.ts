import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/wager/failure-code';
import { ReferenceRules } from '../../../src/domain/wager/reference-rules';
import { WagerTransaction } from '../../../src/domain/wager/wager-transaction';
import { at, brl, usd } from './builders';
import { Harness } from './harness';

/** Cria uma referência já PROCESSED. */
function processed(tx: WagerTransaction): WagerTransaction {
  tx.markProcessed(undefined, brl('0.00'), at(50));
  return tx;
}

describe('ReferenceRules.evaluate', () => {
  test('referência ausente → PENDING_REFERENCE', () => {
    const h = new Harness();
    expect(ReferenceRules.evaluate(h.refund('r1', 'bet-1', '10.00'), undefined, [])).toEqual({
      outcome: 'PENDING_REFERENCE',
    });
  });

  test('referência ainda não terminal → PENDING_REFERENCE', () => {
    const h = new Harness();
    const bet = h.bet('bet-1', '10.00'); // PENDING
    expect(ReferenceRules.evaluate(h.refund('r1', 'bet-1', '10.00'), bet, []).outcome).toBe(
      'PENDING_REFERENCE',
    );
  });

  test('auto-referência é rejeitada, não fica pendente para sempre', () => {
    const h = new Harness();
    const self = h.refund('r1', 'r1', '10.00');
    expect(ReferenceRules.evaluate(self, self, [])).toEqual({
      outcome: 'REJECT',
      code: FailureCode.ReferenceInvalidKind,
    });
  });

  test('referência REJECTED ou FAILED → REFERENCE_NOT_PROCESSED', () => {
    const h = new Harness();
    const rejected = h.bet('bet-1', '10.00');
    rejected.reject(FailureCode.InsufficientFunds, brl('0.00'), at(1));
    const failed = h.bet('bet-2', '10.00');
    failed.fail(FailureCode.InfraPermanentError, at(1));
    for (const ref of [rejected, failed]) {
      expect(
        ReferenceRules.evaluate(h.refund('r1', ref.externalTransactionId, '10.00'), ref, []),
      ).toEqual({
        outcome: 'REJECT',
        code: FailureCode.ReferenceNotProcessed,
      });
    }
  });

  test('REFUND só referencia BET', () => {
    const h = new Harness();
    for (const ref of [processed(h.win('w1', '10.00')), processed(h.loss('l1', '10.00'))]) {
      expect(
        ReferenceRules.evaluate(h.refund('r1', ref.externalTransactionId, '10.00'), ref, []),
      ).toEqual({
        outcome: 'REJECT',
        code: FailureCode.ReferenceInvalidKind,
      });
    }
  });

  test('ROLLBACK referencia BET, WIN ou REFUND — e só esses', () => {
    const h = new Harness();
    const bet = processed(h.bet('bet-1', '10.00'));
    const win = processed(h.win('win-1', '10.00'));
    const refund = processed(h.refund('ref-1', 'x', '10.00'));
    for (const ref of [bet, win, refund]) {
      expect(
        ReferenceRules.evaluate(h.rollback('rb', ref.externalTransactionId, '10.00'), ref, [])
          .outcome,
      ).toBe('APPLY');
    }
    const loss = processed(h.loss('loss-1', '10.00'));
    const rollback = processed(h.rollback('rb-0', 'x', '10.00'));
    for (const ref of [loss, rollback]) {
      expect(
        ReferenceRules.evaluate(h.rollback('rb', ref.externalTransactionId, '10.00'), ref, []),
      ).toEqual({
        outcome: 'REJECT',
        code: FailureCode.ReferenceInvalidKind,
      });
    }
  });

  test('REFERENCE_MISMATCH: outro player, wallet, rodada, provedor ou moeda', () => {
    const h = new Harness();
    const cases: Array<Partial<Parameters<Harness['bet']>[2]>> = [
      { playerId: 'outro-player' },
      { walletId: 'outra-wallet' },
      { roundId: 'round-2' },
      { providerId: 'provider-b', idempotencyKey: 'provider-b:bet-1' },
      { money: usd('10.00') },
    ];
    for (const over of cases) {
      const bet = processed(h.bet('bet-1', '10.00', over));
      const decision = ReferenceRules.evaluate(h.refund('r1', 'bet-1', '10.00'), bet, []);
      expect(decision).toEqual({ outcome: 'REJECT', code: FailureCode.ReferenceMismatch });
    }
  });

  test('ALREADY_REVERSED: qualquer reversão processada da referência (inclusive de outro tipo)', () => {
    const h = new Harness();
    const bet = processed(h.bet('bet-1', '10.00'));
    const previous = h.refund('r0', 'bet-1', '10.00');
    previous.markProcessed(bet.id, brl('0.00'), at(60));
    // mesmo tipo
    expect(ReferenceRules.evaluate(h.refund('r1', 'bet-1', '10.00'), bet, [previous])).toEqual({
      outcome: 'REJECT',
      code: FailureCode.AlreadyReversed,
    });
    // tipo diferente: ROLLBACK da BET que já foi reembolsada creditaria duas vezes
    expect(ReferenceRules.evaluate(h.rollback('rb1', 'bet-1', '10.00'), bet, [previous])).toEqual({
      outcome: 'REJECT',
      code: FailureCode.AlreadyReversed,
    });
  });

  test('reversões não processadas ou de outra referência não bloqueiam', () => {
    const h = new Harness();
    const bet = processed(h.bet('bet-1', '10.00'));
    const rejected = h.refund('r0', 'bet-1', '10.00');
    rejected.reject(FailureCode.AmountMismatch, brl('0.00'), at(60));
    const other = h.refund('r9', 'other', '10.00');
    other.markProcessed('outro-id', brl('0.00'), at(60));
    expect(
      ReferenceRules.evaluate(h.refund('r1', 'bet-1', '10.00'), bet, [rejected, other]).outcome,
    ).toBe('APPLY');
  });

  test('AMOUNT_MISMATCH: valor da reversão diferente do da referência', () => {
    const h = new Harness();
    const bet = processed(h.bet('bet-1', '10.00'));
    expect(ReferenceRules.evaluate(h.refund('r1', 'bet-1', '9.99'), bet, [])).toEqual({
      outcome: 'REJECT',
      code: FailureCode.AmountMismatch,
    });
  });

  test('tudo certo → APPLY com a referência', () => {
    const h = new Harness();
    const bet = processed(h.bet('bet-1', '10.00'));
    expect(ReferenceRules.evaluate(h.refund('r1', 'bet-1', '10'), bet, [])).toEqual({
      outcome: 'APPLY',
      reference: bet,
    });
  });

  test('kinds sem exigência de referência → APPLY sem referência', () => {
    const h = new Harness();
    for (const tx of [h.bet('b', '1.00'), h.win('w', '1.00'), h.loss('l', '1.00')]) {
      expect(ReferenceRules.evaluate(tx, undefined, [])).toEqual({
        outcome: 'APPLY',
        reference: undefined,
      });
    }
  });
});
