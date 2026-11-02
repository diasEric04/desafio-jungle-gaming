declare const transactionBrand: unique symbol;

/**
 * Opaque handle for the SQL transaction a use case is running in. Only infrastructure knows what is
 * inside; repositories receive it as their first argument so every write joins the same transaction.
 */
export interface Tx {
  readonly [transactionBrand]: true;
}

export interface UnitOfWork {
  /**
   * Runs `work` inside ONE database transaction (commit on success, rollback on throw). It may be
   * executed more than once when the database reports a deadlock / serialization failure, so `work`
   * must keep all its state inside the callback. Infrastructure failures are rethrown as
   * `TransientInfrastructureError`.
   */
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

  /** Read-only access with no explicit transaction (single statements, consistent per statement). */
  read<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}
