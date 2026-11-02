import { WagerSettlement } from '@/domain/wagering/wager-settlement';
import { PendingReferencePolicy } from '@/domain/wagering/pending-reference-policy';
import { FailureCode } from '@/domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import { Metrics } from '../ports/metrics';
import {
  PendingReferenceClaim,
  WagerTransactionRepository,
  WalletRepository,
} from '../ports/repositories';
import { Clock, IdGenerator, Logger } from '../ports/services';
import { UnitOfWork } from '../ports/transaction';
import { SettlementPersister } from '../services/settlement-persister';

export type ReprocessResult = 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'SKIPPED';

/** Leases a batch of due PENDING_REFERENCE transactions so concurrent workers never pick the same ones. */
export class ClaimDuePendingReferencesUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      transactions: WagerTransactionRepository;
      clock: Clock;
      leaseMs: number;
    },
  ) {}

  async execute(limit: number): Promise<PendingReferenceClaim[]> {
    return this.deps.uow.run((tx) => {
      const now = this.deps.clock.now();
      const leaseUntil = new Date(now.getTime() + this.deps.leaseMs);
      return this.deps.transactions.claimDuePendingReferences(tx, now, limit, leaseUntil);
    });
  }
}

export interface ReprocessPendingReferenceDeps {
  uow: UnitOfWork;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  persister: SettlementPersister;
  settlement: WagerSettlement;
  policy: PendingReferencePolicy;
  clock: Clock;
  ids: IdGenerator;
  metrics: Metrics;
  logger: Logger;
}

/**
 * Re-evaluates one PENDING_REFERENCE transaction with the same settlement rules as the first pass.
 *
 * Lock order is always wallet row -> transaction row (the same order the submit path implicitly
 * uses), so the worker cannot deadlock with concurrent submissions on the same wallet.
 */
export class ReprocessPendingReferenceUseCase {
  constructor(private readonly deps: ReprocessPendingReferenceDeps) {}

  async execute(claim: PendingReferenceClaim, correlationId: string): Promise<ReprocessResult> {
    const startedAt = performance.now();
    const result = await this.deps.uow.run(async (tx): Promise<ReprocessResult> => {
      const { wallets, transactions, settlement, persister, policy, ids, clock } = this.deps;
      const now = clock.now();

      const wallet = await wallets.findByIdForUpdate(tx, claim.walletId);
      const transaction = await transactions.findByIdForUpdate(tx, claim.transactionId);
      if (
        !wallet ||
        !transaction ||
        transaction.status !== WagerTransactionStatus.PendingReference ||
        transaction.referenceExternalTransactionId === undefined
      ) {
        return 'SKIPPED';
      }
      const expectedWalletVersion = wallet.version;

      const reference = await transactions.findByProviderAndExternalId(
        tx,
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      const referenceAlreadyReversed =
        reference?.status === WagerTransactionStatus.Processed
          ? await transactions.hasProcessedReversalOf(tx, reference.id)
          : false;

      const exhausted = policy.isExhausted(
        transaction.referenceAttempts + 1,
        transaction.createdAt,
        now,
      );
      const outcome = settlement.settle({
        wallet,
        transaction,
        reference,
        referenceAlreadyReversed,
        referenceWaitExhausted: exhausted,
        newEntryId: () => ids.next(),
        now,
      });

      await persister.persist(tx, {
        wallet,
        expectedWalletVersion,
        transaction,
        previousStatus: WagerTransactionStatus.PendingReference,
        outcome,
        correlationId,
        causationId: transaction.id,
        now,
      });
      return outcome.type;
    });

    this.deps.metrics.processingDuration('reprocess', (performance.now() - startedAt) / 1000);
    if (result !== 'SKIPPED') {
      this.deps.logger.info('pending reference reevaluated', {
        correlationId,
        transactionId: claim.transactionId,
        walletId: claim.walletId,
        result,
      });
    }
    return result;
  }

  /**
   * Last resort for a permanent, unexpected error while reevaluating (e.g. a corrupted row): the
   * transaction is parked as FAILED so it stops being retried and stays auditable.
   */
  async markFailed(claim: PendingReferenceClaim, correlationId: string): Promise<void> {
    await this.deps.uow.run(async (tx) => {
      const { wallets, transactions, clock } = this.deps;
      const wallet = await wallets.findByIdForUpdate(tx, claim.walletId);
      const transaction: WagerTransaction | undefined = await transactions.findByIdForUpdate(
        tx,
        claim.transactionId,
      );
      if (!wallet || !transaction || transaction.isTerminal()) {
        return;
      }
      const now = clock.now();
      transaction.fail(FailureCode.InternalError, now);
      await transactions.update(tx, transaction);
      this.deps.metrics.transactionOutcome(transaction.status, transaction.kind);
      this.deps.logger.error('pending reference marked FAILED', {
        correlationId,
        transactionId: claim.transactionId,
        walletId: claim.walletId,
        failureCode: FailureCode.InternalError,
      });
    });
  }
}
