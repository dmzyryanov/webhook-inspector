// Which job runs each script test, and when (#194, D241). The quick tests run
// in `delivery-checks` on every pipeline that validates; the slow ones in a
// group, `operations-tests`, which a merge request pipeline runs only when
// the merge request changes a path the group's rule lists. These tests read this checkout's
// .gitlab/ci/validate.yml, apply each rule to made-up merge requests as
// GitLab would, and run scripts/test-inputs.mjs — the matching and the check
// that fails a group whose tests read a file its rule leaves out — and
// scripts/test-inputs-trace.mjs, the recorder behind that check, on made-up
// input and on processes started here.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import test from 'node:test';
import {
  MAX_PATHS,
  MAX_WILDCARDS,
  changesOf,
  compile,
  compileGlob,
  matches,
  uncovered,
} from './test-inputs.mjs';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const VALIDATE = read('.gitlab/ci/validate.yml');
const GROUPS = ['operations-tests'];
const RUNNERS = ['delivery-checks', ...GROUPS];

/** A top-level job of the validate file, comments left out. */
function block(name) {
  const lines = VALIDATE.split('\n');
  const from = lines.indexOf(`${name}:`);
  assert.ok(from >= 0, `no job ${name}`);
  const after = lines.findIndex((line, at) => at > from && /^[^\s#]/.test(line));
  return lines
    .slice(from, after < 0 ? lines.length : after)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** The script tests a job's `node --test` run names. */
const testsOf = (name) => {
  const job = block(name);
  const run = job.slice(job.indexOf('node --test'));
  return [...run.matchAll(/scripts\/[\w-]+\.test\.mjs/g)].map((m) => m[0]);
};

const temporary = (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-test-inputs-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('every script test runs in exactly one job of the validate stage, the slow ones in a group', () => {
  const all = readdirSync(join(root, 'scripts'))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `scripts/${name}`)
    .sort();
  const runs = new Map();
  for (const job of RUNNERS) {
    for (const file of testsOf(job)) {
      assert.ok(!runs.has(file), `${file} runs in ${runs.get(file)} and ${job}`);
      runs.set(file, job);
    }
  }
  assert.deepEqual(
    [...runs.keys()].sort(),
    all,
    'a script test runs nowhere, or a job runs one that is gone',
  );
  // No other job runs a script test.
  const others = VALIDATE.split('\n')
    .filter((line) => /^[a-z][\w:-]*:$/.test(line))
    .map((line) => line.slice(0, -1))
    .filter((job) => !RUNNERS.includes(job) && !['stages', 'variables', 'default'].includes(job));
  for (const job of others) assert.doesNotMatch(block(job), /node --test/, job);
  // The slow ones.
  assert.deepEqual(testsOf('operations-tests'), [
    'scripts/db.test.mjs',
    'scripts/db-backup.test.mjs',
    'scripts/db-backup-notify.test.mjs',
    'scripts/db-backup-offsite.test.mjs',
  ]);
});

test('each group runs on a merge request only when its paths change, everywhere else always, and checks what its tests read', () => {
  for (const job of GROUPS) {
    const paths = changesOf(VALIDATE, job);
    assert.ok(paths.length > 0 && paths.length <= MAX_PATHS, `${job}: ${paths.length} paths`);
    const patterns = compile(paths);
    // What every group reads besides its tests' own inputs: its test files,
    // the reporter, the recorder and the check, and the pipeline's definition.
    for (const path of [
      ...testsOf(job),
      'scripts/test-run-limit.mjs',
      'scripts/test-inputs.mjs',
      'scripts/test-inputs-trace.mjs',
      '.gitlab-ci.yml',
      '.gitlab/ci/validate.yml',
    ]) {
      assert.ok(matches(patterns, path), `${job}'s rule leaves out ${path}`);
    }
    const script = block(job);
    const run = [
      '      export TEST_INPUTS_FILE=/tmp/test-inputs.txt',
      '      export NODE_OPTIONS="--import=$CI_PROJECT_DIR/scripts/test-inputs-trace.mjs"',
      '      TEST_RUN_LIMIT_SECONDS=1500 node --test --test-timeout=300000 \\',
    ].join('\n');
    assert.ok(script.includes(run), `${job} does not record what its tests read`);
    assert.ok(
      script.includes(
        `      unset NODE_OPTIONS\n      node scripts/test-inputs.mjs check ${job} "$TEST_INPUTS_FILE"\n`,
      ),
      `${job} does not check what its tests read`,
    );
    assert.doesNotMatch(script, /allow_failure:|when:|only:|except:/, job);
  }
  // delivery-checks has no rule and records nothing: check-version and
  // check-api-breaking run in every pipeline that validates.
  const checks = block('delivery-checks');
  assert.doesNotMatch(checks, /^ {2}rules:/m);
  assert.doesNotMatch(checks, /NODE_OPTIONS|TEST_INPUTS_FILE/);
  assert.match(checks, /node scripts\/check-version\.mjs "\$DELIVERY_BASE"/);
  assert.match(checks, /node scripts\/check-api-breaking\.mjs "\$DELIVERY_BASE"/);
});

test('the rules, on made-up merge requests: a group runs when one of its paths changes and only then', () => {
  const groups = Object.fromEntries(GROUPS.map((job) => [job, compile(changesOf(VALIDATE, job))]));
  const runs = (files) => GROUPS.filter((job) => files.some((file) => matches(groups[job], file)));
  for (const [label, files, expected] of [
    [
      'a feature: code, contract, end-to-end, docs and the bookkeeping',
      [
        'apps/backend/src/modules/webhook/receiver.ts',
        'apps/frontend/src/App.tsx',
        'packages/shared/src/index.ts',
        'packages/shared/openapi.json',
        'docs/API.md',
        'docs/PRODUCT.md',
        'CHANGELOG.md',
        'VERSION',
        'e2e/standard-session.spec.ts',
        'package-lock.json',
      ],
      [],
    ],
    ['the documentation', ['README.md', 'docs/ARCHITECTURE.md', 'docs/testing/flakes.md'], []],
    ['a chart template', ['deploy/helm/qa-tools/templates/backend.yaml'], []],
    [
      'the site monitor, whose test runs in delivery-checks',
      ['deploy/helm/qa-tools/files/monitor.mjs'],
      [],
    ],
    ['a quick script test', ['scripts/chart.test.mjs', 'scripts/delivery.test.mjs'], []],
    ['a measurement harness', ['scripts/measure-connections.mjs'], []],
    ['the backup script', ['deploy/helm/qa-tools/files/db-backup.sh'], ['operations-tests']],
    [
      'the backup key',
      ['deploy/helm/qa-tools/files/db-backup-recipient.asc'],
      ['operations-tests'],
    ],
    ['the chart values', ['deploy/helm/qa-tools/values.yaml'], ['operations-tests']],
    ['the local database', ['scripts/db.mjs', 'docker-compose.yml'], ['operations-tests']],
    ['the pipeline', ['.gitlab-ci.yml'], GROUPS],
    ['the validate stage', ['.gitlab/ci/validate.yml'], GROUPS],
    ['the reporter', ['scripts/test-run-limit.mjs'], GROUPS],
    ['the check', ['scripts/test-inputs.mjs'], GROUPS],
    ['nothing at all', [], []],
  ]) {
    assert.deepEqual(runs(files), expected, label);
  }
});

test('the paths match as GitLab matches rules:changes, File.fnmatch with FNM_PATHNAME and FNM_DOTMATCH', () => {
  for (const [glob, path, expected] of [
    ['.claude/**/*', '.claude/settings.json', true],
    ['.claude/**/*', '.claude/scripts/launchd/install.sh', true],
    ['.claude/**/*', '.claude', false],
    ['.claude/**/*', '.claudex/settings.json', false],
    ['.claude/**/*', 'x/.claude/settings.json', false],
    ['.claude/**/*', '.claude/.hidden', true],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['a/**/b', 'a/x/y/c', false],
    ['a/**', 'a/b', true],
    ['a/**', 'a/b/c', false],
    ['*.md', 'README.md', true],
    ['*.md', 'docs/API.md', false],
    ['*.md', '.hidden.md', true],
    ['deploy/helm/qa-tools/files/db-backup*', 'deploy/helm/qa-tools/files/db-backup.sh', true],
    [
      'deploy/helm/qa-tools/files/db-backup*',
      'deploy/helm/qa-tools/files/db-backup-recipient.asc',
      true,
    ],
    ['deploy/helm/qa-tools/files/db-backup*', 'deploy/helm/qa-tools/files/monitor.mjs', false],
    ['deploy/helm/qa-tools/files/db-backup*', 'deploy/helm/qa-tools/files/db-backup/x', false],
    ['.gitlab-ci.yml', '.gitlab-ci.yml', true],
    ['.gitlab-ci.yml', '.gitlab-ciXyml', false],
    ['.gitlab-ci.yml', 'x/.gitlab-ci.yml', false],
    ['scripts/db.mjs', 'scripts/db.mjs.bak', false],
  ]) {
    const pattern = compileGlob(glob);
    assert.equal(typeof pattern, 'function', glob);
    assert.equal(matches([pattern], path), expected, `${glob} on ${path}`);
  }
});

test('a path the lists may not use is refused, never guessed at', () => {
  for (const glob of [
    '',
    '/abs/path',
    './a',
    'a//b',
    'a/',
    'a/../b',
    'a/./b',
    '..',
    'a/?',
    'a/[bc]',
    'a/{b,c}',
    'a/b c',
    "'a/b'",
    'a/$X',
    'a/\\*',
    '*/*/*/*/*',
    'a/**/b/**/c/**/d/**/e/*',
    'x'.repeat(5000),
    null,
    42,
  ]) {
    assert.ok(compileGlob(glob) instanceof Error, JSON.stringify(glob)?.slice(0, 40));
  }
  assert.throws(() => compile([]), /a list of 1 to 50 paths/);
  assert.throws(
    () => compile(Array.from({ length: MAX_PATHS + 1 }, (_, i) => `f${i}`)),
    /a list of 1 to 50/,
  );
  assert.throws(() => compile(['ok', 'a/?']), /unsupported characters/);
  assert.equal(compile(Array.from({ length: MAX_PATHS }, (_, i) => `f${i}`)).length, MAX_PATHS);
  assert.equal(matches(compile(['a*']), 'a'.repeat(5000)), false, 'longer than any path');
  assert.equal(matches(compile(['a*']), null), false);
});

test('matching made-up paths at growing sizes against globs at the wildcard limit stays fast', () => {
  const globs = ['*a*a*a*b', 'a/**/b/**/c*d', '**/**/**/x*', '.claude/**/*'];
  for (const glob of globs) assert.equal(typeof compileGlob(glob), 'function', glob);
  const patterns = compile(globs);
  assert.equal(MAX_WILDCARDS, 4);
  for (const size of [10, 100, 1_000, 4_000]) {
    for (const path of [
      'a'.repeat(size),
      `${'a/'.repeat(size / 2)}c`,
      `a/${'b/'.repeat(size / 2)}c`,
      `${'x/'.repeat(size / 2)}y`,
      `.claude/${'d/'.repeat(size / 2)}`,
    ]) {
      const started = performance.now();
      matches(patterns, path);
      assert.ok(performance.now() - started < 500, `${size}: ${path.slice(0, 20)}`);
    }
  }
});

test('the check names each file read and each directory listed that the paths leave out, and nothing else', () => {
  const patterns = compile(['.claude/**/*', 'docs/tooling/scheduled-fires.md', 'scripts/db*.mjs']);
  const files = new Set([
    '.claude/settings.json',
    'docs/tooling/scheduled-fires.md',
    'docs/DECISIONS.md',
    'scripts/db.mjs',
    'scripts/check-version.mjs',
  ]);
  const directories = new Set(['.claude/scripts', 'docs/tooling', 'docs']);
  const kinds = { isFile: (p) => files.has(p), isDirectory: (p) => directories.has(p) };
  const record = [
    '.claude/settings.json',
    'docs/tooling/scheduled-fires.md',
    'docs/DECISIONS.md',
    'scripts/db.mjs',
    'scripts/check-version.mjs',
    'scripts/check-version.mjs',
    '.claude/scripts/',
    'docs/tooling/',
    // Neither a file nor a directory of the checkout, or not a path in it.
    'git',
    '16384',
    'scripts/gone.mjs',
    '../outside.txt',
    '/etc/passwd',
    'a/../docs/DECISIONS.md',
    './docs/DECISIONS.md',
    '',
    '   ',
    'docs/',
  ].join('\n');
  assert.deepEqual(uncovered(patterns, record, kinds), [
    'docs/',
    'docs/DECISIONS.md',
    'docs/tooling/',
    'scripts/check-version.mjs',
  ]);
  assert.deepEqual(uncovered(patterns, record.replace(/\n/g, '\r\n'), kinds), [
    'docs/',
    'docs/DECISIONS.md',
    'docs/tooling/',
    'scripts/check-version.mjs',
  ]);
  // Records at growing sizes.
  for (const count of [1_000, 100_000]) {
    const big = Array.from({ length: count }, (_, i) =>
      i % 2 ? `.claude/f${i}` : `x${i}${'y'.repeat(i % 300)}`,
    ).join('\n');
    const started = performance.now();
    assert.deepEqual(
      uncovered(patterns, big, { isFile: () => true, isDirectory: () => false }).length,
      count / 2,
    );
    assert.ok(performance.now() - started < 5000, `${count} lines`);
  }
});

test('the check, as the job runs it, passes a record its rule covers and fails one it does not', (t) => {
  const dir = temporary(t);
  const check = (job, lines) => {
    const record = join(dir, 'record.txt');
    if (lines !== null) writeFileSync(record, `${lines.join('\n')}\n`);
    else rmSync(record, { force: true });
    return spawnSync(
      process.execPath,
      [join(root, 'scripts', 'test-inputs.mjs'), 'check', job, record],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
  };
  const ok = check('operations-tests', [
    'scripts/db.mjs',
    'deploy/helm/qa-tools/files/db-backup.sh',
    'scripts/db.mjs',
    'git',
  ]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(
    ok.stdout,
    'operations-tests: its rule names all 2 files of the checkout its tests read.\n',
  );

  const missed = check('operations-tests', [
    'scripts/db.mjs',
    'docs/API.md',
    'deploy/helm/qa-tools/templates/',
  ]);
  assert.equal(missed.status, 1);
  assert.equal(
    missed.stderr,
    [
      "operations-tests's tests read what its rule in .gitlab/ci/validate.yml does not name:",
      '  deploy/helm/qa-tools/templates/ (a new file here)',
      '  docs/API.md',
      "Add each to operations-tests's changes: paths, or stop reading it (D241).",
      '',
    ].join('\n'),
  );
  assert.notEqual(check('operations-tests', null).status, 0, 'no record is no check');
  assert.notEqual(check('delivery-checks', []).status, 0, 'a job without the rule');
  assert.notEqual(check('no-such-job', []).status, 0);
  assert.equal(
    spawnSync(process.execPath, [join(root, 'scripts', 'test-inputs.mjs')], { cwd: root }).status,
    2,
  );
});

test('the recorder notes what a Node process and the Node processes it starts read in this checkout, and nothing outside it', (t) => {
  const dir = temporary(t);
  const record = join(dir, 'record.txt');
  const outside = join(dir, 'outside.txt');
  writeFileSync(outside, 'x\n');
  const code = `
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    fs.readFileSync('VERSION');
    fs.existsSync('docs/API.md');
    fs.existsSync('docs/no-such-file.md');
    fs.readdirSync('docs/testing');
    fs.statSync('docs');
    fs.readFileSync(${JSON.stringify(outside)});
    fs.readdirSync(${JSON.stringify(dir)});
    spawnSync(process.execPath, ['-e', "require('node:fs').statSync('CHANGELOG.md')"], { env: { PATH: process.env.PATH } });
    spawnSync('sh', ['-n', 'deploy/helm/qa-tools/files/db-backup.sh']);
    import('./scripts/check-version.mjs').then(() => fs.promises.readFile('README.md'));
  `;
  const env = {
    PATH: process.env.PATH,
    TEST_INPUTS_FILE: record,
    NODE_OPTIONS: `--import=${join(root, 'scripts', 'test-inputs-trace.mjs')}`,
  };
  const result = spawnSync(process.execPath, ['-e', code], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = readFileSync(record, 'utf8').split('\n').filter(Boolean).sort();
  for (const expected of [
    'VERSION',
    'docs/API.md',
    'docs/no-such-file.md',
    'docs/testing/',
    'CHANGELOG.md',
    'deploy/helm/qa-tools/files/db-backup.sh',
    'scripts/check-version.mjs',
    'README.md',
  ]) {
    assert.ok(lines.includes(expected), `${expected} is not recorded: ${lines.join(', ')}`);
  }
  assert.ok(!lines.includes('docs'), 'a directory stat is no read of its contents');
  assert.ok(
    lines.every((line) => !line.startsWith('/') && !line.startsWith('..')),
    lines.join(', '),
  );
  assert.ok(
    lines.every((line) => !line.startsWith('node_modules')),
    'node_modules is not the checkout',
  );
  assert.equal(new Set(lines).size, lines.length, 'each path once per process');

  // Without TEST_INPUTS_FILE it records nothing and changes nothing.
  const plain = spawnSync(
    process.execPath,
    [
      '-e',
      "require('node:fs').readFileSync('VERSION'); console.log(process.env.TEST_INPUTS_FILE ?? 'none')",
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH, NODE_OPTIONS: env.NODE_OPTIONS },
      encoding: 'utf8',
    },
  );
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, 'none\n');
  assert.equal(plain.stderr, '');
  assert.equal(readdirSync(dir).sort().join(' '), 'outside.txt record.txt');
});
