// A reporter for `node --test` that bounds the whole run and, when the bound
// is reached, says which tests were running (#122). Two jobs of
// `.gitlab/ci/validate.yml` run their test files with it beside the spec
// reporter, `delivery-checks` and the group split from it (D241),
// `operations-tests`:
//
//   TEST_RUN_LIMIT_SECONDS=1500 node --test \
//     --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=./scripts/test-run-limit.mjs --test-reporter-destination=stderr …
//
// A test's own time limit (`--test-timeout`, or a file's `timeout`) runs in
// the process of its file, so it cannot fire while that process is blocked in
// a synchronous call, and nothing at all bounds a file. This reporter runs in
// the runner's process, which only reads the files' events and is never
// blocked by a test. It says its limit at the start. At the limit it writes,
// synchronously, every file still running and the tests of it that have
// started and not ended, with their subtests, and then sends the runner
// SIGTERM: the runner stops the files' processes, prints `Interrupted while
// running:` with the files' names and exits 1. The summary, and the results
// the spec reporter still holds back to keep the files' order, are then lost:
// the runner exits before a second reporter has written them (Node 24). If the
// runner is still there 30 s later, SIGKILL. A test blocked in a synchronous
// call from its very start may not have reported that it began — its process
// cannot write while blocked — so for a file without a running test the last
// test of it to end is named. A test is printed with its line, unless it is a
// top-level test whose line another top-level test of its file, of another
// name, was reported at too: the line of a wrapper that calls `node:test` for
// them all, which names none of them (#220); a loop that defines tests of
// several names loses its line the same way, and their names still tell them
// apart. An unset or malformed limit throws at the start, which ends the run
// with the error at once.

import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

// The longest a name is printed, in characters, and the most lines a report
// holds: what is printed at the limit stays readable whatever a test is named
// and however many run at once.
export const MAX_NAME = 200;
export const MAX_LINES = 60;
// From one second to a day.
export const MAX_LIMIT_SECONDS = 86_400;

/** The limit from `TEST_RUN_LIMIT_SECONDS`, a whole number of seconds; throws otherwise. */
export function limitSeconds(env) {
  const text = env.TEST_RUN_LIMIT_SECONDS ?? '';
  const seconds = /^[1-9][0-9]{0,5}$/.test(text) ? Number(text) : NaN;
  if (!(seconds <= MAX_LIMIT_SECONDS)) {
    throw new Error(
      `test-run-limit: TEST_RUN_LIMIT_SECONDS must be a whole number of seconds from 1 to ${MAX_LIMIT_SECONDS}`,
    );
  }
  return seconds;
}

// Line breaks, other control characters and a half of a surrogate pair alone.
const UNPRINTABLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * A name as one printable line of at most MAX_NAME characters: what could
 * break the line or the log escaped as `\uXXXX`, and a longer one cut, with
 * its length in all. Only its start is looked at, so the cost does not grow
 * with the name.
 */
export function printable(name) {
  const text = String(name ?? '');
  const shown = text
    .slice(0, MAX_NAME + 1)
    .replace(UNPRINTABLE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (text.length <= MAX_NAME && shown.length <= MAX_NAME) return shown;
  let cut = MAX_NAME - 1;
  // Never between the halves of a surrogate pair.
  if (/[\ud800-\udbff]/.test(shown[cut - 1])) cut -= 1;
  return `${shown.slice(0, cut)}… (${text.length} characters in all)`;
}

// What `places` holds for a line two top-level tests of other names share.
const SHARED = Symbol('shared');

/**
 * Follows a run's events: the files running and, in each, the tests that have
 * started and not ended. `see` takes an event; `report` describes what is
 * running as lines of text. A start and an end each cost the same however
 * many tests run, in whatever order they end.
 */
export function tracker({ cwd = process.cwd() } = {}) {
  // The file's path → { name, running, open, last, places }. `running` holds
  // its tests in the order they started, as { name, nesting, line }; `open`
  // finds them by nesting, then name, the last to start of that name on top.
  // `places` holds each line a top-level test of the file was queued or
  // started at, with the name of the first seen there, or SHARED once one of
  // another name was too. The runner reports each top-level test as queued
  // when the file defines it, so a wrapper's line is known to be shared even
  // when the first test through it is the one stuck; otherwise the lines seen
  // so far decide.
  const files = new Map();
  // A file's own entry is the runner's: at nesting 0, named by its path.
  const isFile = (data) =>
    data.nesting === 0 &&
    typeof data.file === 'string' &&
    resolve(cwd, String(data.name)) === data.file;
  const entry = (file, name = file) => {
    if (!files.has(file)) {
      files.set(file, { name, running: new Set(), open: new Map(), last: null, places: new Map() });
    }
    return files.get(file);
  };
  return {
    see(event) {
      const { type, data } = event ?? {};
      if (data === null || typeof data !== 'object') return;
      if (type !== 'test:enqueue' && type !== 'test:dequeue' && type !== 'test:complete') return;
      const file = typeof data.file === 'string' ? data.file : '(no file)';
      if (isFile(data)) {
        if (type === 'test:dequeue') entry(file, data.name);
        else if (type === 'test:complete') files.delete(file);
        return;
      }
      const tests = entry(file);
      const nesting = Number(data.nesting) || 0;
      if (type !== 'test:complete' && nesting === 0 && Number.isInteger(data.line)) {
        const { places } = tests;
        if (!places.has(data.line)) places.set(data.line, data.name);
        else if (places.get(data.line) !== data.name) places.set(data.line, SHARED);
      }
      if (type === 'test:enqueue') return;
      if (!tests.open.has(nesting)) tests.open.set(nesting, new Map());
      const named = tests.open.get(nesting);
      if (type === 'test:dequeue') {
        const test = { name: data.name, nesting, line: data.line };
        tests.running.add(test);
        if (named.has(data.name)) named.get(data.name).push(test);
        else named.set(data.name, [test]);
        return;
      }
      const same = named.get(data.name);
      if (same !== undefined) {
        tests.running.delete(same.pop());
        if (same.length === 0) named.delete(data.name);
      }
      if (named.size === 0) tests.open.delete(nesting);
      tests.last = data.name;
    },
    report(seconds) {
      const lines = [];
      for (const [, { name, running, last, places }] of files) {
        lines.push(`  ${printable(name)}`);
        if (running.size === 0) {
          lines.push(
            last === null
              ? '    no test of it has reported starting: one may be blocked from its start'
              : `    no test of it is reported running; the last to end was: ${printable(last)}`,
          );
        }
        for (const test of running) {
          const wrapper = test.nesting === 0 && places.get(test.line) === SHARED;
          const where = Number.isInteger(test.line) && !wrapper ? ` (line ${test.line})` : '';
          lines.push(
            `${'  '.repeat(Math.max(0, Math.min(test.nesting, 10)) + 2)}${printable(test.name)}${where}`,
          );
        }
      }
      if (files.size === 0) lines.push('  no file is reported running');
      const shown =
        lines.length > MAX_LINES
          ? [...lines.slice(0, MAX_LINES - 1), `  … and ${lines.length - MAX_LINES + 1} more lines`]
          : lines;
      return `\ntest-run-limit: the run's ${seconds} s are up; it is stopped with these still running:\n${shown.join('\n')}\n\n`;
    },
  };
}

export default async function* testRunLimit(source) {
  const seconds = limitSeconds(process.env);
  const track = tracker();
  // Said at the start, so that the log shows the bound before it is needed.
  yield `test-run-limit: this run is stopped after ${seconds} s, naming the tests still running\n`;
  const timer = setTimeout(() => {
    writeSync(2, track.report(seconds));
    process.kill(process.pid, 'SIGTERM');
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 30_000).unref();
  }, seconds * 1000);
  timer.unref();
  try {
    for await (const event of source) track.see(event);
  } finally {
    clearTimeout(timer);
  }
}
