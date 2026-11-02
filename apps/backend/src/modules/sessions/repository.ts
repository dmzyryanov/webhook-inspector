import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import {
  SESSION_ID_ALPHABET,
  SESSION_ID_LENGTH,
  SESSION_IDLE_WINDOW_MAX_SECONDS,
  type ResponseConfig,
  type ResponseQueue,
  type ResponseRule,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { appendEvent, forgetEvents } from '../realtime/events.ts';
import { inTransaction, type TransactionEnd } from '../realtime/transaction.ts';
import { opens, type PresentedKey } from './access-key.ts';

export interface SessionRow extends SessionResponseState {
  id: string;
  expiresAt: Date;
  expired: boolean;
  /**
   * The idle window the session slides by, in seconds, or `null` for a
   * session created with a lifetime, which never slides (D220, D242).
   */
  idleSeconds: number | null;
  /** The fixed end of a session created with a lifetime, or `null` (D220). */
  lifetimeEndsAt: Date | null;
  /**
   * Whether the session's captures keep the sender's address (D243): `false`
   * for a session created with `storeSourceIp: false`, `true` for every other,
   * those created before the column existed included.
   */
  storeSourceIp: boolean;
  /**
   * Whether the session carries an access key's fingerprint (D245, D253):
   * `access_key_hash IS NOT NULL`, set at creation only. Never the
   * fingerprint itself, which only the check reads.
   */
  private: boolean;
}

/** The two columns that say which rule a session expires by (D220, D242). */
export interface ExpiryRuleColumns {
  idle_seconds: number;
  lifetime_ends_at: Date | null;
}

/**
 * The rule as the API reports it: a session with a lifetime has no window,
 * whatever `idle_seconds` holds - the default, which it never slides by.
 */
function toExpiryRule(
  columns: ExpiryRuleColumns,
): Pick<SessionRow, 'idleSeconds' | 'lifetimeEndsAt'> {
  return columns.lifetime_ends_at === null
    ? { idleSeconds: columns.idle_seconds, lifetimeEndsAt: null }
    : { idleSeconds: null, lifetimeEndsAt: columns.lifetime_ends_at };
}

/** The six response columns, as every read path selects them. */
export interface ResponseConfigColumns {
  response_status: number | null;
  response_headers: [string, string][];
  response_body: string | null;
  response_delay_ms: number;
  response_custom_disabled: boolean;
  response_template: boolean;
}

/**
 * The response columns as they are read everywhere, the capture path included.
 *
 * `response_status IS NOT NULL` says a custom response is saved on the
 * session; `response_custom_disabled` says whether it is the one answering
 * (D151, amending D102). The COALESCE calls are defensive, so that a row
 * missing a value still reads as a complete configuration rather than as a
 * broken one - and `response_template`'s is the rule: `NULL`, which every
 * session the previous image wrote holds, is no template (D251).
 */
export const RESPONSE_COLUMNS = `response_status,
            COALESCE(response_headers, '[]'::jsonb) AS response_headers,
            response_body,
            COALESCE(response_delay_ms, 0) AS response_delay_ms,
            COALESCE(response_custom_disabled, false) AS response_custom_disabled,
            COALESCE(response_template, false) AS response_template`;

/**
 * The custom response saved on the session, whether or not it is answering,
 * or `null` when the session has never had one.
 */
export function toCustomResponse(columns: ResponseConfigColumns): ResponseConfig | null {
  if (columns.response_status === null) {
    return null;
  }

  return {
    status: columns.response_status,
    headers: columns.response_headers,
    body: columns.response_body,
    delayMs: columns.response_delay_ms,
    template: columns.response_template,
  };
}

/**
 * The response the session answers with, or `null` when it answers the
 * default: a saved custom response that is not disabled (D151).
 *
 * The capture path composes every reply from this, so a session switched to
 * the default answers the default by its mode, whatever custom response it
 * keeps.
 */
export function toResponseConfig(columns: ResponseConfigColumns): ResponseConfig | null {
  return columns.response_custom_disabled ? null : toCustomResponse(columns);
}

/**
 * The two queue columns (D205): the steps as stored, and how many of them have
 * answered a request since the queue was last started. Both are `NULL` exactly
 * when the session has no queue, which a constraint of migration 010 holds.
 */
export interface QueueColumns {
  response_queue: unknown;
  response_queue_answered: number | null;
}

/**
 * The queue columns as the session read, the changes and their answers select
 * them. The capture path does not: it reads the one step it needs, never the
 * whole queue (`webhook/repository.ts`).
 */
export const QUEUE_COLUMNS = 'response_queue, response_queue_answered';

/**
 * The rules column (D246): the rules as stored, `NULL` when the session has
 * none, which is how an empty list is saved (migration 017).
 */
export interface RulesColumns {
  response_rules: unknown;
}

/**
 * The rules column as the session read, the changes and their answers select
 * it. The capture path does not: it matches the rules in its locking
 * statement and reads only the one that matched (`webhook/repository.ts`).
 */
export const RULES_COLUMNS = 'response_rules';

/** Everything a response state is read from. */
export type ResponseStateColumns = ResponseConfigColumns & QueueColumns & RulesColumns;

/** What every change returns: the columns of the whole response state. */
const STATE_RETURNING = `RETURNING ${RESPONSE_COLUMNS}, ${QUEUE_COLUMNS}, ${RULES_COLUMNS}`;

/** Every reading at once, as the API and `session.updated` carry them. */
export function toResponseState(columns: ResponseStateColumns): SessionResponseState {
  return {
    response: toResponseConfig(columns),
    customResponse: toCustomResponse(columns),
    queue: toResponseQueue(columns),
    rules: toResponseRules(columns),
  };
}

/**
 * A step as the API answers it, whatever order or form the stored object takes:
 * JSONB keeps its keys in an order of its own, and every field is carried at
 * its effective value, as `response` is (D101). Defensive like the COALESCE
 * calls above, so a stored step missing a value still reads as a complete
 * response rather than as a broken one.
 */
export function toQueueStep(stored: unknown): ResponseConfig {
  const step = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<
    string,
    unknown
  >;

  return {
    status: typeof step.status === 'number' ? step.status : 200,
    headers: Array.isArray(step.headers) ? (step.headers as [string, string][]) : [],
    body: typeof step.body === 'string' ? step.body : null,
    delayMs: typeof step.delayMs === 'number' ? step.delayMs : 0,
    // Only `true` is a template: a step or rule the previous image stored
    // has no such key, and is none (D251).
    template: step.template === true,
  };
}

/**
 * The queue the columns hold, or `null` when there is none (D205). `next` is
 * the step the next captured request gets, or `null` once every step has
 * answered and the session response answers again.
 */
export function toResponseQueue(columns: QueueColumns): ResponseQueue | null {
  if (!Array.isArray(columns.response_queue)) {
    return null;
  }

  const steps = columns.response_queue.map(toQueueStep);
  const answered = columns.response_queue_answered ?? 0;

  return {
    steps,
    next: answered < steps.length ? answered + 1 : null,
    total: steps.length,
  };
}

/**
 * A rule as the API answers it (D246), its response read as a step is
 * (`toQueueStep`): every field at its effective value, whatever order the
 * stored object's keys take, and a stored rule missing one read as a complete
 * rule rather than as a broken one.
 */
export function toResponseRule(stored: unknown): ResponseRule {
  const rule = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<
    string,
    unknown
  >;

  return {
    method: typeof rule.method === 'string' ? rule.method : null,
    path: typeof rule.path === 'string' ? rule.path : '/',
    response: toQueueStep(rule.response),
  };
}

/** The rules the column holds, in their order, `[]` when there are none (D246). */
export function toResponseRules(columns: RulesColumns): ResponseRule[] {
  return Array.isArray(columns.response_rules) ? columns.response_rules.map(toResponseRule) : [];
}

/** A string through UTF-8 and back: a lone surrogate becomes U+FFFD (`serializeQueue`). */
function utf8(text: string): string {
  return Buffer.from(text, 'utf8').toString('utf8');
}

/**
 * One response as stored in `jsonb`, in the order `ResponseConfig` names its
 * fields, `template` a key of its own (D251).
 */
function storedResponse(response: ResponseConfig): ResponseConfig {
  return {
    status: response.status,
    headers: response.headers.map(([name, value]): [string, string] => [utf8(name), utf8(value)]),
    body: response.body === null ? null : utf8(response.body),
    delayMs: response.delayMs,
    template: response.template,
  };
}

/**
 * The text the rules are stored as (D246), or `null` for none: a JSON array
 * of `{"method", "path", "response"}`, the response written as a queue's
 * step is, and every string through UTF-8 first, as `serializeQueue` does.
 * The method is one of the receiver's, plain ASCII.
 */
export function serializeRules(rules: readonly ResponseRule[]): string | null {
  if (rules.length === 0) {
    return null;
  }

  return JSON.stringify(
    rules.map((rule) => ({
      method: rule.method,
      path: utf8(rule.path),
      response: storedResponse(rule.response),
    })),
  );
}

/**
 * The text a queue is stored as: a JSON array of the steps, each at its
 * effective values, in the order `ResponseConfig` names its fields.
 *
 * Each string goes through UTF-8 and back first. JSON would write a lone
 * surrogate as a `\ud800` escape, which PostgreSQL's `jsonb` refuses; the
 * text columns of the session response receive it as U+FFFD, the driver
 * encoding every string to UTF-8, so the queue stores what they store. The
 * body's size limit already counts such a character as those three bytes
 * (D101).
 */
export function serializeQueue(steps: readonly ResponseConfig[]): string {
  return JSON.stringify(steps.map(storedResponse));
}

/**
 * Bytes below this value are used and the rest discarded. 248 is the largest
 * multiple of 62 a byte can hold, 4 × 62, so each of the 62 symbols is reached
 * by exactly four byte values. Folding all 256 values with `% 62` instead would
 * give the first eight symbols five values each, and make them likelier.
 */
export const SESSION_ID_BYTE_LIMIT =
  Math.floor(256 / SESSION_ID_ALPHABET.length) * SESSION_ID_ALPHABET.length;

/** The symbol a random byte stands for, or `undefined` for a byte to discard (D161). */
export function sessionIdSymbol(byte: number): string | undefined {
  return byte < SESSION_ID_BYTE_LIMIT
    ? SESSION_ID_ALPHABET[byte % SESSION_ID_ALPHABET.length]
    : undefined;
}

/**
 * A new session id: `SESSION_ID_LENGTH` symbols of `SESSION_ID_ALPHABET` drawn
 * from cryptographically secure random bytes, about 256 bits as D004 asks, and
 * never an `_` or a `-` (D161).
 *
 * Rejection sampling keeps every symbol equally likely: a byte of 248 or more
 * is discarded rather than folded onto the alphabet, and more bytes are drawn
 * until the id is complete. About one byte in 32 is discarded.
 *
 * `random` is replaced only by the tests, which feed it chosen bytes.
 */
export function generateSessionId(random: (size: number) => Uint8Array = randomBytes): string {
  let id = '';

  while (id.length < SESSION_ID_LENGTH) {
    for (const byte of random(SESSION_ID_LENGTH - id.length)) {
      id += sessionIdSymbol(byte) ?? '';
    }
  }

  return id;
}

/**
 * Expiration is computed by PostgreSQL rather than by the application so that a
 * clock difference between the two cannot shift a session's lifetime.
 *
 * A custom session writes all four configuration columns explicitly, including
 * the effective defaults, so that `response_status IS NULL` stays what tells a
 * session that has never had a custom response (D102). `response_custom_disabled`
 * is left to its default, `false`, which is what makes a session created by
 * either image read the same way (D151).
 *
 * A queue given at creation is written with nothing answered yet, so the first
 * request gets its first step (D205); without one both queue columns stay
 * `NULL`, which is also what a session the previous image creates reads as.
 *
 * A lifetime given at creation, `lifetimeSeconds`, sets both ends of the
 * session to that many seconds from `now()`: `expires_at`, which every check
 * reads, and `lifetime_ends_at`, which keeps the refresh from moving it and,
 * by a constraint, keeps `expires_at` from ever passing it (D220). Without
 * one `make_interval` - strict, so `NULL` in gives `NULL` out - leaves
 * `lifetime_ends_at` `NULL` and the expiry the idle window.
 *
 * The idle window, `idleSeconds`, is stored in `idle_seconds`, which every
 * refresh slides the session by and a trigger holds every writer to (D242):
 * `SESSION_IDLE_WINDOW_MAX_SECONDS`, the 7 days of D133, unless the creation
 * asked for a shorter one. A session with a lifetime is given the default,
 * which it never slides by. The window is added in seconds, an exact interval
 * in any time zone, where the 7 days used to be added as calendar days.
 *
 * `storeSourceIp` is stored in `store_source_ip`, which the capture reads under
 * the session row's lock and a trigger holds every writer of a request to
 * (D243): `true`, the column's default, unless the creation turned it off.
 *
 * Rules given at creation are stored in `response_rules`, `NULL` for none
 * (D246), so a session created without them reads as one the previous image
 * creates.
 *
 * Whether the custom response's body is a template is stored in
 * `response_template` beside it (D251), and `NULL` for a default session, as
 * every other response column is; read as `false` either way.
 *
 * A private session's `accessKeyHash`, the SHA-256 fingerprint of its access
 * key, is stored in `access_key_hash`, `NULL` for a public session (D245,
 * D253). The key itself is never given to this function.
 */
export async function insertSession(
  pool: pg.Pool,
  id: string,
  response: ResponseConfig | null,
  queue: readonly ResponseConfig[] | null = null,
  lifetimeSeconds: number | null = null,
  idleSeconds: number = SESSION_IDLE_WINDOW_MAX_SECONDS,
  storeSourceIp = true,
  rules: readonly ResponseRule[] = [],
  accessKeyHash: Buffer | null = null,
): Promise<SessionRow> {
  const idleWindow = lifetimeSeconds === null ? idleSeconds : SESSION_IDLE_WINDOW_MAX_SECONDS;
  const result = await pool.query<
    { id: string; expires_at: Date; store_source_ip: boolean } & QueueColumns & RulesColumns
  >(
    `INSERT INTO sessions
       (id, expires_at, lifetime_ends_at, idle_seconds, response_status, response_headers,
        response_body, response_delay_ms, response_queue, response_queue_answered,
        store_source_ip, response_rules, response_template, access_key_hash)
     VALUES ($1,
             COALESCE(now() + make_interval(secs => $9), now() + make_interval(secs => $2::integer)),
             now() + make_interval(secs => $9),
             $2::integer,
             $3, $4::jsonb, $5, $6, $7::jsonb, $8, $10, $11::jsonb, $12, $13)
     RETURNING id, expires_at, store_source_ip, ${QUEUE_COLUMNS}, ${RULES_COLUMNS}`,
    [
      id,
      idleWindow,
      response?.status ?? null,
      response ? JSON.stringify(response.headers) : null,
      response?.body ?? null,
      response?.delayMs ?? null,
      queue ? serializeQueue(queue) : null,
      queue ? 0 : null,
      lifetimeSeconds,
      storeSourceIp,
      serializeRules(rules),
      response?.template ?? null,
      accessKeyHash,
    ],
  );

  const row = result.rows[0];

  if (!row) {
    throw new Error('Inserting a session returned no row');
  }

  return {
    id: row.id,
    expiresAt: row.expires_at,
    expired: false,
    idleSeconds: lifetimeSeconds === null ? idleWindow : null,
    lifetimeEndsAt: lifetimeSeconds === null ? null : row.expires_at,
    storeSourceIp: row.store_source_ip,
    private: accessKeyHash !== null,
    response,
    customResponse: response,
    queue: toResponseQueue(row),
    rules: toResponseRules(row),
  };
}

/**
 * Returns the session together with the verdict on its expiration, evaluated by
 * the database. `expires_at` is authoritative regardless of whether the
 * scheduled cleanup has physically removed the row yet (D019).
 *
 * Expiration is always judged against `clock_timestamp()`, never `now()`, which
 * PostgreSQL fixes at the start of the transaction (D065).
 *
 * Everything the session answers with is read here, its whole queue and its
 * rules included, so a caller reads it only once `sessionAccess` has found
 * the session open (D245): a refusal must cost no more than a missing
 * session's.
 */
export async function findSession(pool: pg.Pool, id: string): Promise<SessionRow | undefined> {
  const result = await pool.query<
    {
      id: string;
      expires_at: Date;
      expired: boolean;
      store_source_ip: boolean;
      private: boolean;
    } & ExpiryRuleColumns &
      ResponseStateColumns
  >(
    `SELECT id, expires_at, expires_at <= clock_timestamp() AS expired,
            idle_seconds, lifetime_ends_at, store_source_ip,
            access_key_hash IS NOT NULL AS private,
            ${RESPONSE_COLUMNS},
            ${QUEUE_COLUMNS},
            ${RULES_COLUMNS}
     FROM sessions
     WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];

  return row
    ? {
        id: row.id,
        expiresAt: row.expires_at,
        expired: row.expired,
        ...toExpiryRule(row),
        storeSourceIp: row.store_source_ip,
        private: row.private,
        ...toResponseState(row),
      }
    : undefined;
}

/**
 * Whatever a refresh may run on: the pool, or the client already inside the
 * capture transaction. Both paths run the same statement, so it is written once.
 */
type SqlExecutor = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/**
 * Whether a refresh of a session row would write: the conditions of
 * `REFRESH_SESSION_EXPIRY_SQL` but its id, below, as one boolean expression
 * over the row's columns and the clock as it is read. The capture reads it
 * once it holds the row's lock and runs the refresh only when it is true
 * (#260); written once, for both, so that the two cannot drift apart.
 */
export const REFRESH_DUE_SQL = `expires_at > clock_timestamp()
        AND expires_at < clock_timestamp() + make_interval(secs => idle_seconds)
                         - least(interval '1 hour', make_interval(secs => idle_seconds / 10))
        AND lifetime_ends_at IS NULL`;

/**
 * The one statement that moves a session's expiry, exported so that a test can
 * recognise it exactly rather than by matching on its text (D133).
 *
 * Four conditions carry the whole rule, and the row carries the window
 * (`idle_seconds`, D242), so the statement takes the session id alone:
 *
 * - `id = $1` alone would be enough to write, so the other three are what make
 *   the statement safe to run on the hot capture path;
 * - `expires_at > clock_timestamp()` means an expired session is never revived.
 *   Expiry is authoritative from the column (D019) whether or not the scheduled
 *   cleanup has removed the row yet, and it is judged against real time rather
 *   than the transaction's start time (D065);
 * - `expires_at < clock_timestamp() + the window - the throttle` is the
 *   throttle. A session refreshed within the throttle already has more than
 *   the window minus the throttle left, so the statement matches nothing and
 *   writes nothing. The throttle is an hour, or a tenth of a window shorter
 *   than 10 hours - 6 minutes for a 1-hour window, so that a use every 10
 *   minutes keeps such a session alive (D242). It needs no column of its own
 *   and no memory outside the row it protects. Uses at once write once: a
 *   refresh that waited on the row's lock re-reads the row the first one
 *   wrote, which the throttle then leaves alone;
 * - `lifetime_ends_at IS NULL` leaves a session created with a lifetime where
 *   it is: its expiry is the fixed end of that lifetime, and no use moves it
 *   (D220). A refresh by an image without this condition is refused by the
 *   constraint `sessions_lifetime_cap` instead, and the savepoint below turns
 *   that into "keeps its previous expiry".
 *
 * The window is added in seconds, an exact interval in any time zone. The
 * trigger `sessions_idle_window_cap` (migration 013) caps whatever a writer
 * sets at a full window from now, which this statement never passes; it is
 * there for the previous image, whose refresh slides every session 7 days.
 *
 * The last three conditions are `REFRESH_DUE_SQL`, above. A capture that read
 * it true runs this statement, which judges them again and decides what is
 * written: a session that expired in between is not revived.
 */
export const REFRESH_SESSION_EXPIRY_SQL = `UPDATE sessions
        SET expires_at = clock_timestamp() + make_interval(secs => idle_seconds)
      WHERE id = $1
        AND ${REFRESH_DUE_SQL}
  RETURNING expires_at`;

/**
 * Moves a session's expiry to a full window from now, unless the throttle or
 * the expiry guard above says nothing should be written.
 *
 * Returns the new expiration when the row was written and `undefined` when it
 * was not, so a caller that reports `expiresAt` reports what the row now holds
 * instead of the value it read a statement earlier.
 */
export async function refreshSessionExpiry(
  executor: SqlExecutor,
  id: string,
): Promise<Date | undefined> {
  const result = await executor.query<{ expires_at: Date }>(REFRESH_SESSION_EXPIRY_SQL, [id]);

  return result.rows[0]?.expires_at;
}

/**
 * The little the backend needs from a logger to report a failed refresh: the
 * shape both `app.log` and `request.log` already have.
 */
export interface RefreshLogger {
  warn: (details: object, message: string) => void;
}

/**
 * At most one warning a minute, across both refresh paths and all sessions:
 * one module-level instant, shared by whoever reports next.
 */
const REFRESH_WARNING_INTERVAL_MS = 60_000;

let lastRefreshWarningAt = 0;

/**
 * Forgets the last warning.
 *
 * Exists for the tests, and is called by nothing else: the throttle is process
 * state, so a test asserting that a warning was emitted would otherwise be
 * silenced by an unrelated failure reported in the same minute, and would fail
 * saying nothing about its own subject.
 */
export function resetRefreshWarningThrottle(): void {
  lastRefreshWarningAt = 0;
}

/**
 * Reports a refresh that failed, at most once a minute.
 *
 * A failed refresh is deliberately not an error for the caller (D133): a
 * capture is committed and answered regardless, and a page load is served
 * regardless. But a refresh failing *systematically* would quietly shorten
 * every session back to a fixed window, with nothing anywhere to say so, so one
 * line a minute is the signal - rate-limited because the capture path is hot
 * and a per-request line would be the sustained write the throttle exists to
 * avoid.
 *
 * It cannot throw. It is called from inside the capture transaction, where a
 * throw would be exactly the failure the savepoint was added to prevent, so
 * even a logger that misbehaves is swallowed here. The session id is truncated
 * as everything else in the log is (D059).
 */
export function reportRefreshFailure(
  error: unknown,
  sessionId: string,
  logger?: RefreshLogger,
): void {
  try {
    const now = Date.now();

    if (now - lastRefreshWarningAt < REFRESH_WARNING_INTERVAL_MS) {
      return;
    }

    lastRefreshWarningAt = now;

    logger?.warn(
      {
        session: sessionId.slice(0, 8),
        reason: error instanceof Error ? error.message : String(error),
      },
      'session expiry refresh failed; the session keeps its previous expiry',
    );
  } catch {
    // Reporting a failure may not become one.
  }
}

/**
 * Slides a session's expiry from inside a transaction that already holds its
 * row `FOR UPDATE`, without ever deciding the transaction's fate (D133).
 *
 * A statement that fails inside a transaction aborts the whole of it in
 * PostgreSQL, and a `COMMIT` sent on an aborted transaction silently rolls
 * back. So the refresh runs inside `SAVEPOINT refresh_expiry`, its failure is
 * rolled back to that savepoint and reported, and the transaction is usable
 * again: a capture is still stored and a response change still saved. The
 * capture and the response change both call this, last, once their own writes
 * are in.
 */
export async function refreshExpiryInTransaction(
  client: pg.PoolClient,
  sessionId: string,
  logger?: RefreshLogger,
): Promise<void> {
  try {
    await client.query('SAVEPOINT refresh_expiry');
    await refreshSessionExpiry(client, sessionId);
    await client.query('RELEASE SAVEPOINT refresh_expiry');
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT refresh_expiry');
    } catch {
      // The connection itself is gone rather than the statement having
      // failed. Nothing can be done here, and the caller's COMMIT reports it
      // through the normal path.
    }

    // Silence would let a systematically failing refresh shorten every
    // session unnoticed. Rate-limited, and unable to throw, so this stays a
    // report and never becomes the failure the savepoint just contained.
    reportRefreshFailure(error, sessionId, logger);
  }
}

/**
 * What a response change asks for (D150): answer the default and keep whatever
 * custom response is saved, or answer this custom response, which replaces the
 * saved one.
 */
export type ResponseChange = { mode: 'default' } | { mode: 'custom'; response: ResponseConfig };

/**
 * `hadQueue` is whether the session held a response queue when the change
 * locked it (D205).
 */
export type ResponseChangeResult =
  | { outcome: 'updated'; state: SessionResponseState; hadQueue: boolean }
  | { outcome: 'session-not-found' }
  | { outcome: 'session-expired' };

/**
 * Changes the response a session answers with.
 *
 * The session row is locked `FOR UPDATE` first - the same lock every capture
 * takes before it reads the configuration its reply is composed from (D065).
 * The two therefore serialise: a capture that holds the lock is composed wholly
 * from the old response, and one that waits for it wholly from the new one,
 * never from a mixture. A request already inside its delay keeps the answer it
 * was composed with before the delay began (D105, D109).
 *
 * Picking the default only sets the flag: the saved custom response stays in
 * its columns, so switching back restores it (D151), whether its body is a
 * template included (D251). Picking a custom response writes all five columns
 * at their effective values, `response_template` among them, exactly as
 * creation does, and clears the flag.
 *
 * Expiry is judged against `clock_timestamp()` once the lock is held, as the
 * capture judges it: a session that expires while this waits on the lock stays
 * expired and is not written to. A change is a use of the session (D133), so it
 * slides the expiry, throttled by the statement (D242) and unable to fail the
 * change.
 */
export function updateSessionResponse(
  pool: pg.Pool,
  sessionId: string,
  change: ResponseChange,
  logger?: RefreshLogger,
  key: PresentedKey = null,
): Promise<ResponseChangeResult> {
  return changeLockedSession(
    pool,
    sessionId,
    key,
    () => true,
    (client) =>
      change.mode === 'custom'
        ? client.query<ResponseStateColumns>(
            `UPDATE sessions
                SET response_status = $2,
                    response_headers = $3::jsonb,
                    response_body = $4,
                    response_delay_ms = $5,
                    response_custom_disabled = false,
                    response_template = $6
              WHERE id = $1
              ${STATE_RETURNING}`,
            [
              sessionId,
              change.response.status,
              JSON.stringify(change.response.headers),
              change.response.body,
              change.response.delayMs,
              change.response.template,
            ],
          )
        : client.query<ResponseStateColumns>(
            `UPDATE sessions
                SET response_custom_disabled = true
              WHERE id = $1
              ${STATE_RETURNING}`,
            [sessionId],
          ),
    logger,
  );
}

/**
 * What a call on a session's response queue asks for (D205): save these steps
 * and start them from step 1, start the saved ones from step 1 again, or
 * remove the queue.
 */
export type QueueChange =
  { action: 'set'; steps: ResponseConfig[] } | { action: 'restart' } | { action: 'remove' };

/**
 * Sets, restarts or removes a session's response queue (D205), under the lock
 * every capture and every response change takes (D065, D150): a capture that
 * holds the lock takes its step from the queue as it was, and one that waits
 * for it takes step 1 of the queue saved or started here - never a mixture.
 *
 * Saving writes the steps and sets the count of answered steps to 0, so the
 * next request gets step 1. Restarting sets the count to 0 and keeps the steps;
 * a session without a queue keeps having none. Removing sets both columns to
 * `NULL`, and the session answers its response alone. Each is a use of the
 * session, as a response change is (D133, D150).
 *
 * A save is announced always; a restart or a removal only on a session that
 * held a queue, since on one that held none it changes nothing a viewer shows
 * (D205).
 */
export function updateSessionQueue(
  pool: pg.Pool,
  sessionId: string,
  change: QueueChange,
  logger?: RefreshLogger,
  key: PresentedKey = null,
): Promise<ResponseChangeResult> {
  const returning = STATE_RETURNING;

  return changeLockedSession(
    pool,
    sessionId,
    key,
    (hadQueue) => change.action === 'set' || hadQueue,
    (client) => {
      switch (change.action) {
        case 'set':
          return client.query<ResponseStateColumns>(
            `UPDATE sessions
                SET response_queue = $2::jsonb,
                    response_queue_answered = 0
              WHERE id = $1
              ${returning}`,
            [sessionId, serializeQueue(change.steps)],
          );

        case 'restart':
          return client.query<ResponseStateColumns>(
            `UPDATE sessions
                SET response_queue_answered = CASE
                      WHEN response_queue IS NULL THEN NULL
                      ELSE 0
                    END
              WHERE id = $1
              ${returning}`,
            [sessionId],
          );

        case 'remove':
          return client.query<ResponseStateColumns>(
            `UPDATE sessions
                SET response_queue = NULL,
                    response_queue_answered = NULL
              WHERE id = $1
              ${returning}`,
            [sessionId],
          );
      }
    },
    logger,
  );
}

/**
 * Saves a session's response rules (D246), replacing every rule it had; `[]`
 * removes them all. Under the lock every capture and every response or queue
 * change takes (D065, D150, D205): a capture that holds the lock is matched
 * against the rules as they were, and one that waits for it against the rules
 * saved here - never a mixture. The queue's position is not touched, so a
 * save never starts the queue again. A use of the session, as a response
 * change is (D133), and always announced with the whole new state.
 */
export function updateSessionRules(
  pool: pg.Pool,
  sessionId: string,
  rules: readonly ResponseRule[],
  logger?: RefreshLogger,
  key: PresentedKey = null,
): Promise<ResponseChangeResult> {
  return changeLockedSession(
    pool,
    sessionId,
    key,
    () => true,
    (client) =>
      client.query<ResponseStateColumns>(
        `UPDATE sessions
            SET response_rules = $2::jsonb
          WHERE id = $1
          ${STATE_RETURNING}`,
        [sessionId, serializeRules(rules)],
      ),
    logger,
  );
}

/**
 * The transaction every change to what a session answers runs in (D150,
 * D205, D246): the session row locked `FOR UPDATE`, refused as not found - also when
 * `key` does not open it (D245) - or expired with the lock held, judged
 * against `clock_timestamp()` as the capture judges it, then `write` - one
 * statement that returns the response, queue and rules columns - then the expiry
 * slid, throttled and unable to fail the change (D133), then, when
 * `announces` says so for whether the session held a queue, its
 * `session.updated` with the whole new state (D152), still under the lock, so
 * that it is delivered in lock order (D221). A refused change is rolled back
 * and writes nothing, so a key that does not open the session moves no
 * expiry. The lock's statement also reads whether the session holds a queue,
 * as it is before the change, and its fingerprint.
 *
 * It runs on `inTransaction` (D221), which ends it: a commit wakes the readers
 * only when the change appended its `session.updated` (`wake`), and a failure
 * is rolled back and reaches the caller as it was thrown, a connection whose
 * rollback fails as well discarded.
 */
async function changeLockedSession(
  pool: pg.Pool,
  sessionId: string,
  key: PresentedKey,
  announces: (hadQueue: boolean) => boolean,
  write: (client: pg.PoolClient) => Promise<pg.QueryResult<ResponseStateColumns>>,
  logger?: RefreshLogger,
): Promise<ResponseChangeResult> {
  return inTransaction(pool, async (client): Promise<TransactionEnd<ResponseChangeResult>> => {
    const locked = await client.query<{
      id: string;
      queued: boolean;
      access_key_hash: Buffer | null;
    }>(
      `SELECT id, response_queue IS NOT NULL AS queued, access_key_hash
         FROM sessions WHERE id = $1 FOR UPDATE`,
      [sessionId],
    );
    const found = locked.rows[0];

    // A keyed session the key does not open is answered as one that does not
    // exist, before its expiry is read: an expired one too (D245).
    if (found === undefined || !opens(found.access_key_hash, key)) {
      return { commit: false, value: { outcome: 'session-not-found' } };
    }

    const expiry = await client.query<{ expired: boolean }>(
      'SELECT expires_at <= clock_timestamp() AS expired FROM sessions WHERE id = $1',
      [sessionId],
    );

    if (expiry.rows[0]?.expired !== false) {
      return { commit: false, value: { outcome: 'session-expired' } };
    }

    const row = (await write(client)).rows[0];

    if (!row) {
      throw new Error('Updating a locked session returned no row');
    }

    await refreshExpiryInTransaction(client, sessionId, logger);

    const state = toResponseState(row);
    const hadQueue = found.queued;

    const announced = announces(hadQueue);

    if (announced) {
      await appendEvent(client, sessionId, { type: 'session.updated', data: state });
    }

    // A change that appended no event commits without waking the readers:
    // there is nothing for them to read (D205).
    return { commit: true, wake: announced, value: { outcome: 'updated', state, hadQueue } };
  });
}

/**
 * `session-refused` is a keyed session `key` does not open (D245): answered as
 * `session-not-found` is, but announcing nothing, since the session exists and
 * its viewers are watching it.
 */
export type SessionDeletionResult =
  | { outcome: 'deleted'; requestsHeld: number }
  | { outcome: 'session-not-found' }
  | { outcome: 'session-refused' }
  | { outcome: 'session-expired' };

/**
 * Counts one deleted session and the requests it held in the row of the
 * current UTC day (D198), exported so that a test can recognise it exactly.
 *
 * An upsert: the first deletion of a day inserts its row, and every later one
 * adds to it. The day is the UTC day of `clock_timestamp()`, read as the
 * deletion is counted, never from the connection's `TimeZone`. The row is held
 * until the deletion commits, so two deletions on the same day are counted one
 * after the other; nothing on the capture path writes this table.
 */
export const COUNT_SESSION_DELETION_SQL = `INSERT INTO stats.deletions_daily AS counted
         (day, sessions_deleted, requests_held)
       VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date, 1, $1)
       ON CONFLICT (day) DO UPDATE
         SET sessions_deleted = counted.sessions_deleted + 1,
             requests_held = counted.requests_held + EXCLUDED.requests_held`;

/**
 * Deletes a session with everything it holds, inside a transaction the caller
 * has opened and will end: `COMMIT` on `deleted`, `ROLLBACK` otherwise (D198).
 * `deleteSession` below is the one caller outside the tests.
 *
 * The session row is locked `FOR UPDATE` first, the same lock every capture
 * and every response change takes (D065, D150). So a capture that holds it
 * commits first and its request is deleted here with the rest, and a capture
 * that waits for it finds no row once this commits and answers as for an
 * unknown session. A keyed session `key` does not open is refused next, with
 * the lock held, before its expiry is read (D245). Expiry is then judged
 * against `clock_timestamp()` with the lock held, as the capture judges it:
 * an expired session is not deleted, and the scheduled cleanup removes it
 * instead (D019, D067).
 *
 * The requests are deleted by a statement of their own, and their response
 * records by its cascade, so that the count written to the statistics is the
 * number of rows actually removed: a request deleted by its own route between a
 * count and the deletion would otherwise be counted. While the session row is
 * locked no request can be added to it, since a capture takes that lock before
 * it inserts, so the session's own cascade finds nothing left.
 *
 * A deletion is not a use of the session (D133): nothing here refreshes the
 * expiry, and a refused deletion writes nothing.
 *
 * Last, the session's outbox rows lose their payloads and its `close` is
 * written (D221): every process closes the session's connections with `4404`
 * once this commits (D198).
 */
export async function deleteSessionInTransaction(
  client: pg.PoolClient,
  sessionId: string,
  key: PresentedKey = null,
): Promise<SessionDeletionResult> {
  const locked = await client.query<{ id: string; access_key_hash: Buffer | null }>(
    'SELECT id, access_key_hash FROM sessions WHERE id = $1 FOR UPDATE',
    [sessionId],
  );
  const found = locked.rows[0];

  if (found === undefined) {
    return { outcome: 'session-not-found' };
  }

  // Before the expiry is read, so an expired keyed session is refused alike (D245).
  if (!opens(found.access_key_hash, key)) {
    return { outcome: 'session-refused' };
  }

  const expiry = await client.query<{ expired: boolean }>(
    'SELECT expires_at <= clock_timestamp() AS expired FROM sessions WHERE id = $1',
    [sessionId],
  );

  if (expiry.rows[0]?.expired !== false) {
    return { outcome: 'session-expired' };
  }

  const removed = await client.query('DELETE FROM requests WHERE session_id = $1', [sessionId]);
  const requestsHeld = removed.rowCount ?? 0;

  const deleted = await client.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

  if (deleted.rowCount !== 1) {
    throw new Error('Deleting a locked session removed no row');
  }

  await client.query(COUNT_SESSION_DELETION_SQL, [requestsHeld]);
  await forgetEvents(client, sessionId, { session: 'all' });
  await appendEvent(client, sessionId, { type: 'close' });

  return { outcome: 'deleted', requestsHeld };
}

/**
 * Deletes a session in a transaction of its own (D198, `inTransaction`). A
 * refused deletion is rolled back, so it writes nothing, and so is one that
 * fails; a connection whose rollback fails as well is discarded rather than
 * returned to the pool.
 *
 * A session not found is announced too, `close`, once the transaction has
 * rolled back: a viewer of a session that does not exist is always wrong, and
 * this is how a retry closes the viewers a deletion whose acknowledgement was
 * lost left open (D198, D221). An expired session announces nothing (D076),
 * and nor does a keyed session `key` does not open (D245): its viewers hold
 * its key, and a stranger's call may not close them.
 */
export async function deleteSession(
  pool: pg.Pool,
  sessionId: string,
  key: PresentedKey = null,
): Promise<SessionDeletionResult> {
  return inTransaction(pool, async (client): Promise<TransactionEnd<SessionDeletionResult>> => {
    const result = await deleteSessionInTransaction(client, sessionId, key);

    if (result.outcome === 'deleted') {
      return { commit: true, value: result };
    }

    if (result.outcome === 'session-not-found') {
      return {
        commit: false,
        value: result,
        afterRollback: (onItsOwn) => appendEvent(onItsOwn, sessionId, { type: 'close' }),
      };
    }

    return { commit: false, value: result };
  });
}

export async function countRequests(pool: pg.Pool, sessionId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*) AS count FROM requests WHERE session_id = $1',
    [sessionId],
  );

  return Number(result.rows[0]?.count ?? 0);
}

/** What the status read finds for one id it asked about (D199). */
export interface SessionStatusRow {
  id: string;
  expired: boolean;
  /** Of a session that has not expired; `null` for an expired one, whose requests are not read. */
  requestsCount: number | null;
  lastRequestAt: Date | null;
  /**
   * `expires_at` minus the session's own idle window (D242), computed by the
   * same interval arithmetic creation and a refresh add it with; for a session
   * created with a lifetime, the later of its creation and its newest request
   * (D220).
   */
  lastUsedAt: Date;
}

/**
 * The status read's statement after `openSessions`' check of the keys (D245),
 * sent only for the ids that check found open, and exported so that a test
 * can tell it apart from a refresh exactly (D199).
 *
 * It only reads: no session is locked and no expiry moves, since reading the
 * status of a session is not a use of it (D133). Expiry is judged against
 * `clock_timestamp()` once per session, in the `chosen` scan, and the requests
 * of an expired session are not read at all — the lateral aggregate's
 * condition on `expired` is a one-time filter, as D068 keeps an expired
 * session's requests out of every statement. `last_used_at` subtracts the
 * session's own idle window, `idle_seconds`, with the same
 * `make_interval(secs => idle_seconds)` creation and a refresh add it with
 * (D242): an interval of seconds alone, so the inverse is exact in any time
 * zone. A session the previous image slid had 7 calendar days added, which
 * outside UTC can differ from 604800 s by an hour across a daylight-saving
 * change, within the hour the contract already allows (`lastUsedAt` in
 * docs/API.md).
 *
 * A session created with a lifetime has an expiry no use moves (D220), so its
 * `expires_at` says nothing about its last use: `last_used_at` is then the
 * later of its creation and its newest request, `greatest` passing over the
 * `NULL` of a session that holds none.
 *
 * A session the row of which is gone is simply absent from the answer: the
 * caller reports it `not_found`.
 */
export const SESSION_STATUS_SQL = `WITH chosen AS MATERIALIZED (
         SELECT id, created_at, expires_at, lifetime_ends_at, idle_seconds,
                expires_at <= clock_timestamp() AS expired
           FROM sessions
          WHERE id = ANY($1::text[])
       )
       SELECT chosen.id,
              chosen.expired,
              CASE
                WHEN chosen.lifetime_ends_at IS NULL
                  THEN chosen.expires_at - make_interval(secs => chosen.idle_seconds)
                ELSE greatest(chosen.created_at, held.last_request_at)
              END AS last_used_at,
              held.requests_count,
              held.last_request_at
         FROM chosen
         LEFT JOIN LATERAL (
           SELECT count(*) AS requests_count, max(requests.received_at) AS last_request_at
             FROM requests
            WHERE requests.session_id = chosen.id
              AND NOT chosen.expired
         ) held ON NOT chosen.expired`;

/**
 * Reads the sessions `ids` name, in one statement, without using any of them
 * (D133, D199). Answers by id; an id with no row is absent from the map.
 */
export async function readSessionStatuses(
  pool: pg.Pool,
  ids: string[],
): Promise<Map<string, SessionStatusRow>> {
  const result = await pool.query<{
    id: string;
    expired: boolean;
    last_used_at: Date;
    requests_count: string | null;
    last_request_at: Date | null;
  }>(SESSION_STATUS_SQL, [ids]);

  return new Map(
    result.rows.map((row) => [
      row.id,
      {
        id: row.id,
        expired: row.expired,
        requestsCount:
          row.expired || row.requests_count === null ? null : Number(row.requests_count),
        lastRequestAt: row.expired ? null : row.last_request_at,
        lastUsedAt: row.last_used_at,
      },
    ]),
  );
}
