/**
 * Ends a backend test file whose process outlives its tests, and names what
 * keeps it alive (issue #160; D132, amendment 2026-10-20). The frontend's
 * `apps/frontend/src/exit-guard.ts` (#63) is the same guard.
 *
 * The backend suite ran with `--test-force-exit` until #160. That flag ends a
 * file's process as soon as its tests are done, and the report the process
 * had handed to its stdout but not yet written to the runner went with it:
 * under load the tail of a file's report was lost and the run still exited 0,
 * locally and in CI (`docs/testing/flakes.md`, F-02 and F-14). Without the
 * flag nothing else ends a file's process that a handle a test leaked — a
 * timer, a socket, a pool or a server closed on only one path — keeps alive,
 * and then the run never ends: #31's incident, a `node --test` alive for seven
 * hours.
 *
 * The workspace's `test` script loads this module into every test file's
 * process with `node --import`. There it registers a root-level `after()`,
 * which starts a timer once the file's tests have ended. The timer is
 * unref'd, so it holds nothing: a file that ends by itself is not delayed.
 * A process still alive when it fires writes the resources keeping it alive
 * to stderr, synchronously, and exits with code 1, so the runner reports that
 * file as failed, the report names the handle, and the run ends.
 *
 * Only a process the runner started for one file carries `NODE_TEST_CONTEXT`,
 * and only there does this module do anything. The runner's own process does
 * not load `--import` modules at all on Node 24.19, and under
 * `--test-isolation=none` or outside a test run the variable is unset. A bare
 * `node --test` on a backend file does not load the guard either, so a single
 * file is run through the script, which also carries the suite's timeout:
 * `npm test -w @webhook-inspector/backend -- src/<path>.test.ts`, or for a task in the
 * delivery queue `node scripts/db.mjs task-test <task> -- src/<path>.test.ts`.
 *
 * Its limits, besides a run that does not load it:
 * - A file that registers no test. Its root-level `after()` hooks run only
 *   once the process has nothing left to do, so a handle it opens keeps the
 *   timer from ever starting.
 * - A process a test started that still holds the file's stdout or stderr,
 *   given them with `stdio: 'inherit'` and unref'd, say. The file's own
 *   process ends, and the guard with it, while the runner waits for that
 *   output to close. `test-files-exit.test.ts` checks every backend file for
 *   this under a name pattern that leaves it no test.
 * - The 10 s count from the file's first root-level `after()`: this one,
 *   registered before any of the file's own code runs. A file whose own
 *   root-level `after()` takes longer than that to close what it opened is
 *   ended as a leak.
 * - A runner that has not read the file's report 10 s after its tests: the
 *   writes still waiting for it keep the process alive, and the guard then
 *   ends it as a leak, so a report the runner was too slow to take is a
 *   failed file, never a shorter count with exit 0.
 *
 * The name keeps the module out of the runner's discovery, which collects
 * `*.test.*`, `*-test.*`, `*_test.*`, `test-*.*`, `test.*` and anything under
 * a `test/` directory: `test-exit-guard.ts` would run as a test file.
 */
import { writeSync } from 'node:fs';
import { after } from 'node:test';
import { setTimeout } from 'node:timers';

/** How long a test file's process may outlive its tests. */
export const EXIT_GUARD_MS = 10_000;

/**
 * Shortens the 10 s, in milliseconds, for the guard's own test
 * (`exit-guard.test.ts`): its leaking files would otherwise add ten seconds to
 * every run of the suite. Real runs leave it unset. It can only shorten the
 * wait: a longer one would weaken every run it leaked into, and one past a
 * timer's limit would fire after 1 ms.
 */
export const EXIT_GUARD_MS_VARIABLE = 'WEBHOOK_INSPECTOR_EXIT_GUARD_MS';

function delayMs(): number {
  const value = process.env[EXIT_GUARD_MS_VARIABLE];

  if (value === undefined) {
    return EXIT_GUARD_MS;
  }

  const ms = Number(value);

  // A process that throws here fails its file at once, naming the variable.
  if (!Number.isInteger(ms) || ms < 1 || ms > EXIT_GUARD_MS) {
    throw new Error(
      `${EXIT_GUARD_MS_VARIABLE} must be a whole number of milliseconds from 1 to ${EXIT_GUARD_MS}, not ${JSON.stringify(value)}`,
    );
  }

  return ms;
}

/**
 * `entries` less one occurrence of each of `held`. `getActiveResourcesInfo()`
 * gives types, not identities, so a count is all there is to subtract.
 */
function openedSince(entries: string[], held: string[]): string[] {
  const left = [...held];

  return entries.filter((entry) => {
    const index = left.indexOf(entry);

    if (index === -1) {
      return true;
    }

    left.splice(index, 1);
    return false;
  });
}

if (process.env.NODE_TEST_CONTEXT) {
  const ms = delayMs();

  // What the process holds before any code of the file has run: its stdout
  // and stderr, the pipes to the runner, `["PipeWrap","PipeWrap"]` on Node
  // 24.19. Every file's process holds them to the end, so the report leaves
  // out exactly these entries, once each, rather than every `PipeWrap`: a pipe
  // opened later, to a process a test started for instance, is still named.
  const ownStdio = process.getActiveResourcesInfo();

  after(() => {
    setTimeout(() => {
      const active = openedSince(process.getActiveResourcesInfo(), ownStdio);
      // `SimpleWriteWrap` on Node 24.19: a write its reader has not taken,
      // which a test's leak and a runner that fell behind both leave.
      const waiting = active.some((entry) => entry.endsWith('WriteWrap'))
        ? " A WriteWrap is a write its reader has not taken yet, such as this file's report to a runner that fell behind."
        : '';

      try {
        writeSync(
          2,
          `Exit guard (apps/backend/src/testing/exit-guard.ts): this test file's process was still running ${ms} ms after its tests ended, and exits with code 1. Still active: ${JSON.stringify(active)}${waiting}\n`,
        );
      } finally {
        process.exit(1);
      }
    }, ms).unref();
  });
}
