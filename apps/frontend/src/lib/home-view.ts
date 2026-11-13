/**
 * What the home page shows (issue #92, D199): which of its two states, and
 * the list of the sessions used in this browser as the returning visitor's
 * page draws it - its rows, its days, the cut after five and the words around
 * them. Pure, so it is unit-tested; `LandingPage` draws what this decides
 * (D025, D061).
 *
 * The states (rows of the Figma page `Webhook Inspector · My sessions`,
 * `604:11`, approved 2026-10-03):
 *
 * - **First visit (F)** while the list is empty, storage unavailable
 *   included, and once the status read has dropped every session in it.
 * - **Returning visitor (G3′)** as soon as the list holds a session: drawn at
 *   once, with `Loading sessions…` in place of the rows until the status read
 *   answers, so the page never shows F first and then switches.
 */
import { REQUEST_ID_DISPLAY_LENGTH, type SessionStatus } from '@webhook-inspector/shared';
import { en, type Messages } from '../i18n/en.ts';
import { isTimeValue, type ListedSession } from './session-list.ts';

/** How many sessions show before `Show all`. */
export const SESSIONS_SHOWN_FIRST = 5;

/*
 * Every text below takes the interface's words, `m`, English by default
 * (D222); the constants are the English ones.
 */

export const LOADING_SESSIONS = en.home.loading;

export const SESSION_DETAILS_FAILED = en.home.detailsFailed;

/** An active session as the status read describes it. */
export type ActiveSession = Extract<SessionStatus, { state: 'active' }>;

/** Where the status read of the listed sessions stands. */
export type StatusRead =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'loaded'; sessions: ReadonlyMap<string, ActiveSession> };

export type HomeState = 'first-visit' | 'returning';

/**
 * F while nothing is listed, and once the status read has answered without
 * describing any listed session as active; G3′ otherwise, while the read is
 * pending and when it failed included.
 */
export function homeState(list: readonly ListedSession[], read: StatusRead): HomeState {
  if (list.length === 0) {
    return 'first-visit';
  }

  if (read.state === 'loaded' && !list.some((entry) => read.sessions.has(entry.id))) {
    return 'first-visit';
  }

  return 'returning';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One entry of the status read's answer as the contract describes it, for the
 * id sent in its place, or `null`. A fresh object of the documented fields, so
 * nothing else the answer carried reaches the page.
 */
function parseSessionStatus(entry: unknown, id: string): SessionStatus | null {
  if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id !== id) {
    return null;
  }

  switch (entry.state) {
    case 'expired':
    case 'not_found':
      return { id, state: entry.state };
    case 'active': {
      const { receiveUrl, requestsCount, lastRequestAt, lastUsedAt } = entry;

      if (
        typeof receiveUrl !== 'string' ||
        !Number.isSafeInteger(requestsCount) ||
        (requestsCount as number) < 0 ||
        (lastRequestAt !== null && typeof lastRequestAt !== 'string') ||
        typeof lastUsedAt !== 'string'
      ) {
        return null;
      }

      return {
        id,
        state: 'active',
        receiveUrl,
        requestsCount: requestsCount as number,
        lastRequestAt,
        lastUsedAt,
      };
    }
    default:
      return null;
  }
}

/**
 * The status read's answer, checked against its documented contract (D199,
 * `POST /api/sessions/status`), or `null` for an answer that does not match
 * it, which the page handles exactly as a read that failed: the rows by the
 * day each was last opened here, no counts, and nothing taken off the stored
 * list.
 *
 * The contract: an object whose `sessions` is an array with one entry per id
 * sent, in the order sent, each an object with that `id` and a `state` of
 * `active`, `expired` or `not_found`; an `active` entry with a string
 * `receiveUrl`, a non-negative safe integer `requestsCount`, a string or
 * `null` `lastRequestAt` and a string `lastUsedAt`. An unknown `state` fails
 * the whole answer, so a state an API adds later drops no entry. Whether a
 * time string reads as a time is left to the rows, which show a row without
 * one (`sessionRows`, `formatRowMeta`).
 *
 * Only types are compared, and nothing is converted to a string, so no value
 * can make this throw: a nested array in a time field, whose conversion
 * recurses until the stack overflows, is simply not a string. Linear in the
 * number of entries; an answer of another length is refused before any entry
 * is read.
 */
export function parseSessionStatuses(
  answer: unknown,
  ids: readonly string[],
): SessionStatus[] | null {
  if (!isRecord(answer)) {
    return null;
  }

  const { sessions } = answer;

  if (!Array.isArray(sessions) || sessions.length !== ids.length) {
    return null;
  }

  const statuses: SessionStatus[] = [];

  for (const [index, id] of ids.entries()) {
    const status = parseSessionStatus((sessions as unknown[])[index], id);

    if (status === null) {
      return null;
    }

    statuses.push(status);
  }

  return statuses;
}

/**
 * The ids the status read says are gone - `expired` or `not_found` - which
 * leave the list, and the active sessions by id, which the rows show.
 */
export function splitStatuses(statuses: readonly SessionStatus[]): {
  gone: string[];
  active: Map<string, ActiveSession>;
} {
  const gone: string[] = [];
  const active = new Map<string, ActiveSession>();

  for (const status of statuses) {
    if (status.state === 'active') {
      active.set(status.id, status);
    } else {
      gone.push(status.id);
    }
  }

  return { gone, active };
}

/** Where the status read ends: what the rows show, and what leaves the stored list. */
export interface StatusOutcome {
  read: Exclude<StatusRead, { state: 'loading' }>;
  /** The ids reported `expired` or `not_found`; none when the read failed. */
  gone: string[];
}

/**
 * Sends the status read for `ids` through `read` and settles it: `loaded`
 * with the ids that are gone, or `failed` with none. It never rejects -
 * whatever `read` or the handling of its answer throws, a malformed answer
 * included, ends as `failed` - so the page cannot stay on
 * `Loading sessions…`.
 */
export async function settleStatusRead(
  ids: readonly string[],
  read: (ids: string[]) => Promise<readonly SessionStatus[]>,
): Promise<StatusOutcome> {
  try {
    const { gone, active } = splitStatuses(await read([...ids]));

    return { read: { state: 'loaded', sessions: active }, gone };
  } catch {
    return { read: { state: 'failed' }, gone: [] };
  }
}

/** One row of the list. */
export interface SessionRow {
  id: string;
  /**
   * What the status read said of it, or `null` when the read failed: the row
   * then shows its id and no counts, grouped by the day it was opened here.
   */
  details: ActiveSession | null;
  /**
   * The instant it is sorted and grouped by: the last use, or the last opening
   * here - also when the answer's `lastUsedAt` is no time a `Date` can hold.
   */
  at: number;
}

/**
 * The rows, newest first. Once the read has answered, the sessions it
 * described, by the day of their last use (`lastUsedAt`); a listed session
 * the answer left out is not shown. When it failed, every listed session, by
 * the day it was last opened here. While it is pending, none.
 */
export function sessionRows(list: readonly ListedSession[], read: StatusRead): SessionRow[] {
  if (read.state === 'loading') {
    return [];
  }

  const rows: SessionRow[] = [];

  for (const entry of list) {
    if (read.state === 'failed') {
      rows.push({ id: entry.id, details: null, at: entry.openedAt });
      continue;
    }

    const details = read.sessions.get(entry.id);

    if (details !== undefined) {
      const at = Date.parse(details.lastUsedAt);

      rows.push({ id: entry.id, details, at: isTimeValue(at) ? at : entry.openedAt });
    }
  }

  // Ties keep the list's own order, the most recently opened first.
  return rows.sort((a, b) => b.at - a.at);
}

/** The first five rows, or every row once `Show all` was chosen. */
export function visibleRows<T>(rows: readonly T[], showAll: boolean): T[] {
  return showAll ? [...rows] : rows.slice(0, SESSIONS_SHOWN_FIRST);
}

/** The rows of one day. */
export interface DayGroup<T> {
  /** `YYYY-MM-DD` in the viewer's timezone. */
  key: string;
  /** `3 Oct 2026`. */
  label: string;
  /** `3 sessions`: the rows shown under it. */
  count: string;
  rows: T[];
}

/**
 * The parts of an instant in the viewer's timezone, or `null` for a number no
 * `Date` can hold, which `Intl` would refuse with a `RangeError`: the list
 * never throws over a value from storage or from the status read. `timeZone`
 * is for tests.
 */
function localParts(at: number, timeZone?: string) {
  const date = new Date(at);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    // Not `hour12: false`, which some engines render as `24` at midnight.
    hourCycle: 'h23',
  }).formatToParts(date);

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return {
    year: value('year'),
    month: Number(value('month')),
    day: Number(value('day')),
    hour: value('hour'),
    minute: value('minute'),
  };
}

const twoDigits = (value: number) => String(value).padStart(2, '0');

/**
 * Consecutive rows of one local day under one heading, in the rows' order.
 * Rows sorted newest first give the days newest first. A row whose `at` no
 * `Date` can hold - `sessionRows` gives none - goes under a heading with no
 * date, key `''`, rather than throwing. The heading's month is the
 * dictionary's, as the changelog and the detail panel write it, fixed rather
 * than taken from a locale (D148): `3 Oct 2026`, `3 окт. 2026` (D222).
 */
export function groupByDay<T extends { at: number }>(
  rows: readonly T[],
  timeZone?: string,
  m: Messages = en,
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];

  for (const row of rows) {
    const parts = localParts(row.at, timeZone);
    const key =
      parts === null ? '' : `${parts.year}-${twoDigits(parts.month)}-${twoDigits(parts.day)}`;
    const last = groups.at(-1);

    if (last?.key === key) {
      last.rows.push(row);
    } else {
      groups.push({
        key,
        label:
          parts === null ? '' : `${parts.day} ${m.months[parts.month - 1] ?? ''} ${parts.year}`,
        count: '',
        rows: [row],
      });
    }
  }

  for (const group of groups) {
    group.count = m.home.sessions(group.rows.length);
  }

  return groups;
}

/** `1 session`, `3 sessions`; `1 request`, `0 requests`: the English way. */
export function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * `2026-10-03 11:40` in the viewer's timezone, as the row writes the last
 * request; `null` for a time that does not parse to one a `Date` can hold.
 */
export function formatRowTime(iso: string, timeZone?: string): string | null {
  const parts = localParts(Date.parse(iso), timeZone);

  return parts === null
    ? null
    : `${parts.year}-${twoDigits(parts.month)}-${twoDigits(parts.day)} ${parts.hour}:${parts.minute}`;
}

/**
 * A row's second line, in its two tones: `14 requests` and
 * `last request 2026-10-03 11:40`, or `0 requests` and `no requests yet`. A
 * `lastRequestAt` that cannot be read as a time leaves `last request` alone.
 */
export function formatRowMeta(
  details: Pick<ActiveSession, 'requestsCount' | 'lastRequestAt'>,
  timeZone?: string,
  m: Messages = en,
): { count: string; last: string } {
  const time =
    details.lastRequestAt === null ? null : formatRowTime(details.lastRequestAt, timeZone);

  return {
    count: m.home.requests(details.requestsCount),
    last:
      details.lastRequestAt === null
        ? m.home.noRequestsYet
        : time === null
          ? m.home.lastRequest
          : m.home.lastRequestAt(time),
  };
}

/**
 * The line under the list: `5 of 12 sessions in this browser` with `Show all`
 * while some are hidden, `3 sessions in this browser` when every one shows.
 */
export function formatListCount(
  shown: number,
  total: number,
  m: Messages = en,
): { text: string; showAll: boolean } {
  return shown < total
    ? { text: m.home.someShown(shown, total), showAll: true }
    : { text: m.home.allShown(total), showAll: false };
}

/**
 * The receive URL in its two tones: everything before the id muted, the id
 * bold. A URL that does not end with the id is all prefix.
 */
export function splitReceiveUrl(receiveUrl: string, id: string): { prefix: string; id: string } {
  return receiveUrl.endsWith(id) && id.length > 0
    ? { prefix: receiveUrl.slice(0, receiveUrl.length - id.length), id }
    : { prefix: receiveUrl, id: '' };
}

/** A session named in a sentence: its first 7 characters, as a request is (D044). */
export function shortSessionId(id: string): string {
  return id.slice(0, REQUEST_ID_DISPLAY_LENGTH);
}

export const DELETE_SESSION_TITLE = en.home.deleteTitle;

/**
 * The confirmation's sentence (frames `604:408`, `604:511`). The count is the
 * status read's; without one - the read failed - the sentence names none.
 */
export function formatDeleteDescription(
  id: string,
  requestsCount: number | null,
  m: Messages = en,
): string {
  return m.home.deleteDescription(shortSessionId(id), requestsCount);
}

export const DELETE_FAILED = en.home.deleteFailed;

/** The toast after a deletion (frame `604:443`). */
export function formatDeletedToast(id: string, m: Messages = en): string {
  return m.home.deleted(shortSessionId(id));
}

/**
 * The toast when the deletion found the session expired: it was not deleted,
 * and the cleanup removes it, so it leaves the list as the status read would
 * have taken it off.
 */
export function formatExpiredToast(id: string, m: Messages = en): string {
  return m.home.expired(shortSessionId(id));
}
