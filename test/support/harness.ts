import { PublishOutboxUseCase } from '@/application/use-cases/outbox';
import {
  ClaimDuePendingReferencesUseCase,
  ReprocessPendingReferenceUseCase,
} from '@/application/use-cases/pending-references';
import {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '@/application/use-cases/process-wager-transaction';
import { CreateWalletUseCase, ReconcileWalletUseCase } from '@/application/use-cases/wallets';
import { SettlementPersister } from '@/application/services/settlement-persister';
import { PendingReferencePolicy } from '@/domain/wagering/pending-reference-policy';
import { WagerSettlement } from '@/domain/wagering/wager-settlement';
import { WagerTransactionKind } from '@/domain/wagering/wager-transaction';
import type { EventPublisher } from '@/application/ports/services';
import {
  FakeClock,
  InMemoryDb,
  InMemoryInboxRepository,
  InMemoryLedgerRepository,
  InMemoryOutboxRepository,
  InMemoryTransactionRepository,
  InMemoryUnitOfWork,
  InMemoryWalletRepository,
  RecordingMetrics,
  SequentialIds,
  silentLogger,
} from './in-memory';

export const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

/** Wires the real use cases to the in-memory ports. */
export function createHarness(options: { publisher?: EventPublisher } = {}) {
  const db = new InMemoryDb();
  const clock = new FakeClock();
  const ids = new SequentialIds();
  const metrics = new RecordingMetrics();
  const uow = new InMemoryUnitOfWork(db);
  const wallets = new InMemoryWalletRepository(db);
  const transactions = new InMemoryTransactionRepository(db);
  const ledger = new InMemoryLedgerRepository(db);
  const inbox = new InMemoryInboxRepository(db);
  const outbox = new InMemoryOutboxRepository(db);
  const policy = new PendingReferencePolicy(
    { maxAttempts: 3, ttlMs: 10 * 60_000, baseDelayMs: 1_000, maxDelayMs: 10_000 },
    () => 0.5,
  );
  const settlement = new WagerSettlement();
  const persister = new SettlementPersister({
    wallets,
    transactions,
    ledger,
    outbox,
    ids,
    pendingPolicy: policy,
    metrics,
  });

  const process = new ProcessWagerTransactionUseCase({
    uow,
    wallets,
    transactions,
    inbox,
    persister,
    settlement,
    clock,
    ids,
    metrics,
    logger: silentLogger,
  });
  const reprocess = new ReprocessPendingReferenceUseCase({
    uow,
    wallets,
    transactions,
    persister,
    settlement,
    policy,
    clock,
    ids,
    metrics,
    logger: silentLogger,
  });
  const claim = new ClaimDuePendingReferencesUseCase({ uow, transactions, clock, leaseMs: 30_000 });
  const createWallet = new CreateWalletUseCase({
    uow,
    wallets,
    transactions,
    ledger,
    outbox,
    clock,
    ids,
  });
  const reconcile = new ReconcileWalletUseCase({ uow, wallets, metrics, logger: silentLogger });
  const publishOutbox = new PublishOutboxUseCase({
    uow,
    outbox,
    publisher: options.publisher ?? { publish: async () => undefined },
    clock,
    metrics,
    logger: silentLogger,
    backoff: { baseDelayMs: 1_000, maxDelayMs: 60_000 },
  });

  async function openWallet(amount = '100.00') {
    return createWallet.execute({
      playerId: PLAYER,
      initialBalance: { amount, currency: 'BRL' },
      correlationId: 'test',
    });
  }

  let counter = 0;
  function command(
    walletId: string,
    kind: WagerTransactionKind,
    amount: string,
    overrides: Partial<ProcessWagerTransactionCommand> = {},
  ): ProcessWagerTransactionCommand {
    counter += 1;
    const externalTransactionId = overrides.externalTransactionId ?? `tx-${counter}`;
    return {
      idempotencyKey: `provider-a:${externalTransactionId}`,
      providerId: 'provider-a',
      externalTransactionId,
      playerId: PLAYER,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      correlationId: 'test',
      source: 'http',
      ...overrides,
    };
  }

  return {
    db,
    clock,
    metrics,
    process,
    reprocess,
    claim,
    createWallet,
    reconcile,
    publishOutbox,
    openWallet,
    command,
  };
}

export type Harness = ReturnType<typeof createHarness>;
