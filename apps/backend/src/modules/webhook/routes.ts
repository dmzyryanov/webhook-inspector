import { setTimeout as wait } from 'node:timers/promises';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import {
  MAX_BODY_BYTES,
  SESSION_ID_PATTERN,
  type RequestListItem,
  type ResponseConfig,
} from '@webhook-inspector/shared';
import { sessionExpired, sessionNotFound } from '../../errors/app-error.ts';
import { addressKey } from '../limits/rate-limit.ts';
import type { Drain } from '../../lib/drain.ts';
import { http2BodyUnproven, http2StreamOf, isAnswerGone } from '../../lib/http2.ts';
import { isBodyArriving } from '../sessions/refused-body.ts';
import type { RealtimeHub } from '../realtime/hub.ts';
import { captureAdmission, METHODS_WITHOUT_BODY, type CaptureBudget } from './capture-budget.ts';
import { recordResponseCompletion, storeRequest, type RecordedAnswer } from './repository.ts';
import {
  capturedHeaderPairs,
  composeRawRequestHead,
  extractPath,
  extractQueryString,
} from './raw-request.ts';
import { normaliseSourceIp } from './source-ip.ts';
import {
  sendWebhookResponse,
  type ComposedResponse,
  type SendOutcome,
  type WebhookAnswer,
} from './response.ts';
import { CONTENT_TYPE_PLACEHOLDER, isParseableContentType } from './content-type.ts';

const EMPTY_BODY = Buffer.alloc(0);

/**
 * Whether the headers frame no content, by the rule Fastify applies to them
 * (`isEmptyBody` in `fastify/lib/handle-request.js`): no `Transfer-Encoding`,
 * and no `Content-Length` or one of `0` (D166). A path no route has asks it
 * too, to leave Fastify its refusal of such a `QUERY` (`server.ts`, D227).
 */
export function declaresNoContent(headers: FastifyRequest['headers']): boolean {
  const contentLength = headers['content-length'];

  return (
    headers['transfer-encoding'] === undefined &&
    (contentLength === undefined || contentLength === '0')
  );
}

/**
 * The address a request was sent from, before normalisation (D111, D187).
 *
 * `buildReceiver` decides it once per listener: in production the address the
 * connection's PROXY protocol v2 header carried, from a peer inside the trust
 * boundary; locally and in the tests the socket peer. Never a header of the
 * request: on the receive listener every header is the sender's own, and is
 * stored as such.
 */
export type SourceAddress = (request: FastifyRequest) => string | undefined;

interface Capture {
  sessionId: string;
  stored: RequestListItem;
  /**
   * The response this request is answered with: the response queue's step it
   * took (D205), or else the session's response when it was captured, `null`
   * while that is the default - by its mode, whatever custom response it keeps
   * (D151). Read under the capture's lock, so a later change cannot reach this
   * request, its delay included (D150).
   */
  response: ResponseConfig | null;
  /** This request's own answer, composed inside the capture transaction. */
  composed: ComposedResponse;
  /** What its response record holds of that answer, which the completion announces (#260). */
  answered: RecordedAnswer;
}

async function capture(
  pool: pg.Pool,
  sourceAddress: SourceAddress,
  appOrigin: string,
  request: FastifyRequest<{ Params: { sessionId: string } }>,
): Promise<Capture> {
  const { sessionId } = request.params;

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw sessionNotFound();
  }

  const body = Buffer.isBuffer(request.body) ? request.body : EMPTY_BODY;

  // The connection's PROXY header in production, the socket peer locally
  // (D187). Normalisation is what decides the spelling that is stored, and what
  // answers `null` for an address that does not parse.
  const sourceIp = normaliseSourceIp(sourceAddress(request));

  // Every header exactly as the sender wrote it: on the receive listener
  // nothing stands between the sender's bytes and Node's parser but TLS, so
  // there is no proxy's header to leave out (D187, which retired D144's
  // filter). The header list and the raw request are composed from the same
  // pairs, so they cannot disagree. Over HTTP/2 the pseudo-header fields are
  // the raw request's alone (D263).
  const headers = capturedHeaderPairs(request);
  const http2 = http2StreamOf(request.raw) !== undefined;

  // The session is validated inside the storing transaction, not before it, so
  // that it cannot expire or be cleaned up in between. The same transaction
  // reads the response configuration the reply is composed from.
  const result = await storeRequest(
    pool,
    {
      sessionId,
      method: request.raw.method ?? 'UNKNOWN',
      // As received: the router may have been given another spelling of a
      // path it could not decode (`routableUrl`, D173).
      path: extractPath(request.originalUrl),
      httpVersion: request.raw.httpVersion,
      queryString: extractQueryString(request.originalUrl),
      headers,
      body,
      rawRequestHead: composeRawRequestHead(request, headers),
      sourceIp,
      http2,
    },
    // Where the default answer links the request in the inspector (D223).
    appOrigin,
    // Only so that a refresh which fails inside the transaction is reported
    // instead of disappearing; it can change nothing about this capture (D133).
    request.log,
  );

  if (result.outcome === 'session-not-found') {
    throw sessionNotFound();
  }

  if (result.outcome === 'session-expired') {
    throw sessionExpired();
  }

  return {
    sessionId,
    stored: result.request,
    response: result.response,
    composed: result.composed,
    answered: result.answered,
  };
}

/**
 * What the reply keeps of a stored capture, and nothing else (D210): a reply
 * held by a configured delay keeps it for up to 30 s.
 */
interface StoredCapture {
  sessionId: string;
  requestId: string;
  /** The response's delay, `0` for none; the rest of the response is not kept. */
  delayMs: number;
  /** What is written: not the composed `raw`, which the response record holds. */
  answer: WebhookAnswer;
  /**
   * The status, the queue's step and the rule the response record holds, as
   * the capture wrote them: what the completion announces with how the
   * response ended (#260).
   */
  answered: RecordedAnswer;
}

/**
 * Stores the request, with its announcement, in one turn of the session's
 * line (D205), and answers what the reply needs of it.
 *
 * The body is taken off the request as soon as it is stored, so nothing that
 * keeps the request - a reply held by a delay keeps it for up to 30 s - keeps
 * the up to 1 MiB it came in, as `/mcp`'s `readMessage` takes its body off
 * (D203, D210). The full capture, its response and its composed raw answer
 * stay inside this function. What Node read of a body Fastify never reads,
 * a `GET`'s, stays in the request's stream until the reply has closed, and
 * stays counted (`unreadBodyWeight`).
 */
async function captureInOrder(
  pool: pg.Pool,
  hub: RealtimeHub,
  sourceAddress: SourceAddress,
  appOrigin: string,
  request: FastifyRequest<{ Params: { sessionId: string } }>,
): Promise<StoredCapture> {
  // The announcement is written in the capture's transaction and heard once
  // it commits, by every process (D075, D221), in the order the session's
  // changes took its row lock (D205 point 12). The capture takes a turn of the
  // session's line, so that the connection of the pool is taken inside the
  // turn, never before it (D205). The line is kept under the id as the URL
  // gives it; `capture` refuses one that cannot be a session.
  const { sessionId, stored, response, composed, answered } = await hub.inOrder(
    request.params.sessionId,
    () => capture(pool, sourceAddress, appOrigin, request),
  );

  request.body = undefined;

  return {
    sessionId,
    requestId: stored.id,
    delayMs: response?.delayMs ?? 0,
    answer: { status: composed.status, headers: composed.headers, body: composed.body },
    answered,
  };
}

/**
 * The completion writes still under way in the process (D221): a shutdown
 * waits for them before it ends the pool, so that a reply written during the
 * shutdown - a delayed one, say - still has its outcome recorded and
 * announced.
 */
export class PendingWrites {
  readonly #writes = new Set<Promise<unknown>>();

  /** Keeps `write` until it settles. */
  track(write: Promise<unknown>): void {
    const kept = write.finally(() => {
      this.#writes.delete(kept);
    });

    kept.catch(() => undefined);
    this.#writes.add(kept);
  }

  /** Resolves once every write tracked so far, and every one tracked meanwhile, has settled. */
  async settled(): Promise<void> {
    while (this.#writes.size > 0) {
      await Promise.allSettled([...this.#writes]);
    }
  }

  /** Writes under way. Exists for tests and diagnostics. */
  get size(): number {
    return this.#writes.size;
  }
}

/**
 * Records how one response ended, and announces it in the same statement if
 * the record changed (D110, D221, #260), with what the capture recorded.
 *
 * Fire-and-forget on purpose (D109). The response has already been written by
 * the time this runs, and on the abort path it runs from a dead connection's
 * teardown. Its failure is logged and never changes the reply, never awaits a
 * dead one, and never turns a captured request into a `500`: the request is
 * already stored, and losing the outcome is recoverable. It is tracked in
 * `writes`, which a shutdown waits for.
 */
function recordCompletion(
  pool: pg.Pool,
  writes: PendingWrites,
  request: FastifyRequest,
  sessionId: string,
  requestId: string,
  answered: RecordedAnswer,
  outcome: SendOutcome,
): void {
  writes.track(
    recordResponseCompletion(pool, sessionId, requestId, outcome, answered).catch(
      (error: unknown) => {
        request.log.error({ err: error }, 'Recording how a webhook response ended failed');
      },
    ),
  );
}

/**
 * Holds the reply for the configured delay, and reports whether it should still
 * be written (D105).
 *
 * The abort signal is response-side and its cancellation is conditional. It
 * cannot be `request.raw`: on any request carrying body bytes that stream closes
 * as the handler is entered, which would cancel the delay on every real webhook.
 * And a normally completed response emits `close` too, so only a close while
 * `writableEnded` is still `false` means the sender abandoned the connection.
 */
async function holdResponse(reply: FastifyReply, delayMs: number): Promise<boolean> {
  if (isAnswerGone(reply.raw)) {
    return false;
  }

  const controller = new AbortController();
  const onClose = (): void => {
    if (!reply.raw.writableEnded) {
      controller.abort();
    }
  };

  reply.raw.on('close', onClose);

  try {
    await wait(delayMs, undefined, { signal: controller.signal });

    return true;
  } catch {
    return false;
  } finally {
    reply.raw.off('close', onClose);
  }
}

/**
 * The public webhook receiver, registered as a plugin of the receive listener
 * (D187) so that its body handling stays inside this scope. `appOrigin` is the
 * site's, where a default answer links its request (D223).
 */
export function webhookRoutes(
  pool: pg.Pool,
  hub: RealtimeHub,
  sourceAddress: SourceAddress,
  budget: CaptureBudget,
  writes: PendingWrites,
  drain: Drain,
  appOrigin: string,
): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    // Capture the body as bytes and never interpret it. Fastify would otherwise
    // parse JSON and answer 400 on a malformed payload, which is exactly the
    // payload someone opens the inspector to look at (D007).
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    // Fastify refuses a Content-Type that is not a media type before it
    // selects a parser, so the rule above would never see the request and it
    // would be lost. The value is replaced on Fastify's parsed view alone, in a
    // hook that runs before that check; the capture is composed from the raw
    // headers and still shows it exactly as sent (D138).
    //
    // The same view carries a `QUERY` past Fastify's two RFC 10008 refusals,
    // which fire before any parser and would lose the request (D166). One
    // without a `Content-Type` is given the placeholder, as an unparseable one
    // is. One with no content - `Content-Length: 0`, or neither
    // `Content-Length` nor `Transfer-Encoding` - is declared chunked on the
    // view, so Fastify reads its empty stream instead of refusing it; the
    // stream still decides the body, and it holds no bytes. The method, the
    // headers and the body stored come from the raw request, as for every
    // capture, so a `QUERY` is stored exactly as a `POST` of the same shape.
    app.addHook('onRequest', async (request) => {
      const isQuery = request.raw.method === 'QUERY';
      const contentType = request.headers['content-type'];
      let view = request.headers;

      if (contentType === undefined ? isQuery : !isParseableContentType(contentType)) {
        view = { ...view, 'content-type': CONTENT_TYPE_PLACEHOLDER };
      }

      if (isQuery && declaresNoContent(view)) {
        view = { ...view, 'transfer-encoding': 'chunked' };
      }

      // An HTTP/2 request frames its body by its stream (D263): one with no
      // `Content-Length` whose stream did not end with its headers may carry
      // a body all the same, which Fastify, reading the headers, would take
      // for none and store empty; one with `Content-Length: 0` has its
      // END_STREAM still to come, without which it is not stored, and
      // Fastify would run its handler at once. Either is declared chunked on
      // the view as well, so Fastify reads the stream to its end, which
      // decides the body.
      const stream = http2StreamOf(request.raw);

      if (stream !== undefined && !stream.endAfterHeaders && declaresNoContent(view)) {
        view = { ...view, 'transfer-encoding': 'chunked' };
      }

      if (view !== request.headers) {
        request.headers = view;
      }
    });

    // Every webhook waits for its place in the byte budget before a byte of
    // its body is read, and holds it until its reply has closed and its
    // handler has settled (D210). After the hook above, so the place is asked
    // for by a request Fastify will read; a body declared over 1 MiB on a
    // method whose body Fastify reads, refused `413` unread, asks for none,
    // and a `GET`, `HEAD` or `TRACE`, whose body it never reads and Node reads
    // all the same, asks for the body it declares, at most 1 MiB. The
    // address is the sender's, counted as the API's limits count one (D201).
    const admission = captureAdmission(budget, (request) => addressKey(sourceAddress(request)));

    app.addHook('onRequest', admission.guard);

    // The endpoint, the endpoint with a trailing slash (D063), and any path
    // under it (D173): a sender that appends a route per provider or per event,
    // or a WebDAV client addressing `/s/<id>/folder/`, is captured and answered
    // exactly as `/s/<id>` is. The segment after `/s/` alone decides the
    // session; the rest of the path is stored as it reached the application
    // (`extractPath` reads the raw URL, not the decoded wildcard) and is never
    // interpreted. `app.all` takes the methods `buildReceiver` declared before
    // this plugin was registered, so each of the three routes has all 34
    // (D139).
    for (const path of ['/s/:sessionId', '/s/:sessionId/', '/s/:sessionId/*']) {
      app.all<{ Params: { sessionId: string } }>(
        path,
        { bodyLimit: MAX_BODY_BYTES },
        admission.holding(async (request, reply) => {
          // An HTTP/2 request is stored only once its sender's END_STREAM
          // has come (D263): a stream the request timeout ended, answered
          // `408`, or one its sender reset, or whose connection went, before
          // its END_STREAM, `Content-Length` met or not, is ended by Node
          // all the same, so Fastify hands the handler what had come by
          // then, which may not be whole. Nothing is stored, as for an
          // HTTP/1.1 body cut short (D174). A stream whose END_STREAM came
          // before its reset is stored, and its answer recorded `aborted`.
          // Which came first is recorded as Node reads them
          // (`watchHttp2Request`), so no turn is waited for. A `GET`, `HEAD`
          // or `TRACE` is stored on its headers, as over HTTP/1.1: its body
          // is never read.
          const stream = http2StreamOf(request.raw);

          if (
            stream !== undefined &&
            !METHODS_WITHOUT_BODY.has(request.raw.method ?? '') &&
            http2BodyUnproven(stream)
          ) {
            request.log.info('Request aborted by the client');

            return reply.hijack();
          }

          const { sessionId, requestId, delayMs, answer, answered } = await captureInOrder(
            pool,
            hub,
            sourceAddress,
            appOrigin,
            request,
          );

          // Stored: what is still held is the reply, the request's headers,
          // the answer's body and, for a `GET`, `HEAD` or `TRACE` that declared
          // a body, what Node keeps of it unread until the reply has closed,
          // for as long as a delay holds them - never more than the webhook
          // was admitted for, which reserved the answer's 64 KiB (D210).
          admission.stored(request, answer.body?.byteLength ?? 0);

          // Persist and announce, wait, reply (D105). The viewer therefore sees
          // the request while the sender is still waiting, and a sender that
          // gives up mid-delay still finds its request in the inspector.
          // Rejections never reach this line and are never delayed.
          if (delayMs > 0 && !(await holdResponse(reply, delayMs))) {
            // The sender is gone: write nothing into a dead socket. The answer
            // was composed before the delay, so the record it leaves behind
            // carries real content rather than an empty shell (D109).
            reply.hijack();
            recordCompletion(pool, writes, request, sessionId, requestId, answered, 'aborted');

            return reply;
          }

          // The reply carries the request id, which is set only once a request
          // has actually been stored: Fastify keeps headers already on the
          // reply when the error handler runs, so writing them any earlier
          // would leak an id onto the rejection responses, which report none
          // (D100).
          //
          // It ends its connection once the drain has started (D221), and
          // when it is written before the request's body has all arrived,
          // as every other answer does (`createApp`'s `onSend`, D227): a
          // `GET`, `HEAD` or `TRACE`, whose body Fastify never reads, is
          // stored and answered while the rest of a declared body may still
          // be to come. Kept alive, the connection and its request would stay
          // until the rest came or `requestTimeout` ran out, while the
          // webhook's place in the capture budget goes back as the reply
          // closes. The handler has waited for the database since the
          // headers came, so Node's parser has read whatever had arrived:
          // no second look a turn later is needed, as `onSend`'s is.
          //
          // Over HTTP/2 nothing closes the connection: the drain sends its
          // GOAWAY, and an answer before the body has ended ends its stream
          // with `RST_STREAM(NO_ERROR)` once written (D263, `buildReceiver`).
          return sendWebhookResponse(
            reply,
            answer,
            (outcome) =>
              recordCompletion(pool, writes, request, sessionId, requestId, answered, outcome),
            stream === undefined &&
              (drain.closes(request.raw.socket) || isBodyArriving(request.raw)),
          );
        }),
      );
    }
  };
}
