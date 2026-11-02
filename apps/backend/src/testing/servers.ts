/**
 * The two listeners a process runs (D187), built for a test: the application
 * listener as `api`, the receive listener as `receiver`, sharing one realtime
 * hub as `index.ts` makes them share it, and the process's realtime listener
 * feeding that hub with what the outbox announces (D221), so that a capture
 * sent to `receiver` reaches a viewer connected to `api`.
 *
 * Two calls on two pools are two processes on one database: what one
 * announces reaches the other's viewers through PostgreSQL, as it would
 * across a rollout. Within one, `capturePool` gives the receive listener and
 * `/readyz` a pool of their own, as `index.ts` does (D244); absent, both
 * listeners share `pool`.
 *
 * Not a test file itself: only `*.test.ts` files import it.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { Drain } from '../lib/drain.ts';
import type { RateLimitSettings } from '../modules/limits/rate-limit.ts';
import { RealtimeHub } from '../modules/realtime/hub.ts';
import { RealtimeListener, type ListenerOptions } from '../modules/realtime/listener.ts';
import { PendingWrites } from '../modules/webhook/routes.ts';
import { buildReceiver, buildServer, type ReceiverOptions, type ServerOptions } from '../server.ts';

/**
 * Per-address limits no test file reaches (D201), for a file that calls one
 * listener from one address more often than production allows - dozens of
 * sessions created within a minute, say. Every other test runs under the
 * production limits, which `modules/limits/` tests at their real numbers.
 */
export const LIMITS_OUT_OF_REACH: RateLimitSettings = {
  sessionCreates: 1_000_000,
  apiCalls: 1_000_000,
};

export interface TestServers {
  api: FastifyInstance;
  receiver: FastifyInstance;
  hub: RealtimeHub;
  /** The process's realtime listener, listening once `api` is ready. */
  listener: RealtimeListener;
  drain: Drain;
  writes: PendingWrites;
  /** Both listeners' `ready()`, the realtime listener's first `LISTEN` included. */
  ready(): Promise<void>;
  /**
   * Resolves once everything committed so far has been delivered to this
   * process's hub (`RealtimeListener.flush`). A test that asserts nothing was
   * delivered calls it first.
   */
  flush(): Promise<void>;
  /** Both listeners' `close()`, then the realtime listener's `stop()`. */
  close(): Promise<void>;
}

export interface TestServerOptions extends ServerOptions, ReceiverOptions {
  /** What the realtime listener is built with, besides its connection, hub, log and pool. */
  listener?: Partial<Omit<ListenerOptions, 'connectionString' | 'hub' | 'log' | 'pool'>>;
}

export function buildTestServers(pool: pg.Pool, options: TestServerOptions = {}): TestServers {
  const hub = options.hub ?? new RealtimeHub();
  const drain = options.drain ?? new Drain();
  const writes = options.writes ?? new PendingWrites();
  const connectionString = pool.options.connectionString ?? process.env.DATABASE_URL;

  if (connectionString === undefined) {
    throw new Error('The test pool has no connection string for the realtime listener');
  }

  // Declared before the servers, which read whether it has listened.
  let listener: RealtimeListener | null = null;
  const capturePool = options.capturePool ?? pool;
  const api = buildServer(pool, {
    ...options,
    capturePool,
    hub,
    drain,
    realtimeReady: options.realtimeReady ?? (() => listener?.listenedOnce ?? false),
  });
  const receiver = buildReceiver(capturePool, { ...options, hub, drain, writes });

  listener = new RealtimeListener({
    ...options.listener,
    connectionString,
    hub,
    log: api.log,
    pool,
    otherPools: capturePool === pool ? [] : [capturePool],
  });

  const started = listener;

  // Neither listener is ready, nor listening, before the realtime listener
  // has listened once: a viewer connected earlier would be refused `1013`.
  api.addHook('onReady', async () => {
    await started.whenListening();
  });
  started.start();

  return {
    api,
    receiver,
    hub,
    listener: started,
    drain,
    writes,
    ready: async () => {
      await Promise.all([api.ready(), receiver.ready()]);
    },
    flush: () => started.flush(),
    close: async () => {
      await Promise.all([api.close(), receiver.close()]);
      await writes.settled();
      await started.stop();
    },
  };
}

/**
 * A realtime listener for one listener a test built itself with `buildServer`
 * or `buildReceiver`, feeding `hub` as the process's listener feeds its hub
 * (D221): the server is not ready before the listener has listened, and its
 * close stops the listener. What a test gives `hub` - a wait, a viewer - then
 * hears what the outbox announces, a clear ending a wait included.
 */
export function attachListener(
  app: FastifyInstance,
  pool: pg.Pool,
  hub: RealtimeHub,
  options: TestServerOptions['listener'] = {},
): RealtimeListener {
  const connectionString = pool.options.connectionString ?? process.env.DATABASE_URL;

  if (connectionString === undefined) {
    throw new Error('The test pool has no connection string for the realtime listener');
  }

  const listener = new RealtimeListener({
    ...options,
    connectionString,
    hub,
    log: app.log,
    pool,
  });

  app.addHook('onReady', async () => {
    await listener.whenListening();
  });
  app.addHook('onClose', async () => {
    await listener.stop();
  });
  listener.start();

  return listener;
}
