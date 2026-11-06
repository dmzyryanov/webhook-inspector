/**
 * The application's connections and the idle-in-transaction timeout (#132,
 * D221 point 19): every connection of the pool and the realtime
 * listener's own asks for it at its start, and a connection with none keeps
 * the server's default; a connection left idle inside a transaction past a
 * shortened timeout is ended by the server, its transaction rolled back - an
 * outbox event it appended is never committed, the locks it held are free -
 * and the process goes on: the pool discards the connection, lent out or idle
 * in the pool, the backend's log has one `warn` line for it, and the next
 * query opens a new one. A connection ended while its statement runs, under
 * `pool.query` or lent out, leaves one line too, the server's message and
 * code; a statement the server refuses, which the connection outlives, none.
 *
 * Without `createPool`'s listeners the connection's `error` would end this
 * process, as it would the backend's, and the file would fail.
 *
 * And the process's two pools (D244): a pool opens at most the connections
 * it is given, pg's 10 without, and each connection of a named pool reports
 * the name as its `application_name`, `webhook-inspector-<name>`, which
 * `pg_stat_activity` shows; one of a pool with no name reports none.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { loadConfig } from '../config.ts';
import { appendEvent } from '../modules/realtime/events.ts';
import { listenerClientConfig } from '../modules/realtime/listener.ts';
import {
  API_POOL_CONNECTIONS,
  APPLICATION_NAME_PREFIX,
  CAPTURE_POOL_CONNECTIONS,
  CONNECTION_ENDED_MESSAGE,
  createPool,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  type PoolLog,
} from './pool.ts';

/** Short enough to wait out in a test, long enough for its own statements. */
const SHORT_TIMEOUT_MS = 300;

const databaseUrl = loadConfig().databaseUrl;
/** A pool of the default settings, which looks at the others from outside. */
let observer: pg.Pool;

before(() => {
  observer = createPool(databaseUrl);
});

after(async () => {
  await observer?.end();
});

/** `SHOW idle_in_transaction_session_timeout` on a connection opened with `config`. */
async function timeoutOf(config: pg.ClientConfig): Promise<string | undefined> {
  const client = new pg.Client(config);

  await client.connect();

  try {
    const shown = await client.query<{ idle_in_transaction_session_timeout: string }>(
      'SHOW idle_in_transaction_session_timeout',
    );

    return shown.rows[0]?.idle_in_transaction_session_timeout;
  } finally {
    await client.end();
  }
}

/**
 * Within 5 s: the server ends a connection idle in a transaction after
 * `SHORT_TIMEOUT_MS`, while the pool drops an idle connection of its own only
 * after 10 s, pg-pool's default, so a connection gone this soon was ended by
 * the server.
 */
const ENDED_WITHIN_MS = 5_000;

/** Resolves once the server process `pid` is gone, or fails after `ENDED_WITHIN_MS`. */
async function serverProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + ENDED_WITHIN_MS;

  while (Date.now() < deadline) {
    const found = await observer.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);

    if (found.rows.length === 0) {
      return;
    }

    await delay(50);
  }

  assert.fail(`server process ${pid} was not ended within ${ENDED_WITHIN_MS} ms`);
}

/** Resolves once `pool` holds no connection, or fails after `ENDED_WITHIN_MS`. */
async function poolEmptied(pool: pg.Pool): Promise<void> {
  const deadline = Date.now() + ENDED_WITHIN_MS;

  while (pool.totalCount > 0) {
    assert.ok(Date.now() < deadline, `the pool still holds ${pool.totalCount} connections`);
    await delay(50);
  }
}

/**
 * Resolves once `client` has ended, by which time every event its end makes
 * has been emitted. Not `events.once`, which rejects on the `error` the end
 * itself emits first.
 */
function endOf(client: pg.PoolClient): Promise<void> {
  return new Promise((resolve) => {
    client.once('end', () => resolve());
  });
}

/** A log that keeps what it is given, as the backend's would write it. */
function recordingLog(): PoolLog & { lines: { details: object; message: string }[] } {
  const lines: { details: object; message: string }[] = [];

  return {
    lines,
    warn: (details, message) => {
      lines.push({ details, message });
    },
  };
}

/**
 * The one line a connection ended at the idle-in-transaction timeout leaves:
 * the server's message and its code, `idle_in_transaction_session_timeout`,
 * and nothing else.
 */
const TIMEOUT_LINE = {
  details: {
    error: {
      message: 'terminating connection due to idle-in-transaction timeout',
      code: '25P03',
    },
  },
  message: CONNECTION_ENDED_MESSAGE,
};

/**
 * The one line a connection ended by `pg_terminate_backend` leaves, as one
 * ended by a PostgreSQL restart does: the server's message and its code,
 * `admin_shutdown`, and nothing else.
 */
const TERMINATED_LINE = {
  details: {
    error: { message: 'terminating connection due to administrator command', code: '57P01' },
  },
  message: CONNECTION_ENDED_MESSAGE,
};

/** A statement no other connection runs: `pg_sleep(30)`, marked with a random token. */
function sleepStatement(): string {
  return `SELECT pg_sleep(30) /* pool.test ${randomBytes(8).toString('hex')} */`;
}

/**
 * Ends the connection running `statement` with `pg_terminate_backend` once the
 * server shows it running, and answers its server process; fails after
 * `ENDED_WITHIN_MS`.
 */
async function terminateWhenRunning(statement: string): Promise<number> {
  const deadline = Date.now() + ENDED_WITHIN_MS;

  while (Date.now() < deadline) {
    const found = await observer.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE query = $1 AND state = 'active'",
      [statement],
    );
    const pid = found.rows[0]?.pid;

    if (pid !== undefined) {
      await observer.query('SELECT pg_terminate_backend($1)', [pid]);

      return pid;
    }

    await delay(20);
  }

  assert.fail(`no connection ran ${statement} within ${ENDED_WITHIN_MS} ms`);
}

/** After a failed assertion: ends whatever still runs `statement`, so that `end` need not wait 30 s for it. */
async function endRunning(statement: string): Promise<void> {
  await observer.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = $1', [
    statement,
  ]);
}

/** Resolves once `pool` has ended a connection it discarded, by which time every event its end makes has been emitted. */
function removalOf(pool: pg.Pool): Promise<void> {
  return new Promise((resolve) => {
    pool.once('remove', () => resolve());
  });
}

/** The error `pending` is rejected with; fails if it is answered. */
async function rejectionOf(pending: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await pending;
  } catch (error) {
    return error as Error & { code?: string };
  }

  assert.fail('the statement was answered');
}

/** The server process of `client`'s connection. */
async function serverProcessOf(client: pg.PoolClient): Promise<number> {
  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;

  assert.ok(pid);

  return pid;
}

describe('the idle-in-transaction timeout of the application connections (D221)', () => {
  it('is asked for by every connection of the pool and the realtime listener, 60 s, and by no other', async () => {
    assert.equal(IDLE_IN_TRANSACTION_TIMEOUT_MS, 60_000);

    const shown = await observer.query<{ idle_in_transaction_session_timeout: string }>(
      'SHOW idle_in_transaction_session_timeout',
    );

    assert.equal(shown.rows[0]?.idle_in_transaction_session_timeout, '1min');
    assert.equal(await timeoutOf(listenerClientConfig(databaseUrl, 5_000)), '1min');
    // Asked for by the connection, not set on the role or the database: the
    // backup's psql, holding its snapshot for a whole dump, keeps no timeout.
    assert.equal(await timeoutOf({ connectionString: databaseUrl }), '0');
  });

  it('ends a lent-out connection left idle in a transaction: its event never commits, its locks are freed, one warn line names it, and the pool discards it and serves the next query', async () => {
    const log = recordingLog();
    const pool = createPool(databaseUrl, { idleInTransactionTimeoutMs: SHORT_TIMEOUT_MS, log });
    const sessionId = randomBytes(32).toString('base64url');
    const lock = randomInt(1, 2 ** 47);
    const client = await pool.connect();
    const ended = endOf(client);
    let released = false;

    try {
      const pid = await serverProcessOf(client);

      // Codex 3's writer: the event appended, then a stall before `COMMIT`.
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [lock]);
      await appendEvent(client, sessionId, { type: 'close' });

      await serverProcessGone(pid);
      await assert.rejects(client.query('COMMIT'));
      await ended;
      // The server's message, then the client's own "terminated
      // unexpectedly" as its socket closed: one line for both.
      assert.deepEqual(log.lines, [TIMEOUT_LINE]);

      const rows = await observer.query('SELECT 1 FROM realtime_events WHERE session_id = $1', [
        sessionId,
      ]);

      assert.equal(rows.rows.length, 0, 'the stalled event was committed');

      const free = await observer.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1) AS locked',
        [lock],
      );

      assert.equal(free.rows[0]?.locked, true, 'the lock is still held');

      released = true;
      client.release();
      assert.equal(pool.totalCount, 0, 'the ended connection went back into the pool');

      const answered = await pool.query<{ one: number }>('SELECT 1 AS one');

      assert.equal(answered.rows[0]?.one, 1);
      assert.equal(pool.totalCount, 1);
      assert.deepEqual(log.lines, [TIMEOUT_LINE]);
    } finally {
      // A failed assertion leaves the connection lent out, which `end` would
      // wait for.
      if (!released) {
        client.release(new Error('The test failed'));
      }

      await pool.end();
    }
  });

  it('ends a connection released into the pool with its transaction still open, one warn line names it, and the pool discards it and serves the next query', async () => {
    const log = recordingLog();
    const pool = createPool(databaseUrl, { idleInTransactionTimeoutMs: SHORT_TIMEOUT_MS, log });

    try {
      const client = await pool.connect();
      const ended = endOf(client);
      const pid = await serverProcessOf(client);

      // A transaction never ended: released as if its work had committed.
      await client.query('BEGIN');
      await client.query('SELECT 1');
      client.release();
      assert.equal(pool.idleCount, 1);

      await serverProcessGone(pid);
      await poolEmptied(pool);
      await ended;
      // Heard by the client's own listener and by pg-pool's, which passes it
      // on to the pool: one line for both.
      assert.deepEqual(log.lines, [TIMEOUT_LINE]);

      const answered = await pool.query<{ one: number }>('SELECT 1 AS one');

      assert.equal(answered.rows[0]?.one, 1);
      assert.deepEqual(log.lines, [TIMEOUT_LINE]);
    } finally {
      await pool.end();
    }
  });
});

describe('a connection the server ends while its statement runs (D221 point 19)', () => {
  it("leaves one warn line, the server's message and code, when it runs a statement of `pool.query`, and the pool discards it and serves the next query", async () => {
    const log = recordingLog();
    const pool = createPool(databaseUrl, { log });
    const statement = sleepStatement();

    try {
      const removed = removalOf(pool);
      const running = rejectionOf(pool.query(statement));

      await terminateWhenRunning(statement);
      assert.equal((await running).code, '57P01');
      await removed;
      // The server's message rejected the statement, and pg-pool, releasing
      // the connection with it, ended the connection before its socket
      // closed, so no `error` event followed: the line is the message's.
      assert.deepEqual(log.lines, [TERMINATED_LINE]);
      assert.equal(pool.totalCount, 0);

      const answered = await pool.query<{ one: number }>('SELECT 1 AS one');

      assert.equal(answered.rows[0]?.one, 1);
      assert.deepEqual(log.lines, [TERMINATED_LINE]);
    } finally {
      await endRunning(statement);
      await pool.end();
    }
  });

  it('leaves one warn line, the server\'s message and code, when it is lent out, not its own code-less "terminated unexpectedly", and the pool discards it on its release', async () => {
    const log = recordingLog();
    const pool = createPool(databaseUrl, { log });
    const statement = sleepStatement();
    const client = await pool.connect();
    const ended = endOf(client);
    let released = false;

    try {
      const pid = await serverProcessOf(client);
      const running = rejectionOf(client.query(statement));

      assert.equal(await terminateWhenRunning(statement), pid);
      assert.equal((await running).code, '57P01');
      await ended;
      // The server's message rejected the statement, then the client's own
      // "Connection terminated unexpectedly", with no code, came as an
      // `error` event once its socket closed: one line, the server's.
      assert.deepEqual(log.lines, [TERMINATED_LINE]);

      released = true;
      client.release();
      assert.equal(pool.totalCount, 0, 'the ended connection went back into the pool');

      const answered = await pool.query<{ one: number }>('SELECT 1 AS one');

      assert.equal(answered.rows[0]?.one, 1);
      assert.deepEqual(log.lines, [TERMINATED_LINE]);
    } finally {
      if (!released) {
        await endRunning(statement);
        client.release(new Error('The test failed'));
      }

      await pool.end();
    }
  });

  it("leaves no line for a statement the server refuses and the connection outlives, a request's value in its message or a cancelled statement's code of the same class as 57P01", async () => {
    const log = recordingLog();
    const pool = createPool(databaseUrl, { log });
    const value = `not a number "'\\ ${randomBytes(8).toString('hex')}`;
    const client = await pool.connect();
    let released = false;

    try {
      const refused = await rejectionOf(client.query('SELECT $1::integer', [value]));

      assert.equal(refused.code, '22P02');
      assert.ok(refused.message.includes(value), 'the refusal does not quote the value');

      await client.query("SET statement_timeout = '50ms'");

      const cancelled = await rejectionOf(client.query('SELECT pg_sleep(5)'));

      assert.equal(cancelled.code, '57014');
      await client.query('RESET statement_timeout');
      assert.equal((await client.query<{ one: number }>('SELECT 1 AS one')).rows[0]?.one, 1);
      released = true;
      client.release();

      // `pool.query` releases its connection with the refusal, and pg-pool
      // discards a connection released with an error: an end, but not one
      // the server made.
      const removed = removalOf(pool);
      const refusedThroughPool = await rejectionOf(pool.query('SELECT $1::integer', [value]));

      assert.equal(refusedThroughPool.code, '22P02');
      await removed;
      assert.deepEqual(log.lines, []);
    } finally {
      if (!released) {
        client.release(new Error('The test failed'));
      }

      await pool.end();
    }
  });
});

describe('the process’s two pools (D244)', () => {
  it('opens at most the connections a pool is given, pg’s 10 without, capture’s 10 and the API’s 6', async () => {
    assert.equal(CAPTURE_POOL_CONNECTIONS, 10);
    assert.equal(API_POOL_CONNECTIONS, 6);

    const small = createPool(databaseUrl, { max: 3 });

    try {
      assert.equal(small.options.max, 3);
      assert.equal(observer.options.max, 10);

      // Three lent out, the fourth waits for one of them.
      const clients = await Promise.all([small.connect(), small.connect(), small.connect()]);
      const fourth = small.connect();

      try {
        assert.equal(small.totalCount, 3);
        await delay(100);
        assert.equal(small.waitingCount, 1);
      } finally {
        for (const client of clients) {
          client.release();
        }
      }

      (await fourth).release();
      assert.equal(small.totalCount, 3);
    } finally {
      await small.end();
    }
  });

  // The backend's two pools, as `index.ts` names them (D244), under the
  // inspector's name since #323 (D278).
  for (const [name, expected] of [
    ['capture', 'webhook-inspector-capture'],
    ['api', 'webhook-inspector-api'],
  ]) {
    it(`names every connection of the pool named ${name} ${expected} as its application_name, seen in pg_stat_activity`, async () => {
      const named = createPool(databaseUrl, { max: 2, name });

      try {
        const client = await named.connect();

        try {
          const shown = await client.query<{ application_name: string }>('SHOW application_name');

          assert.equal(shown.rows[0]?.application_name, expected);

          const pid = await serverProcessOf(client);
          const seen = await observer.query<{ application_name: string }>(
            'SELECT application_name FROM pg_stat_activity WHERE pid = $1',
            [pid],
          );

          assert.equal(seen.rows[0]?.application_name, expected);
        } finally {
          client.release();
        }

        // `pool.query`'s connection too.
        const queried = await named.query<{ application_name: string }>('SHOW application_name');

        assert.equal(queried.rows[0]?.application_name, expected);
      } finally {
        await named.end();
      }
    });
  }

  it('names no connection of a pool with no name so', async () => {
    const unnamed = await observer.query<{ application_name: string }>('SHOW application_name');
    const shown = unnamed.rows[0]?.application_name ?? '';

    assert.ok(!shown.startsWith(APPLICATION_NAME_PREFIX), shown);
  });
});
