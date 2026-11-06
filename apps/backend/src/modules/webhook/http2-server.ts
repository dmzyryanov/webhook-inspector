/**
 * The HTTP/2 server of the receive listener (D263): Node's, without TLS - h2c,
 * the TLS being Traefik's - listening on nothing. The preface layer
 * (`http2-preface.ts`) gives it the connections that open with the HTTP/2
 * preface, and the second Fastify instance of `buildReceiver` serves their
 * requests with the receive routes, through Node's compatibility request and
 * response.
 *
 * Its limits are HTTP/2's counterparts of the HTTP/1.1 path's, pinned in
 * `server-timeouts.test.ts` and, but for session memory and the stream
 * resets, exercised at their edges in `receiver-http2.test.ts`, and the bound
 * on `:path` and `:authority` in `receiver-http2-hostile.test.ts`:
 *
 * - at most 32 streams open at once on a connection, D229's bound on the
 *   requests an HTTP/1.1 connection has read and not answered: the 33rd is
 *   refused `RST_STREAM(REFUSED_STREAM)` and nothing of it is read;
 * - a header list of at most 4,100 fields - 4,096 header lines and the four
 *   pseudo-header fields - and of at most 148,608 bytes as HTTP/2 counts
 *   them, name and value and 32 bytes a field: HTTP/1.1's 16 KiB of request
 *   target, names and values, 1 KiB for what HTTP/2 counts and HTTP/1.1 does
 *   not (the pseudo-header fields' names, `:method`, `:scheme` and
 *   `:authority`), and 32 bytes for each of the 4,100. Node's default of 128
 *   fields would refuse the 2,500-line webhooks `capture-admission.test.ts`
 *   stores over HTTP/1.1, which fit. A list over either is refused
 *   `RST_STREAM(ENHANCE_YOUR_CALM)`, nothing stored, where HTTP/1.1 answers
 *   `431` - from a connection's first request on, the SETTINGS that announce
 *   the size acknowledged or not (`headerListSize`, below). The 4,100 are
 *   fewer than the 16,384 one-byte lines HTTP/1.1's 16 KiB allows: they are
 *   what bounds the memory of a header block a sender leaves open, which
 *   Node decodes field by field and holds until the block ends or the
 *   connection closes, whatever else is announced (D266);
 * - within that list, a `:path` or `:authority` of at most 16 KiB
 *   (`HTTP2_MAX_PSEUDO_HEADER_BYTES`), HTTP/1.1's whole request head: a longer
 *   one is refused the same way, `RST_STREAM(ENHANCE_YOUR_CALM)`, so that
 *   neither reaches the default answer, the stored row, the list rows, a
 *   `request.received` event or the log line, all sized for HTTP/1.1 (#208)
 *   - though the log line's `host`, which Fastify takes from a regular `host`
 *   field before `:authority`, is held by the list's 148,608 bytes alone;
 * - at most 10 MB of session memory a connection, Node's default, written
 *   down so that it does not move unseen: past it, Node refuses new streams
 *   itself. Our part is the value, pinned; the refusal is reached neither by
 *   the tests nor by #208's measurement, whose open bodies stay far under it
 *   (D266 point 7);
 * - at most 64 streams a connection's sender resets in a burst, and 33 a
 *   second after it (`streamResetBurst`, `streamResetRate`): past them
 *   nghttp2 ends the connection with a GOAWAY, rapid reset's answer
 *   (CVE-2023-44487). Node's defaults, 1,000 and 33, let a connection reset
 *   a thousand streams before it noticed (D266). The resets this server
 *   writes itself, after an early answer (below), are believed not to be
 *   counted; that and the bound's edge are tested by #298;
 * - with PROXY protocol on, at most 32 HTTP/2 connections open at once from
 *   one sender address, counted among the 512 every connection of it may
 *   have (D227) by `installHttp2` in `server.ts`
 *   (`HTTP2_MAX_CONNECTIONS_PER_ADDRESS`), so that the header blocks one
 *   address can leave open are bounded too (D266);
 * - 90 s for a request to arrive, from its headers to the end of its stream
 *   (D172's `requestTimeout`): one still arriving then is answered `408` and
 *   its stream reset, `RST_STREAM(NO_ERROR)`, nothing stored;
 * - 72 s of a connection with nothing on it before it is closed - a GOAWAY,
 *   then its end - as Fastify keeps an idle HTTP/1.1 connection
 *   (`keepAliveTimeout`) and an HTTP/2 session (`http2SessionTimeout`).
 *   Fastify sets no such timeout on the server a `serverFactory` builds, so
 *   this server's own (`sessionIdleTimeoutMs`) is the only close of an idle
 *   connection;
 * - a body of at most 1 MiB, the receive routes' own limit, past which it is
 *   answered `413` / `1004` and nothing stored, as over HTTP/1.1.
 *
 * A `:method` no route has, which HTTP/2 holds to no list, is answered `404`
 * / `1000` before Fastify sees it (`unroutedMethods`).
 *
 * And one rule HTTP/1.1 has otherwise: an answer written before its request's
 * stream has ended - a `GET` that sent a body, a refusal before the body, a
 * `413` - ends that stream with `RST_STREAM(NO_ERROR)` once written, as RFC
 * 9113 §8.1 lets a server ask a client to stop sending without error. The
 * connection and its other streams go on; over HTTP/1.1 such an answer ends
 * its connection (D227).
 *
 * The header fields of a request are kept as the sender wrote them: a value
 * with spaces at its ends, which Node drops by default
 * (`strictFieldWhitespaceValidation`), is kept and stored as received.
 */
import http2, {
  constants,
  type Http2Server,
  type Http2ServerRequest,
  type Http2ServerResponse,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from 'node:http2';
import { MAX_PIPELINED_REQUESTS } from '@webhook-inspector/shared';
import { http2RequestArrived, markHttp2TimedOut, watchHttp2Request } from '../../lib/http2.ts';

/** The streams a connection may have open at once: D229's 32 (`MAX_PIPELINED_REQUESTS`). */
export const HTTP2_MAX_CONCURRENT_STREAMS = MAX_PIPELINED_REQUESTS;

/**
 * HTTP/1.1's bound on a request's head, which Node's parser holds it to:
 * 16 KiB of request target and header names and values (D210 point 3).
 */
const HTTP1_HEAD_BYTES = 16_384;

/** The pseudo-header fields of a request: `:method`, `:scheme`, `:authority` and `:path`. */
const REQUEST_PSEUDO_HEADER_FIELDS = 4;

/** What HTTP/2 counts for each field of a header list besides its name and value (RFC 9113 §6.5.2). */
const HTTP2_FIELD_OVERHEAD_BYTES = 32;

/**
 * What a header list's names and values hold over HTTP/2 and not over
 * HTTP/1.1: the pseudo-header fields' names, `:method`, `:scheme` and
 * `:authority` - `:path` is HTTP/1.1's request target.
 */
const PSEUDO_HEADER_ALLOWANCE_BYTES = 1024;

/**
 * The header lines a request may have over HTTP/2: 4,096 (D266). Node holds
 * a stream's header fields from their decoding to the end of their block -
 * about 210 bytes a field, an estimate from the runs before this bound that
 * #298 measures, before any JavaScript sees them - and a
 * sender that never ends the block keeps them until its connection closes.
 * Before the client has acknowledged the SETTINGS, which a sender that wants
 * this never does, only this number bounds them: the list's size binds once
 * acknowledged, and the session's memory is not reached. HTTP/1.1's 16 KiB
 * allows 16,384 one-byte lines; 4,096 holds a stalled block to under 1 MiB
 * and still takes the 2,500-line webhooks the HTTP/1.1 path stores.
 */
const HTTP2_MAX_HEADER_LINES = 4_096;

/** The fields a request's header list may have: 4,100, the lines and the four pseudo-header fields. */
export const HTTP2_MAX_HEADER_LIST_PAIRS = HTTP2_MAX_HEADER_LINES + REQUEST_PSEUDO_HEADER_FIELDS;

/** The bytes a request's header list may have, as HTTP/2 counts them: 148,608. */
export const HTTP2_MAX_HEADER_LIST_SIZE =
  HTTP1_HEAD_BYTES +
  PSEUDO_HEADER_ALLOWANCE_BYTES +
  HTTP2_FIELD_OVERHEAD_BYTES * HTTP2_MAX_HEADER_LIST_PAIRS;

/** The memory a connection's session may use, in megabytes: Node's default. */
export const HTTP2_MAX_SESSION_MEMORY_MB = 10;

/**
 * The most a request's `:path` or `:authority` may be, as HTTP/2 counts the
 * octets of each (one character a string, below): HTTP/1.1's 16 KiB of
 * request head (D263 point 11, #208). The whole header list is already bounded
 * to `HTTP2_MAX_HEADER_LIST_SIZE`, but a single `:path` or `:authority` can
 * reach about 104 KB within it - one HPACK field over 64 KiB encoded - and
 * those two fields flow, sized for HTTP/1.1's 16 KiB target and `Host` line,
 * into the default answer (JSON escaping can near double the path), the stored
 * row, the list rows, each `request.received` event and the request's log line
 * (`serializeRequest`'s `url`, and its `host` where Fastify takes it from
 * `:authority`: a regular `host` field, which Fastify reads first, is held by
 * the list's bytes alone). Rather than measure each consumer,
 * the stream whose `:path` or `:authority` is longer is refused where the
 * header list is measured (#207).
 */
export const HTTP2_MAX_PSEUDO_HEADER_BYTES = HTTP1_HEAD_BYTES;

/**
 * The streams a connection's sender may reset at once before nghttp2 ends
 * the connection with a GOAWAY, and how many more a second after them
 * (`streamResetBurst`, `streamResetRate`; nghttp2's `stream_reset_rate_limit`).
 * Node's defaults, 1,000 and 33, let one connection open and reset a
 * thousand streams before it ended; 64 is two connections' worth of the 32
 * streams a connection may have open, and 33 a second keeps Node's rate
 * (D266). nghttp2 counts the resets a sender writes and those it writes
 * itself for a sender's error, and is believed not to count those this
 * server writes after an early answer: #298 tests that, and the edge.
 */
export const HTTP2_STREAM_RESET_BURST = 64;
export const HTTP2_STREAM_RESET_RATE = 33;

/**
 * The HTTP/2 connections one sender address may have open at once, with
 * PROXY protocol on: 32, counted among D227's 512 by `installHttp2` in
 * `server.ts`. A connection may leave a header block open holding up to
 * `HTTP2_MAX_HEADER_LIST_PAIRS` decoded fields: about 0.82 MiB at about 210
 * bytes a field (210 x 4,100), about 0.9 MiB with the connection's own cost.
 * 32 of them hold an address to about 29 MiB (0.9 MiB x 32), where D227's 512
 * would let one address reach the container's 512 MiB (D266). These are
 * estimates, which #298 measures. The 33rd is destroyed
 * before Node's HTTP/2 server sees it, with nothing written, as D227
 * refuses the 513th.
 */
export const HTTP2_MAX_CONNECTIONS_PER_ADDRESS = 32;

/** How long a request may take to arrive, as over HTTP/1.1 (D172). */
export const HTTP2_REQUEST_TIMEOUT_MS = 90_000;

/** How long a connection with nothing on it stays open: Fastify's 72 s. */
export const HTTP2_SESSION_IDLE_TIMEOUT_MS = 72_000;

/** What Node's HTTP/2 server is built with. */
export function receiveHttp2ServerOptions(): http2.ServerOptions {
  return {
    maxHeaderListPairs: HTTP2_MAX_HEADER_LIST_PAIRS,
    maxSessionMemory: HTTP2_MAX_SESSION_MEMORY_MB,
    streamResetBurst: HTTP2_STREAM_RESET_BURST,
    streamResetRate: HTTP2_STREAM_RESET_RATE,
    strictFieldWhitespaceValidation: false,
    settings: {
      maxConcurrentStreams: HTTP2_MAX_CONCURRENT_STREAMS,
      maxHeaderListSize: HTTP2_MAX_HEADER_LIST_SIZE,
    },
  };
}

export interface ReceiveHttp2ServerOptions {
  /** How long a request may take to arrive; `HTTP2_REQUEST_TIMEOUT_MS` unless a test shortens it. */
  requestTimeoutMs?: number;
  /**
   * How long a connection with nothing on it stays open;
   * `HTTP2_SESSION_IDLE_TIMEOUT_MS` unless a test shortens it.
   */
  sessionIdleTimeoutMs?: number;
  /** Called with every stream let through, before Node's compatibility layer sees it. */
  onStream?: (stream: ServerHttp2Stream) => void;
  /**
   * The methods the routes take, and the answer to a request with any other
   * `:method`, written instead of handing it to `handler`. HTTP/2 holds
   * `:method` to no list - `FOO` and a lowercase `get` are valid tokens -
   * where Node's HTTP/1.1 parser refuses a name outside `http.METHODS` `400`
   * before Fastify sees it; Fastify's router, with no tree for such a method,
   * would log a warning that calls it a bug of its own, with the whole
   * routing tree, and answer `500`. The set may be filled once the server is
   * built, before it serves.
   */
  unroutedMethods?: {
    routed: ReadonlySet<string>;
    answer: (request: Http2ServerRequest, response: Http2ServerResponse) => void;
  };
}

/**
 * A header list's size as HTTP/2 counts it (RFC 9113 §6.5.2): the octets of
 * each field's name and value, and 32 a field. `rawHeaders` is Node's flat
 * list, every name and value a string of one character an octet; their
 * lengths are read, never their characters, so a list of references to one
 * long value costs nothing more to measure.
 */
export function headerListSize(rawHeaders: readonly string[]): number {
  let size = 0;

  for (const text of rawHeaders) {
    size += text.length;
  }

  return size + HTTP2_FIELD_OVERHEAD_BYTES * Math.floor(rawHeaders.length / 2);
}

/**
 * Whether the request's `:path` or `:authority` is longer than
 * `HTTP2_MAX_PSEUDO_HEADER_BYTES` (#208). Node gives each as a string of one
 * character an octet, so its `.length` is its octet count, as `headerListSize`
 * reads the flat list. Only these two carry a sender's bytes into the
 * HTTP/1.1-sized consumers. A `:method` that reaches Fastify is one the routes
 * take, a name of `http.METHODS`; any other is answered `404` / `1000` with a
 * fixed body before Fastify sees it (`unroutedMethods`). `:scheme` reaches
 * nothing but the stored raw request, as sent, where it is held by the list's
 * 148,608 bytes as any regular field is.
 */
function pseudoHeaderTooLong(headers: IncomingHttpHeaders): boolean {
  const path = headers[constants.HTTP2_HEADER_PATH];
  const authority = headers[constants.HTTP2_HEADER_AUTHORITY];

  return (
    (typeof path === 'string' && path.length > HTTP2_MAX_PSEUDO_HEADER_BYTES) ||
    (typeof authority === 'string' && authority.length > HTTP2_MAX_PSEUDO_HEADER_BYTES)
  );
}

/**
 * Refuses a stream whose header list is over `HTTP2_MAX_HEADER_LIST_SIZE`,
 * `RST_STREAM(ENHANCE_YOUR_CALM)`, as Node refuses one once its SETTINGS are
 * acknowledged; the connection and its other streams go on. Node reports a
 * stream closed with an error code as an `error` of the stream, which nobody
 * else listens for here.
 */
function refuseHeaderList(stream: ServerHttp2Stream): void {
  stream.on('error', () => undefined);
  stream.close(constants.NGHTTP2_ENHANCE_YOUR_CALM);
}

/**
 * Ends a request that is still arriving when its time is up: `408` when
 * nothing has been answered yet, then the stream reset with `NO_ERROR`, once
 * the answer is out. The stream is marked first (`markHttp2TimedOut`): Node
 * reads its closed stream as one whose body was sent whole, so its handler
 * and the error handler ask the mark, and nothing of it is stored.
 */
function overdue(stream: ServerHttp2Stream): void {
  if (stream.destroyed || stream.closed || http2RequestArrived(stream)) {
    return;
  }

  markHttp2TimedOut(stream);

  if (!stream.headersSent) {
    stream.respond({ ':status': 408 }, { endStream: true });
  }

  stream.close(constants.NGHTTP2_NO_ERROR);
}

type StreamListener = (
  stream: ServerHttp2Stream,
  headers: IncomingHttpHeaders,
  flags: number,
  rawHeaders: string[],
) => void;

/**
 * Node's HTTP/2 server for the receive listener, handing each request to
 * `handler` - Fastify's - with the stream rules above.
 *
 * The header list's size is enforced here as well as by Node. Node holds a
 * list to `settings.maxHeaderListSize` only once the client has acknowledged
 * the SETTINGS that announce it - nghttp2's local settings are the
 * acknowledged ones - so a list sent in a client's first flight, before its
 * ACK, as clients with prior knowledge send their first request, was held to
 * nothing but the fields' number and the session's memory: about 10 MB of
 * HTTP/2's count, which a few kilobytes of HPACK references to one long value
 * reach. Node reads a header block whole before it emits its stream, and a
 * reference to a value it has already decoded shares that value's buffer, so
 * what a list holds in memory until then is bounded by the block's
 * compressed size (nghttp2's eight `CONTINUATION` frames, about 144 KiB) and
 * by the 4,100 fields, whatever its count; what grows with the count is the
 * copies made of it afterwards - the request, the raw request, the stored
 * row. So every stream's list is measured as it is emitted, before the
 * compatibility layer builds a request of it, and one over the size is
 * refused as Node refuses it once acknowledged; its trailers too, as Node
 * holds them to the same size.
 */
export function createReceiveHttp2Server(
  handler: (request: Http2ServerRequest, response: Http2ServerResponse) => void,
  options: ReceiveHttp2ServerOptions = {},
): Http2Server {
  const requestTimeoutMs = options.requestTimeoutMs ?? HTTP2_REQUEST_TIMEOUT_MS;
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? HTTP2_SESSION_IDLE_TIMEOUT_MS;
  const unrouted = options.unroutedMethods;
  const server = http2.createServer(
    receiveHttp2ServerOptions(),
    unrouted === undefined
      ? handler
      : (request, response) => {
          if (unrouted.routed.has(request.method)) {
            handler(request, response);
          } else {
            unrouted.answer(request, response);
          }
        },
  );

  // The only close of an idle connection: Fastify sets no session timeout of
  // its own on a server its `serverFactory` builds (Fastify 5.12.1).
  server.on('session', (session) => {
    session.setTimeout(sessionIdleTimeoutMs, () => {
      session.close();
    });
  });

  // Node's compatibility layer starts listening for streams when the server
  // is given its request listener: it builds a request of every stream it
  // is emitted. Taken off, and called below with the streams let through.
  const compatibility = server.listeners('stream') as StreamListener[];

  if (compatibility.length === 0) {
    throw new Error(
      'Node’s HTTP/2 server has no compatibility layer to put the stream rules in front of',
    );
  }

  server.removeAllListeners('stream');

  // Before Node's compatibility layer sees the stream, so that it is set up
  // before its request reaches Fastify.
  const setUpStream = (stream: ServerHttp2Stream): void => {
    options.onStream?.(stream);

    stream.on(
      'trailers',
      (_trailers: IncomingHttpHeaders, _flags: number, rawTrailers: string[]) => {
        if (headerListSize(rawTrailers) > HTTP2_MAX_HEADER_LIST_SIZE) {
          refuseHeaderList(stream);
        }
      },
    );

    // The answer is out, its END_STREAM sent, and the sender has not ended
    // its stream. Its END_STREAM comes after its last DATA frame, or with the
    // trailers Node's compatibility response asks to send
    // (`waitForTrailers`), so that a reset never reaches the sender before
    // the end of the answer: RFC 9113 §8.1 asks for it after, and Node's own
    // client, reset first, keeps the stream open for ever.
    const endIfStillSending = (): void => {
      if (!stream.destroyed && !stream.closed && !http2RequestArrived(stream)) {
        stream.close(constants.NGHTTP2_NO_ERROR);
      }
    };
    let trailers = false;

    stream.once('finish', () => {
      if (!trailers) {
        endIfStillSending();
      }
    });
    // Node sends the trailers in a `setImmediate` of its own (`sendTrailers`),
    // which the compatibility response's listener, after this one, schedules:
    // the reset waits a turn more.
    stream.once('wantTrailers', () => {
      setImmediate(() => setImmediate(endIfStillSending));
    });

    // Node ends a `HEAD`'s writable side inside `respond` and emits no
    // `finish` for it (Node 24.19.0): its answer is looked at once `respond`
    // has returned.
    const respond = stream.respond;

    stream.respond = ((...args: Parameters<ServerHttp2Stream['respond']>) => {
      trailers = args[1]?.waitForTrailers === true;
      respond.apply(stream, args);

      if (stream.writableFinished) {
        process.nextTick(endIfStillSending);
      }
    }) as ServerHttp2Stream['respond'];

    if (stream.endAfterHeaders) {
      return;
    }

    // Whether its END_STREAM came before a close, which the receive routes
    // ask before they store it (`http2BodyUnproven`).
    watchHttp2Request(stream);

    const timer = setTimeout(() => overdue(stream), requestTimeoutMs);
    const clear = (): void => clearTimeout(timer);

    timer.unref();
    stream.once('end', clear);
    stream.once('close', clear);
  };

  server.on('stream', (stream, headers, flags, rawHeaders: string[]) => {
    if (headerListSize(rawHeaders) > HTTP2_MAX_HEADER_LIST_SIZE || pseudoHeaderTooLong(headers)) {
      refuseHeaderList(stream);

      return;
    }

    setUpStream(stream);

    for (const listener of compatibility) {
      listener.call(server, stream, headers, flags, rawHeaders);
    }
  });

  return server;
}
