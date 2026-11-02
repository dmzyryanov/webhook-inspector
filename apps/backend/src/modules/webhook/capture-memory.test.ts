/**
 * What a reply held by a configured delay keeps of its webhook (D210). A
 * delay holds the reply for up to 30 s after the webhook is stored (D105,
 * D172), and the byte budget counts it then at 16 KiB, its header part and
 * the answer's body - so it must keep no more than that: never the body of
 * up to 1 MiB it came in, nor the response's configuration or the composed
 * raw answer, which the response record already holds.
 *
 * Over real sockets, not Fastify's injection, whose made-up request keeps the
 * payload it was given for as long as the request lives. Sixteen webhooks of
 * exactly 1 MiB are sent to a session that delays its answer by 30 s; with
 * all of them stored and their replies held, and the garbage collected, each
 * body's buffer must be gone - a `WeakRef` to it, taken as the handler is
 * reached, is cleared - and the process must hold at most
 * `PER_REPLY_BYTES` more per reply than before they were sent. With the body
 * kept on the request, as before 0.49.1, each held about 1 MiB more.
 *
 * The same holds of a template that reads the body (D251): its 1 MiB is
 * parsed as JSON inside the capture, and neither the parse nor the value it
 * reads outlives the composed answer of at most 64 KiB.
 *
 * A `GET` is different: Fastify never reads its body, and Node keeps what it
 * read of one unread in the request's stream until the reply has closed. So
 * twelve `GET`s each declaring and sending 1 MiB, their replies held by a
 * delay, must be counted in the budget for at least what the process holds
 * for them; counted at their headers alone, as before the outside review's
 * finding, they held about 158 KiB each against 17 KiB counted.
 *
 * The collector is exposed inside this file's own process with
 * `v8.setFlagsFromString` and a new context's `gc`, as
 * `mcp/mcp-memory.test.ts` does, so the test needs no flag on the command
 * line; bytecode flushing is turned off the same way.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import net, { type AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import v8 from 'node:v8';
import vm from 'node:vm';
import type pg from 'pg';
import { MAX_BODY_BYTES } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import { createCaptureBudget } from './capture-budget.ts';

v8.setFlagsFromString('--expose-gc');
v8.setFlagsFromString('--no-flush-bytecode');

const collectGarbage = vm.runInNewContext('gc') as () => void;

/** Replies held at once. */
const REPLIES = 16;

/** What one held reply may add to the process, at most (#144, criterion 3). */
const PER_REPLY_BYTES = 200 * 1024;

/** The delay every reply is held by: longer than the test. */
const DELAY_MS = 30_000;

let pool: pg.Pool;
let servers: TestServers;
let port: number;
const budget = createCaptureBudget();
const createdSessionIds: string[] = [];
/** A weak reference to the body of every webhook, taken as its handler is reached. */
const bodies: WeakRef<Buffer>[] = [];
/** One body for every webhook, so the test itself holds a single copy. */
const BODY = Buffer.alloc(MAX_BODY_BYTES, 0x61);

/**
 * The same size as JSON, one string of nearly all of it: what a template
 * reading `{{request.body.a}}` parses, and finds too large to send (D251).
 */
const JSON_BODY = Buffer.concat([
  Buffer.from('{"a":"'),
  Buffer.alloc(MAX_BODY_BYTES - 8, 0x61),
  Buffer.from('"}'),
]);

/** A template reading the body twice, and the id. */
const TEMPLATE = '{"a":"{{request.body.a}}","again":"{{request.body.a}}","id":"{{request.id}}"}';

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    servers = buildTestServers(pool, {
      captureBudget: budget,
      logDestination: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    });
    // On the root, before the listener is ready, so the webhook scope has it
    // too. Weak: it keeps nothing alive itself.
    servers.receiver.addHook('preHandler', async (request) => {
      if (Buffer.isBuffer(request.body)) {
        bodies.push(new WeakRef(request.body));
      }
    });
    await servers.api.ready();
    await servers.receiver.listen({ host: '127.0.0.1', port: 0 });
    port = (servers.receiver.server.address() as AddressInfo).port;
  })();
  await startup;
});

after(async () => {
  await startup;

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers?.close();
  await pool?.end();
});

/** A session whose every answer waits `delayMs`, its body a template when `template` says so. */
async function delayedSession(delayMs = DELAY_MS, template = false): Promise<string> {
  const created = await servers.api.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      response: template
        ? { status: 200, body: TEMPLATE, delayMs, template: true }
        : { status: 200, body: '{"held":true}', delayMs },
    }),
  });

  assert.equal(created.statusCode, 201, created.body);

  const { id } = created.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

/**
 * Sends a webhook of `BODY` and leaves its connection open: its reply is held
 * by the delay. The head and the body are written apart, so the body written
 * is `BODY` itself and no copy of it.
 */
function send(sessionId: string, method = 'POST', body: Buffer = BODY): net.Socket {
  const socket = net.connect(port, '127.0.0.1', () => {
    socket.write(
      `${method} /s/${sessionId} HTTP/1.1\r\nHost: hook.qa-tools.ru\r\nContent-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\n\r\n`,
      'latin1',
    );
    socket.write(body);
  });

  socket.on('error', () => undefined);

  return socket;
}

/** How many of the session's requests have a response record in `state`. */
async function countIn(sessionId: string, state: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) FROM requests q JOIN request_responses r ON r.request_id = q.id
      WHERE q.session_id = $1 AND r.state = $2`,
    [sessionId, state],
  );

  return Number(result.rows[0]?.count);
}

/**
 * Waits, for at most 20 s, until `count` of the session's requests are in
 * `state` and the pool has nothing in flight.
 */
async function reach(sessionId: string, state: string, count: number): Promise<void> {
  const settled = async (): Promise<boolean> =>
    (await countIn(sessionId, state)) === count &&
    pool.waitingCount === 0 &&
    pool.idleCount === pool.totalCount;

  for (let tries = 0; !(await settled()) && tries < 2000; tries += 1) {
    await delay(10);
  }

  assert.equal(await countIn(sessionId, state), count);
}

/**
 * The bytes the process holds once the garbage is collected: the V8 heap and
 * the memory behind buffers. Each collection runs in a job of its own, since a
 * `WeakRef` read or made in a job keeps its target until the job ends.
 */
async function heldBytes(): Promise<number> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    collectGarbage();
  }

  const { heapUsed, arrayBuffers } = process.memoryUsage();

  return heapUsed + arrayBuffers;
}

/** Sends `REPLIES` webhooks to a delayed session, holds them stored, and returns their sockets. */
async function heldReplies(sessionId: string, body: Buffer = BODY): Promise<net.Socket[]> {
  const sockets = Array.from({ length: REPLIES }, () => send(sessionId, 'POST', body));

  await reach(sessionId, 'pending', REPLIES);

  return sockets;
}

/** Ends every held reply: its sender leaves, and it is recorded `aborted` (D109). */
async function leave(sessionId: string, sockets: net.Socket[]): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }

  await reach(sessionId, 'aborted', REPLIES);
}

describe('a reply held by a delay (D210)', () => {
  it(`keeps at most ${PER_REPLY_BYTES / 1024} KiB and no body of a 1 MiB webhook`, async (t: TestContext) => {
    // Every path once, the pool's connections opened, before the baseline.
    const warm = await delayedSession();

    await leave(warm, await heldReplies(warm));

    const sessionId = await delayedSession();
    const baseline = await heldBytes();
    const firstBody = bodies.length;
    const sockets = await heldReplies(sessionId);

    try {
      assert.equal(bodies.length - firstBody, REPLIES);

      const held = (await heldBytes()) - baseline;
      const kept = bodies.slice(firstBody).filter((body) => body.deref() !== undefined).length;
      const report = `${REPLIES} replies held: ${kept} bodies kept, ${(held / 1024 / 1024).toFixed(2)} MiB more held, ${(held / REPLIES / 1024).toFixed(1)} KiB a reply; the budget holds ${budget.used} bytes`;

      t.diagnostic(report);
      assert.equal(kept, 0, report);
      assert.ok(held <= REPLIES * PER_REPLY_BYTES, report);
    } finally {
      await leave(sessionId, sockets);
    }

    await delay(50);
    assert.equal(budget.used, 0);
  });

  it(`keeps at most ${PER_REPLY_BYTES / 1024} KiB a reply whose template parsed its 1 MiB JSON body (D251)`, async (t: TestContext) => {
    const warm = await delayedSession(DELAY_MS, true);

    await leave(warm, await heldReplies(warm, JSON_BODY));

    const sessionId = await delayedSession(DELAY_MS, true);
    const baseline = await heldBytes();
    const firstBody = bodies.length;
    const sockets = await heldReplies(sessionId, JSON_BODY);

    try {
      const held = (await heldBytes()) - baseline;
      const kept = bodies.slice(firstBody).filter((body) => body.deref() !== undefined).length;
      const report = `${REPLIES} templated replies held: ${kept} bodies kept, ${(held / 1024 / 1024).toFixed(2)} MiB more held, ${(held / REPLIES / 1024).toFixed(1)} KiB a reply`;

      t.diagnostic(report);
      assert.equal(kept, 0, report);
      assert.ok(held <= REPLIES * PER_REPLY_BYTES, report);

      // The value did not fit: what is held is the id and the literal text.
      const answered = await pool.query<{ body: Buffer }>(
        `SELECT r.body FROM requests q JOIN request_responses r ON r.request_id = q.id
          WHERE q.session_id = $1 LIMIT 1`,
        [sessionId],
      );
      const text = answered.rows[0]?.body.toString('utf8') ?? '';

      assert.match(text, /^\{"a":"","again":"","id":"[0-9a-f-]{36}"\}$/);
    } finally {
      await leave(sessionId, sockets);
    }

    await delay(50);
    assert.equal(budget.used, 0);
  });
});

/** Of the GETs below: held at once, and how long a delay holds each reply. */
const GETS = 12;
const GET_DELAY_MS = 5_000;

describe('a GET whose body Fastify never reads, its reply held by a delay (D210)', () => {
  it(`is counted in the budget for at least what the process keeps of its unread body`, async (t: TestContext) => {
    const sessionId = await delayedSession(GET_DELAY_MS);
    const baseline = await heldBytes();
    // Each declares and sends a body of 1 MiB, which Fastify never reads and
    // Node reads into the request's stream all the same, until the reply has
    // closed.
    const sockets = Array.from({ length: GETS }, () => send(sessionId, 'GET'));

    try {
      await reach(sessionId, 'pending', GETS);

      const held = (await heldBytes()) - baseline;
      const report = `${GETS} GETs of 1 MiB held: ${(held / 1024 / 1024).toFixed(2)} MiB more held, ${(held / GETS / 1024).toFixed(1)} KiB each; the budget counts ${(budget.used / 1024 / 1024).toFixed(2)} MiB`;

      t.diagnostic(report);
      assert.ok(held <= budget.used, report);
      // The replies are sent once their delay has run out.
      await reach(sessionId, 'sent', GETS);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
    }

    await delay(50);
    assert.equal(budget.used, 0);
  });
});
