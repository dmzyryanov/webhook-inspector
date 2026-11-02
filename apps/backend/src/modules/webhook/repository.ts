import type pg from 'pg';
import {
  buildInspectorUrl,
  MAX_REQUESTS_PER_SESSION,
  type QueueStep,
  type RequestListItem,
  type ResponseConfig,
  type ResponseSummary,
  type RuleSummary,
} from '@webhook-inspector/shared';
import {
  refreshExpiryInTransaction,
  REFRESH_DUE_SQL,
  RESPONSE_COLUMNS,
  toQueueStep,
  toResponseConfig,
  toResponseRule,
  type RefreshLogger,
  type ResponseConfigColumns,
} from '../sessions/repository.ts';
import { toRecordedQueueStep, toRecordedRuleSummary } from '../requests/response-state.ts';
import { appendEvent, committed, type OutboxEvent } from '../realtime/events.ts';
import { inTransaction, type TransactionEnd } from '../realtime/transaction.ts';
import {
  composeWebhookResponse,
  type ComposedResponse,
  type RequestFacts,
  type SendOutcome,
} from './response.ts';

/**
 * The capture's insert. Its text is the previous image's but for the address
 * it returns (D243), which `source-ip-choice.test.ts` holds: the previous
 * image's insert, replayed on this schema, is the statement this one runs.
 */
export const INSERT_REQUEST_SQL = `INSERT INTO requests
         (session_id, method, path, http_version, query_string, headers, body, body_size,
          raw_request, source_ip, received_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::bytea, $8, $9::bytea || $7::bytea, $10,
               clock_timestamp())
       RETURNING id, received_at, source_ip`;

/**
 * The insert of the answer's record: the previous image's, which
 * `source-ip-choice.test.ts` replays as the statement migration 015's trigger
 * guards (D243), with the three columns of the rule that answered after its
 * own (D246), which that test holds too.
 */
export const INSERT_RESPONSE_SQL = `INSERT INTO request_responses
         (request_id, state, status, headers, body, body_size, body_suppressed, raw_response,
          delay_ms, started_at, queue_step_index, queue_step_total,
          rule_index, rule_method, rule_path)
       VALUES ($1, 'pending', $2, $3::jsonb, $4, $5, $6, $7, $8, clock_timestamp(), $9, $10,
               $11, $12, $13)`;

/**
 * The capture's read once it holds the session row's lock (D019, D065):
 * whether the session has expired, and whether its expiry is due to move
 * (`REFRESH_DUE_SQL`, #260), both against the clock as it is now and the row
 * as the lock holds it. Exported so that a test can recognise it.
 *
 * Not the locking statement itself: what that one selects may be computed
 * before it waits for the lock, the clock with it, and is computed again
 * after the wait only when the row was changed meanwhile.
 */
export const CAPTURE_EXPIRY_SQL = `SELECT expires_at <= clock_timestamp() AS expired,
              (${REFRESH_DUE_SQL}) AS refresh_due
         FROM sessions WHERE id = $1`;

/**
 * The first of the session's response rules a request matches (D246), as one
 * scalar subquery of the capture's locking statement, so it reads the rules of
 * the row the lock returns - the latest committed, as the queue's step is -
 * and never another table. `$2` is the request's method and `$3` its path
 * under the session (`ruleTarget`), `NULL` when it has none, which matches
 * nothing.
 *
 * A rule matches when its method is JSON `null` or equals the request's, and
 * its path equals the request's, or - ending in `*` - is a prefix of it once
 * the `*` is cut. Only `=` and `starts_with` compare: both compare the text
 * byte for byte under the database's deterministic collation, so `%`, `_`,
 * `\`, `.` and every other character of a pattern match only themselves, and
 * no `LIKE` or regular expression is ever built from one. Each rule costs a
 * comparison as long as the shorter of its pattern and the path, so twenty
 * rules of at most 1 KiB cost at most 20 KiB of comparing, whatever the path.
 *
 * It answers the matched rule alone, its position first, `NULL` when none
 * matched: the other rules' responses never leave the database.
 */
export const MATCHED_RULE_SQL = `(SELECT jsonb_build_array(rule.position, rule.item)
                 FROM jsonb_array_elements(response_rules)
                      WITH ORDINALITY AS rule(item, position)
                WHERE (rule.item -> 'method' = 'null'::jsonb
                       OR rule.item ->> 'method' = $2)
                  AND CASE
                        WHEN right(rule.item ->> 'path', 1) = '*'
                          THEN starts_with($3, left(rule.item ->> 'path', -1))
                        ELSE rule.item ->> 'path' = $3
                      END
                ORDER BY rule.position
                LIMIT 1)`;

/**
 * What a request's path is matched against (D246): what follows
 * `/s/<session-id>` in the path as stored (D173), nothing decoded or
 * normalised, and `/` for the session's own URL, which has nothing after its
 * id or a lone `/`. The id segment is whatever the path holds up to its next
 * `/`. A path not under `/s/` has no such part and matches no rule.
 */
export function ruleTarget(path: string): string | null {
  if (!path.startsWith('/s/')) {
    return null;
  }

  const rest = path.indexOf('/', 3);

  return rest === -1 ? '/' : path.slice(rest);
}

export interface CapturedRequest {
  sessionId: string;
  method: string;
  /** The path component only; the query string is its own column (D110). */
  path: string;
  httpVersion: string;
  queryString: string;
  headers: [string, string][];
  body: Buffer;
  /**
   * The request line, the headers and the blank line after them. The stored
   * raw request is this head and then `body`, joined in the insert, so no
   * second full copy of the body is built in the process (D049, D210).
   */
  rawRequestHead: Buffer;
  /**
   * Normalised and validated before it gets here; `null` when it did not
   * parse. What is stored is decided under the session's lock: `null` for a
   * session created with `storeSourceIp: false` (D243).
   */
  sourceIp: string | null;
  /**
   * Whether the request came over HTTP/2 (D263): its answer is composed as
   * HTTP/2 sends it, and its raw form reads `:status` first. Absent, HTTP/1.1.
   */
  http2?: boolean;
}

/**
 * A stored capture reports the row it wrote, because the realtime event has to
 * describe the request exactly as the list API would: the id and the timestamp
 * are assigned by the database, so they can only come from the insert itself
 * (D075).
 */
export type CaptureResult =
  | {
      outcome: 'stored';
      request: RequestListItem;
      /**
       * The response this request is answered with: the response rule that
       * matched it (D246), or else the queue's step that answered it, or
       * else the session response, `null` for the default (D205). Its delay
       * is the one the reply waits out.
       */
      response: ResponseConfig | null;
      /** The answer this request will get, composed inside the transaction. */
      composed: ComposedResponse;
      /**
       * The status, the queue's step and the rule its response record holds,
       * as written here: what its completion announces (#260).
       */
      answered: RecordedAnswer;
    }
  | { outcome: 'session-not-found' }
  | { outcome: 'session-expired' };

/**
 * Stores one captured request.
 *
 * Everything happens in a single transaction (`inTransaction`, D221) that
 * starts by locking the session row. The lock is what makes three guarantees
 * hold under concurrent traffic:
 *
 * - the newest-1000 limit (D006). Without it, two requests arriving together
 *   both see the same 1000 older rows, both delete the same oldest one, and the
 *   session is left holding 1001.
 * - expiration being authoritative at the moment of writing (D019). Checking
 *   the session in an earlier statement leaves a window in which it can expire,
 *   or in which the scheduled cleanup deletes it and the insert fails on its
 *   foreign key.
 * - receipt order following the order of commits within a session (D196). The
 *   receipt time is read once the lock is held, so a request committed later
 *   is never received earlier than one a list has already returned.
 *
 * Expiration and the receipt time are read with `clock_timestamp()` after the
 * lock is held, not with `now()`, which PostgreSQL fixes at the start of the
 * transaction. A request that begins while the session is still valid can wait
 * on the lock long enough for it to expire, or for another capture that began
 * later to commit, and `now()` would still report the moment before the wait.
 *
 * The cost is that requests to one session are written one after another. For a
 * tool whose purpose is to record what arrived, correctness of the record is
 * worth more than parallel writes into the same session.
 *
 * `appOrigin` is the site's public origin, `APP_ORIGIN` (D203): the default
 * answer links the request in the inspector there (D223).
 */
export async function storeRequest(
  pool: pg.Pool,
  captured: CapturedRequest,
  appOrigin: string,
  logger?: RefreshLogger,
): Promise<CaptureResult> {
  return inTransaction(pool, async (client): Promise<TransactionEnd<CaptureResult>> => {
    // The response configuration is read by the statement that already takes
    // the lock, so the reply cannot be composed from a row the cleanup removed
    // in between and no second round trip is added to the capture path. A
    // response change takes the same lock (D150), so this request is answered
    // wholly by the configuration before a change or wholly by the one after
    // it, never by a mixture of the two.
    //
    // The same statement reads the response queue's next step, and only that
    // step: `response_queue -> answered` is the step after the ones already
    // answered, `NULL` when there is no queue or every step has answered
    // (D205). Setting, restarting or removing the queue takes this lock too,
    // so each request takes exactly one step and no two take the same one.
    //
    // And whether the session keeps the sender's address (D243), set at its
    // creation and never changed, so the insert below writes `NULL` for one
    // that does not.
    //
    // And the first response rule the request matches, and only that rule
    // (D246, `MATCHED_RULE_SQL`): matched here, against the rules of the row
    // the lock returns, so a save of the rules, which takes this lock too, is
    // matched wholly before this capture or wholly after it.
    const locked = await client.query<
      { id: string; store_source_ip: boolean } & ResponseConfigColumns & {
          queue_step: unknown;
          queue_total: number | null;
          queue_answered: number | null;
          matched_rule: [number, unknown] | null;
        }
    >(
      `SELECT id, ${RESPONSE_COLUMNS},
              response_queue -> response_queue_answered AS queue_step,
              jsonb_array_length(response_queue) AS queue_total,
              response_queue_answered AS queue_answered,
              store_source_ip,
              ${MATCHED_RULE_SQL} AS matched_rule
       FROM sessions WHERE id = $1 FOR UPDATE`,
      [captured.sessionId, captured.method, ruleTarget(captured.path)],
    );

    const session = locked.rows[0];

    if (!session) {
      return { commit: false, value: { outcome: 'session-not-found' } };
    }

    // Evaluated only now that the lock is held, against real time rather than
    // the transaction's start time - and so is whether the expiry is due to
    // move (`CAPTURE_EXPIRY_SQL`, #260).
    const expiry = await client.query<{ expired: boolean; refresh_due: boolean }>(
      CAPTURE_EXPIRY_SQL,
      [captured.sessionId],
    );

    if (expiry.rows[0]?.expired !== false) {
      return { commit: false, value: { outcome: 'session-expired' } };
    }

    // `source_country` is not written, and stays `NULL`: country resolution was
    // removed (D140). The column itself is kept because the previous image still
    // inserts into it, so dropping it now would break a rollback of the app.
    //
    // `received_at` is written here, with the lock held, from
    // `clock_timestamp()`, and not left to the column's default, `now()`, the
    // moment this transaction began, before any wait for the lock. The lock is
    // held until COMMIT, so within a session receipt order is the order in
    // which captures took it: a capture committed after a list was answered is
    // received after every request that list could see, and a client listing
    // `after` the newest it saw finds it (D196).
    //
    // `raw_request` is the head and the body joined here, `$9 || $7`: the body
    // is sent once, as `body`, rather than a second time inside a raw request
    // composed in the process, which held a second full copy of it for as
    // long as the capture waited for a connection (D210). The bytes stored
    // are the same.
    //
    // `source_ip` is the sender's address, or `NULL` for a session created
    // with `storeSourceIp: false` (D243), written here, so this image never
    // relies on migration 014's trigger, which holds the previous image's
    // insert to the same; `source-ip-choice.test.ts` reads the parameter this
    // sends. The row returns what it holds, and every answer below - the
    // default answer, the record of it, the event - is built from that, never
    // from the address read in the process, so none of them can say more than
    // the row (D075), and migration 015's trigger, which holds the previous
    // image's record of its answer to the row, never changes this one's.
    const inserted = await client.query<{
      id: string;
      received_at: Date;
      source_ip: string | null;
    }>(INSERT_REQUEST_SQL, [
      captured.sessionId,
      captured.method,
      captured.path,
      captured.httpVersion,
      captured.queryString,
      JSON.stringify(captured.headers),
      captured.body,
      captured.body.byteLength,
      captured.rawRequestHead,
      session.store_source_ip ? captured.sourceIp : null,
    ]);

    await client.query(
      `DELETE FROM requests
       WHERE id IN (
         SELECT id FROM requests
         WHERE session_id = $1
         ORDER BY received_at DESC, id DESC
         OFFSET $2
       )`,
      [captured.sessionId, MAX_REQUESTS_PER_SESSION],
    );

    const row = inserted.rows[0];

    if (!row) {
      throw new Error('Inserting a request returned no row');
    }

    // The rule the request matched, which answers it and takes no step of the
    // queue (D246); otherwise the queue's next step, while one is left
    // (D205); otherwise the session response, by the mode rather than by the
    // presence of a status: a session switched to the default keeps its
    // custom response saved and answers the default (D151).
    const matched =
      session.matched_rule === null
        ? null
        : { index: session.matched_rule[0], ...toResponseRule(session.matched_rule[1]) };
    const queueStep: QueueStep | null =
      matched !== null ||
      session.queue_step === null ||
      session.queue_total === null ||
      session.queue_answered === null
        ? null
        : { index: session.queue_answered + 1, total: session.queue_total };
    const response =
      matched !== null
        ? matched.response
        : queueStep === null
          ? toResponseConfig(session)
          : toQueueStep(session.queue_step);
    const rule: RuleSummary | null = matched === null ? null : { index: matched.index };

    // What the request is, as stored: the id, the time and the address from
    // the insert itself, the rest as written, so the default answer says what
    // the list, the detail and the event say (D223, D243). The link names the
    // locked row's session.
    const facts: RequestFacts = {
      requestId: row.id,
      inspectorUrl: buildInspectorUrl(appOrigin, session.id, row.id),
      receivedAt: row.received_at.toISOString(),
      method: captured.method,
      path: captured.path,
      bodySize: captured.body.byteLength,
      sourceIp: row.source_ip,
    };

    // Composed here because the id only exists once the insert has returned,
    // and because the record has to carry real content from the moment it is
    // written: the detail panel shows the prepared response while the request
    // is still pending, and a sender that disconnects mid-delay leaves nothing
    // else behind (D109). Composing is pure - it touches no connection and
    // flushes no head - so it costs the transaction next to nothing. A
    // template's body is filled in here too (D251), from this request's own
    // query string, headers and body - the body parsed only for a placeholder
    // of it, once - and filling one in never throws.
    const composed = composeWebhookResponse(
      response,
      facts,
      {
        queryString: captured.queryString,
        headers: captured.headers,
        body: captured.body,
      },
      captured.http2 === true,
    );

    // Inside the capture transaction, so that "no row means this request
    // predates the release" survives a crash between the capture and the reply
    // (D109). Only the terminal columns are written later.
    //
    // The step that answered it is recorded with it, and `NULL` when the
    // session response did (D205); so is the rule that answered it, with its
    // method and path as they are now, and `NULL` when none did (D246).
    await client.query(INSERT_RESPONSE_SQL, [
      row.id,
      composed.status,
      JSON.stringify(composed.headers),
      composed.body,
      composed.body?.byteLength ?? 0,
      composed.bodySuppressed,
      composed.raw,
      response?.delayMs ?? 0,
      queueStep?.index ?? null,
      queueStep?.total ?? null,
      matched?.index ?? null,
      matched?.method ?? null,
      matched?.path ?? null,
    ]);

    // The step is taken: the next request gets the one after it, or the
    // session response once this was the last (D205). Under the lock, so the
    // count moves by exactly one per request that took a step - and not at
    // all for one a rule answered (D246).
    if (queueStep !== null) {
      await client.query(
        `UPDATE sessions SET response_queue_answered = response_queue_answered + 1 WHERE id = $1`,
        [captured.sessionId],
      );
    }

    // A captured webhook is the other thing that counts as using a session
    // (D133), so the expiry moves a full window ahead here - throttled to once
    // an hour by the statement itself, so the hot path does not gain a write
    // per request. And run only when the expiry read above found it due, by
    // the statement's own conditions (`REFRESH_DUE_SQL`), so that the hot path
    // does not send its three statements for nothing either (#260): about once
    // an hour a session, rather than on every capture. The statement judges
    // its conditions again when it runs and decides what is written.
    //
    // It runs last, once the request and its response record are safely
    // inserted, and inside a savepoint. The savepoint is what keeps the refresh
    // from deciding the fate of a capture: a statement that fails inside a
    // transaction aborts the whole transaction in PostgreSQL, so without one a
    // failed refresh would take the already-successful capture down with it at
    // COMMIT. With it, the failure is rolled back to the savepoint, the
    // transaction is usable again and the request is committed and delivered.
    // Nothing else in this function is allowed to depend on the outcome. The
    // response change runs the same helper for the same reason (D150).
    if (expiry.rows[0]?.refresh_due === true) {
      await refreshExpiryInTransaction(client, captured.sessionId, logger);
    }

    const request: RequestListItem = {
      id: facts.requestId,
      method: facts.method,
      receivedAt: facts.receivedAt,
      bodySize: facts.bodySize,
      sourceIp: facts.sourceIp,
      path: facts.path,
      // Always `pending` in the event: it is announced when the capture
      // commits, before the response is written (D110).
      response: { state: 'pending', status: composed.status, queueStep, rule },
    };

    // The announcement, written last and in this transaction, still under the
    // lock: its id is drawn after every earlier change of the session
    // committed, so it is delivered after them, and it exists only if this
    // commits (D075, D221). It carries the row as the list reports it, ids
    // and time from the insert itself.
    await appendEvent(
      client,
      captured.sessionId,
      { type: 'request.received', data: request },
      row.id,
    );

    // `inTransaction` commits it and wakes the readers once `COMMIT` has
    // returned; a refusal above, or a throw, rolls it back and wakes nobody.
    return {
      commit: true,
      value: {
        outcome: 'stored',
        response,
        composed,
        request,
        answered: { status: composed.status, queueStep, rule },
      },
    };
  });
}

/**
 * What a capture already knows of the answer it recorded, which its
 * completion announces (`recordResponseCompletion`): the status, the queue's
 * step and the rule its record holds, as the capture wrote them.
 */
export type RecordedAnswer = Pick<ResponseSummary, 'status' | 'queueStep' | 'rule'>;

/**
 * A response's completion and its announcement, as one statement that
 * commits on its own (#260): the guarded `UPDATE` of the record (D109), and
 * `response.recorded` appended for the row it changed, and for no other.
 * `$1` is the request's id, `$2` how the response ended, `$3` the session's id
 * and `$4` the event as it is sent. It answers the record's summary columns
 * as the update left them, one row when it changed one and none otherwise.
 *
 * The event's row is the one `APPEND_EVENT_SQL` writes - the same columns,
 * `tx` and `created_at` by their defaults - so the images that serve at once
 * during a rollout read it alike (D221).
 */
export const RECORD_COMPLETION_SQL = `WITH done AS (
         UPDATE request_responses AS r
            SET state = $2,
                completed_at = c.at,
                duration_ms = (EXTRACT(EPOCH FROM (c.at - r.started_at)) * 1000)::int
           FROM (SELECT clock_timestamp() AS at) AS c
          WHERE r.request_id = $1 AND r.state = 'pending'
         RETURNING r.state, r.status, r.queue_step_index, r.queue_step_total, r.rule_index
       ), announced AS (
         INSERT INTO realtime_events (session_id, request_id, kind, payload)
         SELECT $3, $1::uuid, 'response.recorded', $4 FROM done
       )
       SELECT state, status, queue_step_index, queue_step_total, rule_index FROM done`;

/**
 * Writes how one response ended, and reports the summary when it actually
 * changed something.
 *
 * Three properties of this statement are load-bearing (D109):
 *
 * - It **updates and never inserts**. A request deleted while its response was
 *   still pending must stay deleted, and an upsert here would resurrect it.
 * - It **guards the state, not only the row**. The teardown `close` listener
 *   fires on a normally completed response too, so a write guarded by the id
 *   alone would overwrite a terminal `sent` with `aborted` on every successful
 *   request.
 * - It returns `null` unless exactly one row changed, and announces nothing
 *   then, for a transition that did not happen - a request deleted
 *   mid-flight, or a second writer the guard turned into a no-op. No rows
 *   affected is not an error.
 *
 * The change and its `response.recorded` are written by one statement,
 * `RECORD_COMPLETION_SQL`, which commits on its own (#260): the event exists
 * once it commits, never for a write that failed, and only when the update
 * changed the row (D221). A deletion of the request or of its session that
 * runs meanwhile waits for the row the statement holds and then purges the
 * event with the request; one that deleted the row first leaves the
 * statement nothing to update, so nothing to announce.
 *
 * The event is what the capture recorded (`answered`): the status, the
 * queue's step and the rule it wrote into the record, which no later write
 * changes, beside how the response ended - so its summary is the one the row
 * gives, which the statement answers and this function reports. The readers
 * are woken once the statement has returned, only when it wrote the event.
 *
 * It runs on its own pooled connection, outside `storeRequest`'s transaction:
 * that transaction holds the session row `FOR UPDATE` (D065), and a delayed
 * response finishing inside it would hold the lock and the connection for the
 * whole delay, serialising every other capture on that session behind it
 * (D105).
 *
 * The clock is read once, in a subquery, so `completed_at` and the duration it
 * is measured against cannot come from two different instants.
 */
export async function recordResponseCompletion(
  pool: pg.Pool,
  sessionId: string,
  requestId: string,
  outcome: SendOutcome,
  answered: RecordedAnswer,
): Promise<ResponseSummary | null> {
  const event: OutboxEvent = {
    type: 'response.recorded',
    data: {
      id: requestId,
      response: {
        state: outcome,
        status: answered.status,
        queueStep: answered.queueStep,
        rule: answered.rule,
      },
    },
  };
  const result = await pool.query<{
    state: ResponseSummary['state'];
    status: number | null;
    queue_step_index: number | null;
    queue_step_total: number | null;
    rule_index: number | null;
  }>(RECORD_COMPLETION_SQL, [requestId, outcome, sessionId, JSON.stringify(event)]);

  const row = result.rowCount === 1 ? result.rows[0] : undefined;

  if (!row) {
    return null;
  }

  committed(pool);

  return {
    state: row.state,
    status: row.status,
    queueStep: toRecordedQueueStep(row.queue_step_index, row.queue_step_total),
    rule: toRecordedRuleSummary(row.rule_index),
  };
}
