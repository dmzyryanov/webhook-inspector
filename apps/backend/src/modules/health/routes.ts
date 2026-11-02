import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

/**
 * Probe endpoints for Kubernetes (D086).
 *
 * These are not part of the public API and the Ingress does not route to them,
 * so they are reachable only from inside the cluster.
 *
 * Both log at `warn` and above only: the readiness probe asks every 2 s
 * (D221), and a line for each answer would drown the log. A failed readiness
 * check is still logged, at `error`.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  capturePool: pg.Pool,
  realtimeReady: () => boolean,
): void {
  /**
   * Liveness: is this process still able to answer at all? It deliberately
   * does not touch the database, because a database that is briefly away is a
   * reason to stop sending traffic, not a reason to kill a working process.
   */
  app.get('/healthz', { logLevel: 'warn' }, async (_request, reply) => {
    return reply.send({ status: 'ok' });
  });

  /**
   * Readiness: can this process serve a request that needs the database? While
   * this fails, Kubernetes removes the pod from the Service, which is what
   * keeps a rollout from sending traffic to a backend whose pool is not up yet.
   *
   * Asked of capture's own pool (D244): a flood of API calls fills the API's
   * pool and leaves this one alone, so it does not mark the pod unready and
   * stop capture with it; while capture can reach the database the pod is
   * ready.
   *
   * Not before the realtime listener has listened once (D221): a process that
   * has never heard the channel would refuse every viewer with `1013`. Once it
   * has, a lost channel no longer counts - the listener connects again on its
   * own, and a pod taken out of the Service for it would turn a blip of
   * realtime into a refused API (D086).
   */
  app.get('/readyz', { logLevel: 'warn' }, async (_request, reply) => {
    if (!realtimeReady()) {
      return reply.status(503).send({ status: 'unavailable' });
    }

    try {
      await capturePool.query('SELECT 1');

      return reply.send({ status: 'ok' });
    } catch (error) {
      app.log.error({ err: error }, 'Readiness probe failed');

      return reply.status(503).send({ status: 'unavailable' });
    }
  });
}
