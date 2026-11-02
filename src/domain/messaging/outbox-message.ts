import { BackoffPolicy, exponentialDelayMs } from '../shared/backoff';
import { IntegrationEvent, IntegrationEventEnvelope } from './integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  lastError?: string;
}

export const DEFAULT_OUTBOX_BACKOFF: BackoffPolicy = { baseDelayMs: 1_000, maxDelayMs: 60_000 };

const MAX_ERROR_LENGTH = 500;

/**
 * A integration event waiting to be published. It is inserted in the same SQL transaction as the
 * financial change that produced it, and published later by a worker (transactional outbox).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope: IntegrationEventEnvelope<unknown> = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      envelope as unknown as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    this._attempts += 1;
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
    this._lastError = undefined;
  }

  /** Increments attempts and computes the next due time with exponential backoff. */
  scheduleRetry(
    now: Date,
    error?: string,
    backoff: BackoffPolicy = DEFAULT_OUTBOX_BACKOFF,
    random: () => number = Math.random,
  ): void {
    const delay = exponentialDelayMs(this._attempts, backoff, random);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delay);
    this._lastError = error?.slice(0, MAX_ERROR_LENGTH);
  }
}
