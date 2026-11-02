#!/usr/bin/env node
/**
 * The ordinary-load measurement of issue #186 (D232): how many ordinary users
 * at once the backend serves well - people with a session page open, webhooks
 * arriving from their systems, a CI run calling the API - where every load
 * measurement before it was a hostile one.
 *
 * The simulated user (the owner's profile of 2026-10-12, `PROFILE` below): one
 * session; its page open, the realtime connection `/ws/<session-id>` reading
 * events and the list reloaded on every `ready`, as the frontend does, and a
 * connection the server ends or refuses opened again after the frontend's
 * delay (`nextRetryDelay`, D079); a webhook every 5 s, its body JSON of 512
 * bytes to 10 KiB and one in 20 of 200 KiB; a reload of the page now and then,
 * 30 to 90 s apart, its connection closed as a browser closes a page's
 * connections when it leaves it - not waited for - and the page loaded afresh.
 * One user in ten is a CI run instead: it creates a session, starts a list
 * call with `wait`, sends 20 webhooks a second apart, lists until it has every
 * one, deletes the session, pauses 5 s and repeats. Every session is created
 * with a lifetime of an hour (`expiresInSeconds`), so that one a crash leaves
 * behind ends on its own.
 *
 * Served well (the owner's definition, `SERVED_WELL`): the p99 capture time
 * under 1 s, the p99 time from a capture to its row on the open page within
 * 2 s and every captured webhook shown there, no webhook lost - every one sent
 * is stored, counted through the API at the end - and no error: no answer but
 * the expected 2xx, no failed call and no realtime connection closed or
 * refused that the page did not close itself. A row that reached its page by
 * a list read alone is told apart by what its page was doing when the webhook
 * was captured (`realtime.listOnly`), and one whose event never came on a
 * connection that was ready before the webhook was sent and stayed open 2 s
 * after its capture is counted as `missedOnLiveConnection`, the sign of an
 * event lost by the server rather than of a page that was not connected.
 *
 * Commands, from the repository's root:
 *
 *   node scripts/measure-ordinary-load.mjs local [--steps 12+2,50,100,200,400,800]
 *     [--ramp 60] [--hold 180] [--settle 15] [--idle 30] [--backend-cpus 0.5]
 *     [--profile '<json>'] [--cpu-prof DIR] [--out DIR] [--image IMAGE]
 *     [--stop-after 2] [--keep]
 *
 * Part 1 (#186). For every step a fresh project of
 * `scripts/measure-ordinary-load.compose.yml` - the backend image built from
 * this checkout, run with 0.5 CPU and 512 MiB and no swap as production's,
 * PostgreSQL of the project's image with 1 CPU and 1 GiB on a volume of its
 * own, and a client container - and the load run inside the client straight
 * to the backend, no Traefik. Every user comes from an address of its own in
 * 198.18.0.0/15, the benchmarking range: its webhooks open with a PROXY v2
 * header naming it and its API and realtime calls carry an `X-Forwarded-For`
 * naming it, the client being the one trusted peer (`TRUSTED_PROXY_CIDRS`),
 * so the per-address limits (D201, D213, D227) count each user apart. A step
 * is `N` users, a tenth of them CI runs, or `P+C`, P page users and C CI runs.
 * The users start evenly over the ramp, send for the hold, and the settle lets
 * the last events arrive. The backend has no health check of the setup's own
 * (#261): each step starts it and then asks `http://backend:3000/readyz` from
 * the client container every 500 ms until it answers `200`, failing after
 * 120 s with the last answer or error (`readinessWait`), so that no process
 * but the backend's runs in its cgroup from its start to the end of the
 * step's settle - as production's probes, HTTP requests from the kubelet,
 * start none. The backend's, PostgreSQL's and the client container's CPU and
 * memory are read from outside, through the Docker Engine's stats stream,
 * once a second; the backend's `memory.peak`, `cpu.stat` and `cpu.max` are
 * read once the step has ended, by the one process run in its container,
 * `cpu.max` given as `backend.cpuLimit` in CPUs (`cpuLimit`). One JSON report
 * a step is printed and written to `DIR` (a directory under the system's
 * temporary one unless given); after `--stop-after` steps in a row not
 * served well the rest are skipped. Every container, network and volume is
 * removed at the end unless `--keep`; the built image,
 * `dev186-measure-backend`, is left for the next run and removed by hand.
 * `--image` runs an image built before instead.
 *
 * For the CPU each unit of work costs (#188): every step first keeps quiet
 * for `--idle` seconds, 0 to 3600, the containers' CPU over that window
 * reported as their `idle` - since #261 the backend's own work alone, where
 * #186's and #188's held a compose health check's `node` once a second,
 * about 7 % of a CPU; and the report's `units` count what the backend did
 * over the hold, each when it was done - the webhooks answered `200`, the
 * `request.received` events that reached their page, the API calls
 * answered, by kind, and the realtime connections that came `ready`.
 * `--backend-cpus N` limits the backend to N CPUs instead of 0.5,
 * which the report's `backend.cpuLimit` reads back from its cgroup.
 * `--cpu-prof DIR` adds `measure-ordinary-load.cpu-prof.yml`: the backend
 * runs under `node --cpu-prof` with the probe `measure-ordinary-load.probe.mjs`
 * and PostgreSQL with `pg_stat_statements`; after each step, 500 webhooks of
 * 2 KiB are sent one after another from one address, after 10 s of quiet,
 * with the statements counted from nothing; the backend is stopped with
 * SIGTERM, and its profile and the probe's lines are copied to
 * `DIR/step-<step>/` with `profile-summary.json`: the functions and modules
 * with the most self time over the hold (`holdCpu`), the event loop's turns
 * over the hold and per webhook captured, and the statements, turns and
 * events one capture takes (`perCapture`). A profiled step is not one of the
 * line: the profiler spends some of the backend's CPU. A step's report is
 * written as soon as its load is measured, before its profile is read, and
 * again with `cpuProfile` once it is; a `DIR` that already holds the
 * `step-<step>` directory of a step the run would take is refused before any
 * container starts, naming it, and nothing in it is deleted (#261).
 *
 *   node scripts/measure-ordinary-load.mjs production --sessions-file FILE
 *     [--page 12] [--ci 2] [--ramp 60] [--hold 180] [--settle 15]
 *     [--app-origin https://qa-tools.ru] [--receive-origin https://hook.qa-tools.ru]
 *
 * Part 2 (#186): the same profile from this machine's one address against the
 * public hosts, within what one address may do (docs/PRODUCT.md, `Limits`),
 * every limit planned at 80 %: at most 12 page users, each holding one of the
 * address's 16 realtime connections, so that 4 stay free for a reload's new
 * connection arriving before the server has let the old one go and for any
 * other page open behind the same address, and API calls well under 60
 * creations and 1200 other calls a minute and 128 in flight -
 * `productionBudget` refuses a run that would not be, and one whose profile
 * or figures it cannot count. Every mode refuses a `--profile` that is not a
 * profile (`profileProblems`): a field it does not have, a figure not a whole
 * number in its range, or a range whose end is below its start. Close every
 * QA Tools session page open in a browser behind this address first: each
 * holds one of the 16. Run from the operator's Mac at a quiet hour, never from the VPS.
 * Every session id is appended to FILE (`created <id>`) as soon as its
 * creation is answered, before any other call uses it, and `deleted <id>`
 * once its `DELETE` is answered; every session is deleted at the end. On
 * Ctrl-C or SIGTERM no user waits for the hold's end: a user not yet started
 * does not start, a page user sends nothing more and ends when its next
 * reload was planned, up to 90 s away, and a CI run in progress first sends
 * the rest of its 20 webhooks and lists them; each then counts and deletes
 * what it created. A terminal's Ctrl-C reaches every process of the run and a
 * SIGTERM sent to the run is passed on to its workers; a SIGINT sent to the
 * run's own process alone is not, and its workers run to the planned end,
 * deleting their sessions there. The report gives the start and end times.
 *
 *   node scripts/measure-ordinary-load.mjs cleanup --sessions-file FILE
 *     [--app-origin ORIGIN]
 *
 * After a crash: deletes every session FILE records as created and not as
 * deleted, `404` counting as gone, records each deletion in FILE, then reads
 * every session FILE ever recorded and reports any still there. A line that
 * is not `created <id>` or `deleted <id>` with a well-formed session id is
 * skipped, so nothing but `/api/sessions/<session-id>` is ever called. It
 * calls the origin FILE's run headers name (`# measure-ordinary-load <mode>
 * <time> <origin>`), so that a local run's file is never cleaned against
 * production, where every session would answer `404` and be recorded deleted
 * while alive where it was made; it refuses an `--app-origin` that is not that
 * origin, a file whose runs name more than one, and a file with no run header
 * unless `--app-origin` is given.
 *
 *   node scripts/measure-ordinary-load.mjs rehearse [--hold 60] [--out DIR] [--image IMAGE]
 *
 * Part 2's dry run, through production's front: the local project with
 * Traefik in front of the backend as production has it (the `front` profile
 * of the compose file, `measure-ordinary-load.traefik.yml`, which is
 * `measure-connections.traefik.yml` on this project's addresses), TLS ending
 * at Traefik, the receive host a TCP route writing PROXY v2, the application
 * an HTTP route writing `X-Forwarded-For`. The production mode's default run,
 * 12 page users and 2 CI runs, from the client container's one address; then
 * `cleanup` on its file, which must find nothing left; then the same run
 * stopped dead after 20 s as a crash would (`--crash-after`), and `cleanup`
 * deleting what it left; then `places`, which must find all 16 of the
 * address's realtime connections free.
 *
 *   node scripts/measure-ordinary-load.mjs front [--page 16] [--ci 2]
 *     [--other-pages 0] [--ramp 60] [--hold 180] [--settle 15]
 *     [--profile '<json>'] [--out DIR] [--image IMAGE] [--keep]
 *
 * The load from one address through the same front, with no budget: how the
 * realtime limit of one address meets a run's pages and their reloads.
 * `--other-pages N` holds N more realtime connections from the address for
 * the whole run, opened before it, as pages open in other browsers behind the
 * same address would. The step is measured as a Part 1 step is - the
 * containers' CPU and memory, Traefik's too - and `places` follows it.
 *
 * Inside the client container the same file is the load itself, `client`,
 * with the same flags as `production` and `--addresses per-user`; it splits
 * the users over worker processes (`--workers`, one per 100 users, at most
 * 8) and reports each worker's event-loop delay, CPU and how late its
 * webhooks left against their plan, so that a client too busy to keep up is
 * not mistaken for a slow server (`CLIENT_HEALTH`). `--profile '<json>'`
 * overrides parts of `PROFILE`, for the tests and the front's runs.
 * `--crash-after S` stops every process dead after S seconds, for a rehearsal
 * of `cleanup`. `captures [--count 500] [--quiet 10]` is `--cpu-prof`'s
 * series, `--quiet` 0 to 3600 s.
 * `places [--count 16]` creates a session, opens that many
 * realtime connections to it at once from the client's address, reports how
 * many were refused, closes them and deletes the session - again 65 s later
 * when any was, by when the server's heartbeat has cut a connection that
 * stopped answering; it refuses a production origin.
 *
 * No session id is printed: it is the session's key (D153).
 *
 * Dependency-free, Node 24.
 */
import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import console from 'node:console';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import process from 'node:process';
import readline from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
// No imports of its own, so Node loads it as TypeScript here with nothing installed.
import {
  MAX_BODY_BYTES,
  MAX_REQUESTS_PER_SESSION,
  NEGOTIABLE_EVENT_TYPES,
  REALTIME_EVENTS_PARAM,
  REQUEST_LIST_MAX_WAIT_SECONDS,
  SESSION_ID_PATTERN,
  SESSION_LIFETIME_MAX_SECONDS,
  SESSION_LIFETIME_MIN_SECONDS,
} from '../packages/shared/src/index.ts';

const SCRIPT = fileURLToPath(import.meta.url);
const MIB = 1024 * 1024;

/** The simulated user (owner, 2026-10-12) and the choices this script made within it. */
export const PROFILE = Object.freeze({
  /** A page user's webhooks, one every 5 s, sent on time whatever the server answers. */
  webhookIntervalMs: 5_000,
  /** Most bodies: JSON of 512 bytes to 10 KiB, evenly spread. */
  smallMinBytes: 512,
  smallMaxBytes: 10 * 1024,
  /** Now and then 200 KiB: one webhook in 20, against production's 7-day p99 of about 156 KiB. */
  largeBytes: 200 * 1024,
  largeEvery: 20,
  /** A reload of the session page now and then: 30 to 90 s apart, 60 s on average. */
  reloadMinMs: 30_000,
  reloadMaxMs: 90_000,
  /**
   * Whether a reload waits for its old connection's close before the page
   * loads again. A browser does not: leaving a page closes its connections and
   * the next page loads at once, so its new connection can reach the server
   * before the server has let the old one go.
   */
  reloadAwaitsClose: false,
  /** One user in ten is a CI run. */
  ciShare: 10,
  /** A CI run: 20 webhooks, a second apart, each awaited, the list with `wait`, then 5 s. */
  ciWebhooks: 20,
  ciIntervalMs: 1_000,
  ciWaitSeconds: 30,
  ciPauseMs: 5_000,
  /** Every session ends an hour after its creation, so none outlives a crash for long. */
  lifetimeSeconds: 3_600,
});

/** An hour: the longest delay a profile may set, well under a timer's 2^31 - 1 ms. */
const HOUR_MS = 3_600_000;

/**
 * The whole numbers a `--profile` may give each field, from and to. A delay
 * must be a whole number of milliseconds of at most an hour, since Node runs
 * a longer timer after 1 ms; a page's webhook interval and reloads at least
 * 1 ms apart; a body at most the server's limit; a CI run's wait the API's
 * 1 to 30 s; and a lifetime what `expiresInSeconds` takes.
 */
const PROFILE_RANGES = Object.freeze({
  webhookIntervalMs: [1, HOUR_MS],
  smallMinBytes: [0, MAX_BODY_BYTES],
  smallMaxBytes: [0, MAX_BODY_BYTES],
  largeBytes: [0, MAX_BODY_BYTES],
  largeEvery: [1, 1_000_000],
  reloadMinMs: [1, HOUR_MS],
  reloadMaxMs: [1, HOUR_MS],
  ciShare: [1, 1_000_000],
  ciWebhooks: [1, MAX_REQUESTS_PER_SESSION],
  ciIntervalMs: [0, HOUR_MS],
  ciWaitSeconds: [1, REQUEST_LIST_MAX_WAIT_SECONDS],
  ciPauseMs: [0, HOUR_MS],
  lifetimeSeconds: [SESSION_LIFETIME_MIN_SECONDS, SESSION_LIFETIME_MAX_SECONDS],
});

/**
 * Every way a profile is not one this script can run as planned: a field it
 * does not have, a figure that is not a whole number in its range - a string,
 * `NaN`, a negative delay - `reloadAwaitsClose` not a boolean, or a range
 * whose end is below its start. `productionBudget` would compute nothing true
 * from such a profile, `NaN` comparing false with every limit, and a negative
 * or inverted reload range reloads the page in a loop with no delay.
 */
export function profileProblems(profile) {
  const problems = [];
  const unknown = Object.keys(profile).filter((key) => !Object.hasOwn(PROFILE, key));
  // A value as a refusal names it: the start of a string, never all of one.
  const shown = (value) =>
    typeof value === 'string'
      ? JSON.stringify(value.slice(0, 40))
      : value !== null && typeof value === 'object'
        ? Array.isArray(value)
          ? 'a list'
          : 'an object'
        : String(value);

  if (unknown.length > 0) {
    problems.push(
      `the profile has no field ${unknown
        .slice(0, 3)
        .map((key) => shown(key))
        .join(', ')}${unknown.length > 3 ? ` or ${unknown.length - 3} more` : ''}`,
    );
  }

  for (const [key, [from, to]] of Object.entries(PROFILE_RANGES)) {
    const value = profile[key];

    if (!Number.isInteger(value) || value < from || value > to) {
      problems.push(`${key} takes a whole number from ${from} to ${to}, not ${shown(value)}`);
    }
  }

  if (typeof profile.reloadAwaitsClose !== 'boolean') {
    problems.push('reloadAwaitsClose takes true or false');
  }

  if (problems.length === 0 && profile.reloadMaxMs < profile.reloadMinMs) {
    problems.push('reloadMaxMs is below reloadMinMs');
  }

  if (problems.length === 0 && profile.smallMaxBytes < profile.smallMinBytes) {
    problems.push('smallMaxBytes is below smallMinBytes');
  }

  return problems;
}

/** `--profile`: a JSON object of the fields to change, refused unless the result is a profile. */
export function parseProfile(text) {
  let given;

  try {
    given = JSON.parse(text);
  } catch {
    throw new Error('--profile takes a JSON object');
  }

  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    throw new Error('--profile takes a JSON object');
  }

  const profile = { ...PROFILE, ...given };
  const problems = profileProblems(profile);

  if (problems.length > 0) {
    throw new Error(`--profile: ${problems.join('; ')}`);
  }

  return profile;
}

/** Served well (owner, 2026-10-12). */
export const SERVED_WELL = Object.freeze({ captureP99Ms: 1_000, realtimeP99Ms: 2_000 });

/** Past these a worker may have been too busy to keep its plan: the step is not trusted. */
export const CLIENT_HEALTH = Object.freeze({
  eventLoopP99Ms: 50,
  cpuPercent: 80,
  scheduleLagP99Ms: 100,
});

/** What one address may do on production (docs/PRODUCT.md, `Limits`). */
export const PUBLISHED_LIMITS = Object.freeze({
  creationsPerMinute: 60,
  callsPerMinute: 1_200,
  callsInFlight: 128,
  realtimeConnections: 16,
});

/** The share of a published limit a production run may plan for. */
const BUDGET_SHARE = 0.8;
/**
 * The page users a production run may have, each holding a realtime
 * connection: 80 % of the address's 16, as every other limit is planned, so
 * that 4 stay free for a reload's new connection and for pages open in other
 * browsers behind the same address. The first production run planned all 16,
 * and its 16th page was refused for the whole run (D232).
 */
export const PRODUCTION_PAGE_USERS_MAX = Math.floor(
  PUBLISHED_LIMITS.realtimeConnections * BUDGET_SHARE,
);
/** This Mac's path to production carries at most 176 TLS connections at once; stay well under. */
const TLS_CONNECTIONS_MAX = 150;

/** Every call but a wait gives up after this long; a wait after its own seconds and this. */
const CALL_TIMEOUT_MS = 15_000;
/**
 * An API connection idle this long is closed by the client: under the 180 s
 * after which production's Traefik closes an idle one (its `idleTimeout`), so
 * that no call goes out on a connection the proxy is closing at that moment.
 * A browser repeats a call that fails so; this client would count it failed.
 */
const IDLE_SOCKET_MS = 60_000;

/** The frontend's reconnection delays (`apps/frontend/src/api/realtime.ts`, D079). */
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15_000;
const HEALTHY_CONNECTION_MS = 30_000;
/** How often a worker's event loop is sampled for its delay, in milliseconds. */
const LOOP_SAMPLE_MS = 10;

/** A webhook may wait 30 s for room before it is refused (D210); give it that and more. */
const WEBHOOK_TIMEOUT_MS = 60_000;

const PRODUCTION_APP_ORIGIN = 'https://qa-tools.ru';
const PRODUCTION_RECEIVE_ORIGIN = 'https://hook.qa-tools.ru';

/** The list calls made after the measurement: the count at the end and the deletions. */
const FINAL_KINDS = new Set(['count', 'cleanup']);

/** The status each kind of call is expected to answer. */
const EXPECTED_STATUS = {
  create: 201,
  sessionRead: 200,
  list: 200,
  wait: 200,
  delete: 204,
  count: 200,
  cleanup: 204,
};

/* ------------------------------------------------------------------------ */
/* Pure parts: the plan, the numbers and the verdict.                       */
/* ------------------------------------------------------------------------ */

/** Nearest rank: the smallest value at least `fraction` of `sorted` is not above. */
export function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return null;
  }

  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

function round(value) {
  return value === null || value === undefined ? null : Math.round(value * 10) / 10;
}

/** The count, median, p99 and max of the finite values, in milliseconds to a tenth. */
export function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);

  return {
    count: sorted.length,
    median: round(percentile(sorted, 0.5)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted.at(-1) ?? null),
  };
}

/**
 * The address user `index` comes from in Part 1: 198.18.0.1 onwards, in
 * 198.18.0.0/15, the range set aside for benchmarks (RFC 2544).
 */
export function userAddress(index) {
  const n = index + 1;

  if (!Number.isInteger(index) || index < 0 || n >= 2 ** 17 - 1) {
    throw new RangeError(`no address for user ${index}: 198.18.0.0/15 holds 131,070`);
  }

  return `198.${18 + (n >> 16)}.${(n >> 8) & 255}.${n & 255}`;
}

/**
 * The users of a step: `ciUsers` CI runs spread evenly among `pageUsers` page
 * users, each with its address and its start, evenly over the ramp.
 */
export function planUsers(pageUsers, ciUsers, rampMs) {
  const total = pageUsers + ciUsers;
  const ciAt = new Set(
    Array.from({ length: ciUsers }, (_, index) => Math.floor(((index + 0.5) * total) / ciUsers)),
  );

  return Array.from({ length: total }, (_, index) => ({
    index,
    kind: ciAt.has(index) ? 'ci' : 'page',
    address: userAddress(index),
    startMs: total <= 1 ? 0 : Math.round((index * rampMs) / total),
  }));
}

/** `16+2,50,100`: a step of 16 page users and 2 CI runs, then 50 and 100 users, a tenth CI. */
export function parseSteps(text, ciShare = PROFILE.ciShare) {
  return String(text)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const explicit = /^(\d{1,6})\+(\d{1,6})$/.exec(part);
      let pageUsers;
      let ciUsers;

      if (explicit) {
        pageUsers = Number(explicit[1]);
        ciUsers = Number(explicit[2]);
      } else if (/^\d{1,6}$/.test(part)) {
        const users = Number(part);

        ciUsers = Math.round(users / ciShare);
        pageUsers = users - ciUsers;
      } else {
        throw new Error(`a step is N or P+C, not ${JSON.stringify(part.slice(0, 40))}`);
      }

      if (pageUsers + ciUsers < 1 || pageUsers + ciUsers >= 2 ** 17 - 1) {
        throw new Error(`a step has 1 to 131,069 users, not ${pageUsers + ciUsers}`);
      }

      return { label: part, pageUsers, ciUsers, users: pageUsers + ciUsers };
    });
}

/** A seeded generator of numbers in [0, 1) (mulberry32), so that a step's bodies repeat. */
export function random(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The size of user `userIndex`'s webhook `seq`: one in `largeEvery` large, the rest small. */
export function webhookSize(userIndex, seq, next, profile = PROFILE) {
  if ((seq + userIndex) % profile.largeEvery === profile.largeEvery - 1) {
    return profile.largeBytes;
  }

  return (
    profile.smallMinBytes + Math.floor(next() * (profile.smallMaxBytes - profile.smallMinBytes + 1))
  );
}

/** A JSON body of exactly `size` bytes, or the smallest one when `size` is less. */
export function webhookBody(size, userIndex, seq) {
  const head = `{"event":"order.updated","user":${userIndex},"seq":${seq},"pad":"`;
  const tail = '"}';

  return Buffer.from(head + 'x'.repeat(Math.max(0, size - head.length - tail.length)) + tail);
}

const PROXY_V2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);

/** A PROXY protocol v2 header for TCP over IPv4 naming `source`, as Traefik writes one (D187). */
export function proxyHeader(source, sourcePort = 40_000) {
  const octets = source.split('.').map(Number);

  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    throw new RangeError('a PROXY header names an IPv4 address');
  }

  const addresses = Buffer.alloc(12);

  Buffer.from(octets).copy(addresses, 0);
  Buffer.from([10, 186, 0, 3]).copy(addresses, 4);
  addresses.writeUInt16BE(sourcePort & 0xffff, 8);
  addresses.writeUInt16BE(3001, 10);

  return Buffer.concat([
    PROXY_V2_SIGNATURE,
    Buffer.from([0x21, 0x11, 0, addresses.length]),
    addresses,
  ]);
}

/**
 * What an HTTP/1.1 answer read off a raw socket says so far: its status, its
 * headers by lower-case name, its body as text and the `errorCode` of an
 * error body, and whether it is complete - its `Content-Length` read, or its
 * last chunk. `status` is 0 until the head has arrived whole.
 */
export function parseHttpAnswer(bytes) {
  const headEnd = bytes.indexOf('\r\n\r\n');

  if (headEnd === -1) {
    return { complete: false, status: 0, headers: {}, body: '' };
  }

  const lines = bytes.subarray(0, headEnd).toString('latin1').split('\r\n');
  const status = Number(/^HTTP\/1\.[01] (\d{3}) /.exec(`${lines[0]} `)?.[1] ?? 0);
  const headers = {};

  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');

    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }

  const rest = bytes.subarray(headEnd + 4);
  const length = headers['content-length'];
  let complete = false;
  let body = rest;

  if (length !== undefined && /^\d{1,10}$/.test(length)) {
    complete = rest.length >= Number(length);
    body = rest.subarray(0, Number(length));
  } else if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
    complete =
      rest.length >= 5 && rest.subarray(rest.length - 5).toString('latin1') === '0\r\n\r\n';
  }

  const text = body.toString('utf8');
  const errorCode = status >= 400 ? /"errorCode":(\d{1,6})/.exec(text)?.[1] : undefined;

  return {
    complete,
    status,
    headers,
    body: text,
    ...(errorCode === undefined ? {} : { errorCode: Number(errorCode) }),
  };
}

/**
 * What a sessions file holds: the ids recorded `created` and not `deleted`,
 * in order and once each (`pending`), every id recorded `created` (`created`),
 * and how many lines were neither - not `created <id>` or `deleted <id>` with
 * a well-formed session id - and so were skipped. Empty lines and lines
 * opening with `#` are neither counted nor used.
 */
export function pendingSessions(text) {
  const created = [];
  const seen = new Set();
  const deleted = new Set();
  let skipped = 0;

  for (const raw of String(text).split('\n')) {
    const line = raw.trim();

    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const parts = line.split(' ');
    const [verb, id] = parts;

    if (
      parts.length !== 2 ||
      (verb !== 'created' && verb !== 'deleted') ||
      !SESSION_ID_PATTERN.test(id)
    ) {
      skipped += 1;
      continue;
    }

    if (verb === 'created' && !seen.has(id)) {
      seen.add(id);
      created.push(id);
    } else if (verb === 'deleted') {
      deleted.add(id);
    }
  }

  return { pending: created.filter((id) => !deleted.has(id)), created, skipped };
}

/** The line a run writes into its sessions file before its first session: `<it> <mode> <time> <origin>`. */
const RUN_HEADER = '# measure-ordinary-load';

/** An http or https URL's origin - no user, path or query - or null. */
function httpOrigin(value) {
  try {
    const url = new URL(value);

    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The origin `cleanup` calls: the one the sessions file's run headers name,
 * which `--app-origin` (`given`), when there is one, must be. So a file of a
 * local run is never cleaned against production, which would answer `404`
 * for every session and so have each recorded `deleted` while it is still
 * alive where it was made. It refuses a file whose runs name more than one
 * origin, no one origin being right for all its sessions; a run header that
 * names no http or https origin; and a file with no run header unless
 * `--app-origin` is given.
 */
export function cleanupOrigin(text, given) {
  const recorded = new Set();

  for (const raw of String(text).split('\n')) {
    const line = raw.trim();

    if (!line.startsWith(`${RUN_HEADER} `)) {
      continue;
    }

    const parts = line.split(' ');
    const origin = parts.length === 5 ? httpOrigin(parts[4]) : null;

    if (origin === null) {
      throw new Error('a run header in the sessions file names no http or https origin');
    }

    recorded.add(origin);
  }

  if (recorded.size > 1) {
    throw new Error(
      `the sessions file records runs against ${[...recorded].join(' and ')}: ` +
        "clean each origin's sessions from a file of its own",
    );
  }

  const [fromFile] = recorded;

  if (given === undefined) {
    if (fromFile === undefined) {
      throw new Error('the sessions file names no origin in a run header: give --app-origin');
    }

    return fromFile;
  }

  const origin = httpOrigin(given);

  if (origin === null) {
    throw new Error('--app-origin is not an http or https origin');
  }

  if (fromFile !== undefined && origin !== fromFile) {
    throw new Error(
      `--app-origin ${origin} is not ${fromFile}, the origin the sessions file's runs name`,
    );
  }

  return origin;
}

/**
 * The delay before a page's next realtime connection, as the frontend's
 * `nextRetryDelay` gives it (D079): 1 s, doubled after every connection that
 * did not last, at most 15 s, and 1 s again after one that lasted 30 s. A page
 * that loads starts from nothing, so a reload starts the sequence again.
 */
export function nextRetryDelay(previousDelayMs, connectionLifetimeMs) {
  if (connectionLifetimeMs >= HEALTHY_CONNECTION_MS) {
    return FIRST_RETRY_MS;
  }

  return Math.min(Math.max(previousDelayMs * 2, FIRST_RETRY_MS), MAX_RETRY_MS);
}

/** Appends `<verb> <id>` to the sessions file, at once and synchronously, when there is one. */
export function recordSession(file, verb, id) {
  if (file) {
    appendFileSync(file, `${verb} ${id}\n`);
  }
}

/**
 * What a production run plans to ask of one address in its busiest minute,
 * against the published limits, and every way it would exceed 80 % of one -
 * the realtime connections included, 12 of 16 - or the TLS connections this
 * Mac's path to production carries (`problems`, empty when the run may go).
 * A profile that is not one (`profileProblems`) and any figure that is not a
 * finite number of at least 0 are problems too, so that nothing the plan
 * cannot count passes as within it.
 */
export function productionBudget({ pageUsers, ciUsers, apiSockets, profile = PROFILE }) {
  // A CI run's first webhook goes at once, the others an interval apart.
  const ciLoopMs = (profile.ciWebhooks - 1) * profile.ciIntervalMs + profile.ciPauseMs;
  const ciLoopsPerMinute = ciUsers === 0 ? 0 : Math.ceil(60_000 / Math.max(1, ciLoopMs));
  const reloadsPerMinute = Math.ceil(60_000 / Math.max(1, profile.reloadMinMs));
  // A page load and every `ready` read the session and its list: four calls
  // a load, the first load and the reloads, and at the end a count and a
  // deletion. A CI loop: a first wait, at most three more, and a deletion.
  const calls = pageUsers * (4 + 4 * reloadsPerMinute + 2) + ciUsers * ciLoopsPerMinute * 5;
  const creations = pageUsers + ciUsers * ciLoopsPerMinute;
  const webhooksInFlight =
    Math.ceil((pageUsers * 1_000) / Math.max(1, profile.webhookIntervalMs)) * 2 + ciUsers;
  const tlsConnections = pageUsers + apiSockets + webhooksInFlight;
  const problems = profileProblems(profile);

  for (const [name, figure] of Object.entries({
    'page users': pageUsers,
    'CI runs': ciUsers,
    'API calls in flight': apiSockets,
    'session creations in a minute': creations,
    'API calls in a minute': calls,
    'TLS connections': tlsConnections,
  })) {
    if (!(Number.isFinite(figure) && figure >= 0)) {
      problems.push(`${name} ${figure}, not a finite number of at least 0`);
    }
  }

  if (pageUsers > PRODUCTION_PAGE_USERS_MAX) {
    problems.push(
      `${pageUsers} page users hold more than ${PRODUCTION_PAGE_USERS_MAX} realtime connections, ` +
        `80 % of the ${PUBLISHED_LIMITS.realtimeConnections} an address may: the rest are for a ` +
        "reload's new connection and for pages open in other browsers behind the address",
    );
  }

  if (creations > PUBLISHED_LIMITS.creationsPerMinute * BUDGET_SHARE) {
    problems.push(`${creations} session creations in a minute, over 80 % of 60`);
  }

  if (calls > PUBLISHED_LIMITS.callsPerMinute * BUDGET_SHARE) {
    problems.push(`${calls} API calls in a minute, over 80 % of 1200`);
  }

  if (apiSockets > PUBLISHED_LIMITS.callsInFlight * BUDGET_SHARE) {
    problems.push(`${apiSockets} API calls in flight, over 80 % of 128`);
  }

  if (tlsConnections > TLS_CONNECTIONS_MAX) {
    problems.push(`about ${tlsConnections} TLS connections at once, over ${TLS_CONNECTIONS_MAX}`);
  }

  return {
    perMinute: { creations, calls },
    callsInFlightAtMost: apiSockets,
    realtimeConnections: pageUsers,
    realtimeConnectionsAtMost: PRODUCTION_PAGE_USERS_MAX,
    tlsConnectionsAbout: tlsConnections,
    problems,
  };
}

function statusKey({ status, errorCode, error }) {
  if (status === 0) {
    return `failed ${error ?? 'without an answer'}`;
  }

  return errorCode === undefined || errorCode === null ? String(status) : `${status}/${errorCode}`;
}

function countInto(counts, key, by = 1) {
  counts[key] = (counts[key] ?? 0) + by;
}

/** Whether a report is served well, and every reason it is not. */
export function servedWell(report) {
  const reasons = [];
  const capture = report.webhooks.captureMs.p99;
  const realtime = report.realtime.ms.p99;

  if (report.webhooks.sent === 0) {
    reasons.push('no webhook was sent');
  }

  if (capture === null || !(capture < SERVED_WELL.captureP99Ms)) {
    reasons.push(`capture p99 ${capture} ms, not under ${SERVED_WELL.captureP99Ms} ms`);
  }

  if (report.realtime.tracked > 0 && (realtime === null || realtime > SERVED_WELL.realtimeP99Ms)) {
    reasons.push(`realtime p99 ${realtime} ms, over ${SERVED_WELL.realtimeP99Ms} ms`);
  }

  if (report.realtime.notShown > 0) {
    reasons.push(`${report.realtime.notShown} captured webhooks never shown on their open page`);
  }

  if (report.webhooks.lost > 0) {
    reasons.push(`${report.webhooks.lost} webhooks lost`);
  }

  if (report.webhooks.sessionsNotCounted > 0) {
    reasons.push(`${report.webhooks.sessionsNotCounted} sessions not counted at the end`);
  }

  if (report.errors.total > 0) {
    reasons.push(`${report.errors.total} errors`);
  }

  return { verdict: reasons.length === 0, reasons };
}

/**
 * One report from the workers' raw records: webhooks, realtime, API calls,
 * realtime connections, CI runs, errors, the client's health and the verdict.
 * Latencies are given for the whole run and for the hold alone (`…Hold`);
 * errors, losses and the verdict count the whole run, the ramp included, but
 * not the count and the deletions after it (`final`).
 */
export function buildReport(raws, config) {
  const holdFrom = config.rampMs;
  const holdTo = config.rampMs + config.holdMs;
  const inHold = (startedAt) => startedAt >= holdFrom && startedAt < holdTo;
  const webhooks = raws.flatMap((raw) => raw.webhooks);
  const calls = raws.flatMap((raw) => raw.api);
  const shown = raws.flatMap((raw) => raw.shown);
  const stored = raws.flatMap((raw) => raw.stored);
  const errors = {};

  // Webhooks.
  const captured = webhooks.filter((each) => each.status === 200);
  const webhookStatuses = {};

  for (const each of webhooks) {
    countInto(webhookStatuses, statusKey(each));

    if (each.status !== 200) {
      countInto(errors, `webhook ${statusKey(each)}`);
    }
  }

  const countedSessions = stored.filter((each) => !each.countFailed);
  const lost = countedSessions.reduce((sum, each) => sum + Math.max(0, each.sent - each.stored), 0);

  // API calls.
  const byKind = {};
  const measuredCalls = calls.filter((call) => !FINAL_KINDS.has(call.kind));

  for (const call of calls) {
    const kind = (byKind[call.kind] ??= { count: 0, statuses: {}, ms: [] });

    kind.count += 1;
    countInto(kind.statuses, statusKey(call));
    kind.ms.push(call.ms);

    if (!FINAL_KINDS.has(call.kind) && call.status !== EXPECTED_STATUS[call.kind]) {
      countInto(errors, `api ${call.kind} ${statusKey(call)}`);
    }
  }

  // Realtime connections.
  const ws = { opened: 0, readies: 0, reconnections: 0, closes: {} };

  for (const raw of raws) {
    ws.opened += raw.ws.opened;
    ws.readies += raw.ws.readies;
    ws.reconnections += raw.ws.reconnections;

    for (const [key, count] of Object.entries(raw.ws.closes)) {
      countInto(ws.closes, key, count);
      countInto(errors, `ws ${key}`, count);
    }
  }

  // Realtime: from the webhook's answer to its row on the open page, by an
  // event or by a list read on a `ready`, whichever came first.
  const shownMs = (each) =>
    each.eventMs === null && each.listedMs === null
      ? null
      : Math.min(each.eventMs ?? Infinity, each.listedMs ?? Infinity);
  const shownOnPage = shown.filter((each) => shownMs(each) !== null);

  // The rows that reached their page by a list read alone: what the page was
  // doing at the capture, which load listed them, and those whose event a
  // live, ready connection never carried.
  const listOnly = shown.filter((each) => each.eventMs === null && each.listedMs !== null);
  const listOnlyByState = {};
  const listOnlyByLoad = {};

  for (const each of listOnly) {
    countInto(listOnlyByState, each.state);
    countInto(listOnlyByLoad, each.listedBy ?? 'unknown');
  }

  // The pages: how many were refused a connection, never had one ready, and
  // how long each went without one; the ten that went longest, by user.
  const pages = raws.flatMap((raw) => raw.pages);
  const listOnlyByUser = {};

  for (const each of listOnly) {
    countInto(listOnlyByUser, String(each.user));
  }

  const pageNotes = pages
    .map((page) => ({ ...page, listOnly: listOnlyByUser[String(page.user)] ?? 0 }))
    .filter((page) => page.refusals > 0 || page.listOnly > 0)
    .sort((a, b) => b.notReadyMs - a.notReadyMs || b.listOnly - a.listOnly)
    .slice(0, 10)
    .map((page) => ({ ...page, notReadyMs: round(page.notReadyMs) }));

  // CI runs.
  const ci = { loops: 0, loopsCounted: 0, sessionsCreated: 0, sessionsDeleted: 0 };

  for (const raw of raws) {
    ci.loops += raw.ci.loops;
    ci.loopsCounted += raw.ci.loopsCounted;
  }

  for (const raw of raws) {
    ci.sessionsCreated += raw.sessions.ciCreated;
    ci.sessionsDeleted += raw.sessions.ciDeleted;
  }

  // The client.
  const workers = raws.map((raw) => raw.health);
  const clientProblems = [];

  for (const [index, health] of workers.entries()) {
    if (health.eventLoopDelayMs.p99 > CLIENT_HEALTH.eventLoopP99Ms) {
      clientProblems.push(
        `worker ${index}: event-loop delay p99 ${health.eventLoopDelayMs.p99} ms`,
      );
    }

    if (health.cpuPercent > CLIENT_HEALTH.cpuPercent) {
      clientProblems.push(`worker ${index}: ${health.cpuPercent} % of a CPU`);
    }

    if ((health.scheduleLagMs.p99 ?? 0) > CLIENT_HEALTH.scheduleLagP99Ms) {
      clientProblems.push(`worker ${index}: webhooks ${health.scheduleLagMs.p99} ms late at p99`);
    }
  }

  // What the backend did over the hold, each counted when it was done, so
  // that its CPU over the hold can be fitted against them (#188): the
  // webhooks answered `200`, the `request.received` events that reached their
  // open page, the API calls answered with any status - a failed call was not
  // - and the realtime connections that came `ready`.
  const doneInHold = (doneAt) => doneAt >= holdFrom && doneAt < holdTo;
  const answeredInHold = calls.filter((call) => call.status !== 0 && doneInHold(call.at + call.ms));
  const apiAnsweredByKind = {};

  for (const call of answeredInHold) {
    countInto(apiAnsweredByKind, call.kind);
  }

  const units = {
    holdS: config.holdMs / 1000,
    webhooksCaptured: captured.filter((each) => doneInHold(each.at + each.ms)).length,
    eventsDelivered: shown.filter(
      (each) => each.eventMs !== null && doneInHold(each.at + each.captureMs + each.eventMs),
    ).length,
    apiAnswered: answeredInHold.length,
    apiAnsweredByKind,
    connectionsReady: raws.flatMap((raw) => raw.readyAts ?? []).filter(doneInHold).length,
  };

  const rateLimitRemainingMin = { creations: null, calls: null };

  for (const raw of raws) {
    for (const key of ['creations', 'calls']) {
      const value = raw.rateLimitRemainingMin[key];

      if (
        value !== null &&
        (rateLimitRemainingMin[key] === null || value < rateLimitRemainingMin[key])
      ) {
        rateLimitRemainingMin[key] = value;
      }
    }
  }

  const report = {
    webhooks: {
      sent: webhooks.length,
      statuses: webhookStatuses,
      captureMs: summarize(captured.map((each) => each.ms)),
      captureMsHold: summarize(captured.filter((each) => inHold(each.at)).map((each) => each.ms)),
      captureMsSmall: summarize(captured.filter((each) => !each.large).map((each) => each.ms)),
      captureMsLarge: summarize(captured.filter((each) => each.large).map((each) => each.ms)),
      largeShare:
        webhooks.length === 0
          ? null
          : round((webhooks.filter((each) => each.large).length / webhooks.length) * 100),
      perSecondHold: round(
        webhooks.filter((each) => inHold(each.at)).length / Math.max(1, config.holdMs / 1000),
      ),
      stored: countedSessions.reduce((sum, each) => sum + each.stored, 0),
      answeredNotStored: countedSessions.reduce((sum, each) => sum + each.answeredNotStored, 0),
      lost,
      sessionsCounted: countedSessions.length,
      sessionsNotCounted: stored.length - countedSessions.length,
    },
    realtime: {
      tracked: shown.length,
      shownByEvent: shown.filter((each) => each.eventMs !== null).length,
      shownByListOnly: shown.filter((each) => each.eventMs === null && each.listedMs !== null)
        .length,
      notShown: shown.length - shownOnPage.length,
      ms: summarize(shownOnPage.map(shownMs)),
      msHold: summarize(shownOnPage.filter((each) => inHold(each.at)).map(shownMs)),
      eventMs: summarize(shown.map((each) => each.eventMs).filter((value) => value !== null)),
      fromSendMs: summarize(shownOnPage.map((each) => shownMs(each) + each.captureMs)),
      listOnly: {
        count: listOnly.length,
        ms: summarize(listOnly.map((each) => each.listedMs)),
        byStateAtCapture: listOnlyByState,
        byLoad: listOnlyByLoad,
        missedOnLiveConnection: listOnly.filter((each) => each.missed).length,
      },
      pages: {
        count: pages.length,
        refused: pages.filter((page) => page.refusals > 0).length,
        neverReady: pages.filter((page) => page.readies === 0).length,
        notReadyMs: summarize(pages.map((page) => page.notReadyMs)),
        longestWithoutConnection: pageNotes,
      },
    },
    api: {
      calls: calls.length,
      p99Ms: round(
        percentile(
          measuredCalls
            .filter((call) => call.kind !== 'wait')
            .map((call) => call.ms)
            .sort((a, b) => a - b),
          0.99,
        ),
      ),
      byKind: Object.fromEntries(
        Object.entries(byKind).map(([kind, of]) => [
          kind,
          { count: of.count, statuses: of.statuses, ms: summarize(of.ms) },
        ]),
      ),
      rateLimitRemainingMin,
    },
    ws,
    units,
    ci,
    errors: {
      total: Object.values(errors).reduce((sum, count) => sum + count, 0),
      byKind: errors,
    },
    client: {
      workers,
      healthy: clientProblems.length === 0,
      problems: clientProblems,
      limits: CLIENT_HEALTH,
    },
  };

  return { ...report, servedWell: servedWell(report) };
}

/* ------------------------------------------------------------------------ */
/* The load, run by worker processes.                                       */
/* ------------------------------------------------------------------------ */

const now = () => performance.timeOrigin + performance.now();

async function sleepUntil(at) {
  const wait = at - now();

  if (wait > 0) {
    await sleep(wait);
  }
}

function errorName(error) {
  return error?.code ?? String(error?.message ?? error).slice(0, 80);
}

function createContext(config) {
  const secure = new URL(config.appOrigin).protocol === 'https:';
  const client = secure ? https : http;

  return {
    config,
    client,
    agent: new client.Agent({
      keepAlive: true,
      maxSockets: config.apiSockets,
      timeout: IDLE_SOCKET_MS,
    }),
    sendUntil: config.t0 + config.rampMs + config.holdMs,
    settleUntil: config.t0 + config.rampMs + config.holdMs + config.settleMs,
    webhooks: [],
    api: [],
    shown: [],
    pages: [],
    stored: [],
    scheduleLag: [],
    ws: { opened: 0, readies: 0, reconnections: 0, closes: {} },
    /** When each realtime connection first came `ready`, from `t0`. */
    readyAts: [],
    ci: { loops: 0, loopsCounted: 0 },
    sessions: { created: 0, deleted: 0, ciCreated: 0, ciDeleted: 0 },
    rateLimitRemainingMin: { creations: null, calls: null },
  };
}

function noteRateLimit(ctx, headers) {
  const remaining = Number(headers['x-ratelimit-remaining']);
  const key = headers['x-ratelimit-limit'] === '60' ? 'creations' : 'calls';

  if (headers['x-ratelimit-remaining'] !== undefined && Number.isFinite(remaining)) {
    const before = ctx.rateLimitRemainingMin[key];

    ctx.rateLimitRemainingMin[key] = before === null ? remaining : Math.min(before, remaining);
  }
}

/** One API call, read to its end and recorded under `kind`; a failure is status 0. */
function apiCall(ctx, user, kind, method, pathname, { body, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const { config } = ctx;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const started = now();

  return new Promise((resolve) => {
    let settled = false;
    const done = (answer) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      const result = { kind, at: started - config.t0, ms: now() - started, ...answer };

      ctx.api.push({
        kind,
        at: result.at,
        ms: result.ms,
        status: result.status,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        ...(result.error === undefined ? {} : { error: result.error }),
      });
      resolve(result);
    };
    const request = ctx.client.request(
      new URL(pathname, config.appOrigin),
      {
        method,
        agent: ctx.agent,
        headers: {
          ...(config.perUserAddresses ? { 'x-forwarded-for': user.address } : {}),
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': payload.length }),
        },
      },
      (response) => {
        const chunks = [];

        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;

          try {
            json = text === '' ? null : JSON.parse(text);
          } catch {
            json = null;
          }

          noteRateLimit(ctx, response.headers);

          const status = response.statusCode ?? 0;

          done({
            status,
            json,
            ...(status >= 400 && Number.isInteger(json?.errorCode)
              ? { errorCode: json.errorCode }
              : {}),
          });
        });
        response.on('error', (error) => done({ status: 0, error: errorName(error) }));
      },
    );
    const timer = setTimeout(() => {
      request.destroy(Object.assign(new Error('timed out'), { code: 'TIMEOUT' }));
    }, timeoutMs);

    request.on('error', (error) => done({ status: 0, error: errorName(error) }));
    request.end(payload);
  });
}

/** Creates a session and records its id in the sessions file before anything uses it. */
async function createSession(ctx, user) {
  const answer = await apiCall(ctx, user, 'create', 'POST', '/api/sessions', {
    body: { expiresInSeconds: ctx.config.profile.lifetimeSeconds },
  });
  const id = answer.status === 201 ? answer.json?.id : undefined;

  if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
    return null;
  }

  recordSession(ctx.config.sessionsFile, 'created', id);
  ctx.sessions.created += 1;

  if (user.kind === 'ci') {
    ctx.sessions.ciCreated += 1;
  }

  return id;
}

async function deleteSession(ctx, user, id, kind) {
  const answer = await apiCall(ctx, user, kind, 'DELETE', `/api/sessions/${id}`);

  if (answer.status === 204 || answer.status === 404) {
    recordSession(ctx.config.sessionsFile, 'deleted', id);
  }

  if (answer.status === 204) {
    ctx.sessions.deleted += 1;

    if (user.kind === 'ci') {
      ctx.sessions.ciDeleted += 1;
    }
  }

  return answer;
}

/**
 * One webhook on a connection of its own, as most senders send one: in Part 1
 * straight to the receive listener behind a PROXY v2 header naming the user,
 * otherwise through `receiveOrigin` with nothing added. Answers the status,
 * any `errorCode`, the request id and the milliseconds to the answer's end.
 */
function sendWebhook(ctx, user, sessionId, body) {
  const { config } = ctx;
  const started = now();

  return new Promise((resolve) => {
    let settled = false;
    const done = (answer) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ms: now() - started, answeredAt: now(), ...answer });
      }
    };
    let timer;

    if (config.perUserAddresses) {
      const receive = new URL(config.receiveOrigin);
      const socket = net.connect(Number(receive.port || 80), receive.hostname);
      const chunks = [];
      const finish = () => {
        const answer = parseHttpAnswer(Buffer.concat(chunks));

        done({
          status: answer.status,
          id: answer.headers['x-qa-tools-request-id'],
          ...(answer.errorCode === undefined ? {} : { errorCode: answer.errorCode }),
          ...(answer.status === 0 ? { error: 'closed without an answer' } : {}),
        });
      };

      timer = setTimeout(() => {
        socket.destroy();
        done({ status: 0, error: 'TIMEOUT' });
      }, WEBHOOK_TIMEOUT_MS);
      socket.on('connect', () => {
        socket.write(proxyHeader(user.address, socket.localPort));
        socket.write(
          `POST /s/${sessionId} HTTP/1.1\r\nHost: hook.qa-tools.test\r\nConnection: close\r\n` +
            `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
        );
        socket.write(body);
      });
      socket.on('data', (chunk) => {
        chunks.push(chunk);

        // Timed once the answer is whole; the server then closes the
        // connection, which keeps its TIME_WAIT on the server's side.
        if (!settled && parseHttpAnswer(Buffer.concat(chunks)).complete) {
          finish();
        }
      });
      socket.on('error', (error) => {
        if (chunks.length === 0) {
          done({ status: 0, error: errorName(error) });
        }
      });
      socket.on('close', finish);
      socket.setTimeout(WEBHOOK_TIMEOUT_MS + 5_000, () => socket.destroy());

      return;
    }

    const url = new URL(`/s/${sessionId}`, config.receiveOrigin);
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          connection: 'close',
        },
      },
      (response) => {
        const chunks = [];

        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          const errorCode =
            status >= 400
              ? /"errorCode":(\d{1,6})/.exec(Buffer.concat(chunks).toString('utf8'))?.[1]
              : undefined;

          done({
            status,
            id: response.headers['x-qa-tools-request-id'],
            ...(errorCode === undefined ? {} : { errorCode: Number(errorCode) }),
          });
        });
        response.on('error', (error) => done({ status: 0, error: errorName(error) }));
      },
    );

    timer = setTimeout(() => {
      request.destroy(Object.assign(new Error('timed out'), { code: 'TIMEOUT' }));
    }, WEBHOOK_TIMEOUT_MS);
    request.on('error', (error) => done({ status: 0, error: errorName(error) }));
    request.end(body);
  });
}

/** Sends a user's webhook `seq` and records it; answers its id when it was captured. */
async function webhook(ctx, user, sessionId, seq, next, plannedAt) {
  const size = webhookSize(user.index, seq, next, ctx.config.profile);
  const body = webhookBody(size, user.index, seq);
  const sentAt = now();

  if (plannedAt !== undefined) {
    ctx.scheduleLag.push(sentAt - plannedAt);
  }

  const answer = await sendWebhook(ctx, user, sessionId, body);

  ctx.webhooks.push({
    kind: user.kind,
    large: size === ctx.config.profile.largeBytes,
    at: sentAt - ctx.config.t0,
    ms: answer.ms,
    status: answer.status,
    ...(answer.errorCode === undefined ? {} : { errorCode: answer.errorCode }),
    ...(answer.error === undefined ? {} : { error: answer.error }),
  });

  return { ...answer, sentAt, id: answer.status === 200 ? answer.id : undefined };
}

function listIds(answer) {
  return answer.status === 200 && Array.isArray(answer.json)
    ? answer.json.map((item) => item?.id).filter((id) => typeof id === 'string')
    : null;
}

/**
 * A session page as the frontend keeps one (`apps/frontend/src/pages/
 * SessionPage.tsx`, `api/realtime.ts`): when it loads, the session and its
 * list read together and its realtime connection opened at once; both read
 * again on every `ready` (D077, D133); a connection the server ends or
 * refuses opened again after `nextRetryDelay` (D079), never one refused for
 * its session (D076). A reload is a page that leaves and a new one that
 * loads: the old connection closed as a browser closes a page's connections
 * when it leaves it, its close not waited for unless `reloadAwaitsClose`, and
 * nothing it still carries read; the new page starts its delays afresh.
 *
 * What the page was doing at a moment is its `state()`: `ready` (its
 * connection told it `ready`), `connecting` (a connection not ready yet),
 * `waiting` (none, a retry due), `reloading` (none, between a reload's close
 * and its new connection) or `closed` (none and none due). Each row listed is
 * kept with the load that listed it first: `page load` or `ready`.
 */
function sessionPage(ctx, user, sessionId) {
  const { config } = ctx;
  const events = new Map();
  const listed = new Map();
  const url =
    `${config.appOrigin.replace(/^http/, 'ws')}/ws/${sessionId}?${REALTIME_EVENTS_PARAM}=` +
    encodeURIComponent(NEGOTIABLE_EVENT_TYPES.join(','));
  const options = config.perUserAddresses
    ? { headers: { 'x-forwarded-for': user.address } }
    : undefined;
  const loads = new Set();
  const notes = { user: user.index, connections: 0, refusals: 0, readies: 0, notReadyMs: 0 };
  /** The connection the page holds, if any. */
  let current = null;
  let retry = null;
  let retryDelay = 0;
  let reloading = false;
  let stopped = false;
  let openedAt = null;
  let readySince = null;
  let readyMs = 0;

  async function load(by) {
    const [, list] = await Promise.all([
      apiCall(ctx, user, 'sessionRead', 'GET', `/api/sessions/${sessionId}`),
      apiCall(ctx, user, 'list', 'GET', `/api/sessions/${sessionId}/requests`),
    ]);
    const at = now();

    for (const id of listIds(list) ?? []) {
      if (!listed.has(id)) {
        listed.set(id, { at, by });
      }
    }
  }

  function tracked(promise) {
    loads.add(promise);
    void promise.finally(() => loads.delete(promise));

    return promise;
  }

  /** The page's connection is no longer ready: the time it was is counted. */
  function notReady() {
    if (readySince !== null) {
      readyMs += now() - readySince;
      readySince = null;
    }
  }

  function connect() {
    retry = null;

    if (stopped) {
      return;
    }

    const ws =
      options === undefined
        ? new globalThis.WebSocket(url)
        : new globalThis.WebSocket(url, options);
    const connection = { ws, openedAt: null, readyAt: null, endedAt: null, left: false };

    connection.closed = new Promise((resolve) => {
      connection.markClosed = resolve;
    });
    current = connection;
    notes.connections += 1;
    ws.addEventListener('open', () => {
      connection.openedAt = now();
      ctx.ws.opened += 1;
    });
    ws.addEventListener('message', (message) => {
      // A page that has left reads nothing more.
      if (connection.left) {
        return;
      }

      const at = now();
      let event;

      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }

      if (event?.type === 'ready') {
        ctx.ws.readies += 1;
        notes.readies += 1;

        if (connection.readyAt === null) {
          connection.readyAt = at;
          readySince = at;
          ctx.readyAts.push(at - config.t0);
        }

        tracked(load('ready'));
      } else if (event?.type === 'request.received' && typeof event.data?.id === 'string') {
        if (!events.has(event.data.id)) {
          events.set(event.data.id, at);
        }
      }
    });
    ws.addEventListener('error', () => undefined);
    ws.addEventListener('close', (event) => {
      connection.endedAt ??= now();
      connection.markClosed();

      if (connection.left) {
        return;
      }

      if (current === connection) {
        current = null;
        notReady();
      }

      if (stopped) {
        return;
      }

      if (connection.openedAt === null) {
        notes.refusals += 1;
      }

      countInto(
        ctx.ws.closes,
        connection.openedAt === null ? 'failed before open' : `close ${event.code}`,
      );

      // A refusal of the session itself is not retried (D076).
      if (event.code === 4404 || event.code === 4410) {
        return;
      }

      retryDelay = nextRetryDelay(
        retryDelay,
        connection.openedAt === null ? 0 : now() - connection.openedAt,
      );
      ctx.ws.reconnections += 1;
      retry = setTimeout(connect, retryDelay);
    });
  }

  /** The page leaves: its retry dropped, its connection closed and no longer read. */
  function leave() {
    clearTimeout(retry);
    retry = null;

    const connection = current;

    current = null;
    notReady();

    if (connection === null) {
      return Promise.resolve();
    }

    connection.left = true;
    connection.endedAt ??= now();
    connection.ws.close();

    return Promise.race([connection.closed, sleep(5_000)]);
  }

  /** A page loads: its delays from nothing, its load and its connection at once. */
  async function arrive() {
    retryDelay = 0;

    const loading = tracked(load('page load'));

    connect();
    await loading;
  }

  return {
    events,
    listed,
    notes,
    state() {
      if (current !== null) {
        return current.readyAt === null ? 'connecting' : 'ready';
      }

      if (reloading) {
        return 'reloading';
      }

      return retry === null ? 'closed' : 'waiting';
    },
    /** The connection the page holds, if any, for a capture's record. */
    connection() {
      return current;
    },
    async open() {
      openedAt = now();
      await arrive();
    },
    async reload() {
      reloading = true;

      const closing = leave();

      if (config.profile.reloadAwaitsClose) {
        await closing;
      }

      reloading = false;
      await arrive();
    },
    async stop() {
      stopped = true;
      await leave();
      await Promise.all([...loads]);
      notes.notReadyMs = Math.max(0, now() - (openedAt ?? now()) - readyMs);
    },
  };
}

/**
 * Whether a row that reached its page by a list read alone should have come
 * by an event: the page's connection was ready before the webhook was sent,
 * so the server was watching the session for it, and that connection stayed
 * open 2 s after the capture.
 */
export function missedOnLiveConnection(connection, sentAt, answeredAt) {
  return (
    connection !== null &&
    connection.readyAt !== null &&
    connection.readyAt <= sentAt &&
    (connection.endedAt === null || connection.endedAt - answeredAt >= SERVED_WELL.realtimeP99Ms)
  );
}

async function pageUser(ctx, user) {
  const { config } = ctx;
  const { profile } = config;
  const next = random(config.seed + user.index);

  await sleepUntil(config.t0 + user.startMs);

  if (now() >= ctx.sendUntil) {
    return;
  }

  const sessionId = await createSession(ctx, user);

  if (sessionId === null) {
    return;
  }

  const page = sessionPage(ctx, user, sessionId);
  const answered = [];
  const sends = [];
  const begun = now();

  await page.open();

  // Reloads now and then, until the sending ends.
  const reloads = (async () => {
    let at = begun;

    for (;;) {
      at += profile.reloadMinMs + next() * (profile.reloadMaxMs - profile.reloadMinMs);

      if (at >= ctx.sendUntil) {
        return;
      }

      await sleepUntil(at);

      if (now() >= ctx.sendUntil) {
        return;
      }

      await page.reload();
    }
  })();

  // A webhook every interval from a phase of its own, sent on time whatever
  // the server answers, as a sender's system sends them.
  const phase = next() * profile.webhookIntervalMs;

  for (let seq = 0; ; seq += 1) {
    const plannedAt = begun + phase + seq * profile.webhookIntervalMs;

    if (plannedAt >= ctx.sendUntil) {
      break;
    }

    await sleepUntil(plannedAt);

    if (now() >= ctx.sendUntil) {
      break;
    }

    sends.push(
      webhook(ctx, user, sessionId, seq, next, plannedAt).then((answer) => {
        if (answer.id !== undefined) {
          // What the page was doing when the answer came.
          answered.push({ ...answer, state: page.state(), connection: page.connection() });
        }
      }),
    );
  }

  await Promise.all(sends);
  await reloads;

  // The settle: until every captured webhook is on the page, or its end.
  while (
    now() < ctx.settleUntil &&
    answered.some((each) => !page.events.has(each.id) && !page.listed.has(each.id))
  ) {
    await sleep(100);
  }

  await page.stop();
  ctx.pages.push(page.notes);

  for (const each of answered) {
    const eventAt = page.events.get(each.id);
    const listed = page.listed.get(each.id);

    ctx.shown.push({
      at: each.sentAt - config.t0,
      captureMs: each.ms,
      eventMs: eventAt === undefined ? null : eventAt - each.answeredAt,
      listedMs: listed === undefined ? null : listed.at - each.answeredAt,
      user: user.index,
      state: each.state,
      listedBy: listed?.by ?? null,
      missed:
        eventAt === undefined &&
        missedOnLiveConnection(each.connection, each.sentAt, each.answeredAt),
    });
  }

  // The count at the end, then the deletion.
  const count = await apiCall(
    ctx,
    user,
    'count',
    'GET',
    `/api/sessions/${sessionId}/requests?order=asc&limit=1000`,
  );
  const ids = listIds(count);
  const storedIds = new Set(ids ?? []);

  ctx.stored.push({
    kind: 'page',
    sent: sends.length,
    stored: storedIds.size,
    answeredNotStored: answered.filter((each) => !storedIds.has(each.id)).length,
    countFailed: ids === null,
  });
  await deleteSession(ctx, user, sessionId, 'cleanup');
}

async function ciUser(ctx, user) {
  const { config } = ctx;
  const { profile } = config;
  const next = random(config.seed + user.index);
  const loopMs = profile.ciWebhooks * profile.ciIntervalMs;
  let seq = 0;

  await sleepUntil(config.t0 + user.startMs);

  // A loop starts only while its webhooks can all be sent before the end.
  while (now() + loopMs <= ctx.sendUntil) {
    ctx.ci.loops += 1;

    const sessionId = await createSession(ctx, user);

    if (sessionId === null) {
      await sleep(profile.ciPauseMs);
      continue;
    }

    // The test waits for its webhooks before it triggers them.
    const firstWait = apiCall(
      ctx,
      user,
      'wait',
      'GET',
      `/api/sessions/${sessionId}/requests?order=asc&limit=1000&wait=${profile.ciWaitSeconds}`,
      { timeoutMs: profile.ciWaitSeconds * 1000 + CALL_TIMEOUT_MS },
    );
    const answered = [];
    let sent = 0;
    let slot = now();

    for (let index = 0; index < profile.ciWebhooks; index += 1) {
      await sleepUntil(slot);

      const answer = await webhook(ctx, user, sessionId, seq, next);

      seq += 1;
      sent += 1;

      if (answer.id !== undefined) {
        answered.push(answer.id);
      }

      slot = Math.max(slot + profile.ciIntervalMs, now());
    }

    // Lists with `wait` until every webhook has come, three more at most.
    const seen = new Set();
    let after = null;
    let counted = false;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const answer =
        attempt === 0
          ? await firstWait
          : await apiCall(
              ctx,
              user,
              'wait',
              'GET',
              `/api/sessions/${sessionId}/requests?order=asc&limit=1000&wait=${profile.ciWaitSeconds}` +
                (after === null ? '' : `&after=${after}`),
              { timeoutMs: profile.ciWaitSeconds * 1000 + CALL_TIMEOUT_MS },
            );
      const ids = listIds(answer);

      if (ids !== null) {
        counted = true;

        for (const id of ids) {
          seen.add(id);
        }

        if (ids.length > 0) {
          after = ids.at(-1);
        }
      }

      if (seen.size >= sent) {
        break;
      }
    }

    ctx.stored.push({
      kind: 'ci',
      sent,
      stored: seen.size,
      answeredNotStored: answered.filter((id) => !seen.has(id)).length,
      countFailed: !counted,
    });

    if (counted) {
      ctx.ci.loopsCounted += 1;
    }

    await deleteSession(ctx, user, sessionId, 'delete');
    await sleep(profile.ciPauseMs);
  }
}

/** A worker: its users, then its records and its health on stdout as one JSON line. */
async function runWorker() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const { config, users } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const ctx = createContext(config);
  const delay = monitorEventLoopDelay({ resolution: LOOP_SAMPLE_MS });
  let health = null;

  // Ctrl-C or SIGTERM: stop sending and settling now; what was created is
  // still counted and deleted.
  const stop = () => {
    ctx.sendUntil = Math.min(ctx.sendUntil, now());
    ctx.settleUntil = Math.min(ctx.settleUntil, now());
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await sleepUntil(config.t0);
  delay.enable();

  const cpuBefore = process.cpuUsage();
  const wallBefore = now();
  const takeHealth = () => {
    if (health !== null) {
      return;
    }

    const cpu = process.cpuUsage(cpuBefore);
    const wallMs = Math.max(1, now() - wallBefore);

    health = {
      users: users.length,
      // Beyond the sampling interval, which the histogram's readings include.
      eventLoopDelayMs: {
        p50: round(Math.max(0, delay.percentile(50) / 1e6 - LOOP_SAMPLE_MS)),
        p99: round(Math.max(0, delay.percentile(99) / 1e6 - LOOP_SAMPLE_MS)),
        max: round(Math.max(0, delay.max / 1e6 - LOOP_SAMPLE_MS)),
      },
      cpuPercent: round(((cpu.user + cpu.system) / 1000 / wallMs) * 100),
      scheduleLagMs: summarize(ctx.scheduleLag),
      rssMiB: round(process.memoryUsage().rss / MIB),
    };
  };
  // Health is read when the settle ends, before the count and the deletions.
  const healthTimer = setTimeout(takeHealth, Math.max(0, ctx.settleUntil - now()));

  await Promise.all(
    users.map((user) => (user.kind === 'page' ? pageUser(ctx, user) : ciUser(ctx, user))),
  );
  clearTimeout(healthTimer);
  takeHealth();
  delay.disable();
  ctx.agent.destroy();

  process.stdout.write(
    `${JSON.stringify({
      webhooks: ctx.webhooks,
      api: ctx.api,
      shown: ctx.shown,
      pages: ctx.pages,
      stored: ctx.stored,
      ws: ctx.ws,
      ci: ctx.ci,
      sessions: ctx.sessions,
      rateLimitRemainingMin: ctx.rateLimitRemainingMin,
      readyAts: ctx.readyAts,
      health,
    })}\n`,
  );
}

function spawnWorker(config, users, children) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, 'worker'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const chunks = [];

    children.push(child);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error(`a worker ended (${code ?? signal}) without its records`));
      }
    });
    child.stdin.end(JSON.stringify({ config, users }));
  });
}

function emit(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/* ------------------------------------------------------------------------ */
/* Realtime connections held apart from the load.                           */
/* ------------------------------------------------------------------------ */

/** One call from this machine's own address: its status and its JSON body, if any. */
function callJson(origin, method, pathname, body) {
  const url = new URL(pathname, origin);
  const client = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));

  return new Promise((resolve) => {
    const request = client.request(
      url,
      {
        method,
        agent: false,
        headers:
          payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': payload.length },
      },
      (response) => {
        const chunks = [];

        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let json = null;

          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // Not JSON: the status says enough.
          }

          resolve({ status: response.statusCode ?? 0, json });
        });
        response.on('error', () => resolve({ status: 0, json: null }));
      },
    );
    const timer = setTimeout(() => request.destroy(new Error('timed out')), CALL_TIMEOUT_MS);

    request.on('error', () => resolve({ status: 0, json: null }));
    request.on('close', () => clearTimeout(timer));
    request.end(payload);
  });
}

/** A session of its own for connections held apart from the load, or null. */
async function heldSession(origin, sessionsFile) {
  const answer = await callJson(origin, 'POST', '/api/sessions', { expiresInSeconds: 3_600 });
  const id = answer.status === 201 ? answer.json?.id : undefined;

  if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
    return null;
  }

  recordSession(sessionsFile, 'created', id);

  return id;
}

async function deleteHeldSession(origin, sessionsFile, id) {
  const { status } = await callJson(origin, 'DELETE', `/api/sessions/${id}`);

  if (status === 204 || status === 404) {
    recordSession(sessionsFile, 'deleted', id);
  }

  return status;
}

/**
 * `count` realtime connections to one session, opened at once from this
 * machine's own address, each settled once it is `ready`, refused before it
 * opened, closed after, or not settled within 10 s: those counts, and a
 * `close` that closes every one.
 */
async function holdConnections(origin, sessionId, count) {
  const url = `${origin.replace(/^http/, 'ws')}/ws/${sessionId}`;
  const sockets = [];
  const outcomes = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise((resolve) => {
          const ws = new globalThis.WebSocket(url);
          let opened = false;
          const timer = setTimeout(() => resolve('timed out'), 10_000);

          sockets.push(ws);
          ws.addEventListener('open', () => {
            opened = true;
          });
          ws.addEventListener('message', (message) => {
            try {
              if (JSON.parse(String(message.data))?.type === 'ready') {
                clearTimeout(timer);
                resolve('ready');
              }
            } catch {
              // Not an event this needs.
            }
          });
          ws.addEventListener('error', () => undefined);
          ws.addEventListener('close', () => {
            clearTimeout(timer);
            resolve(opened ? 'closed' : 'refused');
          });
        }),
    ),
  );
  const counts = {};

  for (const outcome of outcomes) {
    countInto(counts, outcome);
  }

  return {
    counts,
    async close() {
      for (const ws of sockets) {
        ws.close();
      }

      await sleep(500);
    },
  };
}

/**
 * Whether every one of the address's realtime places is free: `count`
 * connections opened at once to a session of its own, then closed and the
 * session deleted; when any was refused, again 65 s later, by when the
 * server's heartbeat has cut a connection that stopped answering (30 s
 * between pings, D079). Never against production, whose places it would take.
 */
export async function places(appOrigin, count = PUBLISHED_LIMITS.realtimeConnections) {
  if (/(^|\.)qa-tools\.ru\.?$/i.test(new URL(appOrigin).hostname)) {
    throw new Error('places never runs against production');
  }

  if (!Number.isInteger(count) || count < 1 || count > 64) {
    throw new Error(`places opens 1 to 64 connections, not ${count}`);
  }

  const check = async () => {
    const id = await heldSession(appOrigin);

    if (id === null) {
      return { created: false };
    }

    const held = await holdConnections(appOrigin, id, count);

    await held.close();

    return { ...held.counts, deleted: await deleteHeldSession(appOrigin, undefined, id) };
  };
  const first = await check();

  if ((first.ready ?? 0) === count) {
    return { count, freeAtOnce: true, first };
  }

  await sleep(65_000);

  const later = await check();

  return { count, freeAtOnce: false, first, after65s: later };
}

/**
 * The load: the users planned and shared among the workers, the phases
 * printed as they begin, and the report once every worker has ended.
 */
async function runLoad(config) {
  const users = planUsers(config.pageUsers, config.ciUsers, config.rampMs);
  const workers = Math.max(1, Math.min(config.workers, users.length));
  // Pages open in other browsers behind the address, there before the load.
  let others = null;

  if (config.otherPages > 0) {
    const id = await heldSession(config.appOrigin, config.sessionsFile);

    others =
      id === null
        ? { id, held: { counts: { 'not created': config.otherPages }, close: async () => {} } }
        : { id, held: await holdConnections(config.appOrigin, id, config.otherPages) };
  }

  const t0 = now() + 3_000;
  const full = { ...config, t0, seed: config.seed ?? 186 };
  const startedAt = new Date(t0).toISOString();
  const children = [];
  const timers = [];

  if (config.sessionsFile) {
    appendFileSync(
      config.sessionsFile,
      `${RUN_HEADER} ${config.mode} ${startedAt} ${config.appOrigin}\n`,
    );
  }

  for (const [phase, at] of [
    ['ramp', t0],
    ['hold', t0 + config.rampMs],
    ['settle', t0 + config.rampMs + config.holdMs],
    ['final', t0 + config.rampMs + config.holdMs + config.settleMs],
  ]) {
    timers.push(setTimeout(() => emit({ phase, at: new Date(at).toISOString() }), at - now()));
  }

  let interrupted = 0;
  const interrupt = (signal) => {
    interrupted += 1;

    if (interrupted > 1) {
      process.exit(130);
    }

    // A terminal's Ctrl-C reaches the workers too; a SIGTERM is passed on.
    if (signal === 'SIGTERM') {
      for (const child of children) {
        child.kill('SIGTERM');
      }
    }
  };

  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);

  if (config.crashAfterS > 0) {
    // A rehearsal of a crash: every process stops dead, its sessions left.
    timers.push(
      setTimeout(() => {
        for (const child of children) {
          child.kill('SIGKILL');
        }

        process.exit(3);
      }, config.crashAfterS * 1000),
    );
  }

  const raws = await Promise.all(
    Array.from({ length: workers }, (_, worker) =>
      spawnWorker(
        full,
        users.filter((user) => user.index % workers === worker),
        children,
      ),
    ),
  );

  for (const timer of timers) {
    clearTimeout(timer);
  }

  emit({ phase: 'done', at: new Date().toISOString() });

  if (others !== null) {
    await others.held.close();

    if (others.id !== null) {
      await deleteHeldSession(config.appOrigin, config.sessionsFile, others.id);
    }
  }

  const created = raws.reduce((sum, raw) => sum + raw.sessions.created, 0);
  const deleted = raws.reduce((sum, raw) => sum + raw.sessions.deleted, 0);

  return {
    mode: config.mode,
    startedAt,
    endedAt: new Date().toISOString(),
    interrupted: interrupted > 0,
    appOrigin: config.appOrigin,
    receiveOrigin: config.receiveOrigin,
    addresses: config.perUserAddresses ? 'one per user, 198.18.0.0/15' : "this machine's own",
    step: {
      pageUsers: config.pageUsers,
      ciUsers: config.ciUsers,
      users: config.pageUsers + config.ciUsers,
      workers,
    },
    times: {
      rampS: config.rampMs / 1000,
      holdS: config.holdMs / 1000,
      settleS: config.settleMs / 1000,
      t0: Math.round(t0),
      holdFrom: Math.round(t0 + config.rampMs),
      holdTo: Math.round(t0 + config.rampMs + config.holdMs),
    },
    profile: config.profile,
    servedWellDefinition: SERVED_WELL,
    ...(config.budget === undefined ? {} : { budget: config.budget }),
    ...(others === null
      ? {}
      : { otherPages: { asked: config.otherPages, atStart: others.held.counts } }),
    ...buildReport(raws, full),
    sessions: {
      created,
      deleted,
      left: created - deleted,
      file: config.sessionsFile ?? null,
    },
  };
}

/**
 * `captures`, inside the client for `--cpu-prof`: one user from its own
 * address creates a session, keeps quiet for `quietS` seconds, sends `count`
 * webhooks of 2 KiB one after another, each awaited, and deletes the session.
 * The quiet window and the series are timed by the wall clock, as the probe's
 * lines are, so that what one capture takes can be read from both.
 */
async function captureSeries(config, count, quietS) {
  const ctx = createContext({ ...config, t0: now() });
  const [user] = planUsers(1, 0, 0);
  const sessionId = await createSession(ctx, user);

  if (sessionId === null) {
    ctx.agent.destroy();
    throw new Error('captures: the session was not created');
  }

  const quiet = { from: Date.now() };

  await sleep(quietS * 1000);
  quiet.to = Date.now();

  const series = { from: Date.now() };
  const ms = [];
  let captured = 0;

  for (let seq = 0; seq < count; seq += 1) {
    const answer = await sendWebhook(ctx, user, sessionId, webhookBody(2_048, user.index, seq));

    captured += answer.status === 200 ? 1 : 0;
    ms.push(answer.ms);
  }

  series.to = Date.now();
  await deleteSession(ctx, user, sessionId, 'cleanup');
  ctx.agent.destroy();

  return { count, captured, quiet, series, captureMs: summarize(ms) };
}

/* ------------------------------------------------------------------------ */
/* Cleanup after a crash.                                                   */
/* ------------------------------------------------------------------------ */

function call(origin, method, pathname) {
  const url = new URL(pathname, origin);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const request = client.request(url, { method, agent: false }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
      response.on('error', () => resolve(0));
    });
    const timer = setTimeout(() => request.destroy(new Error('timed out')), CALL_TIMEOUT_MS);

    request.on('error', () => resolve(0));
    request.on('close', () => clearTimeout(timer));
    request.end();
  });
}

/**
 * Deletes every session the file records as created and not deleted, then
 * reads every session it ever recorded: the counts, never an id. It calls the
 * origin the file's runs name, `appOrigin` having to be that one when given
 * (`cleanupOrigin`), and calls nothing when it refuses.
 */
export async function cleanup(file, appOrigin) {
  const text = readFileSync(file, 'utf8');
  const origin = cleanupOrigin(text, appOrigin);
  const { pending, created, skipped } = pendingSessions(text);
  const result = { pending: pending.length, deleted: 0, alreadyGone: 0, failed: {}, skipped };

  for (const id of pending) {
    const status = await call(origin, 'DELETE', `/api/sessions/${id}`);

    if (status === 204 || status === 404) {
      recordSession(file, 'deleted', id);
      result[status === 204 ? 'deleted' : 'alreadyGone'] += 1;
    } else {
      countInto(result.failed, String(status));
    }
  }

  const still = {};

  for (const id of created) {
    countInto(still, String(await call(origin, 'GET', `/api/sessions/${id}`)));
  }

  return {
    ...result,
    recorded: created.length,
    readAfter: still,
    left: created.length - (still['404'] ?? 0),
  };
}

/* ------------------------------------------------------------------------ */
/* `--cpu-prof`: where the backend's CPU goes, and what one capture takes.  */
/* ------------------------------------------------------------------------ */

/** The probe's fields (`measure-ordinary-load.probe.mjs`), each a finite number. */
const PROBE_FIELDS = ['t', 'loops', 'events'];
/** The longest probe line read; the probe writes about 120 bytes. */
const PROBE_LINE_MAX = 1_000;
/** The longest statement text kept from `pg_stat_statements`. */
const STATEMENT_TEXT_MAX = 300;
/** The longest script URL a profile's function or module is named by. */
const URL_SHOWN_MAX = 120;

/**
 * The probe's lines, in the order of their wall clock: every line a JSON
 * object whose fields are all finite numbers; anything else skipped.
 */
export function parseProbeLines(text) {
  const lines = [];

  for (const line of String(text).split('\n')) {
    if (line.length === 0 || line.length > PROBE_LINE_MAX) {
      continue;
    }

    let parsed;

    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      PROBE_FIELDS.every((field) => Number.isFinite(parsed[field]))
    ) {
      lines.push(Object.fromEntries(PROBE_FIELDS.map((field) => [field, parsed[field]])));
    }
  }

  return lines.sort((a, b) => a.t - b.t);
}

/** The probe's reading at wall time `t`, between the two lines around it; null outside them. */
function probeAt(lines, t) {
  if (lines.length === 0 || t < lines[0].t || t > lines.at(-1).t) {
    return null;
  }

  let low = 0;
  let high = lines.length - 1;

  while (high - low > 1) {
    const middle = (low + high) >> 1;

    if (lines[middle].t <= t) {
      low = middle;
    } else {
      high = middle;
    }
  }

  const a = lines[low];
  const b = lines[high];
  const share = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);

  return Object.fromEntries(
    PROBE_FIELDS.map((field) => [field, a[field] + (b[field] - a[field]) * share]),
  );
}

/**
 * What the probe saw from `from` to `to`, wall milliseconds: the event loop's
 * turns and the events it handled; null when the window is not within the
 * probe's lines.
 */
export function probeWindow(lines, from, to) {
  const a = probeAt(lines, from);
  const b = probeAt(lines, to);

  if (a === null || b === null || to <= from) {
    return null;
  }

  return {
    seconds: round((to - from) / 1000),
    loops: Math.round(b.loops - a.loops),
    events: Math.round(b.events - a.events),
  };
}

/**
 * The CPU profile's clock against the wall clock: what to add to a wall time
 * in microseconds to read it on the profile's. The probe writes its last line
 * as the backend exits, and `node --cpu-prof` ends its profile a few
 * milliseconds later, so the two ends are taken for the same moment; null
 * when either is missing. The profile's clock is the monotonic one V8 keeps,
 * whose origin no other reading in the process is known to share.
 */
export function profileOffset(profile, lines) {
  if (lines.length === 0 || !Number.isFinite(profile?.endTime)) {
    return null;
  }

  return profile.endTime - lines.at(-1).t * 1000;
}

/** A script's URL as a profile's names show it: from the backend's root, or its package's. */
function shownUrl(url) {
  const modules = url.lastIndexOf('node_modules/');
  const shown = modules !== -1 ? url.slice(modules) : url.replace(/^file:\/\/\/app\//, '');

  return shown.length > URL_SHOWN_MAX ? `…${shown.slice(-URL_SHOWN_MAX)}` : shown;
}

/**
 * The module a profile node's script belongs to: a package under
 * `node_modules` by its name (`pg`, `@fastify/websocket`), the application's
 * own files and Node's (`node:internal/…`) by their paths, and a node with no
 * script by its name - V8's `(garbage collector)`, `(program)`, `(idle)` - or
 * `(native)`.
 */
export function moduleOf(url, functionName = '') {
  const text = String(url ?? '');

  if (text === '') {
    return /^\(.{1,40}\)$/.test(functionName) ? functionName : '(native)';
  }

  const modules = text.lastIndexOf('node_modules/');

  if (modules !== -1) {
    const [scope = '', name = ''] = text.slice(modules + 'node_modules/'.length).split('/', 2);
    const named = scope.startsWith('@') ? `${scope}/${name}` : scope;

    return named.length > URL_SHOWN_MAX ? `…${named.slice(-URL_SHOWN_MAX)}` : named;
  }

  return shownUrl(text);
}

/**
 * Where a CPU profile (`node --cpu-prof`) spent its time, by self time: each
 * sample is charged with the time to the next, and only the samples within
 * `window` (`from` and `to` on the profile's clock, microseconds) when one is
 * given. The `top` functions - by name, script and line - and modules
 * (`moduleOf`) with the most, in milliseconds and as a share of the time not
 * idle; V8's `(idle)` is counted apart. Throws on anything that is not a
 * profile; a node or sample that does not fit is skipped.
 */
export function summarizeCpuProfile(profile, window = null, top = 10) {
  if (
    profile === null ||
    typeof profile !== 'object' ||
    !Array.isArray(profile.nodes) ||
    !Array.isArray(profile.samples) ||
    !Array.isArray(profile.timeDeltas) ||
    profile.samples.length !== profile.timeDeltas.length ||
    !Number.isFinite(profile.startTime)
  ) {
    throw new Error('not a CPU profile: nodes, samples, timeDeltas and startTime');
  }

  const nodes = new Map();

  for (const node of profile.nodes) {
    const frame = node?.callFrame;

    if (!Number.isInteger(node?.id) || frame === null || typeof frame !== 'object') {
      continue;
    }

    const name =
      typeof frame.functionName === 'string' && frame.functionName !== ''
        ? frame.functionName.slice(0, URL_SHOWN_MAX)
        : '(anonymous)';
    const url = typeof frame.url === 'string' ? frame.url : '';
    const line = Number.isInteger(frame.lineNumber) ? frame.lineNumber + 1 : 0;

    nodes.set(node.id, {
      fn: url === '' ? name : `${name} ${shownUrl(url)}:${line}`,
      module: moduleOf(url, name),
    });
  }

  const functions = new Map();
  const modules = new Map();
  let at = profile.startTime;
  let sampled = 0;

  for (let index = 0; index < profile.samples.length; index += 1) {
    const delta = profile.timeDeltas[index];
    const next = index + 1 < profile.samples.length ? profile.timeDeltas[index + 1] : 0;

    if (Number.isFinite(delta)) {
      at += delta;
    }

    if (!Number.isFinite(next) || next < 0) {
      continue;
    }

    const node = nodes.get(profile.samples[index]);

    if (node === undefined || (window !== null && (at < window.from || at >= window.to))) {
      continue;
    }

    functions.set(node.fn, (functions.get(node.fn) ?? 0) + next);
    modules.set(node.module, (modules.get(node.module) ?? 0) + next);
    sampled += next;
  }

  const idle = modules.get('(idle)') ?? 0;
  const busy = sampled - idle;
  const ranked = (totals) =>
    [...totals]
      .filter(([name]) => name !== '(idle)')
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([name, us]) => ({
        name,
        ms: round(us / 1000),
        percent: busy > 0 ? round((us / busy) * 100) : null,
      }));

  return {
    sampledMs: round(sampled / 1000),
    idleMs: round(idle / 1000),
    busyMs: round(busy / 1000),
    functions: ranked(functions),
    modules: ranked(modules),
  };
}

/**
 * Where the CPU went over a step's hold: the profile's samples from
 * `hold.from` to `hold.to`, wall milliseconds as the report's times are,
 * read on the profile's clock in microseconds through the probe's last line
 * (`profileOffset`); null when that offset cannot be had.
 */
export function holdCpu(profile, lines, hold) {
  const offset = profileOffset(profile, lines);

  if (offset === null) {
    return null;
  }

  return summarizeCpuProfile(profile, {
    from: hold.from * 1000 + offset,
    to: hold.to * 1000 + offset,
  });
}

/**
 * `pg_stat_statements`' counts as the script reads them through `psql -At`,
 * one `calls<TAB>statement` a line, the statement's spaces folded; a line of
 * any other shape skipped, and a statement cut to 300 characters.
 */
export function parseStatementCounts(text) {
  const counts = [];

  for (const line of String(text).split('\n')) {
    const tab = line.indexOf('\t');

    if (tab < 1 || tab > 15 || !/^\d+$/.test(line.slice(0, tab))) {
      continue;
    }

    const query = line.slice(tab + 1, tab + 1 + STATEMENT_TEXT_MAX).trim();

    if (query !== '') {
      counts.push({ calls: Number(line.slice(0, tab)), query });
    }
  }

  return counts.sort((a, b) => b.calls - a.calls);
}

/** Statements of the measurement itself, or of the health check, not of a capture. */
function capturesStatement(query) {
  return !/pg_stat_statements/i.test(query) && !/^select \$1$/i.test(query);
}

/**
 * What one capture takes, from a series of `count` captures sent one after
 * another to a backend with nothing else to do: the statements it ran - each
 * statement `pg_stat_statements` counted over the series at least once every
 * two captures, per capture, the health check's `SELECT 1` and the reads of
 * the counts themselves left out, and the rest listed apart - and the event
 * loop's turns and events beyond what the quiet window before the series
 * shows the idle backend doing in as long.
 */
export function perCapture({ count, quiet, series, statements }) {
  const each = statements.filter((statement) => capturesStatement(statement.query));
  const per = each.filter((statement) => statement.calls * 2 >= count);
  const beyondIdle = (field) =>
    quiet === null || series === null || quiet.seconds <= 0 || count <= 0
      ? null
      : round((series[field] - (quiet[field] / quiet.seconds) * series.seconds) / count);

  return {
    captures: count,
    statements:
      count > 0 ? round(per.reduce((sum, statement) => sum + statement.calls, 0) / count) : null,
    byStatement: per.map((statement) => ({
      perCapture: count > 0 ? round(statement.calls / count) : null,
      query: statement.query,
    })),
    otherStatements: each
      .filter((statement) => statement.calls * 2 < count)
      .map((statement) => ({ calls: statement.calls, query: statement.query })),
    loopTurns: beyondIdle('loops'),
    loopEvents: beyondIdle('events'),
  };
}

/* ------------------------------------------------------------------------ */
/* Part 1's orchestration, on the operator's machine.                       */
/* ------------------------------------------------------------------------ */

const COMPOSE_FILE = fileURLToPath(new URL('measure-ordinary-load.compose.yml', import.meta.url));
/** Added by `--cpu-prof`: the backend profiled and probed, PostgreSQL counting statements. */
const CPU_PROF_FILE = fileURLToPath(new URL('measure-ordinary-load.cpu-prof.yml', import.meta.url));
const BACKEND_ADDRESS = '10.186.0.3';
const INNER_SCRIPT = '/repo/scripts/measure-ordinary-load.mjs';

/** Part 1's origins: the backend's two listeners, straight. */
const DIRECT = {
  app: `http://${BACKEND_ADDRESS}:3000`,
  receive: `http://${BACKEND_ADDRESS}:3001`,
};
/**
 * Through the front, Traefik, as production's hosts are reached: the client
 * resolves both names to Traefik, which serves its own default certificate,
 * so the client does not verify it (`NODE_TLS_REJECT_UNAUTHORIZED`, set for
 * the client's runs through the front alone).
 */
const FRONT = {
  app: 'https://qa-tools.test:8443',
  receive: 'https://hook.qa-tools.test:8443',
};
const FRONT_ENV = { NODE_TLS_REJECT_UNAUTHORIZED: '0' };

/** The image `--image` names and the CPUs `--backend-cpus` gives; every call the same. */
const composeEnv = {};
/** The compose files of the run: the project's, and `--cpu-prof`'s beside it when given. */
const composeFiles = [COMPOSE_FILE];

/** `docker compose` and its files, with the `front` profile always named. */
function composeArgs() {
  return ['compose', ...composeFiles.flatMap((file) => ['-f', file]), '--profile', 'front'];
}

/**
 * `docker compose` on this project, with the `front` profile always named:
 * every `up` names its services, so Traefik starts only where it is asked
 * for, and `down` removes it with the rest.
 */
function compose(args, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      [...composeArgs(), ...args],
      { env: { ...process.env, ...composeEnv }, timeout: timeoutMs, maxBuffer: 256 * MIB },
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

function dockerSocket() {
  const host = process.env.DOCKER_HOST;

  if (host?.startsWith('unix://')) {
    return Promise.resolve(host.slice('unix://'.length));
  }

  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      (error, stdout) => {
        if (error || !stdout.trim().startsWith('unix://')) {
          reject(new Error(`no Docker socket: ${error?.message ?? stdout.trim()}`));
        } else {
          resolve(stdout.trim().slice('unix://'.length));
        }
      },
    );
  });
}

/**
 * The Docker Engine's stats stream for one container, a sample a second, read
 * from outside it: its CPU time, throttling and memory, timed by the daemon.
 */
function streamStats(socketPath, id) {
  const samples = [];
  const request = http.request(
    { socketPath, path: `/containers/${id}/stats?stream=true` },
    (response) => {
      const lines = readline.createInterface({ input: response });

      // Stopping the stream aborts the answer, which its reader passes on.
      lines.on('error', () => undefined);
      lines.on('line', (line) => {
        try {
          const stats = JSON.parse(line);

          samples.push({
            at: Date.parse(stats.read),
            cpuNs: stats.cpu_stats?.cpu_usage?.total_usage ?? 0,
            periods: stats.cpu_stats?.throttling_data?.periods ?? 0,
            throttled: stats.cpu_stats?.throttling_data?.throttled_periods ?? 0,
            memory: stats.memory_stats?.usage ?? 0,
            anon: stats.memory_stats?.stats?.anon ?? 0,
          });
        } catch {
          // A line cut by the end of the stream.
        }
      });
      response.on('error', () => undefined);
    },
  );

  request.on('error', () => undefined);
  request.end();

  return { samples, stop: () => request.destroy() };
}

/**
 * A container's samples over the hold (CPU, in % of one CPU: the mean and the
 * busiest second; the share of its CFS periods throttled) and over the whole
 * step (memory, the largest reading of the cgroup's use and of its `anon`).
 */
export function summarizeSamples(samples, from, to) {
  const hold = samples.filter((sample) => sample.at >= from && sample.at <= to);
  const seconds = [];

  for (let index = 1; index < hold.length; index += 1) {
    const elapsedNs = (hold[index].at - hold[index - 1].at) * 1e6;

    if (elapsedNs > 0) {
      seconds.push(((hold[index].cpuNs - hold[index - 1].cpuNs) / elapsedNs) * 100);
    }
  }

  const first = hold[0];
  const last = hold.at(-1);
  const spanNs = first && last ? (last.at - first.at) * 1e6 : 0;
  const periods = first && last ? last.periods - first.periods : 0;

  return {
    samples: samples.length,
    samplesHold: hold.length,
    cpuPercentHold: {
      mean: spanNs > 0 ? round(((last.cpuNs - first.cpuNs) / spanNs) * 100) : null,
      peak: seconds.length === 0 ? null : round(Math.max(...seconds)),
    },
    throttledPercentHold:
      periods > 0 ? round(((last.throttled - first.throttled) / periods) * 100) : null,
    memoryMiB: {
      peak: samples.length === 0 ? null : round(Math.max(...samples.map((s) => s.memory)) / MIB),
      anonPeak: samples.length === 0 ? null : round(Math.max(...samples.map((s) => s.anon)) / MIB),
    },
  };
}

/**
 * A container's CPU over the quiet window before the load, in % of one CPU,
 * from the first sample to the last: what it spends with nothing to do.
 */
export function idleCpu(samples) {
  if (samples.length < 2) {
    return { seconds: 0, cpuPercent: null };
  }

  return {
    seconds: round((samples.at(-1).at - samples[0].at) / 1000),
    cpuPercent: summarizeSamples(samples, samples[0].at, samples.at(-1).at).cpuPercentHold.mean,
  };
}

/** How many captures `--cpu-prof`'s series sends one after another. */
const CAPTURE_SERIES = 500;

/**
 * `captures --count`: how many webhooks the series sends, a whole number of
 * 1 to 1000 - a session keeps its newest 1000 - and 500 unless given.
 */
export function captureCount(value) {
  if (value === undefined) {
    return CAPTURE_SERIES;
  }

  const text = String(value);

  if (!/^\d{1,4}$/.test(text) || Number(text) < 1 || Number(text) > MAX_REQUESTS_PER_SESSION) {
    throw new Error(
      `--count takes a whole number from 1 to ${MAX_REQUESTS_PER_SESSION}, not ${JSON.stringify(text.slice(0, 40))}`,
    );
  }

  return Number(text);
}

/**
 * `--backend-cpus`: the backend's CPU limit, production's 0.5 unless given -
 * #188 runs its first step not served well once more at 1. A plain decimal of
 * 0.1 to 8 CPUs, as Docker takes it; anything else is refused.
 */
export function backendCpus(value) {
  if (value === undefined) {
    return '0.5';
  }

  const text = String(value);

  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text) || Number(text) < 0.1 || Number(text) > 8) {
    throw new Error(
      `--backend-cpus takes a number of CPUs from 0.1 to 8, not ${JSON.stringify(text.slice(0, 40))}`,
    );
  }

  return text;
}

/**
 * The backend's CPU limit as its cgroup has it, in CPUs: `cpu.max`'s quota
 * over its period, `50000 100000` 0.5, so that the report reads back what
 * `--backend-cpus` gave (#261); null for `max`, no limit, and for anything
 * that is not a quota and a period of whole microseconds.
 */
export function cpuLimit(text) {
  const match = /^(max|\d{1,15}) (\d{1,15})\n?$/.exec(String(text));

  if (match === null || match[1] === 'max') {
    return null;
  }

  const quota = Number(match[1]);
  const period = Number(match[2]);

  return quota > 0 && period > 0 ? Math.round((quota / period) * 1000) / 1000 : null;
}

/**
 * The backend's cgroup once the step has ended: `memory.peak`, `cpu.stat` and
 * `cpu.max`, read by one `sh` in its container - the only process run there
 * but the backend's, and after the step's settle.
 */
async function backendCgroup() {
  try {
    const text = await compose([
      'exec',
      '-T',
      'backend',
      'sh',
      '-c',
      'cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/cpu.stat; cat /sys/fs/cgroup/cpu.max',
    ]);
    const field = (name) => Number(new RegExp(`^${name} (\\d+)$`, 'm').exec(text)?.[1] ?? NaN);

    return {
      memoryPeakMiB: round(Number(text.split('\n')[0]) / MIB),
      cpuSeconds: round(field('usage_usec') / 1e6),
      throttledPeriods: field('nr_throttled'),
      periods: field('nr_periods'),
      throttledSeconds: round(field('throttled_usec') / 1e6),
      // `cpu.max` is the last line: one of a quota and a period, or `max` and a period.
      cpuLimit: cpuLimit(text.trimEnd().split('\n').at(-1)),
    };
  } catch (error) {
    return { read: false, error: String(error.message).slice(0, 200) };
  }
}

/** How the backend's container ended the step, and what its log says at warning and above. */
async function backendState() {
  let state;

  try {
    const text = (await compose(['ps', '-a', '--format', 'json', 'backend'])).trim();
    const entries = text.startsWith('[')
      ? JSON.parse(text)
      : text
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));

    state = entries[0] ? { state: entries[0].State, exitCode: entries[0].ExitCode ?? null } : null;
  } catch (error) {
    state = { read: false, error: String(error.message).slice(0, 200) };
  }

  const logs = (await compose(['logs', '--no-color', 'backend']).catch(() => '')).split('\n');
  const messages = {};
  let warnings = 0;
  let errors = 0;

  for (const line of logs) {
    const level = Number(/"level":(\d+)/.exec(line)?.[1] ?? 0);

    if (level >= 40) {
      if (level >= 50) {
        errors += 1;
      } else {
        warnings += 1;
      }

      // The message alone: a log line can hold a URL, and a URL a session id.
      countInto(messages, `${level} ${/"msg":"([^"]{0,120})/.exec(line)?.[1] ?? '?'}`);
    }
  }

  return { ...state, logWarnings: warnings, logErrors: errors, logMessages: messages };
}

/** Where the client asks whether the backend is ready, straight, on the project's network. */
const READYZ = 'http://backend:3000/readyz';
/** How long the backend has to answer `/readyz` with `200`, and how often it is asked. */
const READY_WITHIN_MS = 120_000;
const READY_EVERY_MS = 500;

/**
 * The readiness wait, run by `node -e` with the URL, the deadline and the
 * interval in milliseconds as its arguments: the URL asked until it answers
 * `200`, again every interval after each answer or failure; exit 0 then, or
 * exit 1 once the deadline has passed, naming the URL and its last answer or
 * error on stderr. CommonJS, as `node -e` reads it, and nothing but Node's own.
 */
export const READINESS_SCRIPT = `
const [url, deadlineText, intervalText] = process.argv.slice(1);
const within = Number(deadlineText);
const deadline = Date.now() + within;
const interval = Number(intervalText);
let last = 'no answer';
const attempt = () => {
  const left = Math.max(100, Math.min(5000, deadline - Date.now()));
  fetch(url, { signal: AbortSignal.timeout(left) })
    .then(
      (answer) => {
        answer.body?.cancel().catch(() => {});
        if (answer.status === 200) {
          process.exit(0);
        }
        last = 'answered ' + answer.status;
      },
      (error) => {
        const cause = error.cause ?? {};
        const why = [cause.code, cause.message].filter(Boolean).join(' ');
        last = error.name + ': ' + error.message + (why ? ' (' + why + ')' : '');
      },
    )
    .then(() => {
      if (Date.now() >= deadline) {
        process.stderr.write(url + ' did not answer 200 within ' + within / 1000 + ' s; last: ' + last + '\\n');
        process.exit(1);
      }
      setTimeout(attempt, interval);
    });
};
attempt();
`;

/**
 * The command that waits for the backend to be ready, run in the client
 * container (#261): `node -e` with `READINESS_SCRIPT`, asking `url` every
 * `intervalMs` until it answers `200`, for at most `deadlineMs`. From the
 * client, so that no process but the backend's runs in its cgroup.
 */
export function readinessWait(
  url = READYZ,
  { deadlineMs = READY_WITHIN_MS, intervalMs = READY_EVERY_MS } = {},
) {
  return ['node', '-e', READINESS_SCRIPT, url, String(deadlineMs), String(intervalMs)];
}

/**
 * Starts the project afresh: a new database, migrated, a new backend - running,
 * then ready, as the client finds it (`readinessWait`) - the client, and
 * Traefik in front when `front`. Nothing checks the backend after that.
 */
async function freshProject({ front = false } = {}) {
  await compose(['down', '--volumes', '--remove-orphans'], { timeoutMs: 180_000 });
  await compose(['up', '-d', '--wait', 'postgres', 'client'], { timeoutMs: 180_000 });
  await compose(['up', 'migrate'], { timeoutMs: 180_000 });
  await compose(['up', '-d', '--wait', 'backend'], { timeoutMs: 180_000 });
  await compose(['exec', '-T', 'client', ...readinessWait()], {
    timeoutMs: READY_WITHIN_MS + 60_000,
  });

  if (front) {
    await compose(['up', '-d', '--wait', 'traefik'], { timeoutMs: 180_000 });
  }
}

/**
 * Runs this script inside the client container, with `env` set there; its
 * phases to stderr, its report back.
 */
function inClient(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        ...composeArgs(),
        'exec',
        '-T',
        ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
        'client',
        'node',
        INNER_SCRIPT,
        ...args,
      ],
      { env: { ...process.env, ...composeEnv }, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const lines = readline.createInterface({ input: child.stdout });
    let report = null;
    const other = [];

    lines.on('line', (line) => {
      let parsed;

      try {
        parsed = JSON.parse(line);
      } catch {
        other.push(line);

        return;
      }

      if (parsed.report !== undefined) {
        report = parsed.report;
      } else {
        console.error(JSON.stringify(parsed));
      }
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, report, other }));
  });
}

function innerArgs(step, options, origins, extra = []) {
  return [
    '--page',
    String(step.pageUsers),
    '--ci',
    String(step.ciUsers),
    '--ramp',
    String(options.ramp),
    '--hold',
    String(options.hold),
    '--settle',
    String(options.settle),
    '--app-origin',
    origins.app,
    '--receive-origin',
    origins.receive,
    ...(options.profile ? ['--profile', options.profile] : []),
    ...extra,
  ];
}

/** Whether all 16 of the client's address's realtime places are free, through the front. */
async function placesThroughFront() {
  return (await inClient(['places', '--app-origin', FRONT.app], FRONT_ENV)).report;
}

/** A step's name in the files of a run: `step-12p2` for 12 + 2. */
function stepName(label) {
  return `step-${label.replace('+', 'p')}`;
}

/**
 * The directories `--cpu-prof DIR` already holds for steps of the run, which
 * `local` refuses before any container starts (#261): a step's profile is
 * copied into its directory, and a second profile there would leave the step
 * unread after its whole hold. Nothing is deleted.
 */
export function profileDirsInUse(dir, steps) {
  return steps
    .map((step) => stepName(step.label))
    .filter((name) => existsSync(path.join(dir, name)));
}

/**
 * One step on a fresh project, its containers' CPU and memory read through
 * the stats stream: Part 1's, each user from its own address straight to the
 * backend, or with `front` from the client's one address through Traefik,
 * `places` after it. Its result, and the backend's container for a profile.
 */
async function runStep(step, options, socketPath, { front = false } = {}) {
  await freshProject({ front });

  const services = ['backend', 'postgres', 'client', ...(front ? ['traefik'] : [])];
  const ids = {};

  for (const service of services) {
    ids[service] = (await compose(['ps', '-q', service])).trim();
  }

  const streams = Object.fromEntries(
    Object.entries(ids).map(([service, id]) => [service, streamStats(socketPath, id)]),
  );

  // A quiet window before the load: what each container spends with nothing
  // to do, the fixed part of the fit (#188) - the backend's own timers alone,
  // nothing else running in its cgroup since #261.
  await sleep(options.idle * 1000);

  const idleSamples = Object.fromEntries(
    Object.entries(streams).map(([service, stream]) => [service, stream.samples.length]),
  );
  const idle = (service) => idleCpu(streams[service].samples.slice(0, idleSamples[service]));
  const { code, report, other } = front
    ? await inClient(
        [
          'client',
          ...innerArgs(step, options, FRONT, ['--other-pages', String(options.otherPages ?? 0)]),
        ],
        FRONT_ENV,
      )
    : await inClient([
        'client',
        ...innerArgs(step, options, DIRECT, [
          '--addresses',
          'per-user',
          '--sessions-file',
          `/tmp/dev186-sessions-${stepName(step.label)}.txt`,
        ]),
      ]);

  for (const stream of Object.values(streams)) {
    stream.stop();
  }

  if (report === null) {
    throw new Error(
      `step ${step.label}: the client ended ${code} without a report: ${other.join('\n').slice(0, 2_000)}`,
    );
  }

  const from = report.times.holdFrom;
  const to = report.times.holdTo;
  const result = {
    label: step.label,
    backendCpus: Number(options.backendCpus),
    ...report,
    backend: {
      ...(await backendCgroup()),
      sampled: summarizeSamples(streams.backend.samples, from, to),
      idle: idle('backend'),
      ...(await backendState()),
    },
    postgres: { ...summarizeSamples(streams.postgres.samples, from, to), idle: idle('postgres') },
    clientContainer: summarizeSamples(streams.client.samples, from, to),
    ...(front
      ? {
          traefik: summarizeSamples(streams.traefik.samples, from, to),
          placesAfter: await placesThroughFront(),
        }
      : {}),
  };

  // The profile, when asked for, is read by the caller once this is written.
  return { result, backendId: ids.backend };
}

/** `psql` on the project's database, its rows one a line, its columns apart by a tab. */
function psql(sql) {
  return compose([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'webhook_inspector',
    '-d',
    'webhook_inspector',
    '-v',
    'ON_ERROR_STOP=1',
    '-AtF',
    '\t',
    '-c',
    sql,
  ]);
}

/**
 * After a step run with `--cpu-prof`: a series of captures one after another
 * with `pg_stat_statements` counting from nothing, then the backend stopped
 * with SIGTERM, so that `node --cpu-prof` writes its profile; the profile and
 * the probe's lines copied to `DIR/<step>/`, and their summary - where the
 * CPU went over the hold, the event loop over the hold and over the series,
 * and what one capture takes - written beside them and returned.
 */
async function profileStep(step, options, backendId, report) {
  const dir = path.join(options.cpuProf, stepName(step.label));

  await psql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  await psql('SELECT pg_stat_statements_reset()');

  const series = await inClient([
    'captures',
    '--count',
    String(CAPTURE_SERIES),
    '--quiet',
    '10',
    '--app-origin',
    DIRECT.app,
    '--receive-origin',
    DIRECT.receive,
    '--addresses',
    'per-user',
  ]);

  if (series.report === null) {
    throw new Error(`captures ended ${series.code} without a report: ${series.other.join('\n')}`);
  }

  const statements = parseStatementCounts(
    await psql(
      "SELECT calls, regexp_replace(query, '\\s+', ' ', 'g') FROM pg_stat_statements " +
        'WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())',
    ),
  );

  await compose(['stop', '-t', '120', 'backend'], { timeoutMs: 300_000 });
  mkdirSync(dir, { recursive: true });
  await new Promise((resolve, reject) => {
    execFile('docker', ['cp', `${backendId}:/tmp/qa-profile/.`, dir], (error) =>
      error ? reject(new Error(`docker cp: ${error.message}`)) : resolve(),
    );
  });

  const profiles = readdirSync(dir).filter((name) => name.endsWith('.cpuprofile'));

  if (profiles.length !== 1) {
    throw new Error(`${dir}: ${profiles.length} CPU profiles, not one`);
  }

  const lines = parseProbeLines(readFileSync(path.join(dir, 'probe.jsonl'), 'utf8'));
  const profile = JSON.parse(readFileSync(path.join(dir, profiles[0]), 'utf8'));
  const hold = { from: report.times.holdFrom, to: report.times.holdTo };
  const holdWindow = probeWindow(lines, hold.from, hold.to);
  const { quiet, series: sent } = series.report;
  const summary = {
    profile: path.join(dir, profiles[0]),
    probe: path.join(dir, 'probe.jsonl'),
    hold: {
      cpu: holdCpu(profile, lines, hold),
      loop: holdWindow,
      loopTurnsPerWebhook:
        holdWindow === null || report.units.webhooksCaptured === 0
          ? null
          : round(holdWindow.loops / report.units.webhooksCaptured),
    },
    series: {
      ...series.report,
      quietLoop: probeWindow(lines, quiet.from, quiet.to),
      seriesLoop: probeWindow(lines, sent.from, sent.to),
    },
  };

  summary.perCapture = perCapture({
    count: series.report.captured,
    quiet: summary.series.quietLoop,
    series: summary.series.seriesLoop,
    statements,
  });
  writeFileSync(path.join(dir, 'profile-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  return summary;
}

/** One line of the summary table. */
function summaryLine(result) {
  return {
    step: result.label,
    users: result.step.users,
    backendCpus: result.backendCpus,
    cpuLimit: result.backend?.cpuLimit ?? null,
    captureMs: result.webhooks.captureMs,
    sent: result.webhooks.sent,
    lost: result.webhooks.lost,
    realtimeMs: result.realtime.ms,
    notShown: result.realtime.notShown,
    apiP99Ms: result.api.p99Ms,
    errors: result.errors.total,
    errorKinds: result.errors.byKind,
    backend: {
      cpuMeanHold: result.backend?.sampled?.cpuPercentHold?.mean ?? null,
      cpuPeakHold: result.backend?.sampled?.cpuPercentHold?.peak ?? null,
      throttledHold: result.backend?.sampled?.throttledPercentHold ?? null,
      memoryPeakMiB: result.backend?.memoryPeakMiB ?? null,
    },
    postgresCpuMeanHold: result.postgres?.cpuPercentHold?.mean ?? null,
    clientHealthy: result.client.healthy,
    servedWell: result.servedWell.verdict,
  };
}

function orchestrationOptions(values) {
  // Refused here, before any container, as the client would refuse it.
  if (values.profile !== undefined) {
    parseProfile(values.profile);
  }

  const cpus = backendCpus(values['backend-cpus']);
  const idle = idleSeconds(values.idle);

  // Every `docker compose` call of the run limits the backend so.
  composeEnv.MEASURE_BACKEND_CPUS = cpus;

  return {
    ramp: Number(values.ramp ?? 60),
    hold: Number(values.hold ?? 180),
    settle: Number(values.settle ?? 15),
    idle,
    backendCpus: cpus,
    profile: values.profile,
    otherPages: Number(values['other-pages'] ?? 0),
    out: values.out ?? path.join(os.tmpdir(), `measure-ordinary-load-${Date.now()}`),
  };
}

async function local(values) {
  const steps = parseSteps(values.steps ?? `${PRODUCTION_PAGE_USERS_MAX}+2,50,100,200,400,800`);
  const options = orchestrationOptions(values);
  const stopAfter = Number(values['stop-after'] ?? 2);

  if (values.image) {
    composeEnv.MEASURE_BACKEND_IMAGE = values.image;
  }

  // Each step profiled and probed: no step of the line, the profiler
  // spending some of the backend's CPU itself. A step directory already
  // there is refused now, before any container, rather than after a hold.
  if (values['cpu-prof'] !== undefined) {
    options.cpuProf = path.resolve(values['cpu-prof']);

    const inUse = profileDirsInUse(options.cpuProf, steps);

    if (inUse.length > 0) {
      throw new Error(
        `--cpu-prof ${options.cpuProf} already holds ${inUse.join(', ')}: name a directory without them`,
      );
    }

    composeFiles.push(CPU_PROF_FILE);
  }

  mkdirSync(options.out, { recursive: true });
  console.error(JSON.stringify({ out: options.out }));

  const socketPath = await dockerSocket();
  const results = [];
  let failedInARow = 0;
  let stopped = null;

  if (!values.image) {
    await compose(['build', 'migrate'], { timeoutMs: 900_000 });
  }

  try {
    for (const step of steps) {
      if (failedInARow >= stopAfter) {
        stopped = `${failedInARow} steps in a row not served well; ${step.label} and later not run`;
        break;
      }

      const { result, backendId } = await runStep(step, options, socketPath);
      const file = path.join(options.out, `${stepName(step.label)}.json`);

      // The step's report first, so that a profile that fails keeps it.
      writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);

      if (options.cpuProf) {
        result.cpuProfile = await profileStep(step, options, backendId, result);
        writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      }

      console.log(JSON.stringify(result));
      results.push(result);
      failedInARow = result.servedWell.verdict ? 0 : failedInARow + 1;
    }
  } finally {
    if (!values.keep) {
      await compose(['down', '--volumes', '--remove-orphans'], { timeoutMs: 180_000 });
    }
  }

  const summary = {
    summary: results.map(summaryLine),
    largestServedWell:
      results
        .filter((each) => each.servedWell.verdict)
        .sort((a, b) => b.step.users - a.step.users)[0]?.label ?? null,
    stopped,
  };

  writeFileSync(path.join(options.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
}

async function rehearse(values) {
  const options = orchestrationOptions({ ramp: 20, hold: 60, settle: 10, ...values });
  const file = '/tmp/dev186-rehearse-sessions.txt';
  const crashFile = '/tmp/dev186-rehearse-crash-sessions.txt';

  if (values.image) {
    composeEnv.MEASURE_BACKEND_IMAGE = values.image;
  }

  mkdirSync(options.out, { recursive: true });

  if (!values.image) {
    await compose(['build', 'migrate'], { timeoutMs: 900_000 });
  }

  const result = {};

  try {
    await freshProject({ front: true });

    // The production mode's own default run, through the front.
    const step = { pageUsers: PRODUCTION_PAGE_USERS_MAX, ciUsers: 2 };
    const run = await inClient(
      ['production', ...innerArgs(step, options, FRONT, ['--sessions-file', file])],
      FRONT_ENV,
    );

    result.run = { exitCode: run.code, report: run.report };
    result.cleanupAfterRun = (
      await inClient(['cleanup', '--sessions-file', file, '--app-origin', FRONT.app], FRONT_ENV)
    ).report;

    const crash = await inClient(
      [
        'production',
        ...innerArgs(step, options, FRONT, ['--sessions-file', crashFile, '--crash-after', '20']),
      ],
      FRONT_ENV,
    );

    result.crash = { exitCode: crash.code };
    result.cleanupAfterCrash = (
      await inClient(
        ['cleanup', '--sessions-file', crashFile, '--app-origin', FRONT.app],
        FRONT_ENV,
      )
    ).report;
    result.cleanupAgain = (
      await inClient(
        ['cleanup', '--sessions-file', crashFile, '--app-origin', FRONT.app],
        FRONT_ENV,
      )
    ).report;
    result.placesAfter = await placesThroughFront();
  } finally {
    if (!values.keep) {
      await compose(['down', '--volumes', '--remove-orphans'], { timeoutMs: 180_000 });
    }
  }

  writeFileSync(path.join(options.out, 'rehearsal.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
}

/**
 * One load from the client's one address through the front, with no budget,
 * measured as a Part 1 step is, and `places` after it.
 */
async function front(values) {
  const options = orchestrationOptions(values);
  const [step] = parseSteps(`${values.page ?? 16}+${values.ci ?? 2}`);

  if (values.image) {
    composeEnv.MEASURE_BACKEND_IMAGE = values.image;
  }

  mkdirSync(options.out, { recursive: true });
  console.error(JSON.stringify({ out: options.out }));

  const socketPath = await dockerSocket();

  if (!values.image) {
    await compose(['build', 'migrate'], { timeoutMs: 900_000 });
  }

  let result;

  try {
    ({ result } = await runStep(step, options, socketPath, { front: true }));
  } finally {
    if (!values.keep) {
      await compose(['down', '--volumes', '--remove-orphans'], { timeoutMs: 180_000 });
    }
  }

  writeFileSync(
    path.join(options.out, `front-${step.label.replace('+', 'p')}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
}

/* ------------------------------------------------------------------------ */
/* The command line.                                                        */
/* ------------------------------------------------------------------------ */

const OPTIONS = {
  steps: { type: 'string' },
  page: { type: 'string' },
  ci: { type: 'string' },
  ramp: { type: 'string' },
  hold: { type: 'string' },
  settle: { type: 'string' },
  out: { type: 'string' },
  image: { type: 'string' },
  keep: { type: 'boolean' },
  'stop-after': { type: 'string' },
  'app-origin': { type: 'string' },
  'receive-origin': { type: 'string' },
  'sessions-file': { type: 'string' },
  addresses: { type: 'string' },
  workers: { type: 'string' },
  profile: { type: 'string' },
  'crash-after': { type: 'string' },
  'other-pages': { type: 'string' },
  count: { type: 'string' },
  idle: { type: 'string' },
  'backend-cpus': { type: 'string' },
  'cpu-prof': { type: 'string' },
  quiet: { type: 'string' },
};

/**
 * A duration option in seconds: a plain decimal - digits, and at most three
 * after a point - of 0 up to `max`, `fallback` unless given; anything else
 * refused, quoting at most 40 characters of it.
 */
function seconds(value, fallback, name, max = Infinity) {
  const text = String(value ?? fallback);
  const number = Number(text);

  if (!/^\d{1,7}(\.\d{1,3})?$/.test(text) || number > max) {
    throw new Error(
      `--${name} takes seconds${max === Infinity ? '' : ` from 0 to ${max}`}, not ${JSON.stringify(text.slice(0, 40))}`,
    );
  }

  return number;
}

/** The longest `--idle` and `--quiet`, an hour, as the profile's delays are (`HOUR_MS`). */
const QUIET_MAX_S = HOUR_MS / 1000;

/** `--idle`: the quiet window before each step's load, 0 to 3600 s, 30 unless given. */
export function idleSeconds(value) {
  return seconds(value, 30, 'idle', QUIET_MAX_S);
}

/** `--quiet`: the quiet before `--cpu-prof`'s series of captures, 0 to 3600 s, 10 unless given. */
export function quietSeconds(value) {
  return seconds(value, 10, 'quiet', QUIET_MAX_S);
}

/** The load's configuration from the command line, for `client` and `production`. */
function loadConfig(command, values) {
  const production = command === 'production';
  const perUserAddresses = values.addresses === 'per-user';
  const profile = values.profile === undefined ? PROFILE : parseProfile(values.profile);
  const pageUsers = Number(values.page ?? (production ? PRODUCTION_PAGE_USERS_MAX : 45));
  const ciUsers = Number(values.ci ?? (production ? 2 : 5));
  const users = pageUsers + ciUsers;
  const config = {
    mode: production ? 'production' : 'local',
    appOrigin:
      values['app-origin'] ?? (production ? PRODUCTION_APP_ORIGIN : 'http://127.0.0.1:3000'),
    receiveOrigin:
      values['receive-origin'] ??
      (production ? PRODUCTION_RECEIVE_ORIGIN : 'http://127.0.0.1:3001'),
    pageUsers,
    ciUsers,
    rampMs: seconds(values.ramp, 60, 'ramp') * 1000,
    holdMs: seconds(values.hold, 180, 'hold') * 1000,
    settleMs: seconds(values.settle, 15, 'settle') * 1000,
    perUserAddresses,
    workers: Number(values.workers ?? (production ? 1 : Math.min(8, Math.ceil(users / 100)))),
    // From one address as production's run, 16; from an address per user, 64.
    apiSockets: perUserAddresses ? 64 : 16,
    sessionsFile: values['sessions-file'] ? path.resolve(values['sessions-file']) : undefined,
    profile,
    crashAfterS: seconds(values['crash-after'], 0, 'crash-after'),
    otherPages: Number(values['other-pages'] ?? 0),
  };

  if (
    !Number.isInteger(pageUsers) ||
    !Number.isInteger(ciUsers) ||
    pageUsers < 0 ||
    ciUsers < 0 ||
    users < 1
  ) {
    throw new Error('--page and --ci take whole numbers, at least one user between them');
  }

  if (
    !Number.isInteger(config.otherPages) ||
    config.otherPages < 0 ||
    config.otherPages > PUBLISHED_LIMITS.realtimeConnections
  ) {
    throw new Error('--other-pages takes a whole number from 0 to 16');
  }

  if (production) {
    if (perUserAddresses) {
      throw new Error(
        "the production mode comes from this machine's one address: no --addresses per-user",
      );
    }

    if (!config.sessionsFile) {
      throw new Error(
        'the production mode needs --sessions-file, where every session it creates is recorded',
      );
    }

    if (config.otherPages > 0) {
      throw new Error('the production mode holds no --other-pages: close them instead');
    }

    config.budget = productionBudget({
      pageUsers,
      ciUsers,
      apiSockets: config.apiSockets,
      profile,
    });

    if (config.budget.problems.length > 0) {
      throw new Error(`over what one address may do: ${config.budget.problems.join('; ')}`);
    }
  }

  if (config.sessionsFile && !existsSync(path.dirname(config.sessionsFile))) {
    throw new Error(`no directory for the sessions file ${config.sessionsFile}`);
  }

  return config;
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  });
  const [command] = positionals;

  if (command === 'worker') {
    await runWorker();
  } else if (command === 'client' || command === 'production') {
    const report = await runLoad(loadConfig(command, values));

    emit({ report });
    process.exitCode = report.servedWell.verdict ? 0 : 1;
  } else if (command === 'cleanup') {
    if (!values['sessions-file']) {
      throw new Error('cleanup needs --sessions-file');
    }

    emit({
      report: await cleanup(path.resolve(values['sessions-file']), values['app-origin']),
    });
  } else if (command === 'captures') {
    emit({
      report: await captureSeries(
        loadConfig('client', { ...values, page: '1', ci: '0' }),
        captureCount(values.count),
        quietSeconds(values.quiet),
      ),
    });
  } else if (command === 'places') {
    emit({
      report: await places(
        values['app-origin'] ?? 'http://127.0.0.1:3000',
        Number(values.count ?? PUBLISHED_LIMITS.realtimeConnections),
      ),
    });
  } else if (command === 'local') {
    await local(values);
  } else if (command === 'rehearse') {
    await rehearse(values);
  } else if (command === 'front') {
    await front(values);
  } else {
    throw new Error(
      'usage: node scripts/measure-ordinary-load.mjs local | production | cleanup | rehearse | front [options]',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
