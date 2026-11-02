// `npm run db:up` and `npm run db:rebuild` (scripts/db.mjs, D159), and a
// task's own test database (D216), on the Mac's Docker Desktop and on Linux's
// Docker Engine (#280), exercised with a stand-in for `docker`:
// nothing here starts a container or talks to Docker. What is pinned is what made the old `db:up` expensive — an implicit
// build or pull that reached Docker Desktop's credential helper and hung for an
// hour, or an exit 0 with no database — and the limit that bounds the rest.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  BACKEND_SUITE,
  COMMANDS,
  FORWARDED_SIGNALS,
  IMAGE,
  LABEL,
  LEGACY,
  WAIT_SECONDS,
  imageProbe,
  legacyTaskContainer,
  projectContainers,
  publishedPort,
  run,
  runArguments,
  taskDatabase,
  taskNames,
} from './db.mjs';

const COMPOSE = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');

// A fake `docker`: a shell script in a temporary directory, which records its
// arguments one per line and then does whatever `body` says.
function fakeDocker(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-db-script-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'docker');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${dir}/calls"\n${body}\n`, {
    mode: 0o755,
  });
  const calls = () =>
    readFileSync(join(dir, 'calls'), 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  return { path, dir, calls };
}

// The PID a stand-in wrote to `file`, or null when there is none to check: only
// a whole line holding an integer above 1 counts. An empty file is a shell
// stopped between opening the file and writing it, and `Number('')` is 0,
// which `process.kill` takes for this process's own group (F-06).
function recordedPid(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const pid = /^\d{1,10}\n$/.test(text) ? Number(text) : 0;
  return pid > 1 ? pid : null;
}

// Whether a process runs. Only a process is asked about, never 0, 1 or a
// negative number, which name a process group or launchd; a process that is
// there but may not be signalled counts as running.
const isAlive = (pid) => {
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `not a process of this test: ${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

// Polls `check` until it holds or `ms` have passed; resolves to whether it held.
async function until(check, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= end) return false;
    await sleep(50);
  }
}

test('db:up starts the existing image only, and waits for it to be healthy', () => {
  const [up, ...rest] = COMMANDS.up.steps;
  assert.equal(rest.length, 0, 'db:up runs one command');
  assert.deepEqual(up.slice(0, 2), ['compose', 'up']);
  assert.ok(up.includes('--detach'));
  assert.ok(up.includes('--no-build'), 'db:up must never build the image');
  assert.equal(up[up.indexOf('--pull') + 1], 'never', 'db:up must never pull');
  assert.ok(up.includes('--wait'), 'db:up must fail unless the container is healthy');
  assert.equal(up[up.indexOf('--wait-timeout') + 1], String(WAIT_SECONDS));
  assert.ok(
    WAIT_SECONDS < COMMANDS.up.limitSeconds,
    "Compose's own wait ends before the overall limit, so its message is the one shown",
  );
  assert.ok(COMMANDS.up.limitSeconds <= 180, 'db:up is bounded by about three minutes');
});

test('db:rebuild builds the image, then starts it exactly as db:up does', () => {
  const [build, up, ...rest] = COMMANDS.rebuild.steps;
  assert.equal(rest.length, 0);
  assert.deepEqual(build, ['compose', 'build', 'postgres']);
  assert.deepEqual(up, COMMANDS.up.steps[0]);
  assert.ok(Number.isFinite(COMMANDS.rebuild.limitSeconds));
});

test('success is Compose reporting success, for every step', async (t) => {
  // The look for the old project's container comes first, and finds none.
  const docker = fakeDocker(t, 'exit 0');
  assert.equal(await run('rebuild', { docker: docker.path, log: () => {} }), 0);
  const calls = docker.calls();
  assert.deepEqual(calls, [
    ...projectContainers(LEGACY.project),
    ...COMMANDS.rebuild.steps[0],
    ...COMMANDS.rebuild.steps[1],
  ]);

  const up = fakeDocker(t, 'exit 0');
  assert.equal(await run('up', { docker: up.path, log: () => {} }), 0);
  assert.deepEqual(up.calls(), [
    ...imageProbe(IMAGE),
    ...projectContainers(LEGACY.project),
    ...COMMANDS.up.steps[0],
  ]);
});

test('a failing Compose fails the script with its exit code and says what to check', async (t) => {
  const docker = fakeDocker(t, 'exit 3');
  const lines = [];
  assert.equal(await run('rebuild', { docker: docker.path, log: (line) => lines.push(line) }), 3);
  assert.deepEqual(
    docker.calls(),
    [...projectContainers(LEGACY.project), ...COMMANDS.rebuild.steps[0]],
    'nothing runs after a failure',
  );
  assert.match(
    lines.join('\n'),
    /db:rebuild failed: `docker compose build postgres` exited with 3/,
  );

  const upLines = [];
  assert.equal(await run('up', { docker: docker.path, log: (line) => upLines.push(line) }), 3);
  assert.match(upLines.join('\n'), /npm run db:rebuild/);
});

// The shape of the 2026-09-24 hang: `docker` waiting on a helper it started,
// whose PID it writes to helper.pid as one line. `${0%/*}` is the stand-in's
// directory, found without starting a process.
const HANGING_DOCKER = 'sleep 300 &\necho $! > "${0%/*}/helper.pid"\nwait';

// How long before its limit an attempt may give up and still have waited for
// it. `started` is read before `run()` fixes its deadline, and the timer that
// stops Docker cannot fire before that deadline but for Node's millisecond
// rounding, so a correct attempt never ends sooner than this before its limit.
const EARLY_MS = 100;

test('a Docker that does not answer is stopped at the limit, with what it started', async (t) => {
  // The limit runs from before the stand-in starts. On a machine too loaded
  // for its shell to write the helper's PID within it, the group is stopped all
  // the same and there is no helper to check: that attempt is made again, with
  // a fresh stand-in and twice the limit. Every attempt is held to the code,
  // the bound and the messages. The bound has two sides: load can only make an
  // attempt later, so one that gave up before its limit is scripts/db.mjs not
  // waiting for it, and fails the test at once, never tried again. The first
  // attempt that wrote a PID decides whether its helper was stopped; and when
  // none did, the test fails with each attempt's time, naming both readings:
  // too loaded, or scripts/db.mjs no longer starting the stand-in as it did
  // (F-06).
  const unnamed = [];
  for (const limitSeconds of [1, 2, 4, 8]) {
    const docker = fakeDocker(t, HANGING_DOCKER);
    const lines = [];
    const started = performance.now();
    const code = await run('up', {
      docker: docker.path,
      limitSeconds,
      log: (line) => lines.push(line),
      platform: 'darwin',
    });
    const elapsed = Math.round(performance.now() - started);

    assert.equal(code, 124);
    assert.ok(
      elapsed >= limitSeconds * 1000 - EARLY_MS,
      `the attempt under a limit of ${limitSeconds} s gave up after ${elapsed} ms, before its limit: load only makes an attempt later, so scripts/db.mjs no longer waits for the limit it is given before it stops Docker`,
    );
    assert.ok(elapsed < limitSeconds * 1000 + 3000, `took ${elapsed} ms to give up`);
    assert.match(lines.join('\n'), new RegExp(`db:up gave up after ${limitSeconds} s`));
    assert.match(lines.join('\n'), /docker-credential-desktop/);

    const helper = recordedPid(join(docker.dir, 'helper.pid'));
    if (helper === null) {
      unnamed.push({ limitSeconds, elapsed });
      continue;
    }
    const stopped = await until(() => !isAlive(helper), 3000);
    if (!stopped) {
      // So that a failing run leaves no helper behind, holding the test
      // runner's output open for its 300 s.
      try {
        process.kill(helper, 'SIGKILL');
      } catch {
        // It has just gone.
      }
    }
    assert.ok(stopped, 'the process Docker started is still running');
    return;
  }
  assert.fail(
    `the stand-in wrote no helper's PID within ${unnamed.map((a) => a.limitSeconds).join(', ')} s, the attempts giving up after ${unnamed.map((a) => a.elapsed).join(', ')} ms, none before its limit: the machine was too loaded for the stand-in's shell to write it in time, or scripts/db.mjs no longer starts the stand-in as it did`,
  );
});

// Between the polite stop and the forced one: GRACE_MS in scripts/db.mjs,
// which does not export it.
const GRACE_MS = 5000;

test('a Docker that ignores the polite stop is killed after the grace period', async (t) => {
  // The stand-in says it is ready once its trap is set. A polite stop that
  // comes before the trap ends its shell at once, so that attempt never
  // reaches the grace period and checks nothing: it is made again, with a
  // fresh stand-in and twice the limit. Every attempt is held to the code and
  // to the bound of its limit; load can only make an attempt later, so one
  // that gave up before its limit fails the test at once. The first attempt
  // whose stand-in was ready decides: it must have lasted its limit and the
  // grace period. When none was ready, the test fails with each attempt's
  // time, naming both readings (F-13).
  const late = [];
  for (const limitSeconds of [1, 2, 4, 8]) {
    const docker = fakeDocker(t, 'trap \'\' TERM\n: > "${0%/*}/ready"\nwhile :; do sleep 1; done');
    const started = performance.now();
    const code = await run('up', { docker: docker.path, limitSeconds, log: () => {} });
    const elapsed = Math.round(performance.now() - started);

    assert.equal(code, 124);
    assert.ok(
      elapsed >= limitSeconds * 1000 - EARLY_MS,
      `the attempt under a limit of ${limitSeconds} s gave up after ${elapsed} ms, before its limit: load only makes an attempt later, so scripts/db.mjs no longer waits for the limit it is given before it stops Docker`,
    );
    assert.ok(elapsed < limitSeconds * 1000 + GRACE_MS + 3000, `took ${elapsed} ms to give up`);
    if (!existsSync(join(docker.dir, 'ready'))) {
      late.push({ limitSeconds, elapsed });
      continue;
    }
    assert.ok(
      elapsed >= limitSeconds * 1000 + GRACE_MS - EARLY_MS,
      `the attempt under a limit of ${limitSeconds} s, its stand-in ignoring the polite stop, gave up after ${elapsed} ms: scripts/db.mjs no longer waits ${GRACE_MS / 1000} s after the polite stop before it kills Docker`,
    );
    return;
  }
  assert.fail(
    `the stand-in did not set its trap before the polite stop under a limit of ${late.map((a) => a.limitSeconds).join(', ')} s, the attempts giving up after ${late.map((a) => a.elapsed).join(', ')} ms, none before its limit: the machine was too loaded for the stand-in's shell to set it in time, or scripts/db.mjs no longer starts the stand-in as it did`,
  );
});

// What `db:up` relies on in the compose file: one project for every checkout,
// whatever its directory is called, names that follow that project, and a
// health check `--wait` can trust.
// #280's acceptance 4, for `db:up` and `db:rebuild`: on Linux the messages
// name Docker Engine — its daemon and its socket — and never Docker Desktop or
// its credential helper; on the Mac what they named before.
test('on Linux a Docker that fails or stops answering is said to be the Docker Engine daemon, on the Mac Docker Desktop', async (t) => {
  for (const [platform, says, never] of [
    [
      'linux',
      [/Docker Engine daemon/, /`systemctl status docker`/, /\/var\/run\/docker\.sock/],
      /Docker Desktop|docker-credential-desktop|keychain/,
    ],
    [
      'darwin',
      [/Docker Desktop may be stopped/, /docker-credential-desktop/],
      /Docker Engine|systemctl/,
    ],
  ]) {
    const hanging = fakeDocker(t, 'exec sleep 30');
    const lines = [];
    const code = await run('up', {
      docker: hanging.path,
      limitSeconds: 1,
      log: (line) => lines.push(line),
      platform,
    });
    assert.equal(code, 124, platform);
    const text = lines.join('\n');
    assert.match(text, /db:up gave up after 1 s/, platform);
    for (const pattern of says) assert.match(text, pattern, `${platform}: ${text}`);
    assert.doesNotMatch(text, never, `${platform}: ${text}`);

    const failing = fakeDocker(t, 'exit 3');
    const rebuilt = [];
    assert.equal(
      await run('rebuild', { docker: failing.path, log: (line) => rebuilt.push(line), platform }),
      3,
    );
    assert.match(
      rebuilt.join('\n'),
      platform === 'linux'
        ? /check the network and the Docker Engine daemon\.$/m
        : /check the network and Docker Desktop\.$/m,
      platform,
    );
    assert.doesNotMatch(rebuilt.join('\n'), never, platform);
  }
});

test('docker-compose.yml fixes the project name and a health check that queries', () => {
  assert.match(
    COMPOSE,
    /^name: webhook-inspector$/m,
    'the project name must not come from the directory',
  );
  assert.match(
    COMPOSE,
    new RegExp(`^    image: ${IMAGE}$`, 'm'),
    'the image has the name db:up gives the old one, whatever the project is called',
  );
  assert.notEqual(LEGACY.project, 'webhook-inspector');
  assert.doesNotMatch(
    COMPOSE,
    /container_name:/,
    'a fixed container_name collides across projects and does not follow the project name',
  );
  const healthcheck = /healthcheck:\n([\s\S]*?)\n\S/.exec(COMPOSE)?.[1] ?? '';
  assert.match(healthcheck, /psql -h 127\.0\.0\.1 /, 'healthy must mean reachable over TCP');
  assert.match(healthcheck, /SELECT 1/, 'healthy must mean the configured role can query');
  assert.doesNotMatch(healthcheck, /pg_isready/, 'pg_isready passes with the wrong credentials');
});

// The rename of D278, on a machine set up before it: the Compose project
// `qa-tools`, whose container holds port 5432, and the image under its old
// name only. `db:up` gives the image its new name with `docker tag` and stops
// the old container, and neither builds, pulls nor deletes anything. The
// stand-in keeps what it was told in its directory: whether the image has been
// tagged, and what `docker ps` answers; with `tag-fails` its tag prints that
// file on stderr and exits 1, and with `compose-needs-image` Compose exits 1
// while the image has no new name, as it does when the image is missing.
const RENAMING_DOCKER = `
dir="\${0%/*}"
case "$1 $2" in
  "image inspect")
    if [ "$5" = "${IMAGE}" ] && [ ! -f "$dir/tagged" ] && [ ! -f "$dir/new-image" ]; then
      echo "Error response from daemon: No such image: $5" >&2; exit 1
    fi
    if [ "$5" = "${LEGACY.image}" ] && [ -f "$dir/no-old-image" ]; then
      echo "Error response from daemon: No such image: $5" >&2; exit 1
    fi
    echo sha256:f00d; exit 0 ;;
  "tag ${LEGACY.image}")
    if [ -f "$dir/tag-fails" ]; then cat "$dir/tag-fails" >&2; exit 1; fi
    : > "$dir/tagged"; exit 0 ;;
  "ps --filter") [ -f "$dir/ps" ] && cat "$dir/ps"; exit 0 ;;
  "compose up")
    if [ -f "$dir/compose-needs-image" ] && [ ! -f "$dir/tagged" ] && [ ! -f "$dir/new-image" ]; then
      exit 1
    fi
    exit 0 ;;
esac
exit 0
`;

test('db:up on a machine from before the rename names the old image anew and stops the old container, deleting nothing', async (t) => {
  const docker = fakeDocker(t, RENAMING_DOCKER);
  writeFileSync(join(docker.dir, 'ps'), `${LEGACY.project}-postgres-1\n`);
  const lines = [];
  assert.equal(await run('up', { docker: docker.path, log: (line) => lines.push(line) }), 0);
  assert.deepEqual(docker.calls(), [
    ...imageProbe(IMAGE),
    ...imageProbe(LEGACY.image),
    'tag',
    LEGACY.image,
    IMAGE,
    ...projectContainers(LEGACY.project),
    'stop',
    `${LEGACY.project}-postgres-1`,
    ...COMMANDS.up.steps[0],
  ]);
  const said = lines.join('\n');
  assert.match(said, new RegExp(`The image ${LEGACY.image}, .* is now also named ${IMAGE}`));
  assert.match(said, /nothing was built or pulled/);
  assert.match(
    said,
    new RegExp(`Stopped ${LEGACY.project}-postgres-1, .* It and its data are kept`),
  );
  for (const verb of ['rm', 'rmi', 'down', 'volume', 'build', 'pull', 'kill']) {
    assert.ok(!docker.calls().includes(verb), `db:up ran docker ${verb}`);
  }

  // Again: the image has its name now, and no old container runs.
  const again = fakeDocker(t, RENAMING_DOCKER);
  writeFileSync(join(again.dir, 'new-image'), '');
  assert.equal(await run('up', { docker: again.path, log: () => {} }), 0);
  assert.deepEqual(again.calls(), [
    ...imageProbe(IMAGE),
    ...projectContainers(LEGACY.project),
    ...COMMANDS.up.steps[0],
  ]);
});

test('db:rebuild stops the old container but leaves the image to its build; with neither image db:up tags nothing', async (t) => {
  const rebuild = fakeDocker(t, RENAMING_DOCKER);
  writeFileSync(join(rebuild.dir, 'ps'), `${LEGACY.project}-postgres-1\n`);
  assert.equal(await run('rebuild', { docker: rebuild.path, log: () => {} }), 0);
  assert.deepEqual(rebuild.calls(), [
    ...projectContainers(LEGACY.project),
    'stop',
    `${LEGACY.project}-postgres-1`,
    ...COMMANDS.rebuild.steps[0],
    ...COMMANDS.rebuild.steps[1],
  ]);

  const bare = fakeDocker(t, RENAMING_DOCKER);
  writeFileSync(join(bare.dir, 'no-old-image'), '');
  const lines = [];
  assert.equal(await run('up', { docker: bare.path, log: (line) => lines.push(line) }), 0);
  assert.ok(!bare.calls().includes('tag'), 'nothing to tag');
  assert.doesNotMatch(lines.join('\n'), /now also named|Stopped/);
});

// #353: a `docker tag` that fails leaves the image without the name Compose
// starts, so the new database could not start; the old one, not yet stopped,
// is left running, and what Docker said is shown with the command.
test('a docker tag that fails ends db:up with the command and what Docker said, and stops nothing', async (t) => {
  const docker = fakeDocker(t, RENAMING_DOCKER);
  writeFileSync(join(docker.dir, 'ps'), `${LEGACY.project}-postgres-1\n`);
  writeFileSync(
    join(docker.dir, 'tag-fails'),
    'Error response from daemon: write /var/lib/docker/image/overlay2/repositories.json: no space left on device\n',
  );
  const lines = [];
  const code = await run('up', { docker: docker.path, log: (line) => lines.push(line) });
  assert.equal(code, 1, "db:up exits with the tag's code");
  assert.deepEqual(
    docker.calls(),
    [...imageProbe(IMAGE), ...imageProbe(LEGACY.image), 'tag', LEGACY.image, IMAGE],
    'no docker ps, no docker stop and no Compose after the failed tag',
  );
  const said = lines.join('\n');
  assert.match(
    said,
    new RegExp(
      `^db:up failed: \`docker tag ${LEGACY.image} ${IMAGE}\` exited with 1:\\nError response from daemon: write \\S+: no space left on device$`,
      'm',
    ),
  );
  assert.match(
    said,
    new RegExp(
      `nothing was stopped: a database of the Compose project ${LEGACY.project} still runs`,
    ),
  );
  assert.match(said, /`npm run db:rebuild`, which stops that database first and keeps its data/);
  assert.doesNotMatch(said, /now also named|Stopped /);

  // A tag that prints nothing is said to have printed nothing.
  const silent = fakeDocker(t, RENAMING_DOCKER);
  writeFileSync(join(silent.dir, 'ps'), `${LEGACY.project}-postgres-1\n`);
  writeFileSync(join(silent.dir, 'tag-fails'), '');
  const quiet = [];
  assert.equal(await run('up', { docker: silent.path, log: (line) => quiet.push(line) }), 1);
  assert.match(
    quiet.join('\n'),
    new RegExp(`\`docker tag ${LEGACY.image} ${IMAGE}\` exited with 1 and printed nothing\\.\\n`),
  );
  assert.ok(!silent.calls().includes('stop'), 'nothing stopped');
});

// What the failed tag printed is quoted as it came, at growing sizes: made-up
// output — a line like this script's own, a shell command, a terminal escape,
// a carriage return, a line with no end — is shown whole up to the 64 KiB or
// so kept of it, never run, and db:up still stops nothing and ends at once.
test("a failed tag's output is quoted, never acted on, and nothing is stopped, at any size", async (t) => {
  const junk = [
    `Stopped ${LEGACY.project}-postgres-1`,
    '$(touch pwned)',
    '`touch pwned`; docker stop x',
    'tab\there',
    '\u001b[2J\u001b[H',
    'carriage\rreturn',
    'é-name',
    '',
  ];
  for (const size of [1_000, 100_000, 1_000_000]) {
    const docker = fakeDocker(t, RENAMING_DOCKER);
    writeFileSync(join(docker.dir, 'ps'), `${LEGACY.project}-postgres-1\n`);
    let text = 'first line\n';
    while (text.length < size) text += `${junk.join('\n')}\n`;
    writeFileSync(join(docker.dir, 'tag-fails'), `${text}no end`);
    const lines = [];
    const started = performance.now();
    const code = await run('up', {
      docker: docker.path,
      cwd: docker.dir,
      log: (line) => lines.push(line),
    });
    const elapsed = performance.now() - started;
    assert.equal(code, 1, `size ${size}`);
    for (const verb of ['ps', 'stop', 'compose']) {
      assert.ok(!docker.calls().includes(verb), `size ${size}: db:up ran docker ${verb}`);
    }
    const said = lines.join('\n');
    assert.match(said, /exited with 1:\nfirst line\nStopped /, `size ${size}`);
    assert.match(said, /nothing was stopped/, `size ${size}`);
    if (size < 65_536) assert.match(said, /\nno end\nThe image /, `size ${size}`);
    // The capture keeps 64 KiB and the chunk that crosses it.
    assert.ok(said.length < 2 * 65_536 + 2_000, `size ${size}: ${said.length} characters shown`);
    assert.ok(!existsSync(join(docker.dir, 'pwned')), `size ${size}: the output was run`);
    assert.ok(elapsed < 10_000, `size ${size} took ${Math.round(elapsed)} ms`);
  }
});

// #353: with neither name there Compose cannot start the new database, so the
// old one, which holds the port, is not stopped; Compose's own failure and
// the hint say the image is missing. A Docker that fails every call stops
// nothing either. The stand-ins' Compose exits 1 without a word, so that the
// test's output shows no Docker error.
test('with the image under neither name db:up stops nothing, and the old database keeps running', async (t) => {
  const docker = fakeDocker(t, RENAMING_DOCKER);
  writeFileSync(join(docker.dir, 'ps'), `${LEGACY.project}-postgres-1\n`);
  writeFileSync(join(docker.dir, 'no-old-image'), '');
  writeFileSync(join(docker.dir, 'compose-needs-image'), '');
  const lines = [];
  assert.equal(await run('up', { docker: docker.path, log: (line) => lines.push(line) }), 1);
  assert.deepEqual(
    docker.calls(),
    [...imageProbe(IMAGE), ...imageProbe(LEGACY.image), ...COMMANDS.up.steps[0]],
    'no docker ps and no docker stop without the image',
  );
  const said = lines.join('\n');
  assert.match(said, /db:up failed: `docker compose up .*` exited with 1\./);
  assert.match(
    said,
    new RegExp(`"No such image: ${IMAGE}" — build it once with \`npm run db:rebuild\``),
  );
  assert.doesNotMatch(said, /now also named|Stopped /);

  const failing = fakeDocker(t, 'exit 1');
  assert.equal(await run('up', { docker: failing.path, log: () => {}, platform: 'linux' }), 1);
  assert.deepEqual(failing.calls(), [
    ...imageProbe(IMAGE),
    ...imageProbe(LEGACY.image),
    ...COMMANDS.up.steps[0],
  ]);
});

test('a project run under the old name on purpose is left to it', async (t) => {
  const docker = fakeDocker(t, RENAMING_DOCKER);
  writeFileSync(join(docker.dir, 'ps'), `${LEGACY.project}-postgres-1\n`);
  writeFileSync(join(docker.dir, 'new-image'), '');
  const before = process.env.COMPOSE_PROJECT_NAME;
  process.env.COMPOSE_PROJECT_NAME = LEGACY.project;
  try {
    assert.equal(await run('up', { docker: docker.path, log: () => {} }), 0);
  } finally {
    if (before === undefined) delete process.env.COMPOSE_PROJECT_NAME;
    else process.env.COMPOSE_PROJECT_NAME = before;
  }
  assert.ok(!docker.calls().includes('ps'), 'no look for the old project');
  assert.ok(!docker.calls().includes('stop'), 'nothing stopped');
});

// What `docker ps` answers is read as container names, a line each: only a
// line that is one name as Docker makes them is stopped. Made-up answers at
// growing sizes — a flag, words, a shell command, an overlong name, control
// characters — are stopped by name or passed over, and quickly.
test("the old project's containers are read from docker ps a name a line, and nothing else is taken for one, at any size", async (t) => {
  for (const size of [1_000, 10_000, 100_000]) {
    const docker = fakeDocker(t, RENAMING_DOCKER);
    writeFileSync(join(docker.dir, 'new-image'), '');
    const junk = [
      '--time=0',
      '-t',
      'two words',
      '$(touch pwned)',
      'a;b',
      `${'n'.repeat(129)}`,
      'tab\there',
      '\u0000',
      'é-name',
      '',
      '   ',
    ];
    const lines = [`${LEGACY.project}-postgres-1`, ' padded-2 '];
    while (lines.join('\n').length < size) lines.push(...junk);
    writeFileSync(join(docker.dir, 'ps'), `${lines.join('\n')}\n`);
    const started = performance.now();
    assert.equal(await run('up', { docker: docker.path, log: () => {} }), 0);
    const elapsed = performance.now() - started;
    const calls = docker.calls();
    const stopped = calls.flatMap((arg, index) => (arg === 'stop' ? [calls[index + 1]] : []));
    assert.deepEqual(stopped, [`${LEGACY.project}-postgres-1`, 'padded-2'], `size ${size}`);
    assert.ok(elapsed < 10_000, `size ${size} took ${Math.round(elapsed)} ms`);
  }
});

// The containers `docker stop` was given, in order.
const stoppedBy = (calls) =>
  calls.flatMap((arg, index) => (arg === 'stop' ? [calls[index + 1]] : []));

// The image Compose built for the old project carries the project's and the
// service's labels itself, and every container started from it with `docker
// run` — a task's database under either name, an e2e one — carries them too.
// Only Compose sets `oneoff`, and only on a service's own containers `False`
// with a `container-number`. The labels below are those `docker inspect` showed
// on stand-ins of each kind (Docker Engine 29.9, Compose 5.6), under the names
// they have on a machine from before the rename.
const IMAGE_LABELS = {
  'com.docker.compose.project': LEGACY.project,
  'com.docker.compose.service': 'postgres',
  'com.docker.compose.version': '5.6.1',
};
const COMPOSE_LABELS = {
  'com.docker.compose.config-hash': 'f00d',
  'com.docker.compose.image': 'sha256:f00d',
};
const RUNNING = [
  {
    name: `${LEGACY.project}-postgres-1`,
    labels: {
      ...IMAGE_LABELS,
      ...COMPOSE_LABELS,
      'com.docker.compose.container-number': '1',
      'com.docker.compose.oneoff': 'False',
    },
  },
  { name: legacyTaskContainer('339'), labels: { ...IMAGE_LABELS, [LEGACY.label]: '339' } },
  { name: taskNames('323').container, labels: { ...IMAGE_LABELS, [LABEL]: '323' } },
  { name: 'webhook-inspector-postgres-e2e', labels: { ...IMAGE_LABELS } },
  {
    name: `${LEGACY.project}-postgres-run-0b5e`,
    labels: {
      ...IMAGE_LABELS,
      ...COMPOSE_LABELS,
      'com.docker.compose.oneoff': 'True',
      'com.docker.compose.slug': '0b5e',
    },
  },
  {
    name: 'webhook-inspector-postgres-1',
    labels: {
      ...IMAGE_LABELS,
      ...COMPOSE_LABELS,
      'com.docker.compose.project': 'webhook-inspector',
      'com.docker.compose.container-number': '1',
      'com.docker.compose.oneoff': 'False',
    },
  },
];

// A stand-in whose `docker ps` lists the running containers above as Docker
// does: every `--filter label=<key>` or `label=<key>=<value>` must hold.
const LABELLED_DOCKER = `
dir="\${0%/*}"
[ "$1" = ps ] && exec "${process.execPath}" "$dir/ps.mjs" "$@"
exit 0
`;
const LABEL_FILTER = `
import { readFileSync } from 'node:fs';
import process from 'node:process';
const running = JSON.parse(readFileSync(new URL('./running.json', import.meta.url), 'utf8'));
const args = process.argv.slice(3);
const wanted = [];
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--format' && args[i + 1] === '{{.Names}}') continue;
  const label = args[i] === '--filter' && /^label=([^=]+)(?:=(.*))?$/s.exec(args[i + 1]);
  if (!label) {
    console.error('unexpected: ' + args[i] + ' ' + args[i + 1]);
    process.exit(1);
  }
  wanted.push([label[1], label[2]]);
}
for (const { name, labels } of running) {
  if (wanted.every(([key, value]) => Object.hasOwn(labels, key) && (value === undefined || labels[key] === value))) {
    console.log(name);
  }
}
`;
function labelledDocker(t) {
  const docker = fakeDocker(t, LABELLED_DOCKER);
  writeFileSync(join(docker.dir, 'ps.mjs'), LABEL_FILTER);
  writeFileSync(join(docker.dir, 'running.json'), JSON.stringify(RUNNING));
  return docker;
}

test("the old project's container is looked for by the labels Compose sets on a service's own containers, which no image carries", () => {
  assert.deepEqual(projectContainers(LEGACY.project), [
    'ps',
    '--filter',
    `label=com.docker.compose.project=${LEGACY.project}`,
    '--filter',
    'label=com.docker.compose.service=postgres',
    '--filter',
    'label=com.docker.compose.oneoff=False',
    '--filter',
    'label=com.docker.compose.container-number',
    '--format',
    '{{.Names}}',
  ]);
});

test("db:up and db:rebuild stop the container Compose made for the old project's postgres, and none started from its image another way", async (t) => {
  // The project's and the service's labels alone match every container
  // started from the image, other tasks' databases among them.
  const look = labelledDocker(t);
  const byImage = spawnSync(
    look.path,
    [
      'ps',
      '--filter',
      `label=com.docker.compose.project=${LEGACY.project}`,
      '--filter',
      'label=com.docker.compose.service=postgres',
      '--format',
      '{{.Names}}',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(byImage.status, 0, byImage.stderr);
  assert.deepEqual(byImage.stdout.split('\n').slice(0, -1), [
    `${LEGACY.project}-postgres-1`,
    legacyTaskContainer('339'),
    taskNames('323').container,
    'webhook-inspector-postgres-e2e',
    `${LEGACY.project}-postgres-run-0b5e`,
  ]);

  for (const name of ['up', 'rebuild']) {
    const docker = labelledDocker(t);
    const lines = [];
    assert.equal(await run(name, { docker: docker.path, log: (line) => lines.push(line) }), 0);
    assert.deepEqual(stoppedBy(docker.calls()), [`${LEGACY.project}-postgres-1`], name);
    assert.equal(lines.filter((line) => line.startsWith('Stopped ')).length, 1, name);
  }
});

// `docker ps`'s answer is captured up to 64 KiB, and the line it is cut in is
// then the start of a name: another container's, perhaps, which `docker stop`
// takes as it takes the start of an ID. Only a line that ends is acted on.
test("a name cut off at the end of docker ps's answer is not stopped, without its newline or past the 64 KiB kept", async (t) => {
  const short = fakeDocker(t, RENAMING_DOCKER);
  writeFileSync(join(short.dir, 'new-image'), '');
  writeFileSync(join(short.dir, 'ps'), `${LEGACY.project}-postgres-1\n${LEGACY.project}-postgres`);
  assert.equal(await run('up', { docker: short.path, log: () => {} }), 0);
  assert.deepEqual(stoppedBy(short.calls()), [`${LEGACY.project}-postgres-1`]);

  // Lines that are no name whole, for the `!` that ends each, while every
  // start of one cut before it is: wherever the 64 KiB end, but at a `!` or a
  // newline, the cut line looks like a name.
  for (const size of [100_000, 1_000_000]) {
    const docker = fakeDocker(t, RENAMING_DOCKER);
    writeFileSync(join(docker.dir, 'new-image'), '');
    const lines = [`${LEGACY.project}-postgres-1`];
    while (lines.length * 100 < size) lines.push(`${'a'.repeat(98)}!`);
    writeFileSync(join(docker.dir, 'ps'), `${lines.join('\n')}\n`);
    const started = performance.now();
    assert.equal(await run('up', { docker: docker.path, log: () => {} }), 0);
    const elapsed = performance.now() - started;
    assert.deepEqual(stoppedBy(docker.calls()), [`${LEGACY.project}-postgres-1`], `size ${size}`);
    assert.ok(elapsed < 10_000, `size ${size} took ${Math.round(elapsed)} ms`);
  }
});

test('a look for the old names that does not finish is stopped at the limit and named', async (t) => {
  const docker = fakeDocker(t, '[ "$1" = ps ] && exec sleep 30\nexit 0');
  const lines = [];
  const code = await run('up', {
    docker: docker.path,
    limitSeconds: 1,
    log: (line) => lines.push(line),
    platform: 'linux',
  });
  assert.equal(code, 124);
  assert.match(
    lines.join('\n'),
    new RegExp(
      `db:up gave up after 1 s: \`docker ps --filter label=com\\.docker\\.compose\\.project=${LEGACY.project} `,
    ),
  );
  assert.ok(!docker.calls().includes('compose'), 'Compose never ran');
});

test('a hang-up reaches the Docker process group, and the script reports it', async (t) => {
  // The stand-in says it is ready once its trap is set: a hang-up before that
  // ends the shell with nothing to report it (F-06). The hang-up is sent even
  // when it never says so, which ends the run rather than leave it to its limit.
  const docker = fakeDocker(
    t,
    'trap \'echo HUP > "${0%/*}/signal"; exit 0\' HUP\n: > "${0%/*}/ready"\nwhile :; do sleep 0.1; done',
  );
  const pending = run('up', { docker: docker.path, limitSeconds: 30, log: () => {} });
  const ready = await until(() => existsSync(join(docker.dir, 'ready')), 10_000);
  process.kill(process.pid, 'SIGHUP');

  assert.equal(await pending, FORWARDED_SIGNALS.SIGHUP);
  assert.ok(ready, 'the stand-in did not set its trap within 10 s');
  // The file is there from its opening, before the trap has written to it.
  const signal = join(docker.dir, 'signal');
  const read = () => (existsSync(signal) ? readFileSync(signal, 'utf8') : null);
  await until(() => read() === 'HUP\n', 10_000);
  assert.equal(read(), 'HUP\n');
  assert.equal(process.listenerCount('SIGHUP'), 0, 'the handler outlived the command');
});

test('an unknown command is refused', async () => {
  const lines = [];
  assert.equal(await run('down', { log: (line) => lines.push(line) }), 2);
  assert.equal(await run('toString', { log: () => {} }), 2);
  assert.match(lines.join('\n'), /Usage: node scripts\/db\.mjs <up\|rebuild>/);
});

// ---------------------------------------------------------------------------
// A task's own test database: `task-up` and `task-down` (D216)
// ---------------------------------------------------------------------------
//
// Run against a stand-in `docker` that keeps its containers in a file, and a
// stand-in migration runner that records the URL it was given. Nothing here
// starts a container, and the application's container and its `webhook_inspector`
// database are never named.

const STANDIN_DOCKER = `
const fs = require('node:fs');
const file = process.env.DOCKER_STANDIN;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(file + '.calls', JSON.stringify(args) + '\\n');
const save = () => fs.writeFileSync(file, JSON.stringify(data));
const name = args.at(-1);
if (data.hang) { setInterval(() => {}, 1000); return; }
if (data.down) { process.stderr.write('Cannot connect to the Docker daemon. Is the docker daemon running?\\n'); process.exit(1); }
if (data.answer) { process.stdout.write(data.answer.stdout ?? ''); process.stderr.write(data.answer.stderr ?? ''); process.exit(data.answer.status ?? 0); }
if (args[0] === 'inspect') {
  const box = data.containers[name];
  if (!box) { process.stderr.write((data.missing ?? 'Error: No such object: ') + name + '\\n'); process.exit(1); }
  if (args[2].includes('.Config.Labels')) { process.stdout.write((box.label ?? '<no value>') + ' ' + box.status + '\\n'); process.exit(0); }
  const health = box.health.length > 1 ? box.health.shift() : box.health[0];
  save();
  process.stdout.write(box.status + ' ' + health + '\\n');
} else if (args[0] === 'run') {
  if (data.runFails) { process.stderr.write('Unable to find image webhook-inspector-postgres:latest locally\\n'); process.exit(125); }
  const container = args[args.indexOf('--name') + 1];
  const label = args[args.indexOf('--label') + 1].split('=')[1];
  data.containers[container] = { label, status: 'running', health: data.health ?? ['starting', 'healthy'] };
  save();
  process.stdout.write('f00d\\n');
} else if (args[0] === 'image') {
  if (!(data.images ?? [${JSON.stringify(IMAGE)}]).includes(name)) { process.stderr.write('Error response from daemon: No such image: ' + name + '\\n'); process.exit(1); }
  process.stdout.write('sha256:f00d\\n');
} else if (args[0] === 'tag') {
  if (data.tagFails !== undefined) { process.stderr.write(data.tagFails); process.exit(1); }
  data.images = [...(data.images ?? []), args[2]];
  save();
} else if (args[0] === 'start') {
  data.containers[name].status = 'running';
  save();
} else if (args[0] === 'port') {
  process.stdout.write(data.port ?? '127.0.0.1:55432\\n');
} else if (args[0] === 'rm') {
  delete data.containers[name];
  save();
} else {
  process.stderr.write('stand-in docker: not ' + args.join(' ') + '\\n');
  process.exit(2);
}
`;

const STANDIN_MIGRATE = `
const fs = require('node:fs');
fs.writeFileSync(process.env.MIGRATE_SEEN, process.env.DATABASE_URL ?? '(none)');
process.stdout.write('Applied 001_initial_schema.sql\\n');
process.exit(Number(process.env.MIGRATE_EXIT ?? 0));
`;

function taskFixture(t, data = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-db-task-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const docker = join(dir, 'docker');
  writeFileSync(docker, `#!${process.execPath}\n${STANDIN_DOCKER}`, { mode: 0o755 });
  const migrate = join(dir, 'migrate.cjs');
  writeFileSync(migrate, STANDIN_MIGRATE);
  const file = join(dir, 'docker.json');
  writeFileSync(file, JSON.stringify({ containers: {}, ...data }));
  const seen = join(dir, 'seen');
  return {
    dir,
    seen,
    docker,
    migrate,
    file,
    set: (change) =>
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...change })),
    containers: () => JSON.parse(readFileSync(file, 'utf8')).containers,
    calls: () => {
      try {
        return readFileSync(`${file}.calls`, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    // The script's own process environment is what the stand-ins read.
    run: async (action, task, { migrateExit = 0, limitSeconds = 20 } = {}) => {
      const printed = [];
      const logged = [];
      const before = { ...process.env };
      process.env.DOCKER_STANDIN = file;
      process.env.MIGRATE_SEEN = seen;
      process.env.MIGRATE_EXIT = String(migrateExit);
      // A URL meant for the application's database must never reach the runner.
      process.env.DATABASE_URL =
        'postgres://webhook_inspector:webhook_inspector@localhost:5432/webhook_inspector';
      try {
        const code = await taskDatabase(action, task, {
          docker,
          migrate,
          cwd: dir,
          limitSeconds,
          log: (line) => logged.push(line),
          print: (line) => printed.push(line),
        });
        return { code, printed, logged: logged.join('\n') };
      } finally {
        for (const key of ['DOCKER_STANDIN', 'MIGRATE_SEEN', 'MIGRATE_EXIT', 'DATABASE_URL']) {
          if (before[key] === undefined) delete process.env[key];
          else process.env[key] = before[key];
        }
      }
    },
  };
}

test("a task's database is a container of its own, never built or pulled, for its database alone, on a port Docker chooses", () => {
  assert.deepEqual(taskNames('127'), {
    container: 'webhook-inspector-test-t127',
    database: 'webhook_inspector_t127',
  });
  assert.deepEqual(taskNames('day-owner-fix'), {
    container: 'webhook-inspector-test-day-owner-fix',
    database: 'webhook_inspector_day_owner_fix',
  });
  const args = runArguments('127');
  assert.deepEqual(args.slice(0, 2), ['run', '--detach']);
  assert.equal(args[args.indexOf('--pull') + 1], 'never', 'a task database is never pulled');
  assert.ok(!args.includes('--build') && !args.includes('build'));
  assert.equal(args[args.indexOf('--name') + 1], 'webhook-inspector-test-t127');
  assert.equal(args[args.indexOf('--label') + 1], `${LABEL}=127`);
  assert.equal(
    args[args.indexOf('--publish') + 1],
    '127.0.0.1::5432',
    'loopback, a port Docker picks',
  );
  assert.ok(args.includes('POSTGRES_DB=webhook_inspector_t127'));
  assert.equal(args[args.indexOf(IMAGE) + 1], 'postgres');
  assert.ok(
    args.includes('cron.database_name=webhook_inspector_t127'),
    "pg_cron serves the task's database",
  );
  assert.ok(args.includes('shared_preload_libraries=pg_cron'));
  assert.match(
    args[args.indexOf('--health-cmd') + 1],
    /psql -h 127\.0\.0\.1 .* -d webhook_inspector_t127 .*SELECT 1/,
  );

  // Never the application's container or database, whatever is asked.
  for (const bad of [
    '',
    '0',
    '01',
    'webhook_inspector',
    'webhook-inspector',
    '1; docker rm -f webhook-inspector-postgres-1',
    '../x',
    'day-',
    'DAY-x',
    'day-x/y',
    '1234567890',
    `day-${'a'.repeat(41)}`,
    undefined,
  ]) {
    assert.equal(taskNames(bad), null, String(bad));
  }
  for (const task of ['1', '999999999', 'day-a', `day-${'a'.repeat(39)}`]) {
    const { container, database } = taskNames(task);
    assert.notEqual(database, 'webhook_inspector');
    assert.match(container, /^webhook-inspector-test-/);
    assert.match(database, /^webhook_inspector_[a-z0-9_]+$/);
  }
});

test('task-up starts the container, waits until it is healthy, migrates it and prints its URL; again, it reuses it', async (t) => {
  const f = taskFixture(t);
  const first = await f.run('task-up', '127');
  assert.equal(first.code, 0, first.logged);
  assert.deepEqual(first.printed, [
    'DATABASE_URL=postgres://webhook_inspector:webhook_inspector@127.0.0.1:55432/webhook_inspector_t127',
  ]);
  assert.equal(
    readFileSync(f.seen, 'utf8'),
    'postgres://webhook_inspector:webhook_inspector@127.0.0.1:55432/webhook_inspector_t127',
    "the migrations ran against the task's database, not the URL in the environment",
  );
  const verbs = f.calls().map((args) => args[0]);
  assert.deepEqual(verbs, ['inspect', 'image', 'run', 'inspect', 'inspect', 'port']);
  assert.deepEqual(
    f.calls()[1],
    imageProbe(IMAGE),
    'the image is looked for, never built or pulled',
  );
  assert.deepEqual(f.calls()[2], runArguments('127'));

  // Running already: no second container, the migrations again, the URL again.
  const again = await f.run('task-up', '127');
  assert.equal(again.code, 0, again.logged);
  assert.deepEqual(again.printed, first.printed);
  assert.equal(f.calls().filter((args) => args[0] === 'run').length, 1);

  // Stopped: started again.
  f.set({
    containers: {
      'webhook-inspector-test-t127': { label: '127', status: 'exited', health: ['healthy'] },
    },
  });
  const stopped = await f.run('task-up', '127');
  assert.equal(stopped.code, 0, stopped.logged);
  assert.deepEqual(f.calls().at(-3), ['start', 'webhook-inspector-test-t127']);
});

test('task-down removes the container with its data, and only one made for that task', async (t) => {
  const f = taskFixture(t);
  assert.equal((await f.run('task-up', 'day-x')).code, 0);
  const down = await f.run('task-down', 'day-x');
  assert.equal(down.code, 0, down.logged);
  assert.deepEqual(f.calls().at(-2), [
    'rm',
    '--force',
    '--volumes',
    'webhook-inspector-test-day-x',
  ]);
  // And then the look for its container from before the rename, which is not there.
  assert.deepEqual(f.calls().at(-1).slice(0, 1), ['inspect']);
  assert.equal(f.calls().at(-1).at(-1), legacyTaskContainer('day-x'));
  assert.deepEqual(f.containers(), {});
  const none = await f.run('task-down', 'day-x');
  assert.equal(none.code, 0);
  assert.match(none.printed.join('\n'), /No test database of day-x to remove/);
  assert.equal(f.calls().filter((args) => args[0] === 'rm').length, 1);

  // A container of that name that this script did not make for the task.
  for (const label of ['128', undefined]) {
    f.set({
      containers: {
        'webhook-inspector-test-t127': { label, status: 'running', health: ['healthy'] },
      },
    });
    const count = f.calls().length;
    for (const action of ['task-up', 'task-down']) {
      const result = await f.run(action, '127');
      assert.equal(result.code, 1, `${action} over a container labelled ${label}`);
      assert.match(result.logged, /not made by this script for 127; nothing was changed/);
    }
    assert.deepEqual(
      f
        .calls()
        .slice(count)
        .map((args) => args[0]),
      ['inspect', 'inspect'],
      'nothing but the look',
    );
  }
});

// The rename of D278 for a task's database: a machine that has the image
// under its old name only gives it the new one before `docker run`, and a
// task container made before the rename, `qa-tools-test-<task>` labelled
// `qa-tools.task`, is still removed by `task-down` — when its old label names
// that task, and never otherwise.
test("task-up names an image from before the rename anew; task-down also removes the task's container from before it, by its old label alone", async (t) => {
  assert.equal(legacyTaskContainer('127'), `${LEGACY.project}-test-t127`);
  assert.equal(legacyTaskContainer('day-x'), `${LEGACY.project}-test-day-x`);
  assert.equal(legacyTaskContainer('qa_tools'), null);

  const old = taskFixture(t, { images: [LEGACY.image] });
  const up = await old.run('task-up', '127');
  assert.equal(up.code, 0, up.logged);
  assert.deepEqual(
    old.calls().map((args) => args[0]),
    ['inspect', 'image', 'image', 'tag', 'run', 'inspect', 'inspect', 'port'],
  );
  assert.deepEqual(old.calls()[3], ['tag', LEGACY.image, IMAGE]);
  assert.match(up.logged, new RegExp(`The image ${LEGACY.image}, .* is now also named ${IMAGE}`));

  const none = taskFixture(t, { images: [], runFails: true });
  const missing = await none.run('task-up', '127');
  assert.equal(missing.code, 125);
  assert.deepEqual(
    none.calls().map((args) => args[0]),
    ['inspect', 'image', 'image', 'run'],
  );
  assert.match(missing.logged, /npm run db:rebuild/);

  const oldBox = legacyTaskContainer('127');
  const box = (label) => ({ label, status: 'running', health: ['healthy'] });

  // The old container alone: task-up leaves it, task-down removes it.
  const alone = taskFixture(t, { containers: { [oldBox]: box('127') } });
  assert.equal((await alone.run('task-up', '127')).code, 0);
  assert.ok(alone.containers()[oldBox], 'task-up left the old container as it was');
  assert.equal(alone.calls().filter((args) => args.includes(oldBox)).length, 0);
  const down = await alone.run('task-down', '127');
  assert.equal(down.code, 0, down.logged);
  assert.deepEqual(down.printed, [
    'Removed the test database of 127: webhook-inspector-test-t127 and its data.',
    `Removed the test database of 127 from before the rename: ${oldBox} and its data.`,
  ]);
  assert.deepEqual(alone.containers(), {});
  assert.deepEqual(alone.calls().at(-1), ['rm', '--force', '--volumes', oldBox]);
  assert.ok(
    alone.calls().at(-2).includes(`{{index .Config.Labels "${LEGACY.label}"}} {{.State.Status}}`),
    'known by its old label',
  );

  // Only the old one there: removed, and nothing else said.
  const only = taskFixture(t, { containers: { [oldBox]: box('127') } });
  const onlyDown = await only.run('task-down', '127');
  assert.equal(onlyDown.code, 0, onlyDown.logged);
  assert.deepEqual(onlyDown.printed, [
    `Removed the test database of 127 from before the rename: ${oldBox} and its data.`,
  ]);

  // An old container of that name another task's, or no script's: left.
  for (const label of ['128', undefined]) {
    const other = taskFixture(t, { containers: { [oldBox]: box(label) } });
    const kept = await other.run('task-down', '127');
    assert.equal(kept.code, 0, kept.logged);
    assert.match(kept.printed.join('\n'), /No test database of 127 to remove/);
    assert.ok(other.containers()[oldBox], `an old container labelled ${label} was removed`);
    assert.equal(other.calls().filter((args) => args[0] === 'rm').length, 0);
  }
});

// #353, for a task's database: a tag that fails ends task-up with the command
// and what Docker said, before any `docker run` whose "Unable to find image"
// would hide it.
test('task-up whose docker tag fails says so with what Docker said, and starts nothing', async (t) => {
  const f = taskFixture(t, {
    images: [LEGACY.image],
    tagFails: 'Error response from daemon: no space left on device\n',
  });
  const up = await f.run('task-up', '127');
  assert.equal(up.code, 1);
  assert.deepEqual(
    f.calls().map((args) => args[0]),
    ['inspect', 'image', 'image', 'tag'],
  );
  assert.match(
    up.logged,
    new RegExp(
      `^task-up 127 failed: docker tag ${LEGACY.image} ${IMAGE} exited with 1\\.\\nError response from daemon: no space left on device$`,
      'm',
    ),
  );
  assert.doesNotMatch(up.logged, /now also named|No such image/);
  assert.deepEqual(up.printed, [], 'no URL');
  assert.deepEqual(f.containers(), {}, 'no container started');
});

// How often a stand-in was asked for the container's health: its `docker
// inspect` calls whose format reads `.State.Health`, each counted once the
// stand-in had recorded it.
const healthAsks = (calls) =>
  calls.filter((args) => args[0] === 'inspect' && String(args[2]).includes('.State.Health')).length;

test('task-up fails with the reason when Docker, the image, the health check or the migrations fail, and gives up at its limit', async (t) => {
  const usage = await taskFixture(t).run('task-up', 'webhook_inspector');
  assert.equal(usage.code, 2);
  assert.match(
    usage.logged,
    /Usage: node scripts\/db\.mjs task-up <task> \| task-test <task> .* \| task-down <task>/,
  );
  assert.equal((await taskFixture(t).run('task-sideways', '127')).code, 2);

  const down = taskFixture(t, { down: true });
  const result = await down.run('task-up', '127');
  assert.notEqual(result.code, 0);
  assert.match(
    result.logged,
    /docker inspect webhook-inspector-test-t127 exited with 1\.\nCannot connect to the Docker daemon/,
  );
  assert.deepEqual(
    down.calls().map((args) => args[0]),
    ['inspect'],
    'no run when Docker is down',
  );

  const image = taskFixture(t, { runFails: true });
  const noImage = await image.run('task-up', '127');
  assert.equal(noImage.code, 125);
  assert.match(noImage.logged, /npm run db:rebuild/);

  const sick = taskFixture(t, { health: ['starting', 'unhealthy'] });
  const unhealthy = await sick.run('task-up', '127');
  assert.equal(unhealthy.code, 1);
  assert.match(
    unhealthy.logged,
    /webhook-inspector-test-t127 is running, unhealthy; see `docker logs webhook-inspector-test-t127`/,
  );
  assert.deepEqual(unhealthy.printed, [], 'no URL for a database that is not ready');

  const migrations = taskFixture(t);
  const failed = await migrations.run('task-up', '127', { migrateExit: 3 });
  assert.equal(failed.code, 3);
  assert.match(failed.logged, /the migrations exited with 3/);
  assert.deepEqual(failed.printed, []);

  const noPort = taskFixture(t, { port: '' });
  const portless = await noPort.run('task-up', '127');
  assert.equal(portless.code, 1);
  assert.match(portless.logged, /docker port answered no port/);

  // The limit runs from before the first `docker` call, and each call is a Node
  // process. On a machine too loaded for the calls to be done within it, the
  // limit ends a call rather than the wait for health, as in the hung case
  // below: that attempt is made again, with a fresh stand-in and a longer
  // limit, and when none reaches the wait's own end the test fails (F-06).
  // The wait asks once a second, so a longer limit can fall inside a call
  // again: these four get past calls of up to 1.2 s each, where doubling the
  // limit would stop at 0.9 s.
  // A task-up that no longer gives up before its limit ends a call fails the
  // same way, and no check here tells the two apart, so the failure names
  // both, with each attempt's health asks as evidence, not a check: a wait
  // that went on asking about once a second until its limit points to
  // task-up, one whose calls were too slow to ask that often, to load.
  const missed = [];
  let waited = false;
  for (const limitSeconds of [2, 3, 5, 8]) {
    const never = taskFixture(t, { health: ['starting'] });
    const slow = await never.run('task-up', '127', { limitSeconds });
    assert.equal(slow.code, 124);
    assert.deepEqual(slow.printed, []);
    const callEnded = new RegExp(
      `^task-up 127 gave up after ${limitSeconds} s: docker (?:(?:inspect|run) webhook-inspector-test-t127|image inspect --format \\{\\{\\.Id\\}\\} ${IMAGE}) did not finish\\.$`,
      'm',
    );
    if (callEnded.test(slow.logged)) {
      missed.push({ limitSeconds, asks: healthAsks(never.calls()) });
      continue;
    }
    assert.match(
      slow.logged,
      new RegExp(
        `gave up after ${limitSeconds} s: webhook-inspector-test-t127 did not become healthy`,
      ),
    );
    waited = true;
    break;
  }
  assert.ok(
    waited,
    `no attempt reached the wait's own end: a docker call outlasted the limit of ${missed.map((a) => a.limitSeconds).join(', ')} s, the attempts asking for the container's health ${missed.map((a) => a.asks).join(', ')} times. The machine was too loaded for the calls to be done within the limit, or task-up no longer gives up before its limit ends a call; about one ask per second of the limit points to task-up, far fewer to load`,
  );

  const hung = taskFixture(t, { hang: true });
  const hang = await hung.run('task-up', '127', { limitSeconds: 1 });
  assert.equal(hang.code, 124);
  assert.match(
    hang.logged,
    /gave up after 1 s: docker inspect webhook-inspector-test-t127 did not finish/,
  );
});

// #280's acceptance 4, for a task's database: against a stand-in docker that
// answers as Docker Engine's CLI on Linux — a missing container in the
// daemon's words, a port it chose — the database comes up and goes as on the
// Mac; a daemon that is stopped, or a socket this user may not open, fails
// with the Engine's own words before anything is started.
test("on Linux a task's database comes up and goes against Docker Engine, and a stopped daemon or a refused socket fails with its words", async (t) => {
  const f = taskFixture(t, {
    missing: 'Error response from daemon: No such container: ',
    port: '127.0.0.1:32768\n',
  });
  const up = await f.run('task-up', '127');
  assert.equal(up.code, 0, up.logged);
  assert.deepEqual(up.printed, [
    'DATABASE_URL=postgres://webhook_inspector:webhook_inspector@127.0.0.1:32768/webhook_inspector_t127',
  ]);
  assert.equal(f.calls()[2][0], 'run', 'a missing container in the daemon’s words is absent');
  const down = await f.run('task-down', '127');
  assert.equal(down.code, 0, down.logged);
  assert.deepEqual(f.containers(), {});

  for (const stderr of [
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
    'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/webhook-inspector-test-t127/json": dial unix /var/run/docker.sock: connect: permission denied\n',
  ]) {
    const g = taskFixture(t, { answer: { status: 1, stderr } });
    const result = await g.run('task-up', '127');
    assert.equal(result.code, 1, stderr);
    assert.ok(
      result.logged.includes(
        `task-up 127 failed: docker inspect webhook-inspector-test-t127 exited with 1.\n${stderr.trim()}`,
      ),
      result.logged,
    );
    assert.deepEqual(
      g.calls().map((args) => args[0]),
      ['inspect'],
      'nothing started',
    );
  }
});

test('the published port is read from docker port, and nothing else is taken for one, at any length', () => {
  assert.equal(publishedPort('127.0.0.1:55432\n'), 55432);
  assert.equal(publishedPort('127.0.0.1:1\n[::1]:1\n'), 1);
  for (const bad of ['', 'x', '127.0.0.1:0', '127.0.0.1:70000', '55432', ':', null, undefined]) {
    assert.equal(publishedPort(bad), null, String(bad));
  }
  for (const size of [1_000, 100_000, 1_000_000]) {
    assert.equal(publishedPort(':'.repeat(size)), null);
    assert.equal(publishedPort(`${'1'.repeat(size)}`), null);
    assert.equal(publishedPort(`${'a:'.repeat(size / 2)}9`), 9);
    assert.equal(publishedPort(`127.0.0.1:${'9'.repeat(size)}`), null);
  }
});

// `task-test` runs the backend suite against the task's database. It is run
// here as a process of its own, by a driver that calls it with the stand-ins,
// so that what the suite prints reaches this test as it would reach a session,
// and its exit code is the process's. The stand-in npm records its arguments,
// its directory and the DATABASE_URL it was given, prints a line on each
// stream and exits with NPM_EXIT, or never ends with NPM_HANG.
const STANDIN_NPM = `
const fs = require('node:fs');
fs.writeFileSync(process.env.NPM_SEEN, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  url: process.env.DATABASE_URL ?? null,
}));
process.stdout.write('the suite on stdout\\n');
process.stderr.write('the suite on stderr\\n');
if (process.env.NPM_HANG) setInterval(() => {}, 1000);
else process.exit(Number(process.env.NPM_EXIT ?? 0));
`;

const DB_SCRIPT = fileURLToPath(new URL('./db.mjs', import.meta.url));
const DRIVER = `
import { taskDatabase } from ${JSON.stringify(DB_SCRIPT)};
const [action, task, ...rest] = process.argv.slice(2);
process.exitCode = await taskDatabase(action, task, {
  rest,
  docker: process.env.D_DOCKER,
  npm: process.env.D_NPM,
  migrate: process.env.D_MIGRATE,
  cwd: process.env.D_CWD,
  suiteLimitSeconds: Number(process.env.D_SUITE_LIMIT ?? 60),
});
`;

// The application's own database, as `.env` and a session's environment name
// it: what `task-test` must never run the suite against.
const SHARED_URL =
  'postgres://webhook_inspector:webhook_inspector@localhost:5432/webhook_inspector';

function suiteFixture(t, data = {}) {
  const f = taskFixture(t, data);
  const npm = join(f.dir, 'npm');
  writeFileSync(npm, `#!${process.execPath}\n${STANDIN_NPM}`, { mode: 0o755 });
  const driver = join(f.dir, 'driver.mjs');
  writeFileSync(driver, DRIVER);
  const npmSeen = join(f.dir, 'npm-seen');
  const suite = (args, env = {}) =>
    spawnSync(process.execPath, [driver, ...args], {
      cwd: f.dir,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        DATABASE_URL: SHARED_URL,
        DOCKER_STANDIN: f.file,
        MIGRATE_SEEN: f.seen,
        MIGRATE_EXIT: '0',
        NPM_SEEN: npmSeen,
        D_DOCKER: f.docker,
        D_NPM: npm,
        D_MIGRATE: f.migrate,
        D_CWD: f.dir,
        ...env,
      },
    });
  const npmRan = () => (existsSync(npmSeen) ? JSON.parse(readFileSync(npmSeen, 'utf8')) : null);
  return { ...f, suite, npmRan };
}

test("task-test brings the task's database up and runs the backend suite against it, passing its output and exit code through", (t) => {
  const f = suiteFixture(t);
  const ran = f.suite(['task-test', '127']);
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, 'the suite on stdout\n', "only the suite's own output on stdout");
  assert.match(ran.stderr, /the suite on stderr/);
  assert.match(
    ran.stderr,
    /task-test 127: npm test -w @webhook-inspector\/backend with DATABASE_URL=postgres:\/\/webhook_inspector:webhook_inspector@127\.0\.0\.1:55432\/webhook_inspector_t127\n/,
  );
  const seen = f.npmRan();
  assert.deepEqual(seen.args, BACKEND_SUITE);
  assert.deepEqual(BACKEND_SUITE, ['test', '-w', '@webhook-inspector/backend']);
  assert.equal(
    seen.url,
    'postgres://webhook_inspector:webhook_inspector@127.0.0.1:55432/webhook_inspector_t127',
  );
  assert.notEqual(seen.url, SHARED_URL, 'never the shared database the environment named');
  assert.equal(seen.cwd, realpathOf(f.dir), "from the checkout's root");
  assert.equal(readFileSync(f.seen, 'utf8'), seen.url, 'the migrations ran on the same database');
  assert.deepEqual(
    f.calls().map((args) => args[0]),
    ['inspect', 'image', 'run', 'inspect', 'inspect', 'port'],
  );

  // Its exit code is the suite's, and the arguments after -- are the suite's.
  for (const exit of ['1', '7', '130']) {
    const failed = f.suite(['task-test', '127'], { NPM_EXIT: exit });
    assert.equal(String(failed.status), exit, `the suite exited ${exit}`);
    assert.equal(failed.stdout, 'the suite on stdout\n');
  }
  const one = f.suite([
    'task-test',
    '127',
    '--',
    'src/db/cleanup.test.ts',
    '--test-name-pattern=pg_cron',
  ]);
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual(f.npmRan().args, [
    ...BACKEND_SUITE,
    '--',
    'src/db/cleanup.test.ts',
    '--test-name-pattern=pg_cron',
  ]);
  assert.equal(
    f.calls().filter((args) => args[0] === 'run').length,
    1,
    'one container, reused by every run',
  );
});

test('task-test runs no suite when the call is wrong or the database is not ready, and stops a suite that never ends', (t) => {
  for (const args of [
    ['task-test', '127', 'src/x.test.ts'],
    ['task-test', 'webhook_inspector'],
    ['task-test'],
    ['task-up', '127', '--', 'x'],
    ['task-down', '127', 'extra'],
  ]) {
    const f = suiteFixture(t);
    const result = f.suite(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /Usage: node scripts\/db\.mjs task-up <task> \| task-test <task>/);
    assert.equal(f.npmRan(), null, `no suite for ${args.join(' ')}`);
    assert.deepEqual(f.calls(), [], 'nor any docker');
  }
  for (const [what, data, env, exit] of [
    ['Docker down', { down: true }, {}, 1],
    ['no image', { runFails: true }, {}, 125],
    ['an unhealthy container', { health: ['unhealthy'] }, {}, 1],
    ['failed migrations', {}, { MIGRATE_EXIT: '4' }, 4],
  ]) {
    const f = suiteFixture(t, data);
    const result = f.suite(['task-test', '127'], env);
    assert.equal(result.status, exit, `${what}: ${result.stderr}`);
    assert.equal(f.npmRan(), null, `${what}: the suite ran`);
    assert.equal(result.stdout, '', what);
  }
  const f = suiteFixture(t);
  const hung = f.suite(['task-test', '127'], { NPM_HANG: '1', D_SUITE_LIMIT: '1' });
  assert.equal(hung.status, 124, hung.stderr);
  assert.match(hung.stderr, /task-test 127 gave up after 1 s: the backend suite did not finish/);
});

function realpathOf(path) {
  return realpathSync(path);
}
