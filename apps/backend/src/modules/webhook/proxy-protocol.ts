/**
 * PROXY protocol v2 on the receive listener (D187).
 *
 * In production every connection to the receive listener comes from Traefik's
 * TCP route for the receive host, which passes the sender's TLS-decrypted bytes
 * through untouched and puts one binary header in front of them: the PROXY
 * protocol v2 header (haproxy's `proxy-protocol.txt`, section 2.2), carrying
 * the address the sender connected from. That header is the only place the
 * sender's address still exists once the TCP route has ended the sender's
 * connection, so `sourceIp` is read from it.
 *
 * Believing it is a trust decision, and it is the one D111 already made: the
 * header is accepted only from a peer inside `TRUSTED_PROXY_CIDRS`. A
 * connection from anybody else, a connection whose first bytes are not a valid
 * v2 `PROXY` header, and one that does not deliver the header within the
 * deadline - checked once more, after its timer fires, once the event loop
 * has read the sockets already ready, so that a header already received is
 * still read on a busy loop (#299) - are destroyed with nothing written,
 * before Node's HTTP parser ever sees them. So no peer outside the trust
 * boundary, and no sender, can choose the address stored, and a request that
 * could not carry a sender's address is not captured at all. A peer inside it
 * can: the boundary is the node's pod network, so every pod on the node may
 * send a header, the same single-node assumption D111 names (D187, item 13).
 *
 * What is accepted is deliberately narrow: version 2, the `PROXY` command, TCP
 * over IPv4 or IPv6, with any TLVs after the addresses skipped. `LOCAL`, which
 * the specification lets a proxy send for its own health checks, is refused:
 * Traefik's TCP route never sends it, and a capture must carry the sender's
 * address. The text form of version 1 is refused with everything else.
 *
 * Hand-written rather than a dependency: the format is sixteen fixed bytes and
 * an address block, and the parser is a pure function the tests drive byte by
 * byte.
 *
 * The layer also bounds the connections one sender holds (D227): a
 * connection takes a place of its sender's address once its header has been
 * read - keyed as the per-minute limits key an address, an IPv6 address by
 * its `/64` and an IPv4-mapped one as its IPv4 (`addressKey`) - and gives it
 * back when its socket closes, however it closes. One over the bound, 512 an
 * address unless configured otherwise, is destroyed right after its header,
 * before Node's HTTP server sees a byte of it: no HTTP answer, nothing
 * stored. The sender's address already lives here for the connection's life
 * (`sourceOf`); the count keeps nothing more, keeps an address only while it
 * holds a place, and never writes one to the log: what is logged of the
 * refusals is how many there were.
 *
 * The refusals of a peer outside the trust boundary are logged the same way,
 * as a count at most once a minute, so that a burst of them cannot flood the
 * log whatever reaches the listener. That line names the latest refused peer
 * as well: the socket peer, which the log may name (D117), never a sender's
 * address, and kept only until the line is written.
 */
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import ipaddr from 'ipaddr.js';
import { MAX_RECEIVE_CONNECTIONS_PER_ADDRESS } from '@webhook-inspector/shared';
import { createKeyedSlots, type KeyedSlots } from '../../lib/slots.ts';
import { addressKey } from '../limits/rate-limit.ts';

/** The twelve bytes every v2 header starts with. */
export const PROXY_V2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);

/** Signature, version and command, family and protocol, and the length. */
const FIXED_PART_BYTES = 16;

/** Version 2, command `PROXY`. */
const VERSION_2_PROXY = 0x21;
/** Version 2, command `LOCAL`: refused (D187). */
const VERSION_2_LOCAL = 0x20;
/** TCP over IPv4: two addresses of 4 bytes and two ports of 2. */
const TCP_OVER_IPV4 = 0x11;
/** TCP over IPv6: two addresses of 16 bytes and two ports of 2. */
const TCP_OVER_IPV6 = 0x21;

/**
 * The longest header accepted, TLVs included. Traefik sends none, so a header
 * this long is not Traefik's, and a bound keeps a peer from making the
 * listener buffer without end before a single byte of HTTP.
 */
export const MAX_PROXY_HEADER_BYTES = 1024;

/** How long a trusted peer has to deliver the whole header. */
export const DEFAULT_PROXY_HEADER_TIMEOUT_MS = 5_000;

/**
 * At most one log line a minute about each kind of refused connection: those
 * over the bound of their address (D227), and those from a peer outside the
 * trust boundary (D187). The first refusal of a kind is logged at once, and
 * those that follow within the minute are logged together once it has passed,
 * as a count. A sender opening connections in a loop cannot fill the log, and
 * no line names a sender's address.
 */
export const REFUSAL_LOG_INTERVAL_MS = 60_000;

/**
 * One counted warn line, with a timer of its own: the first refusal is written
 * at once, and the refusals after it are written together, `refused` of them,
 * once `REFUSAL_LOG_INTERVAL_MS` has passed, then at most once an interval. An
 * interval with none writes nothing and stops the timer, so the next refusal
 * is written at once again. Each line carries `fixed` and the fields the
 * latest refusal it counts was given; those are dropped once written, so
 * nothing is kept per refusal. The timer is `unref`'d: it never keeps the
 * process alive.
 */
export function countedRefusals(
  log: FastifyBaseLogger,
  message: string,
  fixed: Record<string, unknown> = {},
): (latest?: Record<string, unknown>) => void {
  let unlogged = 0;
  let latestFields: Record<string, unknown> = {};
  let timer: NodeJS.Timeout | null = null;

  const write = (): void => {
    if (unlogged === 0) {
      timer = null;

      return;
    }

    log.warn({ refused: unlogged, ...fixed, ...latestFields }, message);
    unlogged = 0;
    latestFields = {};
    timer = setTimeout(write, REFUSAL_LOG_INTERVAL_MS);
    timer.unref();
  };

  return (latest = {}) => {
    unlogged += 1;
    latestFields = latest;

    if (timer === null) {
      write();
    }
  };
}

export type ProxyHeader =
  /** Every byte so far agrees with a v2 header; more are needed. */
  | { kind: 'incomplete' }
  /** Not a header this listener accepts; the reason never quotes the bytes. */
  | { kind: 'invalid'; reason: string }
  /** A well-formed `LOCAL` header, which is refused. */
  | { kind: 'local' }
  /** The sender's address, and how many bytes the header took. */
  | { kind: 'proxy'; source: string; length: number };

/**
 * Reads a PROXY protocol v2 header from the first bytes of a connection.
 *
 * Decides as early as the bytes allow: the first byte that disagrees with the
 * signature refuses the connection, so a plain HTTP request or a version 1
 * `PROXY TCP4 …` line is refused on its first byte rather than after a wait.
 */
export function parseProxyV2Header(bytes: Buffer): ProxyHeader {
  const signatureBytes = Math.min(bytes.length, PROXY_V2_SIGNATURE.length);

  if (!bytes.subarray(0, signatureBytes).equals(PROXY_V2_SIGNATURE.subarray(0, signatureBytes))) {
    return { kind: 'invalid', reason: 'not a PROXY protocol v2 header' };
  }

  if (bytes.length <= 12) {
    return { kind: 'incomplete' };
  }

  const versionCommand = bytes[12] as number;

  if (versionCommand === VERSION_2_LOCAL) {
    return bytes.length < FIXED_PART_BYTES ? { kind: 'incomplete' } : { kind: 'local' };
  }

  if (versionCommand !== VERSION_2_PROXY) {
    return { kind: 'invalid', reason: 'not version 2 with the PROXY command' };
  }

  if (bytes.length <= 13) {
    return { kind: 'incomplete' };
  }

  const family = bytes[13] as number;
  const addressBytes = family === TCP_OVER_IPV4 ? 12 : family === TCP_OVER_IPV6 ? 36 : null;

  if (addressBytes === null) {
    return { kind: 'invalid', reason: 'not TCP over IPv4 or IPv6' };
  }

  if (bytes.length < FIXED_PART_BYTES) {
    return { kind: 'incomplete' };
  }

  const declared = bytes.readUInt16BE(14);
  const length = FIXED_PART_BYTES + declared;

  if (declared < addressBytes) {
    return { kind: 'invalid', reason: 'address block shorter than its family needs' };
  }

  if (length > MAX_PROXY_HEADER_BYTES) {
    return { kind: 'invalid', reason: `header longer than ${MAX_PROXY_HEADER_BYTES} bytes` };
  }

  if (bytes.length < length) {
    return { kind: 'incomplete' };
  }

  const source =
    family === TCP_OVER_IPV4
      ? Array.from(bytes.subarray(16, 20)).join('.')
      : ipaddr.fromByteArray(Array.from(bytes.subarray(16, 32))).toString();

  return { kind: 'proxy', source, length };
}

export interface ProxyProtocolOptions {
  /**
   * Whether a socket peer is inside the trust boundary (D111): the same
   * compiled allow-list the application listener hands Fastify.
   */
  isTrustedPeer: (address: string) => boolean;
  /** How long a trusted peer has to deliver the header; 5 s unless a test shortens it. */
  timeoutMs?: number;
  /**
   * How many connections one sender address may have open at once (D227),
   * keyed by `addressKey`; `0` turns the bound off. Absent, 512
   * (`MAX_RECEIVE_CONNECTIONS_PER_ADDRESS`).
   */
  connectionsPerAddress?: number;
  log: FastifyBaseLogger;
}

export interface ProxyProtocolLayer {
  /** The sender's address the connection's header carried, or `undefined` for none. */
  sourceOf(socket: Socket): string | undefined;
  /** Destroys the connections still waiting for their header; for shutdown. */
  closePending(): void;
  /**
   * The places the open connections hold, per sender address (D227), or
   * `null` when the bound is off. Exists for tests and diagnostics.
   */
  readonly connections: KeyedSlots | null;
  /** Connections refused over their address's bound since the layer started. */
  readonly refused: number;
}

/**
 * Puts the PROXY v2 check in front of an HTTP server's own handling of every
 * connection. Called before the server listens.
 *
 * Node's HTTP server handles a connection in its `connection` listener. That
 * listener is taken off the server and called here, with the same socket, once
 * the header has been read and checked; the bytes that arrived after the
 * header are put back in front of the socket's stream first, so the HTTP
 * parser reads them as the first bytes of the connection. Everything else is
 * the server's own: its parser, its limits and its `requestTimeout` and
 * `headersTimeout` checks, which start when the connection is handed over.
 * The socket keeps its own `remoteAddress`, the peer that connected, which is
 * what the structured log records (D117); the sender's address is only ever
 * read through `sourceOf`.
 *
 * Only the first bytes of a connection carry the header: later requests on a
 * kept-alive connection belong to the same sender and share its address.
 *
 * A connection whose sender already has `connectionsPerAddress` open is
 * destroyed once its header has been read, and never handed over (D227).
 */
export function acceptProxyProtocol(
  server: Server,
  options: ProxyProtocolOptions,
): ProxyProtocolLayer {
  const { isTrustedPeer, log } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROXY_HEADER_TIMEOUT_MS;
  const perAddress = options.connectionsPerAddress ?? MAX_RECEIVE_CONNECTIONS_PER_ADDRESS;
  const connections = perAddress > 0 ? createKeyedSlots(perAddress) : null;
  const handlers = server.listeners('connection') as ((socket: Socket) => void)[];

  // Node's own handler. Without it there is nothing to hand a connection to,
  // and a server that silently answered nothing would be worse than one that
  // fails to start.
  if (handlers.length === 0) {
    throw new Error('The HTTP server has no connection listener to put PROXY protocol in front of');
  }

  server.removeAllListeners('connection');

  const sources = new WeakMap<Socket, string>();
  const pending = new Set<Socket>();

  // The refusals over an address's bound, all of them (D227), and their line:
  // the first at once and then at most once a minute, with the count and
  // never an address.
  let refused = 0;
  const logOverBound = countedRefusals(
    log,
    'Receive connections refused: their sender address had every connection place taken',
    { connectionsPerAddress: perAddress },
  );
  // The refusals of a peer outside the trust boundary, counted apart from
  // those over the bound, on the same terms, each line with the latest peer.
  const logOutsidePeer = countedRefusals(
    log,
    'Receive connections refused: peer outside the trust boundary',
  );

  server.on('connection', (socket: Socket) => {
    const peer = socket.remoteAddress;

    // Before a single byte is read: a peer outside the boundary is not asked
    // for a header it may not give. A peer that is unknown is a connection
    // reset before Node read its address - through the proxy, a sender that
    // gave up (inferred) - not a peer known to be outside. It is refused and
    // counted with them, and a line whose latest refusal it is names no peer.
    if (peer === undefined || !isTrustedPeer(peer)) {
      logOutsidePeer(peer === undefined ? {} : { peer });
      socket.destroy();

      return;
    }

    let received: Buffer = Buffer.alloc(0);
    // The deadline's one re-check, once its timer has fired (#299).
    let recheck: NodeJS.Immediate | undefined;

    const settle = (): void => {
      clearTimeout(deadline);
      clearImmediate(recheck);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      pending.delete(socket);
    };

    // The peer, never anything the header said: whatever it carried was not
    // believed.
    const refuse = (reason: string): void => {
      settle();
      log.warn({ peer, reason }, 'Receive connection refused: no valid PROXY protocol header');
      socket.destroy();
    };

    const onData = (chunk: Buffer): void => {
      received = received.length === 0 ? chunk : Buffer.concat([received, chunk]);

      const header = parseProxyV2Header(received);

      if (header.kind === 'incomplete') {
        return;
      }

      if (header.kind === 'invalid') {
        refuse(header.reason);

        return;
      }

      if (header.kind === 'local') {
        refuse('the LOCAL command carries no sender address');

        return;
      }

      settle();

      // A place among its sender's open connections, held until the socket
      // closes, however it closes: by either side, by a timeout of Node's,
      // by a reset (D227). None left: the connection is destroyed before
      // Node's HTTP server sees it, with nothing written - the proxy then
      // ends the sender's connection - and only a count is logged.
      if (connections !== null) {
        const release = connections.tryTake(addressKey(header.source));

        if (release === null) {
          refused += 1;
          logOverBound();

          // Reset rather than closed: Traefik writes the header before the
          // sender's TLS handshake has ended, and a connection merely closed
          // then leaves it forwarding the sender's first bytes into a socket
          // already gone - a request sent in one piece then waits for an
          // answer that never comes. A reset fails that first write, and
          // Traefik ends the sender's connection with it.
          //
          // settle() has taken the layer's `error` listener off, and a reset
          // that fails is emitted as an `error` on the socket - by Node's
          // `_destroy` when the handle's reset fails, or for a handle already
          // gone - which with no listener would be thrown: the refused
          // socket keeps one that ignores it.
          socket.on('error', () => undefined);
          socket.resetAndDestroy();

          return;
        }

        socket.once('close', release);
      }

      sources.set(socket, header.source);

      // Paused before anything is handed over, so no byte is emitted to a
      // listener that is about to be removed, and so Node's handler, adding
      // its own `data` listener, does not set the stream flowing early.
      socket.pause();

      const rest = received.subarray(header.length);

      if (rest.length > 0) {
        socket.unshift(rest);
      }

      for (const handler of handlers) {
        handler.call(server, socket);
      }

      socket.resume();
    };

    // A connection reset during the header is the peer's business; without a
    // listener the error would be thrown.
    const onError = (): void => {
      settle();
    };

    const onClose = (): void => {
      settle();
    };

    // A turn of the event loop runs its timers before it reads the sockets
    // that are ready, so on a loop held past the deadline - a flood starving
    // the CPU - the timer fires while the header may already be in the
    // kernel's buffer (#299). So it refuses nothing itself: it checks once
    // more in the same turn's check phase, after the poll phase has read what
    // the kernel holds, and only a connection still waiting then is refused,
    // with the same reason. Once and no more: more turns would let a peer
    // that trickles bytes stretch the deadline turn after turn. And only a
    // peer inside the trust boundary ever has a deadline, so the extra wait
    // is nothing a public sender controls. A connection that got its header,
    // closed or was reset in between has had settle() cancel the re-check;
    // one destroyed by closePending() is no longer pending.
    const deadline = setTimeout(() => {
      recheck = setImmediate(() => {
        if (pending.has(socket)) {
          refuse(`no complete header within ${timeoutMs} ms`);
        }
      });
    }, timeoutMs);

    pending.add(socket);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });

  return {
    sourceOf: (socket) => sources.get(socket),
    closePending: () => {
      for (const socket of pending) {
        socket.destroy();
      }

      pending.clear();
    },
    connections,
    get refused() {
      return refused;
    },
  };
}
