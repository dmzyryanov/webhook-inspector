// Which runner each job of the pipeline lands on (#198, D258), and which jobs
// take turns through a resource group (#266), read from this checkout's
// .gitlab-ci.yml and .gitlab/ci/validate.yml and the child pipeline
// scripts/main-validation.mjs writes, under a model of how GitLab chooses a
// job's tags and its resource group. Nothing here reaches GitLab.
//
// The model, from GitLab's code at master on 2026-10-22 and its documentation
// (doc/ci/variables, "CI/CD variable precedence"; doc/ci/pipelines/
// downstream_pipelines.md, "Prevent default variables from being passed"):
// - A job's `tags:` replace `default: tags:`; with neither the job is
//   untagged, and GitLab's shared runners take it.
// - Tags are expanded when the pipeline is created, against the job's
//   variables, and a variable that is not set stays as its literal name
//   (Gitlab::Ci::Pipeline::Seed::Build#evaluate_runner_tags,
//   ExpandVariables.expand_existing). The result is split at commas and a
//   blank tag dropped (Gitlab::Ci::Tags::Parser, TagList#clean!).
// - A variable's value is the last of, from lowest: the file's top-level
//   `variables:`, the project's CI/CD variables, and the variables a trigger
//   job passed on to its child pipeline
//   (Gitlab::Ci::Variables::Builder#scoped_variables_for_pipeline_seed).
// - A trigger job passes on its YAML variables: the top-level ones it
//   inherits, which `inherit: variables:` narrows, and its own
//   (Gitlab::Ci::Variables::Downstream::Generator; `forward: yaml_variables`
//   is true by default).
// - Files merged by `include:` merge their top-level `variables:` and
//   `default:`, the including file's key winning.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  PROOF_JOB,
  RUNNER_TAG_DEFAULT,
  RUNNER_TAG_VARIABLE,
  childConfig,
} from './main-validation.mjs';
import { compile, matches } from './test-inputs.mjs';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const CI = read('.gitlab-ci.yml');
const VALIDATE = read('.gitlab/ci/validate.yml');

const SHARED = 'saas-linux-small-amd64';
// The runners are the project's CI/CD variables' since #367, not the
// pipeline files': production's two, as recorded in qa-tools'
// docs/RESOURCES.md, with which the jobs land as before.
const OURS = 'qa-tools-ci';
const DEPLOY = 'qa-tools-vps';
const DEPLOY_TAG_VARIABLE = 'DEPLOY_RUNNER_TAG';
const PRODUCTION = Object.freeze({ [RUNNER_TAG_VARIABLE]: OURS, [DEPLOY_TAG_VARIABLE]: DEPLOY });
const KEYWORDS = ['stages', 'workflow', 'include', 'variables', 'default'];

/** A top-level block of a YAML file, comments left out, or null. */
function block(text, name) {
  const lines = text.split('\n');
  const from = lines.indexOf(`${name}:`);
  if (from < 0) return null;
  const after = lines.findIndex((line, at) => at > from && /^[^\s#]/.test(line));
  return lines
    .slice(from + 1, after < 0 ? lines.length : after)
    .filter((line) => !/^\s*#/.test(line) && line.trim() !== '');
}

/** The top-level keys of a file that are jobs: not keywords, not hidden. */
const jobsOf = (text) =>
  text
    .split('\n')
    .filter((line) => /^[a-z][\w:-]*:$/.test(line))
    .map((line) => line.slice(0, -1))
    .filter((name) => !KEYWORDS.includes(name));

/** `KEY: value` lines of a top-level `variables:`, quotes taken off. */
function variablesOf(text) {
  const found = {};
  for (const line of block(text, 'variables') ?? []) {
    const match = /^ {2}([A-Z_][A-Z0-9_]*): (.*)$/.exec(line);
    if (match) found[match[1]] = match[2].replace(/^'(.*)'$/, '$1');
  }
  return found;
}

/** The list under `<indent>key:` in a block's lines, or null when there is no such key. */
function listUnder(lines, key, indent) {
  const at = lines.indexOf(`${' '.repeat(indent)}${key}:`);
  if (at < 0) return null;
  const items = [];
  for (const line of lines.slice(at + 1)) {
    const match = new RegExp(`^ {${indent + 2}}- (.*)$`).exec(line);
    if (!match) break;
    items.push(match[1]);
  }
  return items;
}

const tagsOfJob = (text, job) => listUnder(block(text, job) ?? [], 'tags', 2);

/**
 * Whether a job runs in merge request pipelines alone: every rule it lists is
 * `if: $CI_PIPELINE_SOURCE == 'merge_request_event'`, with or without
 * `changes:` under it, so no pipeline on main creates it. No job of
 * .gitlab-ci.yml is one today; a job added for merge requests alone is
 * placed by it.
 */
function mergeRequestOnly(text, job) {
  const lines = block(text, job) ?? [];
  const at = lines.indexOf('  rules:');
  if (at < 0) return false;
  const after = lines.slice(at + 1);
  const end = after.findIndex((line) => /^ {2}\S/.test(line));
  const rules = after.slice(0, end < 0 ? after.length : end).filter((line) => /^ {4}- /.test(line));
  return (
    rules.length > 0 &&
    rules.every((line) => line === "    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'")
  );
}
const defaultTags = (text) => listUnder(block(text, 'default') ?? [], 'tags', 2);

/** A trigger job's inherited top-level variables: all, or the listed ones. */
function forwarded(text, job, topLevel) {
  const lines = block(text, job);
  const at = lines.indexOf('  inherit:');
  const listed = at < 0 ? null : listUnder(lines.slice(at + 1), 'variables', 4);
  const own = listUnder(lines, 'variables', 2);
  assert.equal(own, null, `${job} passes variables of its own; the model does not read them`);
  if (listed === null) return { ...topLevel };
  return Object.fromEntries(Object.entries(topLevel).filter(([key]) => listed.includes(key)));
}

/** The tags a job is given, as GitLab expands them. */
function expand(tags, variables) {
  const expanded = tags
    .map((tag) =>
      tag.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name) =>
        Object.hasOwn(variables, name) ? variables[name] : whole,
      ),
    )
    .join(', ')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
  return [...new Set(expanded)];
}

/** A proven tree's decision, for the child pipeline that holds the proof job alone. */
const PROOF = {
  proven: true,
  facts: {
    head: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    base: 'c'.repeat(40),
    mergedHead: 'd'.repeat(40),
    iid: 198,
    pipeline: 1,
    previousPipeline: 2,
  },
};

/**
 * Every job of each pipeline that a runner takes, with the project's CI/CD
 * variables `project` and, for the child pipeline, the files as given: its
 * key (`<pipeline> <job>`), the text it is read from, the variables it is
 * expanded against and the default tags it falls back on.
 */
function placedJobs(project, { ci = CI, validate = VALIDATE } = {}) {
  const ciVariables = variablesOf(ci);
  const placed = [];
  const place = (pipeline, text, jobs, yaml, passed = {}) => {
    const variables = { ...yaml, ...project, ...passed };
    const fallback = defaultTags(text) ?? [];
    for (const job of jobs)
      placed.push({ key: `${pipeline} ${job}`, job, text, variables, fallback });
  };

  // A merge request pipeline: .gitlab-ci.yml with the validate stage
  // included, the including file's keys winning.
  const mergedVariables = { ...variablesOf(validate), ...ciVariables, ...project };
  const mergedDefault = defaultTags(ci) ?? defaultTags(validate) ?? [];
  for (const job of [...jobsOf(validate), 'image:backend', 'image:frontend', 'image:postgres']) {
    const text = jobsOf(validate).includes(job) ? validate : ci;
    placed.push({
      key: `merge-request ${job}`,
      job,
      text,
      variables: mergedVariables,
      fallback: mergedDefault,
    });
  }

  // The parent pipeline on main; `main-validation` is a trigger job, which no
  // runner takes, and a job for merge requests alone is not created there.
  place(
    'main',
    ci,
    jobsOf(ci).filter((job) => job !== 'main-validation' && !mergeRequestOnly(ci, job)),
    ciVariables,
  );

  // Its child: the validate stage when nothing is proven, the proof job when
  // the tree is proven; either way with what `main-validation` passes on.
  const passed = forwarded(ci, 'main-validation', ciVariables);
  const full = childConfig({ proven: false, reason: 'a direct push' }, validate, 'a'.repeat(40));
  place('child', full, jobsOf(full), variablesOf(full), passed);
  const proof = childConfig(PROOF, validate, 'a'.repeat(40));
  place('child', proof, jobsOf(proof), variablesOf(proof), passed);
  return placed;
}

/**
 * Every job of each pipeline and the tags it gets, with the project's CI/CD
 * variables `project` and, for the child pipeline, the files as given.
 */
function pipelines(project, files = {}) {
  return Object.fromEntries(
    placedJobs(project, files).map(({ key, job, text, variables, fallback }) => [
      key,
      expand(tagsOfJob(text, job) ?? fallback, variables),
    ]),
  );
}

/** What every job should get when the moved jobs go to `tag`, and deploy to `deploy`. */
function expected(tag, deploy = DEPLOY) {
  const moved = [
    ...jobsOf(VALIDATE).map((job) => `merge-request ${job}`),
    'merge-request image:backend',
    'merge-request image:frontend',
    'merge-request image:postgres',
    'main main-validation-gate',
    'main image:backend',
    'main image:frontend',
    'main image:postgres',
    ...jobsOf(VALIDATE).map((job) => `child ${job}`),
    `child ${PROOF_JOB}`,
  ];
  return {
    ...Object.fromEntries(moved.map((job) => [job, [tag]])),
    'main deploy': [deploy],
    'main deployment-smoke': [SHARED],
  };
}

// The rules of `image:postgres` (D084), evaluated as GitLab does: in
// order, the first rule whose `if:` holds and whose `changes:`, when it has
// one, match a changed path decides, `when: never` leaving the job out and any
// other rule creating it; a job no rule matches is not created. An `if:` is
// read for `$VAR == 'text'` and `$VAR == $VAR` joined by `&&` alone, a
// variable that is not set being null; anything else is refused rather than
// guessed at. Paths match as rules:changes matches them (test-inputs.mjs).

/** A job's `rules:` as `{ if, when, changes }`, `changes` null when the rule has none. */
function rulesOf(lines) {
  const at = lines.indexOf('  rules:');
  assert.ok(at >= 0, 'the job has no rules:');
  const rules = [];
  let list = null;
  for (const line of lines.slice(at + 1)) {
    let match;
    if (/^ {2}\S/.test(line)) break;
    if ((match = /^ {4}- if: (.+)$/.exec(line))) {
      rules.push({ if: match[1], when: 'on_success', changes: null });
      list = null;
    } else if ((match = /^ {6}when: (\w+)$/.exec(line)) && rules.length > 0) {
      rules.at(-1).when = match[1];
    } else if (line === '      changes:' && rules.length > 0) {
      list = rules.at(-1).changes = [];
    } else if ((match = /^ {8}- (.+)$/.exec(line)) && list !== null) {
      list.push(match[1]);
    } else {
      assert.fail(`a line of rules: the model does not read: ${line}`);
    }
  }
  return rules;
}

/** Whether an `if:` expression holds for these variables. */
function holds(expression, variables) {
  return expression.split(' && ').every((part) => {
    const match = /^\$([A-Z_][A-Z0-9_]*) == (?:'([^']*)'|\$([A-Z_][A-Z0-9_]*))$/.exec(part);
    assert.ok(match, `an expression the model does not read: ${part}`);
    const value = (name) => variables[name] ?? null;
    return value(match[1]) === (match[3] === undefined ? match[2] : value(match[3]));
  });
}

/** Whether a pipeline with these variables and changed paths creates the job. */
function creates(rules, variables, changed) {
  for (const rule of rules) {
    if (!holds(rule.if, variables)) continue;
    if (rule.changes !== null) {
      const patterns = compile(rule.changes);
      if (!changed.some((path) => matches(patterns, path))) continue;
    }
    return rule.when !== 'never';
  }
  return false;
}

test('image:postgres is built when deploy/postgres/ changes, in a merge request and on main (D084)', () => {
  const rules = rulesOf(block(CI, 'image:postgres'));
  assert.deepEqual(rules, [
    {
      if: "$CI_PIPELINE_SOURCE == 'merge_request_event'",
      when: 'on_success',
      changes: ['deploy/postgres/**/*'],
    },
    {
      if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH',
      when: 'on_success',
      changes: ['deploy/postgres/**/*'],
    },
  ]);
  // A merge request pipeline sets no CI_COMMIT_BRANCH; a push sets it to the
  // branch pushed.
  const request = {
    CI_PIPELINE_SOURCE: 'merge_request_event',
    CI_DEFAULT_BRANCH: 'main',
  };
  const main = {
    CI_PIPELINE_SOURCE: 'push',
    CI_COMMIT_BRANCH: 'main',
    CI_DEFAULT_BRANCH: 'main',
  };
  const branch = {
    CI_PIPELINE_SOURCE: 'push',
    CI_COMMIT_BRANCH: 'chore/x',
    CI_DEFAULT_BRANCH: 'main',
  };
  const image = ['deploy/postgres/Dockerfile'];
  const other = ['apps/backend/src/server.ts', 'deploy/helm/qa-tools/values.yaml'];
  for (const [label, variables, changed, expected] of [
    ["the import's merge request, where everything is new", request, [...image, ...other], true],
    ['a merge request changing the database image', request, image, true],
    [
      'a merge request changing a file under deploy/postgres/ deeper down',
      request,
      ['deploy/postgres/initdb/x.sql'],
      true,
    ],
    ['a merge request changing other files', request, other, false],
    [
      'a merge request changing a name that only starts like it',
      request,
      ['deploy/postgres-old/Dockerfile'],
      false,
    ],
    ['a change of the database image on main', main, image, true],
    ['a pipeline on main changing other files', main, other, false],
    ['a branch pipeline outside a merge request', branch, image, false],
  ]) {
    assert.equal(creates(rules, variables, changed), expected, label);
  }
  // The model refuses what it does not read, rather than guess.
  assert.throws(() => holds("$A == 'x' || $B == 'y'", {}), /does not read/);
  assert.throws(() => holds('$A =~ /x/', {}), /does not read/);
  assert.throws(() => rulesOf(['  rules:', '    - changes: [x]']), /does not read/);
});

test('the jobs of the pipeline are the ones this file places', () => {
  assert.deepEqual(jobsOf(CI).sort(), [
    'deploy',
    'deployment-smoke',
    'image:backend',
    'image:frontend',
    'image:postgres',
    'main-validation',
    'main-validation-gate',
  ]);
  // Every job of the file runs on main too.
  assert.deepEqual(
    jobsOf(CI).filter((job) => mergeRequestOnly(CI, job)),
    [],
  );
  assert.deepEqual(jobsOf(VALIDATE).sort(), [
    'chart',
    'delivery-checks',
    'e2e',
    'lint',
    'native-ts',
    'operations-tests',
    'test',
    'typecheck',
  ]);
});

test("with no project variable every validate and build job runs on the shared runners, and deploy waits for a runner tagged with its variable's literal name, which none is (#367)", () => {
  assert.deepEqual(pipelines({}), expected(SHARED, `$${DEPLOY_TAG_VARIABLE}`));
});

test("production's project variables put those jobs on our runner, the child on main among them, and deploy on the production runner; the runner tag alone moves them to the shared runners and back, and deleting it leaves them there (D258, #367)", () => {
  assert.deepEqual(pipelines(PRODUCTION), expected(OURS));
  assert.deepEqual(pipelines({ ...PRODUCTION, [RUNNER_TAG_VARIABLE]: SHARED }), expected(SHARED));
  assert.deepEqual(
    pipelines({ ...PRODUCTION, [RUNNER_TAG_VARIABLE]: 'saas-linux-medium-amd64' }),
    expected('saas-linux-medium-amd64'),
  );
  assert.deepEqual(pipelines(PRODUCTION), expected(OURS));
  assert.deepEqual(pipelines({ [DEPLOY_TAG_VARIABLE]: DEPLOY }), expected(SHARED));
});

test("the trigger job passes on the validate stage's variables and not the runner tag", () => {
  const passed = forwarded(CI, 'main-validation', variablesOf(CI));
  assert.deepEqual(Object.keys(passed).sort(), ['NODE_IMAGE', 'POSTGRES_IMAGE_TAG']);
  // Everything else at the top level of .gitlab-ci.yml is the runner tag: a
  // new variable the validate stage reads is added to the list, or the child
  // pipeline goes without it.
  assert.deepEqual(
    Object.keys(variablesOf(CI)).sort(),
    ['NODE_IMAGE', 'POSTGRES_IMAGE_TAG', RUNNER_TAG_VARIABLE].sort(),
  );
});

test('the model sees the faults it guards against', () => {
  // A trigger job passing every variable on: the child stays on the file's
  // default, the shared runners, while the project variable sends everything
  // else to our runner.
  const passingAll = CI.replace(
    '  inherit:\n    variables:\n      - NODE_IMAGE\n      - POSTGRES_IMAGE_TAG\n',
    '',
  );
  assert.notEqual(passingAll, CI, 'the inherit list is where the test looks for it');
  const leaked = pipelines(PRODUCTION, { ci: passingAll });
  assert.deepEqual(leaked['child lint'], [SHARED]);
  assert.deepEqual(leaked[`child ${PROOF_JOB}`], [SHARED]);
  assert.deepEqual(leaked['main image:backend'], [OURS]);

  // The child without its own default: its jobs wait for a runner tagged
  // with the variable's literal name, which none is — never untagged.
  const noDefault = VALIDATE.replace(`variables:\n  ${RUNNER_TAG_VARIABLE}: '${SHARED}'\n`, '');
  assert.notEqual(noDefault, VALIDATE);
  assert.deepEqual(pipelines({}, { validate: noDefault })['child lint'], [
    `$${RUNNER_TAG_VARIABLE}`,
  ]);

  // An empty project variable drops the tag: the jobs go untagged to the
  // shared runners, which is why the runbook says to delete it, never empty
  // it, and the check reports it.
  const empty = pipelines({ ...PRODUCTION, [RUNNER_TAG_VARIABLE]: '' });
  assert.deepEqual(empty['merge-request lint'], []);
  assert.deepEqual(empty['child e2e'], []);
  assert.deepEqual(empty['main deploy'], [DEPLOY]);
});

test('both files hold the same default, the one the gate writes into the proof', () => {
  assert.equal(RUNNER_TAG_DEFAULT, SHARED);
  assert.equal(variablesOf(CI)[RUNNER_TAG_VARIABLE], SHARED);
  assert.equal(variablesOf(VALIDATE)[RUNNER_TAG_VARIABLE], SHARED);
  assert.deepEqual(defaultTags(CI), [`$${RUNNER_TAG_VARIABLE}`]);
  assert.deepEqual(defaultTags(VALIDATE), [`$${RUNNER_TAG_VARIABLE}`]);
  // Tags are set in `default:` only, but for the two jobs that leave our
  // runner on purpose; no template sets any.
  for (const job of jobsOf(VALIDATE)) assert.equal(tagsOfJob(VALIDATE, job), null, job);
  for (const template of ['.node', '.postgres-ready', '.image']) {
    for (const text of [CI, VALIDATE]) {
      assert.equal(listUnder(block(text, template) ?? [], 'tags', 2), null, template);
    }
  }
  for (const job of jobsOf(CI).filter((name) => !['deploy', 'deployment-smoke'].includes(name))) {
    assert.equal(tagsOfJob(CI, job), null, job);
  }
  assert.deepEqual(tagsOfJob(CI, 'deploy'), [`$${DEPLOY_TAG_VARIABLE}`]);
  assert.deepEqual(tagsOfJob(CI, 'deployment-smoke'), [SHARED]);
});

// KUBECONFIG_DEPLOYER is a protected project variable: every job of a
// pipeline on main receives it unless it is scoped to an environment, and
// scoped to `production` only `deploy`, the one job declaring it, does (D093,
// D258). A second job with an environment would receive it too, and it would
// run on our runner; so would one that names the variable. A key of a hidden
// template, of `default:` or of the top-level `variables:` reaches every job
// that takes it, so the whole of each file is read, not its jobs alone.
const CREDENTIAL = 'KUBECONFIG_DEPLOYER';

/**
 * Each top-level block of a YAML file, comments and blank lines left out: its
 * key, quotes taken off, and its lines, the key's own line among them. Jobs,
 * hidden templates and keywords alike; lines before any key are a block of
 * their own, named ''.
 */
function topLevelBlocks(text) {
  const blocks = [];
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (/^\S/.test(line) || blocks.length === 0) {
      const key = /^(\S.*?)\s*:(\s|$)/.exec(line)?.[1] ?? '';
      blocks.push({
        name: /^\s/.test(line) ? '' : key.replace(/^(['"])(.*)\1$/, '$2'),
        lines: [line],
      });
    } else {
      blocks.at(-1).lines.push(line);
    }
  }
  return blocks;
}

/** An `environment` key in any form: block or flow, plain or quoted, any depth. */
const ENVIRONMENT_KEY = /(^|[\s{,[-])(environment\s*:(\s|$)|(['"])environment\4\s*:)/;

/** A YAML anchor on a key's value or a list item: `key: &name`, `- &name`. */
const ANCHOR = /(:\s+|^\s*-\s+|^\s*)&[^\s&]/;

/** The jobs and templates a block's lines take keys from, through `extends:` or `!reference`. */
function inheritedFrom(lines) {
  const names = [];
  const unquote = (name) => name.trim().replace(/^(['"])(.*)\1$/, '$2');
  lines.forEach((line, at) => {
    const extend = /^\s*extends\s*:\s*(.*)$/.exec(line);
    if (extend && extend[1] !== '') {
      names.push(
        ...extend[1]
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map(unquote),
      );
    } else if (extend) {
      for (const item of lines.slice(at + 1)) {
        const listed = /^\s*-\s+(.*)$/.exec(item);
        if (!listed) break;
        names.push(unquote(listed[1]));
      }
    }
    for (const reference of line.matchAll(/!reference\s*\[\s*([^,\]]+)/g)) {
      names.push(unquote(reference[1]));
    }
  });
  return names;
}

/**
 * What lets the deploy credential reach a job other than `deploy`, in the
 * files as given: `deploy` of the first may name it and declare an
 * environment; nothing else of any of them may, nor take `deploy`'s keys.
 */
function credentialProblems(files) {
  const problems = [];
  const [[deployFile]] = files;
  for (const [file, text] of files) {
    for (const { name, lines } of topLevelBlocks(text)) {
      const where = `${file} ${name === '' ? 'before any key' : name}`;
      if (file === deployFile && name === 'deploy') {
        if (lines.some((line) => ANCHOR.test(line))) problems.push(`${where} holds a YAML anchor`);
        continue;
      }
      if (lines.some((line) => line.includes(CREDENTIAL)))
        problems.push(`${where} names ${CREDENTIAL}`);
      if (lines.some((line) => ENVIRONMENT_KEY.test(line))) {
        problems.push(`${where} declares an environment`);
      }
      if (inheritedFrom(lines).includes('deploy')) problems.push(`${where} takes keys of deploy`);
    }
  }
  return problems;
}

/** The pipeline files and the child pipelines `childConfig` writes from `validate`, `.gitlab-ci.yml` first. */
const credentialFiles = ({ ci = CI, validate = VALIDATE } = {}) => [
  ['.gitlab-ci.yml', ci],
  ['.gitlab/ci/validate.yml', validate],
  ['the child', childConfig({ proven: false, reason: 'a direct push' }, validate, 'a'.repeat(40))],
  ['the proof child', childConfig(PROOF, validate, 'a'.repeat(40))],
];

test("the deploy credential is the deploy job's alone: nothing else in the pipeline files names it or declares an environment", () => {
  assert.deepEqual(credentialProblems(credentialFiles()), []);
  const deploy = block(CI, 'deploy');
  assert.ok(deploy.some((line) => line.includes(CREDENTIAL)));
  assert.ok(deploy.includes('  environment:'));
  assert.ok(deploy.includes('    name: production'));
  // Every top-level key of both files is read: the jobs, the templates and
  // the keywords.
  assert.deepEqual(
    topLevelBlocks(VALIDATE)
      .map((each) => each.name)
      .filter((name) => !jobsOf(VALIDATE).includes(name))
      .sort(),
    ['.node', '.postgres-ready', 'default', 'stages', 'variables'],
  );
  assert.deepEqual(
    topLevelBlocks(CI)
      .map((each) => each.name)
      .filter((name) => !jobsOf(CI).includes(name))
      .sort(),
    ['.image', '.inspector-address', 'default', 'include', 'stages', 'variables', 'workflow'],
  );
});

test('the credential check sees each way of handing the credential to another job', () => {
  // [the fault, the file edited, what is replaced, its replacement, the problem reported]
  const faults = [
    [
      'an environment on .image',
      'ci',
      '.image:\n',
      '.image:\n  environment:\n    name: review\n',
      '.gitlab-ci.yml .image declares an environment',
    ],
    [
      'an environment on a job, in one line',
      'validate',
      'lint:\n',
      'lint:\n  environment: production\n',
      '.gitlab/ci/validate.yml lint declares an environment',
    ],
    [
      'an environment on .node, read in the child too',
      'validate',
      '.node:\n',
      '.node:\n  environment: production\n',
      'the child .node declares an environment',
    ],
    [
      'an environment in default:',
      'ci',
      'default:\n',
      'default:\n  environment: production\n',
      '.gitlab-ci.yml default declares an environment',
    ],
    [
      'a flow environment',
      'ci',
      'image:backend:\n',
      'image:backend:\n  environment: { name: review }\n',
      '.gitlab-ci.yml image:backend declares an environment',
    ],
    [
      'a quoted environment',
      'ci',
      'image:frontend:\n',
      "image:frontend:\n  'environment': production\n",
      '.gitlab-ci.yml image:frontend declares an environment',
    ],
    [
      'the credential in the top-level variables',
      'ci',
      'variables:\n',
      `variables:\n  KUBE: $${CREDENTIAL}\n`,
      `.gitlab-ci.yml variables names ${CREDENTIAL}`,
    ],
    [
      'the credential in a template',
      'validate',
      '.postgres-ready:\n',
      `.postgres-ready:\n  variables:\n    KUBECONFIG: $${CREDENTIAL}\n`,
      `.gitlab/ci/validate.yml .postgres-ready names ${CREDENTIAL}`,
    ],
    [
      'a second deploy job',
      'ci',
      'deployment-smoke:\n',
      `deploy-again:\n  variables:\n    KUBECONFIG: $${CREDENTIAL}\n\ndeployment-smoke:\n`,
      `.gitlab-ci.yml deploy-again names ${CREDENTIAL}`,
    ],
    [
      'a job extending deploy',
      'ci',
      'deployment-smoke:\n',
      'deployment-smoke:\n  extends: deploy\n',
      '.gitlab-ci.yml deployment-smoke takes keys of deploy',
    ],
    [
      'a job extending deploy, listed',
      'ci',
      'deployment-smoke:\n',
      "deployment-smoke:\n  extends:\n    - .x\n    - 'deploy'\n",
      '.gitlab-ci.yml deployment-smoke takes keys of deploy',
    ],
    [
      "a reference to deploy's variables",
      'ci',
      'deployment-smoke:\n',
      'deployment-smoke:\n  variables: !reference [deploy, variables]\n',
      '.gitlab-ci.yml deployment-smoke takes keys of deploy',
    ],
    [
      'an anchor on deploy',
      'ci',
      'deploy:\n  stage: deploy\n',
      'deploy: &deploy\n  stage: deploy\n',
      '.gitlab-ci.yml deploy holds a YAML anchor',
    ],
    [
      'an anchor in deploy',
      'ci',
      '  environment:\n    name: production',
      '  environment: &production\n    name: production',
      '.gitlab-ci.yml deploy holds a YAML anchor',
    ],
  ];
  for (const [fault, file, from, to, problem] of faults) {
    const original = file === 'ci' ? CI : VALIDATE;
    const edited = original.replace(from, to);
    assert.notEqual(edited, original, `${fault}: the edit found nothing to change`);
    assert.ok(
      credentialProblems(credentialFiles({ [file]: edited })).includes(problem),
      `${fault}: ${JSON.stringify(credentialProblems(credentialFiles({ [file]: edited })))}`,
    );
  }
  // A deploy job in the validate stage is not the deploy job.
  assert.deepEqual(
    credentialProblems([
      ['.gitlab-ci.yml', ''],
      ['.gitlab/ci/validate.yml', 'deploy:\n  environment: production\n'],
    ]),
    ['.gitlab/ci/validate.yml deploy declares an environment'],
  );
  // Comments are not read, and a variable whose name holds the word is not one.
  assert.deepEqual(
    credentialProblems([
      [
        '.gitlab-ci.yml',
        `job:\n  # ${CREDENTIAL}, environment: production\n  script:\n    - echo "$CI_ENVIRONMENT_NAME"\n`,
      ],
    ]),
    [],
  );
});

test('the model reads tags as GitLab does: literal names kept, commas split, blanks dropped', () => {
  assert.deepEqual(expand(['$A'], {}), ['$A']);
  assert.deepEqual(expand(['${A}'], { A: 'x' }), ['x']);
  assert.deepEqual(expand(['$A'], { A: 'x, y' }), ['x', 'y']);
  assert.deepEqual(expand(['$A', 'x'], { A: 'x' }), ['x']);
  assert.deepEqual(expand(['$A'], { A: '  ' }), []);
  assert.deepEqual(expand(['$A'], { A: '$B' }), ['$B'], 'a value is not expanded again');
});

// The image builds' Docker daemon pulls Docker Hub's images through Google's
// public mirror of Docker Hub (D258):
// on our runner every pull comes from its server's one address, and Docker
// Hub allows 100 anonymous pulls per 6 hours per address. The daemon is the
// `docker:29-dind` service of `.image`, which the image jobs take through
// `extends:`. GitLab merges a template's keys into a job's, but a
// list the job sets replaces the template's whole, so a job with `services:`
// of its own would start a daemon without the flag.
const MIRROR = 'https://mirror.gcr.io';
const DIND = { name: 'docker:29-dind', command: ['--registry-mirror', MIRROR] };

/** A flow sequence of quoted strings, `['a', "b"]`, as a list; anything else as null. */
function flowList(text) {
  const match = /^\[(.*)\]$/.exec(text.trim());
  if (!match) return null;
  const items = match[1].split(',').map((item) => item.trim());
  if (!items.every((item) => /^'[^']*'$|^"[^"]*"$/.test(item))) return null;
  return items.map((item) => item.slice(1, -1));
}

/**
 * The `services:` of a block's lines: each entry an object with its `name`
 * and the keys under it, a plain string read as the name; null when there is
 * no such key.
 */
function servicesOf(lines) {
  const at = lines.indexOf('  services:');
  if (at < 0) return null;
  const services = [];
  for (const line of lines.slice(at + 1)) {
    const entry = /^ {4}- (.*)$/.exec(line);
    const key = /^ {6}([a-z_]+): (.*)$/.exec(line);
    if (entry) {
      const named = /^name: (.*)$/.exec(entry[1]);
      services.push({ name: named ? named[1] : entry[1] });
    } else if (key && services.length > 0) {
      services.at(-1)[key[1]] = key[1] === 'command' ? flowList(key[2]) : key[2];
    } else {
      break;
    }
  }
  return services;
}

/** What keeps an image job's Docker daemon off the mirror, in `text`. */
function mirrorProblems(text) {
  const problems = [];
  const template = block(text, '.image');
  if (template === null) return ['there is no .image'];
  const services = servicesOf(template);
  try {
    assert.deepEqual(services, [DIND]);
  } catch {
    problems.push(`.image starts ${JSON.stringify(services)}, not ${JSON.stringify([DIND])}`);
  }
  if (!template.includes("    DOCKER_TLS_CERTDIR: '/certs'")) {
    problems.push('.image no longer sets DOCKER_TLS_CERTDIR to /certs');
  }
  const images = jobsOf(text).filter((job) => block(text, job).includes('  extends: .image'));
  for (const job of images) {
    if (servicesOf(block(text, job)) !== null) problems.push(`${job} sets services of its own`);
  }
  for (const job of jobsOf(text).filter((name) => !images.includes(name))) {
    if (block(text, job).some((line) => line.includes('-dind'))) {
      problems.push(`${job} starts a Docker daemon outside .image`);
    }
  }
  if (servicesOf(block(text, 'default') ?? []) !== null) problems.push('default sets services');
  return problems;
}

test("the image builds' Docker daemon pulls Docker Hub's images through mirror.gcr.io", () => {
  assert.deepEqual(mirrorProblems(CI), []);
  assert.deepEqual(
    jobsOf(CI)
      .filter((job) => block(CI, job).includes('  extends: .image'))
      .sort(),
    ['image:backend', 'image:frontend', 'image:postgres'],
  );
  // The validate stage starts no Docker daemon of its own.
  assert.equal(
    VALIDATE.split('\n').some((line) => !/^\s*#/.test(line) && line.includes('-dind')),
    false,
  );
  // The registry login stays as it was: GitLab's registry, with the job's own
  // credentials, which the mirror has nothing to do with.
  assert.deepEqual(listUnder(block(CI, '.image'), 'before_script', 2), [
    'docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"',
  ]);
});

test('the mirror check sees each way of losing the mirror', () => {
  const service = `    - name: docker:29-dind\n      command: ['--registry-mirror', '${MIRROR}']\n`;
  assert.ok(CI.includes(service), 'the service is where the test looks for it');
  const faults = {
    'the flag removed': CI.replace(service, '    - docker:29-dind\n'),
    'another mirror': CI.replace(MIRROR, 'https://mirror.example.com'),
    'the flag and its value in one string': CI.replace(
      `['--registry-mirror', '${MIRROR}']`,
      `['--registry-mirror=${MIRROR}']`,
    ),
    'a second daemon': CI.replace(service, `${service}    - docker:29-dind\n`),
    'a job with services of its own': CI.replace(
      'image:frontend:\n  extends: .image\n',
      'image:frontend:\n  extends: .image\n  services:\n    - docker:29-dind\n',
    ),
    'TLS turned off': CI.replace("DOCKER_TLS_CERTDIR: '/certs'", "DOCKER_TLS_CERTDIR: ''"),
    'a daemon outside .image': CI.replace(
      'deployment-smoke:\n',
      'deployment-smoke:\n  services:\n    - docker:29-dind\n',
    ),
  };
  for (const [fault, text] of Object.entries(faults)) {
    assert.notEqual(text, CI, `${fault}: the edit found nothing to change`);
    assert.notDeepEqual(mirrorProblems(text), [], fault);
  }
  assert.deepEqual(flowList('[\'a\', "b"]'), ['a', 'b']);
  assert.equal(flowList('[a, b]'), null);
  assert.equal(flowList("'a'"), null);
});

// `test` and `e2e` take turns (#266, D258's amendment): side by side on our
// runner's 4 shared vCPU they failed load-sensitive tests, so both hold one
// resource group, and GitLab starts a job of a group only while no other job
// of it runs. A group is project-wide, so one key holds across the merge
// request pipelines and the child pipeline on main. It is named after the
// runner tag, so the jobs the switch sends to the shared runners take turns
// in a group of their own, not behind a job left on our runner, and the
// pipeline under the switch runs and passes as before, one heavy job at a
// time. No other job holds a group but `deploy`, whose `production` is its
// own; no trigger job holds one, which is how a parent and its child would
// wait for each other (GitLab's "Avoid dead locks in pipeline
// configurations"); and no template or `default:` sets one, which would
// reach every job that takes it.
//
// The model, from GitLab's documentation (doc/ci/resource_groups;
// doc/ci/variables/where_variables_can_be_used.md, `resource_group`, read on
// 2026-10-23): the key is expanded when the pipeline is created against the
// job's variables, the project's CI/CD variables among them, as
// `environment:url` is, a name it does not know expanding to nothing; a job
// takes a template's keys through `extends:` unless it sets its own; and the
// key holds only letters, digits, `-`, `_`, `/`, `$`, `{`, `}`, `.` and
// spaces, and neither starts nor ends with `/`.
const HEAVY_JOBS = ['test', 'e2e'];
const HEAVY_GROUP = `heavy-tests-$${RUNNER_TAG_VARIABLE}`;
const DEPLOY_GROUP = 'production';
const GROUP_KEY = /^(?!\/)[A-Za-z0-9_/${}. -]{1,255}(?<!\/)$/;

/**
 * The `resource_group:` a block holds, its own or one it takes from a block
 * of the same text through `extends:` or `!reference`, quotes taken off and
 * unexpanded; null when none does.
 */
function groupOfJob(text, job, seen = new Set([job])) {
  const lines = block(text, job) ?? [];
  for (const line of lines) {
    const own = /^ {2}resource_group:\s*(.*)$/.exec(line);
    if (own) return own[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  for (const name of inheritedFrom(lines)) {
    if (seen.has(name) || block(text, name) === null) continue;
    seen.add(name);
    const found = groupOfJob(text, name, seen);
    if (found !== null) return found;
  }
  return null;
}

/** A resource group's key as GitLab expands it: a name it does not know becomes nothing. */
const expandGroup = (key, variables) =>
  key.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name) =>
    Object.hasOwn(variables, name) ? variables[name] : '',
  );

/** Every job of each pipeline and the resource group it holds, expanded, or null. */
function groups(project, files = {}) {
  return Object.fromEntries(
    placedJobs(project, files).map(({ key, job, text, variables }) => {
      const group = groupOfJob(text, job);
      return [key, group === null ? null : expandGroup(group, variables)];
    }),
  );
}

/** The switch's values the pins run under: production's, the fallback, a larger shared machine. */
const SWITCH = [
  [OURS, PRODUCTION],
  [SHARED, { ...PRODUCTION, [RUNNER_TAG_VARIABLE]: SHARED }],
  ['saas-linux-medium-amd64', { ...PRODUCTION, [RUNNER_TAG_VARIABLE]: 'saas-linux-medium-amd64' }],
];

/** What every job should hold when the moved jobs go to `tag`. */
function expectedGroups(tag) {
  const holders = HEAVY_JOBS.flatMap((job) => [`merge-request ${job}`, `child ${job}`]);
  return Object.fromEntries(
    Object.keys(expected(tag)).map((key) => [
      key,
      holders.includes(key) ? `heavy-tests-${tag}` : key === 'main deploy' ? DEPLOY_GROUP : null,
    ]),
  );
}

/** What lets `test` and `e2e` run at the same time, or anything wait on itself, in the files as given. */
function heavyProblems(files = {}) {
  const { ci = CI, validate = VALIDATE } = files;
  const problems = [];
  const want = HEAVY_JOBS.flatMap((job) => [`child ${job}`, `merge-request ${job}`]).sort();
  const heavyKeys = [];
  for (const [tag, project] of SWITCH) {
    const found = groups(project, files);
    const tags = pipelines(project, files);
    const held = Object.entries(found).filter(
      ([key, group]) => group !== null && key !== 'main deploy',
    );
    const holders = held.map(([key]) => key).sort();
    if (holders.join() !== want.join()) {
      problems.push(
        `with ${tag}: ${holders.join(', ') || 'no job'} hold a group, not ${want.join(', ')}`,
      );
    }
    const keys = [...new Set(held.map(([, group]) => group))];
    if (keys.length > 1)
      problems.push(`with ${tag}: the jobs hold different groups: ${keys.join(', ')}`);
    for (const key of keys) {
      if (!GROUP_KEY.test(key))
        problems.push(`with ${tag}: ${JSON.stringify(key)} is not a key GitLab takes`);
      if (key === DEPLOY_GROUP)
        problems.push(`with ${tag}: the jobs wait behind deploy's ${DEPLOY_GROUP}`);
    }
    if (found['main deploy'] !== DEPLOY_GROUP) {
      problems.push(`with ${tag}: deploy holds ${found['main deploy']}, not ${DEPLOY_GROUP}`);
    }
    for (const [key] of held) {
      if (tags[key].join() !== tag)
        problems.push(`with ${tag}: ${key} runs on ${tags[key].join()}`);
    }
    heavyKeys.push(keys.join());
  }
  if (new Set(heavyKeys).size !== heavyKeys.length) {
    problems.push(`the shared runners' jobs take turns with ours: ${heavyKeys.join(' / ')}`);
  }
  if (groupOfJob(ci, 'main-validation') !== null) problems.push('the trigger job holds a group');
  const children = [
    childConfig({ proven: false, reason: 'a direct push' }, validate, 'a'.repeat(40)),
    childConfig(PROOF, validate, 'a'.repeat(40)),
  ];
  for (const text of [ci, validate, ...children]) {
    for (const { name, lines } of topLevelBlocks(text)) {
      if (!(name.startsWith('.') || KEYWORDS.includes(name) || name === '')) continue;
      if (lines.some((line) => /^\s*resource_group\s*:/.test(line))) {
        problems.push(`${name || 'the top'} sets a resource group`);
      }
    }
  }
  return problems;
}

test('test and e2e hold one resource group, named after the runner tag, in the merge request pipeline and the child on main', () => {
  assert.deepEqual(heavyProblems(), []);
  for (const job of HEAVY_JOBS) assert.equal(groupOfJob(VALIDATE, job), HEAVY_GROUP, job);
  assert.equal(groupOfJob(CI, 'deploy'), DEPLOY_GROUP);
  for (const [tag, project] of SWITCH) {
    assert.deepEqual(groups(project), expectedGroups(tag), tag);
  }
  // Under the switch the pipeline is the same one, its heavy jobs on the
  // shared runners taking turns in their own group.
  const shared = groups({ ...PRODUCTION, [RUNNER_TAG_VARIABLE]: SHARED });
  assert.equal(shared['merge-request e2e'], 'heavy-tests-saas-linux-small-amd64');
  assert.deepEqual(pipelines({ ...PRODUCTION, [RUNNER_TAG_VARIABLE]: SHARED })['child e2e'], [
    SHARED,
  ]);
  assert.equal(groups(PRODUCTION)['child test'], 'heavy-tests-qa-tools-ci');
  // With no project variable at all, as on the shared runners.
  assert.deepEqual(groups({}), expectedGroups(SHARED));
  // The script-test groups and the light jobs take the second place.
  for (const job of jobsOf(VALIDATE).filter((name) => !HEAVY_JOBS.includes(name))) {
    assert.equal(groupOfJob(VALIDATE, job), null, job);
  }
});

test('the resource group check sees each way of letting the two run together or wait on themselves', () => {
  const line = `  resource_group: ${HEAVY_GROUP}\n`;
  const e2eLine = `  # time. Waiting for its turn delays this job and skips nothing.\n${line}`;
  assert.ok(VALIDATE.includes(e2eLine), 'the e2e line is where the test looks for it');
  const both = (key) => `  resource_group: ${key}\n`;
  // [the fault, the file edited, what is replaced wherever it stands, its replacement]
  const faults = [
    ['e2e without the group', 'validate', e2eLine, ''],
    ['test without the group', 'validate', `holding another.\n${line}`, 'holding another.\n'],
    ['e2e in a group of its own', 'validate', e2eLine, e2eLine.replace('heavy-tests', 'e2e-only')],
    ['one key whatever the switch', 'validate', line, both('heavy-tests')],
    ['the key of another variable', 'validate', line, both('heavy-tests-$CI_RUNNER_TAGS')],
    ['the deploy group', 'validate', line, both(DEPLOY_GROUP)],
    ['a key GitLab refuses', 'validate', line, both(`heavy:${HEAVY_GROUP}`)],
    ['a group on .node, which lint takes', 'validate', '.node:\n', `.node:\n${line}`],
    [
      'a group on the script tests',
      'validate',
      'operations-tests:\n',
      `operations-tests:\n${line}`,
    ],
    ['a group in default:', 'validate', 'default:\n', `default:\n${line}`],
    ['a group on the trigger job', 'ci', 'main-validation:\n', `main-validation:\n${line}`],
    ['deploy without its group', 'ci', both(DEPLOY_GROUP), ''],
    ['a tag of its own on e2e', 'validate', e2eLine, `${e2eLine}  tags:\n    - ${OURS}\n`],
  ];
  for (const [fault, file, from, to] of faults) {
    const original = file === 'ci' ? CI : VALIDATE;
    const edited = original.replaceAll(from, to);
    assert.notEqual(edited, original, `${fault}: the edit found nothing to change`);
    assert.notDeepEqual(heavyProblems({ [file]: edited }), [], fault);
  }
});

test('the model reads a resource group as GitLab does: variables expanded, unknown names dropped, its characters checked', () => {
  assert.equal(
    expandGroup(HEAVY_GROUP, { [RUNNER_TAG_VARIABLE]: OURS }),
    'heavy-tests-qa-tools-ci',
  );
  assert.equal(expandGroup('a-${B}', { B: 'x' }), 'a-x');
  assert.equal(expandGroup(HEAVY_GROUP, {}), 'heavy-tests-');
  assert.equal(expandGroup('$A', { A: '$B' }), '$B', 'a value is not expanded again');
  for (const key of [
    'heavy-tests-qa-tools-ci',
    'heavy-tests-saas-linux-small-amd64',
    'a/b',
    'a b',
    '${A}.x',
  ]) {
    assert.match(key, GROUP_KEY, key);
  }
  for (const key of ['', '/a', 'a/', 'a:b', 'a,b', 'a\nb', 'x'.repeat(256)]) {
    assert.doesNotMatch(key, GROUP_KEY, JSON.stringify(key));
  }
  // A job's own key wins over a template's, and a template's reaches the job.
  const text =
    'job:\n  extends: .t\n  resource_group: own\n\n.t:\n  resource_group: t\n\nother:\n  extends: .t\n';
  assert.equal(groupOfJob(text, 'job'), 'own');
  assert.equal(groupOfJob(text, 'other'), 't');
  assert.equal(groupOfJob('a:\n  extends: b\n\nb:\n  extends: a\n', 'a'), null, 'a loop ends');
});

// `deploy` is the one job of the pipeline files that a newer pipeline never
// cancels (D216, #370). resource_group serialises deployments but does not
// stop a running one being cancelled, and a helm client killed mid-upgrade
// leaves the release in pending-upgrade, where the next deployment refuses to
// start until someone clears it by hand; the delivery lock relies on a
// deployment that runs to its end. Every other job takes `interruptible:
// true` from `default:`, which both files hold, but the proof job: the child
// the gate writes for a proven tree holds no `default:`, so that one job,
// which prints a line, takes GitLab's own default.
//
// The model, from GitLab's documentation (doc/ci/yaml: interruptible,
// default, extends, inherit:default, !reference): a job's own key wins over
// one it takes from a template through `extends:`, the last template named
// winning, and those over `default:`'s, which the job does not take when its
// `inherit: default:` is false or a list without `interruptible`; with none
// of them a job is not interruptible. A `!reference` takes the one key it
// names, so it brings `interruptible` only as that key's own value. A merge
// request pipeline's `default:` is both files', the including file's key
// winning. A value other than `true` or `false`, a `!reference` among them,
// is refused rather than guessed at, and so is `inherit:` on a template.

/** An `interruptible:` key at any depth, its value without a trailing comment. */
const INTERRUPTIBLE = /^\s*interruptible\s*:\s*(.*?)\s*(?:#.*)?$/;

/**
 * A block's own `interruptible:`: true, false, a string saying what the model
 * does not read, or undefined when it has none.
 */
function ownInterruptible(lines) {
  for (const line of lines) {
    const match = /^ {2}interruptible\s*:\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    if (match[1] === 'true') return true;
    if (match[1] === 'false') return false;
    return `interruptible: ${match[1]}, a value the model does not read`;
  }
  return undefined;
}

/**
 * A block's `interruptible:`, its own or one it takes from a block of the
 * same text through `extends:`, the last named winning; undefined when none
 * holds one.
 */
function declaredInterruptible(text, job, seen = new Set([job])) {
  const lines = block(text, job) ?? [];
  const own = ownInterruptible(lines);
  if (own !== undefined) return own;
  // The lines without a `!reference`, whose names inheritedFrom would read as templates.
  const extended = inheritedFrom(lines.filter((line) => !line.includes('!reference')));
  for (const name of extended.reverse()) {
    if (seen.has(name) || block(text, name) === null) continue;
    seen.add(name);
    const found = declaredInterruptible(text, name, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Whether a job's lines let it take `default:`'s `interruptible`, from its
 * own `inherit: default:`: true or false, or a string saying what the model
 * does not read.
 */
function takesDefault(lines) {
  const at = lines.indexOf('  inherit:');
  if (at < 0) return true;
  const after = lines.slice(at + 1);
  const end = after.findIndex((line) => /^ {0,2}\S/.test(line));
  const inherit = after.slice(0, end < 0 ? after.length : end);
  const line = inherit.find((item) => /^ {4}default\s*:/.test(item));
  if (line === undefined) return true;
  const value = /^ {4}default\s*:\s*(.*?)\s*$/.exec(line)[1];
  if (value === 'true') return true;
  if (value === 'false') return false;
  const flow = /^\[(.*)\]$/.exec(value);
  if (flow) return flow[1].split(',').some((key) => key.trim() === 'interruptible');
  if (value === '') return (listUnder(inherit, 'default', 4) ?? []).includes('interruptible');
  return `inherit: default: ${value}, a value the model does not read`;
}

/**
 * Whether a job of `text` is interruptible, `fallback` being its pipeline's
 * `default:` value, undefined when that sets none: true or false, or a
 * string saying what the model does not read.
 */
function interruptibleOf(text, job, fallback) {
  const declared = declaredInterruptible(text, job);
  if (declared !== undefined) return declared;
  const takes = takesDefault(block(text, job) ?? []);
  if (typeof takes === 'string') return takes;
  return (takes ? fallback : undefined) ?? false;
}

/** Every job of each pipeline and whether it is interruptible, in the files as given. */
function interruptibles(files = {}) {
  const { ci = CI, validate = VALIDATE } = files;
  const defaultOf = (text) => ownInterruptible(block(text, 'default') ?? []);
  return Object.fromEntries(
    placedJobs({}, files).map(({ key, job, text }) => {
      const fallback = key.startsWith('merge-request ')
        ? (defaultOf(ci) ?? defaultOf(validate))
        : defaultOf(text);
      return [key, interruptibleOf(text, job, fallback)];
    }),
  );
}

/** What every job should be: interruptible, but `deploy` and the proof job. */
const expectedInterruptibles = () =>
  Object.fromEntries(
    Object.keys(expected(OURS)).map((key) => [
      key,
      !['main deploy', `child ${PROOF_JOB}`].includes(key),
    ]),
  );

/**
 * What lets a newer pipeline cancel `deploy`, or keeps another job from being
 * cancelled, in the files as given: `deploy` must declare `interruptible:
 * false` itself, and nothing else in the pipeline files or the child
 * pipelines may declare `interruptible:` as anything but true.
 */
function interruptibleProblems(files = {}) {
  const { ci = CI, validate = VALIDATE } = files;
  const problems = [];
  const want = expectedInterruptibles();
  const found = interruptibles(files);
  for (const [key, value] of Object.entries(found)) {
    if (typeof value === 'string') problems.push(`${key}: ${value}`);
    else if (value !== want[key]) problems.push(`${key} is ${value ? '' : 'not '}interruptible`);
  }
  if (ownInterruptible(block(ci, 'deploy') ?? []) !== false) {
    problems.push('deploy does not declare interruptible: false itself');
  }
  for (const [file, text] of credentialFiles({ ci, validate })) {
    for (const { name, lines } of topLevelBlocks(text)) {
      const where = `${file} ${name === '' ? 'before any key' : name}`;
      if (file === '.gitlab-ci.yml' && name === 'deploy') continue;
      for (const line of lines) {
        const match = INTERRUPTIBLE.exec(line);
        if (match && match[1] !== 'true')
          problems.push(`${where} declares interruptible: ${match[1]}`);
      }
      if (name.startsWith('.') && lines.some((line) => /^\s+inherit\s*:/.test(line))) {
        problems.push(`${where} is a template holding inherit:, which the model does not read`);
      }
    }
  }
  return problems;
}

test('deploy is the one job a newer pipeline does not cancel: it declares interruptible: false, and no other job does (D216, #370)', () => {
  assert.deepEqual(interruptibleProblems(), []);
  assert.ok(block(CI, 'deploy').includes('  interruptible: false'));
  assert.deepEqual(interruptibles(), expectedInterruptibles());
  // Every job but deploy takes the value from default:, in both files.
  for (const text of [CI, VALIDATE]) {
    assert.equal(ownInterruptible(block(text, 'default')), true);
    for (const job of jobsOf(text).filter((name) => name !== 'deploy')) {
      assert.equal(declaredInterruptible(text, job), undefined, job);
    }
  }
});

test('the interruptible check sees each way of letting deploy be cancelled or keeping another job from it', () => {
  const line = '  interruptible: false\n';
  const ownDefault = 'default:\n  interruptible: true\n';
  assert.ok(CI.includes(ownDefault) && VALIDATE.includes(ownDefault), 'both files hold it');
  const start = '\ndeploy:\n  stage: deploy\n';
  assert.ok(CI.includes(start), "deploy's first lines are where the test looks for it");
  // [the fault, the file edited, [what is replaced wherever it stands, its replacement]...]
  const faults = [
    ['deploy without interruptible: false', 'ci', [line, '']],
    ['deploy interruptible', 'ci', [line, '  interruptible: true\n']],
    ['deploy with a value the model does not read', 'ci', [line, '  interruptible: no\n']],
    [
      'deploy taking it from a template',
      'ci',
      [line, ''],
      [start, `\n.keep:\n${line}${start}  extends: .keep\n`],
    ],
    [
      'another job of .gitlab-ci.yml with it',
      'ci',
      ['image:postgres:\n', `image:postgres:\n${line}`],
    ],
    [
      'the gate on main with it',
      'ci',
      ['main-validation-gate:\n', `main-validation-gate:\n${line}`],
    ],
    ['the trigger job with it', 'ci', ['main-validation:\n', `main-validation:\n${line}`]],
    [
      'a job of the validate stage with it',
      'validate',
      ['operations-tests:\n', `operations-tests:\n${line}`],
    ],
    ['the image template with it', 'ci', ['.image:\n', `.image:\n${line}`]],
    ['the node template with it', 'validate', ['.node:\n', `.node:\n${line}`]],
    ["a job taking deploy's keys", 'ci', ['  extends: .image\n', '  extends: [.image, deploy]\n']],
    ['default: not interruptible', 'ci', [ownDefault, `default:\n${line}`]],
    ['.gitlab-ci.yml without its default', 'ci', [ownDefault, 'default:\n']],
    ['the validate stage without its default', 'validate', [ownDefault, 'default:\n']],
    [
      'a job leaving default: out',
      'ci',
      ['image:backend:\n', 'image:backend:\n  inherit:\n    default: false\n'],
    ],
    [
      'a job taking default: without interruptible',
      'validate',
      ['operations-tests:\n', 'operations-tests:\n  inherit:\n    default: [tags]\n'],
    ],
  ];
  for (const [fault, file, ...edits] of faults) {
    const original = file === 'ci' ? CI : VALIDATE;
    let edited = original;
    for (const [from, to] of edits) {
      const before = edited;
      edited = edited.replaceAll(from, to);
      assert.ok(edited !== before, `${fault}: the edit found nothing to change`);
    }
    assert.notDeepEqual(interruptibleProblems({ [file]: edited }), [], fault);
  }
});

test('the model reads interruptible as GitLab does: own key, then templates, the last named winning, then default:, then false', () => {
  const text = [
    'default:',
    '  interruptible: true',
    '',
    '.yes:',
    '  interruptible: true',
    '',
    '.no:',
    '  interruptible: false',
    '',
    'own:',
    '  extends: .yes',
    '  interruptible: false',
    '',
    'last:',
    '  extends: [.yes, .no]',
    '',
    'listed:',
    '  extends:',
    '    - .no',
    '    - .yes',
    '',
    'referenced:',
    '  script: !reference [.no, script]',
    '',
    'reference:',
    '  interruptible: !reference [.no, interruptible]',
    '',
    'plain:',
    '  script: [x]',
    '',
    'alone:',
    '  inherit:',
    '    default: false',
    '',
    'kept:',
    '  inherit:',
    '    default:',
    '      - tags',
    '      - interruptible',
    '',
    'dropped:',
    '  inherit:',
    '    default: [tags]',
    '',
    'loop:',
    '  extends: loop2',
    '',
    'loop2:',
    '  extends: loop',
    '',
    'odd:',
    '  interruptible: yes',
    '',
  ].join('\n');
  const fallback = ownInterruptible(block(text, 'default'));
  const of = (job) => interruptibleOf(text, job, fallback);
  assert.equal(of('own'), false, 'its own key wins');
  assert.equal(of('last'), false, 'the last template named wins');
  assert.equal(of('listed'), true, 'a list of templates, the last winning');
  assert.equal(of('referenced'), true, '!reference takes the one key it names');
  assert.match(of('reference'), /does not read/);
  assert.equal(of('plain'), true, "default:'s value");
  assert.equal(of('alone'), false, 'inherit: default: false drops it');
  assert.equal(of('kept'), true, 'a list naming interruptible keeps it');
  assert.equal(of('dropped'), false, 'a list without it drops it');
  assert.equal(of('loop'), true, 'a loop ends');
  assert.equal(interruptibleOf(text, 'plain', undefined), false, "GitLab's own default");
  assert.match(of('odd'), /does not read/);
  assert.match(takesDefault(['  inherit:', '    default: maybe']), /does not read/);
});
