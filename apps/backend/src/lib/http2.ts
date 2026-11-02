/**
 * What the receive listener's HTTP/2 path asks of a request and its answer
 * (D263). An HTTP/2 request reaches the routes as Node's compatibility
 * request, `Http2ServerRequest`, over a stream of its connection's session;
 * the checks that differ from HTTP/1.1 ask these, and an HTTP/1.1 request
 * answers `undefined` or `false` to every one of them.
 *
 * Told apart by the object, never by `httpVersion`: Node's HTTP/1.1 parser
 * takes a request line that says `HTTP/2.0` and reports `2.0` for it, and
 * such a request stays an HTTP/1.1 capture.
 */
import { Http2ServerRequest, Http2ServerResponse, type ServerHttp2Stream } from 'node:http2';

/** The HTTP/2 stream `request` came on, or `undefined` for an HTTP/1.1 request. */
export function http2StreamOf(request: object): ServerHttp2Stream | undefined {
  return request instanceof Http2ServerRequest ? request.stream : undefined;
}

/** The HTTP/2 stream `response` is written to, or `undefined` for an HTTP/1.1 response. */
export function http2ResponseStreamOf(response: object): ServerHttp2Stream | undefined {
  return response instanceof Http2ServerResponse ? response.stream : undefined;
}

/**
 * Whether the request has all arrived: its stream ended with its `HEADERS`
 * frame, a request with no body, or the end of its body has been read. Node
 * gives the body of a stream closed before its `END_STREAM` an end too, read
 * the same way as one sent whole: whether the sender's `END_STREAM` came is
 * `http2BodyUnproven`'s question.
 */
export function http2RequestArrived(stream: ServerHttp2Stream): boolean {
  return stream.endAfterHeaders || stream.readableEnded;
}

/** The streams the request timeout ended (`createReceiveHttp2Server`'s `overdue`). */
const timedOutStreams = new WeakSet<ServerHttp2Stream>();

/**
 * Records that `stream`'s request was still arriving when its time was up,
 * before it is answered `408` and closed. Node sets `aborted` only on a stream
 * closed before its answer has begun to end, and the `408` ends it first: the
 * mark is what tells such a stream from one sent whole.
 */
export function markHttp2TimedOut(stream: ServerHttp2Stream): void {
  timedOutStreams.add(stream);
}

/** Whether the request timeout ended `stream` (`markHttp2TimedOut`). */
export function http2TimedOut(stream: ServerHttp2Stream): boolean {
  return timedOutStreams.has(stream);
}

/** The streams that closed after Node had read their sender's `END_STREAM` and handed on every byte before it. */
const endedWhole = new WeakSet<ServerHttp2Stream>();

/**
 * Whether Node has read the end of `stream`'s request, its sender's
 * `END_STREAM` - on a `DATA` frame or on its trailers - and handed on every
 * byte that came before it. Node marks the stream's readable side ended as
 * it reads the flag; `readableEnded`, the public sign, waits for the `end`
 * event, which comes a turn later, and for frames Node reads in one batch -
 * the bytes the preface layer puts back, a connection that is not a socket -
 * only after a reset read in the same batch. Node's own mark is read, and
 * `readableEnded` stands in where it is missing.
 */
function endStreamRead(stream: ServerHttp2Stream): boolean {
  const readable = (stream as { _readableState?: { ended?: unknown } })._readableState;

  return stream.readableLength === 0 && (stream.readableEnded || readable?.ended === true);
}

/**
 * Watches `stream`'s request for a close before its `END_STREAM` (D263),
 * before Node's compatibility layer builds a request of it. Node reports a
 * stream closed before its answer has begun to end - reset by its sender,
 * ended by a GOAWAY or gone with its connection - as `aborted` while it
 * closes it, before it ends the stream's readable side for the close; what
 * the stream had read by then is recorded. A stream closed before Node
 * emitted it, in the read that brought its `HEADERS`, is recorded nothing:
 * nothing had read its body, which Node discards with the stream.
 */
export function watchHttp2Request(stream: ServerHttp2Stream): void {
  stream.once('aborted', () => {
    if (endStreamRead(stream)) {
      endedWhole.add(stream);
    }
  });
}

/**
 * Whether the body read from `stream` may not be whole (D263), so that it is
 * not stored: a request is stored only once its sender's `END_STREAM` has
 * come, and every byte before it has been read, whatever its framing.
 *
 * - The request timeout ended the stream, answered `408`: Node ends the body
 *   of a stream it closes as it ends one sent whole, and a request answered
 *   `408` is never stored, as over HTTP/1.1.
 * - The stream has closed - reset by its sender, ended by a GOAWAY or gone
 *   with its connection - and `watchHttp2Request` did not see its
 *   `END_STREAM` read before: Node ends the body of such a stream all the
 *   same, with what had come by then, a `Content-Length` met or not. A
 *   stream whose `END_STREAM` came before its reset, in the same read or
 *   not, is whole, and stored; its answer is `aborted`.
 * - The stream is open and its readable side has not ended: no `END_STREAM`
 *   yet. A handler whose body Fastify has read to its end never sees this.
 */
export function http2BodyUnproven(stream: ServerHttp2Stream): boolean {
  if (stream.endAfterHeaders) {
    return false;
  }

  if (http2TimedOut(stream)) {
    return true;
  }

  return stream.closed ? !endedWhole.has(stream) : !stream.readableEnded;
}

/**
 * Whether the answer's way to the sender has gone: an HTTP/1.1 response
 * destroyed with its connection, an HTTP/2 stream closed or reset. Node's
 * compatibility response has no `destroyed` of its own.
 */
export function isAnswerGone(response: { destroyed?: boolean }): boolean {
  const stream = http2ResponseStreamOf(response);

  return stream === undefined ? response.destroyed === true : stream.destroyed || stream.closed;
}
