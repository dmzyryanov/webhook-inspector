import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  RequestListItem,
  SessionDetails,
  SessionResponseState,
} from '@webhook-inspector/shared';
import * as api from '../api/client.ts';
import { openSessionSocket } from '../api/realtime.ts';
import { AppFooter } from '../components/AppFooter.tsx';
import { AppHeader } from '../components/AppHeader.tsx';
import { BackBar } from '../components/BackBar.tsx';
import type { ChosenDetails } from '../components/CompareView.tsx';
import { EndpointCard } from '../components/EndpointCard.tsx';
import { SessionNotFound } from '../components/NotFound.tsx';
import { RequestDetail } from '../components/RequestDetail.tsx';
import { RequestActionsSheet } from '../components/RequestActions.tsx';
import { RequestList } from '../components/RequestList.tsx';
import { SessionUnavailable } from '../components/SessionUnavailable.tsx';
import { Toast, type ToastIcon, type ToastMessage } from '../components/Toast.tsx';
import { useComparison, useEscapeLeavesPicking } from '../hooks/useComparison.ts';
import { useDesktopLayout } from '../hooks/useDesktopLayout.ts';
import { usePushFlowHistory } from '../hooks/usePushFlowHistory.ts';
import { useReadState } from '../hooks/useReadState.ts';
import { useRequestFilter } from '../hooks/useRequestFilter.ts';
import { staleLink, useRequestSelection } from '../hooks/useRequestSelection.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import type { Phrase } from '../i18n/en.ts';
import { cn } from '../lib/cn.ts';
import {
  countArrivedSince,
  focusOnViewChange,
  formatArrivedBadge,
  formatOpenPosition,
  pushView,
  scrollOnViewChange,
  type PushView,
  type ViewChange,
} from '../lib/push-flow.ts';
import {
  applyRequestDeleted,
  applyResponseRecorded,
  createListLoads,
  deletionClosesDetails,
  mergeRequests,
  reloadClosesDetails,
  replaceWithReloaded,
  shouldRefreshDetails,
  shouldRefreshDetailsOnReady,
} from '../lib/requests.ts';
import { resolveRequestLinkUnlessMove, takeKeyUnlessMove } from '../lib/move-link.ts';
import { removesFragment, takeKeyFromAddress, type AddressBar } from '../lib/request-link.ts';
import { accessKeyFor, heldOnlyInThisTab, settleOpenedKey } from '../lib/access-keys.ts';
import { browserStorage, pruneReadState } from '../lib/read-state.ts';
import {
  classifySessionError,
  keepsNoAddress,
  readSessionPeriodically,
  reloadSessionOnConnection,
  settleLoadFailure,
  settlePageStatus,
  type SessionPageStatus,
} from '../lib/session-lifetime.ts';
import {
  abandonSessionRead,
  applyResponseState,
  beginSessionRead,
  NO_RESPONSE_STATE,
  ownChangeState,
  queueStartedSince,
  recordOwnAnswer,
  recordResponseEvent,
  settleSessionRead,
  type HeldResponseState,
  type ResponseEvent,
} from '../lib/session-response.ts';
import { receiveOrigin, sessionReceiveUrl } from '../lib/receive-url.ts';
import { recordSessionOpened } from '../lib/session-list.ts';
import { EMPTY_SIGNATURE_MEMORY, type SignatureMemory } from '../lib/signature.ts';

/** The page's states and the rule that chooses them live in `session-lifetime`. */
type Status = SessionPageStatus;

/**
 * Whether keyboard focus has nowhere visible to be: on the page body, or on an
 * element that is no longer shown - the list hidden under an open request, or
 * the Back bar that closing it removed.
 */
function focusIsLost(): boolean {
  const active = document.activeElement;

  return active === null || active === document.body || active.getClientRects().length === 0;
}

interface SessionPageProps {
  /**
   * The session this page shows. `App` mounts the page keyed by it, so this
   * value never changes for a given instance (D080).
   */
  sessionId: string;
}

/** The tab's address bar, which a link's key is taken out of (D259). */
const addressBar: AddressBar = {
  get href() {
    return window.location.href;
  },
  replace: (href) => window.history.replaceState(window.history.state, '', href),
};

/**
 * The session page, opened afresh when `Session not found` is given the key
 * of this very session (issue #228, D259): `Session not found` is final for
 * the page that shows it (`settlePageStatus`), so the key the field checked
 * and kept opens a new one, with state of its own, as another session's page
 * would be (D080).
 *
 * So does a link with access to this session put into the tab's address bar
 * while the page is shown - pasted on its `Session not found`, say. Only the
 * fragment changes: the browser loads no new document, and `App` keeps this
 * page, keyed by the session, so the reading before the first load would never
 * see it. On `hashchange` the key is taken out of the address at once, adding
 * no history entry, and held (`takeKeyFromAddress`), and the page opens
 * afresh, its first load presenting it; a malformed fragment is taken out
 * too. D182's `#<request-id>` changes nothing here: a page reads it once,
 * after its first list load, as before. A move link's fragment (D276) is left
 * where it is, for `main.tsx`, which loads the page again to read it
 * (`takeKeyUnlessMove`, issue #345); the reading after the first list load,
 * whose answer may come before that load takes the address, leaves it too
 * (`resolveRequestLinkUnlessMove`, issue #362).
 */
export function SessionPage({ sessionId }: SessionPageProps) {
  const [opening, setOpening] = useState(0);
  const reopen = useCallback(() => setOpening((current) => current + 1), []);

  useEffect(() => {
    function onHashChange(): void {
      if (takeKeyUnlessMove(sessionId, browserStorage(), addressBar).kind === 'access') {
        reopen();
      }
    }

    window.addEventListener('hashchange', onHashChange);

    return () => window.removeEventListener('hashchange', onHashChange);
  }, [sessionId, reopen]);

  return <SessionView key={opening} sessionId={sessionId} onReopen={reopen} />;
}

interface SessionViewProps extends SessionPageProps {
  /** Opens this session's page afresh. */
  onReopen: () => void;
}

function SessionView({ sessionId, onReopen }: SessionViewProps) {
  const m = useMessages();
  const [status, setSettledStatus] = useState<Status>('loading');
  /**
   * Every change of the page's status goes through `settlePageStatus`, which
   * keeps a page on `Session not found` once it is there (D133, D198): the
   * load on mount, a reload or an action answering later cannot put a deleted
   * or expired session back on screen. Showing that screen does not unmount
   * the page, so whatever is in flight still resolves here.
   */
  const setStatus = useCallback((next: Status): void => {
    setSettledStatus((current) => settlePageStatus(current, next));
  }, []);
  const [session, setSession] = useState<SessionDetails | null>(null);
  const [requests, setRequests] = useState<RequestListItem[]>([]);
  /** A failed deletion, said in the list in the language shown (D222). */
  const [actionError, setActionError] = useState<Phrase | null>(null);
  /**
   * This browser's `localStorage`, or `null` where it is unavailable - in which
   * case read state stays in this tab, as it did before #46 (D156).
   */
  const [storage] = useState(browserStorage);
  /**
   * The key this page's private session opened with (D259, #264): the one in
   * force as the load that brought the session started, kept once that load
   * answered a private session, `null` for a public one. The card's lock,
   * `Copy ▾` and a request's `Copy link` take it from here rather than from
   * the store at each render, so a key another tab removes leaves them as
   * they are, as long as the page shows the session; every call and the
   * socket still read the store, so the next call is answered as a missing
   * session's. Tied to the session id it was read for, so it is gone once the
   * page moves to another session.
   */
  const [openedKey, setOpenedKey] = useState<{ sessionId: string; key: string | null } | null>(
    null,
  );

  /*
   * A link with access (D259): its key is read before anything is asked of
   * the server - this runs before the page's first load and its socket, which
   * are passive effects - held in this tab, and taken out of the address at
   * once, by the `replaceState` that leaves the request id alone, if the link
   * named one, for its reading after the first list load (D182). No history
   * entry keeps the key. A fragment of any other shape but D182's request id
   * goes at once too, so no part of a key mistyped or cut short stays in the
   * address. A key this browser already holds for the session is kept
   * (`takeKeyFromAddress`).
   */
  useLayoutEffect(() => {
    takeKeyFromAddress(sessionId, storage, addressBar);
  }, [sessionId, storage]);
  /** Whether the session keeps no sender address, so its rows say `IP not stored` (D249). */
  const addressNotStored = keepsNoAddress(session);
  /** The list filter, its search of headers and bodies, and the rows it keeps (D180, D191). */
  const { filterQuery, changeFilter, rawSearchState, rawSearch, filteredRequests } =
    useRequestFilter({
      sessionId,
      storage,
      requests,
      keepsNoAddress: addressNotStored,
      messages: m,
      setStatus,
    });
  /** The requests opened in this browser, and the unread count in the tab title (D014, D156). */
  const { openedIds, setOpenedIds } = useReadState({
    sessionId,
    storage,
    requests,
    showingRequests: status === 'ready',
    messages: m,
  });

  /**
   * The list loads in flight: whether a deletion has discarded them since they
   * began (D136), and what `request.received` delivered meanwhile (#39).
   */
  const [listLoads] = useState(createListLoads);
  /**
   * The response state the page shows, the session reads in flight with the
   * events taken since each began, and the revision the answer to the
   * viewer's own call compares against (D152, D205). A read is applied with
   * those events on top, so neither a read nor an event undoes the other.
   * Every change to what the page shows of the response goes through it
   * first, so it is always what the page shows.
   */
  const responseState = useRef<HeldResponseState>(NO_RESPONSE_STATE);
  /**
   * The ids the list held when the open request was opened. Whatever the list
   * holds beyond them arrived since, and the Back bar counts it (6C, D157).
   */
  const [knownAtOpen, setKnownAtOpen] = useState<ReadonlySet<string>>(() => new Set());
  /** Where the list was scrolled when a request covered it in the push flow. */
  const listScroll = useRef(0);
  /** The request opened last, whose row takes focus back when it closes. */
  const lastOpened = useRef<string | null>(null);
  /** Whether the address's request link has been read: once per page (D182). */
  const linkRead = useRef(false);
  /**
   * The page's one toast (D182): a saved response change, a copy from the
   * request actions or its refusal, a linked request that is gone. A new one
   * replaces the one on screen.
   */
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  const showToast = useCallback((text: Phrase, icon: ToastIcon = 'check'): void => {
    setToast((current) => ({ id: (current?.id ?? 0) + 1, text, icon }));
  }, []);
  const backButton = useRef<HTMLButtonElement>(null);
  const listSection = useRef<HTMLElement>(null);
  /**
   * What `Check signature…` remembers - the secret, the header chosen and the
   * algorithm switched to - for every request opened on this page, in memory
   * only: a reload, or another session's page, starts from nothing (#74,
   * D197). A ref, read and written by the check, so typing in it does not
   * re-render the page.
   */
  const signatureMemory = useRef<SignatureMemory>(EMPTY_SIGNATURE_MEMORY);
  /**
   * Below 1024 px the page is the push flow: the list, or the open request
   * over it (D157). The layout is CSS; this decides what CSS cannot - the
   * history entry that makes Back return to the list.
   */
  const layout = useDesktopLayout() ? 'split' : 'push';
  /**
   * `Compare with…` for the open request (D186): picking, or comparing with
   * the chosen request, whose details it loads. Held before the selection,
   * which ends it whenever the selection changes.
   */
  const {
    comparison,
    chosenDetails,
    startPicking,
    choose,
    loadChosen,
    showView,
    cancelComparisonPicking,
    endComparison,
  } = useComparison({ sessionId, storage, setOpenedIds, setStatus, listScroll });
  /**
   * The open request and its details: opened by a click or a request link
   * (D182), refreshed on a recorded response or a `ready` (D125), closed by
   * Back, a deletion or a clear (D137).
   */
  const {
    selectedId,
    selectedIdRef,
    details,
    detailFailed,
    discardPendingDetails,
    refreshDetails,
    select,
    openLinked,
  } = useRequestSelection({
    sessionId,
    storage,
    setOpenedIds,
    setRequests,
    setStatus,
    endComparison,
    showToast,
    listScroll,
    lastOpened,
    setKnownAtOpen,
    listSection,
  });
  const picking = comparison?.phase === 'picking' && selectedId !== null;
  // Below 1024 px picking is the list screen, over the open request (A4, D186).
  const view = picking ? 'list' : pushView(selectedId);

  /**
   * Loads the list and puts it on screen in place of what was there.
   *
   * Runs on every connection of the realtime socket, which is what makes a
   * reconnection pick up the requests captured while it was down (D077) and
   * drop the ones deleted meanwhile (#39): the loaded list replaces the one on
   * screen, keeping only what `request.received` delivered after the load
   * began, with what `response.recorded` delivered meanwhile written onto the
   * rows it brings (#174). An open request that is no longer listed closes as
   * on a received deletion (D137). A deletion during the load discards its
   * answer, so a load that started before it cannot put the deleted row back
   * (D136), and so does a later reload that answered first, whose list is the
   * fresher one.
   */
  const reloadRequests = useCallback(async (): Promise<void> => {
    const load = listLoads.begin();
    const startedAt = Date.now();
    let loaded: RequestListItem[];

    try {
      loaded = await api.listRequests(sessionId);
    } catch (error) {
      load.abandon();

      const classified = classifySessionError(error);

      // A closed session takes over the page; a reload that failed for any
      // other reason leaves the list alone and is retried on the next
      // reconnection.
      if (classified !== 'error') {
        setStatus(classified);
      }

      return;
    }

    const settled = load.settle();

    pruneReadState(
      storage,
      sessionId,
      loaded.map((item) => item.id),
      startedAt,
      Date.now(),
    );

    if (settled === null) {
      return;
    }

    if (reloadClosesDetails(selectedIdRef.current, loaded, settled.receivedIds)) {
      discardPendingDetails();
    }

    setRequests((current) =>
      replaceWithReloaded(current, loaded, settled.receivedIds, settled.responses),
    );
    // The list may hold requests captured while the socket was down: what
    // their headers and bodies hold is asked again (D191).
    rawSearch.listReloaded();
  }, [sessionId, storage, listLoads, discardPendingDetails, rawSearch, setStatus]);

  /**
   * A session read begun, on mount or on a `ready` (D133): from now on the
   * events the socket brings are kept for it. Answers its order, which
   * `takeSessionRead` or `dropSessionRead` hands back.
   */
  const startSessionRead = useCallback((): number => {
    const begun = beginSessionRead(responseState.current);

    responseState.current = begun.held;

    return begun.order;
  }, []);

  /** A session read whose answer will not be used: it failed, or the page left. */
  const dropSessionRead = useCallback((order: number): void => {
    responseState.current = abandonSessionRead(responseState.current, order);
  }, []);

  /**
   * A session read answered (D152, D205): applied with the events taken while
   * it was in flight on top, in the order they arrived, unless a read that
   * began after it has been applied already, which leaves the page as it is.
   */
  const takeSessionRead = useCallback((read: SessionDetails, order: number): void => {
    const settled = settleSessionRead(responseState.current, order, read);

    responseState.current = settled.held;

    if (settled.shown !== null) {
      setSession(settled.shown);
    }
  }, []);

  /**
   * Loads the session again on every realtime connection (D133).
   *
   * The list reload beside it is about missed requests (D077); this one is
   * about the session itself. Reading it slides its expiry, which is what makes
   * a tab left open a continuing use, and it is also the moment such a tab
   * learns that its session is gone - an established socket is not closed when
   * its session expires (D076), so nothing else would tell it.
   *
   * A transient failure leaves the page exactly as it is and is retried on the
   * next connection. Only a session-level answer takes the page over.
   */
  const reloadSession = useCallback(async (): Promise<void> => {
    const order = startSessionRead();
    const reloaded = await reloadSessionOnConnection(() => api.getSession(sessionId));

    if (reloaded.outcome === 'loaded') {
      takeSessionRead(reloaded.session, order);

      return;
    }

    dropSessionRead(order);

    if (reloaded.outcome === 'unavailable') {
      setStatus('unavailable');
    }
  }, [sessionId, setStatus, startSessionRead, dropSessionRead, takeSessionRead]);

  /**
   * What the socket says about the response state (D152, D205):
   * `session.updated` from any viewer, this one included, a capture that took
   * a step of the response queue, named by its `request.received`, and a
   * clear, which starts the queue from step 1. Applied to what the page shows
   * at once, and kept by every session read in flight, which is applied with
   * it on top.
   */
  const takeResponseEvent = useCallback((event: ResponseEvent): void => {
    const held = responseState.current;
    const next = recordResponseEvent(held, event);

    responseState.current = next;

    if (next.state !== held.state && next.state !== null) {
      const state = next.state;

      setSession((current) => applyResponseState(current, state));
    }
  }, []);

  /**
   * The answer to this viewer's own change, from a call started at
   * `startedAt` (D152, D205): taken unless the page has taken anything since
   * the call started - its own event, a capture that took a step after it, a
   * read - which the answer must not undo. Answers the response state the
   * toast about the change describes: the answer, or what the page shows
   * once it holds the change's own event (`ownChangeState`).
   */
  const takeOwnAnswer = useCallback(
    (state: SessionResponseState, startedAt: number): SessionResponseState => {
      const held = responseState.current;
      const described = ownChangeState(held, state, startedAt);
      const next = recordOwnAnswer(held, state, startedAt);

      if (next !== held) {
        responseState.current = next;
        setSession((current) => applyResponseState(current, state));
      }

      return described;
    },
    [],
  );

  /** Where the page's revision stands, read by a surface as its call starts. */
  const responseRevision = useCallback((): number => responseState.current.revision, []);

  /** Whether the queue was started from step 1 since a call started (D205). */
  const queueStartedSinceCall = useCallback(
    (startedAt: number): boolean => queueStartedSince(responseState.current, startedAt),
    [],
  );

  /*
   * Back from an open request returns to the list (D157). Closing it - by Back,
   * by `‹ Requests`, or on its own - is the same state change as a deletion of
   * the open request: the panel's empty state on the desktop, the list below
   * 1024 px. A page not showing requests has nothing open.
   */
  const { removeAddressFragment } = usePushFlowHistory({
    layout,
    openId: status === 'ready' ? selectedId : null,
    // Back while picking returns to the open request, as `Cancel` does
    // (D186); the request's entry is pushed again for the Back after it.
    onBack: picking ? cancelComparisonPicking : discardPendingDetails,
    showingRequests: status === 'ready',
  });

  /*
   * The push flow opens a request at its top and returns to the list where
   * it was left. The list is the page's scroll there, so the page's scroll
   * position is the list's.
   *
   * Focus follows the screen (WCAG 2.4.3, D157): the row that opened a request
   * is hidden with the list, so focus moves to `‹ Requests`; the Back bar is
   * gone once the request closes, so focus returns to that request's row, or
   * to the list's heading when the row is gone too. A close that leaves focus
   * on something still shown - the wordmark - leaves it there. The desktop's
   * focus is never moved.
   */
  const shownView = useRef<PushView>(view);

  useLayoutEffect(() => {
    const change: ViewChange = { layout, from: shownView.current, to: view };

    shownView.current = view;

    const scroll = scrollOnViewChange({ ...change, listScroll: listScroll.current });

    if (scroll !== null) {
      window.scrollTo(0, scroll);
    }

    const list = listSection.current;
    const row =
      lastOpened.current === null
        ? null
        : (list?.querySelector<HTMLElement>(
            `[data-request-id="${CSS.escape(lastOpened.current)}"]`,
          ) ?? null);
    const target = focusOnViewChange({
      ...change,
      focusLost: focusIsLost(),
      openRowListed: row !== null,
    });
    const element =
      target === 'back-button'
        ? backButton.current
        : target === 'open-row'
          ? row
          : target === 'list-heading'
            ? // The filter field while it shows, which hides the heading (D180).
              (list?.querySelector<HTMLElement>('[data-list-filter]') ??
              list?.querySelector<HTMLElement>('h2') ??
              null)
            : null;

    element?.focus({ preventScroll: true });
  }, [layout, view]);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      const listLoad = listLoads.begin();
      const read = startSessionRead();
      const listStartedAt = Date.now();
      // The key `api.getSession` presents, read as it is sent: the one the page
      // keeps for a private session (`openedKey`).
      const keyAtLoad = accessKeyFor(sessionId, storage);

      try {
        let loadedSession: SessionDetails;
        let loadedRequests: RequestListItem[];

        try {
          [loadedSession, loadedRequests] = await Promise.all([
            api.getSession(sessionId),
            api.listRequests(sessionId),
          ]);
        } catch (error) {
          listLoad.abandon();
          dropSessionRead(read);
          throw error;
        }

        if (cancelled) {
          listLoad.abandon();
          dropSessionRead(read);

          return;
        }

        // `null` also when a `ready` reload that began later has already put
        // its fresher list on screen.
        const settled = listLoad.settle();

        pruneReadState(
          storage,
          sessionId,
          loadedRequests.map((item) => item.id),
          listStartedAt,
          Date.now(),
        );

        // With what the socket brought meanwhile on top, rather than assigned:
        // a response change may already have arrived while this load was in
        // flight (D152).
        takeSessionRead(loadedSession, read);

        // Merged rather than assigned: the socket may already have delivered a
        // request while this load was in flight. Nothing on screen predates
        // the page, so unlike the reload on `ready` (#39) there is no stale
        // row for a merge to keep. A response recorded meanwhile is written
        // onto the row the answer brings, which may predate it (#174).
        if (settled !== null) {
          setRequests((current) => mergeRequests(current, loadedRequests, settled.responses));
        }

        setOpenedKey({ sessionId, key: loadedSession.private === true ? keyAtLoad : null });
        setStatus('ready');

        // The key it opened with is kept for a private session - stored, so
        // the list marks it and reads it with its key - and dropped for a
        // public one, which needs none (D259). Before the list records it, so
        // a full list pushes out a public session first. A private session
        // whose key another tab removed while it loaded is not listed again.
        //
        // Otherwise the page has loaded the session, so it joins - or moves to
        // the top of - the list of sessions the home page shows for this
        // browser (D199). Blocked or full storage lists nothing, with no error.
        if (settleOpenedKey(storage, sessionId, loadedSession.private)) {
          recordSessionOpened(storage, sessionId, Date.now());
        }

        // A request link is read once, now that the list is known, and its
        // fragment leaves the address whatever it held (D182) - but a move
        // link's, pasted while this load was in flight, which stays for
        // `main.tsx`'s reload to read, as on `hashchange` (issue #362). The
        // fragment goes first, so the entry the push flow pushes for the
        // linked request copies the address without it.
        if (!linkRead.current) {
          linkRead.current = true;

          const link = resolveRequestLinkUnlessMove(window.location.href, loadedRequests);

          if (removesFragment(link)) {
            removeAddressFragment();
          }

          if (link.kind === 'open') {
            void openLinked(link.requestId, loadedRequests);
          } else if (link.kind === 'stale') {
            showToast(staleLink, 'info');
          }
        }
      } catch (error) {
        if (!cancelled) {
          // Refused, a key held here and not stored - a link's, unchecked
          // until now - opened nothing and is let go (`settleLoadFailure`).
          setStatus(settleLoadFailure(sessionId, error));
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [
    sessionId,
    storage,
    listLoads,
    removeAddressFragment,
    openLinked,
    showToast,
    setStatus,
    startSessionRead,
    dropSessionRead,
    takeSessionRead,
  ]);

  /**
   * Watches the session for captured requests, their responses and their
   * deletion by any viewer. A refused connection is
   * the same verdict a session-scoped HTTP call would give, so it moves the
   * page to that state - which is also how a session expiring in an open tab
   * becomes visible.
   */
  useEffect(() => {
    // The key the page holds by now: a link's was read before this effect.
    const accessKey = accessKeyFor(sessionId, storage);

    return openSessionSocket(
      sessionId,
      {
        onReady: () => {
          void reloadRequests();
          void reloadSession();

          // A response recorded while the socket was down sent its event to no
          // one: the reload brings the row's final state, this the panel's
          // (#204).
          const openId = selectedIdRef.current;

          if (shouldRefreshDetailsOnReady(openId)) {
            void refreshDetails(openId);
          }
        },
        onRequest: (event) => {
          // Inserted, never selected: the request being inspected stays put
          // (D014). A list load in flight keeps it even if its answer lacks it
          // (#39).
          listLoads.received(event.data.id);
          setRequests((current) => mergeRequests(current, [event.data]));

          // The step of the response queue it took, if any: the queue's section
          // and the label move on at once, from any sender (D205).
          const step = event.data.response?.queueStep;

          if (step !== null && step !== undefined) {
            takeResponseEvent({ type: 'step', step });
          }
          // Shown at once if its list fields match; what its headers and body
          // hold is asked within a second, once for a burst (D191).
          rawSearch.requestsArrived();
        },
        /*
         * The late half of the same exchange: the row's response summary is
         * updated in place, with no reload, which is what makes a `pending` row
         * reach its final state in front of the viewer (D110). An id this list
         * does not hold changes nothing and never creates a row - the event
         * carries a summary, not a row.
         *
         * A list load in flight keeps it too, and writes it onto the row its
         * answer brings, which may have been read before the response was
         * recorded - even a row this list did not hold yet (#174).
         *
         * The open panel follows the same transition, but it cannot be patched
         * from this payload: the summary has a state and a status, and the panel
         * shows the whole record. So the detail is fetched again when the event
         * names the request currently on screen (D125).
         */
        onResponse: (event) => {
          listLoads.recorded(event.data.id, event.data.response);
          setRequests((current) => applyResponseRecorded(current, event.data));

          if (shouldRefreshDetails(event.data.id, selectedIdRef.current)) {
            void refreshDetails(event.data.id);
          }
        },
        /*
         * A deletion, by another viewer of this session or by this one (D136).
         * The same state change `remove()` applies after its own `204`, and just
         * as idempotent: the acting viewer has already dropped the row, so its
         * own event changes nothing. A panel showing the deleted request returns
         * to the empty state with no notice (D137). The list generation moves
         * for the same reason it does in `remove()`: a reload already in flight
         * must not put the row back.
         */
        onDeleted: (event) => {
          if (deletionClosesDetails(event.data.id, selectedIdRef.current)) {
            discardPendingDetails();
          }

          listLoads.invalidate();
          setRequests((current) => applyRequestDeleted(current, event.data.id));
        },
        onCleared: () => {
          discardPendingDetails();
          listLoads.invalidate();
          setRequests((current) => (current.length === 0 ? current : []));
          // A clear starts the response queue from step 1 (D205).
          takeResponseEvent({ type: 'cleared' });
        },
        /*
         * The session's response was changed, by another viewer or by this one
         * (D152). The whole state is replaced, so the button label follows at
         * once; an open settings surface follows it too until the viewer has
         * chosen something in it, and from then on keeps the choice (last write
         * wins). This viewer's own change arrives here as well, usually before
         * its answer, which it then sets aside (`recordOwnAnswer`); arriving
         * after an answer that was taken, it sets the same state again, and
         * after one set aside, it is what brings the change to the page
         * (correction round 6).
         */
        onSessionUpdated: (event) => {
          takeResponseEvent({ type: 'updated', state: event.data });
        },
        // Both refusal codes say the same thing to this page, exactly as `410`
        // and `404` do over HTTP.
        onRefused: () => {
          setStatus('unavailable');
        },
      },
      accessKey,
    );
  }, [
    sessionId,
    storage,
    reloadRequests,
    reloadSession,
    refreshDetails,
    discardPendingDetails,
    takeResponseEvent,
    listLoads,
    rawSearch,
    setStatus,
  ]);

  /**
   * Reads the session every 10 minutes while the page shows it, besides each
   * connection's read, so a tab left open keeps even a 1-hour session alive
   * (issue #216, D249). The read is the connection's own: a `410` or `404`
   * takes the page to `Session not found`, any other failure keeps it as it
   * is. It stops once the page shows anything else, and with the page.
   */
  useEffect(() => {
    if (status !== 'ready') {
      return;
    }

    return readSessionPeriodically(reloadSession);
  }, [status, reloadSession]);

  // Escape anywhere leaves picking with nothing changed, unless something on
  // the page - a dialog, the filter field - has used it already.
  useEscapeLeavesPicking(picking, cancelComparisonPicking);

  /**
   * A row was tapped or clicked: the list's scroll and the requests it holds
   * are noted for the push flow, and the request is selected exactly as on the
   * desktop, which is also what marks it read (D014, D156).
   */
  function openRequest(id: string): void {
    if (picking) {
      const item = requests.find((request) => request.id === id);

      if (item !== undefined && id !== selectedId) {
        choose(item);
      }

      return;
    }

    listScroll.current = window.scrollY;
    lastOpened.current = id;
    setKnownAtOpen(new Set(requests.map((item) => item.id)));
    void select(id);
  }

  async function remove(id: string): Promise<void> {
    setActionError(null);

    try {
      await api.deleteRequest(sessionId, id);
    } catch (error) {
      const classified = classifySessionError(error);

      if (classified !== 'error') {
        setStatus(classified);

        return;
      }

      // The request is still on the server, so it stays on screen. Removing it
      // here would show a deletion that did not happen, and the row would come
      // back on the next load.
      setActionError(() => (words: typeof m) => words.list.requestNotDeleted);

      return;
    }

    if (selectedId === id) {
      discardPendingDetails();
    }

    listLoads.invalidate();
    setRequests((current) => current.filter((item) => item.id !== id));
  }

  async function clear(): Promise<void> {
    setActionError(null);

    try {
      await api.clearRequests(sessionId);
    } catch (error) {
      const classified = classifySessionError(error);

      if (classified !== 'error') {
        setStatus(classified);

        return;
      }

      setActionError(() => (words: typeof m) => words.list.requestsNotDeleted);

      return;
    }

    discardPendingDetails();
    listLoads.invalidate();
    setRequests([]);
  }

  // The page's frame while the session loads, the footer band where it will be.
  if (status === 'loading') {
    return (
      <div className="flex min-h-full flex-col bg-canvas">
        <AppHeader />
        <div className="flex-1" />
        <AppFooter />
      </div>
    );
  }

  // `404` and `410` alike, on load or later while the page is open (D133).
  if (status === 'unavailable') {
    return <SessionNotFound sessionId={sessionId} onReopen={onReopen} />;
  }

  if (status === 'error' || !session) {
    return (
      <SessionUnavailable
        title={m.session.errorTitle}
        lines={m.session.errorLines}
        action={{
          label: m.queue.tryAgain,
          // A key only this tab holds - a link's, not yet checked, or one
          // storage refused - would not survive a reload: the page is opened
          // afresh instead (D259).
          onClick: () =>
            heldOnlyInThisTab(sessionId, storage) ? onReopen() : window.location.reload(),
        }}
      />
    );
  }

  /**
   * The key of a private session, which the card's lock, `Copy ▾` and
   * `Copy link` show and put in their links (D259): the one it opened with,
   * not the store's of the moment (`openedKey`, #264).
   */
  const accessKey = openedKey?.sessionId === sessionId ? openedKey.key : null;

  // The receive host's URL, from the API (D187); `Copy as cURL` sends to its origin.
  const receiveUrl = sessionReceiveUrl(session, window.location.origin);
  const curlOrigin = receiveOrigin(receiveUrl);
  const comparing = comparison?.phase === 'comparing' && selectedId !== null ? comparison : null;
  const openItem = requests.find((item) => item.id === selectedId) ?? details;
  /*
   * The chosen request is gone once the list no longer holds it - deleted
   * here or by another viewer, cleared, or pushed out by the 1000 limit
   * (D006) - or once the server says it has no such request (D4).
   */
  const chosenShown: ChosenDetails | null =
    comparing === null
      ? null
      : requests.some((item) => item.id === comparing.chosen.id)
        ? chosenDetails
        : { status: 'gone' };

  /*
   * Below 1024 px one of two screens (D157). The list: the endpoint card and
   * the requests, and the page scrolls. The open request: the Back bar and the
   * detail panel, full-bleed, with the endpoint card and the list hidden
   * rather than unmounted, so nothing they hold is lost. At 1024 px and up
   * none of the `max-lg:` classes apply and the page is the split layout.
   *
   * The footer band closes the page (D177). On the desktop it sits under the
   * panes; below 1024 px it follows the list at the end of the page, and the
   * open request, whose panel is the screen's one scroll, goes without it, as
   * it goes without the endpoint card.
   *
   * The header, the endpoint card, the panes and the band are 12 px apart at
   * every width, and so are the list and the detail panel on the desktop
   * (issue #96, direction B). Only the side padding differs, 28, 24 and 16 px,
   * as the header's and the band's do.
   */
  return (
    <div
      className={cn(
        'flex h-full flex-col bg-canvas',
        view === 'list' && 'max-lg:h-auto max-lg:min-h-full',
      )}
    >
      <AppHeader />
      <main
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-3 px-7 py-3',
          view === 'list' ? 'max-md:px-4 md:max-lg:px-6' : 'max-lg:gap-0 max-lg:p-0',
        )}
      >
        <EndpointCard
          sessionId={session.id}
          url={receiveUrl}
          accessKey={accessKey}
          state={session}
          rule={session}
          responseRevision={responseRevision}
          queueStartedSince={queueStartedSinceCall}
          onStateChange={takeOwnAnswer}
          onSessionUnavailable={() => setStatus('unavailable')}
          onToast={showToast}
          onDismissToast={dismissToast}
          className={view === 'detail' ? 'max-lg:hidden' : undefined}
        />

        {view === 'detail' ? (
          <BackBar
            className="lg:hidden"
            position={formatOpenPosition(filteredRequests, selectedId, m)}
            arrived={formatArrivedBadge(countArrivedSince(filteredRequests, knownAtOpen), m)}
            onBack={discardPendingDetails}
            buttonRef={backButton}
            actions={
              <RequestActionsSheet
                details={details}
                sessionId={sessionId}
                accessKey={accessKey}
                receiveOrigin={curlOrigin}
                onToast={showToast}
                onDismissToast={dismissToast}
                onCompare={startPicking}
                signature={signatureMemory}
              />
            }
          />
        ) : null}

        <div className="flex min-h-0 flex-1 gap-3">
          <RequestList
            requests={filteredRequests}
            total={requests.length}
            query={filterQuery}
            onQueryChange={changeFilter}
            search={{
              status: rawSearchState.status,
              reason: rawSearchState.reason,
              slow: rawSearchState.slow,
              onRetry: rawSearch.retry,
            }}
            selectedId={selectedId}
            openedIds={openedIds}
            keepsNoAddress={addressNotStored}
            error={actionError}
            onSelect={openRequest}
            onDelete={(id) => void remove(id)}
            onClear={() => void clear()}
            picking={
              picking && selectedId !== null
                ? {
                    openId: selectedId,
                    openMethod: openItem?.method ?? '',
                    onCancel: cancelComparisonPicking,
                  }
                : null
            }
            compared={
              comparing === null || selectedId === null
                ? null
                : { open: selectedId, chosen: comparing.chosen.id }
            }
            listRef={listSection}
            className={view === 'detail' ? 'max-lg:hidden' : undefined}
          />
          {/*
            Keyed by the selection, so that choosing another request starts it
            on Raw while a manual switch survives anything else that re-renders
            the page - an incoming request, or the response dialog opening and
            closing (D107). Without the key the reset would depend on the panel
            briefly having no details to show, which is a side effect of
            loading rather than a decision about the tab.
          */}
          <RequestDetail
            key={selectedId ?? 'empty'}
            details={details}
            sessionId={sessionId}
            accessKey={accessKey}
            receiveOrigin={curlOrigin}
            onToast={showToast}
            hasSelection={selectedId !== null}
            keepsNoAddress={addressNotStored}
            failed={detailFailed}
            onRetry={() => {
              if (selectedId !== null) {
                void select(selectedId);
              }
            }}
            onCompare={startPicking}
            signature={signatureMemory}
            comparison={
              comparing === null || chosenShown === null
                ? null
                : {
                    chosenItem: comparing.chosen,
                    chosen: chosenShown,
                    view: comparing.view,
                    onViewChange: showView,
                    onChange: startPicking,
                    onClose: endComparison,
                    onRetry: () => void loadChosen(comparing.chosen.id),
                  }
            }
            className={view === 'list' ? 'max-lg:hidden' : undefined}
          />
        </div>
      </main>
      <AppFooter className={view === 'detail' ? 'max-lg:hidden' : undefined} />
      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  );
}
