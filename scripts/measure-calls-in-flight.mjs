#!/usr/bin/env node
/**
 * The burst measurement of issue #139 (D213): calls held open from one address
 * against the application listener, while 10 small captures a second go to a
 * session of their own from another address. It prints one JSON report: what
 * each call was answered and how long it took, the small captures' answers and
 * timings, and how many of them were stored.
 *
 * It drives a backend; it does not start one. The measurement runs it in a
 * container next to a backend container limited as production's is, 0.5 CPU
 * and 512 MiB, and a PostgreSQL container of its own, and reads the backend's
 * peak memory from outside (D213). Every call carries an `X-Forwarded-For`,
 * so the backend must trust this process's address (`TRUSTED_PROXY_CIDRS`)
 * for the calls to count as the addresses named below.
 *
 *   API_URL=http://backend:3000 RECEIVE_URL=http://backend:3001 SERIES=waits \
 *     node scripts/measure-calls-in-flight.mjs
 *
 * SERIES:
 * - `waits` (the default): `COUNT` (1200) `GET .../requests?wait=30` on one
 *   empty session, started at once from one address, each on a connection of
 *   its own: as a client writes one, or with `SHAPE=heavy` as heavy as a
 *   call may be - 100 header lines and a request target of 13,000 bytes;
 *   once the refused ones have been answered, one call from another address,
 *   then a webhook to the session, which answers every wait still held.
 *   `SPREAD_S` (0) spreads the calls evenly over that many seconds.
 * - `ci`: `COUNT` (50) waits from one address, each on a session of its own,
 *   as parallel tests in CI wait; once they are pending, one webhook to each
 *   session, which must answer its own wait and no other.
 * - `connections`: `COUNT` (1200) `GET /no-such-page` at once from one
 *   address, each on a connection of its own: the cost of the connections
 *   alone, a `404` that takes no place, for comparison with `waits`.
 * - `saves`: `COUNT` (120) `PUT .../queue` of a full queue of ordinary text,
 *   738,621 bytes, at once from one address, each to its own session, as
 *   D205's measurement saved them; a webhook to another session 300 ms in.
 *   It first creates `COUNT` sessions, more than the 60 a minute one address
 *   may create, so its backend runs with `RATE_LIMIT_SESSION_CREATES_PER_MINUTE`
 *   raised; the saves themselves count toward the 1200.
 *
 * Every series first prints `{"phase":"warm"}` on a line of its own once its
 * sessions exist and the small captures have run for `WARMUP_S` (5) seconds,
 * and then waits `BASELINE_S` (3) seconds, so that whoever runs it can read
 * the backend's memory before the burst. Optional: SMALL_PER_SECOND (10),
 * TIMEOUT_S (60, per call).
 *
 * Dependency-free, Node 24.
 */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';

const API_URL = new URL(process.env.API_URL ?? 'http://127.0.0.1:3000');
const RECEIVE_URL = process.env.RECEIVE_URL ?? 'http://127.0.0.1:3001';
const SERIES = process.env.SERIES ?? 'waits';
const DEFAULT_COUNT = { waits: 1200, ci: 50, saves: 120, connections: 1200 };
const COUNT = Number(process.env.COUNT ?? DEFAULT_COUNT[SERIES] ?? 0);
const SMALL_PER_SECOND = Number(process.env.SMALL_PER_SECOND ?? 10);
const WARMUP_MS = Number(process.env.WARMUP_S ?? 5) * 1000;
const BASELINE_MS = Number(process.env.BASELINE_S ?? 3) * 1000;
const TIMEOUT_MS = Number(process.env.TIMEOUT_S ?? 60) * 1000;
const SHAPE = process.env.SHAPE ?? 'plain';
const SPREAD_MS = Number(process.env.SPREAD_S ?? 0) * 1000;

/** The address the burst comes from, another one, the small captures' and the setup's. */
const BURST_ADDRESS = '203.0.113.10';
const OTHER_ADDRESS = '203.0.113.11';
const SETUP_ADDRESS = '198.51.100.200';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One call on a connection of its own, read to its end. Answers the status,
 * the headers, the text and the milliseconds from the call to the end of the
 * answer; a failure or a timeout is status 0.
 */
function request(url, { method = 'GET', address, headers = {}, body } = {}) {
  const started = performance.now();

  return new Promise((resolve) => {
    const call = http.request(
      url,
      {
        method,
        agent: false,
        timeout: TIMEOUT_MS,
        headers: {
          ...(address === undefined ? {} : { 'x-forwarded-for': address }),
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];

        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            ms: performance.now() - started,
          }),
        );
        response.on('error', (error) =>
          resolve({ status: 0, error: String(error), ms: performance.now() - started }),
        );
      },
    );

    call.on('timeout', () => call.destroy(new Error('timed out')));
    call.on('error', (error) =>
      resolve({ status: 0, error: String(error), ms: performance.now() - started }),
    );
    call.end(body);
  });
}

async function createSession() {
  const answer = await request(new URL('/api/sessions', API_URL), {
    method: 'POST',
    address: SETUP_ADDRESS,
  });

  if (answer.status !== 201) {
    throw new Error(`creating a session answered ${answer.status}: ${answer.text}`);
  }

  return JSON.parse(answer.text).id;
}

function capture(sessionId, body) {
  return request(`${RECEIVE_URL}/s/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body,
  });
}

/** The requests a session holds, as the list answers them. */
async function stored(sessionId) {
  const answer = await request(new URL(`/api/sessions/${sessionId}/requests?limit=1000`, API_URL), {
    address: SETUP_ADDRESS,
  });

  return answer.status === 200 ? JSON.parse(answer.text) : [];
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return null;
  }

  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function round(value) {
  return value === null ? null : Math.round(value);
}

/** Answers counted by status, and by `errorCode` where an error body gives one. */
function countBy(answers) {
  const counts = {};

  for (const answer of answers) {
    let key = String(answer.status);

    if (answer.status >= 400) {
      try {
        key += `/${JSON.parse(answer.text).errorCode}`;
      } catch {
        // No error body: the status alone.
      }
    }

    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

function timings(answers) {
  const sorted = answers.map((answer) => answer.ms).sort((a, b) => a - b);

  return {
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1) ?? null),
  };
}

/**
 * Small captures to their own session, `SMALL_PER_SECOND` a second, until
 * `stop()`; answers what they were answered.
 */
function smallCaptures(sessionId) {
  const fired = [];
  let running = true;

  const loop = (async () => {
    let next = performance.now();
    let index = 0;

    while (running) {
      index += 1;
      fired.push(capture(sessionId, `{"small":${index}}`));
      next += 1000 / SMALL_PER_SECOND;

      const wait = next - performance.now();

      if (wait > 0) {
        await sleep(wait);
      }
    }
  })();

  return {
    async stop() {
      running = false;
      await loop;

      return Promise.all(fired);
    },
  };
}

/**
 * A wait on `sessionId`: with `SHAPE=heavy` the heaviest a call may be, 100
 * header lines and a request target of 13,000 bytes.
 */
function waitCall(sessionId) {
  const base = `/api/sessions/${sessionId}/requests?wait=30`;

  if (SHAPE !== 'heavy') {
    return request(new URL(base, API_URL), { address: BURST_ADDRESS });
  }

  const path = base + '&'.repeat(13_000 - base.length);
  // Node writes Host and Connection, and the call X-Forwarded-For: 97 more.
  const headers = {};

  for (let line = 1; line <= 97; line += 1) {
    headers[`x-${line}`] = 'y';
  }

  return request(new URL(path, API_URL), { address: BURST_ADDRESS, headers });
}

async function waitsSeries() {
  const session = await createSession();
  const other = await createSession();

  return {
    async burst() {
      const started = performance.now();
      const calls = [];

      // All at once, or spread evenly over `SPREAD_S` seconds.
      for (let index = 0; index < COUNT; index += 1) {
        calls.push(waitCall(session));

        if (SPREAD_MS > 0) {
          const due = started + ((index + 1) * SPREAD_MS) / COUNT - performance.now();

          if (due > 0) {
            await sleep(due);
          }
        }
      }

      const settled = calls.map((call) =>
        call.then((answer) => ({ ...answer, at: performance.now() })),
      );
      const refusedBy = new Promise((resolve) => {
        let refused = 0;

        for (const call of settled) {
          void call.then(() => {
            refused += 1;

            if (refused === COUNT - 128) {
              resolve(performance.now() - started);
            }
          });
        }
      });
      const refusalsAnsweredMs = await Promise.race([
        refusedBy,
        sleep(TIMEOUT_MS).then(() => null),
      ]);
      const otherAddress = await request(new URL(`/api/sessions/${other}`, API_URL), {
        address: OTHER_ADDRESS,
      });

      await sleep(1000);

      const webhook = await capture(session, '{"end":"of the waits"}');
      const answers = await Promise.all(settled);
      const held = answers.filter((answer) => answer.status === 200);
      const requestId = webhook.headers['x-qa-tools-request-id'];

      return {
        calls: COUNT,
        answered: countBy(answers),
        refusalsAnsweredMs: round(refusalsAnsweredMs),
        refusedTimings: timings(answers.filter((answer) => answer.status !== 200)),
        refusedRetryAfter: [
          ...new Set(answers.filter((a) => a.status === 429).map((a) => a.headers['retry-after'])),
        ],
        shape: SHAPE,
        otherAddressWhileHeld: countBy([otherAddress]),
        webhook: webhook.status,
        heldAnsweredWithTheWebhook: held.filter((answer) => {
          const list = JSON.parse(answer.text);

          return list.length === 1 && list[0].id === requestId;
        }).length,
      };
    },
  };
}

async function ciSeries() {
  const sessions = [];

  for (let index = 0; index < COUNT; index += 1) {
    sessions.push(await createSession());
  }

  return {
    async burst() {
      const waits = sessions.map((sessionId) =>
        request(new URL(`/api/sessions/${sessionId}/requests?wait=30`, API_URL), {
          address: BURST_ADDRESS,
        }),
      );

      await sleep(2000);

      const webhooks = await Promise.all(
        sessions.map((sessionId, index) => capture(sessionId, `{"test":${index}}`)),
      );
      const answers = await Promise.all(waits);
      const ownCapture = answers.filter((answer, index) => {
        if (answer.status !== 200) {
          return false;
        }

        const list = JSON.parse(answer.text);

        return (
          list.length === 1 && list[0].id === webhooks[index]?.headers['x-qa-tools-request-id']
        );
      }).length;

      return {
        waits: COUNT,
        webhooks: countBy(webhooks),
        answered: countBy(answers),
        answeredByItsOwnCapture: ownCapture,
        answerTimings: timings(answers),
      };
    },
  };
}

/** `SENTENCE` to exactly `bytes` bytes of UTF-8: ordinary text, as D205's full queue. */
function ordinaryText(bytes) {
  const sentence = 'Ответ сервиса: order 42 accepted, retry later; ok. ';
  let text = '';

  while (Buffer.byteLength(text + sentence) <= bytes) {
    text += sentence;
  }

  return text + 'a'.repeat(bytes - Buffer.byteLength(text));
}

/** Ten steps at every limit of D101 in ordinary text: 738,621 bytes of JSON. */
function fullQueue() {
  const value = 'trace-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ;';
  const names = Array.from({ length: 20 }, (_, index) => `x-h-${String(index).padStart(2, '0')}`);
  const valueBytes = 8192 - names.reduce((sum, name) => sum + name.length + 4, 0);
  const base = Math.floor(valueBytes / names.length);
  const longer = valueBytes - base * names.length;
  const headers = names.map((name, index) => [
    name,
    value.repeat(10).slice(0, base + (index < longer ? 1 : 0)),
  ]);
  const step = { status: 500, headers, body: ordinaryText(65_536), delayMs: 30_000 };

  return JSON.stringify({ steps: Array.from({ length: 10 }, () => step) });
}

async function savesSeries() {
  const sessions = [];

  for (let index = 0; index < COUNT; index += 1) {
    sessions.push(await createSession());
  }

  const probe = await createSession();
  const body = fullQueue();

  return {
    async burst() {
      const saves = sessions.map((sessionId) =>
        request(new URL(`/api/sessions/${sessionId}/queue`, API_URL), {
          method: 'PUT',
          address: BURST_ADDRESS,
          headers: { 'content-type': 'application/json' },
          body,
        }),
      );

      await sleep(300);

      const webhook = await capture(probe, '{"during":"the saves"}');
      const answers = await Promise.all(saves);

      return {
        saves: COUNT,
        bodyBytes: Buffer.byteLength(body),
        answered: countBy(answers),
        timings: timings(answers),
        webhookDuringBurst: { status: webhook.status, ms: round(webhook.ms) },
      };
    },
  };
}

async function connectionsSeries() {
  return {
    async burst() {
      const answers = await Promise.all(
        Array.from({ length: COUNT }, () =>
          request(new URL('/no-such-page', API_URL), { address: BURST_ADDRESS }),
        ),
      );

      return { calls: COUNT, answered: countBy(answers), timings: timings(answers) };
    },
  };
}

async function main() {
  const smallSession = await createSession();
  const series = await {
    waits: waitsSeries,
    ci: ciSeries,
    saves: savesSeries,
    connections: connectionsSeries,
  }[SERIES]();
  const small = smallCaptures(smallSession);

  await sleep(WARMUP_MS);
  console.log(JSON.stringify({ phase: 'warm' }));
  await sleep(BASELINE_MS);

  const startedAt = performance.now();
  const burst = await series.burst();
  const burstMs = performance.now() - startedAt;

  await sleep(1000);

  const smallAnswers = await small.stop();
  const smallStored = await stored(smallSession);

  console.log(
    JSON.stringify({
      series: SERIES,
      burst,
      burstMs: round(burstMs),
      small: {
        sent: smallAnswers.length,
        answered: countBy(smallAnswers),
        stored: smallStored.length,
        timings: timings(smallAnswers),
      },
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
