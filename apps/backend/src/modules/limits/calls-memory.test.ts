/**
 * What a call the application listener holds open keeps of its request
 * (D213), measured with the garbage collected, in the pattern of
 * `mcp-memory.test.ts` (D203).
 *
 * A pending `GET .../requests?wait=N` keeps its whole request for up to 30 s:
 * its URL and its header lines. Within Node's 16 KiB, about 990 short header
 * lines held about 100 KiB a wait; at most 100 lines are let in now, so a
 * wait with 100 lines and a URL of 13,000 bytes - as much of the 16 KiB as
 * the lines leave - must hold at most `PER_WAIT_BYTES`, and a request of
 * 1,000 lines is refused `431` and holds nothing. On the code before D213 the
 * last shape was pending, at about 100 KiB a wait. A shape's round that reads
 * over the bound is made again, up to three rounds, and the least reading is
 * held to it: a reading has caught a few hundred KiB of the process besides
 * the round's calls, once a round, under load (F-25 in
 * `docs/testing/flakes.md`).
 *
 * A `PUT .../response` waits for the session's row lock - behind a capture,
 * a change or a queue call - with its request in hand, and its body is up to
 * 1 MiB of text, decoded into a string of two bytes a character when one of
 * them is outside Latin-1. The body is let go once it is parsed now, so such
 * a call holds what it parsed, a response of at most 64 KiB of body and
 * 8 KiB of headers, and its request: at most `PER_CHANGE_BYTES`. Before D213
 * it held its whole body, about 2 MiB a call for the shapes below. All
 * eight wait for the lock in the database holding no slot of the gate in
 * front of the API's work, which a change gives back before it joins its
 * session's line and does without in its turn; their bodies were read and
 * parsed before the gate (D244).
 *
 * Over real sockets, not Fastify's injection, whose made-up request keeps the
 * payload it was given for as long as the request lives. The collector is
 * exposed inside this file's own process with `v8.setFlagsFromString` and a
 * new context's `gc`, and bytecode flushing is turned off the same way, as in
 * `mcp-memory.test.ts`.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import v8 from 'node:v8';
import vm from 'node:vm';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  MAX_BODY_BYTES,
  MAX_CONCURRENT_LARGE_BODIES,
  MAX_RESPONSE_BODY_BYTES,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildServer } from '../../server.ts';
import { ordinaryFullResponse } from '../../testing/full-queue.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import { PendingWaits } from '../requests/wait.ts';
import { API_WORK_SLOTS, createApiWorkSlots } from './api-work.ts';

v8.setFlagsFromString('--expose-gc');
v8.setFlagsFromString('--no-flush-bytecode');

const collectGarbage = vm.runInNewContext('gc') as () => void;

/** Waits pending at once, for each shape. */
const WAITS = 16;

/** What a pending wait may add to the process, at most: the issue's bound. */
const PER_WAIT_BYTES = 64 * 1024;

/** Changes waiting for their rows at once: every place of large bodies. */
const CHANGES = MAX_CONCURRENT_LARGE_BODIES;

/** What a change waiting for its row may add to the process, at most: the issue's bound. */
const PER_CHANGE_BYTES = 200 * 1024;

/** The size of each change's body: under the listener's 1 MiB. */
const CHANGE_BODY_BYTES = 1_000_000;

let pool: pg.Pool;
let servers: TestServers;
let port: number;
const waits = new PendingWaits();
/** The gate's slots, which no change waiting for its row holds (D244). */
const workSlots = createApiWorkSlots();
const createdSessionIds: string[] = [];
/** Every connection opened, so that none outlives the file. */
const sockets: net.Socket[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    servers = buildTestServers(pool, {
      waits,
      apiWorkSlots: workSlots,
      logDestination: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    });
    await servers.receiver.ready();
    await servers.api.listen({ host: '127.0.0.1', port: 0 });
    port = (servers.api.server.address() as net.AddressInfo).port;
  })();
  await startup;
});

after(async () => {
  await startup;
  waits.close();

  for (const socket of sockets) {
    socket.destroy();
  }

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers?.close();
  await pool?.end();
});

/** What the process holds once the garbage is collected. */
interface Held {
  /** The V8 heap and the memory behind buffers: what a bound is held to. */
  bytes: number;
  /** The memory behind buffers alone. */
  arrayBuffers: number;
  /** What each of the heap's spaces holds, by its name. */
  spaces: Map<string, number>;
}

/**
 * What the process holds once the garbage is collected: the V8 heap and the
 * memory behind buffers, and the heap space by space, for the report. Each
 * collection runs in a job of its own.
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

/** The bytes the process holds once the garbage is collected (`held`). */
async function heldBytes(): Promise<number> {
  return (await held()).bytes;
}

function signedKiB(bytes: number): string {
  return `${bytes < 0 ? '-' : '+'}${(Math.abs(bytes) / 1024).toFixed(1)} KiB`;
}

/**
 * What grew or shrank from `baseline` to `reading`, in each heap space that
 * moved and in the memory behind buffers: `old_space +690.2 KiB, …`.
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

async function createSession(): Promise<string> {
  const response = await servers.api.inject({
    method: 'POST',
    url: '/api/sessions',
    remoteAddress: '198.18.0.1',
  });

  assert.equal(response.statusCode, 201, response.body);

  const { id } = response.json() as { id: string };

  createdSessionIds.push(id);

  return id;
}

/** Waits until `check` holds, for 10 s at most. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
    await delay(10);
  }
}

/**
 * Sends `head` - a request line and header lines, `Connection: close` among
 * them, with no body - on a connection of its own, and answers the promise of
 * everything the server writes before it closes the connection. No closure
 * here refers to `head`, so the test itself keeps no copy of it once it is
 * written: what is measured is the server's.
 */
function rawRequest(head: string): Promise<string> {
  const socket = net.connect(port, '127.0.0.1');
  const chunks: Buffer[] = [];
  const answer = new Promise<string>((resolve) => {
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
  });

  sockets.push(socket);
  socket.write(head);

  return answer;
}

interface WaitShape {
  name: string;
  /** The header lines of the request, `Host` and `Connection: close` among them. */
  lines: number;
  /** The bytes of each header line's value after `x-N: `. */
  valueBytes?: number;
  /** The length of the request target, padded with `&`, which the list skips. */
  targetBytes?: number;
  /** `true` when the request is refused 431 before any route. */
  refused?: boolean;
}

const WAIT_SHAPES: WaitShape[] = [
  { name: 'two header lines, for reference', lines: 2 },
  { name: '100 header lines and a URL of 13,000 bytes', lines: 100, targetBytes: 13_000 },
  {
    name: '100 header lines of 150 bytes, as much of 16 KiB as they fit',
    lines: 100,
    valueBytes: 150,
  },
  {
    name: '1,000 short header lines, which 16 KiB allows: refused 431',
    lines: 1_000,
    refused: true,
  },
];

/** The request of a wait of `shape` on `sessionId`. */
function waitHead(sessionId: string, shape: WaitShape): string {
  const base = `/api/sessions/${sessionId}/requests?wait=30`;
  const target = base + '&'.repeat(Math.max(0, (shape.targetBytes ?? 0) - base.length));
  const head = [`GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close'];

  for (let line = 3; line <= shape.lines; line += 1) {
    head.push(`x-${line}: ${'y'.repeat(shape.valueBytes ?? 1)}`);
  }

  return `${head.join('\r\n')}\r\n\r\n`;
}

/** Clears the session, which ends every wait on it with `[]` (D200). */
async function clear(sessionId: string): Promise<void> {
  const cleared = await servers.api.inject({
    method: 'DELETE',
    url: `/api/sessions/${sessionId}/requests`,
    remoteAddress: '198.18.0.2',
  });

  assert.equal(cleared.statusCode, 204);
}

/**
 * Rounds of a wait shape, at most, before the least of their readings is
 * held to the bound (F-25). A wait that keeps more than `PER_WAIT_BYTES` is
 * over it in every round; a reading that caught something of the process
 * besides the round's calls is not repeated.
 */
const WAIT_ROUNDS = 3;

interface WaitReading {
  /** What the process held more with the round's calls settled than before them. */
  more: number;
  report: string;
}

/**
 * One round of `WAITS` calls of `shape` on a session of its own: the
 * baseline, the calls, each answered or pending, whichever its shape makes
 * it, and the reading. However it went, the session is then cleared and
 * every answer awaited before anything else, so that no wait of the round is
 * still pending when the next baseline is read, or is counted among the next
 * round's (F-25); and every call answered as its shape is.
 */
async function waitRound(shape: WaitShape): Promise<WaitReading> {
  const sessionId = await createSession();
  const head = waitHead(sessionId, shape);

  assert.ok(head.length < 16 * 1024, `${head.length} bytes of head`);

  const baseline = await held();
  let answered = 0;
  const answers = Array.from({ length: WAITS }, () =>
    rawRequest(head).then((answer) => {
      answered += 1;

      return answer;
    }),
  );
  let reading: Held;
  let pending: number;

  try {
    // Each call answered or pending, whichever its shape makes it: what is
    // measured is what the server does with it, not what it should.
    await until(() => answered + waits.size === WAITS, `${WAITS} calls are settled`);
    pending = waits.size;
    reading = await held();
  } finally {
    await clear(sessionId);
    await Promise.all(answers);
  }

  for (const answer of await Promise.all(answers)) {
    if (shape.refused === true) {
      assert.match(answer, /^HTTP\/1\.1 431 Request Header Fields Too Large\r\n/);
    } else {
      assert.match(answer, /^HTTP\/1\.1 200 OK\r\n/);
      assert.ok(answer.endsWith('\r\n\r\n[]'), answer.slice(-80));
    }
  }

  assert.equal(waits.size, 0);

  const more = reading.bytes - baseline.bytes;

  return {
    more,
    report: `${WAITS} calls, ${pending} pending: ${(more / 1024).toFixed(1)} KiB more held, ${(more / WAITS / 1024).toFixed(1)} KiB a call; ${growth(baseline, reading)}`,
  };
}

describe('a pending wait on the API (D213)', () => {
  before(async () => {
    // The same sixteen waits, pending and then ended: every path a wait
    // takes run once and the pool's connections opened, before any baseline.
    const sessionId = await createSession();
    const pending = Array.from({ length: WAITS }, () =>
      rawRequest(waitHead(sessionId, WAIT_SHAPES[1] as WaitShape)),
    );

    await until(() => waits.size === WAITS, 'the warm-up waits are pending');
    await clear(sessionId);
    await Promise.all(pending);
  });

  for (const shape of WAIT_SHAPES) {
    it(`keeps at most ${PER_WAIT_BYTES / 1024} KiB a wait: ${shape.name}`, async (t: TestContext) => {
      const reports: string[] = [];
      let least = Number.POSITIVE_INFINITY;

      // A round over the bound is made again, up to `WAIT_ROUNDS` in all,
      // and the least is held to it (F-25).
      for (let round = 1; round <= WAIT_ROUNDS && least > WAITS * PER_WAIT_BYTES; round += 1) {
        const reading = await waitRound(shape);
        const report = `round ${round}: ${reading.report}`;

        least = Math.min(least, reading.more);
        reports.push(report);
        t.diagnostic(report);
      }

      assert.ok(
        least <= WAITS * PER_WAIT_BYTES,
        `over ${PER_WAIT_BYTES / 1024} KiB a call in each of ${WAIT_ROUNDS} rounds: ${reports.join('; ')}`,
      );
    });
  }
});

interface ChangeShape {
  name: string;
  /** The change, before it is padded with white space to `CHANGE_BODY_BYTES`. */
  change: () => string;
}

const CHANGE_SHAPES: ChangeShape[] = [
  {
    name: 'a response at every limit of D101 in ordinary text, padded with white space',
    change: () => JSON.stringify({ mode: 'custom', response: ordinaryFullResponse() }),
  },
  {
    name: 'a body of 64 KiB with one letter outside Latin-1, padded with white space',
    change: () =>
      JSON.stringify({
        mode: 'custom',
        response: { status: 201, body: `я${'a'.repeat(MAX_RESPONSE_BODY_BYTES - 2)}` },
      }),
  },
  {
    // The text read is two bytes a character throughout, about 2 MB, for
    // the sake of one letter; what is parsed from it is a few bytes.
    name: 'a body of one letter outside Latin-1, padded with white space',
    change: () => JSON.stringify({ mode: 'custom', response: { status: 201, body: 'я' } }),
  },
];

/** `change` followed by white space up to `CHANGE_BODY_BYTES`. */
function paddedBody(change: string): Buffer {
  return Buffer.from(change + ' '.repeat(CHANGE_BODY_BYTES - Buffer.byteLength(change)));
}

/**
 * One `PUT .../response` with `body`, on a connection of its own, answering
 * the promise of its status. No closure here refers to `body`, so the test
 * itself keeps no copy of it once it is written: what is measured is the
 * server's.
 */
function putResponse(sessionId: string, body: Buffer): Promise<number> {
  const request = http.request({
    host: '127.0.0.1',
    port,
    method: 'PUT',
    path: `/api/sessions/${sessionId}/response`,
    agent: false,
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
  });
  const answer = new Promise<number>((resolve, reject) => {
    request.on('response', (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
  });

  request.end(body);

  return answer;
}

/** How many backends wait for a lock `holder` holds. */
async function blockedBy(holder: number): Promise<number> {
  const result = await pool.query<{ waiting: number }>(
    'SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
    [holder],
  );

  return result.rows[0]?.waiting ?? 0;
}

describe('a response change waiting for its session’s row lock (D213)', () => {
  let sessionIds: string[] = [];

  before(async () => {
    sessionIds = await Promise.all(Array.from({ length: CHANGES }, () => createSession()));

    // Every path a change takes run once, and the pool's connections opened.
    for (const status of await Promise.all(
      sessionIds.map((id) => putResponse(id, Buffer.from('{"mode":"default"}'))),
    )) {
      assert.equal(status, 200);
    }
  });

  for (const shape of CHANGE_SHAPES) {
    it(`keeps at most ${PER_CHANGE_BYTES / 1024} KiB a change: ${shape.name}`, async (t: TestContext) => {
      const holder = new pg.Client({ connectionString: loadConfig().databaseUrl });

      await holder.connect();

      let held: number;
      let answers: Promise<number[]> | undefined;

      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM sessions WHERE id = ANY($1) FOR UPDATE', [sessionIds]);

        const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid as number;
        const baseline = await heldBytes();

        answers = Promise.all(sessionIds.map((id) => putResponse(id, paddedBody(shape.change()))));

        // Every one waits for its row in the database, more of them than the
        // gate has slots, and none holds a slot meanwhile (D244).
        for (let tries = 0; (await blockedBy(pid)) < CHANGES; tries += 1) {
          assert.ok(tries < 1_000, 'the changes never all waited for their rows');
          await delay(10);
        }

        assert.ok(CHANGES > API_WORK_SLOTS);
        assert.equal(workSlots.taken, 0, 'a change waiting for its row held a slot');
        assert.equal(workSlots.waiting, 0, 'a change waited for a slot');

        held = (await heldBytes()) - baseline;
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }

      const report = `${CHANGES} changes of ${CHANGE_BODY_BYTES} bytes waiting for their rows: ${(held / 1024).toFixed(1)} KiB more held, ${(held / CHANGES / 1024).toFixed(1)} KiB a change`;

      t.diagnostic(report);
      assert.ok(held <= CHANGES * PER_CHANGE_BYTES, report);
      assert.deepEqual(
        await answers,
        Array.from({ length: CHANGES }, () => 200),
      );
    });
  }
});

/** What a call to a route that takes no body may add to the process, at most. */
const PER_IGNORED_CALL_BYTES = 256 * 1024;

/**
 * A JSON array of empty objects of exactly `MAX_BODY_BYTES`, the listener's
 * 1 MiB: 349,525 objects once parsed, which Fastify's own parser built and
 * the route kept as `request.body` across its handler's waits.
 */
function emptyObjects(): Buffer {
  const count = (MAX_BODY_BYTES - 1) / 3;

  return Buffer.from(`[${'{},'.repeat(count - 1)}{}]`);
}

/**
 * The routes that take no body - the queue's restart and the four deletions
 * - sent two such arrays each while the pool does not answer (D213): two
 * restarts that kept what Fastify parsed held about 44 MiB more. Each
 * must hold well under 1 MiB a call, `PER_IGNORED_CALL_BYTES`: the body is
 * refused `413` / `1004` past 1 KiB, before it is read. With the pool
 * blocked, a call that was let through waits for it with what it parsed.
 */
describe('a body sent to a route that takes none, while the pool does not answer (D213)', () => {
  /** A pool of one connection, which the test holds: every route waits for it. */
  let blocked: pg.Pool;
  let blockedApi: FastifyInstance;
  let blockedPort: number;
  let body: Buffer;
  /** The statuses the server wrote, as it wrote them. */
  const written: number[] = [];

  before(async () => {
    await startup;
    blocked = new pg.Pool({ connectionString: loadConfig().databaseUrl, max: 1 });
    blockedApi = buildServer(blocked, {
      logDestination: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    });
    blockedApi.addHook('onResponse', async (_request, reply) => {
      written.push(reply.statusCode);
    });
    await blockedApi.listen({ host: '127.0.0.1', port: 0 });
    blockedPort = (blockedApi.server.address() as net.AddressInfo).port;
    // Before any baseline, and the same bytes for every call: the test's own
    // copy is counted in each baseline, and no call adds one.
    body = emptyObjects();
    assert.equal(body.length, MAX_BODY_BYTES);
  });

  after(async () => {
    await blockedApi?.close();
    await blocked?.end();
  });

  /**
   * One call with `body` declared `application/json` on a connection of its
   * own, answering the promise of its status, or of `0` when the server ended
   * the connection without one: a body refused before it is read can lose
   * its answer to a reset (D143).
   */
  function sendBody(method: string, path: string): Promise<number> {
    const request = http.request({
      host: '127.0.0.1',
      port: blockedPort,
      method,
      path,
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    });
    const answer = new Promise<number>((resolve) => {
      request.on('response', (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
        response.on('error', () => resolve(response.statusCode ?? 0));
      });
      request.on('error', () => resolve(0));
    });

    request.end(body);

    return answer;
  }

  const ROUTES: [string, string, (sessionId: string) => string][] = [
    ['POST', '/api/sessions/:sessionId/queue/restart', (id) => `/api/sessions/${id}/queue/restart`],
    ['DELETE', '/api/sessions/:sessionId/queue', (id) => `/api/sessions/${id}/queue`],
    ['DELETE', '/api/sessions/:sessionId/requests', (id) => `/api/sessions/${id}/requests`],
    [
      'DELETE',
      '/api/sessions/:sessionId/requests/:requestId',
      (id) => `/api/sessions/${id}/requests/${randomUUID()}`,
    ],
    ['DELETE', '/api/sessions/:sessionId', (id) => `/api/sessions/${id}`],
  ];

  for (const [method, route, path] of ROUTES) {
    it(`keeps at most ${PER_IGNORED_CALL_BYTES / 1024} KiB a call: two 1 MiB arrays of empty objects to ${method} ${route}`, async (t: TestContext) => {
      // A session of each call's own, so that no call waits behind the other
      // in its session's line (D205) rather than for the pool.
      const ids = [await createSession(), await createSession()];
      const holder = await blocked.connect();

      written.length = 0;

      let held: number;
      let waiting: number;
      let answers: Promise<number[]> | undefined;

      try {
        const baseline = await heldBytes();
        let settled = 0;

        answers = Promise.all(
          ids.map((id) =>
            sendBody(method, path(id)).then((status) => {
              settled += 1;

              return status;
            }),
          ),
        );

        // Each call answered, or waiting for the pool with its body parsed:
        // what is measured is what the server does with it.
        await until(() => settled + blocked.waitingCount === 2, 'both calls are settled');
        waiting = blocked.waitingCount;
        held = (await heldBytes()) - baseline;
      } finally {
        holder.release();
      }

      const statuses = await answers;

      await until(() => written.length === 2, 'both answers are written');

      const report = `two calls, ${waiting} waiting for the pool: ${(held / 1024).toFixed(1)} KiB more held, ${(held / 2 / 1024).toFixed(1)} KiB a call; written ${written.join(', ')}, read ${statuses.join(', ')}`;

      t.diagnostic(report);
      assert.ok(held <= 2 * PER_IGNORED_CALL_BYTES, report);
      assert.equal(waiting, 0, report);
      // Refused before the body was read; the client, still sending it, may
      // have lost the answer to the connection's reset.
      assert.deepEqual(written, [413, 413], report);

      for (const status of statuses) {
        assert.ok(status === 413 || status === 0, report);
      }
    });
  }
});
