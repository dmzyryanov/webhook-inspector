/**
 * Integration tests for a session created with a lifetime (D220, issue #129):
 * no use moves its expiry while a session without one still slides (D133);
 * once the lifetime has passed it is expired, and the cleanup removes it with
 * its requests; and the previous image's refresh, replayed on the new schema,
 * cannot extend it. And for a session created with an idle window (D242,
 * issue #158): every use slides it by its own window, throttled to a tenth of
 * a window shorter than 10 hours; uses at once write once; an expired one is
 * never revived; the trigger of migration 013 holds every writer to the
 * window; and the base image's refresh, replayed, leaves a short session at
 * most a full window ahead.
 *
 * Creation itself - what `expiresInSeconds` and `expiresAfterIdleSeconds`
 * take and refuse - is in `sessions.test.ts`, `lifetime-body.test.ts` and
 * `idle-window-body.test.ts`; `lastUsedAt` in `session-status.test.ts`.
 *
 * Start the database and apply migrations first:
 *   npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { SESSION_IDLE_DAYS } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import {
  REFRESH_SESSION_EXPIRY_SQL,
  reportRefreshFailure,
  resetRefreshWarningThrottle,
} from './repository.ts';

const JSON_TYPE = { 'content-type': 'application/json' };
const DAY_MS = 86_400_000;

/** The name migration 021 gives the cleanup job (D160, D278). */
const CLEANUP_JOB = 'webhook-inspector-delete-expired-sessions';

let pool: pg.Pool;
let servers: TestServers;
/** The application listener. */
let app: FastifyInstance;
/** The receive listener, where webhooks are sent (D187). */
let receiver: FastifyInstance;
const createdSessionIds: string[] = [];
/** Every line both listeners logged, as text: a refresh that failed says so here (D133). */
let logOutput = '';

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    // Dozens of sessions created within a minute, from one address (D201).
    servers = buildTestServers(pool, {
      rateLimits: LIMITS_OUT_OF_REACH,
      logDestination: new Writable({
        write(chunk: Buffer | string, _encoding, callback) {
          logOutput += chunk.toString();
          callback();
        },
      }),
    });
    ({ api: app, receiver } = servers);
    await servers.ready();
  })();
  await startup;
});

after(async () => {
  await startup?.catch(() => undefined);

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers?.close();
  await pool?.end();
});

/** What `app.inject` resolves to; its own return type is the chainable form. */
type InjectedResponse = Awaited<ReturnType<typeof app.inject>>;

/** Creates a session: a default one with no body, or the body given. */
async function create(body?: object): Promise<string> {
  const response =
    body === undefined
      ? await app.inject({ method: 'POST', url: '/api/sessions' })
      : await app.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: JSON_TYPE,
          payload: JSON.stringify(body),
        });

  assert.equal(response.statusCode, 201, response.body);

  const { id } = response.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

/** A session's two ends, as text to the microsecond: equal text is an equal value. */
interface Ends {
  expiresAt: string;
  lifetimeEndsAt: string | null;
}

async function ends(sessionId: string): Promise<Ends> {
  const result = await pool.query<{ expires_at: string; lifetime_ends_at: string | null }>(
    `SELECT expires_at::text AS expires_at, lifetime_ends_at::text AS lifetime_ends_at
       FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const row = result.rows[0];

  assert.ok(row, `session ${sessionId.slice(0, 8)} is gone`);

  return { expiresAt: row.expires_at, lifetimeEndsAt: row.lifetime_ends_at };
}

async function expiresAt(sessionId: string): Promise<Date> {
  const result = await pool.query<{ expires_at: Date }>(
    'SELECT expires_at FROM sessions WHERE id = $1',
    [sessionId],
  );

  return (result.rows[0] as { expires_at: Date }).expires_at;
}

/**
 * Lets `interval` pass for a session: its creation and both of its ends move
 * that far back, as they would have read had it been created that long ago.
 * Moving an expiry back keeps the constraint `sessions_lifetime_cap`.
 */
async function letPass(sessionId: string, interval: string): Promise<void> {
  await pool.query(
    `UPDATE sessions
        SET created_at = created_at - $2::interval,
            expires_at = expires_at - $2::interval,
            lifetime_ends_at = lifetime_ends_at - $2::interval
      WHERE id = $1`,
    [sessionId, interval],
  );
}

/** Moves a session's expiry to `interval` from now, for a session without a lifetime. */
async function setExpiry(sessionId: string, interval: string): Promise<void> {
  await pool.query(
    'UPDATE sessions SET expires_at = clock_timestamp() + $2::interval WHERE id = $1',
    [sessionId, interval],
  );
}

/** Sends one webhook to the receive listener. */
function send(sessionId: string): Promise<InjectedResponse> {
  return receiver.inject({
    method: 'POST',
    url: `/s/${sessionId}`,
    headers: { 'content-type': 'text/plain' },
    payload: 'captured',
  });
}

function read(sessionId: string): Promise<InjectedResponse> {
  return app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
}

async function requestCount(sessionId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*) AS count FROM requests WHERE session_id = $1',
    [sessionId],
  );

  return Number(result.rows[0]?.count);
}

function assertError(response: InjectedResponse, statusCode: number, errorCode: number): void {
  assert.equal(response.statusCode, statusCode, response.body);
  assert.equal(response.json<{ errorCode: number }>().errorCode, errorCode, response.body);
}

/**
 * Every use of a session (D133, D150, D205), each answered `200`: a capture,
 * a read, a response change and the queue's three calls, in an order in which
 * the restart and the removal find a queue.
 */
const USES: readonly [string, (sessionId: string) => Promise<InjectedResponse>][] = [
  ['a capture', send],
  ['GET /api/sessions/:sessionId', read],
  [
    'PUT .../response',
    (sessionId) =>
      app.inject({
        method: 'PUT',
        url: `/api/sessions/${sessionId}/response`,
        headers: JSON_TYPE,
        payload: JSON.stringify({ mode: 'custom', response: { status: 202 } }),
      }),
  ],
  [
    'PUT .../queue',
    (sessionId) =>
      app.inject({
        method: 'PUT',
        url: `/api/sessions/${sessionId}/queue`,
        headers: JSON_TYPE,
        payload: JSON.stringify({ steps: [{ status: 503 }] }),
      }),
  ],
  [
    'POST .../queue/restart',
    (sessionId) => app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/queue/restart` }),
  ],
  [
    'DELETE .../queue',
    (sessionId) => app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/queue` }),
  ],
];

describe('no use moves the expiry of a session with a lifetime (criterion 4, D220)', () => {
  for (const [seconds, passed] of [
    [600, null],
    // A full lifetime two hours in: past the hourly throttle, so a slide
    // would show (D150).
    [604_800, '2 hours'],
  ] as const) {
    it(`leaves the expiry byte-equal after every use, with ${seconds} s${passed === null ? '' : `, ${passed} in`}`, async () => {
      const sessionId = await create({ expiresInSeconds: seconds });

      if (passed !== null) {
        await letPass(sessionId, passed);
      }

      const before = await ends(sessionId);

      assert.equal(before.lifetimeEndsAt, before.expiresAt);

      // Any refresh that failed is reported, once a minute (D133): forgetting
      // the last report makes a failure here show in the log.
      resetRefreshWarningThrottle();
      logOutput = '';

      for (const [name, use] of USES) {
        const answered = await use(sessionId);

        assert.equal(answered.statusCode, 200, `${name}: ${answered.body}`);
        assert.deepEqual(await ends(sessionId), before, name);
      }

      // Left where it is by the refresh's own condition, not refused by the
      // constraint: nothing failed.
      assert.equal(logOutput.includes('session expiry refresh failed'), false, logOutput);

      // The read reports the fixed end: what the row holds.
      const reported = (await read(sessionId)).json<{ expiresAt: string }>().expiresAt;

      assert.equal(Date.parse(reported), (await expiresAt(sessionId)).getTime());
      assert.equal(await requestCount(sessionId), 1);
    });
  }

  it('while every use still moves a session without one a full window ahead, as the control', async () => {
    const sessionId = await create();

    assert.equal((await ends(sessionId)).lifetimeEndsAt, null);

    for (const [name, use] of USES) {
      await setExpiry(sessionId, '2 days');

      const answered = await use(sessionId);

      assert.equal(answered.statusCode, 200, `${name}: ${answered.body}`);

      const daysAhead = ((await expiresAt(sessionId)).getTime() - Date.now()) / DAY_MS;

      assert.ok(
        Math.abs(daysAhead - SESSION_IDLE_DAYS) < 0.01,
        `${name}: expected about ${SESSION_IDLE_DAYS} days, got ${daysAhead}`,
      );
      assert.equal((await ends(sessionId)).lifetimeEndsAt, null, name);
    }
  });
});

/** How many sessions a run is given before its failure stands. */
const SESSIONS_TRIED = 3;

/**
 * Runs `run` on a session with a lifetime of 60 s that holds one request and
 * whose lifetime has passed.
 *
 * Other test files remove every expired session as the cleanup does
 * (`src/testing/expired-session.ts`), and a capture takes the row `FOR UPDATE`,
 * so the row cannot be held against them while `run` sends one. As
 * `withExpiredSession` does, a run that failed while its session is still
 * there failed on its own, and one that failed with its session gone runs
 * again on a new one.
 */
async function withPassedLifetime<T>(
  t: TestContext,
  run: (sessionId: string) => Promise<T>,
): Promise<T> {
  for (let tried = 1; ; tried += 1) {
    const sessionId = await create({ expiresInSeconds: 60 });

    assert.equal((await send(sessionId)).statusCode, 200);
    await letPass(sessionId, '61 seconds');

    try {
      return await run(sessionId);
    } catch (error) {
      const { rowCount } = await pool.query('SELECT 1 FROM sessions WHERE id = $1', [sessionId]);

      if (rowCount !== 0 || tried === SESSIONS_TRIED) {
        throw error;
      }

      t.diagnostic(
        `the expired session ${sessionId.slice(0, 8)} was removed during the run, ` +
          `which failed; run again on a new session (${tried} of ${SESSIONS_TRIED})`,
      );
    }
  }
}

describe('once the lifetime has passed (criterion 5, D220)', () => {
  it('answers a webhook and GET 410 / 1002, its lifetime the end it reached', async (t) => {
    await withPassedLifetime(t, async (sessionId) => {
      const state = await pool.query<{ passed: boolean; same: boolean }>(
        `SELECT lifetime_ends_at <= clock_timestamp() AS passed,
                expires_at = lifetime_ends_at AS same
           FROM sessions WHERE id = $1`,
        [sessionId],
      );

      assert.deepEqual(state.rows[0], { passed: true, same: true });
      assertError(await send(sessionId), 410, 1002);
      assertError(await read(sessionId), 410, 1002);
      // Nothing was stored, and nothing revived it.
      assert.equal(await requestCount(sessionId), 1);
      assert.equal((await ends(sessionId)).expiresAt, (await ends(sessionId)).lifetimeEndsAt);
    });
  });

  it('is removed with its requests by the statement the cleanup job runs', async () => {
    const { rows: registered } = await pool.query<{ command: string }>(
      'SELECT command FROM cron.job WHERE jobname = $1 AND database = current_database()',
      [CLEANUP_JOB],
    );
    const command = registered[0]?.command;

    assert.ok(command, 'the cleanup job is not registered against this database');

    const sessionId = await create({ expiresInSeconds: 60 });

    assert.equal((await send(sessionId)).statusCode, 200);
    assert.equal((await send(sessionId)).statusCode, 200);

    // Held `FOR KEY SHARE` from before it expires, so no other file's sweep
    // removes it first; letting the lifetime pass does not wait for that
    // lock, and this transaction's own sweep is not stopped by it.
    const holder = await pool.connect();

    try {
      await holder.query('BEGIN');

      const held = await holder.query('SELECT 1 FROM sessions WHERE id = $1 FOR KEY SHARE', [
        sessionId,
      ]);

      assert.equal(held.rowCount, 1);
      await letPass(sessionId, '61 seconds');

      const counted = await holder.query<{ count: string }>(
        'SELECT count(*) AS count FROM requests WHERE session_id = $1',
        [sessionId],
      );

      assert.equal(Number(counted.rows[0]?.count), 2);
      await holder.query(command);
      await holder.query('COMMIT');
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    } finally {
      holder.release();
    }

    const { rowCount } = await pool.query('SELECT 1 FROM sessions WHERE id = $1', [sessionId]);

    assert.equal(rowCount, 0);
    assert.equal(await requestCount(sessionId), 0);
    assertError(await read(sessionId), 404, 1001);
  });
});

/**
 * Criterion 6 (D220, as D205 did for its queue). The previous image, 0.52.1
 * (`223fdb3`), keeps running on this schema after a `helm rollback`, which
 * never undoes a migration (D055), and beside this image during a rolling
 * update. Its refresh, copied from `apps/backend/src/modules/sessions/repository.ts`
 * as it stood there, moves `expires_at` without knowing `lifetime_ends_at`;
 * its session insert names its columns and gives none. Both are replayed here
 * on the new schema, the refresh inside the savepoint its capture and its
 * response change run it in (`refreshExpiryInTransaction`, D133).
 */
const PREVIOUS_IMAGE_REFRESH = `UPDATE sessions
        SET expires_at = clock_timestamp() + make_interval(days => $2)
      WHERE id = $1
        AND expires_at > clock_timestamp()
        AND expires_at < clock_timestamp() + make_interval(days => $2) - interval '1 hour'
  RETURNING expires_at`;

const PREVIOUS_IMAGE_SESSION_INSERT = `INSERT INTO sessions
       (id, expires_at, response_status, response_headers, response_body, response_delay_ms,
        response_queue, response_queue_answered)
     VALUES ($1, now() + make_interval(days => $2), $3, $4::jsonb, $5, $6, $7::jsonb, $8)
     RETURNING id, expires_at, response_queue, response_queue_answered`;

/** The previous image's capture, stripped to what decides the refresh: the lock, the expiry, the insert. */
const PREVIOUS_IMAGE_CAPTURE_LOCK = 'SELECT id FROM sessions WHERE id = $1 FOR UPDATE';

const PREVIOUS_IMAGE_EXPIRY = `SELECT expires_at <= clock_timestamp() AS expired FROM sessions WHERE id = $1`;

const PREVIOUS_IMAGE_REQUEST_INSERT = `INSERT INTO requests
         (session_id, method, path, http_version, query_string, headers, body, body_size,
          raw_request, source_ip, received_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::bytea, $8, $9::bytea || $7::bytea, $10,
               clock_timestamp())
       RETURNING id, received_at`;

/** The one warning a minute a failed refresh is reported with (D133). */
interface Warning {
  details: { session?: string; reason?: string };
  message: string;
}

/**
 * One capture as the previous image makes it, in its transaction, with its
 * refresh last inside `SAVEPOINT refresh_expiry` as that image ran it: a
 * refused refresh is rolled back to the savepoint and reported, and the
 * capture commits. Answers the refresh's error, or `undefined` when it ran.
 */
async function captureAsPreviousImage(sessionId: string, warnings: Warning[]): Promise<unknown> {
  const client = await pool.connect();
  let refused: unknown;

  try {
    await client.query('BEGIN');
    assert.equal((await client.query(PREVIOUS_IMAGE_CAPTURE_LOCK, [sessionId])).rowCount, 1);

    const expiry = await client.query<{ expired: boolean }>(PREVIOUS_IMAGE_EXPIRY, [sessionId]);

    assert.equal(expiry.rows[0]?.expired, false);

    const body = Buffer.from('captured by the previous image');

    await client.query(PREVIOUS_IMAGE_REQUEST_INSERT, [
      sessionId,
      'POST',
      `/s/${sessionId}`,
      '1.1',
      '',
      JSON.stringify([['content-type', 'text/plain']]),
      body,
      body.byteLength,
      Buffer.from(`POST /s/${sessionId} HTTP/1.1\r\n\r\n`),
      '203.0.113.7',
    ]);

    try {
      await client.query('SAVEPOINT refresh_expiry');
      await client.query(PREVIOUS_IMAGE_REFRESH, [sessionId, SESSION_IDLE_DAYS]);
      await client.query('RELEASE SAVEPOINT refresh_expiry');
    } catch (error) {
      refused = error;
      await client.query('ROLLBACK TO SAVEPOINT refresh_expiry');
      reportRefreshFailure(error, sessionId, {
        warn: (details, message) => warnings.push({ details, message }),
      });
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return refused;
}

/** Whether `error` is PostgreSQL refusing a row by the constraint of migration 011. */
function assertCapRefusal(error: unknown): void {
  assert.ok(error instanceof Error, `no refusal: ${String(error)}`);

  const { code, constraint } = error as Error & { code?: string; constraint?: string };

  assert.equal(code, '23514', error.message);
  assert.equal(constraint, 'sessions_lifetime_cap', error.message);
}

describe('the previous image on the new schema (criterion 6, D220)', () => {
  it('differs from the base image’s refresh by the one condition alone', () => {
    // The base image of 1.1.0 (D242) carries D220's condition; 0.52.1's lacks
    // it. This image's own statement is pinned against the base's below.
    assert.equal(
      BASE_IMAGE_REFRESH,
      PREVIOUS_IMAGE_REFRESH.replace(
        "- interval '1 hour'\n",
        "- interval '1 hour'\n        AND lifetime_ends_at IS NULL\n",
      ),
    );
  });

  for (const [seconds, passed] of [
    [600, null],
    [604_800, '2 hours'],
  ] as const) {
    it(`has its refresh refused by the constraint while its capture commits, with ${seconds} s, warning once a minute`, async () => {
      const sessionId = await create({ expiresInSeconds: seconds });

      if (passed !== null) {
        await letPass(sessionId, passed);
      }

      const before = await ends(sessionId);
      const warnings: Warning[] = [];

      resetRefreshWarningThrottle();
      assertCapRefusal(await captureAsPreviousImage(sessionId, warnings));
      assert.deepEqual(await ends(sessionId), before);
      assert.equal(await requestCount(sessionId), 1);

      // The capture is this image's to read, and this image's uses move nothing.
      const listed = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/requests`,
      });

      assert.equal(listed.json<unknown[]>().length, 1);
      assert.equal((await send(sessionId)).statusCode, 200);
      assert.deepEqual(await ends(sessionId), before);

      // A second refusal within the minute is not reported again.
      assertCapRefusal(await captureAsPreviousImage(sessionId, warnings));
      assert.deepEqual(await ends(sessionId), before);
      assert.equal(await requestCount(sessionId), 3);
      assert.equal(warnings.length, 1);
      assert.equal(
        warnings[0]?.message,
        'session expiry refresh failed; the session keeps its previous expiry',
      );
      assert.equal(warnings[0]?.details.session, sessionId.slice(0, 8));
      assert.match(warnings[0]?.details.reason ?? '', /sessions_lifetime_cap/);

      // Its read of a session refreshes on the pool, outside a transaction,
      // and its failure is caught by that read (D133): refused the same way.
      await assert.rejects(
        pool.query(PREVIOUS_IMAGE_REFRESH, [sessionId, SESSION_IDLE_DAYS]),
        (error) => {
          assertCapRefusal(error);

          return true;
        },
      );
      assert.deepEqual(await ends(sessionId), before);
      resetRefreshWarningThrottle();
    });
  }

  it('still slides a session without a lifetime, and creates sessions this image slides', async () => {
    const created = await create();

    await setExpiry(created, '2 days');
    assert.equal(await captureAsPreviousImage(created, []), undefined);

    const daysAhead = ((await expiresAt(created)).getTime() - Date.now()) / DAY_MS;

    assert.ok(Math.abs(daysAhead - SESSION_IDLE_DAYS) < 0.01, `got ${daysAhead}`);

    // A session the previous image inserts has no lifetime, and this image
    // slides it as any other.
    const inserted = randomBytes(32).toString('base64url');

    await pool.query(PREVIOUS_IMAGE_SESSION_INSERT, [
      inserted,
      SESSION_IDLE_DAYS,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    createdSessionIds.push(inserted);
    assert.equal((await ends(inserted)).lifetimeEndsAt, null);

    await setExpiry(inserted, '2 days');
    assert.equal((await read(inserted)).statusCode, 200);

    const slid = ((await expiresAt(inserted)).getTime() - Date.now()) / DAY_MS;

    assert.ok(Math.abs(slid - SESSION_IDLE_DAYS) < 0.01, `got ${slid}`);
  });
});

/** How many seconds from now, by the database's clock, a session expires. */
async function secondsAhead(sessionId: string): Promise<number> {
  const result = await pool.query<{ ahead: number }>(
    `SELECT extract(epoch FROM expires_at - clock_timestamp())::float8 AS ahead
       FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const row = result.rows[0];

  assert.ok(row, `session ${sessionId.slice(0, 8)} is gone`);

  return row.ahead;
}

/** The window a session's row holds (D242). */
async function idleSeconds(sessionId: string): Promise<number> {
  const result = await pool.query<{ idle_seconds: number }>(
    'SELECT idle_seconds FROM sessions WHERE id = $1',
    [sessionId],
  );

  return (result.rows[0] as { idle_seconds: number }).idle_seconds;
}

/**
 * Asserts that a session expires a full `window` seconds from now, as a use
 * just moved it: no more than the window, and less only by the moments the
 * check itself took.
 */
async function assertFullWindow(sessionId: string, window: number, label: string): Promise<void> {
  const ahead = await secondsAhead(sessionId);

  assert.ok(ahead <= window && ahead > window - 5, `${label}: ${ahead} s ahead, not ${window}`);
}

/**
 * How many backends wait on the backend `pid`, directly or behind another
 * waiter: a lock queue is a chain, each waiting on the one before it.
 */
async function waitingOn(pid: number | undefined): Promise<number> {
  const result = await pool.query<{ waiting: number }>(
    `WITH RECURSIVE waiter (pid) AS (
       SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
       UNION
       SELECT activity.pid
         FROM pg_stat_activity activity
         JOIN waiter ON waiter.pid = ANY(pg_blocking_pids(activity.pid))
     )
     SELECT count(*)::int AS waiting FROM waiter`,
    [pid],
  );

  return result.rows[0]?.waiting ?? 0;
}

/** Polls `waitingOn(pid)` until `count` backends wait, or 10 s have passed; answers the last count. */
async function untilWaiting(pid: number | undefined, count: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  let waiting = await waitingOn(pid);

  while (waiting < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    waiting = await waitingOn(pid);
  }

  return waiting;
}

/**
 * Criterion 3 (D242). A session created with `expiresAfterIdleSeconds` slides
 * by its own window: every use moves its expiry to a full window from now,
 * throttled to a tenth of a window shorter than 10 hours and to an hour
 * otherwise. The clock is moved as above, by setting the expiry: a session
 * whose expiry is `window - x` from now was last moved `x` ago.
 */
describe('an idle window slides by its own length (criterion 3, D242)', () => {
  it('moves a 1-hour session a full hour ahead on every use 7 minutes after the last move', async () => {
    const sessionId = await create({ expiresAfterIdleSeconds: 3600 });

    assert.equal(await idleSeconds(sessionId), 3600);
    await assertFullWindow(sessionId, 3600, 'at creation');

    for (const [name, use] of USES) {
      await setExpiry(sessionId, '53 minutes');

      const answered = await use(sessionId);

      assert.equal(answered.statusCode, 200, `${name}: ${answered.body}`);
      await assertFullWindow(sessionId, 3600, name);
      assert.equal((await ends(sessionId)).lifetimeEndsAt, null, name);
    }
  });

  it('writes nothing to a 1-hour session within 6 minutes of the last move', async () => {
    const sessionId = await create({ expiresAfterIdleSeconds: 3600 });

    for (const [name, use] of USES) {
      // Moved 5 minutes ago: within the throttle of a tenth of the window.
      await setExpiry(sessionId, '55 minutes');

      const before = await ends(sessionId);
      const answered = await use(sessionId);

      assert.equal(answered.statusCode, 200, `${name}: ${answered.body}`);
      assert.deepEqual(await ends(sessionId), before, name);
    }
  });

  for (const [window, inside, outside] of [
    // A tenth of the window below 10 hours, an hour from 10 hours up.
    [7200, '110 minutes', '100 minutes'],
    [36_000, '9 hours 30 minutes', '8 hours 50 minutes'],
    [86_400, '23 hours 30 minutes', '22 hours 30 minutes'],
    [604_800, '7 days -30 minutes', '7 days -90 minutes'],
  ] as const) {
    it(`throttles a ${window}-second session to ${Math.min(3600, window / 10)} s`, async () => {
      const sessionId = await create({ expiresAfterIdleSeconds: window });

      await setExpiry(sessionId, inside);

      const before = await ends(sessionId);

      assert.equal((await read(sessionId)).statusCode, 200);
      assert.deepEqual(await ends(sessionId), before, 'moved within the throttle');

      await setExpiry(sessionId, outside);
      assert.equal((await send(sessionId)).statusCode, 200);
      await assertFullWindow(sessionId, window, 'after the throttle');
    });
  }

  it('keeps the hour of throttle for a 7-day session, default or asked for, where a 1-hour one moves', async () => {
    const asked = await create({ expiresAfterIdleSeconds: 604_800 });
    const unasked = await create();
    const short = await create({ expiresAfterIdleSeconds: 3600 });

    for (const sessionId of [asked, unasked]) {
      // Moved 10 minutes ago: past a 1-hour session's 6 minutes, inside an hour.
      await setExpiry(sessionId, '7 days -10 minutes');

      const before = await ends(sessionId);

      for (const [name, use] of USES) {
        assert.equal((await use(sessionId)).statusCode, 200, name);
        assert.deepEqual(await ends(sessionId), before, name);
      }
    }

    await setExpiry(short, '50 minutes');
    assert.equal((await read(short)).statusCode, 200);
    await assertFullWindow(short, 3600, 'the 1-hour session');
  });

  it('never revives an expired 1-hour session, whatever uses it', async () => {
    const sessionId = await create({ expiresAfterIdleSeconds: 3600 });

    assert.equal((await send(sessionId)).statusCode, 200);
    await setExpiry(sessionId, '-1 second');

    const before = await ends(sessionId);

    for (const [name, use] of USES) {
      assertError(await use(sessionId), 410, 1002);
      assert.deepEqual(await ends(sessionId), before, name);
    }

    // The statement's own guard, reached directly: nothing written.
    assert.equal((await pool.query(REFRESH_SESSION_EXPIRY_SQL, [sessionId])).rowCount, 0);
    assert.deepEqual(await ends(sessionId), before);
    assert.equal(await requestCount(sessionId), 1);
  });

  it('writes once for two captures and a GET at once', async () => {
    const sessionId = await create({ expiresAfterIdleSeconds: 3600 });

    await setExpiry(sessionId, '40 minutes');

    // The row held as a capture holds it, and the first use's refresh made
    // under that lock; the three uses queue behind it, and once it commits each
    // finds the row a refresh has just moved.
    const holder = await pool.connect();
    let written: string | undefined;
    let uses: Promise<InjectedResponse>[];

    try {
      await holder.query('BEGIN');

      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid;

      await holder.query('SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
      assert.equal((await holder.query(REFRESH_SESSION_EXPIRY_SQL, [sessionId])).rowCount, 1);
      written = (
        await holder.query<{ expires_at: string }>(
          'SELECT expires_at::text AS expires_at FROM sessions WHERE id = $1',
          [sessionId],
        )
      ).rows[0]?.expires_at;

      uses = [send(sessionId), send(sessionId), read(sessionId)];

      // Until the first capture and the GET wait on the row, so that they
      // really run at once; the second capture waits for its turn of the
      // session's line (`inOrder`, D205) and runs once the first has ended.
      assert.equal(
        await untilWaiting(pid, 2),
        2,
        'the first capture and the GET did not both wait on the row',
      );
      await holder.query('COMMIT');
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    } finally {
      holder.release();
    }

    for (const answered of await Promise.all(uses)) {
      assert.equal(answered.statusCode, 200, answered.body);
    }

    // Byte-equal to what the first refresh wrote: none of the three wrote.
    assert.equal((await ends(sessionId)).expiresAt, written);
    assert.equal(await requestCount(sessionId), 2);
  });

  it('writes once for eight refreshes at once, the statement alone', async () => {
    const sessionId = await create({ expiresAfterIdleSeconds: 3600 });

    await setExpiry(sessionId, '40 minutes');

    const holder = await pool.connect();
    let refreshes: Promise<pg.QueryResult>[];

    try {
      await holder.query('BEGIN');

      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid;

      assert.equal((await holder.query(REFRESH_SESSION_EXPIRY_SQL, [sessionId])).rowCount, 1);
      refreshes = Array.from({ length: 8 }, () =>
        pool.query(REFRESH_SESSION_EXPIRY_SQL, [sessionId]),
      );
      assert.equal(await untilWaiting(pid, 8), 8, 'the refreshes did not all wait on the row');
      await holder.query('COMMIT');
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    } finally {
      holder.release();
    }

    // Each re-read the row the holder moved, which the throttle left alone.
    const written = (await Promise.all(refreshes)).map((result) => result.rowCount);

    assert.deepEqual(
      written,
      Array.from({ length: 8 }, () => 0),
    );
    await assertFullWindow(sessionId, 3600, 'after the refreshes');
  });
});

/**
 * The trigger of migration 013 (D242): whatever sets `expires_at` on a
 * session that slides gets at most a full window from now; a move back, as an
 * expiry, is left as written; a session with a lifetime is left to
 * `sessions_lifetime_cap` (D220).
 */
describe('every writer is held to the window (D242)', () => {
  it('caps an expiry set past the window at a full window from now', async () => {
    for (const window of [3600, 86_400, 604_800]) {
      const sessionId = await create({ expiresAfterIdleSeconds: window });

      await pool.query(
        "UPDATE sessions SET expires_at = clock_timestamp() + interval '30 days' WHERE id = $1",
        [sessionId],
      );
      await assertFullWindow(sessionId, window, `${window} s`);
    }
  });

  it('leaves a move back, and one within the window, as written', async () => {
    const sessionId = await create({ expiresAfterIdleSeconds: 3600 });

    for (const interval of ['30 minutes', '-1 minute', '59 minutes']) {
      await setExpiry(sessionId, interval);

      const result = await pool.query<{ exact: boolean }>(
        `SELECT expires_at BETWEEN clock_timestamp() + $2::interval - interval '5 seconds'
                               AND clock_timestamp() + $2::interval AS exact
           FROM sessions WHERE id = $1`,
        [sessionId, interval],
      );

      assert.equal(result.rows[0]?.exact, true, interval);
    }
  });

  it('leaves a session with a lifetime to its constraint', async () => {
    const sessionId = await create({ expiresInSeconds: 600 });

    await assert.rejects(
      pool.query(
        "UPDATE sessions SET expires_at = clock_timestamp() + interval '1 hour' WHERE id = $1",
        [sessionId],
      ),
      (error) => {
        assertCapRefusal(error);

        return true;
      },
    );
  });

  it('refuses a window outside the bounds in the row itself', async () => {
    const sessionId = await create();

    for (const value of [3599, 604_801, 0]) {
      await assert.rejects(
        pool.query('UPDATE sessions SET idle_seconds = $2 WHERE id = $1', [sessionId, value]),
        (error) => {
          const { code, constraint } = error as Error & { code?: string; constraint?: string };

          assert.equal(code, '23514');
          assert.equal(constraint, 'sessions_idle_window_range');

          return true;
        },
      );
    }

    await assert.rejects(
      pool.query('UPDATE sessions SET idle_seconds = NULL WHERE id = $1', [sessionId]),
      (error) => (error as { code?: string }).code === '23502',
    );
  });
});

/**
 * Criterion 6 (D242). The base image, 1.0.14 (`330492f`), keeps running on
 * this schema after a `helm rollback`, which never undoes a migration (D055),
 * and beside this image during a rolling update (D221). Its refresh and its
 * session insert, copied from `apps/backend/src/modules/sessions/repository.ts`
 * as they stood there, know nothing of `idle_seconds`: the refresh moves every
 * sliding session 7 days ahead, and the trigger holds it to the session's own
 * window.
 */
const BASE_IMAGE_REFRESH = `UPDATE sessions
        SET expires_at = clock_timestamp() + make_interval(days => $2)
      WHERE id = $1
        AND expires_at > clock_timestamp()
        AND expires_at < clock_timestamp() + make_interval(days => $2) - interval '1 hour'
        AND lifetime_ends_at IS NULL
  RETURNING expires_at`;

const BASE_IMAGE_SESSION_INSERT = `INSERT INTO sessions
       (id, expires_at, lifetime_ends_at, response_status, response_headers, response_body,
        response_delay_ms, response_queue, response_queue_answered)
     VALUES ($1,
             COALESCE(now() + make_interval(secs => $9), now() + make_interval(days => $2)),
             now() + make_interval(secs => $9),
             $3, $4::jsonb, $5, $6, $7::jsonb, $8)
     RETURNING id, expires_at, response_queue, response_queue_answered`;

/** The base image's capture, stripped to what decides the refresh, its refresh in its savepoint. */
async function captureAsBaseImage(sessionId: string): Promise<unknown> {
  const client = await pool.connect();
  let refused: unknown;

  try {
    await client.query('BEGIN');
    assert.equal((await client.query(PREVIOUS_IMAGE_CAPTURE_LOCK, [sessionId])).rowCount, 1);

    const body = Buffer.from('captured by the base image');

    await client.query(PREVIOUS_IMAGE_REQUEST_INSERT, [
      sessionId,
      'POST',
      `/s/${sessionId}`,
      '1.1',
      '',
      JSON.stringify([['content-type', 'text/plain']]),
      body,
      body.byteLength,
      Buffer.from(`POST /s/${sessionId} HTTP/1.1\r\n\r\n`),
      '203.0.113.7',
    ]);

    try {
      await client.query('SAVEPOINT refresh_expiry');
      await client.query(BASE_IMAGE_REFRESH, [sessionId, SESSION_IDLE_DAYS]);
      await client.query('RELEASE SAVEPOINT refresh_expiry');
    } catch (error) {
      refused = error;
      await client.query('ROLLBACK TO SAVEPOINT refresh_expiry');
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return refused;
}

describe('the base image on the new schema (criterion 6, D242)', () => {
  it('differs from this image’s refresh by the window read from the row and the throttle', () => {
    assert.equal(
      REFRESH_SESSION_EXPIRY_SQL,
      BASE_IMAGE_REFRESH.replaceAll(
        'make_interval(days => $2)',
        'make_interval(secs => idle_seconds)',
      ).replace(
        " - interval '1 hour'\n",
        "\n                         - least(interval '1 hour', make_interval(secs => idle_seconds / 10))\n",
      ),
    );
  });

  for (const window of [3600, 86_400]) {
    it(`leaves a ${window}-second session at most a full window ahead when its refresh slides it 7 days`, async () => {
      const sessionId = await create({ expiresAfterIdleSeconds: window });

      // Its throttle is an hour off 7 days, so it writes on every use of
      // such a session; the trigger holds each write to the window.
      await setExpiry(sessionId, '30 minutes');
      assert.equal(await captureAsBaseImage(sessionId), undefined);
      await assertFullWindow(sessionId, window, 'its capture');
      assert.equal(await requestCount(sessionId), 1);

      // Its read refreshes on the pool, outside a transaction (D133).
      await setExpiry(sessionId, '20 minutes');

      const returned = await pool.query<{ expires_at: Date }>(BASE_IMAGE_REFRESH, [
        sessionId,
        SESSION_IDLE_DAYS,
      ]);

      await assertFullWindow(sessionId, window, 'its read');
      // What it reports is what the row holds, the capped value.
      assert.equal(returned.rows[0]?.expires_at.getTime(), (await expiresAt(sessionId)).getTime());

      // This image reads the session as it was created.
      const details = (await read(sessionId)).json<{
        expiresAfterIdleSeconds: number | null;
        lifetimeEndsAt: string | null;
      }>();

      assert.deepEqual([details.expiresAfterIdleSeconds, details.lifetimeEndsAt], [window, null]);
    });
  }

  it('still slides a 7-day session 7 days ahead', async () => {
    const sessionId = await create();

    await setExpiry(sessionId, '2 days');
    assert.equal(await captureAsBaseImage(sessionId), undefined);
    await assertFullWindow(sessionId, 604_800, 'its capture');
  });

  it('creates sessions this image reads and slides as 7-day ones, as every row before the migration', async () => {
    const inserted = randomBytes(32).toString('base64url');

    await pool.query(BASE_IMAGE_SESSION_INSERT, [
      inserted,
      SESSION_IDLE_DAYS,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    createdSessionIds.push(inserted);
    assert.equal(await idleSeconds(inserted), 604_800);

    const details = (await read(inserted)).json<{
      expiresAfterIdleSeconds: number | null;
      lifetimeEndsAt: string | null;
    }>();

    assert.deepEqual([details.expiresAfterIdleSeconds, details.lifetimeEndsAt], [604_800, null]);

    await setExpiry(inserted, '7 days -90 minutes');
    assert.equal((await send(inserted)).statusCode, 200);
    await assertFullWindow(inserted, 604_800, 'slid by this image');
  });
});
