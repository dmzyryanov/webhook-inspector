/**
 * The receive listener's own behaviour, over real sockets where the socket is
 * the point (D187).
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 *
 * - Every header is stored, however many: Node 24's default refuses a request
 *   with more than 1000 header lines with `431`, well within its size limit,
 *   16 KiB of request target and header names and values.
 * - A sender that ends its side of the connection before its answer is written
 *   gets no answer (D187, option B of review round 1). Node's HTTP server
 *   keeps `httpAllowHalfOpen` at its default, `false`: a FIN after a complete
 *   request aborts it. Through Traefik's TCP route every departure of a sender
 *   reaches the backend as a FIN - a TCP FIN, a TLS `close_notify`, a closed
 *   or reset connection - so this is what keeps a sender that gives up during a
 *   configured delay recorded `aborted`, its wait cancelled (D105, D109).
 * - The host's `robots.txt`, and the protective headers on everything it
 *   answers, `404`s included.
 *
 * PROXY protocol is off here, as locally: `trust-boundary.test.ts` covers the
 * PROXY layer.
 */
import assert from 'node:assert/strict';
import net, { type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { ResponseConfig } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { RECEIVE_ROBOTS_TXT } from '../../server.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import {
  CONTENT_SECURITY_POLICY_HEADER,
  CONTENT_TYPE_OPTIONS_HEADER,
  NOSNIFF,
  RECEIVER_CONTENT_SECURITY_POLICY,
} from './response.ts';

let pool: pg.Pool;
let servers: TestServers;
/** The application listener, which creates the sessions. */
let api: FastifyInstance;
/** The receive listener, listening on the loopback interface. */
let receiver: FastifyInstance;
let port: number;
const createdSessionIds: string[] = [];

// after() waits for before() to finish. Node's runner does not when a name
// pattern leaves this file no test, and what before() opens would outlive the
// run (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = start();
  await startup;
});

async function start(): Promise<void> {
  pool = createPool(loadConfig().databaseUrl);
  servers = buildTestServers(pool);
  ({ api, receiver } = servers);
  api.log.level = 'silent';
  receiver.log.level = 'silent';
  await api.ready();
  await receiver.listen({ host: '127.0.0.1', port: 0 });
  port = (receiver.server.address() as AddressInfo).port;
}

after(async () => {
  // A failed start is before()'s to report; close what it did open.
  await startup?.catch(() => undefined);

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers?.close();
  await pool.end();
});

async function newSession(response?: Partial<ResponseConfig>): Promise<string> {
  const created =
    response === undefined
      ? await api.inject({ method: 'POST', url: '/api/sessions' })
      : await api.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ response }),
        });

  assert.equal(created.statusCode, 201, created.body);

  const { id } = created.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

interface Stored {
  id: string;
  headers: [string, string][];
  body: Buffer;
}

async function storedRequests(sessionId: string): Promise<Stored[]> {
  const result = await pool.query<Stored>(
    'SELECT id, headers, body FROM requests WHERE session_id = $1 ORDER BY received_at, id',
    [sessionId],
  );

  return result.rows;
}

/**
 * Writes `request` over a real socket and reads until the server closes the
 * connection or the deadline passes. The request asks for `Connection: close`.
 */
function exchange(request: Buffer, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let received = '';

    const deadline = setTimeout(() => {
      socket.destroy();
      reject(new Error('the server did not close the connection in time'));
    }, timeoutMs);

    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(deadline);
      resolve(received);
    });
  });
}

/** The state of the one response record a session holds, or `undefined` for none. */
async function recordState(sessionId: string): Promise<string | undefined> {
  const result = await pool.query<{ state: string }>(
    `SELECT rr.state FROM request_responses rr JOIN requests q ON q.id = rr.request_id
      WHERE q.session_id = $1`,
    [sessionId],
  );

  return result.rows[0]?.state;
}

/**
 * Writes `request`, then ends the sending side with a FIN once `endWhen`
 * resolves - at once by default - and keeps reading, as a sender whose TLS
 * layer sent `close_notify` does. Resolves with what the server wrote once it
 * has closed the connection.
 */
function halfClose(
  request: Buffer,
  endWhen: () => Promise<void> = async () => {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
    let received = '';

    const deadline = setTimeout(() => {
      socket.destroy();
      reject(new Error('the server did not close the connection in time'));
    }, 5_000);

    socket.on('connect', () => {
      socket.write(request);
      void endWhen().then(() => socket.end());
    });
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(deadline);
      resolve(received);
    });
  });
}

function webhook(target: string, body: string, extra: string[] = []): Buffer {
  return Buffer.from(
    [
      `POST ${target} HTTP/1.1`,
      'Host: hook.qa-tools.ru',
      ...extra,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ].join('\r\n'),
    'latin1',
  );
}

describe('a sender that ends its side before the answer is written gets no answer (D187)', () => {
  it('writes nothing to a sender that half-closes while its request is being stored, whose record stays pending', async () => {
    const sessionId = await newSession();
    const received = await halfClose(webhook(`/s/${sessionId}`, '{"half":"close"}'));

    assert.equal(received, '', 'an answer was written after the FIN');

    // Stored, since the request had arrived whole - after the connection had
    // already closed - and its record is left `pending`, read as `unknown`
    // once it has aged (D109): the connection was gone before the answer
    // could be sent.
    const deadline = Date.now() + 2_000;
    let stored = await storedRequests(sessionId);

    while (stored.length === 0 && Date.now() < deadline) {
      await delay(10);
      stored = await storedRequests(sessionId);
    }

    assert.equal(stored[0]?.body.toString(), '{"half":"close"}');
    await delay(300);
    assert.equal(await recordState(sessionId), 'pending');
  });

  it('records `aborted` for a delayed session whose sender half-closes with its request, before the delay runs out', async () => {
    const delayMs = 1_000;
    const sessionId = await newSession({ status: 202, body: '{"late":true}', delayMs });
    const started = Date.now();
    const received = await halfClose(webhook(`/s/${sessionId}`, '{"half":"close"}'));

    assert.equal(received, '');

    let state: string | undefined;

    while (state !== 'aborted' && Date.now() - started < delayMs) {
      await delay(10);
      state = await recordState(sessionId);
    }

    assert.equal(state, 'aborted', 'not recorded aborted before the delay ran out');
  });

  it('cancels a running wait when the sender half-closes during it, and records `aborted`', async () => {
    const delayMs = 1_500;
    const sessionId = await newSession({ status: 202, body: '{"late":true}', delayMs });
    let waiting = 0;
    const received = await halfClose(webhook(`/s/${sessionId}`, '{"half":"close"}'), async () => {
      // The request is stored, so its handler is waiting out the delay.
      while ((await storedRequests(sessionId)).length === 0) {
        await delay(5);
      }

      waiting = Date.now();
    });

    assert.equal(received, '');

    let state: string | undefined;

    while (state !== 'aborted' && Date.now() - waiting < delayMs) {
      await delay(10);
      state = await recordState(sessionId);
    }

    assert.equal(state, 'aborted', 'the wait was not cancelled by the FIN');
  });
});

describe('every header is stored, however many (D187)', () => {
  it('stores 2500 header lines, all of them in order, within the 16 KiB limit', async () => {
    const sessionId = await newSession();
    const symbols = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    // Five bytes a line, so 2500 lines stay under 16 KiB even counted with
    // their separators, which Node does not count; past Node's default of 1000.
    const lines: [string, string][] = Array.from({ length: 2_500 }, (_, index) => [
      symbols[Math.floor(index / symbols.length)] as string,
      symbols[index % symbols.length] as string,
    ]);
    const request = webhook(`/s/${sessionId}`, '{}', [
      'Connection: close',
      ...lines.map(([name, value]) => `${name}:${value}`),
    ]);

    assert.ok(request.length < 16_384, `${request.length} bytes`);

    const answer = await exchange(request);

    assert.match(answer, /^HTTP\/1\.1 200 OK\r\n/, answer.slice(0, 200));

    const [stored] = await storedRequests(sessionId);

    // Host and Connection first, Content-Type and Content-Length last.
    assert.equal(stored?.headers.length, 2_504);
    assert.deepEqual(stored?.headers.slice(2, 2_502), lines);
  });
});

describe('the receive host serves /s/ and its robots.txt, and nothing else (D187)', () => {
  it('answers /robots.txt with Disallow: /, for GET and HEAD', async () => {
    const response = await receiver.inject({ method: 'GET', url: '/robots.txt' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(response.body, 'User-agent: *\nDisallow: /\n');
    assert.equal(response.body, RECEIVE_ROBOTS_TXT);
    assert.equal(response.headers[CONTENT_TYPE_OPTIONS_HEADER], NOSNIFF);
    assert.equal(
      response.headers[CONTENT_SECURITY_POLICY_HEADER],
      RECEIVER_CONTENT_SECURITY_POLICY,
    );

    const head = await receiver.inject({ method: 'HEAD', url: '/robots.txt' });

    assert.equal(head.statusCode, 200);
    assert.equal(head.headers['content-type'], 'text/plain; charset=utf-8');
  });

  it('answers every other address 404 / 1000, with nosniff and the sandbox policy', async () => {
    for (const [method, url] of [
      ['GET', '/'],
      ['GET', '/api/sessions'],
      ['POST', '/api/sessions'],
      ['GET', '/v/x'],
      ['GET', '/.env'],
      ['GET', '/s'],
      ['POST', '/robots.txt'],
    ] as const) {
      const response = await receiver.inject({ method, url });

      assert.equal(response.statusCode, 404, `${method} ${url}`);
      assert.deepEqual(response.json(), { errorCode: 1000, message: 'Not found' });
      assert.equal(response.headers[CONTENT_TYPE_OPTIONS_HEADER], NOSNIFF, `${method} ${url}`);
      assert.equal(
        response.headers[CONTENT_SECURITY_POLICY_HEADER],
        RECEIVER_CONTENT_SECURITY_POLICY,
        `${method} ${url}`,
      );
    }
  });
});
