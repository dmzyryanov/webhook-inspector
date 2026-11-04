// The backup's notifier (deploy/helm/qa-tools/files/db-backup-notify.mjs,
// D181), run as the backup pod runs it — `node db-backup-notify.mjs`, its
// settings in the environment, stopped by a signal — against a status file in
// a temporary directory and a stand-in for Statuser's heartbeat endpoint on the
// loopback interface. What is pinned is issue #68's: `backup` for a success,
// `backup/fail` with the backup's own message for a failure or a stop, and
// `backup/fail` when the backup ended without a status; exit 0 whatever
// happens, a missing token or an unreachable Statuser included; and no token in
// any output. The status file as db-backup.sh writes it is pinned in
// scripts/db-backup.test.mjs, which also runs the two together.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { clearTimeout, setTimeout } from 'node:timers';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  NO_REPORT,
  heartbeatBody,
  main,
  parseStatus,
  scrubber,
} from '../deploy/helm/qa-tools/files/db-backup-notify.mjs';

const SCRIPT = fileURLToPath(
  new URL('../deploy/helm/qa-tools/files/db-backup-notify.mjs', import.meta.url),
);

// Stands in for the `backup` monitor's token; it must never be printed.
const TOKEN = '0d7e3b9a-2c4f-4a1e-b6d8-5f9c1e3a7b20';

// A stand-in for Statuser: records each heartbeat and answers `answer`'s way.
async function statuser(t, answer = (res) => (res.writeHead(204), res.end())) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        path: req.url.replace(`/${TOKEN}`, 'backup'),
        type: req.headers['content-type'],
        body,
      });
      answer(res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

// Starts the notifier. `exited` resolves with its exit code and output.
function start(env) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      PATH: process.env.PATH,
      NOTIFY_POLL_SECONDS: '0.05',
      NOTIFY_STOP_WAIT_SECONDS: '0.5',
      NOTIFY_TIMEOUT_SECONDS: '2',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const exited = new Promise((resolve) =>
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    }),
  );
  return { child, exited, output: () => output };
}

async function until(condition, what, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (condition()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

function statusDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-db-backup-notify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'db-backup.status') };
}

// As db-backup.sh writes it: a complete file renamed into place.
function writeStatus(file, content) {
  writeFileSync(`${file}.tmp`, content, { mode: 0o644 });
  renameSync(`${file}.tmp`, file);
}

function assertNoToken(result) {
  assert.ok(!result.output.includes(TOKEN), 'the token reached the output');
}

test('a success sends `backup`, then the notifier waits to be stopped and exits 0', async (t) => {
  const hb = await statuser(t);
  const { file } = statusDir(t);
  writeStatus(file, 'ok\n\n');
  const run = start({
    NOTIFY_STATUS_FILE: file,
    NOTIFY_HEARTBEAT_URL: hb.url,
    NOTIFY_TOKEN: TOKEN,
  });
  await until(() => hb.requests.length === 1, 'the heartbeat');
  assert.deepEqual(hb.requests, [
    { method: 'POST', path: 'backup', type: 'text/plain; charset=utf-8', body: 'backup succeeded' },
  ]);

  // A sidecar that exits while the backup container still runs is restarted,
  // so it stays until it is stopped.
  await sleep(300);
  assert.equal(run.child.exitCode, null, 'the notifier exited before it was stopped');
  run.child.kill('SIGTERM');
  const result = await run.exited;
  assert.equal(result.code, 0);
  assert.equal(hb.requests.length, 1, 'the heartbeat was sent twice');
  assert.match(result.output, /The backup reported success/);
  assert.match(result.output, /Heartbeat backup sent: answered 204/);
  assert.match(result.output, /Stopped by SIGTERM/);
  assertNoToken(result);
});

test('a failure sends `backup/fail` with the backup’s own message', async (t) => {
  const hb = await statuser(t);
  const { file } = statusDir(t);
  const message =
    'Not enough free space: /backup has 45.9 GiB free, less than the 1000 GiB required. Nothing was written.';
  const run = start({
    NOTIFY_STATUS_FILE: file,
    NOTIFY_HEARTBEAT_URL: hb.url,
    NOTIFY_TOKEN: TOKEN,
  });
  // Written while the notifier is already waiting, as in the pod.
  await sleep(200);
  assert.equal(hb.requests.length, 0);
  writeStatus(file, `fail\n${message}\n`);
  await until(() => hb.requests.length === 1, 'the heartbeat');
  assert.equal(hb.requests[0].path, 'backup/fail');
  assert.equal(hb.requests[0].body, `backup failed: ${message}`);
  run.child.kill('SIGTERM');
  const result = await run.exited;
  assert.equal(result.code, 0);
  assert.match(result.output, /Heartbeat backup\/fail sent: answered 204/);
  assertNoToken(result);
});

test('stopped before the status, it waits for it and sends it', async (t) => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    await t.test(signal, async (st) => {
      const hb = await statuser(st);
      const { file } = statusDir(st);
      const run = start({
        NOTIFY_STATUS_FILE: file,
        NOTIFY_HEARTBEAT_URL: hb.url,
        NOTIFY_TOKEN: TOKEN,
        NOTIFY_STOP_WAIT_SECONDS: '5',
      });
      await until(() => run.output().includes('Waiting for'), 'the notifier to start');
      run.child.kill(signal);
      // The backup container writes its status while it stops.
      await sleep(300);
      writeStatus(file, 'fail\nStopped by SIGINT\n');
      const result = await run.exited;
      assert.equal(result.code, 0);
      assert.deepEqual(
        hb.requests.map((request) => [request.path, request.body]),
        [['backup/fail', 'backup failed: Stopped by SIGINT']],
      );
      assert.match(result.output, new RegExp(`Stopped by ${signal}`));
      assertNoToken(result);
    });
  }
});

test('a backup that ended without a status is reported as a failure', async (t) => {
  const hb = await statuser(t);
  const { file } = statusDir(t);
  const run = start({
    NOTIFY_STATUS_FILE: file,
    NOTIFY_HEARTBEAT_URL: hb.url,
    NOTIFY_TOKEN: TOKEN,
  });
  await until(() => run.output().includes('Waiting for'), 'the notifier to start');
  const stopped = Date.now();
  run.child.kill('SIGTERM');
  const result = await run.exited;
  assert.equal(result.code, 0);
  assert.ok(Date.now() - stopped >= 500, 'it did not wait for the status');
  assert.deepEqual(
    hb.requests.map((request) => [request.path, request.body]),
    [['backup/fail', `backup failed: ${NO_REPORT}`]],
  );
  assert.match(result.output, new RegExp(`${NO_REPORT} within 0\\.5 s of the stop signal`));
  assertNoToken(result);
});

test('an unreachable or refusing Statuser, or no token, is logged and the notifier still exits 0', async (t) => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedUrl = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((resolve) => closed.close(resolve));

  const refusing = await statuser(t, (res) => (res.writeHead(500), res.end()));
  const cases = {
    'nothing listens': [{ NOTIFY_HEARTBEAT_URL: closedUrl }, /not delivered: ECONNREFUSED/],
    'Statuser answers 500': [
      { NOTIFY_HEARTBEAT_URL: refusing.url },
      /Heartbeat backup\/fail not delivered: answered 500/,
    ],
    'the Secret is missing': [
      { NOTIFY_HEARTBEAT_URL: refusing.url, NOTIFY_TOKEN: undefined },
      /NOTIFY_TOKEN is not set .*Heartbeat backup\/fail not sent/s,
    ],
    'the heartbeat URL is plain http off the loopback interface': [
      { NOTIFY_HEARTBEAT_URL: 'http://heartbeat.example' },
      /NOTIFY_HEARTBEAT_URL is not an https URL.*Heartbeat backup\/fail not sent/s,
    ],
  };
  for (const [name, [env, pattern]] of Object.entries(cases)) {
    await t.test(name, async (st) => {
      const { file } = statusDir(st);
      writeStatus(file, 'fail\npg_dump of qa_tools failed\n');
      const before = refusing.requests.length;
      const vars = { NOTIFY_STATUS_FILE: file, NOTIFY_TOKEN: TOKEN, ...env };
      for (const key of Object.keys(vars)) if (vars[key] === undefined) delete vars[key];
      const run = start(vars);
      await until(() => /Heartbeat backup\/fail/.test(run.output()), 'the attempt');
      run.child.kill('SIGTERM');
      const result = await run.exited;
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, pattern);
      if (!('NOTIFY_TOKEN' in vars)) assert.equal(refusing.requests.length, before);
      assertNoToken(result);
    });
  }
});

test('a status file that cannot be read is logged once, not at every look', async (t) => {
  const hb = await statuser(t);
  const { file } = statusDir(t);
  // A directory where the file belongs: EISDIR at every look, as root too.
  mkdirSync(file);
  const run = start({
    NOTIFY_STATUS_FILE: file,
    NOTIFY_HEARTBEAT_URL: hb.url,
    NOTIFY_TOKEN: TOKEN,
  });
  await sleep(600); // about a dozen looks
  run.child.kill('SIGTERM');
  const result = await run.exited;
  assert.equal(result.code, 0);
  assert.equal(result.output.match(/The status file could not be read: EISDIR/g)?.length, 1);
  assert.deepEqual(
    hb.requests.map((request) => request.path),
    ['backup/fail'],
  );
  assertNoToken(result);
});

test('the token is kept out of the log and the body in any letter case', async (t) => {
  const hb = await statuser(t);
  const { file } = statusDir(t);
  writeStatus(file, `fail\nsomething quoted ${TOKEN.toUpperCase()} by mistake\n`);
  const run = start({
    NOTIFY_STATUS_FILE: file,
    NOTIFY_HEARTBEAT_URL: hb.url,
    NOTIFY_TOKEN: TOKEN,
  });
  await until(() => hb.requests.length === 1, 'the heartbeat');
  run.child.kill('SIGTERM');
  const result = await run.exited;
  assert.equal(result.code, 0);
  assert.equal(hb.requests[0].body, 'backup failed: something quoted <token> by mistake');
  for (const form of [TOKEN, TOKEN.toUpperCase()]) {
    assert.ok(!result.output.includes(form), `the output holds ${form}`);
  }
});

// A value far beyond a token's 128 characters: V8 refuses a regular expression
// built from 32 768 characters or more, which once printed the whole value in
// its error and exited 1, over and over as a restarted sidecar.
test('a token too long to be one is never printed, and the notifier still waits to be stopped', async (t) => {
  for (const length of [32_768, 100_000]) {
    await t.test(`${length} characters`, async (st) => {
      const hb = await statuser(st);
      const { file } = statusDir(st);
      writeStatus(file, 'ok\n\n');
      const huge = 'Zq'.repeat(length / 2);
      const run = start({
        NOTIFY_STATUS_FILE: file,
        NOTIFY_HEARTBEAT_URL: hb.url,
        NOTIFY_TOKEN: huge,
      });
      await until(() => run.output().includes('Heartbeat backup not sent'), 'the outcome');
      await sleep(300);
      assert.equal(run.child.exitCode, null, 'the notifier exited before it was stopped');
      run.child.kill('SIGTERM');
      const result = await run.exited;
      assert.equal(result.code, 0);
      assert.equal(hb.requests.length, 0);
      assert.match(result.output, /NOTIFY_TOKEN does not look like a heartbeat token/);
      for (const form of ['ZqZqZqZq', 'zqzqzqzq', 'ZQZQZQZQ']) {
        assert.ok(!result.output.includes(form), `the output holds ${form}`);
      }
    });
  }
  const huge = 'Zq'.repeat(50_000);
  assert.equal(
    scrubber([[huge, '<token>']])(`a ${huge.toLowerCase()} b ${huge.toUpperCase()}`),
    'a <token> b <token>',
  );
});

test('an error inside the notifier is logged by its name alone, and it still waits to be stopped', async () => {
  const secret = 'Zq'.repeat(20);
  // An environment that fails as it is read, with the value in its message.
  const env = new Proxy(
    {},
    {
      get(target, key) {
        if (key === 'NOTIFY_TOKEN') throw new Error(`could not read ${secret}`);
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
  assert.equal(finished, false, 'the notifier ended before it was stopped');
  signals.emit('SIGTERM');
  assert.equal(await done, 0);
  const output = lines.join('');
  assert.match(output, /The notifier stopped on an error: Error\n/);
  assert.match(output, /Stopped by SIGTERM/);
  assert.ok(!output.toLowerCase().includes(secret.toLowerCase()), 'the message reached the output');
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('the status file is read as `ok`, or `fail` and one line of message', () => {
  assert.deepEqual(parseStatus('ok\n\n'), { ok: true, message: '' });
  assert.deepEqual(parseStatus('fail\nStopped by SIGTERM\n'), {
    ok: false,
    message: 'Stopped by SIGTERM',
  });
  assert.deepEqual(parseStatus('fail\n\n'), { ok: false, message: 'The backup failed' });
  assert.equal(parseStatus(`fail\n${'x'.repeat(400)}\n`).message.length, 300);
  // The longest an off-server copy's failure reaches the status, the script's
  // prefix and the 240 characters it keeps of the uploader's message, is
  // sent whole (#121).
  const offsite = `Off-server copy failed: ${'y'.repeat(240)}`;
  assert.deepEqual(parseStatus(`fail\n${offsite}\n`), { ok: false, message: offsite });
  // Anything else is not a success.
  for (const text of ['', 'OK\n', 'okay\n', 'garbage']) {
    assert.equal(parseStatus(text).ok, false, JSON.stringify(text));
  }
  assert.equal(heartbeatBody({ ok: true, message: '' }), 'backup succeeded');
  assert.equal(heartbeatBody({ ok: false, message: 'x' }), 'backup failed: x');
});
