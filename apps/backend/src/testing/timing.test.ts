/**
 * `withinBound`, on a made-up clock: a run over the bound is run again, the
 * fastest of at most `TIMED_RUNS` counts, and a check over the bound on every
 * run fails.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TIMED_RUNS, withinBound } from './timing.ts';

/** A clock whose runs take `durations` milliseconds, one after the other. */
function clock(durations: number[]): { now: () => number; runs: () => number } {
  let time = 0;
  let reads = 0;

  return {
    now() {
      reads += 1;

      // Every second read ends a run: the time moves on by its duration.
      if (reads % 2 === 0) {
        time += durations[reads / 2 - 1] ?? 0;
      }

      return time;
    },
    runs: () => reads / 2,
  };
}

describe('withinBound', () => {
  it('runs a check under the bound once and answers its value', () => {
    const made = clock([40]);
    let calls = 0;

    assert.equal(
      withinBound(
        100,
        () => {
          calls += 1;

          return 'answer';
        },
        made.now,
      ),
      'answer',
    );
    assert.equal(calls, 1);
    assert.equal(made.runs(), 1);
  });

  it('runs a check over the bound again, and passes once a run is under it', () => {
    const made = clock([150, 400, 99.9]);

    assert.equal(
      withinBound(100, () => 7, made.now),
      7,
    );
    assert.equal(made.runs(), 3);
  });

  it(`fails a check over the bound in each of ${TIMED_RUNS} runs, naming the fastest`, () => {
    const made = clock([300, 180, 100, 250, 120, 50]);

    assert.throws(() => withinBound(100, () => null, made.now), {
      name: 'AssertionError',
      message: `took 100.0 ms at best in ${TIMED_RUNS} runs, over the 100 ms bound`,
    });
    // The sixth duration is never reached.
    assert.equal(made.runs(), TIMED_RUNS);
  });

  it('lets a check that throws fail at once', () => {
    const made = clock([10]);
    let calls = 0;

    assert.throws(
      () =>
        withinBound(
          100,
          () => {
            calls += 1;
            throw new RangeError('made up');
          },
          made.now,
        ),
      RangeError,
    );
    assert.equal(calls, 1);
  });
});
