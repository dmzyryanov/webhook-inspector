/**
 * The realtime connections each address has open (D227): at most
 * `MAX_REALTIME_CONNECTIONS_PER_ADDRESS`, 16, on `/ws/<session-id>`, keyed as
 * the API's limits key an address (`addressKey(request.ip)`, an IPv6 address
 * by its `/64`, an IPv4-mapped one as its IPv4). The next is refused before
 * its upgrade, `429` / `1020` with `Retry-After: 1`, never queued.
 *
 * A connection that stops reading keeps what is published to it, up to its
 * 4 MiB backlog beside the kernel's send buffer (D205 point 13), so that
 * bound is per connection, and before this one nothing bounded how many
 * connections one address held: some 60 to 150 sockets that stopped reading
 * could fill the backend's headroom with one `Run again` (D205's "Slow
 * sockets can still fill the headroom together"). 16 rather than the 32 first
 * decided: 32 such sockets on a session whose every event is 1.8 MiB cost the
 * backend 128 to 178 MiB, measured, its process's memory and the kernel's
 * socket buffers together, and 16 cost 79 to 86 MiB (D227).
 *
 * The place is taken in the route's `onRequest` hook, once the request line
 * and headers have arrived and before the upgrade, and given back exactly
 * once: when the connection's socket closes, or, when the upgrade never
 * happens - the handshake refused, the client gone first, a plain `GET` or a
 * `HEAD` answered `404` / `1000` (#179) - when the reply's response closes.
 * Node emits the response's `close` when its socket closes as well, so an
 * upgraded connection gives its place back on whichever is seen first.
 *
 * The count lives in the process: there is one outside a rollout, and two for
 * its seconds, when an address may have up to twice the limit open (D221). An
 * address is kept only while it holds a place.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MAX_REALTIME_CONNECTIONS_PER_ADDRESS } from '@webhook-inspector/shared';
import { tooManyRealtimeConnections } from '../../errors/app-error.ts';
import { createKeyedSlots, type KeyedSlots } from '../../lib/slots.ts';
import { addressKey } from '../limits/rate-limit.ts';

/** The places of the realtime connections in one process, per address. */
export type RealtimePlaces = KeyedSlots;

export function createRealtimePlaces(
  limit: number = MAX_REALTIME_CONNECTIONS_PER_ADDRESS,
): RealtimePlaces {
  return createKeyedSlots(limit);
}

/** What a connection's socket must offer to hold its place: its `close`. */
export interface ClosingSocket {
  readonly readyState: number;
  readonly CLOSED: number;
  once(event: 'close', listener: () => void): unknown;
}

export interface RealtimeConnections {
  /** The places, which a test reads `taken`, `takenBy` and `keys` of. */
  readonly places: RealtimePlaces;
  /**
   * The route's `onRequest` hook: takes a place of the request's address,
   * held until the reply's response closes, or throws `429` / `1020` when
   * the address has every place taken.
   */
  take(request: FastifyRequest, reply: FastifyReply): void;
  /**
   * The upgraded connection's socket holds the place `request` took, until it
   * closes. Nothing for a request that took none.
   */
  hold(request: FastifyRequest, socket: ClosingSocket): void;
}

/** The realtime connections of the listener, sharing `places`. */
export function realtimeConnections(places: RealtimePlaces): RealtimeConnections {
  const releases = new WeakMap<FastifyRequest, () => void>();

  return {
    places,

    take(request, reply) {
      const release = places.tryTake(addressKey(request.ip));

      if (release === null) {
        throw tooManyRealtimeConnections(places.limit);
      }

      releases.set(request, release);

      // Set as the place is taken, so that nothing that happens to the
      // request afterwards can keep the place past the close of its socket.
      if (reply.raw.destroyed) {
        release();
      } else {
        reply.raw.once('close', release);
      }
    },

    hold(request, socket) {
      const release = releases.get(request);

      if (release === undefined) {
        return;
      }

      if (socket.readyState === socket.CLOSED) {
        release();
      } else {
        socket.once('close', release);
      }
    },
  };
}
