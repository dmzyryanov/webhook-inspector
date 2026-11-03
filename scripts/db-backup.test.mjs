// The nightly database backup (deploy/helm/qa-tools/files/db-backup.sh, D176),
// run with bash against stand-ins for `pg_dump`, `psql`, `pg_restore`, `initdb`,
// `pg_ctl` and `df` on PATH, and pass-throughs for `date` and `sha256sum` that
// can fix the time stamp or fail the check: nothing here starts PostgreSQL or
// talks to a database. What is pinned is the order issue #67 fixes, the
// pg_dump command, which leaves out the realtime outbox's rows (D221), the
// free-space guard, the counts compared after the restore, the restore list
// without pg_cron, pruning to the three newest dumps without ever deleting the
// new one, and that a run which fails at any step, or is stopped, leaves no new
// dump behind. A real run against PostgreSQL with pg_cron is recorded in D176.
// Every run also writes its outcome to a status file, which the notifier in the
// backup pod sends to Statuser (D181): `ok`, or `fail` and the script's own
// message, readable by another uid; further tests run the notifier on it.
// The off-server copy (D190, issue #89) is the script's sixth step: with a
// stand-in for `gpg` it is pinned that the dump is encrypted only after it is
// saved, checked and pruned, that only the ciphertext is handed over, that the
// run waits for the uploader's answer, and that a failed encryption, a failure
// the uploader reports or no answer fails the run as `Off-server copy failed:
// …` with the dump kept; one test runs the real `gpg` on the chart's public
// key, and the last run the script, the uploader and the notifier together.
// The uploader itself is pinned in scripts/db-backup-offsite.test.mjs. Since
// issue #122 a run of the script that does not end within its minute is
// killed, SIGKILL and not SIGTERM, which bash holds back while a command runs
// in the foreground: the test fails by name and the file goes on.

import assert from 'node:assert/strict';
import nodeTest, { after } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn, setTimeout as sleep } from 'node:timers/promises';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';

// Every test of this file, and each of its subtests, has TEST_LIMIT_MS, run
// with a bare `node --test` as with `operations-tests`' `--test-timeout`.
// After it the test fails, as `test timed out after …ms`, under its own name,
// and its `after` hooks stop what it started. The limit is a timer of this
// file's process, so it cannot fire while `run` blocks it in `spawnSync`:
// that is bounded by `run`'s own minute, after which bash is killed with
// SIGKILL, the one signal it cannot hold back while a command runs in the
// foreground, and the test fails by name. A command it ran in the foreground
// may be left running on that path alone. A test that ran out of time is
// failed but its function runs on, and a subtest it starts then gets a signal
// of its own that never aborts; so every test runs under `current`, which
// holds the signal and the start of the top-level test it belongs to, and
// `until` gives up, and `run` and `start` refuse, once that one has ended or,
// for `run` and `start`, has had its TEST_LIMIT_MS: the remaining subtests
// of a test out of time fail at once instead of each waiting out its minute.
// `operations-tests` also stops its whole run after a bound of its own and
// names the tests still running (scripts/test-run-limit.mjs, D190).
const TEST_LIMIT_MS = 300_000;
const current = new AsyncLocalStorage();
const test = (name, options, fn) => {
  const [settings, body] = typeof options === 'function' ? [{}, options] : [options, fn];
  return nodeTest(name, { timeout: TEST_LIMIT_MS, ...settings }, async (t) => {
    // One turn of the event loop first, in which this process writes out
    // what it has to report: the tests before this one and this one's start.
    // It cannot while a test blocks it in a synchronous call, so without the
    // turn a run of such tests would be reported only at the file's end.
    await turn();
    return current.run({ signal: t.signal, started: Date.now() }, () => body(t));
  });
};
// How long `run` lets the script take: many times what a run takes on a
// runner given a fifth of a processor.
const RUN_LIMIT_MS = 60_000;
// Fails at once when the top-level test the caller belongs to has ended, or
// has had its TEST_LIMIT_MS: a test that blocks this process with one run
// after another gives its own limit, a timer, no moment to fire, so the time
// is also read here, between two runs.
const stillRunning = (what) => {
  const owner = current.getStore();
  if (owner === undefined) return;
  if (owner.signal.aborted) assert.fail(`${what} was not begun: its test has ended`);
  if (Date.now() - owner.started > TEST_LIMIT_MS) {
    assert.fail(`${what} was not begun: its test has had its ${TEST_LIMIT_MS / 1000} s`);
  }
};

const SCRIPT = fileURLToPath(
  new URL('../deploy/helm/qa-tools/files/db-backup.sh', import.meta.url),
);
const NOTIFIER = fileURLToPath(
  new URL('../deploy/helm/qa-tools/files/db-backup-notify.mjs', import.meta.url),
);
const UPLOADER = fileURLToPath(
  new URL('../deploy/helm/qa-tools/files/db-backup-offsite.mjs', import.meta.url),
);
// The tests' public key (a throwaway one, #367), to which the off-server copy is encrypted.
const RECIPIENT = fileURLToPath(new URL('fixtures/db-backup-recipient.asc', import.meta.url));
const TEMPLATE = readFileSync(
  new URL('../deploy/helm/qa-tools/templates/db-backup.yaml', import.meta.url),
  'utf8',
);
const VALUES = readFileSync(
  new URL('../deploy/helm/qa-tools/values.yaml', import.meta.url),
  'utf8',
);

// The real executable of that name on PATH, for the pass-through stand-ins.
const which = (name) =>
  process.env.PATH.split(':')
    .map((dir) => join(dir, name))
    .find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
const REAL_DATE = which('date');
const REAL_SHA256SUM = which('sha256sum');
const REAL_GPG = which('gpg');
const REAL_HEAD = which('head');
const REAL_MV = which('mv');

// Stands in for the database password; it must never reach the output.
const SECRET = 'stand-in-password-9f41c2';
// What the stand-ins put where a server's message would quote a row.
const ROW = 'secret-row-content';
const GIB = 1024 * 1024; // in KiB, as `df -k` counts

// `pg_restore -l` of a dump of the migrated schema with pg_cron (PostgreSQL
// 16.15, 2026-09-28). The first two entries end in a space, as the tool
// prints them.
const TOC = [
  ';',
  '; Archive created at 2026-09-28 14:29:39 UTC',
  ';     dbname: qa_tools',
  ';',
  '; Selected TOC Entries:',
  ';',
  '2; 3079 16422 EXTENSION - pg_cron ',
  '3510; 0 0 COMMENT - EXTENSION pg_cron ',
  '3511; 0 0 ACL - SCHEMA public pg_database_owner',
  '7; 2615 16492 SCHEMA - stats qa_tools',
  '3512; 0 0 ACL - SCHEMA stats qa_tools',
  '228; 1255 16403 FUNCTION public is_header_pairs(jsonb) qa_tools',
  '225; 1259 16473 TABLE public request_responses qa_tools',
  '220; 1259 16404 TABLE public requests qa_tools',
  '218; 1259 16385 TABLE public schema_migrations qa_tools',
  '219; 1259 16393 TABLE public sessions qa_tools',
  '227; 1259 16497 VIEW stats requests qa_tools',
  '3513; 0 0 ACL stats TABLE requests qa_tools',
  '226; 1259 16493 VIEW stats sessions qa_tools',
  '3514; 0 0 ACL stats TABLE sessions qa_tools',
  '3307; 0 16425 TABLE DATA cron job qa_tools',
  '3309; 0 16444 TABLE DATA cron job_run_details qa_tools',
  '3502; 0 16473 TABLE DATA public request_responses qa_tools',
  '3501; 0 16404 TABLE DATA public requests qa_tools',
  '3499; 0 16385 TABLE DATA public schema_migrations qa_tools',
  '3500; 0 16393 TABLE DATA public sessions qa_tools',
  '3515; 0 0 SEQUENCE SET cron jobid_seq qa_tools',
  '3516; 0 0 SEQUENCE SET cron runid_seq qa_tools',
  '3351; 2606 16485 CONSTRAINT public request_responses request_responses_pkey qa_tools',
  '3342; 2606 16415 CONSTRAINT public requests requests_pkey qa_tools',
  '3340; 2606 16401 CONSTRAINT public sessions sessions_pkey qa_tools',
  '3343; 1259 16421 INDEX public requests_session_received_at_idx qa_tools',
  '3353; 2606 16486 FK CONSTRAINT public request_responses request_responses_request_id_fkey qa_tools',
  '3352; 2606 16416 FK CONSTRAINT public requests requests_session_id_fkey qa_tools',
];
const PG_CRON_ENTRIES = [
  '2; 3079 16422 EXTENSION - pg_cron ',
  '3510; 0 0 COMMENT - EXTENSION pg_cron ',
  '3307; 0 16425 TABLE DATA cron job qa_tools',
  '3309; 0 16444 TABLE DATA cron job_run_details qa_tools',
  '3515; 0 0 SEQUENCE SET cron jobid_seq qa_tools',
  '3516; 0 0 SEQUENCE SET cron runid_seq qa_tools',
];

// Every stand-in first appends one line to `calls`: its name, whether the
// production password is in its environment, and its arguments. `hang` makes a
// stand-in a step that never ends, and says so by its PID in `hang.pid`: half
// a second after it started, so that the script, which starts a step and then
// notes its PID, has noted it before a test sends the stop signal — a signal
// in between finds no step to stop, and in the pod only the container's end
// stops it — and under a temporary name first, so that the file is never
// read before the PID is in it.
const PRELUDE = `#!/bin/sh
if [ -n "\${PGPASSWORD:-}" ]; then pw=set; else pw=unset; fi
printf '%s pw=%s %s\\n' "\${0##*/}" "$pw" "$*" >> "$FAKE_DIR/calls"
hang() {
  sleep 0.5
  echo $$ > "$FAKE_DIR/hang.pid.tmp" && mv "$FAKE_DIR/hang.pid.tmp" "$FAKE_DIR/hang.pid"
  exec sleep 30
}
`;

const STUBS = {
  df: `
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
printf '/dev/stand-in 61202244 1000 %s 1%% /\\n' "$FAKE_DF_AVAIL_KB"
`,
  // With -c: a statement on the scratch server. Without: the snapshot session,
  // which answers the export with a snapshot id and the dump-time counts. Its
  // messages take real psql's shapes: a connection failure starts "psql:
  // error:"; a server error is "psql:<file>:<line>: ERROR:" for a script read
  // with -f, and a bare "ERROR:" for stdin or -c; continuation lines follow.
  psql: `
sql=; file=; prev=
for arg in "$@"; do
  if [ "$prev" = -c ]; then sql=$arg; fi
  if [ "$prev" = -f ]; then file=$arg; fi
  prev=$arg
done
if [ -n "$sql" ]; then
  case "$sql" in
    'CREATE DATABASE'*) step=createdb ;;
    *) step=count ;;
  esac
  if [ "$FAKE_FAIL" = "$step" ]; then
    echo "ERROR:  $step failed on the scratch server" >&2
    echo 'DETAIL:  Key (id)=(${ROW}) already exists.' >&2
    exit 1
  fi
  if [ "$step" = count ]; then echo "$FAKE_RESTORED_COUNTS"; fi
  exit 0
fi
if [ "$FAKE_FAIL" = snapshot ]; then
  echo 'psql: error: connection to server failed: FATAL:  password authentication failed' >&2
  exit 2
fi
if [ -n "$file" ]; then where="psql:$file:2: "; else where=; fi
n=0
while IFS= read -r line; do
  n=$((n + 1))
  printf 'psql< %s\\n' "$line" >> "$FAKE_DIR/calls"
  case "$line" in
    *pg_export_snapshot*)
      if [ "$FAKE_FAIL" = snapshot-sql ]; then
        echo "\${where}ERROR:  permission denied for table sessions" >&2
        echo 'CONTEXT:  a line quoting ${ROW}' >&2
        exit 3
      fi
      echo "00000003-0000001B-1|$FAKE_DUMP_COUNTS" ;;
  esac
done
`,
  // Writes part of a dump before it fails or hangs, as a real one would.
  pg_dump: `
out=; prev=
for arg in "$@"; do
  if [ "$prev" = -f ]; then out=$arg; fi
  prev=$arg
done
printf 'PGDMP stand-in dump, %s\\n' "$FAKE_DUMP_COUNTS" > "$out"
if [ "$FAKE_FAIL" = pg_dump ]; then
  echo 'pg_dump: error: Dumping the contents of table "requests" failed: PQgetResult() failed.' >&2
  echo 'CONTEXT:  COPY requests, line 1: "${ROW}"' >&2
  exit 1
fi
if [ "$FAKE_HANG" = pg_dump ]; then hang; fi
`,
  pg_restore: `
list=; out=; prev=; listing=0
for arg in "$@"; do
  if [ "$arg" = -l ]; then listing=1; fi
  if [ "$prev" = -L ]; then list=$arg; fi
  if [ "$prev" = -f ]; then out=$arg; fi
  prev=$arg
done
if [ "$listing" = 1 ]; then
  if [ "$FAKE_FAIL" = toc ]; then echo 'pg_restore: error: could not read input file' >&2; exit 1; fi
  cp "$FAKE_DIR/toc" "$out"
  exit 0
fi
cp "$list" "$FAKE_DIR/restore.list"
if [ "$FAKE_FAIL" = restore ]; then
  echo 'pg_restore: error: COPY failed for table "requests": ERROR:  invalid input syntax' >&2
  echo 'CONTEXT:  COPY requests, line 1, column headers: "${ROW}"' >&2
  exit 1
fi
if [ "$FAKE_HANG" = restore ]; then hang; fi
`,
  initdb: `
dir=; prev=
for arg in "$@"; do
  if [ "$prev" = -D ]; then dir=$arg; fi
  prev=$arg
done
if [ "$FAKE_FAIL" = initdb ]; then echo 'initdb: error: could not create directory' >&2; exit 1; fi
mkdir -p "$dir"
`,
  pg_ctl: `
action=
for arg in "$@"; do action=$arg; done
if [ "$FAKE_FAIL" = "$action" ]; then echo "pg_ctl: could not $action the server" >&2; exit 1; fi
`,
  // Stands in for the encryption: its "ciphertext" is a fixed line and then
  // the input, so a test can tell which file was encrypted. It first records
  // its GNUPGHOME and what the dump's directory held when it was called.
  gpg: `
out=; in=; prev=
for arg in "$@"; do
  if [ "$prev" = --output ]; then out=$arg; fi
  prev=$arg
  in=$arg
done
{
  printf 'GNUPGHOME=%s\\n' "\${GNUPGHOME:-}"
  if [ -d "\${GNUPGHOME:-}" ]; then echo 'home=a directory'; else echo 'home=missing'; fi
  ls -A "$(dirname "$in")"
} > "$FAKE_DIR/gpg.seen"
if [ "$FAKE_FAIL" = gpg-empty ]; then : > "$out"; exit 0; fi
if [ "$FAKE_FAIL" = gpg-nothing ]; then exit 0; fi
printf 'stand-in ciphertext of: ' > "$out"
if [ "$FAKE_FAIL" = gpg ]; then
  echo "gpg: $in: encryption failed: No public key" >&2
  echo 'a line quoting ${ROW}' >&2
  exit 2
fi
if [ "$FAKE_HANG" = gpg ]; then hang; fi
cat "$in" >> "$out"
`,
};

// Pass-throughs to the real tools, which log nothing. `date` answers
// FAKE_STAMP for the file-name format when it is set; `sha256sum -c` fails when
// FAKE_FAIL is verify; `head` hangs when FAKE_HANG is head, as a read of a FIFO
// would, for five minutes, which no test waits out; and `mv`, with FAKE_STOP_AFTER_HANDOVER set, sends the script its stop
// signal right after it has moved the encrypted copy into place, the one
// moment a test cannot hit by timing.
const PASSTHROUGHS = {
  head: `#!/bin/sh
if [ "\${FAKE_HANG:-}" = head ]; then
  sleep 0.5
  echo $$ > "$FAKE_DIR/hang.pid.tmp" && "$FAKE_REAL_MV" "$FAKE_DIR/hang.pid.tmp" "$FAKE_DIR/hang.pid"
  exec sleep 300
fi
exec "$FAKE_REAL_HEAD" "$@"
`,
  mv: `#!/bin/sh
"$FAKE_REAL_MV" "$@" || exit $?
for last in "$@"; do :; done
case "\${FAKE_STOP_AFTER_HANDOVER:-}:$last" in
  1:*.dump.gpg) kill -TERM "$PPID" ;;
esac
exit 0
`,
  date: `#!/bin/sh
if [ -n "\${FAKE_STAMP:-}" ] && [ "$*" = '-u +%Y%m%dT%H%M%SZ' ]; then echo "$FAKE_STAMP"; exit 0; fi
exec "$FAKE_REAL_DATE" "$@"
`,
  sha256sum: `#!/bin/sh
if [ "$FAKE_FAIL" = verify ] && [ "$1" = -c ]; then exit 1; fi
exec "$FAKE_REAL_SHA256SUM" "$@"
`,
};

// The directory of stand-ins, written once for the whole file rather than once
// a test: a stand-in keeps nothing of its own — each finds its test's state
// through FAKE_DIR — and macOS checks every new executable on its first run,
// which cost each test more than a second. `realGpg` leaves the `gpg`
// stand-in out, so the script finds the real one.
const BINS = new Map();
function standIns(realGpg) {
  if (!BINS.has(realGpg)) {
    const bin = mkdtempSync(join(tmpdir(), 'qa-db-backup-bin-'));
    for (const [name, body] of Object.entries(STUBS)) {
      if (name === 'gpg' && realGpg) continue;
      writeFileSync(join(bin, name), PRELUDE + body, { mode: 0o755 });
    }
    for (const [name, body] of Object.entries(PASSTHROUGHS)) {
      writeFileSync(join(bin, name), body, { mode: 0o755 });
    }
    BINS.set(realGpg, bin);
  }
  return BINS.get(realGpg);
}
after(() => {
  for (const bin of BINS.values()) rmSync(bin, { recursive: true, force: true });
});

// A throwaway backup directory and scratch directory, and the PATH of stand-ins.
function setup(t, { files = {}, realGpg = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qa-db-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = standIns(realGpg);
  const backup = join(root, 'backup');
  const scratch = join(root, 'scratch');
  const state = join(root, 'state');
  // The emptyDir the backup shares with its notifier.
  const statusDir = join(root, 'status');
  // The emptyDir it shares with the off-server copy's uploader.
  const offsite = join(root, 'offsite');
  for (const dir of [backup, scratch, state, statusDir, offsite]) mkdirSync(dir);
  const statusFile = join(statusDir, 'db-backup.status');
  writeFileSync(join(state, 'toc'), `${TOC.join('\n')}\n`);
  writeFileSync(join(state, 'calls'), '');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(backup, name), content);

  const env = (overrides = {}) => ({
    PATH: `${bin}:${process.env.PATH}`,
    PGHOST: 'db.stand-in.test',
    PGPORT: '5432',
    PGUSER: 'qa_tools',
    PGDATABASE: 'qa_tools',
    PGPASSWORD: SECRET,
    BACKUP_DIR: backup,
    BACKUP_SCRATCH: scratch,
    BACKUP_KEEP: '3',
    BACKUP_MIN_FREE_GIB: '10',
    FAKE_DIR: state,
    FAKE_DF_AVAIL_KB: String(46 * GIB),
    FAKE_DUMP_COUNTS: '113|133',
    FAKE_RESTORED_COUNTS: '113|133',
    FAKE_FAIL: '',
    FAKE_HANG: '',
    FAKE_STAMP: '',
    FAKE_REAL_DATE: REAL_DATE,
    FAKE_REAL_SHA256SUM: REAL_SHA256SUM,
    FAKE_REAL_HEAD: REAL_HEAD,
    FAKE_REAL_MV: REAL_MV,
    BACKUP_STATUS_FILE: statusFile,
    ...overrides,
  });
  // A run of the script, to its end or for a minute at most: then bash is
  // killed, and the result says so in its output. SIGKILL, because the
  // SIGTERM `spawnSync` sends by default waits, in bash, for the command in
  // the foreground to end, and this process is blocked until bash has. A
  // test may run another script, a copy, with a limit of its own.
  const run = (overrides, { script = SCRIPT, limitMs = RUN_LIMIT_MS } = {}) => {
    stillRunning('the run');
    const result = spawnSync('bash', [script], {
      env: env(overrides),
      encoding: 'utf8',
      timeout: limitMs,
      killSignal: 'SIGKILL',
    });
    const ended = result.error
      ? `\n[the run: ${result.error.code ?? result.error.message}${result.signal ? `, killed by ${result.signal}` : ''}]`
      : '';
    return { ...result, output: `${result.stdout}${result.stderr}${ended}` };
  };
  // The same run without blocking this process, for a test that plays the
  // uploader's part meanwhile. `exited` resolves like `run`'s result.
  const start = (overrides) => {
    stillRunning('the run');
    const child = spawn('bash', [SCRIPT], { env: env(overrides) });
    t.after(() => child.kill('SIGKILL'));
    const result = { stdout: '', stderr: '' };
    child.stdout.on('data', (chunk) => (result.stdout += chunk));
    child.stderr.on('data', (chunk) => (result.stderr += chunk));
    const exited = new Promise((resolve) =>
      child.on('close', (status) =>
        resolve({ ...result, status, output: `${result.stdout}${result.stderr}` }),
      ),
    );
    return { child, exited };
  };
  // What turns the off-server copy on, as the chart sets it.
  const offsiteEnv = {
    BACKUP_OFFSITE_DIR: offsite,
    BACKUP_OFFSITE_RECIPIENT_FILE: RECIPIENT,
  };
  const calls = () =>
    readFileSync(join(state, 'calls'), 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  // Tool names in call order, the snapshot session's statements left out.
  const tools = () =>
    calls()
      .filter((line) => !line.startsWith('psql< '))
      .map((line) => {
        const [tool] = line.split(' ');
        if (tool === 'psql' && line.includes('CREATE DATABASE')) return 'psql create';
        if (tool === 'psql' && line.includes(' -c ')) return 'psql count';
        if (tool === 'pg_restore' && line.includes(' -l ')) return 'pg_restore -l';
        if (tool === 'pg_ctl') return `pg_ctl ${line.split(' ').at(-1)}`;
        return tool;
      });
  const listing = (dir = backup) => readdirSync(dir).sort();
  // The status file as `{ outcome, message }`, and its mode.
  const status = () => {
    const [outcome, message, ...rest] = readFileSync(statusFile, 'utf8').split('\n');
    assert.deepEqual(rest, [''], 'the status file holds two lines');
    return { outcome, message, mode: statSync(statusFile).mode & 0o777 };
  };
  return {
    backup,
    scratch,
    state,
    statusDir,
    statusFile,
    offsite,
    offsiteEnv,
    env,
    run,
    start,
    calls,
    tools,
    listing,
    status,
    initial: Object.keys(files),
  };
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const DUMP_NAME = /^qa_tools-\d{8}T\d{6}Z\.dump$/;

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// What every run has to leave, whatever its outcome: no temporary file, an
// empty scratch directory, nothing in the directory shared with the uploader,
// and no credential or row contents in its output.
function assertClean(ctx, result) {
  assert.deepEqual(ctx.listing(ctx.scratch), [], 'the scratch directory is left empty');
  assert.deepEqual(ctx.listing(ctx.offsite), [], 'the hand-over directory is left empty');
  assert.deepEqual(
    ctx.listing().filter((name) => name.endsWith('.tmp') && !ctx.initial.includes(name)),
    [],
    'no temporary file is left in the backup directory',
  );
  assert.ok(!result.output.includes(SECRET), 'the password reached the output');
  assert.ok(!result.output.includes(ROW), 'row contents reached the output');

  // The status file for the notifier, and nothing else, not even its
  // temporary name; readable by the notifier's uid despite the umask.
  assert.deepEqual(ctx.listing(ctx.statusDir), ['db-backup.status']);
  const status = ctx.status();
  assert.equal(status.mode, 0o644);
  if (result.status !== undefined) {
    assert.equal(status.outcome, result.status === 0 ? 'ok' : 'fail');
  }
  assert.ok(!status.message.includes(SECRET), 'the password reached the status');
  assert.ok(!status.message.includes(ROW), 'row contents reached the status');
}

// The message of the last `ERROR:` line the script printed, its own.
const lastError = (result) =>
  [...result.stderr.matchAll(/^\S+ ERROR: (.*)$/gm)].map((match) => match[1]).at(-1);

test('a run dumps, checks the restore, and saves the dump with a matching .sha256', (t) => {
  const ctx = setup(t);
  const result = ctx.run();
  assert.equal(result.status, 0, result.output);

  const [dump, sum, ...rest] = ctx.listing();
  assert.equal(rest.length, 0);
  assert.match(dump, DUMP_NAME);
  assert.equal(sum, `${dump}.sha256`);
  assert.equal(
    readFileSync(join(ctx.backup, sum), 'utf8'),
    `${sha256(join(ctx.backup, dump))}  ${dump}\n`,
    'the checksum file is what `sha256sum -c` reads, naming the final file',
  );

  // The order issue #67 fixes: guard, snapshot and dump, then the restore check
  // on the scratch server.
  assert.deepEqual(ctx.tools(), [
    'df',
    'psql',
    'pg_dump',
    'initdb',
    'pg_ctl start',
    'psql create',
    'pg_restore -l',
    'pg_restore',
    'psql count',
    'pg_ctl stop',
  ]);
  assert.match(
    result.stdout,
    /Dumped qa_tools in snapshot 00000003-0000001B-1: 113 sessions, 133 requests/,
  );
  assert.match(result.stdout, /Restore check passed: restored 113 sessions and 133 requests/);
  assert.match(result.stdout, new RegExp(`Saved ${dump} and ${dump}\\.sha256`));
  assert.match(result.stdout, /Backup succeeded/);
  assertClean(ctx, result);
  assert.deepEqual(ctx.status(), { outcome: 'ok', message: '', mode: 0o644 });
});

test('the counts are read in the snapshot the dump is taken from', (t) => {
  const ctx = setup(t);
  assert.equal(ctx.run().status, 0);
  const calls = ctx.calls();
  const session = calls.filter((line) => line.startsWith('psql< '));
  assert.match(session[0], /BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;/);
  assert.match(
    session[1],
    /SELECT pg_export_snapshot\(\), \(SELECT count\(\*\) FROM public\.sessions\), \(SELECT count\(\*\) FROM public\.requests\);/,
  );
  assert.match(session.at(-1), /COMMIT;/);
  const dump = calls.find((line) => line.startsWith('pg_dump '));
  const [saved] = ctx.listing();
  // The whole command, as the stand-in logs its name, the password's presence
  // and its arguments: custom format, no password prompt, the exported
  // snapshot, and the realtime outbox's rows left out (D221).
  assert.equal(
    dump,
    `pg_dump pw=set -Fc -w --snapshot=00000003-0000001B-1 --exclude-table-data=public.realtime_events -f ${join(ctx.backup, `.${saved}.tmp`)}`,
  );
  // The COMMIT that ends the snapshot comes after pg_dump.
  assert.ok(calls.indexOf(dump) < calls.lastIndexOf(session.at(-1)));
});

test('production is read before the restore check and never after it', (t) => {
  const ctx = setup(t);
  assert.equal(ctx.run().status, 0);
  const lines = ctx.calls().filter((line) => !line.startsWith('psql< '));
  const production = lines.slice(0, 3); // df, the snapshot session, pg_dump
  const scratch = lines.slice(3);
  assert.ok(production.slice(1).every((line) => line.includes(' pw=set ')));
  assert.ok(
    scratch.every((line) => line.includes(' pw=unset ')),
    'the scratch server steps still had the production password',
  );
  assert.ok(scratch.every((line) => !line.includes('db.stand-in.test')));
  const start = lines.find((line) => line.startsWith('pg_ctl ') && line.endsWith(' start'));
  assert.match(start, /listen_addresses=''/, 'the scratch server listens on no TCP port');
  assert.doesNotMatch(start, /shared_preload_libraries|pg_cron/, 'pg_cron must not be loaded');
});

test('the restore leaves out pg_cron and its cron.* rows, and nothing else', (t) => {
  const ctx = setup(t);
  assert.equal(ctx.run().status, 0);
  const restored = readFileSync(join(ctx.state, 'restore.list'), 'utf8').split('\n');
  for (const entry of PG_CRON_ENTRIES) assert.ok(!restored.includes(entry), entry);
  assert.deepEqual(
    restored.filter((line) => line !== ''),
    TOC.filter((line) => !PG_CRON_ENTRIES.includes(line)),
  );
  const restore = ctx
    .calls()
    .find((line) => line.startsWith('pg_restore ') && line.includes(' -L '));
  for (const flag of ['--no-owner', '--no-acl', '--single-transaction', '--exit-on-error']) {
    assert.ok(restore.includes(` ${flag} `), flag);
  }
});

test('the guard stops a run below the free-space minimum before anything is written', (t) => {
  const files = { 'qa_tools-20260101T000000Z.dump': 'old' };
  const ctx = setup(t, { files });
  const result = ctx.run({ FAKE_DF_AVAIL_KB: String(10 * GIB - 1) });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /ERROR: Not enough free space: .*backup has 10\.0 GiB free, less than the 10 GiB required\. Nothing was written\./,
  );
  assert.deepEqual(ctx.tools(), ['df'], 'nothing but df ran');
  assert.deepEqual(ctx.listing(), Object.keys(files));
  assertClean(ctx, result);
  assert.deepEqual(ctx.status(), {
    outcome: 'fail',
    message: `Not enough free space: ${ctx.backup} has 10.0 GiB free, less than the 10 GiB required. Nothing was written.`,
    mode: 0o644,
  });

  // Exactly the minimum is enough.
  const atMinimum = setup(t);
  assert.equal(atMinimum.run({ FAKE_DF_AVAIL_KB: String(10 * GIB) }).status, 0);
});

test('restored counts that differ from the dump fail the run and leave no dump or checksum', async (t) => {
  for (const [what, restored] of [
    ['requests', '113|132'],
    ['sessions', '112|133'],
  ]) {
    await t.test(`${what} only`, (st) => {
      const files = {
        'qa_tools-20260101T000000Z.dump': 'old',
        'qa_tools-20260101T000000Z.dump.sha256': 'x',
      };
      const ctx = setup(st, { files });
      const result = ctx.run({ FAKE_RESTORED_COUNTS: restored });
      assert.equal(result.status, 1);
      const [sessions, requests] = restored.split('|');
      assert.match(
        result.stderr,
        new RegExp(
          `Restore check failed: the dump's snapshot held 113 sessions and 133 requests, the restored copy ${sessions} and ${requests}`,
        ),
      );
      assert.match(result.stdout, /Backup failed; no new dump was kept/);
      assert.deepEqual(ctx.listing(), Object.keys(files).sort());
      assert.equal(ctx.tools().at(-1), 'pg_ctl stop', 'the scratch server is stopped');
      assertClean(ctx, result);
    });
  }
});

test('a failure at any step leaves nothing new', async (t) => {
  const steps = [
    'snapshot',
    'snapshot-sql',
    'pg_dump',
    'initdb',
    'start',
    'createdb',
    'toc',
    'restore',
    'count',
    'stop',
    'verify',
  ];
  for (const step of steps) {
    await t.test(step, (st) => {
      const files = {
        'qa_tools-20260101T000000Z.dump': 'old',
        'qa_tools-20260101T000000Z.dump.sha256': 'x',
        'notes.txt': 'kept',
      };
      const ctx = setup(st, { files });
      const result = ctx.run({ FAKE_FAIL: step });
      assert.equal(result.status, 1, result.output);
      assert.match(result.stdout, /Backup failed; no new dump was kept/);
      assert.deepEqual(ctx.listing(), Object.keys(files).sort());
      const tools = ctx.tools();
      const started = tools.indexOf('pg_ctl start');
      if (started !== -1) {
        assert.ok(
          tools.slice(started + 1).includes('pg_ctl stop'),
          'a started scratch server is stopped',
        );
      }
      assertClean(ctx, result);
      // The status carries the script's own message for the step, never a
      // PostgreSQL client's line.
      const status = ctx.status();
      assert.equal(status.outcome, 'fail');
      assert.equal(status.message, lastError(result));
      assert.doesNotMatch(status.message, /^(psql|pg_dump|pg_restore|initdb|pg_ctl):|^ERROR:/);
    });
  }
});

test('a PostgreSQL client error shows its first line and not the lines quoting a row', async (t) => {
  const cases = {
    // The snapshot session reads its statements with -f, so psql names the
    // file and line; read from plain stdin the same error would be a bare
    // "ERROR:", which production's messages are not trusted to be.
    'snapshot-sql': [
      /^psql:\/dev\/stdin:2: ERROR: {2}permission denied for table sessions$/m,
      /ERROR: Could not open a snapshot of qa_tools/,
    ],
    // psql prints a -c statement's error bare; on the scratch server it is kept.
    createdb: [
      /^ERROR: {2}createdb failed on the scratch server$/m,
      /ERROR: Could not create qa_tools on the scratch server/,
    ],
    count: [/^ERROR: {2}count failed on the scratch server$/m, /Could not count the restored rows/],
    restore: [
      /^pg_restore: error: COPY failed for table "requests"/m,
      /ERROR: The dump did not restore into the scratch server/,
    ],
    pg_dump: [
      /^pg_dump: error: Dumping the contents of table "requests" failed/m,
      /pg_dump of qa_tools failed/,
    ],
  };
  for (const [step, patterns] of Object.entries(cases)) {
    await t.test(step, (st) => {
      const ctx = setup(st);
      const result = ctx.run({ FAKE_FAIL: step });
      assert.equal(result.status, 1);
      for (const pattern of patterns) assert.match(result.stderr, pattern);
      assert.ok(!result.output.includes(ROW), 'a continuation line reached the output');
    });
  }
});

test('a file already at the new name is left alone and fails the run', async (t) => {
  for (const existing of [
    'qa_tools-20260101T030000Z.dump',
    'qa_tools-20260101T030000Z.dump.sha256',
  ]) {
    await t.test(existing, (st) => {
      const files = { [existing]: 'was here first' };
      const ctx = setup(st, { files });
      const result = ctx.run({ FAKE_STAMP: '20260101T030000Z' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /ERROR: qa_tools-20260101T030000Z\.dump already exists/);
      assert.match(result.stdout, /Backup failed; no new dump was kept/);
      assert.deepEqual(ctx.listing(), [existing]);
      assert.equal(readFileSync(join(ctx.backup, existing), 'utf8'), 'was here first');
      assertClean(ctx, result);
    });
  }
});

test('a checksum that fails after the rename removes the renamed dump and checksum', (t) => {
  const files = { 'qa_tools-20260101T000000Z.dump': 'old' };
  const ctx = setup(t, { files });
  const result = ctx.run({ FAKE_FAIL: 'verify', FAKE_STAMP: '20260102T030000Z' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR: qa_tools-20260102T030000Z\.dump does not match its checksum/);
  assert.match(result.stdout, /Backup failed; no new dump was kept/);
  assert.doesNotMatch(result.stdout, /Saved /);
  assert.deepEqual(ctx.listing(), Object.keys(files));
  assertClean(ctx, result);
});

test('pruning never deletes the dump the run saved: a later name fails the run', (t) => {
  const files = {
    'qa_tools-20260101T030000Z.dump': 'older',
    'qa_tools-20260105T030000Z.dump': 'later',
    'qa_tools-20260106T030000Z.dump': 'later',
    'qa_tools-20260107T030000Z.dump': 'later',
  };
  const ctx = setup(t, { files });
  // Sorted by name the new dump would be the second oldest of five, and
  // keeping the three newest would delete it.
  const result = ctx.run({ FAKE_STAMP: '20260102T030000Z' });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /ERROR: qa_tools-20260105T030000Z\.dump sorts after the new dump qa_tools-20260102T030000Z\.dump: the clock may have gone back, or the file was copied in\. Nothing was deleted\./,
  );
  assert.match(
    result.stdout,
    /Backup failed after the new dump was saved and checked; that dump is kept/,
  );
  assert.doesNotMatch(result.stdout, /Deleted /);
  assert.deepEqual(
    ctx.listing(),
    [
      ...Object.keys(files),
      'qa_tools-20260102T030000Z.dump',
      'qa_tools-20260102T030000Z.dump.sha256',
    ].sort(),
  );
  assertClean(ctx, result);
});

test('pruning keeps the three newest dumps and touches nothing else', (t) => {
  const others = {
    'notes.txt': 'kept',
    'qa_tools-manual.dump': 'kept',
    'qa_tool-2026-09-25.dump': 'kept',
    'qa_tools-20260101T030000Z.dump.bak': 'kept',
    'qa_tools-20260101T030000.dump': 'kept',
    'other_db-20260101T030000Z.dump': 'kept',
    '.qa_tools-20260105T030000Z.dump.tmp': 'kept',
  };
  const files = {
    ...others,
    'qa_tools-20260101T030000Z.dump': 'oldest',
    'qa_tools-20260101T030000Z.dump.sha256': 'x',
    'qa_tools-20260102T030000Z.dump': 'older',
    'qa_tools-20260102T030000Z.dump.sha256': 'x',
    'qa_tools-20260103T030000Z.dump': 'kept',
    'qa_tools-20260103T030000Z.dump.sha256': 'x',
    'qa_tools-20260104T030000Z.dump': 'kept, without a checksum',
  };
  const ctx = setup(t, { files });
  const result = ctx.run();
  assert.equal(result.status, 0, result.output);

  const dumps = ctx.listing().filter((name) => DUMP_NAME.test(name));
  assert.equal(dumps.length, 3);
  assert.deepEqual(dumps.slice(0, 2), [
    'qa_tools-20260103T030000Z.dump',
    'qa_tools-20260104T030000Z.dump',
  ]);
  const [, , newest] = dumps;
  assert.deepEqual(
    ctx.listing(),
    [
      ...Object.keys(others),
      'qa_tools-20260103T030000Z.dump',
      'qa_tools-20260103T030000Z.dump.sha256',
      'qa_tools-20260104T030000Z.dump',
      newest,
      `${newest}.sha256`,
    ].sort(),
  );
  for (const [name, content] of Object.entries(others)) {
    assert.equal(readFileSync(join(ctx.backup, name), 'utf8'), content, name);
  }
  assert.match(result.stdout, /Deleted qa_tools-20260101T030000Z\.dump and its checksum/);
  assert.match(result.stdout, /Deleted qa_tools-20260102T030000Z\.dump and its checksum/);
  assert.match(
    result.stdout,
    new RegExp(
      `Dumps kept: qa_tools-20260103T030000Z\\.dump qa_tools-20260104T030000Z\\.dump ${newest}`,
    ),
  );
});

test('a pruning failure fails the run but keeps the new dump, which has passed its check', (t) => {
  const ctx = setup(t, {
    files: {
      'qa_tools-20260102T030000Z.dump': 'x',
      'qa_tools-20260103T030000Z.dump': 'x',
      'qa_tools-20260104T030000Z.dump': 'x',
    },
  });
  // The oldest "dump" is a directory, which `rm -f` refuses.
  mkdirSync(join(ctx.backup, 'qa_tools-20260101T030000Z.dump'));
  writeFileSync(join(ctx.backup, 'qa_tools-20260101T030000Z.dump', 'inside'), 'x');
  const result = ctx.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR: Could not delete qa_tools-20260101T030000Z\.dump/);
  assert.match(
    result.stdout,
    /Backup failed after the new dump was saved and checked; that dump is kept/,
  );
  const saved = ctx.listing().filter((name) => DUMP_NAME.test(name));
  assert.equal(saved.length, 5);
  const newest = saved.at(-1);
  assert.equal(
    readFileSync(join(ctx.backup, `${newest}.sha256`), 'utf8'),
    `${sha256(join(ctx.backup, newest))}  ${newest}\n`,
  );
  assertClean(ctx, result);
});

// A stopped pod gets the image's STOPSIGNAL, INT for the PostgreSQL image;
// TERM is handled the same way.
test('a stop signal mid-run stops the step and leaves nothing new', async (t) => {
  for (const [signal, step, code] of [
    ['SIGINT', 'restore', 130],
    ['SIGTERM', 'pg_dump', 143],
    ['SIGTERM', 'restore', 143],
  ]) {
    await t.test(`${signal} during ${step}`, async (st) => {
      const files = { 'qa_tools-20260101T000000Z.dump': 'old' };
      const ctx = setup(st, { files });
      const child = spawn('bash', [SCRIPT], { env: ctx.env({ FAKE_HANG: step }) });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

      const pidFile = join(ctx.state, 'hang.pid');
      for (let i = 0; i < 100 && !existsSync(pidFile); i += 1) await sleep(100);
      assert.ok(existsSync(pidFile), `${step} never started`);
      const hung = Number(readFileSync(pidFile, 'utf8'));
      const started = Date.now();
      child.kill(signal);
      const exitCode = await exited;

      assert.equal(exitCode, code);
      assert.ok(Date.now() - started < 5000, `the ${signal} waited for the step to end`);
      assert.match(output, new RegExp(`Stopped by ${signal}`));
      assert.match(output, /Backup failed; no new dump was kept/);
      assert.deepEqual(ctx.listing(), Object.keys(files));
      for (let i = 0; i < 30 && isAlive(hung); i += 1) await sleep(100);
      assert.ok(!isAlive(hung), 'the step is still running');
      if (step === 'restore') assert.equal(ctx.tools().at(-1), 'pg_ctl stop');
      assertClean(ctx, { output });
      assert.deepEqual(ctx.status(), {
        outcome: 'fail',
        message: `Stopped by ${signal}`,
        mode: 0o644,
      });
    });
  }
});

// `run`'s own limit, the one bound a run that blocks this process meets
// (#122, #220): a copy of the script stopped in a command in the foreground
// after its traps, where bash holds SIGTERM back until the command ends, must
// still be ended at the limit, by SIGKILL. With SIGTERM, bash would wait out
// the command's 30 s. The command is `sleep`, its PID written first; it
// outlives bash, on this path alone, and is ended here.
test('`run` ends a script blocked in a command in the foreground at its limit, with SIGKILL', (t) => {
  const ctx = setup(t);
  const trap = "trap 'stop SIGHUP 129' HUP\n";
  const script = readFileSync(SCRIPT, 'utf8');
  assert.equal(script.split(trap).length, 2, `the script has one ${JSON.stringify(trap)}`);
  const blocked = join(ctx.state, 'db-backup-blocked.sh');
  const pidFile = join(ctx.state, 'blocked.pid');
  writeFileSync(
    blocked,
    // A function, so that `$$` reaches the copy as it is written.
    script.replace(trap, () => `${trap}sh -c 'echo $$ >"$FAKE_DIR/blocked.pid"; exec sleep 30'\n`),
  );
  const begun = Date.now();
  const result = ctx.run({}, { script: blocked, limitMs: 2_000 });
  const ms = Date.now() - begun;
  // Read now: the test's directory is removed by an earlier `after`.
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : NaN;
  t.after(() => {
    // Only within its 30 s, when the PID is certainly still the sleep's.
    if (Number.isInteger(pid) && pid > 1 && Date.now() - begun < 29_000 && isAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  });
  assert.ok(pid > 1, `the blocked script never reached its sleep:\n${result.output}`);
  assert.equal(
    result.error?.code,
    'ETIMEDOUT',
    `run did not end the blocked script at its limit:\n${result.output}`,
  );
  assert.equal(
    result.signal,
    'SIGKILL',
    `run did not kill the blocked script with SIGKILL:\n${result.output}`,
  );
  assert.ok(
    ms < 20_000,
    `run took ${ms} ms to end the blocked script, as if it waited out its sleep`,
  );
  assert.match(result.output, /\n\[the run: ETIMEDOUT, killed by SIGKILL\]$/);
});

test('a wrong setting, checked before anything runs, writes its status too', (t) => {
  const ctx = setup(t);
  const result = ctx.run({ BACKUP_KEEP: '0' });
  assert.equal(result.status, 1);
  assert.deepEqual(ctx.tools(), [], 'nothing ran');
  assert.deepEqual(ctx.status(), {
    outcome: 'fail',
    message: "BACKUP_KEEP must be a whole number from 1, not '0'",
    mode: 0o644,
  });
  assertClean(ctx, result);
});

test('without a status file, or with one that cannot be written, the outcome is the same', async (t) => {
  await t.test('unset', (st) => {
    const ctx = setup(st);
    const result = ctx.run({ BACKUP_STATUS_FILE: '' });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(ctx.listing(ctx.statusDir), []);
    assert.doesNotMatch(result.output, /status file/);
  });
  for (const [what, overrides, code] of [
    ['a success', {}, 0],
    ['a failure', { FAKE_FAIL: 'pg_dump' }, 1],
  ]) {
    await t.test(`unwritable, ${what}`, (st) => {
      const ctx = setup(st);
      const missing = join(ctx.statusDir, 'gone', 'db-backup.status');
      const result = ctx.run({ ...overrides, BACKUP_STATUS_FILE: missing });
      assert.equal(result.status, code, result.output);
      assert.match(result.stdout, new RegExp(`Could not write the status file ${missing}`));
      assert.deepEqual(ctx.listing(ctx.statusDir), []);
    });
  }
});

// --- The off-server copy (D190) ------------------------------------------------

const STAMP = '20261002T000000Z';
const NAME = `qa_tools-${STAMP}.dump`;
// What the `gpg` stand-in makes of a dump.
const standInCiphertext = (dump) => `stand-in ciphertext of: ${dump}`;

// How long a test waits for something that must happen before it gives up and
// fails. Never a measure of anything: on a shared runner under load a run of
// the script takes many times what it takes on a free machine, and a wait
// costs nothing when the thing comes.
const PATIENCE_MS = 180_000;

async function until(condition, what, ms = PATIENCE_MS) {
  // The top-level test this wait belongs to; once it has ended, by its limit
  // or otherwise, nobody is waiting for the answer.
  const owner = current.getStore();
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (condition()) return;
    if (owner?.signal.aborted) assert.fail(`gave up waiting for ${what}: its test has ended`);
    await sleep(15);
  }
  assert.fail(`timed out waiting for ${what}`);
}

// The uploader's answer as it writes it: a complete file renamed into place.
function writeAnswer(ctx, name, content) {
  const tmp = join(ctx.offsite, `.${name}.gpg.result.tmp`);
  writeFileSync(tmp, content, { mode: 0o644 });
  renameSync(tmp, join(ctx.offsite, `${name}.gpg.result`));
}

// The new dump is kept beside its checksum, which still matches it.
function assertDumpKept(ctx, name = NAME) {
  assert.ok(ctx.listing().includes(name), `${name} is gone`);
  assert.equal(
    readFileSync(join(ctx.backup, `${name}.sha256`), 'utf8'),
    `${sha256(join(ctx.backup, name))}  ${name}\n`,
  );
}

test('without BACKUP_OFFSITE_DIR nothing is encrypted or handed over', (t) => {
  const ctx = setup(t);
  // Even with the key and a wait set: the directory alone turns the copy on.
  const result = ctx.run({
    BACKUP_OFFSITE_RECIPIENT_FILE: RECIPIENT,
    BACKUP_OFFSITE_WAIT_SECONDS: '1',
  });
  assert.equal(result.status, 0, result.output);
  assert.ok(!ctx.tools().includes('gpg'), 'gpg ran');
  assert.doesNotMatch(result.output, /Off-server|Encrypted|uploader/);
  assert.match(result.stdout, /Dumps kept: \S+\n\S+ Backup succeeded\n$/);
  assertClean(ctx, result);
});

test('the dump is encrypted only after it is saved, checked and pruned, and the run waits for the uploader’s answer', async (t) => {
  const files = {
    'qa_tools-20260928T000000Z.dump': 'oldest',
    'qa_tools-20260928T000000Z.dump.sha256': 'x',
    'qa_tools-20260929T000000Z.dump': 'kept',
    'qa_tools-20260930T000000Z.dump': 'kept',
  };
  const ctx = setup(t, { files });
  const run = ctx.start({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP });

  // The uploader's part: take the copy once it is handed over, answer later.
  const handedOver = join(ctx.offsite, `${NAME}.gpg`);
  await until(() => existsSync(handedOver), 'the hand-over');
  const ciphertext = readFileSync(handedOver, 'utf8');
  assert.equal(statSync(handedOver).mode & 0o777, 0o644, 'readable by the uploader’s uid');
  // Only the ciphertext crosses, under its final name; the dump never does.
  assert.deepEqual(ctx.listing(ctx.offsite), [`${NAME}.gpg`]);
  const dump = readFileSync(join(ctx.backup, NAME), 'utf8');
  assert.equal(ciphertext, standInCiphertext(dump));
  // The run is still there, waiting, with its status not yet written.
  await sleep(500);
  assert.equal(run.child.exitCode, null, 'the run ended before the uploader answered');
  assert.deepEqual(ctx.listing(ctx.statusDir), []);
  const summary = `uploaded ${NAME}.gpg, ${ciphertext.length} bytes; deleted nothing; kept ${NAME}.gpg`;
  writeAnswer(ctx, NAME, `ok\n${summary}\n`);
  const result = await run.exited;
  assert.equal(result.status, 0, result.output);

  // gpg is the last tool, after the restore check and the scratch server's
  // stop, with the production password gone from its environment.
  const tools = ctx.tools();
  assert.deepEqual(tools.slice(-2), ['pg_ctl stop', 'gpg']);
  assert.equal(tools.filter((tool) => tool === 'gpg').length, 1);
  const call = ctx.calls().find((line) => line.startsWith('gpg '));
  assert.equal(
    call,
    `gpg pw=unset --batch --no-tty --no-autostart --trust-model always --recipient-file ${RECIPIENT} --output ${join(ctx.offsite, `.${NAME}.gpg.tmp`)} --encrypt ${join(ctx.backup, NAME)}`,
  );
  // When gpg was called the dump was saved under its final name beside its
  // checksum, no temporary file was left, and the old dump was already pruned;
  // its own files were in a directory of the run, on the scratch volume.
  const [home, homeKind, ...seen] = readFileSync(join(ctx.state, 'gpg.seen'), 'utf8')
    .split('\n')
    .filter((line) => line !== '');
  assert.match(home, new RegExp(`^GNUPGHOME=${ctx.scratch}/db-backup\\.[A-Za-z0-9]{6}/gnupg$`));
  assert.equal(homeKind, 'home=a directory');
  assert.deepEqual(seen.sort(), [
    'qa_tools-20260929T000000Z.dump',
    'qa_tools-20260930T000000Z.dump',
    NAME,
    `${NAME}.sha256`,
  ]);

  const lines = result.stdout.split('\n').map((line) => line.replace(/^\S+ /, ''));
  assert.deepEqual(lines.slice(-7), [
    `Saved ${NAME} and ${NAME}.sha256`,
    'Deleted qa_tools-20260928T000000Z.dump and its checksum',
    `Dumps kept: qa_tools-20260929T000000Z.dump qa_tools-20260930T000000Z.dump ${NAME}`,
    `Encrypted ${NAME} as ${NAME}.gpg, ${ciphertext.length} bytes; waiting up to 300 s for the uploader`,
    `Off-server copy: ${summary}`,
    'Backup succeeded',
    '',
  ]);
  assertClean(ctx, result);
  assert.deepEqual(ctx.status(), { outcome: 'ok', message: '', mode: 0o644 });
  assertDumpKept(ctx);
});

test('a failed encryption fails the run as an off-server failure and keeps the dump', async (t) => {
  const cases = {
    gpg: [
      `Off-server copy failed: gpg could not encrypt ${NAME}`,
      /^gpg: \S+: encryption failed: No public key$/m,
    ],
    'gpg-empty': [`Off-server copy failed: gpg wrote no ciphertext for ${NAME}`],
    'gpg-nothing': [`Off-server copy failed: gpg wrote no ciphertext for ${NAME}`],
  };
  for (const [step, [message, shown]] of Object.entries(cases)) {
    await t.test(step, (st) => {
      const files = { 'qa_tools-20260930T000000Z.dump': 'old' };
      const ctx = setup(st, { files });
      const result = ctx.run({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP, FAKE_FAIL: step });
      assert.equal(result.status, 1, result.output);
      assert.equal(lastError(result), message);
      if (shown) assert.match(result.stderr, shown);
      assert.match(
        result.stdout,
        /Backup failed after the new dump was saved and checked; that dump is kept/,
      );
      assert.doesNotMatch(result.stdout, /Backup succeeded|Off-server copy:|Encrypted /);
      assert.deepEqual(ctx.listing(), [...Object.keys(files), NAME, `${NAME}.sha256`].sort());
      assertDumpKept(ctx);
      // No half-written ciphertext is left for the uploader, and none was handed over.
      assertClean(ctx, result);
      assert.deepEqual(ctx.status(), { outcome: 'fail', message, mode: 0o644 });
    });
  }
});

test('a wrong off-server setting is found after the dump is saved, and keeps it', async (t) => {
  const cases = {
    'the key file is missing': [
      { BACKUP_OFFSITE_RECIPIENT_FILE: '/nonexistent/recipient.asc' },
      'Off-server copy failed: BACKUP_OFFSITE_RECIPIENT_FILE does not name a readable public key',
    ],
    'the key file is not set': [
      { BACKUP_OFFSITE_RECIPIENT_FILE: '' },
      'Off-server copy failed: BACKUP_OFFSITE_RECIPIENT_FILE does not name a readable public key',
    ],
    'the wait is zero': [
      { BACKUP_OFFSITE_WAIT_SECONDS: '0' },
      'Off-server copy failed: BACKUP_OFFSITE_WAIT_SECONDS must be a whole number from 1',
    ],
    'the wait is not a number': [
      { BACKUP_OFFSITE_WAIT_SECONDS: '5; rm -rf /' },
      'Off-server copy failed: BACKUP_OFFSITE_WAIT_SECONDS must be a whole number from 1',
    ],
  };
  for (const [name, [overrides, message]] of Object.entries(cases)) {
    await t.test(name, (st) => {
      const ctx = setup(st);
      const result = ctx.run({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP, ...overrides });
      assert.equal(result.status, 1, result.output);
      assert.equal(lastError(result), message);
      assert.ok(!ctx.tools().includes('gpg'), 'gpg ran');
      assertDumpKept(ctx);
      assertClean(ctx, result);
      assert.deepEqual(ctx.status(), { outcome: 'fail', message, mode: 0o644 });
    });
  }
  await t.test('the hand-over directory is missing', (st) => {
    const ctx = setup(st);
    const gone = join(ctx.offsite, 'gone');
    const result = ctx.run({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP, BACKUP_OFFSITE_DIR: gone });
    assert.equal(result.status, 1, result.output);
    assert.equal(lastError(result), `Off-server copy failed: ${gone} is not a writable directory`);
    assert.ok(!ctx.tools().includes('gpg'), 'gpg ran');
    assertDumpKept(ctx);
    assertClean(ctx, result);
  });
});

test('a failure the uploader reports, or no answer at all, fails the run and keeps the dump', async (t) => {
  await t.test('the uploader’s own message reaches the status', (st) => {
    const ctx = setup(st);
    const reason = `uploading ${NAME}.gpg answered 403 AccessDenied`;
    writeAnswer(ctx, NAME, `fail\n${reason}\n`);
    const result = ctx.run({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP });
    assert.equal(result.status, 1, result.output);
    assert.equal(lastError(result), `Off-server copy failed: ${reason}`);
    assert.match(
      result.stdout,
      /Backup failed after the new dump was saved and checked; that dump is kept/,
    );
    assert.doesNotMatch(result.stdout, /Backup succeeded/);
    assertDumpKept(ctx);
    assertClean(ctx, result);
    assert.deepEqual(ctx.status(), {
      outcome: 'fail',
      message: `Off-server copy failed: ${reason}`,
      mode: 0o644,
    });
  });
  // An upload cut by the uploader's time after an earlier attempt stalled
  // (#121), at the longest it is in production: the 240 characters the script
  // keeps of a failure hold it whole, the stall first.
  await t.test(
    'an upload cut after an earlier stall reaches the status whole, at its longest',
    (st) => {
      const ctx = setup(st);
      const reason = `uploading ${NAME}.gpg stalled: no byte moved for 600 s after 9999999998 of 9999999999 bytes, and the run's 1500 s ran out during attempt 10 after 9999999998 of 9999999999 bytes`;
      assert.ok(reason.length <= 240, `${reason.length} characters`);
      writeAnswer(ctx, NAME, `fail\n${reason}\n`);
      const result = ctx.run({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP });
      assert.equal(result.status, 1, result.output);
      assert.equal(lastError(result), `Off-server copy failed: ${reason}`);
      assertDumpKept(ctx);
      assertClean(ctx, result);
      assert.deepEqual(ctx.status(), {
        outcome: 'fail',
        message: `Off-server copy failed: ${reason}`,
        mode: 0o644,
      });
    },
  );
  await t.test('no answer within BACKUP_OFFSITE_WAIT_SECONDS', (st) => {
    const ctx = setup(st);
    const started = Date.now();
    const result = ctx.run({
      ...ctx.offsiteEnv,
      FAKE_STAMP: STAMP,
      BACKUP_OFFSITE_WAIT_SECONDS: '1',
    });
    assert.equal(result.status, 1, result.output);
    assert.ok(Date.now() - started >= 1000, 'it did not wait');
    assert.equal(
      lastError(result),
      'Off-server copy failed: the uploader gave no answer within 1 s',
    );
    assert.match(result.stdout, /waiting up to 1 s for the uploader/);
    assertDumpKept(ctx);
    // The copy nobody took is removed with the run.
    assertClean(ctx, result);
  });
});

// The answer is another container's text. Whatever it holds, the run ends with
// a status of its own wording or the answer's printable ASCII, cut short.
test('an answer made up to break the reading ends the run in bounded time, with a bounded printable status', async (t) => {
  const sizes = [1_000, 10_000, 100_000, 1_000_000];
  const shapes = {
    'a failure of one enormous line': (size) => [`fail\n${'x'.repeat(size)}\n`, 1],
    'one enormous first line': (size) => ['A'.repeat(size), 1],
    'only line breaks': (size) => ['\n'.repeat(size), 1],
    'a failure of control characters': (size) => [
      `fail\n${'\u001b[31m\u0007\r\t\u0000'.repeat(Math.ceil(size / 9))}\n`,
      1,
    ],
    'a failure of bytes that are not text': (size) => [
      Buffer.concat([Buffer.from('fail\n'), Buffer.alloc(size, 0xff), Buffer.from('\n')]),
      1,
    ],
    'a success with an enormous summary': (size) => [
      `ok\n${'é$(id)`id`'.repeat(Math.ceil(size / 11))}\n`,
      0,
    ],
    'a success hidden behind zero bytes': (size) => [
      Buffer.concat([Buffer.alloc(size, 0), Buffer.from('ok\n\n')]),
      size < 2048 ? 0 : 1,
    ],
  };
  for (const [shape, make] of Object.entries(shapes)) {
    await t.test(shape, async (st) => {
      // The four sizes run side by side, each in a directory of its own.
      const started = Date.now();
      const runs = sizes.map((size) => {
        const ctx = setup(st);
        const [content, status] = make(size);
        writeAnswer(ctx, NAME, content);
        const { exited } = ctx.start({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP });
        return { size, ctx, status, exited };
      });
      for (const { size, ctx, status, exited } of runs) {
        const result = await exited;
        // Four runs of the script side by side, seconds on a free machine: the
        // bound is for an answer read a byte at a time, not for a slow runner.
        assert.ok(Date.now() - started < PATIENCE_MS, `${size}: the run took too long`);
        assert.equal(result.status, status, `${size}: ${result.output.slice(-400)}`);
        const written = ctx.status();
        assert.equal(written.outcome, status === 0 ? 'ok' : 'fail');
        assert.ok(written.message.length <= 300, `${size}: ${written.message.length} characters`);
        assert.match(written.message, /^[\x20-\x7e]*$/, `${size}: not printable ASCII`);
        if (status === 1) assert.match(written.message, /^Off-server copy failed: /);
        // Nothing of the answer runs or grows the log.
        assert.ok(
          result.output.length < 5000,
          `${size}: the log holds ${result.output.length} characters`,
        );
        assert.doesNotMatch(result.output, /uid=\d/);
        assertDumpKept(ctx);
        assertClean(ctx, result);
      }
    });
  }

  const exact = {
    '': 'Off-server copy failed: the uploader wrote an answer that was not understood',
    ok: null,
    'ok\n': null,
    'OK\n\n': 'Off-server copy failed: the uploader wrote an answer that was not understood',
    'okay\nfine\n': 'Off-server copy failed: the uploader wrote an answer that was not understood',
    fail: 'Off-server copy failed: the uploader gave no reason',
    'fail\n\n': 'Off-server copy failed: the uploader gave no reason',
    'fail\nfirst\nsecond\n': 'Off-server copy failed: first',
    'fail\n\ttabbed\u0007 and é\n': 'Off-server copy failed:  tabbed  and   ',
    [`fail\n${'y'.repeat(300)}\n`]: `Off-server copy failed: ${'y'.repeat(240)}`,
  };
  const runs = Object.entries(exact).map(([content, message]) => {
    const ctx = setup(t);
    writeAnswer(ctx, NAME, content);
    const { exited } = ctx.start({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP });
    return { content, message, ctx, exited };
  });
  for (const { content, message, ctx, exited } of runs) {
    const result = await exited;
    assert.equal(result.status, message === null ? 0 : 1, JSON.stringify(content));
    assert.equal(ctx.status().message, message ?? '', JSON.stringify(content));
  }
});

// What stands where the answer belongs is another container's doing. A FIFO
// there once held the run past its own wait and past the stop signal, until
// the kubelet killed it without a status.
test('an answer that is not a regular file is refused at once, and the run still reports', async (t) => {
  const kinds = {
    'a FIFO': (ctx, path) => {
      assert.equal(spawnSync('mkfifo', [path]).status, 0);
    },
    'a directory': (ctx, path) => {
      mkdirSync(path);
      writeFileSync(join(path, 'inside'), 'ok\n\n');
    },
    'a symbolic link to the dump': (ctx, path) => symlinkSync(join(ctx.backup, NAME), path),
    'a symbolic link to an answer': (ctx, path) => {
      writeFileSync(join(ctx.state, 'answer'), 'ok\n\n');
      symlinkSync(join(ctx.state, 'answer'), path);
    },
    'a symbolic link to a FIFO': (ctx, path) => {
      assert.equal(spawnSync('mkfifo', [join(ctx.state, 'fifo')]).status, 0);
      symlinkSync(join(ctx.state, 'fifo'), path);
    },
  };
  const message = "Off-server copy failed: the uploader's answer is not a regular file";
  for (const [kind, make] of Object.entries(kinds)) {
    await t.test(kind, async (st) => {
      const ctx = setup(st);
      make(ctx, join(ctx.offsite, `${NAME}.gpg.result`));
      const run = ctx.start({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP });
      // A run that is held is ended here, not waited for: it would not end.
      // Its reader is let go by opening the FIFO's other end. Two minutes are
      // many times what a run takes on the slowest runner.
      const patience = new globalThis.AbortController();
      const result = await Promise.race([
        run.exited,
        sleep(120_000, null, { signal: patience.signal }).catch(() => null),
      ]);
      // The wait is given up once the run has ended, so that it holds nothing open.
      patience.abort();
      if (result === null) {
        run.child.kill('SIGKILL');
        for (const fifo of [join(ctx.offsite, `${NAME}.gpg.result`), join(ctx.state, 'fifo')]) {
          try {
            closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
          } catch {
            // Not a FIFO, or nobody is reading it.
          }
        }
        assert.fail(`the run was still held by ${kind} after 120 s`);
      }
      assert.equal(result.status, 1, result.output);
      assert.equal(lastError(result), message);
      assert.doesNotMatch(result.output, /PGDMP|Backup succeeded/);
      assertDumpKept(ctx);
      // Whatever it was, it is gone with the run, and so is the copy.
      assertClean(ctx, result);
      assert.deepEqual(ctx.status(), { outcome: 'fail', message, mode: 0o644 });
    });
  }
});

test('a read of the answer that hangs is ended by the stop signal, and by its own limit', async (t) => {
  await t.test('SIGTERM during the read', async (st) => {
    const ctx = setup(st);
    writeAnswer(ctx, NAME, 'ok\n\n');
    const run = ctx.start({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP, FAKE_HANG: 'head' });
    const pidFile = join(ctx.state, 'hang.pid');
    await until(() => existsSync(pidFile), 'the read to start');
    const hung = Number(readFileSync(pidFile, 'utf8'));
    const stopped = Date.now();
    run.child.kill('SIGTERM');
    const result = await run.exited;
    assert.equal(result.status, 143, result.output);
    // The reader would hang for 300 s; the status and the message say that
    // the signal ended the run, and the bound that it did not wait.
    assert.ok(Date.now() - stopped < 60_000, 'the SIGTERM waited for the read');
    for (let i = 0; i < 30 && isAlive(hung); i += 1) await sleep(100);
    assert.ok(!isAlive(hung), 'the reader is still running');
    assertDumpKept(ctx);
    assertClean(ctx, result);
    assert.deepEqual(ctx.status(), { outcome: 'fail', message: 'Stopped by SIGTERM', mode: 0o644 });
  });
  await t.test('no stop: the read has 5 seconds', async (st) => {
    const ctx = setup(st);
    writeAnswer(ctx, NAME, 'ok\n\n');
    const started = Date.now();
    const result = await ctx.start({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP, FAKE_HANG: 'head' })
      .exited;
    const took = Date.now() - started;
    assert.equal(result.status, 1, result.output);
    // Fifty waits of a tenth of a second, none of which can end early. That
    // the limit ended the read, and not the reader's own end 300 s later, is
    // in the message.
    assert.ok(took >= 4500, `the run took ${took} ms`);
    const message = "Off-server copy failed: the uploader's answer could not be read within 5 s";
    assert.equal(lastError(result), message);
    const hung = Number(readFileSync(join(ctx.state, 'hang.pid'), 'utf8'));
    for (let i = 0; i < 30 && isAlive(hung); i += 1) await sleep(100);
    assert.ok(!isAlive(hung), 'the reader is still running');
    assertDumpKept(ctx);
    assertClean(ctx, result);
    assert.deepEqual(ctx.status(), { outcome: 'fail', message, mode: 0o644 });
  });
});

// The stop signal the moment the copy has been renamed into place, before the
// script does anything else: `mv` itself sends it.
test('a stop right after the hand-over still removes the copy from the shared directory', (t) => {
  const ctx = setup(t);
  const result = ctx.run({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP, FAKE_STOP_AFTER_HANDOVER: '1' });
  assert.equal(result.status, 143, result.output);
  assert.match(result.output, /Stopped by SIGTERM/);
  assert.doesNotMatch(result.stdout, /Encrypted |waiting up to/, 'the stop came later than meant');
  assertDumpKept(ctx);
  assert.deepEqual(ctx.listing(ctx.offsite), [], `${NAME}.gpg was left for nobody`);
  assertClean(ctx, result);
  assert.deepEqual(ctx.status(), { outcome: 'fail', message: 'Stopped by SIGTERM', mode: 0o644 });
});

test('a stop signal during the off-server copy ends the run at once and keeps the dump', async (t) => {
  await t.test('SIGTERM while waiting for the uploader', async (st) => {
    const ctx = setup(st);
    const run = ctx.start({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP });
    await until(() => existsSync(join(ctx.offsite, `${NAME}.gpg`)), 'the hand-over');
    await sleep(300);
    const stopped = Date.now();
    run.child.kill('SIGTERM');
    const result = await run.exited;
    assert.equal(result.status, 143, result.output);
    // The run would wait 300 s for the uploader.
    assert.ok(Date.now() - stopped < 60_000, 'the SIGTERM waited for the uploader');
    assert.match(result.output, /Stopped by SIGTERM/);
    assert.match(
      result.stdout,
      /Backup failed after the new dump was saved and checked; that dump is kept/,
    );
    assertDumpKept(ctx);
    assertClean(ctx, result);
    assert.deepEqual(ctx.status(), { outcome: 'fail', message: 'Stopped by SIGTERM', mode: 0o644 });
  });
  await t.test('SIGINT during the encryption', async (st) => {
    const ctx = setup(st);
    const run = ctx.start({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP, FAKE_HANG: 'gpg' });
    const pidFile = join(ctx.state, 'hang.pid');
    await until(() => existsSync(pidFile), 'gpg to start');
    const hung = Number(readFileSync(pidFile, 'utf8'));
    const stopped = Date.now();
    run.child.kill('SIGINT');
    const result = await run.exited;
    assert.equal(result.status, 130, result.output);
    // The stand-in for gpg hangs for 30 s.
    assert.ok(Date.now() - stopped < 20_000, 'the SIGINT waited for gpg');
    for (let i = 0; i < 30 && isAlive(hung); i += 1) await sleep(100);
    assert.ok(!isAlive(hung), 'gpg is still running');
    assertDumpKept(ctx);
    // The half-written ciphertext is removed; nothing was handed over.
    assertClean(ctx, result);
    assert.deepEqual(ctx.status(), { outcome: 'fail', message: 'Stopped by SIGINT', mode: 0o644 });
  });
});

// The script's own gpg command, on the key the chart ships. Without gpg on a
// developer's machine the test is skipped; CI installs it (operations-tests).
test(
  'the real gpg encrypts the dump to the recipient key, and the ciphertext names that key alone',
  { skip: !REAL_GPG && !process.env.CI ? 'gpg is not installed' : false },
  async (t) => {
    assert.ok(REAL_GPG, 'gpg is required in CI: operations-tests installs it');
    const ctx = setup(t, { realGpg: true });
    const run = ctx.start({ ...ctx.offsiteEnv, FAKE_STAMP: STAMP });
    const handedOver = join(ctx.offsite, `${NAME}.gpg`);
    await until(() => existsSync(handedOver), 'the hand-over');
    const ciphertext = readFileSync(handedOver);
    writeAnswer(ctx, NAME, 'ok\n\n');
    const result = await run.exited;
    assert.equal(result.status, 0, result.output);
    assert.ok(!ctx.tools().includes('gpg'), 'the stand-in ran instead of the real gpg');
    assertClean(ctx, result);

    const dump = readFileSync(join(ctx.backup, NAME));
    assert.ok(ciphertext.length > dump.length, 'the ciphertext is shorter than the dump');
    assert.ok(!ciphertext.includes(dump), 'the dump is readable in the ciphertext');
    assert.ok(!ciphertext.includes('PGDMP'), 'the dump is readable in the ciphertext');

    // Its packets: one public-key encrypted session key, for the test key's
    // encryption subkey, and no other recipient. This machine has no private
    // key, so the listing ends in "No secret key".
    const home = mkdtempSync(join(tmpdir(), 'qa-gpg-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const copy = join(home, 'copy.gpg');
    writeFileSync(copy, ciphertext);
    const packets = spawnSync(
      REAL_GPG,
      ['--batch', '--no-tty', '--no-autostart', '--homedir', home, '--list-packets', copy],
      { encoding: 'utf8', timeout: PATIENCE_MS },
    );
    const recipients = [
      ...packets.stdout.matchAll(/^:pubkey enc packet:.* keyid ([0-9A-F]{16})$/gm),
    ];
    assert.deepEqual(
      recipients.map((match) => match[1]),
      ['D2734EA6D3638E06'],
      `${packets.stdout}${packets.stderr}`,
    );
    assert.doesNotMatch(packets.stdout, /:symkey enc packet:/);
    assert.notEqual(packets.status, 0, 'this machine could decrypt the copy');
    assert.match(packets.stderr, /No secret key/i);
  },
);

// The two halves together, as in the pod: the backup writes its status, and
// the notifier, the backend image's Node in production, sends it.
test('the notifier sends the status the backup wrote: the guard’s failure, and a success', async (t) => {
  const token = '5a1f9c3e-8d2b-4e7a-9f0c-3b6d1e8a2c44';
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ path: req.url.replace(`/${token}`, 'backup'), body });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  for (const [what, overrides, path, body] of [
    [
      'the guard',
      { FAKE_DF_AVAIL_KB: String(9 * GIB) },
      'backup/fail',
      /^backup failed: Not enough free space: \S+ has 9\.0 GiB free, less than the 10 GiB required\. Nothing was written\.$/,
    ],
    ['a success', {}, 'backup', /^backup succeeded$/],
  ]) {
    await t.test(what, async (st) => {
      const ctx = setup(st);
      const result = ctx.run(overrides);
      assert.equal(result.status, path === 'backup' ? 0 : 1, result.output);
      const before = requests.length;
      const notifier = spawn(process.execPath, [NOTIFIER], {
        env: {
          PATH: process.env.PATH,
          NOTIFY_STATUS_FILE: ctx.statusFile,
          NOTIFY_HEARTBEAT_URL: url,
          NOTIFY_TOKEN: token,
          NOTIFY_POLL_SECONDS: '0.05',
        },
      });
      let output = '';
      notifier.stdout.on('data', (chunk) => (output += chunk));
      notifier.stderr.on('data', (chunk) => (output += chunk));
      const exited = new Promise((resolve) => notifier.on('close', (code) => resolve(code)));
      for (let i = 0; i < 200 && requests.length === before; i += 1) await sleep(25);
      notifier.kill('SIGTERM');
      assert.equal(await exited, 0, output);
      assert.equal(requests.length, before + 1, output);
      assert.equal(requests.at(-1).path, path);
      assert.match(requests.at(-1).body, body);
      assert.ok(!output.includes(token), 'the token reached the output');
    });
  }
});

// The three together, as in the pod: the backup hands its encrypted copy to
// the uploader, which puts it into the storage — here a stand-in that keeps
// objects in memory and checks no signature; scripts/db-backup-offsite.test.mjs
// does — and the notifier sends what the backup made of the uploader's answer.
test('the backup, the uploader and the notifier together: a copy in the bucket and `backup`, or the dump kept and `backup/fail`', async (t) => {
  const token = '7c2e9d41-5b8a-4f3c-a1d6-9e0b4c7f2a35';
  const keyId = 'YCAJEstandInKeyId6543210B';
  const secret = 'YCstand-in_Secret+access/key=ba9876543210';
  const heartbeats = [];
  const buckets = { 'qa-tools-backups': new Map() };
  const xml = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://stand-in');
      if (req.method === 'POST') {
        heartbeats.push({ path: url.pathname.replace(`/${token}`, 'backup'), body: String(body) });
        res.writeHead(204);
        return res.end();
      }
      const [, bucket, key = ''] = url.pathname.split('/');
      const objects = buckets[bucket];
      if (!objects) return xml(res, 404, '<Error><Code>NoSuchBucket</Code></Error>');
      if (req.method === 'PUT') {
        objects.set(key, body);
        return xml(res, 200, '');
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        return xml(res, 204, '');
      }
      if (url.searchParams.has('versioning')) return xml(res, 200, '<VersioningConfiguration/>');
      return xml(
        res,
        200,
        `<ListBucketResult><IsTruncated>false</IsTruncated>${[...objects]
          .map(
            ([name, value]) =>
              `<Contents><Key>${name}</Key><Size>${value.length}</Size></Contents>`,
          )
          .join('')}</ListBucketResult>`,
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  // One pod: the two sidecars first, then the backup; the sidecars are stopped
  // after the backup has ended, as the kubelet stops them.
  const pod = async (st, { stamp, uploaderEnv = {} }) => {
    const ctx = setup(st);
    const sidecar = (script, env) => {
      const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, ...env } });
      st.after(() => child.kill('SIGKILL'));
      const run = { child, output: '' };
      child.stdout.on('data', (chunk) => (run.output += chunk));
      child.stderr.on('data', (chunk) => (run.output += chunk));
      run.exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
      return run;
    };
    const notifier = sidecar(NOTIFIER, {
      NOTIFY_STATUS_FILE: ctx.statusFile,
      NOTIFY_HEARTBEAT_URL: url,
      NOTIFY_TOKEN: token,
      NOTIFY_POLL_SECONDS: '0.05',
    });
    const uploaderVars = {
      OFFSITE_DIR: ctx.offsite,
      OFFSITE_ENDPOINT: url,
      OFFSITE_REGION: 'ru-central1',
      OFFSITE_BUCKET: 'qa-tools-backups',
      OFFSITE_DATABASE: 'qa_tools',
      OFFSITE_KEEP: '3',
      OFFSITE_ACCESS_KEY_ID: keyId,
      OFFSITE_SECRET_ACCESS_KEY: secret,
      OFFSITE_POLL_SECONDS: '0.05',
      ...uploaderEnv,
    };
    for (const key of Object.keys(uploaderVars)) {
      if (uploaderVars[key] === undefined) delete uploaderVars[key];
    }
    const uploader = sidecar(UPLOADER, uploaderVars);
    const before = heartbeats.length;
    const result = await ctx.start({ ...ctx.offsiteEnv, FAKE_STAMP: stamp }).exited;
    await until(() => heartbeats.length > before, `the heartbeat\n${notifier.output}`);
    uploader.child.kill('SIGTERM');
    assert.equal(await uploader.exited, 0, uploader.output);
    notifier.child.kill('SIGTERM');
    assert.equal(await notifier.exited, 0, notifier.output);
    assert.equal(heartbeats.length, before + 1, 'one heartbeat a run');
    for (const output of [
      result.output,
      uploader.output,
      notifier.output,
      heartbeats.at(-1).body,
    ]) {
      const lower = output.toLowerCase();
      assert.ok(!lower.includes(keyId.toLowerCase()), 'the key id reached an output');
      assert.ok(!lower.includes(secret.toLowerCase()), 'the secret key reached an output');
      assert.ok(!output.includes(token), 'the token reached an output');
    }
    assertClean(ctx, result);
    return { ctx, result, uploader, heartbeat: heartbeats.at(-1) };
  };

  await t.test('a success', async (st) => {
    const stamp = '20261002T000000Z';
    const name = `qa_tools-${stamp}.dump`;
    const { ctx, result, uploader, heartbeat } = await pod(st, { stamp });
    assert.equal(result.status, 0, `${result.output}${uploader.output}`);
    const dump = readFileSync(join(ctx.backup, name), 'utf8');
    assert.deepEqual([...buckets['qa-tools-backups'].keys()], [`${name}.gpg`]);
    assert.equal(String(buckets['qa-tools-backups'].get(`${name}.gpg`)), standInCiphertext(dump));
    assert.match(
      result.stdout,
      new RegExp(
        `Off-server copy: uploaded ${name}\\.gpg, \\d+ bytes; deleted nothing; kept ${name}\\.gpg\\n\\S+ Backup succeeded\\n$`,
      ),
    );
    assert.match(uploader.output, new RegExp(`Uploaded ${name}\\.gpg, \\d+ bytes`));
    assert.deepEqual(heartbeat, { path: 'backup', body: 'backup succeeded' });
    assert.deepEqual(ctx.status(), { outcome: 'ok', message: '', mode: 0o644 });
  });

  // The acceptance test's failure: a bucket that does not exist.
  await t.test('a bucket that does not exist', async (st) => {
    const stamp = '20261003T000000Z';
    const name = `qa_tools-${stamp}.dump`;
    const { ctx, result, heartbeat } = await pod(st, {
      stamp,
      uploaderEnv: { OFFSITE_BUCKET: 'qa-tools-no-such-bucket' },
    });
    const message =
      "Off-server copy failed: reading the bucket's versioning answered 404 NoSuchBucket";
    assert.equal(result.status, 1, result.output);
    assert.equal(lastError(result), message);
    assert.deepEqual(heartbeat, { path: 'backup/fail', body: `backup failed: ${message}` });
    assert.deepEqual(ctx.status(), { outcome: 'fail', message, mode: 0o644 });
    // That run's dump and checksum are on the node; the bucket is as it was.
    assertDumpKept(ctx, name);
    assert.ok(!buckets['qa-tools-backups'].has(`${name}.gpg`));
  });

  await t.test('the Secret is missing', async (st) => {
    const stamp = '20261004T000000Z';
    const name = `qa_tools-${stamp}.dump`;
    const { ctx, result, heartbeat } = await pod(st, {
      stamp,
      uploaderEnv: { OFFSITE_ACCESS_KEY_ID: undefined, OFFSITE_SECRET_ACCESS_KEY: undefined },
    });
    const message =
      'Off-server copy failed: OFFSITE_ACCESS_KEY_ID is not set (Secret or key missing)';
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(heartbeat, { path: 'backup/fail', body: `backup failed: ${message}` });
    assertDumpKept(ctx, name);
    assert.ok(!buckets['qa-tools-backups'].has(`${name}.gpg`));
  });
});

test('the script prints no trace and no environment', () => {
  const script = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(
    script,
    /^\s*(set\s+-[a-z]*x|set\s+-o\s+xtrace|printenv|env\s*$|export\s+-p)/m,
  );
});

// What the chart must say, as issue #67 and the owner decided it. The deploy
// identity may manage CronJobs and not Jobs, so the chart never creates a Job
// or a hook itself.
test('the chart runs the script nightly from a CronJob, and never creates a Job', () => {
  assert.match(TEMPLATE, /^kind: CronJob$/m);
  assert.doesNotMatch(TEMPLATE, /^kind: Job$/m);
  assert.doesNotMatch(TEMPLATE, /helm\.sh\/hook/);
  assert.match(TEMPLATE, /\.Files\.Get "files\/db-backup\.sh"/);
  assert.match(TEMPLATE, /name: \{\{ include "qa-tools\.name" \. \}\}-db-backup/);
  assert.match(TEMPLATE, /timeZone: \{\{ \.Values\.backup\.timeZone \| quote \}\}/);
  assert.match(TEMPLATE, /concurrencyPolicy: Forbid/);
  assert.match(TEMPLATE, /backoffLimit: 0/);
  assert.match(TEMPLATE, /restartPolicy: Never/);
  assert.match(TEMPLATE, /runAsUser: 999/);
  assert.doesNotMatch(
    TEMPLATE,
    /^\s*ttlSecondsAfterFinished:/m,
    'failed Jobs are the failure signal',
  );
  assert.match(
    TEMPLATE,
    /hostPath:\n\s+path: \{\{ \.Values\.backup\.hostPath \| quote \}\}\n\s+type: Directory/,
  );

  // The notifier (D181): a native sidecar on the backend image as uid 1000,
  // reading the status file from an emptyDir it shares with the backup
  // container, with the token from an optional Secret key. The backup
  // container is still the pod's only regular container, as uid 999.
  assert.match(TEMPLATE, /\.Files\.Get "files\/db-backup-notify\.mjs"/);
  const sidecar =
    /\n {10}initContainers:\n([\s\S]*?)\n {10}containers:\n/.exec(TEMPLATE)?.[1] ?? '';
  assert.match(sidecar, /^ {12}- name: db-backup-notify$/m);
  assert.match(sidecar, /^ {14}restartPolicy: Always$/m);
  assert.match(
    sidecar,
    /image: \{\{ \.Values\.images\.registry \}\}\/\{\{ \.Values\.images\.backend \}\}:\{\{ include "qa-tools\.imageTag" \. \}\}/,
  );
  assert.match(sidecar, /command: \['node', '\/opt\/db-backup\/db-backup-notify\.mjs'\]/);
  assert.match(sidecar, /name: NOTIFY_STATUS_FILE\n\s+value: \/status\/db-backup\.status/);
  assert.match(
    sidecar,
    /name: NOTIFY_TOKEN\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: \{\{ include "qa-tools\.heartbeatSecret" \. \}\}\n\s+key: backup\n\s+optional: true/,
  );
  assert.match(sidecar, /runAsUser: 1000\n\s+runAsGroup: 1000/);
  assert.match(sidecar, /readOnlyRootFilesystem: true/);
  assert.match(sidecar, /drop: \['ALL'\]/);
  assert.match(sidecar, /- name: status\n\s+mountPath: \/status\n\s+readOnly: true/);
  const containers = /\n {10}containers:\n([\s\S]*?)\n {10}volumes:\n/.exec(TEMPLATE)?.[1] ?? '';
  assert.deepEqual(
    [...containers.matchAll(/^ {12}- name: (\S+)$/gm)].map((match) => match[1]),
    ['db-backup'],
  );
  assert.doesNotMatch(containers, /runAsUser/, 'the backup runs as the pod’s 999');
  assert.match(containers, /name: BACKUP_STATUS_FILE\n\s+value: \/status\/db-backup\.status/);
  assert.match(containers, /- name: status\n\s+mountPath: \/status\n/);
  assert.match(TEMPLATE, /- name: status\n\s+emptyDir:/);
  assert.match(TEMPLATE, /kubectl\.kubernetes\.io\/default-container: db-backup/);

  const backup = /^backup:\n((?: {2}.*\n|\n)*)/m.exec(VALUES)?.[1] ?? '';
  assert.match(backup, /^ {2}schedule: '0 3 \* \* \*'$/m);
  assert.match(backup, /^ {2}timeZone: Europe\/Moscow$/m);
  // A directory of no installation's; production's is its CI/CD variable (#367).
  assert.match(backup, /^ {2}hostPath: \/var\/backups\/webhook-inspector$/m);
  assert.match(backup, /^ {2}keep: 3$/m);
  assert.match(backup, /^ {2}minFreeGiB: 10$/m);
});
