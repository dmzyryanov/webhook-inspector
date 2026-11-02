/**
 * The access keys of the private sessions this browser holds (issue #228,
 * D259), beside the list of the sessions used in it (`session-list.ts`, D199).
 *
 * A private session opens only to a call that presents its key (D245): the
 * page sends it by itself - `Authorization: Bearer <key>` on the API, a
 * subprotocol of the socket's handshake, the status read's `accessKeys` - and
 * the person never sees it. A key has a session id's shape, 43 characters of
 * `A-Z a-z 0-9 _ -` (D245 point 2); any other value is no key, is never kept
 * and never sent, so one bad stored value cannot fail the status read of the
 * whole list (`400` / `1014`).
 *
 * Kept in `localStorage` under `qa-tools:access-keys` as
 * `{"v":1,"items":[{"id":"<session id>","key":"<key>"}]}`, the most recently
 * stored last, apart from the list so a bundle before this one, which rewrites
 * the list with the fields it knows, never drops a key. A key is stored only
 * once it has opened its session as a private one - a creation that drew it,
 * or a link or a paste whose key the session's read accepted - so a wrong key
 * never replaces a right one. It leaves with its session's entry: on
 * `Remove from list`, on a deletion that succeeded, when the status read
 * reports the session `expired` or `not_found`, and when a full list pushes a
 * private session out (`session-list.ts`).
 *
 * **The move link** (issue #321, D276) carries the stored keys from the old
 * address of the inspector to its new one, in the address's fragment, which
 * no server receives, with the list (`move-link.ts`); it is never logged and
 * never sent, and the new address takes it out of the address bar at once, as
 * a link with access is. There the keys only add (`mergeMovedAccessKeys`): a
 * session that holds a key keeps it, so a link's key never replaces one, and
 * a moved key is stored unchecked, having opened its session on the old
 * address, where it was stored. A wrong one, a crafted link's, is no worse
 * than a wrong link with access: the status read reports its session
 * `not_found` and takes it off with its key.
 *
 * **This tab holds keys too** (`holdAccessKey`): the key a link brought before
 * its session answered, and a key storage refused, so a link with access still
 * opens its session in the tab it was opened in. A held key lasts until the
 * tab is reloaded or the key is forgotten here, and is asked after a stored
 * one: a stored key has opened its session, while a held one may be a link's
 * not yet checked, and a session has one key, so the stored one is never the
 * wrong one of the two. A key that is stored is not held as well
 * (`keepAccessKey`): every tab reads the one stored copy at each use, so a key
 * removed in one tab - `Remove from list`, a deletion, a status read - is gone
 * in every other at once, and none opens the session with it again or stores
 * it back. A key another tab removes that this tab still holds, a link's it
 * had not stored yet, is let go of too (`watchAccessKeyRemovals`).
 *
 * **Every storage access is guarded**, as the list's: unavailable, blocked or
 * full storage keeps nothing and throws nothing. Two tabs writing at the same
 * moment are not ordered; the last write wins (D199).
 */
import { MAX_SESSION_STATUS_IDS, SESSION_ID_PATTERN } from '@webhook-inspector/shared';
import { browserStorage } from './read-state.ts';

/** The one key the access keys are kept under. */
export const ACCESS_KEYS_KEY = 'qa-tools:access-keys';

/**
 * The most keys kept: twice the list's 50, so a key whose entry another tab
 * or an older bundle took off the list never pushes out a listed one. The
 * least recently stored goes first.
 */
export const MAX_STORED_ACCESS_KEYS = 2 * MAX_SESSION_STATUS_IDS;

const FORMAT_VERSION = 1;

/** A key's shape: a session id's, 43 characters of `A-Z a-z 0-9 _ -` (D245 point 2). */
const ACCESS_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Whether `value` has a key's shape; anything else is no key to the server. */
export function isAccessKey(value: unknown): value is string {
  return typeof value === 'string' && ACCESS_KEY_PATTERN.test(value);
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

/** The part of `Storage` this module uses; a fake in the tests. */
export type AccessKeyStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The keys of a stored value by session id, the least recently stored first,
 * at most `MAX_STORED_ACCESS_KEYS`; empty for anything this version did not
 * write. An entry is kept only with an id a session can have and a value of a
 * key's shape; an id stored twice keeps its later key. Linear in the stored
 * value, whatever it holds.
 */
export function parseAccessKeys(raw: string | null): Map<string, string> {
  const keys = new Map<string, string>();

  if (raw === null) {
    return keys;
  }

  let value: unknown;

  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return keys;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return keys;
  }

  const { v, items } = value as Record<string, unknown>;

  if (v !== FORMAT_VERSION || !Array.isArray(items)) {
    return keys;
  }

  for (const item of items as unknown[]) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }

    const { id, key } = item as Record<string, unknown>;

    if (isSessionId(id) && isAccessKey(key)) {
      keys.delete(id);
      keys.set(id, key);
    }
  }

  return capped(keys);
}

/** The most recently stored `MAX_STORED_ACCESS_KEYS`, in their order. */
function capped(keys: Map<string, string>): Map<string, string> {
  const excess = keys.size - MAX_STORED_ACCESS_KEYS;

  if (excess <= 0) {
    return keys;
  }

  return new Map([...keys].slice(excess));
}

function serialize(keys: Map<string, string>): string {
  return JSON.stringify({
    v: FORMAT_VERSION,
    items: [...capped(keys)].map(([id, key]) => ({ id, key })),
  });
}

/** The stored keys by session id; empty when nothing can be read. */
export function loadAccessKeys(storage: AccessKeyStorage | null | undefined): Map<string, string> {
  if (storage === null || storage === undefined) {
    return new Map();
  }

  try {
    return parseAccessKeys(storage.getItem(ACCESS_KEYS_KEY));
  } catch {
    return new Map();
  }
}

/**
 * Stores the key of a session that opened with it, as the most recently
 * stored. `false` when nothing was written: an id or a key of the wrong
 * shape, or storage that is unavailable, blocked or full.
 */
export function storeAccessKey(
  storage: AccessKeyStorage | null | undefined,
  id: string,
  key: string,
): boolean {
  if (storage === null || storage === undefined || !isSessionId(id) || !isAccessKey(key)) {
    return false;
  }

  try {
    const keys = parseAccessKeys(storage.getItem(ACCESS_KEYS_KEY));

    keys.delete(id);
    keys.set(id, key);
    storage.setItem(ACCESS_KEYS_KEY, serialize(keys));

    return true;
  } catch {
    return false;
  }
}

/**
 * Adds the keys a move link brought from the old address (issue #321, D276),
 * and only adds: a session that holds a key here keeps it, and no stored key
 * is pushed out. The store keeps at most `MAX_STORED_ACCESS_KEYS`, so new keys
 * take only the room left: those of `first` - the sessions the link lists -
 * before the rest, each group the most recently stored first. They are
 * stored as less recently stored than every key held here, so a later key
 * pushes them out before those. `moved` is the link's keys, the least recently
 * stored first, already checked as stored ones are (`move-link.ts`); a pair of
 * another shape is skipped here all the same. `false` when storage could not
 * be read or written.
 */
export function mergeMovedAccessKeys(
  storage: AccessKeyStorage | null | undefined,
  moved: readonly (readonly [string, string])[],
  first: (id: string) => boolean,
): boolean {
  if (storage === null || storage === undefined) {
    return false;
  }

  try {
    const keys = parseAccessKeys(storage.getItem(ACCESS_KEYS_KEY));
    const added = new Map<string, string>();

    for (const [id, key] of moved) {
      if (isSessionId(id) && isAccessKey(key) && !keys.has(id)) {
        added.delete(id);
        added.set(id, key);
      }
    }

    const room = Math.max(0, MAX_STORED_ACCESS_KEYS - keys.size);
    const newestFirst = [...added.keys()].reverse();
    const taken = new Set(
      [...newestFirst.filter(first), ...newestFirst.filter((id) => !first(id))].slice(0, room),
    );

    if (taken.size > 0) {
      const merged = new Map([...added].filter(([id]) => taken.has(id)));

      for (const [id, key] of keys) {
        merged.set(id, key);
      }

      storage.setItem(ACCESS_KEYS_KEY, serialize(merged));
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the stored keys of `ids`. Writes nothing when none of them has one;
 * `false` when storage could not be read or written.
 */
export function removeAccessKeys(
  storage: AccessKeyStorage | null | undefined,
  ids: Iterable<string>,
): boolean {
  if (storage === null || storage === undefined) {
    return false;
  }

  try {
    const keys = parseAccessKeys(storage.getItem(ACCESS_KEYS_KEY));
    let removed = false;

    for (const id of ids) {
      removed = keys.delete(id) || removed;
    }

    if (removed) {
      storage.setItem(ACCESS_KEYS_KEY, serialize(keys));
    }

    return true;
  } catch {
    return false;
  }
}

/** The keys this tab holds, by session id; see the module's comment. */
const held = new Map<string, string>();

/**
 * Holds a key in this tab, asked after a stored one. A value of the wrong
 * shape is not held; `false` then.
 */
export function holdAccessKey(id: string, key: string): boolean {
  if (!isSessionId(id) || !isAccessKey(key)) {
    return false;
  }

  held.set(id, key);

  return true;
}

/** Lets go of the key this tab holds for `id`, if any; a stored one stays. */
export function releaseAccessKey(id: string): void {
  held.delete(id);
}

/** Lets go of every key this tab holds; for the tests. */
export function releaseAllAccessKeys(): void {
  held.clear();
}

/**
 * Keeps the key of a session that has just opened as a private one: stored,
 * and then no longer held in this tab, so every tab reads the one stored copy
 * and a removal in any of them is a removal in all (D259); held in this tab
 * alone when storage cannot take it. A value of the wrong shape is not kept.
 */
export function keepAccessKey(
  storage: AccessKeyStorage | null | undefined,
  id: string,
  key: string,
): void {
  if (!isSessionId(id) || !isAccessKey(key)) {
    return;
  }

  if (storeAccessKey(storage, id, key)) {
    held.delete(id);
  } else {
    held.set(id, key);
  }
}

/**
 * What a load of a session that succeeded does with the key it opened with
 * (D259), answering whether the session joins the list: a private session's
 * key is kept (`keepAccessKey`) and a key held for a public session, which
 * needs none, is forgotten. A private session whose key this browser no
 * longer holds - removed in another tab while it loaded - is not kept and not
 * listed: the confirmed removal stands, and a listed entry with no key would
 * only show as a public row until the next status read took it off.
 */
export function settleOpenedKey(
  storage: AccessKeyStorage | null | undefined,
  id: string,
  isPrivate: boolean | undefined,
): boolean {
  const key = accessKeyFor(id, storage);

  if (isPrivate === true) {
    if (key === null) {
      return false;
    }

    keepAccessKey(storage, id, key);
  } else if (isPrivate === false && key !== null) {
    forgetAccessKeys(storage, [id]);
  }

  return true;
}

/** Forgets the keys of `ids` in this tab and in storage. */
export function forgetAccessKeys(
  storage: AccessKeyStorage | null | undefined,
  ids: Iterable<string>,
): void {
  const gone = [...ids];

  for (const id of gone) {
    held.delete(id);
  }

  removeAccessKeys(storage, gone);
}

/**
 * Whether the key presented for `id` is one only this tab holds, storage
 * holding none: a link's, not yet checked, or one storage refused. A reload
 * would lose it.
 */
export function heldOnlyInThisTab(
  id: string,
  storage: AccessKeyStorage | null | undefined = pageStorage(),
): boolean {
  return held.has(id) && !loadAccessKeys(storage).has(id);
}

/** The storage the page uses, guarded: `null` where it cannot be had. */
function pageStorage(): AccessKeyStorage | null {
  return browserStorage() ?? null;
}

/**
 * The key to present for a session: the stored one, else the one this tab
 * holds, else `null` - a public session, or a private one this browser cannot
 * open. Never throws.
 */
export function accessKeyFor(
  id: string,
  storage: AccessKeyStorage | null | undefined = pageStorage(),
): string | null {
  return loadAccessKeys(storage).get(id) ?? held.get(id) ?? null;
}

/**
 * The ids among `ids` this browser holds a key for: the private sessions of
 * the list, which the home page marks.
 */
export function privateSessionIds(
  ids: Iterable<string>,
  storage: AccessKeyStorage | null | undefined = pageStorage(),
): Set<string> {
  const stored = loadAccessKeys(storage);
  const found = new Set<string>();

  for (const id of ids) {
    if (held.has(id) || stored.has(id)) {
      found.add(id);
    }
  }

  return found;
}

/**
 * The status read's `accessKeys` (D245 point 5): the key of each of `ids`
 * this browser holds, and of no other id, or `null` when it holds none, so
 * the body stays `{ "ids": […] }` as before. Every value has a key's shape.
 */
export function accessKeysFor(
  ids: readonly string[],
  storage: AccessKeyStorage | null | undefined = pageStorage(),
): Record<string, string> | null {
  const stored = loadAccessKeys(storage);
  const keys: Record<string, string> = {};
  let any = false;

  for (const id of ids) {
    if (!isSessionId(id)) {
      continue;
    }

    const key = stored.get(id) ?? held.get(id);

    if (key !== undefined) {
      keys[id] = key;
      any = true;
    }
  }

  return any ? keys : null;
}

/** The fields of a `storage` event this module reads; a plain object in the tests. */
export interface AccessKeyStorageEvent {
  key: string | null;
  oldValue: string | null;
  newValue: string | null;
  storageArea: unknown;
}

/**
 * The keys a write to the store took out, by session id: each the old value
 * held and the new one does not hold any more, or holds another for. Empty for
 * a write that removed nothing, and for values this version did not write.
 * Linear in the two values, whatever they hold (`parseAccessKeys`).
 */
export function removedAccessKeys(
  oldValue: string | null,
  newValue: string | null,
): Map<string, string> {
  const before = parseAccessKeys(oldValue);
  const removed = new Map<string, string>();

  if (before.size === 0) {
    return removed;
  }

  const after = parseAccessKeys(newValue);

  for (const [id, key] of before) {
    if (after.get(id) !== key) {
      removed.set(id, key);
    }
  }

  return removed;
}

/**
 * Lets go of the keys this tab holds that another tab of this browser took
 * out of storage, as its `storage` event tells (D259): `Remove from list`, a
 * deletion, a status read or a push-out there. Only a held key equal to the
 * one removed goes - a link's that this tab had not stored yet, which would
 * otherwise open the session again and store it back; a key of another value
 * for the same session, a link's the other tab never had, stays. An event of
 * another key, of `sessionStorage`, or of `clear()`, which this application
 * never calls, changes nothing. Answers the ids let go of.
 */
export function releaseRemovedAccessKeys(
  event: AccessKeyStorageEvent,
  storage: AccessKeyStorage | null | undefined,
): string[] {
  if (storage === null || storage === undefined || event.key !== ACCESS_KEYS_KEY) {
    return [];
  }

  try {
    if (event.storageArea !== storage) {
      return [];
    }
  } catch {
    return [];
  }

  const released: string[] = [];

  for (const [id, key] of removedAccessKeys(event.oldValue, event.newValue)) {
    if (held.get(id) === key) {
      held.delete(id);
      released.push(id);
    }
  }

  return released;
}

/**
 * Listens on `target` - the window, once, from `main.tsx` - for the `storage`
 * events another tab's writes to the store fire, and lets go of the keys it
 * removed (`releaseRemovedAccessKeys`). Answers the function that stops it.
 */
export function watchAccessKeyRemovals(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  storage: AccessKeyStorage | null | undefined = pageStorage(),
): () => void {
  function onStorage(event: Event): void {
    releaseRemovedAccessKeys(event as unknown as AccessKeyStorageEvent, storage);
  }

  target.addEventListener('storage', onStorage);

  return () => target.removeEventListener('storage', onStorage);
}
