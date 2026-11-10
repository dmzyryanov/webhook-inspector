// The local database commands behind `npm run db:up` and `npm run db:rebuild`
// (D159). Both run `docker compose` against docker-compose.yml, whose fixed
// project name makes every checkout and worktree address the same container.
//
// `up` never builds and never pulls, so it has no reason to reach a registry or
// Docker Desktop's credential helper, and `--wait` makes Compose exit non-zero
// unless the container is healthy. Each command also has an overall limit,
// enforced here in Node rather than with GNU `timeout`, which macOS does not
// ship: when Docker itself stops answering, the command and everything it
// started are stopped, and the script fails with a message instead of hanging.
// The commands are the same for Docker Desktop on the Mac and Docker Engine on
// Linux; what the messages say to check is the platform's (#280).
//
// `task-up <task>`, `task-test <task>` and `task-down <task>` give a task of
// the delivery queue a test database of its own (D216), so that tasks
// developed side by side never share test data: `node scripts/db.mjs task-up
// 127` starts the container `webhook-inspector-test-t127` and prints the line
// `DATABASE_URL=postgres://webhook_inspector:webhook_inspector@127.0.0.1:<port>/webhook_inspector_t127`;
// `node scripts/db.mjs task-test 127 [-- <arguments>]` does the same and then
// runs the backend suite against it — `npm test -w @webhook-inspector/backend
// [-- <arguments>]` from this checkout's root with that `DATABASE_URL` in the
// suite's environment, which outranks any `.env` — its output and exit code
// passed through; `task-down 127` removes the container and its data. A second database inside the application's container would
// not do: migration 002 creates pg_cron, which a server allows only in the one
// database it was started for (`cron.database_name`), and the suite waits for
// pg_cron to run a job in its own database. So each task's database is a
// disposable container of the image `up` starts, never built or pulled,
// started for that database alone, on a port Docker chooses on 127.0.0.1, and
// migrated before the URL is printed or the suite runs. `task-up` or
// `task-test` on a task whose container is there already starts it if it
// stopped, migrates it and gives the same database again.
// `task-down` removes only a container this script made for that task, which
// it knows by its label; the application's container and its
// `webhook_inspector` database are never touched.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The image `db:up` starts, which `db:rebuild` builds (D159) and
// docker-compose.yml names.
export const IMAGE = 'webhook-inspector-postgres';

// How long Compose waits for the container to report healthy. The health check
// in docker-compose.yml settles well inside this, on a new volume too.
export const WAIT_SECONDS = 120;

const UP = [
  'compose',
  'up',
  '--detach',
  '--no-build',
  '--pull',
  'never',
  '--wait',
  '--wait-timeout',
  String(WAIT_SECONDS),
  'postgres',
];

export const COMMANDS = {
  up: { limitSeconds: 180, steps: [UP] },
  // Building resolves `postgres:16` on Docker Hub and installs pg_cron through
  // apt, so it is allowed longer. It is still bounded.
  rebuild: { limitSeconds: 600, steps: [['compose', 'build', 'postgres'], UP] },
};

// Which Docker this is: Docker Desktop on the Mac, Docker Engine elsewhere,
// Linux among them.
export const dockerOf = (platform = process.platform) =>
  platform === 'darwin' ? 'Docker Desktop' : 'Docker Engine';

// Why the container did not start, by what Compose printed: the same for
// `db:up` and for the start that ends `db:rebuild`.
const NOT_STARTED = [
  '- "port is already allocated" — something else listens on POSTGRES_PORT (default 5432),',
  '  such as another PostgreSQL or a database container of another project; `docker ps`',
  '  lists the containers.',
  '- "unhealthy" — see `npm run db:logs`; a volume created with other credentials fails the',
  '  health check.',
];

// What to check after the step `args` of `db:<name>` failed.
const hints = (name, args, platform) => {
  if (name === 'up') {
    return [
      'The database is not running. The usual causes, by the message above:',
      `- "No such image: ${IMAGE}" — build it once with \`npm run db:rebuild\`.`,
      ...NOT_STARTED,
    ];
  }
  if (args === UP) {
    return [
      'The image was built, but the database did not start. The usual causes, by the message above:',
      ...NOT_STARTED,
    ];
  }
  return [
    'The image was not built.',
    dockerOf(platform) === 'Docker Desktop'
      ? 'Building pulls `postgres:16` from Docker Hub: check the network and Docker Desktop.'
      : 'Building pulls `postgres:16` from Docker Hub: check the network and the Docker Engine daemon.',
  ];
};

// What a Docker that stopped answering may be waiting on: Docker Desktop and
// its credential helper on the Mac; on Linux the Engine's daemon, or a socket
// this user may not open.
const notAnswering = (platform) =>
  dockerOf(platform) === 'Docker Desktop'
    ? [
        'Docker is not answering: Docker Desktop may be stopped or still starting, or its',
        'credential helper (docker-credential-desktop) may be waiting on a locked keychain.',
        'The database was not reported healthy. Check Docker Desktop, then run it again.',
      ]
    : [
        'Docker is not answering: the Docker Engine daemon may be stopped or still starting',
        '(`systemctl status docker`), or this user may not open its socket, /var/run/docker.sock',
        '(root or the docker group). The database was not reported healthy. Check the daemon,',
        'then run it again.',
      ];

// Between the polite stop and the forced one when the limit runs out.
const GRACE_MS = 5000;

// Signals this script passes on to the Docker process group, with the exit code
// it then reports: 128 plus the signal's number, as a shell would.
export const FORWARDED_SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

// Runs one command as the leader of its own process group, so that at the
// deadline the whole group is stopped — a credential helper Docker started
// included — rather than only the process this script started. With
// `capture`, what the command prints is returned as `out` and `err` instead
// of shown; `toStderr` shows its stdout on this script's stderr, which keeps
// this script's stdout for its own answer; `env` is the environment it runs
// with.
function runStep(executable, args, { cwd, deadline, capture = false, toStderr = false, env }) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer;
    let killer;
    let out = '';
    let err = '';

    const stdio = capture ? ['ignore', 'pipe', 'pipe'] : toStderr ? ['ignore', 2, 2] : 'inherit';
    const child = spawn(executable, args, {
      cwd,
      stdio,
      detached: true,
      env: env ?? process.env,
    });
    child.stdout?.setEncoding('utf8').on('data', (chunk) => {
      if (out.length < 65_536) out += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => {
      if (err.length < 65_536) err += chunk;
    });

    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group has already gone.
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      for (const signal of Object.keys(FORWARDED_SIGNALS)) process.off(signal, interrupt);
      resolve({ out, err, ...result });
    };
    // The group is detached from the terminal, so Ctrl-C or a closed terminal
    // reaches only this script; pass it on rather than leave Docker running
    // behind it.
    const interrupt = (signal) => {
      signalGroup(signal);
      finish({ code: FORWARDED_SIGNALS[signal], interrupted: true });
    };

    for (const signal of Object.keys(FORWARDED_SIGNALS)) process.on(signal, interrupt);

    timer = setTimeout(
      () => {
        timedOut = true;
        signalGroup('SIGTERM');
        killer = setTimeout(() => {
          signalGroup('SIGKILL');
          finish({ code: 124, timedOut: true });
        }, GRACE_MS);
      },
      Math.max(0, deadline - Date.now()),
    );

    child.on('error', (error) => {
      console.error(`Could not run ${executable}: ${error.message}`);
      finish({ code: 127 });
    });
    // With stdout captured, its last bytes may arrive after the exit.
    child.on(capture ? 'close' : 'exit', (code, signal) => {
      if (timedOut) {
        // Whatever the command left behind in its group goes too.
        signalGroup('SIGKILL');
        finish({ code: 124, timedOut: true });
        return;
      }
      finish({ code: code ?? (signal ? 1 : 0) });
    });
  });
}

/**
 * Runs `up` or `rebuild` and resolves to the exit code: 0 only when Compose
 * reported the container healthy, 124 when the overall limit ran out.
 * `platform`, `process.platform` unless given, picks what the messages say to
 * check.
 */
export async function run(
  name,
  {
    docker = 'docker',
    cwd = ROOT,
    limitSeconds,
    log = console.error,
    platform = process.platform,
  } = {},
) {
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    log(`Usage: node scripts/db.mjs <${Object.keys(COMMANDS).join('|')}>`);
    return 2;
  }
  const limit = limitSeconds ?? command.limitSeconds;
  const deadline = Date.now() + limit * 1000;

  for (const args of command.steps) {
    const { code, timedOut, interrupted } = await runStep(docker, args, { cwd, deadline });
    if (interrupted) return code;
    if (timedOut) {
      log(
        [
          `\ndb:${name} gave up after ${limit} s: \`docker ${args.join(' ')}\` did not finish.`,
          ...notAnswering(platform),
        ].join('\n'),
      );
      return code;
    }
    if (code !== 0) {
      log(`\ndb:${name} failed: \`docker ${args.join(' ')}\` exited with ${code}.`);
      log(hints(name, args, platform).join('\n'));
      return code;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// A task's own test database (D216)
// ---------------------------------------------------------------------------

// A task as the delivery queue names it: an issue number, or `day-<word>`.
const TASK = /^(?:[1-9]\d{0,8}|day-[a-z0-9][a-z0-9-]{0,39})$/;
// The label that marks a container as one this script made for a task.
export const LABEL = 'webhook-inspector.task';
const USER = 'webhook_inspector';
const PASSWORD = 'webhook_inspector';
// How often the container's health is asked while it starts.
const POLL_MS = 1000;
// The longest the backend suite may run under `task-test`, its group stopped
// past it: a net under the suite's own per-test timeout, not a pace.
export const SUITE_LIMIT_SECONDS = 1800;
// What `task-test` runs, the arguments after `--` appended after a `--` of
// its own, as the workspace script takes them.
export const BACKEND_SUITE = ['test', '-w', '@webhook-inspector/backend'];

const slugOf = (task) => (/^\d/.test(task) ? `t${task}` : task);

/** The container and the database of a task, or null for a name that is no task. */
export function taskNames(task) {
  if (typeof task !== 'string' || !TASK.test(task)) return null;
  const slug = slugOf(task);
  return {
    container: `webhook-inspector-test-${slug}`,
    database: `webhook_inspector_${slug.replaceAll('-', '_')}`,
  };
}

/** The `docker run` arguments that start a task's database. */
export function runArguments(task) {
  const { container, database } = taskNames(task);
  return [
    'run',
    '--detach',
    '--pull',
    'never',
    '--name',
    container,
    '--label',
    `${LABEL}=${task}`,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    `POSTGRES_USER=${USER}`,
    '--env',
    `POSTGRES_PASSWORD=${PASSWORD}`,
    '--env',
    `POSTGRES_DB=${database}`,
    // As docker-compose.yml's: the role can query the database over TCP.
    '--health-cmd',
    `psql -h 127.0.0.1 -U ${USER} -d ${database} -tAc "SELECT 1"`,
    '--health-interval',
    '2s',
    '--health-timeout',
    '5s',
    '--health-retries',
    '30',
    IMAGE,
    'postgres',
    '-c',
    'shared_preload_libraries=pg_cron',
    '-c',
    `cron.database_name=${database}`,
    '-c',
    'cron.use_background_workers=on',
  ];
}

/** The port a `docker port` answer names, or null. */
export function publishedPort(text) {
  const match = /^\S*:(\d{1,5})\s*$/m.exec(text ?? '');
  const port = match ? Number(match[1]) : 0;
  return port > 0 && port < 65_536 ? port : null;
}

/**
 * Runs `task-up`, `task-test` or `task-down` for a task and resolves to the
 * exit code: 0 when the database is ready, with its URL printed, or removed;
 * the suite's own under `task-test` once the database is ready; 2 for a wrong
 * call; 124 when a limit ran out; another when Docker or the migrations
 * failed, with the reason on stderr. `rest` is what follows the task on the
 * command line: nothing, or for `task-test` a `--` and the suite's arguments.
 */
export async function taskDatabase(
  action,
  task,
  {
    rest = [],
    docker = 'docker',
    node = process.execPath,
    npm = 'npm',
    migrate = join(ROOT, 'apps', 'backend', 'src', 'db', 'migrate.ts'),
    cwd = ROOT,
    limitSeconds = COMMANDS.up.limitSeconds,
    suiteLimitSeconds = SUITE_LIMIT_SECONDS,
    log = console.error,
    print = console.log,
  } = {},
) {
  const names = taskNames(task);
  // Nothing after the task, or for `task-test` a `--` and the suite's own.
  const restFits = rest.length === 0 || (action === 'task-test' && rest[0] === '--');
  const suiteArguments = rest.slice(1);
  if (!['task-up', 'task-test', 'task-down'].includes(action) || names === null || !restFits) {
    log(
      'Usage: node scripts/db.mjs task-up <task> | task-test <task> [-- <arguments for the backend suite>] | task-down <task>, the task an issue number (127) or day-<word>',
    );
    return 2;
  }
  const { container, database } = names;
  const deadline = Date.now() + limitSeconds * 1000;
  const step = (args, options = {}) => runStep(docker, args, { cwd, deadline, ...options });
  const failed = (what, result) => {
    if (result.timedOut) {
      log(`${action} ${task} gave up after ${limitSeconds} s: ${what} did not finish.`);
      return 124;
    }
    const said = (result.err ?? '').trim();
    log(`${action} ${task} failed: ${what} exited with ${result.code}.${said ? `\n${said}` : ''}`);
    return result.code === 0 ? 1 : result.code;
  };

  // Whose container this is, and whether it runs: one this script did not
  // make for this task is never started, migrated or removed.
  const found = await step(
    ['inspect', '--format', `{{index .Config.Labels "${LABEL}"}} {{.State.Status}}`, container],
    { capture: true },
  );
  const absent = found.code !== 0 && /no such (?:object|container)/i.test(found.err);
  if (found.interrupted || (found.code !== 0 && !absent)) {
    return failed(`docker inspect ${container}`, found);
  }
  const [owner, status] = absent ? [null, null] : found.out.trim().split(' ');
  if (!absent && owner !== task) {
    log(
      `${action} ${task} refused: a container named ${container} is there, not made by this script for ${task}; nothing was changed.`,
    );
    return 1;
  }

  if (action === 'task-down') {
    if (absent) {
      print(`No test database of ${task} to remove (${container}).`);
      return 0;
    }
    const removed = await step(['rm', '--force', '--volumes', container], { toStderr: true });
    if (removed.code !== 0 || removed.interrupted) return failed(`docker rm ${container}`, removed);
    print(`Removed the test database of ${task}: ${container} and its data.`);
    return 0;
  }

  if (absent) {
    const started = await step(runArguments(task), { toStderr: true });
    if (started.code !== 0 || started.interrupted) {
      log(`No such image ${IMAGE}? Build it once with \`npm run db:rebuild\`.`);
      return failed(`docker run ${container}`, started);
    }
  } else if (status !== 'running') {
    const started = await step(['start', container], { toStderr: true });
    if (started.code !== 0 || started.interrupted)
      return failed(`docker start ${container}`, started);
  }

  for (;;) {
    const health = await step(
      [
        'inspect',
        '--format',
        '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
        container,
      ],
      { capture: true },
    );
    if (health.code !== 0 || health.interrupted)
      return failed(`docker inspect ${container}`, health);
    const [state, healthy] = health.out.trim().split(' ');
    if (state === 'running' && healthy === 'healthy') break;
    if (state !== 'running' || healthy === 'unhealthy') {
      log(
        `${action} ${task} failed: ${container} is ${state}${healthy ? `, ${healthy}` : ''}; see \`docker logs ${container}\`.`,
      );
      return 1;
    }
    if (Date.now() + POLL_MS >= deadline) {
      log(
        `${action} ${task} gave up after ${limitSeconds} s: ${container} did not become healthy.`,
      );
      return 124;
    }
    await sleep(POLL_MS);
  }

  const port = await step(['port', container, '5432/tcp'], { capture: true });
  const published = publishedPort(port.out);
  if (port.code !== 0 || published === null) {
    return port.code === 0
      ? (log(`${action} ${task} failed: docker port answered no port for ${container}.`), 1)
      : failed(`docker port ${container}`, port);
  }
  const url = `postgres://${USER}:${PASSWORD}@127.0.0.1:${published}/${database}`;

  // The migrations, as `npm run db:migrate` applies them, to this database
  // alone: the URL is the only one the runner sees, and no `.env` is read.
  const migrated = await runStep(node, [migrate], {
    cwd,
    deadline,
    toStderr: true,
    env: { ...process.env, DATABASE_URL: url },
  });
  if (migrated.code !== 0 || migrated.interrupted) return failed('the migrations', migrated);
  if (action === 'task-up') {
    print(`DATABASE_URL=${url}`);
    return 0;
  }

  // The backend suite against this database alone: the URL is put into the
  // suite's environment, which outranks the `.env` its script reads, so the
  // application's `webhook_inspector` is never what it runs against.
  const suite = [...BACKEND_SUITE, ...(suiteArguments.length > 0 ? ['--', ...suiteArguments] : [])];
  log(`${action} ${task}: npm ${suite.join(' ')} with DATABASE_URL=${url}`);
  const ran = await runStep(npm, suite, {
    cwd,
    deadline: Date.now() + suiteLimitSeconds * 1000,
    env: { ...process.env, DATABASE_URL: url },
  });
  if (ran.timedOut) {
    log(
      `${action} ${task} gave up after ${suiteLimitSeconds} s: the backend suite did not finish.`,
    );
  }
  return ran.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [name, task, ...rest] = process.argv.slice(2);
  process.exitCode = name?.startsWith('task-')
    ? await taskDatabase(name, task, { rest })
    : await run(name);
}
