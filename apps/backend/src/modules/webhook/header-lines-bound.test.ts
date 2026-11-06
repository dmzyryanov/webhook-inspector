/**
 * The bound on the header lines in flight on the receive listener (#182,
 * D238), over real sockets, each connection naming its sender in a PROXY v2
 * header as Traefik's does.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 *
 * The receiver itself, PROXY protocol on and a small budget: a connection of
 * an address whose lines are all in flight is not parsed - not a byte - nor
 * answered, closed or reset, while another address's webhook is captured;
 * once a holder ends its head, or closes, it is captured whole, every header
 * line in order. A webhook with the most header lines Node allows, on an
 * empty address budget, is captured whole however small the numbers.
 *
 * And a plain Node server put together as the receiver puts it - the bound,
 * then the PROXY layer in front - with timeouts short enough to wait for and
 * every byte Node's parser is given counted on its `execute`: the lines are
 * given back however a connection leaves - before or during its PROXY
 * header, mid-head, held unread, after its head, during its body; by its
 * client's close, a reset, Node's `headersTimeout` or `requestTimeout` - and
 * every count returns to zero. Pipelined requests count each head afresh,
 * once; a body's newlines never count and a chunked body's trailer lines
 * do; a connection admitted for some lines and sending more is held at the
 * line that does not fit; the process's number holds the first connection
 * of an address holding none; and random pipelines of well-formed requests,
 * cut into random writes on connections contending for a few lines, are all
 * answered, Node's count of each head's and trailer section's lines the
 * bound's, with no line logged at `error`. The HTTP/2 preface and the `PRI`
 * heads Node's parser holds without making a request of them - what follows
 * one given to Node's parser at once even while its address's lines are all
 * in flight - the requests behind one asking to upgrade, and 310 connections
 * of a prefix and random bytes cut into random writes, seeded, are answered
 * or closed as before, every line given back, with no line at `error` or
 * `warn` (#277).
 */
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildReceiver, buildServer } from '../../server.ts';
import { writeByteByByte } from '../../testing/http2.ts';
import { modelPipeline, nastyBytes, random } from '../../testing/pipelines.ts';
import {
  createHeaderLineBudget,
  type HeaderLineBudget,
  type HeaderLineBudgetOptions,
  type LineAccount,
} from './header-lines.ts';
import { HTTP2_PREFACE } from './http2-preface.ts';
import { boundPipelinedRequests } from './pipelining.ts';
import {
  acceptProxyProtocol,
  PROXY_V2_SIGNATURE,
  type ProxyProtocolLayer,
} from './proxy-protocol.ts';

const LOOPBACK = '127.0.0.1';

/** Node's own answer to a request its parser refuses, on a server with no `clientError` listener. */
const NODE_BAD_REQUEST = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n';

let pool: pg.Pool;
let api: FastifyInstance;
const createdSessionIds: string[] = [];
const clients: net.Socket[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    api = buildServer(pool);
    api.log.level = 'silent';
    await api.ready();
  })();
  await startup;
});

after(async () => {
  await startup?.catch(() => undefined);

  for (const socket of clients) {
    socket.destroy();
  }

  await api?.close();

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await pool?.end();
});

async function newSession(): Promise<string> {
  const created = await api.inject({ method: 'POST', url: '/api/sessions' });

  assert.equal(created.statusCode, 201, created.body);

  const { id } = created.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

/** A PROXY protocol v2 header for TCP over IPv4 naming `source`, as Traefik writes one. */
function proxyHeader(source: string): Buffer {
  const addresses = Buffer.concat([
    Buffer.from(source.split('.').map(Number)),
    Buffer.from([10, 42, 0, 24]),
    Buffer.from([0xc3, 0x50, 0x20, 0xfb]),
  ]);

  return Buffer.concat([
    PROXY_V2_SIGNATURE,
    Buffer.from([0x21, 0x11, 0, addresses.length]),
    addresses,
  ]);
}

/** Waits, for at most `withinMs`, until `condition` holds. */
async function until(condition: () => boolean, what: string, withinMs = 20_000): Promise<void> {
  const deadline = Date.now() + withinMs;

  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
    await delay(5);
  }
}

interface Client {
  socket: net.Socket;
  /** What the client has received, as text. */
  received(): string;
  /** Answers it has read, by their status lines. */
  statuses(): number[];
  closed: Promise<void>;
  isClosed(): boolean;
  write(bytes: Buffer | string): void;
}

/**
 * A connection to `port` that sends a PROXY header naming `source` - none
 * when `source` is `null` - and then `first`.
 */
function connect(port: number, source: string | null, first: Buffer | string = ''): Client {
  const socket = net.connect(port, LOOPBACK);
  let received = '';
  let isClosed = false;

  clients.push(socket);
  socket.setNoDelay(true);
  socket.on('error', () => undefined);
  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString('latin1');
  });

  const closed = new Promise<void>((resolve) =>
    socket.on('close', () => {
      isClosed = true;
      resolve();
    }),
  );

  // Written at once, before the connection is up - Node sends what is
  // written in order once it is - so that a later write cannot overtake it.
  socket.write(
    Buffer.concat([
      source === null ? Buffer.alloc(0) : proxyHeader(source),
      typeof first === 'string' ? Buffer.from(first, 'latin1') : first,
    ]),
  );

  return {
    socket,
    received: () => received,
    statuses: () => [...received.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((match) => Number(match[1])),
    closed,
    isClosed: () => isClosed,
    write: (bytes) => {
      if (!socket.destroyed) {
        socket.write(typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : bytes);
      }
    },
  };
}

/** `count` header lines `x-<i>: <i>`, and their pairs. */
function headerLines(count: number, prefix = 'x'): { text: string; pairs: [string, string][] } {
  const pairs = Array.from({ length: count }, (_, index): [string, string] => [
    `${prefix}-${index}`,
    String(index),
  ]);

  return { text: pairs.map(([name, value]) => `${name}: ${value}\r\n`).join(''), pairs };
}

/** What a session stored: each request's headers, oldest first. */
async function storedHeaders(sessionId: string): Promise<[string, string][][]> {
  const rows = await pool.query<{ headers: [string, string][] }>(
    'SELECT headers FROM requests WHERE session_id = $1 ORDER BY received_at, id',
    [sessionId],
  );

  return rows.rows.map((row) => row.headers);
}

/** Every count of `budget` at zero: no line in flight, no address kept, nobody waiting. */
async function allGivenBack(budget: HeaderLineBudget, what: string): Promise<void> {
  await until(
    () => budget.lines === 0 && budget.addresses === 0 && budget.waiting === 0,
    `${what}: every line given back (${budget.lines} lines, ${budget.addresses} addresses, ${budget.waiting} waiting)`,
  );
}

/** A logger that keeps what is logged at `error`, and apart from it at `warn`. */
function spyLog(): { log: FastifyBaseLogger; errors: unknown[]; warnings: unknown[] } {
  const errors: unknown[] = [];
  const warnings: unknown[] = [];
  const log = {
    error: (...args: unknown[]) => errors.push(args),
    warn: (...args: unknown[]) => warnings.push(args),
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
  } as unknown as FastifyBaseLogger;

  return { log, errors, warnings };
}

/**
 * A budget that also records, for every connection of each address, the
 * lines of every section it ended - a head's, or a body's end: a chunked
 * body's trailers, none for one of declared length - in the order it ended
 * them, how many accounts it opened, and the most lines it had in flight.
 */
function recording(options: HeaderLineBudgetOptions): {
  budget: HeaderLineBudget;
  sections: Map<string, number[][]>;
  opened: () => number;
  peak: () => number;
} {
  const inner = createHeaderLineBudget(options);
  const sections = new Map<string, number[][]>();
  let opened = 0;
  let peak = 0;

  const budget: HeaderLineBudget = {
    get perAddress() {
      return inner.perAddress;
    },
    get perProcess() {
      return inner.perProcess;
    },
    get lines() {
      return inner.lines;
    },
    linesOf: (key) => inner.linesOf(key),
    get addresses() {
      return inner.addresses;
    },
    get waiting() {
      return inner.waiting;
    },
    open(key, wake) {
      const account = inner.open(key, wake);
      const ended: number[] = [];
      let section = 0;

      opened += 1;
      sections.set(key, [...(sections.get(key) ?? []), ended]);

      const recorded: LineAccount = {
        get lines() {
          return account.lines;
        },
        allowance: () => account.allowance(),
        take(count) {
          section += Math.max(0, count);
          account.take(count);
          peak = Math.max(peak, inner.lines);
        },
        giveBack() {
          ended.push(section);
          section = 0;
          account.giveBack();
          assert.ok(inner.lines >= 0, 'never below zero');
        },
        wait: (want) => account.wait(want),
        close: () => {
          account.close();
          assert.ok(inner.lines >= 0, 'never below zero');
        },
      };

      return recorded;
    },
  };

  return { budget, sections, opened: () => opened, peak: () => peak };
}

interface LineServer {
  port: number;
  budget: HeaderLineBudget;
  errors: unknown[];
  warnings: unknown[];
  layer: ProxyProtocolLayer;
  /** The bytes Node's parser has been given on each connection, by its client's port. */
  parsed(client: Client): number;
  /** The requests Node's parser has read, by URL, with their header and trailer lines. */
  requests: { url: string; lines: number; trailers: number; body: number }[];
  close(): Promise<void>;
}

/**
 * A plain Node server bounded as the receive listener is: the line budget
 * and the pipelining bound, then the PROXY layer in front, trusting
 * everyone and counting no connections. Each request's body is read and
 * answered with what Node made of it, unless `handle` answers it.
 */
async function lineServer(
  budget: HeaderLineBudget,
  {
    headersTimeout = 60_000,
    requestTimeout = 90_000,
    keepAliveTimeout = 5_000,
    upgrade = false,
    handle,
  }: {
    headersTimeout?: number;
    keepAliveTimeout?: number;
    /** Hands an upgrade on to a listener of its own, which answers `101` and closes. */
    upgrade?: boolean;
    requestTimeout?: number;
    handle?: (request: IncomingMessage, response: ServerResponse) => boolean;
  } = {},
): Promise<LineServer> {
  const { log, errors, warnings } = spyLog();
  const requests: LineServer['requests'] = [];
  const server = http.createServer(
    { connectionsCheckingInterval: 50, headersTimeout, requestTimeout, keepAliveTimeout },
    (request, response) => {
      if (handle?.(request, response) === true) {
        return;
      }

      let body = 0;

      request.on('data', (chunk: Buffer) => {
        body += chunk.length;
      });
      request.on('end', () => {
        const seen = {
          url: request.url ?? '',
          lines: request.rawHeaders.length / 2,
          trailers: request.rawTrailers.length / 2,
          body,
        };

        requests.push(seen);
        response.end(JSON.stringify(seen));
      });
    },
  );
  const parsedBy = new Map<number, number>();
  // The PROXY layer, put in front last, as `buildReceiver` puts it.
  const late: { layer?: ProxyProtocolLayer } = {};

  server.maxHeadersCount = 0;
  boundPipelinedRequests(server, {
    headerLines: budget,
    addressOf: (socket) => late.layer?.sourceOf(socket),
    log,
  });

  // Every byte Node's parser is given, counted on its `execute`.
  server.on('connection', (socket: net.Socket) => {
    const parser = (socket as unknown as { parser: { execute: (chunk: Buffer) => unknown } })
      .parser;
    const execute = parser.execute;
    const port = socket.remotePort ?? 0;

    parser.execute = function counted(chunk: Buffer): unknown {
      parsedBy.set(port, (parsedBy.get(port) ?? 0) + chunk.length);

      return Reflect.apply(execute, this, [chunk]);
    };
    socket.once('close', () => Reflect.deleteProperty(parser, 'execute'));
  });

  if (upgrade) {
    server.on('upgrade', (_request: IncomingMessage, socket: net.Socket) => {
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n',
        () => socket.destroy(),
      );
    });
  }

  const layer = acceptProxyProtocol(server, {
    isTrustedPeer: () => true,
    connectionsPerAddress: 0,
    log,
  });

  late.layer = layer;
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));

  return {
    port: (server.address() as AddressInfo).port,
    budget,
    errors,
    warnings,
    layer,
    parsed: (client) => parsedBy.get(client.socket.localPort ?? -1) ?? 0,
    requests,
    async close() {
      server.closeAllConnections();
      layer.closePending();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A head of `lines` lines in all, the request line and `Host` among them, not ended. */
function stalledHead(lines: number, path = '/stall'): string {
  return `POST ${path} HTTP/1.1\r\nHost: h\r\n${'a:\r\n'.repeat(lines - 2)}`;
}

describe('the receiver holds a connection whose address has its header lines in flight, and captures it whole once lines are given back (D238)', () => {
  let receiver: FastifyInstance;
  let budget: HeaderLineBudget;

  before(async () => {
    await startup;
    budget = createHeaderLineBudget({ perAddress: 1_000, perProcess: 100_000 });
    receiver = buildReceiver(pool, {
      trustedProxyCidrs: [`${LOOPBACK}/32`],
      proxyProtocol: 'v2',
      headerLines: budget,
    });
    receiver.log.level = 'silent';
    await receiver.listen({ host: LOOPBACK, port: 0 });
  });

  after(async () => {
    await receiver?.close();
  });

  const port = (): number => (receiver.server.address() as AddressInfo).port;

  for (const release of ['ends its head', 'closes'] as const) {
    it(`holds the next connection of an address whose lines are all in flight - unanswered, open, nothing stored - while another address is captured, and captures it whole, every line in order, once the holder ${release}`, async () => {
      const sessionId = await newSession();
      const sender = release === 'closes' ? '198.51.100.11' : '198.51.100.12';
      // 1,000 lines in all: the address's number.
      const holder = connect(
        port(),
        sender,
        `POST /s/${sessionId}?holder HTTP/1.1\r\nHost: h\r\nContent-Length: 2\r\n${headerLines(997, 'h').text}`,
      );

      await until(() => budget.linesOf(sender) === 1_000, 'the holder has the address’s lines');

      const held = headerLines(150, 'held');
      const body = '{"held":"\\n\\r\\n"}';
      const waiting = connect(
        port(),
        sender,
        `POST /s/${sessionId}?held HTTP/1.1\r\nHost: h\r\n${held.text}Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      );

      await until(() => budget.waiting === 1, 'the next waits');

      // Another address meanwhile: its own number, captured at once.
      const otherSession = await newSession();
      const other = connect(
        port(),
        '198.51.100.99',
        `POST /s/${otherSession} HTTP/1.1\r\nHost: h\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{}`,
      );

      await other.closed;
      assert.deepEqual(other.statuses(), [200]);
      assert.equal((await storedHeaders(otherSession)).length, 1);

      // A second on: still waiting, nothing written, nothing closed, nothing stored.
      await delay(1_000);
      assert.equal(budget.waiting, 1);
      assert.equal(budget.linesOf(sender), 1_000);
      assert.equal(waiting.received(), '');
      assert.equal(waiting.isClosed(), false);
      assert.equal((await storedHeaders(sessionId)).length, 0);

      if (release === 'closes') {
        holder.socket.destroy();
      } else {
        holder.write('\r\n{}');
      }

      await until(() => waiting.statuses().length === 1, 'the held webhook is answered');
      assert.deepEqual(waiting.statuses(), [200]);

      const stored = await storedHeaders(sessionId);
      const heldRow = stored.find((headers) => headers.some(([name]) => name === 'held-0'));

      assert.ok(heldRow !== undefined, 'the held webhook is stored');
      assert.deepEqual(heldRow, [
        ['Host', 'h'],
        ...held.pairs,
        ['Content-Type', 'application/json'],
        ['Content-Length', String(body.length)],
      ]);
      assert.equal(stored.length, release === 'closes' ? 1 : 2);

      holder.socket.destroy();
      waiting.socket.destroy();
      await allGivenBack(budget, 'after both');
    });
  }

  for (const numbers of [{}, { perAddress: 1, perProcess: 1 }]) {
    it(`captures a webhook with the most header lines Node allows, 16,320, whole and in order, on an empty address budget of ${numbers.perAddress ?? 'the default'} lines`, async () => {
      const small = createHeaderLineBudget(numbers);
      const own = buildReceiver(pool, {
        trustedProxyCidrs: [`${LOOPBACK}/32`],
        proxyProtocol: 'v2',
        headerLines: small,
      });

      own.log.level = 'silent';
      await own.listen({ host: LOOPBACK, port: 0 });

      try {
        const sessionId = await newSession();
        const names = 'abcdefghijklmnopqrstuvwxyz0123456789';
        // A GET: Host and 16,319 lines of a one-letter name and no value,
        // within Node's 16 KiB of names, values and target, the target
        // being `/s/` and a 43-character id (D161).
        const pairs = Array.from({ length: 16_319 }, (_, index): [string, string] => [
          names[index % names.length] as string,
          '',
        ]);
        const sent = connect(
          (own.server.address() as AddressInfo).port,
          '203.0.113.5',
          `GET /s/${sessionId} HTTP/1.1\r\nHost: h\r\n${pairs.map(([name]) => `${name}:\r\n`).join('')}\r\n`,
        );

        await until(() => sent.statuses().length === 1, 'answered');
        assert.deepEqual(sent.statuses(), [200], sent.received().slice(0, 400));

        const [headers] = await storedHeaders(sessionId);

        assert.equal(headers?.length, 16_320);
        assert.deepEqual(headers?.[0], ['Host', 'h']);
        assert.deepEqual(headers?.slice(1), pairs);

        sent.socket.destroy();
        await allGivenBack(small, 'after the webhook');
      } finally {
        await own.close();
      }
    });
  }
});

describe('the lines in flight are given back however a connection leaves, and every count returns to zero (D238)', () => {
  it('opens no account for a connection that leaves before or during its PROXY header, and counts the lines that come with the header under its address', async () => {
    const { budget, opened } = recording({ perAddress: 100, perProcess: 1_000 });
    const server = await lineServer(budget);

    try {
      const header = proxyHeader('192.0.2.7');

      // Gone at once, after part of the header, reset during it.
      const gone = connect(server.port, null);

      await new Promise<void>((resolve) => gone.socket.once('connect', () => resolve()));
      gone.socket.destroy();

      const partial = connect(server.port, null, header.subarray(0, 10));

      await delay(50);
      partial.socket.destroy();

      const reset = connect(server.port, null, header.subarray(0, 15));

      await delay(50);
      reset.socket.resetAndDestroy();
      await Promise.all([gone.closed, partial.closed, reset.closed]);
      await delay(100);
      assert.equal(opened(), 0);
      await allGivenBack(budget, 'before any header');

      // The header and lines in one write: every line counted, under its address.
      const together = connect(server.port, '192.0.2.7', stalledHead(40));

      await until(() => budget.linesOf('192.0.2.7') === 40, 'the 40 lines counted');
      assert.equal(budget.lines, 40);
      assert.equal(server.parsed(together), stalledHead(40).length);
      together.socket.destroy();
      await allGivenBack(budget, 'after it closed');
      assert.deepEqual(server.errors, []);
    } finally {
      await server.close();
    }
  });

  it('gives the lines back when a stalled holder’s client closes, resets, or Node’s headersTimeout ends it', async () => {
    const budget = createHeaderLineBudget({ perAddress: 100, perProcess: 1_000 });
    const server = await lineServer(budget, { headersTimeout: 400, requestTimeout: 800 });

    try {
      for (const way of ['close', 'reset', 'headersTimeout'] as const) {
        const holder = connect(server.port, '192.0.2.8', stalledHead(60));

        await until(() => budget.linesOf('192.0.2.8') === 60, `${way}: the holder’s lines`);

        if (way === 'close') {
          holder.socket.end();
        } else if (way === 'reset') {
          holder.socket.resetAndDestroy();
        }

        await holder.closed;
        await allGivenBack(budget, way);

        if (way === 'headersTimeout') {
          assert.match(holder.received(), /^HTTP\/1\.1 408 /, 'Node’s own answer');
        }
      }

      assert.deepEqual(server.errors, []);
    } finally {
      await server.close();
    }
  });

  it('leaves a held connection to Node’s headersTimeout, its 408 and close as before, and its wait ends', async () => {
    const budget = createHeaderLineBudget({ perAddress: 100, perProcess: 1_000 });
    // The holder stalls in a chunked body's trailer section, past its head,
    // so `headersTimeout` does not end it and its `requestTimeout` is far
    // off: its lines stay in flight until its client closes it, and nothing
    // but the held connection's own timeout can end its wait (#182; a holder
    // ended by the same timeout would free its lines first).
    const server = await lineServer(budget, { headersTimeout: 1_000, requestTimeout: 60_000 });

    try {
      const holder = connect(
        server.port,
        '192.0.2.9',
        `POST /trailers HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n${'a:\r\n'.repeat(100)}`,
      );

      await until(() => budget.linesOf('192.0.2.9') === 100, 'the holder’s trailer lines');

      const held = connect(server.port, '192.0.2.9', 'GET /held HTTP/1.1\r\nHost: h\r\n\r\n');

      await until(() => budget.waiting === 1, 'held');
      await held.closed;
      assert.equal(server.parsed(held), 0, 'not a byte of it parsed');
      assert.deepEqual(held.statuses(), [408], 'Node’s own answer, and only it');
      await until(() => budget.waiting === 0, 'its wait ended');
      assert.equal(holder.isClosed(), false, 'the holder still open');
      assert.equal(budget.linesOf('192.0.2.9'), 100, 'the holder’s lines still in flight');
      holder.socket.end();
      await holder.closed;
      await allGivenBack(budget, 'after the holder');
      assert.deepEqual(server.errors, []);
    } finally {
      await server.close();
    }
  });

  it('gives back the lines of a connection that leaves mid-head, after its head, during its body, or held unread, by close or reset, and of one Node’s requestTimeout ends', async () => {
    const budget = createHeaderLineBudget({ perAddress: 50, perProcess: 1_000 });
    const server = await lineServer(budget, { headersTimeout: 1_000, requestTimeout: 1_200 });
    const address = '192.0.2.10';

    try {
      for (const way of ['close', 'reset'] as const) {
        const leave = (client: Client): void => {
          if (way === 'close') {
            client.socket.end();
          } else {
            client.socket.resetAndDestroy();
          }
        };

        // Mid-head.
        const midHead = connect(server.port, address, stalledHead(20));

        await until(() => budget.linesOf(address) === 20, `${way}: mid-head`);
        leave(midHead);
        await midHead.closed;
        await allGivenBack(budget, `${way}: mid-head`);

        // After its head, its body declared and not sent; and during it.
        for (const sent of ['', '{"a":']) {
          const inBody = connect(
            server.port,
            address,
            `POST /b HTTP/1.1\r\nHost: h\r\nContent-Length: 100\r\n\r\n${sent}`,
          );

          await until(() => server.parsed(inBody) > 0, `${way}: its head parsed`);
          await delay(50);
          assert.equal(budget.lines, 0, 'a head ended holds no line');
          leave(inBody);
          await inBody.closed;
          await allGivenBack(budget, `${way}: in its body`);
        }

        // Held unread: its client leaves while it waits. The server sees
        // it go once it reads it again, when the holder lets go.
        const holder = connect(server.port, address, stalledHead(50));

        await until(() => budget.linesOf(address) === 50, `${way}: the holder`);

        const held = connect(server.port, address, stalledHead(10, '/held'));

        await until(() => budget.waiting === 1, `${way}: held`);
        leave(held);
        await held.closed;
        await delay(100);
        assert.equal(server.parsed(held), 0);
        holder.socket.destroy();
        await holder.closed;
        await allGivenBack(budget, `${way}: held unread`);
      }

      // Node's requestTimeout: a body that never comes.
      const slow = connect(
        server.port,
        address,
        'POST /slow HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nab',
      );

      await slow.closed;
      assert.match(slow.received(), /^HTTP\/1\.1 408 /);
      await allGivenBack(budget, 'requestTimeout');
      assert.deepEqual(server.errors, []);
    } finally {
      await server.close();
    }
  });
});

describe('what Node does itself is left to it, and the lines given back (D238)', () => {
  it('leaves a kept-alive connection held before its next request’s first line to Node’s keep-alive timeout, which closes it, and its wait ends', async () => {
    const budget = createHeaderLineBudget({ perAddress: 50, perProcess: 1_000 });
    const server = await lineServer(budget, { keepAliveTimeout: 300 });
    const address = '192.0.2.40';

    try {
      const kept = connect(server.port, address, 'GET /first HTTP/1.1\r\nHost: h\r\n\r\n');

      await until(() => kept.statuses().length === 1, 'its first answered');

      const holder = connect(server.port, address, stalledHead(50));

      await until(() => budget.linesOf(address) === 50, 'the holder’s lines');
      kept.write('GET /second HTTP/1.1\r\nHost: h\r\n\r\n');
      await until(() => budget.waiting === 1, 'its next request held');
      await kept.closed;
      assert.deepEqual(kept.statuses(), [200], 'nothing more written to it');
      await until(() => budget.waiting === 0, 'its wait ended');
      holder.socket.destroy();
      await allGivenBack(budget, 'after the holder');
    } finally {
      await server.close();
    }
  });

  it('leaves to Node the heads and bodies it refuses - a bare LF, a line begun with CR, one line over its 16 KiB, a chunk size that is not one - and gives their lines back', async () => {
    const budget = createHeaderLineBudget({ perAddress: 100_000, perProcess: 1_000_000 });
    const server = await lineServer(budget);

    try {
      for (const [bytes, status] of [
        ['GET / HTTP/1.1\r\nHost: h\na: 1\r\n\r\n', 400],
        ['GET / HTTP/1.1\r\nHost: h\r\n\rX: 1\r\n\r\n', 400],
        [`GET / HTTP/1.1\r\nHost: h\r\n${'a:\r\n'.repeat(16_400)}\r\n`, 431],
        ['POST / HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n', 400],
        ['POST / HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n0\r\na: 1\n\r\n', 400],
      ] as const) {
        const client = connect(server.port, '192.0.2.41', bytes);

        await client.closed;
        assert.deepEqual(client.statuses(), [status], JSON.stringify(bytes.slice(0, 60)));
        await allGivenBack(budget, JSON.stringify(bytes.slice(0, 60)));
      }

      assert.deepEqual(server.errors, []);
    } finally {
      await server.close();
    }
  });

  it('leaves to Node the HTTP/2 preface and the PRI heads it holds without a request: its own 400 and close as before, every line given back, nothing logged at error or warn (#277)', async () => {
    const budget = createHeaderLineBudget({ perAddress: 100_000, perProcess: 1_000_000 });
    const server = await lineServer(budget);
    const preface = HTTP2_PREFACE.toString('latin1');

    try {
      for (const [what, bytes] of [
        ['the PRI line and X', 'PRI * HTTP/2.0\r\n\r\nX'],
        ['23 bytes of the preface and 64 KiB of X', preface.slice(0, 23) + 'X'.repeat(65_536)],
        ['the whole preface', preface],
        ['the whole preface a byte at a time', null],
        ['a CR LF, the PRI line and X', '\r\nPRI * HTTP/2.0\r\n\r\nX'],
        ['PRI / HTTP/1.1 and X', 'PRI / HTTP/1.1\r\n\r\nX'],
        [
          'a GET and the whole preface in one write',
          `GET /g HTTP/1.1\r\nHost: h\r\n\r\n${preface}`,
        ],
      ] as const) {
        const client = connect(server.port, '192.0.2.45', bytes ?? '');

        if (bytes === null) {
          await writeByteByByte(client.socket, HTTP2_PREFACE);
        }

        await client.closed;
        // As on the base (eec3e7b): Node's own refusal, written as soon as
        // the bytes after the held head come, the rest of the preface or
        // not. The GET's answer, not yet written when the refusal is, goes
        // with the connection, as on a server without the bound.
        assert.equal(client.received(), NODE_BAD_REQUEST, what);
        await allGivenBack(budget, what);
      }

      assert.deepEqual(server.errors, []);
      assert.deepEqual(server.warnings, []);
    } finally {
      await server.close();
    }
  });

  it('gives Node’s parser what follows a PRI head it holds at once, while the address’s lines are all in flight: its own 400 and close as before, never held for room, every line given back, nothing logged at error or warn (#277)', async () => {
    const budget = createHeaderLineBudget({ perAddress: 100, perProcess: 1_000 });
    // A connection held for room is ended by Node's `headersTimeout`, its
    // 408 - as on an earlier version of this fix, where what followed a
    // `PRI` head was still counted. The holder stalls in a
    // chunked body's trailer section, past its head, which that timeout
    // does not end.
    const server = await lineServer(budget, { headersTimeout: 5_000, requestTimeout: 60_000 });
    const address = '192.0.2.47';

    try {
      for (const head of ['PRI * HTTP/2.0\r\n\r\n', 'PRI / HTTP/1.1\r\n\r\n']) {
        for (const [after, byteByByte] of [
          ['X', false],
          ['SM\r\n\r\n', false],
          ['SM\r\n\r\n', true],
        ] as const) {
          const what = `${JSON.stringify(head + after)}${byteByByte ? ' a byte at a time' : ''}`;
          const client = connect(server.port, address, head);

          // The head is Node's parser's, held, and its lines given back,
          // before the address's lines are all taken.
          await until(() => server.parsed(client) === head.length, `${what}: the head parsed`);
          assert.equal(budget.lines, 0, `${what}: the head’s lines given back`);

          const holder = connect(
            server.port,
            address,
            `POST /trailers HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n${'a:\r\n'.repeat(100)}`,
          );

          await until(() => budget.linesOf(address) === 100, `${what}: the holder’s lines`);

          if (byteByByte) {
            await writeByteByByte(client.socket, Buffer.from(after, 'latin1'));
          } else {
            client.write(after);
          }

          await client.closed;
          // As on the base (eec3e7b): Node's own refusal, at once.
          assert.equal(client.received(), NODE_BAD_REQUEST, what);
          assert.equal(budget.waiting, 0, `${what}: nothing waited for room`);
          assert.equal(budget.linesOf(address), 100, `${what}: the holder’s lines still in flight`);
          holder.socket.end();
          await holder.closed;
          await allGivenBack(budget, what);
        }
      }

      assert.deepEqual(server.errors, []);
      assert.deepEqual(server.warnings, []);
    } finally {
      await server.close();
    }
  });

  it('reads the requests behind one asking to upgrade, in its write and a later one, answered as before, every line given back, nothing logged at error or warn (#277)', async () => {
    const budget = createHeaderLineBudget({ perAddress: 100_000, perProcess: 1_000_000 });
    // No `upgrade` listener: Node answers the request like any other.
    const server = await lineServer(budget);

    try {
      const client = connect(
        server.port,
        '192.0.2.46',
        'GET /u HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n' +
          'GET /second HTTP/1.1\r\nHost: h\r\n\r\n',
      );

      // Node's parser drops what one call carries behind a request asking to
      // upgrade; the bound ends that call with the request's head, so the
      // second is read, as on the base (eec3e7b).
      await until(() => client.statuses().length === 2, 'both answered');
      client.write('GET /third HTTP/1.1\r\nHost: h\r\n\r\n');
      await until(() => client.statuses().length === 3, 'the third answered');
      assert.equal(
        client.received().replace(/^Date: .*$/gm, 'Date: -'),
        [
          { url: '/u', lines: 3, trailers: 0, body: 0 },
          { url: '/second', lines: 1, trailers: 0, body: 0 },
          { url: '/third', lines: 1, trailers: 0, body: 0 },
        ]
          .map((seen) => {
            const body = JSON.stringify(seen);

            return `HTTP/1.1 200 OK\r\nDate: -\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
          })
          .join(''),
      );
      assert.equal(client.isClosed(), false, 'kept alive');
      client.socket.destroy();
      await allGivenBack(budget, 'after it');
      assert.deepEqual(server.errors, []);
      assert.deepEqual(server.warnings, []);
    } finally {
      await server.close();
    }
  });

  it('holds a head over Node’s 16 KiB like any other, and leaves its refusal to Node once it is read: 431 and close as before, Node’s lines before it given back, every count at zero', async () => {
    const { budget, peak } = recording({ perAddress: 100, perProcess: 1_000_000 });
    const server = await lineServer(budget);
    const address = '192.0.2.44';

    try {
      const holder = connect(server.port, address, stalledHead(100));

      await until(() => budget.linesOf(address) === 100, 'the holder’s lines');

      // 64,000 lines of `a:`, 256,000 bytes: Node's parser refuses it once
      // it has counted 16 KiB of its URL, names and values, the 16,375th
      // `a`. Held, it is not told from S9's 16,000 lines that stop there.
      const big = connect(server.port, address, stalledHead(64_000, '/big'));

      await until(() => budget.waiting === 1, 'held');
      await delay(300);
      assert.equal(server.parsed(big), 0, 'not a byte of it parsed while held');
      assert.equal(big.received(), '');
      holder.socket.end();
      await big.closed;
      assert.deepEqual(big.statuses(), [431], 'Node’s own refusal, as before #182');
      await holder.closed;
      await allGivenBack(budget, 'after both');
      // Node parsed at most its 16 KiB of one-byte lines before refusing
      // it; the account counted at most one read of 64 KiB past them.
      assert.ok(peak() <= 16_384 + 65_536 / 4, `${peak()} lines in flight at the most`);
      assert.deepEqual(server.requests, [], 'no request read');
      assert.deepEqual(server.errors, []);
    } finally {
      await server.close();
    }
  });

  it('gives back the lines of a connection Node hands on, a CONNECT it closes or an upgrade it passes to its listener', async () => {
    const budget = createHeaderLineBudget({ perAddress: 100, perProcess: 1_000 });
    const server = await lineServer(budget, { upgrade: true });

    try {
      const tunnel = connect(
        server.port,
        '192.0.2.42',
        'CONNECT a:1 HTTP/1.1\r\nHost: a:1\r\n\r\nmore',
      );

      await tunnel.closed;
      await allGivenBack(budget, 'after the CONNECT');

      const upgraded = connect(
        server.port,
        '192.0.2.42',
        `GET /u HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n${'a:\r\n'.repeat(50)}`,
      );

      await upgraded.closed;
      assert.deepEqual(upgraded.statuses(), [101]);
      await allGivenBack(budget, 'after the upgrade');
      assert.deepEqual(server.errors, []);
    } finally {
      await server.close();
    }
  });
});

describe('what counts, and how much at a time (D238)', () => {
  it('counts each pipelined request’s head afresh, once, gives its lines back when it ends, and a chunked body’s trailer lines, as Node read them', async () => {
    const { budget, sections } = recording({ perAddress: 1_000, perProcess: 10_000 });
    const server = await lineServer(budget);
    const address = '192.0.2.20';

    try {
      const chunked = `POST /c HTTP/1.1\r\nHost: h\r\n${headerLines(300).text}Transfer-Encoding: chunked\r\n\r\n4\r\n\n\r\n\n\r\n0\r\n${headerLines(250, 't').text}\r\n`;
      const declared = `POST /d HTTP/1.1\r\nHost: h\r\n${headerLines(400).text}Content-Length: 12\r\n\r\na:\r\nb:\r\n\r\n\r\n`;
      const plain = `GET /g HTTP/1.1\r\nHost: h\r\n${headerLines(399).text}\r\n`;
      const pipeline = [chunked, declared, plain, chunked, declared, plain].join('');
      const client = connect(server.port, address, pipeline);

      await until(() => client.statuses().length === 6, 'all six answered');
      assert.deepEqual(client.statuses(), [200, 200, 200, 200, 200, 200]);

      // Node's count of each head (its request line and header lines) and
      // of each body's end (a chunked body's trailers; none for a declared
      // length), against the bound's.
      const expected = server.requests.flatMap((request) =>
        request.url === '/g' ? [1 + request.lines] : [1 + request.lines, request.trailers],
      );

      assert.deepEqual(sections.get(address), [expected]);
      assert.deepEqual(expected, [303, 250, 403, 0, 401, 303, 250, 403, 0, 401]);
      assert.equal(budget.lines, 0, 'nothing left over between and after the heads');
      client.socket.destroy();
      await allGivenBack(budget, 'after the pipeline');
      assert.deepEqual(server.errors, []);
    } finally {
      await server.close();
    }
  });

  it('never counts a body’s newlines: a webhook with 200 KiB of them goes on, its head of 40 lines the address’s last room, its head split across writes', async () => {
    const budget = createHeaderLineBudget({ perAddress: 42, perProcess: 1_000 });
    const server = await lineServer(budget);
    const address = '192.0.2.21';

    try {
      const holder = connect(server.port, address, stalledHead(2));

      await until(() => budget.linesOf(address) === 2, 'the holder’s lines');

      // A head of 40 lines - the address's room exactly - and a body of
      // lines, line ends and head ends.
      const body = 'a:\r\n\n\r\n\r\n'.repeat(Math.ceil((200 * 1024) / 9));
      const head = `POST /body HTTP/1.1\r\nHost: h\r\n${headerLines(37).text}Content-Length: ${body.length}\r\n\r\n`;
      const sender = connect(server.port, address, head.slice(0, 50));

      for (const [from, to] of [
        [50, 51],
        [51, 300],
        [300, head.length],
      ] as const) {
        await delay(20);
        sender.write(head.slice(from, to));
      }

      sender.write(body);
      await until(() => sender.statuses().length === 1, 'answered');
      assert.deepEqual(sender.statuses(), [200]);
      assert.equal(server.requests.at(-1)?.body, body.length);
      assert.equal(budget.waiting, 0);
      holder.socket.destroy();
      sender.socket.destroy();
      await allGivenBack(budget, 'after it');
    } finally {
      await server.close();
    }
  });

  it('holds a chunked body at the trailer line its address has no room for, and reads on once a holder lets go', async () => {
    const budget = createHeaderLineBudget({ perAddress: 50, perProcess: 1_000 });
    const server = await lineServer(budget);
    const address = '192.0.2.22';

    try {
      const holder = connect(server.port, address, stalledHead(45));

      await until(() => budget.linesOf(address) === 45, 'the holder’s lines');

      const sender = connect(
        server.port,
        address,
        `POST /t HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n${headerLines(20, 't').text}\r\n`,
      );

      // Its head's three lines, given back as its head ends, then five of its
      // trailers: the address's 50.
      await until(() => budget.waiting === 1, 'held at a trailer line');
      assert.equal(budget.linesOf(address), 50);
      assert.equal(sender.received(), '');
      holder.socket.destroy();
      await until(() => sender.statuses().length === 1, 'answered');
      assert.equal(server.requests.at(-1)?.trailers, 20);
      sender.socket.destroy();
      await allGivenBack(budget, 'after it');
    } finally {
      await server.close();
    }
  });

  it('counts a connection admitted for some lines that sends more line by line, and holds it at the first that does not fit', async () => {
    const budget = createHeaderLineBudget({ perAddress: 200, perProcess: 1_000 });
    const server = await lineServer(budget);
    const address = '192.0.2.23';

    try {
      const holder = connect(server.port, address, stalledHead(100));

      await until(() => budget.linesOf(address) === 100, 'the holder’s lines');

      const grower = connect(server.port, address, stalledHead(30, '/grow'));

      await until(() => budget.linesOf(address) === 130, 'its first 30');

      const before = server.parsed(grower);
      const more = headerLines(100, 'more').text;

      grower.write(`${more}Content-Length: 0\r\n\r\n`);
      await until(() => budget.waiting === 1, 'held at its 71st');
      assert.equal(budget.linesOf(address), 200);
      // Exactly the 70 lines that fit were parsed, and none of the 71st.
      assert.equal(server.parsed(grower) - before, headerLines(70, 'more').text.length);
      holder.socket.destroy();
      await until(() => grower.statuses().length === 1, 'answered once the holder left');
      // Host, 28 lines of `a:`, the 100 more and Content-Length.
      assert.equal(server.requests.at(-1)?.lines, 130);
      grower.socket.destroy();
      await allGivenBack(budget, 'after it');
    } finally {
      await server.close();
    }
  });

  it('holds the first connection of an address holding none while the process’s lines are all in flight, and reads it on once they are given back', async () => {
    const budget = createHeaderLineBudget({ perAddress: 1_000, perProcess: 300 });
    const server = await lineServer(budget);

    try {
      const first = connect(server.port, '192.0.2.30', stalledHead(200));

      await until(() => budget.lines === 200, 'the first address’s lines');

      const second = connect(server.port, '192.0.2.31', stalledHead(100));

      await until(() => budget.lines === 300, 'the process is full');

      const fresh = connect(server.port, '192.0.2.32', 'GET /fresh HTTP/1.1\r\nHost: h\r\n\r\n');

      await until(() => budget.waiting === 1, 'the fresh address waits');
      await delay(200);
      assert.equal(server.parsed(fresh), 0);
      second.socket.destroy();
      await until(() => fresh.statuses().length === 1, 'answered');
      first.socket.destroy();
      fresh.socket.destroy();
      await allGivenBack(budget, 'after it');
    } finally {
      await server.close();
    }
  });

  it('reads the connections waiting in the order they waited', async () => {
    const budget = createHeaderLineBudget({ perAddress: 10, perProcess: 1_000 });
    const server = await lineServer(budget);
    const address = '192.0.2.33';
    const answered: number[] = [];

    try {
      const holder = connect(server.port, address, stalledHead(10));

      await until(() => budget.linesOf(address) === 10, 'the holder’s lines');

      const waiting: Client[] = [];

      for (let index = 0; index < 5; index += 1) {
        const client = connect(server.port, address, `${stalledHead(8, `/w${index}`)}\r\n`);

        client.socket.on('data', () => {
          if (!answered.includes(index)) {
            answered.push(index);
          }
        });
        waiting.push(client);
        await until(() => budget.waiting === index + 1, `the ${index + 1}th waits`);
      }

      holder.socket.destroy();
      await until(() => answered.length === 5, 'all five answered');
      assert.deepEqual(answered, [0, 1, 2, 3, 4]);

      for (const client of waiting) {
        client.socket.destroy();
      }

      await allGivenBack(budget, 'after them');
    } finally {
      await server.close();
    }
  });
});

describe('random pipelines on connections contending for a few lines (D238)', () => {
  for (const [connections, perAddress] of [
    [4, 1_000],
    [8, 40],
  ] as const) {
    it(`answers every request of random well-formed pipelines on ${connections} connections from 2 addresses at ${perAddress} lines an address, each head’s and trailer section’s lines as Node read them, with no line at error`, async () => {
      const { budget, sections } = recording({ perAddress, perProcess: perAddress * 2 });
      const server = await lineServer(budget);
      const draw = random(connections * 1_000 + perAddress);
      const expected = new Map<string, string[]>();

      try {
        const runs = Array.from({ length: connections }, async (_, index) => {
          const address = `192.0.2.${100 + (index % 2)}`;
          const { text, requests } = modelPipeline(draw, 6, 120);

          // The sections the bound must count on this connection: each
          // head's lines, and each body's end, a chunked one's trailers.
          expected.set(address, [
            ...(expected.get(address) ?? []),
            JSON.stringify(
              requests.flatMap((request) =>
                request.body === 'none'
                  ? [request.headLines]
                  : [request.headLines, request.trailerLines],
              ),
            ),
          ]);

          const bytes = Buffer.from(text, 'latin1');
          const cuts = Array.from({ length: 8 }, () => Math.floor(draw() * bytes.length)).sort(
            (a, b) => a - b,
          );
          const client = connect(server.port, address, bytes.subarray(0, cuts[0]));
          let from = cuts[0] ?? 0;

          for (const cut of [...cuts.slice(1), bytes.length]) {
            await delay(Math.floor(draw() * 20));
            client.write(bytes.subarray(from, cut));
            from = cut;
          }

          await until(
            () => client.statuses().length === requests.length,
            `${address} answered`,
            60_000,
          );
          assert.ok(client.statuses().every((status) => status === 200));
          client.socket.destroy();
        });

        await Promise.all(runs);
        await allGivenBack(budget, 'after every pipeline');

        // Each connection's sections, whichever connection of its address
        // it was, as Node read them.
        for (const [address, each] of expected) {
          assert.deepEqual(
            (sections.get(address) ?? []).map((ended) => JSON.stringify(ended)).sort(),
            [...each].sort(),
            address,
          );
        }

        assert.deepEqual(server.errors, []);
      } finally {
        await server.close();
      }
    });
  }
});

describe('random bytes behind the HTTP/2 preface and other heads (#277)', () => {
  it('answers or closes each of 310 connections of a prefix and up to 64 KiB of random bytes cut into random writes, every line given back, nothing logged at error or warn', async () => {
    const seed = 277;
    const draw = random(seed);
    const budget = createHeaderLineBudget({ perAddress: 100_000, perProcess: 1_000_000 });
    const server = await lineServer(budget, { headersTimeout: 10_000, requestTimeout: 20_000 });
    const preface = HTTP2_PREFACE.toString('latin1');
    const prefixes: (readonly [string, string])[] = [
      ...Array.from(
        { length: preface.length + 1 },
        (_, length) => [`the preface's first ${length} bytes`, preface.slice(0, length)] as const,
      ),
      ['a PRI line', 'PRI * HTTP/2.0\r\n\r\n'],
      ['a PRI line with header lines', 'PRI * HTTP/2.0\r\nHost: h\r\na: 1\r\n\r\n'],
      ['an ordinary head', 'GET /o HTTP/1.1\r\nHost: h\r\n\r\n'],
      [
        'a head with a declared-length body',
        'POST /l HTTP/1.1\r\nHost: h\r\nContent-Length: 40\r\n\r\n',
      ],
      ['a chunked head', 'POST /c HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n'],
      [
        'an upgrade head',
        'GET /u HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n',
      ],
    ];

    try {
      for (let index = 0; index < prefixes.length * 10; index += 1) {
        const [name, prefix] = prefixes[index % prefixes.length] as readonly [string, string];
        // Sometimes the rest of the preface, or a few well-formed requests,
        // before random bytes and bytes that end lines and heads, of a size
        // from 0 to 64 KiB, small ones more often.
        const rest = preface.startsWith(prefix) && draw() < 0.3 ? preface.slice(prefix.length) : '';
        const requests =
          draw() < 0.3 ? modelPipeline(draw, 1 + Math.floor(draw() * 3), 20).text : '';
        const size = Math.floor(65_537 ** draw()) - 1;
        const bytes = Buffer.from(prefix + rest + requests + nastyBytes(draw, size), 'latin1');
        const cuts = Array.from({ length: Math.floor(draw() * 6) }, () =>
          Math.floor(draw() * bytes.length),
        ).sort((a, b) => a - b);
        const gaps = cuts.map(() => Math.floor(draw() * 3));
        const what =
          `seed ${seed}, case ${index}: ${name}` +
          `${rest === '' ? '' : ', the rest of the preface'}${requests === '' ? '' : `, ${requests.length} bytes of requests`}` +
          `, ${size} random bytes, ${bytes.length} in all, cut at [${cuts.join(', ')}]`;
        const client = connect(
          server.port,
          `192.0.2.${60 + (index % 4)}`,
          bytes.subarray(0, cuts[0]),
        );
        for (let at = 0; at < cuts.length; at += 1) {
          await delay(gaps[at] ?? 0);
          client.write(bytes.subarray(cuts[at], cuts[at + 1] ?? bytes.length));
        }

        client.socket.end();

        await until(() => client.isClosed(), `${what}: closed`, 10_000);
        assert.ok(
          server.errors.length === 0 && server.warnings.length === 0,
          `${what}: logged ${JSON.stringify({ errors: server.errors, warnings: server.warnings })}`,
        );
        await allGivenBack(budget, what);
      }
    } finally {
      await server.close();
    }
  });
});
