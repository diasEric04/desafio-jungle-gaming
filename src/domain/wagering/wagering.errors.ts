import { DomainError } from '../errors';

export class InvalidTransactionError extends DomainError {
  readonly code = 'INVALID_TRANSACTION';
  readonly category = 'VALIDATION' as const;

  constructor(message: string) {
    super(message);
  }
}

/** Raised when a terminal (or otherwise impossible) transition is attempted: a programming error. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  readonly category = 'INVARIANT' as const;

  constructor(message: string) {
    super(message);
  }
}

/** Same idempotency key (or same provider transaction id) with a different payload. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly category = 'CONFLICT' as const;

  constructor(idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used with a different payload`);
  }
}

export class TransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';
  readonly category = 'NOT_FOUND' as const;

  constructor(reference: string) {
    super(`Transaction ${reference} not found`);
  }
}
