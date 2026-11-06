import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

// This repository's version rule (D281): a changed path that starts with a
// `runtime` entry ending in `/`, or equals one that does not, is a runtime
// path and needs a VERSION bump, unless it ends with a `tests` entry — a test
// file ships no runtime behaviour wherever it sits, so it keeps the version.
// The rule is the one qa-tools' repository registry held for this code when
// it lived there; the delivery process that delivers into this repository
// keeps a copy of it, which changes with this one.
export const VERSION_RULE = Object.freeze({
  runtime: Object.freeze([
    'apps/',
    'packages/',
    'deploy/helm/',
    'deploy/postgres/',
    'package.json',
    'package-lock.json',
    'docker-compose.yml',
    '.dockerignore',
    'tsconfig.base.json',
  ]),
  tests: Object.freeze(['.test.ts', '.test.tsx']),
});

export const isRuntimePath = (path) =>
  VERSION_RULE.runtime.some((item) =>
    item.endsWith('/') ? path.startsWith(item) : path === item,
  ) && !VERSION_RULE.tests.some((suffix) => path.endsWith(suffix));

// The version this repository starts at: it holds Webhook Inspector from the
// import of qa-tools at 1.19.5 (#326), with no older history, so a base
// without VERSION — the empty commit before the import — takes that version
// alone, with its changelog entry, and nothing else.
export const IMPORTED_VERSION = '1.19.5';

// MAJOR.MINOR.PATCH, each part a decimal number without a leading zero.
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Whether `next` may follow `before`, each `[major, minor, patch]` as BigInts:
// the next patch, the next minor with patch zero, or the next major with minor
// and patch zero (D233). A new major is allowed here like the other two steps;
// whether to release one is not this check's to decide.
function follows(before, next) {
  const [major, minor, patch] = before;
  const [nextMajor, nextMinor, nextPatch] = next;
  return (
    (nextMajor === major + 1n && nextMinor === 0n && nextPatch === 0n) ||
    (nextMajor === major && nextMinor === minor + 1n && nextPatch === 0n) ||
    (nextMajor === major && nextMinor === minor && nextPatch === patch + 1n)
  );
}

export function checkVersion({ previous, current, paths, changelog }) {
  const parse = (value) => {
    const match = typeof value === 'string' ? versionPattern.exec(value) : null;
    if (!match) throw new Error(`Invalid product version: ${value}`);
    return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
  };
  const next = parse(current);
  const runtimeChanged = paths.some(isRuntimePath);
  if (previous === null) {
    if (current !== IMPORTED_VERSION) {
      throw new Error(
        `A base without VERSION takes only the import, at ${IMPORTED_VERSION}, where this repository starts`,
      );
    }
  } else {
    const before = parse(previous);
    if (current === previous) {
      if (runtimeChanged) throw new Error('Runtime changes require a VERSION bump');
      return;
    }
    if (!follows(before, next)) {
      throw new Error(
        'Use the next patch, the next minor (patch zero) or the next major (minor and patch zero); never reuse, skip or decrease a version',
      );
    }
  }
  if (!changelog.split('\n').some((line) => line === `## ${current}`)) {
    throw new Error(`CHANGELOG.md needs an entry for ${current}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2];
  if (!base) throw new Error('Usage: node scripts/check-version.mjs <base-commit>');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const resolved = git('rev-parse', '--verify', `${base}^{commit}`);
  // An unavailable base must fail, not masquerade as the start of the repository.
  const hasVersion = git('ls-tree', '--name-only', resolved, '--', 'VERSION') === 'VERSION';
  checkVersion({
    previous: hasVersion ? git('show', `${resolved}:VERSION`) : null,
    current: readFileSync('VERSION', 'utf8').trim(),
    paths: git('diff', '--name-only', '--no-renames', resolved, 'HEAD').split('\n'),
    changelog: readFileSync('CHANGELOG.md', 'utf8'),
  });
  console.log('Product version and changelog checked');
}
