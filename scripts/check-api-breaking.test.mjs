// The API breaking-change check, `scripts/check-api-breaking.mjs` (#146,
// D219). Pure cases for what it reads and decides; command-line runs on
// throwaway git repositories against a stand-in `oasdiff` on PATH, which
// records how it was called; and runs against the real oasdiff, which
// `delivery-checks` downloads at the pinned version and checksum. Without
// oasdiff on a developer's machine the real cases are skipped (put it on PATH
// or name it in OASDIFF_BIN); with CI set they are required, as the real-gpg
// case of `db-backup.test.mjs` is. The job's own lines are read from
// `.gitlab/ci/validate.yml`, where the validate stage lives (D241), and
// compared whole, as plain text.

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  CouldNotCompare,
  compareSpecs,
  describeChange,
  isDeclared,
  judge,
  LEVEL_ERR,
  LEVEL_INFO,
  LEVEL_WARN,
  LOWERED_CHECKS,
  markExperimentalAsAlpha,
  OASDIFF_FLAGS,
  OASDIFF_TIMEOUT_MS,
  RAISED_CHECKS,
  readChanges,
  SEVERITY_LEVELS,
  SPEC_PATH,
  withoutDescriptions,
} from './check-api-breaking.mjs';

const { structuredClone } = globalThis;
const root = process.cwd();
const SCRIPT = join(root, 'scripts', 'check-api-breaking.mjs');
const read = (path) => readFileSync(join(root, path), 'utf8');

// The real executable of that name on PATH.
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
const REAL_GIT = which('git');
const REAL_OASDIFF = process.env.OASDIFF_BIN || which('oasdiff');
const real = { skip: !REAL_OASDIFF && !process.env.CI ? 'oasdiff is not installed' : false };
const requireReal = () =>
  assert.ok(REAL_OASDIFF, 'oasdiff is required in CI: delivery-checks installs it');

// Directories of their own on PATH: one with the real oasdiff under its name,
// one with a stand-in, one with git alone, so a run can lack oasdiff.
const scratch = mkdtempSync(join(tmpdir(), 'qa-api-check-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const REAL_DIR = join(scratch, 'real-bin');
const STANDIN_DIR = join(scratch, 'standin-bin');
const GIT_ONLY_DIR = join(scratch, 'git-only-bin');
for (const dir of [REAL_DIR, STANDIN_DIR, GIT_ONLY_DIR]) mkdirSync(dir);
if (REAL_OASDIFF) symlinkSync(REAL_OASDIFF, join(REAL_DIR, 'oasdiff'));
symlinkSync(REAL_GIT, join(GIT_ONLY_DIR, 'git'));

// The stand-in: records its working directory, whether OASDIFF_CONFIG reached
// it, its arguments, the files beside it and copies of them, then prints the
// prepared output and exits as told.
writeFileSync(
  join(STANDIN_DIR, 'oasdiff'),
  `#!/bin/sh
state="$STANDIN_STATE"
{
  printf 'cwd=%s\\n' "$PWD"
  printf 'config=%s\\n' "\${OASDIFF_CONFIG-unset}"
  for arg in "$@"; do printf 'arg=%s\\n' "$arg"; done
  for file in * .*; do [ -f "$file" ] && printf 'file=%s\\n' "$file"; done
} > "$state/calls"
for file in base.json head.json levels.txt; do
  [ -f "$file" ] && cp "$file" "$state/seen-$file"
done
[ -n "$STANDIN_STDERR" ] && printf '%s\\n' "$STANDIN_STDERR" >&2
[ "$STANDIN_HANG" = 1 ] && exec sleep 30
[ -f "$state/output" ] && cat "$state/output"
exit "\${STANDIN_EXIT:-0}"
`,
  { mode: 0o755 },
);

// ---------------------------------------------------------------------------
// Fixtures

/** A changelog whose entries, newest first, are `[version, breaking?, deprecated?]`. */
function changelogOf(entries) {
  const header = '# Changes\n\nThe repository-only header.\n\n';
  return (
    header +
    entries
      .map(
        ([version, breaking = false, deprecated = false]) =>
          `## ${version}\n\n2026-10-10\n\n**What ${version} changed.** For users.\n\n` +
          (breaking ? '**Breaking:** a client that relied on it breaks.\n\n' : '') +
          (deprecated ? '**Deprecated:** something, removed on 2026-12-01.\n\n' : ''),
      )
      .join('')
  );
}

// A small OpenAPI 3.1 description with the 3.1 forms the real one uses
// (`type` arrays, `const`, `prefixItems`), closed request bodies, an optional
// query parameter and an optional answer field; an optional header and cookie
// parameter, an optional response header, a request enum (`include`, `order`)
// and two answer enums, one a property and one inside an array item.
const FIXTURE = {
  openapi: '3.1.0',
  info: { title: 'Fixture', version: '0.52.0' },
  paths: {
    '/api/sessions': {
      post: {
        operationId: 'createSession',
        requestBody: {
          required: false,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateSessionRequest' } },
          },
        },
        responses: {
          201: {
            description: 'Created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreatedSession' } },
            },
          },
        },
      },
    },
    '/api/sessions/{sessionId}': {
      parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getSession',
        parameters: [
          {
            name: 'include',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['headers', 'body'] },
          },
          { name: 'X-Trace', in: 'header', required: false, schema: { type: 'string' } },
          { name: 'theme', in: 'cookie', required: false, schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'The session',
            headers: { 'X-Request-Id': { schema: { type: 'string' } } },
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreatedSession' } },
            },
          },
        },
      },
      delete: { operationId: 'deleteSession', responses: { 204: { description: 'Deleted' } } },
    },
  },
  components: {
    schemas: {
      CreateSessionRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          response: { type: 'object' },
          queue: { type: ['object', 'null'] },
          order: { type: 'string', enum: ['asc', 'desc'] },
        },
      },
      CreatedSession: {
        type: 'object',
        required: ['id', 'expiresAt', 'kind'],
        properties: {
          id: { type: 'string' },
          expiresAt: { type: 'string', format: 'date-time' },
          kind: { const: 'session' },
          pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }] },
          note: { type: 'string' },
          state: { type: 'string', enum: ['active', 'expired'] },
          history: { type: 'array', items: { type: 'string', enum: ['created', 'used'] } },
        },
      },
    },
  },
};
const fixture = (change) => {
  const spec = structuredClone(FIXTURE);
  change?.(spec);
  return spec;
};

// The changes the acceptance criteria name, each made alone on the fixture.
const SESSION = '/api/sessions/{sessionId}';
const removeRequiredAnswerField = (spec) => {
  delete spec.components.schemas.CreatedSession.properties.expiresAt;
  spec.components.schemas.CreatedSession.required = ['id', 'kind'];
};
const removeOperation = (spec) => delete spec.paths[SESSION].delete;
const requireOptionalRequestField = (spec) => {
  spec.components.schemas.CreateSessionRequest.required = ['response'];
};
const removeOptionalHeader = (spec) => {
  delete spec.paths[SESSION].get.responses[200].headers['X-Request-Id'];
};

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

/**
 * A throwaway repository whose first commit, the base, holds `VERSION`,
 * `CHANGELOG.md` and the description; `change()` commits the next state. A
 * `spec` of `null` leaves the description out.
 */
function repository(t, { spec = fixture(), version = '0.52.0', changelog } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'qa-api-check-repo-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  git(work, 'init', '--quiet', '--initial-branch=main');
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Test');
  const write = (state) => {
    writeFileSync(join(work, 'VERSION'), `${state.version}\n`);
    writeFileSync(join(work, 'CHANGELOG.md'), state.changelog ?? changelogOf([[state.version]]));
    const file = join(work, SPEC_PATH);
    rmSync(file, { force: true });
    if (typeof state.spec === 'string') {
      mkdirSync(join(work, 'packages', 'shared'), { recursive: true });
      writeFileSync(file, state.spec);
    } else if (state.spec !== null) {
      mkdirSync(join(work, 'packages', 'shared'), { recursive: true });
      writeFileSync(file, `${JSON.stringify(state.spec, null, 2)}\n`);
    }
  };
  write({ spec, version, changelog });
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'base');
  const base = git(work, 'rev-parse', 'HEAD');
  return {
    work,
    base,
    short: base.slice(0, 12),
    change(state) {
      write({ spec, version, changelog, ...state });
      git(work, 'add', '-A');
      git(work, 'commit', '--quiet', '--allow-empty', '-m', 'head');
    },
  };
}

/** Runs the command line in a repository with `dirs` first on PATH. */
function check(work, base, { dirs = [STANDIN_DIR], env = {}, path } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...(base === undefined ? [] : [base])], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      PATH: path ?? [...dirs, process.env.PATH].join(':'),
      ...env,
    },
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

/** A fresh state directory for the stand-in, with what it should print. */
function standin(t, { output = '[]', exit = 0, stderr = '', hang = false } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'qa-api-check-standin-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  if (output !== null) writeFileSync(join(state, 'output'), output);
  return {
    state,
    env: {
      STANDIN_STATE: state,
      STANDIN_EXIT: String(exit),
      STANDIN_STDERR: stderr,
      STANDIN_HANG: hang ? '1' : '0',
      OASDIFF_CONFIG: join(state, 'must-not-be-read.yaml'),
    },
    calls: () =>
      existsSync(join(state, 'calls')) ? readFileSync(join(state, 'calls'), 'utf8') : null,
    seen: (name) => readFileSync(join(state, `seen-${name}`), 'utf8'),
  };
}

const change = (overrides = {}) => ({
  id: 'api-removed-without-deprecation',
  text: 'api removed without deprecation',
  level: LEVEL_ERR,
  operation: 'DELETE',
  path: '/api/sessions/{sessionId}',
  ...overrides,
});

const LS = String.fromCharCode(0x2028);

// ---------------------------------------------------------------------------
// Pure cases

test('an experimental operation, or an unmarked one under an experimental path, is marked alpha; nothing else changes', () => {
  const spec = {
    openapi: '3.1.0',
    paths: {
      '/own': {
        get: { 'x-stability-level': 'experimental' },
        post: { 'x-stability-level': 'beta' },
        put: {},
      },
      '/whole': {
        'x-stability-level': 'experimental',
        parameters: [{ name: 'id', in: 'path' }],
        summary: 'kept',
        get: {},
        delete: { 'x-stability-level': 'stable' },
        trace: { 'x-stability-level': 'experimental' },
      },
      '/stable': { 'x-stability-level': 'stable', get: {} },
    },
    components: { schemas: { A: { 'x-stability-level': 'experimental' } } },
  };
  const result = markExperimentalAsAlpha(spec);
  assert.equal(result, spec, 'the copy it is given is rewritten and returned');
  assert.deepEqual(spec.paths, {
    '/own': {
      get: { 'x-stability-level': 'alpha' },
      post: { 'x-stability-level': 'beta' },
      put: {},
    },
    '/whole': {
      'x-stability-level': 'alpha',
      parameters: [{ name: 'id', in: 'path' }],
      summary: 'kept',
      get: { 'x-stability-level': 'alpha' },
      delete: { 'x-stability-level': 'stable' },
      trace: { 'x-stability-level': 'alpha' },
    },
    '/stable': { 'x-stability-level': 'stable', get: {} },
  });
  assert.deepEqual(spec.components, {
    schemas: { A: { 'x-stability-level': 'experimental' } },
  });
  // Every method OpenAPI 3.1 has, and nothing that only looks like one.
  const all = { 'x-stability-level': 'experimental' };
  for (const key of [
    'get',
    'put',
    'post',
    'delete',
    'options',
    'head',
    'patch',
    'trace',
    'query',
  ]) {
    all[key] = {};
  }
  markExperimentalAsAlpha({ paths: { '/all': all } });
  for (const key of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
    assert.deepEqual(all[key], { 'x-stability-level': 'alpha' }, key);
  }
  assert.deepEqual(all.query, {});
});

test('a description of any shape is returned for oasdiff to judge, never thrown on', () => {
  for (const value of [null, undefined, 0, 'text', [], [{}], true]) {
    assert.equal(markExperimentalAsAlpha(value), value);
  }
  for (const paths of [null, 'x', 3, [], [{ get: {} }]]) {
    const spec = { paths };
    assert.deepEqual(markExperimentalAsAlpha(spec), { paths });
  }
  const odd = {
    paths: {
      '/null': null,
      '/array': [{ 'x-stability-level': 'experimental' }],
      '/number': 7,
      '/ops': {
        'x-stability-level': 'experimental',
        get: null,
        put: 'experimental',
        post: [],
        delete: { 'x-stability-level': ['experimental'] },
        patch: { 'x-stability-level': null },
      },
    },
  };
  const before = structuredClone(odd);
  markExperimentalAsAlpha(odd);
  before.paths['/ops']['x-stability-level'] = 'alpha';
  assert.deepEqual(odd, before, 'only the path-level mark of /ops changes');
});

// The growth cases run at one size each, the largest, which is the one that
// would show slow or recursive code; every kind of input stays (D219 item 10).
test('every string description is blanked at any depth, and nothing else: a property named description, data and extensions stay (#227, D253)', () => {
  const spec = {
    info: { title: 'T', description: 'The API.' },
    paths: {
      '/a': {
        description: 'A path.',
        get: {
          description: 'An operation.',
          parameters: [{ name: 'q', in: 'query', description: 'A parameter.', schema: {} }],
          responses: {
            200: {
              description: 'OK',
              headers: { 'X-A': { description: 'A header.', schema: { type: 'string' } } },
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { type: 'object', description: 'Deep.', properties: { id: { $ref: '#/x' } } },
                      { type: 'null' },
                    ],
                  },
                  examples: { one: { description: 'kept', value: { description: 'kept' } } },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Thing: {
          type: 'object',
          description: 'A thing.',
          properties: {
            description: { type: 'string', description: 'Its own description.' },
            other: {
              type: 'string',
              default: { description: 'kept' },
              enum: [{ description: 'kept' }],
            },
          },
          'x-note': { description: 'kept' },
          const: { description: 'kept' },
          example: { description: 'kept' },
        },
      },
    },
  };
  const blanked = withoutDescriptions(structuredClone(spec));
  const operation = blanked.paths['/a'].get;
  const response = operation.responses[200];
  const thing = blanked.components.schemas.Thing;

  for (const value of [
    blanked.info.description,
    blanked.paths['/a'].description,
    operation.description,
    operation.parameters[0].description,
    response.description,
    response.headers['X-A'].description,
    response.content['application/json'].schema.oneOf[0].description,
    thing.description,
    thing.properties.description.description,
  ]) {
    assert.equal(value, '');
  }

  // The property named description is a schema, and stays one.
  assert.equal(thing.properties.description.type, 'string');
  assert.deepEqual(response.content['application/json'].examples, {
    one: { description: 'kept', value: { description: 'kept' } },
  });
  assert.deepEqual(thing.properties.other.default, { description: 'kept' });
  assert.deepEqual(thing.properties.other.enum, [{ description: 'kept' }]);
  assert.deepEqual(thing['x-note'], { description: 'kept' });
  assert.deepEqual(thing.const, { description: 'kept' });
  assert.deepEqual(thing.example, { description: 'kept' });

  // What is not a description is returned as it is.
  for (const value of [null, 'text', 7, [1, 2]]) {
    assert.deepEqual(withoutDescriptions(structuredClone(value)), value);
  }

  // A nesting of any depth is walked whole, without recursion.
  let deep = { description: 'bottom' };
  const bottom = deep;
  for (let depth = 0; depth < 100_000; depth += 1) deep = { items: deep, description: 'level' };
  withoutDescriptions(deep);
  assert.equal(deep.description, '');
  assert.equal(bottom.description, '');
});

test(
  'a schema’s reworded description, referenced inside an inline oneOf of an answer, is no breaking difference; a member added still is (#227, D253)',
  real,
  (t) => {
    requireReal();
    const withOneOf = (description, members = []) =>
      fixture((spec) => {
        spec.components.schemas.Id = { type: 'string', description };
        spec.components.schemas.CreatedSession.properties.status = {
          // Two members that reference it: oasdiff pairs one member left
          // over on each side and diffs the two, but not two or more.
          oneOf: [
            {
              type: 'object',
              properties: { id: { $ref: '#/components/schemas/Id' }, state: { const: 'a' } },
            },
            {
              type: 'object',
              properties: { id: { $ref: '#/components/schemas/Id' }, state: { const: 'b' } },
            },
            ...members,
          ],
        };
      });
    const env = { ...process.env, PATH: `${REAL_DIR}:${process.env.PATH}` };

    // oasdiff alone reads the reworded description as members removed and
    // others added, which is what the blanked copies prevent.
    const directory = mkdtempSync(join(tmpdir(), 'qa-api-oneof-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, 'base.json'), JSON.stringify(withOneOf('The only key.')));
    writeFileSync(join(directory, 'head.json'), JSON.stringify(withOneOf('One of two keys.')));
    const plain = spawnSync('oasdiff', ['breaking', 'base.json', 'head.json', '--format', 'json'], {
      cwd: directory,
      env,
      encoding: 'utf8',
    });
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /response-property-one-of-added/);

    const reworded = compareSpecs({
      baseText: JSON.stringify(withOneOf('The only key.')),
      headText: JSON.stringify(withOneOf('One of two keys.')),
      env,
    });
    assert.deepEqual(reworded, { breaking: [], notes: [] });

    const added = compareSpecs({
      baseText: JSON.stringify(withOneOf('The only key.')),
      headText: JSON.stringify(withOneOf('One of two keys.', [{ type: 'string' }])),
      env,
    });
    // Once for each answer that carries the schema: POST's 201 and GET's 200.
    assert.deepEqual(
      added.breaking.map((item) => item.id),
      ['response-property-one-of-added', 'response-property-one-of-added'],
    );
  },
);

test('a description of 100,000 experimental paths, marked by path and by operation, is rewritten whole', () => {
  const paths = {};
  for (let index = 0; index < 100_000; index += 1) {
    paths[`/p${index}`] =
      index % 2 === 0
        ? { 'x-stability-level': 'experimental', get: {} }
        : { get: { 'x-stability-level': 'experimental' } };
  }
  markExperimentalAsAlpha({ paths });
  for (const item of Object.values(paths)) {
    assert.equal(item.get['x-stability-level'], 'alpha');
  }
});

test('oasdiff’s output is read into breaking differences (ERR) and notes (WARN, INFO)', () => {
  const err = change();
  const warn = change({ id: 'request-property-removed', level: LEVEL_WARN });
  const info = change({ id: 'endpoint-added', level: LEVEL_INFO });
  delete info.operation;
  const component = { id: 'x', text: 'no operation or path', level: LEVEL_ERR };
  assert.deepEqual(readChanges('[]'), { breaking: [], notes: [] });
  assert.deepEqual(readChanges(JSON.stringify([warn, err, info, component])), {
    breaking: [err, component],
    notes: [warn, info],
  });
  // The fields oasdiff 1.33.0 adds are kept and ignored.
  const full = { ...err, operationId: 'x', section: 'paths', fingerprint: 'f', baseSource: {} };
  assert.deepEqual(readChanges(JSON.stringify([full])).breaking, [full]);
});

test('output that is not oasdiff’s changes cannot be compared, and says which entry', () => {
  const refused = [
    ['', 'not JSON'],
    ['Error: failed to load base spec', 'not JSON'],
    ['[{"id": "x",', 'not JSON'],
    ['{}', 'not a list of changes'],
    ['null', 'not a list of changes'],
    ['"[]"', 'not a list of changes'],
    ['3', 'not a list of changes'],
    ['[null]', 'entry 1 that is not a change'],
    ['[[]]', 'entry 1 that is not a change'],
    ['["x"]', 'entry 1 that is not a change'],
  ];
  for (const [bad, field] of [
    [{ level: undefined }, 'no level'],
    [{ level: '3' }, 'a level as text'],
    [{ level: 4 }, 'an unknown level'],
    [{ level: 0 }, 'level 0'],
    [{ level: 2.5 }, 'a fraction'],
    [{ id: undefined }, 'no id'],
    [{ id: 3 }, 'a numeric id'],
    [{ text: undefined }, 'no text'],
    [{ text: {} }, 'an object text'],
    [{ operation: 3 }, 'a numeric operation'],
    [{ path: ['/a'] }, 'a list as path'],
  ]) {
    refused.push([JSON.stringify([change(), change(bad)]), 'entry 2 that is not a change', field]);
  }
  for (const [output, message, label] of refused) {
    assert.throws(
      () => readChanges(output),
      (error) => error instanceof CouldNotCompare && error.message.includes(message),
      label ?? output,
    );
  }
});

test('output of 100,000 changes, a 1,000,000-character text and 1,000,000 nested lists are read or refused whole', () => {
  const changes = Array.from({ length: 100_000 }, (_, index) =>
    change({ level: index % 2 === 0 ? LEVEL_ERR : LEVEL_WARN, path: `/p${index}` }),
  );
  const { breaking, notes } = readChanges(JSON.stringify(changes));
  assert.equal(breaking.length, 50_000);
  assert.equal(notes.length, 50_000);
  const long = 'x'.repeat(1_000_000);
  assert.equal(readChanges(JSON.stringify([change({ text: long })])).breaking[0].text, long);
  const nested = `${'['.repeat(1_000_000)}${']'.repeat(1_000_000)}`;
  assert.throws(() => readChanges(nested), CouldNotCompare);
  assert.throws(() => readChanges('['.repeat(1_000_000)), CouldNotCompare);
  assert.throws(() => readChanges(`[${'"x",'.repeat(100_000)}"x"]`), CouldNotCompare);
});

test('a difference reads `METHOD /path: <text> (<check id>)`, always on one line', () => {
  assert.equal(
    describeChange(change()),
    'DELETE /api/sessions/{sessionId}: api removed without deprecation (api-removed-without-deprecation)',
  );
  assert.equal(
    describeChange({ id: 'x', text: 'without a place', level: LEVEL_ERR }),
    'without a place (x)',
  );
  assert.equal(
    describeChange(change({ operation: undefined })),
    '/api/sessions/{sessionId}: api removed without deprecation (api-removed-without-deprecation)',
  );
  // A line break, an escape sequence, a C1 control and a line separator in
  // oasdiff's text, its path or its id stay visible as escapes.
  const hostile = change({
    text: `first\nsecond\r\u001b[31mred\u0085${LS}end`,
    path: '/a\nFAKE: line',
    id: 'id\u0000',
  });
  assert.equal(
    describeChange(hostile),
    'DELETE /a\\u000aFAKE: line: first\\u000asecond\\u000d\\u001b[31mred\\u0085\\u2028end (id\\u0000)',
  );
  // A 1,000,000-character difference, the one size, the largest.
  const text = `\n${'a'.repeat(1_000_000)}\u001b`;
  const line = describeChange(change({ text }));
  assert.ok(!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(line), 'a control character got through');
  assert.equal(
    line.length,
    'DELETE /api/sessions/{sessionId}: '.length +
      1_000_000 +
      12 +
      ' (api-removed-without-deprecation)'.length,
  );
});

test('a Breaking paragraph declares only in the new version’s own entry, with the version bumped', () => {
  const declared = (previousVersion, currentVersion, entries) =>
    isDeclared({ previousVersion, currentVersion, changelog: changelogOf(entries) });
  assert.equal(declared('0.52.0', '0.53.0', [['0.53.0', true], ['0.52.0']]), true);
  assert.equal(declared('0.52.0', '1.0.0', [['1.0.0', true], ['0.52.0']]), true);
  assert.equal(declared(null, '0.53.0', [['0.53.0', true]]), true);
  // An older entry's Breaking paragraph declares nothing now.
  assert.equal(declared('0.52.0', '0.53.0', [['0.53.0'], ['0.52.0', true]]), false);
  // Nor does the entry of a version that did not change.
  assert.equal(declared('0.52.0', '0.52.0', [['0.52.0', true]]), false);
  // A version without an entry, and a Deprecated paragraph alone.
  assert.equal(declared('0.52.0', '0.53.0', [['0.52.0', true]]), false);
  assert.equal(declared('0.52.0', '0.53.0', [['0.53.0', false, true], ['0.52.0']]), false);
  // Breaking in the lead, not a paragraph of its own, is not the mark.
  const lead =
    '## 0.53.0\n\n2026-10-10\n\n**A headline.** **Breaking:** inside the lead.\n\n## 0.52.0\n\n2026-10-10\n\n**Old.**\n';
  assert.equal(
    isDeclared({ previousVersion: '0.52.0', currentVersion: '0.53.0', changelog: lead }),
    false,
  );
});

test('the verdict: no break passes, an undeclared one fails naming each difference and the entry, a declared one passes listing them', () => {
  const removed = change();
  const required = change({
    id: 'request-property-became-required',
    text: 'the request property `response` became required',
    operation: 'POST',
    path: '/api/sessions',
  });
  const note = change({
    id: 'request-property-pattern-changed',
    text: 'pattern',
    level: LEVEL_WARN,
  });
  const common = { base: 'abc123', previousVersion: '0.52.0', currentVersion: '0.53.0' };

  assert.deepEqual(judge({ ...common, breaking: [], notes: [note], changelog: 'not read' }), {
    ok: true,
    lines: [
      'Notes, which never fail (WARN), against abc123:',
      '  DELETE /api/sessions/{sessionId}: pattern (request-property-pattern-changed)',
      'No breaking difference in packages/shared/openapi.json against abc123',
    ],
  });

  const failing = judge({
    ...common,
    breaking: [removed, required],
    notes: [],
    changelog: changelogOf([['0.53.0'], ['0.52.0', true]]),
  });
  assert.deepEqual(failing, {
    ok: false,
    lines: [
      'Breaking differences in packages/shared/openapi.json against abc123:',
      '  DELETE /api/sessions/{sessionId}: api removed without deprecation (api-removed-without-deprecation)',
      '  POST /api/sessions: the request property `response` became required (request-property-became-required)',
      'Not declared: add a **Breaking:** paragraph to the 0.53.0 entry of CHANGELOG.md, or make the change additive',
    ],
  });

  const declared = judge({
    ...common,
    breaking: [removed],
    notes: [note],
    changelog: changelogOf([['0.53.0', true], ['0.52.0']]),
  });
  assert.equal(declared.ok, true);
  assert.deepEqual(declared.lines.slice(2), [
    'Breaking differences in packages/shared/openapi.json against abc123:',
    '  DELETE /api/sessions/{sessionId}: api removed without deprecation (api-removed-without-deprecation)',
    'Declared by the **Breaking:** paragraph of the 0.53.0 entry of CHANGELOG.md',
  ]);

  const unchanged = judge({
    ...common,
    currentVersion: '0.52.0',
    breaking: [removed],
    notes: [],
    changelog: changelogOf([['0.52.0', true]]),
  });
  assert.equal(unchanged.ok, false);
  assert.equal(
    unchanged.lines.at(-1),
    "VERSION is 0.52.0, as at the base: bump it, then add a **Breaking:** paragraph to the new version's entry of CHANGELOG.md, or make the change additive",
  );

  // A changelog the parser refuses declares nothing and says why.
  const broken = judge({
    ...common,
    breaking: [removed],
    notes: [],
    changelog: '## 0.53.0\n\n**No date.**\n',
  });
  assert.equal(broken.ok, false);
  assert.match(
    broken.lines.at(-1),
    /^Could not read the declaration from CHANGELOG\.md: CHANGELOG\.md: 0\.53\.0 has no date/,
  );
});

test('four checks are raised to ERR and one lowered to WARN, each with its reason, and oasdiff gets them as its severity file', () => {
  assert.deepEqual(
    [...RAISED_CHECKS.keys()],
    [
      'request-property-removed',
      'request-parameter-removed',
      'response-optional-property-removed',
      'optional-response-header-removed',
    ],
  );
  assert.deepEqual([...LOWERED_CHECKS.keys()], ['response-property-enum-value-added']);
  for (const reason of [...RAISED_CHECKS.values(), ...LOWERED_CHECKS.values()]) {
    assert.ok(reason.length > 20);
  }
  // A parameter's reason names every place a parameter is sent from, and what
  // the writer does about a header or cookie parameter the server stops reading.
  const parameter = RAISED_CHECKS.get('request-parameter-removed');
  for (const words of [
    'an unknown query parameter is refused 400 / 1013',
    'an unknown header or cookie parameter is not refused',
    'may get another answer once the server stops reading it',
    'so its removal needs the same Breaking paragraph',
  ]) {
    assert.ok(parameter.includes(words), `the reason no longer says: ${words}`);
  }
  assert.match(RAISED_CHECKS.get('optional-response-header-removed'), /Retry-After/);
  assert.match(LOWERED_CHECKS.get('response-property-enum-value-added'), /D248/);
  assert.equal(
    SEVERITY_LEVELS,
    'request-property-removed err\nrequest-parameter-removed err\nresponse-optional-property-removed err\noptional-response-header-removed err\nresponse-property-enum-value-added warn\n',
  );
  assert.deepEqual(OASDIFF_FLAGS, [
    '--format',
    'json',
    '--allow-external-refs=false',
    '--severity-levels',
    'levels.txt',
  ]);
});

// ---------------------------------------------------------------------------
// The command line against a stand-in oasdiff

test('oasdiff is called once, in an empty directory of its own, on copies with experimental marked alpha and descriptions blanked, and without OASDIFF_CONFIG', (t) => {
  const marked = fixture((spec) => {
    spec.paths[SESSION]['x-stability-level'] = 'experimental';
    spec.paths['/api/sessions'].post['x-stability-level'] = 'experimental';
  });
  const repo = repository(t, { spec: marked });
  repo.change({ version: '0.53.0', spec: fixture() });
  // A config file in the checkout must not reach oasdiff either.
  writeFileSync(join(repo.work, '.oasdiff.yaml'), 'fail-on: WARN\n');
  const fake = standin(t);
  const result = check(repo.work, repo.base, { env: fake.env });
  assert.equal(result.status, 0, result.output);
  assert.equal(
    result.stdout,
    `No breaking difference in packages/shared/openapi.json against ${repo.short}\n`,
  );

  const calls = fake.calls().trim().split('\n');
  const cwd = calls[0].slice('cwd='.length);
  assert.ok(cwd.includes('qa-api-breaking-'), `oasdiff ran in ${cwd}`);
  assert.ok(!existsSync(cwd), 'the temporary directory was left behind');
  assert.deepEqual(calls.slice(1), [
    'config=unset',
    'arg=breaking',
    'arg=base.json',
    'arg=head.json',
    'arg=--format',
    'arg=json',
    'arg=--allow-external-refs=false',
    'arg=--severity-levels',
    'arg=levels.txt',
    'file=base.json',
    'file=head.json',
    'file=levels.txt',
  ]);
  const base = JSON.parse(fake.seen('base.json'));
  assert.equal(base.paths[SESSION]['x-stability-level'], 'alpha');
  assert.equal(base.paths[SESSION].get['x-stability-level'], 'alpha');
  assert.equal(base.paths[SESSION].delete['x-stability-level'], 'alpha');
  assert.equal(base.paths['/api/sessions'].post['x-stability-level'], 'alpha');
  assert.equal(base.paths['/api/sessions'].post.responses[201].description, '');
  assert.deepEqual(JSON.parse(fake.seen('head.json')), withoutDescriptions(fixture()));
  assert.equal(fake.seen('levels.txt'), SEVERITY_LEVELS);
});

test('without oasdiff, after an error exit, on output that does not parse or a run that does not end, the check fails as could not compare', async (t) => {
  const repo = repository(t);
  repo.change({ version: '0.53.0', spec: fixture(removeOperation) });
  const prefix = `Could not compare packages/shared/openapi.json with ${repo.short}: `;

  const missing = check(repo.work, repo.base, { path: GIT_ONLY_DIR });
  assert.equal(missing.status, 1, missing.output);
  assert.equal(missing.stderr, `${prefix}oasdiff is not installed (not found on PATH)\n`);
  assert.equal(missing.stdout, '');

  const failed = standin(t, {
    output: '',
    exit: 106,
    stderr: 'Error: failed to load base spec\n\u001b[31mfrom base.json',
  });
  const error = check(repo.work, repo.base, { env: failed.env });
  assert.equal(error.status, 1, error.output);
  assert.equal(
    error.stderr,
    `${prefix}oasdiff exited 106: Error: failed to load base spec\\u000a\\u001b[31mfrom base.json\n`,
  );

  // Output that is not oasdiff's, with exit 0: never a pass.
  for (const output of ['', 'not json', '{}', '[{"level": 3}]', '1 changes: 1 error']) {
    const garbled = standin(t, { output });
    const result = check(repo.work, repo.base, { env: garbled.env });
    assert.equal(result.status, 1, `${output}: ${result.output}`);
    assert.ok(result.stderr.startsWith(prefix), result.output);
  }

  // A run that does not end within the bound is stopped and fails.
  const hanging = standin(t, { hang: true });
  const started = Date.now();
  assert.throws(
    () =>
      compareSpecs({
        baseText: JSON.stringify(fixture()),
        headText: JSON.stringify(fixture()),
        env: { ...process.env, ...hanging.env, PATH: `${STANDIN_DIR}:${process.env.PATH}` },
        timeoutMs: 300,
      }),
    (thrown) =>
      thrown instanceof CouldNotCompare && thrown.message === 'oasdiff did not finish within 0.3 s',
  );
  assert.ok(Date.now() - started < 20_000, 'the hanging stand-in was not stopped');
});

test('a WARN entry is printed as a note and passes; an ERR entry fails unless the new version’s entry declares it', (t) => {
  const warn = JSON.stringify([
    change({ level: LEVEL_WARN, id: 'request-property-pattern-changed', text: 'pattern changed' }),
  ]);
  const err = JSON.stringify([change()]);
  const line =
    '  DELETE /api/sessions/{sessionId}: api removed without deprecation (api-removed-without-deprecation)';

  const notes = repository(t);
  notes.change({ version: '0.53.0' });
  const passed = check(notes.work, notes.base, { env: standin(t, { output: warn }).env });
  assert.equal(passed.status, 0, passed.output);
  assert.equal(
    passed.stdout,
    [
      `Notes, which never fail (WARN), against ${notes.short}:`,
      '  DELETE /api/sessions/{sessionId}: pattern changed (request-property-pattern-changed)',
      `No breaking difference in packages/shared/openapi.json against ${notes.short}`,
      '',
    ].join('\n'),
  );

  const undeclared = repository(t);
  undeclared.change({ version: '0.53.0', changelog: changelogOf([['0.53.0'], ['0.52.0', true]]) });
  const failed = check(undeclared.work, undeclared.base, { env: standin(t, { output: err }).env });
  assert.equal(failed.status, 1, failed.output);
  assert.equal(failed.stdout, '');
  assert.equal(
    failed.stderr,
    [
      `Breaking differences in packages/shared/openapi.json against ${undeclared.short}:`,
      line,
      'Not declared: add a **Breaking:** paragraph to the 0.53.0 entry of CHANGELOG.md, or make the change additive',
      '',
    ].join('\n'),
  );

  const declared = repository(t);
  declared.change({ version: '0.53.0', changelog: changelogOf([['0.53.0', true], ['0.52.0']]) });
  const ok = check(declared.work, declared.base, { env: standin(t, { output: err }).env });
  assert.equal(ok.status, 0, ok.output);
  assert.equal(
    ok.stdout,
    [
      `Breaking differences in packages/shared/openapi.json against ${declared.short}:`,
      line,
      'Declared by the **Breaking:** paragraph of the 0.53.0 entry of CHANGELOG.md',
      '',
    ].join('\n'),
  );
});

test('a description missing at the base passes with nothing to compare; one missing from the checkout, or not JSON, fails', (t) => {
  const added = repository(t, { spec: null });
  added.change({ version: '0.53.0', spec: fixture() });
  const fake = standin(t);
  const first = check(added.work, added.base, { env: fake.env });
  assert.equal(first.status, 0, first.output);
  assert.equal(
    first.stdout,
    `packages/shared/openapi.json does not exist at ${added.short}: nothing to compare\n`,
  );
  assert.equal(fake.calls(), null, 'oasdiff ran');

  const removed = repository(t);
  removed.change({ version: '0.53.0', spec: null });
  const gone = check(removed.work, removed.base, { env: standin(t).env });
  assert.equal(gone.status, 1, gone.output);
  assert.equal(
    gone.stderr,
    'Could not compare: packages/shared/openapi.json is missing from this checkout\n',
  );

  for (const [label, base, head] of [
    ['base', '{"openapi": "3.1.0",', JSON.stringify(fixture())],
    ['current', JSON.stringify(fixture()), 'openapi: 3.1.0\n'],
  ]) {
    const broken = repository(t, { spec: base });
    broken.change({ version: '0.53.0', spec: head });
    const result = check(broken.work, broken.base, { env: standin(t).env });
    assert.equal(result.status, 1, result.output);
    assert.equal(
      result.stderr,
      `Could not compare packages/shared/openapi.json with ${broken.short}: the ${label} description is not JSON\n`,
    );
  }
});

test('a base that is not a commit, or none, fails', (t) => {
  const repo = repository(t);
  const unknown = check(repo.work, 'no-such-ref', { env: standin(t).env });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /no-such-ref/);
  const none = check(repo.work, undefined, { env: standin(t).env });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /Usage: node scripts\/check-api-breaking\.mjs <base-commit>/);
});

// ---------------------------------------------------------------------------
// The real oasdiff

test('the oasdiff these cases run is the release delivery-checks pins', real, () => {
  requireReal();
  const pinned = /^ {4}OASDIFF_VERSION: '(\d+\.\d+\.\d+)'$/m.exec(
    read('.gitlab/ci/validate.yml'),
  )?.[1];
  assert.ok(pinned, '.gitlab/ci/validate.yml pins no OASDIFF_VERSION');
  const version = spawnSync(REAL_OASDIFF, ['--version'], { encoding: 'utf8' });
  assert.equal(version.stdout.trim(), `oasdiff version ${pinned}`);
});

test(
  'removing an answer field or an operation, or requiring an optional request field, fails undeclared and names each difference and the entry',
  real,
  (t) => {
    requireReal();
    const repo = repository(t);
    repo.change({
      version: '0.53.0',
      changelog: changelogOf([['0.53.0'], ['0.52.0', true]]),
      spec: fixture((spec) => {
        removeRequiredAnswerField(spec);
        removeOperation(spec);
        requireOptionalRequestField(spec);
      }),
    });
    const result = check(repo.work, repo.base, { dirs: [REAL_DIR] });
    assert.equal(result.status, 1, result.output);
    assert.equal(result.stdout, '');
    // The lines in between are in oasdiff's order, compared here as a set.
    const lines = result.stderr.split('\n');
    assert.equal(
      lines[0],
      `Breaking differences in packages/shared/openapi.json against ${repo.short}:`,
    );
    assert.deepEqual(lines.slice(-2), [
      'Not declared: add a **Breaking:** paragraph to the 0.53.0 entry of CHANGELOG.md, or make the change additive',
      '',
    ]);
    assert.deepEqual(lines.slice(1, -2).sort(), [
      '  DELETE /api/sessions/{sessionId}: api removed without deprecation (api-removed-without-deprecation)',
      '  GET /api/sessions/{sessionId}: removed the required property `expiresAt` from the response with the `200` status (response-required-property-removed)',
      '  POST /api/sessions: removed the required property `expiresAt` from the response with the `201` status (response-required-property-removed)',
      '  POST /api/sessions: the request property `response` became required (request-property-became-required)',
    ]);

    // Each of them alone is breaking too.
    for (const [edit, id] of [
      [removeRequiredAnswerField, 'response-required-property-removed'],
      [removeOperation, 'api-removed-without-deprecation'],
      [requireOptionalRequestField, 'request-property-became-required'],
    ]) {
      const { breaking, notes } = compareSpecs({
        baseText: JSON.stringify(fixture()),
        headText: JSON.stringify(fixture(edit)),
        env: { ...process.env, PATH: `${REAL_DIR}:${process.env.PATH}` },
      });
      assert.ok(breaking.length > 0 && breaking.every((item) => item.id === id), id);
      assert.deepEqual(notes, []);
    }
  },
);

test(
  'the same differences with a Breaking paragraph in the new version’s entry pass and are listed',
  real,
  (t) => {
    requireReal();
    const repo = repository(t);
    repo.change({
      version: '0.53.0',
      changelog: changelogOf([['0.53.0', true], ['0.52.0']]),
      spec: fixture((spec) => {
        removeRequiredAnswerField(spec);
        removeOperation(spec);
        requireOptionalRequestField(spec);
      }),
    });
    const result = check(repo.work, repo.base, { dirs: [REAL_DIR] });
    assert.equal(result.status, 0, result.output);
    const lines = result.stdout.trim().split('\n');
    assert.equal(
      lines[0],
      `Breaking differences in packages/shared/openapi.json against ${repo.short}:`,
    );
    assert.equal(lines.length, 6);
    assert.equal(
      lines.at(-1),
      'Declared by the **Breaking:** paragraph of the 0.53.0 entry of CHANGELOG.md',
    );
  },
);

test(
  'an added path, optional request field or answer field passes with no breaking line and no note',
  real,
  (t) => {
    requireReal();
    const repo = repository(t);
    repo.change({
      version: '0.53.0',
      spec: fixture((spec) => {
        spec.paths['/api/extra'] = { get: { responses: { 200: { description: 'ok' } } } };
        spec.components.schemas.CreateSessionRequest.properties.label = { type: 'string' };
        spec.components.schemas.CreatedSession.properties.receiveUrl = { type: 'string' };
        spec.components.schemas.CreatedSession.required.push('receiveUrl');
      }),
    });
    const result = check(repo.work, repo.base, { dirs: [REAL_DIR] });
    assert.equal(result.status, 0, result.output);
    assert.equal(
      result.output,
      `No breaking difference in packages/shared/openapi.json against ${repo.short}\n`,
    );
  },
);

test(
  'an experimental path or operation may be removed or changed undeclared; a stable one may not, nor may a stable one become experimental',
  real,
  (t) => {
    requireReal();
    const env = { ...process.env, PATH: `${REAL_DIR}:${process.env.PATH}` };
    const compare = (base, head) =>
      compareSpecs({ baseText: JSON.stringify(base), headText: JSON.stringify(head), env });
    const pathMarked = fixture((spec) => {
      spec.paths[SESSION]['x-stability-level'] = 'experimental';
    });
    const withoutPath = fixture((spec) => delete spec.paths[SESSION]);
    assert.deepEqual(compare(pathMarked, withoutPath), { breaking: [], notes: [] });
    assert.deepEqual(
      compare(fixture(), withoutPath)
        .breaking.map((item) => `${item.operation} ${item.id}`)
        .sort(),
      ['DELETE api-path-removed-without-deprecation', 'GET api-path-removed-without-deprecation'],
    );

    const operationMarked = fixture((spec) => {
      spec.paths[SESSION].delete['x-stability-level'] = 'experimental';
    });
    assert.deepEqual(compare(operationMarked, fixture(removeOperation)), {
      breaking: [],
      notes: [],
    });

    // A change inside an experimental operation is not reported either.
    const getMarked = fixture((spec) => {
      spec.paths[SESSION].get['x-stability-level'] = 'experimental';
    });
    const getChanged = fixture((spec) => {
      spec.paths[SESSION].get['x-stability-level'] = 'experimental';
      spec.paths[SESSION].get.responses[200].content['application/json'].schema = {
        type: 'object',
        properties: {},
      };
    });
    assert.deepEqual(compare(getMarked, getChanged), { breaking: [], notes: [] });

    // Marking a stable operation experimental is itself breaking.
    assert.deepEqual(
      compare(fixture(), getMarked).breaking.map((item) => item.id),
      ['api-stability-decreased'],
    );

    // The CLI too: an experimental path removed with no Breaking paragraph.
    const repo = repository(t, { spec: pathMarked });
    repo.change({ version: '0.53.0', spec: withoutPath });
    const result = check(repo.work, repo.base, { dirs: [REAL_DIR] });
    assert.equal(result.status, 0, result.output);
  },
);

test(
  'a removed request field, a query, header or cookie parameter, an optional answer field or an optional response header is breaking by the raised levels',
  real,
  () => {
    requireReal();
    const env = { ...process.env, PATH: `${REAL_DIR}:${process.env.PATH}` };
    const withoutParameter = (name) => (spec) => {
      const { get } = spec.paths[SESSION];
      get.parameters = get.parameters.filter((parameter) => parameter.name !== name);
    };
    for (const [edit, lines] of [
      [
        (spec) => delete spec.components.schemas.CreateSessionRequest.properties.queue,
        ['POST /api/sessions: removed the request property `queue` (request-property-removed)'],
      ],
      [
        withoutParameter('include'),
        [
          'GET /api/sessions/{sessionId}: deleted the `query` request parameter `include` (request-parameter-removed)',
        ],
      ],
      [
        withoutParameter('X-Trace'),
        [
          'GET /api/sessions/{sessionId}: deleted the `header` request parameter `x-trace` (request-parameter-removed)',
        ],
      ],
      [
        withoutParameter('theme'),
        [
          'GET /api/sessions/{sessionId}: deleted the `cookie` request parameter `theme` (request-parameter-removed)',
        ],
      ],
      [
        (spec) => delete spec.components.schemas.CreatedSession.properties.note,
        [
          'GET /api/sessions/{sessionId}: removed the optional property `note` from the response with the `200` status (response-optional-property-removed)',
          'POST /api/sessions: removed the optional property `note` from the response with the `201` status (response-optional-property-removed)',
        ],
      ],
      [
        removeOptionalHeader,
        [
          'GET /api/sessions/{sessionId}: the optional response header `x-request-id` removed for the status `200` (optional-response-header-removed)',
        ],
      ],
    ]) {
      const { breaking, notes } = compareSpecs({
        baseText: JSON.stringify(fixture()),
        headText: JSON.stringify(fixture(edit)),
        env,
      });
      assert.deepEqual(breaking.map(describeChange).sort(), lines);
      assert.ok(breaking.every((item) => item.level === LEVEL_ERR));
      assert.deepEqual(notes, []);
    }
  },
);

test(
  'an optional response header removed from a stable answer fails undeclared, naming the operation, the header and the id, and passes declared',
  real,
  (t) => {
    requireReal();
    const line =
      '  GET /api/sessions/{sessionId}: the optional response header `x-request-id` removed for the status `200` (optional-response-header-removed)';
    const undeclared = repository(t);
    undeclared.change({
      version: '0.53.0',
      changelog: changelogOf([['0.53.0'], ['0.52.0']]),
      spec: fixture(removeOptionalHeader),
    });
    const failed = check(undeclared.work, undeclared.base, { dirs: [REAL_DIR] });
    assert.equal(failed.status, 1, failed.output);
    assert.equal(failed.stdout, '');
    assert.equal(
      failed.stderr,
      [
        `Breaking differences in packages/shared/openapi.json against ${undeclared.short}:`,
        line,
        'Not declared: add a **Breaking:** paragraph to the 0.53.0 entry of CHANGELOG.md, or make the change additive',
        '',
      ].join('\n'),
    );

    const declared = repository(t);
    declared.change({
      version: '0.53.0',
      changelog: changelogOf([['0.53.0', true], ['0.52.0']]),
      spec: fixture(removeOptionalHeader),
    });
    const passed = check(declared.work, declared.base, { dirs: [REAL_DIR] });
    assert.equal(passed.status, 0, passed.output);
    assert.equal(
      passed.stdout,
      [
        `Breaking differences in packages/shared/openapi.json against ${declared.short}:`,
        line,
        'Declared by the **Breaking:** paragraph of the 0.53.0 entry of CHANGELOG.md',
        '',
      ].join('\n'),
    );
  },
);

test(
  'a response header removed on an experimental operation or added passes with no line, a required one removed stays ERR, and one renamed by case only is no difference',
  real,
  () => {
    requireReal();
    const env = { ...process.env, PATH: `${REAL_DIR}:${process.env.PATH}` };
    const compare = (base, head) =>
      compareSpecs({ baseText: JSON.stringify(base), headText: JSON.stringify(head), env });
    const headers = (spec) => spec.paths[SESSION].get.responses[200].headers;
    const experimental = (spec) => {
      spec.paths[SESSION].get['x-stability-level'] = 'experimental';
    };

    assert.deepEqual(
      compare(
        fixture(experimental),
        fixture((spec) => {
          experimental(spec);
          removeOptionalHeader(spec);
        }),
      ),
      { breaking: [], notes: [] },
    );
    assert.deepEqual(
      compare(
        fixture(),
        fixture((spec) => (headers(spec)['X-Expires'] = { schema: { type: 'string' } })),
      ),
      { breaking: [], notes: [] },
    );

    const required = (spec) => (headers(spec)['X-Request-Id'].required = true);
    const { breaking, notes } = compare(fixture(required), fixture(removeOptionalHeader));
    assert.deepEqual(breaking.map(describeChange), [
      'GET /api/sessions/{sessionId}: the mandatory response header `x-request-id` removed for the status `200` (required-response-header-removed)',
    ]);
    assert.equal(breaking[0].level, LEVEL_ERR);
    assert.deepEqual(notes, []);

    // oasdiff 1.33.0 compares header names in lower case, as HTTP reads them:
    // a rename by case alone is no difference at all.
    assert.deepEqual(
      compare(
        fixture(),
        fixture((spec) => {
          headers(spec)['x-request-id'] = headers(spec)['X-Request-Id'];
          delete headers(spec)['X-Request-Id'];
        }),
      ),
      { breaking: [], notes: [] },
    );
  },
);

test(
  'in the real description, Retry-After removed from the shared RateLimitExceeded answer is reported on every operation using it, and every X-RateLimit-* header removed gives one whole line per difference within the bound',
  real,
  (t) => {
    requireReal();
    const env = { ...process.env, PATH: `${REAL_DIR}:${process.env.PATH}` };
    const text = read(SPEC_PATH);
    const spec = JSON.parse(text);

    // `[METHOD, path, status, answer]` for every stable operation's answer,
    // a shared one read through its $ref.
    const answers = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (
          !['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(method)
        ) {
          continue;
        }
        const level = operation['x-stability-level'] ?? item['x-stability-level'];
        if (level === 'experimental') continue;
        for (const [status, answer] of Object.entries(operation.responses ?? {})) {
          const shared = answer.$ref?.replace('#/components/responses/', '');
          answers.push([method.toUpperCase(), path, status, answer, shared]);
        }
      }
    }
    const removed = (method, path, status, header) =>
      `${method} ${path}: the optional response header \`${header.toLowerCase()}\` removed for the status \`${status}\` (optional-response-header-removed)`;

    const withoutRetryAfter = structuredClone(spec);
    delete withoutRetryAfter.components.responses.RateLimitExceeded.headers['Retry-After'];
    const expected = answers
      .filter(([, , , , shared]) => shared === 'RateLimitExceeded')
      .map(([method, path, status]) => removed(method, path, status, 'Retry-After'));
    assert.ok(expected.length > 1, 'RateLimitExceeded is not shared by several operations');
    const retryAfter = compareSpecs({
      baseText: text,
      headText: JSON.stringify(withoutRetryAfter),
      env,
    });
    assert.deepEqual(retryAfter.breaking.map(describeChange).sort(), expected.sort());
    assert.deepEqual(retryAfter.notes, []);

    // Every X-RateLimit-* header, from every answer of the description.
    const rateLimit = (name) => name.startsWith('X-RateLimit-');
    const lines = [];
    for (const [method, path, status, answer, shared] of answers) {
      const headers = (shared ? spec.components.responses[shared] : answer).headers ?? {};
      for (const name of Object.keys(headers).filter(rateLimit)) {
        lines.push(`  ${removed(method, path, status, name)}`);
      }
    }
    assert.ok(lines.length > 100, `${lines.length} rate-limit headers`);
    const stripped = structuredClone(spec);
    const strip = (answer) => {
      for (const name of Object.keys(answer.headers ?? {}).filter(rateLimit)) {
        delete answer.headers[name];
      }
    };
    Object.values(stripped.components.responses).forEach(strip);
    for (const item of Object.values(stripped.paths)) {
      for (const operation of Object.values(item)) {
        Object.values(operation.responses ?? {}).forEach(strip);
      }
    }
    const repo = repository(t, { spec: text });
    repo.change({ version: '0.53.0', spec: stripped });
    const started = Date.now();
    const result = check(repo.work, repo.base, { dirs: [REAL_DIR] });
    assert.ok(Date.now() - started < OASDIFF_TIMEOUT_MS);
    assert.equal(result.status, 1, result.output);
    const printed = result.stderr.split('\n');
    assert.equal(
      printed[0],
      `Breaking differences in packages/shared/openapi.json against ${repo.short}:`,
    );
    assert.deepEqual(printed.slice(-2), [
      'Not declared: add a **Breaking:** paragraph to the 0.53.0 entry of CHANGELOG.md, or make the change additive',
      '',
    ]);
    assert.deepEqual(printed.slice(1, -2).sort(), lines.sort());
  },
);

test(
  'a value added to an answer enum, as a property or inside an array item, passes with the change among the notes; one added to a request enum gives no line',
  real,
  (t) => {
    requireReal();
    const repo = repository(t);
    repo.change({
      version: '0.53.0',
      spec: fixture((spec) => {
        const { properties } = spec.components.schemas.CreatedSession;
        properties.state.enum.push('paused');
        properties.history.items.enum.push('deleted');
      }),
    });
    const result = check(repo.work, repo.base, { dirs: [REAL_DIR] });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stderr, '');
    const lines = result.stdout.split('\n');
    assert.equal(lines[0], `Notes, which never fail (WARN), against ${repo.short}:`);
    assert.deepEqual(lines.slice(-2), [
      `No breaking difference in packages/shared/openapi.json against ${repo.short}`,
      '',
    ]);
    assert.deepEqual(lines.slice(1, -2).sort(), [
      '  GET /api/sessions/{sessionId}: added the new `deleted` enum value to the `history/items/` response property for the response status `200` (response-property-enum-value-added)',
      '  GET /api/sessions/{sessionId}: added the new `paused` enum value to the `state` response property for the response status `200` (response-property-enum-value-added)',
      '  POST /api/sessions: added the new `deleted` enum value to the `history/items/` response property for the response status `201` (response-property-enum-value-added)',
      '  POST /api/sessions: added the new `paused` enum value to the `state` response property for the response status `201` (response-property-enum-value-added)',
    ]);

    const env = { ...process.env, PATH: `${REAL_DIR}:${process.env.PATH}` };
    assert.deepEqual(
      compareSpecs({
        baseText: JSON.stringify(fixture()),
        headText: JSON.stringify(
          fixture((spec) => {
            spec.paths[SESSION].get.parameters[0].schema.enum.push('all');
            spec.components.schemas.CreateSessionRequest.properties.order.enum.push('random');
          }),
        ),
        env,
      }),
      { breaking: [], notes: [] },
    );
  },
);

test(
  'in the real description, a value added to ResponseState passes with a note on each operation answering it, and one added to include or order gives no line',
  real,
  (t) => {
    requireReal();
    const text = read(SPEC_PATH);
    const spec = JSON.parse(text);
    const withState = structuredClone(spec);
    withState.components.schemas.ResponseState.enum.push('queued');
    const repo = repository(t, { spec: text });
    repo.change({ version: '0.53.0', spec: withState });
    const result = check(repo.work, repo.base, { dirs: [REAL_DIR] });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stderr, '');
    const lines = result.stdout.split('\n');
    assert.equal(lines[0], `Notes, which never fail (WARN), against ${repo.short}:`);
    assert.deepEqual(lines.slice(-2), [
      `No breaking difference in packages/shared/openapi.json against ${repo.short}`,
      '',
    ]);
    const notes = lines.slice(1, -2);
    // The list, the query and the detail of requests answer a response's state.
    for (const operation of [
      'GET /api/sessions/{sessionId}/requests: ',
      'POST /api/sessions/{sessionId}/requests/query: ',
      'GET /api/sessions/{sessionId}/requests/{requestId}: ',
    ]) {
      assert.ok(
        notes.some((note) => note.startsWith(`  ${operation}`)),
        `no note on ${operation}`,
      );
    }
    for (const note of notes) {
      assert.match(
        note,
        /^ {2}[A-Z]+ \/\S+: added the new `queued` enum value to the `[^`]+` response property for the response status `200` \(response-property-enum-value-added\)$/,
      );
    }

    // The request enums: include and order as query parameters and as fields
    // of the query's body.
    const requests = structuredClone(spec);
    const list = requests.paths['/api/sessions/{sessionId}/requests'].get.parameters;
    const query = requests.components.schemas.RequestQueryRequest.properties;
    for (const enumeration of [
      list.find((parameter) => parameter.name === 'include').schema.items.enum,
      list.find((parameter) => parameter.name === 'order').schema.enum,
      query.include.items.enum,
      query.order.enum,
    ]) {
      enumeration.push('everything');
    }
    const env = { ...process.env, PATH: `${REAL_DIR}:${process.env.PATH}` };
    assert.deepEqual(compareSpecs({ baseText: text, headText: JSON.stringify(requests), env }), {
      breaking: [],
      notes: [],
    });
  },
);

test(
  'oasdiff 1.33.0 knows every raised and lowered id: each raised one is below ERR by its default, the lowered one ERR',
  real,
  () => {
    requireReal();
    const defaults = {};
    for (const id of [...RAISED_CHECKS.keys(), ...LOWERED_CHECKS.keys()]) {
      const result = spawnSync(
        REAL_OASDIFF,
        ['checks', 'changelog', '--id', id, '--format', 'json'],
        {
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 0, `${id}: ${result.stderr}`);
      const [check] = JSON.parse(result.stdout);
      assert.equal(check.id, id);
      defaults[id] = check.level;
    }
    assert.deepEqual(defaults, {
      'request-property-removed': 'warning',
      'request-parameter-removed': 'warning',
      'response-optional-property-removed': 'info',
      'optional-response-header-removed': 'info',
      'response-property-enum-value-added': 'error',
    });
  },
);

test(
  'a revert after a failed delivery, removing the path and answer field the failed version added, fails undeclared naming the new patch entry and passes declared',
  real,
  (t) => {
    requireReal();
    // The failed version, 1.6.0, added a path and an answer field; the revert
    // takes both out again in 1.6.1 (D219).
    const failedVersion = fixture((spec) => {
      spec.paths['/api/extra'] = { get: { responses: { 200: { description: 'ok' } } } };
      spec.components.schemas.CreatedSession.properties.receiveUrl = { type: 'string' };
    });
    const entry = (breaking) =>
      '# Changes\n\nThe repository-only header.\n\n' +
      '## 1.6.1\n\n2026-10-21\n\n**Undoes 1.6.0.** For users.\n\n' +
      (breaking
        ? '**Breaking:** the extra path and `receiveUrl` are gone again: 1.6.0 was rolled back, so production already serves the description without them.\n\n'
        : '') +
      '## 1.6.0\n\n2026-10-20\n\n**Adds an extra path.** For users.\n\n';
    const removedLines = [
      '  GET /api/extra: api path removed without deprecation (api-path-removed-without-deprecation)',
      '  GET /api/sessions/{sessionId}: removed the optional property `receiveUrl` from the response with the `200` status (response-optional-property-removed)',
      '  POST /api/sessions: removed the optional property `receiveUrl` from the response with the `201` status (response-optional-property-removed)',
    ];

    const undeclared = repository(t, {
      spec: failedVersion,
      version: '1.6.0',
      changelog: changelogOf([['1.6.0']]),
    });
    undeclared.change({ version: '1.6.1', changelog: entry(false), spec: fixture() });
    const failed = check(undeclared.work, undeclared.base, { dirs: [REAL_DIR] });
    assert.equal(failed.status, 1, failed.output);
    const lines = failed.stderr.split('\n');
    assert.equal(
      lines[0],
      `Breaking differences in packages/shared/openapi.json against ${undeclared.short}:`,
    );
    assert.deepEqual(lines.slice(1, -2).sort(), removedLines);
    assert.deepEqual(lines.slice(-2), [
      'Not declared: add a **Breaking:** paragraph to the 1.6.1 entry of CHANGELOG.md, or make the change additive',
      '',
    ]);

    const declared = repository(t, {
      spec: failedVersion,
      version: '1.6.0',
      changelog: changelogOf([['1.6.0']]),
    });
    declared.change({ version: '1.6.1', changelog: entry(true), spec: fixture() });
    const passed = check(declared.work, declared.base, { dirs: [REAL_DIR] });
    assert.equal(passed.status, 0, passed.output);
    assert.equal(
      passed.stdout.trim().split('\n').at(-1),
      'Declared by the **Breaking:** paragraph of the 1.6.1 entry of CHANGELOG.md',
    );
  },
);

test(
  'the real description compared with itself gives no difference, and a description oasdiff cannot load fails as could not compare',
  real,
  () => {
    requireReal();
    const env = { ...process.env, PATH: `${REAL_DIR}:${process.env.PATH}` };
    const text = read(SPEC_PATH);
    assert.match(JSON.parse(text).openapi, /^3\.1\.\d+$/);
    assert.deepEqual(compareSpecs({ baseText: text, headText: text, env }), {
      breaking: [],
      notes: [],
    });
    // An operation of the real description removed is found there too.
    const spec = JSON.parse(text);
    const [path, item] = Object.entries(spec.paths).find(([, value]) => value.delete);
    delete item.delete;
    const { breaking } = compareSpecs({ baseText: text, headText: JSON.stringify(spec), env });
    assert.deepEqual(
      breaking.map((entry) => `${entry.operation} ${entry.path} ${entry.id}`),
      [`DELETE ${path} api-removed-without-deprecation`],
    );

    assert.throws(
      () =>
        compareSpecs({
          baseText: text,
          headText: JSON.stringify({ openapi: '3.1.0', info: 'x', paths: 7 }),
          env,
        }),
      (error) => error instanceof CouldNotCompare && /^oasdiff exited \d+: /.test(error.message),
    );
  },
);

// ---------------------------------------------------------------------------
// The job and the documents

test('delivery-checks downloads the pinned oasdiff, verifies its SHA-256 and runs the check against DELIVERY_BASE on every pipeline', () => {
  const ci = read('.gitlab/ci/validate.yml');
  const job = ci.slice(ci.indexOf('\ndelivery-checks:'), ci.indexOf('\nchart:'));
  const lines = job.split('\n').map((line) => line.trim());
  const at = (line) => {
    const index = lines.indexOf(line);
    assert.ok(index >= 0, `.gitlab/ci/validate.yml delivery-checks no longer has: ${line}`);
    return index;
  };

  const version = /^ {4}OASDIFF_VERSION: '(\d+)\.(\d+)\.(\d+)'$/m.exec(job);
  assert.ok(version, 'delivery-checks pins no OASDIFF_VERSION');
  const [major, minor] = version.slice(1).map(Number);
  assert.ok(
    major > 1 || (major === 1 && minor >= 15),
    'oasdiff before 1.15.0 reads no OpenAPI 3.1',
  );
  assert.match(job, /^ {4}OASDIFF_SHA256: '[0-9a-f]{64}'$/m);

  const script = at('script:');
  const install = [
    at('- apt-get install -y --no-install-recommends git ca-certificates curl'),
    at(
      '- curl -fsSL --retry 3 -o /tmp/oasdiff.tar.gz "https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/oasdiff_${OASDIFF_VERSION}_linux_amd64.tar.gz"',
    ),
    at('- echo "${OASDIFF_SHA256}  /tmp/oasdiff.tar.gz" | sha256sum -c -'),
    at('- tar -xzf /tmp/oasdiff.tar.gz -C /usr/local/bin oasdiff'),
  ];
  assert.deepEqual(
    [...install].sort((a, b) => a - b),
    install,
    'download, verify, extract, in order',
  );
  assert.ok(install.at(-1) < script, 'oasdiff is installed before the script');

  assert.ok(job.includes('scripts/check-api-breaking.test.mjs'), 'the test is not run');
  const merge = at('DELIVERY_BASE="$CI_MERGE_REQUEST_DIFF_BASE_SHA"');
  const main = at('DELIVERY_BASE=$(git rev-parse HEAD^)');
  const guard = at('test -n "$DELIVERY_BASE"');
  const version_ = at('node scripts/check-version.mjs "$DELIVERY_BASE"');
  const api = at('node scripts/check-api-breaking.mjs "$DELIVERY_BASE"');
  assert.ok(merge < main && main < guard && guard < version_ && api === version_ + 1);
  // No rule narrows the job and no failure is allowed: it runs, and gates, on
  // merge request and main pipelines alike.
  for (const key of ['rules:', 'only:', 'except:', 'allow_failure:', 'when:']) {
    assert.ok(!lines.includes(key) && !lines.some((line) => line.startsWith(key)), key);
  }
});

// D219 records the check and DELIVERY says what delivery-checks fails; both
// live with the delivery process, outside this repository. The changelog's
// header, which readers of the API see, says it here.
test('the changelog header says what delivery-checks fails (D219)', () => {
  const header = read('CHANGELOG.md').split(/^## /m)[0].replace(/\s+/g, ' ');
  for (const phrase of [
    '`scripts/check-api-breaking.mjs` fails a merge request',
    'a query, header or cookie parameter or a response header removed',
    'is printed as a note and does not fail the check: before 2026-11-24 it is a breaking change without notice, which the Reviewer reports',
    'A revert or fix after a failed delivery that removes from the description what the failed version added fails the check too',
  ]) {
    assert.ok(header.includes(phrase), `the header of CHANGELOG.md does not say: ${phrase}`);
  }
});

test('the stand-in lists hidden files too, so a planted config would show', (t) => {
  // The listing above relies on `.*`; a file such as `.oasdiff.yaml` beside
  // the copies would appear as `file=.oasdiff.yaml`.
  const fake = standin(t);
  const dir = mkdtempSync(join(tmpdir(), 'qa-api-check-listing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '.oasdiff.yaml'), '');
  const result = spawnSync(join(STANDIN_DIR, 'oasdiff'), [], {
    cwd: dir,
    env: { ...process.env, ...fake.env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fake.calls().includes('file=.oasdiff.yaml'));
  assert.deepEqual(readdirSync(dir), ['.oasdiff.yaml']);
});
