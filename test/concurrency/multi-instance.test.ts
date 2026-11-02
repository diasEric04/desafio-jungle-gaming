import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { createSqsClient } from '@/infrastructure/messaging/sqs-client';
import { provisionQueues } from '@/infrastructure/messaging/queues';
import { assertConsistent, migrate, newId, waitFor, walletTruth } from '../support/db';
import { AppInstance, createWallet, http, startApp, submit } from '../support/app-process';
import { DATABASE_URL, testConfig, uniqueQueueNames } from '../support/env';

/**
 * Real parallelism: three separate OS processes (`bun src/main.ts`) share one PostgreSQL and one set
 * of SQS queues, and the test fires requests at all of them at once. No mocks anywhere.
 * Final invariant in every test: wallet.balance == balance rebuilt from the ledger.
 */
const names = uniqueQueueNames('cc');
const baseEnv = { ...names };
let instances: AppInstance[] = [];
let pg: Client;
const sqsClient = createSqsClient(testConfig(names).aws);

const pick = (i: number) => instances[i % instances.length]!.url;

beforeAll(async () => {
  await migrate();
  await provisionQueues(sqsClient, testConfig(names).queues, {
    redriveMaxReceiveCount: 10,
    visibilityTimeoutSeconds: 3,
  });
  instances = await Promise.all([1, 2, 3].map((n) => startApp(`app-${n}`, baseEnv)));
  pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
}, 120_000);

afterAll(async () => {
  await pg.end();
  await Promise.all(
    instances.map(async (i) => {
      i.kill('SIGTERM');
      await Promise.race([i.exited, new Promise((r) => setTimeout(r, 8_000))]);
      i.kill('SIGKILL');
    }),
  );
  sqsClient.destroy();
});

async function newWallet(amount: string) {
  const playerId = newId();
  const wallet = await createWallet(pick(0), playerId, amount);
  return { walletId: wallet.id, playerId };
}

describe('idempotency under parallelism', () => {
  test('the same BET sent 50 times in parallel to 3 instances debits exactly once', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        submit(pick(i), {
          walletId,
          playerId,
          kind: 'BET',
          amount: '40.00',
          externalTransactionId: 'same-bet',
        }),
      ),
    );
    const fresh = responses.filter((r) => !r.body.idempotentReplay);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.status).toBe(201);
    expect(
      responses
        .filter((r) => r.body.idempotentReplay)
        .every((r) => r.status === 200 && r.body.status === 'PROCESSED'),
    ).toBe(true);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(new Set(responses.map((r) => r.body.balance?.amount))).toEqual(new Set(['60.00'])); // every copy sees the ORIGINAL balance

    const truth = await walletTruth(pg, walletId);
    expect(truth).toMatchObject({ balance: '60.00', ledgerBalance: '60.00', entries: 2 }); // opening + ONE debit
    const events = await pg.query(
      `SELECT COUNT(*)::int AS n FROM outbox_messages WHERE payload->'data'->>'transactionId' IS NOT NULL AND payload->'data'->>'walletId' = $1 AND event_type = 'WagerTransactionProcessed'`,
      [walletId],
    );
    expect(events.rows[0].n).toBe(1);
  });

  test('same key with a different payload is a 409 conflict, even in parallel', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const key = `conflict-${newId()}`;
    const responses = await Promise.all(
      ['10.00', '11.00', '12.00', '13.00'].map((amount, i) =>
        submit(pick(i), {
          walletId,
          playerId,
          kind: 'BET',
          amount,
          externalTransactionId: 'conflicting',
          idempotencyKey: key,
        }),
      ),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(3);
    expect(
      (responses.find((r) => r.status === 409)!.body as unknown as { error: { code: string } })
        .error.code,
    ).toBe('IDEMPOTENCY_CONFLICT');
    await assertConsistent(pg, [walletId]);
  });
});

describe('contention on the balance', () => {
  test('two 80.00 bets on a 100.00 wallet: exactly one PROCESSED, one REJECTED, balance 20.00, one debit', async () => {
    for (let round = 0; round < 5; round++) {
      const { walletId, playerId } = await newWallet('100.00');
      const [a, b] = await Promise.all([
        submit(pick(0), {
          walletId,
          playerId,
          kind: 'BET',
          amount: '80.00',
          externalTransactionId: 'a',
        }),
        submit(pick(1), {
          walletId,
          playerId,
          kind: 'BET',
          amount: '80.00',
          externalTransactionId: 'b',
        }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 422]);
      const rejected = a.status === 422 ? a : b;
      expect(rejected.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        retryAdvice: expect.any(String),
      });
      const truth = await walletTruth(pg, walletId);
      expect(truth).toMatchObject({ balance: '20.00', entries: 2 });
      const debits = await pg.query(
        `SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
        [walletId],
      );
      expect(debits.rows[0].n).toBe(1);
      await assertConsistent(pg, [walletId]);
    }
  });

  test('hot wallet: 150 concurrent 1.00 bets on 60.00 -> exactly 60 processed, 90 rejected, balance 0.00, never negative', async () => {
    const { walletId, playerId } = await newWallet('60.00');
    const responses = await Promise.all(
      Array.from({ length: 150 }, (_, i) =>
        submit(pick(i), {
          walletId,
          playerId,
          kind: 'BET',
          amount: '1.00',
          externalTransactionId: `hot-${i}`,
        }),
      ),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(60);
    expect(responses.filter((r) => r.status === 422)).toHaveLength(90);
    expect(responses.filter((r) => ![201, 422].includes(r.status))).toHaveLength(0);
    const truth = await walletTruth(pg, walletId);
    expect(truth).toMatchObject({ balance: '0.00', entries: 61, chainIntact: true });
    const versions = await pg.query(
      `SELECT wallet_version FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY wallet_version`,
      [walletId],
    );
    expect(versions.rows.map((r) => r.wallet_version)).toEqual(
      Array.from({ length: 61 }, (_, i) => i + 1),
    ); // no gaps, no duplicates
  });

  test('different wallets progress in parallel and every one stays consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 25 }, () => newWallet('50.00')));
    const calls = wallets.flatMap((w, wi) =>
      Array.from({ length: 8 }, (_, i) =>
        submit(pick(wi + i), {
          ...w,
          kind: i % 4 === 3 ? 'WIN' : 'BET',
          amount: '5.00',
          externalTransactionId: `p-${wi}-${i}`,
        }),
      ),
    );
    const responses = await Promise.all(calls);
    expect(responses.every((r) => r.status === 201)).toBe(true);
    await assertConsistent(
      pg,
      wallets.map((w) => w.walletId),
    );
    for (const w of wallets) {
      // 6 bets (-30.00) and 2 wins (+10.00) from 50.00, whatever the interleaving
      expect(await walletTruth(pg, w.walletId)).toMatchObject({ balance: '30.00', entries: 9 });
    }
  });
});

describe('out-of-order delivery', () => {
  test('REFUND and ROLLBACK that arrive before their references wait, then apply exactly once', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const refund = await submit(pick(0), {
      walletId,
      playerId,
      kind: 'REFUND',
      amount: '30.00',
      externalTransactionId: 'ref-1',
      referenceExternalTransactionId: 'bet-1',
    });
    const rollback = await submit(pick(1), {
      walletId,
      playerId,
      kind: 'ROLLBACK',
      amount: '20.00',
      externalTransactionId: 'rb-1',
      referenceExternalTransactionId: 'bet-2',
    });
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe('PENDING_REFERENCE');
    expect(rollback.status).toBe(202);

    await submit(pick(2), {
      walletId,
      playerId,
      kind: 'BET',
      amount: '30.00',
      externalTransactionId: 'bet-1',
    });
    await submit(pick(0), {
      walletId,
      playerId,
      kind: 'BET',
      amount: '20.00',
      externalTransactionId: 'bet-2',
    });

    for (const txId of [refund.body.transactionId, rollback.body.transactionId]) {
      await waitFor(
        async () =>
          (await http<{ status: string }>(pick(1), 'GET', `/wagering/transactions/${txId}`)).body
            .status === 'PROCESSED',
        { what: `${txId} to be applied`, timeoutMs: 30_000 },
      );
    }
    expect(await walletTruth(pg, walletId)).toMatchObject({
      balance: '100.00',
      entries: 5,
      chainIntact: true,
    });
    const replay = await submit(pick(2), {
      walletId,
      playerId,
      kind: 'REFUND',
      amount: '30.00',
      externalTransactionId: 'ref-1',
      referenceExternalTransactionId: 'bet-1',
    });
    expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
  });

  test('concurrent REFUND + ROLLBACK of the same BET never credit twice', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    await submit(pick(0), {
      walletId,
      playerId,
      kind: 'BET',
      amount: '25.00',
      externalTransactionId: 'bet-x',
    });
    const results = await Promise.all([
      submit(pick(0), {
        walletId,
        playerId,
        kind: 'REFUND',
        amount: '25.00',
        externalTransactionId: 'rf',
        referenceExternalTransactionId: 'bet-x',
      }),
      submit(pick(1), {
        walletId,
        playerId,
        kind: 'ROLLBACK',
        amount: '25.00',
        externalTransactionId: 'rb',
        referenceExternalTransactionId: 'bet-x',
      }),
      submit(pick(2), {
        walletId,
        playerId,
        kind: 'REFUND',
        amount: '25.00',
        externalTransactionId: 'rf2',
        referenceExternalTransactionId: 'bet-x',
      }),
    ]);
    expect(results.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.body.failureCode === 'ALREADY_REVERSED')).toHaveLength(2);
    expect(await walletTruth(pg, walletId)).toMatchObject({ balance: '100.00' });
  });
});

describe('API contract', () => {
  test('status codes distinguish invalid payload, conflict, rejection and pending', async () => {
    const { walletId, playerId } = await newWallet('10.00');
    const base = pick(0);
    expect(
      (
        await http(
          base,
          'POST',
          '/wagering/transactions',
          { nope: true },
          { 'idempotency-key': 'k' },
        )
      ).status,
    ).toBe(400);
    expect((await http(base, 'POST', '/wagering/transactions', {})).status).toBe(400); // missing Idempotency-Key
    expect(
      (
        await submit(base, {
          walletId,
          playerId,
          kind: 'BET',
          amount: '1.234',
          externalTransactionId: 'bad-money',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await submit(base, {
          walletId: newId(),
          playerId,
          kind: 'BET',
          amount: '1.00',
          externalTransactionId: 'ghost-wallet',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await submit(base, {
          walletId,
          playerId,
          kind: 'BET',
          amount: '99.00',
          externalTransactionId: 'broke',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await http(
          base,
          'POST',
          '/wagering/transactions',
          { providerId: 'p', kind: 'OPENING' },
          { 'idempotency-key': 'k' },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await http(base, 'POST', '/wallets', {
          playerId,
          initialBalance: { amount: '1.00', currency: 'BRL' },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await http(base, 'POST', '/wallets', {
          playerId,
          initialBalance: { amount: '1.00', currency: 'BRL' },
        })
      ).status,
    ).toBe(409);
  });

  test('ledger pagination uses a stable opaque cursor; reconciliation and health respond', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    for (let i = 0; i < 5; i++)
      await submit(pick(i), {
        walletId,
        playerId,
        kind: 'BET',
        amount: '1.00',
        externalTransactionId: `l-${i}`,
      });
    type Page = { items: { walletVersion: number }[]; nextCursor: string | null };
    const first = await http<Page>(pick(0), 'GET', `/wallets/${walletId}/ledger?limit=4`);
    expect(first.body.items.map((i) => i.walletVersion)).toEqual([1, 2, 3, 4]);
    expect(first.body.nextCursor).toBeString();
    const second = await http<Page>(
      pick(1),
      'GET',
      `/wallets/${walletId}/ledger?limit=4&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items.map((i) => i.walletVersion)).toEqual([5, 6]);
    expect(second.body.nextCursor).toBeNull();
    expect((await http(pick(0), 'GET', `/wallets/${walletId}/ledger?cursor=garbage`)).status).toBe(
      400,
    );

    const rec = await http<Record<string, unknown>>(
      pick(2),
      'POST',
      `/wallets/${walletId}/reconciliation`,
    );
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({
      consistent: true,
      checkedEntries: 6,
      storedBalance: { amount: '95.00' },
      calculatedBalance: { amount: '95.00' },
      difference: { amount: '0.00' },
    });

    expect((await http(pick(0), 'GET', '/health/live')).status).toBe(200);
    expect((await http(pick(0), 'GET', '/health/ready')).status).toBe(200);
    const metrics = await (await fetch(`${pick(0)}/metrics`)).text();
    for (const name of [
      'wager_transactions_total',
      'wager_duplicates_total',
      'wallet_lock_wait_seconds',
      'outbox_lag_seconds',
      'dlq_messages_total',
      'retries_total',
      'wallet_lock_conflicts_total',
      'wager_processing_duration_seconds',
    ]) {
      expect(metrics).toContain(name);
    }
  });
});

describe('crash recovery', () => {
  test('worker killed AFTER commit and BEFORE ack: the redelivered message does not debit twice', async () => {
    const crashNames = uniqueQueueNames('crash');
    const cfg = testConfig(crashNames);
    const crashUrls = await provisionQueues(sqsClient, cfg.queues, {
      redriveMaxReceiveCount: 10,
      visibilityTimeoutSeconds: 3,
    });
    const { walletId, playerId } = await newWallet('100.00');
    const { SqsWagerProducer } = await import('@/infrastructure/messaging/sqs-wager-producer');
    const producer = new SqsWagerProducer(sqsClient, crashUrls.wager);

    const doomed = await startApp('doomed', {
      ...crashNames,
      FAULT_EXIT_BEFORE_ACK: 'true',
      ENABLE_OUTBOX_PUBLISHER: 'false',
      ENABLE_PENDING_REFERENCE_WORKER: 'false',
    });
    const sent = await producer.send({
      providerId: 'provider-a',
      externalTransactionId: 'crash-bet',
      playerId,
      walletId,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });
    const code = await Promise.race([
      doomed.exited,
      new Promise<number>((_, rej) =>
        setTimeout(() => rej(new Error('worker never crashed')), 30_000),
      ),
    ]);
    expect(code).not.toBe(0); // killed by SIGKILL, no graceful path

    // The effect is committed even though the message was never acked...
    expect((await walletTruth(pg, walletId)).balance).toBe('70.00');
    expect(
      (
        await pg.query(`SELECT COUNT(*)::int AS n FROM inbox_messages WHERE message_id = $1`, [
          sent.messageId,
        ])
      ).rows[0].n,
    ).toBe(1);

    // ...and a healthy worker takes the redelivery (after the visibility timeout) and just acks it.
    const survivor = await startApp('survivor', {
      ...crashNames,
      ENABLE_OUTBOX_PUBLISHER: 'false',
      ENABLE_PENDING_REFERENCE_WORKER: 'false',
    });
    try {
      await waitFor(
        async () => {
          const { GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs');
          const out = await sqsClient.send(
            new GetQueueAttributesCommand({
              QueueUrl: crashUrls.wager,
              AttributeNames: [
                'ApproximateNumberOfMessages',
                'ApproximateNumberOfMessagesNotVisible',
              ],
            }),
          );
          return (
            Number(out.Attributes?.['ApproximateNumberOfMessages']) +
              Number(out.Attributes?.['ApproximateNumberOfMessagesNotVisible']) ===
            0
          );
        },
        { what: 'redelivered message to be acked', timeoutMs: 40_000 },
      );
      expect(await walletTruth(pg, walletId)).toMatchObject({ balance: '70.00', entries: 2 });
    } finally {
      survivor.kill('SIGTERM');
      await survivor.exited;
    }
  });

  test('publisher killed after the broker accepted events but before COMMIT: another instance finishes the job', async () => {
    const pubNames = uniqueQueueNames('pub');
    await provisionQueues(sqsClient, testConfig(pubNames).queues, { redriveMaxReceiveCount: 10 });
    // The outbox table is shared by every instance, so the doomed publisher RACES the three shared
    // instances for these rows: it may or may not be the one that crashes. Either way the invariant
    // under test holds: no event stays unpublished and no state is lost.
    const { walletId, playerId } = await newWallet('100.00');
    await submit(pick(0), {
      walletId,
      playerId,
      kind: 'BET',
      amount: '10.00',
      externalTransactionId: 'pub-crash',
    });

    const doomed = await startApp(
      'doomed-publisher',
      {
        ...pubNames,
        FAULT_EXIT_AFTER_PUBLISH: 'true',
        ENABLE_QUEUE_CONSUMER: 'false',
        ENABLE_PENDING_REFERENCE_WORKER: 'false',
      },
      { waitReady: false },
    );
    await Promise.race([doomed.exited, new Promise((r) => setTimeout(r, 10_000))]);
    doomed.kill('SIGKILL');

    const survivor = await startApp('publisher-2', {
      ...pubNames,
      ENABLE_QUEUE_CONSUMER: 'false',
      ENABLE_PENDING_REFERENCE_WORKER: 'false',
    });
    try {
      await waitFor(
        async () =>
          (
            await pg.query(
              `SELECT 1 FROM outbox_messages WHERE published_at IS NULL AND payload->'data'->>'walletId' = $1`,
              [walletId],
            )
          ).rowCount === 0,
        { what: 'all events of the wallet to be published', timeoutMs: 40_000 },
      );
    } finally {
      survivor.kill('SIGTERM');
      await survivor.exited;
    }
    await assertConsistent(pg, [walletId]);
  });

  test('instance killed (SIGKILL) in the middle of a load: after restart every acknowledged bet is in the ledger exactly once', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet('500.00')));
    const victim = await startApp('victim', baseEnv);
    const targets = [instances[0]!.url, instances[1]!.url, victim.url];
    const acknowledged = new Map<string, number>();
    let sent = 0;

    const work = Promise.all(
      Array.from({ length: 300 }, async (_, i) => {
        const w = wallets[i % wallets.length]!;
        const target = targets[i % targets.length]!;
        if (i === 100) victim.kill('SIGKILL');
        try {
          const res = await submit(target, {
            ...w,
            kind: 'BET',
            amount: '1.00',
            externalTransactionId: `k-${i}`,
          });
          sent += 1;
          if (res.status === 201)
            acknowledged.set(w.walletId, (acknowledged.get(w.walletId) ?? 0) + 1);
        } catch {
          /* connection to the killed instance: outcome unknown, will be resolved by retrying below */
        }
      }),
    );
    await work;
    expect(sent).toBeGreaterThan(0);

    // A provider would re-send what it did not see acknowledged, with the SAME keys.
    const restarted = await startApp('victim-restarted', baseEnv);
    try {
      await Promise.all(
        Array.from({ length: 300 }, (_, i) => {
          const w = wallets[i % wallets.length]!;
          return submit(restarted.url, {
            ...w,
            kind: 'BET',
            amount: '1.00',
            externalTransactionId: `k-${i}`,
          });
        }),
      );
    } finally {
      restarted.kill('SIGTERM');
      await restarted.exited;
    }
    for (const w of wallets) {
      const truth = await walletTruth(pg, w.walletId);
      expect(truth).toMatchObject({ balance: '470.00', entries: 31, chainIntact: true }); // 30 distinct bets per wallet, each applied once
      expect(truth.balance).toBe(truth.ledgerBalance);
      expect(acknowledged.get(w.walletId) ?? 0).toBeLessThanOrEqual(30);
    }
  });
});
