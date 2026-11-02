import {
  BODY_LISTS_RETRY_AFTER_SECONDS,
  CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS,
  CAPTURES_BUSY_RETRY_AFTER_SECONDS,
  ErrorCode,
  LARGE_BODIES_RETRY_AFTER_SECONDS,
  REALTIME_CONNECTIONS_RETRY_AFTER_SECONDS,
  SEARCH_BUSY_RETRY_AFTER_SECONDS,
} from '@webhook-inspector/shared';

/**
 * An error that carries the API contract from `docs/API.md`: a stable numeric
 * code (D040) and the HTTP status it maps to. Anything else reaching the error
 * handler is treated as an internal failure.
 */
export class AppError extends Error {
  readonly errorCode: ErrorCode;
  readonly statusCode: number;
  /**
   * Headers the answer carries besides the error body, such as the
   * `Retry-After` of a refusal by a limit (D201). The error handler sets them.
   */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Where in the request body the refused value sits, such as
   * `rules[1].path`, for a `1005` that names a place (D257). The error handler
   * writes it beside the message; every other error has none.
   */
  readonly field: string | undefined;

  constructor(
    errorCode: ErrorCode,
    statusCode: number,
    message: string,
    headers: Readonly<Record<string, string>> = {},
    field?: string,
  ) {
    super(message);
    this.name = 'AppError';
    this.errorCode = errorCode;
    this.statusCode = statusCode;
    this.headers = headers;
    this.field = field;
  }
}

/**
 * Used both for a session that does not exist and for an id that cannot be one,
 * so that a malformed id reveals nothing a wrong id would not (D058).
 */
export function sessionNotFound(): AppError {
  return new AppError(ErrorCode.SESSION_NOT_FOUND, 404, 'Session not found');
}

export function routeNotFound(): AppError {
  return new AppError(ErrorCode.ROUTE_NOT_FOUND, 404, 'Not found');
}

/**
 * Used for a request that does not exist, an id that cannot be one, and a
 * request belonging to a different session. The three are deliberately
 * indistinguishable from outside (D066).
 */
export function requestNotFound(): AppError {
  return new AppError(ErrorCode.REQUEST_NOT_FOUND, 404, 'Request not found');
}

export function sessionExpired(): AppError {
  return new AppError(ErrorCode.SESSION_EXPIRED, 410, 'Session expired');
}

/**
 * A webhook sent to `/s/...` on the application's own host, which stopped
 * receiving them in 0.36.0: they are received on the receive host only
 * (D187). The message names the URL to send to instead; the caller composes
 * it from configuration and a session id it has checked, never from anything
 * else the request carried (D106).
 */
export function receiveUrlMoved(message: string): AppError {
  return new AppError(ErrorCode.RECEIVE_URL_MOVED, 410, message);
}

/**
 * A response configuration that breaks one of the rules in D101. The message
 * names the field and the rule and never echoes the offending value, so a
 * 64 KiB body or a 1 KiB header value cannot land in an error response (D106).
 *
 * `field` locates the refused value in the body, in the notation the message
 * begins with - dotted keys the API defines and positions counted from 0, a
 * header pair's name `[0]` and its value `[1]` - and is answered beside it
 * (D257). The caller builds it from those alone, never from a key or a value
 * the client sent, and leaves it out for a refusal about the body as a whole.
 */
export function invalidResponseConfig(message: string, field?: string): AppError {
  return new AppError(ErrorCode.INVALID_RESPONSE_CONFIG, 400, message, {}, field);
}

/**
 * A request body declared as JSON that is empty, unparseable, or not a JSON
 * object. The top-level shape of the body is a request-body concern, which is
 * what this code is named for (D104).
 */
export function malformedRequestBody(): AppError {
  return new AppError(ErrorCode.MALFORMED_REQUEST_BODY, 400, 'Request body must be a JSON object');
}

/**
 * A search whose `words` break a rule: not an array, too few or too many, an
 * entry that is not a string, or one too short or too long (D191). The message
 * names the rule and never echoes a word: a word is what the tester is looking
 * for in captured data, and it must reach neither an error body nor a log
 * (D106).
 */
export function invalidSearchWords(message: string): AppError {
  return new AppError(ErrorCode.INVALID_SEARCH_WORDS, 400, message);
}

/**
 * A list or query of requests asked for wrongly (D196): an unknown, repeated
 * or invalid query parameter of `GET .../requests`, or an unknown key or an
 * invalid field or condition in the body of `POST .../requests/query`. The
 * message names the parameter or field and the rule, and never echoes a
 * value: a condition is what the tester is looking for in captured data, and
 * it must reach neither an error body nor a log (D106).
 */
export function invalidListQuery(message: string): AppError {
  return new AppError(ErrorCode.INVALID_LIST_QUERY, 400, message);
}

/**
 * A status read whose `ids` or `accessKeys` break a rule (D199, D253): not an
 * array, none or more than 50, an entry that is not a well-formed session id,
 * a repeated id, a malformed `accessKeys`, or a key other than those two. The
 * message names the field and the rule and never quotes an id or a key: an id
 * opens a public session and a key a private one (D004, D106, D245).
 */
export function invalidSessionIds(message: string): AppError {
  return new AppError(ErrorCode.INVALID_SESSION_IDS, 400, message);
}

/**
 * A search cancelled by its own statement timeout (D191). `503`: nothing is
 * wrong with the request, and the same one may succeed later or on a smaller
 * session.
 */
export function searchTimedOut(): AppError {
  return new AppError(
    ErrorCode.SEARCH_TIMED_OUT,
    503,
    'The search took too long and was cancelled',
  );
}

/**
 * A search or a query of requests refused because this process is already
 * running as many of its kind as it allows: the search's count, or the count
 * of queries with no body condition (D191, D250). Refused at once, never
 * queued, with `Retry-After: 1`.
 */
export function searchBusy(): AppError {
  return new AppError(
    ErrorCode.SEARCH_BUSY,
    429,
    'Too many searches are running; try again in a moment',
    { 'retry-after': String(SEARCH_BUSY_RETRY_AFTER_SECONDS) },
  );
}

/**
 * A call over its address's limit for the window (D201). `limit` names the
 * limit, such as `60 session creations per minute`; `Retry-After` is the
 * seconds until the window ends. The message never names the address, which
 * is neither logged nor answered because of a limit.
 */
export function rateLimitExceeded(limit: string, retryAfterSeconds: number): AppError {
  return new AppError(
    ErrorCode.RATE_LIMIT_EXCEEDED,
    429,
    `Rate limit exceeded: ${limit} per address; try again in ${retryAfterSeconds} s`,
    { 'retry-after': String(retryAfterSeconds) },
  );
}

/**
 * A list answer with bodies refused because this process is already writing
 * as many as it allows (D201). Refused at once, never queued.
 */
export function listBodiesBusy(): AppError {
  return new AppError(
    ErrorCode.LIST_BODIES_BUSY,
    429,
    'Too many lists with bodies are being written; try again in a moment',
    { 'retry-after': String(BODY_LISTS_RETRY_AFTER_SECONDS) },
  );
}

/**
 * A large body of a queue save or a creation refused because this process is
 * already handling as many as it allows (D205). Refused at once, never queued.
 */
export function largeBodiesBusy(): AppError {
  return new AppError(
    ErrorCode.LARGE_BODIES_BUSY,
    429,
    'Too many large bodies are being saved; try again in a moment',
    { 'retry-after': String(LARGE_BODIES_RETRY_AFTER_SECONDS) },
  );
}

/**
 * A call refused because its address already has `limit` calls in flight on
 * the API and `/mcp` together, waits included (D213). Refused at once, never
 * queued. The message names the limit, never the address.
 */
export function tooManyConcurrentCalls(limit: number): AppError {
  return new AppError(
    ErrorCode.TOO_MANY_CONCURRENT_CALLS,
    429,
    `Too many calls in flight: ${limit} at once per address; try again in a moment`,
    { 'retry-after': String(CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS) },
  );
}

/**
 * An answer of the API or of `/mcp` not sent, because the answers not yet
 * written of its address, or of the whole process, already weigh what the
 * answers' byte budget allows (#184, D228, `modules/limits/answer-budget.ts`):
 * `429` / `1019`, as the 129th call in flight is, with `Retry-After: 1`. The
 * call itself has been carried out; only its answer is replaced. The message
 * names the limit - `bytes` in MiB when it is a whole number of them, as in
 * production - never the address.
 */
export function answersNotWritten(scope: 'address' | 'server', bytes: number): AppError {
  const mebibytes = bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} bytes`;

  return new AppError(
    ErrorCode.TOO_MANY_CONCURRENT_CALLS,
    429,
    scope === 'address'
      ? `Too many answers not yet written: ${mebibytes} at once per address; try again in a moment`
      : `Too many answers not yet written: ${mebibytes} at once on the server; try again in a moment`,
    { 'retry-after': String(CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS) },
  );
}

/**
 * A realtime connection refused before its upgrade because its address
 * already has `limit` open (D227). Refused at once, never queued, and its
 * connection ends with the answer: an upgrade's socket is the endpoint's to
 * close, which `@fastify/websocket` does once the answer is written. The
 * browser sees the connection fail, `1006`, and reconnects after its delay
 * (D079). The message names the limit, never the address.
 */
export function tooManyRealtimeConnections(limit: number): AppError {
  return new AppError(
    ErrorCode.TOO_MANY_REALTIME_CONNECTIONS,
    429,
    `Too many realtime connections: ${limit} open at once per address; close one and try again`,
    { 'retry-after': String(REALTIME_CONNECTIONS_RETRY_AFTER_SECONDS), connection: 'close' },
  );
}

/**
 * A webhook refused because it waited 30 s for a place in the receiver's byte
 * budget and none came (D210), or at once because it had to wait and the
 * line waiting for a place had no room for it (D228), which `endsConnection`
 * marks: that answer carries `Connection: close`. `503`: nothing is wrong
 * with the request, and the same one may be captured a moment later. Nothing
 * was stored.
 */
export function capturesBusy(endsConnection = false): AppError {
  return new AppError(
    ErrorCode.CAPTURES_BUSY,
    503,
    'Too many webhooks are being received; try again in a moment',
    {
      'retry-after': String(CAPTURES_BUSY_RETRY_AFTER_SECONDS),
      ...(endsConnection ? { connection: 'close' } : {}),
    },
  );
}

/**
 * Any create request not unambiguously declared `application/json`. The single
 * exemption is the conjunction of no body and no `Content-Type` (D104).
 */
export function unsupportedMediaType(): AppError {
  return new AppError(
    ErrorCode.UNSUPPORTED_MEDIA_TYPE,
    415,
    'Content-Type must be application/json',
  );
}
