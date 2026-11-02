/**
 * A call a per-address limit refuses writes no line of the request log
 * (#189, D201's note): neither Fastify's `incoming request` nor its `request
 * completed`, over either count, on `/api` and on `/mcp`, with a body or none,
 * drained or not. Every other answer is logged as before, with the same
 * fields and the same redaction (D059, D117): a call let through, a `1017`, a
 * `500`, an answer of `/mcp` given for its own reason while its count is over,
 * a page no route has, and the router's refusals, which no limit counts.
 *
 * And a call let through is logged at once (#222): its `incoming request` is
 * written as soon as its count lets it through, not held until its answer, so
 * a call held by `wait` - on the list or `/mcp`'s `wait_for_request` - is in
 * the log while it waits.
 *
 * The log is read through `logDestination`, on the listener `buildServer`
 * builds, its window on the test's clock, so that nothing here waits for a
 * minute to pass.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type pg from 'pg';
import { ErrorCode } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { redactSessionIds } from '../../lib/redact.ts';
import { buildServer, type ServerOptions } from '../../server.ts';
import { attachListener } from '../../testing/servers.ts';
import { RealtimeHub } from '../realtime/hub.ts';
import { createLargeBodyPlaces } from '../sessions/large-bodies.ts';
import type { RateLimitSettings } from './rate-limit.ts';

type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

/** A well-formed session id no session has. */
const UNKNOWN_ID = 'z'.repeat(43);
const JSON_TYPE = { 'content-type': 'application/json' };
const MCP_HEADERS = { ...JSON_TYPE, accept: 'application/json, text/event-stream' };

/** Pino's numeric levels. */
const INFO = 30;

interface LogLine {
  level: number;
  time: number;
  msg: string;
  reqId?: string;
  req?: Record<string, unknown>;
  res?: { statusCode?: number };
  responseTime?: number;
}

/** A listener whose every log line is kept, parsed, for the test to read. */
interface Logged {
  app: FastifyInstance;
  lines: () => LogLine[];
}

let pool: pg.Pool;
const servers: FastifyInstance[] = [];
const createdSessionIds: string[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
  })();
  await startup;
});

after(async () => {
  await startup?.catch(() => undefined);
  await Promise.all(servers.map((server) => server.close()));

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await pool?.end();
});

/** The application listener with `limits` on a clock that never moves, its log kept. */
function logged(
  limits: Omit<RateLimitSettings, 'now'>,
  options: ServerOptions = {},
  on: pg.Pool = pool,
): Logged {
  let output = '';
  const app = buildServer(on, {
    logDestination: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
    ...options,
    rateLimits: { ...limits, now: () => 1_000 },
  });

  servers.push(app);

  return {
    app,
    lines: () =>
      output
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as LogLine),
  };
}

/**
 * `logged`'s listener with the process's realtime listener feeding its hub
 * (D221), so that a clear of a session ends the waits on it (D200).
 */
async function loggedWithWaits(): Promise<Logged & { hub: RealtimeHub }> {
  const hub = new RealtimeHub();
  const server = logged({ sessionCreates: 60, apiCalls: 100 }, { hub });

  attachListener(server.app, pool, hub);
  await server.app.ready();

  return { ...server, hub };
}

/** Polls `find` every 10 ms for up to `timeoutMs`: what it found, or `undefined`. */
async function eventually<T>(find: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const found = find();

    if (found !== undefined || Date.now() > deadline) {
      return found;
    }

    await delay(10);
  }
}

/** Lets what an answer logged reach the destination: the log is written as it happens, not later. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** One injected call, and the lines the listener wrote for it. */
async function call(
  server: Logged,
  options: InjectOptions,
): Promise<{ response: Injected; lines: LogLine[] }> {
  const before = server.lines().length;
  const response = await server.app.inject(options);

  await settle();

  if (response.statusCode === 201 && options.url === '/api/sessions') {
    createdSessionIds.push(response.json<{ id: string }>().id);
  }

  return { response, lines: server.lines().slice(before) };
}

/** The `errorCode` of an answer in the API's shape, or of `/mcp`'s JSON-RPC error. */
function errorCodeOf(response: Injected): number | undefined {
  const body = response.json<{ errorCode?: number; error?: { data?: { errorCode?: number } } }>();

  return body.errorCode ?? body.error?.data?.errorCode;
}

/** Asserts a refusal by a count, `429` / `1015`, that wrote no line at all. */
function assertRefusedUnlogged(
  { response, lines }: { response: Injected; lines: LogLine[] },
  what: string,
): void {
  assert.equal(response.statusCode, 429, `${what}: ${response.body}`);
  assert.equal(errorCodeOf(response), ErrorCode.RATE_LIMIT_EXCEEDED, what);
  assert.ok(response.headers['retry-after'], `${what} without Retry-After`);
  assert.equal(response.headers['x-ratelimit-remaining'], '0', what);
  assert.deepEqual(
    lines.map((line) => line.msg),
    [],
    `${what} wrote a line of the request log`,
  );
}

/**
 * Asserts the request log of one answered call as Fastify writes it: its
 * `incoming request`, any `between`, and its `request completed` with
 * `status`, one request id, each line with the fields it has always had.
 */
function assertLogged(lines: LogLine[], status: number, what: string, between: string[] = []) {
  assert.deepEqual(
    lines.map((line) => line.msg),
    ['incoming request', ...between, 'request completed'],
    what,
  );

  const [incoming, ...rest] = lines;
  const completed = rest.at(-1);

  assert.ok(incoming?.reqId, `${what}: no request id`);
  assert.ok(
    lines.every((line) => line.reqId === incoming.reqId),
    `${what}: lines of two requests`,
  );
  assert.equal(incoming.level, INFO);
  assert.deepEqual(Object.keys(incoming).sort(), [
    'hostname',
    'level',
    'msg',
    'pid',
    'req',
    'reqId',
    'time',
  ]);
  // D117's serializer; an injected call has no peer's port, a socket's has.
  assert.deepEqual(
    Object.keys(incoming.req ?? {})
      .filter((key) => key !== 'remotePort')
      .sort(),
    ['host', 'method', 'remoteAddress', 'url'],
  );
  assert.equal(completed?.level, INFO);
  assert.deepEqual(Object.keys(completed ?? {}).sort(), [
    'hostname',
    'level',
    'msg',
    'pid',
    'reqId',
    'res',
    'responseTime',
    'time',
  ]);
  assert.equal(completed?.res?.statusCode, status, what);
  assert.equal(typeof completed?.responseTime, 'number');
}

let nextRpcId = 1;

function mcpCall(remoteAddress: string, body: unknown, headers = {}): InjectOptions {
  return {
    method: 'POST',
    url: '/mcp',
    remoteAddress,
    headers: { ...MCP_HEADERS, ...headers },
    payload: JSON.stringify(body),
  };
}

function toolCall(remoteAddress: string, name: string, args: unknown): InjectOptions {
  return mcpCall(remoteAddress, {
    jsonrpc: '2.0',
    id: nextRpcId++,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function toolsList(remoteAddress: string): InjectOptions {
  return mcpCall(remoteAddress, { jsonrpc: '2.0', id: nextRpcId++, method: 'tools/list' });
}

/** The port a listening server took. */
function portOf(app: FastifyInstance): number {
  const address = app.server.address();

  return typeof address === 'object' && address ? address.port : 0;
}

/** Everything a connection is sent until it closes. */
async function readUntilClosed(socket: net.Socket): Promise<string> {
  const chunks: Buffer[] = [];

  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  await once(socket, 'close');

  return Buffer.concat(chunks).toString('latin1');
}

describe('the request log of a call a limit refuses (#189)', () => {
  it('writes no line for a creation refused over its count, with a body or none, and both for one let through', async () => {
    const server = logged({ sessionCreates: 2, apiCalls: 100 });

    for (let index = 1; index <= 2; index += 1) {
      const created = await call(server, { method: 'POST', url: '/api/sessions' });

      assert.equal(created.response.statusCode, 201);
      assertLogged(created.lines, 201, `creation ${index}`);
      assert.equal(created.lines[0]?.req?.method, 'POST');
      assert.equal(created.lines[0]?.req?.url, '/api/sessions');
    }

    assertRefusedUnlogged(
      await call(server, { method: 'POST', url: '/api/sessions' }),
      'a creation with no body',
    );
    assertRefusedUnlogged(
      await call(server, {
        method: 'POST',
        url: '/api/sessions',
        headers: JSON_TYPE,
        payload: '{"response":{"status":201}}',
      }),
      'a creation with a body',
    );
    assertRefusedUnlogged(
      await call(server, {
        method: 'POST',
        url: '/api/sessions',
        headers: JSON_TYPE,
        payload: Buffer.alloc(2 * 1024 * 1024, 0x20),
      }),
      'a creation over the size limit',
    );

    // The other calls count apart and are logged, the session id in their
    // URL shortened as in every line (D059).
    const read = await call(server, { method: 'GET', url: `/api/sessions/${UNKNOWN_ID}` });

    assert.equal(read.response.statusCode, 404);
    assertLogged(read.lines, 404, 'a read');
    assert.equal(read.lines[0]?.req?.url, '/api/sessions/zzzzzzzz...');
  });

  it('writes no line for a call refused over the other calls, on any route of /api, routed or not', async () => {
    const server = logged({ sessionCreates: 60, apiCalls: 3 });

    for (let index = 1; index <= 3; index += 1) {
      const read = await call(server, { method: 'GET', url: `/api/sessions/${UNKNOWN_ID}` });

      assertLogged(read.lines, 404, `read ${index}`);
    }

    for (const [method, url] of [
      ['GET', `/api/sessions/${UNKNOWN_ID}`],
      ['GET', `/api/sessions/${UNKNOWN_ID}/requests?wait=30`],
      ['DELETE', `/api/sessions/${UNKNOWN_ID}`],
      ['PUT', `/api/sessions/${UNKNOWN_ID}/queue`],
      ['HEAD', `/api/sessions/${UNKNOWN_ID}`],
      // No route has it, and it is the API's: counted, and refused.
      ['GET', '/api/no-such-route'],
      // The router decodes the path before it matches it: the API too.
      ['GET', `/%61pi/sessions/${UNKNOWN_ID}`],
    ] as const) {
      const refused = await call(server, {
        method,
        url,
        ...(method === 'PUT' ? { headers: JSON_TYPE, payload: '{"responses":[]}' } : {}),
      });

      if (method === 'HEAD') {
        // A HEAD answer has no body to read its code from.
        assert.equal(refused.response.statusCode, 429);
        assert.deepEqual(refused.lines, [], 'a HEAD refused wrote a line');
      } else {
        assertRefusedUnlogged(refused, `${method} ${url}`);
      }
    }

    // What no limit counts is logged as before: a path outside the API that
    // no route has (the probes log nothing below `warn`), and a URL the router
    // refuses before any hook, which has always written its `incoming
    // request` alone (D227).
    const page = await call(server, { method: 'GET', url: '/no-such-page' });

    assert.equal(page.response.statusCode, 404);
    assertLogged(page.lines, 404, 'a page no route has');

    const undecodable = await call(server, { method: 'GET', url: '/api/sessions/%zz' });

    assert.equal(undecodable.response.statusCode, 400);
    assert.deepEqual(
      undecodable.lines.map((line) => line.msg),
      ['incoming request'],
    );
    assert.equal(undecodable.lines[0]?.req?.url, '/api/sessions/%zz');
  });

  it('writes no line for a refusal whose body is drained, nor for one whose client leaves during the drain (D143)', async () => {
    const server = logged({ sessionCreates: 1, apiCalls: 100 });

    await server.app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal(
      (await call(server, { method: 'POST', url: '/api/sessions' })).response.statusCode,
      201,
    );

    const before = server.lines().length;
    const head =
      'POST /api/sessions HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n' +
      'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n';

    // Drained: its body arrives after the refusal is decided, and is read
    // before the answer.
    const drained = net.connect(portOf(server.app), '127.0.0.1');
    const answer = readUntilClosed(drained);

    await once(drained, 'connect');
    drained.write(head);
    await delay(100);
    drained.write('{}');

    const [status = ''] = (await answer).split('\r\n');

    assert.equal(status, 'HTTP/1.1 429 Too Many Requests');

    // Left during the drain: its abort is not logged either.
    const left = net.connect(portOf(server.app), '127.0.0.1');

    await once(left, 'connect');
    left.write(head.replace('Content-Length: 2', 'Content-Length: 1000') + '{');
    await delay(100);
    left.destroy();
    await delay(100);
    await settle();

    assert.deepEqual(
      server.lines().slice(before),
      [],
      'a drained refusal or its abort wrote a line',
    );
  });

  it('writes no line for /mcp calls a count refuses - a tool error, a 429 - and logs those it answers for their own reason', async () => {
    const address = '198.51.100.31';
    const server = logged({ sessionCreates: 1, apiCalls: 2 });
    const created = await call(server, toolCall(address, 'create_session', {}));

    assert.equal(created.response.statusCode, 200);
    createdSessionIds.push(
      created.response.json<{ result: { structuredContent: { sessionId: string } } }>().result
        .structuredContent.sessionId,
    );
    assertLogged(created.lines, 200, 'create_session let through');

    // Over the creations: a tool error naming the limit, the count's own
    // refusal in `/mcp`'s form (D203).
    const overCreations = await call(server, toolCall(address, 'create_session', {}));

    assert.equal(overCreations.response.statusCode, 200);
    assert.match(
      overCreations.response.json<{ result: { content: { text: string }[] } }>().result.content[0]
        ?.text ?? '',
      /^errorCode 1015 /,
    );
    assert.deepEqual(overCreations.lines, [], 'create_session refused wrote a line');

    for (let index = 1; index <= 2; index += 1) {
      assertLogged((await call(server, toolsList(address))).lines, 200, `tools/list ${index}`);
    }

    assertRefusedUnlogged(await call(server, toolsList(address)), 'tools/list over the calls');
    assertRefusedUnlogged(
      await call(server, {
        method: 'GET',
        url: `/api/sessions/${UNKNOWN_ID}`,
        remoteAddress: address,
      }),
      'the API, sharing the count',
    );

    // Answered for its own reason, then counted and found over: its answer
    // is not the count's refusal, and is logged.
    const notAcceptable = await call(
      server,
      mcpCall(address, { jsonrpc: '2.0', id: 1, method: 'ping' }, { accept: 'text/html' }),
    );
    const notAllowed = await call(server, { method: 'GET', url: '/mcp', remoteAddress: address });

    assert.equal(notAcceptable.response.statusCode, 406);
    assert.equal(notAcceptable.response.headers['x-ratelimit-remaining'], '0');
    assertLogged(notAcceptable.lines, 406, 'a 406 over the count');
    assert.equal(notAllowed.response.statusCode, 405);
    assert.equal(notAllowed.response.headers['x-ratelimit-remaining'], '0');
    assertLogged(notAllowed.lines, 405, 'a 405 over the count');
  });

  it('logs a 1017 and a 500 as before', async () => {
    // Every place of large bodies taken: a large body is refused `1017`
    // once its call has been counted and let through (D205).
    const busy = logged(
      { sessionCreates: 60, apiCalls: 100 },
      { largeBodyPlaces: createLargeBodyPlaces(0) },
    );
    const large = await call(busy, {
      method: 'POST',
      url: '/api/sessions',
      headers: JSON_TYPE,
      payload: JSON.stringify({ response: { status: 200, body: 'a'.repeat(200 * 1024) } }),
    });

    assert.equal(large.response.statusCode, 429);
    assert.equal(errorCodeOf(large.response), ErrorCode.LARGE_BODIES_BUSY);
    assertLogged(large.lines, 429, 'a 1017');

    // A database gone: every statement fails.
    const fail = async (): Promise<never> => {
      throw new Error('the database is gone');
    };
    const broken = logged({ sessionCreates: 60, apiCalls: 100 }, {}, {
      query: fail,
      connect: fail,
    } as unknown as pg.Pool);
    const failed = await call(broken, { method: 'GET', url: `/api/sessions/${UNKNOWN_ID}` });

    assert.equal(failed.response.statusCode, 500);
    assert.equal(errorCodeOf(failed.response), ErrorCode.INTERNAL_ERROR);
    assertLogged(failed.lines, 500, 'a 500', ['Unhandled error']);
  });

  it('writes no line for 100, 1,000 and 10,000 refusals in a row, nor for 500 pipelined on one connection', async () => {
    const server = logged({ sessionCreates: 1, apiCalls: 1_000_000 });

    assert.equal(
      (await call(server, { method: 'POST', url: '/api/sessions' })).response.statusCode,
      201,
    );

    for (const count of [100, 1_000, 10_000]) {
      const before = server.lines().length;

      for (let index = 0; index < count; index += 1) {
        const refused = await server.app.inject({ method: 'POST', url: '/api/sessions' });

        assert.equal(refused.statusCode, 429);
      }

      await settle();
      assert.equal(server.lines().length, before, `${count} refusals wrote lines`);

      // And the next call let through is logged whole, as the first was.
      assertLogged(
        (await call(server, { method: 'GET', url: `/api/sessions/${UNKNOWN_ID}` })).lines,
        404,
        `the read after ${count}`,
      );
    }

    // Pipelined on one connection kept alive, each answered in turn, then a
    // page no route has on the same connection.
    await server.app.listen({ host: '127.0.0.1', port: 0 });

    const before = server.lines().length;
    const socket = net.connect(portOf(server.app), '127.0.0.1');
    const received = readUntilClosed(socket);
    const refusal = 'POST /api/sessions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n';

    await once(socket, 'connect');
    socket.write(
      refusal.repeat(500) +
        'GET /no-such-page HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
    );

    const text = await received;

    assert.equal(text.match(/HTTP\/1\.1 429 /g)?.length, 500);
    assert.match(text, /HTTP\/1\.1 404 Not Found/);
    await settle();
    assertLogged(server.lines().slice(before), 404, 'the page after 500 refusals');
  });
});

describe('the request log of a call let through, while it waits (#222)', () => {
  /**
   * Starts `options`, a call held by `wait` on `sessionId`, and asserts that
   * its `incoming request`, the line whose URL is `url`, is in the log while
   * the call still waits - unanswered, no `request completed` of it, its wait
   * subscribed - as its count let it through, rather than held until its
   * answer; then clears the session, which ends the wait (D200), and asserts
   * the call's two lines whole. Answers the call's response.
   */
  async function assertLoggedWhileWaiting(
    server: Logged & { hub: RealtimeHub },
    sessionId: string,
    options: InjectOptions,
    url: string,
    what: string,
  ): Promise<Injected> {
    const before = server.lines().length;
    const since = () => server.lines().slice(before);
    let answered = false;
    const answer = server.app.inject(options).finally(() => {
      answered = true;
    });
    const incoming = await eventually(
      () => since().find((line) => line.msg === 'incoming request' && line.req?.url === url),
      2_000,
    );

    assert.ok(incoming?.reqId, `${what}: no incoming request while it waits`);

    const subscribed = await eventually(
      () => (server.hub.countFor(sessionId) > 0 ? true : undefined),
      2_000,
    );

    assert.equal(subscribed, true, `${what}: its wait never subscribed`);
    assert.equal(answered, false, `${what}: answered before anything ended its wait`);
    assert.deepEqual(
      since()
        .filter((line) => line.reqId === incoming.reqId)
        .map((line) => line.msg),
      ['incoming request'],
      `${what}: more than its incoming request while it waits`,
    );

    const cleared = await call(server, {
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/requests`,
    });

    assert.equal(cleared.response.statusCode, 204, cleared.response.body);

    const response = await answer;

    await settle();
    assert.equal(response.statusCode, 200, `${what}: ${response.body}`);
    assertLogged(
      since().filter((line) => line.reqId === incoming.reqId),
      200,
      what,
    );

    return response;
  }

  it('writes the incoming request of a list call held by wait while it waits, not at its answer', async () => {
    const server = await loggedWithWaits();
    const created = await call(server, { method: 'POST', url: '/api/sessions' });

    assert.equal(created.response.statusCode, 201);

    const sessionId = created.response.json<{ id: string }>().id;
    const url = `/api/sessions/${sessionId}/requests?wait=5`;
    const response = await assertLoggedWhileWaiting(
      server,
      sessionId,
      { method: 'GET', url },
      // The session id shortened, as in every line (D059).
      redactSessionIds(url),
      'a list held by wait',
    );

    assert.deepEqual(response.json(), []);
  });

  it("writes the incoming request of /mcp's wait_for_request while it waits, once its count has let it through", async () => {
    const server = await loggedWithWaits();
    const created = await call(server, { method: 'POST', url: '/api/sessions' });

    assert.equal(created.response.statusCode, 201);

    const sessionId = created.response.json<{ id: string }>().id;
    const response = await assertLoggedWhileWaiting(
      server,
      sessionId,
      toolCall('198.51.100.32', 'wait_for_request', { sessionId, wait: 5 }),
      '/mcp',
      'wait_for_request',
    );
    const { result } = response.json<{
      result: { isError?: boolean; structuredContent: { requests: unknown[] } };
    }>();

    assert.equal(result.isError, undefined, response.body);
    assert.deepEqual(result.structuredContent.requests, []);
  });
});
