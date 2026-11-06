import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { SEARCH_TIMEOUT_MS } from '@webhook-inspector/shared';
import type { RealtimeHub } from '../realtime/hub.ts';
import { requestKey } from '../sessions/access-key.ts';
import { jsonBody, mediaTypeGuard, readJsonBodyAsText } from '../sessions/json-body.ts';
import {
  createLargeBodyPlaces,
  largeBodyHandling,
  type LargeBodyHandling,
} from '../sessions/large-bodies.ts';
import { inSessionLine, NO_WAIT_SLOT, type WaitSlot } from '../limits/api-work.ts';
import { isJsonDeclared } from '../sessions/media-type.ts';
import {
  createBodyListPlaces,
  NO_PLACE,
  takeBodyListPlace,
  type BodyListPlaces,
} from './body-lists.ts';
import { sendList, type ListMore, type ReadListedContent } from './list-answer.ts';
import { parseListQueryString, parseQueryBody, queryStringOf } from './list-query.ts';
import { createQuerySlots, parseSearchBody, type QuerySlots } from './search.ts';
import {
  assertListIds,
  clearRequests,
  deleteRequest,
  getRequestDetails,
  listContinuation,
  listedContentReader,
  listRequests,
  queryContinuation,
  queryRequests,
  searchRequests,
  waitForRequests,
  type ChosenList,
} from './service.ts';
import { PendingWaits } from './wait.ts';

interface SessionParams {
  sessionId: string;
}

interface RequestParams extends SessionParams {
  requestId: string;
}

export interface RequestRouteOptions {
  /** How long one search or query may run; `SEARCH_TIMEOUT_MS` unless a test shortens it. */
  searchTimeoutMs?: number;
  /**
   * The list's waits pending on this listener (D200). The application passes
   * none and gets its own; a test passes one to look at it.
   */
  waits?: PendingWaits;
  /**
   * The places of list answers with bodies on this listener (D201). The
   * application passes none and gets its own, four; a test passes one to
   * look at it.
   */
  bodyListPlaces?: BodyListPlaces;
  /**
   * The places of searches and queries on this listener: the search's count
   * (D191), which a query with a body condition takes too (D196), and the
   * count of queries with none (D250); `list_requests` over MCP with a
   * condition takes the same (D203). The application passes the ones it gives
   * `/mcp`; absent, the routes keep their own two of each.
   */
  querySlots?: QuerySlots;
  /**
   * The places of large bodies, which a search or a query with a body over
   * 128 KiB, or chunked, takes (D205, D213). The application passes the
   * handling it gives the session routes; absent, the routes keep their own
   * eight.
   */
  largeBody?: LargeBodyHandling;
  /**
   * What a list call held by `wait` holds while it reads: its slot in the
   * gate in front of the API's work, which it gives back while it waits, and
   * a clear before it joins its session's line (D244). The application
   * passes the gate's; absent, none.
   */
  waitSlot?: (request: FastifyRequest) => WaitSlot;
  /**
   * Runs a read of a list answer streamed after its head - a content read, a
   * resumption - in a slot of the gate of its own, in turn, answering `gone`
   * without it once the call's response has closed (D244). The application
   * passes the gate's; absent, each read runs at once.
   */
  inSlot?: <T>(request: FastifyRequest, read: () => Promise<T>, gone: T) => Promise<T>;
}

/**
 * The reads of a list answer streamed after its head, each in a slot of the
 * gate in front of the API's work and none while the answer waits for its
 * client (D244): a read once the response has closed reads nothing, and the
 * stream, destroyed with it, ends.
 */
function slottedReads(
  request: FastifyRequest,
  readContent: ReadListedContent,
  more: ListMore,
  inSlot: RequestRouteOptions['inSlot'],
): { readContent: ReadListedContent; more: ListMore } {
  if (inSlot === undefined) {
    return { readContent, more };
  }

  return {
    readContent: (ids) => inSlot(request, () => readContent(ids), new Map()),
    more: (beyond, count) => inSlot(request, () => more(beyond, count), []),
  };
}

/**
 * Tells a call held by `wait` that its client has gone (D200). The signal is
 * the response's, not the request's: a request stream may close once it has
 * been read, while the response closes before it has ended only when the
 * connection is gone, as the receiver's delay reads it (D105). `/mcp`'s
 * `wait_for_request` reads it too (D203).
 */
export function clientGone(reply: FastifyReply): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onClose = (): void => {
    if (!reply.raw.writableEnded) {
      controller.abort();
    }
  };

  if (reply.raw.destroyed) {
    controller.abort();
  }

  reply.raw.on('close', onClose);

  return { signal: controller.signal, dispose: () => reply.raw.off('close', onClose) };
}

/**
 * The routes of a session's requests. Each hands its service the key the call
 * presented, `Authorization: Bearer <key>` (`requestKey`), which the service
 * checks where it would find a session missing (D245): a keyed session the key
 * does not open is answered `404` / `1001`, after every check before that
 * point - the query string, the body, a place or a slot - and before anything
 * of the session is read, waited on or changed.
 */
export function registerRequestRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  hub: RealtimeHub,
  options: RequestRouteOptions = {},
): void {
  // The waits pending on this listener, which its close runs out at once
  // (D200): before the server stops accepting and waits for the calls in
  // flight, so that a rollout is not held up for 30 s by a call that would
  // answer `[]` anyway.
  const waits = options.waits ?? new PendingWaits();

  app.addHook('preClose', (done) => {
    waits.close();
    done();
  });

  // The list calls that took the wait path: their `wait` was valid.
  const waiting = new WeakSet<FastifyRequest>();

  // The list answers with bodies this process writes at once, across the
  // list and the query (D201): the application builds one listener, so the
  // limit is the process's, as the search's slots are.
  const bodyListPlaces = options.bodyListPlaces ?? createBodyListPlaces();

  // The list (D037), and since D196 what its query parameters ask for: none
  // of them carries captured data, so they may be in the URL and its log line.
  // The query string is read as it arrived, not as Fastify parsed it, so that
  // a repeated parameter is refused rather than silently made an array. The
  // parameters are checked before the session is looked up. An answer with
  // content is streamed, its content read as it is written, and requests gone
  // by then replaced by those that follow (`sendList`).
  //
  // An answer with bodies takes one of the process's places (D201) before
  // its list statement, after the ids' shape is checked, and gives it back
  // when it is over, or as soon as its client goes, the statement still
  // running or not; with every place taken it is `429` / `1016` at once.
  //
  // With `wait` (D200) an empty answer is held first, until a request arrives
  // for it or the wait ends (`waitForRequests`). Waiting and writing are two
  // phases: the list is chosen, and only then written, so that the cap on
  // answers with bodies applies to the second alone - such a call takes its
  // place once it has requests to write, and none while it waits. A client
  // that leaves while it waits is written nothing, and its subscription and
  // timer are gone already. Nor does it hold its slot in the gate in front of
  // the API's work while it waits, only while it reads (D244).
  //
  // Answered during a shutdown, a call that took the wait path ends its
  // connection with the answer, whatever the answer is: the list, `[]`, a
  // `410` for a session that expired during the wait, a `404` for one the
  // cleanup removed, a `500` for a read that failed. Kept alive, as Traefik
  // keeps it, the connection would hold the listener's close until its idle
  // timeout, 72 s, and the rollout with it (D200). The header is set as the
  // answer is written, in `onSend`, which the error handler's answers pass
  // through too.
  //
  // A `HEAD`, which Fastify answers through this route's handler and hooks
  // (`exposeHeadRoutes`), is answered the `GET`'s status and headers, and
  // its list with content is never written: `onSend` destroys the answer's
  // stream before its first content read, `Readable.from` not having started
  // the generator yet, and Fastify then sends the head alone, as it did when
  // it drained the stream to no one (#210). So a `HEAD` costs its list
  // statement, which decides its status, and holds its call in flight
  // (D213), and with bodies its place (D201 point 8), for that alone.
  app.get<{ Params: SessionParams }>(
    '/api/sessions/:sessionId/requests',
    {
      onSend: async (request, reply, payload) => {
        if (waits.closed && waiting.has(request)) {
          reply.header('connection', 'close');
        }

        if (request.method === 'HEAD' && payload instanceof Readable) {
          payload.destroy();
        }

        return payload;
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params;
      const query = parseListQueryString(queryStringOf(request.originalUrl));
      const key = requestKey(request);
      let release = NO_PLACE;

      // Everything after a place is taken is inside this `try`, the beginning
      // of the answer included, so a throw before the answer's stream is there
      // to give the place back gives it back here (D201 point 8). Giving a
      // place back twice gives it back once.
      try {
        let listed: ChosenList;

        if (query.wait === null) {
          assertListIds(sessionId, query);
          release = takeBodyListPlace(bodyListPlaces, query, reply.raw);
          listed = await listRequests(pool, sessionId, query, key);
        } else {
          waiting.add(request);

          const gone = clientGone(reply);
          let waited: ChosenList | null;

          try {
            waited = await waitForRequests(
              pool,
              hub,
              waits,
              sessionId,
              query,
              gone.signal,
              key,
              options.waitSlot?.(request),
            );
          } finally {
            gone.dispose();
          }

          if (waited === null) {
            // Nothing is written to a connection that is gone, as for an aborted
            // body (D174), and no `request completed` line follows.
            request.log.info('Request aborted by the client');

            return reply.hijack();
          }

          listed = waited;

          // An empty list writes no content and resumes nothing, so it takes no place.
          if (listed.chosen.length > 0) {
            release = takeBodyListPlace(bodyListPlaces, query, reply.raw);
          }
        }

        const reads = slottedReads(
          request,
          listedContentReader(pool, sessionId, query),
          listContinuation(pool, sessionId, query, listed.after),
          options.inSlot,
        );

        return sendList(reply, listed.chosen, query, reads.readContent, reads.more, release);
      } catch (error) {
        release();

        throw error;
      }
    },
  );

  // The searches and queries this process is running, counted here once for
  // the listener: the application builds one of each count, so the limits are
  // the process's (D191). A query with a body condition takes its slot from
  // the search's count (D196), one with none from a count of its own (D250),
  // and so does `/mcp`'s `list_requests` with a condition (D203).
  const querySlots = options.querySlots ?? createQuerySlots();
  const searchTimeoutMs = options.searchTimeoutMs ?? SEARCH_TIMEOUT_MS;
  const largeBody = options.largeBody ?? largeBodyHandling(createLargeBodyPlaces());

  // Searches the raw requests of a session for each word (D191). The words
  // travel in the body, never in the URL, so no log line can hold them: the
  // request serializer logs the method, the URL, the version, the host and the
  // peer, and nothing of a body (D117, D168).
  //
  // The two routes here that read a body share a scope of their own, as the
  // session routes that read one do (`readJsonBodyAsText`, D104). The body is
  // checked completely before the session is looked up: media type, size,
  // shape, then its fields. A body over 128 KiB, or chunked, takes one of the
  // places of large bodies, shared with the session routes, before it is read
  // (D205, D213): eight words or conditions are a few KiB. Each body is let
  // go once it is parsed (`readJsonBody`).
  //
  // The static `search` and `query` segments are matched before `:requestId`,
  // and only for `POST`: `GET` and `DELETE` on these paths are still a request
  // id that cannot be one, `404` / `1003`.
  void app.register(async (scope) => {
    readJsonBodyAsText(scope);

    // Each reads its body before its handler, and so before its call waits
    // for its turn in the gate in front of the API's work (`jsonBody`, D244).
    const searchBody = jsonBody(parseSearchBody);
    const queryBody = jsonBody(parseQueryBody);

    scope.post<{ Params: SessionParams }>(
      '/api/sessions/:sessionId/requests/search',
      {
        onRequest: [mediaTypeGuard(isJsonDeclared), largeBody.guard],
        preHandler: searchBody.preHandler,
      },
      largeBody.holding(async (request) => {
        const words = searchBody.take(request);

        return searchRequests(
          pool,
          request.params.sessionId,
          words,
          querySlots.search,
          searchTimeoutMs,
          requestKey(request),
        );
      }),
    );

    // The list with header and body conditions (D196). The conditions are
    // captured data the user is looking for, so they travel in the body for
    // the reason the search's words do; the answer is the list's. With bodies
    // it takes one of the list's places (D201), as the GET does, before the
    // slot its statement runs in: the search's with a body condition, the
    // header-only queries' without (D250).
    scope.post<{ Params: SessionParams }>(
      '/api/sessions/:sessionId/requests/query',
      {
        onRequest: [mediaTypeGuard(isJsonDeclared), largeBody.guard],
        preHandler: queryBody.preHandler,
      },
      largeBody.holding(async (request, reply) => {
        const { sessionId } = request.params;
        const query = queryBody.take(request);

        assertListIds(sessionId, query);

        const release = takeBodyListPlace(bodyListPlaces, query, reply.raw);

        // The beginning of the answer inside the `try` too, as on the GET.
        try {
          const listed = await queryRequests(
            pool,
            sessionId,
            query,
            querySlots,
            searchTimeoutMs,
            requestKey(request),
          );

          const reads = slottedReads(
            request,
            listedContentReader(pool, sessionId, query),
            queryContinuation(pool, sessionId, query, listed.after, querySlots, searchTimeoutMs),
            options.inSlot,
          );

          return sendList(reply, listed.chosen, query, reads.readContent, reads.more, release);
        } catch (error) {
          release();

          throw error;
        }
      }),
    );
  });

  app.get<{ Params: RequestParams }>(
    '/api/sessions/:sessionId/requests/:requestId',
    async (request) => {
      return getRequestDetails(
        pool,
        request.params.sessionId,
        request.params.requestId,
        requestKey(request),
      );
    },
  );

  // Both deletions are announced in their own transaction, as a capture is
  // (D221): a `404` or `410` rolls back and announces nothing. Every viewer of
  // the session receives the event, the one that asked for the deletion
  // included: applying it is idempotent, so no origin is tracked (D136).
  app.delete<{ Params: RequestParams }>(
    '/api/sessions/:sessionId/requests/:requestId',
    async (request, reply) => {
      const { sessionId, requestId } = request.params;

      await deleteRequest(pool, sessionId, requestId, requestKey(request));

      return reply.status(204).send();
    },
  );

  // Announced on every `204`, including a clear of a session that held
  // nothing. Knowing would need the repository to count what it deleted, and
  // emptying an empty list is harmless to every viewer.
  //
  // A clear starts the response queue from step 1, so it takes one turn of
  // the session's line, as a capture does (`inOrder`, D205), and the session
  // row's lock before it deletes anything: a capture that held the lock
  // first, on any process, is deleted with the rest, and `requests.cleared`
  // is heard after its `request.received` (D221). A single deletion moves no
  // queue and takes no turn. The clear holds no slot of the gate in front of
  // the API's work in the line, waiting or in its turn (`inSessionLine`,
  // D244).
  app.delete<{ Params: SessionParams }>(
    '/api/sessions/:sessionId/requests',
    async (request, reply) => {
      const { sessionId } = request.params;
      const key = requestKey(request);

      await inSessionLine(hub, sessionId, options.waitSlot?.(request) ?? NO_WAIT_SLOT, () =>
        clearRequests(pool, sessionId, key),
      );

      return reply.status(204).send();
    },
  );
}
