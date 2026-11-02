#!/usr/bin/env node
/**
 * The burst measurement of issue #144 (D210): `COUNT` webhooks of exactly
 * 1 MiB sent at once to one session, from `ADDRESSES` in turn, while 10 small
 * captures a second go to another session from an address of their own. It
 * prints one JSON report: what each webhook was answered and how long it took,
 * the small captures' answers and timings, and how many of each were stored.
 *
 * It drives a backend; it does not start one. The measurement runs it in a
 * container next to a backend container limited as production's is, 0.5 CPU
 * and 512 MiB, and a PostgreSQL container of its own, and reads the backend's
 * peak memory from outside (D210). Every webhook opens its own connection to
 * the receive listener with a PROXY protocol v2 header naming its sender, as
 * Traefik's TCP route does in production (D187), so the backend must run with
 * `RECEIVE_PROXY_PROTOCOL=v2` and trust this process's address
 * (`TRUSTED_PROXY_CIDRS`).
 *
 *   API_URL=http://backend:3000 RECEIVE_HOST=backend RECEIVE_PORT=3001 \
 *     COUNT=500 BODY=cyrillic ADDRESSES=203.0.113.7 \
 *     node scripts/measure-capture-bursts.mjs
 *
 * Optional: COUNT (180), BODY (`binary`, bytes 0 to 255 in turn, `cyrillic`,
 * the letter я 524,288 times, `small`, `{}`, or `none`: no body and neither
 * `Content-Type` nor `Content-Length`, so a webhook has two header lines,
 * `Host` and `Connection`), ADDRESSES (one or more,
 * comma separated; 203.0.113.7), HEADER_LINES (0: header lines `x<n>: v`
 * added to each webhook), DELAY_MS (0: the burst session's response delay),
 * SMALL_PER_SECOND (10), TIMEOUT_S (120, per webhook), METHOD (`POST`: the
 * burst's method; a `GET` declares and sends its body all the same, which
 * Fastify never reads), PIPELINE (`get`: each burst connection first sends a
 * `GET` with no body, kept alive, and the webhook pipelined behind it on the
 * same connection; the report's `first` holds the `GET`s' answers),
 * ANSWER_BYTES (0: with a delay the burst session answers `{"held":true}`;
 * otherwise a body of that many bytes, `a` repeated - 65536 is the most a
 * session's answer can be), SESSIONS (`one`: every address sends to one
 * session; `per-address`: each address to a session of its own, since a
 * session keeps its newest 1000 requests).
 *
 * Dependency-free, Node 24.
 */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import http from 'node:http';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3000';
const RECEIVE_HOST = process.env.RECEIVE_HOST ?? '127.0.0.1';
const RECEIVE_PORT = Number(process.env.RECEIVE_PORT ?? 3001);
const COUNT = Number(process.env.COUNT ?? 180);
const BODY = process.env.BODY ?? 'binary';
const ADDRESSES = (process.env.ADDRESSES ?? '203.0.113.7').split(',').map((value) => value.trim());
const HEADER_LINES = Number(process.env.HEADER_LINES ?? 0);
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);
const SMALL_PER_SECOND = Number(process.env.SMALL_PER_SECOND ?? 10);
const TIMEOUT_MS = Number(process.env.TIMEOUT_S ?? 120) * 1000;
const METHOD = process.env.METHOD ?? 'POST';
const PIPELINE = process.env.PIPELINE ?? '';
const ANSWER_BYTES = Number(process.env.ANSWER_BYTES ?? 0);
const SESSIONS = process.env.SESSIONS ?? 'one';
const MIB = 1024 * 1024;

/** The small captures' sender, never one of `ADDRESSES`. */
const SMALL_ADDRESS = '198.51.100.77';

const PROXY_V2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);

/** A PROXY protocol v2 header for TCP over IPv4 naming `source`. */
function proxyHeader(source) {
  const addresses = Buffer.concat([
    Buffer.from(source.split('.').map(Number)),
    Buffer.from([10, 42, 0, 24]),
    Buffer.from([0xc3, 0x50, 0x20, 0xfb]),
  ]);
  const fixed = Buffer.from([0x21, 0x11, 0, addresses.length]);

  return Buffer.concat([PROXY_V2_SIGNATURE, fixed, addresses]);
}

function body() {
  if (BODY === 'none') {
    return { bytes: Buffer.alloc(0), contentType: null };
  }

  if (BODY === 'small') {
    return { bytes: Buffer.from('{}'), contentType: 'application/json' };
  }

  if (BODY === 'cyrillic') {
    const text = Buffer.from('я'.repeat(MIB / 2), 'utf8');

    if (text.length !== MIB) {
      throw new Error(`the Cyrillic body is ${text.length} bytes`);
    }

    return { bytes: text, contentType: 'text/plain; charset=utf-8' };
  }

  return {
    bytes: Buffer.from(Array.from({ length: MIB }, (_, index) => index % 256)),
    contentType: 'application/octet-stream',
  };
}

/**
 * One webhook on a connection of its own, behind a PROXY header naming
 * `source`, sent with `method` and, when `first` is set, pipelined behind it.
 * Answers the status of the last answer, the `errorCode` of an error, the
 * status of the first answer when `first` was sent, and the milliseconds from
 * the connection to the end of the answer; no answer is status 0.
 */
function webhook(source, sessionId, bytes, contentType, extraLines = '', method = 'POST', first) {
  const started = performance.now();

  return new Promise((resolve) => {
    const socket = net.connect(RECEIVE_PORT, RECEIVE_HOST);
    const chunks = [];
    let settled = false;

    const settle = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(deadline);

      const text = Buffer.concat(chunks).toString('latin1');
      const statuses = [...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((match) => Number(match[1]));
      const status =
        first === undefined ? (statuses[0] ?? 0) : statuses.length === 2 ? statuses[1] : 0;
      const errorCodes = [...text.matchAll(/"errorCode":(\d+)/g)].map((match) => Number(match[1]));
      const errorCode = status >= 400 ? errorCodes.at(-1) : undefined;

      resolve({
        status,
        ...(first === undefined ? {} : { firstStatus: statuses[0] ?? 0 }),
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(status === 0 && error !== undefined ? { error: String(error) } : {}),
        ms: performance.now() - started,
      });
    };
    const deadline = setTimeout(() => {
      socket.destroy();
      settle('timed out');
    }, TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(proxyHeader(source));

      if (first !== undefined) {
        socket.write(first, 'latin1');
      }

      const framing =
        contentType === null
          ? ''
          : `Content-Type: ${contentType}\r\nContent-Length: ${bytes.length}\r\n`;

      socket.write(
        `${method} /s/${sessionId} HTTP/1.1\r\nHost: hook.qa-tools.ru\r\nConnection: close\r\n${extraLines}${framing}\r\n`,
        'latin1',
      );

      if (bytes.length > 0) {
        socket.write(bytes);
      }
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => settle(error));
    socket.on('close', () => settle());
  });
}

function api(path, method = 'GET', payload) {
  return new Promise((resolve, reject) => {
    const headers = payload === undefined ? {} : { 'content-type': 'application/json' };
    const call = http.request(`${API_URL}${path}`, { method, headers }, (response) => {
      const chunks = [];

      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
      );
    });

    call.on('error', reject);
    call.end(payload);
  });
}

async function createSession(delayMs = 0, answerBytes = 0) {
  const answer = await api(
    '/api/sessions',
    'POST',
    delayMs > 0 || answerBytes > 0
      ? JSON.stringify({
          response: {
            status: 200,
            body: answerBytes > 0 ? 'a'.repeat(answerBytes) : '{"held":true}',
            delayMs,
          },
        })
      : undefined,
  );

  if (answer.status !== 201) {
    throw new Error(`creating a session answered ${answer.status}: ${answer.text}`);
  }

  return JSON.parse(answer.text).id;
}

/** The sizes of the bodies a session holds, newest first. */
async function storedSizes(sessionId) {
  const answer = await api(`/api/sessions/${sessionId}/requests?limit=1000`);

  if (answer.status !== 200) {
    throw new Error(`listing answered ${answer.status}: ${answer.text}`);
  }

  const parsed = JSON.parse(answer.text);
  const items = Array.isArray(parsed) ? parsed : (parsed.requests ?? parsed.items ?? []);

  return items.map((item) => item.bodySize);
}

function percentile(sorted, fraction) {
  return sorted.length === 0
    ? null
    : sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function summary(answers) {
  const counts = {};

  for (const { status, errorCode } of answers) {
    const key = errorCode === undefined ? String(status) : `${status}/${errorCode}`;

    counts[key] = (counts[key] ?? 0) + 1;
  }

  const ms = answers.map((answer) => answer.ms).sort((a, b) => a - b);
  const round = (value) => (value === null ? null : Math.round(value));

  return {
    count: answers.length,
    statuses: counts,
    ms: {
      min: round(ms[0] ?? null),
      median: round(percentile(ms, 0.5)),
      p95: round(percentile(ms, 0.95)),
      max: round(ms.at(-1) ?? null),
    },
    errors: [...new Set(answers.filter((answer) => answer.error).map((answer) => answer.error))],
  };
}

async function main() {
  const { bytes, contentType } = body();
  const extraLines = Array.from({ length: HEADER_LINES }, (_, index) => `x${index}: v\r\n`).join(
    '',
  );
  const burstSessions = [];

  for (let index = 0; index < (SESSIONS === 'per-address' ? ADDRESSES.length : 1); index += 1) {
    burstSessions.push(await createSession(DELAY_MS, ANSWER_BYTES));
  }

  const burstSession = burstSessions[0];
  const smallSession = await createSession();

  // The small captures run from a second before the burst until it has
  // been answered whole.
  let bursting = true;
  const small = [];
  const smallPayload = Buffer.from('{"event":"small"}');
  const smallLoop = (async () => {
    let next = performance.now();

    while (bursting) {
      small.push(webhook(SMALL_ADDRESS, smallSession, smallPayload, 'application/json'));
      next += 1000 / SMALL_PER_SECOND;

      const wait = next - performance.now();

      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const startedAt = performance.now();
  const burst = await Promise.all(
    Array.from({ length: COUNT }, (_, index) =>
      webhook(
        ADDRESSES[index % ADDRESSES.length],
        burstSessions[index % burstSessions.length],
        bytes,
        contentType,
        extraLines,
        METHOD,
        PIPELINE === 'get'
          ? `GET /s/${burstSession}?first=${index} HTTP/1.1\r\nHost: hook.qa-tools.ru\r\n\r\n`
          : undefined,
      ),
    ),
  );
  const burstMs = performance.now() - startedAt;

  bursting = false;
  await smallLoop;

  const smallAnswers = await Promise.all(small);
  const storedBurst = (await Promise.all(burstSessions.map(storedSizes))).flat();
  const storedSmall = await storedSizes(smallSession);

  console.log(
    JSON.stringify(
      {
        count: COUNT,
        body: BODY,
        headerLines: HEADER_LINES,
        delayMs: DELAY_MS,
        method: METHOD,
        pipeline: PIPELINE || null,
        answerBytes: ANSWER_BYTES,
        sessionsPerAddress: SESSIONS === 'per-address',
        addresses: ADDRESSES,
        burstMs: Math.round(burstMs),
        burst: summary(burst),
        ...(PIPELINE === 'get'
          ? {
              first: summary(
                burst.map((answer) => ({ status: answer.firstStatus, ms: answer.ms })),
              ),
            }
          : {}),
        stored: {
          burst: storedBurst.length,
          burstOfItsSize: storedBurst.filter((size) => size === bytes.length).length,
          small: storedSmall.length,
        },
        small: summary(smallAnswers),
        sessions: { burst: burstSession, bursts: burstSessions, small: smallSession },
      },
      null,
      2,
    ),
  );
}

await main();
