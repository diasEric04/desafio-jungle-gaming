/**
 * Infrastructure failure that is expected to go away by itself (database restarting, pool exhausted,
 * lock wait timeout, broker unavailable...). HTTP maps it to 503 + Retry-After; the SQS consumer
 * retries with backoff. It is always safe to retry because every write path is idempotent.
 */
export class TransientInfrastructureError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransientInfrastructureError';
  }
}

/** Optimistic compare-and-swap on the wallet version failed. Should be impossible under the row lock. */
export class ConcurrentModificationError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} was modified concurrently`);
    this.name = 'ConcurrentModificationError';
  }
}
