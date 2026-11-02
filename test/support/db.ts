import { Client } from 'pg';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '@/infrastructure/persistence/mikro-orm.config';
import { uuidv7 } from '@/shared/system';
import { DATABASE_URL } from './env';

/** Applies pending migrations (idempotent). */
export async function migrate(url: string = DATABASE_URL): Promise<void> {
  const orm = await MikroORM.init(createOrmConfig({ url, poolMin: 1, poolMax: 2 }));
  try {
    await orm.migrator.up();
  } finally {
    await orm.close(true);
  }
}

export async function withClient<T>(
  work: (client: Client) => Promise<T>,
  url: string = DATABASE_URL,
): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export const newId = () => uuidv7();

export interface WalletTruth {
  walletId: string;
  balance: string;
  ledgerBalance: string;
  entries: number;
  chainIntact: boolean;
}

/** The invariant behind every test: wallet.balance == balance rebuilt from the ledger. */
export async function walletTruth(client: Client, walletId: string): Promise<WalletTruth> {
  const { rows } = await client.query(
    `SELECT w.balance::text AS balance,
            COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS "ledgerBalance",
            COUNT(l.id)::int AS entries,
            COALESCE(BOOL_AND(l.balance_before = COALESCE(l.prev_after, 0)), true) AS "chainIntact"
       FROM wallets w
       LEFT JOIN (SELECT wallet_id, id, direction, amount, balance_before,
                         LAG(balance_after) OVER (PARTITION BY wallet_id ORDER BY wallet_version) AS prev_after
                    FROM wallet_ledger_entries WHERE wallet_id = $1) l ON l.wallet_id = w.id
      WHERE w.id = $1 GROUP BY w.id, w.balance`,
    [walletId],
  );
  return { walletId, ...rows[0] };
}

export async function assertConsistent(client: Client, walletIds: string[]): Promise<void> {
  for (const walletId of walletIds) {
    const truth = await walletTruth(client, walletId);
    if (truth.balance !== truth.ledgerBalance || !truth.chainIntact) {
      throw new Error(`wallet ${walletId} inconsistent: ${JSON.stringify(truth)}`);
    }
  }
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  { timeoutMs = 20_000, intervalMs = 150, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
