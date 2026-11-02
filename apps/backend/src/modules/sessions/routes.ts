import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { inSessionLine, NO_WAIT_SLOT, type WaitSlot } from '../limits/api-work.ts';
import type { RealtimeHub } from '../realtime/hub.ts';
import { receiveUrlFor } from '../webhook/receive-url.ts';
import { invalidResponseConfig } from '../../errors/app-error.ts';
import { creationKey, requestKey } from './access-key.ts';
import { jsonBody, mediaTypeGuard, readJsonBodyAsText } from './json-body.ts';
import type { LargeBodyHandling } from './large-bodies.ts';
import { isAcceptableCreateMediaType, isJsonDeclared } from './media-type.ts';
import {
  CREATION_KEY_RULE,
  parseCreateSessionBody,
  parseQueueBody,
  parseResponseChangeBody,
  parseRulesBody,
} from './response-config.ts';
import {
  changeSessionQueue,
  changeSessionResponse,
  changeSessionRules,
  createSession,
  deleteSession,
  getSessionDetails,
  getSessionStatuses,
} from './service.ts';
import { parseStatusBody } from './status-body.ts';

/**
 * `receiveOrigin` is the receive listener's public origin, from which both
 * session answers compose `receiveUrl` (D187). `largeBody` is the handling of
 * the places a large body takes (D205), shared with the search and the query
 * of requests (D213): taken once the media type is settled, before the body
 * is read, and held until the response has closed and the handler has
 * settled.
 *
 * Each route that reads a body takes it off the request once it is parsed
 * (`readJsonBody`), so that a handler waiting on the database keeps only what
 * was parsed from it (D213) - parsed in its `preHandler`, before the call
 * waits for its turn in the gate in front of the API's work (`jsonBody`,
 * D244).
 *
 * Every route with a session id hands its service the key the call presented,
 * `Authorization: Bearer <key>` (`requestKey`), which the service checks where
 * it looks the session up (D245): a keyed session the key does not open is
 * answered `404` / `1001`, after every check that comes before the session
 * is looked up, exactly as one that does not exist.
 *
 * `slotOf` is a call's slot in the gate in front of the API's work, which
 * each change gives back before it joins its session's line, so that no
 * call waiting in a line holds one, nor its turn (`inSessionLine`, D244).
 * The application passes the gate's; absent, none.
 */
export function registerSessionRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  hub: RealtimeHub,
  receiveOrigin: string,
  largeBody: LargeBodyHandling,
  slotOf: (request: FastifyRequest) => WaitSlot = () => NO_WAIT_SLOT,
): void {
  // The five routes that read a JSON body are registered inside their own
  // encapsulated scope, so that their body handling and their media-type rule
  // reach nothing else (`readJsonBodyAsText`, D104).
  void app.register(async (scope) => {
    readJsonBodyAsText(scope);

    // Each reads its body before its handler, and so before its call waits
    // for its turn in the gate in front of the API's work (`jsonBody`, D244).
    const createBody = jsonBody(parseCreateSessionBody);
    const responseBody = jsonBody(parseResponseChangeBody);
    const queueBody = jsonBody(parseQueueBody);
    const rulesBody = jsonBody(parseRulesBody);
    const statusBody = jsonBody(parseStatusBody);

    // A creation carrying a response and a full queue is read within the same
    // 1 MiB as every other JSON body, and a large one only while one of the
    // places of large bodies is free (D205). A lifetime beside them, or alone,
    // fixes the session's end (D220); an idle window, the one it slides by
    // (D242); `storeSourceIp: false`, that its captures keep no sender
    // address (D243); `rules`, the response rules it starts with, within the
    // same 1 MiB (D246).
    //
    // `"private": true` makes it private (D253), and only then is
    // `Authorization` read: no header draws a key, answered once as
    // `accessKey`; `Bearer <key>` creates the session under that key, never
    // answered back; a header carrying no key is `400` / `1005` after every
    // rule of the body, and nothing is created. Without `private`, or with
    // `false`, the header is ignored as it always was.
    scope.post(
      '/api/sessions',
      {
        onRequest: [mediaTypeGuard(isAcceptableCreateMediaType), largeBody.guard],
        preHandler: createBody.preHandler,
      },
      largeBody.holding(async (request, reply) => {
        const body = createBody.take(request);
        const access = body.private ? creationKey(request.headers.authorization) : null;

        if (access?.kind === 'none') {
          throw invalidResponseConfig(CREATION_KEY_RULE);
        }

        const session = await createSession(
          pool,
          body.response,
          body.queue,
          body.expiresInSeconds,
          body.expiresAfterIdleSeconds,
          body.storeSourceIp,
          body.rules,
          access,
        );

        return reply.status(201).send({
          id: session.id,
          expiresAt: session.expiresAt,
          receiveUrl: receiveUrlFor(receiveOrigin, session.id),
          private: session.private,
          ...(session.accessKey === undefined ? {} : { accessKey: session.accessKey }),
        });
      }),
    );

    // Changes the response of a running session (D150). The body is checked
    // completely before the session is looked up - media type, size, shape,
    // then the same `response` rules creation applies - and only then is the
    // session locked, refused as `404` or `410`, and written.
    //
    // Announced in the change's transaction, and heard once it commits, in
    // the order the change took the row's lock among the session's captures
    // and queue calls (D205, D221): a refused change rolls back and announces
    // nothing. Every declaring viewer receives it, the one that made the
    // change included, because applying the same state twice changes nothing
    // (D136, D152). The change takes one turn of the session's line, after
    // the body is read and checked (`inOrder`, D205), and holds no slot of
    // the gate in front of the API's work there, waiting or in its turn, as
    // none of the changes below does (`inSessionLine`, D244).
    //
    // A body over 128 KiB, or chunked, takes one of the places of large
    // bodies, as a queue save does (D213): a valid response is at most
    // 73,873 bytes of JSON, so an ordinary client never takes one. The place
    // stays taken while the handler waits for the session's line and its row
    // lock, a client gone meanwhile included; the body itself is let go once
    // it is parsed.
    scope.put<{ Params: { sessionId: string } }>(
      '/api/sessions/:sessionId/response',
      {
        onRequest: [mediaTypeGuard(isJsonDeclared), largeBody.guard],
        preHandler: responseBody.preHandler,
      },
      largeBody.holding(async (request) => {
        const change = responseBody.take(request);
        const { sessionId } = request.params;

        // The logger is passed for the same one purpose as on the read below: a
        // change is a use of the session, and a refresh that fails is reported
        // rather than raised (D133).
        const key = requestKey(request);

        return inSessionLine(hub, sessionId, slotOf(request), () =>
          changeSessionResponse(pool, sessionId, change, request.log, key),
        );
      }),
    );

    // Saves a response queue and starts it from step 1 (D205): the body is
    // checked completely - media type, size, shape, then every step by the
    // rules a response is checked by - before the session is locked, refused
    // as `404` or `410`, and written, and the new state is announced in its
    // transaction, as a response change is. Its body is read within the
    // 1 MiB of every JSON route, which holds ten steps of ordinary text at
    // every limit of D101; a queue written larger is refused as too large. A
    // large body is read only while one of the places of large bodies is
    // free, shared with creation; with all of them taken it is `429` / `1017`
    // before it is read. The place stays taken while the handler holds the
    // parsed queue, a client gone meanwhile included - while it waits for its
    // turn of the session's line too (`inOrder`, D205).
    scope.put<{ Params: { sessionId: string } }>(
      '/api/sessions/:sessionId/queue',
      {
        onRequest: [mediaTypeGuard(isJsonDeclared), largeBody.guard],
        preHandler: queueBody.preHandler,
      },
      largeBody.holding(async (request) => {
        const steps = queueBody.take(request);
        const { sessionId } = request.params;
        const key = requestKey(request);

        const answered = await inSessionLine(hub, sessionId, slotOf(request), () =>
          changeSessionQueue(pool, sessionId, { action: 'set', steps }, request.log, key),
        );

        return answered.state;
      }),
    );

    // Saves the session's response rules, replacing all it had, `[]` removing
    // them (D246): the body is checked completely - media type, size, shape,
    // then each rule, its response by the rules a response is checked by -
    // before the session is locked, refused as `404` or `410`, and written,
    // and the new state is announced in its transaction, as a queue save is.
    // Its body is read within the 1 MiB of every JSON route, which holds
    // twenty rules of ordinary responses, or fourteen at every limit of D101.
    // A large body takes one of the places of large bodies, as a queue save
    // does, held while the handler waits for its turn of the session's line
    // and holds the parsed rules (`inOrder`, D205). The queue's position is
    // left where it is.
    scope.put<{ Params: { sessionId: string } }>(
      '/api/sessions/:sessionId/rules',
      {
        onRequest: [mediaTypeGuard(isJsonDeclared), largeBody.guard],
        preHandler: rulesBody.preHandler,
      },
      largeBody.holding(async (request) => {
        const rules = rulesBody.take(request);
        const { sessionId } = request.params;
        const key = requestKey(request);

        return inSessionLine(hub, sessionId, slotOf(request), () =>
          changeSessionRules(pool, sessionId, rules, request.log, key),
        );
      }),
    );

    // The status of up to 50 sessions at once, for the home page's list of the
    // sessions used in a browser (D199). The ids travel in the body, never in
    // the URL, so no log line holds them: the request serializer logs the
    // method, the URL, the version, the host and the peer, and nothing of a
    // body (D117, D168), as D191 keeps search words out of URLs. The body is
    // checked completely - media type, size, shape, then `ids` - before
    // anything is read, and the read is not a use of any session (D133). A
    // body over 128 KiB, or chunked, takes one of the places of large bodies
    // (D213); fifty ids are under 3 KiB.
    //
    // A static path: Fastify matches it before `/api/sessions/:sessionId`,
    // which has no `POST`. `GET` and `DELETE` on it reach that route, which
    // reads `status` as an id that cannot be one: `404` / `1001`.
    //
    // A keyed session is reported only when its key travels beside its id,
    // in the body's `accessKeys`, and is `not_found` otherwise (D245); the
    // `Authorization` header plays no part here, since one call asks about
    // many sessions.
    scope.post(
      '/api/sessions/status',
      {
        onRequest: [mediaTypeGuard(isJsonDeclared), largeBody.guard],
        preHandler: statusBody.preHandler,
      },
      largeBody.holding(async (request) => {
        const { ids, accessKeys } = statusBody.take(request);
        const entries = await getSessionStatuses(pool, ids, accessKeys);

        return {
          sessions: entries.map((entry) =>
            entry.state === 'active'
              ? {
                  id: entry.id,
                  state: entry.state,
                  receiveUrl: receiveUrlFor(receiveOrigin, entry.id),
                  requestsCount: entry.requestsCount,
                  lastRequestAt: entry.lastRequestAt,
                  lastUsedAt: entry.lastUsedAt,
                }
              : entry,
          ),
        };
      }),
    );
  });

  // Removes the queue, and starts a saved one from step 1 again without
  // sending it (D205). Outside the scope above, like the deletions: they take
  // no body, and one sent anyway is answered by the same rules as theirs
  // (D104), the listener's own parsers reading at most 1 KiB of it and
  // giving the route nothing (`lib/ignored-body.ts`, D213). Each is a use of the session, refused and announced as a response
  // change is, in its turn of the session's line (D133, D150, D152, D205) - on
  // a session that holds no queue it changes nothing a viewer shows, so it is
  // answered and is a use all the same, and announces nothing.
  app.delete<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/queue',
    async (request) => {
      const { sessionId } = request.params;
      const key = requestKey(request);
      const answered = await inSessionLine(hub, sessionId, slotOf(request), () =>
        changeSessionQueue(pool, sessionId, { action: 'remove' }, request.log, key),
      );

      return answered.state;
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/queue/restart',
    async (request) => {
      const { sessionId } = request.params;
      const key = requestKey(request);
      const answered = await inSessionLine(hub, sessionId, slotOf(request), () =>
        changeSessionQueue(pool, sessionId, { action: 'restart' }, request.log, key),
      );

      return answered.state;
    },
  );

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (request) => {
    // The logger is passed for one purpose: a refresh that fails is reported
    // rather than raised (D133).
    const session = await getSessionDetails(
      pool,
      request.params.sessionId,
      request.log,
      requestKey(request),
    );

    return { ...session, receiveUrl: receiveUrlFor(receiveOrigin, session.id) };
  });

  // Deletes the session with its requests and their responses (D198). Outside
  // the scope above, like the two request deletions: it takes no body, and one
  // sent anyway is answered by the same rules as theirs (D104), at most 1 KiB
  // of it read and nothing of it kept (`lib/ignored-body.ts`, D213).
  //
  // Every connection watching the session, on every process, is closed with
  // `4404` once the service finds the session gone: after the deletion
  // commits, and on the `404` for a well-formed id that names no session,
  // which is how a retry repairs a deletion whose commit was acknowledged to
  // nobody (D198, D221). A deletion that fails, an expired session and a
  // refused body close nothing. `4404` is the code a connection opened
  // afterwards is refused with, so a viewer reads both the same way, and a tab
  // running an older bundle already treats it at any moment as the end of the
  // session (D076).
  app.delete<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId',
    async (request, reply) => {
      await deleteSession(pool, request.params.sessionId, requestKey(request));

      return reply.status(204).send();
    },
  );
}
