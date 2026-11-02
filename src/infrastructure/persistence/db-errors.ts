export type DbErrorKind =
  | 'deadlock'
  | 'serialization'
  | 'lock_timeout'
  | 'statement_timeout'
  | 'connection'
  | 'other';

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  driverError?: unknown;
  previous?: unknown;
};

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
const CONNECTION_MESSAGE =
  /connection terminated|connection refused|timeout (exceeded|acquiring)|too many clients|the database system is (starting up|shutting down)|server closed the connection/i;

function* chain(error: unknown): Generator<ErrorLike> {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const item = current as ErrorLike;
    yield item;
    current = item.cause ?? item.driverError ?? item.previous;
  }
}

/** Classifies a driver/ORM error by PostgreSQL SQLSTATE (and a few well-known Node/pool messages). */
export function classifyDbError(error: unknown): DbErrorKind {
  for (const item of chain(error)) {
    const code = typeof item.code === 'string' ? item.code : undefined;
    if (code === '40P01') return 'deadlock';
    if (code === '40001') return 'serialization';
    if (code === '55P03') return 'lock_timeout';
    if (code === '57014') return 'statement_timeout';
    if (
      code &&
      (code.startsWith('08') || code.startsWith('53') || ['57P01', '57P02', '57P03'].includes(code))
    ) {
      return 'connection';
    }
    if (code && TRANSIENT_NODE_CODES.has(code)) return 'connection';
  }
  for (const item of chain(error)) {
    if (typeof item.message === 'string' && CONNECTION_MESSAGE.test(item.message))
      return 'connection';
  }
  return 'other';
}

/** Kinds worth re-running the whole transaction for (the database aborted it, nothing was applied). */
export function isRetryableInTransaction(kind: DbErrorKind): boolean {
  return kind === 'deadlock' || kind === 'serialization';
}
