import type { IncomingMessage } from 'node:http';
import { http2StreamOf, http2TimedOut } from './http2.ts';

/**
 * Whether the connection ended before the request's body had arrived (D174).
 *
 * Read from the request, never from the error. What such a request reaches the
 * error handler with is Node's `Error: aborted` (`ECONNRESET`), and a database
 * connection that drops raises the same code: the error says nothing about
 * whose end went away.
 *
 * `readableAborted` is the request stream destroyed before its end was read.
 * It is not enough alone: a request with no body is `readableAborted` too once
 * its client has gone, because nothing reads its empty stream to the end, and a
 * genuine failure on it is still a server fault. `complete` is Node's parser
 * having seen the whole message, so a request whose body - or absence of one -
 * had fully arrived is never taken for an abandoned one.
 *
 * Shared by the error handler of both listeners and by `/mcp`'s (D203).
 *
 * Over HTTP/2 the request is its stream (D263): the stream closed - reset by
 * the sender, by a GOAWAY or with its connection - before its answer was
 * written, Node's `aborted`, or ended by the request timeout, answered `408`
 * (`http2TimedOut`), as HTTP/1.1's `requestTimeout` ends its connection.
 * Node's compatibility request ends its body normally then and reports itself
 * `complete`, so neither of the two above says it.
 */
export function connectionEndedBeforeBody(request: IncomingMessage): boolean {
  const stream = http2StreamOf(request);

  if (stream !== undefined) {
    return stream.aborted || http2TimedOut(stream);
  }

  return request.readableAborted && !request.complete;
}
