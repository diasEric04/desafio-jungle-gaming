import { describe, expect, test } from 'bun:test';
import { TransientInfrastructureError } from '@/application/errors';
import { InvalidMoneyError } from '@/domain/money/money';
import { IdempotencyConflictError } from '@/domain/wagering/wagering.errors';
import { WalletNotFoundError } from '@/domain/wallet/wallet.errors';
import { classifyConsumerError } from '@/infrastructure/messaging/error-classification';
import { MessageValidationError } from '@/infrastructure/messaging/message-errors';

describe('classifyConsumerError', () => {
  test('malformed and domain errors are permanent (DLQ)', () => {
    expect(classifyConsumerError(new MessageValidationError('x'))).toEqual({
      disposition: 'PERMANENT',
      reason: 'MALFORMED_MESSAGE',
    });
    expect(classifyConsumerError(new InvalidMoneyError('x')).disposition).toBe('PERMANENT');
    expect(classifyConsumerError(new WalletNotFoundError('w'))).toEqual({
      disposition: 'PERMANENT',
      reason: 'WALLET_NOT_FOUND',
    });
    expect(classifyConsumerError(new IdempotencyConflictError('k')).reason).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
  });

  test('infrastructure and unknown errors are transient (retry with backoff)', () => {
    expect(classifyConsumerError(new TransientInfrastructureError('db', 'connection'))).toEqual({
      disposition: 'TRANSIENT',
      reason: 'connection',
    });
    expect(classifyConsumerError(new Error('???'))).toEqual({
      disposition: 'TRANSIENT',
      reason: 'UNEXPECTED',
    });
  });
});
