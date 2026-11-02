/**
 * The worst-case measurement of #130, `scripts/measure-header-queries.mjs`
 * (D250): its pure parts - the bounds criterion 8 fixed before the run, the
 * percentiles, the never-matching conditions, and the verdict of a phase,
 * which set `MAX_CONCURRENT_HEADER_QUERIES`. The measurement itself needs
 * Docker and runs by hand, as D201's and D232's do.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REQUEST_QUERY_MAX_CONDITIONS } from '@webhook-inspector/shared';
import {
  BOUNDS,
  neverMatching,
  phaseFailures,
  timings,
  type BackendReading,
  type Phase,
} from '../../../scripts/measure-header-queries.mjs';
import { parseQueryBody } from './modules/requests/list-query.ts';

const RUNNING: BackendReading = {
  restartCount: 0,
  startedAt: '2026-10-20T13:47:32.065464791Z',
  oomKilled: false,
  status: 'running',
  memoryPeakMiB: 104.3,
  vmHwmMiB: 132.5,
};

/** A phase that held every bound: 400 captures stored, the slowest 310 ms. */
function passing(): Phase {
  return {
    captures: {
      sent: 400,
      outcomes: { 200: 400 },
      stored: 400,
      ms: { count: 400, p50: 63.3, p95: 184.9, p99: 258.3, max: 310.9 },
    },
    ready: { outcomes: { 200: 40 }, ms: { count: 40, p50: 4.1, p95: 77.5, p99: 85.8, max: 85.8 } },
  };
}

describe('the measurement of header-only queries (D250)', () => {
  it('holds the bounds criterion 8 and D201 set', () => {
    assert.deepEqual(BOUNDS, {
      captureP95Ms: 200,
      captureMaxMs: 500,
      readyMaxMs: 1000,
      backendMemoryMiB: 512,
    });
  });

  it('reads percentiles as the nearest rank, and nothing from no timing', () => {
    assert.deepEqual(timings([]), { count: 0, p50: null, p95: null, p99: null, max: null });
    assert.deepEqual(timings(Array.from({ length: 100 }, (_, index) => 100 - index)), {
      count: 100,
      p50: 50,
      p95: 95,
      p99: 99,
      max: 100,
    });
    assert.deepEqual(timings([7]), { count: 1, p50: 7, p95: 7, p99: 7, max: 7 });
  });

  it('asks 8 header conditions a query takes, whose names every stored request has and whose values none has', () => {
    for (const shape of ['a', 'b'] as const) {
      const headers = neverMatching(shape);
      const query = parseQueryBody(JSON.stringify({ headers }));

      assert.equal(headers.length, REQUEST_QUERY_MAX_CONDITIONS, shape);
      assert.equal(query.bodies.length, 0, `${shape}: a header-only query`);
      assert.equal(new Set(headers.map(({ value }) => value)).size, headers.length);

      for (const { name, value } of headers) {
        // Another letter case of a stored name: `a`, or `x-long-1` to `x-long-4`.
        assert.notEqual(name, name.toLowerCase(), `${shape}: ${name}`);
        assert.match(name.toLowerCase(), shape === 'a' ? /^a$/ : /^x-long-[1-4]$/);
        // No stored value: empty in shape a, 4000 bytes of `v` in shape b.
        assert.match(value, /^never-\d$/);
      }
    }
  });

  it('passes a phase that held every bound', () => {
    assert.deepEqual(phaseFailures(passing(), RUNNING, RUNNING), []);
  });

  it('fails a phase for each bound it broke', () => {
    const cases: [string, (phase: Phase, after: BackendReading) => void, RegExp][] = [
      ['a capture not stored', (phase) => (phase.captures.stored = 399), /^captures: /],
      [
        'a capture refused',
        (phase) => (phase.captures.outcomes = { 200: 399, 503: 1 }),
        /^captures: 400 sent, 399 answered 200/,
      ],
      ['the 95th percentile', (phase) => (phase.captures.ms.p95 = 204.1), /^capture p95 204.1 ms/],
      ['the slowest capture', (phase) => (phase.captures.ms.max = 500), /^capture max 500 ms/],
      ['no capture', (phase) => (phase.captures.ms = timings([])), /^capture p95 null/],
      ['a /readyz not 200', (phase) => (phase.ready.outcomes = { 200: 39, 503: 1 }), /^\/readyz: /],
      ['a slow /readyz', (phase) => (phase.ready.ms.max = 1000), /^\/readyz max 1000 ms/],
      ['an OOM kill', (_, after) => (after.oomKilled = true), /OOM-killed true/],
      ['a stopped backend', (_, after) => (after.status = 'exited'), /^backend exited/],
      ['a new process', (_, after) => (after.startedAt = 'later'), /^backend restarted$/],
      ['memory.peak', (_, after) => (after.memoryPeakMiB = 512), /^backend memoryPeakMiB 512/],
      ['VmHWM', (_, after) => (after.vmHwmMiB = 600), /^backend vmHwmMiB 600/],
      ['an unread memory', (_, after) => delete after.vmHwmMiB, /^backend vmHwmMiB undefined/],
    ];

    for (const [what, breakIt, expected] of cases) {
      const phase = passing();
      const after = { ...RUNNING };

      breakIt(phase, after);

      const failures = phaseFailures(phase, RUNNING, after);

      assert.ok(
        failures.some((failure) => expected.test(failure)),
        `${what}: ${JSON.stringify(failures)}`,
      );
    }
  });
});
