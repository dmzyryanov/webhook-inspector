import {
  NEGOTIABLE_EVENT_TYPES,
  OLD_REALTIME_ACCESS_KEY_PROTOCOL_PREFIX,
  REALTIME_ACCESS_KEY_PROTOCOL_PREFIX,
  REALTIME_EVENTS_PARAM,
  REALTIME_PROTOCOL,
  WsCloseCode,
  type RequestDeletedEvent,
  type RequestReceivedEvent,
  type ResponseRecordedEvent,
  type ServerEvent,
  type SessionUpdatedEvent,
} from '@webhook-inspector/shared';
import { isAccessKey } from '../lib/access-keys.ts';
import { withListPath } from '../lib/requests.ts';

/** Backoff between reconnection attempts, in milliseconds. */
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15_000;

/**
 * How long a connection must last to count as having worked.
 *
 * It is the backend's ping interval (D079): a connection that lives through one
 * ping cycle has exchanged traffic with the server, rather than merely having
 * had its handshake accepted.
 */
const HEALTHY_CONNECTION_MS = 30_000;

/**
 * The delay before the next attempt, given the delay before the last one and
 * how long the connection that just ended stayed open.
 *
 * The handshake is accepted before the backend knows whether it can serve the
 * session, so a connection can open and be closed immediately - by a database
 * failure, for instance. Treating `open` as success would reset the sequence
 * every time and hammer a struggling backend once a second forever, which is
 * exactly what the growing delay exists to prevent. Only a connection that
 * lasted starts the sequence over.
 */
export function nextRetryDelay(previousDelayMs: number, connectionLifetimeMs: number): number {
  if (connectionLifetimeMs >= HEALTHY_CONNECTION_MS) {
    return FIRST_RETRY_MS;
  }

  return Math.min(Math.max(previousDelayMs * 2, FIRST_RETRY_MS), MAX_RETRY_MS);
}

/**
 * The socket URL for one session, carrying this client's declaration of the
 * optional events it can handle (D115).
 *
 * Module-level and pure, and it never derives the declaration from mutable
 * state. That is a constraint D115 puts on this function rather than a style
 * choice: the reconnection path reuses one URL value, so a declaration computed
 * from anything that can change would be silently dropped on the reconnect that
 * follows a pod replacement - the exact moment the guarantee is needed.
 *
 * A connection that declares nothing receives exactly the event types of
 * v0.4.0, which is what makes every already-built client correct unchanged.
 */
export function sessionSocketUrl(sessionId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const events = encodeURIComponent(NEGOTIABLE_EVENT_TYPES.join(','));

  return `${protocol}//${window.location.host}/ws/${sessionId}?${REALTIME_EVENTS_PARAM}=${events}`;
}

/**
 * The subprotocols a connection offers (D245 point 5, D259, D279): none for a
 * public session, whose handshake stays as it always was, and for a private
 * one `webhook-inspector`, which the server echoes, then the key under
 * `webhook-inspector.access-key.` and under the old `qa-tools.access-key.`,
 * which it never does - a browser fails a handshake that offered subprotocols
 * and was answered none. The key goes in the handshake's
 * `Sec-WebSocket-Protocol`, never in the URL, whose path and query the log
 * keeps (D168). A value of any other shape is no key and offers nothing.
 *
 * The old prefix is offered until the old names stop, on the day the
 * changelog's 1.19.0 entry gives, so that a backend of an earlier release,
 * still answering while the backend rolls (D221), reads the key too: it reads
 * only the old prefix. The order is what keeps that backend from echoing the
 * key: it answers the first name offered that does not start with the old
 * prefix, which is `webhook-inspector`, ahead of the key under the new one.
 */
export function sessionSocketProtocols(accessKey: string | null): string[] | undefined {
  return accessKey !== null && isAccessKey(accessKey)
    ? [
        REALTIME_PROTOCOL,
        `${REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${accessKey}`,
        `${OLD_REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${accessKey}`,
      ]
    : undefined;
}

/**
 * What one incoming frame turns out to be.
 *
 * `ignored` covers both an unreadable frame and a type this client does not
 * handle, and it is the outcome that matters: it is what keeps a frame that is
 * not `request.received` out of `mergeRequests`.
 */
export type RoutedMessage =
  | { kind: 'ready' }
  | { kind: 'request'; event: RequestReceivedEvent }
  | { kind: 'response'; event: ResponseRecordedEvent }
  | { kind: 'deleted'; event: RequestDeletedEvent }
  | { kind: 'cleared' }
  | { kind: 'session'; event: SessionUpdatedEvent }
  | { kind: 'ignored' };

/**
 * Decides what an incoming frame is, by type and never by "everything that was
 * not `ready`" (D110).
 *
 * Extracted from `openSessionSocket` so the decision can be tested without a
 * DOM (D070, D114): the guard it carries is the thing that stops a
 * `response.recorded` frame from reaching `mergeRequests` and overwriting a
 * real list row with a `{ id, response }` object that has no method, no
 * timestamp and no size.
 */
export function routeServerMessage(raw: string): RoutedMessage {
  let event: ServerEvent;

  try {
    event = JSON.parse(raw) as ServerEvent;
  } catch {
    // A frame this client cannot read is not worth breaking the connection
    // over; the list still reloads on the next reconnect.
    return { kind: 'ignored' };
  }

  if (event === null || typeof event !== 'object') {
    return { kind: 'ignored' };
  }

  switch (event.type) {
    case 'ready':
      return { kind: 'ready' };

    case 'request.received':
      // A backend before 0.30.0 sends no `path` (D180).
      return {
        kind: 'request',
        event: { ...event, data: withListPath(event.data) },
      };

    case 'response.recorded':
      return { kind: 'response', event };

    case 'request.deleted':
      return { kind: 'deleted', event };

    case 'requests.cleared':
      return { kind: 'cleared' };

    case 'session.updated':
      return { kind: 'session', event };

    default:
      return { kind: 'ignored' };
  }
}

export interface SessionSocketHandlers {
  /**
   * The connection is subscribed to its session. Called on the first connection
   * and on every reconnection, so the caller can reload the list and pick up
   * whatever arrived while the socket was down (D077).
   *
   * This is the server saying it is watching, not the socket saying it is open:
   * the two are not the same moment, and reloading at the earlier one loses
   * anything captured in between (D081).
   */
  onReady: () => void;
  /** A newly captured request: the only event that may add a row (D110). */
  onRequest: (event: RequestReceivedEvent) => void;
  /**
   * One response record reaching a terminal state. It carries the light summary
   * rather than a list row, so an id the viewer does not hold is dropped rather
   * than materialised into a request with no method, time or size (D110).
   */
  onResponse: (event: ResponseRecordedEvent) => void;
  /**
   * One request was deleted, by this viewer or by another one of the same
   * session. Applying it is idempotent, so the viewer that deleted it applies
   * its own event like everyone else's (D136).
   */
  onDeleted: (event: RequestDeletedEvent) => void;
  /** Every request of the session was deleted, by this viewer or another. */
  onCleared: () => void;
  /**
   * The session's response was changed, by this viewer or another. It carries
   * the whole new state, so applying it twice changes nothing (D152).
   */
  onSessionUpdated: (event: SessionUpdatedEvent) => void;
  /**
   * The server refused to watch this session: it does not exist or it has
   * expired. Also called when an established connection is closed with
   * `4404` because its session was deleted (D198), which reads the same way.
   * Nothing is retried afterwards.
   */
  onRefused: (code: WsCloseCode) => void;
}

function isRefusal(code: number): code is WsCloseCode {
  return code === WsCloseCode.SESSION_NOT_FOUND || code === WsCloseCode.SESSION_EXPIRED;
}

/**
 * Watches one session for captured requests, their responses and their
 * deletion, and for changes to the session's own response.
 *
 * The socket carries notifications only; every action stays on HTTP (D013).
 * A lost connection is retried with a growing delay, because a session lives
 * for days and the tab may outlive several network interruptions. A refused
 * connection is not retried: the session is closed and reconnecting would only
 * be refused again.
 *
 * A private session's connection presents `accessKey`, the key the page
 * opened the session with, on its first connection and on every retry
 * (`sessionSocketProtocols`); without it the server closes the connection
 * `4404`, as for a session that does not exist.
 *
 * Returns a function that stops watching.
 */
export function openSessionSocket(
  sessionId: string,
  handlers: SessionSocketHandlers,
  accessKey: string | null = null,
): () => void {
  // Computed once, outside `connect`, so the first connection and every retry
  // use the same URL and therefore the same declaration (D115), and the same
  // key.
  const url = sessionSocketUrl(sessionId);
  const protocols = sessionSocketProtocols(accessKey);

  let socket: WebSocket | null = null;
  let retryTimer: number | undefined;
  let retryDelay = 0;
  let openedAt: number | null = null;
  let stopped = false;

  function connect(): void {
    // A public session's socket is opened exactly as before, with no
    // subprotocol argument at all.
    socket = protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols);
    openedAt = null;

    socket.addEventListener('open', () => {
      openedAt = Date.now();
    });

    // A thin dispatcher over `routeServerMessage`: the decision itself is pure
    // and tested, and nothing about a frame is worked out here.
    socket.addEventListener('message', (message: MessageEvent<string>) => {
      const routed = routeServerMessage(message.data);

      switch (routed.kind) {
        case 'ready':
          handlers.onReady();

          return;

        case 'request':
          handlers.onRequest(routed.event);

          return;

        case 'response':
          handlers.onResponse(routed.event);

          return;

        case 'deleted':
          handlers.onDeleted(routed.event);

          return;

        case 'cleared':
          handlers.onCleared();

          return;

        case 'session':
          handlers.onSessionUpdated(routed.event);

          return;

        case 'ignored':
          return;
      }
    });

    socket.addEventListener('close', (event: CloseEvent) => {
      if (stopped) {
        return;
      }

      if (isRefusal(event.code)) {
        stopped = true;
        handlers.onRefused(event.code);

        return;
      }

      retryDelay = nextRetryDelay(retryDelay, openedAt === null ? 0 : Date.now() - openedAt);
      retryTimer = window.setTimeout(connect, retryDelay);
    });
  }

  connect();

  return () => {
    stopped = true;
    window.clearTimeout(retryTimer);
    socket?.close();
  };
}
