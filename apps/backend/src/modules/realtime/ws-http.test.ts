/**
 * An HTTP request to `/ws/<session-id>` that is not an upgrade (#179): a
 * plain `GET`, and the `HEAD` Fastify adds beside every `GET` route, with or
 * without upgrade headers. Each is answered `404` / `1000` in the error
 * contract's shape (D026, D062) - the same for an active, an expired, an
 * unknown and a malformed id, before any session is looked up - with nothing
 * logged at error, none of the per-minute limits' headers and no count
 * against them, and its realtime place given back once its answer closes
 * (D227). Until 1.0.14 the `HEAD` reached the WebSocket handler as if it
 * were an HTTP one and answered `500` / `1500` with an `Unhandled error`,
 * and the plain `GET` answered `404` with no body.
 *
 * Over real sockets, against the application listener `buildServer` builds,
 * its log read through `logDestination` and its pool counting the queries
 * asked of it. The hostile shapes too: an encoded path, a repeated
 * declaration, HTTP/1.0, declared bodies whole, chunked and stalled,
 * pipelined requests, ids up to and past the router's 100 characters, and
 * 10, 100 and 1,000 requests one after another and 50 at once.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, RouteOptions } from 'fastify';
import type pg from 'pg';
import { ErrorCode, type ApiError } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildServer, type ServerOptions } from '../../server.ts';
import { whileExpired } from '../../testing/expired-session.ts';
import { until } from '../../testing/realtime.ts';
import { addressKey } from '../limits/rate-limit.ts';
import { createRealtimePlaces, type RealtimePlaces } from './connection-places.ts';

/** The answer's body for a `GET`; its length is the `HEAD`'s `Content-Length`. */
const NOT_FOUND: ApiError = { errorCode: ErrorCode.ROUTE_NOT_FOUND, message: 'Not found' };
const NOT_FOUND_LENGTH = String(Buffer.byteLength(JSON.stringify(NOT_FOUND)));
const JSON_TYPE = 'application/json; charset=utf-8';

/** Well-formed, and no session's. */
const UNKNOWN_ID = 'z'.repeat(43);
/** Not an id at all: too short, and one character outside the alphabet. */
const MALFORMED_IDS = ['not-a-session', `${'z'.repeat(42)}!`];

/** Pino's level of `error`. */
const ERROR = 50;

/** The headers of an upgrade a browser writes, `Connection` and `Upgrade` included. */
const UPGRADE = {
  Connection: 'Upgrade',
  Upgrade: 'websocket',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version': '13',
};

let pool: pg.Pool;
const createdSessionIds: string[] = [];
const listeners: FastifyInstance[] = [];
/** Every connection a test opened, so that none outlives the file. */
const sockets: net.Socket[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
  })();
  await startup;
});

after(async () => {
  await startup;

  for (const socket of sockets) {
    socket.destroy();
  }

  await Promise.all(listeners.map((listener) => listener.close()));

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await pool?.end();
});

/** `base`, counting every query and connection asked of it. */
function countingPool(base: pg.Pool): { pool: pg.Pool; asked: () => number } {
  let asked = 0;
  const counted = new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property, target);

      if (property === 'query' || property === 'connect') {
        return (...args: unknown[]) => {
          asked += 1;

          return (value as (...forwarded: unknown[]) => unknown).apply(target, args);
        };
      }

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });

  return { pool: counted, asked: () => asked };
}

interface LogLine {
  level: number;
  msg: string;
}

interface Listener {
  app: FastifyInstance;
  port: number;
  places: RealtimePlaces;
  /** Queries and connections asked of the listener's pool so far. */
  asked: () => number;
  /** Everything the listener has logged so far, raw. */
  output: () => string;
  lines: () => LogLine[];
  /** Every route registered, as the server's `onRoute` sees it. */
  routes: RouteOptions[];
}

/** The application listener on a port of its own, its log kept and its pool counted. */
async function listen(options: Partial<ServerOptions> = {}): Promise<Listener> {
  const counted = countingPool(pool);
  const places = options.realtimePlaces ?? createRealtimePlaces();
  const routes: RouteOptions[] = [];
  let output = '';
  const app = buildServer(counted.pool, {
    ...options,
    realtimePlaces: places,
    onRoute: (route) => {
      routes.push(route);
    },
    logDestination: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
  });

  listeners.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });

  return {
    app,
    port: (app.server.address() as net.AddressInfo).port,
    places,
    asked: counted.asked,
    output: () => output,
    lines: () =>
      output
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as LogLine),
    routes,
  };
}

async function createSession(app: FastifyInstance): Promise<string> {
  // From an address of its own, so that no test's count includes it.
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    remoteAddress: '198.18.0.1',
  });

  assert.equal(response.statusCode, 201, response.body);

  const { id } = response.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

/** A request's head, written by hand; `Host` given unless set to `null`. */
function head(
  method: string,
  target: string,
  headers: Record<string, string | null> = {},
  version = '1.1',
): string {
  const lines: Record<string, string | null> = { Host: '127.0.0.1', ...headers };

  return [
    `${method} ${target} HTTP/${version}`,
    ...Object.entries(lines)
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n');
}

interface Answer {
  status: number;
  /** By lower-case name. */
  headers: Record<string, string>;
  body: string;
}

interface Client {
  /** Writes `text` and resolves with the answers to `methods`, in order. */
  send: (text: string, methods: readonly string[]) => Promise<Answer[]>;
  /** Whether the server has ended the connection. */
  ended: () => boolean;
  /** What arrived past the last answer read: what a `HEAD`'s answer must never carry. */
  extra: () => string;
  close: () => void;
}

/**
 * A connection of its own, reading its answers as they arrive: a `HEAD`'s
 * answer has no body whatever its `Content-Length`, every other one the
 * `Content-Length` it declares.
 */
function client(port: number): Client {
  const socket = net.connect(port, '127.0.0.1');
  let received = Buffer.alloc(0);
  let ended = false;
  const waiting: {
    method: string;
    resolve: (answer: Answer) => void;
    reject: (error: Error) => void;
  }[] = [];
  const end = (): void => {
    ended = true;

    // Everything that arrived has been read by now: what is still awaited
    // never comes.
    for (const { reject } of waiting.splice(0)) {
      reject(new Error('the connection ended before every answer'));
    }
  };
  const read = (): void => {
    while (waiting.length > 0) {
      const headEnd = received.indexOf('\r\n\r\n');

      if (headEnd === -1) {
        return;
      }

      const [statusLine = '', ...headerLines] = received
        .subarray(0, headEnd)
        .toString('latin1')
        .split('\r\n');
      const headers: Record<string, string> = {};

      for (const line of headerLines) {
        const colon = line.indexOf(':');

        headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }

      const [{ method, resolve }] = waiting as [(typeof waiting)[number]];
      const length = method === 'HEAD' ? 0 : Number(headers['content-length'] ?? 0);
      const answerEnd = headEnd + 4 + length;

      if (received.length < answerEnd) {
        return;
      }

      waiting.shift();
      resolve({
        status: Number(statusLine.split(' ')[1]),
        headers,
        body: received.subarray(headEnd + 4, answerEnd).toString(),
      });
      received = received.subarray(answerEnd);
    }
  };

  sockets.push(socket);
  socket.on('error', () => undefined);
  socket.on('data', (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    read();
  });
  socket.once('end', end);
  socket.once('close', end);

  return {
    send: async (text, methods) => {
      const answers = Promise.all(
        methods.map(
          (method) =>
            new Promise<Answer>((resolve, reject) => waiting.push({ method, resolve, reject })),
        ),
      );
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${methods.length} answers`));
        }, 5_000);
      });

      socket.write(text);

      try {
        return await Promise.race([answers, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    ended: () => ended,
    extra: () => received.toString('latin1'),
    close: () => {
      socket.destroy();
    },
  };
}

/** One request on a connection of its own that the server ends: its answer, and nothing after it. */
async function once(port: number, method: string, text: string): Promise<Answer> {
  const connection = client(port);
  const [answer] = (await connection.send(text, [method])) as [Answer];

  await until(connection.ended, 'the connection ends', 1_000);
  assert.equal(connection.extra(), '', `${method}: nothing after the answer`);

  return answer;
}

/** `404` / `1000`: for a `HEAD` its headers alone, for a `GET` its body too. */
function assertNotFound(answer: Answer, method: string, where: string): void {
  assert.equal(answer.status, 404, `${where}: ${answer.body}`);
  assert.equal(answer.headers['content-type'], JSON_TYPE, where);
  assert.equal(answer.headers['content-length'], NOT_FOUND_LENGTH, where);

  if (method === 'HEAD') {
    assert.equal(answer.body, '', where);
  } else {
    assert.deepEqual(JSON.parse(answer.body), NOT_FOUND, where);
  }

  assert.deepEqual(
    Object.keys(answer.headers).filter((name) => name.startsWith('x-ratelimit-')),
    [],
    `${where}: none of the limits' headers`,
  );
}

/** What a log line at error or above says, so that a failure names it. */
function errorLines(server: Listener): string[] {
  return server
    .lines()
    .filter((line) => line.level >= ERROR)
    .map((line) => `${line.level} ${line.msg}`);
}

async function untilNothingHeld(places: RealtimePlaces): Promise<void> {
  await until(() => places.taken === 0 && places.keys === 0, 'every place given back');
}

/** An id of `length` id characters, different every time. */
function randomId(length: number): string {
  return randomBytes(length).toString('base64url').slice(0, length);
}

describe('an HTTP request to /ws/<id> that is not an upgrade (#179)', () => {
  it('gives the HEAD copy of the route the plain handler, never the WebSocket one', async () => {
    const server = await listen();
    const copies = server.routes.filter((route) => route.url === '/ws/:sessionId');

    assert.deepEqual(copies.map((route) => route.method).sort(), ['GET', 'HEAD']);

    const headCopy = copies.find((route) => route.method === 'HEAD') as RouteOptions;

    assert.equal(typeof headCopy.wsHandler, 'function');
    assert.notEqual(headCopy.handler, headCopy.wsHandler);
  });

  for (const method of ['HEAD', 'GET']) {
    it(`answers a ${method} 404 / 1000 the same for an active, an expired, an unknown and a malformed id, looking nothing up and logging nothing at error`, async () => {
      const server = await listen();
      const active = await createSession(server.app);
      const expired = await createSession(server.app);
      const answers: [string, Answer][] = [];

      await whileExpired(pool, expired, async () => {
        for (const [kind, id] of [
          ['active', active],
          ['expired', expired],
          ['unknown', UNKNOWN_ID],
          ...MALFORMED_IDS.map((malformed) => ['malformed', malformed]),
        ] as const) {
          const asked = server.asked();
          const answer = await once(
            server.port,
            method,
            head(method, `/ws/${id}`, { Connection: 'close' }),
          );

          assertNotFound(answer, method, `${method}, ${kind} id`);
          assert.equal(server.asked(), asked, `${method}, ${kind} id: nothing looked up`);
          answers.push([kind, answer]);
        }
      });

      // Identical, the date aside: nothing tells one kind of id from another.
      const [first, ...rest] = answers.map(([, answer]) => ({
        ...answer,
        headers: { ...answer.headers, date: undefined },
      }));

      for (const other of rest) {
        assert.deepEqual(other, first);
      }

      assert.deepEqual(errorLines(server), []);
      await untilNothingHeld(server.places);
    });
  }

  it('answers a HEAD carrying upgrade headers the same, and ends its socket', async () => {
    const server = await listen();
    const active = await createSession(server.app);

    for (const id of [active, UNKNOWN_ID, MALFORMED_IDS[0] as string]) {
      const asked = server.asked();
      const answer = await once(server.port, 'HEAD', head('HEAD', `/ws/${id}`, UPGRADE));

      assertNotFound(answer, 'HEAD', `HEAD with upgrade headers to ${id}`);
      assert.equal(answer.headers.connection, 'close');
      assert.equal(answer.headers.upgrade, undefined);
      assert.equal(server.asked(), asked, 'nothing looked up');
    }

    assert.deepEqual(errorLines(server), []);
    await untilNothingHeld(server.places);
  });

  it("carries none of the per-minute limits' headers and counts against none of them", async () => {
    const server = await listen({ rateLimits: { sessionCreates: 1, apiCalls: 2 } });

    for (let index = 0; index < 5; index += 1) {
      assertNotFound(
        await once(server.port, 'HEAD', head('HEAD', `/ws/${UNKNOWN_ID}`, UPGRADE)),
        'HEAD',
        `HEAD with upgrade headers ${index}`,
      );
    }

    const connection = client(server.port);

    for (let index = 0; index < 10; index += 1) {
      const [headAnswer, getAnswer] = await connection.send(
        head('HEAD', `/ws/${UNKNOWN_ID}`) + head('GET', `/ws/${UNKNOWN_ID}`),
        ['HEAD', 'GET'],
      );

      assertNotFound(headAnswer as Answer, 'HEAD', `HEAD ${index}`);
      assertNotFound(getAnswer as Answer, 'GET', `GET ${index}`);
    }

    // The address's first call under `/api`, after 25 to `/ws`: counted
    // as the first of its two.
    const [call] = (await connection.send(head('GET', '/api/no-such-route'), ['GET'])) as [Answer];

    assert.equal(call.status, 404, call.body);
    assert.equal(call.headers['x-ratelimit-limit'], '2');
    assert.equal(call.headers['x-ratelimit-remaining'], '1');
    connection.close();
  });

  it('gives back the place each takes once its answer closes, and answers 429 / 1020 first while every place of the address is taken (D227)', async () => {
    const places = createRealtimePlaces(1);
    const server = await listen({ realtimePlaces: places });
    const connection = client(server.port);

    // Kept alive: the place comes back with the answer, not with the connection.
    for (const method of ['HEAD', 'GET', 'HEAD', 'GET']) {
      const [answer] = (await connection.send(head(method, `/ws/${UNKNOWN_ID}`), [method])) as [
        Answer,
      ];

      assertNotFound(answer, method, `${method}, kept alive`);
      await untilNothingHeld(places);
    }

    assert.equal(connection.ended(), false, 'the connection is kept alive');

    // The address's one place taken, as by an open connection.
    const release = places.tryTake(addressKey('127.0.0.1'));

    assert.ok(release !== null);

    const refusal: ApiError = {
      errorCode: ErrorCode.TOO_MANY_REALTIME_CONNECTIONS,
      message: 'Too many realtime connections: 1 open at once per address; close one and try again',
    };

    for (const [method, headers] of [
      ['HEAD', { Connection: 'close' }],
      ['HEAD', UPGRADE],
      ['GET', { Connection: 'close' }],
    ] as const) {
      const answer = await once(server.port, method, head(method, `/ws/${UNKNOWN_ID}`, headers));

      assert.equal(answer.status, 429, `${method}: ${answer.body}`);
      assert.equal(answer.headers['retry-after'], '1');
      assert.equal(answer.headers['content-type'], JSON_TYPE);
      assert.equal(
        answer.headers['content-length'],
        String(Buffer.byteLength(JSON.stringify(refusal))),
      );
      assert.equal(answer.body, method === 'HEAD' ? '' : JSON.stringify(refusal));
      assert.equal(places.taken, 1, 'nothing more taken');
    }

    release();
    await untilNothingHeld(places);

    const [answer] = (await connection.send(head('HEAD', `/ws/${UNKNOWN_ID}`), ['HEAD'])) as [
      Answer,
    ];

    assertNotFound(answer, 'HEAD', 'HEAD once the place is back');
    connection.close();
    assert.deepEqual(errorLines(server), []);
    await untilNothingHeld(places);
  });
});

describe('hostile HTTP requests to /ws/<id> (#179)', () => {
  it('answers the variants of a request alike: an encoded path, a repeated declaration, HTTP/1.0', async () => {
    const server = await listen();

    for (const method of ['HEAD', 'GET']) {
      const variants: [string, string][] = [
        ['an encoded path', head(method, `/%77s/${UNKNOWN_ID}`, { Connection: 'close' })],
        [
          'a repeated declaration',
          head(method, `/ws/${UNKNOWN_ID}?events=requests&events=,,x&events=`, {
            Connection: 'close',
          }),
        ],
        ['HTTP/1.0 with no Host', head(method, `/ws/${UNKNOWN_ID}`, { Host: null }, '1.0')],
      ];

      if (method === 'HEAD') {
        variants.push([
          'upgrade headers over HTTP/1.0',
          head(method, `/ws/${UNKNOWN_ID}`, UPGRADE, '1.0'),
        ]);
      }

      for (const [where, text] of variants) {
        const answer = await once(server.port, method, text);

        assertNotFound(answer, method, `${method}, ${where}`);
      }
    }

    assert.equal(server.asked(), 0, 'nothing looked up');
    assert.deepEqual(errorLines(server), []);
    await untilNothingHeld(server.places);
  });

  it('keeps the framing of a kept-alive connection: declared bodies sent whole, chunked or empty, pipelined, then GET /healthz', async () => {
    const server = await listen();
    const connection = client(server.port);
    const target = `/ws/${UNKNOWN_ID}`;
    const answers = await connection.send(
      [
        head('HEAD', target, { 'Content-Length': '0' }),
        head('HEAD', target, { 'Content-Length': '1024' }) + 'b'.repeat(1024),
        head('HEAD', target, { 'Transfer-Encoding': 'chunked' }) + '5\r\nhello\r\n0\r\n\r\n',
        head('GET', target, { 'Content-Length': '2048' }) + 'b'.repeat(2048),
        head('GET', target, { 'Transfer-Encoding': 'chunked' }) + '5\r\nhello\r\n0\r\n\r\n',
        head('HEAD', target),
        head('GET', target),
        head('GET', '/healthz'),
      ].join(''),
      ['HEAD', 'HEAD', 'HEAD', 'GET', 'GET', 'HEAD', 'GET', 'GET'],
    );
    const health = answers.pop() as Answer;

    answers.forEach((answer, index) => {
      assertNotFound(answer, index < 3 || index === 5 ? 'HEAD' : 'GET', `request ${index}`);
      assert.notEqual(answer.headers.connection, 'close', `request ${index} keeps it alive`);
    });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
    assert.equal(connection.extra(), '', 'nothing past the last answer');
    assert.equal(connection.ended(), false);
    connection.close();
    assert.deepEqual(errorLines(server), []);
    await untilNothingHeld(server.places);
  });

  it('ends the connection of a request whose declared body is still arriving (D213 point 5)', async () => {
    const server = await listen();

    for (const method of ['HEAD', 'GET']) {
      const connection = client(server.port);
      const [answer] = (await connection.send(
        head(method, `/ws/${UNKNOWN_ID}`, { 'Content-Length': '2048' }) + 'b'.repeat(1024),
        [method],
      )) as [Answer];

      assertNotFound(answer, method, `${method}, half its body`);
      assert.equal(answer.headers.connection, 'close');
      await until(connection.ended, `${method}: the connection ends`, 1_000);
    }

    assert.deepEqual(errorLines(server), []);
    await untilNothingHeld(server.places);
  });

  it("answers ids of 44 and 100 characters 404 / 1000 and longer ones the router's 414, leaking no id to the log", async () => {
    const server = await listen();

    for (const method of ['HEAD', 'GET']) {
      for (const length of [44, 100, 101, 8_000]) {
        const id = randomId(length);
        const answer = await once(
          server.port,
          method,
          head(method, `/ws/${id}`, { Connection: 'close' }),
        );
        const where = `${method}, an id of ${length}`;

        if (length <= 100) {
          assertNotFound(answer, method, where);
        } else {
          // The router's own refusal of a parameter over 100 characters,
          // outside the contract as documented (D173, D201).
          assert.equal(answer.status, 414, where);
        }

        assert.equal(server.output().includes(id), false, `${where}: the id is not logged`);
      }
    }

    assert.equal(server.asked(), 0, 'nothing looked up');
    assert.deepEqual(errorLines(server), []);
    await untilNothingHeld(server.places);
  });

  it('stays quiet and holds nothing at growing counts: 10, 100 and 1,000 one after another, and 50 at once', async () => {
    const server = await listen();
    const connection = client(server.port);
    const perRequest: number[] = [];

    for (const count of [10, 100, 1_000]) {
      const linesBefore = server.lines().length;

      for (let index = 0; index < count; index += 1) {
        const method = index % 2 === 0 ? 'HEAD' : 'GET';
        const [answer] = (await connection.send(head(method, `/ws/${UNKNOWN_ID}`), [method])) as [
          Answer,
        ];

        assertNotFound(answer, method, `${method} ${index} of ${count}`);
      }

      await untilNothingHeld(server.places);
      perRequest.push((server.lines().length - linesBefore) / count);
    }

    // The log grows by as many lines a request whatever the count.
    assert.equal(new Set(perRequest).size, 1, `log lines a request: ${perRequest.join(', ')}`);
    assert.equal(connection.ended(), false);
    connection.close();

    const together = await Promise.all(
      Array.from({ length: 50 }, (_, index) => {
        const method = index % 2 === 0 ? 'HEAD' : 'GET';

        return once(
          server.port,
          method,
          head(method, `/ws/${UNKNOWN_ID}`, { Connection: 'close' }),
        ).then((answer) => [method, answer] as const);
      }),
    );

    for (const [method, answer] of together) {
      assertNotFound(answer, method, `${method} of 50 at once`);
    }

    assert.equal(server.asked(), 0, 'nothing looked up');
    assert.deepEqual(errorLines(server), []);
    await untilNothingHeld(server.places);
  });
});
