import { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SettlementPersister } from '@/application/services/settlement-persister';
import { PublishOutboxUseCase } from '@/application/use-cases/outbox';
import {
  ClaimDuePendingReferencesUseCase,
  ReprocessPendingReferenceUseCase,
} from '@/application/use-cases/pending-references';
import { ProcessWagerTransactionUseCase } from '@/application/use-cases/process-wager-transaction';
import { GetWagerTransactionQuery } from '@/application/use-cases/wagering-queries';
import {
  CreateWalletUseCase,
  GetLedgerQuery,
  GetWalletQuery,
  ReconcileWalletUseCase,
} from '@/application/use-cases/wallets';
import type { AppConfig } from '@/config/app-config';
import { PendingReferencePolicy } from '@/domain/wagering/pending-reference-policy';
import { WagerSettlement } from '@/domain/wagering/wager-settlement';
import { SystemClock, UuidV7Generator } from '@/shared/system';
import { ReadinessChecker } from './health/readiness';
import { QueueUrls, resolveQueueUrls } from './messaging/queues';
import { createSqsClient } from './messaging/sqs-client';
import { FaultInjectingPublisher, SqsEventPublisher } from './messaging/sqs-event-publisher';
import { SqsWagerConsumer } from './messaging/sqs-wager-consumer';
import { JsonLogger } from './observability/json-logger';
import { PromMetrics } from './observability/prom-metrics';
import { createOrmConfig } from './persistence/mikro-orm.config';
import { MikroOrmWagerTransactionRepository } from './persistence/repositories/wager-transaction.repository';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
} from './persistence/repositories/ledger-inbox-outbox.repositories';
import { MikroOrmWalletRepository } from './persistence/repositories/wallet.repository';
import { MikroOrmUnitOfWork } from './persistence/unit-of-work';
import { OutboxPublisherWorker, PendingReferenceWorker } from './workers/background-workers';
import { AllowAllProviderIdentity } from './auth/provider-identity';
import type { ProviderIdentityPort } from '@/application/ports/services';

export interface ContainerOptions {
  /** Skip SQS entirely (database-only tests). Disables consumer, outbox publisher and the SQS readiness check. */
  withMessaging?: boolean;
}

/**
 * Composition root: the only place that knows every concrete class. HTTP (Nest), the migration
 * script and the test suites all build the same object graph through here.
 */
export async function createContainer(config: AppConfig, options: ContainerOptions = {}) {
  const withMessaging = options.withMessaging ?? true;
  const logger = new JsonLogger(config.logLevel, { instance: config.instanceId });
  const metrics = new PromMetrics(config.instanceId);
  const clock = new SystemClock();
  const ids = new UuidV7Generator();

  const orm = await MikroORM.init(createOrmConfig(config.database));
  const uow = new MikroOrmUnitOfWork(
    orm,
    { lockTimeoutMs: config.database.lockTimeoutMs, maxRetries: config.database.txMaxRetries },
    metrics,
    logger,
  );

  const wallets = new MikroOrmWalletRepository();
  const transactions = new MikroOrmWagerTransactionRepository();
  const ledger = new MikroOrmLedgerRepository();
  const inbox = new MikroOrmInboxRepository();
  const outbox = new MikroOrmOutboxRepository();

  const pendingPolicy = new PendingReferencePolicy({
    maxAttempts: config.pendingReference.maxAttempts,
    ttlMs: config.pendingReference.ttlSeconds * 1000,
    baseDelayMs: config.pendingReference.baseDelayMs,
    maxDelayMs: config.pendingReference.maxDelayMs,
  });
  const settlement = new WagerSettlement();
  const persister = new SettlementPersister({
    wallets,
    transactions,
    ledger,
    outbox,
    ids,
    pendingPolicy,
    metrics,
  });

  const useCases = {
    createWallet: new CreateWalletUseCase({
      uow,
      wallets,
      transactions,
      ledger,
      outbox,
      clock,
      ids,
    }),
    processWagerTransaction: new ProcessWagerTransactionUseCase({
      uow,
      wallets,
      transactions,
      inbox,
      persister,
      settlement,
      clock,
      ids,
      metrics,
      logger,
    }),
    claimPendingReferences: new ClaimDuePendingReferencesUseCase({
      uow,
      transactions,
      clock,
      leaseMs: config.pendingReference.leaseSeconds * 1000,
    }),
    reprocessPendingReference: new ReprocessPendingReferenceUseCase({
      uow,
      wallets,
      transactions,
      persister,
      settlement,
      policy: pendingPolicy,
      clock,
      ids,
      metrics,
      logger,
    }),
    getWallet: new GetWalletQuery({ uow, wallets }),
    getLedger: new GetLedgerQuery({ uow, wallets, ledger }),
    getTransaction: new GetWagerTransactionQuery({ uow, transactions }),
    reconcileWallet: new ReconcileWalletUseCase({ uow, wallets, metrics, logger }),
  };

  let sqs: SQSClient | undefined;
  let queueUrls: QueueUrls | undefined;
  let publishOutbox: PublishOutboxUseCase | undefined;
  let consumer: SqsWagerConsumer | undefined;
  let outboxWorker: OutboxPublisherWorker | undefined;

  if (withMessaging) {
    sqs = createSqsClient(config.aws);
    queueUrls = await resolveQueueUrls(sqs, config.queues);
    const publisher = new FaultInjectingPublisher(
      new SqsEventPublisher(sqs, queueUrls.events),
      config.faults.exitAfterPublish,
    );
    publishOutbox = new PublishOutboxUseCase({
      uow,
      outbox,
      publisher,
      clock,
      metrics,
      logger,
      backoff: { baseDelayMs: config.outbox.baseDelayMs, maxDelayMs: config.outbox.maxDelayMs },
    });
    if (config.roles.outboxPublisher) {
      outboxWorker = new OutboxPublisherWorker(
        publishOutbox,
        config.outbox,
        logger,
        config.shutdownTimeoutMs,
      );
    }
    if (config.roles.consumer) {
      consumer = new SqsWagerConsumer({
        client: sqs,
        queueUrl: queueUrls.wager,
        dlqUrl: queueUrls.dlq,
        useCase: useCases.processWagerTransaction,
        config: config.consumer,
        faultExitBeforeAck: config.faults.exitBeforeAck,
        shutdownTimeoutMs: config.shutdownTimeoutMs,
        metrics,
        logger,
      });
    }
  }

  const pendingWorker = config.roles.pendingReferenceWorker
    ? new PendingReferenceWorker(
        useCases.claimPendingReferences,
        useCases.reprocessPendingReference,
        config.pendingReference,
        metrics,
        logger,
        config.shutdownTimeoutMs,
      )
    : undefined;

  const readiness = new ReadinessChecker(orm, sqs, queueUrls?.wager);

  return {
    config,
    logger,
    metrics,
    orm,
    uow,
    sqs,
    queueUrls,
    useCases,
    publishOutbox,
    readiness,
    providerIdentity: new AllowAllProviderIdentity() as ProviderIdentityPort,

    start(): void {
      outboxWorker?.start();
      pendingWorker?.start();
      consumer?.start();
      logger.info('background roles started', {
        consumer: consumer !== undefined,
        outboxPublisher: outboxWorker !== undefined,
        pendingReferenceWorker: pendingWorker !== undefined,
      });
    },

    /** Graceful shutdown: stop taking work, let in-flight work commit/ack, then release the pool. */
    async stop(): Promise<void> {
      readiness.markShuttingDown();
      await Promise.all([consumer?.stop(), outboxWorker?.stop(), pendingWorker?.stop()]);
      sqs?.destroy();
      await orm.close(true);
      logger.info('shutdown complete');
    },
  };
}

export type Container = Awaited<ReturnType<typeof createContainer>>;
