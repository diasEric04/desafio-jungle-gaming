import { TransientInfrastructureError } from '@/application/errors';
import type { Metrics } from '@/application/ports/metrics';
import type { Logger } from '@/application/ports/services';
import type { PublishOutboxUseCase } from '@/application/use-cases/outbox';
import type {
  ClaimDuePendingReferencesUseCase,
  ReprocessPendingReferenceUseCase,
} from '@/application/use-cases/pending-references';
import type { AppConfig } from '@/config/app-config';
import { uuidv7 } from '@/shared/system';
import { LoopRunner } from './loop-runner';

/** Relays outbox rows to the broker. Any number of instances may run it concurrently. */
export class OutboxPublisherWorker {
  private readonly runner: LoopRunner;
  private ticks = 0;

  constructor(
    private readonly useCase: PublishOutboxUseCase,
    private readonly config: AppConfig['outbox'],
    logger: Logger,
    private readonly shutdownTimeoutMs: number,
  ) {
    this.runner = new LoopRunner(
      'outbox-publisher',
      config.pollIntervalMs,
      () => this.tick(),
      logger,
    );
  }

  start(): void {
    this.runner.start();
  }

  stop(): Promise<void> {
    return this.runner.stop(this.shutdownTimeoutMs);
  }

  private async tick(): Promise<boolean> {
    const result = await this.useCase.execute(this.config.batchSize);
    // Backlog gauges are cheap but not free: refresh them on every 4th tick and whenever idle.
    this.ticks += 1;
    if (this.ticks % 4 === 0 || result.published + result.failed === 0) {
      await this.useCase.refreshBacklogMetrics().catch(() => undefined);
    }
    // Keep draining only while batches come back full and healthy.
    return result.failed === 0 && result.published >= this.config.batchSize;
  }
}

/** Re-evaluates PENDING_REFERENCE transactions whose backoff elapsed (or whose reference just landed). */
export class PendingReferenceWorker {
  private readonly runner: LoopRunner;

  constructor(
    private readonly claim: ClaimDuePendingReferencesUseCase,
    private readonly reprocess: ReprocessPendingReferenceUseCase,
    private readonly config: AppConfig['pendingReference'],
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly shutdownTimeoutMs: number,
  ) {
    this.runner = new LoopRunner(
      'pending-reference',
      config.pollIntervalMs,
      () => this.tick(),
      logger,
    );
  }

  start(): void {
    this.runner.start();
  }

  stop(): Promise<void> {
    return this.runner.stop(this.shutdownTimeoutMs);
  }

  private async tick(): Promise<boolean> {
    const claims = await this.claim.execute(this.config.batchSize);
    for (const item of claims) {
      const correlationId = uuidv7();
      try {
        await this.reprocess.execute(item, correlationId);
      } catch (error) {
        if (error instanceof TransientInfrastructureError) {
          // The lease expires on its own and the row is claimed again.
          this.metrics.retry('pending_reference', error.reason);
          this.logger.warn('pending reference reevaluation deferred', {
            correlationId,
            transactionId: item.transactionId,
            reason: error.reason,
          });
          continue;
        }
        this.logger.error('pending reference failed permanently', {
          correlationId,
          transactionId: item.transactionId,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.reprocess.markFailed(item, correlationId).catch((inner: unknown) => {
          this.logger.error('could not park failed pending reference', {
            correlationId,
            transactionId: item.transactionId,
            error: inner instanceof Error ? inner.message : String(inner),
          });
        });
      }
    }
    return claims.length >= this.config.batchSize;
  }
}
