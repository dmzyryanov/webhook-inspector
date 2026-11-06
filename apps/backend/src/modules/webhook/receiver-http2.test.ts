/**
 * The receive listener's HTTP/2 path (D263), end to end over real sockets:
 * Node's HTTP/2 client with prior knowledge (h2c), and raw frames where
 * Node's client will not send what a test needs, with PROXY protocol v2 on and
 * off, and the setting off, as production has it until #115.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import http2, { constants, type ClientHttp2Stream } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { after, afterEach, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  CAPTURES_BUSY_RETRY_AFTER_SECONDS,
  MAX_BODY_BYTES,
  type ResponseConfig,
  type ResponseRule,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { Drain } from '../../lib/drain.ts';
import { buildReceiver, buildServer, receiverHttp2, type ReceiverOptions } from '../../server.ts';
import { defaultAnswerText } from '../../testing/default-answer.ts';
import {
  amplifiedFields,
  closeH2,
  connectH2,
  FLAG_END_HEADERS,
  FLAG_END_STREAM,
  frame,
  FRAME_DATA,
  FRAME_GOAWAY,
  FRAME_HEADERS,
  FRAME_RST_STREAM,
  FRAME_SETTINGS,
  FRAME_WINDOW_UPDATE,
  frameTypes,
  h2Request,
  headerBlockFrames,
  literalHeaderBlock,
  proxyV2Header,
  rawConnection,
  receivedFrames,
  receiveUntilClosed,
  resetCode,
  writeByteByByte,
  type H2Answer,
  type ReceivedFrame,
} from '../../testing/http2.ts';
import { LIMITS_OUT_OF_REACH } from '../../testing/servers.ts';
import { createCaptureBudget, inFlightBound } from './capture-budget.ts';
import { createHeaderLineBudget } from './header-lines.ts';
import { HTTP2_PREFACE } from './http2-preface.ts';
import {
  HTTP2_MAX_CONCURRENT_STREAMS,
  HTTP2_MAX_CONNECTIONS_PER_ADDRESS,
  HTTP2_MAX_HEADER_LIST_PAIRS,
  HTTP2_MAX_HEADER_LIST_SIZE,
} from './http2-server.ts';
import { PROXY_V2_SIGNATURE } from './proxy-protocol.ts';
import {
  HTTP2_CONNECTION_FIELDS,
  HTTP2_SINGLE_VALUE_FIELDS,
  http2AnswerHeaders,
} from './response.ts';

/** Where the test's sockets come from, and the peer trusted to send a PROXY header. */
const PROXY_PEER = '127.0.0.1';
/** The sender address the PROXY headers of these tests carry. */
const SENDER = '198.51.100.7';
/** A short deadline for the PROXY header and for the preface, so that a refusal is quick to see. */
const DEADLINE_MS = 300;

/**
 * Every warning this file's process emits, collected from its start, before
 * any test: Node warns of a `Connection` field its HTTP/2 compatibility
 * response drops only once a process, whichever test sends the first one.
 */
const warnings: Error[] = [];

process.on('warning', (warning) => warnings.push(warning));

/**
 * Node's warning that its HTTP/2 compatibility response dropped a
 * `Connection` field (Node 24.19.0's `connectionHeaderMessageWarn`): what the
 * wire never shows, as the field is dropped either way.
 */
function droppedConnectionFieldWarnings(): Error[] {
  return warnings.filter(
    (warning) =>
      warning.name === 'UnsupportedWarning' && warning.message.includes('connection header'),
  );
}

/** Today's answer to the HTTP/2 preface on the HTTP/1.1 parser, as #206 measured it on production. */
const PREFACE_ANSWER =
  'HTTP/1.1 400 Bad Request\r\nContent-Length: 65\r\nContent-Type: application/json\r\n\r\n' +
  '{"error":"Bad Request","message":"Client Error","statusCode":400}';

let pool: pg.Pool;
let api: FastifyInstance;
const createdSessionIds: string[] = [];
/** Every receive listener a test started, closed at the end. */
const receivers: FastifyInstance[] = [];
/** Every client session a test opened, closed once the test is done. */
const clients: http2.ClientHttp2Session[] = [];
/** Every raw socket a test opened, closed once the test is done. */
const sockets: import('node:net').Socket[] = [];

/** The receive listeners most tests use, started once. */
interface Listening {
  app: FastifyInstance;
  port: number;
  /** The PROXY header a connection must open with, or none. */
  header: Buffer | undefined;
  /** What `sourceIp` a capture through it stores. */
  sourceIp: string;
}

let plain: Listening;
/**
 * PROXY v2 on, so D266's bound applies to it: every connection to it comes
 * from SENDER, and SENDER may have at most `HTTP2_MAX_CONNECTIONS_PER_ADDRESS`
 * (32) HTTP/2 connections open at once, the 33rd closed with nothing written.
 * So no test leaves one open: `afterEach` closes what a test opened and
 * waits until this listener holds none of SENDER's.
 */
let proxied: Listening;
let off: Listening;
let offProxied: Listening;

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

async function listen(options: ReceiverOptions): Promise<FastifyInstance> {
  const receiver = buildReceiver(pool, options);

  receiver.log.level = 'silent';

  const part = receiverHttp2(receiver);

  if (part !== undefined) {
    part.app.log.level = 'silent';
  }

  receivers.push(receiver);
  await receiver.listen({ host: '127.0.0.1', port: 0 });

  return receiver;
}

function portOf(receiver: FastifyInstance): number {
  return (receiver.server.address() as AddressInfo).port;
}

/** A line either instance of a receive listener logged. */
interface LogLine {
  level: number;
  msg: string;
}

/** Pino's level of `error`. */
const ERROR_LEVEL = 50;

/** A receive listener of its own whose lines, both instances', the test reads. */
async function listenLogged(
  options: ReceiverOptions,
): Promise<{ target: Listening; lines: () => LogLine[] }> {
  let output = '';
  const receiver = buildReceiver(pool, {
    ...options,
    logDestination: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
  });

  receivers.push(receiver);
  await receiver.listen({ host: '127.0.0.1', port: 0 });

  return {
    target: { app: receiver, port: portOf(receiver), header: undefined, sourceIp: PROXY_PEER },
    lines: () =>
      output
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as LogLine),
  };
}

/** A receive listener of its own with `options`, PROXY off. */
async function ownTarget(options: ReceiverOptions): Promise<Listening> {
  const receiver = await listen(options);

  return { app: receiver, port: portOf(receiver), header: undefined, sourceIp: PROXY_PEER };
}

/**
 * Opens a raw connection to `target` and writes, in one write, the preface,
 * empty SETTINGS and `frames` - a client's first flight, before it can have
 * acknowledged the server's SETTINGS, which it never does here. Resolves with
 * the frames received once `done` holds of them.
 */
async function firstFlight(
  target: Listening,
  frames: Buffer,
  done: (received: ReceivedFrame[]) => boolean,
): Promise<ReceivedFrame[]> {
  const socket = await raw(target);
  const chunks: Buffer[] = [];

  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.write(
    Buffer.concat([HTTP2_PREFACE, frame(FRAME_SETTINGS, 0, 0, Buffer.alloc(0)), frames]),
  );
  await eventually(async () => done(receivedFrames(Buffer.concat(chunks))), 'the answer');
  socket.destroy();

  return receivedFrames(Buffer.concat(chunks));
}

/** Whether `streamId` has been answered - a `HEADERS` frame - or reset. */
function answeredOrReset(streamId: number): (received: ReceivedFrame[]) => boolean {
  return (received) =>
    received.some(
      (one) =>
        one.streamId === streamId && (one.type === FRAME_HEADERS || one.type === FRAME_RST_STREAM),
    );
}

/** Whether `streamId` has been answered: a `HEADERS` frame on it. */
function answeredOn(received: ReceivedFrame[], streamId: number): boolean {
  return received.some((one) => one.streamId === streamId && one.type === FRAME_HEADERS);
}

/** Whether the answer on `streamId` has ended: a `HEADERS` or `DATA` frame with END_STREAM on it. */
function answerEndedOn(received: ReceivedFrame[], streamId: number): boolean {
  return received.some(
    (one) =>
      one.streamId === streamId &&
      (one.type === FRAME_HEADERS || one.type === FRAME_DATA) &&
      (one.flags & FLAG_END_STREAM) !== 0,
  );
}

const PROXIED: ReceiverOptions = {
  proxyProtocol: 'v2',
  trustedProxyCidrs: [`${PROXY_PEER}/32`],
  proxyHeaderTimeoutMs: DEADLINE_MS,
};

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    api = buildServer(pool, { rateLimits: LIMITS_OUT_OF_REACH });
    api.log.level = 'silent';
    await api.ready();

    const plainApp = await listen({ http2: 'on', prefaceTimeoutMs: DEADLINE_MS });
    const proxiedApp = await listen({ ...PROXIED, http2: 'on', prefaceTimeoutMs: DEADLINE_MS });
    const offApp = await listen({});
    const offProxiedApp = await listen({ ...PROXIED });

    plain = { app: plainApp, port: portOf(plainApp), header: undefined, sourceIp: PROXY_PEER };
    proxied = {
      app: proxiedApp,
      port: portOf(proxiedApp),
      header: proxyV2Header(SENDER),
      sourceIp: SENDER,
    };
    off = { app: offApp, port: portOf(offApp), header: undefined, sourceIp: PROXY_PEER };
    offProxied = {
      app: offProxiedApp,
      port: portOf(offProxiedApp),
      header: proxyV2Header(SENDER),
      sourceIp: SENDER,
    };
  })();
  await startup;
});

// Each test's client sessions and raw sockets are closed once it is done,
// and the shared PROXY listener is seen to hold no HTTP/2 connection of
// SENDER before the next test, so its 32 an address (D266) are never taken
// by tests that have ended. Left open until the file's end, as they were
// before #302, they reached 19 in one run.
afterEach(async () => {
  for (const session of clients.splice(0)) {
    session.destroy();
  }

  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }

  const shared = proxied as Listening | undefined;
  const places = shared === undefined ? undefined : receiverHttp2(shared.app)?.connections;

  if (places) {
    await eventually(
      async () => places.takenBy(SENDER) === 0,
      `the shared PROXY listener's HTTP/2 connections from ${SENDER} closed after the test, ` +
        `as it closes an address's HTTP/2 connections past ${HTTP2_MAX_CONNECTIONS_PER_ADDRESS} (D266)`,
    );
  }
});

after(async () => {
  await startup?.catch(() => undefined);

  for (const client of clients) {
    client.destroy();
  }

  for (const socket of sockets) {
    socket.destroy();
  }

  await Promise.all(receivers.map((receiver) => receiver.close()));
  await api?.close();

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await pool?.end();
});

/** Creates a session with `body` as its create body, and answers its id and its key, if any. */
async function createSession(body: object = {}): Promise<{ id: string; key?: string }> {
  const created = await api.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

  assert.equal(created.statusCode, 201, created.body);

  const answer = created.json<{ id: string; accessKey?: string }>();

  createdSessionIds.push(answer.id);

  return { id: answer.id, key: answer.accessKey };
}

async function newSession(response?: Partial<ResponseConfig>): Promise<string> {
  return (await createSession(response === undefined ? {} : { response })).id;
}

async function setRules(sessionId: string, rules: ResponseRule[]): Promise<void> {
  const saved = await api.inject({
    method: 'PUT',
    url: `/api/sessions/${sessionId}/rules`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ rules }),
  });

  assert.equal(saved.statusCode, 200, saved.body);
}

/** A client session to `target`, behind its PROXY header if it has one. */
function client(
  target: Listening,
  options: http2.ClientSessionOptions = {},
): http2.ClientHttp2Session {
  const session = connectH2(target.port, target.header, options);

  clients.push(session);

  return session;
}

async function raw(target: Listening): Promise<import('node:net').Socket> {
  const socket = await rawConnection(target.port);

  sockets.push(socket);

  if (target.header !== undefined) {
    socket.write(target.header);
  }

  return socket;
}

interface StoredRequest {
  id: string;
  method: string;
  path: string;
  http_version: string;
  query_string: string;
  headers: [string, string][];
  body: Buffer;
  raw_request: Buffer;
  source_ip: string | null;
}

interface StoredResponse {
  state: string;
  status: number | null;
  headers: [string, string][];
  body: Buffer | null;
  body_suppressed: boolean;
  raw_response: Buffer | null;
  rule_index: number | null;
}

async function storedRequests(sessionId: string): Promise<StoredRequest[]> {
  const result = await pool.query<StoredRequest>(
    `SELECT id, method, path, http_version, query_string, headers, body, raw_request, source_ip
       FROM requests WHERE session_id = $1 ORDER BY received_at, id`,
    [sessionId],
  );

  return result.rows;
}

async function storedRequest(sessionId: string): Promise<StoredRequest> {
  const rows = await storedRequests(sessionId);

  assert.equal(rows.length, 1, `one request stored, not ${rows.length}`);

  return rows[0] as StoredRequest;
}

async function storedResponse(requestId: string): Promise<StoredResponse> {
  const result = await pool.query<StoredResponse>(
    `SELECT state, status, headers, body, body_suppressed, raw_response, rule_index
       FROM request_responses WHERE request_id = $1`,
    [requestId],
  );

  assert.equal(result.rows.length, 1);

  return result.rows[0] as StoredResponse;
}

/** Polls until `check` answers true, or fails after `timeoutMs`. */
async function eventually(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();

  while (!(await check())) {
    if (Date.now() - start > timeoutMs) {
      assert.fail(`not within ${timeoutMs} ms: ${what}`);
    }

    await delay(20);
  }
}

/**
 * Polls, as `eventually` does, until `missing` names nothing, and fails
 * naming what it still names once `timeoutMs` have passed or once `closed`
 * holds: a socket emits every chunk it read before its `close`, so what a
 * closed connection has not delivered never comes.
 */
async function arrives(
  missing: () => string[],
  closed: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();

  for (;;) {
    const gaps = missing();

    if (gaps.length === 0) {
      return;
    }

    if (closed()) {
      assert.fail(`${gaps.join('; ')}, connection closed`);
    }

    if (Date.now() - start > timeoutMs) {
      assert.fail(`not within ${timeoutMs} ms: ${gaps.join('; ')}`);
    }

    await delay(20);
  }
}

/**
 * Resolves as `promise` does, or fails once `timeoutMs` have passed: a
 * deadline of the test's own.
 */
async function within<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new assert.AssertionError({ message: `not within ${timeoutMs} ms: ${what}` })),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The response record of `requestId` once it has left `pending`. */
async function settledResponse(requestId: string): Promise<StoredResponse> {
  let response: StoredResponse | undefined;

  await eventually(async () => {
    response = await storedResponse(requestId);

    return response.state !== 'pending';
  }, 'the response settled');

  return response as StoredResponse;
}

/** Every byte value, twice, then a CR LF and a NUL: a body no text decoding survives. */
const BINARY_BODY = Buffer.concat([
  Buffer.from(Array.from({ length: 256 }, (_unused, index) => index)),
  Buffer.from(Array.from({ length: 256 }, (_unused, index) => 255 - index)),
  Buffer.from('\r\n\0'),
]);

/** The raw request an HTTP/2 capture stores: its header list as received, a blank line, the body. */
function directionB(fields: [string, string][], body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `${fields.map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`,
      'latin1',
    ),
    body,
  ]);
}

/** The pairs of a flat raw header list. */
function pairsOf(rawHeaders: string[]): [string, string][] {
  const pairs: [string, string][] = [];

  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    pairs.push([rawHeaders[index] as string, rawHeaders[index + 1] as string]);
  }

  return pairs;
}

/** Sends the same HTTP/1.1 bytes on a connection of their own and collects the answer. */
async function http1(target: Listening, bytes: string | Buffer): Promise<string> {
  const socket = await raw(target);
  const received = receiveUntilClosed(socket);

  socket.write(bytes);
  setTimeout(() => socket.end(), 400).unref();

  return (await received).bytes.toString('latin1');
}

describe('with RECEIVE_HTTP2 off, as production (criterion 1)', () => {
  for (const name of ['off', 'offProxied'] as const) {
    it(`answers the HTTP/2 preface with today's HTTP/1.1 400, byte for byte, then closes (${name === 'off' ? 'PROXY off' : 'PROXY v2'})`, async () => {
      const target = name === 'off' ? off : offProxied;

      assert.equal(receiverHttp2(target.app), undefined, 'no HTTP/2 part is built');

      const socket = await raw(target);
      const received = receiveUntilClosed(socket);

      socket.write(HTTP2_PREFACE);

      assert.equal((await received).bytes.toString('latin1'), PREFACE_ANSWER);
    });
  }

  it('answers Node’s HTTP/2 client nothing it can read as HTTP/2', async () => {
    const session = client(off);
    const answer = await h2Request(session, { ':path': '/robots.txt' });

    assert.equal(answer.status, undefined);
  });
});

describe('with RECEIVE_HTTP2 on, a request over HTTP/2 (criterion 2)', () => {
  for (const name of ['plain', 'proxied'] as const) {
    const label = name === 'plain' ? 'PROXY off' : 'PROXY v2';
    const target = (): Listening => (name === 'plain' ? plain : proxied);

    it(`is stored as 2.0 with its method, path, query, fields in wire order and body, raw in direction B (${label})`, async () => {
      const sessionId = await newSession();
      const session = client(target());
      const body = Buffer.from('{"event":"charge.succeeded","amount":4200}');
      const answer = await h2Request(
        session,
        {
          ':method': 'POST',
          ':path': `/s/${sessionId}/stripe/events?livemode=false&x=%2F&x=2`,
          ':scheme': 'https',
          ':authority': 'hook.qa-tools.ru',
          'user-agent': 'Stripe/1.0',
          'Content-Type': 'application/json; charset=utf-8',
          cookie: ['a=1', 'b=2'],
          'x-zeta': 'last-sorted-first-sent',
          'content-length': String(body.length),
          'stripe-signature': 't=1,v1=abc',
        },
        { body },
      );

      assert.equal(answer.status, 200);

      const stored = await storedRequest(sessionId);
      const regular: [string, string][] = [
        ['user-agent', 'Stripe/1.0'],
        ['content-type', 'application/json; charset=utf-8'],
        ['cookie', 'a=1'],
        ['cookie', 'b=2'],
        ['x-zeta', 'last-sorted-first-sent'],
        ['content-length', String(body.length)],
        ['stripe-signature', 't=1,v1=abc'],
      ];

      assert.equal(stored.http_version, '2.0');
      assert.equal(stored.method, 'POST');
      assert.equal(stored.path, `/s/${sessionId}/stripe/events`);
      assert.equal(stored.query_string, 'livemode=false&x=%2F&x=2');
      // Lower case, in the order sent, each cookie apart, no pseudo-header.
      assert.deepEqual(stored.headers, regular);
      assert.ok(stored.body.equals(body));
      assert.equal(stored.source_ip, target().sourceIp);

      // The pseudo-header fields first, as they arrived - Node's client puts
      // `:method` and `:path` before `:scheme` and `:authority` as given here.
      const pseudo: [string, string][] = [
        [':method', 'POST'],
        [':path', `/s/${sessionId}/stripe/events?livemode=false&x=%2F&x=2`],
        [':scheme', 'https'],
        [':authority', 'hook.qa-tools.ru'],
      ];

      assert.ok(
        stored.raw_request.equals(directionB([...pseudo, ...regular], body)),
        stored.raw_request.toString('latin1'),
      );
      assert.equal(stored.raw_request.includes(Buffer.from('HTTP/')), false, 'no request line');
    });

    for (const method of ['POST', 'OPTIONS', 'QUERY', 'DELETE']) {
      for (const framing of ['with', 'without'] as const) {
        it(`stores a ${method} body byte for byte ${framing} content-length (${label})`, async () => {
          const sessionId = await newSession();
          const session = client(target());
          const headers: http2.OutgoingHttpHeaders = {
            ':method': method,
            ':path': `/s/${sessionId}`,
            'content-type': 'application/octet-stream',
          };

          if (framing === 'with') {
            headers['content-length'] = String(BINARY_BODY.length);
          }

          // In three DATA frames.
          const answer = await h2Request(session, headers, {
            body: [
              BINARY_BODY.subarray(0, 7),
              BINARY_BODY.subarray(7, 300),
              BINARY_BODY.subarray(300),
            ],
          });

          assert.equal(answer.status, 200, answer.body.toString());

          const stored = await storedRequest(sessionId);

          assert.equal(stored.method, method);
          assert.ok(stored.body.equals(BINARY_BODY), `${stored.body.length} bytes stored`);
          assert.equal(stored.http_version, '2.0');
        });
      }
    }

    it(`stores a QUERY with no Content-Type and no body, as over HTTP/1.1 (D166) (${label})`, async () => {
      const sessionId = await newSession();
      const answer = await h2Request(client(target()), {
        ':method': 'QUERY',
        ':path': `/s/${sessionId}`,
      });

      assert.equal(answer.status, 200);

      const stored = await storedRequest(sessionId);

      assert.equal(stored.method, 'QUERY');
      assert.equal(stored.body.length, 0);
    });

    it(`stores a GET, HEAD or TRACE that sent a body without it, as over HTTP/1.1, and resets its stream after the answer (${label})`, async () => {
      for (const method of ['GET', 'HEAD', 'TRACE']) {
        const sessionId = await newSession();
        // The body is sent and the stream left open, as a sender still sending.
        const answer = await h2Request(
          client(target()),
          { ':method': method, ':path': `/s/${sessionId}`, 'content-length': '1000' },
          { body: 'x'.repeat(100), keepOpen: true },
        );

        // The client never ended its stream, so only the server's
        // `RST_STREAM(NO_ERROR)` after the answer could close it.
        assert.equal(answer.status, 200, method);
        assert.equal(answer.rstCode, constants.NGHTTP2_NO_ERROR);

        const stored = await storedRequest(sessionId);

        assert.equal(stored.body.length, 0, method);
        // Written whole before the reset: an answer before the body's end
        // (RFC 9113 §8.1) is sent.
        assert.equal((await settledResponse(stored.id)).state, 'sent', method);

        // The same request over HTTP/1.1, stored the same way.
        const otherId = await newSession();

        await http1(
          plain,
          `${method} /s/${otherId} HTTP/1.1\r\nHost: h\r\nContent-Length: 3\r\n\r\nabc`,
        );
        await eventually(async () => (await storedRequests(otherId)).length === 1, 'stored');
        assert.equal((await storedRequest(otherId)).body.length, 0, `${method} over HTTP/1.1`);
      }
    });

    it(`answers a default session as D223 says, from the pseudo-header fields (${label})`, async () => {
      const sessionId = await newSession();
      const answer = await h2Request(
        client(target()),
        { ':method': 'PUT', ':path': `/s/${sessionId}/a/b?c=d` },
        { body: 'twelve bytes' },
      );
      const stored = await storedRequest(sessionId);

      assert.equal(answer.status, 200);
      assert.equal(answer.body.toString(), await defaultAnswerText(api, sessionId, stored.id));
      assert.match(
        answer.body.toString(),
        new RegExp(
          `"method":"PUT","path":"/s/${sessionId}/a/b","bodySize":12,"sourceIp":"${target().sourceIp}"`,
        ),
      );
    });
  }
});

/** Pino's level of `warn`. */
const WARN_LEVEL = 40;

/** The status and body of an HTTP/1.1 answer as `http1` collects it. */
function http1Answer(text: string): { status: number; body: string } {
  const [head = '', ...body] = text.split('\r\n\r\n');

  return { status: Number(head.split(' ')[1]), body: body.join('\r\n\r\n') };
}

describe('with RECEIVE_HTTP2 on, a request no route takes (D263 point 11)', () => {
  it('answers a :method no route has - FOO, a lowercase get - 404 / 1000 as it answers a path no route has, nothing stored, nothing logged at warn', async () => {
    const { target, lines } = await listenLogged({ http2: 'on' });
    const sessionId = await newSession();
    const session = client(target);
    const fields = (answer: H2Answer): [string, string][] =>
      pairsOf(answer.rawHeaders).filter(([name]) => name !== 'date');
    const unknownPath = await h2Request(session, { ':method': 'GET', ':path': '/nothing' });

    assert.equal(unknownPath.status, 404);

    for (const method of ['FOO', 'get']) {
      for (const body of [null, 'b']) {
        const answer = await h2Request(
          session,
          { ':method': method, ':path': `/s/${sessionId}` },
          { body },
        );

        assert.equal(answer.status, 404, method);
        assert.deepEqual(fields(answer), fields(unknownPath), method);
        assert.deepEqual(JSON.parse(answer.body.toString()), {
          errorCode: 1000,
          message: 'Not found',
        });
      }
    }

    // The connection goes on.
    assert.equal((await h2Request(session, { ':path': '/robots.txt' })).status, 200);
    assert.equal((await storedRequests(sessionId)).length, 0);
    assert.deepEqual(
      lines().filter((line) => line.level >= WARN_LEVEL),
      [],
      'no line at warn or above',
    );
  });

  // `/s/%zz` is no refusal of the router's: every `/s/...` URL is the
  // receiver's (D173), and `%zz` an id no session has.
  it('answers a path outside /s/, OPTIONS *, an unknown session and /s/%zz as HTTP/1.1 does', async () => {
    const unknownSession = '00000000-0000-4000-8000-000000000000';
    const session = client(plain);

    for (const [method, path, errorCode] of [
      ['GET', '/nothing', 1000],
      ['OPTIONS', '*', 1000],
      ['POST', `/s/${unknownSession}`, 1001],
      ['POST', `/s/${unknownSession}/deeper?x=1`, 1001],
      ['POST', '/s/%zz', 1001],
    ] as const) {
      const answer = await h2Request(session, { ':method': method, ':path': path }, { body: 'b' });
      const overHttp1 = http1Answer(
        await http1(plain, `${method} ${path} HTTP/1.1\r\nHost: h\r\nContent-Length: 1\r\n\r\nb`),
      );

      assert.equal(answer.status, 404, `${method} ${path}`);
      assert.equal(overHttp1.status, 404, `${method} ${path} over HTTP/1.1`);
      assert.equal(JSON.parse(answer.body.toString()).errorCode, errorCode, `${method} ${path}`);
      assert.equal(answer.body.toString(), overHttp1.body, `${method} ${path}`);
      assert.equal('connection' in answer.headers, false);
    }
  });

  it("writes the router's refusals - a path it cannot decode, an id over 100 characters - as over HTTP/1.1, with no Connection field, and the connection goes on", async () => {
    const session = client(plain);

    for (const [path, status, code] of [
      ['/%zz', 400, 'FST_ERR_BAD_URL'],
      [`/s/${'a'.repeat(101)}`, 414, 'FST_ERR_MAX_PARAM_LENGTH'],
    ] as const) {
      // A body still arriving, which over HTTP/1.1 ends the connection.
      let open: ClientHttp2Stream | undefined;
      const answer = await h2Request(
        session,
        { ':method': 'POST', ':path': path },
        { body: 'part', keepOpen: true, opened: (stream) => (open = stream) },
      );
      const overHttp1 = http1Answer(await http1(plain, `GET ${path} HTTP/1.1\r\nHost: h\r\n\r\n`));

      assert.equal(answer.status, status, path);
      assert.equal(JSON.parse(answer.body.toString()).code, code, path);
      assert.equal(answer.body.toString(), overHttp1.body, path);
      assert.equal(overHttp1.status, status, path);
      assert.equal('connection' in answer.headers, false, path);
      assert.ok(open?.closed, 'the stream ended once answered');
    }

    assert.equal((await h2Request(session, { ':path': '/robots.txt' })).status, 200);
  });
});

describe('the HTTP/2 preface on the HTTP/1.1 path, RECEIVE_HTTP2 off and on (#277)', () => {
  for (const http2 of ['off', 'on'] as const) {
    for (const proxy of ['off', 'v2'] as const) {
      const shapes: [string, Buffer][] = [
        [
          '23 bytes of the preface and 64 KiB of X',
          Buffer.concat([HTTP2_PREFACE.subarray(0, 23), Buffer.alloc(65_536, 'X')]),
        ],
        // With the setting on, the whole preface goes to the HTTP/2 path.
        ...(http2 === 'off' ? [['the whole preface', HTTP2_PREFACE] as [string, Buffer]] : []),
      ];

      it(`answers ${shapes.map(([what]) => what).join(', and ')} with today's 400, byte for byte, stores nothing and logs nothing at warn or above (RECEIVE_HTTP2 ${http2}, PROXY ${proxy})`, async () => {
        const { target, lines } = await listenLogged({
          ...(proxy === 'v2' ? PROXIED : {}),
          ...(http2 === 'on' ? { http2: 'on' as const } : {}),
        });
        const part = receiverHttp2(target.app);
        const own: Listening =
          proxy === 'v2' ? { ...target, header: proxyV2Header(SENDER), sourceIp: SENDER } : target;
        let requests = 0;

        assert.equal(part === undefined, http2 === 'off');
        // Nothing is stored without a request: none reaches either instance.
        target.app.server.on('request', () => {
          requests += 1;
        });
        part?.server.on('stream', () => {
          requests += 1;
        });

        for (const [what, bytes] of shapes) {
          const socket = await raw(own);
          const received = receiveUntilClosed(socket);

          socket.write(bytes);
          // As on the base (eec3e7b) and as #206 measured it on production.
          assert.equal((await received).bytes.toString('latin1'), PREFACE_ANSWER, what);
        }

        assert.equal(requests, 0, 'a request reached the receiver');
        assert.deepEqual(
          lines().filter((line) => line.level >= WARN_LEVEL),
          [],
          'logged at warn or above',
        );
      });
    }
  }

  // What follows a PRI head Node's parser holds reaches it at once, whatever
  // room the sender's address has: in an earlier version, where what followed
  // a `PRI` head was still counted, it waited for room once the address's
  // lines were all in flight, and was answered Node's 408 at its 60 s
  // `headersTimeout`.
  // With the setting on, the preface layer hands the head on together with
  // the byte after it, so nothing can take the address's lines between them.
  for (const proxy of ['off', 'v2'] as const) {
    it(`answers what follows a PRI head with today's 400 at once, byte for byte, while the address's header lines are all in flight, stores nothing and logs nothing at warn or above (RECEIVE_HTTP2 off, PROXY ${proxy})`, async () => {
      const headerLines = createHeaderLineBudget({ perAddress: 100, perProcess: 10_000 });
      const open = headerLines.open;
      let givenBack = 0;

      // Counts the sections whose lines are given back, so that the PRI
      // head is known to be held, its lines given back, before a holder
      // takes every line the address has.
      headerLines.open = (key, wake) => {
        const account = open(key, wake);
        const giveBack = account.giveBack;

        account.giveBack = () => {
          givenBack += 1;
          giveBack();
        };

        return account;
      };

      const { target, lines } = await listenLogged({
        ...(proxy === 'v2' ? PROXIED : {}),
        headerLines,
      });
      const own: Listening =
        proxy === 'v2' ? { ...target, header: proxyV2Header(SENDER), sourceIp: SENDER } : target;
      let requests = 0;

      target.app.server.on('request', () => {
        requests += 1;
      });

      for (const after of ['X', 'SM\r\n\r\n']) {
        const socket = await raw(own);
        const received = receiveUntilClosed(socket);
        const before = givenBack;

        socket.write('PRI * HTTP/2.0\r\n\r\n');
        await eventually(async () => givenBack > before, `${after}: the PRI head held`);

        // 100 lines, the address's number, in a head that does not end.
        const holder = await raw(own);

        holder.write(`POST /holder HTTP/1.1\r\nHost: h\r\n${'a:\r\n'.repeat(98)}`);
        await eventually(
          async () => headerLines.linesOf(own.sourceIp) === 100,
          `${after}: the holder has the address’s lines`,
        );

        const sent = Date.now();

        socket.write(after);

        const answer = await received;

        // As on the base (eec3e7b) and as #206 measured it on production.
        assert.equal(answer.bytes.toString('latin1'), PREFACE_ANSWER, after);
        assert.ok(Date.now() - sent < 5_000, `${after}: answered at once, not at a timeout`);
        assert.equal(headerLines.waiting, 0, `${after}: nothing waited for room`);
        holder.destroy();
        await eventually(
          async () => headerLines.lines === 0 && headerLines.waiting === 0,
          `${after}: every line given back`,
        );
      }

      assert.equal(requests, 0, 'a request reached the receiver');
      assert.deepEqual(
        lines().filter((line) => line.level >= WARN_LEVEL),
        [],
        'logged at warn or above',
      );
    });
  }
});

describe('with RECEIVE_HTTP2 on, an HTTP/1.1 connection (criterion 3)', () => {
  /** A request with mixed-case names, a repeat and a body, as a sender writes it. */
  const request = (sessionId: string, version = '1.1'): string =>
    `POST /s/${sessionId}/x?q=1 HTTP/${version}\r\nHost: hook.qa-tools.ru\r\nX-Zeta-Sig: a\r\n` +
    `aLpHa-MiXeD: b\r\nx-dup: 1\r\nX-Dup: 2\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello`;

  for (const [on, offTarget, label] of [
    [() => plain, () => off, 'PROXY off'],
    [() => proxied, () => offProxied, 'PROXY v2'],
  ] as const) {
    it(`is stored exactly as with the setting off: names, case, order, repeats, raw request (${label})`, async () => {
      const withOn = await newSession();
      const withOff = await newSession();

      await http1(on(), request(withOn));
      await http1(offTarget(), request(withOff));
      await eventually(
        async () => (await storedRequests(withOn)).length === 1,
        'stored with it on',
      );
      await eventually(
        async () => (await storedRequests(withOff)).length === 1,
        'stored with it off',
      );

      const a = await storedRequest(withOn);
      const b = await storedRequest(withOff);

      assert.equal(a.http_version, '1.1');
      assert.deepEqual(a.headers, [
        ['Host', 'hook.qa-tools.ru'],
        ['X-Zeta-Sig', 'a'],
        ['aLpHa-MiXeD', 'b'],
        ['x-dup', '1'],
        ['X-Dup', '2'],
        ['Content-Type', 'text/plain'],
        ['Content-Length', '5'],
      ]);
      assert.deepEqual(a.headers, b.headers);
      assert.equal(a.source_ip, b.source_ip);
      assert.equal(a.raw_request.toString('latin1'), request(withOn));
      assert.equal(
        a.raw_request.toString('latin1').replace(withOn, 'ID'),
        b.raw_request.toString('latin1').replace(withOff, 'ID'),
      );
    });
  }

  it('keeps an HTTP/1.1 request line that says HTTP/2.0 an HTTP/1.1 capture, raw request line and all, as with it off', async () => {
    const withOn = await newSession();
    const withOff = await newSession();

    await http1(plain, request(withOn, '2.0'));
    await http1(off, request(withOff, '2.0'));
    await eventually(async () => (await storedRequests(withOn)).length === 1, 'stored with it on');
    await eventually(
      async () => (await storedRequests(withOff)).length === 1,
      'stored with it off',
    );

    const a = await storedRequest(withOn);
    const b = await storedRequest(withOff);

    assert.equal(a.http_version, b.http_version);
    assert.ok(a.raw_request.toString('latin1').startsWith(`POST /s/${withOn}/x?q=1 HTTP/`));
    assert.deepEqual(a.headers, b.headers);

    const answers = await pool.query<{ raw: Buffer }>(
      `SELECT raw_response AS raw FROM request_responses WHERE request_id = ANY($1) ORDER BY raw_response`,
      [[a.id, b.id]],
    );

    for (const { raw } of answers.rows) {
      assert.ok(
        raw.toString('latin1').startsWith('HTTP/1.1 200 OK\r\n'),
        'an HTTP/1.1 status line',
      );
    }
  });

  it('captures Upgrade: h2c as HTTP/1.1 and answers 200, never 101', async () => {
    const sessionId = await newSession();
    const text = await http1(
      plain,
      `GET /s/${sessionId} HTTP/1.1\r\nHost: h\r\nConnection: Upgrade, HTTP2-Settings\r\n` +
        `Upgrade: h2c\r\nHTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\n\r\n`,
    );

    assert.ok(text.startsWith('HTTP/1.1 200 OK\r\n'), text);
    assert.equal(text.includes(' 101 '), false);

    const stored = await storedRequest(sessionId);

    assert.equal(stored.http_version, '1.1');
    assert.deepEqual(
      stored.headers.map(([name]) => name),
      ['Host', 'Connection', 'Upgrade', 'HTTP2-Settings'],
    );
  });

  it('keeps the pipelining bound and the header-line count on an HTTP/1.1 connection, and an HTTP/2 one never meets them (D229, D238)', async () => {
    const headerLines = createHeaderLineBudget();
    const receiver = await listen({ http2: 'on', pipelinedRequests: 2, headerLines });
    const target: Listening = {
      app: receiver,
      port: portOf(receiver),
      header: undefined,
      sourceIp: PROXY_PEER,
    };
    const sessionId = await newSession({ status: 200, delayMs: 600 });
    const socket = await raw(target);
    const get = `GET /s/${sessionId} HTTP/1.1\r\nHost: h\r\n\r\n`;

    // Three pipelined: the first held by its delay, the second read, the
    // third left unread at the bound of 2.
    socket.write(get + get + get);
    await eventually(async () => (await storedRequests(sessionId)).length === 2, 'two stored');
    await delay(250);
    assert.equal((await storedRequests(sessionId)).length, 2, 'the third waits unread');
    await eventually(
      async () => (await storedRequests(sessionId)).length === 3,
      'the third stored once the first is answered',
      3_000,
    );

    // A head still arriving holds its lines in the budget, counted by the
    // slicing layer.
    socket.write('GET /s/x HTTP/1.1\r\nHost: h\r\nA: 1\r\nB: 2\r\n');
    await eventually(async () => headerLines.lines >= 3, 'the lines in flight counted');
    socket.destroy();
    await eventually(async () => headerLines.lines === 0, 'the lines given back');

    // An HTTP/2 request with many fields, held by a delay: never counted.
    const delayed = await newSession({ status: 200, delayMs: 300 });
    const fields: http2.OutgoingHttpHeaders = { ':method': 'GET', ':path': `/s/${delayed}` };

    for (let index = 0; index < 50; index += 1) {
      fields[`x-${index}`] = 'v';
    }

    const pending = h2Request(client(target), fields);

    await eventually(async () => (await storedRequests(delayed)).length === 1, 'stored');
    assert.equal(headerLines.lines, 0);
    assert.equal((await pending).status, 200);
  });
});

describe('the preface layer and PROXY protocol v2 (criterion 4)', () => {
  it('reads one PROXY header for a connection, its address the sourceIp of every stream on it', async () => {
    const sessionId = await newSession();
    const session = client(proxied);

    const answers = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        h2Request(
          session,
          { ':method': 'POST', ':path': `/s/${sessionId}/${index}` },
          { body: String(index) },
        ),
      ),
    );

    assert.deepEqual(
      answers.map((answer) => answer.status),
      [200, 200, 200, 200, 200],
    );

    const rows = await storedRequests(sessionId);

    assert.equal(rows.length, 5);
    assert.deepEqual(new Set(rows.map((row) => row.source_ip)), new Set([SENDER]));
    assert.deepEqual(new Set(rows.map((row) => row.http_version)), new Set(['2.0']));
  });

  for (const [what, bytes] of [
    ['no PROXY header, the preface first', HTTP2_PREFACE],
    [
      'a version 1 header',
      Buffer.concat([Buffer.from(`PROXY TCP4 ${SENDER} 10.42.0.24 50000 8443\r\n`), HTTP2_PREFACE]),
    ],
    [
      'a LOCAL header',
      Buffer.concat([PROXY_V2_SIGNATURE, Buffer.from([0x20, 0x00, 0x00, 0x00]), HTTP2_PREFACE]),
    ],
  ] as const) {
    it(`destroys a connection with ${what}, nothing written`, async () => {
      const socket = await rawConnection(proxied.port);

      sockets.push(socket);

      const received = receiveUntilClosed(socket);

      socket.write(bytes);

      assert.equal((await received).bytes.length, 0);
    });
  }

  it('destroys a connection whose PROXY header misses its deadline, nothing written', async () => {
    const socket = await rawConnection(proxied.port);

    sockets.push(socket);

    const start = Date.now();
    const received = receiveUntilClosed(socket, start);

    socket.write(proxied.header?.subarray(0, 10) ?? Buffer.alloc(0));

    const result = await received;

    assert.equal(result.bytes.length, 0);
    assert.ok(result.closedAfterMs >= DEADLINE_MS - 20, `${result.closedAfterMs} ms`);
  });

  it('destroys a connection from a peer outside the trust boundary, nothing written', async () => {
    const receiver = await listen({ ...PROXIED, trustedProxyCidrs: ['10.42.0.0/24'], http2: 'on' });
    const socket = await rawConnection(portOf(receiver));

    sockets.push(socket);

    const received = receiveUntilClosed(socket);

    socket.write(Buffer.concat([proxyV2Header(SENDER), HTTP2_PREFACE]));

    assert.equal((await received).bytes.length, 0);
  });

  for (const name of ['plain', 'proxied'] as const) {
    const label = name === 'plain' ? 'PROXY off' : 'PROXY v2';
    const target = (): Listening => (name === 'plain' ? plain : proxied);

    it(`destroys a preface stopped part-way at the layer's deadline, nothing written (${label})`, async () => {
      for (const length of [3, 10, 23]) {
        const socket = await raw(target());
        const start = Date.now();
        const received = receiveUntilClosed(socket, start);

        socket.write(HTTP2_PREFACE.subarray(0, length));

        const result = await received;

        assert.equal(result.bytes.length, 0, `${length} bytes`);
        assert.ok(
          result.closedAfterMs >= DEADLINE_MS - 20,
          `${length} bytes: ${result.closedAfterMs} ms`,
        );
        assert.ok(
          result.closedAfterMs < DEADLINE_MS + 1_000,
          `${length} bytes: ${result.closedAfterMs} ms`,
        );
      }
    });

    it(`takes a preface written a byte at a time, and captures the request after it (${label})`, async () => {
      // 24 writes 5 ms apart: a listener of its own, with the default
      // deadline, so that a loaded runner cannot take it past the shared
      // 300 ms one.
      const receiver = await listen({ ...(name === 'plain' ? {} : PROXIED), http2: 'on' });
      const own: Listening = { ...target(), app: receiver, port: portOf(receiver) };
      const sessionId = await newSession();
      const socket = await raw(own);
      const received: Buffer[] = [];

      socket.on('data', (chunk: Buffer) => received.push(chunk));
      await writeByteByByte(socket, HTTP2_PREFACE);
      socket.write(frame(FRAME_SETTINGS, 0, 0, Buffer.alloc(0)));
      socket.write(
        frame(
          FRAME_HEADERS,
          FLAG_END_HEADERS | FLAG_END_STREAM,
          1,
          literalHeaderBlock([
            [':method', 'GET'],
            [':scheme', 'http'],
            [':path', `/s/${sessionId}/bytes`],
            [':authority', 'h'],
            ['x-one', '1'],
          ]),
        ),
      );

      await eventually(async () => (await storedRequests(sessionId)).length === 1, 'stored');

      const stored = await storedRequest(sessionId);

      assert.equal(stored.http_version, '2.0');
      assert.equal(stored.path, `/s/${sessionId}/bytes`);
      assert.deepEqual(stored.headers, [['x-one', '1']]);
      assert.equal(stored.source_ip, own.sourceIp);
      await eventually(
        async () => frameTypes(Buffer.concat(received)).includes(FRAME_HEADERS),
        'answered',
      );
      assert.equal(
        frameTypes(Buffer.concat(received))[0],
        FRAME_SETTINGS,
        'the server speaks HTTP/2',
      );
      socket.destroy();
    });

    it(`gives a first byte that disagrees with the preface to HTTP/1.1, bytes unchanged (${label})`, async () => {
      // `P`, `PR` and `PRO` agree with the preface until `PRO`'s third byte.
      const sessionId = await newSession();
      const text = `PROPFIND /s/${sessionId}/dav/ HTTP/1.1\r\nHost: h\r\nDepth: 1\r\nContent-Length: 4\r\n\r\n<a/>`;
      const socket = await raw(target());
      const answer = receiveUntilClosed(socket);

      await writeByteByByte(socket, Buffer.from(text.slice(0, 4)));
      socket.write(text.slice(4));
      setTimeout(() => socket.end(), 300).unref();

      assert.ok((await answer).bytes.toString('latin1').startsWith('HTTP/1.1 200 OK\r\n'));

      const stored = await storedRequest(sessionId);

      assert.equal(stored.http_version, '1.1');
      assert.equal(stored.method, 'PROPFIND');
      assert.equal(stored.raw_request.toString('latin1'), text);

      // `PRI` begins no request Node's parser takes: the same 400 as with it off.
      assert.equal(
        await http1(target(), `PRI /s/${sessionId} HTTP/1.1\r\nHost: h\r\n\r\n`),
        await http1(
          name === 'plain' ? off : offProxied,
          `PRI /s/${sessionId} HTTP/1.1\r\nHost: h\r\n\r\n`,
        ),
      );
    });

    it(`closes at once, nothing written, a connection that half-closes before the layer has decided (${label})`, async () => {
      // A deadline long enough that waiting for it would show.
      const receiver = await listen({
        ...(name === 'plain' ? {} : PROXIED),
        http2: 'on',
        prefaceTimeoutMs: 5_000,
      });
      const own: Listening = { ...target(), app: receiver, port: portOf(receiver) };

      for (const sent of ['', 'P', 'PR', 'PRI * HT']) {
        const socket = await raw(own);
        const start = Date.now();
        const received = receiveUntilClosed(socket, start);

        socket.end(sent);

        const result = await received;

        assert.equal(result.bytes.length, 0, JSON.stringify(sent));
        assert.ok(
          result.closedAfterMs < 1_000,
          `${JSON.stringify(sent)}: ${result.closedAfterMs} ms`,
        );
      }
    });

    it(`hands a connection that has sent nothing, or only P or PR, to HTTP/1.1 at the deadline, and captures what follows (${label})`, async () => {
      for (const first of ['', 'P', 'PR']) {
        const sessionId = await newSession();
        const method = first === 'PR' ? 'PROPPATCH' : 'POST';
        const text = `${method} /s/${sessionId} HTTP/1.1\r\nHost: h\r\nContent-Length: 2\r\n\r\nok`;
        const socket = await raw(target());
        const answer = receiveUntilClosed(socket);

        if (first !== '') {
          socket.write(first);
        }

        await delay(DEADLINE_MS + 200);
        socket.write(text.slice(first.length));
        setTimeout(() => socket.end(), 300).unref();

        assert.ok((await answer).bytes.toString('latin1').startsWith('HTTP/1.1 200 OK\r\n'), first);

        const stored = await storedRequest(sessionId);

        assert.equal(stored.raw_request.toString('latin1'), text, first);
      }
    });
  }
});

/** The size HTTP/2 counts for a header list: name, value and 32 bytes a field. */
function listSize(fields: [string, string][]): number {
  return fields.reduce((sum, [name, value]) => sum + name.length + value.length + 32, 0);
}

/**
 * A `POST` to `sessionId` whose header list is `extra` bytes over
 * `HTTP2_MAX_HEADER_LIST_SIZE`, at it with 0: mostly the same short field,
 * which HPACK sends in a byte or a few, as a header block compressed past
 * about 144 KiB is a connection error in nghttp2, whatever the list size
 * (D263), and one field that makes up the rest.
 */
function listOfSize(sessionId: string, extra: number): [string, string][] {
  const fields: [string, string][] = [
    [':method', 'POST'],
    [':path', `/s/${sessionId}`],
    [':scheme', 'http'],
    [':authority', 'h'],
    ...Array.from({ length: 4_000 }, (): [string, string] => ['a', '']),
  ];
  const last = HTTP2_MAX_HEADER_LIST_SIZE - listSize(fields) - 'x-last'.length - 32 + extra;

  fields.push(['x-last', 'w'.repeat(last)]);

  return fields;
}

/** A request's headers object from fields, repeated names as arrays, in order. */
function headersOf(fields: [string, string][]): http2.OutgoingHttpHeaders {
  const headers: Record<string, string | string[]> = {};

  for (const [name, value] of fields) {
    const existing = headers[name];

    if (existing === undefined) {
      headers[name] = value;
    } else {
      headers[name] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    }
  }

  return headers;
}

describe('the HTTP/2 limits at their edges (criterion 5)', () => {
  /** A client that may send a header block of any size. */
  const bigClient = (): http2.ClientHttp2Session =>
    client(plain, { maxSendHeaderBlockLength: 4 * 1024 * 1024 });

  it('announces 32 streams and the header list size in its SETTINGS', async () => {
    const session = client(plain);

    await new Promise<void>((resolve) => session.once('remoteSettings', () => resolve()));
    assert.equal(session.remoteSettings.maxConcurrentStreams, HTTP2_MAX_CONCURRENT_STREAMS);
    assert.equal(session.remoteSettings.maxHeaderListSize, HTTP2_MAX_HEADER_LIST_SIZE);
  });

  for (const name of ['plain', 'proxied'] as const) {
    it(`answers 32 concurrent streams and refuses the 33rd with REFUSED_STREAM, storing 32 (${name === 'plain' ? 'PROXY off' : 'PROXY v2'})`, async () => {
      const sessionId = await newSession({ status: 200, delayMs: 500 });
      const session = client(name === 'plain' ? plain : proxied);
      // All 33 opened before the connection is, so before the server's
      // SETTINGS can have arrived: Node's client would otherwise hold the
      // 33rd back itself.
      const answers = await Promise.all(
        Array.from({ length: HTTP2_MAX_CONCURRENT_STREAMS + 1 }, (_unused, index) =>
          h2Request(
            session,
            { ':method': 'POST', ':path': `/s/${sessionId}/${index}` },
            { body: 'x' },
          ),
        ),
      );
      const answered = answers.filter((answer) => answer.status === 200);
      const refused = answers.filter((answer) => answer.status === undefined);

      assert.equal(answered.length, 32);
      assert.equal(refused.length, 1);
      assert.equal(refused[0]?.rstCode, constants.NGHTTP2_REFUSED_STREAM);
      assert.equal((await storedRequests(sessionId)).length, 32);
    });
  }

  it(`keeps ${HTTP2_MAX_CONNECTIONS_PER_ADDRESS} HTTP/2 connections from one address with PROXY v2 and closes the next with nothing written, serves HTTP/1.1 from it meanwhile, logs the refusal naming no address, and takes a new one once one closes (D266)`, async () => {
    assert.equal(HTTP2_MAX_CONNECTIONS_PER_ADDRESS, 32);

    // A listener of its own: no other test's connections from SENDER take
    // its places, and its log lines are read.
    const { target, lines } = await listenLogged({
      ...PROXIED,
      http2: 'on',
      prefaceTimeoutMs: DEADLINE_MS,
    });
    const from: Listening = { ...target, header: proxyV2Header(SENDER), sourceIp: SENDER };
    const part = receiverHttp2(target.app);
    const places = part?.connections;

    assert.ok(part !== undefined && places !== null && places !== undefined);

    const sessionId = await newSession();
    const webhook = (session: http2.ClientHttp2Session, label: string): Promise<H2Answer> =>
      h2Request(
        session,
        { ':method': 'POST', ':path': `/s/${sessionId}`, 'content-type': 'application/json' },
        { body: JSON.stringify({ connection: label }) },
      );
    const held: http2.ClientHttp2Session[] = [];

    // 32 connections from the address, each answered an ordinary webhook
    // and left open.
    for (let index = 1; index <= HTTP2_MAX_CONNECTIONS_PER_ADDRESS; index += 1) {
      const session = client(from);

      assert.equal((await webhook(session, String(index))).status, 200, `connection ${index}`);
      held.push(session);
    }

    assert.equal(places.takenBy(SENDER), HTTP2_MAX_CONNECTIONS_PER_ADDRESS);
    assert.equal((await storedRequests(sessionId)).length, HTTP2_MAX_CONNECTIONS_PER_ADDRESS);

    // The 33rd sends the preface, its SETTINGS and a whole webhook in its
    // first flight: it is closed with nothing written, and nothing of it is
    // stored.
    const overSession = await newSession();
    const socket = await raw(from);
    const received = receiveUntilClosed(socket);

    socket.write(
      Buffer.concat([
        HTTP2_PREFACE,
        frame(FRAME_SETTINGS, 0, 0, Buffer.alloc(0)),
        frame(
          FRAME_HEADERS,
          FLAG_END_HEADERS | FLAG_END_STREAM,
          1,
          literalHeaderBlock([
            [':method', 'POST'],
            [':scheme', 'http'],
            [':path', `/s/${overSession}`],
            [':authority', 'hook.qa-tools.test'],
          ]),
        ),
      ]),
    );

    const over = await within(received, 5_000, 'the 33rd connection closed');

    assert.equal(over.bytes.length, 0, 'the 33rd connection was written to');
    assert.equal(part.refused, 1);
    assert.equal(places.takenBy(SENDER), HTTP2_MAX_CONNECTIONS_PER_ADDRESS);
    assert.equal((await storedRequests(overSession)).length, 0);

    // HTTP/1.1 from the same address meanwhile: answered and stored, its
    // address the PROXY header's.
    const http1Session = await newSession();
    const answer = await http1(
      from,
      `POST /s/${http1Session} HTTP/1.1\r\nHost: hook.qa-tools.test\r\n` +
        'Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
    );

    assert.match(answer, /^HTTP\/1\.1 200 /);

    const overHttp1 = await storedRequest(http1Session);

    assert.equal(overHttp1.http_version, '1.1');
    assert.equal(overHttp1.source_ip, SENDER);

    // The refusal is logged once, at warn, as a count: neither the sender's
    // address nor the proxy's is in it, and no line names the sender.
    const refusals = lines().filter((line) =>
      line.msg.includes('every HTTP/2 connection place taken'),
    );

    assert.equal(refusals.length, 1, JSON.stringify(lines()));

    const refusal = refusals[0] as LogLine & {
      refused?: number;
      http2ConnectionsPerAddress?: number;
    };

    assert.equal(refusal.level, WARN_LEVEL);
    assert.equal(refusal.refused, 1);
    assert.equal(refusal.http2ConnectionsPerAddress, HTTP2_MAX_CONNECTIONS_PER_ADDRESS);
    assert.equal(JSON.stringify(refusal).includes(SENDER), false, 'the refusal names the sender');
    assert.equal(JSON.stringify(refusal).includes(PROXY_PEER), false, 'the refusal names the peer');
    assert.equal(
      lines().some((line) => JSON.stringify(line).includes(SENDER)),
      false,
      'a log line names the sender',
    );

    // One of the 32 closes: its place comes back, and a new HTTP/2
    // connection from the address is answered and stored.
    await closeH2(held[0] as http2.ClientHttp2Session);
    await eventually(
      async () => places.takenBy(SENDER) === HTTP2_MAX_CONNECTIONS_PER_ADDRESS - 1,
      'the closed connection gives its place back',
    );
    assert.equal((await webhook(client(from), 'again')).status, 200);
    assert.equal(places.takenBy(SENDER), HTTP2_MAX_CONNECTIONS_PER_ADDRESS);
    assert.equal((await storedRequests(sessionId)).length, HTTP2_MAX_CONNECTIONS_PER_ADDRESS + 1);
    assert.equal(part.refused, 1);
  });

  it(`stores a header list of exactly ${HTTP2_MAX_HEADER_LIST_PAIRS} fields and refuses one more with ENHANCE_YOUR_CALM, nothing stored`, async () => {
    const atEdge = await newSession();
    const over = await newSession();
    const fieldsFor = (sessionId: string, regular: number): [string, string][] => [
      [':method', 'GET'],
      [':path', `/s/${sessionId}`],
      [':scheme', 'http'],
      [':authority', 'h'],
      ...Array.from({ length: regular }, (): [string, string] => ['a', '']),
    ];
    const edge = fieldsFor(atEdge, HTTP2_MAX_HEADER_LIST_PAIRS - 4);
    const beyond = fieldsFor(over, HTTP2_MAX_HEADER_LIST_PAIRS - 3);

    // Within the size, so that only the number of fields decides.
    assert.ok(listSize(beyond) <= HTTP2_MAX_HEADER_LIST_SIZE);

    const session = bigClient();
    const stored = await h2Request(session, headersOf(edge));
    const refused = await h2Request(session, headersOf(beyond));

    assert.equal(stored.status, 200);
    assert.equal((await storedRequest(atEdge)).headers.length, HTTP2_MAX_HEADER_LIST_PAIRS - 4);
    assert.equal(refused.status, undefined);
    assert.equal(refused.rstCode, constants.NGHTTP2_ENHANCE_YOUR_CALM);
    assert.equal((await storedRequests(over)).length, 0);
    // The connection goes on.
    assert.equal((await h2Request(session, { ':path': '/robots.txt' })).status, 200);
  });

  it(`stores a header list of exactly ${HTTP2_MAX_HEADER_LIST_SIZE} bytes and refuses one byte more, nothing stored`, async () => {
    const atEdge = await newSession();
    const over = await newSession();
    const edge = listOfSize(atEdge, 0);
    const beyond = listOfSize(over, 1);

    assert.equal(listSize(edge), HTTP2_MAX_HEADER_LIST_SIZE);

    const session = bigClient();
    const stored = await h2Request(session, headersOf(edge), { body: 'b' });
    const refused = await h2Request(session, headersOf(beyond), { body: 'b' });

    assert.equal(stored.status, 200);
    assert.equal((await storedRequest(atEdge)).headers.length, 4_001);
    assert.equal(refused.status, undefined);
    assert.equal(refused.rstCode, constants.NGHTTP2_ENHANCE_YOUR_CALM);
    assert.equal((await storedRequests(over)).length, 0);
  });

  // Node holds a list to the size it announces only once the client has
  // acknowledged its SETTINGS; a client with prior knowledge sends its first
  // request before it can have (D263, `createReceiveHttp2Server`).
  for (const name of ['plain', 'proxied'] as const) {
    it(`holds a connection's first request to ${HTTP2_MAX_HEADER_LIST_SIZE} bytes before its client has acknowledged the SETTINGS, raw frames: stored at the size, refused one byte over (${name === 'plain' ? 'PROXY off' : 'PROXY v2'})`, async () => {
      const target = name === 'plain' ? plain : proxied;
      const atEdge = await newSession();
      const over = await newSession();

      const stored = await firstFlight(
        target,
        headerBlockFrames(literalHeaderBlock(listOfSize(atEdge, 0)), 1, true),
        answeredOrReset(1),
      );

      assert.ok(answeredOn(stored, 1), 'the list at the size answered');
      assert.equal(resetCode(stored, 1), undefined);
      assert.equal((await storedRequest(atEdge)).headers.length, 4_001);

      const refused = await firstFlight(
        target,
        Buffer.concat([
          headerBlockFrames(literalHeaderBlock(listOfSize(over, 1)), 1, true),
          // The connection goes on.
          frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS | FLAG_END_STREAM,
            3,
            literalHeaderBlock([
              [':method', 'GET'],
              [':scheme', 'http'],
              [':path', '/robots.txt'],
              [':authority', 'h'],
            ]),
          ),
        ]),
        (received) => answeredOrReset(1)(received) && answeredOn(received, 3),
      );

      assert.equal(resetCode(refused, 1), constants.NGHTTP2_ENHANCE_YOUR_CALM);
      assert.equal(answeredOn(refused, 1), false);
      assert.equal((await storedRequests(over)).length, 0);
    });
  }

  it("holds a fresh connection's first request from Node's client to the size: refused one byte over, stored at it", async () => {
    const atEdge = await newSession();
    const over = await newSession();
    // Each request is made as its session is: Node's client sends it with
    // its preface, before the server's SETTINGS can have arrived.
    const refused = await h2Request(bigClient(), headersOf(listOfSize(over, 1)), { body: 'b' });
    const stored = await h2Request(bigClient(), headersOf(listOfSize(atEdge, 0)), { body: 'b' });

    assert.equal(refused.status, undefined);
    assert.equal(refused.rstCode, constants.NGHTTP2_ENHANCE_YOUR_CALM);
    assert.equal((await storedRequests(over)).length, 0);
    assert.equal(stored.status, 200);
    assert.equal((await storedRequest(atEdge)).headers.length, 4_001);
  });

  it('refuses HPACK-amplified lists sent before the ACK on every stream of every connection, builds no request of them, and stores nothing', async () => {
    const target = await ownTarget({ http2: 'on' });
    const part = receiverHttp2(target.app);
    const sessionId = await newSession();
    let requests = 0;

    assert.ok(part !== undefined);
    part.server.on('request', () => {
      requests += 1;
    });

    // 2,000 references to one 4,000-byte value: about 6 KB on the wire, a
    // list of 8,074,000 bytes as HTTP/2 counts it, which Node's 10 MB of
    // session memory lets through before the ACK.
    const references = 2_000;
    const streams = Array.from(
      { length: HTTP2_MAX_CONCURRENT_STREAMS },
      (_unused, index) => 1 + 2 * index,
    );
    const block = (streamId: number): Buffer =>
      Buffer.concat([
        Buffer.from([0x83, 0x86]),
        literalHeaderBlock([
          [':path', `/s/${sessionId}/${streamId}`],
          [':authority', 'h'],
        ]),
        amplifiedFields('x-big', 4_000, references),
      ]);
    const connections = 4;

    for (let connection = 0; connection < connections; connection += 1) {
      const received = await firstFlight(
        target,
        Buffer.concat(
          streams.map((streamId) => headerBlockFrames(block(streamId), streamId, true)),
        ),
        (frames) => streams.every((streamId) => resetCode(frames, streamId) !== undefined),
      );

      for (const streamId of streams) {
        assert.equal(resetCode(received, streamId), constants.NGHTTP2_ENHANCE_YOUR_CALM);
      }

      assert.equal(received.filter((one) => one.type === FRAME_GOAWAY).length, 0);
    }

    const countedBytes = connections * streams.length * references * ('x-big'.length + 4_000 + 32);

    assert.equal(requests, 0, 'no request built of a refused list');
    assert.equal((await storedRequests(sessionId)).length, 0);
    // About 1 GB as HTTP/2 counts it, all of it refused.
    assert.ok(countedBytes > 1_000_000_000, `${countedBytes} bytes counted`);
    // The connection after them is served as any other.
    assert.equal((await h2Request(client(target), { ':path': '/robots.txt' })).status, 200);
  });

  it('refuses trailers over the size sent before the ACK, as Node refuses them after it, nothing stored', async () => {
    const sessionId = await newSession();
    const received = await firstFlight(
      plain,
      Buffer.concat([
        frame(
          FRAME_HEADERS,
          FLAG_END_HEADERS,
          1,
          literalHeaderBlock([
            [':method', 'POST'],
            [':scheme', 'http'],
            [':path', `/s/${sessionId}`],
            [':authority', 'h'],
          ]),
        ),
        frame(FRAME_DATA, 0, 1, Buffer.from('body')),
        headerBlockFrames(amplifiedFields('x-big', 4_000, 2_000), 1, true),
      ]),
      answeredOrReset(1),
    );

    assert.equal(resetCode(received, 1), constants.NGHTTP2_ENHANCE_YOUR_CALM);
    await delay(200);
    assert.equal((await storedRequests(sessionId)).length, 0);
  });

  it('stores a 2,500-field webhook over HTTP/2, as capture-admission.test.ts stores one over HTTP/1.1', async () => {
    const sessionId = await newSession();
    const fields: http2.OutgoingHttpHeaders = { ':method': 'POST', ':path': `/s/${sessionId}` };

    for (let index = 0; index < 2_500; index += 1) {
      fields[`x-line-${index}`] = String(index);
    }

    const answer = await h2Request(bigClient(), fields, { body: 'b' });

    assert.equal(answer.status, 200);
    assert.equal((await storedRequest(sessionId)).headers.length, 2_500);
  });

  for (const framing of ['with', 'without'] as const) {
    it(`stores a body of exactly 1 MiB and answers 1 MiB + 1 byte 413 / 1004, nothing stored, ${framing} content-length`, async () => {
      const atEdge = await newSession();
      const over = await newSession();
      const send = (sessionId: string, length: number): Promise<H2Answer> =>
        h2Request(
          client(plain),
          {
            ':method': 'POST',
            ':path': `/s/${sessionId}`,
            ...(framing === 'with' ? { 'content-length': String(length) } : {}),
          },
          { body: [Buffer.alloc(length - 1, 0x61), Buffer.from('z')] },
        );

      const stored = await send(atEdge, MAX_BODY_BYTES);
      const refused = await send(over, MAX_BODY_BYTES + 1);

      assert.equal(stored.status, 200);
      assert.equal((await storedRequest(atEdge)).body.length, MAX_BODY_BYTES);
      assert.equal(refused.status, 413);
      assert.deepEqual(JSON.parse(refused.body.toString()), {
        errorCode: 1004,
        message: 'Payload too large',
      });
      assert.equal('connection' in refused.headers, false);
      assert.equal((await storedRequests(over)).length, 0);
    });
  }

  it('weighs a body with no content-length as an open body in the capture budget, and one whose stream ended with its headers as none', async () => {
    const budget = createCaptureBudget({
      totalBytes: 600 * 1024,
      perAddressBytes: 600 * 1024,
      waitMs: 300,
      lightSenderBytes: 0,
      lightReserveBytes: 0,
    });
    const receiver = await listen({ http2: 'on', captureBudget: budget });
    const target: Listening = {
      app: receiver,
      port: portOf(receiver),
      header: undefined,
      sourceIp: PROXY_PEER,
    };
    const sessionId = await newSession();
    const session = client(target);
    // The budget held by the test until it has seen what it asserts, so that
    // it is not empty: a weight larger than the budget goes in only once the
    // budget holds nothing, and the small ones fit beside it.
    const held = budget.take('held-by-the-test', 1_024);

    try {
      const open = await h2Request(
        session,
        { ':method': 'POST', ':path': `/s/${sessionId}/open` },
        { body: 'abc' },
      );
      const declared = await h2Request(
        session,
        { ':method': 'POST', ':path': `/s/${sessionId}/declared`, 'content-length': '3' },
        { body: 'abc' },
      );
      const none = await h2Request(session, { ':method': 'POST', ':path': `/s/${sessionId}/none` });

      // 1 MiB and more does not fit beside the held weight: refused after its wait.
      assert.equal(open.status, 503);
      assert.equal(JSON.parse(open.body.toString()).errorCode, 1018);
      assert.equal('connection' in open.headers, false);
      assert.equal(declared.status, 200);
      assert.equal(none.status, 200);
      assert.deepEqual(
        (await storedRequests(sessionId)).map((row) => row.path),
        [`/s/${sessionId}/declared`, `/s/${sessionId}/none`],
      );
    } finally {
      held.release();
    }

    await eventually(async () => budget.used === 0, 'every weight given back');
  });

  it('refuses a webhook that finds the waiting line full 503 / 1018 at once, with no Connection field and no warning of one, and the connection goes on (D228)', async () => {
    const budget = createCaptureBudget({
      waitMs: 20_000,
      waitingBytes: 1,
      waitingPerAddressBytes: 1,
      lightSenderBytes: 0,
      lightReserveBytes: 0,
    });
    const target = await ownTarget({ http2: 'on', captureBudget: budget });
    const sessionId = await newSession();
    const session = client(target);
    // Every byte of the budget held by the test, so that a webhook must wait.
    const held = budget.take('held-by-the-test', inFlightBound(budget.settings));
    // The first of its address waits, whatever the line holds; the next one
    // finds the line full.
    const waiting = h2Request(
      session,
      { ':method': 'POST', ':path': `/s/${sessionId}/waiting`, 'content-length': '1' },
      { body: 'w' },
    );

    try {
      await eventually(async () => budget.waiting === 1, 'the first webhook waiting');

      const start = Date.now();
      const refused = await h2Request(
        session,
        { ':method': 'POST', ':path': `/s/${sessionId}/refused`, 'content-length': '1' },
        { body: 'r' },
      );

      assert.ok(Date.now() - start < 10_000, 'refused at once, not after its wait');
      assert.equal(refused.status, 503);
      assert.equal(JSON.parse(refused.body.toString()).errorCode, 1018);
      assert.equal(refused.headers['retry-after'], String(CAPTURES_BUSY_RETRY_AFTER_SECONDS));
      // Over HTTP/1.1 the refusal ends its connection (D228); over HTTP/2 no
      // answer carries the field, which Node would drop with a warning.
      assert.equal('connection' in refused.headers, false);
      assert.equal(budget.waiting, 1, 'the first webhook still waiting');
    } finally {
      held.release();
    }

    assert.equal((await waiting).status, 200);

    const later = await h2Request(
      session,
      { ':method': 'POST', ':path': `/s/${sessionId}/later`, 'content-length': '1' },
      { body: 'l' },
    );

    assert.equal(later.status, 200);
    assert.deepEqual(
      (await storedRequests(sessionId)).map((row) => row.path),
      [`/s/${sessionId}/waiting`, `/s/${sessionId}/later`],
    );
    assert.deepEqual(
      droppedConnectionFieldWarnings().map((warning) => warning.message),
      [],
      'Node warned of no Connection field it dropped, in this test or before it',
    );
  });

  it("holds a waiting webhook's stream window alone: the connection's window comes back as its DATA arrives, and the connection's next stream is read whole", async () => {
    const budget = createCaptureBudget({
      totalBytes: 600 * 1024,
      perAddressBytes: 600 * 1024,
      waitMs: 1_000,
      lightSenderBytes: 0,
      lightReserveBytes: 0,
    });
    const target = await ownTarget({ http2: 'on', captureBudget: budget });
    const waiting = await newSession();
    const next = await newSession();
    // HTTP/2's initial window, the stream's and the connection's alike.
    const window = 65_535;
    // The budget held by the test until it has seen what it asserts, so that
    // it is not empty and the open body waits.
    const held = budget.take('held-by-the-test', 1_024);
    const socket = await raw(target);
    const chunks: Buffer[] = [];
    const received = (): ReceivedFrame[] => receivedFrames(Buffer.concat(chunks));
    const data = (streamId: number, bytes: number, end: boolean): Buffer[] => {
      const frames: Buffer[] = [];

      for (let sent = 0; sent < bytes; sent += 16_384) {
        const size = Math.min(16_384, bytes - sent);

        frames.push(
          frame(
            FRAME_DATA,
            end && sent + size === bytes ? FLAG_END_STREAM : 0,
            streamId,
            Buffer.alloc(size, 0x61),
          ),
        );
      }

      return frames;
    };
    const request = (streamId: number, sessionId: string, length?: number): Buffer =>
      frame(
        FRAME_HEADERS,
        FLAG_END_HEADERS,
        streamId,
        literalHeaderBlock([
          [':method', 'POST'],
          [':scheme', 'http'],
          [':path', `/s/${sessionId}`],
          [':authority', 'h'],
          ...(length === undefined
            ? []
            : ([['content-length', String(length)]] as [string, string][])),
        ]),
      );

    const returned = (streamId: number): number =>
      received()
        .filter((one) => one.type === FRAME_WINDOW_UPDATE && one.streamId === streamId)
        .reduce((sum, one) => sum + one.payload.readUInt32BE(0), 0);

    try {
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      // No content-length: an open body, 1 MiB, which does not fit beside the
      // held weight and waits; its whole window sent meanwhile.
      socket.write(
        Buffer.concat([
          HTTP2_PREFACE,
          frame(FRAME_SETTINGS, 0, 0, Buffer.alloc(0)),
          request(1, waiting),
          ...data(1, window, false),
        ]),
      );

      await eventually(async () => returned(0) >= window / 2, "the connection's window given back");
      assert.equal(returned(1), 0, 'the waiting stream is not read');
      assert.equal(answeredOn(received(), 1), false, 'still waiting');

      // A whole window more on the connection, which only the window it gave
      // back allows: a sender past it would be a FLOW_CONTROL_ERROR, a GOAWAY.
      socket.write(Buffer.concat([request(3, next, window), ...data(3, window, true)]));

      await eventually(
        async () => answeredOn(received(), 1) && answeredOn(received(), 3),
        'both streams answered',
        5_000,
      );
      assert.equal(
        received().filter((one) => one.type === FRAME_GOAWAY).length,
        0,
        'no connection error',
      );
      assert.equal((await storedRequests(waiting)).length, 0, 'refused after its wait');
      await eventually(async () => (await storedRequests(next)).length === 1, 'the next stored');
      assert.equal((await storedRequest(next)).body.length, window);
    } finally {
      held.release();
      socket.destroy();
    }

    await eventually(async () => budget.used === 0, 'every weight given back');
  });

  it('answers 408 to a request still arriving when its time is up, nothing stored, and stores one that ends just before', async () => {
    // Shortened from 90 s, and long enough that the stream in time ends a
    // second and more before it.
    const timeoutMs = 1_500;
    const receiver = await listen({ http2: 'on', http2RequestTimeoutMs: timeoutMs });
    const target: Listening = {
      app: receiver,
      port: portOf(receiver),
      header: undefined,
      sourceIp: PROXY_PEER,
    };
    const late = await newSession();
    const inTime = await newSession();
    const session = client(target);
    let stalled: ClientHttp2Stream | undefined;
    // Where each stream's time starts, or just before.
    const opened = Date.now();
    const overdue = h2Request(
      session,
      { ':method': 'POST', ':path': `/s/${late}`, 'content-length': '10' },
      { body: 'five!', keepOpen: true, opened: (stream) => (stalled = stream) },
    );
    let finishing: ClientHttp2Stream | undefined;
    const answered = h2Request(
      session,
      { ':method': 'POST', ':path': `/s/${inTime}` },
      { body: 'part', keepOpen: true, opened: (stream) => (finishing = stream) },
    );

    await delay(250);
    finishing?.end('-end');

    const timedOut = await overdue;
    const elapsed = Date.now() - opened;

    assert.equal(timedOut.status, 408);
    // At its time, not later: within 850 ms past it, measured from where it
    // starts.
    assert.ok(elapsed < timeoutMs + 850, `answered ${elapsed} ms after the streams opened`);
    assert.equal((await answered).status, 200);
    assert.equal((await storedRequest(inTime)).body.toString(), 'part-end');
    assert.equal((await storedRequests(late)).length, 0);
    assert.ok(stalled !== undefined);
  });

  it('closes a connection idle past its time, shortened: a GOAWAY, then its end, its client doing nothing', async () => {
    const target = await ownTarget({ http2: 'on', http2SessionIdleTimeoutMs: 300 });
    const socket = await raw(target);
    const chunks: Buffer[] = [];
    const received = (): ReceivedFrame[] => receivedFrames(Buffer.concat(chunks));
    let ended = false;

    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    // The server's FIN, which only the server's close sends.
    socket.once('end', () => {
      ended = true;
    });
    socket.write(
      Buffer.concat([
        HTTP2_PREFACE,
        frame(FRAME_SETTINGS, 0, 0, Buffer.alloc(0)),
        frame(
          FRAME_HEADERS,
          FLAG_END_HEADERS | FLAG_END_STREAM,
          1,
          literalHeaderBlock([
            [':method', 'GET'],
            [':scheme', 'http'],
            [':path', '/robots.txt'],
            [':authority', 'h'],
          ]),
        ),
      ]),
    );

    await eventually(async () => answeredOn(received(), 1), 'the request answered');
    // Then nothing more from the client.
    await eventually(async () => ended, 'the connection ended by the server', 5_000);

    const goaways = received().filter((one) => one.type === FRAME_GOAWAY);

    assert.ok(goaways.length >= 1, 'a GOAWAY before the end');
    assert.equal(goaways[0]?.payload.readUInt32BE(0), 1, 'naming the last stream taken');
    assert.equal(goaways[0]?.payload.readUInt32BE(4), constants.NGHTTP2_NO_ERROR);
  });

  for (const framing of ['without', 'with'] as const) {
    it(`answers 408 to a body sent in pieces ${framing} content-length and still open when its time is up, stores nothing and logs no error`, async () => {
      const { target, lines } = await listenLogged({ http2: 'on', http2RequestTimeoutMs: 400 });
      const sessionId = await newSession();
      let stalled: ClientHttp2Stream | undefined;
      const answer = h2Request(
        client(target),
        {
          ':method': 'POST',
          ':path': `/s/${sessionId}`,
          ...(framing === 'with' ? { 'content-length': '100' } : {}),
        },
        { body: 'part', keepOpen: true, opened: (stream) => (stalled = stream) },
      );

      await delay(150);
      stalled?.write('-more');

      const timedOut = await answer;

      assert.equal(timedOut.status, 408);
      // Whatever the handler or the error handler would do, it has done.
      await delay(300);
      assert.equal((await storedRequests(sessionId)).length, 0);
      assert.deepEqual(
        lines().filter((line) => line.level >= ERROR_LEVEL),
        [],
        'no line at error',
      );
    });
  }
});

/** The fields an answer's record holds as the client received them: no `:status`, no `date` (D109). */
function receivedFields(answer: H2Answer): [string, string][] {
  return pairsOf(answer.rawHeaders).filter(([name]) => name !== ':status' && name !== 'date');
}

describe('answers over HTTP/2 (criterion 6)', () => {
  /** Every configuration below is one the validator accepts: its session is created. */
  const configurations: [string, Partial<ResponseConfig>, [string, string][]][] = [
    [
      'repeats, a digit-only name, the fields HTTP/2 refuses and spaces at a value’s ends',
      {
        status: 202,
        headers: [
          ['Content-Type', 'text/plain'],
          ['x-dup', '1'],
          ['123', 'digits'],
          ['x-dup', '2'],
          ['content-type', 'text/html'],
          ['Proxy-Connection', 'keep-alive'],
          ['HTTP2-Settings', 'AAMAAABkAARAAAAAAAIAAAAA'],
          ['x-pad', ' both ends\t'],
          ['x-empty', ''],
        ],
        body: 'hello',
      },
      [
        ['content-type', 'text/plain'],
        ['x-dup', '1'],
        ['123', 'digits'],
        ['x-dup', '2'],
        ['x-pad', 'both ends'],
        ['x-empty', ''],
      ],
    ],
    [
      'a redirect with two Location fields (D247)',
      {
        status: 307,
        headers: [
          ['Location', '/s/first'],
          ['location', '/s/second'],
        ],
      },
      [['location', '/s/first']],
    ],
    [
      'repeats of etag, retry-after, last-modified and content-language',
      {
        status: 503,
        headers: [
          ['etag', '"a"'],
          ['retry-after', '1'],
          ['etag', '"b"'],
          ['retry-after', '2'],
          ['last-modified', 'Sat, 24 Oct 2026 10:00:00 GMT'],
          ['last-modified', 'Sun, 25 Oct 2026 10:00:00 GMT'],
          ['content-language', 'en'],
          ['content-language', 'ru'],
          ['vary', 'a'],
          ['vary', 'b'],
        ],
        body: '{"busy":true}',
      },
      [
        ['etag', '"a"'],
        ['retry-after', '1'],
        ['last-modified', 'Sat, 24 Oct 2026 10:00:00 GMT'],
        ['content-language', 'en'],
        ['vary', 'a'],
        ['vary', 'b'],
      ],
    ],
    ['204 with a field', { status: 204, headers: [['x-trace', 't']] }, [['x-trace', 't']]],
    ['205', { status: 205 }, []],
    ['304 with an etag', { status: 304, headers: [['etag', '"v1"']] }, [['etag', '"v1"']]],
    ['599 with a body and no Content-Type', { status: 599, body: 'odd' }, []],
    [
      'a template',
      {
        status: 200,
        headers: [['content-type', 'text/plain']],
        body: '{{request.method}} {{request.path}}',
        template: true,
      },
      [['content-type', 'text/plain']],
    ],
  ];

  for (const [what, response, configured] of configurations) {
    it(`sends ${what}, records what was sent, never failed`, async () => {
      const sessionId = await newSession({ status: 200, ...response });
      const answer = await h2Request(
        client(plain),
        { ':method': 'POST', ':path': `/s/${sessionId}/t` },
        { body: 'x' },
      );
      const stored = await storedRequest(sessionId);
      const record = await settledResponse(stored.id);

      assert.equal(record.state, 'sent');
      assert.equal(answer.status, response.status);
      assert.equal(record.status, response.status);
      // What the record holds is what came: the configured fields by the
      // rule, then the receiver's own, in order.
      assert.deepEqual(record.headers, receivedFields(answer));
      assert.deepEqual(record.headers.slice(0, configured.length), configured);
      assert.equal(
        record.headers.some(([name]) => HTTP2_CONNECTION_FIELDS.has(name)),
        false,
      );
      assert.ok((record.body ?? Buffer.alloc(0)).equals(answer.body));

      if (response.template === true) {
        assert.equal(answer.body.toString(), `POST /s/${sessionId}/t`);
      }

      // The head as stored: `:status` first, then the fields, a blank line, the body.
      const head = [`:status: ${response.status}`, ...record.headers.map(([n, v]) => `${n}: ${v}`)];

      assert.equal(
        record.raw_response?.toString('latin1'),
        `${head.join('\r\n')}\r\n\r\n${answer.body.toString('latin1')}`,
      );
    });
  }

  it('drops the repeats of every field Node sends once, and nothing else, so that Node sends every head the rule leaves', async () => {
    const names = new Set<string>([...HTTP2_SINGLE_VALUE_FIELDS, ...HTTP2_CONNECTION_FIELDS]);

    for (const [key, value] of Object.entries(constants)) {
      if (key.startsWith('HTTP2_HEADER_') && typeof value === 'string' && !value.startsWith(':')) {
        names.add(value);
      }
    }

    const server = http2.createServer();
    const refusals: string[] = [];

    // Each head answers a `HEAD`, so that a `content-length` needs no body.
    server.on('stream', (stream, headers) => {
      const name = String(headers['x-name']);

      try {
        // Digits, which every field Node checks the value of takes.
        stream.respond([
          ':status',
          '200',
          ...http2AnswerHeaders([
            [name, '1'],
            ['x-between', 'b'],
            [name, '2'],
          ]).flat(),
        ]);
      } catch (error) {
        refusals.push(`${name}: ${(error as { code?: string }).code}`);
        stream.close(constants.NGHTTP2_INTERNAL_ERROR);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const session = connectH2((server.address() as AddressInfo).port);

      clients.push(session);

      for (const name of names) {
        const answer = await h2Request(session, {
          ':method': 'HEAD',
          ':path': '/',
          'x-name': name,
        });
        // Node adds a `date` of its own when the head has none.
        const head = pairsOf(answer.rawHeaders).filter(
          ([field]) => field !== ':status' && (name === 'date' || field !== 'date'),
        );

        assert.equal(answer.status, 200, `${name}: ${refusals.join(', ')}`);

        if (HTTP2_CONNECTION_FIELDS.has(name)) {
          assert.deepEqual(head, [['x-between', 'b']], name);
        } else if (HTTP2_SINGLE_VALUE_FIELDS.has(name)) {
          assert.deepEqual(
            head,
            [
              [name, '1'],
              ['x-between', 'b'],
            ],
            name,
          );
        } else {
          assert.deepEqual(
            head,
            [
              [name, '1'],
              ['x-between', 'b'],
              [name, '2'],
            ],
            name,
          );
        }
      }

      assert.deepEqual(refusals, []);
      await closeH2(session);
    } finally {
      server.close();
    }
  });

  it('answers HEAD over HTTP/2 with the head alone, recorded sent with bodySuppressed', async () => {
    const sessionId = await newSession({
      status: 200,
      headers: [['x-trace', 'h']],
      body: 'twelve bytes',
    });
    const answer = await h2Request(client(plain), {
      ':method': 'HEAD',
      ':path': `/s/${sessionId}`,
    });
    const stored = await storedRequest(sessionId);
    const record = await settledResponse(stored.id);

    assert.equal(answer.status, 200);
    assert.equal(answer.headers['content-length'], '12');
    assert.equal(answer.body.length, 0);
    assert.equal(record.state, 'sent');
    assert.equal(record.body_suppressed, true);
    assert.equal(record.body?.toString(), 'twelve bytes');
    assert.ok(record.raw_response?.toString('latin1').endsWith('content-length: 12\r\n\r\n'));
    assert.deepEqual(record.headers, receivedFields(answer));
  });

  it('matches a response rule by :method and :path, and records the rule that answered (D246)', async () => {
    const sessionId = await newSession();

    await setRules(sessionId, [
      {
        method: 'PUT',
        path: '/orders/*',
        response: { status: 201, headers: [], body: 'rule', delayMs: 0, template: false },
      },
    ]);

    const session = client(proxied);
    const matched = await h2Request(
      session,
      { ':method': 'PUT', ':path': `/s/${sessionId}/orders/7?x=1` },
      { body: '{}' },
    );
    const other = await h2Request(session, {
      ':method': 'GET',
      ':path': `/s/${sessionId}/orders/7`,
    });

    assert.equal(matched.status, 201);
    assert.equal(matched.body.toString(), 'rule');
    assert.equal(other.status, 200);

    const [first, second] = await storedRequests(sessionId);

    // Counted from 1, as the API gives it (D246).
    assert.equal((await settledResponse(first?.id ?? '')).rule_index, 1);
    assert.equal((await settledResponse(second?.id ?? '')).rule_index, null);
  });

  it('stores sourceIp null for a session created with storeSourceIp: false, and captures into a keyed session (D243, D245)', async () => {
    const { id: keepsNone } = await createSession({ storeSourceIp: false });
    const { id: keyed, key } = await createSession({ private: true });

    assert.ok(key !== undefined, 'the key is answered once');

    const session = client(proxied);

    assert.equal(
      (await h2Request(session, { ':method': 'POST', ':path': `/s/${keepsNone}` }, { body: 'a' }))
        .status,
      200,
    );
    assert.equal(
      (await h2Request(session, { ':method': 'POST', ':path': `/s/${keyed}` }, { body: 'b' }))
        .status,
      200,
    );

    const none = await storedRequest(keepsNone);
    const withKey = await storedRequest(keyed);

    assert.equal(none.source_ip, null);
    assert.equal(none.http_version, '2.0');
    assert.equal(withKey.source_ip, SENDER);
    assert.equal(withKey.body.toString(), 'b');
  });
});

describe('cancellation over HTTP/2 (criterion 7)', () => {
  it('records aborted when the sender resets a stream during the delay, cancels the wait, and answers the other streams of the connection', async () => {
    const delayed = await newSession({ status: 200, delayMs: 2_000 });
    const plainSession = await newSession();
    const session = client(proxied);
    let held: ClientHttp2Stream | undefined;
    const reset = h2Request(
      session,
      { ':method': 'POST', ':path': `/s/${delayed}` },
      { body: 'wait', opened: (stream) => (held = stream) },
    );

    await eventually(async () => (await storedRequests(delayed)).length === 1, 'stored');

    const start = Date.now();

    held?.close(constants.NGHTTP2_CANCEL);

    const other = await h2Request(
      session,
      { ':method': 'POST', ':path': `/s/${plainSession}` },
      { body: 'go' },
    );
    const record = await settledResponse((await storedRequest(delayed)).id);

    assert.equal(other.status, 200);
    assert.equal(record.state, 'aborted');
    assert.ok(
      Date.now() - start < 1_500,
      `settled after ${Date.now() - start} ms, before the delay`,
    );
    assert.equal((await reset).status, undefined);
  });

  for (const [how, end] of [
    [
      'a GOAWAY with an error',
      (session: http2.ClientHttp2Session) => session.goaway(constants.NGHTTP2_CANCEL),
    ],
    ['a closed connection', (session: http2.ClientHttp2Session) => session.destroy()],
  ] as const) {
    it(`records aborted for every open stream of a connection that ends with ${how}`, async () => {
      const delayed = await newSession({ status: 200, delayMs: 2_000 });
      const session = client(plain);
      const pending = [1, 2, 3].map((index) =>
        h2Request(
          session,
          { ':method': 'POST', ':path': `/s/${delayed}/${index}` },
          { body: String(index) },
        ),
      );

      await eventually(
        async () => (await storedRequests(delayed)).length === 3,
        'all three stored',
      );
      end(session);

      const start = Date.now();

      for (const row of await storedRequests(delayed)) {
        assert.equal((await settledResponse(row.id)).state, 'aborted');
      }

      assert.ok(Date.now() - start < 1_500);
      await Promise.all(pending);
    });
  }

  // RFC 9113 §6.8: a GOAWAY with NO_ERROR is its sender's graceful
  // shutdown, which cancels nothing - the GOAWAY that cancels is one with an
  // error code (D263 point 9).
  it("answers every open stream of a connection left open whose client sends a GOAWAY with NO_ERROR, Node's client", async () => {
    const delayed = await newSession({ status: 200, delayMs: 600 });
    const session = client(plain);
    const pending = [1, 2, 3].map((index) =>
      h2Request(
        session,
        { ':method': 'POST', ':path': `/s/${delayed}/${index}` },
        { body: String(index) },
      ),
    );

    await eventually(async () => (await storedRequests(delayed)).length === 3, 'all three stored');
    session.goaway(constants.NGHTTP2_NO_ERROR);

    assert.deepEqual(
      (await Promise.all(pending)).map((answer) => answer.status),
      [200, 200, 200],
    );

    for (const row of await storedRequests(delayed)) {
      assert.equal((await settledResponse(row.id)).state, 'sent');
    }
  });

  // A client's GOAWAY names the last stream of the server's it may act on,
  // an even id or 0; an odd one names a stream of its own, which nghttp2
  // takes for a connection error (`PROTOCOL_ERROR`): Node destroys the
  // session, resets every open stream `INTERNAL_ERROR` and sends its own
  // GOAWAY with that code, with no code of the receiver's involved.
  //
  // The records settle as the answers are handed to the session, at their
  // streams' `finish`, and the session writes the frames to the socket later
  // in that turn: a read of the frames the moment the last record has
  // settled can come before them (#287, F-22). So the frames are waited
  // for, as every other raw read of this file waits.
  //
  // The `aborted` case's GOAWAY must land while every stream still waits:
  // a stream whose delay has run out is answered and recorded `sent`. The
  // three captures commit one after another under their session's lock, and
  // load once stretched the time from the first one to the GOAWAY past
  // 600 ms (F-22); 3 s costs the case nothing, its GOAWAY ending the session
  // at once, and stays within `settledResponse`'s 5 s.
  for (const [lastStreamId, outcome, delayMs] of [
    [0, 'sent', 600],
    [2, 'sent', 600],
    [5, 'aborted', 3_000],
  ] as const) {
    it(`records ${outcome} for every open stream of a connection left open after a raw GOAWAY with NO_ERROR and last-stream-id ${lastStreamId}`, async () => {
      const delayed = await newSession({ status: 200, delayMs });
      const socket = await raw(plain);
      const chunks: Buffer[] = [];
      let closed = false;
      const request = (streamId: number): Buffer =>
        Buffer.concat([
          frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS,
            streamId,
            literalHeaderBlock([
              [':method', 'POST'],
              [':scheme', 'http'],
              [':path', `/s/${delayed}/${streamId}`],
              [':authority', 'h'],
            ]),
          ),
          frame(FRAME_DATA, FLAG_END_STREAM, streamId, Buffer.from('x')),
        ]);
      const goaway = Buffer.alloc(8);

      goaway.writeUInt32BE(lastStreamId, 0);
      goaway.writeUInt32BE(constants.NGHTTP2_NO_ERROR, 4);
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('close', () => (closed = true));
      socket.write(
        Buffer.concat([
          HTTP2_PREFACE,
          frame(FRAME_SETTINGS, 0, 0, Buffer.alloc(0)),
          request(1),
          request(3),
          request(5),
        ]),
      );
      await eventually(
        async () => (await storedRequests(delayed)).length === 3,
        'all three stored',
      );
      socket.write(frame(FRAME_GOAWAY, 0, 0, goaway));

      const rows = await storedRequests(delayed);

      for (const row of rows) {
        assert.equal((await settledResponse(row.id)).state, outcome, row.path);
      }

      // For `sent`, the answer of every stream, its HEADERS and its
      // END_STREAM; for `aborted`, the GOAWAY with an error code.
      await arrives(
        () => {
          const sofar = receivedFrames(Buffer.concat(chunks));

          if (outcome === 'aborted') {
            return sofar.some(
              (one) =>
                one.type === FRAME_GOAWAY &&
                one.payload.readUInt32BE(4) !== constants.NGHTTP2_NO_ERROR,
            )
              ? []
              : ['streams 1, 3 and 5 recorded aborted, no GOAWAY with an error code received'];
          }

          return [1, 3, 5].flatMap((streamId) => {
            if (!answeredOn(sofar, streamId)) {
              return [`stream ${streamId} recorded sent, its answer not received`];
            }

            return answerEndedOn(sofar, streamId)
              ? []
              : [`stream ${streamId} recorded sent, its answer's END_STREAM not received`];
          });
        },
        () => closed,
      );

      const received = receivedFrames(Buffer.concat(chunks));
      const answered = [1, 3, 5].filter((streamId) => answeredOn(received, streamId));
      const goaways = received.filter((one) => one.type === FRAME_GOAWAY);

      if (outcome === 'sent') {
        assert.deepEqual(answered, [1, 3, 5]);
      } else {
        assert.deepEqual(answered, []);
        assert.ok(
          goaways.some((one) => one.payload.readUInt32BE(4) !== constants.NGHTTP2_NO_ERROR),
          'a GOAWAY with an error code',
        );
      }

      socket.destroy();
    });
  }

  for (const framing of ['with', 'without'] as const) {
    it(`stores nothing of a stream the sender resets before END_STREAM, ${framing} content-length`, async () => {
      // Raw frames: Node's client ends a stream it closes with END_STREAM
      // before its RST_STREAM, which is a body sent whole.
      const sessionId = await newSession();
      const socket = await raw(plain);
      const received: Buffer[] = [];
      const fields: [string, string][] = [
        [':method', 'POST'],
        [':scheme', 'http'],
        [':path', `/s/${sessionId}`],
        [':authority', 'h'],
        ...(framing === 'with' ? ([['content-length', '100']] as [string, string][]) : []),
      ];
      const code = Buffer.alloc(4);

      code.writeUInt32BE(constants.NGHTTP2_CANCEL);
      socket.on('data', (chunk: Buffer) => received.push(chunk));
      socket.write(
        Buffer.concat([
          HTTP2_PREFACE,
          frame(FRAME_SETTINGS, 0, 0, Buffer.alloc(0)),
          frame(FRAME_HEADERS, FLAG_END_HEADERS, 1, literalHeaderBlock(fields)),
          frame(FRAME_DATA, 0, 1, Buffer.from('part of it')),
        ]),
      );
      await delay(100);
      socket.write(frame(FRAME_RST_STREAM, 0, 1, code));
      await delay(300);
      assert.equal((await storedRequests(sessionId)).length, 0);

      // The connection goes on.
      socket.write(
        frame(
          FRAME_HEADERS,
          FLAG_END_HEADERS | FLAG_END_STREAM,
          3,
          literalHeaderBlock([
            [':method', 'GET'],
            [':scheme', 'http'],
            [':path', '/robots.txt'],
            [':authority', 'h'],
          ]),
        ),
      );
      await eventually(
        async () => frameTypes(Buffer.concat(received)).includes(FRAME_HEADERS),
        'the next stream answered',
      );
      socket.destroy();
    });
  }

  /** A `RST_STREAM` frame for `streamId` with the error code `code`. */
  function resetFrame(streamId: number, code: number): Buffer {
    const payload = Buffer.alloc(4);

    payload.writeUInt32BE(code);

    return frame(FRAME_RST_STREAM, 0, streamId, payload);
  }

  /** A `POST` to `path` as one `HEADERS` frame on `streamId`, with `END_STREAM` when `endStream`. */
  function postHeaders(
    streamId: number,
    path: string,
    contentLength: string | undefined,
    endStream = false,
  ): Buffer {
    return frame(
      FRAME_HEADERS,
      FLAG_END_HEADERS | (endStream ? FLAG_END_STREAM : 0),
      streamId,
      literalHeaderBlock([
        [':method', 'POST'],
        [':scheme', 'http'],
        [':path', path],
        [':authority', 'h'],
        ...(contentLength === undefined
          ? []
          : ([['content-length', contentLength]] as [string, string][])),
      ]),
    );
  }

  const BODY = Buffer.from('abcde');
  const RESET_CODES = [
    ['CANCEL', constants.NGHTTP2_CANCEL],
    ['NO_ERROR', constants.NGHTTP2_NO_ERROR],
  ] as const;

  /**
   * A `POST` of `abcde` on stream 1 of a raw connection of its own, to a new
   * session: its `HEADERS`, then - once Node has emitted its stream and
   * Fastify reads its body - each of `writes`, 100 ms apart, or, when
   * `firstFlight`, the preface, the `HEADERS` and the first of `writes` in
   * one write; then a `POST` on stream 3 to the same session, which its line
   * stores after the first (D205), so that the session's rows are read once
   * stream 3's is there. `beforeLast` is awaited before the last write.
   */
  async function postThen(
    contentLength: string | undefined,
    writes: Buffer[],
    options: {
      firstFlight?: boolean;
      beforeLast?: (received: () => ReceivedFrame[]) => Promise<void>;
    } = {},
  ): Promise<{ sessionId: string; rows: StoredRequest[]; received: ReceivedFrame[] }> {
    const sessionId = await newSession();
    const socket = await raw(plain);
    const chunks: Buffer[] = [];
    const received = (): ReceivedFrame[] => receivedFrames(Buffer.concat(chunks));
    const opening = Buffer.concat([HTTP2_PREFACE, frame(FRAME_SETTINGS, 0, 0, Buffer.alloc(0))]);
    const headers = postHeaders(1, `/s/${sessionId}/first`, contentLength);
    const rest = [...writes];

    socket.on('data', (chunk: Buffer) => chunks.push(chunk));

    if (options.firstFlight === true) {
      socket.write(Buffer.concat([opening, headers, rest.shift() ?? Buffer.alloc(0)]));
    } else {
      socket.write(Buffer.concat([opening, headers]));
    }

    while (rest.length > 0) {
      await delay(100);

      if (rest.length === 1) {
        await options.beforeLast?.(received);
      }

      socket.write(rest.shift() as Buffer);
    }

    socket.write(
      Buffer.concat([
        postHeaders(3, `/s/${sessionId}/after`, '1'),
        frame(FRAME_DATA, FLAG_END_STREAM, 3, Buffer.from('z')),
      ]),
    );
    await eventually(
      async () => (await storedRequests(sessionId)).some((row) => row.path.endsWith('/after')),
      'the next stream stored',
    );

    const rows = await storedRequests(sessionId);

    socket.destroy();

    return { sessionId, rows, received: received() };
  }

  for (const framing of ['with', 'without'] as const) {
    const contentLength = framing === 'with' ? String(BODY.length) : undefined;

    for (const [name, code] of RESET_CODES) {
      for (const together of [true, false]) {
        const when = together ? 'in the same write' : 'in a write of its own';

        it(`stores nothing of a stream whose whole body came without its END_STREAM, then RST_STREAM(${name}) ${when}, ${framing} content-length`, async () => {
          const data = frame(FRAME_DATA, 0, 1, BODY);
          const reset = resetFrame(1, code);
          const { rows } = await postThen(
            contentLength,
            together ? [Buffer.concat([data, reset])] : [data, reset],
          );

          assert.deepEqual(
            rows.map((row) => row.path.split('/').pop()),
            ['after'],
          );
        });

        it(`stores the body of a stream whose END_STREAM came before its RST_STREAM(${name}) ${when}, its answer recorded ${together ? 'aborted' : 'sent'}, ${framing} content-length`, async () => {
          const data = frame(FRAME_DATA, FLAG_END_STREAM, 1, BODY);
          const reset = resetFrame(1, code);
          const { rows } = await postThen(
            contentLength,
            together ? [Buffer.concat([data, reset])] : [data, reset],
            together
              ? {}
              : {
                  // Reset once the answer is out: a sender that cancels
                  // nothing of it.
                  beforeLast: async (received) =>
                    eventually(async () => answeredOn(received(), 1), 'the answer'),
                },
          );

          assert.deepEqual(
            rows.map((row) => row.path.split('/').pop()),
            ['first', 'after'],
          );

          const first = rows[0] as StoredRequest;

          assert.deepEqual(first.body, BODY);
          assert.equal((await settledResponse(first.id)).state, together ? 'aborted' : 'sent');
        });
      }
    }

    it(`stores nothing of a stream reset in the read that brings its HEADERS, END_STREAM and all, whose body Node discards: no empty body stored, ${framing} content-length`, async () => {
      const { rows } = await postThen(
        contentLength,
        [
          Buffer.concat([
            frame(FRAME_DATA, FLAG_END_STREAM, 1, BODY),
            resetFrame(1, constants.NGHTTP2_CANCEL),
          ]),
        ],
        { firstFlight: true },
      );

      assert.deepEqual(
        rows.map((row) => row.path.split('/').pop()),
        ['after'],
      );
    });

    it(`stores the body of a stream Node's client ends and then resets, END_STREAM then RST_STREAM(CANCEL), ${framing} content-length`, async () => {
      const sessionId = await newSession();
      const session = client(plain);
      let stream: ClientHttp2Stream | undefined;
      const answer = h2Request(
        session,
        {
          ':method': 'POST',
          ':path': `/s/${sessionId}`,
          ...(contentLength === undefined ? {} : { 'content-length': contentLength }),
        },
        { body: BODY.toString(), keepOpen: true, opened: (opened) => (stream = opened) },
      );

      await delay(100);
      // Node's client sends END_STREAM, then RST_STREAM(CANCEL).
      stream?.close(constants.NGHTTP2_CANCEL);
      await answer;
      await eventually(async () => (await storedRequests(sessionId)).length === 1, 'stored');
      assert.deepEqual((await storedRequest(sessionId)).body, BODY);
    });
  }

  it('waits for the END_STREAM of a stream that declares Content-Length: 0 on HEADERS without it: stored once it comes, nothing stored of one reset first', async () => {
    const ended = await postThen('0', [frame(FRAME_DATA, FLAG_END_STREAM, 1, Buffer.alloc(0))]);

    assert.deepEqual(
      ended.rows.map((row) => row.path.split('/').pop()),
      ['first', 'after'],
    );
    assert.equal(ended.rows[0]?.body.length, 0);

    const reset = await postThen('0', [resetFrame(1, constants.NGHTTP2_CANCEL)]);

    assert.deepEqual(
      reset.rows.map((row) => row.path.split('/').pop()),
      ['after'],
    );
  });

  /** A client's SETTINGS with `SETTINGS_INITIAL_WINDOW_SIZE` (0x4) of `bytes`. */
  function initialWindow(bytes: number): Buffer {
    const payload = Buffer.alloc(6);

    payload.writeUInt16BE(0x4, 0);
    payload.writeUInt32BE(bytes, 2);

    return frame(FRAME_SETTINGS, 0, 0, payload);
  }

  // The record follows what the sender received - the answer's END_STREAM or
  // not - whatever Node calls the body's write back with: Node 24.22.1 calls
  // it back without an error for a body flow control still holds when the
  // stream is reset with NO_ERROR or CANCEL, Node 24.19.0 with `ECANCELED`
  // (D263 point 8).
  for (const [name, code] of RESET_CODES) {
    for (const [window, outcome] of [
      [0, 'aborted'],
      [4, 'aborted'],
      [5, 'sent'],
    ] as const) {
      it(`records ${outcome} for an answer of 5 bytes whose sender, allowing ${window} of them, resets its stream with ${name} once the head is in`, async () => {
        const sessionId = await newSession({ status: 200, headers: [], body: 'hello' });
        const socket = await raw(plain);
        const chunks: Buffer[] = [];
        const received = (): ReceivedFrame[] => receivedFrames(Buffer.concat(chunks));

        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        // The body is read to its END_STREAM, as Fastify reads one: Node then
        // closes the stream at once on a reset, its answer held or not.
        socket.write(
          Buffer.concat([
            HTTP2_PREFACE,
            initialWindow(window),
            postHeaders(1, `/s/${sessionId}`, '1'),
            frame(FRAME_DATA, FLAG_END_STREAM, 1, Buffer.from('x')),
          ]),
        );
        await eventually(async () => answeredOn(received(), 1), 'the head of the answer');
        socket.write(resetFrame(1, code));

        const record = await settledResponse((await storedRequest(sessionId)).id);
        const data = received().filter((one) => one.streamId === 1 && one.type === FRAME_DATA);
        const sent = data.reduce((bytes, one) => bytes + one.payload.length, 0);
        const ended = data.some((one) => (one.flags & FLAG_END_STREAM) !== 0);

        assert.equal(record.state, outcome);
        assert.equal(sent, window);
        assert.equal(ended, outcome === 'sent', 'the answer’s END_STREAM received');
        socket.destroy();
      });
    }
  }
});

describe('the drain over HTTP/2 (criterion 8)', () => {
  it('sends a GOAWAY to every open session on SIGUSR2, and still answers the stream in flight', async () => {
    const drain = new Drain();
    const receiver = await listen({ http2: 'on', drain });
    const target: Listening = {
      app: receiver,
      port: portOf(receiver),
      header: undefined,
      sourceIp: PROXY_PEER,
    };
    const delayed = await newSession({ status: 200, delayMs: 600 });
    const session = client(target);
    const goaway = new Promise<number>((resolve) =>
      session.once('goaway', (code: number) => resolve(code)),
    );
    const inFlight = h2Request(
      session,
      { ':method': 'POST', ':path': `/s/${delayed}` },
      { body: 'a' },
    );

    await eventually(async () => (await storedRequests(delayed)).length === 1, 'stored');
    drain.start();

    assert.equal(await goaway, constants.NGHTTP2_NO_ERROR);
    assert.equal((await inFlight).status, 200);
    assert.equal((await settledResponse((await storedRequest(delayed)).id)).state, 'sent');

    // A connection opened during the drain is served its first stream, then sent its GOAWAY.
    const later = client(target);
    const laterGoaway = new Promise<number>((resolve) =>
      later.once('goaway', (code: number) => resolve(code)),
    );

    assert.equal((await h2Request(later, { ':path': '/robots.txt' })).status, 200);
    assert.equal(await laterGoaway, constants.NGHTTP2_NO_ERROR);
  });

  it('closes every session on SIGTERM once its streams are answered, and leaves none open', async () => {
    const drain = new Drain();
    const receiver = buildReceiver(pool, { http2: 'on', drain });
    const part = receiverHttp2(receiver);

    receiver.log.level = 'silent';
    assert.ok(part !== undefined);
    part.app.log.level = 'silent';
    await receiver.listen({ host: '127.0.0.1', port: 0 });

    const target: Listening = {
      app: receiver,
      port: portOf(receiver),
      header: undefined,
      sourceIp: PROXY_PEER,
    };
    const delayed = await newSession({ status: 200, delayMs: 600 });
    const session = client(target);
    const idle = client(target);
    const sessionClosed = new Promise<void>((resolve) => session.once('close', () => resolve()));

    assert.equal((await h2Request(idle, { ':path': '/robots.txt' })).status, 200);

    // A raw connection that sends the preface and its SETTINGS, then nothing,
    // and ignores every GOAWAY: Node's client closes its own session on the
    // drain's GOAWAY, this one only the listener's close closes.
    const ignoring = await raw(target);
    const ignoringChunks: Buffer[] = [];
    let ignoringEnded = false;

    ignoring.on('data', (chunk: Buffer) => ignoringChunks.push(chunk));
    ignoring.once('end', () => {
      ignoringEnded = true;
    });
    ignoring.write(Buffer.concat([HTTP2_PREFACE, frame(FRAME_SETTINGS, 0, 0, Buffer.alloc(0))]));
    // Its session is open once the server's SETTINGS come.
    await eventually(
      async () =>
        receivedFrames(Buffer.concat(ignoringChunks)).some((one) => one.type === FRAME_SETTINGS),
      "the server's SETTINGS",
    );

    const inFlight = h2Request(
      session,
      { ':method': 'POST', ':path': `/s/${delayed}` },
      { body: 'a' },
    );

    await eventually(async () => (await storedRequests(delayed)).length === 1, 'stored');
    assert.equal(part.sessions.size, 3);

    // As `shutdown` does: the drain, then the listener's close, which waits
    // for no client to act on its GOAWAY.
    drain.start();
    await within(receiver.close(), 5_000, "the listener's close");

    assert.equal((await inFlight).status, 200);
    assert.equal(part.sessions.size, 0);
    await sessionClosed;
    assert.equal((await settledResponse((await storedRequest(delayed)).id)).state, 'sent');
    await eventually(async () => ignoringEnded, 'the ignoring connection ended by the server');
    assert.ok(
      receivedFrames(Buffer.concat(ignoringChunks)).some((one) => one.type === FRAME_GOAWAY),
      'a GOAWAY sent to the ignoring connection',
    );
  });
});
