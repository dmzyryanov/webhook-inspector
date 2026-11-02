/**
 * What the bound on header lines in flight (#182, D238) keeps of a request
 * once Node's parser and its answer are done with it: nothing, however long
 * its connection is kept alive afterwards.
 *
 * The bound kept the latest request of every connection, to check its
 * framing against, until the connection's next request replaced it (the
 * outside review's finding on `ab82a00`): 64 `GET /robots.txt` of 16,000
 * header lines each, answered and read, their connections kept alive, held
 * all 64 requests and 53.7 MiB after garbage collection, outside the line
 * budget, where the receiver before #182 held none and 0.8 MiB. At 512
 * connections an address, that is a path to the process's memory the line
 * budget does not see.
 *
 * Over real sockets: a `WeakRef` to each request is taken as Node publishes
 * it (`http.server.request.start`), and once the answers are read, with the
 * connections still open, every one must be cleared by the collector. The
 * collector is exposed inside this file's own process with
 * `v8.setFlagsFromString` and a new context's `gc`, as
 * `capture-memory.test.ts` does, so the test needs no flag on the command
 * line. Why it does not flake: a full collection clears a `WeakRef` exactly
 * when nothing else reaches its target, so a request the bound holds is
 * never cleared, however many rounds run, and one nothing holds is cleared at
 * the first collection after Node lets go of it - on its `end`, a few turns
 * after its answer has gone. The collections are repeated, each in a turn of
 * its own (a `WeakRef` read in a job keeps its target until the job ends),
 * until all are cleared or a deadline passes, not for a fixed time. What the
 * process holds more is reported, not asserted: the cleared references are
 * the claim, and heap figures move with everything else the process does.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import http, { type IncomingMessage } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { after, before, describe, it, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildReceiver } from '../../server.ts';
import { createHeaderLineBudget, type HeaderLineBudget } from './header-lines.ts';
import { boundPipelinedRequests } from './pipelining.ts';

v8.setFlagsFromString('--expose-gc');
v8.setFlagsFromString('--no-flush-bytecode');

const collectGarbage = vm.runInNewContext('gc') as () => void;

const LOOPBACK = '127.0.0.1';

/** Every connection opened, so that none outlives the file. */
const sockets: net.Socket[] = [];

let pool: pg.Pool;

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

  await pool?.end();
});

/** A `WeakRef` to every request Node's servers make while `run` runs. */
async function watchingRequests<T>(
  run: (requests: WeakRef<IncomingMessage>[]) => Promise<T>,
): Promise<T> {
  const requests: WeakRef<IncomingMessage>[] = [];
  const onStart = (message: unknown): void => {
    requests.push(new WeakRef((message as { request: IncomingMessage }).request));
  };

  subscribe('http.server.request.start', onStart);

  try {
    return await run(requests);
  } finally {
    unsubscribe('http.server.request.start', onStart);
  }
}

/**
 * The bytes the process holds and how many of `requests` are still reachable,
 * once the garbage is collected: collected in turns of their own until none
 * is, or `withinMs` has passed.
 */
async function collected(
  requests: WeakRef<IncomingMessage>[],
  withinMs = 5_000,
): Promise<{ kept: number; bytes: number }> {
  const deadline = Date.now() + withinMs;

  for (;;) {
    await new Promise((resolve) => setImmediate(resolve));
    collectGarbage();

    const kept = requests.filter((request) => request.deref() !== undefined).length;

    if (kept === 0 || Date.now() > deadline) {
      const { heapUsed, arrayBuffers } = process.memoryUsage();

      return { kept, bytes: heapUsed + arrayBuffers };
    }

    await delay(20);
  }
}

/** What is held after a collection, for a baseline. */
async function heldBytes(): Promise<number> {
  return (await collected([])).bytes;
}

/**
 * Writes `bytes` on a new connection and waits until `marker` has come back
 * `answers` times; the connection is left open, kept alive by both sides.
 */
async function answeredOnOpenConnection(
  port: number,
  bytes: string,
  marker: string,
  answers: number,
): Promise<net.Socket> {
  const socket = net.connect(port, LOOPBACK);

  sockets.push(socket);

  await new Promise<void>((resolve, reject) => {
    let received = '';

    socket.setEncoding('latin1');
    socket.on('data', (text: string) => {
      received += text;

      if (received.split(marker).length - 1 >= answers) {
        resolve();
      }
    });
    socket.once('error', reject);
    socket.once('close', () => reject(new Error(`closed after ${JSON.stringify(received)}`)));
    socket.write(bytes, 'latin1');
  });

  return socket;
}

/** A logger that keeps what is logged at `error`. */
function spyLog(): { log: FastifyBaseLogger; errors: unknown[] } {
  const errors: unknown[] = [];
  const log = {
    error: (...args: unknown[]) => errors.push(args),
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
  } as unknown as FastifyBaseLogger;

  return { log, errors };
}

/**
 * A plain Node server bounded as the receive listener is, every header line
 * kept, each request's body read and answered `done`.
 */
async function boundServer(
  budget: HeaderLineBudget,
  options: http.ServerOptions = {},
): Promise<{ port: number; errors: unknown[]; close(): Promise<void> }> {
  const { log, errors } = spyLog();
  const server = http.createServer(
    { keepAliveTimeout: 60_000, ...options },
    (request, response) => {
      request.resume();
      request.on('end', () => response.end('done\n'));
    },
  );

  server.maxHeadersCount = 0;
  boundPipelinedRequests(server, { headerLines: budget, log });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));

  return {
    port: (server.address() as AddressInfo).port,
    errors,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function lines(count: number, prefix = 'a'): string {
  return `${prefix}:\r\n`.repeat(count);
}

describe('the header-line bound keeps no request Node and its answer are done with (#182, D238)', () => {
  it('lets the receiver collect completed GETs of 16,000 header lines whose connections stay open', async (t: TestContext) => {
    const receiver = buildReceiver(pool);
    const connections = 32;
    const head = `GET /robots.txt HTTP/1.1\r\nHost: r.example\r\n${lines(16_000)}\r\n`;

    receiver.log.level = 'silent';
    await receiver.listen({ host: LOOPBACK, port: 0 });

    const port = (receiver.server.address() as AddressInfo).port;

    try {
      // Every path once, closed, before the baseline.
      const warm = await answeredOnOpenConnection(port, head, 'Disallow: /\n', 1);

      warm.destroy();

      const baseline = await heldBytes();
      const { kept, bytes, open } = await watchingRequests(async (requests) => {
        const opened: net.Socket[] = [];

        for (let index = 0; index < connections; index += 1) {
          opened.push(await answeredOnOpenConnection(port, head, 'Disallow: /\n', 1));
        }

        assert.equal(requests.length, connections);

        return {
          ...(await collected(requests)),
          open: opened.filter((socket) => !socket.destroyed).length,
        };
      });
      const report = `${connections} GETs of 16,000 header lines answered, their connections open: ${kept} requests kept, ${((bytes - baseline) / 1024 / 1024).toFixed(2)} MiB more held`;

      t.diagnostic(report);
      assert.equal(open, connections, 'every connection still open');
      assert.equal(kept, 0, report);
    } finally {
      await receiver.close();
    }
  });

  it('lets a bounded server collect requests with bodies of declared length, chunked bodies with trailer lines and pipelined ones, their connections open', async (t: TestContext) => {
    const budget = createHeaderLineBudget();
    const server = await boundServer(budget);
    const declared = `POST /d HTTP/1.1\r\nHost: h\r\n${lines(4_000)}Content-Length: 10\r\n\r\na:\r\nb:\r\n\r\n`;
    const chunked = `POST /c HTTP/1.1\r\nHost: h\r\n${lines(2_000)}Transfer-Encoding: chunked\r\n\r\n4\r\na:\r\n\r\n0\r\n${lines(2_000, 't')}\r\n`;
    const plain = `GET /g HTTP/1.1\r\nHost: h\r\n${lines(4_000)}\r\n`;
    const writes = [
      { bytes: declared, answers: 1 },
      { bytes: chunked, answers: 1 },
      { bytes: plain, answers: 1 },
      { bytes: [declared, chunked, plain, chunked, declared].join(''), answers: 5 },
    ];

    try {
      const { kept, requests } = await watchingRequests(async (made) => {
        for (let round = 0; round < 4; round += 1) {
          for (const { bytes, answers } of writes) {
            await answeredOnOpenConnection(server.port, bytes, 'done\n', answers);
          }
        }

        return { ...(await collected(made)), requests: made.length };
      });
      const report = `${requests} requests answered on ${writes.length * 4} open connections: ${kept} kept`;

      t.diagnostic(report);
      assert.equal(requests, 4 * (1 + 1 + 1 + 5));
      assert.equal(kept, 0, report);
      assert.equal(budget.lines, 0, 'every line given back');
      assert.deepEqual(server.errors, []);
    } finally {
      await server.close();
    }
  });

  it('keeps none either on a connection read uncounted, once its requests could not be followed', async (t: TestContext) => {
    // Node's lenient parser takes a bare LF for a line's end, which the
    // bound's framing does not: Node reads a request the framing has not
    // seen end, and the connection is read uncounted from then on.
    const budget = createHeaderLineBudget();
    const server = await boundServer(budget, { insecureHTTPParser: true });
    const bare = 'GET /bare HTTP/1.1\nHost: h\n\n';
    const plain = `GET /g HTTP/1.1\r\nHost: h\r\n${lines(4_000)}\r\n`;

    try {
      const { kept, requests } = await watchingRequests(async (made) => {
        for (let connection = 0; connection < 4; connection += 1) {
          const socket = await answeredOnOpenConnection(server.port, bare, 'done\n', 1);
          const answered = new Promise<void>((resolve) => {
            let received = '';

            socket.on('data', (text: string) => {
              received += text;

              if (received.split('done\n').length - 1 >= 2) {
                resolve();
              }
            });
          });

          socket.write(plain + plain, 'latin1');
          await answered;
        }

        return { ...(await collected(made)), requests: made.length };
      });
      const report = `${requests} requests answered on 4 open connections read uncounted: ${kept} kept`;

      t.diagnostic(report);
      assert.equal(requests, 4 * 3);
      assert.equal(kept, 0, report);
      assert.equal(server.errors.length, 1, 'the uncounted connection logged once');
      assert.equal(budget.lines, 0, 'every line given back');
    } finally {
      await server.close();
    }
  });
});
