/**
 * Every backend test file ends its own process when a name pattern leaves it
 * no test to run (issue #31, D132).
 *
 * `node --test --test-name-pattern=…` is how a test is re-run on its own, and
 * it is the run that turned a test file into a process that never exits. Node's
 * runner (24.19) starts a file's top-level `before()` as soon as it is
 * registered, but runs the top-level `after()` as soon as the file's last
 * top-level suite has finished, without waiting for a `before()` still in
 * progress. When the pattern matches nothing in a file, every suite is filtered
 * out and finishes at once: `after()` runs first and closes nothing, and
 * `before()` then opens a listener that stays open for good. On the night of
 * 2026-09-23 a `sessions.test.ts` run stayed alive for seven hours that way,
 * its server's ephemeral port read as an inspector's. Without a pattern every
 * suite waits for `before()`, which is why the full suite, and CI, never hung.
 *
 * The files whose top-level `before()` is asynchronous therefore make their
 * `after()` wait for it. This test holds them, and every file added later, to
 * that: it runs each other test file on its own, with a pattern no test name
 * matches and without `--test-force-exit`, and fails for a file that has not
 * ended by the deadline, that ends with a failure, that ran a test anyway, or
 * that left a process of its own running. At the deadline the file's process
 * is asked for the resources still keeping it alive, so the failure names the
 * handle.
 *
 * "Every file" means every `*.test.ts` under `src/`, the one naming this
 * backend uses. A file named after Node's other discovery patterns
 * (`*-test.ts`, `*_test.ts`, `test-*.ts`, anything under a `test/` directory)
 * would run in the suite unchecked here.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'src/test-files-exit.test.ts';

/** An empty negative lookahead fails at every position: it matches no name. */
const NO_TEST_NAME = '(?!)';

/** A file with nothing to run ends within a second or two; the rest is room for a busy runner. */
const DEADLINE_MS = 30_000;

/** How long a process asked for its resources has to print them before it is killed. */
const REPORT_MS = 2_000;

/** How long the output pipes of a process that has ended have to close. */
const PIPES_MS = 2_000;

/**
 * Loaded into each process run here. It prints the resources keeping the
 * process alive when asked by signal; the listener itself keeps nothing alive.
 */
const REPORT_ON_SIGNAL = `data:text/javascript,${encodeURIComponent(
  "process.on('SIGUSR2', () => console.error('still active: ' + " +
    'JSON.stringify(process.getActiveResourcesInfo())));',
)}`;

const testFiles = readdirSync(new URL('.', import.meta.url), { recursive: true })
  .map((path) => `src/${path}`)
  .filter((path) => path.endsWith('.test.ts') && path !== SELF)
  .sort();

/**
 * Processes started here whose output has not closed yet: until it has, a
 * process one of them started may still be holding it.
 */
const running = new Set<ChildProcess>();

/**
 * Kills a process and everything it started. Each one run here leads its own
 * process group, so the group is exactly what this file started.
 */
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

// A run cut short, by a test timeout for instance, leaves nothing behind.
after(() => {
  for (const child of running) {
    killGroup(child);
  }
});

interface Outcome {
  endedOnItsOwn: boolean;
  leftAProcess: boolean;
  code: number | null;
  output: string;
}

/**
 * Runs Node with `args` from the backend directory, as a file of its own and
 * with the pattern above, and waits for it to end. A process still running at
 * the deadline is asked for its resources and then killed. One that ended but
 * whose output pipes stay open has left a process of its own holding them,
 * which is killed too, rather than waited for.
 */
function runAlone(args: string[], deadlineMs = DEADLINE_MS): Promise<Outcome> {
  const env = { ...process.env };
  // Set by the runner for the files it starts. A process that inherits it
  // reports to a runner that is not there instead of running on its own.
  delete env.NODE_TEST_CONTEXT;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        `--import=${REPORT_ON_SIGNAL}`,
        '--test-reporter=tap',
        `--test-name-pattern=${NO_TEST_NAME}`,
        ...args,
      ],
      { cwd: BACKEND, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let endedOnItsOwn = true;
    let leftAProcess = false;
    let kill: NodeJS.Timeout | undefined;

    const collect = (chunk: Buffer): void => {
      output += chunk.toString();

      // Asked and answered: no need to wait out REPORT_MS.
      if (kill !== undefined && /still active: \[.*\]/.test(output)) {
        clearTimeout(kill);
        killGroup(child);
      }
    };

    running.add(child);
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const deadline = setTimeout(() => {
      endedOnItsOwn = false;
      child.kill('SIGUSR2');
      kill = setTimeout(() => killGroup(child), REPORT_MS);
    }, deadlineMs);

    child.on('error', (error) => {
      clearTimeout(deadline);
      running.delete(child);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(deadline);
      clearTimeout(kill);

      const pipes = setTimeout(() => {
        leftAProcess = true;
        killGroup(child);
        child.stdout.destroy();
        child.stderr.destroy();
      }, PIPES_MS);

      child.on('close', () => {
        clearTimeout(pipes);
        running.delete(child);
        resolve({ endedOnItsOwn, leftAProcess, code, output });
      });
    });
  });
}

describe('a test file with no test left to run by a name pattern', { concurrency: 4 }, () => {
  for (const file of testFiles) {
    it(`ends its own process: ${file}`, async () => {
      const outcome = await runAlone([file]);

      assert.ok(
        outcome.endedOnItsOwn,
        `${file} was still running after ${DEADLINE_MS} ms:\n${outcome.output}`,
      );
      assert.ok(!outcome.leftAProcess, `${file} left a process running:\n${outcome.output}`);
      assert.equal(outcome.code, 0, `${file} ended with code ${outcome.code}:\n${outcome.output}`);
      // Without this a pattern that stopped being applied would pass here:
      // every test would run, and pass.
      assert.match(outcome.output, /^# tests 0$/m, `${file} ran tests:\n${outcome.output}`);
    });
  }
});

describe('the check itself', { concurrency: true }, () => {
  // Five seconds is ample for Node to start and load the signal listener,
  // which it does before any of the file's own code runs.
  it('reports a file that leaves a timer running, and names the timer', async () => {
    const leak =
      "import { it } from 'node:test'; setInterval(() => {}, 60_000); it('never run', () => {});";
    const outcome = await runAlone(['--input-type=module', '--eval', leak], 5_000);

    assert.equal(outcome.endedOnItsOwn, false);
    assert.match(outcome.output, /still active: \[.*"Timeout".*\]/);
  });

  it('reports a file that ends but leaves a process of its own running, and stops it', async () => {
    const leak = [
      "import { spawn } from 'node:child_process';",
      "import { it } from 'node:test';",
      "const left = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'inherit' });",
      'left.unref();',
      'console.log(`left pid ${left.pid}`);',
      "it('never run', () => {});",
    ].join('\n');
    const outcome = await runAlone(['--input-type=module', '--eval', leak]);
    const left = Number(/left pid (\d+)/.exec(outcome.output)?.[1]);

    assert.ok(outcome.endedOnItsOwn);
    assert.ok(outcome.leftAProcess);
    assert.ok(left > 0, outcome.output);

    // Killed with its group; a signal takes a moment to land.
    const gone = Date.now() + 5_000;

    while (isRunning(left) && Date.now() < gone) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(isRunning(left), false, `pid ${left} was still running`);
  });
});

/**
 * Whether a process is running. A zombie is not: it has ended and only waits
 * for a parent to reap it, which an orphan's new parent may never do.
 */
function isRunning(pid: number): boolean {
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
    return false;
  }

  return state !== '' && !state.startsWith('Z');
}
