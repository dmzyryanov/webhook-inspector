/**
 * The parsers of the application listener's own scope, which every route
 * that takes no body uses: the four deletions and the queue's restart, so
 * that a body none of them reads is not held while they wait (D213). The
 * not-found route, which answers every method of a path no route
 * has, used them too until D227; it is answered `404` before any parser now
 * (`createApp`'s `preParsing`, `server.ts`), and reads no body. The routes
 * that read a body - the seven JSON routes and `POST /mcp` - replace them in
 * scopes of their own, and every other route either takes only methods
 * Fastify reads no body for, `GET` and `HEAD`, or answers before the body,
 * as `/s/...`'s `410` and `/mcp`'s `405` do.
 *
 * Fastify's own two, `application/json` and `text/plain`, read up to the
 * listener's 1 MiB and gave the route what they parsed, which it kept as
 * `request.body` across every wait of its handler: two queue restarts each
 * sending a 1 MiB array of empty objects held about 44 MiB while the pool did
 * not answer, outside the places of large bodies, and an address may have 128
 * calls in flight. These read at most `MAX_IGNORED_BODY_BYTES` and give the
 * route nothing. A body sent anyway is answered by the rules it was (D104):
 * one declared `application/json` that is empty or does not parse is `400` /
 * `1006`, with Fastify's own JSON parser and its errors, a `text/plain` one is
 * read and ignored, and any other media type is `415` / `1007` unread. Only
 * the size is new: over 1 KiB is `413` / `1004`, before a byte is read when
 * the length is declared. And bytes that are not UTF-8 make a declared-JSON
 * body that does not parse, `400` / `1006`, as on the JSON routes (D196),
 * where Fastify's decoding replaced them and then failed its own length
 * check.
 *
 * Chosen over a parser that discards a body of any length as it arrives,
 * which would keep nothing either: it could not tell a body that does not
 * parse, so a `400` would become a deletion, and a body of up to 1 MiB would
 * still keep its call's request for as long as its client takes to send it.
 * No client the documentation names sends a body to these routes: the
 * frontend sends none and no `Content-Type`, the relay script never calls
 * them, and `/mcp`'s tools call the services, not the routes.
 *
 * A parser of its own rather than Fastify's `parseAs` with a `bodyLimit`:
 * Fastify gives the not-found route the listener's 1 MiB in place of any
 * parser's limit, and this bound was the not-found route's too until D227.
 */
import type { Readable } from 'node:stream';
import { errorCodes, type FastifyInstance } from 'fastify';
import { MAX_IGNORED_BODY_BYTES } from '@webhook-inspector/shared';

/**
 * UTF-8 and nothing else, as the JSON routes read a body (`json-body.ts`):
 * bytes that are not make a body that does not parse.
 */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Reads `payload`, a request body declared `declaredLength` bytes long - the
 * `Content-Length` as it arrived, or nothing for a chunked one - and calls
 * `done` exactly once: with its bytes, when it has ended within `limit`; with
 * Fastify's `413` when its declared length is over `limit`, before a byte is
 * read, or once more than `limit` bytes have arrived, whatever was declared;
 * with the stream's error, given status `400` if it has none, when the
 * request goes before its end; and with Fastify's error for a length that
 * does not match, when the body ended at another one.
 *
 * Past `limit` nothing more is kept: the stream goes on flowing, as Fastify
 * leaves a body it refuses, and what arrives is discarded. The same shape as
 * Fastify's own reading of a body, which the error handler already answers.
 */
export function readAtMost(
  payload: Readable,
  declaredLength: string | undefined,
  limit: number,
  done: (error: Error | null, bytes?: Buffer) => void,
): void {
  const declared = Number(declaredLength);

  if (declared > limit) {
    done(new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE());

    return;
  }

  const chunks: Buffer[] = [];
  let received = 0;

  const stop = (): void => {
    payload.off('data', onData);
    payload.off('end', onEnd);
    payload.off('error', onEnd);
  };

  function onData(chunk: Buffer): void {
    received += chunk.length;

    if (received > limit) {
      stop();
      chunks.length = 0;
      done(new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE());

      return;
    }

    chunks.push(chunk);
  }

  function onEnd(error?: Error & { statusCode?: number }): void {
    stop();

    if (error !== undefined && error !== null) {
      if (!(typeof error.statusCode === 'number' && error.statusCode >= 400)) {
        error.statusCode = 400;
      }

      done(error);

      return;
    }

    if (!Number.isNaN(declared) && received !== declared) {
      done(new errorCodes.FST_ERR_CTP_INVALID_CONTENT_LENGTH());

      return;
    }

    done(null, Buffer.concat(chunks));
  }

  payload.on('data', onData);
  payload.on('end', onEnd);
  payload.on('error', onEnd);
  payload.resume();
}

/**
 * Makes `app`'s own scope read a body of a route that takes none by the rules
 * above. Called before any route and any scope, which copies the parsers it
 * is created with.
 */
export function ignoreUnusedBodies(app: FastifyInstance): void {
  const parseJson = app.getDefaultJsonParser('error', 'error');

  app.removeAllContentTypeParsers();

  app.addContentTypeParser('application/json', (request, payload, done) => {
    readAtMost(
      payload,
      request.headers['content-length'],
      MAX_IGNORED_BODY_BYTES,
      (error, bytes) => {
        if (error !== null) {
          done(error, undefined);

          return;
        }

        let text: string;

        try {
          text = utf8.decode(bytes);
        } catch {
          done(new errorCodes.FST_ERR_CTP_INVALID_JSON_BODY(), undefined);

          return;
        }

        // Checked by Fastify's own parser, `__proto__` refused as it was, and
        // what it parsed dropped: the route is given nothing.
        parseJson(request, text, (parseError) => {
          done(parseError ?? null, undefined);
        });
      },
    );
  });

  app.addContentTypeParser('text/plain', (request, payload, done) => {
    readAtMost(payload, request.headers['content-length'], MAX_IGNORED_BODY_BYTES, (error) => {
      done(error, undefined);
    });
  });
}
