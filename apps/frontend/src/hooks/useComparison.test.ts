import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { act, createElement, useRef, useState } from 'react';
import { ErrorCode } from '@webhook-inspector/shared';
import { loadReadIds } from '../lib/read-state.ts';
import type { SessionPageStatus } from '../lib/session-lifetime.ts';
import {
  detail,
  detailUrl,
  holdFetch,
  memoryStorage,
  row,
  SESSION,
} from '../testing/hook-helpers.ts';
import { installFakeBrowser } from '../testing/render-in-node.ts';
import type { ComparisonPicking } from './useComparison.ts';

/**
 * `Compare with…` for the open request (#75, D186), held by `useComparison`
 * and `useEscapeLeavesPicking` (issue #421): rendered in Node's fake browser
 * by a component that holds the read set and the list's scroll as the page
 * does and calls both hooks, with `fetch` held until a test answers each
 * load of the chosen request as the server would. The fake document
 * dispatches no event, so this file's document keeps the `keydown` listeners
 * it is given, and a test calls them as a browser does when a key is pressed.
 */

/** The fake window, with the scroll position picking notes as a row is chosen. */
const browser: ReturnType<typeof installFakeBrowser> & { scrollY: number } = Object.assign(
  installFakeBrowser(`https://qa-tools.ru/v/${SESSION}`),
  { scrollY: 0 },
);
const keyListeners = new Set<(event: unknown) => void>();

// React DOM listens on the document too, for `selectionchange`; only `keydown` is kept.
Object.assign(browser.document, {
  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === 'keydown') {
      keyListeners.add(listener);
    }
  },
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === 'keydown') {
      keyListeners.delete(listener);
    }
  },
});

// Imported once the fake browser is in place: React DOM looks for a DOM as it loads.
const { createRoot } = await import('react-dom/client');
const { useComparison, useEscapeLeavesPicking } = await import('./useComparison.ts');

/** Presses a key on the page: the document's `keydown` listeners are called, as the browser does. */
async function pressKey(key: string, defaultPrevented = false): Promise<void> {
  await act(async () => {
    for (const listener of keyListeners) {
      listener({ key, defaultPrevented });
    }
  });
}

/** What the page around the hooks holds, as the test reads it after each render. */
interface Page {
  comparison: ComparisonPicking;
  openedIds: ReadonlySet<string>;
  listScroll: number;
}

/**
 * The hooks rendered as the page holds them, with `selectedId` open: what
 * they returned last, what they changed of the page around them, and the
 * page's end.
 */
async function renderComparison(selectedId: string | null) {
  const seen: { current: Page | null } = { current: null };
  const storage = memoryStorage();
  const statuses: SessionPageStatus[] = [];
  const setStatus = (next: SessionPageStatus) => {
    statuses.push(next);
  };
  const container = browser.document.createElement('div');

  browser.document.body.appendChild(container);

  function Probe(): null {
    const [openedIds, setOpenedIds] = useState<ReadonlySet<string>>(() => new Set());
    const listScroll = useRef(0);
    const comparison = useComparison({
      sessionId: SESSION,
      storage,
      setOpenedIds,
      setStatus,
      listScroll,
    });
    // As the page decides it: picking for a request that is open.
    const picking = comparison.comparison?.phase === 'picking' && selectedId !== null;

    useEscapeLeavesPicking(picking, comparison.cancelComparisonPicking);

    seen.current = { comparison, openedIds, listScroll: listScroll.current };

    return null;
  }

  const root = createRoot(container as unknown as HTMLElement);

  await act(async () => root.render(createElement(Probe)));

  const current = (): Page => {
    assert.ok(seen.current, 'the hooks were not rendered');

    return seen.current;
  };

  return {
    get current(): Page {
      return current();
    },
    storage,
    statuses,
    /**
     * Runs `call` as an event handler of the page would, its updates applied,
     * and hands back what it returned in a tuple, so that a load's promise is
     * not awaited here: its answer is the test's to give.
     */
    async run<T>(call: (comparison: ComparisonPicking) => T): Promise<[T]> {
      let result!: [T];

      await act(async () => {
        result = [call(current().comparison)];
      });

      return result;
    },
    unmount: () => act(async () => root.unmount()),
  };
}

describe('useComparison', () => {
  it('compares with the row chosen, read as it is chosen, and shows only the latest choice’s details (D014, D186)', async (t) => {
    const calls = holdFetch(t);
    const page = await renderComparison('req-a');

    t.after(() => {
      browser.scrollY = 0;
    });

    assert.equal(page.current.comparison.comparison, null);
    assert.deepEqual(page.current.comparison.chosenDetails, { status: 'loading' });

    // `Compare with…`, then a row chosen with the list scrolled.
    await page.run((comparison) => comparison.startPicking());
    assert.deepEqual(page.current.comparison.comparison, { phase: 'picking', previous: null });

    browser.scrollY = 180;
    await page.run((comparison) => comparison.choose(row('req-b')));

    assert.deepEqual(page.current.comparison.comparison, {
      phase: 'comparing',
      chosen: row('req-b'),
      view: null,
    });
    assert.deepEqual(page.current.comparison.chosenDetails, { status: 'loading' });
    assert.equal(page.current.listScroll, 180);
    assert.deepEqual([...page.current.openedIds], ['req-b']);
    assert.deepEqual([...loadReadIds(page.storage, SESSION)], ['req-b']);

    // `Change`, keeping the comparison it came from, and another row chosen.
    await page.run((comparison) => comparison.showView('headers'));
    await page.run((comparison) => comparison.startPicking());
    assert.deepEqual(page.current.comparison.comparison, {
      phase: 'picking',
      previous: { chosen: row('req-b'), view: 'headers' },
    });
    await page.run((comparison) => comparison.choose(row('req-c')));

    assert.deepEqual(
      calls.map((call) => call.url),
      [detailUrl('req-b'), detailUrl('req-c')],
    );

    await calls[1]!.answer(200, detail('req-c'));
    assert.deepEqual(page.current.comparison.chosenDetails, {
      status: 'loaded',
      details: detail('req-c'),
    });

    // The earlier choice's answer, arriving last, is not shown.
    await calls[0]!.answer(200, detail('req-b'));
    assert.equal(
      page.current.comparison.chosenDetails.status === 'loaded' &&
        page.current.comparison.chosenDetails.details.id,
      'req-c',
    );
    assert.deepEqual(page.statuses, []);

    await page.unmount();
  });

  it('puts back what picking started from on Cancel, and Close ends the comparison and drops its load (D186)', async (t) => {
    const calls = holdFetch(t);
    const page = await renderComparison('req-a');

    await page.run((comparison) => comparison.startPicking());
    await page.run((comparison) => comparison.choose(row('req-b')));
    await page.run((comparison) => comparison.showView('body'));
    await page.run((comparison) => comparison.startPicking());
    await page.run((comparison) => comparison.cancelComparisonPicking());

    assert.deepEqual(page.current.comparison.comparison, {
      phase: 'comparing',
      chosen: row('req-b'),
      view: 'body',
    });

    await page.run((comparison) => comparison.endComparison());
    assert.equal(page.current.comparison.comparison, null);

    // The chosen request's answer, once the comparison has ended, is not taken.
    await calls[0]!.answer(200, detail('req-b'));
    assert.deepEqual(page.current.comparison.chosenDetails, { status: 'loading' });

    await page.unmount();
  });

  it('says a chosen request the server no longer has is gone, another failure failed, and hands a closed session to the page', async (t) => {
    const calls = holdFetch(t);
    const page = await renderComparison('req-a');

    await page.run((comparison) => comparison.startPicking());
    await page.run((comparison) => comparison.choose(row('req-b')));
    await calls[0]!.answer(404, {
      errorCode: ErrorCode.REQUEST_NOT_FOUND,
      message: 'Request not found',
    });
    assert.deepEqual(page.current.comparison.chosenDetails, { status: 'gone' });
    assert.deepEqual(page.statuses, []);

    // The comparison's `Retry`.
    const [failed] = await page.run((comparison) => comparison.loadChosen('req-b'));

    assert.deepEqual(page.current.comparison.chosenDetails, { status: 'loading' });
    await calls[1]!.answer(500, { message: 'Internal error' });
    await failed;
    assert.deepEqual(page.current.comparison.chosenDetails, { status: 'failed' });
    assert.deepEqual(page.statuses, ['ready']);

    const [closed] = await page.run((comparison) => comparison.loadChosen('req-b'));

    await calls[2]!.answer(410, { errorCode: ErrorCode.SESSION_EXPIRED, message: 'Gone' });
    await closed;
    assert.deepEqual(page.current.comparison.chosenDetails, { status: 'loading' });
    assert.deepEqual(page.statuses, ['ready', 'unavailable']);

    await page.unmount();
  });

  it('leaves picking on Escape while a request is open, unless something on the page has used it (D186)', async () => {
    const page = await renderComparison('req-a');

    // Nothing listens until picking starts.
    assert.equal(keyListeners.size, 0);
    await page.run((comparison) => comparison.startPicking());
    assert.equal(keyListeners.size, 1);

    await pressKey('Escape', true);
    await pressKey('Enter');
    assert.deepEqual(page.current.comparison.comparison, { phase: 'picking', previous: null });

    await pressKey('Escape');
    assert.equal(page.current.comparison.comparison, null);
    assert.equal(keyListeners.size, 0);

    await page.unmount();

    // With no request open, picking is not the page's, and Escape is not listened for.
    const closed = await renderComparison(null);

    await closed.run((comparison) => comparison.startPicking());
    assert.deepEqual(closed.current.comparison.comparison, { phase: 'picking', previous: null });
    assert.equal(keyListeners.size, 0);

    await closed.unmount();
  });
});
