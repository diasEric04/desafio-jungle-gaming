import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  OutboxStats,
} from '@/application/ports/repositories';
import type { Tx } from '@/application/ports/transaction';
import { WalletLedgerEntry } from '@/domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '@/domain/messaging/inbox-message';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { toInboxMessage, toLedgerEntry, toOutboxMessage } from '../mappers';
import { InboxMessageRecord, LedgerEntryRecord, OutboxMessageRecord } from '../schemas/records';
import { emOf } from '../unit-of-work';

export class MikroOrmLedgerRepository implements LedgerRepository {
  async append(tx: Tx, entry: WalletLedgerEntry): Promise<void> {
    // INSERT only. The table has no UPDATE/DELETE path and triggers reject them anyway.
    await emOf(tx).insert(LedgerEntryRecord, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.amount,
      balanceAfter: entry.balanceAfter.amount,
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    });
  }

  async list(
    tx: Tx,
    walletId: string,
    afterVersion: number,
    limit: number,
  ): Promise<WalletLedgerEntry[]> {
    const records = await emOf(tx).find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit },
    );
    return records.map(toLedgerEntry);
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  async tryReceive(tx: Tx, message: InboxMessage): Promise<boolean> {
    const rows = await emOf(tx).execute<unknown[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
    );
    return rows.length > 0;
  }

  async find(tx: Tx, consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await emOf(tx).findOne(InboxMessageRecord, { consumerName, messageId });
    return record ? toInboxMessage(record) : undefined;
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  async enqueue(tx: Tx, message: OutboxMessage): Promise<void> {
    await emOf(tx).insert(OutboxMessageRecord, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload as Record<string, unknown>,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
      publishedAt: null,
      lastError: null,
    });
  }

  async claimDue(tx: Tx, now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await emOf(tx).execute<OutboxMessageRecord[]>(
      `SELECT id, aggregate_id AS "aggregateId", event_type AS "eventType", payload,
              occurred_at AS "occurredAt", attempts, next_attempt_at AS "nextAttemptAt",
              published_at AS "publishedAt", last_error AS "lastError"
         FROM outbox_messages
        WHERE published_at IS NULL AND next_attempt_at <= ?
        ORDER BY occurred_at, id
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(toOutboxMessage);
  }

  async save(tx: Tx, message: OutboxMessage): Promise<void> {
    await emOf(tx).nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      {
        attempts: message.attempts,
        publishedAt: message.publishedAt ?? null,
        lastError: message.lastError ?? null,
        ...(message.nextAttemptAt ? { nextAttemptAt: message.nextAttemptAt } : {}),
      },
    );
  }

  async stats(tx: Tx, now: Date): Promise<OutboxStats> {
    const rows = await emOf(tx).execute<Array<{ pendingCount: number; oldest: number }>>(
      `SELECT COUNT(*)::int AS "pendingCount",
              COALESCE(EXTRACT(EPOCH FROM (?::timestamptz - MIN(occurred_at))), 0)::float8 AS oldest
         FROM outbox_messages WHERE published_at IS NULL`,
      [now],
    );
    const row = rows[0];
    return {
      pendingCount: row?.pendingCount ?? 0,
      oldestPendingAgeSeconds: Math.max(0, row?.oldest ?? 0),
    };
  }
}
