// What this repository names of the private side it came from (#375, #397).
// The inspector moved out of the QA Tools project, whose agents' files,
// decision log, delivery process, records of resources and runbooks are not
// published (D282), and production's CI runners, hosting provider, backup
// storage and heartbeat service are its operator's. A tracked file outside
// CHANGELOG.md, whose history stays as published, names none of them but
// where ALLOWED says it may, so that none creeps back: a file that does fails
// here, in `delivery-checks`, naming the file, the line and the name.
// Decision and issue numbers stay, as references (README).
//
// The check reads every path `git ls-files` lists, and the file at it in the
// working tree, byte for byte. A name is found in any case of its letters,
// and regex-escaped, with no backslash, one or two before each of its other
// characters: one as a test's pattern writes it, two as a JavaScript string
// handed to `new RegExp` holds it. `HB.STATUSER.CLOUD`, `FirstVds`,
// `hb\.statuser\.cloud`, `hb\\.statuser\\.cloud`, `docs\\/DECISIONS\.md` and
// `\.claude\/` are all found (#410, #438). A runner's build directory is a
// form, not one string, and FORMS matches it, in any case. Still not caught:
// a name split across lines; three backslashes or more before any of its
// characters but the first; a backslash before a letter or digit; a character
// written as a class (`[.]`), a code (`\x2e`), an HTML entity, percent-encoded
// or as a lookalike from another alphabet; and a runner's build directory
// regex-escaped.

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

/** The names, each found as PATTERNS spells it. */
const NAMES = Object.freeze([
  '.claude/',
  'docs/DECISIONS.md',
  'docs/DELIVERY.md',
  'docs/RESOURCES.md',
  'docs/runbooks/',
  // Production's CI runner's tag, found too at the start of a longer one (#410).
  'qa-tools-ci',
  'FirstVDS',
  // Production's deploy runner's tag, its backup bucket and directory, and its
  // heartbeat service's host: values of its CI/CD variables, which the tests
  // replace with made-up ones (#397).
  'qa-tools-vps',
  'qa-tools-backups',
  '/var/backups/qa-tools',
  'hb.statuser.cloud',
]);

/**
 * Each name as a pattern (#410, #438): its letters in any case, and before
 * each of its other characters none, one or two backslashes, `\\{0,2}`: one
 * as a regular expression escapes them, two as a JavaScript string handed to
 * `new RegExp` holds that escape. Three or more have no such reading and stay
 * unmatched. The first character goes without: a search finds a name wherever
 * it starts, backslashes before it or not. The backslashes are a bounded part,
 * never `\\*` or `\\+`, and match only where the name allows them, so a run
 * of them, or of a name's start in alternating case, costs the search a few
 * steps a character; a part that repeated without bound at a name's start
 * would make a long run of backslashes cost it quadratic time.
 */
const PATTERNS = Object.freeze(
  NAMES.map((name) => ({
    name,
    pattern: new RegExp(
      [...name]
        .map((char, at) => (/[A-Za-z0-9]/.test(char) ? char : `${at ? '\\\\{0,2}' : ''}\\${char}`))
        .join(''),
      'i',
    ),
  })),
);

/**
 * The names that are a form, not one string: a GitLab runner's build
 * directory, `runner-<token>-project-<id>-concurrent-<n>`, which a job's log
 * prints and whose token part names the runner (#397). A token is 8 or 9
 * characters of `[A-Za-z0-9_-]`, and up to 40 are taken. The form is found in
 * any case, but not regex-escaped, which #410 asks of NAMES alone.
 *
 * The pattern begins with its lookbehind, so at a position it tries, the
 * search reads back first: for a token, at most 40 characters, then for
 * `runner-` before it, giving the token back a character at a time down to 8;
 * and only where that holds does it read `-project-` and a digit forward. No
 * position costs more than those few hundred steps, however many `runner-` or
 * `-project-` a text holds, so the search stays linear. V8 also, before that,
 * glances at the next few characters and tries the lookbehind only where they
 * could begin `-project-`: on ten million letters, measured on Node v24.22.2,
 * the pattern takes under 20 ms, where the lookbehind alone, tried at every
 * position, takes about 2.7 s (#410). The bound does not rest on that.
 */
const FORMS = Object.freeze([
  { name: 'runner-<token>-project-', pattern: /(?<=runner-[\w-]{8,40})-project-\d/i },
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
  // The chart test's check that a render names nothing of production's, which
  // must say what it refuses, the hosting provider in lower case (#410).
  {
    file: 'scripts/chart.test.mjs',
    lines: ['      if (/qa[-_]tools|statuser|yandex|firstvds/i.test(text)) {'],
  },

  // The operator's own texts, kept as they are until #330 moves them out of
  // this repository to the platform, and #369's guard, which names what it
  // refuses in a build without the operator's settings: #330 removes this
  // group together with them (#375, decided on 2026-11-04).
  // The operator's Privacy Policy, shown only with OPERATOR_TEXTS (#369).
  { file: 'apps/frontend/src/lib/legal-copy.ts' },
  // Its test, which holds that text word for word.
  { file: 'apps/frontend/src/lib/legal-copy.test.ts' },
  // #369's build check, which names what it refuses.
  { file: 'apps/frontend/scripts/check-build.mjs' },
  // That check's test, which builds with those names and without them.
  { file: 'apps/frontend/src/lib/operator.test.ts' },
]);

/** The names a text holds, in the lists' order: NAMES, then FORMS. */
const namesIn = (text) =>
  [...PATTERNS, ...FORMS].filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);

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
      // Another case and escaped, near misses until #410.
      ['d.md', 'firstvds FIRSTVDS\ndocs/decisions.md\ndocs\\/DECISIONS.md'],
      // Near misses: no slash, cut short, split, changed, an HTML entity,
      // percent-encoded, three backslashes or four before a character, even
      // after two before another, a backslash or two before a letter, a
      // character class, a code; or another file.
      [
        'e.md',
        [
          '.claude .claudex/ qa-tools-c First',
          'VDS docs/DECISIONS-old.md First&#86;DS docs%2FDECISIONS.md .claude%2F',
          'hb\\\\\\.statuser.cloud docs\\\\\\\\/DECISIONS.md .claude\\\\\\/ qa\\\\-tools\\\\\\-ci',
          'F\\irstVDS F\\\\irstVDS docs/\\runbooks/ docs/\\\\runbooks/ hb\\\\.statuser\\.c\\\\loud',
          'hb[.]statuser[.]cloud hb\\x2estatuser\\x2ecloud docs\\u002fDECISIONS.md',
        ].join('\n'),
      ],
      ['CHANGELOG.md', 'On FirstVDS, see docs/DECISIONS.md.'],
      ['apps/CHANGELOG.md', 'On FirstVDS.'],
      ['changelog.md', 'On FirstVDS.'],
      ['.claude/agents/developer.md', 'nothing'],
      ['docs/runbooks/restore.md', ''],
      ['.Claude/agents/x.md', ''],
      ['docs/Runbooks/x.md', ''],
    ],
    allowed,
  );
  assert.deepEqual(problems, [
    'a.md:2: docs/DECISIONS.md',
    'a.md:2: docs/runbooks/',
    'b.ts:1: .claude/',
    'b.ts:2: qa-tools-ci',
    'b.ts:2: FirstVDS',
    'c.txt:1: docs/DELIVERY.md',
    'c.txt:1: docs/RESOURCES.md',
    'c.txt:1: FirstVDS',
    'd.md:1: FirstVDS',
    'd.md:2: docs/DECISIONS.md',
    'd.md:3: docs/DECISIONS.md',
    'apps/CHANGELOG.md:1: FirstVDS',
    'changelog.md:1: FirstVDS',
    '.claude/agents/developer.md: its path names .claude/',
    'docs/runbooks/restore.md: its path names docs/runbooks/',
    '.Claude/agents/x.md: its path names .claude/',
    'docs/Runbooks/x.md: its path names docs/runbooks/',
  ]);
});

test('on made-up files: each name in upper case, in mixed case and escaped with one backslash or two, each with its file and line (#410, #438)', () => {
  // Every letter one way, then every other letter each way; one backslash,
  // or two, before every character a pattern would escape, the first one
  // included, in the name's own case and in another; and one and two in turn,
  // starting with either.
  const alternating = (name, first) =>
    [...name]
      .map((char, at) => (at % 2 === first ? char.toUpperCase() : char.toLowerCase()))
      .join('');
  const escaped = (name) => name.replace(/[^A-Za-z0-9]/g, '\\$&');
  const doubled = (name) => name.replace(/[^A-Za-z0-9]/g, '\\\\$&');
  const mixed = (name, first) => {
    let at = 0;
    return name.replace(/[^A-Za-z0-9]/g, (char) => {
      at += 1;
      return `${at % 2 === first ? '\\' : '\\\\'}${char}`;
    });
  };
  const spellings = NAMES.flatMap((name) =>
    [
      name.toUpperCase(),
      name.toLowerCase(),
      alternating(name, 0),
      alternating(name, 1),
      escaped(name),
      escaped(alternating(name, 1)),
      doubled(name),
      doubled(alternating(name, 0)),
      mixed(name, 0),
      mixed(alternating(name, 1), 1),
    ].map((spelling) => [spelling, name]),
  );
  const { problems } = check(
    [
      ['spellings.txt', spellings.map(([spelling]) => `x ${spelling} x`).join('\r\n')],
      [
        'examples.mjs',
        [
          "const host = 'HB.STATUSER.CLOUD';",
          '// Hosted at FirstVds.',
          'assert.match(log, /hb\\.statuser\\.cloud/);',
          'assert.doesNotMatch(text, /docs\\/DECISIONS\\.md|\\.claude\\//);',
          "const tag = 'Qa\\-Tools\\-CI';",
          'const dir = /\\/var\\/backups\\/qa-tools\\//;',
          'Under docs\\/runbooks/ and docs/DELIVERY\\.md.',
          "assert.match(log, new RegExp('hb\\\\.statuser\\\\.cloud'));",
          "const refused = new RegExp('DOCS\\\\/decisions\\\\.md|\\\\.Claude\\\\/');",
          'const tag = new RegExp(`qa\\-tools\\\\-ci`);',
          "const bucket = new RegExp('\\\\/var\\/backups\\\\/qa\\-tools');",
          '// See docs\\\\/RESOURCES\\.md and docs\\/runbooks\\\\/.',
        ].join('\n'),
      ],
    ],
    [],
  );
  assert.deepEqual(problems, [
    ...spellings.map(([, name], at) => `spellings.txt:${at + 1}: ${name}`),
    'examples.mjs:1: hb.statuser.cloud',
    'examples.mjs:2: FirstVDS',
    'examples.mjs:3: hb.statuser.cloud',
    'examples.mjs:4: .claude/',
    'examples.mjs:4: docs/DECISIONS.md',
    'examples.mjs:5: qa-tools-ci',
    'examples.mjs:6: /var/backups/qa-tools',
    'examples.mjs:7: docs/DELIVERY.md',
    'examples.mjs:7: docs/runbooks/',
    'examples.mjs:8: hb.statuser.cloud',
    'examples.mjs:9: .claude/',
    'examples.mjs:9: docs/DECISIONS.md',
    'examples.mjs:10: qa-tools-ci',
    'examples.mjs:11: /var/backups/qa-tools',
    'examples.mjs:12: docs/RESOURCES.md',
    'examples.mjs:12: docs/runbooks/',
  ]);
});

test("on made-up files: production's CI runner's tag in any tracked file, in any case and escaped, but in the changelog (#410)", () => {
  const { problems } = check(
    [
      ['.gitlab-ci.yml', 'deploy:\n  tags:\n    - qa-tools-ci\n'],
      ['.gitlab/ci/validate.yml', "variables:\n  QA_TOOLS_RUNNER_TAG: 'QA-Tools-CI'\n"],
      ['deploy/helm/x/values.yaml', '# Was run on qa-tools-ci-2.\n'],
      ['scripts/x.test.mjs', 'assert.doesNotMatch(log, /qa-tools\\-ci/);\n'],
      ['scripts/y.test.mjs', "assert.doesNotMatch(log, new RegExp('QA\\\\-tools\\\\-ci'));\n"],
      // Near misses: the variable's name, the tag cut short or changed.
      ['README.md', 'QA_TOOLS_RUNNER_TAG names it: not qa-tools-c, qa_tools_ci or qa-tools-cl.\n'],
      ['CHANGELOG.md', 'Runs on qa-tools-ci.\n'],
    ],
    [],
  );
  assert.deepEqual(problems, [
    '.gitlab-ci.yml:3: qa-tools-ci',
    '.gitlab/ci/validate.yml:2: qa-tools-ci',
    'deploy/helm/x/values.yaml:1: qa-tools-ci',
    'scripts/x.test.mjs:1: qa-tools-ci',
    'scripts/y.test.mjs:1: qa-tools-ci',
  ]);
  assert.match(report(problems), /^ {2}\.gitlab-ci\.yml:3: qa-tools-ci$/m);
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
    '.Claude/worktrees/',
    '\\.claude\\/worktrees/',
    '\\\\.claude\\\\/worktrees/',
  ].join('\n');
  const { problems, unused } = check(
    [
      ['.gitignore', ignore],
      ['apps/.gitignore', '.claude/worktrees/'],
      ['guard.mjs', 'const refused = ["FirstVDS", "docs/DECISIONS.md"];\nFirstVDS\nfirstvds'],
      ['kept.ts', '  "FirstVDS",\n "FirstVDS",\n  "firstvds",'],
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
    '.gitignore:10: .claude/',
    '.gitignore:11: .claude/',
    '.gitignore:12: .claude/',
    'apps/.gitignore:1: .claude/',
    'kept.ts:2: FirstVDS',
    'kept.ts:3: FirstVDS',
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

test("on made-up files: production's variable values and a runner's build directory, each with its file and line, and their near misses not (#397)", () => {
  const { problems } = check(
    [
      ['f.mjs', "const tag = 'qa-tools-vps';\nconst bucket = 'qa-tools-backups';\n"],
      ['g.md', 'Kept in /var/backups/qa-tools/nightly; beats to https://hb.statuser.cloud/x.\n'],
      [
        'h.txt',
        [
          'Running on runner-ab12cd34-project-123-concurrent-0',
          'runner-jq_m-5oe9-project-7',
          `runner-${'a'.repeat(40)}-project-1`,
          'xrunner-abcdefgh-project-0x',
          'Runner-AbCd1234-PROJECT-5',
        ].join('\r\n'),
      ],
      ['runner-ab12cd34-project-9/x.log', ''],
      // Another case, near misses until #410.
      ['j.md', 'QA-TOOLS-VPS\nHB.STATUSER.CLOUD\nRunner-abcdefgh-project-1'],
      // Near misses: a name cut short or changed, the README's own directory,
      // a placeholder token, a token of 7 or 41 characters, no project
      // number, `projects`, the form regex-escaped.
      [
        'i.md',
        [
          'qa-tools-vp qa-tools-backup qa_tools-backups',
          '/var/backups/webhook-inspector /var/backups/qa_tools /var/backup/qa-tools',
          'hb.statuser.clou hb-statuser.cloud statuser.cloud',
          'runner-<token>-project-<project>-concurrent-0 runner-…-project-1',
          'runner-abcdefg-project-1',
          `runner-${'a'.repeat(41)}-project-1`,
          'runner-abcdefgh-project-x runner-abcdefgh-projects-1',
          'runner-abcd efgh-project-1 runner-abcdefgh_project-1',
          'runner\\-abcdefgh\\-project\\-1',
        ].join('\n'),
      ],
    ],
    [],
  );
  assert.deepEqual(problems, [
    'f.mjs:1: qa-tools-vps',
    'f.mjs:2: qa-tools-backups',
    'g.md:1: /var/backups/qa-tools',
    'g.md:1: hb.statuser.cloud',
    'h.txt:1: runner-<token>-project-',
    'h.txt:2: runner-<token>-project-',
    'h.txt:3: runner-<token>-project-',
    'h.txt:4: runner-<token>-project-',
    'h.txt:5: runner-<token>-project-',
    'runner-ab12cd34-project-9/x.log: its path names runner-<token>-project-',
    'j.md:1: qa-tools-vps',
    'j.md:2: hb.statuser.cloud',
    'j.md:3: runner-<token>-project-',
  ]);
});

test("on made-up content at growing sizes: a runner's build directory found after runs built to make its pattern backtrack, and none in them, quickly (#397)", () => {
  for (const size of [1_000, 100_000, 10_000_000]) {
    const started = performance.now();
    // Every start of `runner-` followed by more token characters than a token
    // has, `-` included, or by a token with no `-project-<digit>` after it;
    // and every `-project-<digit>` with no `runner-` behind it.
    const runs = `${'runner-'.repeat(size / 7)}x`;
    const projects = `x${'-project-1'.repeat(size / 10)}`;
    const long = `runner-${'b-'.repeat(size / 2)}project-1`;
    const capped = `runner-${'c'.repeat(40)}`.repeat(size / 47);
    const almost = 'runner-abcdefgh-project-'.repeat(size / 24);
    const near = Array.from({ length: size / 100 }, (_, i) =>
      i % 2 ? 'runner-abcdefg-project-1' : `runner-${'d'.repeat(41)}-project-1`,
    ).join('\n');
    const { problems } = check(
      [
        ['runs.txt', runs],
        ['projects.txt', projects],
        ['long.txt', long],
        ['capped.txt', capped],
        ['almost.txt', almost],
        ['near.txt', near],
        ['end.txt', `${near}\nrunner-ab12cd34-project-1\n`],
        ['crlf.txt', 'a\r\n'.repeat(size / 10) + 'runner-ab12cd34-project-1-concurrent-0\r\n'],
      ],
      [],
    );
    assert.deepEqual(problems, [
      `end.txt:${size / 100 + 1}: runner-<token>-project-`,
      `crlf.txt:${size / 10 + 1}: runner-<token>-project-`,
    ]);
    assert.ok(performance.now() - started < 5000, `${size}: ${performance.now() - started} ms`);
  }
});

test('on made-up content at growing sizes: a name found after runs built for its case and escapes, and none in them, quickly (#410)', () => {
  for (const size of [1_000, 100_000, 10_000_000]) {
    const started = performance.now();
    // Runs of backslashes, alone and one more than a name allows; and runs of
    // a name's start, escaped or not, and of the runner form's words, in
    // alternating case.
    const slashes = `${'\\'.repeat(size)}\\.claude\\/`;
    const doubled = `${'docs\\\\\\'.repeat(size / 7)}docs\\/DECISIONS\\.md`;
    const alternating = `${'fIrStVd'.repeat(size / 7)}FiRsTvDs`;
    const escaped = `${'Hb\\.StAtUsEr\\.ClOu'.repeat(size / 19)}HB\\.STATUSER\\.CLOUD`;
    const runners = `${'RuNnEr-'.repeat(size / 7)}x`;
    const projects = `x${'-PrOjEcT-1'.repeat(size / 10)}`;
    const near = Array.from({ length: size / 100 }, (_, i) =>
      i % 2 ? 'Hb\\.StAtUsEr\\\\\\.ClOuD' : '\\/VaR\\/bAcKuPs\\/Qa\\-ToOl',
    ).join('\n');
    const { problems } = check(
      [
        ['slashes.txt', slashes],
        ['doubled.txt', doubled],
        ['alternating.txt', alternating],
        ['escaped.txt', escaped],
        ['runners.txt', runners],
        ['projects.txt', projects],
        ['near.txt', `${near}\nRuNnEr-Ab12Cd34-PrOjEcT-1`],
      ],
      [],
    );
    assert.deepEqual(problems, [
      'slashes.txt:1: .claude/',
      'doubled.txt:1: docs/DECISIONS.md',
      'alternating.txt:1: FirstVDS',
      'escaped.txt:1: hb.statuser.cloud',
      `near.txt:${size / 100 + 1}: runner-<token>-project-`,
    ]);
    assert.ok(performance.now() - started < 5000, `${size}: ${performance.now() - started} ms`);
  }
});

test('on made-up content at growing sizes: a name escaped with two backslashes found after runs built for them, and none in the runs, quickly (#438)', () => {
  for (const size of [1_000, 100_000, 10_000_000]) {
    const started = performance.now();
    // A long run of backslashes before a name and inside one; runs of a
    // name's start, in alternating case, with two backslashes before each
    // character a pattern escapes, or one and two in turn; a run with three,
    // one more than a name allows; and many lines, each a name cut short or
    // with three backslashes or four.
    const before = `${'\\'.repeat(size)}\\\\.claude\\\\/`;
    const inside = `docs${'\\'.repeat(size)}/DECISIONS.md\nDOCS\\\\/decisions\\\\.MD`;
    const doubled = `${'Hb\\\\.StAtUsEr\\\\.ClOu'.repeat(size / 20)}HB\\\\.STATUSER\\\\.CLOUD`;
    const mixed = `${'\\\\/vAr\\/bAcKuPs\\\\/qA\\-tOoL'.repeat(size / 26)}\\/VaR\\\\/bAcKuPs\\/Qa\\\\-ToOlS`;
    const tripled = `${'qA\\\\\\-tOoLs\\\\\\-'.repeat(size / 15)}Qa\\\\-ToOlS\\\\-cI`;
    const near = Array.from({ length: size / 100 }, (_, i) =>
      i % 2 ? 'DoCs\\\\/DeLiVeRy\\\\\\.Md' : '\\\\.ClAuDe\\\\\\\\/ dOcS\\\\/rUnBoOkS',
    ).join('\n');
    const { problems } = check(
      [
        ['before.txt', before],
        ['inside.txt', inside],
        ['doubled.txt', doubled],
        ['mixed.txt', mixed],
        ['tripled.txt', tripled],
        ['near.txt', `${near}\nDoCs\\/ReSoUrCeS\\\\.mD`],
      ],
      [],
    );
    assert.deepEqual(problems, [
      'before.txt:1: .claude/',
      'inside.txt:2: docs/DECISIONS.md',
      'doubled.txt:1: hb.statuser.cloud',
      'mixed.txt:1: /var/backups/qa-tools',
      'tripled.txt:1: qa-tools-ci',
      `near.txt:${size / 100 + 1}: docs/RESOURCES.md`,
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
