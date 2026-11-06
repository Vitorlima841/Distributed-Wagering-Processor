import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidAmountError,
  InvalidFieldError,
  InvalidMoneyError,
} from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money/money';
import { Wallet } from '../../../src/domain/wallet/wallet';
import {
  LedgerDirection,
  type WalletLedgerEntry,
} from '../../../src/domain/wallet/wallet-ledger-entry';
import { at, brl, nextId, PLAYER_ID, T0, usd, WALLET_ID } from './builders';

function openWallet(initial: string) {
  return Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: brl(initial),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    now: T0,
  });
}

const move = (money: Money, seconds = 1) => ({
  money,
  transactionId: nextId('tx'),
  entryId: nextId('entry'),
  now: at(seconds),
});

/** Saldo reconstruído pelo ledger: invariante final de todo teste de wallet. */
function ledgerBalance(currency: string, entries: WalletLedgerEntry[]): Money {
  return entries.reduce(
    (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
    Money.zero(currency),
  );
}

describe('Wallet.open', () => {
  test('saldo inicial > 0 gera lançamento OPENING CREDIT de 0.00 até o saldo, e version=1', () => {
    const { wallet, openingEntry } = openWallet('1000.00');
    expect(wallet.balance.toString()).toBe('1000.00 BRL');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt).toEqual(T0);
    expect(wallet.updatedAt).toEqual(T0);
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00 BRL');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00 BRL');
    expect(openingEntry?.transactionId).toBe('tx-opening');
    expect(openingEntry?.walletId).toBe(WALLET_ID);
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test('saldo inicial zero: sem lançamento, version=1', () => {
    const { wallet, openingEntry } = openWallet('0.00');
    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rejeita saldo inicial negativo', () => {
    expect(() =>
      Wallet.open({
        id: WALLET_ID,
        playerId: PLAYER_ID,
        initialBalance: brl('1.00').subtract(brl('2.00')),
        openingTransactionId: 'tx',
        openingEntryId: 'e',
        now: T0,
      }),
    ).toThrow(InvalidAmountError);
  });

  test('rejeita ids vazios', () => {
    expect(() =>
      Wallet.open({
        id: '',
        playerId: PLAYER_ID,
        initialBalance: brl('1.00'),
        openingTransactionId: 'tx',
        openingEntryId: 'e',
        now: T0,
      }),
    ).toThrow(InvalidFieldError);
  });
});

describe('Wallet.debit / credit', () => {
  test('debit reduz o saldo, incrementa version e devolve o lançamento correspondente', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.debit(move(brl('80.00')));
    expect(wallet.balance.toString()).toBe('20.00 BRL');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(at(1));
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.toString()).toBe('80.00 BRL');
    expect(entry.balanceBefore.toString()).toBe('100.00 BRL');
    expect(entry.balanceAfter.toString()).toBe('20.00 BRL');
    expect(entry.walletId).toBe(wallet.id);
    expect(entry.walletVersion).toBe(wallet.version);
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit aumenta o saldo, incrementa version e devolve o lançamento', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.credit(move(brl('25.50')));
    expect(wallet.balance.toString()).toBe('125.50 BRL');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('100.00 BRL');
    expect(entry.balanceAfter.toString()).toBe('125.50 BRL');
    expect(entry.walletVersion).toBe(2);
  });

  test('débito exato do saldo zera a wallet (saldo nunca fica negativo)', () => {
    const { wallet } = openWallet('80.00');
    wallet.debit(move(brl('80.00')));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('saldo insuficiente: lança e não altera saldo, version nem updatedAt', () => {
    const { wallet } = openWallet('100.00');
    wallet.debit(move(brl('80.00')));
    const versionBefore = wallet.version;
    expect(() => wallet.debit(move(brl('80.00'), 9))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00 BRL');
    expect(wallet.version).toBe(versionBefore);
    expect(wallet.updatedAt).toEqual(at(1));
  });

  test('conflito de moeda: lança CurrencyMismatchError e não altera nada', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.debit(move(usd('10.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(move(usd('10.00')))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toString()).toBe('100.00 BRL');
    expect(wallet.version).toBe(1);
  });

  test('valor zero ou negativo é rejeitado em debit e credit', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.debit(move(brl('0.00')))).toThrow(InvalidAmountError);
    expect(() => wallet.credit(move(brl('0.00')))).toThrow(InvalidAmountError);
    expect(() => wallet.credit(move(brl('1.00').subtract(brl('2.00'))))).toThrow(
      InvalidAmountError,
    );
    expect(wallet.version).toBe(1);
  });

  test('crédito que estoura numeric(20,2) falha sem alterar o saldo', () => {
    const { wallet } = openWallet('999999999999999999.99');
    expect(() => wallet.credit(move(brl('0.01')))).toThrow(InvalidMoneyError);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('999999999999999999.99 BRL');
  });

  test('version só incrementa quando o saldo muda', () => {
    const { wallet } = openWallet('10.00');
    expect(() => wallet.debit(move(brl('99.00')))).toThrow(InsufficientFundsError);
    expect(wallet.version).toBe(1);
    wallet.credit(move(brl('1.00')));
    wallet.debit(move(brl('2.00')));
    expect(wallet.version).toBe(3);
  });

  test('saldo == reconstruído pelo ledger após sequência de operações', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const entries = [openingEntry as WalletLedgerEntry];
    entries.push(wallet.debit(move(brl('30.10'))));
    entries.push(wallet.credit(move(brl('5.05'))));
    entries.push(wallet.debit(move(brl('0.01'))));
    expect(wallet.balance.equals(ledgerBalance('BRL', entries))).toBe(true);
    expect(wallet.balance.toString()).toBe('74.94 BRL');
    // encadeamento: o balanceBefore de cada lançamento é o balanceAfter do anterior
    for (let i = 1; i < entries.length; i++) {
      expect(
        entries[i]?.balanceBefore.equals((entries[i - 1] as WalletLedgerEntry).balanceAfter),
      ).toBe(true);
    }
  });

  test('cenário obrigatório (sequencial): 100.00, duas BET de 80.00 → só um débito', () => {
    const { wallet } = openWallet('100.00');
    const entries: WalletLedgerEntry[] = [];
    let rejected = 0;
    for (let i = 0; i < 2; i++) {
      try {
        entries.push(wallet.debit(move(brl('80.00'))));
      } catch (e) {
        if (!(e instanceof InsufficientFundsError)) throw e;
        rejected++;
      }
    }
    expect(entries).toHaveLength(1);
    expect(rejected).toBe(1);
    expect(wallet.balance.toString()).toBe('20.00 BRL');
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói o estado sem revalidar nem gerar lançamento', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: T0,
      updatedAt: at(100),
    });
    expect(wallet.balance.toString()).toBe('42.00 BRL');
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toEqual(at(100));
  });
});
