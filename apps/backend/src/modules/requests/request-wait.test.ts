/**
 * Integration tests for the long-poll of the request list,
 * `GET /api/sessions/:sessionId/requests?wait=N` (D200), against the database
 * and the realtime hub, with both listeners of the process (D187) sharing one
 * hub as `index.ts` makes them share it: a capture on the receive listener
 * ends a wait on the application listener.
 *
 * What a wait answers at once, what ends it - a capture, a clear, the
 * session's deletion, its time, the client leaving, the shutdown - and that
 * nothing of it is left behind afterwards. The orders of events a wait can
 * meet are forced one by one in `wait.test.ts`, without a database.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { ErrorCode, type RequestListEntry } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildServer } from '../../server.ts';
import { whileExpired } from '../../testing/expired-session.ts';
import { createCallPlaces } from '../limits/calls-in-flight.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import { REQUEST_ID_HEADER } from '../webhook/response.ts';
import { PendingWaits } from './wait.ts';

const SESSION_NOT_FOUND = { errorCode: 1001, message: 'Session not found' };
const SESSION_EXPIRED = { errorCode: 1002, message: 'Session expired' };
const REQUEST_NOT_FOUND = { errorCode: 1003, message: 'Request not found' };

/** Pino's numeric level for `error`. */
const ERROR = 50;

let pool: pg.Pool;
let servers: TestServers;
/** The application listener. */
let app: FastifyInstance;
/** The receive listener, where captures are sent (D187). */
let receiver: FastifyInstance;
/** The application listener's pending waits. */
const waits = new PendingWaits();
/** An application listener whose list statements pass through `hooks` (`hookedPool`). */
let hooked: FastifyInstance;
const hookedWaits = new PendingWaits();
const logChunks: string[] = [];
const createdSessionIds: string[] = [];

// after() waits for before() to finish. Node's runner does not when a name
// pattern leaves this file no test, and what before() opens would outlive the
// run (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

const logDestination = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    logChunks.push(chunk.toString('utf8'));
    callback();
  },
});

/**
 * Run around the list statements of `sessionId` on `hookedPool`: `beforeList`
 * before one is sent, `afterList` once it has answered and before its answer
 * is handed back, as a capture by another client could fall there.
 */
const hooks: {
  sessionId: string | null;
  beforeList: ((index: number) => Promise<void>) | null;
  afterList: ((index: number) => Promise<void>) | null;
  lists: number;
} = { sessionId: null, beforeList: null, afterList: null, lists: 0 };

function isHookedList(text: unknown, values: unknown[] | undefined): boolean {
  return (
    typeof text === 'string' &&
    hooks.sessionId !== null &&
    values?.[0] === hooks.sessionId &&
    text.includes('LEFT JOIN LATERAL')
  );
}

/** `target`, with `hooks` run around the list statements it is sent. */
function hookedPool(target: pg.Pool): pg.Pool {
  return new Proxy(target, {
    get(object, property) {
      if (property === 'query') {
        return async (text: unknown, values?: unknown[]) => {
          const hooked = isHookedList(text, values);
          const index = hooked ? hooks.lists++ : -1;

          if (hooked) {
            await hooks.beforeList?.(index);
          }

          const result = await object.query(text as string, values);

          if (hooked) {
            await hooks.afterList?.(index);
          }

          return result;
        };
      }

      const value: unknown = Reflect.get(object, property, object);

      return typeof value === 'function' ? (value as () => unknown).bind(object) : value;
    },
  });
}

/** Runs `run` with `hooks` set for `sessionId`, and clears them afterwards. */
async function withHooks<T>(
  sessionId: string,
  set: Pick<Partial<typeof hooks>, 'beforeList' | 'afterList'>,
  run: () => Promise<T>,
): Promise<T> {
  Object.assign(hooks, {
    sessionId,
    beforeList: set.beforeList ?? null,
    afterList: set.afterList ?? null,
    lists: 0,
  });

  try {
    return await run();
  } finally {
    Object.assign(hooks, { sessionId: null, beforeList: null, afterList: null });
  }
}

before(async () => {
  startup = start();
  await startup;
});

async function start(): Promise<void> {
  pool = createPool(loadConfig().databaseUrl);
  // This listener lives for the whole file, which creates over 50 sessions
  // within a minute from one address, near production's 60 (D201), and holds
  // 200 waits at once from it, past the 128 calls an address may have in
  // flight (D213), which `modules/limits/` tests at their real number.
  servers = buildTestServers(pool, {
    logDestination,
    waits,
    rateLimits: LIMITS_OUT_OF_REACH,
    callPlaces: createCallPlaces(1_000),
  });
  ({ api: app, receiver } = servers);
  hooked = buildServer(hookedPool(pool), { logDestination, hub: servers.hub, waits: hookedWaits });
  await Promise.all([servers.ready(), hooked.ready()]);
}

after(async () => {
  // A failed start is before()'s to report; close what it did open.
  await startup?.catch(() => undefined);

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await Promise.all([servers?.close(), hooked?.close()]);
  await pool.end();
});

/** Polls until `condition` holds; bounded, so a regression fails instead of hanging. */
async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await delay(5);
  }
}

async function newSession(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/sessions' });
  const { id } = response.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

/** Captures one request through the receive listener and answers with its id (D100). */
async function capture(sessionId: string, body = 'ping'): Promise<string> {
  const response = await receiver.inject({
    method: 'POST',
    url: `/s/${sessionId}`,
    headers: { 'content-type': 'text/plain', 'x-trace': 'wait-test' },
    payload: body,
  });

  assert.equal(response.statusCode, 200, response.body);

  return response.headers[REQUEST_ID_HEADER] as string;
}

interface Timed {
  response: LightMyRequestResponse;
  /** Milliseconds from the call to its answer. */
  elapsed: number;
  /** When the answer came, on `performance.now()`'s clock. */
  answeredAt: number;
}

/** Sends the list call with `query` to `server`, timed. */
async function timedList(
  server: FastifyInstance,
  sessionId: string,
  query: string,
): Promise<Timed> {
  const started = performance.now();
  const response = await server.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/requests?${query}`,
  });
  const answeredAt = performance.now();

  return { response, elapsed: answeredAt - started, answeredAt };
}

function ids(response: LightMyRequestResponse): string[] {
  assert.equal(response.statusCode, 200, response.body);

  return response.json<RequestListEntry[]>().map((entry) => entry.id);
}

/** Waits until a wait on `sessionId` is subscribed, and its first read has had time to end. */
async function subscribed(sessionId: string, count = 1): Promise<void> {
  await until(() => servers.hub.countFor(sessionId) >= count, 'the wait to subscribe');
  await delay(150);
}

async function expiresAt(sessionId: string): Promise<string> {
  const result = await pool.query<{ expires_at: string }>(
    'SELECT expires_at::text AS expires_at FROM sessions WHERE id = $1',
    [sessionId],
  );

  return result.rows[0]?.expires_at as string;
}

/** Every line the listeners logged at `error` or above. */
function errorLines(): string[] {
  return logChunks
    .join('')
    .split('\n')
    .filter((line) => line !== '' && (JSON.parse(line) as { level: number }).level >= ERROR);
}

describe('GET .../requests?wait=N answers at once', () => {
  it('with a request captured before the call', async () => {
    const sessionId = await newSession();
    const captured = await capture(sessionId);
    const { response, elapsed } = await timedList(app, sessionId, 'wait=10');

    assert.deepEqual(ids(response), [captured]);
    assert.ok(elapsed < 1000, `answered after ${Math.round(elapsed)} ms`);
    assert.equal(servers.hub.countFor(sessionId), 0);
  });

  it('without after, with every request a session already holds', async () => {
    const sessionId = await newSession();
    const first = await capture(sessionId);
    const second = await capture(sessionId);
    const { response, elapsed } = await timedList(app, sessionId, 'wait=10');

    assert.deepEqual(ids(response), [second, first]);
    assert.ok(elapsed < 1000, `answered after ${Math.round(elapsed)} ms`);
  });

  it('as the list answers it with after, limit, order and include', async () => {
    const sessionId = await newSession();
    const seen = await capture(sessionId, 'seen');
    const next = await capture(sessionId, 'next one');

    await capture(sessionId, 'after that');

    const { response, elapsed } = await timedList(
      app,
      sessionId,
      `wait=10&after=${seen}&order=asc&limit=1&include=headers,body`,
    );
    const [entry] = response.json<(RequestListEntry & { body: string; headers: unknown })[]>();

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['transfer-encoding'], 'chunked');
    assert.ok(elapsed < 1000);
    assert.equal(entry?.id, next);
    assert.equal(entry?.body, 'next one');
    assert.ok(Array.isArray(entry?.headers));
  });

  it('with 404 / 1003 for an after that names no request of the session, leaving nothing', async () => {
    const sessionId = await newSession();
    const otherSession = await newSession();
    const others = await capture(otherSession);

    for (const after of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', others]) {
      const { response, elapsed } = await timedList(app, sessionId, `wait=10&after=${after}`);

      assert.equal(response.statusCode, 404, after);
      assert.deepEqual(response.json(), REQUEST_NOT_FOUND);
      assert.ok(elapsed < 1000, `${after} answered after ${Math.round(elapsed)} ms`);
    }

    assert.equal(servers.hub.countFor(sessionId), 0);
    assert.equal(waits.size, 0);
  });

  it('with 404 / 1001 and 410 / 1002 for a session gone or expired', async () => {
    for (const unknown of ['z'.repeat(43), 'short']) {
      const { response } = await timedList(app, unknown, 'wait=10');

      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), SESSION_NOT_FOUND);
    }

    const sessionId = await newSession();

    await whileExpired(pool, sessionId, async () => {
      const { response, elapsed } = await timedList(app, sessionId, 'wait=10');

      assert.equal(response.statusCode, 410);
      assert.deepEqual(response.json(), SESSION_EXPIRED);
      assert.ok(elapsed < 1000);
    });
  });

  it('with 400 / 1013 for an invalid wait, and for wait with since', async () => {
    const sessionId = await newSession();

    for (const query of [
      'wait=0',
      'wait=31',
      'wait=1.5',
      'wait=05',
      'wait=%2B5',
      'wait=',
      'wait=5&wait=5',
      'wait=5&since=2026-10-04T09:00:00Z',
    ]) {
      const { response } = await timedList(app, sessionId, query);

      assert.equal(response.statusCode, 400, query);
      assert.equal(response.json<{ errorCode: number }>().errorCode, 1013, query);
    }

    assert.equal(servers.hub.countFor(sessionId), 0);
  });
});

describe('GET .../requests?wait=N holds an empty answer', () => {
  it('until a request is captured: wait=10 with a capture at about 1 s answers before 2 s', async (t) => {
    const sessionId = await newSession();
    const pending = timedList(app, sessionId, 'wait=10');

    await until(() => servers.hub.countFor(sessionId) === 1, 'the wait to subscribe');
    await delay(1000);

    const capturedAt = performance.now();
    const captured = await capture(sessionId);
    const { response, elapsed, answeredAt } = await pending;

    assert.deepEqual(ids(response), [captured]);
    assert.ok(elapsed >= 1000, `answered after ${Math.round(elapsed)} ms`);
    assert.ok(elapsed < 2000, `answered after ${Math.round(elapsed)} ms`);
    t.diagnostic(
      `from the capture's call to the answer: ${Math.round(answeredAt - capturedAt)} ms`,
    );
    assert.equal(servers.hub.countFor(sessionId), 0);
    assert.equal(waits.size, 0);
  });

  it('and answers 200 [] once wait seconds pass with nothing captured', async () => {
    const sessionId = await newSession();
    const { response, elapsed } = await timedList(app, sessionId, 'wait=1');

    assert.deepEqual(ids(response), []);
    assert.ok(elapsed >= 1000, `answered after ${Math.round(elapsed)} ms`);
    assert.ok(elapsed < 2500, `answered after ${Math.round(elapsed)} ms`);
    assert.equal(servers.hub.countFor(sessionId), 0);
    assert.equal(waits.size, 0);
  });

  it('without after, on an empty session, until its first request', async () => {
    const sessionId = await newSession();
    const pending = timedList(app, sessionId, 'wait=10');

    await subscribed(sessionId);

    const captured = await capture(sessionId);
    const { response, elapsed } = await pending;

    assert.deepEqual(ids(response), [captured]);
    assert.ok(elapsed < 2000);
  });

  it('with after, for what arrives after that request only', async () => {
    const sessionId = await newSession();
    const seen = await capture(sessionId);
    const pending = timedList(app, sessionId, `wait=10&after=${seen}`);

    await subscribed(sessionId);

    const next = await capture(sessionId);
    const { response, elapsed } = await pending;

    assert.deepEqual(ids(response), [next]);
    assert.ok(elapsed < 2000);
  });

  it('with after, when the request it names is deleted during the wait', async () => {
    const sessionId = await newSession();
    const seen = await capture(sessionId);
    const pending = timedList(app, sessionId, `wait=10&after=${seen}`);
    let answered = false;

    void pending.then(() => {
      answered = true;
    });
    await subscribed(sessionId);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/requests/${seen}`,
    });

    assert.equal(deleted.statusCode, 204);
    await delay(300);
    assert.equal(answered, false, 'deleting the after request ended the wait');

    const next = await capture(sessionId);

    assert.deepEqual(ids((await pending).response), [next]);
  });

  it('with after deleted, until the time runs out: 200 [], never 404', async () => {
    const sessionId = await newSession();
    const seen = await capture(sessionId);
    const pending = timedList(app, sessionId, `wait=1&after=${seen}`);

    await subscribed(sessionId);
    await app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/requests/${seen}` });

    const { response, elapsed } = await pending;

    assert.deepEqual(ids(response), []);
    assert.ok(elapsed >= 1000);
  });

  it('streamed with what include asks for once a request arrives', async () => {
    const sessionId = await newSession();
    const seen = await capture(sessionId);
    const pending = timedList(app, sessionId, `wait=10&after=${seen}&include=headers,body`);

    await subscribed(sessionId);

    const next = await capture(sessionId, '{"orderId":42}');
    const { response } = await pending;
    const [entry] =
      response.json<(RequestListEntry & { body: string; headers: [string, string][] })[]>();

    assert.equal(response.statusCode, 200);
    assert.equal(entry?.id, next);
    assert.equal(entry?.body, '{"orderId":42}');
    assert.ok(entry?.headers.some(([name, value]) => name === 'x-trace' && value === 'wait-test'));
  });
});

describe('GET .../requests?wait=N ends at once', () => {
  it('with 200 [] when the session is cleared, with after', async () => {
    const sessionId = await newSession();
    const seen = await capture(sessionId);
    const pending = timedList(app, sessionId, `wait=10&after=${seen}`);

    await subscribed(sessionId);

    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/requests`,
    });

    assert.equal(cleared.statusCode, 204);

    const { response, elapsed } = await pending;

    assert.deepEqual(ids(response), []);
    assert.ok(elapsed < 1000, `answered after ${Math.round(elapsed)} ms`);
    assert.equal(servers.hub.countFor(sessionId), 0);
    assert.equal(waits.size, 0);
  });

  it('with 200 [] when the session is cleared, without after', async () => {
    const sessionId = await newSession();
    const pending = timedList(app, sessionId, 'wait=10');

    await subscribed(sessionId);
    await app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/requests` });

    const { response, elapsed } = await pending;

    assert.deepEqual(ids(response), []);
    assert.ok(elapsed < 1000, `answered after ${Math.round(elapsed)} ms`);
  });

  it('with 404 / 1001 when the session is deleted', async () => {
    const sessionId = await newSession();
    const pending = timedList(app, sessionId, 'wait=10');

    await subscribed(sessionId);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}` });

    assert.equal(deleted.statusCode, 204);

    const { response, elapsed } = await pending;

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), SESSION_NOT_FOUND);
    assert.ok(elapsed < 1000, `answered after ${Math.round(elapsed)} ms`);
    assert.equal(servers.hub.countFor(sessionId), 0);
    assert.equal(waits.size, 0);
  });
});

describe('GET .../requests?wait=N when its time runs out', () => {
  it('answers 410 / 1002 for a session expired by then', async () => {
    const sessionId = await newSession();
    const pending = timedList(app, sessionId, 'wait=1');

    await subscribed(sessionId);

    await whileExpired(pool, sessionId, async () => {
      const { response, elapsed } = await pending;

      assert.equal(response.statusCode, 410, response.body);
      assert.deepEqual(response.json(), SESSION_EXPIRED);
      assert.ok(elapsed >= 1000, `answered after ${Math.round(elapsed)} ms`);
    });
  });

  it('answers 404 / 1001 for a session the cleanup removed by then', async () => {
    const sessionId = await newSession();
    const pending = timedList(app, sessionId, 'wait=1');

    await subscribed(sessionId);
    // As the cleanup removes it: directly, with nobody told.
    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

    const { response, elapsed } = await pending;

    assert.equal(response.statusCode, 404, response.body);
    assert.deepEqual(response.json(), SESSION_NOT_FOUND);
    assert.ok(elapsed >= 1000, `answered after ${Math.round(elapsed)} ms`);
  });
});

describe('GET .../requests?wait=N misses no capture', () => {
  it('captured after the wait subscribed and before its first read', async () => {
    const sessionId = await newSession();
    let captured = '';
    const { response, elapsed } = await withHooks(
      sessionId,
      {
        beforeList: async (index) => {
          if (index === 0) {
            assert.equal(servers.hub.countFor(sessionId), 1, 'not subscribed before the read');
            captured = await capture(sessionId);
          }
        },
      },
      () => timedList(hooked, sessionId, 'wait=10'),
    );

    assert.deepEqual(ids(response), [captured]);
    assert.ok(elapsed < 1000, `answered after ${Math.round(elapsed)} ms`);
  });

  it('captured after the first read found nothing and before the wait looked at its answer', async () => {
    const sessionId = await newSession();
    let captured = '';
    const { response, elapsed } = await withHooks(
      sessionId,
      {
        afterList: async (index) => {
          if (index === 0) {
            captured = await capture(sessionId);
          }
        },
      },
      () => timedList(hooked, sessionId, 'wait=10'),
    );

    // Subscribed only after the read, the wait would have missed the
    // announcement and answered `[]` after 10 s.
    assert.deepEqual(ids(response), [captured]);
    assert.ok(elapsed < 1000, `answered after ${Math.round(elapsed)} ms`);
  });

  it('captured while a read after an announcement is under way', async () => {
    const sessionId = await newSession();
    let second = '';
    const { response, elapsed } = await withHooks(
      sessionId,
      {
        // The read after the first capture finds it gone, and a second
        // capture commits and is announced while that read is under way:
        // the read finds nothing, and the announcement must not be lost.
        beforeList: async (index) => {
          if (index === 1) {
            await pool.query('DELETE FROM requests WHERE session_id = $1', [sessionId]);
          }
        },
        afterList: async (index) => {
          if (index === 1) {
            second = await capture(sessionId);
          }
        },
      },
      async () => {
        const pending = timedList(hooked, sessionId, 'wait=10');

        await subscribed(sessionId);
        await capture(sessionId);

        return pending;
      },
    );

    assert.deepEqual(ids(response), [second]);
    assert.ok(elapsed < 2000, `answered after ${Math.round(elapsed)} ms`);
  });
});

/** A listening application listener of its own, over `listenPool`, sharing the hub. */
async function listening(
  listenPool: pg.Pool,
  own: PendingWaits,
): Promise<{ server: FastifyInstance; port: number }> {
  const server = buildServer(listenPool, { logDestination, hub: servers.hub, waits: own });

  await server.listen({ host: '127.0.0.1', port: 0 });

  return { server, port: (server.server.address() as AddressInfo).port };
}

interface RawAnswer {
  status: number;
  /** The answer's `Connection` header, as Node's client read it. */
  connection: string | undefined;
  body: string;
}

/**
 * A list call over a real socket, with what it answered, if anything: on a
 * connection of its own, or on one `agent` keeps alive, as Traefik keeps its
 * connections to the backend.
 */
function rawWait(
  port: number,
  path: string,
  agent: http.Agent | false = false,
): { request: http.ClientRequest; answered: Promise<RawAnswer> } {
  const request = http.request({ host: '127.0.0.1', port, path, agent });
  const answered = new Promise<RawAnswer>((resolve, reject) => {
    request.on('response', (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          connection: response.headers.connection,
          body,
        }),
      );
    });
    request.on('error', reject);
  });

  request.end();

  return { request, answered };
}

describe('GET .../requests?wait=N leaves nothing behind', () => {
  it('when the client disconnects: no subscriber, no pending wait, no answer, no error', async () => {
    const own = new PendingWaits();
    const { server, port } = await listening(pool, own);

    try {
      const sessionId = await newSession();
      const errorsBefore = errorLines().length;
      const { request, answered } = rawWait(port, `/api/sessions/${sessionId}/requests?wait=30`);

      answered.catch(() => undefined);
      await until(() => own.size === 1 && servers.hub.countFor(sessionId) === 1, 'the wait');
      request.destroy();
      await until(
        () => own.size === 0 && servers.hub.countFor(sessionId) === 0,
        'the wait to leave',
        1000,
      );

      // A capture afterwards reaches nobody, and nothing fails.
      await capture(sessionId);
      await delay(100);
      assert.equal(errorLines().length, errorsBefore);
      assert.ok(logChunks.join('').includes('Request aborted by the client'));
    } finally {
      await server.close();
    }
  });

  it('when the client disconnects during a read after an announcement', async () => {
    const own = new PendingWaits();
    const { server, port } = await listening(hookedPool(pool), own);

    try {
      const sessionId = await newSession();
      const errorsBefore = errorLines().length;
      let readEnded!: () => void;
      const readHeld = new Promise<void>((resolve) => {
        readEnded = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      await withHooks(
        sessionId,
        {
          afterList: async (index) => {
            if (index === 1) {
              readEnded();
              await held;
            }
          },
        },
        async () => {
          const { request, answered } = rawWait(
            port,
            `/api/sessions/${sessionId}/requests?wait=30`,
          );

          answered.catch(() => undefined);
          await until(() => own.size === 1, 'the wait');
          await delay(100);
          await capture(sessionId);
          await readHeld;
          request.destroy();
          await until(
            () => own.size === 0 && servers.hub.countFor(sessionId) === 0,
            'the wait to leave while its read is held',
            1000,
          );
          release();
          await delay(100);
        },
      );

      assert.equal(errorLines().length, errorsBefore);
    } finally {
      await server.close();
    }
  });

  it('when the process shuts down: every pending wait answers at once, and the close is not held up', async () => {
    const own = new PendingWaits();
    const { server, port } = await listening(pool, own);
    const sessionId = await newSession();
    const otherId = await newSession();
    const seen = await capture(otherId);
    const keptAlive = new http.Agent({ keepAlive: true });
    const pending = [
      rawWait(port, `/api/sessions/${sessionId}/requests?wait=30`, keptAlive),
      rawWait(port, `/api/sessions/${sessionId}/requests?wait=30&include=body`, keptAlive),
      rawWait(port, `/api/sessions/${otherId}/requests?wait=30&after=${seen}`),
    ];

    await until(() => own.size === 3, 'the waits');
    await delay(100);

    const closing = performance.now();

    await server.close();

    const closed = performance.now() - closing;

    for (const { answered } of pending) {
      const { status, connection, body } = await answered;

      assert.equal(status, 200);
      assert.equal(connection, 'close');
      assert.equal(body, '[]');
    }

    keptAlive.destroy();
    assert.ok(closed < 3000, `the close took ${Math.round(closed)} ms`);
    assert.equal(own.size, 0);
    assert.equal(servers.hub.countFor(sessionId), 0);
    assert.equal(servers.hub.countFor(otherId), 0);
  });

  // The last read at the close answers an error as it would when the time runs
  // out: the session expired or removed meanwhile, or the read failing. That
  // answer leaves through the error handler, and it ends its connection too.
  for (const { answer, expected, meanwhile } of [
    {
      answer: '410 / 1002 for a session that expired during the wait',
      expected: { status: 410, body: SESSION_EXPIRED },
      meanwhile: (sessionId: string, close: () => Promise<RawAnswer>) =>
        whileExpired(pool, sessionId, close),
    },
    {
      answer: '404 / 1001 for a session the cleanup removed during the wait',
      expected: { status: 404, body: SESSION_NOT_FOUND },
      meanwhile: async (sessionId: string, close: () => Promise<RawAnswer>) => {
        await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

        return close();
      },
    },
    {
      answer: '500 / 1500 for a last read that failed',
      expected: {
        status: 500,
        body: { errorCode: ErrorCode.INTERNAL_ERROR, message: 'Internal server error' },
      },
      meanwhile: (sessionId: string, close: () => Promise<RawAnswer>) =>
        withHooks(
          sessionId,
          {
            beforeList: () => Promise.reject(new Error('the last read failed')),
          },
          close,
        ),
    },
  ]) {
    it(`when the process shuts down: a wait answered ${answer} ends its connection, and the close is not held up`, async () => {
      const own = new PendingWaits();
      const { server, port } = await listening(hookedPool(pool), own);
      const keptAlive = new http.Agent({ keepAlive: true });
      // A holder rather than a `let`, which TypeScript would narrow to
      // `undefined` past the callback that sets it.
      const shutdown: { took: Promise<number> | null } = { took: null };

      try {
        const sessionId = await newSession();
        const { answered } = rawWait(
          port,
          `/api/sessions/${sessionId}/requests?wait=30`,
          keptAlive,
        );

        answered.catch(() => undefined);
        await until(() => own.size === 1, 'the wait');
        await delay(100);

        const { status, connection, body } = await meanwhile(sessionId, () => {
          const started = performance.now();

          shutdown.took = server.close().then(() => performance.now() - started);

          return answered;
        });

        assert.equal(status, expected.status, body);
        assert.deepEqual(JSON.parse(body), expected.body);
        assert.equal(connection, 'close');

        const closed = await shutdown.took;

        assert.ok(closed !== null && closed < 3000, `the close took ${closed} ms`);
        assert.equal(own.size, 0);
        assert.equal(servers.hub.countFor(sessionId), 0);
      } finally {
        // Without the header the connection held the close until it went:
        // ending it here lets a failed run end too, rather than after 72 s.
        keptAlive.destroy();
        await (shutdown.took ?? server.close());
      }
    });
  }

  it('with 200 waits at once, on one session and across sessions', async () => {
    const one = await newSession();
    const many = await Promise.all(Array.from({ length: 20 }, () => newSession()));
    const calls = [
      ...Array.from({ length: 100 }, () => timedList(app, one, 'wait=10')),
      ...Array.from({ length: 100 }, (_, index) =>
        timedList(app, many[index % 20] as string, 'wait=10'),
      ),
    ];

    await until(
      () =>
        servers.hub.countFor(one) === 100 &&
        many.every((sessionId) => servers.hub.countFor(sessionId) === 5),
      'every wait to subscribe',
    );
    await delay(200);

    const captured = new Map<string, string>();

    for (const sessionId of [one, ...many]) {
      captured.set(sessionId, await capture(sessionId));
    }

    const answers = await Promise.all(calls);

    for (const [index, { response, elapsed }] of answers.entries()) {
      const sessionId = index < 100 ? one : (many[(index - 100) % 20] as string);

      assert.deepEqual(ids(response), [captured.get(sessionId)]);
      assert.ok(elapsed < 5000, `answered after ${Math.round(elapsed)} ms`);
    }

    assert.equal(servers.hub.countFor(one), 0);
    assert.ok(many.every((sessionId) => servers.hub.countFor(sessionId) === 0));
    assert.equal(waits.size, 0);
  });
});

describe('GET .../requests?wait=N is not a use of the session', () => {
  it('leaves expires_at where it is, answered at once or empty when its time runs out (D133)', async () => {
    const sessionId = await newSession();

    await capture(sessionId);

    const newest = await capture(sessionId);
    const before = await expiresAt(sessionId);

    assert.equal(ids((await timedList(app, sessionId, 'wait=10')).response).length, 2);
    assert.deepEqual(ids((await timedList(app, sessionId, `wait=1&after=${newest}`)).response), []);
    assert.equal(await expiresAt(sessionId), before);
  });
});
