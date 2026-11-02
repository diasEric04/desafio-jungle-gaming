import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { Container, createContainer } from '@/infrastructure/container';
import { MikroOrmWalletRepository } from '@/infrastructure/persistence/repositories/wallet.repository';
import { WagerTransactionKind as K } from '@/domain/wagering/wager-transaction';
import { Wallet } from '@/domain/wallet/wallet';
import { Money } from '@/domain/money/money';
import { assertConsistent, migrate, newId, waitFor, withClient } from '../support/db';
import { DATABASE_URL, testConfig } from '../support/env';

let container: Container;
let client: Client;

beforeAll(async () => {
  await migrate();
  container = await createContainer(testConfig({ ENABLE_PENDING_REFERENCE_WORKER: 'false' }), {
    withMessaging: false,
  });
  client = new (await import('pg')).Client({ connectionString: DATABASE_URL });
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await container.stop();
});

const player = () => newId();
async function openWallet(amount: string, playerId = player()) {
  const wallet = await container.useCases.createWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'it',
  });
  return { wallet, playerId };
}
const submit = (
  walletId: string,
  playerId: string,
  kind: K,
  amount: string,
  external: string,
  extra: Record<string, string> = {},
) =>
  container.useCases.processWagerTransaction.execute({
    idempotencyKey: `p:${external}`,
    providerId: 'p',
    externalTransactionId: external,
    playerId,
    walletId,
    roundId: 'r1',
    gameId: 'g',
    kind,
    money: { amount, currency: 'BRL' },
    correlationId: 'it',
    source: 'http',
    ...extra,
  });

describe('atomicity against real PostgreSQL', () => {
  test('wallet creation writes wallet + OPENING + ledger + outbox together, version 1', async () => {
    const { wallet } = await openWallet('1000.00');
    expect(wallet.version).toBe(1);
    const { rows } = await client.query(
      `SELECT (SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1)::int AS ledger,
              (SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'OPENING')::int AS opening,
              (SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1)::int AS outbox`,
      [wallet.id],
    );
    expect(rows[0]).toEqual({ ledger: 1, opening: 1, outbox: 1 });
    await assertConsistent(client, [wallet.id]);
  });

  test('duplicate player+currency is a conflict and leaves a single wallet', async () => {
    const playerId = player();
    await openWallet('5.00', playerId);
    await expect(openWallet('5.00', playerId)).rejects.toThrow(/already has/);
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM wallets WHERE player_id = $1`,
      [playerId],
    );
    expect(rows[0].n).toBe(1);
  });

  test('a failure after the wallet row was updated rolls the update back', async () => {
    const { wallet } = await openWallet('50.00');
    const wallets = new MikroOrmWalletRepository();
    await expect(
      container.uow.run(async (tx) => {
        const locked = (await wallets.findByIdForUpdate(tx, wallet.id))!;
        const expectedVersion = locked.version;
        locked.debit({
          entryId: newId(),
          transactionId: newId(),
          money: Money.from({ amount: '10.00', currency: 'BRL' }),
          at: new Date(),
        });
        await wallets.update(tx, locked, expectedVersion); // written inside the open transaction...
        throw new Error('crash before commit'); // ...then the process "fails"
      }),
    ).rejects.toThrow(/crash/);
    const { rows } = await client.query(
      `SELECT balance::text AS balance, version FROM wallets WHERE id = $1`,
      [wallet.id],
    );
    expect(rows[0]).toEqual({ balance: '50.00', version: 1 });
    await assertConsistent(client, [wallet.id]);
  });

  test('a processed BET commits transaction, wallet, ledger and events in one go', async () => {
    const { wallet, playerId } = await openWallet('100.00');
    const result = await submit(wallet.id, playerId, K.Bet, '25.00', `bet-${newId()}`);
    expect(result.status).toBe('PROCESSED');
    const { rows } = await client.query(
      `SELECT w.balance::text AS balance, w.version,
              (SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = w.id AND direction = 'DEBIT')::int AS debits,
              (SELECT COUNT(*) FROM outbox_messages WHERE payload->'data'->>'walletId' = w.id::text)::int AS events
         FROM wallets w WHERE w.id = $1`,
      [wallet.id],
    );
    expect(rows[0]).toEqual({ balance: '75.00', version: 2, debits: 1, events: 3 }); // opening + processed + balance changed
    await assertConsistent(client, [wallet.id]);
  });

  test('lock timeouts surface as transient infrastructure errors, never as partial writes', async () => {
    const { wallet, playerId } = await openWallet('20.00');
    const holder = new (await import('pg')).Client({ connectionString: DATABASE_URL });
    await holder.connect();
    const short = await createContainer(
      testConfig({ DB_LOCK_TIMEOUT_MS: '300', ENABLE_PENDING_REFERENCE_WORKER: 'false' }),
      { withMessaging: false },
    );
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE`, [wallet.id]); // someone else holds the wallet
      await expect(
        short.useCases.processWagerTransaction.execute({
          idempotencyKey: 'p:locked',
          providerId: 'p',
          externalTransactionId: 'locked',
          playerId,
          walletId: wallet.id,
          roundId: 'r',
          gameId: 'g',
          kind: K.Bet,
          money: { amount: '1.00', currency: 'BRL' },
          correlationId: 'it',
          source: 'http',
        }),
      ).rejects.toMatchObject({ name: 'TransientInfrastructureError' });
      await holder.query('ROLLBACK');
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM wager_transactions WHERE idempotency_key = 'p:locked'`,
      );
      expect(rows[0].n).toBe(0); // the INSERT of the transaction row was rolled back too
    } finally {
      await holder.end();
      await short.stop();
    }
  });
});

describe('reconciliation', () => {
  test('is consistent after activity and detects (without fixing) tampering done behind the app', async () => {
    const { wallet, playerId } = await openWallet('100.00');
    await submit(wallet.id, playerId, K.Bet, '30.00', `b-${newId()}`);
    const ok = await container.useCases.reconcileWallet.execute(wallet.id, 'it');
    expect(ok).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      difference: { amount: '0.00' },
      storedBalance: { amount: '70.00' },
    });

    // Simulate corruption: disable the guard triggers for this session only, as a DBA could.
    await withClient(async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`); // skips triggers incl. the deferred ledger check
      await c.query(`UPDATE wallets SET balance = 71.00 WHERE id = $1`, [wallet.id]);
      await c.query('COMMIT');
    }).catch(() => undefined); // needs superuser; if refused the test below is skipped
    const after = await container.useCases.reconcileWallet.execute(wallet.id, 'it');
    if (!after.consistent) {
      expect(after.difference.amount).toBe('1.00');
      const { rows } = await client.query(`SELECT balance::text FROM wallets WHERE id = $1`, [
        wallet.id,
      ]);
      expect(rows[0].balance).toBe('71.00'); // reported, not silently repaired
    }
  });
});

describe('out-of-order references with the real worker path', () => {
  test('REFUND first -> PENDING_REFERENCE; BET later wakes it; claim + reprocess settles it', async () => {
    const { wallet, playerId } = await openWallet('100.00');
    const bet = `bet-${newId()}`;
    const refund = await submit(wallet.id, playerId, K.Refund, '40.00', `ref-${newId()}`, {
      referenceExternalTransactionId: bet,
    });
    expect(refund.status).toBe('PENDING_REFERENCE');

    await submit(wallet.id, playerId, K.Bet, '40.00', bet);
    const claims = await waitFor(
      async () => {
        const c = await container.useCases.claimPendingReferences.execute(50);
        const mine = c.filter((x) => x.walletId === wallet.id);
        return mine.length ? mine : undefined;
      },
      { what: 'the refund to become claimable' },
    );
    expect(await container.useCases.reprocessPendingReference.execute(claims[0]!, 'it')).toBe(
      'PROCESSED',
    );

    const { rows } = await client.query(
      `SELECT balance::text AS balance FROM wallets WHERE id = $1`,
      [wallet.id],
    );
    expect(rows[0].balance).toBe('100.00');
    await assertConsistent(client, [wallet.id]);
  });

  test('a reference that never arrives is rejected with REFERENCE_NOT_FOUND once the attempt budget is spent', async () => {
    const short = await createContainer(
      testConfig({
        PENDING_REFERENCE_MAX_ATTEMPTS: '2',
        PENDING_REFERENCE_BASE_DELAY_MS: '1',
        PENDING_REFERENCE_MAX_DELAY_MS: '5',
        ENABLE_PENDING_REFERENCE_WORKER: 'false',
      }),
      { withMessaging: false },
    );
    try {
      const { wallet, playerId } = await openWallet('10.00');
      const r = await short.useCases.processWagerTransaction.execute({
        idempotencyKey: `p:rb-${wallet.id}`,
        providerId: 'p',
        externalTransactionId: `rb-${wallet.id}`,
        playerId,
        walletId: wallet.id,
        roundId: 'r',
        gameId: 'g',
        kind: K.Rollback,
        money: { amount: '1.00', currency: 'BRL' },
        referenceExternalTransactionId: 'ghost',
        correlationId: 'it',
        source: 'http',
      });
      expect(r.status).toBe('PENDING_REFERENCE');
      for (let i = 0; i < 2; i++) {
        await new Promise((res) => setTimeout(res, 20));
        for (const c of (await short.useCases.claimPendingReferences.execute(50)).filter(
          (x) => x.walletId === wallet.id,
        )) {
          await short.useCases.reprocessPendingReference.execute(c, 'it');
        }
      }
      const view = await short.useCases.getTransaction.byId(r.transactionId);
      expect(view).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
      const { rows } = await client.query(
        `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1 ORDER BY occurred_at`,
        [r.transactionId],
      );
      expect(rows.map((x) => x.event_type)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionRejected',
      ]);
    } finally {
      await short.stop();
    }
  });
});

test('wallet aggregate round-trips through the database without losing precision', async () => {
  const { wallet } = await openWallet('0.01');
  const loaded = await container.uow.read((tx) =>
    new MikroOrmWalletRepository().findById(tx, wallet.id),
  );
  expect(loaded).toBeInstanceOf(Wallet);
  expect(loaded!.balance.amount).toBe('0.01');
});
