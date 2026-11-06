/**
 * The search of raw requests, `POST /api/sessions/:sessionId/requests/search`
 * (D191): what its body must be, how many searches one process runs at once,
 * and which count a query of requests takes its place in (D250). All are
 * pure, so the rules can be tested without a server.
 *
 * The order of the checks is the response change's (D104, D150): the media
 * type is settled before `parseSearchBody` runs, Fastify's `bodyLimit` answers
 * an oversized body with `413` / `1004`, the shape of the request body is
 * `400` / `1006`, and every rule about `words` is `400` / `1010`. A message
 * names the rule and never echoes a word (D106): a word is what the user is
 * looking for in captured data, and it travels in the body precisely so that
 * no log line and no error can hold it.
 */
import {
  MAX_CONCURRENT_HEADER_QUERIES,
  MAX_CONCURRENT_SEARCHES,
  SEARCH_MAX_WORD_BYTES,
  SEARCH_MAX_WORDS,
  SEARCH_MIN_WORD_BYTES,
} from '@webhook-inspector/shared';
import { invalidSearchWords, malformedRequestBody } from '../../errors/app-error.ts';
import { createSlots, type Slots } from '../../lib/slots.ts';
import { isPlainObject } from '../../lib/plain-object.ts';
import type { ListQuery } from './list-query.ts';

const WORDS_RULE = `words must be an array of 1 to ${SEARCH_MAX_WORDS} strings`;
const WORD_RULE = `Each word must be ${SEARCH_MIN_WORD_BYTES} to ${SEARCH_MAX_WORD_BYTES} bytes of UTF-8`;
const KEYS_RULE = 'The request body may contain no key other than "words"';

/**
 * Turns the search body into the bytes to look for, one buffer per word, in
 * the order given.
 *
 * `rawBody` is the request body as text, never as a parsed object, so that an
 * absent, empty or unparseable body is a `1006` rather than a `500` (D104).
 *
 * A word is the UTF-8 encoding of its string. An unpaired surrogate has none,
 * and is encoded as U+FFFD, which is what `TextEncoder` does in the browser
 * that counted the bytes; nothing is refused for it.
 *
 * Every check is bounded by a small constant however large the body is: the
 * array's length is read before any entry, and a string longer than the byte
 * limit in UTF-16 units is refused without being encoded, since no encoding of
 * it can be shorter.
 */
export function parseSearchBody(rawBody: string | undefined): Buffer[] {
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

  const words = Object.hasOwn(parsed, 'words') ? parsed.words : undefined;

  if (!Array.isArray(words) || words.length < 1 || words.length > SEARCH_MAX_WORDS) {
    throw invalidSearchWords(WORDS_RULE);
  }

  const encoded: Buffer[] = [];

  for (const word of words as unknown[]) {
    if (typeof word !== 'string') {
      throw invalidSearchWords(WORDS_RULE);
    }

    if (word.length > SEARCH_MAX_WORD_BYTES) {
      throw invalidSearchWords(WORD_RULE);
    }

    const bytes = Buffer.from(word, 'utf8');

    if (bytes.length < SEARCH_MIN_WORD_BYTES || bytes.length > SEARCH_MAX_WORD_BYTES) {
      throw invalidSearchWords(WORD_RULE);
    }

    encoded.push(bytes);
  }

  // Unknown keys last, as the other two bodies report them (D104): a key this
  // version does not know is refused rather than ignored, so that one a later
  // version gives a meaning to is never silently dropped by this one.
  for (const key in parsed) {
    if (key !== 'words') {
      throw invalidSearchWords(KEYS_RULE);
    }
  }

  return encoded;
}

/** The searches one process may run at once (D191): a count of `Slots`. */
export type SearchSlots = Slots;

/**
 * At most `limit` searches at once, and no queue: a search that finds no slot
 * is refused at once (`429` / `1012`), so a burst of slow searches can hold at
 * most `limit` database connections and never the rest of the pool, which the
 * list, the captures and the readiness probe share.
 *
 * The count lives in the process, so each process allows `limit` of its own
 * (D191): there is one outside a rollout (`replicas: 1`), and two for its
 * seconds (D221).
 */
export function createSearchSlots(limit: number = MAX_CONCURRENT_SEARCHES): SearchSlots {
  return createSlots(limit);
}

/**
 * The two counts a query of requests takes its place from (D250): the
 * search's, for a query with a body condition, which reads stored bodies as a
 * search reads raw requests (D196); and one of its own for a query with none,
 * header conditions alone or no condition at all, which reads no body.
 */
export interface QuerySlots {
  search: SearchSlots;
  headerOnly: Slots;
}

/**
 * The search's count and a count of `headerOnly` header-only queries, each
 * refusing at once, never queueing. Created once per process, as the
 * search's (D191, D221); a test passes smaller ones.
 */
export function createQuerySlots(
  search: SearchSlots = createSearchSlots(),
  headerOnly: number = MAX_CONCURRENT_HEADER_QUERIES,
): QuerySlots {
  return { search, headerOnly: createSlots(headerOnly) };
}

/**
 * The count a query takes its place in (D250): the search's when it has a
 * body condition, its own when it has none. A query's resumption asks again
 * with the same query, so it takes a place of the same kind.
 */
export function slotsForQuery(query: Pick<ListQuery, 'bodies'>, slots: QuerySlots): Slots {
  return query.bodies.length === 0 ? slots.headerOnly : slots.search;
}
