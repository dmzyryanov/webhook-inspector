// The main pipeline's validation gate, scripts/main-validation.mjs (#194,
// D241), run against throwaway repositories and a stand-in for GitLab's API
// on the loopback interface: nothing here reaches GitLab. The commits are
// real ones, made with git in a temporary directory; the API's answers are
// GitLab's shapes, as `GET /projects/<id>/merge_requests/194` answered in QA
// Tools, the project this code was imported from, for its merge 6a56df9 on
// 2026-10-19. The stand-in answers them under this project's id, and each
// case breaks one part of them. The last tests read this checkout's
// .gitlab-ci.yml and .gitlab/ci/validate.yml and pin the gate's place in the
// pipeline.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import {
  API,
  MAX_ANSWER_BYTES,
  PROOF_JOB,
  childConfig,
  judgeMergeRequest,
  judgePrevious,
  oneLine,
  pickMergeRequest,
  proofLine,
  prove,
  summary,
} from './main-validation.mjs';

const root = process.cwd();
const SCRIPT = join(root, 'scripts', 'main-validation.mjs');
const read = (path) => readFileSync(join(root, path), 'utf8');

const PROJECT = 88390528;
const IID = 194;
const PIPELINE = 2962252589;
const PREVIOUS_PIPELINE = 2962210764;
// A made-up token: every test checks that it reaches the API's header and
// nothing else, neither the log, nor a reason, nor the configuration written.
const TOKEN = 'glcbt-standin-5f2c9a07d3e1b8461c0a';

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitRun = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
/** git for prove(), in `cwd`, as the job runs it: output trimmed, a failure thrown. */
const gitIn = (cwd) => (args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
};

function temporary(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-main-validation-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const commit = (work, file, text, message) => {
  writeFileSync(join(work, file), text);
  gitRun(work, 'add', '-A');
  gitRun(work, 'commit', '--quiet', '-m', message);
  return gitRun(work, 'rev-parse', 'HEAD');
};

// main: one commit, then another while a branch works; the branch integrates
// main by a merge commit, as the delivery process asks, and main merges it
// with a merge commit of its own, as GitLab does. `moved` lands one more
// commit on main after the integration, so the merge's tree is not the
// branch's.
function repository(t, { moved = false } = {}) {
  const dir = temporary(t);
  const work = join(dir, 'work');
  gitRun(dir, 'init', '--quiet', '--initial-branch=main', work);
  gitRun(work, 'config', 'user.email', 'test@example.invalid');
  gitRun(work, 'config', 'user.name', 'Test');
  commit(work, 'README.md', 'one\n', 'first');
  gitRun(work, 'switch', '--quiet', '-c', 'feature');
  commit(work, 'feature.txt', 'feature\n', 'feature');
  gitRun(work, 'switch', '--quiet', 'main');
  commit(work, 'main.txt', 'main\n', 'main moves');
  gitRun(work, 'switch', '--quiet', 'feature');
  gitRun(work, 'merge', '--quiet', '--no-edit', 'main');
  const mergedHead = gitRun(work, 'rev-parse', 'HEAD');
  gitRun(work, 'switch', '--quiet', 'main');
  if (moved) commit(work, 'other.txt', 'another merge\n', 'main moves again');
  const base = gitRun(work, 'rev-parse', 'HEAD');
  gitRun(work, 'merge', '--quiet', '--no-ff', '--no-edit', 'feature');
  const head = gitRun(work, 'rev-parse', 'HEAD');
  return { dir, work, head, base, mergedHead, tree: gitRun(work, 'rev-parse', 'HEAD^{tree}') };
}

/** GitLab's three answers for a merge `f` that proves its tree. */
function answers(f) {
  const mr = {
    id: 470000001,
    iid: IID,
    project_id: PROJECT,
    source_project_id: PROJECT,
    target_project_id: PROJECT,
    state: 'merged',
    merge_commit_sha: f.head,
    squash_commit_sha: null,
    target_branch: 'main',
    source_branch: 'feature',
    sha: f.mergedHead,
  };
  return {
    commitMergeRequests: [mr],
    mergeRequest: {
      ...mr,
      diff_refs: { base_sha: f.base, head_sha: f.mergedHead, start_sha: f.base },
      head_pipeline: {
        id: PIPELINE,
        iid: 4100,
        project_id: PROJECT,
        sha: f.mergedHead,
        ref: `refs/merge-requests/${IID}/head`,
        status: 'success',
        source: 'merge_request_event',
      },
    },
    previous: {
      id: f.base,
      parent_ids: [],
      status: 'success',
      last_pipeline: {
        id: PREVIOUS_PIPELINE,
        project_id: PROJECT,
        sha: f.base,
        ref: 'main',
        status: 'success',
        source: 'push',
      },
    },
  };
}

const paths = (f) => ({
  commitMergeRequests: `/api/v4/projects/${PROJECT}/repository/commits/${f.head}/merge_requests`,
  mergeRequest: `/api/v4/projects/${PROJECT}/merge_requests/${IID}`,
  previous: `/api/v4/projects/${PROJECT}/repository/commits/${f.base}`,
});

// The stand-in API: each path answers 200 with its JSON, or what a function
// given for it writes; anything else is a 404. Every request is recorded with
// the job token it carried.
async function standIn(t, f, routes = answers(f)) {
  const requests = [];
  const byPath = new Map(Object.entries(paths(f)).map(([name, path]) => [path, routes[name]]));
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      token: request.headers['job-token'],
    });
    const route = byPath.get(request.url);
    if (typeof route === 'function') return route(request, response);
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' });
      return response.end('{"message":"404 Not found"}');
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    return response.end(typeof route === 'string' ? route : JSON.stringify(route));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { api: `http://127.0.0.1:${server.address().port}/api/v4`, requests };
}

const envFor = (f, api, extra = {}) => ({
  CI_PIPELINE_SOURCE: 'push',
  CI_DEFAULT_BRANCH: 'main',
  CI_COMMIT_BRANCH: 'main',
  CI_API_V4_URL: api,
  CI_PROJECT_ID: String(PROJECT),
  CI_JOB_TOKEN: TOKEN,
  CI_COMMIT_SHA: f.head,
  ...extra,
});

const VALIDATE =
  'stages:\n  - validate\n\nlint:\n  stage: validate\n  script:\n    - npm run lint\n';

/** Asserts that the decision, its log line and both configurations hold no token. */
function noToken(decision, label) {
  for (const text of [
    JSON.stringify(decision),
    summary(decision),
    childConfig(decision, VALIDATE, decision.facts?.head),
  ]) {
    assert.ok(!text.includes(TOKEN), `${label}: the token is in the output`);
    assert.ok(!text.includes(TOKEN.slice(6, 20)), `${label}: part of the token is in the output`);
  }
}

async function decide(t, f, { routes, env = {}, ...options } = {}) {
  const server = await standIn(t, f, routes ?? answers(f));
  const decision = await prove({
    env: envFor(f, server.api, env),
    git: gitIn(f.work),
    api: server.api,
    ...options,
  });
  return { decision, requests: server.requests, api: server.api };
}

test('a merge whose tree its merge request passed, from the same base, after a passing main pipeline, is proven', async (t) => {
  const f = repository(t);
  assert.equal(
    gitRun(f.work, 'rev-parse', `${f.mergedHead}^{tree}`),
    f.tree,
    'the fixture merges a branch that is up to date',
  );
  const { decision, requests } = await decide(t, f);

  assert.deepEqual(decision, {
    proven: true,
    facts: {
      head: f.head,
      tree: f.tree,
      base: f.base,
      mergedHead: f.mergedHead,
      iid: IID,
      pipeline: PIPELINE,
      previousPipeline: PREVIOUS_PIPELINE,
    },
  });
  // Three GETs, in order, each with the job token and nothing else to send.
  const asked = paths(f);
  assert.deepEqual(
    requests.map((r) => [r.method, r.url, r.token]),
    [
      ['GET', asked.commitMergeRequests, TOKEN],
      ['GET', asked.mergeRequest, TOKEN],
      ['GET', asked.previous, TOKEN],
    ],
  );
  noToken(decision, 'proven');
  assert.match(summary(decision), /^Proven: .* The validate stage does not run again\.$/);

  const config = childConfig(decision, VALIDATE, f.head);
  assert.match(config, new RegExp(`^${PROOF_JOB}:$`, 'm'));
  assert.doesNotMatch(config, /^lint:$/m, 'no validate job runs');
  assert.match(config, /^stages:\n {2}- validate$/m);
  assert.match(config, /^ {4}GIT_STRATEGY: 'none'$/m);
  // On the runner the validate stage runs on, with its default (D258).
  assert.match(config, /^variables:\n {2}QA_TOOLS_RUNNER_TAG: 'saas-linux-small-amd64'$/m);
  assert.match(config, /^ {2}tags:\n {4}- \$QA_TOOLS_RUNNER_TAG$/m);
  // It holds no resource group, so a proven main never waits behind the
  // merge requests' `test` and `e2e` taking their turns (#266).
  assert.doesNotMatch(config, /resource_group/);
  const echo = /^ {4}- 'echo "(.*)"'$/m.exec(config)?.[1];
  assert.ok(echo, 'the proof job prints the proof');
  assert.match(
    echo,
    /^Validated in its merge request: tree [0-9a-f]{40} of [0-9a-f]{40} passed pipeline \d+ of merge request !194 on [0-9a-f]{40}, from [0-9a-f]{40}, whose main pipeline \d+ passed\.$/,
  );
});

test('a pipeline not pushed to main, another API, or no project id or token proves nothing and asks nothing', async (t) => {
  const f = repository(t);
  for (const [label, env] of [
    ['run by hand', { CI_PIPELINE_SOURCE: 'web' }],
    ['scheduled', { CI_PIPELINE_SOURCE: 'schedule' }],
    ['through the API', { CI_PIPELINE_SOURCE: 'api' }],
    ['triggered', { CI_PIPELINE_SOURCE: 'trigger' }],
    ['a merge request', { CI_PIPELINE_SOURCE: 'merge_request_event' }],
    ['a child', { CI_PIPELINE_SOURCE: 'parent_pipeline' }],
    ['no source', { CI_PIPELINE_SOURCE: undefined }],
    ['another branch', { CI_COMMIT_BRANCH: 'feature' }],
    ['no branch', { CI_COMMIT_BRANCH: undefined }],
    ['no default branch', { CI_DEFAULT_BRANCH: undefined, CI_COMMIT_BRANCH: undefined }],
    ['another API', { CI_API_V4_URL: 'https://gitlab.example.invalid/api/v4' }],
    ['no API', { CI_API_V4_URL: undefined }],
    ['no project', { CI_PROJECT_ID: undefined }],
    ['a project path', { CI_PROJECT_ID: 'qa-tools-team/webhook-inspector' }],
    ['a project id with a path', { CI_PROJECT_ID: '88390528/../1' }],
    ['a project id of zero', { CI_PROJECT_ID: '0' }],
    ['no token', { CI_JOB_TOKEN: undefined }],
    ['an empty token', { CI_JOB_TOKEN: '' }],
  ]) {
    const { decision, requests } = await decide(t, f, { env });
    assert.equal(decision.proven, false, label);
    assert.equal(requests.length, 0, `${label}: the API was asked`);
    noToken(decision, label);
  }
});

test('the default API is GitLab.com and a job pointing elsewhere sends its token nowhere', async (t) => {
  assert.equal(API, 'https://gitlab.com/api/v4');
  const f = repository(t);
  const server = await standIn(t, f);
  // The API the job names is the stand-in, but prove() is left with its own.
  const decision = await prove({ env: envFor(f, server.api), git: gitIn(f.work) });
  assert.equal(decision.proven, false);
  assert.match(decision.reason, /the job's API is not https:\/\/gitlab\.com\/api\/v4/);
  assert.equal(server.requests.length, 0);
});

test('a checkout that is not CI_COMMIT_SHA, a commit with one parent or three, and a tree main moved under prove nothing and ask nothing', async (t) => {
  const f = repository(t);
  const other = await decide(t, f, { env: { CI_COMMIT_SHA: f.base } });
  assert.equal(other.decision.proven, false);
  assert.match(other.decision.reason, /not CI_COMMIT_SHA/);
  assert.equal(other.requests.length, 0);

  // A commit pushed to main directly, or merged by a fast-forward: one parent.
  const direct = repository(t);
  const pushed = commit(direct.work, 'direct.txt', 'pushed\n', 'a direct push');
  const one = await decide(t, { ...direct, head: pushed });
  assert.equal(one.decision.proven, false);
  assert.match(one.decision.reason, /has 1 parents, not the two of a merge/);
  assert.equal(one.requests.length, 0);

  // An octopus merge: three parents.
  const octopus = repository(t);
  gitRun(octopus.work, 'switch', '--quiet', '-c', 'second', octopus.base);
  commit(octopus.work, 'second.txt', 'second\n', 'second');
  gitRun(octopus.work, 'switch', '--quiet', '-c', 'third', octopus.base);
  commit(octopus.work, 'third.txt', 'third\n', 'third');
  gitRun(octopus.work, 'switch', '--quiet', 'main');
  gitRun(octopus.work, 'merge', '--quiet', '--no-edit', 'second', 'third');
  const three = await decide(t, { ...octopus, head: gitRun(octopus.work, 'rev-parse', 'HEAD') });
  assert.equal(three.decision.proven, false);
  assert.match(three.decision.reason, /has 3 parents/);
  assert.equal(three.requests.length, 0);

  // Main moved after the branch integrated it: the merge's tree is not the
  // tree the merge request validated, even with every answer saying it passed.
  const moved = repository(t, { moved: true });
  assert.notEqual(gitRun(moved.work, 'rev-parse', `${moved.mergedHead}^{tree}`), moved.tree);
  const differs = await decide(t, moved);
  assert.equal(differs.decision.proven, false);
  assert.match(differs.decision.reason, /tree is not the tree of [0-9a-f]{40}, the merged parent/);
  assert.equal(differs.requests.length, 0);

  // No git at all.
  const missing = await decide(t, f, {});
  assert.equal(missing.decision.proven, true, 'the control proves');
  const server = await standIn(t, f);
  const noGit = await prove({
    env: envFor(f, server.api),
    git: () => {
      throw new Error('spawnSync git ENOENT');
    },
    api: server.api,
  });
  assert.deepEqual(noGit, { proven: false, reason: 'git could not read HEAD' });
});

test('a shallow clone proves with the merge and its parents, and proves nothing without them', async (t) => {
  const f = repository(t);
  for (const [depth, proven] of [
    [1, false],
    [2, true],
  ]) {
    const clone = join(f.dir, `clone-${depth}`);
    gitRun(f.dir, 'clone', '--quiet', `--depth=${depth}`, `file://${f.work}`, clone);
    assert.equal(gitRun(clone, 'rev-parse', 'HEAD'), f.head);
    const server = await standIn(t, f);
    const decision = await prove({
      env: envFor(f, server.api),
      git: gitIn(clone),
      api: server.api,
    });
    assert.equal(decision.proven, proven, `depth ${depth}: ${decision.reason}`);
    if (!proven) {
      assert.match(decision.reason, /git could not read the merge and its merged parent/);
      assert.equal(server.requests.length, 0);
    }
  }
});

// Each case changes one answer of a proof and must leave it unproven.
const clone = (value) => JSON.parse(JSON.stringify(value));
function broken(f) {
  const good = answers(f);
  const with_ = (name, change) => {
    const routes = clone(good);
    routes[name] = change(routes[name]);
    return routes;
  };
  const mr = (change) => with_('mergeRequest', (value) => (change(value), value));
  const pipeline = (change) => mr((value) => change(value.head_pipeline));
  const listed = (change) => with_('commitMergeRequests', (list) => (change(list[0], list), list));
  const previous = (change) => with_('previous', (value) => (change(value), value));
  const status =
    (code, body = '{"message":"stand-in"}') =>
    (request, response) => {
      response.writeHead(code, { 'content-type': 'application/json' });
      response.end(body);
    };
  const cases = [];
  for (const name of ['commitMergeRequests', 'mergeRequest', 'previous']) {
    for (const code of [201, 204, 400, 401, 403, 404, 429, 500, 502, 503]) {
      cases.push([
        `${name} answers ${code}`,
        with_(name, () => status(code, code === 204 ? '' : undefined)),
      ]);
    }
    for (const body of [
      '',
      'not json',
      '{',
      '<html>Sign in</html>',
      '[1,',
      'null',
      '"merged"',
      '42',
    ]) {
      cases.push([`${name} answers ${JSON.stringify(body)}`, with_(name, () => body)]);
    }
  }
  cases.push(
    ['the list is an object', with_('commitMergeRequests', (list) => list[0])],
    ['the list is empty', with_('commitMergeRequests', () => [])],
    [
      'the list holds the merge request twice',
      with_('commitMergeRequests', (list) => [list[0], list[0]]),
    ],
    ['the list holds a null and an array', with_('commitMergeRequests', () => [null, []])],
    [
      'the listed merge request has another merge commit',
      listed((m) => (m.merge_commit_sha = f.base)),
    ],
    ['the listed merge request is open', listed((m) => (m.state = 'opened'))],
    ['the listed merge request is closed', listed((m) => (m.state = 'closed'))],
    [
      'the listed merge request targets another branch',
      listed((m) => (m.target_branch = 'release')),
    ],
    ['the listed merge request is of another project', listed((m) => (m.project_id = 1))],
    ['the listed merge request comes from a fork', listed((m) => (m.source_project_id = 2))],
    ['the listed iid is a string', listed((m) => (m.iid = String(IID)))],
    ['the listed iid is zero', listed((m) => (m.iid = 0))],
    ['the listed iid is a fraction', listed((m) => (m.iid = 194.5))],
    ['the listed iid is a path', listed((m) => (m.iid = '194/../../1'))],
    ['the merge request is another one', mr((m) => (m.iid = 195))],
    ['the merge request is of another project', mr((m) => (m.project_id = 1))],
    ['the merge request is open', mr((m) => (m.state = 'opened'))],
    ['the merge request has another merge commit', mr((m) => (m.merge_commit_sha = f.mergedHead))],
    ['the merge request targets another branch', mr((m) => (m.target_branch = 'release'))],
    ['the merge request has another head', mr((m) => (m.sha = f.base))],
    ['the diff has another head', mr((m) => (m.diff_refs.head_sha = f.base))],
    ['the diff has another base: main moved', mr((m) => (m.diff_refs.base_sha = f.mergedHead))],
    ['the diff has no refs', mr((m) => delete m.diff_refs)],
    ['the diff refs are null', mr((m) => (m.diff_refs = null))],
    ['no head pipeline: the token may not see it', mr((m) => delete m.head_pipeline)],
    ['a null head pipeline', mr((m) => (m.head_pipeline = null))],
    ['a head pipeline that is a list', mr((m) => (m.head_pipeline = [m.head_pipeline]))],
    ['a head pipeline of another project', pipeline((p) => (p.project_id = 1))],
    ['a head pipeline whose id is a string', pipeline((p) => (p.id = String(PIPELINE)))],
    ['a head pipeline on another commit', pipeline((p) => (p.sha = f.base))],
    ['a head pipeline pushed to a branch', pipeline((p) => (p.source = 'push'))],
    ['a head pipeline run by hand', pipeline((p) => (p.source = 'web'))],
    ['a head pipeline on another ref', pipeline((p) => (p.ref = 'feature'))],
    [
      'a head pipeline of another merge request',
      pipeline((p) => (p.ref = 'refs/merge-requests/195/head')),
    ],
    ['a head pipeline with no status', pipeline((p) => delete p.status)],
    ['the previous commit is another', previous((c) => (c.id = f.mergedHead))],
    ['the previous commit has no pipeline', previous((c) => (c.last_pipeline = null))],
    [
      'the previous pipeline ran on another commit',
      previous((c) => (c.last_pipeline.sha = f.head)),
    ],
    [
      'the previous pipeline is a merge request pipeline',
      previous((c) => (c.last_pipeline.ref = 'refs/merge-requests/1/head')),
    ],
    ['the previous pipeline has a string id', previous((c) => (c.last_pipeline.id = 'x'))],
  );
  for (const value of [
    'failed',
    'canceled',
    'canceling',
    'running',
    'pending',
    'created',
    'skipped',
    'manual',
    'scheduled',
    'waiting_for_resource',
    'preparing',
    'SUCCESS',
    'success ',
    '',
    null,
    1,
    true,
  ]) {
    cases.push([
      `a head pipeline whose status is ${JSON.stringify(value)}`,
      pipeline((p) => (p.status = value)),
    ]);
    cases.push([
      `a previous pipeline whose status is ${JSON.stringify(value)}`,
      previous((c) => (c.last_pipeline.status = value)),
    ]);
  }
  return cases;
}

test('each answer that is refused, broken or short of a proof proves nothing, and the token stays in the header', async (t) => {
  const f = repository(t);
  const cases = broken(f);
  assert.ok(cases.length > 100, `${cases.length} cases`);
  for (const [label, routes] of cases) {
    const { decision, requests } = await decide(t, f, { routes });
    assert.equal(decision.proven, false, label);
    assert.ok(decision.reason.length > 0 && decision.reason.length <= 300, label);
    assert.ok(
      requests.every((r) => r.token === TOKEN && r.method === 'GET'),
      label,
    );
    noToken(decision, label);
  }
});

test('a redirect is refused, so the token never follows it', async (t) => {
  const f = repository(t);
  const elsewhere = await standIn(t, f);
  for (const code of [301, 302, 303, 307, 308]) {
    const routes = answers(f);
    routes.mergeRequest = (request, response) => {
      response.writeHead(code, {
        location: `${elsewhere.api}/projects/${PROJECT}/merge_requests/${IID}`,
      });
      response.end();
    };
    const { decision } = await decide(t, f, { routes });
    assert.equal(decision.proven, false, `${code}`);
    assert.match(decision.reason, /failed/, `${code}`);
  }
  assert.equal(elsewhere.requests.length, 0, 'the redirect was followed');
});

test('an API that does not answer, or answers too slowly, proves nothing within the limit', async (t) => {
  const f = repository(t);
  const silent = answers(f);
  silent.commitMergeRequests = () => {}; // never answers
  const trickle = answers(f);
  trickle.mergeRequest = (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    const body = JSON.stringify(answers(f).mergeRequest);
    let at = 0;
    const timer = setInterval(() => {
      if (at >= body.length || response.destroyed) return clearInterval(timer);
      response.write(body[at]);
      at += 1;
    }, 50);
    response.on('close', () => clearInterval(timer));
  };
  const headersLate = answers(f);
  headersLate.previous = (request, response) => {
    const timer = setTimeout(() => response.end(JSON.stringify(answers(f).previous)), 5000);
    response.on('close', () => clearTimeout(timer));
  };
  for (const [label, routes] of [
    ['never answers', silent],
    ['answers a byte at a time', trickle],
    ['answers after the limit', headersLate],
  ]) {
    const started = Date.now();
    const { decision } = await decide(t, f, { routes, timeoutMs: 400 });
    const took = Date.now() - started;
    assert.equal(decision.proven, false, label);
    assert.match(
      decision.reason,
      /failed \(timeouterror\)|broke off \(timeouterror\)/,
      `${label}: ${decision.reason}`,
    );
    assert.ok(took < 3000, `${label} took ${took} ms`);
  }
});

test('answers at growing sizes are read up to the limit: padding keeps a proof, anything past the limit is refused', async (t) => {
  const f = repository(t);
  const good = answers(f);
  for (const size of [1_000, 100_000, MAX_ANSWER_BYTES - 1_000]) {
    const routes = answers(f);
    const text = JSON.stringify(good.mergeRequest);
    routes.mergeRequest = text + ' '.repeat(size - text.length);
    const { decision } = await decide(t, f, { routes });
    assert.equal(decision.proven, true, `${size} bytes: ${decision.reason}`);
  }
  for (const size of [MAX_ANSWER_BYTES + 1, 4 * MAX_ANSWER_BYTES, 32 * MAX_ANSWER_BYTES]) {
    const routes = answers(f);
    const text = JSON.stringify(good.mergeRequest);
    routes.mergeRequest = text + ' '.repeat(size - text.length);
    const started = Date.now();
    const { decision } = await decide(t, f, { routes });
    assert.equal(decision.proven, false, `${size} bytes`);
    assert.match(decision.reason, /answered more than 1048576 bytes/);
    assert.ok(Date.now() - started < 5000, `${size} bytes took too long`);
  }
  // Nesting at growing depths, inside the limit: read or refused, never a crash.
  for (const depth of [1_000, 10_000, 100_000, 500_000]) {
    const routes = answers(f);
    routes.previous = '['.repeat(depth) + ']'.repeat(depth);
    const { decision } = await decide(t, f, { routes });
    assert.equal(decision.proven, false, `depth ${depth}`);
  }
  // Many listed merge requests, one of them the merge's: still the one.
  for (const count of [10, 1_000, 3_000]) {
    const routes = answers(f);
    const decoy = { ...good.commitMergeRequests[0], merge_commit_sha: f.base, iid: 1 };
    routes.commitMergeRequests = [
      ...Array.from({ length: count }, () => decoy),
      good.commitMergeRequests[0],
    ];
    const { decision } = await decide(t, f, { routes });
    assert.equal(decision.proven, true, `${count} listed`);
  }
  // A key that names the prototype changes nothing.
  const routes = answers(f);
  routes.mergeRequest = JSON.stringify(good.mergeRequest).replace(
    /^\{/,
    '{"__proto__":{"status":"success","sha":"x"},"constructor":{"prototype":{"state":"merged"}},',
  );
  assert.equal((await decide(t, f, { routes })).decision.proven, true);
  assert.equal({}.status, undefined);
});

test('the checks read the shapes they are given, whatever those are', () => {
  const context = {
    iid: IID,
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    mergedHead: 'c'.repeat(40),
    project: PROJECT,
    branch: 'main',
  };
  for (const value of [
    undefined,
    null,
    0,
    '',
    'x',
    [],
    [[]],
    {},
    { head_pipeline: {} },
    new Array(1000).fill(null),
  ]) {
    assert.equal(
      typeof pickMergeRequest(value, context).reason,
      'string',
      JSON.stringify(value)?.slice(0, 40),
    );
    assert.equal(typeof judgeMergeRequest(value, context), 'string');
    assert.equal(typeof judgePrevious(value, context), 'string');
  }
});

test('the configuration is the validate stage, under one line saying why, unless the tree is proven', () => {
  const sha = 'd'.repeat(40);
  const text = childConfig(
    { proven: false, reason: 'the pipeline was started by web, not by a push' },
    VALIDATE,
    sha,
  );
  assert.equal(
    text,
    `# Written by scripts/main-validation.mjs (D241) for ${sha}.\n# Not proven: the pipeline was started by web, not by a push. The validate stage runs in full.\n\n${VALIDATE}`,
  );
  // A reason is one printable line of at most 400 characters, whatever it holds.
  for (const reason of [
    'a\nlint:\n  script: [rm -rf /]',
    '\r\u0000\u001b[31m x',
    'x'.repeat(10_000),
    `${'é'.repeat(500)}\n`,
  ]) {
    const config = childConfig({ proven: false, reason }, VALIDATE, sha);
    const [first, second, blank, ...rest] = config.split('\n');
    assert.match(first, /^# Written by /);
    assert.match(second, /^# [\x20-\x7e]{0,400}$/);
    assert.equal(blank, '');
    assert.equal(rest.join('\n'), VALIDATE);
  }
  assert.equal(oneLine('x'.repeat(401)).length, 400);
  // Not a SHA: no SHA is claimed.
  assert.match(
    childConfig({ proven: false, reason: 'r' }, VALIDATE, 'HEAD; rm -rf /'),
    /^# Written by scripts\/main-validation\.mjs \(D241\) for this commit\.$/m,
  );
  // A fact that is not a SHA or an id is not printed.
  assert.equal(
    proofLine({
      tree: `"$(id)"`,
      head: 'x',
      base: 'y',
      mergedHead: 'z',
      iid: 1,
      pipeline: 2,
      previousPipeline: 3,
    }),
    'the facts did not read as SHAs and ids.',
  );
});

test('the command writes the configuration and prints its decision, with the token nowhere', async (t) => {
  const f = repository(t);
  const validatePath = join(f.dir, 'validate.yml');
  writeFileSync(validatePath, VALIDATE);
  const out = join(f.dir, 'child.yml');
  const server = await standIn(t, f);
  const run = (env, args = [validatePath, out]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: f.work,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: f.dir, GIT_CONFIG_GLOBAL: '/dev/null', ...env },
      timeout: 30_000,
    });

  // The job's API is the stand-in, not GitLab.com's: nothing is sent to it.
  const result = run(envFor(f, server.api));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Not proven: the job's API is not https://gitlab.com/api/v4. The validate stage runs in full.\n",
  );
  assert.equal(server.requests.length, 0);
  assert.equal(
    readFileSync(out, 'utf8'),
    childConfig(
      { proven: false, reason: "the job's API is not https://gitlab.com/api/v4" },
      VALIDATE,
      f.head,
    ),
  );
  assert.ok(!existsSync(`${out}.partial`));
  for (const text of [result.stdout, result.stderr, readFileSync(out, 'utf8')]) {
    assert.ok(!text.includes(TOKEN));
  }

  const manual = run(envFor(f, API, { CI_PIPELINE_SOURCE: 'web' }));
  assert.equal(manual.status, 0, manual.stderr);
  assert.match(manual.stdout, /^Not proven: the pipeline was started by web, not by a push\./);

  assert.equal(run({}, []).status, 2);
  rmSync(out);
  const missing = run(envFor(f, API), [join(f.dir, 'absent.yml'), out]);
  assert.notEqual(missing.status, 0);
  assert.ok(!existsSync(out), 'nothing is written without the validate stage');
});

// ---------------------------------------------------------------------------
// The gate's place in the pipeline

/** A top-level block of a YAML file: from `name:` to the next top-level key. */
function block(text, name) {
  const lines = text.split('\n');
  const from = lines.indexOf(`${name}:`);
  assert.ok(from >= 0, `no top-level ${name}:`);
  const after = lines.findIndex((line, at) => at > from && /^[^\s#]/.test(line));
  return lines
    .slice(from, after < 0 ? lines.length : after)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

test('main runs the gate and mirrors what it wrote; merge requests include the validate stage; nothing declares needs', () => {
  const ci = read('.gitlab-ci.yml');
  const validate = read('.gitlab/ci/validate.yml');

  assert.equal(
    block(ci, 'include'),
    "include:\n  - local: .gitlab/ci/validate.yml\n    rules:\n      - if: $CI_PIPELINE_SOURCE == 'merge_request_event'\n",
  );
  assert.equal(
    block(ci, 'main-validation-gate'),
    [
      'main-validation-gate:',
      '  stage: .pre',
      '  image: $NODE_IMAGE',
      '  cache: []',
      '  rules:',
      '    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH',
      '  variables:',
      "    GIT_DEPTH: '2'",
      '  script:',
      '    - |',
      '      if ! command -v git >/dev/null; then',
      '        { apt-get update && apt-get install -y --no-install-recommends git; } >/dev/null ||',
      '          echo "git could not be installed; nothing is proven and the full validate stage runs"',
      '      fi',
      '    - node scripts/main-validation.mjs .gitlab/ci/validate.yml main-validation.yml',
      '  artifacts:',
      '    expire_in: 1 week',
      '    paths:',
      '      - main-validation.yml',
      '',
    ].join('\n'),
  );
  // The deploy gate: mirrored, never allowed to fail, never skipped on main.
  assert.equal(
    block(ci, 'main-validation'),
    [
      'main-validation:',
      '  stage: validate',
      '  rules:',
      '    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH',
      // Only the variables the validate stage reads: one passed on would
      // outrank the project variable that moves the runner tag (D258).
      '  inherit:',
      '    variables:',
      '      - NODE_IMAGE',
      '      - POSTGRES_IMAGE_TAG',
      '  trigger:',
      '    include:',
      '      - artifact: main-validation.yml',
      '        job: main-validation-gate',
      '    strategy: mirror',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    block(ci, 'stages')
      .split('\n')
      .slice(1)
      .map((line) => line.trim()),
    ['- validate', '- build', '- deploy', '- verify-deployment', ''],
  );
  for (const [name, text] of [
    ['.gitlab-ci.yml', ci],
    ['.gitlab/ci/validate.yml', validate],
  ]) {
    assert.doesNotMatch(text, /^\s+needs:/m, `${name}: a job declares needs:`);
    assert.doesNotMatch(text, /^\s+dependencies:/m, `${name}: a job declares dependencies:`);
  }
  // The build and deploy jobs are where they were: after validate, on main.
  for (const job of ['image:backend', 'image:frontend']) {
    assert.doesNotMatch(block(ci, job), /rules:|allow_failure:|when:/, job);
  }
  assert.match(block(ci, '.image'), /^ {2}stage: build$/m);
  assert.match(block(ci, 'deploy'), /^ {2}stage: deploy$/m);
});

test('the validate stage keeps every gate: no rule, failure allowed or manual step but the script-test group', () => {
  const validate = read('.gitlab/ci/validate.yml');
  const jobs = validate
    .split('\n')
    .filter((line) => /^[a-z][\w:-]*:$/.test(line))
    .map((line) => line.slice(0, -1));
  assert.deepEqual(jobs.sort(), [
    'chart',
    'default',
    'delivery-checks',
    'e2e',
    'lint',
    'native-ts',
    'operations-tests',
    'stages',
    'test',
    'typecheck',
    'variables',
  ]);
  for (const job of ['lint', 'typecheck', 'native-ts', 'test', 'e2e', 'delivery-checks', 'chart']) {
    const text = block(validate, job);
    // Job-level keys only: `e2e`'s artifacts are kept `when: always`.
    for (const key of ['rules', 'only', 'except', 'allow_failure', 'when', 'trigger']) {
      assert.doesNotMatch(text, new RegExp(`^ {2}${key}:`, 'm'), `${job} has ${key}:`);
    }
  }
  assert.match(block(validate, 'e2e'), /^ {2}stage: validate$/m);
  assert.equal(block(validate, 'stages'), 'stages:\n  - validate\n');
  assert.match(block(validate, 'default'), /^ {2}interruptible: true$/m);
  // `test` and `e2e` take turns through one resource group, which delays
  // the gate and skips nothing (#266); the copy the gate writes holds it as
  // it stands here, and the gate and the trigger job hold none, so the
  // parent on main never waits for its own child.
  for (const job of ['test', 'e2e']) {
    assert.match(
      block(validate, job),
      /^ {2}resource_group: heavy-tests-\$QA_TOOLS_RUNNER_TAG$/m,
      `${job} no longer takes turns`,
    );
  }
  const ci = read('.gitlab-ci.yml');
  for (const job of ['main-validation-gate', 'main-validation']) {
    assert.doesNotMatch(block(ci, job), /resource_group/, job);
  }
});
