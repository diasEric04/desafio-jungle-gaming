import { MoneyProps } from '@/domain/money/money';
import { FailureCode, RetryAdvice, retryAdviceFor } from '@/domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@/domain/wagering/wager-transaction';

/** What a provider gets back for a submitted transaction (HTTP body; SQS only logs it). */
export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Wallet balance observed when the transaction was settled; null while nothing was settled. */
  balance: MoneyProps | null;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
  retryAdvice?: RetryAdvice;
}

export function toResult(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): WagerTransactionResult {
  const failureCode = transaction.failureCode;
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.observedBalance?.toJSON() ?? null,
    idempotentReplay,
    ...(failureCode !== undefined ? { failureCode, retryAdvice: retryAdviceFor(failureCode) } : {}),
  };
}

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  retryAdvice?: RetryAdvice;
  balance: MoneyProps | null;
  createdAt: string;
  processedAt?: string;
}

export function toView(transaction: WagerTransaction): WagerTransactionView {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    ...(transaction.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
      : {}),
    ...(transaction.referenceTransactionId !== undefined
      ? { referenceTransactionId: transaction.referenceTransactionId }
      : {}),
    ...(transaction.failureCode !== undefined
      ? {
          failureCode: transaction.failureCode,
          retryAdvice: retryAdviceFor(transaction.failureCode),
        }
      : {}),
    balance: transaction.observedBalance?.toJSON() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt !== undefined
      ? { processedAt: transaction.processedAt.toISOString() }
      : {}),
  };
}
