import { EventContext } from '@/domain/messaging/integration-event';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '@/domain/messaging/events/wager-events';
import { PendingReferencePolicy } from '@/domain/wagering/pending-reference-policy';
import { SettlementOutcome } from '@/domain/wagering/wager-settlement';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionStatus,
} from '@/domain/wagering/wager-transaction';
import { Wallet } from '@/domain/wallet/wallet';
import { Metrics } from '../ports/metrics';
import {
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../ports/repositories';
import { IdGenerator } from '../ports/services';
import { Tx } from '../ports/transaction';

export interface PersistSettlementInput {
  wallet: Wallet;
  /** Wallet version that was read under the lock (compare-and-swap target). */
  expectedWalletVersion: number;
  transaction: WagerTransaction;
  previousStatus: WagerTransactionStatus;
  outcome: SettlementOutcome;
  correlationId: string;
  causationId: string;
  now: Date;
}

export interface SettlementPersisterDeps {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  ids: IdGenerator;
  pendingPolicy: PendingReferencePolicy;
  metrics: Metrics;
}

/**
 * Writes the result of a settlement. Transaction state, wallet balance, ledger entry and the
 * integration events all go through the SAME `tx`, so they commit (or roll back) together.
 * Nothing is published here: events only become outbox rows.
 */
export class SettlementPersister {
  constructor(private readonly deps: SettlementPersisterDeps) {}

  async persist(tx: Tx, input: PersistSettlementInput): Promise<void> {
    const { wallet, transaction, outcome, now } = input;
    const { transactions, wallets, ledger, outbox, metrics } = this.deps;

    if (outcome.type === 'PENDING_REFERENCE') {
      const firstTime = input.previousStatus === WagerTransactionStatus.Pending;
      if (firstTime) {
        transaction.markPendingReference(
          wallet.balance,
          this.deps.pendingPolicy.nextAttemptAt(0, now),
          now,
        );
      } else {
        const nextAttempt = transaction.referenceAttempts + 1;
        transaction.rescheduleReference(
          this.deps.pendingPolicy.nextAttemptAt(nextAttempt, now),
          now,
        );
      }
      await transactions.update(tx, transaction);
      if (firstTime) {
        await outbox.enqueue(
          tx,
          OutboxMessage.enqueue(
            WagerTransactionPendingReference.from(transaction, this.context(input)),
          ),
        );
        metrics.transactionOutcome(transaction.status, transaction.kind);
      }
      return;
    }

    await transactions.update(tx, transaction);

    if (outcome.type === 'PROCESSED') {
      if (outcome.ledgerEntry) {
        await ledger.append(tx, outcome.ledgerEntry);
        await wallets.update(tx, wallet, input.expectedWalletVersion);
      }
      await outbox.enqueue(
        tx,
        OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, this.context(input))),
      );
      if (outcome.ledgerEntry) {
        await outbox.enqueue(
          tx,
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, outcome.ledgerEntry, this.context(input)),
          ),
        );
      }
    } else {
      await outbox.enqueue(
        tx,
        OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, this.context(input))),
      );
    }

    metrics.transactionOutcome(transaction.status, transaction.kind);

    // Anything that was waiting for this transaction can be re-evaluated right away.
    if (transaction.providerId !== INTERNAL_PROVIDER_ID) {
      await transactions.wakeDependents(
        tx,
        transaction.providerId,
        transaction.externalTransactionId,
        now,
      );
    }
  }

  private context(input: PersistSettlementInput): EventContext {
    return {
      eventId: this.deps.ids.next(),
      correlationId: input.correlationId,
      causationId: input.causationId,
      occurredAt: input.now,
    };
  }
}
