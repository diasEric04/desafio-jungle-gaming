import { LockMode } from '@mikro-orm/core';
import type {
  PendingReferenceClaim,
  WagerTransactionRepository,
} from '@/application/ports/repositories';
import type { Tx } from '@/application/ports/transaction';
import { WagerTransaction } from '@/domain/wagering/wager-transaction';
import { toWagerTransaction } from '../mappers';
import { WagerTransactionRecord } from '../schemas/records';
import { emOf } from '../unit-of-work';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  /**
   * The unique indexes on (idempotency_key) and (provider_id, external_transaction_id) are the
   * idempotency barrier. A concurrent duplicate blocks here until the winner commits, then gets zero
   * rows back and replays the committed result.
   */
  async insertIfAbsent(tx: Tx, t: WagerTransaction): Promise<boolean> {
    const s = t.toState();
    const rows = await emOf(tx).execute<unknown[]>(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id,
         reference_transaction_id, status, failure_code, observed_balance, reference_attempts,
         next_attempt_at, lease_until, created_at, updated_at, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        s.id,
        s.providerId,
        s.externalTransactionId,
        s.idempotencyKey,
        s.payloadHash,
        s.walletId,
        s.playerId,
        s.roundId,
        s.gameId,
        s.kind,
        s.money.amount,
        s.money.currency,
        s.referenceExternalTransactionId ?? null,
        s.referenceTransactionId ?? null,
        s.status,
        s.failureCode ?? null,
        s.observedBalance?.amount ?? null,
        s.referenceAttempts,
        s.nextAttemptAt ?? null,
        null,
        s.createdAt,
        s.updatedAt,
        s.processedAt ?? null,
      ],
    );
    return rows.length > 0;
  }

  async findById(tx: Tx, id: string): Promise<WagerTransaction | undefined> {
    const record = await emOf(tx).findOne(WagerTransactionRecord, { id });
    return record ? toWagerTransaction(record) : undefined;
  }

  /** Must be the first load of this row in the unit of work (see wallet repository note). */
  async findByIdForUpdate(tx: Tx, id: string): Promise<WagerTransaction | undefined> {
    const record = await emOf(tx).findOne(
      WagerTransactionRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record ? toWagerTransaction(record) : undefined;
  }

  async findByIdempotencyKey(tx: Tx, key: string): Promise<WagerTransaction | undefined> {
    const record = await emOf(tx).findOne(WagerTransactionRecord, { idempotencyKey: key });
    return record ? toWagerTransaction(record) : undefined;
  }

  async findByProviderAndExternalId(
    tx: Tx,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await emOf(tx).findOne(WagerTransactionRecord, {
      providerId,
      externalTransactionId,
    });
    return record ? toWagerTransaction(record) : undefined;
  }

  async update(tx: Tx, t: WagerTransaction): Promise<void> {
    const s = t.toState();
    await emOf(tx).nativeUpdate(
      WagerTransactionRecord,
      { id: s.id },
      {
        status: s.status,
        failureCode: s.failureCode ?? null,
        referenceTransactionId: s.referenceTransactionId ?? null,
        observedBalance: s.observedBalance?.amount ?? null,
        referenceAttempts: s.referenceAttempts,
        nextAttemptAt: s.nextAttemptAt ?? null,
        leaseUntil: null,
        processedAt: s.processedAt ?? null,
        updatedAt: s.updatedAt,
      },
    );
  }

  async hasProcessedReversalOf(tx: Tx, transactionId: string): Promise<boolean> {
    const rows = await emOf(tx).execute<unknown[]>(
      `SELECT 1 FROM wager_transactions
        WHERE reference_transaction_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
        LIMIT 1`,
      [transactionId],
    );
    return rows.length > 0;
  }

  async claimDuePendingReferences(
    tx: Tx,
    now: Date,
    limit: number,
    leaseUntil: Date,
  ): Promise<PendingReferenceClaim[]> {
    // SKIP LOCKED + a lease: concurrent workers get disjoint batches, and a worker that dies only
    // delays its batch until the lease expires.
    const rows = await emOf(tx).execute<Array<{ id: string; walletId: string }>>(
      `UPDATE wager_transactions SET lease_until = ?
        WHERE id IN (
          SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
             AND (lease_until IS NULL OR lease_until < ?)
           ORDER BY next_attempt_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED)
        RETURNING id, wallet_id AS "walletId"`,
      [leaseUntil, now, now, limit],
    );
    return rows.map((row) => ({ transactionId: row.id, walletId: row.walletId }));
  }

  async wakeDependents(
    tx: Tx,
    providerId: string,
    externalTransactionId: string,
    now: Date,
  ): Promise<number> {
    const rows = await emOf(tx).execute<unknown[]>(
      `UPDATE wager_transactions SET next_attempt_at = ?
        WHERE id IN (
          SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE' AND provider_id = ? AND reference_external_transaction_id = ?
             AND next_attempt_at > ?
           FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      [now, providerId, externalTransactionId, now],
    );
    return rows.length;
  }
}
