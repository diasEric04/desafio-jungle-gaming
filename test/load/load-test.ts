/**
 * Load test: boots N real app processes against the running PostgreSQL/LocalStack, drives a mixed
 * workload over HTTP, then verifies the ledger invariant and writes `load-test-report.md`.
 *
 *   bun run test:load            (env: LOAD_INSTANCES, LOAD_WALLETS, LOAD_REQUESTS, LOAD_CONCURRENCY)
 */
import { Client } from 'pg';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { createSqsClient } from '@/infrastructure/messaging/sqs-client';
import { provisionQueues } from '@/infrastructure/messaging/queues';
import { assertConsistent, migrate, newId, waitFor } from '../support/db';
import { createWallet, startApp, submit } from '../support/app-process';
import { DATABASE_URL, testConfig, uniqueQueueNames } from '../support/env';

const INSTANCES = Number(process.env['LOAD_INSTANCES'] ?? 3);
const WALLETS = Number(process.env['LOAD_WALLETS'] ?? 200);
const REQUESTS = Number(process.env['LOAD_REQUESTS'] ?? 5000);
const CONCURRENCY = Number(process.env['LOAD_CONCURRENCY'] ?? 64);
const DUPLICATE_RATIO = 0.1;

const names = uniqueQueueNames('load');
const sqs = createSqsClient(testConfig(names).aws);
await migrate();
await provisionQueues(sqs, testConfig(names).queues, { redriveMaxReceiveCount: 10 });
const apps = await Promise.all(
  Array.from({ length: INSTANCES }, (_, i) =>
    startApp(`load-${i + 1}`, { ...names, LOG_LEVEL: 'error' }),
  ),
);
const pg = new Client({ connectionString: DATABASE_URL });
await pg.connect();

const wallets = await Promise.all(
  Array.from({ length: WALLETS }, async () => {
    const playerId = newId();
    return { playerId, walletId: (await createWallet(apps[0]!.url, playerId, '1000000.00')).id };
  }),
);

const latencies: number[] = [];
const statuses = new Map<number, number>();
let next = 0;
const startedAt = performance.now();

async function worker(): Promise<void> {
  for (;;) {
    const i = next++;
    if (i >= REQUESTS) return;
    const isDuplicate = i > 0 && Math.random() < DUPLICATE_RATIO;
    const n = isDuplicate ? i - 1 : i;
    const t0 = performance.now();
    try {
      const res = await submit(apps[i % apps.length]!.url, {
        ...wallets[n % wallets.length]!,
        kind: 'BET',
        amount: '1.00',
        externalTransactionId: `load-${n}`,
      });
      latencies.push(performance.now() - t0);
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    } catch {
      statuses.set(0, (statuses.get(0) ?? 0) + 1);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const elapsedS = (performance.now() - startedAt) / 1000;

const pct = (p: number) =>
  latencies.slice().sort((a, b) => a - b)[
    Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))
  ] ?? 0;
const errors = [...statuses].filter(([s]) => s === 0 || s >= 500).reduce((a, [, n]) => a + n, 0);

await waitFor(
  async () =>
    (await pg.query(`SELECT 1 FROM outbox_messages WHERE published_at IS NULL LIMIT 1`))
      .rowCount === 0,
  { what: 'outbox to drain', timeoutMs: 120_000 },
);
const lag = (
  await pg.query(
    `SELECT COALESCE(EXTRACT(EPOCH FROM MAX(published_at - created_at)),0)::float AS max_lag FROM outbox_messages`,
  )
).rows[0].max_lag as number;
await assertConsistent(
  pg,
  wallets.map((w) => w.walletId),
);

let lockConflicts = 'n/a';
try {
  const text = await (await fetch(`${apps[0]!.url}/metrics`)).text();
  lockConflicts =
    text
      .split('\n')
      .filter((l) => l.startsWith('wallet_lock_conflicts_total'))
      .join('; ') || '0';
} catch {
  /* metrics are best effort */
}

const report = `# Load test report

Generated: ${new Date().toISOString()}

## Environment
- CPU: ${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}, RAM ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB, ${os.platform()} ${os.release()}
- Bun ${Bun.version}; PostgreSQL + LocalStack on the same host (results are NOT representative of production)
- ${INSTANCES} app processes, ${WALLETS} wallets, ${REQUESTS} requests (~${DUPLICATE_RATIO * 100}% duplicates), ${CONCURRENCY} concurrent clients

## Methodology
Mixed BET workload over HTTP round-robin across instances; duplicates reuse a previous externalTransactionId. After the run: wait for the outbox to drain, then verify wallet.balance == balance rebuilt from the ledger for every wallet.

## Results
| Metric | Value |
| --- | --- |
| Throughput | ${(REQUESTS / elapsedS).toFixed(0)} req/s |
| p50 / p95 / p99 | ${pct(50).toFixed(1)} / ${pct(95).toFixed(1)} / ${pct(99).toFixed(1)} ms |
| Error rate (5xx + network) | ${((errors / REQUESTS) * 100).toFixed(2)} % |
| Status distribution | ${[...statuses].map(([s, n]) => `${s}: ${n}`).join(', ')} |
| Lock conflicts (instance 1) | ${lockConflicts} |
| Max outbox publish lag | ${lag.toFixed(2)} s |
| Ledger invariant | holds for all ${WALLETS} wallets |
`;
writeFileSync('load-test-report.md', report);
console.log(report);

await pg.end();
await Promise.all(
  apps.map(async (a) => {
    a.kill('SIGTERM');
    await Promise.race([a.exited, new Promise((r) => setTimeout(r, 8000))]);
    a.kill('SIGKILL');
  }),
);
sqs.destroy();
process.exit(0);
