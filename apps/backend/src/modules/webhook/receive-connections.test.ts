/**
 * The connections one sender address may have open to the receive listener,
 * counted by its PROXY protocol layer (D227), over real sockets.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 *
 * Every connection comes from 127.0.0.1, which stands in for the proxy, and
 * opens with a PROXY protocol v2 header naming its sender, as Traefik's TCP
 * route writes one. A connection is open when the listener answers a request
 * on it, `GET /robots.txt` kept alive; one refused is closed with nothing
 * written, before Node's HTTP server has seen it. What the layer counts is
 * the header's sender, keyed as the per-minute limits key an address; the
 * key's rules - an IPv6 address by its `/64`, an IPv4-mapped one as its
 * IPv4 - are `proxy-protocol.test.ts`'s, where the layer is driven without a
 * listener.
 */
import assert from 'node:assert/strict';
import net, { type AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import ipaddr from 'ipaddr.js';
import type pg from 'pg';
import { MAX_RECEIVE_CONNECTIONS_PER_ADDRESS } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildReceiver, buildServer } from '../../server.ts';
import { PROXY_V2_SIGNATURE } from './proxy-protocol.ts';

/** Where the test's sockets come from, and the one peer trusted to send a header. */
const PROXY = '127.0.0.1';
/** The sender that fills its places. */
const SENDER = '198.51.100.7';
/** Another sender, which the first one's count must not touch. */
const OTHER = '198.51.100.8';

let pool: pg.Pool;
let api: FastifyInstance;
const createdSessionIds: string[] = [];
/** Every connection a test opened, so that none outlives the file. */
const sockets: net.Socket[] = [];
/** Every receive listener a test started. */
const listeners: FastifyInstance[] = [];

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
  await startup;

  for (const socket of sockets) {
    socket.destroy();
  }

  await Promise.all(listeners.map((listener) => listener.close()));
  await api?.close();

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await pool?.end();
});

async function newSession(): Promise<string> {
  const response = await api.inject({ method: 'POST', url: '/api/sessions' });

  assert.equal(response.statusCode, 201, response.body);

  const { id } = response.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

/** A PROXY protocol v2 header for TCP from `source`, IPv4 or IPv6, as Traefik writes one. */
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

interface Receiver {
  port: number;
  /** Everything the listener logged. */
  log: () => string;
}

/** A receive listener with PROXY protocol v2 on, trusting the loopback peer alone. */
async function receiver(connectionsPerAddress?: number): Promise<Receiver> {
  let output = '';
  const app = buildReceiver(pool, {
    trustedProxyCidrs: [`${PROXY}/32`],
    proxyProtocol: 'v2',
    ...(connectionsPerAddress === undefined ? {} : { connectionsPerAddress }),
    logDestination: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
  });

  listeners.push(app);
  await app.listen({ host: PROXY, port: 0 });

  return { port: (app.server.address() as AddressInfo).port, log: () => output };
}

interface Connection {
  socket: net.Socket;
  /** `open`: its request was answered and it is kept alive; `refused`: closed with nothing written. */
  state: 'open' | 'refused';
}

/**
 * A connection from `sender` asking for `/robots.txt` and keeping the
 * connection alive: resolves `open` once the answer has arrived, or `refused`
 * when the listener closes it with nothing written.
 */
function open(port: number, sender: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, PROXY);
    let received = '';

    sockets.push(socket);
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');

      if (received.includes('\r\n\r\n')) {
        if (!received.startsWith('HTTP/1.1 200 ')) {
          reject(new Error(`unexpected answer: ${received}`));
        }

        resolve({ socket, state: 'open' });
      }
    });
    socket.once('close', () => {
      if (received === '') {
        resolve({ socket, state: 'refused' });
      }
    });
    socket.once('connect', () => {
      socket.write(
        Buffer.concat([
          proxyHeader(sender),
          Buffer.from('GET /robots.txt HTTP/1.1\r\nHost: hook.qa-tools.ru\r\n\r\n', 'latin1'),
        ]),
      );
    });
  });
}

/**
 * `count` connections from `sender`, opened 64 at a time: a listen backlog
 * of 128, macOS's default, would turn connections opened all at once away
 * before the listener had seen them.
 */
async function openMany(port: number, sender: string, count: number): Promise<Connection[]> {
  const connections: Connection[] = [];

  while (connections.length < count) {
    const batch = Math.min(64, count - connections.length);

    connections.push(
      ...(await Promise.all(Array.from({ length: batch }, () => open(port, sender)))),
    );
  }

  return connections;
}

/** A webhook from `sender` on a connection of its own: the status it was answered with, 0 for none. */
function webhook(port: number, sender: string, sessionId: string): Promise<number> {
  return new Promise((resolve) => {
    const socket = net.connect(port, PROXY);
    let received = '';

    sockets.push(socket);
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
    });
    socket.once('close', () => {
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0));
    });
    socket.once('connect', () => {
      socket.write(
        Buffer.concat([
          proxyHeader(sender),
          Buffer.from(
            `POST /s/${sessionId} HTTP/1.1\r\nHost: hook.qa-tools.ru\r\nConnection: close\r\n` +
              'Content-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello',
            'latin1',
          ),
        ]),
      );
    });
  });
}

/** Waits until `socket` has closed on the listener's side too, as far as a little time tells. */
async function closed(socket: net.Socket): Promise<void> {
  if (!socket.closed) {
    await new Promise((resolve) => socket.once('close', resolve));
  }

  // The listener sees the close a moment after the client.
  await delay(50);
}

/** The states of `connections`, counted. */
function states(connections: Connection[]): Record<string, number> {
  const counted: Record<string, number> = {};

  for (const { state } of connections) {
    counted[state] = (counted[state] ?? 0) + 1;
  }

  return counted;
}

describe('the connections of one sender address on the receive listener (D227)', () => {
  it('keeps 512 open from one address, closes the 513th with nothing written, serves another address meanwhile and the first again once one closes', async () => {
    assert.equal(MAX_RECEIVE_CONNECTIONS_PER_ADDRESS, 512);

    const { port, log } = await receiver();
    const sessionId = await newSession();
    const held = await openMany(port, SENDER, 512);

    assert.deepEqual(states(held), { open: 512 });

    const over = await open(port, SENDER);

    assert.equal(over.state, 'refused');
    // A webhook is refused the same way: no answer, nothing stored.
    assert.equal(await webhook(port, SENDER, sessionId), 0);
    // Another address is unaffected.
    assert.equal(await webhook(port, OTHER, sessionId), 200);

    // One of the 512 closes; the next from the same address is served.
    held[0]?.socket.end();
    await closed(held[0]?.socket as net.Socket);
    assert.equal(await webhook(port, SENDER, sessionId), 200);

    const { rows } = await pool.query<{ source_ip: string }>(
      'SELECT source_ip FROM requests WHERE session_id = $1 ORDER BY received_at, id',
      [sessionId],
    );

    assert.deepEqual(
      rows.map((row) => row.source_ip),
      [OTHER, SENDER],
    );

    // The refusals are logged as a count, never with the sender's address.
    const lines = log().trim().split('\n');
    const refusals = lines.filter((line) => line.includes('every connection place taken'));

    assert.equal(refusals.length, 1, log());
    assert.match(refusals[0] as string, /"refused":1,"connectionsPerAddress":512/);
    assert.equal(log().includes(SENDER), false, 'a log line names the sender');
    assert.equal(log().includes(OTHER), false, 'a log line names the other sender');
  });

  it('gives a place back however the connection ends: closed by the client, reset, or ended by an answer with Connection: close', async () => {
    const { port } = await receiver(4);
    const sessionId = await newSession();

    // Closed by the client.
    let held = await openMany(port, SENDER, 4);

    assert.deepEqual(states(held), { open: 4 });
    assert.equal((await open(port, SENDER)).state, 'refused');

    for (const { socket } of held) {
      socket.end();
      await closed(socket);
    }

    // Reset by the client.
    held = await openMany(port, SENDER, 5);
    assert.deepEqual(states(held), { open: 4, refused: 1 });

    for (const { socket, state } of held) {
      if (state === 'open') {
        socket.resetAndDestroy();
        await closed(socket);
      }
    }

    // Ended by the listener, after answering `Connection: close`: four
    // webhooks one after another, each on a connection of its own, and then
    // every place is free again.
    for (let index = 0; index < 4; index += 1) {
      assert.equal(await webhook(port, SENDER, sessionId), 200);
    }

    await delay(50);
    held = await openMany(port, SENDER, 5);
    assert.deepEqual(states(held), { open: 4, refused: 1 });
  });

  it('counts nothing with the bound turned off: 0', async () => {
    const { port, log } = await receiver(0);
    const held = await openMany(port, SENDER, 600);

    assert.deepEqual(states(held), { open: 600 });
    assert.equal(log().includes('every connection place taken'), false);
  });
});
