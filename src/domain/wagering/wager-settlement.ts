import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

export interface SettlementInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  /** Resolved by (providerId, referenceExternalTransactionId); undefined when not (yet) known. */
  reference: WagerTransaction | undefined;
  /** True when a PROCESSED REFUND/ROLLBACK already targets `reference`. */
  referenceAlreadyReversed: boolean;
  /** True when the retry budget / TTL for a missing reference is spent. */
  referenceWaitExhausted: boolean;
  /** Called only when a ledger entry is actually produced. */
  newEntryId: () => string;
  now: Date;
}

export type SettlementOutcome =
  | { type: 'PROCESSED'; ledgerEntry: WalletLedgerEntry | undefined }
  | { type: 'REJECTED'; failureCode: FailureCode }
  | { type: 'PENDING_REFERENCE' };

const REVERSIBLE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

/**
 * Pure domain service holding the business rules of the wagering flow. It mutates the aggregates it
 * is handed (wallet and transaction) and tells the caller what happened; persistence, locking and
 * events are the application layer's job.
 *
 * Interpretations adopted (also documented in ARCHITECTURE.md):
 *  - A transaction can be the target of at most ONE processed reversal of any kind. The brief says
 *    "once per reversal type", but allowing both a REFUND and a ROLLBACK of the same BET would
 *    credit the stake twice, which violates the global "no duplicated credit" invariant.
 *  - WIN / LOSS may optionally reference their BET (same rules as a reference: must exist, be
 *    PROCESSED, belong to the same player/wallet/currency/round, and not be reversed).
 *  - Any transaction carrying a reference whose target is missing (or not yet settled) waits as
 *    PENDING_REFERENCE, not only REFUND/ROLLBACK.
 */
export class WagerSettlement {
  settle(input: SettlementInput): SettlementOutcome {
    const { wallet, transaction } = input;

    if (wallet.playerId !== transaction.playerId) {
      return this.reject(input, FailureCode.PlayerMismatch);
    }
    if (wallet.currency !== transaction.money.currency) {
      return this.reject(input, FailureCode.CurrencyMismatch);
    }

    if (transaction.referenceExternalTransactionId !== undefined) {
      const referenceOutcome = this.checkReference(input);
      if (referenceOutcome) {
        return referenceOutcome;
      }
    }

    return this.apply(input);
  }

  private checkReference(input: SettlementInput): SettlementOutcome | undefined {
    const { transaction, reference } = input;

    if (!reference) {
      return input.referenceWaitExhausted
        ? this.reject(input, FailureCode.ReferenceNotFound)
        : { type: 'PENDING_REFERENCE' };
    }

    if (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return input.referenceWaitExhausted
        ? this.reject(input, FailureCode.ReferenceNotFound)
        : { type: 'PENDING_REFERENCE' };
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      return this.reject(input, FailureCode.ReferenceNotProcessed);
    }

    if (
      reference.providerId !== transaction.providerId ||
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.roundId !== transaction.roundId ||
      reference.money.currency !== transaction.money.currency
    ) {
      return this.reject(input, FailureCode.ReferenceMismatch);
    }

    if (!this.canTarget(transaction.kind, reference.kind)) {
      return this.reject(input, FailureCode.InvalidReferenceKind);
    }

    if (input.referenceAlreadyReversed) {
      return this.reject(input, FailureCode.AlreadyReversed);
    }

    if (transaction.requiresReference() && !transaction.money.equals(reference.money)) {
      return this.reject(input, FailureCode.AmountMismatch);
    }

    return undefined;
  }

  private canTarget(kind: WagerTransactionKind, referenceKind: WagerTransactionKind): boolean {
    switch (kind) {
      case WagerTransactionKind.Refund:
        return referenceKind === WagerTransactionKind.Bet;
      case WagerTransactionKind.Rollback:
        return REVERSIBLE_KINDS.has(referenceKind);
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Loss:
        return referenceKind === WagerTransactionKind.Bet;
      default:
        return false;
    }
  }

  private apply(input: SettlementInput): SettlementOutcome {
    const { wallet, transaction, reference, now } = input;
    const money = transaction.money;
    let entry: WalletLedgerEntry | undefined;

    switch (transaction.kind) {
      case WagerTransactionKind.Bet: {
        if (!wallet.canDebit(money)) {
          return this.reject(input, FailureCode.InsufficientFunds);
        }
        entry = wallet.debit({
          entryId: input.newEntryId(),
          transactionId: transaction.id,
          money,
          at: now,
        });
        break;
      }
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund: {
        entry = wallet.credit({
          entryId: input.newEntryId(),
          transactionId: transaction.id,
          money,
          at: now,
        });
        break;
      }
      case WagerTransactionKind.Loss:
        break;
      case WagerTransactionKind.Rollback: {
        const direction = transaction.ledgerDirectionFor(reference);
        if (direction === LedgerDirection.Debit) {
          if (!wallet.canDebit(money)) {
            return this.reject(input, FailureCode.ReversalWouldOverdraw);
          }
          entry = wallet.debit({
            entryId: input.newEntryId(),
            transactionId: transaction.id,
            money,
            at: now,
          });
        } else {
          entry = wallet.credit({
            entryId: input.newEntryId(),
            transactionId: transaction.id,
            money,
            at: now,
          });
        }
        break;
      }
      case WagerTransactionKind.Opening:
        // OPENING never goes through settlement; it is created already PROCESSED.
        return this.reject(input, FailureCode.InternalError);
    }

    transaction.markProcessed(reference?.id, now, wallet.balance);
    return { type: 'PROCESSED', ledgerEntry: entry };
  }

  private reject(input: SettlementInput, failureCode: FailureCode): SettlementOutcome {
    input.transaction.reject(failureCode, input.now, input.wallet.balance);
    return { type: 'REJECTED', failureCode };
  }
}
