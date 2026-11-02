import { AppConfig, loadConfig } from '@/config/app-config';

export const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wagering:wagering@localhost:5432/wagering';

/** Queue names unique per test file, so suites never consume each other's messages. */
export function uniqueQueueNames(prefix = 't') {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    SQS_WAGER_QUEUE: `${prefix}-wager-${suffix}.fifo`,
    SQS_WAGER_DLQ: `${prefix}-wager-dlq-${suffix}.fifo`,
    SQS_EVENTS_QUEUE: `${prefix}-events-${suffix}.fifo`,
  };
}

/** Fast timers so tests converge in seconds instead of minutes. */
export const FAST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  DATABASE_URL,
  CONSUMER_WAIT_SECONDS: '1',
  CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '3',
  CONSUMER_RETRY_BASE_SECONDS: '1',
  CONSUMER_MAX_ATTEMPTS: '3',
  CONSUMER_CONCURRENCY: '3',
  OUTBOX_POLL_INTERVAL_MS: '100',
  OUTBOX_BASE_DELAY_MS: '100',
  OUTBOX_MAX_DELAY_MS: '500',
  PENDING_REFERENCE_POLL_INTERVAL_MS: '200',
  PENDING_REFERENCE_BASE_DELAY_MS: '300',
  PENDING_REFERENCE_MAX_DELAY_MS: '1000',
  PENDING_REFERENCE_MAX_ATTEMPTS: '5',
  PENDING_REFERENCE_TTL_SECONDS: '30',
  PENDING_REFERENCE_LEASE_SECONDS: '5',
  DB_LOCK_TIMEOUT_MS: '10000',
  SHUTDOWN_TIMEOUT_MS: '5000',
};

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...process.env, ...FAST_ENV, ...overrides });
}
