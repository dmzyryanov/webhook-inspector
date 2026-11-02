/**
 * `/mcp` under the API's per-address limits (D201, D203), at their
 * production numbers, on a listener whose window runs on the test's clock:
 * `create_session` counts toward the 60 session creations and every other
 * request to `/mcp` toward the 1200 other calls, MCP and API calls from one
 * address share both counts, a tool call over a limit is a tool error naming
 * the limit and the seconds to wait, and every answer carries the headers.
 * Each test calls from an address of its own.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { API_CALL_LIMIT, SESSION_CREATE_LIMIT } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildServer } from '../../server.ts';
import { DEFAULT_RATE_LIMITS } from '../limits/rate-limit.ts';

type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const UNKNOWN_SESSION = 'z'.repeat(43);

let pool: pg.Pool;
let app: FastifyInstance;
let clock = 0;
/** Sessions the listener inserted, by statement: a refused creation inserts none. */
let inserts = 0;
const createdSessionIds: string[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

/** The pool, counting the session inserts run through it. */
function countingPool(base: pg.Pool): pg.Pool {
  return new Proxy(base, {
    get(target, property) {
      if (property === 'query') {
        return (...args: unknown[]) => {
          if (/INSERT INTO sessions/i.test(String(args[0]))) {
            inserts += 1;
          }

          return (target.query as (...forwarded: unknown[]) => unknown)(...args);
        };
      }

      const value: unknown = Reflect.get(target, property, target);

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    app = buildServer(countingPool(pool), {
      rateLimits: { ...DEFAULT_RATE_LIMITS, now: () => clock },
      logDestination: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    });
    await app.ready();
  })();
  await startup;
});

after(async () => {
  await startup;

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await app?.close();
  await pool?.end();
});

let nextId = 1;

function mcp(
  remoteAddress: string,
  body: unknown,
  headers: Record<string, string> = {},
  url = '/mcp',
): Promise<Injected> {
  return app.inject({
    method: 'POST',
    url,
    remoteAddress,
    headers: { ...HEADERS, ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function toolCall(remoteAddress: string, name: string, args: unknown): Promise<Injected> {
  return mcp(remoteAddress, {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function toolsList(remoteAddress: string): Promise<Injected> {
  return mcp(remoteAddress, { jsonrpc: '2.0', id: nextId++, method: 'tools/list' });
}

function limitHeaders(response: Injected): { limit: string; remaining: string; reset: string } {
  return {
    limit: response.headers['x-ratelimit-limit'] as string,
    remaining: response.headers['x-ratelimit-remaining'] as string,
    reset: response.headers['x-ratelimit-reset'] as string,
  };
}

interface ToolAnswer {
  result: {
    content: { text: string }[];
    isError?: boolean;
    structuredContent?: { sessionId: string };
  };
}

describe('create_session and the session creations (D201, D203)', () => {
  it('allows 60 a minute from one address, and refuses the 61st as a tool error that creates nothing', async () => {
    const address = '198.51.100.11';
    const insertsBefore = inserts;

    for (let index = 1; index <= SESSION_CREATE_LIMIT; index += 1) {
      const response = await toolCall(address, 'create_session', {});
      const answer = response.json<ToolAnswer>();

      assert.equal(response.statusCode, 200);
      assert.equal(answer.result.isError, undefined, answer.result.content[0]?.text);
      createdSessionIds.push(answer.result.structuredContent?.sessionId as string);
      assert.equal(limitHeaders(response).limit, '60');
      assert.equal(limitHeaders(response).remaining, String(SESSION_CREATE_LIMIT - index));
    }

    assert.equal(inserts - insertsBefore, SESSION_CREATE_LIMIT);

    clock += 23_000;

    const refused = await toolCall(address, 'create_session', {});
    const answer = refused.json<ToolAnswer>();

    assert.equal(refused.statusCode, 200);
    assert.equal(answer.result.isError, true);
    assert.equal(
      answer.result.content[0]?.text,
      'errorCode 1015 RATE_LIMIT_EXCEEDED: Rate limit exceeded: 60 session creations per minute per address; try again in 37 s.',
    );
    assert.deepEqual(limitHeaders(refused), { limit: '60', remaining: '0', reset: '37' });
    assert.equal(
      inserts - insertsBefore,
      SESSION_CREATE_LIMIT,
      'the refused call created a session',
    );

    // A creation the transport refuses never meets the creations' limit: it
    // is the transport's refusal, counted toward the other calls.
    const foreign = await mcp(
      address,
      {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name: 'create_session', arguments: {} },
      },
      { origin: 'https://evil.example' },
    );

    assert.equal(foreign.statusCode, 403);
    assert.equal(limitHeaders(foreign).limit, String(API_CALL_LIMIT));

    // The other calls are counted apart: a list is still answered.
    const list = await toolsList(address);

    assert.equal(list.statusCode, 200);
    assert.equal(limitHeaders(list).limit, String(API_CALL_LIMIT));

    // Once the window has ended, creation is allowed again.
    clock += 37_000;

    const again = await toolCall(address, 'create_session', {});

    assert.equal(again.json<ToolAnswer>().result.isError, undefined);
    createdSessionIds.push(again.json<ToolAnswer>().result.structuredContent?.sessionId as string);
    assert.equal(limitHeaders(again).remaining, '59');
  });

  it('shares the count with POST /api/sessions, both ways', async () => {
    const address = '198.51.100.12';

    for (let index = 0; index < SESSION_CREATE_LIMIT / 2; index += 1) {
      const api = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        remoteAddress: address,
      });

      assert.equal(api.statusCode, 201);
      createdSessionIds.push(api.json<{ id: string }>().id);

      const tool = await toolCall(address, 'create_session', {});

      createdSessionIds.push(tool.json<ToolAnswer>().result.structuredContent?.sessionId as string);
    }

    const tool = await toolCall(address, 'create_session', {});

    assert.match(
      tool.json<ToolAnswer>().result.content[0]?.text ?? '',
      /^errorCode 1015 RATE_LIMIT_EXCEEDED: Rate limit exceeded: 60 session creations per minute/,
    );

    const api = await app.inject({ method: 'POST', url: '/api/sessions', remoteAddress: address });

    assert.equal(api.statusCode, 429);
    assert.equal(api.json<{ errorCode: number }>().errorCode, 1015);
  });

  it('counts a create_session refused for its query string, its Origin, its Accept or its version toward the 1200, not the 60', async () => {
    const address = '198.51.100.13';
    const insertsBefore = inserts;
    const create = (headers: Record<string, string>, url?: string): Promise<Injected> =>
      mcp(
        address,
        {
          jsonrpc: '2.0',
          id: nextId++,
          method: 'tools/call',
          params: { name: 'create_session', arguments: {} },
        },
        headers,
        url,
      );
    const refused = [
      await create({}, '/mcp?a=1'),
      await create({ origin: 'https://evil.example' }),
      await create({ accept: 'text/event-stream' }),
      await create({ 'mcp-protocol-version': '2024-11-05' }),
    ];

    assert.deepEqual(
      refused.map((response) => response.statusCode),
      [400, 403, 406, 400],
    );
    assert.deepEqual(
      refused.map((response) => limitHeaders(response).limit),
      ['1200', '1200', '1200', '1200'],
    );
    assert.deepEqual(
      refused.map((response) => limitHeaders(response).remaining),
      ['1199', '1198', '1197', '1196'],
    );
    assert.equal(inserts - insertsBefore, 0, 'a refused call created a session');

    // The creations are untouched: the first one let through is their first.
    const created = await create({});
    const answer = created.json<ToolAnswer>();

    assert.equal(answer.result.isError, undefined, answer.result.content[0]?.text);
    createdSessionIds.push(answer.result.structuredContent?.sessionId as string);
    assert.equal(limitHeaders(created).limit, String(SESSION_CREATE_LIMIT));
    assert.equal(limitHeaders(created).remaining, String(SESSION_CREATE_LIMIT - 1));
  });
});

describe('every other request to /mcp and the API calls (D201, D203)', () => {
  it('counts every request to /mcp - refused, notifications, 405 - and the API, together, up to 1200', async () => {
    const address = '198.51.100.21';
    const kinds: (() => Promise<Injected>)[] = [
      () => toolsList(address),
      () => toolCall(address, 'list_requests', { sessionId: UNKNOWN_SESSION }),
      () => mcp(address, { jsonrpc: '2.0', method: 'notifications/initialized' }),
      () => mcp(address, '{'),
      () =>
        mcp(address, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' }),
      () =>
        mcp(address, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'content-type': 'text/plain' }),
      () => mcp(address, `{"pad":"${'a'.repeat(1024 * 1024)}"}`),
      () => app.inject({ method: 'GET', url: '/mcp', remoteAddress: address }),
      () =>
        app.inject({
          method: 'GET',
          url: `/api/sessions/${UNKNOWN_SESSION}`,
          remoteAddress: address,
        }),
    ];

    for (let index = 1; index <= API_CALL_LIMIT; index += 1) {
      const response = await (kinds[index % kinds.length] as () => Promise<Injected>)();

      assert.equal(limitHeaders(response).limit, String(API_CALL_LIMIT), `call ${index}`);
      assert.equal(
        limitHeaders(response).remaining,
        String(API_CALL_LIMIT - index),
        `call ${index}`,
      );
    }

    const tool = await toolCall(address, 'list_requests', { sessionId: UNKNOWN_SESSION });
    const answer = tool.json<ToolAnswer>();

    assert.equal(tool.statusCode, 200);
    assert.equal(answer.result.isError, true);
    assert.match(
      answer.result.content[0]?.text ?? '',
      /^errorCode 1015 RATE_LIMIT_EXCEEDED: Rate limit exceeded: 1200 API calls per minute per address; try again in \d+ s\.$/,
    );
    assert.equal(limitHeaders(tool).remaining, '0');

    const list = await toolsList(address);

    assert.equal(list.statusCode, 429);
    assert.equal(list.headers['retry-after'], limitHeaders(list).reset);
    assert.deepEqual(Object.keys(list.json<{ error: object }>().error), [
      'code',
      'message',
      'data',
    ]);
    assert.equal(
      list.json<{ error: { data: { errorCode: number } } }>().error.data.errorCode,
      1015,
    );

    const notification = await mcp(address, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    assert.equal(notification.statusCode, 429);
    assert.equal(notification.json<{ id: unknown }>().id, null);

    const api = await app.inject({
      method: 'GET',
      url: `/api/sessions/${UNKNOWN_SESSION}`,
      remoteAddress: address,
    });

    assert.equal(api.statusCode, 429);

    // Session creations are counted apart, and are still allowed.
    const created = await toolCall(address, 'create_session', {});

    assert.equal(created.json<ToolAnswer>().result.isError, undefined);
    createdSessionIds.push(
      created.json<ToolAnswer>().result.structuredContent?.sessionId as string,
    );

    // A transport refusal still answers as itself, and carries the headers.
    const foreign = await mcp(
      address,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { origin: 'https://evil.example' },
    );

    assert.equal(foreign.statusCode, 403);
    assert.equal(limitHeaders(foreign).remaining, '0');

    const query = await mcp(address, { jsonrpc: '2.0', id: 1, method: 'ping' }, {}, '/mcp?a=1');

    assert.equal(query.statusCode, 400);
    assert.equal(limitHeaders(query).remaining, '0');
  });

  it('carries the three headers on every answer of /mcp, and counts each request once', async () => {
    const address = '198.51.100.22';
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const answers = [
      await toolsList(address),
      await mcp(address, { jsonrpc: '2.0', method: 'notifications/initialized' }),
      await mcp(address, '{'),
      // Refused by Fastify before the handler: the size, a `Content-Type`
      // that is no media type.
      await mcp(address, `{"pad":"${'a'.repeat(1024 * 1024)}"}`),
      await mcp(address, ping, { 'content-type': 'json' }),
      // Refused by the handler before its count.
      await mcp(address, ping, { 'content-type': 'text/plain' }),
      await mcp(address, ping, { origin: 'https://evil.example' }),
      await mcp(address, ping, { accept: 'text/event-stream' }),
      await mcp(address, ping, { 'mcp-protocol-version': '2024-11-05' }),
      await app.inject({ method: 'DELETE', url: '/mcp', remoteAddress: address }),
      await app.inject({ method: 'HEAD', url: '/mcp', remoteAddress: address }),
      // Refused for its query string before the body and the method: a
      // message, a body over 1 MiB, a `GET` and a foreign `Origin`.
      await mcp(address, ping, {}, '/mcp?a=1'),
      await mcp(address, `{"pad":"${'a'.repeat(1024 * 1024)}"}`, {}, '/mcp?a=1'),
      await app.inject({ method: 'GET', url: '/mcp?a=1', remoteAddress: address }),
      await mcp(address, ping, { origin: 'https://evil.example' }, '/mcp?a=1'),
    ];

    assert.deepEqual(
      answers.map((response) => response.statusCode),
      [200, 202, 400, 413, 415, 415, 403, 406, 400, 405, 405, 400, 400, 400, 403],
    );
    assert.deepEqual(
      answers.map((response) => limitHeaders(response).remaining),
      answers.map((_, index) => String(API_CALL_LIMIT - 1 - index)),
    );

    for (const response of answers) {
      assert.ok(Number(limitHeaders(response).reset) >= 1);
    }
  });
});
