// Sends the nightly backup's outcome to Statuser.cloud (D181, issue #68).
//
// Runs beside the backup in its pod (templates/db-backup.yaml), on the backend
// image as uid 1000, because the PostgreSQL image has no HTTPS client and
// stays unchanged. It is a native sidecar, an init container with
// `restartPolicy: Always`: it starts before the backup container, and the
// kubelet stops it after that container has ended, so the Job ends when the
// backup ends, Complete or Failed as the backup container decides (D176).
//
// db-backup.sh writes NOTIFY_STATUS_FILE on every exit it can observe, by
// renaming a complete file into place: `ok`, or `fail` with the script's own
// message on the next line. This waits for the file and sends `backup` or
// `backup/fail` with that message. The kubelet stops the sidecar only after the
// backup container has ended, so by the stop signal (TERM or INT) the file is
// normally there. The NOTIFY_STOP_WAIT_SECONDS it still keeps looking after a
// stop is a guard, for a stop that reaches both containers at once. If the file
// never comes, the backup ended without reporting — killed outright, out of
// memory, or it could not write the file — and `backup/fail` says so.
//
// After sending it waits to be stopped rather than exit: a sidecar that exits
// while the backup container is still finishing is started again. It always
// exits 0. A missing token (the Secret is optional), a Statuser that cannot be
// reached or a status file that cannot be read is logged and never changes
// the backup's outcome. The token, and any URL holding it, is never printed.
//
// Environment:
//   NOTIFY_STATUS_FILE         the file db-backup.sh writes
//   NOTIFY_HEARTBEAT_URL       Statuser's heartbeat endpoint, https://hb.statuser.cloud
//   NOTIFY_TOKEN               the `backup` monitor's token
//   NOTIFY_POLL_SECONDS        how often to look for the file, default 2
//   NOTIFY_STOP_WAIT_SECONDS   how long to look once stopped, default 10
//   NOTIFY_TIMEOUT_SECONDS     limit for the heartbeat request, default 10

import { readFile } from 'node:fs/promises';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';
import process from 'node:process';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;

/** The body sent when the backup ended without writing its status. */
export const NO_REPORT = 'The backup ended without reporting an outcome';

const stamp = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ASCII letters lowercased and nothing else, so every position stays where it was.
const lowerAscii = (text) => text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/**
 * The status file's content as `{ ok, message }`: `ok` alone, or `fail` and a
 * message on the next line. Anything else is a failure too, since a backup
 * that reports nothing readable has not reported success.
 */
export function parseStatus(text) {
  const [outcome = '', message = ''] = text.split('\n');
  const line = message.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (outcome === 'ok') return { ok: true, message: '' };
  if (outcome === 'fail') return { ok: false, message: line || 'The backup failed' };
  return { ok: false, message: 'The backup wrote a status that was not understood' };
}

/** The heartbeat's body: one line of plain text. */
export const heartbeatBody = ({ ok, message }) =>
  ok ? 'backup succeeded' : `backup failed: ${message}`;

function heartbeatBase(value) {
  let url;
  try {
    url = new URL(value ?? '');
  } catch {
    return null;
  }
  const scheme =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  return scheme && !url.username && !url.password && !url.search && !url.hash ? url : null;
}

function describeError(error, timeoutMs) {
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

const seconds = (value, fallback, min, max) => {
  const number = Number(value);
  return value !== undefined &&
    value !== '' &&
    Number.isFinite(number) &&
    number >= min &&
    number <= max
    ? number
    : fallback;
};

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

// An error's name for the log, never its message, which could quote a value.
function errorName(error) {
  try {
    const name = error?.name;
    return typeof name === 'string' && /^\w{1,40}$/.test(name) ? name : 'an unknown error';
  } catch {
    return 'an unknown error';
  }
}

/**
 * One run, to the stop signal. Returns the exit status, which is always 0;
 * the process and its clock can be replaced for the tests. Whatever fails
 * after the stop signal is set up is logged by its name alone, and the
 * notifier still waits to be stopped rather than exit and be restarted.
 */
export async function main({
  env = process.env,
  fetcher = globalThis.fetch,
  signals = process,
  out = process.stdout,
} = {}) {
  // `plain` is for lines of fixed text and an error's name; every other line
  // goes through the scrub.
  const plain = (line) => out.write(`${stamp()} ${line}\n`);
  let scrub = (line) => line;
  const log = (line) => plain(scrub(line));

  // The stop signal wakes whatever wait is running.
  let stoppedAt = null;
  let wake = new globalThis.AbortController();
  const stop = (name) => {
    if (stoppedAt === null) {
      stoppedAt = Date.now();
      plain(`Stopped by ${name}`);
    }
    wake.abort();
  };
  const onTerm = () => stop('SIGTERM');
  const onInt = () => stop('SIGINT');
  signals.on('SIGTERM', onTerm);
  signals.on('SIGINT', onInt);
  const nap = async (ms) => {
    if (wake.signal.aborted) wake = new globalThis.AbortController();
    await sleep(ms, undefined, { signal: wake.signal }).catch(() => {});
  };

  try {
    const raw = String(env.NOTIFY_TOKEN ?? '').trim();
    scrub = scrubber(raw ? [[raw, '<token>']] : []);

    const file = String(env.NOTIFY_STATUS_FILE ?? '');
    const base = heartbeatBase(env.NOTIFY_HEARTBEAT_URL);
    const token = TOKEN.test(raw) ? raw : null;
    const pollMs = seconds(env.NOTIFY_POLL_SECONDS, 2, 0.01, 60) * 1000;
    const stopWaitMs = seconds(env.NOTIFY_STOP_WAIT_SECONDS, 10, 0, 25) * 1000;
    const timeoutMs = seconds(env.NOTIFY_TIMEOUT_SECONDS, 10, 0.1, 15) * 1000;

    if (!raw) {
      log('NOTIFY_TOKEN is not set (Secret or key missing): the outcome is logged, not sent');
    } else if (!token) {
      log('NOTIFY_TOKEN does not look like a heartbeat token: the outcome is logged, not sent');
    }
    if (!base) log('NOTIFY_HEARTBEAT_URL is not an https URL: the outcome is logged, not sent');
    if (!file.startsWith('/')) log('NOTIFY_STATUS_FILE is not an absolute path');

    log(`Waiting for the backup's status in ${file || '(not set)'}`);
    let status = null;
    // A read error other than a missing file is logged once, not at every look.
    let readError = null;
    for (;;) {
      if (file.startsWith('/')) {
        try {
          status = parseStatus(await readFile(file, 'utf8'));
        } catch (error) {
          const reason = describeError(error, 0);
          if (error?.code !== 'ENOENT' && reason !== readError) {
            log(`The status file could not be read: ${reason}`);
          }
          readError = reason;
        }
      }
      if (status) break;
      if (stoppedAt !== null && Date.now() - stoppedAt >= stopWaitMs) break;
      await nap(stoppedAt === null ? pollMs : Math.min(pollMs, 250));
    }
    if (status) {
      log(`The backup reported ${status.ok ? 'success' : `failure: ${status.message}`}`);
    } else {
      log(`${NO_REPORT} within ${stopWaitMs / 1000} s of the stop signal`);
      status = { ok: false, message: NO_REPORT };
    }
    const label = status.ok ? 'backup' : 'backup/fail';

    if (token && base) {
      const url = new URL(
        `${base.pathname.replace(/\/+$/, '')}/${token}${status.ok ? '' : '/fail'}`,
        base,
      );
      try {
        const response = await fetcher(url, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'user-agent': 'qa-tools-monitor',
          },
          body: scrub(heartbeatBody(status)),
          signal: globalThis.AbortSignal.timeout(timeoutMs),
        });
        await response.arrayBuffer().catch(() => {});
        log(
          `Heartbeat ${label} ${response.ok ? 'sent' : 'not delivered'}: answered ${response.status}`,
        );
      } catch (error) {
        log(`Heartbeat ${label} not delivered: ${describeError(error, timeoutMs)}`);
      }
    } else {
      log(`Heartbeat ${label} not sent`);
    }
  } catch (error) {
    plain(`The notifier stopped on an error: ${errorName(error)}`);
  }

  try {
    // Until the kubelet stops the sidecar: one that exits is started again.
    while (stoppedAt === null) await nap(60_000);
  } finally {
    signals.off('SIGTERM', onTerm);
    signals.off('SIGINT', onInt);
  }
  return 0;
}

// Until a stop signal, for the one failure `main` cannot catch itself.
const untilStopped = () =>
  new Promise((resolve) => {
    const keep = setInterval(() => {}, 60_000);
    const done = () => {
      clearInterval(keep);
      resolve();
    };
    process.once('SIGTERM', done);
    process.once('SIGINT', done);
  });

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    // Not expected: `main` catches what fails inside it. The name alone, and
    // exit 0 on the stop signal, as ever.
    process.stdout.write(`${stamp()} The notifier stopped on an error: ${errorName(error)}\n`);
    process.exitCode = 0;
    await untilStopped();
  }
}
