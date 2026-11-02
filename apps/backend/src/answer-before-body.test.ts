/**
 * An answer written before its request's body has arrived ends its
 * connection, on both listeners and whatever the answer (D213 point 5,
 * extended by D227): `qa-tools.ru/s/...`'s `410`, `/healthz`, `/readyz`, the
 * not-found route outside `/api`, a refused realtime connection's `429`, and
 * on the receive listener its not-found route, a malformed session's `404`,
 * a `413` / `1004` for a body declared over 1 MiB, a `503` / `1018` on a
 * connection kept alive and the reply to a captured `GET`, `HEAD` or
 * `TRACE` - each sent with a declared body that stalls -
 * carry `Connection: close`, and the connection ends within a second. So does
 * every answer to an upgrade request outside `/ws` on the application
 * listener, body or none: nothing reads its socket once it is answered. A
 * request whose body arrived whole, or none, keeps its connection alive: the
 * next request on it is answered. The router's own `400` and `414` end theirs
 * to any request that frames a body, even one sent whole in the same write as
 * its head: they are written as soon as the head is parsed, before any of the
 * body, and look at it only then (`writeRouterRefusal`, `server.ts`). A
 * `Content-Length` of 0 frames none, and keeps its connection.
 *
 * A path no route has, or a method its path has no route for, is answered
 * `404` / `1000` before any of its body is read, on both listeners and
 * whatever its method, media type or framing (D227): Fastify's not-found
 * route read a body its instance had a parser for - `application/json` and
 * `text/plain` on both listeners - and answered only once it had all
 * arrived. What Fastify refuses on its headers alone, a `QUERY` without
 * content and a `Content-Type` that is not a media type, keeps its answer,
 * before the body too. What such a request keeps of its body is
 * `not-found-memory.test.ts`'s.
 *
 * Over real sockets written by hand and never ended by the client: whether
 * the server ends a connection is what a socket alone shows. The `/api` and
 * `/mcp` answers are `limits/calls-in-flight-routes.test.ts`'s.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import type http from 'node:http';
import net from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ErrorCode, MAX_BODY_BYTES } from '@webhook-inspector/shared';
import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { createRealtimePlaces } from './modules/realtime/connection-places.ts';
import { RealtimeHub } from './modules/realtime/hub.ts';
import {
  createCaptureBudget,
  inFlightBound,
  type CaptureBudget,
} from './modules/webhook/capture-budget.ts';
import { buildReceiver, buildServer } from './server.ts';

let pool: pg.Pool;
let api: FastifyInstance;
let receiver: FastifyInstance;
let apiPort: number;
let receivePort: number;
let budget: CaptureBudget;
const createdSessionIds: string[] = [];
/** Every connection a test opened, so that none outlives the file. */
const sockets: net.Socket[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

function discard(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);

    const hub = new RealtimeHub();

    // No realtime place for anybody, so that every connection to `/ws` is
    // refused `429` / `1020`.
    api = buildServer(pool, {
      logDestination: discard(),
      hub,
      realtimePlaces: createRealtimePlaces(0),
    });
    // A webhook waits 300 ms, not 30 s, before it is refused `1018`.
    budget = createCaptureBudget({ waitMs: 300 });
    receiver = buildReceiver(pool, { logDestination: discard(), hub, captureBudget: budget });
    await api.listen({ host: '127.0.0.1', port: 0 });
    await receiver.listen({ host: '127.0.0.1', port: 0 });
    apiPort = (api.server.address() as net.AddressInfo).port;
    receivePort = (receiver.server.address() as net.AddressInfo).port;
  })();
  await startup;
});

after(async () => {
  await startup;

  for (const socket of sockets) {
    socket.destroy();
  }

  await Promise.all([api?.close(), receiver?.close()]);

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await pool?.end();
});

async function createSession(): Promise<string> {
  const response = await api.inject({ method: 'POST', url: '/api/sessions' });

  assert.equal(response.statusCode, 201, response.body);

  const { id } = response.json() as { id: string };

  createdSessionIds.push(id);

  return id;
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Connection {
  /** Writes on the connection. */
  write: (data: string) => void;
  /** The `index`th answer read on the connection, counted from 0, once whole. */
  answer: (index?: number) => Promise<Answer>;
  /** Whether the server has ended the connection, by its FIN or a reset. */
  ended: () => boolean;
}

/** Waits until `check` holds, polling every 5 ms, for `ms` at most. */
async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;

  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
    await delay(5);
  }
}

/**
 * A connection of its own, read answer by answer and never ended by the
 * client. `headOnly` reads every answer as one to a `HEAD`: its head alone,
 * whatever `Content-Length` it announces.
 */
function connect(port: number, { headOnly = false } = {}): Connection {
  const socket = net.connect(port, '127.0.0.1');
  const answers: Answer[] = [];
  let buffered = Buffer.alloc(0);
  let ended = false;

  sockets.push(socket);
  socket.on('error', () => undefined);
  socket.once('end', () => {
    ended = true;
  });
  socket.once('close', () => {
    ended = true;
  });
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);

    // Every answer here has a `Content-Length`.
    for (;;) {
      const headEnd = buffered.indexOf('\r\n\r\n');

      if (headEnd === -1) {
        return;
      }

      const [statusLine = '', ...lines] = buffered
        .subarray(0, headEnd)
        .toString('latin1')
        .split('\r\n');
      const headers: http.IncomingHttpHeaders = {};

      for (const line of lines) {
        const colon = line.indexOf(':');

        headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }

      const end = headEnd + 4 + (headOnly ? 0 : Number(headers['content-length'] ?? 0));

      if (buffered.length < end) {
        return;
      }

      answers.push({
        status: Number(statusLine.split(' ')[1]),
        headers,
        body: buffered.subarray(headEnd + 4, end).toString('utf8'),
      });
      buffered = buffered.subarray(end);
    }
  });

  return {
    write: (data) => {
      socket.write(data);
    },
    answer: async (index = 0) => {
      await until(() => answers.length > index || ended, `answer ${index} is read`);

      const answer = answers[index];

      assert.ok(answer !== undefined, `the connection ended before answer ${index}`);

      return answer;
    },
    ended: () => ended,
  };
}

interface Head {
  method: string;
  path: string;
  headers?: Record<string, string>;
}

/** A request line and its header lines, kept alive as HTTP/1.1 is by default. */
function head({ method, path, headers = {} }: Head): string {
  const lines = [`${method} ${path} HTTP/1.1`, 'Host: 127.0.0.1'];

  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }

  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * A request declaring `declared` bytes of body, 2,000 unless said, of which
 * only the first 16 are sent: the rest never comes.
 */
function stalled(port: number, request: Head, declared = 2_000): Connection {
  const connection = connect(port, { headOnly: request.method === 'HEAD' });

  connection.write(
    head({ ...request, headers: { ...request.headers, 'Content-Length': String(declared) } }) +
      '0123456789abcdef',
  );

  return connection;
}

/**
 * A request sending its body chunked that stalls: after one whole chunk of
 * 16 bytes and no last chunk, or in the middle of a chunk declaring 2,000
 * bytes, of which 16 are sent.
 */
function stalledChunked(port: number, request: Head, where: 'between' | 'mid-chunk'): Connection {
  const connection = connect(port, { headOnly: request.method === 'HEAD' });

  connection.write(
    head({ ...request, headers: { ...request.headers, 'Transfer-Encoding': 'chunked' } }) +
      (where === 'between' ? '10\r\n0123456789abcdef\r\n' : '7d0\r\n0123456789abcdef'),
  );

  return connection;
}

/** Waits until the server has ended `connection`, for 1 s at most. */
async function endedWithin(connection: Connection, what: string): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (!connection.ended()) {
    assert.ok(Date.now() < deadline, `${what}: the server kept the connection open`);
    await delay(5);
  }
}

/** `connection`'s answer: `status` and `errorCode`, `Connection: close`, and its end within a second. */
async function assertEnded(
  connection: Connection,
  status: number,
  errorCode: number | null,
  what: string,
): Promise<void> {
  const answer = await connection.answer();

  assert.equal(answer.status, status, `${what}: ${answer.body}`);
  assert.equal(answer.headers.connection, 'close', what);

  if (errorCode !== null) {
    assert.equal((JSON.parse(answer.body) as { errorCode?: number }).errorCode, errorCode, what);
  }

  await endedWithin(connection, what);
}

const OCTETS = { 'Content-Type': 'application/octet-stream' };

describe('an answer written before its body has arrived (D227)', () => {
  it('ends its connection on the application listener: /s/..., the probes, the not-found route and /ws', async () => {
    const sessionId = await createSession();

    await assertEnded(
      stalled(apiPort, { method: 'POST', path: `/s/${sessionId}`, headers: OCTETS }),
      410,
      ErrorCode.RECEIVE_URL_MOVED,
      "/s/...'s 410",
    );
    await assertEnded(stalled(apiPort, { method: 'GET', path: '/healthz' }), 200, null, '/healthz');
    await assertEnded(stalled(apiPort, { method: 'GET', path: '/readyz' }), 200, null, '/readyz');
    await assertEnded(
      stalled(apiPort, { method: 'GET', path: '/no-such-page' }),
      404,
      ErrorCode.ROUTE_NOT_FOUND,
      'a GET to the not-found route',
    );
    await assertEnded(
      stalled(apiPort, { method: 'POST', path: '/no-such-page', headers: OCTETS }),
      404,
      ErrorCode.ROUTE_NOT_FOUND,
      'a POST to the not-found route',
    );
    await assertEnded(
      stalled(apiPort, { method: 'GET', path: `/ws/${sessionId}` }),
      429,
      ErrorCode.TOO_MANY_REALTIME_CONNECTIONS,
      "/ws's 429",
    );
    await assertEnded(
      stalled(apiPort, {
        method: 'GET',
        path: `/ws/${sessionId}`,
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      }),
      429,
      ErrorCode.TOO_MANY_REALTIME_CONNECTIONS,
      "/ws's 429 to an upgrade",
    );
  });

  it('ends its connection whatever the stalled body: chunked between chunks or mid-chunk, and a HEAD declaring one, on both listeners', async () => {
    const sessionId = await createSession();
    const cases: [port: number, request: Head, status: number, errorCode: number | null][] = [
      [
        apiPort,
        { method: 'POST', path: `/s/${sessionId}`, headers: OCTETS },
        410,
        ErrorCode.RECEIVE_URL_MOVED,
      ],
      [apiPort, { method: 'GET', path: '/healthz' }, 200, null],
      [apiPort, { method: 'GET', path: '/no-such-page' }, 404, ErrorCode.ROUTE_NOT_FOUND],
      [
        apiPort,
        { method: 'GET', path: `/ws/${sessionId}` },
        429,
        ErrorCode.TOO_MANY_REALTIME_CONNECTIONS,
      ],
      [receivePort, { method: 'GET', path: '/no-such-page' }, 404, ErrorCode.ROUTE_NOT_FOUND],
      [receivePort, { method: 'GET', path: '/s/not-a-session' }, 404, ErrorCode.SESSION_NOT_FOUND],
    ];

    for (const [port, request, status, errorCode] of cases) {
      const where = `${port === apiPort ? 'api' : 'receive'} ${request.method} ${request.path}`;

      for (const shape of ['between', 'mid-chunk'] as const) {
        await assertEnded(
          stalledChunked(port, request, shape),
          status,
          errorCode,
          `${where}, chunked, stalled ${shape}`,
        );
      }
    }

    // A HEAD declaring a body, answered with a head alone.
    for (const [port, path, status] of [
      [apiPort, `/s/${sessionId}`, 410],
      [apiPort, '/healthz', 200],
      [apiPort, '/no-such-page', 404],
      [receivePort, '/no-such-page', 404],
    ] as const) {
      await assertEnded(
        stalled(port, { method: 'HEAD', path }),
        status,
        null,
        `${port === apiPort ? 'api' : 'receive'} HEAD ${path} declaring a body`,
      );
      await assertEnded(
        stalledChunked(port, { method: 'HEAD', path }, 'mid-chunk'),
        status,
        null,
        `${port === apiPort ? 'api' : 'receive'} HEAD ${path}, chunked`,
      );
    }

    // The receiver's 1018, kept alive, for a chunked body: every byte of the
    // budget taken, the webhook waits its 300 ms with its body unread.
    const filler = budget.take('filler', inFlightBound(budget.settings));

    try {
      for (const shape of ['between', 'mid-chunk'] as const) {
        await assertEnded(
          stalledChunked(
            receivePort,
            { method: 'POST', path: `/s/${sessionId}`, headers: OCTETS },
            shape,
          ),
          503,
          ErrorCode.CAPTURES_BUSY,
          `the receiver's 1018, chunked, stalled ${shape}`,
        );
      }
    } finally {
      filler.release();
    }

    const { rows } = await pool.query('SELECT 1 FROM requests WHERE session_id = $1', [sessionId]);

    assert.equal(rows.length, 0);
  });

  it('ends its connection on the receive listener: the not-found route, a malformed session, a body declared over 1 MiB, and 1018 kept alive', async () => {
    const sessionId = await createSession();

    await assertEnded(
      stalled(receivePort, { method: 'GET', path: '/no-such-page' }),
      404,
      ErrorCode.ROUTE_NOT_FOUND,
      "the receiver's not-found route",
    );
    await assertEnded(
      stalled(receivePort, { method: 'GET', path: '/s/not-a-session' }),
      404,
      ErrorCode.SESSION_NOT_FOUND,
      "the receiver's 404 for a malformed session",
    );

    // A body declared over 1 MiB is refused before a byte of it is read.
    const oversized = connect(receivePort);

    oversized.write(
      head({
        method: 'POST',
        path: `/s/${sessionId}`,
        headers: { ...OCTETS, 'Content-Length': String(MAX_BODY_BYTES + 1) },
      }) + '0123456789abcdef',
    );
    await assertEnded(oversized, 413, ErrorCode.PAYLOAD_TOO_LARGE, "the receiver's 413");

    // Every byte of the budget taken: the webhook waits its 300 ms, its body
    // unread, and is refused on a connection kept alive.
    const filler = budget.take('filler', inFlightBound(budget.settings));

    try {
      await assertEnded(
        stalled(receivePort, { method: 'POST', path: `/s/${sessionId}`, headers: OCTETS }),
        503,
        ErrorCode.CAPTURES_BUSY,
        "the receiver's 1018",
      );
    } finally {
      filler.release();
    }

    const { rows } = await pool.query('SELECT 1 FROM requests WHERE session_id = $1', [sessionId]);

    assert.equal(rows.length, 0);
  });

  it('ends its connection on the receive listener after a capture whose declared body has not all arrived: a GET, a HEAD and a TRACE, each stored', async () => {
    const sessionId = await createSession();

    // Fastify never reads the body of these three, so the capture is stored
    // and answered while the rest of the declared body is still to come.
    for (const method of ['GET', 'HEAD', 'TRACE']) {
      await assertEnded(
        stalled(receivePort, { method, path: `/s/${sessionId}` }),
        200,
        null,
        `a captured ${method}`,
      );
    }

    const { rows } = await pool.query<{ method: string }>(
      'SELECT method FROM requests WHERE session_id = $1 ORDER BY received_at',
      [sessionId],
    );

    assert.deepEqual(
      rows.map(({ method }) => method),
      ['GET', 'HEAD', 'TRACE'],
    );
    // Every place in the budget given back once the connections ended.
    await until(() => budget.used === 0, 'the capture budget is empty');
  });

  it('ends the connection of an upgrade request answered over HTTP on the application listener, outside /ws: /healthz, an unknown path and /s/...', async () => {
    const sessionId = await createSession();
    const upgrade = {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
    };

    for (const [path, status, errorCode] of [
      ['/healthz', 200, null],
      ['/no-such-page', 404, ErrorCode.ROUTE_NOT_FOUND],
      [`/s/${sessionId}`, 410, ErrorCode.RECEIVE_URL_MOVED],
    ] as const) {
      // With a declared body that stalls.
      await assertEnded(
        stalled(apiPort, { method: 'GET', path, headers: upgrade }),
        status,
        errorCode,
        `an upgrade to ${path} with a stalled body`,
      );

      // And with none: once answered, nothing would ever read the socket
      // again.
      const connection = connect(apiPort);

      connection.write(head({ method: 'GET', path, headers: upgrade }));
      await assertEnded(connection, status, errorCode, `an upgrade to ${path}`);
    }
  });

  it("ends its connection on the router's own refusals too: a path it cannot decode, 400, and a parameter over 100 characters, 414, with a stalled body or as an upgrade", async () => {
    const longId = 'a'.repeat(101);
    const upgrade = {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
    };

    for (const [port, path, status, code] of [
      [apiPort, '/api/sessions/%zz', 400, 'FST_ERR_BAD_URL'],
      [apiPort, `/api/sessions/${longId}`, 414, 'FST_ERR_MAX_PARAM_LENGTH'],
      [receivePort, '/%zz', 400, 'FST_ERR_BAD_URL'],
      [receivePort, `/s/${longId}`, 414, 'FST_ERR_MAX_PARAM_LENGTH'],
    ] as const) {
      const where = `${port === apiPort ? 'api' : 'receive'} ${path.slice(0, 40)}`;

      for (const connection of [
        stalled(port, { method: 'POST', path, headers: OCTETS }),
        stalledChunked(port, { method: 'POST', path, headers: OCTETS }, 'mid-chunk'),
      ]) {
        const answer = await connection.answer();

        assert.equal(answer.status, status, `${where}: ${answer.body}`);
        assert.equal(answer.headers.connection, 'close', where);
        // Fastify's own shape, outside the error contract, none of the hooks' headers.
        assert.deepEqual(Object.keys(JSON.parse(answer.body) as object), [
          'error',
          'code',
          'message',
          'statusCode',
        ]);
        assert.equal((JSON.parse(answer.body) as { code: string }).code, code, where);
        assert.equal(answer.headers['x-content-type-options'], undefined, where);
        await endedWithin(connection, where);
      }
    }

    // An upgrade request the router refuses, body or none: its socket ends.
    for (const path of [`/ws/${longId}`, '/ws/%zz', '/%zz']) {
      const connection = connect(apiPort);

      connection.write(head({ method: 'GET', path, headers: upgrade }));

      const answer = await connection.answer();

      assert.ok([400, 414].includes(answer.status), `${path}: ${answer.status}`);
      assert.equal(answer.headers.connection, 'close', path);
      await endedWithin(connection, `an upgrade to ${path.slice(0, 40)}`);
    }
  });

  it("ends its connection on the router's own refusals to a body sent whole with its head, in one write: 400 and 414 on a kept-alive connection, on both listeners", async () => {
    const longId = 'a'.repeat(101);
    // The same five bytes of body, framed by a `Content-Length`, or sent
    // chunked: one chunk and the last chunk, the whole of it.
    const framings = [
      ['Content-Length', { 'Content-Length': '5' }, 'hello'],
      ['chunked', { 'Transfer-Encoding': 'chunked' }, '5\r\nhello\r\n0\r\n\r\n'],
    ] as const;

    for (const [port, first, path, status, code] of [
      [apiPort, '/healthz', '/api/sessions/%zz', 400, 'FST_ERR_BAD_URL'],
      [apiPort, '/healthz', `/api/sessions/${longId}`, 414, 'FST_ERR_MAX_PARAM_LENGTH'],
      [receivePort, '/robots.txt', '/%zz', 400, 'FST_ERR_BAD_URL'],
      [receivePort, '/robots.txt', `/s/${longId}`, 414, 'FST_ERR_MAX_PARAM_LENGTH'],
    ] as const) {
      for (const [framing, framed, body] of framings) {
        const where = `${port === apiPort ? 'api' : 'receive'} ${path.slice(0, 40)}, ${framing}`;
        const connection = connect(port);

        // Kept alive first: a request without a body, answered and left open.
        connection.write(head({ method: 'GET', path: first }));

        const kept = await connection.answer(0);

        assert.equal(kept.status, 200, `${where}: ${kept.body}`);
        assert.equal(kept.headers.connection, 'keep-alive', where);

        // The body follows the head in the same write, so it reaches the
        // server in the same read; the router answers once the head is
        // parsed, before it, and its one look at the body finds it arriving.
        connection.write(head({ method: 'POST', path, headers: { ...OCTETS, ...framed } }) + body);

        const answer = await connection.answer(1);

        assert.equal(answer.status, status, `${where}: ${answer.body}`);
        assert.equal((JSON.parse(answer.body) as { code: string }).code, code, where);
        assert.equal(answer.headers.connection, 'close', where);
        await endedWithin(connection, where);
      }
    }
  });

  it('answers a path no route has 404 before any of its body, whatever the method, media type and framing, on both listeners', async () => {
    const mediaTypes = [
      'application/json',
      'text/plain; charset=utf-8',
      'application/x-www-form-urlencoded',
      'application/octet-stream',
      undefined,
    ];
    // `/robots.txt` has a route on the receive listener for `GET` and
    // `HEAD` alone, `/api/sessions/<id>/queue` one for `DELETE` and `PUT`.
    const targets: [port: number, path: string, methods: string[]][] = [
      [receivePort, '/no-such-page', ['POST', 'PUT', 'PATCH', 'DELETE']],
      [receivePort, '/robots.txt', ['POST', 'PUT', 'PATCH', 'DELETE']],
      [apiPort, '/no-such-page', ['POST', 'PUT', 'PATCH', 'DELETE']],
      [apiPort, '/api/no-such-route', ['POST', 'PUT', 'PATCH', 'DELETE']],
      [apiPort, '/mcp/x', ['POST', 'PUT', 'PATCH', 'DELETE']],
      [apiPort, `/api/sessions/${'a'.repeat(43)}/queue`, ['POST', 'PATCH']],
    ];

    for (const [port, path, methods] of targets) {
      for (const method of methods) {
        for (const contentType of mediaTypes) {
          const request: Head = {
            method,
            path,
            headers: contentType === undefined ? {} : { 'Content-Type': contentType },
          };
          const where = `${port === apiPort ? 'api' : 'receive'} ${method} ${path} ${contentType ?? 'with no Content-Type'}`;

          // Its length declared: 2,000 bytes, over the 1 KiB the
          // application listener's root reads of a body, and 100.
          for (const declared of [2_000, 100]) {
            await assertEnded(
              stalled(port, request, declared),
              404,
              ErrorCode.ROUTE_NOT_FOUND,
              `${where}, ${declared} bytes declared`,
            );
          }

          for (const shape of ['between', 'mid-chunk'] as const) {
            await assertEnded(
              stalledChunked(port, request, shape),
              404,
              ErrorCode.ROUTE_NOT_FOUND,
              `${where}, chunked, stalled ${shape}`,
            );
          }
        }
      }
    }

    // Methods beyond the four, which every route of the receiver takes and
    // Fastify reads a body for, and a body declared over each listener's
    // limit: still `404`, unread.
    for (const port of [apiPort, receivePort]) {
      for (const method of ['QUERY', 'OPTIONS', 'PROPFIND']) {
        await assertEnded(
          stalled(port, {
            method,
            path: '/no-such-page',
            headers: { 'Content-Type': 'application/json' },
          }),
          404,
          ErrorCode.ROUTE_NOT_FOUND,
          `${port === apiPort ? 'api' : 'receive'} ${method} to a path no route has`,
        );
      }

      const oversized = connect(port);

      oversized.write(
        head({
          method: 'POST',
          path: '/no-such-page',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(MAX_BODY_BYTES + 1),
          },
        }) + '[0123456789',
      );
      await assertEnded(oversized, 404, ErrorCode.ROUTE_NOT_FOUND, 'a body declared over 1 MiB');
    }

    // What Fastify refuses on its headers alone keeps its answer, before the
    // body too: a `QUERY` without a `Content-Type` (D166), and a
    // `Content-Type` that is not a media type (D104).
    for (const port of [apiPort, receivePort]) {
      const where = port === apiPort ? 'api' : 'receive';

      await assertEnded(
        stalled(port, { method: 'QUERY', path: '/no-such-page' }),
        400,
        ErrorCode.MISSING_REQUEST_CONTENT,
        `${where} QUERY with no Content-Type`,
      );
      await assertEnded(
        stalledChunked(port, { method: 'QUERY', path: '/no-such-page' }, 'mid-chunk'),
        400,
        ErrorCode.MISSING_REQUEST_CONTENT,
        `${where} QUERY with no Content-Type, chunked`,
      );
      await assertEnded(
        stalled(port, {
          method: 'POST',
          path: '/no-such-page',
          headers: { 'Content-Type': 'json' },
        }),
        415,
        ErrorCode.UNSUPPORTED_MEDIA_TYPE,
        `${where} POST declaring json`,
      );
    }
  });

  it('keeps a connection alive when the body has arrived whole, or none is framed: the next request on it is answered', async () => {
    const sessionId = await createSession();
    const whole = { 'Content-Type': 'application/octet-stream', 'Content-Length': '5' };
    // Declared JSON, and not JSON: a path no route has answers it `404`
    // unread, where its parser answered `400` / `1006` before D227.
    const notJson = { 'Content-Type': 'application/json', 'Content-Length': '5' };
    // Over the 1 KiB the application listener's root reads of a body
    // (`lib/ignored-body.ts`): `404` unread, where it was `413` / `1004`.
    const overKiB = `[${' '.repeat(2_046)}]`;
    const overKiBHeaders = { 'Content-Type': 'application/json', 'Content-Length': '2048' };
    // `Content-Length: 0` frames no body: the router's own `400` and `414`
    // keep its connection, as they do a request with no framing at all.
    const noBody = { 'Content-Length': '0' };

    for (const [port, calls] of [
      [
        apiPort,
        [
          [head({ method: 'POST', path: `/s/${sessionId}`, headers: whole }) + 'hello', 410],
          [head({ method: 'GET', path: '/healthz' }), 200],
          [head({ method: 'GET', path: '/healthz', headers: whole }) + 'hello', 200],
          [head({ method: 'GET', path: '/no-such-page', headers: whole }) + 'hello', 404],
          [head({ method: 'POST', path: '/no-such-page', headers: notJson }) + 'hello', 404],
          [
            head({ method: 'DELETE', path: '/api/no-such-route', headers: overKiBHeaders }) +
              overKiB,
            404,
          ],
          [head({ method: 'POST', path: '/api/sessions/%zz', headers: noBody }), 400],
          [
            head({ method: 'POST', path: `/api/sessions/${'a'.repeat(101)}`, headers: noBody }),
            414,
          ],
          [head({ method: 'GET', path: '/api/sessions/%zz' }), 400],
          [head({ method: 'GET', path: `/api/sessions/${'a'.repeat(101)}` }), 414],
        ],
      ],
      [
        receivePort,
        [
          [head({ method: 'GET', path: '/no-such-page', headers: whole }) + 'hello', 404],
          [head({ method: 'POST', path: '/no-such-page', headers: notJson }) + 'hello', 404],
          [head({ method: 'PUT', path: '/robots.txt', headers: notJson }) + 'hello', 404],
          [head({ method: 'GET', path: '/s/not-a-session', headers: whole }) + 'hello', 404],
          [head({ method: 'POST', path: `/s/${sessionId}`, headers: whole }) + 'hello', 200],
          [head({ method: 'GET', path: `/s/${sessionId}`, headers: whole }) + 'hello', 200],
          [head({ method: 'POST', path: '/%zz', headers: noBody }), 400],
          [head({ method: 'GET', path: '/robots.txt' }), 200],
          [head({ method: 'GET', path: '/%zz' }), 400],
        ],
      ],
    ] as const) {
      const connection = connect(port);

      for (const [index, [request, status]] of calls.entries()) {
        connection.write(request);

        const answer = await connection.answer(index);

        assert.equal(answer.status, status, `${port} ${index}: ${answer.body}`);
        assert.equal(answer.headers.connection, 'keep-alive', `${port} ${index}`);
      }

      await delay(200);
      assert.equal(connection.ended(), false, 'the server ended a connection it could keep');
    }
  });
});
