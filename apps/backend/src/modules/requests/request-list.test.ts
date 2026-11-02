/**
 * Integration tests for what a list of requests may be asked for (D196): the
 * query parameters of `GET /api/sessions/:sessionId/requests` and
 * `POST /api/sessions/:sessionId/requests/query`, against the database.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  MAX_BODY_BYTES,
  MAX_CONCURRENT_HEADER_QUERIES,
  MAX_CONCURRENT_SEARCHES,
  MAX_REQUESTS_PER_SESSION,
  type ApiError,
  type RequestDetails,
  type RequestListEntry,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import type { Slots } from '../../lib/slots.ts';
import { buildReceiver, buildServer } from '../../server.ts';
import { whileExpired } from '../../testing/expired-session.ts';
import { until } from '../../testing/realtime.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import { fingerprintOf } from '../sessions/access-key.ts';
import { REQUEST_ID_HEADER } from '../webhook/response.ts';
import { jsonArrayStream } from './list-answer.ts';
import { parseListQueryString, parseQueryBody } from './list-query.ts';
import { createQuerySlots, createSearchSlots } from './search.ts';
import * as service from './service.ts';

let pool: pg.Pool;
let servers: TestServers;
/** The application listener, with the documented 2 s timeout. */
let app: FastifyInstance;
/** The receive listener, where captures are sent (D187). */
let receiver: FastifyInstance;
/** An application listener whose queries are cancelled after 1 ms. */
let impatient: FastifyInstance;
/** A pool of one connection, so what a query leaves on its connection can be read. */
let singlePool: pg.Pool;
/** An application listener on `singlePool`, cancelling queries after 1 ms. */
let impatientSingle: FastifyInstance;
/** An application listener whose statements pass through `hooks` first (`hookedPool`). */
let hooked: FastifyInstance;
/** A receive listener whose capture statements pass through `hooks` first (`hookedPool`). */
let hookedReceiver: FastifyInstance;
/**
 * The places of searches and queries on `app` and on `hooked` (D191, D250),
 * each listener's own, so that a test can hold them and look at them.
 */
const querySlots = createQuerySlots();
const hookedSlots = createQuerySlots();
/** Every log line the listeners wrote, as text. */
const logChunks: string[] = [];
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
  const { databaseUrl } = loadConfig();
  const logDestination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logChunks.push(chunk.toString('utf8'));
      callback();
    },
  });

  pool = createPool(databaseUrl);
  singlePool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  // Each listener lives for the whole file, which creates dozens of sessions
  // within a minute from one address (D201).
  const rateLimits = LIMITS_OUT_OF_REACH;

  servers = buildTestServers(pool, { logDestination, rateLimits, querySlots });
  ({ api: app, receiver } = servers);
  impatient = buildServer(pool, { logDestination, searchTimeoutMs: 1, rateLimits });
  impatientSingle = buildServer(singlePool, { logDestination, searchTimeoutMs: 1, rateLimits });
  hooked = buildServer(hookedPool(pool), { logDestination, rateLimits, querySlots: hookedSlots });
  hookedReceiver = buildReceiver(hookedPool(pool), { logDestination });
  await Promise.all([
    servers.ready(),
    impatient.ready(),
    impatientSingle.ready(),
    hooked.ready(),
    hookedReceiver.ready(),
  ]);
}

/**
 * What `hooked` runs before a statement of the test's session: before each
 * content read (`readListedContent`), with the ids it is about to read, and
 * before each list statement after the first, which is a resumed list. What
 * a hook does happens between the list statement and the content read, as a
 * deletion or a capture by another client would. `beforeList` runs before
 * every list statement, the first included, and can hold one in its place. Both routes pass through
 * them: the list's statements run on the pool, and the query's list
 * statements on a client the pool lends (`readWithTimeout`). On
 * `hookedReceiver`, a capture runs `beforeLock` once its transaction has begun
 * and before it asks for the session's lock (D065), as a capture held up
 * there by its process or its connection would be.
 */
const hooks: {
  sessionId: string | null;
  beforeContentRead: ((requestIds: string[]) => Promise<void>) | null;
  beforeList: (() => Promise<void>) | null;
  beforeResume: (() => Promise<void>) | null;
  beforeLock: (() => Promise<void>) | null;
  lists: number;
} = {
  sessionId: null,
  beforeContentRead: null,
  beforeList: null,
  beforeResume: null,
  beforeLock: null,
  lists: 0,
};

/** Runs the hook `hooks` sets for a statement, if any. */
async function runHooks(text: unknown, values: unknown[] | undefined): Promise<void> {
  if (typeof text !== 'string' || hooks.sessionId === null || values?.[0] !== hooks.sessionId) {
    return;
  }

  if (text.includes('AND id = ANY($2::uuid[])')) {
    await hooks.beforeContentRead?.(values[1] as string[]);
  } else if (text.includes('FOR UPDATE')) {
    await hooks.beforeLock?.();
  } else if (text.includes('LEFT JOIN LATERAL')) {
    hooks.lists += 1;
    await hooks.beforeList?.();

    if (hooks.lists > 1) {
      await hooks.beforeResume?.();
    }
  }
}

/** `target`, with `replaced` answered in place of the properties it names. */
function replacing<T extends object>(target: T, replaced: Record<string, unknown>): T {
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === 'string' && Object.hasOwn(replaced, property)) {
        return replaced[property];
      }

      const value: unknown = Reflect.get(object, property, object);

      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

/** `pool`, with `hooks` run before the statements they name, and on every client it lends. */
function hookedPool(target: pg.Pool): pg.Pool {
  return replacing(target, {
    query: async (text: unknown, values?: unknown[]) => {
      await runHooks(text, values);

      return target.query(text as string, values);
    },
    connect: async () => {
      const client = await target.connect();

      return replacing(client, {
        query: async (text: unknown, values?: unknown[]) => {
          await runHooks(text, values);

          return client.query(text as string, values);
        },
      });
    },
  });
}

/** Runs `run` with `hooks` set for `sessionId`, and clears them afterwards. */
async function withHooks<T>(
  sessionId: string,
  set: Pick<
    Partial<typeof hooks>,
    'beforeContentRead' | 'beforeList' | 'beforeResume' | 'beforeLock'
  >,
  run: () => Promise<T>,
): Promise<T> {
  Object.assign(hooks, {
    sessionId,
    beforeContentRead: set.beforeContentRead ?? null,
    beforeList: set.beforeList ?? null,
    beforeResume: set.beforeResume ?? null,
    beforeLock: set.beforeLock ?? null,
    lists: 0,
  });

  try {
    return await run();
  } finally {
    Object.assign(hooks, {
      sessionId: null,
      beforeContentRead: null,
      beforeList: null,
      beforeResume: null,
      beforeLock: null,
    });
  }
}

after(async () => {
  // A failed start is before()'s to report; close what it did open.
  await startup?.catch(() => undefined);

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await Promise.all([
    servers?.close(),
    impatient?.close(),
    impatientSingle?.close(),
    hooked?.close(),
    hookedReceiver?.close(),
  ]);
  await singlePool?.end();
  await pool.end();
});

async function newSession(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/sessions' });
  const { id } = response.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

interface Sent {
  method?: 'POST' | 'GET' | 'PUT';
  headers?: Record<string, string>;
  payload?: string | Buffer;
}

/** Captures one request through the receiver and answers with its id (D100). */
async function capture(sessionId: string, sent: Sent = {}): Promise<string> {
  const response = await receiver.inject({
    method: sent.method ?? 'POST',
    url: `/s/${sessionId}`,
    headers:
      sent.method === 'GET' ? sent.headers : { 'content-type': 'text/plain', ...sent.headers },
    payload: sent.payload,
  });

  assert.equal(response.statusCode, 200, response.body);

  return response.headers[REQUEST_ID_HEADER] as string;
}

interface Stored {
  headers?: [string, string][];
  body?: string | Buffer;
  /** A `timestamptz` literal; the moment of the insert when absent. */
  receivedAt?: string;
}

/**
 * Stores requests directly, so a test controls what a capture cannot: the
 * letter case and repetition of header names, and the receipt time.
 */
async function store(sessionId: string, rows: Stored[]): Promise<string[]> {
  const ids: string[] = [];

  for (const row of rows) {
    const body = Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body ?? '', 'utf8');
    const result = await pool.query<{ id: string }>(
      `INSERT INTO requests (session_id, method, headers, body, body_size, raw_request, received_at)
       VALUES ($1, 'POST', $2::jsonb, $3, $4, $3, COALESCE($5::timestamptz, clock_timestamp()))
       RETURNING id`,
      [sessionId, JSON.stringify(row.headers ?? []), body, body.length, row.receivedAt ?? null],
    );

    ids.push(result.rows[0]?.id as string);
  }

  return ids;
}

/**
 * Stores `count` requests whose receipt times share a millisecond in groups
 * of seven and, inside a group, some share the very microsecond while others
 * differ by one or two: ties for the id to break (D056), and differences
 * `receivedAt` cannot show. Answers the ids in receipt order.
 */
async function storeMany(sessionId: string, count: number, base: string): Promise<string[]> {
  await pool.query(
    `INSERT INTO requests (session_id, method, headers, body, body_size, raw_request, received_at)
     SELECT $1, 'POST', '[]'::jsonb, convert_to('n=' || g, 'UTF8'), length('n=' || g),
            convert_to('n=' || g, 'UTF8'),
            $2::timestamptz + (g / 7) * interval '1 millisecond'
              + ((g % 7) % 3) * interval '1 microsecond'
     FROM generate_series(1, $3::int) AS g`,
    [sessionId, base, count],
  );

  return receiptOrder(sessionId);
}

/** The session's request ids in receipt order, `(received_at, id)` ascending, as stored. */
async function receiptOrder(sessionId: string): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM requests WHERE session_id = $1 ORDER BY received_at, id',
    [sessionId],
  );

  return result.rows.map((row) => row.id);
}

function listOn(server: FastifyInstance, sessionId: string, query = '') {
  return server.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/requests${query === '' ? '' : `?${query}`}`,
  });
}

/** The list for `query`, which must answer 200. */
async function list(sessionId: string, query = ''): Promise<RequestListEntry[]> {
  const response = await listOn(app, sessionId, query);

  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers['content-type']), /^application\/json/);

  return response.json<RequestListEntry[]>();
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function queryOn(server: FastifyInstance, sessionId: string, body: unknown) {
  return server.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/requests/query`,
    headers: JSON_HEADERS,
    payload: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
}

/** The answer of the query route for `body`, which must answer 200. */
async function query(sessionId: string, body: unknown): Promise<RequestListEntry[]> {
  const response = await queryOn(app, sessionId, body);

  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers['content-type']), /^application\/json/);

  return response.json<RequestListEntry[]>();
}

const ids = (entries: RequestListEntry[]): string[] => entries.map((entry) => entry.id);

/**
 * The entries without `response`, whose state a capture's record may move
 * from `pending` to `sent` between two reads (D109).
 */
const settled = (entries: RequestListEntry[]) =>
  entries.map(({ response: _response, ...rest }) => rest);

async function details(sessionId: string, requestId: string): Promise<RequestDetails> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/requests/${requestId}`,
  });

  assert.equal(response.statusCode, 200, response.body);

  return response.json<RequestDetails>();
}

function assertError(
  response: Awaited<ReturnType<FastifyInstance['inject']>>,
  status: number,
  errorCode: number,
  where = '',
): void {
  assert.equal(response.statusCode, status, `${where} ${response.body}`);
  assert.equal(response.json<ApiError>().errorCode, errorCode, where);
  assert.deepEqual(Object.keys(response.json()).sort(), ['errorCode', 'message']);
}

/** The fields every list item carries, before `include` (D037, D110, D180). */
const LIST_FIELDS = ['bodySize', 'id', 'method', 'path', 'receivedAt', 'response', 'sourceIp'];

const sorted = (keys: string[]) => [...keys].sort();

/** How many requests the heavy session holds. */
const HEAVY_REQUESTS = 6;

let heavy: Promise<string> | undefined;

/**
 * A session whose body conditions take long enough to be caught running:
 * bodies of 1 MiB that do not compress, each read to its end by a condition
 * none of them holds. Made once and only read afterwards.
 */
function heavySession(): Promise<string> {
  heavy ??= (async () => {
    const sessionId = await newSession();

    for (let index = 0; index < HEAVY_REQUESTS; index += 1) {
      await capture(sessionId, {
        headers: { 'content-type': 'application/octet-stream' },
        payload: randomBytes(MAX_BODY_BYTES),
      });
    }

    return sessionId;
  })();

  return heavy;
}

/** A body condition no random megabyte holds, so every body is read to its end. */
const HEAVY_QUERY = { body: ['no-such-text-anywhere-0'] };

let heavyHeaders: Promise<string> | undefined;

/**
 * A session whose header conditions take long enough to be caught by a 1 ms
 * timeout: 200 requests of 100 header lines, every one named `a`. Made once
 * and only read afterwards.
 */
function heavyHeaderSession(): Promise<string> {
  heavyHeaders ??= (async () => {
    const sessionId = await newSession();

    await pool.query(
      `INSERT INTO requests (session_id, method, headers, body, body_size, raw_request)
       SELECT $1, 'POST',
              (SELECT jsonb_agg(jsonb_build_array('a', 'v' || h)) FROM generate_series(1, 100) AS h),
              ''::bytea, 0, ''::bytea
       FROM generate_series(1, 200)`,
      [sessionId],
    );

    return sessionId;
  })();

  return heavyHeaders;
}

/** Eight header conditions whose name every stored line has, in another case, and whose value none has. */
const HEAVY_HEADER_QUERY = {
  headers: Array.from({ length: 8 }, (_, index) => ({ name: 'A', value: `never-${index}` })),
};

describe('the list asked for nothing (D037)', () => {
  it('answers the same fields as before, newest first', async () => {
    const sessionId = await newSession();
    const first = await capture(sessionId, { payload: 'first' });
    const second = await capture(sessionId, { payload: 'second' });

    for (const empty of ['', '&', '&&']) {
      const items = await list(sessionId, empty);

      assert.deepEqual(ids(items), [second, first]);

      for (const item of items) {
        assert.deepEqual(sorted(Object.keys(item)), LIST_FIELDS);
      }
    }

    // The query route asked for nothing answers the same array.
    assert.deepEqual(settled(await query(sessionId, {})), settled(await list(sessionId)));
  });
});

describe('include (D196)', () => {
  it('adds exactly the headers, as the detail gives them', async () => {
    const sessionId = await newSession();
    const requestId = await capture(sessionId, {
      headers: { 'x-merchant-id': '123', 'x-trace': 'a b' },
      payload: '{"orderId":42}',
    });
    const items = await list(sessionId, 'include=headers');
    const [item] = items;

    assert.equal(items.length, 1);
    assert.deepEqual(sorted(Object.keys(item ?? {})), sorted([...LIST_FIELDS, 'headers']));
    assert.deepEqual(item?.headers, (await details(sessionId, requestId)).headers);
    assert.deepEqual(settled(await query(sessionId, { include: ['headers'] })), settled(items));
  });

  it('adds exactly the body under the detail’s rule: text, binary, empty and absent (D043)', async () => {
    const sessionId = await newSession();
    const text = await capture(sessionId, {
      headers: { 'content-type': 'application/json' },
      payload: '{"name":"Иван","n":1}',
    });
    const binary = await capture(sessionId, {
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41]),
    });
    const empty = await capture(sessionId, { headers: { 'content-length': '0' } });
    const absent = await capture(sessionId, { method: 'GET' });
    const items = await list(sessionId, 'include=body');

    assert.deepEqual(ids(items), [absent, empty, binary, text]);

    for (const item of items) {
      const detail = await details(sessionId, item.id);

      assert.deepEqual(
        sorted(Object.keys(item)),
        sorted([...LIST_FIELDS, 'body', 'bodyBase64', 'isBinary']),
      );
      assert.deepEqual(
        { body: item.body, bodyBase64: item.bodyBase64, isBinary: item.isBinary },
        { body: detail.body, bodyBase64: detail.bodyBase64, isBinary: detail.isBinary },
      );
    }

    const byId = new Map(items.map((item) => [item.id, item]));

    assert.deepEqual(byId.get(text)?.body, '{"name":"Иван","n":1}');
    assert.deepEqual(
      byId.get(binary)?.bodyBase64,
      Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41]).toString('base64'),
    );
    assert.equal(byId.get(binary)?.body, null);
    assert.equal(byId.get(binary)?.isBinary, true);

    for (const bodiless of [empty, absent]) {
      assert.equal(byId.get(bodiless)?.body, '');
      assert.equal(byId.get(bodiless)?.bodyBase64, null);
      assert.equal(byId.get(bodiless)?.isBinary, false);
      assert.equal(byId.get(bodiless)?.bodySize, 0);
    }

    assert.deepEqual(settled(await query(sessionId, { include: ['body'] })), settled(items));
  });

  it('adds both for headers,body in either order, and the same through the query route', async () => {
    const sessionId = await newSession();

    await capture(sessionId, { payload: 'one' });
    await capture(sessionId, { payload: 'two' });

    const both = await list(sessionId, 'include=headers,body');

    assert.equal(both.length, 2);

    for (const item of both) {
      assert.deepEqual(
        sorted(Object.keys(item)),
        sorted([...LIST_FIELDS, 'headers', 'body', 'bodyBase64', 'isBinary']),
      );
    }

    assert.deepEqual(settled(await list(sessionId, 'include=body%2Cheaders')), settled(both));
    assert.deepEqual(
      settled(await query(sessionId, { include: ['body', 'headers'] })),
      settled(both),
    );
  });

  it('carries a 1 MiB body whole', async () => {
    const sessionId = await newSession();
    const large = 'x'.repeat(MAX_BODY_BYTES - 4) + 'tail';

    await capture(sessionId, { payload: large });

    const [item] = await list(sessionId, 'include=body');

    assert.equal(item?.body, large);
  });

  it('streams an answer with content, and answers the plain list as before', async () => {
    const sessionId = await newSession();
    // 1 MiB of control bytes is 6 MiB of JSON: `\u0001` for each.
    const control = '\u0001'.repeat(MAX_BODY_BYTES);

    await capture(sessionId, { payload: control });
    await capture(sessionId, { payload: control });

    const plain = await listOn(app, sessionId);

    assert.equal(plain.headers['content-length'], String(plain.rawPayload.length));
    assert.equal(plain.headers['transfer-encoding'], undefined);

    for (const answer of [
      await listOn(app, sessionId, 'include=body'),
      await queryOn(app, sessionId, { include: ['headers', 'body'] }),
      await listOn(app, sessionId, 'include=headers'),
    ]) {
      assert.equal(answer.statusCode, 200);
      assert.equal(answer.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(answer.headers['content-length'], undefined);
      assert.equal(answer.headers['transfer-encoding'], 'chunked');
      assert.equal(answer.json<RequestListEntry[]>().length, 2);
    }

    const [first] = await list(sessionId, 'include=body');

    assert.equal(first?.body, control);

    // HEAD answers the headers and no body.
    const head = await app.inject({
      method: 'HEAD',
      url: `/api/sessions/${sessionId}/requests?include=body`,
    });

    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
  });
});

describe('content read while the answer is written (D196)', () => {
  it('reads only the session’s requests, and writes the next in place of one gone since the list was read', async () => {
    const sessionId = await newSession();
    const otherSessionId = await newSession();
    const [first, second, third, fourth] = (await store(sessionId, [
      { headers: [['X-N', '1']], body: 'one' },
      { headers: [['X-N', '2']], body: 'two' },
      { headers: [['X-N', '3']], body: Buffer.from([0xff, 0x00]) },
      { headers: [['X-N', '4']], body: 'four' },
    ])) as [string, string, string, string];
    const [foreign] = (await store(otherSessionId, [{ body: 'not yours' }])) as [string];
    const query = parseListQueryString('include=headers,body&order=asc&limit=3');
    const { chosen, after } = await service.listRequests(pool, sessionId, query);
    const read = service.listedContentReader(pool, sessionId, query);
    const more = service.listContinuation(pool, sessionId, query, after);
    const entries = chosen.map(({ entry }) => entry);

    // Metadata alone comes from the list statement, with each time to the microsecond.
    assert.deepEqual(ids(entries), [first, second, third]);
    assert.ok(entries.every((entry) => !('headers' in entry) && !('body' in entry)));
    assert.ok(
      chosen.every(({ receivedAt }) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(receivedAt)),
    );
    assert.equal(after, null);

    // A read finds the session's requests and nothing else, whatever it is asked for.
    assert.deepEqual([...(await read([first, foreign, randomUUID()])).keys()], [first]);

    // Deleted after the list was read and before its content: the fourth takes its place.
    await pool.query('DELETE FROM requests WHERE id = $1', [second]);

    const chunks: Buffer[] = [];

    for await (const chunk of jsonArrayStream(chosen, query, read, more)) {
      chunks.push(chunk as Buffer);
    }

    const written = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestListEntry[];

    assert.deepEqual(ids(written), [first, third, fourth]);
    assert.deepEqual(
      written.map(({ headers, body, bodyBase64, isBinary }) => [
        headers,
        body,
        bodyBase64,
        isBinary,
      ]),
      [
        [[['X-N', '1']], 'one', null, false],
        [[['X-N', '3']], null, '/wA=', true],
        [[['X-N', '4']], 'four', null, false],
      ],
    );
  });
});

type Route = 'GET' | 'POST';

const ROUTES: Route[] = ['GET', 'POST'];
const ORDERS = ['asc', 'desc'] as const;
/** Headers alone are read 50 requests at a time, a body one at a time. */
const INCLUDES: ('headers' | 'body')[][] = [['headers'], ['body']];

interface Asked {
  order: 'asc' | 'desc';
  include: ('headers' | 'body')[];
  limit: number;
  after?: string;
  /** Body conditions, for the query route alone. */
  body?: string[];
  /** Header conditions, for the query route alone. */
  headers?: { name: string; value: string }[];
}

/** `asked` sent to the hooked listener, as query parameters or as a query's body. */
function askHooked(route: Route, sessionId: string, asked: Asked) {
  if (route === 'GET') {
    const parameters = [
      `include=${asked.include.join(',')}`,
      `order=${asked.order}`,
      `limit=${asked.limit}`,
      ...(asked.after === undefined ? [] : [`after=${asked.after}`]),
    ];

    return listOn(hooked, sessionId, parameters.join('&'));
  }

  return queryOn(hooked, sessionId, asked);
}

/** The answer of the hooked listener, which must be a whole `200` array. */
async function answerHooked(
  route: Route,
  sessionId: string,
  asked: Asked,
): Promise<RequestListEntry[]> {
  const response = await askHooked(route, sessionId, asked);

  assert.equal(response.statusCode, 200, response.body);

  return response.json<RequestListEntry[]>();
}

async function deleteRequests(requestIds: string[]): Promise<void> {
  await pool.query('DELETE FROM requests WHERE id = ANY($1::uuid[])', [requestIds]);
}

/** Each stored body of the session as text, by request id. */
async function bodiesOf(sessionId: string): Promise<Map<string, string>> {
  const result = await pool.query<{ id: string; body: string }>(
    "SELECT id, convert_from(body, 'UTF8') AS body FROM requests WHERE session_id = $1",
    [sessionId],
  );

  return new Map(result.rows.map((row) => [row.id, row.body]));
}

/** Checks that each entry carries what `include` asked for, as stored. */
function assertContent(
  entries: RequestListEntry[],
  include: ('headers' | 'body')[],
  bodies: Map<string, string>,
  where: string,
): void {
  for (const entry of entries) {
    assert.equal('headers' in entry, include.includes('headers'), where);
    assert.equal(entry.body, include.includes('body') ? bodies.get(entry.id) : undefined, where);
  }
}

describe('requests gone between the list and their content (D196)', () => {
  it('never answers an empty array while a request follows the one it chose', async () => {
    for (const route of ROUTES) {
      for (const include of INCLUDES) {
        for (const order of ORDERS) {
          const where = `${route} ${include.join(',')} ${order}`;
          const sessionId = await newSession();
          const all = await storeMany(sessionId, 5, '2026-10-01T09:00:00Z');
          const [chosen, next] = (order === 'asc' ? all : [...all].reverse()) as [string, string];
          const answer = await withHooks(
            sessionId,
            {
              beforeContentRead: async (requestIds) => {
                if (requestIds.includes(chosen)) {
                  await deleteRequests([chosen]);
                }
              },
            },
            () => answerHooked(route, sessionId, { order, include, limit: 1 }),
          );

          assert.deepEqual(ids(answer), [next], where);
        }
      }
    }
  });

  it('fills the answer from beyond the last request it chose, and again when those are gone', async () => {
    for (const route of ROUTES) {
      for (const include of INCLUDES) {
        for (const order of ORDERS) {
          const where = `${route} ${include.join(',')} ${order}`;
          const sessionId = await newSession();
          // Groups of seven share a millisecond, and some of them a microsecond.
          const all = await storeMany(sessionId, 20, '2026-10-01T09:00:00Z');
          const listed = order === 'asc' ? all : [...all].reverse();
          const at = (index: number) => listed[index] as string;
          const bodies = await bodiesOf(sessionId);
          let reads = 0;
          const answer = await withHooks(
            sessionId,
            {
              beforeContentRead: async (requestIds) => {
                reads += 1;

                // Chosen: 0 to 3. The first and the last of them go, and the
                // first after them, before any content is read.
                if (reads === 1) {
                  await deleteRequests([at(0), at(3), at(4)]);
                }

                // The list resumes beyond 3 with 5 and 6; 6 goes as 5 is read.
                if (requestIds.includes(at(5))) {
                  await deleteRequests([at(6)]);
                }
              },
            },
            () => answerHooked(route, sessionId, { order, include, limit: 4 }),
          );

          assert.deepEqual(ids(answer), [at(1), at(2), at(5), at(7)], where);
          assertContent(answer, include, bodies, where);
        }
      }
    }
  });

  it('resumes after the position of the request after names, even when it is gone too', async () => {
    for (const route of ROUTES) {
      for (const include of INCLUDES) {
        const where = `${route} ${include.join(',')}`;
        const newestFirst = await newSession();
        const all = await storeMany(newestFirst, 12, '2026-10-01T09:00:00Z');
        const at = (index: number) => all[index] as string;

        // After 6, newest first: 11, 10 and 9 chosen; 11, 9, 8 and 6 itself
        // go. 7 follows 9, and nothing else: 5 and older are not after 6.
        const newest = await withHooks(
          newestFirst,
          { beforeContentRead: () => deleteRequests([at(6), at(11), at(9), at(8)]) },
          () =>
            answerHooked(route, newestFirst, { order: 'desc', include, limit: 3, after: at(6) }),
        );

        assert.deepEqual(ids(newest), [at(10), at(7)], `${where} desc`);

        // After 4, oldest first: 5, 6 and 7 chosen; 5, 7, 8 and 4 itself go;
        // 9 and 10 follow 7.
        const oldestFirst = await newSession();
        const other = await storeMany(oldestFirst, 12, '2026-10-01T09:00:00Z');
        const of = (index: number) => other[index] as string;
        const oldest = await withHooks(
          oldestFirst,
          { beforeContentRead: () => deleteRequests([of(4), of(5), of(7), of(8)]) },
          () => answerHooked(route, oldestFirst, { order: 'asc', include, limit: 3, after: of(4) }),
        );

        assert.deepEqual(ids(oldest), [of(6), of(9), of(10)], `${where} asc`);
      }
    }
  });

  it('writes the next requests in place of those the newest 1000 pushed out, oldest first (D006)', async () => {
    for (const route of ROUTES) {
      for (const include of INCLUDES) {
        const sessionId = await newSession();
        // A day ago, so that a capture made now is the newest.
        const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
        const all = await storeMany(sessionId, MAX_REQUESTS_PER_SESSION, dayAgo);
        const bodies = await bodiesOf(sessionId);
        let captured = false;
        const answer = await withHooks(
          sessionId,
          {
            beforeContentRead: async () => {
              if (!captured) {
                captured = true;

                // Three captures push out the three oldest: the three chosen.
                for (let index = 0; index < 3; index += 1) {
                  await capture(sessionId, { payload: `new ${index}` });
                }
              }
            },
          },
          () => answerHooked(route, sessionId, { order: 'asc', include, limit: 3 }),
        );
        const where = `${route} ${include.join(',')}`;

        assert.deepEqual(ids(answer), all.slice(3, 6), where);
        assertContent(answer, include, bodies, where);
        assert.equal((await receiptOrder(sessionId)).length, MAX_REQUESTS_PER_SESSION, where);
      }
    }
  });

  it('ends a newest-first answer where the oldest were pushed out, since none older is left', async () => {
    // Pushed out are the oldest, so nothing listed newest first follows one.
    const dayAgo = Date.now() - 86_400_000;
    const plain = await newSession();
    const all = await storeMany(plain, MAX_REQUESTS_PER_SESSION, new Date(dayAgo).toISOString());
    const answer = await withHooks(
      plain,
      {
        beforeContentRead: async (requestIds) => {
          if (requestIds.includes(all[0] as string)) {
            await capture(plain, { payload: 'new 1' });
            await capture(plain, { payload: 'new 2' });
          }
        },
      },
      () => answerHooked('GET', plain, { order: 'desc', include: ['headers'], limit: 1000 }),
    );

    assert.deepEqual(ids(answer), all.slice(2).reverse());

    // The query route, its condition choosing the three oldest of a full session.
    for (const include of INCLUDES) {
      const sessionId = await newSession();
      const marked = await store(sessionId, [
        { body: 'mark 0', receivedAt: new Date(dayAgo - 3000).toISOString() },
        { body: 'mark 1', receivedAt: new Date(dayAgo - 2000).toISOString() },
        { body: 'mark 2', receivedAt: new Date(dayAgo - 1000).toISOString() },
      ]);

      await storeMany(sessionId, MAX_REQUESTS_PER_SESSION - 3, new Date(dayAgo).toISOString());

      const newest = await withHooks(
        sessionId,
        {
          beforeContentRead: async (requestIds) => {
            if (requestIds.includes(marked[2] as string)) {
              await capture(sessionId, { payload: 'new 1' });
              await capture(sessionId, { payload: 'new 2' });
            }
          },
        },
        () =>
          answerHooked('POST', sessionId, {
            order: 'desc',
            include,
            limit: 2,
            body: ['mark'],
          }),
      );

      assert.deepEqual(ids(newest), [marked[2]], include.join(','));
    }
  });

  it('answers what it wrote when the session is removed meanwhile', async () => {
    for (const include of INCLUDES) {
      const sessionId = await newSession();
      const all = await storeMany(sessionId, 5, '2026-10-01T09:00:00Z');
      const answer = await withHooks(
        sessionId,
        {
          beforeContentRead: async (requestIds) => {
            // As the cleanup removes it: the session and every request with it.
            if (requestIds.includes(all[1] as string)) {
              await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
            }
          },
        },
        () => answerHooked('GET', sessionId, { order: 'asc', include, limit: 3 }),
      );

      // A body is read one request at a time, so the first was written; three
      // headers are read at once, after the session went.
      assert.deepEqual(ids(answer), include.includes('body') ? [all[0]] : [], include.join(','));
    }
  });
});

describe('a resumed list, in the service (D196)', () => {
  it('takes a place of the query’s own kind for the resumption, and gives it back (D250)', async () => {
    const sessionId = await newSession();
    // Every body holds `common`, and every request the merchant's header.
    const all = await store(
      sessionId,
      Array.from({ length: 6 }, (_, index) => ({
        headers: [['X-Merchant-ID', '123']] as [string, string][],
        body: `common ${index}`,
      })),
    );
    const merchant = { name: 'x-merchant-id', value: '123' };
    const kinds = [
      { kind: 'headerOnly', body: { order: 'asc', limit: 2, include: ['body'] } },
      { kind: 'headerOnly', body: { order: 'asc', limit: 2, headers: [merchant] } },
      { kind: 'search', body: { order: 'asc', limit: 2, body: ['common'] } },
      { kind: 'search', body: { order: 'asc', limit: 2, headers: [merchant], body: ['common'] } },
    ] as const;

    for (const { kind, body } of kinds) {
      const where = `${kind} ${JSON.stringify(body)}`;
      const query = parseQueryBody(JSON.stringify(body));
      const { chosen } = await service.queryRequests(
        pool,
        sessionId,
        query,
        createQuerySlots(),
        2000,
      );
      const last = chosen.at(-1) as (typeof chosen)[number];
      const beyond = { receivedAt: last.receivedAt, id: last.entry.id };
      const slots = createQuerySlots(createSearchSlots(1), 1);
      const own = slots[kind];
      const other = kind === 'search' ? slots.headerOnly : slots.search;
      // Every place of the other count taken changes nothing.
      const otherHeld = other.tryTake();

      assert.notEqual(otherHeld, null, where);

      const more = service.queryContinuation(pool, sessionId, query, null, slots, 2000);

      assert.deepEqual(
        (await more(beyond, 2)).map(({ entry }) => entry.id),
        all.slice(2, 4),
        where,
      );

      // Given back: the only place of its kind can be taken again.
      const release = own.tryTake();

      assert.notEqual(release, null, where);

      // Every place of its kind taken: 429 / 1012 with Retry-After: 1, and no statement.
      await assert.rejects(
        more(beyond, 2),
        (error: unknown) =>
          (error as { errorCode?: number }).errorCode === 1012 &&
          (error as { headers?: Record<string, string> }).headers?.['retry-after'] === '1',
        where,
      );
      release?.();
      otherHeld?.();
      assert.deepEqual([slots.search.taken, slots.headerOnly.taken], [0, 0], where);
    }

    // The GET's resumption takes none.
    const plain = parseQueryBody('{"order":"asc","limit":2,"include":["body"]}');
    const first = await service.queryRequests(pool, sessionId, plain, createQuerySlots(), 2000);
    const last = first.chosen.at(-1) as (typeof first.chosen)[number];

    assert.deepEqual(
      (
        await service.listContinuation(
          pool,
          sessionId,
          plain,
          null,
        )({ receivedAt: last.receivedAt, id: last.entry.id }, 9)
      ).map(({ entry }) => entry.id),
      all.slice(2),
    );
  });

  it('stops the query’s resumption at its timeout: 503 / 1011', async () => {
    const sessionId = await heavySession();
    const query = parseQueryBody(JSON.stringify({ ...HEAVY_QUERY, limit: 1 }));
    const beyond = { receivedAt: '9999-12-31T23:59:59.999999Z', id: randomUUID() };

    await assert.rejects(
      service.queryContinuation(pool, sessionId, query, null, createQuerySlots(), 1)(beyond, 1),
      (error: unknown) => (error as { errorCode?: number }).errorCode === 1011,
    );
  });

  it('ends the answer unfinished when a resumption fails, never as a whole shorter array', async () => {
    for (const route of ROUTES) {
      const sessionId = await newSession();
      const all = await storeMany(sessionId, 5, '2026-10-01T09:00:00Z');
      let failed = 0;
      const answering = withHooks(
        sessionId,
        {
          beforeContentRead: async (requestIds) => {
            if (requestIds.includes(all[0] as string)) {
              await deleteRequests([all[0] as string]);
            }
          },
          beforeResume: async () => {
            failed += 1;
            throw new Error('the resumption failed');
          },
        },
        () => askHooked(route, sessionId, { order: 'asc', include: ['body'], limit: 2 }),
      );

      // The status and the first request were sent; the connection is cut
      // before the array closes, so no client reads it as a whole answer.
      await assert.rejects(answering, { code: 'LIGHT_ECONNRESET' }, route);
      assert.equal(failed, 1, route);

      // Without the failure, the same answer is whole: the next request in
      // its place, read by the one resumed list statement.
      let resumed = 0;
      const whole = await withHooks(
        sessionId,
        {
          beforeContentRead: async (requestIds) => {
            if (requestIds.includes(all[1] as string)) {
              await deleteRequests([all[1] as string]);
            }
          },
          beforeResume: async () => {
            resumed += 1;
          },
        },
        () => answerHooked(route, sessionId, { order: 'asc', include: ['body'], limit: 2 }),
      );

      assert.deepEqual(ids(whole), [all[2], all[3]], route);
      assert.equal(resumed, 1, route);
    }
  });
});

describe('at most 20 requests with bodies (D196)', () => {
  it('answers the newest 20 by default, 20 at most, and all of them without bodies', async () => {
    const sessionId = await newSession();
    const all = await storeMany(sessionId, 25, '2026-10-01T09:00:00Z');
    const newest = [...all].reverse();

    assert.deepEqual(ids(await list(sessionId, 'include=body')), newest.slice(0, 20));
    assert.deepEqual(
      ids(await list(sessionId, 'include=headers,body&limit=20')),
      newest.slice(0, 20),
    );
    assert.deepEqual(ids(await list(sessionId, 'include=body&limit=3')), newest.slice(0, 3));
    assert.deepEqual(ids(await list(sessionId, 'include=body&order=asc')), all.slice(0, 20));
    assert.deepEqual(ids(await list(sessionId, 'include=headers')), newest);
    assert.deepEqual(ids(await query(sessionId, { include: ['body'] })), newest.slice(0, 20));
    assert.deepEqual(ids(await query(sessionId, { include: ['headers'] })), newest);

    for (const refused of [
      await listOn(app, sessionId, 'include=body&limit=21'),
      await listOn(app, sessionId, 'include=headers,body&limit=1000'),
      await queryOn(app, sessionId, { include: ['body'], limit: 21 }),
    ]) {
      assertError(refused, 400, 1013);
      assert.match(refused.json<ApiError>().message, /^limit /);
    }
  });
});

describe('limit and order (D056, D196)', () => {
  it('caps and orders, the id breaking ties in the same direction', async () => {
    const sessionId = await newSession();
    const all = await storeMany(sessionId, 30, '2026-10-01T09:00:00Z');
    const newest = [...all].reverse();

    assert.deepEqual(ids(await list(sessionId)), newest);
    assert.deepEqual(ids(await list(sessionId, 'order=desc')), newest);
    assert.deepEqual(ids(await list(sessionId, 'order=asc')), all);
    assert.deepEqual(ids(await list(sessionId, 'limit=4')), newest.slice(0, 4));
    assert.deepEqual(ids(await list(sessionId, 'limit=4&order=asc')), all.slice(0, 4));
    assert.deepEqual(ids(await list(sessionId, 'limit=1000')), newest);
    assert.deepEqual(ids(await query(sessionId, { limit: 4, order: 'asc' })), all.slice(0, 4));
  });

  it('orders requests sharing one received_at by id, in either direction', async () => {
    const sessionId = await newSession();
    const tied = await store(
      sessionId,
      Array.from({ length: 6 }, () => ({ receivedAt: '2026-10-01T09:00:00.123456Z' })),
    );
    const [before] = await store(sessionId, [{ receivedAt: '2026-10-01T09:00:00.123455Z' }]);
    const [later] = await store(sessionId, [{ receivedAt: '2026-10-01T09:00:00.123457Z' }]);
    const tiedAsc = [...tied].sort();

    assert.deepEqual(ids(await list(sessionId, 'order=asc')), [before, ...tiedAsc, later]);
    assert.deepEqual(ids(await list(sessionId)), [later, ...[...tiedAsc].reverse(), before]);

    // All eight show the same millisecond.
    assert.equal(new Set((await list(sessionId)).map((item) => item.receivedAt)).size, 1);

    // `after` a request inside the tie: the tied ones with a greater id, then later.
    const middle = tiedAsc[2] as string;

    assert.deepEqual(ids(await list(sessionId, `order=asc&after=${middle}`)), [
      ...tiedAsc.slice(3),
      later,
    ]);
    assert.deepEqual(ids(await list(sessionId, `after=${middle}`)), [
      later,
      ...tiedAsc.slice(3).reverse(),
    ]);
    assert.deepEqual(
      ids(await list(sessionId, `after=${before}&limit=2&order=asc`)),
      tiedAsc.slice(0, 2),
    );
    assert.deepEqual(ids(await list(sessionId, `after=${later}`)), []);
  });
});

describe('paging with after (D196)', () => {
  it('returns each of several hundred requests once, in receipt order, page by page', async () => {
    const sessionId = await newSession();
    const all = await storeMany(sessionId, 450, '2026-10-01T09:00:00Z');

    for (const pageSize of [1, 37, 450, 1000]) {
      const seen: string[] = [];
      let last: string | undefined;

      for (;;) {
        const page = ids(
          await list(sessionId, `order=asc&limit=${pageSize}${last ? `&after=${last}` : ''}`),
        );

        if (page.length === 0) {
          break;
        }

        assert.ok(page.length <= pageSize);
        seen.push(...page);
        last = page.at(-1);
      }

      assert.equal(new Set(seen).size, seen.length, `a repeat with pages of ${pageSize}`);
      assert.deepEqual(seen, all, `a gap or another order with pages of ${pageSize}`);
    }
  });

  it('pages the same through the query route, its conditions applied on every page', async () => {
    const sessionId = await newSession();
    const all = await storeMany(sessionId, 300, '2026-10-01T09:00:00Z');
    // Bodies are `n=1` to `n=300`: `n=1` is in 1, 10 to 19 and 100 to 199.
    const holding = (
      await pool.query<{ id: string }>(
        `SELECT id FROM requests WHERE session_id = $1 AND position('n=1'::bytea IN body) > 0
         ORDER BY received_at, id`,
        [sessionId],
      )
    ).rows.map((row) => row.id);

    assert.equal(holding.length, 111);

    for (const [condition, expected] of [
      [{}, all],
      [{ body: ['n=1'] }, holding],
    ] as const) {
      const seen: string[] = [];
      let last: string | undefined;

      for (;;) {
        const page = ids(
          await query(sessionId, {
            ...condition,
            order: 'asc',
            limit: 9,
            ...(last === undefined ? {} : { after: last }),
          }),
        );

        if (page.length === 0) {
          break;
        }

        seen.push(...page);
        last = page.at(-1);
      }

      assert.deepEqual(seen, expected);
    }
  });

  it('keeps only the requests after it, whatever order sorts them by', async () => {
    const sessionId = await newSession();
    const all = await storeMany(sessionId, 20, '2026-10-01T09:00:00Z');
    const pivot = all[11] as string;

    assert.deepEqual(ids(await list(sessionId, `after=${pivot}&order=asc`)), all.slice(12));
    assert.deepEqual(ids(await list(sessionId, `after=${pivot}`)), all.slice(12).reverse());
    assert.deepEqual(ids(await list(sessionId, `after=${pivot}&limit=3`)), all.slice(17).reverse());
    // An id in capitals names the same request.
    assert.deepEqual(
      ids(await list(sessionId, `after=${pivot.toUpperCase()}&order=asc`)),
      all.slice(12),
    );
  });

  /**
   * A poller that saw `second` and continues after it must find `first`,
   * which began its capture earlier but took the session's lock (D065) and
   * committed later. A receipt time read when the capture's transaction began
   * put `first` before `second`, behind the poller's `after`, and no later
   * page ever listed it: a webhook stored and never returned.
   */
  it('lists a capture that began before another but took the lock after it, after that one', async () => {
    const sessionId = await newSession();
    let reachedLock = (): void => undefined;
    const atLock = new Promise<void>((resolve) => {
      reachedLock = resolve;
    });
    let releaseLock = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await withHooks(
      sessionId,
      {
        beforeLock: async () => {
          reachedLock();
          await released;
        },
      },
      async () => {
        // `first` begins its transaction and stops before asking for the lock.
        const pending = hookedReceiver.inject({
          method: 'POST',
          url: `/s/${sessionId}`,
          headers: { 'content-type': 'text/plain' },
          payload: 'began first',
        });

        try {
          await atLock;

          // `second` begins later, takes the lock, commits, and is listed.
          const second = await capture(sessionId, { payload: 'committed first' });

          assert.deepEqual(ids(await list(sessionId, 'order=asc')), [second]);
          assert.deepEqual(ids(await list(sessionId, `order=asc&after=${second}`)), []);

          releaseLock();

          const response = await pending;

          assert.equal(response.statusCode, 200, response.body);

          const first = response.headers[REQUEST_ID_HEADER] as string;

          // The poller's next page, after the newest it saw.
          assert.deepEqual(ids(await list(sessionId, `order=asc&after=${second}`)), [first]);
          assert.deepEqual(ids(await query(sessionId, { order: 'asc', after: second })), [first]);
          assert.deepEqual(ids(await list(sessionId)), [first, second]);
        } finally {
          releaseLock();
          await pending;
        }
      },
    );
  });
});

describe('after naming no request of the session (D066, D196)', () => {
  it('answers 404 / 1003 for a deleted request, on both routes', async () => {
    const sessionId = await newSession();
    const kept = await capture(sessionId, { payload: 'kept' });
    const deleted = await capture(sessionId, { payload: 'deleted' });
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/requests/${deleted}`,
    });

    assert.equal(response.statusCode, 204);
    assertError(await listOn(app, sessionId, `after=${deleted}`), 404, 1003);
    assertError(await queryOn(app, sessionId, { after: deleted }), 404, 1003);
    assert.deepEqual(ids(await list(sessionId, `after=${kept}`)), []);
  });

  it('answers 404 / 1003 for a request the newest 1000 pushed out (D006)', async () => {
    const sessionId = await newSession();
    // A day ago, so that a capture made now is the newest.
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const stored = await storeMany(sessionId, MAX_REQUESTS_PER_SESSION, dayAgo);
    const oldest = stored[0] as string;
    const second = stored[1] as string;

    // Still there: the list after it is the other 999.
    assert.equal((await list(sessionId, `after=${oldest}`)).length, MAX_REQUESTS_PER_SESSION - 1);

    // The 1001st request evicts the oldest.
    const newest = await capture(sessionId, { payload: 'the 1001st' });

    assertError(await listOn(app, sessionId, `after=${oldest}`), 404, 1003);
    assertError(await queryOn(app, sessionId, { after: oldest, order: 'asc' }), 404, 1003);
    assert.equal((await list(sessionId, `after=${second}`)).length, MAX_REQUESTS_PER_SESSION - 1);
    assert.deepEqual(ids(await list(sessionId, `after=${stored.at(-1)}`)), [newest]);
  });

  it('answers 404 / 1003 for an id that never existed, another session’s and a malformed one', async () => {
    const sessionId = await newSession();
    const otherSessionId = await newSession();
    const others = await capture(otherSessionId, { payload: 'not yours' });

    await capture(sessionId, { payload: 'mine' });

    for (const id of [
      randomUUID(),
      others,
      'not-a-uuid',
      '',
      `${others}0`,
      '%zz',
      'a'.repeat(5000),
    ]) {
      assertError(
        await listOn(app, sessionId, `after=${id}`),
        404,
        1003,
        `GET after=${id.slice(0, 40)}`,
      );
      assertError(
        await queryOn(app, sessionId, { after: id }),
        404,
        1003,
        `POST after=${id.slice(0, 40)}`,
      );
    }

    assertError(await listOn(app, sessionId, 'after'), 404, 1003);
  });

  it('answers for the session first: 410 for an expired one, 404 / 1001 for an unknown one', async () => {
    const sessionId = await newSession();
    const requestId = await capture(sessionId, { payload: 'here' });

    await whileExpired(pool, sessionId, async () => {
      for (const after of [requestId, randomUUID()]) {
        assertError(await listOn(app, sessionId, `after=${after}`), 410, 1002);
        assertError(await queryOn(app, sessionId, { after }), 410, 1002);
      }
    });

    for (const after of [requestId, randomUUID()]) {
      assertError(await listOn(app, 'z'.repeat(43), `after=${after}`), 404, 1001);
      assertError(await queryOn(app, 'z'.repeat(43), { after }), 404, 1001);
    }

    // An id that cannot be a session's is 1001 before anything about `after`.
    assertError(await listOn(app, 'short', 'after=not-an-id'), 404, 1001);
    assertError(await queryOn(app, 'short', { after: 'not-an-id' }), 404, 1001);
  });

  it('answers 400 / 1013 for after with since, before anything about either', async () => {
    const sessionId = await newSession();

    for (const after of [randomUUID(), 'not-an-id']) {
      assertError(
        await listOn(app, sessionId, `after=${after}&since=2026-10-04T09:00:00Z`),
        400,
        1013,
      );
      assertError(
        await queryOn(app, sessionId, { after, since: '2026-10-04T09:00:00Z' }),
        400,
        1013,
      );
    }

    assertError(await listOn(app, 'z'.repeat(43), `after=x&since=2026-10-04T09:00:00Z`), 400, 1013);
  });
});

describe('since (D196)', () => {
  it('keeps requests stored strictly later, compared at the microsecond, at the boundary', async () => {
    const sessionId = await newSession();
    // Three requests in three consecutive milliseconds, the middle one stored
    // with microseconds `receivedAt` does not show.
    const [early, middle, late] = await store(sessionId, [
      { receivedAt: '2026-10-04T09:00:00.122999Z' },
      { receivedAt: '2026-10-04T09:00:00.123456Z' },
      { receivedAt: '2026-10-04T09:00:00.124000Z' },
    ]);
    const asc = (since: string) =>
      list(sessionId, `order=asc&since=${encodeURIComponent(since)}`).then(ids);

    assert.equal(
      (await list(sessionId)).find((item) => item.id === middle)?.receivedAt,
      '2026-10-04T09:00:00.123Z',
    );
    // Its own receivedAt is earlier than what is stored: it is listed again.
    assert.deepEqual(await asc('2026-10-04T09:00:00.123Z'), [middle, late]);
    assert.deepEqual(await asc('2026-10-04T09:00:00.123100Z'), [middle, late]);
    // Its stored time: not later than itself. One microsecond before: later.
    assert.deepEqual(await asc('2026-10-04T09:00:00.123456Z'), [late]);
    assert.deepEqual(await asc('2026-10-04T09:00:00.123455Z'), [middle, late]);
    // Finer than a microsecond: stored times are whole microseconds.
    assert.deepEqual(await asc('2026-10-04T09:00:00.123455999Z'), [middle, late]);
    assert.deepEqual(await asc('2026-10-04T09:00:00.123456001Z'), [late]);
    assert.deepEqual(await asc('2026-10-04T09:00:00.123999999Z'), [late]);
    // The other two at their own microsecond, and one before it.
    assert.deepEqual(await asc('2026-10-04T09:00:00.122999Z'), [middle, late]);
    assert.deepEqual(await asc('2026-10-04T09:00:00.122998Z'), [early, middle, late]);
    assert.deepEqual(await asc('2026-10-04T09:00:00.124Z'), []);
    assert.deepEqual(await asc('2026-10-04T09:00:00.123999Z'), [late]);
    // `after` is how a client continues without the repeat its own receivedAt gives.
    assert.deepEqual(ids(await list(sessionId, `order=asc&after=${middle}`)), [late]);
    // The same moments in another zone, the + sent as it is and encoded.
    assert.deepEqual(
      ids(await list(sessionId, 'order=asc&since=2026-10-04T12:00:00.123456+03:00')),
      [late],
    );
    assert.deepEqual(await asc('2026-10-04T12:00:00.123455+03:00'), [middle, late]);
    assert.deepEqual(await asc('2026-10-04T05:30:00.123-03:30'), [middle, late]);
    // The edges of the calendar.
    assert.deepEqual(await asc('0001-01-01T00:00:00Z'), [early, middle, late]);
    assert.deepEqual(await asc('0000-01-01T00:00:00Z'), [early, middle, late]);
    assert.deepEqual(await asc('9999-12-31T23:59:59.999999Z'), []);
    assert.deepEqual(await asc('9999-12-31T23:00:00-01:00'), []);
    // The query route, and with a cap and newest first.
    assert.deepEqual(ids(await query(sessionId, { since: '2026-10-04T09:00:00.122999Z' })), [
      late,
      middle,
    ]);
    assert.deepEqual(ids(await query(sessionId, { since: '2026-10-04T09:00:00.123456Z' })), [late]);
    assert.deepEqual(ids(await list(sessionId, 'since=2026-10-04T09:00:00.100Z&limit=1')), [late]);
  });

  it('keeps exactly the requests stored later, microsecond by microsecond inside one millisecond', async () => {
    const sessionId = await newSession();
    const micros = ['000', '001', '001', '499', '500', '998', '999'];
    const stored = await store(
      sessionId,
      micros.map((micro) => ({ receivedAt: `2026-10-04T09:00:00.777${micro}Z` })),
    );
    const order = await receiptOrder(sessionId);

    for (const [index, micro] of micros.entries()) {
      const since = `2026-10-04T09:00:00.777${micro}Z`;
      const later = stored.filter((_, other) => (micros[other] as string) > micro);

      assert.deepEqual(
        await list(sessionId, `order=asc&since=${since}`).then(ids),
        order.filter((id) => later.includes(id)),
        `since ${since} (${index})`,
      );
    }

    // The millisecond itself, as receivedAt shows it, is earlier than all of them but the first.
    assert.deepEqual(
      await list(sessionId, 'order=asc&since=2026-10-04T09:00:00.777Z').then(ids),
      order.filter((id) => id !== stored[0]),
    );
  });

  it('answers 400 / 1013 for a since with no zone or out of range', async () => {
    const sessionId = await newSession();

    for (const since of [
      '2026-10-04T09:00:00',
      '2026-10-04',
      '2026-02-30T00:00:00Z',
      '+275760-09-13T00:00:00Z',
      '1759568400',
    ]) {
      assertError(
        await listOn(app, sessionId, `since=${encodeURIComponent(since)}`),
        400,
        1013,
        since,
      );
      assertError(await queryOn(app, sessionId, { since }), 400, 1013, since);
    }
  });
});

describe('the conditions of a query (D196)', () => {
  it('matches a header name in any letter case and its value whole, in its case', async () => {
    const sessionId = await newSession();
    const [merchant, upper, longer] = await store(sessionId, [
      { headers: [['X-Merchant-ID', '123']] },
      { headers: [['x-merchant-id', 'ABC']] },
      { headers: [['X-MERCHANT-ID', '1234']] },
    ]);
    const matching = (name: string, value: string) =>
      query(sessionId, { headers: [{ name, value }], order: 'asc' }).then(ids);

    for (const name of ['X-Merchant-ID', 'x-merchant-id', 'X-MERCHANT-ID', 'x-MeRcHaNt-Id']) {
      assert.deepEqual(await matching(name, '123'), [merchant], name);
      assert.deepEqual(await matching(name, 'ABC'), [upper], name);
    }

    // A value is compared whole: a prefix, a longer value and another case are other values.
    assert.deepEqual(await matching('x-merchant-id', '12'), []);
    assert.deepEqual(await matching('x-merchant-id', '1234'), [longer]);
    assert.deepEqual(await matching('x-merchant-id', 'abc'), []);
    assert.deepEqual(await matching('x-merchant-id', '123 '), []);
    // Nor is a name a prefix.
    assert.deepEqual(await matching('x-merchant', '123'), []);
    assert.deepEqual(await matching('x-merchant-id-2', '123'), []);
  });

  it('folds ASCII letters only: no Unicode case rule matches another name', async () => {
    const sessionId = await newSession();
    const [kelvin, plain] = await store(sessionId, [
      { headers: [['X-Key', 'v']] },
      { headers: [['X-Key', 'v']] },
    ]);

    assert.deepEqual(ids(await query(sessionId, { headers: [{ name: 'x-key', value: 'v' }] })), [
      plain,
    ]);
    assert.deepEqual(ids(await query(sessionId, { headers: [{ name: 'X-KEY', value: 'v' }] })), [
      kelvin,
    ]);
    assert.deepEqual(ids(await query(sessionId, { headers: [{ name: 'x-ünï', value: 'v' }] })), []);
  });

  it('matches a repeated header by any of its occurrences', async () => {
    const sessionId = await newSession();
    const [repeated, single] = await store(sessionId, [
      {
        headers: [
          ['X-Tag', 'a'],
          ['Content-Type', 'text/plain'],
          ['x-tag', 'b'],
        ],
      },
      { headers: [['X-Tag', 'b']] },
    ]);
    const tagged = (value: string) =>
      query(sessionId, { headers: [{ name: 'X-Tag', value }], order: 'asc' }).then(ids);

    assert.deepEqual(await tagged('a'), [repeated]);
    assert.deepEqual(await tagged('b'), [repeated, single]);
    assert.deepEqual(await tagged('a, b'), []);
    assert.deepEqual(await tagged('c'), []);
    // Two conditions on one name: both must hold, each by any occurrence.
    assert.deepEqual(
      ids(
        await query(sessionId, {
          headers: [
            { name: 'x-tag', value: 'a' },
            { name: 'x-tag', value: 'b' },
          ],
        }),
      ),
      [repeated],
    );
  });

  it('matches an empty header value only where the value is empty', async () => {
    const sessionId = await newSession();
    const [empty] = await store(sessionId, [
      { headers: [['X-Empty', '']] },
      { headers: [['X-Empty', ' ']] },
      { headers: [['X-Other', '']] },
    ]);

    assert.deepEqual(ids(await query(sessionId, { headers: [{ name: 'x-empty', value: '' }] })), [
      empty,
    ]);
  });

  it('matches captured headers, as the receiver stored them', async () => {
    const sessionId = await newSession();
    const signed = await capture(sessionId, {
      headers: { 'x-signature': 'sha256=abc', 'x-merchant-id': '123' },
      payload: '{"orderId":42}',
    });

    await capture(sessionId, { headers: { 'x-merchant-id': '1234' }, payload: '{"orderId":42}' });

    assert.deepEqual(
      ids(await query(sessionId, { headers: [{ name: 'X-Merchant-ID', value: '123' }] })),
      [signed],
    );
    assert.deepEqual(
      ids(await query(sessionId, { headers: [{ name: 'Content-Type', value: 'text/plain' }] }))
        .length,
      2,
    );
  });

  it('matches body bytes exactly: case, spacing and encoding are other bytes', async () => {
    const sessionId = await newSession();
    const order = await capture(sessionId, { payload: '{"event":"order.paid","orderId":42}' });
    const spaced = await capture(sessionId, { payload: '{"event": "order.paid", "orderId": 42}' });
    const binary = await capture(sessionId, {
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.concat([
        Buffer.from([0xff, 0x00]),
        Buffer.from('tokBinary'),
        Buffer.from([0x00, 0xc3]),
      ]),
    });
    const cp1251 = await capture(sessionId, {
      headers: { 'content-type': 'text/plain; charset=windows-1251' },
      payload: Buffer.from([0xc8, 0xe2, 0xe0, 0xed]),
    });
    const utf8 = await capture(sessionId, { payload: 'имя=Иван' });
    const pattern = await capture(sessionId, { payload: '100%_\\*\'"; DROP' });
    const matching = (body: string[]) => query(sessionId, { body, order: 'asc' }).then(ids);

    assert.deepEqual(await matching(['"orderId":42']), [order]);
    assert.deepEqual(await matching(['"orderid":42']), []);
    assert.deepEqual(await matching(['"orderId": 42']), [spaced]);
    assert.deepEqual(await matching(['order.paid']), [order, spaced]);
    assert.deepEqual(await matching(['tokBinary']), [binary]);
    assert.deepEqual(await matching(['\u0000tokBinary\u0000']), [binary]);
    // The UTF-8 bytes of the string, not the same characters in windows-1251.
    assert.deepEqual(await matching(['Иван']), [utf8]);
    assert.ok(!(await matching(['Иван'])).includes(cp1251));
    // Pattern characters are themselves.
    assert.deepEqual(await matching(['100%']), [pattern]);
    assert.deepEqual(await matching(['1__%']), []);
    assert.deepEqual(await matching([`*'"; DROP`]), [pattern]);
  });

  it('matches the body as stored, not decoded from Content-Encoding, and not the headers', async () => {
    const sessionId = await newSession();
    const gzipped = await capture(sessionId, {
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-only-here': 'tokHeaderOnly',
      },
      payload: gzipSync(Buffer.from('{"compressed":"tokInsideGzip"}')),
    });

    assert.deepEqual(ids(await query(sessionId, { body: ['tokInsideGzip'] })), []);
    assert.deepEqual(ids(await query(sessionId, { body: ['tokHeaderOnly'] })), []);
    assert.deepEqual(ids(await query(sessionId, { body: ['x-only-here'] })), []);
    assert.deepEqual(
      ids(await query(sessionId, { headers: [{ name: 'content-encoding', value: 'gzip' }] })),
      [gzipped],
    );
  });

  it('combines every condition with AND', async () => {
    const sessionId = await newSession();
    const both = await capture(sessionId, {
      headers: { 'x-merchant-id': '123' },
      payload: '{"orderId":42,"status":"paid"}',
    });

    await capture(sessionId, { headers: { 'x-merchant-id': '123' }, payload: '{"orderId":43}' });
    await capture(sessionId, { headers: { 'x-merchant-id': '999' }, payload: '{"orderId":42}' });

    const merchant = { name: 'x-merchant-id', value: '123' };

    assert.equal((await query(sessionId, { headers: [merchant] })).length, 2);
    assert.equal((await query(sessionId, { body: ['"orderId":42'] })).length, 2);
    assert.deepEqual(ids(await query(sessionId, { headers: [merchant], body: ['"orderId":42'] })), [
      both,
    ]);
    assert.deepEqual(
      ids(
        await query(sessionId, { headers: [merchant], body: ['"orderId":42', '"status":"paid"'] }),
      ),
      [both],
    );
    assert.deepEqual(
      ids(
        await query(sessionId, {
          headers: [merchant],
          body: ['"orderId":42', '"status":"failed"'],
        }),
      ),
      [],
    );
    // With every other parameter beside them.
    const [item] = await query(sessionId, {
      headers: [merchant],
      body: ['"orderId":42'],
      include: ['headers', 'body'],
      limit: 1,
      order: 'asc',
    });

    assert.equal(item?.id, both);
    assert.equal(item?.body, '{"orderId":42,"status":"paid"}');
    assert.ok(item?.headers?.some(([name, value]) => name === 'x-merchant-id' && value === '123'));
  });

  it('answers conditions holding lone surrogates, NUL and Unicode without a 500', async () => {
    const sessionId = await newSession();
    const replaced = await capture(sessionId, { payload: 'a��b' });
    const answers = [
      await queryOn(app, sessionId, '{"headers":[{"name":"x-\\ud800","value":"\\udfff"}]}'),
      await queryOn(app, sessionId, '{"body":["a\\ud800\\udc00\\ud800\\udfffb"]}'),
      await queryOn(app, sessionId, '{"body":["\\u0000\\u0000\\u0000"]}'),
      await queryOn(app, sessionId, { headers: [{ name: 'Ключ-😀', value: 'значение' }] }),
      await queryOn(app, sessionId, { headers: [{ name: 'a', value: 'b\u0000' }] }),
      await queryOn(app, sessionId, '{"body":["a\\ud800\\ud800b"]}'),
    ];

    assert.deepEqual(
      answers.map((answer) => answer.statusCode),
      [200, 200, 200, 200, 400, 200],
    );
    assert.deepEqual(answers[0]?.json(), []);
    // A paired surrogate is the character it encodes, so nothing is found...
    assert.deepEqual(answers[1]?.json(), []);
    // ...and an unpaired one is U+FFFD, as a search word's is (D191).
    assert.deepEqual(ids(answers[5]?.json<RequestListEntry[]>() ?? []), [replaced]);
  });

  it('answers 400 / 1006 for a body holding bytes that are not UTF-8, on every route that reads JSON', async () => {
    const sessionId = await newSession();
    // `0xff` is never UTF-8; `0xc3` before a quote starts a sequence it does not finish.
    const notUtf8 = (before: string, after: string) =>
      Buffer.concat([Buffer.from(before), Buffer.from([0xff, 0xc3]), Buffer.from(after)]);

    for (const [method, url, payload] of [
      ['POST', `/api/sessions/${sessionId}/requests/query`, notUtf8('{"body":["ab', 'c"]}')],
      [
        'POST',
        `/api/sessions/${sessionId}/requests/query`,
        notUtf8('{"headers":[{"name":"x-', '","value":""}]}'),
      ],
      ['POST', `/api/sessions/${sessionId}/requests/search`, notUtf8('{"words":["ab', 'c"]}')],
      ['POST', '/api/sessions', notUtf8('{"response":{"status":200,"body":"', '"}}')],
      [
        'PUT',
        `/api/sessions/${sessionId}/response`,
        notUtf8('{"mode":"custom","response":{"status":200,"body":"', '"}}'),
      ],
    ] as const) {
      const response = await app.inject({ method, url, headers: JSON_HEADERS, payload });

      assert.equal(response.statusCode, 400, `${method} ${url}: ${response.body}`);
      assert.deepEqual(response.json(), {
        errorCode: 1006,
        message: 'Request body must be a JSON object',
      });
    }

    // A byte order mark is kept in the text, so JSON.parse refuses it as before.
    const marked = await queryOn(app, sessionId, Buffer.from('﻿{}', 'utf8'));

    assertError(marked, 400, 1006);
    // And valid UTF-8 beyond ASCII is read as it is.
    assert.equal((await queryOn(app, sessionId, Buffer.from('{"body":["Иван"]}'))).statusCode, 200);
  });

  it('answers every request for no condition, and never one of another session', async () => {
    const sessionId = await newSession();
    const otherSessionId = await newSession();
    const mine = await capture(sessionId, { headers: { 'x-shared': '1' }, payload: 'tokShared' });

    await capture(otherSessionId, { headers: { 'x-shared': '1' }, payload: 'tokShared' });

    assert.deepEqual(ids(await query(sessionId, {})), [mine]);
    assert.deepEqual(ids(await query(sessionId, { body: ['tokShared'] })), [mine]);
    assert.deepEqual(ids(await query(sessionId, { headers: [{ name: 'x-shared', value: '1' }] })), [
      mine,
    ]);
  });

  it('answers the same array as the list for the same parameters', async () => {
    const sessionId = await newSession();

    await storeMany(sessionId, 12, '2026-10-01T09:00:00Z');

    const all = await list(sessionId, 'order=asc');
    const pivot = all[3]?.id as string;

    for (const [parameters, body] of [
      ['', {}],
      ['limit=5', { limit: 5 }],
      ['order=asc&limit=5', { order: 'asc', limit: 5 }],
      [`after=${pivot}&order=asc`, { after: pivot, order: 'asc' }],
      ['since=2026-10-01T09:00:00.001Z', { since: '2026-10-01T09:00:00.001Z' }],
      ['include=headers,body&limit=2', { include: ['headers', 'body'], limit: 2 }],
    ] as const) {
      assert.deepEqual(await query(sessionId, body), await list(sessionId, parameters), parameters);
    }
  });
});

describe('the body of a query (D104, D196)', () => {
  const post = (sessionId: string, headers: Record<string, string>, payload: string | Buffer) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/requests/query`,
      headers,
      payload,
    });

  const refusals: [string, Record<string, string>, string | Buffer, number, number][] = [
    ['a body with no Content-Type', {}, '{}', 415, 1007],
    ['a text/plain body', { 'content-type': 'text/plain' }, '{}', 415, 1007],
    ['a form body', { 'content-type': 'application/x-www-form-urlencoded' }, 'limit=5', 415, 1007],
    ['a JSON body over 1 MiB', JSON_HEADERS, Buffer.alloc(MAX_BODY_BYTES + 1, 0x61), 413, 1004],
    ['an empty JSON body', JSON_HEADERS, '', 400, 1006],
    ['an unparseable JSON body', JSON_HEADERS, '{"limit":', 400, 1006],
    ['a JSON array', JSON_HEADERS, '[]', 400, 1006],
    ['an unknown key', JSON_HEADERS, '{"words":["abc"]}', 400, 1013],
    ['a header condition as a pair', JSON_HEADERS, '{"headers":[["a","b"]]}', 400, 1013],
    ['a body condition of 2 bytes', JSON_HEADERS, '{"body":["ab"]}', 400, 1013],
    ['9 conditions', JSON_HEADERS, JSON.stringify({ body: Array(9).fill('abc') }), 400, 1013],
    ['limit: 0', JSON_HEADERS, '{"limit":0}', 400, 1013],
    ['limit: 21 with bodies', JSON_HEADERS, '{"limit":21,"include":["body"]}', 400, 1013],
    ['order: sideways', JSON_HEADERS, '{"order":"sideways"}', 400, 1013],
    ['include: raw', JSON_HEADERS, '{"include":["raw"]}', 400, 1013],
    ['a since with no zone', JSON_HEADERS, '{"since":"2026-10-04T09:00:00"}', 400, 1013],
    [
      'after with since',
      JSON_HEADERS,
      `{"after":"${randomUUID()}","since":"2026-10-04T09:00:00Z"}`,
      400,
      1013,
    ],
  ];

  for (const [description, headers, payload, status, errorCode] of refusals) {
    it(`answers ${status} / ${errorCode} for ${description}`, async () => {
      const sessionId = await newSession();

      assertError(await post(sessionId, headers, payload), status, errorCode);
    });
  }

  it('accepts a Content-Type with parameters and in any letter case', async () => {
    const sessionId = await newSession();
    const response = await post(
      sessionId,
      { 'content-type': 'Application/JSON; charset=utf-8' },
      '{}',
    );

    assert.equal(response.statusCode, 200, response.body);
  });

  it('checks the body before the session: an invalid body is 400 whatever the session', async () => {
    const expiredId = await newSession();

    await whileExpired(pool, expiredId, async () => {
      for (const sessionId of ['z'.repeat(43), 'not-a-session-id', expiredId]) {
        assertError(await queryOn(app, sessionId, { limit: 0 }), 400, 1013, sessionId);
        assertError(await queryOn(app, sessionId, '[]'), 400, 1006, sessionId);
      }

      // The session it held is the expired one the checks were made against.
      assertError(await queryOn(app, expiredId, {}), 410, 1002);
    });
  });

  it('leaves GET and DELETE on the same path a request id that cannot be one', async () => {
    const sessionId = await newSession();
    const kept = await capture(sessionId, { payload: 'kept' });

    for (const method of ['GET', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: `/api/sessions/${sessionId}/requests/query`,
      });

      assert.deepEqual(response.json(), { errorCode: 1003, message: 'Request not found' }, method);
    }

    assert.deepEqual(ids(await list(sessionId)), [kept]);
  });
});

describe('the parameters of the list (D196)', () => {
  it('answers 400 / 1013 for an unknown, repeated or invalid one, naming it and no value', async () => {
    const sessionId = await newSession();
    const secret = 'Qx7Zv9Kp2Wj4Ym8';

    for (const [parameters, named] of [
      [`header=X-Merchant-ID:${secret}`, 'include, limit, order, after, since and wait'],
      [`${secret}=1`, 'include, limit, order, after, since and wait'],
      ['limit=5&limit=5', 'limit'],
      [`include=${secret}`, 'include'],
      [`limit=${secret}`, 'limit'],
      ['limit=0', 'limit'],
      ['limit=-1', 'limit'],
      ['limit=1.5', 'limit'],
      ['limit=1e3', 'limit'],
      [`order=${secret}`, 'order'],
      [`since=${secret}`, 'since'],
      [`wait=${secret}`, 'wait'],
      ['wait=0', 'wait'],
      ['wait=31', 'wait'],
      ['wait=5&since=2026-10-04T09:00:00Z', 'wait and since'],
    ] as const) {
      const response = await listOn(app, sessionId, parameters);

      assertError(response, 400, 1013, parameters);
      assert.ok(response.json<ApiError>().message.includes(named), response.body);
      assert.ok(!response.body.includes(secret.slice(0, 5)), response.body);
    }
  });

  it('checks the parameters before the session', async () => {
    const expiredId = await newSession();

    await whileExpired(pool, expiredId, async () => {
      for (const sessionId of ['z'.repeat(43), 'not-a-session-id', expiredId]) {
        assertError(await listOn(app, sessionId, 'limit=0'), 400, 1013, sessionId);
      }

      assertError(await listOn(app, expiredId, 'limit=1'), 410, 1002);
    });
  });
});

describe('the session of a list or a query (D067, D133)', () => {
  it('moves no expiry: neither route uses the session', async () => {
    const sessionId = await newSession();
    const requestId = await capture(sessionId, { payload: '{"orderId":42}' });
    const expiry = async (): Promise<number> => {
      const { rows } = await pool.query<{ expires_at: Date }>(
        'SELECT expires_at FROM sessions WHERE id = $1',
        [sessionId],
      );

      return rows[0]?.expires_at.getTime() ?? 0;
    };

    // Two hours back, so a refresh, which moves it at most once an hour (D133),
    // would show.
    await pool.query(
      "UPDATE sessions SET expires_at = expires_at - interval '2 hours' WHERE id = $1",
      [sessionId],
    );

    const moved = await expiry();

    await list(sessionId, 'include=headers,body&order=asc&limit=5');
    await list(sessionId, `after=${requestId}`);
    await list(sessionId, 'since=2026-01-01T00:00:00Z');
    await query(sessionId, { body: ['"orderId":42'], include: ['body'] });
    await query(sessionId, { headers: [{ name: 'content-type', value: 'text/plain' }] });

    assert.equal(await expiry(), moved);
  });

  it('answers 404 / 1001 for a missing session and 410 / 1002 for an expired one, on both routes', async () => {
    const expiredId = await newSession();

    await capture(expiredId, { payload: '{"orderId":42}' });

    for (const sessionId of ['z'.repeat(43), 'short', `${'z'.repeat(42)}.`]) {
      assert.deepEqual((await listOn(app, sessionId, 'include=body')).json(), {
        errorCode: 1001,
        message: 'Session not found',
      });
      assert.deepEqual((await queryOn(app, sessionId, { body: ['"orderId":42'] })).json(), {
        errorCode: 1001,
        message: 'Session not found',
      });
    }

    const expired = await whileExpired(pool, expiredId, async () => [
      await listOn(app, expiredId, 'include=headers,body'),
      await queryOn(app, expiredId, { body: ['"orderId":42'] }),
      await queryOn(app, expiredId, {}),
    ]);

    for (const response of expired) {
      assert.equal(response.statusCode, 410);
      assert.deepEqual(response.json(), { errorCode: 1002, message: 'Session expired' });
    }
  });

  it('holds an expired session against the cleanup while a test reads it', async () => {
    const sessionId = await newSession();
    // The cleanup job's statement, limited to this session and to `wait` of
    // waiting for a lock, in a transaction of its own that `end` closes.
    const sweep = async (wait: string, end: 'COMMIT' | 'ROLLBACK'): Promise<void> => {
      const sweeper = await pool.connect();

      try {
        await sweeper.query('BEGIN');
        await sweeper.query(`SET LOCAL lock_timeout = '${wait}'`);
        await sweeper.query('DELETE FROM sessions WHERE expires_at < now() AND id = $1', [
          sessionId,
        ]);
        await sweeper.query(end);
      } catch (error) {
        await sweeper.query('ROLLBACK');
        throw error;
      } finally {
        sweeper.release();
      }
    };

    await whileExpired(pool, sessionId, async () => {
      await assert.rejects(
        sweep('200ms', 'ROLLBACK'),
        { code: '55P03' },
        'the sweep removed a held session',
      );
      assertError(await listOn(app, sessionId), 410, 1002);
    });

    // Let go, the session is the cleanup's. The sweep removes it, unless the
    // job did first: pg_cron, which `cleanup.test.ts` has run this statement
    // every 5 s, may have waited for the hold too and gone ahead as soon as
    // it ended. Either way the session is gone.
    await sweep('5s', 'COMMIT');

    const left = await pool.query('SELECT 1 FROM sessions WHERE id = $1', [sessionId]);

    assert.equal(left.rowCount, 0, 'the released session is still there after the sweep');
  });

  it('answers 404 / 1001 once the session row is gone, as cleanup leaves it', async () => {
    const sessionId = await newSession();
    const requestId = await capture(sessionId, { payload: 'gone' });

    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

    assertError(await listOn(app, sessionId, `after=${requestId}`), 404, 1001);
    assertError(await queryOn(app, sessionId, { after: requestId }), 404, 1001);
  });
});

describe('a query that runs out of time or finds no slot (D191, D196)', () => {
  it('answers 503 / 1011, and the same query succeeds where it is given its 2 s', async () => {
    const sessionId = await heavySession();
    const cancelled = await queryOn(impatient, sessionId, HEAVY_QUERY);

    assertError(cancelled, 503, 1011);
    assert.deepEqual(cancelled.json(), {
      errorCode: 1011,
      message: 'The search took too long and was cancelled',
    });
    assert.deepEqual(await query(sessionId, HEAVY_QUERY), []);
    // The GET reads no condition and has no timeout of its own.
    assert.equal((await listOn(impatient, sessionId, 'include=body')).statusCode, 200);
  });

  it('gives its slot back and leaves its connection without a timeout', async () => {
    const sessionId = await heavySession();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      assertError(
        await queryOn(impatientSingle, sessionId, HEAVY_QUERY),
        503,
        1011,
        `attempt ${attempt}`,
      );
    }

    const timeout = await singlePool.query<{ statement_timeout: string }>('SHOW statement_timeout');
    const transaction = await singlePool.query<{ open: boolean }>(
      'SELECT now() <> statement_timestamp() AS open',
    );

    assert.equal(timeout.rows[0]?.statement_timeout, '0');
    assert.equal(transaction.rows[0]?.open, false, 'the transaction was left open');
  });

  it('runs two at once and refuses the third with 429 / 1012, sharing the count with searches', async () => {
    const sessionId = await heavySession();
    const otherSessionId = await newSession();
    const searchWords = { words: ['no-such-text-anywhere-0', 'no-such-text-anywhere-1'] };
    const search = () =>
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/requests/search`,
        headers: JSON_HEADERS,
        payload: JSON.stringify(searchWords),
      });

    const queries = await Promise.all([
      queryOn(app, sessionId, HEAVY_QUERY),
      queryOn(app, sessionId, HEAVY_QUERY),
      queryOn(app, sessionId, HEAVY_QUERY),
    ]);

    assert.deepEqual(queries.map((answer) => answer.statusCode).sort(), [200, 200, 429]);
    assert.deepEqual(queries.find((answer) => answer.statusCode === 429)?.json(), {
      errorCode: 1012,
      message: 'Too many searches are running; try again in a moment',
    });

    // Two searches running leave no slot for a query, and the other way round.
    const mixed = await Promise.all([search(), search(), queryOn(app, sessionId, HEAVY_QUERY)]);

    assert.deepEqual(mixed.map((answer) => answer.statusCode).sort(), [200, 200, 429]);

    const reversed = await Promise.all([
      queryOn(app, sessionId, HEAVY_QUERY),
      queryOn(app, sessionId, HEAVY_QUERY),
      search(),
    ]);

    assert.deepEqual(reversed.map((answer) => answer.statusCode).sort(), [200, 200, 429]);

    // The list takes no slot.
    const [one, two, listed] = await Promise.all([
      queryOn(app, sessionId, HEAVY_QUERY),
      queryOn(app, sessionId, HEAVY_QUERY),
      listOn(app, sessionId, 'include=body&limit=2'),
    ]);

    assert.deepEqual([one.statusCode, two.statusCode, listed.statusCode], [200, 200, 200]);

    // The slots came back with the answers.
    assert.deepEqual(await query(otherSessionId, HEAVY_QUERY), []);
  });

  it('takes no slot for a body, a session id or an after it refuses', async () => {
    const sessionId = await heavySession();
    const running = queryOn(app, sessionId, HEAVY_QUERY);
    const refusals = await Promise.all([
      queryOn(app, sessionId, { body: ['ab'] }),
      queryOn(app, 'not-a-session-id', {}),
      queryOn(app, sessionId, { after: 'not-an-id' }),
    ]);
    const second = await queryOn(app, sessionId, {});

    assert.deepEqual(
      refusals.map((answer) => answer.statusCode),
      [400, 404, 404],
    );
    assert.equal(second.statusCode, 200, second.body);
    assert.equal((await running).statusCode, 200);
  });
});

describe('the places of header-only queries (D250)', () => {
  const merchant = { name: 'X-Merchant-ID', value: '123' };
  /** An access key for a keyed session (D245): a session id's shape. */
  const KEY = 'Hq3Lp8Vt2Nc6Xw0Rb4Jm9Fs1Kd7Gy5Ze3Ua8Oi2Tn6x';
  const OTHER_KEY = 'Wn5Bc0Ry7Lp2Sv9Mx4Hd1Kq6Tj3Gz8Ef5Ua0Oi7Pl2y';

  /** Takes every place `slots` has free, and answers what gives them back. */
  function holdAll(slots: Slots): () => void {
    const releases: (() => void)[] = [];

    for (let release = slots.tryTake(); release !== null; release = slots.tryTake()) {
      releases.push(release);
    }

    return () => {
      for (const release of releases) {
        release();
      }
    };
  }

  /** A refusal for want of a place: `429` / `1012`, its whole body, and `Retry-After: 1`. */
  function assertBusy(response: Awaited<ReturnType<FastifyInstance['inject']>>, where: string) {
    assert.equal(response.statusCode, 429, `${where} ${response.body}`);
    assert.deepEqual(
      response.json(),
      { errorCode: 1012, message: 'Too many searches are running; try again in a moment' },
      where,
    );
    assert.equal(response.headers['retry-after'], '1', where);
  }

  function searchOn(server: FastifyInstance, sessionId: string, words: string[]) {
    return server.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/requests/search`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ words }),
    });
  }

  it('answers header conditions alone, {} and {"headers": []} with both search places held, and refuses a body condition 1012 with Retry-After: 1', async () => {
    const sessionId = await newSession();
    const [first, second, third] = (await store(sessionId, [
      {
        headers: [
          ['X-Merchant-ID', '123'],
          ['x-trace', 'a'],
        ],
      },
      { headers: [['x-merchant-id', '456']], body: 'order 42' },
      {
        headers: [
          ['x-merchant-id', '789'],
          ['X-MERCHANT-ID', '123'],
        ],
        body: 'order 42',
      },
    ])) as [string, string, string];
    const releaseSearch = holdAll(querySlots.search);

    try {
      assert.equal(querySlots.search.taken, MAX_CONCURRENT_SEARCHES);
      assert.deepEqual(ids(await query(sessionId, { headers: [merchant] })), [third, first]);
      assert.deepEqual(
        ids(await query(sessionId, { headers: [{ name: 'x-merchant-id', value: '456' }] })),
        [second],
      );

      for (const none of [{}, { headers: [] }, { headers: [], body: [] }, { body: [] }]) {
        assert.deepEqual(
          ids(await query(sessionId, none)),
          [third, second, first],
          JSON.stringify(none),
        );
      }

      // A body condition still takes the search's count, with or without a
      // header condition beside it, and so does the search: the third of three.
      for (const body of [{ body: ['order 42'] }, { headers: [merchant], body: ['order 42'] }]) {
        assertBusy(await queryOn(app, sessionId, body), JSON.stringify(body));
      }

      assertBusy(await searchOn(app, sessionId, ['order 42']), 'the search');
      assert.equal(querySlots.headerOnly.taken, 0);
    } finally {
      releaseSearch();
    }

    // Given back, the same refused ones answer.
    assert.deepEqual(ids(await query(sessionId, { headers: [merchant], body: ['order 42'] })), [
      third,
    ]);
    assert.equal(
      (await searchOn(app, sessionId, ['order 42'])).statusCode,
      200,
      'the search, its places back',
    );
  });

  it(`runs ${MAX_CONCURRENT_HEADER_QUERIES} at once and refuses the next 429 / 1012 with Retry-After: 1, while two searches still run`, async () => {
    const sessionId = await newSession();
    const otherSessionId = await newSession();
    const [match] = (await store(sessionId, [
      { headers: [['x-merchant-id', '123']] },
      { headers: [['x-merchant-id', '456']] },
    ])) as [string];
    const [searched] = (await store(otherSessionId, [{ body: 'order 42' }])) as [string];
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const ask = () => queryOn(hooked, sessionId, { headers: [merchant] });
    const { running, refused, searches } = await withHooks(
      sessionId,
      { beforeList: () => gate },
      async () => {
        const running = Array.from({ length: MAX_CONCURRENT_HEADER_QUERIES }, ask);

        try {
          // Each holds its place, its statement held before it runs.
          await until(
            () => hooks.lists === MAX_CONCURRENT_HEADER_QUERIES,
            'every header-only query in its place',
          );
          assert.equal(hookedSlots.headerOnly.taken, MAX_CONCURRENT_HEADER_QUERIES);

          const refused = [
            await ask(),
            await queryOn(hooked, sessionId, {}),
            await queryOn(hooked, otherSessionId, { headers: [] }),
          ];
          // Every header-only place taken leaves both of the search's.
          const searches = await Promise.all([
            searchOn(hooked, otherSessionId, ['order 42']),
            searchOn(hooked, otherSessionId, ['order 42']),
          ]);

          return { running, refused, searches };
        } finally {
          open();
        }
      },
    );

    refused.forEach((answer, index) => assertBusy(answer, `refused ${index}`));

    for (const answer of searches) {
      assert.equal(answer.statusCode, 200, answer.body);
      assert.deepEqual(answer.json(), { matches: [[searched]] });
    }

    for (const answer of await Promise.all(running)) {
      assert.equal(answer.statusCode, 200, answer.body);
      assert.deepEqual(ids(answer.json<RequestListEntry[]>()), [match]);
    }

    assert.deepEqual([hookedSlots.search.taken, hookedSlots.headerOnly.taken], [0, 0]);
  });

  it('stops a header-only query at its timeout: 503 / 1011, its place given back, no transaction left open', async () => {
    const sessionId = await heavyHeaderSession();

    assertError(await queryOn(impatient, sessionId, HEAVY_HEADER_QUERY), 503, 1011);
    // The same query, given its 2 s, finds nothing.
    assert.deepEqual(await query(sessionId, HEAVY_HEADER_QUERY), []);

    // One more than the places: each was given back.
    for (let attempt = 0; attempt <= MAX_CONCURRENT_HEADER_QUERIES; attempt += 1) {
      assertError(
        await queryOn(impatientSingle, sessionId, HEAVY_HEADER_QUERY),
        503,
        1011,
        `attempt ${attempt}`,
      );
    }

    const timeout = await singlePool.query<{ statement_timeout: string }>('SHOW statement_timeout');
    const transaction = await singlePool.query<{ open: boolean }>(
      'SELECT now() <> statement_timestamp() AS open',
    );

    assert.equal(timeout.rows[0]?.statement_timeout, '0');
    assert.equal(transaction.rows[0]?.open, false, 'the transaction was left open');
  });

  it('resumes a header-only answer whose chosen requests were deleted in the header-only count, and ends it whole', async () => {
    for (const include of INCLUDES) {
      const where = include.join(',');
      const sessionId = await newSession();
      const [m0, , m1, m2] = (await store(sessionId, [
        { headers: [['x-merchant-id', '123']], body: 'm0' },
        { headers: [['x-merchant-id', '456']], body: 'other' },
        { headers: [['X-Merchant-ID', '123']], body: 'm1' },
        { headers: [['x-merchant-id', '123']], body: 'm2' },
        { headers: [['x-merchant-id', '123']], body: 'm3' },
      ])) as [string, string, string, string];
      const during: number[][] = [];
      const releaseSearch = holdAll(hookedSlots.search);
      let answer: RequestListEntry[];

      try {
        answer = await withHooks(
          sessionId,
          {
            beforeContentRead: async (requestIds) => {
              if (requestIds.includes(m0)) {
                await deleteRequests([m0]);
              }
            },
            beforeResume: async () => {
              during.push([hookedSlots.search.taken, hookedSlots.headerOnly.taken]);
            },
          },
          () =>
            answerHooked('POST', sessionId, {
              order: 'asc',
              include,
              limit: 2,
              headers: [merchant],
            }),
        );
      } finally {
        releaseSearch();
      }

      // A whole array: the next matching request in the deleted one's place,
      // read by a resumption in a header-only place while both of the
      // search's were held.
      assert.deepEqual(ids(answer), [m1, m2], where);
      assert.deepEqual(during, [[MAX_CONCURRENT_SEARCHES, 1]], where);
      assert.equal(hookedSlots.headerOnly.taken, 0, where);
    }
  });

  it('answers what it wrote when the session is removed during a header-only answer', async () => {
    for (const include of INCLUDES) {
      const sessionId = await newSession();
      const all = await store(
        sessionId,
        Array.from({ length: 5 }, (_, index) => ({
          headers: [['x-merchant-id', '123']] as [string, string][],
          body: `m${index}`,
        })),
      );
      const releaseSearch = holdAll(hookedSlots.search);
      let answer: RequestListEntry[];

      try {
        answer = await withHooks(
          sessionId,
          {
            beforeContentRead: async (requestIds) => {
              if (requestIds.includes(all[1] as string)) {
                await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
              }
            },
          },
          () =>
            answerHooked('POST', sessionId, {
              order: 'asc',
              include,
              limit: 3,
              headers: [merchant],
            }),
        );
      } finally {
        releaseSearch();
      }

      assert.deepEqual(ids(answer), include.includes('body') ? [all[0]] : [], include.join(','));
      assert.equal(hookedSlots.headerOnly.taken, 0);
    }
  });

  it('pages with after, and answers 404 / 1003 for an after naming a deleted request, its place given back', async () => {
    const sessionId = await newSession();
    const [m0, , m1, m2] = (await store(sessionId, [
      { headers: [['x-merchant-id', '123']] },
      { headers: [['x-merchant-id', '456']] },
      { headers: [['x-merchant-id', '123']] },
      { headers: [['x-merchant-id', '123']] },
    ])) as [string, string, string, string];
    const releaseSearch = holdAll(querySlots.search);

    try {
      const asked = { headers: [merchant], order: 'asc', limit: 2 };

      assert.deepEqual(ids(await query(sessionId, asked)), [m0, m1]);
      assert.deepEqual(ids(await query(sessionId, { ...asked, after: m1 })), [m2]);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${sessionId}/requests/${m1}`,
      });

      assert.equal(deleted.statusCode, 204);
      assertError(await queryOn(app, sessionId, { ...asked, after: m1 }), 404, 1003);
      assert.equal(querySlots.headerOnly.taken, 0);
    } finally {
      releaseSearch();
    }
  });

  it('checks a keyed session’s key once a place is taken: 429 / 1012 first, then 404 / 1001, and 200 with its key (D245)', async () => {
    const sessionId = await newSession();
    const [match] = (await store(sessionId, [{ headers: [['x-merchant-id', '123']] }])) as [string];

    await pool.query('UPDATE sessions SET access_key_hash = $2 WHERE id = $1', [
      sessionId,
      fingerprintOf(KEY),
    ]);

    const keyed = (authorization?: string) =>
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/requests/query`,
        headers: { ...JSON_HEADERS, ...(authorization === undefined ? {} : { authorization }) },
        payload: JSON.stringify({ headers: [merchant] }),
      });
    const releaseHeaderOnly = holdAll(querySlots.headerOnly);

    try {
      assertBusy(await keyed(), 'no key, every place taken');
      assertBusy(await keyed(`Bearer ${OTHER_KEY}`), 'another key, every place taken');
      assertBusy(await keyed(`Bearer ${KEY}`), 'its key, every place taken');
    } finally {
      releaseHeaderOnly();
    }

    const releaseSearch = holdAll(querySlots.search);

    try {
      assertError(await keyed(), 404, 1001, 'no key');
      assertError(await keyed(`Bearer ${OTHER_KEY}`), 404, 1001, 'another key');

      const opened = await keyed(`Bearer ${KEY}`);

      assert.equal(opened.statusCode, 200, opened.body);
      assert.deepEqual(ids(opened.json<RequestListEntry[]>()), [match]);
      assert.equal(querySlots.headerOnly.taken, 0);
    } finally {
      releaseSearch();
    }
  });

  it('compares pathological values whole and exactly, and refuses a NUL or a broken body before taking a place', async () => {
    const sessionId = await newSession();
    const [percent, , underscore, , backslash, , quoted, latin1, , named, kelvinValue] =
      (await store(sessionId, [
        { headers: [['x-v', '%']] },
        { headers: [['x-v', 'a%b']] },
        { headers: [['x-v', '_']] },
        { headers: [['x-v', 'ab']] },
        { headers: [['x-v', '\\']] },
        { headers: [['x-v', '\\\\']] },
        { headers: [['x-v', '"quoted"']] },
        { headers: [['x-v', 'café']] },
        { headers: [['x-v', 'cafe']] },
        {
          headers: [
            ['K-Id', 'kelvin'],
            ['iD', 'dotless'],
          ],
        },
        { headers: [['x-v', 'K']] },
      ])) as string[];
    const matching = async (headers: { name: string; value: string }[]) =>
      ids(await query(sessionId, { headers }));
    const releaseSearch = holdAll(querySlots.search);

    try {
      // Bound parameters compared with `=`: no pattern, no escape.
      assert.deepEqual(await matching([{ name: 'x-v', value: '%' }]), [percent]);
      assert.deepEqual(await matching([{ name: 'x-v', value: '_' }]), [underscore]);
      assert.deepEqual(await matching([{ name: 'x-v', value: '\\' }]), [backslash]);
      assert.deepEqual(await matching([{ name: 'x-v', value: '"quoted"' }]), [quoted]);
      assert.deepEqual(await matching([{ name: 'X-V', value: 'café' }]), [latin1]);
      assert.deepEqual(await matching([{ name: 'x-v', value: 'CAFÉ' }]), []);
      // Names fold in ASCII alone: the Kelvin sign and `İ` are not `k` and `i`.
      assert.deepEqual(await matching([{ name: 'k-ID', value: 'kelvin' }]), [named]);
      assert.deepEqual(await matching([{ name: 'K-Id', value: 'kelvin' }]), []);
      assert.deepEqual(await matching([{ name: 'ID', value: 'dotless' }]), [named]);
      assert.deepEqual(await matching([{ name: 'İD', value: 'dotless' }]), []);
      assert.deepEqual(await matching([{ name: 'x-v', value: 'K' }]), []);
      assert.deepEqual(await matching([{ name: 'x-v', value: 'K' }]), [kelvinValue]);
      // Eight identical conditions are one.
      assert.deepEqual(
        await matching(Array.from({ length: 8 }, () => ({ name: 'x-v', value: '%' }))),
        [percent],
      );
      // A lone surrogate is a value no stored header has.
      assert.deepEqual(
        (await query(sessionId, '{"headers":[{"name":"x-v","value":"\\ud800"}]}')).length,
        0,
      );
      assert.equal(querySlots.headerOnly.taken, 0);
    } finally {
      releaseSearch();
    }

    const releaseHeaderOnly = holdAll(querySlots.headerOnly);

    try {
      // Every place taken, a body it refuses is still its refusal, not 1012.
      const nested = '['.repeat(100_000) + ']'.repeat(100_000);

      assertError(
        await queryOn(app, sessionId, { headers: [{ name: 'x-v', value: 'a\u0000' }] }),
        400,
        1013,
        'a NUL',
      );
      assertError(await queryOn(app, sessionId, { headers: [{ name: 'x-v' }] }), 400, 1013);
      assertError(await queryOn(app, sessionId, nested), 400, 1006, 'deep nesting');
      assertError(await queryOn(app, 'not-a-session-id', { headers: [merchant] }), 404, 1001);
      assertBusy(await queryOn(app, sessionId, { headers: [merchant] }), 'a valid one');
      assert.equal(querySlots.headerOnly.taken, MAX_CONCURRENT_HEADER_QUERIES);
    } finally {
      releaseHeaderOnly();
    }
  });
});

describe('what a list or a query leaves in the log (D196)', () => {
  /** Values made only for this test, so any piece of one in the log came from a condition. */
  const VALUES = ['Qx7Zv9Kp2Wj4Ym8', 'Hb3Nf6Rt1Lc5Dg0', 'Uw8Ej2Sa7Io4Pz6', 'Mz5Tq1Xc8Vb3Nn7'];
  const PIECE = 5;

  function pieces(value: string): string[] {
    return Array.from({ length: value.length - PIECE + 1 }, (_, at) => value.slice(at, at + PIECE));
  }

  it('holds no piece of any condition: successful and refused, on both routes', async () => {
    const [name, value, body, other] = VALUES as [string, string, string, string];
    const sessionId = await newSession();
    const heavyId = await heavySession();
    const expiredId = await newSession();
    const from = logChunks.length;
    const requestId = await capture(sessionId, {
      headers: { [name.toLowerCase()]: value },
      payload: `order ${body}`,
    });
    const header = { name, value };

    // Successful, with and without a match, on both routes.
    assert.deepEqual(ids(await query(sessionId, { headers: [header], body: [body] })), [requestId]);
    assert.deepEqual(
      ids(await query(sessionId, { headers: [{ name, value: other }], body: [other] })),
      [],
    );
    assert.equal((await list(sessionId, 'include=headers,body')).length, 1);
    assert.equal((await list(sessionId, `order=asc&limit=5&after=${requestId}`)).length, 0);

    // Refused, in every way a condition can reach a refusal.
    const refused = await Promise.all([
      queryOn(app, sessionId, { headers: [{ name: name.repeat(20), value }] }),
      queryOn(app, sessionId, { headers: [{ name, value: value.repeat(20) }] }),
      queryOn(app, sessionId, { headers: [{ name, value: `${value}\u0000` }] }),
      queryOn(app, sessionId, { headers: [{ name, value, [other]: other }] }),
      queryOn(app, sessionId, { body: [body.repeat(20)] }),
      queryOn(app, sessionId, { body: Array(9).fill(body) }),
      queryOn(app, sessionId, { body: [body], [other]: value }),
      queryOn(app, sessionId, { body: [body], limit: other }),
      queryOn(app, sessionId, { body: [body], since: other }),
      queryOn(app, sessionId, { body: [body], after: other }),
      queryOn(app, sessionId, `{"body":["${body}"`),
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/requests/query`,
        headers: { 'content-type': 'text/plain' },
        payload: JSON.stringify({ body: [body] }),
      }),
      queryOn(app, sessionId, { body: [body], padding: 'x'.repeat(MAX_BODY_BYTES) }),
      queryOn(app, 'z'.repeat(43), { headers: [header], body: [body] }),
    ]);

    assert.deepEqual(
      refused.map((answer) => answer.statusCode),
      [400, 400, 400, 400, 400, 400, 400, 400, 400, 404, 400, 415, 413, 404],
    );

    // Refused for an expired session, on both routes.
    const expired = await whileExpired(pool, expiredId, () =>
      Promise.all([
        queryOn(app, expiredId, { headers: [header], body: [body] }),
        listOn(app, expiredId, 'include=body'),
      ]),
    );

    assert.deepEqual(
      expired.map((answer) => answer.statusCode),
      [410, 410],
    );

    // Timed out, and refused for want of a slot.
    const cancelled = await queryOn(impatient, heavyId, { body: [body, ...HEAVY_QUERY.body] });

    assert.equal(cancelled.statusCode, 503, cancelled.body);

    const atOnce = await Promise.all(
      [0, 1, 2].map(() => queryOn(app, heavyId, { body: [...HEAVY_QUERY.body, body] })),
    );

    assert.deepEqual(atOnce.map((answer) => answer.statusCode).sort(), [200, 200, 429]);

    // The list's refusals: the parameters are in its URL, which is logged, but
    // none of them is a condition.
    const listRefused = await Promise.all([
      listOn(app, sessionId, 'limit=0'),
      listOn(app, sessionId, 'order=sideways&include=body'),
      listOn(app, sessionId, 'include=body&limit=21'),
      listOn(app, sessionId, 'after=not-an-id'),
      listOn(app, 'z'.repeat(43), 'include=body'),
    ]);

    assert.deepEqual(
      listRefused.map((answer) => answer.statusCode),
      [400, 400, 400, 404, 404],
    );

    const log = logChunks.slice(from).join('');

    // The log is the real one: it has a line for each kind of request.
    assert.ok(log.includes('/requests/query'), 'the log holds no query');
    assert.ok(log.includes('/requests?include=headers,body'), 'the log holds no list');
    assert.ok(log.includes('"statusCode":503'), 'the log holds no timed-out query');
    assert.ok(log.includes('"statusCode":429'), 'the log holds no refused query');
    assert.ok(log.includes('"statusCode":400'), 'the log holds no invalid query');
    assert.ok(log.includes('"statusCode":410'), 'the log holds no expired session');

    for (const one of VALUES) {
      for (const piece of pieces(one)) {
        assert.ok(!log.includes(piece), `the log holds "${piece}", a piece of a condition`);
      }
    }

    // Nor any answer: an error body repeats no condition either.
    for (const answer of [
      ...refused,
      ...expired,
      cancelled,
      ...atOnce.filter((one) => one.statusCode !== 200),
    ]) {
      for (const one of VALUES) {
        assert.ok(!answer.body.includes(one.slice(0, PIECE)), answer.body);
      }
    }
  });

  it('logs a value sent to the list in its URL there and nowhere else', async () => {
    const sessionId = await newSession();
    const secret = 'Wq4Rb8Yt2Kd6Lm1';
    const from = logChunks.length;
    const answers = await Promise.all([
      listOn(app, sessionId, `limit=${secret}`),
      listOn(app, sessionId, `header=x-merchant-id:${secret}`),
      listOn(app, sessionId, `since=${secret}`),
    ]);

    assert.deepEqual(
      answers.map((answer) => answer.statusCode),
      [400, 400, 400],
    );

    const lines = logChunks
      .slice(from)
      .join('')
      .split('\n')
      .filter((line) => line.includes(secret.slice(0, PIECE)));

    // The URL is logged as it arrived (D117, D168), so the value is there,
    // once per request, in the request's `url` and in no message.
    assert.equal(lines.length, answers.length);

    for (const line of lines) {
      const parsed = JSON.parse(line) as { req?: { url?: string }; msg?: string };

      assert.ok(parsed.req?.url?.includes(secret), line);
      assert.ok(!parsed.msg?.includes(secret.slice(0, PIECE)), line);
    }
  });
});
