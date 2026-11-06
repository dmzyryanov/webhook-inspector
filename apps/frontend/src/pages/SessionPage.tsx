import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RequestListItem, SessionDetails } from '@webhook-inspector/shared';
import * as api from '../api/client.ts';
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
import { useFirstLoad, useSessionData } from '../hooks/useSessionData.ts';
import { useSessionSocket } from '../hooks/useSessionSocket.ts';
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
import { resolveRequestLinkUnlessMove, takeKeyUnlessMove } from '../lib/move-link.ts';
import { removesFragment, takeKeyFromAddress, type AddressBar } from '../lib/request-link.ts';
import { heldOnlyInThisTab, settleOpenedKey } from '../lib/access-keys.ts';
import { browserStorage } from '../lib/read-state.ts';
import { classifySessionError, keepsNoAddress } from '../lib/session-lifetime.ts';
import { receiveOrigin, sessionReceiveUrl } from '../lib/receive-url.ts';
import { recordSessionOpened } from '../lib/session-list.ts';
import { EMPTY_SIGNATURE_MEMORY, type SignatureMemory } from '../lib/signature.ts';

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
  /**
   * The page's status, the session with its response state, the request list
   * and the list loads in flight, and the session's reads (D133, D152): held
   * first, since every hook below reads the status, the list or their setters.
   */
  const {
    status,
    setStatus,
    session,
    requests,
    setRequests,
    listLoads,
    startSessionRead,
    dropSessionRead,
    takeSessionRead,
    reloadSession,
    takeResponseEvent,
    takeOwnAnswer,
    responseRevision,
    queueStartedSince,
  } = useSessionData({ sessionId });
  /** A failed deletion, said in the list in the language shown (D222). */
  const [actionError, setActionError] = useState<Phrase | null>(null);
  /**
   * This browser's `localStorage`, or `null` where it is unavailable - in which
   * case read state stays in this tab, as it did before #46 (D156).
   */
  const [storage] = useState(browserStorage);

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

  /**
   * The first load has answered (`useFirstLoad`): the page shows the session
   * and its list, keeps the key it opened with, lists the session on the home
   * page, and reads a request link once.
   */
  const showLoaded = useCallback(
    (loadedSession: SessionDetails, loadedRequests: RequestListItem[]): void => {
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
    },
    [sessionId, storage, setStatus, removeAddressFragment, openLinked, showToast],
  );

  /** The session and its list, read as the page opens, and the key it opened with (D133). */
  const { openedKey } = useFirstLoad({
    sessionId,
    storage,
    listLoads,
    setRequests,
    setStatus,
    startSessionRead,
    dropSessionRead,
    takeSessionRead,
    onLoaded: showLoaded,
  });

  /**
   * The socket: what it delivers reaches the list, the open request, the
   * search and the response state, and each connection reloads the list and
   * the session (D077, D133).
   */
  useSessionSocket({
    sessionId,
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
          accessKey={openedKey}
          state={session}
          rule={session}
          responseRevision={responseRevision}
          queueStartedSince={queueStartedSince}
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
                accessKey={openedKey}
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
            accessKey={openedKey}
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
