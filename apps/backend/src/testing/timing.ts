/**
 * A bound on the time one check of made-up input takes, which the machine's
 * load does not decide (D203). The check is run once; a run over the bound is
 * run again, up to `TIMED_RUNS` runs in all, and the fastest is held to the
 * bound. A collection, or another test file on the same cores - the suite
 * runs its files at once, locally and in CI - can stop one run for longer than
 * the check itself takes, but not every run; a check worse than linear is over
 * the bound on every run, and at 1 MiB a quadratic one by seconds.
 *
 * The check must give the same answer every time it runs: the value of the
 * last run is answered.
 *
 * Not a test file itself: only `*.test.ts` files import it.
 */
import assert from 'node:assert/strict';

/** Runs of one check, at most, before its fastest is held to the bound. */
export const TIMED_RUNS = 5;

export function withinBound<T>(
  boundMs: number,
  run: () => T,
  now: () => number = () => performance.now(),
): T {
  let fastest = Number.POSITIVE_INFINITY;

  for (let attempt = 1; ; attempt += 1) {
    const started = now();
    const value = run();

    fastest = Math.min(fastest, now() - started);

    if (fastest < boundMs) {
      return value;
    }

    if (attempt === TIMED_RUNS) {
      assert.fail(
        `took ${fastest.toFixed(1)} ms at best in ${TIMED_RUNS} runs, over the ${boundMs} ms bound`,
      );
    }
  }
}
