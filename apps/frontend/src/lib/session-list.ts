/**
 * The sessions used in this browser, which the home page lists (issue #92,
 * D199).
 *
 * Kept in `localStorage` under `qa-tools:sessions` as
 * `{"v":1,"items":[{"id":"<session id>","openedAt":<ms>}]}`, the most
 * recently opened first. Nothing here goes through the server: the ids leave
 * the browser only as the body of the status read the home page sends
 * (`POST /api/sessions/status`), and another browser, profile or private
 * window keeps a list of its own.
 *
 * - **A session joins the list** when the home page creates it and when its
 *   page, `/v/<id>`, has loaded it; opening it again moves its `openedAt` to
 *   now.
 * - **At most `MAX_LISTED_SESSIONS`**: one status read takes them all. A
 *   session opened into a full list pushes out the least recently opened
 *   public session, and a private one only when every listed session is
 *   private (issue #228, D259, amending D199).
 * - **A session leaves the list** by `Remove from list`, by a deletion that
 *   succeeded, and when the status read reports it `expired` or `not_found`
 *   with the key this browser still holds for it (`removeReportedSessions`).
 *   A private session's access key leaves with it (`access-keys.ts`), however
 *   it leaves, a push-out included.
 * - **The move link** (issue #321, D276) carries the list, with the keys,
 *   the language and the two section states, from the old address of the
 *   inspector to its new one in the address's fragment, which no server
 *   receives (`move-link.ts`). There it only adds (`mergeMovedSessions`): a
 *   session listed already keeps its entry and the later `openedAt`, and a
 *   moved one takes only the room the list has left. Storage belongs to one
 *   origin, so this is the one way the list goes from one address to another.
 *
 * **Every storage access is guarded**, as `read-state.ts` guards its own:
 * unavailable, blocked or full storage means no list, and the home page is
 * the first-visit page, with no error. A stored value this version cannot
 * read is no list either, and the next write replaces it. Each change reads
 * the stored list again, changes it and writes it back, so an entry another
 * tab stored meanwhile is kept. Two tabs writing at the same moment are not
 * ordered, though: `localStorage` has no atomic read-modify-write, so the last
 * write wins (D199).
 */
import { MAX_SESSION_STATUS_IDS, SESSION_ID_PATTERN } from '@webhook-inspector/shared';
import { accessKeysFor, forgetAccessKeys, privateSessionIds } from './access-keys.ts';

/** The one key the list is kept under. */
export const SESSION_LIST_KEY = 'qa-tools:sessions';

/** The most sessions kept, as many as one status read takes (D199). */
export const MAX_LISTED_SESSIONS = MAX_SESSION_STATUS_IDS;

const FORMAT_VERSION = 1;

/** One session of the list. */
export interface ListedSession {
  id: string;
  /** When a page of this browser last opened it, in milliseconds since the epoch. */
  openedAt: number;
}

/** The largest time value a `Date` holds, in milliseconds either side of the epoch. */
const MAX_TIME_VALUE = 8.64e15;

/**
 * Whether `value` is a time value a `Date` can hold: an integer within
 * ±`MAX_TIME_VALUE`. Anything else - `1e20`, a fraction, `Infinity` - would
 * make an `Invalid Date`, and formatting one throws a `RangeError`.
 */
export function isTimeValue(value: unknown): value is number {
  return Number.isSafeInteger(value) && Math.abs(value as number) <= MAX_TIME_VALUE;
}

/** The part of `Storage` this module uses; a fake in the tests. */
export type SessionListStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The entries of a stored value, the most recently opened first, at most
 * `MAX_LISTED_SESSIONS`; empty for anything this version did not write.
 *
 * An entry is kept only with an id a session can have and an `openedAt` a
 * `Date` can hold (`isTimeValue`), so no stored entry can make the page throw
 * when it writes the day; an id stored twice keeps its later opening. Linear
 * in the stored value, whatever it holds.
 */
export function parseSessionList(raw: string | null): ListedSession[] {
  if (raw === null) {
    return [];
  }

  let value: unknown;

  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }

  const { v, items } = value as Record<string, unknown>;

  if (v !== FORMAT_VERSION || !Array.isArray(items)) {
    return [];
  }

  const latest = new Map<string, number>();

  for (const item of items as unknown[]) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }

    const { id, openedAt } = item as Record<string, unknown>;

    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id) || !isTimeValue(openedAt)) {
      continue;
    }

    if (openedAt > (latest.get(id) ?? Number.NEGATIVE_INFINITY)) {
      latest.set(id, openedAt);
    }
  }

  return capped([...latest].map(([id, openedAt]) => ({ id, openedAt })));
}

/** The most recently opened first, and no more than the list keeps. */
function capped(entries: ListedSession[]): ListedSession[] {
  return entries.sort((a, b) => b.openedAt - a.openedAt).slice(0, MAX_LISTED_SESSIONS);
}

function serialize(entries: ListedSession[]): string {
  return JSON.stringify({
    v: FORMAT_VERSION,
    items: capped(entries).map(({ id, openedAt }) => ({ id, openedAt })),
  });
}

/** The list this browser keeps, the most recently opened first; empty when nothing can be read. */
export function loadSessionList(storage: SessionListStorage | null): ListedSession[] {
  if (storage === null) {
    return [];
  }

  try {
    return parseSessionList(storage.getItem(SESSION_LIST_KEY));
  } catch {
    return [];
  }
}

/**
 * The entries of a list one longer than it keeps, less the one pushed out:
 * the least recently opened public session, or, when every entry is private,
 * the least recently opened of all (D259). `entries` is the most recently
 * opened first; so is the answer. A list that fits is answered whole.
 */
export function pushOut(
  entries: readonly ListedSession[],
  isPrivate: (id: string) => boolean,
): { kept: ListedSession[]; pushedOut: string[] } {
  const sorted = [...entries].sort((a, b) => b.openedAt - a.openedAt);
  const pushedOut: string[] = [];

  while (sorted.length > MAX_LISTED_SESSIONS) {
    let index = sorted.length - 1;

    for (let at = sorted.length - 1; at >= 0; at -= 1) {
      if (!isPrivate((sorted[at] as ListedSession).id)) {
        index = at;
        break;
      }
    }

    pushedOut.push((sorted.splice(index, 1)[0] as ListedSession).id);
  }

  return { kept: sorted, pushedOut };
}

/**
 * Adds a session opened now, or moves its `openedAt` to now. A 51st session
 * pushes out the least recently opened public one, or the least recently
 * opened when all are private, whose key goes with it (`pushOut`, D259).
 * Answers with the list as stored, or `null` when nothing could be written; a
 * `now` that is no time value writes nothing, since the list would skip it
 * when read.
 */
export function recordSessionOpened(
  storage: SessionListStorage | null,
  id: string,
  now: number,
): ListedSession[] | null {
  if (storage === null || !SESSION_ID_PATTERN.test(id) || !isTimeValue(now)) {
    return null;
  }

  try {
    const entries = parseSessionList(storage.getItem(SESSION_LIST_KEY)).filter(
      (entry) => entry.id !== id,
    );

    entries.push({ id, openedAt: now });

    const privateIds =
      entries.length > MAX_LISTED_SESSIONS
        ? privateSessionIds(
            entries.map((entry) => entry.id),
            storage,
          )
        : new Set<string>();
    const { kept, pushedOut: gone } = pushOut(entries, (entry) => privateIds.has(entry));

    storage.setItem(SESSION_LIST_KEY, serialize(kept));

    const goneKeys = gone.filter((entry) => privateIds.has(entry));

    if (goneKeys.length > 0) {
      forgetAccessKeys(storage, goneKeys);
    }

    return kept;
  } catch {
    // Full or blocked: the session is simply not listed.
    return null;
  }
}

/**
 * Adds the sessions a move link brought from the old address (issue #321,
 * D276), and only adds: a session listed here already keeps its entry,
 * taking the later of the two `openedAt`, and none is pushed out. The list
 * keeps at most `MAX_LISTED_SESSIONS`, so new sessions take only the room
 * left, the private ones (`isPrivate`) first and then the most recently
 * opened. Answers the ids of `moved` the stored list holds afterwards, or
 * `null` when storage could not be read or written. `moved` is the link's
 * list, already checked as a stored one is (`move-link.ts`); an entry of
 * another shape is skipped here all the same.
 */
export function mergeMovedSessions(
  storage: SessionListStorage | null,
  moved: readonly ListedSession[],
  isPrivate: (id: string) => boolean,
): Set<string> | null {
  if (storage === null) {
    return null;
  }

  try {
    const entries = parseSessionList(storage.getItem(SESSION_LIST_KEY));
    const listed = new Map(entries.map((entry) => [entry.id, entry]));
    const added = new Map<string, ListedSession>();
    let changed = false;

    for (const { id, openedAt } of moved) {
      if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id) || !isTimeValue(openedAt)) {
        continue;
      }

      const here = listed.get(id);
      const earlier = added.get(id);

      if (here !== undefined) {
        if (openedAt > here.openedAt) {
          here.openedAt = openedAt;
          changed = true;
        }
      } else if (earlier === undefined || openedAt > earlier.openedAt) {
        added.set(id, { id, openedAt });
      }
    }

    const room = Math.max(0, MAX_LISTED_SESSIONS - entries.length);
    const taken = [...added.values()]
      .sort((a, b) => Number(isPrivate(b.id)) - Number(isPrivate(a.id)) || b.openedAt - a.openedAt)
      .slice(0, room);

    if (taken.length > 0 || changed) {
      storage.setItem(SESSION_LIST_KEY, serialize([...entries, ...taken]));
    }

    const kept = new Set([...entries, ...taken].map((entry) => entry.id));

    return new Set(moved.map((entry) => entry.id).filter((id) => kept.has(id)));
  } catch {
    // Full or blocked: nothing came.
    return null;
  }
}

/**
 * Takes sessions off the list: removed by hand, deleted, or reported
 * `expired` or `not_found` by the status read. Their access keys go too, from
 * this tab and from storage, listed or not (D259). Answers with the list as
 * stored, or `null` when nothing could be written; writes nothing when none
 * of `ids` is listed or holds a key.
 */
export function removeListedSessions(
  storage: SessionListStorage | null,
  ids: Iterable<string>,
): ListedSession[] | null {
  const gone = new Set(ids);

  forgetAccessKeys(storage, gone);

  if (storage === null) {
    return null;
  }

  try {
    const entries = parseSessionList(storage.getItem(SESSION_LIST_KEY));
    const next = entries.filter((entry) => !gone.has(entry.id));

    if (next.length !== entries.length) {
      storage.setItem(SESSION_LIST_KEY, serialize(next));
    }

    return next;
  } catch {
    return null;
  }
}

/** The key `keys` names for `id`, or `null`: its own property only. */
function keyIn(keys: Readonly<Record<string, string>> | null, id: string): string | null {
  return keys !== null && Object.hasOwn(keys, id) ? (keys[id] as string) : null;
}

/**
 * Takes off the list the sessions a status read reported `expired` or
 * `not_found` (D199), with their keys (D259) - each only while this browser
 * holds for it the key the read was sent with, `sent` being the read's
 * `accessKeys` (`null` for none). The verdict was on that key: a private
 * session read with no key or a wrong one is `not_found` too (D245 point 6),
 * so once another tab has stored its right key meanwhile - a link or a paste
 * that opened it - the answer says nothing about the session, and the entry
 * and the key that tab stored stay. A public session holds no key before or
 * after and leaves as before. Answers the ids taken off.
 */
export function removeReportedSessions(
  storage: SessionListStorage | null,
  reported: Iterable<string>,
  sent: Readonly<Record<string, string>> | null,
): string[] {
  const ids = [...new Set(reported)];
  const now = accessKeysFor(ids, storage);
  const gone = ids.filter((id) => keyIn(now, id) === keyIn(sent, id));

  if (gone.length > 0) {
    removeListedSessions(storage, gone);
  }

  return gone;
}
