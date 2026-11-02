import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { TransientInfrastructureError } from '@/application/errors';
import { PublishOutboxUseCase } from '@/application/use-cases/outbox';
import type { ProcessWagerTransactionUseCase } from '@/application/use-cases/process-wager-transaction';
import { Container, createContainer } from '@/infrastructure/container';
import { provisionQueues, QueueUrls } from '@/infrastructure/messaging/queues';
import { createSqsClient } from '@/infrastructure/messaging/sqs-client';
import { SqsWagerConsumer } from '@/infrastructure/messaging/sqs-wager-consumer';
import { SqsWagerProducer } from '@/infrastructure/messaging/sqs-wager-producer';
import { MikroOrmOutboxRepository } from '@/infrastructure/persistence/repositories/ledger-inbox-outbox.repositories';
import { WagerTransactionKind as K } from '@/domain/wagering/wager-transaction';
import { SystemClock } from '@/shared/system';
import type { WagerFields } from '@/shared/wager-input-schema';
import { assertConsistent, migrate, newId, waitFor } from '../support/db';
import { DATABASE_URL, testConfig, uniqueQueueNames } from '../support/env';

const names = uniqueQueueNames('it');
const config = testConfig({
  ...names,
  ENABLE_QUEUE_CONSUMER: 'false',
  ENABLE_OUTBOX_PUBLISHER: 'false',
  ENABLE_PENDING_REFERENCE_WORKER: 'false',
});

let container: Container;
let sqs: SQSClient;
let urls: QueueUrls;
let producer: SqsWagerProducer;
let pg: Client;

beforeAll(async () => {
  await migrate();
  sqs = createSqsClient(config.aws);
  urls = await provisionQueues(sqs, config.queues, {
    redriveMaxReceiveCount: 10,
    visibilityTimeoutSeconds: 3,
  });
  container = await createContainer(config);
  producer = new SqsWagerProducer(sqs, urls.wager);
  pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
});
afterAll(async () => {
  await pg.end();
  await container.stop();
  sqs.destroy();
});

async function openWallet(amount = '100.00') {
  const playerId = newId();
  const wallet = await container.useCases.createWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'it',
  });
  return { walletId: wallet.id, playerId };
}

const bet = (
  walletId: string,
  playerId: string,
  amount = '25.00',
  external = `bet-${newId()}`,
): WagerFields => ({
  providerId: 'provider-a',
  externalTransactionId: external,
  playerId,
  walletId,
  roundId: 'r1',
  gameId: 'g',
  kind: 'BET',
  money: { amount, currency: 'BRL' },
});

async function balanceOf(walletId: string): Promise<string> {
  return (await pg.query(`SELECT balance::text AS b FROM wallets WHERE id = $1`, [walletId]))
    .rows[0].b;
}

async function queueDepth(url: string): Promise<number> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(out.Attributes?.['ApproximateNumberOfMessages'] ?? 0) +
    Number(out.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? 0)
  );
}

function startConsumer(
  useCase: ProcessWagerTransactionUseCase = container.useCases.processWagerTransaction,
  overrides: Partial<typeof config.consumer> = {},
) {
  const consumer = new SqsWagerConsumer({
    client: sqs,
    queueUrl: urls.wager,
    dlqUrl: urls.dlq,
    useCase,
    config: { ...config.consumer, ...overrides },
    faultExitBeforeAck: false,
    shutdownTimeoutMs: 5_000,
    metrics: container.metrics,
    logger: container.logger,
  });
  consumer.start();
  return consumer;
}

async function drain(
  url: string,
  max = 20,
): Promise<{ body: string; attrs: Record<string, string> }[]> {
  const out: { body: string; attrs: Record<string, string> }[] = [];
  const deadline = Date.now() + 8_000;
  while (out.length < max && Date.now() < deadline) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
        VisibilityTimeout: 1,
      }),
    );
    for (const m of res.Messages ?? []) {
      out.push({
        body: m.Body ?? '',
        attrs: Object.fromEntries(
          Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? '']),
        ),
      });
    }
    if (!(res.Messages ?? []).length && out.length) break;
  }
  return out;
}

describe('SQS consumer', () => {
  test('processes a message, acks only after commit, and the queue ends empty', async () => {
    const { walletId, playerId } = await openWallet();
    const consumer = startConsumer();
    try {
      const sent = await producer.send(bet(walletId, playerId, '25.00'));
      await waitFor(async () => (await balanceOf(walletId)) === '75.00', {
        what: 'bet to be applied',
      });
      await waitFor(async () => (await queueDepth(urls.wager)) === 0, { what: 'queue to drain' });
      const inbox = await pg.query(
        `SELECT COUNT(*)::int AS n FROM inbox_messages WHERE message_id = $1`,
        [sent.messageId],
      );
      expect(inbox.rows[0].n).toBe(1);
      await assertConsistent(pg, [walletId]);
    } finally {
      await consumer.stop();
    }
  });

  test('the same logical message delivered twice debits once (inbox + idempotency key)', async () => {
    const { walletId, playerId } = await openWallet();
    const consumer = startConsumer();
    try {
      const data = bet(walletId, playerId, '30.00');
      const first = await producer.send(data, { messageId: `m-${newId()}` });
      // Same messageId, but the broker is forced to accept it again (different dedup id).
      await producer.sendRaw(first.body, walletId, newId());
      // A different messageId carrying the same business request (producer retry): idempotency key catches it.
      await producer.send(data, { messageId: `m-${newId()}` });
      await waitFor(
        async () => (await queueDepth(urls.wager)) === 0 && (await balanceOf(walletId)) === '70.00',
        { what: 'all copies consumed' },
      );
      await new Promise((r) => setTimeout(r, 500));
      expect(await balanceOf(walletId)).toBe('70.00');
      const debits = await pg.query(
        `SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
        [walletId],
      );
      expect(debits.rows[0].n).toBe(1);
    } finally {
      await consumer.stop();
    }
  });

  test('business rejection is persisted and acknowledged (no retry, no DLQ)', async () => {
    const { walletId, playerId } = await openWallet('10.00');
    const consumer = startConsumer();
    try {
      const data = bet(walletId, playerId, '50.00');
      await producer.send(data);
      await waitFor(
        async () =>
          (
            await pg.query(
              `SELECT 1 FROM wager_transactions WHERE wallet_id = $1 AND status = 'REJECTED'`,
              [walletId],
            )
          ).rowCount === 1,
        { what: 'rejection to be stored' },
      );
      await waitFor(async () => (await queueDepth(urls.wager)) === 0, { what: 'queue to drain' });
      expect(await balanceOf(walletId)).toBe('10.00');
    } finally {
      await consumer.stop();
    }
  });

  test('malformed messages and unknown wallets go straight to the DLQ with the reason', async () => {
    const consumer = startConsumer();
    try {
      await producer.sendRaw('{not json', 'g-bad');
      await producer.send(bet(newId(), newId())); // wallet does not exist
      const dead = await waitFor(
        async () => {
          const got = await drain(urls.dlq);
          return got.length >= 2 ? got : undefined;
        },
        { what: 'two DLQ messages', timeoutMs: 30_000 },
      );
      expect(dead.map((m) => m.attrs['failureReason']).sort()).toEqual([
        'MALFORMED_MESSAGE',
        'WALLET_NOT_FOUND',
      ]);
    } finally {
      await consumer.stop();
    }
  });

  test('transient failures are retried with backoff and succeed; exhausted ones reach the DLQ', async () => {
    const { walletId, playerId } = await openWallet();
    let failures = 2;
    const real = container.useCases.processWagerTransaction;
    const flaky = {
      execute: async (cmd: Parameters<typeof real.execute>[0]) => {
        if (cmd.walletId === walletId && failures > 0) {
          failures -= 1;
          throw new TransientInfrastructureError('db down', 'connection');
        }
        return real.execute(cmd);
      },
    } as ProcessWagerTransactionUseCase;
    const consumer = startConsumer(flaky, { maxAttempts: 5 });
    try {
      await producer.send(bet(walletId, playerId, '10.00'));
      await waitFor(async () => (await balanceOf(walletId)) === '90.00', {
        what: 'retry to succeed',
        timeoutMs: 30_000,
      });
      expect(failures).toBe(0);
    } finally {
      await consumer.stop();
    }

    const poisoned = await openWallet();
    const alwaysFailing = {
      execute: async () => {
        throw new TransientInfrastructureError('db down', 'connection');
      },
    } as unknown as ProcessWagerTransactionUseCase;
    const consumer2 = startConsumer(alwaysFailing, { maxAttempts: 2 });
    try {
      await producer.send(bet(poisoned.walletId, poisoned.playerId));
      const dead = await waitFor(
        async () => {
          const got = (await drain(urls.dlq)).filter((m) => m.body.includes(poisoned.walletId));
          return got.length ? got : undefined;
        },
        { what: 'exhausted message in DLQ', timeoutMs: 40_000 },
      );
      expect(dead[0]!.attrs['failureReason']).toBe('RETRIES_EXHAUSTED');
      expect(await balanceOf(poisoned.walletId)).toBe('100.00');
    } finally {
      await consumer2.stop();
    }
  });

  test('stop() with nothing in flight returns promptly (graceful shutdown)', async () => {
    const consumer = startConsumer();
    const started = Date.now();
    await consumer.stop();
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe('transactional outbox', () => {
  test('events reach the events queue after commit, with the documented envelope', async () => {
    const { walletId, playerId } = await openWallet();
    await container.useCases.processWagerTransaction.execute({
      ...bet(walletId, playerId, '5.00'),
      kind: K.Bet,
      idempotencyKey: `k-${newId()}`,
      correlationId: 'corr-1',
      source: 'http',
    });
    await waitFor(
      async () =>
        (await container.publishOutbox!.execute(100)).published >= 0 &&
        !(
          await pg.query(
            `SELECT 1 FROM outbox_messages WHERE published_at IS NULL AND payload->'data'->>'walletId' = $1`,
            [walletId],
          )
        ).rowCount,
      { what: 'outbox to flush' },
    );
    const events = (await drain(urls.events, 50))
      .map((m) => JSON.parse(m.body))
      .filter((e) => e.data?.walletId === walletId);
    expect(events.map((e) => e.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    const changed = events.find(
      (e) => e.eventType === 'WalletBalanceChanged' && e.data.walletVersion === 2,
    );
    expect(changed).toMatchObject({
      version: 1,
      correlationId: 'corr-1',
      data: {
        direction: 'DEBIT',
        money: { amount: '5.00' },
        balanceBefore: { amount: '100.00' },
        balanceAfter: { amount: '95.00' },
      },
    });
    expect(typeof changed.eventId).toBe('string');
  });

  test('two publishers on the same outbox never publish the same row twice (SKIP LOCKED)', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => openWallet('10.00')));
    for (const w of wallets) {
      await container.useCases.processWagerTransaction.execute({
        ...bet(w.walletId, w.playerId, '1.00'),
        kind: K.Bet,
        idempotencyKey: `k-${newId()}`,
        correlationId: 'it',
        source: 'http',
      });
    }
    const mine = new Set(wallets.map((w) => w.walletId));
    const published: string[] = [];
    const slowRecorder = {
      publish: async (m: { id: string; payload: Record<string, unknown> }) => {
        const walletId = (m.payload['data'] as { walletId?: string }).walletId;
        await new Promise((r) => setTimeout(r, 25)); // keep rows locked long enough for the other publisher to collide
        if (walletId && mine.has(walletId)) published.push(m.id);
      },
    };
    const make = () =>
      new PublishOutboxUseCase({
        uow: container.uow,
        outbox: new MikroOrmOutboxRepository(),
        publisher: slowRecorder,
        clock: new SystemClock(),
        metrics: container.metrics,
        logger: container.logger,
        backoff: { baseDelayMs: 10, maxDelayMs: 50 },
      });
    const [a, b] = [make(), make()];
    await Promise.all([a.execute(500), b.execute(500), a.execute(500), b.execute(500)]);
    expect(published.length).toBeGreaterThan(0);
    expect(new Set(published).size).toBe(published.length); // no duplicates
    const pending = await pg.query(
      `SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL AND payload->'data'->>'walletId' = ANY($1)`,
      [[...mine]],
    );
    expect(pending.rows[0].n).toBe(0);
  });

  test('a publisher that dies before COMMIT loses nothing: another one publishes the same rows', async () => {
    const { walletId, playerId } = await openWallet('10.00');
    await container.useCases.processWagerTransaction.execute({
      ...bet(walletId, playerId, '1.00'),
      kind: K.Bet,
      idempotencyKey: `k-${newId()}`,
      correlationId: 'it',
      source: 'http',
    });
    const outbox = new MikroOrmOutboxRepository();
    const sentByDeadPublisher: string[] = [];
    await expect(
      container.uow.run(async (tx) => {
        const claimed = (await outbox.claimDue(tx, new Date(), 500)).filter(
          (m) => (m.payload['data'] as { walletId?: string }).walletId === walletId,
        );
        for (const m of claimed) sentByDeadPublisher.push(m.id); // "published" to the broker...
        throw new Error('process died before COMMIT'); // ...but the marker never committed
      }),
    ).rejects.toThrow(/died/);
    expect(sentByDeadPublisher.length).toBeGreaterThan(0);

    const seen: string[] = [];
    const survivor = new PublishOutboxUseCase({
      uow: container.uow,
      outbox,
      clock: new SystemClock(),
      metrics: container.metrics,
      logger: container.logger,
      publisher: {
        publish: async (m) => {
          if ((m.payload['data'] as { walletId?: string }).walletId === walletId) seen.push(m.id);
        },
      },
      backoff: { baseDelayMs: 10, maxDelayMs: 50 },
    });
    await survivor.execute(500);
    expect(new Set(seen)).toEqual(new Set(sentByDeadPublisher)); // same events, now actually marked as published
  });

  test('broker outage: events stay pending with backoff and flow once it is back', async () => {
    const { walletId, playerId } = await openWallet('10.00');
    await container.useCases.processWagerTransaction.execute({
      ...bet(walletId, playerId, '1.00'),
      kind: K.Bet,
      idempotencyKey: `k-${newId()}`,
      correlationId: 'it',
      source: 'http',
    });
    let down = true;
    const attempts: string[] = [];
    const flaky = new PublishOutboxUseCase({
      uow: container.uow,
      outbox: new MikroOrmOutboxRepository(),
      clock: new SystemClock(),
      metrics: container.metrics,
      logger: container.logger,
      publisher: {
        publish: async (m) => {
          if ((m.payload['data'] as { walletId?: string }).walletId !== walletId) return;
          if (down) throw new Error('sqs unavailable');
          attempts.push(m.id);
        },
      },
      backoff: { baseDelayMs: 50, maxDelayMs: 100 },
    });
    await flaky.execute(500);
    const stuck = await pg.query(
      `SELECT COUNT(*)::int AS n, MAX(attempts) AS attempts FROM outbox_messages WHERE published_at IS NULL AND payload->'data'->>'walletId' = $1`,
      [walletId],
    );
    expect(stuck.rows[0].n).toBeGreaterThan(0);
    expect(stuck.rows[0].attempts).toBeGreaterThanOrEqual(1);
    down = false;
    await waitFor(
      async () => {
        await flaky.execute(500);
        return attempts.length > 0;
      },
      { what: 'events to flow after recovery' },
    );
  });
});
