import { describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  InvalidAmountError,
  InvalidFailureCodeError,
  InvalidFieldError,
  InvalidTransactionKindError,
  InvalidTransactionStateError,
  MissingReferenceError,
} from '../../../src/domain/errors';
import { FailureCode } from '../../../src/domain/wager/failure-code';
import { computeWagerPayloadHash } from '../../../src/domain/wager/payload-hash';
import {
  type CreateWagerTransactionProps,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  WagerTransaction,
} from '../../../src/domain/wager/wager-transaction';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';
import { at, brl, PLAYER_ID, T0, WALLET_ID } from './builders';

export function props(
  over: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: PLAYER_ID,
    walletId: WALLET_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: Kind.Bet,
    money: brl('25.00'),
    now: T0,
    ...over,
  };
}

const refund = (over: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(
    props({
      kind: Kind.Refund,
      referenceExternalTransactionId: 'bet-1',
      externalTransactionId: 'refund-1',
      ...over,
    }),
  );

describe('WagerTransaction.create', () => {
  test('nasce PENDING, com hash do payload e sem snapshot', () => {
    const tx = WagerTransaction.create(props());
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.payloadHash).toBe(
      computeWagerPayloadHash({
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        playerId: PLAYER_ID,
        walletId: WALLET_ID,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: brl('25.00'),
      }),
    );
    expect(tx.balanceAfter).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.createdAt).toEqual(T0);
  });

  test('OPENING não pode ser submetido', () => {
    expect(() => WagerTransaction.create(props({ kind: Kind.Opening }))).toThrow(
      InvalidTransactionKindError,
    );
  });

  test('kind desconhecido é rejeitado', () => {
    expect(() => WagerTransaction.create(props({ kind: 'JACKPOT' as never }))).toThrow(
      InvalidTransactionKindError,
    );
  });

  test.each([Kind.Refund, Kind.Rollback])('%s exige referenceExternalTransactionId', (kind) => {
    expect(() => WagerTransaction.create(props({ kind }))).toThrow(MissingReferenceError);
    expect(() =>
      WagerTransaction.create(props({ kind, referenceExternalTransactionId: '' })),
    ).toThrow(MissingReferenceError);
  });

  test('BET não aceita referência; WIN e LOSS aceitam como informação', () => {
    expect(() => WagerTransaction.create(props({ referenceExternalTransactionId: 'x' }))).toThrow(
      InvalidFieldError,
    );
    const win = WagerTransaction.create(
      props({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1' }),
    );
    expect(win.referenceExternalTransactionId).toBe('bet-1');
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])('%s exige valor positivo', (kind) => {
    const ref =
      kind === Kind.Refund || kind === Kind.Rollback ? { referenceExternalTransactionId: 'r' } : {};
    expect(() => WagerTransaction.create(props({ kind, money: brl('0.00'), ...ref }))).toThrow(
      InvalidAmountError,
    );
  });

  test('LOSS aceita valor 0.00', () => {
    const tx = WagerTransaction.create(props({ kind: Kind.Loss, money: brl('0.00') }));
    expect(tx.money.isZero()).toBe(true);
  });

  test('rejeita campos de identificação vazios', () => {
    expect(() => WagerTransaction.create(props({ providerId: '' }))).toThrow(InvalidFieldError);
    expect(() => WagerTransaction.create(props({ idempotencyKey: ' ' }))).toThrow(
      InvalidFieldError,
    );
    expect(() => WagerTransaction.create(props({ roundId: '' }))).toThrow(InvalidFieldError);
  });
});

describe('WagerTransaction.opening', () => {
  test('transação interna com chave opening:{walletId}', () => {
    const tx = WagerTransaction.opening({
      id: 'tx-open',
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      money: brl('1000.00'),
      now: T0,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe('internal');
    expect(tx.idempotencyKey).toBe(`opening:${WALLET_ID}`);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe('consultas de domínio', () => {
  test('affectsBalance: false apenas para LOSS', () => {
    expect(WagerTransaction.create(props({ kind: Kind.Loss })).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win]) {
      expect(WagerTransaction.create(props({ kind })).affectsBalance()).toBe(true);
    }
    expect(refund().affectsBalance()).toBe(true);
  });

  test('requiresReference: true para REFUND e ROLLBACK', () => {
    expect(refund().requiresReference()).toBe(true);
    expect(refund({ kind: Kind.Rollback }).requiresReference()).toBe(true);
    expect(WagerTransaction.create(props()).requiresReference()).toBe(false);
  });

  test('ledgerDirectionFor: BET debita; WIN e REFUND creditam', () => {
    expect(WagerTransaction.create(props()).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(WagerTransaction.create(props({ kind: Kind.Win })).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(refund().ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ledgerDirectionFor: LOSS não tem direção', () => {
    expect(() => WagerTransaction.create(props({ kind: Kind.Loss })).ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
  });

  describe('ROLLBACK: direção inversa da referência', () => {
    const rollback = refund({ kind: Kind.Rollback });
    const ref = (kind: Kind) =>
      WagerTransaction.create(
        props({
          kind,
          externalTransactionId: 'bet-1',
          idempotencyKey: 'provider-a:bet-1',
          ...(kind === Kind.Refund ? { referenceExternalTransactionId: 'x' } : {}),
        }),
      );

    test('de BET → CREDIT', () => {
      expect(rollback.ledgerDirectionFor(ref(Kind.Bet))).toBe(LedgerDirection.Credit);
    });
    test('de WIN → DEBIT', () => {
      expect(rollback.ledgerDirectionFor(ref(Kind.Win))).toBe(LedgerDirection.Debit);
    });
    test('de REFUND → DEBIT', () => {
      expect(rollback.ledgerDirectionFor(ref(Kind.Refund))).toBe(LedgerDirection.Debit);
    });
    test('sem referência → MissingReferenceError', () => {
      expect(() => rollback.ledgerDirectionFor()).toThrow(MissingReferenceError);
    });
    test('de LOSS ou ROLLBACK → tipo inválido', () => {
      expect(() => rollback.ledgerDirectionFor(ref(Kind.Loss))).toThrow(
        InvalidTransactionKindError,
      );
      expect(() => rollback.ledgerDirectionFor(refund({ kind: Kind.Rollback }))).toThrow(
        InvalidTransactionKindError,
      );
    });
  });
});

describe('transições', () => {
  test('PENDING → PROCESSED guarda referência, snapshot de saldo e processedAt', () => {
    const tx = refund();
    tx.markProcessed('tx-bet', brl('975.00'), at(5));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.referenceTransactionId).toBe('tx-bet');
    expect(tx.balanceAfter?.toString()).toBe('975.00 BRL');
    expect(tx.processedAt).toEqual(at(5));
  });

  test('PENDING → REJECTED guarda failureCode, snapshot e processedAt, sem referência', () => {
    const tx = WagerTransaction.create(props());
    tx.reject(FailureCode.InsufficientFunds, brl('20.00'), at(2));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.balanceAfter?.toString()).toBe('20.00 BRL');
    expect(tx.processedAt).toEqual(at(2));
  });

  test('PENDING → FAILED só com INFRA_PERMANENT_ERROR', () => {
    const tx = WagerTransaction.create(props());
    expect(() => tx.fail(FailureCode.InsufficientFunds, at(1))).toThrow(InvalidFailureCodeError);
    expect(tx.status).toBe(Status.Pending);
    tx.fail(FailureCode.InfraPermanentError, at(1));
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.InfraPermanentError);
  });

  test('reject não aceita INFRA_PERMANENT_ERROR', () => {
    const tx = WagerTransaction.create(props());
    expect(() => tx.reject(FailureCode.InfraPermanentError, brl('1.00'), at(1))).toThrow(
      InvalidFailureCodeError,
    );
    expect(tx.status).toBe(Status.Pending);
  });

  test.each([
    ['markProcessed', (t: WagerTransaction) => t.markProcessed(undefined, brl('1.00'), at(9))],
    ['markPendingReference', (t: WagerTransaction) => t.markPendingReference(brl('1.00'), at(9))],
    [
      'reject',
      (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, brl('1.00'), at(9)),
    ],
    ['fail', (t: WagerTransaction) => t.fail(FailureCode.InfraPermanentError, at(9))],
    ['scheduleReferenceRetry', (t: WagerTransaction) => t.scheduleReferenceRetry(at(9))],
  ])('estado terminal: %s lança InvalidTransactionStateError', (_name, act) => {
    for (const terminate of [
      (t: WagerTransaction) => t.markProcessed(undefined, brl('1.00'), at(1)),
      (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, brl('1.00'), at(1)),
      (t: WagerTransaction) => t.fail(FailureCode.InfraPermanentError, at(1)),
    ]) {
      const tx = refund();
      terminate(tx);
      const snapshot = { status: tx.status, processedAt: tx.processedAt, code: tx.failureCode };
      expect(() => act(tx)).toThrow(InvalidTransactionStateError);
      expect({ status: tx.status, processedAt: tx.processedAt, code: tx.failureCode }).toEqual(
        snapshot,
      );
    }
  });

  describe('PENDING_REFERENCE', () => {
    test('PENDING → PENDING_REFERENCE agenda a primeira tentativa em 1s e guarda o snapshot', () => {
      const tx = refund();
      tx.markPendingReference(brl('100.00'), at(0));
      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.referenceAttempts).toBe(0);
      expect(tx.nextAttemptAt).toEqual(at(1));
      expect(tx.balanceAfter?.toString()).toBe('100.00 BRL');
    });

    test('backoff exponencial 1s, 2s, 4s… com teto de 60s', () => {
      const tx = refund();
      tx.markPendingReference(brl('100.00'), at(0));
      const delays: number[] = [];
      for (let i = 0; i < 9; i++) {
        tx.scheduleReferenceRetry(at(1000));
        delays.push(((tx.nextAttemptAt as Date).getTime() - at(1000).getTime()) / 1000);
      }
      expect(delays).toEqual([2, 4, 8, 16, 32, 60, 60, 60, 60]);
      expect(tx.referenceAttempts).toBe(9);
    });

    test('scheduleReferenceRetry mantém o status PENDING_REFERENCE e o snapshot original', () => {
      const tx = refund();
      tx.markPendingReference(brl('100.00'), at(0));
      tx.scheduleReferenceRetry(at(1));
      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.balanceAfter?.toString()).toBe('100.00 BRL');
    });

    test('hasExhaustedReferenceAttempts compara com o limite informado', () => {
      const tx = refund();
      tx.markPendingReference(brl('1.00'), at(0));
      for (let i = 0; i < 2; i++) tx.scheduleReferenceRetry(at(1));
      expect(tx.hasExhaustedReferenceAttempts(3)).toBe(false);
      tx.scheduleReferenceRetry(at(1));
      expect(tx.hasExhaustedReferenceAttempts(3)).toBe(true);
    });

    test('PENDING_REFERENCE → PROCESSED / REJECTED / FAILED; limpa nextAttemptAt', () => {
      const processed = refund();
      processed.markPendingReference(brl('1.00'), at(0));
      processed.markProcessed('tx-bet', brl('2.00'), at(3));
      expect(processed.status).toBe(Status.Processed);
      expect(processed.nextAttemptAt).toBeUndefined();

      const rejected = refund();
      rejected.markPendingReference(brl('1.00'), at(0));
      rejected.reject(FailureCode.ReferenceNotFound, brl('1.00'), at(3));
      expect(rejected.status).toBe(Status.Rejected);
      expect(rejected.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(rejected.nextAttemptAt).toBeUndefined();

      const failed = refund();
      failed.markPendingReference(brl('1.00'), at(0));
      failed.fail(FailureCode.InfraPermanentError, at(3));
      expect(failed.status).toBe(Status.Failed);
    });

    test('só PENDING pode virar PENDING_REFERENCE (nada de PENDING_REFERENCE → PENDING_REFERENCE)', () => {
      const tx = refund();
      tx.markPendingReference(brl('1.00'), at(0));
      expect(() => tx.markPendingReference(brl('1.00'), at(1))).toThrow(
        InvalidTransactionStateError,
      );
    });

    test('scheduleReferenceRetry exige PENDING_REFERENCE', () => {
      expect(() => refund().scheduleReferenceRetry(at(1))).toThrow(InvalidTransactionStateError);
    });

    test('kind que não depende de referência não vira PENDING_REFERENCE', () => {
      expect(() =>
        WagerTransaction.create(props()).markPendingReference(brl('1.00'), at(0)),
      ).toThrow(InvalidTransactionStateError);
    });
  });
});

describe('idempotência: matchesPayload', () => {
  test('mesmo payload → replay', () => {
    const tx = WagerTransaction.create(props());
    const sameRequest = WagerTransaction.create(props({ id: 'tx-2', money: brl('25') }));
    expect(tx.matchesPayload(sameRequest.payloadHash)).toBe(true);
    expect(() => tx.assertReplayOf(sameRequest.payloadHash)).not.toThrow();
  });

  test('mesma idempotency key com valor diferente → conflito, não replay', () => {
    const tx = WagerTransaction.create(props());
    const divergent = WagerTransaction.create(props({ id: 'tx-2', money: brl('26.00') }));
    expect(tx.idempotencyKey).toBe(divergent.idempotencyKey);
    expect(tx.matchesPayload(divergent.payloadHash)).toBe(false);
    expect(() => tx.assertReplayOf(divergent.payloadHash)).toThrow(IdempotencyConflictError);
  });

  test('payload divergente em qualquer campo de negócio é conflito', () => {
    const tx = WagerTransaction.create(props());
    for (const change of [
      { kind: Kind.Win },
      { roundId: 'round-1' },
      { gameId: 'other' },
      { walletId: 'other-wallet' },
      { playerId: 'other-player' },
    ] as Array<Partial<CreateWagerTransactionProps>>) {
      expect(tx.matchesPayload(WagerTransaction.create(props(change)).payloadHash)).toBe(false);
    }
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('reconstrói estado terminal sem revalidar transições', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'tx-9',
      providerId: 'provider-a',
      externalTransactionId: 'e-9',
      idempotencyKey: 'provider-a:e-9',
      payloadHash: 'a'.repeat(64),
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      roundId: 'r',
      gameId: 'g',
      kind: Kind.Bet,
      money: brl('10.00'),
      createdAt: T0,
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      balanceAfter: brl('5.00'),
      processedAt: at(1),
      referenceAttempts: 0,
    });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(() => tx.reject(FailureCode.InsufficientFunds, brl('5.00'), at(2))).toThrow(
      InvalidTransactionStateError,
    );
  });
});
