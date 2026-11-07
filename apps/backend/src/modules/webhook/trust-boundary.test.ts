/**
 * The trust boundary, end to end (D111, D117, D187).
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 *
 * Since 0.36.0 webhooks arrive on the receive listener, which Traefik's TCP
 * route reaches with the sender's own bytes behind a PROXY protocol v2 header
 * carrying the sender's address (D187). The boundary decides who may send that
 * header: a peer inside `TRUSTED_PROXY_CIDRS`, and nobody else. No request
 * header is ever believed for the address there, and every header is stored as
 * the sender wrote it.
 *
 * Where the PROXY layer is on, requests go over a real socket from 127.0.0.1,
 * written byte for byte, and the allow-list decides whether that peer is the
 * proxy. Where it is off, as locally, the peer is driven by
 * `light-my-request`'s `remoteAddress`, which sets `socket.remoteAddress` on the
 * injected request.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import ipaddr from 'ipaddr.js';
import type pg from 'pg';
import type { RequestDetails, WebhookDefaultAnswer } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildReceiver, buildServer } from '../../server.ts';
import { PROXY_V2_SIGNATURE } from './proxy-protocol.ts';

/** The node's pod network, which is the shape Stage 0 produced (D111). */
const TRUSTED_CIDR = '10.42.0.0/24';
/** A peer inside that range, standing in for the Traefik pod. */
const TRUSTED_PEER = '10.42.0.28';
/** A peer outside it. Nothing it claims about forwarding may be believed. */
const UNTRUSTED_PEER = '203.0.113.50';
/** Where the test's own socket connects from. */
const LOOPBACK = '127.0.0.1';
/** The sender's address a PROXY header carries in these tests. */
const SENDER = '198.51.100.7';
/** A short deadline for the header, so a refusal by timeout is quick to see. */
const HEADER_TIMEOUT_MS = 300;

let pool: pg.Pool;
/** The application listener, which creates the sessions and serves the details. */
let api: FastifyInstance;
/** The receive listener without PROXY protocol, as locally, with the allow-list set. */
let plain: FastifyInstance;

const createdSessionIds: string[] = [];

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
  api = buildServer(pool);
  plain = buildReceiver(pool, { trustedProxyCidrs: [TRUSTED_CIDR] });
  api.log.level = 'silent';
  plain.log.level = 'silent';
  await api.ready();
  await plain.ready();
}

after(async () => {
  // A failed start is before()'s to report; close what it did open.
  await startup?.catch(() => undefined);

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await api?.close();
  await plain?.close();
  await pool.end();
});

async function newSession(): Promise<string> {
  const response = await api.inject({ method: 'POST', url: '/api/sessions' });
  const { id } = response.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

interface StoredCapture {
  id: string;
  path: string;
  http_version: string;
  query_string: string;
  headers: [string, string][];
  raw_request: Buffer;
  source_ip: string | null;
  body: Buffer;
}

async function storedCaptures(sessionId: string): Promise<StoredCapture[]> {
  const result = await pool.query<StoredCapture>(
    `SELECT id, path, http_version, query_string, headers, raw_request, source_ip, body
       FROM requests WHERE session_id = $1 ORDER BY received_at, id`,
    [sessionId],
  );

  return result.rows;
}

async function storedCapture(sessionId: string): Promise<StoredCapture> {
  const rows = await storedCaptures(sessionId);

  assert.equal(rows.length, 1);

  return rows[0] as StoredCapture;
}

/** Sends one webhook to the plain receive listener from a given peer, and reads back the row. */
async function injected(
  remoteAddress: string,
  headers: Record<string, string> = {},
): Promise<StoredCapture> {
  const sessionId = await newSession();

  const response = await plain.inject({
    method: 'POST',
    url: `/s/${sessionId}`,
    remoteAddress,
    headers,
    payload: 'x',
  });

  assert.equal(response.statusCode, 200, response.body);

  return storedCapture(sessionId);
}

/**
 * A PROXY protocol v2 header for TCP, as Traefik writes it (D187): the
 * signature, version 2 with the PROXY command, the family, the length, the
 * addresses and the ports, and any TLV bytes after them.
 */
function proxyHeader(
  source: string,
  { tlv = Buffer.alloc(0), command = 0x21 }: { tlv?: Buffer; command?: number } = {},
): Buffer {
  const ipv6 = source.includes(':');
  const ports = Buffer.from([0xc3, 0x50, 0x20, 0xfb]);
  const addresses = ipv6
    ? Buffer.concat([ipv6Bytes(source), ipv6Bytes('::1'), ports])
    : Buffer.concat([
        Buffer.from(source.split('.').map(Number)),
        Buffer.from([10, 42, 0, 24]),
        ports,
      ]);
  const fixed = Buffer.alloc(4);

  fixed[0] = command;
  fixed[1] = ipv6 ? 0x21 : 0x11;
  fixed.writeUInt16BE(addresses.length + tlv.length, 2);

  return Buffer.concat([PROXY_V2_SIGNATURE, fixed, addresses, tlv]);
}

/** Sixteen bytes of an IPv6 address in any spelling. */
function ipv6Bytes(address: string): Buffer {
  return Buffer.from(ipaddr.IPv6.parse(address).toByteArray());
}

/** A request written byte for byte: request line, header lines, blank line, body. */
function rawRequest(target: string, headers: [string, string][], body = ''): Buffer {
  const head = [`POST ${target} HTTP/1.1`, ...headers.map(([name, value]) => `${name}: ${value}`)];

  return Buffer.from(`${head.join('\r\n')}\r\n\r\n${body}`, 'latin1');
}

/** A request with no body that closes its connection once answered. */
function closingRequest(target: string): Buffer {
  return rawRequest(target, [
    ['Host', 'hook.qa-tools.ru'],
    ['Connection', 'close'],
    ['Content-Length', '0'],
  ]);
}

interface Listener {
  app: FastifyInstance;
  port: number;
  log: () => string;
}

/** A receive listener with PROXY protocol v2 on, listening on the loopback interface. */
async function proxied(trustedProxyCidrs: string[]): Promise<Listener> {
  let output = '';
  const app = buildReceiver(pool, {
    trustedProxyCidrs,
    proxyProtocol: 'v2',
    proxyHeaderTimeoutMs: HEADER_TIMEOUT_MS,
    logDestination: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
  });

  await app.listen({ host: LOOPBACK, port: 0 });

  return { app, port: (app.server.address() as AddressInfo).port, log: () => output };
}

interface Exchange {
  /** Everything the server wrote, as latin1. */
  received: string;
  /** Whether the server closed the connection within the deadline. */
  closed: boolean;
}

/**
 * Writes `chunks` one after another over a real socket, `pauseMs` apart, and
 * resolves once the server has closed the connection or the deadline has
 * passed. An injected request could carry neither a PROXY header nor a name in
 * the case it was written in.
 */
function exchange(
  port: number,
  chunks: Buffer[],
  pauseMs = 0,
  timeoutMs = 5_000,
): Promise<Exchange> {
  return new Promise((resolve) => {
    const socket = net.connect(port, LOOPBACK);
    let received = '';

    const deadline = setTimeout(() => {
      socket.destroy();
      resolve({ received, closed: false });
    }, timeoutMs);

    socket.on('connect', () => {
      void (async () => {
        for (const chunk of chunks) {
          if (socket.destroyed) {
            return;
          }

          socket.write(chunk);

          if (pauseMs > 0) {
            await delay(pauseMs);
          }
        }
      })();
    });
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
    });
    // A reset is a close too; what was received is the answer.
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(deadline);
      resolve({ received, closed: true });
    });
  });
}

/**
 * Holds the event loop for twice the header deadline, as one long turn of it
 * does when a flood starves the backend's CPU (#299).
 */
function blockLoop(): void {
  const started = Date.now();

  while (Date.now() - started < 2 * HEADER_TIMEOUT_MS) {
    // Nothing: no timer, no socket and no immediate runs until this returns.
  }
}

/**
 * Connects to `listener` and waits until the server has accepted the
 * connection - a `connection` listener added after the receiver was built
 * runs after the PROXY layer's, so the header's deadline is armed - and the
 * client is connected. Then, in one synchronous step, writes `bytes` and
 * blocks the event loop past the deadline (#299): the bytes are in the
 * server's socket buffer, unread, when the next turn runs the deadline's
 * timer. Resolves once the server has closed the connection, or after five
 * seconds.
 */
async function exchangeAfterBlockedLoop(listener: Listener, bytes: Buffer): Promise<Exchange> {
  const accepted = once(listener.app.server, 'connection');
  const socket = net.connect(listener.port, LOOPBACK);
  let received = '';

  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString('latin1');
  });
  // A reset is a close too; what was received is the answer.
  socket.on('error', () => undefined);

  const closed = new Promise<boolean>((resolve) => {
    const deadline = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 5_000);

    socket.on('close', () => {
      clearTimeout(deadline);
      resolve(true);
    });
  });

  await Promise.all([accepted, once(socket, 'connect')]);

  socket.write(bytes);
  blockLoop();

  const wasClosed = await closed;

  return { received, closed: wasClosed };
}

describe('the receive listener without PROXY protocol, as locally (D111, D187)', () => {
  it('SECURITY REGRESSION - an untrusted peer cannot set the sender address with X-Forwarded-For; the socket address is stored (D111). Do not delete this test.', async () => {
    // The single property the whole boundary exists for. A peer may claim
    // anything it likes in a forwarding header, and none of it is believed:
    // what is recorded is the connection it actually made.
    //
    // If this test is ever in the way, the correct response is to fix the code
    // it caught, not to weaken the assertion. Deleting it removes an automatic
    // check that the backend cannot be told who its sender is by the sender.
    const stored = await injected(UNTRUSTED_PEER, {
      'x-forwarded-for': '9.9.9.9',
      'x-real-ip': '9.9.9.9',
    });

    assert.equal(stored.source_ip, UNTRUSTED_PEER);
  });

  it('SECURITY REGRESSION - a chain forged by an untrusted peer is ignored entirely, not partially (D111). Do not delete this test.', async () => {
    // Several hops, all invented. None of them may survive in any position.
    const stored = await injected(UNTRUSTED_PEER, {
      'x-forwarded-for': `1.1.1.1, 2.2.2.2, ${TRUSTED_PEER}`,
    });

    assert.equal(stored.source_ip, UNTRUSTED_PEER);
    assert.notEqual(stored.source_ip, TRUSTED_PEER);
  });

  it('never believes X-Forwarded-For, even from a peer inside the allow-list: the receive listener trusts no header (D187)', async () => {
    // Until 0.36.0 this peer's right-most untrusted entry was the stored
    // address. On the receive listener every header is the sender's, so the
    // chain is stored as sent and decides nothing.
    const stored = await injected(TRUSTED_PEER, {
      'x-forwarded-for': `1.2.3.4, ${SENDER}`,
      'x-real-ip': SENDER,
      forwarded: `for=${SENDER}`,
    });

    assert.equal(stored.source_ip, TRUSTED_PEER);

    const names = stored.headers.map(([name]) => name);

    assert.ok(names.includes('x-forwarded-for'));
    assert.ok(names.includes('x-real-ip'));
    assert.ok(names.includes('forwarded'));
  });

  it('stores null rather than an invented address when the peer address does not parse', async () => {
    // Nothing a sender writes reaches this value any more; an unreadable
    // address still must not fail the capture (D007).
    const stored = await injected('not-an-address');

    assert.equal(stored.source_ip, null);
  });

  it('answers sourceIp null when the address is unknown, and the socket address otherwise, never a forwarding header (D223)', async () => {
    for (const [peer, expected] of [
      ['not-an-address', null],
      [UNTRUSTED_PEER, UNTRUSTED_PEER],
      ['::ffff:203.0.113.9', '203.0.113.9'],
    ] as const) {
      const sessionId = await newSession();
      const response = await plain.inject({
        method: 'POST',
        url: `/s/${sessionId}`,
        remoteAddress: peer,
        headers: { 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '9.9.9.9' },
        payload: 'x',
      });

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<WebhookDefaultAnswer>().sourceIp, expected, peer);
      assert.equal((await storedCapture(sessionId)).source_ip, expected, peer);
    }
  });
});

describe('the receive listener with PROXY protocol v2 (D111, D187)', () => {
  /** The allow-list names the test's own address: this peer is the proxy. */
  let inside: Listener;
  /** The pod-network allow-list: the test's own address is outside it. */
  let outside: Listener;

  before(async () => {
    inside = await proxied([LOOPBACK]);
    outside = await proxied([TRUSTED_CIDR]);
  });

  after(async () => {
    await Promise.all([inside, outside].map((listener) => listener?.app.close()));
  });

  /** Sends one request behind a PROXY header and reads back what was stored. */
  async function captureBehindProxy(
    headers: [string, string][],
    {
      body = '',
      target,
      source = SENDER,
    }: { body?: string; target?: string; source?: string } = {},
  ): Promise<{ sessionId: string; request: Buffer; stored: StoredCapture; received: string }> {
    const sessionId = await newSession();
    const request = rawRequest(
      target?.replace('<id>', sessionId) ?? `/s/${sessionId}`,
      headers,
      body,
    );
    const answer = await exchange(inside.port, [Buffer.concat([proxyHeader(source), request])]);

    assert.match(answer.received, /^HTTP\/1\.1 200 OK\r\n/, answer.received);

    return {
      sessionId,
      request,
      stored: await storedCapture(sessionId),
      received: answer.received,
    };
  }

  it('SECURITY REGRESSION - a peer outside the trust boundary cannot set the sender address with a PROXY header: the connection is refused and nothing is stored (D111, D187). Do not delete this test.', async () => {
    // A pod beside the backend, or anything else that reaches the receive
    // port without being the proxy, would otherwise choose the stored address.
    const sessionId = await newSession();
    const answer = await exchange(outside.port, [
      Buffer.concat([proxyHeader(SENDER), closingRequest(`/s/${sessionId}`)]),
    ]);

    assert.equal(answer.closed, true);
    assert.equal(answer.received, '', 'a refused connection is written nothing');
    assert.deepEqual(await storedCaptures(sessionId), []);
  });

  it('SECURITY REGRESSION - a sender cannot set its address with X-Forwarded-For or X-Real-Ip, chain or not: the PROXY header decides, and the headers are stored as sent (D111, D187). Do not delete this test.', async () => {
    const headers: [string, string][] = [
      ['Host', 'hook.qa-tools.ru'],
      ['X-Forwarded-For', `1.1.1.1, 2.2.2.2, ${TRUSTED_PEER}`],
      ['X-Real-Ip', '9.9.9.9'],
      ['Forwarded', 'for=203.0.113.11'],
      ['Connection', 'close'],
      ['Content-Length', '0'],
    ];
    const { stored } = await captureBehindProxy(headers);

    assert.equal(stored.source_ip, SENDER);
    assert.deepEqual(stored.headers, headers);
  });

  it('stores the headers exactly as the client wrote them: names, case, order, duplicates, and nothing added (D187)', async () => {
    // A webhook as curl writes it on the wire (#90): `Host` first, then the
    // headers in the order given, `Content-Length` for the body. No
    // `Accept-Encoding`, so none may be stored.
    const body = '{"event":"test.completed"}';
    const headers: [string, string][] = [
      ['Host', 'hook.qa-tools.ru'],
      ['x-zeta-sig', 'abc'],
      ['content-type', 'application/json'],
      ['X_Test_Id', '42'],
      ['aLpHa-MiXeD', 'yes'],
      ['x-dup', 'a'],
      ['X-Dup', 'b'],
      ['User-Agent', 'probe/1.0'],
      ['Connection', 'close'],
      ['Content-Length', String(Buffer.byteLength(body))],
    ];
    const { sessionId, request, stored } = await captureBehindProxy(headers, { body });

    assert.deepEqual(stored.headers, headers);
    assert.equal(
      stored.headers.some(([name]) => name.toLowerCase() === 'accept-encoding'),
      false,
    );
    assert.equal(stored.http_version, '1.1');
    assert.equal(stored.source_ip, SENDER);
    // Raw is the request as it arrived, the PROXY header not part of it.
    assert.equal(stored.raw_request.toString('latin1'), request.toString('latin1'));
    assert.equal(stored.body.toString(), body);

    // And the API serves what was stored.
    const response = await api.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests/${stored.id}`,
    });
    const details = response.json<RequestDetails>();

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(details.headers, headers);
    assert.equal(details.sourceIp, SENDER);
    assert.equal(details.httpVersion, '1.1');
  });

  it('answers the address the PROXY header carried as sourceIp, IPv4 or IPv6, never one a header claims (D187, D223)', async () => {
    const headers: [string, string][] = [
      ['Host', 'hook.qa-tools.ru'],
      ['X-Forwarded-For', '9.9.9.9'],
      ['X-Real-Ip', '9.9.9.9'],
      ['Connection', 'close'],
      ['Content-Length', '0'],
    ];

    for (const [source, expected] of [
      [SENDER, SENDER],
      ['2001:DB8:0:0:0:0:0:7', '2001:db8::7'],
    ]) {
      const { received, stored } = await captureBehindProxy(headers, { source });
      const answer = JSON.parse(
        received.slice(received.indexOf('\r\n\r\n') + 4),
      ) as WebhookDefaultAnswer;

      assert.equal(answer.sourceIp, expected, source);
      assert.equal(stored.source_ip, expected, source);
      assert.equal(answer.requestId, stored.id, source);
    }
  });

  it('stores the path and the query exactly as sent: dot segments, a doubled slash and the escape case kept (D173, D187)', async () => {
    const { sessionId, stored } = await captureBehindProxy(
      [
        ['Host', 'hook.qa-tools.ru'],
        ['Connection', 'close'],
        ['Content-Length', '0'],
      ],
      { target: '/s/<id>/a/../b//c/%7euser?x=1' },
    );

    assert.equal(stored.path, `/s/${sessionId}/a/../b//c/%7euser`);
    assert.equal(stored.query_string, 'x=1');
  });

  it('reads the header split across writes, and the request in the same write as its last byte', async () => {
    const sessionId = await newSession();
    const header = proxyHeader(SENDER);
    const chunks = [
      ...Array.from(header.subarray(0, -1), (byte) => Buffer.from([byte])),
      Buffer.concat([header.subarray(-1), closingRequest(`/s/${sessionId}`)]),
    ];
    const answer = await exchange(inside.port, chunks, 2);

    assert.match(answer.received, /^HTTP\/1\.1 200 OK\r\n/, answer.received);
    assert.equal((await storedCapture(sessionId)).source_ip, SENDER);
  });

  it('gives every request on a kept-alive connection the address of its one header', async () => {
    const sessionId = await newSession();
    const first = rawRequest(
      `/s/${sessionId}`,
      [
        ['Host', 'hook.qa-tools.ru'],
        ['Content-Length', '5'],
      ],
      'first',
    );
    const second = rawRequest(
      `/s/${sessionId}`,
      [
        ['Host', 'hook.qa-tools.ru'],
        ['Connection', 'close'],
        ['Content-Length', '6'],
      ],
      'second',
    );
    const answer = await exchange(
      inside.port,
      [Buffer.concat([proxyHeader(SENDER), first]), second],
      200,
    );

    assert.equal(answer.received.match(/HTTP\/1\.1 200 OK/g)?.length, 2, answer.received);

    const rows = await storedCaptures(sessionId);

    assert.deepEqual(
      rows.map((row) => [row.body.toString(), row.source_ip]),
      [
        ['first', SENDER],
        ['second', SENDER],
      ],
    );
  });

  it('skips TLVs after the addresses, and stores an IPv6 sender in its normal form', async () => {
    const sessionId = await newSession();
    // PP2_TYPE_NOOP, three bytes of nothing.
    const header = proxyHeader('2001:db8:0:0:0:0:0:7', {
      tlv: Buffer.from([0x04, 0x00, 0x03, 0, 0, 0]),
    });
    const answer = await exchange(inside.port, [
      Buffer.concat([header, closingRequest(`/s/${sessionId}`)]),
    ]);

    assert.match(answer.received, /^HTTP\/1\.1 200 OK\r\n/, answer.received);
    assert.equal((await storedCapture(sessionId)).source_ip, '2001:db8::7');
  });

  it('keeps no address for a session created with storeSourceIp false, over IPv4, IPv6 and IPv4-mapped IPv6, in no answer, while a default session keeps it (D243)', async () => {
    const headers: [string, string][] = [
      ['Host', 'hook.qa-tools.ru'],
      ['Connection', 'close'],
      ['Content-Length', '0'],
    ];

    for (const [source, normal] of [
      [SENDER, SENDER],
      ['2001:DB8:0:0:0:0:0:7', '2001:db8::7'],
      [`::ffff:${SENDER}`, SENDER],
    ] as const) {
      for (const storeSourceIp of [false, true]) {
        const created = await api.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ storeSourceIp }),
        });

        assert.equal(created.statusCode, 201, created.body);

        const sessionId = created.json<{ id: string }>().id;

        createdSessionIds.push(sessionId);

        const answer = await exchange(inside.port, [
          Buffer.concat([proxyHeader(source), rawRequest(`/s/${sessionId}`, headers)]),
        ]);
        const label = `${source}, storeSourceIp ${String(storeSourceIp)}`;

        assert.match(answer.received, /^HTTP\/1\.1 200 OK\r\n/, answer.received);

        const stored = await storedCapture(sessionId);
        const answered = JSON.parse(
          answer.received.slice(answer.received.indexOf('\r\n\r\n') + 4),
        ) as WebhookDefaultAnswer;
        const list = await api.inject({
          method: 'GET',
          url: `/api/sessions/${sessionId}/requests`,
        });
        const detail = await api.inject({
          method: 'GET',
          url: `/api/sessions/${sessionId}/requests/${stored.id}`,
        });
        const expected = storeSourceIp ? normal : null;

        assert.equal(stored.source_ip, expected, label);
        assert.equal(answered.sourceIp, expected, label);
        assert.equal(detail.json<RequestDetails>().sourceIp, expected, label);

        for (const text of [answer.received, list.body, detail.body]) {
          // Neither spelling of the address: as the header carried it, nor normalised.
          for (const spelling of [source, normal]) {
            assert.equal(
              text.toLowerCase().includes(spelling.toLowerCase()),
              storeSourceIp && spelling === normal,
              `${label}: ${text}`,
            );
          }
        }
      }
    }
  });

  it('stores an IPv4-mapped sender as plain IPv4', async () => {
    const { stored } = await captureBehindProxy(
      [
        ['Host', 'hook.qa-tools.ru'],
        ['Connection', 'close'],
        ['Content-Length', '0'],
      ],
      { source: `::ffff:${SENDER}` },
    );

    assert.equal(stored.source_ip, SENDER);
  });

  for (const [label, first] of [
    ['a plain HTTP request with no header', Buffer.alloc(0)],
    ['a version 1 header in text', Buffer.from(`PROXY TCP4 ${SENDER} 10.42.0.24 50000 8443\r\n`)],
    ['the LOCAL command, which names no sender,', proxyHeader(SENDER, { command: 0x20 })],
  ] as const) {
    it(`refuses ${label} from a trusted peer, writing nothing and storing nothing`, async () => {
      const sessionId = await newSession();
      const answer = await exchange(inside.port, [
        Buffer.concat([first, closingRequest(`/s/${sessionId}`)]),
      ]);

      assert.equal(answer.closed, true);
      assert.equal(answer.received, '');
      assert.deepEqual(await storedCaptures(sessionId), []);
    });
  }

  it('closes a connection from a trusted peer that sends no complete header within the deadline', async () => {
    const started = Date.now();
    const answer = await exchange(inside.port, [proxyHeader(SENDER).subarray(0, 14)]);

    assert.equal(answer.closed, true);
    assert.equal(answer.received, '');
    assert.ok(Date.now() - started >= HEADER_TIMEOUT_MS - 50, 'closed before the deadline');
  });

  it('answers and stores a webhook whose header was already received when a blocked loop let the deadline pass (#299)', async () => {
    const sessionId = await newSession();
    const answer = await exchangeAfterBlockedLoop(
      inside,
      Buffer.concat([proxyHeader(SENDER), closingRequest(`/s/${sessionId}`)]),
    );

    assert.equal(answer.closed, true);
    assert.match(answer.received, /^HTTP\/1\.1 200 OK\r\n/, 'refused with nothing written');
    assert.equal((await storedCapture(sessionId)).source_ip, SENDER);
  });

  it('still refuses a trusted peer with no complete header when a blocked loop let the deadline pass, and logs it with the peer (#299)', async () => {
    const sessionId = await newSession();
    const logged = inside.log().length;
    const answer = await exchangeAfterBlockedLoop(inside, proxyHeader(SENDER).subarray(0, 14));

    assert.equal(answer.closed, true);
    assert.equal(answer.received, '');
    assert.deepEqual(await storedCaptures(sessionId), []);

    const lines = inside.log().slice(logged);
    const refusals = lines
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(({ msg }) => msg === 'Receive connection refused: no valid PROXY protocol header');

    assert.deepEqual(
      refusals.map(({ peer, reason }) => ({ peer, reason })),
      [{ peer: LOOPBACK, reason: `no complete header within ${HEADER_TIMEOUT_MS} ms` }],
      lines,
    );
    assert.equal(lines.includes(SENDER), false);
  });

  it('answers `/s/` and its robots.txt only: the site and the API are not on the receive host, and every answer is protected (D187)', async () => {
    const robots = await exchange(inside.port, [
      Buffer.concat([
        proxyHeader(SENDER),
        Buffer.from(
          'GET /robots.txt HTTP/1.1\r\nHost: hook.qa-tools.ru\r\nConnection: close\r\n\r\n',
        ),
      ]),
    ]);

    assert.match(robots.received, /^HTTP\/1\.1 200 OK\r\n/);
    assert.match(robots.received, /\r\ncontent-type: text\/plain; charset=utf-8\r\n/i);
    assert.ok(robots.received.endsWith('\r\n\r\nUser-agent: *\nDisallow: /\n'), robots.received);

    const answers: string[] = [];

    for (const target of ['/', '/api/sessions']) {
      const answer = await exchange(inside.port, [
        Buffer.concat([
          proxyHeader(SENDER),
          Buffer.from(
            `GET ${target} HTTP/1.1\r\nHost: hook.qa-tools.ru\r\nConnection: close\r\n\r\n`,
          ),
        ]),
      ]);

      answers.push(answer.received);
      assert.match(answer.received, /^HTTP\/1\.1 404 Not Found\r\n/, target);
      assert.match(answer.received, /\{"errorCode":1000,"message":"Not found"\}$/, target);
    }

    // The whole host is a receive URL, so its 404s and its robots.txt carry
    // nosniff and the sandbox policy too.
    for (const received of [robots.received, ...answers]) {
      assert.match(received, /\r\nx-content-type-options: nosniff\r\n/i);
      assert.match(received, /\r\ncontent-security-policy: sandbox; default-src 'none'\r\n/i);
    }
  });

  it('logs the socket peer and never the address the PROXY header carried (D117)', async () => {
    const before = inside.log().length;

    await captureBehindProxy([
      ['Host', 'hook.qa-tools.ru'],
      ['Connection', 'close'],
      ['Content-Length', '0'],
    ]);

    const lines = inside.log().slice(before);

    // The sender's address is what the capture stored, and it is exactly what
    // must not be in the log: logs are read through Lens, pasted into issues
    // and screenshotted, and they outlive the session TTL.
    assert.equal(lines.includes(SENDER), false, 'the PROXY source reached the log');
    // Not nothing, either: "which peer is talking to me" is a question a
    // server log may legitimately answer (D117).
    assert.equal(lines.includes(`"remoteAddress":"${LOOPBACK}"`), true, lines);
  });

  it('logs a refusal with the peer and the reason, never the address the header claimed', async () => {
    // A listener of its own: its refusals are logged as a count, the first at
    // once and the rest a minute later, and `outside`'s first is the SECURITY
    // REGRESSION test's.
    const own = await proxied([TRUSTED_CIDR]);

    try {
      const answer = await exchange(own.port, [proxyHeader(SENDER)]);

      assert.equal(answer.closed, true);

      const lines = own.log();

      assert.match(lines, /"msg":"Receive connections refused: peer outside the trust boundary"/);
      assert.equal(lines.includes(`"refused":1`), true, lines);
      assert.equal(lines.includes(`"peer":"${LOOPBACK}"`), true, lines);
      assert.equal(lines.includes(SENDER), false);
    } finally {
      await own.app.close();
    }
  });
});

describe('the application listener records the socket peer in its log, not the proxy-derived client (D117)', () => {
  /** Collects everything the server writes, after D059 redaction. */
  function captureLog(): { stream: Writable; lines: () => string } {
    let output = '';

    return {
      stream: new Writable({
        write(chunk: Buffer | string, _encoding, callback) {
          output += chunk.toString();
          callback();
        },
      }),
      lines: () => output,
    };
  }

  it('logs the peer address and never the address X-Forwarded-For supplied', async () => {
    const log = captureLog();
    const app = buildServer(pool, {
      logDestination: log.stream,
      trustedProxyCidrs: [TRUSTED_CIDR],
    });

    try {
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        remoteAddress: TRUSTED_PEER,
        headers: { 'x-forwarded-for': SENDER },
      });

      assert.equal(response.statusCode, 201, response.body);
      createdSessionIds.push(response.json<{ id: string }>().id);

      // Behind the trusted proxy `request.ip` is the visitor's own address,
      // and it is exactly what must not be in the log.
      assert.equal(
        log.lines().includes(SENDER),
        false,
        'the proxy-derived address reached the log',
      );
      assert.equal(
        log.lines().includes(`"remoteAddress":"${TRUSTED_PEER}"`),
        true,
        'the socket peer address is missing from the log',
      );
    } finally {
      await app.close();
    }
  });

  it('keeps the same field for a server with no trust boundary configured', async () => {
    const log = captureLog();
    const app = buildServer(pool, { logDestination: log.stream });

    try {
      await app.ready();
      // Any route that logs its requests at `info`: the probes log at `warn`
      // and above only, since readiness is asked every 2 s (D221).
      await app.inject({ method: 'GET', url: '/no-such-route', remoteAddress: UNTRUSTED_PEER });

      assert.equal(log.lines().includes(`"remoteAddress":"${UNTRUSTED_PEER}"`), true);
    } finally {
      await app.close();
    }
  });
});
