/**
 * The calls one address has in flight on the application listener (D213): at
 * most `MAX_CALLS_IN_FLIGHT`, 128, on `/api` and `/mcp` together, waits
 * included, keyed as the per-minute limits key an address (`addressKey`, an
 * IPv6 address by its `/64`). The next is refused at once, `429` / `1019`
 * with `Retry-After: 1`, never queued.
 *
 * A limit per minute does not bound what an address holds at once: a call
 * held by `wait` keeps its request - its URL, its header lines - for up to
 * 30 s, and the fixed window lets one address start some 2,400 of them within
 * a few seconds at its edge (D201 point 4). This bounds the number, so what
 * one address can keep open is bounded far below the backend's 512 MiB.
 *
 * A place is held for as long as anything holds the request, in the shape of
 * D205's large bodies (`modules/sessions/large-bodies.ts`): by the connection
 * until the answer's response closes - once the answer has been written, once
 * Node has destroyed it with its connection, a reply hijacked when its client
 * left included, and for an answer still queued behind another on a
 * pipelined connection when Node's `socketOnClose` aborts it - and by the
 * route's handler from the moment it starts until it settles. A handler can
 * wait for one of the pool's connections or for a session's row lock with the
 * request in hand, and a client gone meanwhile neither stops that wait nor
 * frees the request; a place given back on the close alone would let an
 * address that sends calls and leaves have more than 128 held. It is given
 * back once, when neither holds it any longer.
 *
 * A request whose body the server reads or drains holds a place for as long as
 * it does, and a refusal that cannot hold one is answered at once, without
 * draining: a drain (D143) lasts as long as its client takes to send the body,
 * and keeps the request all that time. So the 129th call is refused `1019` at
 * once, its body never drained, and a call refused `1015` before its body, on a
 * connection Node is about to close, takes a place for the drain or, with none
 * free, is answered at once (`rate-limit.ts`).
 *
 * A call that is refused after it took a place, for its rate on `/mcp`
 * (`1015`, counted there once the body has arrived, D203) or because every
 * place of large bodies is taken (`1017`, D205) with nothing to drain - on a
 * connection kept alive, whose body Node discards itself once the answer is
 * written - gives its place back at once rather than when its refusal has
 * been written: nothing more of it is done. Node would keep such a request
 * until the rest of its body came, holding no place, so an answer written
 * while a body is still arriving ends its connection (`registerRateLimits`).
 * A `1017` whose body is drained keeps its place until its refusal's
 * response closes.
 *
 * The count lives in the process: there is one outside a rollout, and two for
 * its seconds, when an address may hold up to twice the limit (D221). An
 * address is kept only while it holds a place.
 *
 * A place bounds how many calls an address holds, not what their answers
 * weigh: 128 answers of about 1 MiB each, which their client leaves unread,
 * stay in the server until the connection takes them. What answers weigh
 * until their response closes is counted apart, by the answers' byte budget
 * (#184, `answer-budget.ts`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { MAX_CALLS_IN_FLIGHT } from '@webhook-inspector/shared';
import { tooManyConcurrentCalls } from '../../errors/app-error.ts';
import { createKeyedSlots, type KeyedSlots } from '../../lib/slots.ts';

/** The places of the calls in flight in one process, per address. */
export type CallPlaces = KeyedSlots;

export function createCallPlaces(limit: number = MAX_CALLS_IN_FLIGHT): CallPlaces {
  return createKeyedSlots(limit);
}

/**
 * What holds one call's place: the connection, until its response closes, and
 * the route's handler, while it runs. The place is given back when neither
 * does any longer, exactly once.
 */
interface CallHold {
  /** The address the place was taken for. */
  key: string;
  /** Gives the place back; `null` once it has been. */
  release: (() => void) | null;
  /** The response has closed: the answer is written, or the connection gone. */
  closed: boolean;
  /** The handler is running. */
  working: boolean;
  /** Given back for good, the call having been refused after it took the place. */
  refused: boolean;
}

function giveBackHold(hold: CallHold): void {
  const release = hold.release;

  hold.release = null;
  release?.();
}

export interface CallsInFlight {
  /** The places, which a test reads `taken` and `keys` of. */
  readonly places: CallPlaces;
  /**
   * Takes a place of `key` for `request`, held by its connection until its
   * response closes; `false`, taking nothing, when `key` has every place
   * taken.
   */
  take(request: FastifyRequest, reply: FastifyReply, key: string): boolean;
  /**
   * Gives `request`'s place back now and for good, whatever holds it: for a
   * call refused after it took one. Nothing for a call that holds none.
   */
  giveBack(request: FastifyRequest): void;
  /**
   * A route's handler, holding its call's place - if it took one - from the
   * moment it starts until it settles, whatever the connection does
   * meanwhile. A call whose connection went after its request had arrived and
   * before the handler started has given its place back; the handler then
   * takes one again, or, with every place of the address taken, is refused
   * as the 129th call is, to nobody, and does nothing.
   */
  holding(handler: RouteHandlerMethod): RouteHandlerMethod;
}

/**
 * The calls in flight of the listener, sharing `places`. Each call's hold is
 * kept beside its request and goes with it.
 */
export function callsInFlight(places: CallPlaces): CallsInFlight {
  const holds = new WeakMap<FastifyRequest, CallHold>();

  return {
    places,

    take(request, reply, key) {
      const release = places.tryTake(key);

      if (release === null) {
        return false;
      }

      const hold: CallHold = { key, release, closed: false, working: false, refused: false };
      const closed = (): void => {
        hold.closed = true;

        if (!hold.working) {
          giveBackHold(hold);
        }
      };

      holds.set(request, hold);

      // Set as the place is taken, so nothing that happens to the call
      // afterwards can keep the place past the close and the handler's end.
      if (reply.raw.destroyed) {
        closed();
      } else {
        reply.raw.once('close', closed);
      }

      return true;
    },

    giveBack(request) {
      const hold = holds.get(request);

      if (hold !== undefined) {
        hold.refused = true;
        giveBackHold(hold);
      }
    },

    holding(handler) {
      return async function heldHandler(
        this: FastifyInstance,
        request: FastifyRequest,
        reply: FastifyReply,
      ): Promise<unknown> {
        const hold = holds.get(request);

        if (hold === undefined) {
          return handler.call(this, request, reply);
        }

        if (hold.release === null && !hold.refused) {
          const again = places.tryTake(hold.key);

          if (again === null) {
            throw tooManyConcurrentCalls(places.limit);
          }

          hold.release = again;
        }

        hold.working = true;

        try {
          return await handler.call(this, request, reply);
        } finally {
          hold.working = false;

          if (hold.closed) {
            giveBackHold(hold);
          }
        }
      } as RouteHandlerMethod;
    },
  };
}
