// Site and disk heartbeats for Statuser.cloud (D181, issue #68).
//
// Run every 5 minutes by the CronJob in templates/monitor.yaml, on the backend
// image as uid 1000, with Node's built-in fetch and fs.statfs and nothing else.
// One run, in this order:
//
//   1. Disk. The usage of the filesystem holding MONITOR_DISK_PATH as `df`
//      shows it: used / (used + available), rounded up to a whole percent. At
//      or above MONITOR_DISK_THRESHOLD it sends `disk/fail`, below it `disk`,
//      both with the percentage.
//   2. Site. `GET /` must answer 200 text/html with an HTML document,
//      `GET /api/sessions/<random id>` 404 JSON with errorCode 1001, and on
//      the receive host, where webhooks are received since 0.36.0 (D187),
//      `GET /s/<another random id>` 404 JSON with errorCode 1001: the
//      read-only checks of scripts/check-deployment.mjs, which create no
//      session and store nothing. Each id is shaped as a session id, 43
//      characters of base64url, so the backend looks it up in the database
//      instead of refusing its format first; no session has it, and the
//      lookup writes nothing. Up to MONITOR_ATTEMPTS attempts,
//      MONITOR_RETRY_SECONDS apart; the first attempt that passes sends
//      `site`, and when every attempt fails it sends `site/fail` with the last
//      failure. The receive host is part of `site` rather than a heartbeat of
//      its own, so capture never leaves the monitored path.
//
// A heartbeat is a POST to <MONITOR_HEARTBEAT_URL>/<token> for a success and
// <MONITOR_HEARTBEAT_URL>/<token>/fail for a failure, with one short line of
// plain text as its body. The token is the credential, so neither it, nor a URL
// holding it, nor a random session id is ever printed or sent in a body: the
// log names a heartbeat by its monitor, `site` or `disk/fail`, and the lookups
// as `/api/sessions/<random>` and `/s/<random>`. Every line is also scrubbed of them, in any
// ASCII letter case, before it is written: a URL's host is printed lowercased.
// Of the site's answers only the status, a whole-number errorCode and a media
// type from a fixed few are repeated, and an unexpected error is printed by
// its name alone.
//
// Exit status 0 when both heartbeats were delivered, whatever they reported,
// and 1 when one was not or a setting is wrong. A heartbeat that was not
// delivered is silence to Statuser, which alerts too. A wrong site or receive
// URL, disk path or threshold still sends that monitor's `/fail`, saying the
// check is not configured; a missing token or heartbeat URL sends nothing for
// it.
//
// Environment:
//   MONITOR_SITE_URL         the site, https://qa-tools.ru
//   MONITOR_RECEIVE_URL      the receive host, https://hook.qa-tools.ru
//   MONITOR_HEARTBEAT_URL    Statuser's heartbeat endpoint, https://hb.statuser.cloud
//   MONITOR_SITE_TOKEN       the `site` monitor's token
//   MONITOR_DISK_TOKEN       the `disk` monitor's token
//   MONITOR_DISK_PATH        a directory on the filesystem watched
//   MONITOR_DISK_THRESHOLD   percent in use that fails, 1 to 100, default 80
//   MONITOR_ATTEMPTS         site attempts, default 3
//   MONITOR_RETRY_SECONDS    pause after a failed attempt, default 20
//   MONITOR_TIMEOUT_SECONDS  limit for each request, default 10

import { randomBytes } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';
import process from 'node:process';

// Plain http is accepted only on the loopback interface, where the tests run
// their stand-ins; anywhere else a token would travel in the clear.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
// What a token may look like, so that it is a path segment as it stands.
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
const GIB = 1024 ** 3;

/** The defaults the CronJob runs with: 80 %, 3 attempts 20 s apart, 10 s a request. */
export const DEFAULTS = { threshold: 80, attempts: 3, retrySeconds: 20, timeoutSeconds: 10 };

/**
 * A random id of a session's shape (SESSION_ID_PATTERN in packages/shared):
 * 32 random bytes in base64url, 43 characters. The backend refuses an id of
 * any other shape before it reads the database, and a lookup that never
 * reaches the database would not check it.
 */
export const randomSessionId = () => randomBytes(32).toString('base64url');

// ASCII letters lowercased and nothing else, so every position stays where it was.
const lowerAscii = (text) => text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/**
 * Replaces every occurrence of each secret, in any ASCII letter case, by its
 * stand-in: a URL's host is printed lowercased. A literal scan rather than a
 * regular expression, so a value of any length is scrubbed and scrubbing never
 * throws.
 */
export const scrubber = (secrets) => (line) => {
  let text = String(line);
  for (const [secret, stand] of secrets) {
    if (!secret) continue;
    const needle = lowerAscii(secret);
    const hay = lowerAscii(text);
    let scrubbed = '';
    let from = 0;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, from)) {
      scrubbed += text.slice(from, at) + stand;
      from = at + needle.length;
    }
    text = scrubbed + text.slice(from);
  }
  return text;
};

/** The UTC time, to the second, as db-backup.sh prints it. */
export const stamp = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * A base URL from the environment: https, or http on the loopback interface,
 * with no credentials, query or fragment. The value itself is never quoted in
 * the error, in case a token was pasted where a URL belongs.
 */
export function baseUrl(value, name) {
  let url;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) {
    throw new Error(`${name} must be an https URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must hold no credentials, query or fragment`);
  }
  return url;
}

/** The heartbeat URL of a monitor: its token under the base, and `/fail` for a failure. */
export function heartbeatUrl(base, token, ok) {
  const path = `${base.pathname.replace(/\/+$/, '')}/${token}${ok ? '' : '/fail'}`;
  return new URL(path, base);
}

/**
 * Percent of a filesystem in use as `df` shows it, from `fs.statfs`: used is
 * every block that is not free, available what an unprivileged user may still
 * write, and the root-reserved blocks count in neither. Rounded up, as df
 * rounds, so a disk is never reported emptier than it is.
 */
export function diskUsagePercent({ blocks, bfree, bavail }) {
  const used = Number(blocks) - Number(bfree);
  const total = used + Number(bavail);
  if (!(total > 0) || used < 0) throw new Error('the filesystem reported no usable blocks');
  return Math.ceil((used * 100) / total);
}

/** Whether a disk at this percentage fails: at or above the threshold. */
export const diskFails = (percent, threshold) => percent >= threshold;

/**
 * A request's failure in a few words, from codes and names only, never from a
 * message that might quote a URL.
 */
export function describeError(error, timeoutMs) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return `no answer within ${timeoutMs / 1000} s`;
  }
  for (const code of [error?.cause?.code, error?.code]) {
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,59}$/.test(code)) return code;
  }
  // fetch's own reasons are a few lowercase words: `unexpected redirect`,
  // `bad port`. Anything longer, or with a host or a path in it, is not used.
  const reason = error?.cause?.message;
  if (typeof reason === 'string' && /^[a-z][a-z ]{0,39}$/.test(reason)) return reason;
  return typeof error?.name === 'string' && /^\w{1,40}$/.test(error.name)
    ? error.name
    : 'an unknown error';
}

// The media type of an answer, for the log and the heartbeat: one of the few
// the checks expect, or `other`. Nothing the site sends is repeated, so a
// header cannot carry the session id, altered past the scrub, into either.
const MEDIA_TYPES = new Set(['text/html', 'application/json', 'text/plain']);
const mediaType = (response) => {
  const header = response.headers.get('content-type');
  if (header === null || header.trim() === '') return 'no content type';
  const type = lowerAscii(header.split(';')[0].trim());
  return MEDIA_TYPES.has(type) ? type : 'other';
};

// The signal that ends a request after `ms`; the tests replace it to read `ms`.
const timeoutSignal = (ms) => globalThis.AbortSignal.timeout(ms);

/** What the run checks, step by step, as the log and the heartbeat name it. */
export const SITE_STEPS = {
  page: 'GET /',
  lookup: 'GET /api/sessions/<random>',
  receive: 'GET /s/<random> on the receive host',
};

// A 404 JSON answer with errorCode 1001, or the description of what came
// instead.
async function expectSessionNotFound(response, step) {
  const type = mediaType(response);
  const text = await response.text();
  if (response.status !== 404 || type !== 'application/json') {
    return `${step} answered ${response.status} ${type}`;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return `${step} answered 404 application/json that did not parse`;
  }
  if (body?.errorCode !== 1001) {
    const code = Number.isInteger(body?.errorCode) ? body.errorCode : 'none';
    return `${step} answered 404 with errorCode ${code}, not 1001`;
  }
  return null;
}

// One attempt: the page, then the lookup, which needs the backend and the
// database, then the receive host, which needs its TCP route, the backend's
// receive listener and the database. Resolves to a failure's description, or
// null when all three passed.
async function probeOnce(site, receive, { fetcher, timeoutMs, newId, deadline }) {
  const options = () => ({
    redirect: 'error',
    headers: { 'user-agent': 'qa-tools-monitor' },
    signal: deadline(timeoutMs),
  });
  let step = SITE_STEPS.page;
  try {
    const page = await fetcher(new URL('/', site), options());
    const pageType = mediaType(page);
    const document = await page.text();
    if (page.status !== 200 || pageType !== 'text/html') {
      return `GET / answered ${page.status} ${pageType}`;
    }
    if (!/<html[\s>]/i.test(document))
      return 'GET / answered 200 text/html without an HTML document';

    step = SITE_STEPS.lookup;
    const lookup = await fetcher(new URL(`/api/sessions/${newId()}`, site), options());
    const lookupFailure = await expectSessionNotFound(lookup, step);
    if (lookupFailure !== null) return lookupFailure;

    step = SITE_STEPS.receive;
    const received = await fetcher(new URL(`/s/${newId()}`, receive), options());
    return await expectSessionNotFound(received, step);
  } catch (error) {
    return `${step} failed: ${describeError(error, timeoutMs)}`;
  }
}

/**
 * The site check, the receive host included: up to `attempts` attempts,
 * `retryMs` apart. Resolves to `{ ok, attempt, detail }`, the detail being the
 * passing attempt's summary or the last failure.
 */
export async function probeSite(
  site,
  receive,
  { fetcher, attempts, retryMs, timeoutMs, newId, pause, log, deadline = timeoutSignal },
) {
  let failure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await pause(retryMs);
    failure = await probeOnce(site, receive, { fetcher, timeoutMs, newId, deadline });
    if (failure === null) {
      const detail =
        `${SITE_STEPS.page} 200 text/html, ${SITE_STEPS.lookup} 404 errorCode 1001, ` +
        `${SITE_STEPS.receive} 404 errorCode 1001`;
      log(`Site attempt ${attempt} of ${attempts} passed: ${detail}`);
      return { ok: true, attempt, detail };
    }
    log(`Site attempt ${attempt} of ${attempts} failed: ${failure}`);
  }
  return { ok: false, attempt: attempts, detail: failure };
}

/**
 * Sends one heartbeat and says how it went; a failure is described, never
 * thrown, and never with the URL.
 */
export async function sendHeartbeat({
  base,
  token,
  ok,
  body,
  fetcher,
  timeoutMs,
  deadline = timeoutSignal,
}) {
  try {
    const response = await fetcher(heartbeatUrl(base, token, ok), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'text/plain; charset=utf-8', 'user-agent': 'qa-tools-monitor' },
      body,
      signal: deadline(timeoutMs),
    });
    await response.arrayBuffer().catch(() => {});
    return { sent: response.ok, detail: `answered ${response.status}` };
  } catch (error) {
    return { sent: false, detail: describeError(error, timeoutMs) };
  }
}

// A number from the environment, or the default when it is unset. A value
// outside the range is a configuration error, and gives null.
function numberSetting(env, name, fallback, { min, max, integer }, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    problems.push(
      `${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`,
    );
    return null;
  }
  return value;
}

/**
 * One run. Returns the exit status; everything it needs from outside can be
 * replaced, which is how the tests run it without a network or a clock.
 */
export async function main({
  env = process.env,
  fetcher = globalThis.fetch,
  stat = statfs,
  pause = sleep,
  newId = randomSessionId,
  deadline = timeoutSignal,
  out = process.stdout,
  err = process.stderr,
} = {}) {
  // Everything that must never reach the output. A token is scrubbed even when
  // it failed validation, and every session id the run makes up is added here
  // before it is used.
  const secrets = [];
  const scrub = scrubber(secrets);
  const write = (stream, line) => stream.write(`${stamp()} ${scrub(line)}\n`);
  const log = (line) => write(out, line);
  const fail = (line) => write(err, `ERROR: ${line}`);
  const makeId = () => {
    const id = newId();
    secrets.push([id, '<random>']);
    return id;
  };

  const problems = [];
  const token = (name) => {
    const value = (env[name] ?? '').trim();
    if (value) secrets.push([value, '<token>']);
    if (!value) problems.push(`${name} is not set: Secret or key missing, no heartbeat for it`);
    else if (!TOKEN.test(value)) problems.push(`${name} does not look like a heartbeat token`);
    else return value;
    return null;
  };
  const url = (name) => {
    try {
      return baseUrl(env[name], name);
    } catch (error) {
      problems.push(error.message);
      return null;
    }
  };
  const tokens = { site: token('MONITOR_SITE_TOKEN'), disk: token('MONITOR_DISK_TOKEN') };
  const heartbeat = url('MONITOR_HEARTBEAT_URL');
  const site = url('MONITOR_SITE_URL');
  const receive = url('MONITOR_RECEIVE_URL');
  const diskPath = env.MONITOR_DISK_PATH ?? '';
  const threshold = numberSetting(
    env,
    'MONITOR_DISK_THRESHOLD',
    DEFAULTS.threshold,
    { min: 1, max: 100, integer: true },
    problems,
  );
  const attempts =
    numberSetting(
      env,
      'MONITOR_ATTEMPTS',
      DEFAULTS.attempts,
      { min: 1, max: 10, integer: true },
      problems,
    ) ?? DEFAULTS.attempts;
  const retrySeconds =
    numberSetting(
      env,
      'MONITOR_RETRY_SECONDS',
      DEFAULTS.retrySeconds,
      { min: 0, max: 60 },
      problems,
    ) ?? DEFAULTS.retrySeconds;
  const timeoutSeconds =
    numberSetting(
      env,
      'MONITOR_TIMEOUT_SECONDS',
      DEFAULTS.timeoutSeconds,
      { min: 0.1, max: 30 },
      problems,
    ) ?? DEFAULTS.timeoutSeconds;
  const timeoutMs = timeoutSeconds * 1000;
  if (!diskPath.startsWith('/')) problems.push('MONITOR_DISK_PATH must be an absolute path');
  for (const problem of problems) fail(problem);

  log(
    `Monitor: site ${site?.origin ?? '(not set)'}, receive host ` +
      `${receive?.origin ?? '(not set)'}, disk ${diskPath || '(not set)'} failing at ` +
      `${threshold ?? '(not set)'}%, heartbeats to ${heartbeat?.origin ?? '(not set)'}`,
  );

  let delivered = 0;
  const send = async (name, ok, body) => {
    const label = ok ? name : `${name}/fail`;
    if (!heartbeat || !tokens[name]) {
      fail(`Heartbeat ${label} not sent: ${!heartbeat ? 'no heartbeat URL' : 'no token'}`);
      return;
    }
    const result = await sendHeartbeat({
      base: heartbeat,
      token: tokens[name],
      ok,
      body: scrub(body).replace(/\s+/g, ' ').slice(0, 300),
      fetcher,
      timeoutMs,
      deadline,
    });
    if (result.sent) {
      delivered += 1;
      log(`Heartbeat ${label} sent: ${result.detail}`);
    } else {
      fail(`Heartbeat ${label} not delivered: ${result.detail}`);
    }
  };

  // 1. Disk
  let disk;
  if (threshold === null || !diskPath.startsWith('/')) {
    disk = { ok: false, line: 'disk check not configured: see the monitor log' };
  } else {
    try {
      const fs = await stat(diskPath);
      const percent = diskUsagePercent(fs);
      const free = ((Number(fs.bavail) * Number(fs.bsize)) / GIB).toFixed(1);
      disk = {
        ok: !diskFails(percent, threshold),
        line: `disk ${percent}% used, ${free} GiB free; fails at ${threshold}%`,
      };
    } catch (error) {
      disk = {
        ok: false,
        line: `disk usage of ${diskPath} not read: ${describeError(error, timeoutMs)}`,
      };
    }
  }
  log(disk.line);
  await send('disk', disk.ok, disk.line);

  // 2. Site
  let siteLine;
  let siteOk = false;
  if (!site || !receive) {
    siteLine = 'site check not configured: see the monitor log';
  } else {
    const result = await probeSite(site, receive, {
      fetcher,
      attempts,
      retryMs: retrySeconds * 1000,
      timeoutMs,
      newId: makeId,
      pause,
      log,
      deadline,
    });
    siteOk = result.ok;
    siteLine = result.ok
      ? `site up: ${result.detail}; attempt ${result.attempt} of ${attempts}`
      : `site down after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${result.detail}`;
  }
  log(siteLine);
  await send('site', siteOk, siteLine);

  const status = problems.length === 0 && delivered === 2 ? 0 : 1;
  log(
    `Monitor finished: site ${siteOk ? 'up' : 'down'}, disk ${disk.ok ? 'ok' : 'failing'}; ` +
      `${delivered} of 2 heartbeats delivered`,
  );
  return status;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    // Not expected: every step reports its own failure. The name alone, since
    // a message could quote a URL.
    const name = /^\w{1,40}$/.test(error?.name ?? '') ? error.name : 'an unknown error';
    process.stderr.write(`${stamp()} ERROR: the monitor stopped: ${name}\n`);
    process.exitCode = 1;
  }
}
