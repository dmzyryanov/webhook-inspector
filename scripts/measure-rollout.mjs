#!/usr/bin/env node
/**
 * The production probe of issue #132 (D221): what a deployment
 * does to the site, measured from outside the cluster for the whole of it.
 * Started before the deploy job and stopped once only the new pods run; run
 * from the operator's Mac, never from the VPS, which would reach the site
 * through its own hairpin:
 *
 *   APP_ORIGIN=https://qa-tools.ru RECEIVE_ORIGIN=https://hook.qa-tools.ru \
 *     DURATION_S=600 node scripts/measure-rollout.mjs > rollout.json
 *
 * It creates two sessions, one after the other, each kept for deletion as soon
 * as it exists, and, every `INTERVAL_MS` (250) each, for `DURATION_S` seconds:
 *
 * - sends a webhook to the first session on one connection kept alive, and to
 *   the second on a new connection each time;
 * - reads one of the two sessions, `GET /api/sessions/<id>`, in turn;
 * - asks for the home page, `GET /` of `HOME_ORIGIN` (`APP_ORIGIN` unless
 *   set), which must answer `200` with `text/html`.
 *
 * And for each session it keeps a viewer open - a WebSocket declaring every
 * optional event, as the frontend does, which reconnects after a close other
 * than `4404` / `4410` with the frontend's delays (D079) and reloads the list
 * on every `ready` (D077) - and a wait loop, `GET .../requests?order=asc&
 * limit=1000&wait=30&after=<the last id it got>`. About 720 API calls a
 * minute, under the 1200 an address may make (D201).
 *
 * Then it waits `SETTLE_S` seconds (10) for the viewers and waits to catch up,
 * and prints one JSON report: per stream, the answers by status, the failures
 * by message and the timings; per session, the request ids the webhooks were
 * answered with that the viewer never had (by an event or a reload) and that
 * the wait loop never had or had twice, the viewer's closes, reconnections
 * and reloads, the wait loop's calls, and the ids whose `request.received`
 * the viewer was sent twice on one connection (`duplicates`). `failures`
 * counts every failed call - the four streams', the wait loops' and the
 * viewers' reloads - and every duplicate frame; `missing` every id missing
 * from a viewer or a wait loop and every id a wait loop had twice; `ok` is
 * true only when both are 0.
 *
 * An id whose `request.received` reached the viewer on an earlier connection
 * too is listed apart (`repeatedAfterReconnection`) and fails nothing: a
 * connection registered while its process had not yet read a capture is sent
 * that capture's event by design, though an earlier connection may have had
 * it and its reload has it (D221 point 5); the frontend keeps one row per id.
 * One connection sent the same event twice would be an outbox read
 * delivering a row twice, which #132's "each event once" rules out.
 *
 * No session id is printed: it is the session's key (D153). The sessions are
 * deleted in a `finally`, whatever happened, a setup that failed half-way
 * included.
 *
 * Dependency-free, Node 24.
 */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';
// No imports of its own, so Node loads it as TypeScript here with nothing installed.
import { NEGOTIABLE_EVENT_TYPES, REALTIME_EVENTS_PARAM } from '../packages/shared/src/index.ts';

const APP_ORIGIN = process.env.APP_ORIGIN ?? 'http://127.0.0.1:3000';
const RECEIVE_ORIGIN = process.env.RECEIVE_ORIGIN ?? 'http://127.0.0.1:3001';
const HOME_ORIGIN = process.env.HOME_ORIGIN ?? APP_ORIGIN;
const DURATION_MS = Number(process.env.DURATION_S ?? 600) * 1000;
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 250);
const SETTLE_MS = Number(process.env.SETTLE_S ?? 10) * 1000;
/** Every call but a wait gives up after this long; a wait after its 30 s and this. */
const CALL_TIMEOUT_MS = 15_000;
const WAIT_SECONDS = 30;

/** The frontend's reconnection delays (`nextRetryDelay`, D079). */
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15_000;
const HEALTHY_CONNECTION_MS = 30_000;

/** The close codes that refuse a session rather than interrupt a connection (D076). */
const REFUSALS = new Set([4404, 4410]);

/**
 * One HTTP exchange: resolves with the status, the headers and the body, or
 * with `status: 0` and the error's message when there was no answer.
 */
function exchange(origin, path, { method = 'GET', body, agent, close = false, timeoutMs } = {}) {
  const url = new URL(path, origin);
  const client = url.protocol === 'https:' ? https : http;
  const started = performance.now();

  return new Promise((resolve) => {
    let settled = false;
    const done = (answer) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ...answer, ms: performance.now() - started });
      }
    };
    const request = client.request(
      url,
      {
        method,
        agent,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(close ? { connection: 'close' } : {}),
        },
      },
      (response) => {
        const chunks = [];

        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', (error) => done({ status: 0, error: error.message }));
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new Error(`no answer within ${timeoutMs ?? CALL_TIMEOUT_MS} ms`));
    }, timeoutMs ?? CALL_TIMEOUT_MS);

    request.on('error', (error) => done({ status: 0, error: error.message }));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Counts, failures and timings of one stream of calls. */
function stream() {
  return { count: 0, statuses: {}, failures: {}, ms: [] };
}

function record(into, answer, failure) {
  into.count += 1;
  into.statuses[answer.status] = (into.statuses[answer.status] ?? 0) + 1;
  into.ms.push(answer.ms);

  if (failure) {
    into.failures[failure] = (into.failures[failure] ?? 0) + 1;
  }
}

function percentile(sorted, fraction) {
  return sorted.length === 0
    ? null
    : Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]);
}

/**
 * What `of` holds now, copied: the wait loops go on until the deletions answer
 * them `404`, after the report is taken and before it is printed, and those
 * answers are no part of it.
 */
function summary(of) {
  const ms = [...of.ms].sort((a, b) => a - b);

  return {
    count: of.count,
    statuses: { ...of.statuses },
    failures: { ...of.failures },
    ms: { median: percentile(ms, 0.5), p95: percentile(ms, 0.95), max: percentile(ms, 1) },
  };
}

/** Runs `send` every `INTERVAL_MS` until `until`, without waiting for one call before the next. */
async function every(until, send) {
  const pending = [];
  let next = performance.now();

  while (performance.now() < until) {
    pending.push(send());
    next += INTERVAL_MS;

    const wait = next - performance.now();

    if (wait > 0) {
      await sleep(wait);
    }
  }

  await Promise.all(pending);
}

/** The ids of a list answer, or `null` when it is not one. */
function listIds(body) {
  try {
    const list = JSON.parse(body);

    return Array.isArray(list) ? list.map((item) => item.id) : null;
  } catch {
    return null;
  }
}

/**
 * A viewer of one session, as the frontend keeps one (D077, D079): every
 * request id it had, by an event or a reload, and its closes; and the ids
 * whose `request.received` it was sent twice on one connection
 * (`duplicates`), or again on a later connection (`repeatedAfterReconnection`).
 */
function viewer(sessionId, stopped) {
  const seen = new Set();
  /** The ids of every `request.received` frame, on any connection. */
  const framed = new Set();
  const duplicates = [];
  const repeatedAfterReconnection = [];
  const closes = [];
  const reloads = stream();
  let readies = 0;
  let retryDelay = 0;
  let socket = null;
  const wsOrigin = APP_ORIGIN.replace(/^http/, 'ws');
  const url = `${wsOrigin}/ws/${sessionId}?${REALTIME_EVENTS_PARAM}=${encodeURIComponent(
    NEGOTIABLE_EVENT_TYPES.join(','),
  )}`;

  const finished = new Promise((resolve) => {
    function connect() {
      if (stopped()) {
        resolve();

        return;
      }

      const opened = { at: null };
      /** The ids of this connection's `request.received` frames. */
      const framedHere = new Set();

      socket = new globalThis.WebSocket(url);
      socket.addEventListener('open', () => {
        opened.at = performance.now();
      });
      socket.addEventListener('message', (message) => {
        let event;

        try {
          event = JSON.parse(String(message.data));
        } catch {
          return;
        }

        if (event.type === 'ready') {
          readies += 1;
          // The reload, as the frontend makes it on every `ready`.
          void exchange(
            APP_ORIGIN,
            `/api/sessions/${sessionId}/requests?order=asc&limit=1000`,
          ).then((answer) => {
            const ids = answer.status === 200 ? listIds(answer.body) : null;

            record(
              reloads,
              answer,
              ids === null ? `status ${answer.status} ${answer.error ?? ''}`.trim() : null,
            );

            for (const id of ids ?? []) {
              seen.add(id);
            }
          });
        } else if (event.type === 'request.received') {
          const id = event.data.id;

          if (framedHere.has(id)) {
            duplicates.push(id);
          } else {
            if (framed.has(id)) {
              repeatedAfterReconnection.push(id);
            }

            framedHere.add(id);
            framed.add(id);
          }

          seen.add(id);
        }
      });
      socket.addEventListener('close', (event) => {
        closes.push(event.code);

        if (stopped() || REFUSALS.has(event.code)) {
          resolve();

          return;
        }

        const lived = opened.at === null ? 0 : performance.now() - opened.at;

        retryDelay =
          lived >= HEALTHY_CONNECTION_MS
            ? FIRST_RETRY_MS
            : Math.min(Math.max(retryDelay * 2, FIRST_RETRY_MS), MAX_RETRY_MS);
        setTimeout(connect, retryDelay);
      });
    }

    connect();
  });

  return {
    seen,
    duplicates,
    repeatedAfterReconnection,
    closes,
    reloads,
    readies: () => readies,
    close: () => {
      socket?.close();
    },
    finished,
  };
}

/** A wait loop on one session: every id it was answered with, and how often. */
function waitLoop(sessionId, stopped) {
  const counts = new Map();
  const calls = stream();
  let after = null;

  const finished = (async () => {
    while (!stopped()) {
      const query = `order=asc&limit=1000&wait=${WAIT_SECONDS}${after === null ? '' : `&after=${after}`}`;
      const answer = await exchange(APP_ORIGIN, `/api/sessions/${sessionId}/requests?${query}`, {
        timeoutMs: WAIT_SECONDS * 1000 + CALL_TIMEOUT_MS,
      });
      const ids = answer.status === 200 ? listIds(answer.body) : null;

      record(
        calls,
        answer,
        ids === null ? `status ${answer.status} ${answer.error ?? ''}`.trim() : null,
      );

      if (ids === null) {
        await sleep(INTERVAL_MS);

        continue;
      }

      for (const id of ids) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }

      if (ids.length > 0) {
        after = ids.at(-1);
      } else if (answer.ms < 1000) {
        // Answered early and empty: a backend shutting down, or not reading
        // its outbox for a moment (D200, D221). Asked again a little later.
        await sleep(INTERVAL_MS);
      }
    }
  })();

  return { counts, calls, finished };
}

async function createSession() {
  const answer = await exchange(APP_ORIGIN, '/api/sessions', { method: 'POST' });

  if (answer.status !== 201) {
    throw new Error(`creating a session answered ${answer.status} ${answer.error ?? answer.body}`);
  }

  return JSON.parse(answer.body).id;
}

async function main() {
  const sessions = [];
  let report;

  try {
    // One at a time, each kept for the `finally` as soon as it exists: a
    // second creation that fails leaves the first to be deleted.
    sessions.push(await createSession());
    sessions.push(await createSession());

    const startedAt = new Date().toISOString();
    const sendUntil = performance.now() + DURATION_MS;
    let stopping = false;
    const stopped = () => stopping;
    const viewers = sessions.map((id) => viewer(id, stopped));
    const waits = sessions.map((id) => waitLoop(id, stopped));
    const keptAgent = RECEIVE_ORIGIN.startsWith('https:')
      ? new https.Agent({ keepAlive: true, maxSockets: 1 })
      : new http.Agent({ keepAlive: true, maxSockets: 1 });
    const streams = {
      webhookKeptAlive: stream(),
      webhookNewConnection: stream(),
      api: stream(),
      home: stream(),
    };
    const sent = [[], []];
    let reads = 0;

    const webhook = (index, into, options) => async () => {
      const answer = await exchange(RECEIVE_ORIGIN, `/s/${sessions[index]}`, {
        method: 'POST',
        body: { probe: index, at: Date.now() },
        ...options,
      });
      const id = answer.headers?.['x-qa-tools-request-id'];

      record(
        into,
        answer,
        answer.status === 200 && id ? null : `status ${answer.status} ${answer.error ?? ''}`.trim(),
      );

      if (id) {
        sent[index].push(String(id));
      }
    };

    await Promise.all([
      every(sendUntil, webhook(0, streams.webhookKeptAlive, { agent: keptAgent })),
      every(sendUntil, webhook(1, streams.webhookNewConnection, { agent: false, close: true })),
      every(sendUntil, async () => {
        reads += 1;

        const answer = await exchange(APP_ORIGIN, `/api/sessions/${sessions[reads % 2]}`);

        record(
          streams.api,
          answer,
          answer.status === 200 ? null : `status ${answer.status} ${answer.error ?? ''}`.trim(),
        );
      }),
      every(sendUntil, async () => {
        const answer = await exchange(HOME_ORIGIN, '/');
        const html = String(answer.headers?.['content-type'] ?? '').startsWith('text/html');

        record(
          streams.home,
          answer,
          answer.status === 200 && html
            ? null
            : `status ${answer.status} ${answer.headers?.['content-type'] ?? answer.error ?? ''}`.trim(),
        );
      }),
    ]);

    keptAgent.destroy();

    // The viewers and the waits catch up with the last webhooks.
    const settleUntil = performance.now() + SETTLE_MS;

    while (
      performance.now() < settleUntil &&
      !sent.every(
        (ids, index) =>
          ids.every((id) => viewers[index].seen.has(id)) &&
          ids.every((id) => waits[index].counts.has(id)),
      )
    ) {
      await sleep(100);
    }

    stopping = true;

    for (const each of viewers) {
      each.close();
    }

    const perSession = (index) => {
      const ids = sent[index];
      const wait = waits[index];

      return {
        sent: ids.length,
        viewer: {
          missing: ids.filter((id) => !viewers[index].seen.has(id)),
          duplicates: [...viewers[index].duplicates],
          repeatedAfterReconnection: [...viewers[index].repeatedAfterReconnection],
          readies: viewers[index].readies(),
          reconnections: Math.max(0, viewers[index].readies() - 1),
          closes: [...viewers[index].closes],
          reloads: summary(viewers[index].reloads),
        },
        wait: {
          missing: ids.filter((id) => !wait.counts.has(id)),
          twice: [...wait.counts].filter(([, count]) => count > 1).map(([id]) => id),
          calls: summary(wait.calls),
        },
      };
    };

    const sessionsReport = { keptAlive: perSession(0), newConnection: perSession(1) };
    const streamReport = Object.fromEntries(
      Object.entries(streams).map(([name, of]) => [name, summary(of)]),
    );
    // Every failed call - the four streams', the wait loops' and the viewers'
    // reloads - and every frame a viewer was sent twice on one connection.
    const failedCalls = (of) => Object.values(of.failures).reduce((sum, n) => sum + n, 0);
    const failures =
      Object.values(streamReport).reduce((total, of) => total + failedCalls(of), 0) +
      Object.values(sessionsReport).reduce(
        (total, each) =>
          total +
          failedCalls(each.wait.calls) +
          failedCalls(each.viewer.reloads) +
          each.viewer.duplicates.length,
        0,
      );
    const missing = Object.values(sessionsReport).reduce(
      (total, each) =>
        total + each.viewer.missing.length + each.wait.missing.length + each.wait.twice.length,
      0,
    );

    report = {
      startedAt,
      endedAt: new Date().toISOString(),
      appOrigin: APP_ORIGIN,
      receiveOrigin: RECEIVE_ORIGIN,
      homeOrigin: HOME_ORIGIN,
      durationS: DURATION_MS / 1000,
      intervalMs: INTERVAL_MS,
      ok: failures === 0 && missing === 0,
      failures,
      missing,
      streams: streamReport,
      sessions: sessionsReport,
    };
  } finally {
    for (const id of sessions) {
      const answer = await exchange(APP_ORIGIN, `/api/sessions/${id}`, { method: 'DELETE' });

      if (answer.status !== 204) {
        console.error(`deleting a probe session answered ${answer.status} ${answer.error ?? ''}`);
      }
    }
  }

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

await main();
// The wait loops, answered `404` by the deletions, end on their own; nothing
// else is left to keep the process alive.
process.exit(process.exitCode ?? 0);
