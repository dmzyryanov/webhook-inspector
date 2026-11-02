/**
 * Helpers for the tests of realtime delivery through the outbox (D221).
 *
 * Not a test file itself: only `*.test.ts` files import it.
 */
import { setTimeout as delay } from 'node:timers/promises';
import {
  NEGOTIABLE_EVENT_TYPES,
  REALTIME_EVENTS_PARAM,
  type ServerEvent,
} from '@webhook-inspector/shared';
import type { RealtimeListener } from '../modules/realtime/listener.ts';

/** Waits until `check` holds, polling every 5 ms, for `ms` at most, then fails naming `what`. */
export async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    }

    await delay(5);
  }
}

/**
 * Runs `work` with the listener's reads held, so that nothing committed
 * meanwhile is delivered before `work` has ended; what was asked for then
 * runs as one read.
 */
export async function withoutReading<T>(
  servers: { listener: RealtimeListener },
  work: () => Promise<T>,
): Promise<T> {
  const release = servers.listener.holdReads();

  try {
    return await work();
  } finally {
    release();
  }
}

/** An event a viewer receives after `ready`. */
export type ViewerEvent = Exclude<ServerEvent, { type: 'ready' }>;

/** A viewer's connection, recorded from its `ready` on. */
export interface Viewer {
  /** Events received after `ready`, in order, every one of them. */
  events: ViewerEvent[];
  /** Resolves with the close code once the connection has closed. */
  closed: Promise<number>;
  isOpen(): boolean;
  close(): void;
  /** The subprotocol the server answered the handshake with, `''` for none. */
  protocol(): string;
  /** Resolves once `count` events have been received, or rejects after `ms`. */
  received(count: number, ms?: number): Promise<ViewerEvent[]>;
  /**
   * Resolves with the event after the last one `next` resolved with, once it
   * has arrived; rejects when the connection closes first, or after `ms`.
   */
  next(ms?: number): Promise<ViewerEvent>;
  /** The events received that `next` has not resolved with yet. */
  unread(): ViewerEvent[];
}

/**
 * How long a connection may take to report itself ready, or to be closed when
 * it is expected to be. Bounded so that a protocol regression fails with a
 * message instead of holding the test until its own timeout.
 */
const CONNECTION_TIMEOUT_MS = 10_000;

const openSockets = new Set<WebSocket>();

/** Closes every connection `watch`, `watchUrl` and `refused` opened and that is still open. */
export function closeSockets(): void {
  for (const socket of openSockets) {
    socket.close();
  }

  openSockets.clear();
}

/**
 * Watches a session on the application listener at `port` and resolves once
 * the server reports the connection subscribed, as a viewer does (D081),
 * declaring every optional event type unless told otherwise, as the shipped
 * client does (D115). An empty list sends no `events` parameter at all, as
 * every client built before D115 does.
 */
export function watch(
  port: number,
  sessionId: string,
  declares: readonly string[] = NEGOTIABLE_EVENT_TYPES,
): Promise<Viewer> {
  const query = declares.length === 0 ? '' : `?${REALTIME_EVENTS_PARAM}=${declares.join(',')}`;

  return watchUrl(`ws://127.0.0.1:${port}/ws/${sessionId}${query}`);
}

/**
 * Opens a connection at an exact URL and resolves once the server reports it
 * subscribed. Waiting for `ready` rather than for the socket to open is what
 * a viewer does too: the handshake is accepted before the subscription exists
 * (D081). `protocols` are the subprotocols the handshake offers, as a
 * browser's `new WebSocket(url, protocols)` offers them - a keyed session's
 * access key among them (D245).
 */
export function watchUrl(url: string, protocols?: string[]): Promise<Viewer> {
  const socket = new WebSocket(url, protocols);
  const events: ViewerEvent[] = [];
  /** Woken on every event and on the close: the waiting `next` calls, oldest first. */
  const waiting = new Set<() => void>();
  let taken = 0;
  let isClosed = false;
  let ready: () => void = () => undefined;
  const wake = (): void => {
    for (const check of waiting) {
      check();
    }
  };
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => {
      openSockets.delete(socket);
      isClosed = true;
      resolve(event.code);
      wake();
    });
  });

  openSockets.add(socket);
  socket.addEventListener('message', (message) => {
    const event = JSON.parse(String(message.data)) as ServerEvent;

    if (event.type === 'ready') {
      ready();
    } else {
      events.push(event);
      wake();
    }
  });

  const viewer: Viewer = {
    events,
    closed,
    isOpen: () => socket.readyState === WebSocket.OPEN,
    close: () => socket.close(),
    protocol: () => socket.protocol,
    received: async (count, ms = 10_000) => {
      await until(() => events.length >= count, `${count} events, ${events.length} so far`, ms);

      return events.slice(0, count);
    },
    next: (ms = 10_000) =>
      new Promise<ViewerEvent>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const check = (): void => {
          const event = events[taken];

          if (event === undefined && !isClosed) {
            return;
          }

          waiting.delete(check);
          clearTimeout(timer);

          if (event === undefined) {
            reject(new Error('The connection closed while waiting for an event'));
          } else {
            taken += 1;
            resolve(event);
          }
        };

        waiting.add(check);
        check();

        if (waiting.has(check)) {
          timer = setTimeout(() => {
            waiting.delete(check);
            reject(new Error(`Timed out after ${ms} ms waiting for event ${taken + 1}`));
          }, ms);
          timer.unref();
        }
      }),
    unread: () => events.slice(taken),
  };

  return new Promise<Viewer>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`The connection did not report itself ready within ${CONNECTION_TIMEOUT_MS} ms`),
      );
    }, CONNECTION_TIMEOUT_MS);

    timer.unref();
    ready = () => {
      clearTimeout(timer);
      resolve(viewer);
    };
    void closed.then((code) => {
      clearTimeout(timer);
      reject(new Error(`The connection closed with ${code} before reporting itself ready`));
    });
  });
}

/**
 * Opens a connection expected to be closed, offering `protocols` as
 * `watchUrl` does, and reports its close code and what it was sent.
 */
export function refused(
  port: number,
  sessionId: string,
  protocols?: string[],
): Promise<{ code: number; messages: string[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/${sessionId}`, protocols);
  const messages: string[] = [];

  openSockets.add(socket);
  socket.addEventListener('message', (message) => messages.push(String(message.data)));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The connection was not closed within ${CONNECTION_TIMEOUT_MS} ms`));
    }, CONNECTION_TIMEOUT_MS);

    timer.unref();
    socket.addEventListener('close', (event) => {
      clearTimeout(timer);
      openSockets.delete(socket);
      resolve({ code: event.code, messages });
    });
  });
}
