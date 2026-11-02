import { BackoffPolicy, exponentialDelayMs } from '../shared/backoff';

export interface PendingReferencePolicyConfig extends BackoffPolicy {
  /** Total number of re-evaluations allowed before the transaction is rejected. */
  maxAttempts: number;
  /** Hard deadline since the transaction was accepted. */
  ttlMs: number;
}

/**
 * Decides when to look at a PENDING_REFERENCE transaction again and when to give up.
 *
 * Defaults (see .env.example): 8 attempts, 5s base delay doubling up to 120s, 10 min TTL. That covers
 * the usual provider retry/jitter window (seconds to a couple of minutes) while keeping a transaction
 * that will never resolve from lingering for hours; whichever limit is hit first wins.
 */
export class PendingReferencePolicy {
  constructor(
    private readonly config: PendingReferencePolicyConfig,
    private readonly random: () => number = Math.random,
  ) {}

  /** `attempt` is how many re-evaluations already happened (0 for the first schedule). */
  nextAttemptAt(attempt: number, now: Date): Date {
    return new Date(now.getTime() + exponentialDelayMs(attempt, this.config, this.random));
  }

  /** `attemptNumber` is the 1-based number of the evaluation that is happening right now. */
  isExhausted(attemptNumber: number, createdAt: Date, now: Date): boolean {
    return (
      attemptNumber >= this.config.maxAttempts ||
      now.getTime() - createdAt.getTime() >= this.config.ttlMs
    );
  }
}
