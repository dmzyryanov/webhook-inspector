/**
 * Two backend processes on one database, as a rolling update runs them (#132,
 * criteria 1 to 5; D221): two instances, each with its pool, its listeners,
 * its hub and its realtime listener, built on the task's database. What one
 * changes reaches the viewers and the waits of the other through the outbox,
 * each event once, the events that move a session's queue in the order the
 * changes took the session row's lock and a request's recorded response after
 * the request; a large event arrives whole; a deletion closes the viewers of
 * both; and an
 * instance whose listening connection is cut cuts its viewers, answers its
 * waits, listens again and delivers what comes next, with nothing lost to a
 * viewer that reloads; and an instance whose read a deletion or a new viewer
 * overtakes while its payloads are fetched leaves nobody with a stale view.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import {
  WsCloseCode,
  type RequestListItem,
  type ServerEvent,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { escapedFullResponse, largestQueueBody } from '../../testing/full-queue.ts';
import { largestRulesBody } from '../../testing/full-rules.ts';
import {
  closeSockets,
  refused,
  until,
  watch,
  withoutReading,
  type Viewer,
  type ViewerEvent,
} from '../../testing/realtime.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import { SESSION_ACCESS_SQL } from '../sessions/access-key.ts';

interface Instance {
  name: string;
  pool: pg.Pool;
  servers: TestServers;
  port: number;
}

let a: Instance;
let b: Instance;
/** Holds `b`'s next lookup of a session by the realtime route, once armed. */
let holdNextLookup: { reached: () => void; release: Promise<void> } | undefined;
/** What `b`'s realtime listener waits for before it connects again after a loss. */
let reconnectGate: Promise<void> = Promise.resolve();
/** Holds `b`'s next fetch of payloads that includes one of `ids`, once armed (D221). */
let holdNextFetch:
  { ids: ReadonlySet<string>; reached: () => void; release: Promise<void> } | undefined;
const created: string[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

async function listening(server: FastifyInstance): Promise<number> {
  await server.listen({ host: '127.0.0.1', port: 0 });

  return (server.server.address() as AddressInfo).port;
}

async function instance(name: string, pool: pg.Pool): Promise<Instance> {
  const servers = buildTestServers(pool, {
    listener: {
      beforeReconnect: () => reconnectGate,
      beforeFetch: async (ids) => {
        const armed = holdNextFetch;

        if (name === 'b' && armed !== undefined && ids.some((id) => armed.ids.has(id))) {
          holdNextFetch = undefined;
          armed.reached();
          await armed.release;
        }
      },
      firstRetryMs: 50,
    },
  });

  servers.api.log.level = 'silent';
  servers.receiver.log.level = 'silent';

  const port = await listening(servers.api);

  await servers.receiver.ready();

  return { name, pool, servers, port };
}

before(async () => {
  startup = (async () => {
    const poolA = createPool(loadConfig().databaseUrl);
    const baseB = createPool(loadConfig().databaseUrl);
    // `b`'s pool can hold the realtime route's lookup of a session (D198).
    const poolB = new Proxy(baseB, {
      get(target, property) {
        if (property === 'query') {
          return async (...args: unknown[]) => {
            const result = await (target.query as (...values: unknown[]) => Promise<unknown>)(
              ...args,
            );
            const armed = holdNextLookup;

            // The lookup the realtime route makes (`sessionAccess`).
            if (armed && args[0] === SESSION_ACCESS_SQL) {
              holdNextLookup = undefined;
              armed.reached();
              await armed.release;
            }

            return result;
          };
        }

        const value = Reflect.get(target, property, target);

        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });

    a = await instance('a', poolA);
    b = await instance('b', poolB);
  })();
  await startup;
});

after(async () => {
  await startup?.catch(() => undefined);
  closeSockets();

  if (created.length > 0) {
    await a.pool.query('DELETE FROM sessions WHERE id = ANY($1)', [created]);
  }

  for (const each of [a, b]) {
    await each?.servers.close();
    await each?.pool.end();
  }
});

async function newSession(on: Instance = a, body?: object): Promise<string> {
  const response = await on.servers.api.inject({
    method: 'POST',
    url: '/api/sessions',
    ...(body ? { payload: body } : {}),
  });

  assert.equal(response.statusCode, 201, response.body);

  const { id } = response.json<{ id: string }>();

  created.push(id);

  return id;
}

async function capture(on: Instance, sessionId: string, payload = '{}'): Promise<string> {
  const response = await on.servers.receiver.inject({
    method: 'POST',
    url: `/s/${sessionId}`,
    headers: { 'content-type': 'application/json' },
    payload,
  });

  assert.ok(response.statusCode < 600, response.body);

  return String(response.headers['x-qa-tools-request-id']);
}

function api(
  on: Instance,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return on.servers.api.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

/**
 * Lets both instances deliver everything committed so far: each has sent it
 * when this resolves, which is not yet each viewer having read it. Assert
 * what a viewer received after `arrived`, or after `sentBefore`.
 */
async function flushBoth(): Promise<void> {
  await Promise.all([a.servers.flush(), b.servers.flush()]);
}

/** How long `arrived` and `sentBefore` wait for what a viewer was sent. */
const ARRIVAL_MS = 10_000;

/**
 * Waits, bounded, until `viewer` has received `count` events. A flush resolves
 * once an instance has sent what it read; the viewer's side of the connection
 * reads it later, on a loaded machine late enough for an assertion made at
 * once to find it missing (docs/testing/flakes.md). Nothing is waited for an
 * assertion that nothing arrived: that one is made at once, after a flush.
 */
async function arrived(viewer: Viewer, count: number): Promise<void> {
  await viewer.received(count, ARRIVAL_MS);
}

function types(events: ServerEvent[]): string[] {
  return events.map((event) => event.type);
}

describe('across processes (criterion 1, D221)', () => {
  for (const [writerName, readerName] of [
    ['a', 'b'],
    ['b', 'a'],
  ] as const) {
    it(`every event of a change ${writerName} handles reaches viewers and waits of both, each once`, async () => {
      const writer = writerName === 'a' ? a : b;
      const reader = readerName === 'a' ? a : b;
      const sessionId = await newSession(writer);
      const viewers = await Promise.all([
        watch(reader.port, sessionId),
        watch(writer.port, sessionId),
      ]);
      const expected: string[] = [];
      const next = async (type: string): Promise<void> => {
        expected.push(type);

        for (const viewer of viewers) {
          await viewer.received(expected.length);
        }
      };

      // A capture, answered by a wait of the other instance, and its recorded response.
      const waiting = api(reader, 'GET', `/api/sessions/${sessionId}/requests?wait=10`);

      await until(() => reader.servers.hub.countFor(sessionId) === 2, 'the wait to subscribe');

      const requestId = await capture(writer, sessionId);
      const waited = await waiting;

      assert.equal(waited.statusCode, 200);
      assert.deepEqual(
        waited.json<RequestListItem[]>().map((item) => item.id),
        [requestId],
      );
      await next('request.received');
      await next('response.recorded');

      // A response change, a queue saved, started again and removed.
      assert.equal(
        (
          await api(writer, 'PUT', `/api/sessions/${sessionId}/response`, {
            mode: 'custom',
            response: { status: 202 },
          })
        ).statusCode,
        200,
      );
      await next('session.updated');
      assert.equal(
        (
          await api(writer, 'PUT', `/api/sessions/${sessionId}/queue`, {
            steps: [{ status: 501 }, { status: 502 }],
          })
        ).statusCode,
        200,
      );
      await next('session.updated');
      assert.equal(
        (await api(writer, 'POST', `/api/sessions/${sessionId}/queue/restart`)).statusCode,
        200,
      );
      await next('session.updated');
      assert.equal(
        (await api(writer, 'DELETE', `/api/sessions/${sessionId}/queue`)).statusCode,
        200,
      );
      await next('session.updated');

      // A request deleted.
      assert.equal(
        (await api(writer, 'DELETE', `/api/sessions/${sessionId}/requests/${requestId}`))
          .statusCode,
        204,
      );
      await next('request.deleted');

      // A clear, answering a wait of the other instance `[]`.
      const clearedWait = api(reader, 'GET', `/api/sessions/${sessionId}/requests?wait=10`);

      await until(() => reader.servers.hub.countFor(sessionId) === 2, 'the wait to subscribe');
      assert.equal(
        (await api(writer, 'DELETE', `/api/sessions/${sessionId}/requests`)).statusCode,
        204,
      );
      assert.equal((await clearedWait).body, '[]');
      await next('requests.cleared');

      await flushBoth();

      for (const viewer of viewers) {
        assert.deepEqual(types(viewer.events), expected);
        assert.equal(viewer.isOpen(), true);
      }

      // The states the session events carry are the ones the calls answered.
      const updates = viewers[0]?.events.filter((event) => event.type === 'session.updated') ?? [];

      assert.equal(updates.length, 4);
      assert.equal(
        (updates[1] as { data: SessionResponseState }).data.queue?.total,
        2,
        'the queue saved',
      );
      assert.equal((updates[3] as { data: SessionResponseState }).data.queue, null, 'removed');

      for (const viewer of viewers) {
        viewer.close();
      }
    });
  }

  it('announces nothing for a change that rolled back, and a refused change neither', async () => {
    const sessionId = await newSession(a);
    const viewer = await watch(b.port, sessionId);

    assert.equal(
      (await api(a, 'PUT', `/api/sessions/${sessionId}/response`, { mode: 'nonsense' })).statusCode,
      400,
    );
    assert.equal(
      (
        await api(
          a,
          'DELETE',
          `/api/sessions/${sessionId}/requests/00000000-0000-4000-8000-000000000000`,
        )
      ).statusCode,
      404,
    );

    const client = await a.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO realtime_events (session_id, kind, payload) VALUES ($1, 'requests.cleared', '{"type":"requests.cleared"}')`,
        [sessionId],
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    await flushBoth();
    assert.deepEqual(viewer.events, []);
    viewer.close();
  });
});

/**
 * What the order promises (D205 point 12, D221 point 6): the events that move
 * a session's queue - `request.received`, `session.updated`,
 * `requests.cleared` - are appended under the session row's lock, each after
 * the one before it committed, so their ids, and what every viewer receives,
 * follow the lock; a request's `response.recorded` comes after its own
 * `request.received`, appended once that capture committed. Against the
 * queue's other events a `response.recorded` is not ordered: it takes no lock
 * of the session, so it may draw its id before a later capture takes the lock
 * and commit after that capture, and a read then delivers the later capture,
 * and the next read the completion. Nothing sets the queue from it (D205
 * point 6).
 */
const MOVES_THE_QUEUE: ReadonlySet<string> = new Set([
  'request.received',
  'session.updated',
  'requests.cleared',
]);

function movesTheQueue(event: ViewerEvent): boolean {
  return MOVES_THE_QUEUE.has(event.type);
}

/** The session's outbox, in id order, each row as the event it announces. */
async function outbox(sessionId: string): Promise<ViewerEvent[]> {
  const { rows } = await a.pool.query<{ payload: string }>(
    'SELECT payload FROM realtime_events WHERE session_id = $1 ORDER BY id',
    [sessionId],
  );

  return rows.map((row) => JSON.parse(row.payload) as ViewerEvent);
}

/** A ten-step queue and four viewers, two on each instance. */
async function queueWatchedOnBoth(): Promise<{ sessionId: string; viewers: Viewer[] }> {
  const steps = Array.from({ length: 10 }, (_, index) => ({ status: 520 + index }));
  const sessionId = await newSession(a, {
    response: { status: 200 },
    queue: { steps },
  });
  const viewers = await Promise.all([
    watch(a.port, sessionId),
    watch(a.port, sessionId),
    watch(b.port, sessionId),
    watch(b.port, sessionId),
  ]);

  return { sessionId, viewers };
}

/**
 * Sixteen captures and restarts, alternately on the two instances, all at
 * once, then every completion they started written.
 */
async function moveTheQueueFromBoth(sessionId: string): Promise<void> {
  const calls: Promise<unknown>[] = [];

  for (let index = 0; index < 16; index += 1) {
    const on = index % 2 === 0 ? a : b;

    calls.push(
      index % 5 === 4
        ? api(on, 'POST', `/api/sessions/${sessionId}/queue/restart`)
        : capture(on, sessionId, `{"n":${index}}`),
    );
  }

  await Promise.all(calls);
  await Promise.all([a.servers.writes.settled(), b.servers.writes.settled()]);
}

/**
 * What a viewer shows of the queue never moves backwards: every capture takes
 * the step after the last `session.updated` and the captures since, as the
 * client sets `next` from each event (D205).
 */
function assertStepsFollow(events: ViewerEvent[]): void {
  let next: number | null = 1;

  for (const event of events) {
    if (event.type === 'session.updated') {
      next = event.data.queue?.next ?? null;
    } else if (event.type === 'request.received') {
      const step = event.data.response?.queueStep ?? null;

      if (next === null) {
        assert.equal(step, null, 'a step after the queue was used up');
      } else {
        assert.equal(step?.index, next, 'a capture took a step out of order');
        next = step.index < step.total ? step.index + 1 : null;
      }
    }
  }
}

describe('order across processes (criterion 2, D205 point 12, D221)', () => {
  it('delivers calls that move one queue, made on both instances at once, to every viewer of both: the queue’s events in lock order, each response after its request, each event once', async () => {
    const { sessionId, viewers } = await queueWatchedOnBoth();

    await moveTheQueueFromBoth(sessionId);
    await flushBoth();

    // The outbox's order, which is the order the changes took the lock.
    const written = await outbox(sessionId);

    assert.equal(written.filter((event) => event.type === 'request.received').length, 13);
    assert.equal(written.filter((event) => event.type === 'response.recorded').length, 13);

    for (const viewer of viewers) {
      await arrived(viewer, written.length);
      // Each event once, and nothing else.
      assert.deepEqual(
        viewer.events.map((event) => JSON.stringify(event)).sort(),
        written.map((event) => JSON.stringify(event)).sort(),
      );
      // The queue's events in the order of the lock.
      assert.deepEqual(viewer.events.filter(movesTheQueue), written.filter(movesTheQueue));

      // Each recorded response after its own request.
      const receivedAt = new Map<string, number>();

      viewer.events.forEach((event, index) => {
        if (event.type === 'request.received') {
          receivedAt.set(event.data.id, index);
        } else if (event.type === 'response.recorded') {
          const at = receivedAt.get(event.data.id);

          assert.ok(at !== undefined && at < index, 'a response.recorded before its request');
        }
      });

      assertStepsFollow(viewer.events);
    }

    for (const viewer of viewers) {
      viewer.close();
    }
  });

  /**
   * The same calls with the reads of both instances held until every one of
   * them, and every completion, has committed: each instance then finds them
   * all in one read, and delivers that read in id order, the completions in
   * their places included. A read that delivered in any other order fails
   * here, whatever the timing.
   */
  it('delivers what one read finds in id order: with the reads of both held while the calls commit, every viewer of both receives the whole outbox in id order', async () => {
    const { sessionId, viewers } = await queueWatchedOnBoth();
    const releases = [a.servers.listener.holdReads(), b.servers.listener.holdReads()];

    try {
      await moveTheQueueFromBoth(sessionId);

      for (const viewer of viewers) {
        assert.deepEqual(viewer.events, [], 'delivered while the reads were held');
      }
    } finally {
      for (const release of releases) {
        release();
      }
    }

    await flushBoth();

    const written = await outbox(sessionId);

    assert.equal(written.length, 29);

    for (const viewer of viewers) {
      await arrived(viewer, written.length);
      assert.deepEqual(viewer.events, written);
      assertStepsFollow(viewer.events);
    }

    for (const viewer of viewers) {
      viewer.close();
    }
  });
});

describe('large events (criterion 3, D221)', () => {
  /**
   * The largest a valid session can publish, as `hub.test.ts` builds it: a
   * custom response at every limit of D101 whose body JSON writes six bytes a
   * character, then the largest queue the 1 MiB body of `PUT .../queue`
   * admits, written the same way - a `session.updated` of 1,867,651 bytes.
   */
  it('delivers the largest session.updated, about 2.8 MiB with rules, whole to a viewer of the other instance', async () => {
    const sessionId = await newSession(a);
    const viewer = await watch(b.port, sessionId);
    const custom = await api(a, 'PUT', `/api/sessions/${sessionId}/response`, {
      mode: 'custom',
      response: escapedFullResponse(),
    });

    assert.equal(custom.statusCode, 200, custom.body);

    const queued = await a.servers.api.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/queue`,
      headers: { 'content-type': 'application/json' },
      payload: largestQueueBody(),
    });

    assert.equal(queued.statusCode, 200, queued.body);

    // The largest without rules, about 1.8 MiB (D205 point 13).
    const [, withoutRules] = await viewer.received(2);

    assert.ok(Buffer.byteLength(JSON.stringify(withoutRules)) > 1.7 * 1024 * 1024);
    assert.deepEqual((withoutRules as { data: SessionResponseState }).data, queued.json());

    // And beside them rules as large as 1 MiB admits (D246).
    const saved = await a.servers.api.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/rules`,
      headers: { 'content-type': 'application/json' },
      payload: largestRulesBody(),
    });

    assert.equal(saved.statusCode, 200, saved.body);

    const [, , event] = await viewer.received(3);
    const bytes = Buffer.byteLength(JSON.stringify(event));

    assert.equal(event?.type, 'session.updated');
    assert.ok(bytes > 2.7 * 1024 * 1024, `the event is ${bytes} bytes, smaller than the largest`);
    assert.deepEqual((event as { data: SessionResponseState }).data, saved.json());

    // Byte for byte what the outbox holds.
    const { rows } = await a.pool.query<{ payload: string }>(
      `SELECT payload FROM realtime_events
        WHERE session_id = $1 AND kind = 'session.updated' ORDER BY id DESC LIMIT 1`,
      [sessionId],
    );

    assert.equal(rows[0]?.payload, JSON.stringify(event));

    // And what the other instance reads of the session.
    const read = (await api(b, 'GET', `/api/sessions/${sessionId}`)).json<SessionResponseState>();

    assert.deepEqual((event as { data: SessionResponseState }).data, {
      response: read.response,
      customResponse: read.customResponse,
      queue: read.queue,
      rules: read.rules,
    });
    viewer.close();
  });
});

describe('deletion (criterion 4, D198, D221)', () => {
  it('closes the viewers of both instances with 4404 when one deletes the session', async () => {
    const sessionId = await newSession(a);
    const viewers = await Promise.all([watch(a.port, sessionId), watch(b.port, sessionId)]);

    assert.equal((await api(a, 'DELETE', `/api/sessions/${sessionId}`)).statusCode, 204);

    for (const viewer of viewers) {
      assert.equal(await viewer.closed, WsCloseCode.SESSION_NOT_FOUND);
      assert.deepEqual(viewer.events, []);
    }

    assert.equal(a.servers.hub.countFor(sessionId), 0);
    assert.equal(b.servers.hub.countFor(sessionId), 0);
    assert.deepEqual(await refused(b.port, sessionId), {
      code: WsCloseCode.SESSION_NOT_FOUND,
      messages: [],
    });
  });

  it('closes a connection being set up on one instance while the other deletes its session', async () => {
    const sessionId = await newSession(a);
    let reached: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });

    holdNextLookup = {
      reached,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };

    // The lookup on `b` has read the session; `a` deletes it meanwhile.
    const closing = refused(b.port, sessionId);

    await reachedPromise;
    assert.equal((await api(a, 'DELETE', `/api/sessions/${sessionId}`)).statusCode, 204);
    release();

    const { code, messages } = await closing;

    // Closed: before its `ready` when the close was delivered first, after it
    // when the connection registered first (D198, D221).
    assert.equal(code, WsCloseCode.SESSION_NOT_FOUND);
    assert.ok(
      messages.every((message) => message === '{"type":"ready"}'),
      messages.join(),
    );
    await until(() => b.servers.hub.countFor(sessionId) === 0, 'nothing registered');
  });
});

describe('a lost listener (criterion 5, D221)', () => {
  it('cuts its viewers, answers its waits, refuses with 1013 while deaf, listens again, and loses nothing to a reload', async () => {
    const sessionId = await newSession(a);
    const before = await capture(a, sessionId);
    const viewer = await watch(b.port, sessionId);
    const waiting = api(b, 'GET', `/api/sessions/${sessionId}/requests?wait=30&after=${before}`);

    await until(() => b.servers.hub.countFor(sessionId) === 2, 'the wait to subscribe');

    // `b`'s listening connection is cut, and its reconnection held.
    let open: () => void = () => undefined;

    reconnectGate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const started = Date.now();

    await a.pool.query('SELECT pg_terminate_backend($1)', [b.servers.listener.processId]);

    // Its viewer is cut, not closed: `1006` to the client, which reconnects.
    assert.equal(await viewer.closed, 1006);

    // Its wait is answered as at shutdown: what is there, `[]` here.
    const waited = await waiting;

    assert.equal(waited.statusCode, 200);
    assert.equal(waited.body, '[]');
    assert.ok(Date.now() - started < 5_000);

    // While it does not listen: a capture through `a`, and a viewer of `b`
    // refused with 1013, Try Again Later, before any `ready`.
    const duringId = await capture(a, sessionId);
    const meanwhile = await refused(b.port, sessionId);

    assert.deepEqual(meanwhile, { code: 1013, messages: [] });

    // A wait started now answers its first read at once.
    const quick = await api(
      b,
      'GET',
      `/api/sessions/${sessionId}/requests?wait=30&after=${before}`,
    );

    assert.deepEqual(
      quick.json<RequestListItem[]>().map((item) => item.id),
      [duringId],
    );

    open();
    reconnectGate = Promise.resolve();
    await until(() => b.servers.listener.listening, 'b to listen again');

    // The viewer reconnects and reloads: the capture made while `b` was cut
    // is in the list it reads on `ready` (D077).
    const again = await watch(b.port, sessionId);
    const reloaded = (await api(b, 'GET', `/api/sessions/${sessionId}/requests`))
      .json<RequestListItem[]>()
      .map((item) => item.id);

    assert.ok(reloaded.includes(duringId), 'the reload lost the capture made while cut');

    // And what is captured from now on reaches it as an event.
    const afterId = await capture(a, sessionId);
    const received = await again.received(1);

    assert.equal(received[0]?.type, 'request.received');
    assert.equal((received[0] as { data: RequestListItem }).data.id, afterId);
    again.close();
  });
});

/**
 * Arms `holdNextFetch`: `b`'s next fetch of a payload of `ids` waits, between
 * its read and the fetch, until `release` is called; `reached` resolves once it
 * waits.
 */
function holdFetchOf(ids: readonly string[]): { reached: Promise<void>; release: () => void } {
  let reached: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve;
  });

  holdNextFetch = {
    ids: new Set(ids),
    reached,
    release: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };

  return { reached: reachedPromise, release };
}

/**
 * What `viewers` were sent before a capture made now: captures a request on
 * `a`, waits, bounded, until each viewer has received its `request.received`,
 * and returns each one's events before it. A connection keeps its order, so
 * once that marker has arrived everything `b` sent before it has too, the
 * events a viewer must not have been sent included: what a viewer was sent
 * can be judged whole without knowing how much of it to wait for.
 */
async function sentBefore(sessionId: string, viewers: Viewer[]): Promise<ViewerEvent[][]> {
  const marker = await capture(a, sessionId);
  const isMarker = (event: ViewerEvent): boolean =>
    event.type === 'request.received' && event.data.id === marker;

  return Promise.all(
    viewers.map(async (viewer) => {
      await until(
        () => viewer.events.some(isMarker),
        'the marker capture to reach a viewer',
        ARRIVAL_MS,
      );

      return viewer.events.slice(0, viewer.events.findIndex(isMarker));
    }),
  );
}

/** The session's outbox rows, in id order, without payloads. */
async function outboxRows(sessionId: string): Promise<{ id: string; kind: string }[]> {
  const { rows } = await a.pool.query<{ id: string; kind: string }>(
    'SELECT id::text AS id, kind FROM realtime_events WHERE session_id = $1 ORDER BY id',
    [sessionId],
  );

  return rows;
}

/** Resolves with what `promise` resolves with, or fails naming `what` after `ms`. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${ms} ms waiting for ${what}`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `b`'s pool has no statement in flight or waiting: a call's read on it has ended. */
function bPoolIdle(): boolean {
  const { totalCount, idleCount, waitingCount } = b.pool;

  return totalCount === idleCount && waitingCount === 0;
}

describe('a read overtaken while its payloads are fetched (D221 points 5 and 8)', () => {
  /**
   * A capture's `request.received` carries the queue step it took (D205
   * point 6), which nothing later repeats. Deleted before a lagging instance
   * fetched it, its payload is gone (D221 point 8): the viewers and the waits
   * of that instance it was for read the session again rather than miss the
   * step.
   */
  it('makes the viewers and the waits a purged request.received was for read the session again, and nobody else', async () => {
    const sessionId = await newSession(a, {
      response: { status: 200 },
      queue: { steps: [{ status: 201 }, { status: 202 }] },
    });
    const otherId = await newSession(a);
    const viewer = await watch(b.port, sessionId);
    const bystander = await watch(b.port, otherId);
    const waiting = api(b, 'GET', `/api/sessions/${sessionId}/requests?wait=30`);

    await until(() => b.servers.hub.countFor(sessionId) === 2, 'the wait to subscribe');
    await until(bPoolIdle, 'the wait’s first read to end');

    // `b` finds the capture in one read, whose fetch then waits.
    const { requestId, fetching } = await withoutReading(b.servers, async () => {
      const id = await capture(a, sessionId);
      const received = (await outboxRows(sessionId)).filter(
        (row) => row.kind === 'request.received',
      );

      return { requestId: id, fetching: holdFetchOf(received.map((row) => row.id)) };
    });

    await within(fetching.reached, 3_000, '`b` to fetch the capture');

    // The capture is deleted meanwhile: its `request.received` is purged.
    assert.equal(
      (await api(a, 'DELETE', `/api/sessions/${sessionId}/requests/${requestId}`)).statusCode,
      204,
    );

    const released = Date.now();

    fetching.release();

    // The viewer is closed for a retry, `1013`, not refused.
    assert.equal(await within(viewer.closed, 3_000, 'the viewer to be closed'), 1013);
    assert.deepEqual(viewer.events, []);

    // The wait is answered after one last read, which finds the request gone.
    const waited = await within(waiting, 3_000, 'the wait to be answered');

    assert.equal(waited.statusCode, 200);
    assert.equal(waited.body, '[]');
    assert.ok(Date.now() - released < 3_000);

    // The viewer reconnects and reloads: the session shows the step the
    // capture took, the next being the second.
    const again = await watch(b.port, sessionId);
    const reloaded = (
      await api(b, 'GET', `/api/sessions/${sessionId}`)
    ).json<SessionResponseState>();

    assert.equal(reloaded.queue?.next, 2);

    // A viewer of another session is untouched, and still told of its captures.
    await b.servers.flush();
    assert.equal(bystander.isOpen(), true);
    assert.deepEqual(bystander.events, []);

    const otherRequest = await capture(a, otherId);
    const [told] = await bystander.received(1);

    assert.equal(told?.type, 'request.received');
    assert.equal((told as { data: RequestListItem }).data.id, otherRequest);
    again.close();
    bystander.close();
  });

  /**
   * A viewer declaring no optional event wants a capture's `request.received`
   * and not its `response.recorded`. A viewer declaring every one that
   * registers while that read's payloads are fetched reloads the request with
   * its response recorded; sent that read's events, it would get the stale
   * `request.received` and never the `response.recorded` the read passed over.
   */
  it('judges what a read wants, and delivers it, on the registrations as the read returned: a viewer registering during its fetch relies on its reload', async () => {
    const sessionId = await newSession(a);
    const legacy = await watch(b.port, sessionId, []);

    // `b` finds the capture and its recorded response in one read, whose
    // fetch then waits.
    const { requestId, fetching } = await withoutReading(b.servers, async () => {
      const id = await capture(a, sessionId);
      let rows = await outboxRows(sessionId);

      for (let attempt = 0; attempt < 400 && rows.length < 2; attempt += 1) {
        await delay(5);
        rows = await outboxRows(sessionId);
      }

      assert.deepEqual(
        rows.map((row) => row.kind),
        ['request.received', 'response.recorded'],
      );

      return { requestId: id, fetching: holdFetchOf(rows.map((row) => row.id)) };
    });

    await within(fetching.reached, 3_000, '`b` to fetch the capture');

    // A viewer declaring every optional event registers meanwhile, and
    // reloads: the request with its response recorded.
    const late = await watch(b.port, sessionId);
    const [row] = (await api(b, 'GET', `/api/sessions/${sessionId}/requests`)).json<
      RequestListItem[]
    >();

    assert.equal(row?.id, requestId);
    assert.equal(row?.response?.state, 'sent');
    fetching.release();
    await b.servers.flush();

    // Everything `b` has sent the two viewers so far, the held read's
    // delivery included, read whole on their side.
    const [lateSent = [], legacySent = []] = await sentBefore(sessionId, [late, legacy]);

    // What it is sent of the request after its reload, applied as the client
    // applies it, leaves the response recorded: nothing, or the
    // `request.received` followed by its `response.recorded`.
    const sent = lateSent
      .filter((event) => 'data' in event && (event.data as { id?: string }).id === requestId)
      .map((event) => event.type);

    assert.ok(sent.length === 0 || sent.at(-1) === 'response.recorded', sent.join());

    // The legacy viewer has its `request.received`, and nothing else.
    assert.deepEqual(types(legacySent), ['request.received']);
    late.close();
    legacy.close();
  });
});
