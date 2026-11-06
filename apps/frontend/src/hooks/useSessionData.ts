/**
 * What the session page has loaded and shows (D133, D136, D152, D205, D259):
 * the page's status, which stays on `Session not found` once it is there; the
 * session, with the response state its card shows; the request list and the
 * list loads in flight; the session's reads - the first load's, one on every
 * connection of the socket and one every 10 minutes while the page shows the
 * session - with the socket's response events and the answers to this
 * viewer's own changes, put together so that none undoes another; and the
 * first load itself, with the key the session opened with.
 *
 * The rules are the `lib` modules': `session-lifetime.ts` chooses the status
 * and says what a read's failure does, `session-response.ts` how a read, an
 * event and an answer are put together, `requests.ts` what a list load keeps.
 * This holds their state for the page. Every other hook of the page reads its
 * status, its list or their setters, so the page calls `useSessionData` first.
 * The loads whose answers reach those other hooks are called after them: the
 * first load, `useFirstLoad` below, once the selection and the push flow are
 * held, whose callbacks the page's `onLoaded` calls, as `useEscapeLeavesPicking`
 * is called after the hooks it needs; the list's reload on every connection,
 * in `useSessionSocket`, beside the events that reach the same hooks.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type {
  RequestListItem,
  SessionDetails,
  SessionResponseState,
} from '@webhook-inspector/shared';
import * as api from '../api/client.ts';
import { accessKeyFor } from '../lib/access-keys.ts';
import { pruneReadState, type ReadStateStorage } from '../lib/read-state.ts';
import { createListLoads, mergeRequests, type ListLoads } from '../lib/requests.ts';
import {
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

interface SessionDataOptions {
  /** The page's session, fixed for the page: `App` keys the page by it (D080). */
  sessionId: string;
}

export interface SessionData {
  /** The page's status: its states and the rule that chooses them live in `session-lifetime`. */
  status: SessionPageStatus;
  /**
   * Changes the page's status through `settlePageStatus`, which keeps a page
   * on `Session not found` once it is there (D133, D198). The same function
   * for the life of the page.
   */
  setStatus: (next: SessionPageStatus) => void;
  /** The session as the page shows it, or `null` until the first load has answered. */
  session: SessionDetails | null;
  /** Every request the list holds. */
  requests: RequestListItem[];
  /** The list's own state setter, the same function for the life of the page. */
  setRequests: Dispatch<SetStateAction<RequestListItem[]>>;
  /**
   * The list loads in flight: whether a deletion has discarded them since they
   * began (D136), and what `request.received` delivered meanwhile (#39).
   */
  listLoads: ListLoads;
  /** Begins a session read, whose order `takeSessionRead` or `dropSessionRead` hands back. */
  startSessionRead: () => number;
  /** Ends a session read whose answer will not be used: it failed, or the page left. */
  dropSessionRead: (order: number) => void;
  /** Applies a session read's answer, with the events taken while it was in flight on top. */
  takeSessionRead: (read: SessionDetails, order: number) => void;
  /** Reads the session again: on every connection, and every 10 minutes (D133, D249). */
  reloadSession: () => Promise<void>;
  /** Applies what the socket says about the response state (D152, D205). */
  takeResponseEvent: (event: ResponseEvent) => void;
  /** Takes the answer to this viewer's own change, and answers the state its toast describes. */
  takeOwnAnswer: (state: SessionResponseState, startedAt: number) => SessionResponseState;
  /** Where the page's revision stands, read by a surface as its call starts. */
  responseRevision: () => number;
  /** Whether the queue was started from step 1 since a call started (D205). */
  queueStartedSince: (startedAt: number) => boolean;
}

/** The session page's status, session and request list, and the session's reads. */
export function useSessionData({ sessionId }: SessionDataOptions): SessionData {
  const [status, setSettledStatus] = useState<SessionPageStatus>('loading');
  /**
   * Every change of the page's status goes through `settlePageStatus`, which
   * keeps a page on `Session not found` once it is there (D133, D198): the
   * load on mount, a reload or an action answering later cannot put a deleted
   * or expired session back on screen. Showing that screen does not unmount
   * the page, so whatever is in flight still resolves here.
   */
  const setStatus = useCallback((next: SessionPageStatus): void => {
    setSettledStatus((current) => settlePageStatus(current, next));
  }, []);
  const [session, setSession] = useState<SessionDetails | null>(null);
  const [requests, setRequests] = useState<RequestListItem[]>([]);
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

  const responseRevision = useCallback((): number => responseState.current.revision, []);

  const queueStartedSinceCall = useCallback(
    (startedAt: number): boolean => queueStartedSince(responseState.current, startedAt),
    [],
  );

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

  return {
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
    queueStartedSince: queueStartedSinceCall,
  };
}

interface FirstLoadOptions {
  /** The page's session, fixed for the page: `App` keys the page by it (D080). */
  sessionId: string;
  /**
   * This browser's `localStorage`, or `null` where it is unavailable: the key
   * the session is read with, and the read state the loaded list prunes (D156).
   */
  storage: ReadStateStorage | null;
  /** `useSessionData`'s list loads, which the first load is one of. */
  listLoads: ListLoads;
  /** `useSessionData`'s list setter. */
  setRequests: Dispatch<SetStateAction<RequestListItem[]>>;
  /** `useSessionData`'s status setter, which a load that failed sets. */
  setStatus: (next: SessionPageStatus) => void;
  /** `useSessionData`'s session reads, which the first load is one of. */
  startSessionRead: () => number;
  dropSessionRead: (order: number) => void;
  takeSessionRead: (read: SessionDetails, order: number) => void;
  /**
   * What the page does once the session and its list are on it: shows them,
   * lists the session and reads a request link (D182, D199, D259). Called once
   * the load has answered, with the session and the list as the load returned
   * it. Like every option, the same for the life of the page: the load is
   * started again whenever one of them changes.
   */
  onLoaded: (loadedSession: SessionDetails, loadedRequests: RequestListItem[]) => void;
}

export interface FirstLoad {
  /**
   * The key of a private session, which the card's lock, `Copy ▾` and
   * `Copy link` show and put in their links (D259): the one it opened with,
   * not the store's of the moment (#264); `null` for a public session, and
   * until the first load has answered.
   */
  openedKey: string | null;
}

/**
 * The page's first load (D133): the session and its list read together as
 * the page opens, each applied with what the socket brought meanwhile on top,
 * the key the session opened with kept, and the answer handed to the page's
 * `onLoaded`. A load that fails sets the page's status (`settleLoadFailure`);
 * one whose page has gone applies nothing.
 */
export function useFirstLoad({
  sessionId,
  storage,
  listLoads,
  setRequests,
  setStatus,
  startSessionRead,
  dropSessionRead,
  takeSessionRead,
  onLoaded,
}: FirstLoadOptions): FirstLoad {
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
        onLoaded(loadedSession, loadedRequests);
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
    setRequests,
    setStatus,
    startSessionRead,
    dropSessionRead,
    takeSessionRead,
    onLoaded,
  ]);

  return { openedKey: openedKey?.sessionId === sessionId ? openedKey.key : null };
}
