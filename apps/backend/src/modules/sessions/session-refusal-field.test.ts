/**
 * The `field` of a `1005` answer over the routes (D257, issue #232, criterion
 * 2): `PUT .../rules`, `PUT .../queue`, `PUT .../response` and
 * `POST /api/sessions` answer a refusal that names a place `400` with
 * `errorCode`, `message` and `field`; a key of the body itself and every other
 * error answer carry no `field`; no answer holds a key the client sent.
 *
 * Start the database and apply migrations first:
 *   npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { MAX_BODY_BYTES } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';

const JSON_TYPE = { 'content-type': 'application/json' };
const UNKNOWN_SESSION_ID = 'z'.repeat(43);

/** A key of 10,000 characters: no answer may hold it. */
const LONG_KEY = 'k'.repeat(10_000);

let pool: pg.Pool;
let servers: TestServers;
let app: FastifyInstance;
const createdSessionIds: string[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = start();
  await startup;
});

async function start(): Promise<void> {
  pool = createPool(loadConfig().databaseUrl);
  servers = buildTestServers(pool, { rateLimits: LIMITS_OUT_OF_REACH });
  app = servers.api;
  app.log.level = 'silent';
  servers.receiver.log.level = 'silent';
  await servers.ready();
}

after(async () => {
  await startup;

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers.close();
  await pool.end();
});

type InjectedResponse = Awaited<ReturnType<typeof app.inject>>;

async function createSession(): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/sessions' });

  assert.equal(created.statusCode, 201, created.body);

  const { id } = created.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

function send(method: 'POST' | 'PUT', url: string, payload: string): Promise<InjectedResponse> {
  return app.inject({ method, url, headers: JSON_TYPE, payload });
}

/** Asserts a `400` / `1005` answering exactly `message` and `field`, nothing else. */
function assertRefusedAt(answer: InjectedResponse, message: string, field: string): void {
  assert.equal(answer.statusCode, 400, answer.body);
  assert.deepEqual(answer.json(), { errorCode: 1005, message, field });
}

/** Asserts an error answer of `status` / `errorCode` with no `field`. */
function assertNoField(answer: InjectedResponse, status: number, errorCode: number): void {
  assert.equal(answer.statusCode, status, answer.body);

  const body = answer.json<Record<string, unknown>>();

  assert.equal(body.errorCode, errorCode, answer.body);
  assert.deepEqual(Object.keys(body), ['errorCode', 'message'], answer.body);
}

describe('a 1005 answer names its place in field (D257, criterion 2)', () => {
  it('PUT rules: the second rule’s path, as the deployed check sends it', async () => {
    const id = await createSession();
    const answer = await send(
      'PUT',
      `/api/sessions/${id}/rules`,
      JSON.stringify({
        rules: [
          { method: null, path: '/a', response: { status: 200 } },
          { method: null, path: 'orders', response: { status: 200 } },
        ],
      }),
    );

    assertRefusedAt(
      answer,
      'rules[1].path is required and must be a string starting with /',
      'rules[1].path',
    );
  });

  it('PUT queue: the second step’s delay', async () => {
    const id = await createSession();
    const answer = await send(
      'PUT',
      `/api/sessions/${id}/queue`,
      JSON.stringify({ steps: [{ status: 200 }, { status: 200, delayMs: 30_001 }] }),
    );

    assertRefusedAt(
      answer,
      'steps[1].delayMs must be an integer between 0 and 30000',
      'steps[1].delayMs',
    );
  });

  it('PUT response: the status, and a header pair’s value as [1]', async () => {
    const id = await createSession();

    assertRefusedAt(
      await send(
        'PUT',
        `/api/sessions/${id}/response`,
        '{"mode":"custom","response":{"status":99}}',
      ),
      'response.status is required and must be an integer between 200 and 599',
      'response.status',
    );
    assertRefusedAt(
      await send(
        'PUT',
        `/api/sessions/${id}/response`,
        JSON.stringify({ mode: 'custom', response: { status: 200, headers: [['x-a', 'a\r\nb']] } }),
      ),
      'response.headers[0] value must contain only visible ASCII, space and tab',
      'response.headers[0][1]',
    );
  });

  it('POST sessions: a key of the creation, and a rule’s header name as [0]', async () => {
    assertRefusedAt(
      await send('POST', '/api/sessions', '{"storeSourceIp":"no"}'),
      'storeSourceIp must be true or false',
      'storeSourceIp',
    );
    assertRefusedAt(
      await send(
        'POST',
        '/api/sessions',
        JSON.stringify({
          rules: [
            { method: null, path: '/', response: { status: 200 } },
            { method: null, path: '/', response: { status: 200, headers: [['Set-Cookie', 'a']] } },
          ],
        }),
      ),
      'rules[1].response.headers[0] name is reserved by the receiver and cannot be configured',
      'rules[1].response.headers[0][0]',
    );
  });

  it('names a rule holding a key of 10,000 characters by the rule, and answers nothing of the key', async () => {
    const id = await createSession();
    const answer = await send(
      'PUT',
      `/api/sessions/${id}/rules`,
      `{"rules":[{"method":null,"path":"/","response":{"status":200},${JSON.stringify(LONG_KEY)}:1}]}`,
    );

    assertRefusedAt(
      answer,
      'rules[0] may contain no key other than "method", "path" and "response"',
      'rules[0]',
    );
    assert.equal(answer.body.includes(LONG_KEY.slice(0, 100)), false);
  });

  it('gives a key of the body itself no field on all four routes, and answers nothing of it', async () => {
    const id = await createSession();
    const extra = `${JSON.stringify(LONG_KEY)}:1`;

    for (const [method, url, payload] of [
      ['PUT', `/api/sessions/${id}/rules`, `{"rules":[],${extra}}`],
      ['PUT', `/api/sessions/${id}/queue`, `{"steps":[{"status":200}],${extra}}`],
      ['PUT', `/api/sessions/${id}/response`, `{"mode":"default",${extra}}`],
      ['POST', '/api/sessions', `{${extra}}`],
      ['PUT', `/api/sessions/${id}/rules`, `{"rules":[],${JSON.stringify('a\n"b')}:1}`],
    ] as const) {
      const answer = await send(method, url, payload);

      assertNoField(answer, 400, 1005);
      assert.equal(answer.body.includes(LONG_KEY.slice(0, 100)), false, url);
      assert.match(answer.json<{ message: string }>().message, /^The request body may contain/);
    }
  });

  it('names a 1 MiB body of 50,000 rules by the list', async () => {
    const id = await createSession();
    const payload = JSON.stringify({
      rules: Array.from({ length: 50_000 }, () => ({ path: '/abcdefg' })),
    });

    assert.ok(payload.length <= MAX_BODY_BYTES);
    assertRefusedAt(
      await send('PUT', `/api/sessions/${id}/rules`, payload),
      'rules must contain at most 20 rules',
      'rules',
    );
  });
});

describe('every other error answer carries no field (D257, criterion 2)', () => {
  it('answers a missing session, a malformed body, a media type, a size and a route without one', async () => {
    const id = await createSession();
    const rules = '{"rules":[]}';

    assertNoField(await send('PUT', `/api/sessions/${UNKNOWN_SESSION_ID}/rules`, rules), 404, 1001);
    assertNoField(await send('PUT', `/api/sessions/${id}/rules`, '{"rules":'), 400, 1006);
    assertNoField(await send('PUT', `/api/sessions/${id}/queue`, '[]'), 400, 1006);
    assertNoField(
      await app.inject({
        method: 'PUT',
        url: `/api/sessions/${id}/rules`,
        headers: { 'content-type': 'text/plain' },
        payload: rules,
      }),
      415,
      1007,
    );
    assertNoField(
      await send(
        'PUT',
        `/api/sessions/${id}/rules`,
        `{"rules":[],"x":"${'a'.repeat(MAX_BODY_BYTES)}"}`,
      ),
      413,
      1004,
    );
    assertNoField(await app.inject({ method: 'GET', url: '/api/nothing' }), 404, 1000);
    assertNoField(
      await send('POST', `/api/sessions/${id}/requests/search`, '{"words":[]}'),
      400,
      1010,
    );
    assertNoField(await send('POST', '/api/sessions/status', '{"ids":[]}'), 400, 1014);
    assertNoField(
      await app.inject({ method: 'GET', url: `/api/sessions/${id}/requests?nope=1` }),
      400,
      1013,
    );
  });

  it('answers a private creation whose Authorization carries no key 1005 without one: it is no place in the body', async () => {
    const answer = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { ...JSON_TYPE, authorization: 'Basic x' },
      payload: '{"private":true}',
    });

    assertNoField(answer, 400, 1005);
  });
});
