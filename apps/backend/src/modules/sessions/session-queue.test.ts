/**
 * Integration tests for the response queue (D205, issue #106): the three
 * routes, a queue given at creation, what a capture takes from it, what it
 * records, the rules that start it again, and the previous image's statements
 * replayed on the new schema.
 *
 * They run against the local PostgreSQL, with real routing, real handlers and
 * real SQL, because the order of the steps is decided by the session row's
 * lock. The realtime half - `session.updated`, and the step in
 * `request.received` and `response.recorded` - is in `realtime.test.ts`.
 *
 * Start the database and apply migrations first:
 *   npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  buildInspectorUrl,
  MAX_BODY_BYTES,
  MAX_QUEUE_STEPS,
  SESSION_IDLE_DAYS,
  type RequestDetails,
  type RequestListItem,
  type ResponseConfig,
  type SessionDetails,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { DEFAULT_APP_ORIGIN, loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { defaultAnswerText } from '../../testing/default-answer.ts';
import { ordinaryFullQueue, ordinaryFullResponse } from '../../testing/full-queue.ts';
import { INVALID_RESPONSES } from '../../testing/invalid-responses.ts';
import { awaitBlockedBy, poolPausingFirstCommit } from '../../testing/locks.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import { composeWebhookResponse, NOTHING_CARRIED } from '../webhook/response.ts';
import { toResponseConfig, type ResponseConfigColumns } from './repository.ts';

const UNKNOWN_SESSION_ID = 'z'.repeat(43);
const JSON_TYPE = { 'content-type': 'application/json' };

let pool: pg.Pool;
let servers: TestServers;
/** The application listener. */
let app: FastifyInstance;
/** The receive listener, where webhooks are sent (D187). */
let receiver: FastifyInstance;
const createdSessionIds: string[] = [];

before(() => {
  pool = createPool(loadConfig().databaseUrl);
  // Dozens of sessions created within a minute, from one address (D201).
  servers = buildTestServers(pool, { rateLimits: LIMITS_OUT_OF_REACH });
  ({ api: app, receiver } = servers);
  app.log.level = 'silent';
  receiver.log.level = 'silent';
});

after(async () => {
  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers.close();
  await pool.end();
});

/** What `app.inject` resolves to; its own return type is the chainable form. */
type InjectedResponse = Awaited<ReturnType<typeof app.inject>>;

/** The session response of most tests: a custom `200` a step is told apart from. */
const CUSTOM_200: ResponseConfig = {
  status: 200,
  headers: [['x-session', 'custom']],
  body: '{"session":true}',
  delayMs: 0,
  template: false,
};

const STEP_503: ResponseConfig = {
  status: 503,
  headers: [['retry-after', '2']],
  body: '{"error":"temporarily unavailable"}',
  delayMs: 0,
  template: false,
};

const STEP_503_DELAYED: ResponseConfig = { ...STEP_503, delayMs: 2000, template: false };

/** The effective values of a step given as `{ status }` alone (D101). */
function bare(status: number): ResponseConfig {
  return { status, headers: [], body: null, delayMs: 0, template: false };
}

function createWith(payload: string): Promise<InjectedResponse> {
  return app.inject({ method: 'POST', url: '/api/sessions', headers: JSON_TYPE, payload });
}

/** Creates a session: a default one with no body, or the body given. */
async function create(body?: object): Promise<string> {
  const response =
    body === undefined
      ? await app.inject({ method: 'POST', url: '/api/sessions' })
      : await createWith(JSON.stringify(body));

  assert.equal(response.statusCode, 201, response.body);

  const { id } = response.json<{ id: string }>();
  createdSessionIds.push(id);

  return id;
}

/** Saves a queue. Steps are sent as `{"steps":[...]}`; a string is sent as it stands. */
function setQueue(
  sessionId: string,
  steps: unknown[] | string,
  server: FastifyInstance = app,
): Promise<InjectedResponse> {
  return server.inject({
    method: 'PUT',
    url: `/api/sessions/${sessionId}/queue`,
    headers: JSON_TYPE,
    payload: typeof steps === 'string' ? steps : JSON.stringify({ steps }),
  });
}

async function saveQueue(sessionId: string, steps: unknown[]): Promise<SessionResponseState> {
  const response = await setQueue(sessionId, steps);

  assert.equal(response.statusCode, 200, response.body);

  return response.json<SessionResponseState>();
}

function restartQueue(sessionId: string): Promise<InjectedResponse> {
  return app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/queue/restart` });
}

function removeQueue(sessionId: string): Promise<InjectedResponse> {
  return app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/queue` });
}

function changeResponse(sessionId: string, body: object): Promise<InjectedResponse> {
  return app.inject({
    method: 'PUT',
    url: `/api/sessions/${sessionId}/response`,
    headers: JSON_TYPE,
    payload: JSON.stringify(body),
  });
}

async function read(sessionId: string): Promise<SessionDetails> {
  const response = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });

  assert.equal(response.statusCode, 200, response.body);

  return response.json<SessionDetails>();
}

/** The queue's `next`, as the session read gives it. */
async function nextStep(sessionId: string): Promise<number | null | undefined> {
  return (await read(sessionId)).queue?.next;
}

/** Sends one webhook to the receive listener. */
function send(
  sessionId: string,
  options: { method?: string; path?: string; body?: string; server?: FastifyInstance } = {},
): Promise<InjectedResponse> {
  return (options.server ?? receiver).inject({
    method: (options.method ?? 'POST') as 'POST',
    url: `/s/${sessionId}${options.path ?? ''}`,
    ...(options.body === undefined && options.method === 'GET'
      ? {}
      : { payload: options.body ?? 'captured', headers: { 'content-type': 'text/plain' } }),
  });
}

/** The session's list, oldest first: the order the captures took the lock in. */
async function listOldestFirst(sessionId: string): Promise<RequestListItem[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/requests?order=asc`,
  });

  assert.equal(response.statusCode, 200, response.body);

  return response.json<RequestListItem[]>();
}

async function detail(sessionId: string, requestId: string): Promise<RequestDetails> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/requests/${requestId}`,
  });

  assert.equal(response.statusCode, 200, response.body);

  return response.json<RequestDetails>();
}

function requestIdOf(response: InjectedResponse): string {
  const id = response.headers['x-qa-tools-request-id'];

  assert.ok(typeof id === 'string', 'the answer carries no request id');

  return id;
}

function assertError(response: InjectedResponse, statusCode: number, errorCode: number): void {
  assert.equal(response.statusCode, statusCode, response.body);
  assert.equal(response.json<{ errorCode: number }>().errorCode, errorCode, response.body);
}

function messageOf(response: InjectedResponse): string {
  return response.json<{ message: string }>().message;
}

/** The two queue columns as stored. */
async function storedQueue(
  sessionId: string,
): Promise<{ response_queue: unknown; response_queue_answered: number | null }> {
  const result = await pool.query<{
    response_queue: unknown;
    response_queue_answered: number | null;
  }>('SELECT response_queue, response_queue_answered FROM sessions WHERE id = $1', [sessionId]);

  return result.rows[0] as { response_queue: unknown; response_queue_answered: number | null };
}

async function expiresAt(sessionId: string): Promise<Date> {
  const result = await pool.query<{ expires_at: Date }>(
    'SELECT expires_at FROM sessions WHERE id = $1',
    [sessionId],
  );

  return (result.rows[0] as { expires_at: Date }).expires_at;
}

async function setExpiry(sessionId: string, interval: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET expires_at = clock_timestamp() + $2::interval WHERE id = $1`,
    [sessionId, interval],
  );
}

/**
 * The id of the one request of a session whose response is still pending,
 * `besides` left out: a completion is written after its reply has ended, so
 * the record of a request answered just before may still be pending too
 * (D109), the more so under load (#132).
 */
async function awaitPendingRecord(sessionId: string, besides: string[] = []): Promise<string> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const result = await pool.query<{ id: string }>(
      `SELECT r.id FROM requests r JOIN request_responses rr ON rr.request_id = r.id
        WHERE r.session_id = $1 AND rr.state = 'pending' AND NOT r.id = ANY($2::uuid[])`,
      [sessionId, besides],
    );

    if (result.rows[0]) {
      return result.rows[0].id;
    }

    await delay(2);
  }

  throw new Error('no pending response record appeared');
}

describe('a capture takes the next step, then the session response (D205)', () => {
  /** A queue, then a custom session response (#106). */
  it('answers 503, 503 after its delay with the request stored first, then the custom 200', async () => {
    const id = await create({ response: CUSTOM_200 });

    await saveQueue(id, [STEP_503, STEP_503_DELAYED]);

    const first = await send(id);

    assert.equal(first.statusCode, 503);
    assert.equal(first.headers['retry-after'], '2');
    assert.equal(first.body, '{"error":"temporarily unavailable"}');
    assert.equal(first.headers['x-session'], undefined);

    const startedAt = performance.now();
    const second = send(id);
    // Stored before the delay (D105): the request is listed, its response
    // pending and naming step 2 of 2, while the sender still waits.
    const pendingId = await awaitPendingRecord(id, [requestIdOf(first)]);
    const listed = (await listOldestFirst(id)).find((row) => row.id === pendingId);

    assert.deepEqual(listed?.response, {
      state: 'pending',
      status: 503,
      queueStep: { index: 2, total: 2 },
      rule: null,
    });

    const delayed = await second;

    assert.equal(delayed.statusCode, 503);
    assert.equal(requestIdOf(delayed), pendingId);
    assert.ok(
      performance.now() - startedAt >= 1900,
      `answered after ${performance.now() - startedAt} ms`,
    );

    const third = await send(id);

    assert.equal(third.statusCode, 200);
    assert.equal(third.headers['x-session'], 'custom');
    assert.equal(third.body, '{"session":true}');

    // Used up, and still saved until it is removed.
    assert.deepEqual((await read(id)).queue, {
      steps: [STEP_503, STEP_503_DELAYED],
      next: null,
      total: 2,
    });
  });

  it('answers the default once every step has answered a default session', async () => {
    const id = await create();

    await saveQueue(id, [{ status: 503 }, { status: 503 }]);

    assert.equal((await send(id)).statusCode, 503);
    assert.equal((await send(id)).statusCode, 503);

    const third = await send(id);

    assert.equal(third.statusCode, 200);
    // The default answer of today, describing the request it answers (D223).
    assert.equal(third.body, await defaultAnswerText(app, id, requestIdOf(third)));
  });

  /** The list row and the detail name the step, or none. */
  it('records the step that answered each request, and none for the session response', async () => {
    const id = await create({ response: CUSTOM_200 });

    await saveQueue(id, [STEP_503, { status: 429 }]);

    const answers = [await send(id), await send(id), await send(id)];
    const rows = await listOldestFirst(id);

    assert.deepEqual(
      rows.map((row) => [row.response?.status, row.response?.queueStep]),
      [
        [503, { index: 1, total: 2 }],
        [429, { index: 2, total: 2 }],
        [200, null],
      ],
    );

    const details = await Promise.all(answers.map((answer) => detail(id, requestIdOf(answer))));

    assert.deepEqual(
      details.map((one) => one.response?.queueStep),
      [{ index: 1, total: 2 }, { index: 2, total: 2 }, null],
    );

    // The record holds what the step answered: its headers and body exactly.
    assert.equal(details[0]?.response?.body, '{"error":"temporarily unavailable"}');
    assert.ok(details[0]?.response?.headers.some(([name]) => name === 'retry-after'));
  });

  it('records the length of the queue that answered, which a later queue does not change', async () => {
    const id = await create();

    await saveQueue(id, [{ status: 501 }, { status: 502 }, { status: 503 }]);
    const answered = await send(id);

    await saveQueue(id, [{ status: 504 }]);
    const later = await send(id);

    assert.deepEqual((await detail(id, requestIdOf(answered))).response?.queueStep, {
      index: 1,
      total: 3,
    });
    assert.deepEqual((await detail(id, requestIdOf(later))).response?.queueStep, {
      index: 1,
      total: 1,
    });
    assert.equal(later.statusCode, 504);
  });

  it('answers any method on any path under the session with the next step', async () => {
    const id = await create();

    await saveQueue(id, [{ status: 418 }, { status: 202, body: 'second' }]);

    const get = await send(id, { method: 'GET', path: '/deep/path?x=1' });
    const propfind = await send(id, { method: 'PROPFIND', path: '/folder/', body: '<x/>' });

    assert.equal(get.statusCode, 418);
    assert.equal(propfind.statusCode, 202);
    assert.equal(propfind.body, 'second');
  });

  /**
   * The steps are taken under the session row's lock (#106, D065), so twenty
   * requests at once take steps 1 to 10 one each, in the order they took the
   * lock - which is their receipt order (D196) - and the other ten get the
   * session response.
   */
  it('gives each of 10 steps to exactly one of 20 concurrent requests, in capture order', async () => {
    const steps = Array.from({ length: MAX_QUEUE_STEPS }, (_unused, index) => ({
      status: 501 + index,
      body: `step ${index + 1}`,
    }));
    const id = await create({ response: { status: 200, body: 'session' }, queue: { steps } });

    const answers = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) => send(id, { body: `{"n":${index}}` })),
    );

    assert.deepEqual(
      answers.map((answer) => answer.statusCode).sort((left, right) => left - right),
      [
        ...Array.from({ length: 10 }, () => 200),
        ...Array.from({ length: 10 }, (_unused, index) => 501 + index),
      ],
    );

    const rows = await listOldestFirst(id);

    assert.equal(rows.length, 20);
    assert.deepEqual(
      rows.map((row) => [row.response?.status, row.response?.queueStep]),
      [
        ...Array.from({ length: 10 }, (_unused, index) => [
          501 + index,
          { index: index + 1, total: 10 },
        ]),
        ...Array.from({ length: 10 }, () => [200, null]),
      ],
    );

    // Each sender received exactly what its own row records.
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const answer of answers) {
      const row = byId.get(requestIdOf(answer));
      const index = row?.response?.queueStep?.index;

      assert.equal(row?.response?.status, answer.statusCode);
      assert.equal(answer.body, index === undefined ? 'session' : `step ${index}`);
    }

    assert.equal(await nextStep(id), null);
  });

  it('stores a step body as the session response stores the same text, a lone surrogate as U+FFFD', async () => {
    const id = await create();
    const text = 'a\ud800b';

    await saveQueue(id, [{ status: 200, body: text }]);
    assert.equal(
      (await changeResponse(id, { mode: 'custom', response: { status: 201, body: text } }))
        .statusCode,
      200,
    );

    const session = await read(id);

    assert.equal(session.queue?.steps[0]?.body, 'a�b');
    assert.equal(session.queue?.steps[0]?.body, session.customResponse?.body);
    assert.equal((await send(id)).body, 'a�b');
  });
});

describe('what starts the queue again, and what does not (criterion 3)', () => {
  const THREE = [{ status: 501 }, { status: 502 }, { status: 503 }];

  it('starts it from step 1 when it is saved, mid-run included', async () => {
    const id = await create();

    await saveQueue(id, THREE);
    await send(id);
    assert.equal(await nextStep(id), 2);

    const saved = await saveQueue(id, THREE);

    assert.equal(saved.queue?.next, 1);
    assert.equal((await send(id)).statusCode, 501);
  });

  it('starts it from step 1 when the requests are cleared, and keeps the steps', async () => {
    const id = await create();

    await saveQueue(id, THREE);
    await send(id);
    await send(id);

    const cleared = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}/requests` });

    assert.equal(cleared.statusCode, 204);
    assert.deepEqual((await read(id)).queue, {
      steps: THREE.map((step) => bare(step.status)),
      next: 1,
      total: 3,
    });
    assert.equal((await send(id)).statusCode, 501);
  });

  it('starts a used-up queue again when the requests are cleared', async () => {
    const id = await create();

    await saveQueue(id, [{ status: 503 }]);
    await send(id);
    assert.equal(await nextStep(id), null);

    await app.inject({ method: 'DELETE', url: `/api/sessions/${id}/requests` });

    assert.equal(await nextStep(id), 1);
  });

  it('leaves a session without a queue without one when the requests are cleared', async () => {
    const id = await create();

    await send(id);
    await app.inject({ method: 'DELETE', url: `/api/sessions/${id}/requests` });

    assert.deepEqual(await storedQueue(id), {
      response_queue: null,
      response_queue_answered: null,
    });
  });

  it('leaves the position where it is when only the session response changes', async () => {
    const id = await create();

    await saveQueue(id, THREE);
    await send(id);

    const changed = await changeResponse(id, { mode: 'custom', response: CUSTOM_200 });

    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json<SessionResponseState>().queue?.next, 2);
    assert.equal((await send(id)).statusCode, 502);

    assert.equal((await changeResponse(id, { mode: 'default' })).statusCode, 200);
    assert.equal(await nextStep(id), 3);
  });

  it('leaves the position where it is when one request is deleted', async () => {
    const id = await create();

    await saveQueue(id, THREE);

    const first = await send(id);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${id}/requests/${requestIdOf(first)}`,
    });

    assert.equal(deleted.statusCode, 204);
    assert.equal(await nextStep(id), 2);
    assert.equal((await send(id)).statusCode, 502);
  });

  it('starts a used-up queue from step 1 on a restart, without resending it', async () => {
    const id = await create();

    await saveQueue(id, [STEP_503, { status: 202 }]);
    await send(id);
    await send(id);
    assert.equal(await nextStep(id), null);

    const restarted = await restartQueue(id);

    assert.equal(restarted.statusCode, 200);
    assert.deepEqual(restarted.json<SessionResponseState>().queue, {
      steps: [STEP_503, bare(202)],
      next: 1,
      total: 2,
    });
    assert.equal((await send(id)).statusCode, 503);
  });

  it('starts a queue mid-run from step 1 on a restart', async () => {
    const id = await create();

    await saveQueue(id, THREE);
    await send(id);
    await send(id);

    assert.equal((await restartQueue(id)).json<SessionResponseState>().queue?.next, 1);
    assert.equal((await send(id)).statusCode, 501);
  });

  it('returns the session to its response alone when the queue is removed', async () => {
    const id = await create({ response: CUSTOM_200 });

    await saveQueue(id, THREE);
    await send(id);

    const removed = await removeQueue(id);

    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.json(), {
      response: CUSTOM_200,
      customResponse: CUSTOM_200,
      queue: null,
      rules: [],
    });
    assert.deepEqual(await storedQueue(id), {
      response_queue: null,
      response_queue_answered: null,
    });

    const answered = await send(id);

    assert.equal(answered.statusCode, 200);
    assert.equal(answered.body, '{"session":true}');
    assert.equal((await detail(id, requestIdOf(answered))).response?.queueStep, null);
  });

  it('answers a restart or a removal of a session with no queue with its state, and changes nothing of the queue', async () => {
    const id = await create({ response: CUSTOM_200 });
    const expected = { response: CUSTOM_200, customResponse: CUSTOM_200, queue: null, rules: [] };

    const restarted = await restartQueue(id);
    const removed = await removeQueue(id);

    assert.equal(restarted.statusCode, 200);
    assert.deepEqual(restarted.json(), expected);
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.json(), expected);
    assert.deepEqual(await storedQueue(id), {
      response_queue: null,
      response_queue_answered: null,
    });
  });
});

describe('a step as a template (D251)', () => {
  it('saves a step’s flag in its object, reads it back, and fills the step in for the request it answers', async () => {
    const id = await create();
    const templated: ResponseConfig = {
      ...bare(201),
      body: '{"id":"{{request.id}}","echo":"{{request.method}}"}',
      template: true,
    };
    const saved = await saveQueue(id, [templated, { status: 202, body: '{{request.id}}' }]);

    assert.deepEqual(saved.queue?.steps, [templated, { ...bare(202), body: '{{request.id}}' }]);

    const stored = (await storedQueue(id)).response_queue as Record<string, unknown>[];

    assert.deepEqual(
      stored.map((step) => step.template),
      [true, false],
    );

    const first = await send(id);
    const second = await send(id);

    assert.deepEqual(first.json(), { id: requestIdOf(first), echo: 'POST' });
    assert.equal(second.body, '{{request.id}}');
  });

  it('refuses a step whose template breaks the grammar, naming the step and quoting nothing', async () => {
    const id = await create();
    const refused = await setQueue(id, [
      { status: 200 },
      { status: 200, body: '{"a":"{{request.MARKER"}', template: true },
    ]);

    assertError(refused, 400, 1005);
    assert.ok(messageOf(refused).startsWith('steps[1].body placeholder 1 has no closing }}'));
    assert.equal(messageOf(refused).includes('MARKER'), false);
    assert.equal((await read(id)).queue, null);
  });
});

describe('PUT /api/sessions/:sessionId/queue', () => {
  it('saves the steps at their effective values and answers the whole state', async () => {
    const id = await create({ response: CUSTOM_200 });
    const response = await setQueue(id, [
      {
        status: 503,
        headers: [['retry-after', '2']],
        body: '{"e":1}',
        delayMs: 250,
        template: false,
      },
      { status: 204 },
      { status: 201, body: '', delayMs: 0, template: false },
    ]);

    const expected: SessionResponseState = {
      response: CUSTOM_200,
      customResponse: CUSTOM_200,
      queue: {
        steps: [
          {
            status: 503,
            headers: [['retry-after', '2']],
            body: '{"e":1}',
            delayMs: 250,
            template: false,
          },
          bare(204),
          // An empty body is saved as no body, as a response's is (D179).
          bare(201),
        ],
        next: 1,
        total: 3,
      },
      rules: [],
    };

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), expected);

    const session = await read(id);

    assert.deepEqual(
      {
        response: session.response,
        customResponse: session.customResponse,
        queue: session.queue,
        rules: session.rules,
      },
      expected,
    );
    // Every field present, in the order the API names them.
    assert.deepEqual(Object.keys(session.queue?.steps[0] ?? {}), [
      'status',
      'headers',
      'body',
      'delayMs',
      'template',
    ]);
  });

  it('accepts a declared JSON with parameters and in any letter case', async () => {
    const id = await create();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/queue`,
      headers: { 'content-type': 'Application/JSON; charset=utf-8' },
      payload: '{"steps":[{"status":503}]}',
    });

    assert.equal(response.statusCode, 200, response.body);
  });

  it('saves a step with Location on a 3xx and a path under /s/, and refuses one on a 200 (D247)', async () => {
    const id = await create();
    const step = {
      status: 307,
      headers: [['Location', `/s/${id}/after`]],
      body: null,
      delayMs: 0,
      template: false,
    };

    assert.deepEqual((await saveQueue(id, [step, { status: 200 }])).queue?.steps[0], step);

    const answered = await send(id);

    assert.equal(answered.statusCode, 307);
    assert.equal(answered.headers.location, `/s/${id}/after`);

    const before = await storedQueue(id);
    const refused = await setQueue(id, [{ status: 503 }, { ...step, status: 200 }]);

    assertError(refused, 400, 1005);
    assert.equal(
      messageOf(refused),
      'steps[1].headers[0] Location is allowed only when steps[1].status is from 300 to 399',
    );
    assert.deepEqual(await storedQueue(id), before);
  });

  it('refuses no steps and more than 10 with 400 / 1005', async () => {
    const id = await create();

    for (const count of [0, MAX_QUEUE_STEPS + 1, 50_000]) {
      const steps = Array.from({ length: count }, () => ({ status: 503 }));
      const response = await setQueue(id, steps);

      assertError(response, 400, 1005);
      assert.equal(messageOf(response), 'steps must contain 1 to 10 responses');
    }

    assert.equal(
      (
        await setQueue(
          id,
          Array.from({ length: 10 }, () => ({ status: 503 })),
        )
      ).statusCode,
      200,
    );
  });

  /**
   * Both routes read a body within the 1 MiB of every JSON route (D205): a
   * valid one of exactly 1 MiB is taken, one byte more is `413` / `1004`
   * before it is read, and nothing is written.
   */
  it('takes a body of exactly 1 MiB on both routes and answers one byte more 413 / 1004', async () => {
    /** `json` padded with spaces after it to `bytes` bytes, still valid JSON. */
    const padded = (json: string, bytes: number): string =>
      json + ' '.repeat(bytes - Buffer.byteLength(json));
    const id = await create();
    const queueBody = JSON.stringify({ steps: [STEP_503] });
    const createBody = JSON.stringify({ response: CUSTOM_200, queue: { steps: [STEP_503] } });

    assertError(await setQueue(id, padded(queueBody, MAX_BODY_BYTES + 1)), 413, 1004);
    assertError(await createWith(padded(createBody, MAX_BODY_BYTES + 1)), 413, 1004);
    assert.deepEqual(await storedQueue(id), {
      response_queue: null,
      response_queue_answered: null,
    });

    const saved = await setQueue(id, padded(queueBody, MAX_BODY_BYTES));
    const created = await createWith(padded(createBody, MAX_BODY_BYTES));

    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json<SessionResponseState>().queue?.steps, [STEP_503]);
    assert.equal(created.statusCode, 201, created.body);
    createdSessionIds.push(created.json<{ id: string }>().id);
  });

  it('refuses steps that are absent, null or not an array', async () => {
    const id = await create();

    for (const body of ['{}', '{"steps":null}', '{"steps":{"status":503}}', '{"steps":"503"}']) {
      const response = await setQueue(id, body);

      assertError(response, 400, 1005);
      assert.equal(
        messageOf(response),
        'steps is required and must be an array of 1 to 10 responses',
      );
    }
  });

  it('refuses a key beside steps, after the steps are checked', async () => {
    const id = await create();

    const extra = await setQueue(id, '{"steps":[{"status":503}],"next":1}');

    assertError(extra, 400, 1005);
    assert.equal(messageOf(extra), 'The request body may contain no key other than "steps"');

    // A broken step is named before the unknown key.
    assert.match(
      messageOf(await setQueue(id, '{"steps":[{"status":1}],"next":1}')),
      /^steps\[0\]\.status/,
    );
  });

  /**
   * Every step is checked by the function and the rules a response is checked
   * by (D101, D179), and a refused step is named by its position: the message
   * is the response change's own, with `steps[1]` for `response`.
   */
  for (const [description, invalid] of INVALID_RESPONSES) {
    it(`refuses a step with ${description}, naming it, and writes nothing`, async () => {
      const id = await create();

      await saveQueue(id, [{ status: 418 }]);
      await send(id);

      const before = await storedQueue(id);
      const changed = await changeResponse(id, { mode: 'custom', response: invalid });
      const queued = await setQueue(id, [{ status: 503 }, invalid, { status: 200 }]);
      const created = await createWith(
        JSON.stringify({ queue: { steps: [{ status: 503 }, invalid] } }),
      );

      assertError(changed, 400, 1005);
      assertError(queued, 400, 1005);
      assertError(created, 400, 1005);
      assert.equal(messageOf(queued), messageOf(changed).replaceAll('response', 'steps[1]'));
      assert.equal(messageOf(created), messageOf(changed).replaceAll('response', 'queue.steps[1]'));
      assert.deepEqual(await storedQueue(id), before, `${description}: the queue was written`);
    });
  }

  it('refuses a step that is null with its own message', async () => {
    const id = await create();
    const response = await setQueue(id, [{ status: 503 }, null]);

    assertError(response, 400, 1005);
    assert.equal(messageOf(response), 'steps[1] must be an object');
  });

  it('answers 1006 for a body that is absent, empty, unparseable or not an object', async () => {
    const id = await create();

    for (const payload of ['', 'not json', '[]', '"steps"', 'null', '{"steps":[}']) {
      assertError(await setQueue(id, payload), 400, 1006);
    }

    const noBody = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/queue`,
      headers: JSON_TYPE,
    });

    assertError(noBody, 400, 1006);
  });

  it('answers 415 for anything but one declared application/json, a missing one included', async () => {
    const id = await create();

    for (const headers of [
      {},
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded' },
    ]) {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/sessions/${id}/queue`,
        headers,
        payload: '{"steps":[{"status":503}]}',
      });

      assertError(response, 415, 1007);
    }
  });

  /**
   * The 1 MiB admits a full queue of ordinary text (D205): ten steps at every
   * limit of D101 - a body of 65,536 bytes of letters, Cyrillic among them,
   * digits and punctuation, and a header block of 8 KiB in 20 pairs - and a
   * creation carrying a response beside them (`testing/full-queue.ts`).
   */
  it('admits ten steps of ordinary text at every limit, and a creation with a response too', async () => {
    const steps = ordinaryFullQueue();
    const queueBody = JSON.stringify({ steps });
    const createBody = JSON.stringify({ response: ordinaryFullResponse(), queue: { steps } });

    assert.ok(Buffer.byteLength(createBody) < MAX_BODY_BYTES, `${createBody.length} characters`);

    const id = await create();
    const saved = await setQueue(id, queueBody);

    assert.equal(saved.statusCode, 200, saved.body.slice(0, 300));
    assert.deepEqual(saved.json<SessionResponseState>().queue?.steps, steps);

    const created = await createWith(createBody);

    assert.equal(created.statusCode, 201, created.body.slice(0, 300));

    const createdId = created.json<{ id: string }>().id;

    createdSessionIds.push(createdId);

    const read = await app.inject({ method: 'GET', url: `/api/sessions/${createdId}` });

    assert.deepEqual(read.json<SessionDetails>().queue?.steps, steps);
  });

  it('checks the body before it looks for the session', async () => {
    assertError(await setQueue(UNKNOWN_SESSION_ID, []), 400, 1005);
    assertError(await setQueue(UNKNOWN_SESSION_ID, 'not json'), 400, 1006);
  });

  it('answers 404 / 1001 for an unknown session and for an id that cannot be one', async () => {
    assertError(await setQueue(UNKNOWN_SESSION_ID, [{ status: 503 }]), 404, 1001);
    assertError(await setQueue('not-a-session', [{ status: 503 }]), 404, 1001);
  });

  it('answers 410 / 1002 for an expired session, and neither writes nor revives it', async () => {
    const id = await create();

    await setExpiry(id, '-1 minute');

    const expiry = await expiresAt(id);
    const response = await setQueue(id, [{ status: 503 }]);

    assert.deepEqual(response.json(), { errorCode: 1002, message: 'Session expired' });
    assert.equal(response.statusCode, 410);
    assert.deepEqual(await storedQueue(id), {
      response_queue: null,
      response_queue_answered: null,
    });
    assert.equal((await expiresAt(id)).getTime(), expiry.getTime());
  });
});

describe('DELETE /api/sessions/:sessionId/queue and POST .../queue/restart — the session', () => {
  for (const [name, call] of [
    ['removal', removeQueue],
    ['restart', restartQueue],
  ] as const) {
    it(`answers a ${name} of an unknown session or a malformed id 404 / 1001`, async () => {
      assertError(await call(UNKNOWN_SESSION_ID), 404, 1001);
      assertError(await call('not-a-session'), 404, 1001);
    });

    it(`answers a ${name} of an expired session 410 / 1002, and writes nothing`, async () => {
      const id = await create({ queue: { steps: [{ status: 503 }] } });

      await send(id);
      await setExpiry(id, '-1 minute');

      const before = await storedQueue(id);

      assertError(await call(id), 410, 1002);
      assert.deepEqual(await storedQueue(id), before);
    });
  }

  it('answers a body sent anyway by the rules of the other bodiless routes (D104)', async () => {
    const id = await create();

    assertError(
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${id}/queue/restart`,
        headers: JSON_TYPE,
        payload: '{',
      }),
      400,
      1006,
    );
    assertError(
      await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${id}/queue`,
        headers: { 'content-type': 'application/xml' },
        payload: '<x/>',
      }),
      415,
      1007,
    );
  });
});

describe('POST /api/sessions with a queue (D205)', () => {
  it('creates the session with its queue at step 1, and its first request takes it', async () => {
    const id = await create({
      response: CUSTOM_200,
      queue: { steps: [STEP_503, { status: 504 }] },
    });

    assert.deepEqual((await read(id)).queue, {
      steps: [STEP_503, bare(504)],
      next: 1,
      total: 2,
    });
    assert.equal((await send(id)).statusCode, 503);
    assert.equal((await send(id)).statusCode, 504);
    assert.equal((await send(id)).statusCode, 200);
  });

  it('takes a step with Location on a 3xx and a path under /s/, and answers with it (D247)', async () => {
    const id = await create({
      queue: { steps: [{ status: 302, headers: [['location', '/s/x/after']] }] },
    });

    assert.deepEqual((await read(id)).queue?.steps, [
      {
        status: 302,
        headers: [['location', '/s/x/after']],
        body: null,
        delayMs: 0,
        template: false,
      },
    ]);

    const answered = await send(id);

    assert.equal(answered.statusCode, 302);
    assert.equal(answered.headers.location, '/s/x/after');
  });

  it('creates a default session with a queue', async () => {
    const id = await create({ queue: { steps: [{ status: 503 }] } });
    const session = await read(id);

    assert.equal(session.response, null);
    assert.equal(session.queue?.next, 1);
    assert.equal((await send(id)).statusCode, 503);
  });

  it('refuses a queue that is null, not an object, empty, too long, without steps or with another key', async () => {
    for (const [queue, message] of [
      [null, 'queue must be an object; omit the key entirely to create a session without a queue'],
      ['steps', 'queue must be an object'],
      [[{ status: 503 }], 'queue must be an object'],
      [{}, 'queue.steps is required and must be an array of 1 to 10 responses'],
      [{ steps: [] }, 'queue.steps must contain 1 to 10 responses'],
      [
        { steps: Array.from({ length: 11 }, () => ({ status: 503 })) },
        'queue.steps must contain 1 to 10 responses',
      ],
      [{ steps: [{ status: 503 }], next: 1 }, 'queue may contain no key other than "steps"'],
    ] as const) {
      const response = await createWith(JSON.stringify({ queue }));

      assertError(response, 400, 1005);
      assert.equal(messageOf(response), message);
    }
  });

  it('names the response before the queue, and an unknown key after both', async () => {
    const both = await createWith(
      JSON.stringify({ response: { status: 1 }, queue: { steps: [{ status: 1 }] } }),
    );

    assert.match(messageOf(both), /^response\.status/);

    const unknown = await createWith(
      JSON.stringify({ queue: { steps: [{ status: 503 }] }, other: true }),
    );

    assertError(unknown, 400, 1005);
    assert.equal(
      messageOf(unknown),
      'The request body may contain no key other than "response", "queue", "expiresInSeconds", "expiresAfterIdleSeconds", "storeSourceIp", "rules" and "private"',
    );
  });
});

describe('a queue call is a use of the session (D133)', () => {
  for (const [name, call] of [
    ['saving', (id: string) => setQueue(id, [{ status: 503 }])],
    ['restarting', restartQueue],
    ['removing', removeQueue],
  ] as const) {
    it(`moves the expiry a full window ahead when ${name} the queue`, async () => {
      const id = await create();

      await setExpiry(id, '2 days');
      assert.equal((await call(id)).statusCode, 200);

      const daysAhead = ((await expiresAt(id)).getTime() - Date.now()) / 86_400_000;

      assert.ok(
        Math.abs(daysAhead - SESSION_IDLE_DAYS) < 0.01,
        `expected about ${SESSION_IDLE_DAYS} days, got ${daysAhead}`,
      );
    });
  }
});

/**
 * Saving a queue takes the session row's lock every capture takes (D065), so
 * a capture holding it is answered wholly by what the session held before,
 * and the queue saved after it starts from step 1 for the next request.
 *
 * The second call of each test goes to this file's own listeners, whose hub
 * is not the gated pair's: sent to the same pair it would wait in the
 * session's line (`RealtimeHub.inOrder`, D205) before reaching the database,
 * as `realtime.test.ts` shows. The lock is what is under test here - what
 * orders calls that share no line.
 */
describe('a queue change and a capture serialise on the session row', () => {
  it('makes a save that arrives during a capture wait, and starts the new queue after it', async () => {
    const id = await create({ response: CUSTOM_200, queue: { steps: [{ status: 501 }] } });
    const gated = poolPausingFirstCommit(pool);
    const gatedServers = buildTestServers(gated.pool);
    gatedServers.api.log.level = 'silent';
    gatedServers.receiver.log.level = 'silent';

    try {
      const capturing = send(id, { server: gatedServers.receiver });
      const holderPid = await gated.holder;

      let settled = false;
      const saving = setQueue(id, [{ status: 502 }]).then((response) => {
        settled = true;

        return response;
      });

      await awaitBlockedBy(pool, holderPid);
      assert.equal(settled, false, 'the save completed while a capture held the session');
      gated.release();

      assert.equal((await capturing).statusCode, 501);
      assert.equal((await saving).json<SessionResponseState>().queue?.next, 1);
      assert.equal((await send(id)).statusCode, 502);
      assert.equal((await send(id)).statusCode, 200);
    } finally {
      gated.release();
      await gatedServers.close();
    }
  });

  /**
   * A clear locks the session row before it deletes anything, queue or not
   * (`FOR NO KEY UPDATE`, which a capture's `FOR UPDATE` holds off), so its
   * `DELETE` cannot hold rows a capture evicting its oldest request needs
   * while it waits for that capture's row lock (D065, D205). Since #132 the
   * lock is a statement of its own and the `DELETE` a later one, which reads
   * the session's requests as they are once the lock is held: a capture that
   * held the lock first - on this process or another - is deleted with the
   * rest, and its `request.received` comes before the clear's
   * `requests.cleared` (D221). Before #132 a capture on another pair of
   * listeners survived the clear, its commit after the clear's snapshot.
   */
  for (const withQueue of [false, true]) {
    it(`makes a clear wait for a capture holding the session before it deletes a request, ${withQueue ? 'with' : 'without'} a queue`, async () => {
      const id = await create(
        withQueue
          ? {
              response: CUSTOM_200,
              queue: { steps: [{ status: 501 }, { status: 502 }, { status: 503 }] },
            }
          : { response: CUSTOM_200 },
      );

      await send(id);
      await send(id);

      const gated = poolPausingFirstCommit(pool);
      const gatedServers = buildTestServers(gated.pool);
      gatedServers.api.log.level = 'silent';
      gatedServers.receiver.log.level = 'silent';

      try {
        const capturing = send(id, { server: gatedServers.receiver });
        const holderPid = await gated.holder;
        const clearing = app.inject({ method: 'DELETE', url: `/api/sessions/${id}/requests` });
        const first = await Promise.race([
          awaitBlockedBy(pool, holderPid).then(
            () => 'waiting',
            () => 'never waited',
          ),
          clearing.then(() => 'cleared'),
        ]);

        assert.equal(
          first,
          'waiting',
          'the clear did not wait for the capture holding the session',
        );

        // No request row is locked yet: the clear has deleted nothing.
        const client = await pool.connect();

        try {
          await client.query('BEGIN');
          const rows = await client.query(
            'SELECT id FROM requests WHERE session_id = $1 FOR UPDATE NOWAIT',
            [id],
          );

          assert.equal(rows.rowCount, 2);
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }

        gated.release();

        const captured = await capturing;

        // The third step, which the clear then starts again from step 1.
        assert.equal(captured.statusCode, withQueue ? 503 : 200);
        assert.equal((await clearing).statusCode, 204);
        // The capture that held the lock first is deleted with the rest, as
        // on one pair of listeners, whose line orders them (D205, D221).
        assert.deepEqual(await listOldestFirst(id), []);
        assert.equal(await nextStep(id), withQueue ? 1 : undefined);
      } finally {
        gated.release();
        await gatedServers.close();
      }
    });
  }
});

/**
 * Rollback safety for #106 (D205, as D151 did for its flag). The previous image,
 * 0.45.2 (`e453f2c`), keeps running on this schema after a `helm rollback`,
 * which never undoes a migration (D055). These are its statements about a
 * session's response and a capture's record, copied from
 * `apps/backend/src/modules/sessions/repository.ts` and
 * `apps/backend/src/modules/webhook/repository.ts` as they stood there, with
 * `RESPONSE_COLUMNS` written out: the session insert, the capture's locked
 * read its reply is composed from, the capture's two inserts and its clear.
 * It names its columns in each, so it reads no queue and writes none, and
 * answers every request with the session response.
 */
const PREVIOUS_IMAGE_SESSION_INSERT = `INSERT INTO sessions
       (id, expires_at, response_status, response_headers, response_body, response_delay_ms)
     VALUES ($1, now() + make_interval(days => $2), $3, $4::jsonb, $5, $6)
     RETURNING id, expires_at`;

const PREVIOUS_IMAGE_CAPTURE_READ = `SELECT id, response_status,
            COALESCE(response_headers, '[]'::jsonb) AS response_headers,
            response_body,
            COALESCE(response_delay_ms, 0) AS response_delay_ms,
            COALESCE(response_custom_disabled, false) AS response_custom_disabled
       FROM sessions WHERE id = $1 FOR UPDATE`;

const PREVIOUS_IMAGE_REQUEST_INSERT = `INSERT INTO requests
         (session_id, method, path, http_version, query_string, headers, body, body_size,
          raw_request, source_ip, received_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, clock_timestamp())
       RETURNING id, received_at`;

const PREVIOUS_IMAGE_RECORD_INSERT = `INSERT INTO request_responses
         (request_id, state, status, headers, body, body_size, body_suppressed, raw_response,
          delay_ms, started_at)
       VALUES ($1, 'pending', $2, $3::jsonb, $4, $5, $6, $7, $8, clock_timestamp())`;

const PREVIOUS_IMAGE_CLEAR = `WITH state AS (
       SELECT id, expires_at <= clock_timestamp() AS expired FROM sessions WHERE id = $1
     ), removed AS (
       DELETE FROM requests
       WHERE session_id = (SELECT id FROM state WHERE NOT expired)
       RETURNING id
     )
     SELECT (SELECT expired FROM state) AS expired`;

/**
 * One capture as the previous image makes it, in its transaction: the locked
 * read, the reply composed by its rule from what that read returns, and both
 * inserts. Answers the response it composed and the request's id.
 */
async function captureAsPreviousImage(
  sessionId: string,
): Promise<{ status: number; body: string | null; requestId: string }> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const locked = await client.query<{ id: string } & ResponseConfigColumns>(
      PREVIOUS_IMAGE_CAPTURE_READ,
      [sessionId],
    );
    const session = locked.rows[0];

    assert.ok(session);

    const response = toResponseConfig(session);
    const body = Buffer.from('captured by the previous image');
    const inserted = await client.query<{ id: string; received_at: Date }>(
      PREVIOUS_IMAGE_REQUEST_INSERT,
      [
        sessionId,
        'POST',
        `/s/${sessionId}`,
        '1.1',
        '',
        JSON.stringify([['content-type', 'text/plain']]),
        body,
        body.byteLength,
        body,
        '203.0.113.7',
      ],
    );
    const row = inserted.rows[0];

    assert.ok(row);

    const requestId = row.id;
    // Composed by this image's rule: the previous image's differs only in a
    // default session's body, without D223's seven keys, which no test here
    // reads.
    const composed = composeWebhookResponse(
      response,
      {
        requestId,
        inspectorUrl: buildInspectorUrl(DEFAULT_APP_ORIGIN, sessionId, requestId),
        receivedAt: row.received_at.toISOString(),
        method: 'POST',
        path: `/s/${sessionId}`,
        bodySize: body.byteLength,
        sourceIp: '203.0.113.7',
      },
      NOTHING_CARRIED,
    );

    await client.query(PREVIOUS_IMAGE_RECORD_INSERT, [
      requestId,
      composed.status,
      JSON.stringify(composed.headers),
      composed.body,
      composed.body?.byteLength ?? 0,
      composed.bodySuppressed,
      composed.raw,
      response?.delayMs ?? 0,
    ]);
    await client.query('COMMIT');

    return {
      status: composed.status,
      body: composed.body === null ? null : composed.body.toString('utf8'),
      requestId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('the previous image on the new schema (criterion 7, D205)', () => {
  it('answers a session with a queue with the session response, and moves nothing', async () => {
    const id = await create({ response: CUSTOM_200, queue: { steps: [STEP_503, STEP_503] } });

    const answered = await captureAsPreviousImage(id);

    assert.equal(answered.status, 200);
    assert.equal(answered.body, '{"session":true}');
    // The queue is ignored, not lost: where the new image left it.
    assert.equal(await nextStep(id), 1);

    // Its record reads, under this image, as answered by the session response.
    const recorded = await detail(id, answered.requestId);

    assert.equal(recorded.response?.status, 200);
    assert.equal(recorded.response?.queueStep, null);
    assert.equal((await listOldestFirst(id))[0]?.response?.queueStep, null);

    // This image again: the queue starts where it was.
    assert.equal((await send(id)).statusCode, 503);
  });

  it('answers a used-up or mid-run queue with the session response too', async () => {
    const id = await create({ queue: { steps: [STEP_503, { status: 502 }] } });

    await send(id);

    const answered = await captureAsPreviousImage(id);

    assert.equal(answered.status, 200);
    assert.equal(await nextStep(id), 2);
  });

  it('creates sessions this image reads as having no queue', async () => {
    const id = randomBytes(32).toString('base64url');

    await pool.query(PREVIOUS_IMAGE_SESSION_INSERT, [
      id,
      SESSION_IDLE_DAYS,
      CUSTOM_200.status,
      JSON.stringify(CUSTOM_200.headers),
      CUSTOM_200.body,
      CUSTOM_200.delayMs,
    ]);
    createdSessionIds.push(id);

    assert.equal((await read(id)).queue, null);

    const answered = await send(id);

    assert.equal(answered.statusCode, 200);
    assert.equal((await detail(id, requestIdOf(answered))).response?.queueStep, null);
    // And a queue this image saves on it works as on any session.
    await saveQueue(id, [{ status: 503 }]);
    assert.equal((await send(id)).statusCode, 503);
  });

  /**
   * The accepted cost (D205): the previous image's clear knows nothing of the
   * queue, so a clear made while it runs does not start the queue again. This
   * test pins that documented behaviour.
   */
  it('clears the requests without starting the queue again', async () => {
    const id = await create({ queue: { steps: [STEP_503, { status: 502 }] } });

    await send(id);
    await pool.query(PREVIOUS_IMAGE_CLEAR, [id]);

    assert.equal(await nextStep(id), 2);
  });
});
