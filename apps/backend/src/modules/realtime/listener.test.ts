/**
 * The read side of the realtime outbox (D221), against the database: what a
 * process delivers, in what order, when it reads, what it never fetches, and
 * every condition under which it gives up on its channel - each followed by
 * the listener listening again and delivering what comes next.
 *
 * Each test builds its own listeners, as processes, on hubs of their own, and
 * its own sessions, so that what other files commit meanwhile is passed over
 * as nobody's here. The tests of the window (#260) count every read and
 * wake-up, which a notification of another file's process would add to, so
 * they run on a database of this file's own, where no other file notifies.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { poolPausingFirstCommit } from '../../testing/locks.ts';
import { until } from '../../testing/realtime.ts';
import {
  appendEvent,
  committed,
  PRUNE_REALTIME_EVENTS_SQL,
  REALTIME_CHANNEL,
  REALTIME_VACUUM_AFTER_BYTES,
  VACUUM_REALTIME_EVENTS_SQL,
  type OutboxEvent,
} from './events.ts';
import { RealtimeHub, type Subscriber } from './hub.ts';
import {
  COALESCE_MS,
  QUERY_DEADLINE_MS,
  READ_SQL,
  RealtimeListener,
  WAKE_SQL,
  type ListenerOptions,
} from './listener.ts';

let pool: pg.Pool;
/** A second process's pool. */
let other: pg.Pool;
const listeners: RealtimeListener[] = [];
const sessions: string[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    other = createPool(loadConfig().databaseUrl);
  })();
  await startup;
});

after(async () => {
  await startup;

  for (const listener of listeners) {
    await listener.stop();
  }

  if (sessions.length > 0) {
    await pool.query('DELETE FROM realtime_events WHERE session_id = ANY($1)', [sessions]);
  }

  // A set-up that failed is its test's to report.
  await windowDatabase?.catch(() => undefined);

  if (windowDatabaseName !== undefined) {
    await dropWindowDatabase(windowDatabaseName);
  }

  await pool?.end();
  await other?.end();
});

/** A session id of this run: nothing else commits events for it. */
function session(): string {
  const id = randomBytes(32).toString('base64url').slice(0, 43);

  sessions.push(id);

  return id;
}

/** What the listener reports, kept for the test to read. */
interface Log {
  warnings: { details: Record<string, unknown>; message: string }[];
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

function log(): Log {
  const warnings: Log['warnings'] = [];

  return {
    warnings,
    info: () => undefined,
    warn: (details, message) =>
      warnings.push({ details: details as Record<string, unknown>, message }),
  };
}

/**
 * The prune with its conditions kept and one more, first in the rows it
 * chooses: the session is one of `$3`.
 */
const confinedPrune = PRUNE_REALTIME_EVENTS_SQL.replace(
  'FROM realtime_events\n          WHERE ',
  'FROM realtime_events\n          WHERE session_id = ANY($3::text[]) AND ',
);

// Confined it must be: a prune of the whole table here would delete rows the
// files running beside this one still read.
assert.notEqual(confinedPrune, PRUNE_REALTIME_EVENTS_SQL, 'the prune could not be confined');

/** Whether `text` is the prune, confined or not. */
function isPrune(text: string): boolean {
  return text === PRUNE_REALTIME_EVENTS_SQL || text === confinedPrune;
}

/**
 * `on`, with its prune confined to this file's sessions, the statement's own
 * conditions kept as they are. The outbox is one table for the whole suite,
 * and a process here prunes at a retention of 1 s, which would delete rows
 * the files running beside it still read: a cross-process test compares what
 * its viewers received with the outbox's rows.
 */
function confined(on: pg.Pool, to: readonly string[] = sessions): pg.Pool {
  return new Proxy(on, {
    get(target, property) {
      if (property === 'query') {
        return (text: string, values?: unknown[]) =>
          text === PRUNE_REALTIME_EVENTS_SQL
            ? target.query(confinedPrune, [...(values ?? []), to])
            : target.query(text, values);
      }

      const value = Reflect.get(target, property, target);

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

/**
 * A process: a listener on its own hub, listening. One given a retention of
 * its own prunes only this file's sessions (`confined`), those of the tests
 * after its own as well, so its test stops it before it ends: left running at
 * a retention of 1 s, it would delete a later test's rows a second after
 * their commit, before that test has read them.
 */
async function startProcess(
  on: pg.Pool = pool,
  options: Partial<ListenerOptions> = {},
): Promise<{ hub: RealtimeHub; listener: RealtimeListener; log: Log }> {
  const hub = new RealtimeHub();
  const reports = log();
  const prunesOn = options.pool ?? on;
  const listener = new RealtimeListener({
    connectionString: loadConfig().databaseUrl,
    hub,
    log: reports,
    ...options,
    pool: options.retentionSeconds === undefined ? prunesOn : confined(prunesOn as pg.Pool),
  });

  listeners.push(listener);
  listener.start();
  await listener.whenListening();

  return { hub, listener, log: reports };
}

/** A stand-in viewer recording what it is sent, how it is closed, and whether it was cut. */
function viewer(): Subscriber & { sent: string[]; closed: number[]; cut: number } {
  const seen = {
    sent: [] as string[],
    closed: [] as number[],
    cut: 0,
    bufferedAmount: 0,
    send(data: string) {
      seen.sent.push(data);
    },
    close(code: number) {
      seen.closed.push(code);
    },
    terminate() {
      seen.cut += 1;
    },
  };

  return seen;
}

/** `request.deleted` is a negotiable event (D115): a registration must declare it to be sent it. */
const DECLARES_DELETIONS: ReadonlySet<string> = new Set(['request.deleted']);

function deleted(id: string): OutboxEvent {
  return { type: 'request.deleted', data: { id } };
}

/**
 * The wake-up test's waker: a statement deadline well above the 5 s of
 * `QUERY_DEADLINE_MS`, which its held first wake-up outlasts.
 */
const WAKER_DEADLINE_MS = 30_000;
/** How much later each of that test's 100 commits is made: 5.5 s in all. */
const SLOWED_COMMIT_MS = 55;

/**
 * Commits one event of `sessionId` in a transaction of its own on `on`, and
 * tells the readers; `slowedByMs` later than it could, as on a loaded server.
 */
async function commit(
  on: pg.Pool,
  sessionId: string,
  event: OutboxEvent,
  slowedByMs = 0,
): Promise<void> {
  const client = await on.connect();

  try {
    await client.query('BEGIN');
    await appendEvent(client, sessionId, event);

    if (slowedByMs > 0) {
      await delay(slowedByMs);
    }

    await client.query('COMMIT');
  } finally {
    client.release();
  }

  committed(on);
}

/** The ids the `request.deleted` events a viewer was sent carry, in order. */
function ids(seen: { sent: string[] }): string[] {
  return seen.sent.map((data) => (JSON.parse(data) as { data: { id: string } }).data.id);
}

/**
 * The database of the window's tests (#260), this file's own: created on the
 * first test that asks for it, holding the outbox alone, as migration 012
 * creates it, and dropped once the file has run. A notification reaches only
 * the listeners of the database it was sent in, so no process of another
 * file wakes a listener there, as they wake those of the test database all
 * the time: every read and wake-up of a process there is one its test
 * caused, which the test counts exactly and times.
 */
let windowDatabase: Promise<string> | undefined;
/** Its name, once created: what the file's `after` drops. */
let windowDatabaseName: string | undefined;

const OUTBOX_MIGRATION = new URL('../../../migrations/012_realtime_events.sql', import.meta.url);

/** The address of the window's database, created and migrated on first use. */
function windowDatabaseUrl(): Promise<string> {
  windowDatabase ??= (async () => {
    const name = `webhook_inspector_listener_test_${randomBytes(8).toString('hex')}`;

    await pool.query(`CREATE DATABASE ${name}`);
    windowDatabaseName = name;

    const url = new URL(loadConfig().databaseUrl);

    url.pathname = `/${name}`;

    const setUp = new pg.Client({ connectionString: url.href });

    await setUp.connect();

    try {
      // pg_cron exists only in the database `cron.database_name` names: the
      // outbox's own prune job meets a stand-in here.
      await setUp.query(
        `CREATE SCHEMA cron;
         CREATE FUNCTION cron.schedule(text, text, text) RETURNS bigint
             LANGUAGE sql AS 'SELECT 0::bigint';`,
      );
      // As the migration runner sends it: one simple query holding every statement.
      await setUp.query(await readFile(OUTBOX_MIGRATION, 'utf8'));
    } finally {
      await setUp.end();
    }

    return url.href;
  })();

  return windowDatabase;
}

/**
 * Drops the window's database. `Pool.end()` and a listener's stop resolve
 * before the server has closed their connections, and `FORCE` ends a
 * connection still closing with an error its client then raises, so the drop
 * waits until the database has no backend left (as `usage-daily.test.ts`
 * does); `FORCE` stays for a connection that never went away.
 */
async function dropWindowDatabase(name: string): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1',
      [name],
    );

    if (rows[0]?.count === 0) {
      break;
    }

    await delay(50);
  }

  await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

/** `viewer`, which records when it was sent each message as well. */
function timedViewer(): ReturnType<typeof viewer> & { sentAt: number[] } {
  const seen = Object.assign(viewer(), { sentAt: [] as number[] });
  const send = seen.send.bind(seen);

  seen.send = (data: string) => {
    seen.sentAt.push(performance.now());
    send(data);
  };

  return seen;
}

/**
 * How much earlier than its delay after the call a timer may fire, as
 * `performance.now()` tells: Node times it from the clock of the turn of the
 * event loop that set it, read when that turn began.
 */
const TIMER_EARLY_MS = 50;

/** When each read and wake-up was sent, once `start` is called. */
interface Counted {
  reads: number[];
  wakeUps: number[];
}

/**
 * Two processes on the window's database, each on a pool of its own: a
 * waking one, whose commits the test makes and which records, once `start`
 * is called, when it sends each read and each wake-up, and a reading one,
 * which commits nothing. No other process notifies there, and neither ticks
 * within a test: so every read the waking process sends is one its commits
 * asked for, and every read of the reading process one their wake-up asked
 * for - each counted exactly. Each has the window given, or `COALESCE_MS`.
 */
async function countingProcesses(
  coalesceMs?: number,
  readerCoalesceMs?: number,
): Promise<{
  own: pg.Pool;
  waker: { hub: RealtimeHub; listener: RealtimeListener; log: Log };
  reader: { hub: RealtimeHub; listener: RealtimeListener; log: Log };
  counted: Counted;
  start: () => void;
  assertOneWindow: () => Promise<void>;
  end: () => Promise<void>;
}> {
  const url = await windowDatabaseUrl();
  const own = createPool(url);
  const theirs = createPool(url);
  const counted: Counted = { reads: [], wakeUps: [] };
  let counting = false;
  let windowsBefore = 0;
  let readerReadsBefore = 0;
  const waker = await startProcess(own, {
    connectionString: url,
    tickMs: 60_000,
    ...(coalesceMs === undefined ? {} : { coalesceMs }),
    beforeStatement: async (text) => {
      if (counting && text === READ_SQL) {
        counted.reads.push(performance.now());
      }

      if (counting && text === WAKE_SQL) {
        counted.wakeUps.push(performance.now());
      }
    },
  });
  const reader = await startProcess(theirs, {
    connectionString: url,
    tickMs: 60_000,
    ...(readerCoalesceMs === undefined ? {} : { coalesceMs: readerCoalesceMs }),
  });

  return {
    own,
    waker,
    reader,
    counted,
    start: () => {
      counting = true;
      windowsBefore = waker.listener.windowsEnded;
      readerReadsBefore = reader.listener.reads;
    },
    /**
     * Once the waking process's window has ended and the reading process
     * has read on its wake-up: one read and one wake-up of the waking
     * process, one read of the reading process.
     */
    assertOneWindow: async () => {
      await until(() => !waker.listener.windowOpen, 'the window to end', 5_000);
      await until(() => counted.wakeUps.length >= 1, 'the wake-up to be sent', 5_000);
      await until(
        () => reader.listener.reads > readerReadsBefore,
        'the other process to read on it',
        5_000,
      );
      // A read or a wake-up more, had anything asked for one, would have been
      // sent by now.
      await delay(200);
      assert.equal(counted.reads.length, 1, 'one read for the commits of one window');
      assert.equal(
        waker.listener.windowsEnded - windowsBefore,
        1,
        'one window for the commits made inside one',
      );
      assert.equal(counted.wakeUps.length, 1, 'one wake-up for the commits of one window');
      assert.equal(
        reader.listener.reads - readerReadsBefore,
        1,
        'the other process read once, on the one wake-up',
      );
    },
    end: async () => {
      await waker.listener.stop();
      await reader.listener.stop();
      await own.end();
      await theirs.end();
    },
  };
}

/** The ids of the events of `sessionId` in the outbox `on` reaches, in id order. */
async function outboxIds(on: pg.Pool, sessionId: string): Promise<string[]> {
  const rows = await on.query<{ payload: string }>(
    'SELECT payload FROM realtime_events WHERE session_id = $1 ORDER BY id',
    [sessionId],
  );

  return rows.rows.map((row) => (JSON.parse(row.payload) as { data: { id: string } }).data.id);
}

describe('what a listener delivers (D221)', () => {
  it('delivers a commit of its own process at once, each event once, in id order', async () => {
    const { hub, listener } = await startProcess(pool, { tickMs: 60_000 });
    const id = session();
    const seen = viewer();

    hub.add(id, seen, DECLARES_DELETIONS);

    for (let index = 0; index < 20; index += 1) {
      await commit(pool, id, deleted(`r${index}`));
    }

    await listener.flush();
    assert.deepEqual(
      ids(seen),
      Array.from({ length: 20 }, (_, index) => `r${index}`),
    );
  });

  it('delivers what another process commits, woken by its notification with no tick', async () => {
    const reader = await startProcess(pool, { tickMs: 60_000 });
    // The other process: its own pool and listener, which sends the wake-up.
    await startProcess(other, { tickMs: 60_000 });

    const id = session();
    const seen = viewer();

    reader.hub.add(id, seen, DECLARES_DELETIONS);
    await commit(other, id, deleted('from-the-other'));
    await until(() => seen.sent.length === 1, 'the event from the other process', 3_000);
    assert.deepEqual(ids(seen), ['from-the-other']);
  });

  it('is poked by a commit on one of its other pools, capture’s own, and delivers it with no tick, until it stops (D244)', async () => {
    // A pool of its own, which no other listener observes, as capture's is.
    const capture = createPool(loadConfig().databaseUrl, { max: 1 });

    try {
      const { hub, listener } = await startProcess(pool, {
        tickMs: 60_000,
        otherPools: [capture],
      });
      const poke = listener.poke.bind(listener);
      let poked = 0;

      listener.poke = () => {
        poked += 1;
        poke();
      };

      const id = session();
      const seen = viewer();

      hub.add(id, seen, DECLARES_DELETIONS);

      const client = await capture.connect();

      try {
        await client.query('BEGIN');
        await appendEvent(client, id, deleted('on capture’s pool'));
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      // Told within `committed` itself, which runs to its end before anything
      // else - a wake-up another file's commit sends this listener among them.
      const before = poked;

      committed(capture);
      assert.equal(poked, before + 1, 'a commit on capture’s pool did not poke the listener');
      await until(() => seen.sent.length === 1, 'the commit on capture’s pool', 2_000);
      assert.deepEqual(ids(seen), ['on capture’s pool']);

      // Stopped, it is no longer told.
      await listener.stop();

      const stopped = poked;

      committed(capture);
      assert.equal(poked, stopped);
    } finally {
      await capture.end();
    }
  });

  it('reads what no process announced at its next tick: a lost wake-up costs a tick, not an event', async () => {
    const { hub } = await startProcess(pool, { tickMs: 200 });
    const id = session();
    const seen = viewer();

    hub.add(id, seen, DECLARES_DELETIONS);
    // Appended and committed with nobody told.
    await other.query(
      `INSERT INTO realtime_events (session_id, kind, payload) VALUES ($1, 'request.deleted', $2)`,
      [id, JSON.stringify(deleted('unannounced'))],
    );
    await until(() => seen.sent.length === 1, 'the tick to read it', 3_000);
    assert.deepEqual(ids(seen), ['unannounced']);
  });

  it('delivers a later id of another session while an earlier one waits for its COMMIT, then the earlier one', async () => {
    const { hub, listener } = await startProcess(pool, { tickMs: 100 });
    const slow = session();
    const fast = session();
    const slowSeen = viewer();
    const fastSeen = viewer();

    hub.add(slow, slowSeen, DECLARES_DELETIONS);
    hub.add(fast, fastSeen, DECLARES_DELETIONS);

    const gated = poolPausingFirstCommit(pool);
    const held = commit(gated.pool, slow, deleted('held'));

    await gated.holder;

    const { rows } = await pool.query<{ tx: string }>(
      'SELECT tx::text AS tx FROM realtime_events WHERE session_id = $1',
      [slow],
    );

    // Invisible while it has not committed.
    assert.deepEqual(rows, []);

    await commit(other, fast, deleted('after'));
    await listener.flush();
    assert.deepEqual(ids(fastSeen), ['after']);
    assert.deepEqual(slowSeen.sent, []);

    gated.release();
    await held;
    await listener.flush();
    assert.deepEqual(ids(slowSeen), ['held']);
  });

  it('waits for nothing a rolled-back append left behind', async () => {
    const { hub, listener } = await startProcess(pool, { tickMs: 60_000 });
    const gone = session();
    const kept = session();
    const goneSeen = viewer();
    const keptSeen = viewer();

    hub.add(gone, goneSeen, DECLARES_DELETIONS);
    hub.add(kept, keptSeen, DECLARES_DELETIONS);

    const client = await other.connect();

    try {
      await client.query('BEGIN');
      await appendEvent(client, gone, deleted('rolled back'));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const started = Date.now();

    await commit(pool, kept, deleted('committed'));
    await listener.flush();
    assert.ok(Date.now() - started < 1_000);
    assert.deepEqual(ids(keptSeen), ['committed']);
    assert.deepEqual(goneSeen.sent, []);
  });

  /**
   * The prune's horizon guard (D221 point 9), which the next test cannot tell
   * from the retention alone, since a row not yet committed is invisible to a
   * `DELETE` anyway. Here the row has committed, is older than the retention,
   * and the pruning process has read past it, while this one has not read it
   * yet: a prune deletes only below the horizon its process read two prunes
   * earlier, which the row's transaction was not below, so the row stays for
   * the process that has still to read it.
   *
   * No other test's process prunes meanwhile at a retention of 1 s, which
   * would delete the row two of its prunes after the commit: each test that
   * starts one stops it before it ends (`startProcess`).
   */
  it('keeps a committed row older than the retention for a process that has not read it, though the pruning one has', async () => {
    const reader = await startProcess(pool, { tickMs: 60_000 });
    const late = session();
    const lateSeen = viewer();

    reader.hub.add(late, lateSeen, DECLARES_DELETIONS);

    // The pruning process's pool: it keeps the horizon of each prune and,
    // once the test sets `holding`, holds each prune before it runs.
    const prunes: { horizon: string; done: boolean }[] = [];
    let holding: Promise<void> = Promise.resolve();
    const pruning = new Proxy(other, {
      get(target, property) {
        if (property === 'query') {
          return async (text: string, values?: unknown[]) => {
            if (!isPrune(text)) {
              return target.query(text, values);
            }

            const prune = { horizon: String(values?.[0]), done: false };

            prunes.push(prune);
            await holding;

            try {
              return await target.query(text, values);
            } finally {
              prune.done = true;
            }
          };
        }

        const value = Reflect.get(target, property, target);

        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const pruner = await startProcess(other, {
      pool: pruning,
      tickMs: 100,
      retentionSeconds: 1,
      pruneEveryMs: 200,
    });
    let open: () => void = () => undefined;
    let releaseReads: () => void = () => undefined;

    try {
      await until(() => prunes.some((prune) => prune.done), 'the pruning process to prune', 5_000);

      const client = await other.connect();
      let heldFrom: number;

      try {
        await client.query('BEGIN');
        await appendEvent(client, late, deleted('late'));
        // Older than the retention once it commits, as a transaction held past it.
        await delay(1_100);

        // From here every prune waits until it is let go, and this process
        // reads nothing.
        heldFrom = prunes.length;
        holding = new Promise((resolve) => {
          open = resolve;
        });
        releaseReads = reader.listener.holdReads();
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const written = await pool.query<{ tx: string }>(
        'SELECT tx::text AS tx FROM realtime_events WHERE session_id = $1',
        [late],
      );

      assert.equal(written.rows.length, 1);

      const tx = BigInt(written.rows[0]?.tx ?? '0');

      // The pruning process reads past the row, and its next prune waits.
      await until(
        () => BigInt(pruner.listener.floor) > tx && prunes.length > heldFrom,
        'the pruning process to read past the row and to prune again',
      );

      const prune = prunes[heldFrom];

      assert.ok(prune !== undefined);
      assert.ok(
        BigInt(prune.horizon) <= tx,
        `the prune's horizon ${prune.horizon} is the one read two prunes earlier, not above the row's ${tx}`,
      );

      // That prune runs; any after it waits.
      const letGo = open;

      holding = new Promise((resolve) => {
        open = resolve;
      });
      letGo();
      await until(() => prune.done, 'the prune to run');

      const kept = await pool.query('SELECT 1 FROM realtime_events WHERE session_id = $1', [late]);

      assert.equal(kept.rows.length, 1, 'the prune deleted a row a listening process had not read');

      releaseReads();
      await reader.listener.flush();
      assert.deepEqual(ids(lateSeen), ['late']);
    } finally {
      releaseReads();
      open();
      await pruner.listener.stop();
    }
  });

  it('delivers a row held uncommitted past the retention, which no prune deleted meanwhile', async () => {
    const { hub, listener } = await startProcess(pool, {
      tickMs: 100,
      retentionSeconds: 1,
      pruneEveryMs: 200,
    });
    const late = session();
    const busy = session();
    const lateSeen = viewer();

    hub.add(late, lateSeen, DECLARES_DELETIONS);

    try {
      const client = await other.connect();

      try {
        await client.query('BEGIN');
        await appendEvent(client, late, deleted('late'));

        // Meanwhile other transactions commit, and three prunes run.
        for (let index = 0; index < 25; index += 1) {
          await commit(pool, busy, deleted(`busy${index}`));
          await delay(100);
        }

        await client.query('COMMIT');
      } finally {
        client.release();
      }

      committed(other);
      await listener.flush();
      assert.deepEqual(ids(lateSeen), ['late']);
    } finally {
      await listener.stop();
    }
  });

  it('prunes, once their transactions are two prunes behind, the rows older than the retention', async () => {
    const { listener } = await startProcess(pool, {
      tickMs: 100,
      retentionSeconds: 1,
      pruneEveryMs: 200,
    });

    try {
      const id = session();

      await commit(pool, id, deleted('old'));

      const count = async (): Promise<number> =>
        Number(
          (
            await pool.query<{ n: string }>(
              'SELECT count(*) AS n FROM realtime_events WHERE session_id = $1',
              [id],
            )
          ).rows[0]?.n,
        );

      assert.equal(await count(), 1);

      const deadline = Date.now() + 5_000;

      while ((await count()) > 0) {
        assert.ok(Date.now() < deadline, 'the row was never pruned');
        await delay(100);
      }
    } finally {
      await listener.stop();
    }
  });

  /**
   * A deletion's purge (`forgetEvents`) holds the rows of its request while
   * its transaction runs - a request deleted 20 s or more after its capture,
   * before the prune took its rows. A prune waiting for one of them while the
   * purge waited for a row the prune held would be a deadlock, which
   * PostgreSQL ends after a second by failing one of the two: a skipped
   * prune, or the deletion answered `500` (correction round 3). The prune
   * locks what it deletes `FOR UPDATE SKIP LOCKED` instead: it deletes the
   * other rows at once and leaves the held one to a later prune.
   *
   * The statement on its own, on rows of a session no process here prunes,
   * a minute old - past the retention, inside the job's five minutes - and
   * with a horizon above their transaction. Nothing else deletes them
   * meanwhile: every process's prune uses a horizon at least 10 s old, below
   * a transaction that has just ended.
   */
  it('prunes without waiting for a row a transaction holds, and leaves that row to a later prune', async () => {
    const own = randomBytes(32).toString('base64url').slice(0, 43);
    const written = await pool.query<{ id: string; tx: string; bytes: number }>(
      `INSERT INTO realtime_events (session_id, kind, payload, created_at)
       SELECT $1, 'request.received', '{"n":' || n || '}', now() - interval '1 minute'
         FROM generate_series(1, 3) AS n
       RETURNING id::text AS id, tx::text AS tx, pg_column_size(payload) AS bytes`,
      [own],
    );
    const [first, held, last] = written.rows;

    assert.ok(first !== undefined && held !== undefined && last !== undefined);

    const horizon = String(BigInt(held.tx) + 1n);
    const prune = () =>
      pool.query<{ rows: number; bytes: string }>(confinedPrune, [horizon, 20, [own]]);
    const left = async (): Promise<string[]> =>
      (
        await pool.query<{ id: string }>(
          'SELECT id::text AS id FROM realtime_events WHERE session_id = $1 ORDER BY id',
          [own],
        )
      ).rows.map((row) => row.id);
    const holder = await other.connect();

    try {
      // What a request's deletion does to its events, held open.
      await holder.query('BEGIN');
      assert.equal(
        (await holder.query('UPDATE realtime_events SET payload = NULL WHERE id = $1', [held.id]))
          .rowCount,
        1,
      );

      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('the prune waited 2 s for a row a transaction holds')),
          2_000,
        );
      });
      let pruned: Awaited<ReturnType<typeof prune>>;

      try {
        pruned = await Promise.race([prune(), waited]);
      } finally {
        clearTimeout(timer);
      }

      assert.deepEqual(pruned.rows, [{ rows: 2, bytes: String(first.bytes + last.bytes) }]);
      assert.deepEqual(await left(), [held.id]);

      // Once the deletion has ended, the next prune takes the row.
      await holder.query('ROLLBACK');
      assert.deepEqual((await prune()).rows, [{ rows: 1, bytes: String(held.bytes) }]);
      assert.deepEqual(await left(), []);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pool.query('DELETE FROM realtime_events WHERE session_id = $1', [own]);
    }
  });

  /**
   * A deleted row's space, its TOAST chunks above all, is written again only
   * once a vacuum has passed over it, and autovacuum looks once a minute, so
   * a flood of large events grew the table by everything written in between
   * (D221 point 9). A prune that deleted `REALTIME_VACUUM_AFTER_BYTES` of
   * payload or more is followed by a vacuum from the same process, and so is
   * the prune after it, each a statement of its own on the pool - inside a
   * transaction a vacuum fails - and a smaller prune by none. The process
   * here prunes only its own session.
   */
  it('vacuums the outbox after a prune that deleted 1 MiB of payload or more and after the next, outside any transaction, and not after a smaller one', async () => {
    const own = randomBytes(32).toString('base64url').slice(0, 43);
    const statements: {
      kind: 'prune' | 'vacuum';
      rows?: number;
      bytes?: number;
      error?: unknown;
    }[] = [];
    const recording = new Proxy(other, {
      get(target, property) {
        if (property === 'query') {
          return async (text: string, values?: unknown[]) => {
            if (text === PRUNE_REALTIME_EVENTS_SQL) {
              const result = await target.query<{ rows: number; bytes: string }>(confinedPrune, [
                ...(values ?? []),
                [own],
              ]);

              statements.push({
                kind: 'prune',
                rows: result.rows[0]?.rows ?? 0,
                bytes: Number(result.rows[0]?.bytes ?? 0),
              });

              return result;
            }

            if (text === VACUUM_REALTIME_EVENTS_SQL) {
              try {
                const result = await target.query(text, values);

                statements.push({ kind: 'vacuum' });

                return result;
              } catch (error) {
                statements.push({ kind: 'vacuum', error });
                throw error;
              }
            }

            return target.query(text, values);
          };
        }

        const value = Reflect.get(target, property, target);

        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const reports = log();
    const listener = new RealtimeListener({
      connectionString: loadConfig().databaseUrl,
      hub: new RealtimeHub(),
      log: reports,
      pool: recording,
      tickMs: 100,
      retentionSeconds: 1,
      pruneEveryMs: 200,
    });
    const pruned = (): number =>
      statements.reduce((sum, statement) => sum + (statement.rows ?? 0), 0);

    listeners.push(listener);
    listener.start();
    await listener.whenListening();

    try {
      // Small events, pruned with no vacuum.
      for (let index = 0; index < 3; index += 1) {
        await commit(other, own, deleted(`small${index}`));
      }

      await until(() => pruned() >= 3, 'the small events to be pruned');
      assert.deepEqual(
        statements.filter((statement) => statement.kind === 'vacuum'),
        [],
      );

      // One event of about 1.4 MiB of text no compression shrinks, pruned and then vacuumed.
      await commit(other, own, deleted(randomBytes(1_100_000).toString('base64')));
      await until(() => pruned() >= 4, 'the large event to be pruned');

      const large = statements.findIndex(
        (statement) => (statement.bytes ?? 0) >= REALTIME_VACUUM_AFTER_BYTES,
      );

      assert.ok(large >= 0, 'no prune deleted the large event');
      // A vacuum after it, and after the prune after it, then none.
      await until(
        () => statements.slice(large).filter((statement) => statement.kind === 'prune').length >= 4,
        'four prunes from the large one on',
        5_000,
      );
      assert.deepEqual(
        statements
          .slice(large, large + 6)
          .map((statement) => `${statement.kind}${statement.error ? ' failed' : ''}`),
        ['prune', 'vacuum', 'prune', 'vacuum', 'prune', 'prune'],
      );
      // No failure reported. A late read is none: this listener reads every
      // session's rows, and the files beside this one write rows dated
      // minutes back (`db/cleanup.test.ts`'s, for the job).
      assert.deepEqual(
        reports.warnings.filter((warning) => warning.message !== 'Realtime events were read late'),
        [],
      );
    } finally {
      await listener.stop();
      await pool.query('DELETE FROM realtime_events WHERE session_id = $1', [own]);
    }
  });

  it('fetches no payload for events nobody on the process wants, however many', async () => {
    const { hub, listener } = await startProcess(pool, { tickMs: 60_000 });
    const before = listener.fetches;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (let index = 0; index < 500; index += 1) {
        await appendEvent(client, session(), deleted(`flood${index}`));
      }

      await client.query('COMMIT');
    } finally {
      client.release();
    }

    committed(pool);
    await listener.flush();
    assert.equal(listener.fetches, before);

    // One someone wants: one fetch.
    const id = session();
    const seen = viewer();

    hub.add(id, seen, DECLARES_DELETIONS);
    await commit(pool, id, deleted('wanted'));
    await listener.flush();
    assert.equal(listener.fetches, before + 1);
    assert.deepEqual(ids(seen), ['wanted']);
  });

  it('closes a session’s connections on its close, with 4404, in their place among its events', async () => {
    const { hub, listener } = await startProcess(pool, { tickMs: 60_000 });
    const id = session();
    const seen = viewer();

    hub.add(id, seen, DECLARES_DELETIONS);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await appendEvent(client, id, deleted('before the close'));
      await appendEvent(client, id, { type: 'close' });
      await appendEvent(client, id, deleted('after the close'));
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    committed(pool);
    await listener.flush();
    assert.deepEqual(ids(seen), ['before the close']);
    assert.deepEqual(seen.closed, [4404]);
    assert.equal(hub.countFor(id), 0);
  });

  it('skips an event a deletion purged, and delivers the deletion’s own', async () => {
    const { hub, listener } = await startProcess(pool, { tickMs: 60_000 });
    const id = session();
    const seen = viewer();

    hub.add(id, seen, DECLARES_DELETIONS);

    const release = listener.holdReads();

    await commit(pool, id, deleted('purged'));
    await pool.query('UPDATE realtime_events SET payload = NULL WHERE session_id = $1', [id]);
    await commit(pool, id, deleted('kept'));
    release();
    await listener.flush();
    assert.deepEqual(ids(seen), ['kept']);
    assert.equal(listener.listening, true);
  });

  it('delivers payloads verbatim whatever they hold, at growing sizes, the session id included', async () => {
    const { hub, listener } = await startProcess(pool, { tickMs: 60_000 });
    // Nothing in a value reaches the SQL: an id built to break a concatenation.
    const hostile = `x'); DROP TABLE realtime_events; --${randomBytes(4).toString('hex')}`;
    const seen = viewer();

    sessions.push(hostile);
    hub.add(hostile, seen, DECLARES_DELETIONS);

    const piece = `'"\\$1 \u0000 \u2028 я 🐘 ${String.fromCharCode(1)}`;

    for (const size of [1024, 64 * 1024, 1024 * 1024]) {
      const text = piece.repeat(Math.ceil(size / piece.length)).slice(0, size);

      await commit(pool, hostile, deleted(text));
    }

    await listener.flush();
    assert.equal(seen.sent.length, 3);

    for (const [index, size] of [1024, 64 * 1024, 1024 * 1024].entries()) {
      const text = piece.repeat(Math.ceil(size / piece.length)).slice(0, size);

      assert.equal(seen.sent[index], JSON.stringify(deleted(text)));
    }

    assert.equal(
      (await pool.query("SELECT to_regclass('realtime_events') IS NOT NULL AS there")).rows[0]
        ?.there,
      true,
    );
  });

  it('flushes only once a read that began after the call has delivered, and refuses when not listening', async () => {
    const { hub, listener } = await startProcess(pool, { tickMs: 60_000 });
    const id = session();
    const seen = viewer();

    hub.add(id, seen, DECLARES_DELETIONS);

    const release = listener.holdReads();

    await other.query(
      `INSERT INTO realtime_events (session_id, kind, payload) VALUES ($1, 'request.deleted', $2)`,
      [id, JSON.stringify(deleted('flushed'))],
    );

    let flushed = false;
    const flushing = listener.flush().then(() => {
      flushed = true;
    });

    await delay(100);
    assert.equal(flushed, false);
    release();
    await flushing;
    assert.deepEqual(ids(seen), ['flushed']);

    await listener.stop();
    await assert.rejects(listener.flush(), /not listening/);
  });

  /**
   * One wake-up at a time, and one more after it for however many commits
   * asked meanwhile (D221 point 4). Here the first wake-up is held before it
   * is sent until all 100 commits are in and the last one's window has ended
   * (#260), so that every one of them asks while it is under way: two
   * wake-ups in all, where one a commit would be 100. The waking process has
   * a pool of its own, so that it alone wakes for these commits, and only its
   * notifications are counted - the files running beside this one notify on
   * the same channel.
   *
   * The held wake-up waits inside its statement's deadline
   * (`beforeStatement`), so the waker has a deadline of 30 s, and the commits
   * are made one after another, each slowed by `SLOWED_COMMIT_MS`, so that
   * they hold it past the default deadline of 5 s whatever the runner's load:
   * the test fails with the waker at the default, its channel lost, and adds
   * about 6 s to the suite.
   */
  it('wakes the other processes once a commit is in, and once more for however many commits asked meanwhile', async () => {
    const own = createPool(loadConfig().databaseUrl);
    let wakeUps = 0;
    let heldSince = 0;
    let sendWakeUp: () => void = () => undefined;
    const firstWakeUpHeld = new Promise<void>((resolve) => {
      sendWakeUp = resolve;
    });
    const waker = await startProcess(own, {
      tickMs: 60_000,
      queryDeadlineMs: WAKER_DEADLINE_MS,
      beforeStatement: async (text) => {
        if (text === WAKE_SQL) {
          wakeUps += 1;

          if (wakeUps === 1) {
            heldSince = Date.now();
            await firstWakeUpHeld;
          }
        }
      },
    });
    const reader = await startProcess(other, { tickMs: 60_000 });
    const id = session();
    const seen = viewer();
    const counter = new pg.Client({ connectionString: loadConfig().databaseUrl });
    const wakerPid = waker.listener.processId;
    let notifications = 0;

    assert.ok(wakerPid !== null);
    reader.hub.add(id, seen, DECLARES_DELETIONS);
    await counter.connect();
    counter.on('notification', (message) => {
      if (message.channel === REALTIME_CHANNEL && message.processId === wakerPid) {
        notifications += 1;
      }
    });
    await counter.query(`LISTEN ${REALTIME_CHANNEL}`);

    try {
      for (let index = 0; index < 100; index += 1) {
        await commit(own, id, deleted(`w${index}`), SLOWED_COMMIT_MS);
      }

      const heldForMs = Date.now() - heldSince;

      assert.ok(
        heldSince > 0 && heldForMs > QUERY_DEADLINE_MS,
        `the first wake-up was held ${heldForMs} ms, not past the default deadline`,
      );
      // The last commit asks once its window has ended (#260).
      await until(() => !waker.listener.windowOpen, 'the last commit’s window to end', 5_000);
      assert.equal(wakeUps, 1, 'a wake-up was started while another was under way');

      sendWakeUp();
      await until(() => seen.sent.length === 100, 'every event at the other process', 5_000);
      assert.deepEqual(
        [...ids(seen)].sort(),
        Array.from({ length: 100 }, (_, index) => `w${index}`).sort(),
      );
      await until(() => notifications >= 2, 'the second wake-up to be heard', 5_000);
      assert.equal(wakeUps, 2);
      assert.equal(notifications, 2);
      // A late read is not a lost channel: the waker reads every session's
      // rows, and the files beside this one write rows dated minutes back
      // (`db/cleanup.test.ts`'s, for the job).
      assert.deepEqual(
        waker.log.warnings
          .filter((warning) => warning.message !== 'Realtime events were read late')
          .map((warning) => String(warning.details.reason ?? warning.message)),
        [],
        'the waker lost its channel',
      );
    } finally {
      sendWakeUp();
      await counter.end();
      await waker.listener.stop();
      await own.end();
    }
  });
});

/**
 * The window (#260), on the window's database (`windowDatabaseUrl`): every
 * commit inside one causes one read of the process that made it and one
 * wake-up of the others, which read at once on it; nothing is read, woken or
 * delivered before the window has ended. No process of another file notifies
 * there, so each count is exact, and each time is the test's alone.
 */
describe('the window of a process’s commits (#260), on a database of its own', () => {
  /**
   * 20 commits made one after another within a window of 3 s, so that a
   * loaded runner still makes them all inside it.
   */
  it('reads once and wakes the other processes once for the commits inside one window, each event once and in id order', async () => {
    const window = 3_000;
    const { own, waker, reader, start, assertOneWindow, end } = await countingProcesses(window);
    const id = session();
    const mine = viewer();
    const theirs = viewer();

    waker.hub.add(id, mine, DECLARES_DELETIONS);
    reader.hub.add(id, theirs, DECLARES_DELETIONS);

    try {
      start();

      const first = performance.now();

      for (let index = 0; index < 20; index += 1) {
        await commit(own, id, deleted(`c${index}`));
      }

      const spread = performance.now() - first;

      assert.ok(spread < window, `the commits took ${spread} ms, longer than the window`);
      await until(
        () => mine.sent.length === 20,
        'every event at the waking process',
        window + 5_000,
      );
      await until(() => theirs.sent.length === 20, 'every event at the other process', 5_000);

      const expected = Array.from({ length: 20 }, (_, index) => `c${index}`);

      assert.deepEqual(ids(mine), expected);
      assert.deepEqual(ids(theirs), expected);
      await assertOneWindow();
    } finally {
      await end();
    }
  });

  /**
   * A burst from many sessions inside one window (#260's attack list): ten
   * sessions at once on a pool of ten connections, five commits each, one
   * after another, within a window of 3 s. One read and one wake-up for them
   * all, and each session's events reach its viewers once and in id order,
   * on both processes.
   */
  it('reads once and wakes once for a burst of commits of many sessions inside one window, each session’s events once and in id order', async () => {
    const window = 3_000;
    const { own, waker, reader, start, assertOneWindow, end } = await countingProcesses(window);
    const ids10 = Array.from({ length: 10 }, () => session());
    const viewers = ids10.map((id) => {
      const mine = viewer();
      const theirs = viewer();

      waker.hub.add(id, mine, DECLARES_DELETIONS);
      reader.hub.add(id, theirs, DECLARES_DELETIONS);

      return { id, mine, theirs };
    });

    try {
      start();

      const first = performance.now();

      // The sessions at once; each session's commits one after another, so
      // that each must be delivered after the one before it (D205 point 12).
      await Promise.all(
        ids10.map(async (id, sessionIndex) => {
          for (let index = 0; index < 5; index += 1) {
            await commit(own, id, deleted(`s${sessionIndex}-${index}`));
          }
        }),
      );

      const spread = performance.now() - first;

      assert.ok(spread < window, `the burst took ${spread} ms, longer than the window`);

      for (const { id, mine, theirs } of viewers) {
        await until(() => mine.sent.length === 5, 'the session’s events here', window + 5_000);
        await until(() => theirs.sent.length === 5, 'the session’s events there', 5_000);

        const written = await outboxIds(own, id);

        assert.equal(written.length, 5);
        assert.deepEqual(ids(mine), written);
        assert.deepEqual(ids(theirs), written);
      }

      await assertOneWindow();
    } finally {
      await end();
    }
  });

  /**
   * The window as it ships: at most 20 ms (#260's bound), and every commit
   * announced within it - here a burst announced in one turn of the event
   * loop - is answered by one read and one wake-up.
   */
  it('keeps its window at 20 ms at most and answers the commits announced inside it with one read and one wake-up', async () => {
    assert.ok(COALESCE_MS > 0 && COALESCE_MS <= 20, `the window is ${COALESCE_MS} ms`);

    const { own, waker, reader, start, assertOneWindow, end } = await countingProcesses();
    const id = session();
    const mine = viewer();
    const theirs = viewer();

    waker.hub.add(id, mine, DECLARES_DELETIONS);
    reader.hub.add(id, theirs, DECLARES_DELETIONS);

    try {
      // Committed with nobody told, then announced at once, as a burst of
      // commits ending together announces itself.
      for (let index = 0; index < 30; index += 1) {
        await own.query(
          `INSERT INTO realtime_events (session_id, kind, payload) VALUES ($1, 'request.deleted', $2)`,
          [id, JSON.stringify(deleted(`b${index}`))],
        );
      }

      start();

      for (let index = 0; index < 30; index += 1) {
        committed(own);
      }

      await until(() => mine.sent.length === 30, 'every event at the waking process', 5_000);
      await until(() => theirs.sent.length === 30, 'every event at the other process', 5_000);
      assert.deepEqual(ids(mine), await outboxIds(own, id));
      assert.deepEqual(ids(theirs), await outboxIds(own, id));
      await assertOneWindow();
    } finally {
      await end();
    }
  });

  /**
   * Trailing: the read and the wake-up of a commit are sent once its window
   * has ended, never before, and a commit made inside the window joins it,
   * its event delivered by the same read: nothing is read, woken or
   * delivered, on either process, before the window's end. A window of
   * 1.5 s, and the second commit 100 ms into it, so that a stall of a loaded
   * runner does not end the window first.
   */
  it('sends the read and the wake-up of commits only once their window has ended, delivering nothing before on either process', async () => {
    const window = 1_500;
    const { own, waker, reader, counted, start, assertOneWindow, end } =
      await countingProcesses(window);
    const id = session();
    const mine = timedViewer();
    const theirs = timedViewer();

    waker.hub.add(id, mine, DECLARES_DELETIONS);
    reader.hub.add(id, theirs, DECLARES_DELETIONS);

    try {
      start();

      // Before the commit announces itself, so never after its window opened.
      const opened = performance.now();

      await commit(own, id, deleted('first'));
      assert.equal(waker.listener.windowOpen, true, 'the commit opened no window');
      await delay(100);
      // A commit inside the window joins it, and opens no window of its own.
      await commit(own, id, deleted('second'));
      assert.deepEqual(
        {
          reads: counted.reads.length,
          wakeUps: counted.wakeUps.length,
          here: mine.sent.length,
          there: theirs.sent.length,
        },
        { reads: 0, wakeUps: 0, here: 0, there: 0 },
        'read, woken or delivered inside the window',
      );
      await until(
        () => mine.sent.length === 2 && theirs.sent.length === 2,
        'both events on both processes',
        window + 5_000,
      );
      assert.deepEqual(ids(mine), ['first', 'second']);
      assert.deepEqual(ids(theirs), ['first', 'second']);

      const sent: [string, number | undefined][] = [
        ['the read', counted.reads[0]],
        ['the wake-up', counted.wakeUps[0]],
        ['the first event here', mine.sentAt[0]],
        ['the first event there', theirs.sentAt[0]],
      ];

      for (const [what, at] of sent) {
        assert.ok(at !== undefined, `${what} was never sent`);

        const after = at - opened;

        assert.ok(
          after >= window - TIMER_EARLY_MS,
          `${what} was sent ${after} ms after the first commit, inside its window of ${window} ms`,
        );
      }

      await assertOneWindow();
    } finally {
      await end();
    }
  });

  /**
   * The process woken reads at once: the window was the waking process's,
   * taken before it woke the others, and they add none. Here the woken one
   * has a window of 3 s of its own, which a wake-up answered as a commit is
   * would wait out; it delivers well within it, and opens none.
   */
  it('reads at once on another process’s wake-up, opening no window of its own', async () => {
    const window = 3_000;
    const { own, reader, counted, start, assertOneWindow, end } = await countingProcesses(
      undefined,
      window,
    );
    const id = session();
    const theirs = timedViewer();

    reader.hub.add(id, theirs, DECLARES_DELETIONS);

    try {
      start();
      await commit(own, id, deleted('woken'));
      await until(() => theirs.sent.length === 1, 'the event at the woken process', window + 5_000);
      assert.deepEqual(ids(theirs), ['woken']);

      const wokenAt = counted.wakeUps[0];
      const sentAt = theirs.sentAt[0];

      assert.ok(wokenAt !== undefined && sentAt !== undefined, 'no wake-up was sent');

      const latency = sentAt - wokenAt;

      assert.ok(
        latency < window / 2,
        `delivered ${latency} ms after the wake-up was sent, as a window of ${window} ms would`,
      );
      assert.equal(reader.listener.windowsEnded, 0, 'the woken process opened a window of its own');
      await assertOneWindow();
    } finally {
      await end();
    }
  });
});

describe('a lost channel (D221)', () => {
  /**
   * Each case: the hub is deafened - every registration cut - and the
   * listener connects again, reads its baseline, and delivers what is
   * committed afterwards.
   */
  async function expectLost(
    from: { hub: RealtimeHub; listener: RealtimeListener; log: Log },
    seen: { cut: number },
    reason: RegExp,
  ): Promise<void> {
    await until(() => seen.cut === 1, 'the registration to be cut', 5_000);
    assert.ok(
      from.log.warnings.some((warning) => reason.test(String(warning.details.reason))),
      JSON.stringify(from.log.warnings),
    );
    await until(() => from.listener.listening, 'the listener to listen again', 5_000);

    const id = session();
    const after = viewer();

    from.hub.add(id, after, DECLARES_DELETIONS);
    await commit(pool, id, deleted('after'));
    await from.listener.flush();
    assert.deepEqual(ids(after), ['after']);
  }

  it('when its connection ends', async () => {
    const from = await startProcess(pool, { tickMs: 100, firstRetryMs: 50 });
    const seen = viewer();

    from.hub.add(session(), seen, DECLARES_DELETIONS);
    await pool.query('SELECT pg_terminate_backend($1)', [from.listener.processId]);
    // Seen as the connection's end, or by the statement in flight on it.
    await expectLost(from, seen, /connection|failed/);
  });

  it('when a statement is not answered within its deadline', async () => {
    let stall = false;
    const from = await startProcess(pool, {
      tickMs: 50,
      queryDeadlineMs: 300,
      firstRetryMs: 50,
      beforeStatement: async () => {
        if (stall) {
          stall = false;
          await delay(1_000);
        }
      },
    });
    const seen = viewer();

    from.hub.add(session(), seen, DECLARES_DELETIONS);
    stall = true;
    await expectLost(from, seen, /reading the outbox failed|heartbeat|wake-up/);
  });

  /**
   * A commit whose wake-up fails (#260's attack list): the wake-up is sent
   * on the listening connection, so its failure is the channel's, and the
   * process deafens and listens again as for any other loss. The commit is
   * not touched: its event is in the outbox, and the other process, whom the
   * wake-up was for, reads it at its next tick.
   */
  it('when a commit’s wake-up fails, the commit’s event still reaching the other process at its tick', async () => {
    const own = createPool(loadConfig().databaseUrl);
    let failNextWakeUp = true;

    try {
      const from = await startProcess(own, {
        tickMs: 60_000,
        firstRetryMs: 50,
        beforeStatement: async (text) => {
          if (text === WAKE_SQL && failNextWakeUp) {
            failNextWakeUp = false;
            throw new Error('the wake-up failed');
          }
        },
      });
      const reader = await startProcess(other, { tickMs: 200 });
      const id = session();
      const seen = viewer();
      const theirs = viewer();

      from.hub.add(session(), seen, DECLARES_DELETIONS);
      reader.hub.add(id, theirs, DECLARES_DELETIONS);
      await commit(own, id, deleted('unwoken'));
      await until(() => !failNextWakeUp, 'the wake-up to be tried', 5_000);
      // At its tick, or on a notification of a process of another file.
      await until(() => theirs.sent.length === 1, 'the other process’s tick to read it', 5_000);
      assert.deepEqual(ids(theirs), ['unwoken']);
      await expectLost(from, seen, /wake-up failed/);
      await from.listener.stop();
    } finally {
      await own.end();
    }
  });

  it('when no read has completed for longer than it may at a tick', async () => {
    const from = await startProcess(pool, { tickMs: 50, readStaleMs: 300, firstRetryMs: 50 });
    const seen = viewer();

    from.hub.add(session(), seen, DECLARES_DELETIONS);

    const release = from.listener.holdReads();

    await until(() => seen.cut === 1, 'the registration to be cut', 5_000);
    release();
    await expectLost(from, seen, /no read completed/);
  });

  it('when a wanted event is gone before it is fetched', async () => {
    let remove = false;
    const from = await startProcess(pool, {
      tickMs: 60_000,
      firstRetryMs: 50,
      beforeFetch: async (wanted) => {
        if (remove) {
          remove = false;
          await pool.query('DELETE FROM realtime_events WHERE id = ANY($1::bigint[])', [wanted]);
        }
      },
    });
    const id = session();
    const seen = viewer();

    from.hub.add(id, seen, DECLARES_DELETIONS);
    remove = true;
    await commit(pool, id, deleted('gone'));
    await expectLost(from, seen, /gone before it was read/);
    assert.deepEqual(seen.sent, []);
  });

  it('when more rows are marked seen than it keeps', async () => {
    // Well above what the other test files commit meanwhile, which counts
    // too while the horizon is held.
    const from = await startProcess(pool, { tickMs: 60_000, maxSeen: 200, firstRetryMs: 50 });
    const seen = viewer();

    from.hub.add(session(), seen, DECLARES_DELETIONS);

    // A transaction left open holds the horizon below every later one, so
    // the rows committed after it stay marked seen until it ends.
    const holder = await other.connect();

    try {
      await holder.query('BEGIN');
      await appendEvent(holder, session(), deleted('holding the horizon'));

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        for (let index = 0; index < 250; index += 1) {
          await appendEvent(client, session(), deleted(`many${index}`));
        }

        await client.query('COMMIT');
      } finally {
        client.release();
      }

      committed(pool);
      await until(() => seen.cut === 1, 'the registration to be cut', 5_000);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    await expectLost(from, seen, /marked seen/);
  });

  it('when more wanted events wait in one read than it delivers', async () => {
    const from = await startProcess(pool, { tickMs: 60_000, maxWanted: 2, firstRetryMs: 50 });
    const id = session();
    const seen = viewer();

    from.hub.add(id, seen, DECLARES_DELETIONS);

    const release = from.listener.holdReads();

    for (let index = 0; index < 3; index += 1) {
      await commit(pool, id, deleted(`wanted${index}`));
    }

    release();
    await expectLost(from, seen, /waiting to be delivered/);
    assert.deepEqual(seen.sent, []);
  });

  it('keeps the hub deaf until it has listened and read its baseline again', async () => {
    let hold: Promise<void> | null = null;
    let open: () => void = () => undefined;
    const from = await startProcess(pool, {
      tickMs: 100,
      firstRetryMs: 50,
      beforeReconnect: async () => {
        await hold;
      },
    });
    const seen = viewer();

    from.hub.add(session(), seen, DECLARES_DELETIONS);
    hold = new Promise((resolve) => {
      open = resolve;
    });
    await pool.query('SELECT pg_terminate_backend($1)', [from.listener.processId]);
    await until(() => seen.cut === 1, 'the registration to be cut', 5_000);
    assert.equal(from.hub.deaf, true);
    await delay(200);
    assert.equal(from.hub.deaf, true, 'heard again before it listened');
    open();
    await until(() => !from.hub.deaf, 'the hub to hear again', 5_000);
    assert.equal(from.listener.listening, true);
  });
});
