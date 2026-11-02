/**
 * The answers' byte budget on the application listener (#184, D228's
 * amendment), over real sockets: an address whose large answers wait unread
 * past its 16 MiB is refused `429` / `1019` with `Retry-After: 1` and the
 * limits' headers on the next large answer, in the API's error body, while a
 * small answer still fits and another address is unaffected; the check made
 * as each answer is ready, so calls admitted at once on an empty budget do
 * not all pass; the server's 64 MiB, past which an address with one answer
 * counted is refused though its own bytes have room, its first always sent;
 * the bytes given back as the client reads and when it goes away; on
 * `/mcp`, the refusal in its JSON-RPC form under the request's own id; and a
 * call whose answer is refused carried out all the same - a response change
 * saved, a session created - and carried out again when it is called again.
 *
 * Unread answers are held as a client that never reads holds them, without
 * depending on the kernel's buffers: pipelined behind a pending wait on the
 * same connection, each is serialized and then queued in the server,
 * unwritten, until the wait is answered - a clear of its session - or the
 * connection goes. The listener trusts the test's socket as the proxy, so
 * that `X-Forwarded-For` names the address a call counts under (D111, D201).
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  API_ANSWER_BYTES,
  API_ANSWER_PER_ADDRESS_BYTES,
  CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS,
  ErrorCode,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildServer } from '../../server.ts';
import { ordinaryFullQueue, ordinaryFullResponse } from '../../testing/full-queue.ts';
import { attachListener } from '../../testing/servers.ts';
import { RealtimeHub } from '../realtime/hub.ts';
import { createAnswerBudget, type AnswerBudget } from './answer-budget.ts';
import { createCallPlaces, type CallPlaces } from './calls-in-flight.ts';
import { DEFAULT_RATE_LIMITS } from './rate-limit.ts';

/** The addresses the calls come from, as the proxy names them. */
const ADDRESSES = ['203.0.113.10', '203.0.113.11', '203.0.113.12', '203.0.113.13', '203.0.113.14'];
const [A, B, C, D, E] = ADDRESSES as [string, string, string, string, string];
/** Where the sessions are made and cleared from: an address no test counts. */
const SETUP = '198.18.0.1';

let pool: pg.Pool;
const createdSessionIds: string[] = [];
const listeners: FastifyInstance[] = [];
const sockets: net.Socket[] = [];

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
  budget: AnswerBudget;
  places: CallPlaces;
}

async function listen(budget: AnswerBudget = createAnswerBudget()): Promise<Listener> {
  const places = createCallPlaces();
  const hub = new RealtimeHub();
  const app = buildServer(pool, {
    logDestination: discard(),
    trustedProxyCidrs: ['127.0.0.1/32'],
    rateLimits: DEFAULT_RATE_LIMITS,
    callPlaces: places,
    answerBudget: budget,
    hub,
  });

  // The process's realtime listener (D221): a clear ends the waits through it.
  attachListener(app, pool, hub);
  listeners.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });

  return { app, port: (app.server.address() as net.AddressInfo).port, budget, places };
}

/** A session made from `SETUP`: with a full response and a full queue, about 800 KiB of JSON, or empty. */
async function createSession(app: FastifyInstance, full: boolean): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    remoteAddress: SETUP,
    ...(full
      ? {
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({
            response: ordinaryFullResponse(),
            queue: { steps: ordinaryFullQueue() },
          }),
        }
      : {}),
  });

  assert.equal(response.statusCode, 201, response.body.slice(0, 300));

  const { id } = response.json() as { id: string };

  createdSessionIds.push(id);

  return id;
}

/** The bytes of a session's answer, as the server serializes it. */
async function answerBytes(app: FastifyInstance, sessionId: string): Promise<number> {
  const read = await app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}`,
    remoteAddress: SETUP,
  });

  assert.equal(read.statusCode, 200);

  return Buffer.byteLength(read.body);
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One call from `from` on a connection of its own, read whole. */
function call(
  port: number,
  path: string,
  options: { from: string; method?: string; body?: string; headers?: Record<string, string> },
): Promise<Answer> {
  const { from, method = 'GET', body, headers = {} } = options;

  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      agent: false,
      headers: {
        'x-forwarded-for': from,
        connection: 'close',
        ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
        ...headers,
      },
    });

    request.on('response', (response) => {
      const chunks: Buffer[] = [];

      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

/**
 * A connection from `from` that pipelines a wait on `waitOn` and then
 * `count` reads of `sessionId`, and keeps every byte it is answered: the
 * reads' answers are serialized and then queued behind the wait's, unwritten,
 * until the wait is answered or the connection goes.
 */
async function pipelinedBehindWait(
  port: number,
  from: string,
  waitOn: string,
  sessionId: string,
  count: number,
): Promise<{ socket: net.Socket; read: () => Buffer }> {
  const head = (path: string): string =>
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: ${from}\r\n\r\n`;
  const socket = net.connect(port, '127.0.0.1');
  const chunks: Buffer[] = [];

  sockets.push(socket);
  socket.on('error', () => undefined);
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  await once(socket, 'connect');
  socket.write(
    head(`/api/sessions/${waitOn}/requests?wait=30`) +
      head(`/api/sessions/${sessionId}`).repeat(count),
  );

  return { socket, read: () => Buffer.concat(chunks) };
}

interface Raw {
  status: number;
  body: string;
}

/** The answers of a connection, in order, each with a `Content-Length`. */
function answersIn(bytes: Buffer): Raw[] {
  const answers: Raw[] = [];
  let at = 0;

  while (at < bytes.length) {
    const end = bytes.indexOf('\r\n\r\n', at);

    if (end === -1) {
      break;
    }

    const headText = bytes.subarray(at, end).toString('latin1');
    const length = Number(/\r\ncontent-length: *(\d+)/i.exec(headText)?.[1] ?? 0);

    if (bytes.length < end + 4 + length) {
      break;
    }

    answers.push({
      status: Number(/^HTTP\/1\.1 (\d{3})/.exec(headText)?.[1] ?? 0),
      body: bytes.subarray(end + 4, end + 4 + length).toString('utf8'),
    });
    at = end + 4 + length;
  }

  return answers;
}

/** How many answers had each status. */
function tally(answers: Raw[]): Record<number, number> {
  const counts: Record<number, number> = {};

  for (const answer of answers) {
    counts[answer.status] = (counts[answer.status] ?? 0) + 1;
  }

  return counts;
}

async function until(check: () => boolean, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;

  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
    await delay(5);
  }
}

/** Clears a session's requests, which answers every wait on it `[]` at once (D200). */
async function clear(port: number, sessionId: string): Promise<void> {
  const cleared = await call(port, `/api/sessions/${sessionId}/requests`, {
    method: 'DELETE',
    from: SETUP,
  });

  assert.equal(cleared.status, 204, cleared.body);
}

const BUSY_ADDRESS = `Too many answers not yet written: 16 MiB at once per address; try again in a moment`;
const BUSY_SERVER = `Too many answers not yet written: 64 MiB at once on the server; try again in a moment`;

describe('the answers byte budget on the application listener (#184)', () => {
  it('refuses the next large answer of an address with 16 MiB unread 429 / 1019, checked as each is ready, and gives the bytes back as the client reads', async () => {
    const { app, port, budget, places } = await listen();
    const large = await createSession(app, true);
    const small = await createSession(app, false);
    const size = await answerBytes(app, large);
    const smallSize = await answerBytes(app, small);
    // As many as fit in an address's 16 MiB, and five more: all admitted at
    // once by the calls in flight, on an empty budget.
    const fit = Math.floor(API_ANSWER_PER_ADDRESS_BYTES / size);
    const extra = 5;

    assert.ok(size > 700 * 1024, `the large answer is ${size} bytes`);

    const held = await pipelinedBehindWait(port, A, small, large, fit + extra);

    // Every read's answer is ready: `fit` counted, the rest refused as each
    // was ready - and the refusals counted too.
    await until(() => budget.answersOf(A) === fit + extra, 'every answer is ready');
    assert.equal(places.takenBy(A), 1 + fit + extra);

    const refusals = budget.bytesOf(A) - fit * size;

    assert.ok(refusals > 0 && refusals < extra * 300, `${refusals} bytes of ${extra} refusals`);

    // The next large answer of the address does not fit: refused in the
    // API's error body, with `Retry-After: 1` and the limits' headers.
    const refused = await call(port, `/api/sessions/${large}`, { from: A });

    assert.equal(refused.status, 429);
    assert.equal(refused.headers['retry-after'], String(CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS));
    assert.ok(refused.headers['x-ratelimit-limit'] !== undefined, 'no X-RateLimit-Limit');
    assert.ok(refused.headers['x-ratelimit-remaining'] !== undefined, 'no X-RateLimit-Remaining');
    assert.ok(refused.headers['x-ratelimit-reset'] !== undefined, 'no X-RateLimit-Reset');
    assert.deepEqual(JSON.parse(refused.body), {
      errorCode: ErrorCode.TOO_MANY_CONCURRENT_CALLS,
      message: BUSY_ADDRESS,
    });

    // A small answer still fits.
    assert.ok(
      budget.bytesOf(A) + smallSize <= API_ANSWER_PER_ADDRESS_BYTES,
      `${budget.bytesOf(A)} + ${smallSize} bytes do not leave the small answer room`,
    );
    assert.equal((await call(port, `/api/sessions/${small}`, { from: A })).status, 200);

    // Another address is unaffected.
    const other = await call(port, `/api/sessions/${large}`, { from: B });

    assert.equal(other.status, 200);
    assert.equal(Buffer.byteLength(other.body), size);

    // The wait answered, the client reads every queued answer, and their
    // bytes come back as each is written.
    await clear(port, small);
    await until(() => answersIn(held.read()).length === 1 + fit + extra, 'every answer is read');

    // The reads' answers in their connection's order, whichever was ready first.
    const [waited, ...reads] = answersIn(held.read());

    assert.equal(waited?.status, 200);
    assert.deepEqual(tally(reads), { 200: fit, 429: extra });

    for (const answer of reads.filter((each) => each.status === 429)) {
      assert.deepEqual(JSON.parse(answer.body), {
        errorCode: ErrorCode.TOO_MANY_CONCURRENT_CALLS,
        message: BUSY_ADDRESS,
      });
    }

    for (const answer of reads.filter((each) => each.status === 200)) {
      assert.equal(Buffer.byteLength(answer.body), size);
    }
    await until(() => budget.keys === 0, 'every answer is given back');
    assert.equal(budget.bytes, 0);
    await until(() => places.taken === 0, 'every place is given back');
    held.socket.destroy();
  });

  it("refuses past the server's 64 MiB an address with one answer counted, sends every address's first, and gives everything back when the clients go", async () => {
    const { app, port, budget } = await listen();
    const large = await createSession(app, true);
    const small = await createSession(app, false);
    const size = await answerBytes(app, large);
    const fit = Math.floor(API_ANSWER_PER_ADDRESS_BYTES / size);

    // Four addresses each with as much as fits in its own 16 MiB: each
    // unaffected by the others, the server's 64 MiB not yet passed.
    const filled = [];

    for (const from of [A, B, C, D]) {
      filled.push(await pipelinedBehindWait(port, from, small, large, fit));
      await until(() => budget.answersOf(from) === fit, `${from}'s answers are ready`);
      assert.equal(budget.bytesOf(from), fit * size, `${from} had an answer refused`);
    }

    assert.equal(budget.bytes, 4 * fit * size);
    assert.ok(budget.bytes <= API_ANSWER_BYTES);

    // A fifth: its first is sent whatever the server holds; the rest while
    // the server's 64 MiB has room, the others refused for the server's.
    const tried = 6;
    let sent = 1;

    while (sent < tried && budget.bytes + (sent + 1) * size <= API_ANSWER_BYTES) {
      sent += 1;
    }

    const fifth = await pipelinedBehindWait(port, E, small, large, tried);

    await until(() => budget.answersOf(E) === tried, "the fifth's answers are ready");
    assert.ok(budget.bytesOf(E) - sent * size < (tried - sent) * 300, 'more were sent than fit');

    // The fifth address's next is refused for the server's bytes, though its
    // own have room.
    assert.ok(budget.bytesOf(E) + size <= API_ANSWER_PER_ADDRESS_BYTES);

    const refused = await call(port, `/api/sessions/${large}`, { from: E });

    assert.equal(refused.status, 429);
    assert.equal(refused.headers['retry-after'], String(CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS));
    assert.deepEqual(JSON.parse(refused.body), {
      errorCode: ErrorCode.TOO_MANY_CONCURRENT_CALLS,
      message: BUSY_SERVER,
    });

    // An address with nothing counted still has its first sent.
    assert.equal(
      (await call(port, `/api/sessions/${large}`, { from: '203.0.113.99' })).status,
      200,
    );

    // Four of the clients go: their bytes come back, queued answers included.
    for (const connection of filled) {
      connection.socket.destroy();
    }

    await until(() => budget.keys === 1, "the four addresses' answers are given back");
    assert.equal(budget.answersOf(E), tried);

    // The fifth reads its answers once its wait is answered: what the budget said.
    await clear(port, small);
    await until(() => answersIn(fifth.read()).length === 1 + tried, "the fifth's answers are read");

    const [waited, ...reads] = answersIn(fifth.read());

    assert.equal(waited?.status, 200);
    assert.deepEqual(tally(reads), { 200: sent, 429: tried - sent });

    for (const answer of reads.filter((each) => each.status === 429)) {
      assert.equal((JSON.parse(answer.body) as { message: string }).message, BUSY_SERVER);
    }

    await until(() => budget.keys === 0, 'every answer is given back');
    assert.equal(budget.bytes, 0);
    assert.equal(budget.answers, 0);
    fifth.socket.destroy();
  });

  it('refuses a /mcp answer in its JSON-RPC form, under the request id, with Retry-After: 1', async () => {
    const probe = await listen();
    const large = await createSession(probe.app, true);
    const small = await createSession(probe.app, false);
    const size = await answerBytes(probe.app, large);

    // An address's bytes exactly one large answer: once it is counted, nothing else fits.
    const { port, budget } = await listen(createAnswerBudget(size, API_ANSWER_BYTES));
    const held = await pipelinedBehindWait(port, A, small, large, 1);

    await until(() => budget.bytesOf(A) === size, 'the large answer is counted');

    for (const [id, method, params] of [
      [7, 'tools/list', {}],
      ['call-8', 'tools/call', { name: 'list_requests', arguments: { sessionId: small } }],
    ] as const) {
      const refused = await call(port, '/mcp', {
        from: A,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });

      assert.equal(refused.status, 429, `${method}: ${refused.body}`);
      assert.equal(refused.headers['retry-after'], String(CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS));
      assert.deepEqual(JSON.parse(refused.body), {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: `Too many answers not yet written: ${size} bytes at once per address; try again in a moment`,
          data: { errorCode: ErrorCode.TOO_MANY_CONCURRENT_CALLS, retryAfter: 1 },
        },
      });
    }

    // Another address's `/mcp` answers are sent.
    const other = await call(port, '/mcp', {
      from: B,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });

    assert.equal(other.status, 200, other.body.slice(0, 300));
    held.socket.destroy();
    await until(() => budget.keys === 0, 'every answer is given back');
  });

  it('carries out a call whose answer it refuses: the response change is saved, the session created exists, and calling again repeats it', async () => {
    const probe = await listen();
    const large = await createSession(probe.app, true);
    const small = await createSession(probe.app, false);
    const target = await createSession(probe.app, false);
    const size = await answerBytes(probe.app, large);
    const busy = `Too many answers not yet written: ${size} bytes at once per address; try again in a moment`;
    const changedBody = `changed-${randomUUID()}`;
    const createdBody = `created-${randomUUID()}`;
    const change = JSON.stringify({
      mode: 'custom',
      response: { status: 418, headers: [['x-marker', 'refused']], body: changedBody, delayMs: 0 },
    });
    const creation = JSON.stringify({ response: { status: 202, body: createdBody } });
    const json = { 'content-type': 'application/json' };
    /** The sessions whose custom response answers `body`, read from the database itself. */
    const sessionsAnswering = async (body: string): Promise<string[]> => {
      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM sessions WHERE response_body = $1 ORDER BY created_at',
        [body],
      );

      createdSessionIds.push(...rows.map((row) => row.id));

      return rows.map((row) => row.id);
    };

    // An address's bytes exactly one large answer: once it is counted, nothing else fits.
    const { port, budget } = await listen(createAnswerBudget(size, API_ANSWER_BYTES));
    const held = await pipelinedBehindWait(port, A, small, large, 1);

    await until(() => budget.bytesOf(A) === size, 'the large answer is counted');

    // The response change is refused its answer, and saved.
    const changed = await call(port, `/api/sessions/${target}/response`, {
      from: A,
      method: 'PUT',
      headers: json,
      body: change,
    });

    assert.equal(changed.status, 429, changed.body);
    assert.equal(changed.headers['retry-after'], String(CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS));
    assert.deepEqual(JSON.parse(changed.body), {
      errorCode: ErrorCode.TOO_MANY_CONCURRENT_CALLS,
      message: busy,
    });

    const read = await probe.app.inject({
      method: 'GET',
      url: `/api/sessions/${target}`,
      remoteAddress: SETUP,
    });

    assert.equal(read.statusCode, 200);

    const saved = read.json() as { response: { status: number; headers: unknown; body: string } };

    assert.equal(saved.response.status, 418);
    assert.deepEqual(saved.response.headers, [['x-marker', 'refused']]);
    assert.equal(saved.response.body, changedBody);

    // The creation is refused its answer, which alone carried the id, and
    // the session exists.
    const refused = await call(port, '/api/sessions', {
      from: A,
      method: 'POST',
      headers: json,
      body: creation,
    });

    assert.equal(refused.status, 429, refused.body);
    assert.equal(refused.headers['retry-after'], String(CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS));
    assert.deepEqual(JSON.parse(refused.body), {
      errorCode: ErrorCode.TOO_MANY_CONCURRENT_CALLS,
      message: busy,
    });

    const [first, ...others] = await sessionsAnswering(createdBody);

    assert.ok(first, 'the refused creation created no session');
    assert.deepEqual(others, []);

    // Once the address's answers are written, calling again repeats each
    // call: the change is saved again, and a second session is created.
    held.socket.destroy();
    await until(() => budget.keys === 0, 'every answer is given back');

    const again = await call(port, `/api/sessions/${target}/response`, {
      from: A,
      method: 'PUT',
      headers: json,
      body: change,
    });

    assert.equal(again.status, 200, again.body);
    assert.equal(
      (JSON.parse(again.body) as { response: { body: string } }).response.body,
      changedBody,
    );

    const createdAgain = await call(port, '/api/sessions', {
      from: A,
      method: 'POST',
      headers: json,
      body: creation,
    });

    assert.equal(createdAgain.status, 201, createdAgain.body);

    const { id: second } = JSON.parse(createdAgain.body) as { id: string };
    const answering = await sessionsAnswering(createdBody);

    assert.equal(answering.length, 2);
    assert.ok(answering.includes(first) && answering.includes(second) && first !== second);
    await until(() => budget.keys === 0, 'every answer is given back');
  });
});
