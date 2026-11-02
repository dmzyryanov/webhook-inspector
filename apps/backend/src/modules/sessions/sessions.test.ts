/**
 * Integration tests for the session API.
 *
 * These run against the local PostgreSQL from Docker Compose and exercise real
 * routing, real handlers and real SQL. Most requests are injected into Fastify;
 * the create endpoint also listens on a real port, because several rules of
 * v0.3.0 are about framing an injected request cannot express — a repeated
 * `Content-Type`, a body with no `Content-Type` at all, chunked framing, and a
 * request with no `Content-Length` header.
 *
 * Start the database and apply migrations first:
 *   npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  MAX_BODY_BYTES,
  RESERVED_RESPONSE_HEADERS,
  SESSION_ID_PATTERN,
  SESSION_IDLE_DAYS,
  type ResponseConfig,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import { MAX_REFUSAL_DRAIN_BYTES } from './refused-body.ts';
import {
  generateSessionId,
  refreshSessionExpiry,
  REFRESH_SESSION_EXPIRY_SQL,
  resetRefreshWarningThrottle,
} from './repository.ts';
import { getSessionDetails } from './service.ts';

const UNKNOWN_SESSION_ID = 'z'.repeat(43);

let pool: pg.Pool;
let servers: TestServers;
/** The application listener. */
let app: FastifyInstance;
/** The receive listener (D187), logging to the same output. */
let receiver: FastifyInstance;
let port: number;
let logOutput = '';
const createdSessionIds: string[] = [];

/**
 * How many sessions the application has inserted.
 *
 * "No session row was created" is asserted against this counter rather than
 * against a count of rows: the database is shared with the other test files,
 * which run in parallel processes and create sessions of their own, so a row
 * count would make every rejection test race against them.
 */
let sessionInserts = 0;

function countingPool(base: pg.Pool): pg.Pool {
  return new Proxy(base, {
    get(target, property) {
      if (property === 'query') {
        return (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].includes('INSERT INTO sessions')) {
            sessionInserts += 1;
          }

          return (target.query as (...forwarded: unknown[]) => unknown)(...args);
        };
      }

      const value = Reflect.get(target, property, target);

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

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
  servers = buildTestServers(countingPool(pool), {
    // Dozens of sessions created within a minute, from one address (D201).
    rateLimits: LIMITS_OUT_OF_REACH,
    logDestination: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        logOutput += chunk.toString();
        callback();
      },
    }),
  });
  ({ api: app, receiver } = servers);
  await receiver.ready();
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
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

async function createSession(): Promise<{ id: string; expiresAt: string }> {
  const response = await app.inject({ method: 'POST', url: '/api/sessions' });
  const body = response.json<{ id: string; expiresAt: string }>();

  createdSessionIds.push(body.id);

  return body;
}

/** The expiry PostgreSQL currently holds for a session. */
async function expiresAt(id: string): Promise<Date> {
  const result = await pool.query<{ expires_at: Date }>(
    'SELECT expires_at FROM sessions WHERE id = $1',
    [id],
  );

  const row = result.rows[0];

  if (!row) {
    throw new Error(`session ${id.slice(0, 8)} is gone`);
  }

  return row.expires_at;
}

/**
 * A session's two ends as PostgreSQL holds them (D220): its expiry, the end
 * of its lifetime - `null` for a session without one - and the lifetime as
 * the seconds between its creation and its expiry, all computed in the
 * database to the microsecond.
 */
async function storedEnds(
  id: string,
): Promise<{ expires_at: string; lifetime_ends_at: string | null; lifetime: number }> {
  const result = await pool.query<{
    expires_at: string;
    lifetime_ends_at: string | null;
    lifetime: string;
  }>(
    `SELECT expires_at::text AS expires_at, lifetime_ends_at::text AS lifetime_ends_at,
            extract(epoch FROM expires_at - created_at)::text AS lifetime
       FROM sessions WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];

  assert.ok(row, `session ${id.slice(0, 8)} is gone`);

  return { ...row, lifetime: Number(row.lifetime) };
}

/** Moves a session's expiry to an arbitrary point, as the tests below need. */
async function setExpiry(id: string, interval: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET expires_at = clock_timestamp() + $2::interval WHERE id = $1`,
    [id, interval],
  );
}

/** What `app.inject` resolves to; its own return type is the chainable form. */
type InjectedResponse = Awaited<ReturnType<typeof app.inject>>;

/** Sends a create request with a declared-JSON body. */
function createWith(payload: string): Promise<InjectedResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { 'content-type': 'application/json' },
    payload,
  });
}

/** Write-side failures that mean the server closed on us, not that the test broke. */
const EXPECTED_WRITE_ERRORS = new Set(['ECONNRESET', 'EPIPE']);

/**
 * Whether a raw response is whole: the header block has terminated and as many
 * body bytes as the headers declare have arrived.
 *
 * Anything shorter is unusable. A response read only up to its header
 * terminator carries a truncated body, and `rawErrorCode` would then fail to
 * parse it for a reason that has nothing to do with what the test asserts.
 *
 * A response that declares no `Content-Length` — a chunked one, a `204` or a
 * `304` — has no length to wait for, so it can only be called whole once the
 * connection has closed and nothing more can arrive. That is what `closed`
 * says. No call site produces such a response today, but `sendRawRequest` is a
 * general helper: without this the first caller that did would fail on the
 * timeout rather than resolve on `close`.
 */
function isRawResponseComplete(response: string, closed = false): boolean {
  const separator = response.indexOf('\r\n\r\n');

  if (separator === -1) {
    return false;
  }

  const declared = /\r\ncontent-length:\s*(\d+)/i.exec(response.slice(0, separator));

  if (declared === null) {
    return closed;
  }

  return response.length - separator - 4 >= Number(declared[1]);
}

/**
 * Opens a connection, lets `send` write on it, and returns the raw response.
 *
 * The bytes are decoded as latin1 so that the string length is a byte count,
 * and the response is only handed back once it is whole — a truncated body
 * would fail `rawErrorCode` for a reason that has nothing to do with the
 * server. A write-side EPIPE or ECONNRESET is not fatal: a refused request is
 * answered and closed while the client may still be writing, so only what was
 * read decides the outcome. The wait is bounded, so a response that never
 * completes fails with a clear message instead of hanging the suite.
 */
function readRawExchange(send: (socket: net.Socket) => void, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => send(socket));
    let response = '';

    const deadline = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `no complete response arrived within ${timeoutMs}ms: ${JSON.stringify(response)}`,
        ),
      );
    }, timeoutMs);

    const finish = (): void => {
      clearTimeout(deadline);
      socket.destroy();

      if (isRawResponseComplete(response, true)) {
        resolve(response);
      } else {
        reject(
          new Error(`the connection closed on an incomplete response: ${JSON.stringify(response)}`),
        );
      }
    };

    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');

      if (isRawResponseComplete(response)) {
        finish();
      }
    });
    socket.on('close', finish);
    socket.on('error', (error) => {
      if (EXPECTED_WRITE_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')) {
        return;
      }

      clearTimeout(deadline);
      socket.destroy();
      reject(error);
    });
  });
}

/** Sends a handcrafted request over a socket and returns the raw response. */
function sendRawRequest(request: string | Buffer, timeoutMs = 5_000): Promise<string> {
  return readRawExchange((socket) => {
    socket.write(request);
  }, timeoutMs);
}

/**
 * How much of an oversized body is written before the answer is awaited. Small
 * enough to sit in the socket buffers rather than stream on after the refusal.
 *
 * This is measured, and the direction matters: it counts body bytes written as
 * a prefix *before* waiting for the response, so a larger value is riskier
 * rather than safer. A probe lost 0 of 1000 exchanges at this 32 KiB, and 0 of
 * 200 at each of 0, 4 KiB and 64 KiB, but 17 of 200 at 256 KiB and 29 of 200
 * with the whole 1 MiB written up front. Raising it brings the flake back; see
 * `docs/testing/flakes.md`.
 */
const OVERSIZED_PREFIX_BYTES = 32 * 1024;

/**
 * Sends a request declaring an oversized body and returns the raw response.
 *
 * Only the head and the first `OVERSIZED_PREFIX_BYTES` of the body are written.
 * The create route refuses on an `onRequest` hook, before the body is read at
 * all (D104), so the server answers and closes with the body still unread — and
 * a close with unread data in flight is a TCP reset, which discards everything
 * the client has not read yet, the 415 included. Writing the whole body up
 * front therefore loses the response outright often enough to have made this
 * the suite's one measured flake (docs/testing/flakes.md). A prefix the socket
 * buffers can hold keeps the body genuinely in flight when the refusal is
 * decided, while leaving the server able to drain what arrived and close
 * cleanly. The declared `Content-Length` is what makes the request oversized,
 * and it is the header block the route rules on.
 *
 * Since D143 the declared length must also exceed `MAX_REFUSAL_DRAIN_BYTES`.
 * Within that limit the server reads the body to its end before answering a
 * client that asked for `Connection: close`, and this client never finishes
 * it, so the exchange would wait out the bound instead of being answered.
 */
function sendOversizedRequest(head: string, body: string, timeoutMs = 5_000): Promise<string> {
  return readRawExchange((socket) => {
    socket.write(head);
    socket.write(body.slice(0, OVERSIZED_PREFIX_BYTES));
  }, timeoutMs);
}

/**
 * The piece size `writeInChunks` writes a body in.
 *
 * Measured with the test that uses it, one fresh process per run, against the
 * server before issue #12 was fixed: the whole body as one write lost the
 * answer in 2 of 40 runs, 64 KiB pieces in 8 of 20, these 16 KiB pieces in 38
 * of 40. A longer write leaves more of the body in flight when an undrained
 * refusal closes, which is what the test has to provoke to mean anything. With
 * the fix, 0 of 40 (docs/testing/flakes.md, F-01; D143).
 */
const BODY_CHUNK_BYTES = 16 * 1024;

/**
 * Writes the whole of `body`, one `BODY_CHUNK_BYTES` piece after the previous
 * one has been accepted, and stops quietly once the connection is gone: an
 * error on the way is the server's to explain, and the reader reports it.
 */
async function writeInChunks(socket: net.Socket, body: string): Promise<void> {
  for (let offset = 0; offset < body.length; offset += BODY_CHUNK_BYTES) {
    if (socket.destroyed) {
      return;
    }

    await new Promise<void>((resolve) => {
      socket.write(body.slice(offset, offset + BODY_CHUNK_BYTES), () => resolve());
    });
  }
}

function rawStatus(response: string): number {
  return Number(response.slice(9, 12));
}

function rawErrorCode(response: string): number | undefined {
  return (JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as { errorCode?: number })
    .errorCode;
}

interface StoredConfig {
  response_status: number | null;
  response_headers: [string, string][] | null;
  response_body: string | null;
  response_delay_ms: number | null;
}

async function storedConfig(sessionId: string): Promise<StoredConfig> {
  const result = await pool.query<StoredConfig>(
    `SELECT response_status, response_headers, response_body, response_delay_ms
     FROM sessions WHERE id = $1`,
    [sessionId],
  );

  return result.rows[0] as StoredConfig;
}

/** Asserts a rejection, including that the request never reached the database. */
async function assertRejected(
  response: InjectedResponse,
  statusCode: number,
  errorCode: number,
  inserts: number,
  description: string,
): Promise<void> {
  assert.equal(response.statusCode, statusCode, `${description}: unexpected status`);
  assert.equal(
    response.json<{ errorCode: number }>().errorCode,
    errorCode,
    `${description}: unexpected error code`,
  );
  assert.equal(sessionInserts, inserts, `${description}: a session row was created`);
}

describe('POST /api/sessions', () => {
  it('creates a session that expires seven days out (D133)', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/sessions' });

    assert.equal(response.statusCode, 201);

    const body = response.json<{ id: string; expiresAt: string; receiveUrl: string }>();
    createdSessionIds.push(body.id);

    // Since 1.11.0 the answer says whether the session is private (D253): a
    // creation without `private` is public, and answers no key.
    assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'id', 'private', 'receiveUrl']);
    assert.equal((body as unknown as { private: boolean }).private, false);
    assert.match(body.id, SESSION_ID_PATTERN);
    // The local receive listener, which a server built without a configured
    // receive origin names (D187).
    assert.equal(body.receiveUrl, `http://127.0.0.1:3001/s/${body.id}`);
    // Letters and digits only since D161; the pattern also accepts older ids.
    assert.match(body.id, /^[A-Za-z0-9]{43}$/);

    const daysAhead = (Date.parse(body.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(
      Math.abs(daysAhead - SESSION_IDLE_DAYS) < 0.01,
      `expected about ${SESSION_IDLE_DAYS} days, got ${daysAhead}`,
    );

    // The row, not only the answer: the value is computed by PostgreSQL, and
    // the response is only a report of it.
    assert.ok(Math.abs((await expiresAt(body.id)).getTime() - Date.parse(body.expiresAt)) < 1);

    // No lifetime: the window slides, as it did before one could be given
    // (D220).
    const ends = await storedEnds(body.id);

    assert.equal(ends.lifetime_ends_at, null);
    assert.equal(ends.lifetime, SESSION_IDLE_DAYS * 86_400);
  });

  it('creates a different id every time', async () => {
    const first = await createSession();
    const second = await createSession();

    assert.notEqual(first.id, second.id);
  });
});

/**
 * The one-click path. It is listed on its own because it is the regression this
 * release could most easily cause: the exemption from `1007` is the conjunction
 * of no body and no `Content-Type`, and neither half alone earns it (D104).
 */
describe('POST /api/sessions — the bodyless create', () => {
  it('creates a default session when sent with content-length: 0', async () => {
    // What the browser sends for the frontend's one-click create.
    const response = await sendRawRequest(
      [
        'POST /api/sessions HTTP/1.1',
        'Host: qa-tools.ru',
        'Content-Length: 0',
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
    );

    assert.equal(rawStatus(response), 201);

    const { id } = JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as { id: string };
    createdSessionIds.push(id);

    assert.equal((await storedConfig(id)).response_status, null);
  });

  it('creates a default session when sent with no content-length at all', async () => {
    const response = await sendRawRequest(
      ['POST /api/sessions HTTP/1.1', 'Host: qa-tools.ru', 'Connection: close', '', ''].join(
        '\r\n',
      ),
    );

    assert.equal(rawStatus(response), 201);

    const { id } = JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as { id: string };
    createdSessionIds.push(id);

    assert.equal((await storedConfig(id)).response_status, null);
  });
});

describe('POST /api/sessions — media type (1007)', () => {
  it('rejects a body declared text/plain, which is accepted today', async () => {
    const inserts = sessionInserts;
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'text/plain' },
      payload: '{"response":{"status":201}}',
    });

    await assertRejected(response, 415, 1007, inserts, 'text/plain');
    // The create route's own wording, asserted whole. `assertRejected` checks
    // the status and the code only, so without this nothing here would notice
    // the create route starting to answer the root handler's endpoint-neutral
    // 'Unsupported Media Type' instead (D104).
    assert.deepEqual(response.json(), {
      errorCode: 1007,
      message: 'Content-Type must be application/json',
    });
  });

  it('rejects an empty request declaring a non-JSON media type', async () => {
    // The corner a natural implementation gets wrong: no body is not enough,
    // the exemption needs no Content-Type either (D104).
    const inserts = sessionInserts;
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'text/plain' },
      payload: '',
    });

    await assertRejected(response, 415, 1007, inserts, 'empty text/plain');
  });

  it('rejects application/x-www-form-urlencoded, which answers 500 today', async () => {
    const inserts = sessionInserts;
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'response=x',
    });

    await assertRejected(response, 415, 1007, inserts, 'urlencoded');
  });

  it('rejects a body sent with no content-type at all', async () => {
    const inserts = sessionInserts;
    const body = '{"response":{"status":201}}';
    const response = await sendRawRequest(
      [
        'POST /api/sessions HTTP/1.1',
        'Host: qa-tools.ru',
        `Content-Length: ${body.length}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'),
    );

    assert.equal(rawStatus(response), 415);
    assert.equal(rawErrorCode(response), 1007);
    assert.equal(sessionInserts, inserts);
  });

  /**
   * The receiver captures a Content-Type that is not a media type (D138); the
   * create route does not, and keeps its own wording for it. Sent over a socket
   * so that the empty value is really on the wire.
   */
  for (const headerLine of [
    'Content-Type: json',
    'Content-Type:',
    'Content-Type: application/',
    'Content-Type: a/b/c',
  ]) {
    it(`rejects a header that is not a media type: ${headerLine}`, async () => {
      const inserts = sessionInserts;
      const body = '{"response":{"status":201}}';
      const response = await sendRawRequest(
        [
          'POST /api/sessions HTTP/1.1',
          'Host: qa-tools.ru',
          headerLine,
          `Content-Length: ${body.length}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'),
      );

      assert.equal(rawStatus(response), 415);
      assert.deepEqual(JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)), {
        errorCode: 1007,
        message: 'Content-Type must be application/json',
      });
      assert.equal(sessionInserts, inserts);
    });
  }

  for (const [description, first, second] of [
    ['json then text', 'application/json', 'text/plain'],
    ['text then json', 'text/plain', 'application/json'],
    ['two identical json declarations', 'application/json', 'application/json'],
  ]) {
    it(`rejects more than one content-type header: ${description}`, async () => {
      const inserts = sessionInserts;
      const body = '{"response":{"status":201}}';
      const response = await sendRawRequest(
        [
          'POST /api/sessions HTTP/1.1',
          'Host: qa-tools.ru',
          `Content-Type: ${first}`,
          `Content-Type: ${second}`,
          `Content-Length: ${body.length}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'),
      );

      assert.equal(rawStatus(response), 415);
      assert.equal(rawErrorCode(response), 1007);
      assert.equal(sessionInserts, inserts);
    });
  }

  it('rejects a chunked create with no content-type', async () => {
    const inserts = sessionInserts;
    const body = '{"response":{"status":201}}';
    const response = await sendRawRequest(
      [
        'POST /api/sessions HTTP/1.1',
        'Host: qa-tools.ru',
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        body.length.toString(16),
        body,
        '0',
        '',
        '',
      ].join('\r\n'),
    );

    assert.equal(rawStatus(response), 415);
    assert.equal(rawErrorCode(response), 1007);
    assert.equal(sessionInserts, inserts);
  });

  it('accepts a chunked create declaring application/json', async () => {
    // The control: a transfer encoding bears on framing, never on the media
    // type, so this is an ordinary declared-JSON request.
    const body = '{"response":{"status":201}}';
    const response = await sendRawRequest(
      [
        'POST /api/sessions HTTP/1.1',
        'Host: qa-tools.ru',
        'Content-Type: application/json',
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        body.length.toString(16),
        body,
        '0',
        '',
        '',
      ].join('\r\n'),
    );

    assert.equal(rawStatus(response), 201);

    const { id } = JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as { id: string };
    createdSessionIds.push(id);

    assert.equal((await storedConfig(id)).response_status, 201);
  });

  for (const contentType of ['Application/JSON', 'application/json; charset=utf-8']) {
    it(`accepts the media type declared as ${contentType}`, async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { 'content-type': contentType },
        payload: '{"response":{"status":201}}',
      });

      assert.equal(response.statusCode, 201);
      createdSessionIds.push(response.json<{ id: string }>().id);
    });
  }
});

describe('POST /api/sessions — the media type is checked before the size', () => {
  const oversized = `{"response":{"status":200,"body":"${'a'.repeat(MAX_BODY_BYTES)}"}}`;
  const beyondDrainLimit = `{"response":{"status":200,"body":"${'a'.repeat(MAX_REFUSAL_DRAIN_BYTES)}"}}`;

  it('answers 413 for an oversized body declared application/json', async () => {
    const inserts = sessionInserts;
    const response = await createWith(oversized);

    await assertRejected(response, 413, 1004, inserts, 'oversized json');
  });

  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
    it(`answers 415 for an oversized body declared ${contentType}`, async () => {
      // text/plain is the deliberate change: it answers 413 / 1004 today.
      const inserts = sessionInserts;
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { 'content-type': contentType },
        payload: oversized,
      });

      await assertRejected(response, 415, 1007, inserts, `oversized ${contentType}`);
    });
  }

  it('answers 415 for an oversized body with no content-type', async () => {
    // This is the one case that cannot go through `app.inject`: only a real
    // socket can declare an oversized body and then stop short of sending it.
    // If the route ever regressed to checking size before media type, this
    // would most likely still fail on the status assertion — Fastify compares
    // `Content-Length` against `bodyLimit` up front, so it would answer 413 /
    // 1004 without waiting for bytes. But it would fail on the 5 s bound
    // instead if it did wait, because this client never finishes the body. A
    // timeout here means the regression, not a broken helper.
    //
    // The declared body is past the drain limit as well as the body limit, so
    // this is the refusal answered at once, with the body unread (D143). The
    // same bound therefore also catches a server that drained past the limit.
    const inserts = sessionInserts;
    const response = await sendOversizedRequest(
      [
        'POST /api/sessions HTTP/1.1',
        'Host: qa-tools.ru',
        `Content-Length: ${beyondDrainLimit.length}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
      beyondDrainLimit,
    );

    assert.equal(rawStatus(response), 415);
    assert.equal(rawErrorCode(response), 1007);
    assert.equal(sessionInserts, inserts);
  });

  // The case the prefix above steers around, and the one issue #12 is about:
  // all of the body, on a connection Node ends once it has answered. The
  // refusal is decided before the body is read (D104); if the server answered
  // and closed with the body still arriving, the close would be a reset and
  // this client would read nothing. The body is within the drain limit, so the
  // server reads and discards it before answering (D143). The whole of it has
  // to be sent: the server waits for it. Node ends the connection for two
  // reasons, and each has its own test: `Connection: close`, and an HTTP/1.0
  // request that does not ask for keep-alive.
  for (const [description, requestLine, connection] of [
    [
      'a client that writes an oversized body in full and closes',
      'HTTP/1.1',
      ['Connection: close'],
    ],
    ['an HTTP/1.0 client that writes an oversized body in full', 'HTTP/1.0', []],
  ] as const) {
    it(`delivers the 415 to ${description}`, async () => {
      const inserts = sessionInserts;
      const head = [
        `POST /api/sessions ${requestLine}`,
        'Host: qa-tools.ru',
        `Content-Length: ${oversized.length}`,
        ...connection,
        '',
        '',
      ].join('\r\n');
      const response = await readRawExchange((socket) => {
        socket.write(head);
        void writeInChunks(socket, oversized);
      }, 5_000);

      assert.equal(rawStatus(response), 415);
      assert.equal(rawErrorCode(response), 1007);
      assert.equal(sessionInserts, inserts);
    });
  }
});

describe('POST /api/sessions — the request body (1006)', () => {
  for (const [description, payload] of [
    ['an empty body', ''],
    ['an unparseable body', '{"response":'],
    ['an array', '[]'],
    ['a string', '"abc"'],
    ['a null', 'null'],
    ['a number', '123'],
  ]) {
    it(`answers 400 / 1006 for ${description}`, async () => {
      const inserts = sessionInserts;
      const response = await createWith(payload as string);

      await assertRejected(response, 400, 1006, inserts, description as string);
    });
  }

  it("answers with the create route's own message, asserted whole (D104)", async () => {
    // The same reason as the 1007 case above: the wording has to be pinned
    // somewhere, or the root handler's message could quietly replace it.
    const response = await createWith('{"response":');

    assert.deepEqual(response.json(), {
      errorCode: 1006,
      message: 'Request body must be a JSON object',
    });
  });
});

describe('POST /api/sessions — the response configuration (1005)', () => {
  const cases: [string, string][] = [
    ['status below 200', '{"response":{"status":199}}'],
    ['status 101', '{"response":{"status":101}}'],
    ['status above 599', '{"response":{"status":600}}'],
    ['a non-integer status', '{"response":{"status":200.5}}'],
    ['a status that is not a number', '{"response":{"status":"200"}}'],
    ['a null status', '{"response":{"status":null}}'],
    ['no status at all', '{"response":{}}'],
    ['a body with 204', '{"response":{"status":204,"body":"{\\"a\\":1}"}}'],
    ['a body with 205', '{"response":{"status":205,"body":"{\\"a\\":1}"}}'],
    ['a body with 304', '{"response":{"status":304,"body":"{\\"a\\":1}"}}'],
    [
      '21 headers',
      JSON.stringify({
        response: {
          status: 200,
          headers: Array.from({ length: 21 }, (_unused, index) => ['x-pad', String(index)]),
        },
      }),
    ],
    [
      'a header name over 128 bytes',
      JSON.stringify({ response: { status: 200, headers: [['x'.repeat(129), 'v']] } }),
    ],
    [
      'a header name outside the token charset',
      JSON.stringify({ response: { status: 200, headers: [['x trace', 'v']] } }),
    ],
    [
      'a header value over 1024 bytes',
      JSON.stringify({ response: { status: 200, headers: [['x-trace', 'v'.repeat(1025)]] } }),
    ],
    [
      'a header value containing CR',
      JSON.stringify({ response: { status: 200, headers: [['x-trace', 'a\rb']] } }),
    ],
    [
      'a header value containing LF',
      JSON.stringify({ response: { status: 200, headers: [['x-trace', 'a\nb']] } }),
    ],
    [
      'a header block over 8192 bytes',
      JSON.stringify({
        response: {
          status: 200,
          // Nine pairs of 1012 bytes each: inside every per-pair limit, over
          // the block budget.
          headers: Array.from({ length: 9 }, () => ['x-pad-01', 'v'.repeat(1000)]),
        },
      }),
    ],
    ['headers that are not an array', '{"response":{"status":200,"headers":{}}}'],
    ['a null headers', '{"response":{"status":200,"headers":null}}'],
    ['a header pair that is not two strings', '{"response":{"status":200,"headers":[["x-a",1]]}}'],
    [
      'a body over 65536 bytes',
      JSON.stringify({ response: { status: 200, body: JSON.stringify('a'.repeat(65536)) } }),
    ],
    // A raw U+0000, written in the request as the JSON escape of the character
    // itself: the body holds the NUL, which the TEXT column cannot (D179).
    ['a body containing U+0000', '{"response":{"status":200,"body":"a\\u0000b"}}'],
    [
      'a JSON body containing U+0000',
      '{"response":{"status":200,"body":"{\\"a\\":\\"\\u0000\\"}"}}',
    ],
    ['a body that is not a string', '{"response":{"status":200,"body":123}}'],
    ['a negative delayMs', '{"response":{"status":200,"delayMs":-1}}'],
    ['a delayMs over 30000', '{"response":{"status":200,"delayMs":30001}}'],
    ['a non-integer delayMs', '{"response":{"status":200,"delayMs":1.5}}'],
    ['a null delayMs', '{"response":{"status":200,"delayMs":null}}'],
    ['an unknown key inside response', '{"response":{"status":200,"delay":500}}'],
    ['an unknown key beside response', '{"response":{"status":200},"responce":{}}'],
    ['an explicit null response', '{"response":null}'],
  ];

  for (const [description, payload] of cases) {
    it(`answers 400 / 1005 for ${description}`, async () => {
      const inserts = sessionInserts;
      const response = await createWith(payload);

      await assertRejected(response, 400, 1005, inserts, description);
    });
  }

  it('names the field that broke a rule without echoing its value (D106)', async () => {
    const secret = 'v'.repeat(1025);
    const response = await createWith(
      JSON.stringify({ response: { status: 200, headers: [['x-trace', secret]] } }),
    );

    const { message } = response.json<{ message: string }>();

    assert.ok(message.includes('response.headers'), `unhelpful message: ${message}`);
    assert.equal(message.includes(secret), false, 'the rejected value was echoed back');
  });

  it('names the field for a delay outside the range (D106)', async () => {
    const response = await createWith('{"response":{"status":200,"delayMs":30001}}');

    assert.ok(response.json<{ message: string }>().message.includes('response.delayMs'));
  });

  it('rejects every reserved header name, whatever its case, with a 3xx as with 200', async () => {
    for (const status of [200, 302]) {
      for (const name of [...RESERVED_RESPONSE_HEADERS, 'X-QA-Tools-Anything']) {
        for (const spelling of [name, name.toUpperCase()]) {
          const inserts = sessionInserts;
          const response = await createWith(
            JSON.stringify({ response: { status, headers: [[spelling, '/s/x']] } }),
          );

          await assertRejected(response, 400, 1005, inserts, `${spelling} with ${status}`);
        }
      }
    }
  });

  it('rejects Refresh with 302, named literally (D247)', async () => {
    // The loop above cannot fail if the name leaves RESERVED_RESPONSE_HEADERS;
    // this one can. Refresh stays reserved on a redirect too.
    for (const name of ['Refresh', 'refresh']) {
      const inserts = sessionInserts;
      const response = await createWith(
        JSON.stringify({ response: { status: 302, headers: [[name, '0; url=/s/x/after']] } }),
      );

      await assertRejected(response, 400, 1005, inserts, name);
    }
  });

  it('rejects Location with every status outside 300 to 399, naming the field and quoting nothing (D247)', async () => {
    const marker = 'MARKER-168';

    for (const status of [200, 201, 204, 299, 400, 500, 599]) {
      const inserts = sessionInserts;
      const response = await createWith(
        JSON.stringify({
          response: { status, headers: [['Location', `/s/${marker}/after`]] },
        }),
      );

      await assertRejected(response, 400, 1005, inserts, String(status));

      const { message } = response.json<{ message: string }>();

      assert.equal(
        message,
        'response.headers[0] Location is allowed only when response.status is from 300 to 399',
      );
      assert.equal(message.includes(marker), false, 'the rejected value was echoed back');
    }
  });

  it('rejects a Location target that is not a path under /s/ (D247)', async () => {
    for (const target of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/\t/evil.example',
      ' /s/x',
      '/S/x',
      's/x',
      'javascript:alert(1)',
      'data:text/html,x',
      'https://hook.qa-tools.ru@evil.example/',
      '',
    ]) {
      const inserts = sessionInserts;
      const response = await createWith(
        JSON.stringify({ response: { status: 302, headers: [['Location', target]] } }),
      );

      await assertRejected(response, 400, 1005, inserts, JSON.stringify(target));
      assert.equal(
        response.json<{ message: string }>().message,
        'response.headers[0] value of Location must be a path beginning with /s/',
        JSON.stringify(target),
      );
    }
  });

  it('rejects Content-Security-Policy-Report-Only, named literally (D101)', async () => {
    // The loop above cannot fail if the name leaves RESERVED_RESPONSE_HEADERS;
    // this one can. The title case also exercises the case-insensitive compare.
    const inserts = sessionInserts;
    const response = await createWith(
      JSON.stringify({
        response: {
          status: 200,
          headers: [
            ['Content-Security-Policy-Report-Only', 'report-uri https://collector.example'],
          ],
        },
      }),
    );

    await assertRejected(response, 400, 1005, inserts, 'Content-Security-Policy-Report-Only');
  });

  it('rejects Content-Security-Policy, named literally (D179)', async () => {
    // The loop above cannot fail if the name leaves RESERVED_RESPONSE_HEADERS;
    // this one can. The receiver's sandbox policy must not be replaceable.
    for (const name of ['Content-Security-Policy', 'content-security-policy']) {
      const inserts = sessionInserts;
      const response = await createWith(
        JSON.stringify({ response: { status: 200, headers: [[name, 'sandbox allow-scripts']] } }),
      );

      await assertRejected(response, 400, 1005, inserts, name);
    }
  });

  it('keeps refusing a non-empty body with 204, 205 and 304, whatever it holds (D179)', async () => {
    for (const status of [204, 205, 304]) {
      for (const body of [' ', 'OK', '{"a":']) {
        const inserts = sessionInserts;
        const response = await createWith(JSON.stringify({ response: { status, body } }));

        await assertRejected(
          response,
          400,
          1005,
          inserts,
          `${status} with ${JSON.stringify(body)}`,
        );
      }
    }
  });

  it('counts the body limit in bytes rather than characters', async () => {
    // 40002 characters either way: the multi-byte one encodes to 80002 bytes.
    const multiByte = JSON.stringify('é'.repeat(40000));
    const ascii = JSON.stringify('a'.repeat(40000));

    assert.equal(multiByte.length, ascii.length);

    const inserts = sessionInserts;
    const rejected = await createWith(
      JSON.stringify({ response: { status: 200, body: multiByte } }),
    );

    await assertRejected(rejected, 400, 1005, inserts, 'multi-byte body');

    const accepted = await createWith(JSON.stringify({ response: { status: 200, body: ascii } }));

    assert.equal(accepted.statusCode, 201);
    createdSessionIds.push(accepted.json<{ id: string }>().id);
  });
});

describe('POST /api/sessions — templates (D251, criterion 7)', () => {
  /** What could be read as placeholders, every body of it accepted before 1.9.0. */
  const BRACES = ['{"id":"{{request.id}}"}', '{{', 'a }} b', '${x}', '{{ nope }}', '{{1+1}}'];

  it('takes, with the flag absent or false, every body it took before, and reads it back as no template', async () => {
    for (const body of BRACES) {
      for (const flag of [{}, { template: false }]) {
        const response = await createWith(
          JSON.stringify({ response: { status: 200, body, ...flag } }),
        );

        assert.equal(response.statusCode, 201, response.body);

        const { id } = response.json<{ id: string }>();

        createdSessionIds.push(id);

        const read = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });
        const config = read.json<{ response: ResponseConfig }>().response;

        assert.equal(config.body, body);
        assert.equal(config.template, false);
      }
    }
  });

  it('takes a template and stores its flag beside the response', async () => {
    const response = await createWith(
      JSON.stringify({
        response: { status: 201, body: '{"id":"{{request.id}}"}', template: true },
      }),
    );

    assert.equal(response.statusCode, 201, response.body);

    const { id } = response.json<{ id: string }>();

    createdSessionIds.push(id);

    const stored = await pool.query<{ response_template: boolean | null }>(
      'SELECT response_template FROM sessions WHERE id = $1',
      [id],
    );

    assert.equal(stored.rows[0]?.response_template, true);

    const bare = await createWith('{"response":{"status":200}}');
    const { id: bareId } = bare.json<{ id: string }>();

    createdSessionIds.push(bareId);

    const read = await app.inject({ method: 'GET', url: `/api/sessions/${bareId}` });

    assert.equal(read.json<{ response: ResponseConfig }>().response.template, false);
  });

  it('refuses a template whose placeholders break the grammar, or a flag that is no boolean, 1005, creating nothing and quoting nothing', async () => {
    for (const [description, response] of [
      ['an unknown placeholder', { status: 200, body: '{{request.MARKER}}', template: true }],
      ['an unclosed placeholder', { status: 200, body: '{{request.id}}{{MARKER', template: true }],
      ['a space inside the braces', { status: 200, body: '{{ MARKER }}', template: true }],
      ['a flag that is a string', { status: 200, body: 'MARKER', template: 'true' }],
      ['a null flag', { status: 200, body: 'MARKER', template: null }],
    ] as const) {
      const inserts = sessionInserts;
      const answer = await createWith(JSON.stringify({ response }));

      await assertRejected(answer, 400, 1005, inserts, description);
      assert.equal(answer.json<{ message: string }>().message.includes('MARKER'), false);
    }
  });
});

describe('POST /api/sessions — accepted configurations', () => {
  it('accepts Location on a 302 with a path under /s/, and reads it back (D247)', async () => {
    const created = await createWith('{"response":{"status":302}}');
    const { id: target } = created.json<{ id: string }>();

    createdSessionIds.push(target);

    const response = await createWith(
      JSON.stringify({
        response: {
          status: 302,
          headers: [
            ['Location', `/s/${target}/after`],
            ['x-trace', 'abc'],
            ['location', `/s/${target}/second`],
          ],
        },
      }),
    );

    assert.equal(response.statusCode, 201, response.body);

    const { id } = response.json<{ id: string }>();
    createdSessionIds.push(id);

    const read = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });

    assert.deepEqual(read.json<{ response: ResponseConfig }>().response.headers, [
      ['Location', `/s/${target}/after`],
      ['x-trace', 'abc'],
      ['location', `/s/${target}/second`],
    ]);
  });

  it('accepts Location with 300, 301, 302, 303, 307, 308 and 399, its name in any case (D247)', async () => {
    const spellings = ['Location', 'location', 'LOCATION', 'lOcAtIoN'];

    for (const [index, status] of [300, 301, 302, 303, 307, 308, 399].entries()) {
      const name = spellings[index % spellings.length] as string;
      const response = await createWith(
        JSON.stringify({ response: { status, headers: [[name, '/s/x/after']] } }),
      );

      assert.equal(response.statusCode, 201, `${status} ${name}: ${response.body}`);

      const { id } = response.json<{ id: string }>();
      createdSessionIds.push(id);

      assert.deepEqual((await storedConfig(id)).response_headers, [[name, '/s/x/after']]);
    }
  });

  it('accepts Content-Location with any status and any value, as before (D247)', async () => {
    for (const status of [200, 302]) {
      const response = await createWith(
        JSON.stringify({
          response: { status, headers: [['Content-Location', 'https://evil.example/']] },
        }),
      );

      assert.equal(response.statusCode, 201, response.body);
      createdSessionIds.push(response.json<{ id: string }>().id);
    }
  });

  it('stores the documented defaults for a status-only configuration', async () => {
    const response = await createWith('{"response":{"status":200}}');

    assert.equal(response.statusCode, 201);

    const { id } = response.json<{ id: string }>();
    createdSessionIds.push(id);

    assert.deepEqual(await storedConfig(id), {
      response_status: 200,
      response_headers: [],
      response_body: null,
      response_delay_ms: 0,
    });
  });

  it('treats an empty JSON object as a default session', async () => {
    // It parses, it is an object, it has no unknown key and no `response`: the
    // boundary between 1006, 1005 and success (D106).
    const response = await createWith('{}');

    assert.equal(response.statusCode, 201);

    const { id } = response.json<{ id: string }>();
    createdSessionIds.push(id);

    assert.equal((await storedConfig(id)).response_status, null);
    // Nor does it give a lifetime (D220).
    assert.equal((await storedEnds(id)).lifetime_ends_at, null);
  });

  it('accepts an explicit null body, which is what GET returns', async () => {
    const response = await createWith('{"response":{"status":200,"body":null}}');

    assert.equal(response.statusCode, 201);

    const { id } = response.json<{ id: string }>();
    createdSessionIds.push(id);

    assert.equal((await storedConfig(id)).response_body, null);
  });

  // The six characters of a JSON `\u0000` escape are text to the TEXT column;
  // only jsonb would refuse them, and the body is never cast to it (D179).
  for (const body of ['{"a":', "{'a':1}", 'OK', ' ', '{"a":"\\u0000"}']) {
    it(`accepts and stores exactly the body ${JSON.stringify(body)} (D179)`, async () => {
      const response = await createWith(JSON.stringify({ response: { status: 200, body } }));

      assert.equal(response.statusCode, 201, response.body);

      const { id } = response.json<{ id: string }>();
      createdSessionIds.push(id);

      assert.equal((await storedConfig(id)).response_body, body);

      const read = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });

      assert.equal(read.json<{ response: ResponseConfig }>().response.body, body);
    });
  }

  it('saves an empty body as no body, with any status (D179)', async () => {
    for (const status of [200, 204, 205, 304]) {
      const response = await createWith(JSON.stringify({ response: { status, body: '' } }));

      assert.equal(response.statusCode, 201, `${status}: ${response.body}`);

      const { id } = response.json<{ id: string }>();
      createdSessionIds.push(id);

      assert.equal((await storedConfig(id)).response_body, null, String(status));

      const read = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });

      assert.equal(read.json<{ response: ResponseConfig }>().response.body, null, String(status));
    }
  });

  it('accepts a configured Content-Type with any value the header rules accept (D179)', async () => {
    const headers: [string, string][] = [
      ['Content-Type', 'text/plain'],
      ['content-type', 'text/html; charset=windows-1251'],
      ['CONTENT-TYPE', 'not a media type'],
      ['Content-Type', ''],
    ];
    const response = await createWith(
      JSON.stringify({ response: { status: 200, headers, body: 'OK' } }),
    );

    assert.equal(response.statusCode, 201, response.body);

    const { id } = response.json<{ id: string }>();
    createdSessionIds.push(id);

    assert.deepEqual((await storedConfig(id)).response_headers, headers);
  });

  it('accepts an empty header value, which RFC 9110 permits', async () => {
    const response = await createWith('{"response":{"status":200,"headers":[["x-trace-id",""]]}}');

    assert.equal(response.statusCode, 201);

    const { id } = response.json<{ id: string }>();
    createdSessionIds.push(id);

    assert.deepEqual((await storedConfig(id)).response_headers, [['x-trace-id', '']]);
  });

  it('accepts duplicate header names and keeps their order (D045)', async () => {
    const response = await createWith(
      '{"response":{"status":200,"headers":[["x-a","1"],["X-A","2"]]}}',
    );

    assert.equal(response.statusCode, 201);

    const { id } = response.json<{ id: string }>();
    createdSessionIds.push(id);

    assert.deepEqual((await storedConfig(id)).response_headers, [
      ['x-a', '1'],
      ['X-A', '2'],
    ]);
  });

  for (const status of [299, 512]) {
    it(`accepts the unregistered status ${status}`, async () => {
      const response = await createWith(`{"response":{"status":${status}}}`);

      assert.equal(response.statusCode, 201);

      const { id } = response.json<{ id: string }>();
      createdSessionIds.push(id);

      assert.equal((await storedConfig(id)).response_status, status);
    });
  }

  it('accepts a header block just under the budget, ignoring the receiver own headers', async () => {
    // 20 pairs of 409 bytes: 8180 of the 8192, with the receiver's own
    // Content-Type, X-Content-Type-Options, Content-Security-Policy,
    // X-Webhook-Inspector-Request-Id and X-QA-Tools-Request-Id outside the
    // budget entirely.
    const headers = Array.from({ length: 20 }, () => ['x-pad-01', 'v'.repeat(397)]);
    const response = await createWith(JSON.stringify({ response: { status: 200, headers } }));

    assert.equal(response.statusCode, 201);
    createdSessionIds.push(response.json<{ id: string }>().id);
  });

  it('accepts a body of exactly 65536 bytes', async () => {
    const body = JSON.stringify('a'.repeat(65534));

    assert.equal(Buffer.byteLength(body), 65536);

    const response = await createWith(JSON.stringify({ response: { status: 200, body } }));

    assert.equal(response.statusCode, 201);
    createdSessionIds.push(response.json<{ id: string }>().id);
  });
});

/**
 * A lifetime at creation (D220, issue #129): `expiresInSeconds`, 60 to
 * 604800, fixes the session's end at creation. What a use does to such a
 * session, its expiry and the previous image are in `session-lifetime.test.ts`.
 */
describe('POST /api/sessions — a lifetime (D220)', () => {
  /** Creates with `payload` and answers the session, its answer and the time around the call. */
  async function createTimed(payload: string): Promise<{
    id: string;
    expiresAt: string;
    sentAt: number;
    answeredAt: number;
  }> {
    const sentAt = Date.now();
    const response = await createWith(payload);
    const answeredAt = Date.now();

    assert.equal(response.statusCode, 201, response.body);

    const body = response.json<{ id: string; expiresAt: string; receiveUrl: string }>();

    createdSessionIds.push(body.id);
    assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'id', 'private', 'receiveUrl']);

    return { id: body.id, expiresAt: body.expiresAt, sentAt, answeredAt };
  }

  it('creates a default session that expires that many seconds after its creation, as GET reads it (criterion 1)', async () => {
    const created = await createTimed('{"expiresInSeconds":600}');
    const expires = Date.parse(created.expiresAt);

    // Within 2 s of creation + 600 s, whichever moment of the call created it.
    assert.ok(expires >= created.sentAt + 600_000 - 2_000, created.expiresAt);
    assert.ok(expires <= created.answeredAt + 600_000 + 2_000, created.expiresAt);

    // In the row, exactly: both ends 600 s after its creation, to the
    // microsecond, and the answer a report of them.
    const ends = await storedEnds(created.id);

    assert.equal(ends.lifetime, 600);
    assert.equal(ends.lifetime_ends_at, ends.expires_at);
    assert.equal((await expiresAt(created.id)).getTime(), expires);

    // A default session: no response, no queue.
    const read = await app.inject({ method: 'GET', url: `/api/sessions/${created.id}` });

    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), {
      id: created.id,
      expiresAt: created.expiresAt,
      receiveUrl: `http://127.0.0.1:3001/s/${created.id}`,
      requestsCount: 0,
      // A fixed end, no window (D242): the end is `expiresAt`.
      expiresAfterIdleSeconds: null,
      lifetimeEndsAt: created.expiresAt,
      storeSourceIp: true,
      private: false,
      response: null,
      customResponse: null,
      queue: null,
      rules: [],
    });
    assert.equal((await storedConfig(created.id)).response_status, null);
  });

  it('takes 60 and 604800, alone and beside a response and a queue (criterion 2)', async () => {
    const response = {
      status: 201,
      headers: [['x-trace', 'a']],
      body: 'ok',
      delayMs: 0,
      template: false,
    };
    const queue = { steps: [{ status: 503 }] };

    for (const seconds of [60, 604_800]) {
      for (const rest of [{}, { response }, { queue }, { response, queue }]) {
        const payload = JSON.stringify({ ...rest, expiresInSeconds: seconds });
        const created = await createTimed(payload);
        const ends = await storedEnds(created.id);

        assert.equal(ends.lifetime, seconds, payload);
        assert.equal(ends.lifetime_ends_at, ends.expires_at, payload);

        const read = (
          await app.inject({ method: 'GET', url: `/api/sessions/${created.id}` })
        ).json<{ expiresAt: string; response: unknown; queue: { total: number } | null }>();

        assert.equal(read.expiresAt, created.expiresAt, payload);
        assert.deepEqual(read.response, 'response' in rest ? response : null, payload);
        assert.equal(read.queue?.total ?? null, 'queue' in rest ? 1 : null, payload);
      }
    }
  });

  it('takes a JSON number equal to an integer however it is written', async () => {
    for (const written of ['6e2', '600.0', '6.0E+2']) {
      const created = await createTimed(`{"expiresInSeconds":${written}}`);

      assert.equal((await storedEnds(created.id)).lifetime, 600, written);
    }
  });

  const refused: [string, string][] = [
    ['a string', '"600"'],
    ['null', 'null'],
    ['true', 'true'],
    ['false', 'false'],
    ['an array', '[600]'],
    ['an object', '{"seconds":600}'],
    ['59', '59'],
    ['604801', '604801'],
    ['0', '0'],
    ['a negative number', '-600'],
    ['a fraction', '600.5'],
    ['1e400', '1e400'],
    ['-1e400', '-1e400'],
  ];

  for (const [description, written] of refused) {
    it(`answers 400 / 1005 for ${description}, names the field without the value and creates nothing (criterion 2)`, async () => {
      for (const rest of [
        '',
        '"response":{"status":200},',
        '"queue":{"steps":[{"status":503}]},',
      ]) {
        const inserts = sessionInserts;
        const response = await createWith(`{${rest}"expiresInSeconds":${written}}`);

        await assertRejected(response, 400, 1005, inserts, `${description} beside ${rest}`);

        const { message } = response.json<{ message: string }>();

        assert.ok(
          message.startsWith('expiresInSeconds must be an integer from 60 to 604800'),
          message,
        );
        assert.equal(
          message.endsWith('; omit it for a session that expires 7 days after its last use'),
          written === 'null',
          message,
        );

        // Not the value: the rule's own numbers are the only digits in it,
        // and `0` is inside its `60`.
        if (written !== '0') {
          assert.equal(message.includes(written), false, `${message} echoes ${written}`);
        }
      }
    });
  }

  it('reports a broken response, then a broken queue, before a broken lifetime, and a lifetime before an unknown key', async () => {
    const cases: [string, string][] = [
      ['{"expiresInSeconds":5,"response":{"status":99}}', 'response.status is required'],
      ['{"expiresInSeconds":5,"queue":{"steps":[]}}', 'queue.steps must contain'],
      ['{"other":1,"expiresInSeconds":5}', 'expiresInSeconds must be an integer'],
      [
        '{"expiresInSeconds":600,"other":1}',
        'The request body may contain no key other than "response", "queue", "expiresInSeconds", "expiresAfterIdleSeconds", "storeSourceIp", "rules" and "private"',
      ],
    ];

    for (const [payload, start] of cases) {
      const inserts = sessionInserts;
      const response = await createWith(payload);

      await assertRejected(response, 400, 1005, inserts, payload);
      assert.ok(response.json<{ message: string }>().message.startsWith(start), payload);
    }
  });

  it('still takes no lifetime without Content-Type: application/json (D104)', async () => {
    const inserts = sessionInserts;
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'text/plain' },
      payload: '{"expiresInSeconds":600}',
    });

    await assertRejected(response, 415, 1007, inserts, 'text/plain');
  });
});

/**
 * An idle window at creation (D242, issue #158): `expiresAfterIdleSeconds`,
 * 3600 to 604800, the window the session then slides by instead of 7 days.
 * What the parser takes and refuses, without a server, is in
 * `idle-window-body.test.ts`; how every use slides it, in
 * `session-lifetime.test.ts`.
 */
describe('POST /api/sessions — an idle window (D242)', () => {
  /** Creates with `payload` and answers the session, its answer and the time around the call. */
  async function createTimed(payload: string | undefined): Promise<{
    id: string;
    expiresAt: string;
    sentAt: number;
    answeredAt: number;
  }> {
    const sentAt = Date.now();
    const response =
      payload === undefined
        ? await app.inject({ method: 'POST', url: '/api/sessions' })
        : await createWith(payload);
    const answeredAt = Date.now();

    assert.equal(response.statusCode, 201, response.body);

    const body = response.json<{ id: string; expiresAt: string; receiveUrl: string }>();

    createdSessionIds.push(body.id);
    // The create answer is unchanged: neither field is added to it.
    assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'id', 'private', 'receiveUrl']);

    return { id: body.id, expiresAt: body.expiresAt, sentAt, answeredAt };
  }

  /** The two fields `GET` adds, in the order it gives them, and its `expiresAt`. */
  async function rule(id: string): Promise<{
    expiresAfterIdleSeconds: unknown;
    lifetimeEndsAt: unknown;
    expiresAt: string;
    keys: string[];
  }> {
    const read = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });

    assert.equal(read.statusCode, 200, read.body);

    const body = read.json<Record<string, unknown>>();

    return {
      expiresAfterIdleSeconds: body.expiresAfterIdleSeconds,
      lifetimeEndsAt: body.lifetimeEndsAt,
      expiresAt: body.expiresAt as string,
      keys: Object.keys(body),
    };
  }

  for (const seconds of [3600, 86_400, 604_800]) {
    it(`creates a session that expires ${seconds} s after its creation and slides by it (criteria 1 and 4)`, async () => {
      const created = await createTimed(`{"expiresAfterIdleSeconds":${seconds}}`);
      const expires = Date.parse(created.expiresAt);

      // Within 2 s of creation + the window, whichever moment of the call created it.
      assert.ok(expires >= created.sentAt + seconds * 1000 - 2_000, created.expiresAt);
      assert.ok(expires <= created.answeredAt + seconds * 1000 + 2_000, created.expiresAt);

      // In the row, exactly: the window after its creation, no lifetime.
      const ends = await storedEnds(created.id);

      assert.equal(ends.lifetime, seconds);
      assert.equal(ends.lifetime_ends_at, null);
      assert.equal((await expiresAt(created.id)).getTime(), expires);

      const read = await rule(created.id);

      assert.deepEqual([read.expiresAfterIdleSeconds, read.lifetimeEndsAt], [seconds, null]);
      // Freshly created, the read is inside the throttle and moves nothing.
      assert.equal(read.expiresAt, created.expiresAt);
    });
  }

  it('gives no body, {} and the bodies of before the 7 days of D133 (criteria 1 and 4)', async () => {
    for (const payload of [
      undefined,
      '{}',
      '{"response":{"status":201}}',
      '{"queue":{"steps":[{"status":503}]}}',
      '{"response":{"status":200},"queue":{"steps":[{"status":503}]}}',
    ]) {
      const created = await createTimed(payload);

      assert.equal((await storedEnds(created.id)).lifetime, 604_800, String(payload));

      const read = await rule(created.id);

      assert.deepEqual(
        [read.expiresAfterIdleSeconds, read.lifetimeEndsAt],
        [604_800, null],
        String(payload),
      );
    }
  });

  it('takes the window beside a response and a queue', async () => {
    const response = {
      status: 201,
      headers: [['x-trace', 'a']],
      body: 'ok',
      delayMs: 0,
      template: false,
    };
    const queue = { steps: [{ status: 503 }] };

    for (const rest of [{ response }, { queue }, { response, queue }]) {
      const payload = JSON.stringify({ ...rest, expiresAfterIdleSeconds: 3600 });
      const created = await createTimed(payload);

      assert.equal((await storedEnds(created.id)).lifetime, 3600, payload);

      const read = (await app.inject({ method: 'GET', url: `/api/sessions/${created.id}` })).json<{
        expiresAfterIdleSeconds: number | null;
        response: unknown;
        queue: { total: number } | null;
      }>();

      assert.equal(read.expiresAfterIdleSeconds, 3600, payload);
      assert.deepEqual(read.response, 'response' in rest ? response : null, payload);
      assert.equal(read.queue?.total ?? null, 'queue' in rest ? 1 : null, payload);
    }
  });

  it('takes a JSON number equal to an integer however it is written, as expiresInSeconds does', async () => {
    for (const written of ['36e2', '3600.0', '3.6E+3']) {
      const created = await createTimed(`{"expiresAfterIdleSeconds":${written}}`);

      assert.equal((await storedEnds(created.id)).lifetime, 3600, written);
      assert.equal((await rule(created.id)).expiresAfterIdleSeconds, 3600, written);
    }
  });

  it('reads a session with a lifetime as its fixed end and no window (criterion 4)', async () => {
    const created = await createTimed('{"expiresInSeconds":600}');
    const read = await rule(created.id);

    assert.deepEqual(
      [read.expiresAfterIdleSeconds, read.lifetimeEndsAt],
      [null, created.expiresAt],
    );
    assert.equal(read.lifetimeEndsAt, read.expiresAt);
    // Both always present, beside every field of before.
    assert.deepEqual(read.keys.sort(), [
      'customResponse',
      'expiresAfterIdleSeconds',
      'expiresAt',
      'id',
      'lifetimeEndsAt',
      'private',
      'queue',
      'receiveUrl',
      'requestsCount',
      'response',
      'rules',
      'storeSourceIp',
    ]);
  });

  const refused: [string, string][] = [
    ['a string', '"3600"'],
    ['null', 'null'],
    ['true', 'true'],
    ['false', 'false'],
    ['an array', '[3600]'],
    ['an object', '{"seconds":3600}'],
    ['a fraction', '3600.5'],
    ['3599', '3599'],
    ['604801', '604801'],
    ['60', '60'],
    ['a negative number', '-3600'],
    ['1e400', '1e400'],
    ['-1e400', '-1e400'],
  ];

  for (const [description, written] of refused) {
    it(`answers 400 / 1005 for ${description}, names the field without the value and creates nothing (criterion 2)`, async () => {
      for (const rest of [
        '',
        '"response":{"status":200},',
        '"queue":{"steps":[{"status":503}]},',
      ]) {
        const inserts = sessionInserts;
        const response = await createWith(`{${rest}"expiresAfterIdleSeconds":${written}}`);

        await assertRejected(response, 400, 1005, inserts, `${description} beside ${rest}`);

        const { message } = response.json<{ message: string }>();

        assert.ok(
          message.startsWith('expiresAfterIdleSeconds must be an integer from 3600 to 604800'),
          message,
        );
        assert.equal(
          message.endsWith('; omit it for a session that expires 7 days after its last use'),
          written === 'null',
          message,
        );

        // Not the value: the rule's own numbers are the only digits in it.
        if (!['3600', '60'].includes(written)) {
          assert.equal(message.includes(written), false, `${message} echoes ${written}`);
        }
      }
    });
  }

  it('refuses the key beside expiresInSeconds, nested or misspelt, and creates nothing (criterion 2)', async () => {
    const together =
      'expiresInSeconds and expiresAfterIdleSeconds cannot be given together: a session either ends a fixed time after its creation or expires a time after its last use';
    const unknown =
      'The request body may contain no key other than "response", "queue", "expiresInSeconds", "expiresAfterIdleSeconds", "storeSourceIp", "rules" and "private"';

    for (const [payload, message] of [
      ['{"expiresInSeconds":600,"expiresAfterIdleSeconds":3600}', together],
      ['{"expiresAfterIdleSeconds":604800,"expiresInSeconds":604800}', together],
      [
        '{"expiresInSeconds":5,"expiresAfterIdleSeconds":3600}',
        'expiresInSeconds must be an integer from 60 to 604800',
      ],
      [
        '{"response":{"status":200,"expiresAfterIdleSeconds":3600}}',
        'response may contain no key other than "status", "headers", "body", "delayMs" and "template"',
      ],
      [
        '{"queue":{"steps":[{"status":503}],"expiresAfterIdleSeconds":3600}}',
        'queue may contain no key other than "steps"',
      ],
      ['{"session":{"expiresAfterIdleSeconds":3600}}', unknown],
      ['{"expiresafteridleseconds":3600}', unknown],
      ['{"expiresAfterIdle":3600}', unknown],
      ['{"expiresAfterIdleSeconds":3600,"other":1}', unknown],
      ['{"__proto__":{"expiresAfterIdleSeconds":3600}}', unknown],
    ] as const) {
      const inserts = sessionInserts;
      const response = await createWith(payload);

      await assertRejected(response, 400, 1005, inserts, payload);
      assert.equal(response.json<{ message: string }>().message, message, payload);
    }
  });

  it('still takes no window without Content-Type: application/json (D104)', async () => {
    const inserts = sessionInserts;
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'text/plain' },
      payload: '{"expiresAfterIdleSeconds":3600}',
    });

    await assertRejected(response, 415, 1007, inserts, 'text/plain');
  });
});

describe('POST /api/sessions — the sender address (D243)', () => {
  /** A sender's address, the receive listener's peer in these tests. */
  const SENDER = '198.51.100.44';

  /** Creates with `payload` and answers the new session's id, its answer unchanged. */
  async function createChoosing(payload: string | undefined): Promise<string> {
    const response =
      payload === undefined
        ? await app.inject({ method: 'POST', url: '/api/sessions' })
        : await createWith(payload);

    assert.equal(response.statusCode, 201, response.body);

    const body = response.json<{ id: string }>();

    createdSessionIds.push(body.id);
    // The create answer is unchanged: the choice is read back by GET.
    assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'id', 'private', 'receiveUrl']);

    return body.id;
  }

  /** The choice as the row holds it and as `GET` gives it, which must agree. */
  async function choice(id: string): Promise<boolean> {
    const stored = await pool.query<{ store_source_ip: boolean }>(
      'SELECT store_source_ip FROM sessions WHERE id = $1',
      [id],
    );
    const read = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });

    assert.equal(read.statusCode, 200, read.body);

    const given = read.json<Record<string, unknown>>();

    assert.ok(Object.hasOwn(given, 'storeSourceIp'), 'GET left storeSourceIp out');
    assert.equal(given.storeSourceIp, stored.rows[0]?.store_source_ip);

    return given.storeSourceIp as boolean;
  }

  /** One webhook from `SENDER` and the address its row stored. */
  async function capturedAddress(id: string): Promise<string | null> {
    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${id}`,
      remoteAddress: SENDER,
      payload: 'x',
    });

    // Whatever the session answers - 201, or 503 from a queue's step - the
    // request was captured.
    assert.equal(typeof response.headers['x-qa-tools-request-id'], 'string', response.body);

    const stored = await pool.query<{ source_ip: string | null }>(
      'SELECT source_ip FROM requests WHERE id = $1',
      [response.headers['x-qa-tools-request-id']],
    );

    assert.equal(stored.rowCount, 1);

    return stored.rows[0]?.source_ip ?? null;
  }

  it('creates a session with storeSourceIp false whose capture keeps no address, GET saying false (criteria 1 and 4)', async () => {
    const id = await createChoosing('{"storeSourceIp":false}');

    assert.equal(await choice(id), false);
    assert.equal(await capturedAddress(id), null);
  });

  it('keeps the address for true, {}, no body and the bodies of before, GET saying true (criteria 1 and 4)', async () => {
    for (const payload of [
      undefined,
      '{}',
      '{"storeSourceIp":true}',
      '{"response":{"status":201}}',
      '{"queue":{"steps":[{"status":503}]}}',
      '{"expiresInSeconds":600}',
      '{"expiresAfterIdleSeconds":3600}',
    ]) {
      const id = await createChoosing(payload);

      assert.equal(await choice(id), true, String(payload));
      assert.equal(await capturedAddress(id), SENDER, String(payload));
    }
  });

  it('takes the choice beside every other key, each kept', async () => {
    const response = {
      status: 201,
      headers: [['x-trace', 'a']],
      body: 'ok',
      delayMs: 0,
      template: false,
    };
    const queue = { steps: [{ status: 503 }] };

    for (const rest of [
      { response },
      { queue },
      { response, queue, expiresInSeconds: 600 },
      { response, queue, expiresAfterIdleSeconds: 3600 },
    ]) {
      const payload = JSON.stringify({ ...rest, storeSourceIp: false });
      const id = await createChoosing(payload);
      const read = (await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json<{
        storeSourceIp: boolean;
        response: unknown;
        queue: { total: number } | null;
        expiresAfterIdleSeconds: number | null;
        lifetimeEndsAt: string | null;
      }>();

      assert.equal(read.storeSourceIp, false, payload);
      assert.deepEqual(read.response, 'response' in rest ? response : null, payload);
      assert.equal(read.queue?.total ?? null, 'queue' in rest ? 1 : null, payload);
      assert.equal(read.lifetimeEndsAt !== null, 'expiresInSeconds' in rest, payload);
      assert.equal(
        read.expiresAfterIdleSeconds,
        'expiresInSeconds' in rest ? null : 'expiresAfterIdleSeconds' in rest ? 3600 : 604_800,
        payload,
      );
    }
  });

  it('takes the last of duplicate keys, as JSON.parse does (criterion 2)', async () => {
    assert.equal(
      await choice(await createChoosing('{"storeSourceIp":true,"storeSourceIp":false}')),
      false,
    );
    assert.equal(
      await choice(await createChoosing('{"storeSourceIp":false,"storeSourceIp":true}')),
      true,
    );
  });

  it('reads a session created before the column as one that keeps the address (criterion 4)', async () => {
    // The base image's insert (1.1.0, `insertSession`), which names no such
    // column: every row before the migration, and every row that image
    // inserts after it, reads the default.
    const id = generateSessionId();

    await pool.query(
      `INSERT INTO sessions
         (id, expires_at, lifetime_ends_at, idle_seconds, response_status, response_headers,
          response_body, response_delay_ms, response_queue, response_queue_answered)
       VALUES ($1,
               COALESCE(now() + make_interval(secs => $9), now() + make_interval(secs => $2::integer)),
               now() + make_interval(secs => $9),
               $2::integer,
               $3, $4::jsonb, $5, $6, $7::jsonb, $8)
       RETURNING id, expires_at, response_queue, response_queue_answered`,
      [id, 604_800, null, null, null, null, null, null, null],
    );
    createdSessionIds.push(id);

    assert.equal(await choice(id), true);
    assert.equal(await capturedAddress(id), SENDER);
  });

  const refused: [string, string][] = [
    ['the string "false"', '"false"'],
    ['the string "true"', '"true"'],
    ['an empty string', '""'],
    ['0', '0'],
    ['1', '1'],
    ['null', 'null'],
    ['an empty array', '[]'],
    ['an array holding false', '[false]'],
    ['an empty object', '{}'],
    ['an object holding false', '{"value":false}'],
    ['1e400', '1e400'],
  ];

  for (const [description, written] of refused) {
    it(`answers 400 / 1005 for ${description}, names the field without the value and creates nothing (criterion 2)`, async () => {
      for (const rest of [
        '',
        '"response":{"status":200},',
        '"queue":{"steps":[{"status":503}]},',
        '"expiresInSeconds":600,',
        '"expiresAfterIdleSeconds":3600,',
      ]) {
        const inserts = sessionInserts;
        const response = await createWith(`{${rest}"storeSourceIp":${written}}`);

        await assertRejected(response, 400, 1005, inserts, `${description} beside ${rest}`);

        const { message } = response.json<{ message: string }>();

        assert.equal(
          message,
          written === 'null'
            ? "storeSourceIp must be true or false; omit it for a session that stores the sender's IP address"
            : 'storeSourceIp must be true or false',
          `${description} beside ${rest}`,
        );
      }
    });
  }

  it('refuses the key nested or misspelt as an unknown key, after every other rule, and creates nothing (criterion 2)', async () => {
    const unknown =
      'The request body may contain no key other than "response", "queue", "expiresInSeconds", "expiresAfterIdleSeconds", "storeSourceIp", "rules" and "private"';

    for (const [payload, message] of [
      [
        '{"response":{"status":200,"storeSourceIp":false}}',
        'response may contain no key other than "status", "headers", "body", "delayMs" and "template"',
      ],
      [
        '{"queue":{"steps":[{"status":503}],"storeSourceIp":false}}',
        'queue may contain no key other than "steps"',
      ],
      ['{"session":{"storeSourceIp":false}}', unknown],
      ['{"store_source_ip":false}', unknown],
      ['{"storeSourceIP":false}', unknown],
      ['{"storeSourceIp":false,"other":1}', unknown],
      ['{"__proto__":{"storeSourceIp":false}}', unknown],
      // A bad value of an earlier key is told first, an unknown key last.
      [
        '{"storeSourceIp":0,"expiresInSeconds":5}',
        'expiresInSeconds must be an integer from 60 to 604800',
      ],
      [
        '{"storeSourceIp":0,"expiresInSeconds":600,"expiresAfterIdleSeconds":3600}',
        'expiresInSeconds and expiresAfterIdleSeconds cannot be given together: a session either ends a fixed time after its creation or expires a time after its last use',
      ],
      ['{"other":1,"storeSourceIp":0}', 'storeSourceIp must be true or false'],
    ] as const) {
      const inserts = sessionInserts;
      const response = await createWith(payload);

      await assertRejected(response, 400, 1005, inserts, payload);
      assert.equal(response.json<{ message: string }>().message, message, payload);
    }
  });

  it('still takes no choice without Content-Type: application/json (D104)', async () => {
    const inserts = sessionInserts;
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'text/plain' },
      payload: '{"storeSourceIp":false}',
    });

    await assertRejected(response, 415, 1007, inserts, 'text/plain');
  });
});

describe('GET /api/sessions/:sessionId', () => {
  it('returns the session with its request count', async () => {
    const created = await createSession();

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${created.id}` });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      id: created.id,
      expiresAt: created.expiresAt,
      receiveUrl: `http://127.0.0.1:3001/s/${created.id}`,
      requestsCount: 0,
      // A session created without a window slides by the 7 days of D133, and
      // says so; it has no fixed end (D242).
      expiresAfterIdleSeconds: 604_800,
      lifetimeEndsAt: null,
      // A session created without `storeSourceIp: false` keeps the sender's
      // address, and says so (D243).
      storeSourceIp: true,
      // A session created without `"private": true` is public (D253).
      private: false,
      // A default session reads back an explicit null rather than an absent
      // key, so a consumer has one shape to render (D101). One that never had
      // a custom response keeps none either (D151), and one without a queue
      // reads `queue: null` (D205), and one without rules `rules: []` (D246).
      response: null,
      customResponse: null,
      queue: null,
      rules: [],
    });
  });

  it('returns every optional field of a configuration at its effective value', async () => {
    const created = await createWith('{"response":{"status":201}}');
    const { id } = created.json<{ id: string }>();
    createdSessionIds.push(id);

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });

    assert.deepEqual(response.json<{ response: ResponseConfig }>().response, {
      status: 201,
      headers: [],
      body: null,
      delayMs: 0,
      template: false,
    });
  });

  it('returns the stored configuration of a custom session', async () => {
    const configuration = {
      status: 201,
      headers: [['x-trace-id', 'abc']] as [string, string][],
      body: '{"received":true}',
      delayMs: 500,
      template: false,
    };

    const created = await createWith(JSON.stringify({ response: configuration }));
    const { id } = created.json<{ id: string }>();
    createdSessionIds.push(id);

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });
    const read = response.json<{ response: ResponseConfig; customResponse: ResponseConfig }>();

    assert.deepEqual(read.response, configuration);
    // While the custom response is active the two fields agree (D151).
    assert.deepEqual(read.customResponse, configuration);
  });

  it('counts captured requests', async () => {
    const created = await createSession();

    await pool.query(
      `INSERT INTO requests (session_id, method, headers, body, body_size, raw_request)
       SELECT $1, 'POST', '[["host","qa-tools.ru"]]'::jsonb, ''::bytea, 0, ''::bytea
       FROM generate_series(1, 3)`,
      [created.id],
    );

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${created.id}` });

    assert.equal(response.json<{ requestsCount: number }>().requestsCount, 3);
  });

  it('answers 404 for an unknown session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${UNKNOWN_SESSION_ID}`,
    });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { errorCode: 1001, message: 'Session not found' });
  });

  it('answers a malformed id exactly like an unknown session (D058)', async () => {
    const unknown = await app.inject({ method: 'GET', url: `/api/sessions/${UNKNOWN_SESSION_ID}` });
    const malformed = await app.inject({ method: 'GET', url: '/api/sessions/hello' });

    assert.equal(malformed.statusCode, unknown.statusCode);
    assert.equal(malformed.body, unknown.body);
  });

  it('answers 410 for an expired session', async () => {
    const created = await createSession();

    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      created.id,
    ]);

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${created.id}` });

    assert.equal(response.statusCode, 410);
    assert.deepEqual(response.json(), { errorCode: 1002, message: 'Session expired' });
  });
});

/**
 * A load of the View page is one of the two things that count as using a
 * session, so it moves the expiry a full window ahead (D133). The throttle,
 * the expiry guard and the window itself all live in one statement, which both
 * refresh paths share.
 */
describe('GET /api/sessions/:sessionId — the sliding window', () => {
  it('moves the expiry a full window ahead when the last refresh is over an hour old', async () => {
    const created = await createSession();
    await setExpiry(created.id, '2 days');

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${created.id}` });

    assert.equal(response.statusCode, 200);

    const stored = await expiresAt(created.id);
    const daysAhead = (stored.getTime() - Date.now()) / 86_400_000;

    assert.ok(
      Math.abs(daysAhead - SESSION_IDLE_DAYS) < 0.01,
      `expected about ${SESSION_IDLE_DAYS} days, got ${daysAhead}`,
    );

    // The answer reports the refreshed value, not the one read a statement
    // earlier: a client that asked would otherwise be told about a state the
    // row is no longer in.
    const reported = response.json<{ expiresAt: string }>().expiresAt;
    assert.equal(Date.parse(reported), stored.getTime());
  });

  it('writes nothing for a session refreshed within the hour', async () => {
    const created = await createSession();
    // Freshly created, so it already has a full window: the throttle in the
    // statement matches nothing.
    const before = await expiresAt(created.id);

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${created.id}` });

    assert.equal(response.statusCode, 200);
    assert.equal((await expiresAt(created.id)).getTime(), before.getTime());
    assert.equal(Date.parse(response.json<{ expiresAt: string }>().expiresAt), before.getTime());
  });

  it('writes on the hour boundary but not inside it', async () => {
    const inside = (await createSession()).id;
    await setExpiry(inside, `${SESSION_IDLE_DAYS} days -30 minutes`);
    const untouched = await expiresAt(inside);

    await app.inject({ method: 'GET', url: `/api/sessions/${inside}` });
    assert.equal((await expiresAt(inside)).getTime(), untouched.getTime());

    const outside = (await createSession()).id;
    await setExpiry(outside, `${SESSION_IDLE_DAYS} days -90 minutes`);
    const stale = await expiresAt(outside);

    await app.inject({ method: 'GET', url: `/api/sessions/${outside}` });
    assert.ok((await expiresAt(outside)).getTime() > stale.getTime());
  });

  it('never revives an expired session', async () => {
    const created = await createSession();
    await setExpiry(created.id, '-1 minute');
    const before = await expiresAt(created.id);

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${created.id}` });

    assert.equal(response.statusCode, 410);
    assert.deepEqual(response.json(), { errorCode: 1002, message: 'Session expired' });
    assert.equal((await expiresAt(created.id)).getTime(), before.getTime());
  });

  /**
   * The statement's own guard, exercised directly.
   *
   * Through the route this is unreachable: the service answers `410` before a
   * refresh is ever attempted. That is exactly why it is tested here - delete
   * `AND expires_at > clock_timestamp()` and every route-level test stays
   * green, while the read-then-write race the guard closes (a session that
   * expires between the read and the write) would be open again.
   */
  it('refuses an expired row even when the statement is reached directly', async () => {
    const created = await createSession();
    await setExpiry(created.id, '-1 minute');
    const before = await expiresAt(created.id);

    assert.equal(await refreshSessionExpiry(pool, created.id), undefined);
    assert.equal((await expiresAt(created.id)).getTime(), before.getTime());
  });

  it('writes nothing for an id no session has', async () => {
    assert.equal(await refreshSessionExpiry(pool, UNKNOWN_SESSION_ID), undefined);
  });

  /**
   * The read path is protected exactly as the capture path is: sliding the
   * expiry may not decide whether the page loads (D133).
   */
  it('serves the session even when the refresh itself fails', async () => {
    const created = await createSession();
    await setExpiry(created.id, '2 days');
    const before = await expiresAt(created.id);

    let intercepted = 0;
    const failing = new Proxy(pool, {
      get(target, property) {
        if (property === 'query') {
          return (...args: unknown[]) => {
            const query = target.query.bind(target) as (...forwarded: unknown[]) => unknown;

            if (args[0] !== REFRESH_SESSION_EXPIRY_SQL) {
              return query(...args);
            }

            intercepted += 1;

            // A statement that really fails in PostgreSQL, so the failure is
            // the one production could have rather than a thrown stand-in.
            return query('SELECT 1 / 0');
          };
        }

        const value = Reflect.get(target, property, target);

        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });

    const warnings: string[] = [];

    // The throttle is process state shared with the capture path, so a test
    // that asserts on a warning says what it means only from a known start.
    resetRefreshWarningThrottle();

    const details = await getSessionDetails(failing, created.id, {
      warn: (_fields, message) => warnings.push(message),
    });

    assert.equal(intercepted, 1, 'the refresh statement was never intercepted');
    assert.equal(details.id, created.id);
    assert.equal(Date.parse(details.expiresAt), before.getTime());
    assert.equal((await expiresAt(created.id)).getTime(), before.getTime());
    // Reported rather than raised, so a refresh failing systematically is
    // visible in the log instead of only in the expiry dates.
    assert.deepEqual(warnings, [
      'session expiry refresh failed; the session keeps its previous expiry',
    ]);
  });
});

describe('logging', () => {
  it('never writes a complete session id, wherever it appears (D059)', async () => {
    const created = await createSession();

    logOutput = '';
    await app.inject({ method: 'GET', url: `/api/sessions/${created.id}` });
    // An id can also reach the log through an error rather than a URL.
    app.log.error(new Error(`repository failed for session ${created.id}`));

    assert.equal(logOutput.includes(created.id), false);
    assert.equal(logOutput.includes(created.id.slice(0, 8)), true);
  });

  it('writes no more than the first 8 of a real id glued to other id characters (D059, issue #176)', async () => {
    const created = await createSession();
    // Glued after 42 id characters, the id's last 42 were logged when the
    // free-text rule cut runs into windows of 43.
    const glued = `${'a'.repeat(42)}${created.id}`;

    for (const [server, request, status] of [
      [app, { method: 'GET', url: `/api/nonsense/${glued}` }, 404],
      [app, { method: 'GET', url: `/api/sessions/${created.id}?ref=${glued}` }, 200],
      [
        receiver,
        {
          method: 'POST',
          url: `/s/${created.id}/${glued}?ref=session-${created.id}`,
          payload: 'x',
        },
        200,
      ],
    ] as const) {
      logOutput = '';
      const response = await server.inject(request);

      assert.equal(response.statusCode, status, request.url);
      assert.equal(logOutput.includes(`${'a'.repeat(8)}...`), true, request.url);

      for (let start = 0; start + 9 <= created.id.length; start += 1) {
        const piece = created.id.slice(start, start + 9);

        assert.equal(logOutput.includes(piece), false, `"${piece}" of the id reached the log`);
      }
    }
  });

  it('writes only the first 8 characters of a near miss of a real id (D168)', async () => {
    const created = await createSession();
    // One character short: not an id, so the free-text rule, which needs 43,
    // cannot see it, and yet all but one character of the access key.
    const segment = created.id.slice(0, 42);

    logOutput = '';
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${segment}` });

    assert.equal(response.statusCode, 404);
    assert.equal(logOutput.includes(`/api/sessions/${segment.slice(0, 8)}...`), true);

    for (let start = 0; start + 9 <= segment.length; start += 1) {
      const piece = segment.slice(start, start + 9);

      assert.equal(logOutput.includes(piece), false, `"${piece}" of the segment reached the log`);
    }
  });

  it("writes no more of a real id behind a doubled slash or split by a ' (D168)", async () => {
    const created = await createSession();
    const near = created.id.slice(0, 42);
    const split = `${created.id.slice(0, 8)}'${created.id.slice(8)}`;

    // `/s/` on both listeners: the receive listener's 404, and the application
    // listener's 410 for the address it no longer receives at (D187).
    for (const [server, prefix, segment, status] of [
      [app, '/api/sessions//', near, 404],
      [receiver, '/s/', split, 404],
      [app, '/s/', split, 410],
    ] as const) {
      logOutput = '';
      const response = await server.inject({ method: 'GET', url: `${prefix}${segment}` });

      assert.equal(response.statusCode, status, prefix);
      assert.equal(logOutput.includes(`${prefix}${created.id.slice(0, 8)}...`), true, prefix);

      for (let start = 0; start + 9 <= created.id.length; start += 1) {
        const piece = created.id.slice(start, start + 9);

        assert.equal(logOutput.includes(piece), false, `"${piece}" of the id reached the log`);
      }
    }
  });

  it('logs a URL the router was given escaped once more as it arrived, still redacted (D173)', async () => {
    const created = await createSession();

    logOutput = '';

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${created.id}/caf%E9?x=%E9`,
      payload: 'x',
    });

    assert.equal(response.statusCode, 200, response.body);
    // The URL as received, not the one the router was given (`%25E9`).
    assert.equal(logOutput.includes(`"url":"/s/${created.id.slice(0, 8)}.../caf%E9?x=%E9"`), true);
    assert.equal(logOutput.includes('%25E9'), false);
    assert.equal(logOutput.includes(created.id), false);
  });
});

describe('unknown routes', () => {
  it('answers in the documented error shape (D062)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nonsense' });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { errorCode: 1000, message: 'Not found' });
  });

  it('answers the same way for any method', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/sessions/x/y/z' });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { errorCode: 1000, message: 'Not found' });
  });
});
