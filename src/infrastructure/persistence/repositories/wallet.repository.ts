import { LockMode } from '@mikro-orm/core';
import { ConcurrentModificationError } from '@/application/errors';
import type { ReconciliationSnapshot, WalletRepository } from '@/application/ports/repositories';
import type { Tx } from '@/application/ports/transaction';
import { Wallet } from '@/domain/wallet/wallet';
import { toWallet } from '../mappers';
import { WalletRecord } from '../schemas/records';
import { emOf } from '../unit-of-work';

interface SnapshotRow {
  currency: string;
  stored: string;
  calculated: string;
  entries: number;
  chainIntact: boolean;
}

export class MikroOrmWalletRepository implements WalletRepository {
  async exists(tx: Tx, walletId: string): Promise<boolean> {
    const rows = await emOf(tx).execute<unknown[]>('SELECT 1 FROM wallets WHERE id = ?', [
      walletId,
    ]);
    return rows.length > 0;
  }

  async findById(tx: Tx, walletId: string): Promise<Wallet | undefined> {
    const record = await emOf(tx).findOne(WalletRecord, { id: walletId });
    return record ? toWallet(record) : undefined;
  }

  /**
   * Pessimistic write lock on this wallet's row only (`SELECT ... FOR UPDATE`). Writers of the same
   * wallet queue here; writers of other wallets never notice. It must be the first load of the
   * wallet inside the unit of work, so the Identity Map cannot hand back a stale copy.
   */
  async findByIdForUpdate(tx: Tx, walletId: string): Promise<Wallet | undefined> {
    const record = await emOf(tx).findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record ? toWallet(record) : undefined;
  }

  async insertIfAbsent(tx: Tx, wallet: Wallet): Promise<boolean> {
    const rows = await emOf(tx).execute<unknown[]>(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (player_id, currency) DO NOTHING
       RETURNING id`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.amount,
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
    return rows.length > 0;
  }

  /** Compare-and-swap on `version`: defence in depth on top of the row lock. */
  async update(tx: Tx, wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await emOf(tx).nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrentModificationError('wallet', wallet.id);
    }
  }

  async reconciliationSnapshot(
    tx: Tx,
    walletId: string,
  ): Promise<ReconciliationSnapshot | undefined> {
    // One statement => one snapshot: the stored balance and the ledger total cannot be read at
    // different instants, even without locking the wallet.
    const rows = await emOf(tx).execute<SnapshotRow[]>(
      `SELECT w.currency AS currency,
              w.balance::text AS stored,
              COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS calculated,
              COUNT(l.id)::int AS entries,
              COALESCE(BOOL_AND(l.balance_before = COALESCE(l.prev_after, 0)), true) AS "chainIntact"
         FROM wallets w
         LEFT JOIN (
           SELECT wallet_id, id, direction, amount, balance_before,
                  LAG(balance_after) OVER (PARTITION BY wallet_id ORDER BY wallet_version) AS prev_after
             FROM wallet_ledger_entries
            WHERE wallet_id = ?
         ) l ON l.wallet_id = w.id
        WHERE w.id = ?
        GROUP BY w.id, w.currency, w.balance`,
      [walletId, walletId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      walletId,
      currency: row.currency,
      storedBalance: row.stored,
      calculatedBalance: row.calculated,
      checkedEntries: row.entries,
      chainIntact: row.chainIntact,
    };
  }
}
