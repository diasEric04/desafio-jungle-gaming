import { WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '@/domain/messaging/inbox-message';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { WagerTransaction } from '@/domain/wagering/wager-transaction';
import { Wallet } from '@/domain/wallet/wallet';
import { Tx } from './transaction';

export interface ReconciliationSnapshot {
  walletId: string;
  currency: string;
  /** wallets.balance */
  storedBalance: string;
  /** SUM(credits) - SUM(debits) over the ledger */
  calculatedBalance: string;
  checkedEntries: number;
  /** every entry starts where the previous one ended (and the first starts at zero) */
  chainIntact: boolean;
}

export interface WalletRepository {
  exists(tx: Tx, walletId: string): Promise<boolean>;
  /** Plain read, no lock. */
  findById(tx: Tx, walletId: string): Promise<Wallet | undefined>;
  /** `SELECT ... FOR UPDATE`: serializes every writer of this wallet (and only this wallet). */
  findByIdForUpdate(tx: Tx, walletId: string): Promise<Wallet | undefined>;
  /** Returns false when (playerId, currency) already has a wallet. */
  insertIfAbsent(tx: Tx, wallet: Wallet): Promise<boolean>;
  /** Compare-and-swap on version; throws ConcurrentModificationError when it lost the race. */
  update(tx: Tx, wallet: Wallet, expectedVersion: number): Promise<void>;
  /** Balance and ledger totals read in ONE statement (a consistent snapshot). */
  reconciliationSnapshot(tx: Tx, walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface PendingReferenceClaim {
  transactionId: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  /** `INSERT ... ON CONFLICT DO NOTHING`; false when the idempotency key or provider id already exists. */
  insertIfAbsent(tx: Tx, transaction: WagerTransaction): Promise<boolean>;
  findById(tx: Tx, id: string): Promise<WagerTransaction | undefined>;
  findByIdForUpdate(tx: Tx, id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(tx: Tx, key: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(
    tx: Tx,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  update(tx: Tx, transaction: WagerTransaction): Promise<void>;
  hasProcessedReversalOf(tx: Tx, transactionId: string): Promise<boolean>;
  /** Leases due PENDING_REFERENCE rows (`FOR UPDATE SKIP LOCKED`) so concurrent workers never overlap. */
  claimDuePendingReferences(
    tx: Tx,
    now: Date,
    limit: number,
    leaseUntil: Date,
  ): Promise<PendingReferenceClaim[]>;
  /** Makes transactions waiting for this reference due now. Never blocks (SKIP LOCKED). */
  wakeDependents(
    tx: Tx,
    providerId: string,
    externalTransactionId: string,
    now: Date,
  ): Promise<number>;
}

export interface LedgerRepository {
  append(tx: Tx, entry: WalletLedgerEntry): Promise<void>;
  /** Entries ordered by walletVersion ascending, strictly after `afterVersion`. */
  list(tx: Tx, walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
}

export interface InboxRepository {
  /** `INSERT ... ON CONFLICT DO NOTHING`; false when (consumerName, messageId) was already stored. */
  tryReceive(tx: Tx, message: InboxMessage): Promise<boolean>;
  find(tx: Tx, consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}

export interface OutboxStats {
  pendingCount: number;
  oldestPendingAgeSeconds: number;
}

export interface OutboxRepository {
  enqueue(tx: Tx, message: OutboxMessage): Promise<void>;
  /** Due, unpublished messages locked with `FOR UPDATE SKIP LOCKED`: concurrent publishers never overlap. */
  claimDue(tx: Tx, now: Date, limit: number): Promise<OutboxMessage[]>;
  save(tx: Tx, message: OutboxMessage): Promise<void>;
  stats(tx: Tx, now: Date): Promise<OutboxStats>;
}
