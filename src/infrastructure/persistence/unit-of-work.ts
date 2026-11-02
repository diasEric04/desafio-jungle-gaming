import type { MikroORM, SqlEntityManager } from '@mikro-orm/postgresql';
import { ConcurrentModificationError, TransientInfrastructureError } from '@/application/errors';
import type { Metrics } from '@/application/ports/metrics';
import type { Logger } from '@/application/ports/services';
import type { Tx, UnitOfWork } from '@/application/ports/transaction';
import { classifyDbError, DbErrorKind, isRetryableInTransaction } from './db-errors';

/** The concrete transaction handle: the forked EntityManager that owns the SQL transaction. */
export class PgTx {
  constructor(readonly em: SqlEntityManager) {}
}

export function emOf(tx: Tx): SqlEntityManager {
  return (tx as unknown as PgTx).em;
}

function toTx(em: SqlEntityManager): Tx {
  return new PgTx(em) as unknown as Tx;
}

export interface UnitOfWorkOptions {
  lockTimeoutMs: number;
  maxRetries: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Transaction boundary. Each call forks the EntityManager (own Identity Map and Unit of Work, so no
 * state leaks between requests), opens `em.transactional()` (READ COMMITTED) and bounds lock waits
 * with `SET LOCAL lock_timeout`.
 *
 *  - deadlock / serialization failure: the database already rolled back; the callback is re-run up to
 *    `maxRetries` times with jitter (counted as lock conflicts + retries);
 *  - lock timeout, connection loss, pool exhaustion: surfaced as TransientInfrastructureError;
 *  - anything else (domain errors, bugs, constraint violations): rethrown untouched.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const lockTimeout = Math.trunc(this.options.lockTimeoutMs);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.orm.em.fork().transactional(async (em) => {
          await em.execute(`SET LOCAL lock_timeout = ${lockTimeout}`, [], 'run');
          return work(toTx(em));
        });
      } catch (error) {
        const kind: DbErrorKind =
          error instanceof ConcurrentModificationError ? 'serialization' : classifyDbError(error);

        if (isRetryableInTransaction(kind) && attempt < this.options.maxRetries) {
          this.metrics.lockConflict(
            error instanceof ConcurrentModificationError ? 'version_conflict' : kind,
          );
          this.metrics.retry('unit_of_work', kind);
          this.logger.warn('transaction aborted by the database, retrying', {
            kind,
            attempt: attempt + 1,
          });
          await sleep(5 + Math.random() * 20 * (attempt + 1));
          continue;
        }
        throw this.translate(error, kind);
      }
    }
  }

  async read<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await work(toTx(this.orm.em.fork()));
    } catch (error) {
      throw this.translate(error, classifyDbError(error));
    }
  }

  private translate(error: unknown, kind: DbErrorKind): unknown {
    if (error instanceof TransientInfrastructureError) return error;
    switch (kind) {
      case 'lock_timeout':
        this.metrics.lockConflict('lock_timeout');
        return new TransientInfrastructureError(
          'timed out waiting for a database lock',
          kind,
          error,
        );
      case 'deadlock':
      case 'serialization':
        this.metrics.lockConflict(kind);
        return new TransientInfrastructureError(
          'database transaction kept conflicting',
          kind,
          error,
        );
      case 'statement_timeout':
      case 'connection':
        return new TransientInfrastructureError('database unavailable', kind, error);
      case 'other':
        return error;
    }
  }
}
