import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  PendingReferenceClaim,
  ReconciliationSnapshot,
  WagerTransactionRepository,
  WalletRepository,
} from '@/application/ports/repositories';
import type { Metrics } from '@/application/ports/metrics';
import type { Clock, IdGenerator, Logger } from '@/application/ports/services';
import type { Tx, UnitOfWork } from '@/application/ports/transaction';
import { ConcurrentModificationError } from '@/application/errors';
import { LedgerDirection, WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import { InboxMessage, InboxMessageState } from '@/domain/messaging/inbox-message';
import { OutboxMessage, OutboxMessageState } from '@/domain/messaging/outbox-message';
import { Money } from '@/domain/money/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionState,
  WagerTransactionStatus,
} from '@/domain/wagering/wager-transaction';
import { Wallet, WalletState } from '@/domain/wallet/wallet';

/**
 * A tiny in-memory "database" used ONLY by application-level unit tests (business flows).
 * It stores plain state objects (like rows), rolls back on error, and enforces the same
 * uniqueness rules as the SQL schema. It cannot model concurrency: that is what the
 * integration/concurrency suites are for, against real PostgreSQL.
 */
export class InMemoryDb {
  wallets = new Map<string, WalletState>();
  transactions = new Map<string, WagerTransactionState>();
  ledger: WalletLedgerEntry[] = [];
  inbox = new Map<string, InboxMessageState>();
  outbox = new Map<string, OutboxMessageState>();

  snapshot(): InMemoryDb {
    const copy = new InMemoryDb();
    copy.wallets = new Map(this.wallets);
    copy.transactions = new Map(this.transactions);
    copy.ledger = [...this.ledger];
    copy.inbox = new Map(this.inbox);
    copy.outbox = new Map(this.outbox);
    return copy;
  }

  restore(from: InMemoryDb): void {
    this.wallets = from.wallets;
    this.transactions = from.transactions;
    this.ledger = from.ledger;
    this.inbox = from.inbox;
    this.outbox = from.outbox;
  }

  /** wallet.balance must equal what the ledger says. */
  ledgerBalance(walletId: string, currency: string): Money {
    return this.ledger
      .filter((entry) => entry.walletId === walletId)
      .reduce(
        (sum, entry) =>
          entry.direction === LedgerDirection.Credit
            ? sum.add(entry.money)
            : sum.subtract(entry.money),
        Money.zero(currency),
      );
  }

  outboxEventTypes(): string[] {
    return [...this.outbox.values()].map((m) => m.eventType);
  }
}

const tx = {} as Tx;

export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(private readonly db: InMemoryDb) {}

  async run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const before = this.db.snapshot();
    try {
      return await work(tx);
    } catch (error) {
      this.db.restore(before);
      throw error;
    }
  }

  read<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return work(tx);
  }
}

export class InMemoryWalletRepository implements WalletRepository {
  constructor(private readonly db: InMemoryDb) {}

  async exists(_tx: Tx, id: string): Promise<boolean> {
    return this.db.wallets.has(id);
  }

  async findById(_tx: Tx, id: string): Promise<Wallet | undefined> {
    const state = this.db.wallets.get(id);
    return state ? Wallet.rehydrate(state) : undefined;
  }

  findByIdForUpdate(t: Tx, id: string): Promise<Wallet | undefined> {
    return this.findById(t, id);
  }

  async insertIfAbsent(_tx: Tx, wallet: Wallet): Promise<boolean> {
    for (const w of this.db.wallets.values()) {
      if (w.playerId === wallet.playerId && w.currency === wallet.currency) return false;
    }
    this.db.wallets.set(wallet.id, snapshotWallet(wallet));
    return true;
  }

  async update(_tx: Tx, wallet: Wallet, expectedVersion: number): Promise<void> {
    const current = this.db.wallets.get(wallet.id);
    if (!current || current.version !== expectedVersion) {
      throw new ConcurrentModificationError('wallet', wallet.id);
    }
    this.db.wallets.set(wallet.id, snapshotWallet(wallet));
  }

  async reconciliationSnapshot(
    _tx: Tx,
    walletId: string,
  ): Promise<ReconciliationSnapshot | undefined> {
    const wallet = this.db.wallets.get(walletId);
    if (!wallet) return undefined;
    const entries = this.db.ledger.filter((e) => e.walletId === walletId);
    return {
      walletId,
      currency: wallet.currency,
      storedBalance: wallet.balance.amount,
      calculatedBalance: this.db.ledgerBalance(walletId, wallet.currency).amount,
      checkedEntries: entries.length,
      chainIntact: true,
    };
  }
}

function snapshotWallet(wallet: Wallet): WalletState {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export class InMemoryTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly db: InMemoryDb) {}

  private all(): WagerTransactionState[] {
    return [...this.db.transactions.values()];
  }

  async insertIfAbsent(_tx: Tx, t: WagerTransaction): Promise<boolean> {
    const clash = this.all().some(
      (s) =>
        s.idempotencyKey === t.idempotencyKey ||
        (s.providerId === t.providerId && s.externalTransactionId === t.externalTransactionId),
    );
    if (clash) return false;
    this.db.transactions.set(t.id, t.toState());
    return true;
  }

  async findById(_tx: Tx, id: string) {
    const s = this.db.transactions.get(id);
    return s ? WagerTransaction.rehydrate(s) : undefined;
  }

  findByIdForUpdate(t: Tx, id: string) {
    return this.findById(t, id);
  }

  async findByIdempotencyKey(_tx: Tx, key: string) {
    const s = this.all().find((x) => x.idempotencyKey === key);
    return s ? WagerTransaction.rehydrate(s) : undefined;
  }

  async findByProviderAndExternalId(_tx: Tx, providerId: string, externalId: string) {
    const s = this.all().find(
      (x) => x.providerId === providerId && x.externalTransactionId === externalId,
    );
    return s ? WagerTransaction.rehydrate(s) : undefined;
  }

  async update(_tx: Tx, t: WagerTransaction): Promise<void> {
    const current = this.db.transactions.get(t.id);
    if (
      current &&
      [
        WagerTransactionStatus.Processed,
        WagerTransactionStatus.Rejected,
        WagerTransactionStatus.Failed,
      ].includes(current.status)
    ) {
      throw new Error('terminal transactions are immutable (database trigger)');
    }
    this.db.transactions.set(t.id, t.toState());
  }

  async hasProcessedReversalOf(_tx: Tx, transactionId: string): Promise<boolean> {
    return this.all().some(
      (s) =>
        s.status === WagerTransactionStatus.Processed &&
        s.referenceTransactionId === transactionId &&
        (s.kind === WagerTransactionKind.Refund || s.kind === WagerTransactionKind.Rollback),
    );
  }

  async claimDuePendingReferences(
    _tx: Tx,
    now: Date,
    limit: number,
  ): Promise<PendingReferenceClaim[]> {
    return this.all()
      .filter(
        (s) =>
          s.status === WagerTransactionStatus.PendingReference &&
          s.nextAttemptAt !== undefined &&
          s.nextAttemptAt.getTime() <= now.getTime(),
      )
      .slice(0, limit)
      .map((s) => ({ transactionId: s.id, walletId: s.walletId }));
  }

  async wakeDependents(
    _tx: Tx,
    providerId: string,
    externalId: string,
    now: Date,
  ): Promise<number> {
    let count = 0;
    for (const s of this.all()) {
      if (
        s.status === WagerTransactionStatus.PendingReference &&
        s.providerId === providerId &&
        s.referenceExternalTransactionId === externalId
      ) {
        this.db.transactions.set(s.id, { ...s, nextAttemptAt: now });
        count += 1;
      }
    }
    return count;
  }
}

export class InMemoryLedgerRepository implements LedgerRepository {
  constructor(private readonly db: InMemoryDb) {}

  async append(_tx: Tx, entry: WalletLedgerEntry): Promise<void> {
    const dup = this.db.ledger.some(
      (e) =>
        e.transactionId === entry.transactionId ||
        (e.walletId === entry.walletId && e.walletVersion === entry.walletVersion),
    );
    if (dup) throw new Error('duplicate ledger entry (unique constraint)');
    this.db.ledger.push(entry);
  }

  async list(_tx: Tx, walletId: string, afterVersion: number, limit: number) {
    return this.db.ledger
      .filter((e) => e.walletId === walletId && e.walletVersion > afterVersion)
      .sort((a, b) => a.walletVersion - b.walletVersion)
      .slice(0, limit);
  }
}

export class InMemoryInboxRepository implements InboxRepository {
  constructor(private readonly db: InMemoryDb) {}

  private key(consumer: string, id: string): string {
    return `${consumer}|${id}`;
  }

  async tryReceive(_tx: Tx, m: InboxMessage): Promise<boolean> {
    const key = this.key(m.consumerName, m.messageId);
    if (this.db.inbox.has(key)) return false;
    this.db.inbox.set(key, {
      messageId: m.messageId,
      consumerName: m.consumerName,
      payloadHash: m.payloadHash,
      receivedAt: m.receivedAt,
      ...(m.processedAt ? { processedAt: m.processedAt } : {}),
    });
    return true;
  }

  async find(_tx: Tx, consumer: string, id: string) {
    const s = this.db.inbox.get(this.key(consumer, id));
    return s ? InboxMessage.rehydrate(s) : undefined;
  }
}

export class InMemoryOutboxRepository implements OutboxRepository {
  constructor(private readonly db: InMemoryDb) {}

  async enqueue(_tx: Tx, m: OutboxMessage): Promise<void> {
    this.db.outbox.set(m.id, toOutboxState(m));
  }

  async claimDue(_tx: Tx, now: Date, limit: number) {
    return [...this.db.outbox.values()]
      .map((s) => OutboxMessage.rehydrate(s))
      .filter((m) => m.isDue(now))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .slice(0, limit);
  }

  async save(_tx: Tx, m: OutboxMessage): Promise<void> {
    this.db.outbox.set(m.id, toOutboxState(m));
  }

  async stats(_tx: Tx, now: Date) {
    const pending = [...this.db.outbox.values()].filter((s) => s.publishedAt === undefined);
    const oldest = pending.reduce<number>(
      (min, s) => Math.min(min, s.occurredAt.getTime()),
      now.getTime(),
    );
    return {
      pendingCount: pending.length,
      oldestPendingAgeSeconds: (now.getTime() - oldest) / 1000,
    };
  }
}

function toOutboxState(m: OutboxMessage): OutboxMessageState {
  return {
    id: m.id,
    aggregateId: m.aggregateId,
    eventType: m.eventType,
    payload: m.payload,
    occurredAt: m.occurredAt,
    attempts: m.attempts,
    ...(m.nextAttemptAt ? { nextAttemptAt: m.nextAttemptAt } : {}),
    ...(m.publishedAt ? { publishedAt: m.publishedAt } : {}),
    ...(m.lastError ? { lastError: m.lastError } : {}),
  };
}

export class FakeClock implements Clock {
  constructor(private current = new Date('2026-01-01T00:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `00000000-0000-7000-8000-${this.n.toString(16).padStart(12, '0')}`;
  }
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return silentLogger;
  },
};

export class RecordingMetrics implements Metrics {
  counts = new Map<string, number>();
  private bump(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  transactionOutcome(status: string, kind: string): void {
    this.bump(`outcome:${status}:${kind}`);
  }
  duplicateDetected(source: string): void {
    this.bump(`duplicate:${source}`);
  }
  idempotencyConflict(source: string): void {
    this.bump(`conflict:${source}`);
  }
  processingDuration(): void {}
  walletLockWait(): void {}
  lockConflict(type: string): void {
    this.bump(`lock:${type}`);
  }
  retry(component: string, reason: string): void {
    this.bump(`retry:${component}:${reason}`);
  }
  dlqMessage(reason: string): void {
    this.bump(`dlq:${reason}`);
  }
  outboxPublished(): void {
    this.bump('outbox:published');
  }
  outboxPublishFailed(): void {
    this.bump('outbox:failed');
  }
  outboxBacklog(): void {}
  reconciliationDivergence(): void {
    this.bump('reconciliation:divergence');
  }
}
