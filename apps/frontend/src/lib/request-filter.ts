/**
 * The request list's filter (issue #70, D180): one box matched against every
 * field of a row at once, in the browser, and, since #78, against the row's
 * raw request on the server (D191).
 *
 * The query is trimmed and split on whitespace, and every word must occur in
 * at least one field of the row, case-insensitively, or in its Raw. The fields
 * are the method, the status text the row shows, the sender address in full
 * and as the row shows it, the time as the row shows it, the full request id
 * and the path after `/s/<id>` as stored. Raw is the stored raw request - the
 * request line, the headers as `Name: value` and the body - which the list
 * does not carry (D037): the server searches it for the words of 3 bytes and
 * more, as exact bytes, and answers the ids (`planRawSearch`, `RawMatches`).
 * Body size is not matched. An empty query is no filter.
 *
 * Everything here is pure. `useRequestFilter` holds the query and what the
 * server found, `useSessionData` the full list, `lib/raw-search.ts` decides
 * when the server is asked, and `RequestList` draws the highlights
 * `rowHighlights` finds.
 */
import {
  REQUEST_ID_DISPLAY_LENGTH,
  SEARCH_MAX_WORD_BYTES,
  SEARCH_MAX_WORDS,
  SEARCH_MIN_WORD_BYTES,
  type RequestListItem,
} from '@webhook-inspector/shared';
import { en, type Messages } from '../i18n/en.ts';
import { formatListAddress } from './address.ts';
import { formatTimestamp } from './format.ts';
import { splitRequestTarget } from './request-summary.ts';
import { formatListStatus } from './response-summary.ts';

/**
 * Whether a query is no filter: empty or only whitespace. The field treats
 * such a query as empty - it closes on blur and on Escape, and its `×` closes
 * rather than clears - as the matcher and the stored filter do.
 */
export function isBlankQuery(query: string): boolean {
  return query.trim() === '';
}

/**
 * The words of a query, lower-cased, each once; none for a query that is only
 * spaces. A repeated word changes nothing a row matches or highlights, and a
 * pasted megabyte of one word would otherwise be matched against every row
 * once per repeat.
 */
export function queryWords(query: string): string[] {
  const trimmed = query.trim();

  return trimmed === '' ? [] : [...new Set(trimmed.toLowerCase().split(/\s+/))];
}

/**
 * The words of a query as typed, each once: the same split as `queryWords`,
 * in the letter case the viewer wrote. Raw is matched case-sensitively, so
 * this is the form the server is asked about and the form its answer is kept
 * under.
 */
export function typedWords(query: string): string[] {
  const trimmed = query.trim();

  return trimmed === '' ? [] : [...new Set(trimmed.split(/\s+/))];
}

/**
 * What the server's search of the raw requests found (D191): for each word it
 * searched, as typed, the ids of the requests whose Raw holds it. A word it
 * was not asked about has no entry, and then matches list fields only.
 */
export type RawMatches = ReadonlyMap<string, ReadonlySet<string>>;

/** Why a query's words are not sent to the server at all. */
export type RawSearchRefusal = 'word-too-long' | 'too-many-words';

/** What a query asks of the server's search of Raw. */
export type RawSearchPlan =
  /** No word of 3 bytes or more: nothing is sent, and the filter is #70's. */
  | { kind: 'none' }
  /** The words to search, as typed, each once, in the order typed. */
  | { kind: 'search'; words: string[] }
  /** Beyond a limit: nothing is sent, and the pane says why. */
  | { kind: 'refused'; reason: RawSearchRefusal };

const encoder = new TextEncoder();

/**
 * The length of a word in bytes of UTF-8, which is how the server measures
 * it. An unpaired surrogate counts as U+FFFD, three bytes, on both sides.
 */
export function utf8Length(word: string): number {
  return encoder.encode(word).length;
}

/**
 * The searchable-word rules (D191). Only words of 3 bytes or more are searched
 * in Raw; a shorter one matches list fields only. A repeated word is searched
 * once. More than 8 searchable words, or any word over 200 bytes, and Raw is
 * not searched for the query at all: the server would refuse it, so it is not
 * sent. The limits are the backend's, from the shared package.
 */
export function planRawSearch(query: string): RawSearchPlan {
  const words: string[] = [];

  for (const word of typedWords(query)) {
    // No encoding of a string is shorter than its length in UTF-16 units, so
    // a pasted megabyte is refused without being encoded.
    if (word.length > SEARCH_MAX_WORD_BYTES) {
      return { kind: 'refused', reason: 'word-too-long' };
    }

    const bytes = utf8Length(word);

    if (bytes > SEARCH_MAX_WORD_BYTES) {
      return { kind: 'refused', reason: 'word-too-long' };
    }

    // Collected only up to one past the limit, which is all the verdict
    // needs: the rest of a long query is still read for a word over the byte
    // limit, and never compared with more than nine others.
    if (
      bytes >= SEARCH_MIN_WORD_BYTES &&
      words.length <= SEARCH_MAX_WORDS &&
      !words.includes(word)
    ) {
      words.push(word);
    }
  }

  if (words.length === 0) {
    return { kind: 'none' };
  }

  if (words.length > SEARCH_MAX_WORDS) {
    return { kind: 'refused', reason: 'too-many-words' };
  }

  return { kind: 'search', words };
}

/** Whether two plans ask the server the same thing. */
export function sameRawSearchPlan(left: RawSearchPlan, right: RawSearchPlan): boolean {
  if (left.kind === 'search' && right.kind === 'search') {
    return (
      left.words.length === right.words.length &&
      left.words.every((word, index) => word === right.words[index])
    );
  }

  if (left.kind === 'refused' && right.kind === 'refused') {
    return left.reason === right.reason;
  }

  return left.kind === right.kind;
}

/** The parts of a row that show text a match can be highlighted in. */
export interface RowTexts {
  method: string;
  /** The first 7 characters of the id, as the row shows them. */
  shortId: string;
  status: string;
  /** The address as the row shows it: compacted, `IP unavailable` or `IP not stored`. */
  address: string;
  /** `2026-09-17 14:32:06`, in the viewer's timezone. */
  time: string;
}

/** Every text a row is matched against, lower-cased for the comparison. */
interface SearchTexts {
  shown: RowTexts;
  /** The shown texts, the full id, the full address and the path. */
  haystack: string[];
}

/**
 * The texts of a row, cached by the row object: the list holds at most 1000
 * rows (D006), each keystroke matches all of them, and formatting a time is
 * the costly part. A row changes by being replaced (`mergeRequests`,
 * `applyResponseRecorded`), so a cached entry never goes stale. Only the
 * viewer's own timezone is cached; tests pass one explicitly. One cache per
 * language, since the status and a missing address are words (D222): a row
 * is matched against what it shows in the language it is shown in.
 */
const caches = new WeakMap<Messages, WeakMap<RequestListItem, SearchTexts>>();
/** The same for a session that keeps no address, whose rows say `IP not stored` (D249). */
const notStoredCaches = new WeakMap<Messages, WeakMap<RequestListItem, SearchTexts>>();

function languageCache(
  m: Messages,
  keepsNoAddress: boolean,
): WeakMap<RequestListItem, SearchTexts> {
  const byLanguage = keepsNoAddress ? notStoredCaches : caches;
  let cache = byLanguage.get(m);

  if (cache === undefined) {
    cache = new WeakMap();
    byLanguage.set(m, cache);
  }

  return cache;
}

function searchTexts(
  item: RequestListItem,
  timeZone: string | undefined,
  m: Messages,
  keepsNoAddress: boolean,
): SearchTexts {
  const cache = languageCache(m, keepsNoAddress);
  const cached = timeZone === undefined ? cache.get(item) : undefined;

  if (cached !== undefined) {
    return cached;
  }

  const shown: RowTexts = {
    method: item.method,
    shortId: item.id.slice(0, REQUEST_ID_DISPLAY_LENGTH),
    status: formatListStatus(item.response, m),
    address: formatListAddress(item.sourceIp, m, keepsNoAddress),
    time: formatTimestamp(item.receivedAt, timeZone),
  };
  const haystack = [
    shown.method,
    shown.status,
    shown.address,
    shown.time,
    item.id,
    item.sourceIp ?? '',
    pathAfterSession(item),
  ].map((text) => text.toLowerCase());
  const texts = { shown, haystack };

  if (timeZone === undefined) {
    cache.set(item, texts);
  }

  return texts;
}

/**
 * The path after `/s/<id>` as `splitRequestTarget` cuts it, percent-encoding
 * as stored (D173). Empty for the endpoint itself and for a request stored
 * before paths were recorded (D110) - or listed by a backend that does not
 * send `path` yet, during a rollout - so such a row is never matched by it.
 */
export function pathAfterSession(item: Pick<RequestListItem, 'path'>): string {
  return splitRequestTarget({ path: item.path ?? null, queryString: '' })?.path ?? '';
}

/**
 * Whether the row matches every word of the query; any row matches none.
 *
 * `words` are the query's words as typed or lower-cased: a list field is
 * compared case-insensitively either way. `raw` is looked up by the word as
 * given, so only words as typed (`typedWords`) find what the server found. A
 * word matches when it is in a list field or in the row's Raw, each word on
 * its own: `POST 48213` keeps a POST whose body holds 48213 (D191).
 */
export function matchesRequest(
  item: RequestListItem,
  words: readonly string[],
  timeZone?: string,
  raw?: RawMatches,
  m: Messages = en,
  keepsNoAddress = false,
): boolean {
  return matchesWords(item, words, words.map(lowerCase), timeZone, raw, m, keepsNoAddress);
}

function lowerCase(word: string): string {
  return word.toLowerCase();
}

/** `matchesRequest` with the lower-cased words made once for the whole list. */
function matchesWords(
  item: RequestListItem,
  words: readonly string[],
  lowered: readonly string[],
  timeZone: string | undefined,
  raw: RawMatches | undefined,
  m: Messages,
  keepsNoAddress: boolean,
): boolean {
  if (words.length === 0) {
    return true;
  }

  const { haystack } = searchTexts(item, timeZone, m, keepsNoAddress);

  return words.every((word, index) => {
    const lower = lowered[index] as string;

    return haystack.some((text) => text.includes(lower)) || raw?.get(word)?.has(item.id) === true;
  });
}

/**
 * The rows the query keeps, in their order: those matching by their list
 * fields and those the server found by their Raw (`raw`). The same array comes
 * back for an empty query, so no filter costs nothing.
 */
export function filterRequests(
  items: RequestListItem[],
  query: string,
  timeZone?: string,
  raw?: RawMatches,
  m: Messages = en,
  keepsNoAddress = false,
): RequestListItem[] {
  const words = typedWords(query);

  if (words.length === 0) {
    return items;
  }

  const lowered = words.map(lowerCase);

  return items.filter((item) =>
    matchesWords(item, words, lowered, timeZone, raw, m, keepsNoAddress),
  );
}

/** `[start, end)` of highlighted characters in one shown text. */
export type HighlightRange = readonly [number, number];

/** The highlighted ranges of each shown text of a row, and the texts themselves. */
export interface RowHighlights {
  texts: RowTexts;
  ranges: Record<keyof RowTexts, HighlightRange[]>;
}

/**
 * Where the words of the query occur in the texts the row shows - method,
 * short id, status, address and time - merged where they touch or overlap.
 * A word that matched only something the row does not show (the path, the id
 * beyond its first 7 characters, the part of an address the row cut, the
 * row's Raw) has nothing to highlight.
 */
export function rowHighlights(
  item: RequestListItem,
  words: readonly string[],
  timeZone?: string,
  m: Messages = en,
  keepsNoAddress = false,
): RowHighlights {
  const texts = searchTexts(item, timeZone, m, keepsNoAddress).shown;

  return {
    texts,
    ranges: {
      method: findRanges(texts.method, words),
      shortId: findRanges(texts.shortId, words),
      status: findRanges(texts.status, words),
      address: findRanges(texts.address, words),
      time: findRanges(texts.time, words),
    },
  };
}

/** Every occurrence of every word in `text`, case-insensitively, merged. */
export function findRanges(text: string, words: readonly string[]): HighlightRange[] {
  const lower = text.toLowerCase();
  const found: [number, number][] = [];

  for (const word of words) {
    if (word === '') {
      continue;
    }

    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + 1)) {
      found.push([at, at + word.length]);
    }
  }

  found.sort((left, right) => left[0] - right[0]);

  const merged: [number, number][] = [];

  for (const range of found) {
    const last = merged.at(-1);

    if (last !== undefined && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([range[0], range[1]]);
    }
  }

  return merged;
}

/** A shown text cut into plain and highlighted pieces, for drawing. */
export function splitByRanges(
  text: string,
  ranges: readonly HighlightRange[],
): { text: string; match: boolean }[] {
  const pieces: { text: string; match: boolean }[] = [];
  let at = 0;

  for (const [start, end] of ranges) {
    if (start > at) {
      pieces.push({ text: text.slice(at, start), match: false });
    }

    pieces.push({ text: text.slice(start, end), match: true });
    at = end;
  }

  if (at < text.length) {
    pieces.push({ text: text.slice(at), match: false });
  }

  return pieces;
}

/**
 * The header's count while the filter has a value: `3 of 8 / 1000` on the
 * desktop and tablet, `3 of 8` on a phone, where the limit is dropped (2B, 2E).
 */
export function formatFilterCount(shown: number, total: number, m: Messages = en): string {
  return m.filter.count(shown, total);
}

/**
 * The sentence of the Delete all dialog. It names every request the session
 * holds, and, under a filter that hides some, how many of them (2J).
 */
export function formatDeleteAllDescription(
  total: number,
  hidden: number,
  m: Messages = en,
): string {
  return m.deleteAll.description(total, hidden);
}
