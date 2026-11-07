/**
 * The ordinary-load measurement of #186, `scripts/measure-ordinary-load.mjs`
 * (D232): its pure parts - the plan of a step, the numbers, the verdict, the
 * production budget, the frontend's reconnection delays, the sessions file
 * and the answer parser, the last two with made-up hostile input at growing
 * sizes - and the script itself run as a child process against the listeners
 * on the task's database for a few seconds: the production mode deleting
 * every session it created, the per-user mode naming each user's own address
 * to the backend, a page refused by its address's realtime limit told apart
 * from an event lost on a live connection, `places`, and `cleanup` deleting
 * what a crash left, calling nothing but `/api/sessions/<id>` and only at the
 * origin the sessions file names. The script's `nextRetryDelay` is held to
 * the frontend's here too. Since #261 the backend's readiness is asked from
 * the client, the wait run here against a stand-in on loopback, and nothing
 * else runs in the backend's container but the cgroup read after the step.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { SESSION_ID_PATTERN } from '@webhook-inspector/shared';
import {
  CLIENT_HEALTH,
  PRODUCTION_PAGE_USERS_MAX,
  PROFILE,
  backendCpus,
  buildReport,
  captureCount,
  cleanupOrigin,
  cpuLimit,
  holdCpu,
  idleCpu,
  idleSeconds,
  missedOnLiveConnection,
  moduleOf,
  nextRetryDelay,
  parseHttpAnswer,
  parseProbeLines,
  parseProfile,
  parseStatementCounts,
  parseSteps,
  pendingSessions,
  perCapture,
  percentile,
  places,
  planUsers,
  probeWindow,
  productionBudget,
  profileDirsInUse,
  profileOffset,
  profileProblems,
  proxyHeader,
  quietSeconds,
  random,
  readinessWait,
  servedWell,
  summarize,
  summarizeCpuProfile,
  summarizeSamples,
  userAddress,
  webhookBody,
  webhookSize,
  type Report,
  type WorkerRecords,
} from '../../../scripts/measure-ordinary-load.mjs';
// The frontend's own delay, which the script copies. Compared here rather
// than in the frontend's suite: the frontend image builds - `tsc` included -
// from `apps/frontend` and `packages/shared` alone, where the script is not,
// and the backend image runs no `tsc` at all (D051).
import { nextRetryDelay as frontendRetryDelay } from '../../frontend/src/api/realtime.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { createRealtimePlaces } from './modules/realtime/connection-places.ts';
import { buildTestServers, type TestServers } from './testing/servers.ts';
import { withinBound } from './testing/timing.ts';

const SCRIPT = fileURLToPath(
  new URL('../../../scripts/measure-ordinary-load.mjs', import.meta.url),
);
const ID = 'A'.repeat(43);
const OTHER_ID = 'b'.repeat(42) + '9';

describe('measure-ordinary-load: the plan of a step', () => {
  it('gives each user an address of its own in 198.18.0.0/15, never .0.0, and refuses past the range', () => {
    assert.equal(userAddress(0), '198.18.0.1');
    assert.equal(userAddress(254), '198.18.0.255');
    assert.equal(userAddress(255), '198.18.1.0');
    assert.equal(userAddress(65_534), '198.18.255.255');
    assert.equal(userAddress(65_535), '198.19.0.0');
    assert.equal(userAddress(131_069), '198.19.255.254');
    assert.throws(() => userAddress(131_070), RangeError);
    assert.throws(() => userAddress(-1), RangeError);
    assert.throws(() => userAddress(1.5), RangeError);

    const addresses = new Set(Array.from({ length: 5_000 }, (_, index) => userAddress(index)));

    assert.equal(addresses.size, 5_000);
  });

  it('spreads the CI runs evenly among the page users and the starts evenly over the ramp', () => {
    const users = planUsers(720, 80, 60_000);

    assert.equal(users.length, 800);
    assert.equal(users.filter((user) => user.kind === 'ci').length, 80);
    assert.equal(new Set(users.map((user) => user.address)).size, 800);

    // One CI run in every block of ten.
    for (let block = 0; block < 80; block += 1) {
      const kinds = users.slice(block * 10, block * 10 + 10).map((user) => user.kind);

      assert.equal(kinds.filter((kind) => kind === 'ci').length, 1, `block ${block}`);
    }

    assert.equal(users[0]?.startMs, 0);
    assert.ok((users.at(-1)?.startMs ?? 0) < 60_000);
    assert.ok(
      users.every((user, index) => index === 0 || user.startMs >= users[index - 1]!.startMs),
    );
    assert.deepEqual(
      planUsers(16, 2, 1_000)
        .map((user) => user.kind)
        .filter((kind) => kind === 'ci').length,
      2,
    );
    assert.deepEqual(planUsers(1, 0, 60_000), [
      { index: 0, kind: 'page', address: '198.18.0.1', startMs: 0 },
    ]);
  });

  it('reads the steps as N users, a tenth CI, or P+C, and refuses anything else', () => {
    assert.deepEqual(parseSteps('16+2, 50,100,200,400,800'), [
      { label: '16+2', pageUsers: 16, ciUsers: 2, users: 18 },
      { label: '50', pageUsers: 45, ciUsers: 5, users: 50 },
      { label: '100', pageUsers: 90, ciUsers: 10, users: 100 },
      { label: '200', pageUsers: 180, ciUsers: 20, users: 200 },
      { label: '400', pageUsers: 360, ciUsers: 40, users: 400 },
      { label: '800', pageUsers: 720, ciUsers: 80, users: 800 },
    ]);
    assert.deepEqual(parseSteps('5'), [{ label: '5', pageUsers: 4, ciUsers: 1, users: 5 }]);

    for (const hostile of [
      'abc',
      '1e3',
      '-5',
      '0',
      '0+0',
      '5+',
      '+5',
      '1.5',
      '9999999',
      '1+2+3',
      ' 5 6',
    ]) {
      assert.throws(() => parseSteps(hostile), Error, hostile);
    }

    // A long hostile list is refused at its first bad step, quickly.
    const started = performance.now();

    assert.throws(() => parseSteps(`${'1,'.repeat(100_000)}x`));
    assert.ok(performance.now() - started < 2_000);
  });

  it('sends one webhook in 20 of 200 KiB and the rest JSON of 512 bytes to 10 KiB, each exactly its size', () => {
    const next = random(186);
    let large = 0;

    for (let seq = 0; seq < 2_000; seq += 1) {
      const size = webhookSize(7, seq, next);
      const body = webhookBody(size, 7, seq);

      assert.equal(body.length, size);
      assert.equal((JSON.parse(body.toString('utf8')) as { seq: number }).seq, seq);

      if (size === PROFILE.largeBytes) {
        large += 1;
      } else {
        assert.ok(size >= PROFILE.smallMinBytes && size <= PROFILE.smallMaxBytes, String(size));
      }
    }

    assert.equal(large, 100);
    // Users take their large webhooks at different moments.
    assert.notEqual(
      Array.from({ length: 20 }, (_, seq) => webhookSize(0, seq, () => 0)).indexOf(
        PROFILE.largeBytes,
      ),
      Array.from({ length: 20 }, (_, seq) => webhookSize(1, seq, () => 0)).indexOf(
        PROFILE.largeBytes,
      ),
    );
    // The same seed, the same bodies.
    assert.deepEqual(Array.from({ length: 5 }, random(3)), Array.from({ length: 5 }, random(3)));
  });

  it('writes a PROXY v2 header naming the user, and refuses an address that is not IPv4', () => {
    const header = proxyHeader('198.18.1.2', 41_000);

    assert.equal(header.length, 28);
    assert.deepEqual([...header.subarray(0, 12)], [13, 10, 13, 10, 0, 13, 10, 81, 85, 73, 84, 10]);
    assert.deepEqual([...header.subarray(12, 16)], [0x21, 0x11, 0, 12]);
    assert.deepEqual([...header.subarray(16, 20)], [198, 18, 1, 2]);
    assert.equal(header.readUInt16BE(24), 41_000);

    for (const hostile of ['256.0.0.1', '-1.0.0.0', '1.2.3', 'a.b.c.d', '1.2.3.4.5', '::1', '']) {
      assert.throws(() => proxyHeader(hostile), RangeError, hostile);
    }
  });
});

describe('measure-ordinary-load: the numbers', () => {
  it('takes percentiles by nearest rank and leaves out what is not finite', () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([5], 0.99), 5);
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2);

    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);

    assert.equal(percentile(hundred, 0.99), 99);
    assert.equal(percentile(hundred, 1), 100);
    assert.deepEqual(summarize([3, 1, Number.NaN, 2, Infinity]), {
      count: 3,
      median: 2,
      p99: 3,
      max: 3,
    });
    assert.deepEqual(summarize([]), { count: 0, median: null, p99: null, max: null });
    assert.equal(summarize([1.26]).max, 1.3);
  });

  it('reads CPU, throttling and memory from the stats samples, the CPU over the hold alone', () => {
    const second = (at: number, cpuSeconds: number, throttled: number, memory: number) => ({
      at: at * 1000,
      cpuNs: cpuSeconds * 1e9,
      periods: at * 10,
      throttled,
      memory: memory * 1024 * 1024,
      anon: (memory / 2) * 1024 * 1024,
    });
    const samples = [
      second(0, 0, 0, 100),
      second(1, 0.5, 5, 400),
      second(2, 0.9, 8, 200),
      second(3, 1.4, 12, 250),
      second(4, 1.5, 12, 150),
    ];
    const summary = summarizeSamples(samples, 2_000, 4_000);

    assert.deepEqual(summary, {
      samples: 5,
      samplesHold: 3,
      cpuPercentHold: { mean: 30, peak: 50 },
      throttledPercentHold: 20,
      memoryMiB: { peak: 400, anonPeak: 200 },
    });
    assert.deepEqual(summarizeSamples([], 0, 1), {
      samples: 0,
      samplesHold: 0,
      cpuPercentHold: { mean: null, peak: null },
      throttledPercentHold: null,
      memoryMiB: { peak: null, anonPeak: null },
    });
  });

  it("counts losses, errors by kind and the client's health, and leaves the count and deletions at the end out of the verdict", () => {
    const health = (eventLoopP99: number, cpu: number, lag: number): WorkerRecords['health'] => ({
      users: 2,
      eventLoopDelayMs: { p50: 1, p99: eventLoopP99, max: eventLoopP99 },
      cpuPercent: cpu,
      scheduleLagMs: { count: 1, median: lag, p99: lag, max: lag },
      rssMiB: 60,
    });
    const raw = (overrides: Partial<WorkerRecords>): WorkerRecords => ({
      webhooks: [],
      api: [],
      shown: [],
      pages: [],
      stored: [],
      ws: { opened: 1, readies: 1, reconnections: 0, closes: {} },
      ci: { loops: 0, loopsCounted: 0 },
      sessions: { created: 1, deleted: 1, ciCreated: 0, ciDeleted: 0 },
      rateLimitRemainingMin: { creations: 59, calls: 1190 },
      health: health(5, 10, 2),
      ...overrides,
    });
    const report = buildReport(
      [
        raw({
          webhooks: [
            { kind: 'page', large: false, at: 500, ms: 10, status: 200 },
            { kind: 'page', large: true, at: 1_500, ms: 30, status: 200 },
            { kind: 'ci', large: false, at: 1_600, ms: 20, status: 503, errorCode: 1018 },
          ],
          api: [
            { kind: 'create', at: 0, ms: 5, status: 201 },
            { kind: 'list', at: 10, ms: 7, status: 429, errorCode: 1015 },
            { kind: 'wait', at: 10, ms: 900, status: 200 },
            { kind: 'count', at: 3_000, ms: 50, status: 500, errorCode: 1500 },
            { kind: 'cleanup', at: 3_100, ms: 6, status: 0, error: 'ECONNRESET' },
          ],
          shown: [
            {
              at: 500,
              captureMs: 10,
              eventMs: 3,
              listedMs: 40,
              user: 0,
              state: 'ready',
              listedBy: 'ready',
              missed: false,
            },
            {
              at: 1_500,
              captureMs: 30,
              eventMs: null,
              listedMs: 90,
              user: 0,
              state: 'waiting',
              listedBy: 'page load',
              missed: false,
            },
            {
              at: 1_700,
              captureMs: 20,
              eventMs: null,
              listedMs: 4_000,
              user: 2,
              state: 'ready',
              listedBy: 'ready',
              missed: true,
            },
          ],
          pages: [
            { user: 0, connections: 3, refusals: 2, readies: 1, notReadyMs: 1_200.04 },
            { user: 2, connections: 1, refusals: 0, readies: 0, notReadyMs: 5_000 },
            { user: 4, connections: 1, refusals: 0, readies: 1, notReadyMs: 3 },
          ],
          stored: [
            { kind: 'page', sent: 2, stored: 2, answeredNotStored: 0, countFailed: false },
            { kind: 'ci', sent: 1, stored: 0, answeredNotStored: 0, countFailed: false },
          ],
          ws: { opened: 2, readies: 2, reconnections: 1, closes: { 'close 1006': 1 } },
        }),
        raw({
          shown: [
            {
              at: 1_200,
              captureMs: 5,
              eventMs: null,
              listedMs: null,
              user: 1,
              state: 'connecting',
              listedBy: null,
              missed: false,
            },
          ],
          stored: [{ kind: 'page', sent: 1, stored: 0, answeredNotStored: 1, countFailed: true }],
          rateLimitRemainingMin: { creations: 40, calls: null },
          health: health(CLIENT_HEALTH.eventLoopP99Ms + 1, 10, 2),
        }),
      ],
      { rampMs: 1_000, holdMs: 1_000 },
    );

    assert.equal(report.webhooks.sent, 3);
    assert.deepEqual(report.webhooks.statuses, { '200': 2, '503/1018': 1 });
    assert.deepEqual(report.webhooks.captureMs, { count: 2, median: 10, p99: 30, max: 30 });
    assert.equal(report.webhooks.captureMsHold.count, 1);
    assert.equal(report.webhooks.captureMsLarge.max, 30);
    assert.equal(report.webhooks.lost, 1);
    assert.equal(report.webhooks.sessionsNotCounted, 1);
    assert.equal(report.realtime.tracked, 4);
    assert.equal(report.realtime.shownByEvent, 1);
    assert.equal(report.realtime.shownByListOnly, 2);
    assert.equal(report.realtime.notShown, 1);
    assert.deepEqual(report.realtime.ms, { count: 3, median: 90, p99: 4_000, max: 4_000 });
    assert.equal(report.realtime.msHold.count, 2);
    // The list-only rows: what their page was doing, which load listed them,
    // and the one whose event a live, ready connection never carried.
    assert.deepEqual(report.realtime.listOnly, {
      count: 2,
      ms: { count: 2, median: 90, p99: 4_000, max: 4_000 },
      byStateAtCapture: { waiting: 1, ready: 1 },
      byLoad: { 'page load': 1, ready: 1 },
      missedOnLiveConnection: 1,
    });
    // The pages: refused, never ready, and the longest without a connection
    // first, only those refused or with a list-only row.
    assert.equal(report.realtime.pages.count, 3);
    assert.equal(report.realtime.pages.refused, 1);
    assert.equal(report.realtime.pages.neverReady, 1);
    assert.deepEqual(report.realtime.pages.longestWithoutConnection, [
      { user: 2, connections: 1, refusals: 0, readies: 0, notReadyMs: 5_000, listOnly: 1 },
      { user: 0, connections: 3, refusals: 2, readies: 1, notReadyMs: 1_200, listOnly: 1 },
    ]);
    assert.equal(report.api.p99Ms, 7);
    assert.deepEqual(report.errors.byKind, {
      'webhook 503/1018': 1,
      'api list 429/1015': 1,
      'ws close 1006': 1,
    });
    assert.equal(report.errors.total, 3);
    assert.deepEqual(report.api.byKind.cleanup?.statuses, { 'failed ECONNRESET': 1 });
    assert.deepEqual(report.api.rateLimitRemainingMin, { creations: 40, calls: 1190 });
    assert.equal(report.client.healthy, false);
    assert.equal(report.client.problems.length, 1);
    assert.equal(report.servedWell.verdict, false);
  });
});

describe('measure-ordinary-load: served well', () => {
  const passing = (): Pick<Report, 'webhooks' | 'realtime' | 'errors'> =>
    ({
      webhooks: {
        sent: 10,
        captureMs: { count: 10, median: 5, p99: 999.9, max: 1_500 },
        lost: 0,
        sessionsNotCounted: 0,
      },
      realtime: { tracked: 10, notShown: 0, ms: { count: 10, median: 5, p99: 2_000, max: 3_000 } },
      errors: { total: 0 },
    }) as Pick<Report, 'webhooks' | 'realtime' | 'errors'>;

  it('passes p99 capture under 1 s, p99 realtime within 2 s, nothing lost and no error', () => {
    assert.deepEqual(servedWell(passing()), { verdict: true, reasons: [] });
  });

  it('fails each criterion alone, at its edge', () => {
    const cases: [string, (report: ReturnType<typeof passing>) => void][] = [
      ['capture p99 1000 ms', (report) => (report.webhooks.captureMs.p99 = 1_000)],
      ['capture p99 null ms', (report) => (report.webhooks.captureMs.p99 = null)],
      ['realtime p99 2000.1 ms', (report) => (report.realtime.ms.p99 = 2_000.1)],
      ['1 captured webhooks never shown', (report) => (report.realtime.notShown = 1)],
      ['1 webhooks lost', (report) => (report.webhooks.lost = 1)],
      ['1 sessions not counted', (report) => (report.webhooks.sessionsNotCounted = 1)],
      ['1 errors', (report) => (report.errors.total = 1)],
      ['no webhook was sent', (report) => (report.webhooks.sent = 0)],
    ];

    for (const [reason, change] of cases) {
      const report = passing();

      change(report);

      const verdict = servedWell(report);

      assert.equal(verdict.verdict, false, reason);
      assert.ok(
        verdict.reasons.some((each) => each.startsWith(reason)),
        `${reason}: ${verdict.reasons.join('; ')}`,
      );
    }
  });
});

describe('measure-ordinary-load: the production budget', () => {
  it('lets 12 page users and 2 CI runs go, well within what one address may do', () => {
    const budget = productionBudget({ pageUsers: 12, ciUsers: 2, apiSockets: 16 });

    assert.deepEqual(budget.problems, []);
    assert.ok(budget.perMinute.creations <= 48);
    assert.ok(budget.perMinute.calls <= 960);
    assert.ok(budget.tlsConnectionsAbout < 150);
    assert.equal(budget.realtimeConnections, 12);
    assert.equal(budget.realtimeConnectionsAtMost, 12);
    assert.equal(PRODUCTION_PAGE_USERS_MAX, 12);
  });

  it('refuses a 13th page user - 4 of the 16 realtime places stay free - too many creations or calls, and too many calls in flight', () => {
    // The first production run planned all 16 and its 16th page was refused
    // for the whole run (D232).
    for (const pageUsers of [13, 16, 17]) {
      assert.match(
        productionBudget({ pageUsers, ciUsers: 0, apiSockets: 16 }).problems.join(),
        /more than 12 realtime connections, 80 % of the 16/,
        String(pageUsers),
      );
    }

    assert.match(
      productionBudget({ pageUsers: 0, ciUsers: 20, apiSockets: 16 }).problems.join(),
      /session creations/,
    );
    assert.match(
      productionBudget({
        pageUsers: 12,
        ciUsers: 0,
        apiSockets: 16,
        profile: { ...PROFILE, reloadMinMs: 1_000 },
      }).problems.join(),
      /API calls in a minute/,
    );
    assert.match(
      productionBudget({ pageUsers: 1, ciUsers: 0, apiSockets: 120 }).problems.join(),
      /in flight/,
    );
  });

  it('lets nothing it cannot count pass as within it: a profile that is not one, or a figure that is not finite', () => {
    // Each of these once passed with 12 + 2 and then ran a reload loop with
    // no delay, or crashed at a CI run's first pause.
    for (const [change, message] of [
      [{ reloadMaxMs: -1_000_000_000 }, /reloadMaxMs takes a whole number from 1 to 3600000/],
      [{ reloadMinMs: 'x' }, /reloadMinMs takes a whole number/],
      [{ ciPauseMs: 'x' }, /ciPauseMs takes a whole number/],
      [{ ciPauseMs: '5000' }, /ciPauseMs takes a whole number/],
      [{ reloadMinMs: Number.NaN }, /reloadMinMs takes a whole number from 1 to 3600000, not NaN/],
      [{ webhookIntervalMs: Number.POSITIVE_INFINITY }, /webhookIntervalMs takes/],
      [{ ciIntervalMs: -1 }, /ciIntervalMs takes/],
      [{ reloadMinMs: 60_000, reloadMaxMs: 30_000 }, /reloadMaxMs is below reloadMinMs/],
      [{ smallMinBytes: 2_000, smallMaxBytes: 1_000 }, /smallMaxBytes is below smallMinBytes/],
      [{ largeEvery: 0 }, /largeEvery takes/],
      [{ reloadAwaitsClose: 'false' }, /reloadAwaitsClose takes true or false/],
      [{ reloadMinMs: 2 ** 31 }, /reloadMinMs takes/],
      [{ reloadsMinMs: 1 }, /no field "reloadsMinMs"/],
    ] as const) {
      const problems = productionBudget({
        pageUsers: 12,
        ciUsers: 2,
        apiSockets: 16,
        profile: { ...PROFILE, ...change },
      }).problems;

      assert.ok(problems.length > 0, JSON.stringify(change));
      assert.match(problems.join('; '), message, JSON.stringify(change));
    }

    for (const figures of [
      { pageUsers: Number.NaN, ciUsers: 2, apiSockets: 16 },
      { pageUsers: 12, ciUsers: Number.NaN, apiSockets: 16 },
      { pageUsers: 12, ciUsers: 2, apiSockets: Number.POSITIVE_INFINITY },
      { pageUsers: -12, ciUsers: 2, apiSockets: 16 },
    ]) {
      assert.match(
        productionBudget(figures).problems.join('; '),
        /not a finite number of at least 0/,
        JSON.stringify(figures),
      );
    }
  });

  it("counts a CI run's loop from its first webhook, sent at once, so a short run is not undercounted", () => {
    // 2 webhooks 30 s apart and no pause: a loop every 30 s, 2 a minute.
    const budget = productionBudget({
      pageUsers: 0,
      ciUsers: 1,
      apiSockets: 16,
      profile: { ...PROFILE, ciWebhooks: 2, ciIntervalMs: 30_000, ciPauseMs: 0 },
    });

    assert.equal(budget.perMinute.creations, 2);
    assert.equal(budget.perMinute.calls, 10);
    // The default: 19 s of webhooks and 5 s of pause, 3 loops a minute.
    assert.deepEqual(productionBudget({ pageUsers: 12, ciUsers: 2, apiSockets: 16 }).perMinute, {
      creations: 18,
      calls: 198,
    });
  });
});

describe('measure-ordinary-load: --profile', () => {
  it('takes a JSON object of fields to change and gives the profile', () => {
    assert.deepEqual(parseProfile('{}'), PROFILE);
    assert.deepEqual(parseProfile(QUICK), { ...PROFILE, ...JSON.parse(QUICK) });
    assert.deepEqual(parseProfile('{"reloadAwaitsClose":true,"ciPauseMs":0}'), {
      ...PROFILE,
      reloadAwaitsClose: true,
      ciPauseMs: 0,
    });
    assert.deepEqual(profileProblems({ ...PROFILE }), []);
  });

  it('refuses anything else, naming at most the start of what it was given', () => {
    for (const [text, message] of [
      ['', /takes a JSON object/],
      ['x', /takes a JSON object/],
      ['[]', /takes a JSON object/],
      ['null', /takes a JSON object/],
      ['1', /takes a JSON object/],
      ['"{}"', /takes a JSON object/],
      ['{"__proto__":{"reloadMinMs":1}}', /no field "__proto__"/],
      ['{"a":1,"b":2,"c":3,"d":4,"e":5}', /no field "a", "b", "c" or 2 more/],
      ['{"ciWaitSeconds":0}', /ciWaitSeconds takes a whole number from 1 to 30/],
      ['{"ciWaitSeconds":31}', /ciWaitSeconds takes a whole number from 1 to 30/],
      ['{"ciWebhooks":1001}', /ciWebhooks takes a whole number from 1 to 1000/],
      ['{"largeBytes":1048577}', /largeBytes takes a whole number from 0 to 1048576/],
      ['{"lifetimeSeconds":0}', /lifetimeSeconds takes a whole number from 60 to 604800/],
      ['{"webhookIntervalMs":0.5}', /webhookIntervalMs takes/],
      ['{"ciPauseMs":1e300}', /ciPauseMs takes/],
      ['{"reloadMinMs":[1]}', /reloadMinMs takes a whole number from 1 to 3600000, not a list/],
      ['{"reloadMinMs":{}}', /not an object/],
      ['{"reloadMinMs":null}', /not null/],
      ['{"reloadMinMs":true}', /not true/],
    ] as const) {
      assert.throws(() => parseProfile(text), message, text);
    }
  });

  it('refuses hostile profiles of growing size in bounded time, quoting at most 40 characters', () => {
    let previous = 0;

    for (const size of [1_000, 10_000, 100_000]) {
      const unknown = JSON.stringify(
        Object.fromEntries(Array.from({ length: size }, (_, index) => [`k${index}`, index])),
      );
      const started = performance.now();

      assert.throws(
        () => parseProfile(unknown),
        (error: Error) =>
          new RegExp(`or ${size - 3} more$`).test(error.message) && error.message.length < 200,
      );

      const elapsed = performance.now() - started;

      assert.ok(elapsed < 2_000, `${size} fields took ${elapsed} ms`);
      previous = elapsed;
    }

    for (const text of [
      JSON.stringify({ reloadMinMs: 'x'.repeat(8 * 1024 * 1024) }),
      JSON.stringify({ ['k'.repeat(8 * 1024 * 1024)]: 1 }),
      `{"reloadMinMs":${'['.repeat(100_000)}${']'.repeat(100_000)}}`,
      '['.repeat(1_000_000) + ']'.repeat(1_000_000),
      `{"reloadMinMs":${'9'.repeat(8 * 1024 * 1024)}}`,
    ]) {
      const started = performance.now();

      assert.throws(
        () => parseProfile(text),
        (error: Error) => error.message.length < 300,
      );
      assert.ok(performance.now() - started < 5_000 + previous);
    }
  });
});

describe("measure-ordinary-load: a page's realtime connection", () => {
  it("waits as the frontend's nextRetryDelay does: 1 s, doubled to 15 s, 1 s again after one that lasted 30 s", () => {
    let delay = 0;
    const delays = [];

    for (let attempt = 0; attempt < 7; attempt += 1) {
      delay = nextRetryDelay(delay, 0);
      delays.push(delay);
    }

    assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    // Opening is not success: a connection that did not last keeps doubling.
    assert.equal(nextRetryDelay(4_000, 29_999), 8_000);
    assert.equal(nextRetryDelay(15_000, 30_000), 1_000);
    assert.equal(nextRetryDelay(0, 30_000), 1_000);
  });

  it("is the frontend's nextRetryDelay for every previous delay and connection lifetime around the edges", () => {
    // The script imports nothing of the frontend (D232): the two must agree,
    // or the measurement no longer simulates the page.
    for (const previous of [0, 1, 999, 1_000, 2_000, 7_500, 8_000, 14_999, 15_000, 60_000]) {
      for (const lifetime of [0, 1, 29_999, 30_000, 30_001, 300_000]) {
        assert.equal(
          nextRetryDelay(previous, lifetime),
          frontendRetryDelay(previous, lifetime),
          `${previous} ms before, a connection of ${lifetime} ms`,
        );
      }
    }
  });

  it('counts a list-only row as missed only when its connection was ready before the send and stayed open 2 s after the capture', () => {
    const sentAt = 10_000;
    const answeredAt = 10_050;

    assert.equal(
      missedOnLiveConnection({ readyAt: 9_000, endedAt: null }, sentAt, answeredAt),
      true,
    );
    assert.equal(
      missedOnLiveConnection({ readyAt: sentAt, endedAt: answeredAt + 2_000 }, sentAt, answeredAt),
      true,
    );
    // No connection, one not ready before the send, or one that ended within 2 s.
    assert.equal(missedOnLiveConnection(null, sentAt, answeredAt), false);
    assert.equal(
      missedOnLiveConnection({ readyAt: null, endedAt: null }, sentAt, answeredAt),
      false,
    );
    assert.equal(
      missedOnLiveConnection({ readyAt: sentAt + 1, endedAt: null }, sentAt, answeredAt),
      false,
    );
    assert.equal(
      missedOnLiveConnection({ readyAt: 9_000, endedAt: answeredAt + 1_999 }, sentAt, answeredAt),
      false,
    );
  });

  it('never checks the places of a production address, and opens 1 to 64 connections', async () => {
    for (const origin of [
      'https://qa-tools.ru',
      'https://QA-TOOLS.RU:443',
      'https://www.qa-tools.ru',
      'https://qa-tools.ru.',
    ]) {
      await assert.rejects(places(origin), /never runs against production/, origin);
    }

    for (const count of [0, 65, 1.5, Number.NaN]) {
      await assert.rejects(places('http://127.0.0.1:9', count), /1 to 64/, String(count));
    }
  });
});

describe('measure-ordinary-load: the sessions file', () => {
  it('keeps the ids created and not deleted, once each and in order', () => {
    const text = [
      '# measure-ordinary-load production 2026-10-12T00:00:00.000Z https://qa-tools.ru',
      `created ${ID}`,
      `created ${OTHER_ID}`,
      `created ${ID}`,
      `deleted ${OTHER_ID}`,
      '',
    ].join('\n');

    assert.deepEqual(pendingSessions(text), { pending: [ID], created: [ID, OTHER_ID], skipped: 0 });
    assert.deepEqual(pendingSessions(`created ${ID}\r\ndeleted ${ID}\r\n`).pending, []);
  });

  it('skips every line that is not a verb and a well-formed session id, so nothing else is ever called', () => {
    const hostile = [
      `created ../../api/sessions/${ID}`,
      `created ${ID}/requests`,
      `created ${ID}?wait=30`,
      `created ${ID} extra`,
      `created  ${ID}`,
      `Created ${ID}`,
      `removed ${ID}`,
      `created ${ID.slice(1)}`,
      `created ${ID}A`,
      `created ${'Я'.repeat(43)}`,
      `created ${'%2e'.repeat(15)}`,
      `created\t${ID}`,
      `created ${ID.slice(0, 42)}\u0000`,
      'created',
      `deleted ../${ID}`,
    ];
    const result = pendingSessions(hostile.join('\n'));

    assert.deepEqual(result, { pending: [], created: [], skipped: hostile.length });
  });

  it('reads hostile files of growing size in linear time', () => {
    let previous = 0;

    for (const size of [1_000, 10_000, 100_000]) {
      const lines = Array.from({ length: size }, (_, index) =>
        index % 3 === 0 ? `created ${'a'.repeat(index % 40)}` : `x${' '.repeat(index % 50)}y`,
      );
      const started = performance.now();
      const result = pendingSessions(lines.join('\n'));
      const elapsed = performance.now() - started;

      assert.equal(result.pending.length, 0);
      assert.ok(elapsed < 2_000, `${size} lines took ${elapsed} ms`);
      previous = elapsed;
    }

    // One line of 8 MiB, with and without spaces.
    for (const line of [`created ${'A'.repeat(8 * 1024 * 1024)}`, 'a '.repeat(4 * 1024 * 1024)]) {
      const started = performance.now();

      assert.deepEqual(pendingSessions(line).pending, []);
      assert.ok(performance.now() - started < 5_000 + previous);
    }
  });

  const header = (origin: string, mode = 'production') =>
    `# measure-ordinary-load ${mode} 2026-10-12T00:00:00.000Z ${origin}`;

  it("cleans against the origin the file's run headers name, which --app-origin must be when given", () => {
    const local = [header('http://127.0.0.1:3000', 'client'), `created ${ID}`].join('\n');

    // No --app-origin: the file's own, never production by default.
    assert.equal(cleanupOrigin(local, undefined), 'http://127.0.0.1:3000');
    assert.equal(
      cleanupOrigin(`${local}\n${header('http://127.0.0.1:3000/')}\n`, undefined),
      'http://127.0.0.1:3000',
    );
    // The same origin given, written differently, is that origin.
    assert.equal(cleanupOrigin(local, 'http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
    assert.equal(
      cleanupOrigin(header('https://qa-tools.ru'), 'HTTPS://QA-TOOLS.RU:443/api'),
      'https://qa-tools.ru',
    );
    // No user or path is ever kept, from the file or from the flag.
    assert.equal(
      cleanupOrigin(header('http://user:secret@127.0.0.1:3000/x?y'), undefined),
      'http://127.0.0.1:3000',
    );
    // A file with no run header needs --app-origin.
    assert.equal(
      cleanupOrigin(`created ${ID}\n`, 'http://127.0.0.1:3000'),
      'http://127.0.0.1:3000',
    );
    assert.equal(cleanupOrigin('', 'https://qa-tools.ru/'), 'https://qa-tools.ru');

    for (const [text, given, message] of [
      // A local file never cleaned against production, nor the reverse.
      [
        local,
        'https://qa-tools.ru',
        /--app-origin https:\/\/qa-tools\.ru is not http:\/\/127\.0\.0\.1:3000/,
      ],
      [header('https://qa-tools.ru'), 'http://127.0.0.1:3000', /is not https:\/\/qa-tools\.ru/],
      [local, 'http://127.0.0.1:3001', /is not http:\/\/127\.0\.0\.1:3000/],
      // Runs against two origins: no one origin is right for every session.
      [
        `${local}\n${header('https://qa-tools.ru')}`,
        undefined,
        /against http:\/\/127\.0\.0\.1:3000 and https:\/\/qa-tools\.ru/,
      ],
      [
        `${local}\n${header('https://qa-tools.ru')}`,
        'http://127.0.0.1:3000',
        /runs against .+ and /,
      ],
      [`created ${ID}\n`, undefined, /names no origin in a run header: give --app-origin/],
      ['', undefined, /give --app-origin/],
      [local, 'file:///etc/passwd', /--app-origin is not an http or https origin/],
      [local, 'qa-tools.ru', /--app-origin is not an http or https origin/],
      [local, '', /--app-origin is not an http or https origin/],
    ] as const) {
      assert.throws(() => cleanupOrigin(text, given), message, `${text} / ${given}`);
    }
  });

  it('refuses every run header that names no http or https origin, and reads hostile files of growing size in linear time', () => {
    for (const line of [
      header('file:///etc/passwd'),
      header('javascript:alert(1)'),
      header('ftp://127.0.0.1'),
      header('qa-tools.ru'),
      header('http://'),
      header(''),
      header('http://127.0.0.1:3000 extra'),
      '# measure-ordinary-load production http://127.0.0.1:3000',
      '# measure-ordinary-load  production 2026-10-12T00:00:00.000Z http://127.0.0.1:3000',
      `# measure-ordinary-load ${'a '.repeat(1_000)}`,
    ]) {
      assert.throws(
        () => cleanupOrigin(`${line}\ncreated ${ID}\n`, 'http://127.0.0.1:3000'),
        /names no http or https origin/,
        line,
      );
    }

    // Comments that are not run headers are not read.
    assert.equal(
      cleanupOrigin(
        '# measure-ordinary-loader x y https://qa-tools.ru\n#  measure-ordinary-load\n',
        'http://127.0.0.1:3000',
      ),
      'http://127.0.0.1:3000',
    );

    let previous = 0;

    for (const size of [1_000, 10_000, 100_000]) {
      const lines = Array.from({ length: size }, (_, index) =>
        index % 2 === 0 ? header('http://127.0.0.1:3000/') : `created ${'a'.repeat(index % 40)}`,
      );
      const started = performance.now();

      assert.equal(cleanupOrigin(lines.join('\n'), undefined), 'http://127.0.0.1:3000');

      const elapsed = performance.now() - started;

      assert.ok(elapsed < 2_000, `${size} lines took ${elapsed} ms`);
      previous = elapsed;
    }

    // One line of 8 MiB: spaces, which no header has, and a host as long.
    for (const [line, message] of [
      [`# measure-ordinary-load ${'a '.repeat(4 * 1024 * 1024)}`, /names no http or https origin/],
      [header(`http://${'a'.repeat(8 * 1024 * 1024)}`), /is not http:\/\/a{8}/],
    ] as const) {
      const started = performance.now();

      assert.throws(() => cleanupOrigin(line, 'http://127.0.0.1:3000'), message);
      assert.ok(performance.now() - started < 5_000 + previous);
    }
  });
});

describe('measure-ordinary-load: the answer parser', () => {
  it('reads an answer framed by Content-Length, chunked, or not yet whole', () => {
    const whole = Buffer.from(
      'HTTP/1.1 200 OK\r\nX-QA-Tools-Request-Id: abc\r\nContent-Length: 11\r\n\r\n{"ok":true}',
    );

    assert.deepEqual(parseHttpAnswer(whole), {
      complete: true,
      status: 200,
      headers: { 'x-qa-tools-request-id': 'abc', 'content-length': '11' },
      body: '{"ok":true}',
    });
    assert.equal(parseHttpAnswer(whole.subarray(0, whole.length - 1)).complete, false);
    assert.equal(parseHttpAnswer(whole.subarray(0, 20)).status, 0);

    const chunked = Buffer.from(
      'HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\n\r\n' +
        '1d\r\n{"errorCode":1018,"m":"busy"}\r\n0\r\n\r\n',
    );

    assert.equal(parseHttpAnswer(chunked).complete, true);
    assert.equal(parseHttpAnswer(chunked).errorCode, 1018);
    assert.equal(parseHttpAnswer(chunked.subarray(0, chunked.length - 2)).complete, false);
  });

  it('survives hostile answers of growing size without an error and in linear time', () => {
    for (const size of [1_024, 64 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
      const cases = [
        Buffer.alloc(size, 'a'),
        Buffer.from(`HTTP/1.1 200 OK\r\n${'x: y\r\n'.repeat(size / 6)}`),
        Buffer.from(`HTTP/1.1 200 OK\r\n${'x: y\r\n'.repeat(size / 6)}\r\n`),
        Buffer.from(`HTTP/1.1 999999 ${'9'.repeat(size)}\r\n\r\n`),
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${'9'.repeat(size)}\r\n\r\n`),
        Buffer.from(
          `HTTP/1.1 400 X\r\nContent-Length: 1\r\n\r\n${'"errorCode":'.repeat(size / 12)}`,
        ),
        Buffer.from(`HTTP/1.1 500 X\r\n\r\n${'\r\n'.repeat(size / 2)}`),
      ];

      for (const bytes of cases) {
        const started = performance.now();
        const answer = parseHttpAnswer(bytes);

        assert.ok(performance.now() - started < 3_000, `${size}: ${bytes.subarray(0, 20)}`);
        assert.ok(Number.isInteger(answer.status));
      }
    }

    assert.equal(parseHttpAnswer(Buffer.from('HTTP/1.1 999999 X\r\n\r\n')).status, 0);
    assert.equal(
      parseHttpAnswer(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: x\r\n\r\n')).complete,
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* What each unit of work costs, and where the CPU goes (#188).               */
/* -------------------------------------------------------------------------- */

const SCRIPTS = fileURLToPath(new URL('../../../scripts/', import.meta.url));
/**
 * For a run of the script that must refuse before it starts anything: a
 * Docker socket that is not there, so that a run which did not refuse could
 * reach no Docker Engine either.
 */
const NO_DOCKER = { ...process.env, DOCKER_HOST: 'unix:///nonexistent/docker.sock' };
/** What `--idle` and `--quiet` refuse: past an hour, below zero, not a plain decimal. */
const REFUSED_SECONDS = [
  '3601',
  '99999',
  '-1',
  '-0',
  '+1',
  '',
  ' 1',
  '1 ',
  '30\n',
  '1e3',
  '0x10',
  '1.',
  '.5',
  '1.2345',
  '1,5',
  '30s',
  'NaN',
  'Infinity',
  'abc',
  '١٢',
  '30; rm -rf /',
  '${MEASURE_IDLE}',
];

describe('measure-ordinary-load: the units of work over the hold (#188)', () => {
  const quiet = (overrides: Partial<WorkerRecords>): WorkerRecords => ({
    webhooks: [],
    api: [],
    shown: [],
    pages: [],
    stored: [],
    ws: { opened: 0, readies: 0, reconnections: 0, closes: {} },
    ci: { loops: 0, loopsCounted: 0 },
    sessions: { created: 0, deleted: 0, ciCreated: 0, ciDeleted: 0 },
    rateLimitRemainingMin: { creations: null, calls: null },
    health: {
      users: 1,
      eventLoopDelayMs: { p50: 1, p99: 1, max: 1 },
      cpuPercent: 1,
      scheduleLagMs: { count: 0, median: null, p99: null, max: null },
      rssMiB: 50,
    },
    ...overrides,
  });
  const shown = (at: number, captureMs: number, eventMs: number | null) => ({
    at,
    captureMs,
    eventMs,
    listedMs: eventMs === null ? 5 : null,
    user: 0,
    state: 'ready' as const,
    listedBy: eventMs === null ? ('ready' as const) : null,
    missed: false,
  });

  it('counts each webhook, event, API call and connection by when it was done, at the edges of the hold', () => {
    // The hold is 1,000 to 2,000 ms from t0.
    const report = buildReport(
      [
        quiet({
          webhooks: [
            // Sent in the ramp, answered at the hold's first millisecond: counted.
            { kind: 'page', large: false, at: 990, ms: 10, status: 200 },
            // Sent in the hold, answered at its end: not counted.
            { kind: 'page', large: false, at: 1_990, ms: 10, status: 200 },
            // Answered within it but not `200`: not a capture.
            { kind: 'ci', large: false, at: 1_500, ms: 10, status: 503, errorCode: 1018 },
            { kind: 'ci', large: true, at: 1_500, ms: 499, status: 200 },
          ],
          api: [
            { kind: 'sessionRead', at: 999, ms: 1, status: 200 },
            { kind: 'list', at: 1_999, ms: 1, status: 200 },
            // Answered with an error status: answered all the same.
            { kind: 'list', at: 1_200, ms: 5, status: 429, errorCode: 1015 },
            // Failed, never answered.
            { kind: 'wait', at: 1_200, ms: 5, status: 0, error: 'ECONNRESET' },
            { kind: 'wait', at: 900, ms: 1_099, status: 200 },
          ],
          shown: [
            // Its event at 1,000: counted, though sent in the ramp.
            shown(980, 10, 10),
            // Its event at 2,000: not counted.
            shown(1_980, 10, 10),
            // Listed, never by an event: not an event delivered.
            shown(1_500, 10, null),
          ],
          readyAts: [999.9, 1_000, 1_999.9, 2_000],
        }),
        // A worker's records from before #188 have no ready times.
        quiet({ shown: [shown(1_100, 1, 1)] }),
      ],
      { rampMs: 1_000, holdMs: 1_000 },
    );

    assert.deepEqual(report.units, {
      holdS: 1,
      webhooksCaptured: 2,
      eventsDelivered: 2,
      apiAnswered: 3,
      apiAnsweredByKind: { sessionRead: 1, list: 1, wait: 1 },
      connectionsReady: 2,
    });
  });

  it("reads a container's CPU over the quiet window before the load", () => {
    const sample = (at: number, cpuSeconds: number) => ({
      at: at * 1000,
      cpuNs: cpuSeconds * 1e9,
      periods: 0,
      throttled: 0,
      memory: 0,
      anon: 0,
    });

    assert.deepEqual(idleCpu([sample(10, 1), sample(11, 1.05), sample(14, 1.25)]), {
      seconds: 4,
      cpuPercent: 6.3,
    });
    assert.deepEqual(idleCpu([sample(10, 1)]), { seconds: 0, cpuPercent: null });
    assert.deepEqual(idleCpu([]), { seconds: 0, cpuPercent: null });
  });

  it("limits the backend to production's 0.5 CPU unless --backend-cpus gives 0.1 to 8, as the compose file reads it", () => {
    assert.equal(backendCpus(undefined), '0.5');

    for (const given of ['0.1', '0.5', '1', '1.5', '2.25', '8', '08']) {
      assert.equal(backendCpus(given), given);
    }

    for (const hostile of [
      '',
      '0',
      '0.05',
      '8.01',
      '9',
      '100',
      '-1',
      '1e0',
      '0x1',
      ' 1',
      '1 ',
      '1.234',
      '.5',
      '1.',
      'NaN',
      'Infinity',
      '1,5',
      '1\n--cpus=8',
      '${MEASURE_BACKEND_CPUS}',
    ]) {
      assert.throws(() => backendCpus(hostile), /--backend-cpus takes a number of CPUs/, hostile);
    }

    // A refusal quotes at most 40 characters of what it was given, at any size.
    for (const size of [1_000, 100_000, 10_000_000]) {
      const started = performance.now();

      assert.throws(
        () => backendCpus('9'.repeat(size)),
        (error: Error) => error.message.length < 120,
      );
      assert.ok(performance.now() - started < 2_000);
    }

    const compose = readFileSync(path.join(SCRIPTS, 'measure-ordinary-load.compose.yml'), 'utf8');
    const backend = compose.slice(
      compose.indexOf('\n  backend:\n'),
      compose.indexOf('\n  traefik:'),
    );

    assert.match(backend, /\n {4}cpus: \$\{MEASURE_BACKEND_CPUS:-0\.5\}\n/);
    assert.match(backend, /\n {4}mem_limit: 512m\n {4}memswap_limit: 512m\n/);
  });

  it("reads the backend's CPU limit back from its cgroup's cpu.max, null for no limit and for anything else", () => {
    assert.equal(cpuLimit('50000 100000'), 0.5);
    assert.equal(cpuLimit('50000 100000\n'), 0.5);
    assert.equal(cpuLimit('100000 100000'), 1);
    assert.equal(cpuLimit('150000 100000'), 1.5);
    assert.equal(cpuLimit('10000 100000'), 0.1);
    assert.equal(cpuLimit('33333 100000'), 0.333);
    assert.equal(cpuLimit('max 100000'), null);

    for (const hostile of [
      '',
      'max',
      '50000',
      '50000 0',
      '0 100000',
      '-50000 100000',
      '50000 -100000',
      '50000  100000',
      ' 50000 100000',
      '50000 100000 1',
      '50000\t100000',
      '5e4 100000',
      '0x10 100000',
      '50000.5 100000',
      'NaN 100000',
      'Infinity 100000',
      'MAX 100000',
      'max max',
      '50000 100000\n\n',
      '50000 100000\nmax 100000',
      'usage_usec 50000',
      `${'9'.repeat(16)} 100000`,
    ]) {
      assert.equal(cpuLimit(hostile), null, JSON.stringify(hostile));
    }

    // Made-up readings of growing size: refused at once.
    for (const size of [1_000, 100_000, 10_000_000]) {
      const started = performance.now();

      assert.equal(cpuLimit(`${'5'.repeat(size)} 100000`), null);
      assert.equal(cpuLimit(`50000 ${'1'.repeat(size)}`), null);
      assert.equal(cpuLimit(`${'50000 100000\n'.repeat(size / 10)}`), null);
      assert.ok(performance.now() - started < 2_000, `${size}`);
    }
  });

  it("checks nothing in the backend's container: no health check, and no exec into it but the cgroup read after the step", () => {
    const compose = readFileSync(path.join(SCRIPTS, 'measure-ordinary-load.compose.yml'), 'utf8');
    const backend = compose.slice(
      compose.indexOf('\n  backend:\n'),
      compose.indexOf('\n  traefik:'),
    );

    assert.ok(backend.length > 200, 'the backend block is read');
    assert.doesNotMatch(backend, /healthcheck|HEALTH_INTERVAL|start_interval|interval:/);
    // PostgreSQL keeps its own check, which the migration waits for.
    assert.match(compose, /\n {2}postgres:\n[\s\S]*?\n {4}healthcheck:\n/);

    const script = readFileSync(SCRIPT, 'utf8');

    assert.equal(script.match(/'exec',\s*'-T',\s*'backend'/g)?.length, 1);
    assert.match(
      script,
      /async function backendCgroup\(\) \{\n {2}try \{\n {4}const text = await compose\(\[\n {6}'exec',\n {6}'-T',\n {6}'backend',/,
    );
    // The backend started, running, and then found ready from the client.
    assert.match(
      script,
      /compose\(\['up', '-d', '--wait', 'backend'\][^;]*;\n {2}await compose\(\['exec', '-T', 'client', \.\.\.readinessWait\(\)\]/,
    );
    assert.deepEqual(readinessWait().slice(0, 2), ['node', '-e']);
    assert.deepEqual(readinessWait().slice(3), ['http://backend:3000/readyz', '120000', '500']);
  });

  it('refuses --health-interval as an option it does not have, before anything starts', async () => {
    for (const args of [
      ['local', '--health-interval', '1'],
      ['local', '--health-interval=300'],
      ['front', '--health-interval', '1'],
      ['rehearse', '--health-interval', '1'],
    ]) {
      const result = await run(args, NO_DOCKER);

      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, /Unknown option '--health-interval'/, args.join(' '));
    }
  });

  it('keeps quiet before a step for --idle seconds, 0 to 3600, 30 unless given', async () => {
    assert.equal(idleSeconds(undefined), 30);

    for (const [given, wanted] of [
      ['0', 0],
      ['0.5', 0.5],
      ['10', 10],
      ['3600', 3_600],
      ['3600.0', 3_600],
      ['0030', 30],
    ] as const) {
      assert.equal(idleSeconds(given), wanted);
    }

    for (const hostile of [...REFUSED_SECONDS, '3600.001']) {
      assert.throws(
        () => idleSeconds(hostile),
        /--idle takes seconds from 0 to 3600, not "/,
        hostile,
      );
    }

    for (const size of [1_000, 100_000, 10_000_000]) {
      const started = performance.now();

      assert.throws(
        () => idleSeconds('9'.repeat(size)),
        (error: Error) => error.message.length < 120,
      );
      assert.throws(
        () => idleSeconds(`1.${'0'.repeat(size)}`),
        (error: Error) => error.message.length < 120,
      );
      assert.ok(performance.now() - started < 2_000, `${size}`);
    }

    // The script refuses it before any container starts.
    for (const given of ['3601', '-1', 'abc', '1e3']) {
      const result = await run(['local', '--steps', '12+2', `--idle=${given}`], NO_DOCKER);

      assert.equal(result.code, 1, given);
      assert.match(result.stderr, /--idle takes seconds from 0 to 3600/, given);
    }
  });

  it("keeps quiet before --cpu-prof's series for --quiet seconds, 0 to 3600, 10 unless given", async () => {
    assert.equal(quietSeconds(undefined), 10);

    for (const [given, wanted] of [
      ['0', 0],
      ['0.3', 0.3],
      ['10', 10],
      ['3600', 3_600],
    ] as const) {
      assert.equal(quietSeconds(given), wanted);
    }

    for (const hostile of [...REFUSED_SECONDS, '3600.001']) {
      assert.throws(
        () => quietSeconds(hostile),
        /--quiet takes seconds from 0 to 3600, not "/,
        hostile,
      );
    }

    for (const size of [1_000, 100_000, 10_000_000]) {
      const started = performance.now();

      assert.throws(
        () => quietSeconds('9'.repeat(size)),
        (error: Error) => error.message.length < 120,
      );
      assert.ok(performance.now() - started < 2_000, `${size}`);
    }

    // The series refuses it before it calls anything.
    for (const given of ['3601', '-1', 'abc', '1e3']) {
      const result = await run([
        'captures',
        '--count',
        '1',
        `--quiet=${given}`,
        '--app-origin',
        'http://127.0.0.1:9',
        '--receive-origin',
        'http://127.0.0.1:9',
      ]);

      assert.equal(result.code, 1, given);
      assert.match(result.stderr, /--quiet takes seconds from 0 to 3600/, given);
    }
  });

  it('refuses a --cpu-prof directory that already holds a step of the run, before any container starts, and deletes nothing', async () => {
    const prof = mkdtempSync(path.join(os.tmpdir(), 'measure-ordinary-load-prof-'));

    try {
      mkdirSync(path.join(prof, 'step-700'));
      writeFileSync(path.join(prof, 'step-700', 'kept.txt'), 'kept');
      mkdirSync(path.join(prof, 'step-12p2'));

      assert.deepEqual(profileDirsInUse(prof, parseSteps('700')), ['step-700']);
      assert.deepEqual(profileDirsInUse(prof, parseSteps('600,700,800')), ['step-700']);
      assert.deepEqual(profileDirsInUse(prof, parseSteps('12+2,700')), ['step-12p2', 'step-700']);
      // A run without them is accepted.
      assert.deepEqual(profileDirsInUse(prof, parseSteps('600,800')), []);
      assert.deepEqual(profileDirsInUse(prof, parseSteps('13+2,70')), []);
      assert.deepEqual(profileDirsInUse(path.join(prof, 'none'), parseSteps('700')), []);

      const out = path.join(prof, 'out');
      const result = await run(
        ['local', '--steps', '600,700', '--cpu-prof', prof, '--out', out, '--image', 'none'],
        NO_DOCKER,
      );

      assert.equal(result.code, 1);
      assert.match(result.stderr, /--cpu-prof \S+ already holds step-700: name a directory/);
      // Refused before the run made its output directory, let alone a container.
      assert.equal(existsSync(out), false);
      assert.equal(readFileSync(path.join(prof, 'step-700', 'kept.txt'), 'utf8'), 'kept');
    } finally {
      rmSync(prof, { recursive: true, force: true });
    }
  });

  it('sends 1 to 1000 captures in --cpu-prof series, 500 unless told', () => {
    assert.equal(captureCount(undefined), 500);
    assert.equal(captureCount('1'), 1);
    assert.equal(captureCount('1000'), 1_000);

    for (const hostile of ['0', '1001', '9999', '-1', '1.5', '1e3', ' 5', 'abc', '', '10000']) {
      assert.throws(() => captureCount(hostile), /--count takes a whole number from 1 to 1000/);
    }
  });

  it('profiles the backend and counts statements only through the compose file --cpu-prof adds', () => {
    const added = readFileSync(path.join(SCRIPTS, 'measure-ordinary-load.cpu-prof.yml'), 'utf8');
    const base = readFileSync(path.join(SCRIPTS, 'measure-ordinary-load.compose.yml'), 'utf8');

    assert.match(added, /- --cpu-prof\n\s+- --cpu-prof-dir=\/tmp\/qa-profile\n/);
    assert.match(
      added,
      /- --import\n\s+- \/probe\/measure-ordinary-load\.probe\.mjs\n\s+- src\/index\.ts\n/,
    );
    assert.match(
      added,
      /\.\/measure-ordinary-load\.probe\.mjs:\/probe\/measure-ordinary-load\.probe\.mjs:ro/,
    );
    assert.match(added, /shared_preload_libraries=pg_cron,pg_stat_statements/);
    // The line's own steps run neither.
    assert.doesNotMatch(base, /cpu-prof|pg_stat_statements|measure-ordinary-load\.probe/);
  });
});

describe("measure-ordinary-load: the backend's readiness, asked from the client (#261)", () => {
  interface Waited {
    code: number | null;
    stderr: string;
    ms: number;
  }

  /** The wait as `freshProject` runs it in the client, here with this Node. */
  function wait(url: string, deadlineMs: number): Promise<Waited> {
    const [, ...args] = readinessWait(url, { deadlineMs });
    const started = performance.now();
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) =>
        resolve({ code, stderr, ms: Math.round(performance.now() - started) }),
      );
    });
  }

  /** A stand-in for the backend on loopback, answering each `/readyz` as `answer` says. */
  async function stub(answer: (index: number) => number) {
    const asked: string[] = [];
    const server = http.createServer((request, response) => {
      const status = answer(asked.length);

      asked.push(`${request.method} ${request.url}`);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: status === 200 ? 'ready' : 'not ready' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const { port } = server.address() as AddressInfo;

    return {
      url: `http://127.0.0.1:${port}/readyz`,
      asked,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('waits until /readyz answers 200, asking every 500 ms, and exits 0', async () => {
    const backend = await stub((index) => (index < 2 ? 503 : 200));

    try {
      const result = await wait(backend.url, 10_000);

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(backend.asked, ['GET /readyz', 'GET /readyz', 'GET /readyz']);
      // Two pauses of 500 ms between the three asks.
      assert.ok(result.ms >= 1_000, `${result.ms} ms`);
      assert.ok(result.ms < 8_000, `${result.ms} ms`);
    } finally {
      await backend.close();
    }
  });

  it('fails once its deadline has passed, naming /readyz and the last answer', async () => {
    const backend = await stub(() => 503);

    try {
      const result = await wait(backend.url, 2_000);

      assert.equal(result.code, 1);
      assert.match(
        result.stderr,
        /^http:\/\/127\.0\.0\.1:\d+\/readyz did not answer 200 within 2 s; last: answered 503\n$/,
      );
      // It kept asking until the deadline: at 0, 0.5, 1, 1.5 and 2 s.
      assert.ok(backend.asked.length >= 4, `${backend.asked.length} asks`);
      assert.ok(backend.asked.length <= 6, `${backend.asked.length} asks`);
      assert.ok(result.ms >= 2_000, `${result.ms} ms`);
    } finally {
      await backend.close();
    }
  });

  it('keeps trying with nothing listening until its deadline, and fails naming the error', async () => {
    // A port that was free a moment ago, nothing listening on it now.
    const gone = await stub(() => 200);

    await gone.close();

    const result = await wait(gone.url, 2_000);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /\/readyz did not answer 200 within 2 s; last: .*ECONNREFUSED/);
    assert.ok(result.ms >= 2_000, `${result.ms} ms`);
    assert.ok(result.ms < 8_000, `${result.ms} ms`);
  });
});

describe('measure-ordinary-load: the probe and the CPU profile (#188)', () => {
  it("writes the event loop's turns and events, a last line as the process exits", async () => {
    const probeDir = mkdtempSync(path.join(os.tmpdir(), 'measure-ordinary-load-probe-'));

    try {
      const child = spawn(
        process.execPath,
        [
          '--import',
          path.join(SCRIPTS, 'measure-ordinary-load.probe.mjs'),
          '-e',
          'let turns = 0; const tick = () => { turns += 1; if (turns < 60) setTimeout(tick, 10); }; tick();',
        ],
        { env: { ...process.env, QA_PROBE_DIR: probeDir }, stdio: 'ignore' },
      );
      const code = await new Promise((resolve) => child.on('close', resolve));
      const exited = Date.now();
      const lines = parseProbeLines(readFileSync(path.join(probeDir, 'probe.jsonl'), 'utf8'));

      assert.equal(code, 0);
      assert.ok(lines.length >= 3, `${lines.length} lines`);
      assert.ok(lines.at(-1)!.loops >= 60, `${lines.at(-1)!.loops} turns`);
      assert.ok(lines.at(-1)!.loops > lines[0]!.loops);
      assert.ok(exited - lines.at(-1)!.t < 2_000);
      assert.ok(lines.every((line, index) => index === 0 || line.t >= lines[index - 1]!.t));
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });

  const probe = (t: number, loops: number, events: number) => JSON.stringify({ t, loops, events });

  it("reads the probe's lines, skipping any that is not one, and its windows between them", () => {
    const text = [
      probe(2_000, 200, 100),
      'not json',
      '{"t":1500}',
      JSON.stringify({ t: 1_500, loops: '1', events: 1 }),
      JSON.stringify({ t: 1_500, loops: null, events: 1 }),
      JSON.stringify({ t: 1_500, loops: 1, events: Number.MAX_VALUE * 10 }),
      '[1,2,3]',
      'null',
      '',
      probe(1_000, 100, 50),
      probe(3_000, 400, 120),
      `${probe(4_000, 1, 1)}${' '.repeat(1_000)}`,
    ].join('\n');
    const lines = parseProbeLines(text);

    assert.deepEqual(
      lines.map((line) => line.t),
      [1_000, 2_000, 3_000],
    );
    // From 1,500 to 2,500: half of each second's work, by interpolation.
    assert.deepEqual(probeWindow(lines, 1_500, 2_500), {
      seconds: 1,
      loops: 150,
      events: 35,
    });
    assert.deepEqual(probeWindow(lines, 2_000, 3_000), { seconds: 1, loops: 200, events: 20 });
    // Outside the lines, or no window at all.
    assert.equal(probeWindow(lines, 500, 2_000), null);
    assert.equal(probeWindow(lines, 2_000, 3_001), null);
    assert.equal(probeWindow(lines, 2_000, 2_000), null);
    assert.equal(probeWindow([], 1, 2), null);
  });

  it('reads the profile against the wall clock from the probe line written as the backend exits', () => {
    const lines = parseProbeLines([probe(1_000, 1, 1), probe(5_000, 2, 2)].join('\n'));

    assert.equal(profileOffset({ endTime: 9_000_000 }, lines), 9_000_000 - 5_000_000);
    assert.equal(profileOffset({ endTime: 9_000_000 }, []), null);
    assert.equal(profileOffset({ endTime: Number.NaN }, lines), null);
    assert.equal(profileOffset(null, lines), null);
  });

  it('reads hostile probe files of growing size in linear time', () => {
    let previous = 0;

    for (const size of [1_000, 10_000, 100_000]) {
      const text = Array.from({ length: size }, (_, index) =>
        index % 4 === 0
          ? probe(index, index, index)
          : index % 4 === 1
            ? `{"t":${'9'.repeat(index % 400)}`
            : index % 4 === 2
              ? '['.repeat(index % 900)
              : `{"t":1,"loops":1,"events":"${'x'.repeat(index % 900)}"}`,
      ).join('\n');
      const started = performance.now();
      const lines = parseProbeLines(text);
      const elapsed = performance.now() - started;

      assert.equal(lines.length, size / 4);
      assert.ok(elapsed < 2_000 + previous * 20, `${size} lines took ${elapsed} ms`);
      previous = elapsed;
    }

    // One line of 8 MiB: skipped unread.
    const started = performance.now();

    assert.deepEqual(parseProbeLines(`{"t":${'1'.repeat(8 * 1024 * 1024)}}`), []);
    assert.ok(performance.now() - started < 2_000);
  });

  /** A CPU profile as `node --cpu-prof` writes one, its nodes and samples made up. */
  const cpuProfile = () => ({
    startTime: 1_000_000,
    endTime: 1_010_000,
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 } },
      { id: 2, callFrame: { functionName: '(program)', url: '', lineNumber: -1 } },
      { id: 3, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
      { id: 4, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 } },
      {
        id: 5,
        callFrame: {
          functionName: 'insertRequest',
          url: 'file:///app/apps/backend/src/modules/webhook/repository.ts',
          lineNumber: 199,
        },
      },
      {
        id: 6,
        callFrame: {
          functionName: 'parse',
          url: 'file:///app/node_modules/pg-protocol/dist/parser.js',
          lineNumber: 9,
        },
      },
      {
        id: 7,
        callFrame: {
          functionName: '',
          url: 'file:///app/node_modules/@fastify/websocket/index.js',
          lineNumber: 0,
        },
      },
      {
        id: 8,
        callFrame: {
          functionName: 'writeGeneric',
          url: 'node:internal/stream_base_commons',
          lineNumber: 150,
        },
      },
      { id: 9, callFrame: { functionName: 'nativeThing', url: '', lineNumber: -1 } },
    ],
    // Each sample is charged with the time to the next.
    samples: [2, 5, 5, 6, 3, 3, 4, 7, 8, 9, 5],
    timeDeltas: [0, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000],
  });

  it('ranks the functions and modules by self time, the idle time apart, within a window when given', () => {
    const summary = summarizeCpuProfile(cpuProfile(), null, 4);

    assert.equal(summary.sampledMs, 10);
    assert.equal(summary.idleMs, 2);
    assert.equal(summary.busyMs, 8);
    assert.deepEqual(summary.functions, [
      {
        name: 'insertRequest apps/backend/src/modules/webhook/repository.ts:200',
        ms: 2,
        percent: 25,
      },
      { name: '(program)', ms: 1, percent: 12.5 },
      { name: 'parse node_modules/pg-protocol/dist/parser.js:10', ms: 1, percent: 12.5 },
      { name: '(garbage collector)', ms: 1, percent: 12.5 },
    ]);
    assert.deepEqual(
      summarizeCpuProfile(cpuProfile()).modules.map((each) => [each.name, each.ms]),
      [
        ['apps/backend/src/modules/webhook/repository.ts', 2],
        ['(program)', 1],
        ['pg-protocol', 1],
        ['(garbage collector)', 1],
        ['@fastify/websocket', 1],
        ['node:internal/stream_base_commons', 1],
        ['(native)', 1],
      ],
    );
    // Samples timed from 1,003,000 to 1,005,000 (the 4th and 5th): parse, then (idle).
    const window = summarizeCpuProfile(cpuProfile(), { from: 1_003_000, to: 1_005_000 });

    assert.deepEqual(window.functions, [
      { name: 'parse node_modules/pg-protocol/dist/parser.js:10', ms: 1, percent: 100 },
    ]);
    assert.equal(window.idleMs, 1);
  });

  it("cuts the profile to the step's hold, wall milliseconds read on the profile's microseconds through the probe's last line", () => {
    // A wall clock in milliseconds since 1970, as the report's times are, and
    // a profile clock in microseconds from an origin of its own: the probe's
    // last line, at wall W + 10, is the profile's end, S + 10,000.
    const wall = 1_761_200_000_000;
    const start = 7_000_000;
    const names = Array.from({ length: 10 }, (_, index) => `at${index}`);
    const profile = {
      startTime: start,
      endTime: start + 10_000,
      nodes: names.map((name, index) => ({
        id: index + 1,
        callFrame: { functionName: name, url: '', lineNumber: -1 },
      })),
      // Sample k at S + 1,000 k, wall W + k; each charged with the 1 ms to the next.
      samples: names.map((_, index) => index + 1),
      timeDeltas: names.map((_, index) => (index === 0 ? 0 : 1_000)),
    };
    const lines = parseProbeLines(
      [probe(wall - 5_000, 1, 1), probe(wall + 10, 100, 100)].join('\n'),
    );
    const cpu = holdCpu(profile, lines, { from: wall + 3, to: wall + 6 });

    // Exactly the samples inside the hold: at3, at4 and at5, not at6.
    assert.ok(cpu !== null);
    assert.equal(cpu.sampledMs, 3);
    assert.deepEqual(
      cpu.functions.map((each) => each.name),
      ['at3', 'at4', 'at5'],
    );
    assert.deepEqual(
      holdCpu(profile, lines, { from: wall, to: wall + 1 })!.functions.map((each) => each.name),
      ['at0'],
    );
    assert.deepEqual(
      holdCpu(profile, lines, { from: wall + 8, to: wall + 60_000 })!.functions.map(
        (each) => each.name,
      ),
      ['at8', 'at9'],
    );
    assert.equal(holdCpu(profile, lines, { from: wall - 60_000, to: wall })!.sampledMs, 0);
    // No offset without the probe's lines or the profile's end.
    assert.equal(holdCpu(profile, [], { from: wall + 3, to: wall + 6 }), null);
    assert.equal(
      holdCpu({ ...profile, endTime: undefined }, lines, { from: wall + 3, to: wall + 6 }),
      null,
    );
  });

  it('refuses what is not a profile, and skips a node or a sample that does not fit', () => {
    for (const hostile of [
      null,
      'profile',
      [],
      {},
      { ...cpuProfile(), nodes: 'x' },
      { ...cpuProfile(), samples: [1] },
      { ...cpuProfile(), startTime: '0' },
      { ...cpuProfile(), timeDeltas: undefined },
    ]) {
      assert.throws(() => summarizeCpuProfile(hostile), /not a CPU profile/);
    }

    const odd = {
      ...cpuProfile(),
      nodes: [
        ...cpuProfile().nodes,
        null,
        { id: 'x', callFrame: {} },
        { id: 10, callFrame: null },
        { id: 11 },
        { id: 12, callFrame: { functionName: 42, url: 7, lineNumber: 'x' } },
      ],
      samples: [5, 404, 12, 12, 5],
      timeDeltas: [0, 1_000, 1_000, 1_000, -5],
    };
    const summary = summarizeCpuProfile(odd);

    // Sample 404 has no node; the second 12 is charged nothing, the delta
    // after it being negative; node 12's frame of the wrong kinds is named
    // `(anonymous)`, with no script.
    assert.equal(summary.busyMs, 2);
    assert.deepEqual(summary.functions, [
      {
        name: 'insertRequest apps/backend/src/modules/webhook/repository.ts:200',
        ms: 1,
        percent: 50,
      },
      { name: '(anonymous)', ms: 1, percent: 50 },
    ]);
    // A delta that is not a number charges nothing to the sample before it.
    assert.deepEqual(
      summarizeCpuProfile({ ...odd, timeDeltas: [0, Number.NaN, 1_000, 1_000, -5] }).functions,
      [
        { name: '(anonymous)', ms: 1, percent: 100 },
        {
          name: 'insertRequest apps/backend/src/modules/webhook/repository.ts:200',
          ms: 0,
          percent: 0,
        },
      ],
    );
  });

  it('names modules by package, path or pseudo-node, and cuts a hostile URL to 120 characters', () => {
    assert.equal(moduleOf('file:///app/node_modules/pg/lib/client.js', 'query'), 'pg');
    assert.equal(
      moduleOf('file:///app/node_modules/@fastify/websocket/index.js'),
      '@fastify/websocket',
    );
    assert.equal(
      moduleOf('file:///app/node_modules/a/node_modules/pino-std-serializers/x.js'),
      'pino-std-serializers',
    );
    assert.equal(moduleOf('file:///app/apps/backend/src/server.ts'), 'apps/backend/src/server.ts');
    assert.equal(
      moduleOf('file:///app/packages/shared/src/index.ts'),
      'packages/shared/src/index.ts',
    );
    assert.equal(moduleOf('node:internal/streams/readable'), 'node:internal/streams/readable');
    assert.equal(moduleOf('', '(garbage collector)'), '(garbage collector)');
    assert.equal(moduleOf('', 'Reflect.apply'), '(native)');
    assert.equal(moduleOf('', `(${'x'.repeat(100)})`), '(native)');

    let previous = 0;

    for (const size of [1_000, 100_000, 10_000_000]) {
      for (const url of [
        `file:///${'node_modules/'.repeat(size / 13)}pkg/x.js`,
        `file:///app/${'a/'.repeat(size / 2)}x.ts`,
        `file:///app/node_modules/@${'s'.repeat(size)}/${'n'.repeat(size)}`,
      ]) {
        const started = performance.now();
        const name = moduleOf(url, 'f');
        const elapsed = performance.now() - started;

        assert.ok(name.length <= 121, `${name.length} characters`);
        assert.ok(elapsed < 2_000 + previous * 20, `${size}: ${elapsed} ms`);
        previous = Math.max(previous, elapsed);
      }
    }
  });

  /**
   * Samples a node of the hostile profiles below: two. At ten, as until
   * #393, the million samples of 100,000 nodes were most of the summary's
   * time - 1.0 to 1.4 s at best of five alone on the server the measurement
   * ran on, up to 3.4 s under the load below - while the cheapest summary
   * quadratic in the nodes measured took 7.0 s alone: too near for a bound to
   * leave room on both sides (`docs/testing/flakes.md`, F-30).
   */
  const PROFILE_SAMPLES_PER_NODE = 2;

  /**
   * Milliseconds a node of the hostile profiles below may take to summarise:
   * 0.03, so 30 ms at 1,000 nodes, 300 at 10,000 and 3000 at 100,000, the
   * fastest of up to five runs (`withinBound`), so that the machine's load
   * does not decide it. A bound linear in the size, which a summary worse
   * than linear is over from some size on, on every run. One run a size held
   * to 2000 ms plus twenty times the size before, as until #393, failed
   * under load with nothing wrong.
   *
   * At 100,000 nodes the summary takes 0.25 to 0.41 s at best of five alone
   * on the server the measurement ran on, and beside the full backend suite
   * and eight busy loops up to 2.6 s a run and 1.3 s at best of five: 2.3
   * times under the bound. Each node's id looked for among those kept with
   * V8's own `includes`, the cheapest summary quadratic in the nodes measured,
   * takes 5.3 s at best of five alone, 1.8 times over it; each sample's node
   * searched for in the nodes, 26.6 s. A summary that totals each sample's
   * function in a list searched by name passes: these profiles name at most
   * 915 functions, so it is not quadratic in their nodes (F-30).
   */
  const PROFILE_MS_PER_NODE = 0.03;

  it('summarises hostile profiles of growing size in linear time', () => {
    for (const size of [1_000, 10_000, 100_000]) {
      const samples = size * PROFILE_SAMPLES_PER_NODE;
      const nodes = Array.from({ length: size }, (_, index) => ({
        id: index,
        callFrame: {
          functionName: index % 7 === 0 ? 'f'.repeat(index % 5_000) : `f${index % 50}`,
          url:
            index % 3 === 0
              ? `file:///app/${'node_modules/'.repeat(index % 40)}p${index % 9}/x.js`
              : '',
          lineNumber: index % 100,
        },
      }));
      const profile = {
        startTime: 0,
        endTime: samples,
        nodes,
        samples: Array.from({ length: samples }, (_, index) => (index * 7919) % (size + 10)),
        timeDeltas: Array.from({ length: samples }, (_, index) => (index % 11 === 0 ? -1 : 1)),
      };
      // The deltas add up to about 0.82 a sample: the window leaves out the
      // first samples and the last few.
      const summary = withinBound(size * PROFILE_MS_PER_NODE, () =>
        summarizeCpuProfile(profile, { from: 5, to: samples * 0.8 }),
      );

      assert.ok(summary.functions.length <= 10);
      assert.ok(summary.functions.every((each) => each.name.length <= 250));
    }
  });

  it("reads pg_stat_statements' counts, skipping any line of another shape, a statement cut to 300 characters", () => {
    const text = [
      '3\tSELECT $1',
      '1000\tINSERT INTO requests (a) VALUES ($1)',
      'x\tSELECT 2',
      '\tSELECT 3',
      '12345678901234567\tSELECT 4',
      '5',
      '7\t   ',
      `2\t${'Z'.repeat(1_000)}`,
      '',
    ].join('\n');

    assert.deepEqual(parseStatementCounts(text), [
      { calls: 1_000, query: 'INSERT INTO requests (a) VALUES ($1)' },
      { calls: 3, query: 'SELECT $1' },
      { calls: 2, query: 'Z'.repeat(300) },
    ]);

    let previous = 0;

    for (const size of [1_000, 10_000, 100_000]) {
      const hostile = Array.from({ length: size }, (_, index) =>
        index % 2 === 0
          ? `${index}\t${'q'.repeat(index % 2_000)}`
          : `${'1'.repeat(index % 30)}${'\t'.repeat(index % 3)}`,
      ).join('\n');
      const started = performance.now();
      const counts = parseStatementCounts(hostile);
      const elapsed = performance.now() - started;

      assert.ok(counts.every((each) => each.query.length <= 300));
      assert.ok(elapsed < 2_000 + previous * 20, `${size} lines took ${elapsed} ms`);
      previous = elapsed;
    }

    const started = performance.now();

    assert.deepEqual(
      parseStatementCounts(`1\t${'S'.repeat(8 * 1024 * 1024)}`)[0]?.query.length,
      300,
    );
    assert.ok(performance.now() - started < 2_000);
  });

  it('counts what one capture takes: its statements, and the turns beyond what the idle backend does', () => {
    const result = perCapture({
      count: 500,
      // 10 s idle: 40 turns and 10 events a second.
      quiet: { seconds: 10, loops: 400, events: 100 },
      // 5 s of captures: 200 of those turns idle, the rest the captures'.
      series: { seconds: 5, loops: 3_200, events: 1_050 },
      statements: [
        { calls: 1_000, query: 'BEGIN' },
        { calls: 500, query: 'INSERT INTO requests (a) VALUES ($1)' },
        { calls: 250, query: 'UPDATE sessions SET n = n + $1' },
        { calls: 249, query: 'SELECT rare' },
        { calls: 15, query: 'SELECT $1' },
        { calls: 1, query: 'SELECT pg_stat_statements_reset()' },
        { calls: 1, query: 'INSERT INTO sessions DEFAULT VALUES' },
      ],
    });

    assert.deepEqual(result, {
      captures: 500,
      statements: 3.5,
      byStatement: [
        { perCapture: 2, query: 'BEGIN' },
        { perCapture: 1, query: 'INSERT INTO requests (a) VALUES ($1)' },
        { perCapture: 0.5, query: 'UPDATE sessions SET n = n + $1' },
      ],
      otherStatements: [
        { calls: 249, query: 'SELECT rare' },
        { calls: 1, query: 'INSERT INTO sessions DEFAULT VALUES' },
      ],
      loopTurns: 6,
      loopEvents: 2,
    });
    // Without the probe's windows, no turns; with no captures, none either.
    assert.equal(
      perCapture({ count: 500, quiet: null, series: null, statements: [] }).loopTurns,
      null,
    );
    assert.equal(
      perCapture({
        count: 0,
        quiet: { seconds: 1, loops: 1, events: 1 },
        series: { seconds: 1, loops: 1, events: 1 },
        statements: [],
      }).loopEvents,
      null,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The script itself, against both listeners.                                 */
/* -------------------------------------------------------------------------- */

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The `{"report":…}` line a run printed. */
function reportOf(result: Run): Report & {
  sessions: { created: number; deleted: number; left: number };
  step: { pageUsers: number; ciUsers: number; users: number; workers: number };
  budget?: unknown;
} {
  const line = result.stdout.split('\n').find((each) => each.startsWith('{"report"'));

  if (line === undefined) {
    throw new Error(`no report (exit ${result.code}): ${result.stderr.slice(0, 2_000)}`);
  }

  return JSON.parse(line).report;
}

/** A profile short enough for a test, within the production budget. */
const QUICK = JSON.stringify({
  webhookIntervalMs: 400,
  reloadMinMs: 60_000,
  reloadMaxMs: 60_000,
  ciWebhooks: 3,
  ciIntervalMs: 100,
  ciPauseMs: 5_000,
  ciWaitSeconds: 5,
});

let pool: pg.Pool;
let plain: TestServers;
let proxied: TestServers;
/** Servers whose realtime limit is 2 connections an address, not 16, and their places. */
let narrow: TestServers;
const narrowPlaces = createRealtimePlaces(2);
let plainApi: string;
let plainReceive: string;
let proxiedApi: string;
let proxiedReceive: string;
let narrowApi: string;
let narrowReceive: string;
let dir: string;
/** Every call the plain API was asked, method and path. */
const plainCalls: string[] = [];
/** The ids the plain API created. */
const created: string[] = [];
/** What each creation asked for. */
const creationBodies: unknown[] = [];
/** The proxied API's view of its callers, and the sender addresses its lists gave. */
const proxiedIps = new Set<string>();
const listedSourceIps = new Set<string>();
/** The ids the proxied API created. */
const proxiedCreated: string[] = [];

async function listening(server: FastifyInstance): Promise<string> {
  await server.listen({ host: '127.0.0.1', port: 0 });

  return `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
}

async function sessionStatus(origin: string, id: string): Promise<number> {
  return (await fetch(`${origin}/api/sessions/${id}`)).status;
}

describe('scripts/measure-ordinary-load.mjs (D232)', () => {
  // Only this suite needs the database and the listeners; its after()
  // waits for its before() (#31, src/test-files-exit.test.ts).
  let startup: Promise<void> | undefined;

  before(async () => {
    startup = (async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'measure-ordinary-load-'));
      pool = createPool(loadConfig().databaseUrl);
      plain = buildTestServers(pool);
      proxied = buildTestServers(pool, {
        trustedProxyCidrs: ['127.0.0.1/32'],
        proxyProtocol: 'v2',
      });
      narrow = buildTestServers(pool, { realtimePlaces: narrowPlaces });

      for (const servers of [plain, proxied, narrow]) {
        servers.api.log.level = 'silent';
        servers.receiver.log.level = 'silent';
      }

      plain.api.addHook('onRequest', async (request) => {
        plainCalls.push(`${request.method} ${request.url}`);
      });
      plain.api.addHook('preHandler', async (request) => {
        if (request.method === 'POST' && request.url === '/api/sessions') {
          // The route reads its body as text and parses it itself.
          creationBodies.push(
            typeof request.body === 'string' ? JSON.parse(request.body) : request.body,
          );
        }
      });
      plain.api.addHook('onSend', async (request, reply, payload) => {
        if (
          request.method === 'POST' &&
          request.url === '/api/sessions' &&
          reply.statusCode === 201
        ) {
          created.push((JSON.parse(String(payload)) as { id: string }).id);
        }

        return payload;
      });
      proxied.api.addHook('onRequest', async (request) => {
        proxiedIps.add(request.ip);
      });
      proxied.api.addHook('onSend', async (request, reply, payload) => {
        if (
          request.method === 'POST' &&
          request.url === '/api/sessions' &&
          reply.statusCode === 201
        ) {
          proxiedCreated.push((JSON.parse(String(payload)) as { id: string }).id);
        }

        if (
          request.method === 'GET' &&
          /\/requests(\?|$)/.test(request.url) &&
          reply.statusCode === 200
        ) {
          for (const row of JSON.parse(String(payload)) as { sourceIp: string }[]) {
            listedSourceIps.add(row.sourceIp);
          }
        }

        return payload;
      });

      plainApi = await listening(plain.api);
      plainReceive = await listening(plain.receiver);
      proxiedApi = await listening(proxied.api);
      proxiedReceive = await listening(proxied.receiver);
      narrowApi = await listening(narrow.api);
      narrowReceive = await listening(narrow.receiver);
    })();
    await startup;
  });

  after(async () => {
    await startup;
    await plain?.close();
    await proxied?.close();
    await narrow?.close();
    await pool?.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs the production mode within its budget, records every session before using it and deletes every one', async () => {
    const file = path.join(dir, 'production.txt');

    created.length = 0;
    creationBodies.length = 0;

    const result = await run([
      'production',
      '--app-origin',
      plainApi,
      '--receive-origin',
      plainReceive,
      '--page',
      '2',
      '--ci',
      '1',
      '--ramp',
      '0.5',
      '--hold',
      '3',
      '--settle',
      '3',
      '--sessions-file',
      file,
      '--profile',
      QUICK,
    ]);
    const report = reportOf(result);

    assert.equal(result.code, 0, JSON.stringify(report.servedWell));
    assert.equal(report.servedWell.verdict, true);
    assert.ok(report.webhooks.sent >= 10, String(report.webhooks.sent));
    assert.equal(report.webhooks.lost, 0);
    assert.equal(report.errors.total, 0, JSON.stringify(report.errors));
    assert.equal(report.realtime.notShown, 0);
    assert.ok(report.realtime.shownByEvent > 0);
    assert.ok(report.ci.loops >= 1);
    assert.equal(report.ws.opened, 2);
    assert.ok(report.budget);
    assert.equal(report.sessions.created, created.length);
    assert.equal(report.sessions.left, 0);
    assert.ok(creationBodies.length >= 3);
    assert.deepEqual(
      creationBodies,
      creationBodies.map(() => ({ expiresInSeconds: 3_600 })),
    );

    // Each id in the file once created and once deleted, and gone.
    const text = readFileSync(file, 'utf8');

    assert.deepEqual(pendingSessions(text).pending, []);
    assert.deepEqual(new Set(pendingSessions(text).created), new Set(created));

    for (const id of created) {
      assert.equal(await sessionStatus(plainApi, id), 404);
    }

    // No session id is printed.
    for (const id of created) {
      assert.ok(!result.stdout.includes(id) && !result.stderr.includes(id));
    }
  });

  it('refuses a production run over what one address may do, without a sessions file, with an address per user, or with a profile that is not one', async () => {
    const common = [
      'production',
      '--app-origin',
      'http://127.0.0.1:9',
      '--receive-origin',
      'http://127.0.0.1:9',
      '--ramp',
      '0',
      '--hold',
      '1',
    ];
    const refusedFile = path.join(dir, 'refused.txt');
    const file = ['--sessions-file', refusedFile];
    const profile = (json: string) => ['--profile', json];

    for (const [args, message] of [
      [[...common, '--page', '13', ...file], /more than 12 realtime connections/],
      [[...common, '--other-pages', '1', ...file], /no --other-pages/],
      [[...common, '--ci', '20', ...file], /session creations/],
      [[...common], /needs --sessions-file/],
      [[...common, '--addresses', 'per-user', ...file], /no --addresses per-user/],
      // A profile that is not one is refused before anything runs: a figure
      // that is not a whole number in its range (a string, even "5000", or
      // a negative delay), a reload range whose end is below its start, or
      // text that is no JSON object. No run could be counted or paced as
      // planned from it.
      [
        [...common, ...profile('{"reloadMaxMs":-1000000000}'), ...file],
        /--profile: reloadMaxMs takes a whole number/,
      ],
      [[...common, ...profile('{"reloadMinMs":"x"}'), ...file], /--profile: reloadMinMs takes/],
      [
        [...common, '--ci', '100', ...profile('{"ciPauseMs":"x"}'), ...file],
        /--profile: ciPauseMs takes/,
      ],
      [[...common, ...profile('{"ciPauseMs":"5000"}'), ...file], /--profile: ciPauseMs takes/],
      [
        [...common, ...profile('{"reloadMinMs":60000,"reloadMaxMs":30000}'), ...file],
        /reloadMaxMs is below reloadMinMs/,
      ],
      [[...common, ...profile('not json'), ...file], /--profile takes a JSON object/],
      // Every mode refuses it, not production's alone.
      [
        ['client', ...common.slice(1), ...profile('{"reloadMinMs":"x"}')],
        /--profile: reloadMinMs takes/,
      ],
    ] as const) {
      const result = await run([...args]);

      assert.notEqual(result.code, 0, args.join(' '));
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stdout, /"phase"/, args.join(' '));
    }

    // Refused before anything: no session recorded, no run header written.
    assert.equal(existsSync(refusedFile), false);
  });

  it("names each user's own address to the backend in the per-user mode, reloads the page, and keeps the reloads out of the errors", async () => {
    proxiedIps.clear();
    listedSourceIps.clear();

    const result = await run([
      'client',
      '--addresses',
      'per-user',
      '--app-origin',
      proxiedApi,
      '--receive-origin',
      proxiedReceive,
      '--page',
      '3',
      '--ci',
      '1',
      '--workers',
      '2',
      '--ramp',
      '0.5',
      '--hold',
      '4',
      '--settle',
      '3',
      '--profile',
      JSON.stringify({ ...JSON.parse(QUICK), reloadMinMs: 900, reloadMaxMs: 1_300 }),
    ]);
    const report = reportOf(result);
    const addresses = new Set(planUsers(3, 1, 0).map((user) => user.address));

    assert.equal(
      result.code,
      0,
      JSON.stringify({ verdict: report.servedWell, errors: report.errors }),
    );
    assert.equal(report.servedWell.verdict, true);
    assert.equal(report.step.workers, 2);
    assert.equal(report.client.workers.length, 2);
    assert.ok(report.ws.opened > 3, `opened ${report.ws.opened}: no reload`);
    assert.equal(report.errors.total, 0);
    assert.deepEqual(proxiedIps, addresses);
    assert.ok(listedSourceIps.size >= 2);

    for (const ip of listedSourceIps) {
      assert.ok(addresses.has(ip), ip);
    }

    // What the backend did over the hold, for #188's fit: the reloads' new
    // connections and calls among it, and no event without its webhook.
    const { units } = report;

    assert.equal(units.holdS, 4);
    assert.ok(units.webhooksCaptured > 0, JSON.stringify(units));
    assert.ok(units.eventsDelivered > 0, JSON.stringify(units));
    assert.ok(units.eventsDelivered <= units.webhooksCaptured, JSON.stringify(units));
    assert.ok(units.connectionsReady > 0, JSON.stringify(units));
    assert.ok((units.apiAnsweredByKind.list ?? 0) > 0, JSON.stringify(units));
    assert.equal(
      units.apiAnswered,
      Object.values(units.apiAnsweredByKind).reduce((sum, count) => sum + count, 0),
    );
  });

  it("sends --cpu-prof's series of captures one after another from one address after its quiet window, and deletes its session", async () => {
    proxiedIps.clear();
    proxiedCreated.length = 0;

    const args = [
      '--addresses',
      'per-user',
      '--app-origin',
      proxiedApi,
      '--receive-origin',
      proxiedReceive,
    ];
    const result = await run(['captures', '--count', '5', '--quiet', '0.3', ...args]);
    const line = result.stdout.split('\n').find((each) => each.startsWith('{"report"'));

    assert.equal(result.code, 0, result.stderr.slice(0, 2_000));
    assert.ok(line !== undefined);

    const report = JSON.parse(line).report as {
      count: number;
      captured: number;
      quiet: { from: number; to: number };
      series: { from: number; to: number };
      captureMs: { count: number };
    };

    assert.equal(report.count, 5);
    assert.equal(report.captured, 5);
    assert.equal(report.captureMs.count, 5);
    assert.ok(report.quiet.to - report.quiet.from >= 250, JSON.stringify(report.quiet));
    assert.ok(report.series.from >= report.quiet.to);
    assert.ok(report.series.to >= report.series.from);
    assert.deepEqual(proxiedIps, new Set([userAddress(0)]));
    assert.equal(proxiedCreated.length, 1);
    assert.equal(await sessionStatus(proxiedApi, proxiedCreated[0]!), 404);

    // A count out of its range is refused before anything is sent.
    const refused = await run(['captures', '--count', '1001', ...args]);

    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /--count takes a whole number from 1 to 1000/);
    assert.equal(proxiedCreated.length, 1);
  });

  it("tells a page refused by its address's realtime limit from an event lost on a live connection, and lists its rows by its loads", async () => {
    // Three pages from one address against a limit of two: the third is
    // refused, as the first production run's 16th page was (D232), and
    // reloads that wait for their close.
    const result = await run([
      'client',
      '--app-origin',
      narrowApi,
      '--receive-origin',
      narrowReceive,
      '--page',
      '3',
      '--ci',
      '0',
      '--ramp',
      '0.5',
      '--hold',
      '6',
      '--settle',
      '10',
      '--profile',
      JSON.stringify({
        ...JSON.parse(QUICK),
        reloadMinMs: 1_500,
        reloadMaxMs: 2_000,
        reloadAwaitsClose: true,
      }),
    ]);
    const report = reportOf(result);
    const listOnly = report.realtime.listOnly;

    // Not served well: a refused connection is an error.
    assert.equal(result.code, 1, JSON.stringify(report.errors));
    assert.ok((report.ws.closes['failed before open'] ?? 0) >= 1, JSON.stringify(report.ws));
    assert.equal(report.webhooks.lost, 0);
    assert.equal(report.realtime.pages.count, 3);
    assert.ok(report.realtime.pages.refused >= 1);
    assert.ok(
      report.realtime.pages.longestWithoutConnection.some((page) => page.refusals >= 1),
      JSON.stringify(report.realtime.pages),
    );
    // Its rows came by its loads while it had no connection - none of them
    // an event a ready connection lost.
    assert.ok(listOnly.count >= 1, JSON.stringify(report.realtime));
    assert.ok(
      (listOnly.byStateAtCapture.waiting ?? 0) +
        (listOnly.byStateAtCapture.connecting ?? 0) +
        (listOnly.byStateAtCapture.reloading ?? 0) >=
        1,
      JSON.stringify(listOnly),
    );
    assert.equal(listOnly.missedOnLiveConnection, 0, JSON.stringify(listOnly));
    assert.equal(
      Object.values(listOnly.byLoad).reduce((sum, count) => sum + count, 0),
      listOnly.count,
    );
  });

  it('finds every realtime place of the address free with places, and gives every one back', async () => {
    const result = await run(['places', '--app-origin', narrowApi, '--count', '2']);
    const report = JSON.parse(result.stdout.trim()).report as {
      count: number;
      freeAtOnce: boolean;
      first: Record<string, number>;
    };

    assert.equal(result.code, 0, result.stderr);
    assert.equal(report.freeAtOnce, true);
    assert.equal(report.first.ready, 2);
    assert.equal(report.first.deleted, 204);
    // Every place given back once the connections have closed.
    for (let wait = 0; narrowPlaces.taken > 0 && wait < 50; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(narrowPlaces.taken, 0);
  });

  it("leaves its sessions behind when it crashes, and cleanup deletes them at the file's origin, calling nothing but /api/sessions/<id>", async () => {
    const file = path.join(dir, 'crash.txt');

    created.length = 0;

    const crash = await run([
      'production',
      '--app-origin',
      plainApi,
      '--receive-origin',
      plainReceive,
      '--page',
      '2',
      '--ci',
      '1',
      '--ramp',
      '0.5',
      '--hold',
      '30',
      '--sessions-file',
      file,
      '--profile',
      QUICK,
      '--crash-after',
      '5',
    ]);

    assert.equal(crash.code, 3);

    const left = pendingSessions(readFileSync(file, 'utf8')).pending;

    assert.ok(left.length >= 2, `left ${left.length}`);

    for (const id of left) {
      assert.equal(await sessionStatus(plainApi, id), 200);
    }

    // Hostile lines beside the real ones: none of them is called.
    writeFileSync(
      file,
      `${readFileSync(file, 'utf8')}created ../../api/sessions\ncreated ${ID}/requests\n` +
        `created ${ID}\n`,
    );
    plainCalls.length = 0;

    // Another origin than the file's run header names is refused, nothing
    // called and nothing recorded.
    const before = readFileSync(file, 'utf8');
    const refused = await run([
      'cleanup',
      '--sessions-file',
      file,
      '--app-origin',
      'http://127.0.0.1:9',
    ]);

    assert.notEqual(refused.code, 0);
    assert.match(
      refused.stderr,
      /--app-origin http:\/\/127\.0\.0\.1:9 is not http:\/\/127\.0\.0\.1:\d+/,
    );
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(plainCalls.length, 0, plainCalls.join());

    // Without --app-origin, the origin the file's run header names.
    const cleanup = await run(['cleanup', '--sessions-file', file]);
    const report = JSON.parse(cleanup.stdout.trim()).report as {
      pending: number;
      deleted: number;
      alreadyGone: number;
      skipped: number;
      left: number;
    };

    assert.equal(cleanup.code, 0, cleanup.stderr);
    assert.equal(report.pending, left.length + 1);
    assert.equal(report.deleted, left.length);
    assert.equal(report.alreadyGone, 1);
    assert.equal(report.skipped, 2);
    assert.equal(report.left, 0);

    for (const call of plainCalls) {
      assert.match(call, /^(DELETE|GET) \/api\/sessions\/[A-Za-z0-9_-]{43}$/);
      assert.ok(SESSION_ID_PATTERN.test(call.split('/').at(-1) ?? ''));
    }

    for (const id of created) {
      assert.equal(await sessionStatus(plainApi, id), 404);
    }

    // A second cleanup finds nothing left.
    const again = JSON.parse(
      (await run(['cleanup', '--sessions-file', file, '--app-origin', plainApi])).stdout.trim(),
    ).report as { pending: number; left: number };

    assert.deepEqual([again.pending, again.left], [0, 0]);
  });
});
