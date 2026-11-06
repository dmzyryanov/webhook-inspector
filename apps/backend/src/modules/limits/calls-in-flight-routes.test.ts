/**
 * The calls an address has in flight on a real listener (D213): at most 128
 * on `/api` and `/mcp` together, waits included, the next refused `429` /
 * `1019` with `Retry-After: 1` and the limits' headers - on `/mcp` in its
 * JSON-RPC form, `id` `null`, before its query string's `400`, `403` for a
 * foreign `Origin` - on every method; another address unaffected, an IPv6
 * address counted by its `/64`; a call refused `1015` holding none, a `/mcp`
 * call refused by its count giving its place back before its refusal is
 * written; a body the server drains holding a place while it is drained, a
 * refusal that cannot hold one answered at once - the 129th call, a `1015`
 * with none free, eight large bodies held and 200 more refused, none left
 * pending; the place given back on every way a call ends - an
 * answer, a refusal after the place was taken, a hijacked reply, a client
 * gone in the middle of its body, while its handler waits for the pool or a
 * session's row lock, while its wait is pending, and pipelined answers still
 * queued when the connection goes - and the count back at exactly 0
 * afterwards, with no address left behind. And at most 100 header lines a
 * request on this listener.
 *
 * Over real sockets, not Fastify's injection: a place is held until the
 * answer's response closes, which is what a socket that goes away decides.
 * The listener trusts the test's own socket as the proxy, so that
 * `X-Forwarded-For` names the address a call counts under (D111, D201).
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  API_CALL_LIMIT,
  ErrorCode,
  MAX_CALLS_IN_FLIGHT,
  SESSION_CREATE_LIMIT,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { RealtimeHub } from '../realtime/hub.ts';
import { buildServer, type ServerOptions } from '../../server.ts';
import { attachListener } from '../../testing/servers.ts';
import { QUERY_STRING_REFUSED } from '../mcp/routes.ts';
import { createLargeBodyPlaces } from '../sessions/large-bodies.ts';
import { PendingWaits } from '../requests/wait.ts';
import { createCallPlaces, type CallPlaces } from './calls-in-flight.ts';
import { DEFAULT_RATE_LIMITS } from './rate-limit.ts';

const JSON_TYPE = 'application/json';
const MCP_ACCEPT = 'application/json, text/event-stream';
const MCP_VERSION = '2025-11-25';
const TOO_MANY = (limit: number) => ({
  errorCode: ErrorCode.TOO_MANY_CONCURRENT_CALLS,
  message: `Too many calls in flight: ${limit} at once per address; try again in a moment`,
});

/** The address most calls come from, and another. */
const A = '203.0.113.10';
const B = '203.0.113.11';

let pool: pg.Pool;
const createdSessionIds: string[] = [];
const listeners: FastifyInstance[] = [];
/** Every connection a test opened, so that none outlives the file. */
const sockets: { destroy(): void }[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
  })();
  await startup;
});

after(async () => {
  await startup;

  for (const socket of sockets) {
    socket.destroy();
  }

  await Promise.all(listeners.map((listener) => listener.close()));

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await pool?.end();
});

function discard(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

interface Listener {
  app: FastifyInstance;
  port: number;
  places: CallPlaces;
  waits: PendingWaits;
  /** The places `A` held as each answer marked `x-test-record` was sent, before it was written. */
  recorded: number[];
}

/**
 * The application listener on a port of its own, with `limit` places a
 * call address - the production 128 unless given - and the test's socket
 * trusted as the proxy.
 */
async function listen(
  options: ServerOptions & { limit?: number; database?: pg.Pool } = {},
): Promise<Listener> {
  const { limit, database, ...rest } = options;
  const places = createCallPlaces(limit);
  const waits = new PendingWaits();
  const hub = new RealtimeHub();
  const app = buildServer(database ?? pool, {
    logDestination: discard(),
    trustedProxyCidrs: ['127.0.0.1/32'],
    rateLimits: DEFAULT_RATE_LIMITS,
    waits,
    callPlaces: places,
    hub,
    ...rest,
  });

  // The process's realtime listener (D221): a clear ends the waits through it.
  attachListener(app, pool, hub);

  // Added after the listener's own hooks, so that it runs once the place is
  // taken: a refusal by a later hook.
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-test-throw'] !== undefined) {
      throw new Error('a later hook failed');
    }
  });

  // What `A` holds as an answer is sent, before a byte of it is written and
  // so before its response can close: a place given back "at once" is back
  // by then, one given back on the close is not.
  const recorded: number[] = [];

  app.addHook('onSend', async (request) => {
    if (request.headers['x-test-record'] !== undefined) {
      recorded.push(places.takenBy(A));
    }
  });

  listeners.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });

  return { app, port: (app.server.address() as net.AddressInfo).port, places, waits, recorded };
}

async function createSession(app: FastifyInstance): Promise<string> {
  // From an address of its own, so that no test's count includes it.
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    remoteAddress: '198.18.0.1',
  });

  assert.equal(response.statusCode, 201, response.body);

  const { id } = response.json() as { id: string };

  createdSessionIds.push(id);

  return id;
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Call {
  /** The whole answer, or the failure that ended the call before it. */
  answered: Promise<Answer>;
  /** Sends the rest of the body held back. */
  finish: () => void;
  /** Closes the connection, as a client that goes away does. */
  abort: () => void;
}

interface SendOptions {
  method?: string;
  /** The address the call comes from, as the proxy names it. */
  from?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Send the headers and the first 16 bytes of the body, and hold the rest. */
  hold?: boolean;
  /** `Connection: close` rather than kept alive: a refusal drains the body first (D143). */
  closing?: boolean;
}

/** One call on a connection of its own. */
function send(port: number, path: string, options: SendOptions = {}): Call {
  const { method = 'GET', from = A, headers = {}, body, hold = false, closing = false } = options;
  const payload = body === undefined ? undefined : Buffer.from(body);
  const agent = new http.Agent({ keepAlive: !closing });
  const request = http.request({
    host: '127.0.0.1',
    port,
    path,
    method,
    agent,
    headers: {
      'x-forwarded-for': from,
      ...(closing ? { connection: 'close' } : {}),
      ...(payload === undefined ? {} : { 'content-length': String(payload.length) }),
      ...headers,
    },
  });
  const answered = new Promise<Answer>((resolve, reject) => {
    request.on('response', (response) => {
      const chunks: Buffer[] = [];

      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        agent.destroy();
      });
      response.on('error', reject);
    });
    request.on('error', reject);
  });

  answered.catch(() => undefined);

  if (hold && payload !== undefined) {
    request.flushHeaders();
    request.write(payload.subarray(0, 16));
  } else if (payload !== undefined) {
    request.end(payload);
  } else {
    request.end();
  }

  const call: Call = {
    answered,
    finish: () => {
      request.end(payload?.subarray(16));
    },
    abort: () => {
      request.destroy();
      agent.destroy();
    },
  };

  sockets.push({ destroy: call.abort });

  return call;
}

/** A pending wait on `sessionId`, which nothing captured will end. */
function wait(port: number, sessionId: string, from = A): Call {
  return send(port, `/api/sessions/${sessionId}/requests?wait=30`, { from });
}

/** A JSON-RPC message to `/mcp`, or to `path`: `/mcp` with a query string. */
function mcp(
  port: number,
  message: Record<string, unknown>,
  options: SendOptions & { path?: string } = {},
): Call {
  const { path = '/mcp', ...rest } = options;

  return send(port, path, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    ...rest,
    headers: {
      'content-type': JSON_TYPE,
      accept: MCP_ACCEPT,
      'mcp-protocol-version': MCP_VERSION,
      ...options.headers,
    },
  });
}

const INITIALIZE = {
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: 'calls-in-flight-test', version: '1' },
  },
};

/** Waits until `check` holds, for 5 s at most. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
    await delay(5);
  }
}

/** An answer's status, and the error code its body names if any: `429 / 1019`. */
function statusOf({ status, body }: Answer): string {
  let code: unknown;

  try {
    const parsed = JSON.parse(body) as {
      errorCode?: unknown;
      error?: { data?: { errorCode?: unknown } };
    } | null;

    code = parsed?.errorCode ?? parsed?.error?.data?.errorCode;
  } catch {
    code = undefined;
  }

  return typeof code === 'number' ? `${status} / ${code}` : String(status);
}

/**
 * Opens 128 waits from `A` at once, each on a connection of its own, and
 * resolves to them once all are pending: 128 places held by `A` and 128
 * waits in `waits`. That is where these tests start, not what they time, so
 * it is bounded at 20 s rather than `until`'s 5 s: the API's work passes
 * three at a time (D244), so the 128 access checks queue behind each other,
 * and load stretches each (`docs/testing/flakes.md`, F-21). 20 s is well
 * within the waits' own 30 s (D200), so all are still pending when the test
 * goes on. Nothing here ends a wait: a call that ends first, answered or
 * failed, fails the setup at once, and every failure names what it read.
 */
async function holdWaits(
  t: TestContext,
  { port, places, waits }: Listener,
  sessionId: string,
): Promise<Call[]> {
  const started = Date.now();
  const pending = Array.from({ length: 128 }, () => wait(port, sessionId));
  const ended: string[] = [];

  for (const call of pending) {
    call.answered.then(
      (answer) => ended.push(statusOf(answer)),
      (error: NodeJS.ErrnoException) => ended.push(error.code ?? error.message),
    );
  }

  const read = (): string => {
    const counts = new Map<string, number>();

    for (const end of ended) {
      counts.set(end, (counts.get(end) ?? 0) + 1);
    }

    const ends = [...counts].map(([end, count]) => `${count} x ${end}`).join(', ');

    return (
      `${places.takenBy(A)} places held by A, ${waits.size} waits pending, ` +
      `${ended.length} of 128 calls ended${ends === '' ? '' : ` (${ends})`}, ` +
      `after ${Date.now() - started} ms`
    );
  };

  while (places.takenBy(A) !== 128 || waits.size !== 128) {
    assert.ok(ended.length === 0, `a call ended before 128 waits were pending: ${read()}`);
    assert.ok(
      Date.now() - started < 20_000,
      `timed out waiting until 128 waits are pending: ${read()}`,
    );
    await delay(5);
  }

  t.diagnostic(`128 waits pending after ${Date.now() - started} ms`);

  return pending;
}

/** Clears a session's requests, which answers every wait on it `[]` at once (D200). */
async function clear(port: number, sessionId: string): Promise<void> {
  const cleared = await send(port, `/api/sessions/${sessionId}/requests`, {
    method: 'DELETE',
    from: '198.18.0.2',
  }).answered;

  assert.equal(cleared.status, 204, cleared.body);
}

/**
 * The refusal of the 129th call: `429` / `1019`, `Retry-After: 1` and the
 * limits' headers, those of the creations for `POST /api/sessions`.
 */
function assertTooMany(
  answer: Answer,
  limit: number,
  where: string,
  rateLimit = API_CALL_LIMIT,
): void {
  assert.equal(answer.status, 429, `${where}: ${answer.body}`);
  assert.equal(answer.headers['retry-after'], '1', where);
  assert.equal(answer.headers['x-ratelimit-limit'], String(rateLimit), where);
  assert.ok(answer.headers['x-ratelimit-remaining'] !== undefined, where);
  assert.ok(answer.headers['x-ratelimit-reset'] !== undefined, where);

  if (answer.body !== '') {
    assert.deepEqual(JSON.parse(answer.body), TOO_MANY(limit), where);
  }
}

/** `/mcp`'s refusal of the 129th call, in D203's over-limit form, `id` `null`. */
function assertMcpTooMany(answer: Answer, limit: number, where: string): void {
  assert.equal(answer.status, 429, `${where}: ${answer.body}`);
  assert.equal(answer.headers['retry-after'], '1', where);
  assert.equal(answer.headers['x-ratelimit-limit'], String(API_CALL_LIMIT), where);
  assert.ok(answer.headers['x-ratelimit-remaining'] !== undefined, where);
  assert.ok(answer.headers['x-ratelimit-reset'] !== undefined, where);
  assert.deepEqual(
    JSON.parse(answer.body),
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: TOO_MANY(limit).message,
        data: { errorCode: ErrorCode.TOO_MANY_CONCURRENT_CALLS, retryAfter: 1 },
      },
    },
    where,
  );
}

/** The count back at exactly nothing: no place taken and no address kept. */
async function untilNothingHeld(places: CallPlaces): Promise<void> {
  await until(() => places.taken === 0, 'every place is given back');
  assert.equal(places.keys, 0);
}

/** `call`'s answer if it arrives within `ms`, which fails the test otherwise. */
async function answeredWithin(call: Call, ms: number, what: string): Promise<Answer> {
  const answer = await Promise.race([call.answered, delay(ms, null)]);

  assert.ok(answer !== null, `${what}: not answered within ${ms} ms`);

  return answer;
}

/** Whether `call` is still unanswered, its connection still open, after `ms`. */
async function stillPending(call: Call, ms: number): Promise<boolean> {
  const settled = await Promise.race([
    call.answered.then(
      () => true,
      () => true,
    ),
    delay(ms, false),
  ]);

  return !settled;
}

/** A large body of exactly 200,000 bytes, `start` and spaces. */
function large(start: string): string {
  return start + ' '.repeat(200_000 - start.length);
}

describe('128 calls in flight from one address (D213)', () => {
  it('holds 128 waits and refuses the 129th call on the API and on /mcp, 429 / 1019 with Retry-After: 1', async (t) => {
    assert.equal(MAX_CALLS_IN_FLIGHT, 128);

    const listener = await listen();
    const { app, port, places, waits } = listener;
    const sessionId = await createSession(app);
    const pending = await holdWaits(t, listener, sessionId);

    assertTooMany(await send(port, `/api/sessions/${sessionId}`).answered, 128, 'GET');
    assertMcpTooMany(await mcp(port, INITIALIZE).answered, 128, '/mcp');

    // A foreign Origin is still refused 403 first, as the specification asks.
    const foreign = await mcp(port, INITIALIZE, {
      headers: { origin: 'https://elsewhere.example' },
    }).answered;

    assert.equal(foreign.status, 403, foreign.body);
    assert.equal(JSON.parse(foreign.body).id, null);

    // Another address has its 128 of its own.
    assert.equal(
      (await send(port, `/api/sessions/${sessionId}`, { from: B }).answered).status,
      200,
    );
    assert.equal(places.takenBy(A), 128);

    // One client goes: its place comes back, and the next call is accepted.
    pending[0]?.abort();
    await until(() => places.takenBy(A) === 127, 'the place of a client gone comes back');
    assert.equal((await send(port, `/api/sessions/${sessionId}`).answered).status, 200);
    await until(() => places.takenBy(A) === 127, 'the answered call gives its place back');

    // A clear answers every wait `[]` at once, and every place comes back.
    await clear(port, sessionId);

    for (const call of pending.slice(1)) {
      const answer = await call.answered;

      assert.equal(answer.status, 200);
      assert.equal(answer.body, '[]');
    }

    await untilNothingHeld(places);
    assert.equal(waits.size, 0);
  });

  it('refuses a 129th /mcp call with a query string 429 / 1019 before its 400, and 403 for a foreign Origin', async (t) => {
    const listener = await listen();
    const { app, port, places } = listener;
    const sessionId = await createSession(app);
    const pending = await holdWaits(t, listener, sessionId);
    const urls = ['/mcp?x', '/mcp?', '/mcp#x'];
    const foreignOrigin = { origin: 'https://elsewhere.example' };

    // The calls in flight are checked before the `/mcp` scope's query string:
    // the over-limit form, on `POST` and `GET` alike, not the query string's
    // `400`.
    for (const path of urls) {
      assertMcpTooMany(await mcp(port, INITIALIZE, { path }).answered, 128, `POST ${path}`);
      assertMcpTooMany(await send(port, path).answered, 128, `GET ${path}`);

      // A foreign Origin is still refused 403 first, as the specification asks.
      for (const answer of [
        await mcp(port, INITIALIZE, { path, headers: foreignOrigin }).answered,
        await send(port, path, { headers: foreignOrigin }).answered,
      ]) {
        const { id, error } = JSON.parse(answer.body) as {
          id: unknown;
          error: { code: number; message: string };
        };

        assert.equal(answer.status, 403, `${path}: ${answer.body}`);
        assert.equal(id, null, path);
        assert.equal(error.code, -32000, path);
        assert.match(error.message, /^Forbidden/, path);
      }
    }

    assert.equal(places.takenBy(A), 128);

    await clear(port, sessionId);
    await Promise.all(pending.map((call) => call.answered));
    await untilNothingHeld(places);

    // With a place free, the same calls meet the query string's refusal.
    for (const path of urls) {
      const answer = await mcp(port, INITIALIZE, { path }).answered;

      assert.equal(answer.status, 400, `${path}: ${answer.body}`);
      assert.equal(JSON.parse(answer.body).error.message, QUERY_STRING_REFUSED, path);
    }

    await untilNothingHeld(places);
  });

  it('refuses every method on the API and on /mcp once the address has them all, bodyless ones included', async () => {
    const { app, port, places } = await listen({ limit: 2 });
    const sessionId = await createSession(app);
    const pending = [wait(port, sessionId), wait(port, sessionId)];

    await until(() => places.takenBy(A) === 2, 'two waits are pending');

    const methods = [
      'GET',
      'HEAD',
      'POST',
      'PUT',
      'DELETE',
      'OPTIONS',
      'PATCH',
      'PROPFIND',
      'TRACE',
      'QUERY',
    ];

    for (const path of [
      `/api/sessions/${sessionId}`,
      `/api/sessions/${sessionId}/requests`,
      `/api/sessions/${sessionId}/response`,
      '/api/sessions',
      '/api',
      '/api/no-such-route',
    ]) {
      for (const method of methods) {
        const answer = await send(port, path, { method }).answered;
        const creation = method === 'POST' && path === '/api/sessions';

        assertTooMany(
          answer,
          2,
          `${method} ${path}`,
          creation ? SESSION_CREATE_LIMIT : API_CALL_LIMIT,
        );

        if (method === 'HEAD') {
          assert.equal(answer.body, '');
        }
      }
    }

    // With a body: kept alive, it is answered without being read; on a
    // connection that closes, it is answered at once too, never drained,
    // since it holds no place to drain it with (D213) - this body arrived
    // whole with its headers, so nothing is in flight and the answer arrives.
    for (const closing of [false, true]) {
      assertTooMany(
        await send(port, `/api/sessions/${sessionId}/response`, {
          method: 'PUT',
          headers: { 'content-type': JSON_TYPE },
          body: '{"mode":"default"}',
          closing,
        }).answered,
        2,
        `a body, ${closing ? 'closing' : 'kept alive'}`,
      );
    }

    for (const method of methods.filter((name) => name !== 'HEAD')) {
      const answer =
        method === 'POST'
          ? await mcp(port, INITIALIZE).answered
          : await send(port, '/mcp', { method }).answered;

      assertMcpTooMany(answer, 2, `${method} /mcp`);
    }

    // Untouched: the probes, the receive URL's 410, the not-found route
    // outside `/api` and after `/mcp`, and the realtime connection.
    for (const [path, status] of [
      ['/healthz', 200],
      ['/readyz', 200],
      [`/s/${sessionId}`, 410],
      ['/mcpx', 404],
      ['/mcp/', 404],
      ['/', 404],
    ] as const) {
      const answer = await send(port, path).answered;

      assert.equal(answer.status, status, path);
      assert.equal(answer.headers['x-ratelimit-limit'], undefined, path);
    }

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/${sessionId}`);
    const [message] = (await once(socket, 'message')) as [MessageEvent];

    assert.deepEqual(JSON.parse(String(message.data)), { type: 'ready' });
    assert.equal(places.takenBy(A), 2);
    socket.close();
    await once(socket, 'close');

    await clear(port, sessionId);
    await Promise.all(pending.map((call) => call.answered));
    await untilNothingHeld(places);
  });

  it('takes a place for every method on the API and on /mcp, and gives each back once answered', async () => {
    const { app, port, places } = await listen({ limit: 1 });
    const sessionId = await createSession(app);
    const methods = [
      'GET',
      'HEAD',
      'POST',
      'PUT',
      'DELETE',
      'OPTIONS',
      'PATCH',
      'PROPFIND',
      'TRACE',
      'QUERY',
    ];
    let answered = 0;

    // With one place, every call in turn is accepted only if the one before
    // gave its place back.
    for (const path of [`/api/sessions/${sessionId}`, '/api/no-such-route', '/mcp']) {
      for (const method of methods) {
        const answer = await send(port, path, { method }).answered;

        assert.notEqual(answer.status, 429, `${method} ${path}: ${answer.body}`);
        await untilNothingHeld(places);
        answered += 1;
      }
    }

    assert.equal(answered, 30);
  });

  it('refuses the 129th at once on a connection that closes with its declared body unfinished, never draining it', async (t) => {
    const listener = await listen();
    const { app, port, places } = listener;
    const sessionId = await createSession(app);
    const pending = await holdWaits(t, listener, sessionId);

    // Its headers and 16 bytes of a declared body, the rest never sent: with
    // no place to hold it by, it is answered now, not once its body ends
    // (D213).
    const api = send(port, `/api/sessions/${sessionId}/response`, {
      method: 'PUT',
      headers: { 'content-type': JSON_TYPE },
      body: large('{"mode":"default"}'),
      hold: true,
      closing: true,
    });

    assertTooMany(await answeredWithin(api, 1_000, 'the API'), 128, 'the API, closing');

    const onMcp = mcp(port, INITIALIZE, { hold: true, closing: true });

    assertMcpTooMany(await answeredWithin(onMcp, 1_000, '/mcp'), 128, '/mcp, closing');
    assert.equal(places.takenBy(A), 128);

    api.abort();
    onMcp.abort();
    await clear(port, sessionId);
    await Promise.all(pending.map((call) => call.answered));
    await untilNothingHeld(places);
  });
});

describe('the address a call in flight counts under (D213)', () => {
  it('counts two IPv6 addresses of one /64 together, an IPv4-mapped one as its IPv4, and others apart', async () => {
    const { app, port, places } = await listen({ limit: 2 });
    const sessionId = await createSession(app);
    const ask = (from: string) => send(port, `/api/sessions/${sessionId}`, { from }).answered;
    const pending = [
      wait(port, sessionId, '2001:db8:1:2::1'),
      wait(port, sessionId, '2001:db8:1:2:ffff:ffff:ffff:fffe'),
    ];

    await until(() => places.takenBy('2001:db8:1:2::/64') === 2, 'the /64 holds two places');
    assertTooMany(await ask('2001:db8:1:2::abcd'), 2, 'the same /64');
    assert.equal((await ask('2001:db8:1:3::1')).status, 200, 'another /64 counts apart');

    pending.push(
      wait(port, sessionId, '::ffff:198.51.100.7'),
      wait(port, sessionId, '198.51.100.7'),
    );
    await until(() => places.takenBy('198.51.100.7') === 2, 'the IPv4 address holds two places');
    assertTooMany(await ask('198.51.100.7'), 2, 'the IPv4 address');
    assertTooMany(await ask('::ffff:198.51.100.7'), 2, 'the IPv4-mapped address');
    assert.equal((await ask('198.51.100.8')).status, 200, 'another address counts apart');
    assert.equal(places.keys, 2);

    await clear(port, sessionId);
    await Promise.all(pending.map((call) => call.answered));
    await untilNothingHeld(places);
  });
});

describe('a call refused by its count (D213)', () => {
  it('takes no place when refused 1015 kept alive, and a /mcp call its count refuses gives its place back before its refusal is written', async () => {
    const clock = { now: () => 1_000 };
    const { app, port, places, recorded } = await listen({
      rateLimits: { sessionCreates: 60, apiCalls: 3, now: clock.now },
    });
    const sessionId = await createSession(app);
    const pending = [wait(port, sessionId), wait(port, sessionId)];

    await until(() => places.takenBy(A) === 2, 'two waits are pending');

    // The third call of the minute: counted, a place taken and given back.
    assert.equal((await send(port, `/api/sessions/${sessionId}`).answered).status, 200);
    await until(() => places.takenBy(A) === 2, 'the third call gives its place back');

    // The fourth: refused 1015 on a connection kept alive, with no place
    // taken, its body unread and left to Node.
    const refused = send(port, `/api/sessions/${sessionId}/response`, {
      method: 'PUT',
      headers: { 'content-type': JSON_TYPE },
      body: '{"mode":"default"}',
      hold: true,
    });
    const refusal = await refused.answered;

    assert.equal(refusal.status, 429);
    assert.equal(JSON.parse(refusal.body).errorCode, ErrorCode.RATE_LIMIT_EXCEEDED);
    assert.equal(places.takenBy(A), 2);
    refused.abort();

    // `/mcp` takes its place before its body; counted once the body has
    // arrived and refused then, it gives the place back at once: before its
    // refusal is sent, not when that refusal's response closes.
    const held = mcp(port, INITIALIZE, { hold: true, headers: { 'x-test-record': '1' } });

    await until(() => places.takenBy(A) === 3, 'the /mcp call holds a place before its body');
    held.finish();

    const mcpRefusal = await held.answered;

    assert.equal(mcpRefusal.status, 429, mcpRefusal.body);
    assert.equal(JSON.parse(mcpRefusal.body).error.data.errorCode, ErrorCode.RATE_LIMIT_EXCEEDED);
    assert.deepEqual(recorded, [2], 'the refused /mcp call held its place as its refusal was sent');
    await until(() => places.takenBy(A) === 2, 'the refused /mcp call gives its place back');

    await clear(port, sessionId);
    await Promise.all(pending.map((call) => call.answered));
    await untilNothingHeld(places);
  });

  it('holds a place while a 1015 on a connection that closes is drained, until its client ends or leaves, and answers it at once with none free', async () => {
    const clock = { now: () => 1_000 };
    const { app, port, places } = await listen({
      limit: 2,
      rateLimits: { sessionCreates: 60, apiCalls: 2, now: clock.now },
    });
    const sessionId = await createSession(app);
    const refusedChange = (): Call =>
      send(port, `/api/sessions/${sessionId}/response`, {
        method: 'PUT',
        headers: { 'content-type': JSON_TYPE },
        body: `{"mode":"default"}${' '.repeat(1_000)}`,
        hold: true,
        closing: true,
      });
    const assertRefused = (answer: Answer, what: string): void => {
      assert.equal(answer.status, 429, `${what}: ${answer.body}`);
      assert.equal(JSON.parse(answer.body).errorCode, ErrorCode.RATE_LIMIT_EXCEEDED, what);
    };

    // The address's two calls of the minute: a wait, which keeps its place,
    // and a read.
    const pending = wait(port, sessionId);

    await until(() => places.takenBy(A) === 1, 'the wait is pending');
    assert.equal((await send(port, `/api/sessions/${sessionId}`).answered).status, 200);
    await until(() => places.takenBy(A) === 1, 'the read gives its place back');

    // Refused 1015 before its body, on a connection that closes: its body is
    // drained (D143), and the drain holds the address's second place.
    const drained = refusedChange();

    await until(() => places.takenBy(A) === 2, 'the drained 1015 holds a place');
    assert.ok(await stillPending(drained, 200), 'the 1015 was answered before its body ended');
    assert.equal(places.takenBy(A), 2);

    // With no place free, the next is answered at once, its body undrained.
    const atOnce = refusedChange();

    assertRefused(await answeredWithin(atOnce, 1_000, 'with no place free'), 'with no place free');
    assert.equal(places.takenBy(A), 2);
    atOnce.abort();

    // Its client sends the rest: the refusal is answered, the place given back.
    drained.finish();
    assertRefused(await drained.answered, 'once drained');
    await until(() => places.takenBy(A) === 1, 'the drained 1015 gives its place back');

    // A client that leaves in the middle of the drain gives it back too.
    const leaving = refusedChange();

    await until(() => places.takenBy(A) === 2, 'the next drained 1015 holds a place');
    leaving.abort();
    await until(() => places.takenBy(A) === 1, 'a client gone mid-drain gives its place back');

    await clear(port, sessionId);
    await pending.answered;
    await untilNothingHeld(places);
  });
});

/** A pool whose statements and connections wait while `gate.closed` is true. */
function gatedPool(base: pg.Pool): { pool: pg.Pool; gate: { closed: boolean; open: () => void } } {
  let opened: () => void = () => undefined;
  let gateOpen = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const gate = {
    closed: false,
    open: () => {
      gate.closed = false;
      opened();
      gateOpen = new Promise<void>((resolve) => {
        opened = resolve;
      });
    },
  };
  const gated = new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property, target);

      if (property === 'query' || property === 'connect') {
        return async (...args: unknown[]) => {
          if (gate.closed) {
            await gateOpen;
          }

          return (value as (...forwarded: unknown[]) => unknown).apply(target, args);
        };
      }

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });

  return { pool: gated, gate };
}

/** How many backends wait for a lock `holder` holds. */
async function blockedBy(holder: number): Promise<number> {
  const result = await pool.query<{ waiting: number }>(
    'SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
    [holder],
  );

  return result.rows[0]?.waiting ?? 0;
}

describe('the place given back however a call ends (D213)', () => {
  it('when it is answered, when its wait is pending and its client goes, and on /mcp when a wait is hijacked', async () => {
    const { app, port, places, waits } = await listen();
    const sessionId = await createSession(app);

    assert.equal((await send(port, `/api/sessions/${sessionId}`).answered).status, 200);
    await untilNothingHeld(places);

    const waiting = wait(port, sessionId);

    await until(() => places.takenBy(A) === 1 && waits.size === 1, 'the wait is pending');
    waiting.abort();
    await untilNothingHeld(places);
    assert.equal(waits.size, 0);

    const mcpWait = mcp(port, {
      id: 'wait',
      method: 'tools/call',
      params: { name: 'wait_for_request', arguments: { sessionId, wait: 30 } },
    });

    await until(() => places.takenBy(A) === 1 && waits.size === 1, 'the /mcp wait is pending');
    mcpWait.abort();
    await untilNothingHeld(places);
    assert.equal(waits.size, 0);
  });

  it('when its client goes in the middle of its body, on the API and on /mcp', async () => {
    const { app, port, places } = await listen();
    const sessionId = await createSession(app);

    for (const start of [
      () =>
        send(port, `/api/sessions/${sessionId}/response`, {
          method: 'PUT',
          headers: { 'content-type': JSON_TYPE },
          body: `{"mode":"custom","response":{"status":201,"body":"${'x'.repeat(4096)}"}}`,
          hold: true,
        }),
      () => mcp(port, INITIALIZE, { hold: true }),
    ]) {
      const call = start();

      await until(() => places.takenBy(A) === 1, 'the call holds its place mid-body');
      call.abort();
      await untilNothingHeld(places);
    }
  });

  it('only once its handler settles, when its client goes while the handler waits for the pool', async () => {
    const gated = gatedPool(pool);
    const { app, port, places } = await listen({ database: gated.pool });
    const sessionId = await createSession(app);

    gated.gate.closed = true;

    const call = send(port, `/api/sessions/${sessionId}`);

    await until(() => places.takenBy(A) === 1, 'the call holds its place');
    await delay(50);
    call.abort();
    await assert.rejects(call.answered);

    // The handler still waits, with the request in hand: the place stays.
    await delay(300);
    assert.equal(places.takenBy(A), 1, 'the place went with the client while the handler waited');

    gated.gate.open();
    await untilNothingHeld(places);
  });

  it('only once its handler settles, when its client goes while the handler waits for a row lock', async () => {
    const { app, port, places } = await listen();
    const sessionId = await createSession(app);
    const holder = await pool.connect();

    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);

      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid as number;
      const call = send(port, `/api/sessions/${sessionId}/response`, {
        method: 'PUT',
        headers: { 'content-type': JSON_TYPE },
        body: '{"mode":"custom","response":{"status":202}}',
      });

      for (let tries = 0; (await blockedBy(pid)) === 0; tries += 1) {
        assert.ok(tries < 1000, 'the change never waited for the lock');
        await delay(5);
      }

      assert.equal(places.takenBy(A), 1);
      call.abort();
      await assert.rejects(call.answered);
      await delay(300);
      assert.equal(places.takenBy(A), 1, 'the place went with the client while the handler waited');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    await untilNothingHeld(places);
  });

  it('after each refusal that follows the place: 413, 415, 400, 1017 and a throw in a later hook', async () => {
    const { app, port, places } = await listen({ largeBodyPlaces: createLargeBodyPlaces(0) });
    const sessionId = await createSession(app);

    const refusals: [string, Call, number][] = [
      [
        '413',
        send(port, `/api/sessions/${sessionId}/response`, {
          method: 'PUT',
          headers: { 'content-type': JSON_TYPE, 'content-length': String(2 * 1024 * 1024) },
          hold: true,
          body: '{',
        }),
        413,
      ],
      [
        '415',
        send(port, `/api/sessions/${sessionId}/response`, {
          method: 'PUT',
          headers: { 'content-type': 'text/plain' },
          body: '{"mode":"default"}',
        }),
        415,
      ],
      [
        '400',
        send(port, `/api/sessions/${sessionId}/response`, {
          method: 'PUT',
          headers: { 'content-type': JSON_TYPE },
          body: '{"mode":',
        }),
        400,
      ],
      [
        '1017',
        send(port, `/api/sessions/${sessionId}/requests/search`, {
          method: 'POST',
          headers: { 'content-type': JSON_TYPE },
          body: JSON.stringify({ words: ['abc'] }) + ' '.repeat(200_000),
        }),
        429,
      ],
      [
        'a throw',
        send(port, `/api/sessions/${sessionId}`, { headers: { 'x-test-throw': '1' } }),
        500,
      ],
    ];

    for (const [what, call, status] of refusals) {
      const answer = await call.answered;

      assert.equal(answer.status, status, `${what}: ${answer.body}`);
      call.abort();
      await untilNothingHeld(places);
    }
  });

  it('for a call refused 1017: kept while its body is drained, until its client ends or leaves, and at once when kept alive', async () => {
    const largeBodies = createLargeBodyPlaces(1);
    const { app, port, places, recorded } = await listen({ largeBodyPlaces: largeBodies });
    const sessionId = await createSession(app);
    const held = send(port, `/api/sessions/${sessionId}/response`, {
      method: 'PUT',
      headers: { 'content-type': JSON_TYPE },
      body: large('{"mode":"default"}'),
      hold: true,
    });
    const refusedQuery = ({ headers = {}, ...options }: SendOptions): Call =>
      send(port, `/api/sessions/${sessionId}/requests/query`, {
        method: 'POST',
        body: large('{}'),
        hold: true,
        ...options,
        headers: { 'content-type': JSON_TYPE, ...headers },
      });
    const assertBusy = (answer: Answer, what: string): void => {
      assert.equal(answer.status, 429, `${what}: ${answer.body}`);
      assert.equal(JSON.parse(answer.body).errorCode, ErrorCode.LARGE_BODIES_BUSY, what);
    };

    await until(
      () => places.takenBy(A) === 1 && largeBodies.taken === 1,
      'a large body holds both places',
    );

    // On a connection that closes, the refusal drains the body before it is
    // answered (D143), and the drain keeps the call's place among the calls
    // in flight - while it holds none of large bodies - so that drains count
    // toward the 128 (D213).
    const drained = refusedQuery({ closing: true });

    await until(() => places.takenBy(A) === 2, 'the drained 1017 keeps its place');
    assert.ok(await stillPending(drained, 200), 'the 1017 was answered before its body ended');
    assert.equal(places.takenBy(A), 2);
    assert.equal(largeBodies.taken, 1);
    drained.finish();
    assertBusy(await drained.answered, 'once drained');
    await until(() => places.takenBy(A) === 1, 'the drained 1017 gives its place back');

    // A client that leaves in the middle of the drain gives it back too.
    const leaving = refusedQuery({ closing: true });

    await until(() => places.takenBy(A) === 2, 'the next drained 1017 keeps its place');
    leaving.abort();
    await until(() => places.takenBy(A) === 1, 'a client gone mid-drain gives its place back');

    // Kept alive, the body is Node's to discard once the answer is written:
    // the call gives its place back at once, before its refusal is sent, and
    // holds neither place.
    const keptAlive = refusedQuery({ headers: { 'x-test-record': '1' } });

    assertBusy(await answeredWithin(keptAlive, 1_000, 'kept alive'), 'kept alive');
    assert.deepEqual(recorded, [1], 'the kept-alive 1017 held its place as its refusal was sent');
    assert.equal(largeBodies.taken, 1);
    keptAlive.abort();

    held.finish();
    assert.equal((await held.answered).status, 200);
    await untilNothingHeld(places);
    assert.equal(largeBodies.taken, 0);
  });

  it('with eight large bodies held, 200 more on connections that close hold at most 128 places, the rest answered at once', async () => {
    const largeBodies = createLargeBodyPlaces();
    const { app, port, places } = await listen({ largeBodyPlaces: largeBodies });
    const sessionId = await createSession(app);
    const held = Array.from({ length: 8 }, () =>
      send(port, `/api/sessions/${sessionId}/response`, {
        method: 'PUT',
        headers: { 'content-type': JSON_TYPE },
        body: large('{"mode":"default"}'),
        hold: true,
      }),
    );

    await until(
      () => places.takenBy(A) === 8 && largeBodies.taken === 8,
      'eight large bodies hold both places',
    );

    // Two hundred bodies cut short: each declares 200,000 bytes, sends 16
    // and stops, on a connection that closes. 120 are refused 1017 and
    // drained, each holding a place while it is; the other 80 find none and
    // are refused 1019 at once, undrained - their answer read, or their
    // connection closed under them - and none of them is left pending.
    const more = Array.from({ length: 200 }, () =>
      send(port, `/api/sessions/${sessionId}/requests/query`, {
        method: 'POST',
        headers: { 'content-type': JSON_TYPE },
        body: large('{}'),
        hold: true,
        closing: true,
      }),
    );
    const outcomes: (Answer | 'closed' | undefined)[] = more.map(() => undefined);

    more.forEach((call, index) => {
      call.answered.then(
        (answer) => {
          outcomes[index] = answer;
        },
        () => {
          outcomes[index] = 'closed';
        },
      );
    });

    const settled = (): number => outcomes.filter((outcome) => outcome !== undefined).length;

    await until(() => settled() === 80 && places.takenBy(A) === 128, '80 are answered at once');
    // Nothing more: the 120 are still drained, each holding its place.
    await delay(300);
    assert.equal(settled(), 80);
    assert.equal(places.takenBy(A), 128);
    assert.equal(largeBodies.taken, 8);

    for (const outcome of outcomes) {
      if (outcome !== undefined && outcome !== 'closed') {
        assertTooMany(outcome, 128, 'one of the 200 with no place');
      }
    }

    const drained = more.filter((_, index) => outcomes[index] === undefined);

    assert.equal(drained.length, 120);

    // Their clients send the rest: each is answered 1017 and gives its place
    // back.
    for (const call of drained) {
      call.finish();
    }

    for (const answer of await Promise.all(drained.map((call) => call.answered))) {
      assert.equal(answer.status, 429, answer.body);
      assert.equal(JSON.parse(answer.body).errorCode, ErrorCode.LARGE_BODIES_BUSY);
    }

    await until(() => places.takenBy(A) === 8, 'the drained calls give their places back');

    for (const call of more) {
      call.abort();
    }

    for (const call of held) {
      call.finish();
    }

    for (const answer of await Promise.all(held.map((call) => call.answered))) {
      assert.equal(answer.status, 200, answer.body);
    }

    await untilNothingHeld(places);
    assert.equal(largeBodies.taken, 0);
  });

  it('pipelined behind a pending wait: each call holds one, and all come back once the connection goes, queued answers included', async () => {
    const { app, port, places, waits } = await listen();
    const sessionId = await createSession(app);
    const head = (method: string, path: string, extra = ''): string =>
      `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: ${A}\r\n${extra}\r\n`;
    const change = '{"mode":"custom","response":{"status":203}}';

    for (const ending of ['destroy', 'end', 'reset'] as const) {
      const socket = net.connect(port, '127.0.0.1');

      sockets.push(socket);
      socket.on('error', () => undefined);
      socket.on('data', () => undefined);
      await once(socket, 'connect');
      socket.write(
        head('GET', `/api/sessions/${sessionId}/requests?wait=30`) +
          head('GET', `/api/sessions/${sessionId}`).repeat(3) +
          head('HEAD', `/api/sessions/${sessionId}`) +
          head('GET', '/api/no-such-route') +
          head(
            'PUT',
            `/api/sessions/${sessionId}/response`,
            `Content-Type: ${JSON_TYPE}\r\nContent-Length: ${change.length}\r\n`,
          ) +
          change,
      );

      await until(() => places.takenBy(A) === 7 && waits.size === 1, 'seven calls hold a place');
      // Their handlers have settled; their answers wait behind the wait's.
      await delay(300);
      assert.equal(places.takenBy(A), 7, `${ending}: a queued answer gave its place back early`);

      if (ending === 'destroy') {
        socket.destroy();
      } else if (ending === 'end') {
        socket.end();
      } else {
        socket.resetAndDestroy();
      }

      await untilNothingHeld(places);
      assert.equal(waits.size, 0);
    }
  });
});

describe('the header lines of a request (D213)', () => {
  /**
   * A request with `lines` header lines, `Host` and `Connection: close` among
   * them, and its raw answer once the connection has closed.
   *
   * A head of more than 101 lines is written in two parts: through line 101,
   * where the parser refuses it, and the rest only once the server has ended
   * its answer or the connection has closed. Written whole, a head of 2,500
   * lines, about 27 KB, can still be arriving when the server answers `431`
   * and closes; closed with data unread, the connection is reset, and the
   * client's next read fails, `read ECONNRESET`, the answer with it
   * (`docs/testing/flakes.md`, F-19). Written so, the server has read all it
   * was sent when it closes, and the rest meets a closed connection: its
   * `EPIPE` or reset is expected, and the close that follows settles the
   * answer, as F-01's reader does.
   */
  function withLines(port: number, path: string, lines: number): Promise<string> {
    // Half open: the rest can still be written once the server has ended.
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
    const chunks: Buffer[] = [];
    const head = [
      `GET ${path} HTTP/1.1`,
      'Host: 127.0.0.1',
      `X-Forwarded-For: ${A}`,
      'Connection: close',
    ];

    for (let line = 4; line <= lines; line += 1) {
      head.push(`x-${line}: y`);
    }

    const whole = `${head.join('\r\n')}\r\n\r\n`;
    // The request line and header lines 1 to 101.
    const first = lines > 101 ? `${head.slice(0, 102).join('\r\n')}\r\n` : whole;
    const rest = whole.slice(first.length);

    sockets.push(socket);

    return new Promise((resolve, reject) => {
      let failure: Error | undefined;

      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') {
          failure = error;
        }
      });
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      // The server has ended, its answer read whole: the rest, and our end.
      socket.once('end', () => (rest === '' ? socket.end() : socket.end(rest)));
      socket.once('close', () => {
        if (failure === undefined) {
          resolve(Buffer.concat(chunks).toString('utf8'));
        } else {
          reject(failure);
        }
      });
      socket.write(first);
    });
  }

  it('answers 100 header lines and refuses 101 with 431 before any route, taking no place', async () => {
    const { app, port, places } = await listen();
    const sessionId = await createSession(app);

    for (const path of [`/api/sessions/${sessionId}`, '/healthz']) {
      const answered = await withLines(port, path, 100);

      assert.match(answered, /^HTTP\/1\.1 200 OK\r\n/, path);

      const refused = await withLines(port, path, 101);

      assert.equal(
        refused,
        'HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 114\r\nContent-Type: application/json\r\n\r\n{"error":"Request Header Fields Too Large","message":"Exceeded maximum allowed HTTP header size","statusCode":431}',
        path,
      );
      assert.equal((await withLines(port, path, 2_500)).slice(0, 13), 'HTTP/1.1 431 ');
    }

    await untilNothingHeld(places);
  });
});

/**
 * A connection answered while its request's body is still arriving (D213).
 * Kept alive, Node keeps such a request until the rest of its body has come,
 * while its place among the calls in flight has gone back with the answer or
 * was never taken - a `1019`, a `1015` with no drain, a `1017` kept alive - so
 * every answer on `/api` and `/mcp` written before its body has all arrived
 * ends its connection, and one whose body has arrived whole, or that has
 * none, keeps it alive.
 *
 * Over connections written byte for byte and never closed by the client, as
 * one keeping them alive keeps them: whether the connection ends is the
 * server's to decide. The tests above destroy their client's agent once an
 * answer has ended, which hid this.
 */
describe('a connection whose body is still arriving when it is answered (D213)', () => {
  interface Connection {
    /** Writes on the connection. */
    write: (data: string) => void;
    /** The `index`th answer read on the connection, counted from 0, once whole. */
    answer: (index?: number) => Promise<Answer>;
    /** Whether the server has ended the connection, by its FIN or a reset. */
    ended: () => boolean;
  }

  /** A connection of its own, read answer by answer and never ended by the client. */
  function connect(port: number): Connection {
    const socket = net.connect(port, '127.0.0.1');
    const answers: Answer[] = [];
    let buffered = Buffer.alloc(0);
    let ended = false;

    sockets.push(socket);
    socket.on('error', () => undefined);
    socket.once('end', () => {
      ended = true;
    });
    socket.once('close', () => {
      ended = true;
    });
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);

      // Every answer here has a `Content-Length`, none a `HEAD`'s.
      for (;;) {
        const headEnd = buffered.indexOf('\r\n\r\n');

        if (headEnd === -1) {
          return;
        }

        const [statusLine = '', ...lines] = buffered
          .subarray(0, headEnd)
          .toString('latin1')
          .split('\r\n');
        const headers: http.IncomingHttpHeaders = {};

        for (const line of lines) {
          const colon = line.indexOf(':');

          headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
        }

        const end = headEnd + 4 + Number(headers['content-length'] ?? 0);

        if (buffered.length < end) {
          return;
        }

        answers.push({
          status: Number(statusLine.split(' ')[1]),
          headers,
          body: buffered.subarray(headEnd + 4, end).toString('utf8'),
        });
        buffered = buffered.subarray(end);
      }
    });

    return {
      write: (data) => {
        socket.write(data);
      },
      answer: async (index = 0) => {
        await until(() => answers.length > index || ended, `answer ${index} is read`);

        const answer = answers[index];

        assert.ok(answer !== undefined, `the connection ended before answer ${index}`);

        return answer;
      },
      ended: () => ended,
    };
  }

  interface Head {
    method: string;
    path: string;
    from?: string;
    headers?: Record<string, string>;
  }

  /** A request line and its header lines, kept alive as HTTP/1.1 is by default. */
  function head({ method, path, from = A, headers = {} }: Head): string {
    const lines = [`${method} ${path} HTTP/1.1`, 'Host: 127.0.0.1', `X-Forwarded-For: ${from}`];

    for (const [name, value] of Object.entries(headers)) {
      lines.push(`${name}: ${value}`);
    }

    return `${lines.join('\r\n')}\r\n\r\n`;
  }

  /**
   * A call whose headers declare `declared` bytes of body, of which only the
   * first 16 are sent: the rest never comes.
   */
  function stalled(port: number, request: Head, declared = 200_000): Connection {
    const connection = connect(port);

    connection.write(
      head({ ...request, headers: { ...request.headers, 'Content-Length': String(declared) } }) +
        '{"mode":"defaul',
    );

    return connection;
  }

  /** Waits until the server has ended `connection`, for 1 s at most. */
  async function endedWithin(connection: Connection, what: string): Promise<void> {
    const deadline = Date.now() + 1_000;

    while (!connection.ended()) {
      assert.ok(Date.now() < deadline, `${what}: the server kept the connection open`);
      await delay(5);
    }
  }

  const JSON_HEADERS = { 'Content-Type': JSON_TYPE };
  const MCP_HEADERS = {
    'Content-Type': JSON_TYPE,
    Accept: MCP_ACCEPT,
    'MCP-Protocol-Version': MCP_VERSION,
  };

  it('ends it after each refusal that holds no place for the body - 1019 on the API and on /mcp, 1015, 1017 - and after every other answer written before it', async () => {
    const largeBodies = createLargeBodyPlaces(1);
    const { app, port, places } = await listen({
      limit: 1,
      largeBodyPlaces: largeBodies,
      rateLimits: { sessionCreates: 1, apiCalls: API_CALL_LIMIT },
    });
    const sessionId = await createSession(app);

    /** `connection`'s answer: `status` and `errorCode`, `Connection: close`, and its end. */
    async function assertEnded(
      connection: Connection,
      status: number,
      errorCode: number | null,
      what: string,
    ): Promise<void> {
      const answer = await connection.answer();

      assert.equal(answer.status, status, `${what}: ${answer.body}`);
      assert.equal(answer.headers.connection, 'close', what);

      if (errorCode !== null) {
        const body = JSON.parse(answer.body) as {
          errorCode?: number;
          error?: { data?: { errorCode?: number } };
        };

        assert.equal(body.errorCode ?? body.error?.data?.errorCode, errorCode, what);
      }

      await endedWithin(connection, what);
    }

    // 1019: a wait holds the address's one place.
    const pending = wait(port, sessionId);

    await until(() => places.takenBy(A) === 1, 'the wait holds the place');
    await assertEnded(
      stalled(port, {
        method: 'PUT',
        path: `/api/sessions/${sessionId}/response`,
        headers: JSON_HEADERS,
      }),
      429,
      ErrorCode.TOO_MANY_CONCURRENT_CALLS,
      '1019 on the API',
    );
    await assertEnded(
      stalled(port, { method: 'POST', path: '/mcp', headers: MCP_HEADERS }),
      429,
      ErrorCode.TOO_MANY_CONCURRENT_CALLS,
      '1019 on /mcp',
    );
    await clear(port, sessionId);
    await pending.answered;
    await untilNothingHeld(places);

    // 1015: the address's one creation of the minute spent, the next is
    // refused before any place, its body left to Node.
    const created = await send(port, '/api/sessions', { method: 'POST' }).answered;

    assert.equal(created.status, 201, created.body);
    createdSessionIds.push((JSON.parse(created.body) as { id: string }).id);
    await assertEnded(
      stalled(port, { method: 'POST', path: '/api/sessions', headers: JSON_HEADERS }),
      429,
      ErrorCode.RATE_LIMIT_EXCEEDED,
      '1015',
    );

    // 1017: another address holds the one place of large bodies; this call
    // gives its place among the calls in flight back at once.
    const held = send(port, `/api/sessions/${sessionId}/response`, {
      method: 'PUT',
      from: B,
      headers: { 'content-type': JSON_TYPE },
      body: large('{"mode":"default"}'),
      hold: true,
    });

    await until(() => largeBodies.taken === 1, 'a large body holds the place');
    await assertEnded(
      stalled(port, {
        method: 'PUT',
        path: `/api/sessions/${sessionId}/response`,
        headers: JSON_HEADERS,
      }),
      429,
      ErrorCode.LARGE_BODIES_BUSY,
      '1017',
    );
    held.finish();
    assert.equal((await held.answered).status, 200);

    // Every other answer written before the body: refusals whose place goes
    // back once they are written - a 415, /mcp's 405, a 413 over the 1 KiB
    // of a route that takes no body - and a 200 to a GET that framed one.
    await assertEnded(
      stalled(port, {
        method: 'PUT',
        path: `/api/sessions/${sessionId}/response`,
        headers: { 'Content-Type': 'text/plain' },
      }),
      415,
      ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      '415',
    );
    await assertEnded(
      stalled(port, { method: 'DELETE', path: '/mcp', headers: MCP_HEADERS }),
      405,
      null,
      "/mcp's 405",
    );
    await assertEnded(
      stalled(
        port,
        { method: 'DELETE', path: `/api/sessions/${sessionId}/requests`, headers: JSON_HEADERS },
        2_000,
      ),
      413,
      ErrorCode.PAYLOAD_TOO_LARGE,
      '413',
    );
    await assertEnded(
      stalled(port, { method: 'GET', path: `/api/sessions/${sessionId}`, headers: JSON_HEADERS }),
      200,
      null,
      'a GET',
    );

    await untilNothingHeld(places);
    assert.equal(largeBodies.taken, 0);
  });

  it('keeps it alive when the body has arrived whole, or none is framed: the next call on it is answered', async () => {
    const { app, port, places } = await listen({ limit: 1 });
    const sessionId = await createSession(app);
    const pending = wait(port, sessionId);

    await until(() => places.takenBy(A) === 1, 'the wait holds the place');

    const connection = connect(port);
    const whole = '{"mode":"default"}';
    const calls: [string, number][] = [
      // A 1019 with no body, and with one sent whole with its headers.
      [head({ method: 'GET', path: `/api/sessions/${sessionId}` }), 429],
      [
        head({
          method: 'PUT',
          path: `/api/sessions/${sessionId}/response`,
          headers: { ...JSON_HEADERS, 'Content-Length': String(whole.length) },
        }) + whole,
        429,
      ],
      // From another address: a 415 whose body arrived whole, and a read.
      [
        head({
          method: 'PUT',
          path: `/api/sessions/${sessionId}/response`,
          from: B,
          headers: { 'Content-Type': 'text/plain', 'Content-Length': '1' },
        }) + 'x',
        415,
      ],
      [head({ method: 'GET', path: `/api/sessions/${sessionId}`, from: B }), 200],
    ];

    for (const [index, [request, status]] of calls.entries()) {
      connection.write(request);

      const answer = await connection.answer(index);

      assert.equal(answer.status, status, `${index}: ${answer.body}`);
      assert.equal(answer.headers.connection, 'keep-alive', String(index));
    }

    await delay(200);
    assert.equal(connection.ended(), false, 'the server ended a connection it could keep');

    await clear(port, sessionId);
    await pending.answered;
    await untilNothingHeld(places);
  });

  it('ends 140 refusals with stalled bodies after 128 calls held, kept alive: the connections are back at 128 within a second', async (t) => {
    const listener = await listen();
    const { app, port, places } = listener;
    const sessionId = await createSession(app);
    const pending = await holdWaits(t, listener, sessionId);
    const connections = async (): Promise<number> =>
      new Promise((resolve, reject) => {
        app.server.getConnections((error, count) => {
          if (error) {
            reject(error);
          } else {
            resolve(count);
          }
        });
      });

    assert.equal(await connections(), 128);

    // On the API and on `/mcp` in turn, each declaring 200,000 bytes and
    // sending 16: every one refused 1019 at once, its connection ended.
    // Twenty at a time, within the listen queue of a Mac, 128 connections,
    // beside the 128 open ones (D213 point 8).
    const refused: Connection[] = [];

    while (refused.length < 140) {
      const wave = Array.from({ length: 20 }, (_, index) =>
        index % 2 === 0
          ? stalled(port, {
              method: 'PUT',
              path: `/api/sessions/${sessionId}/response`,
              headers: JSON_HEADERS,
            })
          : stalled(port, { method: 'POST', path: '/mcp', headers: MCP_HEADERS }),
      );

      for (const connection of wave) {
        const answer = await connection.answer();

        assert.equal(answer.status, 429, `${refused.length}: ${answer.body}`);
        refused.push(connection);
      }
    }

    // Both within the second: the server's count and each client's end. Node
    // counts a connection out in the same call that closes its socket, and
    // the client reads that end on a later turn of the event loop, so the
    // count can be back at 128 before the last ends have been read here.
    const deadline = Date.now() + 1_000;
    const unended = (): number => refused.filter((connection) => !connection.ended()).length;
    let open = await connections();

    while (open !== 128 || unended() > 0) {
      assert.ok(
        Date.now() < deadline,
        `${open} connections open and ${unended()} refusals not ended a second after the refusals, not the 128 waits'`,
      );
      await delay(10);
      open = await connections();
    }

    for (const connection of refused) {
      assert.equal((await connection.answer()).headers.connection, 'close');
    }

    assert.equal(places.takenBy(A), 128);

    await clear(port, sessionId);
    await Promise.all(pending.map((call) => call.answered));
    await untilNothingHeld(places);
  });
});
