import { DomainError } from '../errors';

export interface MoneyProps {
  /** Decimal string with fixed scale of 2, e.g. "25.00". */
  amount: string;
  /** ISO-4217 alphabetic code, e.g. "BRL". */
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
  readonly category = 'VALIDATION' as const;

  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  readonly category = 'VALIDATION' as const;

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

const SCALE = 2;
const MINOR_PER_UNIT = 100n;
const MAX_INTEGER_DIGITS = 15;
const MAX_MINOR = 10n ** BigInt(MAX_INTEGER_DIGITS + SCALE);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// "0", "25", "25.5", "25.50". No sign, no exponent, no separators, no leading zeros.
const UNSIGNED_AMOUNT_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const SIGNED_AMOUNT_PATTERN = /^(-)?(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

/**
 * Immutable monetary amount backed by an integer count of minor units (BigInt), so no
 * floating point is ever involved. Scale is fixed at 2 decimal places.
 *
 * `Money.from` is the contract for external input and therefore rejects negative values.
 * Negative values can still appear as the result of arithmetic (e.g. `balance.subtract(bet)`),
 * and `Money.fromSigned` re-reads such serialized values (reconciliation differences).
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    return Money.parse(props, false);
  }

  static fromSigned(props: MoneyProps): Money {
    return Money.parse(props, true);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  private static parse(props: MoneyProps, allowNegative: boolean): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object with amount and currency');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    Money.assertCurrency(currency);

    const match = (allowNegative ? SIGNED_AMOUNT_PATTERN : UNSIGNED_AMOUNT_PATTERN).exec(amount);
    if (!match) {
      throw new InvalidMoneyError(
        amount.startsWith('-') && !allowNegative
          ? 'negative amounts are not accepted'
          : 'amount must be a plain decimal string with at most 2 decimal places (e.g. "25.00")',
      );
    }

    const negative = allowNegative && match[1] === '-';
    const whole = allowNegative ? match[2] : match[1];
    const fraction = allowNegative ? match[3] : match[2];
    if (whole === undefined) {
      throw new InvalidMoneyError('amount is malformed');
    }
    if (whole.length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError(`amount exceeds ${MAX_INTEGER_DIGITS} integer digits`);
    }

    const minor =
      BigInt(whole) * MINOR_PER_UNIT + BigInt((fraction ?? '').padEnd(SCALE, '0') || '0');
    return Money.ofMinor(negative ? -minor : minor, currency);
  }

  private static ofMinor(minor: bigint, currency: string): Money {
    const abs = minor < 0n ? -minor : minor;
    if (abs >= MAX_MINOR) {
      throw new InvalidMoneyError('amount out of supported range');
    }
    return new Money(minor, currency);
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 alphabetic code (e.g. "BRL")');
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinor(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinor(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Value equality. Different currencies are simply "not equal" (no throw). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  /** Decimal string with exactly 2 decimal places, e.g. "-5.00". */
  get amount(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const whole = abs / MINOR_PER_UNIT;
    const fraction = (abs % MINOR_PER_UNIT).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
