import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  NEGOTIABLE_EVENT_TYPES,
  OLD_REALTIME_ACCESS_KEY_PROTOCOL_PREFIX,
  OLD_REALTIME_PROTOCOL,
  REALTIME_ACCESS_KEY_PROTOCOL_PREFIX,
  REALTIME_EVENTS_PARAM,
  REALTIME_PROTOCOL,
  WsCloseCode,
} from '@webhook-inspector/shared';
import {
  classifySessionError,
  settlePageStatus,
  type SessionPageStatus,
} from '../lib/session-lifetime.ts';
import {
  nextRetryDelay,
  openSessionSocket,
  routeServerMessage,
  sessionSocketProtocols,
  sessionSocketUrl,
  type SessionSocketHandlers,
} from './realtime.ts';

/** Long enough to count as a connection that worked; see HEALTHY_CONNECTION_MS. */
const LASTED = 30_000;

describe('nextRetryDelay', () => {
  it('grows to the cap and stops there', () => {
    const delays: number[] = [];
    let delay = 0;

    for (let attempt = 0; attempt < 7; attempt += 1) {
      delay = nextRetryDelay(delay, 0);
      delays.push(delay);
    }

    assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  });

  /**
   * The backend accepts the handshake before it knows whether it can serve the
   * session, so a failing backend produces open-then-close cycles. They must
   * still back off, or a struggling backend is retried once a second forever.
   */
  it('keeps growing when a connection opens and is closed immediately', () => {
    let delay = nextRetryDelay(0, 0);

    assert.equal(delay, 1_000);

    delay = nextRetryDelay(delay, 5);
    assert.equal(delay, 2_000);

    delay = nextRetryDelay(delay, 12);
    assert.equal(delay, 4_000);
  });

  it('starts over after a connection that lasted', () => {
    assert.equal(nextRetryDelay(8_000, LASTED), 1_000);
    assert.equal(nextRetryDelay(15_000, 10 * LASTED), 1_000);
  });

  it('does not start over just below the healthy threshold', () => {
    assert.equal(nextRetryDelay(4_000, LASTED - 1), 8_000);
  });
});

const SESSION_ID = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

/**
 * The routing decision, which is the reason it was lifted out of
 * `openSessionSocket` at all (D114).
 *
 * The property being pinned is structural: **only `request.received` can reach
 * the request branch**, so only it can reach `mergeRequests` (D110). A frame of
 * any other type merged by id would overwrite a real list row with an object
 * that has no method, no timestamp and no size - a request the viewer would
 * have invented.
 */
describe('routeServerMessage', () => {
  it('routes ready to ready', () => {
    assert.deepEqual(routeServerMessage('{"type":"ready"}'), { kind: 'ready' });
  });

  it('routes request.received to the request branch, carrying the row', () => {
    const frame = '{"type":"request.received","data":{"id":"a","method":"POST"}}';
    const routed = routeServerMessage(frame);

    assert.equal(routed.kind, 'request');
    assert.equal(routed.kind === 'request' ? routed.event.data.id : null, 'a');
  });

  it('reads a request.received row without `path` as `path: null` (D180)', () => {
    const old = routeServerMessage('{"type":"request.received","data":{"id":"a","method":"POST"}}');
    const current = routeServerMessage(
      '{"type":"request.received","data":{"id":"b","method":"POST","path":"/s/x/stripe"}}',
    );

    assert.equal(old.kind === 'request' ? old.event.data.path : undefined, null);
    assert.equal(current.kind === 'request' ? current.event.data.path : undefined, '/s/x/stripe');
  });

  it('routes response.recorded to the response branch', () => {
    const frame =
      '{"type":"response.recorded","data":{"id":"a","response":{"state":"sent","status":200}}}';
    const routed = routeServerMessage(frame);

    assert.equal(routed.kind, 'response');
    assert.equal(routed.kind === 'response' ? routed.event.data.response.state : null, 'sent');
  });

  it('routes request.deleted to the deleted branch, carrying the id', () => {
    const routed = routeServerMessage('{"type":"request.deleted","data":{"id":"a"}}');

    assert.equal(routed.kind, 'deleted');
    assert.equal(routed.kind === 'deleted' ? routed.event.data.id : null, 'a');
  });

  it('routes requests.cleared to the cleared branch', () => {
    assert.deepEqual(routeServerMessage('{"type":"requests.cleared"}'), { kind: 'cleared' });
  });

  it('routes session.updated to the session branch, carrying the new state (D152)', () => {
    const frame =
      '{"type":"session.updated","data":{"response":null,"customResponse":{"status":201,"headers":[],"body":null,"delayMs":0}}}';
    const routed = routeServerMessage(frame);

    assert.equal(routed.kind, 'session');
    assert.equal(routed.kind === 'session' ? routed.event.data.response : undefined, null);
    assert.equal(
      routed.kind === 'session' ? routed.event.data.customResponse?.status : undefined,
      201,
    );
  });

  it('ignores an unknown type, and it never reaches the request branch', () => {
    for (const frame of [
      '{"type":"requests.removed","data":{"ids":["a"]}}',
      '{"type":"REQUEST.DELETED","data":{"id":"a"}}',
      '{"type":"","data":{}}',
      '{"data":{"id":"a"}}',
      '{"type":"REQUEST.RECEIVED","data":{"id":"a"}}',
    ]) {
      assert.deepEqual(routeServerMessage(frame), { kind: 'ignored' }, frame);
    }
  });

  it('ignores unparseable text, and it never reaches the request branch', () => {
    for (const frame of ['', 'not json', '{', '[1,2]', 'null', '"ready"', '42']) {
      assert.deepEqual(routeServerMessage(frame), { kind: 'ignored' }, JSON.stringify(frame));
    }
  });
});

/**
 * The URL, which is the only place anything observes what the **shipped**
 * client declares (D114, D115).
 *
 * The socket-level tests on the backend run against the wire and see only what
 * their own helper declared, so they cannot tell whether this bundle declares
 * anything at all - on a first connection or on a retry.
 */
describe('sessionSocketUrl', () => {
  const original = (globalThis as { window?: unknown }).window;

  before(() => {
    (globalThis as { window?: unknown }).window = {
      location: { protocol: 'https:', host: 'qa-tools.ru' },
    };
  });

  after(() => {
    (globalThis as { window?: unknown }).window = original;
  });

  it('carries the declaration of every negotiable event', () => {
    const url = new URL(sessionSocketUrl(SESSION_ID));

    assert.equal(url.protocol, 'wss:');
    assert.equal(url.pathname, `/ws/${SESSION_ID}`);
    assert.deepEqual(url.searchParams.get(REALTIME_EVENTS_PARAM)?.split(','), [
      ...NEGOTIABLE_EVENT_TYPES,
    ]);
  });

  it('declares response.recorded by name, spelled as the shared constant spells it', () => {
    assert.ok(sessionSocketUrl(SESSION_ID).includes('response.recorded'));
  });

  it('declares both deletion events, so the shipped client receives them (D135)', () => {
    const declared = new URL(sessionSocketUrl(SESSION_ID)).searchParams
      .get(REALTIME_EVENTS_PARAM)
      ?.split(',');

    assert.ok(declared?.includes('request.deleted'));
    assert.ok(declared?.includes('requests.cleared'));
  });

  it('declares session.updated, so the shipped client follows a response change (D152)', () => {
    const declared = new URL(sessionSocketUrl(SESSION_ID)).searchParams
      .get(REALTIME_EVENTS_PARAM)
      ?.split(',');

    assert.ok(declared?.includes('session.updated'));
  });

  /**
   * The reconnection guarantee, in the only terms a unit test can see it: the
   * retry path reuses one URL value, so a builder that returned a different -
   * or a declaration-free - URL on a later call would silently drop the
   * declaration exactly when a pod replacement forced a reconnect.
   */
  it('returns the same URL, still carrying the declaration, on every call', () => {
    const first = sessionSocketUrl(SESSION_ID);
    const later = [1, 2, 3].map(() => sessionSocketUrl(SESSION_ID));

    for (const url of later) {
      assert.equal(url, first);
      assert.ok(url.includes(`${REALTIME_EVENTS_PARAM}=`));
      assert.ok(url.includes('response.recorded'));
    }
  });

  it('uses the insecure scheme on an insecure page', () => {
    (globalThis as { window?: unknown }).window = {
      location: { protocol: 'http:', host: 'localhost:5173' },
    };

    assert.ok(sessionSocketUrl(SESSION_ID).startsWith('ws://localhost:5173/ws/'));
  });
});

/**
 * A socket the test drives by hand: it records what was constructed and lets
 * the test deliver `open`, `message` and `close` as the browser would.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readonly url: string;
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close(): void {}
}

/**
 * The connection's life after it was accepted. A session deleted through the
 * API closes every connection watching it with `4404` (D198), and the page
 * moves to `Session not found` without a reload because `4404` at any moment
 * is a refusal here (D076). These pin that, and that any other close is still
 * retried.
 */
describe('openSessionSocket', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  let timers: (() => void)[] = [];

  before(() => {
    (globalThis as { window?: unknown }).window = {
      location: { protocol: 'https:', host: 'qa-tools.ru' },
      setTimeout: (callback: () => void) => timers.push(callback),
      clearTimeout: () => undefined,
    };
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  });

  after(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  });

  function watchWith(refused: number[], readies: { count: number }): () => void {
    FakeSocket.instances = [];
    timers = [];

    const ignore = () => undefined;
    const handlers: SessionSocketHandlers = {
      onReady: () => {
        readies.count += 1;
      },
      onRequest: ignore,
      onResponse: ignore,
      onDeleted: ignore,
      onCleared: ignore,
      onSessionUpdated: ignore,
      onRefused: (code) => {
        refused.push(code);
      },
    };

    return openSessionSocket(SESSION_ID, handlers);
  }

  it('ends a watched session that is closed with 4404 after ready, and does not reconnect', () => {
    const refused: number[] = [];
    const readies = { count: 0 };
    const stop = watchWith(refused, readies);
    const socket = FakeSocket.instances[0];

    assert.ok(socket);
    socket.emit('open', {});
    socket.emit('message', { data: '{"type":"ready"}' });
    socket.emit('close', { code: WsCloseCode.SESSION_NOT_FOUND });

    assert.equal(readies.count, 1);
    assert.deepEqual(refused, [4404]);
    assert.deepEqual(timers, [], 'a deleted session was reconnected to');
    assert.equal(FakeSocket.instances.length, 1);
    stop();
  });

  it('reconnects after any other close of an established connection', () => {
    const refused: number[] = [];
    const readies = { count: 0 };
    const stop = watchWith(refused, readies);
    const socket = FakeSocket.instances[0];

    assert.ok(socket);
    socket.emit('open', {});
    socket.emit('message', { data: '{"type":"ready"}' });
    socket.emit('close', { code: 1006 });

    assert.deepEqual(refused, []);
    assert.equal(timers.length, 1);

    timers[0]?.();

    assert.equal(FakeSocket.instances.length, 2);
    assert.equal(FakeSocket.instances[1]?.url, FakeSocket.instances[0]?.url);
    stop();
  });

  /**
   * A backend process that stops reading the outbox cuts every connection it
   * holds, which the viewer sees as an abnormal closure, `1006`, and refuses
   * a new one with `1013`, Try Again Later, until it reads again (D221). Both
   * are retried, and the connection that follows reloads the list on its
   * `ready` (D077) - the reload is what recovers anything the cut connection
   * missed.
   */
  it('reconnects after 1006 and after 1013, and reloads on the ready that follows', () => {
    const refused: number[] = [];
    const readies = { count: 0 };
    const stop = watchWith(refused, readies);
    const first = FakeSocket.instances[0];

    assert.ok(first);
    first.emit('open', {});
    first.emit('message', { data: '{"type":"ready"}' });
    assert.equal(readies.count, 1);

    // Cut by a process that stopped reading.
    first.emit('close', { code: 1006 });
    assert.equal(timers.length, 1);
    timers[0]?.();

    // Refused while it does not read yet: before any `ready`.
    const second = FakeSocket.instances[1];

    assert.ok(second);
    second.emit('open', {});
    second.emit('close', { code: 1013, reason: 'Try again later' });
    assert.deepEqual(refused, [], '1013 was taken as a refusal');
    assert.equal(timers.length, 2);
    timers[1]?.();

    // Listening again: the next connection is accepted and reloads.
    const third = FakeSocket.instances[2];

    assert.ok(third);
    assert.equal(third.url, first.url);
    third.emit('open', {});
    third.emit('message', { data: '{"type":"ready"}' });
    assert.equal(readies.count, 2);
    assert.deepEqual(refused, []);
    stop();
  });

  /**
   * The order traced on !130. The page's load on mount
   * reads the session and its list before the session is deleted, and its
   * answers arrive only after the deletion has closed the socket with `4404`.
   * The socket is not reopened after a refusal, so nothing would correct a
   * page that went back to the session then. Both change the page's status as
   * `SessionPage` changes it, through `settlePageStatus`.
   */
  it('leaves a page refused by a 4404 close on Session not found when its load on mount answers afterwards', async () => {
    FakeSocket.instances = [];
    timers = [];

    let status: SessionPageStatus = 'loading';
    const setStatus = (next: SessionPageStatus): void => {
      status = settlePageStatus(status, next);
    };
    let answerLoad: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answerLoad = resolve;
    });
    // Begun as the page mounts, before the socket opens; settled at the end.
    const mounting = answered.then(
      () => setStatus('ready'),
      (error: unknown) => setStatus(classifySessionError(error)),
    );
    const ignore = () => undefined;
    const stop = openSessionSocket(SESSION_ID, {
      onReady: ignore,
      onRequest: ignore,
      onResponse: ignore,
      onDeleted: ignore,
      onCleared: ignore,
      onSessionUpdated: ignore,
      onRefused: () => setStatus('unavailable'),
    });
    const socket = FakeSocket.instances[0];

    assert.ok(socket);
    socket.emit('open', {});
    socket.emit('message', { data: '{"type":"ready"}' });
    socket.emit('close', { code: WsCloseCode.SESSION_NOT_FOUND });

    assert.equal(status, 'unavailable');

    answerLoad();
    await mounting;

    assert.equal(status, 'unavailable', 'the load on mount put the deleted session back on screen');

    // Nor does a later call that fails for another reason, which the page
    // reports in place and which asks for `ready` (`classifySessionFailure`).
    setStatus(classifySessionError(new TypeError('Failed to fetch')));
    setStatus('ready');

    assert.equal(status, 'unavailable');
    assert.deepEqual(timers, [], 'a refused session was reconnected to');
    stop();
  });
});

/**
 * Issue #228 (D245 point 5, D259): a private session's socket offers
 * its key beside the protocol the server echoes, on its first connection and
 * on every retry, and the key is never in the URL; a public session's socket
 * is opened exactly as before, with no subprotocol argument at all. Since
 * #334 (D279) it offers `webhook-inspector`, then the key under the new prefix
 * and under the old one, which a backend of 1.18.x reads.
 */
describe('the socket of a private session', () => {
  const KEY = 'Kf8sQ2xLm9Wq4Tz7Hc1Ny6Bd3Rv5Gs0Jx2Ve7Up4RtE';
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  let timers: (() => void)[] = [];

  /** Records each construction's arguments, as the browser received them. */
  class OfferingSocket {
    static made: unknown[][] = [];
    static instances: OfferingSocket[] = [];
    readonly #listeners = new Map<string, ((event: unknown) => void)[]>();

    constructor(...args: unknown[]) {
      OfferingSocket.made.push(args);
      OfferingSocket.instances.push(this);
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
    }

    emit(type: string, event: unknown): void {
      for (const listener of this.#listeners.get(type) ?? []) {
        listener(event);
      }
    }

    close(): void {}
  }

  before(() => {
    (globalThis as { window?: unknown }).window = {
      location: { protocol: 'https:', host: 'qa-tools.ru' },
      setTimeout: (callback: () => void) => timers.push(callback),
      clearTimeout: () => undefined,
    };
    (globalThis as { WebSocket?: unknown }).WebSocket = OfferingSocket;
  });

  after(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  });

  const ignore = () => undefined;
  const handlers: SessionSocketHandlers = {
    onReady: ignore,
    onRequest: ignore,
    onResponse: ignore,
    onDeleted: ignore,
    onCleared: ignore,
    onSessionUpdated: ignore,
    onRefused: ignore,
  };

  const OFFERED = [
    'webhook-inspector',
    `webhook-inspector.access-key.${KEY}`,
    `qa-tools.access-key.${KEY}`,
  ];

  it('offers the key under both prefixes beside webhook-inspector, which the server echoes (D279)', () => {
    assert.equal(REALTIME_PROTOCOL, 'webhook-inspector');
    assert.equal(REALTIME_ACCESS_KEY_PROTOCOL_PREFIX, 'webhook-inspector.access-key.');
    assert.equal(OLD_REALTIME_PROTOCOL, 'qa-tools');
    assert.equal(OLD_REALTIME_ACCESS_KEY_PROTOCOL_PREFIX, 'qa-tools.access-key.');
    assert.deepEqual(sessionSocketProtocols(KEY), [
      REALTIME_PROTOCOL,
      `${REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${KEY}`,
      `${OLD_REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${KEY}`,
    ]);
    assert.deepEqual(sessionSocketProtocols(KEY), OFFERED);
  });

  /**
   * A backend of 1.18.x, which may still answer while the backend rolls
   * (D221), as its `access-key.ts` read the handshake: the key from the one
   * name starting with `qa-tools.access-key.`, and the answer the first name
   * offered that does not. Written out here rather than imported, since this
   * release's code no longer reads that way.
   */
  const OLD_PREFIX_1_18 = 'qa-tools.access-key.';
  const keyOf1_18 = (offered: string[]) => {
    const keys = offered.filter((name) => name.startsWith(OLD_PREFIX_1_18));

    return keys.length === 1 ? keys[0]?.slice(OLD_PREFIX_1_18.length) : undefined;
  };
  const answerOf1_18 = (offered: string[]) =>
    offered.find((name) => !name.startsWith(OLD_PREFIX_1_18));

  it('opens a private session on a backend of 1.18.x too, which echoes webhook-inspector and never the key (D279)', () => {
    const offered = sessionSocketProtocols(KEY) ?? [];

    assert.equal(keyOf1_18(offered), KEY);
    assert.equal(answerOf1_18(offered), 'webhook-inspector');
    // The order is what keeps the key under the new prefix from being that
    // answer: with it first, a backend of 1.18.x would echo it.
    assert.equal(answerOf1_18([offered[1] ?? '', offered[0] ?? '']), offered[1]);
  });

  it('offers nothing for a public session or a value that is no key', () => {
    for (const value of [
      null,
      '',
      'short',
      `${KEY}x`,
      `${KEY.slice(1)} `,
      'a'.repeat(1024 * 1024),
    ]) {
      assert.equal(sessionSocketProtocols(value), undefined, String(value).slice(0, 50));
    }
  });

  it('presents the key on the first connection and on every retry, never in the URL', () => {
    OfferingSocket.made = [];
    OfferingSocket.instances = [];
    timers = [];

    const stop = openSessionSocket('S3ss10n00000000000000000000000000000000000ab', handlers, KEY);

    // Three lost connections, each retried after its delay.
    for (let retry = 0; retry < 3; retry += 1) {
      OfferingSocket.instances.at(-1)?.emit('close', { code: 1006 });
      timers.shift()?.();
    }

    assert.equal(OfferingSocket.made.length, 4);

    for (const [url, protocols] of OfferingSocket.made) {
      assert.equal(String(url).includes(KEY), false);
      assert.deepEqual(protocols, OFFERED);
    }

    stop();
  });

  it('opens a public session’s socket with the URL alone, as before', () => {
    OfferingSocket.made = [];

    const stop = openSessionSocket('S3ss10n00000000000000000000000000000000000ab', handlers);

    assert.equal(OfferingSocket.made.length, 1);
    assert.equal(OfferingSocket.made[0]?.length, 1);
    stop();
  });
});
