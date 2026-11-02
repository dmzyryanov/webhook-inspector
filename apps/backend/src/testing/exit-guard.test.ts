/**
 * The backend suite's exit guard (`exit-guard.ts`, issue #160), run for real,
 * and the backend `test` script that loads it.
 *
 * Each case writes test files into a temporary directory and runs Node's test
 * runner on them as a process of its own. A `--eval` script would not do: it
 * runs node:test in one process, with no per-file process for the guard to act
 * in.
 *
 * The guard's own cases run `node --import <guard> --test`. The leaking files
 * get a 1 s guard instead of 10 s through the guard's override, so that, run
 * side by side, they add about a second to the suite rather than ten. The
 * clean file keeps the 10 s of a real run, which is what it must not wait for.
 *
 * The script's cases run the workspace's real `test` script, read from
 * `package.json`, on a file that stops its runner with SIGSTOP and then
 * reports more than the pipe to the runner holds: the deterministic form of a
 * runner that falls behind under load (`docs/testing/flakes.md`, F-14). This
 * test holds the runner stopped until the file's process has ended, or for at
 * most `HOLD_MS`, and then lets it go on. Under `--test-force-exit` the file's
 * process ended at once and what the pipe could not take was lost: 9 of 16
 * tests reported, exit 0. Without it the process waits for the runner, and
 * every test is reported.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT_GUARD_MS, EXIT_GUARD_MS_VARIABLE } from './exit-guard.ts';

const BACKEND = fileURLToPath(new URL('../..', import.meta.url));
const GUARD = fileURLToPath(new URL('exit-guard.ts', import.meta.url));

/** The guard's wait for the leaking files below. */
const SHORT_MS = 1_000;

/** A run still going by then has not ended on its own, and is killed. */
const DEADLINE_MS = 30_000;

/** How long the output pipes of a run that has ended have to close. */
const PIPES_MS = 2_000;

/**
 * The longest the runner is held stopped. The file's process cannot end
 * before then unless something ends it, the flag or the guard; and it is well
 * inside the guard's 10 s, so a file that waits for its runner is not ended.
 */
const HOLD_MS = 3_000;

/**
 * Tests the file reports while its runner is stopped. Each one's report is
 * about 6.4 KiB, its name padded to 1000 characters, so the fifteen come to
 * about 100 KiB: more than the 64 KiB a pipe holds on macOS and Linux, and
 * less than that plus the 64 KiB a stream takes before it pushes back. The
 * rest is then in the file's process, written to the runner only once it
 * reads, and nothing pauses the report, so a process ended at once loses it.
 */
const TAIL_TESTS = 15;

/** The variables the file that stops its runner reads. */
const TAIL_DIR = 'WEBHOOK_INSPECTOR_TAIL_DIR';
const TAIL_FAILS = 'WEBHOOK_INSPECTOR_TAIL_FAILS';

const FILES: Record<string, string> = {
  'leaks-a-timer.test.mjs': `
import { it } from 'node:test';

it('leaves a timer running', () => {
  setInterval(() => {}, 60_000);
});
`,
  'passes.test.mjs': `
import { it } from 'node:test';

it('passes', () => {});
`,
  // #31's shape: set-up that is asynchronous before the server exists. With a
  // name pattern that leaves no test to run, after() runs first and closes
  // nothing, and before() then opens a server nothing closes (D132,
  // amendment 2026-09-25).
  'opens-a-server-late.test.mjs': `
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

let server;

before(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(() => server?.close());

describe('the server', () => {
  it('answers', () => {});
});
`,
  // A server on a Unix socket and a connection to it: three pipes of the
  // file's own, besides its stdout and stderr.
  'leaves-a-pipe-open.test.mjs': `
import { connect, createServer } from 'node:net';
import { it } from 'node:test';

it('leaves a pipe open', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen('leak.sock', resolve));
  await new Promise((resolve) => connect('leak.sock', resolve));
});
`,
  'closes-its-server.test.mjs': `
import { createServer } from 'node:http';
import { after, before, it } from 'node:test';

const server = createServer();

before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
after(() => new Promise((resolve) => server.close(resolve)));

it('listens', (t) => {
  t.assert.ok(server.listening);
});
`,
  // Stops its runner, the process that started it, once the runner has had a
  // moment to read what came before, and records its PID so that this test
  // can tell when it has ended. Every test of the tail records that it ran.
  // Only a process the runner started for this file stops its parent.
  'reports-while-its-runner-is-stopped.test.mjs': `
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const dir = process.env.${TAIL_DIR};
const pad = 'x'.repeat(1000);

describe('before the runner is stopped', () => {
  it('stops the runner once it has read what came before', async () => {
    await sleep(200);
    writeFileSync(join(dir, 'file.pid'), String(process.pid));
    if (process.env.NODE_TEST_CONTEXT) {
      process.kill(process.ppid, 'SIGSTOP');
    }
  });
});

describe('while the runner is stopped', () => {
  for (let i = 0; i < ${TAIL_TESTS}; i++) {
    it(\`tail \${i} \${pad}\`, () => {
      appendFileSync(join(dir, 'ran'), \`\${i}\\n\`);
    });
  }

  if (process.env.${TAIL_FAILS} === '1') {
    it('fails at the end of the tail', () => {
      appendFileSync(join(dir, 'ran'), 'failed\\n');
      throw new Error('the failure at the end of the tail');
    });
  }
});
`,
};

const STOPS_ITS_RUNNER = 'reports-while-its-runner-is-stopped.test.mjs';

const dir = mkdtempSync(join(tmpdir(), 'webhook-inspector-exit-guard-'));

for (const [name, source] of Object.entries(FILES)) {
  writeFileSync(join(dir, name), source.trimStart());
}

/**
 * Runs started here whose output has not closed yet. Each leads its own
 * process group, so the group is exactly what this file started.
 */
const running = new Set<ChildProcess>();

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Nothing left in the group.
  }
}

function cleanUp(): void {
  for (const child of running) {
    killGroup(child);
  }

  rmSync(dir, { recursive: true, force: true });
}

// A run cut short, by a test timeout for instance, leaves nothing behind, a
// runner held stopped included: SIGKILL ends a stopped process too.
after(cleanUp);

// Nor does this file's process stopped by a signal, by Ctrl-C or a stopped
// task, when `after()` does not run. Each listener is removed as it runs, so
// the signal raised again ends the process as it would have without one,
// unless something else listens for it; a clean-up that throws does not stop
// that. A SIGKILL cannot be caught; a run still in flight then ends on its
// own, by its guard or as a clean file, as long as the guard works, except a
// runner held stopped, which waits for a SIGCONT or a SIGKILL.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    try {
      cleanUp();
    } finally {
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    }
  });
}

/**
 * Whether a process has ended. A zombie has: it only waits for its parent to
 * reap it, which a stopped runner cannot do.
 */
function hasEnded(pid: number): boolean {
  let state: string;

  try {
    if (existsSync('/proc')) {
      // `pid (name) S …`, and the name may itself contain `) `.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');

      state = stat.slice(stat.lastIndexOf(')') + 2);
    } else {
      state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    }
  } catch {
    // No such process.
    return true;
  }

  return state === '' || state.startsWith('Z');
}

interface Outcome {
  endedOnItsOwn: boolean;
  code: number | null;
  /** From the start of the run to the end of its process. */
  ms: number;
  output: string;
  /**
   * For a file that stops its runner: whether the file's process had ended
   * when the runner was let go on, and the tests of its tail that ran.
   */
  stopped?: { fileEndedFirst: boolean; ran: string[] };
}

interface RunOptions {
  /** Replaces the guard's 10 s; a string is passed as written, valid or not. */
  guardMs?: number | string;
  /** Variables for the run besides the guard's override. */
  env?: Record<string, string>;
  /**
   * The directory the file that stops its runner writes to. With it the run
   * is held stopped until that file's process has ended or `holdMs` is up,
   * and then let go on.
   */
  tailDir?: string;
  /** `HOLD_MS` unless given. */
  holdMs?: number;
}

/**
 * Runs Node with `args` from `cwd` and waits for it to end, killing it at the
 * deadline.
 */
function run(args: string[], cwd: string, options: RunOptions = {}): Promise<Outcome> {
  const env = { ...process.env, ...options.env };
  // Set by the runner for the process it runs this file in. A run that
  // inherited it would report to a runner that is not there instead of
  // starting a process per file, and the guard would have nothing to act in.
  delete env.NODE_TEST_CONTEXT;
  delete env[EXIT_GUARD_MS_VARIABLE];

  if (options.guardMs !== undefined) {
    env[EXIT_GUARD_MS_VARIABLE] = String(options.guardMs);
  }

  if (options.tailDir !== undefined) {
    env[TAIL_DIR] = options.tailDir;
  }

  return new Promise((resolvePromise, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let endedOnItsOwn = true;
    let stopped: Outcome['stopped'];

    running.add(child);
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

    const deadline = setTimeout(() => {
      endedOnItsOwn = false;
      killGroup(child);
    }, DEADLINE_MS);

    if (options.tailDir !== undefined) {
      const { tailDir, holdMs = HOLD_MS } = options;

      void (async () => {
        const pidFile = join(tailDir, 'file.pid');

        while (!existsSync(pidFile) && running.has(child)) {
          await sleep(20);
        }

        if (!running.has(child)) {
          return;
        }

        // The file writes its PID and then stops the runner: give the signal
        // a moment to land before the hold is timed.
        await sleep(20);

        const pid = Number(readFileSync(pidFile, 'utf8'));
        const held = performance.now();
        let fileEndedFirst = hasEnded(pid);

        while (!fileEndedFirst && performance.now() - held < holdMs) {
          await sleep(100);
          fileEndedFirst = hasEnded(pid);
        }

        const ranFile = join(tailDir, 'ran');
        const ran = existsSync(ranFile) ? readFileSync(ranFile, 'utf8').trim().split('\n') : [];

        stopped = { fileEndedFirst, ran };

        if (child.pid !== undefined) {
          process.kill(child.pid, 'SIGCONT');
        }
      })().catch(reject);
    }

    child.on('error', (error) => {
      clearTimeout(deadline);
      running.delete(child);
      reject(error);
    });
    child.on('exit', (code) => {
      const ms = performance.now() - started;

      clearTimeout(deadline);

      const pipes = setTimeout(() => {
        killGroup(child);
        child.stdout.destroy();
        child.stderr.destroy();
      }, PIPES_MS);

      child.on('close', () => {
        clearTimeout(pipes);
        running.delete(child);
        resolvePromise({ endedOnItsOwn, code, ms, output, stopped });
      });
    });
  });
}

/** `node --import <guard> --test` on `files` in the temporary directory. */
function runGuarded(
  files: string[],
  { args = [], ...options }: RunOptions & { args?: string[] } = {},
): Promise<Outcome> {
  return run(
    [`--import=${pathToFileURL(GUARD).href}`, '--test', '--test-reporter=tap', ...args, ...files],
    dir,
    options,
  );
}

/** The backend's `test` script, word by word. */
function testScript(): string[] {
  const manifest = JSON.parse(readFileSync(join(BACKEND, 'package.json'), 'utf8')) as {
    scripts: { test: string };
  };

  return manifest.scripts.test.split(/\s+/);
}

/**
 * The backend's real `test` script, run as npm would run it from the
 * workspace, on the file that stops its runner, in a directory of its own.
 */
async function runScriptOnStoppedRunner(
  name: string,
  options: RunOptions = {},
): Promise<Outcome & { stopped: NonNullable<Outcome['stopped']> }> {
  const words = testScript();

  assert.equal(words[0], 'node', `the test script is \`${words.join(' ')}\``);

  const tailDir = join(dir, name);

  mkdirSync(tailDir);

  const outcome = await run(
    [...words.slice(1), '--test-reporter=tap', join(dir, STOPS_ITS_RUNNER)],
    BACKEND,
    { ...options, tailDir },
  );

  assert.ok(outcome.stopped, `the file never stopped its runner:\n${outcome.output}`);

  return { ...outcome, stopped: outcome.stopped };
}

/** The resources the guard reported, or `undefined` if it reported none. */
function stillActive(output: string): string[] | undefined {
  const reported = /Still active: (\[[^\]]*\])/m.exec(output);

  return reported?.[1] === undefined ? undefined : (JSON.parse(reported[1]) as string[]);
}

/** A number the TAP summary gives, as `# tests 16`. */
function summary(output: string, line: string): number | undefined {
  const value = new RegExp(`^# ${line} (\\d+)$`, 'm').exec(output)?.[1];

  return value === undefined ? undefined : Number(value);
}

describe('the exit guard', { concurrency: true }, () => {
  it('ends a file that leaves a timer running, names the timer and keeps the other results', async () => {
    const outcome = await runGuarded(['leaks-a-timer.test.mjs', 'passes.test.mjs'], {
      guardMs: SHORT_MS,
    });

    assert.ok(outcome.endedOnItsOwn, `still running after ${DEADLINE_MS} ms:\n${outcome.output}`);
    assert.equal(outcome.code, 1, outcome.output);
    assert.ok(outcome.ms >= SHORT_MS, `ended after ${outcome.ms} ms:\n${outcome.output}`);
    // The file's own stdout and stderr are left out, and nothing else.
    assert.deepEqual(stillActive(outcome.output), ['Timeout'], outcome.output);
    // Both tests passed and are reported; the one failure is the leaking file.
    assert.match(outcome.output, /^not ok \d+ - leaks-a-timer\.test\.mjs$/m);
    assert.match(outcome.output, /^# pass 2$/m);
    assert.match(outcome.output, /^# fail 1$/m);
  });

  it("ends #31's shape with a pattern that matches nothing, and names the server", async () => {
    const outcome = await runGuarded(['opens-a-server-late.test.mjs'], {
      args: ['--test-name-pattern=(?!)'],
      guardMs: SHORT_MS,
    });

    assert.ok(outcome.endedOnItsOwn, `still running after ${DEADLINE_MS} ms:\n${outcome.output}`);
    assert.equal(outcome.code, 1, outcome.output);
    assert.deepEqual(stillActive(outcome.output), ['TCPServerWrap'], outcome.output);
    assert.match(outcome.output, /^not ok \d+ - opens-a-server-late\.test\.mjs$/m);
    // No test ran: the pattern was applied.
    assert.match(outcome.output, /^# pass 0$/m);
  });

  it("names every pipe a test left open, leaving out only the file's stdout and stderr", async () => {
    const outcome = await runGuarded(['leaves-a-pipe-open.test.mjs'], { guardMs: SHORT_MS });

    assert.ok(outcome.endedOnItsOwn, `still running after ${DEADLINE_MS} ms:\n${outcome.output}`);
    assert.equal(outcome.code, 1, outcome.output);
    // The listening socket, and the two ends of the connection.
    assert.deepEqual(
      stillActive(outcome.output),
      ['PipeWrap', 'PipeWrap', 'PipeWrap'],
      outcome.output,
    );
  });

  it('does not delay a file that ends by itself', async () => {
    const outcome = await runGuarded(['closes-its-server.test.mjs']);

    assert.ok(outcome.endedOnItsOwn, `still running after ${DEADLINE_MS} ms:\n${outcome.output}`);
    assert.equal(outcome.code, 0, outcome.output);
    assert.ok(
      outcome.ms < EXIT_GUARD_MS,
      `ended after ${outcome.ms} ms, not before the guard's ${EXIT_GUARD_MS} ms:\n${outcome.output}`,
    );
    assert.equal(stillActive(outcome.output), undefined, outcome.output);
    assert.match(outcome.output, /^# pass 1$/m);
  });

  // The override can only shorten the wait: a value above the 10 s, which
  // would weaken every run it leaked into, is refused like one that is no
  // number at all, and fails every file before its tests run.
  for (const value of ['ten', String(EXIT_GUARD_MS + 1)]) {
    it(`fails every file at once when its override is ${JSON.stringify(value)}`, async () => {
      const outcome = await runGuarded(['passes.test.mjs', 'closes-its-server.test.mjs'], {
        guardMs: value,
      });

      assert.ok(outcome.endedOnItsOwn, `still running after ${DEADLINE_MS} ms:\n${outcome.output}`);
      assert.equal(outcome.code, 1, outcome.output);
      assert.ok(
        outcome.output.includes(
          `${EXIT_GUARD_MS_VARIABLE} must be a whole number of milliseconds from 1 to ${EXIT_GUARD_MS}, not ${JSON.stringify(value)}`,
        ),
        outcome.output,
      );
      assert.match(outcome.output, /^# pass 0$/m);
      assert.match(outcome.output, /^# fail 2$/m);
    });
  }
});

describe('the backend test script', { concurrency: true }, () => {
  it("loads the guard into every test file's process", () => {
    const words = testScript();
    const script = words.join(' ');
    const imports = words.flatMap((word, index) => {
      if (word === '--import') {
        return words.slice(index + 1, index + 2);
      }

      return word.startsWith('--import=') ? [word.slice('--import='.length)] : [];
    });
    const guards = imports.filter((specifier) => resolve(BACKEND, specifier) === GUARD);

    assert.equal(words[0], 'node', `the test script is \`${script}\``);
    assert.ok(words.includes('--test'), `the test script is \`${script}\``);
    assert.equal(guards.length, 1, `the test script, \`${script}\`, does not load ${GUARD}`);
    assert.ok(existsSync(resolve(BACKEND, guards[0] ?? '')));
    // In one process for every file there is no NODE_TEST_CONTEXT, and the
    // guard does nothing.
    assert.ok(
      !words.some((word) => word.startsWith('--test-isolation')),
      `the test script, \`${script}\`, changes the runner's isolation`,
    );
  });

  // Issue #160: under `--test-force-exit` the file's process ended at once,
  // and the 9 tests the pipe had taken were all the runner reported, exit 0.
  it('reports every test of a file whose runner has fallen behind, and exits 0', async () => {
    const outcome = await runScriptOnStoppedRunner('falls-behind');
    const tests = TAIL_TESTS + 1;

    assert.ok(outcome.endedOnItsOwn, `still running after ${DEADLINE_MS} ms:\n${outcome.output}`);
    assert.equal(outcome.stopped.ran.length, TAIL_TESTS, outcome.output);
    assert.equal(
      summary(outcome.output, 'tests'),
      tests,
      `the runner reported fewer than the ${tests} tests of the file, the file's process ${outcome.stopped.fileEndedFirst ? 'having ended' : 'still running'} while its runner was stopped:\n${outcome.output}`,
    );
    assert.equal(summary(outcome.output, 'pass'), tests, outcome.output);
    assert.equal(outcome.code, 0, outcome.output);
    assert.equal(stillActive(outcome.output), undefined, outcome.output);
  });

  // Under `--test-force-exit` the run did exit 1, but only the file was named
  // as failing: the test that failed, and its error, were lost with the tail.
  it('names a test that fails at the end of that tail, and exits 1', async () => {
    const outcome = await runScriptOnStoppedRunner('fails-at-the-end', {
      env: { [TAIL_FAILS]: '1' },
    });
    const tests = TAIL_TESTS + 2;

    assert.ok(outcome.endedOnItsOwn, `still running after ${DEADLINE_MS} ms:\n${outcome.output}`);
    assert.deepEqual(outcome.stopped.ran.slice(-1), ['failed'], outcome.output);
    assert.equal(summary(outcome.output, 'tests'), tests, outcome.output);
    assert.equal(summary(outcome.output, 'fail'), 1, outcome.output);
    assert.match(outcome.output, /^ {4}not ok \d+ - fails at the end of the tail$/m);
    assert.ok(outcome.output.includes('the failure at the end of the tail'), outcome.output);
    assert.equal(outcome.code, 1, outcome.output);
  });

  // A runner that has not read a file's report by the end of the guard's wait
  // makes that file fail, naming the write still waiting, rather than report
  // fewer tests with exit 0. The runner is held until the guard has ended the
  // file's process, however late a loaded machine makes it.
  it('fails a file whose runner falls behind beyond the guard, naming the write that waits', async () => {
    const outcome = await runScriptOnStoppedRunner('beyond-the-guard', {
      guardMs: SHORT_MS,
      holdMs: DEADLINE_MS - 5_000,
    });
    const active = stillActive(outcome.output) ?? [];

    assert.ok(outcome.endedOnItsOwn, `still running after ${DEADLINE_MS} ms:\n${outcome.output}`);
    assert.ok(outcome.stopped.fileEndedFirst, outcome.output);
    assert.equal(outcome.stopped.ran.length, TAIL_TESTS, outcome.output);
    assert.equal(outcome.code, 1, outcome.output);
    assert.ok(
      active.some((entry) => entry.endsWith('WriteWrap')),
      `the guard named ${JSON.stringify(active)}:\n${outcome.output}`,
    );
    assert.ok(
      outcome.output.includes('a runner that fell behind'),
      `the guard did not say what a WriteWrap is:\n${outcome.output}`,
    );
    assert.match(
      outcome.output,
      /^not ok \d+ - .*reports-while-its-runner-is-stopped\.test\.mjs$/m,
    );
  });
});
