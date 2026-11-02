import { BackoffPolicy } from '@/domain/shared/backoff';
import { Metrics } from '../ports/metrics';
import { OutboxRepository } from '../ports/repositories';
import { Clock, EventPublisher, Logger } from '../ports/services';
import { UnitOfWork } from '../ports/transaction';

export interface PublishOutboxResult {
  published: number;
  failed: number;
}

/**
 * Transactional-outbox relay. One batch = one SQL transaction:
 *
 *   claim due rows (FOR UPDATE SKIP LOCKED) -> publish each -> mark published -> COMMIT.
 *
 * Several publishers can run at once (they skip each other's locked rows). If a publisher dies after
 * sending but before COMMIT, the rows become visible again and another publisher sends them a
 * second time: delivery is at-least-once, and consumers deduplicate by `eventId` (the same id is
 * used as the FIFO MessageDeduplicationId, which also absorbs most duplicates broker-side).
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      outbox: OutboxRepository;
      publisher: EventPublisher;
      clock: Clock;
      metrics: Metrics;
      logger: Logger;
      backoff: BackoffPolicy;
    },
  ) {}

  async execute(batchSize: number): Promise<PublishOutboxResult> {
    const { uow, outbox, publisher, clock, metrics, logger, backoff } = this.deps;

    return uow.run(async (tx) => {
      const due = await outbox.claimDue(tx, clock.now(), batchSize);
      let published = 0;
      let failed = 0;

      for (const message of due) {
        try {
          await publisher.publish(message);
          const at = clock.now();
          message.markPublished(at);
          metrics.outboxPublished(
            Math.max(0, (at.getTime() - message.occurredAt.getTime()) / 1000),
          );
          published += 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          message.scheduleRetry(clock.now(), reason, backoff);
          metrics.outboxPublishFailed();
          metrics.retry('outbox', 'publish_failed');
          logger.warn('outbox publish failed, will retry', {
            outboxMessageId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            nextAttemptAt: message.nextAttemptAt?.toISOString(),
            reason,
          });
          failed += 1;
        }
        await outbox.save(tx, message);
      }
      return { published, failed };
    });
  }

  /** Refreshes the backlog gauges (pending count and age of the oldest pending event). */
  async refreshBacklogMetrics(): Promise<void> {
    const stats = await this.deps.uow.read((tx) =>
      this.deps.outbox.stats(tx, this.deps.clock.now()),
    );
    this.deps.metrics.outboxBacklog(stats.pendingCount, stats.oldestPendingAgeSeconds);
  }
}
