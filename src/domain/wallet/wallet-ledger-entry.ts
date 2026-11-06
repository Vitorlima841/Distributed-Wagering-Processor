import { InvalidAmountError, UnbalancedLedgerEntryError } from '../errors';
import type { Money } from '../money/money';
import { assertNonEmpty } from '../shared/assert';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Lançamento imutável do ledger. Sem campos mutáveis e sem métodos de transição:
 * a instância é congelada e só `isBalanced()` existe como consulta.
 */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.createdAt = state.createdAt;
    Object.freeze(this);
  }

  /** Valida campos, sinal e aritmética (`balanceBefore ± money === balanceAfter`). */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    assertNonEmpty('id', props.id);
    assertNonEmpty('walletId', props.walletId);
    assertNonEmpty('transactionId', props.transactionId);
    if (!props.money.isPositive()) {
      throw new InvalidAmountError(`Lançamento exige valor positivo, recebido ${props.money}`);
    }
    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `Lançamento desbalanceado: ${props.balanceBefore} ${props.direction === LedgerDirection.Credit ? '+' : '-'} ` +
          `${props.money} != ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir da persistência — não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  /** Mesma moeda, saldos não negativos e `balanceBefore ± money === balanceAfter`. */
  isBalanced(): boolean {
    const currency = this.money.currency;
    if (this.balanceBefore.currency !== currency || this.balanceAfter.currency !== currency) {
      return false;
    }
    if (this.balanceBefore.isNegative() || this.balanceAfter.isNegative()) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
