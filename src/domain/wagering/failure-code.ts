/**
 * Stable, machine-readable reason for a REJECTED / FAILED transaction.
 *
 * Every code carries a `RetryAdvice` so a provider can decide what to do without parsing messages.
 * Remember that a terminal transaction is final for its idempotency key: re-sending the same key
 * returns the same rejection. "Retrying" always means sending a NEW externalTransactionId.
 */
export enum FailureCode {
  /** BET: wallet balance lower than the stake. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK that would debit more than the wallet currently holds (operationally different). */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Referenced transaction never arrived within the retry budget / TTL. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referenced transaction exists but is REJECTED / FAILED, so there is nothing to apply against. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Reference belongs to another player / wallet / currency / round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Reference has a kind that this operation cannot target (e.g. REFUND of a WIN). */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** The reference was already reversed (at most one reversal per transaction). */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** REFUND / ROLLBACK amount differs from the referenced amount (no partial reversals). */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** playerId does not own the wallet. */
  PlayerMismatch = 'PLAYER_MISMATCH',
  /** Unexpected permanent failure while reprocessing; stored as FAILED for audit. */
  InternalError = 'INTERNAL_ERROR',
}

export enum RetryAdvice {
  /** Fix the payload, then send it again under a new externalTransactionId. */
  FixPayload = 'FIX_PAYLOAD',
  /** The request was valid; it may be sent again later under a new externalTransactionId. */
  SubmitNewTransactionLater = 'SUBMIT_NEW_TRANSACTION_LATER',
  /** Nothing the provider can do will change the outcome. */
  DoNotRetry = 'DO_NOT_RETRY',
  /** Needs a human on our side; contact support with the transaction id. */
  ManualReview = 'MANUAL_REVIEW',
}

const ADVICE: Readonly<Record<FailureCode, RetryAdvice>> = {
  [FailureCode.InsufficientFunds]: RetryAdvice.SubmitNewTransactionLater,
  [FailureCode.ReversalWouldOverdraw]: RetryAdvice.ManualReview,
  [FailureCode.ReferenceNotFound]: RetryAdvice.SubmitNewTransactionLater,
  [FailureCode.ReferenceNotProcessed]: RetryAdvice.DoNotRetry,
  [FailureCode.ReferenceMismatch]: RetryAdvice.FixPayload,
  [FailureCode.InvalidReferenceKind]: RetryAdvice.FixPayload,
  [FailureCode.AlreadyReversed]: RetryAdvice.DoNotRetry,
  [FailureCode.AmountMismatch]: RetryAdvice.FixPayload,
  [FailureCode.CurrencyMismatch]: RetryAdvice.FixPayload,
  [FailureCode.PlayerMismatch]: RetryAdvice.FixPayload,
  [FailureCode.InternalError]: RetryAdvice.ManualReview,
};

export function retryAdviceFor(code: FailureCode): RetryAdvice {
  return ADVICE[code];
}
