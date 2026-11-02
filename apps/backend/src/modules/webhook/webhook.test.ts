/**
 * Integration tests for the webhook receiver.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  MAX_BODY_BYTES,
  REALTIME_EVENTS_PARAM,
  RESPONSE_UNKNOWN_GRACE_MS,
  type RequestDetails,
  type RequestListItem,
  type ResponseConfig,
  type ResponseSummary,
  type ServerEvent,
  type WebhookDefaultAnswer,
} from '@webhook-inspector/shared';
import { DEFAULT_APP_ORIGIN, loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildReceiver, buildServer } from '../../server.ts';
import {
  DEFAULT_ANSWER_KEYS,
  defaultAnswerFor,
  defaultAnswerText,
} from '../../testing/default-answer.ts';
import { withExpiredSession } from '../../testing/expired-session.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import type { Subscriber } from '../realtime/hub.ts';
import { REFRESH_SESSION_EXPIRY_SQL, resetRefreshWarningThrottle } from '../sessions/repository.ts';
import { getSessionDetails } from '../sessions/service.ts';
import { METHODS_WITHOUT_BODY } from './capture-budget.ts';
import { recordResponseCompletion, storeRequest } from './repository.ts';
import { PendingWrites } from './routes.ts';
import { CONTENT_TYPE_PLACEHOLDER } from './content-type.ts';

let pool: pg.Pool;
let servers: TestServers;
/** The application listener: sessions, the API and realtime. */
let app: FastifyInstance;
/** The receive listener, where every webhook is sent (D187). */
let receiver: FastifyInstance;
const createdSessionIds: string[] = [];

/**
 * The site's origin both listeners are given, `APP_ORIGIN` (D203): where a
 * default answer links its request (D223). Not the default, so a link built
 * from anything else fails.
 */
const APP_ORIGIN = 'https://inspector.qa-tools.example';

interface StoredRequest {
  id: string;
  method: string;
  path: string | null;
  http_version: string | null;
  query_string: string;
  headers: [string, string][];
  body: Buffer;
  body_size: number;
  raw_request: Buffer;
  source_ip: string | null;
  source_country: string | null;
}

/** The receive listener's port, which the raw requests address. */
let port: number;
/** The application listener's port, for realtime and the API. */
let apiPort: number;

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
  // Both listeners, sharing one realtime hub as the process runs them (D187).
  // Dozens of sessions created within a minute, from one address (D201).
  servers = buildTestServers(pool, { rateLimits: LIMITS_OUT_OF_REACH, appOrigin: APP_ORIGIN });
  ({ api: app, receiver } = servers);
  app.log.level = 'silent';
  receiver.log.level = 'silent';
  // Real listeners, so that requests an injected one cannot express - repeated
  // headers, original header case - can still be tested.
  await receiver.listen({ host: '127.0.0.1', port: 0 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = receiver.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  const apiAddress = app.server.address();
  apiPort = typeof apiAddress === 'object' && apiAddress ? apiAddress.port : 0;
}

/** Sends a handcrafted request over a socket and returns the raw response. */
function sendRawRequest(request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let response = '';

    socket.on('data', (chunk) => {
      response += chunk.toString();
      if (response.includes('\r\n\r\n')) {
        socket.end();
      }
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

/**
 * Sends a handcrafted request and returns everything the server writes.
 *
 * Unlike `sendRawRequest` it waits a grace period after the header block before
 * resolving, so that "no body followed" can be told apart from "the body has
 * not arrived yet" - which is exactly what the HEAD contract is about. A closed
 * connection is definitive and resolves at once. The wait is bounded, so a
 * response that never arrives fails instead of hanging the suite.
 */
function readRawResponse(request: string, graceMs = 150, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let response = '';
    let grace: NodeJS.Timeout | undefined;

    const deadline = setTimeout(() => {
      socket.destroy();
      reject(new Error('no complete response arrived in time'));
    }, timeoutMs);

    const finish = (): void => {
      clearTimeout(deadline);
      clearTimeout(grace);
      socket.destroy();
      resolve(response);
    };

    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');

      if (response.includes('\r\n\r\n') && grace === undefined) {
        grace = setTimeout(finish, graceMs);
      }
    });
    socket.on('close', finish);
    socket.on('error', reject);
  });
}

/**
 * Resolves once the client end of a connection is closed.
 *
 * Bounded, so a connection nothing ever closes fails here instead of hanging
 * the suite indefinitely: `requestTimeout` covers only a request still
 * arriving (D172).
 */
function awaitSocketClose(socket: net.Socket, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.closed) {
      resolve();
      return;
    }

    const deadline = setTimeout(
      () => reject(new Error('the connection was never closed')),
      timeoutMs,
    );

    socket.once('close', () => {
      clearTimeout(deadline);
      resolve();
    });
  });
}

/** The head of a raw response, split into its status line and header pairs. */
function parseRawResponse(response: string): {
  status: number;
  headers: [string, string][];
  body: string;
} {
  const separator = response.indexOf('\r\n\r\n');
  const [statusLine, ...headerLines] = response.slice(0, separator).split('\r\n');

  return {
    status: Number((statusLine as string).slice(9, 12)),
    headers: headerLines.map((line) => {
      const colon = line.indexOf(':');

      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }),
    body: response.slice(separator + 4),
  };
}

function headerValues(headers: [string, string][], name: string): string[] {
  return headers.filter(([header]) => header === name).map(([, value]) => value);
}

function webhookRequest(
  sessionId: string,
  { method = 'POST', body = '' }: { method?: string; body?: string } = {},
): string {
  return [
    `${method} /s/${sessionId} HTTP/1.1`,
    'Host: qa-tools.ru',
    'Connection: close',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n');
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

async function newSession(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/sessions' });
  const { id } = response.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

/** Creates a session answering the given configuration (D099). */
async function newCustomSession(response: Partial<ResponseConfig>): Promise<string> {
  const created = await app.inject({
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

/** One stored response record, read straight from the table (D109). */
interface StoredResponse {
  request_id: string;
  state: string;
  status: number | null;
  headers: [string, string][];
  body: Buffer | null;
  body_size: number;
  body_suppressed: boolean;
  raw_response: Buffer | null;
  delay_ms: number;
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
}

async function storedResponses(sessionId: string): Promise<StoredResponse[]> {
  const result = await pool.query<StoredResponse>(
    `SELECT rr.*
       FROM request_responses rr
       JOIN requests r ON r.id = rr.request_id
      WHERE r.session_id = $1
      ORDER BY r.received_at DESC, r.id DESC`,
    [sessionId],
  );

  return result.rows;
}

/**
 * Blocks until the session's records are all terminal.
 *
 * A condition wait, not a sleep: `sent` is recorded from the write's
 * completion callback, which runs after the sender already holds the response,
 * so a test that read the table the instant its request returned would be
 * reading a race rather than a result (D109).
 */
async function awaitRecorded(sessionId: string, count: number): Promise<StoredResponse[]> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const rows = await storedResponses(sessionId);

    if (rows.length === count && rows.every((row) => row.state !== 'pending')) {
      return rows;
    }

    await delay(1);
  }

  throw new Error(`${count} response records did not reach a terminal state`);
}

async function storedRequests(sessionId: string): Promise<StoredRequest[]> {
  const result = await pool.query<StoredRequest>(
    `SELECT id, method, path, http_version, query_string, headers, body, body_size, raw_request,
            source_ip, source_country
     FROM requests WHERE session_id = $1 ORDER BY received_at DESC, id DESC`,
    [sessionId],
  );

  return result.rows;
}

/**
 * Blocks until the session holds `count` captures.
 *
 * For the tests that act on a request while its own response is still being
 * held: the capture commits before the delay begins, so the row is there well
 * before the sender has its answer, but not at the instant the socket was
 * written to.
 */
async function awaitStoredRequests(sessionId: string, count: number): Promise<StoredRequest[]> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const rows = await storedRequests(sessionId);

    if (rows.length === count) {
      return rows;
    }

    await delay(1);
  }

  throw new Error(`${count} requests were not captured`);
}

/** UUID v4, the format the request id is promised in (D044). */
/** The receiver's sandbox policy, on every answer the application sends to `/s/…` (D179). */
const SANDBOX_POLICY = "sandbox; default-src 'none'";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('capturing requests', () => {
  it('accepts a webhook and answers {"ok":true,"requestId":...} and what it stored (D100, D223)', async () => {
    const sessionId = await newSession();

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      headers: { 'content-type': 'application/json' },
      payload: '{"event":"build.completed"}',
    });

    assert.equal(response.statusCode, 200);

    const body = response.json<WebhookDefaultAnswer>();
    assert.equal(body.ok, true);
    assert.match(body.requestId, UUID_V4);
    // `ok` first and `requestId` second, as D100 has them, then the seven
    // keys D223 added, and nothing else.
    assert.deepEqual(Object.keys(body), [...DEFAULT_ANSWER_KEYS]);
    assert.equal(
      response.body,
      await defaultAnswerText(app, sessionId, body.requestId, APP_ORIGIN),
    );

    const [stored] = await storedRequests(sessionId);
    assert.equal(body.requestId, stored?.id);
    assert.equal(stored?.method, 'POST');
    assert.equal(stored?.body.toString(), '{"event":"build.completed"}');
    assert.equal(stored?.body_size, 27);
  });

  it('answers with X-QA-Tools-Request-Id matching the stored row and the body (D100)', async () => {
    const sessionId = await newSession();

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      payload: 'x',
    });

    const [stored] = await storedRequests(sessionId);
    const header = response.headers['x-webhook-inspector-request-id'];

    assert.match(String(header), UUID_V4);
    assert.equal(header, stored?.id);
    assert.equal(header, response.json<{ requestId: string }>().requestId);
    // The old name beside it, the same value, until the old names stop (D279).
    assert.equal(response.headers['x-qa-tools-request-id'], header);
  });

  it('stores a malformed JSON payload instead of rejecting it (D007)', async () => {
    const sessionId = await newSession();

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      headers: { 'content-type': 'application/json' },
      payload: '{"broken": ',
    });

    assert.equal(response.statusCode, 200);

    const [stored] = await storedRequests(sessionId);
    assert.equal(stored?.body.toString(), '{"broken": ');
  });

  it('stores an empty payload declared as JSON instead of rejecting it (D007)', async () => {
    // The receiver parses every declared media type as bytes, so the 400 / 1006
    // answer the root error handler gives an empty or unparseable declared-JSON
    // body elsewhere cannot arise here: a capture must never become an error
    // response. An invalid Content-Type *header* is captured too, by a
    // different mechanism, pinned by the cases below (D138).
    const sessionId = await newSession();

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    assert.equal(response.statusCode, 200);

    const [stored] = await storedRequests(sessionId);
    assert.equal(stored?.body.toString(), '');
    assert.equal(stored?.body_size, 0);
  });

  it('stores a payload declared as a media type no API route parses (D007)', async () => {
    const sessionId = await newSession();

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      headers: { 'content-type': 'application/xml' },
      payload: '<event/>',
    });

    assert.equal(response.statusCode, 200);

    const [stored] = await storedRequests(sessionId);
    assert.equal(stored?.body.toString(), '<event/>');
  });

  /** A POST carrying `headerLine` exactly as written, sent over a real socket. */
  function sendWithHeaderLine(sessionId: string, headerLine: string, body: string) {
    return sendRawRequest(
      [
        `POST /s/${sessionId} HTTP/1.1`,
        'Host: qa-tools.ru',
        headerLine,
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'),
    );
  }

  /** The detail the API returns for a session's one stored request. */
  async function onlyRequestDetails(sessionId: string): Promise<RequestDetails> {
    const list = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/requests` });
    const ids = list.json<{ id: string }[]>().map(({ id }) => id);

    assert.equal(ids.length, 1, `expected one listed request, got ${ids.length}`);

    const details = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests/${ids[0]}`,
    });

    return details.json<RequestDetails>();
  }

  /**
   * A Content-Type that is not a media type is captured like any other request
   * (D138). Fastify refuses such a header before it selects a parser; inside
   * the receiver's scope it is replaced on Fastify's parsed view first, and what
   * is stored comes from the headers as received. It answered 415 / 1007 from
   * v0.5.2 to v0.8.0 and stored nothing (D104).
   *
   * Sent over a socket, so that the header on the wire - the empty value
   * included - is exactly the line written here, and the capture is compared
   * with what a sender really produced. The first four are the shapes the
   * issue measured; the rest show that the rule is Fastify's whole set rather
   * than those four examples.
   */
  for (const [description, headerLine, value] of [
    ['a Content-Type with no slash in it', 'Content-Type: json', 'json'],
    ['a Content-Type with no subtype', 'Content-Type: application/', 'application/'],
    ['a Content-Type with a second slash in it', 'Content-Type: a/b/c', 'a/b/c'],
    ['an empty Content-Type', 'Content-Type:', ''],
    ['a Content-Type with no type', 'Content-Type: /json', '/json'],
    ['a Content-Type of parameters alone', 'Content-Type: ;charset=utf-8', ';charset=utf-8'],
    [
      'a Content-Type listing two media types',
      'Content-Type: text/plain, application/json',
      'text/plain, application/json',
    ],
  ] as [string, string, string][]) {
    it(`captures a request with ${description}, keeping the header as sent (D138)`, async () => {
      const sessionId = await newSession();
      const body = '{"event":"build.completed"}';

      const response = parseRawResponse(await sendWithHeaderLine(sessionId, headerLine, body));

      // The receiver's own answer rather than a refusal: 200 and the default
      // body with the stored id, carrying the pinned representation headers
      // (D100, D101).
      assert.equal(response.status, 200, response.body);

      const details = await onlyRequestDetails(sessionId);

      assert.equal(response.body, JSON.stringify(defaultAnswerFor(sessionId, details, APP_ORIGIN)));
      assert.deepEqual(headerValues(response.headers, 'x-qa-tools-request-id'), [details.id]);
      assert.deepEqual(headerValues(response.headers, 'x-webhook-inspector-request-id'), [
        details.id,
      ]);
      assert.deepEqual(headerValues(response.headers, 'content-type'), [
        'application/json; charset=utf-8',
      ]);
      assert.deepEqual(headerValues(response.headers, 'x-content-type-options'), ['nosniff']);
      assert.deepEqual(headerValues(response.headers, 'content-security-policy'), [SANDBOX_POLICY]);

      // The body bytes, untouched.
      const [stored] = await storedRequests(sessionId);
      assert.deepEqual(stored?.body, Buffer.from(body));
      assert.equal(details.body, body);

      // The header exactly as it was sent - not the placeholder the receiver
      // let Fastify parse with - in both the header list and the raw request.
      assert.deepEqual(
        details.headers.filter(([name]) => name.toLowerCase() === 'content-type'),
        [['Content-Type', value]],
      );
      assert.ok(
        details.raw?.includes(`\r\nContent-Type: ${value}\r\n`),
        `the raw request lost the header: ${JSON.stringify(details.raw)}`,
      );
      assert.ok(!details.raw?.includes(CONTENT_TYPE_PLACEHOLDER), 'the placeholder was stored');
    });
  }

  it("answers such a request with the session's configured response (D138)", async () => {
    const sessionId = await newCustomSession({
      status: 202,
      headers: [['x-fixture', 'accepted']],
      body: '{"queued":true}',
    });

    const response = parseRawResponse(
      await sendWithHeaderLine(sessionId, 'Content-Type: json', 'x'),
    );

    assert.equal(response.status, 202, response.body);
    assert.equal(response.body, '{"queued":true}');
    assert.deepEqual(headerValues(response.headers, 'x-fixture'), ['accepted']);

    const [stored] = await storedRequests(sessionId);
    assert.deepEqual(headerValues(response.headers, 'x-qa-tools-request-id'), [stored?.id]);
    assert.deepEqual(headerValues(response.headers, 'x-webhook-inspector-request-id'), [
      stored?.id,
    ]);
  });

  /**
   * The rule is not a rewrite of every declaration: a valid media type, however
   * unusual, is captured exactly as before (D007).
   */
  for (const headerLine of [
    'Content-Type: Application/JSON; charset=UTF-8',
    'Content-Type: text/plain;charset',
    'Content-Type: vnd.example/x-thing+json',
  ]) {
    it(`captures ${headerLine} unchanged, body untouched (D007)`, async () => {
      const sessionId = await newSession();
      const body = '<event id="1"/>';

      const response = parseRawResponse(await sendWithHeaderLine(sessionId, headerLine, body));

      assert.equal(response.status, 200, response.body);

      const [stored] = await storedRequests(sessionId);
      assert.deepEqual(stored?.body, Buffer.from(body));
      assert.deepEqual(
        stored?.headers.filter(([name]) => name.toLowerCase() === 'content-type'),
        [['Content-Type', headerLine.slice('Content-Type: '.length)]],
      );
    });
  }

  /**
   * The other side of that rule: a header that is missing is not an invalid
   * one, and the replacement adds nothing to a request that declared nothing.
   * Sent over a socket, because the point of the test is an absence and an
   * injected request cannot promise one (D104, D138).
   */
  it('stores a request sent with no Content-Type header at all (D104)', async () => {
    const sessionId = await newSession();
    const body = '{"event":"build.completed"}';

    const response = parseRawResponse(await sendRawRequest(webhookRequest(sessionId, { body })));

    assert.equal(response.status, 200, response.body);

    const [stored] = await storedRequests(sessionId);
    assert.equal(stored?.body.toString(), body);
    assert.deepEqual(
      (stored?.headers ?? []).filter(([name]) => name.toLowerCase() === 'content-type'),
      [],
    );
    assert.doesNotMatch(stored?.raw_request.toString('latin1') ?? '', /content-type/i);
  });

  it('stores binary payloads byte for byte, including null bytes', async () => {
    const sessionId = await newSession();
    const payload = Buffer.from([0x00, 0x01, 0xff, 0x00, 0xfe]);

    await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload,
    });

    const [stored] = await storedRequests(sessionId);
    assert.deepEqual(stored?.body, payload);
    assert.equal(stored?.body_size, 5);
  });

  it('captures a plain GET, as opening the URL in a browser produces', async () => {
    const sessionId = await newSession();

    const response = await receiver.inject({ method: 'GET', url: `/s/${sessionId}` });

    assert.equal(response.statusCode, 200);

    const [stored] = await storedRequests(sessionId);
    assert.equal(stored?.method, 'GET');
    assert.equal(stored?.body_size, 0);
  });

  it('accepts every standard method and answers each with the request id header (D100)', async () => {
    const sessionId = await newSession();
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

    for (const method of methods) {
      const response = await receiver.inject({ method, url: `/s/${sessionId}` });
      assert.equal(response.statusCode, 200, `${method} was not accepted`);
      assert.match(
        String(response.headers['x-qa-tools-request-id']),
        UUID_V4,
        `${method} carried no request id`,
      );
    }

    const stored = await storedRequests(sessionId);
    assert.deepEqual(new Set(stored.map((row) => row.method)), new Set(methods));
  });

  it('preserves duplicate headers, their order and their case (D045)', async () => {
    const sessionId = await newSession();

    // Sent over a real socket: an injected request cannot express repeated
    // headers or preserve their case, and this is exactly what D045 promises.
    const response = await sendRawRequest(
      [
        `POST /s/${sessionId} HTTP/1.1`,
        'Host: qa-tools.ru',
        'Set-Cookie: a=1',
        'X-Custom-Header: kept',
        'Set-Cookie: b=2',
        'Content-Length: 0',
        '',
        '',
      ].join('\r\n'),
    );

    assert.match(response, /^HTTP\/1\.1 200/);

    const [stored] = await storedRequests(sessionId);

    assert.deepEqual(
      stored?.headers.filter(([name]) => name.toLowerCase() === 'set-cookie'),
      [
        ['Set-Cookie', 'a=1'],
        ['Set-Cookie', 'b=2'],
      ],
    );
    assert.ok(stored?.headers.some(([name]) => name === 'X-Custom-Header'));
    assert.ok(stored?.raw_request.toString().includes('Set-Cookie: a=1\r\nX-Custom-Header'));
  });

  it('preserves the query string exactly as sent', async () => {
    const sessionId = await newSession();
    const query = 'source=regression&source=staging&run%20id=qa%201842&empty=';

    await receiver.inject({ method: 'GET', url: `/s/${sessionId}?${query}` });

    const [stored] = await storedRequests(sessionId);
    assert.equal(stored?.query_string, query);
  });

  it('stores the raw request with its request line, headers and body (D049)', async () => {
    const sessionId = await newSession();

    await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}?a=1`,
      headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
      payload: '{"ok":1}',
    });

    const [stored] = await storedRequests(sessionId);
    const raw = stored?.raw_request.toString() ?? '';

    assert.match(raw, new RegExp(`^POST /s/${sessionId}\\?a=1 HTTP/1\\.1\\r\\n`));
    assert.ok(raw.includes('x-request-id: abc'));
    assert.ok(raw.endsWith('\r\n\r\n{"ok":1}'));
  });

  it('records the source IP visible to the backend', async () => {
    const sessionId = await newSession();

    // The injected peer, named rather than implied: an exact value is what
    // makes this assertion able to fail if the address ever stops being the
    // one the connection came from (D111).
    await receiver.inject({ method: 'GET', url: `/s/${sessionId}`, remoteAddress: '198.51.100.7' });

    const [stored] = await storedRequests(sessionId);
    assert.equal(stored?.source_ip, '198.51.100.7');
  });

  /**
   * Country resolution is gone (D140): nothing on the capture path looks the
   * address up, and nothing writes the column it used to fill. The column is
   * still selected here, so this also fails if it is dropped while a
   * deployable image still inserts into it.
   */
  it('writes nothing to source_country, which stays in place unused (D140)', async () => {
    const sessionId = await newSession();

    await receiver.inject({ method: 'GET', url: `/s/${sessionId}`, remoteAddress: '198.51.100.7' });

    const [stored] = await storedRequests(sessionId);
    assert.equal(stored?.source_ip, '198.51.100.7');
    assert.equal(stored?.source_country, null);
  });

  it('accepts a trailing slash (D063)', async () => {
    const sessionId = await newSession();

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}/`,
      payload: 'x',
    });

    assert.equal(response.statusCode, 200);
    assert.equal((await storedRequests(sessionId)).length, 1);
  });
});

describe('paths under the endpoint (D173)', () => {
  /** Sends one request over a real socket and times the answer. */
  async function timedSend(
    target: string,
    body: string,
  ): Promise<{ response: ReturnType<typeof parseRawResponse>; elapsedMs: number }> {
    const started = Date.now();
    const raw = await readUntilClosed(
      handcrafted(
        `POST ${target} HTTP/1.1`,
        ['Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`],
        body,
      ),
    );

    return { response: parseRawResponse(raw), elapsedMs: Date.now() - started };
  }

  /** The answer's headers without the three that differ between any two answers. */
  function comparableHeaders(headers: [string, string][]): [string, string][] {
    return headers.filter(
      ([name]) =>
        name !== 'date' &&
        name !== 'x-webhook-inspector-request-id' &&
        name !== 'x-qa-tools-request-id',
    );
  }

  it('captures POST /s/<id>/stripe/events?livemode=false exactly as POST /s/<id>, and announces it', async () => {
    const sessionId = await newCustomSession({
      status: 202,
      headers: [
        ['x-fixture', 'accepted'],
        ['x-trace-id', 'abc-123'],
      ],
      body: '{"queued":true}',
      delayMs: 150,
    });
    const body = '{"id":"evt_1","type":"charge.succeeded"}';

    // A connection that declared nothing: `request.received` reaches every one.
    const socket = new WebSocket(`ws://127.0.0.1:${apiPort}/ws/${sessionId}`);
    const events: ServerEvent[] = [];

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('message', (message) => {
        const event = JSON.parse(message.data as string) as ServerEvent;

        if (event.type === 'ready') {
          resolve();
        } else {
          events.push(event);
        }
      });
      socket.addEventListener('error', () => reject(new Error('the watcher could not connect')));
    });

    try {
      const root = await timedSend(`/s/${sessionId}?livemode=false`, body);
      const sub = await timedSend(`/s/${sessionId}/stripe/events?livemode=false`, body);

      // The same answer: status, headers in their order and body, and the same
      // configured delay held before it (D105).
      for (const { response, elapsedMs } of [root, sub]) {
        assert.equal(response.status, 202, response.body);
        assert.equal(response.body, '{"queued":true}');
        assert.ok(elapsedMs >= 140, `answered after ${elapsedMs} ms, before the delay`);
      }

      assert.deepEqual(
        comparableHeaders(sub.response.headers),
        comparableHeaders(root.response.headers),
      );

      const subId = headerValues(sub.response.headers, 'x-qa-tools-request-id')[0] ?? '';
      const rootId = headerValues(root.response.headers, 'x-qa-tools-request-id')[0] ?? '';

      assert.match(subId, UUID_V4);

      // Stored with the path it was sent to, and its query string apart from it.
      const stored = await storedRequests(sessionId);
      const subRow = stored.find((row) => row.id === subId);
      const rootRow = stored.find((row) => row.id === rootId);

      assert.equal(subRow?.path, `/s/${sessionId}/stripe/events`);
      assert.equal(subRow?.query_string, 'livemode=false');
      assert.equal(subRow?.body.toString(), body);
      assert.equal(rootRow?.path, `/s/${sessionId}`);
      assert.match(
        subRow?.raw_request.toString('latin1') ?? '',
        new RegExp(`^POST /s/${sessionId}/stripe/events\\?livemode=false HTTP/1\\.1\\r\\n`),
      );

      // In the list, which carries it for the list filter although no row
      // shows it (D180; PRODUCT: no path in a row).
      const listed = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/requests`,
      });
      const items = listed.json<RequestListItem[]>();
      const subItem = items.find((item) => item.id === subId);
      const rootItem = items.find((item) => item.id === rootId);

      assert.ok(subItem && rootItem);
      assert.deepEqual(Object.keys(subItem).sort(), Object.keys(rootItem).sort());
      assert.equal(subItem.path, `/s/${sessionId}/stripe/events`);
      assert.equal(rootItem.path, `/s/${sessionId}`);

      // Over realtime, as the row the list holds.
      const announced = events.find(
        (event) => event.type === 'request.received' && event.data.id === subId,
      );

      assert.ok(announced, 'the request was not announced');
      assert.equal(announced.type, 'request.received');
      assert.deepEqual(Object.keys(announced.data).sort(), Object.keys(subItem).sort());
      assert.equal(announced.data.path, `/s/${sessionId}/stripe/events`);

      // And in the detail, as it was sent.
      const details = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/requests/${subId}`,
      });

      assert.equal(details.json<RequestDetails>().path, `/s/${sessionId}/stripe/events`);
      assert.equal(details.json<RequestDetails>().queryString, 'livemode=false');
    } finally {
      socket.close();
    }
  });

  it('keeps /s/<id> and /s/<id>/ as they were, each stored with its own path (D063)', async () => {
    const sessionId = await newSession();

    for (const [url, path, query] of [
      [`/s/${sessionId}`, `/s/${sessionId}`, ''],
      [`/s/${sessionId}/`, `/s/${sessionId}/`, ''],
      [`/s/${sessionId}?a=1`, `/s/${sessionId}`, 'a=1'],
      [`/s/${sessionId}/?a=1`, `/s/${sessionId}/`, 'a=1'],
    ]) {
      const response = await receiver.inject({ method: 'POST', url, payload: 'x' });
      const requestId = response.headers['x-qa-tools-request-id'];

      assert.equal(response.statusCode, 200, url);
      assert.equal(
        response.body,
        await defaultAnswerText(app, sessionId, String(requestId), APP_ORIGIN),
        url,
      );
      // The answer's path is the stored one: its trailing slash kept, its query
      // string not (D063, D223).
      assert.equal(response.json<WebhookDefaultAnswer>().path, path, url);

      const stored = (await storedRequests(sessionId)).find((row) => row.id === requestId);

      assert.equal(stored?.path, path, url);
      assert.equal(stored?.query_string, query, url);
    }
  });

  it('stores the path exactly as it reached the application: nothing decoded or normalised', async () => {
    const sessionId = await newSession();

    // Over a real socket, because an injected request is parsed as a URL first,
    // which resolves `..` and would test the injector instead. What the
    // production proxy rewrites before the application sees it is recorded in
    // D173 and docs/API.md; the application itself rewrites nothing.
    for (const rest of [
      '/%D0%BF%D0%BB%D0%B0%D1%82%D0%B5%D0%B6/new',
      '/%d0%bf/lower-case%2fhex',
      '/a%20b+c/%2F/%3F%23',
      '//double//slashes/',
      '/a/../b/./c',
      '/..',
      '/x;y=1,z',
      '/h',
    ]) {
      const target = `/s/${sessionId}${rest}`;
      const { response } = await timedSend(`${target}?q=%41&r=a%20b`, '{}');
      const requestId = headerValues(response.headers, 'x-qa-tools-request-id')[0];

      assert.equal(response.status, 200, `${target}: ${response.body}`);

      const stored = (await storedRequests(sessionId)).find((row) => row.id === requestId);

      assert.equal(stored?.path, target);
      assert.equal(stored?.query_string, 'q=%41&r=a%20b', target);
      assert.ok(
        stored?.raw_request
          .toString('latin1')
          .startsWith(`POST ${target}?q=%41&r=a%20b HTTP/1.1\r\n`),
        target,
      );

      const details = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/requests/${requestId}`,
      });

      assert.equal(details.json<RequestDetails>().path, target);
    }
  });

  it('has no path length limit of its own: 12 KiB is captured, past 16 KiB the parser refuses the request line', async () => {
    const sessionId = await newSession();
    const path = `/s/${sessionId}/${'p'.repeat(12 * 1024)}`;
    const { response } = await timedSend(path, '{}');
    const requestId = headerValues(response.headers, 'x-qa-tools-request-id')[0];

    assert.equal(response.status, 200, response.body);

    const [stored] = await storedRequests(sessionId);

    assert.equal(stored?.id, requestId);
    assert.equal(stored?.path, path);

    // Node's limit on the request line and headers together, 16 KiB, bounds
    // the path (D142): past it the parser refuses the request before any
    // route, in Fastify's own shape, and nothing is stored.
    const refused = parseRawResponse(
      await readUntilClosed(
        handcrafted(
          `POST /s/${sessionId}/${'p'.repeat(17 * 1024)} HTTP/1.1`,
          ['Content-Length: 0'],
          '',
        ),
      ),
    );

    assert.equal(refused.status, 431);
    assert.equal((JSON.parse(refused.body) as { errorCode?: number }).errorCode, undefined);
    assert.equal((await storedRequests(sessionId)).length, 1);
  });

  it('captures a path the router cannot decode, stored exactly as it arrived', async () => {
    const sessionId = await newSession();

    // The escape of a byte that is not UTF-8, as a Latin-1 sender writes `é`,
    // and a `%` without two hex digits. Fastify's router refuses both before
    // any route; under the endpoint the router is given them escaped once more,
    // and the capture reads the URL as it was received (D173).
    for (const rest of ['/caf%E9/r%E9sum%E9', '/%FF%FE', '/100%', '/%zz/%D0%BF']) {
      const target = `/s/${sessionId}${rest}`;
      const { response } = await timedSend(`${target}?q=%E9`, '{}');
      const requestId = headerValues(response.headers, 'x-qa-tools-request-id')[0];

      assert.equal(response.status, 200, `${target}: ${response.body}`);

      const stored = (await storedRequests(sessionId)).find((row) => row.id === requestId);

      assert.equal(stored?.path, target);
      assert.equal(stored?.query_string, 'q=%E9', target);
      assert.ok(
        stored?.raw_request.toString('latin1').startsWith(`POST ${target}?q=%E9 HTTP/1.1\r\n`),
        target,
      );
    }
  });
});

/**
 * Every method the receiver accepts, written out rather than derived (D139).
 *
 * The server derives the set from `http.METHODS` and Fastify's defaults, so a
 * Node or Fastify upgrade can move it without a line of this project changing -
 * which is how D064's seven became nine unnoticed. This list is the pin: a
 * change to either source fails here, and the documents that state the set are
 * corrected in the same change.
 */
const ACCEPTED_METHODS = [
  'ACL',
  'BIND',
  'CHECKOUT',
  'COPY',
  'DELETE',
  'GET',
  'HEAD',
  'LINK',
  'LOCK',
  'M-SEARCH',
  'MERGE',
  'MKACTIVITY',
  'MKCALENDAR',
  'MKCOL',
  'MOVE',
  'NOTIFY',
  'OPTIONS',
  'PATCH',
  'POST',
  'PROPFIND',
  'PROPPATCH',
  'PURGE',
  'PUT',
  'QUERY',
  'REBIND',
  'REPORT',
  'SEARCH',
  'SOURCE',
  'SUBSCRIBE',
  'TRACE',
  'UNBIND',
  'UNLINK',
  'UNLOCK',
  'UNSUBSCRIBE',
];

/**
 * Fastify's own bodyless defaults, whose body it never reads; not changed by
 * D139. The capture budget's set, so the weight that keeps such a body
 * counted, unread, until the reply has closed (D210) rests on what this file
 * checks over real sockets.
 */
const BODYLESS_METHODS = METHODS_WITHOUT_BODY;

/**
 * Sends a handcrafted request and returns whatever arrived before the server
 * closed the connection. Unlike `readRawResponse` it treats a reset as a close,
 * since a connection the server tears down is the outcome under test here, and
 * it can address a second listener.
 */
function readUntilClosed(request: string, targetPort = port, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(targetPort, '127.0.0.1', () => socket.write(request));
    let response = '';

    const deadline = setTimeout(() => {
      socket.destroy();
      reject(new Error('the connection was never closed'));
    }, timeoutMs);

    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
    });
    // An `error` is always followed by `close`, which is where this resolves.
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(deadline);
      resolve(response);
    });
  });
}

describe('HTTP methods (D064, D139)', () => {
  it('accepts exactly the 34 methods of http.METHODS other than CONNECT', () => {
    assert.deepEqual([...receiver.supportedMethods].sort(), ACCEPTED_METHODS);

    // The route itself, not only the instance's set: `app.all` takes the set
    // as it stands when the route is added, so a declaration made too late
    // would leave the set right and the route short. The wildcard is the third
    // route of the receiver, any path under the endpoint (D173).
    for (const path of ['/s/:sessionId', '/s/:sessionId/', '/s/:sessionId/*']) {
      for (const method of ACCEPTED_METHODS) {
        assert.ok(receiver.hasRoute({ method, url: path }), `${method} ${path} is not routed`);
      }

      assert.equal(receiver.hasRoute({ method: 'CONNECT', url: path }), false);
    }
  });

  it('captures each of them over a real socket, body included, on the endpoint and under it', async () => {
    // A path under the endpoint is the receiver's third route and takes the
    // same 34 methods (D173); `/folder/` is what a WebDAV client addresses.
    for (const suffix of ['', '/folder/']) {
      const sessionId = await newSession();
      const path = `/s/${sessionId}${suffix}`;

      for (const method of ACCEPTED_METHODS) {
        const request = [
          `${method} ${path} HTTP/1.1`,
          'Host: qa-tools.ru',
          'Connection: close',
          // A QUERY without one takes another way through Fastify (D166), which
          // its own tests below cover.
          'Content-Type: text/plain',
          'Content-Length: 5',
          '',
          'hello',
        ].join('\r\n');
        const response = parseRawResponse(await readRawResponse(request));

        assert.equal(response.status, 200, `${method} ${path} was not accepted`);
        assert.match(
          headerValues(response.headers, 'x-qa-tools-request-id')[0] ?? '',
          UUID_V4,
          `${method} ${path} carried no request id`,
        );
      }

      // In the session, as the viewer's list reads it.
      const listed = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/requests`,
      });
      const listedMethods = listed.json<RequestListItem[]>().map((item) => item.method);

      assert.deepEqual(listedMethods.sort(), ACCEPTED_METHODS, path);

      // Every method keeps what it carried (D007) - the 25 added ones because
      // they are declared with a body - except Fastify's three bodyless
      // defaults, whose body it never reads. Both halves are asserted, so a
      // Fastify default that moved a method between the two would fail here
      // too. And every one keeps the path it was sent to.
      for (const stored of await storedRequests(sessionId)) {
        assert.equal(
          stored.body.toString(),
          BODYLESS_METHODS.has(stored.method) ? '' : 'hello',
          `${stored.method} ${path} stored an unexpected body`,
        );
        assert.equal(stored.path, path, `${stored.method} stored another path`);
      }
    }
  });

  it('captures an added method whose Content-Type is not a media type (D138)', async () => {
    const sessionId = await newSession();

    // The receiver's Content-Type rule is not tied to a method: an added one
    // reaches the same hook and the same parse-anything parser as POST.
    const response = parseRawResponse(
      await readRawResponse(
        [
          `PROPFIND /s/${sessionId} HTTP/1.1`,
          'Host: qa-tools.ru',
          'Connection: close',
          'Content-Type: json',
          'Content-Length: 5',
          '',
          'hello',
        ].join('\r\n'),
      ),
    );

    assert.equal(response.status, 200, response.body);

    const [stored] = await storedRequests(sessionId);

    assert.equal(stored?.method, 'PROPFIND');
    assert.equal(stored?.body.toString(), 'hello');
    assert.deepEqual(
      stored?.headers.filter(([name]) => name.toLowerCase() === 'content-type'),
      [['Content-Type', 'json']],
    );
  });

  it('captures a WebDAV PROPFIND on a folder, XML body included, as it captures POST there (D173)', async () => {
    const sessionId = await newSession();
    const body = '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getetag/></prop></propfind>';

    // The realistic WebDAV request. Until D173 it was the not-found route's,
    // and answered 404 / 1000 - or 415 / 1007 for a header that is not a media
    // type. It is the receiver's now: any media type is captured, and one that
    // is not a media type is captured as D138 captures it on the endpoint.
    for (const contentType of ['application/xml', 'json']) {
      for (const method of ['POST', 'PROPFIND']) {
        const label = `${method} with ${contentType}`;
        const response = parseRawResponse(
          await readRawResponse(
            [
              `${method} /s/${sessionId}/folder/ HTTP/1.1`,
              'Host: qa-tools.ru',
              'Connection: close',
              'Depth: 1',
              `Content-Type: ${contentType}`,
              `Content-Length: ${Buffer.byteLength(body)}`,
              '',
              body,
            ].join('\r\n'),
          ),
        );
        const requestId = headerValues(response.headers, 'x-qa-tools-request-id')[0] ?? '';

        assert.equal(response.status, 200, `${label}: ${response.body}`);
        assert.match(requestId, UUID_V4, label);

        const stored = (await storedRequests(sessionId)).find((row) => row.id === requestId);

        assert.equal(stored?.method, method, label);
        assert.equal(stored?.path, `/s/${sessionId}/folder/`, label);
        assert.equal(stored?.query_string, '', label);
        assert.equal(stored?.body.toString(), body, label);
        assert.deepEqual(
          stored?.headers.filter(([name]) => name.toLowerCase() === 'content-type'),
          [['Content-Type', contentType]],
          label,
        );
      }
    }

    assert.equal((await storedRequests(sessionId)).length, 4);
  });

  it('closes a CONNECT without an answer and captures nothing', async () => {
    const sessionId = await newSession();

    const response = await readUntilClosed(
      [`CONNECT /s/${sessionId} HTTP/1.1`, 'Host: qa-tools.ru', '', ''].join('\r\n'),
    );

    assert.equal(response, '');
    assert.equal((await storedRequests(sessionId)).length, 0);
  });

  it('leaves a method outside http.METHODS to Node, which answers 400', async () => {
    const sessionId = await newSession();

    for (const method of ['FROBNICATE', 'X-VENDOR']) {
      const response = parseRawResponse(
        await readRawResponse(webhookRequest(sessionId, { method, body: 'hello' })),
      );

      assert.equal(response.status, 400, method);
      // No nosniff and no sandbox policy: the application never saw the
      // request, since every response it produces for a /s/... URL carries
      // both (D101, D179).
      assert.deepEqual(headerValues(response.headers, 'x-content-type-options'), [], method);
      assert.deepEqual(headerValues(response.headers, 'content-security-policy'), [], method);
      assert.deepEqual(headerValues(response.headers, 'x-qa-tools-request-id'), [], method);
      assert.deepEqual(
        headerValues(response.headers, 'x-webhook-inspector-request-id'),
        [],
        method,
      );
    }

    assert.equal((await storedRequests(sessionId)).length, 0);
  });
});

/**
 * The shapes of `QUERY` Fastify refuses before any route runs, as RFC 10008
 * requires (D139, D166): no `Content-Type`, or one with no content.
 */
const QUERY_REFUSED_SHAPES: [string, string[], string][] = [
  ['no Content-Type, a body', ['Content-Length: 5'], 'hello'],
  ['a Content-Type, Content-Length: 0', ['Content-Type: text/plain', 'Content-Length: 0'], ''],
  [
    'a Content-Type, neither Content-Length nor Transfer-Encoding',
    ['Content-Type: text/plain'],
    '',
  ],
  ['neither a Content-Type nor content, Content-Length: 0', ['Content-Length: 0'], ''],
  ['neither a Content-Type nor content, no framing at all', [], ''],
];

function handcrafted(requestLine: string, headers: string[], body: string): string {
  return [requestLine, 'Host: qa-tools.ru', 'Connection: close', ...headers, '', body].join('\r\n');
}

/** A second instance whose log can be read, for the "no Unhandled error" claims. */
async function withLoggedServer(run: (targetPort: number) => Promise<void>): Promise<string> {
  let log = '';
  const logged = buildServer(pool, {
    logDestination: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        log += chunk.toString();
        callback();
      },
    }),
  });

  try {
    await logged.listen({ host: '127.0.0.1', port: 0 });
    const address = logged.server.address();

    await run(typeof address === 'object' && address ? address.port : 0);
  } finally {
    await logged.close();
  }

  return log;
}

describe('QUERY without a Content-Type or content (D166)', () => {
  it('captures every refused shape exactly as a POST of the same shape, on each of its paths', async () => {
    const sessionId = await newCustomSession({
      status: 202,
      headers: [['x-fixture', 'accepted']],
      body: '{"queued":true}',
    });

    // The endpoint, its trailing slash (D063) and a path under it (D173).
    for (const path of [`/s/${sessionId}`, `/s/${sessionId}/`, `/s/${sessionId}/search/items`]) {
      for (const [shape, headers, body] of QUERY_REFUSED_SHAPES) {
        const label = `${shape} to ${path}`;
        const ids: Record<string, string> = {};

        for (const method of ['QUERY', 'POST']) {
          const response = parseRawResponse(
            await readUntilClosed(handcrafted(`${method} ${path} HTTP/1.1`, headers, body)),
          );

          // The session's configured answer, with the id of what was stored.
          assert.equal(response.status, 202, `${method}, ${label}: ${response.body}`);
          assert.equal(response.body, '{"queued":true}', `${method}, ${label}`);
          assert.deepEqual(headerValues(response.headers, 'x-fixture'), ['accepted']);
          ids[method] = headerValues(response.headers, 'x-qa-tools-request-id')[0] ?? '';
          assert.match(ids[method], UUID_V4, `${method}, ${label}`);
        }

        const stored = await storedRequests(sessionId);
        const query = stored.find((row) => row.id === ids.QUERY);
        const post = stored.find((row) => row.id === ids.POST);

        assert.ok(query && post, label);
        assert.equal(query.method, 'QUERY', label);
        // Headers as sent - an absent Content-Type stays absent, and nothing
        // the receiver put on Fastify's view is stored - and the body as the
        // POST's.
        assert.deepEqual(query.headers, post.headers, label);
        assert.deepEqual(
          query.headers.map(([name]) => name),
          ['Host', 'Connection', ...headers.map((line) => line.slice(0, line.indexOf(':')))],
          label,
        );
        assert.deepEqual(query.body, Buffer.from(body), label);
        assert.deepEqual(query.body, post.body, label);
        assert.equal(query.body_size, post.body_size, label);
        assert.equal(query.path, post.path, label);
        assert.equal(
          query.raw_request.toString('latin1').replace(/^QUERY /, 'POST '),
          post.raw_request.toString('latin1'),
          label,
        );
      }
    }

    // In the session's list, as the inspector reads it.
    const listed = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/requests` });
    const methods = listed.json<RequestListItem[]>().map((item) => item.method);

    assert.equal(methods.filter((method) => method === 'QUERY').length, 15);
  });

  it('applies the configured delay and the body limit as for a POST', async () => {
    const sessionId = await newCustomSession({ status: 200, delayMs: 200 });
    const started = Date.now();
    const response = parseRawResponse(
      await readUntilClosed(
        handcrafted(`QUERY /s/${sessionId} HTTP/1.1`, ['Content-Length: 0'], ''),
      ),
    );

    assert.equal(response.status, 200, response.body);
    assert.ok(Date.now() - started >= 190, 'the configured delay was not waited out');

    // Declared over the limit and never sent: the limit refuses it on the
    // declaration, before a byte of the body is read (D008).
    const oversized = parseRawResponse(
      await readUntilClosed(
        handcrafted(
          `QUERY /s/${sessionId} HTTP/1.1`,
          [`Content-Length: ${MAX_BODY_BYTES + 1}`],
          '',
        ),
      ),
    );

    assert.equal(oversized.status, 413, oversized.body);
    assert.deepEqual(JSON.parse(oversized.body), { errorCode: 1004, message: 'Payload too large' });
    assert.equal((await storedRequests(sessionId)).length, 1);
  });

  it('answers an unknown or expired session as a POST is answered, and stores nothing', async (t) => {
    await withExpiredSession(t, pool, newSession, async (expiredSessionId) => {
      for (const [sessionId, status, answer] of [
        ['z'.repeat(43), 404, { errorCode: 1001, message: 'Session not found' }],
        ['short', 404, { errorCode: 1001, message: 'Session not found' }],
        [expiredSessionId, 410, { errorCode: 1002, message: 'Session expired' }],
      ] as [string, number, object][]) {
        for (const [shape, headers, body] of QUERY_REFUSED_SHAPES) {
          for (const method of ['QUERY', 'POST']) {
            const label = `${method}, ${shape}, ${sessionId}`;
            const response = parseRawResponse(
              await readUntilClosed(
                handcrafted(`${method} /s/${sessionId} HTTP/1.1`, headers, body),
              ),
            );

            assert.equal(response.status, status, label);
            assert.deepEqual(JSON.parse(response.body), answer, label);
            assert.deepEqual(headerValues(response.headers, 'x-qa-tools-request-id'), [], label);
            assert.deepEqual(
              headerValues(response.headers, 'x-webhook-inspector-request-id'),
              [],
              label,
            );
          }
        }
      }

      assert.equal((await storedRequests(expiredSessionId)).length, 0);
    });
  });

  it('leaves the shapes Fastify never refused as they were', async () => {
    const sessionId = await newSession();
    const cases: [string, string[], string, string][] = [
      [
        'a Content-Type and a body',
        ['Content-Type: text/plain', 'Content-Length: 5'],
        'hello',
        'hello',
      ],
      [
        'chunked and empty',
        ['Content-Type: text/plain', 'Transfer-Encoding: chunked'],
        '0\r\n\r\n',
        '',
      ],
      [
        'a Content-Type that is not a media type (D138)',
        ['Content-Type: json', 'Content-Length: 5'],
        'hello',
        'hello',
      ],
    ];

    for (const [shape, headers, body, storedBody] of cases) {
      const response = parseRawResponse(
        await readUntilClosed(handcrafted(`QUERY /s/${sessionId} HTTP/1.1`, headers, body)),
      );
      const id = headerValues(response.headers, 'x-qa-tools-request-id')[0];

      assert.equal(response.status, 200, `${shape}: ${response.body}`);

      const stored = (await storedRequests(sessionId)).find((row) => row.id === id);

      assert.equal(stored?.method, 'QUERY', shape);
      assert.equal(stored?.body.toString(), storedBody, shape);
      assert.deepEqual(
        stored?.headers.slice(2),
        headers.map((line) => [
          line.slice(0, line.indexOf(':')),
          line.slice(line.indexOf(':') + 2),
        ]),
        shape,
      );
    }
  });

  it('answers 400 / 1008 everywhere outside the receiver, stores nothing and logs no Unhandled error', async () => {
    const sessionId = await newSession();
    const cases: [string, string[], string, string][] = [
      [
        'no Content-Type, Content-Length: 0',
        ['Content-Length: 0'],
        '',
        'Request must have a Content-Type header',
      ],
      [
        'no Content-Type, a body',
        ['Content-Length: 5'],
        'hello',
        'Request must have a Content-Type header',
      ],
      [
        'a Content-Type, Content-Length: 0',
        ['Content-Type: text/plain', 'Content-Length: 0'],
        '',
        'Request must have content',
      ],
      [
        'a Content-Type, no framing',
        ['Content-Type: application/json'],
        '',
        'Request must have content',
      ],
    ];

    // A path under `/s/<id>/` was one of these until D173; it is the
    // receiver's now, and the test above captures a QUERY there.
    const log = await withLoggedServer(async (loggedPort) => {
      for (const path of [
        `/v/${sessionId}`,
        '/api/sessions',
        `/api/sessions/${sessionId}/requests`,
        '/nowhere',
      ]) {
        for (const [shape, headers, body, message] of cases) {
          const label = `${shape} to ${path}`;
          const response = parseRawResponse(
            await readUntilClosed(handcrafted(`QUERY ${path} HTTP/1.1`, headers, body), loggedPort),
          );

          assert.equal(response.status, 400, label);
          assert.deepEqual(JSON.parse(response.body), { errorCode: 1008, message }, label);
          assert.deepEqual(headerValues(response.headers, 'x-qa-tools-request-id'), [], label);
          assert.deepEqual(
            headerValues(response.headers, 'x-webhook-inspector-request-id'),
            [],
            label,
          );
        }
      }
    });

    assert.doesNotMatch(log, /Unhandled error/);
    assert.equal((await storedRequests(sessionId)).length, 0);
  });
});

describe('rejecting requests', () => {
  /**
   * Requests stored under a path that starts with `prefix`, whatever session
   * they would belong to - the only way to show that an id no session has left
   * nothing behind.
   */
  async function storedUnder(prefix: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM requests WHERE starts_with(path, $1 || '/')",
      [prefix],
    );

    return result.rows[0]?.count ?? -1;
  }

  it('answers an unknown or malformed session under a path 404 / 1001 and stores nothing (D173)', async () => {
    // Unknown, too short, a character no id has, and empty: the segment after
    // `/s/` decides, exactly as on the endpoint, and never `1000`, which would
    // say the path was wrong when the session is (D062 as amended).
    for (const id of ['z'.repeat(43), 'short', `${'z'.repeat(42)}.`, '']) {
      for (const method of ['POST', 'GET', 'PROPFIND', 'DELETE']) {
        for (const rest of ['/x', '/stripe/events?livemode=false', '/folder/']) {
          const label = `${method} /s/${id}${rest}`;
          const response = parseRawResponse(
            await readUntilClosed(
              handcrafted(
                `${method} /s/${id}${rest} HTTP/1.1`,
                ['Content-Type: application/json', 'Content-Length: 2'],
                '{}',
              ),
            ),
          );

          assert.equal(response.status, 404, label);
          assert.deepEqual(
            JSON.parse(response.body),
            { errorCode: 1001, message: 'Session not found' },
            label,
          );
          assert.deepEqual(headerValues(response.headers, 'x-qa-tools-request-id'), [], label);
          assert.deepEqual(
            headerValues(response.headers, 'x-webhook-inspector-request-id'),
            [],
            label,
          );
          assert.deepEqual(headerValues(response.headers, 'x-content-type-options'), ['nosniff']);
          assert.deepEqual(headerValues(response.headers, 'content-security-policy'), [
            SANDBOX_POLICY,
          ]);
        }
      }

      assert.equal(await storedUnder(`/s/${id}`), 0, `something was stored under /s/${id}`);
    }
  });

  it('leaves an id segment over 100 characters to the router, 414 outside the contract, on the endpoint and under it', async () => {
    // find-my-way's `maxParamLength`: the router refuses the parameter before
    // any route or hook, as on every route with one. An id is 43 characters.
    for (const target of [`/s/${'a'.repeat(101)}`, `/s/${'a'.repeat(101)}/stripe/events`]) {
      const response = parseRawResponse(
        await readUntilClosed(handcrafted(`POST ${target} HTTP/1.1`, ['Content-Length: 0'], '')),
      );
      const body = JSON.parse(response.body) as { errorCode?: number; code?: string };

      assert.equal(response.status, 414, target);
      assert.equal(body.errorCode, undefined, target);
      assert.equal(body.code, 'FST_ERR_MAX_PARAM_LENGTH', target);
      assert.deepEqual(headerValues(response.headers, 'x-content-type-options'), [], target);
      assert.deepEqual(headerValues(response.headers, 'content-security-policy'), [], target);
    }

    // At 100 characters it is still the receiver's, and an id that cannot be one.
    const atLimit = await receiver.inject({ method: 'POST', url: `/s/${'a'.repeat(100)}/x` });

    assert.equal(atLimit.statusCode, 404);
    assert.deepEqual(atLimit.json(), { errorCode: 1001, message: 'Session not found' });
    assert.equal(await storedUnder(`/s/${'a'.repeat(101)}`), 0);
  });

  it('answers an expired session under a path 410 / 1002 and stores nothing (D173)', async (t) => {
    await withExpiredSession(t, pool, newSession, async (sessionId) => {
      const response = await receiver.inject({
        method: 'POST',
        url: `/s/${sessionId}/stripe/events`,
        payload: 'x',
      });

      assert.equal(response.statusCode, 410);
      assert.deepEqual(response.json(), { errorCode: 1002, message: 'Session expired' });
      assert.equal(response.headers['x-qa-tools-request-id'], undefined);
      assert.equal(response.headers['x-webhook-inspector-request-id'], undefined);
      assert.equal((await storedRequests(sessionId)).length, 0);
    });
  });

  it('leaves /api, /v/<id> and a bare /s to the not-found route, 404 / 1000 (D062)', async () => {
    const sessionId = await newSession();

    // Only paths under `/s/<id>/` changed (D173). The backend serves no `/v/`
    // address - the frontend does - and `/s` without its slash names no
    // session.
    for (const url of [
      `/api/sessions/${sessionId}/extra`,
      `/api/sessions/${sessionId}/requests/extra/more`,
      '/api/nowhere',
      `/v/${sessionId}`,
      `/v/${sessionId}/extra`,
      '/s',
    ]) {
      for (const method of ['GET', 'POST']) {
        const response = await app.inject({ method: method as 'GET', url });

        assert.equal(response.statusCode, 404, `${method} ${url}`);
        assert.deepEqual(response.json(), { errorCode: 1000, message: 'Not found' }, url);
        assert.equal(response.headers['x-qa-tools-request-id'], undefined, url);
        assert.equal(response.headers['x-webhook-inspector-request-id'], undefined, url);
      }
    }

    assert.equal((await storedRequests(sessionId)).length, 0);
  });

  it('answers an id the router cannot decode 404 / 1001, and leaves any other such URL to Fastify', async () => {
    // Given to the router escaped once more (D173), so the id is compared as
    // sent, fails the pattern and is answered in the error contract.
    for (const target of ['/s/%zz', '/s/%zz/stripe/events', `/s/${'z'.repeat(40)}%E9`]) {
      const response = parseRawResponse(
        await readUntilClosed(handcrafted(`POST ${target} HTTP/1.1`, [], '')),
      );

      assert.equal(response.status, 404, target);
      assert.deepEqual(
        JSON.parse(response.body),
        { errorCode: 1001, message: 'Session not found' },
        target,
      );
      assert.deepEqual(headerValues(response.headers, 'x-content-type-options'), ['nosniff']);
      assert.deepEqual(headerValues(response.headers, 'content-security-policy'), [SANDBOX_POLICY]);
      assert.deepEqual(headerValues(response.headers, 'x-qa-tools-request-id'), [], target);
      assert.deepEqual(
        headerValues(response.headers, 'x-webhook-inspector-request-id'),
        [],
        target,
      );
    }

    // Outside `/s/` nothing changed: Fastify's router refuses the path before
    // any route, straight to the socket, with no errorCode and no hook, as the
    // parser's refusals of D142 are answered.
    for (const target of ['/api/sessions/%zz', '/api/sessions/caf%E9/requests', '/nowhere/%FF']) {
      const response = parseRawResponse(
        await readUntilClosed(handcrafted(`GET ${target} HTTP/1.1`, [], ''), apiPort),
      );

      assert.equal(response.status, 400, target);
      assert.equal(
        (JSON.parse(response.body) as { errorCode?: number }).errorCode,
        undefined,
        target,
      );
      assert.deepEqual(headerValues(response.headers, 'x-content-type-options'), [], target);
      assert.deepEqual(headerValues(response.headers, 'content-security-policy'), [], target);
    }
  });

  it('answers 404 for an unknown session', async () => {
    const response = await receiver.inject({ method: 'POST', url: `/s/${'z'.repeat(43)}` });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { errorCode: 1001, message: 'Session not found' });
    assert.equal(response.headers['x-qa-tools-request-id'], undefined);
    assert.equal(response.headers['x-webhook-inspector-request-id'], undefined);
  });

  it('answers 410 for an expired session and stores nothing', async (t) => {
    await withExpiredSession(t, pool, newSession, async (sessionId) => {
      const response = await receiver.inject({
        method: 'POST',
        url: `/s/${sessionId}`,
        payload: 'x',
      });

      assert.equal(response.statusCode, 410);
      assert.deepEqual(response.json(), { errorCode: 1002, message: 'Session expired' });
      assert.equal(response.headers['x-qa-tools-request-id'], undefined);
      assert.equal(response.headers['x-webhook-inspector-request-id'], undefined);
      assert.equal((await storedRequests(sessionId)).length, 0);
    });
  });

  it('accepts a body of exactly 1 MB', async () => {
    const sessionId = await newSession();

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      payload: Buffer.alloc(MAX_BODY_BYTES, 'a'),
    });

    assert.equal(response.statusCode, 200);
    assert.equal((await storedRequests(sessionId))[0]?.body_size, MAX_BODY_BYTES);
  });

  it('answers 413 above 1 MB and stores nothing (D008)', async () => {
    const sessionId = await newSession();

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      payload: Buffer.alloc(MAX_BODY_BYTES + 1, 'a'),
    });

    assert.equal(response.statusCode, 413);
    assert.deepEqual(response.json(), { errorCode: 1004, message: 'Payload too large' });
    assert.equal(response.headers['x-qa-tools-request-id'], undefined);
    assert.equal(response.headers['x-webhook-inspector-request-id'], undefined);
    assert.equal((await storedRequests(sessionId)).length, 0);
  });

  it('answers 413 above 1 MB whatever the Content-Type says, and stores nothing (D138)', async () => {
    // The replacement lets an unparseable declaration reach the body limit,
    // where it used to be refused with 415 before the body was read; it does
    // not let an oversized body through.
    const sessionId = await newSession();

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      headers: { 'content-type': 'json' },
      payload: Buffer.alloc(MAX_BODY_BYTES + 1, 'a'),
    });

    assert.equal(response.statusCode, 413, response.body);
    assert.deepEqual(response.json(), { errorCode: 1004, message: 'Payload too large' });
    assert.equal(response.headers['x-qa-tools-request-id'], undefined);
    assert.equal(response.headers['x-webhook-inspector-request-id'], undefined);
    assert.equal((await storedRequests(sessionId)).length, 0);
  });

  it('answers 413 before the session is looked at (D046)', async () => {
    const expiredSessionId = await newSession();
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      expiredSessionId,
    ]);

    const oversized = Buffer.alloc(MAX_BODY_BYTES + 1, 'a');

    // Fastify enforces the body limit before the route runs, so the payload
    // wins over both session answers. Accepted for v0.1 and pinned here so the
    // documented behaviour cannot drift unnoticed.
    for (const [state, sessionId] of [
      ['unknown', 'z'.repeat(43)],
      ['expired', expiredSessionId],
    ]) {
      const response = await receiver.inject({
        method: 'POST',
        url: `/s/${sessionId}`,
        payload: oversized,
      });

      assert.equal(response.statusCode, 413, `unexpected status for an ${state} session`);
      assert.deepEqual(response.json(), { errorCode: 1004, message: 'Payload too large' });
      assert.equal(response.headers['x-qa-tools-request-id'], undefined);
      assert.equal(response.headers['x-webhook-inspector-request-id'], undefined);
    }

    assert.equal((await storedRequests(expiredSessionId)).length, 0);
  });
});

describe('retention', () => {
  it('keeps only the newest 1000 requests (D006)', async () => {
    const sessionId = await newSession();

    // 1000 older requests, inserted directly so the test stays fast. Each body
    // carries its age in seconds, so the evicted one can be named exactly.
    await pool.query(
      `INSERT INTO requests (session_id, method, headers, body, body_size, raw_request, received_at)
       SELECT $1, 'OLD', '[]'::jsonb, n::text::bytea, 0, ''::bytea, now() - make_interval(secs => n)
       FROM generate_series(1, 1000) AS n`,
      [sessionId],
    );

    await receiver.inject({ method: 'POST', url: `/s/${sessionId}`, payload: 'newest' });

    const stored = await storedRequests(sessionId);
    const bodies = stored.map((row) => row.body.toString());

    assert.equal(stored.length, 1000);
    assert.equal(bodies[0], 'newest');
    // The oldest request, 1000 seconds back, is the one that was dropped.
    assert.equal(bodies.includes('1000'), false);
    assert.equal(bodies.includes('999'), true);
  });
});

describe('concurrency', () => {
  it('holds the 1000 limit when requests arrive at once (D006)', async () => {
    const sessionId = await newSession();

    await pool.query(
      `INSERT INTO requests (session_id, method, headers, body, body_size, raw_request, received_at)
       SELECT $1, 'OLD', '[]'::jsonb, ''::bytea, 0, ''::bytea, now() - make_interval(secs => n)
       FROM generate_series(1, 1000) AS n`,
      [sessionId],
    );

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        receiver.inject({ method: 'POST', url: `/s/${sessionId}`, payload: `concurrent-${index}` }),
      ),
    );

    for (const response of responses) {
      assert.equal(response.statusCode, 200);
    }

    const stored = await storedRequests(sessionId);
    const bodies = new Set(stored.map((row) => row.body.toString()));

    assert.equal(stored.length, 1000);

    // Every concurrent request was kept: the limit was held by dropping old
    // requests, not by losing new ones.
    for (let index = 0; index < 10; index += 1) {
      assert.ok(bodies.has(`concurrent-${index}`), `concurrent-${index} was lost`);
    }
  });
});

describe('expiration while waiting for the lock', () => {
  it('refuses a request whose session expires during the wait (D019)', async () => {
    const sessionId = await newSession();

    // Hold the session row so the incoming request has to wait, and set the
    // session to expire during that wait. Its transaction therefore starts
    // while the session is still valid and acquires the lock after it is not.
    const holder = await pool.connect();

    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
      await holder.query(
        `UPDATE sessions SET expires_at = clock_timestamp() + interval '200 milliseconds'
         WHERE id = $1`,
        [sessionId],
      );

      const pending = receiver.inject({ method: 'POST', url: `/s/${sessionId}`, payload: 'late' });

      // Long enough for the request to be blocked on the lock, and for the
      // session to expire while it waits.
      await delay(600);
      await holder.query('COMMIT');

      const response = await pending;

      assert.equal(response.statusCode, 410);
      assert.deepEqual(response.json(), { errorCode: 1002, message: 'Session expired' });
      assert.equal((await storedRequests(sessionId)).length, 0);
    } finally {
      holder.release();
    }
  });
});

/** Waits until some connection is blocked by the one whose backend is `pid`, 5 s at most. */
async function awaitBlockedBy(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await pool.query<{ blocked: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))) AS blocked',
      [pid],
    );

    if (result.rows[0]?.blocked === true) {
      return;
    }

    await delay(5);
  }

  throw new Error('no connection waited for the lock');
}

describe('the receipt time (D065, D196)', () => {
  /**
   * Within a session, receipt order is the order in which captures took the
   * session's lock, so a capture committed after a list was answered is
   * received after everything that list could hold, and a client listing
   * `after` the newest it saw finds it. A time read when the capture's
   * transaction began, before the wait, broke that.
   */
  it('is read once the capture holds the session’s lock, after the wait', async () => {
    const sessionId = await newSession();
    const holder = await pool.connect();
    let open = false;
    let settled: Promise<unknown> = Promise.resolve();

    try {
      await holder.query('BEGIN');
      open = true;
      await holder.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);

      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid as number;
      const pending = receiver.inject({
        method: 'POST',
        url: `/s/${sessionId}`,
        payload: 'waited',
      });

      settled = pending.catch(() => undefined);
      await awaitBlockedBy(pid);

      // Read while the capture waits, so after its transaction began.
      const waiting = (await holder.query<{ at: string }>('SELECT clock_timestamp()::text AS at'))
        .rows[0]?.at as string;

      await holder.query('COMMIT');
      open = false;

      const response = await pending;

      assert.equal(response.statusCode, 200, response.body);

      const stored = await pool.query<{ id: string; later: boolean }>(
        'SELECT id, received_at > $2::timestamptz AS later FROM requests WHERE session_id = $1',
        [sessionId, waiting],
      );

      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0]?.id, response.headers['x-qa-tools-request-id']);
      assert.equal(stored.rows[0]?.id, response.headers['x-webhook-inspector-request-id']);
      assert.equal(stored.rows[0]?.later, true, 'the receipt time was read before the wait');
    } finally {
      if (open) {
        await holder.query('ROLLBACK');
      }

      holder.release();
      await settled;
    }
  });
});

describe('the configured response', () => {
  it('answers the configured status, headers and body byte for byte', async () => {
    // Duplicate keys and an order jsonb would not preserve: the body is stored
    // as TEXT precisely so that it comes back as it was typed (D101).
    const body = '{"b":1,"a":2,"a":3}';
    const sessionId = await newCustomSession({
      status: 201,
      headers: [
        ['x-trace-id', 'abc'],
        ['x-a', '1'],
        ['X-A', '2'],
      ],
      body,
    });

    const response = parseRawResponse(await readRawResponse(webhookRequest(sessionId)));

    assert.equal(response.status, 201);
    assert.equal(response.body, body);
    // Nothing is injected into a custom body: the id travels in the header.
    assert.equal(response.body.includes('requestId'), false);
    assert.deepEqual(headerValues(response.headers, 'x-trace-id'), ['abc']);
    // Both duplicates are present, in the configured order (D045).
    assert.deepEqual(headerValues(response.headers, 'x-a'), ['1', '2']);
    assert.deepEqual(headerValues(response.headers, 'content-type'), [
      'application/json; charset=utf-8',
    ]);
    assert.deepEqual(headerValues(response.headers, 'x-content-type-options'), ['nosniff']);
    assert.deepEqual(headerValues(response.headers, 'content-security-policy'), [SANDBOX_POLICY]);

    const [stored] = await storedRequests(sessionId);
    assert.deepEqual(headerValues(response.headers, 'x-qa-tools-request-id'), [
      stored?.id as string,
    ]);
    assert.deepEqual(headerValues(response.headers, 'x-webhook-inspector-request-id'), [
      stored?.id as string,
    ]);
  });

  it('sends the configured headers in the configured order (D101)', async () => {
    // A digit-only name is a valid HTTP token, and the validator accepts one.
    // Collapsing the configured pairs into a plain object would hoist it to the
    // front of the head, because JavaScript orders integer-like keys first.
    const sessionId = await newCustomSession({
      status: 200,
      headers: [
        ['x-a', '1'],
        ['123', '2'],
        ['x-b', '3'],
      ],
      body: '{}',
    });

    const response = parseRawResponse(await readRawResponse(webhookRequest(sessionId)));
    const configured = response.headers.filter(([name]) => ['x-a', '123', 'x-b'].includes(name));

    assert.deepEqual(configured, [
      ['x-a', '1'],
      ['123', '2'],
      ['x-b', '3'],
    ]);
  });

  it('sends a configured empty header value on the wire', async () => {
    const sessionId = await newCustomSession({ status: 200, headers: [['x-trace-id', '']] });

    const response = parseRawResponse(await readRawResponse(webhookRequest(sessionId)));

    assert.deepEqual(headerValues(response.headers, 'x-trace-id'), ['']);
  });

  it('answers an unregistered configured status with exactly that status', async () => {
    for (const status of [299, 512]) {
      const sessionId = await newCustomSession({ status });

      const response = parseRawResponse(await readRawResponse(webhookRequest(sessionId)));

      assert.equal(response.status, status);
    }
  });

  for (const [description, configuration] of [
    ['no configured body', { status: 200 }],
    ['a status that forbids one', { status: 204 }],
  ] as [string, Partial<ResponseConfig>][]) {
    it(`sends neither Content-Type nor Content-Length with ${description}`, async () => {
      const sessionId = await newCustomSession(configuration);

      const response = parseRawResponse(await readRawResponse(webhookRequest(sessionId)));

      assert.equal(response.status, configuration.status);
      assert.deepEqual(headerValues(response.headers, 'content-type'), []);
      assert.deepEqual(headerValues(response.headers, 'content-length'), []);
      // Neither header describes a representation, so both still apply.
      assert.deepEqual(headerValues(response.headers, 'x-content-type-options'), ['nosniff']);
      assert.deepEqual(headerValues(response.headers, 'content-security-policy'), [SANDBOX_POLICY]);
      assert.equal(headerValues(response.headers, 'x-qa-tools-request-id').length, 1);
      assert.equal(headerValues(response.headers, 'x-webhook-inspector-request-id').length, 1);
    });
  }

  it('answers a broken JSON body exactly, under application/json (D179)', async () => {
    const sessionId = await newCustomSession({ status: 200, body: '{"a":' });

    const response = parseRawResponse(await readRawResponse(webhookRequest(sessionId)));

    assert.equal(response.status, 200);
    assert.equal(response.body, '{"a":');
    assert.deepEqual(headerValues(response.headers, 'content-type'), [
      'application/json; charset=utf-8',
    ]);
    assert.deepEqual(headerValues(response.headers, 'content-length'), ['5']);

    // The record holds what was sent (D109).
    const [record] = await awaitRecorded(sessionId, 1);

    assert.equal(record?.body?.toString(), '{"a":');
    assert.equal(record?.body_size, 5);
    assert.deepEqual(headerValues(record?.headers ?? [], 'content-type'), [
      'application/json; charset=utf-8',
    ]);
  });

  it('answers a configured Content-Type as configured, and adds no second one (D179)', async () => {
    const sessionId = await newCustomSession({
      status: 200,
      headers: [
        ['x-before', '1'],
        ['Content-Type', 'text/plain'],
        ['x-after', '2'],
      ],
      body: 'OK',
    });

    const response = parseRawResponse(await readRawResponse(webhookRequest(sessionId)));
    const [request] = await storedRequests(sessionId);
    const [record] = await awaitRecorded(sessionId, 1);
    const sent: [string, string][] = [
      ['x-before', '1'],
      ['content-type', 'text/plain'],
      ['x-after', '2'],
      ['x-webhook-inspector-request-id', request?.id as string],
      ['x-qa-tools-request-id', request?.id as string],
      ['x-content-type-options', 'nosniff'],
      ['content-security-policy', SANDBOX_POLICY],
      ['content-length', '2'],
    ];

    assert.equal(response.status, 200);
    assert.equal(response.body, 'OK');
    // Exactly `text/plain`: no charset added, and no application/json after it.
    assert.deepEqual(headerValues(response.headers, 'content-type'), ['text/plain']);
    // In its configured place, among the configured pairs.
    assert.deepEqual(
      response.headers.filter(([name]) => sent.some(([expected]) => expected === name)),
      sent,
    );
    assert.deepEqual(record?.headers, sent);
    assert.equal(record?.body?.toString(), 'OK');
    assert.ok(record?.raw_response?.toString().includes('\r\ncontent-type: text/plain\r\n'));
  });

  it('sends every configured Content-Type, duplicates included, as configured (D179)', async () => {
    const sessionId = await newCustomSession({
      status: 200,
      headers: [
        ['content-type', 'text/xml'],
        ['CONTENT-TYPE', 'text/plain; charset=windows-1251'],
      ],
      body: '<a/>',
    });

    const response = parseRawResponse(await readRawResponse(webhookRequest(sessionId)));

    assert.deepEqual(headerValues(response.headers, 'content-type'), [
      'text/xml',
      'text/plain; charset=windows-1251',
    ]);
  });

  for (const [description, configuration, method] of [
    ['no configured body', { status: 200 }, 'POST'],
    ['a status that forbids one', { status: 204 }, 'POST'],
    ['a status that forbids one, 205', { status: 205 }, 'POST'],
    ['a status that forbids one, 304', { status: 304 }, 'POST'],
    ['a HEAD request', { status: 200, body: 'OK' }, 'HEAD'],
    ['a HEAD request and no body', { status: 200 }, 'HEAD'],
  ] as [string, Partial<ResponseConfig>, string][]) {
    it(`sends a configured Content-Type with ${description} (D179)`, async () => {
      const sessionId = await newCustomSession({
        ...configuration,
        headers: [['Content-Type', 'text/plain']],
      });

      const response = parseRawResponse(
        await readRawResponse(webhookRequest(sessionId, { method })),
      );
      const [record] = await awaitRecorded(sessionId, 1);

      assert.equal(response.status, configuration.status);
      assert.deepEqual(headerValues(response.headers, 'content-type'), ['text/plain']);
      assert.deepEqual(headerValues(record?.headers ?? [], 'content-type'), ['text/plain']);
      assert.deepEqual(headerValues(response.headers, 'content-security-policy'), [SANDBOX_POLICY]);
      assert.deepEqual(headerValues(response.headers, 'x-content-type-options'), ['nosniff']);
    });
  }

  it('answers the v0.1 default for a session whose configuration is NULL (D102)', async () => {
    const sessionId = await newSession();

    const stored = await pool.query<{
      response_status: number | null;
      response_headers: unknown;
      response_body: string | null;
      response_delay_ms: number | null;
    }>(
      `SELECT response_status, response_headers, response_body, response_delay_ms
       FROM sessions WHERE id = $1`,
      [sessionId],
    );

    assert.deepEqual(stored.rows[0], {
      response_status: null,
      response_headers: null,
      response_body: null,
      response_delay_ms: null,
    });

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      payload: 'x',
    });
    const [captured] = await storedRequests(sessionId);

    assert.equal(response.statusCode, 200);
    assert.ok(captured);
    // The v0.1 default of today, describing the request it answers (D223).
    assert.equal(response.body, await defaultAnswerText(app, sessionId, captured.id, APP_ORIGIN));
  });
});

/**
 * A configured `Location` on a `3xx` (D247): sent in its configured place by
 * the unchanged send path, recorded with the response (D109), absent from
 * every refusal, and followed by a client that follows redirects into a
 * second capture of the same session. Read over raw sockets, so nothing
 * follows a redirect unless the test asks for it.
 */
describe('a Location on a redirect (D247)', () => {
  it('answers 302 with it in its configured place, beside nosniff, the sandbox and the request id, and records it', async () => {
    const created = await newSession();
    const target = `/s/${created}/after`;
    const sessionId = await newCustomSession({
      status: 302,
      headers: [
        ['x-before', '1'],
        ['Location', target],
        ['x-after', '2'],
      ],
    });

    const read = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });

    assert.deepEqual(read.json<{ response: ResponseConfig }>().response.headers, [
      ['x-before', '1'],
      ['Location', target],
      ['x-after', '2'],
    ]);

    const response = parseRawResponse(await readRawResponse(webhookRequest(sessionId)));
    const [stored] = await storedRequests(sessionId);

    assert.equal(response.status, 302);
    assert.deepEqual(response.headers.slice(0, 3), [
      ['x-before', '1'],
      ['location', target],
      ['x-after', '2'],
    ]);
    assert.deepEqual(headerValues(response.headers, 'location'), [target]);
    assert.deepEqual(headerValues(response.headers, 'x-content-type-options'), ['nosniff']);
    assert.deepEqual(headerValues(response.headers, 'content-security-policy'), [SANDBOX_POLICY]);
    assert.deepEqual(headerValues(response.headers, 'x-qa-tools-request-id'), [
      stored?.id as string,
    ]);

    const [record] = await awaitRecorded(sessionId, 1);

    assert.equal(record?.status, 302);
    assert.deepEqual(headerValues(record?.headers ?? [], 'location'), [target]);
    assert.ok(record?.raw_response?.toString().includes(`\r\nlocation: ${target}\r\n`));

    const detail = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests/${stored?.id as string}`,
    });

    assert.deepEqual(
      headerValues(detail.json<RequestDetails>().response?.headers ?? [], 'location'),
      [target],
    );
  });

  it('sends several Location pairs in their order, and an encoded line break as the text it is', async () => {
    const sessionId = await newCustomSession({
      status: 301,
      headers: [
        ['Location', '/s/a/1'],
        ['x-mid', 'm'],
        ['LOCATION', '/s/a/%0d%0aSet-Cookie:%20a=1'],
      ],
    });

    const response = parseRawResponse(await readRawResponse(webhookRequest(sessionId)));

    assert.equal(response.status, 301);
    assert.deepEqual(response.headers.slice(0, 3), [
      ['location', '/s/a/1'],
      ['x-mid', 'm'],
      ['location', '/s/a/%0d%0aSet-Cookie:%20a=1'],
    ]);
    assert.deepEqual(headerValues(response.headers, 'set-cookie'), []);
  });

  it('answers HEAD with Location and no body, its bytes marked as not sent, after the delay', async () => {
    const delayMs = 300;
    const sessionId = await newCustomSession({
      status: 302,
      headers: [['Location', '/s/x/after']],
      body: 'Moved',
      delayMs,
    });

    const started = Date.now();
    const response = parseRawResponse(
      await readRawResponse(webhookRequest(sessionId, { method: 'HEAD' })),
    );

    assert.ok(Date.now() - started >= delayMs, 'answered before the delay');
    assert.equal(response.status, 302);
    assert.equal(response.body, '');
    assert.deepEqual(headerValues(response.headers, 'location'), ['/s/x/after']);

    const [record] = await awaitRecorded(sessionId, 1);
    const [stored] = await storedRequests(sessionId);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests/${stored?.id as string}`,
    });

    assert.equal(record?.body_suppressed, true);
    assert.equal(detail.json<RequestDetails>().response?.bodySuppressed, true);
    assert.deepEqual(
      headerValues(detail.json<RequestDetails>().response?.headers ?? [], 'location'),
      ['/s/x/after'],
    );
  });

  it('answers 404 after deletion, 410 once expired and 413 above 1 MB without it', async (t) => {
    const configuration: Partial<ResponseConfig> = {
      status: 302,
      headers: [['Location', '/s/x/after']],
    };
    const oversized = await newCustomSession(configuration);
    const tooLarge = await receiver.inject({
      method: 'POST',
      url: `/s/${oversized}`,
      payload: Buffer.alloc(MAX_BODY_BYTES + 1, 'a'),
    });

    assert.equal(tooLarge.statusCode, 413);
    assert.equal(tooLarge.json<{ errorCode: number }>().errorCode, 1004);
    assert.equal(tooLarge.headers.location, undefined);

    const deleted = await newCustomSession(configuration);

    assert.equal(
      (await app.inject({ method: 'DELETE', url: `/api/sessions/${deleted}` })).statusCode,
      204,
    );

    const gone = await receiver.inject({ method: 'POST', url: `/s/${deleted}`, payload: 'x' });

    assert.equal(gone.statusCode, 404);
    assert.equal(gone.json<{ errorCode: number }>().errorCode, 1001);
    assert.equal(gone.headers.location, undefined);

    await withExpiredSession(
      t,
      pool,
      () => newCustomSession(configuration),
      async (sessionId) => {
        const expired = await receiver.inject({
          method: 'POST',
          url: `/s/${sessionId}/under/a/path`,
          payload: 'x',
        });

        assert.equal(expired.statusCode, 410);
        assert.equal(expired.json<{ errorCode: number }>().errorCode, 1002);
        assert.equal(expired.headers.location, undefined);
      },
    );
  });

  it('is followed by a client into a second capture of the session: 307, then the queue’s 200', async () => {
    const sessionId = await newSession();
    const target = `/s/${sessionId}/after`;
    const queued = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/queue`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        steps: [
          { status: 307, headers: [['Location', target]] },
          { status: 200, body: 'done' },
        ],
      }),
    });

    assert.equal(queued.statusCode, 200, queued.body);

    const body = '{"event":"order.paid","n":1}';
    const followed = await fetch(`http://127.0.0.1:${port}/s/${sessionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
      body,
    });

    assert.equal(followed.status, 200);
    assert.equal(followed.redirected, true);
    assert.equal(await followed.text(), 'done');

    const [second, first] = await awaitStoredRequests(sessionId, 2);

    assert.equal(first?.path, `/s/${sessionId}`);
    assert.equal(second?.path, target);

    for (const captured of [first, second]) {
      // The sender's own header case is kept (D045); the client's is compared folded.
      const sent = (captured?.headers ?? []).map(([name, value]): [string, string] => [
        name.toLowerCase(),
        value,
      ]);

      assert.equal(captured?.method, 'POST');
      assert.equal(captured?.body.toString(), body);
      assert.deepEqual(headerValues(sent, 'content-type'), ['application/json']);
      assert.deepEqual(headerValues(sent, 'x-trace'), ['abc']);
    }

    const records = await awaitRecorded(sessionId, 2);

    assert.deepEqual(
      records.map((record) => record.status),
      [200, 307],
    );
  });
});

/**
 * A default session's answer says what was stored and links it in the
 * inspector (D223): nine keys, `ok` first and `requestId` second, each value
 * equal to the stored row, the list, the detail and `X-QA-Tools-Request-Id`,
 * and nothing the request carried. Over real sockets, so the target, the
 * headers and the body are exactly the bytes written here.
 */
describe('the default answer (D223)', () => {
  /** The stored row's receipt time, which `storedRequests` does not read. */
  async function storedReceivedAt(requestId: string): Promise<string> {
    const result = await pool.query<{ received_at: Date }>(
      'SELECT received_at FROM requests WHERE id = $1',
      [requestId],
    );
    const row = result.rows[0];

    assert.ok(row, `request ${requestId} was not stored`);

    return row.received_at.toISOString();
  }

  /** One request written byte for byte, closing its connection once answered. */
  function written(target: string, headers: string[] = [], body = '', method = 'POST'): string {
    return [
      `${method} ${target} HTTP/1.1`,
      'Host: hook.qa-tools.ru',
      ...headers,
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n');
  }

  /** The answer's body, read back from the latin1 the raw response is read as. */
  function answerOf(response: ReturnType<typeof parseRawResponse>): WebhookDefaultAnswer {
    return JSON.parse(
      Buffer.from(response.body, 'latin1').toString('utf8'),
    ) as WebhookDefaultAnswer;
  }

  it('has nine keys in order, each equal to the stored request, the list, the detail and X-QA-Tools-Request-Id', async () => {
    const sessionId = await newSession();
    const body = '{"event":"order.paid","orderId":42}';
    const response = parseRawResponse(
      await readRawResponse(
        written(
          `/s/${sessionId}/stripe/events?livemode=false`,
          ['Content-Type: application/json'],
          body,
        ),
      ),
    );

    assert.equal(response.status, 200, response.body);

    const answer = answerOf(response);
    const [requestId] = headerValues(response.headers, 'x-qa-tools-request-id');

    assert.deepEqual(Object.keys(answer), [...DEFAULT_ANSWER_KEYS]);
    assert.equal(answer.ok, true);
    assert.equal(answer.requestId, requestId);
    assert.equal(answer.message, 'Captured by QA Tools');
    assert.equal(answer.inspectorUrl, `${APP_ORIGIN}/v/${sessionId}#${requestId}`);
    assert.equal(answer.method, 'POST');
    assert.equal(answer.path, `/s/${sessionId}/stripe/events`);
    assert.equal(answer.bodySize, Buffer.byteLength(body));
    assert.equal(answer.sourceIp, '127.0.0.1');

    // The stored row.
    const [stored] = await storedRequests(sessionId);

    assert.ok(stored);
    assert.equal(answer.requestId, stored.id);
    assert.equal(answer.method, stored.method);
    assert.equal(answer.path, stored.path);
    assert.equal(answer.bodySize, stored.body_size);
    assert.equal(answer.sourceIp, stored.source_ip);
    assert.equal(answer.receivedAt, await storedReceivedAt(stored.id));

    // The list and the detail, byte for byte the same time.
    const listed = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/requests` });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests/${stored.id}`,
    });
    const details = detail.json<RequestDetails>();

    for (const item of [listed.json<RequestListItem[]>()[0], details]) {
      assert.ok(item);
      assert.deepEqual(
        [item.id, item.receivedAt, item.method, item.path, item.bodySize, item.sourceIp],
        [
          answer.requestId,
          answer.receivedAt,
          answer.method,
          answer.path,
          answer.bodySize,
          answer.sourceIp,
        ],
      );
    }

    assert.equal(
      Buffer.from(response.body, 'latin1').toString('utf8'),
      JSON.stringify(defaultAnswerFor(sessionId, details, APP_ORIGIN)),
    );

    // Recorded as it was sent, its length announced (D109).
    const [record] = await awaitRecorded(sessionId, 1);

    assert.equal(record?.body?.toString('utf8'), Buffer.from(response.body, 'latin1').toString());
    assert.deepEqual(headerValues(response.headers, 'content-length'), [
      String(record?.body?.byteLength),
    ]);
    assert.equal(details.response?.body, record?.body?.toString('utf8'));
  });

  it('links the request on the local dev server when no APP_ORIGIN is configured', async () => {
    const local = buildReceiver(pool);

    local.log.level = 'silent';

    try {
      const sessionId = await newSession();
      const response = await local.inject({ method: 'POST', url: `/s/${sessionId}`, payload: 'x' });
      const answer = response.json<WebhookDefaultAnswer>();

      assert.equal(DEFAULT_APP_ORIGIN, 'http://localhost:5173');
      assert.equal(answer.inspectorUrl, `http://localhost:5173/v/${sessionId}#${answer.requestId}`);
    } finally {
      await local.close();
    }
  });

  it('echoes nothing of the body, the headers or the query string', async () => {
    const sessionId = await newSession();
    const markers = {
      body: 'BODY-MARKER-7F3A',
      headerName: 'X-NAME-MARKER-9C1D',
      headerValue: 'VALUE-MARKER-2B8E',
      queryKey: 'KEY-MARKER-1E4F',
      queryValue: 'QUERY-MARKER-5D0C',
      authorization: 'Bearer TOKEN-MARKER-6A2B',
    };
    const body = `{"secret":"${markers.body}"}`;
    const raw = await readRawResponse(
      written(
        `/s/${sessionId}/hooks?${markers.queryKey}=${markers.queryValue}`,
        [
          `${markers.headerName}: ${markers.headerValue}`,
          `Authorization: ${markers.authorization}`,
          'Content-Type: application/json',
        ],
        body,
      ),
    );

    assert.equal(parseRawResponse(raw).status, 200, raw);

    // Nowhere in the answer, head or body, in any letter case.
    for (const marker of Object.values(markers)) {
      assert.equal(raw.toLowerCase().includes(marker.toLowerCase()), false, marker);
    }

    // And yet every one of them was stored.
    const [stored] = await storedRequests(sessionId);

    assert.ok(stored?.body.toString().includes(markers.body));
    assert.equal(stored?.query_string, `${markers.queryKey}=${markers.queryValue}`);
    assert.deepEqual(
      stored?.headers.find(([name]) => name === markers.headerName),
      [markers.headerName, markers.headerValue],
    );
  });

  it('gives the path as stored: a trailing slash, %zz and dot segments kept, the query string dropped', async () => {
    const sessionId = await newSession();
    const root = `/s/${sessionId}`;

    for (const [target, path] of [
      [`${root}/`, `${root}/`],
      [`${root}/?a=1`, `${root}/`],
      [`${root}/%zz`, `${root}/%zz`],
      [`${root}/a/%zz/?x=%zz&y=1`, `${root}/a/%zz/`],
      [`${root}/a/../b//c/%7euser/?q=1`, `${root}/a/../b//c/%7euser/`],
      [`${root}/%E9t%C3%A9`, `${root}/%E9t%C3%A9`],
    ] as [string, string][]) {
      const response = parseRawResponse(await readRawResponse(written(target, [], 'x')));

      assert.equal(response.status, 200, `${target}: ${response.body}`);

      const answer = answerOf(response);
      const stored = (await storedRequests(sessionId)).find((row) => row.id === answer.requestId);

      assert.equal(answer.path, path, target);
      assert.equal(stored?.path, path, target);
    }
  });

  it('gives bodySize as the bytes received: 0 for none, UTF-8 bytes, and the compressed size of a gzip body', async () => {
    const sessionId = await newSession();
    const gzipped = gzipSync('compress me, '.repeat(500));
    const utf8 = Buffer.from('{"status":"приня́то ✓"}');

    assert.ok(gzipped.byteLength < 500, `${gzipped.byteLength} bytes`);

    for (const [description, method, payload, headers] of [
      ['a GET with none', 'GET', undefined, {}],
      ['an empty POST', 'POST', Buffer.alloc(0), {}],
      ['UTF-8', 'POST', utf8, { 'content-type': 'application/json' }],
      ['gzip', 'POST', gzipped, { 'content-type': 'application/json', 'content-encoding': 'gzip' }],
      ['the largest accepted', 'PUT', Buffer.alloc(MAX_BODY_BYTES, 0x61), {}],
    ] as [string, 'GET' | 'POST' | 'PUT', Buffer | undefined, Record<string, string>][]) {
      const response = await receiver.inject({
        method,
        url: `/s/${sessionId}`,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });

      assert.equal(response.statusCode, 200, description);

      const answer = response.json<WebhookDefaultAnswer>();
      const stored = (await storedRequests(sessionId)).find((row) => row.id === answer.requestId);

      assert.equal(answer.bodySize, payload?.byteLength ?? 0, description);
      assert.equal(stored?.body_size, answer.bodySize, description);
      assert.deepEqual(stored?.body, payload ?? Buffer.alloc(0), description);
    }
  });

  it('answers made-up paths built to break its JSON, at growing sizes up to Node’s limit, with JSON that reads back as the stored path', async () => {
    const sessionId = await newSession();
    const prefix = `/s/${sessionId}/`;

    for (const fragment of ['"', '\\', '\\"', '","ok":false,"requestId":"x', '</script>{}|^`<>']) {
      for (const size of [1, 1_024, 8_192, 16_000]) {
        const target = `${prefix}${fragment.repeat(Math.ceil(size / fragment.length)).slice(0, size)}`;
        const where = `${JSON.stringify(fragment)} × ${size}`;
        const response = parseRawResponse(
          await readRawResponse(written(target, [], '', 'GET'), 150, 10_000),
        );

        assert.equal(response.status, 200, `${where}: ${response.body.slice(0, 200)}`);

        const text = Buffer.from(response.body, 'latin1').toString('utf8');
        const answer = JSON.parse(text) as WebhookDefaultAnswer;
        const stored = (await storedRequests(sessionId)).find((row) => row.id === answer.requestId);

        assert.deepEqual(Object.keys(answer), [...DEFAULT_ANSWER_KEYS], where);
        assert.equal(answer.ok, true, where);
        assert.equal(answer.path, target, where);
        assert.equal(stored?.path, target, where);
        assert.deepEqual(
          headerValues(response.headers, 'content-length'),
          [String(Buffer.byteLength(text))],
          where,
        );
      }
    }
  });

  it('announces on a HEAD the length of the body it recorded and did not send', async () => {
    const sessionId = await newSession();
    const head = parseRawResponse(
      await readRawResponse(webhookRequest(sessionId, { method: 'HEAD' })),
    );
    const [record] = await awaitRecorded(sessionId, 1);

    assert.equal(head.status, 200);
    assert.equal(head.body, '', 'a HEAD response carried body bytes');
    assert.ok(record?.body);
    assert.equal(record.body_suppressed, true);
    assert.equal(record.body_size, record.body.byteLength);
    assert.deepEqual(headerValues(head.headers, 'content-length'), [
      String(record.body.byteLength),
    ]);

    const recorded = JSON.parse(record.body.toString('utf8')) as WebhookDefaultAnswer;

    assert.equal(recorded.method, 'HEAD');
    assert.deepEqual(headerValues(head.headers, 'x-qa-tools-request-id'), [recorded.requestId]);
    assert.deepEqual(headerValues(head.headers, 'x-webhook-inspector-request-id'), [
      recorded.requestId,
    ]);
  });
});

describe('X-Content-Type-Options (D101) and Content-Security-Policy (D179)', () => {
  it('are sent on a default session, a custom session, a path under either and every rejection', async (t) => {
    const defaultSession = await newSession();
    const customSession = await newCustomSession({ status: 201, body: '{"ok":1}' });
    const bodylessSession = await newCustomSession({ status: 204 });
    let notAMediaType!: Awaited<ReturnType<typeof receiver.inject>>;

    // The session to expire, sent this while it is still live. Until D173 a
    // path under the endpoint was the root instance's not-found route, where
    // Fastify refused a Content-Type that is not a media type with 415 / 1007
    // before the 404 was reached. It is the receiver now, which captures such a
    // header (D138), so no URL under /s/ answers 415 any more: this one is
    // captured, and answered with the session's configured headers.
    const liveUntilExpired = async (): Promise<string> => {
      const sessionId = await newCustomSession({
        status: 200,
        headers: [['access-control-allow-origin', '*']],
      });

      notAMediaType = await receiver.inject({
        method: 'POST',
        url: `/s/${sessionId}/payment`,
        headers: { 'content-type': 'json' },
        payload: 'x',
      });

      return sessionId;
    };

    await withExpiredSession(t, pool, liveUntilExpired, async (expiredSession) => {
      const oversized = Buffer.alloc(MAX_BODY_BYTES + 1, 'a');
      const answers: [string, Awaited<ReturnType<typeof app.inject>>, boolean][] = [
        [
          'default',
          await receiver.inject({ method: 'POST', url: `/s/${defaultSession}`, payload: 'x' }),
          true,
        ],
        [
          'custom',
          await receiver.inject({ method: 'POST', url: `/s/${customSession}`, payload: 'x' }),
          true,
        ],
        [
          'custom, body-less',
          await receiver.inject({ method: 'POST', url: `/s/${bodylessSession}`, payload: 'x' }),
          true,
        ],
        [
          'default, HEAD',
          await receiver.inject({ method: 'HEAD', url: `/s/${defaultSession}` }),
          true,
        ],
        [
          'custom, HEAD',
          await receiver.inject({ method: 'HEAD', url: `/s/${customSession}` }),
          true,
        ],
        [
          'default, under a path',
          await receiver.inject({
            method: 'POST',
            url: `/s/${defaultSession}/payment`,
            payload: 'x',
          }),
          true,
        ],
        ['custom, under a path, not a media type', notAMediaType, true],
        [
          '404 / 1001',
          await receiver.inject({ method: 'POST', url: `/s/${'z'.repeat(43)}` }),
          false,
        ],
        [
          '404 / 1001 under a path',
          await receiver.inject({ method: 'POST', url: `/s/${'z'.repeat(43)}/payment` }),
          false,
        ],
        [
          '410 / 1002',
          await receiver.inject({ method: 'POST', url: `/s/${expiredSession}` }),
          false,
        ],
        [
          '410 / 1002 under a path',
          await receiver.inject({ method: 'POST', url: `/s/${expiredSession}/payment` }),
          false,
        ],
        [
          '413 / 1004',
          await receiver.inject({
            method: 'POST',
            url: `/s/${defaultSession}`,
            payload: oversized,
          }),
          false,
        ],
        [
          '413 / 1004 under a path',
          await receiver.inject({
            method: 'POST',
            url: `/s/${defaultSession}/payment`,
            payload: oversized,
          }),
          false,
        ],
      ];

      for (const [description, response, carriesRequestId] of answers) {
        assert.equal(
          response.headers['x-content-type-options'],
          'nosniff',
          `${description} carried no nosniff`,
        );
        assert.equal(
          response.headers['content-security-policy'],
          SANDBOX_POLICY,
          `${description} carried no sandbox policy`,
        );
        assert.equal(
          response.headers['x-qa-tools-request-id'] !== undefined,
          carriesRequestId,
          `${description} reported the wrong request id header`,
        );
      }

      // A capture carries the session's configured headers; a rejection is the
      // receiver's own answer, not the session's (D101), under a path as well.
      assert.equal(notAMediaType.statusCode, 200, notAMediaType.body);
      assert.equal(notAMediaType.headers['access-control-allow-origin'], '*');

      for (const url of [`/s/${expiredSession}`, `/s/${expiredSession}/payment`]) {
        const rejected = await receiver.inject({ method: 'POST', url });

        assert.equal(rejected.statusCode, 410, url);
        assert.equal(rejected.headers['access-control-allow-origin'], undefined, url);
      }
    });
  });
});

describe('HEAD requests (D064)', () => {
  it('sends the representation headers of the bodied response and no body bytes', async () => {
    // Multi-byte on purpose: Content-Length counts UTF-8 bytes, not characters.
    const body = JSON.stringify({ status: 'приня́то ✓' });
    const sessionId = await newCustomSession({
      status: 201,
      headers: [['x-trace-id', 'abc']],
      body,
    });

    const head = parseRawResponse(
      await readRawResponse(webhookRequest(sessionId, { method: 'HEAD' })),
    );
    const get = parseRawResponse(await readRawResponse(webhookRequest(sessionId)));

    assert.notEqual(Buffer.byteLength(body), body.length);
    assert.equal(head.status, 201);
    assert.equal(head.body, '', 'a HEAD response carried body bytes');
    // The raw response is read as latin1, which is how header bytes decode, so
    // the body is turned back into UTF-8 before it is compared.
    assert.equal(Buffer.from(get.body, 'latin1').toString('utf8'), body);
    assert.deepEqual(headerValues(head.headers, 'content-length'), [
      String(Buffer.byteLength(body)),
    ]);
    assert.deepEqual(
      headerValues(head.headers, 'content-length'),
      headerValues(get.headers, 'content-length'),
    );
    assert.deepEqual(headerValues(head.headers, 'content-type'), [
      'application/json; charset=utf-8',
    ]);
    assert.deepEqual(headerValues(head.headers, 'x-trace-id'), ['abc']);
    assert.deepEqual(headerValues(head.headers, 'x-content-type-options'), ['nosniff']);
    assert.deepEqual(headerValues(head.headers, 'content-security-policy'), [SANDBOX_POLICY]);
    assert.equal(headerValues(head.headers, 'x-qa-tools-request-id').length, 1);
    assert.equal(headerValues(head.headers, 'x-webhook-inspector-request-id').length, 1);

    // Stored as an ordinary request: same row, same list, counted like any
    // other method.
    const stored = await storedRequests(sessionId);
    assert.deepEqual(stored.map((row) => row.method).sort(), ['HEAD', 'POST']);
  });

  for (const [description, configuration] of [
    ['no configured body', { status: 200 }],
    ['a status that forbids one', { status: 204 }],
  ] as [string, Partial<ResponseConfig>][]) {
    it(`sends neither representation header with ${description}`, async () => {
      const sessionId = await newCustomSession(configuration);

      const response = parseRawResponse(
        await readRawResponse(webhookRequest(sessionId, { method: 'HEAD' })),
      );

      assert.equal(response.body, '');
      assert.deepEqual(headerValues(response.headers, 'content-type'), []);
      assert.deepEqual(headerValues(response.headers, 'content-length'), []);
      assert.equal(headerValues(response.headers, 'x-qa-tools-request-id').length, 1);
      assert.equal(headerValues(response.headers, 'x-webhook-inspector-request-id').length, 1);
    });
  }
});

/**
 * The delay is taken after the request has been persisted and published, and is
 * driven from the outgoing response rather than from the inbound request
 * (D105). Every probe here carries body bytes on purpose: `request.raw` closes
 * as the handler is entered on a request that carries a body, so a body-less
 * probe cannot tell the required signal apart from the forbidden one.
 */
describe('the configured delay (D105)', () => {
  /** Ref'd timers on this process's event loop; the server shares it. */
  function refdTimers(): number {
    return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
  }

  /** Same request, framed with a transfer encoding instead of a length. */
  function chunkedWebhookRequest(sessionId: string, body: string): string {
    return [
      `POST /s/${sessionId} HTTP/1.1`,
      'Host: qa-tools.ru',
      'Connection: close',
      'Transfer-Encoding: chunked',
      '',
      Buffer.byteLength(body).toString(16),
      body,
      '0',
      '',
      '',
    ].join('\r\n');
  }

  /**
   * How long the first response byte took to arrive. The wait is bounded and
   * its expiry is a failure: an implementation aborting on the wrong signal
   * sends no response at all, and an unbounded read would hang rather than
   * fail.
   */
  function timeToFirstByte(request: string, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const socket = net.connect(port, '127.0.0.1', () => socket.write(request));

      const deadline = setTimeout(() => {
        socket.destroy();
        reject(new Error('no response byte arrived before the bound'));
      }, timeoutMs);

      socket.once('data', () => {
        clearTimeout(deadline);
        socket.destroy();
        resolve(Date.now() - started);
      });
      socket.on('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
    });
  }

  it('stores the request while the sender is still waiting for its reply', async () => {
    const delayMs = 700;
    const sessionId = await newCustomSession({ status: 200, delayMs });
    const pending = readRawResponse(webhookRequest(sessionId, { body: '{"payload":true}' }));

    let stored: StoredRequest[] = [];
    const deadline = Date.now() + delayMs * 0.6;

    while (Date.now() < deadline && stored.length === 0) {
      await delay(25);
      stored = await storedRequests(sessionId);
    }

    assert.equal(stored.length, 1, 'nothing was stored while the reply was still pending');
    assert.equal(stored[0]?.body.toString(), '{"payload":true}');

    // The pool was reachable throughout, so the wait is not held inside the
    // capture transaction.
    assert.equal(parseRawResponse(await pending).status, 200);
  });

  it('sends no byte of the response before the delay has elapsed', async () => {
    const delayMs = 400;
    const sessionId = await newCustomSession({ status: 200, body: '{"late":true}', delayMs });

    const probes: [string, string][] = [
      ['content-length', webhookRequest(sessionId, { body: '{"probe":1}' })],
      ['chunked', chunkedWebhookRequest(sessionId, '{"probe":2}')],
    ];

    for (const [framing, request] of probes) {
      const elapsed = await timeToFirstByte(request, delayMs * 10);

      assert.ok(
        elapsed >= delayMs - 5,
        `the ${framing} probe was answered after ${elapsed}ms, before the ${delayMs}ms delay`,
      );
    }

    assert.equal((await storedRequests(sessionId)).length, 2);
  });

  it('cancels the wait when the sender disconnects during it', async () => {
    const delayMs = 1500;
    // The configured body is what makes the record assertions below mean
    // something: the answer is composed before the delay, so a sender that
    // vanishes mid-delay must still leave real content behind (D109).
    const configuredBody = '{"delayed":true}';
    const sessionId = await newCustomSession({ status: 200, body: configuredBody, delayMs });

    // Every ref'd timer in the process but the pool's own. pg-pool keeps one
    // ref'd 10 s idle timer for each idle client and none for a busy one, so a
    // query still in flight at the baseline - an earlier test's fire-and-forget
    // record update, slow on a loaded runner - would add a timer by the next
    // sample. That was the CI failure `11 !== 10` on 2026-10-01. Read in one
    // synchronous step, the two numbers cannot disagree.
    const delayTimers = (): number => refdTimers() - pool.idleCount;

    // A request's handler enters its wait in the continuations that follow
    // its capture's commit, none of which waits for anything outside the
    // process, so its timer exists by the time the listener has read the
    // capture's `request.received` from the outbox and delivered it (D221),
    // which takes a statement of its own: the hook resolves on the turn
    // after. Waiting for that, rather than for a fixed time, is what keeps the
    // samples below inside the delay on a slow runner. The listener reads a
    // payload only when someone wants it, hence the stand-in subscriber.
    const { hub } = servers;
    const deliver = hub.deliver.bind(hub);
    const wanting: Subscriber = {
      send: () => undefined,
      close: () => undefined,
      terminate: () => undefined,
      bufferedAmount: 0,
    };
    let onReceived: (() => void) | undefined;

    hub.deliver = (id, type, payload) => {
      deliver(id, type, payload);

      if (id === sessionId && type === 'request.received') {
        onReceived?.();
      }
    };
    hub.add(sessionId, wanting, new Set());

    const nextWait = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const bound = setTimeout(() => reject(new Error('no request reached its wait')), 5_000);

        onReceived = () => {
          clearTimeout(bound);
          onReceived = undefined;
          setImmediate(resolve);
        };
      });

    const abandonedResponses: { headersSent: boolean; writableEnded: boolean }[] = [];
    const listener = (_request: unknown, response: unknown): void => {
      abandonedResponses.push(response as { headersSent: boolean; writableEnded: boolean });
    };

    receiver.server.on('request', listener);

    try {
      // Sampled with nothing of this test in flight. An awaited sleep has
      // already fired, so no timer of the test's own is pending at a sample.
      const baseline = delayTimers();

      const abandonedWaits = nextWait();
      const abandoned = net.connect(port, '127.0.0.1');
      abandoned.on('error', () => {});
      abandoned.on('connect', () =>
        abandoned.write(webhookRequest(sessionId, { body: '{"abandoned":true}' })),
      );

      await abandonedWaits;

      const waitStarted = Date.now();

      // The abandoned request's wait is running: one timer more.
      assert.equal(delayTimers(), baseline + 1, 'the abandoned request never reached its wait');

      abandoned.destroy();

      // Recorded `aborted` by the cancelled wait alone: an uncancelled one
      // would still be holding the reply.
      const [abandonedRow] = await storedRequests(sessionId);
      let abandonedState: string | undefined;

      while (abandonedState !== 'aborted' && Date.now() - waitStarted < delayMs) {
        await delay(5);
        abandonedState = (await storedResponses(sessionId)).find(
          (row) => row.request_id === abandonedRow?.id,
        )?.state;
      }

      assert.equal(
        abandonedState,
        'aborted',
        'the wait was not cancelled before the delay ran out',
      );
      // And its timer is gone, not merely ignored.
      assert.equal(delayTimers(), baseline, 'the abandoned wait is still pending');

      const liveWaits = nextWait();
      const live = net.connect(port, '127.0.0.1');
      let liveResponse = '';

      live.on('error', () => {});
      live.on('data', (chunk) => (liveResponse += chunk.toString()));
      live.on('connect', () => live.write(webhookRequest(sessionId, { body: '{"live":true}' })));

      await liveWaits;

      // Exactly one delay timer, the live request's own. More means the
      // abandoned wait is still pending. Sampled before the abandoned wait
      // would have run out on its own, or its absence would prove nothing.
      assert.equal(delayTimers(), baseline + 1, 'unexpected number of pending delay timers');
      assert.ok(
        Date.now() - waitStarted < delayMs,
        'sampled after the abandoned wait could expire',
      );

      // The live request asks for `Connection: close`, so its answer is whole
      // once the server closes it, a full delay later; by then the abandoned
      // wait, which began first, would have run out too. Awaited only now: the
      // bound is a timer of its own, which the samples above must not count.
      await awaitSocketClose(live, delayMs * 4);

      const [firstResponse] = abandonedResponses;

      assert.equal(firstResponse?.headersSent, false, 'the abandoned response was written to');
      assert.equal(firstResponse?.writableEnded, false, 'the abandoned response was ended');
      assert.match(liveResponse, /^HTTP\/1\.1 200/);

      // The abandoned request leaves a record, and it is not `sent`: nothing
      // was written into that socket. It carries the answer that was composed
      // before the delay - status, the exact header list and the body bytes -
      // rather than the empty shell a compose-after-delay implementation would
      // have left (D109).
      const stored = await storedRequests(sessionId);
      const abandonedRequest = stored.find(
        (row) => row.body.toString() === '{"abandoned":true}',
      ) as StoredRequest;

      assert.ok(abandonedRequest, 'the abandoned request was not stored');

      const records = await awaitRecorded(sessionId, 2);
      const record = records.find((row) => row.request_id === abandonedRequest.id);

      assert.equal(record?.state, 'aborted');
      assert.equal(record?.status, 200);
      assert.deepEqual(
        record?.headers,
        [
          ['x-webhook-inspector-request-id', abandonedRequest.id],
          ['x-qa-tools-request-id', abandonedRequest.id],
          ['x-content-type-options', 'nosniff'],
          ['content-security-policy', SANDBOX_POLICY],
          ['content-type', 'application/json; charset=utf-8'],
          ['content-length', String(Buffer.byteLength(configuredBody))],
        ],
        'the aborted record did not carry the composed header list',
      );
      assert.equal(record?.body?.toString(), configuredBody);
      assert.equal(record?.body_suppressed, false);
      assert.equal(record?.raw_response?.toString().startsWith('HTTP/1.1 200 OK\r\n'), true);
      assert.equal(record?.delay_ms, delayMs);
      assert.equal(record?.completed_at === null, false);

      live.destroy();
    } finally {
      receiver.server.off('request', listener);
      hub.deliver = deliver;
      hub.remove(sessionId, wanting);
    }
  });

  it('never delays a rejection', async () => {
    const sessionId = await newCustomSession({ status: 200, delayMs: 5_000 });

    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      sessionId,
    ]);

    const started = Date.now();
    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      payload: 'x',
    });

    assert.equal(response.statusCode, 410);
    assert.ok(Date.now() - started < 1_000, 'an error response was delayed');
  });
});

/**
 * The per-request response record (D109).
 *
 * The record is written on two passes: a `pending` row carrying the composed
 * answer, inside the capture transaction, and a small terminal update once the
 * write has ended. What these tests are about is the second pass telling the
 * truth - and never telling it about a request that is no longer there.
 */
describe('the response record (D109)', () => {
  /**
   * A socket that declared `response.recorded`, collecting every frame it gets.
   *
   * Used here rather than a hub spy because the publish is only worth asserting
   * where a client would observe it, and a declaring connection is the only one
   * that does (D115).
   */
  async function watchRecorded(
    sessionId: string,
  ): Promise<{ events: ServerEvent[]; close(): void }> {
    const socket = new WebSocket(
      `ws://127.0.0.1:${apiPort}/ws/${sessionId}?${REALTIME_EVENTS_PARAM}=response.recorded`,
    );
    const events: ServerEvent[] = [];

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('message', (message) => {
        const event = JSON.parse(message.data as string) as ServerEvent;

        if (event.type === 'ready') {
          resolve();

          return;
        }

        events.push(event);
      });
      socket.addEventListener('error', () => reject(new Error('the watcher could not connect')));
      socket.addEventListener('close', () =>
        reject(new Error('the watcher closed before reporting itself ready')),
      );
    });

    return { events, close: () => socket.close() };
  }

  /** Blocks until `watcher` holds a `response.recorded` for `requestId`. */
  async function awaitRecordedEvent(
    watcher: { events: ServerEvent[] },
    requestId: string,
  ): Promise<ResponseSummary> {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      for (const event of watcher.events) {
        if (event.type === 'response.recorded' && event.data.id === requestId) {
          return event.data.response;
        }
      }

      await delay(1);
    }

    throw new Error('no response.recorded arrived for that request');
  }

  async function details(sessionId: string, requestId: string): Promise<RequestDetails> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests/${requestId}`,
    });

    assert.equal(response.statusCode, 200, response.body);

    return response.json<RequestDetails>();
  }

  it('records a normal answer as sent, carrying exactly what the backend formed', async () => {
    const sessionId = await newCustomSession({
      status: 201,
      headers: [['x-trace-id', 'abc']],
      body: '{"accepted":true}',
    });

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      payload: 'x',
    });

    assert.equal(response.statusCode, 201);

    const [request] = await storedRequests(sessionId);
    const [record] = await awaitRecorded(sessionId, 1);

    assert.equal(record?.state, 'sent');
    assert.equal(record?.status, 201);

    // This request's own id, not a placeholder and not the session's
    // configuration, and the stored list is the exact final one - the
    // `content-length` the receiver appends included (D109).
    assert.deepEqual(record?.headers, [
      ['x-trace-id', 'abc'],
      ['x-webhook-inspector-request-id', request?.id as string],
      ['x-qa-tools-request-id', request?.id as string],
      ['x-content-type-options', 'nosniff'],
      ['content-security-policy', SANDBOX_POLICY],
      ['content-type', 'application/json; charset=utf-8'],
      ['content-length', '17'],
    ]);
    assert.equal(record?.body?.toString(), '{"accepted":true}');
    assert.equal(record?.body_size, 17);
    assert.equal(record?.body_suppressed, false);
    // The status line and the headers the backend set, and only those: Node
    // composes `Date`, `Connection` and `Keep-Alive` when it serialises the
    // head, after this value has been built, so they are absent here by
    // construction and this is not a byte-for-byte wire capture (D109).
    assert.equal(
      record?.raw_response?.toString(),
      [
        'HTTP/1.1 201 Created',
        'x-trace-id: abc',
        `x-webhook-inspector-request-id: ${request?.id as string}`,
        `x-qa-tools-request-id: ${request?.id as string}`,
        'x-content-type-options: nosniff',
        `content-security-policy: ${SANDBOX_POLICY}`,
        'content-type: application/json; charset=utf-8',
        'content-length: 17',
        '',
        '{"accepted":true}',
      ].join('\r\n'),
    );
    assert.equal(record?.delay_ms, 0);
    assert.equal(record?.completed_at === null, false);
    assert.equal((record?.duration_ms ?? -1) >= 0, true);

    // And the same record, read back through the contract clients use.
    const detail = await details(sessionId, request?.id as string);

    assert.equal(detail.response?.state, 'sent');
    assert.equal(detail.response?.status, 201);
    assert.equal(detail.response?.body, '{"accepted":true}');
    assert.equal(detail.response?.bodySuppressed, false);
    assert.equal(detail.path, `/s/${sessionId}`);
    assert.equal(detail.httpVersion, '1.1');
    // The field left the contract with country resolution (D140).
    assert.equal('sourceCountry' in detail, false);
  });

  it('records the HEAD representation with its bytes marked as not sent', async () => {
    const body = JSON.stringify({ status: 'ok' });
    const sessionId = await newCustomSession({ status: 200, body });

    await readRawResponse(webhookRequest(sessionId, { method: 'HEAD' }));

    const [record] = await awaitRecorded(sessionId, 1);

    assert.equal(record?.state, 'sent');
    assert.equal(record?.body?.toString(), body, 'the produced representation was not stored');
    assert.equal(record?.body_size, Buffer.byteLength(body));
    assert.equal(record?.body_suppressed, true);
    assert.deepEqual(headerValues(record?.headers ?? [], 'content-length'), [
      String(Buffer.byteLength(body)),
    ]);

    // The head alone: HEAD is where "a body was produced" and "a body is sent"
    // diverge, and the raw record omits the body Node suppresses (D064, D109).
    assert.equal(record?.raw_response?.toString().endsWith('\r\n\r\n'), true);
    assert.equal(record?.raw_response?.toString().includes(body), false);
  });

  it('records no body at all for a 204', async () => {
    const sessionId = await newCustomSession({ status: 204 });

    await receiver.inject({ method: 'POST', url: `/s/${sessionId}`, payload: 'x' });

    const [record] = await awaitRecorded(sessionId, 1);

    assert.equal(record?.state, 'sent');
    assert.equal(record?.status, 204);
    assert.equal(record?.body, null, 'a 204 stored a body');
    assert.equal(record?.body_size, 0);
    assert.equal(record?.body_suppressed, false);
    assert.deepEqual(headerValues(record?.headers ?? [], 'content-type'), []);
    assert.deepEqual(headerValues(record?.headers ?? [], 'content-length'), []);
    assert.equal(record?.raw_response?.toString().startsWith('HTTP/1.1 204 No Content\r\n'), true);
    assert.equal(record?.raw_response?.toString().endsWith('\r\n\r\n'), true);

    // `null` is "no body at all", which the API reports as no body on all three
    // fields - not as an empty one (D109).
    const [request] = await storedRequests(sessionId);
    const detail = await details(sessionId, request?.id as string);

    assert.equal(detail.response?.body, null);
    assert.equal(detail.response?.bodyBase64, null);
    assert.equal(detail.response?.isBinary, false);
    assert.equal(detail.response?.bodySize, 0);
  });

  it('reads an aged pending record as unknown, and stores nothing for it', async () => {
    const sessionId = await newSession();

    await receiver.inject({ method: 'POST', url: `/s/${sessionId}`, payload: 'x' });

    const [request] = await storedRequests(sessionId);

    await awaitRecorded(sessionId, 1);

    // Put the record back into the state a process killed inside the window
    // leaves behind, and age it one second past the shared grace.
    await pool.query(
      `UPDATE request_responses
          SET state = 'pending', completed_at = NULL, duration_ms = NULL,
              started_at = now() - make_interval(secs => $2)
        WHERE request_id = $1`,
      [request?.id, RESPONSE_UNKNOWN_GRACE_MS / 1000 + 1],
    );

    const detail = await details(sessionId, request?.id as string);

    assert.equal(detail.response?.state, 'unknown');

    const listed = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests`,
    });

    assert.equal(listed.json<{ response: ResponseSummary }[]>()[0]?.response.state, 'unknown');

    // Derived on both endpoints and stored on neither (D109).
    const [record] = await storedResponses(sessionId);

    assert.equal(record?.state, 'pending');
  });

  it('reads a request captured before this release as no record at all', async () => {
    const sessionId = await newSession();

    // Exactly what a pre-release row looks like: no response record, and the
    // three columns this release added still NULL, because there is no backfill
    // (D102, D109, D118).
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO requests (session_id, method, headers, body, body_size, raw_request)
       VALUES ($1, 'POST', '[]'::jsonb, ''::bytea, 0, ''::bytea)
       RETURNING id`,
      [sessionId],
    );

    const detail = await details(sessionId, inserted.rows[0]?.id as string);

    assert.equal(detail.response, null);
    assert.equal(detail.path, null);
    assert.equal(detail.httpVersion, null);
    assert.equal('sourceCountry' in detail, false);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests`,
    });

    assert.equal(listed.json<{ response: unknown }[]>()[0]?.response, null);
  });

  /**
   * A rollback runs the previous image against this schema, and that image
   * inserts into `source_country` on every capture - which is why the column
   * is kept (D140). This is its insert, column for column. A row written that
   * way, even one carrying a country, is served without one: the field left
   * the contract, and no stored value brings it back.
   */
  it("accepts the previous image's insert and never returns a country (D140)", async () => {
    const sessionId = await newSession();

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO requests
         (session_id, method, path, http_version, query_string, headers, body, body_size,
          raw_request, source_ip, source_country)
       VALUES ($1, 'POST', $2, '1.1', '', '[]'::jsonb, ''::bytea, 0, ''::bytea,
               '145.40.74.12', 'NL')
       RETURNING id`,
      [sessionId, `/s/${sessionId}`],
    );

    const detail = await details(sessionId, inserted.rows[0]?.id as string);

    assert.equal(detail.sourceIp, '145.40.74.12');
    assert.equal('sourceCountry' in detail, false);
    assert.doesNotMatch(JSON.stringify(detail), /country/i);
  });

  it('answers the sender normally when recording the outcome fails', async () => {
    const sessionId = await newCustomSession({ status: 201, body: '{"kept":true}' });

    // Recording is fire-and-forget: the response is written first and recorded
    // second, and a failure to record must never change the reply or its status
    // (D109).
    //
    // The outcome's UPDATE fails on every path to the database: the pool's own
    // `query`, which is where `recordResponseCompletion` runs it, as one
    // statement (#260), and the `query` of every client the pool lends.
    // Each failure is counted, so a path the injection does not reach fails
    // the test instead of recording `sent` unseen (#267).
    let injected = 0;
    const failingQuery =
      (query: unknown, target: object) =>
      (...args: unknown[]): unknown => {
        const [statement] = args;
        const text =
          typeof statement === 'string'
            ? statement
            : (statement as { text?: unknown } | null | undefined)?.text;

        if (typeof text === 'string' && text.includes('UPDATE request_responses')) {
          injected += 1;

          return Promise.reject(new Error('injected: recording the outcome failed'));
        }

        return (query as (...forwarded: unknown[]) => unknown).apply(target, args);
      };
    const bound = (value: unknown, target: object): unknown =>
      typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    // Only this view of a lent client fails: `release` is the client's own, so
    // the client goes back to the pool as it came, after the rollback.
    const failingClient = (client: pg.PoolClient): pg.PoolClient =>
      new Proxy(client, {
        get(target, property) {
          const value = Reflect.get(target, property, target);

          return property === 'query' ? failingQuery(value, target) : bound(value, target);
        },
      });
    const failingPool = new Proxy(pool, {
      get(target, property) {
        const value = Reflect.get(target, property, target);

        if (property === 'query') {
          return failingQuery(value, target);
        }

        if (property === 'connect') {
          return async () => failingClient(await target.connect());
        }

        return bound(value, target);
      },
    });

    // The receiver's completion writes, watched so that the record is read
    // once the recording has ended, not raced: a read that beats the write
    // finds `pending` whether the write fails or not.
    const writes = new PendingWrites();
    const track = writes.track.bind(writes);
    const recording = new Promise<Promise<unknown>>((resolve) => {
      writes.track = (write) => {
        track(write);
        resolve(write);
      };
    });
    const failing = buildReceiver(failingPool, { writes });

    failing.log.level = 'silent';

    try {
      const response = await failing.inject({
        method: 'POST',
        url: `/s/${sessionId}`,
        payload: 'x',
      });

      assert.equal(response.statusCode, 201);
      assert.equal(response.body, '{"kept":true}');
      assert.equal(response.headers['content-length'], '13');
      assert.match(String(response.headers['x-qa-tools-request-id']), UUID_V4);
      assert.match(String(response.headers['x-webhook-inspector-request-id']), UUID_V4);

      // The tracked write catches the failure and logs it, so it settles
      // either way; the timer, unref'd, holds nothing once it has.
      const ended = await Promise.race([
        recording.then(async (write) => {
          await write;

          return true;
        }),
        delay(10_000, false, { ref: false }),
      ]);

      assert.equal(ended, true, 'the recording of the outcome should have ended within 10 s');
      assert.equal(injected, 1, 'the outcome write should have met the injected failure once');

      const [record] = await storedResponses(sessionId);

      assert.equal(record?.state, 'pending', 'the terminal write should have failed');
    } finally {
      await failing.close();
    }
  });

  it('records failed and announces it when our own write throws', async () => {
    const sessionId = await newSession();
    const watcher = await watchRecorded(sessionId);

    // No valid input reaches `failed`: D101 keeps every configurable status,
    // header name and value inside what `writeHead` accepts, so nothing a
    // sender can send makes the write throw. The failing call is our own, on a
    // response object this process owns, which is what makes the state
    // reachable at all - and this test is a fault injection, never evidence
    // that a sender can produce it (D109, D114).
    const listener = (raw: { url?: string }, response: { writeHead: unknown }): void => {
      if (raw.url?.startsWith(`/s/${sessionId}`) === true) {
        response.writeHead = () => {
          throw new Error('injected: writing the head failed');
        };
      }
    };

    receiver.server.on('request', listener);

    const socket = net.connect(port, '127.0.0.1');

    socket.on('error', () => {});
    socket.on('connect', () => socket.write(webhookRequest(sessionId, { body: '{"fault":1}' })));

    try {
      const [record] = await awaitRecorded(sessionId, 1);

      assert.equal(record?.state, 'failed');
      // The answer was formed before the write was attempted, so the record
      // still holds it: `failed` means the send failed, never that the
      // inspector lost the data (D109, D120, D124).
      assert.equal(record?.status, 200);
      assert.equal(record?.body === null, false);

      const summary = await awaitRecordedEvent(watcher, record?.request_id as string);

      assert.deepEqual(summary, { state: 'failed', status: 200, queueStep: null, rule: null });

      // The reply was hijacked and the write threw, so nothing else is left to
      // end this connection: the `failed` path destroys it rather than leaving
      // the sender to wait indefinitely, as `requestTimeout` covers only a
      // request still arriving (D109, D172). Awaited here, before the test
      // closes the socket itself, so that claim has a test.
      await awaitSocketClose(socket);
    } finally {
      receiver.server.off('request', listener);
      socket.destroy();
      watcher.close();
    }
  });

  it('announces sent and aborted, and nothing when a pending record ages out', async () => {
    const sessionId = await newCustomSession({ status: 200, body: '{"ok":1}', delayMs: 800 });
    const watcher = await watchRecorded(sessionId);

    try {
      // `sent`: answered normally, after its delay.
      const answered = await readRawResponse(
        webhookRequest(sessionId, { body: '{"answered":true}' }),
        150,
        10_000,
      );

      assert.equal(parseRawResponse(answered).status, 200);

      // `aborted`: gone before the delay elapsed.
      const abandoned = net.connect(port, '127.0.0.1');

      abandoned.on('error', () => {});
      abandoned.on('connect', () =>
        abandoned.write(webhookRequest(sessionId, { body: '{"abandoned":true}' })),
      );

      await delay(200);
      abandoned.destroy();

      const records = await awaitRecorded(sessionId, 2);
      const byBody = new Map(
        (await storedRequests(sessionId)).map((row) => [row.body.toString(), row.id]),
      );
      const sentId = byBody.get('{"answered":true}') as string;
      const abortedId = byBody.get('{"abandoned":true}') as string;

      assert.equal(records.find((row) => row.request_id === sentId)?.state, 'sent');
      assert.equal(records.find((row) => row.request_id === abortedId)?.state, 'aborted');

      assert.deepEqual(await awaitRecordedEvent(watcher, sentId), {
        state: 'sent',
        status: 200,
        queueStep: null,
        rule: null,
      });
      assert.deepEqual(await awaitRecordedEvent(watcher, abortedId), {
        state: 'aborted',
        status: 200,
        queueStep: null,
        rule: null,
      });

      const announced = watcher.events.length;

      // `unknown` is derived at read time and never stored, so there is no
      // write to hang a publish on and nothing is announced when a record
      // crosses that line (D109, D110). Reading it is what a viewer does.
      await pool.query(
        `UPDATE request_responses
            SET state = 'pending', completed_at = NULL, duration_ms = NULL,
                started_at = now() - make_interval(secs => $2)
          WHERE request_id = $1`,
        [sentId, RESPONSE_UNKNOWN_GRACE_MS / 1000 + 1],
      );

      assert.equal((await details(sessionId, sentId)).response?.state, 'unknown');
      assert.equal(watcher.events.length, announced, 'ageing out announced something');
    } finally {
      watcher.close();
    }
  });

  it('deletes the record with its request, on all four paths (D109)', async () => {
    async function recordCount(sessionId: string): Promise<number> {
      return (await storedResponses(sessionId)).length;
    }

    // 1. A single delete.
    const single = await newSession();

    await receiver.inject({ method: 'POST', url: `/s/${single}`, payload: 'x' });
    await awaitRecorded(single, 1);

    const [singleRequest] = await storedRequests(single);

    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/sessions/${single}/requests/${singleRequest?.id as string}`,
        })
      ).statusCode,
      204,
    );
    assert.equal(await recordCount(single), 0);

    // 2. Delete all.
    const all = await newSession();

    await receiver.inject({ method: 'POST', url: `/s/${all}`, payload: 'x' });
    await receiver.inject({ method: 'POST', url: `/s/${all}`, payload: 'y' });
    await awaitRecorded(all, 2);

    assert.equal(
      (await app.inject({ method: 'DELETE', url: `/api/sessions/${all}/requests` })).statusCode,
      204,
    );
    assert.equal(await recordCount(all), 0);

    // 3. The newest-1000 eviction (D006). The oldest request carries a record
    // of its own, so its disappearance is what is being observed.
    const evicting = await newSession();

    await pool.query(
      `INSERT INTO requests (session_id, method, headers, body, body_size, raw_request, received_at)
       SELECT $1, 'OLD', '[]'::jsonb, ''::bytea, 0, ''::bytea, now() - make_interval(secs => n)
       FROM generate_series(1, 1000) AS n`,
      [evicting],
    );

    const oldest = await pool.query<{ id: string }>(
      'SELECT id FROM requests WHERE session_id = $1 ORDER BY received_at ASC LIMIT 1',
      [evicting],
    );

    await pool.query(
      `INSERT INTO request_responses (request_id, state, started_at)
       VALUES ($1, 'sent', now())`,
      [oldest.rows[0]?.id],
    );

    await receiver.inject({ method: 'POST', url: `/s/${evicting}`, payload: 'newest' });

    const survivors = await pool.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM request_responses WHERE request_id = $1',
      [oldest.rows[0]?.id],
    );

    assert.equal(survivors.rows[0]?.total, 0, 'the evicted request kept its response record');

    // 4. The scheduled session cleanup (D019), which is this statement.
    const expired = await newSession();

    await receiver.inject({ method: 'POST', url: `/s/${expired}`, payload: 'x' });
    await awaitRecorded(expired, 1);
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      expired,
    ]);
    await pool.query('DELETE FROM sessions WHERE expires_at < now()');

    assert.equal(await recordCount(expired), 0);
  });

  it('writes nothing back for a request deleted during its delay (D109)', async () => {
    const sessionId = await newCustomSession({ status: 200, body: '{"ok":1}', delayMs: 800 });
    const watcher = await watchRecorded(sessionId);

    async function recordsFor(requestId: string): Promise<number> {
      const result = await pool.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM request_responses WHERE request_id = $1',
        [requestId],
      );

      return result.rows[0]?.total ?? -1;
    }

    try {
      // Not awaited: everything below happens while this reply is still being
      // held for its configured delay.
      const answering = readRawResponse(
        webhookRequest(sessionId, { body: '{"doomed":true}' }),
        150,
        10_000,
      );
      const [captured] = await awaitStoredRequests(sessionId, 1);
      const requestId = captured?.id as string;

      assert.equal(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/sessions/${sessionId}/requests/${requestId}`,
          })
        ).statusCode,
        204,
      );
      assert.equal(await recordsFor(requestId), 0, 'the cascade left the record behind');

      // The sender is still there, so the handler wakes up and answers a
      // request that no longer exists. The completion write that follows must
      // update and never insert, or the delete would be undone.
      assert.equal(parseRawResponse(await answering).status, 200);

      // Recording is fire-and-forget (D109), so its absence is asserted across
      // the window it would have landed in rather than at one instant.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        assert.equal(await recordsFor(requestId), 0, 'a deleted request got its record back');
        await delay(2);
      }

      assert.equal(
        watcher.events.some(
          (event) => event.type === 'response.recorded' && event.data.id === requestId,
        ),
        false,
        'a transition that never happened was announced',
      );
    } finally {
      watcher.close();
    }
  });

  it('never overwrites a record that already reached a terminal state (D109)', async () => {
    const sessionId = await newSession();

    await receiver.inject({ method: 'POST', url: `/s/${sessionId}`, payload: 'x' });

    const [record] = await awaitRecorded(sessionId, 1);

    assert.equal(record?.state, 'sent');

    // The teardown `close` listener fires on a normally completed response too,
    // which is why the statement guards the state and not only the row. This is
    // that listener, isolated: a second write for the same request. It must
    // change nothing and report nothing, and announce nothing (D221).
    const second = await recordResponseCompletion(
      pool,
      sessionId,
      record?.request_id as string,
      'aborted',
      { status: 200, queueStep: null, rule: null },
    );

    assert.equal(second, null, 'a transition that did not happen was reported');

    const [after] = await storedResponses(sessionId);

    assert.equal(after?.state, 'sent');
    assert.deepEqual(after?.completed_at, record?.completed_at);
    assert.equal(after?.duration_ms, record?.duration_ms);
  });
});

/**
 * The sliding window (D133). A captured webhook is one of the two things that
 * count as using a session, so it moves the expiry - throttled to once an hour
 * by the statement itself, and never on a session that has already expired.
 */
describe('the sliding expiry', () => {
  /** The expiry PostgreSQL currently holds for a session. */
  async function expiresAt(sessionId: string): Promise<Date> {
    const result = await pool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM sessions WHERE id = $1',
      [sessionId],
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(`session ${sessionId.slice(0, 8)} is gone`);
    }

    return row.expires_at;
  }

  /** Moves a session's expiry to an arbitrary point, as these tests need. */
  async function setExpiry(sessionId: string, interval: string): Promise<void> {
    await pool.query(
      'UPDATE sessions SET expires_at = clock_timestamp() + $2::interval WHERE id = $1',
      [sessionId, interval],
    );
  }

  /** A capture as the route hands one to the repository. */
  function captured(sessionId: string, body: string) {
    return {
      sessionId,
      method: 'POST',
      path: `/s/${sessionId}`,
      httpVersion: '1.1',
      queryString: '',
      headers: [['host', 'qa-tools.ru']] as [string, string][],
      body: Buffer.from(body),
      rawRequestHead: Buffer.alloc(0),
      sourceIp: null,
    };
  }

  /**
   * A pool whose capture transaction runs a refresh that really fails inside
   * PostgreSQL - a division by zero put in its place - rather than one that
   * throws in JavaScript before reaching the server.
   *
   * The difference is the whole point of the test. A thrown `Error` would prove
   * only that the call is wrapped; a statement that fails in the server aborts
   * the transaction, so without the savepoint the COMMIT that follows would
   * fail with `current transaction is aborted` and the capture would be lost.
   */
  function poolWithFailingRefresh(base: pg.Pool, counter: { intercepted: number }): pg.Pool {
    const forward = <T extends object>(target: T, property: string | symbol): unknown => {
      const value = Reflect.get(target, property, target);

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    };

    /** The same substitution for either executor: the pool, or a client. */
    const failingQuery = (target: pg.Pool | pg.PoolClient): ((...args: unknown[]) => unknown) => {
      const query = target.query.bind(target) as (...forwarded: unknown[]) => unknown;

      return (...args: unknown[]) => {
        if (args[0] !== REFRESH_SESSION_EXPIRY_SQL) {
          return query(...args);
        }

        // Counted, so a test can prove it injected anything at all. Matching on
        // the exported statement is otherwise silent: inline that SQL, or stop
        // running it, and a test asserting only the outcome would pass having
        // intercepted nothing.
        counter.intercepted += 1;

        return query('SELECT 1 / 0');
      };
    };

    return new Proxy(base, {
      get(target, property) {
        // The read path runs the refresh on the pool; the capture path runs it
        // on the client it holds the transaction open on. Both are intercepted,
        // so one helper serves both tests.
        if (property === 'query') {
          return failingQuery(target);
        }

        if (property !== 'connect') {
          return forward(target, property);
        }

        return async () => {
          const client = await target.connect();

          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              return clientProperty === 'query'
                ? failingQuery(clientTarget)
                : forward(clientTarget, clientProperty);
            },
          });
        };
      },
    });
  }

  it('moves the expiry a full window ahead when the last refresh is over an hour old', async () => {
    const sessionId = await newSession();
    await setExpiry(sessionId, '2 days');

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      payload: 'moved',
    });

    assert.equal(response.statusCode, 200);
    assert.equal((await storedRequests(sessionId)).length, 1);

    const daysAhead = ((await expiresAt(sessionId)).getTime() - Date.now()) / 86_400_000;

    assert.ok(Math.abs(daysAhead - 7) < 0.01, `expected about 7 days, got ${daysAhead}`);
  });

  it('writes nothing when the session was refreshed within the hour', async () => {
    const sessionId = await newSession();
    // Freshly created, so it already holds a full window and the throttle in
    // the statement matches nothing.
    const before = await expiresAt(sessionId);

    for (let sent = 0; sent < 3; sent += 1) {
      const response = await receiver.inject({
        method: 'POST',
        url: `/s/${sessionId}`,
        payload: `throttled ${sent}`,
      });

      assert.equal(response.statusCode, 200);
    }

    assert.equal((await storedRequests(sessionId)).length, 3);
    assert.equal((await expiresAt(sessionId)).getTime(), before.getTime());
  });

  it('never revives an expired session', async () => {
    const sessionId = await newSession();
    await setExpiry(sessionId, '-1 minute');
    const before = await expiresAt(sessionId);

    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      payload: 'late',
    });

    assert.equal(response.statusCode, 410);
    assert.deepEqual(response.json(), { errorCode: 1002, message: 'Session expired' });
    assert.equal((await storedRequests(sessionId)).length, 0);
    assert.equal((await expiresAt(sessionId)).getTime(), before.getTime());
  });

  /**
   * Development priority 1: correctness of webhook capture. The refresh is a
   * convenience running inside the capture transaction, and it never decides
   * whether a request is recorded and answered.
   */
  it('captures and answers the request even when the refresh fails', async () => {
    const sessionId = await newSession();
    // Stale enough that the refresh would write if it could, so the assertion
    // below distinguishes a failed refresh from a throttled one.
    await setExpiry(sessionId, '2 days');
    const before = await expiresAt(sessionId);

    resetRefreshWarningThrottle();

    const counter = { intercepted: 0 };
    const warnings: { session: unknown; reason: unknown }[] = [];
    const logger = {
      warn: (details: object) => warnings.push(details as { session: unknown; reason: unknown }),
    };

    const result = await storeRequest(
      poolWithFailingRefresh(pool, counter),
      captured(sessionId, 'the refresh failed and this survived'),
      APP_ORIGIN,
      logger,
    );

    assert.equal(counter.intercepted, 1, 'the refresh statement was never intercepted');
    assert.equal(result.outcome, 'stored');

    const stored = await storedRequests(sessionId);

    assert.equal(stored.length, 1, 'the capture was rolled back with the refresh');
    assert.equal(stored[0]?.body.toString(), 'the refresh failed and this survived');
    // The response record is written in the same transaction (D109), so its
    // presence is the proof that the whole transaction committed.
    assert.equal((await storedResponses(sessionId)).length, 1);
    // And the refresh itself did not happen.
    assert.equal((await expiresAt(sessionId)).getTime(), before.getTime());

    // Reported, so a systematically failing refresh is not silent...
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.session, sessionId.slice(0, 8));
    assert.match(String(warnings[0]?.reason), /division by zero/);

    // ...but rate-limited, because this is the hot path: a second failure in
    // the same minute captures the request and writes no second line.
    const second = await storeRequest(
      poolWithFailingRefresh(pool, counter),
      captured(sessionId, 'the second one, also captured'),
      APP_ORIGIN,
      logger,
    );

    assert.equal(second.outcome, 'stored');
    assert.equal(counter.intercepted, 2);
    assert.equal((await storedRequests(sessionId)).length, 2);
    assert.equal(warnings.length, 1, 'the warning is not rate-limited');
  });

  /**
   * The throttle is one module-level instant shared by both refresh paths, and
   * that is a claim about where the state lives, not about either path alone.
   * So it is pinned across the two: a capture reports, and the read path - a
   * different module, the same process - then finds itself throttled.
   */
  it('shares the one-a-minute throttle with the read path', async () => {
    const sessionId = await newSession();
    await setExpiry(sessionId, '2 days');

    const warnings: string[] = [];
    const logger = { warn: (_details: object, message: string) => warnings.push(message) };
    const counter = { intercepted: 0 };

    resetRefreshWarningThrottle();
    await storeRequest(
      poolWithFailingRefresh(pool, counter),
      captured(sessionId, 'the capture that reports'),
      APP_ORIGIN,
      logger,
    );

    assert.equal(warnings.length, 1);

    // The read path now fails its own refresh, in the same minute.
    await getSessionDetails(poolWithFailingRefresh(pool, counter), sessionId, logger);

    assert.equal(counter.intercepted, 2, 'the read path did not reach the refresh');
    assert.equal(warnings.length, 1, 'the throttle is per path rather than shared');

    // And it is the throttle doing that, not a path that cannot report at all.
    resetRefreshWarningThrottle();
    await getSessionDetails(poolWithFailingRefresh(pool, counter), sessionId, logger);

    assert.equal(warnings.length, 2);
  });

  /**
   * The reporter is called from inside the capture transaction, so it may not
   * throw there whatever the logger does - a logger that throws would be
   * exactly the failure the savepoint was added to prevent.
   */
  it('captures the request even when the logger itself throws', async () => {
    const sessionId = await newSession();
    await setExpiry(sessionId, '2 days');

    const counter = { intercepted: 0 };

    resetRefreshWarningThrottle();

    const result = await storeRequest(
      poolWithFailingRefresh(pool, counter),
      captured(sessionId, 'the logger threw and this survived'),
      APP_ORIGIN,
      {
        warn: () => {
          throw new Error('the logger is broken');
        },
      },
    );

    assert.equal(counter.intercepted, 1);
    assert.equal(result.outcome, 'stored');

    const stored = await storedRequests(sessionId);

    assert.equal(stored.length, 1, 'a throwing logger rolled the capture back');
    assert.equal(stored[0]?.body.toString(), 'the logger threw and this survived');
    assert.equal((await storedResponses(sessionId)).length, 1);
  });

  it('refreshes normally on the same path when nothing fails', async () => {
    const sessionId = await newSession();
    await setExpiry(sessionId, '2 days');

    const result = await storeRequest(pool, captured(sessionId, 'the control'), APP_ORIGIN);

    assert.equal(result.outcome, 'stored');

    const daysAhead = ((await expiresAt(sessionId)).getTime() - Date.now()) / 86_400_000;

    assert.ok(Math.abs(daysAhead - 7) < 0.01, `expected about 7 days, got ${daysAhead}`);
  });
});

/**
 * A session created with `storeSourceIp: false` (D243, issue #166): its
 * captures store no sender address, and no answer about them says one - the
 * default answer and its record, the list with and without `include`, a
 * waiting list call, the detail, the query route and `request.received` -
 * while a default session in the same test stores and says it. The address
 * is the receive listener's peer here; `trust-boundary.test.ts` sends it
 * behind PROXY v2, `mcp.test.ts` reads it through the tools.
 */
describe('a session that keeps no sender address (D243)', () => {
  const SENDER = '203.0.113.77';

  /** Creates a session with `payload` as its create body. */
  async function createWith(payload: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    assert.equal(created.statusCode, 201, created.body);

    const { id } = created.json<{ id: string }>();

    createdSessionIds.push(id);

    return id;
  }

  /** A viewer that declared every optional event, collecting what it hears. */
  async function watch(sessionId: string): Promise<{ events: ServerEvent[]; close(): void }> {
    const socket = new WebSocket(
      `ws://127.0.0.1:${apiPort}/ws/${sessionId}?${REALTIME_EVENTS_PARAM}=response.recorded`,
    );
    const events: ServerEvent[] = [];

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('message', (message) => {
        const event = JSON.parse(message.data as string) as ServerEvent;

        if (event.type === 'ready') {
          resolve();
        } else {
          events.push(event);
        }
      });
      socket.addEventListener('error', () => reject(new Error('the watcher could not connect')));
    });

    return { events, close: () => socket.close() };
  }

  /** Every answer the API gives about the session's requests, as text, each named. */
  async function everyAnswer(sessionId: string, requestId: string): Promise<[string, string][]> {
    const base = `/api/sessions/${sessionId}/requests`;
    const answers: [string, string][] = [];

    for (const url of [
      base,
      `${base}?include=headers,body`,
      `${base}?wait=1`,
      `${base}/${requestId}`,
    ]) {
      const response = await app.inject({ method: 'GET', url });

      assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
      answers.push([url, response.body]);
    }

    for (const payload of ['{}', '{"include":["headers","body"]}']) {
      const response = await app.inject({
        method: 'POST',
        url: `${base}/query`,
        headers: { 'content-type': 'application/json' },
        payload,
      });

      assert.equal(response.statusCode, 200, `query ${payload}: ${response.body}`);
      answers.push([`query ${payload}`, response.body]);
    }

    return answers;
  }

  it('stores none, and says none in any answer, while a default session keeps it (criterion 3)', async () => {
    const opted = await createWith('{"storeSourceIp":false}');
    const kept = await createWith('{}');
    const viewer = await watch(opted);

    try {
      // A list call waiting for the first request, as a test without a browser makes it.
      const waiting = app.inject({ method: 'GET', url: `/api/sessions/${opted}/requests?wait=10` });

      await delay(100);

      const sent = await Promise.all(
        [opted, kept].map((sessionId) =>
          receiver.inject({
            method: 'POST',
            url: `/s/${sessionId}`,
            remoteAddress: SENDER,
            headers: { 'content-type': 'application/json' },
            payload: '{"event":"order.paid"}',
          }),
        ),
      );
      const [optedAnswer, keptAnswer] = sent.map(
        (response) => JSON.parse(response.body) as WebhookDefaultAnswer,
      );

      assert.equal(optedAnswer?.sourceIp, null);
      assert.equal(keptAnswer?.sourceIp, SENDER);

      const waited = await waiting;

      assert.equal(waited.statusCode, 200, waited.body);

      const [stored] = await storedRequests(opted);
      const [record] = await awaitRecorded(opted, 1);

      assert.ok(stored);
      assert.equal(stored.source_ip, null);
      assert.equal(stored.id, optedAnswer?.requestId);
      assert.equal((await storedRequests(kept))[0]?.source_ip, SENDER);

      // The viewer hears the capture and its recorded answer.
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        if (viewer.events.some((event) => event.type === 'response.recorded')) {
          break;
        }

        await delay(1);
      }

      const received = viewer.events.find((event) => event.type === 'request.received');

      assert.ok(received, JSON.stringify(viewer.events));
      assert.equal((received.data as RequestListItem).sourceIp, null);

      const said: [string, string][] = [
        ['the answer', sent[0]?.body ?? ''],
        ['the waiting list call', waited.body],
        ['the recorded body', record?.body?.toString('latin1') ?? ''],
        ['the recorded raw response', record?.raw_response?.toString('latin1') ?? ''],
        ['the events', JSON.stringify(viewer.events)],
        ...(await everyAnswer(opted, stored.id)),
      ];

      for (const [name, text] of said) {
        assert.equal(text.includes(SENDER), false, `${name} says the address: ${text}`);
      }

      for (const [name, text] of await everyAnswer(
        kept,
        (await storedRequests(kept))[0]?.id ?? '',
      )) {
        assert.ok(text.includes(SENDER), `${name} of the default session lost the address`);
      }
    } finally {
      viewer.close();
    }
  });

  it('keeps a sender’s own forwarding headers as sent, and lets them decide nothing (Decision 6)', async () => {
    const opted = await createWith('{"storeSourceIp":false}');
    const response = await receiver.inject({
      method: 'POST',
      url: `/s/${opted}`,
      remoteAddress: SENDER,
      headers: {
        'x-forwarded-for': '192.0.2.5, 192.0.2.6',
        'x-real-ip': '192.0.2.7',
        forwarded: 'for=192.0.2.8',
      },
      payload: 'x',
    });

    assert.equal(response.statusCode, 200, response.body);

    const [stored] = await storedRequests(opted);

    assert.equal(stored?.source_ip, null);
    assert.equal((JSON.parse(response.body) as WebhookDefaultAnswer).sourceIp, null);

    const headers = new Map(stored?.headers);

    assert.equal(headers.get('x-forwarded-for'), '192.0.2.5, 192.0.2.6');
    assert.equal(headers.get('x-real-ip'), '192.0.2.7');
    assert.equal(headers.get('forwarded'), 'for=192.0.2.8');
  });

  it('keeps none of a zone-suffixed, an IPv4-mapped or a plain IPv6 peer, in any spelling, where a default session keeps it normalised', async () => {
    for (const [peer, normal] of [
      ['fe80::1%eth0', 'fe80::1'],
      ['::ffff:203.0.113.78', '203.0.113.78'],
      ['::FFFF:CB00:714F', '203.0.113.79'],
      ['2001:DB8:0:0:0:0:0:78', '2001:db8::78'],
    ] as const) {
      for (const storeSourceIp of [false, true]) {
        const sessionId = await createWith(JSON.stringify({ storeSourceIp }));
        const response = await receiver.inject({
          method: 'POST',
          url: `/s/${sessionId}`,
          remoteAddress: peer,
          payload: 'x',
        });
        const label = `${peer}, storeSourceIp ${String(storeSourceIp)}`;

        assert.equal(response.statusCode, 200, response.body);

        const [stored] = await storedRequests(sessionId);

        assert.ok(stored, label);
        assert.equal(stored.source_ip, storeSourceIp ? normal : null, label);

        const answers = [
          response.body,
          ...(await everyAnswer(sessionId, stored.id)).map(([, text]) => text),
        ];

        for (const text of answers) {
          const lower = text.toLowerCase();

          assert.equal(lower.includes(normal), storeSourceIp, `${label}: ${text}`);
          assert.equal(lower.includes(peer.toLowerCase()), false, `${label}: ${text}`);
        }
      }
    }
  });

  it('answers an address that did not parse null in either session, as before (D111)', async () => {
    for (const payload of ['{"storeSourceIp":false}', '{"storeSourceIp":true}']) {
      const sessionId = await createWith(payload);
      const response = await receiver.inject({
        method: 'POST',
        url: `/s/${sessionId}`,
        remoteAddress: 'not-an-address',
        payload: 'x',
      });

      assert.equal(response.statusCode, 200, response.body);
      assert.equal((await storedRequests(sessionId))[0]?.source_ip, null, payload);
    }
  });
});
