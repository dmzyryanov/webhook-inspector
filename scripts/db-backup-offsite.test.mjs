// The off-server copy's uploader (deploy/helm/qa-tools/files/db-backup-offsite.mjs,
// D190), run as the backup pod runs it — `node db-backup-offsite.mjs`, its
// settings in the environment, stopped by a signal — against a hand-over
// directory in a temporary directory and a stand-in for the object storage on
// the loopback interface, never the internet. The stand-in checks every
// request's AWS Signature Version 4 with code of its own, written from the
// received bytes, and the script's signer is checked against the examples AWS
// publishes. What is pinned is issue #89's: a correctly signed `PUT` of the
// copy, the versioning guard, the listing, pruning to the three newest copies
// with everything else untouched, an object that sorts after the new copy,
// each failure reaching the answer db-backup.sh reads, a missing credential,
// an empty bucket, and no credential in any output. Since the first correction
// round also: a copy of 256 MiB uploaded without the process growing by it, no
// signature in any output even when the storage answers with it, a listing
// that lies about its size refused, and a versioning answer read as off only
// when it is whole. Since the second: an upload cut for silence and not for
// its size, a too-slow one cut by the run's limit with a message of its own,
// and what is read of a listing bounded to what the uploader's memory holds. Since
// issue #121: an upload cut by the run's limit after an earlier attempt failed
// names that attempt's problem first, never "too large", within the 240
// characters of a failure at production lengths. Since issue #122: a limit
// that fires late fails a test. In this process, where of two timers the one
// due first always fires first, an exchange must give up on its silence
// before an answer that comes a quarter later, and the run's limit must cut an
// upload before the stand-in has made more pauses than fit in it; in the
// uploader's own process, an answer ten times later than the silence must
// never be read, and the run's limit must come before twice its pauses. A
// stop must end a nap of a minute at once. db-backup.sh's half — the
// encryption, the hand-over and the answer becoming `Off-server copy failed: …`
// — is pinned in scripts/db-backup.test.mjs, which also runs the two together.

import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import { setImmediate as turn, setTimeout as sleep } from 'node:timers/promises';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  DEFAULTS,
  Failure,
  MAX_COPIES,
  MAX_FAILURE_LENGTH,
  MAX_LIST_PAGE_BYTES,
  MAX_PAGES,
  MAX_PAGE_ENTRIES,
  cutOffMessage,
  errorCode,
  exchange,
  main,
  parseListing,
  parseVersioning,
  planPruning,
  readSettings,
  scrubber,
  signRequest,
  uriEncode,
  xmlText,
} from '../deploy/helm/qa-tools/files/db-backup-offsite.mjs';

// Every test of this file, and each of its subtests, has TEST_LIMIT_MS, run
// with a bare `node --test` as with `operations-tests`' `--test-timeout`.
// After it the test fails, as `test timed out after …ms`, under its own name,
// and its `after` hooks stop what it started. The limit is a timer of this
// file's process, which no wait here blocks. A test that ran out of time is
// failed but its function runs on, and a subtest it starts then gets a signal
// of its own that never aborts; so every test runs under `current`, which
// holds the signal of the top-level test it belongs to, and `until` gives up
// at its first look once that one has ended: the remaining subtests of a test
// that timed out fail at once instead of each waiting out PATIENCE_MS.
// `operations-tests` also stops its whole run after a bound of its own and
// names the tests still running (scripts/test-run-limit.mjs, D190).
const TEST_LIMIT_MS = 300_000;
const current = new AsyncLocalStorage();
const test = (name, options, fn) => {
  const [settings, body] = typeof options === 'function' ? [{}, options] : [options, fn];
  return nodeTest(name, { timeout: TEST_LIMIT_MS, ...settings }, async (t) => {
    // One turn of the event loop first, in which this process writes out
    // what it has to report: the tests before this one and this one's start.
    // It cannot while a test blocks it in a synchronous call, so without the
    // turn a run of such tests would be reported only at the file's end.
    await turn();
    return current.run(t.signal, () => body(t));
  });
};

const SCRIPT = fileURLToPath(
  new URL('../deploy/helm/qa-tools/files/db-backup-offsite.mjs', import.meta.url),
);
const TEMPLATE = readFileSync(
  new URL('../deploy/helm/qa-tools/templates/db-backup.yaml', import.meta.url),
  'utf8',
);
const VALUES = readFileSync(
  new URL('../deploy/helm/qa-tools/values.yaml', import.meta.url),
  'utf8',
);
const RECIPIENT = readFileSync(
  new URL('fixtures/db-backup-recipient.asc', import.meta.url),
  'utf8',
);
const BACKUP_SCRIPT = readFileSync(
  new URL('../deploy/helm/qa-tools/files/db-backup.sh', import.meta.url),
  'utf8',
);

// Stand-ins for the static access key; neither half may ever be printed. The
// secret holds the characters a real one may: `+`, `/`, `=`, `-` and `_`.
const KEY_ID = 'YCAJEstandInKeyId0123456A';
const SECRET = 'YCstand-in_Secret+access/key=0123456789a';
const BUCKET = 'qa-tools-backups';
const REGION = 'ru-central1';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const copyName = (stamp) => `qa_tools-${stamp}.dump.gpg`;
const NEW = copyName('20261002T000000Z');

const xmlEscape = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const errorXml = (code, message = 'stand-in') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message><Resource>/x</Resource><RequestId>1</RequestId></Error>`;

// --- The stand-in's own Signature Version 4 check -----------------------------
//
// Written from the specification against what arrives on the wire, sharing no
// code with the script: the canonical request is rebuilt from the raw request
// line and the received headers, and the body's own sha256 must be the one
// that was signed.
function checkSignature(req, body) {
  const header = req.headers.authorization ?? '';
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/.exec(
      header,
    );
  if (!match) return 'no Signature Version 4 authorization';
  const [, keyId, day, region, service, signedHeaders, signature] = match;
  if (keyId !== KEY_ID) return 'another key id';
  const names = signedHeaders.split(';');
  for (const required of ['host', 'x-amz-content-sha256', 'x-amz-date']) {
    if (!names.includes(required)) return `${required} is not signed`;
  }
  if ([...names].sort().join(';') !== signedHeaders) return 'signed headers are not sorted';
  const amzDate = req.headers['x-amz-date'] ?? '';
  if (!/^\d{8}T\d{6}Z$/.test(amzDate) || !amzDate.startsWith(day)) return 'a wrong x-amz-date';
  const sent = Date.parse(
    amzDate.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'),
  );
  if (Math.abs(Date.now() - sent) > 5 * 60_000) return 'a skewed x-amz-date';
  if (req.headers['x-amz-content-sha256'] !== sha256(body)) return 'the body is not the one signed';

  const [rawPath, rawQuery = ''] = req.url.split('?');
  const query = rawQuery
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const at = pair.indexOf('=');
      return at === -1 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
    })
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const canonical = [
    req.method,
    rawPath,
    query,
    ...names.map((name) => `${name}:${String(req.headers[name] ?? '').trim()}`),
    '',
    signedHeaders,
    req.headers['x-amz-content-sha256'],
  ].join('\n');
  const toSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    `${day}/${region}/${service}/aws4_request`,
    sha256(canonical),
  ].join('\n');
  let key = Buffer.from(`AWS4${SECRET}`, 'utf8');
  for (const part of [day, region, service, 'aws4_request']) {
    key = createHmac('sha256', key).update(part).digest();
  }
  const expected = createHmac('sha256', key).update(toSign).digest('hex');
  if (expected !== signature) return 'the signature does not match';
  if (region !== REGION || service !== 's3') return 'another scope';
  return null;
}

// A stand-in for the object storage: one bucket of objects in memory, the four
// calls the script makes, path-style, and `intercept` to answer a request some
// other way. Every request is recorded with the outcome of its signature check.
async function storage(t, { objects = {}, versioning = null, pageSize = 1000 } = {}) {
  const state = {
    objects: new Map(Object.entries(objects).map(([key, value]) => [key, Buffer.from(value)])),
    versioning,
    pageSize,
    requests: [],
    // (request) => undefined, or { status, body, headers, delayMs }, or { hang: true }
    intercept: () => undefined,
    // The continuation token of page n; awkward on purpose, so its encoding counts.
    token: (index) => `page ${index}+/=&é`,
  };
  const sockets = new Set();
  // The timers of answers given late, cleared with the stand-in.
  const late = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://stand-in');
      const [, bucket, ...rest] = url.pathname.split('/');
      const key = decodeURIComponent(rest.join('/'));
      const refusal = checkSignature(req, body);
      const request = {
        method: req.method,
        path: url.pathname,
        search: url.search,
        bucket,
        key,
        params: Object.fromEntries(url.searchParams),
        signature: /Signature=([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1],
        host: req.headers.host,
        refusal,
        body,
        type: req.headers['content-type'],
        length: req.headers['content-length'],
        agent: req.headers['user-agent'],
      };
      state.requests.push(request);
      const send = (status, text = '', headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/xml', ...headers });
        res.end(text);
      };
      if (refusal) return send(403, errorXml('SignatureDoesNotMatch'));
      const override = state.intercept(request);
      if (override?.hang) return undefined;
      if (override?.delayMs) {
        const timer = setTimeout(() => {
          late.delete(timer);
          send(override.status, override.body ?? '', override.headers ?? {});
        }, override.delayMs);
        late.add(timer);
        return undefined;
      }
      if (override) return send(override.status, override.body ?? '', override.headers ?? {});
      if (bucket !== BUCKET) return send(404, errorXml('NoSuchBucket'));

      if (req.method === 'GET' && key === '' && url.searchParams.has('versioning')) {
        return send(
          200,
          `<?xml version="1.0" encoding="UTF-8"?>\n<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${
            state.versioning ? `<Status>${state.versioning}</Status>` : ''
          }</VersioningConfiguration>`,
        );
      }
      if (req.method === 'GET' && key === '' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...state.objects.keys()].filter((name) => name.startsWith(prefix)).sort();
        const token = url.searchParams.get('continuation-token');
        let from = 0;
        if (token !== null) {
          from = keys.findIndex((_, index) => state.token(index) === token);
          if (from === -1) return send(400, errorXml('InvalidArgument'));
        }
        const page = keys.slice(from, from + state.pageSize);
        const more = from + state.pageSize < keys.length;
        return send(
          200,
          `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${state.pageSize}</MaxKeys><IsTruncated>${more}</IsTruncated>${page
            .map(
              (name) =>
                `<Contents><Key>${xmlEscape(name)}</Key><LastModified>2026-10-02T00:00:01.000Z</LastModified><ETag>&quot;etag&quot;</ETag><Size>${state.objects.get(name).length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
            )
            .join('')}${
            more
              ? `<NextContinuationToken>${xmlEscape(state.token(from + state.pageSize))}</NextContinuationToken>`
              : ''
          }</ListBucketResult>`,
        );
      }
      if (req.method === 'PUT' && key !== '') {
        state.objects.set(key, body);
        return send(200, '', { etag: '"etag"' });
      }
      if (req.method === 'DELETE' && key !== '') {
        state.objects.delete(key);
        return send(204);
      }
      return send(400, errorXml('InvalidRequest'));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        for (const timer of late) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  );
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.keys = () => [...state.objects.keys()].sort();
  state.calls = () =>
    state.requests.map(
      (request) => `${request.method} ${request.path}${request.search ? request.search : ''}`,
    );
  return state;
}

// How long a test waits for something that must happen — an answer, a log
// line, a process's end — before it gives up and fails. Never a measure of
// anything: on a shared runner under load a process may get a tenth of a
// processor, so a wait is far longer than the thing takes and costs nothing
// when it comes.
const PATIENCE_MS = 180_000;

// Starts the uploader. `exited` resolves with its exit code and output. A
// request is given 30 s of silence, far more than a loaded stand-in needs to
// answer; a test about that limit sets its own.
function start(env) {
  const vars = {
    PATH: process.env.PATH,
    OFFSITE_REGION: REGION,
    OFFSITE_BUCKET: BUCKET,
    OFFSITE_DATABASE: 'qa_tools',
    OFFSITE_ACCESS_KEY_ID: KEY_ID,
    OFFSITE_SECRET_ACCESS_KEY: SECRET,
    OFFSITE_KEEP: '3',
    OFFSITE_POLL_SECONDS: '0.03',
    OFFSITE_TIMEOUT_SECONDS: '30',
    OFFSITE_RETRY_SECONDS: '0.03',
    ...env,
  };
  for (const key of Object.keys(vars)) if (vars[key] === undefined) delete vars[key];
  const child = spawn(process.execPath, [SCRIPT], { env: vars, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 2 * PATIENCE_MS);
  const exited = new Promise((resolve) =>
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    }),
  );
  return { child, exited, output: () => output };
}

async function until(condition, what, ms = PATIENCE_MS) {
  // The top-level test this wait belongs to; once it has ended, by its limit
  // or otherwise, nobody is waiting for the answer.
  const owner = current.getStore();
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (condition()) return;
    if (owner?.aborted) assert.fail(`gave up waiting for ${what}: its test has ended`);
    await sleep(15);
  }
  assert.fail(`timed out waiting for ${what}`);
}

function handOverDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-db-backup-offsite-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// As db-backup.sh hands a copy over: a complete file renamed into place.
function handOver(dir, name, content) {
  writeFileSync(join(dir, `.${name}.tmp`), content, { mode: 0o644 });
  renameSync(join(dir, `.${name}.tmp`), join(dir, name));
}

// The answer for a copy, as `{ outcome, message, mode }`, once it is there.
async function answerFor(dir, name, run, ms = PATIENCE_MS) {
  const file = join(dir, `${name}.result`);
  await until(() => existsSync(file), `the answer for ${name}\n${run ? run.output() : ''}`, ms);
  const [outcome, message, ...rest] = readFileSync(file, 'utf8').split('\n');
  assert.deepEqual(rest, [''], 'the answer holds two lines');
  return { outcome, message, mode: statSync(file).mode & 0o777 };
}

// Neither half of the credential, in any letter case, nor anything signed.
function assertNoCredential(...texts) {
  for (const text of texts) {
    const lower = String(text).toLowerCase();
    assert.ok(!lower.includes(KEY_ID.toLowerCase()), 'the key id reached the output');
    assert.ok(!lower.includes(SECRET.toLowerCase()), 'the secret key reached the output');
    assert.doesNotMatch(String(text), /AWS4-HMAC-SHA256|Signature=|Credential=|x-amz-/i);
    assert.doesNotMatch(String(text), /[0-9a-f]{64}/, 'a signature or a hash reached the output');
  }
}

// One copy handed to a running uploader, to its answer; then the uploader is
// stopped. Returns the answer, the output and the exit code.
async function runOnce(t, store, { env = {}, name = NEW, content = 'ciphertext' } = {}) {
  const dir = handOverDir(t);
  const run = start({ OFFSITE_DIR: dir, OFFSITE_ENDPOINT: store.url, ...env });
  t.after(() => run.child.kill('SIGKILL'));
  handOver(dir, name, content);
  const answer = await answerFor(dir, name, run);
  run.child.kill('SIGTERM');
  const result = await run.exited;
  assert.equal(result.code, 0, result.output);
  assertNoCredential(result.output, answer.message);
  return { answer, output: result.output, dir };
}

const OLD = {
  [copyName('20260928T000000Z')]: 'oldest',
  [copyName('20260929T000000Z')]: 'older',
  [copyName('20260930T000000Z')]: 'kept',
  [copyName('20261001T000000Z')]: 'kept',
};
// Everything else a bucket may hold, none of it the job's to touch.
const OTHERS = {
  'notes.txt': 'kept',
  'qa_tools-manual.dump.gpg': 'kept',
  'qa_tools-20260101T030000Z.dump': 'kept',
  'qa_tools-20260101T030000Z.dump.gpg.bak': 'kept',
  'qa_tools-20260101T030000.dump.gpg': 'kept',
  'qa_tools-20260101T030000Z.dump.gpg/inside': 'kept',
  'qa_tools-2026010aT030000Z.dump.gpg': 'kept',
  'other_db-20260101T030000Z.dump.gpg': 'kept',
  'copies/qa_tools-20260101T030000Z.dump.gpg': 'kept',
  'QA_TOOLS-20260101T030000Z.dump.gpg': 'kept',
};

// --- The signer, against AWS's published examples -----------------------------

// "Signature Calculations for the Authorization Header: Transferring Payload in
// a Single Chunk (AWS Signature Version 4)", Amazon S3 API Reference: the
// example key, bucket `examplebucket`, 24 May 2013, and the four signatures the
// page prints.
test('the signer reproduces the signatures of AWS’s Signature Version 4 examples for S3', () => {
  const example = {
    host: 'examplebucket.s3.amazonaws.com',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    date: new Date('2013-05-24T00:00:00Z'),
  };
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.equal(sha256(''), empty);

  const getObject = signRequest({
    ...example,
    method: 'GET',
    path: '/test.txt',
    headers: { Range: 'bytes=0-9' },
    payloadHash: empty,
  });
  assert.equal(
    getObject.signature,
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
  assert.equal(
    getObject.headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
  assert.equal(getObject.headers['x-amz-date'], '20130524T000000Z');

  // The key `test$file.text`, percent-encoded once in the path.
  assert.equal(uriEncode('test$file.text'), 'test%24file.text');
  const body = 'Welcome to Amazon S3.';
  assert.equal(sha256(body), '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  assert.equal(
    signRequest({
      ...example,
      method: 'PUT',
      path: `/${uriEncode('test$file.text')}`,
      headers: {
        Date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      payloadHash: sha256(body),
    }).signature,
    '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
  );

  // A parameter without a value, `?lifecycle`.
  const lifecycle = signRequest({
    ...example,
    method: 'GET',
    path: '/',
    query: { lifecycle: '' },
    payloadHash: empty,
  });
  assert.equal(lifecycle.canonicalQuery, 'lifecycle=');
  assert.equal(lifecycle.sentQuery, 'lifecycle');
  assert.equal(
    lifecycle.signature,
    'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
  );

  // Two parameters, sorted by name whatever order they are given in.
  for (const query of [
    { 'max-keys': '2', prefix: 'J' },
    { prefix: 'J', 'max-keys': '2' },
  ]) {
    const list = signRequest({ ...example, method: 'GET', path: '/', query, payloadHash: empty });
    assert.equal(list.canonicalQuery, 'max-keys=2&prefix=J');
    assert.equal(list.sentQuery, 'max-keys=2&prefix=J');
    assert.equal(
      list.signature,
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  }
});

test('the signature changes with every part of the request, and the stand-in checks it independently', async (t) => {
  const base = {
    method: 'PUT',
    host: 'storage.yandexcloud.net',
    path: `/${BUCKET}/${NEW}`,
    query: {},
    headers: { 'content-type': 'application/octet-stream' },
    payloadHash: sha256('ciphertext'),
    accessKeyId: KEY_ID,
    secretAccessKey: SECRET,
    region: REGION,
    date: new Date('2026-10-02T00:00:05Z'),
  };
  const reference = signRequest(base);
  assert.match(
    reference.headers.authorization,
    new RegExp(
      `^AWS4-HMAC-SHA256 Credential=${KEY_ID}/20261002/ru-central1/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`,
    ),
  );
  for (const [what, change] of Object.entries({
    method: { method: 'DELETE' },
    host: { host: 'storage.yandexcloud.net:8443' },
    path: { path: `/${BUCKET}/${copyName('20261002T000001Z')}` },
    query: { query: { versioning: '' } },
    header: { headers: { 'content-type': 'text/plain' } },
    payload: { payloadHash: sha256('other') },
    secret: { secretAccessKey: `${SECRET}x` },
    region: { region: 'ru-central2' },
    service: { service: 'sqs' },
    day: { date: new Date('2026-10-03T00:00:05Z') },
    second: { date: new Date('2026-10-02T00:00:06Z') },
  })) {
    assert.notEqual(signRequest({ ...base, ...change }).signature, reference.signature, what);
  }

  // The stand-in refuses a request whose signature, body or scope is off.
  const store = await storage(t);
  const send = async (change = {}, edit = (headers) => headers) => {
    const payload = Buffer.from('ciphertext');
    const url = new URL(store.url);
    const signed = signRequest({
      ...base,
      host: url.host,
      date: new Date(),
      payloadHash: sha256(payload),
      ...change,
    });
    const headers = edit({ ...signed.headers });
    delete headers.host;
    const response = await globalThis.fetch(`${store.url}/${BUCKET}/${NEW}`, {
      method: 'PUT',
      headers,
      body: payload,
    });
    await response.arrayBuffer();
    return [response.status, store.requests.at(-1).refusal];
  };
  assert.deepEqual(await send(), [200, null]);
  assert.deepEqual(await send({ secretAccessKey: `${SECRET}x` }), [
    403,
    'the signature does not match',
  ]);
  assert.deepEqual(await send({ payloadHash: sha256('other') }), [
    403,
    'the body is not the one signed',
  ]);
  assert.deepEqual(await send({ region: 'us-east-1' }), [403, 'another scope']);
  assert.deepEqual(await send({ date: new Date(Date.now() - 3_600_000) }), [
    403,
    'a skewed x-amz-date',
  ]);
  assert.deepEqual(await send({ path: `/${BUCKET}/other` }), [403, 'the signature does not match']);
  assert.deepEqual(await send({}, (headers) => ({ ...headers, 'content-type': 'text/plain' })), [
    403,
    'the signature does not match',
  ]);
});

// --- One run ----------------------------------------------------------------

test('a copy is uploaded with a correctly signed PUT, the bucket is pruned to the three newest of five, and everything else is untouched', async (t) => {
  const store = await storage(t, { objects: { ...OLD, ...OTHERS } });
  const content = Buffer.from([0x84, 0x5e, 0x03, 0x00, 0xff, 0x0a, 0x0d, 0x00, 0x80, 0x7f]);
  const dir = handOverDir(t);
  const run = start({ OFFSITE_DIR: dir, OFFSITE_ENDPOINT: store.url });
  t.after(() => run.child.kill('SIGKILL'));
  await until(() => run.output().includes('waiting for a copy'), 'the uploader to start');
  assert.equal(store.requests.length, 0, 'nothing is asked before a copy is handed over');
  handOver(dir, NEW, content);
  const answer = await answerFor(dir, NEW, run);

  assert.deepEqual(answer, {
    outcome: 'ok',
    message: `uploaded ${NEW}, 10 bytes; deleted ${copyName('20260928T000000Z')} ${copyName('20260929T000000Z')}; kept ${copyName('20260930T000000Z')} ${copyName('20261001T000000Z')} ${NEW}`,
    mode: 0o644,
  });
  // The four calls, in order, each correctly signed, path-style.
  assert.deepEqual(store.calls(), [
    `GET /${BUCKET}?versioning`,
    `PUT /${BUCKET}/${NEW}`,
    `GET /${BUCKET}?list-type=2&prefix=qa_tools-`,
    `DELETE /${BUCKET}/${copyName('20260928T000000Z')}`,
    `DELETE /${BUCKET}/${copyName('20260929T000000Z')}`,
  ]);
  for (const request of store.requests) {
    assert.equal(request.refusal, null, `${request.method} ${request.path}`);
    assert.equal(request.agent, 'qa-tools-backup');
  }
  const put = store.requests[1];
  assert.deepEqual(put.body, content, 'the bytes uploaded are the bytes handed over');
  assert.equal(put.type, 'application/octet-stream');
  assert.equal(put.length, '10');

  assert.deepEqual(
    store.keys(),
    [
      ...Object.keys(OTHERS),
      copyName('20260930T000000Z'),
      copyName('20261001T000000Z'),
      NEW,
    ].sort(),
  );
  for (const [key, value] of Object.entries(OTHERS)) {
    assert.equal(store.objects.get(key).toString(), value, key);
  }
  assert.deepEqual(store.objects.get(NEW), content);

  // It stays until it is stopped — a sidecar that exits is started again —
  // and does nothing more meanwhile.
  await sleep(300);
  assert.equal(run.child.exitCode, null, 'the uploader exited before it was stopped');
  assert.equal(store.requests.length, 5);
  run.child.kill('SIGTERM');
  const result = await run.exited;
  assert.equal(result.code, 0);

  // The log: the object's name and size, the names deleted, the copies kept.
  const lines = result.output.split('\n').map((line) => line.replace(/^\S+ /, ''));
  assert.deepEqual(lines, [
    `Off-server copy to bucket ${BUCKET} at ${store.url}, region ${REGION}: keep 3 copies; waiting for a copy in ${dir}`,
    `Found ${NEW}, 10 bytes`,
    "The bucket's versioning is off",
    `Uploaded ${NEW}, 10 bytes`,
    `Deleted ${copyName('20260928T000000Z')}`,
    `Deleted ${copyName('20260929T000000Z')}`,
    `Copies kept: ${copyName('20260930T000000Z')} ${copyName('20261001T000000Z')} ${NEW}`,
    'Off-server copy succeeded',
    'Stopped by SIGTERM',
    '',
  ]);
  assertNoCredential(result.output, answer.message);
  // The copy and its answer are db-backup.sh's to remove; no temporary file is left.
  assert.deepEqual(readdirSync(dir).sort(), [NEW, `${NEW}.result`]);
});

test('fewer copies than the retention are all kept, and OFFSITE_KEEP decides how many', async (t) => {
  await t.test('an empty bucket', async (st) => {
    const store = await storage(st);
    const { answer } = await runOnce(st, store);
    assert.deepEqual(answer, {
      outcome: 'ok',
      message: `uploaded ${NEW}, 10 bytes; deleted nothing; kept ${NEW}`,
      mode: 0o644,
    });
    assert.deepEqual(store.keys(), [NEW]);
    assert.ok(store.requests.every((request) => request.method !== 'DELETE'));
  });
  await t.test('keep 1', async (st) => {
    const store = await storage(st, { objects: { ...OLD, ...OTHERS } });
    const { answer } = await runOnce(st, store, { env: { OFFSITE_KEEP: '1' } });
    assert.equal(answer.outcome, 'ok');
    assert.deepEqual(store.keys(), [...Object.keys(OTHERS), NEW].sort());
  });
  await t.test('keep unset is 3', async (st) => {
    const store = await storage(st, { objects: OLD });
    await runOnce(st, store, { env: { OFFSITE_KEEP: undefined } });
    assert.equal(store.keys().length, 3);
  });
});

test('an object that sorts after the new copy fails the run and nothing is deleted', async (t) => {
  const later = copyName('20261005T000000Z');
  const store = await storage(t, { objects: { ...OLD, [later]: 'later', ...OTHERS } });
  const { answer, output } = await runOnce(t, store);
  assert.deepEqual(answer, {
    outcome: 'fail',
    message: `${later} in the bucket sorts after the new copy ${NEW}: the clock may have gone back, or the object was copied in. Nothing was deleted.`,
    mode: 0o644,
  });
  assert.ok(store.requests.every((request) => request.method !== 'DELETE'));
  // The copy just uploaded stays, beside everything that was there.
  assert.deepEqual(store.keys(), [...Object.keys(OLD), ...Object.keys(OTHERS), later, NEW].sort());
  assert.match(output, /Off-server copy failed: .* sorts after the new copy/);
  assert.doesNotMatch(output, /Deleted |Off-server copy succeeded/);
});

test('the versioning guard: nothing is uploaded to a bucket whose versioning is enabled', async (t) => {
  await t.test('Enabled', async (st) => {
    const store = await storage(st, { objects: OLD, versioning: 'Enabled' });
    const { answer } = await runOnce(st, store);
    assert.deepEqual(answer, {
      outcome: 'fail',
      message:
        "the bucket's versioning is Enabled, so a delete would leave the old versions in place. Nothing was uploaded.",
      mode: 0o644,
    });
    assert.deepEqual(store.calls(), [`GET /${BUCKET}?versioning`]);
    assert.deepEqual(store.keys(), Object.keys(OLD));
  });
  await t.test('Suspended passes, and the log says so', async (st) => {
    const store = await storage(st, { objects: OLD, versioning: 'Suspended' });
    const { answer, output } = await runOnce(st, store);
    assert.equal(answer.outcome, 'ok');
    assert.match(output, /The bucket's versioning is Suspended/);
    assert.equal(store.keys().length, 3);
  });
  await t.test('a refused read fails the run before anything is uploaded', async (st) => {
    const store = await storage(st, { objects: OLD });
    store.intercept = (request) =>
      'versioning' in request.params ? { status: 403, body: errorXml('AccessDenied') } : undefined;
    const { answer } = await runOnce(st, store);
    assert.deepEqual(answer, {
      outcome: 'fail',
      message: "reading the bucket's versioning answered 403 AccessDenied",
      mode: 0o644,
    });
    assert.equal(store.requests.length, 1, 'a refusal is not tried again');
    assert.deepEqual(store.keys(), Object.keys(OLD));
  });
  await t.test('an answer that is not a versioning configuration', async (st) => {
    for (const body of [
      '<html><body>proxy</body></html>',
      '',
      '<VersioningConfiguration><Status>On</Status></VersioningConfiguration>',
    ]) {
      const store = await storage(st, { objects: OLD });
      store.intercept = (request) =>
        'versioning' in request.params ? { status: 200, body } : undefined;
      const { answer } = await runOnce(st, store);
      assert.deepEqual(
        [answer.outcome, answer.message],
        ['fail', "the bucket's versioning answer was not understood"],
        body,
      );
      assert.equal(store.requests.length, 1);
    }
  });
  await t.test('OFFSITE_CHECK_VERSIONING=false does not ask', async (st) => {
    const store = await storage(st, { objects: OLD, versioning: 'Enabled' });
    const { answer, output } = await runOnce(st, store, {
      env: { OFFSITE_CHECK_VERSIONING: 'false' },
    });
    assert.equal(answer.outcome, 'ok');
    assert.ok(store.requests.every((request) => !('versioning' in request.params)));
    assert.match(
      output,
      /The bucket's versioning is not read \(OFFSITE_CHECK_VERSIONING is false\)/,
    );
  });
});

test('each failure reaches the answer, described by its status and the storage’s code', async (t) => {
  const isList = (request) => request.params['list-type'] === '2';
  const cases = {
    'the upload is refused': {
      intercept: (request) =>
        request.method === 'PUT' ? { status: 403, body: errorXml('AccessDenied') } : undefined,
      message: `uploading ${NEW} answered 403 AccessDenied`,
      keys: Object.keys(OLD),
      calls: 2,
    },
    'the signature is refused': {
      intercept: (request) =>
        request.method === 'PUT'
          ? { status: 403, body: errorXml('SignatureDoesNotMatch', `${KEY_ID} ${SECRET}`) }
          : undefined,
      message: `uploading ${NEW} answered 403 SignatureDoesNotMatch`,
      keys: Object.keys(OLD),
      calls: 2,
    },
    'the bucket does not exist': {
      env: { OFFSITE_BUCKET: 'qa-tools-no-such-bucket' },
      message: "reading the bucket's versioning answered 404 NoSuchBucket",
      keys: Object.keys(OLD),
      calls: 1,
    },
    'the listing is refused': {
      intercept: (request) =>
        isList(request) ? { status: 403, body: errorXml('AccessDenied') } : undefined,
      message: `listing the bucket answered 403 AccessDenied; ${NEW} was uploaded and nothing was deleted`,
      keys: [...Object.keys(OLD), NEW],
      calls: 3,
    },
    'a delete is refused': {
      intercept: (request) =>
        request.method === 'DELETE' ? { status: 403, body: errorXml('AccessDenied') } : undefined,
      message: `deleting ${copyName('20260928T000000Z')} answered 403 AccessDenied`,
      keys: [...Object.keys(OLD), NEW],
      calls: 4,
    },
    'the storage redirects': {
      intercept: (request) =>
        request.method === 'PUT'
          ? {
              status: 307,
              body: errorXml('TemporaryRedirect'),
              headers: { location: 'http://127.0.0.1:1/elsewhere' },
            }
          : undefined,
      message: `uploading ${NEW} answered 307 TemporaryRedirect`,
      keys: Object.keys(OLD),
      calls: 2,
    },
    'an error without a readable code': {
      intercept: (request) =>
        request.method === 'PUT'
          ? { status: 400, body: `<Error><Code>Bad Code ${SECRET}</Code></Error>` }
          : undefined,
      message: `uploading ${NEW} answered 400`,
      keys: Object.keys(OLD),
      calls: 2,
    },
    'the listing does not show the new copy': {
      intercept: (request) =>
        isList(request)
          ? {
              status: 200,
              body: '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
            }
          : undefined,
      message: `the bucket's listing does not show ${NEW}, which was uploaded. Nothing was deleted.`,
      keys: [...Object.keys(OLD), NEW],
      calls: 3,
    },
    'the listing shows the new copy with another size': {
      intercept: (request) =>
        isList(request)
          ? {
              status: 200,
              body: `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${NEW}</Key><Size>9</Size></Contents></ListBucketResult>`,
            }
          : undefined,
      message: `the bucket lists ${NEW} with 9 bytes, not the 10 uploaded. Nothing was deleted.`,
      keys: [...Object.keys(OLD), NEW],
      calls: 3,
    },
    'the listing is not a listing': {
      intercept: (request) =>
        isList(request) ? { status: 200, body: '<html>proxy</html>' } : undefined,
      message: `the listing was not understood; ${NEW} was uploaded and nothing was deleted`,
      keys: [...Object.keys(OLD), NEW],
      calls: 3,
    },
    'the listing is cut off': {
      intercept: (request) =>
        isList(request)
          ? {
              status: 200,
              body: `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${NEW}</Key><Si`,
            }
          : undefined,
      message: `the listing was cut off inside an entry; ${NEW} was uploaded and nothing was deleted`,
      keys: [...Object.keys(OLD), NEW],
      calls: 3,
    },
    'the listing never ends': {
      intercept: (request) =>
        isList(request)
          ? {
              status: 200,
              body: `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>again</NextContinuationToken><Contents><Key>${NEW}</Key><Size>10</Size></Contents></ListBucketResult>`,
            }
          : undefined,
      message: "the bucket's listing did not end within 5 pages. Nothing was deleted.",
      keys: [...Object.keys(OLD), NEW],
      calls: 7,
    },
    'a listing page is larger than 2 MiB': {
      intercept: (request) =>
        isList(request)
          ? {
              status: 200,
              body: `<ListBucketResult>${`<Contents><Key>${'k'.repeat(2100)}</Key><Size>1</Size></Contents>`.repeat(1000)}</ListBucketResult>`,
            }
          : undefined,
      message: `listing the bucket answered with more than 2097152 bytes; ${NEW} was uploaded and nothing was deleted`,
      keys: [...Object.keys(OLD), NEW],
      calls: 3,
    },
  };
  for (const [name, expected] of Object.entries(cases)) {
    await t.test(name, async (st) => {
      const store = await storage(st, { objects: OLD });
      if (expected.intercept) store.intercept = expected.intercept;
      const { answer, output } = await runOnce(st, store, { env: expected.env });
      assert.deepEqual(answer, { outcome: 'fail', message: expected.message, mode: 0o644 });
      assert.deepEqual(store.keys(), [...expected.keys].sort());
      assert.equal(store.requests.length, expected.calls, store.calls().join('\n'));
      assert.match(output, /Off-server copy failed: /);
      assert.doesNotMatch(output, /Off-server copy succeeded|stand-in|proxy/);
    });
  }
});

test('a request that gets no answer, or a 5xx or 429, is tried again; any other refusal is not', async (t) => {
  await t.test('one 503, then the upload goes through', async (st) => {
    const store = await storage(st, { objects: OLD });
    let failed = 0;
    store.intercept = (request) =>
      request.method === 'PUT' && (failed += 1) === 1
        ? { status: 503, body: errorXml('SlowDown') }
        : undefined;
    const { answer, output } = await runOnce(st, store);
    assert.equal(answer.outcome, 'ok');
    assert.match(
      output,
      new RegExp(`uploading ${NEW.replace(/\./g, '\\.')}: attempt 1 of 3 answered 503 SlowDown`),
    );
    assert.equal(store.requests.filter((request) => request.method === 'PUT').length, 2);
    assert.equal(store.keys().length, 3);
  });
  await t.test('429 on the listing, once', async (st) => {
    const store = await storage(st, { objects: OLD });
    let failed = 0;
    store.intercept = (request) =>
      request.params['list-type'] === '2' && (failed += 1) === 1
        ? { status: 429, body: errorXml('TooManyRequests') }
        : undefined;
    const { answer } = await runOnce(st, store);
    assert.equal(answer.outcome, 'ok');
  });
  await t.test('500 three times fails after the third attempt', async (st) => {
    const store = await storage(st, { objects: OLD });
    store.intercept = (request) =>
      request.method === 'PUT' ? { status: 500, body: errorXml('InternalError') } : undefined;
    const { answer, output } = await runOnce(st, store);
    assert.deepEqual(
      [answer.outcome, answer.message],
      ['fail', `uploading ${NEW} answered 500 InternalError`],
    );
    assert.equal(store.requests.filter((request) => request.method === 'PUT').length, 3);
    assert.equal(output.match(/attempt \d of 3 answered 500 InternalError/g).length, 2);
    assert.deepEqual(store.keys(), Object.keys(OLD));
  });
  await t.test('OFFSITE_ATTEMPTS=1 does not try again', async (st) => {
    const store = await storage(st, { objects: OLD });
    store.intercept = (request) =>
      request.method === 'PUT' ? { status: 500, body: errorXml('InternalError') } : undefined;
    await runOnce(st, store, { env: { OFFSITE_ATTEMPTS: '1' } });
    assert.equal(store.requests.filter((request) => request.method === 'PUT').length, 1);
  });
  await t.test('nothing listens', async (st) => {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${closed.address().port}`;
    await new Promise((resolve) => closed.close(resolve));
    const { answer, output } = await runOnce(st, { url });
    assert.deepEqual(
      [answer.outcome, answer.message],
      ['fail', "reading the bucket's versioning failed: ECONNREFUSED"],
    );
    assert.equal(output.match(/attempt \d of 3 failed: ECONNREFUSED/g).length, 2);
  });
  // In these four the upload is the first request — the versioning read is
  // switched off — so that no limit under test has to be met by a request the
  // test is not about, however slow the machine.
  // The upload is answered, but ten times later than the second of silence
  // allowed, by a timer of the stand-in's that no machine makes come early.
  // An uploader whose silence limit fired ten times late or more would take
  // that answer and go on to another message; a correct one takes it only if
  // its own timer, in its own process, comes 9 s late. (Within one process,
  // where a timer due first fires first, the test of `exchange` below catches
  // a silence limit that fires a quarter late.)
  await t.test('the storage does not answer within the limit', async (st) => {
    const store = await storage(st, { objects: OLD });
    store.intercept = (request) =>
      request.method === 'PUT' ? { status: 200, delayMs: 10_000 } : undefined;
    const { answer } = await runOnce(st, store, {
      env: {
        OFFSITE_CHECK_VERSIONING: 'false',
        OFFSITE_TIMEOUT_SECONDS: '1',
        OFFSITE_ATTEMPTS: '2',
      },
    });
    assert.deepEqual(
      [answer.outcome, answer.message],
      ['fail', `uploading ${NEW} failed: no answer within 1 s`],
    );
    const puts = () => store.requests.filter((request) => request.method === 'PUT').length;
    await until(() => puts() >= 2, 'the stand-in to have read both attempts');
    assert.equal(puts(), 2);
  });
  // Ten attempts, each 0.4 s of silence at least, take 4 s and more on any
  // machine; the run's 2 s end them first. What ended them is read from the
  // message and from the number of attempts, not from a clock: however slow
  // the machine, an attempt that finds the run's time up says so, and fewer
  // than ten were made.
  await t.test('the whole run has a limit of its own', async (st) => {
    const store = await storage(st, { objects: OLD });
    store.intercept = (request) => (request.method === 'PUT' ? { hang: true } : undefined);
    const { answer } = await runOnce(st, store, {
      env: {
        OFFSITE_CHECK_VERSIONING: 'false',
        OFFSITE_TIMEOUT_SECONDS: '0.4',
        OFFSITE_ATTEMPTS: '10',
        OFFSITE_DEADLINE_SECONDS: '2',
      },
    });
    assert.equal(answer.outcome, 'fail');
    assert.match(
      answer.message,
      new RegExp(
        `^uploading ${NEW.replace(/\./g, '\\.')} (failed: no answer within \\d+(\\.\\d+)? s, and the run's 2 s leave no time for another attempt|did not start within the run's 2 s from the hand-over)$`,
      ),
    );
    const puts = store.requests.filter((request) => request.method === 'PUT').length;
    assert.ok(puts < 10, `${puts} attempts were made`);
  });
  // The limit is looked at before the pause for another attempt: with 60 s
  // between attempts and 20 s for the run, the failure comes with the first
  // attempt's end. A pause would show as the line that announces it, and as a
  // second attempt after it.
  await t.test('the limit is noticed before the pause, not after it', async (st) => {
    const store = await storage(st, { objects: OLD });
    store.intercept = (request) =>
      request.method === 'PUT' ? { status: 503, body: errorXml('SlowDown') } : undefined;
    const { answer, output } = await runOnce(st, store, {
      env: {
        OFFSITE_CHECK_VERSIONING: 'false',
        OFFSITE_RETRY_SECONDS: '60',
        OFFSITE_DEADLINE_SECONDS: '20',
      },
    });
    assert.deepEqual(
      [answer.outcome, answer.message],
      [
        'fail',
        `uploading ${NEW} answered 503 SlowDown, and the run's 20 s leave no time for another attempt`,
      ],
    );
    assert.equal(store.requests.filter((request) => request.method === 'PUT').length, 1);
    assert.doesNotMatch(output, /attempt 1 of 3/);
  });
  await t.test('a step that cannot be done within the limit says so', async (st) => {
    const store = await storage(st, { objects: OLD });
    // The versioning read is answered a second after the whole limit has
    // passed: a timer of the stand-in's, which no machine makes come early.
    store.intercept = (request) =>
      'versioning' in request.params
        ? { status: 200, delayMs: 1500, body: '<VersioningConfiguration/>' }
        : undefined;
    const { answer } = await runOnce(st, store, {
      env: { OFFSITE_DEADLINE_SECONDS: '0.5' },
    });
    assert.equal(answer.outcome, 'fail');
    // Cut while waiting for the answer; or, on a machine so slow that the
    // limit passed before the request was made, not begun.
    assert.match(
      answer.message,
      /^reading the bucket's versioning (failed: no answer within 0\.\d+ s, and the run's 0\.5 s leave no time for another attempt|did not start within the run's 0\.5 s from the hand-over)$/,
    );
    assert.ok(store.requests.every((request) => request.method === 'GET'));
    assert.deepEqual(store.keys(), Object.keys(OLD));
  });
});

test('a missing credential or a wrong setting fails the copy without asking the storage anything', async (t) => {
  const cases = {
    'the Secret is missing': [
      { OFFSITE_ACCESS_KEY_ID: undefined, OFFSITE_SECRET_ACCESS_KEY: undefined },
      'OFFSITE_ACCESS_KEY_ID is not set (Secret or key missing)',
    ],
    'the key id is missing': [
      { OFFSITE_ACCESS_KEY_ID: '' },
      'OFFSITE_ACCESS_KEY_ID is not set (Secret or key missing)',
    ],
    'the secret key is missing': [
      { OFFSITE_SECRET_ACCESS_KEY: undefined },
      'OFFSITE_SECRET_ACCESS_KEY is not set (Secret or key missing)',
    ],
    'a key id that is not one': [
      { OFFSITE_ACCESS_KEY_ID: 'two words' },
      'OFFSITE_ACCESS_KEY_ID does not look like a key id',
    ],
    'a secret key with a line break in it': [
      { OFFSITE_SECRET_ACCESS_KEY: 'first-line-of-it\r\nx-injected: 1' },
      'OFFSITE_SECRET_ACCESS_KEY does not look like a secret key',
    ],
    'the bucket is empty': [{ OFFSITE_BUCKET: '' }, 'OFFSITE_BUCKET is not set'],
    'a bucket name with a path in it': [
      { OFFSITE_BUCKET: 'bucket/../other' },
      'OFFSITE_BUCKET is not a bucket name',
    ],
    'plain http off the loopback interface': [
      { OFFSITE_ENDPOINT: 'http://storage.yandexcloud.net' },
      'OFFSITE_ENDPOINT is not an https URL without a path',
    ],
    'an endpoint with a credential in it': [
      { OFFSITE_ENDPOINT: 'https://user:password@storage.yandexcloud.net' },
      'OFFSITE_ENDPOINT is not an https URL without a path',
    ],
    'no region': [{ OFFSITE_REGION: '' }, 'OFFSITE_REGION is not a region name'],
    'no database': [{ OFFSITE_DATABASE: undefined }, 'OFFSITE_DATABASE is not a database name'],
    'keep 0': [{ OFFSITE_KEEP: '0' }, 'OFFSITE_KEEP must be a whole number from 1'],
    'a versioning switch that is neither': [
      { OFFSITE_CHECK_VERSIONING: 'no' },
      'OFFSITE_CHECK_VERSIONING must be true or false',
    ],
  };
  for (const [name, [env, message]] of Object.entries(cases)) {
    await t.test(name, async (st) => {
      const store = await storage(st, { objects: OLD });
      const { answer, output } = await runOnce(st, store, { env });
      assert.deepEqual(answer, { outcome: 'fail', message, mode: 0o644 });
      assert.equal(store.requests.length, 0, 'the storage was asked');
      assert.deepEqual(store.keys(), Object.keys(OLD));
      assert.ok(output.includes(`${message}: no copy can be uploaded`), output);
      assert.ok(output.includes(`Off-server copy failed: ${message}`), output);
    });
  }

  await t.test('a copy of another database is not uploaded', async (st) => {
    const store = await storage(st, { objects: OLD });
    const other = 'other_db-20261002T000000Z.dump.gpg';
    const { answer } = await runOnce(st, store, { name: other });
    assert.deepEqual(
      [answer.outcome, answer.message],
      ['fail', `${other} is not a copy of qa_tools, the database this job backs up`],
    );
    assert.equal(store.requests.length, 0);
  });
  await t.test('an empty file is not uploaded', async (st) => {
    const store = await storage(st, { objects: OLD });
    const { answer } = await runOnce(st, store, { content: '' });
    assert.deepEqual([answer.outcome, answer.message], ['fail', `${NEW} is empty or not a file`]);
    assert.equal(store.requests.length, 0);
  });
});

test('a listing of several pages is read to its end before anything is deleted', async (t) => {
  const objects = { ...OTHERS };
  for (let day = 1; day <= 9; day += 1) objects[copyName(`2026090${day}T000000Z`)] = `day ${day}`;
  const store = await storage(t, { objects, pageSize: 4 });
  const { answer } = await runOnce(t, store);
  assert.equal(answer.outcome, 'ok');
  const lists = store.requests.filter((request) => request.params['list-type'] === '2');
  // Sixteen objects under the prefix, the new copy among them, four a page.
  assert.equal(lists.length, 4);
  assert.equal(lists[0].params['continuation-token'], undefined);
  assert.equal(lists[1].params['continuation-token'], store.token(4));
  assert.ok(lists.every((request) => request.refusal === null));
  const firstDelete = store.requests.findIndex((request) => request.method === 'DELETE');
  assert.ok(store.requests.slice(firstDelete).every((request) => request.method === 'DELETE'));
  assert.deepEqual(
    store.keys(),
    [
      ...Object.keys(OTHERS),
      copyName('20260908T000000Z'),
      copyName('20260909T000000Z'),
      NEW,
    ].sort(),
  );
});

test('only a name db-backup.sh gives a copy is taken, and a copy that has its answer is left alone', async (t) => {
  const store = await storage(t, { objects: OLD });
  const dir = handOverDir(t);
  // What else the directory may hold: the temporary name of a copy still being
  // written, an answer, and a copy answered before a restart.
  const done = copyName('20261001T120000Z');
  writeFileSync(join(dir, `.${NEW}.tmp`), 'half');
  writeFileSync(join(dir, 'qa_tools-20261002T000000Z.dump'), 'a plain dump must never be here');
  writeFileSync(join(dir, 'notes.gpg'), 'x');
  handOver(dir, done, 'earlier');
  writeFileSync(join(dir, `${done}.result`), 'ok\nearlier\n');
  const run = start({ OFFSITE_DIR: dir, OFFSITE_ENDPOINT: store.url });
  t.after(() => run.child.kill('SIGKILL'));
  await until(() => run.output().includes('waiting for a copy'), 'the uploader to start');
  await sleep(400);
  assert.equal(store.requests.length, 0, 'something that is not a new copy was uploaded');
  assert.equal(readFileSync(join(dir, `${done}.result`), 'utf8'), 'ok\nearlier\n');
  run.child.kill('SIGTERM');
  const result = await run.exited;
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.output, /Found /);
});

test('a copy whose answer cannot be written is not uploaded again and again', async (t) => {
  const store = await storage(t);
  const dir = handOverDir(t);
  // A directory where the answer's temporary file belongs: writing it fails,
  // whoever runs the test, and no answer appears beside the copy.
  mkdirSync(join(dir, `.${NEW}.result.tmp`));
  writeFileSync(join(dir, `.${NEW}.result.tmp`, 'in the way'), '');
  const run = start({ OFFSITE_DIR: dir, OFFSITE_ENDPOINT: store.url });
  t.after(() => run.child.kill('SIGKILL'));
  handOver(dir, NEW, 'ciphertext');
  await until(() => run.output().includes('could not be written'), 'the failed answer');
  await sleep(400); // about a dozen looks
  run.child.kill('SIGTERM');
  const result = await run.exited;
  assert.equal(result.code, 0);
  assert.match(
    result.output,
    new RegExp(`The result for ${NEW.replace(/\./g, '\\.')} could not be written: E[A-Z]+\n`),
  );
  assert.equal(result.output.match(/Found /g).length, 1);
  assert.equal(store.requests.filter((request) => request.method === 'PUT').length, 1);
  assert.ok(!existsSync(join(dir, `${NEW}.result`)));
});

test('a stop signal ends a waiting uploader at once, and one in the middle of a request too', async (t) => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    await t.test(`${signal} while waiting`, async (st) => {
      const store = await storage(st);
      const dir = handOverDir(st);
      // It looks for a copy once a minute, the longest a setting allows, and
      // has had a second to begin its first nap when the signal comes: one
      // whose stop did not end the nap would wait it out, up to a minute.
      // Half of that is far more than a stop takes anywhere.
      const run = start({
        OFFSITE_DIR: dir,
        OFFSITE_ENDPOINT: store.url,
        OFFSITE_POLL_SECONDS: '60',
      });
      st.after(() => run.child.kill('SIGKILL'));
      await until(() => run.output().includes('waiting for a copy'), 'the uploader to start');
      await sleep(1000);
      const stopped = Date.now();
      run.child.kill(signal);
      const result = await run.exited;
      assert.equal(result.code, 0);
      assert.ok(Date.now() - stopped < 30_000, 'the stop was not immediate');
      assert.match(result.output, new RegExp(`Stopped by ${signal}`));
      assert.equal(store.requests.length, 0);
      assertNoCredential(result.output);
    });
  }
  await t.test('SIGTERM during an upload that hangs', async (st) => {
    const store = await storage(st);
    store.intercept = (request) => (request.method === 'PUT' ? { hang: true } : undefined);
    const dir = handOverDir(st);
    // The request would wait 300 s for an answer; the stop must not.
    const run = start({
      OFFSITE_DIR: dir,
      OFFSITE_ENDPOINT: store.url,
      OFFSITE_TIMEOUT_SECONDS: '300',
      OFFSITE_DEADLINE_SECONDS: '600',
    });
    st.after(() => run.child.kill('SIGKILL'));
    handOver(dir, NEW, 'ciphertext');
    await until(() => store.requests.some((request) => request.method === 'PUT'), 'the upload');
    const stopped = Date.now();
    run.child.kill('SIGTERM');
    const result = await run.exited;
    assert.equal(result.code, 0);
    assert.ok(Date.now() - stopped < 60_000, 'the stop waited for the request');
    const answer = await answerFor(dir, NEW);
    assert.deepEqual(
      [answer.outcome, answer.message],
      ['fail', `uploading ${NEW} was stopped by SIGTERM`],
    );
    assertNoCredential(result.output, answer.message);
  });
});

test('a hand-over directory that is not there is logged once, and the uploader still waits to be stopped', async (t) => {
  const store = await storage(t);
  const dir = join(handOverDir(t), 'gone');
  const run = start({ OFFSITE_DIR: dir, OFFSITE_ENDPOINT: store.url });
  t.after(() => run.child.kill('SIGKILL'));
  // Once it has looked and said so, about fifteen more looks.
  await until(() => run.output().includes('could not be read'), 'the first look');
  await sleep(500);
  assert.equal(run.child.exitCode, null);
  run.child.kill('SIGTERM');
  const result = await run.exited;
  assert.equal(result.code, 0);
  assert.equal(
    result.output.match(/The hand-over directory could not be read: ENOENT/g)?.length,
    1,
  );

  const relative = start({ OFFSITE_DIR: 'offsite', OFFSITE_ENDPOINT: store.url });
  t.after(() => relative.child.kill('SIGKILL'));
  await until(() => relative.output().includes('waiting for a copy'), 'the uploader to start');
  await sleep(200);
  assert.equal(relative.child.exitCode, null);
  relative.child.kill('SIGTERM');
  const second = await relative.exited;
  assert.equal(second.code, 0);
  assert.match(second.output, /OFFSITE_DIR is not an absolute path/);
});

// --- Through `main`, with stand-ins for the exchange and the pause ---------------

// Runs `main` in this process against a stand-in for its exchange with the
// storage; resolves once the copy has its answer, then stops it. With `size`
// the copy is a sparse file of that many bytes instead of `content`.
async function inProcess(
  t,
  { env = {}, transport, pause, content = 'ciphertext', size = null, signals = new EventEmitter() },
) {
  const dir = handOverDir(t);
  if (size === null) handOver(dir, NEW, content);
  else {
    const path = join(dir, `.${NEW}.tmp`);
    writeFileSync(path, '');
    truncateSync(path, size);
    renameSync(path, join(dir, NEW));
  }
  const lines = [];
  const done = main({
    env: {
      OFFSITE_DIR: dir,
      OFFSITE_ENDPOINT: 'https://storage.yandexcloud.net',
      OFFSITE_REGION: REGION,
      OFFSITE_BUCKET: BUCKET,
      OFFSITE_DATABASE: 'qa_tools',
      OFFSITE_ACCESS_KEY_ID: KEY_ID,
      OFFSITE_SECRET_ACCESS_KEY: SECRET,
      OFFSITE_POLL_SECONDS: '0.02',
      ...env,
    },
    transport,
    signals,
    out: { write: (text) => lines.push(text) },
    ...(pause ? { pause } : {}),
  });
  const answer = await answerFor(dir, NEW, { output: () => lines.join('') });
  signals.emit('SIGTERM');
  assert.equal(await done, 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  return { answer, output: lines.join('') };
}

test('the defaults: three attempts five seconds apart, sixty seconds a request, https to the real host', async (t) => {
  assert.deepEqual(DEFAULTS, {
    keep: 3,
    pollSeconds: 1,
    timeoutSeconds: 60,
    attempts: 3,
    retrySeconds: 5,
    deadlineSeconds: 240,
  });
  const requests = [];
  const pauses = [];
  const { answer, output } = await inProcess(t, {
    transport: async (options) => {
      requests.push(options);
      return { status: 500, text: errorXml('InternalError'), over: false };
    },
    // The pause before another attempt is recorded and skipped; the looks for
    // a copy and the wait for the stop signal are slept.
    pause: async (ms, value, options) => {
      if (ms === 5000) pauses.push(ms);
      else await sleep(ms, value, options);
    },
  });
  assert.deepEqual(
    [answer.outcome, answer.message],
    ['fail', "reading the bucket's versioning answered 500 InternalError"],
  );
  assert.equal(requests.length, 3);
  assert.deepEqual(pauses, [5000, 5000]);
  for (const options of requests) {
    // Signed as `versioning=`, sent as the AWS SDKs and CLI send it.
    assert.equal(options.url, `https://storage.yandexcloud.net/${BUCKET}?versioning`);
    assert.equal(options.method, 'GET');
    assert.equal(options.file, null);
    assert.equal(options.headers.host, 'storage.yandexcloud.net');
    assert.equal(options.headers['content-length'], undefined);
    assert.equal(options.maxBytes, 64 * 1024);
    assert.equal(options.idleMs, 60_000);
    assert.deepEqual(options.progress, { sent: 0, received: 0 });
    assert.ok(options.signal instanceof globalThis.AbortSignal);
    assert.match(
      options.headers.authorization,
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${KEY_ID}/\\d{8}/ru-central1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`,
      ),
    );
    assert.equal(options.headers['x-amz-content-sha256'], sha256(''));
  }
  assertNoCredential(output, answer.message);
});

test('an error inside the uploader is logged by its name alone, and it still waits to be stopped', async () => {
  const secret = 'Zq'.repeat(20);
  // An environment that fails as it is read, with the value in its message.
  const env = new Proxy(
    {},
    {
      get(target, key) {
        if (key === 'OFFSITE_SECRET_ACCESS_KEY') throw new Error(`could not read ${secret}`);
        return undefined;
      },
    },
  );
  const signals = new EventEmitter();
  const lines = [];
  let finished = false;
  const done = main({ env, signals, out: { write: (text) => lines.push(text) } }).then((code) => {
    finished = true;
    return code;
  });
  await sleep(200);
  assert.equal(finished, false, 'the uploader ended before it was stopped');
  signals.emit('SIGTERM');
  assert.equal(await done, 0);
  const output = lines.join('');
  assert.match(output, /The uploader stopped on an error: Error\n/);
  assert.match(output, /Stopped by SIGTERM/);
  assert.ok(!output.toLowerCase().includes(secret.toLowerCase()), 'the message reached the output');
});

test('a request that fails with the credential in its message is described by its code or name alone', async (t) => {
  const { answer, output } = await inProcess(t, {
    env: { OFFSITE_ATTEMPTS: '1' },
    transport: async (options) => {
      throw new TypeError(
        `request failed for ${options.url} with ${options.headers.authorization} and ${SECRET}`,
        { cause: new Error(`connect to ${KEY_ID} failed`) },
      );
    },
  });
  assert.deepEqual(
    [answer.outcome, answer.message],
    ['fail', "reading the bucket's versioning failed: TypeError"],
  );
  assertNoCredential(output, answer.message);
});

// --- Made-up input built to break the parsing, at growing sizes ------------------

const SIZES = [1_000, 10_000, 100_000, 1_000_000];
// For one call. What it is there to catch is a scan that is quadratic in its
// input, which at the largest size takes hours; what it must never catch is a
// linear one on a shared runner that gives the test a tenth of a processor,
// where the slowest of these calls, a fraction of a second on a free machine,
// takes a few seconds.
const LIMIT_MS = 120_000;

function timed(what, fn) {
  const started = process.hrtime.bigint();
  let result;
  let error;
  try {
    result = fn();
  } catch (caught) {
    error = caught;
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < LIMIT_MS, `${what} took ${Math.round(ms)} ms`);
  return { result, error, ms };
}

// --- The copy is streamed, not held in memory, and its time follows progress ----

// A storage that only counts and hashes what arrives, keeping nothing, so that
// a copy of any size costs this process nothing. It can be made slow, and says
// how slow it was, by its own clock:
//
//   `pauses: { every, ms, count }` — each time it has taken another `every`
//     bytes of an upload it stops taking for `ms` milliseconds, `count` times
//     (without `count`, for as long as the upload lasts), and takes at full
//     speed in between. A pause is a timer of this process: no machine, fast
//     or slow, makes it shorter, so `count` pauses last `count` x `ms` at
//     least. It is not a rate: a pause for every chunk, of the chunk's length
//     over a rate, came to less than the rate promised wherever a timer of 3.9
//     ms fires after 3.
//   `stallAfter` — it stops taking an upload after that many bytes, for good.
//   `pages` — the listing: an array of whole answers, served in turn.
//
// `stats.uploads` holds, for each upload begun: the bytes taken, the pauses
// made and how long each really lasted, and the time from its first byte to
// its last.
async function intake(t, { pauses = null, stallAfter = Infinity, pages = null } = {}) {
  const seen = { puts: 0, bytes: 0, hash: null, declared: null, signedHash: null, chunked: null };
  const stats = { lists: 0, listBytes: 0, uploads: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stand-in');
    const hash = createHash('sha256');
    let bytes = 0;
    const upload = { taken: 0, pauses: [], firstByteAt: null, lastByteAt: null, intakeMs: 0 };
    if (req.method === 'PUT') stats.uploads.push(upload);
    req.on('data', (chunk) => {
      const now = performance.now();
      upload.firstByteAt ??= now;
      upload.lastByteAt = now;
      upload.intakeMs = now - upload.firstByteAt;
      bytes += chunk.length;
      upload.taken = bytes;
      hash.update(chunk);
      if (bytes >= stallAfter) return req.pause();
      const due =
        pauses !== null &&
        upload.pauses.length < (pauses.count ?? Infinity) &&
        bytes >= (upload.pauses.length + 1) * pauses.every;
      if (due) {
        req.pause();
        setTimeout(() => {
          upload.pauses.push(performance.now() - now);
          req.resume();
        }, pauses.ms);
      }
      return undefined;
    });
    req.on('end', () => {
      const send = (status, text = '') => {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(text);
      };
      if (req.method === 'PUT') {
        seen.puts += 1;
        seen.bytes = bytes;
        seen.hash = hash.digest('hex');
        seen.declared = req.headers['content-length'];
        seen.chunked = req.headers['transfer-encoding'] ?? null;
        seen.signedHash = req.headers['x-amz-content-sha256'];
        return send(200);
      }
      if (url.searchParams.has('versioning')) return send(200, '<VersioningConfiguration/>');
      stats.lists += 1;
      const text = pages
        ? pages[Math.min(stats.lists, pages.length) - 1]
        : `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${NEW}</Key><Size>${seen.bytes}</Size></Contents></ListBucketResult>`;
      stats.listBytes += text.length;
      return send(200, text);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, seen, stats };
}

// The uploader's `main` as the pod runs it, in a process of its own that says
// when it ends how much memory it peaked at. One copy of `size` bytes — a
// sparse file, which costs no disk and reads as zeros — is handed over; the
// answer, the output and the peak in KiB come back.
async function uploadInOwnProcess(t, url, { size, env = {} }) {
  const dir = handOverDir(t);
  const path = join(dir, `.${NEW}.tmp`);
  writeFileSync(path, '');
  truncateSync(path, size);
  const wrapper = `
    import { main } from ${JSON.stringify(new URL('../deploy/helm/qa-tools/files/db-backup-offsite.mjs', import.meta.url).href)};
    const code = await main();
    process.stdout.write('maxRSS ' + process.resourceUsage().maxRSS + '\\n');
    process.exitCode = code;
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', wrapper], {
    env: {
      PATH: process.env.PATH,
      OFFSITE_DIR: dir,
      OFFSITE_ENDPOINT: url,
      OFFSITE_REGION: REGION,
      OFFSITE_BUCKET: BUCKET,
      OFFSITE_DATABASE: 'qa_tools',
      OFFSITE_ACCESS_KEY_ID: KEY_ID,
      OFFSITE_SECRET_ACCESS_KEY: SECRET,
      OFFSITE_POLL_SECONDS: '0.03',
      OFFSITE_RETRY_SECONDS: '0.03',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  renameSync(path, join(dir, NEW));
  const answer = await answerFor(dir, NEW, { output: () => output });
  child.kill('SIGTERM');
  assert.equal(await exited, 0, output);
  assertNoCredential(output.replace(/^maxRSS \d+$/m, ''), answer.message);
  return { answer, output, peakKib: Number(/^maxRSS (\d+)$/m.exec(output)?.[1]) };
}

const MIB = 1024 * 1024;
// The chart's memory limit for the uploader (alerts.resources), in KiB.
const LIMIT_KIB = 128 * 1024;

// A copy of 256 MiB. Sent through one buffer the process stays near an idle
// Node process; read into memory, as the first version did through `fetch`,
// it held the whole copy and more, and was killed under the chart's 128Mi at
// about 100 MB.
test('a copy far larger than the uploader’s memory limit is uploaded without the process growing by it', async (t) => {
  const SIZE = 256 * MIB;
  const store = await intake(t);
  const { answer, output, peakKib } = await uploadInOwnProcess(t, store.url, { size: SIZE });
  assert.deepEqual(
    [answer.outcome, answer.message],
    ['ok', `uploaded ${NEW}, ${SIZE} bytes; deleted nothing; kept ${NEW}`],
    output,
  );
  // Every byte arrived, once, under a declared length, and is what was signed.
  assert.equal(store.seen.puts, 1);
  assert.equal(store.seen.bytes, SIZE);
  assert.equal(store.seen.declared, String(SIZE));
  assert.equal(store.seen.chunked, null);
  assert.equal(store.seen.hash, store.seen.signedHash);
  assert.ok(peakKib > 0, output);
  assert.ok(
    peakKib < LIMIT_KIB,
    `the uploader peaked at ${Math.round(peakKib / 1024)} MiB for a copy of ${SIZE / MIB} MiB: the body was held in memory`,
  );
});

// The request's limit is on silence. A storage that takes the copy in slowly
// but keeps taking it is not cut by that limit, however long the copy takes;
// one that stops taking it is, once the silence has lasted that long; and a
// copy still moving when the run's own limit is up is cut with a message that
// says what it is: too large for the time allowed, not a storage that cannot
// be reached.
//
// How long each upload lasted is the stand-in's to say, from its own pauses
// and its own clock; no bound here is on this process's wall clock. What the
// uploader sees as movement is bytes leaving for the connection, and a
// connection takes them in steps of up to a third of its send buffer as the
// other end reads. So each case is laid out for buffers far larger than any
// machine gives a loopback connection, and its margins are counted in pauses,
// not in milliseconds.
test('an upload is cut when it stalls, not when it is long: a slow one that keeps moving goes through', async (t) => {
  const SIZE = 256 * MIB;
  const quoted = NEW.replace(/\./g, '\\.');

  // Ten times, after each 16 MiB taken, the stand-in stands still for half a
  // second: 5 seconds of pauses at least, with 4 seconds of silence allowed.
  // The silence the uploader sees is one pause, eight times shorter than the
  // limit, as long as a third of the send buffer is no more than the 16 MiB
  // taken between two pauses, and at most four pauses for a buffer four times
  // that. The last 96 MiB are taken without a pause, so the pauses are over
  // while the uploader still has bytes to send, unless the connection holds
  // more than 96 MiB.
  await t.test('taken in over more than the silence allowed, never still for long', async (st) => {
    const SILENCE_S = 4;
    const pauses = { every: 16 * MIB, ms: 500, count: 10 };
    const store = await intake(st, { pauses });
    const { answer, output } = await uploadInOwnProcess(st, store.url, {
      size: SIZE,
      env: { OFFSITE_TIMEOUT_SECONDS: String(SILENCE_S), OFFSITE_ATTEMPTS: '1' },
    });
    // One upload begun: none is a run that failed before its PUT, two one that
    // was tried again. What the stand-in saw is read only once there is one.
    assert.equal(
      store.stats.uploads.length,
      1,
      `${store.stats.uploads.length} uploads begun; ${answer.outcome}: ${answer.message}\n${output}`,
    );
    const [upload] = store.stats.uploads;
    const standIn = `the stand-in took ${upload.taken} bytes over ${Math.round(upload.intakeMs)} ms, pausing ${upload.pauses.map((ms) => Math.round(ms)).join(', ')} ms`;
    assert.equal(answer.outcome, 'ok', `${answer.message}\n${standIn}\n${output}`);
    assert.equal(store.seen.bytes, SIZE);
    assert.equal(store.seen.hash, store.seen.signedHash);
    // By the stand-in's clock: every pause was made and none was cut short,
    // so the upload it took in lasted longer than the silence allowed.
    assert.equal(upload.pauses.length, pauses.count, standIn);
    assert.ok(Math.min(...upload.pauses) >= pauses.ms - 5, standIn);
    assert.ok(upload.intakeMs > SILENCE_S * 1000, standIn);
  });

  // The stand-in takes the first megabyte and no more. The connection goes on
  // taking bytes until its buffers are full, then nothing moves; the copy is
  // far larger than any buffer, so that happens part of the way.
  await t.test('a storage that stops taking the copy part of the way', async (st) => {
    const store = await intake(st, { stallAfter: 1 * MIB });
    const { answer, output } = await uploadInOwnProcess(st, store.url, {
      size: SIZE,
      env: { OFFSITE_TIMEOUT_SECONDS: '2', OFFSITE_ATTEMPTS: '2' },
    });
    assert.equal(answer.outcome, 'fail', output);
    const stalled = new RegExp(
      `^uploading ${quoted} stalled: no byte moved for 2 s after (\\d+) of ${SIZE} bytes$`,
    );
    assert.match(answer.message, stalled);
    const sent = Number(stalled.exec(answer.message)[1]);
    assert.ok(sent >= 1 * MIB && sent < SIZE, `${sent} bytes had left`);
    // Tried again, as a request without an answer is, and stalled again; the
    // stand-in took its megabyte each time and never the whole copy.
    assert.match(output, / attempt 1 of 2 stalled: no byte moved for 2 s after \d+ of \d+ bytes\n/);
    assert.equal(store.stats.uploads.length, 2);
    for (const upload of store.stats.uploads) {
      assert.ok(upload.taken >= 1 * MIB && upload.taken < 2 * MIB, `${upload.taken} bytes taken`);
    }
    assert.equal(store.seen.puts, 0, 'an upload was completed');
  });

  // After every megabyte the stand-in stands still for a tenth of a second,
  // for as long as the upload lasts: 256 pauses, 25 seconds at least, for a
  // copy the run gives 5. The silence allowed is 30 s, so that nothing but the
  // run's limit can end it, whatever the connection buffers: the uploader
  // need only have sent its first piece within those 5 seconds, and it sends
  // it at once, the upload being its first request here.
  await t.test('a copy too large for the run’s limit at the speed it moves', async (st) => {
    const store = await intake(st, { pauses: { every: 1 * MIB, ms: 100 } });
    const { answer, output } = await uploadInOwnProcess(st, store.url, {
      size: SIZE,
      env: {
        OFFSITE_CHECK_VERSIONING: 'false',
        OFFSITE_TIMEOUT_SECONDS: '30',
        OFFSITE_DEADLINE_SECONDS: '5',
      },
    });
    assert.equal(answer.outcome, 'fail', output);
    const cut = new RegExp(
      `^uploading ${quoted} was cut off by the run's 5 s after (\\d+) of ${SIZE} bytes: the copy is too large for the time allowed at this speed$`,
    );
    assert.match(answer.message, cut);
    const sent = Number(cut.exec(answer.message)[1]);
    assert.ok(sent > 0 && sent < SIZE, `${sent} bytes had left`);
    // One attempt: the copy was moving all along, and is not sent again. The
    // stand-in had taken part of it, a megabyte for each pause it made.
    assert.doesNotMatch(output, /attempt 1 of|no answer|stalled/);
    assert.equal(store.stats.uploads.length, 1);
    const [upload] = store.stats.uploads;
    assert.ok(upload.taken > 0 && upload.taken < SIZE, `${upload.taken} bytes taken`);
    assert.ok(
      upload.taken <= (upload.pauses.length + 2) * MIB,
      'the stand-in took more than it paused for',
    );
    // Each pause lasts a tenth of a second at least, by the stand-in's own
    // timer, so the pauses made say how long the upload lasted at least: 50 in
    // the run's 5 s, and twice that only if the uploader's limit came 5 s late
    // in its own process. Those made after the cut, on what the connection
    // still held, are counted too. An uploader whose limit fired three times
    // late let about 150 be made.
    assert.ok(
      upload.pauses.length <= 2 * ((5 * 1000) / 100),
      `the stand-in made ${upload.pauses.length} pauses of 100 ms before the run's 5 s ended the upload`,
    );
    assert.equal(store.seen.puts, 0, 'the upload was completed');
  });

  // The same copy, run by `main` in this process with the real exchange, so
  // that the run's limit and the stand-in's pauses are timers of one process,
  // where of two timers the one due first fires first however loaded the
  // machine. Each pause begins after the one before it has ended, and the
  // first after the attempt began, so when the run's 2 s are up at most 20
  // pauses of a tenth of a second can have ended; they are counted at that
  // moment, from the request's own signal. An uploader whose limit fired a
  // tenth late let a 21st end.
  await t.test(
    'in one process, the run’s limit cuts the copy before more pauses than fit in it',
    async (st) => {
      const PAUSE_MS = 100;
      const DEADLINE_S = 2;
      const store = await intake(st, { pauses: { every: 1 * MIB, ms: PAUSE_MS } });
      let atCut = null;
      const transport = (options) => {
        options.signal.addEventListener(
          'abort',
          () => (atCut ??= store.stats.uploads[0]?.pauses.length ?? -1),
          { once: true },
        );
        return exchange(options);
      };
      const { answer, output } = await inProcess(st, {
        size: SIZE,
        transport,
        env: {
          OFFSITE_ENDPOINT: store.url,
          OFFSITE_CHECK_VERSIONING: 'false',
          OFFSITE_TIMEOUT_SECONDS: '30',
          OFFSITE_RETRY_SECONDS: '0.03',
          OFFSITE_DEADLINE_SECONDS: String(DEADLINE_S),
        },
      });
      assert.match(
        answer.message,
        new RegExp(
          `^uploading ${quoted} was cut off by the run's ${DEADLINE_S} s after \\d+ of ${SIZE} bytes: the copy is too large for the time allowed at this speed$`,
        ),
        output,
      );
      assert.ok(atCut >= 0, `the upload had not begun when its signal ended it\n${output}`);
      assert.ok(
        atCut <= (DEADLINE_S * 1000) / PAUSE_MS,
        `${atCut} pauses of ${PAUSE_MS} ms had ended when the run's ${DEADLINE_S} s cut the upload`,
      );
    },
  );
});

// --- An upload cut by the run's limit after an earlier attempt failed (#121) ---
//
// When the run's limit cuts an upload still sending, the copy is "too large
// for the time allowed" only if no attempt of it failed before. After one,
// the time may have gone to that failure — a storage that stalled, said
// nothing or refused — so the latest earlier problem is named first and the
// cut after it. Each case runs in this process through a stand-in transport:
// every attempt fails at once as it is told, and the attempt the limit cuts
// reports what it had sent and waits for its signal. What ends that attempt is
// the run's own timer, not a socket's buffers, and the attempts before it take
// a few milliseconds of the run's second.

// The reproduction's copy, and what its last attempt had sent when it was cut.
const UPLOAD = { size: 24_000_000, cutAt: 2_752_512 };
const uploading = `uploading ${NEW}`;
const ranOutAt = (attempt, seconds = 1) =>
  `, and the run's ${seconds} s ran out during attempt ${attempt} after ${UPLOAD.cutAt} of ${UPLOAD.size} bytes`;
// The longest error code errorCode keeps: 64 characters.
const LONGEST_CODE = 'SlowDown'.repeat(8);

// One attempt of the stand-in transport, by how it ends and how much of the
// copy it had sent by then.
const stand = {
  // No byte moved for the silence allowed: part of the copy sent is a stall;
  // none or all of it, no answer.
  still: (sent) => ({
    sent,
    error: Object.assign(new Error('no byte moved'), { code: 'ESTALLED' }),
  }),
  // The whole copy sent, then this status and error code.
  answered: (status, code) => ({
    sent: UPLOAD.size,
    answer: { status, text: errorXml(code), over: false },
  }),
  // A system error, `ECONNRESET`, after `sent` bytes.
  error: (code, sent = 0) => ({
    sent,
    error: Object.assign(new Error(`stand-in ${code}`), { code }),
  }),
  // Still sending when the request's signal ends it.
  moving: () => ({ sent: UPLOAD.cutAt, moving: true }),
};

// A transport that plays `steps`, one an attempt: a list, or a function of
// the request's options and its number. Every request's options are kept.
function scripted(steps) {
  const requests = [];
  const transport = async (options) => {
    requests.push(options);
    const step = Array.isArray(steps)
      ? steps[requests.length - 1]
      : steps(options, requests.length);
    assert.ok(step, `request ${requests.length} was not expected`);
    options.progress.sent = step.sent;
    if (step.moving) {
      await new Promise((resolve, reject) => {
        const end = () => reject(options.signal.reason);
        if (options.signal.aborted) end();
        else options.signal.addEventListener('abort', end, { once: true });
      });
    }
    if (step.answer) return step.answer;
    throw step.error;
  };
  return { transport, requests };
}

// The upload of a 24 MB copy as `steps` play it, as its first request, with
// 2 s of silence allowed, no pause between attempts, one attempt for each
// step and 1 s for the run; `env` changes any of these.
async function cutAfter(t, steps, { env = {}, pause, signals } = {}) {
  const { transport, requests } = scripted(steps);
  const { answer, output } = await inProcess(t, {
    content: Buffer.alloc(UPLOAD.size),
    env: {
      OFFSITE_CHECK_VERSIONING: 'false',
      OFFSITE_TIMEOUT_SECONDS: '2',
      OFFSITE_RETRY_SECONDS: '0',
      OFFSITE_DEADLINE_SECONDS: '1',
      OFFSITE_ATTEMPTS: String(Array.isArray(steps) ? steps.length : 3),
      ...env,
    },
    transport,
    pause,
    signals,
  });
  assert.equal(answer.outcome, 'fail', output);
  assertNoCredential(output, answer.message);
  return { message: answer.message, output, requests };
}

test('an upload cut by the run’s limit after an earlier attempt failed names that failure first, never a copy too large', async (t) => {
  // The issue's reproduction, its 12 s for the run scaled to 2 and its pauses
  // of half a second recorded and skipped: two attempts stall part of the
  // way, and the third, sent from the start, is still moving when the run's
  // time is up. It used to end `was cut off by the run's 12 s after 2752512
  // of 24000000 bytes: the copy is too large for the time allowed at this
  // speed`.
  await t.test(
    'two stalls, then the third attempt still sending when the time is up',
    async (st) => {
      const pauses = [];
      const { message, output, requests } = await cutAfter(
        st,
        [stand.still(12_000_000), stand.still(11_796_480), stand.moving()],
        {
          env: { OFFSITE_RETRY_SECONDS: '0.5', OFFSITE_DEADLINE_SECONDS: '2' },
          pause: async (ms, value, options) => {
            if (ms === 500) pauses.push(ms);
            else await sleep(ms, value, options);
          },
        },
      );
      assert.equal(
        message,
        `${uploading} stalled: no byte moved for 2 s after 11796480 of 24000000 bytes${ranOutAt(3, 2)}`,
      );
      assert.doesNotMatch(message, /too large/);
      assert.ok(message.length <= MAX_FAILURE_LENGTH, `${message.length} characters`);
      // Each stall is logged as it happens, the first one too.
      assert.match(
        output,
        / attempt 1 of 3 stalled: no byte moved for 2 s after 12000000 of 24000000 bytes\n/,
      );
      assert.match(
        output,
        / attempt 2 of 3 stalled: no byte moved for 2 s after 11796480 of 24000000 bytes\n/,
      );
      assert.deepEqual(pauses, [500, 500]);
      assert.equal(requests.length, 3);
      for (const options of requests) assert.equal(options.headers['content-length'], '24000000');
    },
  );

  // The counterpart: an upload that has failed nowhere and is cut by the
  // run's time is a copy too large for it, attempts left or not.
  await t.test(
    'a single attempt still sending when the time is up: the copy is too large',
    async (st) => {
      const { message, output, requests } = await cutAfter(st, [stand.moving()], {
        env: { OFFSITE_ATTEMPTS: '3' },
      });
      assert.equal(
        message,
        `${uploading} was cut off by the run's 1 s after 2752512 of 24000000 bytes: the copy is too large for the time allowed at this speed`,
      );
      assert.doesNotMatch(output, /attempt 1 of/);
      assert.equal(requests.length, 1);
    },
  );

  // Only an attempt of the upload counts: the versioning read failing once
  // before it says nothing about the upload's own time.
  await t.test('a failed attempt of another request does not count', async (st) => {
    const { message, output, requests } = await cutAfter(
      st,
      (options, number) => {
        if (options.method === 'PUT') return stand.moving();
        return number === 1
          ? stand.answered(503, 'SlowDown')
          : { sent: 0, answer: { status: 200, text: '<VersioningConfiguration/>', over: false } };
      },
      { env: { OFFSITE_CHECK_VERSIONING: 'true' } },
    );
    assert.match(output, /reading the bucket's versioning: attempt 1 of 3 answered 503 SlowDown\n/);
    assert.equal(
      message,
      `${uploading} was cut off by the run's 1 s after 2752512 of 24000000 bytes: the copy is too large for the time allowed at this speed`,
    );
    assert.deepEqual(
      requests.map((options) => options.method),
      ['GET', 'GET', 'PUT'],
    );
  });

  // Every kind of earlier failure an upload is tried again after; with
  // several, the latest is named, whichever it is.
  const cases = {
    'an earlier attempt that got no answer': [[stand.still(0)], 'failed: no answer within 2 s'],
    'an earlier attempt that sent the whole copy and got no answer': [
      [stand.still(UPLOAD.size)],
      'failed: no answer within 2 s',
    ],
    'an earlier 503': [[stand.answered(503, 'SlowDown')], 'answered 503 SlowDown'],
    'an earlier 429': [[stand.answered(429, 'TooManyRequests')], 'answered 429 TooManyRequests'],
    'an earlier 500 with the longest error code kept': [
      [stand.answered(500, LONGEST_CODE)],
      `answered 500 ${LONGEST_CODE}`,
    ],
    'an earlier ECONNRESET part of the way': [
      [stand.error('ECONNRESET', 5_000_000)],
      'failed: ECONNRESET',
    ],
    'an earlier ECONNREFUSED': [[stand.error('ECONNREFUSED')], 'failed: ECONNREFUSED'],
    'a 503, a reset and a stall: the stall, the latest, is named': [
      [
        stand.answered(503, 'SlowDown'),
        stand.error('ECONNRESET', 1_000_000),
        stand.still(12_000_000),
      ],
      'stalled: no byte moved for 2 s after 12000000 of 24000000 bytes',
    ],
    'a stall, then a 503: the 503, the latest, is named': [
      [stand.still(12_000_000), stand.answered(503, 'SlowDown')],
      'answered 503 SlowDown',
    ],
  };
  for (const [name, [before, earlier]] of Object.entries(cases)) {
    await t.test(name, async (st) => {
      const { message, requests } = await cutAfter(st, [...before, stand.moving()]);
      const attempt = before.length + 1;
      assert.equal(message, `${uploading} ${earlier}${ranOutAt(attempt)}`);
      assert.equal(requests.length, attempt);
    });
  }

  // One problem is named however many attempts came before: the message for
  // the tenth is the second's but for one digit.
  await t.test(
    'OFFSITE_ATTEMPTS 2, 3 and 10: one earlier problem, a message of bounded length',
    async (st) => {
      const lengths = new Map();
      for (const attempts of [2, 3, 10]) {
        const before = Array.from({ length: attempts - 2 }, (_, index) =>
          index % 2 === 0 ? stand.answered(503, 'SlowDown') : stand.error('ECONNRESET', 1_000_000),
        );
        const { message, output } = await cutAfter(st, [
          ...before,
          stand.still(12_000_000),
          stand.moving(),
        ]);
        assert.equal(
          message,
          `${uploading} stalled: no byte moved for 2 s after 12000000 of 24000000 bytes${ranOutAt(attempts)}`,
        );
        assert.equal(
          output.match(new RegExp(` attempt \\d+ of ${attempts} `, 'g')).length,
          attempts - 1,
        );
        lengths.set(attempts, message.length);
      }
      assert.equal(lengths.get(3), lengths.get(2));
      assert.equal(lengths.get(10), lengths.get(2) + 1);
    },
  );

  // The earlier problem reaches the message as the log has it: scrubbed of
  // the credential, and with no code at all where the storage put something
  // that is not shaped like one.
  await t.test(
    'an earlier answer or error that carries the credential or a signature',
    async (st) => {
      const keyId = await cutAfter(st, [stand.answered(503, KEY_ID), stand.moving()]);
      assert.equal(keyId.message, `${uploading} answered 503 <access key id>${ranOutAt(2)}`);
      const signature = await cutAfter(st, (options, number) => {
        if (number > 1) return stand.moving();
        const signed = /Signature=([0-9a-f]{64})$/.exec(options.headers.authorization)[1];
        return stand.answered(503, `S${signed.slice(0, 63)}`);
      });
      assert.equal(signature.message, `${uploading} answered 503${ranOutAt(2)}`);
      const reset = await cutAfter(st, (options, number) =>
        number > 1
          ? stand.moving()
          : {
              sent: 1_000_000,
              error: Object.assign(
                new Error(`reset after ${options.headers.authorization} with ${SECRET}`),
                { code: 'ECONNRESET', cause: new Error(`from ${KEY_ID}`) },
              ),
            },
      );
      assert.equal(reset.message, `${uploading} failed: ECONNRESET${ranOutAt(2)}`);
    },
  );

  // A stop signal in the pause after a failed attempt ends the run as it
  // always has: stopped, with no attempt made after it.
  await t.test('SIGTERM in the pause after a stall', async (st) => {
    const signals = new EventEmitter();
    const { message, output, requests } = await cutAfter(
      st,
      [stand.still(12_000_000), stand.moving()],
      {
        env: { OFFSITE_RETRY_SECONDS: '0.5' },
        signals,
        pause: async (ms, value, options) => {
          if (ms === 500) signals.emit('SIGTERM');
          else await sleep(ms, value, options);
        },
      },
    );
    assert.equal(message, `${uploading} was stopped by SIGTERM`);
    assert.match(output, / attempt 1 of 2 stalled: no byte moved for 2 s after 12000000 of/);
    assert.match(output, /Stopped by SIGTERM\n/);
    assert.equal(requests.length, 1);
  });
});

// The same message at the longest each of its parts takes in production: the
// copy's name of 34 characters, byte counts of 10 digits (the pod's volumes
// hold a copy of up to 2 GiB, 2147483648 bytes), the largest deadline and
// silence the settings accept beside the issue's and the defaults, ten
// attempts, and each earlier problem the cases above pin, the longest error
// code included. It stays within the 240 characters a failure keeps, so the
// status and the heartbeat carry it whole. With a database name of the
// longest kind, 63 characters, the cut drops the message's end, and the
// earlier problem is still whole in what is kept.
test('an upload cut after an earlier failure is reported within the 240 characters kept, at production lengths', () => {
  assert.equal(MAX_FAILURE_LENGTH, 240);
  assert.equal(NEW.length, 34);
  assert.equal(errorCode(errorXml(LONGEST_CODE)), LONGEST_CODE);
  assert.equal(errorCode(errorXml(`${LONGEST_CODE}s`)), '');
  // Ten digits each, the bytes sent short of the size, as for an upload under way.
  const bytes = 9_999_999_999;
  const sent = bytes - 1;
  const problems = (silence) => [
    `stalled: no byte moved for ${silence} s after ${sent} of ${bytes} bytes`,
    `failed: no answer within ${silence} s`,
    `answered 503 ${LONGEST_CODE}`,
    'answered 429 TooManyRequests',
    'failed: ECONNREFUSED',
    'failed: ECONNRESET',
  ];
  const longestName = `${'d'.repeat(63)}-20261002T000000Z.dump.gpg`;
  let longest = 0;
  for (const name of [NEW, longestName]) {
    const what = `uploading ${name}`;
    for (const deadline of [12, 240, 1500]) {
      const ranOut = `the run's ${deadline} s`;
      for (const silence of [0.5, 2, 60, 600]) {
        for (const attempt of [2, 3, 10]) {
          for (const earlier of problems(silence)) {
            const message = cutOffMessage({
              what,
              earlier,
              ranOut,
              attempt,
              sent,
              size: bytes,
            });
            const kept = message.slice(0, MAX_FAILURE_LENGTH);
            assert.ok(kept.startsWith(`${what} ${earlier}, and `), message);
            if (name === NEW) {
              assert.equal(kept, message, `${message.length} characters: ${message}`);
              longest = Math.max(longest, message.length);
            }
          }
        }
      }
      const alone = cutOffMessage({
        what,
        earlier: null,
        ranOut,
        attempt: 1,
        sent,
        size: bytes,
      });
      assert.match(alone, /: the copy is too large for the time allowed at this speed$/);
      if (name === NEW) assert.ok(alone.length <= MAX_FAILURE_LENGTH, alone);
    }
  }
  // `uploading <34> answered 503 <64>, and the run's 1500 s ran out during
  // attempt 10 after <10 digits> of <10 digits> bytes`.
  assert.equal(longest, 207);
});

// The two limits and db-backup.sh's wait, as the defaults set them. A storage
// that never answers is given up on, after every attempt, before the run's
// limit, so its message is `no answer`; the uploader's answer comes before the
// script stops waiting; and what the run's limit allows a copy is its time
// times the uplink.
test('the defaults keep the three time limits in their order', () => {
  const wait = Number(
    /^offsite_wait=\$\{BACKUP_OFFSITE_WAIT_SECONDS:-(\d+)\}$/m.exec(BACKUP_SCRIPT)?.[1],
  );
  assert.equal(wait, 300);
  const { timeoutSeconds, attempts, retrySeconds, deadlineSeconds } = DEFAULTS;
  const silent = attempts * timeoutSeconds + (attempts - 1) * retrySeconds;
  assert.equal(silent, 190);
  assert.ok(silent < deadlineSeconds, 'a silent storage would be reported as a copy too large');
  assert.ok(
    wait >= deadlineSeconds + 30,
    'the script would stop waiting before the uploader answers',
  );
  // 240 s at 1 Mbit/s is 30 MB; the runbook's "about 29 MB for each Mbit/s"
  // leaves the versioning read, the listing and the pruning their seconds.
  assert.equal((deadlineSeconds * 1_000_000) / 8, 30_000_000);
});

// --- What is read of a listing is bounded to what the memory holds --------------

// The largest listing the bounds let through: every page just under its 2 MiB
// with its 1,000 entries, as many pages as are read. Twenty pages of 4 MiB,
// the first bounds, filled the chart's 128Mi with pages not yet collected.
test('a listing at its bounds is read whole within the uploader’s memory limit, and one byte or one page more is refused', async (t) => {
  assert.ok(
    MAX_PAGES * MAX_LIST_PAGE_BYTES <= 16 * MIB,
    'more listing may be read for one copy than was measured under the memory limit',
  );
  assert.deepEqual([MAX_PAGES, MAX_LIST_PAGE_BYTES, MAX_PAGE_ENTRIES], [5, 2 * MIB, 1000]);

  const SIZE = 1 * MIB;
  // 1,000 entries: the new copy and 999 objects that are no copies, their
  // keys padded so that the page comes to `bytes`.
  const page = (number, last, bytes) => {
    const head = `<ListBucketResult><IsTruncated>${!last}</IsTruncated>${last ? '' : `<NextContinuationToken>${number + 1}</NextContinuationToken>`}<Contents><Key>${NEW}</Key><Size>${SIZE}</Size></Contents>`;
    const tail = '</ListBucketResult>';
    const frame = (index, pad) =>
      `<Contents><Key>qa_tools-padding-${number}-${index}-${'k'.repeat(pad)}</Key><Size>1</Size></Contents>`;
    const each = Math.floor((bytes - head.length - tail.length) / (MAX_PAGE_ENTRIES - 1));
    const pad = each - frame(999, 0).length;
    let body = head;
    for (let index = 0; index < MAX_PAGE_ENTRIES - 1; index += 1) body += frame(index, pad);
    return body + tail;
  };

  await t.test('at the bounds', async (st) => {
    const pages = Array.from({ length: MAX_PAGES }, (_, index) =>
      page(index + 1, index + 1 === MAX_PAGES, MAX_LIST_PAGE_BYTES - 1),
    );
    for (const text of pages) {
      assert.ok(text.length <= MAX_LIST_PAGE_BYTES && text.length > MAX_LIST_PAGE_BYTES - 4096);
    }
    const store = await intake(st, { pages });
    const { answer, output, peakKib } = await uploadInOwnProcess(st, store.url, { size: SIZE });
    assert.deepEqual(
      [answer.outcome, answer.message],
      ['ok', `uploaded ${NEW}, ${SIZE} bytes; deleted nothing; kept ${NEW}`],
      output,
    );
    assert.equal(store.stats.lists, MAX_PAGES);
    assert.ok(store.stats.listBytes > MAX_PAGES * (MAX_LIST_PAGE_BYTES - 4096));
    assert.ok(
      peakKib < LIMIT_KIB,
      `the uploader peaked at ${Math.round(peakKib / 1024)} MiB for ${Math.round(store.stats.listBytes / MIB)} MiB of listing`,
    );
  });

  await t.test(
    'a page of the first bounds, just under 4 MiB, is refused and no other is asked for',
    async (st) => {
      const pages = Array.from({ length: 20 }, (_, index) =>
        page(index + 1, index === 19, 4 * MIB - 1),
      );
      const store = await intake(st, { pages });
      const { answer, peakKib } = await uploadInOwnProcess(st, store.url, { size: SIZE });
      assert.deepEqual(
        [answer.outcome, answer.message],
        [
          'fail',
          `listing the bucket answered with more than ${MAX_LIST_PAGE_BYTES} bytes; ${NEW} was uploaded and nothing was deleted`,
        ],
      );
      assert.equal(store.stats.lists, 1);
      assert.ok(peakKib < LIMIT_KIB);
    },
  );

  await t.test('one page more than the bounds', async (st) => {
    const pages = Array.from({ length: MAX_PAGES + 1 }, (_, index) =>
      page(index + 1, false, 256 * 1024),
    );
    const store = await intake(st, { pages });
    const { answer } = await uploadInOwnProcess(st, store.url, { size: SIZE });
    assert.deepEqual(
      [answer.outcome, answer.message],
      ['fail', `the bucket's listing did not end within ${MAX_PAGES} pages. Nothing was deleted.`],
    );
    assert.equal(store.stats.lists, MAX_PAGES);
  });
});

// Of a page only the names of copies are kept, and a name is kept as a string
// of its own: as parsed it is a slice of the page, and a slice keeps the text
// it was cut from alive. Here every page holds one copy's name, and what the
// heap holds is measured after a collection each time a page is asked for.
// Held pages show as about 2 MiB more each time; a page let go shows nothing.
test('a page of the listing is let go before the next is read, whatever names are kept from it', async (t) => {
  const dir = handOverDir(t);
  handOver(dir, NEW, 'ciphertext');
  const script = `
    import { main, MAX_PAGES, MAX_LIST_PAGE_BYTES } from ${JSON.stringify(new URL('../deploy/helm/qa-tools/files/db-backup-offsite.mjs', import.meta.url).href)};
    import { EventEmitter } from 'node:events';
    import { existsSync } from 'node:fs';
    const NEW = ${JSON.stringify(NEW)};
    const heap = [];
    let page = 0;
    const transport = async (options) => {
      const url = new URL(options.url);
      if (options.method === 'PUT') return { status: 200, text: '', over: false };
      if (url.searchParams.has('versioning')) return { status: 200, text: '<VersioningConfiguration/>', over: false };
      page += 1;
      globalThis.gc();
      heap.push(process.memoryUsage().heapUsed);
      const last = page === MAX_PAGES;
      // One copy's name, the newest on the last page, and padding to the page's limit.
      const name = last ? NEW : 'qa_tools-2026090' + page + 'T000000Z.dump.gpg';
      const head = '<ListBucketResult><IsTruncated>' + !last + '</IsTruncated>' + (last ? '' : '<NextContinuationToken>' + (page + 1) + '</NextContinuationToken>') + '<Contents><Key>' + name + '</Key><Size>10</Size></Contents><Contents><Key>qa_tools-padding-';
      const tail = '</Key><Size>1</Size></Contents></ListBucketResult>';
      return { status: 200, text: head + 'k'.repeat(MAX_LIST_PAGE_BYTES - head.length - tail.length - 1) + tail, over: false };
    };
    const signals = new EventEmitter();
    const done = main({ env: process.env, transport, signals, out: { write() {} } });
    while (!existsSync(process.env.OFFSITE_DIR + '/' + NEW + '.result')) await new Promise((resolve) => setTimeout(resolve, 20));
    signals.emit('SIGTERM');
    await done;
    process.stdout.write(JSON.stringify({ heap, pages: page, pageBytes: MAX_LIST_PAGE_BYTES }) + '\\n');
  `;
  const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
    env: {
      PATH: process.env.PATH,
      OFFSITE_DIR: dir,
      OFFSITE_ENDPOINT: 'https://storage.yandexcloud.net',
      OFFSITE_REGION: REGION,
      OFFSITE_BUCKET: BUCKET,
      OFFSITE_DATABASE: 'qa_tools',
      OFFSITE_KEEP: '100',
      OFFSITE_ACCESS_KEY_ID: KEY_ID,
      OFFSITE_SECRET_ACCESS_KEY: SECRET,
      OFFSITE_POLL_SECONDS: '0.02',
    },
    encoding: 'utf8',
    timeout: PATIENCE_MS,
  });
  assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
  const { heap, pages, pageBytes } = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(pages, MAX_PAGES);
  assert.equal(pageBytes, MAX_LIST_PAGE_BYTES);
  const [, answerLine] = readFileSync(join(dir, `${NEW}.result`), 'utf8').split('\n');
  assert.match(
    answerLine,
    new RegExp(
      `^uploaded .* kept qa_tools-20260901T000000Z\\.dump\\.gpg .* ${NEW.replace(/\./g, '\\.')}$`,
    ),
  );
  // When a page is asked for, the page before it may still be on its way out
  // of the loop; none before that. So from the second request to the last the
  // heap must not grow: three more pages were read by then and a name kept
  // from each, about 6 MiB if they were held.
  assert.equal(heap.length, MAX_PAGES);
  const grown = heap.at(-1) - heap[1];
  assert.ok(
    grown < pageBytes / 2,
    `the heap grew by ${(grown / MIB).toFixed(1)} MiB over ${pages - 2} pages of ${pageBytes / MIB} MiB: the pages are held`,
  );
  assert.ok(heap[1] - heap[0] < 1.5 * pageBytes, 'more than the page just read is held');
});

test('one exchange pipes the file, stops reading an answer at its limit, and fails on one that ends early', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', (chunk) => (bytes += chunk.length));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        bytes,
        length: req.headers['content-length'],
        connection: req.headers.connection,
      });
      if (req.url === '/big') {
        res.writeHead(200);
        return res.end('x'.repeat(100_000));
      }
      if (req.url === '/cut') {
        res.writeHead(200, { 'content-length': '1000' });
        res.write('half');
        return setTimeout(() => res.destroy(), 50);
      }
      if (req.url === '/elsewhere') {
        res.writeHead(307, { location: '/big' });
        return res.end('<Error><Code>TemporaryRedirect</Code></Error>');
      }
      if (req.url === '/never') return undefined;
      res.writeHead(200);
      return res.end('fine');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const never = new globalThis.AbortController().signal;

  const dir = handOverDir(t);
  const path = join(dir, 'body');
  writeFileSync(path, 'b'.repeat(300_000));
  assert.deepEqual(
    await exchange({
      url: `${base}/put`,
      method: 'PUT',
      headers: { 'content-length': '300000' },
      file: { path },
      signal: never,
      maxBytes: 1000,
    }),
    { status: 200, text: 'fine', over: false },
  );
  assert.deepEqual(seen.at(-1), {
    method: 'PUT',
    url: '/put',
    bytes: 300_000,
    length: '300000',
    connection: 'close',
  });

  // Beyond the limit the answer is cut, said to be over, and read no further.
  const big = await exchange({
    url: `${base}/big`,
    method: 'GET',
    headers: {},
    signal: never,
    maxBytes: 1000,
  });
  assert.deepEqual([big.status, big.text.length, big.over], [200, 1000, true]);
  const exact = await exchange({
    url: `${base}/big`,
    method: 'GET',
    headers: {},
    signal: never,
    maxBytes: 100_000,
  });
  assert.deepEqual([exact.text.length, exact.over], [100_000, false]);

  // A redirect is an answer, not followed.
  const redirect = await exchange({
    url: `${base}/elsewhere`,
    method: 'GET',
    headers: {},
    signal: never,
    maxBytes: 1000,
  });
  assert.equal(redirect.status, 307);
  assert.equal(seen.at(-1).url, '/elsewhere');

  await assert.rejects(
    exchange({ url: `${base}/cut`, method: 'GET', headers: {}, signal: never, maxBytes: 1000 }),
    (error) =>
      /^(ECONNRESET|ERR_STREAM_PREMATURE_CLOSE)$/.test(error.code) || error.message === 'aborted',
  );
  await assert.rejects(
    exchange({
      url: `${base}/never`,
      method: 'GET',
      headers: {},
      signal: globalThis.AbortSignal.timeout(100),
      maxBytes: 1000,
    }),
    (error) => error.name === 'AbortError' || error.name === 'TimeoutError',
  );
  await assert.rejects(
    exchange({
      url: `${base}/put`,
      method: 'PUT',
      headers: { 'content-length': '5' },
      file: { path: join(dir, 'gone') },
      signal: never,
      maxBytes: 1000,
    }),
    (error) => error.code === 'ENOENT',
  );
});

// The silence limit within one process: the stand-in answers a quarter later
// than the silence allowed, by a timer of this process. Of two timers the one
// due first fires first, and the exchange's is set before the request leaves
// and due before the stand-in's, so a correct exchange gives up before the
// answer is even sent, however loaded the machine. One whose limit fired a
// quarter late or more would read the answer.
test('an exchange gives up on its silence before an answer that comes a quarter later', async (t) => {
  const IDLE_MS = 1000;
  const timers = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.writeHead(200);
        res.end('late');
      }, IDLE_MS * 1.25);
      timers.add(timer);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  });
  const progress = { sent: 0, received: 0 };
  await assert.rejects(
    exchange({
      url: `http://127.0.0.1:${server.address().port}/late`,
      method: 'GET',
      headers: {},
      signal: new globalThis.AbortController().signal,
      idleMs: IDLE_MS,
      maxBytes: 1000,
      progress,
    }),
    (error) => error.code === 'ESTALLED',
  );
  assert.equal(progress.received, 0, 'part of the answer was read');
});

// --- What the storage answers never carries a signature into an output ----------

test('a storage that answers with the request’s own signature as its error code does not get it repeated', async (t) => {
  const forms = {
    'as sent': (signature) => signature,
    'in capitals': (signature) => signature.toUpperCase(),
    'after a letter': (signature) => `E${signature.slice(0, 63)}`,
    'half of it': (signature) => `Sig${signature.slice(0, 32)}`,
  };
  const steps = {
    "reading the bucket's versioning": (request) => 'versioning' in request.params,
    [`uploading ${NEW}`]: (request) => request.method === 'PUT',
    'listing the bucket': (request) => request.params['list-type'] === '2',
    [`deleting ${copyName('20260928T000000Z')}`]: (request) => request.method === 'DELETE',
  };
  for (const [step, matches] of Object.entries(steps)) {
    for (const [form, make] of Object.entries(forms)) {
      await t.test(`${step}, ${form}`, async (st) => {
        const store = await storage(st, { objects: OLD });
        const echoed = [];
        store.intercept = (request) => {
          if (!matches(request)) return undefined;
          echoed.push(request.signature);
          return {
            status: 403,
            body: `<Error><Code>${make(request.signature)}</Code><Message>${request.signature}</Message></Error>`,
          };
        };
        const { answer, output } = await runOnce(st, store);
        assert.equal(echoed.length, 1);
        assert.equal(answer.outcome, 'fail');
        // The status alone: what stood where the code belongs is no code.
        assert.ok(answer.message.startsWith(`${step} answered 403`), answer.message);
        assert.doesNotMatch(answer.message, /answered 403 \S/);
        for (const text of [output, answer.message]) {
          assert.doesNotMatch(text, /[0-9a-fA-F]{16}/, 'part of a signature reached an output');
          assert.ok(
            !text.toLowerCase().includes(echoed[0].slice(0, 12)),
            'a signature reached an output',
          );
        }
      });
    }
  }
});

test('every line and the answer are scrubbed of the latest request’s signature, as of the credential', async (t) => {
  // Nothing the storage answers reaches an output as text, so the scrub is
  // shown on a failure made to carry what the request was signed with.
  let signature;
  const { answer, output } = await inProcess(t, {
    transport: async (options) => {
      signature = /Signature=([0-9a-f]{64})$/.exec(options.headers.authorization)[1];
      throw new Failure(`was refused: ${signature} ${signature.toUpperCase()} by ${KEY_ID}`);
    },
  });
  assert.deepEqual(
    [answer.outcome, answer.message],
    [
      'fail',
      "reading the bucket's versioning was refused: <signature> <signature> by <access key id>",
    ],
  );
  assert.match(output, /was refused: <signature> <signature> by <access key id>\n/);
  assert.ok(!output.toLowerCase().includes(signature), 'the signature reached the log');
});

test('an error code is taken only when it is shaped like one', () => {
  const xml = (code) =>
    `<?xml version="1.0"?><Error><Code>${code}</Code><Message>m</Message></Error>`;
  for (const code of [
    'AccessDenied',
    'NoSuchBucket',
    'SignatureDoesNotMatch',
    'XAmzContentSHA256Mismatch',
    'InvalidAccessKeyId',
    'SlowDown',
    'TooManyRequests',
    'Ab',
  ]) {
    assert.equal(errorCode(xml(code)), code);
  }
  const signature = sha256('a signature');
  for (const code of [
    signature,
    signature.toUpperCase(),
    `E${signature}`,
    `Code${signature.slice(0, 16)}`,
    `Code${signature.slice(0, 16).toUpperCase()}Tail`,
    'DeadBeefDeadBeef',
    'accessDenied',
    'A',
    '9Lives',
    'Access Denied',
    'Access-Denied',
    'Access.Denied',
    'Accès',
    'AccessDenied\n',
    ' AccessDenied',
    '',
    `A${'b'.repeat(64)}`,
    SECRET,
    `AWS4-HMAC-SHA256 Credential=${KEY_ID}`,
    '<Code>AccessDenied</Code>',
    '&#65;ccessDenied',
  ]) {
    assert.equal(errorCode(xml(code)), '', JSON.stringify(code));
  }
  assert.equal(errorCode(''), '');
  assert.equal(errorCode('<Error><Code>AccessDenied'), '', 'a code that is not closed');
  assert.equal(errorCode('<html>proxy</html>'), '');
  // Only the start of an answer is looked at, and at any size it takes no time.
  assert.equal(errorCode(`${' '.repeat(70_000)}${xml('AccessDenied')}`), '');
  for (const size of SIZES) {
    for (const piece of ['<Code>', '</Code>', '<Code>A', 'A', 'af09', '<']) {
      const text = piece.repeat(Math.ceil(size / piece.length));
      const { result } = timed(`${JSON.stringify(piece)} at ${size}`, () => errorCode(text));
      assert.ok(result === '' || /^[A-Z][A-Za-z0-9]{1,63}$/.test(result), result.slice(0, 80));
      const wrapped = timed(`a code of ${JSON.stringify(piece)} at ${size}`, () =>
        errorCode(xml(text)),
      );
      assert.ok(wrapped.result === '' || wrapped.result.length <= 64);
    }
  }
});

// --- A listing that lies about its size ----------------------------------------

test('a listing beyond what a storage may answer is refused before it costs memory, and nothing is deleted', async (t) => {
  const entry = (key, size = 10) => `<Contents><Key>${key}</Key><Size>${size}</Size></Contents>`;
  const made = (index) =>
    copyName(`2025${String(1000 + (index % 9000))}T${String(index % 1_000_000).padStart(6, '0')}Z`);

  await t.test(`${MAX_PAGE_ENTRIES + 1} entries on one page`, async (st) => {
    const store = await storage(st, { objects: OLD });
    store.intercept = (request) =>
      request.params['list-type'] === '2'
        ? {
            status: 200,
            body: `<ListBucketResult><IsTruncated>false</IsTruncated>${entry(NEW)}${Array.from({ length: MAX_PAGE_ENTRIES }, (_, index) => entry(made(index))).join('')}</ListBucketResult>`,
          }
        : undefined;
    const { answer } = await runOnce(st, store);
    assert.deepEqual(
      [answer.outcome, answer.message],
      [
        'fail',
        `the listing holds more than 1000 entries on one page; ${NEW} was uploaded and nothing was deleted`,
      ],
    );
    assert.ok(store.requests.every((request) => request.method !== 'DELETE'));
    assert.deepEqual(store.keys(), [...Object.keys(OLD), NEW].sort());
  });

  await t.test(`more than ${MAX_COPIES} copies over several honest pages`, async (st) => {
    const objects = {};
    for (let index = 0; index < MAX_COPIES; index += 1) objects[made(index)] = 'x';
    const store = await storage(st, { objects });
    assert.equal(store.keys().length, MAX_COPIES);
    const { answer } = await runOnce(st, store);
    assert.deepEqual(
      [answer.outcome, answer.message],
      [
        'fail',
        `the bucket lists more than 1000 copies of qa_tools, far more than this job leaves. ${NEW} was uploaded and nothing was deleted.`,
      ],
    );
    assert.ok(store.requests.every((request) => request.method !== 'DELETE'));
    assert.equal(store.keys().length, MAX_COPIES + 1);
  });

  await t.test(`exactly ${MAX_COPIES} copies are pruned`, async (st) => {
    const objects = {};
    for (let index = 0; index < MAX_COPIES - 1; index += 1) objects[made(index)] = 'x';
    const store = await storage(st, { objects });
    const { answer, output } = await runOnce(st, store, {
      // 997 deletions, a connection each: seconds on a free machine. The
      // uploader's deadline of ten minutes keeps it from cutting them short;
      // this test's own TEST_LIMIT_MS, five minutes, is the bound that holds.
      env: { OFFSITE_DEADLINE_SECONDS: '600' },
    });
    assert.equal(answer.outcome, 'ok', answer.message);
    assert.equal(store.keys().length, 3);
    assert.ok(store.keys().includes(NEW));
    // The log names each deletion once, and the answer stays one short line.
    assert.equal(output.match(/ Deleted /g).length, MAX_COPIES - 3);
    assert.ok(answer.message.length <= 600);
  });

  // The tester's flood: twenty pages of 50,000 made-up copies each, a million
  // in all, about 4 MiB a page. The first page is refused; no other is asked for.
  await t.test('a million made-up copies in twenty pages', async (st) => {
    // Page n holds 50,000 names no other page has, and is made when asked for.
    const page = (number) =>
      `<ListBucketResult><IsTruncated>${number < 20}</IsTruncated><NextContinuationToken>page-${number + 1}</NextContinuationToken>${entry(NEW)}${Array.from({ length: 50_000 }, (_, index) => entry(made((number - 1) * 50_000 + index))).join('')}</ListBucketResult>`;
    const first = page(1);
    assert.ok(first.length > 3_000_000 && first.length < 4 * 1024 * 1024);
    const calls = [];
    const before = process.memoryUsage().rss;
    const { answer, output } = await inProcess(st, {
      transport: async (options) => {
        const url = new URL(options.url);
        calls.push(`${options.method} ${url.search}`);
        if (options.method === 'PUT') return { status: 200, text: '', over: false };
        if (url.searchParams.has('versioning')) {
          return { status: 200, text: '<VersioningConfiguration/>', over: false };
        }
        const token = url.searchParams.get('continuation-token');
        return {
          status: 200,
          text: token === null ? first : page(Number(token.slice('page-'.length))),
          over: false,
        };
      },
    });
    assert.deepEqual(
      [answer.outcome, answer.message],
      [
        'fail',
        `the listing holds more than 1000 entries on one page; ${NEW} was uploaded and nothing was deleted`,
      ],
    );
    assert.deepEqual(calls, ['GET ?versioning', 'PUT ', 'GET ?list-type=2&prefix=qa_tools-']);
    assert.ok(output.length < 2000, `the log holds ${output.length} characters`);
    const grown = process.memoryUsage().rss - before;
    assert.ok(grown < 64 * 1024 * 1024, `the process grew by ${Math.round(grown / 1048576)} MiB`);
  });
});

// --- The versioning guard reads `off` only from a whole answer ------------------

test('a versioning answer that is not exactly one whole document, or says its status twice, is never read as off', async (t) => {
  const ns = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"';
  const open = `<?xml version="1.0" encoding="UTF-8"?>\n<VersioningConfiguration ${ns}>`;
  const enabled = `${open}<Status>Enabled</Status></VersioningConfiguration>`;
  const refused = {
    'a status that is not closed': `${open}<Status>Enabled`,
    'a status that is not closed, the document closed': `${open}<Status>Enabled</VersioningConfiguration>`,
    'a document that is not closed': `${open}<Status>Enabled</Status>`,
    'no status and no end': open,
    'the root tag itself cut off': '<VersioningConfiguration xmlns="http://s3.amazonaws.com',
    'an empty status before a real one': `${open}<Status></Status><Status>Enabled</Status></VersioningConfiguration>`,
    'two statuses': `${open}<Status>Suspended</Status><Status>Enabled</Status></VersioningConfiguration>`,
    'an empty status': `${open}<Status></Status></VersioningConfiguration>`,
    'a self-closed status': `${open}<Status/></VersioningConfiguration>`,
    'a status in another case': `${open}<status>Enabled</status></VersioningConfiguration>`,
    'a status with an attribute': `${open}<Status xml:space="preserve">Enabled</Status></VersioningConfiguration>`,
    'a status with space in it': `${open}<Status> Enabled </Status></VersioningConfiguration>`,
    'a status inside a comment': `${open}<!-- <Status>Enabled</Status> --></VersioningConfiguration>`,
    'a status inside another element': `${open}<Wrap><Status>Enabled</Status></Wrap></VersioningConfiguration>`,
    'a longer root name': '<VersioningConfigurationResult></VersioningConfigurationResult>',
    'an unknown status': `${open}<Status>Paused</Status></VersioningConfiguration>`,
    // The tester's two: an attribute whose quote is never closed, which made
    // the root tag end at the `/>` inside its value; and a second document
    // after a first that says nothing.
    'an attribute whose quote is not closed': `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/><Status>Enabled</Status></VersioningConfiguration>`,
    'an attribute whose quote is not closed, no status': `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/>`,
    'two documents, the second enabled': `<VersioningConfiguration/>${enabled}`,
    'two documents, the first whole and empty': `${open}</VersioningConfiguration>\n${enabled}`,
    'text after the document': `${open}</VersioningConfiguration>Enabled`,
    'a status after the document': `<VersioningConfiguration/><Status>Enabled</Status>`,
    'text before the document': `Enabled ${open}</VersioningConfiguration>`,
    'another root around it': `<Answer>${enabled}</Answer>`,
    'an attribute without a value': '<VersioningConfiguration xmlns/>',
    'an attribute without quotes': '<VersioningConfiguration xmlns=x/>',
    'text among the children': `${open}Enabled</VersioningConfiguration>`,
    'an error answer': '<Error><Code>AccessDenied</Code></Error>',
    'nothing at all': '',
  };
  for (const [name, xml] of Object.entries(refused)) {
    assert.throws(() => parseVersioning(xml), Failure, name);
  }
  const read = {
    Off: [
      '<VersioningConfiguration/>',
      '<VersioningConfiguration />',
      `<VersioningConfiguration ${ns}/>`,
      `<VersioningConfiguration ${ns} />\n`,
      `<VersioningConfiguration xmlns='single' other:attr="x y"></VersioningConfiguration>`,
      `${open}</VersioningConfiguration>`,
      `${open}\n  \n</VersioningConfiguration>\n`,
      `\uFEFF${open}</VersioningConfiguration >`,
      `${open}<MfaDelete>Disabled</MfaDelete></VersioningConfiguration>`,
      `${open}<MfaDelete/></VersioningConfiguration>`,
    ],
    Enabled: [
      enabled,
      `${enabled}\n`,
      `${open}\n  <Status>Enabled</Status>\n  <MfaDelete>Disabled</MfaDelete>\n</VersioningConfiguration>`,
      `${open}<MfaDelete>Disabled</MfaDelete><Status>Enabled</Status></VersioningConfiguration>`,
    ],
    Suspended: [`${open}<Status>Suspended</Status></VersioningConfiguration>`],
  };
  for (const [status, answers] of Object.entries(read)) {
    for (const xml of answers) assert.equal(parseVersioning(xml), status, xml);
  }
  for (const size of SIZES) {
    for (const piece of [
      '<Status>',
      '</Status>',
      '<Status>Enabled',
      '<VersioningConfiguration',
      '<VersioningConfiguration/>',
      '<MfaDelete>Disabled</MfaDelete>',
      ' ',
      ' a="b"',
      ' a=',
      '<',
    ]) {
      const repeated = piece.repeat(Math.ceil(size / piece.length));
      for (const text of [
        repeated,
        `${open}${repeated}`,
        `<VersioningConfiguration${repeated}`,
        `<VersioningConfiguration/>${repeated}x`,
      ]) {
        const { result, error } = timed(`${JSON.stringify(piece)} at ${size}`, () =>
          parseVersioning(text),
        );
        assert.ok(
          error instanceof Failure,
          `${JSON.stringify(piece)} at ${size} was read as ${result}`,
        );
      }
    }
    // A whole document of that size is read, in the same time.
    const padded = `${open}${'<MfaDelete>Disabled</MfaDelete>'.repeat(Math.ceil(size / 31))}<Status>Enabled</Status></VersioningConfiguration>${' '.repeat(size)}`;
    assert.equal(
      timed(`a whole document at ${size}`, () => parseVersioning(padded)).result,
      'Enabled',
    );
  }

  // Through the uploader: the tester's two answers, each a whole HTTP body.
  for (const body of [
    refused['a status that is not closed'],
    refused['an empty status before a real one'],
    refused['an attribute whose quote is not closed'],
    refused['two documents, the second enabled'],
  ]) {
    await t.test(JSON.stringify(body.slice(-45)), async (st) => {
      const store = await storage(st, { objects: OLD });
      store.intercept = (request) =>
        'versioning' in request.params ? { status: 200, body } : undefined;
      const { answer } = await runOnce(st, store);
      assert.deepEqual(
        [answer.outcome, answer.message],
        ['fail', "the bucket's versioning answer was not understood"],
      );
      assert.equal(store.requests.length, 1, 'something was asked after the guard');
      assert.deepEqual(store.keys(), Object.keys(OLD));
    });
  }
});

test('a listing made up to break the parser is refused or read, in bounded time, at every size', () => {
  const entry = (key, size = 1) => `<Contents><Key>${key}</Key><Size>${size}</Size></Contents>`;
  const wrap = (inner) =>
    `<ListBucketResult>${inner}<IsTruncated>false</IsTruncated></ListBucketResult>`;
  for (const size of SIZES) {
    const cases = {
      // Shapes that are a listing: read whole. A page holds at most 1,000
      // entries, as the API returns; more is a storage that lies.
      'many entries': [
        wrap(entry(NEW).repeat(Math.ceil(size / 80))),
        Math.ceil(size / 80) <= MAX_PAGE_ENTRIES ? 'read' : 'refused',
      ],
      'one enormous key': [wrap(entry('k'.repeat(size))), 'read'],
      'a key of character references': [wrap(entry('&#x41;'.repeat(Math.ceil(size / 6)))), 'read'],
      'a key of ampersands': [wrap(entry('&'.repeat(size))), 'read'],
      'a key of unfinished references': [wrap(entry('&#x'.repeat(Math.ceil(size / 3)))), 'read'],
      'a key that looks like markup': [
        wrap(entry('&lt;/Key&gt;&lt;/Contents&gt;'.repeat(Math.ceil(size / 30)))),
        'read',
      ],
      'garbage between the entries': [
        wrap(`${'<'.repeat(size)}${entry(NEW)}${'>'.repeat(size)}`),
        'read',
      ],
      'an enormous size': [wrap(entry(NEW, '9'.repeat(size))), 'read'],
      // Shapes that are not: refused, never half used.
      'entries never closed': [
        '<ListBucketResult>' + '<Contents>'.repeat(Math.ceil(size / 10)),
        'refused',
      ],
      'keys never closed': [
        wrap(`<Contents>${'<Key>'.repeat(Math.ceil(size / 5))}</Contents>`),
        'refused',
      ],
      'entries without keys': [
        wrap('<Contents></Contents>'.repeat(Math.ceil(size / 21))),
        'refused',
      ],
      'cut off before the end': [
        `<ListBucketResult>${entry(NEW).repeat(Math.ceil(size / 80))}`,
        'refused',
      ],
      'not a listing': ['<'.repeat(size), 'refused'],
      'only closing tags': ['</Contents>'.repeat(Math.ceil(size / 11)), 'refused'],
      'truncated without a token': [
        `<ListBucketResult>${entry(NEW)}<IsTruncated>true</IsTruncated></ListBucketResult>`,
        'refused',
      ],
      'a token too long to send': [
        `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>${'t'.repeat(size + 4097)}</NextContinuationToken></ListBucketResult>`,
        'refused',
      ],
    };
    for (const [name, [xml, outcome]] of Object.entries(cases)) {
      const { result, error } = timed(`${name} at ${size}`, () => parseListing(xml));
      if (outcome === 'read') {
        assert.equal(error, undefined, `${name} at ${size}: ${error?.message}`);
        assert.ok(result.objects.length >= 1, `${name} at ${size}`);
        assert.equal(result.next, null);
      } else {
        assert.ok(error instanceof Failure, `${name} at ${size} was not refused as a Failure`);
        assert.ok(error.message.length < 100, 'the refusal quotes the answer');
      }
    }
  }

  // A size that is not a whole number of at most fifteen digits is unknown,
  // never a wrong number.
  assert.deepEqual(parseListing(wrap(entry(NEW, '10'))).objects, [{ key: NEW, size: 10 }]);
  for (const size of ['', '-1', '1e3', '0x10', ' 10', '9'.repeat(16)]) {
    assert.equal(parseListing(wrap(entry(NEW, size))).objects[0].size, null, size);
  }
  // The page's own elements are read outside the entries: a key cannot end a
  // listing early or name the next page.
  const sly = parseListing(
    `<ListBucketResult>${entry('<IsTruncated>true</IsTruncated><NextContinuationToken>x</NextContinuationToken>')}<IsTruncated>false</IsTruncated></ListBucketResult>`,
  );
  assert.equal(sly.next, null);
  assert.equal(
    parseListing(
      `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken></ListBucketResult>`,
    ).next,
    'a&b',
  );
});

test('a key is matched by its exact name after its character references are resolved', () => {
  assert.equal(xmlText('qa&#95;tools-&#x32;0261002T000000Z.dump.gpg'), NEW);
  assert.equal(xmlText('&amp;&lt;&gt;&quot;&apos;'), '&<>"\'');
  assert.equal(xmlText('&amp;lt;'), '&lt;', 'resolved once, not twice');
  // What is no reference stays as written: a surrogate, zero, beyond Unicode,
  // an unknown name.
  for (const raw of [
    '&#xD800;',
    '&#0;',
    '&#x110000;',
    '&#9999999;',
    '&nbsp;',
    '&#;',
    '&#x;',
    '&',
  ]) {
    assert.equal(xmlText(raw), raw);
  }
  for (const size of SIZES) {
    for (const piece of ['&', '&#', '&#x41;', '&amp;', '&#x', ';', '&a']) {
      const text = piece.repeat(Math.ceil(size / piece.length));
      const { result } = timed(`${JSON.stringify(piece)} at ${size}`, () => xmlText(text));
      assert.equal(typeof result, 'string');
    }
  }

  assert.equal(parseVersioning('<VersioningConfiguration/>'), 'Off');
  assert.equal(parseVersioning('<VersioningConfiguration></VersioningConfiguration>'), 'Off');
  assert.equal(
    parseVersioning('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'),
    'Enabled',
  );
  assert.equal(
    parseVersioning(
      '<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>',
    ),
    'Suspended',
  );
  for (const xml of [
    '',
    '<Error><Code>AccessDenied</Code></Error>',
    '<VersioningConfiguration><Status>enabled</Status></VersioningConfiguration>',
    '<VersioningConfiguration><Status> Enabled</Status></VersioningConfiguration>',
    `<VersioningConfiguration><Status>${'E'.repeat(1_000_000)}</Status></VersioningConfiguration>`,
    '<Status>Enabled</Status>'.repeat(100_000),
  ]) {
    assert.throws(() => parseVersioning(xml), Failure);
  }
});

test('percent-encoding never throws and encodes everything but the unreserved characters', () => {
  assert.equal(uriEncode('AZaz09-._~'), 'AZaz09-._~');
  assert.equal(
    uriEncode(' !"#$%&\'()*+,/:;<=>?@[\\]^`{|}'),
    '%20%21%22%23%24%25%26%27%28%29%2A%2B%2C%2F%3A%3B%3C%3D%3E%3F%40%5B%5C%5D%5E%60%7B%7C%7D',
  );
  assert.equal(uriEncode('é€😀'), '%C3%A9%E2%82%AC%F0%9F%98%80');
  assert.equal(uriEncode('\u0000\n'), '%00%0A');
  // A lone surrogate, which `encodeURIComponent` refuses, becomes U+FFFD.
  assert.throws(() => encodeURIComponent('\ud800'), URIError);
  assert.equal(uriEncode('\ud800'), '%EF%BF%BD');
  assert.equal(uriEncode(''), '');
  assert.equal(uriEncode(undefined), 'undefined');
  for (const size of SIZES) {
    for (const piece of ['a', '%', '/', 'é', '😀', '\ud800', '..%2f', '\n']) {
      const text = piece.repeat(Math.ceil(size / piece.length));
      const { result } = timed(`${JSON.stringify(piece)} at ${size}`, () => uriEncode(text));
      assert.ok(/^(?:[A-Za-z0-9\-._~]|%[0-9A-F]{2})*$/.test(result), JSON.stringify(piece));
    }
  }
  // A continuation token of any shape is signed as it is sent.
  const awkward = 'page 2+/=&é\ud800\n?#';
  const signed = signRequest({
    method: 'GET',
    host: 'storage.yandexcloud.net',
    path: `/${BUCKET}`,
    query: { 'list-type': '2', 'continuation-token': awkward, prefix: 'qa_tools-' },
    payloadHash: sha256(''),
    accessKeyId: KEY_ID,
    secretAccessKey: SECRET,
    region: REGION,
  });
  assert.equal(
    signed.canonicalQuery,
    'continuation-token=page%202%2B%2F%3D%26%C3%A9%EF%BF%BD%0A%3F%23&list-type=2&prefix=qa_tools-',
  );
  assert.equal(
    new URL(`https://h/${BUCKET}?${signed.canonicalQuery}`).search,
    `?${signed.canonicalQuery}`,
  );
});

test('pruning keeps the newest by name, never deletes the new copy, and holds at any size', () => {
  const names = Object.keys(OLD);
  assert.deepEqual(planPruning({ names: [...names, NEW], uploaded: NEW, keep: 3 }), {
    remove: names.slice(0, 2),
    kept: [...names.slice(2), NEW],
  });
  // Whatever order the listing came in, and whether or not it lists the new
  // copy, or lists a name twice.
  assert.deepEqual(
    planPruning({ names: [...names].reverse().concat(names), uploaded: NEW, keep: 3 }),
    { remove: names.slice(0, 2), kept: [...names.slice(2), NEW] },
  );
  assert.deepEqual(planPruning({ names: [], uploaded: NEW, keep: 3 }), { remove: [], kept: [NEW] });
  assert.deepEqual(planPruning({ names, uploaded: NEW, keep: 1 }), { remove: names, kept: [NEW] });
  assert.deepEqual(planPruning({ names, uploaded: NEW, keep: 5 }), {
    remove: [],
    kept: [...names, NEW],
  });
  assert.throws(
    () => planPruning({ names: [copyName('20261002T000001Z')], uploaded: NEW, keep: 3 }),
    Failure,
  );
  for (const size of [1_000, 10_000, 100_000]) {
    const many = Array.from({ length: size }, (_, index) =>
      copyName(`2025${String(index % 10000).padStart(4, '0')}T${String(index).padStart(6, '0')}Z`),
    );
    const { result } = timed(`${size} copies`, () =>
      planPruning({ names: many, uploaded: NEW, keep: 3 }),
    );
    assert.equal(result.kept.length, 3);
    assert.equal(result.kept.at(-1), NEW);
    assert.ok(!result.remove.includes(NEW));
    assert.equal(result.remove.length + 3, new Set(many).size + 1);
  }
});

test('the credential is scrubbed in any letter case and at any length', () => {
  const scrub = scrubber([
    [SECRET, '<secret access key>'],
    [KEY_ID, '<access key id>'],
  ]);
  assert.equal(
    scrub(`a ${SECRET} b ${SECRET.toUpperCase()} c ${KEY_ID.toLowerCase()} d`),
    'a <secret access key> b <secret access key> c <access key id> d',
  );
  assert.equal(scrubber([['', 'x']])('unchanged'), 'unchanged');
  for (const length of [32_768, 100_000, 1_000_000]) {
    const huge = 'Zq'.repeat(length / 2);
    const { result } = timed(`a secret of ${length}`, () =>
      scrubber([[huge, '<secret>']])(`a ${huge.toLowerCase()} b ${huge.toUpperCase()}`),
    );
    assert.equal(result, 'a <secret> b <secret>');
  }
});

test('a secret too long to be one is never printed or used, in the log or the answer', async (t) => {
  for (const length of [32_768, 100_000]) {
    await t.test(`${length} characters`, async (st) => {
      const store = await storage(st);
      const dir = handOverDir(st);
      const huge = 'Zq'.repeat(length / 2);
      const run = start({
        OFFSITE_DIR: dir,
        OFFSITE_ENDPOINT: store.url,
        OFFSITE_SECRET_ACCESS_KEY: huge,
      });
      st.after(() => run.child.kill('SIGKILL'));
      handOver(dir, NEW, 'ciphertext');
      const answer = await answerFor(dir, NEW, run);
      run.child.kill('SIGTERM');
      const result = await run.exited;
      assert.equal(result.code, 0);
      assert.deepEqual(
        [answer.outcome, answer.message],
        ['fail', 'OFFSITE_SECRET_ACCESS_KEY does not look like a secret key'],
      );
      assert.equal(store.requests.length, 0);
      for (const form of ['ZqZqZqZq', 'zqzqzqzq', 'ZQZQZQZQ']) {
        assert.ok(!result.output.includes(form), `the output holds ${form}`);
      }
    });
  }
});

test('the settings are read from the environment, and each problem is named', () => {
  const env = {
    OFFSITE_DIR: '/offsite',
    OFFSITE_ENDPOINT: 'https://storage.yandexcloud.net',
    OFFSITE_REGION: REGION,
    OFFSITE_BUCKET: BUCKET,
    OFFSITE_DATABASE: 'qa_tools',
    OFFSITE_ACCESS_KEY_ID: ` ${KEY_ID}\n`,
    OFFSITE_SECRET_ACCESS_KEY: `${SECRET}\n`,
  };
  const settings = readSettings(env);
  assert.deepEqual(settings.problems, []);
  assert.equal(settings.origin.origin, 'https://storage.yandexcloud.net');
  assert.equal(settings.accessKeyId, KEY_ID, 'surrounding space is not part of the key');
  assert.equal(settings.secretAccessKey, SECRET);
  assert.equal(settings.keep, 3);
  assert.equal(settings.checkVersioning, true);
  assert.deepEqual(
    [settings.pollMs, settings.timeoutMs, settings.attempts, settings.retryMs, settings.deadlineMs],
    [1000, 60_000, 3, 5000, 240_000],
  );
  assert.equal(readSettings({ ...env, OFFSITE_KEEP: '7' }).keep, 7);
  assert.equal(readSettings({ ...env, OFFSITE_CHECK_VERSIONING: 'false' }).checkVersioning, false);
  // A number that is not one, or out of range, falls back to its default.
  for (const value of ['', 'soon', '-1', '0', 'Infinity', '1e9']) {
    assert.equal(readSettings({ ...env, OFFSITE_TIMEOUT_SECONDS: value }).timeoutMs, 60_000, value);
  }
  assert.equal(
    readSettings({ ...env, OFFSITE_ENDPOINT: 'http://127.0.0.1:9000' }).problems.length,
    0,
  );
  for (const endpoint of [
    '',
    'storage.yandexcloud.net',
    'http://storage.yandexcloud.net',
    'https://storage.yandexcloud.net/bucket',
    'https://storage.yandexcloud.net/?x=1',
    'https://storage.yandexcloud.net/#x',
    'https://key:secret@storage.yandexcloud.net',
    'ftp://storage.yandexcloud.net',
    'http://127.0.0.1.example.com',
    'x'.repeat(1_000_000),
    `https://storage.yandexcloud.net/${'a/'.repeat(500_000)}`,
  ]) {
    assert.deepEqual(
      readSettings({ ...env, OFFSITE_ENDPOINT: endpoint }).problems,
      ['OFFSITE_ENDPOINT is not an https URL without a path'],
      endpoint.slice(0, 60),
    );
  }
  for (const bucket of [
    'A',
    'ab',
    'Bucket',
    'a_b',
    'a/b',
    'a..b',
    '-ab',
    'ab-',
    'a'.repeat(64),
    'a b',
    'a?b',
    'a%2fb',
  ]) {
    assert.deepEqual(
      readSettings({ ...env, OFFSITE_BUCKET: bucket }).problems,
      ['OFFSITE_BUCKET is not a bucket name'],
      bucket,
    );
  }
  for (const size of SIZES) {
    for (const piece of ['a', 'a.', '..', '/', 'a-']) {
      const value = piece.repeat(size);
      const { result } = timed(`a bucket of ${JSON.stringify(piece)} at ${size}`, () =>
        readSettings({
          ...env,
          OFFSITE_BUCKET: value,
          OFFSITE_REGION: value,
          OFFSITE_DATABASE: value,
        }),
      );
      assert.equal(result.problems.length, 3);
    }
  }
  // Every problem at once, the bucket's first: it is what the answer carries.
  assert.deepEqual(readSettings({}).problems, [
    'OFFSITE_BUCKET is not set',
    'OFFSITE_ENDPOINT is not an https URL without a path',
    'OFFSITE_REGION is not a region name',
    'OFFSITE_DATABASE is not a database name',
    'OFFSITE_ACCESS_KEY_ID is not set (Secret or key missing)',
    'OFFSITE_SECRET_ACCESS_KEY is not set (Secret or key missing)',
  ]);
});

// --- The recipient key and the chart ------------------------------------------

// The fingerprint of each version 4 key packet in an armored OpenPGP block
// (RFC 4880, 12.2): SHA-1 over 0x99, the body's length in two bytes, the body.
function fingerprints(armored) {
  const lines = armored.split('\n').map((line) => line.trim());
  const begin = lines.indexOf('-----BEGIN PGP PUBLIC KEY BLOCK-----');
  const end = lines.indexOf('-----END PGP PUBLIC KEY BLOCK-----');
  assert.ok(begin !== -1 && end > begin, 'not an armored public key block');
  const data = Buffer.from(
    lines
      .slice(begin + 1, end)
      .filter((line) => line !== '' && !line.startsWith('=') && !line.includes(':'))
      .join(''),
    'base64',
  );
  const found = [];
  for (let at = 0; at < data.length;) {
    const first = data[at];
    assert.ok(first & 0x80, 'not a packet');
    let tag;
    let length;
    let header;
    if (first & 0x40) {
      tag = first & 0x3f;
      const octet = data[at + 1];
      if (octet < 192) [length, header] = [octet, 2];
      else if (octet < 224) [length, header] = [((octet - 192) << 8) + data[at + 2] + 192, 3];
      else {
        assert.equal(octet, 255, 'a partial length is not expected in a key');
        [length, header] = [data.readUInt32BE(at + 2), 6];
      }
    } else {
      tag = (first >> 2) & 0x0f;
      const type = first & 0x03;
      assert.notEqual(type, 3, 'an indeterminate length is not expected in a key');
      header = 1 + (1 << type);
      length =
        type === 0
          ? data[at + 1]
          : type === 1
            ? data.readUInt16BE(at + 1)
            : data.readUInt32BE(at + 1);
    }
    const body = data.subarray(at + header, at + header + length);
    assert.equal(body.length, length, 'a packet is cut off');
    if (tag === 6 || tag === 14) {
      assert.equal(body[0], 4, 'a version 4 key');
      const prefix = Buffer.from([0x99, length >> 8, length & 0xff]);
      found.push({
        kind: tag === 6 ? 'primary' : 'subkey',
        fingerprint: createHash('sha1').update(prefix).update(body).digest('hex').toUpperCase(),
      });
    }
    // A secret key (5) or secret subkey (7) must never be in the chart.
    assert.ok(tag !== 5 && tag !== 7, 'the block holds a private key');
    at += header + length;
  }
  return found;
}

// The tests' recipient key: the owner's of 2026-10-01, from the comment on
// issue #89, a public key. Production's is its CI/CD variable since #367,
// not this file, and the chart holds none.
test('the tests’ recipient file is a public key, and holds no private key', () => {
  assert.deepEqual(fingerprints(RECIPIENT), [
    { kind: 'primary', fingerprint: '4C5BCE04B61A2DE37D4D567BD332EF5D79E659B1' },
    { kind: 'subkey', fingerprint: 'BD9E5C803178216D18745DF775374469D290765A' },
  ]);
  assert.doesNotMatch(RECIPIENT, /PRIVATE KEY/);
  assert.equal(RECIPIENT.match(/-----BEGIN PGP PUBLIC KEY BLOCK-----/g).length, 1);
});

test('the chart runs the uploader only with a bucket set, and holds no credential', () => {
  // Everything the off-server copy adds sits behind the bucket: with it empty
  // the pod has no uploader, no shared directory, and db-backup.sh is not told
  // to encrypt.
  const guarded = [
    ...TEMPLATE.matchAll(
      /\{\{- if \.Values\.backup\.offsite\.bucket \}\}\n([\s\S]*?)\{\{- end \}\}/g,
    ),
  ].map((match) => match[1]);
  assert.equal(guarded.length, 5);
  const unguarded = TEMPLATE.replace(
    /\{\{- if \.Values\.backup\.offsite\.bucket \}\}\n[\s\S]*?\{\{- end \}\}\n/g,
    '',
  )
    // The comments, and the initContainers key, which the notifier needs too.
    .replace(/\{\{- \/\*[\s\S]*?\*\/\}\}/, '')
    .replace(/^\s*#.*$/gm, '')
    .replace(
      /^ *\{\{- if or \.Values\.alerts\.heartbeatUrl \.Values\.backup\.offsite\.bucket \}\}\n/m,
      '',
    );
  assert.doesNotMatch(unguarded, /offsite|OFFSITE|recipient/i);

  const [config, sidecar, env, mount, volume] = guarded;
  // The ConfigMap holds the uploader and the key only with a bucket, the key
  // the one the installer gives, refused when there is none (#367).
  assert.match(
    config,
    /^ {2}db-backup-offsite\.mjs: \|-\n {4}\{\{- \.Files\.Get "files\/db-backup-offsite\.mjs" \| nindent 4 \}\}$/m,
  );
  assert.match(
    config,
    /^ {2}db-backup-recipient\.asc: \|-\n {4}\{\{- required "backup\.offsite\.recipientKey must be set when backup\.offsite\.bucket is[^"]*" \.Values\.backup\.offsite\.recipientKey \| nindent 4 \}\}$/m,
  );
  assert.match(sidecar, /^ {12}- name: db-backup-offsite$/m);
  assert.match(sidecar, /^ {14}restartPolicy: Always$/m);
  assert.match(
    sidecar,
    /image: \{\{ \.Values\.images\.registry \}\}\/\{\{ \.Values\.images\.backend \}\}:\{\{ include "qa-tools\.imageTag" \. \}\}/,
  );
  assert.match(sidecar, /command: \['node', '\/opt\/db-backup\/db-backup-offsite\.mjs'\]/);
  for (const [name, value] of [
    ['OFFSITE_DIR', '/offsite'],
    [
      'OFFSITE_ENDPOINT',
      '{{ required "backup.offsite.endpoint must be set when backup.offsite.bucket is: the storage\'s https:// endpoint" .Values.backup.offsite.endpoint | quote }}',
    ],
    [
      'OFFSITE_REGION',
      '{{ required "backup.offsite.region must be set when backup.offsite.bucket is: the storage\'s region" .Values.backup.offsite.region | quote }}',
    ],
    ['OFFSITE_BUCKET', '{{ .Values.backup.offsite.bucket | quote }}'],
    ['OFFSITE_DATABASE', '{{ .Values.postgres.database | quote }}'],
    ['OFFSITE_KEEP', '{{ .Values.backup.keep | quote }}'],
    ['OFFSITE_CHECK_VERSIONING', '{{ .Values.backup.offsite.checkVersioning | quote }}'],
  ]) {
    assert.ok(sidecar.includes(`- name: ${name}\n                  value: ${value}\n`), name);
  }
  // The credential comes from the Secret the chart names and never holds
  // (D087), optionally, so a missing Secret is a reported failure and not a
  // pod that cannot start.
  for (const [name, key] of [
    ['OFFSITE_ACCESS_KEY_ID', 'access-key-id'],
    ['OFFSITE_SECRET_ACCESS_KEY', 'secret-access-key'],
  ]) {
    assert.match(
      sidecar,
      new RegExp(
        `name: ${name}\\n\\s+valueFrom:\\n\\s+secretKeyRef:\\n\\s+name: \\{\\{ include "qa-tools\\.offsiteSecret" \\. \\}\\}\\n\\s+key: ${key}\\n\\s+optional: true`,
      ),
    );
  }
  assert.match(sidecar, /runAsUser: 1000\n\s+runAsGroup: 1000/);
  assert.match(sidecar, /readOnlyRootFilesystem: true/);
  assert.match(sidecar, /drop: \['ALL'\]/);
  // It sees the hand-over directory and the scripts; never the backup
  // directory, the scratch volume or the database's password.
  assert.deepEqual(
    [...sidecar.matchAll(/^ {16}- name: (\S+)\n {18}mountPath: (\S+)$/gm)].map((match) => [
      match[1],
      match[2],
    ]),
    [
      ['offsite', '/offsite'],
      ['script', '/opt/db-backup'],
    ],
  );
  assert.doesNotMatch(sidecar, /PGPASSWORD|postgres\.existingSecret|name: backup|name: scratch/);

  // The backup container is told where to hand the copy over and which key to
  // encrypt to, and is given no storage credential.
  assert.match(env, /name: BACKUP_OFFSITE_DIR\n\s+value: \/offsite\n/);
  assert.match(
    env,
    /name: BACKUP_OFFSITE_RECIPIENT_FILE\n\s+value: \/opt\/db-backup\/db-backup-recipient\.asc\n/,
  );
  assert.match(mount, /- name: offsite\n\s+mountPath: \/offsite\n/);
  assert.match(volume, /- name: offsite\n\s+emptyDir:\n/);
  const containers = /\n {10}containers:\n([\s\S]*?)\n {10}volumes:\n/.exec(TEMPLATE)?.[1] ?? '';
  assert.doesNotMatch(containers, /OFFSITE_ACCESS_KEY_ID|OFFSITE_SECRET_ACCESS_KEY|offsiteSecret/);
  // The notifier comes first, so the kubelet stops the uploader before it.
  const initContainers =
    /\n {10}initContainers:\n([\s\S]*?)\n {10}containers:\n/.exec(TEMPLATE)?.[1] ?? '';
  assert.deepEqual(
    [...initContainers.matchAll(/^ {12}- name: (\S+)$/gm)].map((match) => match[1]),
    ['db-backup-notify', 'db-backup-offsite'],
  );

  // The chart holds no key of its own.
  assert.doesNotMatch(TEMPLATE, /\.Files\.Get "files\/db-backup-recipient\.asc"/);

  // Off by default, naming no storage of anyone's (#367); production's are
  // its CI/CD variables.
  const offsite = /^ {2}offsite:\n((?: {4}.*\n)*)/m.exec(VALUES)?.[1] ?? '';
  assert.match(offsite, /^ {4}bucket: ''$/m);
  assert.match(offsite, /^ {4}endpoint: ''$/m);
  assert.match(offsite, /^ {4}region: ''$/m);
  assert.match(offsite, /^ {4}recipientKey: ''$/m);
  assert.match(offsite, /^ {4}existingSecret: ''$/m);
  assert.match(offsite, /^ {4}checkVersioning: true$/m);
  // Nothing that looks like a key in the chart's values.
  assert.doesNotMatch(VALUES, /access-key-id: \S|secret-access-key: \S|YCAJ|YC[A-Za-z0-9_-]{38}/);
});
