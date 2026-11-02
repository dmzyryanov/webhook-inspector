/**
 * A response's completion as one statement (#260): the guarded `UPDATE` of
 * its record and its `response.recorded` written together, committing on
 * their own (D109, D221), the event built from what the capture recorded.
 * Against the database:
 *
 * - the event's payload is, byte for byte, the one the previous image writes
 *   from the stored row - so both images of a rollout read and write the same
 *   rows - for every kind of answer, a rule's, a queue step's, a custom
 *   response's and the default, and for every way a response ends; through
 *   the repository and through the receive listener, whose list then says
 *   what the event says;
 * - a completion that changes nothing writes no event and wakes nobody, and
 *   of two completions of one request at once, one is recorded, announced
 *   and woken for, and the other changes nothing;
 * - a completion racing its session's deletion or its request's leaves no
 *   payload of the deleted request behind: one that took the record first
 *   is purged by the deletion, which waited for it, and one that came after
 *   finds no record and announces nothing.
 *
 * A capture's statements, the completion's one among them, are counted in
 * `realtime/transaction-writers.test.ts`.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import type { RequestListItem, ResponseConfig, ResponseSummary } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import { observeCommits, type CommitObserver } from '../realtime/events.ts';
import { deleteRequest } from '../requests/repository.ts';
import { toRecordedQueueStep, toRecordedRuleSummary } from '../requests/response-state.ts';
import { deleteSession } from '../sessions/repository.ts';
import { createSession } from '../sessions/service.ts';
import {
  RECORD_COMPLETION_SQL,
  recordResponseCompletion,
  storeRequest,
  type CapturedRequest,
  type RecordedAnswer,
} from './repository.ts';
import type { SendOutcome } from './response.ts';

const ORIGIN = 'https://qa-tools.example';

let pool: pg.Pool;
/** The receive listener's and the API's, a pool of their own with its realtime listener. */
let serversPool: pg.Pool;
let servers: TestServers;
const created: string[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    serversPool = createPool(loadConfig().databaseUrl);
    servers = buildTestServers(serversPool);
    servers.api.log.level = 'silent';
    servers.receiver.log.level = 'silent';
    await servers.ready();
  })();
  await startup;
});

after(async () => {
  await startup?.catch(() => undefined);

  if (created.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [created]);
    await pool.query('DELETE FROM realtime_events WHERE session_id = ANY($1)', [created]);
  }

  await servers?.close();
  await serversPool?.end();
  await pool?.end();
});

const STEP: ResponseConfig = {
  status: 503,
  headers: [['X-Step', 'one']],
  body: 'step',
  delayMs: 0,
  template: false,
};

const CUSTOM: ResponseConfig = {
  status: 201,
  headers: [['X-Custom', 'yes']],
  body: '{"custom":true}',
  delayMs: 0,
  template: false,
};

const RULED: ResponseConfig = {
  status: 418,
  headers: [],
  body: 'ruled',
  delayMs: 0,
  template: false,
};

/** Each kind of answer a capture records, and the session that gives it to `POST /s/<id>/hook`. */
const KINDS: { name: string; make: () => Promise<string> }[] = [
  { name: 'the default answer', make: () => session(null) },
  { name: 'a custom response', make: () => session(CUSTOM) },
  { name: 'a queue’s step', make: () => session(CUSTOM, [STEP, STEP]) },
  {
    name: 'a response rule',
    make: () =>
      session(
        CUSTOM,
        [STEP],
        [
          { method: 'GET', path: '/other', response: STEP },
          { method: null, path: '/hook*', response: RULED },
        ],
      ),
  },
];

const OUTCOMES: SendOutcome[] = ['sent', 'aborted', 'failed'];

async function session(
  response: ResponseConfig | null,
  queue: ResponseConfig[] | null = null,
  rules: Parameters<typeof createSession>[6] = [],
): Promise<string> {
  const made = await createSession(pool, response, queue, null, null, true, rules);

  created.push(made.id);

  return made.id;
}

function captured(sessionId: string): CapturedRequest {
  return {
    sessionId,
    method: 'POST',
    path: `/s/${sessionId}/hook`,
    httpVersion: '1.1',
    queryString: '',
    headers: [['content-type', 'application/json']],
    body: Buffer.from('{"a":1}'),
    rawRequestHead: Buffer.from(`POST /s/${sessionId}/hook HTTP/1.1\r\n\r\n`),
    sourceIp: '203.0.113.7',
  };
}

/** A capture stored through the repository: its id and what its record holds of its answer. */
async function stored(sessionId: string): Promise<{ requestId: string; answered: RecordedAnswer }> {
  const result = await storeRequest(pool, captured(sessionId), ORIGIN);

  assert.equal(result.outcome, 'stored');

  return result.outcome === 'stored'
    ? { requestId: result.request.id, answered: result.answered }
    : assert.fail('not stored');
}

/** The summary the stored record gives, as the previous image builds its event from it. */
async function rowSummary(requestId: string): Promise<ResponseSummary | null> {
  const result = await pool.query<{
    state: ResponseSummary['state'];
    status: number | null;
    queue_step_index: number | null;
    queue_step_total: number | null;
    rule_index: number | null;
  }>(
    `SELECT state, status, queue_step_index, queue_step_total, rule_index
       FROM request_responses WHERE request_id = $1`,
    [requestId],
  );
  const row = result.rows[0];

  return row === undefined
    ? null
    : {
        state: row.state,
        status: row.status,
        queueStep: toRecordedQueueStep(row.queue_step_index, row.queue_step_total),
        rule: toRecordedRuleSummary(row.rule_index),
      };
}

/** The `response.recorded` rows of a request: their payloads as stored, in id order. */
async function recordedEvents(requestId: string): Promise<(string | null)[]> {
  const result = await pool.query<{ payload: string | null }>(
    `SELECT payload FROM realtime_events
      WHERE request_id = $1 AND kind = 'response.recorded' ORDER BY id`,
    [requestId],
  );

  return result.rows.map((row) => row.payload);
}

/** The payload the previous image writes for a completion, from the row it updated (D221). */
function previousImagePayload(requestId: string, summary: ResponseSummary): string {
  return JSON.stringify({ type: 'response.recorded', data: { id: requestId, response: summary } });
}

/** Counts the wake-ups `committed` asks of `on`'s listeners while `run` runs. */
async function counting<T>(
  on: pg.Pool,
  run: (woken: { pokes: number; wakes: number }) => Promise<T>,
): Promise<T> {
  const woken = { pokes: 0, wakes: 0 };
  const observer: CommitObserver = {
    poke: () => {
      woken.pokes += 1;
    },
    wake: () => {
      woken.wakes += 1;
    },
  };

  observeCommits(on, observer);

  try {
    return await run(woken);
  } finally {
    observeCommits(on, observer, false);
  }
}

/** The statement a session's deletion deletes its requests with, and waits in for a record. */
const SESSION_DELETION_WAITS = 'DELETE FROM requests WHERE session_id = $1';
/** The statement a request's deletion deletes it with: its `DELETE` inside a `WITH`. */
const REQUEST_DELETION_WAITS = '%DELETE FROM requests%WHERE session_id = (SELECT id FROM state%';

/**
 * The backend whose statement is `like` and that `pg_blocking_pids` names
 * one of `blockers` for: a statement waiting for a lock one of them holds,
 * or waits for first.
 */
async function blockedRunning(like: string, blockers: number[]): Promise<number> {
  for (let attempt = 0; attempt < 2_500; attempt += 1) {
    const result = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE query LIKE $1 AND pg_blocking_pids(pid) && $2::int[]`,
      [like, blockers],
    );

    if (result.rows[0] !== undefined) {
      return result.rows[0].pid;
    }

    await delay(2);
  }

  throw new Error(`nothing ran ${like.slice(0, 40)} blocked`);
}

/**
 * A connection holding a request's response record `FOR UPDATE`, as a
 * transaction under way holds it, until `release`.
 */
async function holdRecord(
  requestId: string,
): Promise<{ pid: number; release: () => Promise<void> }> {
  const client = await pool.connect();

  await client.query('BEGIN');
  await client.query('SELECT 1 FROM request_responses WHERE request_id = $1 FOR UPDATE', [
    requestId,
  ]);

  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
    ?.pid as number;

  return {
    pid,
    release: async () => {
      await client.query('ROLLBACK');
      client.release();
    },
  };
}

/** The payloads of `sessionId`'s events that still carry data of a request. */
async function requestPayloadsLeft(sessionId: string): Promise<number> {
  const result = await pool.query<{ left: number }>(
    `SELECT count(*)::int AS left FROM realtime_events
      WHERE session_id = $1 AND request_id IS NOT NULL AND payload IS NOT NULL`,
    [sessionId],
  );

  return result.rows[0]?.left ?? -1;
}

describe('the completion’s event is the stored row’s summary (#260, D221)', () => {
  for (const kind of KINDS) {
    for (const outcome of OUTCOMES) {
      it(`for ${kind.name}, ${outcome}: the event the previous image would write, byte for byte, written once and woken for once`, async () => {
        const sessionId = await kind.make();
        const { requestId, answered } = await stored(sessionId);

        await counting(pool, async (woken) => {
          const summary = await recordResponseCompletion(
            pool,
            sessionId,
            requestId,
            outcome,
            answered,
          );
          const fromRow = await rowSummary(requestId);

          assert.ok(fromRow !== null);
          assert.equal(fromRow.state, outcome);
          assert.deepEqual(summary, fromRow);
          assert.deepEqual(await recordedEvents(requestId), [
            previousImagePayload(requestId, fromRow),
          ]);
          assert.deepEqual(woken, { pokes: 1, wakes: 1 });
        });
      });
    }
  }

  it('records what each kind of answer named: the rule, the queue’s step, or neither', async () => {
    const answers: RecordedAnswer[] = [];

    for (const kind of KINDS) {
      answers.push((await stored(await kind.make())).answered);
    }

    assert.deepEqual(answers, [
      { status: 200, queueStep: null, rule: null },
      { status: 201, queueStep: null, rule: null },
      { status: 503, queueStep: { index: 1, total: 2 }, rule: null },
      { status: 418, queueStep: null, rule: { index: 2 } },
    ]);
  });

  for (const kind of KINDS) {
    it(`for ${kind.name} through the receive listener: the event says what the row and the list say`, async () => {
      const sessionId = await kind.make();
      const response = await servers.receiver.inject({
        method: 'POST',
        url: `/s/${sessionId}/hook`,
        headers: { 'content-type': 'application/json' },
        payload: '{"through":"the receiver"}',
      });
      const requestId = String(response.headers['x-qa-tools-request-id']);

      await servers.writes.settled();

      const fromRow = await rowSummary(requestId);

      assert.ok(fromRow !== null);
      assert.equal(fromRow.state, 'sent');
      assert.equal(fromRow.status, response.statusCode);
      assert.deepEqual(await recordedEvents(requestId), [previousImagePayload(requestId, fromRow)]);

      const listed = await servers.api.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/requests`,
      });

      assert.equal(listed.statusCode, 200);
      assert.deepEqual(
        listed.json<RequestListItem[]>().find((item) => item.id === requestId)?.response,
        fromRow,
      );
    });
  }
});

describe('a completion that changes nothing (D109, #260)', () => {
  it('writes no event and wakes nobody for a record already ended', async () => {
    const sessionId = await session(CUSTOM);
    const { requestId, answered } = await stored(sessionId);

    await recordResponseCompletion(pool, sessionId, requestId, 'sent', answered);

    await counting(pool, async (woken) => {
      assert.equal(
        await recordResponseCompletion(pool, sessionId, requestId, 'aborted', answered),
        null,
      );
      assert.deepEqual(woken, { pokes: 0, wakes: 0 });
    });

    assert.equal((await rowSummary(requestId))?.state, 'sent');
    assert.equal((await recordedEvents(requestId)).length, 1);
  });

  it('writes no event, wakes nobody and inserts no record for a request that is gone', async () => {
    const sessionId = await session(CUSTOM);
    const { requestId, answered } = await stored(sessionId);

    assert.equal((await deleteRequest(pool, sessionId, requestId)).value, true);

    await counting(pool, async (woken) => {
      assert.equal(
        await recordResponseCompletion(pool, sessionId, requestId, 'sent', answered),
        null,
      );
      assert.deepEqual(woken, { pokes: 0, wakes: 0 });
    });

    assert.equal(await rowSummary(requestId), null, 'the record was inserted again');
    assert.deepEqual(await recordedEvents(requestId), []);
  });

  it('records one of two completions of one request made at once, announces it once and wakes once, twenty times over', async () => {
    for (let round = 0; round < 20; round += 1) {
      const sessionId = await session(null);
      const { requestId, answered } = await stored(sessionId);

      await counting(pool, async (woken) => {
        const [sent, aborted] = await Promise.all([
          recordResponseCompletion(pool, sessionId, requestId, 'sent', answered),
          recordResponseCompletion(pool, sessionId, requestId, 'aborted', answered),
        ]);
        const winner = sent ?? aborted;

        assert.equal([sent, aborted].filter((each) => each !== null).length, 1);
        assert.ok(winner !== null);
        assert.deepEqual(await rowSummary(requestId), winner);
        assert.deepEqual(await recordedEvents(requestId), [
          previousImagePayload(requestId, winner),
        ]);
        assert.deepEqual(woken, { pokes: 1, wakes: 1 });
      });
    }
  });
});

describe('a completion racing a deletion (D198, D221, #260)', () => {
  it('is purged by its session’s deletion when it took the record first: the deletion waited for it', async () => {
    const sessionId = await session(CUSTOM);
    const { requestId, answered } = await stored(sessionId);
    const holder = await holdRecord(requestId);
    const completing = recordResponseCompletion(pool, sessionId, requestId, 'sent', answered);
    const completer = await blockedRunning(RECORD_COMPLETION_SQL, [holder.pid]);
    const deleting = deleteSession(pool, sessionId);

    await blockedRunning(SESSION_DELETION_WAITS, [holder.pid, completer]);
    await holder.release();

    const [summary, deletion] = await Promise.all([completing, deleting]);

    assert.equal(summary?.state, 'sent', 'the completion did not take the record first');
    assert.equal(deletion.outcome, 'deleted');
    assert.deepEqual(await recordedEvents(requestId), [null], 'the deletion did not purge it');
    assert.equal(await requestPayloadsLeft(sessionId), 0);
  });

  it('finds no record and announces nothing when its session’s deletion took the record first', async () => {
    const sessionId = await session(CUSTOM);
    const { requestId, answered } = await stored(sessionId);
    const holder = await holdRecord(requestId);
    const deleting = deleteSession(pool, sessionId);
    const deleter = await blockedRunning(SESSION_DELETION_WAITS, [holder.pid]);

    let summary: ResponseSummary | null | undefined;

    await counting(pool, async (woken) => {
      const completing = recordResponseCompletion(pool, sessionId, requestId, 'sent', answered);

      await blockedRunning(RECORD_COMPLETION_SQL, [holder.pid, deleter]);
      await holder.release();
      [summary] = await Promise.all([completing, deleting]);
      // The deletion's own commit wakes the readers; the completion does not.
      assert.equal(woken.wakes, 1);
    });

    assert.equal(summary, null);
    assert.deepEqual(await recordedEvents(requestId), []);
    assert.equal(await requestPayloadsLeft(sessionId), 0);
  });

  it('is purged by its request’s deletion when it took the record first', async () => {
    const sessionId = await session(CUSTOM);
    const { requestId, answered } = await stored(sessionId);
    const holder = await holdRecord(requestId);
    const completing = recordResponseCompletion(pool, sessionId, requestId, 'aborted', answered);
    const completer = await blockedRunning(RECORD_COMPLETION_SQL, [holder.pid]);
    const deleting = deleteRequest(pool, sessionId, requestId);

    await blockedRunning(REQUEST_DELETION_WAITS, [holder.pid, completer]);
    await holder.release();

    const [summary, deletion] = await Promise.all([completing, deleting]);

    assert.equal(summary?.state, 'aborted');
    assert.equal(deletion.value, true);
    assert.deepEqual(await recordedEvents(requestId), [null]);
    assert.equal(await requestPayloadsLeft(sessionId), 0);
  });

  it('leaves no payload of a deleted session behind, whichever comes first, thirty times over', async () => {
    for (let round = 0; round < 30; round += 1) {
      const sessionId = await session(round % 2 === 0 ? null : CUSTOM);
      const { requestId, answered } = await stored(sessionId);
      const [summary, deletion] = await Promise.all([
        recordResponseCompletion(pool, sessionId, requestId, 'sent', answered),
        deleteSession(pool, sessionId),
      ]);

      assert.equal(deletion.outcome, 'deleted');
      assert.equal(await requestPayloadsLeft(sessionId), 0, `round ${round}`);
      assert.deepEqual(
        await recordedEvents(requestId),
        summary === null ? [] : [null],
        `round ${round}`,
      );
    }
  });
});
