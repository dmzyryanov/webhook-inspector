import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { SESSION_ID_PATTERN } from '@webhook-inspector/shared';
import { receiveUrlMoved } from '../../errors/app-error.ts';
import { drainRefusedBody } from '../sessions/refused-body.ts';
import { extractPath } from './raw-request.ts';

/**
 * Where a session receives webhooks: the receive listener's public origin and
 * `/s/<id>` (D187). Composed on every answer from configuration, never stored,
 * so moving the receive host changes every session's URL at once.
 */
export function receiveUrlFor(receiveOrigin: string, sessionId: string): string {
  return `${receiveOrigin}/s/${sessionId}`;
}

/**
 * The message of the old host's `410`. It names the session's receive URL when
 * the segment after `/s/` is shaped as a session id, and the receive host's
 * pattern otherwise. Nothing else the request carried is repeated (D106), and
 * the database is not read, so the answer says nothing about whether such a
 * session exists (D058).
 */
export function receiveUrlMovedMessage(receiveOrigin: string, url: string): string {
  const segment = extractPath(url).slice('/s/'.length).split('/')[0] ?? '';

  return SESSION_ID_PATTERN.test(segment)
    ? `Webhooks for this session are received at ${receiveUrlFor(receiveOrigin, segment)}`
    : `Webhooks are received at ${receiveOrigin}/s/<session-id>`;
}

/**
 * `/s/...` on the application listener: since 0.36.0 webhooks are received on
 * the receive host only, and this host answers `410` / `1009` naming the URL to
 * send to instead, whatever the method and whatever the path under `/s/`
 * (D187). Nothing is stored.
 *
 * The refusal is thrown from `onRequest`, before Fastify reads a byte of the
 * body, so neither a body over the limit, nor a `Content-Type` no parser takes,
 * nor a `QUERY` without content can turn it into another answer (D166). Thrown
 * with the body unread, it drains the body first on a connection Node is about
 * to close, as the create route's refusal does (D143), holding one of the
 * process's 8 drain places meanwhile, the ones the receive host's `1018`
 * refusals drain with (D228): `/s/...` takes no place among an address's calls
 * in flight (D213), so nothing else bounds how many such drains run at once. A
 * refusal that finds every place taken is answered at once, its body unread,
 * and its connection, which Node was about to close, ends with the answer. The
 * route's handler is never reached; it exists so that the router sends every
 * method and every depth under `/s/` here rather than to the not-found handler.
 */
export function receiveUrlMovedRoutes(receiveOrigin: string): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    app.addHook('onRequest', async (request, reply) => {
      await drainRefusedBody(request.raw, reply.raw.shouldKeepAlive);

      throw receiveUrlMoved(receiveUrlMovedMessage(receiveOrigin, request.originalUrl));
    });

    app.all('/s/*', async () => {
      throw receiveUrlMoved(`Webhooks are received at ${receiveOrigin}/s/<session-id>`);
    });
  };
}
