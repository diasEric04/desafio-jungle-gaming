import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { CurrencyMismatchError, Money } from '../money/money';
import {
  InsufficientFundsError,
  InvalidWalletError,
  InvalidWalletOperationError,
} from './wallet.errors';

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
  createdAt: Date;
}

export interface MovementProps {
  /** Id for the ledger entry that will be produced by this movement. */
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root. The balance can only change through `debit` / `credit`, and each of them returns
 * the ledger entry that describes the change, so balance and ledger cannot drift apart inside the
 * domain. The database re-checks the same invariant with a deferred constraint trigger.
 *
 * `version` starts at 1 and is bumped only when the balance changes. Concurrency control
 * (pessimistic row lock + compare-and-swap on `version`) is applied by the repository.
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

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('initial balance cannot be negative');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.createdAt,
      props.createdAt,
    );
  }

  /** Reconstruction from persistence: does not re-run transition rules. */
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

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.move(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    return this.move(LedgerDirection.Credit, props);
  }

  private move(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(props.money)
        : balanceBefore.subtract(props.money);
    const nextVersion = this._version + 1;

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      walletVersion: nextVersion,
      createdAt: props.at,
    });

    this._balance = balanceAfter;
    this._version = nextVersion;
    this._updatedAt = props.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError('only strictly positive amounts can be moved');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
