export type TransactionSource = 'http' | 'sqs' | 'reprocess';

export interface Metrics {
  /** One increment per settled/accepted transaction, by resulting status and kind. */
  transactionOutcome(status: string, kind: string): void;
  duplicateDetected(source: TransactionSource): void;
  idempotencyConflict(source: TransactionSource): void;
  processingDuration(source: TransactionSource, seconds: number): void;
  /** Wallet row lock: time spent waiting for it. */
  walletLockWait(seconds: number): void;
  /** deadlock | serialization | lock_timeout | version_conflict */
  lockConflict(type: string): void;
  retry(component: string, reason: string): void;
  dlqMessage(reason: string): void;
  outboxPublished(delaySeconds: number): void;
  outboxPublishFailed(): void;
  outboxBacklog(pending: number, oldestAgeSeconds: number): void;
  reconciliationDivergence(): void;
}
