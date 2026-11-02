/**
 * Capture's own pool and the gate in front of the API's work (D244), on both
 * listeners and the task's database:
 *
 * - with every connection of the API's pool held, a capture is stored
 *   promptly and `/readyz` answers `200`, while an API call waits and is
 *   answered once a connection is free;
 * - a capture committed on capture's pool pokes the realtime listener, which
 *   reads it at once: a viewer hears it with no tick;
 * - with every connection of capture's pool held, the API answers a call of
 *   every route the API's listener registers under `/api` and `/mcp`, on a
 *   private session with its key (D245, D253), the response rules' among
 *   them (D246), and the list with bodies, a list `wait`, the query with a
 *   body condition and `list_requests` over `/mcp` besides - so none of them
 *   uses capture's pool;
 * - with the gate full, the next call waits, never refused, and is answered
 *   once a slot frees, which then goes back;
 * - with the gate full, a call of every route registered under `/api` and
 *   `/mcp` waits for its turn and is answered once it comes (a census of the
 *   registered routes, criterion 3 of #243): no handler runs outside the
 *   gate; over `POST /mcp`, besides a tool call, `initialize`, `ping`,
 *   `tools/list`, a notification and a method it does not know, every
 *   message the transport and the count let through; `/mcp`'s other
 *   methods, refused `405` by their hook before any handler, are answered at
 *   once, as every refusal before a handler is;
 * - a `wait`, on the list and over `/mcp`, holds no slot while it waits;
 * - a `wait` whose client leaves while its read is under way, on the list
 *   and over `/mcp`, keeps its slot until the read settles, and no other
 *   call is let past the bound meanwhile;
 * - a change of a session, every call of the API that takes a turn of the
 *   session's line (`inOrder`, D205), holds no slot while it waits in the
 *   line behind a capture, nor in its turn: with one slot, a call on another
 *   session is answered meanwhile, and each change is answered once the line
 *   drains, while the slot is held by someone else;
 * - a JSON body refused `400` as it is read and checked is answered at once
 *   with the gate full, waiting for no turn;
 * - a call whose client goes while it waits for its turn runs no statement
 *   and leaves no slot taken.
 *
 * `api-work.test.ts` holds the gate's rules without a server. Over real
 * sockets where a client leaves; Fastify's injection elsewhere.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { MCP_PATH } from '@webhook-inspector/shared/mcp';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { awaitBlockedBy, holdEveryConnection } from '../../testing/locks.ts';
import { until, watch } from '../../testing/realtime.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import { PendingWaits } from '../requests/wait.ts';
import { createApiWorkSlots, type ApiWorkSlots } from './api-work.ts';

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};

/** The API's description, whose examples are the bodies the census sends (`routeCalls`). */
const SPEC = JSON.parse(
  readFileSync(new URL('../../../../../packages/shared/openapi.json', import.meta.url), 'utf8'),
) as {
  paths: Record<
    string,
    Record<
      string,
      {
        requestBody?: {
          content?: Record<
            string,
            { example?: unknown; examples?: Record<string, { value: unknown }> }
          >;
        };
      }
    >
  >;
};

/** Reads what the tests check, outside the pools the servers use. */
let check: pg.Pool;
const createdSessionIds: string[] = [];
const opened: { stop(): Promise<void> }[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    check = createPool(loadConfig().databaseUrl);
  })();
  await startup;
});

after(async () => {
  await startup;

  for (const each of opened.splice(0)) {
    await each.stop();
  }

  if (createdSessionIds.length > 0) {
    await check.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await check?.end();
});

interface Process {
  servers: TestServers;
  apiPool: pg.Pool;
  capturePool: pg.Pool;
  slots: ApiWorkSlots;
  waits: PendingWaits;
  /** Every `query` and `connect` the API's pool was asked for. */
  apiPoolUses: () => number;
  /** Every route the application listener registered under `/api` and `/mcp`, a method each. */
  routes: RegisteredRoute[];
}

/** A route as Fastify registered it, one method of it: `/api/sessions/:sessionId`. */
interface RegisteredRoute {
  method: string;
  url: string;
}

/**
 * A process as `index.ts` builds it, on two small pools of its own and a
 * gate of `slots` slots (D244); the API's pool counts what it is asked for.
 * `tickMs` is the realtime listener's, a minute for a test that must hear a
 * commit with no tick.
 */
async function start(
  options: { apiConnections?: number; slots?: number; tickMs?: number } = {},
): Promise<Process> {
  const url = loadConfig().databaseUrl;
  const capturePool = createPool(url, { max: 2, name: 'capture' });
  const basePool = createPool(url, { max: options.apiConnections ?? 2, name: 'api' });
  let uses = 0;
  const apiPool = new Proxy(basePool, {
    get(target, property) {
      const value = Reflect.get(target, property, target);

      if (property === 'query' || property === 'connect') {
        return (...args: unknown[]) => {
          uses += 1;

          return (value as (...args: unknown[]) => unknown).apply(target, args);
        };
      }

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  const slots = createApiWorkSlots(options.slots);
  const waits = new PendingWaits();
  const routes: RegisteredRoute[] = [];
  const servers = buildTestServers(apiPool, {
    // Both listeners report their routes; the receive host's are none of these.
    onRoute: (route) => {
      if (route.url.startsWith('/api') || route.url === MCP_PATH) {
        for (const method of ([] as string[]).concat(route.method)) {
          routes.push({ method: method.toUpperCase(), url: route.url });
        }
      }
    },
    capturePool,
    apiWorkSlots: slots,
    waits,
    ...(options.tickMs === undefined ? {} : { listener: { tickMs: options.tickMs } }),
    rateLimits: LIMITS_OUT_OF_REACH,
    // The test's own socket is the proxy, so that `X-Forwarded-For` names an address.
    trustedProxyCidrs: ['127.0.0.1/32'],
    logDestination: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });

  await servers.ready();

  let stopped = false;

  opened.push({
    stop: async () => {
      if (stopped) {
        return;
      }

      stopped = true;
      await servers.close();
      await Promise.all([capturePool.end(), basePool.end()]);
    },
  });

  return { servers, apiPool, capturePool, slots, waits, apiPoolUses: () => uses, routes };
}

/** A private session (D253) with one capture, and the key that opens it (D245). */
interface Target {
  sessionId: string;
  requestId: string;
  accessKey: string;
}

async function privateTarget(backend: Process): Promise<Target> {
  const created = await backend.servers.api.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { private: true },
  });

  assert.equal(created.statusCode, 201, created.body);

  const { id: sessionId, accessKey } = created.json() as { id: string; accessKey: string };

  createdSessionIds.push(sessionId);

  const capture = await backend.servers.receiver.inject({
    method: 'POST',
    url: `/s/${sessionId}/path`,
    payload: '{"find":"me"}',
    headers: { 'content-type': 'application/json' },
  });

  assert.equal(capture.statusCode, 200);

  return { sessionId, requestId: (capture.json() as { requestId: string }).requestId, accessKey };
}

/** One call of the census: what it is, how it is made, and whether a hook answers it before any handler. */
interface RouteCall {
  label: string;
  run: () => Promise<LightMyRequestResponse>;
  beforeHandler: boolean;
}

/**
 * The messages of `POST /mcp` the server answers itself, without a tool,
 * once the transport and the count have let them through - each takes its
 * turn in the gate as a tool call does (#243's correction round 3, the
 * outside review's finding 2): `initialize`, `ping`, `tools/list`, a
 * notification, answered `202`, and a method the server does not know.
 */
const MCP_PROTOCOL_MESSAGES: readonly (readonly [string, Record<string, unknown>])[] = [
  [
    'initialize',
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'census', version: '1.0.0' },
      },
    },
  ],
  ['ping', { jsonrpc: '2.0', id: 3, method: 'ping' }],
  ['tools/list', { jsonrpc: '2.0', id: 4, method: 'tools/list' }],
  ['a notification', { jsonrpc: '2.0', method: 'notifications/initialized' }],
  ['a method it does not know', { jsonrpc: '2.0', id: 5, method: 'resources/list' }],
];

/** The body the description gives as the first JSON example of a route's method, if any. */
function exampleBody(method: string, url: string): unknown {
  const path = url.replace(/:([A-Za-z]+)/g, '{$1}');
  const json = SPEC.paths[path]?.[method.toLowerCase()]?.requestBody?.content?.['application/json'];

  return json?.example ?? Object.values(json?.examples ?? {})[0]?.value;
}

/**
 * A call of every route `backend` registered under `/api` and `/mcp`, each
 * method of each, on `target` with its key: a session's id and a request's
 * id where the URL takes them, the description's example as the body of a
 * route that reads one, and `list_requests` as the message of `POST /mcp` -
 * and besides it each message of the protocol the server answers itself
 * (`MCP_PROTOCOL_MESSAGES`). `/mcp`'s other methods are refused `405` by
 * their hook, which reaches no handler. The deletions come last, the session's own at the very end, so
 * that every call before them finds what it names; each on a target of its
 * own when `deletions` gives one, so that none finds what another deleted
 * while they run at once - a change of a session's line runs its turn
 * outside the gate (D244), so a call behind it in the gate can overtake it.
 */
function routeCalls(
  backend: Process,
  target: Target,
  deletions: ReadonlyMap<string, Target> = new Map(),
): RouteCall[] {
  const api = backend.servers.api;
  const authorization = `Bearer ${target.accessKey}`;
  const seen = new Set<string>();
  const calls: (RouteCall & { rank: number })[] = [];

  for (const { method, url } of backend.routes) {
    const label = `${method} ${url}`;

    if (seen.has(label)) {
      continue;
    }

    seen.add(label);

    if (url === MCP_PATH) {
      calls.push({
        label,
        rank: 0,
        beforeHandler: method !== 'POST',
        run: () =>
          api.inject({
            method: method as 'POST',
            url,
            headers: { ...MCP_HEADERS, authorization },
            ...(method === 'POST'
              ? {
                  payload: {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'list_requests', arguments: { sessionId: target.sessionId } },
                  },
                }
              : {}),
          }),
      });

      if (method === 'POST') {
        for (const [name, payload] of MCP_PROTOCOL_MESSAGES) {
          calls.push({
            label: `${label} ${name}`,
            rank: 0,
            beforeHandler: false,
            run: () =>
              api.inject({
                method: 'POST',
                url,
                headers: { ...MCP_HEADERS, authorization },
                payload,
              }),
          });
        }
      }

      continue;
    }

    const own = deletions.get(label) ?? target;
    const path = url.replace(':sessionId', own.sessionId).replace(':requestId', own.requestId);
    const body = exampleBody(method, url);
    let rank = 0;

    if (method === 'DELETE') {
      rank = url === '/api/sessions/:sessionId' ? 2 : 1;
    }

    calls.push({
      label,
      rank,
      beforeHandler: false,
      run: () =>
        api.inject({
          method: method as 'GET',
          url: path,
          headers: {
            authorization: `Bearer ${own.accessKey}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
        }),
    });
  }

  return calls
    .sort((a, b) => a.rank - b.rank)
    .map(({ label, run, beforeHandler }) => ({
      label,
      run,
      beforeHandler,
    }));
}

/** The routes added since #213's branch, which the census must hold (D245, D246, D253). */
const NEWER_ROUTES = [
  'PUT /api/sessions/:sessionId/rules',
  'POST /api/sessions/:sessionId/queue/restart',
  'DELETE /api/sessions/:sessionId/queue',
  'POST /api/sessions/status',
  'POST /api/sessions',
  'POST /mcp',
];

/** The keys of a path item of the description that are operations. */
const HTTP_METHODS = new Set(['get', 'head', 'put', 'post', 'patch', 'delete', 'options', 'trace']);

/** Records a session a call created, so that it is removed afterwards. */
function keepCreated(answer: LightMyRequestResponse): void {
  if (answer.statusCode === 201) {
    const id = (answer.json() as { id?: unknown }).id;

    if (typeof id === 'string') {
      createdSessionIds.push(id);
    }
  }
}

async function newSession(backend: Process): Promise<string> {
  const answer = await backend.servers.api.inject({ method: 'POST', url: '/api/sessions' });

  assert.equal(answer.statusCode, 201);

  const id = (answer.json() as { id: string }).id;

  createdSessionIds.push(id);

  return id;
}

/** What `promise` settles with within `ms`, or `'pending'`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([promise, delay(ms).then(() => 'pending' as const)]);
}

async function stored(sessionId: string): Promise<number> {
  const { rows } = await check.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM requests WHERE session_id = $1',
    [sessionId],
  );

  return rows[0]?.n ?? 0;
}

describe('capture’s own pool (D244)', () => {
  it('stores a capture promptly and answers /readyz 200 with every API connection held, while the API call waits', async () => {
    const backend = await start();
    const sessionId = await newSession(backend);
    const held = await holdEveryConnection(backend.apiPool);

    try {
      const startedAt = Date.now();
      const capture = await within(
        backend.servers.receiver.inject({
          method: 'POST',
          url: `/s/${sessionId}`,
          payload: '{"held":"every API connection"}',
          headers: { 'content-type': 'application/json' },
        }),
        5_000,
      );

      assert.notEqual(capture, 'pending', 'the capture waited for the API’s pool');
      assert.equal(capture === 'pending' ? 0 : capture.statusCode, 200);
      assert.ok(Date.now() - startedAt < 2_000, `stored after ${Date.now() - startedAt} ms`);
      assert.equal(await stored(sessionId), 1);

      const ready = await within(backend.servers.api.inject({ url: '/readyz' }), 5_000);

      assert.notEqual(ready, 'pending', 'readiness waited for the API’s pool');
      assert.equal(ready === 'pending' ? 0 : ready.statusCode, 200);

      // The API call waits for a connection of its own pool, and is answered once one frees.
      const read = backend.servers.api.inject({ url: `/api/sessions/${sessionId}` });

      assert.equal(await within(read, 300), 'pending');
      held.release();

      const answer = await read;

      assert.equal(answer.statusCode, 200);
      assert.equal((answer.json() as { requestsCount: number }).requestsCount, 1);
    } finally {
      held.release();
    }
  });

  it('pokes the realtime listener with a capture committed on capture’s pool, so that a viewer hears it with no tick', async () => {
    const backend = await start({ tickMs: 60_000 });
    const sessionId = await newSession(backend);
    const listener = backend.servers.listener;
    const poke = listener.poke.bind(listener);
    let poked = 0;

    listener.poke = () => {
      poked += 1;
      poke();
    };

    await backend.servers.api.listen({ host: '127.0.0.1', port: 0 });

    const port = (backend.servers.api.server.address() as net.AddressInfo).port;
    const viewer = await watch(port, sessionId);

    try {
      const startedAt = Date.now();
      const capture = await backend.servers.receiver.inject({
        method: 'POST',
        url: `/s/${sessionId}`,
        payload: 'heard at once',
      });

      assert.equal(capture.statusCode, 200);
      assert.ok(poked >= 1, 'the capture’s commit did not poke the listener');

      const [event] = await viewer.received(1, 2_000);

      assert.equal(event?.type, 'request.received');
      assert.ok(Date.now() - startedAt < 2_000, `heard after ${Date.now() - startedAt} ms`);
    } finally {
      viewer.close();
      listener.poke = poke;
    }
  });

  it('answers a call of every route under /api and /mcp, and the list’s and the query’s other kinds, with every connection of capture’s pool held', async () => {
    const backend = await start();
    const target = await privateTarget(backend);
    const { sessionId, requestId, accessKey } = target;
    const authorization = `Bearer ${accessKey}`;
    const census = routeCalls(backend, target);
    const labels = census.map((call) => call.label);

    for (const route of NEWER_ROUTES) {
      assert.ok(labels.includes(route), `the census lacks ${route}`);
    }

    const held = await holdEveryConnection(backend.capturePool);

    try {
      const api = backend.servers.api;
      // Besides one call of each route - `list_requests` the census's call of
      // `POST /mcp` - the kinds of a route's call that read otherwise: the
      // list with bodies, a wait, and the query with a body condition.
      const kinds: RouteCall[] = [
        `/api/sessions/${sessionId}/requests?include=body,headers`,
        `/api/sessions/${sessionId}/requests?wait=1&after=${requestId}`,
      ].map((url) => ({
        label: `GET ${url}`,
        beforeHandler: false,
        run: () => api.inject({ url, headers: { authorization } }),
      }));

      kinds.push({
        label: 'POST query with a body condition',
        beforeHandler: false,
        run: () =>
          api.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/requests/query`,
            headers: { authorization },
            payload: { include: ['body'], body: ['find'] },
          }),
      });

      // Deletions last, as the census orders them.
      const firstDeletion = census.findIndex((call) => call.label.startsWith('DELETE '));
      const calls = [...census.slice(0, firstDeletion), ...kinds, ...census.slice(firstDeletion)];

      for (const call of calls) {
        const answer = await within(call.run(), 5_000);

        assert.notEqual(answer, 'pending', `${call.label} waited for capture’s pool`);

        if (answer !== 'pending') {
          keepCreated(answer);

          if (call.beforeHandler) {
            assert.equal(answer.statusCode, 405, `${call.label}: ${answer.statusCode}`);
          } else {
            assert.ok(
              answer.statusCode < 300,
              `${call.label}: ${answer.statusCode} ${answer.body.slice(0, 300)}`,
            );
          }
        }
      }
    } finally {
      held.release();
    }
  });
});

describe('the gate in front of the API’s work (D244)', () => {
  it('makes the next call wait while the gate is full, never refusing it, and answers it once a slot frees', async () => {
    const backend = await start({ slots: 1 });
    const sessionId = await newSession(backend);
    const holder = await backend.slots.take('the test', new AbortController().signal);

    assert.ok(holder !== null);

    const read = backend.servers.api.inject({ url: `/api/sessions/${sessionId}/requests` });

    assert.equal(await within(read, 300), 'pending');
    assert.equal(backend.slots.waiting, 1);

    holder();

    const answer = await read;

    assert.equal(answer.statusCode, 200);
    assert.deepEqual(answer.json(), []);
    await until(() => backend.slots.taken === 0, 'the slot to go back');
  });

  it('makes a call of every route registered under /api and /mcp wait for its turn while the gate is full, those of D245 and D246 included, and answers each once its turn comes', async () => {
    const backend = await start({ slots: 1 });
    const target = await privateTarget(backend);
    const labels = routeCalls(backend, target).map((call) => call.label);
    // Each deletion on a session of its own: they run at once here.
    const deletions = new Map<string, Target>();

    for (const label of labels.filter((each) => each.startsWith('DELETE '))) {
      deletions.set(label, await privateTarget(backend));
    }

    const census = routeCalls(backend, target, deletions);

    for (const route of NEWER_ROUTES) {
      assert.ok(labels.includes(route), `the census lacks ${route}`);
    }

    for (const [name] of MCP_PROTOCOL_MESSAGES) {
      assert.ok(labels.includes(`POST /mcp ${name}`), `the census lacks POST /mcp ${name}`);
    }

    // Every operation the API's description gives under `/api` and `/mcp` is
    // among the routes registered (`openapi.test.ts` holds the two the same),
    // each with a call here.
    for (const [path, item] of Object.entries(SPEC.paths)) {
      if (!path.startsWith('/api') && path !== MCP_PATH) {
        continue;
      }

      for (const method of Object.keys(item).filter((key) => HTTP_METHODS.has(key))) {
        const label = `${method.toUpperCase()} ${path.replace(/\{([A-Za-z]+)\}/g, ':$1')}`;

        assert.ok(labels.includes(label), `the census lacks ${label}`);
      }
    }

    const holder = await backend.slots.take('the test', new AbortController().signal);

    assert.ok(holder !== null);

    const waiting: { label: string; answer: Promise<LightMyRequestResponse> }[] = [];

    try {
      for (const call of census) {
        const answer = call.run();

        if (call.beforeHandler) {
          // Refused by its hook before any handler, as a `415` is: answered at once.
          const refused = await within(answer, 2_000);

          assert.notEqual(refused, 'pending', `${call.label} waited for the gate`);
          assert.equal(refused === 'pending' ? 0 : refused.statusCode, 405, call.label);
          continue;
        }

        waiting.push({ label: call.label, answer });
        await until(
          () => backend.slots.waiting === waiting.length,
          `${call.label} to wait for its turn`,
        );
      }

      // Nothing of them has been answered while the slot was held.
      for (const each of waiting) {
        assert.equal(await within(each.answer, 0), 'pending', `${each.label} was answered`);
      }

      assert.equal(backend.slots.taken, 1);
    } finally {
      holder();
    }

    for (const each of waiting) {
      const answer = await within(each.answer, 10_000);

      assert.notEqual(answer, 'pending', `${each.label} was never answered`);

      if (answer !== 'pending') {
        keepCreated(answer);
        assert.ok(
          answer.statusCode < 300,
          `${each.label}: ${answer.statusCode} ${answer.body.slice(0, 300)}`,
        );
      }
    }

    await until(
      () => backend.slots.taken === 0 && backend.slots.waiting === 0,
      'every slot to go back',
    );
  });

  it('holds no slot for a wait while it waits, on the list and over /mcp', async () => {
    const backend = await start({ slots: 1 });
    const sessionId = await newSession(backend);
    const listWait = backend.servers.api.inject({
      url: `/api/sessions/${sessionId}/requests?wait=10`,
    });
    const mcpWait = backend.servers.api.inject({
      method: 'POST',
      url: '/mcp',
      headers: MCP_HEADERS,
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'wait_for_request', arguments: { sessionId, wait: 10 } },
      },
    });

    // Each holds a slot for its first read, and none once that read found nothing.
    await until(
      () => backend.waits.size === 2 && backend.slots.taken === 0 && backend.slots.waiting === 0,
      'both waits to wait holding no slot',
    );
    await delay(200);
    assert.equal(backend.waits.size, 2);
    assert.equal(backend.slots.taken, 0, 'a wait kept its slot while it waited');

    // With one slot, another call is answered at once meanwhile.
    const read = await within(
      backend.servers.api.inject({ url: `/api/sessions/${sessionId}` }),
      2_000,
    );

    assert.notEqual(read, 'pending');

    // A capture ends both, each reading in its turn.
    const capture = await backend.servers.receiver.inject({
      method: 'POST',
      url: `/s/${sessionId}`,
      payload: 'one',
    });

    assert.equal(capture.statusCode, 200);

    const [listed, called] = await Promise.all([listWait, mcpWait]);

    assert.equal(listed.statusCode, 200);
    assert.equal((listed.json() as unknown[]).length, 1);
    assert.equal(called.statusCode, 200);
    assert.equal(
      (called.json() as { result: { structuredContent: { requests: unknown[] } } }).result
        .structuredContent.requests.length,
      1,
    );
    await until(() => backend.slots.taken === 0 && backend.slots.waiting === 0, 'every slot back');
  });

  it('keeps the slot of a wait’s read under way when its client leaves, on the list and over /mcp, and lets no other call past the bound until the read settles', async () => {
    for (const over of ['the list', '/mcp'] as const) {
      const backend = await start({ slots: 1 });
      const sessionId = await newSession(backend);

      await backend.servers.api.listen({ host: '127.0.0.1', port: 0 });

      const port = (backend.servers.api.server.address() as net.AddressInfo).port;
      const socket = net.connect(port, '127.0.0.1');
      const message = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'wait_for_request', arguments: { sessionId, wait: 10 } },
      });

      socket.on('error', () => undefined);
      socket.write(
        over === 'the list'
          ? `GET /api/sessions/${sessionId}/requests?wait=10 HTTP/1.1\r\nHost: t\r\n` +
              'X-Forwarded-For: 203.0.113.1\r\n\r\n'
          : `POST /mcp HTTP/1.1\r\nHost: t\r\nX-Forwarded-For: 203.0.113.1\r\n` +
              'Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n' +
              `MCP-Protocol-Version: 2025-11-25\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n` +
              message,
      );

      // Its first read found nothing: it waits, holding no slot.
      await until(
        () => backend.waits.size === 1 && backend.slots.taken === 0,
        `the wait ${over === 'the list' ? 'on the list' : 'over /mcp'} to wait holding no slot`,
      );

      // With every connection of the API's pool held, a capture - stored on
      // capture's own pool - is announced to the wait, whose next read takes
      // the one slot and waits for a connection: a read under way.
      const held = await holdEveryConnection(backend.apiPool);

      try {
        const capture = await backend.servers.receiver.inject({
          method: 'POST',
          url: `/s/${sessionId}`,
          payload: 'one',
        });

        assert.equal(capture.statusCode, 200);
        await until(() => backend.slots.taken === 1, 'the wait’s read to take the slot');

        // Its client leaves: the wait ends and its handler settles, the read
        // still waiting for its connection.
        socket.destroy();
        await until(() => backend.waits.size === 0, 'the wait to end');
        await delay(100);
        assert.equal(backend.slots.taken, 1, `${over}: the slot went back with its read under way`);

        // Another address's call waits for its turn, and runs no statement.
        const uses = backend.apiPoolUses();
        const other = backend.servers.api.inject({ url: `/api/sessions/${sessionId}` });

        await until(() => backend.slots.waiting === 1, 'the other call to wait for its turn');
        await delay(100);
        assert.equal(backend.apiPoolUses(), uses, `${over}: another call ran past the bound`);
        assert.equal(backend.slots.taken, 1);

        // The read gets its connection and settles; the other call's turn comes.
        held.release();

        const answer = await within(other, 5_000);

        assert.notEqual(answer, 'pending', `${over}: the other call was never answered`);
        assert.equal(answer === 'pending' ? 0 : answer.statusCode, 200);
      } finally {
        held.release();
      }

      await until(
        () => backend.slots.taken === 0 && backend.slots.waiting === 0,
        'every slot to go back',
      );
    }
  });

  it('reads no content for a list with bodies whose client goes at its head while its read waits for a turn', async () => {
    const backend = await start({ slots: 1 });
    const sessionId = await newSession(backend);

    for (const body of ['one', 'two']) {
      const capture = await backend.servers.receiver.inject({
        method: 'POST',
        url: `/s/${sessionId}`,
        payload: body,
      });

      assert.equal(capture.statusCode, 200);
    }

    await backend.servers.api.listen({ host: '127.0.0.1', port: 0 });

    const port = (backend.servers.api.server.address() as net.AddressInfo).port;
    const holder = await backend.slots.take('the test', new AbortController().signal);

    assert.ok(holder !== null);

    const socket = net.connect(port, '127.0.0.1');
    let received = '';

    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
    });
    socket.write(
      `GET /api/sessions/${sessionId}/requests?include=body HTTP/1.1\r\nHost: t\r\n` +
        'X-Forwarded-For: 203.0.113.1\r\n\r\n',
    );
    await until(() => backend.slots.waiting === 1, 'the list to wait for its turn');

    // Another's work comes next once the list's answer has begun, so its first
    // content read waits for a turn.
    const other = backend.slots.take('another address', new AbortController().signal);

    holder();
    await until(() => received.includes('\r\n\r\n'), 'the answer’s head');

    const otherRelease = await other;

    await until(() => backend.slots.waiting === 1, 'the content read to wait for its turn');

    const usesAtHead = backend.apiPoolUses();

    socket.destroy();
    await until(() => backend.slots.waiting === 0, 'the content read to leave the queue');
    otherRelease?.();
    await delay(100);
    assert.equal(backend.apiPoolUses(), usesAtHead, 'a content read ran for a client gone');
    assert.equal(backend.slots.taken, 0);
    assert.match(received, /^HTTP\/1\.1 200 /);
  });

  it('runs no statement for a call whose client goes while it waits for its turn, and leaves no slot taken', async () => {
    const backend = await start({ slots: 1 });
    const sessionId = await newSession(backend);
    const port = await (async () => {
      await backend.servers.api.listen({ host: '127.0.0.1', port: 0 });

      return (backend.servers.api.server.address() as net.AddressInfo).port;
    })();
    const holder = await backend.slots.take('the test', new AbortController().signal);

    assert.ok(holder !== null);

    // A list with bodies and a query, each from an address of its own, whose clients go.
    const sockets = [
      `GET /api/sessions/${sessionId}/requests?include=body HTTP/1.1\r\nHost: t\r\nX-Forwarded-For: 203.0.113.1\r\n\r\n`,
      `POST /api/sessions/${sessionId}/requests/query HTTP/1.1\r\nHost: t\r\nX-Forwarded-For: 203.0.113.2\r\n` +
        'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
    ].map((head) => {
      const socket = net.connect(port, '127.0.0.1');

      socket.on('error', () => undefined);
      socket.write(head);

      return socket;
    });

    await until(() => backend.slots.waiting === 2, 'both calls to wait for their turn');

    const usesBefore = backend.apiPoolUses();

    for (const socket of sockets) {
      socket.destroy();
    }

    await until(() => backend.slots.waiting === 0, 'both calls to leave the queue');
    holder();
    await delay(100);
    assert.equal(backend.apiPoolUses(), usesBefore, 'a call whose client had gone ran a statement');
    assert.equal(backend.slots.taken, 0);

    // The slot is whole: the next call is answered at once.
    const answer = await within(
      backend.servers.api.inject({ url: `/api/sessions/${sessionId}/requests` }),
      2_000,
    );

    assert.notEqual(answer, 'pending');
    assert.equal(backend.slots.taken, 0);
  });

  it('holds no slot for a change while it waits in its session’s line behind a capture, nor in its turn, for every call that takes a turn: a call on another session is answered meanwhile, and each change once the line drains', async () => {
    const backend = await start({ slots: 1 });
    const lined = await newSession(backend);
    const other = await newSession(backend);
    const api = backend.servers.api;
    const hub = backend.servers.hub;
    const inOrder = hub.inOrder.bind(hub);
    let joined = 0;

    // Counts the calls that join the held session's line, the capture's among them.
    hub.inOrder = (<T>(sessionId: string, change: () => Promise<T>): Promise<T> => {
      if (sessionId === lined) {
        joined += 1;
      }

      return inOrder(sessionId, change);
    }) as typeof hub.inOrder;

    const route = (method: 'PUT' | 'POST' | 'DELETE', url: string) => () => {
      const body = exampleBody(method, url);

      return api.inject({
        method,
        url: url.replace(':sessionId', lined),
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
      });
    };
    const tool = (name: string, args: Record<string, unknown>) => () =>
      api.inject({
        method: 'POST',
        url: '/mcp',
        headers: MCP_HEADERS,
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: { sessionId: lined, ...args } },
        },
      });
    // Every call of the API and of `/mcp` that takes a turn of a session's
    // line (`inOrder`, D205), in an order in which each finds what it needs.
    const changes = [
      { label: 'PUT .../response', run: route('PUT', '/api/sessions/:sessionId/response') },
      { label: 'PUT .../queue', run: route('PUT', '/api/sessions/:sessionId/queue') },
      {
        label: 'POST .../queue/restart',
        run: route('POST', '/api/sessions/:sessionId/queue/restart'),
      },
      { label: 'DELETE .../queue', run: route('DELETE', '/api/sessions/:sessionId/queue') },
      { label: 'PUT .../rules', run: route('PUT', '/api/sessions/:sessionId/rules') },
      { label: 'DELETE .../requests', run: route('DELETE', '/api/sessions/:sessionId/requests') },
      { label: 'set_response over /mcp', run: tool('set_response', { mode: 'default' }) },
      { label: 'clear_requests over /mcp', run: tool('clear_requests', {}) },
    ];

    // A capture holds the session's line: in its turn, it waits for the
    // session row, which the test holds.
    const holder = await check.connect();
    let rowHeld = true;
    let slot: (() => void) | null = null;

    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [lined]);

      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const capture = backend.servers.receiver.inject({
        method: 'POST',
        url: `/s/${lined}`,
        payload: 'held in its turn',
      });

      await awaitBlockedBy(check, rows[0]?.pid ?? 0);
      assert.equal(joined, 1);

      const answers: { label: string; answer: Promise<LightMyRequestResponse> }[] = [];

      for (const change of changes) {
        answers.push({ label: change.label, answer: change.run() });
        // It passes the gate, gives its slot back and joins the line.
        await until(() => joined === answers.length + 1, `${change.label} to join the line`);
        await until(
          () => backend.slots.taken === 0 && backend.slots.waiting === 0,
          `${change.label} to hold no slot in the line`,
        );
      }

      // With the gate's one slot, a call on another session is answered meanwhile.
      const read = await within(api.inject({ url: `/api/sessions/${other}` }), 2_000);

      assert.notEqual(read, 'pending', 'a change waiting in its session’s line held the slot');
      assert.equal(read === 'pending' ? 0 : read.statusCode, 200);

      for (const each of answers) {
        assert.equal(await within(each.answer, 0), 'pending', `${each.label} was answered`);
      }

      // The gate's one slot is taken elsewhere: the changes' turns need none.
      slot = await backend.slots.take('another address', new AbortController().signal);
      assert.ok(slot !== null);

      await holder.query('ROLLBACK');
      rowHeld = false;

      const captured = await within(capture, 10_000);

      assert.notEqual(captured, 'pending', 'the capture was never stored');
      assert.equal(captured === 'pending' ? 0 : captured.statusCode, 200);

      for (const each of answers) {
        const answer = await within(each.answer, 10_000);

        assert.notEqual(answer, 'pending', `${each.label} waited for a slot in its turn`);

        if (answer !== 'pending') {
          assert.ok(
            answer.statusCode < 300,
            `${each.label}: ${answer.statusCode} ${answer.body.slice(0, 300)}`,
          );

          if (each.label.endsWith('over /mcp')) {
            const { result } = answer.json() as { result?: { isError?: boolean } };

            assert.ok(result !== undefined && result.isError !== true, answer.body.slice(0, 300));
          }
        }
      }

      assert.equal(backend.slots.waiting, 0, 'a turn waited for the slot');
      assert.equal(backend.slots.taken, 1, 'a turn took a slot');
    } finally {
      if (rowHeld) {
        await holder.query('ROLLBACK');
      }

      holder.release();
      slot?.();
      hub.inOrder = inOrder;
    }

    await until(() => backend.slots.taken === 0 && backend.slots.waiting === 0, 'every slot back');
  });

  it('answers a JSON body refused 400 as it is read and checked at once with the gate full, at growing sizes, waiting for no turn', async () => {
    const backend = await start({ slots: 1 });
    const sessionId = await newSession(backend);
    const api = backend.servers.api;
    const holder = await backend.slots.take('the test', new AbortController().signal);

    assert.ok(holder !== null);

    /** The body, its refusal, and the routes it is sent to. */
    const cases: { label: string; payload: string; errorCode: number; urls: string[] }[] = [];
    // The seven routes that read a JSON body (D244 point 7).
    const everyJsonRoute = [
      'POST /api/sessions',
      `PUT /api/sessions/${sessionId}/response`,
      `PUT /api/sessions/${sessionId}/queue`,
      `PUT /api/sessions/${sessionId}/rules`,
      'POST /api/sessions/status',
      `POST /api/sessions/${sessionId}/requests/search`,
      `POST /api/sessions/${sessionId}/requests/query`,
    ];

    // Not JSON: cut off inside a string, from a byte to past the 128 KiB a
    // large body starts at, under the 1 MiB every JSON route reads.
    for (const size of [1, 1_024, 65_536, 262_144, 900_000]) {
      cases.push({
        label: `${size} bytes not JSON`,
        payload: `{"a":"${'x'.repeat(size)}`,
        errorCode: 1006,
        urls: size === 1 ? everyJsonRoute : [`PUT /api/sessions/${sessionId}/response`],
      });
    }

    // JSON that a change's rules refuse.
    cases.push({
      label: 'a response change of no mode',
      payload: JSON.stringify({ mode: 'nope' }),
      errorCode: 1005,
      urls: [`PUT /api/sessions/${sessionId}/response`],
    });

    try {
      for (const each of cases) {
        for (const target of each.urls) {
          const [method, url] = target.split(' ') as ['PUT' | 'POST', string];
          const answer = await within(
            api.inject({
              method,
              url,
              headers: { 'content-type': 'application/json' },
              payload: each.payload,
            }),
            2_000,
          );

          assert.notEqual(answer, 'pending', `${target}, ${each.label}: waited for the gate`);

          if (answer !== 'pending') {
            assert.equal(answer.statusCode, 400, `${target}, ${each.label}: ${answer.body}`);
            assert.equal(
              (answer.json() as { errorCode: number }).errorCode,
              each.errorCode,
              `${target}, ${each.label}: ${answer.body}`,
            );
          }

          assert.equal(backend.slots.waiting, 0, `${target}, ${each.label}: waited for a turn`);
        }
      }

      assert.equal(backend.slots.taken, 1);
    } finally {
      holder();
    }
  });
});
