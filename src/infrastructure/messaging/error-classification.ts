import { TransientInfrastructureError } from '@/application/errors';
import { DomainError } from '@/domain/errors';
import { MessageValidationError } from './message-errors';

export type Disposition = 'PERMANENT' | 'TRANSIENT';

export interface Classification {
  disposition: Disposition;
  reason: string;
}

/**
 * What the consumer does with a failure:
 *  - business outcomes (rejections) never reach here: they are persisted and acknowledged;
 *  - PERMANENT: no retry can succeed (malformed message, unknown wallet, idempotency conflict...)
 *    -> straight to the DLQ so it stays inspectable;
 *  - TRANSIENT: infrastructure hiccups (and anything unknown) -> retry with backoff, DLQ once the
 *    attempt budget is spent.
 */
export function classifyConsumerError(error: unknown): Classification {
  if (error instanceof MessageValidationError)
    return { disposition: 'PERMANENT', reason: 'MALFORMED_MESSAGE' };
  if (error instanceof DomainError) return { disposition: 'PERMANENT', reason: error.code };
  if (error instanceof TransientInfrastructureError)
    return { disposition: 'TRANSIENT', reason: error.reason };
  return { disposition: 'TRANSIENT', reason: 'UNEXPECTED' };
}
