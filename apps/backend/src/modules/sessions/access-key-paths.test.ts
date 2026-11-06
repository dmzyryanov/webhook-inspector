/**
 * Every path that reads or changes a session, walked against a keyed session
 * (D245, issue #98): each operation of `packages/shared/openapi.json`
 * whose path takes a session id, `POST /api/sessions/status`, every MCP tool
 * of `MCP_TOOLS` that takes a `sessionId`, and `/ws/:sessionId`.
 *
 * The lists are read from the description and the tools' definitions, not
 * written here, so a path or a tool added later is walked as it is added, and
 * fails here until it checks the key. A path that takes a session id some
 * other way than in its own path fails the census below until it is walked.
 *
 * Without a key and with another, a keyed session answers exactly what a
 * session that does not exist answers, and nothing of it changes - its row,
 * its expiry, which every refused call leaves where a use would have moved it,
 * its requests and its events. With its key it answers what a
 * public session answers, and so does a public session sent any key.
 *
 * Tests make a keyed session by writing the fingerprint straight to the row,
 * which reaches every state a session can be in; the walk of the description's
 * operations runs once more against a session created private through
 * `POST /api/sessions` (D253, #227), with the same answers.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  REALTIME_ACCESS_KEY_PROTOCOL_PREFIX,
  REALTIME_PROTOCOL,
  SESSION_ID_PATTERN,
  WsCloseCode,
} from '@webhook-inspector/shared';
import { mcpTools } from '@webhook-inspector/shared/mcp';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { whileExpired, withExpiredSession } from '../../testing/expired-session.ts';
import { ordinaryFullQueue, ordinaryFullResponse } from '../../testing/full-queue.ts';
import { closeSockets, refused, until, watchUrl } from '../../testing/realtime.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import type { RealtimeHub } from '../realtime/hub.ts';
import { fingerprintOf, SESSION_ACCESS_SQL } from './access-key.ts';

const APP_ORIGIN = 'https://qa-tools.example';
const RECEIVE_ORIGIN = 'https://hook.qa-tools.example';
const MCP_TOOLS = mcpTools(RECEIVE_ORIGIN);
const SPEC = JSON.parse(
  readFileSync(new URL('../../../../../packages/shared/openapi.json', import.meta.url), 'utf8'),
) as Spec;

/** The key the keyed sessions here carry, and another of the same shape. */
const KEY = 'Qx7Zv9Kp2Wj4Ym8Hb3Nf6Rt1Lc5Dg0Uw8Ej2Sa7Io4P';
const OTHER = 'Lm3Nb8Vc1Xz6As9Df2Gh5Jk0Pq7Wr4Ty8Ui1Op3Ea6S';
/** A well-formed id no session has, and a request id no request has. */
const MISSING = 'Mz8Kq2Wx7Pn4Vb1Lc6Hj3Rt9Fd5Sg0Ya2Ue7Io4TmNq';
const MISSING_REQUEST = '3f8a1b20-0000-4000-8000-000000000000';

/** Every `Authorization` a refused call is made with: none, another key, and keys that are none. */
const REFUSED_AUTHORIZATIONS: (string | undefined)[] = [
  undefined,
  `Bearer ${OTHER}`,
  'Bearer',
  'Bearer ',
  `Basic ${KEY}`,
  `Bearer ${KEY}x`,
  `Bearer ${KEY.slice(1)}`,
  `Bearer ${KEY.toLowerCase()}`,
  KEY,
];

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};

interface Spec {
  paths: Record<string, PathItem>;
}

type PathItem = Record<string, unknown> & { servers?: unknown };

interface SpecOperation {
  requestBody?: {
    content?: Record<string, { example?: unknown; examples?: Record<string, { value: unknown }> }>;
  };
}

/** One operation of the description, as the walk calls it. */
interface Operation {
  method: string;
  path: string;
  body: unknown;
}

const METHODS = ['get', 'head', 'put', 'post', 'patch', 'delete', 'options', 'trace'];

/**
 * The description's operations: those whose path takes a session id on the
 * API's own host, each with its first JSON example as its body, and `HEAD`
 * beside every `GET`, which Fastify answers through the same route; the
 * operations whose path takes none; and the paths served on another host.
 */
function census(): { scoped: Operation[]; unscoped: string[]; elsewhere: string[] } {
  const scoped: Operation[] = [];
  const unscoped: string[] = [];
  const elsewhere: string[] = [];

  for (const [path, item] of Object.entries(SPEC.paths)) {
    if (item.servers !== undefined) {
      elsewhere.push(path);
      continue;
    }

    for (const method of METHODS) {
      const operation = item[method] as SpecOperation | undefined;

      if (operation === undefined) {
        continue;
      }

      if (!path.includes('{sessionId}')) {
        unscoped.push(`${method.toUpperCase()} ${path}`);
        continue;
      }

      const json = operation.requestBody?.content?.['application/json'];
      const example = json?.example ?? Object.values(json?.examples ?? {})[0]?.value;

      if (operation.requestBody !== undefined && example === undefined) {
        throw new Error(
          `${method.toUpperCase()} ${path} has a body and no example to walk it with`,
        );
      }

      scoped.push({ method: method.toUpperCase(), path, body: example });

      if (method === 'get' && item.head === undefined) {
        scoped.push({ method: 'HEAD', path, body: undefined });
      }
    }
  }

  return { scoped, unscoped, elsewhere };
}

const CENSUS = census();

/** The MCP tools that take a session id, and the arguments each is walked with. */
const SESSION_TOOLS = MCP_TOOLS.filter((tool) =>
  Object.hasOwn(
    (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    'sessionId',
  ),
);

let pool: pg.Pool;
let servers: TestServers;
let app: FastifyInstance;
let receiver: FastifyInstance;
let port: number;
const logLines: string[] = [];
const createdSessionIds: string[] = [];
/**
 * A statement the servers sent on the pool while `recording`, and the columns
 * its answer carried once it arrived: what the server read of a session.
 */
interface Recorded {
  text: string;
  columns: string[] | undefined;
}

/** The statements sent while `recording`, for what a refusal reads. */
const recorded: Recorded[] = [];
let recording = false;
/**
 * Called with each statement sent on the pool while `recording`, right before
 * it is sent, with its values: how a test makes something happen at a given
 * point of a path, as the socket's second lookup below needs.
 */
let beforeSent: ((text: string, values: unknown) => void) | undefined;

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);

    const watched = new Proxy(pool, {
      get(target, property, receiver) {
        if (property === 'query') {
          return (...args: unknown[]) => {
            if (recording && typeof args[0] === 'string') {
              beforeSent?.(args[0], args[1]);
            }

            const result = (target.query as (...given: unknown[]) => unknown).apply(target, args);

            if (recording && typeof args[0] === 'string') {
              const entry: Recorded = { text: args[0], columns: undefined };

              recorded.push(entry);

              // Settled before the caller's own `await` resumes, which was
              // attached after this.
              if (result instanceof Promise) {
                void (result as Promise<pg.QueryResult>).then(
                  (answer) => {
                    entry.columns = answer.fields.map((field) => field.name);
                  },
                  () => undefined,
                );
              }
            }

            return result;
          };
        }

        const value = Reflect.get(target, property, receiver) as unknown;

        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });

    servers = buildTestServers(watched, {
      appOrigin: APP_ORIGIN,
      receiveOrigin: RECEIVE_ORIGIN,
      rateLimits: LIMITS_OUT_OF_REACH,
      logDestination: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          logLines.push(chunk.toString('utf8'));
          callback();
        },
      }),
    });
    ({ api: app, receiver } = servers);
    await servers.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();

    assert.ok(address !== null && typeof address === 'object');
    port = address.port;
  })();
  await startup;
});

after(async () => {
  await startup?.catch(() => undefined);
  closeSockets();

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers?.close();
  await pool?.end();
});

interface Walked {
  id: string;
  requestId: string;
}

/**
 * Captures the walk's request for `sessionId`, a session holding none yet -
 * the capture never asks for a key - and answers its id once the record of
 * its answer is complete.
 */
async function capture(sessionId: string): Promise<string> {
  const captured = await receiver.inject({
    method: 'POST',
    url: `/s/${sessionId}/orders?ref=1`,
    headers: { 'content-type': 'application/json', 'x-trace': 'walk' },
    payload: '{"order":42,"note":"walk"}',
  });

  assert.equal(captured.statusCode, 200, captured.body);

  // The record of its answer is completed once the answer has been written
  // (D109): settled here, so that nothing changes the session after.
  await servers.writes.settled();

  const request = await pool.query<{ id: string }>(
    'SELECT id::text FROM requests WHERE session_id = $1',
    [sessionId],
  );

  return request.rows[0]?.id as string;
}

/**
 * A session holding one captured request - none when `empty`, its request id
 * then one no request has - its expiry moved back to two days from now so
 * that any use would move it a full window ahead again (D133), keyed with
 * `key` when one is given: its fingerprint written to the row, or, with
 * `throughApi`, the session created private under `key` by
 * `POST /api/sessions` (D253), which writes it.
 */
async function session(
  key: string | null = null,
  { empty = false, throughApi = false } = {},
): Promise<Walked> {
  const created =
    throughApi && key !== null
      ? await app.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          payload: '{"private":true}',
        })
      : await app.inject({ method: 'POST', url: '/api/sessions' });

  assert.equal(created.statusCode, 201, created.body);

  const { id, private: isPrivate } = created.json<{ id: string; private: boolean }>();

  createdSessionIds.push(id);
  assert.equal(isPrivate, throughApi && key !== null);

  const requestId = empty ? MISSING_REQUEST : await capture(id);

  if (throughApi) {
    await pool.query(
      `UPDATE sessions SET expires_at = clock_timestamp() + interval '2 days' WHERE id = $1`,
      [id],
    );
  } else {
    await pool.query(
      `UPDATE sessions
          SET expires_at = clock_timestamp() + interval '2 days',
              access_key_hash = $2
        WHERE id = $1`,
      [id, key === null ? null : fingerprintOf(key)],
    );
  }

  return { id, requestId };
}

/**
 * Runs `action`, counting the subscribers registered with the hub for
 * `sessionId` meanwhile - those removed again before it ended among them,
 * which `countFor` afterwards no longer sees. A wait subscribes before its
 * first read (`waitForList`), so one that subscribed is counted here even
 * where that read answers at once.
 */
async function subscribing<T>(
  sessionId: string,
  action: () => Promise<T>,
): Promise<{ answer: T; subscribed: number }> {
  const hub = servers.hub;
  let subscribed = 0;

  for (const method of ['add', 'hold'] as const) {
    const registers = hub[method].bind(hub);

    hub[method] = (...args: Parameters<RealtimeHub['add']>) => {
      if (args[0] === sessionId) {
        subscribed += 1;
      }

      registers(...args);
    };
  }

  try {
    const answer = await action();

    return { answer, subscribed };
  } finally {
    // The prototype's methods again.
    Reflect.deleteProperty(hub, 'add');
    Reflect.deleteProperty(hub, 'hold');
  }
}

/** Everything a call could change of a session, as the database holds it. */
async function snapshot(sessionId: string): Promise<unknown> {
  const result = await pool.query(
    `SELECT (SELECT to_jsonb(s) FROM sessions s WHERE s.id = $1) AS session,
            (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)
               FROM requests r WHERE r.session_id = $1) AS requests,
            (SELECT coalesce(jsonb_agg(to_jsonb(rr) ORDER BY rr.request_id), '[]'::jsonb)
               FROM request_responses rr JOIN requests r ON r.id = rr.request_id
              WHERE r.session_id = $1) AS responses`,
    [sessionId],
  );

  return result.rows[0];
}

/** The outbox's newest row now: what a call writes for any session is above it. */
async function outboxMark(): Promise<string> {
  const result = await pool.query<{ mark: string }>(
    'SELECT coalesce(max(id), 0)::text AS mark FROM realtime_events',
  );

  return result.rows[0]?.mark as string;
}

async function eventsSince(sessionId: string, mark: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM realtime_events WHERE session_id = $1 AND id > $2',
    [sessionId, mark],
  );

  return result.rows[0]?.count as number;
}

/** What a client can see of an answer: its status, its body and the headers that describe it. */
interface Answer {
  status: number;
  body: string;
  contentType: string | undefined;
  allow: string | undefined;
}

async function call(
  operation: Operation,
  target: Walked,
  authorization: string | undefined,
): Promise<Answer> {
  const url = operation.path
    .replace('{sessionId}', target.id)
    .replace('{requestId}', target.requestId);
  const headers: Record<string, string> = {};

  if (operation.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  if (authorization !== undefined) {
    headers.authorization = authorization;
  }

  const response = await app.inject({
    method: operation.method as 'GET',
    url,
    headers,
    ...(operation.body === undefined ? {} : { payload: JSON.stringify(operation.body) }),
  });

  return {
    status: response.statusCode,
    body: response.body,
    contentType: response.headers['content-type'] as string | undefined,
    allow: response.headers.allow as string | undefined,
  };
}

/** The shape of a JSON answer - its keys, at every depth, and the type of each value. */
function shape(body: string): unknown {
  if (body === '') {
    return '';
  }

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk);
    }

    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, walk(inner)] as const),
      );
    }

    return value === null ? 'null' : typeof value;
  };

  return walk(JSON.parse(body) as unknown);
}

function label(operation: Operation): string {
  return `${operation.method} ${operation.path}`;
}

describe('the census: every path that takes a session id is walked (D245)', () => {
  it('walks with ids and keys of the right shape, so that nothing is refused for its shape', () => {
    for (const value of [KEY, OTHER, MISSING]) {
      assert.match(value, SESSION_ID_PATTERN);
    }
  });

  it('finds the paths with a session id in the description, and no other way to name a session', () => {
    assert.ok(CENSUS.scoped.length >= 13, `${CENSUS.scoped.length} operations`);
    // A path that takes a session id some other way - in its body, as the
    // status read does - is walked by a test of its own below, and one added
    // later fails here until it is.
    assert.deepEqual(CENSUS.unscoped.sort(), ['POST /api/sessions', 'POST /api/sessions/status']);
    // The receive host's capture, which never asks for a key, is tested below
    // too.
    assert.deepEqual(CENSUS.elsewhere, ['/s/{sessionId}']);
  });

  it('finds the MCP tools that take a session id: every tool but create_session', () => {
    assert.deepEqual(
      MCP_TOOLS.filter((tool) => !SESSION_TOOLS.includes(tool)).map((tool) => tool.name),
      ['create_session'],
    );
  });
});

/**
 * One operation walked against a keyed session: refused as a missing session
 * without its key and with each value that is not its key, changing nothing
 * and announcing nothing; answered as a public session with its key.
 */
async function walkOperation(operation: Operation, throughApi: boolean): Promise<void> {
  const keyed = await session(KEY, { throughApi });
  const missing = await call(operation, { id: MISSING, requestId: MISSING_REQUEST }, undefined);

  // What a session that does not exist is answered (D058).
  assert.equal(missing.status, 404, `${label(operation)}: ${missing.body}`);

  if (operation.method !== 'HEAD') {
    assert.equal(JSON.parse(missing.body).errorCode, 1001, missing.body);
  }

  const before = await snapshot(keyed.id);
  const mark = await outboxMark();

  for (const authorization of REFUSED_AUTHORIZATIONS) {
    const refusedAnswer = await call(operation, keyed, authorization);

    assert.deepEqual(
      refusedAnswer,
      missing,
      `${label(operation)} with ${authorization ?? 'no Authorization'}`,
    );
    assert.deepEqual(
      await snapshot(keyed.id),
      before,
      `${label(operation)} with ${authorization ?? 'no Authorization'} changed the session`,
    );
  }

  // A key in the URL is no key: nothing reads one there (D168). The list
  // refuses a parameter it does not know before the session is looked
  // up, `400`, for a missing session alike.
  const withQuery = { ...operation, path: `${operation.path}?accessKey=${KEY}` };
  const inQuery = await call(withQuery, keyed, undefined);

  assert.deepEqual(
    inQuery,
    await call(withQuery, { id: MISSING, requestId: MISSING_REQUEST }, undefined),
    `${label(operation)} with the key in its query string`,
  );
  assert.ok(inQuery.status >= 400, `${label(operation)} opened by a key in the URL`);
  assert.deepEqual(await snapshot(keyed.id), before);

  await servers.flush();
  assert.equal(await eventsSince(keyed.id, mark), 0, `${label(operation)} announced a refusal`);

  // With its key, as a public session is answered; a public session sent
  // any key, as it always was.
  const plain = await session();
  const plainWithKey = await session();
  const today = await call(operation, plain, undefined);
  const opened = await call(operation, keyed, `Bearer ${KEY}`);
  const ignored = await call(operation, plainWithKey, `Bearer ${OTHER}`);

  assert.ok(today.status < 300, `${label(operation)} on a public session: ${today.body}`);

  for (const [what, answer] of [
    ['the keyed session with its key', opened],
    ['a public session sent another key', ignored],
  ] as const) {
    assert.equal(answer.status, today.status, `${label(operation)}, ${what}: ${answer.body}`);
    assert.deepEqual(shape(answer.body), shape(today.body), `${label(operation)}, ${what}`);
    assert.equal(answer.contentType, today.contentType, `${label(operation)}, ${what}`);
  }
}

describe('every operation of the description with a session id, against a keyed session (D245)', () => {
  for (const operation of CENSUS.scoped) {
    it(`${label(operation)}: refused as a missing session without its key, answered as today with it`, async () => {
      await walkOperation(operation, false);
    });
  }
});

describe('every operation of the description with a session id, against a session created private through POST /api/sessions (D253, #227 criterion 5)', () => {
  for (const operation of CENSUS.scoped) {
    it(`${label(operation)}: the same answers as for the keyed session above`, async () => {
      await walkOperation(operation, true);
    });
  }
});

/** Calls a tool over `/mcp`, with `authorization` when given, and answers the JSON-RPC answer. */
async function tool(
  name: string,
  args: Record<string, unknown>,
  authorization?: string,
): Promise<{ status: number; body: { result?: { isError?: boolean } } & Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: authorization === undefined ? MCP_HEADERS : { ...MCP_HEADERS, authorization },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  return { status: response.statusCode, body: response.json() };
}

/** The arguments a tool is walked with: each it requires, from `target`. */
function argumentsFor(
  definition: (typeof MCP_TOOLS)[number],
  target: Walked,
): Record<string, unknown> {
  const values: Record<string, unknown> = {
    sessionId: target.id,
    requestId: target.requestId,
    mode: 'default',
  };
  const required = (definition.inputSchema as { required?: string[] }).required ?? [];
  const args: Record<string, unknown> = {};

  for (const name of required) {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`${definition.name} requires ${name}, which the walk has no value for`);
    }

    args[name] = values[name];
  }

  // A wait that is refused must not wait; one that is answered finds the request.
  if (definition.name === 'wait_for_request') {
    args.wait = 30;
  }

  return args;
}

describe('every MCP tool that takes a session id, against a keyed session (D245)', () => {
  for (const definition of SESSION_TOOLS) {
    it(`${definition.name}: the not-found tool error without its key, answered as today with it`, async () => {
      const keyed = await session(KEY);
      const missing = await tool(
        definition.name,
        argumentsFor(definition, { id: MISSING, requestId: MISSING_REQUEST }),
      );

      assert.equal(missing.status, 200);
      assert.equal(missing.body.result?.isError, true);
      assert.match(JSON.stringify(missing.body), /errorCode 1001 SESSION_NOT_FOUND/);

      const before = await snapshot(keyed.id);
      const mark = await outboxMark();

      for (const authorization of REFUSED_AUTHORIZATIONS) {
        const started = performance.now();
        const { answer, subscribed } = await subscribing(keyed.id, () =>
          tool(definition.name, argumentsFor(definition, keyed), authorization),
        );

        assert.deepEqual(answer, missing, `${definition.name} with ${authorization ?? 'none'}`);
        assert.ok(performance.now() - started < 5000, `${definition.name} waited when refused`);
        // Refused before the wait subscribes, so it hears nothing of the session (D245).
        assert.equal(subscribed, 0, `${definition.name} subscribed when refused`);
        assert.deepEqual(
          await snapshot(keyed.id),
          before,
          `${definition.name} changed the session`,
        );
      }

      await servers.flush();
      assert.equal(await eventsSince(keyed.id, mark), 0, `${definition.name} announced a refusal`);
      assert.equal(servers.hub.countFor(keyed.id), 0, `${definition.name} left a subscriber`);

      const plain = await session();
      const plainWithKey = await session();
      const today = await tool(definition.name, argumentsFor(definition, plain));
      const opened = await tool(definition.name, argumentsFor(definition, keyed), `Bearer ${KEY}`);
      const ignored = await tool(
        definition.name,
        argumentsFor(definition, plainWithKey),
        `Bearer ${OTHER}`,
      );

      assert.notEqual(today.body.result?.isError, true, JSON.stringify(today.body));

      for (const answer of [opened, ignored]) {
        assert.equal(answer.status, today.status);
        assert.equal(
          answer.body.result?.isError,
          today.body.result?.isError,
          JSON.stringify(answer.body),
        );
        assert.deepEqual(
          shape(
            JSON.stringify(
              (answer.body.result as { structuredContent?: unknown }).structuredContent ?? null,
            ),
          ),
          shape(
            JSON.stringify(
              (today.body.result as { structuredContent?: unknown }).structuredContent ?? null,
            ),
          ),
        );
      }
    });
  }
});

/** Opens a socket offering `protocols`, and reports how it closed and what the handshake chose. */
function closing(
  sessionId: string,
  protocols?: string[],
): Promise<{ code: number; reason: string; protocol: string; messages: string[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/${sessionId}`, protocols);
  const messages: string[] = [];

  socket.addEventListener('message', (message) => messages.push(String(message.data)));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('The connection was not closed within 10 s'));
    }, 10_000);

    socket.addEventListener('close', (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason, protocol: socket.protocol, messages });
    });
  });
}

const carrying = (key: string): string[] => [
  REALTIME_PROTOCOL,
  `${REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${key}`,
];

/**
 * What a refusal reads, for a keyed session and a missing one alike (D245):
 * the one statement of `sessionAccess`, whose answer carries the
 * fingerprint and the expiry's verdict and no column of what the session
 * answers with, so its cost does not grow with what the session stores.
 */
const ACCESS_READ: Recorded[] = [
  { text: SESSION_ACCESS_SQL, columns: ['access_key_hash', 'expired'] },
];

/**
 * What `action` answered, and the statements reading `sessions` the servers
 * sent while it ran, each with the columns its answer carried.
 */
async function whileRecording<T>(
  action: () => Promise<T>,
): Promise<{ answer: T; statements: Recorded[] }> {
  recorded.length = 0;
  recording = true;

  try {
    const answer = await action();

    return {
      answer,
      statements: recorded.filter((entry) => /\bFROM sessions\b/.test(entry.text)),
    };
  } finally {
    recording = false;
  }
}

/**
 * A keyed session that stores as much as a session can: a custom response at
 * every limit of D101 and a queue of ten such steps, set with its key - about
 * 800 KiB the full read would load and parse.
 */
async function fullyConfigured(): Promise<Walked> {
  const keyed = await session(KEY);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${KEY}` };
  const response = await app.inject({
    method: 'PUT',
    url: `/api/sessions/${keyed.id}/response`,
    headers,
    payload: JSON.stringify({ mode: 'custom', response: ordinaryFullResponse() }),
  });

  assert.equal(response.statusCode, 200, response.body);

  const queue = await app.inject({
    method: 'PUT',
    url: `/api/sessions/${keyed.id}/queue`,
    headers,
    payload: JSON.stringify({ steps: ordinaryFullQueue() }),
  });

  assert.equal(queue.statusCode, 200, queue.body);

  const opened = await app.inject({
    method: 'GET',
    url: `/api/sessions/${keyed.id}`,
    headers: { authorization: `Bearer ${KEY}` },
  });

  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(opened.json<{ queue: { total: number } }>().queue.total, 10);
  assert.ok(opened.body.length > 700 * 1024, `the session holds ${opened.body.length} bytes`);

  return keyed;
}

describe('the socket, /ws/:sessionId, against a keyed session (D245)', () => {
  it('closes 4404 without the key or with another, as for a missing session, and changes nothing', async () => {
    const keyed = await session(KEY);
    const before = await snapshot(keyed.id);
    const missing = await closing(MISSING);

    assert.deepEqual(missing, {
      code: WsCloseCode.SESSION_NOT_FOUND,
      reason: 'Session not found',
      protocol: '',
      messages: [],
    });

    for (const protocols of [
      undefined,
      carrying(OTHER),
      [REALTIME_PROTOCOL],
      [REALTIME_PROTOCOL, `${REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${KEY}x`],
      [REALTIME_PROTOCOL, KEY],
      [
        REALTIME_PROTOCOL,
        `${REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${KEY}`,
        `${REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${OTHER}`,
      ],
    ]) {
      const answer = await closing(keyed.id, protocols);

      // The handshake answers the subprotocol the missing session's would have.
      assert.deepEqual(
        answer,
        { ...missing, protocol: protocols === undefined ? '' : REALTIME_PROTOCOL },
        JSON.stringify(protocols),
      );
    }

    // A key sent once the socket is open is no key: the server reads no message.
    const late = new WebSocket(`ws://127.0.0.1:${port}/ws/${keyed.id}`);
    const lateCode = await new Promise<number>((resolve) => {
      late.addEventListener('open', () => late.send(KEY));
      late.addEventListener('close', (event) => resolve(event.code));
    });

    assert.equal(lateCode, WsCloseCode.SESSION_NOT_FOUND);
    assert.deepEqual(await snapshot(keyed.id), before);
    assert.equal(servers.hub.countFor(keyed.id), 0);
  });

  it('refuses a keyed session by the very statement that refuses a missing one, with no wait (criterion 8)', async () => {
    const keyed = await session(KEY);
    const refusal = (sessionId: string, protocols?: string[]) =>
      whileRecording(() => refused(port, sessionId, protocols));

    const missing = await refusal(MISSING);
    const withoutKey = await refusal(keyed.id);
    const withOther = await refusal(keyed.id, carrying(OTHER));

    // One statement, which reads the fingerprint and the expiry and nothing
    // the session answers with.
    assert.deepEqual(missing.statements, ACCESS_READ);
    assert.deepEqual(withoutKey, missing);
    assert.deepEqual(withOther, missing);
  });

  it('opens with its key, echoing the protocol offered beside it and never the key', async () => {
    const keyed = await session(KEY);
    const viewer = await watchUrl(`ws://127.0.0.1:${port}/ws/${keyed.id}`, carrying(KEY));

    assert.equal(viewer.protocol(), REALTIME_PROTOCOL);

    // It hears its session as any viewer does, and no event carries the key.
    const captured = await receiver.inject({ method: 'POST', url: `/s/${keyed.id}`, payload: 'x' });

    assert.equal(captured.statusCode, 200);

    const event = await viewer.next();

    assert.equal(event.type, 'request.received');
    assert.ok(!JSON.stringify(event).includes(KEY.slice(-12)));
    viewer.close();
  });

  it('opens a public session with or without a key, as a tab of the current bundle does', async () => {
    const plain = await session();
    const bare = await watchUrl(`ws://127.0.0.1:${port}/ws/${plain.id}`);
    const offered = await watchUrl(`ws://127.0.0.1:${port}/ws/${plain.id}`, carrying(OTHER));

    assert.equal(bare.protocol(), '');
    assert.equal(offered.protocol(), REALTIME_PROTOCOL);
    bare.close();
    offered.close();
  });

  it('closes an expired keyed session 4404 without its key, and 4410 with it', async () => {
    const keyed = await session(KEY);

    await whileExpired(pool, keyed.id, async () => {
      assert.equal((await closing(keyed.id)).code, WsCloseCode.SESSION_NOT_FOUND);
      assert.equal((await closing(keyed.id, carrying(OTHER))).code, WsCloseCode.SESSION_NOT_FOUND);
      assert.equal((await closing(keyed.id, carrying(KEY))).code, WsCloseCode.SESSION_EXPIRED);
    });
  });
});

/**
 * The socket's names under the service's name beside the old ones (#334,
 * D279): a connection offering only the old names - as a
 * tab opened before 1.19.0 does, its offer written out here as it was - only
 * the new ones, or both, as the page offers them now, opens a public and a
 * private session, echoing the first name offered that carries no key; a
 * wrong key under either prefix, or different keys under the two, is refused
 * as a missing session is.
 */
describe('the socket under the new names and the old (D279)', () => {
  const OLD_TAB = (key: string) => ['qa-tools', `qa-tools.access-key.${key}`];
  const NEW_ONLY = (key: string) => ['webhook-inspector', `webhook-inspector.access-key.${key}`];
  const PAGE = (key: string) => [
    'webhook-inspector',
    `webhook-inspector.access-key.${key}`,
    `qa-tools.access-key.${key}`,
  ];
  const offers: [string, string[], string][] = [
    ['a tab opened before 1.19.0, offering the old names', OLD_TAB(KEY), 'qa-tools'],
    ['the new names only', NEW_ONLY(KEY), 'webhook-inspector'],
    ['the page of 1.19.0, offering both', PAGE(KEY), 'webhook-inspector'],
    [
      'the old key beside the new name',
      ['webhook-inspector', `qa-tools.access-key.${KEY}`],
      'webhook-inspector',
    ],
    [
      'the new key beside the old name',
      ['qa-tools', `webhook-inspector.access-key.${KEY}`],
      'qa-tools',
    ],
    [
      'both names and both keys, the old first',
      [
        'qa-tools',
        'webhook-inspector',
        `qa-tools.access-key.${KEY}`,
        `webhook-inspector.access-key.${KEY}`,
      ],
      'qa-tools',
    ],
  ];

  for (const [description, protocols, echoed] of offers) {
    it(`opens a private session for ${description}, echoing ${echoed} and never the key`, async () => {
      const keyed = await session(KEY);
      const viewer = await watchUrl(`ws://127.0.0.1:${port}/ws/${keyed.id}`, protocols);

      assert.equal(viewer.protocol(), echoed);

      const captured = await receiver.inject({
        method: 'POST',
        url: `/s/${keyed.id}`,
        payload: 'x',
      });

      assert.equal(captured.statusCode, 200);

      const event = await viewer.next();

      assert.equal(event.type, 'request.received');
      assert.ok(!JSON.stringify(event).includes(KEY.slice(-12)));
      viewer.close();
    });
  }

  it('opens a public session offering the old names, the new, both, or a wrong key under either', async () => {
    const plain = await session();

    for (const [protocols, echoed] of [
      [undefined, ''],
      [OLD_TAB(OTHER), 'qa-tools'],
      [NEW_ONLY(OTHER), 'webhook-inspector'],
      [PAGE(OTHER), 'webhook-inspector'],
      [
        [
          'webhook-inspector',
          `webhook-inspector.access-key.${KEY}`,
          `qa-tools.access-key.${OTHER}`,
        ],
        'webhook-inspector',
      ],
    ] as const) {
      const viewer = await watchUrl(
        `ws://127.0.0.1:${port}/ws/${plain.id}`,
        protocols === undefined ? undefined : [...protocols],
      );

      assert.equal(viewer.protocol(), echoed, JSON.stringify(protocols));
      viewer.close();
    }
  });

  it('closes a private session 4404 for a wrong key under either prefix, or different keys under the two, as a missing one', async () => {
    const keyed = await session(KEY);
    const before = await snapshot(keyed.id);

    for (const protocols of [
      OLD_TAB(OTHER),
      NEW_ONLY(OTHER),
      PAGE(OTHER),
      ['webhook-inspector', `webhook-inspector.access-key.${KEY}`, `qa-tools.access-key.${OTHER}`],
      ['webhook-inspector', `webhook-inspector.access-key.${OTHER}`, `qa-tools.access-key.${KEY}`],
      [
        'webhook-inspector',
        `webhook-inspector.access-key.${KEY}`,
        `webhook-inspector.access-key.${OTHER}`,
      ],
      ['webhook-inspector', `WEBHOOK-INSPECTOR.ACCESS-KEY.${KEY}`],
      ['qa-tools', `QA-TOOLS.access-key.${KEY}`],
      ['webhook-inspector', `webhook-inspector.access-key.${KEY}x`, `qa-tools.access-key.${KEY}`],
    ]) {
      const missing = await closing(MISSING, protocols);
      const answer = await closing(keyed.id, protocols);

      assert.equal(missing.code, WsCloseCode.SESSION_NOT_FOUND, JSON.stringify(protocols));
      assert.deepEqual(answer, missing, JSON.stringify(protocols));
      assert.notEqual(answer.protocol, '', JSON.stringify(protocols));
      assert.ok(!answer.protocol.toLowerCase().includes('access-key'), answer.protocol);
    }

    assert.deepEqual(await snapshot(keyed.id), before);
    assert.equal(servers.hub.countFor(keyed.id), 0);
  });

  it('closes an expired private session 4410 with its key under either prefix, and 4404 with another', async () => {
    const keyed = await session(KEY);

    await whileExpired(pool, keyed.id, async () => {
      for (const offer of [OLD_TAB, NEW_ONLY, PAGE]) {
        assert.equal((await closing(keyed.id, offer(KEY))).code, WsCloseCode.SESSION_EXPIRED);
        assert.equal((await closing(keyed.id, offer(OTHER))).code, WsCloseCode.SESSION_NOT_FOUND);
      }
    });
  });
});

/**
 * Answers a handshake to `/ws/<sessionId>` written by hand with
 * `Sec-WebSocket-Protocol: <protocols>`: its status, and the subprotocol a
 * `101` answered. Any upgraded socket is ended at once.
 */
function handshake(
  sessionId: string,
  protocols: string,
): Promise<{ status: number; protocol: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: `/ws/${sessionId}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Protocol': protocols,
      },
    });

    request.on('upgrade', (answer, socket) => {
      socket.destroy();
      resolve({
        status: answer.statusCode ?? 0,
        protocol: answer.headers['sec-websocket-protocol'],
      });
    });
    request.on('response', (answer) => {
      answer.resume();
      resolve({
        status: answer.statusCode ?? 0,
        protocol: answer.headers['sec-websocket-protocol'],
      });
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * A name that starts like a key's prefix in another letter case (#356): the
 * prefixes are compared exactly (D245), so such a name carries no key, and the
 * handshake answers it as any other name, as before 1.19.0; from 1.19.0 until
 * this fix it answered none, and a browser failed the handshake `1006`. A name
 * under an exact prefix is still never answered, and an empty name never
 * reaches the choice: `ws` refuses it `400`.
 */
describe('the socket offering a name like a key prefix in another letter case (#356)', () => {
  const MISTYPED = [
    'Webhook-Inspector.Access-Key.x',
    'QA-TOOLS.ACCESS-KEY.x',
    `WEBHOOK-INSPECTOR.ACCESS-KEY.${KEY}`,
    `Qa-Tools.Access-Key.${KEY}`,
    'Webhook-Inspector.Access-Key.',
  ];

  it('opens a public session offering only such a name, answered with it', async () => {
    const plain = await session();

    for (const name of MISTYPED) {
      const viewer = await watchUrl(`ws://127.0.0.1:${port}/ws/${plain.id}`, [name]);

      assert.equal(viewer.protocol(), name);
      assert.equal(viewer.isOpen(), true, name);
      viewer.close();
    }
  });

  it('opens a private session’s socket offering only such a name, answered with it, and closes it 4404 as a missing one', async () => {
    const keyed = await session(KEY);
    const before = await snapshot(keyed.id);

    for (const name of MISTYPED) {
      const missing = await closing(MISSING, [name]);
      const answer = await closing(keyed.id, [name]);

      assert.deepEqual(
        missing,
        {
          code: WsCloseCode.SESSION_NOT_FOUND,
          reason: 'Session not found',
          protocol: name,
          messages: [],
        },
        name,
      );
      assert.deepEqual(answer, missing, name);
    }

    assert.deepEqual(await snapshot(keyed.id), before);
    assert.equal(servers.hub.countFor(keyed.id), 0);
  });

  it('opens a private session with its key under an exact prefix offered after such a name, which is answered', async () => {
    const keyed = await session(KEY);

    for (const protocols of [
      ['QA-TOOLS.ACCESS-KEY.x', `${REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${KEY}`],
      [`Webhook-Inspector.Access-Key.${OTHER}`, `qa-tools.access-key.${KEY}`],
    ]) {
      const viewer = await watchUrl(`ws://127.0.0.1:${port}/ws/${keyed.id}`, protocols);

      assert.equal(viewer.protocol(), protocols[0]);

      const captured = await receiver.inject({
        method: 'POST',
        url: `/s/${keyed.id}`,
        payload: 'x',
      });

      assert.equal(captured.statusCode, 200);
      assert.equal((await viewer.next()).type, 'request.received');
      viewer.close();
    }
  });

  it('still answers no name under an exact prefix, a key or not, which a browser fails as 1006', async () => {
    const plain = await session();
    const keyed = await session(KEY);

    for (const sessionId of [plain.id, keyed.id, MISSING]) {
      for (const protocols of [
        `${REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${KEY}`,
        `qa-tools.access-key.${KEY}`,
        `${REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${KEY}, qa-tools.access-key.${KEY}`,
        `${REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}, qa-tools.access-key.`,
        `${REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${OTHER}`,
      ]) {
        assert.deepEqual(
          await handshake(sessionId, protocols),
          { status: 101, protocol: undefined },
          protocols,
        );
      }
    }
  });

  it('refuses 400, before any choice, a handshake whose offer has an empty or a repeated name', async () => {
    for (const protocols of [
      '',
      ',',
      ', webhook-inspector',
      'webhook-inspector,',
      'webhook-inspector,,chat',
      'Webhook-Inspector.Access-Key.x, , webhook-inspector',
      'webhook-inspector, webhook-inspector',
      'Webhook-Inspector.Access-Key.x,Webhook-Inspector.Access-Key.x',
    ]) {
      assert.deepEqual(
        await handshake(MISSING, protocols),
        { status: 400, protocol: undefined },
        JSON.stringify(protocols),
      );
    }

    assert.deepEqual(
      await handshake(MISSING, 'Webhook-Inspector.Access-Key.x, webhook-inspector'),
      {
        status: 101,
        protocol: 'Webhook-Inspector.Access-Key.x',
      },
    );
  });

  for (const size of [1024, 4 * 1024, 12 * 1024]) {
    it(`answers such a name after ${size} characters of names under the exact prefixes`, async () => {
      const keys = Array.from(
        { length: Math.floor(size / 40) },
        (_, n) =>
          `${n % 2 === 0 ? REALTIME_ACCESS_KEY_PROTOCOL_PREFIX : 'qa-tools.access-key.'}${n}`,
      );
      const name = `WEBHOOK-INSPECTOR.ACCESS-KEY.${'a'.repeat(size / 4)}`;

      assert.deepEqual(await handshake(MISSING, [...keys, name].join(', ')), {
        status: 101,
        protocol: name,
      });
      assert.deepEqual(await handshake(MISSING, keys.join(', ')), {
        status: 101,
        protocol: undefined,
      });
    });
  }
});

describe('a keyed session storing the largest response and queue, refused (D245, criterion 8)', () => {
  it('closes its socket as a missing session’s, after the same read, which loads none of what it stores', async () => {
    const keyed = await fullyConfigured();

    for (const protocols of [undefined, carrying(OTHER)]) {
      const missing = await whileRecording(() => closing(MISSING, protocols));
      const answer = await whileRecording(() => closing(keyed.id, protocols));

      assert.equal(missing.answer.code, WsCloseCode.SESSION_NOT_FOUND);
      assert.deepEqual(missing.statements, ACCESS_READ, JSON.stringify(protocols));
      assert.deepEqual(answer, missing, JSON.stringify(protocols));
    }

    // With its key the socket needs nothing more of the session either: the
    // same read, sent a second time only when a session was closed while the
    // connection was set up (D198) - by a deletion any process on this
    // database committed, as a test file running beside this one may at any
    // moment. The hub's count only grows, so when it has not moved over the
    // whole opening the route cannot have looked the session up again.
    const closedBefore = servers.hub.closedSessions;
    const opened = await whileRecording(() =>
      watchUrl(`ws://127.0.0.1:${port}/ws/${keyed.id}`, carrying(KEY)),
    );
    const lookedUpAgain =
      servers.hub.closedSessions !== closedBefore && opened.statements.length === 2;

    assert.deepEqual(
      opened.statements,
      lookedUpAgain ? [...ACCESS_READ, ...ACCESS_READ] : ACCESS_READ,
    );
    opened.answer.close();
  });

  it('answers GET /api/sessions/:sessionId as for a missing session, after the same read, and reads it whole only with its key', async () => {
    const keyed = await fullyConfigured();

    for (const method of ['GET', 'HEAD'] as const) {
      for (const authorization of [undefined, `Bearer ${OTHER}`]) {
        const read = (id: string) =>
          whileRecording(async () => {
            const answer = await app.inject({
              method,
              url: `/api/sessions/${id}`,
              headers: authorization === undefined ? {} : { authorization },
            });

            return { status: answer.statusCode, body: answer.body };
          });
        const missing = await read(MISSING);
        const answer = await read(keyed.id);
        const what = `${method} with ${authorization ?? 'no Authorization'}`;

        assert.equal(missing.answer.status, 404, what);
        assert.deepEqual(missing.statements, ACCESS_READ, what);
        assert.deepEqual(answer, missing, what);
      }
    }

    // The same read first with its key, then the session whole.
    const opened = await whileRecording(() =>
      app.inject({
        method: 'GET',
        url: `/api/sessions/${keyed.id}`,
        headers: { authorization: `Bearer ${KEY}` },
      }),
    );

    assert.equal(opened.answer.statusCode, 200, opened.answer.body);
    assert.deepEqual(opened.statements[0], ACCESS_READ[0]);
    assert.ok(
      opened.statements.slice(1).some((entry) => entry.columns?.includes('response_queue')),
      opened.statements.map((entry) => entry.text).join('\n'),
    );
  });
});

describe('the socket looked up again (D198), for a keyed session storing the largest response and queue (D245)', () => {
  it('opens with its key when a session was closed while it opened, looking it up again by the same read', async () => {
    const keyed = await fullyConfigured();
    let forced = 0;

    // A session closed in the hub between the first lookup and the check
    // after the registration, as the listener closes one a deletion committed
    // anywhere: the route reads the hub's count before its first lookup, so a
    // move made as that lookup is sent sends it to the second on every run.
    beforeSent = (text, values) => {
      if (
        forced === 0 &&
        text === SESSION_ACCESS_SQL &&
        Array.isArray(values) &&
        values[0] === keyed.id
      ) {
        forced += 1;
        servers.hub.closeSession(MISSING, WsCloseCode.SESSION_NOT_FOUND, 'Session not found');
      }
    };

    try {
      const opened = await whileRecording(() =>
        watchUrl(`ws://127.0.0.1:${port}/ws/${keyed.id}`, carrying(KEY)),
      );

      assert.equal(forced, 1, 'the first lookup was not seen');
      // Both lookups the one statement, each answered the fingerprint and the
      // expiry's verdict and nothing the session stores.
      assert.deepEqual(opened.statements, [...ACCESS_READ, ...ACCESS_READ]);
      // Opened, `ready` sent, and registered.
      assert.equal(opened.answer.protocol(), REALTIME_PROTOCOL);
      assert.ok(opened.answer.isOpen());
      assert.equal(servers.hub.countFor(keyed.id), 1);
      opened.answer.close();
    } finally {
      beforeSent = undefined;
    }
  });
});

/** Posts a status read, with `accessKeys` when given. */
async function status(
  ids: string[],
  accessKeys?: Record<string, string>,
): Promise<{ id: string; state: string }[]> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions/status',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    payload: JSON.stringify(accessKeys === undefined ? { ids } : { ids, accessKeys }),
  });

  assert.equal(response.statusCode, 200, response.body);

  return response.json<{ sessions: { id: string; state: string }[] }>().sessions;
}

describe('POST /api/sessions/status against a keyed session (D245, criterion 5)', () => {
  it('reports a keyed session only with its own key beside its id, and as missing otherwise', async () => {
    const keyed = await session(KEY);
    const plain = await session();
    const before = await snapshot(keyed.id);
    const ids = [keyed.id, plain.id, MISSING];

    // `Authorization` plays no part: the key travels beside its id.
    for (const accessKeys of [
      undefined,
      {},
      { [keyed.id]: OTHER },
      { [plain.id]: KEY },
      { [plain.id]: KEY, [keyed.id]: OTHER },
    ]) {
      const sessions = await status(ids, accessKeys);

      assert.deepEqual(
        sessions[0],
        { id: keyed.id, state: 'not_found' },
        JSON.stringify(accessKeys),
      );
      assert.deepEqual(sessions[2], { id: MISSING, state: 'not_found' });
      assert.equal(sessions[1]?.state, 'active');
    }

    const opened = await status(ids, { [keyed.id]: KEY, [plain.id]: OTHER });

    assert.deepEqual(
      opened.map((entry) => entry.state),
      ['active', 'active', 'not_found'],
    );
    assert.deepEqual(shape(JSON.stringify(opened[0])), shape(JSON.stringify(opened[1])));
    assert.equal((opened[0] as { requestsCount?: number }).requestsCount, 1);
    assert.deepEqual(await snapshot(keyed.id), before, 'the status read used the session');
  });

  it('reports an expired keyed session as missing without its key, and as expired with it', async () => {
    const keyed = await session(KEY);

    await whileExpired(pool, keyed.id, async () => {
      assert.deepEqual(await status([keyed.id]), [{ id: keyed.id, state: 'not_found' }]);
      assert.deepEqual(await status([keyed.id], { [keyed.id]: KEY }), [
        { id: keyed.id, state: 'expired' },
      ]);
    });
  });
});

describe('an expired keyed session on the API (D245)', () => {
  it('is 404 / 1001 without its key, and 410 / 1002 with it', async () => {
    const keyed = await session(KEY);

    await whileExpired(pool, keyed.id, async () => {
      for (const url of [`/api/sessions/${keyed.id}`, `/api/sessions/${keyed.id}/requests`]) {
        const refusedAnswer = await app.inject({ method: 'GET', url });
        const opened = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${KEY}` },
        });

        assert.equal(refusedAnswer.statusCode, 404, url);
        assert.equal(refusedAnswer.json<{ errorCode: number }>().errorCode, 1001);
        assert.equal(opened.statusCode, 410, url);
        assert.equal(opened.json<{ errorCode: number }>().errorCode, 1002);
      }
    });
  });
});

/**
 * The operations that lock the session row and then read its expiry (D245
 * item 4): `changeLockedSession` behind the first five, since #134 the rules'
 * save too (D246), and `deleteSessionInTransaction` behind the last. Each
 * checks the key before the expiry, so a stranger is never told `410` for a
 * keyed session that has expired.
 */
const ROW_LOCKING = [
  'PUT /api/sessions/{sessionId}/response',
  'PUT /api/sessions/{sessionId}/rules',
  'PUT /api/sessions/{sessionId}/queue',
  'DELETE /api/sessions/{sessionId}/queue',
  'POST /api/sessions/{sessionId}/queue/restart',
  'DELETE /api/sessions/{sessionId}',
];

describe('the operations that lock the session row, against an expired keyed session (D245)', () => {
  for (const name of ROW_LOCKING) {
    it(`${name}: 404 / 1001 as a missing session without its key, 410 / 1002 with it, and nothing changes`, async (t) => {
      // From the description, with the example body the census walks it with.
      const operation = CENSUS.scoped.find((entry) => label(entry) === name);

      assert.ok(operation !== undefined, `${name} is not in the description`);

      const missing = await call(operation, { id: MISSING, requestId: MISSING_REQUEST }, undefined);

      assert.equal(missing.status, 404, missing.body);
      assert.equal(JSON.parse(missing.body).errorCode, 1001, missing.body);

      // The row is taken `FOR UPDATE`, which `whileExpired`'s hold would block.
      await withExpiredSession(
        t,
        pool,
        async () => (await session(KEY)).id,
        async (id) => {
          const keyed = { id, requestId: MISSING_REQUEST };
          const before = await snapshot(id);
          const mark = await outboxMark();

          for (const authorization of REFUSED_AUTHORIZATIONS) {
            assert.deepEqual(
              await call(operation, keyed, authorization),
              missing,
              `${name} with ${authorization ?? 'no Authorization'}`,
            );
          }

          const opened = await call(operation, keyed, `Bearer ${KEY}`);

          assert.equal(opened.status, 410, opened.body);
          assert.equal(JSON.parse(opened.body).errorCode, 1002, opened.body);

          // Neither the refusals nor the expired answer wrote anything: no
          // configuration, no expiry moved, no request gone, no event.
          assert.deepEqual(await snapshot(id), before, `${name} changed the session`);
          await servers.flush();
          assert.equal(await eventsSince(id, mark), 0, `${name} announced a refusal`);
        },
      );
    });
  }
});

/**
 * How long a refused wait may take. Its session holds nothing, so a wait of a
 * second that subscribed would answer after twice this.
 */
const REFUSED_WAIT_MS = 500;

/**
 * The list `operation` answers for `target` with `authorization`, and the
 * request it is to hold: for a wait, on a session holding nothing, the one
 * captured once the wait has subscribed, which ends it.
 */
async function listed(
  operation: Operation,
  target: Walked,
  authorization: string | undefined,
  waits: boolean,
): Promise<{ answer: Answer; requestId: string }> {
  if (!waits) {
    return { answer: await call(operation, target, authorization), requestId: target.requestId };
  }

  let answered = false;
  const pending = call(operation, target, authorization).finally(() => {
    answered = true;
  });

  // An answer before any subscription - a refusal, say - is compared as it is.
  await until(
    () => answered || servers.hub.countFor(target.id) > 0,
    `the wait on ${target.id} to subscribe`,
  );

  const requestId = await capture(target.id);

  return { answer: await pending, requestId };
}

describe('the request list with a wait or with bodies, against a keyed session (D245)', () => {
  for (const query of ['wait=1', 'include=headers,body', 'wait=1&include=headers,body']) {
    it(`GET …/requests?${query}: refused at once as a missing session without its key, answered as a public session with it`, async () => {
      const operation: Operation = {
        method: 'GET',
        path: `/api/sessions/{sessionId}/requests?${query}`,
        body: undefined,
      };
      const waits = query.includes('wait=');
      // A wait is walked on a session holding nothing, where one that
      // subscribed would wait out its second rather than answer at once.
      const keyed = await session(KEY, { empty: waits });
      const missing = await call(operation, { id: MISSING, requestId: MISSING_REQUEST }, undefined);

      assert.equal(missing.status, 404, missing.body);
      assert.equal(JSON.parse(missing.body).errorCode, 1001, missing.body);

      const before = await snapshot(keyed.id);
      const mark = await outboxMark();

      for (const authorization of REFUSED_AUTHORIZATIONS) {
        const what = `?${query} with ${authorization ?? 'no Authorization'}`;
        const started = performance.now();
        const { answer, subscribed } = await subscribing(keyed.id, () =>
          call(operation, keyed, authorization),
        );
        const took = performance.now() - started;

        assert.deepEqual(answer, missing, what);
        // A refused wait never subscribes, so it never waits.
        assert.equal(subscribed, 0, `${what} subscribed`);

        if (waits) {
          assert.ok(took < REFUSED_WAIT_MS, `${what} answered after ${Math.round(took)} ms`);
        }

        assert.deepEqual(await snapshot(keyed.id), before, `${what} changed the session`);
      }

      await servers.flush();
      assert.equal(await eventsSince(keyed.id, mark), 0, `?${query} announced a refusal`);
      assert.equal(servers.hub.countFor(keyed.id), 0, `?${query} left a subscriber`);

      // With its key, what a public session is answered: the list holding its
      // request - for a wait, on a session holding nothing, the wait
      // subscribed and ended by the request captured meanwhile.
      const plain = await session(null, { empty: waits });
      const today = await listed(operation, plain, undefined, waits);
      const opened = await listed(operation, keyed, `Bearer ${KEY}`, waits);

      assert.equal(today.answer.status, 200, today.answer.body);
      assert.ok(today.answer.body.includes(today.requestId), today.answer.body);
      assert.equal(opened.answer.status, today.answer.status, opened.answer.body);
      assert.deepEqual(shape(opened.answer.body), shape(today.answer.body), `?${query}`);
      assert.equal(opened.answer.contentType, today.answer.contentType);
      assert.ok(opened.answer.body.includes(opened.requestId), opened.answer.body);
    });
  }
});

describe('a refused call is not a use (D245, criterion 4)', () => {
  it('moves no expiry of an idle-window session, where its key moves it', async () => {
    const keyed = await session(KEY);
    const expiry = async () =>
      (
        await pool.query<{ expires_at: Date }>('SELECT expires_at FROM sessions WHERE id = $1', [
          keyed.id,
        ])
      ).rows[0]?.expires_at.getTime();

    // A window of an hour, half of it gone: any use moves it (D242).
    await pool.query(
      `UPDATE sessions SET idle_seconds = 3600, expires_at = clock_timestamp() + interval '30 minutes'
        WHERE id = $1`,
      [keyed.id],
    );

    const before = await expiry();

    for (const authorization of REFUSED_AUTHORIZATIONS) {
      const headers = authorization === undefined ? {} : { authorization };

      await app.inject({ method: 'GET', url: `/api/sessions/${keyed.id}`, headers });
      await app.inject({
        method: 'PUT',
        url: `/api/sessions/${keyed.id}/response`,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: JSON.stringify({ mode: 'default' }),
      });
      await app.inject({ method: 'POST', url: `/api/sessions/${keyed.id}/queue/restart`, headers });
    }

    assert.equal(await expiry(), before);

    const opened = await app.inject({
      method: 'GET',
      url: `/api/sessions/${keyed.id}`,
      headers: { authorization: `Bearer ${KEY}` },
    });

    assert.equal(opened.statusCode, 200);
    assert.ok(((await expiry()) as number) > (before as number), 'the key did not use the session');
  });
});

describe('the capture on the receive host (D245, criterion 6)', () => {
  it('captures into a keyed session as into any other, asking for no key', async () => {
    const keyed = await session(KEY);
    const captured = await receiver.inject({
      method: 'PUT',
      url: `/s/${keyed.id}/again`,
      payload: 'second',
    });

    assert.equal(captured.statusCode, 200, captured.body);

    const held = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM requests WHERE session_id = $1',
      [keyed.id],
    );

    assert.equal(held.rows[0]?.count, 2);
  });
});

describe('the key appears nowhere it could leak (D245, criterion 7)', () => {
  it('is in no log line, and in no event of the outbox', async () => {
    // Every call above wrote its lines by now; what each refusal answered is
    // compared with a missing session's answer, which cannot hold the key.
    const fingerprint = fingerprintOf(KEY).toString('hex');
    const text = logLines.join('');

    assert.ok(logLines.length > 0);

    for (const needle of [
      KEY.slice(-16),
      OTHER.slice(-16),
      KEY.slice(0, 16),
      'Bearer',
      REALTIME_ACCESS_KEY_PROTOCOL_PREFIX,
      fingerprint.slice(0, 16),
    ]) {
      assert.ok(!text.includes(needle), `a log line holds ${needle}`);
    }

    const events = await pool.query<{ payload: string | null }>(
      'SELECT payload FROM realtime_events WHERE session_id = ANY($1)',
      [createdSessionIds],
    );

    for (const { payload } of events.rows) {
      assert.ok(!(payload ?? '').includes(KEY.slice(-16)));
      assert.ok(!(payload ?? '').includes(fingerprint.slice(0, 16)));
    }
  });
});
