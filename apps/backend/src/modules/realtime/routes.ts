import websocket, { type WebSocket } from '@fastify/websocket';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import {
  NEGOTIABLE_EVENT_TYPES,
  REALTIME_EVENTS_PARAM,
  SESSION_ID_PATTERN,
  WsCloseCode,
  type ReadyEvent,
} from '@webhook-inspector/shared';
import { routeNotFound } from '../../errors/app-error.ts';
import { chooseProtocol, protocolKey, sessionAccess } from '../sessions/access-key.ts';
import type { RealtimeConnections } from './connection-places.ts';
import type { RealtimeHub } from './hub.ts';

/** How often an idle connection is pinged, and how long a pong may take. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Keeps an idle connection alive and notices a dead one.
 *
 * A session outlives any single connection, and a viewer may leave the tab
 * open without receiving anything, while proxies close silent connections after
 * a minute.
 * The ping is what keeps the socket from being dropped and reconnected all day
 * (D079). A connection that misses a pong is terminated rather than closed:
 * the peer is not answering, so waiting for a close handshake is pointless.
 */
function startHeartbeat(socket: WebSocket): () => void {
  let awaitingPong = false;

  const timer = setInterval(() => {
    if (awaitingPong) {
      socket.terminate();

      return;
    }

    awaitingPong = true;
    socket.ping();
  }, HEARTBEAT_INTERVAL_MS);

  socket.on('pong', () => {
    awaitingPong = false;
  });

  return () => clearInterval(timer);
}

/**
 * What a connection declared it can handle, out of the optional event types.
 *
 * Split on `,`, trimmed, and intersected with the known negotiable set, so a
 * client cannot make the server retain arbitrary strings. A repeated key
 * arrives as an array and is read as one declaration. Everything that does not
 * survive the intersection is dropped silently: a malformed or unknown
 * declaration is **never** a refusal, and D076's close-code table gains no row
 * for it (D115). An absent parameter yields an empty set, which is exactly
 * today's event types.
 */
function parseEventDeclaration(declared: string | string[] | undefined): ReadonlySet<string> {
  const known: readonly string[] = NEGOTIABLE_EVENT_TYPES;
  const parts = (Array.isArray(declared) ? declared : [declared ?? '']).flatMap((value) =>
    value.split(','),
  );

  return new Set(parts.map((name) => name.trim()).filter((name) => known.includes(name)));
}

/**
 * The realtime endpoint.
 *
 * It carries notifications of captures, recorded responses, deletions and
 * response changes, and nothing else: the viewer sends no messages, and every
 * action stays on HTTP (D013, D152). A connection to a session
 * that cannot be watched is refused with the close code matching the HTTP
 * answer the same session would give (D076), and every connection of a session
 * deleted through the API is closed with `4404` once the deletion commits
 * (D198). A session that expires leaves its open connections alone (D076).
 * What it carries is what the process's listener hears from every process
 * (D221): while the process is not listening a connection is closed with
 * `1013`, and one open when the listening stops is cut.
 *
 * One address has at most 16 connections open at once (D227,
 * `connection-places.ts`): the place is taken once the headers have arrived,
 * before the upgrade, and the 17th is refused `429` / `1020` with
 * `Retry-After: 1` in the error contract's shape, never upgraded - the
 * browser sees the connection fail and reconnects after its delay (D079), so
 * no close code is added (D076). The place is given back when the socket
 * closes, or when the reply closes for a connection never upgraded.
 *
 * An HTTP request to the endpoint that is not an upgrade - a plain `GET`, a
 * `HEAD` with or without upgrade headers - is answered `404` / `1000` in the
 * error contract's shape, as a route that does not exist is (D026, D062),
 * without looking the session up.
 *
 * A keyed session is watched only by a connection that offered its access key
 * as a subprotocol of the handshake, `REALTIME_ACCESS_KEY_PROTOCOL_PREFIX`
 * and the key, or its old prefix until the day the changelog's 1.19.0 entry
 * gives, or both with the same key (D245, D279): a browser cannot set
 * `Authorization` on a socket, and the URL's path and query reach the log
 * (D168). Any other connection to it is closed `4404` by the lookup that
 * closes one to a session that does not exist, right after it, with nothing
 * awaited between: the same statement, which reads the fingerprint and the
 * expiry and nothing the session answers with (`sessionAccess`), the same
 * code and reason, and no message waited for, so its answer and its timing
 * say nothing a missing session's do not. The connection needs nothing else
 * of the session. The subprotocol answered is chosen before the session is
 * looked up (`chooseProtocol`): the first offered that carries no key, as
 * `ws` chose the first before, and never the key's, which a browser therefore
 * offers beside `REALTIME_PROTOCOL` - or beside the old `qa-tools`, as a tab
 * opened before 1.19.0 does (D279).
 */
export function realtimeRoutes(
  pool: pg.Pool,
  hub: RealtimeHub,
  connections: RealtimeConnections,
): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    await app.register(websocket, {
      options: { handleProtocols: (offered: Set<string>) => chooseProtocol(offered) },
    });

    app.route<{
      Params: { sessionId: string };
      Querystring: Partial<Record<typeof REALTIME_EVENTS_PARAM, string | string[]>>;
    }>({
      method: 'GET',
      url: '/ws/:sessionId',
      // Before the upgrade, after the listener's own hooks: the 17th
      // connection of an address is answered `429` and never upgraded. A
      // request that asks for no upgrade takes a place too, given back once
      // its answer closes.
      onRequest: async (request, reply) => {
        connections.take(request, reply);
      },
      // An HTTP request that is not an upgrade: a plain `GET`, and the `HEAD`
      // Fastify adds beside every `GET` route, with or without upgrade
      // headers - `@fastify/websocket` leaves that copy as it is, so it keeps
      // this handler, never the one below. Answered as a route that does not
      // exist, in the error contract's shape, before any session is looked up.
      handler: () => {
        throw routeNotFound();
      },
      wsHandler: async (socket, request) => {
        // Held by the socket from now on, given back when it closes.
        connections.hold(request, socket);

        const { sessionId } = request.params;
        const accepts = parseEventDeclaration(request.query[REALTIME_EVENTS_PARAM]);

        // A malformed id is refused exactly like an unknown one (D058).
        if (!SESSION_ID_PATTERN.test(sessionId)) {
          socket.close(WsCloseCode.SESSION_NOT_FOUND, 'Session not found');

          return;
        }

        // Read before the session is looked up: a session deleted after the
        // lookup found it, and before this connection is registered below, is
        // told by a change of this number (D198).
        const closedBefore = hub.closedSessions;
        const key = protocolKey(request.headers['sec-websocket-protocol']);

        // The fingerprint and the expiry, and nothing else of the session,
        // which the connection does not need: a refusal costs a keyed session
        // what it costs a missing one (D245, criterion 8).
        let access;

        try {
          access = await sessionAccess(pool, sessionId, key);
        } catch (error) {
          request.log.error({ err: error }, 'Realtime connection failed to load its session');
          socket.close(1011, 'Internal error');

          return;
        }

        // A keyed session the handshake offered no key of, or another key, is
        // refused as one that does not exist, expired or not (D245).
        if (access === 'missing') {
          socket.close(WsCloseCode.SESSION_NOT_FOUND, 'Session not found');

          return;
        }

        // Nothing inside an expired session is available, watching included
        // (D067).
        if (access === 'expired') {
          socket.close(WsCloseCode.SESSION_EXPIRED, 'Session expired');

          return;
        }

        // The viewer may have given up while the session was being loaded.
        if (socket.readyState !== socket.OPEN) {
          return;
        }

        // The process is not listening (D221): nothing would reach this
        // connection, so it is not registered. `1013`, Try Again Later, is not a
        // refusal to the viewer, which reconnects after its delay (D079) and
        // reloads on `ready` (D077). Read right before the registration, with
        // nothing awaited in between, so a deafness that begins later cuts the
        // connection with every other.
        if (hub.deaf) {
          socket.close(1013, 'Try again later');

          return;
        }

        // Registered, but held: what is published to it from now on is kept and
        // sent after its `ready`, in order, so `ready` stays the first message
        // even when the session is looked up again below (D081, D198).
        hub.hold(sessionId, socket, accepts);

        const stopHeartbeat = startHeartbeat(socket);

        socket.on('close', () => {
          stopHeartbeat();
          hub.remove(sessionId, socket);
        });

        // A deletion closes the session's registered connections once it has
        // committed (D198). One that committed while this connection was being
        // looked up and registered found nothing of it to close, and the lookup
        // above may have read the session before the deletion. So when any
        // session was closed meanwhile, the session is looked up again, now that
        // the connection is registered: a deletion committed before this second
        // lookup is seen by it, and one committed after it closes the
        // connection itself. A connection to a deleted session therefore never
        // stays open, and one that was never at risk costs nothing more. What
        // is published to the connection during this lookup is held for it, and
        // dropped with it when it is closed.
        //
        // The same statement and key as the first lookup: the key opened the
        // session then and a fingerprint never changes (D245), so `missing` is
        // a session gone since.
        if (hub.closedSessions !== closedBefore) {
          let current;

          try {
            current = await sessionAccess(pool, sessionId, key);
          } catch (error) {
            request.log.error({ err: error }, 'Realtime connection failed to load its session');
            hub.remove(sessionId, socket);
            socket.close(1011, 'Internal error');

            return;
          }

          if (current === 'missing') {
            hub.remove(sessionId, socket);
            socket.close(WsCloseCode.SESSION_NOT_FOUND, 'Session not found');

            return;
          }

          // Closed meanwhile - by the deletion itself, or by the viewer - so
          // there is nothing left to announce.
          if (socket.readyState !== socket.OPEN) {
            return;
          }
        }

        // Announced only now, and this is what the viewer waits for before
        // reloading the list. The handshake was accepted before the session was
        // even looked up, so a viewer that reloaded then could have missed a
        // request captured while this subscription was still being set up
        // (D081). It does not echo the negotiated set: the client knows what it
        // asked for, and the server's answer is observable in what it sends
        // (D115). Whatever was held for the connection follows it at once, in
        // the order it was published, and every later event as it is published.
        hub.release(sessionId, socket, JSON.stringify({ type: 'ready' } satisfies ReadyEvent));
      },
    });
  };
}
