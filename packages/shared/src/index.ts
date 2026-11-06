/**
 * Contracts shared by the Webhook Inspector frontend and backend.
 *
 * Values here mirror the project's decisions, cited by number, and the contract
 * in `docs/API.md`. Change them only together with that documentation.
 */

/**
 * How long a session lives from its last use by default (D005 as amended,
 * D133), and the longest idle window a session may be created with (D242).
 *
 * The window slides: creation sets `expires_at` this far ahead, and a captured
 * webhook or a load of the View page moves it this far ahead again. It is not
 * an age limit, so a session in daily use never expires and only an abandoned
 * one does - unless it was created with a lifetime, whose end no use moves
 * (D220). A session created with `expiresAfterIdleSeconds` slides by its own,
 * shorter window instead (D242), so this stays the bound `/terms` and
 * `/privacy` state.
 */
export const SESSION_IDLE_DAYS = 7;

/**
 * The shortest idle window a session may be created with,
 * `expiresAfterIdleSeconds` of `POST /api/sessions` and of the MCP tool
 * `create_session` (D242): one hour.
 */
export const SESSION_IDLE_WINDOW_MIN_SECONDS = 3600;

/**
 * The longest idle window a session may be created with, and the window of
 * every session created without one: `SESSION_IDLE_DAYS` in seconds (D242).
 */
export const SESSION_IDLE_WINDOW_MAX_SECONDS = SESSION_IDLE_DAYS * 86_400;

/**
 * The shortest lifetime a session may be created with, `expiresInSeconds` of
 * `POST /api/sessions` and of the MCP tool `create_session` (D220).
 */
export const SESSION_LIFETIME_MIN_SECONDS = 60;

/**
 * The longest lifetime a session may be created with: the idle window, since
 * a lifetime only shortens a session and never keeps it past 7 days after its
 * last use (D220). A session created with one ends that many seconds after its
 * creation, and no use moves its expiry.
 */
export const SESSION_LIFETIME_MAX_SECONDS = SESSION_IDLE_DAYS * 86_400;

/**
 * Length of a session id (D004). A new id is 43 symbols of
 * `SESSION_ID_ALPHABET`, 62^43 ≈ 2^256; one created before 0.20.3 is 32 random
 * bytes in Base64URL without padding, also 43 characters (D161).
 */
export const SESSION_ID_LENGTH = 43;

/**
 * The symbols a new session id is drawn from: letters and digits. Neither `_`
 * nor `-`, which stop a double-click selection and are easy to drop when a URL
 * is copied or typed (D161).
 */
export const SESSION_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Characters a session id may contain.
 *
 * Deliberately wider than `SESSION_ID_ALPHABET`: it still accepts `_` and `-`,
 * because every id created before 0.20.3 is Base64URL, and such a session keeps
 * working for as long as it is used (D133, D161). Every new id matches it too,
 * so nothing that validates an id changed with the alphabet.
 *
 * Keep in step with the `/v/` location in `apps/frontend/nginx.conf`, which
 * repeats this pattern to decide which addresses it serves with `200` rather
 * than `404` (D146). `apps/frontend/src/lib/not-found.test.ts` fails when the
 * two differ.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Maximum accepted webhook body size in bytes (D008). */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Maximum number of captured requests kept per session (D006). */
export const MAX_REQUESTS_PER_SESSION = 1000;

/** Number of request-ID characters shown in the request list (D044). */
export const REQUEST_ID_DISPLAY_LENGTH = 7;

/** Stable numeric API error codes (D040). Never reuse or renumber a published code. */
export const ErrorCode = {
  ROUTE_NOT_FOUND: 1000,
  SESSION_NOT_FOUND: 1001,
  SESSION_EXPIRED: 1002,
  REQUEST_NOT_FOUND: 1003,
  PAYLOAD_TOO_LARGE: 1004,
  INVALID_RESPONSE_CONFIG: 1005,
  MALFORMED_REQUEST_BODY: 1006,
  UNSUPPORTED_MEDIA_TYPE: 1007,
  MISSING_REQUEST_CONTENT: 1008,
  RECEIVE_URL_MOVED: 1009,
  INVALID_SEARCH_WORDS: 1010,
  SEARCH_TIMED_OUT: 1011,
  SEARCH_BUSY: 1012,
  INVALID_LIST_QUERY: 1013,
  INVALID_SESSION_IDS: 1014,
  RATE_LIMIT_EXCEEDED: 1015,
  LIST_BODIES_BUSY: 1016,
  LARGE_BODIES_BUSY: 1017,
  CAPTURES_BUSY: 1018,
  TOO_MANY_CONCURRENT_CALLS: 1019,
  TOO_MANY_REALTIME_CONNECTIONS: 1020,
  INTERNAL_ERROR: 1500,
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Body of every internal API error response (D026). */
export interface ApiError {
  errorCode: ErrorCode;
  message: string;
  /**
   * Where in the request body the refused value sits, such as
   * `rules[1].path`: only on a `1005` that names a place in it (D257).
   */
  field?: string;
}

/**
 * The inspector's page of a session, `<origin>/v/<session-id>`, or of one of
 * its requests, `<origin>/v/<session-id>#<request-id>` (D182). The one builder
 * of the link: `Copy link` copies it, `/mcp` answers it as `inspectorUrl`
 * (D203), and so does a default session's reply (D223). `origin` is the
 * site's own, `APP_ORIGIN` on the backend. The link grants exactly what the
 * session's address grants (D004), and is never given anything else to carry.
 */
export function buildInspectorUrl(origin: string, sessionId: string, requestId?: string): string {
  const page = `${origin}/v/${sessionId}`;

  return requestId === undefined ? page : `${page}#${requestId}`;
}

/**
 * What a default session answers a stored request with (D100, D223): `ok`
 * first and `requestId` second, then what the request is, as the list and the
 * detail give it, and nothing it carried - no body, no header, no query
 * string. Open to additive extension: a client ignores keys it does not know.
 */
export interface WebhookDefaultAnswer {
  ok: true;
  /**
   * The stored request's id, equal to `X-Webhook-Inspector-Request-Id` and
   * `X-QA-Tools-Request-Id` (D100, D279).
   */
  requestId: string;
  /**
   * `Captured by QA Tools`, until the day the changelog's 1.19.0 entry gives,
   * and `Captured by Webhook Inspector` from it (D279).
   */
  message: string;
  /** `<APP_ORIGIN>/v/<session-id>#<request-id>`: this request in the inspector (D182). */
  inspectorUrl: string;
  /** UTC, ISO 8601, as the list and the detail give it. */
  receivedAt: string;
  method: string;
  /** The stored path: `/s/<id>` and any sub-path, as received, without the query string (D173). */
  path: string;
  /** The stored body's size in bytes, as received; `0` without a body. */
  bodySize: number;
  /**
   * The stored sender address, `null` when it is unknown (D111, D187) or the
   * session was created with `storeSourceIp: false` (D243).
   */
  sourceIp: string | null;
}

/** What both session answers, `POST /api/sessions` and `GET /api/sessions/:sessionId`, say. */
export interface SessionIdentity {
  id: string;
  /**
   * Absolute expiration timestamp in UTC, ISO 8601 (D028). For a session
   * created with a lifetime, the fixed end of that lifetime, which no use
   * moves (D220).
   */
  expiresAt: string;
  /**
   * Where this session receives webhooks: the receive host's origin and
   * `/s/<id>`, `https://hook.qa-tools.ru/s/<id>` in production (D187). Derived
   * from configuration on every answer, never stored.
   */
  receiveUrl: string;
  /**
   * Whether the session is private (D245, D253): `true` for one created with
   * `"private": true`, which answers only a caller presenting its access key;
   * `false` for every other, those created before 1.11.0 included. Set at
   * creation only.
   */
  private: boolean;
}

/** Response of `POST /api/sessions`. */
export interface CreatedSession extends SessionIdentity {
  /**
   * The access key the server drew for a private session created without an
   * `Authorization` header, answered this once and never again (D253); absent
   * for a public session and for one created under a key the caller sent.
   */
  accessKey?: string;
}

/**
 * How writing one captured request's response ended (D109).
 *
 * `pending`, `sent`, `aborted` and `failed` are stored. `unknown` is derived at
 * read time from a `pending` record that has aged past its own delay plus
 * `RESPONSE_UNKNOWN_GRACE_MS`, and is never stored. A missing record is a fifth
 * reading, expressed as `response: null`, and means nothing was recorded.
 *
 * `sent` means the backend finished writing the response into the connection.
 * It is never a delivery confirmation (D103).
 */
export type ResponseState = 'pending' | 'sent' | 'aborted' | 'failed' | 'unknown';

/**
 * Which step of a session's response queue answered a request (D205): its
 * position, 1-based, and how many steps the queue held at that moment.
 * `{ "index": 2, "total": 7 }` reads "queue step 2 of 7".
 */
export interface QueueStep {
  index: number;
  total: number;
}

/**
 * Which of a session's response rules answered a request (D246): its
 * position in the list, 1-based, when it answered. What a list row and the
 * events carry; the detail adds what the rule matched on (`RecordedRule`).
 */
export interface RuleSummary {
  index: number;
}

/**
 * The rule that answered a request, as it was when it answered (D246): its
 * position, 1-based, its method - `null` for any method - and its path
 * pattern. The response it answered with is the record itself.
 */
export interface RecordedRule extends RuleSummary {
  method: string | null;
  path: string;
}

/** What a list row and `response.recorded` carry about a response (D110). */
export interface ResponseSummary {
  state: ResponseState;
  /** `null` when the write failed before a status was composed (D109). */
  status: number | null;
  /**
   * The step of the session's response queue that answered the request, or
   * `null` when the session response answered it - the session had no queue,
   * or every step had answered already - or a response rule did, and for
   * every request recorded before 0.46.0 or by an earlier image (D205).
   */
  queueStep: QueueStep | null;
  /**
   * The response rule that answered the request, or `null` when none did -
   * the queue or the session response answered - and for every request
   * recorded before 1.3.0 or by an earlier image (D246). A rule and a queue
   * step never answer the same request.
   */
  rule: RuleSummary | null;
}

/**
 * The whole recorded response, carried by the detail endpoint only (D110).
 *
 * Bytes follow the same UTF-8/Base64 transport rule as the captured request
 * (D043). `body` is `null` for a response that carried no body at all; an empty
 * body travels as an empty string, and the two are different answers.
 */
export interface ResponseRecord extends ResponseSummary {
  /**
   * The response rule that answered, with what it matched on as it was then,
   * or `null` (D246).
   */
  rule: RecordedRule | null;
  /** The exact final ordered pair list the backend passed to `writeHead` (D045, D109). */
  headers: [string, string][];
  body: string | null;
  bodyBase64: string | null;
  isBinary: boolean;
  bodySize: number;
  /** A representation was produced and its bytes were not sent: `HEAD` (D064). */
  bodySuppressed: boolean;
  /**
   * The response the backend formed: its status line, those same headers and
   * its body. Not a wire capture - the headers Node adds when it serialises the
   * head (`Date`, `Connection`, `Keep-Alive`) are not part of it - and on
   * `aborted` or `pending` not all of it, or none of it, was written (D109).
   */
  raw: string | null;
  rawBase64: string | null;
  isRawBinary: boolean;
  delayMs: number;
  /** UTC, ISO 8601. The capture time the response was formed at. */
  startedAt: string;
  completedAt: string | null;
  /** Backend-side, and it includes the configured delay (D109). */
  durationMs: number | null;
}

/**
 * One row of `GET /api/sessions/:sessionId/requests` asked with no `include`:
 * list metadata only (D037, as amended by D196).
 */
export interface RequestListItem {
  id: string;
  method: string;
  /** UTC, ISO 8601. The frontend renders it in the viewer's timezone (D042). */
  receivedAt: string;
  bodySize: number;
  /**
   * The stored sender address, or `null` when it did not parse (D111) or the
   * session was created with `storeSourceIp: false` (D243).
   */
  sourceIp: string | null;
  /**
   * The path component of the captured URL, without the query string, as
   * stored (D173). `null` for a request captured before the column existed:
   * there is no backfill (D110). Listed so the list filter can match it; no
   * row shows it (D180).
   */
  path: string | null;
  /** The light summary only: no body and no full headers here (D110). */
  response: ResponseSummary | null;
}

/**
 * Response of `GET /api/sessions/:sessionId/requests/:requestId`.
 *
 * Bytes are transported as text when they are valid UTF-8 and as Base64 when
 * they are not, never lossily (D043).
 */
export interface RequestDetails extends RequestListItem {
  queryString: string;
  /** Ordered [name, value] pairs, duplicates preserved (D045). */
  headers: [string, string][];
  body: string | null;
  bodyBase64: string | null;
  isBinary: boolean;
  raw: string | null;
  rawBase64: string | null;
  isRawBinary: boolean;
  /**
   * The HTTP version the request arrived on; `null` for a request captured
   * before the column existed: there is no backfill (D102, D110). `path`,
   * inherited from `RequestListItem`, is `null` in the same case.
   */
  httpVersion: string | null;
  /** The whole record, or `null` when nothing was recorded (D109, D110). */
  response: ResponseRecord | null;
}

/**
 * The limits of the search of raw requests,
 * `POST /api/sessions/:sessionId/requests/search` (D191). The backend is
 * authoritative; the frontend checks the same values, so a query the server
 * would refuse is never sent.
 *
 * A word is measured in bytes of its UTF-8 encoding, an unpaired surrogate
 * counting as U+FFFD, three bytes, which is how both `TextEncoder` and the
 * backend encode one.
 */
export const SEARCH_MIN_WORD_BYTES = 3;
export const SEARCH_MAX_WORD_BYTES = 200;
export const SEARCH_MAX_WORDS = 8;

/** How long one search may run before it is cancelled and answered `503` / `1011`. */
export const SEARCH_TIMEOUT_MS = 2000;

/**
 * How many searches one backend process runs at once, and queries of requests
 * with a body condition among them; the next one is refused `429` / `1012`,
 * not queued. Per process: one outside a rollout, two for its seconds (D191,
 * D196, D221).
 */
export const MAX_CONCURRENT_SEARCHES = 2;

/**
 * How many queries of requests with no body condition - header conditions
 * alone, or none - one backend process runs at once, in a count of their own
 * apart from the searches'; the next one is refused `429` / `1012`, not
 * queued. Per process, as the searches' (D250).
 */
export const MAX_CONCURRENT_HEADER_QUERIES = 2;

/** The `Retry-After` of a `429` / `1012`, from either count, in seconds (D250). */
export const SEARCH_BUSY_RETRY_AFTER_SECONDS = 1;

/**
 * The per-address limits of the API (D201): calls are counted in fixed
 * windows of this many seconds, each window starting with the first call an
 * address makes in it.
 */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * `POST /api/sessions` per address per window (D201). Creation counts toward
 * this limit only.
 */
export const SESSION_CREATE_LIMIT = 60;

/** Every other call under `/api` per address per window (D201). */
export const API_CALL_LIMIT = 1200;

/**
 * How many calls one address may have in flight at once on `/api` and `/mcp`
 * together, waits included, from the moment the headers of each have arrived
 * until its answer is written - or its client is gone - and its handler has
 * settled; the next is refused `429` / `1019`, not queued (D213). Keyed as the
 * per-minute limits key an address, an IPv6 address by its `/64`. Per
 * process: one outside a rollout, two for its seconds (D221).
 */
export const MAX_CALLS_IN_FLIGHT = 128;

/**
 * The `Retry-After` of that refusal, in seconds (D213), and of an answer the
 * answers' byte budget refuses (#184).
 */
export const CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

/**
 * What the answers of `/api` and `/mcp` not yet written may weigh at once in
 * one backend process, in bytes (#184, D228): an answer weighs its body as it
 * was serialized, from that moment until its response closes - written whole,
 * or its connection gone. One that would take the process past this while its
 * address already has another answer counted is not sent: its call is
 * answered `429` / `1019` instead. Per process: one outside a rollout, two for
 * its seconds (D221).
 */
export const API_ANSWER_BYTES = 64 * 1024 * 1024;

/**
 * What the answers of one address not yet written may weigh at once, in
 * bytes, within `API_ANSWER_BYTES` (#184, D228), the address keyed as the
 * calls in flight key it. The address's first answer counted is always sent,
 * whatever its size.
 */
export const API_ANSWER_PER_ADDRESS_BYTES = 16 * 1024 * 1024;

/**
 * How many realtime connections, `/ws/<session-id>`, one address may have
 * open at once, from the moment the headers of each have arrived until its
 * socket has closed; the next is refused `429` / `1020` before the upgrade,
 * not queued (D227). 16 rather than the 32 first decided: 32 connections
 * that stopped reading cost the backend 128 to 178 MiB, measured, more than
 * the about 128 MiB the decision allowed them. Keyed as the per-minute
 * limits key an address, an IPv6 address by its `/64`. Per process: one
 * outside a rollout, two for its seconds (D221).
 */
export const MAX_REALTIME_CONNECTIONS_PER_ADDRESS = 16;

/** The `Retry-After` of that refusal, in seconds (D227). */
export const REALTIME_CONNECTIONS_RETRY_AFTER_SECONDS = 1;

/**
 * How many connections one sender address may have open at once to the
 * receive host, counted by the backend's PROXY protocol layer from the moment
 * a connection's header names its sender until the connection closes, an idle
 * kept-alive one included (D227). The next is closed right after its header,
 * with no HTTP answer. Keyed as the per-minute limits key an address, an IPv6
 * address by its `/64`. The default of `RECEIVE_CONNECTIONS_PER_ADDRESS`,
 * which the chart sets from `receive.connectionsPerAddress`; `0` turns the
 * bound off. Per process: one outside a rollout, two for its seconds (D221).
 * 512 so that D210's burst of 500 webhooks at once from one address is still
 * stored whole.
 */
export const MAX_RECEIVE_CONNECTIONS_PER_ADDRESS = 512;

/**
 * How many requests one connection to the receive host may have read and not
 * yet answered at once (D229). A sender may pipeline any number: those past
 * this many wait unread in the connection and are read as the earlier ones
 * are answered, every one still captured and answered in order; nothing is
 * refused for it. A request counts as answered once its whole answer has been
 * handed to the connection. The backend reads more of a connection only while
 * fewer than this many of its requests are unanswered, in slices cut short of
 * the head that would be one too many. With
 * `MAX_RECEIVE_CONNECTIONS_PER_ADDRESS` it bounds what one address's
 * pipelining can make the backend hold.
 */
export const MAX_PIPELINED_REQUESTS = 32;

/**
 * How many header lines the connections of one sender address to the receive
 * host may have given the backend's HTTP parser and not yet ended (D238): a
 * line is in flight from its first byte until the empty line ending its
 * request head, or its trailer section, or until its connection closes. A
 * connection whose next line does not fit waits, its bytes unread, and is
 * read on once lines are given back; nothing is answered, closed or refused
 * for it. The address's oldest holder of lines, and the first connection of
 * an address holding none, are never held by this number, so a webhook with
 * the most header lines Node allows, 16,320, is never held by its own size.
 * Keyed as the per-minute limits key an address, an IPv6 address by its
 * `/64`. Two of the largest heads Node allows: Node keeps every line of a
 * head still arriving, about 24 bytes each at the least, and the receive
 * listener limits no count of lines (D187).
 */
export const MAX_HEADER_LINES_IN_FLIGHT_PER_ADDRESS = 32_768;

/**
 * How many header lines all the connections to the receive host together may
 * have in flight in one backend process (D238), the per-address number's
 * sixteen times: sixteen addresses at their bound before another address's
 * webhook waits. The process's oldest holder of lines, and the first
 * connection while none holds any, are never held by it. About 12 MiB of
 * Node's parser at 24 bytes a line. Per process: one outside a rollout, two
 * for its seconds (D221).
 */
export const MAX_HEADER_LINES_IN_FLIGHT = 524_288;

/**
 * The most header lines a request to the application listener may carry, the
 * `Host` line included; Node refuses one with more `431` before any route
 * (D213). The receive listener has no such limit: a webhook is stored with
 * every header it carries, within Node's 16 KiB (D187).
 */
export const MAX_API_HEADER_LINES = 100;

/**
 * The largest body a route of the application listener that takes none reads,
 * in bytes: the four deletions, the queue's restart, and the not-found route
 * (D213). Such a body is still checked by the rules it was before - one
 * declared `application/json` must parse, a media type with no parser is
 * refused - and then dropped; a larger one is refused `413` / `1004`, unread
 * when its length is declared. The routes that read a body keep the 1 MiB of
 * `MAX_BODY_BYTES`.
 */
export const MAX_IGNORED_BODY_BYTES = 1024;

/**
 * How many list answers with bodies one backend process writes at once,
 * across `GET .../requests` and `POST .../requests/query`; the next is refused
 * `429` / `1016`, not queued. Per process: one outside a rollout, two for its
 * seconds (D201, D221).
 */
export const MAX_CONCURRENT_BODY_LISTS = 4;

/** The `Retry-After` of that refusal, in seconds (D201). */
export const BODY_LISTS_RETRY_AFTER_SECONDS = 1;

/**
 * A body of `PUT /api/sessions/:sessionId/queue`, `PUT
 * /api/sessions/:sessionId/rules` or `POST /api/sessions` - and of the other
 * routes D213 and D246 list - declared larger than this many bytes - or sent
 * chunked, with no length declared - is a large one, and takes one of the
 * places counted by `MAX_CONCURRENT_LARGE_BODIES` before it is read (D205). A
 * creation with no body, a response alone written as its own UTF-8, a queue
 * of a few steps and rules of a few ordinary responses are all smaller, and
 * never take one.
 */
export const LARGE_BODY_THRESHOLD_BYTES = 128 * 1024;

/**
 * How many large bodies one backend process handles at once across those
 * routes, from the moment their headers arrive until their answers end; the
 * next is refused `429` / `1017`, not queued. Per process: one outside a
 * rollout, two for its seconds (D205, D221).
 */
export const MAX_CONCURRENT_LARGE_BODIES = 8;

/** The `Retry-After` of that refusal, in seconds (D205). */
export const LARGE_BODIES_RETRY_AFTER_SECONDS = 1;

/**
 * What the webhooks being received by one backend process may weigh at once,
 * in bytes (D210): a webhook weighs its declared body, at most 1 MiB, plus
 * 16 KiB, 256 bytes a header line and `MAX_RESPONSE_BODY_BYTES` for its
 * answer. One that does not fit waits, first come first served, with its body
 * unread; a light sender's may go in past it, within
 * `CAPTURE_LIGHT_RESERVE_BYTES` (D261). Per process: one outside a rollout,
 * two for its seconds (D074, D221).
 */
export const CAPTURE_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * What the webhooks being received from one address may weigh at once, in
 * bytes, within `CAPTURE_BUDGET_BYTES` (D210). The address is the sender's, an
 * IPv6 address counted by its `/64`, as the API's limits count one (D201).
 */
export const CAPTURE_BUDGET_PER_ADDRESS_BYTES = 16 * 1024 * 1024;

/**
 * What an address may hold of the capture budget, the webhook being admitted
 * included, and still be a light sender, in bytes (D261): a light sender's
 * webhook may go in past `CAPTURE_BUDGET_BYTES`, within
 * `CAPTURE_LIGHT_RESERVE_BYTES`, and before any heavier sender's waiting.
 */
export const CAPTURE_LIGHT_SENDER_BYTES = 12 * 1024 * 1024;

/**
 * What the light senders' webhooks may hold past `CAPTURE_BUDGET_BYTES`, in
 * bytes (D261): with it no admission takes the webhooks being received by one
 * backend process past 80 MiB, and no other sender's past 64 MiB.
 */
export const CAPTURE_LIGHT_RESERVE_BYTES = 16 * 1024 * 1024;

/**
 * How long a webhook waits for its place, in milliseconds, before it is
 * refused `503` / `1018` (D210).
 */
export const CAPTURE_WAIT_MS = 30_000;

/** The `Retry-After` of that refusal, in seconds (D210). */
export const CAPTURES_BUSY_RETRY_AFTER_SECONDS = 1;

/**
 * What the webhooks waiting for a place in the capture budget may weigh at
 * once in one backend process, in bytes (D228): a waiting webhook weighs its
 * header part, 16 KiB and 256 bytes a header line. One that must wait and does
 * not fit is refused `503` / `1018` at once, unless it is the only one of its
 * address waiting. Per process: one outside a rollout, two for its seconds
 * (D074, D221).
 */
export const CAPTURE_WAITING_BYTES = 64 * 1024 * 1024;

/**
 * What the webhooks waiting from one address may weigh at once, in bytes,
 * within `CAPTURE_WAITING_BYTES` (D228). The address is counted as the capture
 * budget counts it, an IPv6 address by its `/64` (D210).
 */
export const CAPTURE_WAITING_PER_ADDRESS_BYTES = 16 * 1024 * 1024;

/**
 * How many refused webhook bodies one backend process reads and discards at
 * once before answering their refusals (D143, D228): the `1018` refusals on
 * the receive host and the `410` / `1009` of `/s/...` on the application
 * listener (D187) share them; with none free a refusal is answered at once
 * and its connection ends. The application listener's other refusals drain
 * while their call holds one of its address's 128 places of calls in flight
 * instead (D213).
 */
export const MAX_CONCURRENT_REFUSAL_DRAINS = 8;

/** Body of `POST /api/sessions/:sessionId/requests/search` (D191). */
export interface RequestSearchBody {
  /**
   * 1 to `SEARCH_MAX_WORDS` strings of `SEARCH_MIN_WORD_BYTES` to
   * `SEARCH_MAX_WORD_BYTES` bytes each. Each is looked for on its own, as the
   * exact bytes of its UTF-8 encoding: case-sensitive, no pattern syntax.
   */
  words: string[];
}

/** Response of `POST /api/sessions/:sessionId/requests/search` (D191). */
export interface RequestSearchResult {
  /**
   * One list per word, in the order of `words`: the ids of the session's
   * requests whose raw request contains that word, newest first. Ids only -
   * the search returns no part of a body or a header (D037).
   */
  matches: string[][];
}

/**
 * What a list may carry beyond its metadata, asked for with `include` on
 * `GET /api/sessions/:sessionId/requests` and in the body of
 * `POST /api/sessions/:sessionId/requests/query` (D196).
 */
export const REQUEST_LIST_INCLUDES = ['headers', 'body'] as const;

export type RequestListInclude = (typeof REQUEST_LIST_INCLUDES)[number];

/** The two orders a list can be asked in; `desc`, newest first, is the default (D056). */
export const REQUEST_LIST_ORDERS = ['desc', 'asc'] as const;

export type RequestListOrder = (typeof REQUEST_LIST_ORDERS)[number];

/** The largest `limit`: every request a session can hold (D006). */
export const REQUEST_LIST_MAX_LIMIT = MAX_REQUESTS_PER_SESSION;

/**
 * At most this many requests in one answer that includes bodies, and the
 * default `limit` when bodies are included; a larger `limit` is refused. With
 * bodies of at most 1 MiB (D008), an answer carries at most 20 MiB of stored
 * bodies (D196).
 */
export const REQUEST_LIST_MAX_WITH_BODIES = 20;

/**
 * The longest `wait` of `GET /api/sessions/:sessionId/requests`, in seconds
 * (D200): an integer from 1 to this. It stays well under Traefik's 60 s
 * `readTimeout` and the backend's 90 s `requestTimeout` (D172). It equals the
 * longest configured response delay (`MAX_RESPONSE_DELAY_MS`) today, by choice
 * rather than by rule: either can change without the other.
 */
export const REQUEST_LIST_MAX_WAIT_SECONDS = 30;

/**
 * The limits of the conditions of `POST /api/sessions/:sessionId/requests/query`
 * (D196): at most 8 in all, a header name of 1 to 200 bytes and a value of 0 to
 * 200 bytes of UTF-8. A body condition is measured as a search word is, 3 to
 * 200 bytes (`SEARCH_MIN_WORD_BYTES`, `SEARCH_MAX_WORD_BYTES`, D191).
 */
export const REQUEST_QUERY_MAX_CONDITIONS = 8;
export const REQUEST_QUERY_MAX_HEADER_NAME_BYTES = 200;
export const REQUEST_QUERY_MAX_HEADER_VALUE_BYTES = 200;

/** What `include=headers` adds to a list item: the pairs as the detail gives them (D045). */
export interface RequestListHeaders {
  headers: [string, string][];
}

/** What `include=body` adds to a list item, under the detail's rule (D043). */
export interface RequestListBody {
  body: string | null;
  bodyBase64: string | null;
  isBinary: boolean;
}

/**
 * One item of the answer of `GET /api/sessions/:sessionId/requests` and of
 * `POST /api/sessions/:sessionId/requests/query`: the list metadata, plus
 * exactly the fields `include` asked for and no others (D196).
 */
export type RequestListEntry = RequestListItem &
  Partial<RequestListHeaders> &
  Partial<RequestListBody>;

/** A header condition of a query: the name ASCII case-insensitively, the value whole (D196). */
export interface RequestQueryHeaderCondition {
  name: string;
  value: string;
}

/**
 * Body of `POST /api/sessions/:sessionId/requests/query` (D196). Every key is
 * optional; `after`, `since`, `limit`, `order` and `include` mean what the
 * query parameters of the list mean. The conditions combine with AND.
 */
export interface RequestQueryBody {
  headers?: RequestQueryHeaderCondition[];
  /** Each string's UTF-8 bytes must occur in the stored body, exactly. */
  body?: string[];
  after?: string;
  since?: string;
  limit?: number;
  order?: RequestListOrder;
  include?: RequestListInclude[];
}

/**
 * The response a custom session answers every webhook with (D099). Chosen at
 * session creation and changeable while the session runs, through
 * `PUT /api/sessions/:sessionId/response` (D150).
 *
 * Every optional field is carried at its effective value rather than omitted,
 * so a reader never has to tell "absent" apart from "default" (D101).
 */
export interface ResponseConfig {
  /** One final HTTP response, 200-599 inclusive. */
  status: number;
  /** Ordered [name, value] pairs, duplicates preserved and sent in order (D045). */
  headers: [string, string][];
  /**
   * The exact text to return, any format (D179), or `null` for a response with
   * no body. An empty string is never stored: it is saved as `null`.
   */
  body: string | null;
  delayMs: number;
  /**
   * Whether `body` is a template (D251): its placeholders, `{{request.id}}`
   * and the rest of `@webhook-inspector/shared/response-template`, are replaced with
   * values of the request each answer is for. `false` sends the body exactly
   * as configured (D100, D179), and is what a request that leaves it out
   * saves.
   */
  template: boolean;
}

/** The most steps a response queue holds (D205). */
export const MAX_QUEUE_STEPS = 10;

/**
 * A session's response queue (D205): up to `MAX_QUEUE_STEPS` responses that
 * answer the next captured requests one each, in order, before the session
 * response answers again.
 */
export interface ResponseQueue {
  /** The steps in order, each at its effective values, as `response` is (D101). */
  steps: ResponseConfig[];
  /**
   * The position, 1-based, of the step the next captured request gets, or
   * `null` when every step has answered and the session response answers the
   * next one. Saving the queue, restarting it and clearing the requests set it
   * to `1`.
   */
  next: number | null;
  /** How many steps the queue holds: `steps.length`. */
  total: number;
}

/** The most response rules a session holds (D246). */
export const MAX_RESPONSE_RULES = 20;

/**
 * The longest path pattern of a response rule (D246): 1024 characters of
 * visible ASCII, one byte each, which is all a pattern may hold, as all a
 * request's path holds. Far above any path an API is called on, and a
 * sixteenth of the 16 KiB that bound a request's whole head (D142), so twenty
 * patterns cost a capture little.
 */
export const MAX_RULE_PATH_BYTES = 1024;

/**
 * The methods a response rule may name (D246): every method the receiver
 * captures (D139) - Node's `http.METHODS` but `CONNECT`, which no route ever
 * sees - written as Node gives them, in upper case. A backend test pins the
 * list to the receiver's.
 */
export const RESPONSE_RULE_METHODS: readonly string[] = [
  'ACL',
  'BIND',
  'CHECKOUT',
  'COPY',
  'DELETE',
  'GET',
  'HEAD',
  'LINK',
  'LOCK',
  'M-SEARCH',
  'MERGE',
  'MKACTIVITY',
  'MKCALENDAR',
  'MKCOL',
  'MOVE',
  'NOTIFY',
  'OPTIONS',
  'PATCH',
  'POST',
  'PROPFIND',
  'PROPPATCH',
  'PURGE',
  'PUT',
  'QUERY',
  'REBIND',
  'REPORT',
  'SEARCH',
  'SOURCE',
  'SUBSCRIBE',
  'TRACE',
  'UNBIND',
  'UNLINK',
  'UNLOCK',
  'UNSUBSCRIBE',
];

/**
 * One response rule of a session (D246): a request with this method - any
 * method when `method` is `null` - whose path under `/s/<session-id>` matches
 * `path` is answered with `response`, and takes no step of the queue. `path`
 * is an exact path, or a prefix when it ends in `*`, compared literally with
 * the path as stored (D173): nothing decoded or normalised, case-sensitive,
 * the query not part of it, and `/` for the session's own URL with or
 * without its trailing slash. Visible ASCII only, any other character written
 * percent-encoded, as a request sends it.
 */
export interface ResponseRule {
  method: string | null;
  path: string;
  /** At its effective values, as `response` is (D101). */
  response: ResponseConfig;
}

/**
 * What a session answers, and what it keeps (D102 as amended by D151, D205
 * and D246).
 *
 * The same fields are carried by `GET /api/sessions/:sessionId`, by the
 * answers of `PUT /api/sessions/:sessionId/response`, of the queue's three
 * calls and of `PUT /api/sessions/:sessionId/rules`, and by
 * `session.updated`, so none of them can describe a session differently.
 */
export interface SessionResponseState {
  /**
   * The response the session answers with: the custom one while it is active,
   * `null` while the session answers the default. Its meaning is unchanged from
   * before responses could be changed, which is what keeps a client built
   * before D151 correct.
   */
  response: ResponseConfig | null;
  /**
   * The custom response saved on the session, active or not, or `null` when the
   * session has never had one. Picking the default keeps it here, and switching
   * back to custom restores it (D151). Equal to `response` while it is active.
   */
  customResponse: ResponseConfig | null;
  /**
   * The response queue layered over `response`, or `null` when the session
   * has none (D205). A used-up queue stays here, with `next` `null`, until it
   * is removed.
   */
  queue: ResponseQueue | null;
  /**
   * The response rules, in the order they are matched, `[]` when the session
   * has none (D246). A request the first matching rule answers takes no step
   * of `queue`; one no rule matches is answered by `queue`, then `response`.
   */
  rules: ResponseRule[];
}

/**
 * Response of `GET /api/sessions/:sessionId`. It never carries `accessKey`:
 * a key is answered once, by the creation that drew it (D253).
 */
export interface SessionDetails extends SessionIdentity, SessionResponseState {
  requestsCount: number;
  /**
   * The rule the session expires by (D242): for a session that slides, its
   * idle window in seconds - `SESSION_IDLE_WINDOW_MAX_SECONDS` for every
   * session created without `expiresAfterIdleSeconds` - and `null` for a
   * session created with a lifetime, which never slides (D220).
   */
  expiresAfterIdleSeconds: number | null;
  /**
   * The fixed end of a session created with a lifetime, UTC ISO 8601 and equal
   * to `expiresAt`, or `null` for a session that slides (D220, D242).
   */
  lifetimeEndsAt: string | null;
  /**
   * Whether the session's captures keep the sender's address (D243): `false`
   * for a session created with `storeSourceIp: false`, whose requests carry
   * `sourceIp: null`; `true` for every other, those created before the key
   * existed included. Set at creation only.
   */
  storeSourceIp: boolean;
}

/**
 * The most session ids one status read takes (D199), and the most sessions
 * the home page's list keeps in a browser, so the whole list is read in one
 * call.
 */
export const MAX_SESSION_STATUS_IDS = 50;

/** Body of `POST /api/sessions/status` (D199). */
export interface SessionStatusBody {
  /** 1 to `MAX_SESSION_STATUS_IDS` well-formed, distinct session ids. */
  ids: string[];
}

/**
 * What a status read says about one session (D199). Reading it is not a use
 * of the session: nothing here moves its expiry (D133).
 */
export type SessionStatus =
  | {
      id: string;
      state: 'active';
      /** The session's webhook URL, as `GET /api/sessions/:sessionId` gives it (D187). */
      receiveUrl: string;
      requestsCount: number;
      /** When the newest request it holds was received, UTC ISO 8601, or `null` for none. */
      lastRequestAt: string | null;
      /**
       * When the session was last used: `expiresAt` minus the session's own
       * idle window (D242), `SESSION_IDLE_DAYS` unless it was created with
       * `expiresAfterIdleSeconds`, so accurate to within the time a use may
       * leave the expiry unmoved: an hour, or a tenth of a window shorter than
       * 10 hours (D150, D242). For a session created with a lifetime, whose
       * expiry no use moves, the later of its creation and its newest request
       * (D220). UTC ISO 8601.
       */
      lastUsedAt: string;
    }
  | { id: string; state: 'expired' }
  | { id: string; state: 'not_found' };

/** Response of `POST /api/sessions/status` (D199): one entry per id, in request order. */
export interface SessionStatusResult {
  sessions: SessionStatus[];
}

/**
 * The limits a response configuration is validated against at session creation
 * (D101). The backend is authoritative; the frontend checks the same values so
 * that a mistake is reported before the request is sent.
 *
 * Every size is a count of UTF-8 bytes, never of characters, and every multiple
 * is binary (1 KiB = 1024 bytes).
 */
export const RESPONSE_STATUS_MIN = 200;
export const RESPONSE_STATUS_MAX = 599;

/** Statuses that forbid a body: configuring one with a body is rejected. */
export const STATUSES_WITHOUT_BODY = [204, 205, 304];

export const MAX_RESPONSE_HEADERS = 20;
export const MAX_HEADER_NAME_BYTES = 128;
export const MAX_HEADER_VALUE_BYTES = 1024;
/** Sum of `name: value\r\n` over the configured pairs only. */
export const MAX_HEADER_BLOCK_BYTES = 8192;
export const MAX_RESPONSE_BODY_BYTES = 65536;
export const MAX_RESPONSE_DELAY_MS = 30000;

/** The RFC 9110 token charset, which is what a header name may contain. */
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * A header value is visible ASCII plus space and tab, so that CR and LF cannot
 * appear: a value carrying them is a response-splitting primitive. An empty
 * value is allowed, as RFC 9110 permits.
 */
export const HEADER_VALUE_MIN_CODE = 0x20;
export const HEADER_VALUE_MAX_CODE = 0x7e;
export const HEADER_VALUE_TAB_CODE = 0x09;

/**
 * Header names a configuration may not set, compared case-insensitively and
 * listed in lower case. A deny-list: any name not here is permitted (D101),
 * `Location` apart, as below. `Content-Type` left the list with D179: it is configured like any other
 * header, and `Content-Security-Policy`, which stays on it, is what keeps a
 * configured `text/html` from running in the product's origin. `Location`
 * left it with D247 for the rule of `locationHeaderProblem`; `Refresh` stays.
 */
export const RESERVED_RESPONSE_HEADERS = [
  'content-length',
  'content-encoding',
  'x-content-type-options',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'host',
  'set-cookie',
  'refresh',
  'alt-svc',
  'www-authenticate',
  'proxy-authenticate',
  'clear-site-data',
  'strict-transport-security',
  'content-security-policy',
  'content-security-policy-report-only',
  'public-key-pins',
  'access-control-allow-credentials',
  'nel',
  'report-to',
  'reporting-endpoints',
  // The receiver's own header under the service's name (D279), which the
  // prefix below does not cover; `REQUEST_ID_HEADER`.
  'x-webhook-inspector-request-id',
];

/** Our own namespace, reserved as a prefix rather than as a single name. */
export const RESERVED_RESPONSE_HEADER_PREFIX = 'x-qa-tools-';

/**
 * The header every stored webhook is answered with, carrying the stored
 * request's id (D100), under the service's name since 1.19.0 (D279). Sent
 * beside `OLD_REQUEST_ID_HEADER`, with the same value, on every kind of
 * answer; reserved, as the last name of `RESERVED_RESPONSE_HEADERS`, and,
 * like it, outside the configured header budget.
 */
export const REQUEST_ID_HEADER = 'x-webhook-inspector-request-id';

/**
 * The request-id header's old name, sent beside `REQUEST_ID_HEADER` until
 * the day the changelog's 1.19.0 entry gives (D279), and reserved by
 * `RESERVED_RESPONSE_HEADER_PREFIX`.
 *
 * @deprecated Use `REQUEST_ID_HEADER`; removed with the old names (D279).
 */
export const OLD_REQUEST_ID_HEADER = 'x-qa-tools-request-id';

/**
 * The one header name a configuration may set only on a redirect, with a
 * target of one form (D247), compared case-insensitively.
 */
export const LOCATION_HEADER = 'location';
/** The statuses a configured `Location` is allowed with, inclusive: every `3xx` (D247). */
export const LOCATION_STATUS_MIN = 300;
export const LOCATION_STATUS_MAX = 399;
/**
 * What a configured `Location` value must begin with, compared literally and
 * case-sensitively: a path on the host that answered, under `/s/` (D247). No
 * absolute URL, no other path, no scheme and no leading space; widening the
 * rule later is additive, narrowing it would not be (D212).
 */
export const LOCATION_TARGET_PREFIX = '/s/';

/** Why a configured header breaks the `Location` rule (D247). */
export type LocationHeaderProblem = 'status' | 'target';

/**
 * The `Location` rule (D247), one predicate for the backend's validator and the
 * frontend's form, so the two cannot drift: `null` for any other header name,
 * and for a `Location` whose status is 300 to 399 and whose value begins with
 * `/s/`; otherwise which of the two it breaks, the status first. `status` is
 * `null` when it is not known to be a valid one yet, as in a form whose status
 * field is wrong, and then only the target is judged.
 *
 * The value's other rules - at most 1024 bytes of visible ASCII, space and tab
 * - are the header rules every value is held to, and run before this one. The
 * check is a prefix comparison, so its cost is bounded by the prefix whatever
 * the value's length.
 */
export function locationHeaderProblem(
  name: string,
  value: string,
  status: number | null,
): LocationHeaderProblem | null {
  if (name.toLowerCase() !== LOCATION_HEADER) {
    return null;
  }

  if (status !== null && (status < LOCATION_STATUS_MIN || status > LOCATION_STATUS_MAX)) {
    return 'status';
  }

  return value.startsWith(LOCATION_TARGET_PREFIX) ? null : 'target';
}

/**
 * Sent once, as the first message, when the connection has been subscribed to
 * its session and no capture can be missed any more. The client reloads the
 * request list on this event rather than on the transport-level open, which
 * happens earlier (D081).
 */
export interface ReadyEvent {
  type: 'ready';
}

/**
 * The single request event of v0.1: one newly captured request, carrying the
 * list metadata needed to insert its row and nothing more. Bodies and full
 * headers stay on the detail endpoint (D013, D037).
 */
export interface RequestReceivedEvent {
  type: 'request.received';
  data: RequestListItem;
}

/**
 * One response record reaching a terminal state: `pending` became `sent`,
 * `aborted` or `failed` (D110).
 *
 * It carries the light summary rather than a list row, so a client that does
 * not already hold this id ignores the event silently and never creates a row:
 * `request.received` stays the only event that may add one. Nothing is
 * published on `pending -> unknown`, which is derived at read time and never
 * stored (D109).
 */
export interface ResponseRecordedEvent {
  type: 'response.recorded';
  data: { id: string; response: ResponseSummary };
}

/**
 * One captured request was deleted through `DELETE .../requests/:requestId`.
 *
 * Published by the route after the deletion succeeded, so a `404` publishes
 * nothing. Every declaring viewer of the session receives it, the one that
 * deleted included, and applies it idempotently (D136): the row is dropped by
 * id, and a detail panel showing that request closes (D137). An id the viewer
 * does not hold changes nothing.
 */
export interface RequestDeletedEvent {
  type: 'request.deleted';
  data: { id: string };
}

/**
 * Every request of the session was deleted through `DELETE .../requests`.
 *
 * Carries no `data`, like `ready`. Published on every `204`, including a clear
 * of a session that held nothing: emptying an empty list changes nothing.
 */
export interface RequestsClearedEvent {
  type: 'requests.cleared';
}

/**
 * The session's response was changed through `PUT .../response` (D152), its
 * response queue was set, restarted or removed (D205), or its response rules
 * were saved through `PUT .../rules` (D246).
 *
 * Carries the whole new state, the fields the session read carries, so a
 * viewer replaces what it holds rather than merging a difference. A capture
 * that takes a step of the queue and a clear that starts it again publish no
 * `session.updated`: the viewer moves the queue's `next` itself, from the
 * `queueStep` of `request.received` and from `requests.cleared`. Every
 * declaring viewer receives it, the one that made the change included: applying
 * a state twice changes nothing, so no origin is tracked (D136). A viewer with
 * a settings form open keeps what was typed in it (last write wins).
 */
export interface SessionUpdatedEvent {
  type: 'session.updated';
  data: SessionResponseState;
}

/** Everything the session WebSocket can send. The client sends nothing (D074). */
export type ServerEvent =
  | ReadyEvent
  | RequestReceivedEvent
  | ResponseRecordedEvent
  | RequestDeletedEvent
  | RequestsClearedEvent
  | SessionUpdatedEvent;

/**
 * The query parameter a connection declares its optional events with, on the
 * existing socket URL: `/ws/:sessionId?events=response.recorded` (D115).
 *
 * An absent parameter means exactly the event types of v0.4.0, which is what
 * makes every already-built client correct without changing it.
 */
export const REALTIME_EVENTS_PARAM = 'events';

/**
 * How a connection to a keyed session presents its access key (D245): as a
 * subprotocol of the handshake, this prefix followed by the key, never in the
 * URL, whose path and query the log keeps (D168). A browser cannot set
 * `Authorization` on a socket, and a handshake refused for a key refuses as
 * one for a session that does not exist, with no message to wait for.
 *
 * The server never echoes the key's subprotocol. A browser fails a handshake
 * that offered subprotocols and was answered none, so a client offers
 * `REALTIME_PROTOCOL` beside the key, which the server echoes:
 * `new WebSocket(url, [REALTIME_PROTOCOL, REALTIME_ACCESS_KEY_PROTOCOL_PREFIX + key])`.
 * A connection to a public session needs neither.
 *
 * The service's name since 1.19.0 (D279); the server takes the old prefix,
 * `OLD_REALTIME_ACCESS_KEY_PROTOCOL_PREFIX`, as well until the day the
 * changelog's 1.19.0 entry gives.
 */
export const REALTIME_ACCESS_KEY_PROTOCOL_PREFIX = 'webhook-inspector.access-key.';

/** The subprotocol offered beside the key's, which the server echoes (D245, D279). */
export const REALTIME_PROTOCOL = 'webhook-inspector';

/**
 * The key's subprotocol prefix before 1.19.0, still taken until the day the
 * changelog's 1.19.0 entry gives (D279). The page offers the key under it as
 * well, after the new one, so that a backend of an earlier release, which
 * reads only this prefix, opens the session during a rollout.
 *
 * @deprecated Use `REALTIME_ACCESS_KEY_PROTOCOL_PREFIX`; removed with the old names (D279).
 */
export const OLD_REALTIME_ACCESS_KEY_PROTOCOL_PREFIX = 'qa-tools.access-key.';

/**
 * The subprotocol offered beside the key's before 1.19.0, which the server
 * still echoes when it is the first offered that carries no key (D245, D279).
 *
 * @deprecated Use `REALTIME_PROTOCOL`; removed with the old names (D279).
 */
export const OLD_REALTIME_PROTOCOL = 'qa-tools';

/**
 * The optional event types that reach a connection only if it declared them.
 *
 * Defined exactly once, here, and imported by both sides. A second copy is how
 * the gate inverts itself by accident: a type added to one list and missing
 * from the other is sent to everyone or to nobody, with nothing erroring
 * (D115). Every type not listed here reaches every connection.
 *
 * `request.deleted` and `requests.cleared` are negotiable too (D135), and so is
 * `session.updated` (D152): an absent parameter still means exactly the event
 * set of v0.4.0.
 */
export const NEGOTIABLE_EVENT_TYPES = [
  'response.recorded',
  'request.deleted',
  'requests.cleared',
  'session.updated',
] as const;

export type NegotiableEventType = (typeof NEGOTIABLE_EVENT_TYPES)[number];

/**
 * How long past its own `delayMs` a `pending` record may sit before it reads
 * `unknown` (D109).
 *
 * One definition, so the list endpoint, the detail endpoint and the WebSocket
 * payload cannot disagree about when a row has aged out.
 */
export const RESPONSE_UNKNOWN_GRACE_MS = 60_000;

/**
 * Close codes the session WebSocket uses to refuse a connection, in the range
 * reserved for applications. They mirror the HTTP answers a session-scoped
 * route would give, so the viewer can tell a closed session from a lost
 * network (D076). `SESSION_NOT_FOUND` also closes every open connection of a
 * session deleted through the API (D198).
 */
export const WsCloseCode = {
  SESSION_NOT_FOUND: 4404,
  SESSION_EXPIRED: 4410,
} as const;

export type WsCloseCode = (typeof WsCloseCode)[keyof typeof WsCloseCode];
