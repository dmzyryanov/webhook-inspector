/**
 * The answers' byte budget (#184, D228's amendment). Without a server: 16 MiB
 * an address and 64 MiB in all; an answer refused only while its address has
 * another counted, so an address's first always passes, whatever its size and
 * whatever the others hold; bytes given back once however often they are;
 * a refusal counted without being refused; an address kept only while it has
 * an answer counted; and floods of answers and of addresses.
 *
 * And the hook on a listener of its own, over real sockets, with no
 * database: an answer counted from the moment it is serialized until its
 * response closes - held while it waits behind another on its connection -
 * and given back exactly once however that ends: written whole, its client
 * gone, its connection reset, the server's timeout, the answer's client gone
 * before it was ready; refused `429` / `1019` with `Retry-After: 1` by the
 * route's error handler, the refusal counted and never refused; nothing
 * counted for a `HEAD`, a stream, an empty body or a path the hook is not
 * told is a call; and an answer replaced by a later hook's failure given back
 * as its replacement is counted.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  API_ANSWER_BYTES,
  API_ANSWER_PER_ADDRESS_BYTES,
  CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS,
  ErrorCode,
} from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import { countAnswers, createAnswerBudget, type AnswerBudget } from './answer-budget.ts';

const MiB = 1024 * 1024;

/** An answer the budget let through, its release taken out. */
function sent(admission: ReturnType<AnswerBudget['admit']>): () => void {
  assert.ok(admission.sent, `refused for its ${admission.sent ? '' : admission.limit}`);

  return admission.release;
}

describe('the answers byte budget, without a server (#184)', () => {
  it('is 16 MiB an address and 64 MiB in all', () => {
    assert.equal(API_ANSWER_PER_ADDRESS_BYTES, 16 * MiB);
    assert.equal(API_ANSWER_BYTES, 64 * MiB);

    const budget = createAnswerBudget();

    assert.equal(budget.perAddress, 16 * MiB);
    assert.equal(budget.total, 64 * MiB);
  });

  it('refuses the next answer of an address that would pass its 16 MiB, to the byte, and lets another address in', () => {
    const budget = createAnswerBudget();
    const held = [sent(budget.admit('a', 10 * MiB)), sent(budget.admit('a', 6 * MiB - 1))];

    assert.equal(budget.bytesOf('a'), 16 * MiB - 1);

    // Exactly to the limit passes; one byte past it does not.
    assert.deepEqual(budget.admit('a', 2), { sent: false, limit: 'address' });
    held.push(sent(budget.admit('a', 1)));
    assert.equal(budget.bytesOf('a'), 16 * MiB);
    assert.deepEqual(budget.admit('a', 1), { sent: false, limit: 'address' });
    assert.equal(budget.answersOf('a'), 3);

    // A refusal counted nothing.
    assert.equal(budget.bytes, 16 * MiB);

    // Another address is unaffected.
    held.push(sent(budget.admit('b', 8 * MiB)));
    assert.equal(budget.bytesOf('b'), 8 * MiB);

    // Bytes given back let the next of `a` in.
    held[1]?.();
    assert.equal(budget.bytesOf('a'), 10 * MiB + 1);
    held.push(sent(budget.admit('a', 6 * MiB - 1)));
    assert.equal(budget.bytesOf('a'), 16 * MiB);

    for (const release of held) {
      release();
    }

    assert.equal(budget.bytes, 0);
    assert.equal(budget.answers, 0);
    assert.equal(budget.keys, 0);
  });

  it('refuses the next answer of an address with one counted once the server would pass its 64 MiB', () => {
    const budget = createAnswerBudget();
    const held = ['a', 'b', 'c', 'd'].map((key) => sent(budget.admit(key, 16 * MiB)));

    assert.equal(budget.bytes, 64 * MiB);

    // `a` and `e` each have an answer counted: within their own 16 MiB, past the server's.
    held.push(sent(budget.admit('e', 1)));
    assert.deepEqual(budget.admit('e', 1), { sent: false, limit: 'server' });

    // An address's own limit is named first when both are passed.
    assert.deepEqual(budget.admit('a', 1), { sent: false, limit: 'address' });

    held[0]?.();
    held.push(sent(budget.admit('e', 16 * MiB - 1)));
    assert.equal(budget.bytes, 64 * MiB);
    assert.deepEqual(budget.admit('e', 1), { sent: false, limit: 'address' });

    for (const release of held) {
      release();
    }

    assert.equal(budget.bytes, 0);
    assert.equal(budget.keys, 0);
  });

  it("sends an address's first answer whatever its size and whatever the server holds", () => {
    const budget = createAnswerBudget(4 * MiB, 8 * MiB);

    // Larger than the address's bytes and the server's together.
    const huge = sent(budget.admit('a', 100 * MiB));

    assert.equal(budget.bytesOf('a'), 100 * MiB);
    assert.deepEqual(budget.admit('a', 1), { sent: false, limit: 'address' });

    // Every other address's first is still sent, its second not.
    const others = Array.from({ length: 10 }, (_unused, index) =>
      sent(budget.admit(`k${index}`, 2 * MiB)),
    );

    assert.equal(budget.bytes, 120 * MiB);
    assert.deepEqual(budget.admit('k0', 1), { sent: false, limit: 'server' });

    // An empty answer is an answer too: the address has one counted.
    const empty = sent(budget.admit('z', 0));

    assert.equal(budget.answersOf('z'), 1);
    assert.deepEqual(budget.admit('z', 1), { sent: false, limit: 'server' });

    huge();
    empty();

    for (const release of others) {
      release();
    }

    assert.equal(budget.bytes, 0);
    assert.equal(budget.keys, 0);

    // With nothing counted, the first is sent again.
    sent(budget.admit('a', 100 * MiB))();
  });

  it('gives bytes back once, however often and in whatever order they are given back', () => {
    const budget = createAnswerBudget(10, 100);
    const first = sent(budget.admit('a', 4));
    const second = sent(budget.admit('a', 4));

    first();
    first();
    first();
    assert.equal(budget.bytesOf('a'), 4);
    assert.equal(budget.answersOf('a'), 1);
    assert.equal(budget.bytes, 4);

    second();
    second();
    assert.equal(budget.bytesOf('a'), 0);
    assert.equal(budget.keys, 0);

    // A release of a key gone does not bring it back or go below nothing.
    first();
    assert.equal(budget.keys, 0);
    assert.equal(budget.bytes, 0);
    assert.equal(budget.answers, 0);
  });

  it('counts a refusal whatever the budget holds, and never refuses it', () => {
    const budget = createAnswerBudget(10, 20);
    const full = sent(budget.admit('a', 10));

    assert.equal(budget.admit('a', 1).sent, false);

    const refusal = budget.count('a', 150);

    assert.equal(budget.bytesOf('a'), 160);
    assert.equal(budget.answersOf('a'), 2);

    // Counted beyond the server's bytes too.
    const other = budget.count('b', 1_000);

    assert.equal(budget.bytes, 1_160);

    refusal();
    refusal();
    other();
    full();
    assert.equal(budget.bytes, 0);
    assert.equal(budget.keys, 0);
  });

  it('refuses a size that is not a whole, non-negative number of bytes', () => {
    const budget = createAnswerBudget();

    for (const size of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      assert.throws(() => budget.admit('a', size), RangeError, String(size));
      assert.throws(() => budget.count('a', size), RangeError, String(size));
    }

    assert.equal(budget.keys, 0);
  });

  it('refuses 100,000 answers of one full address quickly, and keeps nothing of 100,000 addresses once they are given back', () => {
    const budget = createAnswerBudget();
    const full = sent(budget.admit('flood', 16 * MiB));
    const started = performance.now();

    for (let index = 0; index < 100_000; index += 1) {
      assert.equal(budget.admit('flood', 1).sent, false);
    }

    assert.ok(performance.now() - started < 5_000, 'refusing the flood took too long');
    assert.equal(budget.answersOf('flood'), 1);
    sent(budget.admit('other', 1))();

    const many = Array.from({ length: 100_000 }, (_unused, index) =>
      sent(budget.admit(`2001:db8:${index.toString(16)}::/64`, 1_000)),
    );

    assert.equal(budget.keys, 100_001);
    assert.equal(budget.bytes, 16 * MiB + 100_000_000);

    // Past the server's 64 MiB, each with one counted: the next of any is refused.
    assert.deepEqual(budget.admit('2001:db8:0::/64', 1), { sent: false, limit: 'server' });

    for (const release of many.reverse()) {
      release();
    }

    full();
    assert.equal(budget.keys, 0);
    assert.equal(budget.bytes, 0);
    assert.equal(budget.answers, 0);
  });
});

// The hook, over real sockets. `/api/...` is a call; anything else is not.

const listeners: FastifyInstance[] = [];
const sockets: net.Socket[] = [];

after(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }

  await Promise.all(listeners.map((listener) => listener.close()));
});

interface Listener {
  port: number;
  budget: AnswerBudget;
  /** Lets every `/api/hold` answer: what keeps a connection's later answers queued. */
  releaseHolds: () => void;
}

/** Every width of UTF-8, a lone surrogate's replacement aside, and what JSON escapes. */
const MIXED_TEXT = 'ascii Ответ 中文 😀 "quoted" \\ \u0001\n'.repeat(20_000);

/** A body of `bytes` bytes of JSON: a string of `bytes - 2` characters. */
function jsonOf(bytes: number): string {
  return JSON.stringify('x'.repeat(bytes - 2));
}

async function listen(
  budget: AnswerBudget,
  options: {
    connectionTimeout?: number;
    laterHookThrows?: boolean;
    /** Each payload a later `onSend` hook is given: what goes on to the connection. */
    seen?: unknown[];
  } = {},
): Promise<Listener> {
  const app = Fastify({ connectionTimeout: options.connectionTimeout ?? 0 });
  let holds: (() => void)[] = [];
  let released = false;

  // As the application listener's error handler answers an `AppError`.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .headers(error.headers)
        .send({ errorCode: error.errorCode, message: error.message });
    }

    return reply.status(500).send({ errorCode: 1500, message: 'Internal error' });
  });

  countAnswers(
    app,
    budget,
    (request) => request.url.startsWith('/api/'),
    (request) => String(request.headers['x-address'] ?? 'a'),
  );

  if (options.laterHookThrows === true) {
    app.addHook('onSend', async (request, reply) => {
      if (reply.statusCode < 400 && request.headers['x-later-throws'] !== undefined) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 500, 'a later hook failed');
      }
    });
  }

  app.get<{ Params: { bytes: string } }>('/api/big/:bytes', async (request, reply) =>
    reply.type('application/json').send(jsonOf(Number(request.params.bytes))),
  );
  if (options.seen !== undefined) {
    const seen = options.seen;

    app.addHook('onSend', async (_request, _reply, payload) => {
      seen.push(payload);
    });
  }

  // Text of one, two, three and four bytes a character, and characters JSON escapes.
  app.get('/api/text', async (_request, reply) =>
    reply.type('application/json; charset=utf-8').send(JSON.stringify(MIXED_TEXT)),
  );
  app.get<{ Params: { bytes: string } }>('/elsewhere/:bytes', async (request, reply) =>
    reply.type('application/json').send(jsonOf(Number(request.params.bytes))),
  );
  app.get('/api/stream', async (_request, reply) =>
    reply
      .type('application/json')
      .send(Readable.from([Buffer.from('"'), Buffer.alloc(100_000, 120), Buffer.from('"')])),
  );
  app.get('/api/empty', async (_request, reply) => reply.status(204).send());
  app.get('/api/missing', async () => {
    throw new AppError(ErrorCode.SESSION_NOT_FOUND, 404, 'Session not found');
  });
  app.get('/api/hold', async (_request, reply) => {
    if (!released) {
      await new Promise<void>((resolve) => holds.push(resolve));
    }

    return reply.type('application/json').send('{"held":true}');
  });

  listeners.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });

  return {
    port: (app.server.address() as net.AddressInfo).port,
    budget,
    releaseHolds: () => {
      released = true;

      for (const resolve of holds) {
        resolve();
      }

      holds = [];
    },
  };
}

function head(method: string, path: string, extra = ''): string {
  return `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${extra}\r\n`;
}

/** A connection that sends `text` and keeps every byte it is answered. */
async function connection(
  port: number,
  text: string,
): Promise<{ socket: net.Socket; read: () => Buffer }> {
  const socket = net.connect(port, '127.0.0.1');
  const chunks: Buffer[] = [];

  sockets.push(socket);
  socket.on('error', () => undefined);
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  await once(socket, 'connect');
  socket.write(text);

  return { socket, read: () => Buffer.concat(chunks) };
}

interface Raw {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The answers of a connection, in order, each with a `Content-Length`. */
function answersIn(bytes: Buffer): Raw[] {
  const answers: Raw[] = [];
  let at = 0;

  while (at < bytes.length) {
    const end = bytes.indexOf('\r\n\r\n', at);

    if (end === -1) {
      break;
    }

    const lines = bytes.subarray(at, end).toString('latin1').split('\r\n');
    const headers: Record<string, string> = {};

    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':');

      headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }

    const length = Number(headers['content-length'] ?? 0);

    answers.push({
      status: Number(lines[0]?.split(' ')[1]),
      headers,
      body: bytes.subarray(end + 4, end + 4 + length).toString('utf8'),
    });
    at = end + 4 + length;
  }

  return answers;
}

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = performance.now() + ms;

  while (!check()) {
    if (performance.now() > deadline) {
      assert.fail(`timed out waiting until ${what}`);
    }

    await delay(5);
  }
}

describe('the answers byte budget on a listener (#184)', () => {
  it('counts an answer from its serialization until its response closes, held while it waits behind another', async () => {
    const { port, budget, releaseHolds } = await listen(createAnswerBudget(1 * MiB, 4 * MiB));
    const { socket, read } = await connection(
      port,
      head('GET', '/api/hold') + head('GET', '/api/big/300000') + head('GET', '/api/big/200000'),
    );

    // The two answers are serialized and queued behind the held one, unwritten.
    await until(() => budget.answersOf('a') === 2, 'both answers are counted');
    assert.equal(budget.bytesOf('a'), 500_000);
    await delay(200);
    assert.equal(budget.bytesOf('a'), 500_000, 'given back before it was written');

    releaseHolds();
    await until(() => budget.keys === 0, 'every answer has been written');

    const answers = answersIn(read());

    await until(() => answersIn(read()).length === 3, 'the client has read all three');
    assert.deepEqual(
      answersIn(read()).map((answer) => [answer.status, Buffer.byteLength(answer.body)]),
      [
        [200, 13],
        [200, 300_000],
        [200, 200_000],
      ],
      `read so far ${answers.length}`,
    );
    assert.equal(budget.bytes, 0);
    socket.destroy();
  });

  it('refuses the answer that does not fit 429 / 1019 with Retry-After: 1, counts the refusal and never refuses it', async () => {
    const { port, budget, releaseHolds } = await listen(createAnswerBudget(600_000, 4 * MiB));
    const { socket, read } = await connection(
      port,
      head('GET', '/api/hold') +
        head('GET', '/api/big/400000') +
        head('GET', '/api/big/400000') +
        head('GET', '/api/missing'),
    );

    await until(() => budget.answersOf('a') === 3, 'an answer, a refusal and a 404 counted');

    // The first big answer, the refusal of the second and the 404, each counted.
    const refusalBytes = budget.bytesOf('a') - 400_000;

    assert.ok(refusalBytes > 0 && refusalBytes < 400, `${refusalBytes} bytes of refusals`);

    // Another address is unaffected.
    const other = await connection(
      port,
      head('GET', '/api/big/400000', 'X-Address: b\r\nConnection: close\r\n'),
    );

    await once(other.socket, 'close');
    assert.equal(answersIn(other.read())[0]?.status, 200);
    assert.equal(budget.bytesOf('b'), 0);

    releaseHolds();
    await until(() => answersIn(read()).length === 4, 'the client has read all four');

    const [held, first, refused, missing] = answersIn(read());

    assert.equal(held?.status, 200);
    assert.equal(first?.status, 200);
    assert.equal(refused?.status, 429);
    assert.equal(refused?.headers['retry-after'], String(CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS));
    assert.match(refused?.headers['content-type'] ?? '', /^application\/json/);
    assert.deepEqual(JSON.parse(refused?.body ?? ''), {
      errorCode: ErrorCode.TOO_MANY_CONCURRENT_CALLS,
      message:
        'Too many answers not yet written: 600000 bytes at once per address; try again in a moment',
    });
    assert.equal(missing?.status, 404);
    await until(() => budget.keys === 0, 'everything has been given back');
    socket.destroy();
  });

  it('names the server when its bytes are what the answer would pass', async () => {
    const { port, budget, releaseHolds } = await listen(createAnswerBudget(1 * MiB, 500_000));
    const a = await connection(port, head('GET', '/api/hold') + head('GET', '/api/big/400000'));

    await until(() => budget.answersOf('a') === 1, "a's answer is counted");

    const b = await connection(
      port,
      head('GET', '/api/hold', 'X-Address: b\r\n') +
        head('GET', '/api/big/50000', 'X-Address: b\r\n') +
        head('GET', '/api/big/100000', 'X-Address: b\r\n'),
    );

    // `b`'s first is sent; its second would pass the server's 500,000 bytes.
    await until(() => budget.answersOf('b') === 2, "b's answer and refusal are counted");
    releaseHolds();
    await until(() => answersIn(b.read()).length === 3, "b's three are read");

    const refused = answersIn(b.read())[2];

    assert.equal(refused?.status, 429);
    assert.equal(
      (JSON.parse(refused?.body ?? '') as { message: string }).message,
      'Too many answers not yet written: 500000 bytes at once on the server; try again in a moment',
    );
    await until(() => budget.keys === 0, 'everything has been given back');
    a.socket.destroy();
    b.socket.destroy();
  });

  it('gives an answer back exactly once however its response ends', async () => {
    for (const ending of ['destroy', 'end', 'reset', 'timeout'] as const) {
      const { port, budget } = await listen(createAnswerBudget(1 * MiB, 4 * MiB), {
        connectionTimeout: ending === 'timeout' ? 300 : 0,
      });
      const { socket } = await connection(
        port,
        head('GET', '/api/hold') + head('GET', '/api/big/300000').repeat(2),
      );

      await until(() => budget.answersOf('a') === 2, `${ending}: both answers are counted`);

      if (ending === 'destroy') {
        socket.destroy();
      } else if (ending === 'end') {
        socket.end();
      } else if (ending === 'reset') {
        socket.resetAndDestroy();
      }

      // The server's own timeout ends a connection with nothing moving on it.
      await until(() => budget.keys === 0, `${ending}: the answers are given back`, 10_000);
      assert.equal(budget.bytes, 0, ending);
      assert.equal(budget.answers, 0, ending);
    }
  });

  it("counts nothing for an answer whose client left before it was ready, and gives the client's next answers their room", async () => {
    const { port, budget, releaseHolds } = await listen(createAnswerBudget(1 * MiB, 4 * MiB));
    const { socket } = await connection(port, head('GET', '/api/hold') + head('GET', '/api/hold'));

    await delay(100);
    socket.destroy();
    await delay(100);
    releaseHolds();
    await delay(100);
    assert.equal(budget.keys, 0);
    assert.equal(budget.bytes, 0);
  });

  it('counts nothing for a HEAD, a stream, an empty answer or a path that is not a call', async () => {
    const { port, budget, releaseHolds } = await listen(createAnswerBudget(1 * MiB, 4 * MiB));
    const { socket, read } = await connection(
      port,
      head('GET', '/api/hold') +
        head('HEAD', '/api/big/300000') +
        head('GET', '/api/stream') +
        head('GET', '/api/empty') +
        head('GET', '/elsewhere/300000'),
    );

    await delay(300);
    assert.equal(budget.keys, 0, 'something was counted');
    releaseHolds();
    await until(() => read().includes('204 No Content'), 'the answers are read');
    assert.equal(budget.keys, 0);
    socket.destroy();
  });

  it('hands a counted answer on as its exact UTF-8 bytes, which the client reads whole', async () => {
    const seen: unknown[] = [];
    const { port, budget } = await listen(createAnswerBudget(4 * MiB, 8 * MiB), { seen });
    const expected = Buffer.from(JSON.stringify(MIXED_TEXT), 'utf8');
    const { socket, read } = await connection(
      port,
      head('GET', '/api/text') + head('GET', '/elsewhere/1000'),
    );

    await until(() => answersIn(read()).length === 2, 'both are read');

    const [text, elsewhere] = answersIn(read());

    assert.equal(text?.status, 200);
    assert.equal(text?.headers['content-length'], String(expected.length));
    assert.equal(text?.body, JSON.stringify(MIXED_TEXT));
    assert.equal(JSON.parse(text?.body ?? '""'), MIXED_TEXT);

    // Bytes for the counted answer, the string left as it was for the one not counted.
    assert.ok(Buffer.isBuffer(seen[0]), 'the counted answer went on as a string');
    assert.ok((seen[0] as Buffer).equals(expected));
    assert.equal(typeof seen[1], 'string');
    assert.equal(elsewhere?.status, 200);
    await until(() => budget.keys === 0, 'everything has been given back');
    socket.destroy();
  });

  it('gives back an answer a later hook replaced, as the replacement is counted', async () => {
    const { port, budget, releaseHolds } = await listen(createAnswerBudget(1 * MiB, 4 * MiB), {
      laterHookThrows: true,
    });
    const { socket, read } = await connection(
      port,
      head('GET', '/api/hold') + head('GET', '/api/big/300000', 'X-Later-Throws: 1\r\n'),
    );

    await until(() => budget.answersOf('a') === 1, 'the replacement is counted');
    assert.ok(
      budget.bytesOf('a') < 100,
      `${budget.bytesOf('a')} bytes: the replaced answer is still counted`,
    );
    releaseHolds();
    await until(() => answersIn(read()).length === 2, 'both are read');
    assert.equal(answersIn(read())[1]?.status, 500);
    await until(() => budget.keys === 0, 'everything has been given back');
    socket.destroy();
  });
});
