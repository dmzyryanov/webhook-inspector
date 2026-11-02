import pg from 'pg';

/**
 * How long the server lets an application connection sit idle inside a
 * transaction before it ends the connection, and with it the transaction
 * (`idle_in_transaction_session_timeout`, D221): 60 s.
 *
 * Every transaction of the application is a few statements with nothing but
 * the process's own work between them, milliseconds as a rule: no call waits
 * for a client, a delayed reply or another call of its session while it holds
 * a transaction open (D105, D200, D205). A minute is far above any of that
 * under load, and well under the five minutes after which pg_cron's job
 * deletes an outbox row, so a writer stalled between its event's insert and
 * its `COMMIT` is ended, its event never committed, before the job could take
 * the row from a reader (D221 point 9). It also bounds how long such a
 * transaction holds its locks, a session row's among them, and the readers'
 * transaction horizon. The backup's `psql`, which holds a snapshot open for
 * the length of a dump, and `qa_readonly`'s sessions are not the
 * application's and keep the server's default, no timeout: the setting is
 * asked for by each connection at its start, never set on a role or the
 * database.
 */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * What every connection of the application asks the server for at its start:
 * the pool's here, and the realtime listener's own (`listener.ts`).
 */
export function applicationConnectionSettings(
  idleInTransactionTimeoutMs = IDLE_IN_TRANSACTION_TIMEOUT_MS,
): Pick<pg.ClientConfig, 'idle_in_transaction_session_timeout'> {
  return { idle_in_transaction_session_timeout: idleInTransactionTimeoutMs };
}

/**
 * The connections of capture's own pool (D244): the receive listener's
 * captures and completion writes, and `/readyz`. pg's default, as the one
 * pool before it had.
 */
export const CAPTURE_POOL_CONNECTIONS = 10;

/**
 * The connections of the API's pool (D244): `/api`, `/mcp`, `/ws` and the
 * realtime listener's prune: the gate's slots in front of the API's work
 * (`API_WORK_SLOTS`), and room for what the gate does not hold - the
 * realtime connections' reads, the prune, and a change in its turn of a
 * session's line (`inSessionLine`), one a session at a time. The searches
 * and queries run within the slots: of the four places of their two counts
 * (D191, D250), each statement held up to its 2 s timeout, at most as many
 * run at once as the gate has slots.
 */
export const API_POOL_CONNECTIONS = 6;

/** What the pool's own `error` is given to: nothing, as `createPool` says. */
const ignore = (): void => undefined;

/** Where `createPool` reports an ended connection: the application listener's log. */
export interface PoolLog {
  warn(details: object, message: string): void;
}

export interface PoolOptions {
  /** `IDLE_IN_TRANSACTION_TIMEOUT_MS`, shorter in the test that reaches it. */
  idleInTransactionTimeoutMs?: number;
  /** The backend's log; without one, as in most tests, an ended connection is not reported. */
  log?: PoolLog;
  /** The most connections open at once; pg's default, 10, unless given (D244). */
  max?: number;
  /**
   * Which of the process's pools this is, `capture` or `api` (D244): each
   * connection reports it as its `application_name`,
   * `webhook-inspector-capture` or `webhook-inspector-api`, which
   * `pg_stat_activity` shows. Absent, none.
   */
  name?: string;
}

/** What a named pool's connections put before its name in `application_name` (D244, D278). */
export const APPLICATION_NAME_PREFIX = 'webhook-inspector-';

/** The line an ended connection leaves in the log. */
export const CONNECTION_ENDED_MESSAGE = 'A pooled database connection ended';

/**
 * The severities of an error after which the server ends the session and
 * closes the connection; an `ERROR` ends only its statement. Matched in
 * English, the language of the server's messages (the official image's
 * locale).
 */
const SESSION_ENDING_SEVERITIES = new Set(['FATAL', 'PANIC']);

/**
 * A connection pool. Opening a connection per request would dominate the cost
 * of the small queries this service runs. A process has two (D244): capture's
 * own, for the receive listener and `/readyz`, so that no call of the API can
 * take a connection a capture needs, and the API's, for everything else. A
 * caller waiting for a connection waits for as long as it takes: the gate in
 * front of the API's work bounds how many wait on the API's pool, besides
 * the changes in their sessions' turns, one a session and at most an
 * address's calls in flight, and the byte budget how many captures wait on
 * theirs (D210).
 *
 * A connection the server ends - at the idle-in-transaction timeout, when
 * PostgreSQL restarts or `pg_terminate_backend` ends it - is sent the reason
 * as an error, then closed. pg hands the error to the statement running on the
 * connection, if one is, and otherwise reports it as an `error` event on the
 * client; a client lent out then reports its closed socket as an `error` of
 * its own, "Connection terminated unexpectedly". An idle client's `error`
 * reaches the pool too, through pg-pool's own listener. With nobody listening,
 * any of them would end the process. All are listened to: a client lent out
 * has its pending or next query rejected, which its caller answers as any
 * failed query, and its release discards it, since pg-pool drops a client that
 * can no longer be queried; `pool.query` releases its client with the error,
 * which discards it too; one idle in the pool is discarded by the pool. The
 * next query opens a new connection.
 *
 * Each ended connection leaves one `warn` line in `log`: the error's message
 * and code and nothing else - no statement, no parameter, nothing a request
 * carried. Two listeners every client gets at its connect, for its whole life,
 * write it, whichever hears the end first, and only it. One hears the server's
 * messages before pg routes them and takes an error of a session-ending
 * severity alone: an `ERROR`, which the connection outlives, is its
 * statement's caller's to report, and its message may quote a value a request
 * carried. The other is the client's `error`, for an end the server sent no
 * such error for: a broken socket, or an immediate shutdown or a crash of the
 * server, which sends at most a `WARNING` before the connection closes, so
 * that the line is the code-less "Connection terminated unexpectedly". A
 * connection the server ends with a `FATAL` while its statement runs logs the
 * server's message and code: under `pool.query`, which ends the connection
 * before its socket closes, so that no `error` follows, and on a client lent
 * out, whose "terminated unexpectedly" after it is not logged. The pool's
 * listener stays silent, since it hears again what an idle client's own
 * listeners have logged. PostgreSQL's own log has the rest.
 */
export function createPool(connectionString: string, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    ...applicationConnectionSettings(options.idleInTransactionTimeoutMs),
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.name === undefined
      ? {}
      : { application_name: `${APPLICATION_NAME_PREFIX}${options.name}` }),
  });

  pool.on('connect', (client) => {
    let reported = false;
    const report = (error: Error & { code?: unknown }): void => {
      if (reported) {
        return;
      }

      reported = true;
      options.log?.warn(
        {
          error: {
            message: error.message,
            code: typeof error.code === 'string' ? error.code : undefined,
          },
        },
        CONNECTION_ENDED_MESSAGE,
      );
    };

    client.connection.prependListener('errorMessage', (error: pg.DatabaseError) => {
      if (error.severity !== undefined && SESSION_ENDING_SEVERITIES.has(error.severity)) {
        report(error);
      }
    });
    client.on('error', report);
  });
  pool.on('error', ignore);

  return pool;
}
