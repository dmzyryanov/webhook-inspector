/**
 * The per-address limits of the API on a real listener (D201): 60 session
 * creations and 1200 other calls per minute, counted apart, reported in every
 * answer of a limited route and refused `429` / `1015` with `Retry-After`
 * before any database work; counted by address, an IPv6 one by its `/64`;
 * never applied to the receiver, the realtime connection or the probes; and
 * leaving no address in a log line or a statement.
 *
 * The limits run at their production numbers here. The window's clock is the
 * test's own, so "once `Retry-After` has passed" takes no minute.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { API_CALL_LIMIT, ErrorCode, SESSION_CREATE_LIMIT } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildServer, type ReceiverOptions, type ServerOptions } from '../../server.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import { PendingWaits } from '../requests/wait.ts';
import { DEFAULT_RATE_LIMITS, type RateLimitSettings } from './rate-limit.ts';

type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

const MALFORMED_ID = 'not-a-session-id';
const UNKNOWN_ID = 'z'.repeat(43);
const JSON_TYPE = { 'content-type': 'application/json' };

let pool: pg.Pool;
const createdSessionIds: string[] = [];
const servers: { close(): Promise<unknown> }[] = [];

/** Every statement and connection the application asked the pool for, in order. */
const statements: { text: string; values: unknown }[] = [];

/** The pool, recording every statement run through it and every connection taken from it. */
function recordingPool(base: pg.Pool): pg.Pool {
  return new Proxy(base, {
    get(target, property) {
      if (property === 'query') {
        return (...args: unknown[]) => {
          statements.push({ text: String(args[0]), values: args[1] });

          return (target.query as (...forwarded: unknown[]) => unknown)(...args);
        };
      }

      if (property === 'connect') {
        return async () => {
          statements.push({ text: '(connect)', values: undefined });

          const client = await target.connect();

          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty === 'query') {
                return (...args: unknown[]) => {
                  statements.push({ text: String(args[0]), values: args[1] });

                  return (clientTarget.query as (...forwarded: unknown[]) => unknown)(...args);
                };
              }

              const value = Reflect.get(clientTarget, clientProperty, clientTarget);

              return typeof value === 'function'
                ? (value as () => unknown).bind(clientTarget)
                : value;
            },
          });
        };
      }

      const value = Reflect.get(target, property, target);

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

function discard(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

/** A clock the test moves by hand. */
function manualClock(): { now: () => number; advance: (seconds: number) => void } {
  let time = 1_000;

  return {
    now: () => time,
    advance: (seconds) => {
      time += seconds * 1000;
    },
  };
}

/** The application listener with the production limits on `clock`, unless `limits` says otherwise. */
function listener(
  clock: { now: () => number },
  options: ServerOptions & { limits?: Omit<RateLimitSettings, 'now'> } = {},
): FastifyInstance {
  const { limits, ...rest } = options;
  const app = buildServer(recordingPool(pool), {
    logDestination: discard(),
    ...rest,
    rateLimits: { ...(limits ?? DEFAULT_RATE_LIMITS), now: clock.now },
  });

  servers.push(app);

  return app;
}

/** Both listeners, as the process runs them, with the limits on `clock`. */
function bothListeners(
  clock: { now: () => number },
  options: ServerOptions & ReceiverOptions & { limits?: Omit<RateLimitSettings, 'now'> } = {},
): TestServers {
  const { limits, ...rest } = options;
  const both = buildTestServers(recordingPool(pool), {
    logDestination: discard(),
    ...rest,
    rateLimits: { ...(limits ?? DEFAULT_RATE_LIMITS), now: clock.now },
  });

  servers.push(both);

  return both;
}

/** The three headers of a limited answer, or what is missing. */
function limitHeaders(response: Injected): { limit?: string; remaining?: string; reset?: string } {
  return {
    limit: response.headers['x-ratelimit-limit'] as string | undefined,
    remaining: response.headers['x-ratelimit-remaining'] as string | undefined,
    reset: response.headers['x-ratelimit-reset'] as string | undefined,
  };
}

function hasNoLimitHeader(headers: Record<string, unknown>, where: string): void {
  for (const name of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
    assert.equal(headers[name], undefined, `${where} carries ${name}`);
  }

  assert.equal(headers['retry-after'], undefined, `${where} carries retry-after`);
}

async function createOn(
  app: FastifyInstance,
  extra: Record<string, unknown> = {},
): Promise<Injected> {
  const response = await app.inject({ method: 'POST', url: '/api/sessions', ...extra });

  if (response.statusCode === 201) {
    createdSessionIds.push((response.json() as { id: string }).id);
  }

  return response;
}

// after() waits for before() to finish. Node's runner does not when a name
// pattern leaves this file no test, and what before() opens would outlive the
// run (#31, src/test-files-exit.test.ts).
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

describe('session creation: 60 per minute per address (D201)', () => {
  it('creates 60 within a minute and refuses the 61st with 429 / 1015 and Retry-After, creating nothing', async () => {
    const clock = manualClock();
    const app = listener(clock);

    for (let call = 1; call <= SESSION_CREATE_LIMIT; call += 1) {
      const created = await createOn(app);

      assert.equal(created.statusCode, 201, `creation ${call}`);
      assert.deepEqual(limitHeaders(created), {
        limit: '60',
        remaining: String(SESSION_CREATE_LIMIT - call),
        reset: '60',
      });
    }

    clock.advance(20);

    const statementsBefore = statements.length;
    const refused = await createOn(app);

    assert.equal(refused.statusCode, 429);
    assert.deepEqual(refused.json(), {
      errorCode: ErrorCode.RATE_LIMIT_EXCEEDED,
      message:
        'Rate limit exceeded: 60 session creations per minute per address; try again in 40 s',
    });
    assert.equal(ErrorCode.RATE_LIMIT_EXCEEDED, 1015);
    assert.equal(refused.headers['retry-after'], '40');
    assert.deepEqual(limitHeaders(refused), { limit: '60', remaining: '0', reset: '40' });

    // A custom session's body, and one over the size limit, are refused the
    // same way: the refusal comes before the body is read.
    const withBody = await createOn(app, {
      headers: JSON_TYPE,
      payload: JSON.stringify({ response: { status: 201 } }),
    });
    const oversized = await createOn(app, {
      headers: JSON_TYPE,
      payload: Buffer.alloc(2 * 1024 * 1024, 0x20),
    });

    for (const response of [withBody, oversized]) {
      assert.equal(response.statusCode, 429);
      assert.equal((response.json() as { errorCode: number }).errorCode, 1015);
    }

    // Before any database work: no statement, no connection, so no session.
    assert.equal(statements.length, statementsBefore);
  });

  it('creates again once Retry-After has passed', async () => {
    const clock = manualClock();
    const app = listener(clock);

    for (let call = 0; call < SESSION_CREATE_LIMIT; call += 1) {
      await createOn(app);
    }

    clock.advance(59);

    const refused = await createOn(app);

    assert.equal(refused.statusCode, 429);
    assert.equal(refused.headers['retry-after'], '1');

    clock.advance(Number(refused.headers['retry-after']));

    const again = await createOn(app);

    assert.equal(again.statusCode, 201);
    assert.deepEqual(limitHeaders(again), { limit: '60', remaining: '59', reset: '60' });
  });
});

describe('every other API call: 1200 per minute per address (D201)', () => {
  it('allows 1200 and refuses the next on every route but creation, which counts apart', async () => {
    const clock = manualClock();
    const app = listener(clock);

    for (let call = 1; call <= API_CALL_LIMIT; call += 1) {
      const response = await app.inject({ method: 'GET', url: `/api/sessions/${MALFORMED_ID}` });

      assert.equal(response.statusCode, 404);
      assert.equal(response.headers['x-ratelimit-remaining'], String(API_CALL_LIMIT - call));
    }

    const statementsBefore = statements.length;

    for (const [method, url] of [
      ['GET', `/api/sessions/${MALFORMED_ID}`],
      ['GET', `/api/sessions/${UNKNOWN_ID}`],
      ['GET', `/api/sessions/${UNKNOWN_ID}/requests?include=body`],
      ['DELETE', `/api/sessions/${UNKNOWN_ID}/requests`],
      ['DELETE', `/api/sessions/${UNKNOWN_ID}`],
      ['GET', '/api/no-such-route'],
    ] as const) {
      const refused = await app.inject({ method, url });

      assert.equal(refused.statusCode, 429, `${method} ${url}`);
      assert.equal((refused.json() as { errorCode: number }).errorCode, 1015);
      assert.match(refused.json<{ message: string }>().message, /1200 API calls per minute/);
      assert.equal(refused.headers['retry-after'], '60');
      assert.deepEqual(limitHeaders(refused), { limit: '1200', remaining: '0', reset: '60' });
    }

    for (const [url, payload] of [
      [`/api/sessions/${UNKNOWN_ID}/requests/query`, '{}'],
      [`/api/sessions/${UNKNOWN_ID}/requests/search`, '{"words":["abc"]}'],
      ['/api/sessions/status', JSON.stringify({ ids: [UNKNOWN_ID] })],
    ]) {
      const refused = await app.inject({ method: 'POST', url, headers: JSON_TYPE, payload });

      assert.equal(refused.statusCode, 429, url);
    }

    assert.equal(statements.length, statementsBefore, 'a refused call ran a statement');

    // Exhausting the calls leaves creation untouched.
    const created = await createOn(app);

    assert.equal(created.statusCode, 201);
    assert.deepEqual(limitHeaders(created), { limit: '60', remaining: '59', reset: '60' });
  });

  it('leaves the other calls untouched when creation is exhausted', async () => {
    const clock = manualClock();
    const app = listener(clock);

    for (let call = 0; call < SESSION_CREATE_LIMIT; call += 1) {
      await createOn(app);
    }

    assert.equal((await createOn(app)).statusCode, 429);

    const read = await app.inject({
      method: 'GET',
      url: `/api/sessions/${createdSessionIds.at(-1)}`,
    });

    assert.equal(read.statusCode, 200);
    assert.deepEqual(limitHeaders(read), { limit: '1200', remaining: '1199', reset: '60' });
  });
});

describe('the headers of a limited answer (D201)', () => {
  it('are on every answer of every limited route, errors included, and Remaining falls by one per call', async () => {
    const clock = manualClock();
    const app = listener(clock);
    let calls = 0;
    let creations = 0;

    const call = async (
      method: string,
      url: string,
      status: number,
      extra: Record<string, unknown> = {},
    ): Promise<Injected> => {
      const response = await app.inject({ method: method as 'GET', url, ...extra });
      const isCreate = method === 'POST' && url === '/api/sessions';

      if (isCreate) {
        creations += 1;
      } else {
        calls += 1;
      }

      assert.equal(response.statusCode, status, `${method} ${url} ${response.body.slice(0, 200)}`);
      assert.deepEqual(
        limitHeaders(response),
        isCreate
          ? { limit: '60', remaining: String(60 - creations), reset: '60' }
          : { limit: '1200', remaining: String(1200 - calls), reset: '60' },
        `${method} ${url}`,
      );

      return response;
    };

    const created = await call('POST', '/api/sessions', 201);
    const { id } = created.json() as { id: string };

    createdSessionIds.push(id);

    await call('POST', '/api/sessions', 400, { headers: JSON_TYPE, payload: '{"response":1}' });
    await call('POST', '/api/sessions', 415, {
      headers: { 'content-type': 'text/plain' },
      payload: 'x',
    });
    await call('POST', '/api/sessions', 413, {
      headers: JSON_TYPE,
      payload: Buffer.alloc(2 * 1024 * 1024, 0x20),
    });
    await call('GET', `/api/sessions/${id}`, 200);
    await call('HEAD', `/api/sessions/${id}`, 200);
    await call('GET', `/api/sessions/${UNKNOWN_ID}`, 404);
    await call('GET', `/api/sessions/${MALFORMED_ID}`, 404);
    // The router decodes the path, so this is the API too, and counts.
    await call('GET', `/%61pi/sessions/${MALFORMED_ID}`, 404);
    await call('GET', '/api/no-such-route', 404);
    await call('GET', '/api', 404);
    await call('PUT', `/api/sessions/${id}/response`, 200, {
      headers: JSON_TYPE,
      payload: '{"mode":"custom","response":{"status":202}}',
    });
    await call('PUT', `/api/sessions/${id}/response`, 400, {
      headers: JSON_TYPE,
      payload: '{"mode":"sideways"}',
    });
    // The response queue's three calls (D205).
    await call('PUT', `/api/sessions/${id}/queue`, 200, {
      headers: JSON_TYPE,
      payload: '{"steps":[{"status":503}]}',
    });
    await call('PUT', `/api/sessions/${id}/queue`, 400, {
      headers: JSON_TYPE,
      payload: '{"steps":[]}',
    });
    await call('POST', `/api/sessions/${id}/queue/restart`, 200);
    await call('DELETE', `/api/sessions/${id}/queue`, 200);
    await call('POST', '/api/sessions/status', 200, {
      headers: JSON_TYPE,
      payload: JSON.stringify({ ids: [id] }),
    });
    await call('POST', '/api/sessions/status', 400, { headers: JSON_TYPE, payload: '{"ids":[]}' });
    await call('GET', `/api/sessions/${id}/requests`, 200);
    await call('GET', `/api/sessions/${id}/requests?include=headers,body`, 200);
    await call('GET', `/api/sessions/${id}/requests?unknown=1`, 400);
    await call('GET', `/api/sessions/${id}/requests?wait=1`, 200);
    await call('POST', `/api/sessions/${id}/requests/query`, 200, {
      headers: JSON_TYPE,
      payload: '{"include":["body"]}',
    });
    await call('POST', `/api/sessions/${id}/requests/search`, 200, {
      headers: JSON_TYPE,
      payload: '{"words":["abc"]}',
    });
    await call('GET', `/api/sessions/${id}/requests/00000000-0000-4000-8000-000000000000`, 404);
    await call('DELETE', `/api/sessions/${id}/requests/00000000-0000-4000-8000-000000000000`, 404);
    await call('DELETE', `/api/sessions/${id}/requests`, 204);

    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      id,
    ]);
    await call('GET', `/api/sessions/${id}`, 410);
    await call('DELETE', `/api/sessions/${UNKNOWN_ID}`, 404);
    await call('QUERY', `/api/sessions/${id}`, 400);

    assert.deepEqual([creations, calls], [4, 27]);
  });
});

describe('the seconds a limited answer reports (D201)', () => {
  it('counts X-RateLimit-Reset when the answer is sent, for a call held by wait', async () => {
    const clock = manualClock();
    const waits = new PendingWaits();
    const app = listener(clock, { waits });
    const created = await createOn(app);
    const { id } = created.json() as { id: string };

    // Counted at once, with 60 s of its window left, and answered once its
    // wait of a second runs out, 30 s later on the window's clock.
    const held = app.inject({ method: 'GET', url: `/api/sessions/${id}/requests?wait=1` });
    const deadline = Date.now() + 5_000;

    while (waits.size === 0) {
      assert.ok(Date.now() < deadline, 'the call never waited');
      await delay(5);
    }

    clock.advance(30);

    const answered = await held;

    assert.equal(answered.statusCode, 200);
    assert.deepEqual(answered.json(), []);
    assert.deepEqual(limitHeaders(answered), { limit: '1200', remaining: '1199', reset: '30' });
  });

  it('counts Retry-After when a refusal is sent, after its body is drained', async () => {
    const clock = manualClock();
    const app = listener(clock, { limits: { sessionCreates: 1, apiCalls: API_CALL_LIMIT } });

    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    // The socket's peer and inject's are both 127.0.0.1: one address.
    assert.equal((await createOn(app)).statusCode, 201);

    // Refused on a connection Node closes after its answer, so its body is
    // drained before the refusal is sent; the body arrives 30 s later on the
    // window's clock.
    const socket = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];

    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    await once(socket, 'connect');
    socket.write(
      'POST /api/sessions HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n' +
        'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n',
    );
    await delay(200);
    clock.advance(30);
    socket.write('{}');
    await once(socket, 'close');

    const [head = '', body = ''] = Buffer.concat(chunks).toString('utf8').split('\r\n\r\n');

    assert.match(head, /^HTTP\/1\.1 429 /);
    assert.match(head, /\r\nretry-after: 30\r\n/i);
    assert.match(head, /\r\nx-ratelimit-reset: 30\r\n/i);
    assert.match(head, /\r\nx-ratelimit-remaining: 0\r\n/i);
    assert.deepEqual(JSON.parse(body), {
      errorCode: ErrorCode.RATE_LIMIT_EXCEEDED,
      message: 'Rate limit exceeded: 1 session creations per minute per address; try again in 30 s',
    });
  });
});

describe('the address a limit counts (D201)', () => {
  const small = { sessionCreates: 1, apiCalls: 2 };

  async function exhausts(
    app: FastifyInstance,
    remoteAddress: string,
    headers = {},
  ): Promise<boolean> {
    const responses: number[] = [];

    for (let call = 0; call < 3; call += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/sessions/${MALFORMED_ID}`,
        remoteAddress,
        headers,
      });

      responses.push(response.statusCode);
    }

    return responses.join() === '404,404,429';
  }

  it('counts two addresses apart', async () => {
    const app = listener(manualClock(), { limits: small });

    assert.ok(await exhausts(app, '198.51.100.1'));
    assert.ok(await exhausts(app, '198.51.100.2'), 'the second address was refused early');
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/sessions/${MALFORMED_ID}`,
          remoteAddress: '198.51.100.1',
        })
      ).statusCode,
      429,
    );
  });

  it('counts two IPv6 addresses of one /64 together, and of two /64s apart', async () => {
    const app = listener(manualClock(), { limits: small });
    const ask = (remoteAddress: string) =>
      app.inject({ method: 'GET', url: `/api/sessions/${MALFORMED_ID}`, remoteAddress });

    assert.equal((await ask('2001:db8:1:2::1')).statusCode, 404);
    assert.equal((await ask('2001:db8:1:2:ffff:ffff:ffff:fffe')).statusCode, 404);
    assert.equal((await ask('2001:db8:1:2::abcd')).statusCode, 429, 'the /64 shares one count');
    assert.equal((await ask('2001:db8:1:3::1')).statusCode, 404, 'another /64 counts apart');
    assert.equal((await ask('2001:db8:1:3::2')).statusCode, 404);
    assert.equal((await ask('2001:db8:1:3::3')).statusCode, 429);
    // An IPv4 sender on a dual-stack socket is its IPv4 address.
    assert.ok(await exhausts(app, '::ffff:203.0.113.9'));
    assert.equal((await ask('203.0.113.9')).statusCode, 429);
  });

  it('is not changed by an X-Forwarded-For an untrusted peer sends', async () => {
    const app = listener(manualClock(), { limits: small });
    const ask = (forwarded: string) =>
      app.inject({
        method: 'GET',
        url: `/api/sessions/${MALFORMED_ID}`,
        remoteAddress: '198.51.100.20',
        headers: { 'x-forwarded-for': forwarded },
      });

    assert.equal((await ask('203.0.113.1')).statusCode, 404);
    assert.equal((await ask('203.0.113.2')).statusCode, 404);
    assert.equal((await ask('203.0.113.3')).statusCode, 429);
  });

  it("is the client's address a trusted proxy forwards, never one forged before it", async () => {
    const app = listener(manualClock(), { limits: small, trustedProxyCidrs: ['10.42.0.0/24'] });
    const ask = (forwarded: string) =>
      app.inject({
        method: 'GET',
        url: `/api/sessions/${MALFORMED_ID}`,
        remoteAddress: '10.42.0.7',
        headers: { 'x-forwarded-for': forwarded },
      });

    assert.equal((await ask('203.0.113.1')).statusCode, 404);
    // A value the client wrote itself stands on the left, and is skipped.
    assert.equal((await ask('198.51.100.99, 203.0.113.1')).statusCode, 404);
    assert.equal((await ask('198.51.100.98, 203.0.113.1')).statusCode, 429);
    assert.equal((await ask('203.0.113.2')).statusCode, 404, 'another client counts apart');
  });
});

describe('what the limits never touch (D201)', () => {
  it('captures more than 1200 webhooks a minute from one address, every one answered and stored', async () => {
    const clock = manualClock();
    const both = bothListeners(clock);

    await both.ready();

    const custom = await createOn(both.api, {
      headers: JSON_TYPE,
      payload: JSON.stringify({
        response: { status: 202, body: 'accepted', headers: [['x-mock', '1']] },
      }),
    });
    const plain = await createOn(both.api);
    const sessions = [(custom.json() as { id: string }).id, (plain.json() as { id: string }).id];
    const captures = API_CALL_LIMIT + 1;
    const answered = [0, 0];

    // Twenty at a time, all from the one address inject uses.
    for (let start = 0; start < captures; start += 20) {
      const batch = Array.from({ length: Math.min(20, captures - start) }, (_, offset) => {
        const index = (start + offset) % 2;

        return both.receiver
          .inject({
            method: 'POST',
            url: `/s/${sessions[index]}`,
            headers: { 'content-type': 'text/plain' },
            payload: `capture ${start + offset}`,
          })
          .then((response) => ({ index, response }));
      });

      for (const { index, response } of await Promise.all(batch)) {
        if (index === 0) {
          assert.equal(response.statusCode, 202);
          assert.equal(response.body, 'accepted');
          assert.equal(response.headers['x-mock'], '1');
        } else {
          assert.equal(response.statusCode, 200);
        }

        assert.ok(response.headers['x-qa-tools-request-id'], 'a capture without its id');
        hasNoLimitHeader(response.headers, 'a capture');
        answered[index] = (answered[index] ?? 0) + 1;
      }
    }

    assert.deepEqual(answered, [601, 600]);

    for (const [index, id] of sessions.entries()) {
      const read = await both.api.inject({ method: 'GET', url: `/api/sessions/${id}` });

      assert.equal((read.json() as { requestsCount: number }).requestsCount, answered[index]);
    }
  });

  it('never refuses or counts /ws, /healthz, /readyz or /s/ on the application listener', async () => {
    const clock = manualClock();
    const app = listener(clock, { limits: { sessionCreates: 1, apiCalls: 1 } });

    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const created = await createOn(app);
    const { id } = created.json() as { id: string };

    assert.equal((await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).statusCode, 429);
    assert.equal((await createOn(app)).statusCode, 429);

    for (let round = 0; round < 3; round += 1) {
      for (const url of ['/healthz', '/readyz']) {
        const probe = await fetch(`http://127.0.0.1:${port}${url}`);

        assert.equal(probe.status, 200, url);
        hasNoLimitHeader(Object.fromEntries(probe.headers), url);
      }

      const moved = await fetch(`http://127.0.0.1:${port}/s/${id}`, { method: 'POST', body: 'x' });

      assert.equal(moved.status, 410);
      assert.equal(((await moved.json()) as { errorCode: number }).errorCode, 1009);
      hasNoLimitHeader(Object.fromEntries(moved.headers), '/s/');

      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}`);
      const [message] = (await once(socket, 'message')) as [MessageEvent];

      assert.deepEqual(JSON.parse(String(message.data)), { type: 'ready' });
      socket.close();
      await once(socket, 'close');
    }

    // Still refused: none of the above counted, and none was refused.
    assert.equal((await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).statusCode, 429);
  });
});

describe('what the limits leave behind (D201)', () => {
  it("writes the client's address in no log line and no statement", async () => {
    const address = '198.51.100.73';
    let log = '';
    const clock = manualClock();
    const app = buildServer(recordingPool(pool), {
      logDestination: new Writable({
        write(chunk: Buffer | string, _encoding, callback) {
          log += chunk.toString();
          callback();
        },
      }),
      trustedProxyCidrs: ['10.42.0.0/24'],
      rateLimits: { sessionCreates: 1, apiCalls: 2, now: clock.now },
    });

    servers.push(app);

    const statementsBefore = statements.length;
    const from = { remoteAddress: '10.42.0.7', headers: { 'x-forwarded-for': address } };
    const answers: number[] = [];

    for (const request of [
      { method: 'POST', url: '/api/sessions' },
      { method: 'POST', url: '/api/sessions' },
      {
        method: 'POST',
        url: '/api/sessions',
        headers: { ...from.headers, ...JSON_TYPE },
        payload: '{"response":{"status":201}}',
      },
      { method: 'GET', url: `/api/sessions/${UNKNOWN_ID}` },
      { method: 'GET', url: `/api/sessions/${UNKNOWN_ID}/requests` },
      { method: 'GET', url: `/api/sessions/${UNKNOWN_ID}/requests` },
    ] as const) {
      const response = await app.inject({ ...from, ...request });

      answers.push(response.statusCode);

      if (response.statusCode === 201) {
        createdSessionIds.push((response.json() as { id: string }).id);
      }
    }

    assert.deepEqual(answers, [201, 429, 429, 404, 404, 429]);
    assert.match(log, /request completed/, 'the log was not captured');
    assert.ok(!log.includes(address), 'a log line holds the address');
    assert.ok(
      !JSON.stringify(statements.slice(statementsBefore)).includes(address),
      'a statement holds the address',
    );
  });
});
