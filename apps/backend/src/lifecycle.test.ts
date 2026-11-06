/**
 * How the backend process ends (D221, `lifecycle.ts`), with both listeners,
 * the realtime listener and the two pools of their own, capture's and the
 * API's (D244), on the task's database:
 *
 * - a delayed answer (#132): a capture whose configured response delay is 30 s,
 *   sent just before the process is told to stop, is answered in full, its
 *   outcome recorded and announced before the pools end, and both end;
 * - the drain SIGUSR2 starts: every answer then closes its connection, the
 *   receiver's own reply to a webhook included, except an answer with
 *   another request of the same socket in flight behind it, so that a
 *   pipelined webhook is answered too;
 * - a closing listener serves a request that arrives on a connection it
 *   still holds, rather than answering it `503`.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { MAX_RESPONSE_DELAY_MS } from '@webhook-inspector/shared';
import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { drainProcess, shutdown, type ProcessParts } from './lifecycle.ts';
import { until } from './testing/realtime.ts';
import { buildTestServers, type TestServers } from './testing/servers.ts';

/** Reads what the tests check, outside the pools the shutdowns end. */
let check: pg.Pool;
const created: string[] = [];

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

  if (created.length > 0) {
    await check.query('DELETE FROM sessions WHERE id = ANY($1)', [created]);
  }

  await check?.end();
});

interface Process {
  parts: ProcessParts;
  servers: TestServers;
  apiPort: number;
  receivePort: number;
  /** Ends what a test that did not shut down left running. */
  stop(): Promise<void>;
}

async function listening(server: FastifyInstance): Promise<number> {
  await server.listen({ host: '127.0.0.1', port: 0 });

  return (server.server.address() as AddressInfo).port;
}

/** A backend process as `index.ts` builds it, on two pools of its own (D244). */
async function start(): Promise<Process> {
  const capturePool = createPool(loadConfig().databaseUrl, { name: 'capture' });
  const pool = createPool(loadConfig().databaseUrl, { name: 'api' });
  const servers = buildTestServers(pool, { capturePool });

  servers.api.log.level = 'silent';
  servers.receiver.log.level = 'silent';

  const apiPort = await listening(servers.api);
  const receivePort = await listening(servers.receiver);
  const parts: ProcessParts = {
    app: servers.api,
    receiver: servers.receiver,
    pools: [capturePool, pool],
    listener: servers.listener,
    drain: servers.drain,
    writes: servers.writes,
  };
  let stopped = false;

  return {
    parts,
    servers,
    apiPort,
    receivePort,
    stop: async () => {
      if (!stopped) {
        stopped = true;
        await servers.close();
        await Promise.all(
          [capturePool, pool].filter((each) => !each.ended).map((each) => each.end()),
        );
      }
    },
  };
}

async function newSession(on: Process, response?: object): Promise<string> {
  const answer = await on.servers.api.inject({
    method: 'POST',
    url: '/api/sessions',
    ...(response ? { payload: { response } } : {}),
  });

  assert.equal(answer.statusCode, 201, answer.body);

  const { id } = answer.json<{ id: string }>();

  created.push(id);

  return id;
}

/** A webhook as a sender writes it, kept alive unless told otherwise. */
function webhook(sessionId: string, body: string, close = false): string {
  return [
    `POST /s/${sessionId} HTTP/1.1`,
    'Host: hook.qa-tools.ru',
    ...(close ? ['Connection: close'] : []),
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n');
}

/** One raw connection: what it was sent, as text, and when it ended. */
function connect(port: number): {
  socket: net.Socket;
  received: () => string;
  ended: Promise<void>;
} {
  const socket = net.connect(port, '127.0.0.1');
  let received = '';
  const ended = new Promise<void>((resolve) => {
    socket.on('close', () => resolve());
  });

  socket.on('data', (chunk) => {
    received += chunk.toString('latin1');
  });
  socket.on('error', () => undefined);

  return { socket, received: () => received, ended };
}

/** The HTTP answers in `text`: each one's status, `Connection` header and body. */
function answers(text: string): { status: number; connection: string | null; body: string }[] {
  const found: { status: number; connection: string | null; body: string }[] = [];
  let rest = text;

  while (rest.startsWith('HTTP/1.1 ')) {
    const headEnd = rest.indexOf('\r\n\r\n');

    if (headEnd === -1) {
      break;
    }

    const head = rest.slice(0, headEnd);
    const length = Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1] ?? 0);
    const body = rest.slice(headEnd + 4, headEnd + 4 + length);

    found.push({
      status: Number(head.slice(9, 12)),
      connection: /\r\nconnection: ([^\r]+)/i.exec(head)?.[1]?.toLowerCase() ?? null,
      body,
    });
    rest = rest.slice(headEnd + 4 + length);
  }

  return found;
}

async function storedStates(sessionId: string): Promise<string[]> {
  const { rows } = await check.query<{ state: string }>(
    `SELECT rr.state FROM request_responses rr JOIN requests r ON r.id = rr.request_id
      WHERE r.session_id = $1 ORDER BY r.received_at`,
    [sessionId],
  );

  return rows.map((row) => row.state);
}

describe('a shutdown (criterion 6, D221)', () => {
  it('answers in full a capture whose 30 s delay began just before it, records its outcome and announces it, then ends', async () => {
    assert.equal(MAX_RESPONSE_DELAY_MS, 30_000);

    const backend = await start();

    try {
      const sessionId = await newSession(backend, {
        status: 201,
        body: '{"late":"but whole"}',
        delayMs: MAX_RESPONSE_DELAY_MS,
      });
      const sender = connect(backend.receivePort);

      sender.socket.write(webhook(sessionId, '{"just":"before the stop"}'));

      // Stored, and its reply held by the delay: then the process is told to stop.
      await (async () => {
        const deadline = Date.now() + 10_000;

        while ((await storedStates(sessionId)).length === 0) {
          assert.ok(Date.now() < deadline, 'the webhook was never stored');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();

      const toldAt = Date.now();
      let shutDownAt = 0;
      const stopping = shutdown(backend.parts, 'SIGTERM').then(() => {
        shutDownAt = Date.now();
      });

      await sender.ended;

      const answeredAt = Date.now();
      const [answer] = answers(sender.received());

      assert.equal(answer?.status, 201);
      assert.equal(answer?.body, '{"late":"but whole"}');
      // The drain the shutdown starts ends the connection with the answer.
      assert.equal(answer?.connection, 'close');
      assert.ok(answeredAt - toldAt > 25_000, `answered ${answeredAt - toldAt} ms after the stop`);

      await stopping;
      assert.ok(shutDownAt >= answeredAt, 'the process ended before its answer');
      assert.ok(
        backend.parts.pools.every((pool) => pool.ended),
        'a pool was left open',
      );

      // Its outcome recorded, and announced, before the pool ended.
      assert.deepEqual(await storedStates(sessionId), ['sent']);

      // The capture's own event, 30 s old, may have been pruned by now (D221).
      const { rows } = await check.query<{ kind: string }>(
        `SELECT kind FROM realtime_events WHERE session_id = $1 AND kind = 'response.recorded'`,
        [sessionId],
      );

      assert.deepEqual(
        rows.map((row) => row.kind),
        ['response.recorded'],
      );
    } finally {
      await backend.stop().catch(() => undefined);
    }
  });
});

describe('the drain (D221)', () => {
  it('closes the connection of every answer, an API answer and a webhook reply included', async () => {
    const backend = await start();

    try {
      const sessionId = await newSession(backend);

      // Before the drain: kept alive.
      const kept = connect(backend.receivePort);

      kept.socket.write(webhook(sessionId, '{"n":1}'));
      await until(() => answers(kept.received()).length === 1, 'the answer');
      assert.equal(answers(kept.received())[0]?.connection, 'keep-alive');

      drainProcess(backend.parts);

      // The same connection's next webhook closes it.
      kept.socket.write(webhook(sessionId, '{"n":2}'));
      await kept.ended;
      assert.deepEqual(
        answers(kept.received()).map((answer) => [answer.status, answer.connection]),
        [
          [200, 'keep-alive'],
          [200, 'close'],
        ],
      );

      const call = connect(backend.apiPort);

      call.socket.write(`GET /api/sessions/${sessionId} HTTP/1.1\r\nHost: qa-tools.ru\r\n\r\n`);
      await call.ended;
      assert.deepEqual(
        answers(call.received()).map((answer) => [answer.status, answer.connection]),
        [[200, 'close']],
      );
    } finally {
      await backend.stop();
    }
  });

  it('answers two webhooks pipelined on one connection during the drain, both recorded sent, and closes it after the second', async () => {
    const backend = await start();

    try {
      const sessionId = await newSession(backend);

      drainProcess(backend.parts);

      const sender = connect(backend.receivePort);

      sender.socket.write(webhook(sessionId, '{"n":1}') + webhook(sessionId, '{"n":2}'));
      await sender.ended;

      const both = answers(sender.received());

      assert.deepEqual(
        both.map((answer) => [answer.status, answer.connection]),
        [
          [200, 'keep-alive'],
          [200, 'close'],
        ],
      );
      await backend.servers.writes.settled();
      assert.deepEqual(await storedStates(sessionId), ['sent', 'sent']);
    } finally {
      await backend.stop();
    }
  });
});

describe('a closing listener (D221)', () => {
  it('serves a request that arrives on a connection it still holds, rather than answering it 503', async () => {
    const backend = await start();

    try {
      const sessionId = await newSession(backend, { status: 200, body: 'held', delayMs: 1_000 });
      const sender = connect(backend.receivePort);

      sender.socket.write(webhook(sessionId, '{"n":1}'));
      await (async () => {
        const deadline = Date.now() + 10_000;

        while ((await storedStates(sessionId)).length === 0) {
          assert.ok(Date.now() < deadline, 'the webhook was never stored');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();

      // The receiver closes, without a drain, while the first reply is held;
      // the second webhook comes on the same connection meanwhile.
      const closing = backend.servers.receiver.close();

      sender.socket.write(webhook(sessionId, '{"n":2}', true));
      await sender.ended;
      await closing;

      assert.deepEqual(
        answers(sender.received()).map((answer) => answer.status),
        [200, 200],
      );
    } finally {
      await backend.stop();
    }
  });
});
