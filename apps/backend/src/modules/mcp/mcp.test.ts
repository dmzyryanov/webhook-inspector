/**
 * `/mcp` against the database (D203), through Fastify's injection, with both
 * listeners of the process sharing one hub as `index.ts` makes them share it:
 * each tool against the API it wraps - its answers, its refusals with their
 * `errorCode`, what it announces to the session's viewers and which session
 * expiry it moves (D133) - the body cut and the captured content, and every
 * refusal of the transport. The limits are in `mcp-limits.test.ts`, a real
 * MCP client over HTTP in `mcp-http.test.ts`.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ErrorCode, MAX_CONCURRENT_HEADER_QUERIES } from '@webhook-inspector/shared';
import {
  MCP_INSTRUCTIONS,
  MCP_REQUEST_ID_MAX_LENGTH,
  mcpTools,
  MCP_UNTRUSTED_FIELD,
  MCP_UNTRUSTED_NOTICE,
} from '@webhook-inspector/shared/mcp';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { whileExpired, withExpiredSession } from '../../testing/expired-session.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import { buildServer } from '../../server.ts';
import { createQuerySlots } from '../requests/search.ts';
import type { Subscriber } from '../realtime/hub.ts';
import { PendingWaits } from '../requests/wait.ts';
import { QUERY_STRING_REFUSED, SERVER_VERSION } from './routes.ts';

type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

const APP_ORIGIN = 'https://qa-tools.example';
/**
 * The site's second origin (#319, D275): the other `Origin` let in. Every
 * link below still names `APP_ORIGIN`, as production's keep naming
 * `https://qa-tools.ru` beside `https://webhook.qa-tools.ru`.
 */
const ALIAS_ORIGIN = 'https://webhook.qa-tools.example';
const RECEIVE_ORIGIN = 'https://hook.qa-tools.example';
/** The tools as this server, with its receive origin, lists them (D274). */
const MCP_TOOLS = mcpTools(RECEIVE_ORIGIN);
const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};
const UNKNOWN_SESSION = 'z'.repeat(43);
const UNKNOWN_REQUEST = '3f8a1b20-0000-4000-8000-000000000000';

let pool: pg.Pool;
let servers: TestServers;
/** The places of searches and queries of `app` and its `/mcp` (D191, D250), which a test holds. */
const querySlots = createQuerySlots();
let app: FastifyInstance;
let receiver: FastifyInstance;
const createdSessionIds: string[] = [];
let nextId = 1;

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    servers = buildTestServers(pool, {
      appOrigin: APP_ORIGIN,
      appAliasOrigin: ALIAS_ORIGIN,
      receiveOrigin: RECEIVE_ORIGIN,
      rateLimits: LIMITS_OUT_OF_REACH,
      querySlots,
      logDestination: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    });
    ({ api: app, receiver } = servers);
    await servers.ready();
  })();
  await startup;
});

after(async () => {
  await startup;

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers?.close();
  await pool?.end();
});

/** Posts one JSON-RPC message to `/mcp`. */
function post(
  body: unknown,
  headers: Record<string, string> = {},
  target: FastifyInstance = app,
): Promise<Injected> {
  return target.inject({
    method: 'POST',
    url: '/mcp',
    headers: { ...HEADERS, ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Calls a tool and answers its result, after checking the JSON-RPC envelope. */
async function call(name: string, args?: unknown): Promise<ToolResult> {
  const id = nextId++;
  const response = await post({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: args === undefined ? { name } : { name, arguments: args },
  });

  assert.equal(response.statusCode, 200, response.body);

  const answer = response.json<{ jsonrpc: string; id: number; result: ToolResult }>();

  assert.equal(answer.jsonrpc, '2.0');
  assert.equal(answer.id, id);

  return answer.result;
}

/** A tool's structured result, after checking it is no error. */
async function ok(name: string, args?: unknown): Promise<Record<string, unknown>> {
  const result = await call(name, args);

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.ok(result.structuredContent);

  return result.structuredContent;
}

/** A tool's refusal text, after checking it is one. */
async function refused(name: string, args?: unknown): Promise<string> {
  const result = await call(name, args);

  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.content.length, 1);

  return result.content[0]?.text ?? '';
}

async function createSession(response?: unknown): Promise<string> {
  const created = await ok('create_session', response === undefined ? {} : { response });
  const sessionId = created.sessionId as string;

  createdSessionIds.push(sessionId);

  return sessionId;
}

/** Sends a webhook to the receive listener and answers the stored request's id. */
async function capture(
  sessionId: string,
  options: { path?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<string> {
  const response = await receiver.inject({
    method: 'POST',
    url: `/s/${sessionId}${options.path ?? ''}`,
    headers: options.headers ?? { 'content-type': 'application/json' },
    payload: options.body ?? '{"event":"order.paid"}',
  });

  assert.ok(response.statusCode < 300, response.body);

  return response.headers['x-qa-tools-request-id'] as string;
}

/**
 * A response summary of a request answered `status`: `sent` once the record
 * of the answer is written, `pending` just before (D109).
 */
function assertAnswered(response: unknown, status: number): void {
  const summary = response as { state: string; status: number };

  assert.equal(summary.status, status);
  assert.ok(['pending', 'sent'].includes(summary.state), summary.state);
}

async function expiresAt(sessionId: string): Promise<Date> {
  const result = await pool.query<{ expires_at: Date }>(
    'SELECT expires_at FROM sessions WHERE id = $1',
    [sessionId],
  );

  return result.rows[0]?.expires_at as Date;
}

/** Moves the session's expiry two hours back, so that a refresh would show. */
async function ageSession(sessionId: string): Promise<Date> {
  await pool.query(
    "UPDATE sessions SET expires_at = expires_at - interval '2 hours' WHERE id = $1",
    [sessionId],
  );

  return expiresAt(sessionId);
}

/** A stand-in viewer of a session, recording what it is sent and how it is closed. */
function viewer(sessionId: string, events: string[]): { sent: string[]; closed: number[] } {
  const seen = { sent: [] as string[], closed: [] as number[] };
  const subscriber: Subscriber = {
    send(data) {
      seen.sent.push(data);
    },
    close(code) {
      seen.closed.push(code);
    },
    bufferedAmount: 0,
    terminate() {},
  };

  servers.hub.add(sessionId, subscriber, new Set(events));

  return seen;
}

describe('initialize, ping and tools/list', () => {
  it('negotiates the version, names the server and its product version, and opens no session', async () => {
    const response = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      },
      { 'mcp-protocol-version': '' },
    );

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] as string, /^application\/json/);
    assert.equal(response.headers['mcp-session-id'], undefined);

    const { result } = response.json<{ result: Record<string, unknown> }>();
    const version = readFileSync(new URL('../../../../../VERSION', import.meta.url), 'utf8').trim();

    assert.deepEqual(result, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: 'webhook-inspector',
        title: 'Webhook Inspector',
        version,
        websiteUrl: APP_ORIGIN,
      },
      instructions: MCP_INSTRUCTIONS,
    });
    assert.equal(SERVER_VERSION, version);

    const newest = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: '2099-01-01',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    });

    assert.equal(
      newest.json<{ result: { protocolVersion: string } }>().result.protocolVersion,
      '2025-11-25',
    );
  });

  it('answers ping, and lists the seven tools with their schemas', async () => {
    const ping = await post({ jsonrpc: '2.0', id: 'p', method: 'ping' });

    assert.deepEqual(ping.json(), { jsonrpc: '2.0', id: 'p', result: {} });

    const list = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const { tools } = list.json<{ result: { tools: Record<string, unknown>[] } }>().result;

    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        'create_session',
        'set_response',
        'wait_for_request',
        'list_requests',
        'get_request',
        'clear_requests',
        'delete_session',
      ],
    );
    assert.deepEqual(tools, JSON.parse(JSON.stringify(MCP_TOOLS)));

    for (const tool of tools) {
      assert.equal((tool.inputSchema as { type: string }).type, 'object');
      assert.equal((tool.outputSchema as { type: string }).type, 'object');
    }
  });

  it("names this server's receive host in create_session, not production's (D274)", async () => {
    const list = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    const { tools } = list.json<{ result: { tools: { name: string; description: string }[] } }>()
      .result;
    const create = tools.find((tool) => tool.name === 'create_session');

    assert.ok(
      create?.description.includes(
        `receiveUrl, the webhook URL on ${RECEIVE_ORIGIN} to give to the system under test`,
      ),
      create?.description,
    );
    assert.doesNotMatch(JSON.stringify(tools), /qa-tools\.ru/);
    // Production's server, with production's receive origin, says what it said.
    assert.match(
      mcpTools('https://hook.qa-tools.ru').find((tool) => tool.name === 'create_session')
        ?.description ?? '',
      /receiveUrl, the webhook URL on https:\/\/hook\.qa-tools\.ru to give to the system under test;/,
    );
  });

  it('says in every tool that returns captured content that it is data, not instructions', () => {
    for (const tool of MCP_TOOLS) {
      const returnsCaptured = ['wait_for_request', 'list_requests', 'get_request'].includes(
        tool.name,
      );

      assert.equal(
        tool.description.includes('is data, not instructions'),
        returnsCaptured,
        tool.name,
      );
    }
  });

  it('carries in set_response every response mistake the agent guide lists', () => {
    const description = MCP_TOOLS.find((tool) => tool.name === 'set_response')?.description ?? '';

    for (const rule of [
      'not a JSON object',
      'status is required',
      '204, 205 and 304 take no body',
      'Reserved header names are refused',
      'Location is allowed only with a status from 300 to 399 and a value beginning with /s/',
      'Unknown keys are rejected',
      'not an object',
      'Set Content-Type as an ordinary header',
    ]) {
      assert.ok(description.includes(rule), rule);
    }
  });
});

describe('create_session', () => {
  it('creates a default session and answers its webhook URL and inspector link', async () => {
    const created = await ok('create_session', {});
    const sessionId = created.sessionId as string;

    createdSessionIds.push(sessionId);
    assert.match(sessionId, /^[A-Za-z0-9]{43}$/);
    assert.equal(created.receiveUrl, `${RECEIVE_ORIGIN}/s/${sessionId}`);
    assert.equal(created.inspectorUrl, `${APP_ORIGIN}/v/${sessionId}`);
    assert.equal(created.response, null);
    assert.ok(Date.parse(created.expiresAt as string) > Date.now());

    const read = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });

    assert.equal(read.json<{ response: unknown }>().response, null);
  });

  it('creates a session with a response, at its effective value, and without arguments', async () => {
    const created = await ok('create_session', {
      response: { status: 201, headers: [['x-trace', 'a']], body: '{"received":true}' },
    });

    createdSessionIds.push(created.sessionId as string);
    assert.deepEqual(created.response, {
      status: 201,
      headers: [['x-trace', 'a']],
      body: '{"received":true}',
      delayMs: 0,
      template: false,
    });

    const bare = await ok('create_session');

    createdSessionIds.push(bare.sessionId as string);
    assert.equal(bare.response, null);
  });

  it('refuses a response by the API’s rules with 1005 and the rule, and an unknown argument', async () => {
    const cases: [unknown, RegExp][] = [
      [
        { response: { body: 'x' } },
        /^errorCode 1005 INVALID_RESPONSE_CONFIG: response\.status is required/,
      ],
      [{ response: { status: 200, body: { a: 1 } } }, /response\.body must be a string/],
      [
        { response: { status: 204, body: 'x' } },
        /must be absent when response\.status is 204, 205 or 304/,
      ],
      [{ response: { status: 200, headers: [['Set-Cookie', 'a']] } }, /name is reserved/],
      [{ response: { status: 200, extra: 1 } }, /response may contain no key other than/],
      [{ response: null }, /response must be an object/],
      [
        { response: { status: 200, headers: { a: 'b' } } },
        /must be an array of \[name, value\] pairs/,
      ],
    ];

    for (const [args, rule] of cases) {
      assert.match(await refused('create_session', args), rule);
    }

    // The queue and the rules are the API's alone (D205, D246).
    for (const args of [{ ttl: 5 }, { queue: { steps: [{ status: 503 }] } }, { rules: [] }]) {
      assert.equal(
        await refused('create_session', args),
        'Invalid arguments: create_session takes no argument other than response, expiresInSeconds, expiresAfterIdleSeconds, storeSourceIp and private',
      );
    }
    assert.equal(
      await refused('create_session', []),
      'Invalid arguments: arguments must be an object',
    );
    assert.equal(
      await refused('create_session', 'x'),
      'Invalid arguments: arguments must be an object',
    );
  });

  /** Criterion 8 of #129 (D220). */
  it('creates a session that ends expiresInSeconds after its creation, which set_response does not move', async () => {
    const sentAt = Date.now();
    const created = await ok('create_session', { expiresInSeconds: 600 });
    const answeredAt = Date.now();
    const sessionId = created.sessionId as string;

    createdSessionIds.push(sessionId);

    const expires = Date.parse(created.expiresAt as string);

    assert.ok(expires >= sentAt + 600_000 - 2_000, created.expiresAt as string);
    assert.ok(expires <= answeredAt + 600_000 + 2_000, created.expiresAt as string);
    assert.equal(created.response, null);

    const lifetime = await pool.query<{ lifetime: string; same: boolean }>(
      `SELECT extract(epoch FROM expires_at - created_at)::text AS lifetime,
              lifetime_ends_at = expires_at AS same
         FROM sessions WHERE id = $1`,
      [sessionId],
    );

    assert.equal(Number(lifetime.rows[0]?.lifetime), 600);
    assert.equal(lifetime.rows[0]?.same, true);

    const read = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });

    assert.equal(read.json<{ expiresAt: string }>().expiresAt, created.expiresAt);

    // Beside a response, and the one use a tool makes moves nothing.
    const custom = await ok('create_session', {
      response: { status: 202 },
      expiresInSeconds: 60,
    });
    const customId = custom.sessionId as string;

    createdSessionIds.push(customId);
    assert.deepEqual(custom.response, {
      status: 202,
      headers: [],
      body: null,
      delayMs: 0,
      template: false,
    });

    const before = await expiresAt(customId);

    await ok('set_response', { sessionId: customId, mode: 'default' });
    assert.equal((await expiresAt(customId)).getTime(), before.getTime());
    assert.equal(Date.parse(custom.expiresAt as string), before.getTime());
  });

  it('refuses a bad expiresInSeconds with the 1005 tool error, after the response and before an unknown argument', async () => {
    const rule = 'expiresInSeconds must be an integer from 60 to 604800';

    for (const value of [59, 604_801, 0, -60, 600.5, '600', true, [], {}, [600]]) {
      assert.equal(
        await refused('create_session', { expiresInSeconds: value }),
        `errorCode 1005 INVALID_RESPONSE_CONFIG: ${rule}. Fix that rule and call again.`,
        JSON.stringify(value),
      );
    }

    assert.equal(
      await refused('create_session', { expiresInSeconds: null }),
      `errorCode 1005 INVALID_RESPONSE_CONFIG: ${rule}; omit it for a session that expires 7 days after its last use. Fix that rule and call again.`,
    );

    // A value JSON reads as Infinity, sent as text.
    const id = nextId++;
    const huge = await post(
      `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"create_session","arguments":{"expiresInSeconds":1e400}}}`,
    );

    assert.equal(
      huge.json<{ result: ToolResult }>().result.content[0]?.text,
      `errorCode 1005 INVALID_RESPONSE_CONFIG: ${rule}. Fix that rule and call again.`,
    );

    assert.match(
      await refused('create_session', { response: { status: 99 }, expiresInSeconds: 5 }),
      /^errorCode 1005 INVALID_RESPONSE_CONFIG: response\.status is required/,
    );
    assert.equal(
      await refused('create_session', { ttl: 5, expiresInSeconds: 5 }),
      `errorCode 1005 INVALID_RESPONSE_CONFIG: ${rule}. Fix that rule and call again.`,
    );
    assert.equal(
      await refused('create_session', { expiresInSeconds: 600, ttl: 5 }),
      'Invalid arguments: create_session takes no argument other than response, expiresInSeconds, expiresAfterIdleSeconds, storeSourceIp and private',
    );
  });

  /** Criterion 7 of #158 (D242). */
  it('creates a session that slides by expiresAfterIdleSeconds, which set_response moves', async () => {
    for (const window of [3600, 86_400, 604_800]) {
      const sentAt = Date.now();
      const created = await ok('create_session', { expiresAfterIdleSeconds: window });
      const answeredAt = Date.now();
      const sessionId = created.sessionId as string;

      createdSessionIds.push(sessionId);

      const expires = Date.parse(created.expiresAt as string);

      assert.ok(expires >= sentAt + window * 1000 - 2_000, created.expiresAt as string);
      assert.ok(expires <= answeredAt + window * 1000 + 2_000, created.expiresAt as string);
      // The output is unchanged: no field says which rule the session follows.
      assert.deepEqual(Object.keys(created).sort(), [
        'expiresAt',
        'inspectorUrl',
        'receiveUrl',
        'response',
        'sessionId',
      ]);

      const read = (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).json<{
        expiresAfterIdleSeconds: number | null;
        lifetimeEndsAt: string | null;
      }>();

      assert.deepEqual([read.expiresAfterIdleSeconds, read.lifetimeEndsAt], [window, null]);
    }

    // Beside a response; a use past the throttle moves it a full window ahead.
    const custom = await ok('create_session', {
      response: { status: 202 },
      expiresAfterIdleSeconds: 3600,
    });
    const customId = custom.sessionId as string;

    createdSessionIds.push(customId);
    assert.deepEqual(custom.response, {
      status: 202,
      headers: [],
      body: null,
      delayMs: 0,
      template: false,
    });
    await pool.query(
      "UPDATE sessions SET expires_at = clock_timestamp() + interval '50 minutes' WHERE id = $1",
      [customId],
    );
    await ok('set_response', { sessionId: customId, mode: 'default' });

    const ahead = await pool.query<{ ahead: number }>(
      'SELECT extract(epoch FROM expires_at - clock_timestamp())::float8 AS ahead FROM sessions WHERE id = $1',
      [customId],
    );

    assert.ok(Math.abs((ahead.rows[0]?.ahead as number) - 3600) < 5, String(ahead.rows[0]?.ahead));
  });

  it('refuses a bad expiresAfterIdleSeconds, and the two keys together, with the API’s 1005 messages', async () => {
    const rule = 'expiresAfterIdleSeconds must be an integer from 3600 to 604800';
    const fix = 'Fix that rule and call again.';

    for (const value of [3599, 604_801, 60, 0, -3600, 3600.5, '3600', true, [], {}, [3600]]) {
      assert.equal(
        await refused('create_session', { expiresAfterIdleSeconds: value }),
        `errorCode 1005 INVALID_RESPONSE_CONFIG: ${rule}. ${fix}`,
        JSON.stringify(value),
      );
    }

    assert.equal(
      await refused('create_session', { expiresAfterIdleSeconds: null }),
      `errorCode 1005 INVALID_RESPONSE_CONFIG: ${rule}; omit it for a session that expires 7 days after its last use. ${fix}`,
    );

    // A value JSON reads as Infinity, and one written with a fraction of zeros, sent as text.
    for (const [written, refusal] of [
      ['1e400', `errorCode 1005 INVALID_RESPONSE_CONFIG: ${rule}. ${fix}`],
      ['3600.5', `errorCode 1005 INVALID_RESPONSE_CONFIG: ${rule}. ${fix}`],
    ] as const) {
      const id = nextId++;
      const answered = await post(
        `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"create_session","arguments":{"expiresAfterIdleSeconds":${written}}}}`,
      );

      assert.equal(
        answered.json<{ result: ToolResult }>().result.content[0]?.text,
        refusal,
        written,
      );
    }

    const id = nextId++;
    const taken = await post(
      `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"create_session","arguments":{"expiresAfterIdleSeconds":3600.0}}}`,
    );
    const takenResult = taken.json<{
      result: ToolResult & { structuredContent?: { sessionId?: string } };
    }>().result;

    assert.notEqual(takenResult.isError, true, JSON.stringify(takenResult));

    const takenId = takenResult.structuredContent?.sessionId;

    assert.ok(takenId, JSON.stringify(takenResult));
    createdSessionIds.push(takenId);

    assert.equal(
      await refused('create_session', { expiresInSeconds: 600, expiresAfterIdleSeconds: 3600 }),
      `errorCode 1005 INVALID_RESPONSE_CONFIG: expiresInSeconds and expiresAfterIdleSeconds cannot be given together: a session either ends a fixed time after its creation or expires a time after its last use. ${fix}`,
    );
    // In the API's order: the response, the lifetime, the window, the two together, an unknown argument.
    assert.match(
      await refused('create_session', { response: { status: 99 }, expiresAfterIdleSeconds: 5 }),
      /^errorCode 1005 INVALID_RESPONSE_CONFIG: response\.status is required/,
    );
    assert.equal(
      await refused('create_session', { expiresInSeconds: 5, expiresAfterIdleSeconds: 5 }),
      `errorCode 1005 INVALID_RESPONSE_CONFIG: expiresInSeconds must be an integer from 60 to 604800. ${fix}`,
    );
    assert.equal(
      await refused('create_session', { ttl: 5, expiresAfterIdleSeconds: 5 }),
      `errorCode 1005 INVALID_RESPONSE_CONFIG: ${rule}. ${fix}`,
    );
    assert.equal(
      await refused('create_session', { expiresAfterIdleSeconds: 3600, ttl: 5 }),
      'Invalid arguments: create_session takes no argument other than response, expiresInSeconds, expiresAfterIdleSeconds, storeSourceIp and private',
    );
  });

  /** Criteria 3 and 8 of #166 (D243). */
  it('creates a session that keeps no sender address: every reading tool gives sourceIp null, as a default one gives the address', async () => {
    const sender = '198.51.100.23';
    const created = await ok('create_session', { storeSourceIp: false });
    const sessionId = created.sessionId as string;

    createdSessionIds.push(sessionId);
    // Its output is unchanged: the choice is read back by GET.
    assert.deepEqual(Object.keys(created).sort(), [
      'expiresAt',
      'inspectorUrl',
      'receiveUrl',
      'response',
      'sessionId',
    ]);

    const control = await createSession();
    const waiting = call('wait_for_request', { sessionId, wait: 10 });

    await delay(200);

    for (const id of [sessionId, control]) {
      const response = await receiver.inject({
        method: 'POST',
        url: `/s/${id}`,
        remoteAddress: sender,
        headers: { 'content-type': 'application/json' },
        payload: '{"event":"order.paid"}',
      });

      assert.equal(response.statusCode, 200, response.body);
    }

    const waited = (await waiting).structuredContent as Record<string, unknown>;
    const listed = await ok('list_requests', { sessionId });
    const requestId = (listed.requests as { id: string }[])[0]?.id as string;
    const read = await ok('get_request', { sessionId, requestId });

    for (const [tool, answer] of [
      ['wait_for_request', (waited.requests as Record<string, unknown>[])[0]],
      ['list_requests', (listed.requests as Record<string, unknown>[])[0]],
      ['get_request', read],
    ] as const) {
      assert.ok(answer, tool);
      assert.equal(answer.sourceIp, null, tool);
    }

    for (const answer of [waited, listed, read]) {
      assert.equal(JSON.stringify(answer).includes(sender), false, JSON.stringify(answer));
    }

    const details = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });

    assert.equal(details.json<{ storeSourceIp: boolean }>().storeSourceIp, false);

    // The same capture into a default session keeps the address.
    const kept = await ok('list_requests', { sessionId: control });

    assert.equal((kept.requests as { sourceIp: string | null }[])[0]?.sourceIp, sender);
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/sessions/${control}` })).json<{
        storeSourceIp: boolean;
      }>().storeSourceIp,
      true,
    );

    // true, as the key left out, keeps it too.
    const asked = await ok('create_session', { storeSourceIp: true });

    createdSessionIds.push(asked.sessionId as string);
    assert.equal(
      (
        await app.inject({ method: 'GET', url: `/api/sessions/${asked.sessionId as string}` })
      ).json<{ storeSourceIp: boolean }>().storeSourceIp,
      true,
    );
  });

  /** Criteria 2 and 8 of #166 (D243). */
  it('refuses a storeSourceIp that is no boolean with the API’s 1005 message, in the API’s order', async () => {
    const rule = 'storeSourceIp must be true or false';
    const fix = 'Fix that rule and call again.';

    for (const value of ['false', 'true', '', 0, 1, [], [false], {}, { value: false }]) {
      const refusal = await refused('create_session', { storeSourceIp: value });

      assert.equal(
        refusal,
        `errorCode 1005 INVALID_RESPONSE_CONFIG: ${rule}. ${fix}`,
        JSON.stringify(value),
      );
    }

    assert.equal(
      await refused('create_session', { storeSourceIp: null }),
      `errorCode 1005 INVALID_RESPONSE_CONFIG: ${rule}; omit it for a session that stores the sender's IP address. ${fix}`,
    );
    // In the API's order: the response, the lifetime, the window, the two
    // together, the choice, an unknown argument.
    assert.match(
      await refused('create_session', { response: { status: 99 }, storeSourceIp: 0 }),
      /^errorCode 1005 INVALID_RESPONSE_CONFIG: response\.status is required/,
    );
    assert.equal(
      await refused('create_session', { expiresInSeconds: 5, storeSourceIp: 0 }),
      `errorCode 1005 INVALID_RESPONSE_CONFIG: expiresInSeconds must be an integer from 60 to 604800. ${fix}`,
    );
    assert.equal(
      await refused('create_session', { expiresAfterIdleSeconds: 5, storeSourceIp: 0 }),
      `errorCode 1005 INVALID_RESPONSE_CONFIG: expiresAfterIdleSeconds must be an integer from 3600 to 604800. ${fix}`,
    );
    assert.match(
      await refused('create_session', {
        expiresInSeconds: 600,
        expiresAfterIdleSeconds: 3600,
        storeSourceIp: 0,
      }),
      /cannot be given together/,
    );
    assert.equal(
      await refused('create_session', { ttl: 5, storeSourceIp: 0 }),
      `errorCode 1005 INVALID_RESPONSE_CONFIG: ${rule}. ${fix}`,
    );

    for (const args of [
      { storeSourceIp: false, ttl: 5 },
      { store_source_ip: false },
      { storeSourceIP: false },
      { response: { status: 200 }, sourceIp: false },
    ]) {
      assert.equal(
        await refused('create_session', args),
        'Invalid arguments: create_session takes no argument other than response, expiresInSeconds, expiresAfterIdleSeconds, storeSourceIp and private',
        JSON.stringify(args),
      );
    }

    assert.match(
      await refused('create_session', { response: { status: 200, storeSourceIp: false } }),
      /^errorCode 1005 INVALID_RESPONSE_CONFIG: response may contain no key other than/,
    );

    // Duplicate keys, sent as text, keep the last, as JSON.parse does.
    for (const [written, expected] of [
      ['{"storeSourceIp":true,"storeSourceIp":false}', false],
      ['{"storeSourceIp":false,"storeSourceIp":true}', true],
    ] as const) {
      const id = nextId++;
      const answered = await post(
        `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"create_session","arguments":${written}}}`,
      );
      const result = answered.json<{
        result: ToolResult & { structuredContent?: { sessionId?: string } };
      }>().result;
      const takenId = result.structuredContent?.sessionId;

      assert.ok(takenId, JSON.stringify(result));
      createdSessionIds.push(takenId);
      assert.equal(
        (await app.inject({ method: 'GET', url: `/api/sessions/${takenId}` })).json<{
          storeSourceIp: boolean;
        }>().storeSourceIp,
        expected,
        written,
      );
    }
  });
});

describe('Location on a redirect, through the tools (D247)', () => {
  it('creates a session with it, answered on the wire, and refuses it with 200 as the API does', async () => {
    const created = await ok('create_session', {
      response: { status: 302, headers: [['Location', '/s/x/after']] },
    });
    const sessionId = created.sessionId as string;

    createdSessionIds.push(sessionId);
    assert.deepEqual(created.response, {
      status: 302,
      headers: [['Location', '/s/x/after']],
      body: null,
      delayMs: 0,
      template: false,
    });

    const webhook = await receiver.inject({ method: 'POST', url: `/s/${sessionId}` });

    assert.equal(webhook.statusCode, 302);
    assert.equal(webhook.headers.location, '/s/x/after');

    assert.equal(
      await refused('create_session', {
        response: { status: 200, headers: [['Location', '/s/MARKER-168']] },
      }),
      'errorCode 1005 INVALID_RESPONSE_CONFIG: response.headers[0] Location is allowed only when response.status is from 300 to 399. Fix that rule and call again.',
    );
  });

  it('sets it with set_response, and refuses a target outside /s/ as PUT does', async () => {
    const sessionId = await createSession();
    const custom = {
      status: 307,
      headers: [['location', `/s/${sessionId}/after`]],
      body: null,
      delayMs: 0,
      template: false,
    };

    assert.deepEqual(await ok('set_response', { sessionId, mode: 'custom', response: custom }), {
      sessionId,
      mode: 'custom',
      response: custom,
    });

    const webhook = await receiver.inject({ method: 'POST', url: `/s/${sessionId}` });

    assert.equal(webhook.statusCode, 307);
    assert.equal(webhook.headers.location, `/s/${sessionId}/after`);

    const text = await refused('set_response', {
      sessionId,
      mode: 'custom',
      response: { status: 302, headers: [['Location', 'https://MARKER-168.example/']] },
    });

    assert.equal(
      text,
      'errorCode 1005 INVALID_RESPONSE_CONFIG: response.headers[0] value of Location must be a path beginning with /s/. Fix that rule and call again.',
    );
    assert.equal(text.includes('MARKER-168'), false);
  });
});

describe('response templates, through the tools (D251, criterion 7)', () => {
  const TEMPLATE = {
    status: 201,
    headers: [['Content-Type', 'application/json']],
    body: '{"id":"{{request.id}}","order":"{{request.body.order.id}}","q":"{{request.query.q}}"}',
    delayMs: 0,
    template: true,
  };

  it('creates a session whose body is a template, answered on the wire with the request’s values', async () => {
    const created = await ok('create_session', { response: TEMPLATE });
    const sessionId = created.sessionId as string;

    createdSessionIds.push(sessionId);
    assert.deepEqual(created.response, TEMPLATE);

    const webhook = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}?q=from+query`,
      headers: { 'content-type': 'application/json' },
      payload: '{"order":{"id":"ord_7"}}',
    });

    assert.equal(webhook.statusCode, 201);
    assert.deepEqual(webhook.json(), {
      id: webhook.headers['x-qa-tools-request-id'],
      order: 'ord_7',
      q: 'from query',
    });
  });

  it('sets one with set_response, and turns it off when the flag is left out', async () => {
    const sessionId = await createSession();

    assert.deepEqual(await ok('set_response', { sessionId, mode: 'custom', response: TEMPLATE }), {
      sessionId,
      mode: 'custom',
      response: TEMPLATE,
    });

    const plain: Record<string, unknown> = { ...TEMPLATE };

    delete plain.template;
    const changed = await ok('set_response', { sessionId, mode: 'custom', response: plain });

    assert.deepEqual(changed.response, { ...plain, template: false });
  });

  it('refuses a placeholder outside the set, or a flag that is no boolean, as the API does, quoting nothing', async () => {
    const sessionId = await createSession();
    const cases: [object, string][] = [
      [
        { status: 200, body: '{"a":"{{request.MARKER-135}}"}', template: true },
        'errorCode 1005 INVALID_RESPONSE_CONFIG: response.body placeholder 1 must be one of {{request.id}}, {{request.method}}, {{request.path}}, {{request.query.<name>}}, {{request.header.<name>}} or {{request.body.<path>}}, with nothing else inside the braces. Fix that rule and call again.',
      ],
      [
        { status: 200, body: '{{request.id}}{{MARKER-135', template: true },
        'errorCode 1005 INVALID_RESPONSE_CONFIG: response.body placeholder 2 has no closing }}: with response.template true every {{ starts a placeholder. Fix that rule and call again.',
      ],
      [
        { status: 200, body: 'MARKER-135', template: 'true' },
        'errorCode 1005 INVALID_RESPONSE_CONFIG: response.template must be true or false. Fix that rule and call again.',
      ],
    ];

    for (const [response, message] of cases) {
      for (const [tool, args] of [
        ['create_session', { response }],
        ['set_response', { sessionId, mode: 'custom', response }],
      ] as const) {
        const text = await refused(tool, args);

        assert.equal(text, message, tool);
        assert.equal(text.includes('MARKER-135'), false);
      }
    }
  });
});

describe('set_response', () => {
  it('changes the response as PUT does, announces it, and is a use of the session (D133)', async () => {
    const sessionId = await createSession();
    const seen = viewer(sessionId, ['session.updated']);
    const before = await ageSession(sessionId);
    const changed = await ok('set_response', {
      sessionId,
      mode: 'custom',
      response: { status: 500, headers: [['retry-after', '30']], body: 'boom' },
    });
    const custom = {
      status: 500,
      headers: [['retry-after', '30']],
      body: 'boom',
      delayMs: 0,
      template: false,
    };

    assert.deepEqual(changed, { sessionId, mode: 'custom', response: custom });
    assert.ok((await expiresAt(sessionId)).getTime() > before.getTime());
    // Delivered from the outbox once the change has committed (D221).
    await servers.flush();
    assert.deepEqual(
      seen.sent.map((data) => JSON.parse(data) as unknown),
      // The whole state, as the route publishes it, the queue included (D152, D205).
      [
        {
          type: 'session.updated',
          data: { response: custom, customResponse: custom, queue: null, rules: [] },
        },
      ],
    );

    const webhook = await receiver.inject({ method: 'POST', url: `/s/${sessionId}` });

    assert.equal(webhook.statusCode, 500);
    assert.equal(webhook.body, 'boom');

    const back = await ok('set_response', { sessionId, mode: 'default' });

    assert.deepEqual(back, { sessionId, mode: 'default', response: null });
  });

  it('refuses as PUT does: 1005 with the rule, 1001, an unknown argument, a missing id', async () => {
    const sessionId = await createSession();

    assert.match(
      await refused('set_response', { sessionId, mode: 'custom' }),
      /^errorCode 1005 INVALID_RESPONSE_CONFIG: response must be an object when mode is "custom"/,
    );
    assert.match(
      await refused('set_response', { sessionId, mode: 'default', response: { status: 200 } }),
      /response must be absent when mode is "default"/,
    );
    assert.match(
      await refused('set_response', { sessionId, mode: 'other' }),
      /mode is required and must be "default" or "custom"/,
    );
    assert.match(
      await refused('set_response', { sessionId: UNKNOWN_SESSION, mode: 'default' }),
      /^errorCode 1001 SESSION_NOT_FOUND: Session not found\. The session does not exist or was deleted/,
    );
    assert.match(
      await refused('set_response', { sessionId: 'short', mode: 'default' }),
      /^errorCode 1001 SESSION_NOT_FOUND/,
    );
    assert.equal(
      await refused('set_response', { sessionId, mode: 'default', status: 200 }),
      'Invalid arguments: set_response takes no argument other than sessionId, mode and response',
    );
    assert.equal(
      await refused('set_response', { mode: 'default' }),
      'Invalid arguments: sessionId is required and must be a string',
    );
    assert.equal(
      await refused('set_response', { sessionId: 7, mode: 'default' }),
      'Invalid arguments: sessionId is required and must be a string',
    );
  });
});

describe('list_requests and get_request', () => {
  it('lists metadata only, with the path and Content-Type inside the captured field', async () => {
    const sessionId = await createSession();
    const first = await capture(sessionId, {
      path: '/stripe/events?x=1',
      headers: { 'Content-Type': 'application/json', 'X-Secret-Header': 'header-value-123' },
      body: '{"orderId":42,"marker":"body-value-456"}',
    });
    const second = await capture(sessionId, { headers: {}, body: '' });
    const listed = await ok('list_requests', { sessionId });
    const text = JSON.stringify(listed);

    assert.equal(listed.notice, MCP_UNTRUSTED_NOTICE);
    assert.ok(!text.includes('body-value-456'), 'a body is listed');
    assert.ok(!text.includes('header-value-123'), 'a header is listed');

    const requests = listed.requests as Record<string, unknown>[];

    assert.deepEqual(
      requests.map((entry) => entry.id),
      [second, first],
    );
    assert.deepEqual(
      Object.keys(requests[1] ?? {}).sort(),
      [
        'bodySize',
        'id',
        'method',
        'receivedAt',
        'response',
        'sourceIp',
        MCP_UNTRUSTED_FIELD,
      ].sort(),
    );
    assert.deepEqual(requests[1]?.[MCP_UNTRUSTED_FIELD], {
      path: `/s/${sessionId}/stripe/events`,
      contentType: 'application/json',
    });
    assert.deepEqual(requests[0]?.[MCP_UNTRUSTED_FIELD], {
      path: `/s/${sessionId}`,
      contentType: null,
    });
    assert.equal(requests[1]?.method, 'POST');
    assert.equal(requests[1]?.bodySize, 40);
    assertAnswered(requests[1]?.response, 200);

    const asc = await ok('list_requests', { sessionId, order: 'asc', limit: 1 });

    assert.deepEqual(
      (asc.requests as { id: string }[]).map((entry) => entry.id),
      [first],
    );

    const later = await ok('list_requests', { sessionId, order: 'asc', after: first });

    assert.deepEqual(
      (later.requests as { id: string }[]).map((entry) => entry.id),
      [second],
    );

    const filtered = await ok('list_requests', {
      sessionId,
      headers: [{ name: 'x-secret-header', value: 'header-value-123' }],
      body: ['"orderId":42'],
    });

    assert.deepEqual(
      (filtered.requests as { id: string }[]).map((entry) => entry.id),
      [first],
    );
  });

  it('lists by header conditions alone while both search places are held, and refuses a body condition 1012 (D250)', async () => {
    const sessionId = await createSession();
    const first = await capture(sessionId, {
      headers: { 'X-Merchant-ID': '123' },
      body: '{"orderId":42}',
    });

    await capture(sessionId, { headers: { 'X-Merchant-ID': '456' }, body: '{"orderId":42}' });

    const held = [querySlots.search.tryTake(), querySlots.search.tryTake()];
    const merchant = [{ name: 'x-merchant-id', value: '123' }];

    assert.ok(held.every((release) => release !== null));

    try {
      for (const args of [{ headers: merchant }, { headers: merchant, body: [] }]) {
        const listed = await ok('list_requests', { sessionId, ...args });

        assert.deepEqual(
          (listed.requests as { id: string }[]).map((entry) => entry.id),
          [first],
          JSON.stringify(args),
        );
      }

      for (const args of [{ body: ['"orderId":42'] }, { headers: merchant, body: ['"orderId"'] }]) {
        assert.equal(
          await refused('list_requests', { sessionId, ...args }),
          'errorCode 1012 SEARCH_BUSY: Too many searches are running; try again in a moment.',
          JSON.stringify(args),
        );
      }

      assert.equal(querySlots.headerOnly.taken, 0);
    } finally {
      for (const release of held) {
        release?.();
      }
    }

    // Every header-only place held: a list with header conditions alone is
    // the tool error 1012, in the tool's form, with no HTTP header of its
    // own, and one with a body condition runs.
    const headerOnly = Array.from({ length: MAX_CONCURRENT_HEADER_QUERIES }, () =>
      querySlots.headerOnly.tryTake(),
    );

    try {
      const response = await post({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name: 'list_requests', arguments: { sessionId, headers: merchant } },
      });

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['retry-after'], undefined);
      assert.deepEqual(response.json<{ result: ToolResult }>().result.content, [
        {
          type: 'text',
          text: 'errorCode 1012 SEARCH_BUSY: Too many searches are running; try again in a moment.',
        },
      ]);

      const withBody = await ok('list_requests', { sessionId, body: ['"orderId":42'] });

      assert.equal((withBody.requests as unknown[]).length, 2);
    } finally {
      for (const release of headerOnly) {
        release?.();
      }
    }
  });

  /**
   * The queue's step a list row and the detail carry since 0.46.0 is not part
   * of these tools' answers, which give a response's state and status alone,
   * as they did before (D203, D205).
   */
  it('gives the state and status of a response a queue step answered, and no step', async () => {
    const sessionId = await createSession();
    const queued = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/queue`,
      headers: { 'content-type': 'application/json' },
      payload: '{"steps":[{"status":202}]}',
    });

    assert.equal(queued.statusCode, 200);

    const requestId = await capture(sessionId);
    const listed = await ok('list_requests', { sessionId });
    const [entry] = listed.requests as { response: Record<string, unknown> }[];
    const read = await ok('get_request', { sessionId, requestId });

    assert.deepEqual(Object.keys(entry?.response ?? {}).sort(), ['state', 'status']);
    assert.deepEqual(Object.keys(read.response as object).sort(), ['state', 'status']);
    assertAnswered(entry?.response, 202);
    assertAnswered(read.response, 202);
  });

  it('lists 20 by default and at most 100, and refuses as the list does with 1013', async () => {
    const sessionId = await createSession();

    for (let index = 0; index < 22; index += 1) {
      await capture(sessionId);
    }

    assert.equal(((await ok('list_requests', { sessionId })).requests as unknown[]).length, 20);
    assert.equal(
      ((await ok('list_requests', { sessionId, limit: 100 })).requests as unknown[]).length,
      22,
    );

    const cases: [Record<string, unknown>, string][] = [
      [{ limit: 101 }, 'limit must be an integer from 1 to 100'],
      [{ limit: 0 }, 'limit must be an integer from 1 to 100'],
      [{ limit: '20' }, 'limit must be an integer from 1 to 100'],
      [{ order: 'up' }, 'order must be asc or desc'],
      [{ since: '2026-10-04 09:00' }, 'since must be a date-time with a zone offset'],
      [
        { after: UNKNOWN_REQUEST, since: '2026-10-04T09:00:00Z' },
        'after and since cannot be used together',
      ],
      [{ after: 5 }, 'after must be a string'],
      [{ headers: {} }, 'headers must be an array'],
      [{ body: ['ab'] }, 'body[0] must be 3 to 200 bytes'],
      [
        {
          headers: Array.from({ length: 5 }, () => ({ name: 'a', value: 'b' })),
          body: ['abc', 'abd', 'abe', 'abf'],
        },
        'at most 8 conditions together',
      ],
    ];

    for (const [args, rule] of cases) {
      const text = await refused('list_requests', { sessionId, ...args });

      assert.ok(text.startsWith('errorCode 1013 INVALID_LIST_QUERY: '), text);
      assert.ok(text.includes(rule), `${text} lacks ${rule}`);
    }

    assert.match(
      await refused('list_requests', { sessionId, after: 'not-a-uuid' }),
      /^errorCode 1003 REQUEST_NOT_FOUND/,
    );
    assert.match(
      await refused('list_requests', { sessionId, after: UNKNOWN_REQUEST }),
      /^errorCode 1003 REQUEST_NOT_FOUND/,
    );
    assert.match(
      await refused('list_requests', { sessionId: UNKNOWN_SESSION }),
      /^errorCode 1001 SESSION_NOT_FOUND/,
    );
    assert.equal(
      await refused('list_requests', { sessionId, include: ['body'] }),
      'Invalid arguments: list_requests takes no argument other than sessionId, limit, order, after, since, headers and body',
    );
  });

  it('reads one request with its headers and body, the captured part inside the field', async () => {
    const sessionId = await createSession();
    const requestId = await capture(sessionId, {
      path: '/a/b?x=1&y=%20',
      headers: { 'Content-Type': 'text/plain', 'X-Trace': 'abc' },
      body: 'héllo',
    });
    const read = await ok('get_request', { sessionId, requestId });

    assert.equal(read.notice, MCP_UNTRUSTED_NOTICE);
    assert.equal(read.id, requestId);
    assert.equal(read.method, 'POST');
    assert.equal(read.httpVersion, '1.1');
    assert.equal(read.bodySize, 6);
    assert.equal(read.bodyEncoding, 'utf-8');
    assert.equal(read.truncated, false);
    assertAnswered(read.response, 200);
    assert.equal(read.inspectorUrl, `${APP_ORIGIN}/v/${sessionId}#${requestId}`);

    const captured = read[MCP_UNTRUSTED_FIELD] as Record<string, unknown>;

    assert.equal(captured.path, `/s/${sessionId}/a/b`);
    assert.equal(captured.queryString, 'x=1&y=%20');
    assert.equal(captured.body, 'héllo');
    assert.ok(
      (captured.headers as [string, string][]).some(
        ([name, value]) => name.toLowerCase() === 'x-trace' && value === 'abc',
      ),
    );

    const api = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests/${requestId}`,
    });

    assert.deepEqual(captured.headers, api.json<{ headers: unknown }>().headers);
  });

  it('gives a 1 MiB body as its first 64 KiB with truncated set, binary as Base64, empty as null', async () => {
    const sessionId = await createSession();
    const large = await capture(sessionId, {
      headers: { 'content-type': 'text/plain' },
      body: 'a'.repeat(1024 * 1024),
    });
    const binaryBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    const binary = await capture(sessionId, {
      headers: { 'content-type': 'application/octet-stream' },
      body: binaryBytes,
    });
    const empty = await capture(sessionId, { headers: {}, body: '' });

    const big = await ok('get_request', { sessionId, requestId: large });
    const bigCaptured = big[MCP_UNTRUSTED_FIELD] as { body: string };

    assert.equal(big.bodySize, 1024 * 1024);
    assert.equal(big.truncated, true);
    assert.equal(big.bodyEncoding, 'utf-8');
    assert.equal(bigCaptured.body, 'a'.repeat(64 * 1024));

    const bin = await ok('get_request', { sessionId, requestId: binary });
    const binCaptured = bin[MCP_UNTRUSTED_FIELD] as { body: string };

    assert.equal(bin.bodyEncoding, 'base64');
    assert.equal(bin.truncated, false);
    assert.ok(Buffer.from(binCaptured.body, 'base64').equals(binaryBytes));

    const none = await ok('get_request', { sessionId, requestId: empty });

    assert.equal(none.bodySize, 0);
    assert.equal(none.bodyEncoding, null);
    assert.equal(none.truncated, false);
    assert.equal((none[MCP_UNTRUSTED_FIELD] as { body: unknown }).body, null);
  });

  it('gives a text body exactly as the API does, a second byte-order mark and a mark alone included', async () => {
    const sessionId = await createSession();
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const cases: [Buffer, string][] = [
      [Buffer.concat([bom, bom, Buffer.from('hello')]), '\uFEFFhello'],
      [Buffer.concat([bom, Buffer.from('hello')]), 'hello'],
      [Buffer.concat([bom, bom]), '\uFEFF'],
      [bom, ''],
    ];

    for (const [bytes, text] of cases) {
      const requestId = await capture(sessionId, {
        headers: { 'content-type': 'text/plain' },
        body: bytes,
      });
      const read = await ok('get_request', { sessionId, requestId });
      const api = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/requests/${requestId}`,
      });

      assert.equal(api.json<{ body: unknown }>().body, text);
      assert.equal((read[MCP_UNTRUSTED_FIELD] as { body: unknown }).body, text);
      assert.equal(read.bodyEncoding, 'utf-8');
      assert.equal(read.truncated, false);
      assert.equal(read.bodySize, bytes.length);
    }
  });

  it('refuses an unknown request with 1003, an unknown session with 1001, and a missing id', async () => {
    const sessionId = await createSession();

    assert.match(
      await refused('get_request', { sessionId, requestId: UNKNOWN_REQUEST }),
      /^errorCode 1003 REQUEST_NOT_FOUND: Request not found\./,
    );
    assert.match(
      await refused('get_request', { sessionId, requestId: 'x' }),
      /^errorCode 1003 REQUEST_NOT_FOUND/,
    );
    assert.match(
      await refused('get_request', { sessionId: UNKNOWN_SESSION, requestId: UNKNOWN_REQUEST }),
      /^errorCode 1001 SESSION_NOT_FOUND/,
    );
    assert.equal(
      await refused('get_request', { sessionId }),
      'Invalid arguments: requestId is required and must be a string',
    );
  });

  it('refuses every reading tool on an expired session with 1002', async () => {
    const sessionId = await createSession();
    const requestId = await capture(sessionId);

    await whileExpired(pool, sessionId, async () => {
      for (const [name, args] of [
        ['list_requests', { sessionId }],
        ['get_request', { sessionId, requestId }],
        ['wait_for_request', { sessionId, wait: 1 }],
        ['clear_requests', { sessionId }],
      ] as const) {
        assert.match(
          await refused(name, args),
          /^errorCode 1002 SESSION_EXPIRED: Session expired\. The session has expired/,
          name,
        );
      }
    });
  });

  it('refuses delete_session and set_response on an expired session with 1002', async (t) => {
    // Both take the session row FOR UPDATE, which `whileExpired`'s hold would block.
    for (const [name, extra] of [
      ['delete_session', {}],
      ['set_response', { mode: 'default' }],
    ] as const) {
      const text = await withExpiredSession(
        t,
        pool,
        () => createSession(),
        (sessionId) => refused(name, { sessionId, ...extra }),
      );

      assert.match(text, /^errorCode 1002 SESSION_EXPIRED/, name);
    }
  });
});

describe('wait_for_request', () => {
  it('answers within 500 ms of a capture, not at the end of its 10 s wait, as list_requests lists it', async () => {
    const sessionId = await createSession();
    const waiting = call('wait_for_request', { sessionId, wait: 10 }).then((result) => ({
      result,
      at: performance.now(),
    }));

    await delay(300);

    const sent = performance.now();
    const requestId = await capture(sessionId, { headers: { 'content-type': 'text/plain' } });
    const { result, at } = await waiting;

    // The capture's announcement ends the wait; 500 ms leaves room for the
    // insert and the list read on a loaded database, and is still far from
    // the wait's own end.
    assert.ok(at - sent < 500, `answered ${(at - sent).toFixed(1)} ms after the capture`);
    assert.deepEqual(result.content[0], { type: 'text', text: MCP_UNTRUSTED_NOTICE });

    const requests = result.structuredContent?.requests as Record<string, unknown>[];

    assert.deepEqual(
      requests.map((entry) => entry.id),
      [requestId],
    );
    assert.deepEqual(requests[0]?.[MCP_UNTRUSTED_FIELD], {
      path: `/s/${sessionId}`,
      contentType: 'text/plain',
    });
  });

  it('answers at once when the session holds a request, waits after one, and runs out empty', async () => {
    const sessionId = await createSession();
    const first = await capture(sessionId);
    const started = performance.now();
    const atOnce = await ok('wait_for_request', { sessionId });

    assert.ok(performance.now() - started < 1000);
    assert.equal((atOnce.requests as unknown[]).length, 1);

    const timedOut = performance.now();
    const empty = await ok('wait_for_request', { sessionId, after: first, wait: 1 });

    assert.ok(performance.now() - timedOut >= 900);
    assert.deepEqual(empty.requests, []);
    assert.equal(empty.notice, MCP_UNTRUSTED_NOTICE);
  });

  it('is ended with [] by clear_requests, and with 1001 by delete_session', async () => {
    const sessionId = await createSession();
    const cleared = call('wait_for_request', { sessionId, wait: 10 });

    await delay(200);
    assert.deepEqual(await ok('clear_requests', { sessionId }), { sessionId, cleared: true });
    assert.deepEqual((await cleared).structuredContent?.requests, []);

    const deleted = call('wait_for_request', { sessionId, wait: 10 });

    await delay(200);
    assert.deepEqual(await ok('delete_session', { sessionId }), { sessionId, deleted: true });

    const result = await deleted;

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /^errorCode 1001 SESSION_NOT_FOUND/);
  });

  it('refuses a wait outside 1 to 30 s, since, and a request id that is no UUID', async () => {
    const sessionId = await createSession();

    for (const wait of [0, 31, 1.5, '10']) {
      assert.match(
        await refused('wait_for_request', { sessionId, wait }),
        /^errorCode 1013 INVALID_LIST_QUERY: wait must be an integer number of seconds from 1 to 30/,
      );
    }

    assert.match(
      await refused('wait_for_request', { sessionId, since: '2026-10-04T09:00:00Z' }),
      /^Invalid arguments: wait_for_request takes no argument other than sessionId, wait, after, limit and order$/,
    );
    assert.match(
      await refused('wait_for_request', { sessionId, after: 'x', wait: 1 }),
      /^errorCode 1003 REQUEST_NOT_FOUND/,
    );
  });
});

describe('clear_requests and delete_session', () => {
  it('clear empties the list, keeps the session and announces it, as DELETE .../requests does', async () => {
    const sessionId = await createSession();
    const seen = viewer(sessionId, ['requests.cleared']);

    await capture(sessionId);
    // Delivered before the clear: read once its window has ended (#260), a
    // capture purged by a clear before it is read makes its viewers read the
    // session again instead (D221 point 8).
    await servers.flush();
    await ok('clear_requests', { sessionId });

    assert.deepEqual((await ok('list_requests', { sessionId })).requests, []);
    await servers.flush();
    // `request.received` reaches every viewer; the clear is announced after it.
    assert.deepEqual(seen.sent.slice(-1), ['{"type":"requests.cleared"}']);
    assert.equal(seen.sent.filter((data) => data.includes('requests.cleared')).length, 1);
    assert.equal(
      (await receiver.inject({ method: 'POST', url: `/s/${sessionId}` })).statusCode,
      200,
    );
  });

  it('delete ends the session and closes its viewers with 4404, and get_request is then 1001', async () => {
    const sessionId = await createSession();
    const requestId = await capture(sessionId);

    // Read before the viewer registers, as a capture's window ends (#260):
    // one purged by the deletion before it is read would make the viewer
    // read the session again, `1013`, rather than wait for its close.
    await servers.flush();

    const seen = viewer(sessionId, []);

    await ok('delete_session', { sessionId });
    await servers.flush();

    assert.deepEqual(seen.closed, [4404]);
    assert.match(
      await refused('get_request', { sessionId, requestId }),
      /^errorCode 1001 SESSION_NOT_FOUND: Session not found\./,
    );
    assert.match(await refused('delete_session', { sessionId }), /^errorCode 1001/);
    assert.equal(
      (await receiver.inject({ method: 'POST', url: `/s/${sessionId}` })).statusCode,
      404,
    );
  });
});

describe('the uses of a session (D133)', () => {
  it('moves the expiry on set_response alone', async () => {
    const sessionId = await createSession();
    const requestId = await capture(sessionId);
    const before = await ageSession(sessionId);

    for (const [name, args] of [
      ['list_requests', { sessionId }],
      ['list_requests', { sessionId, body: ['order'] }],
      ['wait_for_request', { sessionId, wait: 1 }],
      ['get_request', { sessionId, requestId }],
      ['clear_requests', { sessionId }],
    ] as const) {
      await ok(name, args);
      assert.equal((await expiresAt(sessionId)).getTime(), before.getTime(), name);
    }

    await ok('set_response', { sessionId, mode: 'default' });
    assert.ok((await expiresAt(sessionId)).getTime() > before.getTime());
  });
});

describe('the transport (D203)', () => {
  it('answers a notification and a response 202 with no body', async () => {
    for (const body of [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
      { jsonrpc: '2.0', id: 9, result: {} },
    ]) {
      const response = await post(body);

      assert.equal(response.statusCode, 202);
      assert.equal(response.body, '');
    }
  });

  it('answers an unknown method -32601 and an unknown tool -32602, naming neither', async () => {
    const method = await post({ jsonrpc: '2.0', id: 1, method: 'resources/list' });

    assert.equal(method.statusCode, 200);
    assert.deepEqual(method.json(), {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    });

    const tool = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'drop_everything', arguments: {} },
    });

    assert.deepEqual(tool.json(), {
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32602, message: 'Invalid params: no such tool; tools/list names the tools' },
    });
  });

  it('refuses what is not one JSON-RPC message with 400', async () => {
    const cases: [string, number][] = [
      ['{', -32700],
      ['', -32700],
      ['[{"jsonrpc":"2.0","id":1,"method":"ping"}]', -32600],
      ['{"jsonrpc":"2.0","id":null,"method":"ping"}', -32600],
      ['{"id":1,"method":"ping"}', -32600],
    ];

    for (const [body, code] of cases) {
      const response = await post(body);

      assert.equal(response.statusCode, 400, body);
      assert.equal(response.json<{ error: { code: number } }>().error.code, code, body);
      assert.equal(response.json<{ id: unknown }>().id, null);
    }
  });

  it(`echoes an id of ${MCP_REQUEST_ID_MAX_LENGTH} characters, and refuses a longer one or an inexact number 400 / -32600 quoting none`, async () => {
    const longest = 'i'.repeat(MCP_REQUEST_ID_MAX_LENGTH);
    const echoed = await post({ jsonrpc: '2.0', id: longest, method: 'ping' });

    assert.equal(echoed.statusCode, 200);
    assert.equal(echoed.json<{ id: unknown }>().id, longest);

    for (const id of [`${longest}i`, 'i'.repeat(1_000_000), 2 ** 53, 1.5]) {
      const response = await post({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'list_requests', arguments: { sessionId: UNKNOWN_SESSION } },
      });
      const answer = response.json<{ id: unknown; error: { code: number; message: string } }>();

      assert.equal(response.statusCode, 400);
      assert.equal(answer.id, null);
      assert.equal(answer.error.code, -32600);
      assert.match(answer.error.message, /^Invalid Request: id must be a string of at most 256 /);
      assert.ok(response.body.length < 300, `${response.body.length} bytes answered`);
    }
  });

  it('refuses a foreign Origin 403, on POST and GET, and lets in none and its own two (#319, D275)', async () => {
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

    for (const origin of [
      'https://evil.example',
      'null',
      `${APP_ORIGIN}/`,
      RECEIVE_ORIGIN,
      `${ALIAS_ORIGIN}/`,
      ALIAS_ORIGIN.toUpperCase(),
      `${ALIAS_ORIGIN}.evil.example`,
    ]) {
      const response = await post(ping, { origin });

      assert.equal(response.statusCode, 403, origin);
      assert.match(response.json<{ error: { message: string } }>().error.message, /^Forbidden/);

      const get = await app.inject({ method: 'GET', url: '/mcp', headers: { origin } });

      assert.equal(get.statusCode, 403);
    }

    assert.equal((await post(ping, { origin: APP_ORIGIN })).statusCode, 200);
    assert.equal((await post(ping, { origin: ALIAS_ORIGIN })).statusCode, 200);
    assert.equal((await post(ping)).statusCode, 200);

    // Called from the second origin, the server still names the first as its
    // site: the links are APP_ORIGIN's until day X.
    const initialized = await post(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      },
      { origin: ALIAS_ORIGIN },
    );

    assert.equal(initialized.statusCode, 200);
    assert.equal(
      initialized.json<{ result: { serverInfo: { websiteUrl: string } } }>().result.serverInfo
        .websiteUrl,
      APP_ORIGIN,
    );
  });

  it('answers GET, HEAD, DELETE and every other method 405 with Allow: POST', async () => {
    for (const method of ['GET', 'HEAD', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'] as const) {
      const response = await app.inject({ method, url: '/mcp' });

      assert.equal(response.statusCode, 405, method);
      assert.equal(response.headers.allow, 'POST');
    }
  });

  it('answers every other method 405 before its body is read: a body over 1 MiB, a Content-Type that is no media type (D213)', async () => {
    // The route has no use for a body, and reading one would hold up to
    // 1 MiB of it while it arrives (the second outside review's finding 2):
    // so neither Fastify's 413 nor its 415 is met first.
    for (const method of ['DELETE', 'PUT', 'PATCH', 'OPTIONS'] as const) {
      for (const [headers, payload] of [
        [HEADERS, `{"pad":"${'a'.repeat(1024 * 1024)}"}`],
        [{ ...HEADERS, 'content-type': 'json' }, '{}'],
        [{ ...HEADERS, 'content-type': 'application/octet-stream' }, Buffer.alloc(4_096)],
      ] as const) {
        const response = await app.inject({ method, url: '/mcp', headers, payload });

        assert.equal(response.statusCode, 405, `${method} ${headers['content-type']}`);
        assert.equal(response.headers.allow, 'POST');
        assert.equal(response.json<{ id: unknown }>().id, null);
      }
    }
  });

  it('refuses a URL with a query string 400 on every method, before its body and its method, quoting none', async () => {
    const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const refusal = {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: QUERY_STRING_REFUSED },
    };
    const long = `q=${'x'.repeat(12_000)}`;

    // An empty `?` and a `#` are refused too; Fastify's injection drops both
    // from a URL, so `mcp-http.test.ts` sends them over a socket.
    for (const url of ['/mcp?a=1', '/mcp?x', '/mcp?a=1&a=2', `/mcp?${long}`, '/%6Dcp?a=1']) {
      const response = await app.inject({ method: 'POST', url, headers: HEADERS, payload: ping });

      assert.equal(response.statusCode, 400, url.slice(0, 16));
      assert.deepEqual(response.json(), refusal, url.slice(0, 16));
    }

    // Before the body is read and before Fastify's own checks: a body over
    // 1 MiB, a `Content-Type` that is no media type or not JSON, a body that
    // is no JSON-RPC message, a create_session call - each the same refusal.
    const cases: [Record<string, string>, string][] = [
      [HEADERS, `{"pad":"${'a'.repeat(1024 * 1024)}"}`],
      [{ ...HEADERS, 'content-type': 'json' }, ping],
      [{ ...HEADERS, 'content-type': 'text/plain' }, ping],
      [{ ...HEADERS, accept: 'text/event-stream' }, ping],
      [{ ...HEADERS, 'mcp-protocol-version': '2024-11-05' }, ping],
      [HEADERS, '{'],
      [
        HEADERS,
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'create_session', arguments: {} },
        }),
      ],
    ];

    for (const [headers, payload] of cases) {
      const response = await app.inject({ method: 'POST', url: '/mcp?a=1', headers, payload });

      assert.equal(response.statusCode, 400, JSON.stringify(headers));
      assert.deepEqual(response.json(), refusal);
    }

    // Before the method: every other method is this 400, not 405.
    for (const method of ['GET', 'HEAD', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'] as const) {
      const response = await app.inject({ method, url: '/mcp?a=1' });

      assert.equal(response.statusCode, 400, method);
      assert.equal(response.headers.allow, undefined, method);

      if (method !== 'HEAD') {
        assert.deepEqual(response.json(), refusal, method);
      }
    }

    // A foreign Origin is still answered first, on every method; the
    // application's own is let through to the refusal.
    for (const method of ['POST', 'GET', 'DELETE'] as const) {
      const foreign = await app.inject({
        method,
        url: '/mcp?a=1',
        headers: { ...HEADERS, origin: 'https://evil.example' },
        payload: method === 'POST' ? ping : undefined,
      });

      assert.equal(foreign.statusCode, 403, method);
      assert.match(foreign.json<{ error: { message: string } }>().error.message, /^Forbidden/);

      const own = await app.inject({
        method,
        url: '/mcp?a=1',
        headers: { ...HEADERS, origin: APP_ORIGIN },
        payload: method === 'POST' ? ping : undefined,
      });

      assert.equal(own.statusCode, 400, method);
    }

    // `/mcp` without a query string still answers.
    assert.equal((await post({ jsonrpc: '2.0', id: 3, method: 'ping' })).statusCode, 200);
  });

  it('refuses an Accept without JSON 406, and a body not declared JSON 415', async () => {
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

    assert.equal((await post(ping, { accept: 'text/event-stream' })).statusCode, 406);
    assert.equal((await post(ping, { accept: 'application/json;q=0' })).statusCode, 406);
    assert.equal((await post(ping, { accept: '*/*' })).statusCode, 200);

    // `text/plain` reaches the handler, which refuses it. A value that is no
    // media type - `json`, empty, `a/b c`, `/json` - Fastify refuses before
    // the handler; the scope's error handler answers it in the same words,
    // which its generic `400` branch would not.
    for (const contentType of ['text/plain', 'json', '', 'a/b c', '/json']) {
      const response = await post(ping, { 'content-type': contentType });

      assert.equal(response.statusCode, 415, contentType);
      assert.deepEqual(
        response.json(),
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message: 'Unsupported Media Type: Content-Type must be application/json',
          },
        },
        contentType,
      );
    }
  });

  it('refuses a protocol version it does not speak 400, and takes none as 2025-03-26', async () => {
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

    assert.equal((await post(ping, { 'mcp-protocol-version': '2024-11-05' })).statusCode, 400);
    assert.equal((await post(ping, { 'mcp-protocol-version': '2025-03-26' })).statusCode, 200);

    const none = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(ping),
    });

    assert.equal(none.statusCode, 200);
  });

  it('refuses a body over 1 MiB 413 as JSON-RPC', async () => {
    const response = await post(
      `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"${'a'.repeat(1024 * 1024)}"}}`,
    );

    assert.equal(response.statusCode, 413);
    assert.equal(response.json<{ error: { code: number } }>().error.code, -32000);
  });

  it('is not served by the receive listener: hook.qa-tools.ru/mcp is 404 / 1000', async () => {
    for (const method of ['GET', 'POST'] as const) {
      const response = await receiver.inject({
        method,
        url: '/mcp',
        headers: HEADERS,
        payload: method === 'POST' ? '{"jsonrpc":"2.0","id":1,"method":"ping"}' : undefined,
      });

      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), {
        errorCode: ErrorCode.ROUTE_NOT_FOUND,
        message: 'Not found',
      });
    }
  });

  // The Ingress's `/mcp` is a string prefix since 0.45.1 (D203), so every
  // path that starts with it reaches this listener: each is the not-found
  // route's, uncounted, and none meets `/mcp`'s own checks - not its query
  // string refusal, its `Origin`, its `Accept` or its `405`.
  it('answers every other path the Ingress’s /mcp prefix sends it 404 / 1000, uncounted', async () => {
    const paths = [
      '/mcp/',
      '/mcp/x',
      '/mcp/mcp',
      '/mcpx',
      '/mcp-docs',
      '/mcp//',
      '/mcp/?x=1',
      '/mcpx?x=1',
      '/mcp/#x',
      // Escaped, a `/`, `?` or `#` is part of the path, which then is not `/mcp`.
      '/mcp%2F',
      '/mcp%3Fx=1',
      '/mcp%23x',
      ...[1, 1_000, 10_000].flatMap((size) => [
        `/mcp/${'a'.repeat(size)}`,
        `/mcp${'a'.repeat(size)}`,
      ]),
    ];

    for (const url of paths) {
      for (const [method, headers] of [
        ['POST', HEADERS],
        ['POST', { ...HEADERS, origin: 'https://evil.example', accept: 'text/html' }],
        ['GET', {}],
        ['DELETE', {}],
      ] as const) {
        const response = await app.inject({
          method,
          url,
          headers,
          payload: method === 'POST' ? '{"jsonrpc":"2.0","id":1,"method":"ping"}' : undefined,
        });
        const label = `${method} ${url.slice(0, 24)} (${url.length})`;

        assert.equal(response.statusCode, 404, label);
        assert.deepEqual(
          response.json(),
          { errorCode: ErrorCode.ROUTE_NOT_FOUND, message: 'Not found' },
          label,
        );
        assert.equal(response.headers['x-ratelimit-limit'], undefined, label);
        assert.equal(response.headers.allow, undefined, label);
      }
    }

    // `/mcp` itself is still the endpoint.
    assert.equal((await post({ jsonrpc: '2.0', id: 2, method: 'ping' })).statusCode, 200);
  });

  it('is in the backend image with the description it reads its version from', () => {
    const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');

    assert.match(
      dockerfile,
      /^COPY packages\/shared\/openapi\.json packages\/shared\/openapi\.json$/m,
    );
  });
});

describe('a shutdown while wait_for_request waits (D200, D203)', () => {
  it('answers it at once with an empty list, and closes its connection', async () => {
    const sessionId = await createSession();
    const waits = new PendingWaits();
    const closing = buildServer(pool, {
      hub: servers.hub,
      waits,
      rateLimits: LIMITS_OUT_OF_REACH,
      logDestination: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    });

    try {
      await closing.ready();

      const started = performance.now();
      const answer = post(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'wait_for_request', arguments: { sessionId, wait: 20 } },
        },
        {},
        closing,
      );

      for (let tries = 0; waits.size === 0 && tries < 100; tries += 1) {
        await delay(10);
      }

      assert.equal(waits.size, 1);
      waits.close();

      const response = await answer;

      assert.ok(performance.now() - started < 5000);
      assert.equal(response.headers.connection, 'close');
      assert.deepEqual(
        response.json<{ result: { structuredContent: { requests: unknown[] } } }>().result
          .structuredContent.requests,
        [],
      );
    } finally {
      await closing.close();
    }
  });
});

describe('create_session with private (D253, #227 criterion 6)', () => {
  const KEY = 'Gh7Jk2Lm9Nb4Vc1Xz6As3Df8Qw5Er0Ty7Ui2Op4Pa9S';
  const OTHER = 'Wr5Tn2Bv8Cx1Zl6Kj9Hg3Fd7Sa0Qp4Ow2Ie8Uy5Rt1M';

  /** Calls a tool with `authorization` on the `POST`, when given, and answers its result. */
  async function callAs(
    authorization: string | undefined,
    name: string,
    args: unknown,
  ): Promise<ToolResult> {
    const id = nextId++;
    const response = await post(
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
      authorization === undefined ? {} : { authorization },
    );

    assert.equal(response.statusCode, 200, response.body);

    return response.json<{ result: ToolResult }>().result;
  }

  /** How many sessions answer with `body`: how many creations with it stored one. */
  async function storedWith(body: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM sessions WHERE response_body = $1',
      [body],
    );

    return result.rows[0]?.count as number;
  }

  it('creates a session under the key of /mcp’s Authorization, which that key opens through every tool and nothing else does', async () => {
    const created = await callAs(`Bearer ${KEY}`, 'create_session', {
      private: true,
      response: { status: 202 },
    });

    assert.equal(created.isError, undefined, created.content[0]?.text);

    const sessionId = created.structuredContent?.sessionId as string;

    createdSessionIds.push(sessionId);
    // The output is a public session's, and holds no key (D253).
    assert.deepEqual(Object.keys(created.structuredContent ?? {}).sort(), [
      'expiresAt',
      'inspectorUrl',
      'receiveUrl',
      'response',
      'sessionId',
    ]);
    assert.ok(!JSON.stringify(created).includes(KEY));

    const read = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${KEY}` },
    });

    assert.equal(read.json<{ private: boolean }>().private, true);
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).statusCode,
      404,
    );

    const captured = await receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      payload: 'a',
    });

    assert.equal(captured.statusCode, 202, captured.body);
    await servers.writes.settled();

    const requestId = captured.headers['x-qa-tools-request-id'] as string;
    const tools: [string, Record<string, unknown>][] = [
      ['set_response', { sessionId, mode: 'default' }],
      ['list_requests', { sessionId }],
      ['get_request', { sessionId, requestId }],
      ['wait_for_request', { sessionId, wait: 1 }],
      ['clear_requests', { sessionId }],
      ['delete_session', { sessionId }],
    ];

    for (const [name, args] of tools) {
      for (const authorization of [undefined, `Bearer ${OTHER}`, `Basic ${KEY}`, KEY]) {
        const refusedAnswer = await callAs(authorization, name, args);

        assert.equal(refusedAnswer.isError, true, `${name} with ${authorization ?? 'no key'}`);
        assert.match(refusedAnswer.content[0]?.text ?? '', /^errorCode 1001 SESSION_NOT_FOUND: /);
      }
    }

    for (const [name, args] of tools) {
      const answer = await callAs(`Bearer ${KEY}`, name, args);

      assert.equal(answer.isError, undefined, `${name}: ${answer.content[0]?.text}`);
    }

    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/sessions/${sessionId}`,
          headers: { authorization: `Bearer ${KEY}` },
        })
      ).statusCode,
      404,
      'delete_session left the session',
    );
  });

  it('is a tool error 1005 when the header carries no key, and creates nothing', async () => {
    for (const authorization of [
      undefined,
      '',
      'Bearer',
      `Basic ${KEY}`,
      `Bearer ${KEY}x`,
      `Bearer ${KEY.slice(1)}`,
      `Bearer ${'A'.repeat(16 * 1024)}`,
    ]) {
      // One per header, which no row left by an earlier run can carry.
      const marker = `marker-${randomUUID()}`;
      const answer = await callAs(authorization, 'create_session', {
        private: true,
        response: { status: 200, body: marker },
      });

      assert.equal(answer.isError, true, JSON.stringify(answer));
      assert.equal(
        answer.content[0]?.text,
        'errorCode 1005 INVALID_RESPONSE_CONFIG: private: true needs an access key in the Authorization header of /mcp: Bearer and 43 characters of A-Z, a-z, 0-9, _ and -; the tools never draw one. Fix that rule and call again.',
      );
      assert.equal(await storedWith(marker), 0, `${authorization ?? 'no header'} created one`);
    }
  });

  it('creates a public session without private, or with false, whatever the header carries', async () => {
    for (const [authorization, args] of [
      [undefined, {}],
      [`Bearer ${KEY}`, {}],
      [`Bearer ${KEY}`, { private: false }],
      ['Bearer', { private: false }],
    ] as const) {
      const created = await callAs(authorization, 'create_session', args);

      assert.equal(created.isError, undefined, created.content[0]?.text);

      const sessionId = created.structuredContent?.sessionId as string;

      createdSessionIds.push(sessionId);

      const read = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });

      assert.equal(read.statusCode, 200);
      assert.equal(read.json<{ private: boolean }>().private, false);
    }
  });

  it('refuses a private that is not a boolean 1005, before anything else is read', async () => {
    for (const value of ['true', 1, null, {}]) {
      const answer = await callAs(`Bearer ${KEY}`, 'create_session', { private: value });

      assert.equal(answer.isError, true);
      assert.match(
        answer.content[0]?.text ?? '',
        /^errorCode 1005 INVALID_RESPONSE_CONFIG: private must be true or false/,
      );
    }
  });
});
