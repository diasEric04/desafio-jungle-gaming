import { z } from 'zod';

/** Kinds a provider may submit. OPENING is internal and intentionally absent. */
export const SUBMITTABLE_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

const identifier = (max = 128) => z.string().min(1).max(max);

export const moneySchema = z
  .object({ amount: z.string().min(1).max(40), currency: z.string().length(3) })
  .strict();

/** Business fields of a submission (shared by the HTTP body and the SQS message `data`). */
export const wagerFieldsSchema = z
  .object({
    providerId: identifier(64),
    externalTransactionId: identifier(),
    playerId: z.string().uuid(),
    walletId: z.string().uuid(),
    roundId: identifier(),
    gameId: identifier(),
    kind: z.enum(SUBMITTABLE_KINDS),
    money: moneySchema,
    referenceExternalTransactionId: identifier().optional(),
  })
  .strict();

export type WagerFields = z.infer<typeof wagerFieldsSchema>;

export const idempotencyKeySchema = z.string().min(1).max(256);
