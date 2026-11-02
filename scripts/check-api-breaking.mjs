// The API breaking-change check (#146, D219): `delivery-checks` runs
// `node scripts/check-api-breaking.mjs "$DELIVERY_BASE"` right after
// `check-version.mjs`, on merge request and main pipelines alike. It compares
// `packages/shared/openapi.json` with the same file at the base and fails when
// the difference breaks a client and the version does not declare it.
//
// - The comparison is oasdiff's (`oasdiff breaking <base> <head> --format
//   json`), the release `delivery-checks` pins by version and SHA-256. An entry
//   of level ERR is a breaking difference; a WARN entry is printed as a note
//   and never fails. A missing oasdiff, an exit other than 0, a run that does
//   not end within `OASDIFF_TIMEOUT_MS` or output that does not read as
//   oasdiff's changes fails as "could not compare": never a silent pass.
// - `RAISED_CHECKS` makes ERR four checks oasdiff rates lower and D184
//   counts as breaking in this API, each with its reason; `LOWERED_CHECKS`
//   makes WARN one it rates ERR, a new value of an answer's enum, which D248
//   announced as an addition, with its reason. oasdiff gets both as its
//   `--severity-levels` file.
// - oasdiff runs in an empty temporary directory, on copies of both files and
//   without `OASDIFF_CONFIG`, so no `.oasdiff.*` file of the checkout and no
//   variable of the job changes what it reports, and with
//   `--allow-external-refs=false`, so the description reads nothing but itself.
// - In the copies an operation marked `x-stability-level: experimental`, or
//   left unmarked under a path marked so, is marked `alpha`, the level oasdiff
//   leaves out of breaking detection; oasdiff knows only draft, alpha, beta and
//   stable and reports `experimental` as an error (D212, D219).
// - In the copies every `description` is blanked (`withoutDescriptions`): no
//   check of oasdiff's reads one, and oasdiff tells the inline members of a
//   `oneOf` apart by their whole content, descriptions included, so a
//   schema's reworded description, referenced inside one, read as members
//   removed and others added, `response-property-one-of-added`, an ERR
//   (#227, D253). Blanked rather than removed, so a response keeps the
//   `description` OpenAPI requires of it.
// - Declared means: `VERSION` differs from the base's and the `## <VERSION>`
//   entry of `CHANGELOG.md`, read by the parser `/changelog` and the breaking
//   feed use, has a `**Breaking:**` paragraph. A Breaking paragraph of an
//   older entry, or with the version unchanged, declares nothing.
// - A description missing at the base passes, with nothing to compare; one
//   missing in the checkout fails.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { parseChangelog } from '../apps/frontend/scripts/changelog.mjs';

export const SPEC_PATH = 'packages/shared/openapi.json';

/** oasdiff's levels in its JSON output: `level` 3 is ERR, 2 WARN, 1 INFO. */
export const LEVEL_ERR = 3;
export const LEVEL_WARN = 2;
export const LEVEL_INFO = 1;

/** How long one oasdiff run may take; it compares this description in well under a second. */
export const OASDIFF_TIMEOUT_MS = 120_000;

/**
 * The checks raised to ERR for this API (D219), by oasdiff's check id, each
 * with the reason D184 counts it as breaking where oasdiff's default does not:
 * a removed request property or parameter is WARN by default, a removed
 * optional answer field or optional response header INFO, which
 * `oasdiff breaking` does not print at all.
 */
export const RAISED_CHECKS = new Map([
  [
    'request-property-removed',
    'every request body is closed (additionalProperties: false), so a request that still sends the property is refused 400 / 1005',
  ],
  [
    'request-parameter-removed',
    'an unknown query parameter is refused 400 / 1013, so a request that still sends it fails; an unknown header or cookie parameter is not refused, yet a request that still sends one may get another answer once the server stops reading it, so its removal needs the same Breaking paragraph',
  ],
  [
    'response-optional-property-removed',
    'a field of an answer is removed, which D184 counts as breaking whether or not it is always present',
  ],
  [
    'optional-response-header-removed',
    "a client may read the header, such as Retry-After or a rate-limit header, so D184 counts its removal as breaking, as it does an answer field's; every response header of this description is optional",
  ],
]);

/**
 * The checks lowered to WARN for this API (D248), by oasdiff's check id, each
 * with its reason: the change is printed as a note and never fails.
 */
export const LOWERED_CHECKS = new Map([
  [
    'response-property-enum-value-added',
    "a new value of an enum in an answer, such as a response's state, is an addition from the date D248 announced, as a new field is; before that date it is a breaking change without notice, which the Reviewer reports, and the check reads no date, so that one commit always gets one verdict",
  ],
]);

/**
 * `RAISED_CHECKS` and then `LOWERED_CHECKS` as oasdiff reads a
 * `--severity-levels` file: `<check id> err` and `<check id> warn` per line.
 */
export const SEVERITY_LEVELS = [
  ...[...RAISED_CHECKS.keys()].map((id) => `${id} err\n`),
  ...[...LOWERED_CHECKS.keys()].map((id) => `${id} warn\n`),
].join('');

/** The arguments after the two file names, the same on every run. */
export const OASDIFF_FLAGS = [
  '--format',
  'json',
  '--allow-external-refs=false',
  '--severity-levels',
  'levels.txt',
];

// Generous for the files and the output, so that size alone never turns a
// comparison into an error; output beyond it fails as "could not compare".
const MAX_BUFFER = 256 * 1024 * 1024;

const OPERATIONS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const STABILITY = 'x-stability-level';

/** Why the two descriptions could not be compared: the check fails, never passes. */
export class CouldNotCompare extends Error {}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Marks as `alpha` every operation of a parsed description that is
 * experimental: its own `x-stability-level` is `experimental`, or it has none
 * and its path's is. Rewrites the object it is given, a copy read for the
 * comparison, and returns it; anything that is not a description is returned
 * as it is, for oasdiff to refuse.
 */
export function markExperimentalAsAlpha(spec) {
  if (!isObject(spec) || !isObject(spec.paths)) return spec;
  for (const item of Object.values(spec.paths)) {
    if (!isObject(item)) continue;
    const pathExperimental = item[STABILITY] === 'experimental';
    if (pathExperimental) item[STABILITY] = 'alpha';
    for (const method of OPERATIONS) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      if (operation[STABILITY] === 'experimental') operation[STABILITY] = 'alpha';
      else if (pathExperimental && !Object.hasOwn(operation, STABILITY)) {
        operation[STABILITY] = 'alpha';
      }
    }
  }
  return spec;
}

/** Keys whose value is data a client sends or reads, never an annotation to remove. */
const DATA_KEYS = new Set(['default', 'const', 'enum', 'example', 'examples']);

/**
 * Blanks every `description` whose value is a string in a parsed
 * description, at any depth, and returns it: the annotation of the
 * description itself, of an operation, a parameter, a response, a header and
 * a schema, each made `''`. A property named `description`, whose value is a
 * schema, stays as it is, and nothing under `default`, `const`, `enum`,
 * `example`, `examples` or an `x-` extension is touched. Rewrites the object
 * it is given, a copy read for the comparison, with a stack rather than
 * recursion, so a nesting of any depth is walked whole; anything that is not
 * a description is returned as it is, for oasdiff to refuse.
 */
export function withoutDescriptions(spec) {
  const pending = [spec];

  while (pending.length > 0) {
    const value = pending.pop();

    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (isObject(value)) {
      if (typeof value.description === 'string') value.description = '';
      for (const [key, inner] of Object.entries(value)) {
        if (!DATA_KEYS.has(key) && !key.startsWith('x-')) pending.push(inner);
      }
    }
  }

  return spec;
}

/**
 * Reads oasdiff's `--format json` output into the breaking differences (ERR)
 * and the notes (WARN, and INFO should it ever appear). Anything else — text
 * that is not JSON, not an array, an entry without a known level or without
 * its id and text — throws `CouldNotCompare`.
 */
export function readChanges(output) {
  let changes;
  try {
    changes = JSON.parse(output);
  } catch {
    throw new CouldNotCompare('oasdiff printed output that is not JSON');
  }
  if (!Array.isArray(changes)) {
    throw new CouldNotCompare('oasdiff printed JSON that is not a list of changes');
  }
  const breaking = [];
  const notes = [];
  changes.forEach((change, index) => {
    const known =
      isObject(change) &&
      [LEVEL_ERR, LEVEL_WARN, LEVEL_INFO].includes(change.level) &&
      typeof change.id === 'string' &&
      typeof change.text === 'string' &&
      ['operation', 'path'].every(
        (key) => change[key] === undefined || typeof change[key] === 'string',
      );
    if (!known) {
      throw new CouldNotCompare(`oasdiff printed entry ${index + 1} that is not a change`);
    }
    (change.level === LEVEL_ERR ? breaking : notes).push(change);
  });
  return { breaking, notes };
}

// A control character in oasdiff's text (C0, DEL and C1, `\p{Cc}`), such as a
// line break or an escape sequence, and a line or paragraph separator, is
// shown as an escape, so that one difference stays one line of the job's log.
const printable = (text) =>
  text.replace(
    /[\p{Cc}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/** One difference in plain words: `METHOD /path: <text> (<check id>)`. */
export function describeChange(change) {
  const where = [change.operation, change.path].filter((part) => part !== undefined).join(' ');
  const text = where === '' ? change.text : `${where}: ${change.text}`;
  return printable(`${text} (${change.id})`);
}

/**
 * Whether the version declares a breaking change: it differs from the base's
 * and its own entry, as `parseChangelog` reads it, has a Breaking paragraph.
 */
export function isDeclared({ previousVersion, currentVersion, changelog }) {
  if (previousVersion === currentVersion) return false;
  const entry = parseChangelog(changelog).find((item) => item.version === currentVersion);
  return entry?.breaking === true;
}

/**
 * The verdict on oasdiff's changes: `{ ok, lines }`, the lines to print in
 * order. Breaking differences fail unless the version declares them; notes
 * never fail. The changelog is read only when there is a breaking difference.
 */
export function judge({ breaking, notes, previousVersion, currentVersion, changelog, base }) {
  const lines = [];
  const list = (title, changes) => {
    if (changes.length === 0) return;
    lines.push(title, ...changes.map((change) => `  ${describeChange(change)}`));
  };
  list(`Notes, which never fail (WARN), against ${base}:`, notes);
  if (breaking.length === 0) {
    lines.push(`No breaking difference in ${SPEC_PATH} against ${base}`);
    return { ok: true, lines };
  }
  list(`Breaking differences in ${SPEC_PATH} against ${base}:`, breaking);
  let declared;
  try {
    declared = isDeclared({ previousVersion, currentVersion, changelog });
  } catch (error) {
    lines.push(`Could not read the declaration from CHANGELOG.md: ${printable(error.message)}`);
    return { ok: false, lines };
  }
  if (declared) {
    lines.push(
      `Declared by the **Breaking:** paragraph of the ${currentVersion} entry of CHANGELOG.md`,
    );
    return { ok: true, lines };
  }
  if (previousVersion === currentVersion) {
    lines.push(
      `VERSION is ${currentVersion}, as at the base: bump it, then add a **Breaking:** paragraph to the new version's entry of CHANGELOG.md, or make the change additive`,
    );
  } else {
    lines.push(
      `Not declared: add a **Breaking:** paragraph to the ${currentVersion} entry of CHANGELOG.md, or make the change additive`,
    );
  }
  return { ok: false, lines };
}

/**
 * Compares two descriptions given as text with oasdiff from `PATH` and returns
 * `{ breaking, notes }`; throws `CouldNotCompare` when that cannot be done.
 */
export function compareSpecs({
  baseText,
  headText,
  env = process.env,
  timeoutMs = OASDIFF_TIMEOUT_MS,
}) {
  const read = (text, name) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new CouldNotCompare(`the ${name} description is not JSON`);
    }
  };
  const base = withoutDescriptions(markExperimentalAsAlpha(read(baseText, 'base')));
  const head = withoutDescriptions(markExperimentalAsAlpha(read(headText, 'current')));

  const directory = mkdtempSync(join(tmpdir(), 'qa-api-breaking-'));
  try {
    writeFileSync(join(directory, 'base.json'), JSON.stringify(base));
    writeFileSync(join(directory, 'head.json'), JSON.stringify(head));
    writeFileSync(join(directory, 'levels.txt'), SEVERITY_LEVELS);
    const cleanEnv = { ...env };
    delete cleanEnv.OASDIFF_CONFIG;
    const result = spawnSync('oasdiff', ['breaking', 'base.json', 'head.json', ...OASDIFF_FLAGS], {
      cwd: directory,
      env: cleanEnv,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error?.code === 'ENOENT') {
      throw new CouldNotCompare('oasdiff is not installed (not found on PATH)');
    }
    if (result.error?.code === 'ETIMEDOUT') {
      throw new CouldNotCompare(`oasdiff did not finish within ${timeoutMs / 1000} s`);
    }
    if (result.error) throw new CouldNotCompare(`oasdiff could not run: ${result.error.message}`);
    if (result.status !== 0) {
      const said = printable(result.stderr.trim().slice(0, 2000));
      const how = result.signal ? `was stopped by ${result.signal}` : `exited ${result.status}`;
      throw new CouldNotCompare(`oasdiff ${how}${said === '' ? '' : `: ${said}`}`);
    }
    return readChanges(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2];
  if (!base) throw new Error('Usage: node scripts/check-api-breaking.mjs <base-commit>');
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', maxBuffer: MAX_BUFFER }).trim();
  // An unavailable base fails here, as in check-version.mjs.
  const resolved = git('rev-parse', '--verify', `${base}^{commit}`);
  const short = resolved.slice(0, 12);
  const has = (path) => git('ls-tree', '--name-only', resolved, '--', path) === path;

  if (!existsSync(SPEC_PATH)) {
    console.error(`Could not compare: ${SPEC_PATH} is missing from this checkout`);
    process.exitCode = 1;
  } else if (!has(SPEC_PATH)) {
    console.log(`${SPEC_PATH} does not exist at ${short}: nothing to compare`);
  } else {
    try {
      const { breaking, notes } = compareSpecs({
        baseText: git('show', `${resolved}:${SPEC_PATH}`),
        headText: readFileSync(SPEC_PATH, 'utf8'),
      });
      const { ok, lines } = judge({
        breaking,
        notes,
        previousVersion: has('VERSION') ? git('show', `${resolved}:VERSION`) : null,
        currentVersion: readFileSync('VERSION', 'utf8').trim(),
        changelog: readFileSync('CHANGELOG.md', 'utf8'),
        base: short,
      });
      // One stream per verdict, so the lines keep their order in the job's log.
      for (const line of lines) {
        if (ok) console.log(line);
        else console.error(line);
      }
      if (!ok) process.exitCode = 1;
    } catch (error) {
      if (!(error instanceof CouldNotCompare)) throw error;
      console.error(`Could not compare ${SPEC_PATH} with ${short}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
