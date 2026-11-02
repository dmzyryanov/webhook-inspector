/**
 * The write side of the realtime outbox (D221) through the API, against the
 * database: every change writes its event in its own transaction, and every
 * deletion takes from the outbox what it deletes, at once - `/privacy`'s
 * "until you delete it" - including a recorded response whose write was
 * under way when its request was deleted. An expired session writes nothing.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { withExpiredSession } from '../../testing/expired-session.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import { RECORD_COMPLETION_SQL } from '../webhook/repository.ts';

let pool: pg.Pool;
let servers: TestServers;
const created: string[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    servers = buildTestServers(pool);
    servers.api.log.level = 'silent';
    servers.receiver.log.level = 'silent';
    await servers.ready();
  })();
  await startup;
});

after(async () => {
  await startup;

  if (created.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [created]);
  }

  await servers?.close();
  await pool?.end();
});

/**
 * Waits until a backend whose statement is `like` is blocked by one of
 * `blockers` (`pg_blocking_pids`), and answers its pid.
 */
async function blockedOn(blockers: number[], like: string): Promise<number> {
  for (let attempt = 0; attempt < 2_500; attempt += 1) {
    const result = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE query LIKE $1 AND pg_blocking_pids(pid) && $2::int[]`,
      [like, blockers],
    );

    if (result.rows[0] !== undefined) {
      return result.rows[0].pid;
    }

    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  throw new Error(`nothing ran ${like.slice(0, 40)} blocked`);
}

interface Row {
  kind: string;
  request_id: string | null;
  payload: string | null;
}

async function rows(sessionId: string): Promise<Row[]> {
  const result = await pool.query<Row>(
    `SELECT kind, request_id::text AS request_id, payload
       FROM realtime_events WHERE session_id = $1 ORDER BY id`,
    [sessionId],
  );

  return result.rows;
}

async function newSession(): Promise<string> {
  const response = await servers.api.inject({ method: 'POST', url: '/api/sessions' });
  const { id } = response.json<{ id: string }>();

  created.push(id);

  return id;
}

async function capture(sessionId: string): Promise<string> {
  const response = await servers.receiver.inject({
    method: 'POST',
    url: `/s/${sessionId}`,
    headers: { 'content-type': 'application/json' },
    payload: '{"secret":"captured data"}',
  });

  assert.equal(response.statusCode, 200);

  return String(response.headers['x-qa-tools-request-id']);
}

describe('what the outbox keeps of a change (D221)', () => {
  it('writes each change’s event with the change, the request it carries data of named', async () => {
    const sessionId = await newSession();
    const requestId = await capture(sessionId);

    await servers.writes.settled();

    const written = await rows(sessionId);

    assert.deepEqual(
      written.map((row) => [row.kind, row.request_id]),
      [
        ['request.received', requestId],
        ['response.recorded', requestId],
      ],
    );

    const received = JSON.parse(written[0]?.payload ?? '{}') as {
      type: string;
      data: { id: string; path: string };
    };

    assert.equal(received.type, 'request.received');
    assert.equal(received.data.id, requestId);
    assert.equal(received.data.path, `/s/${sessionId}`);
  });

  it('purges a deleted request’s events at once, and keeps the deletion’s own', async () => {
    const sessionId = await newSession();
    const deletedId = await capture(sessionId);
    const keptId = await capture(sessionId);

    await servers.writes.settled();
    assert.equal(
      (
        await servers.api.inject({
          method: 'DELETE',
          url: `/api/sessions/${sessionId}/requests/${deletedId.toUpperCase()}`,
        })
      ).statusCode,
      204,
    );

    const after = await rows(sessionId);

    for (const row of after.filter((each) => each.request_id === deletedId)) {
      assert.equal(row.payload, null, `${row.kind} of the deleted request kept its data`);
    }

    assert.ok(
      after.filter((row) => row.request_id === keptId).every((row) => row.payload !== null),
    );
    assert.deepEqual(after.at(-1), {
      kind: 'request.deleted',
      request_id: null,
      payload: JSON.stringify({ type: 'request.deleted', data: { id: deletedId } }),
    });
  });

  it('purges every request’s events on a clear, and keeps the session’s own and the clear', async () => {
    const sessionId = await newSession();

    await capture(sessionId);
    await capture(sessionId);
    await servers.api.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/response`,
      payload: { mode: 'custom', response: { status: 202 } },
    });
    await servers.writes.settled();
    assert.equal(
      (await servers.api.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/requests` }))
        .statusCode,
      204,
    );

    const after = await rows(sessionId);

    assert.ok(
      after.filter((row) => row.request_id !== null).every((row) => row.payload === null),
      'a cleared request kept its data in the outbox',
    );
    assert.ok(after.some((row) => row.kind === 'session.updated' && row.payload !== null));
    assert.deepEqual(after.at(-1), {
      kind: 'requests.cleared',
      request_id: null,
      payload: '{"type":"requests.cleared"}',
    });
  });

  it('purges every event of a deleted session at once and writes its close; a retry writes another', async () => {
    const sessionId = await newSession();

    await capture(sessionId);
    await servers.api.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/response`,
      payload: { mode: 'custom', response: { status: 202, body: 'kept in the session' } },
    });
    await servers.writes.settled();
    assert.equal(
      (await servers.api.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}` }))
        .statusCode,
      204,
    );

    const after = await rows(sessionId);

    assert.ok(
      after.every((row) => row.payload === null),
      'the deleted session kept data',
    );
    assert.equal(after.at(-1)?.kind, 'close');

    // The retry of a deletion whose answer was lost: `404`, and a close.
    assert.equal(
      (await servers.api.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}` }))
        .statusCode,
      404,
    );
    assert.deepEqual((await rows(sessionId)).filter((row) => row.kind === 'close').length, 2);
  });

  it('writes nothing for an expired session’s refused deletion (D076)', async (t) => {
    await withExpiredSession(t, pool, newSession, async (sessionId) => {
      const before = await rows(sessionId);

      assert.equal(
        (await servers.api.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}` }))
          .statusCode,
        410,
      );
      assert.deepEqual(await rows(sessionId), before);
    });
  });

  it('purges a recorded response whose write was under way while its request was deleted', async () => {
    const sessionId = await newSession();
    // The completion's one statement (#260) sent while a transaction under
    // way holds its response record, so that it waits for the record with
    // its write begun; the deletion of its request, queued behind it, waits
    // for it in turn, then purges what it wrote.
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = true;
    const gated = new Proxy(pool, {
      get(target, property) {
        if (property === 'query') {
          return async (...args: unknown[]) => {
            if (args[0] === RECORD_COMPLETION_SQL && armed) {
              armed = false;
              reached();
              await released;
            }

            return (target.query as (...values: unknown[]) => Promise<unknown>)(...args);
          };
        }

        const value = Reflect.get(target, property, target);

        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const own = buildTestServers(gated);
    const holder = await pool.connect();
    let holding = false;

    own.api.log.level = 'silent';
    own.receiver.log.level = 'silent';

    try {
      await own.ready();

      const response = await own.receiver.inject({
        method: 'POST',
        url: `/s/${sessionId}`,
        payload: 'x',
      });
      const requestId = String(response.headers['x-qa-tools-request-id']);

      await reachedPromise;
      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT 1 FROM request_responses WHERE request_id = $1 FOR UPDATE', [
        requestId,
      ]);

      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid as number;

      release();

      const completer = await blockedOn([holderPid], RECORD_COMPLETION_SQL);
      let deleted = false;
      const deleting = servers.api
        .inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/requests/${requestId}` })
        .then((answer) => {
          deleted = true;

          return answer;
        });

      await blockedOn([holderPid, completer], '%DELETE FROM requests%');
      assert.equal(deleted, false, 'the deletion did not wait for the completion');
      await holder.query('ROLLBACK');
      holding = false;
      assert.equal((await deleting).statusCode, 204);
      await own.writes.settled();

      const after = await rows(sessionId);
      const recorded = after.find((row) => row.kind === 'response.recorded');

      assert.ok(recorded, 'the completion wrote no event');
      assert.equal(recorded.payload, null, 'the recorded response outlived its request');
    } finally {
      release();

      if (holding) {
        await holder.query('ROLLBACK');
      }

      holder.release();
      await own.close();
    }
  });
});
