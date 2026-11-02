/**
 * The realtime connections an address may have open on a real listener
 * (D227): 16 accepted, the 17th refused `429` / `1020` with `Retry-After: 1`
 * before any upgrade and its connection ended, another address unaffected,
 * the next accepted once one closes; two IPv6 addresses of one `/64` counted
 * together, an IPv4-mapped one as its IPv4; the place given back however a
 * connection ends - upgraded and closed by its client, closed by the server
 * (`4404`, a cut), or never upgraded: a handshake `ws` refuses, a `GET` with
 * no upgrade, a client gone before its upgrade - and nothing left held; and
 * a page open in 16 tabs of one address reconnecting as a viewer does after
 * a cut.
 *
 * Over real sockets, with the upgrade written by hand: the place is taken
 * once the headers have arrived and given back when a socket closes, which
 * only a socket can decide. The listener trusts the test's own socket as the
 * proxy, so that `X-Forwarded-For` names the address a connection counts
 * under (D111, D201).
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import net from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ErrorCode, MAX_REALTIME_CONNECTIONS_PER_ADDRESS } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildServer } from '../../server.ts';
import { until } from '../../testing/realtime.ts';
import { createRealtimePlaces, type RealtimePlaces } from './connection-places.ts';
import { RealtimeHub } from './hub.ts';

/** The address most connections come from, and another. */
const A = '203.0.113.10';
const B = '203.0.113.11';

let pool: pg.Pool;
const createdSessionIds: string[] = [];
const listeners: FastifyInstance[] = [];
/** Every connection a test opened, so that none outlives the file. */
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
  places: RealtimePlaces;
  hub: RealtimeHub;
  /** Lets the connections held before their handler, `x-test-hold`, go on. */
  openGate: () => void;
}

/**
 * The application listener on a port of its own, with `limit` realtime
 * connections an address - the production 16 unless given - and the test's
 * socket trusted as the proxy. A connection carrying `x-test-hold` waits
 * before its handler, after its place is taken, until `openGate`.
 */
async function listen(limit?: number, appPool: pg.Pool = pool): Promise<Listener> {
  const places = createRealtimePlaces(limit);
  const hub = new RealtimeHub();
  const app = buildServer(appPool, {
    logDestination: discard(),
    trustedProxyCidrs: ['127.0.0.1/32'],
    realtimePlaces: places,
    hub,
  });
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  // After every `onRequest` hook, the route's own among them, and before
  // the handler that upgrades.
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-hold'] !== undefined) {
      await gate;
    }
  });

  listeners.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });

  return { app, port: (app.server.address() as net.AddressInfo).port, places, hub, openGate };
}

async function createSession(app: FastifyInstance): Promise<string> {
  // From an address of its own, so that no test's count includes it.
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    remoteAddress: '198.18.0.1',
  });

  assert.equal(response.statusCode, 201, response.body);

  const { id } = response.json() as { id: string };

  createdSessionIds.push(id);

  return id;
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Connection {
  /** The answer to the upgrade: `101`, or a refusal with its body. */
  answer: () => Promise<Answer>;
  /** Whether the server has sent `ready`: the connection is subscribed. */
  ready: () => boolean;
  /** The code of the server's close frame, once one has arrived. */
  closeCode: () => number | null;
  /** Whether the server has ended the connection, by its FIN or a reset. */
  ended: () => boolean;
  /** Closes the connection, as a tab that goes away does. */
  close: () => void;
}

interface ConnectOptions {
  /** The address the connection comes from, as the proxy names it. */
  from?: string;
  /** The request target, `/ws/<sessionId>` unless given. */
  target?: string;
  /** Header lines replacing or added to a valid upgrade's. */
  headers?: Record<string, string | null>;
}

/**
 * Opens `/ws/<sessionId>` on a connection of its own with a handshake written
 * by hand, as a browser writes one, `events` declaring nothing.
 */
function connect(port: number, sessionId: string, options: ConnectOptions = {}): Connection {
  const { from = A, headers = {}, target = `/ws/${sessionId}` } = options;
  const lines: Record<string, string | null> = {
    Host: '127.0.0.1',
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    'Sec-WebSocket-Version': '13',
    'X-Forwarded-For': from,
    ...headers,
  };
  const head = [
    `GET ${target} HTTP/1.1`,
    ...Object.entries(lines)
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([name, value]) => `${name}: ${value}`),
  ].join('\r\n');
  const socket = net.connect(port, '127.0.0.1');
  let received = Buffer.alloc(0);
  let answer: Answer | null = null;
  let ended = false;
  /** The server's frames after a `101`, read as they arrive: unmasked, none fragmented. */
  let frames = Buffer.alloc(0);
  const texts: string[] = [];
  let closeCode: number | null = null;
  const readFrames = (): void => {
    for (;;) {
      if (frames.length < 2) {
        return;
      }

      const opcode = (frames[0] as number) & 0x0f;
      const short = (frames[1] as number) & 0x7f;
      const [start, length] =
        short === 126
          ? [4, frames.length >= 4 ? frames.readUInt16BE(2) : Infinity]
          : short === 127
            ? [10, frames.length >= 10 ? Number(frames.readBigUInt64BE(2)) : Infinity]
            : [2, short];

      if (frames.length < start + length) {
        return;
      }

      const payload = frames.subarray(start, start + length);

      if (opcode === 0x1) {
        texts.push(payload.toString('utf8'));
      } else if (opcode === 0x8) {
        closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      }

      frames = frames.subarray(start + length);
    }
  };

  sockets.push(socket);
  socket.on('error', () => undefined);
  socket.once('end', () => {
    ended = true;
  });
  socket.once('close', () => {
    ended = true;
  });
  socket.on('data', (chunk: Buffer) => {
    if (answer?.status === 101) {
      frames = Buffer.concat([frames, chunk]);
      readFrames();

      return;
    }

    received = Buffer.concat([received, chunk]);

    if (answer !== null) {
      return;
    }

    const headEnd = received.indexOf('\r\n\r\n');

    if (headEnd === -1) {
      return;
    }

    const [statusLine = '', ...headerLines] = received
      .subarray(0, headEnd)
      .toString('latin1')
      .split('\r\n');
    const parsed: http.IncomingHttpHeaders = {};

    for (const line of headerLines) {
      const colon = line.indexOf(':');

      parsed[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }

    const status = Number(statusLine.split(' ')[1]);
    const end = status === 101 ? headEnd + 4 : headEnd + 4 + Number(parsed['content-length'] ?? 0);

    if (received.length >= end) {
      answer = { status, headers: parsed, body: received.subarray(headEnd + 4, end).toString() };

      if (status === 101) {
        frames = received.subarray(end);
        readFrames();
      }
    }
  });
  socket.write(`${head}\r\n\r\n`);

  return {
    answer: async () => {
      await until(() => answer !== null || ended, 'the answer to the upgrade', 5_000);
      assert.ok(answer !== null, 'the connection ended before its answer');

      return answer;
    },
    ready: () => texts.includes('{"type":"ready"}'),
    closeCode: () => closeCode,
    ended: () => ended,
    close: () => {
      socket.destroy();
    },
  };
}

/** Opens a connection and waits until it is subscribed. */
async function subscribed(port: number, sessionId: string, from = A): Promise<Connection> {
  const connection = connect(port, sessionId, { from });
  const answer = await connection.answer();

  assert.equal(answer.status, 101, answer.body);
  await until(connection.ready, 'ready');

  return connection;
}

/** Asserts the refusal of `connection`: `429` / `1020`, never upgraded, its connection ended within 1 s. */
async function assertRefused(connection: Connection, limit: number): Promise<void> {
  const answer = await connection.answer();

  assert.equal(answer.status, 429, answer.body);
  assert.equal(answer.headers['retry-after'], '1');
  assert.equal(answer.headers.connection, 'close');
  assert.equal(answer.headers.upgrade, undefined);
  assert.deepEqual(JSON.parse(answer.body), {
    errorCode: ErrorCode.TOO_MANY_REALTIME_CONNECTIONS,
    message: `Too many realtime connections: ${limit} open at once per address; close one and try again`,
  });
  await until(connection.ended, 'the refused connection ends', 1_000);
  assert.equal(connection.ready(), false);
}

async function untilNothingHeld(places: RealtimePlaces): Promise<void> {
  await until(() => places.taken === 0 && places.keys === 0, 'every place given back');
}

describe('the realtime connections of one address (D227)', () => {
  it('accepts 16 and refuses the 17th 429 / 1020 before its upgrade, another address served, the next accepted once one closes', async () => {
    const { app, port, places, hub } = await listen();
    const sessionId = await createSession(app);

    assert.equal(MAX_REALTIME_CONNECTIONS_PER_ADDRESS, 16);

    const open: Connection[] = [];

    for (let index = 0; index < 16; index += 1) {
      open.push(await subscribed(port, sessionId));
    }

    assert.equal(places.takenBy(A), 16);
    assert.equal(hub.countFor(sessionId), 16);

    const refused = connect(port, sessionId);

    await assertRefused(refused, 16);
    assert.equal(places.takenBy(A), 16);
    assert.equal(hub.countFor(sessionId), 16);

    // Another address is unaffected.
    const other = await subscribed(port, sessionId, B);

    assert.equal(places.takenBy(B), 1);

    // One closes: its place comes back, and the next is accepted.
    open.shift()?.close();
    await until(() => places.takenBy(A) === 15, 'the closed connection gives its place back');
    open.push(await subscribed(port, sessionId));
    assert.equal(places.takenBy(A), 16);
    await assertRefused(connect(port, sessionId), 16);

    for (const connection of [...open, other]) {
      connection.close();
    }

    await untilNothingHeld(places);
    await until(() => hub.countFor(sessionId) === 0, 'every connection forgotten');
  });

  it('counts two IPv6 addresses of one /64 together, an IPv4-mapped one as its IPv4, others apart', async () => {
    const { app, port, places } = await listen(2);
    const sessionId = await createSession(app);
    const open = [
      await subscribed(port, sessionId, '2001:db8:1:2::1'),
      await subscribed(port, sessionId, '2001:db8:1:2:ffff:ffff:ffff:fffe'),
    ];

    await assertRefused(connect(port, sessionId, { from: '2001:db8:1:2::3' }), 2);
    open.push(await subscribed(port, sessionId, '2001:db8:1:3::1'));

    open.push(await subscribed(port, sessionId, '::ffff:198.51.100.7'));
    open.push(await subscribed(port, sessionId, '198.51.100.7'));
    await assertRefused(connect(port, sessionId, { from: '198.51.100.7' }), 2);

    assert.equal(places.takenBy('2001:db8:1:2::/64'), 2);
    assert.equal(places.takenBy('2001:db8:1:3::/64'), 1);
    assert.equal(places.takenBy('198.51.100.7'), 2);

    for (const connection of open) {
      connection.close();
    }

    await untilNothingHeld(places);
  });
});

describe('the place of a realtime connection given back (D227)', () => {
  it('when the upgrade never happens: a handshake refused, a GET with no upgrade, a client gone before its upgrade', async () => {
    const { app, port, places, hub, openGate } = await listen(1);
    const sessionId = await createSession(app);

    // A handshake `ws` refuses, `400` with its own body: the place is taken
    // before the handshake is checked, and back once its socket closes.
    const badVersion = connect(port, sessionId, { headers: { 'Sec-WebSocket-Version': '99' } });

    assert.equal((await badVersion.answer()).status, 400);
    await until(badVersion.ended, 'the refused handshake ends');
    await untilNothingHeld(places);

    // A plain `GET`, no upgrade asked for: the route answers `404`, kept alive.
    const plain = connect(port, sessionId, {
      headers: { Upgrade: null, Connection: 'keep-alive', 'Sec-WebSocket-Key': null },
    });

    assert.equal((await plain.answer()).status, 404);
    await untilNothingHeld(places);
    plain.close();

    // A client that leaves once its place is taken, before its upgrade.
    const gone = connect(port, sessionId, { headers: { 'X-Test-Hold': '1' } });

    await until(() => places.takenBy(A) === 1, 'the held connection takes its place');
    gone.close();

    // Nothing reads an upgrade's socket before its handler does, so its
    // departure is seen once the handler writes to it: the place is back
    // then, and nothing stays registered.
    await delay(100);
    openGate();
    await untilNothingHeld(places);
    await until(() => hub.countFor(sessionId) === 0, 'nothing registered for the client gone');

    // The one place is free: a connection is accepted and subscribed.
    const next = await subscribed(port, sessionId);

    assert.equal(places.takenBy(A), 1);
    next.close();
    await untilNothingHeld(places);
  });

  it('when the socket closes: closed by its client, refused 4404 by the server, cut with every other', async () => {
    const { app, port, places, hub } = await listen(1);
    const sessionId = await createSession(app);

    const first = await subscribed(port, sessionId);

    first.close();
    await untilNothingHeld(places);

    // An unknown session: upgraded, then closed `4404` by the server, the
    // place held until the client answers the close and the socket goes.
    const unknown = connect(port, 'x'.repeat(43));

    assert.equal((await unknown.answer()).status, 101);
    await until(() => unknown.closeCode() === 4404, 'the server closes with 4404');
    assert.equal(places.takenBy(A), 1);
    unknown.close();
    await untilNothingHeld(places);

    // A cut of every connection, as when the process stops hearing (D221).
    const cut = await subscribed(port, sessionId);

    assert.equal(places.takenBy(A), 1);
    hub.deafen();
    await until(cut.ended, 'the cut connection ends');
    await untilNothingHeld(places);
    hub.hear();

    (await subscribed(port, sessionId)).close();
    await untilNothingHeld(places);
  });

  it('lets a page open in 16 tabs of one address reconnect after a cut, as a viewer does a second later (D079)', async () => {
    const { app, port, places, hub } = await listen();
    const sessionId = await createSession(app);
    const tabs = await Promise.all(Array.from({ length: 16 }, () => subscribed(port, sessionId)));

    assert.equal(places.takenBy(A), 16);
    hub.deafen();
    await until(() => tabs.every((tab) => tab.ended()), 'every tab is cut');
    hub.hear();

    // The viewer's first delay after an interruption.
    await delay(1_000);

    const again = await Promise.all(Array.from({ length: 16 }, () => subscribed(port, sessionId)));

    assert.equal(places.takenBy(A), 16);
    assert.equal(hub.countFor(sessionId), 16);

    for (const tab of again) {
      tab.close();
    }

    await untilNothingHeld(places);
  });
});

/**
 * A pool that counts the statements reading `sessions`, which a realtime
 * connection makes only once it is upgraded (`sessionAccess`).
 */
function countingPool(): { pool: pg.Pool; lookups: () => number; reset: () => void } {
  let lookups = 0;
  const counting = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'query') {
        return (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].includes('FROM sessions')) {
            lookups += 1;
          }

          return (target.query as (...rest: unknown[]) => unknown).apply(target, args);
        };
      }

      const value: unknown = Reflect.get(target, property, receiver);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return {
    pool: counting,
    lookups: () => lookups,
    reset: () => {
      lookups = 0;
    },
  };
}

describe('upgrade loops over the cap (D227)', () => {
  it('are refused 429 / 1020 before the session is looked up, at 50, 500 and 2,000 attempts, holding nothing more', async () => {
    const counted = countingPool();
    const { app, port, places } = await listen(1, counted.pool);
    const sessionId = await createSession(app);
    const held = await subscribed(port, sessionId);

    for (const attempts of [50, 500, 2_000]) {
      counted.reset();

      for (let done = 0; done < attempts; done += 50) {
        const batch = Array.from({ length: Math.min(50, attempts - done) }, (_, index) =>
          // A known session and unknown ones alike: neither is looked up.
          connect(port, index % 2 === 0 ? sessionId : 'x'.repeat(43)),
        );

        for (const connection of batch) {
          const answer = await connection.answer();

          assert.equal(answer.status, 429, answer.body);
          await until(connection.ended, 'the refused connection ends', 1_000);
        }
      }

      assert.equal(counted.lookups(), 0, `${attempts} refusals looked a session up`);
      assert.equal(places.takenBy(A), 1);
      assert.equal(places.keys, 1);
    }

    held.close();
    await untilNothingHeld(places);
  });

  it('cannot be escaped by a forged forwarding prefix or a variant of the path: counted, or not the route', async () => {
    const counted = countingPool();
    const { app, port, places } = await listen(1, counted.pool);
    const sessionId = await createSession(app);
    const held = await subscribed(port, sessionId);

    counted.reset();

    // A prefix the client wrote itself: the proxy appends the address it
    // saw, which is the one counted (D111).
    for (const from of [`9.9.9.9, ${A}`, `${B}, ${A}`, `unknown, ${A}`, ` ${A}`]) {
      await assertRefused(connect(port, sessionId, { from }), 1);
    }

    // Every target that reaches the route is counted and refused; any other
    // is not the route, refused by the router, and never upgraded.
    for (const target of [
      `/ws/${sessionId}/`,
      `/ws/${sessionId}?events=request.received`,
      `/ws/${sessionId}?events=a&events=b&events=`,
      `/ws/${sessionId}#fragment`,
      `/%77s/${sessionId}`,
      `/ws/${sessionId.slice(0, 10)}%2F${sessionId.slice(10)}`,
      `//ws/${sessionId}`,
      `/ws//${sessionId}`,
      `/WS/${sessionId}`,
      `/ws/${'x'.repeat(5_000)}`,
    ]) {
      const connection = connect(port, sessionId, { target });
      const answer = await connection.answer();

      const what = target.slice(0, 80);

      // `414` for a parameter over the router's 100 characters.
      assert.ok([429, 404, 400, 414].includes(answer.status), `${what}: ${answer.status}`);
      await until(connection.ended, `${what} ends`, 1_000);
    }

    assert.equal(counted.lookups(), 0);
    assert.equal(places.takenBy(A), 1);
    held.close();
    await untilNothingHeld(places);
  });
});
