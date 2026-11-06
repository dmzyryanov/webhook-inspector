import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers';
import { act, createElement, useRef, useState } from 'react';
import { ErrorCode, type RequestDetails, type RequestListItem } from '@webhook-inspector/shared';
import type { ToastIcon } from '../components/Toast.tsx';
import { en, type Phrase } from '../i18n/en.ts';
import { loadReadIds, type ReadStateStorage } from '../lib/read-state.ts';
import type { SessionPageStatus } from '../lib/session-lifetime.ts';
import { installFakeBrowser } from '../testing/render-in-node.ts';
import type { RequestSelection } from './useRequestSelection.ts';

/**
 * The session page's open request (D014, D125, D137, D182), held by
 * `useRequestSelection` (issue #421): rendered in Node's fake browser by a
 * component that holds the list, the read set and the push flow's notes as
 * the page does and calls the hook, with `fetch` held until a test answers
 * each detail call as the server would.
 */

const SESSION = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

/** The fake window, with the scroll position the push flow notes as a request opens. */
const browser: ReturnType<typeof installFakeBrowser> & { scrollY: number } = Object.assign(
  installFakeBrowser(`https://qa-tools.ru/v/${SESSION}`),
  { scrollY: 0 },
);
/** Whether the window is 1024 px wide or more, which a linked opening reads as its details arrive. */
let desktop = false;

Object.assign(browser, {
  matchMedia: () => ({
    matches: desktop,
    addEventListener(): void {},
    removeEventListener(): void {},
  }),
});
// Node has no `CSS`; the ids here hold nothing a selector would need escaped.
Object.assign(globalThis, { CSS: { escape: (value: string) => value } });

// Imported once the fake browser is in place: React DOM looks for a DOM as it loads.
const { createRoot } = await import('react-dom/client');
const { staleLink, useRequestSelection } = await import('./useRequestSelection.ts');

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

/** A request's details as the API answers them, its body `body`, with no response recorded. */
function detail(id: string, body = '{"type":"charge"}'): RequestDetails {
  return {
    ...row(id),
    queryString: '',
    headers: [['Content-Type', 'application/json']],
    body,
    bodyBase64: null,
    isBinary: false,
    raw: null,
    rawBase64: null,
    isRawBinary: false,
    httpVersion: '1.1',
    response: null,
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

/** One detail call `fetch` was asked for, held until the test answers it. */
interface HeldCall {
  url: string;
  answer: (status: number, body: unknown) => Promise<void>;
}

/** `fetch`, holding every call until the test answers it, in whatever order it chooses. */
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

function detailUrl(id: string): string {
  return `/api/sessions/${SESSION}/requests/${id}`;
}

/** What the page around the hook holds, as the test reads it after each render. */
interface Page {
  selection: RequestSelection;
  requests: RequestListItem[];
  openedIds: ReadonlySet<string>;
  knownAtOpen: ReadonlySet<string>;
  listScroll: number;
  lastOpened: string | null;
}

/** The id of the request whose details the panel shows, or `null`. */
function shownId(page: { readonly current: Page }): string | null {
  return page.current.selection.details?.id ?? null;
}

/**
 * The hook rendered as the page holds it, with `requests` listed: what it
 * returned last, what it changed of the page around it, and the page's end.
 */
async function renderSelection(
  requests: RequestListItem[],
  listSection: HTMLElement | null = null,
) {
  const seen: { current: Page | null } = { current: null };
  const storage = memoryStorage();
  const statuses: SessionPageStatus[] = [];
  const toasts: { text: Phrase; icon: ToastIcon | undefined }[] = [];
  let comparisonsEnded = 0;
  const setStatus = (next: SessionPageStatus) => {
    statuses.push(next);
  };
  const endComparison = () => {
    comparisonsEnded += 1;
  };
  const showToast = (text: Phrase, icon?: ToastIcon) => {
    toasts.push({ text, icon });
  };
  const container = browser.document.createElement('div');

  browser.document.body.appendChild(container);

  function Probe(): null {
    const [listed, setRequests] = useState(requests);
    const [openedIds, setOpenedIds] = useState<ReadonlySet<string>>(() => new Set());
    const [knownAtOpen, setKnownAtOpen] = useState<ReadonlySet<string>>(() => new Set());
    const listScroll = useRef(0);
    const lastOpened = useRef<string | null>(null);
    const section = useRef(listSection);
    const selection = useRequestSelection({
      sessionId: SESSION,
      storage,
      setOpenedIds,
      setRequests,
      setStatus,
      endComparison,
      showToast,
      listScroll,
      lastOpened,
      setKnownAtOpen,
      listSection: section,
    });

    seen.current = {
      selection,
      requests: listed,
      openedIds,
      knownAtOpen,
      listScroll: listScroll.current,
      lastOpened: lastOpened.current,
    };

    return null;
  }

  const root = createRoot(container as unknown as HTMLElement);

  await act(async () => root.render(createElement(Probe)));

  const current = (): Page => {
    assert.ok(seen.current, 'the hook was not rendered');

    return seen.current;
  };

  return {
    get current(): Page {
      return current();
    },
    storage,
    statuses,
    toasts,
    get comparisonsEnded() {
      return comparisonsEnded;
    },
    /**
     * Runs `call` as an event handler of the page would, its updates applied,
     * and hands back what it returned in a tuple, so that an opening's promise
     * is not awaited here: its answer is the test's to give.
     */
    async run<T>(call: (selection: RequestSelection) => T): Promise<[T]> {
      let result!: [T];

      await act(async () => {
        result = [call(current().selection)];
      });

      return result;
    },
    unmount: () => act(async () => root.unmount()),
  };
}

describe('useRequestSelection', () => {
  it('shows the request clicked last, whatever order the answers come in, each opening read and ending the comparison (D014, D186)', async (t) => {
    const calls = holdFetch(t);
    const page = await renderSelection([row('req-a'), row('req-b')]);

    assert.equal(page.current.selection.selectedId, null);

    const [first] = await page.run((selection) => selection.select('req-a'));
    const [second] = await page.run((selection) => selection.select('req-b'));

    assert.deepEqual(
      calls.map((call) => call.url),
      [detailUrl('req-a'), detailUrl('req-b')],
    );
    // Open at once, its details still loading; the socket's callbacks read it too.
    assert.equal(page.current.selection.selectedId, 'req-b');
    assert.equal(page.current.selection.selectedIdRef.current, 'req-b');
    assert.equal(shownId(page), null);
    // Opening is what makes a request read, in this tab and in this browser's store.
    assert.deepEqual([...page.current.openedIds], ['req-a', 'req-b']);
    assert.deepEqual([...loadReadIds(page.storage, SESSION)].sort(), ['req-a', 'req-b']);
    assert.equal(page.comparisonsEnded, 2);

    await calls[1]!.answer(200, detail('req-b'));
    assert.equal(await second, 'shown');
    assert.equal(shownId(page), 'req-b');

    // The earlier click's answer, arriving last, is not shown.
    await calls[0]!.answer(200, detail('req-a'));
    assert.equal(await first, 'superseded');
    assert.equal(shownId(page), 'req-b');
    assert.equal(page.current.selection.detailFailed, false);
    assert.deepEqual(page.statuses, []);

    await page.unmount();
  });

  it('closes the open request and drops its answer still in flight, ending the comparison too (D137)', async (t) => {
    const calls = holdFetch(t);
    const page = await renderSelection([row('req-a')]);
    const [opening] = await page.run((selection) => selection.select('req-a'));

    await page.run((selection) => selection.discardPendingDetails());

    assert.equal(page.current.selection.selectedId, null);
    assert.equal(page.current.selection.selectedIdRef.current, null);
    assert.equal(page.comparisonsEnded, 2);

    await calls[0]!.answer(200, detail('req-a'));
    assert.equal(await opening, 'superseded');
    assert.equal(page.current.selection.details, null);
    assert.equal(page.current.selection.selectedId, null);

    await page.unmount();
  });

  it('takes a request the server no longer has off the list, says another failure in the panel and hands a closed session to the page', async (t) => {
    const calls = holdFetch(t);
    const page = await renderSelection([row('req-a'), row('req-b')]);

    const [gone] = await page.run((selection) => selection.select('req-a'));

    await calls[0]!.answer(404, {
      errorCode: ErrorCode.REQUEST_NOT_FOUND,
      message: 'Request not found',
    });
    assert.equal(await gone, 'not-found');
    assert.deepEqual(
      page.current.requests.map((item) => item.id),
      ['req-b'],
    );
    assert.equal(page.current.selection.selectedId, null);
    // Mirrored from the selection once it is rendered.
    assert.equal(page.current.selection.selectedIdRef.current, null);
    assert.equal(page.current.selection.detailFailed, false);
    assert.deepEqual(page.statuses, []);

    const [failed] = await page.run((selection) => selection.select('req-b'));

    await calls[1]!.answer(500, { message: 'Internal error' });
    assert.equal(await failed, 'failed');
    // The request stays open, its panel saying its details did not load.
    assert.equal(page.current.selection.selectedId, 'req-b');
    assert.equal(page.current.selection.detailFailed, true);
    assert.deepEqual(page.statuses, ['ready']);

    // The panel's Retry, answered for a session that has expired meanwhile.
    const [retried] = await page.run((selection) => selection.select('req-b'));

    assert.equal(page.current.selection.detailFailed, false);
    await calls[2]!.answer(410, { errorCode: ErrorCode.SESSION_EXPIRED, message: 'Gone' });
    assert.equal(await retried, 'failed');
    assert.equal(page.current.selection.detailFailed, false);
    assert.deepEqual(page.statuses, ['ready', 'unavailable']);

    await page.unmount();
  });

  it('refreshes the open request in place, and keeps what it shows when a refresh fails or comes for a request since closed (D125)', async (t) => {
    const calls = holdFetch(t);
    const page = await renderSelection([row('req-a')]);
    const [opening] = await page.run((selection) => selection.select('req-a'));

    await calls[0]!.answer(200, detail('req-a', 'first'));
    assert.equal(await opening, 'shown');
    assert.equal(page.current.selection.details?.body, 'first');

    const [refreshed] = await page.run((selection) => selection.refreshDetails('req-a'));

    await calls[1]!.answer(200, detail('req-a', 'second'));
    await refreshed;
    assert.equal(page.current.selection.details?.body, 'second');
    assert.equal(page.current.selection.selectedId, 'req-a');

    // A refresh that fails never clears the panel nor says it failed.
    const [failed] = await page.run((selection) => selection.refreshDetails('req-a'));

    await calls[2]!.answer(500, { message: 'Internal error' });
    await failed;
    assert.equal(page.current.selection.details?.body, 'second');
    assert.equal(page.current.selection.detailFailed, false);

    // The request closed while its refresh was in flight stays closed.
    const [late] = await page.run((selection) => selection.refreshDetails('req-a'));

    await page.run((selection) => selection.discardPendingDetails());
    await calls[3]!.answer(200, detail('req-a', 'third'));
    await late;
    assert.equal(page.current.selection.details, null);
    assert.deepEqual(page.statuses, []);

    await page.unmount();
  });

  it('opens a linked request as a click does, says one that is gone is gone, and on the desktop scrolls its row into view (D182)', async (t) => {
    const calls = holdFetch(t);
    const listed = [row('req-a'), row('req-b')];
    const revealed: { selector: string; block: string | undefined }[] = [];
    const listSection = {
      querySelector: (selector: string) => ({
        scrollIntoView: (options: ScrollIntoViewOptions) =>
          revealed.push({ selector, block: options.block }),
      }),
    } as unknown as HTMLElement;
    const page = await renderSelection(listed, listSection);

    t.after(() => {
      desktop = false;
      browser.scrollY = 0;
    });

    // Below 1024 px, the list scrolled: noted for the push flow before it opens.
    browser.scrollY = 240;

    const [gone] = await page.run((selection) => selection.openLinked('req-a', listed));

    assert.equal(page.current.selection.selectedId, 'req-a');
    assert.equal(page.current.listScroll, 240);
    assert.equal(page.current.lastOpened, 'req-a');
    assert.deepEqual([...page.current.knownAtOpen], ['req-a', 'req-b']);
    assert.deepEqual([...page.current.openedIds], ['req-a']);

    await calls[0]!.answer(404, {
      errorCode: ErrorCode.REQUEST_NOT_FOUND,
      message: 'Request not found',
    });
    await gone;
    assert.equal(page.toasts.length, 1);
    assert.equal(page.toasts[0]!.text, staleLink);
    assert.equal(page.toasts[0]!.text(en), en.staleLink);
    assert.equal(page.toasts[0]!.icon, 'info');
    assert.deepEqual(
      page.current.requests.map((item) => item.id),
      ['req-b'],
    );
    assert.deepEqual(revealed, []);

    // On the desktop, read as its details arrive: its row is brought into view.
    const [shown] = await page.run((selection) => selection.openLinked('req-b', listed));

    desktop = true;
    await calls[1]!.answer(200, detail('req-b'));
    await shown;
    assert.equal(shownId(page), 'req-b');
    assert.deepEqual(revealed, [{ selector: '[data-request-id="req-b"]', block: 'nearest' }]);
    assert.equal(page.toasts.length, 1);
    assert.deepEqual(page.statuses, []);

    await page.unmount();
  });
});
