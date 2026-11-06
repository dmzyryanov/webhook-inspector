/**
 * The session page's realtime delivery (D076, D077, D110, D136, D152): the
 * socket watching the session, opened as the page opens and closed with it,
 * and what each of its events does on the page - a captured request inserted,
 * a recorded response written onto its row and its open panel, a deletion or
 * a clear applied, the session's response replaced, a refusal taking the page
 * to `Session not found` - and, on every connection, the list loaded again,
 * which is what makes a reconnection pick up what was captured while it was
 * down, with the session read again beside it.
 *
 * The socket is `api/realtime.ts`'s, which retries a lost connection and
 * routes each frame; what an event does to the list is `lib/requests.ts`'s,
 * and to the response state `useSessionData`'s. This installs the handlers
 * and carries them out. Every event reaches the open request and the list's
 * search, so the page calls this after `useRequestSelection` and
 * `useRequestFilter`, and after `useFirstLoad`, as it opened the socket after
 * its first load began.
 */
import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { RequestListItem } from '@webhook-inspector/shared';
import * as api from '../api/client.ts';
import { openSessionSocket } from '../api/realtime.ts';
import { accessKeyFor } from '../lib/access-keys.ts';
import type { RawSearch } from '../lib/raw-search.ts';
import { pruneReadState, type ReadStateStorage } from '../lib/read-state.ts';
import {
  applyRequestDeleted,
  applyResponseRecorded,
  deletionClosesDetails,
  mergeRequests,
  reloadClosesDetails,
  replaceWithReloaded,
  shouldRefreshDetails,
  shouldRefreshDetailsOnReady,
  type ListLoads,
} from '../lib/requests.ts';
import { classifySessionError, type SessionPageStatus } from '../lib/session-lifetime.ts';
import type { ResponseEvent } from '../lib/session-response.ts';

interface SessionSocketOptions {
  /** The page's session, fixed for the page: `App` keys the page by it (D080). */
  sessionId: string;
  /**
   * This browser's `localStorage`, or `null` where it is unavailable: the key
   * the socket presents, and the read state a reloaded list prunes (D156).
   */
  storage: ReadStateStorage | null;
  /** `useSessionData`'s list loads, which every event that changes the list reaches. */
  listLoads: ListLoads;
  /** `useSessionData`'s list setter. */
  setRequests: Dispatch<SetStateAction<RequestListItem[]>>;
  /** `useSessionData`'s status setter: a refused connection or reload takes the page over. */
  setStatus: (next: SessionPageStatus) => void;
  /** `useSessionData`'s session read, run on every connection (D133). */
  reloadSession: () => Promise<void>;
  /** `useSessionData`'s response state, which a step, a clear and `session.updated` move (D205). */
  takeResponseEvent: (event: ResponseEvent) => void;
  /** `useRequestSelection`'s open request, read as an event arrives. */
  selectedIdRef: Readonly<RefObject<string | null>>;
  /** `useRequestSelection`'s refresh of the open request (D125). */
  refreshDetails: (id: string) => Promise<void>;
  /** `useRequestSelection`'s close of the open request (D137). */
  discardPendingDetails: () => void;
  /** `useRequestFilter`'s search of headers and bodies, told of every arrival and reload (D191). */
  rawSearch: RawSearch;
}

/**
 * The session page's socket and its handlers. Every option is the same for
 * the life of the page, so the socket is opened once; one that changed would
 * close it and open another.
 */
export function useSessionSocket({
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
}: SessionSocketOptions): void {
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
  }, [
    sessionId,
    storage,
    listLoads,
    selectedIdRef,
    discardPendingDetails,
    setRequests,
    rawSearch,
    setStatus,
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
         * The same state change the page's `remove()` applies after its own
         * `204`, and just as idempotent: the acting viewer has already dropped
         * the row, so its own event changes nothing. A panel showing the
         * deleted request returns to the empty state with no notice (D137). The
         * list generation moves for the same reason it does in `remove()`: a
         * reload already in flight must not put the row back.
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
         * after one set aside, it is what brings the change to the page.
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
    selectedIdRef,
    refreshDetails,
    discardPendingDetails,
    takeResponseEvent,
    listLoads,
    setRequests,
    rawSearch,
    setStatus,
  ]);
}
