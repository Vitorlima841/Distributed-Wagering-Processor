import { CurrencyMismatchError, InsufficientFundsError, InvalidAmountError } from '../errors';
import type { Money } from '../money/money';
import { assertNonEmpty } from '../shared/assert';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Ids da transação interna OPENING e do lançamento, usados só se o saldo inicial for > 0. */
  openingTransactionId: string;
  openingEntryId: string;
  now: Date;
}

export interface OpenWalletResult {
  wallet: Wallet;
  /** CREDIT de 0.00 até o saldo inicial; ausente quando o saldo inicial é zero. */
  openingEntry?: WalletLedgerEntry;
}

export interface MovementProps {
  money: Money;
  transactionId: string;
  entryId: string;
  now: Date;
}

/**
 * Aggregate root. Toda alteração de saldo devolve o lançamento de ledger correspondente,
 * então saldo e ledger não divergem. A serialização entre operações concorrentes é
 * responsabilidade da persistência (lock da linha da wallet), não deste objeto.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenWalletResult {
    assertNonEmpty('id', props.id);
    assertNonEmpty('playerId', props.playerId);
    if (props.initialBalance.isNegative()) {
      throw new InvalidAmountError('Saldo inicial não pode ser negativo');
    }
    const { initialBalance, now } = props;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      now,
      now,
    );
    if (initialBalance.isZero()) {
      return { wallet };
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: initialBalance.subtract(initialBalance),
      balanceAfter: initialBalance,
      createdAt: now,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError(props.money.toString(), this._balance.toString());
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(props.money), props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(props.money), props);
  }

  /** Cria o lançamento primeiro: se algo falhar, o estado da wallet permanece intacto. */
  private apply(
    direction: LedgerDirection,
    newBalance: Money,
    props: MovementProps,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter: newBalance,
      createdAt: props.now,
    });
    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = props.now;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidAmountError(`Movimentação exige valor positivo, recebido ${money}`);
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
