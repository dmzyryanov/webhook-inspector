/**
 * The session page's list filter (D180, D191): the query as typed, kept per
 * session in this browser and restored on reload; the server's search of the
 * raw requests for its words, which follows it; and the rows the filter
 * keeps. The page holds one, and its list draws the field, the count and what
 * the search says.
 *
 * The rules are the `lib` modules': `read-state.ts` keeps the query,
 * `raw-search.ts` decides when the server is asked, `request-filter.ts`
 * decides which rows stay. This holds their state for the page and runs their
 * effects: the query saved, the search told of it, the search stopped with
 * the page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RequestListItem } from '@webhook-inspector/shared';
import * as api from '../api/client.ts';
import type { Messages } from '../i18n/en.ts';
import {
  createRawSearch,
  RAW_SEARCH_OFF,
  type RawSearch,
  type RawSearchState,
} from '../lib/raw-search.ts';
import { loadFilter, saveFilter, type ReadStateStorage } from '../lib/read-state.ts';
import { filterRequests } from '../lib/request-filter.ts';
import { classifySessionError, type SessionPageStatus } from '../lib/session-lifetime.ts';

interface RequestFilterOptions {
  /** The page's session, fixed for the page: `App` keys the page by it (D080). */
  sessionId: string;
  /**
   * This browser's `localStorage`, or `null` where it is unavailable, in which
   * case the filter stays in this tab (D156).
   */
  storage: ReadStateStorage | null;
  /** Every request the list holds. */
  requests: RequestListItem[];
  /** Whether the session keeps no sender address, so its rows say `IP not stored` (D249). */
  keepsNoAddress: boolean;
  /** The words of the language shown, which a row is matched in (D222). */
  messages: Messages;
  /** The page's status, which a closed session answering the search takes over. */
  setStatus: (next: SessionPageStatus) => void;
}

export interface RequestFilter {
  /** The filter as typed: the field's value. */
  filterQuery: string;
  /** The field's change: what the viewer typed. */
  changeFilter: (query: string) => void;
  /** What the server's search found, and what the list pane says about it. */
  rawSearchState: RawSearchState;
  /**
   * The search itself, one for the page: the page tells it of arrivals and
   * reloads, and the list's Retry calls it.
   */
  rawSearch: RawSearch;
  /** The rows the filter keeps, in the list's order. */
  filteredRequests: RequestListItem[];
}

/** The list filter of one session's page: its query, its search of Raw and its rows. */
export function useRequestFilter({
  sessionId,
  storage,
  requests,
  keepsNoAddress,
  messages: m,
  setStatus,
}: RequestFilterOptions): RequestFilter {
  /**
   * The list filter as typed, kept per session in this browser and restored
   * on reload (D180). Other open tabs pick it up on their next reload.
   */
  const [filterQuery, setFilterQuery] = useState(() => loadFilter(storage, sessionId));
  /**
   * Whether the viewer has typed in the filter on this page. Until then the
   * filter is the one restored on reload, and it is searched at once rather
   * than after a pause in typing (D191).
   */
  const filterTyped = useRef(false);
  const changeFilter = useCallback((query: string): void => {
    filterTyped.current = true;
    setFilterQuery(query);
  }, []);
  /**
   * What the server's search of the raw requests found for the filter's
   * words, and what the list pane says about that search (D191).
   */
  const [rawSearchState, setRawSearchState] = useState<RawSearchState>(RAW_SEARCH_OFF);
  /**
   * Decides when the server is asked (`lib/raw-search.ts`). One per page, and
   * everything it is built from is fixed for the page: `App` keys the page by
   * its session (D080). A closed session answers the search as it answers any
   * session-scoped call, and takes the page over the same way.
   */
  const [rawSearch] = useState(() =>
    createRawSearch({
      search: async (words) => {
        try {
          return await api.searchRequests(sessionId, words);
        } catch (error) {
          const classified = classifySessionError(error);

          if (classified !== 'error') {
            setStatus(classified);
          }

          throw error;
        }
      },
      onChange: setRawSearchState,
    }),
  );
  /**
   * The rows the filter keeps: by their list fields, in the browser, or by
   * their raw request, as the server found (D191). The list, the Back bar's
   * position and its arrived badge count these; the tab title and Delete all
   * count every request (D078, D180).
   */
  const filteredRequests = useMemo(
    () =>
      filterRequests(requests, filterQuery, undefined, rawSearchState.matches, m, keepsNoAddress),
    [requests, filterQuery, rawSearchState.matches, m, keepsNoAddress],
  );

  /*
   * Kept on every change, and on the first render too, which marks a restored
   * filter used so it lives as long as the session's read state (D180).
   */
  useEffect(() => {
    saveFilter(storage, sessionId, filterQuery, Date.now());
  }, [storage, sessionId, filterQuery]);

  /*
   * The search of headers and bodies follows the filter (D191): by itself
   * after a pause in typing, and at once for the filter this page was loaded
   * with. Leaving the page stops its timers.
   */
  useEffect(() => {
    rawSearch.setQuery(filterQuery, { immediate: !filterTyped.current });
  }, [rawSearch, filterQuery]);

  useEffect(() => () => rawSearch.stop(), [rawSearch]);

  return { filterQuery, changeFilter, rawSearchState, rawSearch, filteredRequests };
}
