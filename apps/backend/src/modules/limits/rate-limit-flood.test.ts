/**
 * The one log line that names an address, so that the operator can tell
 * which address floods the service (#215, D201): the refusal that takes an
 * address's refusals in a window past the limit itself - the address having
 * asked for more than twice what the window allows - writes one line at
 * `warn`, `FLOOD_LINE`, naming the address as the limits count it, an IPv6
 * address by its `/64`, the counter, `creations` or `calls`, and the
 * refusals so far. At most one a window for each address and counter, on
 * `/api` and `/mcp` alike, and none for an address within its limits or
 * refused no more than the limit.
 *
 * Every call comes through a trusted proxy with the client's address in
 * `X-Forwarded-For`, as in production, so that the request log names the
 * proxy and a line holding the client's address can only be the limits'
 * own. The log is read through `logDestination`, the window on the test's
 * clock, so that nothing here waits for a minute to pass.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type pg from 'pg';
import { RATE_LIMIT_WINDOW_SECONDS } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildServer } from '../../server.ts';
import { FLOOD_LINE, type RateLimitSettings, UNREADABLE_ADDRESS } from './rate-limit.ts';

const MINUTE = RATE_LIMIT_WINDOW_SECONDS * 1000;

/** Pino's numeric level of `warn`. */
const WARN = 40;

/** The proxy every call comes through, inside the trust boundary. */
const PROXY = '10.42.0.7';

const CREATE: InjectOptions = { method: 'POST', url: '/api/sessions' };
/** A call of the API no route has: counted as the other calls, answered `404` with no database work. */
const CALL: InjectOptions = { method: 'GET', url: '/api/no-such-route' };
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

interface LogLine {
  level: number;
  msg: string;
  [field: string]: unknown;
}

/** What one flood line says, beside its level, message, time, host and process. */
interface Flood {
  address: string;
  counter: 'creations' | 'calls';
  refused: number;
}

/** A listener whose every log line is kept, its window on a clock the test moves. */
interface Logged {
  app: FastifyInstance;
  text: () => string;
  lines: () => LogLine[];
  advance: (ms: number) => void;
}

let pool: pg.Pool;
const servers: FastifyInstance[] = [];
const createdSessionIds: string[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
  })();
  await startup;
});

after(async () => {
  await startup?.catch(() => undefined);
  await Promise.all(servers.map((server) => server.close()));

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await pool?.end();
});

/** The application listener behind the trusted proxy with `limits`, its log kept. */
function logged(limits: Omit<RateLimitSettings, 'now'>): Logged {
  let output = '';
  let time = 1_000;
  const app = buildServer(pool, {
    logDestination: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
    trustedProxyCidrs: ['10.42.0.0/24'],
    rateLimits: { ...limits, now: () => time },
  });

  servers.push(app);

  return {
    app,
    text: () => output,
    lines: () =>
      output
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as LogLine),
    advance: (ms) => {
      time += ms;
    },
  };
}

/** `options` sent by the proxy for the client at `address`. */
function from(address: string, options: InjectOptions): InjectOptions {
  return {
    ...options,
    remoteAddress: PROXY,
    headers: { ...options.headers, 'x-forwarded-for': address },
  };
}

let nextRpcId = 1;

/** A `/mcp` message from `address`, through the proxy. */
function mcp(address: string, method: string, params?: unknown): InjectOptions {
  return from(address, {
    method: 'POST',
    url: '/mcp',
    headers: MCP_HEADERS,
    payload: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method, params }),
  });
}

/** Sends `options` from `address` `times` times in a row, and answers their statuses. */
async function send(
  server: Logged,
  address: string,
  options: InjectOptions,
  times: number,
): Promise<number[]> {
  const statuses: number[] = [];

  for (let index = 0; index < times; index += 1) {
    const response = await server.app.inject(from(address, options));

    if (response.statusCode === 201 && options.url === '/api/sessions') {
      createdSessionIds.push(response.json<{ id: string }>().id);
    }

    statuses.push(response.statusCode);
  }

  return statuses;
}

/**
 * Asserts that the listener's flood lines are `expected`, in order, each at
 * `warn` with its fields and nothing else, and that no other line names any
 * of their addresses: the request log names the proxy.
 */
function assertFloods(server: Logged, expected: Flood[]): void {
  const lines = server.lines();
  const floods = lines.filter((line) => line.msg === FLOOD_LINE);

  assert.ok(lines.length > 0, 'the log was not captured');
  assert.deepEqual(
    floods.map(({ address, counter, refused }) => ({ address, counter, refused })),
    expected,
  );

  for (const line of floods) {
    assert.equal(line.level, WARN);
    assert.deepEqual(Object.keys(line).sort(), [
      'address',
      'counter',
      'hostname',
      'level',
      'msg',
      'pid',
      'refused',
      'time',
    ]);
  }

  const named = new Set(
    expected.map(({ address }) => address).filter((address) => address !== UNREADABLE_ADDRESS),
  );

  for (const line of lines.filter((item) => item.msg !== FLOOD_LINE)) {
    const text = JSON.stringify(line);

    for (const address of named) {
      assert.ok(!text.includes(address), `${line.msg} names ${address}`);
    }
  }
}

describe('the line naming an address far over a limit (#215)', () => {
  it('names an address once its creations refused pass the limit itself, once a window, and none within or just over', async () => {
    const server = logged({ sessionCreates: 2, apiCalls: 100 });
    const address = '198.51.100.41';
    const flood: Flood = { address, counter: 'creations', refused: 3 };

    // Within the limit, then refused as many times as it allows: twice what
    // the window allows asked for, and no line names the address.
    assert.deepEqual(await send(server, address, CREATE, 4), [201, 201, 429, 429]);
    assert.ok(server.lines().length > 0, 'the log was not captured');
    assert.ok(!server.text().includes(address), 'a line names an address just over its limit');

    // The refusal past the limit itself, then no more in the window.
    assert.deepEqual(await send(server, address, CREATE, 1), [429]);
    assertFloods(server, [flood]);
    await send(server, address, CREATE, 100);
    assertFloods(server, [flood]);

    // A millisecond before the window ends, still none.
    server.advance(MINUTE - 1);
    await send(server, address, CREATE, 10);
    assertFloods(server, [flood]);

    // The next window counts from none: within, just over, then past again.
    server.advance(1);
    assert.deepEqual(await send(server, address, CREATE, 4), [201, 201, 429, 429]);
    assertFloods(server, [flood]);
    await send(server, address, CREATE, 1);
    assertFloods(server, [flood, flood]);
  });

  it('names an address past the other calls, an IPv6 one by the /64 that every address of the block counts toward', async () => {
    const server = logged({ sessionCreates: 60, apiCalls: 3 });
    const block = [
      '2001:db8:1:2:aaaa:bbbb:cccc:dddd',
      '2001:DB8:1:2::1',
      '2001:0db8:0001:0002:0000:0000:0000:00ff',
    ];
    const neighbour = '2001:db8:1:3::1';

    // Three let through and three refused across the block, and the
    // neighbouring block the same: each just over its limit.
    const statuses: number[] = [];

    for (const address of block) {
      statuses.push(...(await send(server, address, CALL, 2)));
    }

    assert.deepEqual(statuses, [404, 404, 404, 429, 429, 429]);

    assert.deepEqual(await send(server, neighbour, CALL, 6), [404, 404, 404, 429, 429, 429]);
    assertFloods(server, []);

    // The block's fourth refusal, from yet another of its addresses, and
    // more from each of them: one line for the block.
    assert.deepEqual(await send(server, '2001:db8:1:2::abcd', CALL, 1), [429]);
    assertFloods(server, [{ address: '2001:db8:1:2::/64', counter: 'calls', refused: 4 }]);

    for (const address of block) {
      await send(server, address, CALL, 5);
    }

    assertFloods(server, [{ address: '2001:db8:1:2::/64', counter: 'calls', refused: 4 }]);

    for (const address of [...block, '2001:db8:1:2::abcd', neighbour, '2001:db8:1:3::/64']) {
      assert.ok(!server.text().includes(address), `a line names ${address}`);
    }
  });

  it('names an address over both counters once for each, and an IPv4-mapped address by its IPv4', async () => {
    const server = logged({ sessionCreates: 1, apiCalls: 2 });
    const address = '203.0.113.9';

    await send(server, `::ffff:${address}`, CREATE, 3);
    await send(server, address, CALL, 5);
    await send(server, address, CREATE, 10);
    await send(server, `::ffff:${address}`, CALL, 10);

    assertFloods(server, [
      { address, counter: 'creations', refused: 2 },
      { address, counter: 'calls', refused: 3 },
    ]);
    assert.ok(!server.text().includes('::ffff:'), 'a line names the mapped spelling');
  });

  it('names an address on /mcp as on /api, the two sharing each count', async () => {
    const server = logged({ sessionCreates: 1, apiCalls: 2 });
    const address = '198.51.100.52';
    const created = await server.app.inject(
      mcp(address, 'tools/call', { name: 'create_session', arguments: {} }),
    );

    assert.equal(created.statusCode, 200);
    createdSessionIds.push(
      created.json<{ result: { structuredContent: { sessionId: string } } }>().result
        .structuredContent.sessionId,
    );

    // Over the creations: a tool error naming the limit (D203), its first
    // refusal unnamed, its second past the limit itself.
    for (let index = 0; index < 2; index += 1) {
      const refused = await server.app.inject(
        mcp(address, 'tools/call', { name: 'create_session', arguments: {} }),
      );

      assert.match(
        refused.json<{ result: { content: { text: string }[] } }>().result.content[0]?.text ?? '',
        /^errorCode 1015 /,
      );
      assertFloods(server, index === 0 ? [] : [{ address, counter: 'creations', refused: 2 }]);
    }

    // The other calls: one of each let through, then refused in turn, the
    // third refusal past the limit, an API call.
    assert.equal((await server.app.inject(mcp(address, 'tools/list'))).statusCode, 200);
    assert.deepEqual(await send(server, address, CALL, 1), [404]);
    assert.equal((await server.app.inject(mcp(address, 'tools/list'))).statusCode, 429);
    assert.deepEqual(await send(server, address, CALL, 1), [429]);
    assertFloods(server, [{ address, counter: 'creations', refused: 2 }]);
    assert.equal((await server.app.inject(mcp(address, 'tools/list'))).statusCode, 429);
    assertFloods(server, [
      { address, counter: 'creations', refused: 2 },
      { address, counter: 'calls', refused: 3 },
    ]);

    // And no more in the window, from either.
    await server.app.inject(mcp(address, 'tools/call', { name: 'create_session', arguments: {} }));
    await server.app.inject(mcp(address, 'tools/list'));
    await send(server, address, CREATE, 1);
    await send(server, address, CALL, 1);
    assertFloods(server, [
      { address, counter: 'creations', refused: 2 },
      { address, counter: 'calls', refused: 3 },
    ]);
  });

  it('writes one line for each of 10, 100 and 1,000 addresses flooding at once, each naming its own, and none for one beside them within its limit', async () => {
    const server = logged({ sessionCreates: 60, apiCalls: 1 });
    const quiet = '192.0.2.200';
    const expected: Flood[] = [];

    for (const [batch, count] of [10, 100, 1_000].entries()) {
      const addresses = Array.from(
        { length: count },
        (_, index) => `198.${18 + batch}.${index >> 8}.${index & 255}`,
      );

      // Each address in turn: let through, refused, past the limit, refused.
      for (const address of addresses) {
        assert.deepEqual(await send(server, address, CALL, 4), [404, 429, 429, 429], address);
        expected.push({ address, counter: 'calls', refused: 2 });
      }

      assert.deepEqual(await send(server, quiet, CALL, 2), [404, 429]);
      assertFloods(server, expected);
      server.advance(MINUTE);
    }

    assert.ok(!server.text().includes(quiet), 'a line names the address within its limit');
  });

  it('writes a line in each of two processes counting apart, as during a deployment', async () => {
    const old = logged({ sessionCreates: 1, apiCalls: 2 });
    const next = logged({ sessionCreates: 1, apiCalls: 2 });
    const address = '198.51.100.63';

    for (const server of [old, next]) {
      assert.deepEqual(await send(server, address, CALL, 6), [404, 404, 429, 429, 429, 429]);
      assertFloods(server, [{ address, counter: 'calls', refused: 3 }]);
    }
  });

  it('names a forwarded value that is no address by the one key of every such value, never by what it says, at 100, 1,000 and 10,000 characters', async () => {
    const server = logged({ sessionCreates: 60, apiCalls: 1 });
    const expected: Flood[] = [];

    for (const size of [100, 1_000, 10_000]) {
      // An end of the line's JSON and a would-be line of its own, padded:
      // forwarded by the proxy as the client's address.
      const hostile = `"}\\n{"level":60 "msg":"injected" "address":"${'9'.repeat(size)}`;

      assert.deepEqual(await send(server, hostile, CALL, 4), [404, 429, 429, 429], `${size}`);
      expected.push({ address: UNREADABLE_ADDRESS, counter: 'calls', refused: 2 });
      // Every line still parses as one line of JSON, the flood line's address
      // the shared key.
      assertFloods(server, expected);
      assert.ok(!server.text().includes('injected'), `the value of ${size} is in a line`);
      assert.ok(!server.text().includes('9'.repeat(100)), `the value of ${size} is in a line`);
      assert.ok(
        server.lines().every((line) => line.level <= WARN),
        `the value of ${size} made a line of its own`,
      );
      server.advance(MINUTE);
    }

    // A value of the shape of an address that is not one shares that key.
    for (const value of ['198.51.100.256', '2001:db8::1::2', '010.1.2.3']) {
      assert.deepEqual(await send(server, value, CALL, 4), [404, 429, 429, 429], value);
      expected.push({ address: UNREADABLE_ADDRESS, counter: 'calls', refused: 2 });
      assertFloods(server, expected);
      assert.ok(!server.text().includes(value), `${value} is in a line`);
      server.advance(MINUTE);
    }
  });
});
