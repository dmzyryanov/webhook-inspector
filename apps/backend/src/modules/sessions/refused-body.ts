/**
 * How a connection ends after the create route refuses a request before its
 * body is read (D143).
 *
 * The media-type guard answers on `onRequest`, before a byte of the body is
 * read (D104). When Node then closes the connection with body bytes still
 * arriving, the close is a TCP reset, and a reset discards whatever the client
 * has received but not yet read - the refusal included. So before answering, a
 * body is read and discarded, but only when it is known in advance that the
 * read will finish: a drain cut short while data is still in flight makes the
 * reset certain rather than possible, which is worse than not draining.
 *
 * Decided from the headers alone, before any of the body is read:
 *
 * - the connection will be kept alive: nothing, Node drains the body itself
 *   once the answer is written, and reuses the connection;
 * - no body framed: nothing, there is nothing in flight;
 * - a `Content-Length` of at most `MAX_REFUSAL_DRAIN_BYTES`: read and discard
 *   the body to its end, then answer;
 * - anything else, `Transfer-Encoding: chunked` included: answer at once, and
 *   the answer can still be lost to a client that is sending.
 *
 * `drainRefusedBody` also bounds how many drains run at once: the capture
 * refusals on the receive host (`1018`) and the application listener's
 * `/s/…` `410` (D187) share `refusalDrainPlaces`, at most
 * `MAX_CONCURRENT_REFUSAL_DRAINS`, 8, in the process (D228), since a flood of
 * refusals draining their 1 MiB bodies at once was what drove its memory up
 * (D210 point 11). A refusal that finds no place is answered at once, as the
 * last row answers, its body unread and its connection ended. The application
 * listener's other refusals before the body (`1015`, `1017`, the media-type
 * `415`, `/mcp`'s) drain while their call holds a place among its address's
 * calls in flight, 128 (D213), and drain with `drainRequestBody` as before;
 * `/s/…` takes no such place, so the 8 places are what bounds its drains.
 */
import type { IncomingMessage } from 'node:http';
import { MAX_BODY_BYTES, MAX_CONCURRENT_REFUSAL_DRAINS } from '@webhook-inspector/shared';
import { createSlots, type Slots } from '../../lib/slots.ts';
import { framesNoBody, headerValues } from './media-type.ts';

/**
 * The largest body read and discarded before a refusal is answered. Four times
 * the body limit, so that a body a little over the limit and sent with the wrong
 * `Content-Type` is still covered. The bytes are discarded as they arrive, never
 * buffered, so what this bounds is time on a socket rather than memory.
 */
export const MAX_REFUSAL_DRAIN_BYTES = 4 * MAX_BODY_BYTES;

/** A declared length: digits only, as RFC 9110 defines `Content-Length`. */
const CONTENT_LENGTH = /^\d+$/;

/**
 * Whether a refused request's body should be read and discarded before the
 * refusal is answered. Pure, so the rule can be tested without a server.
 *
 * `keepAlive` is the response's `shouldKeepAlive`: Node's reading of the
 * request, set before the request reaches Fastify, and false for
 * `Connection: close` and for HTTP/1.0 without `Connection: keep-alive`. Node
 * can still end a kept-alive connection when the answer is written, but on
 * none of the grounds that could apply to this refusal (D143).
 *
 * Anything the headers do not settle beyond doubt - a repeated
 * `Content-Length`, even with identical values, or one that is not a plain
 * decimal - is answered at once rather than drained: Node's parser has normally
 * refused such a request before it gets here, and a drain that might not end
 * where it was expected to is the case that must not be entered.
 */
export function shouldDrainRefusedBody(rawHeaders: string[], keepAlive: boolean): boolean {
  if (keepAlive) {
    return false;
  }

  if (headerValues(rawHeaders, 'transfer-encoding').length > 0) {
    return false;
  }

  const lengths = headerValues(rawHeaders, 'content-length');

  if (lengths.length !== 1) {
    return false;
  }

  const declared = (lengths[0] as string).trim();

  if (!CONTENT_LENGTH.test(declared)) {
    return false;
  }

  const length = Number(declared);

  return length > 0 && length <= MAX_REFUSAL_DRAIN_BYTES;
}

/**
 * Whether `request` frames a body that has not all arrived yet: Node's parser
 * has not read its end. Answered so on a connection kept alive, a call leaves
 * its request behind, which Node keeps until the rest of the body has come and
 * been discarded - up to the 90 s of `requestTimeout` for a client that stalls
 * - while nothing that counts the calls in flight holds it any longer. So such
 * an answer ends its connection (`Connection: close`), and the request goes
 * with it (D213): on `/api` and `/mcp` since 0.52.1, and on every answer
 * of both listeners since D227 (`createApp`'s `onSend`, `server.ts`), the
 * receiver's reply to a captured webhook included (`webhook/routes.ts`). A body
 * that has arrived whole, or none framed, leaves the connection as it was.
 *
 * Read from `complete`, which Node's parser sets once it has read the end of
 * the message, not from `readableEnded`: a body read whole and not consumed
 * is in the process already, and Node discards it at once. Only `false`
 * counts, so a request that is not Node's - Fastify's injection has no parser
 * - is never taken for one still arriving. The framing headers are read as
 * well, so a request that frames no body is never taken for one, whenever it
 * is answered.
 *
 * An HTTP/2 request never asks it: no answer ends an HTTP/2 connection, and
 * one written before its stream has ended ends that stream alone, with
 * `RST_STREAM(NO_ERROR)` once written (`createReceiveHttp2Server`, D263).
 */
export function isBodyArriving(request: Pick<IncomingMessage, 'complete' | 'rawHeaders'>): boolean {
  return request.complete === false && !framesNoBody(request.rawHeaders);
}

/**
 * Reads the rest of a request body and discards it, resolving once the body has
 * ended or the request has gone.
 *
 * It sets no timer of its own, deliberately: a timer firing while data is in
 * flight produces exactly the reset the drain exists to avoid. What bounds it is
 * the size rule above and, as for any request whose body is read, the server's
 * `requestTimeout` of 90 s on a direct connection and Traefik's `readTimeout` of
 * 60 s in production (D143, D172).
 */
export function drainRequestBody(request: IncomingMessage): Promise<void> {
  if (request.readableEnded || request.destroyed) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const settle = (): void => {
      request.off('end', settle);
      request.off('close', settle);
      request.off('error', settle);
      resolve();
    };

    request.on('end', settle);
    request.on('close', settle);
    request.on('error', settle);
    request.resume();
  });
}

/**
 * The process's places for draining the receive host's refused webhook bodies
 * (D228, the `1018` capture refusals): what a drain costs is the process's - a
 * socket read again, whose receive buffer the kernel grows for a reader this
 * fast, charged to the backend's memory (D210 point 5). Measured before it,
 * 485 refusals of `GET`s declaring 1 MiB, answered together when their 30 s
 * ran out, drained their bodies at once and took the backend to 300 to
 * 498 MiB of its 512 MiB (D210 point 11). The application listener's `/s/…`
 * `410` drains with them too: `/s/…` holds no place among an address's calls
 * in flight (D213), so nothing else bounds those drains. The listener's other
 * refusals drain while their call holds such a place, 128 an address, and are
 * not counted here.
 */
export function createRefusalDrainPlaces(limit = MAX_CONCURRENT_REFUSAL_DRAINS): Slots {
  return createSlots(limit);
}

/** The process's drain places, the receiver's `1018` and `/s/…`'s `410` sharing them (D228). */
export const refusalDrainPlaces: Slots = createRefusalDrainPlaces();

/**
 * How a refused request's body was dealt with before its refusal is
 * answered: `none` when D143's rule drains nothing - a connection kept alive,
 * no body framed, framing it cannot be sure of; `drained` when it was read to
 * its end, or until its client left; `no-place` when it should have been and
 * every drain place was taken, so the refusal is answered at once, its body
 * unread, and Node ends its connection, which is not kept alive.
 */
export type RefusalDrain = 'none' | 'drained' | 'no-place';

/**
 * Drains a refused request's body before its refusal is answered, as D143
 * decides from its headers, holding one of `places` while it does - the
 * process's own unless a test passes others - and answers how (D228). A drain
 * holds its place until the body has ended or the request has gone, however
 * long its client takes, which the server's `requestTimeout` and Traefik's
 * `readTimeout` bound (D172).
 */
export async function drainRefusedBody(
  request: IncomingMessage,
  keepAlive: boolean,
  places: Slots = refusalDrainPlaces,
): Promise<RefusalDrain> {
  if (!shouldDrainRefusedBody(request.rawHeaders, keepAlive)) {
    return 'none';
  }

  const release = places.tryTake();

  if (release === null) {
    return 'no-place';
  }

  try {
    await drainRequestBody(request);
  } finally {
    release();
  }

  return 'drained';
}
