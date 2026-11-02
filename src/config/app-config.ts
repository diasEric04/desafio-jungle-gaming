export interface AppConfig {
  nodeEnv: string;
  port: number;
  instanceId: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  database: {
    url: string;
    poolMin: number;
    poolMax: number;
    /** `SET LOCAL lock_timeout`: how long a statement may wait for a row lock before failing as transient. */
    lockTimeoutMs: number;
    /** Re-runs of a transaction after a deadlock / serialization failure. */
    txMaxRetries: number;
  };
  aws: {
    region: string;
    endpoint: string | undefined;
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
  };
  queues: { wager: string; dlq: string; events: string };
  roles: { consumer: boolean; outboxPublisher: boolean; pendingReferenceWorker: boolean };
  consumer: {
    name: string;
    concurrency: number;
    maxAttempts: number;
    visibilityTimeoutSeconds: number;
    waitSeconds: number;
    retryBaseSeconds: number;
    retryMaxSeconds: number;
  };
  outbox: { pollIntervalMs: number; batchSize: number; baseDelayMs: number; maxDelayMs: number };
  pendingReference: {
    pollIntervalMs: number;
    batchSize: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    ttlSeconds: number;
    leaseSeconds: number;
  };
  shutdownTimeoutMs: number;
  /** Crash simulation used by the recovery tests. Refused when NODE_ENV=production. */
  faults: { exitBeforeAck: boolean; exitAfterPublish: boolean };
}

type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Invalid configuration: ${message}`);
    this.name = 'ConfigError';
  }
}

function text(env: Env, name: string, fallback?: string): string {
  const value = env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`${name} is required`);
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function int(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw))
    throw new ConfigError(`${name} must be a non-negative integer, got "${raw}"`);
  const value = Number(raw);
  if (value < min) throw new ConfigError(`${name} must be >= ${min}, got ${value}`);
  return value;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false, got "${raw}"`);
}

export function loadConfig(env: Env = process.env): AppConfig {
  const nodeEnv = text(env, 'NODE_ENV', 'development');
  const level = text(env, 'LOG_LEVEL', 'info');
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(level)) {
    throw new ConfigError(`LOG_LEVEL must be debug|info|warn|error|silent, got "${level}"`);
  }

  const faults = {
    exitBeforeAck: flag(env, 'FAULT_EXIT_BEFORE_ACK', false),
    exitAfterPublish: flag(env, 'FAULT_EXIT_AFTER_PUBLISH', false),
  };
  if (nodeEnv === 'production' && (faults.exitBeforeAck || faults.exitAfterPublish)) {
    throw new ConfigError('fault injection is not allowed when NODE_ENV=production');
  }

  const poolMin = int(env, 'DB_POOL_MIN', 2);
  const poolMax = int(env, 'DB_POOL_MAX', 20, 1);
  if (poolMin > poolMax) throw new ConfigError('DB_POOL_MIN cannot exceed DB_POOL_MAX');

  return {
    nodeEnv,
    port: int(env, 'PORT', 3000, 1),
    instanceId: text(env, 'INSTANCE_ID', `instance-${process.pid}`),
    logLevel: level as AppConfig['logLevel'],
    database: {
      url: text(env, 'DATABASE_URL'),
      poolMin,
      poolMax,
      lockTimeoutMs: int(env, 'DB_LOCK_TIMEOUT_MS', 5_000, 100),
      txMaxRetries: int(env, 'DB_TX_MAX_RETRIES', 3),
    },
    aws: {
      region: text(env, 'AWS_REGION', 'us-east-1'),
      endpoint: optional(env, 'AWS_ENDPOINT_URL'),
      accessKeyId: optional(env, 'AWS_ACCESS_KEY_ID'),
      secretAccessKey: optional(env, 'AWS_SECRET_ACCESS_KEY'),
    },
    queues: {
      wager: text(env, 'SQS_WAGER_QUEUE', 'wager-transactions.fifo'),
      dlq: text(env, 'SQS_WAGER_DLQ', 'wager-transactions-dlq.fifo'),
      events: text(env, 'SQS_EVENTS_QUEUE', 'wager-events.fifo'),
    },
    roles: {
      consumer: flag(env, 'ENABLE_QUEUE_CONSUMER', true),
      outboxPublisher: flag(env, 'ENABLE_OUTBOX_PUBLISHER', true),
      pendingReferenceWorker: flag(env, 'ENABLE_PENDING_REFERENCE_WORKER', true),
    },
    consumer: {
      name: text(env, 'CONSUMER_NAME', 'wager-transactions-consumer'),
      concurrency: int(env, 'CONSUMER_CONCURRENCY', 5, 1),
      maxAttempts: int(env, 'CONSUMER_MAX_ATTEMPTS', 5, 1),
      visibilityTimeoutSeconds: int(env, 'CONSUMER_VISIBILITY_TIMEOUT_SECONDS', 30, 1),
      waitSeconds: int(env, 'CONSUMER_WAIT_SECONDS', 5),
      retryBaseSeconds: int(env, 'CONSUMER_RETRY_BASE_SECONDS', 2, 1),
      retryMaxSeconds: int(env, 'CONSUMER_RETRY_MAX_SECONDS', 120, 1),
    },
    outbox: {
      pollIntervalMs: int(env, 'OUTBOX_POLL_INTERVAL_MS', 500, 10),
      batchSize: int(env, 'OUTBOX_BATCH_SIZE', 25, 1),
      baseDelayMs: int(env, 'OUTBOX_BASE_DELAY_MS', 1_000, 1),
      maxDelayMs: int(env, 'OUTBOX_MAX_DELAY_MS', 60_000, 1),
    },
    pendingReference: {
      pollIntervalMs: int(env, 'PENDING_REFERENCE_POLL_INTERVAL_MS', 2_000, 10),
      batchSize: int(env, 'PENDING_REFERENCE_BATCH_SIZE', 20, 1),
      maxAttempts: int(env, 'PENDING_REFERENCE_MAX_ATTEMPTS', 8, 1),
      baseDelayMs: int(env, 'PENDING_REFERENCE_BASE_DELAY_MS', 5_000, 1),
      maxDelayMs: int(env, 'PENDING_REFERENCE_MAX_DELAY_MS', 120_000, 1),
      ttlSeconds: int(env, 'PENDING_REFERENCE_TTL_SECONDS', 600, 1),
      leaseSeconds: int(env, 'PENDING_REFERENCE_LEASE_SECONDS', 30, 1),
    },
    shutdownTimeoutMs: int(env, 'SHUTDOWN_TIMEOUT_MS', 20_000, 1),
    faults,
  };
}
