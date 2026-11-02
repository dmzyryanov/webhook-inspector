/**
 * The receive URL on the application listener (D187): the `receiveUrl` the
 * session answers carry, and the `410` / `1009` that `/s/...` answers on the
 * host that stopped receiving webhooks in 0.36.0.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { METHODS } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ErrorCode, MAX_BODY_BYTES } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildServer } from '../../server.ts';
import { receiveUrlFor, receiveUrlMovedMessage } from './receive-url.ts';
import {
  CONTENT_SECURITY_POLICY_HEADER,
  CONTENT_TYPE_OPTIONS_HEADER,
  NOSNIFF,
  RECEIVER_CONTENT_SECURITY_POLICY,
} from './response.ts';

const RECEIVE_ORIGIN = 'https://hook.qa-tools.ru';

let pool: pg.Pool;
let app: FastifyInstance;
let port: number;
const createdSessionIds: string[] = [];

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
  app = buildServer(pool, { receiveOrigin: RECEIVE_ORIGIN });
  app.log.level = 'silent';
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
}

after(async () => {
  // A failed start is before()'s to report; close what it did open.
  await startup?.catch(() => undefined);

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await app?.close();
  await pool.end();
});

async function newSession(): Promise<{ id: string; receiveUrl: string }> {
  const response = await app.inject({ method: 'POST', url: '/api/sessions' });

  assert.equal(response.statusCode, 201, response.body);

  const created = response.json<{ id: string; receiveUrl: string }>();

  createdSessionIds.push(created.id);

  return created;
}

async function storedCount(sessionId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*) FROM requests WHERE session_id = $1',
    [sessionId],
  );

  return Number(result.rows[0]?.count);
}

type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

function assertMoved(response: Injected, message: string, label = ''): void {
  assert.equal(response.statusCode, 410, `${label} ${response.body}`);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8', label);
  assert.equal(response.headers[CONTENT_TYPE_OPTIONS_HEADER], NOSNIFF, label);
  assert.equal(
    response.headers[CONTENT_SECURITY_POLICY_HEADER],
    RECEIVER_CONTENT_SECURITY_POLICY,
    label,
  );
  assert.equal(response.headers['x-qa-tools-request-id'], undefined, label);

  if (response.body !== '') {
    assert.deepEqual(response.json(), { errorCode: ErrorCode.RECEIVE_URL_MOVED, message }, label);
  }
}

describe('receiveUrl (D187)', () => {
  it('is composed from the receive origin and the session id', () => {
    assert.equal(receiveUrlFor(RECEIVE_ORIGIN, 'abc'), 'https://hook.qa-tools.ru/s/abc');
  });

  it('is in the answers of POST /api/sessions and GET /api/sessions/{sessionId}', async () => {
    const created = await newSession();

    assert.equal(created.receiveUrl, `${RECEIVE_ORIGIN}/s/${created.id}`);

    const details = await app.inject({ method: 'GET', url: `/api/sessions/${created.id}` });

    assert.equal(details.statusCode, 200, details.body);
    assert.equal(details.json<{ receiveUrl: string }>().receiveUrl, created.receiveUrl);
  });

  it('is never stored: the session row has no column for it', async () => {
    const result = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions'`,
    );

    assert.equal(
      result.rows.some(({ column_name }) => column_name.includes('receive')),
      false,
    );
  });
});

describe('/s/... on the application listener answers 410 / 1009 (D187)', () => {
  it('names the session receive URL for an id-shaped segment, and the pattern otherwise', () => {
    const id = 'A'.repeat(43);

    assert.equal(
      receiveUrlMovedMessage(RECEIVE_ORIGIN, `/s/${id}/a/b?x=1`),
      `Webhooks for this session are received at https://hook.qa-tools.ru/s/${id}`,
    );

    for (const url of [
      '/s/',
      '/s/short',
      `/s/${'a'.repeat(44)}`,
      '/s/%zz',
      '/s/<script>',
      `/s//${id}`,
    ]) {
      assert.equal(
        receiveUrlMovedMessage(RECEIVE_ORIGIN, url),
        'Webhooks are received at https://hook.qa-tools.ru/s/<session-id>',
        url,
      );
    }
  });

  it('answers every method the receiver accepted, and stores nothing', async () => {
    const { id } = await newSession();
    const message = `Webhooks for this session are received at ${RECEIVE_ORIGIN}/s/${id}`;

    for (const method of METHODS.filter((name) => name !== 'CONNECT')) {
      const response = await app.inject({ method: method as 'GET', url: `/s/${id}` });

      assertMoved(response, message, method);
    }

    assert.equal(await storedCount(id), 0);
  });

  it('answers any path under /s/, the endpoint itself, a trailing slash and an undecodable path', async () => {
    const { id } = await newSession();
    const named = `Webhooks for this session are received at ${RECEIVE_ORIGIN}/s/${id}`;
    const generic = `Webhooks are received at ${RECEIVE_ORIGIN}/s/<session-id>`;

    for (const [url, message] of [
      [`/s/${id}`, named],
      [`/s/${id}/`, named],
      [`/s/${id}/a/b`, named],
      [`/s/${id}?x=1`, named],
      [`/s/${id}/caf%E9`, named],
      ['/s/', generic],
      [`/s/${'a'.repeat(101)}`, generic],
      ['/s/%zz', generic],
      ['/s/z/zz', generic],
    ]) {
      assertMoved(
        await app.inject({ method: 'POST', url: url as string, payload: 'x' }),
        message as string,
        url,
      );
    }

    assert.equal(await storedCount(id), 0);
  });

  it('answers before the body is read: a body over the limit, an unparseable Content-Type and a bodiless QUERY are 410 too', async () => {
    const { id } = await newSession();
    const message = `Webhooks for this session are received at ${RECEIVE_ORIGIN}/s/${id}`;

    assertMoved(
      await app.inject({
        method: 'POST',
        url: `/s/${id}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: Buffer.alloc(MAX_BODY_BYTES + 1),
      }),
      message,
      'oversized',
    );
    assertMoved(
      await app.inject({
        method: 'POST',
        url: `/s/${id}`,
        headers: { 'content-type': 'not a media type' },
        payload: 'x',
      }),
      message,
      'content type',
    );
    assertMoved(await app.inject({ method: 'QUERY' as 'GET', url: `/s/${id}` }), message, 'QUERY');
    assert.equal(await storedCount(id), 0);
  });

  it('keeps a kept-alive connection usable after the refusal of a request with a body', async () => {
    const { id } = await newSession();
    const request = (connection: string): string =>
      [
        `POST /s/${id} HTTP/1.1`,
        'Host: qa-tools.ru',
        `Connection: ${connection}`,
        'Content-Length: 5',
        '',
        'hello',
      ].join('\r\n');

    const received = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(request('keep-alive'));
        socket.write(request('close'));
      });
      let text = '';

      socket.on('data', (chunk: Buffer) => {
        text += chunk.toString('latin1');
      });
      socket.on('close', () => resolve(text));
      socket.on('error', reject);
    });

    assert.equal(received.match(/HTTP\/1\.1 410 Gone/g)?.length, 2, received);
    assert.equal(await storedCount(id), 0);
  });

  it('leaves /s without its slash to the not-found route', async () => {
    const response = await app.inject({ method: 'POST', url: '/s' });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      errorCode: ErrorCode.ROUTE_NOT_FOUND,
      message: 'Not found',
    });
  });
});
