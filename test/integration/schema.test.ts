import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { migrate, newId, withClient } from '../support/db';
import { DATABASE_URL } from '../support/env';

const hash = 'a'.repeat(64);
const now = new Date();

let client: Client;
beforeAll(async () => {
  await migrate();
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
});
afterAll(async () => client.end());

async function expectSqlState(promise: Promise<unknown>, state: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string }).code).toBe(state);
    return;
  }
  throw new Error(`expected SQLSTATE ${state} but the statement succeeded`);
}

async function wallet(balance = '0.00'): Promise<{ id: string; player: string }> {
  const id = newId();
  const player = newId();
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES ($1,$2,'BRL',$3,1,$4,$4)`,
    [id, player, balance, now],
  );
  if (Number(balance) > 0) {
    const tx = newId();
    await insertTx(tx, id, player, {
      kind: 'OPENING',
      provider: 'internal',
      external: `opening:${id}`,
      amount: balance,
    });
    await client.query(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
       VALUES ($1,$2,$3,'CREDIT',$4,'BRL',0,$4,1,$5)`,
      [newId(), id, tx, balance, now],
    );
  }
  await client.query('COMMIT');
  return { id, player };
}

async function insertTx(
  id: string,
  walletId: string,
  player: string,
  o: {
    kind?: string;
    provider?: string;
    external?: string;
    key?: string;
    amount?: string;
    status?: string;
    reference?: string | null;
    refId?: string | null;
  } = {},
) {
  const status = o.status ?? 'PROCESSED';
  await client.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code,
       observed_balance, next_attempt_at, created_at, updated_at, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'r','g',$8,$9,'BRL',$10,$11,$12,$13,0,$14,$15,$15,$16)`,
    [
      id,
      o.provider ?? 'p1',
      o.external ?? id,
      o.key ?? `${o.provider ?? 'p1'}:${o.external ?? id}`,
      hash,
      walletId,
      player,
      o.kind ?? 'BET',
      o.amount ?? '1.00',
      o.reference ?? null,
      o.refId ?? null,
      status,
      status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : null,
      status === 'PENDING_REFERENCE' ? now : null,
      now,
      status === 'PROCESSED' ? now : null,
    ],
  );
}

describe('schema guarantees (enforced by PostgreSQL, not by application code)', () => {
  test('migrations are reversible: up -> down(all) -> up on a scratch database', async () => {
    const name = `wagering_mig_${Date.now().toString(36)}`;
    await withClient((c) => c.query(`CREATE DATABASE ${name}`));
    const url = DATABASE_URL.replace(/\/[^/?]+(\?.*)?$/, `/${name}$1`);
    try {
      const { MikroORM } = await import('@mikro-orm/postgresql');
      const { createOrmConfig } = await import('@/infrastructure/persistence/mikro-orm.config');
      const orm = await MikroORM.init(createOrmConfig({ url, poolMin: 1, poolMax: 2 }));
      const tables = async () =>
        withClient(
          async (c) =>
            (
              await c.query(
                `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'mikro_orm_migrations' ORDER BY 1`,
              )
            ).rows.map((r) => r.tablename),
          url,
        );
      await orm.migrator.up();
      expect(await tables()).toEqual([
        'inbox_messages',
        'outbox_messages',
        'wager_transactions',
        'wallet_ledger_entries',
        'wallets',
      ]);
      await orm.migrator.down({ to: 0 });
      expect(await tables()).toEqual([]);
      await orm.migrator.up();
      expect((await tables()).length).toBe(5);
      await orm.close(true);
    } finally {
      await withClient((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    }
  });

  test('balance can never be negative', async () => {
    const w = await wallet('10.00');
    await expectSqlState(
      client.query(`UPDATE wallets SET balance = -1, version = version + 1 WHERE id = $1`, [w.id]),
      '23514',
    );
  });

  test('one wallet per (player, currency)', async () => {
    const w = await wallet();
    await expectSqlState(
      client.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES ($1,$2,'BRL',0,1,$3,$3)`,
        [newId(), w.player, now],
      ),
      '23505',
    );
  });

  test('ledger is append-only: UPDATE, DELETE and TRUNCATE are refused', async () => {
    const w = await wallet('10.00');
    await expectSqlState(
      client.query(`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = $1`, [w.id]),
      '23000',
    );
    await expectSqlState(
      client.query(`DELETE FROM wallet_ledger_entries WHERE wallet_id = $1`, [w.id]),
      '23000',
    );
    await expectSqlState(client.query(`TRUNCATE wallet_ledger_entries`), '23000');
  });

  test('ledger rows must be arithmetically valid and unique per wallet version / transaction', async () => {
    const w = await wallet('10.00');
    const tx = newId();
    await client.query('BEGIN');
    await insertTx(tx, w.id, w.player, { amount: '3.00' });
    await expectSqlState(
      client.query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
         VALUES ($1,$2,$3,'DEBIT',3,'BRL',10,8,2,$4)`,
        [newId(), w.id, tx, now],
      ),
      '23514',
    );
    await client.query('ROLLBACK');
    const tx2 = newId();
    await client.query('BEGIN');
    await insertTx(tx2, w.id, w.player, { amount: '3.00' });
    await expectSqlState(
      client.query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
         VALUES ($1,$2,$3,'DEBIT',3,'BRL',10,7,1,$4)`,
        [newId(), w.id, tx2, now],
      ),
      '23505', // wallet_version 1 already taken by the opening entry
    );
    await client.query('ROLLBACK');
  });

  test('idempotency key and (provider, external id) are unique', async () => {
    const w = await wallet('10.00');
    await insertTx(newId(), w.id, w.player, { external: 'e1', key: 'k1' });
    await expectSqlState(insertTx(newId(), w.id, w.player, { external: 'e2', key: 'k1' }), '23505');
    await expectSqlState(insertTx(newId(), w.id, w.player, { external: 'e1', key: 'k2' }), '23505');
  });

  test('terminal transactions and business columns are immutable', async () => {
    const w = await wallet('10.00');
    const done = newId();
    await insertTx(done, w.id, w.player);
    await expectSqlState(
      client.query(
        `UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = $1`,
        [done],
      ),
      '23000',
    );
    await expectSqlState(
      client.query(`DELETE FROM wager_transactions WHERE id = $1`, [done]),
      '23000',
    );
    const open = newId();
    await insertTx(open, w.id, w.player, {
      status: 'PENDING_REFERENCE',
      kind: 'REFUND',
      reference: 'nope',
      external: 'pend-1',
    });
    await expectSqlState(
      client.query(`UPDATE wager_transactions SET amount = 99 WHERE id = $1`, [open]),
      '23000',
    );
    await expectSqlState(
      client.query(`UPDATE wager_transactions SET status = 'PENDING' WHERE id = $1`, [open]),
      '23000',
    );
  });

  test('a reference can be reversed by at most one processed reversal', async () => {
    const w = await wallet('10.00');
    const bet = newId();
    await insertTx(bet, w.id, w.player, { external: 'bet-1' });
    await insertTx(newId(), w.id, w.player, {
      kind: 'REFUND',
      external: 'r1',
      reference: 'bet-1',
      refId: bet,
    });
    await expectSqlState(
      insertTx(newId(), w.id, w.player, {
        kind: 'ROLLBACK',
        external: 'r2',
        reference: 'bet-1',
        refId: bet,
      }),
      '23505',
    );
  });

  test('only OPENING may use the internal provider; reversals need a reference; BET cannot have one', async () => {
    const w = await wallet();
    await expectSqlState(
      insertTx(newId(), w.id, w.player, { provider: 'internal', kind: 'BET' }),
      '23514',
    );
    await expectSqlState(
      insertTx(newId(), w.id, w.player, { kind: 'OPENING', provider: 'p1' }),
      '23514',
    );
    await expectSqlState(insertTx(newId(), w.id, w.player, { kind: 'REFUND' }), '23514');
    await expectSqlState(
      insertTx(newId(), w.id, w.player, { kind: 'BET', reference: 'x' }),
      '23514',
    );
  });

  test('balance cannot change without a matching ledger entry (checked at COMMIT)', async () => {
    const w = await wallet('10.00');
    await client.query('BEGIN');
    await client.query(`UPDATE wallets SET balance = 5, version = version + 1 WHERE id = $1`, [
      w.id,
    ]);
    await expectSqlState(client.query('COMMIT'), '23000');
    await client.query('ROLLBACK').catch(() => undefined);
    const { rows } = await client.query(`SELECT balance::text FROM wallets WHERE id = $1`, [w.id]);
    expect(rows[0].balance).toBe('10.00');
  });

  test('wallet version rule: bumps exactly when the balance changes', async () => {
    const w = await wallet('10.00');
    await expectSqlState(
      client.query(`UPDATE wallets SET version = version + 1 WHERE id = $1`, [w.id]),
      '23000',
    );
    await expectSqlState(
      client.query(`UPDATE wallets SET balance = 9 WHERE id = $1`, [w.id]),
      '23000',
    );
    await expectSqlState(
      client.query(`UPDATE wallets SET currency = 'USD' WHERE id = $1`, [w.id]),
      '23000',
    );
  });

  test('published outbox events and their payloads are immutable', async () => {
    const id = newId();
    await client.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES ($1,$2,'T','{"a":1}',$3,0,$3)`,
      [id, newId(), now],
    );
    await expectSqlState(
      client.query(`UPDATE outbox_messages SET payload = '{"a":2}' WHERE id = $1`, [id]),
      '23000',
    );
    await client.query(`UPDATE outbox_messages SET published_at = $2, attempts = 1 WHERE id = $1`, [
      id,
      now,
    ]);
    await expectSqlState(
      client.query(`UPDATE outbox_messages SET attempts = 2 WHERE id = $1`, [id]),
      '23000',
    );
  });
});
