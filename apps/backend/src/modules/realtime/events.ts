/**
 * The write side of the realtime outbox (D221): every change a viewer or a
 * wait must hear of writes its event to `realtime_events` in its own
 * transaction, as the last statement before `COMMIT`, and calls `committed`
 * once that `COMMIT` has returned - or, a response's completion, in the very
 * statement that makes the change, which commits on its own, and calls
 * `committed` once that statement has returned (#260). Every backend process on the database
 * reads the rows committed since its last read (`listener.ts`) and delivers
 * them to its own viewers and waits, so a change made by any process reaches
 * the viewers of all of them, its own included.
 *
 * The event is in the database exactly when its change is: a transaction that
 * rolls back after the append leaves no row, so nothing announces a change
 * that did not happen (D075), and a committed change is announced once.
 *
 * Its order is its id. The identity draws ids in the order the inserts run
 * (CACHE 1, the default), and every event that must follow another is
 * inserted after that other committed: under the session row's lock for the
 * changes that move the session's queue and for its deletion (D065, D205
 * point 12, D198), and after its cause for a request's `response.recorded` and
 * `request.deleted`. A reader delivers what it has not seen in id order.
 *
 * Nothing here notifies inside the transaction. PostgreSQL commits every
 * transaction that notifies one at a time, each waiting for its own WAL flush,
 * and doing it in the capture's transaction cost 25 % of a burst's throughput
 * (D221, option C, measured and dropped). The wake-up `committed` sends
 * afterwards is a transaction of its own that writes no WAL before its commit,
 * sent with `synchronous_commit` off, and a lost one costs a reader at most
 * its one-second tick, never an event.
 *
 * Every statement here is parameterised; the channel is this module's
 * constant.
 */
import type pg from 'pg';
import type { ServerEvent } from '@webhook-inspector/shared';

/** The channel every process listens on for wake-ups. A notification on it means "read". */
export const REALTIME_CHANNEL = 'realtime_events';

/**
 * How old, in seconds, an outbox row must be before a process deletes it, and
 * only once its transaction is below the horizon the process read two prunes
 * earlier (`listener.ts`, D221).
 */
export const REALTIME_EVENT_RETENTION_SECONDS = 20;

/**
 * The statement each process deletes old outbox rows with, every 5 s: older
 * than the retention, `$2` seconds, and written by a transaction below `$1`, a horizon the
 * process read at least 10 s earlier - so every transaction below it had
 * committed or rolled back 10 s before, and every process still listening has
 * read its rows since (D221). It answers how many rows it deleted and how many
 * bytes their payloads took on disk, which decides whether the process
 * vacuums the table next (`REALTIME_VACUUM_AFTER_BYTES`).
 *
 * It never waits for a row lock: it locks the rows it is to delete first,
 * `FOR UPDATE SKIP LOCKED`, and deletes only those, so a row a deletion's
 * purge holds (`forgetEvents`, a request deleted 20 s or more after its
 * capture) is left to a later prune rather than waited for. Two statements
 * each waiting for rows the other holds would be a deadlock, which
 * PostgreSQL ends after a second by failing one of them - the prune, or the
 * deletion with a `500` (correction round 3, the Reviewer's question).
 */
export const PRUNE_REALTIME_EVENTS_SQL = `WITH doomed AS MATERIALIZED (
         SELECT id FROM realtime_events
          WHERE created_at < clock_timestamp() - make_interval(secs => $2)
            AND tx < $1::xid8
            FOR UPDATE SKIP LOCKED
       ), pruned AS (
         DELETE FROM realtime_events AS e USING doomed
          WHERE e.id = doomed.id
         RETURNING pg_column_size(e.payload) AS bytes
       )
       SELECT count(*)::int AS rows, coalesce(sum(bytes), 0)::text AS bytes FROM pruned`;

/**
 * A prune that deleted at least this many bytes of payload is followed by a
 * vacuum of the table, `VACUUM_REALTIME_EVENTS_SQL`, from the same process,
 * and so is the prune after it (`listener.ts`, D221 point 9). A deleted row's
 * space, its TOAST chunks above all, can be written again only once a vacuum
 * has passed over it; autovacuum looks at a database once a minute, so a
 * flood of large events would otherwise grow the table by everything written
 * between two of its passes, and by more while each pass takes longer than
 * the last.
 */
export const REALTIME_VACUUM_AFTER_BYTES = 1024 * 1024;

/**
 * The vacuum a large prune is followed by: outside any transaction, as a
 * vacuum must be; at full speed, a manual vacuum having no cost delay; and
 * `SKIP_LOCKED`, so that a process never waits for another one's vacuum, or
 * autovacuum's, of the same table - what one skips, the vacuum after its next
 * prune takes. It covers the table's TOAST table, and gives the empty pages
 * at the end of each back to the disk: `INDEX_CLEANUP ON`, because a vacuum
 * that finds few dead rows otherwise leaves their line pointers in place, and
 * a page holding one is not empty, so a table emptied after a flood kept its
 * size.
 */
export const VACUUM_REALTIME_EVENTS_SQL = 'VACUUM (SKIP_LOCKED, INDEX_CLEANUP ON) realtime_events';

/** The events a change writes: the wire events viewers receive, and a deletion's close. */
export type OutboxEvent = Exclude<ServerEvent, { type: 'ready' }> | { type: 'close' };

/** What runs one statement: the pool, or a client inside a transaction. */
type Executor = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/**
 * The append: one plain insert, `tx` and `created_at` filled by their
 * defaults. The row's shape is a contract between the images that serve at
 * once during a rollout (D221).
 */
export const APPEND_EVENT_SQL = `INSERT INTO realtime_events (session_id, request_id, kind, payload)
       VALUES ($1, $2::uuid, $3, $4)`;

/**
 * Writes one event of `sessionId` in the transaction `executor` is in - at
 * once, on the pool. `requestId` names the request whose captured data the
 * event carries, `request.received` and `response.recorded`, so that deleting
 * that request purges it (`forgetEvents`); it is `null` for every other event.
 *
 * No savepoint around it: it fails with its transaction and commits with it.
 * The caller calls `committed` once the transaction has committed.
 */
export async function appendEvent(
  executor: Executor,
  sessionId: string,
  event: OutboxEvent,
  requestId: string | null = null,
): Promise<void> {
  await executor.query(APPEND_EVENT_SQL, [
    sessionId,
    requestId,
    event.type,
    event.type === 'close' ? null : JSON.stringify(event),
  ]);
}

/** What `committed` asks of the process's listener. */
export interface CommitObserver {
  /**
   * Read the outbox: at the end of a short window that the commits after
   * this one join (`COALESCE_MS`, #260), or once more after the read under
   * way.
   */
  poke(): void;
  /** Tell the other processes to read: one wake-up for the commits of a window, coalesced. */
  wake(): void;
}

/**
 * The listeners of the process a pool belongs to, kept on the pool itself
 * under a symbol, so that a test's proxy of the pool, which forwards every
 * property, finds them too. A process has one; two test instances have two
 * pools, and a test that builds a second instance on a proxy of the first
 * one's pool has two on one.
 */
const OBSERVERS = Symbol('realtime outbox observers');

function observersOf(pool: object): Set<CommitObserver> {
  const holder = pool as Record<symbol, Set<CommitObserver> | undefined>;
  let observers = holder[OBSERVERS];

  if (observers === undefined) {
    observers = new Set();
    holder[OBSERVERS] = observers;
  }

  return observers;
}

/** Names a listener `committed` reaches for `pool`, or, with `false`, forgets it. */
export function observeCommits(pool: object, observer: CommitObserver, observe = true): void {
  if (observe) {
    observersOf(pool).add(observer);
  } else {
    observersOf(pool).delete(observer);
  }
}

/**
 * Called once a transaction that appended an event has committed: the
 * process's listener reads, and the other processes are woken - once,
 * however many listeners share the pool, and for every commit inside one
 * window of the listener's, once (#260). Never fails and never waits: a
 * process with no listener, or a call that is missed, leaves the event to the
 * next one-second read.
 */
export function committed(pool: object): void {
  let woken = false;

  for (const observer of observersOf(pool)) {
    observer.poke();

    if (!woken) {
      observer.wake();
      woken = true;
    }
  }
}

/**
 * What a deletion purges of the outbox (D221, `/privacy`'s "until you delete
 * it"): the events carrying one request's data, those carrying the data of
 * any request of the session, or every event of the session.
 */
export type ForgottenEvents = { requestId: string } | { requests: 'all' } | { session: 'all' };

/**
 * Removes the payloads a deletion takes with it, in the deletion's own
 * transaction, so they go when its rows go. The rows stay, with no payload,
 * until the prune removes them: a reader that wanted one then knows a
 * deletion took it (and the deletion's own event follows), where a row gone
 * altogether is a lost channel (D221).
 *
 * Run after the deletion's own statements, which wait for a capture's
 * transaction or a completion's statement holding the rows they delete: this
 * statement then sees what that transaction or statement appended.
 */
export async function forgetEvents(
  executor: Executor,
  sessionId: string,
  forgotten: ForgottenEvents,
): Promise<void> {
  if ('requestId' in forgotten) {
    await executor.query(
      `UPDATE realtime_events SET payload = NULL
        WHERE session_id = $1 AND request_id = $2::uuid AND payload IS NOT NULL`,
      [sessionId, forgotten.requestId],
    );

    return;
  }

  await executor.query(
    'requests' in forgotten
      ? `UPDATE realtime_events SET payload = NULL
          WHERE session_id = $1 AND request_id IS NOT NULL AND payload IS NOT NULL`
      : `UPDATE realtime_events SET payload = NULL
          WHERE session_id = $1 AND payload IS NOT NULL`,
    [sessionId],
  );
}
