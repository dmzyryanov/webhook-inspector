/**
 * Integration tests for deleting a whole session, `DELETE
 * /api/sessions/:sessionId` (D198, issue #102).
 *
 * They run against the local PostgreSQL with both listeners of the process
 * (D187) sharing one realtime hub, because what is tested is the deletion as
 * every party sees it: the API, the receive URL, an open viewer's socket, a
 * sender still waiting out a delay, a capture racing the deletion, and the
 * statistics row the deletion writes.
 *
 * The application's pool is wrapped so that the statements it sends can be
 * read back: that is how "a deletion is not a use" and "a refused deletion
 * counts nothing" are asserted exactly, since other test files delete sessions
 * of their own in the same database at the same time, and how the completion
 * write of a delayed response is waited for. The test's own queries go through
 * a second pool, which nothing records.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { NEGOTIABLE_EVENT_TYPES, WsCloseCode, type ServerEvent } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { withExpiredSession } from '../../testing/expired-session.ts';
import { closeSockets, refused, watch } from '../../testing/realtime.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import { RealtimeHub, type Subscriber } from '../realtime/hub.ts';
import { READ_SQL } from '../realtime/listener.ts';
import { SESSION_ACCESS_SQL } from './access-key.ts';
import {
  COUNT_SESSION_DELETION_SQL,
  deleteSessionInTransaction,
  REFRESH_SESSION_EXPIRY_SQL,
} from './repository.ts';

const UNKNOWN_SESSION_ID = 'z'.repeat(43);
const SESSION_NOT_FOUND = { errorCode: 1001, message: 'Session not found' };
const SESSION_EXPIRED = { errorCode: 1002, message: 'Session expired' };

/** Bounds every wait, so a regression fails with a message instead of hanging the suite. */
const WAIT_MS = 10_000;

/** One statement the application sent, its parameters, and when it settled. */
interface Statement {
  text: string;
  values: unknown[];
  settled: Promise<unknown>;
}

const statements: Statement[] = [];
const logLines: string[] = [];
const createdSessionIds: string[] = [];
const openSockets: WebSocket[] = [];

/** The application's pool, recorded. */
let pool: pg.Pool;
/** The test's own queries, not recorded. */
let direct: pg.Pool;
let servers: TestServers;
/** The application listener: the API and the realtime endpoint. */
let app: FastifyInstance;
/** The receive listener, where webhooks are sent (D187). */
let receiver: FastifyInstance;
let apiPort: number;
let receivePort: number;

type Queryable = { query: (...args: unknown[]) => unknown };

/** A property of a wrapped pool or client, its methods still bound to it. */
function forward<T extends object>(target: T, property: string | symbol): unknown {
  const value = Reflect.get(target, property, target) as unknown;

  return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
}

/**
 * Records the text of every statement sent through `query`, on the pool and
 * on every client taken from it, the transactions of a capture and of a
 * deletion included.
 */
function recordingPool(base: pg.Pool): pg.Pool {
  const recorded =
    (target: Queryable) =>
    (...args: unknown[]): unknown => {
      const result = target.query(...args);

      if (typeof args[0] === 'string') {
        statements.push({
          text: args[0],
          values: Array.isArray(args[1]) ? (args[1] as unknown[]) : [],
          settled: Promise.resolve(result).catch(() => undefined),
        });
      }

      return result;
    };

  return new Proxy(base, {
    get(target, property) {
      if (property === 'query') {
        return recorded(target as unknown as Queryable);
      }

      if (property === 'connect') {
        return async () => {
          const client = await target.connect();

          return new Proxy(client, {
            get(inner, innerProperty) {
              return innerProperty === 'query'
                ? recorded(inner as unknown as Queryable)
                : forward(inner, innerProperty);
            },
          });
        };
      }

      return forward(target, property);
    },
  });
}

// after() waits for before() to finish. Node's runner does not when a name
// pattern leaves this file no test, and what before() opens would outlive the
// run (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = start();
  await startup;
});

async function start(): Promise<void> {
  const databaseUrl = loadConfig().databaseUrl;

  direct = createPool(databaseUrl);
  pool = recordingPool(createPool(databaseUrl));
  servers = buildTestServers(pool, {
    logDestination: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        logLines.push(
          ...chunk
            .toString()
            .split('\n')
            .filter((line) => line.length > 0),
        );
        callback();
      },
    }),
  });
  ({ api: app, receiver } = servers);
  apiPort = await listening(app);
  receivePort = await listening(receiver);
}

async function listening(server: FastifyInstance): Promise<number> {
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();

  return typeof address === 'object' && address ? address.port : 0;
}

after(async () => {
  // A failed start is before()'s to report; close what it did open.
  await startup?.catch(() => undefined);

  for (const socket of openSockets) {
    socket.close();
  }

  closeSockets();

  if (createdSessionIds.length > 0) {
    await direct.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers?.close();
  await pool?.end();
  await direct?.end();
});

function withTimeout<T>(promise: Promise<T>, description: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out after ${WAIT_MS} ms waiting for ${description}`)),
        WAIT_MS,
      ).unref(),
    ),
  ]);
}

async function newSession(payload?: object): Promise<string> {
  const response =
    payload === undefined
      ? await app.inject({ method: 'POST', url: '/api/sessions' })
      : await app.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify(payload),
        });

  assert.equal(response.statusCode, 201, response.body);

  const { id } = response.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

function deleteSession(sessionId: string, extra: object = {}) {
  return app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}`, ...extra });
}

/** An injected answer. */
type Answer = Awaited<ReturnType<typeof deleteSession>>;

/**
 * Captures one request through a receive listener - the shared one unless
 * told otherwise - and answers its id. It returns once the capture has been
 * published.
 */
async function capture(
  sessionId: string,
  body = '{"event":"x"}',
  on: FastifyInstance = receiver,
): Promise<string> {
  const response = await on.inject({
    method: 'POST',
    url: `/s/${sessionId}`,
    headers: { 'content-type': 'application/json' },
    payload: body,
  });

  assert.equal(response.statusCode, 200, response.body);

  const id = response.headers['x-qa-tools-request-id'];

  assert.ok(typeof id === 'string');

  return id;
}

/** Waits until every captured request of the session has a terminal response record. */
async function awaitRecorded(sessionId: string, count: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;

  while (Date.now() < deadline) {
    const { rows } = await direct.query<{ total: number; pending: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE rr.state = 'pending')::int AS pending
         FROM request_responses rr
         JOIN requests r ON r.id = rr.request_id
        WHERE r.session_id = $1`,
      [sessionId],
    );

    if (rows[0]?.total === count && rows[0]?.pending === 0) {
      return;
    }

    await delay(5);
  }

  throw new Error(`${count} response records did not reach a terminal state`);
}

/** What the database still holds of a session: its row, its requests, their responses. */
async function remains(sessionId: string, requestIds: string[]) {
  const { rows } = await direct.query<{
    sessions: number;
    requests: number;
    responses: number;
  }>(
    `SELECT (SELECT count(*)::int FROM sessions WHERE id = $1) AS sessions,
            (SELECT count(*)::int FROM requests WHERE session_id = $1) AS requests,
            (SELECT count(*)::int FROM request_responses WHERE request_id = ANY($2::uuid[]))
              AS responses`,
    [sessionId, requestIds],
  );

  return rows[0];
}

/** The statements the application sent from `from` on. */
function sentSince(from: number): string[] {
  return statements.slice(from).map((statement) => statement.text);
}

/** The log lines at `error` level or above from `from` on. */
function errorsSince(from: number): string[] {
  return logLines.slice(from).filter((line) => {
    try {
      return ((JSON.parse(line) as { level?: number }).level ?? 0) >= 50;
    } catch {
      return true;
    }
  });
}

/** A connection recorded from its first message on, `ready` included, in the order received. */
interface Recorded {
  messages: ServerEvent[];
  /** Resolves with the close code once the connection has closed. */
  closed: Promise<number>;
  isOpen(): boolean;
}

/** Opens a connection declaring every optional event type, and records everything it is sent. */
function record(sessionId: string, port: number): Recorded {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/ws/${sessionId}?events=${NEGOTIABLE_EVENT_TYPES.join(',')}`,
  );
  const messages: ServerEvent[] = [];
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => resolve(event.code));
  });

  openSockets.push(socket);
  socket.addEventListener('message', (message) => {
    messages.push(JSON.parse(message.data as string) as ServerEvent);
  });

  return { messages, closed, isOpen: () => socket.readyState === WebSocket.OPEN };
}

/** A lookup or a read held by `OwnServers.holdLookup` or `OwnServers.holdRead`. */
interface Hold {
  /** Resolves once what is held has reached the hold and is being held. */
  reached: Promise<void>;
  /** Lets it go on. */
  release: () => void;
}

/** One thing a `RecordingHub` did, as `RecordingHub.follow` reports it. */
interface HubStep {
  /** Milliseconds since `follow`. */
  at: number;
  what:
    'hold' | 'release' | 'remove' | 'close of this session' | 'close of another session' | 'deafen';
  /** The followed session's registrations before it and after it (`countFor`). */
  before: number;
  after: number;
  /** For `release`: whether it sent `ready`. */
  sent?: boolean;
}

/** A session a `RecordingHub` follows. */
interface Followed {
  /** Resolves once a connection to the session has been registered (`hold`). */
  registered: Promise<void>;
  /** What the hub has done since `follow`, in order. */
  steps(): HubStep[];
  /** The steps as a failure message gives them. */
  describe(): string;
}

/**
 * A hub that records what it does for the one session it is told to follow:
 * the realtime route registering a connection to it (`hold`), announcing it
 * (`release`) and forgetting it (`remove`), and every close and every
 * deafness, of any session, since each of those moves `closedSessions` and so
 * decides whether the route looks a session up a second time (D198). A
 * registration is then seen as it happens rather than polled for: one that
 * second lookup undoes lasts a round trip to the database, less than a poll's
 * 5 ms (F-23 in `docs/testing/flakes.md`).
 */
class RecordingHub extends RealtimeHub {
  #followed: string | null = null;
  #since = 0;
  #steps: HubStep[] = [];
  #registered: () => void = () => undefined;

  /** Starts recording `sessionId`'s steps; another session followed before is no longer. */
  follow(sessionId: string): Followed {
    const steps: HubStep[] = [];
    const registered = new Promise<void>((resolve) => {
      this.#registered = resolve;
    });

    this.#followed = sessionId;
    this.#since = performance.now();
    this.#steps = steps;

    return { registered, steps: () => [...steps], describe: () => describeSteps(steps) };
  }

  override hold(sessionId: string, subscriber: Subscriber, accepts: ReadonlySet<string>): void {
    const before = this.#count();

    super.hold(sessionId, subscriber, accepts);

    if (sessionId === this.#followed) {
      this.#record('hold', before);
      this.#registered();
    }
  }

  override release(sessionId: string, subscriber: Subscriber, first: string): boolean {
    const before = this.#count();
    const sent = super.release(sessionId, subscriber, first);

    if (sessionId === this.#followed) {
      this.#record('release', before, sent);
    }

    return sent;
  }

  override remove(sessionId: string, subscriber: Subscriber): void {
    const before = this.#count();

    super.remove(sessionId, subscriber);

    if (sessionId === this.#followed) {
      this.#record('remove', before);
    }
  }

  override closeSession(sessionId: string, code: number, reason: string): void {
    const before = this.#count();

    super.closeSession(sessionId, code, reason);
    this.#record(
      sessionId === this.#followed ? 'close of this session' : 'close of another session',
      before,
    );
  }

  override deafen(): void {
    const before = this.#count();

    super.deafen();
    this.#record('deafen', before);
  }

  #count(): number {
    return this.#followed === null ? 0 : this.countFor(this.#followed);
  }

  #record(what: HubStep['what'], before: number, sent?: boolean): void {
    if (this.#followed === null) {
      return;
    }

    this.#steps.push({
      at: performance.now() - this.#since,
      what,
      before,
      after: this.#count(),
      ...(sent === undefined ? {} : { sent }),
    });
  }
}

/**
 * The steps in order, with the time and the followed session's registrations
 * before and after each; a run of closes of other sessions is given as one.
 */
function describeSteps(steps: readonly HubStep[]): string {
  if (steps.length === 0) {
    return 'the hub did nothing for it';
  }

  const lines: string[] = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    let last = index;

    while (step.what === 'close of another session' && steps[last + 1]?.what === step.what) {
      last += 1;
    }

    const what =
      last > index
        ? `${last - index + 1} closes of other sessions`
        : step.sent === undefined
          ? step.what
          : `${step.what}, ${step.sent ? 'ready sent' : 'nothing sent'}`;

    lines.push(
      `+${step.at.toFixed(1)} ms ${what}, registered ${step.before} -> ${steps[last]!.after}`,
    );
    index = last;
  }

  return `the hub: ${lines.join('; ')}`;
}

/**
 * Resolves once the followed session has a connection registered, as the hub
 * records it, so that a registration undone at once is not missed. Fails
 * after `WAIT_MS`, or once the connection is closed first, naming what the
 * hub did meanwhile and the close the connection received.
 */
async function registration(
  followed: Followed,
  closed: Promise<{ code: number; messages: string[] }>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const seen = await Promise.race([
    followed.registered.then(() => null),
    closed.then(
      ({ code, messages }) =>
        `the connection was closed ${code} first, after ${JSON.stringify(messages)}`,
      (error: unknown) => `the connection failed first: ${String(error)}`,
    ),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(`not within ${WAIT_MS} ms`), WAIT_MS);
      timer.unref();
    }),
  ]);

  clearTimeout(timer);

  if (seen !== null) {
    throw new Error(`Waiting for the connection to register: ${seen}; ${followed.describe()}`);
  }
}

/** What `promise` resolves with; its failure, if it fails, followed by what the hub did. */
async function explained<T>(promise: Promise<T>, followed: Followed): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ${followed.describe()}`,
      { cause: error },
    );
  }
}

/** Servers of their own over a pool that can be told to misbehave once. */
interface OwnServers {
  servers: TestServers;
  /** The servers' hub, which records what it does for a session it follows. */
  hub: RecordingHub;
  /** The application listener's port. */
  port: number;
  /**
   * Holds the next lookup of a session by the realtime route once it has read
   * the session and before the route goes on (D198).
   */
  holdLookup(): Hold;
  /**
   * Holds the next read of the outbox before its statement is sent, so before
   * it has taken its snapshot. Reads run one at a time, so once it is held no
   * read is under way: nothing is delivered to the hub - no close of any
   * session, whose deletion another test file may make - until `release`,
   * unlike `withoutReading`, whose hold leaves a read already under way to
   * deliver. The read is held inside its statement's deadline, 5 s: a hold
   * must stay well under it.
   */
  holdRead(): Hold;
  /**
   * Lets the next `COMMIT` commit, and then fails it as a connection lost
   * before PostgreSQL's acknowledgement arrived would: what the transaction
   * wrote is committed, and its caller is told it failed.
   */
  loseNextCommit(): void;
  close(): Promise<void>;
}

/**
 * Both listeners and a hub of their own, over the recorded pool, so that what
 * one test does to them reaches no other test.
 */
async function ownServers(): Promise<OwnServers> {
  let hold: { reached: () => void; release: Promise<void> } | undefined;
  let readHold: { reached: () => void; release: Promise<void> } | undefined;
  let releaseRead: () => void = () => undefined;
  let losingCommit = false;

  const misbehaving = new Proxy(pool, {
    get(target, property) {
      if (property === 'query') {
        return async (...args: unknown[]) => {
          const result = await (target as unknown as Queryable).query(...args);
          const armed = hold;

          // The lookup the realtime route makes (`sessionAccess`).
          if (armed && args[0] === SESSION_ACCESS_SQL) {
            hold = undefined;
            armed.reached();
            await armed.release;
          }

          return result;
        };
      }

      if (property === 'connect') {
        return async () => {
          const client = await target.connect();

          return new Proxy(client, {
            get(inner, innerProperty) {
              if (innerProperty !== 'query') {
                return forward(inner, innerProperty);
              }

              return async (...args: unknown[]) => {
                const result = await (inner as unknown as Queryable).query(...args);

                if (losingCommit && args[0] === 'COMMIT') {
                  losingCommit = false;
                  throw new Error('Connection terminated unexpectedly');
                }

                return result;
              };
            },
          });
        };
      }

      return forward(target, property);
    },
  });
  const hub = new RecordingHub();
  const own = buildTestServers(misbehaving, {
    hub,
    listener: {
      beforeStatement: async (text) => {
        const armed = readHold;

        if (armed && text === READ_SQL) {
          readHold = undefined;
          armed.reached();
          await armed.release;
        }
      },
    },
    logDestination: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });

  await own.ready();

  return {
    servers: own,
    hub,
    port: await listening(own.api),
    holdLookup() {
      let reached: () => void = () => undefined;
      let release: () => void = () => undefined;
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });

      hold = { reached, release: releasePromise };

      return { reached: reachedPromise, release };
    },
    holdRead() {
      let reached: () => void = () => undefined;
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const releasePromise = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });

      readHold = { reached, release: releasePromise };

      return { reached: reachedPromise, release: releaseRead };
    },
    loseNextCommit() {
      losingCommit = true;
    },
    async close() {
      hold = undefined;
      readHold = undefined;
      // A read still held would hold the listener's stop.
      releaseRead();
      losingCommit = false;
      await own.close();
    },
  };
}

describe('DELETE /api/sessions/:sessionId', () => {
  it('deletes a live session with its requests and their responses: 204, no body, no row left', async () => {
    const sessionId = await newSession();
    const requestIds = [
      await capture(sessionId),
      await capture(sessionId),
      await capture(sessionId),
    ];

    await awaitRecorded(sessionId, 3);
    assert.deepEqual(await remains(sessionId, requestIds), {
      sessions: 1,
      requests: 3,
      responses: 3,
    });

    const response = await deleteSession(sessionId);

    assert.equal(response.statusCode, 204);
    assert.equal(response.body, '');
    assert.deepEqual(await remains(sessionId, requestIds), {
      sessions: 0,
      requests: 0,
      responses: 0,
    });
  });

  it('leaves every session route answering 404 / 1001, and the receive URL as for an unknown session', async () => {
    const sessionId = await newSession();
    const requestId = await capture(sessionId);

    assert.equal((await deleteSession(sessionId)).statusCode, 204);

    const json = { 'content-type': 'application/json' };
    const routes = [
      { method: 'GET', url: `/api/sessions/${sessionId}` },
      { method: 'GET', url: `/api/sessions/${sessionId}/requests` },
      // The list with content and paged by the deleted request (D196).
      {
        method: 'GET',
        url: `/api/sessions/${sessionId}/requests?include=headers,body&order=asc&after=${requestId}`,
      },
      { method: 'GET', url: `/api/sessions/${sessionId}/requests/${requestId}` },
      {
        method: 'PUT',
        url: `/api/sessions/${sessionId}/response`,
        headers: json,
        payload: '{"mode":"default"}',
      },
      { method: 'DELETE', url: `/api/sessions/${sessionId}/requests` },
      { method: 'DELETE', url: `/api/sessions/${sessionId}/requests/${requestId}` },
      {
        method: 'POST',
        url: `/api/sessions/${sessionId}/requests/search`,
        headers: json,
        payload: '{"words":["event"]}',
      },
      {
        method: 'POST',
        url: `/api/sessions/${sessionId}/requests/query`,
        headers: json,
        payload: '{"body":["event"],"include":["body"]}',
      },
    ] as const;

    for (const route of routes) {
      const answer = await app.inject(route);

      assert.equal(answer.statusCode, 404, `${route.method} ${route.url}`);
      assert.deepEqual(answer.json(), SESSION_NOT_FOUND, `${route.method} ${route.url}`);
    }

    // The receive URL: the same answer, head and body, as an id that never
    // named a session, and nothing captured.
    for (const suffix of ['', '/stripe/events']) {
      const [deleted, unknown] = await Promise.all(
        [sessionId, UNKNOWN_SESSION_ID].map((id) =>
          receiver.inject({ method: 'POST', url: `/s/${id}${suffix}`, payload: 'x' }),
        ),
      );

      assert.equal(deleted?.statusCode, 404);
      assert.equal(deleted?.statusCode, unknown?.statusCode);
      assert.equal(deleted?.body, unknown?.body);
      assert.deepEqual(deleted?.json(), SESSION_NOT_FOUND);
      assert.equal(deleted?.headers['content-type'], unknown?.headers['content-type']);
      assert.equal(deleted?.headers['x-content-type-options'], 'nosniff');
      assert.equal(
        deleted?.headers['content-security-policy'],
        unknown?.headers['content-security-policy'],
      );
    }

    assert.deepEqual(await remains(sessionId, [requestId]), {
      sessions: 0,
      requests: 0,
      responses: 0,
    });
  });

  it('answers 404 / 1001 to a second deletion, an unknown id and a malformed one', async () => {
    const sessionId = await newSession();

    assert.equal((await deleteSession(sessionId)).statusCode, 204);

    const ids = [
      sessionId,
      UNKNOWN_SESSION_ID,
      'abc',
      'a'.repeat(42),
      'a'.repeat(44),
      `${'a'.repeat(42)}.`,
      `${'a'.repeat(42)}~`,
    ];

    for (const id of ids) {
      const answer = await deleteSession(id);

      assert.equal(answer.statusCode, 404, id);
      assert.deepEqual(answer.json(), SESSION_NOT_FOUND, id);
    }
  });

  it('refuses an expired session with 410 / 1002 and deletes nothing, counting nothing', async (t) => {
    // Other test files sweep expired sessions as the cleanup does, and the
    // deletion takes the row FOR UPDATE, so the row cannot be held against a
    // sweep: a run whose session a sweep removed is run again on a new one.
    let requestIds: string[] = [];

    await withExpiredSession(
      t,
      direct,
      async () => {
        const sessionId = await newSession();

        requestIds = [await capture(sessionId), await capture(sessionId)];
        await awaitRecorded(sessionId, 2);

        return sessionId;
      },
      async (sessionId) => {
        const { rows: before } = await direct.query<{ expires_at: Date }>(
          'SELECT expires_at FROM sessions WHERE id = $1',
          [sessionId],
        );
        const from = statements.length;
        const answer = await deleteSession(sessionId);

        assert.equal(answer.statusCode, 410);
        assert.deepEqual(answer.json(), SESSION_EXPIRED);
        assert.deepEqual(await remains(sessionId, requestIds), {
          sessions: 1,
          requests: 2,
          responses: 2,
        });

        const { rows: afterwards } = await direct.query<{ expires_at: Date }>(
          'SELECT expires_at FROM sessions WHERE id = $1',
          [sessionId],
        );

        // Not revived, and nothing written: no delete, no count, no refresh.
        assert.deepEqual(afterwards[0]?.expires_at, before[0]?.expires_at);

        const sent = sentSince(from);

        assert.ok(
          sent.some((text) => text.includes('FOR UPDATE')),
          'the deletion took no lock',
        );
        assert.equal(
          sent.some((text) => /^\s*(DELETE|UPDATE|INSERT)/i.test(text)),
          false,
          `a refused deletion wrote: ${sent.join(' | ')}`,
        );
      },
    );
  });

  it('is not a use of the session: nothing refreshes its expiry (D133)', async () => {
    const sessionId = await newSession();

    await capture(sessionId);

    const from = statements.length;

    assert.equal((await deleteSession(sessionId)).statusCode, 204);

    const sent = sentSince(from);

    assert.equal(sent.includes(REFRESH_SESSION_EXPIRY_SQL), false, 'the deletion refreshed');
    assert.equal(
      sent.some((text) => /UPDATE\s+sessions/i.test(text)),
      false,
      'the deletion updated the session row',
    );
    // One count, in the deletion's own transaction: begun before it, and
    // committed after it.
    assert.equal(sent.filter((text) => text === COUNT_SESSION_DELETION_SQL).length, 1);
    assert.ok(sent.indexOf('BEGIN') < sent.indexOf(COUNT_SESSION_DELETION_SQL));
    assert.ok(sent.indexOf(COUNT_SESSION_DELETION_SQL) < sent.lastIndexOf('COMMIT'));
  });

  it('takes no body, and answers one sent anyway as the request deletions do (D104)', async () => {
    const sessionId = await newSession();
    const tooLarge = Buffer.alloc(1024 * 1024 + 1, 0x61);

    for (const [headers, payload, status, errorCode] of [
      [{ 'content-type': 'application/json' }, '{', 400, 1006],
      [{ 'content-type': 'application/xml' }, '<x/>', 415, 1007],
      [{ 'content-type': 'text/plain' }, tooLarge, 413, 1004],
    ] as const) {
      const answer = await deleteSession(sessionId, { headers, payload });

      assert.equal(answer.statusCode, status);
      assert.equal(answer.json<{ errorCode: number }>().errorCode, errorCode);
    }

    // Refused before the route ran: the session is still there.
    assert.equal((await remains(sessionId, []))?.sessions, 1);

    // A body these routes parse and ignore does not stop the deletion.
    const answer = await deleteSession(sessionId, {
      headers: { 'content-type': 'text/plain' },
      payload: 'ignored',
    });

    assert.equal(answer.statusCode, 204);
    assert.equal((await remains(sessionId, []))?.sessions, 0);
  });
});

describe('open viewers of a deleted session', () => {
  it('are closed with 4404, while a viewer of another session stays open', async () => {
    const deleted = await newSession();
    const other = await newSession();
    const declaring = await watch(apiPort, deleted);
    const silent = await watch(apiPort, deleted, []);
    const bystander = await watch(apiPort, other);

    assert.equal(servers.hub.countFor(deleted), 2);
    assert.equal((await deleteSession(deleted)).statusCode, 204);

    assert.equal(await withTimeout(declaring.closed, 'the declaring viewer to close'), 4404);
    assert.equal(await withTimeout(silent.closed, 'the silent viewer to close'), 4404);
    assert.equal(WsCloseCode.SESSION_NOT_FOUND, 4404);
    assert.equal(servers.hub.countFor(deleted), 0);

    // Closed, not told: no event announced the deletion first.
    assert.deepEqual(declaring.events, []);
    assert.deepEqual(silent.events, []);

    // The other session's viewer is still subscribed and still receives.
    assert.ok(bystander.isOpen());
    assert.equal(servers.hub.countFor(other), 1);

    const requestId = await capture(other);
    const deadline = Date.now() + WAIT_MS;

    while (!bystander.events.some((event) => event.type === 'request.received')) {
      assert.ok(Date.now() < deadline, 'the other session stopped receiving');
      await delay(5);
    }

    const received = bystander.events.find((event) => event.type === 'request.received');

    assert.ok(received?.type === 'request.received' && received.data.id === requestId);

    // And a connection opened afterwards is refused, as for an unknown session.
    assert.deepEqual(await refused(apiPort, deleted), { code: 4404, messages: [] });
  });

  it('closes a connection whose session was deleted while it was being set up (D198)', async () => {
    // The realtime lookup is held after it has read the session and before
    // the route goes on: the window in which the deletion finds nothing of the
    // connection to close.
    const own = await ownServers();

    try {
      // The control: held and released with no deletion meanwhile, the
      // connection is set up as usual.
      const kept = await newSession();
      const keptHold = own.holdLookup();
      const keptViewer = watch(own.port, kept);

      await withTimeout(keptHold.reached, 'the lookup to be held');
      keptHold.release();

      const viewer = await keptViewer;

      assert.ok(viewer.isOpen());

      // The case: the lookup has read the session, the deletion commits and
      // its close is delivered, finding nothing of the connection, and only
      // then is the connection registered. Its second lookup finds no session.
      const doomed = await newSession();
      const doomedHold = own.holdLookup();
      const doomedRefused = refused(own.port, doomed);

      await withTimeout(doomedHold.reached, 'the lookup to be held');
      assert.equal(
        (await own.servers.api.inject({ method: 'DELETE', url: `/api/sessions/${doomed}` }))
          .statusCode,
        204,
      );
      await own.servers.flush();
      doomedHold.release();

      assert.deepEqual(await doomedRefused, { code: 4404, messages: [] });
      assert.equal(own.servers.hub.countFor(doomed), 0);
      assert.ok(viewer.isOpen(), 'a deletion of another session closed this one');

      // And when the connection registers before the close is delivered -
      // the close is read from the outbox after the deletion has committed
      // (D221) - the close finds it registered and closes it, after its
      // `ready`. A read of the outbox is held before the connection is opened
      // until it has registered, so no close of any session reaches the hub
      // meanwhile - this listener reads every test file's deletions - and the
      // route, seeing `closedSessions` unchanged, sends `ready` as it
      // registers the connection, with no second lookup (F-23).
      const late = await newSession();
      const lateRead = own.holdRead();
      // Asks for a read, which is the one held, once a read under way, if any, has ended.
      const lateDelivered = own.servers.flush();

      lateDelivered.catch(() => undefined);
      await withTimeout(lateRead.reached, 'a read of the outbox to be held');

      const lateSteps = own.hub.follow(late);
      const lateHold = own.holdLookup();
      const lateRefused = refused(own.port, late);

      await withTimeout(lateHold.reached, 'the lookup to be held');
      assert.equal(
        (await own.servers.api.inject({ method: 'DELETE', url: `/api/sessions/${late}` }))
          .statusCode,
        204,
      );
      lateHold.release();
      await registration(lateSteps, lateRefused);
      assert.deepEqual(
        lateSteps.steps().map((step) => [step.what, step.after, step.sent]),
        [
          ['hold', 1, undefined],
          ['release', 1, true],
        ],
        `registered and sent ready, with nothing else: ${lateSteps.describe()}`,
      );

      // The held read takes its snapshot now, after the deletion committed.
      lateRead.release();
      await explained(withTimeout(lateDelivered, 'the held read to deliver the close'), lateSteps);

      const lateClose = await explained(lateRefused, lateSteps);

      assert.deepEqual(
        lateClose,
        { code: 4404, messages: ['{"type":"ready"}'] },
        lateSteps.describe(),
      );
      assert.ok(
        lateSteps
          .steps()
          .some((step) => step.what === 'close of this session' && step.before === 1),
        `the deletion's close did not find the connection registered: ${lateSteps.describe()}`,
      );
      assert.equal(own.servers.hub.countFor(late), 0, lateSteps.describe());
    } finally {
      await own.close();
    }
  });

  /**
   * A connection set up while another session was deleted looks its own
   * session up a second time once it is registered (D198), so captures can be
   * published to it before its `ready` is sent. `ready` is still the first
   * message (D081): what is published meanwhile is held and follows it, in
   * the order it was published.
   */
  it('sends ready first to a connection looking its session up again, then what was published to it meanwhile, in order', async () => {
    const own = await ownServers();

    try {
      const watched = await newSession();
      const other = await newSession();
      const firstLookup = own.holdLookup();
      const viewer = record(watched, own.port);

      await withTimeout(firstLookup.reached, 'the first lookup to be held');
      assert.equal(
        (await own.servers.api.inject({ method: 'DELETE', url: `/api/sessions/${other}` }))
          .statusCode,
        204,
      );
      // The other session's close delivered: the count of closes has moved.
      await own.servers.flush();

      const secondLookup = own.holdLookup();

      firstLookup.release();
      await withTimeout(secondLookup.reached, 'the second lookup to be held');
      assert.equal(own.servers.hub.countFor(watched), 1, 'not registered before its second lookup');

      // Delivered to the registered connection while its second lookup is held.
      const firstId = await capture(watched, '{"n":1}', own.servers.receiver);
      const secondId = await capture(watched, '{"n":2}', own.servers.receiver);

      await own.servers.flush();
      secondLookup.release();

      const receivedIds = () =>
        viewer.messages.flatMap((message) =>
          message.type === 'request.received' ? [message.data.id] : [],
        );
      const deadline = Date.now() + WAIT_MS;

      while (receivedIds().length < 2) {
        assert.ok(Date.now() < deadline, 'what was published during the lookup never arrived');
        await delay(5);
      }

      const types = viewer.messages.map((message) => message.type);

      assert.equal(types[0], 'ready', `the messages arrived as ${types.join(', ')}`);
      assert.equal(types.filter((type) => type === 'ready').length, 1);
      assert.deepEqual(receivedIds(), [firstId, secondId]);
      assert.ok(viewer.isOpen());
    } finally {
      await own.close();
    }
  });

  it('sends nothing it held to a connection whose session is deleted during its second lookup', async () => {
    const own = await ownServers();

    try {
      const watched = await newSession();
      const other = await newSession();
      const firstLookup = own.holdLookup();
      const viewer = record(watched, own.port);

      await withTimeout(firstLookup.reached, 'the first lookup to be held');
      assert.equal(
        (await own.servers.api.inject({ method: 'DELETE', url: `/api/sessions/${other}` }))
          .statusCode,
        204,
      );
      await own.servers.flush();

      const secondLookup = own.holdLookup();

      firstLookup.release();
      await withTimeout(secondLookup.reached, 'the second lookup to be held');
      await capture(watched, '{"n":1}', own.servers.receiver);
      // The capture read before the deletion purges it, as its window ends
      // (#260): one purged first would make the connection read the session
      // again, `1013`, rather than be closed with the session (D221 point 8).
      await own.servers.flush();
      assert.equal(
        (await own.servers.api.inject({ method: 'DELETE', url: `/api/sessions/${watched}` }))
          .statusCode,
        204,
      );
      // The capture held for it, then its close: both delivered while held.
      await own.servers.flush();
      secondLookup.release();

      assert.equal(await withTimeout(viewer.closed, 'the connection to close'), 4404);
      assert.deepEqual(viewer.messages, []);
      assert.equal(own.servers.hub.countFor(watched), 0);
    } finally {
      await own.close();
    }
  });

  /**
   * A deletion that commits while the connection to PostgreSQL fails before
   * its acknowledgement arrives is answered `500`: the route cannot tell it
   * from a deletion that did not happen. Its close committed with it, so its
   * viewers are closed all the same, from the outbox (D221) - before #132 they
   * stayed open until a retry. The retry finds no session, answers `404`, and
   * writes a close of its own, which closes a viewer that is still open (D198).
   */
  it('closes the viewers of a deletion whose acknowledgement was lost, and the retry answers 404 and closes them too', async () => {
    const own = await ownServers();

    try {
      const sessionId = await newSession();
      const viewer = await watch(own.port, sessionId);
      const url = `/api/sessions/${sessionId}`;

      own.loseNextCommit();

      const failed = await own.servers.api.inject({ method: 'DELETE', url });

      assert.equal(failed.statusCode, 500, failed.body);
      assert.equal((await remains(sessionId, []))?.sessions, 0, 'the deletion did not commit');
      assert.equal(await withTimeout(viewer.closed, 'the viewer to close'), 4404);
      assert.equal(own.servers.hub.countFor(sessionId), 0);
      assert.deepEqual(viewer.events, []);

      // The retry: a viewer opened on the session meanwhile - by a tab that
      // was set up before the deletion, say - is closed by the retry's close.
      const stillOpen = { closed: [] as number[] };
      const subscriber: Subscriber = {
        send() {},
        close(code) {
          stillOpen.closed.push(code);
        },
        bufferedAmount: 0,
        terminate() {},
      };

      own.servers.hub.add(sessionId, subscriber, new Set());

      const retried = await own.servers.api.inject({ method: 'DELETE', url });

      assert.equal(retried.statusCode, 404);
      assert.deepEqual(retried.json(), SESSION_NOT_FOUND);
      await own.servers.flush();
      assert.deepEqual(stillOpen.closed, [4404]);
      assert.equal(own.servers.hub.countFor(sessionId), 0);
    } finally {
      await own.close();
    }
  });
});

describe('a delayed response outliving its session', () => {
  it('still answers its sender, and publishes nothing and logs no error for it (D109)', async () => {
    const sessionId = await newSession({
      response: { status: 201, body: '{"late":true}', delayMs: 1000 },
    });
    const published: string[] = [];
    const deliver = servers.hub.deliver.bind(servers.hub);
    // The listener reads a payload only when someone wants it (D221).
    const wanting: Subscriber = {
      send: () => undefined,
      close: () => undefined,
      terminate: () => undefined,
      bufferedAmount: 0,
    };

    servers.hub.deliver = (target, type, payload) => {
      if (target === sessionId) {
        published.push(type);
      }

      deliver(target, type, payload);
    };
    servers.hub.add(sessionId, wanting, new Set());

    try {
      // Not awaited: the deletion below happens while this sender waits.
      const answering = fetch(`http://127.0.0.1:${receivePort}/s/${sessionId}`, {
        method: 'POST',
        body: 'x',
      });
      const deadline = Date.now() + WAIT_MS;
      let requestId: string | undefined;

      // Captured, and announced by `request.received`, which is delivered
      // once the capture commits, before the delay ends.
      while (requestId === undefined || published.length === 0) {
        assert.ok(Date.now() < deadline, 'the request was not captured and announced');

        const { rows } = await direct.query<{ id: string }>(
          'SELECT id FROM requests WHERE session_id = $1',
          [sessionId],
        );

        requestId = rows[0]?.id;
        await delay(5);
      }

      assert.deepEqual(published, ['request.received']);
      published.length = 0;

      const fromStatement = statements.length;
      const fromLog = logLines.length;

      assert.equal((await deleteSession(sessionId)).statusCode, 204);

      const answer = await withTimeout(answering, 'the delayed answer');

      assert.equal(answer.status, 201);
      assert.equal(await answer.text(), '{"late":true}');
      assert.equal(answer.headers.get('x-qa-tools-request-id'), requestId);

      // The completion write is fire-and-forget (D109): wait for it to have
      // run, then check what it left behind.
      let completion: Statement | undefined;

      while (completion === undefined) {
        assert.ok(Date.now() < deadline + WAIT_MS, 'the completion write never ran');
        completion = statements
          .slice(fromStatement)
          .find(
            (statement) =>
              statement.text.includes('UPDATE request_responses') &&
              statement.values[0] === requestId,
          );
        await delay(5);
      }

      await completion.settled;
      // Everything committed so far delivered, so an event that should not
      // exist would show (D221).
      await servers.writes.settled();
      await servers.flush();

      assert.deepEqual(published, [], 'an event was delivered for a deleted session');
      assert.deepEqual(errorsSince(fromLog), []);
      assert.deepEqual(await remains(sessionId, [requestId]), {
        sessions: 0,
        requests: 0,
        responses: 0,
      });
    } finally {
      servers.hub.deliver = deliver;
      servers.hub.remove(sessionId, wanting);
    }
  });
});

/** The backends waiting, directly or behind another waiter, on a lock `pid` holds. */
async function blockedBehind(pid: number): Promise<number> {
  const { rows } = await direct.query<{ pid: number; blockers: number[] }>(
    `SELECT pid, pg_blocking_pids(pid) AS blockers
       FROM pg_stat_activity WHERE datname = current_database()`,
  );
  const blocked = new Set<number>();
  let grew = true;

  while (grew) {
    grew = false;

    for (const row of rows) {
      if (
        !blocked.has(row.pid) &&
        row.blockers.some((blocker) => blocker === pid || blocked.has(blocker))
      ) {
        blocked.add(row.pid);
        grew = true;
      }
    }
  }

  return blocked.size;
}

async function untilBlocked(pid: number, count: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;

  while ((await blockedBehind(pid)) < count) {
    assert.ok(Date.now() < deadline, `${count} statements never queued behind the lock`);
    await delay(5);
  }
}

describe('a capture and a deletion of the same session together', () => {
  /**
   * The session row is held by the test, the capture and the deletion queue
   * behind it in the order given, and the row is let go. PostgreSQL grants a
   * row lock to its waiters in the order they queued, so each order is
   * exercised on purpose rather than by chance.
   */
  async function race(first: 'capture' | 'deletion') {
    const sessionId = await newSession();
    const holder = await direct.connect();

    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);

      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = rows[0]?.pid as number;
      const startCapture = () =>
        receiver.inject({ method: 'POST', url: `/s/${sessionId}`, payload: '{"race":1}' });
      const startDeletion = () => deleteSession(sessionId);
      let captured: Promise<Answer>;
      let deleted: Promise<Answer>;

      if (first === 'capture') {
        captured = startCapture();
        await untilBlocked(pid, 1);
        deleted = startDeletion();
      } else {
        deleted = startDeletion();
        await untilBlocked(pid, 1);
        captured = startCapture();
      }

      await untilBlocked(pid, 2);
      await holder.query('COMMIT');

      return { sessionId, captured: await captured, deleted: await deleted };
    } catch (error) {
      await holder.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
  }

  it('stores a capture that holds the lock first, and the deletion then removes it', async () => {
    const fromLog = logLines.length;
    const { sessionId, captured, deleted } = await race('capture');

    assert.equal(captured.statusCode, 200, captured.body);
    assert.equal(deleted.statusCode, 204, deleted.body);

    const requestId = captured.headers['x-qa-tools-request-id'] as string;

    assert.deepEqual(await remains(sessionId, [requestId]), {
      sessions: 0,
      requests: 0,
      responses: 0,
    });
    assert.deepEqual(errorsSince(fromLog), []);
  });

  it('answers a capture that waited for the deletion as for an unknown session', async () => {
    const fromLog = logLines.length;
    const { sessionId, captured, deleted } = await race('deletion');

    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal(captured.statusCode, 404, captured.body);
    assert.deepEqual(captured.json(), SESSION_NOT_FOUND);
    assert.deepEqual(await remains(sessionId, []), { sessions: 0, requests: 0, responses: 0 });
    assert.deepEqual(errorsSince(fromLog), []);
  });

  it('ends without a 500 or a foreign-key error under concurrent captures', async () => {
    const fromLog = logLines.length;

    for (let round = 0; round < 5; round += 1) {
      const sessionId = await newSession();
      const captures = Array.from({ length: 6 }, (_, index) =>
        receiver.inject({ method: 'POST', url: `/s/${sessionId}`, payload: `{"n":${index}}` }),
      );
      // In the middle of the burst, so that some captures run before it and
      // some after.
      const deletion = deleteSession(sessionId);
      const later = Array.from({ length: 6 }, (_, index) =>
        receiver.inject({ method: 'POST', url: `/s/${sessionId}`, payload: `{"m":${index}}` }),
      );

      assert.equal((await deletion).statusCode, 204);

      for (const answer of await Promise.all([...captures, ...later])) {
        if (answer.statusCode === 200) {
          continue;
        }

        assert.equal(answer.statusCode, 404, answer.body);
        assert.deepEqual(answer.json(), SESSION_NOT_FOUND);
      }

      assert.deepEqual(await remains(sessionId, []), { sessions: 0, requests: 0, responses: 0 });
    }

    const errors = errorsSince(fromLog);

    assert.deepEqual(errors, []);
    assert.equal(
      logLines.slice(fromLog).some((line) => line.includes('foreign key')),
      false,
      'a capture met a foreign-key error',
    );
  });
});

describe('a list of requests being written when its session is deleted', () => {
  /** The statement that reads what `include` adds, a request at a time with bodies (D196). */
  const CONTENT_READ = 'WHERE session_id = $1 AND id = ANY($2::uuid[])';
  const BODIES = ['{"event":"first"}', '{"event":"second"}', '{"event":"third"}'];

  /**
   * Lists three requests with their bodies, oldest first, on a server of its
   * own whose pool deletes the session through the API just before the second
   * request's content is read: after the first request has been written and
   * before the rest. Answers what the list answered, how the deletion was
   * answered, how many content reads ran and what the server logged.
   */
  async function listWhileDeleted(
    list: (api: FastifyInstance, sessionId: string) => Promise<Answer>,
  ) {
    const sessionId = await newSession();
    const requestIds: string[] = [];

    for (const body of BODIES) {
      requestIds.push(await capture(sessionId, body));
    }

    await awaitRecorded(sessionId, BODIES.length);

    const ownLog: string[] = [];
    let reads = 0;
    let deletion: Answer | undefined;
    const gated = new Proxy(pool, {
      get(target, property) {
        if (property === 'query') {
          return async (...args: unknown[]) => {
            if (typeof args[0] === 'string' && args[0].includes(CONTENT_READ)) {
              reads += 1;

              if (reads === 2) {
                // Through the suite's own server, whose pool is not gated.
                deletion = await deleteSession(sessionId);
              }
            }

            return (target.query as (...forwarded: unknown[]) => unknown)(...args);
          };
        }

        const value = Reflect.get(target, property, target) as unknown;

        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });

    const own = buildTestServers(gated, {
      logDestination: new Writable({
        write(chunk: Buffer | string, _encoding, callback) {
          ownLog.push(
            ...chunk
              .toString()
              .split('\n')
              .filter((line) => line.length > 0),
          );
          callback();
        },
      }),
    });

    try {
      await own.ready();

      const from = statements.length;
      const answer = await list(own.api, sessionId);
      const listStatements = sentSince(from).filter((text) =>
        text.includes('LEFT JOIN LATERAL'),
      ).length;

      return { sessionId, requestIds, answer, deletion, reads, listStatements, ownLog };
    } finally {
      await own.close();
    }
  }

  /**
   * The answer is the whole array of what was written before the deletion:
   * the requests read after it are gone, the list resumes once beyond them,
   * finds the session gone and lists nothing, and the array is closed (D196's
   * resumption, D198). No `500`, nothing logged as an error, nothing left.
   */
  async function assertEndedWhole(result: Awaited<ReturnType<typeof listWhileDeleted>>) {
    const { sessionId, requestIds, answer, deletion, reads, listStatements, ownLog } = result;

    assert.equal(deletion?.statusCode, 204, deletion?.body);
    assert.equal(answer.statusCode, 200, answer.body);

    const listed = JSON.parse(answer.body) as { id: string; body: string }[];

    assert.deepEqual(
      listed.map(({ id, body }) => ({ id, body })),
      [{ id: requestIds[0], body: BODIES[0] }],
    );
    assert.equal(reads, BODIES.length, 'every chosen request was looked for');
    assert.equal(listStatements, 2, 'the list did not resume exactly once');
    assert.deepEqual(await remains(sessionId, requestIds), {
      sessions: 0,
      requests: 0,
      responses: 0,
    });
    assert.deepEqual(
      ownLog.filter((line) => {
        try {
          return ((JSON.parse(line) as { level?: number }).level ?? 0) >= 50;
        } catch {
          return true;
        }
      }),
      [],
    );
  }

  it('ends the GET with content as a whole array of what it had written (D196, D198)', async () => {
    await assertEndedWhole(
      await listWhileDeleted((api, sessionId) =>
        api.inject({
          method: 'GET',
          url: `/api/sessions/${sessionId}/requests?include=body&order=asc&limit=3`,
        }),
      ),
    );
  });

  it('ends a query of requests with content the same way (D196, D198)', async () => {
    await assertEndedWhole(
      await listWhileDeleted((api, sessionId) =>
        api.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/requests/query`,
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({
            body: ['event'],
            include: ['body'],
            order: 'asc',
            limit: 3,
          }),
        }),
      ),
    );
  });
});

describe('the deletions counted in stats.deletions_daily', () => {
  interface Counted {
    day: string;
    sessions_deleted: number;
    requests_held: number;
  }

  const TODAY = `(clock_timestamp() AT TIME ZONE 'UTC')::date`;

  /**
   * The current UTC day, read once. Every reading of a day row names the day
   * it got from here, so two readings are of one row unless the day changed
   * between them, which `sameDay` then detects.
   */
  async function currentDay(client: pg.PoolClient): Promise<string> {
    const { rows } = await client.query<{ day: string }>(`SELECT ${TODAY}::text AS day`);

    return (rows[0] as { day: string }).day;
  }

  /**
   * Today's row, locked by `client` until its transaction ends, so that no
   * other deletion - another test file's, in this shared database - can change
   * it between two readings. Created at zero when the day has none yet. The
   * day is read once, so midnight between the insert and the lock cannot
   * leave the lock on a row that does not exist.
   */
  async function lockToday(client: pg.PoolClient): Promise<Counted> {
    const day = await currentDay(client);

    await client.query(
      `INSERT INTO stats.deletions_daily (day, sessions_deleted, requests_held)
       VALUES ($1::date, 0, 0) ON CONFLICT (day) DO NOTHING`,
      [day],
    );

    const { rows } = await client.query<Counted>(
      `SELECT day::text, sessions_deleted::int, requests_held::int
         FROM stats.deletions_daily WHERE day = $1::date FOR UPDATE`,
      [day],
    );

    return rows[0] as Counted;
  }

  async function readDay(client: pg.PoolClient, day: string): Promise<Counted | undefined> {
    const { rows } = await client.query<Counted>(
      `SELECT day::text, sessions_deleted::int, requests_held::int
         FROM stats.deletions_daily WHERE day = $1::date`,
      [day],
    );

    return rows[0];
  }

  /** The UTC day can change between two readings, at midnight; such a run is repeated. */
  async function sameDay<T>(attempt: () => Promise<T | 'day changed'>): Promise<T> {
    for (let tries = 0; tries < 3; tries += 1) {
      const result = await attempt();

      if (result !== 'day changed') {
        return result;
      }
    }

    throw new Error('the UTC day changed during every attempt');
  }

  it('counts one more session and the requests it held, in the row of the current UTC day', async () => {
    const sessionId = await newSession();

    for (let index = 0; index < 4; index += 1) {
      await capture(sessionId);
    }

    await awaitRecorded(sessionId, 4);

    const { before, afterwards, result } = await sameDay(async () => {
      const client = await direct.connect();

      try {
        await client.query('BEGIN');

        const before = await lockToday(client);
        const result = await deleteSessionInTransaction(client, sessionId);

        if ((await currentDay(client)) !== before.day) {
          await client.query('ROLLBACK');

          return 'day changed' as const;
        }

        const afterwards = await readDay(client, before.day);

        await client.query('COMMIT');

        return { before, afterwards, result };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });

    assert.deepEqual(result, { outcome: 'deleted', requestsHeld: 4 });
    assert.deepEqual(afterwards, {
      day: before.day,
      sessions_deleted: before.sessions_deleted + 1,
      requests_held: before.requests_held + 4,
    });
    assert.deepEqual(await remains(sessionId, []), { sessions: 0, requests: 0, responses: 0 });
  });

  it('counts nothing when the deletion is rolled back, since both are one transaction', async () => {
    const sessionId = await newSession();

    await capture(sessionId);
    await awaitRecorded(sessionId, 1);

    const { before, afterwards } = await sameDay(async () => {
      const client = await direct.connect();

      try {
        await client.query('BEGIN');

        const before = await lockToday(client);

        await client.query('SAVEPOINT deletion');
        assert.equal((await deleteSessionInTransaction(client, sessionId)).outcome, 'deleted');
        await client.query('ROLLBACK TO SAVEPOINT deletion');

        const day = await currentDay(client);
        const afterwards = await readDay(client, before.day);

        await client.query('ROLLBACK');

        return day === before.day ? { before, afterwards } : ('day changed' as const);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });

    assert.deepEqual(afterwards, before);
    assert.deepEqual((await remains(sessionId, []))?.sessions, 1);
  });

  it('is written by the route, once per deletion, as the day row of the deletion', async () => {
    // The route commits its deletion, so a run the UTC day changed in is
    // repeated with a fresh session. Both readings are of the row of the day
    // read before the deletion, and the day is read again after the second:
    // the deletion's own day, taken between the two, is then that day too.
    const { before, afterwards, sent } = await sameDay(async () => {
      const sessionId = await newSession();

      await capture(sessionId);
      await capture(sessionId);
      await awaitRecorded(sessionId, 2);

      const client = await direct.connect();

      try {
        const day = await currentDay(client);
        const before = (await readDay(client, day)) ?? {
          day,
          sessions_deleted: 0,
          requests_held: 0,
        };
        const from = statements.length;

        assert.equal((await deleteSession(sessionId)).statusCode, 204);

        const afterwards = await readDay(client, day);

        if ((await currentDay(client)) !== day) {
          return 'day changed' as const;
        }

        return { before, afterwards, sent: sentSince(from) };
      } finally {
        client.release();
      }
    });

    // Other files delete sessions in this database too, so the route's own
    // increment is a lower bound here; it is exact in the tests above, and
    // this process sent the count exactly once.
    assert.ok(afterwards, `no row for ${before.day}`);
    assert.ok(afterwards.sessions_deleted >= before.sessions_deleted + 1);
    assert.ok(afterwards.requests_held >= before.requests_held + 2);
    assert.equal(sent.filter((text) => text === COUNT_SESSION_DELETION_SQL).length, 1);
  });
});
