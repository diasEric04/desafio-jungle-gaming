import { z } from 'zod';
import { hashCanonical } from '@/shared/hashing';
import { MessageValidationError } from './message-errors';
import { idempotencyKeySchema, wagerFieldsSchema } from '@/shared/wager-input-schema';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

const envelopeSchema = z
  .object({
    messageId: z.string().min(1).max(256),
    type: z.literal(WAGER_MESSAGE_TYPE),
    occurredAt: z.string().datetime(),
    data: wagerFieldsSchema.extend({ idempotencyKey: idempotencyKeySchema }),
  })
  .strict();

export type WagerMessageEnvelope = z.infer<typeof envelopeSchema>;

export interface ParsedWagerMessage {
  envelope: WagerMessageEnvelope;
  /** SHA-256 of the canonical envelope; stored in the inbox to detect a reused messageId. */
  payloadHash: string;
}

export function parseWagerMessage(body: string | undefined): ParsedWagerMessage {
  if (!body) throw new MessageValidationError('empty message body');
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new MessageValidationError('message body is not valid JSON');
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new MessageValidationError(
      `invalid message: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
    );
  }
  return { envelope: parsed.data, payloadHash: hashCanonical(parsed.data) };
}
