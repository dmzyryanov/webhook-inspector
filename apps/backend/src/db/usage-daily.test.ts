/**
 * Integration tests for the daily usage counters (D178, issue #49).
 *
 * Migration 008 creates `stats.usage_daily` and `stats.usage_daily_top`, the
 * function `public.record_usage_days()` that fills them, and the pg_cron job
 * that runs it every night.
 *
 * **Where the function is tested.** It records every day from its start to
 * yesterday, and its start depends on everything the database holds: the
 * latest recorded day, or else the earliest session or request anywhere. In
 * the shared test database its counts would take in every other test file's
 * rows, and the empty-database case would need all of them deleted; a
 * transaction holding those deletions and the usage tables would block the
 * files running beside this one and could deadlock with them
 * (`stats-views.test.ts` drops schema `stats` in a transaction of its own to
 * replay migration 007). So the function runs in a database of its own that
 * this file creates, migrates and drops at the end, and each test there runs in
 * a transaction that starts with no usage rows and is rolled back; only the
 * two tests that need a second transaction commit, and they delete what they
 * wrote. Its rows and its usage tables are its own. The cluster-wide role
 * `qa_readonly` is not: replaying 007 there runs its `ALTER ROLE` statements,
 * which set the values the role already has, and two writers of the role at
 * the same moment - `stats-views.test.ts`'s replay, or this file set up a
 * second time by `test-files-exit.test.ts` - fail the one that waited with
 * `tuple concurrently updated` once the other commits. So every replay of 007
 * in the suite is serialised by one advisory lock (`ROLE_REPLAY_LOCK`, issue
 * #255), which the set-up holds while it migrates the scratch database. The
 * lock is taken in the test database, not the scratch one: an advisory lock
 * meets only those taken in the same database, and the test database is the
 * one every replay shares, each set-up's scratch database being its own.
 * pg_cron can be created only in the database named
 * by `cron.database_name`, so migrations 002 and 006, which only manage its
 * jobs, are skipped there and 008's `cron.schedule` call meets a stand-in.
 *
 * **Where the job is tested.** In the test database, where pg_cron runs, by
 * reading `cron.job` and `cron.timezone` and by replaying the migration's
 * schedule call in a transaction that is rolled back.
 *
 * **The sender networks' 90 days** (D254, issue #165). Migration 020 schedules
 * a second job, which deletes the `sender_net` rows older than 90 UTC days,
 * and runs its statement once. The statement is read back from `cron.job` in
 * the test database and run in the scratch database, on rows of its own, for
 * the same reasons; the job itself is read, and the whole migration replayed,
 * in the test database, as the usage job is.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_REQUESTS_PER_SESSION } from '@webhook-inspector/shared';
import type pg from 'pg';
import { loadConfig } from '../config.ts';
import { createPool } from './pool.ts';

/** Migration 008's job, under the name migration 021 gives it (D278). */
const JOB_NAME = 'webhook-inspector-record-usage-days';
const JOB_SCHEDULE = '5 0 * * *';
const JOB_COMMAND = 'SELECT public.record_usage_days()';

/** Migration 020's job (D254): a day's sender networks are kept 90 UTC days. Under 021's name (D278). */
const NETS_JOB_NAME = 'webhook-inspector-delete-old-sender-nets';
/** The name 020 gave it, which 021 replaces. */
const NETS_JOB_NAME_020 = 'qa-tools-delete-old-sender-nets';
const NETS_JOB_SCHEDULE = '10 0 * * *';
const NETS_JOB_COMMAND =
  "DELETE FROM stats.usage_daily_top WHERE dimension = 'sender_net' AND day < (now() AT TIME ZONE 'UTC')::date - 90";

const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const NETS_MIGRATION = new URL('020_sender_net_retention.sql', MIGRATIONS);
/** The migration that schedules both jobs under their names since #323 (D278). */
const INSPECTOR_NAME_MIGRATION = new URL('021_rename_jobs_to_webhook_inspector.sql', MIGRATIONS);
/** They only manage pg_cron jobs, and pg_cron exists only in cron.database_name. */
const CRON_ONLY_MIGRATIONS = new Set([
  '002_expired_session_cleanup.sql',
  '006_rename_cleanup_job.sql',
  '021_rename_jobs_to_webhook_inspector.sql',
]);
/**
 * The advisory lock every replay of 007 in the backend suite holds while it
 * writes the role, taken in the test database: the same key as
 * `stats-views.test.ts`'s, above the 1 to 2^47 that `pool.test.ts` draws its
 * keys from (issue #255).
 */
const ROLE_REPLAY_LOCK = '255000000000000007';

const runId = randomUUID().replaceAll('-', '');
const scratchDatabase = `webhook_inspector_usage_test_${runId}`;

/** Two time zones on either side of UTC, far enough that local days differ from UTC ones. */
const AHEAD_OF_UTC = 'Pacific/Kiritimati';
const BEHIND_UTC = 'Pacific/Pago_Pago';

let main: pg.Pool;
let scratch: pg.Pool;
let startup: Promise<void> | undefined;

before(async () => {
  startup = setUp();
  await startup;
});

async function setUp(): Promise<void> {
  const databaseUrl = loadConfig().databaseUrl;
  main = createPool(databaseUrl);

  await main.query(`CREATE DATABASE ${scratchDatabase}`);

  const scratchUrl = new URL(databaseUrl);
  scratchUrl.pathname = `/${scratchDatabase}`;
  scratch = createPool(scratchUrl.href);

  await scratch.query(
    `CREATE SCHEMA cron;
     CREATE FUNCTION cron.schedule(text, text, text) RETURNS bigint
         LANGUAGE sql AS 'SELECT 0::bigint';`,
  );

  const files = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort();
  // A connection to the test database holds ROLE_REPLAY_LOCK until the last
  // migration has committed in the scratch one.
  const lock = await main.connect();

  try {
    await lock.query(`SELECT pg_advisory_lock(${ROLE_REPLAY_LOCK})`);

    for (const name of files) {
      if (!CRON_ONLY_MIGRATIONS.has(name)) {
        // As the migration runner sends it: one simple query holding every statement.
        await scratch.query(await readFile(new URL(name, MIGRATIONS), 'utf8'));
      }
    }
  } finally {
    // An unlock that fails ends the connection instead, which releases the
    // lock as well, and leaves the set-up's own error to be reported.
    await lock.query(`SELECT pg_advisory_unlock(${ROLE_REPLAY_LOCK})`).then(
      () => lock.release(),
      (error: Error) => lock.release(error),
    );
  }
}

after(async () => {
  // after() does not wait for an asynchronous before() when a name pattern
  // filters out every suite (D132), so it waits here; a failed set-up is
  // before()'s to report.
  await startup?.catch(() => undefined);
  await scratch?.end();

  if (main) {
    await dropScratchDatabase();
    await main.end();
  }
});

/**
 * `Pool.end()` resolves before the server has closed the pool's connections,
 * and `FORCE` ends a connection still closing with an error its client then
 * raises, so the drop waits until the database has no backend left. `FORCE`
 * stays for a connection that never went away.
 */
async function dropScratchDatabase(): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const { rows } = await main.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1',
      [scratchDatabase],
    );

    if (rows[0]?.count === 0) {
      break;
    }

    await delay(50);
  }

  await main.query(`DROP DATABASE IF EXISTS ${scratchDatabase} WITH (FORCE)`);
}

// ---------------------------------------------------------------------------
// Fixtures

type Client = pg.PoolClient;

/** Session ids are constrained by their length alone. */
function sessionId(label: string): string {
  return label.padEnd(43, '0');
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** An instant on a UTC day, written with its offset so the connection's TimeZone cannot move it. */
function at(day: string, time: string): string {
  return `${day}T${time}Z`;
}

interface SessionFixture {
  id: string;
  createdAt: string;
  responseStatus?: number;
  customDisabled?: boolean;
  /** `false` for a session that keeps no sender address (D243). */
  storeSourceIp?: boolean;
}

async function insertSession(client: Client, session: SessionFixture): Promise<void> {
  await client.query(
    `INSERT INTO sessions
       (id, created_at, expires_at, response_status, response_custom_disabled, store_source_ip)
     VALUES ($1, $2, $2::timestamptz + interval '7 days', $3, $4, $5)`,
    [
      session.id,
      session.createdAt,
      session.responseStatus ?? null,
      session.customDisabled ?? false,
      session.storeSourceIp ?? true,
    ],
  );
}

interface RequestFixture {
  sessionId: string;
  receivedAt: string;
  method?: string;
  headers?: [string, string][];
  /** Defaults to the endpoint itself; `null` is a request captured before paths were stored. */
  path?: string | null;
  sourceIp?: string | null;
  bodySize?: number;
  /** That many requests, one second apart from `receivedAt`. */
  count?: number;
}

async function insertRequests(client: Client, request: RequestFixture): Promise<void> {
  const body = Buffer.alloc(request.bodySize ?? 0);

  await client.query(
    `INSERT INTO requests
       (session_id, method, received_at, headers, body, body_size, raw_request, path, source_ip)
     SELECT $1, $2, $3::timestamptz + make_interval(secs => n - 1), $4::jsonb, $5, $6, $5, $7, $8
     FROM generate_series(1, $9::int) AS n`,
    [
      request.sessionId,
      request.method ?? 'POST',
      request.receivedAt,
      JSON.stringify(request.headers ?? []),
      body,
      body.byteLength,
      request.path === undefined ? `/s/${request.sessionId}` : request.path,
      request.sourceIp ?? null,
      request.count ?? 1,
    ],
  );
}

/**
 * Runs `body` on the scratch database in a transaction that starts with no
 * usage rows, with the connection's TimeZone set to `timeZone`, and is always
 * rolled back. `now()`, and so the function's yesterday, is fixed for the
 * whole transaction, so the fixtures and the run agree on it.
 */
async function inScratchTransaction(
  body: (client: Client, yesterday: string) => Promise<void>,
  timeZone = 'UTC',
): Promise<void> {
  const client = await scratch.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('TimeZone', $1, true)`, [timeZone]);
    await client.query('DELETE FROM stats.usage_daily_top');
    await client.query('DELETE FROM stats.usage_daily');

    await body(client, await yesterdayOf(client));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function yesterdayOf(client: Client | pg.Pool): Promise<string> {
  const { rows } = await client.query<{ day: string }>(
    `SELECT ((now() AT TIME ZONE 'UTC')::date - 1)::text AS day`,
  );

  return rows[0]?.day as string;
}

async function recordUsageDays(client: Client | pg.Pool): Promise<number> {
  const { rows } = await client.query<{ days: number }>(
    'SELECT public.record_usage_days() AS days',
  );

  return rows[0]?.days as number;
}

interface DailyRow {
  day: string;
  sessions_created: number;
  sessions_created_with_requests: number;
  sessions_with_requests: number;
  sessions_returning: number;
  requests_captured: number;
  sender_nets: number;
  body_bytes_total: number;
  body_bytes_max: number;
  sessions_custom_response: number;
  requests_with_subpath: number;
  sessions_at_request_limit: number;
  /** Whether `database_bytes` is set; its value is checked separately. */
  database_bytes_set: boolean;
}

async function dailyRows(client: Client | pg.Pool): Promise<DailyRow[]> {
  const { rows } = await client.query<DailyRow>(
    `SELECT day::text AS day, sessions_created, sessions_created_with_requests,
            sessions_with_requests, sessions_returning, requests_captured, sender_nets,
            body_bytes_total::int AS body_bytes_total, body_bytes_max, sessions_custom_response,
            requests_with_subpath, sessions_at_request_limit,
            database_bytes IS NOT NULL AS database_bytes_set
     FROM stats.usage_daily ORDER BY day`,
  );

  return rows;
}

interface TopRow {
  day: string;
  dimension: string;
  value: string;
  requests: number;
  sessions: number;
}

async function topRows(client: Client | pg.Pool, day?: string): Promise<TopRow[]> {
  const { rows } = await client.query<TopRow>(
    `SELECT day::text AS day, dimension, value, requests, sessions
     FROM stats.usage_daily_top
     WHERE $1::date IS NULL OR day = $1::date
     ORDER BY day, dimension, requests DESC, value COLLATE "C"`,
    [day ?? null],
  );

  return rows;
}

/** A day with nothing in it: every count zero. */
function quietDay(day: string, databaseBytesSet = false): DailyRow {
  return {
    day,
    sessions_created: 0,
    sessions_created_with_requests: 0,
    sessions_with_requests: 0,
    sessions_returning: 0,
    requests_captured: 0,
    sender_nets: 0,
    body_bytes_total: 0,
    body_bytes_max: 0,
    sessions_custom_response: 0,
    requests_with_subpath: 0,
    sessions_at_request_limit: 0,
    database_bytes_set: databaseBytesSet,
  };
}

const LONG_USER_AGENT = `agent/${'x'.repeat(300)}`;

/**
 * A busy day and the days around it, relative to yesterday (Y): the day before
 * it (Y-4), the busy day (Y-3), the day after it (Y-2), a quiet day (Y-1) and
 * yesterday. The boundary instants - 00:00:00 and 23:59:59.999 UTC - fall on
 * other local days in both time zones the test uses.
 */
interface BusyDays {
  before: string;
  busy: string;
  next: string;
  quiet: string;
}

async function seedBusyDay(client: Client, yesterday: string): Promise<BusyDays> {
  const before = addDays(yesterday, -4);
  const busy = addDays(yesterday, -3);
  const next = addDays(yesterday, -2);
  const ids = {
    returning: sessionId('returning'),
    custom: sessionId('custom'),
    disabled: sessionId('disabled'),
    full: sessionId('full'),
    almostFull: sessionId('almost-full'),
    idle: sessionId('idle'),
    late: sessionId('late'),
  };

  // Created the day before, captures on both days.
  await insertSession(client, { id: ids.returning, createdAt: at(before, '12:00:00') });
  await insertRequests(client, {
    sessionId: ids.returning,
    receivedAt: at(before, '12:05:00'),
    method: 'GET',
    headers: [['User-Agent', 'curl/8.7.1']],
    sourceIp: '203.0.113.7',
    bodySize: 5,
  });
  await insertRequests(client, {
    sessionId: ids.returning,
    receivedAt: at(busy, '00:00:00'),
    method: 'POST',
    headers: [
      ['user-agent', 'curl/8.7.1'],
      ['Content-Type', 'Application/JSON; charset=utf-8'],
    ],
    path: `/s/${ids.returning}/stripe/events`,
    sourceIp: '203.0.113.200',
    bodySize: 100,
  });

  // An active custom response.
  await insertSession(client, {
    id: ids.custom,
    createdAt: at(busy, '01:00:00'),
    responseStatus: 201,
  });
  await insertRequests(client, {
    sessionId: ids.custom,
    receivedAt: at(busy, '01:10:00'),
    method: 'POST',
    headers: [
      ['CONTENT-TYPE', 'text/plain'],
      ['content-type', 'application/xml'],
      ['User-Agent', LONG_USER_AGENT],
    ],
    // A lone `/` after the id is not a path.
    path: `/s/${ids.custom}/`,
    sourceIp: '2001:db8:1:2::5',
    bodySize: 300,
  });
  await insertRequests(client, {
    sessionId: ids.custom,
    receivedAt: at(busy, '23:59:59.999'),
    method: 'PUT',
    headers: [['Content-Type', 'Text/CSV ;header=present']],
    // Captured before paths were stored (D110).
    path: null,
    sourceIp: '2001:db8:1:ffff::1',
  });

  // A custom response kept but switched to the default (D151).
  await insertSession(client, {
    id: ids.disabled,
    createdAt: at(busy, '02:00:00'),
    responseStatus: 202,
    customDisabled: true,
  });
  await insertRequests(client, {
    sessionId: ids.disabled,
    receivedAt: at(busy, '02:30:00'),
    method: 'PROPFIND',
    headers: [['User-Agent', 'Stripe/1.0']],
    path: `/s/${ids.disabled}/folder/`,
    sourceIp: null,
    bodySize: 50,
  });
  await insertRequests(client, {
    sessionId: ids.disabled,
    receivedAt: at(busy, '02:31:00'),
    method: 'POST',
    headers: [
      ['User-Agent', 'Stripe/1.0'],
      ['Content-Type', 'application/json'],
    ],
    sourceIp: 'not an address',
    bodySize: 20,
  });

  // One session at the request limit, one just below it.
  await insertSession(client, { id: ids.full, createdAt: at(busy, '03:00:00') });
  await insertRequests(client, {
    sessionId: ids.full,
    receivedAt: at(busy, '03:00:01'),
    method: 'GET',
    count: MAX_REQUESTS_PER_SESSION,
  });
  await insertSession(client, { id: ids.almostFull, createdAt: at(busy, '05:00:00') });
  await insertRequests(client, {
    sessionId: ids.almostFull,
    receivedAt: at(busy, '05:00:01'),
    method: 'GET',
    sourceIp: '198.51.100.9',
    count: MAX_REQUESTS_PER_SESSION - 1,
  });

  // Created on the busy day with nothing captured, and created at its last
  // second with its first capture at the next day's first.
  await insertSession(client, { id: ids.idle, createdAt: at(busy, '07:00:00') });
  await insertSession(client, { id: ids.late, createdAt: at(busy, '23:59:59') });
  await insertRequests(client, {
    sessionId: ids.late,
    receivedAt: at(next, '00:00:00'),
    method: 'GET',
    sourceIp: '192.0.2.1',
    bodySize: 7,
  });

  return { before, busy, next, quiet: addDays(yesterday, -1) };
}

// ---------------------------------------------------------------------------

describe('record_usage_days()', () => {
  it('was run by the migration, which recorded yesterday of the new, empty database', async () => {
    const { rows } = await scratch.query<{ day: string; expected: string }>(
      `SELECT day::text AS day, ((recorded_at AT TIME ZONE 'UTC')::date - 1)::text AS expected
       FROM stats.usage_daily`,
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.day, rows[0]?.expected);
    assert.deepEqual(await dailyRows(scratch), [quietDay(rows[0]?.day as string, true)]);
    assert.deepEqual(await topRows(scratch), []);
  });

  for (const timeZone of [AHEAD_OF_UTC, BEHIND_UTC]) {
    it(`counts every column of a busy day by UTC days, with the connection in ${timeZone}`, async () => {
      await inScratchTransaction(async (client, yesterday) => {
        const days = await seedBusyDay(client, yesterday);

        assert.equal(await recordUsageDays(client), 5);
        assert.deepEqual(await dailyRows(client), [
          {
            ...quietDay(days.before),
            sessions_created: 1,
            sessions_created_with_requests: 1,
            sessions_with_requests: 1,
            requests_captured: 1,
            sender_nets: 1,
            body_bytes_total: 5,
            body_bytes_max: 5,
          },
          {
            day: days.busy,
            // custom, disabled, full, almost-full, idle, late
            sessions_created: 6,
            // custom, disabled, full, almost-full: idle captured nothing, late
            // captured its first request the next day
            sessions_created_with_requests: 4,
            // returning, custom, disabled, full, almost-full
            sessions_with_requests: 5,
            sessions_returning: 1,
            requests_captured: 1 + 2 + 2 + MAX_REQUESTS_PER_SESSION + MAX_REQUESTS_PER_SESSION - 1,
            // 203.0.113.0/24, 2001:db8:1::/48 twice, 198.51.100.0/24; the
            // missing and the unreadable address are not counted
            sender_nets: 3,
            body_bytes_total: 100 + 300 + 50 + 20,
            body_bytes_max: 300,
            // custom; disabled keeps a custom response it does not answer
            sessions_custom_response: 1,
            // /stripe/events and /folder/; not the lone `/`, the NULL path or
            // the endpoint itself
            requests_with_subpath: 2,
            // full, not almost-full
            sessions_at_request_limit: 1,
            database_bytes_set: false,
          },
          {
            ...quietDay(days.next),
            sessions_with_requests: 1,
            sessions_returning: 1,
            requests_captured: 1,
            sender_nets: 1,
            body_bytes_total: 7,
            body_bytes_max: 7,
          },
          quietDay(days.quiet),
          quietDay(yesterday, true),
        ]);
      }, timeZone);
    });
  }

  it('keeps the normalised top values of each dimension', async () => {
    await inScratchTransaction(async (client, yesterday) => {
      const days = await seedBusyDay(client, yesterday);

      await recordUsageDays(client);

      assert.deepEqual(await topRows(client, days.busy), [
        // First Content-Type header, media type only, trimmed, lower case.
        { day: days.busy, dimension: 'content_type', value: '<none>', requests: 2000, sessions: 3 },
        {
          day: days.busy,
          dimension: 'content_type',
          value: 'application/json',
          requests: 2,
          sessions: 2,
        },
        { day: days.busy, dimension: 'content_type', value: 'text/csv', requests: 1, sessions: 1 },
        {
          day: days.busy,
          dimension: 'content_type',
          value: 'text/plain',
          requests: 1,
          sessions: 1,
        },
        // As stored.
        { day: days.busy, dimension: 'method', value: 'GET', requests: 1999, sessions: 2 },
        { day: days.busy, dimension: 'method', value: 'POST', requests: 3, sessions: 3 },
        { day: days.busy, dimension: 'method', value: 'PROPFIND', requests: 1, sessions: 1 },
        { day: days.busy, dimension: 'method', value: 'PUT', requests: 1, sessions: 1 },
        // /24 and /48 as text; missing and unreadable alike.
        {
          day: days.busy,
          dimension: 'sender_net',
          value: '<unknown>',
          requests: 1002,
          sessions: 2,
        },
        {
          day: days.busy,
          dimension: 'sender_net',
          value: '198.51.100.0/24',
          requests: 999,
          sessions: 1,
        },
        {
          day: days.busy,
          dimension: 'sender_net',
          value: '2001:db8:1::/48',
          requests: 2,
          sessions: 1,
        },
        {
          day: days.busy,
          dimension: 'sender_net',
          value: '203.0.113.0/24',
          requests: 1,
          sessions: 1,
        },
        // First User-Agent header, whatever its spelling, cut to 200 characters.
        { day: days.busy, dimension: 'user_agent', value: '<none>', requests: 2000, sessions: 3 },
        { day: days.busy, dimension: 'user_agent', value: 'Stripe/1.0', requests: 2, sessions: 1 },
        {
          day: days.busy,
          dimension: 'user_agent',
          value: LONG_USER_AGENT.slice(0, 200),
          requests: 1,
          sessions: 1,
        },
        { day: days.busy, dimension: 'user_agent', value: 'curl/8.7.1', requests: 1, sessions: 1 },
      ]);
      assert.deepEqual(await topRows(client, days.next), [
        { day: days.next, dimension: 'content_type', value: '<none>', requests: 1, sessions: 1 },
        { day: days.next, dimension: 'method', value: 'GET', requests: 1, sessions: 1 },
        {
          day: days.next,
          dimension: 'sender_net',
          value: '192.0.2.0/24',
          requests: 1,
          sessions: 1,
        },
        { day: days.next, dimension: 'user_agent', value: '<none>', requests: 1, sessions: 1 },
      ]);
      assert.deepEqual(await topRows(client, days.quiet), []);
      assert.deepEqual(await topRows(client, yesterday), []);
    });
  });

  it('counts the requests of a session that keeps no sender address as <unknown>, whatever its writer gave (D243)', async () => {
    await inScratchTransaction(async (client, yesterday) => {
      const opted = sessionId('nosource');
      const kept = sessionId('keepsource');

      await insertSession(client, {
        id: opted,
        createdAt: at(yesterday, '08:00:00'),
        storeSourceIp: false,
      });
      await insertSession(client, { id: kept, createdAt: at(yesterday, '08:00:00') });
      // Written with an address, as the previous image writes it: the
      // trigger of migration 014 keeps none for the opted-out session.
      await insertRequests(client, {
        sessionId: opted,
        receivedAt: at(yesterday, '09:00:00'),
        sourceIp: '203.0.113.7',
        count: 3,
      });
      await insertRequests(client, {
        sessionId: kept,
        receivedAt: at(yesterday, '09:00:00'),
        sourceIp: '203.0.113.7',
        count: 2,
      });

      const stored = await client.query<{ session_id: string; source_ip: string | null }>(
        `SELECT DISTINCT session_id, source_ip FROM requests WHERE session_id = ANY($1)
         ORDER BY session_id`,
        [[opted, kept]],
      );

      assert.deepEqual(stored.rows, [
        { session_id: kept, source_ip: '203.0.113.7' },
        { session_id: opted, source_ip: null },
      ]);

      await recordUsageDays(client);

      assert.deepEqual(
        (await topRows(client, yesterday)).filter((row) => row.dimension === 'sender_net'),
        [
          {
            day: yesterday,
            dimension: 'sender_net',
            value: '<unknown>',
            requests: 3,
            sessions: 1,
          },
          {
            day: yesterday,
            dimension: 'sender_net',
            value: '203.0.113.0/24',
            requests: 2,
            sessions: 1,
          },
        ],
      );

      const [day] = (await dailyRows(client)).filter((row) => row.day === yesterday);

      // A missing address is no network: the one counted is the default session's.
      assert.equal(day?.sender_nets, 1);
      assert.equal(day?.requests_captured, 5);
    });
  });

  it('keeps 20 values per dimension, by requests and then by value in byte order', async () => {
    // 25 values in every dimension. One sent most often and sorting last; 16
    // sent 3 times; four tied at 2 across the cut, two of them upper case, so
    // byte order and a linguistic collation keep different ones; four sent
    // once, one of them sorting first.
    interface Sent {
      value: string;
      contentType: string;
      count: number;
    }
    const sent: Sent[] = [
      { value: 'zz-most', contentType: 'ZZ/Most; q=1', count: 4 },
      ...Array.from({ length: 16 }, (_, index) => ({
        value: `v-${String(index + 1).padStart(2, '0')}`,
        contentType: `Application/V-${String(index + 1).padStart(2, '0')}; charset=utf-8`,
        count: 3,
      })),
      ...['Zeta', 'alpha', 'beta', 'Omega'].map((value) => ({
        value,
        contentType: value,
        count: 2,
      })),
      ...['AAA-rare', 'v-17', 'v-18', 'v-19'].map((value) => ({
        value,
        contentType: value,
        count: 1,
      })),
    ];
    const nets = sent.map((_, index) => `10.${index}.7.0/24`);
    const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

    function expectedTop(
      day: string,
      dimension: string,
      valueOf: (item: Sent, index: number) => string,
    ) {
      return sent
        .map((item, index) => ({ value: valueOf(item, index), count: item.count }))
        .sort((a, b) => b.count - a.count || byteOrder(a.value, b.value))
        .slice(0, 20)
        .map(({ value, count }) => ({
          day,
          dimension,
          value,
          requests: count,
          // Alternating between two sessions.
          sessions: Math.min(count, 2),
        }));
    }

    await inScratchTransaction(async (client, yesterday) => {
      const day = addDays(yesterday, -1);
      const sessions = [sessionId('top-a'), sessionId('top-b')];

      for (const id of sessions) {
        await insertSession(client, { id, createdAt: at(day, '00:00:00') });
      }

      for (const [index, item] of sent.entries()) {
        for (let copy = 0; copy < item.count; copy += 1) {
          await insertRequests(client, {
            sessionId: sessions[copy % 2] as string,
            receivedAt: at(
              day,
              `01:${String(index).padStart(2, '0')}:${String(copy).padStart(2, '0')}`,
            ),
            method: item.value,
            headers: [
              ['User-Agent', item.value],
              ['Content-Type', item.contentType],
            ],
            sourceIp: `10.${index}.7.${copy + 1}`,
          });
        }
      }

      await recordUsageDays(client);

      const top = await topRows(client, day);
      const of = (dimension: string) => top.filter((row) => row.dimension === dimension);

      assert.deepEqual(
        of('content_type'),
        expectedTop(
          day,
          'content_type',
          (item) => item.contentType.split(';')[0]?.trim().toLowerCase() as string,
        ),
      );
      assert.deepEqual(
        of('method'),
        expectedTop(day, 'method', (item) => item.value),
      );
      assert.deepEqual(
        of('sender_net'),
        expectedTop(day, 'sender_net', (_, index) => nets[index] as string),
      );
      assert.deepEqual(
        of('user_agent'),
        expectedTop(day, 'user_agent', (item) => item.value),
      );

      // Spelled out, so the rule the expectations share is visible: the most
      // sent first although it sorts last, upper case before lower case in the
      // tie, and a value sent once cut although it sorts first.
      const agents = of('user_agent').map((row) => row.value);
      assert.equal(agents[0], 'zz-most');
      assert.deepEqual(agents.slice(17), ['Omega', 'Zeta', 'alpha']);
      assert.equal(agents.includes('beta'), false);
      assert.equal(agents.includes('AAA-rare'), false);
    });
  });

  it('with nothing recorded, starts at the earliest session', async () => {
    await inScratchTransaction(async (client, yesterday) => {
      await insertSession(client, {
        id: sessionId('earliest-session'),
        createdAt: at(addDays(yesterday, -5), '00:00:00'),
      });
      await insertRequests(client, {
        sessionId: sessionId('earliest-session'),
        receivedAt: at(addDays(yesterday, -2), '10:00:00'),
      });

      assert.equal(await recordUsageDays(client), 6);
      assert.deepEqual(
        (await dailyRows(client)).map((row) => row.day),
        [-5, -4, -3, -2, -1, 0].map((offset) => addDays(yesterday, offset)),
      );
    }, BEHIND_UTC);
  });

  it('with nothing recorded, starts at the earliest request', async () => {
    await inScratchTransaction(async (client, yesterday) => {
      // Received before its session was created: nothing in the schema forbids
      // it, and it makes the requests the earlier of the two.
      await insertSession(client, {
        id: sessionId('earliest-request'),
        createdAt: at(addDays(yesterday, -1), '12:00:00'),
      });
      await insertRequests(client, {
        sessionId: sessionId('earliest-request'),
        receivedAt: at(addDays(yesterday, -3), '23:59:59.999'),
      });

      assert.equal(await recordUsageDays(client), 4);
      assert.equal((await dailyRows(client))[0]?.day, addDays(yesterday, -3));
    }, AHEAD_OF_UTC);
  });

  it('starts the day after the latest recorded day and never rewrites a recorded one', async () => {
    await inScratchTransaction(async (client, yesterday) => {
      const recorded = addDays(yesterday, -3);

      await client.query(
        `INSERT INTO stats.usage_daily
           (day, sessions_created, sessions_created_with_requests, sessions_with_requests,
            sessions_returning, requests_captured, sender_nets, body_bytes_total, body_bytes_max,
            sessions_custom_response, requests_with_subpath, sessions_at_request_limit,
            database_bytes, recorded_at)
         VALUES ($1, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, '2000-01-01T00:00:00Z')`,
        [recorded],
      );
      await insertSession(client, {
        id: sessionId('around'),
        createdAt: at(addDays(yesterday, -5), '08:00:00'),
      });

      for (const offset of [-5, -4, -3, -2]) {
        await insertRequests(client, {
          sessionId: sessionId('around'),
          receivedAt: at(addDays(yesterday, offset), '08:00:00'),
        });
      }

      assert.equal(await recordUsageDays(client), 3);

      const { rows } = await client.query<{
        day: string;
        requests_captured: number;
        recorded_at: string;
      }>(
        `SELECT day::text AS day, requests_captured, recorded_at::text AS recorded_at
         FROM stats.usage_daily ORDER BY day`,
      );
      assert.deepEqual(
        rows.map((row) => [row.day, row.requests_captured]),
        [
          [recorded, 45],
          [addDays(yesterday, -2), 1],
          [addDays(yesterday, -1), 0],
          [yesterday, 0],
        ],
      );
      assert.equal(rows[0]?.recorded_at, '2000-01-01 00:00:00+00');
      assert.deepEqual(await topRows(client, recorded), []);
    });
  });

  it('with no data at all, records yesterday alone', async () => {
    await inScratchTransaction(async (client, yesterday) => {
      assert.equal(await recordUsageDays(client), 1);
      assert.deepEqual(await dailyRows(client), [quietDay(yesterday, true)]);
      assert.deepEqual(await topRows(client), []);
    }, AHEAD_OF_UTC);
  });

  it('records nothing once yesterday is recorded', async () => {
    await inScratchTransaction(async (client, yesterday) => {
      assert.equal(await recordUsageDays(client), 1);
      assert.equal(await recordUsageDays(client), 0);
      assert.deepEqual(await dailyRows(client), [quietDay(yesterday, true)]);
    });
  });

  it('sets database_bytes for yesterday alone, and leaves it NULL for a backfilled day', async () => {
    await inScratchTransaction(async (client, yesterday) => {
      await insertSession(client, {
        id: sessionId('backfill'),
        createdAt: at(addDays(yesterday, -2), '12:00:00'),
      });

      await recordUsageDays(client);

      const { rows } = await client.query<{
        day: string;
        database_bytes: string | null;
        size_now: string;
      }>(
        `SELECT day::text AS day, database_bytes::text AS database_bytes,
                pg_database_size(current_database())::text AS size_now
         FROM stats.usage_daily ORDER BY day`,
      );

      assert.deepEqual(
        rows.map((row) => [row.day, row.database_bytes === null]),
        [
          [addDays(yesterday, -2), true],
          [addDays(yesterday, -1), true],
          [yesterday, false],
        ],
      );

      // The size of the database when the day was recorded: the run's own
      // inserts may have grown it since, never shrunk it.
      const recorded = Number(rows[2]?.database_bytes);
      assert.ok(recorded > 0 && recorded <= Number(rows[2]?.size_now), String(recorded));
    });
  });
});

describe('record_usage_days() across transactions', () => {
  /** Committed rows, so each test removes what it wrote. */
  async function clearScratch(): Promise<void> {
    await scratch.query('DELETE FROM stats.usage_daily_top');
    await scratch.query('DELETE FROM stats.usage_daily');
    await scratch.query('DELETE FROM sessions');
  }

  async function seedCommitted(yesterday: string): Promise<void> {
    const client = await scratch.connect();

    try {
      await insertSession(client, {
        id: sessionId('committed'),
        createdAt: at(addDays(yesterday, -2), '09:00:00'),
      });
      await insertRequests(client, {
        sessionId: sessionId('committed'),
        receivedAt: at(addDays(yesterday, -1), '09:00:00'),
        headers: [['User-Agent', 'curl/8.7.1']],
        sourceIp: '203.0.113.7',
        bodySize: 12,
        count: 3,
      });
    } finally {
      client.release();
    }
  }

  async function snapshot(): Promise<unknown[]> {
    const { rows: daily } = await scratch.query('SELECT * FROM stats.usage_daily ORDER BY day');
    const { rows: top } = await scratch.query(
      'SELECT * FROM stats.usage_daily_top ORDER BY day, dimension, value COLLATE "C"',
    );

    return [daily, top];
  }

  it('changes nothing on a second run, nor after the rows it counted are deleted', async () => {
    try {
      await clearScratch();
      const yesterday = await yesterdayOf(scratch);
      await seedCommitted(yesterday);

      assert.equal(await recordUsageDays(scratch), 3);
      const recorded = await snapshot();
      assert.equal((recorded[0] as unknown[]).length, 3);

      assert.equal(await recordUsageDays(scratch), 0);
      assert.deepEqual(await snapshot(), recorded);

      await scratch.query('DELETE FROM sessions');

      assert.equal(await recordUsageDays(scratch), 0);
      assert.deepEqual(await snapshot(), recorded);
    } finally {
      await clearScratch();
    }
  });

  it('lets a run that overlaps another wait for it, then record nothing and not fail', async () => {
    const first = await scratch.connect();
    const second = await scratch.connect();
    let secondRun: Promise<{ days: number } | { error: unknown }> | undefined;

    try {
      await clearScratch();
      const yesterday = await yesterdayOf(scratch);
      await seedCommitted(yesterday);

      await first.query('BEGIN');
      assert.equal(await recordUsageDays(first), 3);

      const { rows: backend } = await second.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      secondRun = recordUsageDays(second).then(
        (days) => ({ days }),
        (error: unknown) => ({ error }),
      );

      // The second run is really overlapping: it waits on the first's lock.
      const deadline = Date.now() + 10_000;
      let waiting = false;

      while (!waiting && Date.now() < deadline) {
        const { rows } = await scratch.query<{ wait_event_type: string | null }>(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
          [backend[0]?.pid],
        );
        waiting = rows[0]?.wait_event_type === 'Lock';

        if (!waiting) {
          await delay(50);
        }
      }

      assert.equal(waiting, true, 'the second run never waited for the first');

      await first.query('COMMIT');
      const recorded = await snapshot();

      assert.deepEqual(await secondRun, { days: 0 });
      assert.deepEqual(await snapshot(), recorded);
      assert.equal((recorded[0] as unknown[]).length, 3);
    } finally {
      // After a failure the first may still hold the lock the second waits on.
      await first.query('ROLLBACK').catch(() => undefined);
      await secondRun;
      first.release();
      second.release();
      await clearScratch();
    }
  });
});

describe('the usage job', () => {
  it('is registered once, at 00:05 every day, running the function', async () => {
    const { rows } = await main.query<{
      schedule: string;
      command: string;
      active: boolean;
      database: string;
      here: string;
    }>(
      `SELECT schedule, command, active, database, current_database() AS here
       FROM cron.job WHERE jobname = $1`,
      [JOB_NAME],
    );

    assert.equal(rows.length, 1, `${JOB_NAME} is not registered exactly once`);
    assert.equal(rows[0]?.schedule, JOB_SCHEDULE);
    assert.equal(rows[0]?.command, JOB_COMMAND);
    assert.equal(rows[0]?.active, true);
    assert.equal(rows[0]?.database, rows[0]?.here);
  });

  it('reads its schedule in GMT, so it runs at 00:05 UTC', async () => {
    // pg_cron's default; neither the chart nor docker-compose.yml sets it.
    const { rows } = await main.query<{ timezone: string }>(
      `SELECT current_setting('cron.timezone') AS timezone`,
    );

    assert.ok(['GMT', 'UTC'].includes(rows[0]?.timezone as string), rows[0]?.timezone);
  });

  it('stays one job when the migration that names it schedules it again', async () => {
    // Migration 008 scheduled it, under the name 021 has replaced (D278).
    const migration = await readFile(INSPECTOR_NAME_MIGRATION, 'utf8');
    const schedule = new RegExp(`^SELECT cron\\.schedule\\(\\s*'${JOB_NAME}',[^;]*\\);$`, 'm').exec(
      migration,
    )?.[0];

    assert.ok(schedule, 'migration 021 no longer schedules the job with one cron.schedule call');

    const client = await main.connect();

    try {
      await client.query('BEGIN');
      await client.query(schedule);
      await client.query(schedule);

      const { rows } = await client.query<{ schedule: string; command: string }>(
        'SELECT schedule, command FROM cron.job WHERE jobname = $1',
        [JOB_NAME],
      );

      assert.deepEqual(rows, [{ schedule: JOB_SCHEDULE, command: JOB_COMMAND }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// The sender networks' 90 days (D254, issue #165)

/** The statement migration 020's job runs, read back from the test database's `cron.job`. */
async function registeredNetsRemoval(): Promise<string> {
  const { rows } = await main.query<{ command: string }>(
    'SELECT command FROM cron.job WHERE jobname = $1 AND database = current_database()',
    [NETS_JOB_NAME],
  );

  assert.equal(rows.length, 1, `${NETS_JOB_NAME} is not registered once against the test database`);

  return (rows[0] as { command: string }).command;
}

/**
 * T, the UTC day of `now()` - fixed for a whole transaction - read as seconds
 * since the epoch, so that neither the connection's TimeZone nor the
 * statement under test's own expression gives it.
 */
async function utcTodayOf(client: Client | pg.Pool): Promise<string> {
  const { rows } = await client.query<{ epoch: number }>(
    'SELECT extract(epoch FROM now())::float8 AS epoch',
  );

  return new Date((rows[0]?.epoch as number) * 1000).toISOString().slice(0, 10);
}

/** Each recorded day's top values: one of each other dimension and three networks, `<unknown>` among them. */
const RECORDED_VALUES: [string, string][] = [
  ['user_agent', 'curl/8.7.1'],
  ['content_type', 'application/json'],
  ['method', 'POST'],
  ['sender_net', '203.0.113.0/24'],
  ['sender_net', '2001:db8:1::/48'],
  ['sender_net', '<unknown>'],
];

/** A recorded day for each of `days`: its totals, its deletions and its top values. */
async function seedRecordedDays(client: Client | pg.Pool, days: string[]): Promise<void> {
  for (const [index, day] of days.entries()) {
    await client.query(
      `INSERT INTO stats.usage_daily
         (day, sessions_created, sessions_created_with_requests, sessions_with_requests,
          sessions_returning, requests_captured, sender_nets, body_bytes_total, body_bytes_max,
          sessions_custom_response, requests_with_subpath, sessions_at_request_limit)
       VALUES ($1, 1, 1, 1, 0, $2, 2, 30, 10, 0, 0, 0)`,
      [day, index + 3],
    );
    await client.query(
      'INSERT INTO stats.deletions_daily (day, sessions_deleted, requests_held) VALUES ($1, 1, $2)',
      [day, index + 3],
    );

    for (const [dimension, value] of RECORDED_VALUES) {
      await client.query(
        `INSERT INTO stats.usage_daily_top (day, dimension, value, requests, sessions)
         VALUES ($1, $2, $3, $4, 1)`,
        [day, dimension, value, index + 1],
      );
    }
  }
}

interface StatsSnapshot {
  daily: unknown[];
  deletions: unknown[];
  top: TopRow[];
}

/** Every row of the three tables, whole. */
async function statsSnapshot(client: Client | pg.Pool): Promise<StatsSnapshot> {
  const { rows: daily } = await client.query('SELECT * FROM stats.usage_daily ORDER BY day');
  const { rows: deletions } = await client.query(
    'SELECT * FROM stats.deletions_daily ORDER BY day',
  );

  return { daily, deletions, top: await topRows(client) };
}

/** A snapshot's networks, as `<day> <value>`. */
function networks(top: TopRow[]): string[] {
  return top
    .filter((row) => row.dimension === 'sender_net')
    .map((row) => `${row.day} ${row.value}`);
}

describe('the removal of old sender networks (D254)', () => {
  // On UTC day T, T-90 is the oldest day that keeps its networks. A statement
  // reading the day from the connection's TimeZone, as current_date does,
  // would remove T-90 in Kiritimati from 10:00 UTC, or keep T-91 in Pago Pago
  // before 11:00 UTC, so one of the two fails it at any hour.
  for (const timeZone of [AHEAD_OF_UTC, BEHIND_UTC]) {
    it(`keeps a day's networks 90 UTC days, <unknown> among them, then removes them and nothing else, with the connection in ${timeZone}`, async () => {
      const removal = await registeredNetsRemoval();

      await inScratchTransaction(async (client) => {
        await client.query('DELETE FROM stats.deletions_daily');

        const today = await utcTodayOf(client);
        const ancient = addDays(today, -400);
        const firstRemoved = addDays(today, -91);
        const lastKept = addDays(today, -90);
        const kept = addDays(today, -89);

        await seedRecordedDays(client, [ancient, firstRemoved, lastKept, kept]);
        const before = await statsSnapshot(client);

        // Three networks on each of the two days.
        assert.equal((await client.query(removal)).rowCount, 6);

        const after = await statsSnapshot(client);

        assert.deepEqual(after.daily, before.daily);
        assert.deepEqual(after.deletions, before.deletions);
        assert.deepEqual(
          after.top,
          before.top.filter((row) => row.dimension !== 'sender_net' || row.day >= lastKept),
        );
        assert.deepEqual(networks(after.top), [
          `${lastKept} 2001:db8:1::/48`,
          `${lastKept} 203.0.113.0/24`,
          `${lastKept} <unknown>`,
          `${kept} 2001:db8:1::/48`,
          `${kept} 203.0.113.0/24`,
          `${kept} <unknown>`,
        ]);
        // The other dimensions keep all four days.
        assert.equal(after.top.filter((row) => row.dimension !== 'sender_net').length, 4 * 3);

        // A second run removes nothing more and does not fail.
        assert.equal((await client.query(removal)).rowCount, 0);
        assert.deepEqual(await statsSnapshot(client), after);
      }, timeZone);
    });
  }

  it('removes nothing while no network is older than 90 days, as at its deployment', async () => {
    const removal = await registeredNetsRemoval();

    await inScratchTransaction(async (client) => {
      await client.query('DELETE FROM stats.deletions_daily');

      const today = await utcTodayOf(client);

      await seedRecordedDays(
        client,
        [-90, -30, -1].map((offset) => addDays(today, offset)),
      );
      const before = await statsSnapshot(client);

      assert.equal((await client.query(removal)).rowCount, 0);
      assert.deepEqual(await statsSnapshot(client), before);
    }, BEHIND_UTC);
  });

  it('removes the networks of a day recorded late, already past 90 days, which the recording never writes again', async () => {
    const removal = await registeredNetsRemoval();

    await inScratchTransaction(async (client, yesterday) => {
      const today = await utcTodayOf(client);
      const late = addDays(today, -95);

      await insertSession(client, { id: sessionId('late'), createdAt: at(late, '09:00:00') });
      await insertRequests(client, {
        sessionId: sessionId('late'),
        receivedAt: at(late, '10:00:00'),
        method: 'PUT',
        headers: [
          ['User-Agent', 'curl/8.7.1'],
          ['Content-Type', 'application/json'],
        ],
        sourceIp: '198.51.100.7',
      });

      // With nothing recorded the recording starts at that day, 95 days before
      // T, and goes to yesterday.
      assert.equal(await recordUsageDays(client), 95);
      assert.equal(addDays(late, 94), yesterday);

      const recorded = await topRows(client, late);

      assert.deepEqual(
        recorded.map((row) => [row.dimension, row.value]),
        [
          ['content_type', 'application/json'],
          ['method', 'PUT'],
          ['sender_net', '198.51.100.0/24'],
          ['user_agent', 'curl/8.7.1'],
        ],
      );

      assert.equal((await client.query(removal)).rowCount, 1);

      const left = recorded.filter((row) => row.dimension !== 'sender_net');

      assert.deepEqual(await topRows(client, late), left);

      // The day keeps its usage_daily row, so the next run records nothing,
      // and the count of networks, a number rather than a network, stays.
      assert.equal(await recordUsageDays(client), 0);
      assert.deepEqual(await topRows(client, late), left);
      assert.deepEqual(
        (await dailyRows(client)).filter((row) => row.day === late).map((row) => row.sender_nets),
        [1],
      );
    }, AHEAD_OF_UTC);
  });

  it('lets a run that overlaps another wait for it, then remove nothing and not fail', async () => {
    const removal = await registeredNetsRemoval();
    const first = await scratch.connect();
    const second = await scratch.connect();
    let secondRun: Promise<{ removed: number | null } | { error: unknown }> | undefined;

    /** Committed rows, so the test removes what it wrote. */
    const clear = async () => {
      await scratch.query('DELETE FROM stats.usage_daily_top');
      await scratch.query('DELETE FROM stats.usage_daily');
      await scratch.query('DELETE FROM stats.deletions_daily');
    };

    try {
      await clear();

      const today = await utcTodayOf(scratch);
      const removed = addDays(today, -91);
      const kept = addDays(today, -90);

      await seedRecordedDays(scratch, [removed, kept]);

      await first.query('BEGIN');
      assert.equal((await first.query(removal)).rowCount, 3);

      const { rows: backend } = await second.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      secondRun = second.query(removal).then(
        (result) => ({ removed: result.rowCount }),
        (error: unknown) => ({ error }),
      );

      // The second run is really overlapping: it waits on the rows the first deletes.
      const deadline = Date.now() + 10_000;
      let waiting = false;

      while (!waiting && Date.now() < deadline) {
        const { rows } = await scratch.query<{ wait_event_type: string | null }>(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
          [backend[0]?.pid],
        );
        waiting = rows[0]?.wait_event_type === 'Lock';

        if (!waiting) {
          await delay(50);
        }
      }

      assert.equal(waiting, true, 'the second run never waited for the first');

      await first.query('COMMIT');

      assert.deepEqual(await secondRun, { removed: 0 });
      assert.deepEqual(networks(await topRows(scratch)), [
        `${kept} 2001:db8:1::/48`,
        `${kept} 203.0.113.0/24`,
        `${kept} <unknown>`,
      ]);
    } finally {
      // After a failure the first may still hold the rows the second waits on.
      await first.query('ROLLBACK').catch(() => undefined);
      await secondRun;
      first.release();
      second.release();
      await clear();
    }
  });
});

describe('the sender-network job (D254)', () => {
  it('is registered once against this database, at 00:10 every day, running the removal', async () => {
    const { rows } = await main.query<{
      schedule: string;
      command: string;
      active: boolean;
      here: boolean;
    }>(
      `SELECT schedule, command, active, database = current_database() AS here
       FROM cron.job WHERE jobname = $1`,
      [NETS_JOB_NAME],
    );

    assert.deepEqual(rows, [
      { schedule: NETS_JOB_SCHEDULE, command: NETS_JOB_COMMAND, active: true, here: true },
    ]);
  });

  it('stays one job when the migration is applied again, and its removal then finds nothing more', async () => {
    const migration = await readFile(NETS_MIGRATION, 'utf8');
    const renaming = await readFile(INSPECTOR_NAME_MIGRATION, 'utf8');
    const client = await main.connect();

    try {
      await client.query('BEGIN');

      // As the migration runner sends it: one simple query holding every
      // statement, so the answer is one result per statement.
      const once = (await client.query(migration)) as unknown as pg.QueryResult[];
      const twice = (await client.query(migration)) as unknown as pg.QueryResult[];

      assert.deepEqual(
        once.map((result) => result.command),
        ['SELECT', 'DELETE'],
      );
      assert.deepEqual(
        twice.map((result) => [result.command, result.rowCount]),
        [
          ['SELECT', 1],
          ['DELETE', 0],
        ],
      );

      // 020 schedules it under the name 021 has since replaced (D278); 021,
      // applied again after it, leaves the one job under the new name.
      await client.query(renaming);

      const { rows } = await client.query<{
        jobname: string;
        schedule: string;
        command: string;
      }>('SELECT jobname, schedule, command FROM cron.job WHERE jobname = ANY($1)', [
        [NETS_JOB_NAME_020, NETS_JOB_NAME],
      ]);

      assert.deepEqual(rows, [
        { jobname: NETS_JOB_NAME, schedule: NETS_JOB_SCHEDULE, command: NETS_JOB_COMMAND },
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('runs five minutes after the usage job has recorded yesterday', async () => {
    const { rows } = await main.query<{ jobname: string; schedule: string }>(
      `SELECT jobname, schedule FROM cron.job
       WHERE jobname = ANY ($1) AND database = current_database() ORDER BY jobname`,
      [[JOB_NAME, NETS_JOB_NAME]],
    );

    assert.deepEqual(rows, [
      { jobname: NETS_JOB_NAME, schedule: '10 0 * * *' },
      { jobname: JOB_NAME, schedule: '5 0 * * *' },
    ]);
  });
});
