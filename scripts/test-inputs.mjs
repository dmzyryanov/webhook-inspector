// Whether a group of script tests' rule names what the tests read (#194,
// D241). A job of .gitlab/ci/validate.yml that runs only when what its tests
// read changes lists those paths under `rules: changes: paths:`, and records
// what the tests read with scripts/test-inputs-trace.mjs. After its tests it
// runs `node scripts/test-inputs.mjs check <job> <record>`, which fails,
// naming each one, for every file of the checkout the tests read that the
// paths do not match, and every directory they listed a new file of which the
// paths would not match. So a test that starts reading a file the list leaves
// out fails the first time it runs, which a change to that test or to what it
// reads makes happen.
//
// The paths are matched as GitLab matches `rules:changes`: Ruby's
// File.fnmatch with FNM_PATHNAME, FNM_DOTMATCH and FNM_EXTGLOB. Only the part
// of that syntax the lists need is accepted, and anything else is refused
// rather than guessed at: literal characters, `*` inside a segment, and `**`
// as a whole segment, which matches any number of directories. A list holds
// at most 50 paths, GitLab's limit for one `changes:`.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

/** GitLab's limit on the paths of one `rules:changes`. */
export const MAX_PATHS = 50;
/** At most this many wildcards in one path, so that matching stays linear enough. */
export const MAX_WILDCARDS = 4;
/** Paths longer than this are not a path of this checkout. */
export const MAX_PATH_LENGTH = 4096;

const LITERAL = /^[A-Za-z0-9._-]+$/;

/** Whether `text`, one path segment, matches `pattern`, one glob segment whose only wildcard is `*`. */
function segmentMatches(pattern, text) {
  // The greedy match with one point to return to: linear in practice and at
  // worst the product of the two lengths, never exponential.
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p;
      p += 1;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * A `changes:` path as a function that says whether a changed path matches
 * it, or an Error saying why it is not one this accepts.
 */
export function compileGlob(glob) {
  if (typeof glob !== 'string' || glob === '' || glob.length > MAX_PATH_LENGTH) {
    return new Error('not a path');
  }
  if (glob.startsWith('/') || glob.startsWith('./') || glob.includes('//') || glob.endsWith('/')) {
    return new Error(`${glob}: not a plain relative path`);
  }
  const segments = glob.split('/');
  let wildcards = 0;
  const parts = [];
  for (const [index, segment] of segments.entries()) {
    if (segment === '**' && index < segments.length - 1) {
      // `**/`: any number of directories, none included.
      wildcards += 1;
      parts.push(null);
      continue;
    }
    if (segment === '.' || segment === '..') return new Error(`${glob}: a relative segment`);
    // `**` as the last segment, or inside one, is `*` under FNM_PATHNAME.
    const pattern = segment.replace(/\*+/g, '*');
    for (const piece of pattern.split('*')) {
      if (piece !== '' && !LITERAL.test(piece)) {
        return new Error(`${glob}: unsupported characters in ${segment}`);
      }
    }
    wildcards += (pattern.match(/\*/g) ?? []).length;
    parts.push(pattern);
  }
  if (wildcards > MAX_WILDCARDS) return new Error(`${glob}: more than ${MAX_WILDCARDS} wildcards`);
  return (path) => {
    if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH) return false;
    // The same greedy match one level up: `**/` is the wildcard, any other
    // part matches one name.
    const names = path.split('/');
    let p = 0;
    let n = 0;
    let star = -1;
    let mark = 0;
    while (n < names.length) {
      if (p < parts.length && parts[p] === null) {
        star = p;
        p += 1;
        mark = n;
      } else if (p < parts.length && segmentMatches(parts[p], names[n])) {
        p += 1;
        n += 1;
      } else if (star >= 0) {
        p = star + 1;
        mark += 1;
        n = mark;
      } else {
        return false;
      }
    }
    while (p < parts.length && parts[p] === null) p += 1;
    return p === parts.length;
  };
}

/** The matchers of `globs`, throwing on the first that is refused. */
export function compile(globs) {
  if (!Array.isArray(globs) || globs.length === 0 || globs.length > MAX_PATHS) {
    throw new Error(`a list of 1 to ${MAX_PATHS} paths is needed`);
  }
  return globs.map((glob) => {
    const compiled = compileGlob(glob);
    if (compiled instanceof Error) throw compiled;
    return compiled;
  });
}

/** Whether a changed `path` makes GitLab run a job whose `changes:` paths compiled to `patterns`. */
export function matches(patterns, path) {
  return (
    typeof path === 'string' &&
    path.length <= MAX_PATH_LENGTH &&
    patterns.some((match) => match(path))
  );
}

/**
 * The `changes: paths:` of `job` in `.gitlab/ci/validate.yml` text: the job's
 * first rule must be the merge request rule with its paths, its second the
 * rule that runs it everywhere else, and it must have no other.
 */
export function changesOf(text, job) {
  const lines = text.split('\n');
  const from = lines.indexOf(`${job}:`);
  if (from < 0) throw new Error(`no job ${job}`);
  const end = lines.findIndex((line, at) => at > from && /^[^\s#]/.test(line));
  const body = lines
    .slice(from + 1, end < 0 ? lines.length : end)
    .filter((line) => !/^\s*#/.test(line));
  const rules = body.indexOf('  rules:');
  if (rules < 0) throw new Error(`${job} has no rules`);
  const expected = [
    "    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'",
    '      changes:',
    '        paths:',
  ];
  if (expected.some((line, at) => body[rules + 1 + at] !== line)) {
    throw new Error(`${job}'s first rule is not the merge request rule with changes: paths:`);
  }
  const paths = [];
  let at = rules + 1 + expected.length;
  for (; /^ {10}- /.test(body[at] ?? ''); at += 1) paths.push(body[at].slice(12).trim());
  if (
    body[at] !== "    - if: $CI_PIPELINE_SOURCE != 'merge_request_event'" ||
    /^ {4}[- ]/.test(body[at + 1] ?? '')
  ) {
    throw new Error(
      `${job}'s rules are not the merge request rule and the rule for every other pipeline`,
    );
  }
  return paths;
}

/**
 * What the record holds that the paths leave out: files of the checkout that
 * `patterns` do not match, and listed directories a new file of which they
 * would not match. `isFile` and `isDirectory` say what a recorded path is in
 * the checkout; a path that is neither, or outside the checkout, counts for
 * nothing.
 */
export function uncovered(patterns, record, { isFile, isDirectory }) {
  const missing = new Set();
  for (const raw of record.split('\n')) {
    const entry = raw.trim();
    if (entry === '' || entry.length > MAX_PATH_LENGTH) continue;
    const listing = entry.endsWith('/');
    const path = listing ? entry.slice(0, -1) : entry;
    if (
      path === '' ||
      path.startsWith('/') ||
      path.split('/').some((s) => s === '' || s === '.' || s === '..')
    ) {
      continue;
    }
    if (listing) {
      if (isDirectory(path) && !matches(patterns, `${path}/a-new-file`)) missing.add(entry);
    } else if (isFile(path) && !matches(patterns, path)) {
      missing.add(entry);
    }
  }
  return [...missing].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, job, recordPath] = process.argv.slice(2);
  if (command !== 'check' || !job || !recordPath) {
    console.error('Usage: node scripts/test-inputs.mjs check <job> <record>');
    process.exit(2);
  }
  const root = process.cwd();
  const patterns = compile(
    changesOf(readFileSync(join(root, '.gitlab/ci/validate.yml'), 'utf8'), job),
  );
  // No record at all means the tests ran without the recorder: nothing was checked.
  const record = readFileSync(recordPath, 'utf8');
  const kind = (path) => statSync(join(root, path), { throwIfNoEntry: false });
  const missing = uncovered(patterns, record, {
    isFile: (path) => kind(path)?.isFile() ?? false,
    isDirectory: (path) => kind(path)?.isDirectory() ?? false,
  });
  const files = new Set(record.split('\n').filter((line) => line && kind(line)?.isFile()));
  if (missing.length > 0) {
    console.error(`${job}'s tests read what its rule in .gitlab/ci/validate.yml does not name:`);
    for (const entry of missing)
      console.error(`  ${entry}${entry.endsWith('/') ? ' (a new file here)' : ''}`);
    console.error(`Add each to ${job}'s changes: paths, or stop reading it (D241).`);
    process.exit(1);
  }
  console.log(`${job}: its rule names all ${files.size} files of the checkout its tests read.`);
}
