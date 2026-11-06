/**
 * Validation of the response configuration sent to `POST /api/sessions`, of
 * the change sent to `PUT /api/sessions/:sessionId/response`, of the
 * response queue sent to `PUT /api/sessions/:sessionId/queue` and of the
 * response rules sent to `PUT /api/sessions/:sessionId/rules`. All run the
 * very same `response` validator, so a configuration one of them accepts the
 * others accept too, and a rejection carries the same `1005` rule on each, a
 * step's or a rule's message naming its place (D150, D205, D246). The
 * lifetime a creation may
 * carry, `expiresInSeconds`, is checked here too, under the same `1005` (D220),
 * and so are its idle window, `expiresAfterIdleSeconds` (D242), and whether it
 * keeps the sender's address, `storeSourceIp` (D243), and whether it is
 * private, `private` (D253).
 *
 * This is the security boundary of v0.3.0: a gap in header validation is a
 * response-splitting or open-redirect hole rather than a cosmetic defect, so
 * everything is checked against the raw values the caller sent and nothing is
 * normalised on the way in.
 *
 * The order of the checks is normative (D104): the media type is settled before
 * this function runs, Fastify's `bodyLimit` answers an oversized body with
 * `413` / `1004`, the shape of the request body is `400` / `1006`, and every
 * rule of the limits table is `400` / `1005`. Within `1005` the checks follow
 * the order of the rows in that table, because only one message can be
 * returned. A message names the field and the rule it broke and never echoes
 * the offending value (D106).
 */
import {
  HEADER_NAME_PATTERN,
  HEADER_VALUE_MAX_CODE,
  HEADER_VALUE_MIN_CODE,
  HEADER_VALUE_TAB_CODE,
  LOCATION_STATUS_MAX,
  LOCATION_STATUS_MIN,
  LOCATION_TARGET_PREFIX,
  locationHeaderProblem,
  MAX_HEADER_BLOCK_BYTES,
  MAX_HEADER_NAME_BYTES,
  MAX_HEADER_VALUE_BYTES,
  MAX_QUEUE_STEPS,
  MAX_RESPONSE_BODY_BYTES,
  MAX_RESPONSE_DELAY_MS,
  MAX_RESPONSE_HEADERS,
  MAX_RESPONSE_RULES,
  MAX_RULE_PATH_BYTES,
  RESERVED_RESPONSE_HEADERS,
  RESERVED_RESPONSE_HEADER_PREFIX,
  RESPONSE_RULE_METHODS,
  RESPONSE_STATUS_MAX,
  RESPONSE_STATUS_MIN,
  SESSION_IDLE_DAYS,
  SESSION_IDLE_WINDOW_MAX_SECONDS,
  SESSION_IDLE_WINDOW_MIN_SECONDS,
  SESSION_LIFETIME_MAX_SECONDS,
  SESSION_LIFETIME_MIN_SECONDS,
  STATUSES_WITHOUT_BODY,
  type ResponseConfig,
  type ResponseRule,
} from '@webhook-inspector/shared';
import {
  templateProblem,
  TEMPLATE_PLACEHOLDERS,
  type TemplateProblem,
} from '@webhook-inspector/shared/response-template';
import {
  type AppError,
  invalidResponseConfig,
  malformedRequestBody,
} from '../../errors/app-error.ts';
import { isPlainObject } from '../../lib/plain-object.ts';
import type { ResponseChange } from './repository.ts';

const TOP_LEVEL_KEYS = [
  'response',
  'queue',
  'expiresInSeconds',
  'expiresAfterIdleSeconds',
  'storeSourceIp',
  'rules',
  'private',
];
const CHANGE_KEYS = ['mode', 'response'];
const RESPONSE_KEYS = ['status', 'headers', 'body', 'delayMs', 'template'];
const QUEUE_KEYS = ['steps'];
const RULES_KEYS = ['rules'];
const RULE_KEYS = ['method', 'path', 'response'];

const NUL = '\x00';

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * A `1005` about the value at `field`, such as `rules[1].path`: the message is
 * `field` and the rule it broke, and `field` is answered beside it (D257).
 * `field` is made of the keys the API defines and of positions only, never of
 * a key or a value the client sent (D106).
 */
function refuse(field: string, rule: string): AppError {
  return invalidResponseConfig(`${field} ${rule}`, field);
}

/**
 * A `1005` about a header pair's name or value: the message reads
 * `<pair> name …` or `<pair> value …`, the field is `<pair>[0]` or
 * `<pair>[1]` (D257).
 */
function refusePairPart(pair: string, part: 'name' | 'value', rule: string): AppError {
  return invalidResponseConfig(`${pair} ${part} ${rule}`, `${pair}[${part === 'name' ? 0 : 1}]`);
}

/**
 * What a creation asks for: the session's response, `null` for the default,
 * the steps of its response queue, `null` for none (D205), how it expires
 * (`SessionExpiry`), whether its captures keep the sender's address, `true`
 * unless the body says `false` (D243), its response rules, `[]` for none
 * (D246), and whether it is private, `false` unless the body says `true`
 * (D253): only then does the route read the call's `Authorization`.
 */
export interface CreateSessionRequest extends SessionExpiry {
  response: ResponseConfig | null;
  queue: ResponseConfig[] | null;
  storeSourceIp: boolean;
  rules: ResponseRule[];
  private: boolean;
}

/**
 * How a creation asks its session to expire: with a lifetime in seconds, the
 * fixed end no use moves (D220), or with an idle window in seconds, which
 * every use slides (D242) - never both - or with neither, `null` and `null`,
 * for a session that expires `SESSION_IDLE_DAYS` after its last use.
 */
export interface SessionExpiry {
  expiresInSeconds: number | null;
  expiresAfterIdleSeconds: number | null;
}

/** The rule of `expiresInSeconds`, which every refusal of it states (D220). */
export const LIFETIME_RULE = `expiresInSeconds must be an integer from ${SESSION_LIFETIME_MIN_SECONDS} to ${SESSION_LIFETIME_MAX_SECONDS}`;

/** The rule of `expiresAfterIdleSeconds`, which every refusal of it states (D242). */
export const IDLE_WINDOW_RULE = `expiresAfterIdleSeconds must be an integer from ${SESSION_IDLE_WINDOW_MIN_SECONDS} to ${SESSION_IDLE_WINDOW_MAX_SECONDS}`;

/** The refusal of both expiry keys at once (D242): a session either slides or does not. */
export const ONE_EXPIRY_RULE =
  'expiresInSeconds and expiresAfterIdleSeconds cannot be given together: a session either ends a fixed time after its creation or expires a time after its last use';

/** The rule of `storeSourceIp`, which every refusal of it states (D243). */
export const STORE_SOURCE_IP_RULE = 'storeSourceIp must be true or false';

/** The rule of `private`, which every refusal of it states (D253). */
export const PRIVATE_RULE = 'private must be true or false';

/**
 * The refusal of a private creation whose `Authorization` carries no key
 * (D253): another scheme, an empty `Bearer`, a value not of a key's shape or
 * too long. Names the rule, never the value (D106).
 */
export const CREATION_KEY_RULE =
  'With "private": true, Authorization must be Bearer and an access key of 43 characters of A-Z, a-z, 0-9, _ and -, or be left out for the server to draw one';

/** The refusal of any other key at the top level of a create body. */
export const UNKNOWN_CREATE_KEY_RULE =
  'The request body may contain no key other than "response", "queue", "expiresInSeconds", "expiresAfterIdleSeconds", "storeSourceIp", "rules" and "private"';

/**
 * Turns the create body into the effective response configuration - `null`
 * for a default session - the queue it starts with, if any (D205), the
 * lifetime (D220) or the idle window (D242) it is created with, if any,
 * whether its captures keep the sender's address (D243), the response
 * rules it starts with, if any (D246), and whether it is private (D253).
 *
 * `rawBody` is the request body as text, never as a parsed object: parsing is
 * done here so that an empty or unparseable body is a `1006` rather than the
 * `500` Fastify's own JSON parser produced before this release (D104).
 */
export function parseCreateSessionBody(rawBody: string | undefined): CreateSessionRequest {
  // No body at all: the one-click create, which this release does not touch.
  if (rawBody === undefined) {
    return {
      response: null,
      queue: null,
      expiresInSeconds: null,
      expiresAfterIdleSeconds: null,
      storeSourceIp: true,
      rules: [],
      private: false,
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw malformedRequestBody();
  }

  if (!isPlainObject(parsed)) {
    throw malformedRequestBody();
  }

  const response = Object.hasOwn(parsed, 'response') ? parseResponse(parsed.response) : null;
  // After the response, so a body breaking a rule in both is answered about
  // the response, as it was before a queue could be given (D205).
  const queue = Object.hasOwn(parsed, 'queue') ? parseQueue(parsed.queue) : null;
  // After the queue, so a body breaking a rule of both is answered about the
  // queue, as it was before a lifetime could be given (D220).
  const expiry = parseSessionExpiry(parsed);
  // After both expiry keys and the two together, so a body breaking a rule of
  // those is answered about them, as it was before the choice existed (D243).
  const storeSourceIp = Object.hasOwn(parsed, 'storeSourceIp')
    ? parseStoreSourceIp(parsed.storeSourceIp)
    : true;
  // After every key before it, so a body breaking a rule of one of those is
  // answered about it, as it was before rules could be given (D246).
  const rules = Object.hasOwn(parsed, 'rules') ? parseCreateRules(parsed.rules) : [];
  // After every key before it, for the same reason (D253).
  const isPrivate = Object.hasOwn(parsed, 'private') ? parsePrivate(parsed.private) : false;

  // Unknown keys are the last row of the limits table, so they are reported
  // only once every rule above them holds.
  rejectUnknownKeys(parsed, TOP_LEVEL_KEYS, UNKNOWN_CREATE_KEY_RULE);

  return { response, queue, ...expiry, storeSourceIp, rules, private: isPrivate };
}

/**
 * Whether a session is private (D253): `false`, a public session as every
 * session was before, or `true`, a session that answers only a caller
 * presenting its access key. `create_session` over MCP runs it on its
 * argument.
 *
 * Only the JSON booleans are taken, as `storeSourceIp`'s are: a string such
 * as `"true"`, a number such as `1`, an array or an object is refused, and an
 * explicit `null` is refused with what to do instead. No message echoes the
 * value (D106).
 */
export function parsePrivate(value: unknown): boolean {
  if (value === null) {
    throw invalidResponseConfig(`${PRIVATE_RULE}; omit it for a public session`, 'private');
  }

  if (typeof value !== 'boolean') {
    throw invalidResponseConfig(PRIVATE_RULE, 'private');
  }

  return value;
}

/**
 * Whether a session's captures keep the address the backend attributes to
 * their sender (D243): `true`, as every session did before, or `false`, for a
 * session whose requests store `null` instead. The headers the sender sent
 * are kept as sent either way (D187). `create_session` over MCP runs it on its
 * argument.
 *
 * Only the JSON booleans are taken. A string such as `"false"`, a number such
 * as `0`, an array or an object is no boolean and is refused, never read as
 * one; an explicit `null` is refused with what to do instead, as
 * `"response": null` is: leaving the key out is how a session that keeps the
 * address is created. No message echoes the value (D106).
 */
export function parseStoreSourceIp(value: unknown): boolean {
  if (value === null) {
    throw invalidResponseConfig(
      `${STORE_SOURCE_IP_RULE}; omit it for a session that stores the sender's IP address`,
      'storeSourceIp',
    );
  }

  if (typeof value !== 'boolean') {
    throw invalidResponseConfig(STORE_SOURCE_IP_RULE, 'storeSourceIp');
  }

  return value;
}

/**
 * The two expiry keys of a creation, in the order the limits table gives
 * them: `expiresInSeconds` (D220), then `expiresAfterIdleSeconds` (D242),
 * then the two together, which is refused - a session that ends at a fixed
 * time cannot also slide. Each key's own rule comes first, so a body with a
 * bad value is told about that value. `create_session` over MCP runs it on
 * its arguments.
 */
export function parseSessionExpiry(parsed: Record<string, unknown>): SessionExpiry {
  const expiresInSeconds = Object.hasOwn(parsed, 'expiresInSeconds')
    ? parseExpiresInSeconds(parsed.expiresInSeconds)
    : null;
  const expiresAfterIdleSeconds = Object.hasOwn(parsed, 'expiresAfterIdleSeconds')
    ? parseExpiresAfterIdleSeconds(parsed.expiresAfterIdleSeconds)
    : null;

  // Named by the first of the two, which the message begins with (D257).
  if (expiresInSeconds !== null && expiresAfterIdleSeconds !== null) {
    throw invalidResponseConfig(ONE_EXPIRY_RULE, 'expiresInSeconds');
  }

  return { expiresInSeconds, expiresAfterIdleSeconds };
}

/**
 * The lifetime a session is created with (D220): a whole number of seconds
 * from `SESSION_LIFETIME_MIN_SECONDS` to `SESSION_LIFETIME_MAX_SECONDS`, the
 * idle window, so that a lifetime only shortens a session. `create_session`
 * over MCP runs it on its argument.
 *
 * The value is judged as `JSON.parse` read it, as `status` and `delayMs` are:
 * `6e2` and `600.0` are the number 600 and are taken, while `1e400` reads as
 * `Infinity` and a string, a boolean, an array or an object are no number, and
 * all of them are refused. An explicit `null` is refused with what to do
 * instead, as `"response": null` is: leaving the key out is how a session
 * without a lifetime is created. No message echoes the value (D106).
 */
export function parseExpiresInSeconds(value: unknown): number {
  if (value === null) {
    throw invalidResponseConfig(
      `${LIFETIME_RULE}; omit it for a session that expires ${SESSION_IDLE_DAYS} days after its last use`,
      'expiresInSeconds',
    );
  }

  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < SESSION_LIFETIME_MIN_SECONDS ||
    value > SESSION_LIFETIME_MAX_SECONDS
  ) {
    throw invalidResponseConfig(LIFETIME_RULE, 'expiresInSeconds');
  }

  return value;
}

/**
 * The idle window a session is created with (D242): a whole number of seconds
 * from `SESSION_IDLE_WINDOW_MIN_SECONDS`, an hour, to
 * `SESSION_IDLE_WINDOW_MAX_SECONDS`, the 7 days every other session slides by.
 * The session then expires that long after its last use instead of 7 days,
 * every rule of the sliding window applying to it (D133).
 *
 * Judged exactly as `parseExpiresInSeconds` judges a lifetime: as `JSON.parse`
 * read it, so `36e2` and `3600.0` are taken and `1e400`, a fraction, a string,
 * a boolean, an array and an object are refused; `null` is refused with what
 * to do instead; no message echoes the value (D106).
 */
export function parseExpiresAfterIdleSeconds(value: unknown): number {
  if (value === null) {
    throw invalidResponseConfig(
      `${IDLE_WINDOW_RULE}; omit it for a session that expires ${SESSION_IDLE_DAYS} days after its last use`,
      'expiresAfterIdleSeconds',
    );
  }

  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < SESSION_IDLE_WINDOW_MIN_SECONDS ||
    value > SESSION_IDLE_WINDOW_MAX_SECONDS
  ) {
    throw invalidResponseConfig(IDLE_WINDOW_RULE, 'expiresAfterIdleSeconds');
  }

  return value;
}

/**
 * Turns the body of a response change into what it asks for (D150).
 *
 * The same order as creation: a body that is absent, unparseable or not a JSON
 * object is `1006`, and every rule after that is `1005`. `mode` is required and
 * is the discriminant here - unlike creation, where the presence of `response`
 * is, a change has two meanings that both need saying:
 *
 * - `{"mode":"custom","response":{...}}` answers with that response and saves
 *   it, validated by exactly the function creation uses;
 * - `{"mode":"default"}` answers the default and keeps the saved custom
 *   response untouched (D151). A `response` beside it is refused rather than
 *   ignored, because it could only be read as a request to save something the
 *   call does not save.
 */
export function parseResponseChangeBody(rawBody: string | undefined): ResponseChange {
  // Unlike creation, a change has no bodyless form: there is nothing a request
  // without a body could mean.
  if (rawBody === undefined) {
    throw malformedRequestBody();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw malformedRequestBody();
  }

  if (!isPlainObject(parsed)) {
    throw malformedRequestBody();
  }

  const change = parseResponseChange(parsed);

  rejectUnknownKeys(
    parsed,
    CHANGE_KEYS,
    'The request body may contain no key other than "mode" and "response"',
  );

  return change;
}

/**
 * What `mode` and `response` of an object ask for: the rules of a change
 * above, all but the unknown keys, which the caller refuses in its own words.
 * `set_response` over MCP runs exactly these on its arguments (D203).
 */
export function parseResponseChange(parsed: Record<string, unknown>): ResponseChange {
  if (parsed.mode === 'custom') {
    if (!Object.hasOwn(parsed, 'response') || parsed.response === null) {
      throw refuse('response', 'must be an object when mode is "custom"');
    }

    return { mode: 'custom', response: parseResponse(parsed.response) };
  }

  if (parsed.mode === 'default') {
    if (Object.hasOwn(parsed, 'response')) {
      throw refuse(
        'response',
        'must be absent when mode is "default"; the saved custom response is kept',
      );
    }

    return { mode: 'default' };
  }

  throw refuse('mode', 'is required and must be "default" or "custom"');
}

/**
 * One `response` object checked against every rule of the limits table, as
 * creation and a change check it; `create_session` over MCP runs it on its
 * argument (D203). A step of a response queue is checked by this same
 * function (D205): `field` is where the object sits in the body - `response`,
 * or `steps[2]` and `queue.steps[2]` for the third step - and every message
 * names it, so a refused step is named by its position.
 */
export function parseResponse(value: unknown, field = 'response'): ResponseConfig {
  if (value === null) {
    throw refuse(
      field,
      field === 'response'
        ? 'must be an object; omit the key entirely to create a default session'
        : 'must be an object',
    );
  }

  if (!isPlainObject(value)) {
    throw refuse(field, 'must be an object');
  }

  const status = parseStatus(value.status, field);

  // A body on a status that forbids one is refused now rather than dropped
  // later (D101). It was decided while a configuration could never be
  // repaired, and it stands now that one can be changed (D150): it holds for
  // the change as well, since the reply to such a session would not carry the
  // body it was configured with.
  if (
    STATUSES_WITHOUT_BODY.includes(status) &&
    typeof value.body === 'string' &&
    value.body !== ''
  ) {
    throw refuse(`${field}.body`, `must be absent when ${field}.status is 204, 205 or 304`);
  }

  const headers = parseHeaders(value.headers, field, status);
  const body = parseBody(value.body, field);
  const delayMs = parseDelay(value.delayMs, field);
  const template = parseTemplate(value.template, body, field);

  rejectUnknownKeys(
    value,
    RESPONSE_KEYS,
    `${field} may contain no key other than "status", "headers", "body", "delayMs" and "template"`,
    field,
  );

  return { status, headers, body, delayMs, template };
}

/**
 * The steps of a response queue (D205): an array of 1 to `MAX_QUEUE_STEPS`
 * responses, each checked by `parseResponse` under its own position, in order,
 * so the first step that breaks a rule is the one the message names. The
 * count is checked before any step, so a queue of 11 is refused for its length
 * whatever its steps hold.
 */
export function parseQueueSteps(value: unknown, field: string): ResponseConfig[] {
  if (!Array.isArray(value)) {
    throw refuse(field, `is required and must be an array of 1 to ${MAX_QUEUE_STEPS} responses`);
  }

  if (value.length < 1 || value.length > MAX_QUEUE_STEPS) {
    throw refuse(field, `must contain 1 to ${MAX_QUEUE_STEPS} responses`);
  }

  return value.map((step: unknown, index) => parseResponse(step, `${field}[${index}]`));
}

/**
 * The `queue` of a creation (D205): an object whose `steps` are what
 * `PUT /api/sessions/:sessionId/queue` takes. An explicit `null` is refused,
 * as `"response": null` is: leaving the key out is how a session without a
 * queue is created.
 */
function parseQueue(value: unknown): ResponseConfig[] {
  if (value === null) {
    throw refuse(
      'queue',
      'must be an object; omit the key entirely to create a session without a queue',
    );
  }

  if (!isPlainObject(value)) {
    throw refuse('queue', 'must be an object');
  }

  const steps = parseQueueSteps(value.steps, 'queue.steps');

  rejectUnknownKeys(value, QUEUE_KEYS, 'queue may contain no key other than "steps"', 'queue');

  return steps;
}

/**
 * Turns the body of `PUT /api/sessions/:sessionId/queue` into the steps it
 * saves (D205), in the order every JSON route checks its body (D104): a body
 * that is absent, unparseable or not a JSON object is `1006`, and every rule
 * after that is `1005` - `steps` itself, each step as a response is checked,
 * then any key but `steps`.
 */
export function parseQueueBody(rawBody: string | undefined): ResponseConfig[] {
  if (rawBody === undefined) {
    throw malformedRequestBody();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw malformedRequestBody();
  }

  if (!isPlainObject(parsed)) {
    throw malformedRequestBody();
  }

  const steps = parseQueueSteps(parsed.steps, 'steps');

  rejectUnknownKeys(parsed, QUEUE_KEYS, 'The request body may contain no key other than "steps"');

  return steps;
}

/**
 * The rule every refusal of a rule's method states (D246). The methods are
 * the receiver's (`RESPONSE_RULE_METHODS`); API.md lists them.
 */
export const RULE_METHOD_RULE =
  'method is required: null for any method, or a method the receiver captures, in upper case, CONNECT excepted';

/**
 * The response rules of a session (D246): an array of at most
 * `MAX_RESPONSE_RULES` rules, each checked in order under its own position,
 * so the first rule that breaks a check is the one the message names. The
 * count is checked before any rule, so 21 rules are refused for their number
 * whatever they hold. `[]` is no rules.
 */
export function parseRules(value: unknown, field = 'rules'): ResponseRule[] {
  if (!Array.isArray(value)) {
    throw refuse(field, `is required and must be an array of at most ${MAX_RESPONSE_RULES} rules`);
  }

  if (value.length > MAX_RESPONSE_RULES) {
    throw refuse(field, `must contain at most ${MAX_RESPONSE_RULES} rules`);
  }

  return value.map((rule: unknown, index) => parseRule(rule, `${field}[${index}]`));
}

/**
 * One rule (D246), its fields in the order they are written: `method`, then
 * `path`, then `response`, checked by `parseResponse` under the rule's place
 * (`rules[2].response`), then any other key. No message quotes what the rule
 * holds (D106).
 */
function parseRule(value: unknown, field: string): ResponseRule {
  if (!isPlainObject(value)) {
    throw refuse(field, 'must be an object with "method", "path" and "response"');
  }

  const method = parseRuleMethod(value, field);
  const path = parseRulePath(value.path, field);
  const response = parseResponse(value.response, `${field}.response`);

  // Named by the rule, never by the key, which is the client's (D106, D257).
  rejectUnknownKeys(
    value,
    RULE_KEYS,
    `${field} may contain no key other than "method", "path" and "response"`,
    field,
  );

  return { method, path, response };
}

/**
 * A rule's method: present, and `null` for any method or one of the methods
 * the receiver captures, exactly as Node writes it - upper case - since a
 * captured request's method is compared with it as stored. `CONNECT` never
 * reaches a route (D139), so a rule naming it could never answer.
 */
function parseRuleMethod(value: Record<string, unknown>, field: string): string | null {
  const method = value.method;

  if (method === null) {
    return null;
  }

  if (typeof method !== 'string' || !RESPONSE_RULE_METHODS.includes(method)) {
    throw invalidResponseConfig(`${field}.${RULE_METHOD_RULE}`, `${field}.method`);
  }

  return method;
}

/** The visible ASCII characters, `!` to `~`: all a request's path is ever made of. */
const FIRST_VISIBLE_CODE = 0x21;
const LAST_VISIBLE_CODE = 0x7e;

/**
 * A rule's path pattern (D246): starting with `/`, at most
 * `MAX_RULE_PATH_BYTES` characters of visible ASCII - all a stored path is
 * made of, since the receiver's parser refuses a request line holding any
 * other byte and a space ends the target, so another character is written
 * percent-encoded, as a request sends it - no `?`, since the query is never
 * matched, and `*` only as its last character, which makes it a prefix.
 * Nothing in it is special but that last `*`: `%`, `_`, `.` and every other
 * character match only themselves.
 *
 * The length is judged before any character is read, so a long one costs no
 * more than its count; ASCII is one byte a character of UTF-8.
 */
function parseRulePath(value: unknown, field: string): string {
  const place = `${field}.path`;

  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw refuse(place, 'is required and must be a string starting with /');
  }

  if (value.length > MAX_RULE_PATH_BYTES) {
    throw refuse(place, `must be at most ${MAX_RULE_PATH_BYTES} characters`);
  }

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < FIRST_VISIBLE_CODE || code > LAST_VISIBLE_CODE) {
      throw refuse(
        place,
        'must contain only visible ASCII: write a space or any other character percent-encoded, as a request sends it',
      );
    }
  }

  if (value.includes('?')) {
    throw refuse(place, 'must contain no ?: the query of a request is never matched');
  }

  const star = value.indexOf('*');

  if (star !== -1 && star !== value.length - 1) {
    throw refuse(
      place,
      'may contain * only as its last character, where it matches any rest of the path',
    );
  }

  return value;
}

/**
 * The `rules` of a creation (D246): what `PUT /api/sessions/:sessionId/rules`
 * takes as `rules`, so one array serves both. An explicit `null` is refused,
 * as `"queue": null` is: leaving the key out, or `[]`, is how a session
 * without rules is created.
 */
function parseCreateRules(value: unknown): ResponseRule[] {
  if (value === null) {
    throw refuse(
      'rules',
      'must be an array; omit the key entirely to create a session without rules',
    );
  }

  return parseRules(value, 'rules');
}

/**
 * Turns the body of `PUT /api/sessions/:sessionId/rules` into the rules it
 * saves (D246), in the order every JSON route checks its body (D104): a body
 * that is absent, unparseable or not a JSON object is `1006`, and every rule
 * after that is `1005` - `rules` itself, each rule in order, then any key but
 * `rules`.
 */
export function parseRulesBody(rawBody: string | undefined): ResponseRule[] {
  if (rawBody === undefined) {
    throw malformedRequestBody();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw malformedRequestBody();
  }

  if (!isPlainObject(parsed)) {
    throw malformedRequestBody();
  }

  const rules = parseRules(parsed.rules, 'rules');

  rejectUnknownKeys(parsed, RULES_KEYS, 'The request body may contain no key other than "rules"');

  return rules;
}

function parseStatus(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < RESPONSE_STATUS_MIN ||
    value > RESPONSE_STATUS_MAX
  ) {
    throw refuse(
      `${field}.status`,
      `is required and must be an integer between ${RESPONSE_STATUS_MIN} and ${RESPONSE_STATUS_MAX}`,
    );
  }

  return value;
}

/**
 * Duplicate names are accepted and kept in the configured order (D045), several
 * `Location` pairs among them; case folding applies to the reserved list and to
 * the name `Location`, and to nothing else. `status` is the response's own,
 * already checked, which the `Location` rule reads (D247).
 */
function parseHeaders(value: unknown, field: string, status: number): [string, string][] {
  if (value === undefined) {
    return [];
  }

  const list = `${field}.headers`;

  if (!Array.isArray(value)) {
    throw refuse(list, 'must be an array of [name, value] pairs');
  }

  if (value.length > MAX_RESPONSE_HEADERS) {
    throw refuse(list, `must contain at most ${MAX_RESPONSE_HEADERS} pairs`);
  }

  const headers: [string, string][] = [];

  for (const [index, pair] of value.entries()) {
    const place = `${list}[${index}]`;

    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== 'string' ||
      typeof pair[1] !== 'string'
    ) {
      throw refuse(place, 'must be a [name, value] pair of two strings');
    }

    const name: string = pair[0];
    const headerValue: string = pair[1];

    if (byteLength(name) > MAX_HEADER_NAME_BYTES) {
      throw refusePairPart(place, 'name', `must be at most ${MAX_HEADER_NAME_BYTES} bytes`);
    }

    if (!HEADER_NAME_PATTERN.test(name)) {
      throw refusePairPart(
        place,
        'name',
        "must be an HTTP token: letters, digits and the characters !#$%&'*+.^_`|~-",
      );
    }

    if (byteLength(headerValue) > MAX_HEADER_VALUE_BYTES) {
      throw refusePairPart(place, 'value', `must be at most ${MAX_HEADER_VALUE_BYTES} bytes`);
    }

    if (!isAllowedHeaderValue(headerValue)) {
      throw refusePairPart(place, 'value', 'must contain only visible ASCII, space and tab');
    }

    headers.push([name, headerValue]);
  }

  // Only the configured pairs are counted: the receiver's own Content-Type,
  // X-Content-Type-Options, Content-Security-Policy, X-Webhook-Inspector-Request-Id
  // and X-QA-Tools-Request-Id sit outside this budget (D279).
  const blockBytes = headers.reduce(
    (total, [name, headerValue]) => total + byteLength(`${name}: ${headerValue}\r\n`),
    0,
  );

  if (blockBytes > MAX_HEADER_BLOCK_BYTES) {
    throw refuse(
      list,
      `must serialise to at most ${MAX_HEADER_BLOCK_BYTES} bytes as "name: value" lines`,
    );
  }

  // A reserved name, then the `Location` rule, pair by pair in the configured
  // order, so the first pair breaking either is the one named (D247). Neither
  // message quotes the value (D106).
  for (const [index, [name, headerValue]] of headers.entries()) {
    const place = `${list}[${index}]`;

    if (isReservedHeaderName(name)) {
      throw refusePairPart(place, 'name', 'is reserved by the receiver and cannot be configured');
    }

    const location = locationHeaderProblem(name, headerValue, status);

    // The pair as a whole: its name is allowed, but not beside this status.
    if (location === 'status') {
      throw refuse(
        place,
        `Location is allowed only when ${field}.status is from ${LOCATION_STATUS_MIN} to ${LOCATION_STATUS_MAX}`,
      );
    }

    if (location === 'target') {
      throw refusePairPart(
        place,
        'value',
        `of Location must be a path beginning with ${LOCATION_TARGET_PREFIX}`,
      );
    }
  }

  return headers;
}

/** Visible ASCII plus space and tab, so that CR and LF cannot appear (D101). */
function isAllowedHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code === HEADER_VALUE_TAB_CODE) {
      continue;
    }

    if (code < HEADER_VALUE_MIN_CODE || code > HEADER_VALUE_MAX_CODE) {
      return false;
    }
  }

  return true;
}

function isReservedHeaderName(name: string): boolean {
  const lowered = name.toLowerCase();

  return (
    RESERVED_RESPONSE_HEADERS.includes(lowered) ||
    lowered.startsWith(RESERVED_RESPONSE_HEADER_PREFIX)
  );
}

/**
 * The body is kept as the exact text the caller sent and is only checked, never
 * rewritten (D101). Any text is a body - JSON or not, valid or broken - since
 * D179: the user announces what it is with a configured `Content-Type`.
 *
 * `null` is accepted as the absence of a body: it is exactly what
 * `GET /api/sessions/:sessionId` emits for a session without one (D106). An
 * empty string means the same and is saved as `null` (D179), so a session has
 * one way to hold "no body".
 */
function parseBody(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw refuse(`${field}.body`, 'must be a string containing the body to return');
  }

  if (byteLength(value) > MAX_RESPONSE_BODY_BYTES) {
    throw refuse(`${field}.body`, `must be at most ${MAX_RESPONSE_BODY_BYTES} bytes of UTF-8`);
  }

  // The TEXT column storing the body cannot hold a NUL byte, so accepting one
  // would turn an invalid configuration into a 500 at insert time. Only the
  // character itself is refused: the six characters of a JSON `\u0000` escape
  // are ordinary text to that column, and the body is never cast to jsonb
  // (D179, correcting D101).
  if (value.includes(NUL)) {
    throw refuse(`${field}.body`, 'must not contain U+0000');
  }

  return value;
}

function parseDelay(value: unknown, field: string): number {
  if (value === undefined) {
    return 0;
  }

  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_RESPONSE_DELAY_MS
  ) {
    throw refuse(`${field}.delayMs`, `must be an integer between 0 and ${MAX_RESPONSE_DELAY_MS}`);
  }

  return value;
}

/** The rule of `template`, which every refusal of its type states (D251). */
const TEMPLATE_RULE = 'template must be true or false';

/** The placeholders a refusal lists, as API.md writes them. */
const PLACEHOLDER_LIST = `${TEMPLATE_PLACEHOLDERS.slice(0, -1).join(', ')} or ${TEMPLATE_PLACEHOLDERS.at(-1)}`;

/**
 * Whether the body is a template (D251): absent is `false`, the body sent
 * exactly as configured, which every body accepted before is; otherwise only
 * a JSON boolean, `null` and `"true"` refused as no boolean.
 *
 * With `true`, the body - already within its size and free of U+0000 - must
 * read as a template: every `{{` one of the placeholders, closed by `}}`,
 * nothing else inside the braces. The message names the placeholder by its
 * place among the body's `{{`, counted from 1, and the rule it broke, never
 * what it holds (D106). Reading it is one pass over the body, whatever it
 * holds. A template without a body, or on 204, 205 or 304, is taken: it
 * simply has nothing to fill in.
 */
function parseTemplate(value: unknown, body: string | null, field: string): boolean {
  if (value === undefined) {
    return false;
  }

  if (typeof value !== 'boolean') {
    throw invalidResponseConfig(`${field}.${TEMPLATE_RULE}`, `${field}.template`);
  }

  if (value && body !== null) {
    const problem = templateProblem(body);

    if (problem !== null) {
      throw invalidResponseConfig(templateProblemMessage(problem, field), `${field}.body`);
    }
  }

  return value;
}

/** A refused template's message: where, and which rule, with nothing of the body in it (D106). */
function templateProblemMessage(problem: TemplateProblem, field: string): string {
  const place = `${field}.body placeholder ${problem.index}`;

  switch (problem.kind) {
    case 'unclosed':
      return `${place} has no closing }}: with ${field}.template true every {{ starts a placeholder`;
    case 'header':
      return `${place} must name a header that is an HTTP token: letters, digits and the characters !#$%&'*+.^_\`|~-`;
    case 'query':
      return `${place} must name a query parameter`;
    case 'body':
      return `${place} must name a path of the request body: keys separated by dots, none empty`;
    case 'unknown':
      return `${place} must be one of ${PLACEHOLDER_LIST}, with nothing else inside the braces`;
  }
}

/**
 * Unknown keys are rejected rather than ignored: a misspelt `delayMs` would
 * otherwise create a session that is not the one the caller described, with
 * nothing in the reply saying so (D101).
 *
 * `field` is the object holding the key - `rules[1]`, `queue` - and never the
 * key, which is the client's (D106); the body's own unknown keys, a refusal
 * of the body as a whole, carry none (D257).
 */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  known: string[],
  message: string,
  field?: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw invalidResponseConfig(message, field);
    }
  }
}
