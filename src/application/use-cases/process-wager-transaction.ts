import { InboxMessage, InboxMessageConflictError } from '@/domain/messaging/inbox-message';
import { Money, MoneyProps } from '@/domain/money/money';
import { WagerSettlement } from '@/domain/wagering/wager-settlement';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@/domain/wagering/wager-transaction';
import {
  IdempotencyConflictError,
  InvalidTransactionStateError,
} from '@/domain/wagering/wagering.errors';
import { WalletNotFoundError } from '@/domain/wallet/wallet.errors';
import { hashCanonical } from '@/shared/hashing';
import { toResult, WagerTransactionResult } from '../dto';
import { Metrics, TransactionSource } from '../ports/metrics';
import {
  InboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../ports/repositories';
import { Clock, IdGenerator, Logger } from '../ports/services';
import { Tx, UnitOfWork } from '../ports/transaction';
import { SettlementPersister } from '../services/settlement-persister';

export interface InboxContext {
  consumerName: string;
  messageId: string;
  /** Hash of the whole broker message, used to detect a messageId reused with another body. */
  payloadHash: string;
}

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  source: TransactionSource;
  /** Present when the command came from a broker message (inbox deduplication). */
  inbox?: InboxContext;
}

export interface ProcessWagerTransactionDeps {
  uow: UnitOfWork;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  inbox: InboxRepository;
  persister: SettlementPersister;
  settlement: WagerSettlement;
  clock: Clock;
  ids: IdGenerator;
  metrics: Metrics;
  logger: Logger;
}

/**
 * Hash of the business fields of a submission. The Idempotency-Key header, transport metadata and
 * timestamps are deliberately excluded: same business request => same hash.
 * Algorithm: SHA-256 over the canonical JSON (keys sorted recursively, undefined dropped) of
 * { providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money,
 *   referenceExternalTransactionId }, with money normalized to scale 2.
 */
export function computePayloadHash(
  command: Pick<
    ProcessWagerTransactionCommand,
    | 'providerId'
    | 'externalTransactionId'
    | 'playerId'
    | 'walletId'
    | 'roundId'
    | 'gameId'
    | 'kind'
    | 'referenceExternalTransactionId'
  >,
  money: Money,
): string {
  return hashCanonical({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: money.toJSON(),
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  });
}

/**
 * The single entry point for financial operations: the HTTP controller and the SQS consumer both
 * call this use case, so they share every rule and every guarantee.
 *
 * Flow inside ONE SQL transaction:
 *   1. inbox row (broker input only): a duplicate delivery short-circuits to the stored result;
 *   2. INSERT the transaction ON CONFLICT DO NOTHING: the unique indexes are the idempotency
 *      barrier, so N concurrent copies of the same request produce exactly one winner and the
 *      others replay the winner's committed result (or conflict if the payload differs);
 *   3. lock ONLY this wallet's row (SELECT ... FOR UPDATE), settle against the locked state,
 *   4. persist transaction + wallet + ledger + outbox events together.
 */
export class ProcessWagerTransactionUseCase {
  constructor(private readonly deps: ProcessWagerTransactionDeps) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    const startedAt = performance.now();
    const money = Money.from(command.money);
    const payloadHash = computePayloadHash(command, money);

    // Fail fast on malformed input, before taking a connection. The real object is rebuilt inside
    // the transaction because the unit of work may re-run the callback after a deadlock.
    this.buildTransaction(command, money, payloadHash, this.deps.clock.now());

    const result = await this.deps.uow.run((tx) =>
      this.executeInTransaction(tx, command, money, payloadHash),
    );

    this.deps.metrics.processingDuration(command.source, (performance.now() - startedAt) / 1000);
    if (result.idempotentReplay) {
      this.deps.metrics.duplicateDetected(command.source);
    }
    this.deps.logger.info('wager transaction handled', {
      correlationId: command.correlationId,
      messageId: command.inbox?.messageId,
      transactionId: result.transactionId,
      walletId: command.walletId,
      providerId: command.providerId,
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
      source: command.source,
    });
    return result;
  }

  private async executeInTransaction(
    tx: Tx,
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
  ): Promise<WagerTransactionResult> {
    const { wallets, transactions, inbox, settlement, persister, ids, clock, metrics } = this.deps;
    const now = clock.now();

    if (command.inbox) {
      const message = InboxMessage.receive({
        messageId: command.inbox.messageId,
        consumerName: command.inbox.consumerName,
        payloadHash: command.inbox.payloadHash,
        receivedAt: now,
      });
      // The financial effect commits in this same transaction, so "stored" means "processed".
      message.markProcessed(now);
      const firstDelivery = await inbox.tryReceive(tx, message);
      if (!firstDelivery) {
        const stored = await inbox.find(tx, message.consumerName, message.messageId);
        if (stored && stored.payloadHash !== message.payloadHash) {
          metrics.idempotencyConflict(command.source);
          throw new InboxMessageConflictError(message.consumerName, message.messageId);
        }
        const existing = await transactions.findByIdempotencyKey(tx, command.idempotencyKey);
        if (!existing) {
          throw new InvalidTransactionStateError(
            `inbox says ${message.messageId} was processed but no transaction exists`,
          );
        }
        return toResult(existing, true);
      }
    }

    if (!(await wallets.exists(tx, command.walletId))) {
      throw new WalletNotFoundError(command.walletId);
    }

    const transaction = this.buildTransaction(command, money, payloadHash, now);
    const inserted = await transactions.insertIfAbsent(tx, transaction);
    if (!inserted) {
      const existing =
        (await transactions.findByIdempotencyKey(tx, command.idempotencyKey)) ??
        (await transactions.findByProviderAndExternalId(
          tx,
          command.providerId,
          command.externalTransactionId,
        ));
      if (!existing) {
        throw new InvalidTransactionStateError(
          `unique violation on ${command.idempotencyKey} but no committed row is visible`,
        );
      }
      if (
        existing.idempotencyKey !== command.idempotencyKey ||
        !existing.matchesPayload(payloadHash)
      ) {
        metrics.idempotencyConflict(command.source);
        throw new IdempotencyConflictError(command.idempotencyKey);
      }
      return toResult(existing, true);
    }

    // From here on this request owns the transaction row. Serialize on the wallet.
    const lockStartedAt = performance.now();
    const wallet = await wallets.findByIdForUpdate(tx, command.walletId);
    metrics.walletLockWait((performance.now() - lockStartedAt) / 1000);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }
    const expectedWalletVersion = wallet.version;

    let reference: WagerTransaction | undefined;
    let referenceAlreadyReversed = false;
    if (transaction.referenceExternalTransactionId !== undefined) {
      reference = await transactions.findByProviderAndExternalId(
        tx,
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      if (reference?.status === WagerTransactionStatus.Processed) {
        referenceAlreadyReversed = await transactions.hasProcessedReversalOf(tx, reference.id);
      }
    }

    const outcome = settlement.settle({
      wallet,
      transaction,
      reference,
      referenceAlreadyReversed,
      referenceWaitExhausted: false,
      newEntryId: () => ids.next(),
      now,
    });

    await persister.persist(tx, {
      wallet,
      expectedWalletVersion,
      transaction,
      previousStatus: WagerTransactionStatus.Pending,
      outcome,
      correlationId: command.correlationId,
      causationId: command.inbox?.messageId ?? transaction.id,
      now,
    });

    return toResult(transaction, false);
  }

  private buildTransaction(
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
    now: Date,
  ): WagerTransaction {
    return WagerTransaction.create({
      id: this.deps.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      ...(command.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: command.referenceExternalTransactionId }
        : {}),
      createdAt: now,
    });
  }
}
