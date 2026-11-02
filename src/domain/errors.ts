/**
 * How an error should be treated by the outer layers, without the domain knowing about HTTP or SQS:
 *  - VALIDATION: the input can never be valid as sent (HTTP 400, SQS -> DLQ).
 *  - CONFLICT:   the request contradicts persisted state (HTTP 409, SQS -> DLQ).
 *  - NOT_FOUND:  a referenced aggregate does not exist (HTTP 404, SQS -> DLQ).
 *  - INVARIANT:  programming error / corrupted state; never a normal business path (HTTP 500).
 *
 * Business *rejections* (insufficient funds, bad reference...) are NOT errors: they are persisted
 * as REJECTED transactions with a FailureCode.
 */
export type ErrorCategory = 'VALIDATION' | 'CONFLICT' | 'NOT_FOUND' | 'INVARIANT';

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
