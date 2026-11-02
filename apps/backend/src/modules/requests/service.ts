import type pg from 'pg';
import type { WaitSlot } from '../limits/api-work.ts';
import {
  SESSION_ID_PATTERN,
  type RequestDetails,
  type RequestListEntry,
  type RequestSearchResult,
  type ResponseRecord,
  type ResponseSummary,
} from '@webhook-inspector/shared';
import {
  requestNotFound,
  searchBusy,
  searchTimedOut,
  sessionExpired,
  sessionNotFound,
} from '../../errors/app-error.ts';
import { PLAIN_LIST, type ListQuery } from './list-query.ts';
import * as repository from './repository.ts';
import { hasResponseRecord, isStatementCancelled } from './repository.ts';
import type {
  DetailRow,
  Listed,
  ListedRow,
  ListPosition,
  ListRow,
  RecordedRow,
  SessionScoped,
} from './repository.ts';
import type { ListedEntry, ListMore, ReadListedContent } from './list-answer.ts';
import {
  readResponseState,
  toRecordedQueueStep,
  toRecordedRule,
  toRecordedRuleSummary,
} from './response-state.ts';
import { requireAccess, type PresentedKey } from '../sessions/access-key.ts';
import type { Slots } from '../../lib/slots.ts';
import { slotsForQuery, type QuerySlots, type SearchSlots } from './search.ts';
import { transportBytes } from './transport.ts';
import { waitForList, type PendingWaits } from './wait.ts';
import type { RealtimeHub } from '../realtime/hub.ts';

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turns the session state reported by the query itself into the documented
 * answers (D067). The state was read by the same statement that performed the
 * operation, so it cannot have changed in between.
 */
function unwrap<T>(result: SessionScoped<T>): T {
  if (result.expired === null) {
    throw sessionNotFound();
  }

  if (result.expired) {
    throw sessionExpired();
  }

  return result.value;
}

function assertSessionIdShape(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw sessionNotFound();
  }
}

function assertRequestIdShape(requestId: string): void {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw requestNotFound();
  }
}

/**
 * The light summary a list row and `response.recorded` carry: state, status,
 * the queue's step and the rule's position that answered, and nothing else,
 * so the list keeps returning no bodies and no full headers (D110, D205,
 * D246).
 *
 * It takes a row the join matched, so "there is no record" is answered once, by
 * `hasResponseRecord`, rather than here as well.
 */
function toResponseSummary(row: RecordedRow<ListRow>): ResponseSummary {
  return {
    state: readResponseState(row.response_state, row.response_delay_ms, row.response_started_at),
    status: row.response_status,
    queueStep: toRecordedQueueStep(row.response_queue_step_index, row.response_queue_step_total),
    rule: toRecordedRuleSummary(row.response_rule_index),
  };
}

/**
 * The whole record, for the detail endpoint only.
 *
 * `body` and `raw` travel under the same UTF-8/Base64 rule as the captured
 * request (D043). A `NULL` body means the response carried none at all and is
 * reported as `null` on all three fields, which is not the same answer as an
 * empty body arriving as an empty string (D109).
 */
function toResponseRecord(row: DetailRow): ResponseRecord | null {
  if (!hasResponseRecord(row)) {
    return null;
  }

  const body = row.response_body === null ? null : transportBytes(row.response_body);
  const raw = row.response_raw === null ? null : transportBytes(row.response_raw);

  return {
    ...toResponseSummary(row),
    // The rule with what it matched on as it was when it answered (D246).
    rule: toRecordedRule(row.response_rule_index, row.response_rule_method, row.response_rule_path),
    headers: row.response_headers,
    body: body?.text ?? null,
    bodyBase64: body?.base64 ?? null,
    isBinary: body?.isBinary ?? false,
    bodySize: row.response_body_size,
    bodySuppressed: row.response_body_suppressed,
    raw: raw?.text ?? null,
    rawBase64: raw?.base64 ?? null,
    isRawBinary: raw?.isBinary ?? false,
    delayMs: row.response_delay_ms,
    startedAt: row.response_started_at.toISOString(),
    completedAt: row.response_completed_at?.toISOString() ?? null,
    durationMs: row.response_duration_ms,
  };
}

/**
 * One list item: the metadata every row carries. What `include` adds is read
 * and written after it, while the answer is streamed (`list-answer.ts`, D196).
 */
function toListEntry(row: ListRow): RequestListEntry {
  return {
    id: row.id as string,
    method: row.method,
    receivedAt: row.received_at.toISOString(),
    bodySize: row.body_size,
    sourceIp: row.source_ip,
    // The list filter matches it; no row shows it (D180).
    path: row.path,
    response: hasResponseRecord(row) ? toResponseSummary(row) : null,
  };
}

/**
 * Checks the ids the list is asked about before any statement runs: one that
 * cannot be a session's is `404` / `1001`, and an `after` that cannot be a
 * request id is `404` / `1003`, as an unknown one is (D066). The routes check
 * them before they take a place for an answer with bodies too (D201), so
 * that such an id is answered without one.
 */
export function assertListIds(sessionId: string, query: ListQuery): void {
  assertSessionIdShape(sessionId);

  if (query.after !== null) {
    assertRequestIdShape(query.after);
  }
}

/** A listed row as the answer writes it, with where it stands for a resumed list. */
function toListedEntry(row: ListedRow): ListedEntry {
  return { entry: toListEntry(row), receivedAt: row.received_exact };
}

/** What a list chose when it began: the requests, and where `after`'s request stood. */
export interface ChosenList {
  chosen: ListedEntry[];
  /** The position of the request `after` named, for a resumed list; `null` without `after`. */
  after: ListPosition | null;
}

/**
 * Turns what the list statement answered into the list, or into the answer
 * for a session that is gone or expired (D067) and for an `after` that is not
 * one of the session's requests: deleted, evicted or never one, `404` / `1003`.
 */
function toList(result: SessionScoped<Listed>): ChosenList {
  const { afterFound, afterPosition, rows } = unwrap(result);

  if (!afterFound) {
    throw requestNotFound();
  }

  return { chosen: rows.map(toListedEntry), after: afterPosition };
}

/**
 * `GET /api/sessions/:sessionId/requests`: with no parameter, the list as it
 * always was (D037); with them, narrowed, capped and ordered as `query` asks
 * (D196). The entries carry metadata alone: what `include` adds is read while
 * the answer is written (`listedContentReader`), and requests gone by then
 * are replaced by those that follow (`listContinuation`). It reads the
 * session and does not use it: `expires_at` stays (D133).
 *
 * `key` is the access key the call presented (D245): a keyed session it does
 * not open is `404` / `1001` before the list is read, as here on every path
 * that reads or changes requests (`requireAccess`).
 */
export async function listRequests(
  pool: pg.Pool,
  sessionId: string,
  query: ListQuery = PLAIN_LIST,
  key: PresentedKey = null,
): Promise<ChosenList> {
  assertListIds(sessionId, query);
  await requireAccess(pool, sessionId, key);

  return toList(await repository.listRequests(pool, sessionId, query));
}

/**
 * `GET /api/sessions/:sessionId/requests?wait=N` (D200): the list as
 * `listRequests` answers it, held while it is empty for up to `query.wait`
 * seconds (`waitForList`), or `null` once `signal` says the client has gone.
 *
 * The ids are checked first, as for the list, and the first read answers what
 * the list answers: `404` / `1001`, `410` / `1002`, and `404` / `1003` for an
 * `after` that names no request of the session. That read resolves `after` to
 * the position of the request it names, once: every later read keeps the
 * requests beyond that position, so deleting the request meanwhile does not
 * end the wait, and the answer resumes from it as the list's does
 * (`listContinuation`). A later read applies the session's state again: a
 * session expired when the time runs out is `410` / `1002`, and one gone by
 * then `404` / `1001`. Nothing here uses the session (D133).
 *
 * A keyed session `key` does not open is `404` / `1001` before the wait
 * subscribes to anything (D245): a refused call never waits, and hears
 * nothing of the session.
 *
 * Each read holds `slot`, the call's slot in the gate in front of the API's
 * work, and the wait holds none while it waits (D244); the access check runs
 * in the slot the call's handler holds.
 */
export async function waitForRequests(
  pool: pg.Pool,
  hub: RealtimeHub,
  waits: PendingWaits,
  sessionId: string,
  query: ListQuery,
  signal: AbortSignal,
  key: PresentedKey = null,
  slot?: WaitSlot,
): Promise<ChosenList | null> {
  assertListIds(sessionId, query);

  // A client gone already is answered nothing, before the pool, as the wait
  // itself answers it before the hub (`waitForList`).
  if (signal.aborted) {
    return null;
  }

  await requireAccess(pool, sessionId, key);

  // A holder rather than a `let`, which TypeScript would narrow to `null` below.
  const resolved: { after: ListPosition | null } = { after: null };
  const chosen = await waitForList<ListedEntry>({
    hub,
    waits,
    sessionId,
    signal,
    slot,
    waitMs: (query.wait ?? 0) * 1000,
    first: async () => {
      const listed = toList(await repository.listRequests(pool, sessionId, query));

      resolved.after = listed.after;

      return listed.chosen;
    },
    again: async () =>
      unwrap(await repository.listRequests(pool, sessionId, query, null, resolved.after)).rows.map(
        toListedEntry,
      ),
  });

  return chosen === null ? null : { chosen, after: resolved.after };
}

/**
 * Runs `run` in a place of `slots` - the search's count, or the count of
 * header-only queries (D191, D250): every place taken is `429` / `1012`, a
 * statement stopped by its timeout `503` / `1011`, and the place is given back
 * however `run` ends.
 */
async function inSearchSlot<T>(slots: Slots, run: () => Promise<T>): Promise<T> {
  const release = slots.tryTake();

  if (release === null) {
    throw searchBusy();
  }

  try {
    return await run();
  } catch (error) {
    if (isStatementCancelled(error)) {
      throw searchTimedOut();
    }

    throw error;
  } finally {
    release();
  }
}

/**
 * `POST /api/sessions/:sessionId/requests/query`: the list, with header and
 * body conditions that travel in a body (D196).
 *
 * A query with a body condition takes its slot from the search's count, since
 * it reads the stored bodies as a search reads raw requests (D191); one with
 * none - header conditions alone, or no condition - takes a place in a count
 * of its own (`slotsForQuery`, D250). Both run under the search's timeout. The
 * order of the answers is the search's: an id that cannot be a session's is
 * `404` / `1001` and an `after` that cannot be a request id `404` / `1003`,
 * without a slot or a query; a query that finds every place of its count
 * taken is `429` / `1012`; then one statement reads the session's state, the
 * request `after` names and the list; a statement stopped by its timeout is
 * `503` / `1011`. The slot is given back however the query ends, before any
 * content `include` asks for is read and the answer written. A keyed session
 * `key` does not open is `404` / `1001` once the slot is taken, before that
 * statement runs, where a session that does not exist is answered (D245).
 */
export async function queryRequests(
  pool: pg.Pool,
  sessionId: string,
  query: ListQuery,
  slots: QuerySlots,
  timeoutMs: number,
  key: PresentedKey = null,
): Promise<ChosenList> {
  assertListIds(sessionId, query);

  return inSearchSlot(slotsForQuery(query, slots), async () => {
    await requireAccess(pool, sessionId, key);

    return toList(await repository.listRequestsWithTimeout(pool, sessionId, query, timeoutMs));
  });
}

/**
 * How an answer listing requests of `sessionId` reads the content `include`
 * asks for, a few requests at a time as it writes them (D196). Neither route
 * takes a slot or a timeout for it: each read finds requests by their primary
 * key, and reads at most one body (`list-answer.ts`).
 */
export function listedContentReader(
  pool: pg.Pool,
  sessionId: string,
  query: ListQuery,
): ReadListedContent {
  const include = { headers: query.includeHeaders, body: query.includeBody };

  return (requestIds) => repository.readListedContent(pool, sessionId, requestIds, include);
}

/**
 * The requests a resumed list chose, metadata alone. The answer's status was
 * decided when the list began, so the session's state is not applied here; a
 * session removed meanwhile lists nothing.
 */
function resumedEntries(result: SessionScoped<Listed>): ListedEntry[] {
  return result.value.rows.map(toListedEntry);
}

/**
 * How the GET's answer resumes its list where requests it chose were gone
 * before their content was read (`list-answer.ts`, D196): the same statement,
 * from the position of the last request chosen, with no slot and no timeout,
 * as the GET's own statement.
 */
export function listContinuation(
  pool: pg.Pool,
  sessionId: string,
  query: ListQuery,
  after: ListPosition | null,
): ListMore {
  return async (beyond, count) =>
    resumedEntries(
      await repository.listRequests(pool, sessionId, query, { after, beyond, limit: count }),
    );
}

/**
 * How the query's answer resumes its list (`listContinuation`). Its header
 * and body conditions read stored requests as its first statement did, so a
 * resumption runs as that statement ran, in a place of the same count - the
 * search's with a body condition, the header-only queries' without
 * (`slotsForQuery`, D250) - and under its timeout (D191): no answer under way
 * runs more scans at once than the places allow. A resumption that finds
 * every place taken, or runs out of time, ends the answer unfinished, as a
 * failed content read does; it never ends it as a shorter but whole array.
 */
export function queryContinuation(
  pool: pg.Pool,
  sessionId: string,
  query: ListQuery,
  after: ListPosition | null,
  slots: QuerySlots,
  timeoutMs: number,
): ListMore {
  const kind = slotsForQuery(query, slots);

  return (beyond, count) =>
    inSearchSlot(kind, async () =>
      resumedEntries(
        await repository.listRequestsWithTimeout(pool, sessionId, query, timeoutMs, {
          after,
          beyond,
          limit: count,
        }),
      ),
    );
}

/** One request in full; a keyed session `key` does not open is `404` / `1001` (D245). */
export async function getRequestDetails(
  pool: pg.Pool,
  sessionId: string,
  requestId: string,
  key: PresentedKey = null,
): Promise<RequestDetails> {
  assertSessionIdShape(sessionId);
  assertRequestIdShape(requestId);
  await requireAccess(pool, sessionId, key);

  const row = unwrap(await repository.findRequest(pool, sessionId, requestId));

  if (!row) {
    throw requestNotFound();
  }

  const body = transportBytes(row.body);
  const raw = transportBytes(row.raw_request);

  return {
    id: row.id as string,
    method: row.method,
    receivedAt: row.received_at.toISOString(),
    bodySize: row.body_size,
    sourceIp: row.source_ip,
    queryString: row.query_string,
    headers: row.headers,
    body: body.text,
    bodyBase64: body.base64,
    isBinary: body.isBinary,
    raw: raw.text,
    rawBase64: raw.base64,
    isRawBinary: raw.isBinary,
    // `null` for a request captured before the columns existed: no backfill ran
    // (D102, D110). `source_country` is not read and there is no `sourceCountry`:
    // country resolution was removed (D140).
    path: row.path,
    httpVersion: row.http_version,
    response: toResponseRecord(row),
  };
}

/**
 * For each word, the ids of the session's requests whose raw request holds it,
 * newest first (D191).
 *
 * The order of the answers: an id that cannot be a session's is `404` / `1001`
 * without a slot or a query; a search that finds every slot taken is `429` /
 * `1012`, refused at once; then one statement reads the session's state and
 * searches (D068), so `404` / `1001` and `410` / `1002` are the answers of the
 * moment the search ran; a statement stopped by its timeout is `503` / `1011`.
 * The slot is given back however the search ends.
 *
 * The answer carries ids and nothing else: no part of a body or a header
 * leaves through the search (D037).
 *
 * A keyed session `key` does not open is `404` / `1001` once the slot is
 * taken, before the search runs, where a session that does not exist is
 * answered (D245): its stored requests are never searched for such a call.
 */
export async function searchRequests(
  pool: pg.Pool,
  sessionId: string,
  words: readonly Buffer[],
  slots: SearchSlots,
  timeoutMs: number,
  key: PresentedKey = null,
): Promise<RequestSearchResult> {
  assertSessionIdShape(sessionId);

  const release = slots.tryTake();

  if (release === null) {
    throw searchBusy();
  }

  try {
    await requireAccess(pool, sessionId, key);

    const rows = unwrap(await repository.searchRawRequests(pool, sessionId, words, timeoutMs));

    return {
      matches: words.map((_, index) =>
        rows.filter((row) => row.found[index] === true).map((row) => row.id),
      ),
    };
  } catch (error) {
    if (isStatementCancelled(error)) {
      throw searchTimedOut();
    }

    throw error;
  } finally {
    release();
  }
}

/** Deletes one request; a keyed session `key` does not open is `404` / `1001`, nothing deleted (D245). */
export async function deleteRequest(
  pool: pg.Pool,
  sessionId: string,
  requestId: string,
  key: PresentedKey = null,
): Promise<void> {
  assertSessionIdShape(sessionId);
  assertRequestIdShape(requestId);
  await requireAccess(pool, sessionId, key);

  if (!unwrap(await repository.deleteRequest(pool, sessionId, requestId))) {
    throw requestNotFound();
  }
}

/**
 * Deletes every request of the session and starts its response queue from
 * step 1 again (D205). A keyed session `key` does not open is `404` / `1001`,
 * nothing deleted and nothing announced (D245).
 */
export async function clearRequests(
  pool: pg.Pool,
  sessionId: string,
  key: PresentedKey = null,
): Promise<void> {
  assertSessionIdShape(sessionId);
  await requireAccess(pool, sessionId, key);

  unwrap(await repository.deleteAllRequests(pool, sessionId));
}
