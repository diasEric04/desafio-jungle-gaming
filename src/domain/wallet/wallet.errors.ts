import { DomainError } from '../errors';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
  readonly category = 'INVARIANT' as const;

  constructor(walletId: string) {
    super(`Wallet ${walletId} cannot cover this debit`);
  }
}

export class InvalidWalletOperationError extends DomainError {
  readonly code = 'INVALID_WALLET_OPERATION';
  readonly category = 'INVARIANT' as const;

  constructor(message: string) {
    super(message);
  }
}

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';
  readonly category = 'NOT_FOUND' as const;

  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  readonly category = 'CONFLICT' as const;

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';
  readonly category = 'VALIDATION' as const;

  constructor(message: string) {
    super(message);
  }
}
