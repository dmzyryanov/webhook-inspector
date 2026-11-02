/**
 * Response templates over real sockets and the database (D251, issue #135):
 * a body without the opt-in sent and recorded byte for byte, a template's
 * placeholders filled in from the request it answers - as the session
 * response, a queue's step and a rule's response - what is recorded equal to
 * what was sent, missing values, the cap, the escaping, the refusals at save,
 * the headers every answer carries, the flag in every answer and event, and
 * the previous image's statements replayed on the migrated schema.
 *
 * `response-template.test.ts` holds the grammar and the substitution as pure
 * functions.
 *
 * Start the database and apply migrations first:
 *   npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  MAX_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  type RequestDetails,
  type ResponseConfig,
  type SessionDetails,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { templateProblem } from '@webhook-inspector/shared/response-template';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { closeSockets, watch } from '../../testing/realtime.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import { withinBound } from '../../testing/timing.ts';

const JSON_TYPE = { 'content-type': 'application/json' };

let pool: pg.Pool;
let servers: TestServers;
let app: FastifyInstance;
let receiver: FastifyInstance;
let port: number;
let apiPort: number;
const createdSessionIds: string[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    servers = buildTestServers(pool, { rateLimits: LIMITS_OUT_OF_REACH });
    ({ api: app, receiver } = servers);
    app.log.level = 'silent';
    receiver.log.level = 'silent';
    await receiver.listen({ host: '127.0.0.1', port: 0 });
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (receiver.server.address() as net.AddressInfo).port;
    apiPort = (app.server.address() as net.AddressInfo).port;
  })();
  await startup;
});

after(async () => {
  await startup;
  closeSockets();

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers.close();
  await pool.end();
});

type InjectedResponse = Awaited<ReturnType<typeof app.inject>>;

/** A response at its effective values (D101). */
function response(status: number, rest: Partial<ResponseConfig> = {}): ResponseConfig {
  return { status, headers: [], body: null, delayMs: 0, template: false, ...rest };
}

function post(url: string, body: unknown): Promise<InjectedResponse> {
  return app.inject({ method: 'POST', url, headers: JSON_TYPE, payload: JSON.stringify(body) });
}

function put(url: string, body: unknown): Promise<InjectedResponse> {
  return app.inject({ method: 'PUT', url, headers: JSON_TYPE, payload: JSON.stringify(body) });
}

async function create(body: object): Promise<string> {
  const created = await post('/api/sessions', body);

  assert.equal(created.statusCode, 201, created.body);

  const { id } = created.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

async function read(sessionId: string): Promise<SessionDetails> {
  const answer = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });

  assert.equal(answer.statusCode, 200, answer.body);

  return answer.json<SessionDetails>();
}

async function detail(sessionId: string, requestId: string): Promise<RequestDetails> {
  const answer = await app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/requests/${requestId}`,
  });

  assert.equal(answer.statusCode, 200, answer.body);

  return answer.json<RequestDetails>();
}

function assertError(answer: InjectedResponse, statusCode: number, errorCode: number): string {
  assert.equal(answer.statusCode, statusCode, answer.body);

  const { errorCode: code, message } = answer.json<{ errorCode: number; message: string }>();

  assert.equal(code, errorCode, answer.body);

  return message;
}

/** One answer as it came off the socket, its body as bytes. */
interface WireAnswer {
  status: number;
  headers: Map<string, string>;
  body: Buffer;
}

/** A request to send: everything after the target is optional. */
interface Outgoing {
  method?: string;
  /** What follows `/s/<id>`: a path and a query string. */
  target?: string;
  headers?: [string, string][];
  body?: Buffer | string | null;
}

/** Sends one request over a socket of its own and reads its answer whole. */
function send(sessionId: string, outgoing: Outgoing = {}): Promise<WireAnswer> {
  const method = outgoing.method ?? 'POST';
  const body =
    outgoing.body === null || outgoing.body === undefined
      ? null
      : Buffer.isBuffer(outgoing.body)
        ? outgoing.body
        : Buffer.from(outgoing.body, 'utf8');
  const lines = [
    `${method} /s/${sessionId}${outgoing.target ?? ''} HTTP/1.1`,
    'Host: hook.test',
    'Connection: close',
    ...(outgoing.headers ?? []).map(([name, value]) => `${name}: ${value}`),
    ...(body === null ? [] : [`Content-Length: ${body.byteLength}`]),
  ];
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');

  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () =>
      socket.write(body === null ? head : Buffer.concat([head, body])),
    );
    const chunks: Buffer[] = [];

    socket.setTimeout(30_000, () => {
      socket.destroy();
      reject(new Error('no complete answer in time'));
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks);
      const end = raw.indexOf('\r\n\r\n');

      assert.ok(end !== -1, 'an answer without a head');

      const [statusLine = '', ...headLines] = raw.subarray(0, end).toString('latin1').split('\r\n');
      const headers = new Map<string, string>();

      for (const line of headLines) {
        const colon = line.indexOf(':');

        headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
      }

      resolve({
        status: Number(statusLine.split(' ')[1]),
        headers,
        body: raw.subarray(end + 4),
      });
    });
  });
}

/** The id the answer names in `X-QA-Tools-Request-Id`. */
function requestIdOf(answer: WireAnswer): string {
  const id = answer.headers.get('x-qa-tools-request-id');

  assert.ok(id, 'the answer names no request');

  return id;
}

/** The recorded response's body and raw bytes, whichever way the detail carries them (D043). */
function recordedBytes(record: NonNullable<RequestDetails['response']>): {
  body: Buffer | null;
  raw: Buffer | null;
} {
  return {
    body:
      record.body === null && record.bodyBase64 === null
        ? null
        : record.isBinary
          ? Buffer.from(record.bodyBase64 ?? '', 'base64')
          : Buffer.from(record.body ?? '', 'utf8'),
    raw:
      record.raw === null && record.rawBase64 === null
        ? null
        : record.isRawBinary
          ? Buffer.from(record.rawBase64 ?? '', 'base64')
          : Buffer.from(record.raw ?? '', 'utf8'),
  };
}

/** Waits until the request's response record leaves `pending`, and answers it. */
async function settled(
  sessionId: string,
  requestId: string,
): Promise<NonNullable<RequestDetails['response']>> {
  for (let tries = 0; tries < 500; tries += 1) {
    const record = (await detail(sessionId, requestId)).response;

    if (record !== null && record.state !== 'pending') {
      return record;
    }

    await delay(10);
  }

  assert.fail('the response stayed pending');
}

/**
 * Holds what was sent against what was recorded (criterion 3): the record's
 * body and size are the bytes on the socket, its raw is its head and those
 * bytes, `Content-Length` their count - and for a `HEAD` the count of the
 * body as this request filled it in, which was produced and not sent.
 */
async function assertRecordedAsSent(
  sessionId: string,
  answer: WireAnswer,
  head = false,
): Promise<Buffer | null> {
  const record = await settled(sessionId, requestIdOf(answer));
  const { body, raw } = recordedBytes(record);

  assert.equal(record.state, 'sent');
  assert.equal(record.bodySuppressed, head && body !== null);

  if (head) {
    assert.equal(answer.body.byteLength, 0);
  } else {
    assert.deepEqual(body ?? Buffer.alloc(0), answer.body);
  }

  assert.equal(record.bodySize, body?.byteLength ?? 0);
  assert.equal(
    answer.headers.get('content-length'),
    body === null ? undefined : String(body.byteLength),
  );
  assert.ok(raw !== null);

  const rawBody = raw.subarray(raw.indexOf('\r\n\r\n') + 4);

  assert.deepEqual(rawBody, head ? Buffer.alloc(0) : answer.body);

  return body;
}

/** Where a response answers from: the session response, a queue's step or a rule. */
type Place = 'response' | 'queue' | 'rule';
const PLACES: Place[] = ['response', 'queue', 'rule'];

/** A creation body whose next request is answered by `answer` from `place`. */
function answeringFrom(place: Place, answer: object): object {
  switch (place) {
    case 'response':
      return { response: answer };
    case 'queue':
      return { queue: { steps: [answer] } };
    case 'rule':
      return { rules: [{ method: null, path: '/*', response: answer }] };
  }
}

/** A body every reader of `{{` could take for a template, sent without the opt-in. */
const LOOKS_LIKE_A_TEMPLATE =
  '{"id":"{{request.id}}","x":"${x}","open":"{{","close":"}}","b":"{{request.body.a}}","bad":"{{ nope }}"}';

/**
 * A body that reads as a template, every placeholder of it filled in from the
 * request were the flag on, sent without it: only the opt-in's gate keeps it
 * as configured, which `LOOKS_LIKE_A_TEMPLATE` - refused as a template - does
 * not show.
 */
const READS_AS_A_TEMPLATE =
  '{"id":"{{request.id}}","method":"{{request.method}}","path":"{{request.path}}",' +
  '"a":"{{request.query.a}}","trace":"{{request.header.X-Trace}}","b":"{{request.body.a}}"}';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

describe('a body without the opt-in is sent as configured (criterion 1)', () => {
  it('holds a body that reads as a template, and one that does not', () => {
    assert.equal(templateProblem(READS_AS_A_TEMPLATE), null);
    assert.notEqual(templateProblem(LOOKS_LIKE_A_TEMPLATE), null);
  });

  for (const place of PLACES) {
    for (const flag of [{}, { template: false }]) {
      it(`sends and records it byte for byte as the ${place}${'template' in flag ? ', template false' : ''}, on every method`, async () => {
        for (const configured of [LOOKS_LIKE_A_TEMPLATE, READS_AS_A_TEMPLATE]) {
          for (const method of METHODS) {
            const id = await create(
              answeringFrom(place, { status: 200, body: configured, ...flag }),
            );
            const answer = await send(id, {
              method,
              target: '/orders?a=1',
              headers: [['X-Trace', 'abc']],
              body: method === 'GET' || method === 'HEAD' ? null : '{"a":"from the body"}',
            });
            const label = `${place} ${method} ${configured}`;

            assert.equal(answer.status, 200, label);

            const recorded = await assertRecordedAsSent(id, answer, method === 'HEAD');

            assert.equal(recorded?.toString('utf8'), configured, label);

            if (method === 'HEAD') {
              assert.equal(
                answer.headers.get('content-length'),
                String(Buffer.byteLength(configured)),
                label,
              );
            } else {
              assert.equal(answer.body.toString('utf8'), configured, label);
            }
          }
        }
      });
    }
  }
});

/** A JSON template naming every placeholder of the set. */
const EVERY_PLACEHOLDER =
  '{"id":"{{request.id}}","method":"{{request.method}}","path":"{{request.path}}",' +
  '"q":"{{request.query.q}}","trace":"{{request.header.X-Trace}}",' +
  '"order":"{{request.body.order.id}}","n":{{request.body.order.n}},"first":"{{request.body.items.0.sku}}"}';

/** What `EVERY_PLACEHOLDER` gives for the request `sendEvery` sends to `/orders`. */
function everyValue(sessionId: string, requestId: string, method = 'POST'): object {
  return {
    id: requestId,
    method,
    path: `/s/${sessionId}/orders`,
    q: 'hello world',
    trace: 'trace-1',
    order: 'ord_42',
    n: 7,
    first: 'A',
  };
}

function sendEvery(sessionId: string, method = 'POST'): Promise<WireAnswer> {
  return send(sessionId, {
    method,
    target: '/orders?q=hello+world&q=second',
    headers: [
      ['x-trace', 'trace-1'],
      ['X-Trace', 'trace-2'],
      ['Content-Type', 'application/json'],
    ],
    body: JSON.stringify({ order: { id: 'ord_42', n: 7 }, items: [{ sku: 'A' }, { sku: 'B' }] }),
  });
}

describe('a template takes the values of the request it answers (criterion 2)', () => {
  for (const place of PLACES) {
    it(`fills in every placeholder of the set as the ${place}`, async () => {
      const id = await create(
        answeringFrom(place, { status: 201, body: EVERY_PLACEHOLDER, template: true }),
      );
      const answer = await sendEvery(id);

      assert.equal(answer.status, 201);
      assert.deepEqual(
        JSON.parse(answer.body.toString('utf8')),
        everyValue(id, requestIdOf(answer)),
      );
      await assertRecordedAsSent(id, answer);
    });
  }

  it('fills in every step of a queue with its own template, in order', async () => {
    const id = await create({
      queue: {
        steps: [
          { status: 201, body: '{"step":1,"id":"{{request.id}}"}', template: true },
          { status: 202, body: '{"step":2,"q":"{{request.query.q}}"}', template: true },
          { status: 203, body: '{"step":3,"raw":"{{request.query.q}}"}' },
        ],
      },
    });
    const first = await send(id, { target: '?q=one' });
    const second = await send(id, { target: '?q=two' });
    const third = await send(id, { target: '?q=three' });

    assert.deepEqual(JSON.parse(first.body.toString()), { step: 1, id: requestIdOf(first) });
    assert.deepEqual(JSON.parse(second.body.toString()), { step: 2, q: 'two' });
    assert.equal(third.body.toString(), '{"step":3,"raw":"{{request.query.q}}"}');
  });

  it('fills in every rule’s response with its own template', async () => {
    const id = await create({
      rules: [
        {
          method: 'POST',
          path: '/orders',
          response: { status: 201, body: '{"created":"{{request.body.id}}"}', template: true },
        },
        {
          method: 'GET',
          path: '/orders/*',
          response: { status: 200, body: '{"path":"{{request.path}}"}', template: true },
        },
      ],
    });
    const created = await send(id, { target: '/orders', body: '{"id":"o-1"}' });
    const read = await send(id, { method: 'GET', target: '/orders/o-1' });

    assert.deepEqual(JSON.parse(created.body.toString()), { created: 'o-1' });
    assert.deepEqual(JSON.parse(read.body.toString()), { path: `/s/${id}/orders/o-1` });
  });

  it('gives each of 50 concurrent captures its own values', async () => {
    const id = await create({
      response: {
        status: 200,
        body: '{"id":"{{request.id}}","q":"{{request.query.n}}","h":"{{request.header.x-n}}","b":"{{request.body.n}}"}',
        template: true,
      },
    });
    const answers = await Promise.all(
      Array.from({ length: 50 }, (_unused, index) =>
        send(id, {
          target: `?n=${index}`,
          headers: [['X-N', `h${index}`]],
          body: JSON.stringify({ n: `b${index}` }),
        }),
      ),
    );
    const ids = new Set<string>();

    answers.forEach((answer, index) => {
      const requestId = requestIdOf(answer);

      ids.add(requestId);
      assert.deepEqual(JSON.parse(answer.body.toString()), {
        id: requestId,
        q: String(index),
        h: `h${index}`,
        b: `b${index}`,
      });
    });
    assert.equal(ids.size, 50);

    for (const answer of answers.slice(0, 5)) {
      await assertRecordedAsSent(id, answer);
    }
  });
});

describe('what is recorded is what was sent (criterion 3)', () => {
  it('records the filled-in body, its size and raw, and HEAD announces its length', async () => {
    const id = await create({
      response: {
        status: 200,
        headers: [['Content-Type', 'text/plain; charset=utf-8']],
        body: 'ünïcödé {{request.method}} {{request.query.v}} {{request.id}}',
        template: true,
      },
    });

    for (const method of ['GET', 'POST', 'HEAD']) {
      const answer = await send(id, { method, target: '?v=%E2%82%AC%F0%9F%98%80' });
      const body = await assertRecordedAsSent(id, answer, method === 'HEAD');
      const expected = `ünïcödé ${method} €😀 ${requestIdOf(answer)}`;

      assert.equal(body?.toString('utf8'), expected);
      assert.equal(answer.headers.get('content-length'), String(Buffer.byteLength(expected)));
      assert.notEqual(Buffer.byteLength(expected), expected.length);
    }
  });

  // The outside review's case: a template in the default answer's shape - this
  // request's id where the default answer names it, then a last "sourceIp"
  // member filled in from the query string - answering a session that keeps
  // no address. Migration 015's trigger holds the record of the previous
  // image's default answer to the row (D243); a template's record is what was
  // sent, whatever it holds (D251, migration 019).
  it('records as sent a template in the default answer’s shape, for a session that keeps no address', async () => {
    const shaped = {
      status: 200,
      body: '{"ok":true,"requestId":"{{request.id}}","method":"{{request.method}}","sourceIp":"{{request.query.ip}}"}',
      template: true,
    };

    for (const place of PLACES) {
      for (const method of ['GET', 'HEAD']) {
        const id = await create({ ...answeringFrom(place, shaped), storeSourceIp: false });
        const answer = await send(id, { method, target: '?ip=203.0.113.7' });
        const requestId = requestIdOf(answer);
        const expected = Buffer.from(
          `{"ok":true,"requestId":"${requestId}","method":"${method}","sourceIp":"203.0.113.7"}`,
        );
        const body = await assertRecordedAsSent(id, answer, method === 'HEAD');
        const record = await settled(id, requestId);
        const { raw } = recordedBytes(record);
        const length = String(expected.byteLength);

        assert.deepEqual(body, expected, `${place} ${method}`);
        assert.equal(answer.headers.get('content-length'), length, `${place} ${method}`);
        assert.deepEqual(record.headers.at(-1), ['content-length', length], `${place} ${method}`);
        assert.ok(raw?.includes(`\r\ncontent-length: ${length}\r\n\r\n`), `${place} ${method}`);
        assert.equal(record.queueStep === null, place !== 'queue');
        assert.equal(record.rule === null, place !== 'rule');
        assert.equal((await detail(id, requestId)).sourceIp, null);
      }
    }
  });

  it('answers 204, 205 and 304 with no body and no Content-Length, template or not (attack f)', async () => {
    for (const status of [204, 205, 304]) {
      const id = await create({ response: { status, template: true } });

      for (const method of ['GET', 'HEAD']) {
        const answer = await send(id, { method });

        assert.equal(answer.status, status);
        assert.equal(answer.headers.get('content-length'), undefined);

        const record = await settled(id, requestIdOf(answer));

        assert.equal(record.body, null);
        assert.equal(record.bodySize, 0);
      }
    }
  });
});

describe('a missing value renders empty, and the capture stands (criterion 4)', () => {
  const TEMPLATE =
    '[{{request.header.x-absent}}][{{request.query.absent}}][{{request.body.missing}}]' +
    '[{{request.body.n}}][{{request.body.o}}][{{request.body.l}}][{{request.body.l.9}}]';

  it('gives an absent header or parameter, a path not found, null, an object and an array nothing', async () => {
    const id = await create({ response: { status: 201, body: TEMPLATE, template: true } });
    const answer = await send(id, { body: '{"n":null,"o":{"a":1},"l":[1,2]}' });

    assert.equal(answer.status, 201);
    assert.equal(answer.body.toString(), '[][][][][][][]');
    await assertRecordedAsSent(id, answer);
  });

  it('reads no value from a body that is not JSON, not UTF-8, or nested 100,000 deep', async () => {
    const id = await create({
      response: { status: 202, body: '[{{request.body.a}}][{{request.id}}]', template: true },
    });

    for (const body of [
      Buffer.from('a=1&b=2'),
      Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
      Buffer.from(`${'['.repeat(100_000)}${']'.repeat(100_000)}`),
      Buffer.from(`${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}`),
      Buffer.from('{"a":'),
      Buffer.alloc(0),
    ]) {
      const answer = await send(id, { body });

      assert.equal(answer.status, 202);
      assert.equal(answer.body.toString(), `[][${requestIdOf(answer)}]`);
      await assertRecordedAsSent(id, answer);
    }
  });

  it('reads no body a GET, a HEAD or a TRACE sends, which Fastify never reads: its placeholder renders empty', async () => {
    const id = await create({
      response: {
        status: 200,
        body: '{"a":"{{request.body.a}}","method":"{{request.method}}"}',
        template: true,
      },
    });

    // A POST, whose body is read, beside them shows the body would fill it in.
    for (const method of ['GET', 'HEAD', 'TRACE', 'POST']) {
      const answer = await send(id, {
        method,
        headers: [['Content-Type', 'application/json']],
        body: '{"a":"from the body"}',
      });

      assert.equal(answer.status, 200, method);

      const recorded = await assertRecordedAsSent(id, answer, method === 'HEAD');

      assert.deepEqual(
        JSON.parse(recorded?.toString('utf8') ?? 'null'),
        { a: method === 'POST' ? 'from the body' : '', method },
        method,
      );
    }
  });

  it('takes the first of duplicate headers and parameters, and decodes +, %zz and %E9 as URLSearchParams does (attack e)', async () => {
    const id = await create({
      response: {
        status: 200,
        headers: [['Content-Type', 'text/plain']],
        body: '{{request.header.x-dup}}|{{request.query.a}}|{{request.query.b}}|{{request.query.c}}|{{request.header.x-utf8}}',
        template: true,
      },
    });
    const answer = await send(id, {
      target: '?a=x+y&a=second&b=%zz&c=%E9',
      headers: [
        ['X-Dup', 'one'],
        ['x-dup', 'two'],
      ],
    });
    // A header sent as UTF-8 bytes reads as UTF-8.
    const utf8 = await send(id, {
      headers: [['X-UTF8', Buffer.from('é', 'utf8').toString('latin1')]],
    });

    assert.equal(answer.body.toString('utf8'), 'one|x y|%zz|\ufffd|');
    assert.equal(utf8.body.toString('utf8'), '||||é');
  });
});

describe(`the sent body is at most ${MAX_RESPONSE_BODY_BYTES} bytes (criterion 5)`, () => {
  it('renders empty a 1 MiB value, in bounded time, however often it is named', async () => {
    const id = await create({
      response: { status: 200, body: '{{request.body.a}}'.repeat(3640), template: true },
    });
    const body = JSON.stringify({ a: 'v'.repeat(MAX_BODY_BYTES - 16) });

    assert.ok(Buffer.byteLength(body) <= MAX_BODY_BYTES);

    const started = performance.now();
    const answer = await send(id, { body });

    assert.ok(performance.now() - started < 5_000);
    assert.equal(answer.body.byteLength, 0);
    await assertRecordedAsSent(id, answer);
  });

  it('writes a value as often as it fits, and not once past the cap', async () => {
    const id = await create({
      response: { status: 200, body: '{{request.query.s}}'.repeat(3449), template: true },
    });

    // A query value, which a HEAD carries as a POST does: a body sent with a
    // HEAD or a GET is never read, and no placeholder of it has a value.
    for (const method of ['POST', 'HEAD']) {
      const answer = await send(id, { method, target: '?s=abcdefghijklmnopqrst' });
      const body = await assertRecordedAsSent(id, answer, method === 'HEAD');

      // Twenty bytes fit 3,276 times in 65,536.
      assert.equal(body?.byteLength, 3276 * 20);
      assert.equal(answer.headers.get('content-length'), String(3276 * 20));
    }
  });
});

describe('the escaping by the answer’s effective Content-Type (criterion 6)', () => {
  /** A header value, a query value and a body value, each built to break its context. */
  function hostile(id: string): Promise<WireAnswer> {
    return send(id, {
      target: `?q=${encodeURIComponent('"\\\n\u2028</q>')}`,
      headers: [['X-V', `"\\' <b>&`]],
      body: '{"v":"\\"\\\\\\u0000\\u001f\\u2028\\u2029\\ud800<script>&\'"}',
    });
  }

  for (const contentType of [null, 'application/json', 'application/problem+json; charset=utf-8']) {
    it(`keeps a JSON string valid ${contentType === null ? 'with no Content-Type' : `as ${contentType}`}`, async () => {
      const id = await create({
        response: {
          status: 200,
          headers: contentType === null ? [] : [['Content-Type', contentType]],
          body: '{"q":"{{request.query.q}}","h":"{{request.header.x-v}}","b":"{{request.body.v}}"}',
          template: true,
        },
      });
      const answer = await hostile(id);

      assert.deepEqual(JSON.parse(answer.body.toString('utf8')), {
        q: '"\\\n\u2028</q>',
        h: `"\\' <b>&`,
        b: '"\\\u0000\u001f\u2028\u2029\ud800<script>&\'',
      });
      await assertRecordedAsSent(id, answer);
    });
  }

  for (const contentType of ['text/html; charset=utf-8', 'application/xml', 'image/svg+xml']) {
    it(`writes & < > " and ' as entities as ${contentType}`, async () => {
      const id = await create({
        response: {
          status: 200,
          headers: [['Content-Type', contentType]],
          body: '<p title="{{request.header.x-v}}">{{request.query.q}}</p>',
          template: true,
        },
      });
      const answer = await hostile(id);

      assert.equal(
        answer.body.toString('utf8'),
        '<p title="&quot;\\&#39; &lt;b&gt;&amp;">&quot;\\\n\u2028&lt;/q&gt;</p>',
      );
    });
  }

  it('writes the value raw for any other type', async () => {
    const id = await create({
      response: {
        status: 200,
        headers: [['Content-Type', 'text/plain']],
        body: '{{request.header.x-v}}|{{request.body.v}}',
        template: true,
      },
    });
    const answer = await hostile(id);

    assert.deepEqual(
      answer.body,
      Buffer.from(`"\\' <b>&|"\\\u0000\u001f\u2028\u2029\ufffd<script>&'`, 'utf8'),
    );
    // U+0000 reaches the record as a byte like any other (BYTEA).
    await assertRecordedAsSent(id, answer);
  });

  // The sender's path after the session's id, stored as received (D173): every
  // character markup writes as an entity and the two JSON escapes, all of
  // which Node's parser takes in a request target.
  const HOSTILE_PATH = `/a"b\\<c>&'d`;
  const PATH_ANSWERS: [string | null, string, (sessionId: string) => string][] = [
    [
      null,
      '{"path":"{{request.path}}"}',
      (sessionId) => `{"path":"/s/${sessionId}/a\\"b\\\\<c>&'d"}`,
    ],
    [
      'text/html; charset=utf-8',
      '<p>{{request.path}}</p>',
      (sessionId) => `<p>/s/${sessionId}/a&quot;b\\&lt;c&gt;&amp;&#39;d</p>`,
    ],
    ['text/plain', '{{request.path}}', (sessionId) => `/s/${sessionId}/a"b\\<c>&'d`],
  ];

  for (const [contentType, body, expected] of PATH_ANSWERS) {
    it(`escapes the path's " \\ < > & and ' ${contentType === null ? 'with no Content-Type' : `as ${contentType}`}`, async () => {
      const id = await create({
        response: {
          status: 200,
          headers: contentType === null ? [] : [['Content-Type', contentType]],
          body,
          template: true,
        },
      });
      const answer = await send(id, { target: HOSTILE_PATH });
      const path = `/s/${id}${HOSTILE_PATH}`;
      const text = answer.body.toString('utf8');

      assert.equal(answer.status, 200);
      assert.equal((await detail(id, requestIdOf(answer))).path, path);
      assert.equal(text, expected(id));

      if (contentType === null) {
        assert.deepEqual(JSON.parse(text), { path });
      }

      await assertRecordedAsSent(id, answer);
    });
  }
});

describe('a value the sender wrote is written as it is, never read again for placeholders (one pass)', () => {
  // Each value the sender writes names the id, itself and the other three, so
  // a renderer that substituted again, in whatever order, would expand one of
  // them. Node's parser takes `{` and `}` in a request target, so the path
  // carries it too; the query carries it percent-encoded.
  const INJECTED =
    '{{request.id}}{{request.path}}{{request.query.q}}{{request.header.x-t}}{{request.body.s}}';
  const NAMES_ALL =
    '{{request.id}}|{{request.path}}|{{request.query.q}}|{{request.header.x-t}}|{{request.body.s}}';

  /** The values in the order the templates name them. */
  interface Values {
    id: string;
    path: string;
    q: string;
    h: string;
    b: string;
  }

  const ONE_PASS: [string | null, string, (values: Values) => string][] = [
    [
      null,
      '{"id":"{{request.id}}","path":"{{request.path}}","q":"{{request.query.q}}","h":"{{request.header.x-t}}","b":"{{request.body.s}}"}',
      (values) => JSON.stringify(values),
    ],
    [
      'text/html; charset=utf-8',
      `<p>${NAMES_ALL}</p>`,
      (values) => `<p>${Object.values(values).join('|')}</p>`,
    ],
    ['text/plain', NAMES_ALL, (values) => Object.values(values).join('|')],
  ];

  for (const [contentType, body, expected] of ONE_PASS) {
    it(`sends the placeholder text in the path, the query, a header and the body verbatim ${contentType === null ? 'with no Content-Type' : `as ${contentType}`}`, async () => {
      const id = await create({
        response: {
          status: 200,
          headers: contentType === null ? [] : [['Content-Type', contentType]],
          body,
          template: true,
        },
      });
      const answer = await send(id, {
        target: `/${INJECTED}?q=${encodeURIComponent(INJECTED)}`,
        headers: [['X-T', INJECTED]],
        body: JSON.stringify({ s: INJECTED }),
      });
      const requestId = requestIdOf(answer);
      const path = `/s/${id}/${INJECTED}`;
      const values = { id: requestId, path, q: INJECTED, h: INJECTED, b: INJECTED };
      const text = answer.body.toString('utf8');

      assert.equal(answer.status, 200);
      assert.equal((await detail(id, requestId)).path, path);
      assert.equal(text, expected(values));

      if (contentType === null) {
        assert.deepEqual(JSON.parse(text), values);
      }

      // The id only where the template names it, never where a value does.
      assert.equal(text.split(requestId).length, 2);
      await assertRecordedAsSent(id, answer);
    });
  }
});

describe('a template is refused at save, quoting nothing (criterion 7)', () => {
  const SECRET = 'SECRET-135';
  const HOSTILE: [string, string][] = [
    [`{"a":"{{request.${SECRET}}}"}`, 'placeholder 1 must be one of'],
    [`{"a":"{{request.id}}","b":"{{${SECRET}`, 'placeholder 2 has no closing }}'],
    [`{{ request.header.${SECRET} }}`, 'placeholder 1 must be one of'],
    [`{{request.header.${SECRET}:x}}`, 'placeholder 1 must name a header that is an HTTP token'],
    [`{{request.body.${SECRET}..x}}`, 'placeholder 1 must name a path of the request body'],
    [`{{request.query.}}${SECRET}`, 'placeholder 1 must name a query parameter'],
  ];

  it('refuses each where a response is checked: creation, a change, a queue’s step and a rule', async () => {
    const id = await create({ response: { status: 200, body: 'kept' } });

    for (const [body, rule] of HOSTILE) {
      const answer = { status: 200, body, template: true };
      const places: [Promise<InjectedResponse>, string][] = [
        [post('/api/sessions', { response: answer }), 'response.body'],
        [post('/api/sessions', { queue: { steps: [answer] } }), 'queue.steps[0].body'],
        [
          post('/api/sessions', { rules: [{ method: null, path: '/', response: answer }] }),
          'rules[0].response.body',
        ],
        [
          put(`/api/sessions/${id}/response`, { mode: 'custom', response: answer }),
          'response.body',
        ],
        [put(`/api/sessions/${id}/queue`, { steps: [{ status: 200 }, answer] }), 'steps[1].body'],
        [
          put(`/api/sessions/${id}/rules`, {
            rules: [{ method: 'GET', path: '/x', response: answer }],
          }),
          'rules[0].response.body',
        ],
      ];

      for (const [refused, field] of places) {
        const message = assertError(await refused, 400, 1005);

        assert.ok(message.startsWith(`${field} ${rule}`), `${message} for ${body}`);
        assert.equal(message.includes(SECRET), false, message);
      }
    }

    const kept = await read(id);

    assert.deepEqual(kept.response, response(200, { body: 'kept' }));
    assert.equal(kept.queue, null);
    assert.deepEqual(kept.rules, []);
  });

  it('refuses a template that is no boolean, null and "true" included', async () => {
    for (const template of [null, 'true', 1, 0, [], {}]) {
      const message = assertError(
        await post('/api/sessions', { response: { status: 200, template } }),
        400,
        1005,
      );

      assert.equal(message, 'response.template must be true or false');
    }
  });

  it('takes, without the opt-in, every body it took before: braces of any kind, unclosed or not', async () => {
    for (const body of [
      '{{',
      '}}',
      '{{request.nope}}',
      '{{ x }}',
      '{{1+1}}',
      '${x}',
      '{'.repeat(65_536),
    ]) {
      for (const flag of [{}, { template: false }]) {
        await create({ response: { status: 200, body, ...flag } });
      }
    }
  });

  it('takes a template with no body, and one on 204', async () => {
    const id = await create({ response: { status: 204, template: true } });

    assert.deepEqual((await read(id)).response, response(204, { template: true }));
  });

  it('refuses made-up templates at growing sizes at once', async () => {
    for (const bytes of [1024, 16 * 1024, MAX_RESPONSE_BODY_BYTES]) {
      for (const body of [
        '{'.repeat(bytes),
        '{{'.repeat(bytes / 2),
        `{{${' '.repeat(bytes - 4)}}}`,
      ]) {
        const payload = JSON.stringify({ response: { status: 200, body, template: true } });
        const started = performance.now();
        const answer = await app.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: JSON_TYPE,
          payload,
        });

        assertError(answer, 400, 1005);
        assert.ok(performance.now() - started < 1_000, `${bytes}`);
      }
    }

    // The check alone, as `parseResponse` runs it, held to a bound at the largest size.
    const bytes = MAX_RESPONSE_BODY_BYTES;

    for (const [body, kind] of [
      ['{'.repeat(bytes), 'unclosed'],
      ['{{'.repeat(bytes / 2), 'unclosed'],
      [`{{${' '.repeat(bytes - 4)}}}`, 'unknown'],
    ] as const) {
      assert.deepEqual(
        withinBound(500, () => templateProblem(body)),
        { kind, index: 1 },
      );
    }
  });
});

describe('every templated answer is a sandboxed document (criterion 8)', () => {
  it('carries nosniff and the sandbox policy, as HTML and as JSON', async () => {
    for (const headers of [[], [['Content-Type', 'text/html']]]) {
      const id = await create({
        response: {
          status: 200,
          headers,
          body: '<script>{{request.query.q}}</script>',
          template: true,
        },
      });
      const answer = await send(id, { target: '?q=alert(1)' });

      assert.equal(answer.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(answer.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    }
  });
});

describe('every answer and event carries the flag (criterion 9)', () => {
  const TEMPLATE = response(201, { body: '{"id":"{{request.id}}"}', template: true });
  const PLAIN = response(202, { body: '{{request.id}}' });

  it('reads it on the response, the kept one, each step and each rule, false where absent', async () => {
    const id = await create({
      response: { status: 201, body: '{"id":"{{request.id}}"}', template: true },
      queue: { steps: [{ status: 202, body: '{{request.id}}' }, TEMPLATE] },
      rules: [
        { method: null, path: '/a', response: TEMPLATE },
        { method: null, path: '/b', response: { status: 202, body: '{{request.id}}' } },
      ],
    });
    const state = await read(id);

    assert.deepEqual(state.response, TEMPLATE);
    assert.deepEqual(state.customResponse, TEMPLATE);
    assert.deepEqual(state.queue?.steps, [PLAIN, TEMPLATE]);
    assert.deepEqual(
      state.rules.map((rule) => rule.response),
      [TEMPLATE, PLAIN],
    );

    const plain = await read(await create({ response: { status: 202, body: '{{request.id}}' } }));

    assert.equal(plain.response?.template, false);
  });

  it('carries it in the answers of the response, queue and rules calls, and in session.updated', async () => {
    const id = await create({ response: { status: 200 } });
    const viewer = await watch(apiPort, id);
    const calls: [string, unknown, (state: SessionResponseState) => unknown][] = [
      [
        'response',
        { mode: 'custom', response: TEMPLATE },
        (state) => [state.response, state.customResponse],
      ],
      ['queue', { steps: [TEMPLATE, PLAIN] }, (state) => state.queue?.steps],
      [
        'rules',
        { rules: [{ method: 'GET', path: '/', response: TEMPLATE }] },
        (state) => state.rules.map((rule) => rule.response),
      ],
    ];

    for (const [route, body, pick] of calls) {
      const answer = await put(`/api/sessions/${id}/${route}`, body);

      assert.equal(answer.statusCode, 200, answer.body);

      const state = answer.json<SessionResponseState>();
      const event = await viewer.next();

      assert.ok(event.type === 'session.updated');
      assert.deepEqual(event.data, state);
      assert.ok(JSON.stringify(pick(state)).includes('"template":true'), route);
    }

    // Default keeps it with the kept response; Custom without the key turns it off.
    const toDefault = await put(`/api/sessions/${id}/response`, { mode: 'default' });

    assert.deepEqual(toDefault.json<SessionResponseState>().customResponse, TEMPLATE);
    assert.deepEqual((await viewer.next()).type, 'session.updated');

    const resent = await put(`/api/sessions/${id}/response`, {
      mode: 'custom',
      response: { status: 201, body: '{"id":"{{request.id}}"}' },
    });

    assert.equal(resent.json<SessionResponseState>().response?.template, false);
    viewer.close();
  });
});

describe('a change during the delay leaves the composed answer alone (D105)', () => {
  it('answers with the template as it was when the request was captured', async () => {
    const id = await create({
      response: { status: 200, body: '{"first":"{{request.id}}"}', template: true, delayMs: 1_000 },
    });
    const pending = send(id);

    for (let tries = 0; tries < 200; tries += 1) {
      const listed = await app.inject({ method: 'GET', url: `/api/sessions/${id}/requests` });

      if (listed.json<unknown[]>().length > 0) {
        break;
      }

      await delay(10);
    }

    const changed = await put(`/api/sessions/${id}/response`, {
      mode: 'custom',
      response: { status: 201, body: '{"second":"{{request.method}}"}', template: true },
    });

    assert.equal(changed.statusCode, 200);

    const answer = await pending;

    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.body.toString()), { first: requestIdOf(answer) });
    await assertRecordedAsSent(id, answer);
  });
});

/**
 * The previous image on the new schema (migration 018): beside this one
 * during a rolling update (D221), alone after a `helm rollback` (D055). Its
 * statements, copied from `apps/backend/src/modules/sessions/repository.ts`
 * and `webhook/repository.ts` at 1.8.0 (`6292ccd`), name no column of 018 and
 * no `template` key: a session it creates reads as no template, a queue or
 * rules it saves are none, its capture reads a template's body as configured,
 * and its change of the session response leaves the column as it was.
 */
describe('the previous image on the new schema (criterion 11)', () => {
  const BASE_IMAGE_SESSION_INSERT = `INSERT INTO sessions
       (id, expires_at, lifetime_ends_at, idle_seconds, response_status, response_headers,
        response_body, response_delay_ms, response_queue, response_queue_answered,
        store_source_ip, response_rules)
     VALUES ($1,
             COALESCE(now() + make_interval(secs => $9), now() + make_interval(secs => $2::integer)),
             now() + make_interval(secs => $9),
             $2::integer,
             $3, $4::jsonb, $5, $6, $7::jsonb, $8, $10, $11::jsonb)
     RETURNING id, expires_at, store_source_ip, response_queue, response_queue_answered, response_rules`;
  const BASE_IMAGE_CAPTURE_LOCK = `SELECT id, response_status,
            COALESCE(response_headers, '[]'::jsonb) AS response_headers,
            response_body,
            COALESCE(response_delay_ms, 0) AS response_delay_ms,
            COALESCE(response_custom_disabled, false) AS response_custom_disabled,
              response_queue -> response_queue_answered AS queue_step,
              jsonb_array_length(response_queue) AS queue_total,
              response_queue_answered AS queue_answered,
              store_source_ip
       FROM sessions WHERE id = $1 FOR UPDATE`;
  const BASE_IMAGE_RESPONSE_CHANGE = `UPDATE sessions
                SET response_status = $2,
                    response_headers = $3::jsonb,
                    response_body = $4,
                    response_delay_ms = $5,
                    response_custom_disabled = false
              WHERE id = $1
              RETURNING response_status, response_body`;
  const BASE_IMAGE_QUEUE_SAVE = `UPDATE sessions
                SET response_queue = $2::jsonb,
                    response_queue_answered = 0
              WHERE id = $1`;

  /** A session id of 43 characters no other test makes. */
  function previousImageId(): string {
    const id = `P135${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
      .padEnd(43, 'p')
      .slice(0, 43);

    createdSessionIds.push(id);

    return id;
  }

  it('reads a session it creates, its steps and its rules as no template, and answers them as configured', async () => {
    const id = previousImageId();
    const stored = { status: 200, headers: [], body: '{{request.id}}', delayMs: 0 };

    await pool.query(BASE_IMAGE_SESSION_INSERT, [
      id,
      604_800,
      200,
      '[]',
      '{"id":"{{request.id}}"}',
      0,
      JSON.stringify([stored]),
      0,
      null,
      true,
      JSON.stringify([{ method: null, path: '/rule', response: stored }]),
    ]);

    const state = await read(id);

    assert.equal(state.response?.template, false);
    assert.equal(state.queue?.steps[0]?.template, false);
    assert.equal(state.rules[0]?.response.template, false);

    assert.equal((await send(id, { target: '/rule' })).body.toString(), '{{request.id}}');
    assert.equal((await send(id)).body.toString(), '{{request.id}}');
    assert.equal((await send(id)).body.toString(), '{"id":"{{request.id}}"}');
  });

  it('runs its capture’s locking statement on a template, reading the body as configured', async () => {
    const id = await create({
      response: { status: 200, body: '{"id":"{{request.id}}"}', template: true },
    });
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const locked = await client.query<{ response_body: string }>(BASE_IMAGE_CAPTURE_LOCK, [id]);

      assert.equal(locked.rows[0]?.response_body, '{"id":"{{request.id}}"}');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('leaves the column as it was when it changes the response, and saves a queue as none', async () => {
    const id = await create({
      response: { status: 200, body: '{"id":"{{request.id}}"}', template: true },
    });

    await pool.query(BASE_IMAGE_RESPONSE_CHANGE, [
      id,
      201,
      '[]',
      '{"again":"{{request.method}}"}',
      0,
    ]);
    // The flag stays the response's: the body it saved is a template once
    // this image serves again (migration 018).
    assert.deepEqual(
      (await read(id)).response,
      response(201, {
        body: '{"again":"{{request.method}}"}',
        template: true,
      }),
    );
    assert.equal((await send(id)).body.toString(), '{"again":"POST"}');

    await pool.query(BASE_IMAGE_QUEUE_SAVE, [
      id,
      JSON.stringify([{ status: 202, headers: [], body: '{{request.id}}', delayMs: 0 }]),
    ]);
    assert.equal((await read(id)).queue?.steps[0]?.template, false);
    assert.equal((await send(id)).body.toString(), '{{request.id}}');
  });

  it('sends as configured a body it saved that does not read as a template', async () => {
    const id = await create({
      response: { status: 200, body: '{"id":"{{request.id}}"}', template: true },
    });

    await pool.query(BASE_IMAGE_RESPONSE_CHANGE, [id, 200, '[]', '{"broken":"{{request.id"}', 0]);

    const answer = await send(id);

    assert.equal(answer.status, 200);
    assert.equal(answer.body.toString(), '{"broken":"{{request.id"}');
    await assertRecordedAsSent(id, answer);
  });
});
