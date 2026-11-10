/**
 * What the connection measurement reads inside the backend's process (#213,
 * D244), loaded before the backend with `--import` by
 * `scripts/measure-connections.mjs` when a series asks for it: each pool's
 * waiting callers and connections, and the event loop's delay, written as one
 * JSON line every 250 ms to `/tmp/qa-probe.jsonl` in the backend's container,
 * which the orchestrator reads once the series is done.
 *
 * It changes nothing the backend does: it registers every `pg.Pool` the
 * backend makes - by its `application_name` less the `webhook-inspector-`
 * before it, `capture` and `api` (D244, D278), `shared` for a pool that sets
 * none (`poolName`) - notes the most callers waiting for a connection after
 * each `connect`, and samples the event loop's delay at 10 ms. So it measures
 * a base image as it measures this branch's. Only the backend's own process
 * is probed: a `node` the container's health check or `docker exec` starts
 * loads it and does nothing; a module that imports it, as its test does, gets
 * `poolName` and nothing else.
 *
 * Beside them, for each of the two listeners - `receive`, on `RECEIVE_PORT`,
 * and `app` - where a request's time inside the process goes: from its
 * connection's accept to its `request` event, its head parsed (`toRequest`,
 * the first request of a connection alone), and from that event to its
 * response's close (`toClose`). What a client sees beyond the two was spent
 * before the accept, in the kernel's queue of the listening socket.
 *
 * Dependency-free, Node 24.
 */
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import process from 'node:process';
import { setInterval } from 'node:timers';
import { pathToFileURL } from 'node:url';

const OUT = '/tmp/qa-probe.jsonl';
const EVERY_MS = 250;
const RECEIVE_PORT = Number(process.env.RECEIVE_PORT ?? 3001);
const main = process.argv[1];

/**
 * The name a pool's readings go under: its `application_name` without the
 * `webhook-inspector-` the backend puts before a named pool's, once, at its
 * start alone; `shared` for a pool that sets none.
 */
export function poolName(options) {
  return String(options?.application_name ?? 'shared').replace(/^webhook-inspector-/, '');
}

/** One listener's timings in the window since the line before. */
function timings() {
  return { connections: 0, requests: 0, closed: 0, toRequest: [], toClose: [] };
}

/** The largest and the 99th percentile of `values`, in ms, `null` for none. */
function spread(values) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const at = (share) =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]);

  return { p99: at(0.99), max: Math.round(sorted.at(-1)) };
}

if (main !== undefined && main.endsWith('src/index.ts')) {
  const ACCEPTED = Symbol('probe accepted');
  const SEEN = Symbol('probe seen');
  let listeners = { receive: timings(), app: timings() };
  const emit = http.Server.prototype.emit;

  http.Server.prototype.emit = function probedEmit(event, ...args) {
    if (event === 'connection') {
      args[0][ACCEPTED] ??= performance.now();
      listeners[this.address()?.port === RECEIVE_PORT ? 'receive' : 'app'].connections += 1;
    } else if (event === 'request') {
      const [request, response] = args;
      const socket = request.socket;
      const now = performance.now();
      const name = this.address()?.port === RECEIVE_PORT ? 'receive' : 'app';
      const window = listeners[name];

      window.requests += 1;

      if (socket !== null && socket !== undefined && socket[SEEN] !== true) {
        socket[SEEN] = true;

        if (socket[ACCEPTED] !== undefined) {
          window.toRequest.push(now - socket[ACCEPTED]);
        }
      }

      response.once('close', () => {
        const current = listeners[name];

        current.closed += 1;
        current.toClose.push(performance.now() - now);
      });
    }

    return emit.call(this, event, ...args);
  };

  const pg = createRequire(pathToFileURL(main))('pg');
  const Pool = pg.Pool;
  const pools = [];

  pg.Pool = class ProbedPool extends Pool {
    constructor(options) {
      super(options);

      const name = poolName(options);

      this.probe = { name, maxWaiting: 0, maxTotal: 0, acquire: [], hold: [] };
      pools.push(this);
    }

    connect(...args) {
      const asked = performance.now();
      const answer = super.connect(...args);

      // A checkout without a callback, as a capture's: how long it waited
      // for its connection, and how long it held it until its release.
      if (args.length === 0) {
        void answer.then(
          (client) => {
            const acquired = performance.now();
            const release = client.release;

            this.probe.acquire.push(acquired - asked);
            client.release = (...releaseArgs) => {
              this.probe.hold.push(performance.now() - acquired);
              client.release = release;

              return release.apply(client, releaseArgs);
            };
          },
          () => undefined,
        );
      }

      // pg-pool queues a caller for one tick even when a connection is idle,
      // and serves it from the idle ones then: only the callers beyond those
      // wait for one.
      this.probe.maxWaiting = Math.max(this.probe.maxWaiting, this.waitingCount - this.idleCount);
      this.probe.maxTotal = Math.max(this.probe.maxTotal, this.totalCount);

      return answer;
    }
  };

  const delay = monitorEventLoopDelay({ resolution: 10 });
  const ms = (nanoseconds) => Math.round(nanoseconds / 1e4) / 100;

  delay.enable();
  setInterval(() => {
    const line = {
      t: Date.now(),
      // The window since the line before: its delays, and each pool's most
      // callers waiting and connections open, as they are now.
      eventLoopDelayMs: {
        p50: ms(delay.percentile(50)),
        p99: ms(delay.percentile(99)),
        max: ms(delay.max),
      },
      pools: Object.fromEntries(
        pools.map((pool) => [
          pool.probe.name,
          {
            maxWaiting: Math.max(pool.probe.maxWaiting, pool.waitingCount),
            maxTotal: Math.max(pool.probe.maxTotal, pool.totalCount),
            waiting: pool.waitingCount,
            total: pool.totalCount,
            acquireMs: spread(pool.probe.acquire),
            holdMs: spread(pool.probe.hold),
          },
        ]),
      ),
      listeners: Object.fromEntries(
        Object.entries(listeners).map(([name, window]) => [
          name,
          {
            connections: window.connections,
            requests: window.requests,
            closed: window.closed,
            toRequestMs: spread(window.toRequest),
            toCloseMs: spread(window.toClose),
          },
        ]),
      ),
    };

    listeners = { receive: timings(), app: timings() };
    delay.reset();

    for (const pool of pools) {
      pool.probe.maxWaiting = pool.waitingCount;
      pool.probe.maxTotal = pool.totalCount;
      pool.probe.acquire = [];
      pool.probe.hold = [];
    }

    try {
      appendFileSync(OUT, `${JSON.stringify(line)}\n`);
    } catch {
      // A full or read-only /tmp loses the probe's lines, never the backend.
    }
  }, EVERY_MS).unref();
}
