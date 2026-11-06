/**
 * What a list of requests may be asked for (D196): the query parameters of
 * `GET /api/sessions/:sessionId/requests` and the body of
 * `POST /api/sessions/:sessionId/requests/query`. Both are parsed into the one
 * `ListQuery` the repository reads, so `after`, `since`, `limit`, `order` and
 * `include` mean the same on both routes. `wait`, the long-poll, is the GET's
 * alone (D200): the body has no such key, and refuses one as unknown. Pure, so
 * every rule is tested without a server.
 *
 * Every refusal is `400` / `1013` with a message that names the parameter or
 * the field and the rule, and never a value (D106): the header and body
 * conditions are what the user is looking for in captured data, and they
 * travel in a body precisely so that no log line and no error can hold them.
 * Two answers are not this code: a body that is not a JSON object is `1006`,
 * as for every route that reads one (D104), and an `after` that cannot be a
 * request id is `404` / `1003`, which the service answers once the session id
 * has been checked.
 *
 * Every check is bounded by a small constant however large the input is: an
 * array's length is read before any of its entries, and a string longer than
 * its byte limit in UTF-16 units is refused without being encoded, since no
 * encoding of it can be shorter.
 */
import {
  REQUEST_LIST_INCLUDES,
  REQUEST_LIST_MAX_LIMIT,
  REQUEST_LIST_MAX_WAIT_SECONDS,
  REQUEST_LIST_MAX_WITH_BODIES,
  REQUEST_LIST_ORDERS,
  REQUEST_QUERY_MAX_CONDITIONS,
  REQUEST_QUERY_MAX_HEADER_NAME_BYTES,
  REQUEST_QUERY_MAX_HEADER_VALUE_BYTES,
  SEARCH_MAX_WORD_BYTES,
  SEARCH_MIN_WORD_BYTES,
  type RequestListInclude,
  type RequestListOrder,
} from '@webhook-inspector/shared';
import { invalidListQuery, malformedRequestBody } from '../../errors/app-error.ts';
import { isPlainObject } from '../../lib/plain-object.ts';

/** A header condition, its name already folded to ASCII lower case. */
export interface HeaderCondition {
  name: string;
  value: string;
}

/** What the repository lists, and how. */
export interface ListQuery {
  includeHeaders: boolean;
  includeBody: boolean;
  /** `null`: no cap beyond the 1000 a session holds. */
  limit: number | null;
  order: RequestListOrder;
  /**
   * The request id as given. Its shape is checked by the service, after the
   * session id's, so that a malformed one is `404` / `1003` like an unknown one.
   */
  after: string | null;
  /**
   * The instant `since` names, cut to the microsecond PostgreSQL stores, as a
   * `timestamptz` literal: a request is listed when its stored `received_at`
   * is strictly later (`sinceBound`).
   */
  receivedAfter: string | null;
  headers: HeaderCondition[];
  /** The UTF-8 bytes each body condition looks for. */
  bodies: Buffer[];
  /**
   * How long an empty answer may be held for a request to arrive, in seconds,
   * 1 to `REQUEST_LIST_MAX_WAIT_SECONDS`; `null`: answered at once (D200).
   */
  wait: number | null;
}

/** The list as it is answered without a parameter: today's list, unchanged. */
export const PLAIN_LIST: ListQuery = {
  includeHeaders: false,
  includeBody: false,
  limit: null,
  order: 'desc',
  after: null,
  receivedAfter: null,
  headers: [],
  bodies: [],
  wait: null,
};

const PARAMETERS = ['include', 'limit', 'order', 'after', 'since', 'wait'] as const;

type Parameter = (typeof PARAMETERS)[number];

const BODY_KEYS = ['headers', 'body', 'after', 'since', 'limit', 'order', 'include'];

export const RULES = {
  unknownParameter:
    'Unknown query parameter: the list takes only include, limit, order, after, since and wait',
  repeated: (name: Parameter) => `${name} may be given only once`,
  includeParameter: 'include must be headers, body, or both separated by a comma',
  includeField: 'include must be an array of "headers", "body" or both, each at most once',
  limit: `limit must be an integer from 1 to ${REQUEST_LIST_MAX_LIMIT}`,
  limitWithBody: `limit must be an integer from 1 to ${REQUEST_LIST_MAX_WITH_BODIES} when body is included`,
  order: 'order must be asc or desc',
  since:
    'since must be a date-time with a zone offset, such as 2026-10-04T09:00:00Z or 2026-10-04T12:00:00+03:00',
  afterField: 'after must be a string: the id of a request',
  afterWithSince: 'after and since cannot be used together',
  wait: `wait must be an integer number of seconds from 1 to ${REQUEST_LIST_MAX_WAIT_SECONDS}`,
  waitWithSince: 'wait and since cannot be used together',
  headers: `headers must be an array of at most ${REQUEST_QUERY_MAX_CONDITIONS} conditions`,
  header: (index: number) =>
    `headers[${index}] must be an object with a name and a value, both strings, and no other key`,
  headerName: (index: number) =>
    `headers[${index}].name must be 1 to ${REQUEST_QUERY_MAX_HEADER_NAME_BYTES} bytes of UTF-8 without U+0000`,
  headerValue: (index: number) =>
    `headers[${index}].value must be 0 to ${REQUEST_QUERY_MAX_HEADER_VALUE_BYTES} bytes of UTF-8 without U+0000`,
  body: `body must be an array of at most ${REQUEST_QUERY_MAX_CONDITIONS} strings`,
  bodyItem: (index: number) =>
    `body[${index}] must be ${SEARCH_MIN_WORD_BYTES} to ${SEARCH_MAX_WORD_BYTES} bytes of UTF-8`,
  conditions: `headers and body may hold at most ${REQUEST_QUERY_MAX_CONDITIONS} conditions together`,
  keys: 'The request body may contain no key other than headers, body, after, since, limit, order and include',
} as const;

/** The query string of a request target: everything after the first `?`, or nothing. */
export function queryStringOf(url: string): string {
  const mark = url.indexOf('?');

  return mark < 0 ? '' : url.slice(mark + 1);
}

/**
 * Percent-decodes a key or a value. `+` stays a `+`, as RFC 3986 has it: no
 * parameter holds a space, and a zone offset such as `+03:00` written into the
 * URL unencoded then means what it says. An escape that does not decode to
 * UTF-8 leaves the text as it was, so it keeps its `%`, which no valid key or
 * value holds: it is refused by the rule of what it was given for.
 */
function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function isParameter(name: string): name is Parameter {
  return (PARAMETERS as readonly string[]).includes(name);
}

function includeFrom(items: readonly unknown[], rule: string): Set<RequestListInclude> {
  const included = new Set<RequestListInclude>();

  // Longer than the set it is drawn from: something in it is unknown or repeated.
  if (items.length < 1 || items.length > REQUEST_LIST_INCLUDES.length) {
    throw invalidListQuery(rule);
  }

  for (const item of items) {
    if (
      typeof item !== 'string' ||
      !(REQUEST_LIST_INCLUDES as readonly string[]).includes(item) ||
      included.has(item as RequestListInclude)
    ) {
      throw invalidListQuery(rule);
    }

    included.add(item as RequestListInclude);
  }

  return included;
}

function limitRule(includeBody: boolean): string {
  return includeBody ? RULES.limitWithBody : RULES.limit;
}

function maxLimit(includeBody: boolean): number {
  return includeBody ? REQUEST_LIST_MAX_WITH_BODIES : REQUEST_LIST_MAX_LIMIT;
}

/** Whether `value` is one of the two orders; `list_requests` over MCP checks it too (D203). */
export function isOrder(value: unknown): value is RequestListOrder {
  return typeof value === 'string' && (REQUEST_LIST_ORDERS as readonly string[]).includes(value);
}

/** A date-time as RFC 3339 writes one: a zone offset is required, `+03:00` or `Z`. */
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

const EARLIEST = Date.parse('0001-01-01T00:00:00.000Z');
const LATEST = Date.parse('9999-12-31T23:59:59.999Z');

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/**
 * The instant `since` names, in UTC to the microsecond, as a `timestamptz`
 * literal, or `null` when `since` is not a valid date-time with a zone offset.
 *
 * A request is listed when its stored `received_at` is strictly later, at the
 * microsecond PostgreSQL stores (D196): `since=…09:00:00.123100Z` keeps a
 * request stored at `.123456`. A fraction finer than a microsecond is cut:
 * for a stored time `t`, a whole number of microseconds, `t > since` holds
 * exactly when `t > since cut to its microsecond`. `receivedAt` shows
 * milliseconds only, so a request's own `receivedAt` given back may list it
 * again; `after` is how a client continues without repeats.
 *
 * JavaScript's `Date` keeps milliseconds, so it computes the instant to the
 * millisecond, offset applied, and the fraction's fourth to sixth digits are
 * written after it: an offset is whole minutes and cannot change them.
 *
 * Every field is checked against the calendar - month, day of that month,
 * hour, minute, second, the offset's hours and minutes - so that nothing rolls
 * over into another date. A leap second is refused: no stored time holds one.
 * An instant outside the years 1 to 9999 is an infinity, which PostgreSQL
 * reads and which keeps every request or none.
 */
export function sinceBound(value: string): string | null {
  const match = DATE_TIME.exec(value);

  if (!match) {
    return null;
  }

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const fraction = match[7] ?? '';
  const sign = match[8] === '-' ? -1 : 1;
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  ) {
    return null;
  }

  const digits = fraction.padEnd(6, '0');
  // `setUTCFullYear`, not `Date.UTC`, which reads the years 0 to 99 as 1900 to 1999.
  const date = new Date(0);

  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number(digits.slice(0, 3)));

  const instant = date.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000;

  if (instant < EARLIEST) {
    return '-infinity';
  }

  if (instant > LATEST) {
    return 'infinity';
  }

  // `…SS.mmmZ` with the microseconds written before the `Z`.
  return `${new Date(instant).toISOString().slice(0, -1)}${digits.slice(3, 6)}Z`;
}

/**
 * The query parameters of `GET /api/sessions/:sessionId/requests`, from the
 * query string as received (`rawQuery`, without its `?`).
 *
 * The query string is read here rather than from Fastify's parsed object, so
 * that a repeated parameter is seen as repeated and `+` keeps its meaning.
 * An empty segment, such as the one a trailing `&` leaves, carries nothing and
 * is skipped. The order of the checks is fixed, so one query string always
 * gets the same answer (D106): an unknown or a repeated parameter, in the
 * order they come; then the values, as `include`, `limit`, `order`, `since`,
 * `wait`; then `after` with `since`; then `wait` with `since` (D200).
 */
export function parseListQueryString(rawQuery: string): ListQuery {
  const given = new Map<Parameter, string>();

  for (const segment of rawQuery.split('&')) {
    if (segment === '') {
      continue;
    }

    const equals = segment.indexOf('=');
    const name = decode(equals < 0 ? segment : segment.slice(0, equals));
    const value = equals < 0 ? '' : decode(segment.slice(equals + 1));

    if (!isParameter(name)) {
      throw invalidListQuery(RULES.unknownParameter);
    }

    if (given.has(name)) {
      throw invalidListQuery(RULES.repeated(name));
    }

    given.set(name, value);
  }

  const include = given.get('include');
  const included =
    include === undefined
      ? new Set<RequestListInclude>()
      : includeFrom(include.split(','), RULES.includeParameter);
  const includeBody = included.has('body');

  let limit: number | null = includeBody ? REQUEST_LIST_MAX_WITH_BODIES : null;
  const limitText = given.get('limit');

  if (limitText !== undefined) {
    // Decimal digits with no sign, no leading zero, no point and no exponent:
    // `0`, `-1`, `1.5`, `1e3` and `+5` are all refused.
    if (!/^[1-9][0-9]{0,3}$/.test(limitText) || Number(limitText) > maxLimit(includeBody)) {
      throw invalidListQuery(limitRule(includeBody));
    }

    limit = Number(limitText);
  }

  const order = given.get('order') ?? 'desc';

  if (!isOrder(order)) {
    throw invalidListQuery(RULES.order);
  }

  // `after` is taken as it is: its shape is the service's to check.
  const since = given.get('since');
  const receivedAfter = since === undefined ? null : sinceBound(since);

  if (since !== undefined && receivedAfter === null) {
    throw invalidListQuery(RULES.since);
  }

  const waitText = given.get('wait');
  let wait: number | null = null;

  if (waitText !== undefined) {
    // Seconds in decimal digits with no sign, no leading zero, no point and no
    // exponent, as `limit` is written: `0`, `-1`, `1.5`, `1e1`, `+5`, `05` and
    // ` 5` are all refused, and so is anything above the cap rather than cut
    // to it (D200). The digits are not counted: the cap alone bounds the
    // value, so raising it needs no change here, and a run too long for a
    // number reads as `Infinity`, which is above it.
    if (!/^[1-9][0-9]*$/.test(waitText) || Number(waitText) > REQUEST_LIST_MAX_WAIT_SECONDS) {
      throw invalidListQuery(RULES.wait);
    }

    wait = Number(waitText);
  }

  const after = given.get('after') ?? null;

  if (after !== null && since !== undefined) {
    throw invalidListQuery(RULES.afterWithSince);
  }

  // `since` is a time on the client's clock, which may differ from the
  // server's: a wait for what arrives after it could miss a webhook (D200).
  if (wait !== null && since !== undefined) {
    throw invalidListQuery(RULES.waitWithSince);
  }

  return {
    includeHeaders: included.has('headers'),
    includeBody,
    limit,
    order,
    after,
    receivedAfter,
    headers: [],
    bodies: [],
    wait,
  };
}

/** ASCII letters to lower case and nothing else: `İ` and `K` (Kelvin) stay what they are. */
export function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** Whether `text` is `min` to `max` bytes of UTF-8, measured without encoding a string far too long. */
function hasUtf8Bytes(text: string, min: number, max: number): boolean {
  if (text.length > max) {
    return false;
  }

  const bytes = Buffer.byteLength(text, 'utf8');

  return bytes >= min && bytes <= max;
}

/** The header conditions of a query, by its rules; `list_requests` over MCP takes them too (D203). */
export function parseHeaderConditions(value: unknown): HeaderCondition[] {
  if (!Array.isArray(value) || value.length > REQUEST_QUERY_MAX_CONDITIONS) {
    throw invalidListQuery(RULES.headers);
  }

  return (value as unknown[]).map((entry, index) => {
    if (
      !isPlainObject(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.value !== 'string' ||
      !Object.hasOwn(entry, 'name') ||
      !Object.hasOwn(entry, 'value') ||
      Object.keys(entry).length !== 2
    ) {
      throw invalidListQuery(RULES.header(index));
    }

    // PostgreSQL text holds no U+0000, and no stored header does: Node's
    // parser refuses one in a name and in a value.
    if (
      !hasUtf8Bytes(entry.name, 1, REQUEST_QUERY_MAX_HEADER_NAME_BYTES) ||
      entry.name.includes('\u0000')
    ) {
      throw invalidListQuery(RULES.headerName(index));
    }

    if (
      !hasUtf8Bytes(entry.value, 0, REQUEST_QUERY_MAX_HEADER_VALUE_BYTES) ||
      entry.value.includes('\u0000')
    ) {
      throw invalidListQuery(RULES.headerValue(index));
    }

    return { name: asciiLowerCase(entry.name), value: entry.value };
  });
}

/** The body conditions of a query, by its rules; `list_requests` over MCP takes them too (D203). */
export function parseBodyConditions(value: unknown): Buffer[] {
  if (!Array.isArray(value) || value.length > REQUEST_QUERY_MAX_CONDITIONS) {
    throw invalidListQuery(RULES.body);
  }

  return (value as unknown[]).map((entry, index) => {
    if (typeof entry !== 'string') {
      throw invalidListQuery(RULES.body);
    }

    // An unpaired surrogate is encoded as U+FFFD, as a search word is (D191).
    if (!hasUtf8Bytes(entry, SEARCH_MIN_WORD_BYTES, SEARCH_MAX_WORD_BYTES)) {
      throw invalidListQuery(RULES.bodyItem(index));
    }

    return Buffer.from(entry, 'utf8');
  });
}

/**
 * The body of `POST /api/sessions/:sessionId/requests/query`.
 *
 * `rawBody` is the request body as text, never as a parsed object, so that an
 * absent, empty or unparseable body is a `1006` rather than a `500` (D104).
 * The fields are checked in a fixed order - `headers`, `body`, their number
 * together, `include`, `limit`, `order`, `after`, `since`, then `after` with
 * `since` - and an unknown key last, as the search reports one (D191). Every
 * key is optional; a key that is present must have its type, and `null` is
 * not an absent key.
 */
export function parseQueryBody(rawBody: string | undefined): ListQuery {
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

  const field = (key: string): unknown => (Object.hasOwn(parsed, key) ? parsed[key] : undefined);
  const has = (key: string): boolean => Object.hasOwn(parsed, key);

  const headers = has('headers') ? parseHeaderConditions(field('headers')) : [];
  const bodies = has('body') ? parseBodyConditions(field('body')) : [];

  if (headers.length + bodies.length > REQUEST_QUERY_MAX_CONDITIONS) {
    throw invalidListQuery(RULES.conditions);
  }

  const include = field('include');
  let included = new Set<RequestListInclude>();

  if (has('include')) {
    if (!Array.isArray(include)) {
      throw invalidListQuery(RULES.includeField);
    }

    // An empty array asks for nothing beyond the metadata.
    included = include.length === 0 ? included : includeFrom(include, RULES.includeField);
  }

  const includeBody = included.has('body');
  let limit: number | null = includeBody ? REQUEST_LIST_MAX_WITH_BODIES : null;

  if (has('limit')) {
    const value = field('limit');

    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > maxLimit(includeBody)
    ) {
      throw invalidListQuery(limitRule(includeBody));
    }

    limit = value;
  }

  const order = has('order') ? field('order') : 'desc';

  if (!isOrder(order)) {
    throw invalidListQuery(RULES.order);
  }

  let after: string | null = null;

  if (has('after')) {
    const value = field('after');

    if (typeof value !== 'string') {
      throw invalidListQuery(RULES.afterField);
    }

    after = value;
  }

  let receivedAfter: string | null = null;

  if (has('since')) {
    const since = field('since');

    receivedAfter = typeof since === 'string' ? sinceBound(since) : null;

    if (receivedAfter === null) {
      throw invalidListQuery(RULES.since);
    }
  }

  if (after !== null && has('since')) {
    throw invalidListQuery(RULES.afterWithSince);
  }

  // Unknown keys last, as the other bodies report them (D104, D191): a key
  // this version does not know is refused rather than ignored, so that one a
  // later version gives a meaning to is never silently dropped by this one.
  for (const key in parsed) {
    if (!BODY_KEYS.includes(key)) {
      throw invalidListQuery(RULES.keys);
    }
  }

  return {
    includeHeaders: included.has('headers'),
    includeBody,
    limit,
    order,
    after,
    receivedAfter,
    headers,
    bodies,
    wait: null,
  };
}
