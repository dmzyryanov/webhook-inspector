import type pg from 'pg';
import { appendEvent, forgetEvents } from '../realtime/events.ts';
import { inTransaction } from '../realtime/transaction.ts';
import type { ListQuery } from './list-query.ts';

/**
 * Every query here answers the session's state and performs the operation in a
 * single statement.
 *
 * Checking the session first and acting afterwards leaves a window in which the
 * session can expire or be removed by the cleanup: a delete could report `204`
 * for a session that had already expired, and a read could report a missing
 * request where the truth was an expired session. D065 closed that window for
 * captures; these routes close it the same way, without locks, because one
 * statement is atomic (D068).
 *
 * `expired` is `null` when the session does not exist at all.
 */

interface SessionState {
  expired: boolean | null;
}

/**
 * The response columns every read joins.
 *
 * `response_state` is `null` when no record exists at all, which is a reading in
 * its own right and means the request predates this release or its record was
 * never written (D109). `response_delay_ms` and `response_started_at` are read
 * on both endpoints but returned by neither: they are only what `unknown` is
 * derived from.
 *
 * All three are nullable because the join is a `LEFT JOIN`: where it matches
 * nothing, every column of the record reads `null`, whatever the table declares.
 */
interface ResponseColumns {
  response_state: string | null;
  response_status: number | null;
  response_delay_ms: number | null;
  response_started_at: Date | null;
  /** The queue's step that answered, both `null` when the session response did (D205). */
  response_queue_step_index: number | null;
  response_queue_step_total: number | null;
  /** The position of the rule that answered, `null` when none did (D246). */
  response_rule_index: number | null;
}

/**
 * A row whose response join matched.
 *
 * `state`, `delay_ms` and `started_at` are `NOT NULL` in `request_responses`, so
 * they are absent together or present together: a non-`null` state means the
 * join found a record and the other two can be read. `status` stays nullable
 * here because it is nullable in the table - a write that failed before a status
 * was composed has none (D109).
 */
export type RecordedRow<T extends ResponseColumns> = T & {
  response_state: string;
  response_delay_ms: number;
  response_started_at: Date;
};

export function hasResponseRecord<T extends ResponseColumns>(row: T): row is RecordedRow<T> {
  return row.response_state !== null;
}

interface ListRow extends SessionState, ResponseColumns {
  id: string | null;
  method: string;
  received_at: Date;
  body_size: number;
  source_ip: string | null;
  /** `null` for a request captured before the column existed (D110). */
  path: string | null;
}

interface DetailRow extends ListRow {
  query_string: string;
  headers: [string, string][];
  body: Buffer;
  raw_request: Buffer;
  http_version: string | null;
  response_headers: [string, string][];
  response_body: Buffer | null;
  response_body_size: number;
  response_body_suppressed: boolean;
  response_raw: Buffer | null;
  response_completed_at: Date | null;
  response_duration_ms: number | null;
  /** What the rule that answered matched on, as it was then (D246). */
  response_rule_method: string | null;
  response_rule_path: string | null;
}

/**
 * What both endpoints need to report a state, and nothing heavier. The list
 * returns `state`, `status`, the queue's step and the rule's position of
 * these; the delay and the start are derivation input (D110, D205, D246).
 */
const RESPONSE_SUMMARY_COLUMNS = `rr.state AS response_state,
            rr.status AS response_status,
            rr.delay_ms AS response_delay_ms,
            rr.started_at AS response_started_at,
            rr.queue_step_index AS response_queue_step_index,
            rr.queue_step_total AS response_queue_step_total,
            rr.rule_index AS response_rule_index`;

export type { DetailRow, ListRow };

export interface SessionScoped<T> {
  expired: boolean | null;
  value: T;
}

/**
 * Where a request stands in receipt order: `received_at` as PostgreSQL stores
 * it, to the microsecond, and the id that breaks ties (D056). JavaScript's
 * `Date` keeps milliseconds only, so the time travels as text, written by the
 * database and read back by it unchanged.
 */
export interface ListPosition {
  /** `received_at` in UTC to the microsecond, such as `2026-10-04T09:00:00.123456Z`. */
  receivedAt: string;
  id: string;
}

/** A listed row and its exact receipt time, which a resumed list starts from. */
export interface ListedRow extends ListRow {
  id: string;
  /** `received_at` in UTC to the microsecond (`ListPosition`). */
  received_exact: string;
}

export interface Listed {
  /**
   * Whether the request `after` names is one of the session's. `true` when no
   * `after` was given; read only while the session is valid.
   */
  afterFound: boolean;
  /** Where the request `after` names stands, read by the same statement; `null` without `after`. */
  afterPosition: ListPosition | null;
  rows: ListedRow[];
}

/**
 * Where a list resumes when requests it chose were gone before their content
 * was read (D196): the requests beyond the last one it chose, in its order,
 * under its conditions, at most as many as the answer still has room for.
 */
export interface ListResume {
  /** Where the request `after` named stood when the list began; `null` without `after`. */
  after: ListPosition | null;
  /** The last request the list chose, whether it is still there or not. */
  beyond: ListPosition;
  /** How many more requests the answer may hold. */
  limit: number;
}

/** What the list statement reads besides the row itself. */
interface ListedResultRow extends ListRow {
  after_found: boolean;
  after_received_exact: string | null;
  after_id: string | null;
  received_exact: string | null;
}

/**
 * `received_at` as text in UTC to the microsecond, which `::timestamptz` reads
 * back exactly whatever the connection's `DateStyle` and `TimeZone`.
 */
function exactTime(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** A row comparison with a position, both bound, never part of the statement's text. */
function positionTerm(position: ListPosition, bind: (value: unknown) => string): string {
  return `(${bind(position.receivedAt)}::timestamptz, ${bind(position.id)}::uuid)`;
}

/** What `include` adds to a listed request, read by `readListedContent` (D196). */
export interface ListedContent {
  /** Read only with `include=headers`. */
  headers?: [string, string][];
  /** Read only with `include=body`. */
  body?: Buffer;
}

/** Anything a statement can run on: the pool, or the client of a transaction. */
type Queryable = Pick<pg.PoolClient, 'query'>;

const ASCII_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ASCII_LOWER = 'abcdefghijklmnopqrstuvwxyz';

/**
 * The requests of a session that `query` asks for (D196), with the session's
 * state, in one statement (D068).
 *
 * Without a parameter this is the list as it always was: every request, newest
 * first, with the id breaking ties so the order is stable when two requests
 * share a timestamp (D056), and no body or header (D037), whatever `include`
 * asks: that content is read by `readListedContent` while the answer is
 * written. The parameters only narrow, cap or reverse the list:
 *
 * - `after` keeps the requests received after the named one in receipt order,
 *   `(received_at, id)` greater than its own, whatever `order` sorts by. The
 *   named request is looked up by this same statement, so its receipt time is
 *   compared at full precision and never travels through JavaScript, which
 *   keeps milliseconds only. When it is not one of the session's - deleted,
 *   evicted, or never one - the answer is `afterFound: false` and no row.
 *   Its position is answered too (`afterPosition`), for a resumed list.
 * - `receivedAfter` keeps the requests whose stored `received_at` is strictly
 *   later, compared at the microsecond (`sinceBound`).
 * - A header condition holds when one of the stored pairs has the name,
 *   compared after folding ASCII letters to lower case and nothing else -
 *   `translate`, not `lower`, which follows the database's locale - and
 *   exactly the value, as the detail returns it.
 * - A body condition holds when the stored body contains its bytes:
 *   `position(... IN body)` on `bytea`, D191's matcher, exact and with no
 *   pattern syntax. The body is the bytes as received, not decoded from any
 *   `Content-Encoding`.
 * - Every condition is a bound parameter, never part of the statement's text.
 *
 * As in the search, an expired session joins no request, so nothing of it is
 * read. The existing index, `requests (session_id, received_at DESC, id DESC)`,
 * serves both orders, `after` and the cap; a session holds at most 1000
 * requests (D006), which bounds what the conditions read. A condition reads
 * the headers and bodies in the database; none of them is returned.
 *
 * With `resume`, the statement lists what follows a list already under way
 * (`list-answer.ts`): the requests beyond `resume.beyond` in the list's
 * order, at most `resume.limit`, under the same conditions, with `after`
 * compared with the position the first statement read for it - the request
 * it names may be gone by now. The answer's status was decided by that first
 * statement, so the session's expiry is not applied again, as the content
 * read does not apply it (`readListedContent`); a session removed meanwhile
 * lists nothing.
 *
 * With `afterAt` and no `resume`, the statement lists as the first one does,
 * the session's state applied, but keeps the requests beyond that position in
 * place of looking up the request `after` names: it is how a list held by
 * `wait` reads again (D200), with `after` resolved once, when the call
 * arrived, so that the request it names being deleted meanwhile changes
 * nothing. `afterFound` is then `true` and `afterPosition` is `afterAt`.
 */
export async function listRequests(
  client: Queryable,
  sessionId: string,
  query: ListQuery,
  resume: ListResume | null = null,
  afterAt: ListPosition | null = null,
): Promise<SessionScoped<Listed>> {
  const values: unknown[] = [sessionId];
  const bind = (value: unknown): string => {
    values.push(value);

    return `$${values.length}`;
  };
  const conditions = ['r.session_id = state.id'];
  let anchor = '';
  let afterFound = 'true';
  let afterColumns = 'NULL::text AS after_received_exact, NULL::uuid AS after_id';

  if (resume !== null) {
    if (resume.after !== null) {
      conditions.push(`(r.received_at, r.id) > ${positionTerm(resume.after, bind)}`);
    }

    conditions.push(
      `(r.received_at, r.id) ${query.order === 'asc' ? '>' : '<'} ${positionTerm(resume.beyond, bind)}`,
    );
  } else {
    conditions.push('NOT state.expired');

    if (afterAt !== null) {
      afterColumns = `${bind(afterAt.receivedAt)}::text AS after_received_exact,
            ${bind(afterAt.id)}::uuid AS after_id`;
      conditions.push(`(r.received_at, r.id) > ${positionTerm(afterAt, bind)}`);
    } else if (query.after !== null) {
      anchor = `, anchor AS (
         SELECT r.received_at, r.id FROM requests r
         WHERE r.session_id = (SELECT id FROM state WHERE NOT expired) AND r.id = ${bind(query.after)}
       )`;
      afterFound = 'EXISTS (SELECT 1 FROM anchor)';
      afterColumns = `(SELECT ${exactTime('a.received_at')} FROM anchor a) AS after_received_exact,
            (SELECT a.id FROM anchor a) AS after_id`;
      conditions.push('(r.received_at, r.id) > (SELECT a.received_at, a.id FROM anchor a)');
    }
  }

  if (query.receivedAfter !== null) {
    conditions.push(`r.received_at > ${bind(query.receivedAfter)}::timestamptz`);
  }

  for (const header of query.headers) {
    conditions.push(`EXISTS (
         SELECT 1 FROM jsonb_array_elements(r.headers) AS h(pair)
         WHERE translate(h.pair ->> 0, '${ASCII_UPPER}', '${ASCII_LOWER}') = ${bind(header.name)}
           AND h.pair ->> 1 = ${bind(header.value)}
       )`);
  }

  for (const bytes of query.bodies) {
    conditions.push(`position(${bind(bytes)}::bytea IN r.body) > 0`);
  }

  const direction = query.order === 'asc' ? 'ASC' : 'DESC';
  const cap = resume === null ? query.limit : resume.limit;
  const limit = cap === null ? '' : `LIMIT ${bind(cap)}`;

  const result = await client.query<ListedResultRow>(
    `WITH state AS (
       SELECT id, expires_at <= clock_timestamp() AS expired FROM sessions WHERE id = $1
     )${anchor}
     SELECT state.expired, ${afterFound} AS after_found, ${afterColumns},
            r.id, r.method, r.received_at, ${exactTime('r.received_at')} AS received_exact,
            r.body_size, r.source_ip, r.path,
            ${RESPONSE_SUMMARY_COLUMNS}
     FROM state
     LEFT JOIN LATERAL (
       SELECT r.id, r.method, r.received_at, r.body_size, r.source_ip, r.path
       FROM requests r
       WHERE ${conditions.join('\n         AND ')}
       ORDER BY r.received_at ${direction}, r.id ${direction}
       ${limit}
     ) r ON true
     LEFT JOIN request_responses rr ON rr.request_id = r.id
     ORDER BY r.received_at ${direction}, r.id ${direction}`,
    values,
  );

  const first = result.rows[0];

  if (!first) {
    return { expired: null, value: { afterFound: false, afterPosition: null, rows: [] } };
  }

  // The one row a session with nothing to list joins is its state alone.
  const rows = result.rows.filter((row): row is ListedResultRow & ListedRow => row.id !== null);
  const afterPosition =
    first.after_received_exact !== null && first.after_id !== null
      ? { receivedAt: first.after_received_exact, id: first.after_id }
      : null;

  return {
    expired: first.expired,
    value: { afterFound: first.after_found, afterPosition, rows },
  };
}

/**
 * The content `include` asks for of requests `listRequests` listed (D196): the
 * headers, the body or both, by request id.
 *
 * The answer's status was decided by the list statement, which read the
 * session's state and the ids (D068). This read only fills in what the answer
 * writes next, a few requests at a time (`list-answer.ts`), so that an answer
 * holds about one request's content however many it lists, instead of every
 * body it will write. A stored request never changes, so what is read is what
 * the list statement would have read. A request gone since - deleted, pushed
 * out by the newest 1000, cleared, or removed with its session, deleted
 * through the API (D198) or by the cleanup - is absent from the map; the
 * answer writes the requests that follow in its place (`listRequests` with
 * `resume`), and none follows once the session is gone. The session's expiry is
 * not read again: the requests were listed while the session was valid, and
 * an answer already under way cannot become a `410`.
 */
export async function readListedContent(
  pool: pg.Pool,
  sessionId: string,
  requestIds: readonly string[],
  include: { headers: boolean; body: boolean },
): Promise<Map<string, ListedContent>> {
  const columns = [...(include.headers ? ['headers'] : []), ...(include.body ? ['body'] : [])];
  const result = await pool.query<ListedContent & { id: string }>(
    `SELECT id${columns.map((column) => `, ${column}`).join('')}
     FROM requests
     WHERE session_id = $1 AND id = ANY($2::uuid[])`,
    [sessionId, requestIds],
  );

  return new Map(result.rows.map(({ id, ...content }) => [id, content]));
}

/**
 * Runs `read` in a read-only transaction of its own whose statements stop
 * after `timeoutMs` (D191).
 *
 * The timeout is set with `set_config(..., true)` - `SET LOCAL` with a bound
 * value - inside this transaction alone, so it ends with the transaction and
 * no other query on the connection inherits it. A statement that runs out of
 * time fails with `query_canceled` (`isStatementCancelled`), and the
 * transaction is rolled back before the connection returns to the pool; a
 * connection whose rollback failed is discarded rather than reused.
 */
async function readWithTimeout<T>(
  pool: pg.Pool,
  timeoutMs: number,
  read: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  /** Set when the rollback itself failed: the connection is then discarded, not reused. */
  let unusable: Error | undefined;

  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);

    const value = await read(client);

    await client.query('COMMIT');

    return value;
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

/**
 * `listRequests` under D191's statement timeout, for the query route, whose
 * header and body conditions may read every stored request of the session
 * (D196).
 */
export function listRequestsWithTimeout(
  pool: pg.Pool,
  sessionId: string,
  query: ListQuery,
  timeoutMs: number,
  resume: ListResume | null = null,
): Promise<SessionScoped<Listed>> {
  return readWithTimeout(pool, timeoutMs, (client) =>
    listRequests(client, sessionId, query, resume),
  );
}

export async function findRequest(
  pool: pg.Pool,
  sessionId: string,
  requestId: string,
): Promise<SessionScoped<DetailRow | undefined>> {
  const result = await pool.query<DetailRow>(
    `SELECT s.expires_at <= clock_timestamp() AS expired,
            r.id, r.method, r.received_at, r.body_size, r.source_ip, r.query_string,
            r.headers, r.body, r.raw_request, r.path, r.http_version,
            ${RESPONSE_SUMMARY_COLUMNS},
            rr.headers AS response_headers,
            rr.body AS response_body,
            rr.body_size AS response_body_size,
            rr.body_suppressed AS response_body_suppressed,
            rr.raw_response AS response_raw,
            rr.completed_at AS response_completed_at,
            rr.duration_ms AS response_duration_ms,
            rr.rule_method AS response_rule_method,
            rr.rule_path AS response_rule_path
     FROM sessions s
     LEFT JOIN requests r ON r.session_id = s.id AND r.id = $2
     LEFT JOIN request_responses rr ON rr.request_id = r.id
     WHERE s.id = $1`,
    [sessionId, requestId],
  );

  const row = result.rows[0];

  if (!row) {
    return { expired: null, value: undefined };
  }

  return { expired: row.expired, value: row.id === null ? undefined : row };
}

/** One request of the session, and which of the searched words its raw request holds. */
export interface SearchRow {
  id: string;
  /** One flag per word, in the order the words were given. */
  found: boolean[];
}

/** `query_canceled`: what a statement stopped by `statement_timeout` raises. */
const QUERY_CANCELED = '57014';

/** Whether an error is PostgreSQL cancelling a statement, as its timeout does. */
export function isStatementCancelled(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === QUERY_CANCELED
  );
}

/**
 * Looks for each word in the raw request of every request of the session
 * (D191): `position(word IN raw_request)`, which on `bytea` is an exact,
 * case-sensitive comparison of bytes with no pattern syntax, so a word needs
 * no escaping and a body that is not UTF-8 is matched byte for byte. The words
 * are bound parameters and never part of the statement's text.
 *
 * One statement reads the session's state and searches (D068): an expired
 * session joins no request, so nothing of it is read. `state` is a CTE so that
 * the expiry is decided once; `clock_timestamp()` is volatile, which also
 * keeps PostgreSQL from inlining it.
 *
 * There is no index: every raw request of the session is read, up to 1000 of
 * them (D006) and up to about 1 MiB each (D008). What bounds that is the
 * statement timeout of `readWithTimeout`, set for its transaction alone.
 *
 * Every request is returned with its flags, matching or not: at most 1000
 * short rows, and each `position` is evaluated exactly once per request.
 */
export async function searchRawRequests(
  pool: pg.Pool,
  sessionId: string,
  words: readonly Buffer[],
  timeoutMs: number,
): Promise<SessionScoped<SearchRow[]>> {
  const flags = words
    .map((_, index) => `position($${index + 2}::bytea IN r.raw_request) > 0`)
    .join(', ');

  return readWithTimeout(pool, timeoutMs, async (client) => {
    const result = await client.query<{
      expired: boolean;
      id: string | null;
      found: (boolean | null)[];
    }>(
      `WITH state AS (
         SELECT id, expires_at <= clock_timestamp() AS expired FROM sessions WHERE id = $1
       )
       SELECT state.expired, r.id, ARRAY[${flags}] AS found
       FROM state
       LEFT JOIN requests r ON r.session_id = state.id AND NOT state.expired
       ORDER BY r.received_at DESC, r.id DESC`,
      [sessionId, ...words],
    );

    const first = result.rows[0];

    if (!first) {
      return { expired: null, value: [] };
    }

    const rows: SearchRow[] = [];

    for (const row of result.rows) {
      if (row.id !== null) {
        rows.push({ id: row.id, found: row.found.map((flag) => flag === true) });
      }
    }

    return { expired: first.expired, value: rows };
  });
}

/**
 * Deletes only while the session is valid: the inner select yields no session
 * id for an expired one, so the delete matches nothing.
 *
 * A deletion that removed the request purges the outbox rows carrying its data
 * and writes its `request.deleted`, in the same transaction (D221): the id as
 * every list row spells it, in lower case - the route accepts a UUID in either
 * case, and an upper-case id would name no row on any viewer. The purge runs
 * after the delete, which waits for a completion's statement holding the
 * request's response record, so it also purges the `response.recorded` that
 * statement wrote.
 */
export async function deleteRequest(
  pool: pg.Pool,
  sessionId: string,
  requestId: string,
): Promise<SessionScoped<boolean>> {
  return inTransaction(pool, async (client) => {
    const result = await client.query<{ expired: boolean | null; removed: number }>(
      `WITH state AS (
         SELECT id, expires_at <= clock_timestamp() AS expired FROM sessions WHERE id = $1
       ), removed AS (
        DELETE FROM requests
        WHERE session_id = (SELECT id FROM state WHERE NOT expired) AND id = $2
        RETURNING id
       )
       SELECT (SELECT expired FROM state) AS expired,
              (SELECT count(*)::int FROM removed) AS removed`,
      [sessionId, requestId],
    );

    const row = result.rows[0];
    const removed = (row?.removed ?? 0) > 0;

    if (removed) {
      await forgetEvents(client, sessionId, { requestId });
      await appendEvent(client, sessionId, {
        type: 'request.deleted',
        data: { id: requestId.toLowerCase() },
      });
    }

    return { commit: removed, value: { expired: row?.expired ?? null, value: removed } };
  });
}

/**
 * Removes the session's requests, and starts its response queue from step 1
 * again if it has one (D205), and announces it, `requests.cleared`, in the
 * same transaction (D221). Nothing else of the session changes.
 *
 * The session row is locked first, by a statement of its own, and only then
 * are the requests deleted: the delete reads the session's requests as they
 * are once the lock is held, so a capture that held the lock first - on this
 * process or another - commits first and its request is deleted with the
 * rest, and its `request.received` is announced before this clear, in lock
 * order (D205 point 12). One that arrives meanwhile waits for the clear. The
 * lock comes first for a second reason: a delete run before it could hold the
 * rows a capture evicts while waiting for the session row that capture holds,
 * a deadlock.
 *
 * The lock is `FOR NO KEY UPDATE`, the one the restart's own `UPDATE` takes:
 * it waits for the `FOR UPDATE` every capture holds while it takes a step and
 * evicts the session's oldest request (D065), and a capture waits for it.
 * Unlike `FOR UPDATE` it does not wait for a `FOR KEY SHARE`, which is what a
 * foreign-key check takes and what holds an expired session against the sweep
 * in the tests (`testing/expired-session.ts`), so a clear is never held by
 * either. Expiry is judged with the lock held, against `clock_timestamp()`.
 *
 * The outbox rows carrying the data of the session's requests are purged
 * after the delete, which waits for any completion's statement holding a
 * response record of the session, so the purge sees what that wrote.
 */
export async function deleteAllRequests(
  pool: pg.Pool,
  sessionId: string,
): Promise<SessionScoped<void>> {
  return inTransaction<SessionScoped<void>>(pool, async (client) => {
    const locked = await client.query<{ expired: boolean }>(
      `SELECT expires_at <= clock_timestamp() AS expired
         FROM sessions WHERE id = $1 FOR NO KEY UPDATE`,
      [sessionId],
    );
    const expired = locked.rows[0]?.expired ?? null;

    if (expired !== false) {
      return { commit: false, value: { expired, value: undefined } };
    }

    await client.query('DELETE FROM requests WHERE session_id = $1', [sessionId]);
    await client.query(
      `UPDATE sessions SET response_queue_answered = 0
        WHERE id = $1 AND response_queue IS NOT NULL`,
      [sessionId],
    );
    await forgetEvents(client, sessionId, { requests: 'all' });
    await appendEvent(client, sessionId, { type: 'requests.cleared' });

    return { commit: true, value: { expired: false, value: undefined } };
  });
}
