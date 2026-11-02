/**
 * A request whose connection ends before its body has arrived is logged once,
 * at `info`, as aborted by the client, and nothing is written for it; a genuine
 * failure on a request that arrived whole is still an `Unhandled error` (D174).
 *
 * Over real sockets, against the servers `buildServer` and `buildReceiver`
 * build - a webhook goes to the receive listener (D187) - with its log read
 * through `logDestination`. Needs no database: a pool stands in for it that
 * fails as a dropped connection does - with the very text of an abandoned body,
 * `aborted` and `ECONNRESET` - so that only the state of the request can tell
 * the two apart.
 */
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import { ErrorCode } from '@webhook-inspector/shared';
import { buildReceiver, buildServer } from './server.ts';

const ABORTED = 'Request aborted by the client';
const UNHANDLED = 'Unhandled error';

/** Well-formed; only the failing pool below is ever asked about it. */
const SESSION_ID = 'z'.repeat(43);

/** Pino's numeric levels. */
const INFO = 30;
const WARN = 40;
const ERROR = 50;

interface LogLine {
  level: number;
  msg: string;
  reqId?: string;
  err?: { type?: string; message?: string; code?: string; stack?: string };
}

interface Exchange {
  request: IncomingMessage;
  response: ServerResponse;
}

interface TestServer {
  port: number;
  /** The first request the server receives, as Node hands it to Fastify. */
  exchange: Promise<Exchange>;
  lines: () => LogLine[];
}

/** Polls until `condition` holds; bounded, so a line that never comes fails instead of hanging. */
async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await delay(10);
  }
}

/**
 * Runs `run` against a listening server built on `pool`, closes the server,
 * and returns every line it logged.
 */
async function withServer(
  pool: pg.Pool,
  run: (server: TestServer) => Promise<void>,
  build: typeof buildServer | typeof buildReceiver = buildServer,
): Promise<LogLine[]> {
  let output = '';
  const app = build(pool, {
    logDestination: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
  });
  const lines = (): LogLine[] =>
    output
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as LogLine);
  const exchange = new Promise<Exchange>((resolve) => {
    app.server.once('request', (request: IncomingMessage, response: ServerResponse) => {
      resolve({ request, response });
    });
  });

  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();

    await run({ port: typeof address === 'object' && address ? address.port : 0, exchange, lines });
  } finally {
    await app.close();
  }

  return lines();
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket));

    socket.once('error', reject);
  });
}

/** Everything the server writes to a connection, once the connection has closed. */
function readUntilClosed(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let received = '';

    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
    });
    // A server that closes with bytes unread may reset the connection; what
    // arrived before it is what is asserted on.
    socket.on('error', () => undefined);
    socket.once('close', () => resolve(received));
  });
}

/**
 * Resolves once the server's end of a connection has closed. Not `once(socket,
 * 'close')`, which rejects on the `error` a socket destroyed with a parse error
 * emits first.
 */
function serverSideClosed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.closed) {
      resolve();
      return;
    }

    socket.once('close', () => resolve());
  });
}

/** Resolves once the server has started reading the request's body. */
async function bodyBeingRead(server: TestServer): Promise<void> {
  const { request } = await server.exchange;

  await until(() => request.readableFlowing === true, 'the server to read the body');
}

/**
 * Resolves once the request has a line after `incoming request`: the one that
 * says how it ended, whichever that is, so that a wrong one fails on what it
 * says rather than on a timeout.
 */
async function outcomeLogged(server: TestServer): Promise<void> {
  await until(
    () =>
      server.lines().some((line) => line.reqId !== undefined && line.msg !== 'incoming request'),
    'a line saying how the request ended',
  );
}

/** A request line and headers, then part of a body declared longer. */
function partialBody(target: string, headers: string[]): string {
  return [
    `POST ${target} HTTP/1.1`,
    'Host: qa-tools.ru',
    ...headers,
    'Content-Length: 1000',
    '',
    '',
  ]
    .join('\r\n')
    .concat('{"part');
}

/** An error as a database connection that drops raises it: word for word an abandoned body's. */
function droppedConnection(): Error {
  return Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
}

/**
 * A pool whose every query fails as a dropped connection does, once `release`
 * is called. Only `query` and `connect` are ever reached by the routes used here.
 */
function failingPool(): { pool: pg.Pool; queried: Promise<void>; release: () => void } {
  let entered = (): void => undefined;
  let release = (): void => undefined;
  const queried = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fail = async (): Promise<never> => {
    entered();
    await released;
    throw droppedConnection();
  };

  return { pool: { query: fail, connect: fail } as unknown as pg.Pool, queried, release };
}

/** The one request's trail: its `reqId` and the messages logged under it, in order. */
function trail(lines: LogLine[]): { reqId: string; messages: string[] } {
  const incoming = lines.filter((line) => line.msg === 'incoming request');

  assert.equal(incoming.length, 1, 'expected exactly one request');

  const reqId = incoming[0]?.reqId;

  assert.equal(typeof reqId, 'string');

  return {
    reqId: reqId as string,
    messages: lines.filter((line) => line.reqId === reqId).map((line) => line.msg),
  };
}

function assertLoggedAsAborted(lines: LogLine[]): void {
  const { reqId, messages } = trail(lines);
  const aborted = lines.filter((line) => line.msg === ABORTED);

  assert.equal(aborted.length, 1, JSON.stringify(lines));
  assert.equal(aborted[0]?.level, INFO);
  assert.equal(aborted[0]?.reqId, reqId);
  // No error and no stack: nothing about this is the server's fault.
  assert.equal(aborted[0]?.err, undefined);
  // The line closes the trail: no `request completed`, no warning after it.
  assert.deepEqual(messages, ['incoming request', ABORTED]);
  assert.deepEqual(
    lines.filter((line) => line.level >= WARN),
    [],
    'a warning or an error was logged',
  );
}

function assertNothingWritten({ response }: Exchange): void {
  assert.equal(response.headersSent, false, 'a status line was written for the request');
  assert.equal(response.writableEnded, false, 'a response was ended for the request');
}

describe('a request whose connection ends before its body has arrived (D174)', () => {
  const abandoned: [string, string][] = [
    ['a create', '/api/sessions'],
    ['a webhook', `/s/${SESSION_ID}`],
    ['a webhook to a path under the endpoint', `/s/${SESSION_ID}/hooks/stripe`],
  ];

  // How the client leaves decides what reaches the connection before the
  // error handler runs, never what the handler does. A FIN mid-body is an
  // unfinished message to Node's parser, and Fastify's client-error handler
  // writes its `400` before closing (D142); a reset is written nothing.
  const endings: [string, (client: net.Socket) => void, boolean][] = [
    ['closes its end', (client) => client.destroy(), true],
    ['resets the connection', (client) => client.resetAndDestroy(), false],
  ];

  for (const [label, target] of abandoned) {
    for (const [ending, leave, parserAnswers] of endings) {
      it(`logs ${label} whose client ${ending} mid-body once, at info, and writes nothing`, async () => {
        const { pool } = failingPool();
        let exchange: Exchange | undefined;

        const lines = await withServer(
          pool,
          async (server) => {
            const client = await connect(server.port);

            client.write(partialBody(target, ['Content-Type: application/json']));
            await bodyBeingRead(server);
            leave(client);

            await outcomeLogged(server);
            exchange = await server.exchange;
          },
          target.startsWith('/s/') ? buildReceiver : buildServer,
        );

        assertLoggedAsAborted(lines);
        assertNothingWritten(exchange as Exchange);
        assert.equal(
          (exchange as Exchange).request.socket.bytesWritten > 0,
          parserAnswers,
          'what reached the connection before the error handler ran',
        );
      });
    }
  }

  it('logs a GET that declares a body and is abandoned at info, though its handler fails after', async () => {
    // Fastify reads no body for `GET`, `HEAD` or `TRACE` and runs the handler
    // at once. The body was never read, so the rule holds even for a failure
    // that is the server's own: a query failing once the client has gone.
    const { pool, queried, release } = failingPool();
    let exchange: Exchange | undefined;

    const lines = await withServer(pool, async (server) => {
      const client = await connect(server.port);

      client.write(
        [
          `GET /api/sessions/${SESSION_ID} HTTP/1.1`,
          'Host: qa-tools.ru',
          'Content-Length: 1000',
          '',
          'part',
        ].join('\r\n'),
      );
      await queried;
      exchange = await server.exchange;

      const { socket } = exchange.request;

      client.destroy();

      await serverSideClosed(socket);

      release();
      await outcomeLogged(server);
    });

    assertLoggedAsAborted(lines);
    assertNothingWritten(exchange as Exchange);
  });

  it('logs a chunked body the parser refuses mid-read the same way (D142)', async () => {
    const { pool } = failingPool();
    let received = '';
    let exchange: Exchange | undefined;

    const lines = await withServer(
      pool,
      async (server) => {
        const client = await connect(server.port);
        const closed = readUntilClosed(client);

        client.write(
          [
            `POST /s/${SESSION_ID} HTTP/1.1`,
            'Host: qa-tools.ru',
            'Content-Type: text/plain',
            'Transfer-Encoding: chunked',
            '',
            '',
          ].join('\r\n'),
        );
        await bodyBeingRead(server);
        // Not a chunk-size line: the parser refuses it, and Fastify's client-error
        // handler answers and closes the connection.
        client.write('zz\r\nabc\r\n');

        received = await closed;
        await outcomeLogged(server);
        exchange = await server.exchange;
      },
      buildReceiver,
    );

    // The parser's own refusal, and no second answer after it.
    assert.match(received, /^HTTP\/1\.1 400 /);
    assert.equal(received.split('HTTP/1.1 ').length - 1, 1, received);
    assertLoggedAsAborted(lines);
    assertNothingWritten(exchange as Exchange);
  });

  it('logs a refused create whose client goes during the drain the same way (D143)', async () => {
    const { pool } = failingPool();
    let exchange: Exchange | undefined;

    const lines = await withServer(pool, async (server) => {
      const client = await connect(server.port);

      // Refused on its media type before the body is read; with `Connection:
      // close` and a declared length within the bound, the body is drained
      // before the 415 is written, and the client leaves during the drain.
      client.write(partialBody('/api/sessions', ['Content-Type: text/plain', 'Connection: close']));
      await bodyBeingRead(server);
      client.destroy();

      await outcomeLogged(server);
      exchange = await server.exchange;
    });

    assertLoggedAsAborted(lines);
    assertNothingWritten(exchange as Exchange);
  });
});

describe('a genuine failure on a request that arrived whole (D174)', () => {
  function assertLoggedAsUnhandled(lines: LogLine[], expected: string[]): void {
    const { reqId, messages } = trail(lines);
    const unhandled = lines.filter((line) => line.msg === UNHANDLED);

    assert.equal(unhandled.length, 1, JSON.stringify(lines));
    assert.equal(unhandled[0]?.level, ERROR);
    assert.equal(unhandled[0]?.reqId, reqId);
    assert.equal(unhandled[0]?.err?.message, 'aborted');
    assert.equal(unhandled[0]?.err?.code, 'ECONNRESET');
    assert.equal(typeof unhandled[0]?.err?.stack, 'string');
    assert.deepEqual(messages, expected);
    assert.equal(
      lines.some((line) => line.msg === ABORTED),
      false,
    );
  }

  it('is still logged at error level as an Unhandled error and answered 500 / 1500', async () => {
    const { pool, release } = failingPool();
    let received = '';

    release();

    const lines = await withServer(pool, async (server) => {
      const client = await connect(server.port);
      const closed = readUntilClosed(client);

      client.write(
        [
          'POST /api/sessions HTTP/1.1',
          'Host: qa-tools.ru',
          'Connection: close',
          'Content-Type: application/json',
          'Content-Length: 2',
          '',
          '{}',
        ].join('\r\n'),
      );

      received = await closed;
    });

    const [head = '', body = ''] = received.split('\r\n\r\n');

    assert.match(head, /^HTTP\/1\.1 500 /);
    assert.deepEqual(JSON.parse(body), {
      errorCode: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    });
    assertLoggedAsUnhandled(lines, ['incoming request', UNHANDLED, 'request completed']);
  });

  // The two below fail while the handler is waiting for the database, after
  // the client has gone. What decides is whether the request had arrived
  // whole, not whether its connection is still there.
  const arrivedWhole: [string, string, string[]][] = [
    [
      'a create whose body was read',
      'POST /api/sessions HTTP/1.1',
      ['Content-Type: application/json', 'Content-Length: 2', '', '{}'],
    ],
    // No body, so nothing ever reads its request stream to the end: it is
    // `readableAborted` once the client has gone, and only `complete` tells it
    // from an abandoned body.
    ['a read with no body', `GET /api/sessions/${SESSION_ID} HTTP/1.1`, ['', '']],
  ];

  for (const [label, requestLine, rest] of arrivedWhole) {
    it(`is still an Unhandled error on ${label} when its client has gone`, async () => {
      const { pool, queried, release } = failingPool();

      const lines = await withServer(pool, async (server) => {
        const client = await connect(server.port);

        client.write([requestLine, 'Host: qa-tools.ru', ...rest].join('\r\n'));
        await queried;

        const { request } = await server.exchange;
        const socket = request.socket;

        client.destroy();

        await serverSideClosed(socket);

        release();
        await outcomeLogged(server);
      });

      // Its 500 is written to nobody, and no `request completed` follows.
      assertLoggedAsUnhandled(lines, ['incoming request', UNHANDLED]);
    });
  }
});
