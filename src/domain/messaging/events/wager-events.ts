import { LedgerDirection, WalletLedgerEntry } from '../../ledger/wallet-ledger-entry';
import { MoneyProps } from '../../money/money';
import { FailureCode, RetryAdvice, retryAdviceFor } from '../../wagering/failure-code';
import { WagerTransaction, WagerTransactionKind } from '../../wagering/wager-transaction';
import { Wallet } from '../../wallet/wallet';
import { EventContext, IntegrationEvent } from '../integration-event';

interface WagerTransactionEventBase {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function base(transaction: WagerTransaction): WagerTransactionEventBase {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

// ---------------------------------------------------------------- WagerTransactionProcessed

export interface WagerTransactionProcessedData extends WagerTransactionEventBase {
  /** Wallet balance right after the transaction was applied. */
  balance: MoneyProps;
  referenceTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const balance = transaction.observedBalance;
    if (!balance) {
      throw new Error('a processed transaction must carry its observed balance');
    }
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data: {
        ...base(transaction),
        balance: balance.toJSON(),
        ...(transaction.referenceTransactionId !== undefined
          ? { referenceTransactionId: transaction.referenceTransactionId }
          : {}),
      },
    });
  }
}

// ---------------------------------------------------------------- WagerTransactionRejected

export interface WagerTransactionRejectedData extends WagerTransactionEventBase {
  failureCode: FailureCode;
  retryAdvice: RetryAdvice;
  balance?: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const failureCode = transaction.failureCode;
    if (!failureCode) {
      throw new Error('a rejected transaction must carry a failure code');
    }
    return new WagerTransactionRejected({
      eventId: ctx.eventId,
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data: {
        ...base(transaction),
        failureCode,
        retryAdvice: retryAdviceFor(failureCode),
        ...(transaction.observedBalance ? { balance: transaction.observedBalance.toJSON() } : {}),
      },
    });
  }
}

// ---------------------------------------------------------------- WagerTransactionPendingReference

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventBase {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const reference = transaction.referenceExternalTransactionId;
    if (!reference) {
      throw new Error('a pending-reference transaction must carry referenceExternalTransactionId');
    }
    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data: { ...base(transaction), referenceExternalTransactionId: reference },
    });
  }
}

// ---------------------------------------------------------------- WalletBalanceChanged

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
