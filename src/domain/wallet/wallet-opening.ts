import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { WagerTransaction } from '../wagering/wager-transaction';
import { Wallet } from './wallet';

export interface OpenWalletWithBalanceProps {
  walletId: string;
  playerId: string;
  initialBalance: Money;
  now: Date;
  /** Only used when initialBalance > 0. */
  openingTransactionId: string;
  openingEntryId: string;
  openingPayloadHash: string;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Present only when the wallet starts with a positive balance. */
  opening: { transaction: WagerTransaction; entry: WalletLedgerEntry } | undefined;
}

/**
 * A wallet opened with money is born with an internal OPENING transaction and its CREDIT ledger
 * entry, so "balance == sum(ledger)" holds from the very first commit.
 */
export function openWalletWithBalance(props: OpenWalletWithBalanceProps): OpenedWallet {
  const wallet = Wallet.open({
    id: props.walletId,
    playerId: props.playerId,
    initialBalance: props.initialBalance,
    createdAt: props.now,
  });

  if (!props.initialBalance.isPositive()) {
    return { wallet, opening: undefined };
  }

  const transaction = WagerTransaction.opening({
    id: props.openingTransactionId,
    walletId: props.walletId,
    playerId: props.playerId,
    payloadHash: props.openingPayloadHash,
    money: props.initialBalance,
    observedBalance: props.initialBalance,
    createdAt: props.now,
  });

  const entry = WalletLedgerEntry.create({
    id: props.openingEntryId,
    walletId: props.walletId,
    transactionId: props.openingTransactionId,
    direction: LedgerDirection.Credit,
    money: props.initialBalance,
    balanceBefore: Money.zero(props.initialBalance.currency),
    balanceAfter: props.initialBalance,
    walletVersion: wallet.version,
    createdAt: props.now,
  });

  return { wallet, opening: { transaction, entry } };
}
