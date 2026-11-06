import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers';
import { act, createElement, useRef, useState } from 'react';
import {
  WsCloseCode,
  type QueueStep,
  type RequestListItem,
  type ServerEvent,
} from '@webhook-inspector/shared';
import type { RawSearch } from '../lib/raw-search.ts';
import type { ReadStateStorage } from '../lib/read-state.ts';
import { createListLoads } from '../lib/requests.ts';
import type { SessionPageStatus } from '../lib/session-lifetime.ts';
import type { ResponseEvent } from '../lib/session-response.ts';
import { installFakeBrowser } from '../testing/render-in-node.ts';

/**
 * The session page's realtime delivery, held by `useSessionSocket` (issue
 * #422): rendered in Node's fake browser by a component that holds the list,
 * the open request and the list loads as the page does and calls the hook,
 * with a socket the test drives by hand and `fetch` held until a test answers
 * each reload of the list as the server would.
 */

const SESSION = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

const browser = installFakeBrowser(`https://qa-tools.ru/v/${SESSION}`);

// The page's socket stops its retry timer as it closes; the fake runs no timer.
Object.assign(browser, { clearTimeout: () => undefined });

/**
 * A socket the test drives by hand: it records what was constructed and lets
 * the test deliver `message` and `close` as the browser would.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readonly url: string;
  closed = false;
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

  close(): void {
    this.closed = true;
  }
}

Object.assign(globalThis, { WebSocket: FakeSocket });

// Imported once the fake browser is in place: React DOM looks for a DOM as it loads.
const { createRoot } = await import('react-dom/client');
const { useSessionSocket } = await import('./useSessionSocket.ts');

/** A `localStorage` of one browser, in memory. */
function memoryStorage(): ReadStateStorage {
  const items = new Map<string, string>();

  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (name) => items.get(name) ?? null,
    setItem: (name, value) => {
      items.set(name, String(value));
    },
    removeItem: (name) => {
      items.delete(name);
    },
  };
}

function row(id: string, queueStep: QueueStep | null = null): RequestListItem {
  return {
    id,
    method: 'POST',
    receivedAt: '2026-09-17T14:32:06.000Z',
    bodySize: 19,
    sourceIp: '145.40.74.12',
    path: `/s/${SESSION}/stripe/events`,
    response: { state: 'sent', status: 200, queueStep, rule: null },
  };
}

/** An answer of the API, as much of one as `api/client.ts` reads. */
function answer(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

/** Lets an answer, a chain of promises, reach the page. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

/** One call `fetch` was asked for, held until the test answers it. */
interface HeldCall {
  url: string;
  answer: (status: number, body: unknown) => Promise<void>;
}

/** `fetch`, holding every call until the test answers it. */
function holdFetch(t: TestContext): HeldCall[] {
  const calls: HeldCall[] = [];

  t.mock.method(
    globalThis,
    'fetch',
    (url: string) =>
      new Promise<Response>((resolve) => {
        calls.push({
          url,
          answer: async (status, body) => {
            resolve(answer(status, body));
            await settle();
          },
        });
      }),
  );

  return calls;
}

/** What the page around the hook did, as the test reads it. */
interface Seen {
  requests: string[];
  statuses: SessionPageStatus[];
  responseEvents: ResponseEvent[];
  sessionReads: number;
  refreshed: string[];
  closed: number;
  searched: string[];
}

/**
 * The hook rendered as the page holds it, with `requests` listed and
 * `openId` open: what it changed of the page around it, the socket it opened,
 * and the page's end.
 */
async function renderSocket(requests: RequestListItem[], openId: string | null = null) {
  FakeSocket.instances = [];

  const seen: Seen = {
    requests: [],
    statuses: [],
    responseEvents: [],
    sessionReads: 0,
    refreshed: [],
    closed: 0,
    searched: [],
  };
  const storage = memoryStorage();
  const setStatus = (next: SessionPageStatus) => {
    seen.statuses.push(next);
  };
  const reloadSession = async () => {
    seen.sessionReads += 1;
  };
  const takeResponseEvent = (event: ResponseEvent) => {
    seen.responseEvents.push(event);
  };
  const refreshDetails = async (id: string) => {
    seen.refreshed.push(id);
  };
  const rawSearch = {
    requestsArrived: () => seen.searched.push('arrived'),
    listReloaded: () => seen.searched.push('reloaded'),
  } as unknown as RawSearch;
  const container = browser.document.createElement('div');

  browser.document.body.appendChild(container);

  function Probe(): null {
    const [listed, setRequests] = useState(requests);
    const [listLoads] = useState(createListLoads);
    const selectedIdRef = useRef<string | null>(openId);
    const [discardPendingDetails] = useState(() => () => {
      seen.closed += 1;
      selectedIdRef.current = null;
    });

    useSessionSocket({
      sessionId: SESSION,
      storage,
      listLoads,
      setRequests,
      setStatus,
      reloadSession,
      takeResponseEvent,
      selectedIdRef,
      refreshDetails,
      discardPendingDetails,
      rawSearch,
    });

    seen.requests = listed.map((item) => item.id);

    return null;
  }

  const root = createRoot(container as unknown as HTMLElement);

  await act(async () => root.render(createElement(Probe)));

  assert.equal(FakeSocket.instances.length, 1, 'the page opened one socket');

  const socket = FakeSocket.instances[0]!;

  return {
    seen,
    socket,
    /** Delivers one frame of the server, as the socket would. */
    async deliver(event: ServerEvent): Promise<void> {
      await act(async () => {
        socket.emit('message', { data: JSON.stringify(event) });
      });
    },
    async close(code: number): Promise<void> {
      await act(async () => {
        socket.emit('close', { code });
      });
    },
    unmount: () => act(async () => root.unmount()),
  };
}

describe('useSessionSocket', () => {
  it('watches the page’s session, and stops with the page', async () => {
    const page = await renderSocket([]);

    assert.ok(page.socket.url.includes(`/ws/${SESSION}?`), page.socket.url);
    assert.equal(page.socket.closed, false);

    await page.unmount();
    assert.equal(page.socket.closed, true);
  });

  it('inserts a captured request without opening it, and moves the queue on by the step it took (D014, D205)', async () => {
    const page = await renderSocket([row('req-a')], 'req-a');

    await page.deliver({ type: 'request.received', data: row('req-b', { index: 2, total: 3 }) });

    assert.deepEqual([...page.seen.requests].sort(), ['req-a', 'req-b']);
    assert.deepEqual(page.seen.responseEvents, [{ type: 'step', step: { index: 2, total: 3 } }]);
    assert.deepEqual(page.seen.searched, ['arrived']);
    // The open request stays open.
    assert.equal(page.seen.closed, 0);

    await page.unmount();
  });

  it('reloads the list on every connection, keeping what arrived meanwhile and dropping what went, and reads the session again (D077, D133, #39)', async (t) => {
    const calls = holdFetch(t);
    const page = await renderSocket([row('req-a'), row('req-gone')], 'req-a');

    await page.deliver({ type: 'ready' });

    assert.deepEqual(
      calls.map((call) => call.url),
      [`/api/sessions/${SESSION}/requests`],
    );
    assert.equal(page.seen.sessionReads, 1);
    // The open request's panel is read again beside the list (#204).
    assert.deepEqual(page.seen.refreshed, ['req-a']);

    // Delivered while the reload is in flight: its answer lacks it, and it stays.
    await page.deliver({ type: 'request.received', data: row('req-new') });
    await calls[0]!.answer(200, [row('req-a')]);

    assert.deepEqual([...page.seen.requests].sort(), ['req-a', 'req-new']);
    assert.deepEqual(page.seen.searched, ['arrived', 'reloaded']);
    assert.equal(page.seen.closed, 0);

    await page.unmount();
  });

  it('closes the open request that another viewer deleted, and lets no reload in flight bring it back (D136, D137)', async (t) => {
    const calls = holdFetch(t);
    const page = await renderSocket([row('req-a'), row('req-b')], 'req-a');

    await page.deliver({ type: 'ready' });
    await page.deliver({ type: 'request.deleted', data: { id: 'req-a' } });

    assert.deepEqual(page.seen.requests, ['req-b']);
    assert.equal(page.seen.closed, 1);

    // The reload began before the deletion: its answer is discarded.
    await calls[0]!.answer(200, [row('req-a'), row('req-b')]);
    assert.deepEqual(page.seen.requests, ['req-b']);

    await page.unmount();
  });

  it('takes the page to Session not found when the connection is refused (D076, D198)', async () => {
    const page = await renderSocket([row('req-a')]);

    await page.close(WsCloseCode.SESSION_NOT_FOUND);

    assert.deepEqual(page.seen.statuses, ['unavailable']);

    await page.unmount();
  });
});
