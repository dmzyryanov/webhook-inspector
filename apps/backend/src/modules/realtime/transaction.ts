/**
 * The transaction a writer of the outbox runs in (D221): `BEGIN`, the
 * writer's work, `COMMIT` or `ROLLBACK`, and the readers woken once a
 * `COMMIT` has returned (`committed`). One place for how such a transaction
 * ends, so that a fix to it reaches every writer on it: a capture, a change
 * to what a session answers (its response, queue or rules), a request's
 * deletion, a clear and a session's deletion. A response's completion is
 * one statement that commits on its own, its change and its event together,
 * and needs none (`RECORD_COMPLETION_SQL`, #260).
 *
 * A commit wakes the readers, unless the work says that it appended no event
 * (`wake: false`): a restart or a removal of the queue on a session that held
 * none commits and announces nothing (D205), so it sends no wake-up to every
 * process for nothing. A rollback wakes nobody, unless the work asks for a
 * step after it that appends an event on its own (`afterRollback`): a session
 * deletion that found no session writes its `close` there (D198).
 *
 * A throw - from the work, the `COMMIT`, the `ROLLBACK` or the step after
 * it - is followed by a `ROLLBACK`, wakes nobody and reaches the caller as it
 * was thrown. A connection whose rollback fails as well is released with that
 * failure, so that the pool discards it rather than lend it out again.
 */
import type pg from 'pg';
import { committed } from './events.ts';

/** How the work asks its transaction to end, and what the call then answers. */
export type TransactionEnd<T> =
  | {
      commit: true;
      value: T;
      /**
       * Whether the readers are woken once the `COMMIT` has returned: `true`
       * when absent, `false` for a commit that appended no event.
       */
      wake?: boolean;
    }
  | {
      commit: false;
      value: T;
      /**
       * Run on the same connection once the `ROLLBACK` has returned, outside
       * any transaction, so that each of its statements commits on its own;
       * the readers are woken once it has returned.
       */
      afterRollback?: (client: pg.PoolClient) => Promise<void>;
    };

/**
 * Runs `work` in a transaction of its own on a connection of `pool`, ends it
 * as `work` answers, and answers its value.
 */
export async function inTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<TransactionEnd<T>>,
): Promise<T> {
  const client = await pool.connect();
  /** Set when the rollback itself failed: the connection is then discarded, not reused. */
  let unusable: Error | undefined;

  try {
    await client.query('BEGIN');

    const end = await work(client);

    if (end.commit) {
      await client.query('COMMIT');

      if (end.wake !== false) {
        committed(pool);
      }

      return end.value;
    }

    await client.query('ROLLBACK');

    if (end.afterRollback !== undefined) {
      await end.afterRollback(client);
      committed(pool);
    }

    return end.value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      unusable = rollbackError instanceof Error ? rollbackError : new Error('Rollback failed');
    }

    throw error;
  } finally {
    client.release(unusable);
  }
}
