import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { act, createElement } from 'react';
import type { RequestListItem } from '@webhook-inspector/shared';
import { en } from '../i18n/en.ts';
import { readStateKey, recordRead, type ReadStateStorage } from '../lib/read-state.ts';
import { installFakeBrowser } from '../testing/render-in-node.ts';
import type { ReadState } from './useReadState.ts';

/**
 * The session page's read state (D014, D078, D156), held by `useReadState`
 * (issue #406): rendered in Node's fake browser by a component that only
 * calls the hook. The fake window dispatches no event, so this file's window
 * keeps the `storage` listeners it is given, and a test calls them as a
 * browser does when another tab writes.
 */

const SESSION = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';
const OTHER_SESSION = 'x'.repeat(43);
const OPENED_AT = Date.UTC(2026, 10, 6, 8, 0, 0);

const browser = installFakeBrowser(`https://qa-tools.ru/v/${SESSION}`);
const storageListeners = new Set<(event: unknown) => void>();

Object.assign(browser, {
  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === 'storage') {
      storageListeners.add(listener);
    }
  },
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === 'storage') {
      storageListeners.delete(listener);
    }
  },
});

// Imported once the fake browser is in place: React DOM looks for a DOM as it loads.
const { createRoot } = await import('react-dom/client');
const { useReadState } = await import('./useReadState.ts');

type ReadStateOptions = Parameters<typeof useReadState>[0];

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

/** A `storage` event as the browser hands it to every other tab of the origin. */
function storageEvent(storageArea: unknown, key: string, newValue: string | null) {
  return { key, newValue, oldValue: null, storageArea };
}

/** Calls the window's `storage` listeners with `event`, as the browser does. */
async function dispatchStorage(event: unknown): Promise<void> {
  await act(async () => {
    for (const listener of storageListeners) {
      listener(event);
    }
  });
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

/** The hook rendered as a page would hold it: what it returned last, its next render and its end. */
async function renderReadState(options: Omit<ReadStateOptions, 'sessionId' | 'messages'>) {
  const seen: { current: ReadState | null } = { current: null };
  const container = browser.document.createElement('div');

  browser.document.body.appendChild(container);

  function Probe(props: ReadStateOptions): null {
    seen.current = useReadState(props);

    return null;
  }

  const root = createRoot(container as unknown as HTMLElement);
  const render = (next: Omit<ReadStateOptions, 'sessionId' | 'messages'>) =>
    act(async () =>
      root.render(createElement(Probe, { sessionId: SESSION, messages: en, ...next })),
    );

  await render(options);

  return {
    get current(): ReadState {
      assert.ok(seen.current, 'the hook was not rendered');

      return seen.current;
    },
    render,
    unmount: () => act(async () => root.unmount()),
  };
}

describe('useReadState', () => {
  it('starts from what this browser read, and the tab title counts the rest while requests are shown (D014, D078)', async () => {
    const storage = memoryStorage();
    const requests = [row('req-a'), row('req-b'), row('req-c')];

    recordRead(storage, SESSION, 'req-a', OPENED_AT);

    const page = await renderReadState({ storage, requests, showingRequests: false });

    assert.deepEqual([...page.current.openedIds], ['req-a']);
    // Loading, or a notice: nothing is waiting to be read.
    assert.equal(document.title, 'Webhook Inspector');

    await page.render({ storage, requests, showingRequests: true });
    assert.equal(document.title, '(2) Webhook Inspector');

    // Opened on this page, through the setter the page marks a request read with.
    await act(async () => page.current.setOpenedIds(new Set(['req-a', 'req-b', 'req-c'])));
    assert.equal(document.title, 'Webhook Inspector');

    await act(async () => page.current.setOpenedIds(new Set(['req-a'])));
    assert.equal(document.title, '(2) Webhook Inspector');

    // Leaving the page puts the plain title back.
    await page.unmount();
    assert.equal(document.title, 'Webhook Inspector');
  });

  it('takes in a request another tab of this browser opened, from its storage event, and nothing else (D156)', async () => {
    const storage = memoryStorage();
    const page = await renderReadState({
      storage,
      requests: [row('req-a'), row('req-b')],
      showingRequests: true,
    });

    assert.equal(storageListeners.size, 1);
    assert.equal(document.title, '(2) Webhook Inspector');

    // Another tab opens `req-b`: it writes the session's entry, and this tab
    // is told what the entry now holds.
    recordRead(storage, SESSION, 'req-b', OPENED_AT);

    const written = storage.getItem(readStateKey(SESSION));
    const before = page.current.openedIds;

    // The same write in `sessionStorage`, another session's entry and a
    // removal change nothing.
    await dispatchStorage(storageEvent(memoryStorage(), readStateKey(SESSION), written));
    await dispatchStorage(storageEvent(storage, readStateKey(OTHER_SESSION), written));
    await dispatchStorage(storageEvent(storage, readStateKey(SESSION), null));
    assert.equal(page.current.openedIds, before);
    assert.deepEqual([...page.current.openedIds], []);

    await dispatchStorage(storageEvent(storage, readStateKey(SESSION), written));
    assert.deepEqual([...page.current.openedIds], ['req-b']);
    assert.equal(document.title, '(1) Webhook Inspector');

    // The page gone, nothing listens any more.
    await page.unmount();
    assert.equal(storageListeners.size, 0);
  });

  it('with no storage, keeps read state in this tab and listens to nothing (D156)', async () => {
    const page = await renderReadState({
      storage: null,
      requests: [row('req-a')],
      showingRequests: true,
    });

    assert.deepEqual([...page.current.openedIds], []);
    assert.equal(storageListeners.size, 0);
    assert.equal(document.title, '(1) Webhook Inspector');

    await page.unmount();
  });
});
