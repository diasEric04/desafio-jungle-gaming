import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { FailureCode } from './failure-code';
import { InvalidTransactionError, InvalidTransactionStateError } from './wagering.errors';

export enum WagerTransactionKind {
  /** Internal: credit created when a wallet is opened with a positive balance. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Accepted, not yet applied. Only lives inside the SQL transaction that creates it. */
  Pending = 'PENDING',
  /** Waiting for the referenced transaction to arrive / be applied. */
  PendingReference = 'PENDING_REFERENCE',
  /** Applied (terminal). */
  Processed = 'PROCESSED',
  /** Business rule violation (terminal). */
  Rejected = 'REJECTED',
  /** Permanent infrastructure error, kept for audit (terminal). */
  Failed = 'FAILED',
}

/** Provider id reserved for system-generated transactions such as OPENING. */
export const INTERNAL_PROVIDER_ID = 'internal';

/**
 * Valid transitions:
 *
 *   PENDING            -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
 *   PENDING_REFERENCE  -> PENDING_REFERENCE (rescheduled) | PROCESSED | REJECTED | FAILED
 *   PROCESSED | REJECTED | FAILED -> (none: terminal)
 */
export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id in the provider's namespace (not our internal id). */
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  /** internal id of the resolved reference, set when the transaction is PROCESSED against one. */
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Wallet balance right after this transaction was settled; returned verbatim on replays. */
  observedBalance?: Money;
  /** How many times a PENDING_REFERENCE transaction has been re-evaluated. */
  referenceAttempts: number;
  nextAttemptAt?: Date;
  updatedAt: Date;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  payloadHash: string;
  money: Money;
  observedBalance: Money;
  createdAt: Date;
}

const IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

function assertIdentifier(name: string, value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new InvalidTransactionError(
      `${name} must be a non-empty string (max ${maxLength} chars, no control chars or surrounding spaces)`,
    );
  }
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _observedBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextAttemptAt: Date | undefined;
  private _updatedAt: Date;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._observedBalance = state.observedBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextAttemptAt = state.nextAttemptAt;
    this._updatedAt = state.updatedAt;
  }

  /** Nasce em PENDING. Valida as regras de forma e a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionError('OPENING is an internal kind and cannot be submitted');
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidTransactionError(`unknown transaction kind "${String(props.kind)}"`);
    }
    assertIdentifier('providerId', props.providerId, 64);
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidTransactionError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
    assertIdentifier('externalTransactionId', props.externalTransactionId);
    assertIdentifier('idempotencyKey', props.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
    assertIdentifier('walletId', props.walletId);
    assertIdentifier('playerId', props.playerId);
    assertIdentifier('roundId', props.roundId);
    assertIdentifier('gameId', props.gameId);
    if (!HASH_PATTERN.test(props.payloadHash)) {
      throw new InvalidTransactionError('payloadHash must be a lowercase hex SHA-256');
    }

    if (props.money.isNegative()) {
      throw new InvalidTransactionError('amount cannot be negative');
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidTransactionError(`${props.kind} requires an amount greater than zero`);
    }

    const requiresReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (props.referenceExternalTransactionId !== undefined) {
      assertIdentifier('referenceExternalTransactionId', props.referenceExternalTransactionId);
      if (props.referenceExternalTransactionId === props.externalTransactionId) {
        throw new InvalidTransactionError('a transaction cannot reference itself');
      }
      if (props.kind === WagerTransactionKind.Bet) {
        throw new InvalidTransactionError('BET cannot reference another transaction');
      }
    } else if (requiresReference) {
      throw new InvalidTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }

    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
      updatedAt: props.createdAt,
    });
  }

  /** Internal factory: the OPENING credit is born already PROCESSED, together with its ledger entry. */
  static opening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidTransactionError('OPENING requires an amount greater than zero');
    }
    const key = `${INTERNAL_PROVIDER_ID}:opening:${props.walletId}`;
    return new WagerTransaction({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: key,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Processed,
      processedAt: props.createdAt,
      observedBalance: props.observedBalance,
      referenceAttempts: 0,
      updatedAt: props.createdAt,
    });
  }

  /** Reconstruction from persistence: does not re-validate transitions or business rules. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transitions (throw InvalidTransactionStateError when the current state is terminal)

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance: Money,
  ): void {
    this.assertOpen('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._failureCode = undefined;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  /** First time the reference is found missing: PENDING -> PENDING_REFERENCE. */
  markPendingReference(observedBalance: Money, nextAttemptAt: Date, at: Date): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        `markPendingReference requires PENDING, current status is ${this._status}`,
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._observedBalance = observedBalance;
    this._nextAttemptAt = nextAttemptAt;
    this._referenceAttempts = 0;
    this._updatedAt = at;
  }

  /** The reference is still missing: PENDING_REFERENCE -> PENDING_REFERENCE with a later deadline. */
  rescheduleReference(nextAttemptAt: Date, at: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `rescheduleReference requires PENDING_REFERENCE, current status is ${this._status}`,
      );
    }
    this._referenceAttempts += 1;
    this._nextAttemptAt = nextAttemptAt;
    this._updatedAt = at;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money): void {
    this.assertOpen('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertOpen('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /** LOSS records the outcome of a round without moving money. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direction of the ledger entry this transaction produces. ROLLBACK is the inverse of whatever
   * its reference did, so the reference must be supplied for it.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError(
            'ROLLBACK needs its reference to know the direction',
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not produce a ledger entry');
    }
  }

  private assertOpen(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `${operation} is not allowed: transaction ${this.id} is already ${this._status}`,
      );
    }
  }

  /** Snapshot used by repositories. */
  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
      observedBalance: this._observedBalance,
      referenceAttempts: this._referenceAttempts,
      nextAttemptAt: this._nextAttemptAt,
      updatedAt: this._updatedAt,
    };
  }
}
