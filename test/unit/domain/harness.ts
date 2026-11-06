import { Money } from '../../../src/domain/money/money';
import { WagerPolicy, type WagerProcessingResult } from '../../../src/domain/wager/wager-policy';
import {
  type CreateWagerTransactionProps,
  WagerTransactionKind as Kind,
  WagerTransaction,
  WagerTransactionStatus,
} from '../../../src/domain/wager/wager-transaction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import {
  LedgerDirection,
  type WalletLedgerEntry,
} from '../../../src/domain/wallet/wallet-ledger-entry';
import { at, brl, nextId, PLAYER_ID, T0, WALLET_ID } from './builders';

/**
 * Mini "persistência" em memória só para testes unitários do domínio: resolve referências e
 * reversões já processadas como o repositório faria, e reconstrói o saldo pelo ledger.
 */
export class Harness {
  readonly wallet: Wallet;
  readonly entries: WalletLedgerEntry[] = [];
  readonly store: WagerTransaction[] = [];
  private clock = 1;

  constructor(initial = '100.00') {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl(initial),
      openingTransactionId: 'tx-opening',
      openingEntryId: 'entry-opening',
      now: T0,
    });
    this.wallet = wallet;
    if (openingEntry) this.entries.push(openingEntry);
  }

  tx(
    kind: Kind,
    externalId: string,
    amount: string,
    over: Partial<CreateWagerTransactionProps> = {},
  ) {
    return WagerTransaction.create({
      id: nextId('tx'),
      providerId: 'provider-a',
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      playerId: PLAYER_ID,
      walletId: WALLET_ID,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: brl(amount),
      now: at(this.clock++),
      ...over,
    });
  }

  bet = (id: string, amount: string, over: Partial<CreateWagerTransactionProps> = {}) =>
    this.tx(Kind.Bet, id, amount, over);
  win = (id: string, amount: string, over: Partial<CreateWagerTransactionProps> = {}) =>
    this.tx(Kind.Win, id, amount, over);
  loss = (id: string, amount: string, over: Partial<CreateWagerTransactionProps> = {}) =>
    this.tx(Kind.Loss, id, amount, over);
  refund = (
    id: string,
    ref: string,
    amount: string,
    over: Partial<CreateWagerTransactionProps> = {},
  ) => this.tx(Kind.Refund, id, amount, { referenceExternalTransactionId: ref, ...over });
  rollback = (
    id: string,
    ref: string,
    amount: string,
    over: Partial<CreateWagerTransactionProps> = {},
  ) => this.tx(Kind.Rollback, id, amount, { referenceExternalTransactionId: ref, ...over });

  /** Processa (ou reprocessa) a transação com o estado atual do "banco". */
  submit(transaction: WagerTransaction, maxReferenceAttempts?: number): WagerProcessingResult {
    if (!this.store.includes(transaction)) this.store.push(transaction);
    const reference = transaction.referenceExternalTransactionId
      ? this.store.find(
          (t) =>
            t.providerId === transaction.providerId &&
            t.externalTransactionId === transaction.referenceExternalTransactionId,
        )
      : undefined;
    const processedReversals = reference
      ? this.store.filter(
          (t) =>
            t.status === WagerTransactionStatus.Processed &&
            (t.kind === Kind.Refund || t.kind === Kind.Rollback) &&
            t.referenceTransactionId === reference.id,
        )
      : [];
    const result = WagerPolicy.apply({
      wallet: this.wallet,
      transaction,
      reference,
      processedReversals,
      entryId: nextId('entry'),
      now: at(this.clock++),
      ...(maxReferenceAttempts === undefined ? {} : { maxReferenceAttempts }),
    });
    if (result.outcome === 'PROCESSED' && result.ledgerEntry) this.entries.push(result.ledgerEntry);
    return result;
  }

  ledgerBalance(): Money {
    return this.entries.reduce(
      (acc, e) =>
        e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money),
      Money.zero(this.wallet.currency),
    );
  }

  /** Invariante final: wallet.balance == saldo reconstruído pelo ledger. */
  expectConsistent(expect: (v: unknown) => { toBe(x: unknown): void }): void {
    expect(this.wallet.balance.equals(this.ledgerBalance())).toBe(true);
  }
}
