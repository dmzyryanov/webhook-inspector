import type {
  CreatedSession,
  ErrorCode,
  RequestDetails,
  RequestListItem,
  RequestSearchBody,
  RequestSearchResult,
  SessionDetails,
  SessionResponseState,
  SessionStatus,
  SessionStatusBody,
} from '@webhook-inspector/shared';
import { parseSessionStatuses } from '../lib/home-view.ts';
import { withListPath, withSourceIp } from '../lib/requests.ts';
import { accessKeyFor, accessKeysFor, isAccessKey } from '../lib/access-keys.ts';
import type { CreateSessionBody, ResponseChangeBody } from '../lib/response-config.ts';
import { parseRetryAfter } from '../lib/retry-after.ts';
import { createSessionInit, type NewSessionOptions } from '../lib/session-options.ts';

/**
 * The API is reached through a relative path. In development the Vite dev
 * server proxies it to the backend, in production the Ingress serves both from
 * one origin (D060), so no base URL is configured anywhere.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly errorCode: ErrorCode | undefined;
  /**
   * The answer's `Retry-After` in whole seconds, at least 1, and `undefined`
   * without a usable one (`parseRetryAfter`, issue #128). The API sends it
   * with its `429` refusals; only the home page's `Generate URL` reads it.
   */
  readonly retryAfterSeconds: number | undefined;
  /**
   * Where in the body sent the server placed its refusal, `rules[1].path`,
   * as `refusalField` keeps it from the answer: only a `1005` carries one
   * (D257), and the dialogs mark the rule or the step it names.
   */
  readonly field: string | undefined;

  constructor(
    status: number,
    errorCode: ErrorCode | undefined,
    message: string,
    retryAfterSeconds?: number,
    field?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.retryAfterSeconds = retryAfterSeconds;
    this.field = field;
  }
}

/**
 * The longest `field` kept from an error answer. The longest the API writes is
 * well under 60 characters (`rules[19].response.headers[19][1]`); anything
 * longer is no place the dialogs could mark, and is dropped unread.
 */
export const MAX_REFUSAL_FIELD_LENGTH = 200;

/**
 * An error answer's `field` as the page keeps it (D257): a string of at most
 * `MAX_REFUSAL_FIELD_LENGTH` characters, or `undefined` for anything else - no
 * key, a number, an object, a longer string - as from a backend before it.
 */
export function refusalField(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !Object.hasOwn(body, 'field')) {
    return undefined;
  }

  const field = (body as { field?: unknown }).field;

  return typeof field === 'string' && field.length <= MAX_REFUSAL_FIELD_LENGTH ? field : undefined;
}

/**
 * A call for one session, carrying its access key when this browser holds one
 * (D245 point 5, D259): `Authorization: Bearer <key>` beside the call's own
 * headers, never in the URL. A public session's call is sent exactly as
 * before, `init` untouched. `key` overrides the held one: the paste field's
 * check of a key before it is kept.
 */
function forSession(sessionId: string, init?: RequestInit, key?: string): RequestInit | undefined {
  const accessKey = key ?? accessKeyFor(sessionId);

  if (accessKey === null || !isAccessKey(accessKey)) {
    return init;
  }

  return {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${accessKey}`,
    },
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      errorCode?: ErrorCode;
      message?: string;
    } | null;

    throw new ApiError(
      response.status,
      body?.errorCode,
      body?.message ?? 'Request failed',
      parseRetryAfter(response.headers.get('Retry-After')),
      refusalField(body),
    );
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/**
 * Creates a session with the home page's options (issue #216, D249): its idle
 * window and whether it keeps the sender's IP. A session's response is
 * configured on its page (D150, D158); the API still creates a session with a
 * `response`, and `/docs` still shows how.
 *
 * With the defaults - no options, or both at their default - it must send
 * **no body and no `Content-Type` at all**. That conjunction is the single
 * exemption from the media-type rule, so adding an empty body or a
 * `Content-Type` header would turn the documented `201` into a `415` / `1007`
 * (D104). A choice sends only the keys that differ, as JSON
 * (`createSessionInit`).
 */
export function createSession(options?: NewSessionOptions): Promise<CreatedSession> {
  return request<CreatedSession>('/sessions', createSessionInit(options));
}

/**
 * Reads a session, with the key this browser holds for it, or with `key`
 * when given: the paste field checks a key that way before keeping it.
 */
export function getSession(sessionId: string, key?: string): Promise<SessionDetails> {
  return request<SessionDetails>(`/sessions/${sessionId}`, forSession(sessionId, undefined, key));
}

/**
 * Reads the status of the sessions the home page lists, without using any of
 * them (D199): unlike `getSession`, it moves no expiry. The ids travel in the
 * body, never in the URL, so no log line holds them. So do the keys of the
 * private ones, in `accessKeys` beside their ids (D245 point 5, D259): only
 * for ids sent, only values of a key's shape, and no `accessKeys` at all when
 * the browser holds none - the body before private sessions, byte for byte.
 * The home page passes the keys it took (`accessKeysFor`), so it judges the
 * answer against the very keys it was sent with (`removeReportedSessions`).
 *
 * A backend still on the image before this route existed answers `404` /
 * `1000`, which the page reads as a read that failed. So is an answer that
 * does not match the documented contract (`parseSessionStatuses`): it is
 * refused here, as a rejection, and nothing of it reaches the page.
 */
export async function readSessionStatuses(
  ids: string[],
  accessKeys: Record<string, string> | null = accessKeysFor(ids),
): Promise<SessionStatus[]> {
  const body: SessionStatusBody & { accessKeys?: Record<string, string> } =
    accessKeys === null ? { ids } : { ids, accessKeys };
  const answer = await request<unknown>('/sessions/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const statuses = parseSessionStatuses(answer, ids);

  if (statuses === null) {
    throw new Error('The status read answered outside its contract');
  }

  return statuses;
}

/**
 * Deletes a session with everything it holds (D198). It takes no body, so it
 * sends none and no `Content-Type` (D104).
 */
export function deleteSession(sessionId: string): Promise<void> {
  return request<void>(`/sessions/${sessionId}`, forSession(sessionId, { method: 'DELETE' }));
}

/**
 * Changes the response of a running session (D150) and answers with the state
 * it now has - the same two fields the session read carries.
 */
export function changeSessionResponse(
  sessionId: string,
  body: ResponseChangeBody,
): Promise<SessionResponseState> {
  return request<SessionResponseState>(
    `/sessions/${sessionId}/response`,
    forSession(sessionId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Saves a response queue and starts it from step 1 (D205); answers with the
 * state the session now has, the queue in it.
 */
export function setSessionQueue(
  sessionId: string,
  steps: CreateSessionBody['response'][],
): Promise<SessionResponseState> {
  return request<SessionResponseState>(
    `/sessions/${sessionId}/queue`,
    forSession(sessionId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps }),
    }),
  );
}

/**
 * Saves the session's response rules, the whole list in order, replacing
 * every rule it had; `[]` removes them all (D246). Answers the state the
 * session now has.
 */
export function setSessionRules(
  sessionId: string,
  rules: {
    method: string | null;
    path: string;
    response: CreateSessionBody['response'];
  }[],
): Promise<SessionResponseState> {
  return request<SessionResponseState>(
    `/sessions/${sessionId}/rules`,
    forSession(sessionId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
    }),
  );
}

/**
 * Starts the saved queue from step 1 again without sending it (D205). It
 * takes no body, so it sends none and no `Content-Type` (D104).
 */
export function restartSessionQueue(sessionId: string): Promise<SessionResponseState> {
  return request<SessionResponseState>(
    `/sessions/${sessionId}/queue/restart`,
    forSession(sessionId, { method: 'POST' }),
  );
}

/** Removes the response queue (D205). No body, as `restartSessionQueue`. */
export function removeSessionQueue(sessionId: string): Promise<SessionResponseState> {
  return request<SessionResponseState>(
    `/sessions/${sessionId}/queue`,
    forSession(sessionId, { method: 'DELETE' }),
  );
}

export async function listRequests(sessionId: string): Promise<RequestListItem[]> {
  const items = await request<RequestListItem[]>(
    `/sessions/${sessionId}/requests`,
    forSession(sessionId),
  );

  return items.map(withListPath);
}

/**
 * Asks the server which of the session's requests hold each word in their raw
 * request - request line, headers and body - as exact bytes (D191). The words
 * travel in the body, never in the URL, so no log line holds what a tester is
 * looking for.
 *
 * A backend still on the image before this route existed answers `404` /
 * `1000`, which the caller reads as a search that failed.
 */
export function searchRequests(sessionId: string, words: string[]): Promise<RequestSearchResult> {
  const body: RequestSearchBody = { words };

  return request<RequestSearchResult>(
    `/sessions/${sessionId}/requests/search`,
    forSession(sessionId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * One request's details, its `sourceIp` read as a list row's is: anything but
 * a string or `null` is read as `null` (`withSourceIp`, issue #245), so the
 * panel's facts line reads `IP unavailable` for it rather than failing to draw.
 */
export async function getRequestDetails(
  sessionId: string,
  requestId: string,
): Promise<RequestDetails> {
  const details = await request<RequestDetails>(
    `/sessions/${sessionId}/requests/${requestId}`,
    forSession(sessionId),
  );

  return withSourceIp(details);
}

export function deleteRequest(sessionId: string, requestId: string): Promise<void> {
  return request<void>(
    `/sessions/${sessionId}/requests/${requestId}`,
    forSession(sessionId, { method: 'DELETE' }),
  );
}

export function clearRequests(sessionId: string): Promise<void> {
  return request<void>(
    `/sessions/${sessionId}/requests`,
    forSession(sessionId, { method: 'DELETE' }),
  );
}
