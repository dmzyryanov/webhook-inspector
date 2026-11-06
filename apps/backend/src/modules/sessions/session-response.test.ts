/**
 * Integration tests for changing a running session's response (D150-D153).
 *
 * They run against the local PostgreSQL, with real routing, real handlers and
 * real SQL: what is being tested is as much the locking and the schema as the
 * route. The realtime half of the change - `session.updated` - is tested with
 * the other events, in `realtime.test.ts`.
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
  RESERVED_RESPONSE_HEADERS,
  SESSION_IDLE_DAYS,
  type ResponseConfig,
  type SessionDetails,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { defaultAnswerText } from '../../testing/default-answer.ts';
import { INVALID_RESPONSES } from '../../testing/invalid-responses.ts';
import { awaitBlockedBy, poolPausingFirstCommit } from '../../testing/locks.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import { REFRESH_SESSION_EXPIRY_SQL, resetRefreshWarningThrottle } from './repository.ts';
import { changeSessionResponse } from './service.ts';

const UNKNOWN_SESSION_ID = 'z'.repeat(43);

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

const CUSTOM: ResponseConfig = {
  status: 201,
  headers: [['x-trace-id', 'abc']],
  body: '{"received":true}',
  delayMs: 0,
  template: false,
};

async function createDefault(server: FastifyInstance = app): Promise<string> {
  const response = await server.inject({ method: 'POST', url: '/api/sessions' });

  assert.equal(response.statusCode, 201);

  const { id } = response.json<{ id: string }>();
  createdSessionIds.push(id);

  return id;
}

async function createCustom(configuration: object = CUSTOM): Promise<string> {
  const response = await createWith(JSON.stringify({ response: configuration }));

  assert.equal(response.statusCode, 201, response.body);

  const { id } = response.json<{ id: string }>();
  createdSessionIds.push(id);

  return id;
}

function createWith(payload: string): Promise<InjectedResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { 'content-type': 'application/json' },
    payload,
  });
}

/** Sends a change. A string is sent as it stands; anything else as its JSON. */
function change(
  sessionId: string,
  body: unknown,
  server: FastifyInstance = app,
): Promise<InjectedResponse> {
  return server.inject({
    method: 'PUT',
    url: `/api/sessions/${sessionId}/response`,
    headers: { 'content-type': 'application/json' },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function read(sessionId: string): Promise<SessionDetails> {
  const response = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });

  assert.equal(response.statusCode, 200);

  return response.json<SessionDetails>();
}

interface StoredColumns {
  response_status: number | null;
  response_headers: [string, string][] | null;
  response_body: string | null;
  response_delay_ms: number | null;
  response_custom_disabled: boolean;
}

async function stored(sessionId: string): Promise<StoredColumns> {
  const result = await pool.query<StoredColumns>(
    `SELECT response_status, response_headers, response_body, response_delay_ms,
            response_custom_disabled
       FROM sessions WHERE id = $1`,
    [sessionId],
  );

  return result.rows[0] as StoredColumns;
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

function webhook(sessionId: string, server: FastifyInstance = receiver): Promise<InjectedResponse> {
  return server.inject({ method: 'POST', url: `/s/${sessionId}`, payload: 'captured' });
}

/** The status the backend recorded for one captured request (D109). */
async function recordedStatus(requestId: string): Promise<{ state: string; status: number }> {
  const result = await pool.query<{ state: string; status: number }>(
    'SELECT state, status FROM request_responses WHERE request_id = $1',
    [requestId],
  );

  return result.rows[0] as { state: string; status: number };
}

function assertError(response: InjectedResponse, statusCode: number, errorCode: number): void {
  assert.equal(response.statusCode, statusCode, response.body);
  assert.equal(response.json<{ errorCode: number }>().errorCode, errorCode, response.body);
}

describe('PUT /api/sessions/:sessionId/response — changing the response', () => {
  it('replaces a custom response and answers with the new state', async () => {
    const id = await createCustom();
    const next: ResponseConfig = {
      status: 500,
      headers: [
        ['retry-after', '30'],
        ['X-Trace-Id', 'def'],
      ],
      body: '{"error":"boom"}',
      delayMs: 250,
      template: false,
    };

    const response = await change(id, { mode: 'custom', response: next });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      response: next,
      customResponse: next,
      queue: null,
      rules: [],
    });

    const details = await read(id);

    assert.deepEqual(details.response, next);
    assert.deepEqual(details.customResponse, next);
  });

  it('stores the effective defaults for a status-only change, replacing headers and body', async () => {
    const id = await createCustom({ ...CUSTOM, delayMs: 500 });

    const response = await change(id, { mode: 'custom', response: { status: 200 } });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(await stored(id), {
      response_status: 200,
      response_headers: [],
      response_body: null,
      response_delay_ms: 0,
      response_custom_disabled: false,
    });
  });

  it('turns a default session custom', async () => {
    const id = await createDefault();

    const response = await change(id, { mode: 'custom', response: { status: 503 } });
    const expected: ResponseConfig = {
      status: 503,
      headers: [],
      body: null,
      delayMs: 0,
      template: false,
    };

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      response: expected,
      customResponse: expected,
      queue: null,
      rules: [],
    });
  });

  /** Picking Default keeps the custom response (D151). */
  it('keeps every custom field when the default is picked, and restores them', async () => {
    const configuration: ResponseConfig = { ...CUSTOM, delayMs: 500 };
    const id = await createCustom(configuration);

    const toDefault = await change(id, { mode: 'default' });

    assert.equal(toDefault.statusCode, 200);
    assert.deepEqual(toDefault.json(), {
      response: null,
      customResponse: configuration,
      queue: null,
      rules: [],
    });
    assert.deepEqual(await stored(id), {
      response_status: 201,
      response_headers: [['x-trace-id', 'abc']],
      response_body: '{"received":true}',
      response_delay_ms: 500,
      response_custom_disabled: true,
    });

    const details = await read(id);

    assert.equal(details.response, null);
    assert.deepEqual(details.customResponse, configuration);

    // What the quick switch sends to switch back: the kept response itself.
    const back = await change(id, { mode: 'custom', response: details.customResponse });

    assert.equal(back.statusCode, 200);
    assert.deepEqual(back.json(), {
      response: configuration,
      customResponse: configuration,
      queue: null,
      rules: [],
    });
    assert.equal((await stored(id)).response_custom_disabled, false);
  });

  it('answers a default change on a session that never had a custom response', async () => {
    const id = await createDefault();

    const response = await change(id, { mode: 'default' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      response: null,
      customResponse: null,
      queue: null,
      rules: [],
    });
    assert.equal((await stored(id)).response_status, null);
  });
});

/**
 * Validation parity with creation (D101, D150): the same `response` validator
 * runs on both routes, so every configuration creation refuses is refused by a
 * change with the same `1005` and the same message, and nothing is written.
 */
describe('PUT /api/sessions/:sessionId/response — the same rules as creation (1005)', () => {
  for (const [description, invalid] of INVALID_RESPONSES) {
    it(`answers 400 / 1005 with creation's own message for ${description}`, async () => {
      const id = await createCustom();
      const before = await stored(id);

      const created = await createWith(JSON.stringify({ response: invalid }));
      const changed = await change(id, { mode: 'custom', response: invalid });

      assertError(created, 400, 1005);
      assertError(changed, 400, 1005);
      assert.equal(
        changed.json<{ message: string }>().message,
        created.json<{ message: string }>().message,
      );
      assert.deepEqual(await stored(id), before, `${description}: the session was written`);
    });
  }

  it('refuses every reserved header name, whatever its case, with a 3xx as with 200', async () => {
    const id = await createCustom();

    for (const status of [200, 302]) {
      for (const name of [...RESERVED_RESPONSE_HEADERS, 'X-QA-Tools-Anything']) {
        for (const spelling of [name, name.toUpperCase()]) {
          const response = await change(id, {
            mode: 'custom',
            response: { status, headers: [[spelling, '/s/x']] },
          });

          assertError(response, 400, 1005);
        }
      }
    }

    assert.equal((await stored(id)).response_status, 201);
  });

  it('accepts Location on a 3xx with a path under /s/, and answers with it (D247)', async () => {
    const id = await createCustom();
    const next: ResponseConfig = {
      status: 307,
      headers: [['Location', `/s/${id}/after`]],
      body: null,
      delayMs: 0,
      template: false,
    };

    const response = await change(id, { mode: 'custom', response: next });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual((await read(id)).response, next);

    const answered = await webhook(id);

    assert.equal(answered.statusCode, 307);
    assert.equal(answered.headers.location, `/s/${id}/after`);

    // Back to a 200 with the row still there: refused, the 307 kept.
    const refused = await change(id, {
      mode: 'custom',
      response: { ...next, status: 200 },
    });

    assertError(refused, 400, 1005);
    assert.equal(
      refused.json<{ message: string }>().message,
      'response.headers[0] Location is allowed only when response.status is from 300 to 399',
    );
    assert.deepEqual((await read(id)).response, next);
  });

  it('names the field that broke a rule without echoing its value (D106)', async () => {
    const id = await createCustom();
    const secret = 'v'.repeat(1025);

    const response = await change(id, {
      mode: 'custom',
      response: { status: 200, headers: [['x-trace', secret]] },
    });
    const { message } = response.json<{ message: string }>();

    assert.ok(message.includes('response.headers'), `unhelpful message: ${message}`);
    assert.equal(message.includes(secret), false, 'the rejected value was echoed back');
  });

  it('accepts any body and a configured Content-Type, as creation does (D179)', async () => {
    for (const body of ['{"a":', "{'a':1}", 'OK', ' ', '{"a":"\\u0000"}']) {
      const accepted = { status: 200, headers: [['Content-Type', 'text/plain']], body };
      const viaCreate = await createCustom(accepted);
      const viaChange = await createCustom();

      const response = await change(viaChange, { mode: 'custom', response: accepted });

      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(await stored(viaChange), await stored(viaCreate));
      assert.equal((await read(viaChange)).response?.body, body);
      assert.deepEqual((await read(viaChange)).response?.headers, [['Content-Type', 'text/plain']]);
    }
  });

  it('saves an empty body as no body, 204 included (D179)', async () => {
    for (const status of [200, 204]) {
      const id = await createCustom();

      const response = await change(id, { mode: 'custom', response: { status, body: '' } });

      assert.equal(response.statusCode, 200, response.body);
      assert.equal((await stored(id)).response_body, null);
      assert.equal((await read(id)).response?.body, null);
    }
  });

  it('accepts exactly what creation accepts, and stores it the same way', async () => {
    const accepted = {
      status: 299,
      headers: [
        ['x-a', '1'],
        ['X-A', '2'],
        ['x-empty', ''],
        ...Array.from({ length: 17 }, () => ['x-pad-01', 'v'.repeat(397)]),
      ],
      body: JSON.stringify('a'.repeat(65534)),
      delayMs: 30000,
    };
    const viaCreate = await createCustom(accepted);
    const viaChange = await createDefault();

    const response = await change(viaChange, { mode: 'custom', response: accepted });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(await stored(viaChange), await stored(viaCreate));
  });
});

describe('PUT /api/sessions/:sessionId/response — what the change itself must say (1005)', () => {
  const cases: [string, string][] = [
    ['no mode', '{}'],
    ['a mode spelled differently', '{"mode":"Custom","response":{"status":200}}'],
    ['a null mode', '{"mode":null}'],
    ['a mode that is not a string', '{"mode":1}'],
    ['custom with no response', '{"mode":"custom"}'],
    ['custom with a null response', '{"mode":"custom","response":null}'],
    ['default with a response', '{"mode":"default","response":{"status":200}}'],
    ['default with a null response', '{"mode":"default","response":null}'],
    ['an unknown key beside a default change', '{"mode":"default","status":200}'],
    ['an unknown key beside a custom change', '{"mode":"custom","response":{"status":200},"x":1}'],
  ];

  for (const [description, payload] of cases) {
    it(`answers 400 / 1005 for ${description}`, async () => {
      const id = await createCustom();
      const before = await stored(id);

      assertError(await change(id, payload), 400, 1005);
      assert.deepEqual(await stored(id), before);
    });
  }

  it('says what a default change keeps when it is sent a response', async () => {
    const id = await createCustom();
    const response = await change(id, '{"mode":"default","response":{"status":200}}');

    assert.deepEqual(response.json(), {
      errorCode: 1005,
      message: 'response must be absent when mode is "default"; the saved custom response is kept',
      field: 'response',
    });
  });
});

describe('PUT /api/sessions/:sessionId/response — body, media type and size', () => {
  for (const [description, payload] of [
    ['an empty body', ''],
    ['an unparseable body', '{"mode":'],
    ['an array', '[]'],
    ['a string', '"abc"'],
    ['a null', 'null'],
    ['a number', '123'],
  ]) {
    it(`answers 400 / 1006 for ${description}`, async () => {
      const id = await createCustom();

      assertError(await change(id, payload as string), 400, 1006);
    });
  }

  it('answers 400 / 1006 for a declared-JSON change with no body at all', async () => {
    const id = await createCustom();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/response`,
      headers: { 'content-type': 'application/json' },
    });

    assertError(response, 400, 1006);
  });

  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'json']) {
    it(`answers 415 / 1007 for a body declared ${contentType}`, async () => {
      const id = await createCustom();
      const response = await app.inject({
        method: 'PUT',
        url: `/api/sessions/${id}/response`,
        headers: { 'content-type': contentType },
        payload: '{"mode":"default"}',
      });

      assertError(response, 415, 1007);
      assert.equal((await stored(id)).response_custom_disabled, false);
    });
  }

  it('answers 415 / 1007 to a change with no body and no content-type', async () => {
    // Creation's one exemption does not exist here: a change has no bodyless
    // form, so there is nothing for such a request to mean.
    const id = await createCustom();
    const response = await app.inject({ method: 'PUT', url: `/api/sessions/${id}/response` });

    assertError(response, 415, 1007);
  });

  it('accepts the media type with parameters and in any case', async () => {
    const id = await createCustom();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/response`,
      headers: { 'content-type': 'Application/JSON; charset=utf-8' },
      payload: '{"mode":"default"}',
    });

    assert.equal(response.statusCode, 200);
  });

  it('answers 413 / 1004 for a declared-JSON body over the 1 MiB limit', async () => {
    const id = await createCustom();
    const response = await change(id, JSON.stringify({ padding: 'a'.repeat(1024 * 1024) }));

    assertError(response, 413, 1004);
  });
});

describe('PUT /api/sessions/:sessionId/response — the session', () => {
  it('checks the body before it looks for the session', async () => {
    assertError(await change(UNKNOWN_SESSION_ID, { mode: 'custom' }), 400, 1005);
  });

  it('answers 404 / 1001 for an unknown session', async () => {
    assertError(await change(UNKNOWN_SESSION_ID, { mode: 'default' }), 404, 1001);
  });

  it('answers a malformed id exactly like an unknown session (D058)', async () => {
    assertError(await change('not-a-session', { mode: 'default' }), 404, 1001);
  });

  it('answers 410 / 1002 for an expired session, and neither writes nor revives it', async () => {
    const id = await createCustom();
    await setExpiry(id, '-1 minute');
    const before = await stored(id);
    const expiry = await expiresAt(id);

    const response = await change(id, { mode: 'custom', response: { status: 500 } });

    assert.deepEqual(response.json(), { errorCode: 1002, message: 'Session expired' });
    assert.equal(response.statusCode, 410);
    assert.deepEqual(await stored(id), before);
    assert.equal((await expiresAt(id)).getTime(), expiry.getTime());
  });
});

/** The receiver answers by the mode, not by the presence of a status (D151). */
describe('capture after a change', () => {
  it('answers the default while the custom response is kept, and the custom one after it is restored', async () => {
    const id = await createCustom();

    const custom = await webhook(id);

    assert.equal(custom.statusCode, 201);
    assert.equal(custom.headers['x-trace-id'], 'abc');
    assert.equal(custom.body, '{"received":true}');

    assert.equal((await change(id, { mode: 'default' })).statusCode, 200);

    const answered = await webhook(id);
    const requestId = String(answered.headers['x-qa-tools-request-id']);

    assert.equal(answered.statusCode, 200);
    assert.equal(answered.headers['x-trace-id'], undefined);
    // Switched back to the default, it answers today's default (D223).
    assert.equal(answered.body, await defaultAnswerText(app, id, requestId));
    // The record carries the status composed for this request (D109); its
    // terminal state is written after the reply, so only the status is read.
    assert.equal((await recordedStatus(requestId)).status, 200);

    const kept = (await read(id)).customResponse;

    assert.equal((await change(id, { mode: 'custom', response: kept })).statusCode, 200);

    const restored = await webhook(id);

    assert.equal(restored.statusCode, 201);
    assert.equal(restored.headers['x-trace-id'], 'abc');
    assert.equal(restored.body, '{"received":true}');
  });

  it('answers a new custom response from the next request on', async () => {
    const id = await createCustom();

    await change(id, {
      mode: 'custom',
      response: { status: 500, headers: [['retry-after', '30']], body: '{"error":"boom"}' },
    });

    const answered = await webhook(id);

    assert.equal(answered.statusCode, 500);
    assert.equal(answered.headers['retry-after'], '30');
    assert.equal(answered.headers['x-trace-id'], undefined);
    assert.equal(answered.body, '{"error":"boom"}');
  });

  /**
   * A request already waiting out its delay when the change commits answers
   * with what it was composed with; only a request captured after the change
   * sees the new response (D105/D109).
   */
  it('lets a request inside its delay keep the answer it was composed with', async () => {
    const id = await createCustom({ ...CUSTOM, delayMs: 1000 });

    const first = webhook(id);
    const firstId = await awaitPendingRecord(id);

    const changed = await change(id, {
      mode: 'custom',
      response: { status: 500, body: '{"changed":true}' },
    });

    assert.equal(changed.statusCode, 200);
    // Still inside its delay when the change committed, which is the case
    // under test rather than an accident of timing.
    assert.equal((await recordedStatus(firstId)).state, 'pending');

    const second = await webhook(id);

    assert.equal(second.statusCode, 500);
    assert.equal(second.body, '{"changed":true}');

    const held = await first;

    assert.equal(held.statusCode, 201);
    assert.equal(held.headers['x-trace-id'], 'abc');
    assert.equal(held.body, '{"received":true}');
    assert.equal((await recordedStatus(firstId)).status, 201);
  });
});

/** The id of the one request of a session whose response is still pending. */
async function awaitPendingRecord(sessionId: string): Promise<string> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const result = await pool.query<{ id: string }>(
      `SELECT r.id FROM requests r JOIN request_responses rr ON rr.request_id = r.id
        WHERE r.session_id = $1 AND rr.state = 'pending'`,
      [sessionId],
    );

    if (result.rows[0]) {
      return result.rows[0].id;
    }

    await delay(2);
  }

  throw new Error('no pending response record appeared');
}

/**
 * The change and the capture take the same `FOR UPDATE` lock on the session
 * row (D065, D150), so each request is answered wholly by one configuration.
 * Both directions are driven with the lock genuinely held: a pool pauses one
 * transaction at its `COMMIT`, and the test waits until PostgreSQL reports the
 * other one blocked behind it before letting go.
 *
 * The second call goes to this file's own listeners, whose hub is not the
 * gated pair's: sent to the same pair it would wait in the session's line
 * (`RealtimeHub.inOrder`, D205) before reaching the database, as
 * `realtime.test.ts` shows. The lock is what is under test here - what orders
 * calls that share no line.
 */
describe('a change and a capture serialise on the session row', () => {
  it('makes a capture that arrives during a change wait, and answers it wholly from the new response', async () => {
    const id = await createCustom();
    const gated = poolPausingFirstCommit(pool);
    const gatedServers = buildTestServers(gated.pool);
    const { api: server, receiver: gatedReceiver } = gatedServers;
    server.log.level = 'silent';
    gatedReceiver.log.level = 'silent';

    try {
      const changing = change(
        id,
        {
          mode: 'custom',
          response: { status: 500, headers: [['x-trace-id', 'new']], body: '{"v":"new"}' },
        },
        server,
      );
      const holderPid = await gated.holder;

      const capturing = webhook(id);

      await awaitBlockedBy(pool, holderPid);
      gated.release();

      assert.equal((await changing).statusCode, 200);

      const answered = await capturing;

      assert.equal(answered.statusCode, 500);
      assert.equal(answered.headers['x-trace-id'], 'new');
      assert.equal(answered.body, '{"v":"new"}');
    } finally {
      gated.release();
      await gatedServers.close();
    }
  });

  it('makes a change that arrives during a capture wait, and leaves that capture wholly old', async () => {
    const id = await createCustom();
    const gated = poolPausingFirstCommit(pool);
    const gatedServers = buildTestServers(gated.pool);
    const { api: server, receiver: gatedReceiver } = gatedServers;
    server.log.level = 'silent';
    gatedReceiver.log.level = 'silent';

    try {
      const capturing = webhook(id, gatedReceiver);
      const holderPid = await gated.holder;

      let settled = false;
      const changing = change(id, { mode: 'custom', response: { status: 500 } }).then(
        (response) => {
          settled = true;

          return response;
        },
      );

      await awaitBlockedBy(pool, holderPid);
      assert.equal(settled, false, 'the change completed while a capture held the session');
      gated.release();

      const answered = await capturing;

      assert.equal(answered.statusCode, 201);
      assert.equal(answered.headers['x-trace-id'], 'abc');
      assert.equal(answered.body, '{"received":true}');
      assert.equal((await changing).statusCode, 200);
      assert.equal((await webhook(id)).statusCode, 500);
    } finally {
      gated.release();
      await gatedServers.close();
    }
  });
});

/** A change is a use of the session (D133). */
describe('a change slides the expiry', () => {
  it('moves the expiry a full window ahead when the last refresh is over an hour old', async () => {
    const id = await createCustom();
    await setExpiry(id, '2 days');

    assert.equal((await change(id, { mode: 'default' })).statusCode, 200);

    const daysAhead = ((await expiresAt(id)).getTime() - Date.now()) / 86_400_000;

    assert.ok(
      Math.abs(daysAhead - SESSION_IDLE_DAYS) < 0.01,
      `expected about ${SESSION_IDLE_DAYS} days, got ${daysAhead}`,
    );
  });

  it('writes nothing to the expiry for a session refreshed within the hour', async () => {
    const id = await createCustom();
    await setExpiry(id, `${SESSION_IDLE_DAYS} days -30 minutes`);
    const before = await expiresAt(id);

    assert.equal((await change(id, { mode: 'default' })).statusCode, 200);
    assert.equal((await change(id, { mode: 'custom', response: CUSTOM })).statusCode, 200);
    assert.equal((await expiresAt(id)).getTime(), before.getTime());
  });

  it('saves the change even when the refresh itself fails', async () => {
    const id = await createCustom();
    await setExpiry(id, '2 days');
    const before = await expiresAt(id);

    let intercepted = 0;
    const forward = <T extends object>(target: T, property: string | symbol): unknown => {
      const value = Reflect.get(target, property, target);

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    };
    const failing = new Proxy(pool, {
      get(target, property) {
        if (property !== 'connect') {
          return forward(target, property);
        }

        return async () => {
          const client = await target.connect();
          const query = client.query.bind(client) as (...args: unknown[]) => unknown;

          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty !== 'query') {
                return forward(clientTarget, clientProperty);
              }

              return (...args: unknown[]) => {
                if (args[0] !== REFRESH_SESSION_EXPIRY_SQL) {
                  return query(...args);
                }

                intercepted += 1;

                // A statement that really fails inside PostgreSQL, so the
                // transaction is genuinely aborted without the savepoint.
                return query('SELECT 1 / 0');
              };
            },
          });
        };
      },
    });

    const warnings: string[] = [];

    resetRefreshWarningThrottle();

    const state: SessionResponseState = await changeSessionResponse(
      failing,
      id,
      { mode: 'default' },
      { warn: (_fields, message) => warnings.push(message) },
    );

    assert.equal(intercepted, 1, 'the refresh statement was never intercepted');
    assert.equal(state.response, null);
    assert.equal((await stored(id)).response_custom_disabled, true);
    assert.equal((await expiresAt(id)).getTime(), before.getTime());
    assert.deepEqual(warnings, [
      'session expiry refresh failed; the session keeps its previous expiry',
    ]);
  });
});

/**
 * The previous image, v0.13.0 (`4577ff4`), keeps running on this schema after
 * a `helm rollback`, which never undoes a migration (D055, D151). These are its
 * two statements about a session's response, copied from
 * `apps/backend/src/modules/sessions/repository.ts` as it stood there: the
 * session insert, and the read every one of its paths uses, whose rule is
 * "custom exactly when `response_status IS NOT NULL`".
 */
const PREVIOUS_IMAGE_INSERT = `INSERT INTO sessions
       (id, expires_at, response_status, response_headers, response_body, response_delay_ms)
     VALUES ($1, now() + make_interval(days => $2), $3, $4::jsonb, $5, $6)
     RETURNING id, expires_at`;

const PREVIOUS_IMAGE_READ = `SELECT id, expires_at, expires_at <= clock_timestamp() AS expired,
            response_status,
            COALESCE(response_headers, '[]'::jsonb) AS response_headers,
            response_body,
            COALESCE(response_delay_ms, 0) AS response_delay_ms
     FROM sessions
     WHERE id = $1`;

/** What the previous image answers a session with, by its own rule. */
async function previousImageResponse(sessionId: string): Promise<ResponseConfig | null> {
  const result = await pool.query<{
    response_status: number | null;
    response_headers: [string, string][];
    response_body: string | null;
    response_delay_ms: number;
  }>(PREVIOUS_IMAGE_READ, [sessionId]);
  const row = result.rows[0];

  assert.ok(row);

  return row.response_status === null
    ? null
    : {
        status: row.response_status,
        headers: row.response_headers,
        body: row.response_body,
        delayMs: row.response_delay_ms,
        template: false,
      };
}

async function insertAsPreviousImage(response: ResponseConfig | null): Promise<string> {
  const id = randomBytes(32).toString('base64url');

  await pool.query(PREVIOUS_IMAGE_INSERT, [
    id,
    SESSION_IDLE_DAYS,
    response?.status ?? null,
    response ? JSON.stringify(response.headers) : null,
    response?.body ?? null,
    response?.delayMs ?? null,
  ]);
  createdSessionIds.push(id);

  return id;
}

describe('the previous image on the new schema (D151)', () => {
  it('leaves a custom session it created after the migration custom under this image', async () => {
    const id = await insertAsPreviousImage(CUSTOM);

    const details = await read(id);

    assert.deepEqual(details.response, CUSTOM);
    assert.deepEqual(details.customResponse, CUSTOM);

    const answered = await webhook(id);

    assert.equal(answered.statusCode, 201);
    assert.equal(answered.headers['x-trace-id'], 'abc');
    assert.equal(answered.body, '{"received":true}');
  });

  it('leaves a default session it created after the migration default under this image', async () => {
    const id = await insertAsPreviousImage(null);

    const details = await read(id);

    assert.equal(details.response, null);
    assert.equal(details.customResponse, null);

    const answered = await webhook(id);
    const requestId = String(answered.headers['x-qa-tools-request-id']);

    assert.equal(answered.statusCode, 200);
    assert.equal(answered.body, await defaultAnswerText(app, id, requestId));
  });

  it('reads a custom response this image saved exactly as this image does', async () => {
    const id = await insertAsPreviousImage(null);
    const next: ResponseConfig = {
      status: 503,
      headers: [['retry-after', '5']],
      body: '{"busy":true}',
      delayMs: 100,
      template: false,
    };

    await change(id, { mode: 'custom', response: next });

    assert.deepEqual(await previousImageResponse(id), next);
  });

  /**
   * The accepted cost of keeping the custom response (D151): the previous image
   * knows nothing of the flag, so after a rollback a session switched to the
   * default here answers its kept custom response there, until it is switched
   * again by an image that knows the flag. This test pins that documented
   * behaviour, so a change to it has to change the documentation too.
   */
  it('answers a session switched to the default with its kept custom response', async () => {
    const id = await createCustom();

    await change(id, { mode: 'default' });

    assert.equal((await read(id)).response, null);
    assert.deepEqual(await previousImageResponse(id), CUSTOM);
  });
});
