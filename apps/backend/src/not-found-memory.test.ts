/**
 * A body sent to a path no route has is never read, so the process keeps
 * none of it however many such requests stall (D227), measured with the
 * garbage collected, in the pattern of `limits/calls-memory.test.ts`.
 *
 * On the receive listener, whose root keeps Fastify's own JSON and text
 * parsers, the not-found route read such a body into a string - up to the
 * listener's 1 MiB, counted by no budget, since the capture budget and
 * `MAX_BODY_BYTES` hold the webhook routes alone - and answered `404` only
 * once it had all arrived. A connection that stalled one byte short of a
 * 1 MiB body kept about 1 MiB of heap for as long as its client liked:
 * 8, 32 and 128 of them held 8.3, 32.8 and 129.7 MiB, and a few hundred from
 * one address took a process with a 259 MiB heap past it (measured on
 * #145's `dafdd27`). Answered `404` before a byte of the body,
 * each connection is ended by the close rule (`answer-before-body.test.ts`)
 * and keeps nothing: at most `PER_CONNECTION_BYTES` a connection here,
 * the client's own sockets included.
 *
 * Over real sockets, not Fastify's injection, whose made-up request keeps
 * the payload it was given. The collector is exposed inside this file's own
 * process with `v8.setFlagsFromString` and a new context's `gc`, and bytecode
 * flushing is turned off the same way, as in `mcp-memory.test.ts`.
 *
 * That the listener answered every one is read from its log, a `request
 * completed` line with `404` each; that it ended every one, from its client:
 * a `close`, waited for with a deadline rather than for a fixed time. The
 * client reads and drops what it is sent: closed with the body's bytes
 * unread, the server's socket is reset after its FIN, and a client on macOS
 * mostly sees the reset, as an `error`, while one on Linux sees the FIN
 * alone, as an `end` - which a socket nobody reads never emits, so that on
 * Linux it saw nothing at all (#145's pipeline 2936068107).
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { MAX_BODY_BYTES } from '@webhook-inspector/shared';
import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { buildReceiver } from './server.ts';

v8.setFlagsFromString('--expose-gc');
v8.setFlagsFromString('--no-flush-bytecode');

const collectGarbage = vm.runInNewContext('gc') as () => void;

/** Connections stalled at once in the warm-up, of each shape. */
const WARM_UP_CONNECTIONS = 32;

/**
 * What a connection may add to the process, at most: a fraction of the 1 MiB
 * each one held before, room for the client's own socket and noise.
 */
const PER_CONNECTION_BYTES = 64 * 1024;

/**
 * Every byte of a body of the listener's limit but the last, written by every
 * client: one buffer, allocated before any measurement, so that the clients
 * add none of their own.
 */
const ALL_BUT_THE_LAST = Buffer.alloc(MAX_BODY_BYTES - 1, 0x61);

let pool: pg.Pool;
let receiver: FastifyInstance;
let port: number;
/** The `404`s the listener has logged as completed, counted from 0 by each test. */
let answered = 0;
/** Every connection opened, so that none outlives the file. */
const sockets: net.Socket[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    receiver = buildReceiver(pool, {
      logDestination: new Writable({
        write(chunk: Buffer | string, _encoding, callback) {
          for (const line of chunk.toString().split('\n')) {
            if (line === '') {
              continue;
            }

            const entry = JSON.parse(line) as { msg?: string; res?: { statusCode?: number } };

            if (entry.msg === 'request completed' && entry.res?.statusCode === 404) {
              answered += 1;
            }
          }

          callback();
        },
      }),
    });
    await receiver.listen({ host: '127.0.0.1', port: 0 });
    port = (receiver.server.address() as net.AddressInfo).port;
  })();
  await startup;
});

after(async () => {
  await startup;

  for (const socket of sockets) {
    socket.destroy();
  }

  await receiver?.close();
  await pool?.end();
});

/**
 * The bytes the process holds once the garbage is collected: the V8 heap and
 * the memory behind buffers. Each collection runs in a job of its own.
 */
async function heldBytes(): Promise<number> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    collectGarbage();
  }

  const { heapUsed, arrayBuffers } = process.memoryUsage();

  return heapUsed + arrayBuffers;
}

/** The connections the receive listener has open. */
function serverConnections(): Promise<number> {
  return new Promise((resolve, reject) => {
    receiver.server.getConnections((error, count) => {
      if (error) {
        reject(error);
      } else {
        resolve(count);
      }
    });
  });
}

/** Waits until `check` holds, polling every 10 ms, for `ms` at most; answers whether it did. */
async function within(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (!(await check())) {
    if (Date.now() >= deadline) {
      return false;
    }

    await delay(10);
  }

  return true;
}

interface Shape {
  name: string;
  /** The header lines after the request line and `Host`, the framing among them. */
  headers: string[];
  /** What goes before the body's bytes, and what after: a chunk's size line and nothing. */
  framing: [before: string, after: string];
  /** How many connections of the shape are stalled at once, one test each: growing for the first. */
  counts: number[];
}

const SHAPES: Shape[] = [
  {
    name: 'declared application/json, its length declared',
    headers: ['Content-Type: application/json', `Content-Length: ${MAX_BODY_BYTES}`],
    framing: ['', ''],
    counts: [8, 32, 128],
  },
  {
    name: 'declared text/plain, its length declared',
    headers: ['Content-Type: text/plain; charset=utf-8', `Content-Length: ${MAX_BODY_BYTES}`],
    framing: ['', ''],
    counts: [32],
  },
  {
    name: 'declared application/json, chunked, stalled inside a chunk of the whole body',
    headers: ['Content-Type: application/json', 'Transfer-Encoding: chunked'],
    framing: [`${MAX_BODY_BYTES.toString(16)}\r\n`, ''],
    counts: [32],
  },
];

interface Stalled {
  socket: net.Socket;
  /** Whether the socket has closed: the server ended it, by its FIN or a reset. */
  closed: () => boolean;
  /** Whether the client saw a reset, an `error`, before its `close`. */
  reset: () => boolean;
}

/**
 * Opens a connection to the receive listener, writes the head of a `POST` of
 * `shape` to a path no route has and every byte of its body but the last,
 * and never ends it; whatever it is sent is read and dropped. Answers the
 * socket, whether it has closed and whether it saw a reset.
 */
function stall(shape: Shape): Stalled {
  const socket = net.connect(port, '127.0.0.1');
  let closed = false;
  let reset = false;

  sockets.push(socket);
  socket.resume();
  socket.on('error', () => {
    reset = true;
  });
  // After an `error`, or after the `end` that only a socket read to its end
  // emits: the client ends or destroys nothing of its own accord before the
  // check.
  socket.once('close', () => {
    closed = true;
  });
  socket.write(
    `${['POST /no-such-page HTTP/1.1', 'Host: 127.0.0.1', ...shape.headers].join('\r\n')}\r\n\r\n${shape.framing[0]}`,
  );
  socket.write(ALL_BUT_THE_LAST);

  return { socket, closed: () => closed, reset: () => reset };
}

describe('a body sent to a path no route has on the receive listener (D227)', () => {
  before(async () => {
    // Every path such a request takes, run as often as a test runs it
    // before any baseline.
    const warm = SHAPES.flatMap((shape) =>
      Array.from({ length: WARM_UP_CONNECTIONS }, () => stall(shape)),
    );

    await within(() => warm.every(({ closed }) => closed()), 10_000);
  });

  for (const shape of SHAPES) {
    for (const connections of shape.counts) {
      it(`keeps at most ${PER_CONNECTION_BYTES / 1024} KiB a connection, ${connections} stalled one byte short of 1 MiB: ${shape.name}`, async (t: TestContext) => {
        const baseline = await heldBytes();

        answered = 0;

        const stalledOnes = Array.from({ length: connections }, () => stall(shape));

        // Every client has seen its connection ended, or the deadline has
        // passed: on the code before D227 the server read every body but its
        // last byte and kept every connection open, and the wait runs out.
        await within(() => stalledOnes.every(({ closed }) => closed()), 10_000);
        await within(async () => (await serverConnections()) === 0, 1_000);

        const held = (await heldBytes()) - baseline;
        const open = await serverConnections();
        const closed = stalledOnes.filter(({ closed }) => closed()).length;
        const reset = stalledOnes.filter(({ reset }) => reset()).length;
        const report = `${connections} connections: ${(held / 1024).toFixed(1)} KiB more held, ${(held / connections / 1024).toFixed(1)} KiB a connection; ${answered} answered 404, ${open} still open on the server, ${closed} ended, ${reset} of them by a reset the client saw`;

        t.diagnostic(report);

        for (const { socket } of stalledOnes) {
          socket.destroy();
        }

        assert.ok(held <= connections * PER_CONNECTION_BYTES, report);
        assert.equal(answered, connections, report);
        assert.equal(open, 0, report);
        assert.equal(closed, connections, report);
      });
    }
  }
});
