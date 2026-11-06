import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers';
import { act, createElement } from 'react';
import { ErrorCode, type RequestListItem } from '@webhook-inspector/shared';
import { en } from '../i18n/en.ts';
import { TYPING_PAUSE_MS } from '../lib/raw-search.ts';
import { filterKey, type ReadStateStorage } from '../lib/read-state.ts';
import type { SessionPageStatus } from '../lib/session-lifetime.ts';
import { installFakeBrowser } from '../testing/render-in-node.ts';
import type { RequestFilter } from './useRequestFilter.ts';

/**
 * The session page's list filter (D180, D191), held by `useRequestFilter`
 * (issue #406): rendered in Node's fake browser by a component that only
 * calls the hook, with `fetch` answering the search as the server would.
 */

const SESSION = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';
/** A word of no row's list fields, which only a search of Raw can find. */
const WORD = 'needle42';
/** A day long past, when a stored filter was last used. */
const LONG_AGO = Date.UTC(2026, 0, 5, 8, 0, 0);
const SEARCH_URL = `/api/sessions/${SESSION}/requests/search`;

const browser = installFakeBrowser(`https://qa-tools.ru/v/${SESSION}`);
// Imported once the fake browser is in place: React DOM looks for a DOM as it loads.
const { createRoot } = await import('react-dom/client');
const { useRequestFilter } = await import('./useRequestFilter.ts');

type FilterOptions = Parameters<typeof useRequestFilter>[0];

/** A `localStorage` of one browser, in memory. */
function memoryStorage(initial: Record<string, string> = {}): ReadStateStorage {
  const items = new Map(Object.entries(initial));

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

/** The filter as this browser keeps it for the session. */
function storedFilter(storage: ReadStateStorage): { usedAt: number; query: string } | null {
  const raw = storage.getItem(filterKey(SESSION));

  return raw === null ? null : (JSON.parse(raw) as { usedAt: number; query: string });
}

function row(id: string): RequestListItem {
  return {
    id,
    method: 'POST',
    receivedAt: '2026-09-17T14:32:06.000Z',
    bodySize: 19,
    sourceIp: '145.40.74.12',
    path: `/s/${SESSION}/stripe/events`,
    response: { state: 'sent', status: 200, queueStep: null, rule: null },
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

/** `fetch`, answering every call with `respond`'s answer, its calls recorded. */
function mockFetch(t: TestContext, respond: () => Response) {
  return t.mock.method(globalThis, 'fetch', async () => respond());
}

/** The words of each search `fetch` was asked for, in order; nothing else is asked. */
function searchedWords(fetch: ReturnType<typeof mockFetch>): string[][] {
  return fetch.mock.calls.map((call) => {
    const [url, init] = call.arguments as unknown as [string, RequestInit];

    assert.equal(url, SEARCH_URL);
    assert.equal(init.method, 'POST');

    return (JSON.parse(String(init.body)) as { words: string[] }).words;
  });
}

/** The hook rendered as a page would hold it: what it returned last, and the page's end. */
async function renderFilter(options: Omit<FilterOptions, 'sessionId' | 'messages'>) {
  const seen: { current: RequestFilter | null } = { current: null };
  const container = browser.document.createElement('div');

  browser.document.body.appendChild(container);

  function Probe(props: FilterOptions): null {
    seen.current = useRequestFilter(props);

    return null;
  }

  const root = createRoot(container as unknown as HTMLElement);

  await act(async () =>
    root.render(createElement(Probe, { sessionId: SESSION, messages: en, ...options })),
  );

  return {
    get current(): RequestFilter {
      assert.ok(seen.current, 'the hook was not rendered');

      return seen.current;
    },
    unmount: () => act(async () => root.unmount()),
  };
}

/** Lets a search's answer, a chain of promises, reach the page. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

describe('useRequestFilter', () => {
  it('starts from the filter this browser kept, keeps it again and searches Raw for it at once (D180, D191)', async (t) => {
    const storage = memoryStorage({
      [filterKey(SESSION)]: JSON.stringify({ v: 1, usedAt: LONG_AGO, query: WORD }),
    });
    const fetch = mockFetch(t, () => answer(200, { matches: [['req-b']] }));
    const page = await renderFilter({
      storage,
      requests: [row('req-a'), row('req-b')],
      keepsNoAddress: false,
      setStatus: () => assert.fail('the page status was changed'),
    });

    assert.equal(page.current.filterQuery, WORD);
    // Kept on the first render: used now, so it lives as long as the read state.
    assert.equal(storedFilter(storage)?.query, WORD);
    assert.ok((storedFilter(storage)?.usedAt ?? 0) > LONG_AGO);
    // Asked during the render's effects, with no pause in typing to wait for.
    assert.deepEqual(searchedWords(fetch), [[WORD]]);

    await settle();

    // The row the server found in Raw is the one the filter keeps.
    assert.equal(page.current.rawSearchState.status, 'searched');
    assert.deepEqual(
      page.current.filteredRequests.map((item) => item.id),
      ['req-b'],
    );

    await page.unmount();
  });

  it('searches what is typed after the pause in typing, and nothing once the page has gone (D191)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const storage = memoryStorage();
    const fetch = mockFetch(t, () => answer(200, { matches: [['req-a']] }));
    const page = await renderFilter({
      storage,
      requests: [row('req-a'), row('req-b')],
      keepsNoAddress: false,
      setStatus: () => assert.fail('the page status was changed'),
    });

    assert.equal(page.current.filterQuery, '');
    assert.deepEqual(
      page.current.filteredRequests.map((item) => item.id),
      ['req-a', 'req-b'],
    );

    await act(async () => page.current.changeFilter(WORD));

    assert.equal(page.current.filterQuery, WORD);
    assert.equal(storedFilter(storage)?.query, WORD);
    // No list field holds the word, and Raw has not answered yet.
    assert.deepEqual(
      page.current.filteredRequests.map((item) => item.id),
      [],
    );

    t.mock.timers.tick(TYPING_PAUSE_MS - 1);
    assert.deepEqual(searchedWords(fetch), []);
    t.mock.timers.tick(1);
    assert.deepEqual(searchedWords(fetch), [[WORD]]);

    await settle();
    assert.deepEqual(
      page.current.filteredRequests.map((item) => item.id),
      ['req-a'],
    );

    // Typed again, and the page left before the pause ends: no search is sent.
    await act(async () => page.current.changeFilter(`${WORD} other`));
    await page.unmount();
    t.mock.timers.tick(TYPING_PAUSE_MS);
    assert.deepEqual(searchedWords(fetch), [[WORD]]);
  });

  it('hands a closed session to the page, and keeps any other failure in the list pane', async (t) => {
    const statuses: SessionPageStatus[] = [];
    const closed = mockFetch(t, () =>
      answer(410, { errorCode: ErrorCode.SESSION_EXPIRED, message: 'Session expired' }),
    );
    const restored = {
      [filterKey(SESSION)]: JSON.stringify({ v: 1, usedAt: LONG_AGO, query: WORD }),
    };
    const first = await renderFilter({
      storage: memoryStorage(restored),
      requests: [row('req-a')],
      keepsNoAddress: false,
      setStatus: (next) => statuses.push(next),
    });

    await settle();
    assert.deepEqual(statuses, ['unavailable']);
    await first.unmount();

    closed.mock.restore();
    mockFetch(t, () => answer(500, { message: 'Internal error' }));

    const second = await renderFilter({
      storage: memoryStorage(restored),
      requests: [row('req-a')],
      keepsNoAddress: false,
      setStatus: (next) => statuses.push(next),
    });

    await settle();
    assert.deepEqual(statuses, ['unavailable']);
    assert.equal(second.current.rawSearchState.status, 'not-searched');
    assert.equal(second.current.rawSearchState.reason, 'failed');
    await second.unmount();
  });
});
