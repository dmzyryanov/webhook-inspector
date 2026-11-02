/**
 * The PROXY protocol v2 header and the layer that reads it (D187), and the
 * connections it lets one sender address hold (D227).
 *
 * Needs no database and no listener: the parser is pure, and the layer is
 * driven through a stand-in server and stand-in sockets. The end-to-end
 * behaviour over real sockets, with a capture stored, is in
 * `trust-boundary.test.ts` and `receive-connections.test.ts`.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, it, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import proxyAddr from '@fastify/proxy-addr';
import type { FastifyBaseLogger } from 'fastify';
import ipaddr from 'ipaddr.js';
import { MAX_RECEIVE_CONNECTIONS_PER_ADDRESS } from '@webhook-inspector/shared';
import {
  acceptProxyProtocol,
  MAX_PROXY_HEADER_BYTES,
  parseProxyV2Header,
  PROXY_V2_SIGNATURE,
  REFUSAL_LOG_INTERVAL_MS,
} from './proxy-protocol.ts';

/** A TCP-over-IPv4 header from 198.51.100.7:50000 to 10.42.0.24:8443, as Step 0 saw one. */
function ipv4Header(extra: number[] = []): Buffer {
  return Buffer.from([
    ...PROXY_V2_SIGNATURE,
    0x21,
    0x11,
    0x00,
    12 + extra.length,
    198,
    51,
    100,
    7,
    10,
    42,
    0,
    24,
    0xc3,
    0x50,
    0x20,
    0xfb,
    ...extra,
  ]);
}

function ipv6Header(): Buffer {
  const source = [0x20, 0x01, 0x0d, 0xb8, ...Array<number>(11).fill(0), 0x07];
  const destination = [...Array<number>(15).fill(0), 0x01];

  return Buffer.from([
    ...PROXY_V2_SIGNATURE,
    0x21,
    0x21,
    0x00,
    36,
    ...source,
    ...destination,
    0xc3,
    0x50,
    0x20,
    0xfb,
  ]);
}

describe('parseProxyV2Header (D187)', () => {
  it('reads the sender address and the header length of TCP over IPv4 and IPv6', () => {
    assert.deepEqual(parseProxyV2Header(ipv4Header()), {
      kind: 'proxy',
      source: '198.51.100.7',
      length: 28,
    });
    assert.deepEqual(parseProxyV2Header(ipv6Header()), {
      kind: 'proxy',
      source: '2001:db8::7',
      length: 52,
    });
  });

  it('ignores what follows the header, and skips TLVs inside its length', () => {
    const header = ipv4Header([0x04, 0x00, 0x01, 0x00]);
    const parsed = parseProxyV2Header(
      Buffer.concat([header, Buffer.from('POST /s/x HTTP/1.1\r\n')]),
    );

    assert.deepEqual(parsed, { kind: 'proxy', source: '198.51.100.7', length: 32 });
  });

  it('asks for more at every length short of the whole header, and never refuses a prefix of a valid one', () => {
    const header = ipv4Header();

    for (let length = 0; length < header.length; length += 1) {
      assert.deepEqual(
        parseProxyV2Header(header.subarray(0, length)),
        { kind: 'incomplete' },
        `${length}`,
      );
    }
  });

  it('refuses at the first byte that disagrees with the signature', () => {
    for (const text of [
      'P',
      'POST /s/x HTTP/1.1\r\n',
      'PROXY TCP4 198.51.100.7 10.42.0.24 1 2\r\n',
      '\r\n\r\n\x01',
    ]) {
      assert.deepEqual(parseProxyV2Header(Buffer.from(text, 'latin1')), {
        kind: 'invalid',
        reason: 'not a PROXY protocol v2 header',
      });
    }
  });

  it('recognises LOCAL, and refuses another version or command', () => {
    const local = Buffer.from([...PROXY_V2_SIGNATURE, 0x20, 0x00, 0x00, 0x00]);

    assert.deepEqual(parseProxyV2Header(local), { kind: 'local' });
    assert.deepEqual(parseProxyV2Header(local.subarray(0, 14)), { kind: 'incomplete' });

    for (const versionCommand of [0x11, 0x22, 0x31, 0x2f]) {
      const header = ipv4Header();

      header[12] = versionCommand;
      assert.equal(parseProxyV2Header(header).kind, 'invalid', versionCommand.toString(16));
    }
  });

  it('refuses every family but TCP over IPv4 and IPv6', () => {
    // UNSPEC, UDP over IPv4, UDP over IPv6, UNIX stream, UNIX datagram.
    for (const family of [0x00, 0x12, 0x22, 0x31, 0x32]) {
      const header = ipv4Header();

      header[13] = family;
      assert.deepEqual(
        parseProxyV2Header(header),
        { kind: 'invalid', reason: 'not TCP over IPv4 or IPv6' },
        family.toString(16),
      );
    }
  });

  it('refuses a length shorter than the addresses, or a header longer than the cap', () => {
    const short = ipv4Header();

    short.writeUInt16BE(11, 14);
    assert.equal(parseProxyV2Header(short).kind, 'invalid');

    const long = ipv4Header();

    long.writeUInt16BE(MAX_PROXY_HEADER_BYTES - 16 + 1, 14);
    assert.equal(parseProxyV2Header(long).kind, 'invalid');

    // The longest accepted, all of it TLV bytes.
    const longest = ipv4Header(Array<number>(MAX_PROXY_HEADER_BYTES - 28).fill(0));

    assert.equal(parseProxyV2Header(longest).kind, 'proxy');
  });
});

/**
 * A socket as far as the layer uses one: a stream with a peer address, whose
 * reset is recorded and destroys it as a socket's does. `resetFails` makes
 * the reset emit an `error` as Node's does when it fails: at once, from
 * `_destroy`, when the handle's reset fails, or on the next tick for a
 * handle already gone. `emitClose: false` keeps its `close` from being emitted
 * on the next tick when it is destroyed: a real socket's comes only in the
 * event loop's close phase, after the check phase's immediates (#299).
 */
function fakeSocket(
  remoteAddress: string | undefined,
  {
    resetFails,
    emitClose = true,
  }: { resetFails?: 'at once' | 'on the next tick'; emitClose?: boolean } = {},
): Socket {
  const stream = new PassThrough({ emitClose });

  return Object.assign(stream, {
    remoteAddress,
    reset: false,
    resetAndDestroy() {
      Object.assign(stream, { reset: true });
      stream.destroy();

      const failure = Object.assign(new Error('reset EINVAL'), { code: 'EINVAL' });

      if (resetFails === 'at once') {
        stream.emit('error', failure);
      } else if (resetFails === 'on the next tick') {
        process.nextTick(() => stream.emit('error', failure));
      }

      return stream;
    },
  }) as unknown as Socket;
}

/** Whether the layer reset `socket` rather than merely closing it. */
const wasReset = (socket: Socket): boolean => (socket as unknown as { reset: boolean }).reset;

interface Logged {
  warnings: Record<string, unknown>[];
  log: FastifyBaseLogger;
}

function recordingLog(): Logged {
  const warnings: Record<string, unknown>[] = [];
  const log = {
    warn: (fields: Record<string, unknown>, message: string) => {
      warnings.push({ ...fields, message });
    },
  } as unknown as FastifyBaseLogger;

  return { warnings, log };
}

/** A server with one `connection` listener, as Node's HTTP server has, recording what reaches it. */
function fakeServer(): { server: Server; handed: { socket: Socket; first: Buffer }[] } {
  const server = new EventEmitter() as unknown as Server;
  const handed: { socket: Socket; first: Buffer }[] = [];

  server.on('connection', (socket: Socket) => {
    const entry = { socket, first: Buffer.alloc(0) };

    handed.push(entry);
    // As Node's own handler does: an error on a connection it holds is its
    // business, not an uncaught exception.
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      entry.first = Buffer.concat([entry.first, chunk]);
    });
  });

  return { server, handed };
}

const trusted = proxyAddr.compile(['10.42.0.0/24']);
const isTrustedPeer = (address: string): boolean => trusted(address, 0);

describe('acceptProxyProtocol (D187)', () => {
  it("hands a trusted peer's connection to the server with the bytes after the header, and remembers the sender", async () => {
    const { server, handed } = fakeServer();
    const { log } = recordingLog();
    const layer = acceptProxyProtocol(server, { isTrustedPeer, log });
    // What Step 0 saw: the Traefik pod as an IPv4-mapped IPv6 address.
    const socket = fakeSocket('::ffff:10.42.0.24');

    server.emit('connection', socket);
    socket.write(Buffer.concat([ipv4Header(), Buffer.from('POST /s/x HTTP/1.1\r\n')]));
    await delay(10);

    assert.equal(handed.length, 1);
    assert.equal(handed[0]?.first.toString(), 'POST /s/x HTTP/1.1\r\n');
    assert.equal(layer.sourceOf(socket), '198.51.100.7');
  });

  it('refuses a peer outside the boundary before reading a byte, and logs the refusals as a count at most once a minute, with the latest peer', () => {
    mock.timers.enable({ apis: ['setTimeout'] });

    try {
      const { server, handed } = fakeServer();
      const { warnings, log } = recordingLog();
      const layer = acceptProxyProtocol(server, { isTrustedPeer, log });
      const message = 'Receive connections refused: peer outside the trust boundary';

      // Outside the /24, and unknown: a connection reset before Node read its
      // address.
      for (const peer of ['127.0.0.1', '10.42.1.5', undefined]) {
        const socket = fakeSocket(peer);

        server.emit('connection', socket);
        assert.equal(socket.destroyed, true, String(peer));
        // Never read: no listener of the layer's is left on it.
        assert.equal(socket.listenerCount('data'), 0, String(peer));
        assert.equal(layer.sourceOf(socket), undefined, String(peer));
      }

      assert.equal(handed.length, 0);
      // The first at once; the two after it once the minute has passed, the
      // latest of them unknown, so that line names no peer.
      assert.deepEqual(warnings, [{ refused: 1, peer: '127.0.0.1', message }]);
      mock.timers.tick(REFUSAL_LOG_INTERVAL_MS - 1);
      assert.equal(warnings.length, 1);
      mock.timers.tick(1);
      assert.deepEqual(warnings, [
        { refused: 1, peer: '127.0.0.1', message },
        { refused: 2, message },
      ]);
      // A quiet minute writes nothing, and the next refusal is logged at once,
      // naming its own peer and none kept from before.
      mock.timers.tick(REFUSAL_LOG_INTERVAL_MS);
      assert.equal(warnings.length, 2);
      server.emit('connection', fakeSocket('::1'));
      assert.deepEqual(warnings[2], { refused: 1, peer: '::1', message });
      // Not a refusal over a sender's bound: those are counted apart (D227).
      assert.equal(layer.refused, 0);
    } finally {
      mock.timers.reset();
    }
  });

  it('writes two lines for a flood of refused peers within a minute, at 2, 2,000 and 20,000 connections', () => {
    mock.timers.enable({ apis: ['setTimeout'] });

    try {
      for (const connections of [2, 2_000, 20_000]) {
        const { server, handed } = fakeServer();
        const { warnings, log } = recordingLog();

        acceptProxyProtocol(server, { isTrustedPeer, log });

        // Peers outside the /24 of both families, and unknown ones, mixed.
        let destroyed = 0;

        for (let index = 0; index < connections; index += 1) {
          const peer =
            index % 3 === 0
              ? undefined
              : index % 3 === 1
                ? `10.42.${1 + (index >> 8)}.${index & 0xff}`
                : `2001:db8::${index.toString(16)}`;
          const socket = fakeSocket(index === connections - 1 ? '192.0.2.1' : peer);

          server.emit('connection', socket);
          destroyed += socket.destroyed ? 1 : 0;
        }

        assert.equal(destroyed, connections, `${connections}`);
        assert.equal(handed.length, 0, `${connections}`);
        assert.equal(warnings.length, 1, `${connections}`);
        mock.timers.tick(REFUSAL_LOG_INTERVAL_MS);
        assert.deepEqual(
          warnings.map(({ refused, peer }) => ({ refused, peer })),
          [
            { refused: 1, peer: undefined },
            { refused: connections - 1, peer: '192.0.2.1' },
          ],
          `${connections}`,
        );
        // And nothing more however long it stays quiet.
        mock.timers.tick(REFUSAL_LOG_INTERVAL_MS * 3);
        assert.equal(warnings.length, 2, `${connections}`);
      }
    } finally {
      mock.timers.reset();
    }
  });

  it('refuses an invalid header and logs why, without the bytes it carried', async () => {
    const { server, handed } = fakeServer();
    const { warnings, log } = recordingLog();
    const layer = acceptProxyProtocol(server, { isTrustedPeer, log });
    const socket = fakeSocket('10.42.0.24');

    server.emit('connection', socket);
    socket.write(Buffer.from('PROXY TCP4 198.51.100.7 10.42.0.24 50000 8443\r\n'));
    await delay(10);

    assert.equal(socket.destroyed, true);
    assert.equal(wasReset(socket), false);
    assert.equal(handed.length, 0);
    assert.equal(layer.sourceOf(socket), undefined);
    assert.deepEqual(warnings, [
      {
        peer: '10.42.0.24',
        reason: 'not a PROXY protocol v2 header',
        message: 'Receive connection refused: no valid PROXY protocol header',
      },
    ]);
    assert.equal(JSON.stringify(warnings).includes('198.51.100.7'), false);
  });

  it('closes a connection whose header does not arrive within the deadline', async () => {
    const { server, handed } = fakeServer();
    const { warnings, log } = recordingLog();

    acceptProxyProtocol(server, { isTrustedPeer, log, timeoutMs: 50 });

    const socket = fakeSocket('10.42.0.24');

    server.emit('connection', socket);
    socket.write(ipv4Header().subarray(0, 10));
    await delay(120);

    assert.equal(socket.destroyed, true);
    assert.equal(handed.length, 0);
    assert.equal(warnings[0]?.reason, 'no complete header within 50 ms');
  });

  it('destroys the connections still waiting for a header when asked to close', () => {
    const { server } = fakeServer();
    const { log } = recordingLog();
    const layer = acceptProxyProtocol(server, { isTrustedPeer, log });
    const socket = fakeSocket('10.42.0.24');

    server.emit('connection', socket);
    layer.closePending();

    assert.equal(socket.destroyed, true);
  });

  it('refuses to start on a server with no connection listener to put itself in front of', () => {
    const { log } = recordingLog();

    assert.throws(
      () => acceptProxyProtocol(new EventEmitter() as unknown as Server, { isTrustedPeer, log }),
      /no connection listener/,
    );
  });
});

describe('the header deadline on a busy event loop (#299)', () => {
  const timeoutMs = 50;
  const message = 'Receive connection refused: no valid PROXY protocol header';

  /**
   * Resolves in the check phase, after the layer's re-check: an immediate
   * scheduled once the deadline's timer has fired runs after it. Only
   * `setTimeout` is mocked, so the layer's `setImmediate` is the real one.
   */
  const afterRecheck = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  /** A layer whose deadline's timer has just fired, with one connection waiting. */
  function firedDeadline(socket = fakeSocket('10.42.0.24')) {
    const { server, handed } = fakeServer();
    const { warnings, log } = recordingLog();
    const layer = acceptProxyProtocol(server, { isTrustedPeer, log, timeoutMs });

    server.emit('connection', socket);
    mock.timers.tick(timeoutMs - 1);
    assert.equal(socket.destroyed, false);
    mock.timers.tick(1);
    // Fired, and nothing refused yet: what the poll phase reads before the
    // re-check still counts.
    assert.equal(socket.destroyed, false);
    assert.deepEqual(warnings, []);

    return { layer, socket, handed, warnings };
  }

  it('hands over a header delivered after the deadline fired and before the re-check, with its sender', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });

    try {
      const { layer, socket, handed, warnings } = firedDeadline();

      socket.write(Buffer.concat([ipv4Header(), Buffer.from('POST /s/x HTTP/1.1\r\n')]));
      await afterRecheck();

      assert.equal(socket.destroyed, false);
      assert.deepEqual(warnings, []);
      assert.equal(handed.length, 1);
      assert.equal(handed[0]?.first.toString(), 'POST /s/x HTTP/1.1\r\n');
      assert.equal(layer.sourceOf(socket), '198.51.100.7');
    } finally {
      mock.timers.reset();
    }
  });

  it('refuses at the re-check a connection with no complete header by then, with the same reason', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });

    try {
      const socket = fakeSocket('10.42.0.24');

      socket.write(ipv4Header().subarray(0, 10));

      const { layer, handed, warnings } = firedDeadline(socket);

      await afterRecheck();

      assert.equal(socket.destroyed, true);
      assert.equal(handed.length, 0);
      assert.equal(layer.sourceOf(socket), undefined);
      assert.deepEqual(warnings, [
        { peer: '10.42.0.24', reason: `no complete header within ${timeoutMs} ms`, message },
      ]);
    } finally {
      mock.timers.reset();
    }
  });

  it('neither refuses nor logs a connection closed, reset or closed for shutdown between the two', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });

    try {
      const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

      for (const [label, end] of [
        ['closed', (socket: Socket) => socket.destroy()],
        ['reset', (socket: Socket) => socket.destroy(reset)],
      ] as const) {
        const { socket, handed, warnings } = firedDeadline();

        end(socket);
        await afterRecheck();

        assert.equal(handed.length, 0, label);
        assert.deepEqual(warnings, [], label);
      }

      // Destroyed by closePending(), its `close` still to come when the
      // re-check runs, as a real socket's is.
      const { layer, socket, handed, warnings } = firedDeadline(
        fakeSocket('10.42.0.24', { emitClose: false }),
      );

      layer.closePending();
      await afterRecheck();

      assert.equal(socket.destroyed, true);
      assert.equal(handed.length, 0);
      assert.deepEqual(warnings, []);
    } finally {
      mock.timers.reset();
    }
  });
});

/** A TCP header from `source`, IPv4 or IPv6 in any spelling, as Traefik writes one. */
function headerFrom(source: string): Buffer {
  const ports = [0xc3, 0x50, 0x20, 0xfb];

  if (!source.includes(':')) {
    return Buffer.from([
      ...PROXY_V2_SIGNATURE,
      0x21,
      0x11,
      0x00,
      12,
      ...source.split('.').map(Number),
      10,
      42,
      0,
      24,
      ...ports,
    ]);
  }

  return Buffer.from([
    ...PROXY_V2_SIGNATURE,
    0x21,
    0x21,
    0x00,
    36,
    ...ipaddr.IPv6.parse(source).toByteArray(),
    ...ipaddr.IPv6.parse('::1').toByteArray(),
    ...ports,
  ]);
}

/** The layer with `connectionsPerAddress`, on a stand-in server, and how to connect to it. */
function boundLayer(connectionsPerAddress?: number) {
  const { server, handed } = fakeServer();
  const { warnings, log } = recordingLog();
  const layer = acceptProxyProtocol(server, {
    isTrustedPeer,
    log,
    ...(connectionsPerAddress === undefined ? {} : { connectionsPerAddress }),
  });

  /**
   * A connection from the proxy that writes `bytes` of the header naming
   * `source`, all of it by default, then a request line; answers its socket,
   * a stand-in from the proxy's address unless one is given.
   */
  const connect = (source: string, bytes?: number, socket = fakeSocket('10.42.0.24')): Socket => {
    const header = headerFrom(source);

    server.emit('connection', socket);
    socket.write(
      bytes === undefined
        ? Buffer.concat([header, Buffer.from('GET / HTTP/1.1\r\n')])
        : header.subarray(0, bytes),
    );

    return socket;
  };

  /** A connection from `peer`, outside the trust boundary or unknown, which is refused at once. */
  const knock = (peer: string | undefined): Socket => {
    const socket = fakeSocket(peer);

    server.emit('connection', socket);

    return socket;
  };

  return { layer, handed, warnings, connect, knock };
}

/**
 * Lets the stand-in sockets deliver what was written to them, and emit their
 * `close`: both happen on the next ticks. Not a timer, which a test mocks.
 */
const settled = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe('the connections one sender address may hold (D227)', () => {
  it('lets 512 through by default, and destroys the 513th right after its header, handing it to nobody', async () => {
    const { layer, handed, connect } = boundLayer();
    const held = Array.from({ length: MAX_RECEIVE_CONNECTIONS_PER_ADDRESS }, () =>
      connect('198.51.100.7'),
    );

    await settled();
    assert.equal(handed.length, 512);
    assert.equal(layer.connections?.takenBy('198.51.100.7'), 512);

    const over = connect('198.51.100.7');

    await settled();
    assert.equal(over.destroyed, true);
    // Reset, so that the proxy fails its first write to it (D227).
    assert.equal(wasReset(over), true);
    assert.equal(handed.length, 512);
    assert.equal(layer.sourceOf(over), undefined);
    assert.equal(layer.refused, 1);
    assert.equal(
      held.every((socket) => !socket.destroyed),
      true,
    );
  });

  it('keeps an error listener on a socket it refuses over the bound, whose reset may fail with an error', async () => {
    for (const resetFails of ['at once', 'on the next tick'] as const) {
      const { layer, handed, connect } = boundLayer(1);

      connect('198.51.100.7');

      const over = connect('198.51.100.7', undefined, fakeSocket('10.42.0.24', { resetFails }));

      // Without a listener the error would be thrown, failing this test.
      await settled();
      assert.equal(over.destroyed, true, resetFails);
      assert.equal(wasReset(over), true, resetFails);
      assert.equal(over.listenerCount('error') > 0, true, resetFails);
      assert.equal(handed.length, 1, resetFails);
      assert.equal(layer.refused, 1, resetFails);
    }
  });

  it('gives a place back when a connection closes, however it closes, and the next is let through', async () => {
    const { layer, handed, connect } = boundLayer(3);
    const held = ['198.51.100.7', '198.51.100.7', '198.51.100.7'].map((source) => connect(source));

    await settled();
    assert.equal(layer.connections?.takenBy('198.51.100.7'), 3);

    // Closed, by either side.
    held[0]?.destroy();
    await settled();
    assert.equal(layer.connections?.takenBy('198.51.100.7'), 2);

    // Reset: an error, then the close.
    held[1]?.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await settled();
    assert.equal(layer.connections?.takenBy('198.51.100.7'), 1);

    // Two more are let through, and the third of them is not.
    const next = ['198.51.100.7', '198.51.100.7', '198.51.100.7'].map((source) => connect(source));

    await settled();
    assert.deepEqual(
      next.map((socket) => socket.destroyed),
      [false, false, true],
    );
    assert.equal(handed.length, 5);

    // Every one closed: the address is not kept.
    for (const socket of [...held, ...next]) {
      socket.destroy();
    }

    await settled();
    assert.equal(layer.connections?.taken, 0);
    assert.equal(layer.connections?.keys, 0);
  });

  it('counts each address apart: another address is unaffected', async () => {
    const { layer, connect } = boundLayer(2);

    connect('198.51.100.7');
    connect('198.51.100.7');

    const over = connect('198.51.100.7');
    const other = connect('198.51.100.8');

    await settled();
    assert.equal(over.destroyed, true);
    assert.equal(other.destroyed, false);
    assert.equal(layer.connections?.takenBy('198.51.100.8'), 1);
  });

  it('counts two IPv6 addresses of one /64 together, and an IPv4-mapped one as its IPv4', async () => {
    const { layer, connect } = boundLayer(2);

    connect('2001:db8:0:1::1');
    connect('2001:db8:0:1:ffff:ffff:ffff:ffff');

    const sameBlock = connect('2001:DB8:0:1::abcd');
    const otherBlock = connect('2001:db8:0:2::1');

    connect('::ffff:198.51.100.7');
    connect('198.51.100.7');

    const mapped = connect('::ffff:c633:6407');

    await settled();
    assert.equal(sameBlock.destroyed, true);
    assert.equal(otherBlock.destroyed, false);
    assert.equal(layer.connections?.takenBy('2001:db8:0:1::/64'), 2);
    assert.equal(mapped.destroyed, true);
    assert.equal(layer.connections?.takenBy('198.51.100.7'), 2);
  });

  it('counts nothing with the bound turned off: 0', async () => {
    const { layer, handed, connect } = boundLayer(0);

    for (let index = 0; index < 600; index += 1) {
      connect('198.51.100.7');
    }

    await settled();
    assert.equal(layer.connections, null);
    assert.equal(handed.length, 600);
    assert.equal(layer.refused, 0);
  });

  it('takes a place only once the whole header has been read: none for one still arriving, or left halfway', async () => {
    const { layer, handed, connect } = boundLayer(1);
    const arriving = connect('198.51.100.7', 20);

    await settled();
    assert.equal(arriving.destroyed, false);
    assert.equal(layer.connections?.taken, 0);

    arriving.destroy();
    await settled();
    assert.equal(layer.connections?.taken, 0);

    const whole = connect('198.51.100.7');

    await settled();
    assert.equal(whole.destroyed, false);
    assert.equal(handed.length, 1);
    assert.equal(layer.connections?.takenBy('198.51.100.7'), 1);
  });

  it('logs the refusals as a count at most once a minute, and never an address', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });

    try {
      const { warnings, connect } = boundLayer(1);

      connect('198.51.100.7');
      connect('203.0.113.9');
      await settled();

      for (let index = 0; index < 5; index += 1) {
        connect('198.51.100.7');
        connect('203.0.113.9');
      }

      await settled();

      const refusals = () =>
        warnings.filter((warning) => String(warning.message).includes('every connection place'));

      // The first at once; the nine after it once the minute has passed.
      assert.deepEqual(
        refusals().map((warning) => warning.refused),
        [1],
      );
      mock.timers.tick(REFUSAL_LOG_INTERVAL_MS);
      assert.deepEqual(
        refusals().map((warning) => warning.refused),
        [1, 9],
      );
      // A quiet minute writes nothing, and the next refusal is logged at once.
      mock.timers.tick(REFUSAL_LOG_INTERVAL_MS);
      assert.equal(refusals().length, 2);
      connect('198.51.100.7');
      await settled();
      assert.deepEqual(
        refusals().map((warning) => warning.refused),
        [1, 9, 1],
      );

      const written = JSON.stringify(warnings);

      assert.equal(written.includes('198.51.100.7'), false);
      assert.equal(written.includes('203.0.113.9'), false);
      assert.deepEqual(refusals()[0], {
        refused: 1,
        connectionsPerAddress: 1,
        message:
          'Receive connections refused: their sender address had every connection place taken',
      });
    } finally {
      mock.timers.reset();
    }
  });

  it('counts the refusals over the bound apart from those of a peer outside the boundary, neither line delaying or counting the other', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });

    try {
      const { layer, handed, warnings, connect, knock } = boundLayer(1);
      const kind = (warning: Record<string, unknown>): string =>
        String(warning.message).includes('every connection place') ? 'bound' : 'boundary';
      const lines = () => warnings.map((warning) => `${kind(warning)} ${String(warning.refused)}`);

      connect('198.51.100.7');
      await settled();

      // One of each, the boundary's first: each is logged at once, the
      // second not held back by the first's minute.
      knock('127.0.0.1');
      connect('198.51.100.7');
      await settled();
      assert.deepEqual(lines(), ['boundary 1', 'bound 1']);

      // Then three more of each kind, interleaved, and a fourth outside peer.
      for (let index = 0; index < 3; index += 1) {
        connect('198.51.100.7');
        knock(index === 1 ? undefined : `192.0.2.${index}`);
      }

      knock('10.42.1.5');
      await settled();
      assert.deepEqual(lines(), ['boundary 1', 'bound 1']);
      mock.timers.tick(REFUSAL_LOG_INTERVAL_MS);
      assert.deepEqual(lines(), ['boundary 1', 'bound 1', 'boundary 4', 'bound 3']);
      assert.deepEqual(warnings[3], {
        refused: 3,
        connectionsPerAddress: 1,
        message:
          'Receive connections refused: their sender address had every connection place taken',
      });
      assert.equal(warnings[2]?.peer, '10.42.1.5');
      // `refused` counts the refusals over the bound alone (D227).
      assert.equal(layer.refused, 4);
      assert.equal(handed.length, 1);

      // A quiet minute for both; then a refusal over the bound alone is
      // logged at once, and the boundary's line stays silent.
      mock.timers.tick(REFUSAL_LOG_INTERVAL_MS);
      connect('198.51.100.7');
      await settled();
      mock.timers.tick(REFUSAL_LOG_INTERVAL_MS);
      assert.deepEqual(lines().slice(4), ['bound 1']);

      // No sender's address in any line, the PROXY header's above all.
      assert.equal(JSON.stringify(warnings).includes('198.51.100.7'), false);
    } finally {
      mock.timers.reset();
    }
  });

  it('keeps no address once its connections have closed, at 100, 1,000 and 10,000 senders', async () => {
    for (const senders of [100, 1_000, 10_000]) {
      const { layer, connect } = boundLayer();
      const held = Array.from({ length: senders }, (_, index) =>
        connect(`2001:db8:${(index >> 16).toString(16)}:${(index & 0xffff).toString(16)}::1`),
      );

      await settled();
      assert.equal(layer.connections?.keys, senders, `${senders}`);

      for (const socket of held) {
        socket.destroy();
      }

      await settled();
      assert.equal(layer.connections?.keys, 0, `${senders}`);
      assert.equal(layer.connections?.taken, 0, `${senders}`);
    }
  });

  it('holds one /64 to its bound however many addresses inside it connect, at 600, 6,000 and 30,000 rotations', async () => {
    for (const rotations of [600, 6_000, 30_000]) {
      const { layer, handed, connect } = boundLayer();

      for (let index = 0; index < rotations; index += 1) {
        connect(`2001:db8:0:1:${(index >> 16).toString(16)}:${(index & 0xffff).toString(16)}::1`);

        // A thousand at a time, so that the refused ones are let go.
        if (index % 1_000 === 999) {
          await settled();
        }
      }

      await settled();
      assert.equal(handed.length, 512, `${rotations}`);
      assert.equal(layer.connections?.keys, 1, `${rotations}`);
      assert.equal(layer.refused, rotations - 512, `${rotations}`);
    }
  });
});
