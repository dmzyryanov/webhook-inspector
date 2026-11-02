/**
 * The move of Webhook Inspector from its old address to its new one (issue
 * #321, D276): the banner on the old address, the move link its action
 * follows, and the arrival on the new address.
 *
 * Browser storage belongs to one origin, so the new address starts with an
 * empty list. The banner's action carries this browser's list of sessions
 * (`qa-tools:sessions`), the keys of its private sessions
 * (`qa-tools:access-keys`), the language chosen (`qa-tools:language`) and the
 * two section states (`qa-tools:queue-section`, `qa-tools:rules-section`) to
 * the new address in one versioned parameter of the fragment:
 *
 *     https://webhook.qa-tools.ru/#move=<base64url of the JSON below>
 *     {"v":1,"sessions":[{"id","openedAt"}],"keys":[{"id","key"}],
 *      "language":"ru","queueSection":false,"rulesSection":true}
 *
 * `sessions` and `keys` are the stored lists' items as they are stored, and
 * the last three are present only where this browser stores a value. Read
 * marks and filters stay behind.
 *
 * **The keys are handled as a link with access's** (D259): a browser never
 * sends what follows a `#`, so the link reaches no server, log or `Referer`;
 * nothing here logs it; the old address builds it only as its action is
 * clicked, never into the page, and the new one reads it before anything is
 * drawn and takes it out of the address at once by replacing the history
 * entry (`takeMoveFromAddress`), whatever it held. One opened over a page
 * already shown is read by loading the page again (`main.tsx`); a session
 * page's own reading of its fragment leaves it there for that load
 * (`takeKeyUnlessMove`).
 *
 * **The arrival only adds** (Decision 4 of #321): sessions by id, the later
 * `openedAt` kept, within `MAX_LISTED_SESSIONS`, and keys within
 * `MAX_STORED_ACCESS_KEYS`, nothing stored replaced or removed
 * (`mergeMovedSessions`, `mergeMovedAccessKeys`); the language and each
 * section state are taken only where this address stores none. A crafted
 * link can do no more than a link to a session does: add to the list. A toast
 * says how many sessions came and how many of them are private.
 *
 * **A link is read strictly** with the checks the stored formats have, and
 * refused whole for any fault: longer than `MAX_MOVE_FRAGMENT_LENGTH`, not
 * base64url, not JSON, another version, a field of another type, an entry a
 * stored list would not keep, an id twice, more sessions or keys than the
 * stores keep. A refused link changes nothing and is taken out of the address
 * all the same. A legitimate link never holds such a fault: the old address
 * builds it from what its own stored lists read.
 *
 * Where the move goes and when is the build's (`scripts/move-setting.mjs`):
 * `BUILT_MOVE`, the old origin, the new one and day X, or `null` for a build
 * with no second origin. The banner shows on the old origin alone
 * (`moveBannerShown`); a link is read wherever it opens, since it only adds.
 */
import { SESSION_ID_PATTERN } from '@webhook-inspector/shared';
import type { Messages, Phrase } from '../i18n/en.ts';
import { readStoredLanguage, storeLanguage, type Language } from '../i18n/index.ts';
import {
  isAccessKey,
  loadAccessKeys,
  MAX_STORED_ACCESS_KEYS,
  mergeMovedAccessKeys,
  type AccessKeyStorage,
} from './access-keys.ts';
import {
  parseQueueSectionOpen,
  QUEUE_SECTION_KEY,
  RULES_SECTION_KEY,
  serializeQueueSectionOpen,
} from './queue-section-open.ts';
import {
  takeKeyFromAddress,
  withoutFragment,
  type AddressBar,
  type SessionLinkFragment,
} from './request-link.ts';
import {
  isTimeValue,
  loadSessionList,
  MAX_LISTED_SESSIONS,
  mergeMovedSessions,
  type ListedSession,
} from './session-list.ts';

/** The move the build carries (D276): the old origin, the new one and day X, `YYYY-MM-DD`. */
export interface BuiltMove {
  readonly from: string;
  readonly to: string;
  readonly day: string;
}

/** What a move link carries. */
export interface MoveData {
  /** The list's entries, as `loadSessionList` reads them. */
  sessions: ListedSession[];
  /** The keys by session id, the least recently stored first, as `loadAccessKeys` reads them. */
  keys: [string, string][];
  language: Language | null;
  queueSection: boolean | null;
  rulesSection: boolean | null;
}

/** What an arrival brought: the link's sessions the list now holds, and how many of them are private. */
export interface MoveArrival {
  sessions: number;
  privateSessions: number;
}

/** The part of `Storage` this module uses; a fake in the tests. */
export type MoveStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The one version of the link this one reads and writes. */
export const MOVE_FORMAT_VERSION = 1;

/** The fragment's parameter: `#move=<base64url>`. */
export const MOVE_PARAMETER = 'move=';

/**
 * The longest value of the parameter read: the most a link can carry - 50
 * sessions and 100 keys - is under 20,000 characters. Anything longer is
 * refused before it is decoded.
 */
export const MAX_MOVE_FRAGMENT_LENGTH = 32_768;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The build's move, as `vite.config.ts` defines it; undefined outside a Vite build, in the tests. */
declare const __WEBHOOK_INSPECTOR_MOVE__: unknown;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An own property of `record`, or `undefined`: never one of `Object.prototype`. */
function own(record: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

/** The build's move as given, or `null` for none and for anything of another shape. */
export function parseBuiltMove(value: unknown): BuiltMove | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const from = own(value, 'from');
  const to = own(value, 'to');
  const day = own(value, 'day');

  return typeof from === 'string' &&
    typeof to === 'string' &&
    typeof day === 'string' &&
    DAY.test(day)
    ? { from, to, day }
    : null;
}

/** The move this bundle was built with (`scripts/move-setting.mjs`), or `null`. */
export const BUILT_MOVE: BuiltMove | null = parseBuiltMove(
  typeof __WEBHOOK_INSPECTOR_MOVE__ === 'undefined' ? null : __WEBHOOK_INSPECTOR_MOVE__,
);

/** Whether a page of `pageOrigin` shows the banner: on the old origin of a build that moves. */
export function moveBannerShown(pageOrigin: string, move: BuiltMove | null): move is BuiltMove {
  return move !== null && pageOrigin === move.from;
}

/** An origin's host as the banner and the toast name it: `webhook.qa-tools.ru`. */
export function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * Day X as the interface writes a day, `1 Dec 2026` or `1 дек. 2026`, from
 * the dictionary's months (D148), joined by no-break spaces so the banner
 * never breaks a line inside it.
 */
export function formatMoveDay(day: string, m: Pick<Messages, 'months'>): string {
  const [, year, month, date] = DAY.exec(day) ?? [];

  return year === undefined
    ? day
    : `${Number(date)}\u00a0${m.months[Number(month) - 1] ?? ''}\u00a0${Number(year)}`;
}

/** A stored section state, or `null` for none, for anything else and for storage that throws. */
function readSection(storage: MoveStorage, key: string): boolean | null {
  try {
    return parseQueueSectionOpen(storage.getItem(key));
  } catch {
    return null;
  }
}

/** What this browser's storage gives a move link: what each store reads, nothing where it reads nothing. */
export function collectMove(storage: MoveStorage | null): MoveData {
  return {
    sessions: loadSessionList(storage),
    keys: [...loadAccessKeys(storage)],
    language: readStoredLanguage(storage),
    queueSection: storage === null ? null : readSection(storage, QUEUE_SECTION_KEY),
    rulesSection: storage === null ? null : readSection(storage, RULES_SECTION_KEY),
  };
}

/** Base64url without padding, of a text all of whose characters are ASCII. */
function toBase64Url(text: string): string {
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** The parameter's value for `move`: base64url of its JSON, every character of which is ASCII. */
export function encodeMove(move: MoveData): string {
  const value: Record<string, unknown> = {
    v: MOVE_FORMAT_VERSION,
    sessions: move.sessions.map(({ id, openedAt }) => ({ id, openedAt })),
    keys: move.keys.map(([id, key]) => ({ id, key })),
  };

  if (move.language !== null) {
    value.language = move.language;
  }

  if (move.queueSection !== null) {
    value.queueSection = move.queueSection;
  }

  if (move.rulesSection !== null) {
    value.rulesSection = move.rulesSection;
  }

  return toBase64Url(JSON.stringify(value));
}

/** The link the banner's action follows: the new origin's home page with `#move=`. */
export function buildMoveLink(to: string, move: MoveData): string {
  return `${to}/#${MOVE_PARAMETER}${encodeMove(move)}`;
}

/** The link's sessions, or `null` for any fault: an entry the stored list would not keep, an id twice, too many. */
function parseMovedSessions(items: unknown): ListedSession[] | null {
  if (!Array.isArray(items) || items.length > MAX_LISTED_SESSIONS) {
    return null;
  }

  const seen = new Set<string>();
  const sessions: ListedSession[] = [];

  for (const item of items as unknown[]) {
    if (!isPlainObject(item)) {
      return null;
    }

    const id = own(item, 'id');
    const openedAt = own(item, 'openedAt');

    if (
      typeof id !== 'string' ||
      !SESSION_ID_PATTERN.test(id) ||
      !isTimeValue(openedAt) ||
      seen.has(id)
    ) {
      return null;
    }

    seen.add(id);
    sessions.push({ id, openedAt });
  }

  return sessions;
}

/** The link's keys, or `null` for any fault: a pair the key store would not keep, an id twice, too many. */
function parseMovedKeys(items: unknown): [string, string][] | null {
  if (!Array.isArray(items) || items.length > MAX_STORED_ACCESS_KEYS) {
    return null;
  }

  const seen = new Set<string>();
  const keys: [string, string][] = [];

  for (const item of items as unknown[]) {
    if (!isPlainObject(item)) {
      return null;
    }

    const id = own(item, 'id');
    const key = own(item, 'key');

    if (
      typeof id !== 'string' ||
      !SESSION_ID_PATTERN.test(id) ||
      !isAccessKey(key) ||
      seen.has(id)
    ) {
      return null;
    }

    seen.add(id);
    keys.push([id, key]);
  }

  return keys;
}

/** An optional field: absent is `null`, present must pass `valid`, else the link is refused. */
function optional<T>(
  record: Record<string, unknown>,
  name: string,
  valid: (value: unknown) => value is T,
): { ok: true; value: T | null } | { ok: false } {
  if (!Object.hasOwn(record, name)) {
    return { ok: true, value: null };
  }

  const value = record[name];

  return valid(value) ? { ok: true, value } : { ok: false };
}

function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'ru';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * What a decoded link holds, or `null` for any fault: not an object, another
 * version, `sessions` or `keys` missing or refused, an optional field of
 * another value. A field this version does not know is passed over, as the
 * stored formats pass over theirs.
 */
export function parseMoveValue(value: unknown): MoveData | null {
  if (!isPlainObject(value) || own(value, 'v') !== MOVE_FORMAT_VERSION) {
    return null;
  }

  const sessions = parseMovedSessions(own(value, 'sessions'));
  const keys = parseMovedKeys(own(value, 'keys'));
  const language = optional(value, 'language', isLanguage);
  const queueSection = optional(value, 'queueSection', isBoolean);
  const rulesSection = optional(value, 'rulesSection', isBoolean);

  if (sessions === null || keys === null || !language.ok || !queueSection.ok || !rulesSection.ok) {
    return null;
  }

  return {
    sessions,
    keys,
    language: language.value,
    queueSection: queueSection.value,
    rulesSection: rulesSection.value,
  };
}

/**
 * What an address's fragment holds for the move:
 *
 * - `none`: no fragment, or one that is not `move=` - a link with access, a
 *   request id - left to the page that reads it;
 * - `refused`: `move=` with anything a link does not hold (see the module);
 * - `move`: what the link carries.
 *
 * Bounded whatever the address's size: one search for `#`, a length check
 * before anything is decoded, then linear checks of at most
 * `MAX_MOVE_FRAGMENT_LENGTH` characters.
 */
export type MoveFragment =
  { kind: 'none' } | { kind: 'refused' } | { kind: 'move'; move: MoveData };

export function readMoveFragment(href: string): MoveFragment {
  const hash = href.indexOf('#');

  if (hash === -1 || !href.startsWith(MOVE_PARAMETER, hash + 1)) {
    return { kind: 'none' };
  }

  const encoded = href.slice(hash + 1 + MOVE_PARAMETER.length);

  if (encoded.length > MAX_MOVE_FRAGMENT_LENGTH || !BASE64URL.test(encoded)) {
    return { kind: 'refused' };
  }

  let value: unknown;

  try {
    const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/');

    value = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
  } catch {
    return { kind: 'refused' };
  }

  const move = parseMoveValue(value);

  return move === null ? { kind: 'refused' } : { kind: 'move', move };
}

/** Whether an address's fragment is a move link's, read or refused; cheap, for `hashchange`. */
export function holdsMoveFragment(href: string): boolean {
  const hash = href.indexOf('#');

  return hash !== -1 && href.startsWith(MOVE_PARAMETER, hash + 1);
}

/**
 * What a session page does on `hashchange` (issue #345): reads a key from the
 * fragment as on its first load (`takeKeyFromAddress`), except a move link's,
 * read or refused, which it leaves in the address and answers `move`. That
 * one is `main.tsx`'s: its own listener, in the same dispatch, loads the page
 * again so the link is read on arrival and taken out then. Taken out here,
 * as a fragment the page does not know, it would leave that load nothing to
 * read in a browser whose reload takes the address as it is by then. Every
 * other fragment - `#key=`, `#<request-id>`, a malformed one - goes to
 * `takeKeyFromAddress` unchanged.
 */
export function takeKeyUnlessMove(
  sessionId: string,
  storage: AccessKeyStorage | null | undefined,
  address: AddressBar,
): SessionLinkFragment | { kind: 'move' } {
  if (holdsMoveFragment(address.href)) {
    return { kind: 'move' };
  }

  return takeKeyFromAddress(sessionId, storage, address);
}

/** Takes a section state where this address stores none. */
function takeSection(storage: MoveStorage, key: string, open: boolean | null): void {
  if (open === null) {
    return;
  }

  try {
    if (parseQueueSectionOpen(storage.getItem(key)) === null) {
      storage.setItem(key, serializeQueueSectionOpen(open));
    }
  } catch {
    // Blocked or full: the section opens as it would have.
  }
}

/**
 * Adds what a link carries to this address's storage, only adding (see the
 * module): the keys, then the list, then the language and the section states
 * where none is stored. Answers how many of the link's sessions the list holds
 * afterwards and how many of those this browser holds a key for; none where
 * storage cannot be had.
 */
export function mergeMove(storage: MoveStorage | null, move: MoveData): MoveArrival {
  if (storage === null) {
    return { sessions: 0, privateSessions: 0 };
  }

  const listedIds = new Set(move.sessions.map((entry) => entry.id));
  const movedKeys = new Set(move.keys.map(([id]) => id));

  mergeMovedAccessKeys(storage, move.keys, (id) => listedIds.has(id));

  const came = mergeMovedSessions(storage, move.sessions, (id) => movedKeys.has(id)) ?? new Set();

  if (move.language !== null && readStoredLanguage(storage) === null) {
    storeLanguage(storage, move.language);
  }

  takeSection(storage, QUEUE_SECTION_KEY, move.queueSection);
  takeSection(storage, RULES_SECTION_KEY, move.rulesSection);

  const keys = loadAccessKeys(storage);

  return {
    sessions: came.size,
    privateSessions: [...came].filter((id) => keys.has(id)).length,
  };
}

/**
 * Reads a move link from the address, before the first render, and takes its
 * fragment out of the address whatever it held, adding no history entry; a
 * link that is read is merged (`mergeMove`). Answers what came, or `null` for
 * no link and for a refused one, which changed nothing.
 */
export function takeMoveFromAddress(
  storage: MoveStorage | null,
  address: AddressBar,
): MoveArrival | null {
  const href = address.href;
  const fragment = readMoveFragment(href);

  if (fragment.kind === 'none') {
    return null;
  }

  address.replace(withoutFragment(href));

  return fragment.kind === 'move' ? mergeMove(storage, fragment.move) : null;
}

/** The toast an arrival shows, naming the old address's host where the build has one. */
export function moveArrivedToast(arrival: MoveArrival, move: BuiltMove | null): Phrase {
  const from = move === null ? null : originHost(move.from);

  return (m) => m.move.arrived(arrival.sessions, arrival.privateSessions, from);
}
