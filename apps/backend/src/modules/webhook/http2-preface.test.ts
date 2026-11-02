/**
 * The HTTP/2 preface and the layer that reads it (D263).
 *
 * Needs no database and no listener: the reading is pure, and the layer is
 * driven through a stand-in server and stand-in sockets. The end-to-end
 * behaviour over real sockets, PROXY protocol on and off, is in
 * `receiver-http2.test.ts`.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { METHODS, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import { random } from '../../testing/pipelines.ts';
import {
  acceptHttp2Preface,
  DEFAULT_PREFACE_TIMEOUT_MS,
  HTTP1_SHARED_PREFIX_BYTES,
  HTTP2_PREFACE,
  readPreface,
} from './http2-preface.ts';

describe('readPreface (D263)', () => {
  it('is the 24 bytes of RFC 9113', () => {
    assert.equal(HTTP2_PREFACE.toString('latin1'), 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
    assert.equal(HTTP2_PREFACE.length, 24);
  });

  it('asks for more at every length short of the preface, and takes the preface with whatever follows it', () => {
    for (let length = 0; length < HTTP2_PREFACE.length; length += 1) {
      assert.equal(readPreface(HTTP2_PREFACE.subarray(0, length)), 'incomplete', `${length}`);
    }

    assert.equal(readPreface(HTTP2_PREFACE), 'http2');
    assert.equal(
      readPreface(Buffer.concat([HTTP2_PREFACE, Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0])])),
      'http2',
    );
  });

  it('decides for HTTP/1.1 at the first byte that disagrees, wherever it is', () => {
    for (let position = 0; position < HTTP2_PREFACE.length; position += 1) {
      for (const byte of [0x00, 0x0a, 0x20, 0x41, 0x7f, 0xff]) {
        if (byte === HTTP2_PREFACE[position]) {
          continue;
        }

        const bytes = Buffer.from(HTTP2_PREFACE.subarray(0, position + 1));

        bytes[position] = byte;
        assert.equal(readPreface(bytes), 'http1', `${position}: ${byte}`);
        // The bytes after the disagreeing one change nothing.
        assert.equal(readPreface(Buffer.concat([bytes, HTTP2_PREFACE])), 'http1');
      }
    }
  });

  it('reads every HTTP/1.1 request Node’s parser takes as HTTP/1.1 by its third byte at the latest', () => {
    let longest = 0;

    for (const method of METHODS) {
      const line = Buffer.from(`${method} /s/x HTTP/1.1\r\n`, 'latin1');

      assert.equal(readPreface(line), 'http1', method);

      let shared = 0;

      while (line[shared] === HTTP2_PREFACE[shared]) {
        shared += 1;
      }

      longest = Math.max(longest, shared);
      assert.equal(readPreface(line.subarray(0, shared)), 'incomplete', method);
      assert.equal(readPreface(line.subarray(0, shared + 1)), 'http1', method);
    }

    // `P` and `PR`, of `POST`, `PUT`, `PATCH`, `PROPFIND`, `PROPPATCH` and
    // `PURGE`: no method Node's parser takes begins with `PRI`.
    assert.equal(METHODS.includes('PRI'), false);
    assert.equal(longest, HTTP1_SHARED_PREFIX_BYTES);
  });

  it('reads hostile bytes of growing size in time, never taking what does not begin with the preface for it', () => {
    const next = random(207);

    for (const size of [1, 23, 24, 25, 1_024, 65_536, 1_048_576, 8_388_608]) {
      const bytes = Buffer.alloc(size);

      for (let index = 0; index < Math.min(size, 4_096); index += 1) {
        bytes[index] = Math.floor(next() * 256);
      }

      const start = performance.now();
      const reading = readPreface(bytes);

      assert.notEqual(reading, 'http2', `${size}`);
      assert.ok(performance.now() - start < 50, `${size} bytes`);

      // The same bytes behind the preface are HTTP/2, decided by the first 24.
      const behind = Buffer.concat([HTTP2_PREFACE, bytes]);
      const later = performance.now();

      assert.equal(readPreface(behind), 'http2');
      assert.ok(performance.now() - later < 50, `${size} bytes behind the preface`);
    }
  });
});

function fakeSocket(): Socket {
  return Object.assign(new PassThrough(), { remoteAddress: '127.0.0.1' }) as unknown as Socket;
}

/** A fake socket that a half-close leaves open, as a real one with `allowHalfOpen` is: destroyed only by whoever holds it. */
function halfOpenSocket(): Socket {
  return Object.assign(new PassThrough({ autoDestroy: false }), {
    remoteAddress: '127.0.0.1',
  }) as unknown as Socket;
}

function recordingLog(): { warnings: Record<string, unknown>[]; log: FastifyBaseLogger } {
  const warnings: Record<string, unknown>[] = [];
  const log = {
    warn: (fields: Record<string, unknown>, message: string) => {
      warnings.push({ ...fields, message });
    },
  } as unknown as FastifyBaseLogger;

  return { warnings, log };
}

/** A server with one `connection` listener, as the pipelining bound leaves it, recording what reaches it. */
function fakeServer(): { server: Server; handed: { socket: Socket; first: Buffer }[] } {
  const server = new EventEmitter() as unknown as Server;
  const handed: { socket: Socket; first: Buffer }[] = [];

  server.on('connection', (socket: Socket) => {
    const entry = { socket, first: Buffer.alloc(0) };

    handed.push(entry);
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      entry.first = Buffer.concat([entry.first, chunk]);
    });
  });

  return { server, handed };
}

/** What the HTTP/2 side was handed: each socket, and the bytes in its buffer when it was. */
function http2Side(): {
  http2: (socket: Socket) => void;
  taken: { socket: Socket; first: Buffer }[];
} {
  const taken: { socket: Socket; first: Buffer }[] = [];

  return {
    http2: (socket) => {
      // As Node's session does: it reads what was put back in the socket's buffer.
      const chunks: Buffer[] = [];
      let chunk: Buffer | null;

      while ((chunk = socket.read() as Buffer | null) !== null) {
        chunks.push(chunk);
      }

      taken.push({ socket, first: Buffer.concat(chunks) });
    },
    taken,
  };
}

describe('acceptHttp2Preface (D263)', () => {
  it('hands a connection that opens with the preface to the HTTP/2 side, the preface and what follows put back', async () => {
    const { server, handed } = fakeServer();
    const { http2, taken } = http2Side();
    const layer = acceptHttp2Preface(server, { http2, log: recordingLog().log });
    const socket = fakeSocket();
    const settings = Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0]);

    server.emit('connection', socket);
    assert.equal(layer.pending, 1);
    socket.write(Buffer.concat([HTTP2_PREFACE, settings]));
    await delay(10);

    assert.equal(handed.length, 0);
    assert.equal(taken.length, 1);
    assert.ok(taken[0]?.first.equals(Buffer.concat([HTTP2_PREFACE, settings])));
    assert.equal(layer.pending, 0);
  });

  it('takes a preface that arrives a byte at a time', async () => {
    const { server, handed } = fakeServer();
    const { http2, taken } = http2Side();

    acceptHttp2Preface(server, { http2, log: recordingLog().log });

    const socket = fakeSocket();

    server.emit('connection', socket);

    for (const byte of HTTP2_PREFACE) {
      socket.write(Buffer.from([byte]));
      await delay(1);
    }

    await delay(10);
    assert.equal(handed.length, 0);
    assert.ok(taken[0]?.first.equals(HTTP2_PREFACE));
  });

  it('hands every other connection to the HTTP/1.1 handling at its first disagreeing byte, its bytes unchanged', async () => {
    for (const text of [
      'GET /s/x HTTP/1.1\r\n\r\n',
      'POST /s/x HTTP/1.1\r\n',
      'PROPFIND / HTTP/1.1\r\n',
      'PRX',
      '\0',
    ]) {
      const { server, handed } = fakeServer();
      const { http2, taken } = http2Side();

      acceptHttp2Preface(server, { http2, log: recordingLog().log });

      const socket = fakeSocket();

      server.emit('connection', socket);

      // Written in single bytes, so the layer decides on the one that disagrees.
      for (const byte of Buffer.from(text, 'latin1')) {
        socket.write(Buffer.from([byte]));
        await delay(1);
      }

      await delay(10);
      assert.equal(taken.length, 0, text);
      assert.equal(handed.length, 1, text);
      assert.equal(handed[0]?.first.toString('latin1'), text);
    }
  });

  it('at its deadline hands a connection that sent nothing, P or PR to HTTP/1.1, and destroys one further into the preface, counted in a line', async () => {
    for (const sent of ['', 'P', 'PR', 'PRI', 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r']) {
      const { server, handed } = fakeServer();
      const { http2, taken } = http2Side();
      const { warnings, log } = recordingLog();
      const layer = acceptHttp2Preface(server, { http2, timeoutMs: 50, log });
      const socket = fakeSocket();

      server.emit('connection', socket);
      socket.write(sent);
      await delay(100);

      assert.equal(taken.length, 0, sent);
      assert.equal(layer.pending, 0, sent);

      if (sent.length <= HTTP1_SHARED_PREFIX_BYTES) {
        assert.equal(handed.length, 1, sent);
        assert.equal(handed[0]?.first.toString('latin1'), sent);
        assert.equal(socket.destroyed, false);
        assert.deepEqual(warnings, []);
      } else {
        assert.equal(handed.length, 0, sent);
        assert.equal(socket.destroyed, true, sent);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0]?.refused, 1);
        assert.equal(warnings[0]?.timeoutMs, 50);
      }
    }
  });

  it('destroys at once a connection its sender half-closes before the layer has decided, nothing handed on and nothing logged', async () => {
    for (const sent of ['', 'P', 'PR', 'PRI', 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r']) {
      const { server, handed } = fakeServer();
      const { http2, taken } = http2Side();
      const { warnings, log } = recordingLog();
      const layer = acceptHttp2Preface(server, { http2, timeoutMs: 5_000, log });
      const socket = halfOpenSocket();

      server.emit('connection', socket);
      socket.end(sent);
      await delay(10);

      assert.equal(socket.destroyed, true, JSON.stringify(sent));
      assert.equal(layer.pending, 0, JSON.stringify(sent));
      assert.equal(handed.length + taken.length, 0, JSON.stringify(sent));
      assert.deepEqual(warnings, []);
    }
  });

  it('leaves a half-close after its decision to the side it handed the connection to', async () => {
    const { server, handed } = fakeServer();
    const { http2, taken } = http2Side();

    acceptHttp2Preface(server, { http2, timeoutMs: 5_000, log: recordingLog().log });

    const http1 = halfOpenSocket();
    const preface = halfOpenSocket();

    server.emit('connection', http1);
    server.emit('connection', preface);
    http1.end('GET / HTTP/1.1\r\n\r\n');
    preface.end(HTTP2_PREFACE);
    await delay(10);

    assert.equal(handed.length, 1);
    assert.equal(taken.length, 1);
    assert.equal(http1.destroyed, false);
    assert.equal(preface.destroyed, false);
  });

  it('waits 10 s by default', () => {
    assert.equal(DEFAULT_PREFACE_TIMEOUT_MS, 10_000);
  });

  it('forgets a connection that closes or fails while it waits, and destroys the waiting ones on closePending', async () => {
    const { server, handed } = fakeServer();
    const { http2, taken } = http2Side();
    const layer = acceptHttp2Preface(server, { http2, timeoutMs: 50, log: recordingLog().log });
    const closing = fakeSocket();
    const failing = fakeSocket();
    const waiting = fakeSocket();

    for (const socket of [closing, failing, waiting]) {
      server.emit('connection', socket);
      socket.write('PRI');
    }

    assert.equal(layer.pending, 3);
    closing.destroy();
    failing.destroy(new Error('reset'));
    await delay(1);
    assert.equal(layer.pending, 1);
    layer.closePending();
    assert.equal(layer.pending, 0);
    assert.equal(waiting.destroyed, true);
    await delay(100);
    assert.equal(handed.length + taken.length, 0);
  });

  it('refuses a server with no connection listener to put the layer in front of', () => {
    assert.throws(
      () =>
        acceptHttp2Preface(new EventEmitter() as unknown as Server, {
          http2: () => undefined,
          log: recordingLog().log,
        }),
      /no connection listener/,
    );
  });
});
