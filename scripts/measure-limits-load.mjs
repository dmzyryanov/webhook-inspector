#!/usr/bin/env node
/**
 * The load measurement of issue #100 (D201): one address using everything the
 * per-address limits allow, four readers each repeating a list answer of 20
 * bodies of 1 MiB, and 10 captures a second going to other sessions, against
 * one backend for a fixed time. It prints one JSON report: what each stream
 * was answered, the capture timings, and whether every capture was stored.
 *
 * It drives a backend; it does not start one. The measurement runs it in a
 * container next to a backend container limited as production's is, 0.5 CPU
 * and 512 MiB, and a PostgreSQL container of its own, and reads the backend's
 * peak memory from outside (D201, "Load measurement"). Every call carries an
 * `X-Forwarded-For`, so the backend must trust this process's address
 * (`TRUSTED_PROXY_CIDRS`) for the streams to count as the addresses named
 * below; otherwise they all count as one.
 *
 *   API_URL=http://backend:3000 RECEIVE_URL=http://backend:3001 \
 *     node scripts/measure-limits-load.mjs
 *
 * Optional: DURATION_S (120), BODY_BYTE (1, the byte every stored body is
 * made of: U+0001, which JSON escapes as six bytes, so an answer is 120 MiB).
 *
 * Dependency-free, Node 24.
 */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3000';
const RECEIVE_URL = process.env.RECEIVE_URL ?? 'http://127.0.0.1:3001';
const DURATION_MS = Number(process.env.DURATION_S ?? 120) * 1000;
const BODY_BYTE = Number(process.env.BODY_BYTE ?? 1);
const MIB = 1024 * 1024;

/** The address that uses both limits whole, and the readers', one each. */
const LIMITED_ADDRESS = '203.0.113.10';
const READER_ADDRESSES = ['203.0.113.21', '203.0.113.22', '203.0.113.23', '203.0.113.24'];
const SETUP_ADDRESS = '198.51.100.200';

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

/**
 * One call, read to its end. Answers the status, the headers, the bytes read
 * and the milliseconds from the call to the end of the answer; a failure is
 * status 0.
 */
function request(url, { method = 'GET', address, headers = {}, body, keepBody = false } = {}) {
  const started = performance.now();

  return new Promise((resolve) => {
    const call = http.request(
      url,
      {
        method,
        agent,
        headers: {
          ...(address === undefined ? {} : { 'x-forwarded-for': address }),
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
          ...headers,
        },
      },
      (response) => {
        let bytes = 0;
        const chunks = [];

        response.on('data', (chunk) => {
          bytes += chunk.length;

          if (keepBody) {
            chunks.push(chunk);
          }
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            bytes,
            ms: performance.now() - started,
            text: keepBody ? Buffer.concat(chunks).toString('utf8') : '',
          }),
        );
        response.on('error', (error) =>
          resolve({ status: 0, error: String(error), bytes, ms: performance.now() - started }),
        );
      },
    );

    call.on('error', (error) =>
      resolve({ status: 0, error: String(error), bytes: 0, ms: performance.now() - started }),
    );
    call.end(body);
  });
}

async function createSession(address) {
  const answer = await request(`${API_URL}/api/sessions`, {
    method: 'POST',
    address,
    keepBody: true,
  });

  if (answer.status !== 201) {
    throw new Error(`creating a session answered ${answer.status}: ${answer.text}`);
  }

  return JSON.parse(answer.text).id;
}

async function capture(sessionId, body, contentType = 'text/plain') {
  return request(`${RECEIVE_URL}/s/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return null;
  }

  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function round(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

function countBy(answers) {
  const counts = {};

  for (const { status } of answers) {
    counts[status] = (counts[status] ?? 0) + 1;
  }

  return counts;
}

/** Runs `fire` every `intervalMs` until the end, without waiting for one to finish first. */
async function everyInterval(intervalMs, endAt, fire) {
  const pending = [];
  let next = performance.now();

  while (next < endAt) {
    pending.push(fire());
    next += intervalMs;

    const wait = next - performance.now();

    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  return Promise.all(pending);
}

async function main() {
  // Setup, before the clock starts: the session the readers list, holding 20
  // bodies of 1 MiB; the sessions the captures go to, two, since a session
  // keeps its newest 1000 and two minutes at 10 a second are 1200; and the
  // session the light calls read.
  const bodies = await createSession(SETUP_ADDRESS);
  const payload = Buffer.alloc(MIB, BODY_BYTE);

  for (let index = 0; index < 20; index += 1) {
    const stored = await capture(bodies, payload, 'application/octet-stream');

    if (stored.status !== 200) {
      throw new Error(`storing body ${index} answered ${stored.status}`);
    }
  }

  const targets = [await createSession(SETUP_ADDRESS), await createSession(SETUP_ADDRESS)];
  const light = await createSession(SETUP_ADDRESS);

  const startedAt = performance.now();
  const endAt = startedAt + DURATION_MS;

  // One address: a session a second (60 a minute) and 20 light calls a
  // second (1200 a minute), alternating a session read and its plain list.
  const creations = everyInterval(1000, endAt, () =>
    request(`${API_URL}/api/sessions`, { method: 'POST', address: LIMITED_ADDRESS }),
  );
  let lightIndex = 0;
  const lightCalls = everyInterval(50, endAt, () => {
    lightIndex += 1;

    return request(
      lightIndex % 2 === 0
        ? `${API_URL}/api/sessions/${light}`
        : `${API_URL}/api/sessions/${light}/requests`,
      { address: LIMITED_ADDRESS },
    );
  });

  // Four readers, each repeating the list with its 20 bodies, read at full
  // speed, from an address of its own.
  const readers = READER_ADDRESSES.map(async (address) => {
    const answers = [];

    while (performance.now() < endAt) {
      answers.push(
        await request(`${API_URL}/api/sessions/${bodies}/requests?include=body`, { address }),
      );
    }

    return answers;
  });

  // Ten captures a second, alternating the two target sessions.
  let captureIndex = 0;
  const captures = everyInterval(100, endAt, async () => {
    const target = captureIndex % 2;

    captureIndex += 1;

    const answer = await capture(
      targets[target],
      `{"capture":${captureIndex}}`,
      'application/json',
    );

    return { ...answer, target, requestId: answer.headers?.['x-qa-tools-request-id'] };
  });

  const [created, lighted, read, captured] = await Promise.all([
    creations,
    lightCalls,
    Promise.all(readers),
    captures,
  ]);
  const elapsedMs = performance.now() - startedAt;

  // Every capture answered 200 must be in its session.
  const stored = [];

  for (const target of targets) {
    const answer = await request(`${API_URL}/api/sessions/${target}`, {
      address: SETUP_ADDRESS,
      keepBody: true,
    });

    stored.push(JSON.parse(answer.text).requestsCount);
  }

  const answeredPerTarget = [0, 0];

  for (const { status, target, requestId } of captured) {
    if (status === 200 && requestId !== undefined) {
      answeredPerTarget[target] += 1;
    }
  }

  const captureMs = captured.map(({ ms }) => ms).sort((a, b) => a - b);
  const readerAnswers = read.flat();
  const readerMs = readerAnswers
    .filter(({ status }) => status === 200)
    .map(({ ms }) => ms)
    .sort((a, b) => a - b);

  console.log(
    JSON.stringify(
      {
        durationS: round(elapsedMs / 1000),
        bodyByte: BODY_BYTE,
        creations: { sent: created.length, answers: countBy(created) },
        lightCalls: { sent: lighted.length, answers: countBy(lighted) },
        readers: {
          answers: countBy(readerAnswers),
          perReader: read.map((answers) => answers.length),
          mibPerAnswer: round(
            (readerAnswers.find(({ status }) => status === 200)?.bytes ?? 0) / MIB,
          ),
          msP50: round(percentile(readerMs, 0.5)),
          msMax: round(readerMs.at(-1) ?? null),
        },
        captures: {
          sent: captured.length,
          answers: countBy(captured),
          answeredPerSession: answeredPerTarget,
          storedPerSession: stored,
          everyAnsweredCaptureStored:
            stored[0] === answeredPerTarget[0] && stored[1] === answeredPerTarget[1],
          ms: {
            p50: round(percentile(captureMs, 0.5)),
            p95: round(percentile(captureMs, 0.95)),
            p99: round(percentile(captureMs, 0.99)),
            max: round(captureMs.at(-1) ?? null),
          },
          within500ms: round((captureMs.filter((ms) => ms <= 500).length / captureMs.length) * 100),
        },
      },
      null,
      2,
    ),
  );

  agent.destroy();
}

await main();
