/**
 * The viewer's read state, shared by the tabs of one browser (issue #46, D156).
 *
 * A request is unread until this viewer opens it (D078). The set of opened ids
 * is kept per session in `localStorage`, so a tab opened later and a reload
 * start from it, and the `storage` event carries each change to the tabs open
 * at that moment. Nothing goes through the server: another browser, profile or
 * private window keeps its own read state.
 *
 * **The set only grows.** There is no "mark as unread", so combining two views
 * of it is a union: idempotent, order-independent, and a tab reading its own
 * write back changes nothing (compare D136). An id the tab does not hold yet is
 * kept, so a request opened in another tab before it reached this one arrives
 * already read.
 *
 * **Storage is bounded** (D156):
 * - at most `MAX_STORED_READ_IDS` ids per session, the most recently opened
 *   kept (D006);
 * - an id the session no longer holds is dropped when a list load proves it:
 *   the id was opened before the load started - so the request was already
 *   stored on the server when the list was read - and the list does not
 *   contain it. An id opened after the load started is never dropped by that
 *   load, which is what keeps criterion 2 true;
 * - an entry not used for longer than a session lives unused
 *   (`SESSION_IDLE_DAYS`) is removed.
 *
 * **Every storage access is guarded.** Unavailable, blocked or full storage
 * leaves the page on today's per-tab read state, with no error.
 *
 * Stored under `qa-tools:read:<sessionId>` as
 * `{"v":1,"usedAt":<ms>,"opened":{"<requestId>":<openedAt ms>}}`.
 *
 * **The list filter lives beside it** (issue #70, D180): the text typed in the
 * request list's filter, per session, under `qa-tools:filter:<sessionId>` as
 * `{"v":1,"usedAt":<ms>,"query":"<text>"}`. It is restored on reload, not
 * carried to other open tabs, removed when cleared, and dropped with the
 * session's read state: by the same idle rule, and together with a read-state
 * entry that rule removes. Storage that is blocked or full leaves it in the tab.
 *
 * **Neither travels with the move link** (issue #321, D276), which carries
 * the list of sessions, their keys, the language and the section states from
 * the inspector's old address to its new one (`move-link.ts`): up to 1,000
 * ids for each of 50 sessions would swell the link, and the new address
 * starts with every request unread and no filter.
 */
import { MAX_REQUESTS_PER_SESSION, SESSION_IDLE_DAYS } from '@webhook-inspector/shared';

/** Prefix of every read-state key; the session id follows it. */
export const READ_STATE_KEY_PREFIX = 'qa-tools:read:';

/** Prefix of every list-filter key; the session id follows it (D180). */
export const FILTER_KEY_PREFIX = 'qa-tools:filter:';

/** The most ids kept for one session: as many as it can hold (D006). */
export const MAX_STORED_READ_IDS = MAX_REQUESTS_PER_SESSION;

/** How long an entry survives unused, in milliseconds: a session's idle life. */
export const READ_STATE_IDLE_MS = SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000;

const FORMAT_VERSION = 1;

/** The part of `Storage` this module uses; a fake in the tests. */
export type ReadStateStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>;

interface StoredReadState {
  /** When a tab of this browser last used the entry. */
  usedAt: number;
  /** Opened request id → when it was first opened. */
  opened: Map<string, number>;
}

export function readStateKey(sessionId: string): string {
  return `${READ_STATE_KEY_PREFIX}${sessionId}`;
}

export function filterKey(sessionId: string): string {
  return `${FILTER_KEY_PREFIX}${sessionId}`;
}

/**
 * The browser's `localStorage`, or `null` where it cannot be had: reading the
 * property itself throws when storage is blocked.
 */
export function browserStorage(): ReadStateStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** A stored value, or `null` for anything that is not one this version wrote. */
function parseStored(raw: string | null): StoredReadState | null {
  if (raw === null) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(raw);

    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const { v, usedAt, opened } = value as Record<string, unknown>;

    if (
      v !== FORMAT_VERSION ||
      typeof usedAt !== 'number' ||
      typeof opened !== 'object' ||
      opened === null ||
      Array.isArray(opened)
    ) {
      return null;
    }

    const entries = new Map<string, number>();

    for (const [id, openedAt] of Object.entries(opened)) {
      if (typeof openedAt === 'number' && Number.isFinite(openedAt)) {
        entries.set(id, openedAt);
      }
    }

    return { usedAt, opened: entries };
  } catch {
    return null;
  }
}

function serialize(state: StoredReadState): string {
  let entries = [...state.opened];

  if (entries.length > MAX_STORED_READ_IDS) {
    entries = entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_STORED_READ_IDS);
  }

  return JSON.stringify({
    v: FORMAT_VERSION,
    usedAt: state.usedAt,
    opened: Object.fromEntries(entries),
  });
}

function read(storage: ReadStateStorage, sessionId: string): StoredReadState | null {
  return parseStored(storage.getItem(readStateKey(sessionId)));
}

function write(storage: ReadStateStorage, sessionId: string, state: StoredReadState): void {
  storage.setItem(readStateKey(sessionId), serialize(state));
}

/** The ids stored as opened for the session; empty when nothing can be read. */
export function loadReadIds(storage: ReadStateStorage | null, sessionId: string): Set<string> {
  if (storage === null) {
    return new Set();
  }

  try {
    return new Set(read(storage, sessionId)?.opened.keys());
  } catch {
    return new Set();
  }
}

/**
 * Adds an opened request to the session's stored set. Read, merged and
 * written back, so an id another tab stored meanwhile is kept.
 */
export function recordRead(
  storage: ReadStateStorage | null,
  sessionId: string,
  id: string,
  now: number,
): void {
  if (storage === null) {
    return;
  }

  try {
    const state = read(storage, sessionId) ?? { usedAt: now, opened: new Map() };

    if (!state.opened.has(id)) {
      state.opened.set(id, now);
    }

    state.usedAt = now;
    write(storage, sessionId, state);
  } catch {
    // Full or blocked: this tab keeps its own read state, as before #46.
  }
}

/**
 * Drops the ids a completed list load proves the session no longer holds, and
 * marks the entry used. `heldIds` is the whole list the server answered, and
 * `loadStartedAt` the moment before that load was sent: only an id opened
 * before then is dropped for being absent. Writes nothing when there is no
 * entry, so a session never opened creates none.
 */
export function pruneReadState(
  storage: ReadStateStorage | null,
  sessionId: string,
  heldIds: Iterable<string>,
  loadStartedAt: number,
  now: number,
): void {
  if (storage === null) {
    return;
  }

  try {
    const state = read(storage, sessionId);

    if (state === null) {
      return;
    }

    const held = new Set(heldIds);

    for (const [id, openedAt] of state.opened) {
      if (openedAt < loadStartedAt && !held.has(id)) {
        state.opened.delete(id);
      }
    }

    state.usedAt = now;
    write(storage, sessionId, state);
  } catch {
    // Nothing to report: an entry left larger than it needs to be is harmless.
  }
}

/**
 * Removes the entries of sessions unused for longer than `READ_STATE_IDLE_MS`,
 * and any read-state entry this version cannot read. The session the page is
 * showing is left alone: its entry is refreshed by the page's own list load.
 */
export function pruneIdleReadState(
  storage: ReadStateStorage | null,
  currentSessionId: string,
  now: number,
): void {
  if (storage === null) {
    return;
  }

  try {
    const current = readStateKey(currentSessionId);
    const currentFilter = filterKey(currentSessionId);
    const stale: string[] = [];

    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);

      if (key === null || key === current || key === currentFilter) {
        continue;
      }

      if (key.startsWith(READ_STATE_KEY_PREFIX)) {
        const state = parseStored(storage.getItem(key));

        if (state === null || now - state.usedAt > READ_STATE_IDLE_MS) {
          // The session's filter goes with its read state (D180).
          stale.push(key, filterKey(key.slice(READ_STATE_KEY_PREFIX.length)));
        }
      } else if (key.startsWith(FILTER_KEY_PREFIX)) {
        const filter = parseStoredFilter(storage.getItem(key));

        if (filter === null || now - filter.usedAt > READ_STATE_IDLE_MS) {
          stale.push(key);
        }
      }
    }

    for (const key of stale) {
      storage.removeItem(key);
    }
  } catch {
    // Left for the next page load.
  }
}

/**
 * The ids a `storage` event carries for this session, or `null` when the event
 * is about something else: another key, a removal, or a value this version
 * cannot read.
 */
export function readIdsFromStorageEvent(
  event: { key: string | null; newValue: string | null },
  sessionId: string,
): string[] | null {
  if (event.key !== readStateKey(sessionId)) {
    return null;
  }

  const state = parseStored(event.newValue);

  return state === null ? null : [...state.opened.keys()];
}

/**
 * The union of a tab's read set and ids learnt elsewhere. The same set comes
 * back when nothing is new, so a tab's own write echoed to it does not even
 * re-render the page.
 */
export function addReadIds(
  current: ReadonlySet<string>,
  ids: Iterable<string>,
): ReadonlySet<string> {
  let next: Set<string> | null = null;

  for (const id of ids) {
    if (!current.has(id)) {
      next ??= new Set(current);
      next.add(id);
    }
  }

  return next ?? current;
}

/** A stored filter, or `null` for anything that is not one this version wrote. */
function parseStoredFilter(raw: string | null): { usedAt: number; query: string } | null {
  if (raw === null) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(raw);

    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const { v, usedAt, query } = value as Record<string, unknown>;

    return v === FORMAT_VERSION && typeof usedAt === 'number' && typeof query === 'string'
      ? { usedAt, query }
      : null;
  } catch {
    return null;
  }
}

/**
 * The list filter this browser kept for the session, or `''` for none or
 * where nothing can be read (D180).
 */
export function loadFilter(storage: ReadStateStorage | null, sessionId: string): string {
  if (storage === null) {
    return '';
  }

  try {
    return parseStoredFilter(storage.getItem(filterKey(sessionId)))?.query ?? '';
  } catch {
    return '';
  }
}

/**
 * Keeps the session's list filter, or removes it when the text is only
 * spaces. Blocked or full storage leaves the filter in the tab alone.
 */
export function saveFilter(
  storage: ReadStateStorage | null,
  sessionId: string,
  query: string,
  now: number,
): void {
  if (storage === null) {
    return;
  }

  try {
    if (query.trim() === '') {
      storage.removeItem(filterKey(sessionId));
    } else {
      storage.setItem(
        filterKey(sessionId),
        JSON.stringify({ v: FORMAT_VERSION, usedAt: now, query }),
      );
    }
  } catch {
    // Full or blocked: the filter belongs to this tab alone.
  }
}
