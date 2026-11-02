/**
 * Integration tests for the scheduled cleanup of expired sessions (D019, D041).
 *
 * The backend already treats expires_at as authoritative, so these tests are
 * about the job that reclaims the storage behind it: that the migrations
 * registered it against this database under its current name, that migration
 * 006 also renames a job restored from the old production database, and that
 * pg_cron running the statement that job carries actually removes an expired
 * session and its requests (D061, D073, D160). And the realtime outbox's
 * backstop job of migration 012 (D221). And migration 021, which gives all
 * four pg_cron jobs the inspector's name (D278).
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import { loadConfig } from '../config.ts';
import { createPool } from './pool.ts';

/** The name migration 021 gives the job (D278). */
const JOB_NAME = 'webhook-inspector-delete-expired-sessions';
/** The name migration 006 gave it (D160), which 021 replaces. */
const JOB_NAME_006 = 'qa-tools-delete-expired-sessions';
/**
 * The name migration 002 gave it. An applied migration is never edited, so 002
 * still registers this name and 006 replaces it (D159, D160).
 */
const OLD_JOB_NAME = 'qa-tool-delete-expired-sessions';
/**
 * The role and database the job belonged to in production before the move to
 * the qa-tools namespace. Neither exists in the new one, and a restored
 * cron.job row still names both.
 */
const OLD_PRODUCTION_ROLE = 'qa_tool';
const OLD_PRODUCTION_DATABASE = 'qa_tool';
const JOB_SCHEDULE = '*/10 * * * *';
const JOB_COMMAND = 'DELETE FROM sessions WHERE expires_at < now()';
const RENAME_MIGRATION = new URL('../../migrations/006_rename_cleanup_job.sql', import.meta.url);
const INSPECTOR_NAME_MIGRATION = new URL(
  '../../migrations/021_rename_jobs_to_webhook_inspector.sql',
  import.meta.url,
);
/** Runs often enough to be observed, rather than on the ten-minute schedule. */
const PROBE_SCHEDULE = '5 seconds';
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Session ids are constrained by their length alone, so these stay readable
 * while remaining unique to this test run: nothing another run scheduled, or
 * left behind after crashing, can be mistaken for them.
 */
const runId = randomUUID().replaceAll('-', '');
const expiredSessionId = `cleanup-ex-${runId}`;
const liveSessionId = `cleanup-lv-${runId}`;

let pool: pg.Pool;

before(() => {
  pool = createPool(loadConfig().databaseUrl);
});

after(async () => {
  await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [[expiredSessionId, liveSessionId]]);
  await pool.end();
});

/** Inserts a session with one request, so the cascade has something to remove. */
async function seedSession(id: string, expiresIn: string): Promise<void> {
  await pool.query('INSERT INTO sessions (id, expires_at) VALUES ($1, now() + $2::interval)', [
    id,
    expiresIn,
  ]);
  await pool.query(
    `INSERT INTO requests (session_id, method, headers, body, body_size, raw_request)
     VALUES ($1, 'POST', '[]'::jsonb, $2, 0, $2)`,
    [id, Buffer.alloc(0)],
  );
}

async function sessionExists(id: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM sessions WHERE id = $1', [id]);

  return rowCount === 1;
}

async function requestCount(sessionId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*) FROM requests WHERE session_id = $1',
    [sessionId],
  );

  return Number(rows[0]?.count);
}

interface JobRun {
  status: string;
  return_message: string | null;
}

/** The most recent run of a job, ignoring anything that started earlier. */
async function lastRunSince(jobId: number, since: Date): Promise<JobRun | undefined> {
  const { rows } = await pool.query<JobRun>(
    `SELECT status, return_message FROM cron.job_run_details
     WHERE jobid = $1 AND start_time > $2
     ORDER BY start_time DESC LIMIT 1`,
    [jobId, since],
  );

  return rows[0];
}

/** Migration 012's backstop of the realtime outbox's prune (D221), under 021's name (D278). */
const OUTBOX_JOB_NAME = 'webhook-inspector-prune-realtime-events';
const OUTBOX_JOB_SCHEDULE = '* * * * *';
const OUTBOX_JOB_COMMAND =
  "WITH doomed AS MATERIALIZED (SELECT id FROM realtime_events WHERE created_at < clock_timestamp() - interval '5 minutes' FOR UPDATE SKIP LOCKED) DELETE FROM realtime_events AS e USING doomed WHERE e.id = doomed.id";

/** How long the job's statement may take beside a held row before it counts as waiting for it. */
const NO_WAIT_MS = 2_000;

describe('the realtime outbox backstop job (D221)', () => {
  it('is registered once against this database, every minute, for rows older than five minutes', async () => {
    const { rows } = await pool.query<{ schedule: string; command: string; active: boolean }>(
      `SELECT schedule, command, active FROM cron.job
       WHERE jobname = $1 AND database = current_database()`,
      [OUTBOX_JOB_NAME],
    );

    assert.deepEqual(rows, [
      { schedule: OUTBOX_JOB_SCHEDULE, command: OUTBOX_JOB_COMMAND, active: true },
    ]);
  });

  /**
   * The registered job's own statement, read from `cron.job`, run on two rows
   * inserted by a transaction that is never committed: no other connection
   * sees them, so neither a backend's prune nor another test file can take
   * the old one, and its deletion is that statement's alone - one that runs
   * and deletes nothing leaves it there, and the test fails. The younger row
   * is four minutes old, inside the job's five. The transaction is rolled
   * back. Then pg_cron runs the same statement, as a probe every 5 s, so that
   * the scheduler is seen running it in this database (`job_run_details`).
   */
  it('deletes, by the registered job’s statement, an outbox row older than five minutes and keeps one younger, and pg_cron runs that statement', async () => {
    const old = `cleanup-outbox-old-${runId}`;
    const young = `cleanup-outbox-new-${runId}`;
    const { rows: registered } = await pool.query<{ command: string }>(
      'SELECT command FROM cron.job WHERE jobname = $1 AND database = current_database()',
      [OUTBOX_JOB_NAME],
    );

    assert.equal(registered.length, 1, 'the job is not registered once against this database');

    const command = (registered[0] as { command: string }).command;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO realtime_events (session_id, kind, created_at)
         VALUES ($1, 'close', clock_timestamp() - interval '6 minutes'),
                ($2, 'close', clock_timestamp() - interval '4 minutes')`,
        [old, young],
      );
      await client.query(command);

      const { rows } = await client.query<{ session_id: string }>(
        'SELECT session_id FROM realtime_events WHERE session_id = ANY($1) ORDER BY session_id',
        [[old, young]],
      );

      assert.deepEqual(
        rows.map((row) => row.session_id),
        [young],
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    const scheduledAt = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
      ?.now as Date;
    const probeName = `webhook-inspector-outbox-probe-${runId}`;
    const { rows: scheduled } = await pool.query<{ jobid: number }>(
      'SELECT cron.schedule($1, $2, $3) AS jobid',
      [probeName, PROBE_SCHEDULE, command],
    );
    const probeId = scheduled[0]?.jobid as number;

    try {
      const deadline = Date.now() + PROBE_TIMEOUT_MS;
      let run: JobRun | undefined;

      while (Date.now() < deadline && run?.status !== 'succeeded') {
        run = await lastRunSince(probeId, scheduledAt);

        if (run?.status !== 'succeeded') {
          await delay(500);
        }
      }

      assert.equal(
        run?.status,
        'succeeded',
        `no successful run (${run?.return_message ?? 'none'})`,
      );
    } finally {
      await pool.query('SELECT cron.unschedule($1::bigint)', [probeId]);
    }
  });

  /**
   * A deletion's purge (`forgetEvents`) holds the rows of its request or
   * session while its transaction runs. The job's statement never waits for
   * such a row - waiting while the purge waited for a row the job held would
   * be a deadlock, ended by failing one of them - but leaves it to its next
   * run (correction round 3).
   */
  it('leaves an old row a transaction holds, without waiting for it, and deletes the other old ones', async () => {
    const held = `cleanup-outbox-held-${runId}`;
    const free = `cleanup-outbox-free-${runId}`;
    const holder = await pool.connect();
    const insert = (sessionId: string) =>
      pool.query(
        `INSERT INTO realtime_events (session_id, kind, payload, created_at)
         VALUES ($1, 'request.received', '{}', now() - interval '6 minutes')`,
        [sessionId],
      );

    try {
      // The job itself runs here every minute, and may take the row between
      // its insert and the lock; another row is tried then. No backend
      // process's prune takes it meanwhile: a row's transaction stays above
      // the horizon a prune uses for 10 s (D221).
      let locked = false;

      for (let attempt = 0; attempt < 5 && !locked; attempt += 1) {
        await insert(held);
        await holder.query('BEGIN');
        locked =
          (
            await holder.query('UPDATE realtime_events SET payload = NULL WHERE session_id = $1', [
              held,
            ])
          ).rowCount === 1;

        if (!locked) {
          await holder.query('ROLLBACK');
        }
      }

      assert.ok(locked, 'the held row was deleted before it could be locked, five times');
      await insert(free);

      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the job's statement waited ${NO_WAIT_MS} ms for a held row`)),
          NO_WAIT_MS,
        );
      });

      try {
        await Promise.race([pool.query(OUTBOX_JOB_COMMAND), waited]);
      } finally {
        clearTimeout(timer);
      }

      const left = async (): Promise<string[]> =>
        (
          await pool.query<{ session_id: string }>(
            'SELECT session_id FROM realtime_events WHERE session_id = ANY($1)',
            [[held, free]],
          )
        ).rows.map((row) => row.session_id);

      assert.deepEqual(await left(), [held]);

      await holder.query('ROLLBACK');
      await pool.query(OUTBOX_JOB_COMMAND);
      assert.deepEqual(await left(), []);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pool.query('DELETE FROM realtime_events WHERE session_id = ANY($1)', [[held, free]]);
    }
  });
});

describe('the scheduled cleanup job', () => {
  it('is registered once against this database', async () => {
    const { rows } = await pool.query<{ schedule: string; active: boolean }>(
      `SELECT schedule, active FROM cron.job
       WHERE jobname = $1 AND database = current_database()`,
      [JOB_NAME],
    );

    assert.equal(rows.length, 1, 'the cleanup job is not registered against this database');
    assert.equal(rows[0]?.active, true);
    assert.equal(rows[0]?.schedule, JOB_SCHEDULE);
  });

  it('no longer exists under the name migration 002 gave it (D160)', async () => {
    // Any database and any owner: the bootstrap superuser sees every row, and
    // a job left behind under the old name would run the cleanup twice.
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM cron.job WHERE jobname = $1',
      [OLD_JOB_NAME],
    );

    assert.equal(Number(rows[0]?.count), 0, `a job named ${OLD_JOB_NAME} is still registered`);
  });

  it('is renamed by migration 006 when restored from the old production database (D160)', async () => {
    // The restored row belongs to a role and a database that do not exist
    // here, which is what defeats pg_cron's by-name unschedule. The row is
    // written as a restore writes it, and everything happens inside a
    // transaction that is rolled back, so the job this database really runs
    // is left as it was.
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { rows: identity } = await client.query<{ user: string; database: string }>(
        'SELECT current_user AS user, current_database() AS database',
      );
      assert.notEqual(identity[0]?.user, OLD_PRODUCTION_ROLE, 'the restored row must be foreign');

      await client.query(
        `INSERT INTO cron.job (schedule, command, nodename, nodeport, database, username, active, jobname)
         VALUES ($1, $2, 'localhost', 5432, $3, $4, true, $5)`,
        [JOB_SCHEDULE, JOB_COMMAND, OLD_PRODUCTION_DATABASE, OLD_PRODUCTION_ROLE, OLD_JOB_NAME],
      );

      // The file itself, as the migration runner sends it: one simple query
      // holding every statement.
      await client.query(await readFile(RENAME_MIGRATION, 'utf8'));

      const { rows } = await client.query<{
        jobname: string;
        username: string;
        database: string;
        schedule: string;
        command: string;
        active: boolean;
      }>(
        `SELECT jobname, username, database, schedule, command, active FROM cron.job
         WHERE jobname = ANY($1) ORDER BY jobid`,
        [[OLD_JOB_NAME, JOB_NAME_006]],
      );

      assert.deepEqual(rows, [
        {
          jobname: JOB_NAME_006,
          username: identity[0]?.user,
          database: identity[0]?.database,
          schedule: JOB_SCHEDULE,
          command: JOB_COMMAND,
          active: true,
        },
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('deletes an expired session and its requests when pg_cron runs it (D061)', async () => {
    // The whole chain is exercised here - scheduler, cleanup statement,
    // cascade - because the parts prove nothing separately: a job that runs
    // and a statement that deletes still leave open whether that statement
    // succeeds in the cron context, which is where it actually runs.
    const { rows: registered } = await pool.query<{ command: string }>(
      'SELECT command FROM cron.job WHERE jobname = $1 AND database = current_database()',
      [JOB_NAME],
    );
    const command = registered[0]?.command as string;

    assert.ok(command, 'the cleanup job is not registered against this database');

    await seedSession(expiredSessionId, '-1 minute');
    await seedSession(liveSessionId, '1 hour');

    // Taken from the database clock, so that a run recorded before the probe
    // was scheduled - by an earlier run, or a probe left behind by one that
    // crashed - cannot be mistaken for this one.
    const scheduledAt = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
      ?.now as Date;

    // Unique to this test run, so that concurrent runs and abandoned probes
    // stay out of each other's way; removed by its own id below.
    const probeName = `webhook-inspector-cleanup-probe-${runId}`;
    const { rows: scheduled } = await pool.query<{ jobid: number }>(
      'SELECT cron.schedule($1, $2, $3) AS jobid',
      [probeName, PROBE_SCHEDULE, command],
    );
    const probeId = scheduled[0]?.jobid as number;

    try {
      const deadline = Date.now() + PROBE_TIMEOUT_MS;
      let run: JobRun | undefined;

      while (Date.now() < deadline && run?.status !== 'succeeded') {
        run = await lastRunSince(probeId, scheduledAt);

        if (run?.status !== 'succeeded') {
          await delay(500);
        }
      }

      assert.equal(
        run?.status,
        'succeeded',
        `pg_cron recorded no successful run of the cleanup statement within ${PROBE_TIMEOUT_MS / 1000} seconds (last run: ${run?.status ?? 'none'}, ${run?.return_message ?? 'no message'}). The scheduler is not running jobs in this database, cron.log_run is off, or the statement itself fails when run by cron.`,
      );
    } finally {
      await pool.query('SELECT cron.unschedule($1::bigint)', [probeId]);
    }

    assert.equal(await sessionExists(expiredSessionId), false, 'the expired session survived');
    assert.equal(await requestCount(expiredSessionId), 0, 'the cascade left requests behind');
    assert.equal(await sessionExists(liveSessionId), true, 'a live session was deleted');
    assert.equal(await requestCount(liveSessionId), 1, 'a live session lost its requests');
  });
});

/**
 * The four jobs of migrations 006, 008, 012 and 020, each as the latest of them
 * scheduled it, under the name migration 021 gives it and the one it had
 * before (D278).
 */
const INSPECTOR_JOBS = [
  {
    old: 'qa-tools-delete-expired-sessions',
    name: 'webhook-inspector-delete-expired-sessions',
    schedule: JOB_SCHEDULE,
    command: JOB_COMMAND,
  },
  {
    old: 'qa-tools-record-usage-days',
    name: 'webhook-inspector-record-usage-days',
    schedule: '5 0 * * *',
    command: 'SELECT public.record_usage_days()',
  },
  {
    old: 'qa-tools-prune-realtime-events',
    name: OUTBOX_JOB_NAME,
    schedule: OUTBOX_JOB_SCHEDULE,
    command: OUTBOX_JOB_COMMAND,
  },
  {
    old: 'qa-tools-delete-old-sender-nets',
    name: 'webhook-inspector-delete-old-sender-nets',
    schedule: '10 0 * * *',
    command:
      "DELETE FROM stats.usage_daily_top WHERE dimension = 'sender_net' AND day < (now() AT TIME ZONE 'UTC')::date - 90",
  },
] as const;

/**
 * Production's role and database, which a dump taken before #335 names in its
 * cron.job rows; another pair should the suite itself run as them.
 */
const RESTORED_OWNER = 'qa_tools';

interface CronRow {
  jobname: string;
  username: string;
  database: string;
  schedule: string;
  command: string;
  active: boolean;
}

describe("the pg_cron jobs under the inspector's name (migration 021, D278)", () => {
  it('holds each of the four once against this database under its new name, with its schedule and statement, and none under the old', async () => {
    const { rows } = await pool.query<{ jobname: string; schedule: string; command: string }>(
      `SELECT jobname, schedule, command FROM cron.job
       WHERE jobname = ANY($1) AND database = current_database() AND active ORDER BY jobname`,
      [INSPECTOR_JOBS.map((job) => job.name)],
    );

    assert.deepEqual(
      rows,
      INSPECTOR_JOBS.map(({ name, schedule, command }) => ({ jobname: name, schedule, command }))
        .slice()
        .sort((a, b) => a.jobname.localeCompare(b.jobname)),
    );

    // Any database and any owner: a job left behind under an old name would
    // run its statement twice.
    const { rows: old } = await pool.query<{ jobname: string }>(
      'SELECT jobname FROM cron.job WHERE jobname = ANY($1)',
      [INSPECTOR_JOBS.map((job) => job.old)],
    );

    assert.deepEqual(old, []);
  });

  it('replaces a row of each written as a restore writes it - the old name, another owner - by one job, and changes nothing run again', async () => {
    // Inside a transaction that is rolled back, so the jobs this database
    // really runs are left as they were; a row no transaction committed is
    // one pg_cron never sees.
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { rows: identity } = await client.query<{ user: string; database: string }>(
        'SELECT current_user AS user, current_database() AS database',
      );
      const here = identity[0] as { user: string; database: string };
      const owner = here.user === RESTORED_OWNER ? `${RESTORED_OWNER}_restored` : RESTORED_OWNER;
      const database =
        here.database === RESTORED_OWNER ? `${RESTORED_OWNER}_restored` : RESTORED_OWNER;

      assert.notEqual(owner, here.user, 'the restored rows must be foreign');

      for (const job of INSPECTOR_JOBS) {
        await client.query(
          `INSERT INTO cron.job (schedule, command, nodename, nodeport, database, username, active, jobname)
           VALUES ($1, $2, 'localhost', 5432, $3, $4, true, $5)`,
          [job.schedule, job.command, database, owner, job.old],
        );
      }

      // The file itself, as the migration runner sends it: one simple query
      // holding every statement. Twice: a second run must change nothing.
      const migration = await readFile(INSPECTOR_NAME_MIGRATION, 'utf8');

      for (let run = 0; run < 2; run += 1) {
        await client.query(migration);

        const { rows } = await client.query<CronRow>(
          `SELECT jobname, username, database, schedule, command, active FROM cron.job
           WHERE jobname = ANY($1) ORDER BY jobname`,
          [INSPECTOR_JOBS.flatMap((job) => [job.old, job.name])],
        );

        assert.deepEqual(
          rows,
          INSPECTOR_JOBS.map(({ name, schedule, command }) => ({
            jobname: name,
            username: here.user,
            database: here.database,
            schedule,
            command,
            active: true,
          }))
            .slice()
            .sort((a, b) => a.jobname.localeCompare(b.jobname)),
          `run ${run + 1}`,
        );
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
