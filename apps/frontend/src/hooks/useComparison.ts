/**
 * `Compare with…` for the session page's open request (#75, D186): picking
 * another request in the list, or comparing with the one chosen, as its row
 * was when chosen; the chosen request's details, loaded with the existing
 * detail call and nothing else; and Escape, which leaves picking.
 *
 * The transitions are `lib/compare-state.ts`'s. This holds their state for
 * the page and loads the chosen request. The comparison belongs to the open
 * request, and anything that changes the selection ends it: the selection
 * (`useRequestSelection`) is handed `endComparison` for that, so the page
 * calls this hook before it. Whether the page is picking also needs the
 * selection, so the Escape that leaves picking is a hook of its own,
 * `useEscapeLeavesPicking`, which the page calls after both.
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
import { ErrorCode, type RequestListItem } from '@webhook-inspector/shared';
import * as api from '../api/client.ts';
import { ApiError } from '../api/client.ts';
import type { ChosenDetails } from '../components/CompareView.tsx';
import {
  cancelPicking,
  chooseRequest,
  startPicking as pickingFrom,
  withView,
  type ComparisonState,
} from '../lib/compare-state.ts';
import { addReadIds, recordRead, type ReadStateStorage } from '../lib/read-state.ts';
import type { CompareViewName } from '../lib/request-diff.ts';
import { classifySessionFailure, type SessionPageStatus } from '../lib/session-lifetime.ts';

/**
 * `Compare with…` for the open request (#75, D186): picking another request
 * in the list, or comparing with the one chosen, as its row was when chosen.
 * It belongs to the open request, and anything that changes the selection
 * ends it. The transitions are `lib/compare-state.ts`'s.
 */
export type Comparison = ComparisonState<RequestListItem>;

interface ComparisonOptions {
  /** The page's session, fixed for the page: `App` keys the page by it (D080). */
  sessionId: string;
  /**
   * This browser's `localStorage`, or `null` where it is unavailable, in which
   * case read state stays in this tab (D156).
   */
  storage: ReadStateStorage | null;
  /** The read set's setter (`useReadState`): a chosen row's content is read, so the row is too. */
  setOpenedIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  /**
   * The page's status, which a closed session answering the chosen request's
   * load takes over: the page's own setter, the same for the life of the page.
   */
  setStatus: (next: SessionPageStatus) => void;
  /**
   * Where the list was scrolled, noted as a row is chosen, so that below
   * 1024 px picking again puts the list back where it was left (D157).
   */
  listScroll: RefObject<number>;
}

export interface ComparisonPicking {
  /** Picking, comparing, or `null`: the open request alone. */
  comparison: Comparison | null;
  /** The chosen request's details as loaded: loading, loaded, gone or failed. */
  chosenDetails: ChosenDetails;
  /** `Compare with…`, `Change` and `Choose another`: picking for the open request. */
  startPicking: () => void;
  /** A row chosen while picking: the comparison with it, and its details' load. */
  choose: (item: RequestListItem) => void;
  /** Loads the chosen request's details again: the comparison's `Retry`. */
  loadChosen: (id: string) => Promise<void>;
  /** The user picked a view of the comparison on screen. */
  showView: (view: CompareViewName) => void;
  /** `Cancel`, Escape and Back while picking: nothing changed. */
  cancelComparisonPicking: () => void;
  /** `Close ×`, and any change of the selection: the open request as it was. */
  endComparison: () => void;
}

/** The open request's comparison with another, and the chosen request's details. */
export function useComparison({
  sessionId,
  storage,
  setOpenedIds,
  setStatus,
  listScroll,
}: ComparisonOptions): ComparisonPicking {
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [chosenDetails, setChosenDetails] = useState<ChosenDetails>({ status: 'loading' });
  /** Identifies the chosen request's load whose answer is still wanted. */
  const latestChosenRequest = useRef(0);

  /**
   * Loads the request chosen to compare with (D186), with the existing detail
   * call and nothing else. Only the answer to the latest choice is applied. A
   * request the server no longer has is gone (D4); a closed session takes the
   * page over, as any other session-scoped call does.
   */
  const loadChosen = useCallback(
    async (id: string): Promise<void> => {
      const token = (latestChosenRequest.current += 1);

      setChosenDetails({ status: 'loading' });

      try {
        const loaded = await api.getRequestDetails(sessionId, id);

        if (latestChosenRequest.current === token) {
          setChosenDetails({ status: 'loaded', details: loaded });
        }
      } catch (error) {
        if (latestChosenRequest.current !== token) {
          return;
        }

        if (error instanceof ApiError && error.errorCode === ErrorCode.REQUEST_NOT_FOUND) {
          setChosenDetails({ status: 'gone' });

          return;
        }

        setStatus(classifySessionFailure(error, () => setChosenDetails({ status: 'failed' })));
      }
    },
    [sessionId, setStatus],
  );

  /**
   * A row chosen while picking: the comparison is shown, and below 1024 px it
   * is the detail screen again. Its content is read, so the row is too
   * (D014, D156).
   */
  const choose = useCallback(
    (item: RequestListItem): void => {
      listScroll.current = window.scrollY;
      setOpenedIds((current) => addReadIds(current, [item.id]));
      recordRead(storage, sessionId, item.id, Date.now());
      setComparison(chooseRequest(item));
      void loadChosen(item.id);
    },
    [sessionId, storage, setOpenedIds, listScroll, loadChosen],
  );

  /**
   * `Compare with…`, `Change` and `Choose another`: picking for the open
   * request. A comparison it starts from is kept, its chosen request's details
   * and any load of them included, so that leaving picking can put it back.
   * Below 1024 px picking is the list screen, put back where it was left
   * (`listScroll`, noted when the request or the last choice was made).
   */
  const startPicking = useCallback((): void => {
    setComparison(pickingFrom);
  }, []);

  const showView = useCallback((view: CompareViewName): void => {
    setComparison((current) => withView(current, view));
  }, []);

  /**
   * `Cancel`, Escape and Back while picking: nothing changed - the comparison
   * `Change` started from, on its view, or the open request (D186).
   */
  const cancelComparisonPicking = useCallback((): void => {
    setComparison(cancelPicking);
  }, []);

  /**
   * `Close ×`: the open request as it was. Opening another request, or
   * closing the open one, ends a comparison the same way (D186), the chosen
   * request's load in flight dropped with it.
   */
  const endComparison = useCallback((): void => {
    latestChosenRequest.current += 1;
    setComparison(null);
  }, []);

  return {
    comparison,
    chosenDetails,
    startPicking,
    choose,
    loadChosen,
    showView,
    cancelComparisonPicking,
    endComparison,
  };
}

/**
 * Escape anywhere leaves picking with nothing changed, unless something on
 * the page - a dialog, the filter field - has used it already. `picking` is
 * the page's: picking for a request that is open.
 */
export function useEscapeLeavesPicking(
  picking: boolean,
  cancelComparisonPicking: () => void,
): void {
  useEffect(() => {
    if (!picking) {
      return;
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        cancelComparisonPicking();
      }
    }

    document.addEventListener('keydown', onKeyDown);

    return () => document.removeEventListener('keydown', onKeyDown);
  }, [picking, cancelComparisonPicking]);
}
