// What this repository names of the private side it came from (#375). The
// inspector moved out of the QA Tools project, whose agents' files, decision
// log, delivery process, records of resources and runbooks are not published
// (D282), and production's CI runner and hosting provider are its operator's.
// A tracked file outside CHANGELOG.md, whose history stays as published,
// names none of them but where ALLOWED says it may, so that none creeps back:
// a file that does fails here, in `delivery-checks`, naming the file, the line
// and the name. Decision and issue numbers stay, as references (README).
//
// The check reads every path `git ls-files` lists, and the file at it in the
// working tree, byte for byte. The names are literal and case-sensitive, as
// the issue's own `git grep` is: a name split across lines, escaped or written
// in another case is not caught.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import test from 'node:test';
import { URL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The names, each literal and case-sensitive. */
const NAMES = Object.freeze([
  '.claude/',
  'docs/DECISIONS.md',
  'docs/DELIVERY.md',
  'docs/RESOURCES.md',
  'docs/runbooks/',
  'qa-tools-ci-firstvds',
  'FirstVDS',
]);

/** The one file the check does not read: the changelog's published history. */
const EXEMPT = 'CHANGELOG.md';

/**
 * Where a name may stay: a whole file, or in it only the lines given, each
 * exactly (a line's closing `\r` aside). An entry that allows nothing fails
 * the check, so the list shrinks with the files.
 */
const ALLOWED = Object.freeze([
  // The private side's local files, which Git must never pick up.
  { file: '.gitignore', lines: ['.claude/settings.local.json', '.claude/worktrees/'] },
  // This file: the names above and its tests' made-up input.
  { file: 'scripts/private-names.test.mjs' },
  // The changelog check's case for `.claude/`, a path its published text refuses.
  {
    file: 'apps/frontend/src/lib/changelog.test.ts',
    lines: ["    'An agent in .claude/agents.',"],
  },

  // PROVISIONAL (#375): the owner's decision on the operator's texts changes
  // this group, and only this group.
  // The operator's own Privacy Policy, shown only with OPERATOR_TEXTS (#369).
  { file: 'apps/frontend/src/lib/legal-copy.ts' },
  // Its test, which holds that text word for word.
  { file: 'apps/frontend/src/lib/legal-copy.test.ts' },
  // #369's build check, which names what it refuses.
  { file: 'apps/frontend/scripts/check-build.mjs' },
  // That check's test, which builds with those names and without them.
  { file: 'apps/frontend/src/lib/operator.test.ts' },
]);

/** The names a text holds, in the list's order. */
const namesIn = (text) => NAMES.filter((name) => text.includes(name));

/**
 * The tracked paths of the checkout at `dir`, each with its content as
 * Latin-1 text, one character a byte, so that no decoding hides a name: a
 * symbolic link's target, nothing for a file the working tree lacks or a
 * submodule.
 */
function trackedFiles(dir) {
  const listed = execFileSync('git', ['-C', dir, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .split('\0')
    .filter(Boolean)
    .map((path) => {
      const full = join(dir, path);
      let stat;
      try {
        stat = lstatSync(full);
      } catch (error) {
        if (error.code === 'ENOENT') return [path, ''];
        throw error;
      }
      if (stat.isSymbolicLink()) return [path, readlinkSync(full, 'latin1')];
      if (!stat.isFile()) return [path, ''];
      return [path, readFileSync(full).toString('latin1')];
    });
}

/**
 * What the files name that they may not, one finding a line, and which
 * entries of `allowed` allowed something.
 */
function check(files, allowed = ALLOWED) {
  const problems = [];
  const used = new Set();
  for (const [path, text] of files) {
    for (const name of namesIn(path)) problems.push(`${path}: its path names ${name}`);
    if (path === EXEMPT || namesIn(text).length === 0) continue;
    const entry = allowed.find((item) => item.file === path);
    if (entry && !entry.lines) {
      used.add(entry);
      continue;
    }
    const lines = text.split('\n');
    for (let at = 0; at < lines.length; at += 1) {
      const line = lines[at].endsWith('\r') ? lines[at].slice(0, -1) : lines[at];
      const named = namesIn(line);
      if (named.length === 0) continue;
      if (entry?.lines.includes(line)) {
        used.add(`${path}\n${line}`);
        continue;
      }
      for (const name of named) problems.push(`${path}:${at + 1}: ${name}`);
    }
  }
  const unused = allowed.flatMap((entry) =>
    entry.lines
      ? entry.lines
          .filter((line) => !used.has(`${entry.file}\n${line}`))
          .map((line) => `${entry.file}, the line ${JSON.stringify(line)}`)
      : used.has(entry)
        ? []
        : [entry.file],
  );
  return { problems, unused };
}

const report = (problems) =>
  [
    'A tracked file names what this repository does not publish (#375):',
    ...problems.map((problem) => `  ${problem}`),
    'Say in place what is needed, or cite the decision or issue number alone;',
    'scripts/private-names.test.mjs lists the names and where one may stay.',
  ].join('\n');

test('no tracked file outside CHANGELOG.md names the private side, but where the list allows it', () => {
  const { problems } = check(trackedFiles(root));
  assert.deepEqual(problems, [], report(problems));
});

test('every entry of the list still allows something', () => {
  const { unused } = check(trackedFiles(root));
  assert.deepEqual(
    unused,
    [],
    `The list allows what no tracked file names any more; take these out of ALLOWED:\n  ${unused.join('\n  ')}`,
  );
});

test('on made-up files: each name, its file and line, and nothing but the names', () => {
  const allowed = [];
  const { problems } = check(
    [
      ['a.md', 'one\nSee docs/DECISIONS.md and docs/runbooks/x.md.\n'],
      ['b.ts', '// .claude/agents\r\nconst host = "qa-tools-ci-firstvds";\r\n'],
      ['c.txt', 'xFirstVDSx docs/DELIVERY.mdx docs/RESOURCES.md'],
      // Near misses: another case, no slash, split, escaped, or another file.
      ['d.md', 'firstvds FIRSTVDS .claude .claudex/ First\nVDS docs/decisions.md'],
      ['e.md', 'docs\\/DECISIONS.md First&#86;DS docs/DECISIONS-old.md'],
      ['CHANGELOG.md', 'On FirstVDS, see docs/DECISIONS.md.'],
      ['apps/CHANGELOG.md', 'On FirstVDS.'],
      ['changelog.md', 'On FirstVDS.'],
      ['.claude/agents/developer.md', 'nothing'],
      ['docs/runbooks/restore.md', ''],
    ],
    allowed,
  );
  assert.deepEqual(problems, [
    'a.md:2: docs/DECISIONS.md',
    'a.md:2: docs/runbooks/',
    'b.ts:1: .claude/',
    'b.ts:2: qa-tools-ci-firstvds',
    'c.txt:1: docs/DELIVERY.md',
    'c.txt:1: docs/RESOURCES.md',
    'c.txt:1: FirstVDS',
    'apps/CHANGELOG.md:1: FirstVDS',
    'changelog.md:1: FirstVDS',
    '.claude/agents/developer.md: its path names .claude/',
    'docs/runbooks/restore.md: its path names docs/runbooks/',
  ]);
});

test('on made-up files: an allowed line only as it is, a whole file anywhere, and an entry that allows nothing named', () => {
  const allowed = [
    { file: '.gitignore', lines: ['.claude/settings.local.json', '.claude/worktrees/'] },
    { file: 'guard.mjs' },
    { file: 'gone.mjs' },
    { file: 'kept.ts', lines: ['  "FirstVDS",', 'never there'] },
  ];
  const ignore = [
    '# Local files of .claude/scripts/x.sh.',
    '.claude/settings.local.json',
    '.claude/worktrees/\r',
    '.claude/worktrees/ ',
    ' .claude/worktrees/',
    '/.claude/worktrees/',
    '!.claude/worktrees/',
    '.claude/worktrees/*',
    '.claude/settings.local.json .claude/x',
  ].join('\n');
  const { problems, unused } = check(
    [
      ['.gitignore', ignore],
      ['apps/.gitignore', '.claude/worktrees/'],
      ['guard.mjs', 'const refused = ["FirstVDS", "docs/DECISIONS.md"];\nFirstVDS'],
      ['kept.ts', '  "FirstVDS",\n "FirstVDS",'],
    ],
    allowed,
  );
  assert.deepEqual(problems, [
    '.gitignore:1: .claude/',
    '.gitignore:4: .claude/',
    '.gitignore:5: .claude/',
    '.gitignore:6: .claude/',
    '.gitignore:7: .claude/',
    '.gitignore:8: .claude/',
    '.gitignore:9: .claude/',
    'apps/.gitignore:1: .claude/',
    'kept.ts:2: FirstVDS',
  ]);
  assert.deepEqual(unused, ['gone.mjs', 'kept.ts, the line "never there"']);
});

test('on made-up content at growing sizes: a name found at the end of a long line and among many lines, quickly', () => {
  for (const size of [1_000, 100_000, 10_000_000]) {
    const started = performance.now();
    const line = `${'FirstVD'.repeat(size / 7)}FirstVDS`;
    const near = Array.from({ length: size / 100 }, (_, i) =>
      i % 2 ? '.claude' + 'x/'.repeat(10) : 'docs/DECISIONS.m',
    ).join('\n');
    const { problems } = check(
      [
        ['long.txt', line],
        ['near.txt', `${near}\ndocs/runbooks/`],
        ['crlf.txt', 'a\r\n'.repeat(size / 10) + '.claude/\r\n'],
      ],
      [],
    );
    assert.deepEqual(problems, [
      'long.txt:1: FirstVDS',
      `near.txt:${size / 100 + 1}: docs/runbooks/`,
      `crlf.txt:${size / 10 + 1}: .claude/`,
    ]);
    assert.ok(performance.now() - started < 5000, `${size}: ${performance.now() - started} ms`);
  }
});

test('on bytes no decoding can hide a name in: binary content, invalid UTF-8 and NUL around it', () => {
  const content = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xc3]),
    Buffer.from('FirstVDS'),
    Buffer.from([0xe2, 0x82, 0x00, 0xf0, 0x9f]),
    Buffer.from('.claude/'),
    Buffer.from([0xc0]),
  ]);
  const { problems } = check([['logo.png', content.toString('latin1')]], []);
  assert.deepEqual(problems, ['logo.png:1: .claude/', 'logo.png:1: FirstVDS']);
});

test('on a throwaway repository: a tracked file that names one fails, naming it; untracked, deleted and allowed ones do not', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-private-names-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git('init', '--quiet', '--initial-branch=main');
  write('README.md', 'Nothing here.\n');
  write('docs/a b.md', 'Hosted at FirstVDS.\n');
  write('deleted.md', 'docs/DELIVERY.md\n');
  write('.gitignore', '.claude/worktrees/\n');
  git('add', '--', 'README.md', 'docs/a b.md', 'deleted.md', '.gitignore');
  write('untracked.md', 'docs/RESOURCES.md\n');
  rmSync(join(dir, 'deleted.md'));
  const { problems } = check(trackedFiles(dir), [
    { file: '.gitignore', lines: ['.claude/worktrees/'] },
  ]);
  assert.deepEqual(problems, ['docs/a b.md:1: FirstVDS']);
  assert.match(report(problems), /^ {2}docs\/a b\.md:1: FirstVDS$/m);
});
