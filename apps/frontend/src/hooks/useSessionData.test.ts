import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { act, createElement, useCallback, useState } from 'react';
import { ErrorCode, type RequestListItem, type SessionDetails } from '@webhook-inspector/shared';
import {
  ACCESS_KEYS_KEY,
  accessKeyFor,
  holdAccessKey,
  releaseAllAccessKeys,
} from '../lib/access-keys.ts';
import { readStateKey, recordRead, type ReadStateStorage } from '../lib/read-state.ts';
import { mergeRequests } from '../lib/requests.ts';
import { SESSION_READ_INTERVAL_MS, type SessionPageStatus } from '../lib/session-lifetime.ts';
import {
  answering,
  holdFetch,
  memoryStorage,
  row,
  SESSION,
  settle,
} from '../testing/hook-helpers.ts';
import { installFakeBrowser } from '../testing/render-in-node.ts';
import type { FirstLoad, SessionData } from './useSessionData.ts';

/**
 * What the session page has loaded and shows, held by `useSessionData`, and
 * its first load, `useFirstLoad` (issue #422): rendered in Node's fake browser
 * by a component that calls them as the page does, with `fetch` held until a
 * test answers each call as the server would.
 */

const KEY = 'Kq7vN2xLm9Pz4Rt8Wy3Bc6Hd1Fg5Js0Ua-Ve_Xi2Ok7';

const browser = installFakeBrowser(`https://qa-tools.ru/v/${SESSION}`);

// Imported once the fake browser is in place: React DOM looks for a DOM as it loads.
const { createRoot } = await import('react-dom/client');
const { useFirstLoad, useSessionData } = await import('./useSessionData.ts');

/** The session as `GET /api/sessions/:sessionId` answers it, with the default response. */
function sessionRead(overrides: Partial<SessionDetails> = {}): SessionDetails {
  return {
    id: SESSION,
    expiresAt: '2026-10-01T00:00:00.000Z',
    receiveUrl: `https://hook.qa-tools.ru/s/${SESSION}`,
    requestsCount: 3,
    expiresAfterIdleSeconds: 604_800,
    lifetimeEndsAt: null,
    storeSourceIp: true,
    private: false,
    response: null,
    customResponse: null,
    queue: null,
    rules: [],
    ...overrides,
  };
}

const SESSION_URL = `/api/sessions/${SESSION}`;
const LIST_URL = `/api/sessions/${SESSION}/requests`;

/** What the hooks returned last. */
interface Page {
  data: SessionData;
  firstLoad: FirstLoad | null;
}

/**
 * The hooks rendered as the page holds them: `useSessionData`, and, with
 * `withFirstLoad`, `useFirstLoad` after it, whose `onLoaded` notes what it was
 * handed and which version of it was called, and puts the page on `ready`, as
 * the page's does, and whose status setter notes each status the load sets
 * before the page takes it. A new version of `onLoaded`, as the page makes one
 * when what it reads changes, starts the first load again with the page still
 * there (`restartFirstLoad`).
 */
async function renderData({
  withFirstLoad,
  storage = memoryStorage(),
}: {
  withFirstLoad: boolean;
  storage?: ReadStateStorage;
}) {
  const seen: { current: Page | null } = { current: null };
  const loaded: { session: SessionDetails; requests: string[]; onLoaded: number }[] = [];
  const loadStatuses: SessionPageStatus[] = [];
  const nextOnLoaded: { current: (() => void) | null } = { current: null };
  const container = browser.document.createElement('div');

  browser.document.body.appendChild(container);

  function DataProbe(): null {
    seen.current = { data: useSessionData({ sessionId: SESSION }), firstLoad: null };

    return null;
  }

  function PageProbe(): null {
    const data = useSessionData({ sessionId: SESSION });
    const { setStatus } = data;
    const [version, setVersion] = useState(1);

    nextOnLoaded.current = () => setVersion((current) => current + 1);

    const onLoaded = useCallback(
      (session: SessionDetails, requests: RequestListItem[]): void => {
        loaded.push({ session, requests: requests.map((item) => item.id), onLoaded: version });
        setStatus('ready');
      },
      [setStatus, version],
    );
    const setLoadStatus = useCallback(
      (next: SessionPageStatus): void => {
        loadStatuses.push(next);
        setStatus(next);
      },
      [setStatus],
    );
    const firstLoad = useFirstLoad({
      sessionId: SESSION,
      storage,
      listLoads: data.listLoads,
      setRequests: data.setRequests,
      setStatus: setLoadStatus,
      startSessionRead: data.startSessionRead,
      dropSessionRead: data.dropSessionRead,
      takeSessionRead: data.takeSessionRead,
      onLoaded,
    });

    seen.current = { data, firstLoad };

    return null;
  }

  const root = createRoot(container as unknown as HTMLElement);

  await act(async () => root.render(createElement(withFirstLoad ? PageProbe : DataProbe)));

  const current = (): Page => {
    assert.ok(seen.current, 'the hooks were not rendered');

    return seen.current;
  };

  return {
    get current(): Page {
      return current();
    },
    /** The page's status now: a call, which an assertion before it does not narrow. */
    status: (): SessionPageStatus => current().data.status,
    /** The session as the page shows it now. */
    session: (): SessionDetails | null => current().data.session,
    loaded,
    /** Each status the first load set, in order. */
    loadStatuses,
    /** Runs `call` as an event handler or a socket callback of the page would, its updates applied. */
    async run<T>(call: (data: SessionData) => T): Promise<[T]> {
      let result!: [T];

      await act(async () => {
        result = [call(current().data)];
      });

      return result;
    },
    /** Hands the first load a new version of `onLoaded`, which starts it again, the page still there. */
    restartFirstLoad: () =>
      act(async () => {
        assert.ok(nextOnLoaded.current, 'the first load was not rendered');
        nextOnLoaded.current();
      }),
    unmount: () => act(async () => root.unmount()),
  };
}

describe('useSessionData', () => {
  it('keeps the page on Session not found once it is there, whatever answers later (D133, D198)', async () => {
    const page = await renderData({ withFirstLoad: false });

    assert.equal(page.status(), 'loading');

    await page.run((data) => data.setStatus('ready'));
    assert.equal(page.status(), 'ready');

    await page.run((data) => data.setStatus('unavailable'));
    await page.run((data) => data.setStatus('ready'));
    await page.run((data) => data.setStatus('error'));
    assert.equal(page.status(), 'unavailable');

    await page.unmount();
  });

  it('applies a session read with the response change the socket brought while it was in flight on top (D152)', async (t) => {
    const calls = holdFetch(t);
    const page = await renderData({ withFirstLoad: false });

    // A first read on screen, answered with the default response.
    const [first] = await page.run((data) => data.reloadSession());

    await calls[0]!.answer(200, sessionRead());
    await first;
    assert.equal(page.session()?.response, null);

    // A connection's read begins; another viewer changes the response before it answers.
    const [second] = await page.run((data) => data.reloadSession());

    await page.run((data) => data.takeResponseEvent({ type: 'updated', state: answering(201) }));
    assert.equal(page.session()?.response?.status, 201);

    // The read was taken before the change, and does not undo it.
    await calls[1]!.answer(200, sessionRead({ requestsCount: 4 }));
    await second;
    assert.equal(page.session()?.response?.status, 201);
    assert.equal(page.session()?.requestsCount, 4);
    assert.deepEqual(
      calls.map((call) => call.url),
      [SESSION_URL, SESSION_URL],
    );

    await page.unmount();
  });

  it('takes the page to Session not found when a read finds its session gone, and keeps it on any other failure (D133)', async (t) => {
    const calls = holdFetch(t);
    const page = await renderData({ withFirstLoad: false });

    await page.run((data) => data.setStatus('ready'));

    const [failed] = await page.run((data) => data.reloadSession());

    await calls[0]!.answer(503, { message: 'Service unavailable' });
    await failed;
    assert.equal(page.status(), 'ready');

    const [gone] = await page.run((data) => data.reloadSession());

    await calls[1]!.answer(410, { errorCode: ErrorCode.SESSION_EXPIRED, message: 'Expired' });
    await gone;
    assert.equal(page.status(), 'unavailable');

    await page.unmount();
  });

  it('reads the session every 10 minutes only while the page shows it (D249, #216)', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const calls = holdFetch(t);
    const page = await renderData({ withFirstLoad: false });

    // Still loading: no read starts.
    t.mock.timers.tick(SESSION_READ_INTERVAL_MS);
    await settle();
    assert.deepEqual(
      calls.map((call) => call.url),
      [],
    );

    // Showing the session: the read starts 10 minutes on.
    await page.run((data) => data.setStatus('ready'));
    t.mock.timers.tick(SESSION_READ_INTERVAL_MS - 1);
    await settle();
    assert.deepEqual(
      calls.map((call) => call.url),
      [],
    );

    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(
      calls.map((call) => call.url),
      [SESSION_URL],
    );
    await calls[0]!.answer(200, sessionRead());

    // Showing an error: no read starts.
    await page.run((data) => data.setStatus('error'));

    for (let tick = 0; tick < 3; tick += 1) {
      t.mock.timers.tick(SESSION_READ_INTERVAL_MS);
      await settle();
    }

    assert.equal(calls.length, 1);

    await page.unmount();
  });

  it('stops the 10-minute read with the page (D249)', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const calls = holdFetch(t);
    const page = await renderData({ withFirstLoad: false });

    await page.run((data) => data.setStatus('ready'));
    t.mock.timers.tick(SESSION_READ_INTERVAL_MS);
    await settle();
    assert.equal(calls.length, 1);
    await calls[0]!.answer(200, sessionRead());

    await page.unmount();

    for (let tick = 0; tick < 3; tick += 1) {
      t.mock.timers.tick(SESSION_READ_INTERVAL_MS);
      await settle();
    }

    assert.equal(calls.length, 1);
  });
});

describe('useFirstLoad', () => {
  it('reads the session and its list together, keeps a request delivered meanwhile and hands the answer to the page (D133, #39)', async (t) => {
    const calls = holdFetch(t);
    const page = await renderData({ withFirstLoad: true });

    assert.deepEqual(
      calls.map((call) => call.url),
      [SESSION_URL, LIST_URL],
    );
    assert.equal(page.status(), 'loading');

    // The socket delivers a request before the list answers, as `onRequest` does.
    await page.run((data) => {
      data.listLoads.received('req-new');
      data.setRequests((current) => mergeRequests(current, [row('req-new')]));
    });

    await calls[0]!.answer(200, sessionRead());
    assert.equal(page.loaded.length, 0, 'the list has not answered yet');

    await calls[1]!.answer(200, [row('req-a')]);
    assert.deepEqual(
      page.loaded.map((done) => [done.session.id, done.requests]),
      [[SESSION, ['req-a']]],
    );
    assert.deepEqual(page.current.data.requests.map((item) => item.id).sort(), [
      'req-a',
      'req-new',
    ]);
    assert.equal(page.session()?.id, SESSION);
    assert.equal(page.status(), 'ready');
    // A public session keeps no key.
    assert.equal(page.current.firstLoad?.openedKey, null);

    await page.unmount();
  });

  it('keeps the key a private session opened with (D259, #264)', async (t) => {
    const calls = holdFetch(t);
    const storage = memoryStorage();

    storage.setItem(ACCESS_KEYS_KEY, JSON.stringify({ v: 1, items: [{ id: SESSION, key: KEY }] }));

    const page = await renderData({ withFirstLoad: true, storage });

    assert.equal(page.current.firstLoad?.openedKey, null);

    // Another tab removes the key while the load's calls are held: the page
    // keeps the one the load was sent with.
    storage.removeItem(ACCESS_KEYS_KEY);

    await calls[0]!.answer(200, sessionRead({ private: true }));
    await calls[1]!.answer(200, []);
    assert.equal(page.current.firstLoad?.openedKey, KEY);

    await page.unmount();
  });

  it('hands a session that is gone to the page, and nothing to its onLoaded (D133)', async (t) => {
    const calls = holdFetch(t);
    const page = await renderData({ withFirstLoad: true });

    await calls[1]!.answer(200, []);
    await calls[0]!.answer(404, { errorCode: ErrorCode.SESSION_NOT_FOUND, message: 'Not found' });

    assert.equal(page.status(), 'unavailable');
    assert.equal(page.session(), null);
    assert.deepEqual(page.loaded, []);
    assert.deepEqual(page.loadStatuses, ['unavailable']);

    await page.unmount();
  });

  it('applies nothing of a load that answers once the page has gone (D133, D156)', async (t) => {
    const calls = holdFetch(t);
    const storage = memoryStorage();

    // A request opened here before the load, which a list without it drops.
    recordRead(storage, SESSION, 'req-old', Date.now() - 60_000);

    const readState = storage.getItem(readStateKey(SESSION));
    const page = await renderData({ withFirstLoad: true, storage });

    await page.unmount();
    await calls[0]!.answer(200, sessionRead());
    await calls[1]!.answer(200, [row('req-a')]);

    assert.deepEqual(page.loaded, [], 'the page was handed the answer');
    assert.equal(storage.getItem(readStateKey(SESSION)), readState, 'the read state was pruned');
  });

  it('sets no status and lets go of no key for a load that fails once the page has gone (D133, D259)', async (t) => {
    t.after(releaseAllAccessKeys);

    const calls = holdFetch(t);

    // A link's key, held in this tab and not stored: a refused load lets it go.
    holdAccessKey(SESSION, KEY);

    const page = await renderData({ withFirstLoad: true });

    await page.unmount();
    await calls[1]!.answer(200, []);
    await calls[0]!.answer(404, { errorCode: ErrorCode.SESSION_NOT_FOUND, message: 'Not found' });

    assert.deepEqual(page.loadStatuses, []);
    assert.equal(accessKeyFor(SESSION, null), KEY);
  });

  /**
   * The first load starts again whenever one of its options changes - here a
   * new version of `onLoaded` - and the page stays. The load it replaced
   * answers first and applies nothing: not its session, not its list, not
   * its `onLoaded`. The load that replaced it is applied as a first load, with
   * what the socket brought after the replaced one answered on top, and an
   * event after it is shown at once. What the replaced load lets go of as it
   * answers, its list load (`listLoad.abandon()`) and its session read
   * (`dropSessionRead`), is not on screen: a list load or a session read left
   * in flight only keeps what the socket brings, for an answer of its own
   * that never comes. So this pins what the page shows across the restart,
   * not those two calls.
   */
  it('applies nothing of a first load started again in flight, and the load that replaced it with what the socket brought on top (D133, D152, #39)', async (t) => {
    const calls = holdFetch(t);
    const page = await renderData({ withFirstLoad: true });

    await page.restartFirstLoad();
    assert.deepEqual(
      calls.map((call) => call.url),
      [SESSION_URL, LIST_URL, SESSION_URL, LIST_URL],
    );

    // The replaced load answers first, while the one that replaced it is in flight.
    await calls[0]!.answer(200, sessionRead({ requestsCount: 1 }));
    await calls[1]!.answer(200, [row('req-stale')]);

    // Through `length` and `map`, which an assertion does not narrow for the checks below.
    assert.equal(page.loaded.length, 0, 'the replaced load was handed to the page');
    assert.equal(page.session(), null, 'the replaced load put its session on screen');
    assert.deepEqual(
      page.current.data.requests.map((item) => item.id),
      [],
      'the replaced load put its list on screen',
    );
    assert.equal(page.status(), 'loading');
    assert.deepEqual(page.loadStatuses, []);

    // The socket delivers a request, as `onRequest` does, and another viewer
    // changes the response, before the load that replaced it answers.
    await page.run((data) => {
      data.listLoads.received('req-new');
      data.setRequests((current) => mergeRequests(current, [row('req-new')]));
    });
    await page.run((data) => data.takeResponseEvent({ type: 'updated', state: answering(201) }));

    await calls[2]!.answer(200, sessionRead({ requestsCount: 2 }));
    await calls[3]!.answer(200, [row('req-a')]);

    assert.deepEqual(
      page.loaded.map((done) => [done.session.requestsCount, done.requests, done.onLoaded]),
      [[2, ['req-a'], 2]],
    );
    assert.deepEqual(page.current.data.requests.map((item) => item.id).sort(), [
      'req-a',
      'req-new',
    ]);
    assert.equal(page.session()?.requestsCount, 2);
    assert.equal(page.session()?.response?.status, 201);
    assert.equal(page.status(), 'ready');
    assert.deepEqual(page.loadStatuses, []);

    // What the socket brings afterwards is shown at once.
    await page.run((data) => data.takeResponseEvent({ type: 'updated', state: answering(202) }));
    assert.equal(page.session()?.response?.status, 202);

    await page.unmount();
  });
});
