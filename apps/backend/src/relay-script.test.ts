/**
 * The relay script, `apps/frontend/public/webhook-inspector-relay.mjs`, run as
 * a child process against a real backend and a local target server (issue
 * #77, D202). The site serves the same file under its old name,
 * `qa-tools-relay.mjs`, until the old names stop (D279).
 *
 * The script is what a tester downloads from https://webhook.qa-tools.ru and
 * runs next to their own service. Here it reads the session through the
 * application listener, webhooks are sent to the receive listener over real
 * sockets, so that their header case, order and duplicates are the sender's,
 * and the target is a plain `node:http` server that records what reached it:
 * its request line, its `rawHeaders` exactly as they arrived, and its body
 * bytes.
 *
 * The listeners run under production's per-address limits (D201), so the
 * tests also show that the relay's ordinary use stays inside them; one test
 * runs a second pair under a low limit, to see it meet `429` / `1015`.
 *
 * Its pure parts - arguments, paths, headers, body, `Retry-After` - and its
 * answers to an API that fails or limits it in other ways are tested in the
 * frontend suite (`apps/frontend/src/lib/relay-script.test.ts`), with a stub
 * API.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { insertSession } from './modules/sessions/repository.ts';
import { whileExpired } from './testing/expired-session.ts';
import { buildTestServers, type TestServers } from './testing/servers.ts';

const SCRIPT = fileURLToPath(
  new URL('../../frontend/public/webhook-inspector-relay.mjs', import.meta.url),
);

/** How long a step that should take milliseconds may take before the test fails. */
const STEP_MS = 15_000;

let pool: pg.Pool;
let servers: TestServers;
let apiBase: string;
let receivePort: number;
let target: http.Server;
let targetBase: string;
const createdSessionIds: string[] = [];
const relays = new Set<ChildProcess>();

/** Every call the application listener answered: its URL, status and `X-RateLimit-Limit`, in order. */
const apiCalls: { url: string; status: number; limit: string; userAgent: string | undefined }[] =
  [];
/** Every call the application listener began, answered or not. */
const apiCallsStarted: string[] = [];

interface Received {
  method: string;
  url: string;
  rawHeaders: string[];
  body: Buffer;
}

/** What reached the target, by the first segment of its path: each test has its own. */
const received = new Map<string, Received[]>();

/** Called before the target answers a request on that first segment, if set. */
const holds = new Map<string, (request: Received) => Promise<void>>();

function firstSegment(url: string): string {
  return url.split('/')[1]?.split('?')[0] ?? '';
}

async function handleTarget(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  const record: Received = {
    method: request.method ?? '',
    url: request.url ?? '',
    rawHeaders: request.rawHeaders,
    body: Buffer.concat(chunks),
  };
  const segment = firstSegment(record.url);

  received.set(segment, [...(received.get(segment) ?? []), record]);
  await holds.get(segment)?.(record);
  response.writeHead(200, { 'content-type': 'text/plain' }).end('relayed');
}

// after() waits for before() to finish. Node's runner does not when a name
// pattern leaves this file no test, and what before() opens would outlive the
// run (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = start();
  await startup;
});

/** A log destination that drops every line. */
function discard(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

async function start(): Promise<void> {
  pool = createPool(loadConfig().databaseUrl);
  servers = buildTestServers(pool, { logDestination: discard() });
  servers.api.addHook('onRequest', (request, _reply, done) => {
    apiCallsStarted.push(request.url);
    done();
  });
  servers.api.addHook('onResponse', (request, reply, done) => {
    apiCalls.push({
      url: request.url,
      status: reply.statusCode,
      limit: String(reply.getHeader('x-ratelimit-limit')),
      userAgent: request.headers['user-agent'],
    });
    done();
  });
  await servers.api.listen({ host: '127.0.0.1', port: 0 });
  await servers.receiver.listen({ host: '127.0.0.1', port: 0 });
  apiBase = `http://127.0.0.1:${(servers.api.server.address() as AddressInfo).port}`;
  receivePort = (servers.receiver.server.address() as AddressInfo).port;
  target = http.createServer((request, response) => {
    handleTarget(request, response).catch((error: unknown) => {
      response.destroy(error as Error);
    });
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  targetBase = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
}

after(async () => {
  // A failed start is before()'s to report; close what it did open.
  await startup?.catch(() => undefined);

  for (const relay of relays) {
    relay.kill('SIGKILL');
  }

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  target?.closeAllConnections();
  await new Promise((resolve) => (target ? target.close(resolve) : resolve(undefined)));
  await servers?.close();
  await pool?.end();
});

/**
 * A session created with an id as the generator before D161 made it - 32
 * random bytes in Base64URL - whose first one or two symbols are `-`
 * (`111110`), as about 1 in 64 and 1 in 4096 of those ids are. The row is
 * inserted, because the generator no longer makes such an id.
 */
async function olderSession(dashes: 1 | 2): Promise<string> {
  const bytes = randomBytes(32);

  if (dashes === 1) {
    bytes[0] = 0b1111_1000;
  } else {
    bytes[0] = 0b1111_1011;
    bytes[1] = 0b1110_0000;
  }

  const id = bytes.toString('base64url');

  assert.ok(id.startsWith('-'.repeat(dashes)) && id[dashes] !== '-', id);
  await insertSession(pool, id, null);
  createdSessionIds.push(id);

  return id;
}

async function newSession(): Promise<string> {
  const created = await servers.api.inject({ method: 'POST', url: '/api/sessions' });

  assert.equal(created.statusCode, 201, created.body);

  const { id } = created.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

/**
 * Sends `head` (the request line and header lines, without the blank line)
 * and `body` to the receive listener on `port` over a socket of its own, and
 * answers the id of the request it stored.
 */
function capture(
  head: string,
  body: Buffer = Buffer.alloc(0),
  port = receivePort,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(Buffer.concat([Buffer.from(`${head}\r\n\r\n`, 'latin1'), body]));
    });
    let answer = '';

    socket.setTimeout(STEP_MS, () => socket.destroy(new Error('the receiver did not answer')));
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('latin1');
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const id = /^x-qa-tools-request-id: ([0-9a-f-]{36})\r$/im.exec(answer)?.[1];

      if (id === undefined) {
        reject(new Error(`the receiver stored nothing: ${answer.slice(0, 200)}`));
      } else {
        resolve(id);
      }
    });
  });
}

/** A body-less `POST` to `/s/<session><path>`, on the receive listener on `port`. */
function capturePath(sessionId: string, path: string, port = receivePort): Promise<string> {
  return capture(
    `POST /s/${sessionId}${path} HTTP/1.1\r\nHost: hook.example\r\nContent-Length: 0\r\nConnection: close`,
    Buffer.alloc(0),
    port,
  );
}

interface Relay {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  /** Resolves with the first line of stdout, or of `stream`, matching `pattern`, waiting for it. */
  line(pattern: RegExp, stream?: 'stdout' | 'stderr'): Promise<string>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;
}

/**
 * Runs the script with `args` and the local API, `apiBase` unless `api` names
 * another, given after them, or before them with `apiFirst`, for arguments
 * that end the options with `--`. Its environment is this process's without
 * either access-key variable, plus `accessKey` as `WEBHOOK_INSPECTOR_ACCESS_KEY`
 * and `oldAccessKey` as `QA_TOOLS_ACCESS_KEY` when given (D253, D279).
 */
function startRelay(
  args: string[],
  {
    apiFirst = false,
    api: base = apiBase,
    accessKey,
    oldAccessKey,
  }: { apiFirst?: boolean; api?: string; accessKey?: string; oldAccessKey?: string } = {},
): Relay {
  const api = ['--api', base];
  const env: NodeJS.ProcessEnv = { ...process.env };

  delete env.WEBHOOK_INSPECTOR_ACCESS_KEY;
  delete env.QA_TOOLS_ACCESS_KEY;

  if (accessKey !== undefined) {
    env.WEBHOOK_INSPECTOR_ACCESS_KEY = accessKey;
  }

  if (oldAccessKey !== undefined) {
    env.QA_TOOLS_ACCESS_KEY = oldAccessKey;
  }

  const child = spawn(
    process.execPath,
    [SCRIPT, ...(apiFirst ? [...api, ...args] : [...args, ...api])],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const waiting = new Set<() => void>();

  relays.add(child);

  const collect = (lines: string[]) => {
    let partial = '';

    return (chunk: Buffer) => {
      const parts = (partial + chunk.toString('utf8')).split('\n');

      partial = parts.pop() ?? '';
      lines.push(...parts);

      for (const wake of waiting) {
        wake();
      }
    };
  };

  child.stdout?.on('data', collect(stdout));
  child.stderr?.on('data', collect(stderr));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      relays.delete(child);
      resolve({ code, signal });

      for (const wake of waiting) {
        wake();
      }
    });
  });

  return {
    child,
    stdout,
    stderr,
    exited,
    line: (pattern, stream = 'stdout') =>
      new Promise((resolve, reject) => {
        const check = () => {
          const found = (stream === 'stdout' ? stdout : stderr).find((line) => pattern.test(line));

          if (found !== undefined) {
            finish();
            resolve(found);
          } else if (child.exitCode !== null || child.signalCode !== null) {
            finish();
            reject(
              new Error(
                `the relay ended without printing ${pattern}:\n${stdout.join('\n')}\n${stderr.join('\n')}`,
              ),
            );
          }
        };
        const timer = setTimeout(() => {
          finish();
          reject(
            new Error(
              `the relay printed no line matching ${pattern} in ${STEP_MS} ms:\n${stdout.join('\n')}\n${stderr.join('\n')}`,
            ),
          );
        }, STEP_MS);
        const finish = () => {
          clearTimeout(timer);
          waiting.delete(check);
        };

        waiting.add(check);
        check();
      }),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }

      await exited;
    },
  };
}

/** Waits until the target has received `count` requests under `segment`, and answers them. */
async function receivedUnder(segment: string, count: number): Promise<Received[]> {
  const deadline = Date.now() + STEP_MS;

  while ((received.get(segment)?.length ?? 0) < count) {
    assert.ok(
      Date.now() < deadline,
      `the target received ${received.get(segment)?.length ?? 0} of ${count} requests under /${segment}`,
    );
    await delay(20);
  }

  return received.get(segment) ?? [];
}

/** A fresh first path segment for a test's target base URL. */
function segment(name: string): string {
  return `${name}-${randomBytes(4).toString('hex')}`;
}

describe('webhook-inspector-relay.mjs against a real backend', () => {
  it('sends a request on with its method, path after the id, query, headers in order and case, and body bytes', async (t) => {
    const sessionId = await newSession();
    const tag = segment('exact');
    const relay = startRelay([sessionId, `${targetBase}/${tag}`]);

    t.after(() => relay.stop());
    await relay.line(/Ctrl\+C stops/);

    // Every byte value, then bytes that are not UTF-8.
    const binary = Buffer.concat([
      Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
      Buffer.from([0xc3, 0x28, 0xff, 0xfe]),
    ]);

    await capture(
      [
        `PUT /s/${sessionId}/a/b?x=1&y=%20 HTTP/1.1`,
        'Host: hook.example',
        'X-Trace: one',
        'content-TYPE: application/octet-stream',
        'X-Dup: a',
        'X-Forwarded-For: 203.0.113.9',
        'Accept-Encoding: gzip',
        'X-Real-Ip: 198.51.100.7',
        'x-dup: b',
        'Accept-Encoding: br',
        'Keep-Alive: timeout=5',
        'X-Empty: ',
        `Content-Length: ${binary.length}`,
        'X-Dup: c',
        'Connection: close',
      ].join('\r\n'),
      binary,
    );

    const [binaryRequest] = await receivedUnder(tag, 1);

    assert.equal(binaryRequest?.method, 'PUT');
    assert.equal(binaryRequest?.url, `/${tag}/a/b?x=1&y=%20`);
    assert.deepEqual(binaryRequest?.rawHeaders, [
      'Host',
      targetBase.slice('http://'.length),
      'X-Trace',
      'one',
      'content-TYPE',
      'application/octet-stream',
      'X-Dup',
      'a',
      'x-dup',
      'b',
      'Accept-Encoding',
      'br',
      'X-Empty',
      '',
      'X-Dup',
      'c',
      'Content-Length',
      String(binary.length),
      'Connection',
      'close',
    ]);
    assert.ok(binaryRequest?.body.equals(binary), 'the binary body arrived changed');
    await relay.line(new RegExp(`PUT /${tag}/a/b\\?x=1&y=%20 -> 200$`));

    // A UTF-8 body that began with a byte-order mark, which the API's text
    // form drops and the relay puts back; and the endpoint itself.
    const text = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"name":"Иван","emoji":"🙂"}\n', 'utf8'),
    ]);

    await capture(
      [
        `POST /s/${sessionId} HTTP/1.1`,
        'Host: hook.example',
        'Content-Type: application/json; charset=utf-8',
        `Content-Length: ${text.length}`,
        'Connection: close',
      ].join('\r\n'),
      text,
    );

    // The endpoint with a trailing slash, a GET without a body, and a HEAD.
    await capture(
      `GET /s/${sessionId}/ HTTP/1.1\r\nHost: hook.example\r\nX-Order: 1\r\nConnection: close`,
    );
    await capture(
      `HEAD /s/${sessionId}/head?q HTTP/1.1\r\nHost: hook.example\r\nConnection: close`,
    );

    const [, textRequest, slashRequest, headRequest] = await receivedUnder(tag, 4);

    assert.equal(textRequest?.method, 'POST');
    assert.equal(textRequest?.url, `/${tag}`);
    assert.ok(textRequest?.body.equals(text), 'the text body arrived changed');
    assert.deepEqual(textRequest?.rawHeaders.slice(2, 4), [
      'Content-Type',
      'application/json; charset=utf-8',
    ]);

    assert.equal(slashRequest?.method, 'GET');
    assert.equal(slashRequest?.url, `/${tag}/`);
    assert.deepEqual(slashRequest?.rawHeaders, [
      'Host',
      targetBase.slice('http://'.length),
      'X-Order',
      '1',
      'Connection',
      'close',
    ]);
    assert.equal(slashRequest?.body.length, 0);

    assert.equal(headRequest?.method, 'HEAD');
    assert.equal(headRequest?.url, `/${tag}/head?q`);
    await relay.line(new RegExp(`HEAD /${tag}/head\\?q -> 200$`));

    // Neither a length nor chunked framing: a POST is sent with
    // `Content-Length: 0`, never with a `Transfer-Encoding: chunked` its
    // sender did not send, and a DELETE with neither.
    await capture(`POST /s/${sessionId}/bare HTTP/1.1\r\nHost: hook.example\r\nConnection: close`);
    await capture(
      `DELETE /s/${sessionId}/bare HTTP/1.1\r\nHost: hook.example\r\nConnection: close`,
    );

    const [bareRequest, deleteRequest] = (await receivedUnder(tag, 6)).slice(4);
    const host = targetBase.slice('http://'.length);

    assert.equal(bareRequest?.method, 'POST');
    assert.deepEqual(bareRequest?.rawHeaders, [
      'Host',
      host,
      'Content-Length',
      '0',
      'Connection',
      'close',
    ]);
    assert.equal(deleteRequest?.method, 'DELETE');
    assert.deepEqual(deleteRequest?.rawHeaders, ['Host', host, 'Connection', 'close']);
  });

  it('skips what was captured before it started, and with --from-start sends it first, oldest first', async (t) => {
    const sessionId = await newSession();

    for (const index of [1, 2, 3]) {
      await capturePath(sessionId, `/old/${index}`);
    }

    const skipping = segment('skip');
    const first = startRelay([sessionId, `${targetBase}/${skipping}`]);

    t.after(() => first.stop());
    await first.line(/3 captured before now are skipped/);

    // The first new request is deleted while the target holds it, so the
    // relay's next call names a request that is gone and the list is read
    // again: the three requests from before the start are still not sent.
    let newStored: (id: string) => void = () => undefined;
    const newId = new Promise<string>((resolve) => {
      newStored = resolve;
    });

    holds.set(skipping, async (request) => {
      if (request.url.endsWith('/new/1')) {
        const deleted = await servers.api.inject({
          method: 'DELETE',
          url: `/api/sessions/${sessionId}/requests/${await newId}`,
        });

        assert.equal(deleted.statusCode, 204);
        await capturePath(sessionId, '/new/2');
      }
    });
    t.after(() => holds.delete(skipping));
    newStored(await capturePath(sessionId, '/new/1'));
    await first.line(new RegExp(`POST /${skipping}/new/2 -> 200$`));
    await delay(300);
    assert.deepEqual(
      received.get(skipping)?.map((request) => request.url),
      [`/${skipping}/new/1`, `/${skipping}/new/2`],
    );
    const deletedId = await newId;

    assert.ok(
      apiCalls.some((call) => call.url.includes(`after=${deletedId}`) && call.status === 404),
      'no call named the deleted request as after',
    );
    await first.stop();

    // The webhook URL, with a path after the id, names the session as well.
    const all = segment('from-start');
    const second = startRelay([
      `http://127.0.0.1:${receivePort}/s/${sessionId}/any/path?x=1`,
      `${targetBase}/${all}`,
      '--from-start',
    ]);

    t.after(() => second.stop());
    await second.line(/oldest first/);

    const forwarded = await receivedUnder(all, 4);

    assert.deepEqual(
      forwarded.map((request) => request.url),
      ['/old/1', '/old/2', '/old/3', '/new/2'].map((path) => `/${all}${path}`),
    );
  });

  it('sends a burst larger than a page completely, in capture order, once each', async (t) => {
    const sessionId = await newSession();
    const tag = segment('burst');
    const before = 150;
    const during = 120;

    for (let index = 0; index < before; index += 1) {
      await capturePath(sessionId, `/b/${index}`);
    }

    const relay = startRelay([sessionId, `${targetBase}/${tag}`, '--from-start']);

    t.after(() => relay.stop());
    await relay.line(/Ctrl\+C stops/);

    for (let index = before; index < before + during; index += 1) {
      await capturePath(sessionId, `/b/${index}`);
    }

    const forwarded = await receivedUnder(tag, before + during);

    // A little longer, so that a repeat would have arrived.
    await delay(500);
    assert.deepEqual(
      received.get(tag)?.map((request) => request.url),
      Array.from({ length: before + during }, (_, index) => `/${tag}/b/${index}`),
    );
    assert.equal(forwarded.length, before + during);

    const pages = apiCalls.filter(
      (call) => call.url.includes(sessionId) && /[?&]limit=100(&|$)/.test(call.url),
    );

    assert.ok(pages.length >= 3, `the list was read in ${pages.length} pages`);

    // Well inside production's 1200 calls a minute (D201), which this listener
    // has: one detail call per request and one list call per answer of up to
    // 100, so at most two calls a request, and never a 429. The 270 requests
    // took 274 calls when this was written.
    const relayCalls = apiCalls.filter((call) => call.url.includes(sessionId));
    const details = relayCalls.filter((call) => !call.url.includes('/requests?'));

    assert.ok(
      relayCalls.every((call) => call.status === 200 && call.limit === '1200'),
      JSON.stringify(relayCalls.filter((call) => call.status !== 200 || call.limit !== '1200')),
    );
    assert.equal(details.length, before + during);
    assert.ok(
      relayCalls.length <= 2 * (before + during) + 1,
      `the relay made ${relayCalls.length} calls for ${before + during} requests`,
    );
  });

  it('meets 429 / 1015 under a low RATE_LIMIT_API_CALLS_PER_MINUTE, waits its Retry-After with one line, and sends every request once', async (t) => {
    // Fewer calls a minute than sending these requests takes: the start's
    // list, at least one waiting list, one detail call per request, and the
    // list after them. The limit is read from the variable as the process
    // reads it.
    const count = 5;
    const { rateLimits } = loadConfig({
      ...process.env,
      RATE_LIMIT_API_CALLS_PER_MINUTE: String(count + 1),
    });

    assert.equal(rateLimits.apiCalls, count + 1);

    // The limits' clock is the test's and stands still unless moved, so the
    // window's minute need not pass for real; the relay's wait is real.
    let now = 1_000;
    const limited = buildTestServers(pool, {
      logDestination: discard(),
      rateLimits: { ...rateLimits, now: () => now },
    });
    const startedAt = new WeakMap<object, number>();
    const calls: {
      url: string;
      status: number;
      retryAfter: unknown;
      startedAt: number | undefined;
      answeredAt: number;
    }[] = [];
    // The relay, once started, is stopped before the listeners close.
    const running: { relay?: Relay } = {};

    t.after(async () => {
      await running.relay?.stop();
      await limited.close();
    });
    // After the limits' own hook, so a refused call is not seen here.
    limited.api.addHook('onRequest', (request, _reply, done) => {
      startedAt.set(request, Date.now());
      done();
    });
    limited.api.addHook('onResponse', (request, reply, done) => {
      calls.push({
        url: request.url,
        status: reply.statusCode,
        retryAfter: reply.getHeader('retry-after'),
        startedAt: startedAt.get(request),
        answeredAt: Date.now(),
      });
      done();
    });
    await limited.api.listen({ host: '127.0.0.1', port: 0 });
    await limited.receiver.listen({ host: '127.0.0.1', port: 0 });

    const limitedApi = `http://127.0.0.1:${(limited.api.server.address() as AddressInfo).port}`;
    const limitedReceivePort = (limited.receiver.server.address() as AddressInfo).port;
    const sessionId = await newSession();
    const tag = segment('limited');

    const relay = startRelay([sessionId, `${targetBase}/${tag}`], { api: limitedApi });

    running.relay = relay;
    await relay.line(/0 captured before now are skipped/);

    // The window began with the start's list; 57 of its 60 s pass at once.
    now += 57_000;

    for (let index = 0; index < count; index += 1) {
      await capturePath(sessionId, `/l/${index}`, limitedReceivePort);
    }

    await relay.line(
      /API rate limit reached \(429, errorCode 1015\); trying again in 3 s$/,
      'stderr',
    );
    // The window ends while the relay waits; its next call opens another.
    now += 3_000;

    await receivedUnder(tag, count);
    // A little longer, so that a repeat would have arrived.
    await delay(300);

    assert.deepEqual(
      received.get(tag)?.map((request) => request.url),
      Array.from({ length: count }, (_, index) => `/${tag}/l/${index}`),
    );
    assert.equal(relay.stdout.filter((line) => / -> 200$/.test(line)).length, count);
    assert.equal(relay.stderr.length, 1, relay.stderr.join('\n'));

    // The limit's calls were answered, the next one refused with three
    // seconds to wait, and the relay called again only once they had passed.
    const position = calls.findIndex((call) => call.status === 429);
    const refusal = calls[position];
    const retry = calls[position + 1];

    assert.equal(position, count + 1, JSON.stringify(calls));
    assert.ok(refusal !== undefined);
    assert.equal(refusal.retryAfter, '3');
    assert.ok(
      calls.every((call) => call === refusal || call.status === 200),
      JSON.stringify(calls),
    );
    assert.ok(retry?.startedAt !== undefined, 'the relay did not call again');

    const waited = retry.startedAt - refusal.answeredAt;

    assert.ok(waited >= 2_950, `the relay called again ${waited} ms after the 429`);
  });

  it('after a clear, and after the request it waits after is deleted, sends new requests once each and waits while idle', async (t) => {
    const sessionId = await newSession();
    const tag = segment('gone');
    const relay = startRelay([sessionId, `${targetBase}/${tag}`]);
    const requests = `/api/sessions/${sessionId}/requests`;

    t.after(() => relay.stop());
    await relay.line(/0 captured before now are skipped/);

    const first = await capturePath(sessionId, '/r1');

    await relay.line(new RegExp(`/${tag}/r1 -> 200$`));

    // A clear ends the relay's wait with []; the request it waits after is gone.
    const cleared = await servers.api.inject({ method: 'DELETE', url: requests });

    assert.equal(cleared.statusCode, 204);
    await capturePath(sessionId, '/r2');
    await relay.line(new RegExp(`/${tag}/r2 -> 200$`));

    // The target holds the next request while the test deletes it from the
    // session and captures another: the relay's next call names a request
    // that is gone.
    let fourth = '';
    let thirdStored: (id: string) => void = () => undefined;
    const thirdId = new Promise<string>((resolve) => {
      thirdStored = resolve;
    });

    holds.set(tag, async (request) => {
      if (request.url.endsWith('/r3')) {
        const deleted = await servers.api.inject({
          method: 'DELETE',
          url: `${requests}/${await thirdId}`,
        });

        assert.equal(deleted.statusCode, 204);
        fourth = await capturePath(sessionId, '/r4');
      }
    });

    const third = await capturePath(sessionId, '/r3');

    thirdStored(third);

    await relay.line(new RegExp(`/${tag}/r4 -> 200$`));
    holds.delete(tag);
    await capturePath(sessionId, '/r5');
    await relay.line(new RegExp(`/${tag}/r5 -> 200$`));
    await delay(300);

    assert.deepEqual(
      received.get(tag)?.map((request) => request.url),
      ['/r1', '/r2', '/r3', '/r4', '/r5'].map((path) => `/${tag}${path}`),
    );
    assert.notEqual(fourth, '');

    // Both gaps were met by the API's 404 for a gone `after`.
    for (const gone of [first, third]) {
      assert.ok(
        apiCalls.some((call) => call.url.includes(`after=${gone}`) && call.status === 404),
        `no call named the gone request ${gone} as after`,
      );
    }

    // Idle: the call under way waits, and no other is made.
    const startedBefore = apiCallsStarted.filter((url) => url.includes(sessionId)).length;

    await delay(3_000);

    const startedIdle =
      apiCallsStarted.filter((url) => url.includes(sessionId)).length - startedBefore;

    assert.ok(startedIdle <= 1, `the idle relay made ${startedIdle} calls in 3 s`);

    // The call under way is a list that waits 30 s: idle, the relay makes two
    // calls a minute, against the 1200 its address may make (D201).
    const mine = apiCallsStarted.filter((url) => url.includes(sessionId));

    assert.match(mine.at(-1) ?? '', /[?&]wait=30(&|$)/);
    assert.equal(apiCalls.filter((call) => call.url.includes(sessionId)).length, mine.length - 1);
  });

  it('takes a session id from before D161 that starts with -, bare or after --', async (t) => {
    for (const dashes of [1, 2] as const) {
      const sessionId = await olderSession(dashes);

      for (const endOptions of [false, true]) {
        const tag = segment('older');
        const base = `${targetBase}/${tag}`;
        const relay = endOptions
          ? startRelay(['--', sessionId, base], { apiFirst: true })
          : startRelay([sessionId, base]);

        t.after(() => relay.stop());
        await relay.line(/Ctrl\+C stops/);
        await capturePath(sessionId, '/older');
        await relay.line(new RegExp(`POST /${tag}/older -> 200$`));
        await relay.stop();
        assert.deepEqual(
          relay.stderr,
          [],
          `${dashes} dash(es), ${endOptions ? 'after --' : 'bare'}`,
        );
        assert.deepEqual(
          received.get(tag)?.map((request) => request.url),
          [`/${tag}/older`],
        );
      }
    }
  });

  it('prints an error line for a target that cannot be reached, and sends the next request', async (t) => {
    const sessionId = await newSession();
    const closed = http.createServer((_request, response) => {
      response.writeHead(204).end();
    });

    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));

    const port = (closed.address() as AddressInfo).port;

    await new Promise((resolve) => closed.close(resolve));

    const relay = startRelay([sessionId, `http://127.0.0.1:${port}/down`]);

    t.after(() => relay.stop());
    t.after(
      () =>
        new Promise((resolve) => {
          closed.closeAllConnections();
          closed.close(resolve);
        }),
    );
    await relay.line(/Ctrl\+C stops/);
    await capturePath(sessionId, '/first');
    await relay.line(/POST \/down\/first -> error: .*ECONNREFUSED/);

    await new Promise<void>((resolve) => closed.listen(port, '127.0.0.1', resolve));
    await capturePath(sessionId, '/second');
    await relay.line(/POST \/down\/second -> 204$/);
    assert.equal(relay.child.exitCode, null, 'the relay stopped');
  });

  it('forwards a private session’s requests with WEBHOOK_INSPECTOR_ACCESS_KEY, sending the key to the API on every call and to the service never (D253, D279)', async (t) => {
    const created = await servers.api.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'application/json' },
      payload: '{"private":true}',
    });

    assert.equal(created.statusCode, 201, created.body);

    const { id, accessKey } = created.json<{ id: string; accessKey: string }>();

    createdSessionIds.push(id);

    const base = segment('private');
    const firstCall = apiCalls.length;
    const relay = startRelay([id, `${targetBase}/${base}`], { accessKey });

    t.after(() => relay.stop());
    await relay.line(/Ctrl\+C stops/);
    await capture(
      `POST /s/${id}/hook?x=1 HTTP/1.1\r\nHost: hook.example\r\nAuthorization: Bearer sender-own\r\nContent-Length: 2\r\nConnection: close`,
      Buffer.from('{}'),
    );

    const [forwarded] = await receivedUnder(base, 1);

    await relay.line(/POST \/private-[0-9a-f]+\/hook\?x=1 -> 200/);
    await relay.stop();

    // The sender's own Authorization reaches the service as captured, and
    // the relay's key never does.
    assert.equal(forwarded?.url, `/${base}/hook?x=1`);
    assert.deepEqual(
      (forwarded?.rawHeaders ?? []).filter((_value, index, all) =>
        /^authorization$/i.test(all[index - (index % 2)] ?? ''),
      ),
      ['Authorization', 'Bearer sender-own'],
    );
    assert.ok(!JSON.stringify(forwarded?.rawHeaders).includes(accessKey));

    // Every call it made was answered, none refused as a missing session.
    const calls = apiCalls.slice(firstCall).filter((call) => call.url.includes(id));

    assert.ok(calls.length >= 2, `${calls.length} calls`);
    assert.ok(
      calls.every((call) => call.status === 200),
      JSON.stringify(calls),
    );
    // Its User-Agent names the service (D279).
    assert.ok(
      calls.every((call) => call.userAgent === 'webhook-inspector-relay'),
      JSON.stringify(calls),
    );
    assert.ok(!relay.stdout.join('\n').includes(accessKey), 'the key was printed');
    assert.ok(!relay.stderr.join('\n').includes(accessKey), 'the key was printed');

    // Without the key the same session is not found, and the relay says why it may be.
    const keyless = startRelay([id, `${targetBase}/${base}`]);
    const keylessEnd = await keyless.exited;

    assert.equal(keylessEnd.code, 1);
    assert.match(
      keyless.stderr.join('\n'),
      /not found \(404, errorCode 1001\).*it is private and WEBHOOK_INSPECTOR_ACCESS_KEY does not hold its access key/,
    );
  });

  /**
   * The old name, still read beside the new one (#334, D279): the old
   * variable alone still relays a private session's webhook, with a line
   * naming the new one; with both set the new one wins - here the old holds
   * another key, which would find no session.
   */
  for (const [description, keys, says] of [
    [
      'QA_TOOLS_ACCESS_KEY alone',
      'old',
      /^QA_TOOLS_ACCESS_KEY is the old name of WEBHOOK_INSPECTOR_ACCESS_KEY/,
    ],
    ['both variables set, the new one read', 'both', undefined],
  ] as const) {
    it(`forwards a private session’s requests with ${description} (D279)`, async (t) => {
      const created = await servers.api.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { 'content-type': 'application/json' },
        payload: '{"private":true}',
      });

      assert.equal(created.statusCode, 201, created.body);

      const { id, accessKey } = created.json<{ id: string; accessKey: string }>();
      const other = `${accessKey.slice(0, -1)}${accessKey.endsWith('A') ? 'B' : 'A'}`;

      createdSessionIds.push(id);

      const base = segment(keys);
      const firstCall = apiCalls.length;
      const relay = startRelay(
        [id, `${targetBase}/${base}`],
        keys === 'old' ? { oldAccessKey: accessKey } : { accessKey, oldAccessKey: other },
      );

      t.after(() => relay.stop());
      await relay.line(/Ctrl\+C stops/);
      await capture(
        `POST /s/${id}/hook HTTP/1.1\r\nHost: hook.example\r\nContent-Length: 2\r\nConnection: close`,
        Buffer.from('{}'),
      );

      const [forwarded] = await receivedUnder(base, 1);

      await relay.line(new RegExp(`POST /${base}/hook -> 200`));
      await relay.stop();

      assert.equal(forwarded?.url, `/${base}/hook`);

      const calls = apiCalls.slice(firstCall).filter((call) => call.url.includes(id));

      assert.ok(calls.length >= 2, `${calls.length} calls`);
      assert.ok(
        calls.every((call) => call.status === 200),
        JSON.stringify(calls),
      );

      const stderr = relay.stderr.join('\n');

      if (says === undefined) {
        assert.doesNotMatch(stderr, /old name/);
      } else {
        assert.match(stderr, says);
      }

      for (const key of [accessKey, other]) {
        assert.ok(!relay.stdout.join('\n').includes(key), 'a key was printed');
        assert.ok(!stderr.includes(key), 'a key was printed');
      }
    });
  }

  it('ends with status 1 and a message for an unknown, an expired and a deleted session', async (t) => {
    const unknown = startRelay(['A'.repeat(43), `${targetBase}/unknown`]);
    const unknownEnd = await unknown.exited;

    assert.equal(unknownEnd.code, 1);
    assert.match(unknown.stderr.join('\n'), /session was not found \(404, errorCode 1001\)/);

    const expiredId = await newSession();

    await whileExpired(pool, expiredId, async () => {
      const expired = startRelay([expiredId, `${targetBase}/expired`]);
      const expiredEnd = await expired.exited;

      assert.equal(expiredEnd.code, 1);
      assert.match(expired.stderr.join('\n'), /session has expired \(410, errorCode 1002\)/);
    });

    const deletedId = await newSession();
    const deleted = startRelay([deletedId, `${targetBase}/deleted`]);

    t.after(() => deleted.stop());
    await deleted.line(/Ctrl\+C stops/);

    const answer = await servers.api.inject({
      method: 'DELETE',
      url: `/api/sessions/${deletedId}`,
    });

    assert.equal(answer.statusCode, 204);

    const deletedEnd = await deleted.exited;

    assert.equal(deletedEnd.code, 1);
    assert.match(deleted.stderr.join('\n'), /session was not found/);
  });
});
