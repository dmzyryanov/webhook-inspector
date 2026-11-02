/**
 * The tool errors of the codes a working database does not give without a
 * lock or a schema change (D203), without a server or a database: `1011`, a
 * statement stopped by its timeout; `1012`, every place of the count a list
 * with conditions takes - the search's with a body condition, the header-only
 * queries' without (D250); and `1500`, a failure the API would answer `500`. Each runs through
 * `callTool` on a made-up pool, as a tool meets it. The rule that a tool
 * error says what to do once, for every code a tool can meet, and the whole
 * text of a `1001`, which `docs/API.md` quotes under the MCP server's Errors.
 * And that a call `readCall` answers never reads its arguments again once
 * they are read (D203): what it runs with was built by its checks.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { ErrorCode } from '@webhook-inspector/shared';
import type { McpToolName } from '@webhook-inspector/shared/mcp';
import {
  AppError,
  invalidListQuery,
  invalidResponseConfig,
  rateLimitExceeded,
  requestNotFound,
  searchBusy,
  searchTimedOut,
  sessionExpired,
  sessionNotFound,
} from '../../errors/app-error.ts';
import { RealtimeHub } from '../realtime/hub.ts';
import { RULES } from '../requests/list-query.ts';
import { createQuerySlots, createSearchSlots, type QuerySlots } from '../requests/search.ts';
import type { PendingWaits } from '../requests/wait.ts';
import { apiErrorText, callTool, readCall, runCall, type ToolContext } from './tools.ts';

const API_CONTRACT_URL = new URL('../../../../../docs/API.md', import.meta.url);
const SESSION_ID = 'z'.repeat(43);
const REQUEST_ID = '3f8a1b20-0000-4000-8000-000000000000';
/** A list with a condition: the query, in a slot of the search and under its timeout. */
const CONDITION = { sessionId: SESSION_ID, body: ['order'] };

/** What the made-up logger was given. */
interface Logged {
  errors: { object: unknown; message: unknown }[];
}

function context(
  pool: unknown,
  logged: Logged,
  querySlots: QuerySlots = createQuerySlots(),
  signal: AbortSignal = new AbortController().signal,
): ToolContext {
  const log = {
    error(object: unknown, message: unknown) {
      logged.errors.push({ object, message });
    },
    info() {},
    warn() {},
    debug() {},
  };

  return {
    pool: pool as pg.Pool,
    // A hub of its own, which nothing watches: `set_response` and
    // `clear_requests` run in a session's line of it (D205), and no tool
    // below publishes to a viewer or waits.
    hub: new RealtimeHub(),
    waits: {} as PendingWaits,
    querySlots,
    searchTimeoutMs: 2000,
    receiveOrigin: 'https://hook.qa-tools.example',
    appOrigin: 'https://qa-tools.example',
    signal,
    log: log as unknown as FastifyBaseLogger,
    key: null,
  };
}

/** A pool the call must not reach: any use of it fails the test. */
const untouchedPool = new Proxy(
  {},
  {
    get(_target, property) {
      assert.fail(`the pool was used: ${String(property)}`);
    },
  },
);

/** The one text block of a tool error. */
function errorText(result: Awaited<ReturnType<typeof callTool>>): string {
  assert.ok(result !== null);
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.structuredContent, undefined);

  return (result.content[0] as { text: string }).text;
}

describe('tool errors for 1011, 1012 and 1500 (D203)', () => {
  it('answers a query that finds every slot taken 1012, saying once to try again, without a query', async () => {
    const logged: Logged = { errors: [] };
    const slots = createQuerySlots(createSearchSlots(1));
    const held = slots.search.tryTake();

    assert.ok(held !== null);

    const result = await callTool(
      'list_requests',
      CONDITION,
      context(untouchedPool, logged, slots),
    );

    assert.equal(
      errorText(result),
      'errorCode 1012 SEARCH_BUSY: Too many searches are running; try again in a moment.',
    );
    assert.equal(slots.search.taken, 1, 'the refused query took a slot');
    assert.equal(slots.headerOnly.taken, 0, 'the refused query took a header-only place');
    assert.deepEqual(logged.errors, []);
    held();
  });

  it('answers a list with header conditions alone in its own count: 1012 only when every place of it is taken (D250)', async () => {
    const logged: Logged = { errors: [] };
    const slots = createQuerySlots(createSearchSlots(1), 2);
    const held = [slots.headerOnly.tryTake(), slots.headerOnly.tryTake()];
    const headersOnly = {
      sessionId: SESSION_ID,
      headers: [{ name: 'X-Merchant-ID', value: '123' }],
    };

    assert.ok(held.every((release) => release !== null));

    for (const args of [headersOnly, { ...headersOnly, body: [] }]) {
      assert.equal(
        errorText(await callTool('list_requests', args, context(untouchedPool, logged, slots))),
        'errorCode 1012 SEARCH_BUSY: Too many searches are running; try again in a moment.',
      );
    }

    assert.equal(slots.headerOnly.taken, 2);
    assert.equal(slots.search.taken, 0, 'a header-only list took the search’s place');

    for (const release of held) {
      release?.();
    }

    // The search's only place held: a list with header conditions alone
    // still runs its statement, and gives its own place back.
    const search = slots.search.tryTake();
    const statements: string[] = [];
    const client = {
      async query(text: string) {
        statements.push(text);

        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const pool = {
      async connect() {
        return client;
      },
      async query(text: string) {
        if (text.startsWith('SELECT access_key_hash FROM sessions')) {
          return { rows: [{ access_key_hash: null }], rowCount: 1 };
        }

        assert.fail(`an unexpected statement: ${text}`);
      },
    };
    const result = await callTool('list_requests', headersOnly, context(pool, logged, slots));

    // The made-up statement answers no session, which is 1001.
    assert.match(errorText(result), /^errorCode 1001 SESSION_NOT_FOUND/);
    assert.ok(statements.includes('BEGIN READ ONLY'), statements.join(' | '));
    assert.equal(slots.headerOnly.taken, 0, 'the header-only place was kept');
    assert.equal(slots.search.taken, 1);
    search?.();
    assert.deepEqual(logged.errors, []);
  });

  it('answers a query its statement timeout stops 1011, and gives the slot and the connection back', async () => {
    const logged: Logged = { errors: [] };
    const slots = createQuerySlots(createSearchSlots(1));
    const statements: string[] = [];
    const released: unknown[] = [];
    // PostgreSQL's answer to a statement `statement_timeout` stops.
    const cancelled = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const client = {
      async query(text: string) {
        statements.push(text);

        if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(text) || text.includes('set_config')) {
          return { rows: [], rowCount: 0 };
        }

        throw cancelled;
      },
      release(error?: Error) {
        released.push(error);
      },
    };
    const pool = {
      async connect() {
        return client;
      },
      // The access check's read, before the query's own statement (D245):
      // a public session, which every key opens.
      async query(text: string) {
        if (text.startsWith('SELECT access_key_hash FROM sessions')) {
          return { rows: [{ access_key_hash: null }], rowCount: 1 };
        }

        throw cancelled;
      },
    };

    const result = await callTool('list_requests', CONDITION, context(pool, logged, slots));

    assert.equal(
      errorText(result),
      'errorCode 1011 SEARCH_TIMED_OUT: The search took too long and was cancelled. Narrow the conditions, or try again.',
    );
    assert.equal(slots.search.taken, 0, 'the slot was kept');
    assert.ok(statements.includes('ROLLBACK'), statements.join(' | '));
    assert.deepEqual(released, [undefined]);
    assert.deepEqual(logged.errors, []);
  });

  it('answers a failure the API would answer 500 as 1500, logs it, and quotes nothing of it', async () => {
    const logged: Logged = { errors: [] };
    const failure = new Error('relation "requests" does not exist');
    const pool = {
      async connect() {
        throw failure;
      },
      async query() {
        throw failure;
      },
    };

    const result = await callTool(
      'get_request',
      { sessionId: SESSION_ID, requestId: REQUEST_ID },
      context(pool, logged),
    );

    assert.equal(
      errorText(result),
      'errorCode 1500 INTERNAL_ERROR: Internal server error. Try again later.',
    );
    assert.deepEqual(logged.errors, [{ object: { err: failure }, message: 'Unhandled error' }]);
  });
});

describe('apiErrorText (D203)', () => {
  it('says what to do once, for every code a tool can meet', () => {
    const errors: AppError[] = [
      sessionNotFound(),
      sessionExpired(),
      requestNotFound(),
      invalidResponseConfig('status is required'),
      invalidListQuery(RULES.limit),
      searchTimedOut(),
      searchBusy(),
      rateLimitExceeded('60 session creations per minute', 37),
      rateLimitExceeded('1200 API calls per minute', 1),
      new AppError(ErrorCode.INTERNAL_ERROR, 500, 'Internal server error'),
    ];

    for (const error of errors) {
      const text = apiErrorText(error);

      assert.match(text, new RegExp(`^errorCode ${error.errorCode} [A-Z_]+: `), text);
      assert.ok((text.match(/\b(try|call) again\b/gi) ?? []).length <= 1, text);
      assert.ok(text.endsWith('.') && !text.includes('..'), text);
    }

    assert.equal(
      apiErrorText(rateLimitExceeded('60 session creations per minute', 37)),
      'errorCode 1015 RATE_LIMIT_EXCEEDED: Rate limit exceeded: 60 session creations per minute per address; try again in 37 s.',
    );
    // `1003` answers an id that is malformed or another session's as well.
    assert.equal(
      apiErrorText(requestNotFound()),
      "errorCode 1003 REQUEST_NOT_FOUND: Request not found. The session holds no such request: the id is not one of this session's request ids, or the request was deleted, cleared or pushed out by the newest 1000.",
    );
  });

  it('names the private case in a 1001, in the one text docs/API.md quotes (D245, #256)', () => {
    const text = apiErrorText(sessionNotFound());

    // One constant for every session: it says nothing about whether this one
    // exists or is private, and keeps the advice for a public one.
    assert.equal(
      text,
      'errorCode 1001 SESSION_NOT_FOUND: Session not found. The session does not exist or was deleted, or it is private and this call did not present its access key: for a private session, check the Authorization header your MCP client sends to this server; otherwise create a new one with create_session.',
    );

    // The MCP server's Errors section opens with a 1001 as its example.
    const contract = readFileSync(API_CONTRACT_URL, 'utf8');
    const start = contract.indexOf('\n## MCP server\n');
    const server = contract.slice(start, contract.indexOf('\n## ', start + 1));
    const errors = server.indexOf('\n### Errors\n');

    assert.ok(start >= 0, 'docs/API.md has no MCP server section');
    assert.ok(errors >= 0, 'the MCP server section of docs/API.md has no Errors');

    const example = /```text\n([^\n]*)\n```/.exec(server.slice(errors));

    assert.ok(example, 'the Errors of the MCP server in docs/API.md give no example');
    assert.equal(example[1], text, 'docs/API.md quotes another 1001');
  });
});

describe('a call readCall answers (D203)', () => {
  it('never reads its arguments again once they are read, for each of the seven tools', async () => {
    // Reached by every tool but the two below once its checks have passed.
    const failure = new Error('the made-up pool');
    const pool = {
      async connect() {
        throw failure;
      },
      async query() {
        throw failure;
      },
    };
    const aborted = new AbortController();

    aborted.abort();

    const calls: [McpToolName, Record<string, unknown>][] = [
      [
        'create_session',
        { response: { status: 201, headers: [['x-a', 'b']], body: 'ok' }, expiresInSeconds: 600 },
      ],
      // An idle window instead of a lifetime, read before the call too (D242).
      ['create_session', { response: { status: 201 }, expiresAfterIdleSeconds: 3600 }],
      // The address choice, read before the call too (D243).
      ['create_session', { storeSourceIp: false, expiresAfterIdleSeconds: 3600 }],
      ['set_response', { sessionId: SESSION_ID, mode: 'custom', response: { status: 202 } }],
      // The client gone: the wait ends with no answer, before the hub or the pool.
      [
        'wait_for_request',
        { sessionId: SESSION_ID, wait: 30, after: REQUEST_ID, limit: 5, order: 'asc' },
      ],
      [
        'list_requests',
        {
          sessionId: SESSION_ID,
          limit: 5,
          order: 'asc',
          since: '2026-10-04T09:00:00Z',
          headers: [{ name: 'x-event', value: 'paid' }],
          body: ['order'],
        },
      ],
      ['get_request', { sessionId: SESSION_ID, requestId: REQUEST_ID }],
      ['clear_requests', { sessionId: SESSION_ID }],
      ['delete_session', { sessionId: SESSION_ID }],
    ];

    for (const [name, args] of calls) {
      const logged: Logged = { errors: [] };
      // Any use of a revoked proxy throws a TypeError, which the call would
      // log and answer as 1500 in place of the pool's failure.
      const { proxy, revoke } = Proxy.revocable(args, {});
      const call = readCall(name, proxy);

      revoke();
      assert.throws(() => Object.keys(proxy), TypeError);

      const result = await runCall(call, context(pool, logged, createQuerySlots(), aborted.signal));

      if (name === 'wait_for_request') {
        assert.equal(result, null, name);
        assert.deepEqual(logged.errors, [], name);
      } else {
        assert.equal(
          errorText(result),
          'errorCode 1500 INTERNAL_ERROR: Internal server error. Try again later.',
          name,
        );
        assert.deepEqual(
          logged.errors,
          [{ object: { err: failure }, message: 'Unhandled error' }],
          name,
        );
      }
    }
  });

  it('answers a refusal of its checks when it runs, without the pool', async () => {
    const logged: Logged = { errors: [] };

    for (const [name, args, text] of [
      ['wait_for_request', [], 'Invalid arguments: arguments must be an object'],
      [
        'get_request',
        { sessionId: 7 },
        'Invalid arguments: sessionId is required and must be a string',
      ],
      [
        'wait_for_request',
        { sessionId: SESSION_ID, wait: 31 },
        'errorCode 1013 INVALID_LIST_QUERY: wait must be an integer number of seconds from 1 to 30. Fix that argument and call again.',
      ],
      [
        'clear_requests',
        { sessionId: SESSION_ID, other: 1 },
        'Invalid arguments: clear_requests takes no argument other than sessionId',
      ],
      // A lifetime out of its range, before the pool (D220).
      [
        'create_session',
        { expiresInSeconds: 59 },
        'errorCode 1005 INVALID_RESPONSE_CONFIG: expiresInSeconds must be an integer from 60 to 604800. Fix that rule and call again.',
      ],
      [
        'create_session',
        { expiresInSeconds: null },
        'errorCode 1005 INVALID_RESPONSE_CONFIG: expiresInSeconds must be an integer from 60 to 604800; omit it for a session that expires 7 days after its last use. Fix that rule and call again.',
      ],
      [
        'create_session',
        { expiresInSeconds: 600, other: 1 },
        'Invalid arguments: create_session takes no argument other than response, expiresInSeconds, expiresAfterIdleSeconds, storeSourceIp and private',
      ],
      // An idle window out of its range, and beside a lifetime, before the pool (D242).
      [
        'create_session',
        { expiresAfterIdleSeconds: 3599 },
        'errorCode 1005 INVALID_RESPONSE_CONFIG: expiresAfterIdleSeconds must be an integer from 3600 to 604800. Fix that rule and call again.',
      ],
      [
        'create_session',
        { expiresAfterIdleSeconds: null },
        'errorCode 1005 INVALID_RESPONSE_CONFIG: expiresAfterIdleSeconds must be an integer from 3600 to 604800; omit it for a session that expires 7 days after its last use. Fix that rule and call again.',
      ],
      [
        'create_session',
        { expiresInSeconds: 600, expiresAfterIdleSeconds: 3600 },
        'errorCode 1005 INVALID_RESPONSE_CONFIG: expiresInSeconds and expiresAfterIdleSeconds cannot be given together: a session either ends a fixed time after its creation or expires a time after its last use. Fix that rule and call again.',
      ],
      // A choice that is no boolean, before the pool (D243).
      [
        'create_session',
        { storeSourceIp: 'false' },
        'errorCode 1005 INVALID_RESPONSE_CONFIG: storeSourceIp must be true or false. Fix that rule and call again.',
      ],
      [
        'create_session',
        { storeSourceIp: null },
        "errorCode 1005 INVALID_RESPONSE_CONFIG: storeSourceIp must be true or false; omit it for a session that stores the sender's IP address. Fix that rule and call again.",
      ],
      [
        'create_session',
        { storeSourceIp: false, other: 1 },
        'Invalid arguments: create_session takes no argument other than response, expiresInSeconds, expiresAfterIdleSeconds, storeSourceIp and private',
      ],
      // A private session with no key on the call, and a private that is no
      // boolean, before the pool: the tools never draw a key (D253).
      [
        'create_session',
        { private: true },
        'errorCode 1005 INVALID_RESPONSE_CONFIG: private: true needs an access key in the Authorization header of /mcp: Bearer and 43 characters of A-Z, a-z, 0-9, _ and -; the tools never draw one. Fix that rule and call again.',
      ],
      [
        'create_session',
        { private: 'true' },
        'errorCode 1005 INVALID_RESPONSE_CONFIG: private must be true or false. Fix that rule and call again.',
      ],
      [
        'create_session',
        { private: null },
        'errorCode 1005 INVALID_RESPONSE_CONFIG: private must be true or false; omit it for a public session. Fix that rule and call again.',
      ],
    ] as [McpToolName, unknown, string][]) {
      const call = readCall(name, args);

      assert.equal(errorText(await runCall(call, context(untouchedPool, logged))), text, name);
    }

    assert.deepEqual(logged.errors, []);
  });
});
