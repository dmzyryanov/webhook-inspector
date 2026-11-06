/**
 * The session page's open request (D014, D137, D182): which request is
 * selected, its details as the panel shows them, whether their load failed,
 * and the ways a request is opened, refreshed and closed - a click, a request
 * link read after the first list load, a recorded response or a `ready`, a
 * deletion or a clear.
 *
 * The decisions are the `lib` modules': `requests.ts` decides when a refresh
 * is applied and which reading of a response the panel keeps, `request-link.ts`
 * what follows a linked opening. This holds the selection's state for the
 * page and carries them out. Opening a request marks it read (D014, D156),
 * and opening or closing one ends the open request's comparison, through
 * `useComparison`'s `endComparison` (D186): the page calls that hook before
 * this one.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { ErrorCode, type RequestDetails, type RequestListItem } from '@webhook-inspector/shared';
import * as api from '../api/client.ts';
import { ApiError } from '../api/client.ts';
import type { ToastIcon } from '../components/Toast.tsx';
import type { Phrase } from '../i18n/en.ts';
import { addReadIds, recordRead, type ReadStateStorage } from '../lib/read-state.ts';
import { afterLinkedOpening, type OpeningOutcome } from '../lib/request-link.ts';
import { detailToShow, loadRefreshedDetails } from '../lib/requests.ts';
import { classifySessionFailure, type SessionPageStatus } from '../lib/session-lifetime.ts';
import { DESKTOP_QUERY } from './useDesktopLayout.ts';

/**
 * The toast a link to a request the session no longer holds shows (D182):
 * here when its opening finds it gone, and on the page when the first list
 * load does not hold it.
 */
export const staleLink: Phrase = (m) => m.staleLink;

interface RequestSelectionOptions {
  /** The page's session, fixed for the page: `App` keys the page by it (D080). */
  sessionId: string;
  /**
   * This browser's `localStorage`, or `null` where it is unavailable, in which
   * case read state stays in this tab (D156).
   */
  storage: ReadStateStorage | null;
  /** The read set's setter (`useReadState`): opening a request is what makes it read (D014). */
  setOpenedIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  /** The list's setter: a request the server no longer has leaves the list. */
  setRequests: Dispatch<SetStateAction<RequestListItem[]>>;
  /**
   * The page's status, which a closed session answering a request's load
   * takes over: the page's own setter, the same for the life of the page.
   */
  setStatus: (next: SessionPageStatus) => void;
  /** Ends the open request's comparison, as anything that changes the selection does (D186). */
  endComparison: () => void;
  /** The page's one toast, which says a linked request is gone (D182). */
  showToast: (text: Phrase, icon?: ToastIcon) => void;
  /** Where the list was scrolled when a request covered it in the push flow (D157). */
  listScroll: RefObject<number>;
  /** The request opened last, whose row takes focus back when it closes. */
  lastOpened: RefObject<string | null>;
  /** Notes the ids the list held when a request was opened, which the Back bar counts from. */
  setKnownAtOpen: Dispatch<SetStateAction<ReadonlySet<string>>>;
  /** The list's section, whose row a linked request's opening scrolls into view on the desktop. */
  listSection: RefObject<HTMLElement | null>;
}

export interface RequestSelection {
  /** The open request's id, or `null`: nothing open. */
  selectedId: string | null;
  /**
   * The open request's id, readable from the socket's callbacks, which are
   * installed once per connection; written ahead of its state by `select`.
   */
  selectedIdRef: Readonly<RefObject<string | null>>;
  /** The open request's details, or `null` while they load or once it closes. */
  details: RequestDetails | null;
  /** Whether loading the open request's details failed, for a reason other than the session's. */
  detailFailed: boolean;
  /** Closes the open request and drops any detail answer still in flight (D137). */
  discardPendingDetails: () => void;
  /** Loads the open request again after its response was recorded, or on a `ready` (D125). */
  refreshDetails: (id: string) => Promise<void>;
  /** Opens a request: selected, marked read, its details loaded. */
  select: (id: string) => Promise<OpeningOutcome>;
  /** Opens the request a link names, once the first list load has put the session on screen. */
  openLinked: (id: string, listed: readonly RequestListItem[]) => Promise<void>;
}

/** The request open on the session page, and its details. */
export function useRequestSelection({
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
}: RequestSelectionOptions): RequestSelection {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<RequestDetails | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  /** Identifies the detail request whose answer is still wanted. */
  const latestDetailRequest = useRef(0);
  /**
   * The selected request, readable from the page's socket callback. That
   * callback is installed once per connection, and its dependencies are the
   * session and the reload - re-installing it on every selection would drop and
   * re-open the WebSocket each time a row is clicked, which is a heavy way to
   * learn one string.
   */
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  /**
   * Drops any detail answer still in flight, so it cannot repopulate the panel,
   * and returns the panel to its empty state.
   *
   * A stable callback rather than a plain function because the page's socket
   * handlers call it too, for a deletion made by another viewer (D137), and so
   * does the reload that finds the open request missed a deletion. It touches
   * only refs, state setters and `endComparison`, all of them the same for the
   * life of the page.
   */
  const discardPendingDetails = useCallback((): void => {
    latestDetailRequest.current += 1;
    selectedIdRef.current = null;
    setSelectedId(null);
    setDetails(null);
    setDetailFailed(false);
    endComparison();
  }, [endComparison]);

  /**
   * Reloads the open panel's request after its response was recorded, or on a
   * `ready` while it is open (D125, #204).
   *
   * The decisions live in `loadRefreshedDetails`, which answers with the detail
   * to show or with `null`, and `detailToShow`, which keeps the panel from
   * going back to an earlier reading of its response; this is the caller that
   * owns the state. Unlike `select()`, it **never clears `details` and never sets the
   * failure state**: the panel is already holding valid data, and replacing a
   * good panel with a loading or an error state because a refresh did not come
   * back would be worse than leaving the response it was opened with on screen.
   *
   * Setting `details` re-renders the panel without remounting it: the component
   * is keyed by the selection, which has not changed, so the tabs the viewer
   * chose stay where they are (D107).
   */
  const refreshDetails = useCallback(
    async (id: string): Promise<void> => {
      const loaded = await loadRefreshedDetails({
        id,
        token: latestDetailRequest.current,
        load: (requestId) => api.getRequestDetails(sessionId, requestId),
        currentState: () => ({
          selectedId: selectedIdRef.current,
          token: latestDetailRequest.current,
        }),
      });

      if (loaded !== null) {
        setDetails((current) => detailToShow(current, loaded));
      }
    },
    [sessionId],
  );

  /**
   * Selecting quickly can outrun the network: answers may arrive in a different
   * order than the clicks. Only the answer to the most recent selection is
   * applied, so the panel always describes the highlighted row.
   */
  const select = useCallback(
    async (id: string): Promise<OpeningOutcome> => {
      const token = (latestDetailRequest.current += 1);

      // Opening is what makes a request read (D014), in every tab of this
      // browser showing the session (D156).
      setOpenedIds((current) => addReadIds(current, [id]));
      recordRead(storage, sessionId, id, Date.now());
      // Written ahead of the effect that mirrors it, so a deletion event landing
      // before this render commits still sees the row as the open one (D137).
      selectedIdRef.current = id;
      setSelectedId(id);
      setDetails(null);
      setDetailFailed(false);
      // Another request opened normally ends a comparison (D186).
      endComparison();

      try {
        const loaded = await api.getRequestDetails(sessionId, id);

        if (latestDetailRequest.current !== token) {
          return 'superseded';
        }

        // A refresh sharing this token may have answered first with the
        // recorded response; an answer still reading pending, or unknown for
        // an overdue record, does not undo it (#204).
        setDetails((current) => detailToShow(current, loaded));

        return 'shown';
      } catch (error) {
        if (latestDetailRequest.current !== token) {
          return 'superseded';
        }

        if (error instanceof ApiError && error.errorCode === ErrorCode.REQUEST_NOT_FOUND) {
          setRequests((current) => current.filter((item) => item.id !== id));
          setSelectedId(null);
          setDetailFailed(false);

          return 'not-found';
        }

        setStatus(classifySessionFailure(error, () => setDetailFailed(true)));

        return 'failed';
      }
    },
    [sessionId, storage, setOpenedIds, setRequests, setStatus, endComparison],
  );

  /**
   * Opens the request a link names, once the first list load has put the
   * session on screen (D182): exactly as a click on its row does - noted for
   * the push flow, selected, marked read (D014, D156) - with the list the load
   * returned as what the list held at the opening. Below 1024 px that is the
   * push flow's opening, with its history entry; on the desktop there is none.
   *
   * What follows is `afterLinkedOpening`: a request the server no longer has
   * closes again, as any selection of one does, and the toast says it is gone;
   * one whose details are on screen has its row scrolled into the list's view
   * on the desktop. The layout is read when the details arrive, not when the
   * link was read, and a request the viewer left before then moves nothing.
   */
  const openLinked = useCallback(
    async (id: string, listed: readonly RequestListItem[]): Promise<void> => {
      listScroll.current = window.scrollY;
      lastOpened.current = id;
      setKnownAtOpen(new Set(listed.map((item) => item.id)));

      const outcome = await select(id);
      const layoutNow = window.matchMedia(DESKTOP_QUERY).matches ? 'split' : 'push';
      const next = afterLinkedOpening(outcome, layoutNow);

      if (next === 'stale-toast') {
        showToast(staleLink, 'info');
      } else if (next === 'reveal-row') {
        listSection.current
          ?.querySelector<HTMLElement>(`[data-request-id="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      }
    },
    [select, showToast, listScroll, lastOpened, setKnownAtOpen, listSection],
  );

  return {
    selectedId,
    selectedIdRef,
    details,
    detailFailed,
    discardPendingDetails,
    refreshDetails,
    select,
    openLinked,
  };
}
