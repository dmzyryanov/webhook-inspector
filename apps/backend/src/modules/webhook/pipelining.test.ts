/**
 * The bound on what one connection to the receive listener pipelines
 * (#181, D229), over real sockets: a connection never has more than
 * `MAX_PIPELINED_REQUESTS` requests read and not yet answered, whatever it
 * sends and however it sends it, and every request it pipelined is still
 * answered, in order, and captured. With PROXY protocol on and off.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 *
 * What a connection has read and not answered is counted here on Node's own
 * `http.server.request.start` and `http.server.response.finish` channels,
 * apart from the bound's own count, from the moment Node's parser reads a
 * request's head - the ones Node answers itself included - to the moment its
 * whole answer has been handed to the connection. A test finds its
 * connection's count by both of its ports, the client's and the receiver's,
 * the latest count first: the kernel gives a client's connection to one
 * receiver the port an earlier connection to another had (#383). A case of
 * its own holds that match on counts made by hand, no socket connected: a
 * match by either port alone, or the first count in place of the latest,
 * fails it (#414).
 *
 * A client that reads none of its answers pipelines more of them than the
 * kernel can take whole, by the machine's own `net.ipv4.tcp_wmem` and
 * `net.ipv4.tcp_rmem`, and the case checks the bound only once the kernel
 * takes no more of them, failing if it never stops (#383).
 *
 * Node's parser itself is held where the bound relies on it: every request
 * head it counts ends in `LF CR LF` (`HEAD_END`), checked against random
 * pipelines; it makes no request of the HTTP/2 preface's `PRI` line, which
 * it holds and then refuses with `400`, a request after it included (#277);
 * and `sliceLength`, which
 * cuts a slice short of one head too many, and `nextSlice`, which waits for
 * an answer rather than parse a short slice while others are unanswered,
 * against hostile input of growing sizes.
 * Bytes dense in `LF CR LF` - bodies of nothing else, or of empty CRLF lines
 * - are captured whole, of declared length and chunked, across reads, and a
 * body of them behind 30 delayed requests is parsed in slices of 60 bytes or
 * more and kept unread in one piece a read, as Node keeps it. The bound's
 * stop is its own to start again only while nobody else has stopped the
 * connection since, and the capture budget's guard holds it stopped for a
 * waiting webhook (D210). A limit below 2 is refused, and a limit of 2
 * still reads on a body still arriving.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { readFileSync } from 'node:fs';
import http, { METHODS, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  MAX_PIPELINED_REQUESTS,
  MAX_REQUESTS_PER_SESSION,
  MAX_RESPONSE_BODY_BYTES,
  type ResponseConfig,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildReceiver, buildServer } from '../../server.ts';
import { connectionStops } from './capture-budget.ts';
import {
  boundPipelinedRequests,
  HEAD_END,
  MIN_SLICE_BYTES,
  nextSlice,
  holdStopped,
  sliceLength,
} from './pipelining.ts';
import { PROXY_V2_SIGNATURE } from './proxy-protocol.ts';
import { REQUEST_ID_HEADER } from './response.ts';

const LOOPBACK = '127.0.0.1';
const SENDER = '198.51.100.21';

let pool: pg.Pool;
let api: FastifyInstance;
/** PROXY protocol off, as locally. */
let plain: FastifyInstance;
/** PROXY protocol v2 on, the loopback trusted, as in production. */
let proxied: FastifyInstance;
/** PROXY protocol off, at most 2 requests read and unanswered, the least allowed. */
let pair: FastifyInstance;
const createdSessionIds: string[] = [];
const sockets: net.Socket[] = [];

/** What one receive connection has read and answered, counted from Node's channels. */
interface Count {
  /** Requests read and not answered. */
  now: number;
  /** The most `now` has been. */
  most: number;
  /** Requests whose whole answer has been handed to the connection. */
  answered: number;
  /** The port its client connected from, read while it is connected. */
  port: number | undefined;
  /** The receiver's port it connected to. */
  to: number | undefined;
  /** The receiver's side of the connection. */
  socket: net.Socket;
}

/** Each receive connection's count, in the order each began. */
const counts = new Map<net.Socket, Count>();
let receivers: Server[] = [];

const onStart = (message: unknown): void => {
  const { socket, server } = message as { socket: net.Socket; server: Server };

  if (!receivers.includes(server)) {
    return;
  }

  const count = counts.get(socket) ?? {
    now: 0,
    most: 0,
    answered: 0,
    port: socket.remotePort,
    to: socket.localPort,
    socket,
  };

  count.now += 1;
  count.most = Math.max(count.most, count.now);
  counts.set(socket, count);
};

const onFinish = (message: unknown): void => {
  const { socket } = message as { socket: net.Socket };
  const count = counts.get(socket);

  if (count !== undefined) {
    count.now -= 1;
    count.answered += 1;
  }
};

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    api = buildServer(pool);
    api.log.level = 'silent';
    await api.ready();
    plain = buildReceiver(pool);
    proxied = buildReceiver(pool, {
      trustedProxyCidrs: [`${LOOPBACK}/32`],
      proxyProtocol: 'v2',
    });
    pair = buildReceiver(pool, { pipelinedRequests: 2 });

    for (const receiver of [plain, proxied, pair]) {
      receiver.log.level = 'silent';
      await receiver.listen({ host: LOOPBACK, port: 0 });
    }

    receivers = [plain.server, proxied.server, pair.server];
    subscribe('http.server.request.start', onStart);
    subscribe('http.server.response.finish', onFinish);
  })();
  await startup;
});

after(async () => {
  await startup?.catch(() => undefined);
  unsubscribe('http.server.request.start', onStart);
  unsubscribe('http.server.response.finish', onFinish);

  for (const socket of sockets) {
    socket.destroy();
  }

  await Promise.all([plain, proxied, pair].map((receiver) => receiver?.close()));
  await api?.close();

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await pool?.end();
});

async function newSession(response?: Partial<ResponseConfig>): Promise<string> {
  const created = await api.inject({
    method: 'POST',
    url: '/api/sessions',
    ...(response === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ response }) }),
  });

  assert.equal(created.statusCode, 201, created.body);

  const { id } = created.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

/** A PROXY protocol v2 header for TCP over IPv4 naming `source`, as Traefik writes one. */
function proxyHeader(source: string): Buffer {
  const addresses = Buffer.concat([
    Buffer.from(source.split('.').map(Number)),
    Buffer.from([10, 42, 0, 24]),
    Buffer.from([0xc3, 0x50, 0x20, 0xfb]),
  ]);

  return Buffer.concat([
    PROXY_V2_SIGNATURE,
    Buffer.from([0x21, 0x11, 0, addresses.length]),
    addresses,
  ]);
}

function portOf(receiver: FastifyInstance): number {
  return (receiver.server.address() as AddressInfo).port;
}

/** One answer of a pipeline, as the client read it. */
interface Answer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

interface Pipeline {
  socket: net.Socket;
  answers: Answer[];
  closed: Promise<void>;
  /** The port the client connected from, once connected. */
  port: number | undefined;
  /** The receiver's port it connects to. */
  to: number;
}

/**
 * A connection to `receiver` that writes `bytes` at once - behind a PROXY
 * header for `proxied` - or in pieces cut at `cuts`, 30 ms apart, and reads
 * the answers as they come, each framed by its `Content-Length`; an answer
 * to a `HEAD` has no body, so the methods the pipeline sent, in order, tell
 * which.
 */
function pipeline(
  receiver: FastifyInstance,
  bytes: Buffer,
  {
    methods = [],
    read = true,
    cuts = [],
  }: { methods?: string[]; read?: boolean; cuts?: number[] } = {},
): Pipeline {
  const socket = net.connect(portOf(receiver), LOOPBACK);
  const answers: Answer[] = [];
  let buffered = Buffer.alloc(0);

  sockets.push(socket);
  socket.on('error', () => undefined);

  if (!read) {
    socket.pause();
  }

  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);

    for (;;) {
      const end = buffered.indexOf('\r\n\r\n');

      if (end === -1) {
        return;
      }

      const [statusLine = '', ...lines] = buffered
        .subarray(0, end)
        .toString('latin1')
        .split('\r\n');
      const headers: Record<string, string> = {};

      for (const line of lines) {
        const colon = line.indexOf(':');

        headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }

      const length =
        methods[answers.length] === 'HEAD' ? 0 : Number(headers['content-length'] ?? 0);

      if (buffered.length < end + 4 + length) {
        return;
      }

      answers.push({
        status: Number(statusLine.split(' ')[1]),
        headers,
        body: buffered.subarray(end + 4, end + 4 + length),
      });
      buffered = buffered.subarray(end + 4 + length);
    }
  });

  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));

  const sent: Pipeline = { socket, answers, closed, port: undefined, to: portOf(receiver) };

  socket.on('connect', () => {
    sent.port = socket.localPort;

    const header = receiver === proxied ? proxyHeader(SENDER) : Buffer.alloc(0);

    void (async () => {
      let from = 0;

      for (const cut of [...cuts, bytes.length]) {
        if (from > 0) {
          await delay(30);
        }

        if (!socket.destroyed) {
          socket.write(
            from === 0
              ? Buffer.concat([header, bytes.subarray(0, cut)])
              : bytes.subarray(from, cut),
          );
        }

        from = cut;
      }
    })();
  });

  return sent;
}

/**
 * The count of `sent`'s connection on the server's side: the latest whose
 * client port and receiver port are both `sent`'s. A client port alone is
 * not enough: the kernel gives a connection to one receiver the port of a
 * connection to another, open or closed, whose count is kept, as a
 * connection of the PROXY v2 suite may be given the port of one of the
 * PROXY-off suite's before it (#383; how often, `docs/testing/flakes.md`,
 * F-28). Two connections have the same pair of ports only once the first
 * has closed, so the latest is `sent`'s once its first request has been
 * read. The case `the count a case finds for its connection, by countOf`
 * holds this on counts made by hand: it fails for a match by the client port
 * alone or by the receiver port alone, for the first match in place of the
 * latest, and for a count given before `sent` connects.
 */
function countOf(sent: Pipeline): Count | undefined {
  let found: Count | undefined;

  for (const count of counts.values()) {
    if (sent.port !== undefined && count.port === sent.port && count.to === sent.to) {
      found = count;
    }
  }

  return found;
}

/** Waits, for at most `withinMs`, until `condition` holds. */
async function until(condition: () => boolean, what: string, withinMs = 20_000): Promise<void> {
  const deadline = Date.now() + withinMs;

  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
    await delay(10);
  }
}

/** The largest of `net.ipv4.<name>`'s three sizes, or `undefined` where it cannot be read. */
function largestTcpBuffer(name: 'tcp_wmem' | 'tcp_rmem'): number | undefined {
  try {
    const largest = Number(
      readFileSync(`/proc/sys/net/ipv4/${name}`, 'latin1').trim().split(/\s+/)[2],
    );

    return Number.isSafeInteger(largest) && largest > 0 ? largest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How many answers of `MAX_RESPONSE_BODY_BYTES` to pipeline for a client
 * that reads none of them, so that the kernel cannot take them whole: on the
 * loopback, the receiver's send buffer and the client's receive buffer hold
 * what the kernel takes, and Linux grows them at most to the largest size of
 * `net.ipv4.tcp_wmem` and of `net.ipv4.tcp_rmem`. As many answers as both
 * would hold of bodies alone, and twice `MAX_PIPELINED_REQUESTS` more, so
 * that more than the bound are still unanswered once the kernel takes no
 * more; 200 at least, as before #383, and 200 where the sizes cannot be read
 * (a kernel other than Linux), where `untilTakesNoMore` fails the case if
 * the kernel takes them all.
 *
 * Up to 4 MiB and 6 MiB by default, so 224 answers. How much the kernel
 * takes of them changes with the reordering the connection starts with, by
 * which Linux grows the receiver's send buffer up to that largest size: the
 * reordering Linux keeps for `127.0.0.1` in its TCP metrics. That earlier
 * connections raise it, so that what the kernel takes changes from run to
 * run, is inferred, not traced (F-28). On the agents' server 39 answers at
 * Linux's own 3, 63 at the 29 its metrics held, and with sizes of 16 MiB 119
 * at 29 and every one of 200, 252 of 576, at 300 (F-28).
 */
function unreadAnswerCount(): { count: number; sizes: string } {
  const wmem = largestTcpBuffer('tcp_wmem');
  const rmem = largestTcpBuffer('tcp_rmem');

  if (wmem === undefined || rmem === undefined) {
    return { count: 200, sizes: 'tcp_wmem and tcp_rmem unread' };
  }

  return {
    count: Math.max(
      200,
      Math.ceil((wmem + rmem) / MAX_RESPONSE_BODY_BYTES) + 2 * MAX_PIPELINED_REQUESTS,
    ),
    sizes: `tcp_wmem up to ${wmem} bytes, tcp_rmem up to ${rmem}`,
  };
}

/**
 * Waits until the kernel takes no more of `sent`'s answers: the receiver's
 * side of the connection holds a write the kernel has not taken at ten looks
 * in a row, no answer handed over between them. Between two looks the event
 * loop has polled the sockets, and a kernel with room takes a waiting write
 * as soon as it is polled, so a write still waiting ten looks later waits
 * for a client that reads.
 */
async function untilTakesNoMore(sent: Pipeline): Promise<void> {
  let looks = 0;
  let answered = -1;

  await until(() => {
    const count = countOf(sent);
    const waiting =
      count !== undefined && count.socket.writableLength > 0 && count.answered === answered;

    answered = count?.answered ?? -1;
    looks = waiting ? looks + 1 : 0;

    return looks >= 10;
  }, 'the kernel takes no more of its answers');
}

/** What a session stored, oldest first: method, query string and body digest. */
async function stored(
  sessionId: string,
): Promise<{ id: string; method: string; query: string; body: string }[]> {
  const result = await pool.query<{
    id: string;
    method: string;
    query_string: string;
    body: Buffer;
  }>(
    'SELECT id, method, query_string, body FROM requests WHERE session_id = $1 ORDER BY received_at, id',
    [sessionId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    method: row.method,
    query: row.query_string,
    body: createHash('sha256').update(row.body).digest('hex').slice(0, 16),
  }));
}

/**
 * `pick` of each request a session stored, in the order they were sent - by
 * their query, `n=0` first - rather than the order their concurrent handlers
 * stored them in.
 */
async function byQuery(
  sessionId: string,
  pick: (row: Awaited<ReturnType<typeof stored>>[number]) => string,
): Promise<string[]> {
  const rows = await stored(sessionId);

  return rows
    .map((row) => ({ index: Number(row.query.slice('n='.length)), value: pick(row) }))
    .sort((a, b) => a.index - b.index)
    .map((row) => row.value);
}

function digest(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/**
 * Asserts that each answer is the one to the request sent at its place:
 * `answers[i]` names, by its request id, the stored request whose query is
 * `n=i`.
 */
async function inOrder(sessionId: string, answers: Answer[], count: number): Promise<void> {
  const rows = await stored(sessionId);
  const queryOf = new Map(rows.map((row) => [row.id, row.query]));

  assert.equal(answers.length, count);
  assert.equal(rows.length, count);
  answers.forEach((answer, index) => {
    assert.equal(answer.status, 200, answer.body.toString());
    assert.equal(queryOf.get(answer.headers[REQUEST_ID_HEADER] ?? ''), `n=${index}`);
  });
}

const gets = (sessionId: string, count: number): Buffer =>
  Buffer.from(
    Array.from(
      { length: count },
      (_, index) => `GET /s/${sessionId}?n=${index} HTTP/1.1\r\nHost: h\r\n\r\n`,
    ).join(''),
    'latin1',
  );

/** Where `LF CR LF` ends in `bytes` (the index of its last byte), `previous` the two bytes before it. */
function headEnds(bytes: Buffer, previous: readonly [number, number] = [-1, -1]): number[] {
  const all = Buffer.concat([Buffer.from(previous.filter((byte) => byte >= 0)), bytes]);
  const shift = all.length - bytes.length;
  const ends: number[] = [];

  for (let at = all.indexOf(HEAD_END); at !== -1; at = all.indexOf(HEAD_END, at + 1)) {
    ends.push(at + HEAD_END.length - 1 - shift);
  }

  return ends;
}

/** A pseudo-random generator, seeded, so that a failure can be repeated. */
function random(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;

    return state / 0x7fffffff;
  };
}

/**
 * Cuts `bytes` into the slices the bound would give the parser with `free`
 * requests free at each cut, and asserts each: at least one byte, no more
 * than `free` heads ending in it, and cut just before the one that would end
 * one more when it is not the end of `bytes`.
 */
function cutAll(bytes: Buffer, free: number): number {
  let previous: [number, number] = [-1, -1];
  let slices = 0;

  for (let start = 0; start < bytes.length; slices += 1) {
    const length = sliceLength(bytes, start, free, previous);
    const slice = bytes.subarray(start, start + length);
    const ending = headEnds(slice, previous);

    assert.ok(length >= 1, `an empty slice at ${start}`);
    assert.ok(ending.length <= free, `${ending.length} heads end in a slice at ${start}`);

    if (start + length < bytes.length) {
      const longer = bytes.subarray(start, start + length + 1);

      assert.equal(
        headEnds(longer, previous).length,
        free + 1,
        `not cut as late as it may at ${start}`,
      );
    }

    previous =
      length >= 2
        ? [slice[length - 2] as number, slice[length - 1] as number]
        : [previous[1], slice[0] as number];
    start += length;
  }

  return slices;
}

describe('the count a case finds for its connection, by countOf (#383)', () => {
  it('is the latest kept from its client port to its receiver, never one from the same client port to another receiver or from another client port to the same one', () => {
    // Counts made by hand and kept in `counts`, as `onStart` keeps them;
    // nothing connects. Each is taken out again whatever the case finds.
    const port = 1;
    const [one, other] = [portOf(plain), portOf(proxied)];
    const made: net.Socket[] = [];
    const keep = (from: number | undefined, to: number): Count => {
      const socket = new net.Socket();
      const count: Count = { now: 0, most: 1, answered: 1, port: from, to, socket };

      made.push(socket);
      counts.set(socket, count);

      return count;
    };
    const sent = (from: number | undefined, to: number): Pipeline => ({
      socket: new net.Socket(),
      answers: [],
      closed: Promise.resolve(),
      port: from,
      to,
    });

    assert.ok(
      ![...counts.values()].some((count) => count.port === port),
      `a connection of the file’s came from port ${port}`,
    );

    try {
      const first = keep(port, one);

      assert.equal(
        countOf(sent(port, other)),
        undefined,
        'given the count of a connection from its client port to another receiver',
      );
      assert.equal(countOf(sent(port, one)), first, 'not given the count of its own connection');

      const latest = keep(port, one);
      const others = keep(port, other);

      // Kept after `latest`, from another client port to the same receiver:
      // a match by receiver port alone would be given this one.
      keep(port + 1, one);

      assert.equal(
        countOf(sent(port, one)),
        latest,
        'not given the latest count from its client port to its receiver',
      );
      assert.equal(countOf(sent(port, other)), others, 'not given the other receiver’s own');

      keep(undefined, one);
      assert.equal(countOf(sent(undefined, one)), undefined, 'given a count before it connects');
    } finally {
      for (const socket of made) {
        counts.delete(socket);
      }
    }
  });
});

describe('the slices Node’s parser is given (D229)', () => {
  it('end before the head that would be one too many, and take the rest when there is none', () => {
    const get = Buffer.from('GET /s/x HTTP/1.1\r\nHost: h\r\n\r\n', 'latin1');
    const three = Buffer.concat([get, get, get]);

    assert.equal(sliceLength(three, 0, 3, [-1, -1]), three.length);
    assert.equal(sliceLength(three, 0, 2, [-1, -1]), 2 * get.length + get.length - 1);
    assert.equal(sliceLength(three, 0, 1, [-1, -1]), get.length + get.length - 1);
    assert.equal(sliceLength(three, get.length, 1, [0x0d, 0x0a]), 2 * get.length - 1);

    const body = Buffer.alloc(1_000_000, 0x61);

    assert.equal(sliceLength(body, 0, 1, [-1, -1]), body.length, 'a body without a head end');
  });

  it('count a head that ends in the first two bytes, its LF CR or its LF given before', () => {
    const rest = Buffer.from('\nGET / HTTP/1.1\r\nHost: h\r\n\r\nGET', 'latin1');

    // `LF CR` given, `LF` first: one head ends at byte 0, the next later.
    assert.equal(sliceLength(rest, 0, 1, [0x0a, 0x0d]), rest.lastIndexOf('GET') - 1);

    const crlf = Buffer.from('\r\nGET / HTTP/1.1\r\nHost: h\r\n\r\nGET', 'latin1');

    // `LF` given, `CR LF` first: one head ends at byte 1.
    assert.equal(sliceLength(crlf, 0, 1, [-1, 0x0a]), crlf.lastIndexOf('GET') - 1);
  });

  for (const size of [1_024, 65_536, 1_048_576]) {
    it(`cut hostile input of ${size} bytes, every slice within the bound and none empty`, () => {
      const draw = random(size);
      const pieces = [
        '\n\r\n',
        '\r\n',
        '\n',
        '\r',
        'GET /\n\r\n',
        'GET / HTTP/1.1\r\n\r\n',
        'a',
        '\n\r\n\r\n',
      ];
      const shapes: Buffer[] = [
        Buffer.from('\n\r'.repeat(size / 2), 'latin1'),
        Buffer.from('GET /\n\r\n'.repeat(size / 8), 'latin1'),
        Buffer.alloc(size, 0x0a),
        Buffer.from(
          Array.from({ length: size / 4 }, () => pieces[Math.floor(draw() * pieces.length)]).join(
            '',
          ),
          'latin1',
        ).subarray(0, size),
        Buffer.from(Array.from({ length: size }, () => Math.floor(draw() * 256))),
      ];
      const started = Date.now();

      for (const shape of shapes) {
        for (const free of [1, 2, 31, 32]) {
          cutAll(shape, free);
        }
      }

      // A cut costs a search from its start, not from the read's: linear.
      assert.ok(Date.now() - started < 20_000, `${Date.now() - started} ms`);
    });
  }

  it('wait for an answer rather than give a slice cut shorter than MIN_SLICE_BYTES while more than one request is unanswered', () => {
    const limit = 32;
    const run = Buffer.from('\n\r\n'.repeat(1_000), 'latin1');
    const get = Buffer.from('GET /s/x HTTP/1.1\r\nHost: h\r\n\r\n', 'latin1');
    const gets = Buffer.concat(Array.from({ length: 8 }, () => get));

    assert.equal(nextSlice(run, 0, limit, limit, [-1, -1]), 0, 'at the count');
    assert.equal(nextSlice(run, 0, 2, limit, [-1, -1]), 0, 'short, with others unanswered');
    assert.equal(nextSlice(run, 0, 31, limit, [-1, -1]), 0, 'short, one free');
    // With one unanswered, the one that may still be arriving, or none: given.
    assert.equal(nextSlice(run, 0, 1, limit, [-1, -1]), sliceLength(run, 0, 31, [-1, -1]));
    assert.equal(nextSlice(run, 0, 0, limit, [-1, -1]), sliceLength(run, 0, 32, [-1, -1]));
    // Short, but not cut - the end of the read: given.
    assert.equal(nextSlice(get, 0, 31, limit, [-1, -1]), get.length);
    // Two heads of 30 bytes and most of a third are short of 128 bytes; four are not.
    assert.equal(nextSlice(gets, 0, 30, limit, [-1, -1]), 0);
    assert.equal(nextSlice(gets, 0, 28, limit, [-1, -1]), 4 * get.length + get.length - 1);

    // With one free, two pipelined requests give a slice of both less one
    // byte: longer than 64 bytes each, it passes MIN_SLICE_BYTES; of 64, it
    // waits.
    const sized = (length: number): Buffer => {
      const head = (path: string) => `GET /${path} HTTP/1.1\r\nHost: h\r\n\r\n`;
      const bytes = Buffer.from(head('a'.repeat(length - head('').length)), 'latin1');

      assert.equal(bytes.length, length);

      return bytes;
    };
    const two = (length: number) => Buffer.concat([sized(length), sized(length)]);

    assert.equal(nextSlice(two(65), 0, limit - 1, limit, [-1, -1]), 65 + 64);
    assert.equal(nextSlice(two(64), 0, limit - 1, limit, [-1, -1]), 0);
  });

  for (const size of [1_024, 65_536, 1_048_576]) {
    it(`give hostile input of ${size} bytes in slices of 128 bytes or more while others are unanswered, and of 2 bytes a free request with one`, () => {
      const draw = random(size + 1);
      const limit = 32;
      const shapes: Buffer[] = [
        Buffer.from('\n\r\n'.repeat(Math.ceil(size / 3)), 'latin1').subarray(0, size),
        Buffer.from('\r\n'.repeat(size / 2), 'latin1'),
        Buffer.from('GET /\n\r\n'.repeat(size / 8), 'latin1'),
        Buffer.from(
          Array.from({ length: size }, () => ['\r', '\n', 'G', ' '][Math.floor(draw() * 4)]).join(
            '',
          ),
          'latin1',
        ),
        Buffer.from(Array.from({ length: size }, () => Math.floor(draw() * 256))),
      ];

      for (const shape of shapes) {
        for (const unfinished of [0, 1, 2, 16, 31]) {
          let previous: [number, number] = [-1, -1];
          let calls = 0;

          for (let start = 0; start < shape.length; calls += 1) {
            const length = nextSlice(shape, start, unfinished, limit, previous);

            if (length === 0) {
              // Waits: never with only the request that may still be arriving.
              assert.ok(unfinished > 1, `waited at ${start} with ${unfinished} unanswered`);

              break;
            }

            if (start + length < shape.length) {
              const least = unfinished > 1 ? MIN_SLICE_BYTES : 2 * (limit - unfinished);

              assert.ok(length >= least, `${length} bytes at ${start}, ${unfinished} unanswered`);
            }

            previous =
              length >= 2
                ? [shape[start + length - 2] as number, shape[start + length - 1] as number]
                : [previous[1], shape[start] as number];
            start += length;
          }

          if (unfinished <= 1) {
            // One call into the parser for every 62 bytes or more.
            assert.ok(calls <= Math.ceil(shape.length / 62) + 1, `${calls} slices`);
          }
        }
      }
    });
  }

  it('need a limit of at least 2: a connection whose one unanswered request is still arriving is read on', () => {
    const log = { error: () => undefined } as unknown as FastifyBaseLogger;

    for (const limit of [0, 1, 1.5, -2, Number.NaN]) {
      assert.throws(
        () => boundPipelinedRequests(http.createServer(), { limit, log }),
        /a limit of at least 2/,
        String(limit),
      );
    }

    assert.doesNotThrow(() => boundPipelinedRequests(http.createServer(), { limit: 2, log }));
  });

  it('rest on every request head Node’s parser counts ending in LF CR LF', async () => {
    let started = 0;
    const count = (): void => {
      started += 1;
    };
    const server = http.createServer((_request, response) => response.end());

    server.maxHeadersCount = 0;
    subscribe('http.server.request.start', count);
    await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));

    // How many requests Node's parser counts in `text`, sent whole and then ended.
    const counted = async (text: string): Promise<number> => {
      started = 0;

      await new Promise<void>((resolve) => {
        const socket = net.connect((server.address() as AddressInfo).port, LOOPBACK, () =>
          socket.end(text),
        );

        socket.on('error', () => undefined);
        socket.on('data', () => undefined);
        socket.on('close', () => resolve());
      });

      return started;
    };

    try {
      assert.equal(await counted('GET /\n\r\n'), 1, 'the shortest head Node counts');
      assert.equal(await counted('GET / HTTP/1.1\r\n\r\n'), 1, 'the shortest HTTP/1.1 head');

      // No other ending of a head counts.
      for (const ending of ['\n\n', '\r\n', '\n\r', '\r\r', '\r\n\n', '\r\r\n', '\n', '\r']) {
        assert.equal(await counted(`GET /${ending}`), 0, JSON.stringify(ending));
        assert.equal(await counted(`GET / HTTP/1.1${ending}`), 0, JSON.stringify(ending));
      }

      // Random pipelines, well formed and corrupted: never more requests
      // than `LF CR LF`s in them.
      const draw = random(181);
      const tokens = [
        'GET',
        'POST',
        'ACL',
        ' ',
        '/',
        '/s/x',
        '*',
        'HTTP/1.1',
        'HTTP/1.0',
        'HTTP/0.9',
        '\r\n',
        '\n',
        '\r',
        '\n\r\n',
        'Host: a',
        'a:',
        ' b',
        '\t',
        'Connection: keep-alive',
        'Transfer-Encoding: chunked',
        'Content-Length: 3',
        'abc',
        '0',
        ':',
      ];
      const pick = (): string => tokens[Math.floor(draw() * tokens.length)] as string;
      let withRequests = 0;

      for (let index = 0; index < 600; index += 1) {
        let text = '';

        for (let request = 1 + Math.floor(draw() * 5); request > 0; request -= 1) {
          if (draw() < 0.7) {
            text += `${draw() < 0.5 ? 'GET' : 'POST'} ${draw() < 0.5 ? '/' : '/s/x'}`;
            text += draw() < 0.15 ? '' : ` HTTP/1.${draw() < 0.8 ? 1 : 0}`;
            text += draw() < 0.2 ? '\n' : '\r\n';

            for (let line = Math.floor(draw() * 4); line > 0; line -= 1) {
              text += pick() + (draw() < 0.15 ? '\n' : '\r\n');
            }

            text += draw() < 0.8 ? '\r\n' : pick();
          } else {
            for (let token = 1 + Math.floor(draw() * 8); token > 0; token -= 1) {
              text += pick();
            }
          }
        }

        const requests = await counted(text);

        withRequests += requests > 0 ? 1 : 0;
        assert.ok(
          requests <= headEnds(Buffer.from(text, 'latin1')).length,
          `${requests} requests in ${JSON.stringify(text)}`,
        );
      }

      assert.ok(withRequests > 50, `only ${withRequests} of the pipelines had a request`);
    } finally {
      unsubscribe('http.server.request.start', count);
      server.close();
    }
  });

  it('rest on Node’s parser making no request of the HTTP/2 preface’s PRI line: it holds the head, then answers 400 whatever follows, a request included (#277)', async () => {
    let started = 0;
    const count = (): void => {
      started += 1;
    };
    const server = http.createServer((_request, response) => response.end());

    server.maxHeadersCount = 0;
    subscribe('http.server.request.start', count);
    await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));

    try {
      for (const [head, after] of [
        ['PRI * HTTP/2.0\r\n\r\n', 'SM\r\n\r\n'],
        ['PRI * HTTP/2.0\r\n\r\n', 'X'],
        ['PRI / HTTP/1.1\r\n\r\n', 'X'],
        // The bound reads on uncounted behind such a head: no request, and
        // so no header line, can come after it.
        ['PRI * HTTP/2.0\r\n\r\n', 'GET / HTTP/1.1\r\nHost: h\r\n\r\n'],
        ['PRI / HTTP/1.1\r\n\r\n', 'GET / HTTP/1.1\r\nHost: h\r\n\r\n'],
        // Nor after the whole preface: Node's parser does not take HTTP/1.1
        // up again once the rest of the preface has come (#288).
        ['PRI * HTTP/2.0\r\n\r\n', 'SM\r\n\r\nGET / HTTP/1.1\r\nHost: h\r\n\r\n'],
        ['PRI / HTTP/1.1\r\n\r\n', 'SM\r\n\r\nGET / HTTP/1.1\r\nHost: h\r\n\r\n'],
      ] as const) {
        const what = JSON.stringify(head + after);
        let received = '';
        let closed = false;

        started = 0;

        const socket = net.connect((server.address() as AddressInfo).port, LOOPBACK);

        socket.on('error', () => undefined);
        socket.on('data', (chunk: Buffer) => {
          received += chunk.toString('latin1');
        });

        const close = new Promise<void>((resolve) =>
          socket.on('close', () => {
            closed = true;
            resolve();
          }),
        );

        socket.write(head);
        // The head alone: held, neither a request nor an answer.
        await delay(150);
        assert.equal(started, 0, `${what}: a request of the head alone`);
        assert.equal(received, '', `${what}: an answer to the head alone`);
        assert.equal(closed, false, `${what}: closed after the head alone`);
        socket.write(after);
        await close;
        assert.equal(started, 0, `${what}: a request`);
        assert.equal(received, 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n', what);
      }

      // The whole preface in one write, as a sender with prior knowledge sends it.
      started = 0;

      const answer = await new Promise<string>((resolve) => {
        let received = '';
        const socket = net.connect((server.address() as AddressInfo).port, LOOPBACK, () =>
          socket.write('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'),
        );

        socket.on('error', () => undefined);
        socket.on('data', (chunk: Buffer) => {
          received += chunk.toString('latin1');
        });
        socket.on('close', () => resolve(received));
      });

      assert.equal(started, 0, 'a request of the whole preface');
      assert.equal(answer, 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } finally {
      unsubscribe('http.server.request.start', count);
      server.close();
    }
  });
});

for (const [name, receiver] of [
  ['PROXY protocol off', () => plain],
  ['PROXY protocol v2', () => proxied],
] as const) {
  describe(`a connection that pipelines, ${name} (D229)`, () => {
    it(`has at most ${MAX_PIPELINED_REQUESTS} requests read and unanswered, and gets all 300 of its GETs answered in order`, async () => {
      const sessionId = await newSession({ status: 200, body: 'held', delayMs: 200 });
      const sent = pipeline(receiver(), gets(sessionId, 300));

      await until(() => sent.answers.length === 300, 'all 300 are answered');

      const count = countOf(sent);

      assert.ok(count !== undefined, 'the connection was counted');
      assert.ok(count.most <= MAX_PIPELINED_REQUESTS, `${count.most} read and unanswered at once`);
      assert.ok(
        count.most > MAX_PIPELINED_REQUESTS / 2,
        `only ${count.most}: no pipelining at all`,
      );
      await inOrder(sessionId, sent.answers, 300);
    });

    it('captures every body of a pipeline whole, of declared length and chunked, letters and bytes dense in LF CR LF, behind delayed answers and across reads', async () => {
      const sessionId = await newSession({ status: 200, body: 'held', delayMs: 50 });
      // Letters; `LF CR LF` and nothing else; empty CRLF lines, an end of
      // a head every two bytes; and the two mixed with letters.
      const kinds = [
        (length: number, index: number) => Buffer.alloc(length, 0x41 + (index % 26)),
        (length: number) => Buffer.from('\n\r\n'.repeat(length), 'latin1').subarray(0, length),
        (length: number) => Buffer.from('\r\n'.repeat(length), 'latin1').subarray(0, length),
        (length: number) =>
          Buffer.from('a\n\r\nbc\r\n\r\n'.repeat(length), 'latin1').subarray(0, length),
      ];
      // Two of them span reads of 64 KiB: one of declared length, one chunked.
      const lengthOf = (index: number): number =>
        index === 21 ? 150_000 : index === 26 ? 100_000 : 1 + ((index * 7_919) % 20_000);
      const bodies = Array.from({ length: 48 }, (_, index) =>
        (kinds[index % kinds.length] as (length: number, index: number) => Buffer)(
          lengthOf(index),
          index,
        ),
      );
      const requests = bodies.map((body, index) => {
        const head = `POST /s/${sessionId}?n=${index} HTTP/1.1\r\nHost: h\r\nContent-Type: application/octet-stream\r\n`;

        if (index % 3 === 2) {
          // Chunked, in pieces of 1,000 bytes.
          const pieces: Buffer[] = [
            Buffer.from(`${head}Transfer-Encoding: chunked\r\n\r\n`, 'latin1'),
          ];

          for (let at = 0; at < body.length; at += 1_000) {
            const piece = body.subarray(at, at + 1_000);

            pieces.push(
              Buffer.from(`${piece.length.toString(16)}\r\n`, 'latin1'),
              piece,
              Buffer.from('\r\n'),
            );
          }

          pieces.push(Buffer.from('0\r\n\r\n'));

          return Buffer.concat(pieces);
        }

        return Buffer.concat([
          Buffer.from(`${head}Content-Length: ${body.length}\r\n\r\n`, 'latin1'),
          body,
        ]);
      });

      // Every body dense in `LF CR LF` is cut inside, whatever is free.
      bodies.forEach((body, index) => {
        if (index % kinds.length !== 0 && body.length >= 200) {
          assert.ok(sliceLength(body, 0, MAX_PIPELINED_REQUESTS, [-1, -1]) < body.length);
        }
      });

      // The 150,000 bytes of `LF CR LF` are also written in three, cut
      // inside one `LF CR LF` after its LF and after its CR.
      const at =
        requests.slice(0, 21).reduce((sum, request) => sum + request.length, 0) +
        (requests[21] as Buffer).indexOf('\r\n\r\n') +
        4 +
        3 * 20_000 +
        1;
      const sent = pipeline(receiver(), Buffer.concat(requests), { cuts: [at, at + 1] });

      await until(() => sent.answers.length === bodies.length, 'every POST is answered');
      await inOrder(sessionId, sent.answers, bodies.length);
      assert.deepEqual(await byQuery(sessionId, (row) => row.body), bodies.map(digest));

      const most = countOf(sent)?.most ?? 0;

      assert.ok(most <= MAX_PIPELINED_REQUESTS, `${most} read and unanswered at once`);
      assert.ok(most > 1, 'no pipelining at all');
    });

    it('answers a pipeline of every method in order, each captured', async () => {
      const sessionId = await newSession();
      const methods = METHODS.filter((method) => method !== 'CONNECT');
      const bytes = Buffer.from(
        methods
          .map(
            (method, index) => `${method} /s/${sessionId}?n=${index} HTTP/1.1\r\nHost: h\r\n\r\n`,
          )
          .join(''),
        'latin1',
      );
      const sent = pipeline(receiver(), bytes, { methods });

      await until(() => sent.answers.length === methods.length, 'every method is answered');
      await inOrder(sessionId, sent.answers, methods.length);
      assert.deepEqual(await byQuery(sessionId, (row) => row.method), methods);
    });

    it(`holds at most ${MAX_PIPELINED_REQUESTS} of the requests Node answers itself, pipelined behind a delayed one`, async () => {
      const sessionId = await newSession({ status: 200, body: 'held', delayMs: 300 });
      // 18 bytes each, the shortest HTTP/1.1 request: Node answers each
      // `400` for its missing `Host`, never handing it to the application,
      // and ends the connection after the first of those answers.
      const bytes = Buffer.concat([
        gets(sessionId, 1),
        Buffer.from('GET / HTTP/1.1\r\n\r\n'.repeat(3_000), 'latin1'),
      ]);
      const sent = pipeline(receiver(), bytes);

      await sent.closed;

      const count = countOf(sent);

      assert.ok(count !== undefined, 'the connection was counted');
      assert.ok(count.most <= MAX_PIPELINED_REQUESTS, `${count.most} read and unanswered at once`);
      assert.equal(sent.answers[0]?.status, 200);
      assert.equal(sent.answers[1]?.status, 400);
    });

    it('holds at most the bound for a client that reads none of its answers, and delivers them all once it reads', async (t) => {
      const answerBody = 'r'.repeat(MAX_RESPONSE_BODY_BYTES);
      const { count: total, sizes } = unreadAnswerCount();

      assert.ok(
        total <= MAX_REQUESTS_PER_SESSION,
        `${total} answers to outgrow the kernel's buffers (${sizes}): more than a session keeps`,
      );

      const sessionId = await newSession({ status: 200, body: answerBody });
      const sent = pipeline(receiver(), gets(sessionId, total), { read: false });

      // What the kernel takes stays there, the client reading none of it.
      await untilTakesNoMore(sent);

      const count = countOf(sent);

      assert.ok(count !== undefined, 'the connection was counted');
      assert.ok(count.most <= MAX_PIPELINED_REQUESTS, `${count.most} read and unanswered at once`);
      assert.ok(
        total - count.answered > MAX_PIPELINED_REQUESTS,
        `the kernel took ${count.answered} of ${total} answers (${sizes}): too few left for the bound to hold back`,
      );
      t.diagnostic(`the kernel took ${count.answered} of ${total} answers (${sizes})`);

      sent.socket.resume();
      await until(() => sent.answers.length === total, `all ${total} are delivered`);
      await inOrder(sessionId, sent.answers, total);
      assert.ok(sent.answers.every((answer) => answer.body.toString() === answerBody));
      assert.ok(count.most <= MAX_PIPELINED_REQUESTS, `${count.most} read and unanswered at once`);
    });

    it('bounds a burst that comes after the connection has been used', async () => {
      const sessionId = await newSession({ status: 200, body: 'held', delayMs: 100 });
      const sent = pipeline(receiver(), gets(sessionId, 1));

      await until(() => sent.answers.length === 1, 'the first is answered');

      const rest = gets(sessionId, 151).subarray(gets(sessionId, 1).length);

      sent.socket.write(rest);
      await until(() => sent.answers.length === 151, 'the burst is answered');

      const count = countOf(sent);

      assert.ok(
        count !== undefined && count.most <= MAX_PIPELINED_REQUESTS,
        `${count?.most} at once`,
      );
      await inOrder(sessionId, sent.answers, 151);
    });

    it('lets a connection that closes in the middle of its pipeline go, and keeps answering others', async () => {
      const sessionId = await newSession({ status: 200, body: 'held', delayMs: 2_000 });
      const sent = pipeline(receiver(), gets(sessionId, 2_000));

      await until(() => (countOf(sent)?.most ?? 0) > 0, 'its first requests are read');
      sent.socket.destroy();
      await delay(200);

      const next = pipeline(receiver(), gets(await newSession(), 3));

      await until(() => next.answers.length === 3, 'another connection is answered');
      assert.ok(next.answers.every((answer) => answer.status === 200));
    });

    it('closes a connection whose pipeline carries a CONNECT, as before, and answers the next', async () => {
      const sessionId = await newSession();
      const bytes = Buffer.concat([
        gets(sessionId, 1),
        Buffer.from('CONNECT h:443 HTTP/1.1\r\nHost: h:443\r\n\r\n', 'latin1'),
        gets(sessionId, 2).subarray(gets(sessionId, 1).length),
      ]);
      const sent = pipeline(receiver(), bytes);

      await sent.closed;

      const next = pipeline(receiver(), gets(await newSession(), 1));

      await until(() => next.answers.length === 1, 'another connection is answered');
      assert.equal(next.answers[0]?.status, 200);
    });

    it('captures a request that asks to upgrade like any other, and reads its connection on', async () => {
      const sessionId = await newSession();
      const sent = pipeline(
        receiver(),
        Buffer.from(
          `GET /s/${sessionId}?n=0 HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
          'latin1',
        ),
      );

      await until(() => sent.answers.length === 1, 'it is answered');
      // Written after its answer, so that it is read however the connection
      // is: what a read carries behind a request asking to upgrade, an
      // unbounded or uncounted connection drops; the counted bound ends the
      // slice with the head, so Node's parser reads it as the next request
      // (#277, `header-lines-bound.test.ts`).
      sent.socket.write(`GET /s/${sessionId}?n=1 HTTP/1.1\r\nHost: h\r\n\r\n`);
      await until(() => sent.answers.length === 2, 'the next is answered');
      await inOrder(sessionId, sent.answers, 2);
    });
  });
}

describe('a connection to a receiver bound at 2 requests, the least allowed (D229)', () => {
  it('reads on bodies dense in LF CR LF still arriving, of declared length and chunked, and answers every request in order', async () => {
    const sessionId = await newSession({ status: 200, body: 'held', delayMs: 50 });
    const declared = Buffer.from('\n\r\n'.repeat(70_000), 'latin1');
    const chunked = Buffer.from('\r\n'.repeat(60_000), 'latin1');
    const post = (index: number, framing: string): string =>
      `POST /s/${sessionId}?n=${index} HTTP/1.1\r\nHost: h\r\nContent-Type: application/octet-stream\r\n${framing}\r\n\r\n`;
    const chunks: Buffer[] = [];

    for (let at = 0; at < chunked.length; at += 4_096) {
      const piece = chunked.subarray(at, at + 4_096);

      chunks.push(
        Buffer.from(`${piece.length.toString(16)}\r\n`, 'latin1'),
        piece,
        Buffer.from('\r\n'),
      );
    }

    const bytes = Buffer.concat([
      Buffer.from(`GET /s/${sessionId}?n=0 HTTP/1.1\r\nHost: h\r\n\r\n`, 'latin1'),
      Buffer.from(post(1, `Content-Length: ${declared.length}`), 'latin1'),
      declared,
      Buffer.from(post(2, 'Transfer-Encoding: chunked'), 'latin1'),
      ...chunks,
      Buffer.from('0\r\n\r\n', 'latin1'),
      Buffer.from(`GET /s/${sessionId}?n=3 HTTP/1.1\r\nHost: h\r\n\r\n`, 'latin1'),
    ]);
    const sent = pipeline(pair, bytes);

    await until(() => sent.answers.length === 4, 'all 4 are answered');
    await inOrder(sessionId, sent.answers, 4);
    assert.deepEqual(await byQuery(sessionId, (row) => row.body), [
      digest(''),
      digest(declared),
      digest(chunked),
      digest(''),
    ]);
    assert.ok(
      (countOf(sent)?.most ?? 0) <= 2,
      `${countOf(sent)?.most} read and unanswered at once`,
    );
  });
});

const silentLog = { error: () => undefined } as unknown as FastifyBaseLogger;

interface BoundServer {
  server: Server;
  port: number;
  /** Every request's target, in the order Node's parser read them. */
  seen: string[];
  /** The answers not yet ended, by target. */
  responses: Map<string, ServerResponse>;
  close(): Promise<void>;
}

/**
 * A plain Node server behind the bound at `limit`, on the loopback, which
 * records each request and leaves its answer to the test unless `handle`
 * says otherwise.
 */
async function boundServer(
  limit: number,
  handle: (request: IncomingMessage, response: ServerResponse) => void = () => undefined,
): Promise<BoundServer> {
  const seen: string[] = [];
  const responses = new Map<string, ServerResponse>();
  const server = http.createServer((request, response) => {
    seen.push(request.url ?? '');
    responses.set(request.url ?? '', response);
    handle(request, response);
  });

  boundPipelinedRequests(server, { limit, log: silentLog });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));

  return {
    server,
    port: (server.address() as AddressInfo).port,
    seen,
    responses,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A client connection to `port` that writes `bytes` once connected and keeps what it is answered. */
function rawClient(
  port: number,
  bytes: Buffer | string,
): { socket: net.Socket; received: () => string } {
  const socket = net.connect(port, LOOPBACK, () => socket.write(bytes));
  let received = '';

  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString('latin1');
  });
  socket.on('error', () => undefined);

  return { socket, received: () => received };
}

const threeGets =
  'GET /a HTTP/1.1\r\nHost: h\r\n\r\nGET /b HTTP/1.1\r\nHost: h\r\n\r\nGET /c HTTP/1.1\r\nHost: h\r\n\r\n';

describe('the bound’s stop and the bodies it slices, on a plain Node server (D229)', () => {
  it('parses a body dense in LF CR LF pipelined behind 30 delayed requests in slices of 60 bytes or more, and keeps it unread in one piece a read, as Node does', async () => {
    const body = Buffer.from('\n\r\n'.repeat(87_382), 'latin1');
    const pieces: number[] = [];
    let executes = 0;
    const bound = await boundServer(MAX_PIPELINED_REQUESTS, (request, response) => {
      if (request.url === '/d') {
        setTimeout(() => response.end('d'), 200);

        return;
      }

      // Left unread a while - read ahead to Node's 64 KiB and stopped -
      // and then read.
      setTimeout(() => {
        request.on('data', (piece: Buffer) => pieces.push(piece.length));
        request.on('end', () => response.end('b'));
      }, 600);
    });

    // Every call into the connection's parser, counted on its `execute`.
    bound.server.on('connection', (socket: net.Socket) => {
      const parser = (socket as unknown as { parser: { execute: (...args: unknown[]) => unknown } })
        .parser;
      const execute = parser.execute;

      parser.execute = function counted(...args: unknown[]): unknown {
        executes += 1;

        return Reflect.apply(execute, this, args);
      };
      socket.once('close', () => Reflect.deleteProperty(parser, 'execute'));
    });

    const client = rawClient(
      bound.port,
      Buffer.concat([
        Buffer.from(
          `${'GET /d HTTP/1.1\r\nHost: h\r\n\r\n'.repeat(30)}POST /b HTTP/1.1\r\nHost: h\r\nContent-Length: ${body.length}\r\n\r\n`,
          'latin1',
        ),
        body,
      ]),
    );

    try {
      await until(
        () => client.received().split('HTTP/1.1 200').length - 1 === 31,
        'all 31 are answered',
      );
    } finally {
      client.socket.destroy();
      await bound.close();
    }

    assert.equal(
      pieces.reduce((sum, piece) => sum + piece, 0),
      body.length,
    );
    // Some 2,800 pieces of 93 bytes, or 21,000 of 3 behind the 30, unless
    // a read's are pushed as one.
    assert.ok(pieces.length <= body.length / 4_096, `${pieces.length} pieces of the body`);
    // 87,000 calls of 3 bytes behind the 30, unless the body waits for them.
    assert.ok(executes <= Math.ceil(body.length / 60) + 64, `${executes} calls into the parser`);
  });

  it('starts a connection it stopped only while the stop is still its own, not one somebody else stopped again since', async () => {
    const bound = await boundServer(2);
    let served: net.Socket | undefined;
    let meddle = false;

    bound.server.on('connection', (socket: net.Socket) => {
      served = socket;
    });

    // In the turn the first answer finishes, before the bound's start a turn
    // later: somebody starts the connection - Node, for a body - and
    // somebody stops it again - the capture budget's guard.
    const onFinish = (message: unknown): void => {
      const { socket } = message as { socket: net.Socket };

      if (meddle && socket === served) {
        meddle = false;
        socket.resume();
        socket.pause();
      }
    };

    subscribe('http.server.response.finish', onFinish);

    const client = rawClient(bound.port, threeGets);

    try {
      await until(() => bound.seen.length === 2, 'two are read');
      await delay(50);
      assert.deepEqual(bound.seen, ['/a', '/b'], 'read past the count');

      meddle = true;
      bound.responses.get('/a')?.end('a');
      await delay(100);
      assert.deepEqual(bound.seen, ['/a', '/b'], 'started a stop that was not its own');
      assert.equal(served?.isPaused(), true);

      // Its maker starts it, and the rest is read.
      served?.resume();
      await until(() => bound.seen.length === 3, 'the third is read');
      bound.responses.get('/b')?.end('b');
      bound.responses.get('/c')?.end('c');
      await until(
        () => client.received().split('HTTP/1.1 200').length - 1 === 3,
        'all 3 are answered',
      );
    } finally {
      unsubscribe('http.server.response.finish', onFinish);
      client.socket.destroy();
      await bound.close();
    }
  });

  for (const when of ['while the read is parsed', 'once it has been parsed'] as const) {
    it(`keeps a connection it stopped at the count stopped while the capture budget’s guard holds it for a waiting webhook, the guard stopping it ${when}, and reads on once the guard lets go`, async () => {
      const stopReading = connectionStops();
      const readAgain: (() => void)[] = [];
      const bound = await boundServer(2, (request) => {
        // The webhook waits for its place, its connection stopped (D210):
        // from the request's own handling, or a turn of promises later, as
        // the receiver's hooks run.
        if (request.url === '/b') {
          const wait = (): void => {
            readAgain.push(stopReading(request.socket));
          };

          if (when === 'while the read is parsed') {
            wait();
          } else {
            queueMicrotask(wait);
          }
        }
      });
      const client = rawClient(bound.port, threeGets);

      try {
        await until(() => readAgain.length === 1, 'the webhook waits');
        assert.deepEqual(bound.seen, ['/a', '/b']);

        // The answer before it no longer lets the bound read on.
        bound.responses.get('/a')?.end('a');
        await until(() => client.received().includes('HTTP/1.1 200'), 'the first is answered');
        await delay(100);
        assert.deepEqual(bound.seen, ['/a', '/b'], 'read on while the webhook waited');

        // Admitted: the guard lets go, and the bound, below its count, reads on.
        readAgain[0]?.();
        await until(() => bound.seen.length === 3, 'the third is read');
        bound.responses.get('/b')?.end('b');
        bound.responses.get('/c')?.end('c');
        await until(
          () => client.received().split('HTTP/1.1 200').length - 1 === 3,
          'all 3 are answered',
        );
      } finally {
        client.socket.destroy();
        await bound.close();
      }
    });
  }

  it('stops a connection somebody else starts again while it is at the count, and reads on once an answer frees a place', async () => {
    const bound = await boundServer(2);
    let served: net.Socket | undefined;

    bound.server.on('connection', (socket: net.Socket) => {
      served = socket;
    });

    const client = rawClient(bound.port, threeGets);

    try {
      await until(() => bound.seen.length === 2, 'two are read');
      served?.resume();
      await delay(100);
      assert.deepEqual(bound.seen, ['/a', '/b'], 'read past the count once started');
      assert.equal(served?.isPaused(), true);

      bound.responses.get('/a')?.end('a');
      await until(() => bound.seen.length === 3, 'the third is read once the first is answered');
      bound.responses.get('/b')?.end('b');
      bound.responses.get('/c')?.end('c');
      await until(
        () => client.received().split('HTTP/1.1 200').length - 1 === 3,
        'all 3 are answered',
      );
    } finally {
      client.socket.destroy();
      await bound.close();
    }

    // Nothing to hold on a connection the bound does not read, and a
    // release counts once.
    const release = holdStopped(new net.Socket());

    release();
    release();
  });
});
