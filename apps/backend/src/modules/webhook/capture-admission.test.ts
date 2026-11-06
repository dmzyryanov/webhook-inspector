/**
 * The capture budget on the receive listener, over real sockets (D210): a
 * webhook waits for its place with its body unread, and Node stops reading
 * its socket meanwhile; a webhook that arrived whole is stored once its place
 * comes though its sender left while it waited, with PROXY protocol on and
 * off (D187, D229); a sender gone in the middle of its body is dropped, and
 * logged as one that left even when that is seen only once its wait has run
 * out; a wait that runs out is refused `503` / `1018` with `Retry-After: 1`;
 * a `GET`, `HEAD` or `TRACE` declaring a body over 1 MiB waits like one
 * declaring none, and holds, while a delay holds its reply, at least what
 * Node read of its body and keeps unread; a connection whose pipelined
 * webhooks wait is read again only once none of them waits, also when the
 * pipelining bound stopped it at its count (D229); a connection that
 * dies with webhooks pipelined behind a delayed answer gives back what they
 * hold, their queued answers closed by Node too, and lets one still waiting
 * go at the latest when its wait runs out; the weight is held until the reply
 * has closed and the handler has settled, and shrinks once the webhook is
 * stored, never growing; one address is held to its own budget while another
 * goes in, and to its 16 MiB by small `GET`s whose delayed answers are at
 * their bound. The waiting line (D228): the next of a full address refused
 * at once, the first of an address always let to wait, a 2,500-line webhook
 * stored with every header line; at most eight refused bodies drain at once,
 * the ninth answered at once before its body, and a lone refusal's 1 MiB
 * body drained and its answer delivered. The application listener's `/s/...`
 * `410` drains with the same eight places: the ninth answered at once, before
 * its body. `capture-budget.test.ts` holds the rules without a server.
 * What a test reads of a connection is read on the server's side of that
 * connection alone, never on a closed earlier one from the same port (#301).
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import ipaddr from 'ipaddr.js';
import type pg from 'pg';
import {
  ErrorCode,
  MAX_BODY_BYTES,
  MAX_CONCURRENT_REFUSAL_DRAINS,
  MAX_RESPONSE_BODY_BYTES,
  type ResponseConfig,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildReceiver, buildServer } from '../../server.ts';
import { RealtimeHub } from '../realtime/hub.ts';
import { refusalDrainPlaces } from '../sessions/refused-body.ts';
import {
  CAPTURE_BASE_WEIGHT_BYTES,
  CAPTURE_HEADER_LINE_WEIGHT_BYTES,
  captureWeight,
  createCaptureBudget,
  inFlightBound,
  METHODS_WITHOUT_BODY,
  REFUSED_LINE_FULL,
  SENDER_LEFT,
  storedWeight,
  waitingWeight,
  type CaptureBudget,
} from './capture-budget.ts';
import { PROXY_V2_SIGNATURE } from './proxy-protocol.ts';
import { REQUEST_ID_HEADER } from './response.ts';

const LOOPBACK = '127.0.0.1';

/**
 * How much of a waiting webhook's connection is read, at most: the chunk that
 * carried its headers, one read of libuv's 64 KiB. Without the stop, Node read
 * two chunks here, and the kernel grew the connection's receive buffer for
 * most of the rest (D210).
 */
const READ_WHILE_WAITING_BYTES = 64 * 1024;

/** The line at `warn` of a webhook refused because its wait ran out. */
const REFUSED = 'Webhook refused: no place in the capture budget in time';

/**
 * A waiting line small enough to fill over sockets: one small webhook an
 * address, two in all. The 16 MiB and 64 MiB of production are held by
 * `capture-budget.test.ts` without a server (D228).
 */
const LINE_PER_ADDRESS = CAPTURE_BASE_WEIGHT_BYTES + 4 * CAPTURE_HEADER_LINE_WEIGHT_BYTES;

/**
 * The wait of `bounded` and `boundedProxied`: past the 2 s delay a test puts
 * before a waiting webhook, so that delay's end comes first, and short.
 */
const BOUNDED_WAIT_MS = 3_000;

/** The two lines a webhook let go from the line is logged with, each at its level (D210 point 6). */
const LET_GO_LEVELS = new Map([
  [SENDER_LEFT, 30],
  [REFUSED, 40],
]);

/** A gate a test opens: requests carrying `x-hold-handler` wait for it before their handler. */
let openHandlerGate: () => void = () => undefined;
let handlerGate: Promise<void> = Promise.resolve();

/** A log line as the listener wrote it, with the request it names when it names one. */
interface LogLine {
  level: number;
  msg: string;
  reqId?: string;
  req?: { method?: string };
}

interface Listener {
  app: FastifyInstance;
  budget: CaptureBudget;
  port: number;
  /** Every connection the listener accepted. */
  sockets: net.Socket[];
  /** Every log line written so far, parsed. */
  log: () => LogLine[];
}

let pool: pg.Pool;
/** `pool`, telling `onCaptureCommitted` when a capture's transaction has committed. */
let sampled: pg.Pool;
let api: FastifyInstance;
/** The application listener's port: `api` listens for the `/s/...` `410` over sockets. */
let apiPort: number;
const hub = new RealtimeHub();

/**
 * Called once a capture's transaction has committed, on the handler's turn
 * and before the handler goes on to shrink its weight: where the hub was
 * sent the capture's announcement before the outbox made delivery
 * asynchronous (D221). A test sets it to sample the budget there.
 */
let onCaptureCommitted: (() => void) | null = null;

function forward<T extends object>(target: T, property: string | symbol): unknown {
  const value = Reflect.get(target, property, target);

  return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
}

/** A pool whose clients call `onCaptureCommitted` after a `COMMIT` of a transaction that inserted a request. */
function samplingPool(base: pg.Pool): pg.Pool {
  return new Proxy(base, {
    get(target, property) {
      if (property !== 'connect') {
        return forward(target, property);
      }

      return async () => {
        const client = await target.connect();
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        let inserted = false;

        return new Proxy(client, {
          get(inner, innerProperty) {
            if (innerProperty !== 'query') {
              return forward(inner, innerProperty);
            }

            return async (...args: unknown[]) => {
              const text = typeof args[0] === 'string' ? args[0] : '';

              if (text === 'BEGIN') {
                inserted = false;
              } else if (text.includes('INSERT INTO requests')) {
                inserted = true;
              }

              const result = await query(...args);

              if (text === 'COMMIT' && inserted) {
                inserted = false;
                onCaptureCommitted?.();
              }

              return result;
            };
          },
        });
      };
    },
  });
}
/** The default budget, with a wait no test reaches. */
let plain: Listener;
/** A budget whose wait runs out after 300 ms. */
let short: Listener;
/** PROXY protocol v2 on, the loopback trusted: each connection names its sender. */
let proxied: Listener;
/** A budget whose wait runs out after `BOUNDED_WAIT_MS`, directly and behind PROXY v2. */
let bounded: Listener;
let boundedProxied: Listener;
/**
 * A budget whose waiting line holds one small webhook an address and two in
 * all, behind PROXY v2 so each sender is its own address (D228): the next of
 * a full address, or the third address, is refused `503` / `1018` at once.
 */
let lineBound: Listener;
/** The pipelining bound at 2 requests read and unanswered a connection, the least allowed (D229). */
let pairBound: Listener;
const createdSessionIds: string[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

async function listener(
  budget: CaptureBudget,
  proxy: boolean,
  pipelinedRequests?: number,
): Promise<Listener> {
  const lines: string[] = [];
  const sockets: net.Socket[] = [];
  const app = buildReceiver(sampled, {
    hub,
    captureBudget: budget,
    pipelinedRequests,
    ...(proxy ? { trustedProxyCidrs: [`${LOOPBACK}/32`], proxyProtocol: 'v2' as const } : {}),
    logDestination: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        lines.push(...chunk.toString().split('\n').filter(Boolean));
        callback();
      },
    }),
  });

  // On the root, before the listener is ready, so the webhook scope has it too.
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-hold-handler'] !== undefined) {
      await handlerGate;
    }
  });
  app.server.on('connection', (socket: net.Socket) => sockets.push(socket));
  await app.listen({ host: LOOPBACK, port: 0 });

  return {
    app,
    budget,
    port: (app.server.address() as AddressInfo).port,
    sockets,
    log: () => lines.map((line) => JSON.parse(line) as LogLine),
  };
}

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    sampled = samplingPool(pool);
    api = buildServer(pool, { hub });
    api.log.level = 'silent';
    await api.listen({ host: LOOPBACK, port: 0 });
    apiPort = (api.server.address() as AddressInfo).port;
    plain = await listener(createCaptureBudget(), false);
    short = await listener(createCaptureBudget({ waitMs: 300 }), false);
    proxied = await listener(createCaptureBudget(), true);
    bounded = await listener(createCaptureBudget({ waitMs: BOUNDED_WAIT_MS }), false);
    boundedProxied = await listener(createCaptureBudget({ waitMs: BOUNDED_WAIT_MS }), true);
    lineBound = await listener(
      createCaptureBudget({
        waitMs: BOUNDED_WAIT_MS,
        waitingPerAddressBytes: LINE_PER_ADDRESS,
        waitingBytes: 2 * LINE_PER_ADDRESS,
      }),
      true,
    );
    pairBound = await listener(createCaptureBudget(), false, 2);
  })();
  await startup;
});

after(async () => {
  await startup?.catch(() => undefined);
  openHandlerGate();

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await Promise.all(
    [plain, short, proxied, bounded, boundedProxied, lineBound, pairBound].map((each) =>
      each?.app.close(),
    ),
  );
  await api?.close();
  await pool?.end();
});

async function newSession(response?: Partial<ResponseConfig>): Promise<string> {
  const created = await api.inject({
    method: 'POST',
    url: '/api/sessions',
    ...(response === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ response }) }),
  });

  assert.equal(created.statusCode, 201, created.body);

  const { id } = created.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

/** A body's size and the start of its SHA-256, which a test compares instead of the body. */
function described(body: Buffer): string {
  return `${body.length} ${createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
}

/**
 * What a session stored, oldest first, as `described` gives each body: a
 * failed deep comparison of 1 MiB buffers makes `node:assert` diff them for
 * minutes, holding gigabytes meanwhile.
 */
async function stored(sessionId: string): Promise<string[]> {
  return (await storedBodies(sessionId)).map(described);
}

async function storedBodies(sessionId: string): Promise<Buffer[]> {
  const result = await pool.query<{ body: Buffer }>(
    'SELECT body FROM requests WHERE session_id = $1 ORDER BY received_at, id',
    [sessionId],
  );

  return result.rows.map((row) => row.body);
}

/** Waits, for at most `withinMs`, 5 s unless given, until `condition` holds. */
async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  withinMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + withinMs;

  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
    await delay(5);
  }
}

/** The header lines `webhook` writes besides `extra`: Host, Connection, Content-Type, Content-Length. */
const WEBHOOK_LINES = 4;

/** A webhook written byte for byte, asking for `Connection: close` unless `keepAlive`. */
function webhook(
  sessionId: string,
  body: Buffer,
  { extra = [], keepAlive = false }: { extra?: [string, string][]; keepAlive?: boolean } = {},
): Buffer {
  const lines = [
    `POST /s/${sessionId} HTTP/1.1`,
    'Host: hook.qa-tools.ru',
    `Connection: ${keepAlive ? 'keep-alive' : 'close'}`,
    ...extra.map(([name, value]) => `${name}: ${value}`),
    'Content-Type: application/octet-stream',
    `Content-Length: ${body.length}`,
  ];

  return Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), body]);
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Call {
  socket: net.Socket;
  /** Every byte the client writes on its connection, a PROXY header included. */
  carries: number;
  /** The answer, once the server has closed the connection; `null` for none. */
  answer: Promise<Answer | null>;
}

/** Writes `bytes` to `port`, after a PROXY v2 header naming `source` when given. */
function call(port: number, bytes: Buffer, source?: string): Call {
  const socket = net.connect(port, LOOPBACK);
  let received = '';
  const answer = new Promise<Answer | null>((resolve) => {
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      const split = received.indexOf('\r\n\r\n');

      if (split === -1) {
        resolve(null);

        return;
      }

      const [statusLine = '', ...lines] = received.slice(0, split).split('\r\n');
      const headers: Record<string, string> = {};

      for (const line of lines) {
        const colon = line.indexOf(':');

        headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }

      resolve({
        status: Number(statusLine.split(' ')[1]),
        headers,
        body: received.slice(split + 4),
      });
    });
  });

  const header = source === undefined ? Buffer.alloc(0) : proxyHeader(source);

  socket.on('connect', () => {
    if (header.length > 0) {
      socket.write(header);
    }

    socket.write(bytes);
  });

  return { socket, carries: header.length + bytes.length, answer };
}

/** A PROXY protocol v2 header for TCP naming `source`, as Traefik writes one (D187). */
function proxyHeader(source: string): Buffer {
  const ipv6 = source.includes(':');
  const ports = Buffer.from([0xc3, 0x50, 0x20, 0xfb]);
  const addresses = ipv6
    ? Buffer.concat([
        Buffer.from(ipaddr.IPv6.parse(source).toByteArray()),
        Buffer.from(ipaddr.IPv6.parse('::1').toByteArray()),
        ports,
      ])
    : Buffer.concat([
        Buffer.from(source.split('.').map(Number)),
        Buffer.from([10, 42, 0, 24]),
        ports,
      ]);
  const fixed = Buffer.from([0x21, ipv6 ? 0x21 : 0x11, 0, 0]);

  fixed.writeUInt16BE(addresses.length, 2);

  return Buffer.concat([PROXY_V2_SIGNATURE, fixed, addresses]);
}

/**
 * The sockets of `listener` still open whose remote end is `client`'s local
 * end, address and port; none before `client` has connected. `sockets` keeps
 * every connection the listener accepted, closed ones too, and a closed one
 * keeps its peer's port and its `bytesRead`: once the kernel gave a new client
 * the port of an earlier connection, matching the port alone measured the
 * earlier socket (#301).
 */
function sidesOf(listener: Listener, client: net.Socket): net.Socket[] {
  const port = client.localPort;

  if (port === undefined) {
    return [];
  }

  return listener.sockets.filter(
    (socket) =>
      !socket.destroyed &&
      socket.remotePort === port &&
      socket.remoteAddress === client.localAddress,
  );
}

/** The server's side of `client`'s connection: the one open socket `sidesOf` finds, or the test fails. */
function serverSide(listener: Listener, client: net.Socket): net.Socket {
  const sides = sidesOf(listener, client);
  const from =
    client.localPort === undefined
      ? 'the client, which has no port: it is not connected'
      : `the client's ${client.localAddress}:${client.localPort}`;

  assert.equal(
    sides.length,
    1,
    `${sides.length} open sockets among the listener's ${listener.sockets.length} come from ${from}, ` +
      `where one is the server's side of its connection`,
  );

  return sides[0] as net.Socket;
}

/** What a read assertion measured on the server's side of a connection. */
interface Reading {
  /** The bytes the socket had read. */
  read: number;
  /** The socket's remote port, whether it was still open, its bytes read and the connection's own total. */
  said: string;
}

/** What `side` has read, now, of a connection whose client writes `carries` bytes in all. */
function readingOf(side: net.Socket, carries: number): Reading {
  const read = side.bytesRead;

  return {
    read,
    said:
      `the server's socket from port ${side.remotePort}, ${side.destroyed ? 'closed' : 'open'}, ` +
      `read ${read} bytes of the ${carries} its connection carries`,
  };
}

function noWeightLeft(listener: Listener): void {
  assert.equal(listener.budget.used, 0, 'weight still held');
  assert.equal(listener.budget.waiting, 0, 'still waiting');
}

/** The lines among `lines` that say how the request `reqId` was let go from the line. */
function letGoOf(lines: LogLine[], reqId: string | undefined): LogLine[] {
  return lines.filter((line) => line.reqId === reqId && LET_GO_LEVELS.has(line.msg));
}

/**
 * Asserts that the request `reqId` was let go from the line once, logged
 * either as one that left, at `info`, or as refused, at `warn`.
 */
function letGoOnce(lines: LogLine[], reqId: string | undefined): void {
  const [line, ...more] = letGoOf(lines, reqId);

  assert.ok(line !== undefined && more.length === 0, JSON.stringify(lines));
  assert.equal(line.level, LET_GO_LEVELS.get(line.msg), JSON.stringify(lines));
}

describe("the server's side of a client's connection, as these tests read it (#301)", () => {
  it('is the open socket from the client’s address and port, not a closed earlier one from the same port ahead of it, and fails the test when none or two are', async () => {
    // An earlier connection, to another server, from a port the kernel
    // chose. That server closes it first, so no TIME_WAIT is left on the
    // client's port, which this test's own connection then binds.
    const accepted: net.Socket[] = [];
    const other = net.createServer((socket) => {
      accepted.push(socket);
    });
    const clients: net.Socket[] = [];

    other.listen(0, LOOPBACK);
    await once(other, 'listening');

    try {
      const first = net.connect({
        port: (other.address() as AddressInfo).port,
        host: LOOPBACK,
        localAddress: LOOPBACK,
      });

      clients.push(first);
      first.on('error', () => undefined);
      await once(first, 'connect');
      await until(() => accepted.length === 1, 'the earlier connection is accepted');

      const earlier = accepted[0] as net.Socket;
      const port = first.localPort;

      assert.ok(port !== undefined, 'the earlier client has a port');
      // Read while open, as matching a listener's sockets reads it: a socket
      // keeps its peer's address and port once read.
      assert.equal(earlier.remotePort, port);

      const closed = Promise.all([once(earlier, 'close'), once(first, 'close')]);

      earlier.destroy();
      await closed;

      // This test's own connection, to the listener, from that very port.
      const before = plain.sockets.length;
      const client = net.connect({
        port: plain.port,
        host: LOOPBACK,
        localAddress: LOOPBACK,
        localPort: port,
      });

      clients.push(client);
      client.on('error', () => undefined);
      await once(client, 'connect');
      await until(() => plain.sockets.length === before + 1, 'the connection is accepted');

      const own = plain.sockets.at(-1) as net.Socket;
      // The closed earlier socket ahead of the open one, as a listener's list
      // holds a connection it accepted earlier.
      const listed: Listener = { ...plain, sockets: [earlier, ...plain.sockets] };

      assert.equal(client.localPort, port);
      assert.ok(earlier.destroyed, 'the earlier socket is closed');
      assert.equal(earlier.remotePort, port, 'the earlier socket keeps the port');
      assert.equal(
        earlier.remoteAddress,
        client.localAddress,
        'the earlier socket keeps the address',
      );
      // Not vacuous: the port alone finds the earlier socket.
      assert.equal(
        listed.sockets.find((socket) => socket.remotePort === client.localPort),
        earlier,
      );
      assert.equal(serverSide(listed, client), own);
      assert.equal(serverSide(plain, client), own);
      assert.throws(() => serverSide({ ...listed, sockets: [earlier] }, client), {
        name: 'AssertionError',
        message: /^0 open sockets among the listener's 1 come from the client's 127\.0\.0\.1:\d+,/,
      });
      assert.throws(() => serverSide({ ...listed, sockets: [earlier, own, own] }, client), {
        name: 'AssertionError',
        message: /^2 open sockets among the listener's 3 /,
      });
      // A client not yet connected has no port, and no side.
      assert.throws(() => serverSide(listed, new net.Socket()), {
        name: 'AssertionError',
        message: /^0 open sockets .* come from the client, which has no port: it is not connected,/,
      });

      // A read assertion's message names the socket it measured. Neither
      // client wrote a byte.
      assert.deepEqual(readingOf(earlier, 1_000), {
        read: 0,
        said: `the server's socket from port ${port}, closed, read 0 bytes of the 1000 its connection carries`,
      });
      assert.deepEqual(readingOf(own, 1_000), {
        read: 0,
        said: `the server's socket from port ${port}, open, read 0 bytes of the 1000 its connection carries`,
      });
    } finally {
      for (const each of clients) {
        each.destroy();
      }

      await new Promise<void>((resolve) => {
        other.close(() => resolve());
      });
    }
  });
});

describe('a webhook waits for its place with its body unread (D210)', () => {
  it('reads no more than the chunk that carried its headers while it waits, and stores it whole once its place comes', async (t: TestContext) => {
    const sessionId = await newSession();
    const body = Buffer.alloc(MAX_BODY_BYTES, 0xa7);
    const filler = plain.budget.take('filler', inFlightBound(plain.budget.settings));
    const sent = call(plain.port, webhook(sessionId, body));

    await until(() => plain.budget.waiting === 1, 'the webhook waits');
    // Long enough for a socket left reading to have read everything.
    await delay(300);

    const { read, said } = readingOf(serverSide(plain, sent.socket), sent.carries);

    t.diagnostic(`while waiting, ${said}`);
    assert.ok(read <= READ_WHILE_WAITING_BYTES, `while waiting, ${said}`);
    assert.deepEqual(await stored(sessionId), []);

    filler.release();

    const answer = await sent.answer;

    assert.equal(answer?.status, 200, answer?.body);
    assert.deepEqual(await stored(sessionId), [described(body)]);
    await until(() => plain.budget.used === 0, 'the weight is given back');
    noWeightLeft(plain);
  });

  // A webhook that arrived whole is stored however its sender leaves (D187).
  // Its connection is not read while it waits, so the sender's departure is
  // not seen, and it is stored once its place comes: behind a PROXY header
  // as before, and without one since the pipelining bound (D229) gives every
  // receive connection's bytes to Node's parser through its `data` listener,
  // as the first read behind a PROXY header always was. A connection Node's
  // parser read natively had parsed the body after the guard had stopped it,
  // and Node then started it again itself: the departure was seen there, and
  // nothing stored.
  for (const [name, through] of [
    ['', () => ({ listener: plain, source: undefined })],
    [', behind a PROXY header', () => ({ listener: proxied, source: '203.0.113.31' })],
  ] as const) {
    it(`stores a webhook that arrived whole once its place comes, though its sender left while it waited${name}`, async () => {
      const { listener, source } = through();
      const sessionId = await newSession();
      const body = Buffer.from('{"left":"early"}');
      const filler = listener.budget.take('filler', inFlightBound(listener.budget.settings));
      const linesBefore = listener.log().length;
      const sent = call(listener.port, webhook(sessionId, body), source);

      await until(() => listener.budget.waiting === 1, 'the webhook waits');
      sent.socket.destroy();
      await delay(200);
      assert.equal(listener.budget.waiting, 1, 'the connection was read while it waited');

      filler.release();
      await until(async () => (await stored(sessionId)).length === 1, 'the webhook is stored');
      assert.deepEqual(await stored(sessionId), [described(body)]);
      await until(() => listener.budget.used === 0, 'the weight is given back');
      noWeightLeft(listener);
      assert.ok(
        !listener
          .log()
          .slice(linesBefore)
          .some((line) => line.level >= 40),
        JSON.stringify(listener.log().slice(linesBefore)),
      );
    });
  }

  it('drops a sender gone in the middle of a 1 MiB body while its socket was not read once its place comes: nothing stored, nothing held', async () => {
    const sessionId = await newSession();
    const filler = plain.budget.take('filler', inFlightBound(plain.budget.settings));
    const linesBefore = plain.log().length;
    // A third of the body declared, then gone: had the sender written all of
    // it before leaving, the kernel would deliver it whole, and a request
    // that arrived whole is stored however its sender leaves (D187).
    const whole = webhook(sessionId, Buffer.alloc(MAX_BODY_BYTES, 0x62));
    const sent = call(plain.port, whole.subarray(0, whole.length - (2 * MAX_BODY_BYTES) / 3));

    await until(() => plain.budget.waiting === 1, 'the webhook waits');
    sent.socket.destroy();
    await delay(100);

    // Node reads nothing of a socket whose request is waiting, so the
    // departure is seen once reading starts again, when the place comes.
    filler.release();
    await until(() => plain.budget.used === 0 && plain.budget.waiting === 0, 'all is given back');
    await delay(100);
    assert.deepEqual(await stored(sessionId), []);

    const lines = plain.log().slice(linesBefore);

    assert.ok(!lines.some((line) => line.level >= 40), JSON.stringify(lines));
    noWeightLeft(plain);
  });

  it('logs a sender gone in the middle of its body as one that left, at info, not as refused, when its wait runs out', async () => {
    const sessionId = await newSession();
    const filler = short.budget.take('filler', inFlightBound(short.budget.settings));
    const linesBefore = short.log().length;
    // Its trail ends with a line at `info`: this hook's, or the error
    // handler's for a request whose connection ended before its body (D174).
    const departed = (): boolean =>
      short
        .log()
        .slice(linesBefore)
        .some((line) => line.msg === SENDER_LEFT || line.msg === 'Request aborted by the client');

    try {
      // As above, a third of the body declared, then gone, on a connection
      // that asks to be closed, so the refusal drains its body first (D143).
      const whole = webhook(sessionId, Buffer.alloc(MAX_BODY_BYTES, 0x66));
      const sent = call(short.port, whole.subarray(0, whole.length - (2 * MAX_BODY_BYTES) / 3));

      await until(() => short.budget.waiting === 1, 'the webhook waits');
      sent.socket.destroy();

      // Not read while it waits, so the departure is seen only once the wait
      // has run out and the drain reads the connection to its close.
      await until(() => short.budget.waiting === 0, 'the wait runs out');
      await until(departed, 'the departure is logged');

      const lines = short.log().slice(linesBefore);

      assert.ok(!lines.some((line) => line.level >= 40), JSON.stringify(lines));
      assert.ok(
        lines.some((line) => line.level === 30 && line.msg === SENDER_LEFT),
        JSON.stringify(lines),
      );
      assert.equal(await sent.answer, null);
      assert.deepEqual(await stored(sessionId), []);
    } finally {
      filler.release();
    }

    noWeightLeft(short);
  });

  it('refuses a webhook whose wait runs out 503 / 1018 with Retry-After: 1, its body read first, and stores nothing', async () => {
    const sessionId = await newSession();
    const filler = short.budget.take('filler', inFlightBound(short.budget.settings));
    const linesBefore = short.log().length;

    try {
      const started = Date.now();
      // A body the client is still sending when the wait runs out: the
      // refusal is answered once it has been read, so it is not lost to a
      // reset (D143).
      const sent = call(short.port, webhook(sessionId, Buffer.alloc(512 * 1024, 0x63)));
      const answer = await sent.answer;

      assert.ok(Date.now() - started >= 300, 'answered before the wait ran out');
      assert.equal(answer?.status, 503, JSON.stringify(answer));
      assert.equal(answer?.headers['retry-after'], '1');
      assert.equal(answer?.headers['x-content-type-options'], 'nosniff');
      assert.equal(answer?.headers['content-security-policy'], "sandbox; default-src 'none'");
      assert.equal(answer?.headers[REQUEST_ID_HEADER], undefined);
      assert.deepEqual(JSON.parse(answer?.body ?? ''), {
        errorCode: 1018,
        message: 'Too many webhooks are being received; try again in a moment',
      });

      const lines = short.log().slice(linesBefore);

      assert.ok(
        lines.some((line) => line.level === 40 && line.msg === REFUSED),
        JSON.stringify(lines),
      );
      assert.ok(!lines.some((line) => line.level >= 50), JSON.stringify(lines));
      assert.deepEqual(await stored(sessionId), []);
    } finally {
      filler.release();
    }

    noWeightLeft(short);
  });

  it('refuses a webhook to a session answering 302 with Location 503 / 1018 without it (D247)', async () => {
    const sessionId = await newSession({ status: 302, headers: [['Location', '/s/x/after']] });
    const filler = short.budget.take('filler', inFlightBound(short.budget.settings));

    try {
      const answer = await call(short.port, webhook(sessionId, Buffer.from('x'))).answer;

      assert.equal(answer?.status, 503, JSON.stringify(answer));
      assert.equal(JSON.parse(answer?.body ?? '').errorCode, 1018);
      assert.equal(answer?.headers.location, undefined);
      assert.deepEqual(await stored(sessionId), []);
    } finally {
      filler.release();
    }

    noWeightLeft(short);
  });

  it('refuses one on a kept-alive connection the same way', async () => {
    const sessionId = await newSession();
    const filler = short.budget.take('filler', inFlightBound(short.budget.settings));

    try {
      const sent = call(
        short.port,
        webhook(sessionId, Buffer.alloc(64 * 1024, 0x64), { keepAlive: true }),
      );
      let received = '';

      sent.socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('latin1');
      });
      await until(() => received.includes('"errorCode":1018'), 'the refusal arrives');
      assert.match(received, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
      assert.match(received, /\r\nretry-after: 1\r\n/i);
      sent.socket.destroy();
      assert.deepEqual(await stored(sessionId), []);
    } finally {
      filler.release();
    }

    noWeightLeft(short);
  });

  it('reads a kept-alive connection again after a webhook with no body waited on it', async () => {
    const sessionId = await newSession();
    const filler = plain.budget.take('filler', inFlightBound(plain.budget.settings));
    const get = (index: number): string =>
      `GET /s/${sessionId}?n=${index} HTTP/1.1\r\nHost: hook.qa-tools.ru\r\n\r\n`;
    const sent = call(plain.port, Buffer.from(get(1), 'latin1'));
    let received = '';

    sent.socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
    });

    try {
      await until(() => plain.budget.waiting === 1, 'the GET waits');
      filler.release();
      await until(() => received.includes('HTTP/1.1 200 OK'), 'the first is answered');

      // The same connection, once more: it must still be read.
      sent.socket.write(get(2));
      await until(() => received.split('HTTP/1.1 200 OK').length === 3, 'the second is answered');
    } finally {
      filler.release();
      sent.socket.destroy();
    }

    const stored = await pool.query<{ query_string: string }>(
      'SELECT query_string FROM requests WHERE session_id = $1 ORDER BY received_at',
      [sessionId],
    );

    assert.deepEqual(
      stored.rows.map((row) => row.query_string),
      ['n=1', 'n=2'],
    );
    await until(() => plain.budget.used === 0, 'the weight is given back');
    noWeightLeft(plain);
  });

  it('reads a kept-alive connection again after a webhook with no body was refused 503 on it', async () => {
    const sessionId = await newSession();
    const filler = short.budget.take('filler', inFlightBound(short.budget.settings));
    const get = (index: number): string =>
      `GET /s/${sessionId}?n=${index} HTTP/1.1\r\nHost: hook.qa-tools.ru\r\n\r\n`;
    const sent = call(short.port, Buffer.from(get(1), 'latin1'));
    let received = '';

    sent.socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
    });

    try {
      await until(() => received.includes('"errorCode":1018'), 'the first is refused');
      filler.release();
      sent.socket.write(get(2));
      await until(() => received.includes('HTTP/1.1 200 OK'), 'the second is answered');
    } finally {
      filler.release();
      sent.socket.destroy();
    }

    const stored = await pool.query<{ query_string: string }>(
      'SELECT query_string FROM requests WHERE session_id = $1',
      [sessionId],
    );

    assert.deepEqual(
      stored.rows.map((row) => row.query_string),
      ['n=2'],
    );
    await until(() => short.budget.used === 0, 'the weight is given back');
    noWeightLeft(short);
  });

  it('refuses none of a body declared over 1 MiB, which weighs nothing and is answered 413 at once', async () => {
    const sessionId = await newSession();
    const filler = plain.budget.take('filler', inFlightBound(plain.budget.settings));

    try {
      const head = Buffer.from(
        `POST /s/${sessionId} HTTP/1.1\r\nHost: h\r\nConnection: close\r\nContent-Length: ${MAX_BODY_BYTES + 1}\r\n\r\n`,
        'latin1',
      );
      const sent = call(plain.port, head);
      const answer = await sent.answer;

      assert.equal(answer?.status, 413);
      assert.equal(plain.budget.waiting, 0);
    } finally {
      filler.release();
    }

    noWeightLeft(plain);
  });
});

describe('the line waiting for a place, over sockets (D228)', () => {
  const A = '203.0.113.1';
  const B = '203.0.113.2';

  /** The log lines `lineBound` wrote since `before`. */
  function since(before: number): LogLine[] {
    return lineBound.log().slice(before);
  }

  it('refuses the next of a full address at once, 503 / 1018 with Retry-After: 1 and Connection: close, nothing stored, another address unaffected', async () => {
    const sessionA = await newSession();
    const sessionB = await newSession();
    const filler = lineBound.budget.take('filler', inFlightBound(lineBound.budget.settings));
    const linesBefore = lineBound.log().length;

    try {
      // The first of A waits (an empty line always takes it).
      const firstA = call(lineBound.port, webhook(sessionA, Buffer.from('{"a":1}')), A);

      await until(() => lineBound.budget.waiting === 1, 'A’s first waits');

      // The first of B waits too: the process line still has room.
      const firstB = call(lineBound.port, webhook(sessionB, Buffer.from('{"b":1}')), B);

      await until(() => lineBound.budget.waiting === 2, 'B’s first waits');

      // A’s second, on a kept-alive connection, is refused at once - well
      // under the 3 s wait - with Connection: close, and nothing is stored.
      const started = Date.now();
      const refused = call(
        lineBound.port,
        webhook(sessionA, Buffer.from('{"a":2}'), { keepAlive: true }),
        A,
      );
      const answer = await refused.answer;

      assert.ok(Date.now() - started < BOUNDED_WAIT_MS, `waited ${Date.now() - started} ms`);
      assert.equal(answer?.status, 503, JSON.stringify(answer));
      assert.equal(answer?.headers['retry-after'], '1');
      assert.equal(answer?.headers.connection, 'close');
      assert.equal(answer?.headers[REQUEST_ID_HEADER], undefined);
      assert.deepEqual(JSON.parse(answer?.body ?? ''), {
        errorCode: 1018,
        message: 'Too many webhooks are being received; try again in a moment',
      });
      assert.deepEqual(await stored(sessionA), [], 'nothing stored for the refused address');

      const lines = since(linesBefore);

      assert.ok(
        lines.some((line) => line.level === 40 && line.msg === REFUSED_LINE_FULL),
        JSON.stringify(lines),
      );
      assert.ok(!lines.some((line) => line.level >= 50), JSON.stringify(lines));

      // The two that were allowed to wait go in once there is room, and store.
      filler.release();
      assert.equal((await firstA.answer)?.status, 200);
      assert.equal((await firstB.answer)?.status, 200);
      assert.deepEqual(await stored(sessionA), [described(Buffer.from('{"a":1}'))]);
      assert.deepEqual(await stored(sessionB), [described(Buffer.from('{"b":1}'))]);
    } finally {
      filler.release();
    }

    await until(() => lineBound.budget.used === 0, 'the weight is given back');
    assert.equal(lineBound.budget.lineUsed, 0);
    noWeightLeft(lineBound);
  });

  it('always lets the first of an address wait though the line has no room, and stores a 2,500-line webhook whole', async () => {
    const sessionId = await newSession();
    const filler = lineBound.budget.take('filler', inFlightBound(lineBound.budget.settings));
    const body = Buffer.from('{"lines":2500}');
    // 2,500 header lines weigh 641 KiB in the line, far over its one small
    // webhook, yet the first of its address waits all the same (D228). One
    // counted byte a name and value each, so the request stays under Node's
    // 16 KiB of header names and values (`receiver.test.ts`).
    const symbols = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const extra: [string, string][] = Array.from({ length: 2_500 - WEBHOOK_LINES }, (_, index) => [
      symbols[Math.floor(index / symbols.length) % symbols.length] as string,
      symbols[index % symbols.length] as string,
    ]);

    assert.ok(
      waitingWeight(Array(2 * 2_500).fill('')) > lineBound.budget.settings.waitingPerAddressBytes,
    );

    try {
      const sent = call(lineBound.port, webhook(sessionId, body, { extra }), '203.0.113.9');

      await until(() => lineBound.budget.waiting === 1, 'the heavy first waits');
      filler.release();

      const answer = await sent.answer;

      assert.equal(answer?.status, 200, answer?.body);
      assert.deepEqual(await stored(sessionId), [described(body)]);

      // Every one of its 2,500 header lines is stored, in order: Host and
      // Connection first, Content-Type and Content-Length last (D187).
      const headers = await pool.query<{ headers: [string, string][] }>(
        'SELECT headers FROM requests WHERE session_id = $1',
        [sessionId],
      );

      assert.equal(headers.rows.length, 1);
      assert.equal(headers.rows[0]?.headers.length, 2_500);
      assert.deepEqual(headers.rows[0]?.headers.slice(2, 2_500 - 2), extra);
    } finally {
      filler.release();
    }

    await until(() => lineBound.budget.used === 0, 'the weight is given back');
    assert.equal(lineBound.budget.lineUsed, 0);
    noWeightLeft(lineBound);
  });
});

describe('at most eight refused bodies drain at once, over sockets (D228)', () => {
  it('drains the stalled 1 MiB bodies of eight refused GETs and answers the ninth 503 / 1018 at once, before its body, its connection closed', async () => {
    const sessionId = await newSession();
    const filler = short.budget.take('filler', inFlightBound(short.budget.settings));
    const linesBefore = short.log().length;
    // A GET declaring 1 MiB on a connection that asks to be closed, its body
    // not sent: refused once its 300 ms run out, and D143 would drain it.
    const head = Buffer.from(
      [
        `GET /s/${sessionId} HTTP/1.1`,
        'Host: hook.qa-tools.ru',
        'Connection: close',
        'Content-Type: application/octet-stream',
        `Content-Length: ${MAX_BODY_BYTES}`,
        '',
        '',
      ].join('\r\n'),
      'latin1',
    );
    const calls: Call[] = [];
    const receivedBytes: number[] = [];

    await until(() => refusalDrainPlaces.taken === 0, 'no drain place is taken');

    try {
      for (let index = 0; index <= MAX_CONCURRENT_REFUSAL_DRAINS; index += 1) {
        const sent = call(short.port, head);

        receivedBytes.push(0);
        sent.socket.on('data', (chunk: Buffer) => {
          receivedBytes[index] = (receivedBytes[index] ?? 0) + chunk.length;
        });
        calls.push(sent);
      }

      // Their waits run out together: eight take the process's eight drain
      // places and read bodies that do not come.
      await until(
        () => refusalDrainPlaces.taken === MAX_CONCURRENT_REFUSAL_DRAINS,
        'eight drain places are taken',
      );

      // The ninth finds none: answered at once, its body unread and never
      // sent, and its connection closed by the server.
      const ninth = await Promise.race(
        calls.map(async (each, index) => ({ index, answer: await each.answer })),
      );

      assert.equal(ninth.answer?.status, 503, JSON.stringify(ninth.answer));
      assert.equal(ninth.answer?.headers['retry-after'], '1');
      assert.equal(ninth.answer?.headers.connection, 'close');
      assert.equal(ninth.answer?.headers[REQUEST_ID_HEADER], undefined);
      assert.deepEqual(JSON.parse(ninth.answer?.body ?? ''), {
        errorCode: 1018,
        message: 'Too many webhooks are being received; try again in a moment',
      });

      const draining = calls.filter((_, index) => index !== ninth.index);

      // The eight still drain, unanswered, their connections open.
      await delay(200);
      assert.equal(refusalDrainPlaces.taken, MAX_CONCURRENT_REFUSAL_DRAINS);
      assert.deepEqual(
        draining.map((each) => receivedBytes[calls.indexOf(each)]),
        Array(MAX_CONCURRENT_REFUSAL_DRAINS).fill(0),
      );
      assert.ok(draining.every((each) => !each.socket.destroyed && !each.socket.readableEnded));

      // Their bodies sent, each drain ends and its refusal is delivered.
      for (const each of draining) {
        each.socket.write(Buffer.alloc(MAX_BODY_BYTES, 0x71));
      }

      for (const each of draining) {
        const answer = await each.answer;

        assert.equal(answer?.status, 503, JSON.stringify(answer));
        assert.equal(JSON.parse(answer?.body ?? '').errorCode, 1018);
      }

      await until(() => refusalDrainPlaces.taken === 0, 'every drain place is given back');
      assert.deepEqual(await stored(sessionId), []);

      const lines = short.log().slice(linesBefore);

      assert.equal(
        lines.filter((line) => line.level === 40 && line.msg === REFUSED).length,
        MAX_CONCURRENT_REFUSAL_DRAINS + 1,
        JSON.stringify(lines),
      );
      assert.ok(!lines.some((line) => line.level >= 50), JSON.stringify(lines));
    } finally {
      filler.release();

      for (const each of calls) {
        each.socket.destroy();
      }
    }

    await until(() => short.budget.used === 0, 'the weight is given back');
    noWeightLeft(short);
  });
});

describe("the application listener's /s/... 410 shares the eight drain places (D228)", () => {
  it('drains the stalled 1 MiB bodies of eight refused POSTs and answers the ninth 410 / 1009 at once, before its body, its connection closed', async () => {
    const sessionId = await newSession();
    // A webhook sent to the host that stopped receiving them (D187), on a
    // connection that asks to be closed, declaring 1 MiB it does not send:
    // refused before its body, and D143 would drain it. `/s/...` holds no
    // place among its address's calls in flight (D213), so the drain places
    // are what bounds these drains.
    const head = Buffer.from(
      [
        `POST /s/${sessionId} HTTP/1.1`,
        'Host: qa-tools.ru',
        'Connection: close',
        'Content-Type: application/octet-stream',
        `Content-Length: ${MAX_BODY_BYTES}`,
        '',
        '',
      ].join('\r\n'),
      'latin1',
    );
    const calls: Call[] = [];
    const receivedBytes: number[] = [];

    await until(() => refusalDrainPlaces.taken === 0, 'no drain place is taken');

    try {
      for (let index = 0; index <= MAX_CONCURRENT_REFUSAL_DRAINS; index += 1) {
        const sent = call(apiPort, head);

        receivedBytes.push(0);
        sent.socket.on('data', (chunk: Buffer) => {
          receivedBytes[index] = (receivedBytes[index] ?? 0) + chunk.length;
        });
        calls.push(sent);
      }

      // Eight take the process's eight drain places and read bodies that do
      // not come.
      await until(
        () => refusalDrainPlaces.taken === MAX_CONCURRENT_REFUSAL_DRAINS,
        'eight drain places are taken',
      );

      // The ninth finds none: answered at once, its body unread and never
      // sent, and its connection closed by the server.
      const ninth = await Promise.race(
        calls.map(async (each, index) => ({ index, answer: await each.answer })),
      );

      assert.equal(ninth.answer?.status, 410, JSON.stringify(ninth.answer));
      assert.equal(ninth.answer?.headers.connection, 'close');
      assert.equal(JSON.parse(ninth.answer?.body ?? '').errorCode, ErrorCode.RECEIVE_URL_MOVED);
      assert.ok(calls[ninth.index]?.socket.destroyed);

      const draining = calls.filter((_, index) => index !== ninth.index);

      // The eight still drain, unanswered, their connections open.
      await delay(200);
      assert.equal(refusalDrainPlaces.taken, MAX_CONCURRENT_REFUSAL_DRAINS);
      assert.deepEqual(
        draining.map((each) => receivedBytes[calls.indexOf(each)]),
        Array(MAX_CONCURRENT_REFUSAL_DRAINS).fill(0),
      );
      assert.ok(draining.every((each) => !each.socket.destroyed && !each.socket.readableEnded));

      // Their bodies sent, each drain ends and its 410 is delivered.
      for (const each of draining) {
        each.socket.write(Buffer.alloc(MAX_BODY_BYTES, 0x71));
      }

      for (const each of draining) {
        const answer = await each.answer;

        assert.equal(answer?.status, 410, JSON.stringify(answer));
        assert.equal(JSON.parse(answer?.body ?? '').errorCode, ErrorCode.RECEIVE_URL_MOVED);
      }

      await until(() => refusalDrainPlaces.taken === 0, 'every drain place is given back');
      assert.deepEqual(await stored(sessionId), []);
    } finally {
      for (const each of calls) {
        each.socket.destroy();
      }
    }
  });
});

describe('a lone refused body is drained whole (D143, D228)', () => {
  it('delivers a 503 / 1018 on a closing connection whose 1 MiB body is still arriving, its body read first', async () => {
    const sessionId = await newSession();
    const filler = short.budget.take('filler', inFlightBound(short.budget.settings));
    const linesBefore = short.log().length;
    const body = Buffer.alloc(MAX_BODY_BYTES, 0x7a);

    try {
      const started = Date.now();
      const sent = call(short.port, webhook(sessionId, body));
      const answer = await sent.answer;

      // Answered only once the wait ran out, and only once the body was read:
      // the drain (D143) read a place from the process's places (D228) and
      // the answer is not lost to a reset.
      assert.ok(Date.now() - started >= 300, 'answered before the wait ran out');
      assert.equal(answer?.status, 503, JSON.stringify(answer));
      assert.equal(answer?.headers['retry-after'], '1');
      assert.deepEqual(JSON.parse(answer?.body ?? ''), {
        errorCode: 1018,
        message: 'Too many webhooks are being received; try again in a moment',
      });
      assert.deepEqual(await stored(sessionId), []);

      const lines = short.log().slice(linesBefore);

      assert.ok(
        lines.some((line) => line.level === 40 && line.msg === REFUSED),
        JSON.stringify(lines),
      );
    } finally {
      filler.release();
    }

    noWeightLeft(short);
  });
});

/**
 * A `GET`, `HEAD` or `TRACE` declaring `body`'s length, or sending it chunked,
 * and then `body`, asking for `Connection: close`.
 */
function bodylessWithBody(
  method: string,
  sessionId: string,
  body: Buffer,
  chunked: boolean,
): Buffer {
  const head = [
    `${method} /s/${sessionId} HTTP/1.1`,
    'Host: hook.qa-tools.ru',
    'Connection: close',
    'Content-Type: application/octet-stream',
    chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${body.length}`,
    '',
    '',
  ].join('\r\n');
  const framed = chunked
    ? Buffer.concat([
        Buffer.from(`${body.length.toString(16)}\r\n`, 'latin1'),
        body,
        Buffer.from('\r\n0\r\n\r\n', 'latin1'),
      ])
    : body;

  return Buffer.concat([Buffer.from(head, 'latin1'), framed]);
}

describe('a GET, HEAD or TRACE, whose body Fastify never reads (D210)', () => {
  it('holds, while a delay holds its reply, at least what Node read of the body it declared and keeps unread', async (t: TestContext) => {
    const answerBody = '{"held":true}';
    const cases: [string, string, Buffer, boolean][] = [
      ['a GET of 1 MiB', 'GET', Buffer.alloc(MAX_BODY_BYTES, 0x67), false],
      ['a HEAD of 1 MiB', 'HEAD', Buffer.alloc(MAX_BODY_BYTES, 0x68), false],
      ['a TRACE of 1 MiB', 'TRACE', Buffer.alloc(MAX_BODY_BYTES, 0x74), false],
      ['a GET of 1 MiB, chunked', 'GET', Buffer.alloc(MAX_BODY_BYTES, 0x63), true],
      ['a GET of 100,000 bytes', 'GET', Buffer.alloc(100_000, 0x31), false],
    ];
    // The request as Node hands it to the server, whose stream holds what it
    // read of the body.
    const received: IncomingMessage[] = [];
    const onRequest = (request: IncomingMessage): void => {
      received.push(request);
    };

    plain.app.server.on('request', onRequest);

    try {
      for (const [what, method, body, chunked] of cases) {
        const sessionId = await newSession({ status: 202, body: answerBody, delayMs: 1_000 });
        const before = received.length;
        const sent = call(plain.port, bodylessWithBody(method, sessionId, body, chunked));

        await until(
          async () =>
            (await pool.query('SELECT 1 FROM requests WHERE session_id = $1', [sessionId]))
              .rowCount === 1,
          `${what} is stored`,
        );
        // Long enough for Node to have read all it reads while nobody does.
        await delay(200);

        const request = received[before];
        const buffered = request?.readableLength ?? Number.NaN;
        const { read, said } = readingOf(serverSide(plain, sent.socket), sent.carries);
        const held = plain.budget.used;

        t.diagnostic(`${what}: ${said}, ${buffered} kept unread in its stream, ${held} held`);
        // Not vacuous: Node does keep a body it read, at least its first chunk.
        assert.ok(buffered >= Math.min(body.length, 60_000), `${what}: ${buffered} kept`);
        assert.ok(held >= read, `${what}: ${held} held, where ${said}`);
        assert.ok(held >= buffered, `${what}: ${held} held for ${buffered} kept`);

        assert.equal((await sent.answer)?.status, 202, what);
        await until(() => plain.budget.used === 0, `${what}: the weight is given back`);
      }
    } finally {
      plain.app.server.off('request', onRequest);
    }

    noWeightLeft(plain);
  });

  it('waits for its place declaring 2,000,000 bytes just as declaring none, with its address full, and is stored once there is room', async () => {
    const sessionId = await newSession();
    const { budget } = proxied;
    const sender = '203.0.113.44';
    const full = budget.take(sender, budget.settings.perAddressBytes);
    const sent: { what: string; call: Call }[] = [];

    try {
      for (const method of METHODS_WITHOUT_BODY) {
        for (const declared of [2_000_000, 0]) {
          const head = [
            `${method} /s/${sessionId}?declared=${declared} HTTP/1.1`,
            'Host: hook.qa-tools.ru',
            'Connection: close',
            `Content-Length: ${declared}`,
            '',
            '',
          ].join('\r\n');

          sent.push({
            what: `${method} declaring ${declared}`,
            call: call(proxied.port, Buffer.from(head, 'latin1'), sender),
          });
        }
      }

      // Neither is refused `413` by Fastify, which never reads their body,
      // so a length declared over 1 MiB weighs 1 MiB, not nothing, and lets
      // none of them past the line.
      await until(() => budget.waiting === sent.length, 'every one waits');
      await delay(200);
      assert.equal(budget.waiting, sent.length);
      assert.deepEqual(await stored(sessionId), []);

      full.release();

      for (const { what, call: each } of sent) {
        assert.equal((await each.answer)?.status, 200, what);
      }
    } finally {
      full.release();

      for (const { call: each } of sent) {
        each.socket.destroy();
      }
    }

    const rows = await pool.query<{ method: string; query_string: string; body: Buffer }>(
      'SELECT method, query_string, body FROM requests WHERE session_id = $1',
      [sessionId],
    );

    assert.deepEqual(
      rows.rows.map((row) => `${row.method} ${row.query_string} ${row.body.length}`).sort(),
      sent.map(({ what }) => what.replace(/ declaring (\d+)$/, ' declared=$1 0')).sort(),
    );
    await until(() => budget.used === 0, 'the weight is given back');
    noWeightLeft(proxied);
  });
});

/** What a connection's client has been answered so far, as it arrives. */
function answersOn(socket: net.Socket): () => string {
  let received = '';

  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString('latin1');
  });

  return () => received;
}

/** How many answers of `status` `received` holds. */
function count(received: string, status: string): number {
  return received.split(`HTTP/1.1 ${status}`).length - 1;
}

/** The request pipelined first, kept alive: a `GET` with no body, or a small `POST`. */
function firstOf(kind: 'GET' | 'POST', sessionId: string): Buffer {
  return kind === 'GET'
    ? Buffer.from(`GET /s/${sessionId}?first HTTP/1.1\r\nHost: hook.qa-tools.ru\r\n\r\n`, 'latin1')
    : webhook(sessionId, Buffer.from('{"first":true}'), { keepAlive: true });
}

describe('the webhooks of one connection share its stop (D210)', () => {
  for (const [kind, atOnce] of [
    ['GET', false],
    ['POST', false],
    ['GET', true],
  ] as const) {
    it(`keeps a connection unread while a POST of 1 MiB pipelined behind a ${kind} admitted ${atOnce ? 'at once' : 'after waiting with it'} waits, and stores the POST whole once its place comes`, async (t: TestContext) => {
      const sessionId = await newSession();
      const { budget } = plain;
      const body = Buffer.alloc(MAX_BODY_BYTES, 0x70);
      // Room for the first, about 81 KiB with the answer's 64 KiB, not for
      // the POST behind it: at once, or once both wait.
      const room = inFlightBound(budget.settings) - 256 * 1024;
      const filler = budget.take('filler', atOnce ? room : inFlightBound(budget.settings));
      const sent = call(
        plain.port,
        Buffer.concat([firstOf(kind, sessionId), webhook(sessionId, body)]),
      );
      const received = answersOn(sent.socket);

      try {
        if (!atOnce) {
          await until(() => budget.waiting === 2, 'both wait');
          filler.shrink(room);
        }

        await until(() => count(received(), '200 OK') === 1, `the ${kind} is answered`);
        // Long enough for a socket left reading to have read the POST whole.
        await delay(300);

        const { read, said } = readingOf(serverSide(plain, sent.socket), sent.carries);

        t.diagnostic(`while the POST waits behind an answered ${kind}, ${said}`);
        assert.equal(budget.waiting, 1, 'the POST waits');
        assert.ok(read <= READ_WHILE_WAITING_BYTES, `while the POST waited, ${said}`);

        filler.release();

        const answer = await sent.answer;

        assert.equal(count(received(), '200 OK'), 2, JSON.stringify(answer));
      } finally {
        filler.release();
        sent.socket.destroy();
      }

      assert.deepEqual((await stored(sessionId)).at(-1), described(body));
      assert.equal((await stored(sessionId)).length, 2);
      await until(() => budget.used === 0, 'the weight is given back');
      noWeightLeft(plain);
    });
  }

  it('keeps a connection unread while a POST of 1 MiB waits at the pipelining bound’s count, though the GET before it is answered meanwhile (D229)', async (t: TestContext) => {
    const sessionId = await newSession();
    const { budget } = pairBound;
    const body = Buffer.alloc(MAX_BODY_BYTES, 0x70);
    // Room for the GET, not for the POST: the bound, at 2, stopped the
    // connection at the POST's head, and the guard finds it stopped.
    const filler = budget.take('filler', inFlightBound(budget.settings) - 256 * 1024);
    const sent = call(
      pairBound.port,
      Buffer.concat([firstOf('GET', sessionId), webhook(sessionId, body)]),
    );
    const received = answersOn(sent.socket);

    try {
      await until(() => count(received(), '200 OK') === 1, 'the GET is answered');
      // Long enough for a socket the bound started again to have read on.
      await delay(300);

      const { read, said } = readingOf(serverSide(pairBound, sent.socket), sent.carries);

      t.diagnostic(`while the POST waits at the bound's count, ${said}`);
      assert.equal(budget.waiting, 1, 'the POST waits');
      assert.ok(read <= READ_WHILE_WAITING_BYTES, `while the POST waited, ${said}`);

      filler.release();

      const answer = await sent.answer;

      assert.equal(count(received(), '200 OK'), 2, JSON.stringify(answer));
    } finally {
      filler.release();
      sent.socket.destroy();
    }

    assert.deepEqual((await stored(sessionId)).at(-1), described(body));
    await until(() => budget.used === 0, 'the weight is given back');
    noWeightLeft(pairBound);
  });

  it('reads it again only once the last of them goes in: a GET and a POST both waiting are admitted together and stored', async () => {
    const sessionId = await newSession();
    const { budget } = plain;
    const body = Buffer.alloc(MAX_BODY_BYTES, 0x71);
    const filler = budget.take('filler', inFlightBound(budget.settings));
    const sent = call(
      plain.port,
      Buffer.concat([firstOf('GET', sessionId), webhook(sessionId, body)]),
    );
    const received = answersOn(sent.socket);

    try {
      await until(() => budget.waiting === 2, 'both wait');
      await delay(200);

      const { read, said } = readingOf(serverSide(plain, sent.socket), sent.carries);

      assert.ok(read <= READ_WHILE_WAITING_BYTES, `while both waited, ${said}`);

      filler.release();
      await sent.answer;
      assert.equal(count(received(), '200 OK'), 2, received().slice(0, 200));
    } finally {
      filler.release();
      sent.socket.destroy();
    }

    assert.deepEqual(await stored(sessionId), [described(Buffer.alloc(0)), described(body)]);
    await until(() => budget.used === 0, 'the weight is given back');
    noWeightLeft(plain);
  });

  it('refuses both 503 when their waits run out, the POST’s body read first, and stores nothing', async () => {
    const sessionId = await newSession();
    const { budget } = short;
    const filler = budget.take('filler', inFlightBound(budget.settings));
    const sent = call(
      short.port,
      Buffer.concat([
        firstOf('GET', sessionId),
        webhook(sessionId, Buffer.alloc(MAX_BODY_BYTES, 0x72)),
      ]),
    );
    const received = answersOn(sent.socket);

    try {
      await until(() => sidesOf(short, sent.socket).length > 0, 'the connection is accepted');

      // Found while open, and read once the connection has closed.
      const server = serverSide(short, sent.socket);
      // The POST is answered only once its body has been drained, which
      // needs its connection read although the GET before it was refused.
      const answer = await sent.answer;
      const { read, said } = readingOf(server, sent.carries);

      assert.equal(count(received(), '503 Service Unavailable'), 2, JSON.stringify(answer));
      assert.equal(received().split('"errorCode":1018').length - 1, 2);
      assert.ok(read > MAX_BODY_BYTES, `once both were refused, ${said}`);
    } finally {
      filler.release();
      sent.socket.destroy();
    }

    assert.deepEqual(await stored(sessionId), []);
    noWeightLeft(short);
  });

  it('lets both go when their sender leaves while they wait, at the latest when their waits run out: nothing stored, nothing held', async () => {
    // Not a departure seen as it happens: with their connection stopped,
    // Node generally does not see it end (point 6). On the default wait of
    // 30 s both left the line at 30.0 s, measured at 70fccd6, the `GET`
    // refused at `warn` to nobody and the `POST`, its body drained, logged as
    // one that left; on the CI runner at af65504, on the short wait, both were
    // refused at `warn`, the departure not seen by then. Which line each gets
    // is therefore not claimed: one each, either one that left at `info` or a
    // refusal at `warn`. What is claimed, once the waits have run out and the
    // connection is read again: nothing stored, nothing held, nothing waiting
    // and nothing at `error` or above.
    const sessionId = await newSession();
    const { budget } = short;
    const filler = budget.take('filler', inFlightBound(budget.settings));
    const linesBefore = short.log().length;
    const sent = call(
      short.port,
      Buffer.concat([
        firstOf('GET', sessionId),
        webhook(sessionId, Buffer.alloc(MAX_BODY_BYTES, 0x73)),
      ]),
    );

    try {
      await until(() => budget.waiting === 2, 'both wait');
      sent.socket.destroy();
      await until(() => budget.waiting === 0, 'neither waits');
    } finally {
      filler.release();
    }

    const since = (): LogLine[] => short.log().slice(linesBefore);
    const arrivals = since().filter((line) => line.msg === 'incoming request');

    assert.deepEqual(
      arrivals.map((line) => line.req?.method),
      ['GET', 'POST'],
      JSON.stringify(since()),
    );

    await until(
      () => arrivals.every((arrival) => letGoOf(since(), arrival.reqId).length > 0),
      'each is let go',
    );
    await delay(100);
    assert.deepEqual(await stored(sessionId), []);

    const lines = since();

    for (const arrival of arrivals) {
      letGoOnce(lines, arrival.reqId);
    }

    assert.ok(!lines.some((line) => line.level >= 50), JSON.stringify(lines));
    noWeightLeft(short);
  });
});

describe('a connection that dies gives back what its pipelined webhooks hold (D210)', () => {
  // Pipelined behind a `GET` whose answer a delay holds, the answers of the
  // webhooks after it wait unwritten in Node's line for the connection
  // (`state.outgoing`). Their holds are given back on their replies'
  // `close`, which Node 24 emits for those too when the connection closes:
  // `socketOnClose` destroys them (`abortOutgoing`, `node:_http_server`).
  // Node was once read as destroying only the requests, not their answers;
  // these tests held at 70fccd6 all the same.
  for (const [name, source] of [
    ['directly', undefined],
    ['behind the PROXY protocol', '203.0.113.91'],
  ] as const) {
    const on = (): Listener => (source === undefined ? plain : proxied);

    it(`gives back the holds of stored webhooks whose answers wait behind a delayed one, ${name}`, async () => {
      const delayed = await newSession({ status: 200, body: 'held', delayMs: 30_000 });
      const answered = await newSession();
      const listener = on();
      const { budget } = listener;
      const bodies = [
        Buffer.from('{"pipelined":1}'),
        Buffer.alloc(MAX_BODY_BYTES, 0x74),
        Buffer.from('{"pipelined":3}'),
      ];
      const sent = call(
        listener.port,
        Buffer.concat([
          firstOf('GET', delayed),
          ...bodies.map((body) => webhook(answered, body, { keepAlive: true })),
        ]),
        source,
      );
      const received = answersOn(sent.socket);

      try {
        await until(
          async () =>
            (await storedBodies(delayed)).length === 1 &&
            (await storedBodies(answered)).length === bodies.length,
          'all four are stored',
        );
        await until(() => budget.waiting === 0, 'none waits');
        // Each still holds its stored weight: the `GET` for its delay, those
        // behind it until their queued answers are written.
        await delay(200);
        assert.ok(budget.used > 0, 'nothing is held');
        assert.equal(received(), '', 'an answer was written behind the delayed GET');

        sent.socket.destroy();
        // Within `until`'s 5 s, so the delay's end cannot stand in for it.
        await until(() => budget.used === 0, 'the holds are given back');
      } finally {
        sent.socket.destroy();
      }

      assert.deepEqual(await stored(answered), bodies.map(described));
      noWeightLeft(listener);
    });

    it(`lets a pipelined webhook still waiting go, at the latest when its wait runs out, and gives back every hold, ${name}`, async (t: TestContext) => {
      // With a webhook of the connection waiting, the connection is not read,
      // and Node sees it end only when it next reads or writes it (points 6
      // and 7). Writing the answer the delay holds, here after 2 s, often
      // brings that about, and the waiting `POST` then leaves the line as one
      // that left; not always: in 20 cases at af65504 on macOS,
      // on the default wait, 7 left only when their wait of 30 s ran out,
      // refused at `warn` to nobody. Either line is accepted. The two before
      // it give back their holds once their answers are written, and the
      // `POST` holds nothing while it waits, so what is claimed is the bound:
      // on a wait of 3 s, past the delay, nothing waits and nothing is held
      // beyond the filler by the time it has run out, with a margin.
      const delayed = await newSession({ status: 200, body: 'held', delayMs: 2_000 });
      const answered = await newSession();
      const listener = source === undefined ? bounded : boundedProxied;
      const { budget } = listener;
      // Room for the `GET` and the small `POST`, about 81 KiB each with the
      // answer's 64 KiB, not for the `POST` of 1 MiB behind them.
      const fillerWeight = inFlightBound(budget.settings) - 256 * 1024;
      const filler = budget.take('filler', fillerWeight);
      const linesBefore = listener.log().length;
      const since = (): LogLine[] => listener.log().slice(linesBefore);
      const small = Buffer.from('{"pipelined":"stored"}');
      const sent = call(
        listener.port,
        Buffer.concat([
          firstOf('GET', delayed),
          webhook(answered, small, { keepAlive: true }),
          webhook(answered, Buffer.alloc(MAX_BODY_BYTES, 0x75), { keepAlive: true }),
        ]),
        source,
      );
      const received = answersOn(sent.socket);

      try {
        await until(
          async () =>
            (await storedBodies(delayed)).length === 1 &&
            (await storedBodies(answered)).length === 1 &&
            budget.waiting === 1,
          'the GET and the small POST are stored, the POST of 1 MiB waits',
        );
        assert.ok(budget.used > fillerWeight, 'nothing is held');
        assert.equal(received(), '', 'an answer was written behind the delayed GET');

        const left = Date.now();

        sent.socket.destroy();
        await until(
          () => budget.waiting === 0 && budget.used === fillerWeight,
          'the POST leaves the line and every hold is given back',
          BOUNDED_WAIT_MS + 5_000,
        );
        t.diagnostic(`nothing waits or is held ${Date.now() - left} ms after the sender left`);
      } finally {
        filler.release();
        sent.socket.destroy();
      }

      const arrivals = since().filter((line) => line.msg === 'incoming request');

      assert.deepEqual(
        arrivals.map((line) => line.req?.method),
        ['GET', 'POST', 'POST'],
        JSON.stringify(since()),
      );

      const waiter = arrivals[2]?.reqId;

      await until(() => letGoOf(since(), waiter).length > 0, 'the POST of 1 MiB is let go');

      const lines = since();

      letGoOnce(lines, waiter);
      t.diagnostic(`the POST of 1 MiB: ${letGoOf(lines, waiter)[0]?.msg}`);
      assert.ok(!lines.some((line) => line.level >= 50), JSON.stringify(lines));
      // At `warn`, that `POST`'s refusal alone, if it was refused.
      assert.ok(
        lines
          .filter((line) => line.level >= 40)
          .every((line) => line.reqId === waiter && line.msg === REFUSED),
        JSON.stringify(lines),
      );
      assert.deepEqual(await stored(answered), [described(small)]);
      noWeightLeft(listener);
    });
  }
});

describe('the light senders’ reserve, over sockets (D261)', () => {
  it('stores a light sender’s webhook at once while the process’s 64 MiB is taken, and gives the reserve back once it is answered', async () => {
    const sessionId = await newSession();
    const body = Buffer.from('{"light":"sender"}');
    const { totalBytes } = plain.budget.settings;
    const filler = plain.budget.take('filler', totalBytes);

    try {
      const answer = await call(plain.port, webhook(sessionId, body)).answer;

      assert.equal(answer?.status, 200);
      assert.equal(plain.budget.waiting, 0);
      assert.deepEqual(await stored(sessionId), [described(body)]);
      await until(() => plain.budget.used === totalBytes, 'the reserve is given back');
    } finally {
      filler.release();
    }

    noWeightLeft(plain);
  });

  it('gives the reserve back when a light sender leaves while a delay holds its answer', async () => {
    const sessionId = await newSession({ status: 202, body: '{}', delayMs: 10_000 });
    const body = Buffer.from('{"left":"after it was stored"}');
    const { totalBytes } = plain.budget.settings;
    const filler = plain.budget.take('filler', totalBytes);

    try {
      const sent = call(plain.port, webhook(sessionId, body));

      await until(
        async () => (await storedBodies(sessionId)).length === 1,
        'the webhook is stored',
      );
      assert.ok(plain.budget.used > totalBytes, 'the webhook holds nothing of the reserve');
      sent.socket.destroy();
      await until(() => plain.budget.used === totalBytes, 'the reserve is given back');
    } finally {
      filler.release();
    }

    noWeightLeft(plain);
  });
});

describe('the weight of a webhook (D210)', () => {
  it('is held while a delay holds its reply, shrunk to 16 KiB, its header part and the answer’s body, and given back once the reply has closed', async () => {
    const answerBody = '{"late":true}';
    const sessionId = await newSession({ status: 202, body: answerBody, delayMs: 800 });
    const body = Buffer.alloc(MAX_BODY_BYTES, 0x65);
    const sent = call(plain.port, webhook(sessionId, body));

    await until(async () => (await storedBodies(sessionId)).length === 1, 'the webhook is stored');
    await until(
      () =>
        plain.budget.used ===
        CAPTURE_BASE_WEIGHT_BYTES +
          WEBHOOK_LINES * CAPTURE_HEADER_LINE_WEIGHT_BYTES +
          Buffer.byteLength(answerBody),
      'the weight shrinks',
    );

    const answer = await sent.answer;

    assert.equal(answer?.status, 202);
    assert.equal(answer?.body, answerBody);
    await until(() => plain.budget.used === 0, 'the weight is given back');
  });

  it('is held by a handler whose sender left before it began, which takes it again and stores the webhook', async () => {
    const sessionId = await newSession();
    const body = Buffer.from('{"stored":"after the sender left"}');
    const bytes = webhook(sessionId, body, { extra: [['X-Hold-Handler', '1']] });
    // The five lines `webhook` writes with the one extra.
    const weight = captureWeight('POST', [
      ...['Host', 'Connection', 'X-Hold-Handler', 'Content-Type'].flatMap((name) => [name, '-']),
      'Content-Length',
      String(body.length),
    ]);

    handlerGate = new Promise((resolve) => {
      openHandlerGate = resolve;
    });

    // What is held, read inside the handler: once the webhook's transaction
    // has committed, on the handler's turn, before its weight shrinks
    // (`onCaptureCommitted`), so no read can fall between two samples.
    const heldWhenAnnounced: number[] = [];

    onCaptureCommitted = () => {
      heldWhenAnnounced.push(plain.budget.used);
    };

    try {
      const sent = call(plain.port, bytes);

      await until(() => plain.budget.used === weight, 'the webhook is admitted');
      // Its body read whole, its handler held at the gate: the sender leaves.
      sent.socket.destroy();
      await until(() => plain.budget.used === 0, 'the connection’s hold is given back');

      // The handler, let through, takes the weight again while it stores.
      openHandlerGate();
      await until(
        async () => (await storedBodies(sessionId)).length === 1,
        'the webhook is stored',
      );
      await until(() => plain.budget.used === 0, 'the handler’s hold is given back');
    } finally {
      onCaptureCommitted = null;
    }

    assert.deepEqual(await stored(sessionId), [described(body)]);
    assert.deepEqual(heldWhenAnnounced, [weight], 'the handler did not hold the weight');
    noWeightLeft(plain);
  });
});

describe('the budget of an address (D210)', () => {
  it('holds an address to its 16 MiB, an IPv6 address by its /64, while another address goes in', async () => {
    const sessionId = await newSession();
    const { budget } = proxied;
    const full = budget.take('203.0.113.7', budget.settings.perAddressBytes);
    const fullNetwork = budget.take('2001:db8:1:2::/64', budget.settings.perAddressBytes);

    try {
      const waiting = call(proxied.port, webhook(sessionId, Buffer.from('a')), '203.0.113.7');
      const waitingNetwork = call(
        proxied.port,
        webhook(sessionId, Buffer.from('b')),
        '2001:db8:1:2::99',
      );

      await until(() => budget.waiting === 2, 'both wait');

      const other = await call(proxied.port, webhook(sessionId, Buffer.from('c')), '203.0.113.8')
        .answer;
      const otherNetwork = await call(
        proxied.port,
        webhook(sessionId, Buffer.from('d')),
        '2001:db8:1:3::1',
      ).answer;

      assert.equal(other?.status, 200);
      assert.equal(otherNetwork?.status, 200);
      assert.equal(budget.waiting, 2);

      full.release();
      fullNetwork.release();
      assert.equal((await waiting.answer)?.status, 200);
      assert.equal((await waitingNetwork.answer)?.status, 200);
      assert.deepEqual((await storedBodies(sessionId)).map((body) => body.toString()).sort(), [
        'a',
        'b',
        'c',
        'd',
      ]);
    } finally {
      full.release();
      fullNetwork.release();
    }

    await until(() => budget.used === 0, 'the weight is given back');
    noWeightLeft(proxied);
  });

  it('holds the real address of a session that keeps none to its 16 MiB, while another address goes in (D243)', async () => {
    const created = await api.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'application/json' },
      payload: '{"storeSourceIp":false}',
    });

    assert.equal(created.statusCode, 201, created.body);

    const sessionId = created.json<{ id: string }>().id;

    createdSessionIds.push(sessionId);

    const { budget } = proxied;
    // The address the PROXY header carries, not the `null` the row will hold:
    // the budget keys by it before the session is read (D210).
    const full = budget.take('203.0.113.9', budget.settings.perAddressBytes);

    try {
      const waiting = call(proxied.port, webhook(sessionId, Buffer.from('a')), '203.0.113.9');

      await until(() => budget.waiting === 1, 'it waits for its address');
      assert.ok(budget.usedBy('203.0.113.9') >= budget.settings.perAddressBytes);

      const other = await call(proxied.port, webhook(sessionId, Buffer.from('b')), '203.0.113.10')
        .answer;

      assert.equal(other?.status, 200);
      assert.equal(budget.waiting, 1);

      full.release();
      assert.equal((await waiting.answer)?.status, 200);
    } finally {
      full.release();
    }

    const stored = await pool.query<{ body: Buffer; source_ip: string | null }>(
      'SELECT body, source_ip FROM requests WHERE session_id = $1 ORDER BY body',
      [sessionId],
    );

    assert.deepEqual(
      stored.rows.map((row) => [row.body.toString(), row.source_ip]),
      [
        ['a', null],
        ['b', null],
      ],
    );
    await until(() => budget.used === 0, 'the weight is given back');
    noWeightLeft(proxied);
  });

  it('holds an address to its 16 MiB with small GETs whose delayed answers are at their bound, each holding no more than it was admitted for', async () => {
    // The largest answer a session can be configured with (D101), held by a
    // delay: stored, each GET keeps it, its 16 KiB and its two header lines.
    const answerBody = 'a'.repeat(MAX_RESPONSE_BODY_BYTES);
    const sessionId = await newSession({ status: 200, body: answerBody, delayMs: 2_000 });
    const { budget } = proxied;
    const sender = '203.0.113.61';
    const lines = ['Host', '-', 'Connection', '-'];
    const head = Buffer.from(
      `GET /s/${sessionId} HTTP/1.1\r\nHost: hook.qa-tools.ru\r\nConnection: close\r\n\r\n`,
      'latin1',
    );
    // What one such GET holds while its answer waits: about 80 KiB, so 203
    // fit an address's 16 MiB. Weighed at its headers alone, 992 would go in
    // and then hold 78 MiB.
    const heldEach = storedWeight('GET', lines, Buffer.byteLength(answerBody));
    const fit = Math.floor(budget.settings.perAddressBytes / heldEach);
    const count = fit + 40;
    // What is held from the address, read inside the handler as each GET is
    // stored, once its transaction has committed (`onCaptureCommitted`).
    const samples: { held: number; waiting: number }[] = [];

    onCaptureCommitted = () => {
      samples.push({ held: budget.usedBy(sender), waiting: budget.waiting });
    };

    const calls: Call[] = [];

    try {
      // Opened 25 at a time, each batch accepted before the next: hundreds
      // at once overflow a test machine's listen queue (macOS keeps 128),
      // and the resets that follow are not what this test is about.
      while (calls.length < count) {
        const accepted = proxied.sockets.length;
        const batch = Math.min(25, count - calls.length);

        for (let index = 0; index < batch; index += 1) {
          calls.push(call(proxied.port, head, sender));
        }

        await until(() => proxied.sockets.length >= accepted + batch, 'the batch is accepted');
      }

      // Each answer as its status and its body's length, counted.
      const answered: Record<string, number> = {};

      for (const answer of await Promise.all(calls.map((each) => each.answer))) {
        const key = `${answer?.status} ${answer?.body.length}`;

        answered[key] = (answered[key] ?? 0) + 1;
      }

      assert.deepEqual(answered, { [`200 ${MAX_RESPONSE_BODY_BYTES}`]: count });
    } finally {
      onCaptureCommitted = null;

      for (const each of calls) {
        each.socket.destroy();
      }
    }

    const most = Math.max(...samples.map((sample) => sample.held));
    const report = `${fit} fit, ${heldEach} bytes each; at most ${most} held, ${Math.max(...samples.map((sample) => sample.waiting))} waiting`;

    assert.equal(samples.length, count, report);
    assert.ok(
      samples.every((sample) => sample.held <= budget.settings.perAddressBytes),
      `the address held more than its 16 MiB: ${report}`,
    );
    // The address was full, and the rest waited for room.
    assert.ok(
      samples.some((sample) => sample.waiting > 0),
      `none waited: ${report}`,
    );
    assert.equal(most, fit * heldEach, report);
    assert.equal(
      (await pool.query('SELECT 1 FROM requests WHERE session_id = $1', [sessionId])).rowCount,
      count,
    );
    await until(() => budget.used === 0, 'the weight is given back');
    noWeightLeft(proxied);
  });
});
