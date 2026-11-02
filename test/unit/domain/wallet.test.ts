import { describe, expect, test } from 'bun:test';
import {
  LedgerDirection,
  WalletLedgerEntry,
  InvalidLedgerEntryError,
} from '@/domain/ledger/wallet-ledger-entry';
import { CurrencyMismatchError, Money } from '@/domain/money/money';
import { Wallet } from '@/domain/wallet/wallet';
import { InsufficientFundsError } from '@/domain/wallet/wallet.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
const open = (amount = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(amount), createdAt: at });
const move = (amount: string, n = 1) => ({
  entryId: `e${n}`,
  transactionId: `t${n}`,
  money: brl(amount),
  at,
});

describe('Wallet', () => {
  test('starts at version 1 with the opening balance', () => {
    const wallet = open();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.currency).toBe('BRL');
  });

  test('debit and credit return the matching ledger entry and bump version', () => {
    const wallet = open();
    const debit = wallet.debit(move('80.00'));
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.balanceBefore.amount).toBe('100.00');
    expect(debit.balanceAfter.amount).toBe('20.00');
    expect(debit.walletVersion).toBe(2);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);

    const credit = wallet.credit(move('5.50', 2));
    expect(credit.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('25.50');
    expect(wallet.version).toBe(3);
  });

  test('never goes negative', () => {
    const wallet = open('10.00');
    expect(() => wallet.debit(move('10.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('10.00');
    expect(wallet.version).toBe(1);
    wallet.debit(move('10.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rejects other currencies and non-positive amounts without changing state', () => {
    const wallet = open();
    expect(() =>
      wallet.debit({ ...move('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) }),
    ).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(move('0.00'))).toThrow();
    expect(wallet.version).toBe(1);
  });

  test('rehydrate does not revalidate', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('3.00'),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.version).toBe(7);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    direction: LedgerDirection.Debit,
    money: brl('10.00'),
    balanceBefore: brl('50.00'),
    balanceAfter: brl('40.00'),
    walletVersion: 2,
    createdAt: at,
  };

  test('validates the arithmetic on create', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('41.00') })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() =>
      WalletLedgerEntry.create({ ...base, money: brl('0.00'), balanceAfter: brl('50.00') }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create(base);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { id: string }).id = 'other';
    }).toThrow();
  });
});
