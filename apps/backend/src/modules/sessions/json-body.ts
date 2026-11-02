/**
 * What the routes that read a JSON body share (D104): the guard that settles
 * the media type before the body is read, the parsers of the scope such a
 * route is registered in, and the body taken off the request once read.
 * Session creation, the response change, the queue save (D205), the status
 * read (D199), the search of raw requests (D191) and the query of requests
 * (D196) use them, each reading its body in a `preHandler` (`jsonBody`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { malformedRequestBody, unsupportedMediaType } from '../../errors/app-error.ts';
import { drainRequestBody, shouldDrainRefusedBody } from './refused-body.ts';

/**
 * UTF-8 and nothing else, which is what JSON exchanged between systems must be
 * (RFC 8259). `ignoreBOM` keeps a byte order mark in the text, as reading the
 * body as a string did, so such a body is still refused by `JSON.parse`.
 */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A guard that answers `415` before the body is read, for a route whose media
 * type rule is `accepts`.
 *
 * onRequest, not preValidation: by the latter Fastify has already selected a
 * parser and enforced bodyLimit, so an oversized non-JSON body would have been
 * answered 413 before the media type was looked at, contradicting the
 * normative order (D104).
 *
 * Refusing here means answering with the body unread. On a connection Node is
 * about to close, that body is read and discarded first, within a bound, or the
 * close would be a reset that loses the answer (D143).
 */
export function mediaTypeGuard(accepts: (rawHeaders: string[]) => boolean) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!accepts(request.raw.rawHeaders)) {
      if (shouldDrainRefusedBody(request.raw.rawHeaders, reply.raw.shouldKeepAlive)) {
        await drainRequestBody(request.raw);
      }

      throw unsupportedMediaType();
    }
  };
}

/**
 * What `parse` makes of the body a route of such a scope was handed - text,
 * or `undefined` when there is none - with the body taken off the request
 * first, as `/mcp`'s `readMessage` takes its own (D203). Whatever keeps the
 * request while the route then waits - for one of the pool's connections, for
 * a session's row lock, for its turn of the session's line - keeps none of
 * the up to 1 MiB it came in, decoded into a string that takes two bytes a
 * character once one of them is outside Latin-1 (D213).
 *
 * A function of its own, so that the text is held by no local of the
 * handler, which would keep it across the handler's waits: what it answers
 * is what `parse` built.
 */
export function readJsonBody<T>(
  request: FastifyRequest,
  parse: (body: string | undefined) => T,
): T {
  const body = typeof request.body === 'string' ? request.body : undefined;

  request.body = undefined;

  return parse(body);
}

/**
 * A route's body, read in its `preHandler`: `parse` makes what the handler
 * needs of the text, which is taken off the request first (`readJsonBody`),
 * and the handler `take`s what was made, which nothing else then holds.
 * Before the handler, so before its call waits for its turn in the gate in
 * front of the API's work (D244): a call waiting there keeps what it parsed,
 * not the up to 1 MiB it came in (D213). What `parse` throws is answered as
 * it was from the handler, before anything else of the call is done.
 */
export function jsonBody<T>(parse: (body: string | undefined) => T): {
  preHandler: (request: FastifyRequest) => Promise<void>;
  take: (request: FastifyRequest) => T;
} {
  const parsed = new WeakMap<FastifyRequest, { value: T }>();

  return {
    preHandler: async (request) => {
      parsed.set(request, { value: readJsonBody(request, parse) });
    },
    take: (request) => {
      const held = parsed.get(request);

      if (held === undefined) {
        throw new Error('The body was not read before the handler');
      }

      parsed.delete(request);

      return held.value;
    },
  };
}

/**
 * Makes an encapsulated scope hand a declared-JSON body to its routes as text.
 *
 * Routes that read a JSON body are registered inside their own scope so that
 * their body handling and their media-type rule reach nothing else. A hook or
 * a parser on the root instance would propagate into the webhook plugin and
 * reject every non-JSON webhook, destroying capture (D104).
 */
export function readJsonBodyAsText(scope: FastifyInstance): void {
  scope.removeAllContentTypeParsers();

  // The body is read as text and parsed by the route's validator, so that an
  // empty or unparseable JSON body answers 400 / 1006 instead of the 500
  // Fastify's own JSON parser produced (D104).
  //
  // Read as bytes and decoded here, not with `parseAs: 'string'`: Fastify then
  // decodes with replacement and compares the length of the decoded text with
  // `Content-Length`, so a body holding bytes that are not UTF-8 failed that
  // comparison and was answered 500 / 1500 (found with #103). Bytes that are
  // not UTF-8 make a body that is not JSON: 400 / 1006 (D196).
  scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    let text: string;

    try {
      text = utf8.decode(body as Buffer);
    } catch {
      done(malformedRequestBody());

      return;
    }

    done(null, text);
  });

  // Unreachable behind the guards. Registered so that a media type which ever
  // slipped past them is answered loudly rather than parsed and ignored.
  scope.addContentTypeParser('*', { parseAs: 'string' }, (_request, _body, done) => {
    done(unsupportedMediaType());
  });
}
