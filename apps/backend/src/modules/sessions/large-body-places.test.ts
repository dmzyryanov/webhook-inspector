/**
 * The cap on large queue-bearing bodies on a real listener (D205): eight at
 * once across `PUT /api/sessions/:sessionId/queue` and `POST /api/sessions`,
 * the next refused `429` / `1017` with `Retry-After` at once, before its body
 * is read; small bodies, a body declared over 1 MiB, a wrong media type and a
 * creation over its address's limit never taking a place; and a place given
 * back on every way a call ends - an answer, a refusal by the body's checks,
 * an unknown session, a chunked body over 1 MiB, a failure, and a client gone
 * in the middle of its body - but not while a handler still holds a body read
 * whole, its client gone or not: handlers held behind the sessions' row locks
 * keep their places until they settle.
 *
 * A large body is held "being handled" by sending its headers and the first
 * KiB of it and holding the rest: the place is taken once the headers have
 * arrived.
 *
 * The listener keeps the gate in front of the API's work at its three slots
 * (D244): the eight handlers waiting behind the row locks hold none, since a
 * change gives its slot back before its turn of the session's line, and the
 * gate's own tests are `api-work*.test.ts`.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import {
  ErrorCode,
  LARGE_BODY_THRESHOLD_BYTES,
  MAX_BODY_BYTES,
  type SessionDetails,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { ordinaryFullResponse } from '../../testing/full-queue.ts';
import { ordinaryFullRules, ordinaryRules } from '../../testing/full-rules.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import { buildServer } from '../../server.ts';
import { createLargeBodyPlaces, type LargeBodyPlaces } from './large-bodies.ts';

const UNKNOWN_SESSION_ID = 'z'.repeat(43);
const JSON_TYPE = { 'content-type': 'application/json' };

/** Ten steps of 20,000 bytes of text each: about 200 KB, a large body. */
const STEPS = Array.from({ length: 10 }, (_, index) => ({
  status: 500 + index,
  body: 'q'.repeat(20_000),
}));
const LARGE_QUEUE = JSON.stringify({ steps: STEPS });
const LARGE_CREATION = JSON.stringify({ response: { status: 202 }, queue: { steps: STEPS } });

/** The listener's places, with the times a place was asked for counted. */
const inner = createLargeBodyPlaces();
let asked = 0;
const places: LargeBodyPlaces = {
  tryTake() {
    asked += 1;

    return inner.tryTake();
  },
  get taken() {
    return inner.taken;
  },
};

let pool: pg.Pool;
let servers: TestServers;
let port: number;
/** Responses of the listener closed so far: answered, or their connection gone. */
let responsesClosed = 0;
const createdSessionIds: string[] = [];

/** While set, every statement and connection the routes ask for fails. */
let failing = false;

function failingPool(base: pg.Pool): pg.Pool {
  return new Proxy(base, {
    get(target, property) {
      if (property === 'connect' || property === 'query') {
        return (...args: unknown[]) =>
          failing
            ? Promise.reject(new Error('the database went away'))
            : (Reflect.get(target, property, target) as (...a: unknown[]) => unknown).apply(
                target,
                args,
              );
      }

      const value = Reflect.get(target, property, target);

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

const quiet = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

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
  servers = buildTestServers(failingPool(pool), {
    logDestination: quiet(),
    largeBodyPlaces: places,
  });
  await servers.receiver.ready();
  servers.api.server.on(
    'request',
    (_request: http.IncomingMessage, response: http.ServerResponse) => {
      response.once('close', () => {
        responsesClosed += 1;
      });
    },
  );
  await servers.api.listen({ host: '127.0.0.1', port: 0 });
  port = (servers.api.server.address() as AddressInfo).port;
}

after(async () => {
  await startup?.catch(() => undefined);
  failing = false;

  // A call a failed test left holding its body would keep the listener's
  // close waiting.
  for (const call of calls) {
    call.abort();
  }

  await servers?.close();

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await pool?.end();
});

async function createSession(): Promise<string> {
  const response = await servers.api.inject({ method: 'POST', url: '/api/sessions' });

  assert.equal(response.statusCode, 201);

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
  /** Sends the rest of the body. */
  finish: (rest?: Buffer | string) => void;
  /** Closes the connection, as a client that goes away does. */
  abort: () => void;
}

interface SendOptions {
  /** Send the headers and the first KiB, and hold the rest until `finish`. */
  hold?: boolean;
  /** No `Content-Length`: the body is sent chunked. */
  chunked?: boolean;
  /** Keep the connection alive, so a refusal is answered without the body being read. */
  keepAlive?: boolean;
  headers?: Record<string, string>;
}

/** Every call made, so that none outlives the file. */
const calls: Call[] = [];

/** One call over its own connection. */
function send(
  method: 'POST' | 'PUT',
  path: string,
  body: string,
  { hold = false, chunked = false, keepAlive = false, headers = JSON_TYPE }: SendOptions = {},
): Call {
  const payload = Buffer.from(body);
  const agent = keepAlive ? new http.Agent({ keepAlive: true }) : false;
  const request = http.request({
    host: '127.0.0.1',
    port,
    path,
    method,
    agent,
    headers: chunked ? headers : { ...headers, 'content-length': String(payload.length) },
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

        if (agent) {
          agent.destroy();
        }
      });
      response.on('error', reject);
    });
    request.on('error', reject);
  });

  answered.catch(() => undefined);

  if (hold) {
    request.flushHeaders();
    request.write(payload.subarray(0, 1024));
  } else {
    request.end(payload);
  }

  const call: Call = {
    answered,
    finish: (rest = payload.subarray(1024)) => {
      request.end(rest);
    },
    abort: () => {
      request.destroy();

      if (agent) {
        agent.destroy();
      }
    },
  };

  calls.push(call);

  return call;
}

/** Waits until `check` holds, for 5 s at most. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
    await delay(5);
  }
}

/** Waits until `check` answers true, for 5 s at most. */
async function untilAnswered(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
    await delay(5);
  }
}

/** How many backends wait for a lock one of `holders` holds. */
async function waitingFor(holders: number[]): Promise<number> {
  const result = await pool.query<{ waiting: number }>(
    'SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE pg_blocking_pids(pid) && $1::int[]',
    [holders],
  );

  return result.rows[0]?.waiting ?? 0;
}

/** A large save held after its first KiB, once it holds its place. */
async function holdSave(sessionId: string, body = LARGE_QUEUE, chunked = false): Promise<Call> {
  const before = places.taken;
  const call = send('PUT', `/api/sessions/${sessionId}/queue`, body, { hold: true, chunked });

  await until(() => places.taken === before + 1, 'the save holds a place');

  return call;
}

async function refusedAtOnce(call: Call, limit: string): Promise<void> {
  const started = Date.now();
  const { status, headers, body } = await call.answered;

  assert.equal(status, 429, body);
  assert.equal(headers['retry-after'], '1');
  // A limited route: its rate-limit headers are there too (D201).
  assert.equal(headers['x-ratelimit-limit'], limit);
  assert.ok(headers['x-ratelimit-remaining'] !== undefined);
  assert.ok(headers['x-ratelimit-reset'] !== undefined);
  assert.deepEqual(JSON.parse(body), {
    errorCode: ErrorCode.LARGE_BODIES_BUSY,
    message: 'Too many large bodies are being saved; try again in a moment',
  });
  assert.ok(Date.now() - started < 1_000, 'the refusal was not at once');
}

async function queueOf(sessionId: string): Promise<SessionDetails['queue']> {
  const response = await servers.api.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });

  assert.equal(response.statusCode, 200);

  return (response.json() as SessionDetails).queue;
}

describe('eight large bodies at once (D205)', () => {
  it('refuses the next on either route at once, before its body is read, and writes nothing', async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => createSession()));
    const held: Call[] = [];

    for (const id of ids.slice(0, 4)) {
      held.push(await holdSave(id));
    }

    for (let index = 0; index < 4; index += 1) {
      held.push(send('POST', '/api/sessions', LARGE_CREATION, { hold: true }));
    }

    await until(() => places.taken === 8, 'eight large bodies hold a place');

    // A save whose body has not been sent, on a connection kept alive: it is
    // answered without its body being read.
    const unsent = send('PUT', `/api/sessions/${ids[4]}/queue`, LARGE_QUEUE, {
      hold: true,
      keepAlive: true,
    });

    await refusedAtOnce(unsent, '1200');
    unsent.abort();

    // A creation and a chunked save sent whole on a connection that closes:
    // the body is drained, and the refusal arrives (D143).
    await refusedAtOnce(send('POST', '/api/sessions', LARGE_CREATION), '60');
    await refusedAtOnce(
      send('PUT', `/api/sessions/${ids[4]}/queue`, LARGE_QUEUE, { chunked: true }),
      '1200',
    );
    assert.equal(await queueOf(ids[4] as string), null);
    assert.equal(places.taken, 8);

    const answers = await Promise.all(
      held.map((call) => {
        call.finish();

        return call.answered;
      }),
    );

    assert.deepEqual(
      answers.map((answer) => answer.status),
      [200, 200, 200, 200, 201, 201, 201, 201],
    );

    for (const answer of answers.slice(4)) {
      createdSessionIds.push((JSON.parse(answer.body) as { id: string }).id);
    }

    await until(() => places.taken === 0, 'every place is given back');

    // Accepted again once places are free.
    const again = await send('PUT', `/api/sessions/${ids[4]}/queue`, LARGE_QUEUE).answered;

    assert.equal(again.status, 200);
    assert.equal((await queueOf(ids[4] as string))?.total, 10);
  });

  it('never refuses a small body, a body over 1 MiB, a wrong media type or a creation over its limit', async () => {
    const id = await createSession();
    const held: Call[] = [];

    for (let index = 0; index < 8; index += 1) {
      held.push(await holdSave(await createSession()));
    }

    const askedBefore = asked;

    assert.equal(places.taken, 8);

    // No body, a response alone at every limit of D101, a queue of one step.
    const bare = await servers.api.inject({ method: 'POST', url: '/api/sessions' });
    const withResponse = await send(
      'POST',
      '/api/sessions',
      JSON.stringify({ response: ordinaryFullResponse() }),
    ).answered;
    const smallQueue = await send(
      'PUT',
      `/api/sessions/${id}/queue`,
      JSON.stringify({ steps: [ordinaryFullResponse()] }),
    ).answered;

    assert.equal(bare.statusCode, 201);
    assert.equal(withResponse.status, 201);
    assert.equal(smallQueue.status, 200);
    createdSessionIds.push(
      (bare.json() as { id: string }).id,
      (JSON.parse(withResponse.body) as { id: string }).id,
    );

    // A body exactly at the threshold.
    const atThreshold = JSON.stringify({ steps: [{ status: 418 }] });
    const padded = atThreshold + ' '.repeat(LARGE_BODY_THRESHOLD_BYTES - atThreshold.length);

    assert.equal((await send('PUT', `/api/sessions/${id}/queue`, padded).answered).status, 200);

    // Over 1 MiB: refused before it is read, as before. Not JSON: 415.
    const oversized = await servers.api.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/queue`,
      headers: JSON_TYPE,
      payload: Buffer.alloc(MAX_BODY_BYTES + 1, 0x20),
    });
    const wrongType = await servers.api.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'text/plain' },
      payload: LARGE_CREATION,
    });

    assert.equal(oversized.statusCode, 413);
    assert.equal((oversized.json() as { errorCode: number }).errorCode, 1004);
    assert.equal(wrongType.statusCode, 415);
    assert.equal(asked, askedBefore, 'a place was asked for');

    await Promise.all(
      held.map((call) => {
        call.finish();

        return call.answered;
      }),
    );
    await until(() => places.taken === 0, 'every place is given back');

    // A creation refused by its address's limit takes no place: the limit's
    // hook runs before the route's (D201).
    let ownAsked = 0;
    const own = createLargeBodyPlaces(1);
    const limited = buildServer(failingPool(pool), {
      logDestination: quiet(),
      rateLimits: { sessionCreates: 1, apiCalls: 1200 },
      largeBodyPlaces: {
        tryTake() {
          ownAsked += 1;

          return own.tryTake();
        },
        get taken() {
          return own.taken;
        },
      },
    });

    try {
      const first = await limited.inject({ method: 'POST', url: '/api/sessions' });

      createdSessionIds.push((first.json() as { id: string }).id);

      const second = await limited.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: JSON_TYPE,
        payload: LARGE_CREATION,
      });

      assert.equal(second.statusCode, 429);
      assert.equal((second.json() as { errorCode: number }).errorCode, 1015);
      assert.equal(ownAsked, 0);
    } finally {
      await limited.close();
    }
  });
});

describe('a place given back on every way a call ends (D205)', () => {
  it('an answer: a save 200, a creation 201', async () => {
    const id = await createSession();
    const save = await holdSave(id);

    save.finish();
    assert.equal((await save.answered).status, 200);
    await until(() => places.taken === 0, 'the save gives its place back');

    const creation = send('POST', '/api/sessions', LARGE_CREATION, { hold: true });

    await until(() => places.taken === 1, 'the creation holds a place');
    creation.finish();

    const created = await creation.answered;

    assert.equal(created.status, 201);
    createdSessionIds.push((JSON.parse(created.body) as { id: string }).id);
    await until(() => places.taken === 0, 'the creation gives its place back');
  });

  it('a refusal by the body’s checks: 400 / 1005 and 400 / 1006', async () => {
    const id = await createSession();
    const invalid = JSON.stringify({ steps: [...STEPS.slice(1), { status: 99 }] });
    const malformed = '{' + 'x'.repeat(200_000);

    for (const [body, code] of [
      [invalid, 1005],
      [malformed, 1006],
    ] as const) {
      const save = await holdSave(id, body);

      save.finish();

      const answer = await save.answered;

      assert.equal(answer.status, 400);
      assert.equal((JSON.parse(answer.body) as { errorCode: number }).errorCode, code);
      await until(() => places.taken === 0, `the place of a ${code} is given back`);
    }

    assert.equal(await queueOf(id), null);
  });

  it('an unknown session: 404 / 1001', async () => {
    const save = await holdSave(UNKNOWN_SESSION_ID);

    save.finish();
    assert.equal((await save.answered).status, 404);
    await until(() => places.taken === 0, 'the place of a 404 is given back');
  });

  it('a chunked body over 1 MiB: 413 / 1004', async () => {
    const id = await createSession();
    const save = await holdSave(id, LARGE_QUEUE, true);

    save.finish(Buffer.alloc(MAX_BODY_BYTES, 0x20));

    const answer = await save.answered;

    assert.equal(answer.status, 413);
    assert.equal((JSON.parse(answer.body) as { errorCode: number }).errorCode, 1004);
    await until(() => places.taken === 0, 'the place of a 413 is given back');
  });

  it('a failure: 500 / 1500', async () => {
    const id = await createSession();
    const save = await holdSave(id);

    failing = true;

    try {
      save.finish();

      const answer = await save.answered;

      assert.equal(answer.status, 500);
      assert.equal((JSON.parse(answer.body) as { errorCode: number }).errorCode, 1500);
    } finally {
      failing = false;
    }

    await until(() => places.taken === 0, 'the place of a 500 is given back');
  });

  it('a client gone in the middle of its body, on either route', async () => {
    const id = await createSession();
    const save = await holdSave(id);
    const creation = send('POST', '/api/sessions', LARGE_CREATION, { hold: true });

    await until(() => places.taken === 2, 'both hold a place');
    save.abort();
    creation.abort();
    await until(() => places.taken === 0, 'the places of the calls gone are given back');
    assert.equal(await queueOf(id), null);
  });
});

/**
 * Whole large bodies sent, their handlers waiting for the sessions' row locks
 * with the parsed queues in hand, as they wait behind a capture or a change,
 * and the clients gone. A place given back on the close alone let the next
 * bodies in while those were still held; it is now held until the handler
 * settles.
 */
describe('a place held while the handler holds the body (D205)', () => {
  it('stays taken after the client goes until the handler settles, and the ninth is refused meanwhile', async () => {
    const ids = await Promise.all(Array.from({ length: 9 }, () => createSession()));
    const { databaseUrl } = loadConfig();
    // Two transactions of their own hold the rows of eight sessions: one the
    // first session's, the other the next seven.
    const one = new pg.Client({ connectionString: databaseUrl });
    const seven = new pg.Client({ connectionString: databaseUrl });
    const holders: number[] = [];

    await one.connect();
    await seven.connect();

    try {
      for (const [client, held] of [
        [one, ids.slice(0, 1)],
        [seven, ids.slice(1, 8)],
      ] as const) {
        await client.query('BEGIN');
        await client.query('SELECT id FROM sessions WHERE id = ANY($1) FOR UPDATE', [held]);

        const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

        holders.push(backend.rows[0]?.pid as number);
      }

      const closedBefore = responsesClosed;
      const saves = ids
        .slice(0, 8)
        .map((id) => send('PUT', `/api/sessions/${id}/queue`, LARGE_QUEUE));

      // Every body read whole and parsed: the eight handlers wait for the locks.
      await untilAnswered(
        async () => (await waitingFor(holders)) === 8,
        'eight saves wait for the locks',
      );
      assert.equal(places.taken, 8);

      for (const save of saves) {
        save.abort();
      }

      await until(
        () => responsesClosed === closedBefore + 8,
        'the listener sees the eight connections close',
      );
      assert.equal(await waitingFor(holders), 8, 'a handler stopped waiting');
      assert.equal(places.taken, 8, 'a place went while its handler held the body');

      // The ninth large body, on either route, is refused before it is read.
      await refusedAtOnce(send('PUT', `/api/sessions/${ids[8]}/queue`, LARGE_QUEUE), '1200');
      await refusedAtOnce(send('POST', '/api/sessions', LARGE_CREATION), '60');
      assert.equal(await queueOf(ids[8] as string), null);

      // One handler settles: its place comes back, and the next is taken.
      await one.query('COMMIT');
      await until(() => places.taken === 7, 'the settled handler gives its place back');

      const next = await send('PUT', `/api/sessions/${ids[8]}/queue`, LARGE_QUEUE).answered;

      assert.equal(next.status, 200);
      assert.equal(places.taken, 7);

      await seven.query('COMMIT');
      await until(() => places.taken === 0, 'every place is given back');

      // The handlers of the clients gone ran to their end: each queue is saved.
      for (const id of ids) {
        assert.equal((await queueOf(id))?.total, 10);
      }
    } finally {
      // A failed test must not leave the handlers waiting for the locks.
      for (const client of [one, seven]) {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    }
  });
});

/**
 * The four routes that take the places since D213: a response change, a
 * status read, a search and a query. A body over 128 KiB, or chunked, takes
 * one; an ordinary one never does.
 */
describe('the places of large bodies on four more routes (D213)', () => {
  /** A body over the threshold: valid JSON padded with white space. */
  function padded(json: string): string {
    return json + ' '.repeat(LARGE_BODY_THRESHOLD_BYTES + 1024 - json.length);
  }

  it('take one for a body over 128 KiB on each, refuse the ninth at once, and take none for an ordinary body', async () => {
    const id = await createSession();
    const routes = [
      {
        method: 'PUT',
        path: `/api/sessions/${id}/response`,
        large: padded('{"mode":"default"}'),
        ordinary: JSON.stringify({ mode: 'custom', response: ordinaryFullResponse() }),
      },
      {
        method: 'POST',
        path: '/api/sessions/status',
        large: padded(JSON.stringify({ ids: [id] })),
        ordinary: JSON.stringify({
          ids: Array.from(
            { length: 50 },
            (_, index) => `${id.slice(0, 41)}${String(index).padStart(2, '0')}`,
          ),
        }),
      },
      {
        method: 'POST',
        path: `/api/sessions/${id}/requests/search`,
        large: padded('{"words":["abc"]}'),
        ordinary: '{"words":["abc","def","ghi"]}',
      },
      {
        method: 'POST',
        path: `/api/sessions/${id}/requests/query`,
        large: padded('{"include":["headers"]}'),
        ordinary: '{"headers":[{"name":"x-event","value":"order.paid"}]}',
      },
    ] as const;
    const held: Call[] = [];

    for (const route of routes) {
      for (let copy = 0; copy < 2; copy += 1) {
        const before = places.taken;

        held.push(send(route.method, route.path, route.large, { hold: true }));
        await until(() => places.taken === before + 1, `${route.path} holds a place`);
      }
    }

    assert.equal(places.taken, 8);

    const askedBefore = asked;

    for (const route of routes) {
      // The ninth, whole or chunked, is refused before its body is read: a
      // chunked body of two bytes, whose headers declare no length, as well.
      await refusedAtOnce(send(route.method, route.path, route.large), '1200');

      const chunked = send(route.method, route.path, '{}', { chunked: true, hold: true });

      await refusedAtOnce(chunked, '1200');
      chunked.abort();

      // An ordinary body is answered with every place taken, asking for none.
      const before = asked;
      const ordinary = await send(route.method, route.path, route.ordinary).answered;

      assert.equal(ordinary.status, 200, `${route.path}: ${ordinary.body}`);
      assert.equal(asked, before, `${route.path}: an ordinary body asked for a place`);
    }

    assert.equal(asked - askedBefore, 8, 'only the refused large bodies asked');
    assert.equal(places.taken, 8);

    // One at a time, so that none meets a count already taken, whatever its
    // size: the searches take the search's places (D191), and the queries,
    // which have no body condition, those of the queries without one (D250).
    for (const call of held) {
      call.finish();

      const answer = await call.answered;

      assert.equal(answer.status, 200, answer.body.slice(0, 200));
    }

    await until(() => places.taken === 0, 'every place is given back');
  });

  it('keep the place of a response change while its handler waits for the row lock, its client gone', async () => {
    const id = await createSession();
    const { databaseUrl } = loadConfig();
    const holder = new pg.Client({ connectionString: databaseUrl });

    await holder.connect();

    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [id]);

      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid as number;
      const change = send('PUT', `/api/sessions/${id}/response`, padded('{"mode":"default"}'));

      await untilAnswered(
        async () => (await waitingFor([pid])) === 1,
        'the change waits for the lock',
      );
      assert.equal(places.taken, 1);
      change.abort();
      await delay(200);
      assert.equal(places.taken, 1, 'the place went while the handler waited');

      await holder.query('COMMIT');
      await until(() => places.taken === 0, 'the settled handler gives its place back');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  });
});

/**
 * `PUT /api/sessions/:sessionId/rules` takes the places too, the eighth route
 * to (D246): a body over 128 KiB - two rules at every limit of D101 are about
 * 144 KiB - or chunked, takes one; twenty rules of ordinary responses, about
 * 44 KiB, never do.
 */
describe('the places of large bodies on PUT .../rules (D246)', () => {
  it('takes one for a body over 128 KiB, refuses the ninth at once, and takes none for ordinary rules', async () => {
    const id = await createSession();
    const path = `/api/sessions/${id}/rules`;
    const large = JSON.stringify({ rules: ordinaryFullRules(2) });
    const ordinary = JSON.stringify({ rules: ordinaryRules() });

    assert.ok(Buffer.byteLength(large) > LARGE_BODY_THRESHOLD_BYTES);
    assert.ok(Buffer.byteLength(ordinary) < LARGE_BODY_THRESHOLD_BYTES);

    const held: Call[] = [];

    for (let copy = 0; copy < 8; copy += 1) {
      const before = places.taken;

      held.push(send('PUT', path, large, { hold: true }));
      await until(() => places.taken === before + 1, 'a rules save holds a place');
    }

    assert.equal(places.taken, 8);

    // The ninth, whole or chunked, is refused before its body is read.
    await refusedAtOnce(send('PUT', path, large), '1200');

    const chunked = send('PUT', path, '{}', { chunked: true, hold: true });

    await refusedAtOnce(chunked, '1200');
    chunked.abort();

    // Ordinary rules are saved with every place taken, asking for none.
    const asking = asked;
    const saved = await send('PUT', path, ordinary).answered;

    assert.equal(saved.status, 200, saved.body.slice(0, 200));
    assert.equal(asked, asking, 'ordinary rules asked for a place');

    for (const call of held) {
      call.finish();

      const answer = await call.answered;

      assert.equal(answer.status, 200, answer.body.slice(0, 200));
    }

    await until(() => places.taken === 0, 'every place is given back');
  });
});

/**
 * `POST /mcp` takes the places too (D213): its body is held whole while it
 * arrives, up to 1 MiB, and one address may have 128 calls in flight. The place
 * goes back once the message is read and checked, which takes the body off the
 * request, so a `wait_for_request` waits without one.
 */
describe('the places of large bodies on POST /mcp (D213)', () => {
  const MCP_HEADERS = {
    ...JSON_TYPE,
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  };

  /** `message` as JSON padded with white space past the threshold. */
  function paddedMessage(message: Record<string, unknown>): string {
    const json = JSON.stringify({ jsonrpc: '2.0', ...message });

    return json + ' '.repeat(LARGE_BODY_THRESHOLD_BYTES + 1024 - json.length);
  }

  const PING = { id: 1, method: 'ping' };

  async function refusedOnMcp(call: Call): Promise<void> {
    const started = Date.now();
    const { status, headers, body } = await call.answered;

    assert.equal(status, 429, body);
    assert.equal(headers['retry-after'], '1');
    assert.equal(headers['x-ratelimit-limit'], '1200');
    assert.deepEqual(JSON.parse(body), {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: 'Too many large bodies are being saved; try again in a moment',
        data: { errorCode: ErrorCode.LARGE_BODIES_BUSY, retryAfter: 1 },
      },
    });
    assert.ok(Date.now() - started < 1_000, 'the refusal was not at once');
  }

  it('takes one for a body over 128 KiB, refuses the ninth 429 / 1017 in JSON-RPC form, and takes none for an ordinary message', async () => {
    const id = await createSession();
    const held: Call[] = [];

    for (let copy = 0; copy < 8; copy += 1) {
      const before = places.taken;

      held.push(send('POST', '/mcp', paddedMessage(PING), { hold: true, headers: MCP_HEADERS }));
      await until(() => places.taken === before + 1, '/mcp holds a place');
    }

    const askedBefore = asked;

    // The ninth, whole or chunked, on /mcp and on the API alike: one count.
    await refusedOnMcp(send('POST', '/mcp', paddedMessage(PING), { headers: MCP_HEADERS }));

    const chunked = send('POST', '/mcp', JSON.stringify({ jsonrpc: '2.0', ...PING }), {
      chunked: true,
      hold: true,
      headers: MCP_HEADERS,
    });

    await refusedOnMcp(chunked);
    chunked.abort();
    await refusedAtOnce(send('PUT', `/api/sessions/${id}/queue`, LARGE_QUEUE), '1200');

    // An ordinary message is answered with every place taken, asking for none.
    const ordinary = await send('POST', '/mcp', JSON.stringify({ jsonrpc: '2.0', ...PING }), {
      headers: MCP_HEADERS,
    }).answered;

    assert.equal(ordinary.status, 200, ordinary.body);
    assert.equal(asked - askedBefore, 3, 'only the refused large bodies asked');

    for (const call of held) {
      call.finish();

      const answer = await call.answered;

      assert.equal(answer.status, 200, answer.body.slice(0, 200));
      assert.deepEqual(JSON.parse(answer.body), { jsonrpc: '2.0', id: 1, result: {} });
    }

    await until(() => places.taken === 0, 'every place is given back');
  });

  it('gives the place back once the message is read: a wait_for_request waits without one', async () => {
    const id = await createSession();
    const waiting = send(
      'POST',
      '/mcp',
      paddedMessage({
        id: 2,
        method: 'tools/call',
        params: { name: 'wait_for_request', arguments: { sessionId: id, wait: 30 } },
      }),
      { hold: true, headers: MCP_HEADERS },
    );

    await until(() => places.taken === 1, 'the wait holds a place while its body arrives');
    waiting.finish();
    await until(() => places.taken === 0, 'the place goes back once the message is read');
    assert.ok(
      await Promise.race([waiting.answered.then(() => false), delay(200, true)]),
      'the wait was answered',
    );

    waiting.abort();
  });
});
