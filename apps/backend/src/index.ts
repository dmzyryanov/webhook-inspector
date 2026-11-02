import { loadConfig } from './config.ts';
import { API_POOL_CONNECTIONS, CAPTURE_POOL_CONNECTIONS, createPool } from './db/pool.ts';
import { drainProcess, shutdown, type ProcessParts } from './lifecycle.ts';
import { Drain } from './lib/drain.ts';
import { RealtimeHub } from './modules/realtime/hub.ts';
import { RealtimeListener } from './modules/realtime/listener.ts';
import { PendingWrites } from './modules/webhook/routes.ts';
import { buildReceiver, buildServer } from './server.ts';

const config = loadConfig();
// A connection the server ends is reported to the application listener's log
// (`createPool`), which exists once the server is built: `app` is assigned
// before this module first awaits, and no connection can end before then.
const poolLog = { warn: (details: object, message: string) => app.log.warn(details, message) };
// Two pools (D244): capture's own, for the receive listener and `/readyz`,
// and the API's, for everything else, so that no call of the API can take a
// connection a capture needs. About 17 connections a process with the
// realtime listener's, twice that for a rollout's seconds (D221).
const capturePool = createPool(config.databaseUrl, {
  log: poolLog,
  max: CAPTURE_POOL_CONNECTIONS,
  name: 'capture',
});
const apiPool = createPool(config.databaseUrl, {
  log: poolLog,
  max: API_POOL_CONNECTIONS,
  name: 'api',
});

// One registry of open realtime connections and waits for both listeners, fed
// by one listening connection with what every process on the database
// announces, this one's own changes included (D074, D187, D221).
const hub = new RealtimeHub();
const drain = new Drain();
const writes = new PendingWrites();

const receiver = buildReceiver(capturePool, {
  hub,
  drain,
  writes,
  trustedProxyCidrs: config.trustedProxyCidrs,
  proxyProtocol: config.receiveProxyProtocol,
  // At most this many connections open at once from one sender address,
  // counted in the PROXY layer; 0 turns the bound off (D227).
  connectionsPerAddress: config.receiveConnectionsPerAddress,
  // HTTP/2 for a connection that opens with its preface, off unless
  // RECEIVE_HTTP2=on (D263).
  http2: config.receiveHttp2,
  // Where a default answer links its request in the inspector (D223).
  appOrigin: config.appOrigin,
});
const app = buildServer(apiPool, {
  capturePool,
  hub,
  drain,
  trustedProxyCidrs: config.trustedProxyCidrs,
  receiveOrigin: config.receiveOrigin,
  appOrigin: config.appOrigin,
  // The site's second origin, the other Origin /mcp lets in (D275).
  appAliasOrigin: config.appAliasOrigin,
  rateLimits: config.rateLimits,
  realtimeReady: () => listener.listenedOnce,
});
const listener = new RealtimeListener({
  connectionString: config.databaseUrl,
  hub,
  log: app.log,
  pool: apiPool,
  otherPools: [capturePool],
});

listener.start();

// The receive listener first: `/readyz` is on the application listener, so
// the pod is never ready before the receive port is open.
await receiver.listen({ host: config.host, port: config.receivePort });
await app.listen({ host: config.host, port: config.port });

const parts: ProcessParts = {
  app,
  receiver,
  pools: [capturePool, apiPool],
  listener,
  drain,
  writes,
};
let stopping: Promise<void> | null = null;

/**
 * Kubernetes sends SIGTERM on every rollout, after the `preStop` hook's
 * SIGUSR2 and pause (D221): an abrupt exit would drop requests already being
 * served. `shutdown` lets them finish, a delayed webhook reply included, and
 * answers every list call held by `wait` at once (D200).
 */
function stop(signal: string): void {
  stopping ??= shutdown(parts, signal).then(
    () => process.exit(0),
    (error: unknown) => {
      app.log.error({ err: error }, 'Shutdown failed');
      process.exit(1);
    },
  );
}

process.on('SIGUSR2', () => drainProcess(parts));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
