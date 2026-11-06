#!/usr/bin/env node
/**
 * The worst-case measurement of issue #130 (D250): header-only
 * queries of requests, which take places of their own beside the search's
 * two, against a session whose stored headers make every header condition as
 * costly as a webhook can make it.
 *
 * For each shape of stored headers a fresh project of
 * `measure-header-queries.compose.yml` - the backend image built from this
 * checkout at 0.5 CPU and 512 MiB with no swap, PostgreSQL of the project's
 * image at 1 CPU and 1 GiB - and one session of 1000 requests of about 16 KiB
 * of headers each:
 *
 * - `a`: 16,000 header lines `a:`, one counted byte each, as many as Node's
 *   16 KiB allows, each stored as a pair `["a", ""]`;
 * - `b`: four headers `x-long-1` to `x-long-4` of 4000 bytes each.
 *
 * Then phases of `PHASE_S` seconds, each at one concurrency level of
 * header-only queries, from one address and from several (IPv4 and IPv6
 * `/64`s apart): every query worker repeats `POST .../requests/query` with 8
 * header conditions that never match - a name every stored line has, in
 * another letter case, and a value none has - at once after each answer and
 * one `Retry-After` after a `429`. Beside them, throughout, two workers keep
 * two searches of 8 never-matching words busy on the same session; 10
 * captures a second go to another session, made for the phase; and
 * `/readyz` is read once a second. The backend's cgroup and process are read
 * from outside after each phase.
 *
 * The bounds, set before the run from issue #130's and D201's numbers, each
 * held by every phase: every capture answered `200` and stored; capture
 * timings, from the call to the end of its answer, 95th percentile at most
 * 200 ms and every one under 500 ms; `/readyz` `200` within 1 s every time;
 * the backend's `memory.peak` and `VmHWM` under 512 MiB; the same backend
 * process throughout, running, not OOM-killed.
 *
 *   node scripts/measure-header-queries.mjs run [--shapes a,b] [--levels 4,8,16]
 *     [--modes one,several] [--searches 2] [--phase-s 40]
 *     [--image <a backend image already built>]
 *
 * `--levels 0` runs no query, and `--searches 0` no search: the baselines.
 *
 * It prints one JSON report and exits 0 when every bound held, 1 when one did
 * not, 2 when the measurement could not run. `inner` is what it runs in the
 * client container. Dependency-free, Node 24.
 */
import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import console from 'node:console';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import readline from 'node:readline';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(HERE, 'measure-header-queries.compose.yml');
const INNER_SCRIPT = '/repo/scripts/measure-header-queries.mjs';
const MIB = 1024 * 1024;

/** The bounds of issue #130, fixed before the run. */
export const BOUNDS = Object.freeze({
  captureP95Ms: 200,
  captureMaxMs: 500,
  readyMaxMs: 1000,
  backendMemoryMiB: 512,
});

/** The requests the measured session holds: a session keeps its newest 1000. */
const STORED_REQUESTS = 1000;
const CAPTURES_PER_SECOND = 10;
/** The searches kept busy beside the queries: the search's two places. */
const SEARCH_WORKERS = 2;
const CONDITIONS = 8;

/** The addresses the callers are, `X-Forwarded-For` naming each. */
const ONE_ADDRESS = '203.0.113.50';
const SEARCH_ADDRESSES = ['198.51.100.21', '198.51.100.22'];
const SETUP_ADDRESS = '198.51.100.200';

/** Worker `index`'s address when the queries come from several: IPv4 and IPv6 `/64`s alternately. */
function severalAddress(index) {
  return index % 2 === 0
    ? `203.0.113.${100 + index}`
    : `2001:db8:${(0x130 + index).toString(16)}::1`;
}

// ---------------------------------------------------------------------------
// Numbers.

function round(value) {
  return Math.round(value * 10) / 10;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return null;
  }

  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

/** The timings in ms: count, median, 95th and 99th percentiles, maximum. */
export function timings(values) {
  const sorted = [...values].sort((a, b) => a - b);

  return {
    count: sorted.length,
    p50: sorted.length === 0 ? null : round(percentile(sorted, 0.5)),
    p95: sorted.length === 0 ? null : round(percentile(sorted, 0.95)),
    p99: sorted.length === 0 ? null : round(percentile(sorted, 0.99)),
    max: sorted.length === 0 ? null : round(sorted.at(-1)),
  };
}

function countInto(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Inside the client container: the load itself.

const API_URL = process.env.API_URL ?? 'http://backend:3000';
const RECEIVE_URL = process.env.RECEIVE_URL ?? 'http://backend:3001';
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

/**
 * One call, read to its end: its status, headers, text and the ms from the
 * call to the end of its answer. A failure is status 0.
 */
function call(url, { method = 'GET', address, headers = {}, body, timeoutMs = 30_000 } = {}) {
  const started = performance.now();

  return new Promise((resolve) => {
    const request = http.request(
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
          resolve({ status: 0, headers: {}, text: String(error), ms: performance.now() - started }),
        );
      },
    );

    request.setTimeout(timeoutMs, () => request.destroy(new Error('timed out')));
    request.on('error', (error) =>
      resolve({ status: 0, headers: {}, text: String(error), ms: performance.now() - started }),
    );
    request.end(body);
  });
}

function errorCodeOf(answer) {
  try {
    return JSON.parse(answer.text).errorCode ?? null;
  } catch {
    return null;
  }
}

async function createSession() {
  const created = await call(`${API_URL}/api/sessions`, { method: 'POST', address: SETUP_ADDRESS });

  if (created.status !== 201) {
    throw new Error(`creating a session answered ${created.status}: ${created.text.slice(0, 200)}`);
  }

  return JSON.parse(created.text).id;
}

/**
 * A webhook whose head is written as given, over a connection of its own: how
 * a head of 16,000 lines is sent, which no client library writes.
 */
function rawWebhook(sessionId, headerLines, body) {
  const { hostname, port } = new URL(RECEIVE_URL);

  return new Promise((resolve) => {
    const socket = net.connect(Number(port), hostname);
    const chunks = [];
    let settled = false;
    const finish = (status) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(status);
      }
    };

    socket.setTimeout(60_000, () => finish(0));
    socket.on('connect', () => {
      socket.write(
        `POST /s/${sessionId} HTTP/1.1\r\nHost: backend\r\nContent-Type: text/plain\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n` +
          `${headerLines}\r\n${body}`,
      );
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);

      const text = Buffer.concat(chunks).toString('latin1');

      if (text.includes('\r\n\r\n')) {
        finish(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0));
      }
    });
    socket.on('error', () => finish(0));
    socket.on('close', () => finish(0));
  });
}

const LONG_VALUE = 'v'.repeat(4000);

/** One stored request of `shape`: its webhook, answering its status. */
function storeOne(sessionId, shape, index) {
  if (shape === 'a') {
    return rawWebhook(sessionId, 'a:\r\n'.repeat(16_000), `n=${index}`);
  }

  return call(`${RECEIVE_URL}/s/${sessionId}`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      'x-long-1': LONG_VALUE,
      'x-long-2': LONG_VALUE,
      'x-long-3': LONG_VALUE,
      'x-long-4': LONG_VALUE,
    },
    body: `n=${index}`,
  }).then((answer) => answer.status);
}

/** The session of the shape, filled with its 1000 requests, two webhooks at a time. */
async function setup(shape) {
  const sessionId = await createSession();
  const started = performance.now();
  const statuses = {};
  let next = 0;

  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (next < STORED_REQUESTS) {
        const index = next;

        next += 1;
        countInto(statuses, String(await storeOne(sessionId, shape, index)));
      }
    }),
  );

  const listed = await call(`${API_URL}/api/sessions/${sessionId}/requests`, {
    address: SETUP_ADDRESS,
  });
  const stored = listed.status === 200 ? JSON.parse(listed.text).length : null;
  const detail =
    listed.status === 200
      ? await call(
          `${API_URL}/api/sessions/${sessionId}/requests/${JSON.parse(listed.text)[0].id}`,
          { address: SETUP_ADDRESS },
        )
      : null;
  const headers = detail?.status === 200 ? JSON.parse(detail.text).headers : [];

  return {
    sessionId,
    shape,
    fillSeconds: round((performance.now() - started) / 1000),
    webhookStatuses: statuses,
    stored,
    oneRequest: {
      headerPairs: headers.length,
      headerBytes: headers.reduce((sum, [name, value]) => sum + name.length + value.length, 0),
    },
  };
}

/** The 8 never-matching header conditions for `shape`: names every request has, values none has. */
export function neverMatching(shape) {
  return Array.from({ length: CONDITIONS }, (_, index) => ({
    name: shape === 'a' ? 'A' : `X-LONG-${(index % 4) + 1}`,
    value: `never-${index}`,
  }));
}

const NEVER_WORDS = Array.from({ length: CONDITIONS }, (_, index) => `never-matching-${index}`);

/** One phase: `level` query workers, from one address or several, for `seconds`. */
async function load(sessionId, shape, level, mode, seconds, searchWorkers = SEARCH_WORKERS) {
  const captureSession = await createSession();
  const queryBody = JSON.stringify({ headers: neverMatching(shape) });
  const searchBody = JSON.stringify({ words: NEVER_WORDS });
  const deadline = performance.now() + seconds * 1000;
  const running = () => performance.now() < deadline;

  const queries = { outcomes: {}, ms200: [], ms503: [], retryAfter: {} };
  const searches = { outcomes: {}, ms: [] };
  const captures = { outcomes: {}, ms: [], ids: [] };
  const ready = { outcomes: {}, ms: [] };

  const queryWorker = async (index) => {
    const address = mode === 'one' ? ONE_ADDRESS : severalAddress(index);

    while (running()) {
      const answer = await call(`${API_URL}/api/sessions/${sessionId}/requests/query`, {
        method: 'POST',
        address,
        headers: { 'content-type': 'application/json' },
        body: queryBody,
      });
      const code = answer.status === 200 ? '' : `/${errorCodeOf(answer)}`;

      countInto(queries.outcomes, `${answer.status}${code}`);

      if (answer.status === 200) {
        queries.ms200.push(answer.ms);
      } else if (answer.status === 503) {
        queries.ms503.push(answer.ms);
      } else if (answer.status === 429) {
        const retryAfter = answer.headers['retry-after'];

        countInto(queries.retryAfter, `${code.slice(1)}:${retryAfter ?? 'none'}`);
        await delay(Math.max(1, Number(retryAfter) || 1) * 1000);
      } else {
        await delay(100);
      }
    }
  };

  const searchWorker = async (index) => {
    while (running()) {
      const answer = await call(`${API_URL}/api/sessions/${sessionId}/requests/search`, {
        method: 'POST',
        address: SEARCH_ADDRESSES[index],
        headers: { 'content-type': 'application/json' },
        body: searchBody,
      });

      countInto(
        searches.outcomes,
        `${answer.status}${answer.status === 200 ? '' : `/${errorCodeOf(answer)}`}`,
      );
      searches.ms.push(answer.ms);

      if (answer.status === 429) {
        await delay(1000);
      }
    }
  };

  const pending = [];
  let captureIndex = 0;
  const captureTimer = setInterval(() => {
    const index = captureIndex;

    captureIndex += 1;
    pending.push(
      call(`${RECEIVE_URL}/s/${captureSession}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'capture', index }),
      }).then((answer) => {
        countInto(captures.outcomes, String(answer.status));
        captures.ms.push(answer.ms);

        if (answer.status === 200) {
          captures.ids.push(answer.headers['x-qa-tools-request-id']);
        }
      }),
    );
  }, 1000 / CAPTURES_PER_SECOND);
  const readyTimer = setInterval(() => {
    pending.push(
      call(`${API_URL}/readyz`, { timeoutMs: 10_000 }).then((answer) => {
        countInto(ready.outcomes, String(answer.status));
        ready.ms.push(answer.ms);
      }),
    );
  }, 1000);

  await Promise.all([
    ...Array.from({ length: level }, (_, index) => queryWorker(index)),
    ...Array.from({ length: searchWorkers }, (_, index) => searchWorker(index)),
    // The phase lasts its seconds with no worker at all, as a baseline.
    delay(seconds * 1000),
  ]);
  clearInterval(captureTimer);
  clearInterval(readyTimer);
  await Promise.all(pending);

  const listed = await call(`${API_URL}/api/sessions/${captureSession}/requests`, {
    address: SETUP_ADDRESS,
  });
  const storedIds = new Set(
    listed.status === 200 ? JSON.parse(listed.text).map((entry) => entry.id) : [],
  );

  return {
    shape,
    level,
    mode,
    seconds,
    searchWorkers,
    queries: {
      outcomes: queries.outcomes,
      retryAfter: queries.retryAfter,
      answered200Ms: timings(queries.ms200),
      timedOut503Ms: timings(queries.ms503),
    },
    searches: { outcomes: searches.outcomes, ms: timings(searches.ms) },
    captures: {
      sent: captureIndex,
      outcomes: captures.outcomes,
      stored: captures.ids.filter((id) => storedIds.has(id)).length,
      ms: timings(captures.ms),
    },
    ready: { outcomes: ready.outcomes, ms: timings(ready.ms) },
  };
}

async function inner(args) {
  const [step, ...rest] = args;
  let report;

  if (step === 'setup') {
    report = await setup(rest[0]);
  } else if (step === 'load') {
    const [sessionId, shape, level, mode, seconds, searchWorkers] = rest;

    report = await load(
      sessionId,
      shape,
      Number(level),
      mode,
      Number(seconds),
      Number(searchWorkers),
    );
  } else {
    throw new Error(`unknown inner step ${step}`);
  }

  console.log(JSON.stringify({ report }));
  agent.destroy();
}

// ---------------------------------------------------------------------------
// On the host: the project, the backend's readings, the verdict.

const composeEnv = {};

function compose(args, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['compose', '-f', COMPOSE_FILE, ...args],
      { env: { ...process.env, ...composeEnv }, timeout: timeoutMs, maxBuffer: 64 * MIB },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`docker compose ${args.join(' ')}: ${error.message}\n${stderr}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

function docker(args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`docker ${args.join(' ')}: ${error.message}\n${stderr}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Runs `inner` in the client container and answers its report. */
function inClient(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'compose',
        '-f',
        COMPOSE_FILE,
        'exec',
        '-T',
        'client',
        'node',
        INNER_SCRIPT,
        'inner',
        ...args,
      ],
      { env: { ...process.env, ...composeEnv }, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const lines = readline.createInterface({ input: child.stdout });
    let report = null;

    lines.on('line', (line) => {
      try {
        report = JSON.parse(line).report ?? report;
      } catch {
        console.error(line);
      }
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 && report !== null
        ? resolve(report)
        : reject(new Error(`inner ${args.join(' ')} ended ${code}`)),
    );
  });
}

/** The backend container's state and its process's readings, from outside. */
async function backendReadings(id) {
  const [restartCount, startedAt, oomKilled, status] = (
    await docker([
      'inspect',
      '--format',
      '{{.RestartCount}} {{.State.StartedAt}} {{.State.OOMKilled}} {{.State.Status}}',
      id,
    ])
  )
    .trim()
    .split(' ');
  let memory = {};

  if (status === 'running') {
    const text = await compose([
      'exec',
      '-T',
      'backend',
      'sh',
      '-c',
      'cat /sys/fs/cgroup/memory.peak; grep -E "^(VmHWM|VmRSS)" /proc/1/status',
    ]);
    const kib = (name) => Number(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(text)?.[1] ?? NaN);

    memory = {
      memoryPeakMiB: round(Number(text.split('\n')[0]) / MIB),
      vmHwmMiB: round(kib('VmHWM') / 1024),
      vmRssMiB: round(kib('VmRSS') / 1024),
    };
  }

  return {
    restartCount: Number(restartCount),
    startedAt,
    oomKilled: oomKilled === 'true',
    status,
    ...memory,
  };
}

async function backendLogErrors() {
  const lines = (await compose(['logs', '--no-color', 'backend']).catch(() => '')).split('\n');
  const messages = {};

  for (const line of lines) {
    const level = Number(/"level":(\d+)/.exec(line)?.[1] ?? 0);

    if (level >= 50) {
      // The message alone: a log line can hold a URL, and a URL a session id.
      countInto(messages, /"msg":"([^"]{0,120})/.exec(line)?.[1] ?? '?');
    }
  }

  return messages;
}

/** What failed of the bounds in one phase, as sentences; none when it passed. */
export function phaseFailures(phase, before, after) {
  const failures = [];
  const { captures, ready } = phase;

  if ((captures.outcomes['200'] ?? 0) !== captures.sent || captures.stored !== captures.sent) {
    failures.push(
      `captures: ${captures.sent} sent, ${captures.outcomes['200'] ?? 0} answered 200, ${captures.stored} stored`,
    );
  }

  if (captures.ms.p95 === null || captures.ms.p95 > BOUNDS.captureP95Ms) {
    failures.push(`capture p95 ${captures.ms.p95} ms over ${BOUNDS.captureP95Ms}`);
  }

  if (captures.ms.max === null || captures.ms.max >= BOUNDS.captureMaxMs) {
    failures.push(`capture max ${captures.ms.max} ms not under ${BOUNDS.captureMaxMs}`);
  }

  if ((ready.outcomes['200'] ?? 0) !== ready.ms.count || ready.ms.count === 0) {
    failures.push(`/readyz: ${JSON.stringify(ready.outcomes)}`);
  }

  if (ready.ms.max === null || ready.ms.max >= BOUNDS.readyMaxMs) {
    failures.push(`/readyz max ${ready.ms.max} ms not under ${BOUNDS.readyMaxMs}`);
  }

  if (after.status !== 'running' || after.oomKilled || after.restartCount !== 0) {
    failures.push(
      `backend ${after.status}, OOM-killed ${after.oomKilled}, restarts ${after.restartCount}`,
    );
  }

  if (after.startedAt !== before.startedAt) {
    failures.push('backend restarted');
  }

  for (const reading of ['memoryPeakMiB', 'vmHwmMiB']) {
    if (!(after[reading] < BOUNDS.backendMemoryMiB)) {
      failures.push(`backend ${reading} ${after[reading]} not under ${BOUNDS.backendMemoryMiB}`);
    }
  }

  return failures;
}

function option(args, name, fallback) {
  const at = args.indexOf(`--${name}`);

  return at === -1 ? fallback : args[at + 1];
}

async function run(args) {
  const shapes = option(args, 'shapes', 'a,b').split(',');
  const levels = option(args, 'levels', '4,8,16').split(',').map(Number);
  const phaseSeconds = Number(option(args, 'phase-s', '40'));
  const searchWorkers = Number(option(args, 'searches', String(SEARCH_WORKERS)));
  const modes = option(args, 'modes', 'one,several').split(',');
  const image = option(args, 'image', undefined);
  const report = { bounds: BOUNDS, shapes: [], started: new Date().toISOString() };
  let failed = false;

  if (image !== undefined) {
    composeEnv.MEASURE_BACKEND_IMAGE = image;
  }

  // Nothing is pulled: the images must be here already.
  await docker([
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    'webhook-inspector-postgres',
    'node:24-slim',
  ]);

  if (image === undefined) {
    await compose(['build', 'migrate'], { timeoutMs: 900_000 });
  }

  report.image = (
    await docker(['image', 'inspect', '--format', '{{.Id}}', image ?? 'dev130-measure-backend'])
  ).trim();

  try {
    for (const shape of shapes) {
      await compose(['down', '--volumes', '--remove-orphans'], { timeoutMs: 180_000 });
      await compose(['up', '-d', '--wait', 'postgres', 'client'], { timeoutMs: 180_000 });
      await compose(['up', 'migrate'], { timeoutMs: 180_000 });
      await compose(['up', '-d', '--wait', 'backend'], { timeoutMs: 180_000 });

      const id = (await compose(['ps', '-q', 'backend'])).trim();
      const idle = await backendReadings(id);

      console.error(`shape ${shape}: filling the session`);

      const filled = await inClient(['setup', shape]);
      const entry = { shape, idle, filled, afterFill: await backendReadings(id), phases: [] };

      report.shapes.push(entry);

      for (const level of levels) {
        for (const mode of modes) {
          console.error(`shape ${shape}: ${level} query workers from ${mode} address(es)`);

          const before = await backendReadings(id);
          const phase = await inClient([
            'load',
            filled.sessionId,
            shape,
            String(level),
            mode,
            String(phaseSeconds),
            String(searchWorkers),
          ]);
          const after = await backendReadings(id);
          const failures = phaseFailures(phase, before, after);

          failed ||= failures.length > 0;
          entry.phases.push({ ...phase, backend: after, failures });
          console.error(
            JSON.stringify({
              shape,
              level,
              mode,
              captureMs: phase.captures.ms,
              readyMs: phase.ready.ms,
              queries: phase.queries.outcomes,
              searches: phase.searches.outcomes,
              memory: [after.memoryPeakMiB, after.vmHwmMiB],
              failures,
            }),
          );
        }
      }

      entry.logErrors = await backendLogErrors();
    }
  } finally {
    await compose(['down', '--volumes', '--remove-orphans'], { timeoutMs: 180_000 }).catch(
      (error) => console.error(String(error.message)),
    );
  }

  report.ended = new Date().toISOString();
  report.passed = !failed;
  console.log(JSON.stringify(report, null, 2));

  return failed ? 1 : 0;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const [mode, ...rest] = process.argv.slice(2);

  if (mode === 'inner') {
    inner(rest).catch((error) => {
      console.error(String(error.stack ?? error));
      process.exit(2);
    });
  } else if (mode === 'run') {
    run(rest).then(
      (code) => process.exit(code),
      (error) => {
        console.error(String(error.stack ?? error));
        process.exit(2);
      },
    );
  } else {
    console.error(
      'usage: node scripts/measure-header-queries.mjs run [--shapes a,b] [--levels 4,8,16] [--modes one,several] [--searches 2] [--phase-s 40] [--image <name>]',
    );
    process.exit(2);
  }
}
