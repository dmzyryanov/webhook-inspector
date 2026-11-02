/**
 * The frontend suite's exit guard (`exit-guard.ts`, issue #63), run for real.
 *
 * Each case writes test files into a temporary directory and runs
 * `node --import <guard> --test` on them, the form of the workspace's `test`
 * script, as a process of its own. A `--eval` script would not do: it runs
 * node:test in one process, with no per-file process for the guard to act in.
 *
 * The leaking files get a 1 s guard instead of 10 s through the guard's
 * override, so that, run side by side, they add about a second to the suite
 * rather than ten. The clean file keeps the 10 s of a real run, which is what
 * it must not wait for.
 *
 * The last test holds the `test` script to loading the guard.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT_GUARD_MS, EXIT_GUARD_MS_VARIABLE } from './exit-guard.ts';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const GUARD = fileURLToPath(new URL('exit-guard.ts', import.meta.url));

/** The guard's wait for the leaking files below. */
const SHORT_MS = 1_000;

/** A run still going by then has not ended on its own, and is killed. */
const DEADLINE_MS = 30_000;

/** How long the output pipes of a run that has ended have to close. */
const PIPES_MS = 2_000;

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
};

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

// A run cut short, by a test timeout for instance, leaves nothing behind.
after(cleanUp);

// Nor does this file's process stopped by a signal, by Ctrl-C or a stopped
// task, when `after()` does not run. Each listener is removed as it runs, so
// the signal raised again ends the process as it would have without one,
// unless something else listens for it; a clean-up that throws does not stop
// that. A SIGKILL cannot be caught; a run still in flight then ends on its
// own, by its guard or as a clean file, as long as the guard works.
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

interface Outcome {
  endedOnItsOwn: boolean;
  code: number | null;
  /** From the start of the run to the end of its process. */
  ms: number;
  output: string;
}

/**
 * Runs `node --import <guard> --test` on `files` in the temporary directory
 * and waits for it to end, killing it at the deadline. `guardMs` replaces the
 * guard's 10 s; a string is passed as written, valid or not.
 */
function runGuarded(
  files: string[],
  { args = [], guardMs }: { args?: string[]; guardMs?: number | string } = {},
): Promise<Outcome> {
  const env = { ...process.env };
  // Set by the runner for the process it runs this file in. A run that
  // inherited it would report to a runner that is not there instead of
  // starting a process per file, and the guard would have nothing to act in.
  delete env.NODE_TEST_CONTEXT;
  delete env[EXIT_GUARD_MS_VARIABLE];

  if (guardMs !== undefined) {
    env[EXIT_GUARD_MS_VARIABLE] = String(guardMs);
  }

  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(
      process.execPath,
      [`--import=${pathToFileURL(GUARD).href}`, '--test', '--test-reporter=tap', ...args, ...files],
      { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let endedOnItsOwn = true;

    running.add(child);
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

    const deadline = setTimeout(() => {
      endedOnItsOwn = false;
      killGroup(child);
    }, DEADLINE_MS);

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
        resolve({ endedOnItsOwn, code, ms, output });
      });
    });
  });
}

/** The resources the guard reported, or `undefined` if it reported none. */
function stillActive(output: string): string[] | undefined {
  const reported = /Still active: (\[.*\])$/m.exec(output);

  return reported?.[1] === undefined ? undefined : (JSON.parse(reported[1]) as string[]);
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

describe('the frontend test script', () => {
  it("loads the guard into every test file's process", () => {
    const manifest = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8')) as {
      scripts: { test: string };
    };
    const script = manifest.scripts.test;
    const words = script.split(/\s+/);
    const imports = words.flatMap((word, index) => {
      if (word === '--import') {
        return words.slice(index + 1, index + 2);
      }

      return word.startsWith('--import=') ? [word.slice('--import='.length)] : [];
    });
    const guards = imports.filter((specifier) => resolve(FRONTEND, specifier) === GUARD);

    assert.equal(words[0], 'node', `the test script is \`${script}\``);
    assert.ok(words.includes('--test'), `the test script is \`${script}\``);
    assert.equal(guards.length, 1, `the test script, \`${script}\`, does not load ${GUARD}`);
    assert.ok(existsSync(resolve(FRONTEND, guards[0] ?? '')));
    // In one process for every file there is no NODE_TEST_CONTEXT, and the
    // guard does nothing.
    assert.ok(
      !words.some((word) => word.startsWith('--test-isolation')),
      `the test script, \`${script}\`, changes the runner's isolation`,
    );
  });
});
