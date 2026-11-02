/**
 * The cap on list answers with bodies on a real listener (D201): four at
 * once, across the list and the query, the fifth refused `429` / `1016` with
 * `Retry-After` at once, before its list statement; answers with headers
 * alone or without `include` untouched; a place given back when an answer
 * ends, fails, loses its client or fails before it is begun; and a call held
 * by `wait` taking a place only once it has requests to write.
 *
 * An answer is held "being written" by holding its content read: the pool
 * passes every read of a body for the sessions in `held` to a gate the test
 * opens one read at a time, or fails. Each held session holds one request, so
 * each held answer is one read. A call is held before its answer by holding
 * its list statement the same way, for the sessions in `listHeld`, on the
 * pool and on a connection taken from it, where the query runs its own.
 *
 * What a list whose client left while its statement ran still holds (#141,
 * D201 point 8's note): its query place, on the query route - one of the
 * search's with a body condition, one of the header-only queries' without
 * (D250) - until the statement settles; its address's place among the calls
 * in flight (D213), passed in as `callPlaces`, until then too; and no content
 * read at all.
 *
 * A `HEAD` (#210) takes a place for its list statement as the `GET` does,
 * answers the `GET`'s status and headers, and reads no content.
 *
 * How a list with bodies whose client left is logged (#212, D174): once, at
 * `info`, `Request aborted by the client` when its answer had not begun, and
 * Fastify's `stream closed prematurely` when it had; never at `error` unless
 * its statement failed. The listeners' log is kept line by line, and a test
 * reads each of its calls' lines by the request id of its `incoming request`.
 *
 * Content reads are counted per session as they reach the database: the pool,
 * and a connection taken from it, keep every statement they run by the
 * session it names first, so a test counts the list statements and content
 * reads of a session once its calls have settled and a settle wait has passed.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { Readable, type ReadableOptions, Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import {
  ErrorCode,
  MAX_CONCURRENT_BODY_LISTS,
  MAX_CONCURRENT_HEADER_QUERIES,
  MAX_CONCURRENT_SEARCHES,
  type RequestListEntry,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import { createApiWorkSlots } from '../limits/api-work.ts';
import { createCallPlaces } from '../limits/calls-in-flight.ts';
import { createBodyListPlaces } from './body-lists.ts';
import { PendingWaits } from './wait.ts';

/** The statement that reads the content of listed requests with their bodies. */
const BODY_READ = /^SELECT id(, headers)?, body\s+FROM requests/;

/** The list statement, which chooses the requests an answer writes. */
const LIST_STATEMENT = /LEFT JOIN LATERAL/;

/** Any read of listed requests' content: headers, body or both (`readListedContent`). */
const CONTENT_READ =
  /^SELECT id(, headers)?(, body)?\s+FROM requests\s+WHERE session_id = \$1 AND id = ANY/;

/**
 * How long a test waits, once every place is back, for whatever an answer
 * still does after its head or after its client left: unfixed, a `HEAD`'s
 * stream went on reading every body here, its first read within a few
 * milliseconds.
 */
const SETTLE_MS = 300;

let pool: pg.Pool;
let servers: TestServers;
let port: number;
const places = createBodyListPlaces();
/** The calls in flight per address (D213); every call of this file comes from `LOCAL`. */
const callPlaces = createCallPlaces();
const LOCAL = '127.0.0.1';
const waits = new PendingWaits();
const createdSessionIds: string[] = [];

/** Pino's numeric levels. */
const INFO = 30;
const ERROR = 50;

/** What D174 logs, at `info`, for a client that gave up. */
const ABORTED = 'Request aborted by the client';

/** What Fastify logs, at `info`, for an answer cut off once its head was written. */
const CUT_OFF = 'stream closed prematurely';

interface LogLine {
  level: number;
  msg: string;
  reqId?: string;
  req?: { method?: string; url?: string };
  res?: { statusCode?: number };
}

/** Every line the listeners have logged so far, in order. */
const logged: LogLine[] = [];

/** What the last chunk logged ended with after its last full line. */
let unfinishedLine = '';

/** Sessions whose body reads wait at the gate. */
const held = new Set<string>();

/** Body reads waiting at the gate, oldest first. */
const gate: { open: () => void; fail: (error: Error) => void }[] = [];

/** Sessions whose list statements wait at `listGate`. */
const listHeld = new Set<string>();

/** List statements waiting at their gate, oldest first. */
const listGate: (() => void)[] = [];

/** List statements of `listHeld` sessions that have been let through and answered. */
let listsAnswered = 0;

/**
 * Sessions whose list statements, once let through, fail as a statement on a
 * connection the database dropped does, instead of running.
 */
const listFailing = new Set<string>();

/** Statements run and connections taken through the pool so far. */
let databaseWork = 0;

/** Every statement run through the pool or a connection taken from it, with its first value. */
const ran: { text: string; first: string }[] = [];

function record(text: unknown, values: unknown[] | undefined): void {
  if (typeof text === 'string') {
    ran.push({ text, first: String(values?.[0]) });
  }
}

/** The list statements and content reads run so far for `sessionId`. */
function statementsOf(sessionId: string): { lists: number; contentReads: number } {
  const ofSession = ran.filter(({ first }) => first === sessionId);

  return {
    lists: ofSession.filter(({ text }) => LIST_STATEMENT.test(text)).length,
    contentReads: ofSession.filter(({ text }) => CONTENT_READ.test(text)).length,
  };
}

/** The list statements and content reads run for `sessionId` since `before` was read. */
function statementsSince(
  before: { lists: number; contentReads: number },
  sessionId: string,
): { lists: number; contentReads: number } {
  const now = statementsOf(sessionId);

  return { lists: now.lists - before.lists, contentReads: now.contentReads - before.contentReads };
}

/**
 * Holds a list statement of a session in `listHeld` until `listGate` opens
 * it, then runs it, or fails it for a session in `listFailing`.
 */
async function runList<T>(
  text: unknown,
  values: unknown[] | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (
    typeof text !== 'string' ||
    !LIST_STATEMENT.test(text) ||
    !listHeld.has(String(values?.[0]))
  ) {
    return run();
  }

  await new Promise<void>((open) => {
    listGate.push(open);
  });

  if (listFailing.has(String(values?.[0]))) {
    listsAnswered += 1;

    throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
  }

  const result = await run();

  listsAnswered += 1;

  return result;
}

function gatedPool(base: pg.Pool): pg.Pool {
  return new Proxy(base, {
    get(target, property) {
      if (property === 'connect') {
        return async () => {
          databaseWork += 1;

          const client = await target.connect();

          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty === 'query') {
                return (text: unknown, values?: unknown[]) => {
                  record(text, values);

                  return runList(text, values, () => clientTarget.query(text as string, values));
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

      if (property === 'query') {
        return async (text: unknown, values?: unknown[]) => {
          databaseWork += 1;
          record(text, values);

          if (typeof text === 'string' && BODY_READ.test(text) && held.has(String(values?.[0]))) {
            await new Promise<void>((open, fail) => {
              gate.push({ open, fail });
            });
          }

          return runList(text, values, () => target.query(text as string, values));
        };
      }

      const value = Reflect.get(target, property, target);

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

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
  servers = buildTestServers(gatedPool(pool), {
    logDestination: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        const lines = (unfinishedLine + chunk.toString()).split('\n');

        unfinishedLine = lines.pop() ?? '';

        for (const line of lines) {
          if (line !== '') {
            logged.push(JSON.parse(line) as LogLine);
          }
        }

        callback();
      },
    }),
    bodyListPlaces: places,
    callPlaces,
    waits,
    // More slots than the gate's three in front of the API's work (D244): the
    // tests hold four list statements and more at once, and what they test
    // is the places; the gate's own tests are `api-work*.test.ts`.
    apiWorkSlots: createApiWorkSlots(16),
  });
  await servers.receiver.ready();
  await servers.api.listen({ host: '127.0.0.1', port: 0 });
  port = (servers.api.server.address() as AddressInfo).port;
}

after(async () => {
  await startup?.catch(() => undefined);

  for (const waiting of gate.splice(0)) {
    waiting.open();
  }

  for (const open of listGate.splice(0)) {
    open();
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

async function capture(sessionId: string, body: string): Promise<void> {
  const response = await servers.receiver.inject({
    method: 'POST',
    url: `/s/${sessionId}`,
    headers: { 'content-type': 'text/plain' },
    payload: body,
  });

  assert.equal(response.statusCode, 200);
}

/** A session holding one request, whose body reads wait at the gate. */
async function heldSession(): Promise<string> {
  const id = await createSession();

  await capture(id, `the body of ${id}`);
  held.add(id);

  return id;
}

interface Call {
  /** The status and headers, once they have arrived. */
  answered: Promise<{ status: number; headers: http.IncomingHttpHeaders }>;
  /** The whole body, or the failure that cut it off. */
  body: Promise<string>;
  /** How the body ended so far: `null` while it is still arriving. */
  outcome: () => 'complete' | 'failed' | null;
  /** Closes the connection, as a client that goes away does. */
  destroy: () => void;
}

/** One call over its own connection. */
function call(path: string, json?: unknown): Call {
  const payload = json === undefined ? undefined : JSON.stringify(json);
  const request = http.request({
    host: '127.0.0.1',
    port,
    path,
    method: payload === undefined ? 'GET' : 'POST',
    agent: false,
    headers: payload === undefined ? {} : { 'content-type': 'application/json' },
  });
  let outcome: 'complete' | 'failed' | null = null;
  let resolveBody: (text: string) => void = () => undefined;
  let rejectBody: (error: Error) => void = () => undefined;
  const body = new Promise<string>((resolve, reject) => {
    resolveBody = resolve;
    rejectBody = reject;
  });

  body.then(
    () => {
      outcome = 'complete';
    },
    () => {
      outcome = 'failed';
    },
  );

  const answered = new Promise<{ status: number; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      request.on('response', (response) => {
        const chunks: Buffer[] = [];

        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
        response.on('error', rejectBody);
        response.on('aborted', () => rejectBody(new Error('the answer was cut off')));
        response.on('close', () => {
          if (!response.complete) {
            rejectBody(new Error('the answer was cut off'));
          }
        });
        resolve({ status: response.statusCode ?? 0, headers: response.headers });
      });
      request.on('error', (error) => {
        reject(error);
        rejectBody(error);
      });
    },
  );

  answered.catch(() => undefined);
  request.end(payload);

  return { answered, body, outcome: () => outcome, destroy: () => request.destroy() };
}

/** Waits until `check` holds, for 5 s at most. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
    await delay(5);
  }
}

/** Answers taken over a held session, until all four hold a place and wait at the gate. */
async function holdFour(sessionId: string): Promise<Call[]> {
  const calls = [
    call(`/api/sessions/${sessionId}/requests?include=body`),
    call(`/api/sessions/${sessionId}/requests?include=headers,body&order=asc`),
    call(`/api/sessions/${sessionId}/requests/query`, { include: ['body'] }),
    call(`/api/sessions/${sessionId}/requests?include=body&limit=1`),
  ];

  await until(() => places.taken === 4 && gate.length === 4, 'four answers hold a place');

  return calls;
}

async function refusedAtOnce(target: Call): Promise<void> {
  const started = Date.now();
  const { status, headers } = await target.answered;

  refusals += 1;

  assert.equal(status, 429);
  assert.equal(headers['retry-after'], '1');
  // A limited route: its rate-limit headers are there too.
  assert.equal(headers['x-ratelimit-limit'], '1200');
  assert.deepEqual(JSON.parse(await target.body), {
    errorCode: ErrorCode.LIST_BODIES_BUSY,
    message: 'Too many lists with bodies are being written; try again in a moment',
  });
  assert.ok(Date.now() - started < 1_000, 'the refusal was not at once');
}

/** Refusals seen by `refusedAtOnce`. */
let refusals = 0;

/** Waits until every place is back, then `SETTLE_MS` for what an answer still does. */
async function settled(): Promise<void> {
  await until(() => places.taken === 0 && callPlaces.taken === 0, 'every place is given back');
  await delay(SETTLE_MS);
}

/** Headers that change from one call to the next, or frame a body a `HEAD` has none of. */
const MOVING_HEADERS = new Set([
  'date',
  'transfer-encoding',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
]);

interface Head {
  status: number;
  headers: Record<string, unknown>;
}

/**
 * A call's status and headers as a `HEAD` must repeat the `GET`'s (RFC 9110
 * §9.3.2): all but `MOVING_HEADERS`, the two rate-limit ones there all the same.
 */
function headOf(response: { statusCode: number; headers: Record<string, unknown> }): Head {
  for (const name of ['x-ratelimit-remaining', 'x-ratelimit-reset']) {
    assert.match(String(response.headers[name]), /^\d+$/, name);
  }

  return {
    status: response.statusCode,
    headers: Object.fromEntries(
      Object.entries(response.headers).filter(([name]) => !MOVING_HEADERS.has(name)),
    ),
  };
}

interface RawCall {
  /** Every byte the server has written so far. */
  received: () => Buffer;
  /** The head, up to and with its blank line, once it has arrived; `null` before. */
  head: () => string | null;
  /** Whether the server has ended the connection. */
  ended: () => boolean;
  close: () => void;
}

/**
 * One request written whole as `text` on a connection of its own, closed as
 * soon as the request has been written, as a client that gives up at once
 * does (#212). Resolves once the connection is closed.
 */
function leftAtOnce(text: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect(port, LOCAL);

    socket.on('error', () => undefined);
    socket.on('close', () => resolve());
    socket.write(text, () => socket.destroy());
  });
}

/** A `GET` of the list with `include`, as `leftAtOnce` writes it. */
function rawList(sessionId: string, include: string): string {
  return `GET /api/sessions/${sessionId}/requests?include=${include} HTTP/1.1\r\nHost: localhost\r\n\r\n`;
}

/** A query with `include`, as `leftAtOnce` writes it. */
function rawQuery(sessionId: string, include: string[]): string {
  const body = JSON.stringify({ include });

  return (
    `POST /api/sessions/${sessionId}/requests/query HTTP/1.1\r\nHost: localhost\r\n` +
    `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

/** One request written as `text` on a connection of its own. */
function rawCall(text: string): RawCall {
  const socket = net.connect(port, LOCAL);
  const chunks: Buffer[] = [];
  let ended = false;

  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.on('close', () => {
    ended = true;
  });
  socket.on('error', () => undefined);
  socket.write(text);

  const received = (): Buffer => Buffer.concat(chunks);

  return {
    received,
    head: () => {
      const bytes = received();
      const end = bytes.indexOf('\r\n\r\n');

      return end === -1 ? null : bytes.subarray(0, end + 4).toString('latin1');
    },
    ended: () => ended,
    close: () => socket.destroy(),
  };
}

/**
 * A query that must find every place of its count taken (D250) while
 * `heldStatements` statements are held: refused `429` / `1012`, within 5 s,
 * and never let through to a statement of its own, which would wait at
 * `listGate`.
 */
async function refusedForSlots(target: Call, heldStatements: number): Promise<void> {
  let status = 0;

  void target.answered.then(
    (answer) => {
      status = answer.status;
    },
    () => undefined,
  );
  await until(
    () => status !== 0 || listGate.length > heldStatements,
    'the query is answered or reaches a statement',
  );
  assert.equal(listGate.length, heldStatements, 'a slot came back before its statement settled');
  assert.equal(status, 429);
  assert.equal(
    (JSON.parse(await target.body) as { errorCode: number }).errorCode,
    ErrorCode.SEARCH_BUSY,
  );
}

/** Lets every held list statement through and stops holding `sessionId`'s: a test's cleanup. */
function releaseLists(sessionId: string): void {
  listHeld.delete(sessionId);

  for (const open of listGate.splice(0)) {
    open();
  }
}

/**
 * What each call on `sessionId` has logged from line `from` of `logged` on,
 * sorted: its method and its URL after the session id, which the log
 * shortens to its first eight characters (D059), then each of its lines
 * after its `incoming request`: level, message and, where the line has one,
 * the status answered.
 */
function trailsSince(from: number, sessionId: string): string[][] {
  const lines = logged.slice(from);
  const prefix = `/api/sessions/${sessionId.slice(0, 8)}...`;

  return lines
    .filter((line) => line.msg === 'incoming request' && line.req?.url?.startsWith(prefix))
    .map((incoming) => [
      `${incoming.req?.method} ${incoming.req?.url?.slice(prefix.length)}`,
      ...lines
        .filter((line) => line.reqId === incoming.reqId && line !== incoming)
        .map((line) =>
          [line.level, line.msg, line.res?.statusCode]
            .filter((part) => part !== undefined)
            .join(' '),
        ),
    ])
    .sort((one, other) => JSON.stringify(one).localeCompare(JSON.stringify(other)));
}

/** Every line at `error` or above logged from line `from` of `logged` on. */
function seriousSince(from: number): LogLine[] {
  return logged.slice(from).filter((line) => line.level >= ERROR);
}

describe('four list answers with bodies at once (D201)', () => {
  it('refuses a fifth on either route at once, and lets headers alone, no include and searches through', async () => {
    const sessionId = await heldSession();
    const four = await holdFour(sessionId);
    const other = await createSession();

    await capture(other, 'another body');

    // Before its list statement: the refused calls do no database work.
    const workBefore = databaseWork;

    await refusedAtOnce(call(`/api/sessions/${sessionId}/requests?include=body`));
    await refusedAtOnce(
      call(`/api/sessions/${sessionId}/requests/query`, { include: ['headers', 'body'] }),
    );
    // Another session's answer with bodies is refused just the same: the
    // places are the process's.
    await refusedAtOnce(call(`/api/sessions/${other}/requests?include=body`));
    assert.equal(databaseWork, workBefore);
    assert.equal(refusals, 3);

    for (const [target, check] of [
      [call(`/api/sessions/${sessionId}/requests?include=headers`), 'headers'],
      [call(`/api/sessions/${sessionId}/requests`), 'plain'],
      [call(`/api/sessions/${sessionId}/requests/query`, { include: ['headers'] }), 'headers'],
      [call(`/api/sessions/${sessionId}/requests/query`, {}), 'plain'],
    ] as const) {
      assert.equal((await target.answered).status, 200);

      const [item] = JSON.parse(await target.body) as RequestListEntry[];

      assert.ok(item !== undefined);
      assert.equal('body' in item, false);
      assert.equal('headers' in item, check === 'headers');
    }

    const searched = call(`/api/sessions/${sessionId}/requests/search`, { words: ['body'] });

    assert.equal((await searched.answered).status, 200);
    assert.equal(
      (JSON.parse(await searched.body) as { matches: string[][] }).matches[0]?.length,
      1,
    );
    assert.equal(places.taken, 4);

    for (const waiting of gate.splice(0)) {
      waiting.open();
    }

    for (const held_ of four) {
      assert.equal((await held_.answered).status, 200);
      assert.equal(
        (JSON.parse(await held_.body) as RequestListEntry[])[0]?.body,
        `the body of ${sessionId}`,
      );
    }

    await until(() => places.taken === 0, 'every place is given back');
  });

  it('accepts the next once one ends, once one fails, and once a client goes', async () => {
    const sessionId = await heldSession();
    const four = await holdFour(sessionId);
    const later: Call[] = [];

    // One ends: its read is let through, and it is written to its end.
    gate.shift()?.open();
    await until(() => four.some((one) => one.outcome() === 'complete'), 'one answer has ended');
    await until(() => places.taken === 3, 'the ended answer gives its place back');
    later.push(call(`/api/sessions/${sessionId}/requests?include=body`));
    await until(() => places.taken === 4 && gate.length === 4, 'the next answer takes the place');

    // One fails: its read fails, and the answer is cut off.
    gate.shift()?.fail(new Error('the read failed'));
    await until(
      () => [...four, ...later].some((one) => one.outcome() === 'failed'),
      'one answer has failed',
    );
    await until(() => places.taken === 3, 'the failed answer gives its place back');
    later.push(call(`/api/sessions/${sessionId}/requests/query`, { include: ['body'] }));
    await until(() => places.taken === 4 && gate.length === 4, 'the next answer takes the place');

    // A client goes while its answer's read is still held.
    const leaving = [...four, ...later].find((one) => one.outcome() === null);

    assert.ok(leaving !== undefined);
    leaving.destroy();
    await until(() => places.taken === 3, "the departed client's answer gives its place back");
    assert.equal(gate.length, 4, 'its read is still held');
    later.push(call(`/api/sessions/${sessionId}/requests?include=body`));
    await until(() => places.taken === 4 && gate.length === 5, 'the next answer takes the place');

    for (const waiting of gate.splice(0)) {
      waiting.open();
    }

    // Each answer read to its end by the client, not only by the server: a
    // place comes back when the server's stream closes, which can be before
    // the client has read the last of the answer.
    const all = [...four, ...later];

    await until(() => all.every((one) => one.outcome() !== null), 'every answer has ended');
    await until(() => places.taken === 0, 'every place is given back');

    const outcomes = all.map((one) => one.outcome()).sort();

    // The one let through and the four let through at the end ended; the one
    // whose read failed and the one whose client went did not.
    assert.deepEqual(outcomes, [
      'complete',
      'complete',
      'complete',
      'complete',
      'complete',
      'failed',
      'failed',
    ]);
  });

  it('leaves no place taken after a HEAD, whose answer carries no body', async () => {
    const sessionId = await createSession();

    await capture(sessionId, 'a body a HEAD does not get');

    for (let round = 0; round < 6; round += 1) {
      const head = await servers.api.inject({
        method: 'HEAD',
        url: `/api/sessions/${sessionId}/requests?include=body`,
      });

      assert.equal(head.statusCode, 200);
      assert.equal(head.body, '');
      await until(() => places.taken === 0, 'no place is left taken');
      await until(() => callPlaces.taken === 0, 'no call is left in flight');
    }
  });

  it('runs a HEAD its list statement and no content read, with bodies, headers alone or wait, while the GET reads every body (#210)', async () => {
    const sessionId = await createSession();

    for (const body of ['the first body', 'the second body', 'the third body']) {
      await capture(sessionId, body);
    }

    for (const query of ['include=body', 'include=headers', 'include=headers,body&wait=10']) {
      const before = statementsOf(sessionId);
      const head = await servers.api.inject({
        method: 'HEAD',
        url: `/api/sessions/${sessionId}/requests?${query}`,
      });

      assert.equal(head.statusCode, 200, query);
      assert.equal(head.body, '', query);
      await settled();
      assert.deepEqual(
        { query, ...statementsSince(before, sessionId) },
        { query, lists: 1, contentReads: 0 },
      );
    }

    // The control: the same GETs read each body, one at a time, and the
    // headers of all three in one read.
    for (const [query, contentReads] of [
      ['include=body', 3],
      ['include=headers', 1],
    ] as const) {
      const before = statementsOf(sessionId);
      const get = await servers.api.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/requests?${query}`,
      });

      assert.equal(get.statusCode, 200, query);
      assert.equal(get.json<RequestListEntry[]>().length, 3, query);
      await settled();
      assert.deepEqual(
        { query, ...statementsSince(before, sessionId) },
        { query, lists: 1, contentReads },
      );
    }
  });

  it("holds a body-list place for a HEAD's list statement and gives it back once the head is sent", async () => {
    const sessionId = await createSession();

    await capture(sessionId, 'a body a held HEAD does not read');
    listHeld.add(sessionId);

    const before = statementsOf(sessionId);
    const head = servers.api.inject({
      method: 'HEAD',
      url: `/api/sessions/${sessionId}/requests?include=body`,
    });

    await until(() => listGate.length === 1, "the HEAD's list statement is held");
    assert.equal(places.taken, 1, 'the HEAD holds a body-list place');
    assert.equal(callPlaces.taken, 1, 'the HEAD is a call in flight');

    listGate.shift()?.();

    const answered = await head;

    assert.equal(answered.statusCode, 200);
    assert.equal(answered.body, '');
    await settled();
    listHeld.delete(sessionId);
    assert.deepEqual(statementsSince(before, sessionId), { lists: 1, contentReads: 0 });
  });

  it('bounds HEADs at once as it bounds any list call, at growing numbers, none of them reading content', async () => {
    const sessionId = await createSession();

    await capture(sessionId, 'a body many HEADs do not read');

    for (const count of [1, 8, 64]) {
      const before = statementsOf(sessionId);
      const heads = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          servers.api.inject({
            method: 'HEAD',
            url: `/api/sessions/${sessionId}/requests?include=${index % 2 === 0 ? 'body' : 'headers'}`,
          }),
        ),
      );
      const statuses = heads.map((head) => head.statusCode);

      // More than four with bodies at once are refused before their
      // statement, as GETs are; headers alone never are.
      assert.ok(
        statuses.every((status) => status === 200 || status === 429),
        statuses.join(),
      );
      assert.ok(
        heads.every((head) => head.body === ''),
        'a HEAD was answered a body',
      );
      await settled();
      assert.deepEqual(
        { count, ...statementsSince(before, sessionId) },
        { count, lists: statuses.filter((status) => status === 200).length, contentReads: 0 },
      );
    }
  });

  it("answers a HEAD the GET's status and headers: the plain list, bodies, headers alone, a missing session, a wait answered by a capture, every place taken", async () => {
    const sessionId = await createSession();

    await capture(sessionId, 'a body whose list a HEAD and a GET both answer');
    // The record of the capture's answer is completed once the answer has
    // been written (D109): settled first, so that the GET and the HEAD list
    // the same state, `sent`, and not `pending` for the first alone.
    await servers.writes.settled();

    const compared: { what: string; get: Head; head: Head }[] = [];

    async function compare(what: string, url: string): Promise<void> {
      const get = await servers.api.inject({ method: 'GET', url });
      const head = await servers.api.inject({ method: 'HEAD', url });

      assert.equal(head.body, '', what);
      compared.push({ what, get: headOf(get), head: headOf(head) });
    }

    await compare('the plain list', `/api/sessions/${sessionId}/requests`);
    await compare('bodies', `/api/sessions/${sessionId}/requests?include=body`);
    await compare('headers alone', `/api/sessions/${sessionId}/requests?include=headers`);
    await compare('a missing session', `/api/sessions/${'z'.repeat(43)}/requests?include=body`);

    // A wait answered by a capture, on an empty session of its own for each method.
    const waited = new Map<string, Head>();

    for (const method of ['GET', 'HEAD'] as const) {
      const empty = await createSession();
      const waiting = waits.size;
      const answer = servers.api.inject({
        method,
        url: `/api/sessions/${empty}/requests?wait=10&include=body`,
      });

      await until(() => waits.size === waiting + 1, `the ${method} waits`);
      await capture(empty, `the capture that answers the ${method}`);

      const answered = await answer;

      assert.equal(answered.statusCode, 200, method);
      assert.equal(
        method === 'HEAD' ? answered.body : answered.json<RequestListEntry[]>()[0]?.body,
        method === 'HEAD' ? '' : 'the capture that answers the GET',
      );
      waited.set(method, headOf(answered));
    }

    compared.push({
      what: 'a wait answered by a capture',
      get: waited.get('GET') as Head,
      head: waited.get('HEAD') as Head,
    });

    // Every place taken: 429 / 1016 to both.
    const four = await holdFour(await heldSession());

    await compare('every place taken', `/api/sessions/${sessionId}/requests?include=body`);

    for (const waiting of gate.splice(0)) {
      waiting.open();
    }

    for (const held_ of four) {
      await held_.body;
    }

    await until(() => places.taken === 0, 'every place is given back');

    for (const { what, get, head } of compared) {
      assert.deepEqual({ what, ...head }, { what, ...get });
    }

    // A list with content is chunked on a GET, so neither carries a length;
    // the plain list and the errors carry the GET's.
    assert.deepEqual(
      compared.map(({ what, head }) => [
        what,
        head.status,
        head.headers['content-type'],
        'content-length' in head.headers,
      ]),
      [
        ['the plain list', 200, 'application/json; charset=utf-8', true],
        ['bodies', 200, 'application/json; charset=utf-8', false],
        ['headers alone', 200, 'application/json; charset=utf-8', false],
        ['a missing session', 404, 'application/json; charset=utf-8', true],
        ['a wait answered by a capture', 200, 'application/json; charset=utf-8', false],
        ['every place taken', 429, 'application/json; charset=utf-8', true],
      ],
    );
    assert.equal(compared.at(-1)?.head.headers['retry-after'], '1');
  });

  it('sends a raw HEAD on a real listener its head alone, kept alive, and reads none of the 20 bodies after it', async () => {
    const sessionId = await createSession();

    for (let index = 0; index < 20; index += 1) {
      // Escaped by JSON as six bytes each, as D201 measured.
      await capture(sessionId, '\u0001'.repeat(64 * 1024));
    }

    const before = statementsOf(sessionId);
    const raw = rawCall(
      `HEAD /api/sessions/${sessionId}/requests?include=body HTTP/1.1\r\nHost: localhost\r\n\r\n`,
    );

    await until(() => raw.head() !== null, 'the head arrives');
    await settled();

    const head = raw.head() ?? '';

    assert.match(head, /^HTTP\/1\.1 200 OK\r\n/);
    assert.match(head, /\r\ncontent-type: application\/json; charset=utf-8\r\n/i);
    assert.doesNotMatch(head, /\r\ncontent-length:/i);
    assert.equal(
      raw.received().length,
      Buffer.byteLength(head, 'latin1'),
      'bytes followed the head',
    );
    assert.equal(raw.ended(), false, 'the connection is kept alive');
    assert.deepEqual(statementsSince(before, sessionId), { lists: 1, contentReads: 0 });
    raw.close();
  });

  it('answers a HEAD that asks for an upgrade from the list handler too, ends its connection, and reads no content', async () => {
    const sessionId = await createSession();

    for (let index = 0; index < 20; index += 1) {
      await capture(sessionId, '\u0001'.repeat(64 * 1024));
    }

    const before = statementsOf(sessionId);
    // Node hands such a request to the `upgrade` event, which routes it
    // through Fastify on a response of its own (`isHandedOver`, D227).
    const raw = rawCall(
      `HEAD /api/sessions/${sessionId}/requests?include=body HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    );

    await until(() => raw.ended(), 'the server ends the connection');
    await settled();

    const head = raw.head() ?? '';

    assert.match(head, /^HTTP\/1\.1 200 OK\r\n/);
    assert.match(head, /\r\nconnection: close\r\n/i);
    assert.doesNotMatch(head, /\r\ncontent-length:/i);
    assert.equal(
      raw.received().length,
      Buffer.byteLength(head, 'latin1'),
      'bytes followed the head',
    );
    // The list statement ran: the request reached the list handler.
    assert.deepEqual(statementsSince(before, sessionId), { lists: 1, contentReads: 0 });
  });

  it('takes no place for a call held by wait until it has requests to write', async () => {
    const empty = await createSession();
    const waiting = Array.from({ length: 4 }, () =>
      call(`/api/sessions/${empty}/requests?wait=10&include=body`),
    );

    await until(() => waits.size === 4, 'four calls wait');
    assert.equal(places.taken, 0);

    // Four waiting tests do not shut out a list with bodies.
    const other = await createSession();

    await capture(other, 'listed while four wait');

    const listed = call(`/api/sessions/${other}/requests?include=body`);

    assert.equal((await listed.answered).status, 200);
    assert.equal(
      (JSON.parse(await listed.body) as RequestListEntry[])[0]?.body,
      'listed while four wait',
    );

    // With every place held, a waiting call that finds its request is refused.
    const sessionId = await heldSession();
    const four = await holdFour(sessionId);

    await capture(empty, 'arrived while every place was taken');

    for (const one of waiting) {
      await refusedAtOnce(one);
    }

    assert.equal(waits.size, 0);

    for (const waiting_ of gate.splice(0)) {
      waiting_.open();
    }

    for (const held_ of four) {
      assert.equal((await held_.answered).status, 200);
      await held_.body;
    }

    await until(() => places.taken === 0, 'every place is given back');

    // And with a place free, a waiting call that finds its request writes it.
    const afterwards = call(`/api/sessions/${empty}/requests?wait=10&include=body`);

    assert.equal((await afterwards.answered).status, 200);
    assert.equal(
      (JSON.parse(await afterwards.body) as RequestListEntry[])[0]?.body,
      'arrived while every place was taken',
    );
    assert.equal(places.taken, 0);
  });

  it('gives the place back at once when its client goes during the list statement', async (t) => {
    const sessionId = await createSession();

    await capture(sessionId, 'a body whose client goes before it is listed');
    listHeld.add(sessionId);
    // On a failure too, nothing this test holds is left to the tests after it.
    t.after(() => {
      releaseLists(sessionId);

      for (const waiting of gate.splice(0)) {
        waiting.open();
      }
    });

    // Counted from here: a test before this one may have let one through.
    const answeredBefore = listsAnswered;
    const from = logged.length;

    // Two lists and two queries, their places taken and their list
    // statements held: each query's in a connection of its own, in a place
    // of the header-only queries' count, since neither has a condition (D250).
    const four = [
      call(`/api/sessions/${sessionId}/requests?include=body`),
      call(`/api/sessions/${sessionId}/requests?include=headers,body&order=asc`),
      call(`/api/sessions/${sessionId}/requests/query`, { include: ['body'] }),
      call(`/api/sessions/${sessionId}/requests/query`, { include: ['headers', 'body'] }),
    ];

    await until(
      () => places.taken === 4 && listGate.length === 4,
      'four calls hold a place, their list statements held',
    );

    for (const one of four) {
      one.destroy();
    }

    // Given back with every statement still held: a client gone does not
    // keep its place until its statement settles.
    await until(() => places.taken === 0, 'the departed clients give their places back');
    assert.equal(listGate.length, 4, 'the list statements are still held');

    // So a fifth is accepted while those statements are held.
    const fifthSession = await heldSession();
    const fifth = call(`/api/sessions/${fifthSession}/requests?include=body`);

    await until(() => places.taken === 1 && gate.length === 1, 'a fifth answer holds a place');

    // The statements settle now, and their answers go to no one. A place
    // they gave back already is not given back again: three more answers
    // fill the four places, and the one after them is refused.
    for (const open of listGate.splice(0)) {
      open();
    }

    await until(
      () => listsAnswered === answeredBefore + 4,
      'the four list statements have answered',
    );
    await delay(200);
    assert.equal(places.taken, 1, 'a place given back again, or still kept');

    // Each departed client is logged once, at `info`, as D174 logs a client
    // that gave up, and no answer is begun for it: no `Unhandled error` and
    // `500` for a query, no `stream closed prematurely` for a list, no
    // `request completed` (#212).
    await until(() => {
      const trails = trailsSince(from, sessionId);

      return trails.length === 4 && trails.every((trail) => trail.length > 1);
    }, 'the four calls have logged what became of them');
    assert.deepEqual(trailsSince(from, sessionId), [
      ['GET /requests?include=body', `${INFO} ${ABORTED}`],
      ['GET /requests?include=headers,body&order=asc', `${INFO} ${ABORTED}`],
      ['POST /requests/query', `${INFO} ${ABORTED}`],
      ['POST /requests/query', `${INFO} ${ABORTED}`],
    ]);
    assert.deepEqual(seriousSince(from), []);

    const more = [
      call(`/api/sessions/${fifthSession}/requests?include=body`),
      call(`/api/sessions/${fifthSession}/requests/query`, { include: ['body'] }),
      call(`/api/sessions/${fifthSession}/requests?include=headers,body`),
    ];

    await until(() => places.taken === 4 && gate.length === 4, 'four answers hold a place');
    await refusedAtOnce(call(`/api/sessions/${fifthSession}/requests?include=body`));

    for (const waiting of gate.splice(0)) {
      waiting.open();
    }

    for (const one of [fifth, ...more]) {
      assert.equal((await one.answered).status, 200);
      assert.equal(
        (JSON.parse(await one.body) as RequestListEntry[])[0]?.body,
        `the body of ${fifthSession}`,
      );
    }

    await until(() => places.taken === 0, 'every place is given back');
    assert.deepEqual(seriousSince(from), []);
    listHeld.delete(sessionId);
  });

  it('logs a client that leaves as soon as its request is written once, at info, before its list statement began, on both routes (#212)', async (t) => {
    const sessionId = await createSession();

    await capture(sessionId, 'a body whose clients leave at once');
    listHeld.add(sessionId);
    t.after(() => releaseLists(sessionId));

    const answeredBefore = listsAnswered;
    const from = logged.length;

    // Each request written whole and its connection closed at once; each list
    // statement held before it is sent until the server has seen every close.
    await Promise.all([
      leftAtOnce(rawList(sessionId, 'body')),
      leftAtOnce(rawList(sessionId, 'headers,body')),
      leftAtOnce(rawQuery(sessionId, ['body'])),
      leftAtOnce(rawQuery(sessionId, ['headers', 'body'])),
    ]);
    await until(
      () => listGate.length === 4 && places.taken === 0,
      'four list statements are held and every client is gone',
    );

    for (const open of listGate.splice(0)) {
      open();
    }

    await until(() => listsAnswered === answeredBefore + 4, 'the four statements have answered');
    await until(() => callPlaces.taken === 0, 'the four handlers have settled');
    assert.deepEqual(trailsSince(from, sessionId), [
      ['GET /requests?include=body', `${INFO} ${ABORTED}`],
      ['GET /requests?include=headers,body', `${INFO} ${ABORTED}`],
      ['POST /requests/query', `${INFO} ${ABORTED}`],
      ['POST /requests/query', `${INFO} ${ABORTED}`],
    ]);
    assert.deepEqual(seriousSince(from), []);
    // No answer was begun: nothing was read for one.
    await delay(SETTLE_MS);
    assert.equal(statementsOf(sessionId).contentReads, 0);
  });

  it('logs no error for lists with bodies whose clients leave as soon as their requests are written, round after round, on both routes (#212)', async () => {
    const sessionId = await createSession();

    await capture(sessionId, 'a body whose clients keep leaving');

    const from = logged.length;
    const rounds = 8;

    // Nothing held: each client is gone whenever the server sees its close,
    // before its statement, while it runs, or once the answer has begun. A
    // round is over once each of its calls has logged what became of it and
    // given its places back, so that no round finds the places, or those of
    // the header-only queries its queries take (D250), taken by the one before.
    for (let round = 1; round <= rounds; round += 1) {
      await Promise.all([
        leftAtOnce(rawList(sessionId, 'body')),
        leftAtOnce(rawList(sessionId, 'headers,body')),
        leftAtOnce(rawQuery(sessionId, ['body'])),
        leftAtOnce(rawQuery(sessionId, ['headers', 'body'])),
      ]);
      await until(() => {
        const trails = trailsSince(from, sessionId);

        return (
          trails.length === round * 4 &&
          trails.every((trail) => trail.length > 1) &&
          places.taken === 0 &&
          callPlaces.taken === 0
        );
      }, `round ${round} is over`);
    }

    // Each call is logged once, at `info`: aborted if its answer was not
    // begun, cut off if it was.
    for (const trail of trailsSince(from, sessionId)) {
      assert.equal(trail.length, 2, JSON.stringify(trail));
      assert.ok(
        [`${INFO} ${ABORTED}`, `${INFO} ${CUT_OFF} 200`].includes(trail[1] ?? ''),
        JSON.stringify(trail),
      );
    }

    assert.deepEqual(seriousSince(from), []);
  });

  it('logs an answer with bodies whose client goes once its head is written at info, cut off, on both routes (#212)', async () => {
    const sessionId = await heldSession();
    const from = logged.length;
    const cut = [
      call(`/api/sessions/${sessionId}/requests?include=body`),
      call(`/api/sessions/${sessionId}/requests/query`, { include: ['body'] }),
    ];

    // Each answer's head has arrived and its content read is held.
    await until(
      () => places.taken === 2 && gate.length === 2,
      'two answers hold a place, their reads held',
    );

    for (const one of cut) {
      assert.equal((await one.answered).status, 200);
      one.destroy();
    }

    await until(() => places.taken === 0, 'the departed clients give their places back');

    for (const waiting of gate.splice(0)) {
      waiting.open();
    }

    await until(() => callPlaces.taken === 0, 'the two handlers have settled');
    await delay(SETTLE_MS);
    assert.deepEqual(trailsSince(from, sessionId), [
      ['GET /requests?include=body', `${INFO} ${CUT_OFF} 200`],
      ['POST /requests/query', `${INFO} ${CUT_OFF} 200`],
    ]);
    assert.deepEqual(seriousSince(from), []);
  });

  it('still logs a list statement that fails as an Unhandled error once its client has gone, on both routes (D174, #212)', async (t) => {
    const sessionId = await createSession();

    await capture(sessionId, 'a body whose list statement fails');
    listHeld.add(sessionId);
    listFailing.add(sessionId);
    t.after(() => {
      listFailing.delete(sessionId);
      releaseLists(sessionId);
    });

    const answeredBefore = listsAnswered;
    const from = logged.length;
    const left = [
      call(`/api/sessions/${sessionId}/requests?include=body`),
      call(`/api/sessions/${sessionId}/requests/query`, { include: ['body'] }),
    ];

    await until(
      () => places.taken === 2 && listGate.length === 2,
      'a list and a query hold a place, their statements held',
    );

    for (const one of left) {
      one.destroy();
    }

    await until(() => places.taken === 0, 'the departed clients give their places back');

    for (const open of listGate.splice(0)) {
      open();
    }

    await until(() => listsAnswered === answeredBefore + 2, 'the two statements have failed');
    await until(() => callPlaces.taken === 0, 'the two handlers have settled');

    // A request that arrived whole and failed is a server fault whether or
    // not its client is still there to be answered: D174's error handler is
    // unchanged, and only an answer not begun for a client gone is `info`.
    assert.deepEqual(trailsSince(from, sessionId), [
      ['GET /requests?include=body', `${ERROR} Unhandled error`],
      ['POST /requests/query', `${ERROR} Unhandled error`],
    ]);
  });

  // Each count a query takes its place in (D250): the header-only queries',
  // for a query without a condition, and the search's, for one with a body
  // condition that the request's body holds.
  for (const { count, limit, conditions, sharesSearchPlaces } of [
    {
      count: "the header-only queries'",
      limit: MAX_CONCURRENT_HEADER_QUERIES,
      conditions: {},
      sharesSearchPlaces: false,
    },
    {
      count: "the search's",
      limit: MAX_CONCURRENT_SEARCHES,
      conditions: { body: ['queries are left'] },
      sharesSearchPlaces: true,
    },
  ]) {
    it(`keeps a query's place of ${count} count until its statement settles when its client goes, and gives it back once (#141, D191, D250)`, async (t) => {
      // One query beyond the count must still find a list place, to meet
      // the count's refusal rather than 1016's.
      assert.ok(limit < MAX_CONCURRENT_BODY_LISTS, 'a count this test cannot fill');

      const sessionId = await createSession();

      await capture(sessionId, 'a body whose queries are left');
      listHeld.add(sessionId);
      t.after(() => releaseLists(sessionId));

      const query = (): Call =>
        call(`/api/sessions/${sessionId}/requests/query`, { ...conditions, include: ['body'] });
      const answeredBefore = listsAnswered;

      // As many queries with bodies as the count holds, each holding a list
      // place and a place of the count, their statements held; then their
      // clients go.
      const left = Array.from({ length: limit }, query);

      await until(
        () => places.taken === limit && listGate.length === limit,
        'the queries hold a list place and a place of the count, their statements held',
      );

      for (const one of left) {
        one.destroy();
      }

      // The list places come back at once (D201 point 8)...
      await until(() => places.taken === 0, 'the departed clients give their list places back');
      assert.equal(listGate.length, limit, 'the statements are still held');

      // ...the places of the count do not: one more query is refused, and
      // gives back the list place it took before asking for one of them.
      await refusedForSlots(query(), limit);
      await until(() => places.taken === 0, 'the refused query gives its list place back');

      // And they are places of that count alone: a search, whose statement
      // is not held, finds the search's places taken by queries with a body
      // condition, and free beside queries without one.
      const searched = call(`/api/sessions/${sessionId}/requests/search`, {
        words: ['queries'],
      });
      const searchedHead = await searched.answered;
      const searchedBody = JSON.parse(await searched.body) as { errorCode?: number };

      if (sharesSearchPlaces) {
        assert.equal(searchedHead.status, 429);
        assert.equal(searchedHead.headers['retry-after'], '1');
        assert.equal(searchedBody.errorCode, ErrorCode.SEARCH_BUSY);
      } else {
        assert.equal(
          searchedHead.status,
          200,
          'a search was refused beside queries without a body condition',
        );
      }

      // The statements settle, to nobody.
      for (const open of listGate.splice(0)) {
        open();
      }

      await until(
        () => listsAnswered === answeredBefore + limit,
        'the abandoned statements have answered',
      );
      // A place of the count comes back after its statement's transaction
      // ends, before the handler settles; a handler gives its call place back
      // only once settled (D213), so no call place left means every place of
      // the count is back.
      await until(() => callPlaces.taken === 0, 'the abandoned queries have settled');

      // Each came back once: as many queries as the count holds are let
      // through - held at their statements here - and one more is refused
      // again.
      const next = Array.from({ length: limit }, query);

      await until(
        () => places.taken === limit && listGate.length === limit,
        'the queries take every place of the count again',
      );

      await refusedForSlots(query(), limit);
      releaseLists(sessionId);

      for (const one of next) {
        assert.equal((await one.answered).status, 200);
        assert.equal(
          (JSON.parse(await one.body) as RequestListEntry[])[0]?.body,
          'a body whose queries are left',
        );
      }

      await until(() => places.taken === 0, 'every place is given back');
    });
  }

  it('reads no content for a list with bodies whose client went before its statement settled, on both routes (#141)', async (t) => {
    const sessionId = await createSession();

    await capture(sessionId, 'a body nobody is left to read');
    listHeld.add(sessionId);
    t.after(() => releaseLists(sessionId));

    const answeredBefore = listsAnswered;
    const left = [
      call(`/api/sessions/${sessionId}/requests?include=body`),
      call(`/api/sessions/${sessionId}/requests?include=headers,body&order=asc`),
      call(`/api/sessions/${sessionId}/requests/query`, { include: ['body'] }),
    ];

    await until(
      () => places.taken === 3 && listGate.length === 3,
      'two lists and a query hold a place, their statements held',
    );

    for (const one of left) {
      one.destroy();
    }

    await until(() => places.taken === 0, 'the departed clients give their places back');

    for (const open of listGate.splice(0)) {
      open();
    }

    await until(() => listsAnswered === answeredBefore + 3, 'the three statements have answered');
    await until(() => callPlaces.taken === 0, 'the three handlers have settled');
    // Long enough for an answer begun anyway to have read its first body.
    await delay(SETTLE_MS);
    assert.equal(statementsOf(sessionId).contentReads, 0, 'content read for a client gone');

    // The count sees a read: a client that stays is written its body, once.
    listHeld.delete(sessionId);

    const stayed = call(`/api/sessions/${sessionId}/requests?include=body`);

    assert.equal((await stayed.answered).status, 200);
    assert.equal(
      (JSON.parse(await stayed.body) as RequestListEntry[])[0]?.body,
      'a body nobody is left to read',
    );
    assert.equal(statementsOf(sessionId).contentReads, 1);
    await until(() => places.taken === 0, 'every place is given back');
  });

  it("keeps its address's call place until an abandoned list's statement settles, then gives it back once (#141, D213)", async (t) => {
    const sessionId = await createSession();

    await capture(sessionId, 'a body whose list is left');
    listHeld.add(sessionId);
    t.after(() => releaseLists(sessionId));
    await until(() => callPlaces.taken === 0, 'no call holds a place');

    const answeredBefore = listsAnswered;
    const left = call(`/api/sessions/${sessionId}/requests?include=body`);

    await until(
      () => places.taken === 1 && listGate.length === 1 && callPlaces.takenBy(LOCAL) === 1,
      'the list holds a list place and a call place, its statement held',
    );
    left.destroy();

    // The list place comes back at once; the call place stays with the
    // handler, which still waits for its statement.
    await until(() => places.taken === 0, 'the departed client gives its list place back');
    await delay(200);
    assert.equal(
      callPlaces.takenBy(LOCAL),
      1,
      'the call place went with the client while its statement still ran',
    );

    listGate.shift()?.();
    await until(() => listsAnswered === answeredBefore + 1, 'the statement has answered');
    await until(() => callPlaces.takenBy(LOCAL) === 0, 'the call place comes back once it settles');

    // Given back once: a call held now counts one place, and none once answered.
    const next = call(`/api/sessions/${sessionId}/requests?include=body`);

    await until(
      () => listGate.length === 1 && callPlaces.takenBy(LOCAL) === 1,
      'the next list holds one call place',
    );
    listHeld.delete(sessionId);
    listGate.shift()?.();
    assert.equal((await next.answered).status, 200);
    assert.equal(
      (JSON.parse(await next.body) as RequestListEntry[])[0]?.body,
      'a body whose list is left',
    );
    await until(() => callPlaces.taken === 0, 'every call place is given back');
    await until(() => places.taken === 0, 'every place is given back');
  });

  // Last in the file: on a route that keeps a place it could not give back,
  // the places it leaks would be missing from every test after it.
  it('gives the place back when an answer with bodies fails before it is begun', async (t) => {
    const sessionId = await createSession();

    await capture(sessionId, 'a body whose answer is never begun');

    // The answer's stream cannot be made: the throw comes after its place is
    // taken and its list statement has run, before the stream that would
    // give the place back exists. Nothing else on these routes passes an
    // async generator to `Readable.from`.
    const from = Readable.from.bind(Readable);

    t.mock.method(
      Readable,
      'from',
      (iterable: Iterable<unknown> | AsyncIterable<unknown>, options?: ReadableOptions) => {
        if (Object.prototype.toString.call(iterable) === '[object AsyncGenerator]') {
          throw new Error('the answer could not be begun');
        }

        return from(iterable, options);
      },
    );

    const targets = [
      'list',
      // Held by `wait` and answered at once: the session holds a request.
      'waiting list',
      'query',
    ] as const;
    const kept: [string, number][] = [];

    for (const target of targets) {
      const before = places.taken;
      const failed =
        target === 'query'
          ? call(`/api/sessions/${sessionId}/requests/query`, { include: ['body'] })
          : call(
              `/api/sessions/${sessionId}/requests?include=headers,body${target === 'list' ? '' : '&wait=10'}`,
            );

      assert.equal((await failed.answered).status, 500, target);
      await failed.body;
      kept.push([target, places.taken - before]);
    }

    // Places each route kept after its answer: none.
    assert.deepEqual(
      kept,
      targets.map((target) => [target, 0]),
    );
  });
});
