/**
 * When the server is asked to search the raw requests for the list filter's
 * words, and what the list pane says about it (issue #78, D191).
 *
 * The search starts by itself: 400 ms after typing stops, at once for a filter
 * restored on reload and for Retry, again 1 s after new requests arrive, and
 * again after the list reload that follows a reconnection (D077). One search
 * is in flight per tab: one wanted meanwhile runs when it has answered, and an
 * answer for words the query no longer holds is dropped. A search still
 * running after 300 ms shows a spinner; a faster one shows nothing.
 *
 * A plain object with no React in it, held by the page, with the search and
 * the timers handed in, so the rules can be tested on their own.
 */
import {
  ErrorCode,
  SEARCH_MAX_WORD_BYTES,
  SEARCH_MAX_WORDS,
  SEARCH_TIMEOUT_MS,
  type RequestSearchResult,
} from '@webhook-inspector/shared';
import { ApiError } from '../api/client.ts';
import { en, type Messages } from '../i18n/en.ts';
import {
  planRawSearch,
  sameRawSearchPlan,
  type RawMatches,
  type RawSearchPlan,
  type RawSearchRefusal,
} from './request-filter.ts';

/** How long after the last keystroke the search starts. */
export const TYPING_PAUSE_MS = 400;
/** How long a search runs before the spinner shows. */
export const SPINNER_DELAY_MS = 300;
/** How long after a request arrives the search runs again. */
export const ARRIVAL_DELAY_MS = 1000;

/** Why headers and bodies were not searched for the query on screen. */
export type NotSearchedReason = 'timeout' | 'busy' | 'failed' | RawSearchRefusal;

/*
 * The texts in English; the list pane draws the dictionary's `filter` (D222).
 */

/** The placeholder of the filter field: desktop and tablet, and a phone (A4.1, A4.7). */
export const FILTER_PLACEHOLDER = en.filter.placeholder;
export const FILTER_PLACEHOLDER_PHONE = en.filter.placeholderPhone;

/** The list's text while Raw is being searched and no list field matches (A4.2). */
export const SEARCHING_TEXT = en.filter.searching;
/** The line the empty result adds once Raw was searched (A4.5, A4.9). */
export const SEARCHED_TOO_TEXT = en.filter.searchedToo;
/** What every not-searched text opens with; the reason follows as a whole part. */
export const NOT_SEARCHED_LEAD = en.filter.notSearchedLead;

/** The reason, as the notice and the empty state finish the sentence (A4.3, A4.4). */
export function notSearchedReasonText(reason: NotSearchedReason, m: Messages = en): string {
  switch (reason) {
    case 'timeout':
      return m.filter.tookOver(SEARCH_TIMEOUT_MS / 1000);
    case 'busy':
      return m.filter.busy;
    case 'failed':
      return m.filter.failed;
    case 'word-too-long':
      return m.filter.wordTooLong(SEARCH_MAX_WORD_BYTES);
    case 'too-many-words':
      return m.filter.tooManyWords(SEARCH_MAX_WORDS);
  }
}

/**
 * Whether Retry is offered: for what another attempt can change. A word over
 * the limit or too many words are the query's own, checked before sending.
 */
export function canRetrySearch(reason: NotSearchedReason): boolean {
  return reason === 'timeout' || reason === 'busy' || reason === 'failed';
}

/**
 * Why a search that did not answer `200` was not made: the timeout and the
 * refusal have codes of their own, and anything else is `failed` - a network
 * failure, a `500`, and the `404` of a backend still on the image before this
 * route existed, during a rollout.
 */
export function classifySearchFailure(error: unknown): NotSearchedReason {
  if (error instanceof ApiError) {
    if (error.errorCode === ErrorCode.SEARCH_TIMED_OUT) {
      return 'timeout';
    }

    if (error.errorCode === ErrorCode.SEARCH_BUSY) {
      return 'busy';
    }
  }

  return 'failed';
}

/** What the page holds about the search of Raw. */
export interface RawSearchState {
  /** What the latest successful search found, for the words still in the query. */
  matches: RawMatches;
  /**
   * - `off`: the query has no word of 3 bytes or more; the filter is #70's.
   * - `pending`: what Raw holds for the query is still to come.
   * - `searched`: every searchable word of the query was searched.
   * - `not-searched`: it was not, and `reason` says why.
   */
  status: 'off' | 'pending' | 'searched' | 'not-searched';
  reason: NotSearchedReason | null;
  /** A search has been running for over 300 ms: the spinner. */
  slow: boolean;
}

const NO_MATCHES: RawMatches = new Map();

/** Before any query: nothing searched, nothing to say. */
export const RAW_SEARCH_OFF: RawSearchState = {
  matches: NO_MATCHES,
  status: 'off',
  reason: null,
  slow: false,
};

/** The timers the search runs on; the tests hand in their own. */
export interface SearchTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const browserTimers: SearchTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RawSearchOptions {
  /** Asks the server; rejects when it did not answer `200`. */
  search: (words: string[]) => Promise<RequestSearchResult>;
  /** Called with every new state. */
  onChange: (state: RawSearchState) => void;
  timers?: SearchTimers;
}

export interface RawSearch {
  /**
   * The filter text changed. Words that are searched the same as before
   * change nothing; otherwise the search runs after the typing pause, or at
   * once with `immediate`, which is for a filter restored on reload.
   */
  setQuery(query: string, options?: { immediate?: boolean }): void;
  /** A request arrived over realtime: search again in a second, once for a burst. */
  requestsArrived(): void;
  /** The list was reloaded after a reconnection (D077): search again now. */
  listReloaded(): void;
  /** Retry, from the notice or the empty state. */
  retry(): void;
  /**
   * The page is leaving: no timer is left running and nothing more is
   * reported. A later `setQuery` starts it again.
   */
  stop(): void;
}

/**
 * The per-word id sets of an answer, or `null` when the answer is not one list
 * of ids per word asked.
 */
function toMatches(words: readonly string[], result: RequestSearchResult): RawMatches | null {
  const lists: unknown = (result as { matches?: unknown } | null)?.matches;

  if (!Array.isArray(lists) || lists.length !== words.length) {
    return null;
  }

  const matches = new Map<string, ReadonlySet<string>>();

  for (const [index, word] of words.entries()) {
    const ids: unknown = lists[index];

    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      return null;
    }

    matches.set(word, new Set(ids as string[]));
  }

  return matches;
}

export function createRawSearch({
  search,
  onChange,
  timers = browserTimers,
}: RawSearchOptions): RawSearch {
  let plan: RawSearchPlan = { kind: 'none' };
  let state = RAW_SEARCH_OFF;
  let stopped = false;
  /** The words of the search in flight, or `null`. */
  let running: readonly string[] | null = null;
  /** A search was wanted while one was in flight: run when it has answered. */
  let again = false;
  /**
   * A request arrived, or the list was reloaded, and no search has started
   * since: the next one wanted must be a new search, even where one for the
   * same words is in flight. It outlives a change of the query, so an arrival
   * during a pause in typing is not lost when the query returns to the words
   * of the search in flight.
   */
  let unseen = false;
  let typingTimer: unknown = null;
  let arrivalTimer: unknown = null;
  let spinnerTimer: unknown = null;

  function report(next: Partial<RawSearchState>): void {
    state = { ...state, ...next };

    if (!stopped) {
      onChange(state);
    }
  }

  function cancel(handle: unknown): null {
    if (handle !== null) {
      timers.clear(handle);
    }

    return null;
  }

  function isCurrent(words: readonly string[]): boolean {
    return plan.kind === 'search' && sameRawSearchPlan(plan, { kind: 'search', words: [...words] });
  }

  /** The search in flight has answered, one way or the other. */
  function finished(): void {
    running = null;
    spinnerTimer = cancel(spinnerTimer);
  }

  /** Runs what was wanted while a search was in flight. */
  function runAgainIfWanted(): void {
    if (again) {
      again = false;
      run(true);
    }
  }

  function showSpinnerWhenSlow(): void {
    spinnerTimer = timers.set(() => {
      spinnerTimer = null;

      if (running !== null) {
        report({ slow: true });
      }
    }, SPINNER_DELAY_MS);
  }

  /**
   * Starts a search, or notes that one is wanted when the one in flight has
   * answered. `fresh` is for what may have changed the answer - an arrival, a
   * reload, Retry: then a search in flight does not do, even for the same
   * words. Without it a search in flight for the same words is the search.
   */
  function run(fresh: boolean): void {
    typingTimer = cancel(typingTimer);
    arrivalTimer = cancel(arrivalTimer);

    if (plan.kind !== 'search' || stopped) {
      return;
    }

    if (fresh) {
      unseen = true;
    }

    if (running !== null) {
      if (unseen || !isCurrent(running)) {
        again = true;
      } else if (spinnerTimer === null && !state.slow) {
        // Stopped and started again while it ran: its spinner is owed still.
        showSpinnerWhenSlow();
      }

      return;
    }

    const words = plan.words;

    running = words;
    // The search starting now sees every request there is.
    unseen = false;

    // A new attempt takes the notice away; its own answer puts one back.
    if (state.status === 'not-searched') {
      report({ status: 'pending', reason: null });
    }

    showSpinnerWhenSlow();

    search([...words]).then(
      (result) => {
        finished();

        const matches = isCurrent(words) ? toMatches(words, result) : null;

        if (!isCurrent(words)) {
          // Superseded: a newer query's search is wanted or on its way.
          report({ slow: false });
        } else if (matches === null) {
          again = false;
          report({ matches: NO_MATCHES, status: 'not-searched', reason: 'failed', slow: false });
        } else {
          report({ matches, status: 'searched', reason: null, slow: false });
        }

        runAgainIfWanted();
      },
      (error: unknown) => {
        finished();

        if (isCurrent(words)) {
          // What Raw held is no longer shown: under the notice the list is the
          // list-field matches alone. Nothing runs again by itself after a
          // failure; Retry, a new query and a reload do.
          again = false;
          report({
            matches: NO_MATCHES,
            status: 'not-searched',
            reason: classifySearchFailure(error),
            slow: false,
          });
        } else {
          report({ slow: false });
        }

        runAgainIfWanted();
      },
    );
  }

  return {
    setQuery(query, options = {}) {
      const next = planRawSearch(query);
      const resumed = stopped;

      stopped = false;

      if (!resumed && sameRawSearchPlan(plan, next)) {
        return;
      }

      plan = next;
      typingTimer = cancel(typingTimer);
      arrivalTimer = cancel(arrivalTimer);
      // `unseen` stays: what arrived is still to be searched for the new words.
      again = false;

      if (next.kind === 'none') {
        unseen = false;
        report({ matches: NO_MATCHES, status: 'off', reason: null });

        return;
      }

      if (next.kind === 'refused') {
        unseen = false;
        report({ matches: NO_MATCHES, status: 'not-searched', reason: next.reason });

        return;
      }

      // What is already known about a word still in the query stays on screen
      // until the new answer replaces it, so a row does not blink out while a
      // second word is typed.
      const kept = new Map<string, ReadonlySet<string>>();

      for (const word of next.words) {
        const ids = state.matches.get(word);

        if (ids !== undefined) {
          kept.set(word, ids);
        }
      }

      report({
        matches: kept,
        status: kept.size === next.words.length ? 'searched' : 'pending',
        reason: null,
      });

      if (options.immediate === true) {
        run(false);
      } else {
        typingTimer = timers.set(() => run(false), TYPING_PAUSE_MS);
      }
    },

    requestsArrived() {
      // After a failure nothing runs by itself: a session too large to search
      // in time would otherwise be searched again on every arrival.
      if (plan.kind !== 'search' || stopped || state.status === 'not-searched') {
        return;
      }

      // A search is about to start after typing, and it is told that it has
      // an arrival to see: where one for the same words is in flight, started
      // before the arrival, that one will not do.
      if (typingTimer !== null) {
        unseen = true;

        return;
      }

      // A burst makes one search, a second after its first request.
      if (arrivalTimer === null) {
        arrivalTimer = timers.set(() => run(true), ARRIVAL_DELAY_MS);
      }
    },

    listReloaded() {
      if (plan.kind !== 'search' || stopped) {
        return;
      }

      // As for an arrival: the search about to start after typing is told.
      if (typingTimer !== null) {
        unseen = true;

        return;
      }

      run(true);
    },

    retry() {
      if (plan.kind === 'search' && !stopped) {
        run(true);
      }
    },

    stop() {
      stopped = true;
      again = false;
      unseen = false;
      typingTimer = cancel(typingTimer);
      arrivalTimer = cancel(arrivalTimer);
      spinnerTimer = cancel(spinnerTimer);
    },
  };
}
