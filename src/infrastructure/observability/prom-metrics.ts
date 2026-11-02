import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Metrics, TransactionSource } from '@/application/ports/metrics';

const FAST_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LAG_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions: Counter<'status' | 'kind'>;
  private readonly duplicates: Counter<'source'>;
  private readonly conflicts: Counter<'source'>;
  private readonly duration: Histogram<'source'>;
  private readonly lockWait: Histogram;
  private readonly lockConflicts: Counter<'type'>;
  private readonly retries: Counter<'component' | 'reason'>;
  private readonly dlq: Counter<'reason'>;
  private readonly outboxPublishedTotal: Counter;
  private readonly outboxFailedTotal: Counter;
  private readonly outboxDelay: Histogram;
  private readonly outboxPending: Gauge;
  private readonly outboxLag: Gauge;
  private readonly divergences: Counter;

  constructor(instanceId: string, collectDefaults = true) {
    const registers = [this.registry];
    this.registry.setDefaultLabels({ instance: instanceId });
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });

    this.transactions = new Counter({
      name: 'wager_transactions_total',
      help: 'Transactions by resulting status and kind',
      labelNames: ['status', 'kind'],
      registers,
    });
    this.duplicates = new Counter({
      name: 'wager_duplicates_total',
      help: 'Idempotent replays / duplicate deliveries detected',
      labelNames: ['source'],
      registers,
    });
    this.conflicts = new Counter({
      name: 'wager_idempotency_conflicts_total',
      help: 'Same key or message id reused with a different payload',
      labelNames: ['source'],
      registers,
    });
    this.duration = new Histogram({
      name: 'wager_processing_duration_seconds',
      help: 'End-to-end processing latency of one transaction',
      labelNames: ['source'],
      buckets: FAST_BUCKETS,
      registers,
    });
    this.lockWait = new Histogram({
      name: 'wallet_lock_wait_seconds',
      help: 'Time spent waiting for the wallet row lock',
      buckets: FAST_BUCKETS,
      registers,
    });
    this.lockConflicts = new Counter({
      name: 'wallet_lock_conflicts_total',
      help: 'Deadlocks, lock timeouts and version conflicts',
      labelNames: ['type'],
      registers,
    });
    this.retries = new Counter({
      name: 'retries_total',
      help: 'Retries by component and reason',
      labelNames: ['component', 'reason'],
      registers,
    });
    this.dlq = new Counter({
      name: 'dlq_messages_total',
      help: 'Messages sent to the dead-letter queue',
      labelNames: ['reason'],
      registers,
    });
    this.outboxPublishedTotal = new Counter({
      name: 'outbox_published_total',
      help: 'Outbox events published',
      registers,
    });
    this.outboxFailedTotal = new Counter({
      name: 'outbox_publish_failures_total',
      help: 'Outbox publish attempts that failed',
      registers,
    });
    this.outboxDelay = new Histogram({
      name: 'outbox_publish_delay_seconds',
      help: 'Time between event creation and publication',
      buckets: LAG_BUCKETS,
      registers,
    });
    this.outboxPending = new Gauge({
      name: 'outbox_pending_messages',
      help: 'Unpublished outbox events',
      registers,
    });
    this.outboxLag = new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Age of the oldest unpublished outbox event',
      registers,
    });
    this.divergences = new Counter({
      name: 'reconciliation_divergences_total',
      help: 'Wallets whose balance disagrees with their ledger',
      registers,
    });
  }

  transactionOutcome(status: string, kind: string): void {
    this.transactions.inc({ status, kind });
  }
  duplicateDetected(source: TransactionSource): void {
    this.duplicates.inc({ source });
  }
  idempotencyConflict(source: TransactionSource): void {
    this.conflicts.inc({ source });
  }
  processingDuration(source: TransactionSource, seconds: number): void {
    this.duration.observe({ source }, seconds);
  }
  walletLockWait(seconds: number): void {
    this.lockWait.observe(seconds);
  }
  lockConflict(type: string): void {
    this.lockConflicts.inc({ type });
  }
  retry(component: string, reason: string): void {
    this.retries.inc({ component, reason });
  }
  dlqMessage(reason: string): void {
    this.dlq.inc({ reason });
  }
  outboxPublished(delaySeconds: number): void {
    this.outboxPublishedTotal.inc();
    this.outboxDelay.observe(delaySeconds);
  }
  outboxPublishFailed(): void {
    this.outboxFailedTotal.inc();
  }
  outboxBacklog(pending: number, oldestAgeSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(oldestAgeSeconds);
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
