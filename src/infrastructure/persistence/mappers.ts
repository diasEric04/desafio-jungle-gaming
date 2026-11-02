import { LedgerDirection, WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '@/domain/messaging/inbox-message';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { Money } from '@/domain/money/money';
import { FailureCode } from '@/domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@/domain/wagering/wager-transaction';
import { Wallet } from '@/domain/wallet/wallet';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './schemas/records';

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });

export function toWallet(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: money(r.balance, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function toWagerTransaction(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount, r.currency),
    ...(r.referenceExternalTransactionId
      ? { referenceExternalTransactionId: r.referenceExternalTransactionId }
      : {}),
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    ...(r.referenceTransactionId ? { referenceTransactionId: r.referenceTransactionId } : {}),
    ...(r.failureCode ? { failureCode: r.failureCode as FailureCode } : {}),
    ...(r.processedAt ? { processedAt: r.processedAt } : {}),
    ...(r.observedBalance !== null && r.observedBalance !== undefined
      ? { observedBalance: money(r.observedBalance, r.currency) }
      : {}),
    referenceAttempts: r.referenceAttempts,
    ...(r.nextAttemptAt ? { nextAttemptAt: r.nextAttemptAt } : {}),
    updatedAt: r.updatedAt,
  });
}

export function toLedgerEntry(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: money(r.amount, r.currency),
    balanceBefore: money(r.balanceBefore, r.currency),
    balanceAfter: money(r.balanceAfter, r.currency),
    walletVersion: r.walletVersion,
    createdAt: r.createdAt,
  });
}

export function toInboxMessage(r: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: r.messageId,
    consumerName: r.consumerName,
    payloadHash: r.payloadHash,
    receivedAt: r.receivedAt,
    ...(r.processedAt ? { processedAt: r.processedAt } : {}),
  });
}

export function toOutboxMessage(r: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
    ...(r.lastError ? { lastError: r.lastError } : {}),
  });
}
