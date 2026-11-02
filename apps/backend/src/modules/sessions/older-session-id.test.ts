/**
 * A session created before new ids became letters and digits (D161) keeps
 * working: its Base64URL id, `_` and `-` included, still passes every route
 * that validates an id with `SESSION_ID_PATTERN` - the page's session read, the
 * receiver, the request list and details, the response change, both deletions
 * and the realtime connection.
 *
 * The row is inserted with an id of the older shape rather than generated,
 * because the generator no longer produces one.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  REALTIME_EVENTS_PARAM,
  SESSION_ID_PATTERN,
  type RequestListItem,
  type ServerEvent,
  type SessionDetails,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import { insertSession } from './repository.ts';

const MESSAGE_TIMEOUT_MS = 5_000;

let pool: pg.Pool;
let servers: TestServers;
/** The application listener. */
let app: FastifyInstance;
let port: number;
/** The receive listener's port (D187). */
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
  servers = buildTestServers(pool);
  app = servers.api;
  app.log.level = 'silent';
  servers.receiver.log.level = 'silent';
  await app.listen({ host: '127.0.0.1', port: 0 });
  await servers.receiver.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;

  const receiveAddress = servers.receiver.server.address();
  receivePort = typeof receiveAddress === 'object' && receiveAddress ? receiveAddress.port : 0;
}

after(async () => {
  // A failed start is before()'s to report; close what it did open.
  await startup?.catch(() => undefined);

  for (const socket of openSockets) {
    socket.close();
  }

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers?.close();
  await pool.end();
});

/**
 * An id as the generator before D161 made it - 32 random bytes in Base64URL -
 * with a `-` and a `_` placed for certain: five set bits and a clear one open
 * the first byte (`111110` is `-`), and six set bits open the fourth, the
 * start of the fifth symbol (`111111` is `_`).
 */
function base64UrlSessionId(): string {
  const bytes = randomBytes(32);

  bytes[0] = 0b1111_1000;
  bytes[3] = 0b1111_1100;

  return bytes.toString('base64url');
}

/** Resolves with the next event on the socket, or fails after a bounded wait. */
function nextEvent(socket: WebSocket, description: string): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${description}`)),
      MESSAGE_TIMEOUT_MS,
    );

    socket.addEventListener(
      'message',
      (message) => {
        clearTimeout(timer);
        resolve(JSON.parse(message.data as string) as ServerEvent);
      },
      { once: true },
    );
    socket.addEventListener(
      'close',
      (event) => {
        clearTimeout(timer);
        reject(new Error(`The connection closed with ${event.code} waiting for ${description}`));
      },
      { once: true },
    );
  });
}

describe('a session whose id has _ and - (created before D161)', () => {
  it('is read, captures, lists, opens, changes, deletes and streams like a new one', async () => {
    const id = base64UrlSessionId();

    assert.equal(id[0], '-');
    assert.equal(id[4], '_');
    assert.match(id, SESSION_ID_PATTERN);

    await insertSession(pool, id, null);
    createdSessionIds.push(id);

    // The View page's read.
    const read = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });

    assert.equal(read.statusCode, 200);
    assert.equal(read.json<SessionDetails>().id, id);

    // A viewer's realtime connection, declaring the deletion events.
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/${id}?${REALTIME_EVENTS_PARAM}=request.deleted,requests.cleared`,
    );

    openSockets.push(socket);
    assert.equal((await nextEvent(socket, 'ready')).type, 'ready');

    // The receiver, and the event it publishes.
    const received = nextEvent(socket, 'request.received');
    const captured = await fetch(`http://127.0.0.1:${receivePort}/s/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"older":true}',
    });

    assert.equal(captured.status, 200);

    const requestId = captured.headers.get('x-qa-tools-request-id');

    assert.ok(requestId);

    const event = await received;

    assert.equal(event.type, 'request.received');
    assert.equal(event.type === 'request.received' && event.data.id, requestId);

    // The request list and the request's details.
    const list = await app.inject({ method: 'GET', url: `/api/sessions/${id}/requests` });

    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      list.json<RequestListItem[]>().map((item) => item.id),
      [requestId],
    );

    const details = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/requests/${requestId}`,
    });

    assert.equal(details.statusCode, 200);

    // The response change, and the receiver answering with it.
    const changed = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/response`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ mode: 'custom', response: { status: 202 } }),
    });

    assert.equal(changed.statusCode, 200);

    const second = nextEvent(socket, 'the second request.received');
    const answered = await fetch(`http://127.0.0.1:${receivePort}/s/${id}`, { method: 'GET' });

    assert.equal(answered.status, 202);
    assert.equal((await second).type, 'request.received');

    // Deleting one request, then clearing the rest.
    const deleted = nextEvent(socket, 'request.deleted');
    const deleteOne = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${id}/requests/${requestId}`,
    });

    assert.equal(deleteOne.statusCode, 204);
    assert.deepEqual(await deleted, { type: 'request.deleted', data: { id: requestId } });

    const cleared = nextEvent(socket, 'requests.cleared');
    const clearAll = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}/requests` });

    assert.equal(clearAll.statusCode, 204);
    assert.deepEqual(await cleared, { type: 'requests.cleared' });

    const emptied = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });

    assert.equal(emptied.statusCode, 200);
    assert.equal(emptied.json<SessionDetails>().requestsCount, 0);
  });
});
