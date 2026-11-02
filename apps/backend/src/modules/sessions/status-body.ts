/**
 * The body of the status read, `POST /api/sessions/status` (D199): what it
 * must be. Pure, so the rules can be tested without a server.
 *
 * The order of the checks is the other JSON bodies' (D104, D150, D191): the
 * media type is settled before `parseStatusBody` runs, Fastify's `bodyLimit`
 * answers an oversized body with `413` / `1004`, the shape of the request body
 * is `400` / `1006`, and every rule about `ids` is `400` / `1014`. A message
 * names the rule and never quotes an id or a key (D106): an id opens a public
 * session (D004), a key a private one (D245), and both travel in the body
 * precisely so that no URL and no log line holds them.
 *
 * `accessKeys` (D245) carries the access key of each private session the read
 * asks about, beside its id: `{ "<id>": "<key>" }`. Optional, so every body
 * valid before stays valid and means what it meant. Documented since 1.11.0,
 * when a private session can be created (D253); `KEYS_RULE` names it since.
 * A malformed value stays a strict `1014`: relaxing it later would be an
 * addition, where tightening a relaxed rule would break a client (D212).
 */
import { MAX_SESSION_STATUS_IDS, SESSION_ID_PATTERN } from '@webhook-inspector/shared';
import { invalidSessionIds, malformedRequestBody } from '../../errors/app-error.ts';

export const IDS_RULE = `ids must be an array of 1 to ${MAX_SESSION_STATUS_IDS} session ids`;
export const ID_RULE = 'Each id must be a session id: 43 characters of A-Z, a-z, 0-9, _ and -';
export const REPEATED_ID_RULE = 'ids must not hold the same id twice';
export const KEYS_RULE = 'The request body may contain no key other than "ids" and "accessKeys"';
export const ACCESS_KEYS_RULE =
  'accessKeys must map ids from ids to access keys: 43 characters of A-Z, a-z, 0-9, _ and -';

/** What the status read is asked: the ids, in order, and the key sent beside each keyed one. */
export interface StatusBody {
  ids: string[];
  /** Id to key, for the ids a key was sent with; empty when none was. */
  accessKeys: Map<string, string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turns the status body into the ids to read, in the order given, and the
 * access keys sent beside them.
 *
 * `rawBody` is the request body as text, never as a parsed object, so that an
 * absent, empty or unparseable body is a `1006` rather than a `500` (D104).
 *
 * Every check is bounded by a small constant however large the body is: the
 * array's length is read before any entry, an entry is checked against the
 * anchored pattern of `SESSION_ID_PATTERN`, which fails within 44 characters
 * of any string, and the repeat check holds at most 50 ids. `accessKeys` is
 * refused once it holds more entries than `ids`, so it is read no further
 * than 50 of them, each value checked against the same anchored pattern.
 */
export function parseStatusBody(rawBody: string | undefined): StatusBody {
  if (rawBody === undefined) {
    throw malformedRequestBody();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    // A syntax error, and a nesting too deep for the parser's stack.
    throw malformedRequestBody();
  }

  if (!isPlainObject(parsed)) {
    throw malformedRequestBody();
  }

  const ids = Object.hasOwn(parsed, 'ids') ? parsed.ids : undefined;

  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_SESSION_STATUS_IDS) {
    throw invalidSessionIds(IDS_RULE);
  }

  for (const id of ids as unknown[]) {
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
      throw invalidSessionIds(ID_RULE);
    }
  }

  const distinct = new Set(ids as string[]);

  if (distinct.size !== ids.length) {
    throw invalidSessionIds(REPEATED_ID_RULE);
  }

  const accessKeys = Object.hasOwn(parsed, 'accessKeys')
    ? parseAccessKeys(parsed.accessKeys, distinct)
    : new Map<string, string>();

  // Unknown keys last, as the other bodies report them (D104): a key this
  // version does not know is refused rather than ignored, so that one a later
  // version gives a meaning to is never silently dropped by this one.
  for (const key in parsed) {
    if (key !== 'ids' && key !== 'accessKeys') {
      throw invalidSessionIds(KEYS_RULE);
    }
  }

  return { ids: ids as string[], accessKeys };
}

/**
 * `accessKeys`: an object whose every name is one of `ids` and whose every
 * value is a string of a key's shape, a session id's (D161, D245). An empty
 * object sends no key. Anything else is `400` / `1014` with
 * `ACCESS_KEYS_RULE`, which quotes neither an id nor a key (D106). A key of
 * the right shape that opens nothing is not refused here: its session is
 * answered `not_found`, as one that does not exist.
 */
function parseAccessKeys(value: unknown, ids: ReadonlySet<string>): Map<string, string> {
  if (!isPlainObject(value)) {
    throw invalidSessionIds(ACCESS_KEYS_RULE);
  }

  const accessKeys = new Map<string, string>();

  for (const id in value) {
    const key = value[id];

    if (
      accessKeys.size === ids.size ||
      !Object.hasOwn(value, id) ||
      !ids.has(id) ||
      typeof key !== 'string' ||
      !SESSION_ID_PATTERN.test(key)
    ) {
      throw invalidSessionIds(ACCESS_KEYS_RULE);
    }

    accessKeys.set(id, key);
  }

  return accessKeys;
}
