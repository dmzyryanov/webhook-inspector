/**
 * Integration tests for the view API.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  MAX_BODY_BYTES,
  MAX_IGNORED_BODY_BYTES,
  type ApiError,
  type RequestDetails,
  type RequestListItem,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { whileExpired } from '../../testing/expired-session.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';

let pool: pg.Pool;
let servers: TestServers;
/** The application listener. */
let app: FastifyInstance;
/** The receive listener, where captures are sent (D187). */
let receiver: FastifyInstance;
const createdSessionIds: string[] = [];

// after() waits for before() to finish. Node's runner does not when a name
// pattern leaves this file no test, and what before() opens would outlive the
// run (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = start();
  await startup;
});

async function start(): Promise<void> {
  pool = createPool(loadConfig().databaseUrl);
  servers = buildTestServers(pool);
  ({ api: app, receiver } = servers);
  app.log.level = 'silent';
  receiver.log.level = 'silent';
  await servers.ready();
}

after(async () => {
  // A failed start is before()'s to report; close what it did open.
  await startup?.catch(() => undefined);

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers?.close();
  await pool.end();
});

async function newSession(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/sessions' });
  const { id } = response.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

async function capture(sessionId: string, payload: string | Buffer, url?: string): Promise<string> {
  const response = await receiver.inject({
    method: 'POST',
    url: url ?? `/s/${sessionId}`,
    headers: { 'content-type': 'application/json', 'x-marker': 'kept' },
    payload,
  });

  assert.equal(response.statusCode, 200);

  return latestRequestId(sessionId);
}

/** Captures a request without a body, as opening the URL in a browser does. */
async function captureGet(sessionId: string, url?: string): Promise<string> {
  const response = await receiver.inject({ method: 'GET', url: url ?? `/s/${sessionId}` });

  assert.equal(response.statusCode, 200);

  return latestRequestId(sessionId);
}

async function latestRequestId(sessionId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM requests WHERE session_id = $1 ORDER BY received_at DESC, id DESC LIMIT 1',
    [sessionId],
  );

  return rows[0]?.id as string;
}

async function storedRawRequest(requestId: string): Promise<Buffer> {
  const { rows } = await pool.query<{ raw_request: Buffer }>(
    'SELECT raw_request FROM requests WHERE id = $1',
    [requestId],
  );

  return rows[0]?.raw_request as Buffer;
}

async function requestIds(sessionId: string): Promise<string[]> {
  const response = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/requests` });

  return response.json<RequestListItem[]>().map((item) => item.id);
}

async function expire(sessionId: string): Promise<void> {
  await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [
    sessionId,
  ]);
}

describe('GET /api/sessions/:sessionId/requests', () => {
  it('lists requests newest first with metadata only (D037)', async () => {
    const sessionId = await newSession();
    await capture(sessionId, 'first');
    await capture(sessionId, 'second');

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests`,
    });

    assert.equal(response.statusCode, 200);

    const items = response.json<RequestListItem[]>();
    assert.equal(items.length, 2);
    assert.equal(items[0]?.bodySize, 6, 'newest request should come first');
    // `response` is the field v0.5.0 added to a list row, and it is the light
    // summary only: no body and no full headers (D110). `path` was added for
    // the list filter (D180).
    assert.deepEqual(Object.keys(items[0] ?? {}).sort(), [
      'bodySize',
      'id',
      'method',
      'path',
      'receivedAt',
      'response',
      'sourceIp',
    ]);
    assert.equal(items[0]?.path, `/s/${sessionId}`);
    assert.deepEqual(Object.keys(items[0]?.response ?? {}).sort(), [
      'queueStep',
      'rule',
      'state',
      'status',
    ]);
  });

  it('lists the path as stored, without the query, and null for an old capture (D180)', async () => {
    const sessionId = await newSession();
    const old = await capture(sessionId, 'old');
    const sub = await capture(sessionId, 'sub', `/s/${sessionId}/stripe/events?livemode=false`);

    // Captured before `requests.path` existed: no backfill ran (D110).
    await pool.query('UPDATE requests SET path = NULL WHERE id = $1', [old]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests`,
    });
    const items = response.json<RequestListItem[]>();

    assert.equal(items.find((item) => item.id === sub)?.path, `/s/${sessionId}/stripe/events`);
    assert.equal(items.find((item) => item.id === old)?.path, null);
  });

  it('returns an empty list for a session with no requests', async () => {
    const sessionId = await newSession();

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests`,
    });

    assert.deepEqual(response.json(), []);
  });
});

describe('GET /api/sessions/:sessionId/requests/:requestId', () => {
  it('returns the full request with headers and query string', async () => {
    const sessionId = await newSession();
    const requestId = await capture(sessionId, '{"a":1}', `/s/${sessionId}?x=1&x=2`);

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests/${requestId}`,
    });

    assert.equal(response.statusCode, 200);

    const details = response.json<RequestDetails>();
    assert.equal(details.body, '{"a":1}');
    assert.equal(details.bodyBase64, null);
    assert.equal(details.isBinary, false);
    assert.equal(details.queryString, 'x=1&x=2');
    assert.ok(details.headers.some(([name]) => name.toLowerCase() === 'x-marker'));
    assert.ok(details.raw?.startsWith('POST /s/'));
    assert.equal(details.isRawBinary, false);
  });

  it('transports a payload that is not valid UTF-8 as Base64 (D043)', async () => {
    const sessionId = await newSession();
    const payload = Buffer.from([0x00, 0xff, 0xfe, 0x41]);
    const requestId = await capture(sessionId, payload);

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests/${requestId}`,
    });

    const details = response.json<RequestDetails>();

    assert.equal(details.body, null);
    assert.equal(details.isBinary, true);
    assert.deepEqual(Buffer.from(details.bodyBase64 ?? '', 'base64'), payload);
    // The raw request embeds the same bytes, so it is binary too.
    assert.equal(details.isRawBinary, true);
  });

  it('carries a binary raw request through Base64 byte for byte (D043, D049)', async () => {
    const sessionId = await newSession();
    const payload = Buffer.from([0x00, 0xff, 0xfe, 0x41]);
    const requestId = await capture(sessionId, payload);

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests/${requestId}`,
    });

    const details = response.json<RequestDetails>();
    const transported = Buffer.from(details.rawBase64 ?? '', 'base64');

    assert.equal(details.raw, null);
    assert.deepEqual(transported, await storedRawRequest(requestId));
    assert.ok(transported.subarray(-payload.length).equals(payload), 'the payload bytes changed');
  });

  it('carries a raw request that has no body, ending at the blank line (D049)', async () => {
    const sessionId = await newSession();
    const requestId = await captureGet(sessionId, `/s/${sessionId}?probe=1`);

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests/${requestId}`,
    });

    const details = response.json<RequestDetails>();

    assert.equal(details.isRawBinary, false);
    assert.equal(details.rawBase64, null);
    assert.match(details.raw ?? '', new RegExp(`^GET /s/${sessionId}\\?probe=1 HTTP/1\\.1\\r\\n`));
    assert.ok(details.raw?.endsWith('\r\n\r\n'), 'the raw request does not end at the blank line');
    assert.equal(details.bodySize, 0);
  });

  it('carries a 1 MB payload through intact', async () => {
    const sessionId = await newSession();
    const payload = 'x'.repeat(MAX_BODY_BYTES);
    const requestId = await capture(sessionId, payload);

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests/${requestId}`,
    });

    const details = response.json<RequestDetails>();
    assert.equal(details.body?.length, MAX_BODY_BYTES);
    assert.equal(details.bodySize, MAX_BODY_BYTES);
  });

  it('answers 404 for a malformed id, a missing one and another session’s (D066)', async () => {
    const sessionId = await newSession();
    const otherSessionId = await newSession();
    const foreignId = await capture(otherSessionId, 'not yours');

    const expected = { errorCode: 1003, message: 'Request not found' };

    for (const id of ['hello', '11111111-2222-4333-8444-555555555555', foreignId]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/requests/${id}`,
      });

      assert.equal(response.statusCode, 404, `unexpected status for ${id}`);
      assert.deepEqual(response.json(), expected, `unexpected body for ${id}`);
    }
  });
});

describe('deleting requests', () => {
  it('deletes one request and answers 204', async () => {
    const sessionId = await newSession();
    const kept = await capture(sessionId, 'kept');
    const removed = await capture(sessionId, 'removed');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/requests/${removed}`,
    });

    assert.equal(response.statusCode, 204);
    assert.equal(response.body, '');

    const list = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/requests` });
    assert.deepEqual(
      list.json<RequestListItem[]>().map((item) => item.id),
      [kept],
    );
  });

  it('refuses to delete a request belonging to another session', async () => {
    const sessionId = await newSession();
    const otherSessionId = await newSession();
    const foreignId = await capture(otherSessionId, 'not yours');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/requests/${foreignId}`,
    });

    assert.equal(response.statusCode, 404);

    const list = await app.inject({
      method: 'GET',
      url: `/api/sessions/${otherSessionId}/requests`,
    });
    assert.equal(list.json<RequestListItem[]>().length, 1, 'the other session lost a request');
  });

  it('clears every request while keeping the session alive', async () => {
    const sessionId = await newSession();
    await capture(sessionId, 'one');
    await capture(sessionId, 'two');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/requests`,
    });

    assert.equal(response.statusCode, 204);

    const session = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    assert.equal(session.statusCode, 200);
    assert.equal(session.json<{ requestsCount: number }>().requestsCount, 0);
  });

  it('clears only its own session', async () => {
    const sessionId = await newSession();
    const otherSessionId = await newSession();
    await capture(sessionId, 'mine');
    const foreignId = await capture(otherSessionId, 'not yours');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/requests`,
    });

    assert.equal(response.statusCode, 204);
    assert.deepEqual(await requestIds(sessionId), []);
    assert.deepEqual(await requestIds(otherSessionId), [foreignId]);
  });

  it('clears a session that has nothing to clear', async () => {
    const sessionId = await newSession();

    for (const attempt of ['first', 'second']) {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${sessionId}/requests`,
      });

      assert.equal(response.statusCode, 204, `unexpected status on the ${attempt} clear`);
    }

    assert.deepEqual(await requestIds(sessionId), []);
  });
});

/**
 * The clear endpoint takes no body. Declaring one anyway is a client mistake,
 * and Fastify already classifies its own content-type parser failures as 4xx;
 * the root error handler carries that classification through instead of
 * widening it into 500 / 1500 (D104).
 */
describe('DELETE /api/sessions/:sessionId/requests — a declared body', () => {
  const malformed: [string, string | undefined, string, number, ApiError][] = [
    [
      'an empty body declared as JSON',
      'application/json',
      '',
      400,
      { errorCode: 1006, message: 'Request body must be a JSON object' },
    ],
    [
      'an unparseable body declared as JSON',
      'application/json',
      '{"a":',
      400,
      { errorCode: 1006, message: 'Request body must be a JSON object' },
    ],
    [
      'a body declared as a media type the instance has no parser for',
      'application/xml',
      '<a/>',
      415,
      { errorCode: 1007, message: 'Unsupported Media Type' },
    ],
    [
      'a Content-Type header that is not a media type',
      'json',
      'hello',
      415,
      { errorCode: 1007, message: 'Unsupported Media Type' },
    ],
    [
      'an empty Content-Type header',
      '',
      'hello',
      415,
      { errorCode: 1007, message: 'Unsupported Media Type' },
    ],
    // The receiver captures these since D138; the internal API still refuses
    // them.
    [
      'a Content-Type header with no subtype',
      'application/',
      'hello',
      415,
      { errorCode: 1007, message: 'Unsupported Media Type' },
    ],
    [
      'a Content-Type header with a second slash in it',
      'a/b/c',
      'hello',
      415,
      { errorCode: 1007, message: 'Unsupported Media Type' },
    ],
    [
      'a body sent with no Content-Type header at all',
      undefined,
      'hello',
      415,
      { errorCode: 1007, message: 'Unsupported Media Type' },
    ],
  ];

  for (const [description, contentType, payload, status, expected] of malformed) {
    it(`answers ${status} / ${expected.errorCode} for ${description}`, async () => {
      const sessionId = await newSession();
      const kept = await capture(sessionId, 'kept');

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${sessionId}/requests`,
        headers: contentType === undefined ? {} : { 'content-type': contentType },
        payload,
      });

      assert.equal(response.statusCode, status, response.body);
      // The whole body, so that a divergent message or an extra field fails.
      assert.deepEqual(response.json(), expected);
      // The refusal was not merely reported: a rejected call clears nothing.
      assert.deepEqual(await requestIds(sessionId), [kept]);
    });
  }

  /**
   * The other half of the rule, and the half worth pinning hardest: outside the
   * create scope the instance keeps Fastify's default parsers — `text/plain` as
   * well as `application/json` — and neither of them enforces the create route's
   * "must be a JSON object". A body these parsers accept is read, ignored, and
   * the clear goes through, so documenting a client error for these inputs would
   * promise a refusal where a destructive call actually succeeds (D104).
   */
  const accepted: [string, string, string][] = [
    ['a text/plain body', 'text/plain', 'hello'],
    ['a declared-JSON body that parses to a number', 'application/json', '123'],
    ['a declared-JSON body that parses to a string', 'application/json', '"abc"'],
    ['a declared-JSON body that parses to an array', 'application/json', '[]'],
  ];

  for (const [description, contentType, payload] of accepted) {
    it(`clears the requests and answers 204 for ${description}`, async () => {
      const sessionId = await newSession();
      await capture(sessionId, 'one');
      await capture(sessionId, 'two');

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${sessionId}/requests`,
        headers: { 'content-type': contentType },
        payload,
      });

      assert.equal(response.statusCode, 204, response.body);
      assert.equal(response.body, '');
      assert.deepEqual(await requestIds(sessionId), []);
    });
  }

  it('still clears when called the way the frontend calls it (D104)', async () => {
    const sessionId = await newSession();
    await capture(sessionId, 'one');
    await capture(sessionId, 'two');

    // Neither a Content-Type nor a body, which is what the frontend sends.
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/requests`,
    });

    assert.equal(response.statusCode, 204);
    assert.equal(response.body, '');
    assert.deepEqual(await requestIds(sessionId), []);
  });
});

describe('session state', () => {
  it('answers 410 on every route once the session has expired (D067)', async () => {
    const sessionId = await newSession();
    const requestId = await capture(sessionId, 'before expiry');

    const routes = [
      { method: 'GET', url: `/api/sessions/${sessionId}/requests` },
      { method: 'GET', url: `/api/sessions/${sessionId}/requests/${requestId}` },
      { method: 'DELETE', url: `/api/sessions/${sessionId}/requests/${requestId}` },
      { method: 'DELETE', url: `/api/sessions/${sessionId}/requests` },
      {
        method: 'POST',
        url: `/api/sessions/${sessionId}/requests/search`,
        headers: { 'content-type': 'application/json' },
        payload: '{"words":["expiry"]}',
      },
    ] as const;

    // Held against the cleanup sweep until the count, which its cascade would empty.
    await whileExpired(pool, sessionId, async () => {
      for (const route of routes) {
        const response = await app.inject(route);

        assert.equal(
          response.statusCode,
          410,
          `unexpected status for ${route.method} ${route.url}`,
        );
        assert.deepEqual(response.json(), { errorCode: 1002, message: 'Session expired' });
      }

      // The refusals were not merely reported: neither delete removed anything,
      // which is what binding the session check to the operation guarantees.
      const remaining = await pool.query<{ count: string }>(
        'SELECT count(*) AS count FROM requests WHERE session_id = $1',
        [sessionId],
      );
      assert.equal(remaining.rows[0]?.count, '1');
    });
  });

  it('answers 404 on every route for an unknown session', async () => {
    const unknown = 'z'.repeat(43);

    const requestId = '11111111-2222-4333-8444-555555555555';

    const routes = [
      { method: 'GET', url: `/api/sessions/${unknown}/requests` },
      { method: 'GET', url: `/api/sessions/${unknown}/requests/${requestId}` },
      { method: 'DELETE', url: `/api/sessions/${unknown}/requests/${requestId}` },
      { method: 'DELETE', url: `/api/sessions/${unknown}/requests` },
      {
        method: 'POST',
        url: `/api/sessions/${unknown}/requests/search`,
        headers: { 'content-type': 'application/json' },
        payload: '{"words":["abc"]}',
      },
    ] as const;

    for (const route of routes) {
      const response = await app.inject(route);

      assert.equal(response.statusCode, 404, `unexpected status for ${route.url}`);
      assert.deepEqual(response.json(), { errorCode: 1001, message: 'Session not found' });
    }
  });
});

describe('the session check is bound to the operation (D068)', () => {
  it('reports an expired session rather than a missing request', async () => {
    const sessionId = await newSession();
    const requestId = await capture(sessionId, 'still here');
    await expire(sessionId);

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests/${requestId}`,
    });

    assert.equal(response.statusCode, 410);
  });

  it('reports an unknown session once the row is gone, as cleanup leaves it', async () => {
    const sessionId = await newSession();
    await capture(sessionId, 'about to vanish');

    // What the scheduled cleanup does: the session goes, its requests cascade.
    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/requests`,
    });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { errorCode: 1001, message: 'Session not found' });
  });
});

/**
 * The routes that take no body - the four deletions and the queue's restart -
 * read at most 1 KiB of one sent anyway, check it by the rules of D104 and
 * keep none of it (D213): before, they read up to the listener's 1 MiB and
 * kept what they parsed while their handler waited. What they keep is
 * measured in `modules/limits/calls-memory.test.ts`. The not-found route was
 * one of them until D227, and reads none at all now: whatever body a path or
 * method no route has is sent, it answers `404` / `1000` unread
 * (`answer-before-body.test.ts`).
 */
describe('a body sent to a route that takes none (D213)', () => {
  /** Valid JSON of exactly `bytes` bytes: an array padded with white space. */
  function jsonOf(bytes: number): string {
    return `[${' '.repeat(bytes - 2)}]`;
  }

  async function routes(): Promise<{ method: 'POST' | 'DELETE'; url: string; ok: number }[]> {
    const ids = await Promise.all(Array.from({ length: 5 }, () => newSession()));
    const requestId = await capture(ids[3] as string, 'deleted');

    return [
      { method: 'POST', url: `/api/sessions/${ids[0]}/queue/restart`, ok: 200 },
      { method: 'DELETE', url: `/api/sessions/${ids[1]}/queue`, ok: 200 },
      { method: 'DELETE', url: `/api/sessions/${ids[2]}/requests`, ok: 204 },
      { method: 'DELETE', url: `/api/sessions/${ids[3]}/requests/${requestId}`, ok: 204 },
      { method: 'DELETE', url: `/api/sessions/${ids[4]}`, ok: 204 },
      // The not-found route, on a path no route has and a method none takes.
      { method: 'POST', url: '/api/no-such-route', ok: 404 },
      { method: 'DELETE', url: `/api/sessions/${ids[0]}/response`, ok: 404 },
    ];
  }

  it('is 413 / 1004 over 1 KiB, declared or chunked, and refuses nothing else it did not refuse before; on a path or method no route has, 404 / 1000 unread (D227)', async () => {
    assert.equal(MAX_IGNORED_BODY_BYTES, 1024);

    for (const { method, url } of await routes()) {
      const notFound = url.includes('no-such-route') || url.endsWith('/response');

      for (const [headers, payload] of [
        [{ 'content-type': 'application/json' }, jsonOf(MAX_IGNORED_BODY_BYTES + 1)],
        [{ 'content-type': 'text/plain' }, 'x'.repeat(MAX_IGNORED_BODY_BYTES + 1)],
        [{ 'content-type': 'application/json' }, jsonOf(MAX_BODY_BYTES)],
        [
          { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
          Readable.from([Buffer.from(jsonOf(MAX_IGNORED_BODY_BYTES + 1))]),
        ],
      ] as const) {
        const response = await app.inject({ method, url, headers, payload });

        assert.equal(
          response.statusCode,
          notFound ? 404 : 413,
          `${method} ${url}: ${response.body}`,
        );
        assert.deepEqual(
          response.json(),
          notFound
            ? { errorCode: 1000, message: 'Not found' }
            : { errorCode: 1004, message: 'Payload too large' },
        );
      }

      // Unchanged: a media type with no parser is refused unread, whatever
      // its size - by the not-found route with its 404, as before - and a
      // declared-JSON body that is empty or does not parse is 400, but on
      // the not-found route, which reads no body since D227, 404.
      for (const [headers, payload, status, errorCode] of [
        [
          { 'content-type': 'application/xml' },
          `<x>${'y'.repeat(4_096)}</x>`,
          notFound ? 404 : 415,
          notFound ? 1000 : 1007,
        ],
        [{ 'content-type': 'application/json' }, '{', notFound ? 404 : 400, notFound ? 1000 : 1006],
        [{ 'content-type': 'application/json' }, '', notFound ? 404 : 400, notFound ? 1000 : 1006],
        // Bytes that are not UTF-8 make a body that does not parse (D196).
        [
          { 'content-type': 'application/json' },
          Buffer.from([0x22, 0xff, 0x22]),
          notFound ? 404 : 400,
          notFound ? 1000 : 1006,
        ],
      ] as const) {
        const response = await app.inject({ method, url, headers, payload });

        assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`);
        assert.equal(response.json<{ errorCode: number }>().errorCode, errorCode);
      }
    }
  });

  it('is read, checked and ignored up to 1 KiB, and the call goes on', async () => {
    for (const { method, url, ok } of await routes()) {
      for (const [headers, payload] of [
        [{ 'content-type': 'application/json' }, jsonOf(MAX_IGNORED_BODY_BYTES)],
        [{ 'content-type': 'application/json; charset=utf-8' }, '{}'],
        [{ 'content-type': 'text/plain' }, 'x'.repeat(MAX_IGNORED_BODY_BYTES)],
      ] as const) {
        const response = await app.inject({ method, url, headers, payload });

        // A deletion done once answers 404 the next time; what matters is
        // that the body was not refused.
        assert.ok(
          response.statusCode === ok || response.statusCode === 404,
          `${method} ${url}: ${response.statusCode} ${response.body}`,
        );
      }
    }
  });
});
