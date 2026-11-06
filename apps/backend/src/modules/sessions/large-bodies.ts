/**
 * How many large bodies of `PUT /api/sessions/:sessionId/queue` and
 * `POST /api/sessions` one process handles at once (D205): eight, across
 * both routes - and, since D213, across `PUT
 * /api/sessions/:sessionId/response`, `POST /api/sessions/status`, `POST
 * /api/sessions/:sessionId/requests/search`, `POST
 * /api/sessions/:sessionId/requests/query` and `POST /mcp` too, and, since
 * D246, `PUT /api/sessions/:sessionId/rules`: eight routes in all. `/mcp`
 * gives its place back once its message is read (`release`).
 *
 * A valid queue of 1 MiB is read, decoded, parsed, checked, written to `jsonb`
 * and answered whole, with several copies of it alive at once per call, and a
 * body of text V8 holds in two bytes a character costs twice that again.
 * Sent from one client, well within its 1200 calls a minute, 100 to 120 such
 * saves at once killed the 512 MiB backend, below the
 * receiver's own margin. A limit per minute bounds none of that, so the large
 * bodies being handled are counted, as list answers with bodies are (D201):
 * the ninth is refused at once, `429` / `1017` with `Retry-After`, never
 * queued.
 *
 * The place is taken on `onRequest`, once the headers have arrived and before
 * a byte of the body is read, and held for as long as anything holds the body
 * (so that at most eight large bodies are held at once): by the connection until
 * the answer's response closes - once the answer has been written, or as
 * soon as the connection goes - and by the route's handler from the moment it
 * starts until it settles. A handler can wait for a connection of the pool or
 * for the session's row lock with the parsed queue in hand, and a client gone
 * meanwhile neither stops that wait nor frees the memory; a place given back
 * on the close alone let clients that send whole bodies and go admit more
 * than eight while the earlier ones were still held. A call that never reaches
 * its handler - a client gone in the middle of its body, a `413`, a body
 * that is not JSON - gives it back when its response closes, as before.
 *
 * Large is what the framing says before the body is read: a `Content-Length`
 * over `LARGE_BODY_THRESHOLD_BYTES` and within the 1 MiB body limit, a chunked
 * body, whose length nobody knows yet, and framing the headers do not settle.
 * A body declared over 1 MiB takes none: it is refused `413` before it is
 * read. A creation with no body, and a response or a few steps written as
 * ordinary text with a `Content-Length`, are under the threshold and never
 * wait for a place; the same sent chunked does.
 *
 * The count lives in the process: there is one outside a rollout, and two for
 * its seconds (D221).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  LARGE_BODY_THRESHOLD_BYTES,
  MAX_BODY_BYTES,
  MAX_CONCURRENT_LARGE_BODIES,
} from '@webhook-inspector/shared';
import { largeBodiesBusy } from '../../errors/app-error.ts';
import { createSlots, type Slots } from '../../lib/slots.ts';
import { headerValues } from './media-type.ts';
import { drainRequestBody, shouldDrainRefusedBody } from './refused-body.ts';

/** The places of large queue-bearing bodies in one process. */
export type LargeBodyPlaces = Slots;

export function createLargeBodyPlaces(
  limit: number = MAX_CONCURRENT_LARGE_BODIES,
): LargeBodyPlaces {
  return createSlots(limit);
}

/** A declared length: digits only, as RFC 9110 defines `Content-Length`. */
const CONTENT_LENGTH = /^\d+$/;

/**
 * Whether a request's body is a large one, which takes a place, from its
 * framing headers alone. Pure, so the rule can be tested without a server.
 *
 * - no `Content-Length` and no `Transfer-Encoding`: no body, none;
 * - `Transfer-Encoding`, chunked or anything else: its length is unknown
 *   until it has been read, so it takes one;
 * - one `Content-Length` of plain digits: one when it is over
 *   `LARGE_BODY_THRESHOLD_BYTES` and at most `MAX_BODY_BYTES`; a larger one
 *   is refused `413` before it is read, and a smaller one costs too little to
 *   count;
 * - anything else - a repeated `Content-Length`, even with equal values, or
 *   one that is not plain digits: one, since the headers do not settle what
 *   will be read. Node's parser normally refuses such a request before it
 *   gets here.
 */
export function isLargeBody(rawHeaders: string[]): boolean {
  if (headerValues(rawHeaders, 'transfer-encoding').length > 0) {
    return true;
  }

  const lengths = headerValues(rawHeaders, 'content-length');

  if (lengths.length === 0) {
    return false;
  }

  if (lengths.length > 1) {
    return true;
  }

  const declared = (lengths[0] as string).trim();

  if (!CONTENT_LENGTH.test(declared)) {
    return true;
  }

  const length = Number(declared);

  return length > LARGE_BODY_THRESHOLD_BYTES && length <= MAX_BODY_BYTES;
}

/**
 * What holds one large body's place: the connection, until its response
 * closes, and the route's handler, while it runs. The place is given back
 * when neither does any longer, exactly once.
 */
interface PlaceHold {
  /** Gives the place back; `null` once it has been. */
  release: (() => void) | null;
  /** The response has closed: the answer is written, or the connection gone. */
  closed: boolean;
  /** The handler is running, with the body read. */
  working: boolean;
}

function giveBack(hold: PlaceHold): void {
  const release = hold.release;

  hold.release = null;
  release?.();
}

type Handler<Request extends FastifyRequest, Result> = (
  request: Request,
  reply: FastifyReply,
) => Promise<Result>;

export interface LargeBodyHandling {
  /**
   * The `onRequest` hook of the eight routes: takes a place for a large body,
   * or refuses the request `429` / `1017` when every place is taken. Placed
   * after the media-type guard, so a body refused `415` - never read - takes
   * none, and after the per-address limits, whose hook runs before any
   * route's (D201), so a refused creation takes none either.
   *
   * A refusal answers with the body unread, as the per-address limits and the
   * media-type guard do: on a connection Node is about to close, the body is
   * read and discarded first, within D143's bound, or the close would be a
   * reset that loses the answer. Discarded as it arrives, it is never held,
   * but the request is, for as long as the client takes to send it: such a
   * call keeps the place it took among its address's calls in flight until
   * its refusal's response closes, so that the drains count toward the 128
   * (D213). Any other refused call - kept alive, Node discarding the body itself
   * once the answer is written, or with nothing it would drain - is handed to
   * `onRefusal`, which gives that place back at once, so that it holds
   * neither; its answer ends its connection when the body is still arriving
   * (`registerRateLimits`).
   */
  guard: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /**
   * The route's handler, holding its call's place - if it took one - from the
   * moment it starts until it settles, whatever the connection does
   * meanwhile. A call whose connection went after its body was read and
   * before the handler started has given its place back; the handler then
   * takes one again, or, with every place taken, is refused as the ninth
   * body is, to nobody, and nothing is written.
   */
  holding: <Request extends FastifyRequest, Result>(
    handler: Handler<Request, Result>,
  ) => Handler<Request, Result>;
  /**
   * Gives back the place `request` took, now and for good, for a route that
   * has let its body go and keeps nothing large of it: `POST /mcp` once its
   * message is read and checked, which a `wait_for_request` then holds for up
   * to 30 s with nothing but its arguments (D213). Nothing for a call that
   * took none.
   */
  release: (request: FastifyRequest) => void;
}

/**
 * The guard and the handler wrapper of the eight routes, sharing `places`.
 *
 * The connection's hold is set as the place is taken, so nothing that happens
 * to the call afterwards can keep the place past the close and the handler's
 * end: Node signals the close once the answer has been written and when the
 * connection goes before that, and the handler's hold ends in a `finally`.
 * Each call's hold is kept beside its request and goes with it.
 *
 * `onRefusal` is told of every call the guard refuses `1017` without
 * draining its body, before the refusal; the listener gives its place among
 * the calls in flight back there. A call whose body is drained is not told:
 * it keeps that place until its response closes (D213).
 */
export function largeBodyHandling(
  places: LargeBodyPlaces,
  onRefusal: (request: FastifyRequest) => void = () => undefined,
): LargeBodyHandling {
  const holds = new WeakMap<FastifyRequest, PlaceHold>();

  return {
    async guard(request, reply) {
      if (!isLargeBody(request.raw.rawHeaders)) {
        return;
      }

      const release = places.tryTake();

      if (release === null) {
        // A drain keeps the request for as long as its client takes to send
        // the body, so the call keeps its place among its address's calls in
        // flight while it is drained, given back when the refusal's response
        // closes; one with nothing to drain gives it back now (D213).
        if (shouldDrainRefusedBody(request.raw.rawHeaders, reply.raw.shouldKeepAlive)) {
          await drainRequestBody(request.raw);
        } else {
          onRefusal(request);
        }

        throw largeBodiesBusy();
      }

      const hold: PlaceHold = { release, closed: false, working: false };
      const closed = (): void => {
        hold.closed = true;

        if (!hold.working) {
          giveBack(hold);
        }
      };

      holds.set(request, hold);

      if (reply.raw.destroyed) {
        closed();
      } else {
        reply.raw.once('close', closed);
      }
    },

    holding(handler) {
      return async (request, reply) => {
        const hold = holds.get(request);

        if (hold === undefined) {
          return handler(request, reply);
        }

        if (hold.release === null) {
          const again = places.tryTake();

          if (again === null) {
            throw largeBodiesBusy();
          }

          hold.release = again;
        }

        hold.working = true;

        try {
          return await handler(request, reply);
        } finally {
          hold.working = false;

          if (hold.closed) {
            giveBack(hold);
          }
        }
      };
    },

    release(request) {
      const hold = holds.get(request);

      if (hold !== undefined) {
        giveBack(hold);
      }
    },
  };
}
