import { describe, expect, test } from 'bun:test';
import {
  InvalidAmountError,
  InvalidFieldError,
  UnbalancedLedgerEntryError,
} from '../../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';
import { brl, T0, usd, WALLET_ID } from './builders';

const base = {
  id: 'entry-1',
  walletId: WALLET_ID,
  transactionId: 'tx-1',
  createdAt: T0,
};

describe('WalletLedgerEntry.create', () => {
  test('DEBIT balanceado', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('80.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('20.00'),
    });
    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toString()).toBe('20.00 BRL');
  });

  test('CREDIT balanceado', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('25.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejeita aritmética errada (DEBIT)', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('80.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('30.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejeita aritmética errada (CREDIT)', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('90.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejeita lançamento com valor zero', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('10.00'),
      }),
    ).toThrow(InvalidAmountError);
  });

  test('rejeita saldo resultante negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejeita moedas divergentes entre valor e saldos', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: usd('10.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('10.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejeita ids vazios', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        transactionId: '',
        direction: LedgerDirection.Credit,
        money: brl('1.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(InvalidFieldError);
  });
});

describe('WalletLedgerEntry é imutável', () => {
  const entry = WalletLedgerEntry.create({
    ...base,
    direction: LedgerDirection.Credit,
    money: brl('25.00'),
    balanceBefore: brl('0.00'),
    balanceAfter: brl('25.00'),
  });

  test('instância congelada: atribuição falha', () => {
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = 'DEBIT';
    }).toThrow(TypeError);
  });

  test('não expõe métodos de transição', () => {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter(
      (name) => name !== 'constructor',
    );
    expect(methods).toEqual(['isBalanced']);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('não revalida: reconstrói estado persistido como está', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('80.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('30.00'), // inconsistente de propósito
    });
    expect(entry.isBalanced()).toBe(false);
  });
});
