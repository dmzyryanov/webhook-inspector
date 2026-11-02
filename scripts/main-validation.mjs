// The main pipeline's validation gate (#194, D241). On `main` the job
// `main-validation-gate` runs
// `node scripts/main-validation.mjs .gitlab/ci/validate.yml main-validation.yml`,
// and the trigger job `main-validation` runs the file it writes as a child
// pipeline whose status it mirrors; `build` and `deploy` wait for that job.
//
// The file is one of two:
// - the proof job alone, when this commit's tree is proven validated: the
//   merge request it merges ran the validate stage on that same tree, from the
//   same base, and passed;
// - the validate stage itself, a copy of `.gitlab/ci/validate.yml`, in every
//   other case — a direct push, a tree that differs because main moved, an
//   answer of the API that is missing, refused, late, too large or not what a
//   proof needs. Any doubt runs the full validation, as before the gate.
//
// What is proven, every part of it checked:
// - The pipeline is a push to the default branch: not one run by hand, by a
//   schedule or through the API, which could have set its variables.
// - `HEAD` is `CI_COMMIT_SHA` and has exactly two parents. Its tree is the
//   tree of the second parent, the merge request's head, read from the
//   checkout; the job fetches two levels of history for it (`GIT_DEPTH`).
// - Exactly one merged merge request of this project into the default branch
//   has this commit as its merge commit
//   (`GET /projects/:id/repository/commits/:sha/merge_requests`).
// - That merge request (`GET /projects/:id/merge_requests/:iid`) has the second
//   parent as its head, the first as its diff's base, and as its head pipeline
//   a merge request pipeline on that head whose status is `success`. A
//   successful pipeline on the same tree from the same base is what makes
//   `check-version` and `check-api-breaking` give here what they gave there.
// - The first parent's last pipeline (`GET /projects/:id/repository/commits/:sha`)
//   is a `main` pipeline that passed. A merge request pipeline leaves out the
//   script tests whose inputs it did not change; they are proven by the
//   pipeline that last ran them on these same inputs, which a passing chain of
//   `main` pipelines carries forward (D241).
//
// The requests carry the job's own `CI_JOB_TOKEN`, which may read these three
// endpoints, and go only to `API`: a job whose `CI_API_V4_URL` says otherwise
// proves nothing and sends nothing. A redirect is refused, so the token never
// follows one. Nothing printed or written holds the token or any text of an
// answer; only numbers, commit SHAs and statuses that were checked.

import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const { fetch, AbortSignal, TextDecoder } = globalThis;

/** The only API the gate asks: GitLab.com's, where this project lives. */
export const API = 'https://gitlab.com/api/v4';
/** How long one request may take, its answer included. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** The largest answer read; the three answers are a few KiB. */
export const MAX_ANSWER_BYTES = 1024 * 1024;
/** The proof job of the child pipeline written when the tree is proven. */
export const PROOF_JOB = 'validated-in-merge-request';
/**
 * The variable naming the runner tag of the validate stage, and its default:
 * the project's own CI runner (D258). The proof job is tagged with it like
 * every job of `.gitlab/ci/validate.yml`, whose default it repeats, so a
 * project CI/CD variable of this name moves the proof to the shared runners
 * with the rest; the trigger job does not pass it on, so nothing outranks
 * that project variable in the child pipeline.
 */
export const RUNNER_TAG_VARIABLE = 'QA_TOOLS_RUNNER_TAG';
export const RUNNER_TAG_DEFAULT = 'qa-tools-ci';

const SHA = /^[0-9a-f]{40}$/;
const PROJECT_ID = /^[1-9][0-9]{0,15}$/;
const WORD = /^[a-z_]{1,40}$/;

class NoProof extends Error {}

/** A positive whole number as GitLab writes an id, or null. */
const idOf = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A status or source as GitLab spells one, or a word that says it is not one. */
const word = (value) => (typeof value === 'string' && WORD.test(value) ? value : 'something else');

/** The tree and parents of a commit, from `git cat-file commit`, which reads the object itself. */
function commitOf(git, ref) {
  const text = git(['cat-file', 'commit', ref]);
  const header = text.slice(0, text.indexOf('\n\n') < 0 ? text.length : text.indexOf('\n\n'));
  let tree = null;
  const parents = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  if (!SHA.test(tree ?? '') || !parents.every((parent) => SHA.test(parent))) {
    throw new NoProof(`git could not read ${ref} as a commit`);
  }
  return { tree, parents };
}

/** The one merged merge request whose merge commit is `head`, or why there is none. */
export function pickMergeRequest(list, { head, project, branch }) {
  if (!Array.isArray(list)) return { reason: 'the merge requests of the commit are not a list' };
  const found = list.filter(
    (mr) =>
      isObject(mr) &&
      mr.merge_commit_sha === head &&
      mr.state === 'merged' &&
      mr.target_branch === branch &&
      mr.project_id === project &&
      mr.source_project_id === project &&
      idOf(mr.iid) !== null,
  );
  if (found.length !== 1) {
    return {
      reason: `${found.length} merged merge requests of this project have ${head} as their merge commit`,
    };
  }
  return { iid: found[0].iid };
}

/** Why the merge request does not prove the tree, or null when it does. */
export function judgeMergeRequest(mr, { iid, head, base, mergedHead, project, branch }) {
  if (!isObject(mr)) return `merge request !${iid} is not an object`;
  if (mr.iid !== iid || mr.project_id !== project || mr.source_project_id !== project) {
    return `the answer for merge request !${iid} is another merge request`;
  }
  if (mr.state !== 'merged' || mr.merge_commit_sha !== head || mr.target_branch !== branch) {
    return `merge request !${iid} is not merged into ${branch} as ${head}`;
  }
  if (mr.sha !== mergedHead || mr.diff_refs?.head_sha !== mergedHead) {
    return `merge request !${iid}'s head is not ${mergedHead}, the merged parent`;
  }
  if (mr.diff_refs?.base_sha !== base) {
    return `merge request !${iid}'s diff is not based on ${base}, the parent on ${branch}`;
  }
  const pipeline = mr.head_pipeline;
  if (!isObject(pipeline)) return `merge request !${iid} shows no head pipeline`;
  const id = idOf(pipeline.id);
  if (id === null || pipeline.project_id !== project) {
    return `merge request !${iid}'s head pipeline is not a pipeline of this project`;
  }
  if (pipeline.sha !== mergedHead) {
    return `merge request !${iid}'s head pipeline ${id} ran on another commit`;
  }
  if (
    pipeline.source !== 'merge_request_event' ||
    pipeline.ref !== `refs/merge-requests/${iid}/head`
  ) {
    return `pipeline ${id} is not a merge request pipeline of !${iid} (source ${word(pipeline.source)})`;
  }
  if (pipeline.status !== 'success') {
    return `merge request !${iid}'s head pipeline ${id} is ${word(pipeline.status)}, not success`;
  }
  return null;
}

/** Why the first parent's pipeline does not carry the proof forward, or null when it does. */
export function judgePrevious(commit, { base, branch }) {
  if (!isObject(commit) || commit.id !== base) return `the answer for ${base} is another commit`;
  const pipeline = commit.last_pipeline;
  if (!isObject(pipeline) || idOf(pipeline.id) === null) {
    return `${base}, the parent on ${branch}, shows no pipeline`;
  }
  if (pipeline.sha !== base || pipeline.ref !== branch) {
    return `${base}'s last pipeline ${pipeline.id} is not a ${branch} pipeline of it`;
  }
  if (pipeline.status !== 'success') {
    return `${base}'s ${branch} pipeline ${pipeline.id} is ${word(pipeline.status)}, not success`;
  }
  return null;
}

/** An answer's body as text, refused past `limit` bytes. */
async function bodyOf(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) throw new NoProof(`answered more than ${limit} bytes`);
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** GET `path` from the API as JSON with the job token, or NoProof saying why not. */
async function getJson({ api, path, token, fetchImpl, timeoutMs, maxBytes }) {
  const what = `GET ${path}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${api}${path}`, {
      headers: { 'JOB-TOKEN': token, Accept: 'application/json' },
      redirect: 'error',
      signal,
    });
  } catch (error) {
    throw new NoProof(`${what} failed (${word(error?.name?.toLowerCase())})`);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new NoProof(`${what} answered ${response.status}`);
  }
  let text;
  try {
    text = await bodyOf(response, maxBytes);
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    if (error instanceof NoProof) throw new NoProof(`${what} ${error.message}`);
    throw new NoProof(`${what} broke off (${word(error?.name?.toLowerCase())})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new NoProof(`${what} answered something that is not JSON`);
  }
}

/**
 * Whether this pipeline's commit is proven validated by its merge request:
 * `{ proven: true, facts }` or `{ proven: false, reason }`. Never throws for
 * anything the job, git or the API does; the caller treats a throw as no proof
 * all the same.
 */
export async function prove({
  env,
  git,
  fetchImpl = fetch,
  api = API,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxBytes = MAX_ANSWER_BYTES,
}) {
  try {
    if (env.CI_PIPELINE_SOURCE !== 'push') {
      throw new NoProof(
        `the pipeline was started by ${word(env.CI_PIPELINE_SOURCE)}, not by a push`,
      );
    }
    const branch = env.CI_DEFAULT_BRANCH;
    if (!branch || env.CI_COMMIT_BRANCH !== branch) {
      throw new NoProof('the pipeline is not on the default branch');
    }
    if (env.CI_API_V4_URL !== api) throw new NoProof(`the job's API is not ${api}`);
    if (!PROJECT_ID.test(env.CI_PROJECT_ID ?? '')) throw new NoProof('CI_PROJECT_ID is not an id');
    const project = Number(env.CI_PROJECT_ID);
    const token = env.CI_JOB_TOKEN;
    if (typeof token !== 'string' || token === '') throw new NoProof('the job has no CI_JOB_TOKEN');

    let head;
    try {
      head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    } catch {
      throw new NoProof('git could not read HEAD');
    }
    if (!SHA.test(head) || head !== env.CI_COMMIT_SHA) {
      throw new NoProof('the checkout is not CI_COMMIT_SHA');
    }
    let merge;
    let mergedTree;
    try {
      merge = commitOf(git, head);
      if (merge.parents.length !== 2) {
        throw new NoProof(`${head} has ${merge.parents.length} parents, not the two of a merge`);
      }
      mergedTree = commitOf(git, merge.parents[1]).tree;
    } catch (error) {
      if (error instanceof NoProof) throw error;
      throw new NoProof('git could not read the merge and its merged parent');
    }
    const [base, mergedHead] = merge.parents;
    if (mergedTree !== merge.tree) {
      throw new NoProof(`${head}'s tree is not the tree of ${mergedHead}, the merged parent`);
    }

    const ask = (path) => getJson({ api, path, token, fetchImpl, timeoutMs, maxBytes });
    const prefix = `/projects/${project}`;
    const picked = pickMergeRequest(
      await ask(`${prefix}/repository/commits/${head}/merge_requests`),
      {
        head,
        project,
        branch,
      },
    );
    if (picked.reason) throw new NoProof(picked.reason);
    const { iid } = picked;
    const mr = await ask(`${prefix}/merge_requests/${iid}`);
    const refused = judgeMergeRequest(mr, { iid, head, base, mergedHead, project, branch });
    if (refused) throw new NoProof(refused);
    const previous = await ask(`${prefix}/repository/commits/${base}`);
    const broken = judgePrevious(previous, { base, branch });
    if (broken) throw new NoProof(broken);

    return {
      proven: true,
      facts: {
        head,
        tree: merge.tree,
        base,
        mergedHead,
        iid,
        pipeline: mr.head_pipeline.id,
        previousPipeline: previous.last_pipeline.id,
      },
    };
  } catch (error) {
    if (error instanceof NoProof) return { proven: false, reason: error.message };
    return { proven: false, reason: `the gate failed (${word(error?.name?.toLowerCase())})` };
  }
}

/** One printable line of at most 400 characters, for a comment or the log; a proof's is about 310. */
export function oneLine(text) {
  const flat = String(text).replace(/[^\x20-\x7e]+/g, ' ');
  return flat.length > 400 ? `${flat.slice(0, 397)}...` : flat;
}

/** What the decision says, as one line for the job's log. */
export function summary(decision) {
  if (!decision.proven)
    return oneLine(`Not proven: ${decision.reason}. The validate stage runs in full.`);
  return oneLine(`Proven: ${proofLine(decision.facts)} The validate stage does not run again.`);
}

/**
 * The proof in one sentence, from checked values only: commit SHAs and ids.
 * Its characters need no quoting in YAML's single quotes or the shell's double
 * quotes, which the proof job prints it in.
 */
export function proofLine(facts) {
  const line = `tree ${facts.tree} of ${facts.head} passed pipeline ${facts.pipeline} of merge request !${facts.iid} on ${facts.mergedHead}, from ${facts.base}, whose main pipeline ${facts.previousPipeline} passed.`;
  return /^[A-Za-z0-9 !.,]+$/.test(line) ? line : 'the facts did not read as SHAs and ids.';
}

/**
 * The child pipeline's configuration: the proof job when the tree is proven,
 * the validate stage (`validate`, the text of `.gitlab/ci/validate.yml`) when
 * it is not.
 */
export function childConfig(decision, validate, sha) {
  const commit = SHA.test(sha ?? '') ? sha : 'this commit';
  if (!decision.proven) {
    return `# Written by scripts/main-validation.mjs (D241) for ${commit}.\n# ${summary(decision)}\n\n${validate}`;
  }
  // Every value below was checked to be a commit SHA or a number, so the line
  // needs no quoting beyond YAML's single quotes.
  return [
    `# Written by scripts/main-validation.mjs (D241) for ${commit}.`,
    `# ${summary(decision)}`,
    '',
    'stages:',
    '  - validate',
    '',
    'variables:',
    `  ${RUNNER_TAG_VARIABLE}: '${RUNNER_TAG_DEFAULT}'`,
    '',
    `${PROOF_JOB}:`,
    '  stage: validate',
    '  image: $NODE_IMAGE',
    '  tags:',
    `    - $${RUNNER_TAG_VARIABLE}`,
    '  cache: []',
    '  variables:',
    "    GIT_STRATEGY: 'none'",
    '  script:',
    `    - 'echo "Validated in its merge request: ${proofLine(decision.facts)}"'`,
    '',
  ].join('\n');
}

/** git in the checkout, its output trimmed; throws when git fails or is missing. */
function runGit(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [validatePath, outPath] = process.argv.slice(2);
  if (!validatePath || !outPath) {
    console.error('Usage: node scripts/main-validation.mjs <validate.yml> <child-pipeline.yml>');
    process.exit(2);
  }
  // Without the validate stage there is nothing to fall back to: the job
  // fails, and the pipeline with it.
  const validate = readFileSync(validatePath, 'utf8');
  let decision;
  try {
    decision = await prove({ env: process.env, git: runGit });
  } catch {
    decision = { proven: false, reason: 'the gate failed' };
  }
  const text = childConfig(decision, validate, process.env.CI_COMMIT_SHA);
  writeFileSync(`${outPath}.partial`, text);
  renameSync(`${outPath}.partial`, outPath);
  console.log(summary(decision));
}
