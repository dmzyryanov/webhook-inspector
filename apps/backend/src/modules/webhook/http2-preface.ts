/**
 * The HTTP/2 connection preface on the receive listener (D263), installed only
 * with `RECEIVE_HTTP2=on`.
 *
 * A sender that speaks HTTP/2 without TLS's ALPN - h2c with prior knowledge,
 * which is what reaches the listener through Traefik's TCP route whatever ALPN
 * agreed with the sender, #206 measured - opens its connection with the
 * 24 bytes of `HTTP2_PREFACE`, after the PROXY protocol header when there is
 * one. This layer reads a connection's first bytes, compares them with the
 * preface and hands the connection on:
 *
 * - the whole preface: to the HTTP/2 server, whose session reads the preface
 *   and everything after it;
 * - a first byte that disagrees with the preface: to the HTTP/1.1 handling,
 *   the pipelining bound and Node's parser (D229, D238), with every byte it
 *   read put back, unchanged (D187). Every HTTP/1.1 request a client sends
 *   disagrees by its first byte, or by its second or third when its method
 *   begins with `P` - `POST`, `PUT`, `PATCH`, `PROPFIND`, `PROPPATCH`,
 *   `PURGE` - so it waits for nothing.
 *
 * It decides at the first byte that disagrees, as `parseProxyV2Header` does,
 * and within a deadline of its own, `DEFAULT_PREFACE_TIMEOUT_MS`, from the
 * moment the connection reaches it. At the deadline a connection that has
 * sent no more than `HTTP1_SHARED_PREFIX_BYTES` - nothing, `P` or `PR`, the
 * beginning of a request Node's HTTP/1.1 parser accepts as much as of the
 * preface - is handed to the HTTP/1.1 handling with those bytes, as if the
 * layer were not there: Node's own timeouts then bound it, a connection a
 * client opened ahead of its request included. One that has sent more, `PRI`
 * and beyond - which no method Node's parser accepts begins with, so a preface
 * stalled part-way - is destroyed with nothing written, and counted in a line
 * at `warn` at most once a minute.
 *
 * A connection its sender half-closes before the layer has decided has sent
 * all it ever will, and is destroyed at once, nothing written, rather than
 * left to the deadline and then to Node's timeouts: the bytes cannot be
 * handed on after their end (`ERR_STREAM_UNSHIFT_AFTER_END_EVENT`), and Node's
 * parser, which watches a connection for its end, would never see this one.
 * With the setting off such a connection closes at once too, after nothing;
 * after `P` or `PR` Node's parser writes its `400` first, which no request a
 * client completes meets.
 *
 * Put between the pipelining bound and the PROXY protocol layer: the PROXY
 * layer hands it a connection once its header has been read, with the bytes
 * after the header put back, so the layer reads the same bytes with PROXY on
 * or off, and an HTTP/2 connection never meets the HTTP/1.1 slicing layer,
 * whose framing it does not have.
 */
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import { countedRefusals } from './proxy-protocol.ts';

/** RFC 9113 §3.4: what an HTTP/2 client sends first on a connection. */
export const HTTP2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'latin1');

/**
 * How long a connection has to send the preface whole, or a byte that
 * disagrees with it, before the layer decides at the deadline. Longer than
 * the PROXY header's 5 s: the PROXY header is Traefik's, written at once,
 * where the first byte after it is the sender's, after its TLS handshake.
 */
export const DEFAULT_PREFACE_TIMEOUT_MS = 10_000;

/**
 * How many of the preface's first bytes a request Node's HTTP/1.1 parser
 * accepts can begin with: `P` and `PR`, of `POST`, `PUT`, `PATCH`,
 * `PROPFIND`, `PROPPATCH` and `PURGE`. `PRI` is no method Node's parser
 * takes: it answers such a request `400`.
 */
export const HTTP1_SHARED_PREFIX_BYTES = 2;

export type PrefaceReading = 'incomplete' | 'http2' | 'http1';

/**
 * What a connection's first bytes are: the whole preface, a byte that
 * disagrees with it, or a part of it so far. Pure.
 */
export function readPreface(bytes: Buffer): PrefaceReading {
  const length = Math.min(bytes.length, HTTP2_PREFACE.length);

  if (!bytes.subarray(0, length).equals(HTTP2_PREFACE.subarray(0, length))) {
    return 'http1';
  }

  return bytes.length >= HTTP2_PREFACE.length ? 'http2' : 'incomplete';
}

export interface PrefaceOptions {
  /** Takes a connection that opened with the preface, the preface put back in front of it. */
  http2: (socket: Socket) => void;
  /** The layer's deadline; `DEFAULT_PREFACE_TIMEOUT_MS` unless a test shortens it. */
  timeoutMs?: number;
  log: FastifyBaseLogger;
}

export interface PrefaceLayer {
  /** Destroys the connections still waiting for a decision; for shutdown. */
  closePending(): void;
  /** Connections waiting for a decision. Exists for tests and diagnostics. */
  readonly pending: number;
}

/**
 * Puts the preface check in front of an HTTP server's own handling of every
 * connection, before the PROXY protocol layer is put in front of it. Called
 * before the server listens.
 *
 * As the PROXY layer does, the server's `connection` listeners - the
 * pipelining bound's - are taken off and called with the socket once the
 * layer has decided for HTTP/1.1; the bytes read meanwhile are put back in
 * front of the socket's stream first, so the parser reads them as the first
 * bytes of the connection. A connection decided for HTTP/2 is stopped, its
 * bytes put back, and given to `options.http2`, which emits it on the HTTP/2
 * server: Node's session reads what is in the socket's buffer before it
 * reads the socket itself.
 */
export function acceptHttp2Preface(server: Server, options: PrefaceOptions): PrefaceLayer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFACE_TIMEOUT_MS;
  const handlers = server.listeners('connection') as ((socket: Socket) => void)[];

  if (handlers.length === 0) {
    throw new Error(
      'The HTTP server has no connection listener to put the HTTP/2 preface in front of',
    );
  }

  server.removeAllListeners('connection');

  const pending = new Set<Socket>();
  const logStalled = countedRefusals(
    options.log,
    'Receive connections closed: an HTTP/2 preface stopped part-way',
    { timeoutMs },
  );

  server.on('connection', (socket: Socket) => {
    let received: Buffer = Buffer.alloc(0);

    const settle = (): void => {
      clearTimeout(deadline);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
      socket.off('close', onClose);
      pending.delete(socket);
    };

    // Paused before anything is handed over, so that no byte is emitted to a
    // listener about to be removed, and so that Node's handler, adding its
    // own `data` listener, does not set the stream flowing early.
    const handOver = (http2: boolean): void => {
      settle();
      socket.pause();

      if (received.length > 0) {
        socket.unshift(received);
      }

      if (http2) {
        // Node's session reads the socket natively once it has read what
        // was put back: nothing to start here.
        options.http2(socket);

        return;
      }

      for (const handler of handlers) {
        handler.call(server, socket);
      }

      socket.resume();
    };

    const onData = (chunk: Buffer): void => {
      received = received.length === 0 ? chunk : Buffer.concat([received, chunk]);

      const reading = readPreface(received);

      if (reading !== 'incomplete') {
        handOver(reading === 'http2');
      }
    };

    // The sender half-closed before the layer decided: see above.
    const onEnd = (): void => {
      settle();
      socket.destroy();
    };

    // A connection reset while the layer reads it is the sender's business;
    // without a listener the error would be thrown.
    const onError = (): void => {
      settle();
    };

    const onClose = (): void => {
      settle();
    };

    const deadline = setTimeout(() => {
      if (received.length <= HTTP1_SHARED_PREFIX_BYTES) {
        handOver(false);

        return;
      }

      settle();
      logStalled();
      socket.destroy();
    }, timeoutMs);

    pending.add(socket);
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onError);
    socket.on('close', onClose);
  });

  return {
    closePending: () => {
      for (const socket of pending) {
        socket.destroy();
      }

      pending.clear();
    },
    get pending() {
      return pending.size;
    },
  };
}
