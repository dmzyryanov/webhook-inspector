/**
 * Integration tests for the realtime endpoint.
 *
 * These open real WebSocket connections against a listening server, because
 * what is being tested is the connection itself: which sessions may be watched,
 * and what a watcher receives when a request is captured.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  NEGOTIABLE_EVENT_TYPES,
  REALTIME_EVENTS_PARAM,
  WsCloseCode,
  type RequestListItem,
  type ServerEvent,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { whileExpired } from '../../testing/expired-session.ts';
import { poolHoldingFirstCommitAnswer, poolPausingFirstCommit } from '../../testing/locks.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import {
  closeSockets,
  refused,
  watch,
  watchUrl,
  type Viewer,
  type ViewerEvent,
} from '../../testing/realtime.ts';
import { SESSION_ACCESS_SQL } from '../sessions/access-key.ts';
import { MAX_SUBSCRIBER_BACKLOG_BYTES } from './hub.ts';

const UNKNOWN_SESSION_ID = 'z'.repeat(43);

let pool: pg.Pool;
let servers: TestServers;
/** The application listener, where viewers connect. */
let app: FastifyInstance;
let port: number;
/** The receive listener's port, where webhooks are sent (D187). */
let receivePort: number;
const createdSessionIds: string[] = [];
const openSockets: WebSocket[] = [];

// after() waits for before() to finish. Node's runner does not when a name
// pattern leaves this file no test, and what before() opens would outlive the
// run (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = start();
  await startup;
});

async function start(): Promise<void> {
  pool = createPool(loadConfig().databaseUrl);
  // Two listeners sharing one hub, as the process runs them (D187): a capture
  // on the receive listener is announced to a viewer of the other.
  servers = buildTestServers(pool);
  app = servers.api;
  app.log.level = 'silent';
  servers.receiver.log.level = 'silent';
  port = await listening(app);
  receivePort = await listening(servers.receiver);
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
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers?.close();
  await pool.end();
});

async function newSession(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/sessions' });
  const { id } = response.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

/**
 * A pool that holds the session lookup of the realtime route until a gate
 * opens, so a test can occupy the window between accepting a connection and
 * subscribing it. Everything else - the capture, the request list - runs
 * normally.
 */
function poolHoldingSessionLookup(base: pg.Pool, gate: Promise<void>): pg.Pool {
  return new Proxy(base, {
    get(target, property) {
      if (property === 'query') {
        return async (...args: unknown[]) => {
          // Several queries judge expiration, so match on the very statement
          // of the route's lookup (`sessionAccess`).
          if (args[0] === SESSION_ACCESS_SQL) {
            await gate;
          }

          return (target.query as (...forwarded: unknown[]) => unknown)(...args);
        };
      }

      const value = Reflect.get(target, property, target);

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

/**
 * How long any wait for a message may take. Bounded so that a protocol
 * regression - a `ready` that is never sent, an event that never arrives -
 * fails with a message instead of hanging the suite.
 */
const MESSAGE_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, description: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () =>
          reject(new Error(`Timed out after ${MESSAGE_TIMEOUT_MS}ms waiting for ${description}`)),
        MESSAGE_TIMEOUT_MS,
      ).unref(),
    ),
  ]);
}

/** The next message on a socket, whatever it is. */
function nextMessage(socket: WebSocket, description = 'a message'): Promise<ServerEvent> {
  return withTimeout(
    new Promise<ServerEvent>((resolve, reject) => {
      socket.addEventListener(
        'message',
        (message) => resolve(JSON.parse(message.data as string) as ServerEvent),
        { once: true },
      );
      socket.addEventListener('close', () => reject(new Error('The connection closed')), {
        once: true,
      });
    }),
    description,
  );
}

function sendWebhook(
  sessionId: string,
  body: string,
  origin = `http://127.0.0.1:${receivePort}`,
): Promise<Response> {
  return fetch(`${origin}/s/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

/**
 * Blocks until the session holds `count` response records and none of them is
 * still `pending`.
 *
 * A condition wait rather than a sleep: it asks the database and stops the
 * moment the answer is the one it is waiting for, so it asserts nothing about
 * how long anything takes. What it buys is ordering - once every record is
 * terminal, every `response.recorded` this capture will ever publish has
 * committed with it, so it reaches a socket before the event of anything done
 * afterwards (D221 point 6); not yet that it has reached one. Without it, a
 * completion, written after its reply has ended, may commit after a later
 * call's change.
 */
async function awaitRecorded(sessionId: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const result = await pool.query<{ total: number; pending: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE rr.state = 'pending')::int AS pending
         FROM request_responses rr
         JOIN requests r ON r.id = rr.request_id
        WHERE r.session_id = $1`,
      [sessionId],
    );
    const row = result.rows[0];

    if (row && row.total === count && row.pending === 0) {
      return;
    }

    await delay(1);
  }

  throw new Error(`${count} response records did not reach a terminal state`);
}

/** The event types a declaring client asks for, spelled from the shared list. */
const DECLARES_RECORDED = ['response.recorded'];

/** What the shipped client declares: every negotiable type (D115, D135). */
const DECLARES_EVERYTHING: readonly string[] = NEGOTIABLE_EVENT_TYPES;

/** Captures one request and answers with the id the receiver stored. */
async function capture(sessionId: string, body = '{}'): Promise<string> {
  const response = await sendWebhook(sessionId, body);

  assert.equal(response.status, 200);

  const id = response.headers.get('x-qa-tools-request-id');

  assert.ok(id);

  return id;
}

function deleteOne(sessionId: string, requestId: string) {
  return app.inject({
    method: 'DELETE',
    url: `/api/sessions/${sessionId}/requests/${requestId}`,
  });
}

function clearAll(sessionId: string) {
  return app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/requests` });
}

/**
 * Proves a watcher received nothing it has not already been handed, using the
 * order of one socket rather than a sleep: a fresh capture is sent, and the
 * next event must be its `request.received`. Anything published to this socket
 * before it - a deletion frame the gate should have withheld - would be ahead
 * of it in the queue and returned instead.
 */
async function assertNothingPending(watcher: Viewer, sessionId: string): Promise<void> {
  assert.deepEqual(watcher.unread(), []);

  const probe = await capture(sessionId, '{"probe":true}');
  const next = await watcher.next();

  assert.ok(next.type === 'request.received', `expected request.received, got ${next.type}`);
  assert.equal(next.data.id, probe);
}

describe('realtime endpoint', () => {
  it('delivers a captured request as list metadata, and nothing more', async () => {
    const sessionId = await newSession();
    const watcher = await watch(port, sessionId, []);

    const response = await sendWebhook(sessionId, '{"order":42}');

    assert.equal(response.status, 200);

    const event = await watcher.next();

    assert.ok(event.type === 'request.received');

    // The event carries exactly the list row (D037): no body, no headers. It
    // gained `response` because the list row did, and nothing else (D110,
    // D115), and `path` because the list filter matches it (D180). Removing
    // `sourceCountry` from the detail response did not touch this key set,
    // because the field never entered a list row (D118, D140).
    assert.deepEqual(Object.keys(event.data).sort(), [
      'bodySize',
      'id',
      'method',
      'path',
      'receivedAt',
      'response',
      'sourceIp',
    ]);
    assert.equal(event.data.path, `/s/${sessionId}`);

    // Always `pending` here: the event is published after the capture commits
    // and before the response is written (D110).
    assert.deepEqual(event.data.response, {
      state: 'pending',
      status: 200,
      queueStep: null,
      rule: null,
    });
    assert.equal(event.data.method, 'POST');
    assert.equal(event.data.bodySize, 12);
    assert.ok(!Number.isNaN(Date.parse(event.data.receivedAt)));

    // The same request the list API reports, described the same way (D075).
    // Every field is compared, `response` included - but `response` is the one
    // that is a moment rather than a fact: the event was published while the
    // record was still `pending` and the list is read after it settled, so the
    // event's own value is asserted above and the shape is what is compared
    // here - and the read waits for the record to settle first, because the
    // completion write is fire-and-forget and the two queries do not share a
    // connection (D109).
    await awaitRecorded(sessionId, 1);

    const listed = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/requests` });
    const [row] = listed.json<RequestListItem[]>();

    assert.equal(listed.json<RequestListItem[]>().length, 1);
    assert.deepEqual({ ...row, response: null }, { ...event.data, response: null });
    assert.deepEqual(Object.keys(row?.response ?? {}).sort(), [
      'queueStep',
      'rule',
      'state',
      'status',
    ]);
    assert.equal(row?.response?.state, 'sent');

    watcher.close();
  });

  it('does not deliver a session’s requests to a watcher of another session', async () => {
    const [watched, other] = await Promise.all([newSession(), newSession()]);
    const [watcher, bystander] = await Promise.all([
      watch(port, watched, []),
      watch(port, other, []),
    ]);

    await sendWebhook(watched, '{}');
    await watcher.next();

    // The capture has been delivered, so anything the bystander was going to
    // receive would have arrived by now.
    assert.deepEqual(bystander.unread(), []);

    watcher.close();
    bystander.close();
  });

  it('refuses an unknown session', async () => {
    assert.deepEqual(await refused(port, UNKNOWN_SESSION_ID), {
      code: WsCloseCode.SESSION_NOT_FOUND,
      messages: [],
    });
  });

  it('refuses a session id that cannot be one', async () => {
    assert.deepEqual(await refused(port, 'not-a-session-id'), {
      code: WsCloseCode.SESSION_NOT_FOUND,
      messages: [],
    });
  });

  it('refuses an expired session', async () => {
    const sessionId = await newSession();

    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      sessionId,
    ]);

    assert.deepEqual(await refused(port, sessionId), {
      code: WsCloseCode.SESSION_EXPIRED,
      messages: [],
    });
  });

  /**
   * The handshake is accepted before the session has even been looked up, so
   * there is a window in which the transport is open and nothing is subscribed
   * yet. A viewer reloading the list at that moment would miss a request
   * captured immediately afterwards: too late for the reload, too early for an
   * event. `ready` is what closes the window, and this test holds it open on
   * purpose to prove it (D081).
   */
  it('loses nothing captured while a connection is still being subscribed', async () => {
    const sessionId = await newSession();

    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const gatedServers = buildTestServers(poolHoldingSessionLookup(pool, held));
    const gated = gatedServers.api;

    gated.log.level = 'silent';
    gatedServers.receiver.log.level = 'silent';

    const gatedPort = await listening(gated);
    const gatedReceivePort = await listening(gatedServers.receiver);

    try {
      const socket = new WebSocket(`ws://127.0.0.1:${gatedPort}/ws/${sessionId}`);

      openSockets.push(socket);

      const messages: ServerEvent[] = [];

      socket.addEventListener('message', (message) => {
        messages.push(JSON.parse(message.data as string) as ServerEvent);
      });

      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve());
        socket.addEventListener('error', () => reject(new Error('The connection failed')));
      });

      // The transport is open while the session lookup is still held, so the
      // server has said nothing yet.
      assert.deepEqual(messages, []);

      const captured = await sendWebhook(
        sessionId,
        '{"during":true}',
        `http://127.0.0.1:${gatedReceivePort}`,
      );

      assert.equal(captured.status, 200);

      // Nothing was subscribed when it was captured, so it arrives as no event.
      assert.deepEqual(messages, []);

      const ready = nextMessage(socket, 'the connection to report itself ready');

      release();

      assert.deepEqual(await ready, { type: 'ready' });

      // What the viewer does on `ready`: reload. The request captured inside the
      // window is in the answer, which is the half of the guarantee the reload
      // carries.
      const listed = await gated.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/requests`,
      });

      assert.equal(listed.json<RequestListItem[]>().length, 1);

      // And the other half: from `ready` onwards, captures arrive as events, so
      // nothing falls between the reload and the subscription.
      const afterReady = nextMessage(socket, 'the request captured after ready');

      await sendWebhook(sessionId, '{"after":true}', `http://127.0.0.1:${gatedReceivePort}`);

      assert.equal((await afterReady).type, 'request.received');
    } finally {
      await gatedServers.close();
    }
  });

  /**
   * The per-connection declaration (D115), proved in the only terms the server
   * observes: what a socket that asked for nothing receives.
   *
   * The order is what makes this deterministic rather than a race. The first
   * capture's record is terminal before the second is even sent, so any
   * `response.recorded` it was going to produce has already committed; had it
   * been sent to this socket it would arrive ahead of the second
   * `request.received`, and `next()` would return it instead.
   */
  it('sends no response.recorded to a connection that declared nothing', async () => {
    const sessionId = await newSession();
    const watcher = await watch(port, sessionId, []);

    await sendWebhook(sessionId, '{"first":true}');

    const first = await watcher.next();

    assert.equal(first.type, 'request.received');
    await awaitRecorded(sessionId, 1);

    await sendWebhook(sessionId, '{"second":true}');

    const second = await watcher.next();

    assert.equal(second.type, 'request.received');
    await awaitRecorded(sessionId, 2);

    // Nothing else arrived, on either capture.
    assert.deepEqual(watcher.unread(), []);

    watcher.close();
  });

  /**
   * The same client after a reconnection, which is the case D115 exists for:
   * an old bundle is still running its original JavaScript when the pod is
   * replaced, so it presents no declaration on the connection that follows. The
   * server cannot see a bundle, only a socket with no parameter on it - and
   * that is exactly what this reopens.
   */
  it('sends no response.recorded after a connection that declared nothing reconnects', async () => {
    const sessionId = await newSession();
    const first = await watch(port, sessionId, []);

    first.close();

    const reconnected = await watch(port, sessionId, []);

    await sendWebhook(sessionId, '{"after":"reconnect"}');

    const received = await reconnected.next();

    assert.equal(received.type, 'request.received');
    await awaitRecorded(sessionId, 1);

    assert.deepEqual(reconnected.unread(), []);

    reconnected.close();
  });

  it('sends response.recorded to a connection that declared it', async () => {
    const sessionId = await newSession();
    const watcher = await watch(port, sessionId, DECLARES_RECORDED);

    await sendWebhook(sessionId, '{"declared":true}');

    const captured = await watcher.next();

    assert.ok(captured.type === 'request.received');

    const recorded = await watcher.next();

    assert.ok(recorded.type === 'response.recorded');
    assert.equal(recorded.data.id, captured.data.id);
    assert.equal(recorded.data.response.state, 'sent');
    assert.equal(recorded.data.response.status, 200);

    watcher.close();
  });

  /**
   * The only test that proves the hub **selects** rather than broadcasts, and
   * it has to be at socket level: one session, one capture, two sockets open at
   * the same moment, differing in nothing but their declaration.
   *
   * It is deterministic without any wait of its own. `publish` walks its
   * subscribers in one synchronous call, so by the time the declaring socket
   * holds the event, the other one has already been offered it and skipped.
   */
  it('sends response.recorded to the declaring socket of a session and not the other', async () => {
    const sessionId = await newSession();
    const [declaring, silent] = await Promise.all([
      watch(port, sessionId, DECLARES_RECORDED),
      watch(port, sessionId, []),
    ]);

    await sendWebhook(sessionId, '{"fanout":true}');

    const capturedByDeclaring = await declaring.next();
    const capturedBySilent = await silent.next();

    assert.ok(capturedByDeclaring.type === 'request.received');
    assert.equal(capturedBySilent.type, 'request.received');

    const recorded = await declaring.next();

    assert.ok(recorded.type === 'response.recorded');
    assert.equal(recorded.data.id, capturedByDeclaring.data.id);

    // Same session, same capture, same instant: the difference is the
    // declaration and nothing else.
    assert.deepEqual(silent.unread(), []);

    declaring.close();
    silent.close();
  });

  /**
   * A declaration the server cannot use is a no-op, never a refusal: D076's
   * close-code table gains no row for it (D115). Each of these still gets
   * `ready`, which is what `watch` resolves on, so reaching the assertions at
   * all is half the proof.
   */
  for (const [description, query] of [
    ['an empty value', `${REALTIME_EVENTS_PARAM}=`],
    ['an unknown event type', `${REALTIME_EVENTS_PARAM}=nonsense`],
    ['a repeated key', `${REALTIME_EVENTS_PARAM}=nonsense&${REALTIME_EVENTS_PARAM}=also-nonsense`],
  ]) {
    it(`accepts ${description} and sends it no response.recorded`, async () => {
      const sessionId = await newSession();
      const watcher = await watchUrl(`ws://127.0.0.1:${port}/ws/${sessionId}?${query}`);

      await sendWebhook(sessionId, '{"malformed":"declaration"}');

      const received = await watcher.next();

      assert.equal(received.type, 'request.received');
      await awaitRecorded(sessionId, 1);

      assert.deepEqual(watcher.unread(), []);

      watcher.close();
    });
  }

  it('stops delivering to a closed connection without failing the capture', async () => {
    const sessionId = await newSession();
    const watcher = await watch(port, sessionId, []);

    watcher.close();

    // Wait for the server to observe the close, so the capture below publishes
    // into a session with no subscribers left.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await sendWebhook(sessionId, '{}');

    assert.equal(response.status, 200);
    assert.deepEqual(watcher.unread(), []);
  });
});

/**
 * Deletions reaching every open viewer of the session (issue #7, D135-D137).
 *
 * Watchers declare `request.received` implicitly and the deletion types
 * explicitly. Each capture below is consumed from the watcher before the
 * deletion is made, and `response.recorded` is not declared where it would
 * interleave, so the next event on a socket is exactly what the deletion
 * published.
 */
describe('deletion events', () => {
  const DECLARES_DELETIONS = ['request.deleted', 'requests.cleared'];

  it('publishes request.deleted with the id to every declaring viewer of the session', async () => {
    const sessionId = await newSession();
    const [acting, other] = await Promise.all([
      watch(port, sessionId, DECLARES_DELETIONS),
      watch(port, sessionId, DECLARES_DELETIONS),
    ]);
    const id = await capture(sessionId);

    await acting.next();
    await other.next();

    const response = await deleteOne(sessionId, id);

    assert.equal(response.statusCode, 204);

    // The viewer that asked receives its own event too: no origin is tracked
    // (D136).
    for (const watcher of [acting, other]) {
      assert.deepEqual(await watcher.next(), { type: 'request.deleted', data: { id } });
    }

    acting.close();
    other.close();
  });

  it('publishes the id as the list spells it when the route is given upper case', async () => {
    const sessionId = await newSession();
    const watcher = await watch(port, sessionId, DECLARES_DELETIONS);
    const id = await capture(sessionId);

    await watcher.next();

    const response = await deleteOne(sessionId, id.toUpperCase());

    assert.equal(response.statusCode, 204);
    assert.deepEqual(await watcher.next(), { type: 'request.deleted', data: { id } });

    watcher.close();
  });

  it('publishes requests.cleared, with no data, to every declaring viewer', async () => {
    const sessionId = await newSession();
    const [acting, other] = await Promise.all([
      watch(port, sessionId, DECLARES_DELETIONS),
      watch(port, sessionId, DECLARES_DELETIONS),
    ]);

    await capture(sessionId);
    await acting.next();
    await other.next();

    const response = await clearAll(sessionId);

    assert.equal(response.statusCode, 204);

    for (const watcher of [acting, other]) {
      assert.deepEqual(await watcher.next(), { type: 'requests.cleared' });
    }

    acting.close();
    other.close();
  });

  /** Criterion 5: the gate of D115 holds for both new types. */
  it('sends neither frame to a connection that declared nothing', async () => {
    const sessionId = await newSession();
    const [declaring, silent] = await Promise.all([
      watch(port, sessionId, DECLARES_EVERYTHING),
      watch(port, sessionId, []),
    ]);
    const id = await capture(sessionId);

    await declaring.next();
    await silent.next();
    await awaitRecorded(sessionId, 1);
    assert.equal((await declaring.next()).type, 'response.recorded');

    assert.equal((await deleteOne(sessionId, id)).statusCode, 204);
    assert.equal((await clearAll(sessionId)).statusCode, 204);

    assert.equal((await declaring.next()).type, 'request.deleted');
    assert.equal((await declaring.next()).type, 'requests.cleared');

    await assertNothingPending(silent, sessionId);

    declaring.close();
    silent.close();
  });

  it('sends neither frame to a connection that declared only response.recorded', async () => {
    const sessionId = await newSession();
    const watcher = await watch(port, sessionId, DECLARES_RECORDED);
    const id = await capture(sessionId);

    assert.equal((await watcher.next()).type, 'request.received');
    assert.equal((await watcher.next()).type, 'response.recorded');

    assert.equal((await deleteOne(sessionId, id)).statusCode, 204);
    assert.equal((await clearAll(sessionId)).statusCode, 204);

    const probe = await capture(sessionId, '{"probe":true}');
    const next = await watcher.next();

    assert.ok(next.type === 'request.received');
    assert.equal(next.data.id, probe);

    watcher.close();
  });

  /** Criterion 6: the service throws before the route reaches the publish. */
  it('publishes nothing for a delete answered 404', async () => {
    const sessionId = await newSession();
    const watcher = await watch(port, sessionId, DECLARES_DELETIONS);
    const id = await capture(sessionId);

    await watcher.next();

    for (const missing of ['00000000-0000-4000-8000-000000000000', 'not-a-request-id']) {
      const response = await deleteOne(sessionId, missing);

      assert.equal(response.statusCode, 404, missing);
      assert.equal(response.json<{ errorCode: number }>().errorCode, 1003);
    }

    // Deleted once, then again: the second answer is a 404 and publishes
    // nothing either.
    assert.equal((await deleteOne(sessionId, id)).statusCode, 204);
    assert.deepEqual(await watcher.next(), { type: 'request.deleted', data: { id } });
    assert.equal((await deleteOne(sessionId, id)).statusCode, 404);

    await assertNothingPending(watcher, sessionId);

    watcher.close();
  });

  it('publishes nothing when the session has expired', async () => {
    const sessionId = await newSession();
    const watcher = await watch(port, sessionId, DECLARES_DELETIONS);
    const id = await capture(sessionId);

    await watcher.next();

    // Held against the cleanup sweep until it is revived, which a sweep that
    // waited for the hold then leaves alone.
    await whileExpired(pool, sessionId, async () => {
      assert.equal((await deleteOne(sessionId, id)).statusCode, 410);
      assert.equal((await clearAll(sessionId)).statusCode, 410);

      // An expired session refuses captures, so the socket's order cannot be
      // probed here. Revive it for the probe alone: anything published by the
      // two refused calls would already be queued ahead of the probe's event.
      await pool.query("UPDATE sessions SET expires_at = now() + interval '1 day' WHERE id = $1", [
        sessionId,
      ]);
    });
    await assertNothingPending(watcher, sessionId);

    watcher.close();
  });

  /** Criterion 7. */
  it('answers 204 to a clear of an empty session and publishes a harmless requests.cleared', async () => {
    const sessionId = await newSession();
    const watcher = await watch(port, sessionId, DECLARES_DELETIONS);

    const response = await clearAll(sessionId);

    assert.equal(response.statusCode, 204);
    assert.equal(response.body, '');
    assert.deepEqual(await watcher.next(), { type: 'requests.cleared' });

    // The connection is unharmed and keeps delivering.
    await assertNothingPending(watcher, sessionId);

    watcher.close();
  });

  /** Criterion 8. */
  it('does not deliver either event to a viewer of another session', async () => {
    const [watched, other] = await Promise.all([newSession(), newSession()]);
    const [watcher, bystander] = await Promise.all([
      watch(port, watched, DECLARES_DELETIONS),
      watch(port, other, DECLARES_DELETIONS),
    ]);
    const id = await capture(watched);

    await watcher.next();

    assert.equal((await deleteOne(watched, id)).statusCode, 204);
    assert.equal((await clearAll(watched)).statusCode, 204);
    assert.equal((await watcher.next()).type, 'request.deleted');
    assert.equal((await watcher.next()).type, 'requests.cleared');

    await assertNothingPending(bystander, other);

    watcher.close();
    bystander.close();
  });
});

/**
 * `session.updated` (D152): the response change reaches every viewer that
 * declared it, the one that made it included, and nobody else - a connection
 * that declared nothing still receives exactly the v0.4.0 event set (D115).
 */
describe('response change events', () => {
  const DECLARES_UPDATES = ['session.updated'];

  /** A custom response that still answers `200`, so a probe capture succeeds. */
  const CUSTOM_200 = {
    status: 200,
    headers: [['x-trace-id', 'abc']] as [string, string][],
    body: '{"kept":true}',
    delayMs: 0,
    template: false,
  };

  function changeResponse(sessionId: string, body: object | string) {
    return app.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/response`,
      headers: { 'content-type': 'application/json' },
      payload: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('publishes the new state to every declaring viewer, the one that changed it included', async () => {
    const sessionId = await newSession();
    const [acting, other] = await Promise.all([
      watch(port, sessionId, DECLARES_UPDATES),
      watch(port, sessionId, DECLARES_EVERYTHING),
    ]);

    const toCustom = await changeResponse(sessionId, { mode: 'custom', response: CUSTOM_200 });

    assert.equal(toCustom.statusCode, 200);

    for (const watcher of [acting, other]) {
      assert.deepEqual(await watcher.next(), {
        type: 'session.updated',
        data: { response: CUSTOM_200, customResponse: CUSTOM_200, queue: null, rules: [] },
      });
    }

    // The default keeps the custom response, and the event says so.
    assert.equal((await changeResponse(sessionId, { mode: 'default' })).statusCode, 200);

    for (const watcher of [acting, other]) {
      assert.deepEqual(await watcher.next(), {
        type: 'session.updated',
        data: { response: null, customResponse: CUSTOM_200, queue: null, rules: [] },
      });
    }

    acting.close();
    other.close();
  });

  it('carries exactly what the change answered and what the session now reads', async () => {
    const sessionId = await newSession();
    const watcher = await watch(port, sessionId, DECLARES_UPDATES);

    const answered = await changeResponse(sessionId, { mode: 'custom', response: { status: 200 } });
    const event = await watcher.next();
    const read = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    const { response, customResponse, queue, rules } = read.json<{
      response: unknown;
      customResponse: unknown;
      queue: unknown;
      rules: unknown;
    }>();

    assert.ok(event.type === 'session.updated');
    assert.deepEqual(event.data, answered.json());
    assert.deepEqual(event.data, { response, customResponse, queue, rules });

    watcher.close();
  });

  it('sends nothing to a connection that declared nothing, or only the other types', async () => {
    const sessionId = await newSession();
    const [silent, deletions, declaring] = await Promise.all([
      watch(port, sessionId, []),
      watch(port, sessionId, ['response.recorded', 'request.deleted', 'requests.cleared']),
      watch(port, sessionId, DECLARES_UPDATES),
    ]);

    assert.equal(
      (await changeResponse(sessionId, { mode: 'custom', response: CUSTOM_200 })).statusCode,
      200,
    );
    assert.equal((await declaring.next()).type, 'session.updated');

    // Anything published to these two by the change would be queued ahead of
    // the probe capture's own `request.received`.
    await assertNothingPending(silent, sessionId);

    const probe = await capture(sessionId, '{"probe":true}');
    let next = await deletions.next();

    // The declaring-deletions socket also declared `response.recorded`, so the
    // first probe's record may arrive before the second probe's row.
    while (next.type !== 'request.received' || next.data.id !== probe) {
      assert.notEqual(next.type, 'session.updated');
      next = await deletions.next();
    }

    silent.close();
    deletions.close();
    declaring.close();
  });

  it('publishes nothing for a refused change', async () => {
    const sessionId = await newSession();
    const watcher = await watch(port, sessionId, DECLARES_UPDATES);

    assert.equal((await changeResponse(sessionId, { mode: 'custom' })).statusCode, 400);
    assert.equal((await changeResponse(sessionId, '{"mode":')).statusCode, 400);
    // A Location on a 200 and one outside /s/ (D247).
    for (const response of [
      { status: 200, headers: [['Location', '/s/x']] },
      { status: 302, headers: [['Location', 'https://evil.example/']] },
    ]) {
      assert.equal((await changeResponse(sessionId, { mode: 'custom', response })).statusCode, 400);
    }

    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      sessionId,
    ]);
    assert.equal((await changeResponse(sessionId, { mode: 'default' })).statusCode, 410);

    // Revived for the probe alone, as for the deletions above: anything the
    // refused calls published would already be queued ahead of it.
    await pool.query("UPDATE sessions SET expires_at = now() + interval '1 day' WHERE id = $1", [
      sessionId,
    ]);
    await assertNothingPending(watcher, sessionId);

    watcher.close();
  });

  it('does not deliver the change to a viewer of another session', async () => {
    const [changed, other] = await Promise.all([newSession(), newSession()]);
    const [watcher, bystander] = await Promise.all([
      watch(port, changed, DECLARES_UPDATES),
      watch(port, other, DECLARES_UPDATES),
    ]);

    assert.equal((await changeResponse(changed, { mode: 'default' })).statusCode, 200);
    assert.equal((await watcher.next()).type, 'session.updated');

    await assertNothingPending(bystander, other);

    watcher.close();
    bystander.close();
  });
});

/**
 * The response queue's events (D205): setting, restarting and removing it
 * publish `session.updated` with the whole state the call answered; a capture
 * names the step that answered it in `request.received` and in
 * `response.recorded`; a clear publishes `requests.cleared` and starts the
 * queue again, which the next capture's step shows.
 */
describe('response queue events', () => {
  const DECLARES_UPDATES = ['session.updated'];

  function queueCall(sessionId: string, method: 'PUT' | 'POST' | 'DELETE', steps?: object[]) {
    return app.inject({
      method,
      url: `/api/sessions/${sessionId}/queue${method === 'POST' ? '/restart' : ''}`,
      ...(steps === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ steps }) }),
    });
  }

  it('publishes the state each queue call answered to every declaring viewer', async () => {
    const sessionId = await newSession();
    const [acting, other] = await Promise.all([
      watch(port, sessionId, DECLARES_UPDATES),
      watch(port, sessionId, DECLARES_EVERYTHING),
    ]);

    for (const call of [
      () => queueCall(sessionId, 'PUT', [{ status: 503 }, { status: 504 }]),
      () => queueCall(sessionId, 'POST'),
      () => queueCall(sessionId, 'DELETE'),
    ]) {
      const answered = await call();

      assert.equal(answered.statusCode, 200);

      for (const watcher of [acting, other]) {
        assert.deepEqual(await watcher.next(), { type: 'session.updated', data: answered.json() });
      }
    }

    acting.close();
    other.close();
  });

  /**
   * A restart or a removal on a session without a queue changes nothing a
   * viewer shows: it is answered with the state and is a use of the session
   * (D133), and publishes nothing (D205; the Architect's note C4 on
   * correction round 7). A second removal included.
   */
  it('publishes nothing for a restart or a removal on a session without a queue', async () => {
    const sessionId = await newSession();
    const watcher = await watch(port, sessionId, DECLARES_UPDATES);

    for (const method of ['POST', 'DELETE'] as const) {
      const answered = await queueCall(sessionId, method);

      assert.equal(answered.statusCode, 200);
      assert.equal(answered.json<{ queue: unknown }>().queue, null);
    }

    await assertNothingPending(watcher, sessionId);

    const saved = await queueCall(sessionId, 'PUT', [{ status: 503 }]);
    const removed = await queueCall(sessionId, 'DELETE');

    assert.deepEqual(await watcher.next(), { type: 'session.updated', data: saved.json() });
    assert.deepEqual(await watcher.next(), { type: 'session.updated', data: removed.json() });
    assert.equal((await queueCall(sessionId, 'DELETE')).statusCode, 200);
    assert.equal((await queueCall(sessionId, 'POST')).statusCode, 200);

    await assertNothingPending(watcher, sessionId);

    watcher.close();
  });

  it('publishes nothing for a refused queue call', async () => {
    const sessionId = await newSession();
    const watcher = await watch(port, sessionId, DECLARES_UPDATES);

    assert.equal((await queueCall(sessionId, 'PUT', [])).statusCode, 400);

    await assertNothingPending(watcher, sessionId);

    watcher.close();
  });

  it('names the step in request.received and response.recorded, and none for the session response', async () => {
    const sessionId = await newSession();

    assert.equal((await queueCall(sessionId, 'PUT', [{ status: 200 }])).statusCode, 200);

    const watcher = await watch(port, sessionId, ['response.recorded']);

    const first = await capture(sessionId);
    const second = await capture(sessionId);

    await awaitRecorded(sessionId, 2);

    const events = [
      await watcher.next(),
      await watcher.next(),
      await watcher.next(),
      await watcher.next(),
    ];
    // Each completion is written after its reply has ended, under no lock of
    // the session, so the first capture's `response.recorded` may arrive after
    // the second's `request.received` or after its `response.recorded` (D221
    // point 6): each event is matched to its request by id, not by its place.
    const stepIn = (type: 'request.received' | 'response.recorded', id: string): unknown => {
      const steps = events.flatMap((event) =>
        (event.type === 'request.received' || event.type === 'response.recorded') &&
        event.type === type &&
        event.data.id === id
          ? [event.data.response?.queueStep]
          : [],
      );

      assert.equal(steps.length, 1, `one ${type} of ${id}`);

      return steps[0];
    };

    assert.deepEqual(
      [stepIn('request.received', first), stepIn('request.received', second)],
      [{ index: 1, total: 1 }, null],
    );
    assert.deepEqual(
      [stepIn('response.recorded', first), stepIn('response.recorded', second)],
      [{ index: 1, total: 1 }, null],
    );

    watcher.close();
  });

  it('starts the queue again on a clear, which the next capture shows', async () => {
    const sessionId = await newSession();

    assert.equal(
      (await queueCall(sessionId, 'PUT', [{ status: 200 }, { status: 200 }])).statusCode,
      200,
    );

    const watcher = await watch(port, sessionId, ['requests.cleared']);

    await capture(sessionId);
    assert.deepEqual((await watcher.next()).type, 'request.received');
    assert.equal((await clearAll(sessionId)).statusCode, 204);
    assert.deepEqual(await watcher.next(), { type: 'requests.cleared' });

    await capture(sessionId);

    const next = await watcher.next();

    assert.ok(next.type === 'request.received');
    assert.deepEqual(next.data.response?.queueStep, { index: 1, total: 2 });

    watcher.close();
  });
});

/**
 * The events of a session's calls reach its viewers in the order the calls
 * took the session row's lock (`RealtimeHub.inOrder`, D205; the outside
 * review's finding 1 on correction round 6). Each test runs on a pair of
 * listeners sharing one hub, as the process runs them, whose pool holds back
 * the answer to capture A's `COMMIT`: A is in the database and the row's lock
 * is free, but A has not published yet - the moment in which a later call
 * could publish before it. The later call is made then, and A is let go once
 * that call has answered or has been kept waiting for `HELD_MS`; without the
 * line it answers within that time and publishes first.
 */
describe('publish order follows the session row lock (D205)', () => {
  /** How long a later call is given while A's commit is held; in the line it waits for A. */
  const HELD_MS = 300;
  const DECLARES_QUEUE_EVENTS = ['session.updated', 'requests.cleared'];

  interface HeldPair {
    servers: TestServers;
    /** The port of the pair's application listener, where viewers connect. */
    port: number;
    /** Where webhooks to the pair are sent. */
    receiveOrigin: string;
    committed: Promise<void>;
    release: () => void;
  }

  async function heldPair(): Promise<HeldPair> {
    const held = poolHoldingFirstCommitAnswer(pool);
    const pair = buildTestServers(held.pool);

    pair.api.log.level = 'silent';
    pair.receiver.log.level = 'silent';

    return {
      servers: pair,
      port: await listening(pair.api),
      receiveOrigin: `http://127.0.0.1:${await listening(pair.receiver)}`,
      committed: held.committed,
      release: held.release,
    };
  }

  /** A session with a queue of these statuses, saved on the shared listeners. */
  async function sessionWithQueue(statuses: number[]): Promise<string> {
    const sessionId = await newSession();
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/queue`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ steps: statuses.map((status) => ({ status })) }),
    });

    assert.equal(saved.statusCode, 200);

    return sessionId;
  }

  /**
   * Captures A on the pair, waits until it has committed, makes the later
   * call, and lets A's commit answer once that call has answered or `HELD_MS`
   * has passed; `answeredWhileHeld` says whether the later call had answered
   * by then. A call in the session's line has not: its turn starts only once
   * A's has ended, with A's commit answered and A published.
   */
  async function captureThen<T>(
    pair: HeldPair,
    sessionId: string,
    later: () => Promise<T>,
  ): Promise<{ first: Response; later: T; answeredWhileHeld: boolean }> {
    const first = sendWebhook(sessionId, '{"call":"A"}', pair.receiveOrigin);

    await withTimeout(pair.committed, 'capture A to commit');

    const answer = later();
    let answered = false;
    const settled = (): void => {
      answered = true;
    };

    void answer.then(settled, settled);
    await Promise.race([answer, delay(HELD_MS)]);

    const answeredWhileHeld = answered;

    pair.release();

    return { first: await first, later: await answer, answeredWhileHeld };
  }

  /** The step a `request.received` names, or the type of any other event. */
  function stepOf(event: ViewerEvent): unknown {
    return event.type === 'request.received' ? event.data.response?.queueStep : event.type;
  }

  async function storedRequests(sessionId: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM requests WHERE session_id = $1',
      [sessionId],
    );

    return result.rows[0]?.count ?? -1;
  }

  /**
   * What a viewer declaring `requests.cleared` hears of capture A, which took
   * step 1 of 2, and of a clear made after it that waited in the line. The
   * clear's turn starts once A's has ended, and its commit purges the
   * payload of A's `request.received` (D221 point 8). The pair's listener
   * reads A's row at the end of the window of `COALESCE_MS` that A's
   * answered commit opened, or at a tick, which may fall while A's answer is
   * held: nothing orders that read and the clear's commit, and the clear
   * usually commits inside the window (#279, `docs/testing/flakes.md` F-20).
   * So the viewer is either sent A's step and then `requests.cleared` (D205
   * point 12), or, the clear first, sent nothing and closed `1013` to read
   * the session again, the cost D221 point 8 accepts of a clear that
   * overtakes a read. Either keeps the order: in the second A's row is still
   * taken before the clear's - usually in one read, by id - and its
   * reload drops the viewer before the clear's row is delivered. Anything
   * else fails: `requests.cleared` before or without the step, another
   * event, another close code, or neither within `next`'s 10 s.
   */
  async function heardOfClearAfterCapture(watcher: Viewer): Promise<string> {
    let first: ViewerEvent;

    try {
      first = await watcher.next();
    } catch (error) {
      // `next` rejects when the connection closes first, and when its time
      // runs out with the connection open.
      if (watcher.isOpen()) {
        throw error;
      }

      assert.equal(await withTimeout(watcher.closed, 'the viewer’s close'), 1013);
      assert.deepEqual(watcher.events, []);

      return 'nothing, then a 1013 close to reload';
    }

    assert.deepEqual(stepOf(first), { index: 1, total: 2 });
    assert.deepEqual(await watcher.next(), { type: 'requests.cleared' });

    return 'step 1 of 2, then requests.cleared';
  }

  /** The session after the clear: no request, A's included, and its queue at step 1 again. */
  async function assertClearedAfterCapture(sessionId: string): Promise<void> {
    assert.equal(await storedRequests(sessionId), 0);

    const read = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });

    assert.equal(read.json<{ queue: { next: number } }>().queue.next, 1);
  }

  /** A `tools/call` on the pair's `/mcp`, as `mcp-limits.test.ts` sends one. */
  function toolCall(pair: HeldPair, name: string, args: Record<string, unknown>) {
    return pair.servers.api.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
  }

  it('sends the steps of two captures in the order they took the lock', async () => {
    const sessionId = await sessionWithQueue([501, 502]);
    const pair = await heldPair();

    try {
      const watcher = await watch(pair.port, sessionId, DECLARES_QUEUE_EVENTS);
      const { first, later } = await captureThen(pair, sessionId, () =>
        sendWebhook(sessionId, '{"call":"B"}', pair.receiveOrigin),
      );

      assert.equal(first.status, 501);
      assert.equal(later.status, 502);
      assert.deepEqual(
        [stepOf(await watcher.next()), stepOf(await watcher.next())],
        [
          { index: 1, total: 2 },
          { index: 2, total: 2 },
        ],
      );

      watcher.close();
    } finally {
      pair.release();
      await pair.servers.close();
    }
  });

  it('sends the step a capture took before the session.updated of a Run again after it', async () => {
    const sessionId = await sessionWithQueue([501]);
    const pair = await heldPair();

    try {
      const watcher = await watch(pair.port, sessionId, DECLARES_QUEUE_EVENTS);
      const { first, later } = await captureThen(pair, sessionId, () =>
        pair.servers.api.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/queue/restart`,
        }),
      );

      assert.equal(first.status, 501);
      assert.equal(later.statusCode, 200);
      assert.equal(later.json<{ queue: { next: number } }>().queue.next, 1);
      assert.deepEqual(stepOf(await watcher.next()), { index: 1, total: 1 });
      assert.deepEqual(await watcher.next(), { type: 'session.updated', data: later.json() });

      watcher.close();
    } finally {
      pair.release();
      await pair.servers.close();
    }
  });

  it('sends the step a capture took before the session.updated of a queue of the same length saved after it', async () => {
    const sessionId = await sessionWithQueue([501, 502]);
    const pair = await heldPair();

    try {
      const watcher = await watch(pair.port, sessionId, DECLARES_QUEUE_EVENTS);
      const { first, later } = await captureThen(pair, sessionId, () =>
        pair.servers.api.inject({
          method: 'PUT',
          url: `/api/sessions/${sessionId}/queue`,
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ steps: [{ status: 503 }, { status: 504 }] }),
        }),
      );

      assert.equal(first.status, 501);
      assert.equal(later.statusCode, 200);
      assert.deepEqual(stepOf(await watcher.next()), { index: 1, total: 2 });
      assert.deepEqual(await watcher.next(), { type: 'session.updated', data: later.json() });

      watcher.close();
    } finally {
      pair.release();
      await pair.servers.close();
    }
  });

  it('sends a capture’s step before the requests.cleared of a clear after it, or has the viewer reload, and the clear deletes its request', async (t) => {
    const sessionId = await sessionWithQueue([501, 502]);
    const pair = await heldPair();

    try {
      const watcher = await watch(pair.port, sessionId, DECLARES_QUEUE_EVENTS);
      const { first, later, answeredWhileHeld } = await captureThen(pair, sessionId, () =>
        pair.servers.api.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/requests` }),
      );

      assert.equal(first.status, 501);
      assert.equal(answeredWhileHeld, false, 'the clear did not wait in the line for capture A');
      assert.equal(later.statusCode, 204);
      t.diagnostic(`The viewer heard ${await heardOfClearAfterCapture(watcher)}`);
      await assertClearedAfterCapture(sessionId);

      watcher.close();
    } finally {
      pair.release();
      await pair.servers.close();
    }
  });

  it('sends a capture’s step before the session.updated of an MCP set_response after it', async () => {
    const sessionId = await sessionWithQueue([501, 502]);
    const pair = await heldPair();

    try {
      const watcher = await watch(pair.port, sessionId, DECLARES_QUEUE_EVENTS);
      const { first, later } = await captureThen(pair, sessionId, () =>
        toolCall(pair, 'set_response', { sessionId, mode: 'default' }),
      );

      assert.equal(first.status, 501);
      assert.equal(later.statusCode, 200, later.body);
      assert.deepEqual(stepOf(await watcher.next()), { index: 1, total: 2 });

      const updated = await watcher.next();

      assert.ok(updated.type === 'session.updated');
      assert.equal(updated.data.queue?.next, 2);

      watcher.close();
    } finally {
      pair.release();
      await pair.servers.close();
    }
  });

  it('sends a capture’s step before the requests.cleared of an MCP clear_requests after it, or has the viewer reload, and the clear deletes its request', async (t) => {
    const sessionId = await sessionWithQueue([501, 502]);
    const pair = await heldPair();

    try {
      const watcher = await watch(pair.port, sessionId, DECLARES_QUEUE_EVENTS);
      const { first, later, answeredWhileHeld } = await captureThen(pair, sessionId, () =>
        toolCall(pair, 'clear_requests', { sessionId }),
      );

      assert.equal(first.status, 501);
      assert.equal(answeredWhileHeld, false, 'the clear did not wait in the line for capture A');
      assert.equal(later.statusCode, 200, later.body);
      t.diagnostic(`The viewer heard ${await heardOfClearAfterCapture(watcher)}`);
      await assertClearedAfterCapture(sessionId);

      watcher.close();
    } finally {
      pair.release();
      await pair.servers.close();
    }
  });

  /**
   * On one pair of listeners, as the process runs them, a clear waits for a
   * capture that holds the session in the line rather than on the row's
   * lock, holding no connection meanwhile, and deletes that capture's
   * request once it has committed and published (D205 point 4). The tests of
   * `session-queue.test.ts` that make a clear wait on the lock send the two
   * calls to two pairs, whose lines are their own.
   */
  it('makes a clear on the same pair wait for a capture holding the session, and delete its request', async () => {
    const sessionId = await sessionWithQueue([501, 502, 503]);

    assert.equal((await sendWebhook(sessionId, '{}')).status, 501);
    assert.equal((await sendWebhook(sessionId, '{}')).status, 502);

    const gated = poolPausingFirstCommit(pool);
    const pair = buildTestServers(gated.pool);

    pair.api.log.level = 'silent';
    pair.receiver.log.level = 'silent';

    try {
      const pairReceiveOrigin = `http://127.0.0.1:${await listening(pair.receiver)}`;
      const capturing = sendWebhook(sessionId, '{}', pairReceiveOrigin);
      const holderPid = await withTimeout(gated.holder, 'the capture to hold the session');
      let settled = false;
      const clearing = pair.api
        .inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/requests` })
        .then((response) => {
          settled = true;

          return response;
        });

      await delay(HELD_MS);

      assert.equal(settled, false, 'the clear completed while a capture held the session');

      const blocked = await pool.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [holderPid],
      );

      assert.equal(
        blocked.rows[0]?.waiting,
        0,
        'the clear waited on the row lock, not in the line',
      );

      gated.release();

      assert.equal((await capturing).status, 503);
      assert.equal((await clearing).statusCode, 204);
      assert.equal(await storedRequests(sessionId), 0);

      const read = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });

      assert.equal(read.json<{ queue: { next: number } }>().queue.next, 1);
    } finally {
      gated.release();
      await pair.close();
    }
  });

  /**
   * A call waits for its turn holding no connection of the pool (D205): with
   * a pool of two, one capture holding the session and one connection, and
   * six more captures of that session waiting behind it, a capture of another
   * session still finds the second connection and is answered. Waiting in the
   * line with a connection taken would leave it none until the first capture
   * was let go.
   */
  it('answers another session’s capture while more captures of one session than the pool has connections wait', async () => {
    const small = new pg.Pool({ connectionString: loadConfig().databaseUrl, max: 2 });
    const held = poolHoldingFirstCommitAnswer(small);
    const pair = buildTestServers(held.pool);

    pair.api.log.level = 'silent';
    pair.receiver.log.level = 'silent';

    try {
      const pairReceiveOrigin = `http://127.0.0.1:${await listening(pair.receiver)}`;
      const sessionId = await sessionWithQueue([501, 502, 503, 504, 505, 506, 507]);
      const other = await newSession();
      const first = sendWebhook(sessionId, '{}', pairReceiveOrigin);

      await withTimeout(held.committed, 'the first capture to commit');

      let waitingAnswered = 0;
      const waiting = Array.from({ length: 6 }, () =>
        sendWebhook(sessionId, '{}', pairReceiveOrigin).then((response) => {
          waitingAnswered += 1;

          return response;
        }),
      );

      // Time for the six to reach their handlers, where a line entered with a
      // connection taken would take the second one.
      await delay(HELD_MS);

      const otherAnswer = await withTimeout(
        sendWebhook(other, '{}', pairReceiveOrigin),
        'the other session’s capture to be answered',
      );

      assert.equal(otherAnswer.status, 200);
      assert.equal(waitingAnswered, 0, 'a capture behind the held one was answered before it');

      held.release();

      const statuses = [(await first).status];

      for (const response of await withTimeout(Promise.all(waiting), 'the six to be answered')) {
        statuses.push(response.status);
      }

      assert.deepEqual(
        statuses.sort((left, right) => left - right),
        [501, 502, 503, 504, 505, 506, 507],
      );
    } finally {
      held.release();
      await pair.close();
      await small.end();
    }
  });
});

/**
 * A real connection whose peer stops reading is terminated once it falls
 * `MAX_SUBSCRIBER_BACKLOG_BYTES` behind (D205; the outside review's finding 2
 * on correction round 6), so what `ws` reports as its `bufferedAmount` is
 * what the bound reads; a viewer that reads is sent every event meanwhile.
 */
describe('a connection that does not read', () => {
  /** Opens the realtime connection by hand, reads up to its `ready`, and stops reading. */
  function stalledViewer(sessionId: string): Promise<net.Socket> {
    return withTimeout(
      new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        let seen = '';

        socket.on('error', () => undefined);
        socket.on('connect', () => {
          socket.write(
            `GET /ws/${sessionId}?${REALTIME_EVENTS_PARAM}=session.updated HTTP/1.1\r\n` +
              'Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
          );
        });

        const onData = (chunk: Buffer): void => {
          seen += chunk.toString('latin1');

          if (seen.includes('{"type":"ready"}')) {
            socket.off('data', onData);
            socket.pause();
            resolve(socket);
          }
        };

        socket.on('data', onData);
        socket.on('close', () => reject(new Error('The stalled viewer was closed before ready')));
      }),
      'the stalled viewer to be ready',
    );
  }

  it('terminates it once it falls 4 MiB behind, and sends a reading viewer every event', async () => {
    const sessionId = await newSession();
    const reading = await watch(port, sessionId, ['session.updated']);
    const stalled = await stalledViewer(sessionId);
    let closed = false;

    stalled.on('close', () => {
      closed = true;
    });

    assert.equal(servers.hub.countFor(sessionId), 2);

    // Each change publishes the response twice, as `response` and as
    // `customResponse`: about 0.8 MiB of JSON, its body control characters.
    const body = '\u0001'.repeat(65_536);
    let changes = 0;

    try {
      while (servers.hub.countFor(sessionId) === 2 && changes < 40) {
        const changed = await app.inject({
          method: 'PUT',
          url: `/api/sessions/${sessionId}/response`,
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ mode: 'custom', response: { status: 400 + changes, body } }),
        });

        assert.equal(changed.statusCode, 200, changed.body);
        changes += 1;
      }

      assert.equal(servers.hub.countFor(sessionId), 1, `still registered after ${changes} changes`);
      // At least the bound was published before it was cut.
      assert.ok(changes * 0.75 * 1024 * 1024 > MAX_SUBSCRIBER_BACKLOG_BYTES, `${changes} changes`);

      for (let index = 0; index < changes; index += 1) {
        const event = await reading.next();

        assert.ok(event.type === 'session.updated');
        assert.equal(event.data.response?.status, 400 + index);
      }

      // Destroyed by the server: the peer sees its connection end.
      stalled.resume();
      await withTimeout(
        (async () => {
          while (!closed) {
            await delay(5);
          }
        })(),
        'the stalled connection to close',
      );
    } finally {
      stalled.destroy();
      reading.close();
    }
  });
});
