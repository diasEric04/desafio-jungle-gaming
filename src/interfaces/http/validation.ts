import type { ZodTypeAny, z } from 'zod';

export class RequestValidationError extends Error {
  constructor(
    message: string,
    public readonly details: ReadonlyArray<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export function parseOrThrow<S extends ZodTypeAny>(
  schema: S,
  value: unknown,
  what: string,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data as z.infer<S>;
  throw new RequestValidationError(
    `invalid ${what}`,
    result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}
