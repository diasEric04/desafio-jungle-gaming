export interface BackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/**
 * Exponential backoff with +/-20% jitter, capped at `maxDelayMs`.
 * `attempt` is zero-based: attempt 0 waits ~baseDelayMs.
 */
export function exponentialDelayMs(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(attempt, 0), 30);
  const raw = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const jitter = 0.8 + random() * 0.4;
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(raw * jitter)));
}
