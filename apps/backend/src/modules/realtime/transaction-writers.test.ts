/**
 * The capture and a change to what a session answers on the outbox writers'
 * transaction (`inTransaction`, D221, #209), and a response's completion,
 * against the database, through a pool whose connections pass every
 * statement on and write it down by name as it returns, the readers' wake-up
 * and the connection's release in their place among them:
 *
 * - the statements one capture and one change send on their connection, each
 *   once and in order, against lists written here: the ones they sent before
 *   #209, with no round trip added to the capture path, and since #260 a
 *   capture's eight when its session's expiry is not due to move, the refresh's
 *   three more only when it is; and a completion's one statement on the pool;
 * - the readers woken once, after `COMMIT` has returned, by a capture and by a
 *   change that appended its `session.updated`, and by nothing else: not by a
 *   restart or a removal on a session that held no queue, nor by a refusal,
 *   which rolls back and writes nothing;
 * - a statement made to fail inside either, without being sent, with its
 *   `ROLLBACK` working or made to fail as well: the statement's error reaching
 *   the caller and not the rollback's, nothing written, nobody woken, and the
 *   connection returned, or discarded - released with the rollback's failure,
 *   so that the pool ends it, and the session row's lock goes with it.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { withExpiredSession } from '../../testing/expired-session.ts';
import { awaitBlockedBy } from '../../testing/locks.ts';
import { fingerprintOf } from '../sessions/access-key.ts';
import {
  REFRESH_SESSION_EXPIRY_SQL,
  updateSessionQueue,
  updateSessionResponse,
  type ResponseChange,
} from '../sessions/repository.ts';
import {
  CAPTURE_EXPIRY_SQL,
  INSERT_REQUEST_SQL,
  INSERT_RESPONSE_SQL,
  RECORD_COMPLETION_SQL,
  recordResponseCompletion,
  storeRequest,
  type CapturedRequest,
} from '../webhook/repository.ts';
import { APPEND_EVENT_SQL, observeCommits } from './events.ts';

const ORIGIN = 'https://qa-tools.example';

/** A key of a key's shape (D161), and another that does not open its session. */
const KEY = 'K'.repeat(43);
const OTHER_KEY = 'O'.repeat(43);

/** The expiry read a change sends once the lock is held, as written there. */
const EXPIRY_READ = 'SELECT expires_at <= clock_timestamp() AS expired FROM sessions WHERE id = $1';

/** The queue's step taken by a capture it answered (D205), as written there. */
const TAKE_QUEUE_STEP =
  'UPDATE sessions SET response_queue_answered = response_queue_answered + 1 WHERE id = $1';

/** The capture's lock and the change's: the session row `FOR UPDATE`, whatever it reads. */
const LOCK = /^SELECT id, [\s\S]+ FROM sessions WHERE id = \$1 FOR UPDATE$/;

/** The capture's eviction of what lies beyond the newest 1000 (D006). */
const EVICT =
  /^DELETE FROM requests\s+WHERE id IN \(\s+SELECT id FROM requests\s+WHERE session_id = \$1\s+ORDER BY received_at DESC, id DESC\s+OFFSET \$2\s+\)$/;

/** A change's own write: the one `UPDATE` of the row that returns the new state. */
const WRITE = /^UPDATE sessions\s+SET [\s\S]+ WHERE id = \$1\s+RETURNING /;

/**
 * The name of a statement either writer sends, or `unexpected …` for any
 * other, so that a statement added, removed or moved changes a list below.
 */
function nameOf(text: unknown): string {
  switch (text) {
    case 'BEGIN':
    case 'COMMIT':
    case 'ROLLBACK':
    case 'SAVEPOINT refresh_expiry':
    case 'RELEASE SAVEPOINT refresh_expiry':
    case 'ROLLBACK TO SAVEPOINT refresh_expiry':
      return text;
    case INSERT_REQUEST_SQL:
      return 'insert request';
    case INSERT_RESPONSE_SQL:
      return 'insert response';
    case APPEND_EVENT_SQL:
      return 'append event';
    case REFRESH_SESSION_EXPIRY_SQL:
      return 'refresh expiry';
    case EXPIRY_READ:
      return 'read expiry';
    case CAPTURE_EXPIRY_SQL:
      return 'read expiry and refresh due';
    case RECORD_COMPLETION_SQL:
      return 'record completion';
    case TAKE_QUEUE_STEP:
      return 'take queue step';
  }

  if (typeof text !== 'string') {
    return `unexpected ${typeof text}`;
  }

  if (LOCK.test(text)) {
    return 'lock session';
  }

  if (EVICT.test(text)) {
    return 'evict oldest';
  }

  if (WRITE.test(text)) {
    return 'write change';
  }

  return `unexpected ${text.replace(/\s+/g, ' ').slice(0, 120)}`;
}

/**
 * One capture's statements before #209 and since, in order, a session
 * response answering and the session's expiry due to move: eleven, the
 * expiry read naming whether it is due since #260.
 */
const CAPTURE = [
  'BEGIN',
  'lock session',
  'read expiry and refresh due',
  'insert request',
  'evict oldest',
  'insert response',
  'SAVEPOINT refresh_expiry',
  'refresh expiry',
  'RELEASE SAVEPOINT refresh_expiry',
  'append event',
  'COMMIT',
];

/** The refresh's three statements, sent only when the expiry is due to move (#260). */
const REFRESH = ['SAVEPOINT refresh_expiry', 'refresh expiry', 'RELEASE SAVEPOINT refresh_expiry'];

/** The same with the expiry not due to move: eight, the refresh's three left out (#260). */
const CAPTURE_NOT_DUE = CAPTURE.filter((name) => !REFRESH.includes(name));

/** The same with the queue's step answering: its `UPDATE` after the response's record. */
function fromQueue(list: readonly string[]): string[] {
  return [
    ...list.slice(0, list.indexOf('insert response') + 1),
    'take queue step',
    ...list.slice(list.indexOf('insert response') + 1),
  ];
}

const CAPTURE_FROM_QUEUE = fromQueue(CAPTURE);

/** One announced change's statements, before #209 and since. */
const CHANGE = [
  'BEGIN',
  'lock session',
  'read expiry',
  'write change',
  'SAVEPOINT refresh_expiry',
  'refresh expiry',
  'RELEASE SAVEPOINT refresh_expiry',
  'append event',
  'COMMIT',
];

/** The statements `list` sends before `name`. */
function preceding(list: readonly string[], name: string): string[] {
  const index = list.indexOf(name);

  assert.notEqual(index, -1, `${name} is not in the list`);

  return list.slice(0, index);
}

/** Statements made to fail, by name, without being sent: their errors in turn, one a time. */
type Failing = Partial<Record<string, Error[]>>;

interface Recording {
  pool: pg.Pool;
  /** Each statement's name as it returned, `failed <name>`, `woken` and the release. */
  log: string[];
  /** What each connection was released with, in turn. */
  released: (Error | boolean | undefined)[];
}

let base: pg.Pool;
/** A pool of its own, so that a connection `base` kept can never answer for it. */
let other: pg.Pool;
const sessions: string[] = [];

before(() => {
  base = createPool(loadConfig().databaseUrl);
  other = createPool(loadConfig().databaseUrl);
});

after(async () => {
  if (sessions.length > 0) {
    await base.query('DELETE FROM realtime_events WHERE session_id = ANY($1)', [sessions]);
    await base.query('DELETE FROM sessions WHERE id = ANY($1)', [sessions]);
  }

  await Promise.all([base.end(), other.end()]);
});

/**
 * A public session of this run, or a keyed one, that expires in an hour - so
 * that a capture's refresh is due, its window being 7 days - or in
 * `expiresIn`: in 7 days a capture finds nothing due.
 */
async function newSession(key: string | null = null, expiresIn = '1 hour'): Promise<string> {
  const id = randomBytes(32).toString('base64url');

  sessions.push(id);
  await base.query(
    `INSERT INTO sessions (id, expires_at, access_key_hash)
     VALUES ($1, now() + $3::interval, $2)`,
    [id, key === null ? null : fingerprintOf(key), expiresIn],
  );

  return id;
}

/** How a session of `newSession` is made to find no refresh due: a full window ahead. */
const NOT_DUE = '7 days';

/**
 * A session holding a queue of two steps, from step 1, that expires in an
 * hour or in `expiresIn`: set once the queue is, which refreshes it (D133).
 */
async function queuedSession(expiresIn = '1 hour'): Promise<string> {
  const id = await newSession(null, expiresIn);
  const step = {
    status: 201,
    headers: [] as [string, string][],
    body: 'step',
    delayMs: 0,
    template: false,
  };
  const queued = await updateSessionQueue(base, id, { action: 'set', steps: [step, step] });

  assert.equal(queued.outcome, 'updated');
  await base.query('UPDATE sessions SET expires_at = now() + $2::interval WHERE id = $1', [
    id,
    expiresIn,
  ]);

  return id;
}

/** One capture into `sessionId`. */
function captured(sessionId: string, body = 'a capture'): CapturedRequest {
  return {
    sessionId,
    method: 'POST',
    path: `/s/${sessionId}`,
    httpVersion: '1.1',
    queryString: '',
    headers: [],
    body: Buffer.from(body),
    rawRequestHead: Buffer.from(`POST /s/${sessionId} HTTP/1.1\r\n\r\n`),
    sourceIp: '203.0.113.7',
  };
}

/**
 * What a session holds: its row whole, expiry included, and how many
 * requests, response records and events it has - or `null` when it is gone.
 */
async function held(sessionId: string): Promise<unknown> {
  const result = await base.query<{ state: unknown }>(
    `SELECT jsonb_build_object(
              'row', to_jsonb(s),
              'requests', (SELECT count(*) FROM requests r WHERE r.session_id = s.id),
              'responses', (SELECT count(*) FROM request_responses rr
                              JOIN requests r ON r.id = rr.request_id
                             WHERE r.session_id = s.id),
              'events', (SELECT count(*) FROM realtime_events e WHERE e.session_id = s.id)
            ) AS state
       FROM sessions s WHERE s.id = $1`,
    [sessionId],
  );

  return result.rows[0]?.state ?? null;
}

/** The expiry a session's row holds. */
async function expiresAt(sessionId: string): Promise<Date> {
  const result = await base.query<{ expires_at: Date }>(
    'SELECT expires_at FROM sessions WHERE id = $1',
    [sessionId],
  );

  return result.rows[0]?.expires_at as Date;
}

/** How many requests, response records and events a session has. */
async function counts(
  sessionId: string,
): Promise<{ requests: number; responses: number; events: number }> {
  const result = await base.query<{ requests: number; responses: number; events: number }>(
    `SELECT (SELECT count(*)::int FROM requests WHERE session_id = $1) AS requests,
            (SELECT count(*)::int FROM request_responses rr
               JOIN requests r ON r.id = rr.request_id
              WHERE r.session_id = $1) AS responses,
            (SELECT count(*)::int FROM realtime_events WHERE session_id = $1) AS events`,
    [sessionId],
  );

  return result.rows[0] as { requests: number; responses: number; events: number };
}

/**
 * Takes the session row's lock on a connection of `other`, waiting for it at
 * most 10 s: it answers once no connection holds the row, and fails with the
 * lock timeout while one does.
 */
async function lockIsFree(sessionId: string): Promise<void> {
  const client = await other.connect();

  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");

    const locked = await client.query('SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE', [
      sessionId,
    ]);

    assert.equal(locked.rowCount, 1);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/**
 * Runs `run` on a proxy of a pool of its own whose connections log each
 * statement by name once it has returned, fail the statements named in
 * `failing` without sending them, and log their release; the readers' wake-up
 * is logged in its place. No listener runs in this file, so the observer is
 * the pool's only one.
 *
 * The pool is ended afterwards, so that a connection a writer wrongly gave
 * back with its transaction open - as 1.7.2's bare `ROLLBACK` did when it
 * failed - ends with it and cannot run the next test's statements.
 */
async function recording<T>(
  failing: Failing,
  run: (recorded: Recording) => Promise<T>,
): Promise<T> {
  const own = createPool(loadConfig().databaseUrl);
  const log: string[] = [];
  const released: (Error | boolean | undefined)[] = [];
  const forward = <O extends object>(target: O, property: string | symbol): unknown => {
    const value = Reflect.get(target, property, target);

    return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
  };
  /** A statement on a client of the pool or on the pool itself, logged and failed alike. */
  const logging =
    (query: (...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]): Promise<unknown> => {
      const name = nameOf(args[0]);
      const failure = failing[name]?.shift();

      if (failure !== undefined) {
        log.push(`failed ${name}`);
        throw failure;
      }

      const answer = await query(...args);

      log.push(name);

      return answer;
    };
  const pool = new Proxy(own, {
    get(target, property) {
      // A completion's one statement runs on the pool, not on a client it
      // holds (#260).
      if (property === 'query') {
        return logging(target.query.bind(target) as (...args: unknown[]) => Promise<unknown>);
      }

      if (property !== 'connect') {
        return forward(target, property);
      }

      return async () => {
        const client = await target.connect();
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;

        return new Proxy(client, {
          get(clientTarget, clientProperty) {
            if (clientProperty === 'release') {
              return (error?: Error | boolean) => {
                released.push(error);
                log.push(error === undefined ? 'released' : 'released, discarded');
                clientTarget.release(error);
              };
            }

            if (clientProperty !== 'query') {
              return forward(clientTarget, clientProperty);
            }

            return logging(query);
          },
        });
      };
    },
  });
  const observer = { poke: () => undefined, wake: () => log.push('woken') };

  observeCommits(pool, observer);

  try {
    return await run({ pool, log, released });
  } finally {
    observeCommits(pool, observer, false);
    await own.end();
  }
}

describe('a capture on the outbox writers’ transaction (D221, #209)', () => {
  it('sends the statements it sent before #209 when its expiry is due to move, each once and in order, eleven, and wakes the readers once, after COMMIT has returned', async () => {
    const sessionId = await newSession();
    const before = await expiresAt(sessionId);

    await recording({}, async ({ pool, log, released }) => {
      const result = await storeRequest(pool, captured(sessionId), ORIGIN);

      assert.equal(result.outcome, 'stored');
      assert.deepEqual(log, [...CAPTURE, 'woken', 'released']);
      assert.equal(CAPTURE.length, 11);
      assert.deepEqual(released, [undefined]);
    });

    assert.ok((await expiresAt(sessionId)) > before, 'the due refresh did not move the expiry');
  });

  it('sends eight statements when its expiry is not due to move, the refresh’s three left out, and wakes the readers once (#260)', async () => {
    const sessionId = await newSession(null, NOT_DUE);
    const before = await expiresAt(sessionId);

    await recording({}, async ({ pool, log, released }) => {
      const result = await storeRequest(pool, captured(sessionId), ORIGIN);

      assert.equal(result.outcome, 'stored');
      assert.deepEqual(log, [...CAPTURE_NOT_DUE, 'woken', 'released']);
      assert.equal(CAPTURE_NOT_DUE.length, 8);
      assert.deepEqual(released, [undefined]);
    });

    assert.deepEqual(await expiresAt(sessionId), before);
    assert.deepEqual(await counts(sessionId), { requests: 1, responses: 1, events: 1 });
  });

  it('takes the queue’s step after the response’s record when a step answers, and wakes the readers once', async () => {
    const sessionId = await queuedSession();

    await recording({}, async ({ pool, log }) => {
      const result = await storeRequest(pool, captured(sessionId), ORIGIN);

      assert.equal(result.outcome, 'stored');
      assert.equal(result.outcome === 'stored' ? result.composed.status : null, 201);
      assert.deepEqual(log, [...CAPTURE_FROM_QUEUE, 'woken', 'released']);
      assert.equal(CAPTURE_FROM_QUEUE.length, 12);
    });
  });

  it('takes the queue’s step in nine statements when its expiry is not due to move (#260)', async () => {
    const sessionId = await queuedSession(NOT_DUE);

    await recording({}, async ({ pool, log }) => {
      const result = await storeRequest(pool, captured(sessionId), ORIGIN);

      assert.equal(result.outcome, 'stored');
      assert.equal(result.outcome === 'stored' ? result.composed.status : null, 201);
      assert.deepEqual(log, [...fromQueue(CAPTURE_NOT_DUE), 'woken', 'released']);
      assert.equal(fromQueue(CAPTURE_NOT_DUE).length, 9);
    });
  });

  it('stores and announces a capture whose due refresh fails, rolled back to its savepoint, and wakes the readers once (D133)', async () => {
    const sessionId = await newSession();
    const before = await expiresAt(sessionId);
    const failure = new Error('the refresh failed');

    await recording({ 'refresh expiry': [failure] }, async ({ pool, log, released }) => {
      const result = await storeRequest(pool, captured(sessionId), ORIGIN);

      assert.equal(result.outcome, 'stored');
      assert.deepEqual(log, [
        ...preceding(CAPTURE, 'refresh expiry'),
        'failed refresh expiry',
        'ROLLBACK TO SAVEPOINT refresh_expiry',
        'append event',
        'COMMIT',
        'woken',
        'released',
      ]);
      assert.deepEqual(released, [undefined]);
    });

    assert.deepEqual(await expiresAt(sessionId), before);
    assert.deepEqual(await counts(sessionId), { requests: 1, responses: 1, events: 1 });
  });

  /**
   * Whether the expiry is due is read once the lock is held (#260's attack
   * list, a refresh due exactly at the lock): a session not yet due while
   * its capture waits for the row, and due by the time the lock is free, is
   * refreshed by that capture - what the locking statement selects may be
   * computed before its wait, the clock with it, so it is read in the
   * statement after. The lock's holder leaves the row as it was.
   */
  it('refreshes an expiry that fell due while it waited for the session’s lock, judged once the lock is held (#260)', async () => {
    const sessionId = await newSession(null, NOT_DUE);
    const holder = await other.connect();
    let holding = false;

    try {
      // Due 1.5 s from now: 7 days, less the hour's throttle, ahead.
      await base.query(
        `UPDATE sessions
            SET expires_at = clock_timestamp() + interval '7 days' - interval '1 hour'
                             + interval '1.5 seconds'
          WHERE id = $1`,
        [sessionId],
      );
      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);

      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid as number;
      const before = await expiresAt(sessionId);

      await recording({}, async ({ pool, log }) => {
        const capturing = storeRequest(pool, captured(sessionId), ORIGIN);

        await awaitBlockedBy(base, holderPid);
        await delay(2_000);
        await holder.query('ROLLBACK');
        holding = false;
        assert.equal((await capturing).outcome, 'stored');
        assert.deepEqual(log, [...CAPTURE, 'woken', 'released']);
      });

      const moved = (await expiresAt(sessionId)).getTime() - before.getTime();

      assert.ok(moved > 3_000_000, `the expiry moved ${moved} ms, not by the refresh`);
    } finally {
      if (holding) {
        await holder.query('ROLLBACK');
      }

      holder.release();
    }
  });

  /**
   * And the other way: a session due when its capture begins to wait, which
   * the lock's holder refreshes meanwhile, is not refreshed again - uses at
   * once write once, and now send the refresh's statements once too.
   */
  it('sends no refresh for an expiry the lock’s holder moved while it waited (#260)', async () => {
    const sessionId = await newSession();
    const holder = await other.connect();
    let holding = false;

    try {
      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);

      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid as number;

      await recording({}, async ({ pool, log }) => {
        const capturing = storeRequest(pool, captured(sessionId), ORIGIN);

        await awaitBlockedBy(base, holderPid);
        assert.equal((await holder.query(REFRESH_SESSION_EXPIRY_SQL, [sessionId])).rowCount, 1);
        await holder.query('COMMIT');
        holding = false;
        assert.equal((await capturing).outcome, 'stored');
        assert.deepEqual(log, [...CAPTURE_NOT_DUE, 'woken', 'released']);
      });
    } finally {
      if (holding) {
        await holder.query('ROLLBACK');
      }

      holder.release();
    }
  });

  it('rolls an unknown session’s capture back once its lock has found nothing, and wakes nobody', async () => {
    const sessionId = randomBytes(32).toString('base64url');

    await recording({}, async ({ pool, log }) => {
      assert.deepEqual(await storeRequest(pool, captured(sessionId), ORIGIN), {
        outcome: 'session-not-found',
      });
      assert.deepEqual(log, ['BEGIN', 'lock session', 'ROLLBACK', 'released']);
    });
  });

  it('rolls an expired session’s capture back once its expiry is read, writes nothing and wakes nobody', async (t) => {
    await withExpiredSession(
      t,
      base,
      () => newSession(),
      async (sessionId) => {
        const before = await held(sessionId);

        await recording({}, async ({ pool, log }) => {
          assert.deepEqual(await storeRequest(pool, captured(sessionId), ORIGIN), {
            outcome: 'session-expired',
          });
          assert.deepEqual(log, [
            'BEGIN',
            'lock session',
            'read expiry and refresh due',
            'ROLLBACK',
            'released',
          ]);
        });
        assert.deepEqual(await held(sessionId), before);
        assert.deepEqual(await counts(sessionId), { requests: 0, responses: 0, events: 0 });
      },
    );
  });

  for (const failed of ['insert request', 'insert response', 'append event']) {
    it(`rolls a capture back when its ${failed} fails: that error, nothing written, nobody woken, the connection returned`, async () => {
      const sessionId = await newSession();
      const before = await held(sessionId);
      const failure = new Error(`the ${failed} failed`);

      await recording({ [failed]: [failure] }, async ({ pool, log, released }) => {
        await assert.rejects(storeRequest(pool, captured(sessionId), ORIGIN), (error) => {
          assert.equal(error, failure);

          return true;
        });
        assert.deepEqual(log, [
          ...preceding(CAPTURE, failed),
          `failed ${failed}`,
          'ROLLBACK',
          'released',
        ]);
        assert.deepEqual(released, [undefined]);
      });
      assert.deepEqual(await held(sessionId), before);
    });

    it(`answers a capture whose ${failed} fails and whose ROLLBACK fails as well with the statement’s error, discards the connection, and the row’s lock goes with it`, async () => {
      const sessionId = await newSession();
      const before = await held(sessionId);
      const failure = new Error(`the ${failed} failed`);
      const rollbackFailure = new Error('the rollback failed');

      await recording(
        { [failed]: [failure], ROLLBACK: [rollbackFailure] },
        async ({ pool, log, released }) => {
          await assert.rejects(storeRequest(pool, captured(sessionId), ORIGIN), (error) => {
            assert.equal(error, failure, 'the caller did not receive the statement’s error');

            return true;
          });
          assert.deepEqual(log, [
            ...preceding(CAPTURE, failed),
            `failed ${failed}`,
            'failed ROLLBACK',
            'released, discarded',
          ]);
          assert.equal(released.length, 1);
          assert.equal(released[0], rollbackFailure, 'the connection was not discarded');

          // The transaction was never ended on the server: the connection
          // still held the session row `FOR UPDATE` when it was released. The
          // pool ended it on its release, with the recording pool still open,
          // so the server rolled it back and the lock is free.
          await lockIsFree(sessionId);
        },
      );

      assert.deepEqual(await held(sessionId), before);

      const next = await storeRequest(base, captured(sessionId, 'the next capture'), ORIGIN);

      assert.equal(next.outcome, 'stored');
      assert.equal(
        (await base.query('SELECT 1 FROM requests WHERE session_id = $1', [sessionId])).rowCount,
        1,
      );
    });
  }

  it('answers a capture whose COMMIT fails with that error, wakes nobody and announces nothing', async () => {
    const sessionId = await newSession();
    const before = await held(sessionId);
    const failure = new Error('the commit failed');

    await recording({ COMMIT: [failure] }, async ({ pool, log, released }) => {
      await assert.rejects(storeRequest(pool, captured(sessionId), ORIGIN), (error) => {
        assert.equal(error, failure);

        return true;
      });
      assert.deepEqual(log, [
        ...preceding(CAPTURE, 'COMMIT'),
        'failed COMMIT',
        'ROLLBACK',
        'released',
      ]);
      assert.deepEqual(released, [undefined]);
    });
    assert.deepEqual(await held(sessionId), before);
  });

  it('tries a refused capture’s failing ROLLBACK once more, answers its error and discards the connection when that fails too', async () => {
    const sessionId = randomBytes(32).toString('base64url');
    const first = new Error('the rollback failed');
    const second = new Error('the rollback failed again');

    await recording({ ROLLBACK: [first, second] }, async ({ pool, log, released }) => {
      await assert.rejects(storeRequest(pool, captured(sessionId), ORIGIN), (error) => {
        assert.equal(error, first);

        return true;
      });
      assert.deepEqual(log, [
        'BEGIN',
        'lock session',
        'failed ROLLBACK',
        'failed ROLLBACK',
        'released, discarded',
      ]);
      assert.deepEqual(released, [second]);
    });
  });
});

describe('a change to what a session answers on the outbox writers’ transaction (D150, D205, D221, D245, #209)', () => {
  const custom: ResponseChange = {
    mode: 'custom',
    response: {
      status: 202,
      headers: [['X-Changed', 'yes']],
      body: 'changed',
      delayMs: 0,
      template: false,
    },
  };

  it('sends the statements of a response change on a session with a queue and wakes the readers once, after COMMIT has returned', async () => {
    const sessionId = await queuedSession();

    await recording({}, async ({ pool, log, released }) => {
      const result = await updateSessionResponse(pool, sessionId, custom);

      assert.equal(result.outcome, 'updated');
      assert.equal(result.outcome === 'updated' ? result.hadQueue : null, true);
      assert.deepEqual(log, [...CHANGE, 'woken', 'released']);
      assert.deepEqual(released, [undefined]);
    });
  });

  for (const [action, what] of [
    ['restart', 'a restart'],
    ['remove', 'a removal'],
  ] as const) {
    it(`commits ${what} of the queue on a session without one, appends nothing and wakes nobody`, async () => {
      const sessionId = await newSession();

      await recording({}, async ({ pool, log, released }) => {
        const result = await updateSessionQueue(pool, sessionId, { action });

        assert.equal(result.outcome, 'updated');
        assert.equal(result.outcome === 'updated' ? result.hadQueue : null, false);
        assert.deepEqual(log, [...CHANGE.filter((name) => name !== 'append event'), 'released']);
        assert.deepEqual(released, [undefined]);
      });

      const events = await base.query('SELECT 1 FROM realtime_events WHERE session_id = $1', [
        sessionId,
      ]);

      assert.equal(events.rowCount, 0);
    });
  }

  it('refuses a change to a session that does not exist once its lock has found nothing, and wakes nobody', async () => {
    const sessionId = randomBytes(32).toString('base64url');

    await recording({}, async ({ pool, log }) => {
      assert.deepEqual(await updateSessionResponse(pool, sessionId, { mode: 'default' }), {
        outcome: 'session-not-found',
      });
      assert.deepEqual(log, ['BEGIN', 'lock session', 'ROLLBACK', 'released']);
    });
  });

  for (const [what, presented] of [
    ['no key', null],
    ['another key', OTHER_KEY],
  ] as const) {
    it(`refuses a change to a keyed session with ${what} before its expiry is read, writes nothing and wakes nobody`, async () => {
      const sessionId = await newSession(KEY);
      const before = await held(sessionId);

      await recording({}, async ({ pool, log }) => {
        assert.deepEqual(
          await updateSessionResponse(pool, sessionId, custom, undefined, presented),
          { outcome: 'session-not-found' },
        );
        assert.deepEqual(log, ['BEGIN', 'lock session', 'ROLLBACK', 'released']);
      });
      assert.deepEqual(await held(sessionId), before);
    });
  }

  it('refuses a change to an expired session once its expiry is read, writes nothing and wakes nobody', async (t) => {
    await withExpiredSession(
      t,
      base,
      () => newSession(KEY),
      async (sessionId) => {
        const before = await held(sessionId);

        await recording({}, async ({ pool, log }) => {
          assert.deepEqual(await updateSessionResponse(pool, sessionId, custom, undefined, KEY), {
            outcome: 'session-expired',
          });
          assert.deepEqual(log, ['BEGIN', 'lock session', 'read expiry', 'ROLLBACK', 'released']);
        });
        assert.deepEqual(await held(sessionId), before);
      },
    );
  });

  it('rolls a change back when its UPDATE fails: that error, nothing written, nobody woken, the connection returned', async () => {
    const sessionId = await queuedSession();
    const before = await held(sessionId);
    const failure = new Error('the change failed');

    await recording({ 'write change': [failure] }, async ({ pool, log, released }) => {
      await assert.rejects(updateSessionResponse(pool, sessionId, custom), (error) => {
        assert.equal(error, failure);

        return true;
      });
      assert.deepEqual(log, [
        ...preceding(CHANGE, 'write change'),
        'failed write change',
        'ROLLBACK',
        'released',
      ]);
      assert.deepEqual(released, [undefined]);
    });
    assert.deepEqual(await held(sessionId), before);
  });

  it('answers a change whose UPDATE fails and whose ROLLBACK fails as well with the UPDATE’s error, discards the connection, and the row’s lock goes with it', async () => {
    const sessionId = await queuedSession();
    const before = await held(sessionId);
    const failure = new Error('the change failed');
    const rollbackFailure = new Error('the rollback failed');

    await recording(
      { 'write change': [failure], ROLLBACK: [rollbackFailure] },
      async ({ pool, log, released }) => {
        await assert.rejects(updateSessionResponse(pool, sessionId, custom), (error) => {
          assert.equal(error, failure, 'the caller did not receive the statement’s error');

          return true;
        });
        assert.deepEqual(log, [
          ...preceding(CHANGE, 'write change'),
          'failed write change',
          'failed ROLLBACK',
          'released, discarded',
        ]);
        assert.equal(released.length, 1);
        assert.equal(released[0], rollbackFailure, 'the connection was not discarded');

        // As for the capture: the pool ended the connection that held the
        // row on its release, so the server rolled its transaction back and
        // the lock is free.
        await lockIsFree(sessionId);
      },
    );

    assert.deepEqual(await held(sessionId), before);

    const next = await updateSessionResponse(base, sessionId, custom);

    assert.equal(next.outcome, 'updated');
  });
});

describe('a response’s completion as one statement (D109, D221, #260)', () => {
  /** A capture of `sessionId` stored on `base`, and what its record holds of its answer. */
  async function stored(sessionId: string) {
    const result = await storeRequest(base, captured(sessionId), ORIGIN);

    assert.equal(result.outcome, 'stored');

    return result.outcome === 'stored'
      ? { requestId: result.request.id, answered: result.answered }
      : assert.fail('not stored');
  }

  /** The state a request's record holds. */
  async function state(requestId: string): Promise<string | undefined> {
    const result = await base.query<{ state: string }>(
      'SELECT state FROM request_responses WHERE request_id = $1',
      [requestId],
    );

    return result.rows[0]?.state;
  }

  it('records how a response ended and announces it in one statement on the pool, and wakes the readers once, after it has returned', async () => {
    const sessionId = await newSession(null, NOT_DUE);
    const { requestId, answered } = await stored(sessionId);

    await recording({}, async ({ pool, log, released }) => {
      const summary = await recordResponseCompletion(pool, sessionId, requestId, 'sent', answered);

      assert.deepEqual(summary, { state: 'sent', ...answered });
      assert.deepEqual(log, ['record completion', 'woken']);
      // No connection of its own was taken from the pool and given back.
      assert.deepEqual(released, []);
    });

    assert.equal(await state(requestId), 'sent');
    assert.deepEqual(await counts(sessionId), { requests: 1, responses: 1, events: 2 });
  });

  it('sends its one statement for a completion that changes nothing, writes no event and wakes nobody', async () => {
    const sessionId = await newSession(null, NOT_DUE);
    const { requestId, answered } = await stored(sessionId);

    await recordResponseCompletion(base, sessionId, requestId, 'sent', answered);

    await recording({}, async ({ pool, log }) => {
      assert.equal(
        await recordResponseCompletion(pool, sessionId, requestId, 'aborted', answered),
        null,
      );
      assert.deepEqual(log, ['record completion']);
    });

    assert.equal(await state(requestId), 'sent');
    assert.deepEqual(await counts(sessionId), { requests: 1, responses: 1, events: 2 });
  });

  it('answers a completion whose statement fails with that error, writes nothing and wakes nobody', async () => {
    const sessionId = await newSession(null, NOT_DUE);
    const { requestId, answered } = await stored(sessionId);
    const failure = new Error('the completion failed');

    await recording({ 'record completion': [failure] }, async ({ pool, log }) => {
      await assert.rejects(
        recordResponseCompletion(pool, sessionId, requestId, 'sent', answered),
        (error) => error === failure,
      );
      assert.deepEqual(log, ['failed record completion']);
    });

    assert.equal(await state(requestId), 'pending');
    assert.deepEqual(await counts(sessionId), { requests: 1, responses: 1, events: 1 });
  });
});
