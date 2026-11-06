/**
 * What a pending `wait_for_request` keeps of the `POST` that asked for it
 * (D203). A wait holds its request for up to 30 s,
 * and the shared limits let one address have hundreds pending, so it must keep
 * only values built afresh from what its checks let through - never the body,
 * which can be valid JSON of nearly 1 MiB, nor the message parsed from it,
 * whose objects can be far larger inside V8 than they look: an object read
 * with 100,000 duplicate keys has two keys to `Object.keys` and megabytes of
 * property table behind them.
 *
 * Over real sockets, not Fastify's injection, whose made-up request keeps the
 * payload it was given for as long as the request lives. For each shape below,
 * sixteen waits are made pending at once, each sent as a body of 1,000,000
 * bytes with an id of the longest length allowed, every argument the wait
 * takes, and the rest of the body built to make the parsed message large.
 * With all of them pending and the garbage collected, each body's buffer must
 * be gone - a `WeakRef` to it, taken as the handler is reached, is cleared -
 * and the process must hold at most `PER_WAIT_BYTES` more per wait than before
 * they began: about twice what a wait with a plain body of under 500 bytes
 * holds, its socket, request, reply, subscription and timer. An earlier
 * version of the code held about 6 MiB a wait with the duplicate `wait` keys.
 * Before its baseline, each shape makes one round of its own calls and clears
 * it, so what its parsing and checks compile and keep for good is not counted
 * against its waits; the report gives the growth of each heap space as well
 * (`docs/testing/flakes.md`, F-18).
 *
 * And a wait whose URL carries a query string, which the request would keep
 * as long as it waits: while its body was still read, the two shapes below
 * held about 61 and 81 KiB a wait here. It is refused before its body
 * is read now, so no body reaches the handler, nothing waits, and nothing is
 * held.
 *
 * And the strings a call keeps without a copy of its own - a header
 * condition's value, a configured response's headers and body - are copies
 * JSON.parse made, not slices of the text it read: measured here too.
 *
 * The collector is exposed inside this file's own process with
 * `v8.setFlagsFromString` and a new context's `gc`, so the test needs no flag
 * on the command line and runs the same through the workspace script or on
 * its own. Bytecode flushing is turned off the same way: V8 drops the bytecode
 * of a function that has not run for six collections and compiles it again
 * when it next runs, about 5 MiB in this process, which the many collections
 * here would otherwise move between a baseline and its reading.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import v8 from 'node:v8';
import vm from 'node:vm';
import type pg from 'pg';
import { MCP_PATH, MCP_REQUEST_ID_MAX_LENGTH } from '@webhook-inspector/shared/mcp';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { PendingWaits } from '../requests/wait.ts';
import { createLargeBodyPlaces } from '../sessions/large-bodies.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import { parseMessage } from './protocol.ts';
import { QUERY_STRING_REFUSED } from './routes.ts';

v8.setFlagsFromString('--expose-gc');
v8.setFlagsFromString('--no-flush-bytecode');

const collectGarbage = vm.runInNewContext('gc') as () => void;

/** Waits pending at once, for each shape. */
const WAITS = 16;

/** The size of each body: under the listener's 1 MiB. */
const BODY_BYTES = 1_000_000;

/**
 * What a pending wait may add to the process, at most: the heap and the
 * memory behind buffers, once collected. A wait with a plain body holds 20 to
 * 25 KiB here.
 */
const PER_WAIT_BYTES = 48 * 1024;

/** What a string of about 200 characters kept from a parsed body may add, at most. */
const PER_STRING_BYTES = 16 * 1024;

let pool: pg.Pool;
let servers: TestServers;
let endpoint: URL;
const waits = new PendingWaits();
const createdSessionIds: string[] = [];
/** A weak reference to the body of every `/mcp` request, taken as its handler is reached. */
const bodies: WeakRef<Buffer>[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    servers = buildTestServers(pool, {
      waits,
      rateLimits: LIMITS_OUT_OF_REACH,
      // A place among the large bodies for each call of a round. The
      // process's eight (D205, D213) refuse a ninth body still being read at
      // once, `429` / `1017`, and sixteen bodies of 1,000,000 bytes sent at
      // once overlap that far when the process is slow, so that calls meant
      // to wait never do (F-18). Each gives its place back once its message
      // is read, before it waits: none is held when anything is measured.
      largeBodyPlaces: createLargeBodyPlaces(WAITS),
      logDestination: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    });
    // On the root, before the listener is ready, so the `/mcp` scope has it
    // too. Weak: it keeps nothing alive itself. By the route, so that a URL
    // with a query string that reached the handler would be counted too.
    servers.api.addHook('preHandler', async (request) => {
      if (request.routeOptions.url === MCP_PATH && Buffer.isBuffer(request.body)) {
        bodies.push(new WeakRef(request.body));
      }
    });
    await servers.receiver.ready();
    await servers.api.listen({ host: '127.0.0.1', port: 0 });
    endpoint = new URL(
      `http://127.0.0.1:${(servers.api.server.address() as AddressInfo).port}${MCP_PATH}`,
    );
  })();
  await startup;
});

after(async () => {
  await startup;
  // Anything still waiting after a failure is answered at once, so the
  // listener can close.
  waits.close();

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers?.close();
  await pool?.end();
});

interface Answer {
  status: number;
  body: {
    id?: unknown;
    result?: {
      isError?: boolean;
      content?: { text?: string }[];
      structuredContent?: Record<string, unknown>;
    };
  };
}

/**
 * Sends `body` to `/mcp`, with `query` after a `?` when given, and answers
 * the promise of its answer, read whole. No closure here refers to `body`, so
 * the test itself keeps no copy of it once it is written.
 */
function post(body: string, query?: string): Promise<Answer> {
  const request = http.request(query === undefined ? endpoint : `${endpoint.href}?${query}`, {
    method: 'POST',
    agent: false,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      'content-length': Buffer.byteLength(body),
    },
  });
  const answer = new Promise<Answer>((resolve, reject) => {
    request.on('error', reject);
    request.on('response', (response) => {
      const chunks: Buffer[] = [];

      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Answer['body'],
        });
      });
      response.on('error', reject);
    });
  });

  request.end(body);

  return answer;
}

function callText(id: string, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

/** A session holding one request, whose id a wait's `after` names: the wait then waits. */
async function sessionWithRequest(): Promise<WaitArguments> {
  const created = await post(callText('create', 'create_session', {}));
  const sessionId = created.body.result?.structuredContent?.sessionId;

  assert.equal(typeof sessionId, 'string', JSON.stringify(created.body));
  createdSessionIds.push(sessionId as string);

  const captured = await servers.receiver.inject({
    method: 'POST',
    url: `/s/${sessionId as string}`,
    headers: { 'content-type': 'application/json' },
    payload: '{"event":"order.paid"}',
  });
  const requestId = captured.headers['x-qa-tools-request-id'];

  assert.equal(typeof requestId, 'string', captured.body);

  return {
    sessionId: sessionId as string,
    after: requestId as string,
    order: 'desc',
    limit: 50,
    wait: 30,
  };
}

/** Every argument `wait_for_request` takes. */
interface WaitArguments {
  sessionId: string;
  after: string;
  order: 'desc';
  limit: number;
  wait: number;
}

/** `JSON.stringify(args)` without its closing brace, for keys to follow. */
function openArguments(args: WaitArguments): string {
  return JSON.stringify(args).slice(0, -1);
}

/**
 * The text `build` makes with as many `unit`s in its one gap as keep it within
 * `BODY_BYTES`.
 */
function filled(build: (filler: string) => string, unit: string): string {
  const room = BODY_BYTES - Buffer.byteLength(build(''));

  return build(unit.repeat(Math.floor(room / Buffer.byteLength(unit))));
}

/** `,"<prefix>0":0,"<prefix>1":0,…`: distinct keys within `room` bytes. */
function distinctKeys(prefix: string, room: number): string {
  const keys: string[] = [];
  let length = 0;

  for (let index = 0; ; index += 1) {
    const key = `,"${prefix}${index}":0`;

    if (length + key.length > room) {
      return keys.join('');
    }

    keys.push(key);
    length += key.length;
  }
}

/** The text `build` makes with distinct keys in its gap, within `BODY_BYTES`. */
function withDistinctKeys(build: (keys: string) => string, prefix: string): string {
  return build(distinctKeys(prefix, BODY_BYTES - Buffer.byteLength(build(''))));
}

/** An id of the longest length allowed, unique by `label` and `index`. */
function longId(label: string, index: number, character = 'i'): string {
  const prefix = `${label}-${index}-`;

  return prefix + character.repeat(MCP_REQUEST_ID_MAX_LENGTH - prefix.length);
}

interface Shape {
  name: string;
  /** The body of the wait numbered `index`, with the id it carries. */
  body(id: string, args: WaitArguments): string;
  /** The id of the wait numbered `index`. */
  id?: (index: number) => string;
  /** `true` when the call is refused at once, for its arguments, rather than left to wait. */
  refused?: boolean;
  /**
   * A query string the URL carries: the transport refuses the request before
   * its body is read, so no body reaches the handler at all.
   */
  query?: string;
}

const SHAPES: Shape[] = [
  {
    name: 'a plain body of under 500 bytes, for reference',
    body: (id, args) => callText(id, 'wait_for_request', { ...args }),
  },
  {
    name: 'white space between the members',
    body: (id, args) =>
      filled(
        (filler) =>
          `{"jsonrpc":"2.0",${filler}"id":${JSON.stringify(id)},"method":"tools/call","params":{"name":"wait_for_request","arguments":${JSON.stringify(args)}}}`,
        ' ',
      ),
  },
  {
    // Keys repeated inside `arguments`: Object.keys sees only the five arguments.
    name: 'about 99,000 duplicate wait keys in arguments',
    body: (id, args) =>
      filled(
        (filler) =>
          `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"tools/call","params":{"name":"wait_for_request","arguments":${openArguments(args)}${filler}}}}`,
        ',"wait":30',
      ),
  },
  {
    name: 'duplicate name and arguments keys in params',
    body: (id, args) =>
      filled(
        (filler) =>
          `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"tools/call","params":{"name":"wait_for_request"${filler},"arguments":${JSON.stringify(args)}}}`,
        `,"name":"wait_for_request","arguments":${JSON.stringify(args)}`,
      ),
  },
  {
    name: 'duplicate keys at the top level',
    body: (id, args) =>
      filled(
        (filler) =>
          `{"jsonrpc":"2.0"${filler},"id":${JSON.stringify(id)},"method":"tools/call","params":{"name":"wait_for_request","arguments":${JSON.stringify(args)}}}`,
        ',"jsonrpc":"2.0","method":"tools/call"',
      ),
  },
  {
    name: 'a _meta of 300,000 characters and some 70,000 objects',
    body: (id, args) =>
      filled(
        (filler) =>
          `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"tools/call","params":{"name":"wait_for_request","arguments":${JSON.stringify(args)},"_meta":{"progressToken":"${'p'.repeat(300_000)}","items":[${filler}{}]}}}`,
        '{"k":"v"},',
      ),
  },
  {
    name: 'some 70,000 distinct unknown keys in params, accepted',
    body: (id, args) =>
      withDistinctKeys(
        (keys) =>
          `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"tools/call","params":{"name":"wait_for_request","arguments":${JSON.stringify(args)}${keys}}}`,
        'u',
      ),
  },
  {
    name: 'some 70,000 distinct unknown keys at the top level, accepted',
    body: (id, args) =>
      withDistinctKeys(
        (keys) =>
          `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"tools/call","params":{"name":"wait_for_request","arguments":${JSON.stringify(args)}}${keys}}`,
        'u',
      ),
  },
  {
    name: 'ids of 256 two-byte characters, padded with white space',
    id: (index) => longId('я', index, 'я'),
    body: (id, args) =>
      filled((filler) => `${callText(id, 'wait_for_request', { ...args })}${filler}`, ' '),
  },
  {
    name: 'a query string of 15,000 characters, refused before the body',
    query: `q=${'x'.repeat(14_998)}`,
    body: (id, args) => callText(id, 'wait_for_request', { ...args }),
  },
  {
    name: 'a query string of 3,000 duplicate keys, refused before the body',
    query: Array.from({ length: 3000 }, () => 'a=1').join('&'),
    body: (id, args) => callText(id, 'wait_for_request', { ...args }),
  },
  {
    name: 'some 70,000 distinct unknown keys in arguments, refused',
    refused: true,
    body: (id, args) =>
      withDistinctKeys(
        (keys) =>
          `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"tools/call","params":{"name":"wait_for_request","arguments":${openArguments(args)}${keys}}}}`,
        'u',
      ),
  },
];

/** What the process holds once the garbage is collected. */
interface Held {
  /** The V8 heap and the memory behind buffers: what a limit is held to. */
  bytes: number;
  /** The memory behind buffers alone. */
  arrayBuffers: number;
  /** What each of the heap's spaces holds, by its name. */
  spaces: Map<string, number>;
}

/**
 * What the process holds once the garbage is collected: the V8 heap and the
 * memory behind buffers, and the heap space by space, for the report. Each
 * collection runs in a job of its own, since a `WeakRef` read or made in a job
 * keeps its target until the job ends.
 */
async function held(): Promise<Held> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    collectGarbage();
  }

  const { heapUsed, arrayBuffers } = process.memoryUsage();

  return {
    bytes: heapUsed + arrayBuffers,
    arrayBuffers,
    spaces: new Map(
      v8.getHeapSpaceStatistics().map((space) => [space.space_name, space.space_used_size]),
    ),
  };
}

function signedKiB(bytes: number): string {
  return `${bytes < 0 ? '-' : '+'}${(Math.abs(bytes) / 1024).toFixed(1)} KiB`;
}

/**
 * What grew or shrank from `baseline` to `reading`, in each heap space that
 * moved and in the memory behind buffers: `old_space +310.2 KiB, …`.
 */
function growth(baseline: Held, reading: Held): string {
  const spaces = [...reading.spaces]
    .map(([name, used]) => [name, used - (baseline.spaces.get(name) ?? 0)] as const)
    .filter(([, change]) => change !== 0)
    .map(([name, change]) => `${name} ${signedKiB(change)}`);

  return [
    ...spaces,
    `array buffers ${signedKiB(reading.arrayBuffers - baseline.arrayBuffers)}`,
  ].join(', ');
}

/**
 * Waits, for at most 10 s, until `waits` has `count` pending and the pool has
 * no query in flight. A wait is counted once it has subscribed, before its
 * first read has run; a clear that commits while that read is still queued for
 * one of the pool's ten connections would leave it no request to read after,
 * and the wait would answer `1003` rather than `[]` (D200). Nothing else in
 * this file uses the pool meanwhile.
 */
async function pendingReach(count: number): Promise<void> {
  const settled = (): boolean =>
    waits.size === count && pool.waitingCount === 0 && pool.idleCount === pool.totalCount;
  const started = Date.now();

  for (let tries = 0; !settled() && tries < 1000; tries += 1) {
    await delay(10);
  }

  const after = `after ${Date.now() - started} ms`;

  assert.equal(waits.size, count, `waits pending ${after}`);
  assert.equal(pool.waitingCount, 0, `queries waiting for a connection ${after}`);
  assert.equal(pool.idleCount, pool.totalCount, `connections idle ${after}`);
}

/** Clears the session, which ends every wait on it with `[]` (D200). */
async function clear(sessionId: string): Promise<void> {
  const cleared = await post(callText('clear', 'clear_requests', { sessionId }));

  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
}

/**
 * The same sixteen waits with small bodies, pending and then ended: every
 * path a wait takes run once and the pool's connections opened, before any
 * baseline.
 */
async function warmUp(): Promise<void> {
  const args = await sessionWithRequest();
  const pending = Array.from({ length: WAITS }, (_, index) =>
    post(callText(`warm-${index}`, 'wait_for_request', { ...args })),
  );

  await pendingReach(WAITS);
  await clear(args.sessionId);

  for (const answer of await Promise.all(pending)) {
    assert.deepEqual(
      answer.body.result?.structuredContent?.requests,
      [],
      JSON.stringify(answer.body),
    );
  }
}

/**
 * `true` when the shape's calls are answered at once, with nothing left
 * waiting: refused for their arguments, or by the transport for their query
 * string.
 */
function answeredAtOnce(shape: Shape): boolean {
  return shape.refused === true || shape.query !== undefined;
}

/** The ids of a round of the shape's calls, those `label` makes unless the shape has its own. */
function roundIds(shape: Shape, label: string): string[] {
  return Array.from({ length: WAITS }, (_, index) =>
    shape.id === undefined ? longId(label, index) : shape.id(index),
  );
}

/** That every call of a round, once ended, was answered as the shape is. */
function assertAnswers(shape: Shape, ids: string[], answers: Answer[]): void {
  answers.forEach((answer, index) => {
    if (shape.query !== undefined) {
      assert.equal(answer.status, 400);
      assert.deepEqual(answer.body, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: QUERY_STRING_REFUSED },
      });

      return;
    }

    assert.equal(answer.status, 200);
    assert.equal(answer.body.id, ids[index]);

    if (shape.refused === true) {
      assert.equal(answer.body.result?.isError, true);
      assert.equal(
        answer.body.result?.content?.[0]?.text,
        'Invalid arguments: wait_for_request takes no argument other than sessionId, wait, after, limit and order',
      );
    } else {
      assert.deepEqual(
        answer.body.result?.structuredContent?.requests,
        [],
        JSON.stringify(answer.body),
      );
    }
  });
}

/**
 * One round of the shape's own calls, on a session of its own, ended as the
 * measured round is: every wait pending and then cleared, or every call
 * answered at once. What the shape's parsing and checks compile and keep for
 * good - code, feedback, the hidden classes of what they build - is then in
 * place before a baseline is read, rather than counted against its waits.
 */
async function warmShape(shape: Shape, number: number): Promise<void> {
  const args = await sessionWithRequest();
  const ids = roundIds(shape, `w${number}`);
  const pending = ids.map((id) => post(shape.body(id, args), shape.query));

  try {
    if (!answeredAtOnce(shape)) {
      await pendingReach(WAITS);
    }
  } finally {
    // However it went, as the measured round's: none left pending.
    if (!answeredAtOnce(shape)) {
      await clear(args.sessionId);
    }

    await Promise.allSettled(pending);
  }

  assertAnswers(shape, ids, await Promise.all(pending));
  assert.equal(waits.size, 0);
}

describe('a pending wait_for_request (D203)', () => {
  before(warmUp);

  SHAPES.forEach((shape, number) => {
    it(`keeps at most ${PER_WAIT_BYTES / 1024} KiB and no body per wait: ${shape.name}`, async (t: TestContext) => {
      await warmShape(shape, number);

      const args = await sessionWithRequest();
      const ids = roundIds(shape, `s${number}`);

      // The same session's list, answered at once, from as many calls at
      // once: the pool's connections are in place before the baseline.
      await Promise.all(
        ids.map((_, index) =>
          post(
            callText(`list-${index}`, 'list_requests', {
              sessionId: args.sessionId,
              after: args.after,
            }),
          ),
        ),
      );

      const baseline = await held();
      const firstBody = bodies.length;
      const pending = ids.map((id) => post(shape.body(id, args), shape.query));

      try {
        if (answeredAtOnce(shape)) {
          await Promise.all(pending);
          assert.equal(waits.size, 0);
        } else {
          await pendingReach(WAITS);
        }

        // A request refused for its query string is answered before its body
        // is read: none reaches the handler.
        assert.equal(bodies.length - firstBody, shape.query === undefined ? WAITS : 0);

        const reading = await held();
        const more = reading.bytes - baseline.bytes;
        const kept = bodies.slice(firstBody).filter((body) => body.deref() !== undefined).length;
        const report = `${WAITS} ${answeredAtOnce(shape) ? 'refused calls' : 'pending waits'}: ${kept} bodies kept, ${(more / 1024 / 1024).toFixed(2)} MiB more held, ${(more / WAITS / 1024).toFixed(1)} KiB a call; ${growth(baseline, reading)}`;

        t.diagnostic(report);
        assert.equal(kept, 0, report);
        assert.ok(more <= WAITS * PER_WAIT_BYTES, report);
      } finally {
        // However the measurement went, a clear ends every wait with an
        // empty list (D200), and its answers are awaited, so the next shape
        // starts with none pending.
        if (!answeredAtOnce(shape)) {
          await clear(args.sessionId);
        }

        await Promise.allSettled(pending);
      }

      assertAnswers(shape, ids, await Promise.all(pending));
      assert.equal(waits.size, 0);
    });
  });
});

describe('a string JSON.parse reads out of a message (D203)', () => {
  it('is a copy, which keeps nothing of the text it was read from', async (t: TestContext) => {
    const value = 'v'.repeat(200);
    const kept: unknown[] = [];
    const baseline = (await held()).bytes;

    for (let index = 0; index < WAITS; index += 1) {
      const message = parseMessage(
        Buffer.from(
          `${callText(`json-${index}`, 'list_requests', {
            sessionId: 's'.repeat(43),
            headers: [{ name: 'x-event', value: `${value}${index}` }],
          })}${' '.repeat(BODY_BYTES)}`,
        ),
      );

      assert.equal(message.kind, 'request');

      // The value alone, as `parseHeaderConditions` keeps it.
      const args = (message.kind === 'request' ? message.params.arguments : null) as {
        headers: { value: string }[];
      };

      kept.push(args.headers[0]?.value);
    }

    const more = (await held()).bytes - baseline;
    const report = `${WAITS} strings of about ${value.length} characters kept from bodies of over ${BODY_BYTES} bytes: ${(more / 1024).toFixed(1)} KiB more held`;

    t.diagnostic(report);
    assert.equal(kept.length, WAITS);
    // A slice of the text would keep each body's million characters.
    assert.ok(more <= WAITS * PER_STRING_BYTES, report);
  });
});
