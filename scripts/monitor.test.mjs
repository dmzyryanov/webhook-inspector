// The site and disk monitor (deploy/helm/qa-tools/files/monitor.mjs, D181),
// run as the CronJob runs it — `node monitor.mjs` with its settings in the
// environment — against three stand-ins on the loopback interface: the site,
// answering `/` and `/api/sessions/<id>` as production does or failing in a
// chosen way, the receive host, answering `/s/<id>` as production's does since
// 0.36.0 (D187), and Statuser's heartbeat endpoint, recording every heartbeat.
// The disk is the test machine's own temporary directory, so the threshold
// decides the outcome; the rounding and the threshold themselves are pinned
// on the pure functions. Nothing here reaches the internet. What is pinned is
// issue #68's: `site` or `site/fail` after up to three attempts, `disk` or
// `disk/fail` with the percentage, only `/` and `/api/sessions/<random id>`
// requested and so no session created, and no token or session id in any
// output or heartbeat. The random id has a session id's shape, which the
// stand-in requires as the backend does before it reads the database: an id
// of another shape would be answered without the database ever being checked
// (D181).

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { statfsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  DEFAULTS,
  baseUrl,
  describeError,
  diskFails,
  diskUsagePercent,
  heartbeatUrl,
  main,
  randomSessionId,
  scrubber,
} from '../deploy/helm/qa-tools/files/monitor.mjs';
// No imports of its own, so Node loads it as TypeScript here with nothing installed.
import { SESSION_ID_PATTERN } from '../packages/shared/src/index.ts';

const SCRIPT = fileURLToPath(new URL('../deploy/helm/qa-tools/files/monitor.mjs', import.meta.url));
const TEMPLATE = readFileSync(
  new URL('../deploy/helm/qa-tools/templates/monitor.yaml', import.meta.url),
  'utf8',
);
const VALUES = readFileSync(
  new URL('../deploy/helm/qa-tools/values.yaml', import.meta.url),
  'utf8',
);

// Stand-ins for the two heartbeat tokens, shaped as Statuser's are. Neither may
// appear in any output or heartbeat body.
const SITE_TOKEN = '6f1c9a2e-4b7d-4e0a-9c3f-1d2e5b8a7c01';
const DISK_TOKEN = 'b4e8d0f2-7a1c-4d3e-8f5b-0c9a2e6d4b12';
const { Response, AbortController } = globalThis;

// A server on the loopback interface that records each request and answers
// through `handler`, or never, when the handler returns false.
async function serve(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = {
        method: req.method,
        path: req.url,
        type: req.headers['content-type'],
        body,
      };
      requests.push(request);
      handler(request, res, requests);
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

// A port nothing listens on: taken from the system, then released.
async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

// Production's answers: the application shell, and the lookup's 404 for a
// session the database does not hold. The backend answers an id of any other
// shape without reading the database, so the stand-in gives such an id an
// answer the monitor must not accept: a lookup that stops there checks
// nothing (D181).
function healthy(request, res) {
  const id = /^\/api\/sessions\/(.*)$/.exec(request.path)?.[1];
  if (request.path === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html>\n<html lang="en"><head></head><body></body></html>');
  } else if (id !== undefined && SESSION_ID_PATTERN.test(id)) {
    json(res, 404, { errorCode: 1001, message: 'Session not found' });
  } else if (id !== undefined) {
    json(res, 404, { errorCode: 1000, message: 'Not a session id: the database was not read' });
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

// The receive host's answer to a webhook for a session the database does not
// hold, `404` / `1001`; like the backend, the stand-in reads nothing for an id
// of another shape, and answers what the monitor must not accept (D187).
function healthyReceive(request, res) {
  const id = /^\/s\/(.*)$/.exec(request.path)?.[1];
  if (id !== undefined && SESSION_ID_PATTERN.test(id)) {
    json(res, 404, { errorCode: 1001, message: 'Session not found' });
  } else {
    json(res, 404, { errorCode: 1000, message: 'Not found' });
  }
}

// Statuser's answer to a heartbeat.
const statuser = (request, res) => {
  res.writeHead(204);
  res.end();
};

// Runs the script as the CronJob does and resolves with its exit code and output.
function run(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, output: `${stdout}${stderr}` });
    });
  });
}

async function setup(t, { site = healthy, receive = healthyReceive, heartbeats = statuser } = {}) {
  const siteServer = await serve(t, site);
  const receiveServer = await serve(t, receive);
  const hb = await serve(t, heartbeats);
  const env = (overrides = {}) => ({
    MONITOR_SITE_URL: siteServer.url,
    MONITOR_RECEIVE_URL: receiveServer.url,
    MONITOR_HEARTBEAT_URL: hb.url,
    MONITOR_SITE_TOKEN: SITE_TOKEN,
    MONITOR_DISK_TOKEN: DISK_TOKEN,
    MONITOR_DISK_PATH: tmpdir(),
    // Nothing but a full disk reaches 100 %.
    MONITOR_DISK_THRESHOLD: '100',
    MONITOR_RETRY_SECONDS: '0.05',
    MONITOR_TIMEOUT_SECONDS: '2',
    ...overrides,
  });
  return { site: siteServer, receive: receiveServer, hb, env };
}

// What every run must keep to itself: the tokens, and the session ids it made
// up, in its output and in every heartbeat it sent.
function assertNothingLeaked(ctx, result) {
  const ids = [
    ...ctx.site.requests.map((request) => /^\/api\/sessions\/(.+)$/.exec(request.path)?.[1]),
    ...ctx.receive.requests.map((request) => /^\/s\/(.+)$/.exec(request.path)?.[1]),
  ].filter(Boolean);
  const bodies = ctx.hb.requests.map((request) => request.body).join('\n');
  for (const secret of [SITE_TOKEN, DISK_TOKEN, ...ids]) {
    assert.ok(!result.output.includes(secret), `the output holds ${secret}`);
    assert.ok(!bodies.includes(secret), `a heartbeat body holds ${secret}`);
  }
}

// The heartbeats Statuser received, as `<monitor>` or `<monitor>/fail`.
const received = (ctx) =>
  ctx.hb.requests.map((request) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.type, 'text/plain; charset=utf-8');
    const path = request.path.replace(`/${SITE_TOKEN}`, 'site').replace(`/${DISK_TOKEN}`, 'disk');
    return { path, body: request.body };
  });

test('a healthy run sends `disk` and `site`, and asks the site for `/` and one random session and the receive host for another', async (t) => {
  const ctx = await setup(t);
  const result = await run(ctx.env());
  assert.equal(result.status, 0, result.output);

  const [disk, site, ...rest] = received(ctx);
  assert.equal(rest.length, 0);
  assert.equal(disk.path, 'disk');
  assert.match(disk.body, /^disk \d{1,3}% used, \d+\.\d GiB free; fails at 100%$/);
  assert.equal(site.path, 'site');
  assert.equal(
    site.body,
    'site up: GET / 200 text/html, GET /api/sessions/<random> 404 errorCode 1001, ' +
      'GET /s/<random> on the receive host 404 errorCode 1001; attempt 1 of 3',
  );

  // Read-only: the page and a lookup of a session that does not exist, which
  // is how the monitor never creates one.
  assert.deepEqual(
    ctx.site.requests.map((request) => request.method),
    ['GET', 'GET'],
  );
  assert.equal(ctx.site.requests[0].path, '/');
  const [, prefix, id] = /^(\/api\/sessions\/)(.*)$/.exec(ctx.site.requests[1].path);
  assert.equal(prefix, '/api/sessions/');
  assert.match(id, SESSION_ID_PATTERN);

  // The receive host: one GET of a random session's receive URL, a webhook
  // that stores nothing, with an id of its own (D187).
  assert.deepEqual(
    ctx.receive.requests.map((request) => request.method),
    ['GET'],
  );
  const [, receiveId] = /^\/s\/(.*)$/.exec(ctx.receive.requests[0].path);
  assert.match(receiveId, SESSION_ID_PATTERN);
  assert.notEqual(receiveId, id);

  assert.match(result.stdout, /Site attempt 1 of 3 passed/);
  assert.match(result.stdout, /Heartbeat disk sent: answered 204/);
  assert.match(result.stdout, /Heartbeat site sent: answered 204/);
  assert.match(result.stdout, /GET \/api\/sessions\/<random>/);
  assert.match(result.stdout, /GET \/s\/<random> on the receive host/);
  assert.match(result.stdout, /Monitor finished: site up, disk ok; 2 of 2 heartbeats delivered/);
  assert.equal(result.stderr, '');
  assertNothingLeaked(ctx, result);
});

test('a site failing three times sends `site/fail` with the last failure, after the pauses', async (t) => {
  const ctx = await setup(t, {
    site: (request, res) => {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad Gateway');
    },
  });
  const started = Date.now();
  const result = await run(ctx.env({ MONITOR_RETRY_SECONDS: '0.3' }));
  assert.equal(result.status, 0, result.output);
  assert.ok(Date.now() - started >= 600, 'the attempts did not pause between them');

  assert.deepEqual(
    ctx.site.requests.map((request) => `${request.method} ${request.path}`),
    ['GET /', 'GET /', 'GET /'],
    'three attempts, each stopping at the page',
  );
  const [disk, site] = received(ctx);
  assert.equal(disk.path, 'disk');
  assert.equal(site.path, 'site/fail');
  assert.equal(site.body, 'site down after 3 attempts: GET / answered 502 text/plain');
  for (const attempt of [1, 2, 3]) {
    assert.match(
      result.stdout,
      new RegExp(`Site attempt ${attempt} of 3 failed: GET / answered 502 text/plain`),
    );
  }
  assert.match(result.stdout, /Heartbeat site\/fail sent: answered 204/);
  assert.match(result.stdout, /Monitor finished: site down, disk ok; 2 of 2 heartbeats delivered/);
  assertNothingLeaked(ctx, result);
});

test('a site that answers on the third attempt sends `site`', async (t) => {
  const ctx = await setup(t, {
    site: (request, res, requests) => {
      if (requests.filter((seen) => seen.path === '/').length < 3) {
        res.writeHead(503, { 'content-type': 'text/html' });
        res.end('<html>Service Unavailable</html>');
      } else {
        healthy(request, res);
      }
    },
  });
  const result = await run(ctx.env());
  assert.equal(result.status, 0, result.output);
  const site = received(ctx).find((heartbeat) => heartbeat.path.startsWith('site'));
  assert.equal(site.path, 'site');
  assert.match(site.body, /attempt 3 of 3$/);
  assert.equal(ctx.site.requests.length, 4);
  assertNothingLeaked(ctx, result);
});

test('each way the site can fail is named in `site/fail`', async (t) => {
  const page = (request, res) => healthy(request, res);
  const lookup = (answer) => (request, res) =>
    request.path === '/' ? page(request, res) : answer(request, res);
  const cases = {
    'the page is not HTML': [
      (request, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('hello');
      },
      'GET / answered 200 text/plain',
    ],
    'the page is empty': [
      (request, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('');
      },
      'GET / answered 200 text/html without an HTML document',
    ],
    'the lookup is served the application shell': [
      lookup((request, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html></html>');
      }),
      'GET /api/sessions/<random> answered 200 text/html',
    ],
    'the lookup finds a session': [
      lookup((request, res) => json(res, 200, { id: 'x' })),
      'GET /api/sessions/<random> answered 200 application/json',
    ],
    'the lookup answers another error': [
      lookup((request, res) => json(res, 404, { errorCode: 1000, message: 'Not found' })),
      'GET /api/sessions/<random> answered 404 with errorCode 1000, not 1001',
    ],
    'the lookup is not JSON': [
      lookup((request, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{');
      }),
      'GET /api/sessions/<random> answered 404 application/json that did not parse',
    ],
    'the backend is down behind the proxy': [
      lookup((request, res) => {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('Bad Gateway');
      }),
      'GET /api/sessions/<random> answered 502 text/plain',
    ],
    'the page redirects': [
      (request, res) => {
        res.writeHead(301, { location: 'https://elsewhere.test/' });
        res.end();
      },
      'GET / failed: unexpected redirect',
    ],
  };
  // Every case here gets an answer, so each runs with the file's 2 s limit
  // for a request. The limit holds every request, the heartbeats included:
  // at 0.3 s an answer or a heartbeat late on a loaded machine turned the
  // pinned failure into `no answer within 0.3 s`, or the heartbeat went
  // undelivered (F-12). Only the page that never answers waits a limit out,
  // below, in one attempt.
  for (const [name, [site, failure]] of Object.entries(cases)) {
    await t.test(name, async (st) => {
      const ctx = await setup(st, { site });
      const result = await run(ctx.env());
      assert.equal(result.status, 0, result.output);
      const heartbeat = received(ctx).find((sent) => sent.path.startsWith('site'));
      assert.equal(heartbeat.path, 'site/fail');
      assert.equal(heartbeat.body, `site down after 3 attempts: ${failure}`);
      assert.ok(
        ctx.site.requests.every(
          (request) =>
            request.method === 'GET' &&
            (request.path === '/' ||
              SESSION_ID_PATTERN.test(request.path.replace('/api/sessions/', ''))),
        ),
        'the monitor asked for something other than / and one random session',
      );
      assertNothingLeaked(ctx, result);
    });
  }

  await t.test('the page never answers', async (st) => {
    const ctx = await setup(st, { site: () => {} });
    const result = await run(ctx.env({ MONITOR_ATTEMPTS: '1' }));
    assert.equal(result.status, 0, result.output);
    const heartbeat = received(ctx).find((sent) => sent.path.startsWith('site'));
    assert.equal(heartbeat.path, 'site/fail');
    assert.equal(heartbeat.body, 'site down after 1 attempt: GET / failed: no answer within 2 s');
    assert.deepEqual(
      ctx.site.requests.map((request) => `${request.method} ${request.path}`),
      ['GET /'],
    );
    assertNothingLeaked(ctx, result);
  });

  await t.test('nothing listens', async (st) => {
    const ctx = await setup(st);
    const port = await closedPort();
    const result = await run(ctx.env({ MONITOR_SITE_URL: `http://127.0.0.1:${port}` }));
    assert.equal(result.status, 0, result.output);
    const heartbeat = received(ctx).find((sent) => sent.path.startsWith('site'));
    assert.equal(heartbeat.path, 'site/fail');
    assert.equal(heartbeat.body, 'site down after 3 attempts: GET / failed: ECONNREFUSED');
    assertNothingLeaked(ctx, result);
  });
});

test('each way the receive host can fail is named in `site/fail` (D187)', async (t) => {
  const cases = {
    'the receive host captures the request': [
      (request, res) => json(res, 200, { ok: true, requestId: 'x' }),
      'GET /s/<random> on the receive host answered 200 application/json',
    ],
    'the receive host is the old one, which answers 410': [
      (request, res) =>
        json(res, 410, { errorCode: 1009, message: 'Webhooks for this session are received at …' }),
      'GET /s/<random> on the receive host answered 410 application/json',
    ],
    'the receive host answers another error': [
      (request, res) => json(res, 404, { errorCode: 1000, message: 'Not found' }),
      'GET /s/<random> on the receive host answered 404 with errorCode 1000, not 1001',
    ],
    'the receive host is the site itself': [
      (request, res) => {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html>Page not found</html>');
      },
      'GET /s/<random> on the receive host answered 404 text/html',
    ],
  };
  for (const [name, [receive, failure]] of Object.entries(cases)) {
    await t.test(name, async (st) => {
      const ctx = await setup(st, { receive });
      const result = await run(ctx.env());
      assert.equal(result.status, 0, result.output);
      const heartbeat = received(ctx).find((sent) => sent.path.startsWith('site'));
      assert.equal(heartbeat.path, 'site/fail');
      assert.equal(heartbeat.body, `site down after 3 attempts: ${failure}`);
      // Each attempt reached the receive host, after the site's two checks.
      assert.equal(ctx.receive.requests.length, 3);
      assert.equal(ctx.site.requests.length, 6);
      assert.ok(
        ctx.receive.requests.every(
          (request) =>
            request.method === 'GET' && SESSION_ID_PATTERN.test(request.path.replace('/s/', '')),
        ),
        'the monitor asked the receive host for something other than one random session',
      );
      assertNothingLeaked(ctx, result);
    });
  }

  await t.test('nothing listens on the receive host', async (st) => {
    const ctx = await setup(st);
    const port = await closedPort();
    const result = await run(ctx.env({ MONITOR_RECEIVE_URL: `http://127.0.0.1:${port}` }));
    assert.equal(result.status, 0, result.output);
    const heartbeat = received(ctx).find((sent) => sent.path.startsWith('site'));
    assert.equal(heartbeat.path, 'site/fail');
    assert.equal(
      heartbeat.body,
      'site down after 3 attempts: GET /s/<random> on the receive host failed: ECONNREFUSED',
    );
    assertNothingLeaked(ctx, result);
  });

  await t.test('no receive host configured', async (st) => {
    const ctx = await setup(st);
    for (const value of ['', 'http://hook.qa-tools.ru']) {
      const result = await run(ctx.env({ MONITOR_RECEIVE_URL: value }));
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /MONITOR_RECEIVE_URL (is not a URL|must be an https URL)/);
      assert.match(result.stdout, /receive host \(not set\)/);
    }
    // Neither run asked the site or the receive host anything, and each sent
    // `site/fail` saying the check is not configured.
    assert.equal(ctx.site.requests.length, 0);
    assert.equal(ctx.receive.requests.length, 0);
    const sites = received(ctx).filter((sent) => sent.path.startsWith('site'));
    assert.deepEqual(
      sites.map((sent) => [sent.path, sent.body]),
      [
        ['site/fail', 'site check not configured: see the monitor log'],
        ['site/fail', 'site check not configured: see the monitor log'],
      ],
    );
  });
});

test('the disk fails at and above the threshold, in whole percent rounded up as df rounds', () => {
  assert.equal(diskFails(79, 80), false);
  assert.equal(diskFails(80, 80), true);
  assert.equal(diskFails(81, 80), true);

  // 1 000 000 blocks of which 50 000 are reserved for root: used / (used +
  // available), the reserved blocks counted in neither.
  const disk = (used) => ({ blocks: 1_000_000, bfree: 1_000_000 - used, bavail: 950_000 - used });
  assert.equal(diskUsagePercent(disk(750_500)), 79); // 79.00 %
  assert.equal(diskUsagePercent(disk(750_501)), 80); // 79.0001 %, up as df rounds
  assert.equal(diskUsagePercent(disk(760_000)), 80); // exactly 80 %
  assert.equal(diskFails(diskUsagePercent(disk(750_500)), 80), false);
  assert.equal(diskFails(diskUsagePercent(disk(750_501)), 80), true);
  assert.equal(diskFails(diskUsagePercent(disk(769_500)), 80), true); // 81 %
  assert.equal(diskUsagePercent(disk(0)), 0);
  assert.equal(diskUsagePercent(disk(950_000)), 100);
  assert.throws(() => diskUsagePercent({ blocks: 0, bfree: 0, bavail: 0 }));
});

test('a disk at or above the threshold sends `disk/fail` with the percentage; below it `disk`', async (t) => {
  const percent = diskUsagePercent(statfsSync(tmpdir()));
  assert.ok(percent >= 1 && percent < 100, `the test disk is ${percent}% used`);
  for (const [threshold, path] of [
    [1, 'disk/fail'],
    [100, 'disk'],
  ]) {
    await t.test(`threshold ${threshold}%`, async (st) => {
      const ctx = await setup(st);
      const result = await run(ctx.env({ MONITOR_DISK_THRESHOLD: String(threshold) }));
      assert.equal(result.status, 0, result.output);
      const disk = received(ctx).find((sent) => sent.path.startsWith('disk'));
      assert.equal(disk.path, path);
      assert.match(
        disk.body,
        new RegExp(`^disk \\d+% used, \\d+\\.\\d GiB free; fails at ${threshold}%$`),
      );
      assert.match(
        result.stdout,
        new RegExp(`Heartbeat ${path.replace('/', '\\/')} sent: answered 204`),
      );
      assertNothingLeaked(ctx, result);
    });
  }

  await t.test('a directory that is not there', async (st) => {
    const ctx = await setup(st);
    const result = await run(ctx.env({ MONITOR_DISK_PATH: '/no/such/directory' }));
    assert.equal(result.status, 0, result.output);
    const disk = received(ctx).find((sent) => sent.path.startsWith('disk'));
    assert.equal(disk.path, 'disk/fail');
    assert.equal(disk.body, 'disk usage of /no/such/directory not read: ENOENT');
    assertNothingLeaked(ctx, result);
  });
});

test('a Statuser that cannot be reached fails the Job and prints no token', async (t) => {
  const ctx = await setup(t);
  const port = await closedPort();
  const result = await run(ctx.env({ MONITOR_HEARTBEAT_URL: `http://127.0.0.1:${port}` }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR: Heartbeat disk not delivered: ECONNREFUSED/);
  assert.match(result.stderr, /ERROR: Heartbeat site not delivered: ECONNREFUSED/);
  assert.match(result.stdout, /0 of 2 heartbeats delivered/);
  assertNothingLeaked(ctx, result);
});

test('a heartbeat Statuser refuses is not counted as delivered', async (t) => {
  const ctx = await setup(t, {
    heartbeats: (request, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown token');
    },
  });
  const result = await run(ctx.env());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR: Heartbeat site not delivered: answered 404/);
  assertNothingLeaked(ctx, result);
});

test('a missing token leaves that heartbeat unsent, sends the other, and fails the Job', async (t) => {
  const ctx = await setup(t);
  const result = await run(ctx.env({ MONITOR_SITE_TOKEN: '' }));
  assert.equal(result.status, 1);
  assert.deepEqual(
    received(ctx).map((sent) => sent.path),
    ['disk'],
  );
  assert.match(result.stderr, /ERROR: MONITOR_SITE_TOKEN is not set/);
  assert.match(result.stderr, /ERROR: Heartbeat site not sent: no token/);
  assertNothingLeaked(ctx, result);

  // A value that is no token is not sent, nor printed.
  const odd = await setup(t);
  const strange = 'not a token/../with spaces';
  const oddResult = await run(odd.env({ MONITOR_DISK_TOKEN: strange }));
  assert.equal(oddResult.status, 1);
  assert.deepEqual(
    received(odd).map((sent) => sent.path),
    ['site'],
  );
  assert.match(oddResult.stderr, /MONITOR_DISK_TOKEN does not look like a heartbeat token/);
  assert.ok(!oddResult.output.includes(strange));
});

test('tokens travel only over https, or http on the loopback interface', async (t) => {
  const ctx = await setup(t);
  const result = await run(ctx.env({ MONITOR_HEARTBEAT_URL: 'http://heartbeat.example' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MONITOR_HEARTBEAT_URL must be an https URL/);
  assert.equal(ctx.hb.requests.length, 0);
  assert.match(result.stderr, /ERROR: Heartbeat disk not sent: no heartbeat URL/);
  assertNothingLeaked(ctx, result);

  assert.throws(() => baseUrl('http://example.test', 'X'), /must be an https URL/);
  assert.throws(() => baseUrl('https://user:pw@example.test', 'X'), /no credentials/);
  assert.throws(() => baseUrl('https://example.test/?t=1', 'X'), /no credentials, query/);
  assert.throws(
    () => baseUrl(SITE_TOKEN, 'X'),
    (error) => !error.message.includes(SITE_TOKEN),
  );
  assert.equal(baseUrl('http://127.0.0.1:9', 'X').href, 'http://127.0.0.1:9/');
});

// A token pasted where a URL belongs is printed with the URL's host, which
// the URL parser lowercases; the scrub matches it in any letter case. Port 1 is
// one fetch refuses before any lookup, so nothing leaves the machine.
test('a token is kept out of the output in any letter case', async (t) => {
  const mixed = 'Ab12Cd34-Ef56-4a7B-8c9D-0e1F2a3B4c5D';
  const ctx = await setup(t);
  const result = await run(
    ctx.env({ MONITOR_DISK_TOKEN: mixed, MONITOR_HEARTBEAT_URL: `https://${mixed}.invalid:1` }),
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /heartbeats to https:\/\/<token>\.invalid:1/);
  assert.match(result.stderr, /Heartbeat disk not delivered: bad port/);
  assert.equal(ctx.hb.requests.length, 0);
  for (const form of [mixed, mixed.toLowerCase(), mixed.toUpperCase()]) {
    assert.ok(!result.output.includes(form), `the output holds ${form}`);
  }
  assertNothingLeaked(ctx, result);

  const scrub = scrubber([[mixed, '<token>']]);
  assert.equal(scrub(`a ${mixed.toUpperCase()} b ${mixed.toLowerCase()}`), 'a <token> b <token>');
  assert.equal(scrubber([['a.b$', '<x>']])('a.b$ axb$'), '<x> axb$', 'the secret is literal text');
});

// The defaults the CronJob runs with, which the other tests replace for speed:
// the run itself, with a stand-in for fetch, statfs, the pause and the clock.
// A value far beyond a token's 128 characters: V8 refuses a regular expression
// built from 32 768 characters or more, so the scrub must not be one.
test('a token too long to be one is never printed and does not stop the run', async (t) => {
  for (const length of [32_768, 100_000]) {
    await t.test(`${length} characters`, async (st) => {
      const ctx = await setup(st);
      const huge = 'Zq'.repeat(length / 2);
      // Also as the site's host, which the log prints lowercased; port 1 is
      // refused by fetch before any lookup.
      const result = await run(
        ctx.env({ MONITOR_SITE_TOKEN: huge, MONITOR_SITE_URL: `https://${huge}.invalid:1` }),
      );
      assert.equal(result.status, 1, result.stderr.slice(0, 500));
      assert.deepEqual(
        received(ctx).map((sent) => sent.path),
        ['disk'],
      );
      assert.match(result.stderr, /MONITOR_SITE_TOKEN does not look like a heartbeat token/);
      assert.match(result.stderr, /Heartbeat site\/fail not sent: no token/);
      for (const form of ['ZqZqZqZq', 'zqzqzqzq', 'ZQZQZQZQ']) {
        assert.ok(!result.output.includes(form), `the output holds ${form}`);
      }
      assertNothingLeaked(ctx, result);
    });
  }
});

// Every form a hostile Content-Type could give the lookup id on its way to the
// log: as sent, and as a normaliser lowercasing it or dropping `_` would.
const idForms = (id) => [
  id,
  id.toLowerCase(),
  id.toUpperCase(),
  id.replace(/_/g, ''),
  id.toLowerCase().replace(/_/g, ''),
  id.toLowerCase().replace(/[^a-z0-9.+/-]/g, ''),
];

test('a Content-Type that repeats the lookup id never carries it out, in any form', async (t) => {
  await t.test('an id with `_`, `-` and both cases, in the type and its parameters', async () => {
    const ids = [];
    const beats = [];
    const lines = [];
    const sink = { write: (text) => lines.push(text) };
    const status = await main({
      env: {
        MONITOR_SITE_URL: 'https://site.test',
        MONITOR_RECEIVE_URL: 'https://receive.test',
        MONITOR_HEARTBEAT_URL: 'https://hb.test',
        MONITOR_SITE_TOKEN: SITE_TOKEN,
        MONITOR_DISK_TOKEN: DISK_TOKEN,
        MONITOR_DISK_PATH: '/disk',
      },
      newId: () => {
        const id = `Ab_C-dE_${ids.length}${randomSessionId().slice(9)}`;
        ids.push(id);
        return id;
      },
      fetcher: async (url, options) => {
        if (url.host === 'hb.test') {
          beats.push({ path: url.pathname, body: options.body });
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/') {
          return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
        }
        const id = url.pathname.split('/').at(-1);
        const types = [`Application/${id}`, `${id}`, `text/${id}; charset=${id}`];
        return new Response('{}', {
          status: 404,
          headers: { 'content-type': types[(ids.length - 1) % types.length] },
        });
      },
      stat: async () => ({ blocks: 1000, bfree: 900, bavail: 900, bsize: 4096 }),
      pause: async () => {},
      deadline: () => new AbortController().signal,
      out: sink,
      err: sink,
    });
    assert.equal(status, 0, lines.join(''));
    assert.equal(ids.length, 3);
    for (const id of ids) {
      assert.match(id, SESSION_ID_PATTERN);
      assert.match(id, /_/);
    }
    assert.deepEqual(
      beats.map((beat) => beat.path),
      [`/${DISK_TOKEN}`, `/${SITE_TOKEN}/fail`],
    );
    assert.equal(
      beats[1].body,
      'site down after 3 attempts: GET /api/sessions/<random> answered 404 other',
    );
    const text = `${lines.join('')}\n${beats.map((beat) => beat.body).join('\n')}`;
    for (const id of ids) {
      for (const form of idForms(id)) assert.ok(!text.includes(form), `${form} reached the output`);
    }
  });

  await t.test('the monitor run as the CronJob runs it', async (st) => {
    const ctx = await setup(st, {
      site: (request, res) => {
        const id = /^\/api\/sessions\/(.*)$/.exec(request.path)?.[1];
        if (id === undefined) return healthy(request, res);
        res.writeHead(404, { 'content-type': `Application/${id}` });
        res.end('{}');
      },
    });
    const result = await run(ctx.env());
    assert.equal(result.status, 0, result.output);
    const site = received(ctx).find((sent) => sent.path.startsWith('site'));
    assert.equal(site.path, 'site/fail');
    assert.equal(
      site.body,
      'site down after 3 attempts: GET /api/sessions/<random> answered 404 other',
    );
    const ids = ctx.site.requests
      .map((request) => /^\/api\/sessions\/(.+)$/.exec(request.path)?.[1])
      .filter(Boolean);
    assert.equal(ids.length, 3);
    const text = `${result.output}\n${ctx.hb.requests.map((request) => request.body).join('\n')}`;
    for (const id of ids) {
      for (const form of idForms(id)) assert.ok(!text.includes(form), `${form} reached the output`);
    }
  });
});

test('an unexpected media type is named `other`, never repeated', async (t) => {
  const ctx = await setup(t, {
    site: (request, res) => {
      res.writeHead(503, { 'content-type': 'application/x-something-else; charset=utf-8' });
      res.end('down');
    },
  });
  const result = await run(ctx.env());
  const site = received(ctx).find((sent) => sent.path.startsWith('site'));
  assert.equal(site.body, 'site down after 3 attempts: GET / answered 503 other');
  assert.doesNotMatch(result.output, /something-else/);
});

test('by default the site gets 3 attempts 20 s apart, every request 10 s, and the disk fails at 80 %', async () => {
  assert.deepEqual(DEFAULTS, { threshold: 80, attempts: 3, retrySeconds: 20, timeoutSeconds: 10 });
  const pauses = [];
  const limits = [];
  const requests = [];
  const lines = [];
  const sink = { write: (text) => lines.push(text) };
  const status = await main({
    env: {
      MONITOR_SITE_URL: 'https://site.test',
      MONITOR_RECEIVE_URL: 'https://receive.test',
      MONITOR_HEARTBEAT_URL: 'https://hb.test',
      MONITOR_SITE_TOKEN: SITE_TOKEN,
      MONITOR_DISK_TOKEN: DISK_TOKEN,
      MONITOR_DISK_PATH: '/disk',
    },
    fetcher: async (url, options) => {
      requests.push({ host: url.host, path: url.pathname, body: options.body });
      if (url.host === 'hb.test') return new Response(null, { status: 204 });
      return new Response('Bad Gateway', {
        status: 502,
        headers: { 'content-type': 'text/plain' },
      });
    },
    // 800 blocks used of 1000 available to users: exactly 80 %.
    stat: async () => ({ blocks: 1100, bfree: 300, bavail: 200, bsize: 4096 }),
    pause: async (ms) => pauses.push(ms),
    deadline: (ms) => {
      limits.push(ms);
      return new AbortController().signal;
    },
    out: sink,
    err: sink,
  });
  assert.equal(status, 0, lines.join(''));
  assert.deepEqual(pauses, [20_000, 20_000]);
  // Three pages and two heartbeats, each with the same limit.
  assert.deepEqual(limits, [10_000, 10_000, 10_000, 10_000, 10_000]);
  const beats = requests.filter((request) => request.host === 'hb.test');
  assert.deepEqual(
    beats.map((request) => request.path),
    [`/${DISK_TOKEN}/fail`, `/${SITE_TOKEN}/fail`],
  );
  assert.match(beats[0].body, /^disk 80% used, 0\.0 GiB free; fails at 80%$/);
  assert.equal(beats[1].body, 'site down after 3 attempts: GET / answered 502 text/plain');
});

test('the lookup id has a session id’s shape, fresh each time', () => {
  const ids = new Set(Array.from({ length: 50 }, () => randomSessionId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, SESSION_ID_PATTERN);
});

test('a heartbeat URL is the token under the base, and /fail after it for a failure', () => {
  const base = new URL('https://heartbeat.example');
  assert.equal(
    heartbeatUrl(base, SITE_TOKEN, true).href,
    `https://heartbeat.example/${SITE_TOKEN}`,
  );
  assert.equal(
    heartbeatUrl(base, SITE_TOKEN, false).href,
    `https://heartbeat.example/${SITE_TOKEN}/fail`,
  );
  assert.equal(
    heartbeatUrl(new URL('https://hb.example.test/beat/'), 'abcdefgh', false).href,
    'https://hb.example.test/beat/abcdefgh/fail',
  );
});

test('an error is described by its code or name, never by a message that could hold a URL', () => {
  const wrapped = (cause) => Object.assign(new TypeError('fetch failed'), { cause });
  assert.equal(
    describeError(
      wrapped(
        Object.assign(new Error(`getaddrinfo ENOTFOUND x/${SITE_TOKEN}`), { code: 'ENOTFOUND' }),
      ),
      1000,
    ),
    'ENOTFOUND',
  );
  assert.equal(
    describeError(wrapped(new Error('unexpected redirect')), 1000),
    'unexpected redirect',
  );
  assert.equal(describeError(wrapped(new Error(`bad https://x/${SITE_TOKEN}`)), 1000), 'TypeError');
  assert.equal(
    describeError(Object.assign(new Error('x'), { name: 'TimeoutError' }), 10_000),
    'no answer within 10 s',
  );
});

// What the chart must say, as issue #68 and the owner decided it; since #367
// only with a heartbeat URL set, which no default is.
test('the chart runs the monitor every 5 minutes from a CronJob, as uid 1000, and never creates a Job', () => {
  assert.match(
    TEMPLATE,
    /^\{\{- if \.Values\.alerts\.heartbeatUrl \}\}\napiVersion: v1\nkind: ConfigMap$/m,
  );
  assert.match(TEMPLATE, /\n\{\{- end \}\}\n$/);
  assert.match(TEMPLATE, /^kind: CronJob$/m);
  assert.match(TEMPLATE, /^kind: ConfigMap$/m);
  assert.doesNotMatch(TEMPLATE, /^kind: Job$/m);
  assert.doesNotMatch(TEMPLATE, /helm\.sh\/hook/);
  assert.match(TEMPLATE, /\.Files\.Get "files\/monitor\.mjs"/);
  assert.match(TEMPLATE, /name: \{\{ include "qa-tools\.name" \. \}\}-monitor/);
  assert.match(TEMPLATE, /schedule: \{\{ \.Values\.alerts\.schedule \| quote \}\}/);
  assert.match(TEMPLATE, /concurrencyPolicy: Forbid/);
  assert.match(TEMPLATE, /successfulJobsHistoryLimit: 1/);
  assert.match(TEMPLATE, /failedJobsHistoryLimit: 1/);
  assert.match(TEMPLATE, /backoffLimit: 0/);
  const deadline = Number(/activeDeadlineSeconds: (\d+)/.exec(TEMPLATE)?.[1]);
  assert.ok(deadline > 120 && deadline < 300, 'a run ends before the next one is due');
  assert.match(TEMPLATE, /restartPolicy: Never/);
  assert.match(TEMPLATE, /automountServiceAccountToken: false/);
  assert.match(TEMPLATE, /enableServiceLinks: false/);
  assert.match(TEMPLATE, /imagePullSecrets:/);
  assert.match(TEMPLATE, /runAsUser: 1000\n\s+runAsGroup: 1000\n\s+runAsNonRoot: true/);
  assert.match(TEMPLATE, /readOnlyRootFilesystem: true/);
  assert.match(TEMPLATE, /allowPrivilegeEscalation: false/);
  assert.match(TEMPLATE, /drop: \['ALL'\]/);
  assert.match(
    TEMPLATE,
    /image: \{\{ \.Values\.images\.registry \}\}\/\{\{ \.Values\.images\.backend \}\}:\{\{ include "qa-tools\.imageTag" \. \}\}/,
  );
  assert.match(TEMPLATE, /command: \['node', '\/opt\/monitor\/monitor\.mjs'\]/);
  for (const key of ['site', 'disk']) {
    assert.match(
      TEMPLATE,
      new RegExp(
        `secretKeyRef:\\n\\s+name: \\{\\{ include "qa-tools\\.heartbeatSecret" \\. \\}\\}\\n\\s+key: ${key}\\n\\s+optional: true`,
      ),
    );
  }
  assert.match(
    TEMPLATE,
    /hostPath:\n\s+path: \{\{ \.Values\.alerts\.diskPath \| quote \}\}\n\s+type: Directory/,
  );
  assert.match(
    TEMPLATE,
    /- name: disk\n\s+mountPath: \{\{ \.Values\.alerts\.diskPath \| quote \}\}\n\s+readOnly: true/,
  );

  // The receive host, by its public name, from the chart's own value (D187).
  assert.match(
    TEMPLATE,
    /- name: MONITOR_RECEIVE_URL\n\s+value: \{\{ printf "https:\/\/%s" \(include "qa-tools\.receiveHost" \.\) \| quote \}\}/,
  );
  const receiveValues = /^receive:\n((?: {2}.*\n|\n)*)/m.exec(VALUES)?.[1] ?? '';
  assert.match(receiveValues, /^ {2}host: ''$/m);

  // No heartbeat service, Secret or site by default: an installation sets its
  // own, and the chart derives the Secret's name and the site from the
  // release and the host (scripts/chart.test.mjs).
  const alerts = /^alerts:\n((?: {2}.*\n|\n)*)/m.exec(VALUES)?.[1] ?? '';
  assert.match(alerts, /^ {2}heartbeatUrl: ''$/m);
  assert.match(alerts, /^ {2}existingSecret: ''$/m);
  assert.match(alerts, /^ {2}siteUrl: ''$/m);
  assert.match(alerts, /^ {2}schedule: '\*\/5 \* \* \* \*'$/m);
  assert.match(alerts, /^ {2}diskPath: \/var\/lib\/rancher\/k3s\/storage$/m);
  assert.match(alerts, /^ {2}diskThresholdPercent: 80$/m);
});
