/**
 * Integration tests for the read-only usage views and role (D170, issue #48).
 *
 * Migration 007 creates schema `stats` with two views and role `qa_readonly`,
 * which may read those views and nothing else; migration 008 adds the two
 * tables of daily counters, which the role may read too (D178, issue #49), and
 * migration 009 the table of sessions deleted each day, which it may read as
 * well (D198, issue #102); migration 020 removes the sender networks older
 * than 90 days by a pg_cron job, which the role can neither run nor change
 * (D254, issue #165). The
 * privacy boundary is the column lists, so they are pinned exactly, in order;
 * the access boundary is the privileges, so every refusal is checked as the
 * role itself, inside a transaction opened READ WRITE on purpose:
 * `default_transaction_read_only` is only a default a session can switch off,
 * and the privileges are what must hold without it. What the tables hold is
 * tested in usage-daily.test.ts and session-delete.test.ts.
 *
 * `SET LOCAL ROLE` is used rather than a login: the role is NOLOGIN outside
 * production by design. Role settings apply only at login, so they are read
 * from the catalogue instead of observed.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';
import { loadConfig } from '../config.ts';
import { createPool } from './pool.ts';

const ROLE = 'qa_readonly';
/** Migration 020's job, which removes the sender networks older than 90 days (D254), under 021's name (D278). */
const NETS_JOB_NAME = 'webhook-inspector-delete-old-sender-nets';
const MIGRATION = new URL('../../migrations/007_stats_readonly_views.sql', import.meta.url);
/**
 * The advisory lock every replay of 007 in the backend suite holds while it
 * writes the role, taken in the test database: the same key as
 * `usage-daily.test.ts`'s, above the 1 to 2^47 that `pool.test.ts` draws its
 * keys from (issue #255).
 */
const ROLE_REPLAY_LOCK = '255000000000000007';

/** The approved column lists (issue #48), in order. */
const SESSIONS_COLUMNS = ['session_key', 'created_at', 'expires_at'];
const REQUESTS_COLUMNS = [
  'session_key',
  'received_at',
  'method',
  'body_size',
  'content_type',
  'user_agent',
  'sender_net',
];
/** The approved columns of the daily counters (issue #49), in order. */
const USAGE_DAILY_COLUMNS = [
  'day',
  'sessions_created',
  'sessions_created_with_requests',
  'sessions_with_requests',
  'sessions_returning',
  'requests_captured',
  'sender_nets',
  'body_bytes_total',
  'body_bytes_max',
  'sessions_custom_response',
  'requests_with_subpath',
  'sessions_at_request_limit',
  'database_bytes',
  'recorded_at',
];
const USAGE_DAILY_TOP_COLUMNS = ['day', 'dimension', 'value', 'requests', 'sessions'];
/** The approved columns of the deletions counted per day (issue #102), in order. */
const DELETIONS_DAILY_COLUMNS = ['day', 'sessions_deleted', 'requests_held'];
/**
 * Every relation the role may read, and the only privilege it holds on each
 * (D170, D178, D198). Granting it anything more takes a decision of its
 * own, not only an edit of this list.
 */
const READABLE_RELATIONS = [
  'stats.deletions_daily',
  'stats.requests',
  'stats.sessions',
  'stats.usage_daily',
  'stats.usage_daily_top',
];

/** Session ids are constrained by their length alone; 43 characters, unique to this run. */
const runId = randomUUID().replaceAll('-', '');
const sessionId = `stats-view-${runId}`;
const LONG_USER_AGENT = `agent/${'x'.repeat(300)}`;

function sessionKey(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 12);
}

let pool: pg.Pool;
let startup: Promise<void> | undefined;

before(async () => {
  startup = seed();
  await startup;
});

async function seed(): Promise<void> {
  pool = createPool(loadConfig().databaseUrl);
  assert.equal(sessionId.length, 43);

  await pool.query(`INSERT INTO sessions (id, expires_at) VALUES ($1, now() + interval '1 day')`, [
    sessionId,
  ]);

  const samples: [string, [string, string][], string | null][] = [
    [
      'POST',
      [
        ['Host', 'example.test'],
        ['CONTENT-TYPE', 'application/json'],
        ['Content-Type', 'text/plain'],
        ['User-Agent', LONG_USER_AGENT],
        ['Authorization', 'Bearer secret'],
      ],
      '203.0.113.77',
    ],
    [
      'PUT',
      [
        ['content-type', 'text/xml'],
        ['user-agent', 'curl/8.7.1'],
      ],
      '2001:db8:abcd:12::1',
    ],
    ['GET', [], null],
    ['DELETE', [['X-Other', 'y']], 'not an address'],
  ];

  for (const [index, [method, headers, sourceIp]] of samples.entries()) {
    await pool.query(
      `INSERT INTO requests (session_id, method, received_at, headers, body, body_size, raw_request, source_ip)
       VALUES ($1, $2, now() + make_interval(secs => $3), $4::jsonb, $5, 3, $5, $6)`,
      [sessionId, method, index, JSON.stringify(headers), Buffer.from('abc'), sourceIp],
    );
  }
}

after(async () => {
  // after() does not wait for an asynchronous before() when a name pattern
  // filters out every suite (D132), so it waits here; a failed seed is
  // before()'s to report.
  await startup?.catch(() => undefined);

  if (pool) {
    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    await pool.end();
  }
});

/**
 * Runs one statement as qa_readonly in a READ WRITE transaction that is always
 * rolled back, so the pooled connection never keeps the role.
 */
async function asReadonly<Row extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<Row>> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN READ WRITE');
    await client.query(`SET LOCAL ROLE ${ROLE}`);

    return await client.query<Row>(sql, params);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function assertRefused(sql: string): Promise<void> {
  await assert.rejects(asReadonly(sql), (error: { code?: string }) => {
    // insufficient_privilege: refused by a privilege, not by read-only mode.
    assert.equal(error.code, '42501', `${sql} failed with ${String(error.code)}`);
    return true;
  });
}

async function columns(relation: string): Promise<string[]> {
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'stats' AND table_name = $1 ORDER BY ordinal_position`,
    [relation],
  );

  return rows.map((row) => row.column_name);
}

describe('the stats views', () => {
  it('expose exactly the approved columns, in order, and so do the three tables', async () => {
    assert.deepEqual(await columns('sessions'), SESSIONS_COLUMNS);
    assert.deepEqual(await columns('requests'), REQUESTS_COLUMNS);
    assert.deepEqual(await columns('usage_daily'), USAGE_DAILY_COLUMNS);
    assert.deepEqual(await columns('usage_daily_top'), USAGE_DAILY_TOP_COLUMNS);
    assert.deepEqual(await columns('deletions_daily'), DELETIONS_DAILY_COLUMNS);
  });

  it('and the three tables are the only relations in schema stats, which holds no function', async () => {
    // Indexes belong to their tables and are left out.
    const { rows } = await pool.query<{ relname: string; relkind: string }>(
      `SELECT c.relname, c.relkind FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'stats' AND c.relkind <> 'i' ORDER BY c.relname`,
    );

    assert.deepEqual(rows, [
      { relname: 'deletions_daily', relkind: 'r' },
      { relname: 'requests', relkind: 'v' },
      { relname: 'sessions', relkind: 'v' },
      { relname: 'usage_daily', relkind: 'r' },
      { relname: 'usage_daily_top', relkind: 'r' },
    ]);

    const { rows: functions } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_proc WHERE pronamespace = 'stats'::regnamespace`,
    );

    assert.equal(functions[0]?.count, 0);
  });

  it('show a session by the first 12 hex characters of sha256(id)', async () => {
    const { rows } = await asReadonly<{ session_key: string }>(
      'SELECT session_key FROM stats.sessions WHERE session_key = $1',
      [sessionKey(sessionId)],
    );

    assert.equal(rows.length, 1);
    assert.match(rows[0]?.session_key ?? '', /^[0-9a-f]{12}$/);
  });

  it('reduce the sender to its network and read the two headers case-insensitively', async () => {
    const { rows } = await asReadonly<{
      session_key: string;
      method: string;
      body_size: number;
      content_type: string | null;
      user_agent: string | null;
      sender_net: string | null;
    }>(
      `SELECT session_key, method, body_size, content_type, user_agent, sender_net::text
       FROM stats.requests WHERE session_key = $1 ORDER BY received_at`,
      [sessionKey(sessionId)],
    );
    const key = sessionKey(sessionId);

    assert.deepEqual(rows, [
      {
        session_key: key,
        method: 'POST',
        body_size: 3,
        // The first of two Content-Type headers, whatever its spelling.
        content_type: 'application/json',
        user_agent: LONG_USER_AGENT.slice(0, 200),
        sender_net: '203.0.113.0/24',
      },
      {
        session_key: key,
        method: 'PUT',
        body_size: 3,
        content_type: 'text/xml',
        user_agent: 'curl/8.7.1',
        sender_net: '2001:db8:abcd::/48',
      },
      {
        session_key: key,
        method: 'GET',
        body_size: 3,
        content_type: null,
        user_agent: null,
        sender_net: null,
      },
      {
        session_key: key,
        method: 'DELETE',
        body_size: 3,
        content_type: null,
        user_agent: null,
        // An unreadable stored address reads NULL instead of failing the query.
        sender_net: null,
      },
    ]);
  });
});

describe('the qa_readonly role', () => {
  it('can read both views', async () => {
    await asReadonly('SELECT * FROM stats.sessions');
    await asReadonly('SELECT * FROM stats.requests');
  });

  it('can read both usage tables', async () => {
    await asReadonly('SELECT * FROM stats.usage_daily');
    await asReadonly('SELECT * FROM stats.usage_daily_top');
  });

  it('can read the deletions counted per day, and cannot write them (D198)', async () => {
    await asReadonly('SELECT day, sessions_deleted, requests_held FROM stats.deletions_daily');
    await assertRefused(
      `INSERT INTO stats.deletions_daily (day, sessions_deleted, requests_held)
       VALUES ('2000-01-01', 1, 0)`,
    );
    await assertRefused('UPDATE stats.deletions_daily SET sessions_deleted = 0');
    await assertRefused('DELETE FROM stats.deletions_daily');
    await assertRefused('TRUNCATE stats.deletions_daily');
    await assertRefused('DROP TABLE stats.deletions_daily');
    await assertRefused('ALTER TABLE stats.deletions_daily ADD COLUMN stats_probe int');
  });

  it('holds SELECT on the approved relations and no other privilege on any relation', async () => {
    // Every grant to the role, on any table, view or sequence of any schema,
    // read from the catalogue: a grant added to another table, or any other
    // privilege on these, shows up here.
    const { rows } = await pool.query<{ relation: string; privilege: string }>(
      `SELECT format('%s.%s', n.nspname, c.relname) AS relation, acl.privilege_type AS privilege
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
        WHERE acl.grantee = $1::regrole
        ORDER BY 1, 2`,
      [ROLE],
    );

    assert.deepEqual(
      rows,
      READABLE_RELATIONS.map((relation) => ({ relation, privilege: 'SELECT' })),
    );

    // Nor through a column grant.
    const { rows: columnGrants } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM pg_attribute a
         CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
        WHERE acl.grantee = $1::regrole`,
      [ROLE],
    );

    assert.equal(columnGrants[0]?.count, 0);
  });

  it('cannot read the tables', async () => {
    await assertRefused('SELECT * FROM public.sessions');
    await assertRefused('SELECT * FROM public.requests');
    await assertRefused('SELECT * FROM public.request_responses');
    await assertRefused('SELECT * FROM cron.job');
  });

  it('cannot read the realtime outbox, whose payloads carry captured requests (D221)', async () => {
    await assertRefused('SELECT payload FROM public.realtime_events');
    await assertRefused('SELECT count(*) FROM public.realtime_events');

    const { rows } = await pool.query<{ readable: boolean }>(
      "SELECT has_table_privilege($1, 'public.realtime_events', 'SELECT') AS readable",
      [ROLE],
    );

    assert.equal(rows[0]?.readable, false);

    // No default privilege hands the role a table created later either.
    const { rows: defaults } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM pg_default_acl d
         CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
        WHERE acl.grantee = $1::regrole`,
      [ROLE],
    );

    assert.equal(defaults[0]?.count, 0);
  });

  it('cannot write through the views or to the tables', async () => {
    await assertRefused(
      `INSERT INTO stats.sessions (created_at, expires_at) VALUES (now(), now())`,
    );
    await assertRefused(`UPDATE stats.sessions SET expires_at = now()`);
    await assertRefused(`DELETE FROM stats.sessions`);
    await assertRefused(`UPDATE stats.requests SET method = 'X'`);
    await assertRefused(`DELETE FROM stats.requests`);
    await assertRefused(`INSERT INTO public.sessions (id, expires_at) VALUES ('x', now())`);
    await assertRefused(`UPDATE public.requests SET method = 'X'`);
    await assertRefused(`DELETE FROM public.sessions`);
  });

  it('cannot write the usage tables or run the function that records them', async () => {
    await assertRefused(
      `INSERT INTO stats.usage_daily (day, sessions_created, sessions_created_with_requests,
         sessions_with_requests, sessions_returning, requests_captured, sender_nets,
         body_bytes_total, body_bytes_max, sessions_custom_response, requests_with_subpath,
         sessions_at_request_limit)
       VALUES ('2000-01-01', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
    );
    await assertRefused(`UPDATE stats.usage_daily SET requests_captured = 0`);
    await assertRefused(`DELETE FROM stats.usage_daily`);
    await assertRefused('TRUNCATE stats.usage_daily');
    await assertRefused(
      `INSERT INTO stats.usage_daily_top (day, dimension, value, requests, sessions)
       VALUES ('2000-01-01', 'method', 'GET', 1, 1)`,
    );
    await assertRefused(`UPDATE stats.usage_daily_top SET requests = 0`);
    await assertRefused(`DELETE FROM stats.usage_daily_top`);
    await assertRefused('TRUNCATE stats.usage_daily_top');
    // Refused already by the missing USAGE on schema public (D170 item 3)...
    await assertRefused('SELECT public.record_usage_days()');
  });

  it('cannot run the removal of old sender networks, nor schedule, change or unschedule its job (D254)', async () => {
    const { rows } = await pool.query<{ command: string }>(
      'SELECT command FROM cron.job WHERE jobname = $1 AND database = current_database()',
      [NETS_JOB_NAME],
    );

    assert.equal(rows.length, 1, `${NETS_JOB_NAME} is not registered once against this database`);
    await assertRefused((rows[0] as { command: string }).command);
    await assertRefused(`SELECT cron.schedule('${NETS_JOB_NAME}', '* * * * *', 'SELECT 1')`);
    await assertRefused(`SELECT cron.unschedule('${NETS_JOB_NAME}')`);
    await assertRefused(`UPDATE cron.job SET active = false WHERE jobname = '${NETS_JOB_NAME}'`);
  });

  it('holds no EXECUTE on the recording function, nor does PUBLIC', async () => {
    // ...and EXECUTE is withheld as well, so granting that USAGE later would
    // still not let the role write the counters.
    const { rows } = await pool.query<{ role_execute: boolean; public_execute: boolean }>(
      `SELECT has_function_privilege($1, 'public.record_usage_days()', 'EXECUTE') AS role_execute,
              EXISTS (
                SELECT 1
                FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
                WHERE p.oid = 'public.record_usage_days()'::regprocedure
                  AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              ) AS public_execute`,
      [ROLE],
    );

    assert.deepEqual(rows[0], { role_execute: false, public_execute: false });
  });

  it('cannot run DDL', async () => {
    await assertRefused('CREATE TABLE public.stats_probe (id int)');
    await assertRefused('CREATE TABLE stats.stats_probe (id int)');
    await assertRefused('CREATE TEMP TABLE stats_probe (id int)');
    await assertRefused('CREATE SCHEMA stats_probe');
    await assertRefused('CREATE VIEW stats.stats_probe AS SELECT 1');
    await assertRefused('DROP VIEW stats.sessions');
    await assertRefused('ALTER VIEW stats.requests RENAME TO stats_probe');
    await assertRefused('TRUNCATE public.requests');
    await assertRefused('DROP TABLE stats.usage_daily_top');
    await assertRefused('ALTER TABLE stats.usage_daily ADD COLUMN stats_probe int');
  });

  it('holds no attribute, membership or setting beyond the approved ones', async () => {
    const { rows } = await pool.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      rolconnlimit: number;
      has_password: boolean;
      memberships: number;
      settings: string[] | null;
    }>(
      `SELECT a.rolcanlogin, a.rolsuper, a.rolcreatedb, a.rolcreaterole, a.rolreplication,
              a.rolbypassrls, a.rolconnlimit, a.rolpassword IS NOT NULL AS has_password,
              (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = a.oid) AS memberships,
              (SELECT s.setconfig FROM pg_db_role_setting s
               WHERE s.setrole = a.oid AND s.setdatabase = 0) AS settings
       FROM pg_authid a WHERE a.rolname = $1`,
      [ROLE],
    );

    assert.equal(rows.length, 1, 'role qa_readonly does not exist');
    const role = rows[0];

    // Outside production the role never logs in; LOGIN and the password are
    // the operator's step, whose runbook is kept outside this repository.
    assert.equal(role?.rolcanlogin, false);
    assert.equal(role?.has_password, false);
    assert.equal(role?.rolsuper, false);
    assert.equal(role?.rolcreatedb, false);
    assert.equal(role?.rolcreaterole, false);
    assert.equal(role?.rolreplication, false);
    assert.equal(role?.rolbypassrls, false);
    assert.equal(role?.rolconnlimit, 2);
    assert.equal(role?.memberships, 0);
    assert.deepEqual([...(role?.settings ?? [])].sort(), [
      'default_transaction_read_only=on',
      'statement_timeout=5s',
    ]);
  });

  it('holds USAGE on stats and on no other application schema, and no TEMPORARY', async () => {
    const { rows } = await pool.query<{
      stats_usage: boolean;
      public_usage: boolean;
      public_create: boolean;
      cron_usage: boolean;
      temporary: boolean;
    }>(
      `SELECT has_schema_privilege($1, 'stats', 'USAGE') AS stats_usage,
              has_schema_privilege($1, 'public', 'USAGE') AS public_usage,
              has_schema_privilege($1, 'public', 'CREATE') AS public_create,
              has_schema_privilege($1, 'cron', 'USAGE') AS cron_usage,
              has_database_privilege($1, current_database(), 'TEMPORARY') AS temporary`,
      [ROLE],
    );

    assert.deepEqual(rows[0], {
      stats_usage: true,
      public_usage: false,
      public_create: false,
      cron_usage: false,
      temporary: false,
    });
  });

  it('is left as it is when the migration meets an existing role', async () => {
    // Roles are cluster-wide and the migration runs once per database, so a
    // second database in the same cluster meets the role already there -
    // possibly after the operator gave it LOGIN on production. Replayed inside
    // a transaction that is rolled back. The transaction first takes the lock
    // `usage-daily.test.ts` holds while it replays 007, in the test database
    // the two share, so neither writes the cluster-wide role while the other
    // does, which failed the one that waited with `tuple concurrently
    // updated` (issue #255).
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(${ROLE_REPLAY_LOCK})`);
      await client.query('DROP SCHEMA stats CASCADE');
      await client.query(`ALTER ROLE ${ROLE} LOGIN`);

      await client.query(await readFile(MIGRATION, 'utf8'));

      const { rows } = await client.query<{ rolcanlogin: boolean; count: number }>(
        `SELECT bool_and(rolcanlogin) AS rolcanlogin, count(*)::int AS count
         FROM pg_roles WHERE rolname = $1`,
        [ROLE],
      );

      assert.deepEqual(rows[0], { rolcanlogin: true, count: 1 });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
