import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '@/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('parses and serializes with fixed scale 2', () => {
    expect(brl('25').amount).toBe('25.00');
    expect(brl('25.5').amount).toBe('25.50');
    expect(brl('0.07').amount).toBe('0.07');
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });

  test.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '0x10',
    '1,5',
    '.5',
    '5.',
    '1.234',
    '007',
    '+1',
    ' 1',
    '1 ',
    '--1',
  ])('rejects malformed input %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects negative values in input contracts', () => {
    expect(() => brl('-1.00')).toThrow(/negative/);
  });

  test('rejects non-string amounts and bad currencies', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'BRLL' })).toThrow(InvalidMoneyError);
  });

  test('is exact where floats are not', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    let sum = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) sum = sum.add(brl('0.01'));
    expect(sum.amount).toBe('10.00');
  });

  test('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    const b = a.subtract(brl('3.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('7.00');
    expect(a.negate().amount).toBe('-10.00');
    expect(a.amount).toBe('10.00');
  });

  test('arithmetic can go negative, contracts cannot', () => {
    const diff = brl('1.00').subtract(brl('2.50'));
    expect(diff.isNegative()).toBe(true);
    expect(diff.amount).toBe('-1.50');
    expect(Money.fromSigned(diff.toJSON()).equals(diff)).toBe(true);
    expect(() => Money.from(diff.toJSON())).toThrow(InvalidMoneyError);
  });

  test('comparisons', () => {
    expect(brl('0').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').equals(brl('1'))).toBe(true);
  });

  test('currency conflicts raise a domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  test('rejects out-of-range amounts', () => {
    expect(() => brl('1000000000000000.00')).toThrow(InvalidMoneyError);
    expect(brl('999999999999999.99').amount).toBe('999999999999999.99');
    expect(() => brl('999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyError);
  });
});
