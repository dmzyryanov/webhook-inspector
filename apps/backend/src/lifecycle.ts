/**
 * How the backend process ends (D221): Kubernetes runs the pod's `preStop`
 * hook, which sends SIGUSR2 and pauses 10 s, then sends SIGTERM, and kills the
 * pod `terminationGracePeriodSeconds`, 60 s, after it began
 * (`deploy/helm/qa-tools/templates/backend.yaml`).
 *
 * - **SIGUSR2 drains** (`drainProcess`): both listeners keep serving; from
 *   then on every answer over HTTP/1.1 ends its connection, and every HTTP/2
 *   session of the receive listener is sent a GOAWAY, its open streams
 *   answered (D263), so that Traefik, which stops sending the pod new
 *   requests during the pause, keeps no connection to it alive.
 * - **SIGTERM shuts down** (`shutdown`): the drain, if SIGUSR2 did not start
 *   it; then both listeners close - neither accepts a connection any more, a
 *   request already arriving is served and none is answered `503`, every list
 *   call held by `wait` is answered at once (D200), every realtime connection
 *   is closed - and their close waits for every request in flight, a webhook
 *   whose reply a configured delay of up to 30 s holds included; then the
 *   completion writes of the replies written meanwhile are awaited, so that
 *   their outcome is recorded and announced; then the realtime listener
 *   stops, and both pools end, capture's and the API's (D244).
 *
 * `index.ts` wires the signals to these; `lifecycle.test.ts` runs them.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Drain } from './lib/drain.ts';
import type { RealtimeListener } from './modules/realtime/listener.ts';
import type { PendingWrites } from './modules/webhook/routes.ts';

/** What the process is made of, as `index.ts` builds it. */
export interface ProcessParts {
  app: FastifyInstance;
  receiver: FastifyInstance;
  /** Capture's own pool and the API's (D244), both ended last. */
  pools: readonly pg.Pool[];
  listener: RealtimeListener;
  drain: Drain;
  writes: PendingWrites;
}

/**
 * SIGUSR2: from now on every answer over HTTP/1.1 ends its connection, and
 * every HTTP/2 session is sent a GOAWAY, its open streams answered; nothing
 * else changes.
 */
export function drainProcess(parts: ProcessParts): void {
  if (!parts.drain.draining) {
    parts.drain.start();
    parts.app.log.info(
      {},
      'Draining: every answer now ends its connection, every HTTP/2 session is sent a GOAWAY',
    );
  }
}

/**
 * SIGTERM: drains, closes both listeners and waits for what is in flight,
 * waits for the completion writes, stops the listener and ends the pools.
 * Resolves once everything has ended; rejects with the first failure, after
 * which the caller exits anyway.
 */
export async function shutdown(parts: ProcessParts, signal: string): Promise<void> {
  parts.app.log.info({ signal }, 'Shutting down');
  drainProcess(parts);

  await Promise.all([parts.receiver.close(), parts.app.close()]);
  await parts.writes.settled();
  await parts.listener.stop();
  await Promise.all(parts.pools.map((pool) => pool.end()));
}
