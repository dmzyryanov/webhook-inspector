/**
 * The HTTP/2 hostile-input series (D266, issue #208): the attack shapes an
 * HTTP/2 receive path brings that HTTP/1.1 does not - rapid reset
 * (CVE-2023-44487), CONTINUATION and HPACK bombs (CVE-2024-27983/-28182),
 * SETTINGS/PING/empty-frame/PRIORITY floods (CVE-2019-9511 to -9518),
 * MadeYouReset (CVE-2025-8671), zero and one-byte windows, oversized and
 * malformed frames, protocol confusion, and the shapes #207's delivery found
 * (the issue's two comments) - each at its smallest size, against the #207
 * path with `RECEIVE_HTTP2` on.
 *
 * The throughline: for every shape the backend answers an
 * ordinary webhook, on a connection of its own, during the shape where the
 * shape lasts and always after it, and stores it; the attack itself stores
 * nothing it should not. The
 * larger question - how many attacking addresses a shape survives under
 * D228's pass bar - is `scripts/measure-http2-hostile.mjs`'s for the eleven
 * shapes it implements, recorded in D266 point 4; the others here are not
 * measured (D266 point 3). Here each shape is exercised once, bounded in
 * time, over real sockets.
 *
 * Raw frames (`../../testing/http2.ts`) send what Node's client will not: a
 * HEADERS without END_HEADERS, an oversized frame, a reused stream id, a
 * zero-length header name, an out-of-range HPACK index. Node's own client
 * sends the rest.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 * (`node scripts/db.mjs task-test 208` brings up a database of its own).
 */
import assert from 'node:assert/strict';
import http2, { constants, type ClientHttp2Session } from 'node:http2';
import type { AddressInfo, Socket } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { MAX_BODY_BYTES } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildReceiver, buildServer, receiverHttp2, type ReceiverOptions } from '../../server.ts';
import {
  amplifiedFields,
  connectH2,
  FLAG_END_HEADERS,
  FLAG_END_STREAM,
  frame,
  FRAME_DATA,
  FRAME_GOAWAY,
  FRAME_HEADERS,
  FRAME_PING,
  FRAME_PRIORITY,
  FRAME_SETTINGS,
  h2Request,
  headerBlockFrames,
  hpackTableSizeUpdate,
  literalHeaderBlock,
  rawConnection,
  receivedFrames,
  resetCode,
  rstStream,
  settingsPayload,
  uint32,
  windowUpdate,
  type ReceivedFrame,
} from '../../testing/http2.ts';
import { LIMITS_OUT_OF_REACH } from '../../testing/servers.ts';
import { HTTP2_PREFACE } from './http2-preface.ts';
import { HTTP2_MAX_HEADER_LIST_SIZE, HTTP2_MAX_PSEUDO_HEADER_BYTES } from './http2-server.ts';

/** The SETTINGS id this file sends raw in a flood (RFC 9113 §6.5.2). */
const SETTINGS_HEADER_TABLE_SIZE = 0x1;
/** The SETTINGS id of a stream's initial flow-control window (RFC 9113 §6.5.2). */
const SETTINGS_INITIAL_WINDOW_SIZE = 0x4;

let pool: pg.Pool;
let api: FastifyInstance;
let receiver: FastifyInstance;
let port: number;
const createdSessionIds: string[] = [];
const clients: ClientHttp2Session[] = [];
const sockets: Socket[] = [];
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    api = buildServer(pool, { rateLimits: LIMITS_OUT_OF_REACH });
    api.log.level = 'silent';
    await api.ready();

    const options: ReceiverOptions = { http2: 'on' };

    receiver = buildReceiver(pool, options);
    receiver.log.level = 'silent';

    const part = receiverHttp2(receiver);

    if (part !== undefined) {
      part.app.log.level = 'silent';
    }

    await receiver.listen({ host: '127.0.0.1', port: 0 });
    port = (receiver.server.address() as AddressInfo).port;
  })();
  await startup;
});

after(async () => {
  await startup?.catch(() => undefined);

  for (const client of clients) {
    client.destroy();
  }

  for (const socket of sockets) {
    socket.destroy();
  }

  await receiver?.close();
  await api?.close();

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await pool?.end();
});

/** Creates a session, optionally with a response configuration, and answers its id. */
async function newSession(response?: Record<string, unknown>): Promise<string> {
  const created = await api.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(response === undefined ? {} : { response }),
  });

  assert.equal(created.statusCode, 201, created.body);

  const id = created.json<{ id: string }>().id;

  createdSessionIds.push(id);

  return id;
}

/** How many requests a session has stored. */
async function storedCount(sessionId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM requests WHERE session_id = $1',
    [sessionId],
  );

  return Number(result.rows[0]?.count ?? '0');
}

/** Polls until `check` holds, or fails with `what` after `timeoutMs`. */
async function eventually(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();

  while (!(await check())) {
    if (Date.now() - start > timeoutMs) {
      assert.fail(`not within ${timeoutMs} ms: ${what}`);
    }

    await delay(20);
  }
}

/** A Node HTTP/2 client to the receiver, closed at the end. */
function client(options: http2.ClientSessionOptions = {}): ClientHttp2Session {
  const session = connectH2(port, undefined, options);

  clients.push(session);

  return session;
}

/**
 * An ordinary webhook on a connection of its own: the capture path at rest.
 * It is answered `200` and stored within the deadline, whatever the attack on
 * its own connections is doing. `label` names the moment, so a
 * failure says whether the backend fell during the shape or after it.
 */
async function ordinaryWebhook(label: string): Promise<void> {
  const sessionId = await newSession();
  const answer = await h2Request(
    client(),
    { ':method': 'POST', ':path': `/s/${sessionId}`, 'content-type': 'application/json' },
    { body: '{"event":"ordinary"}' },
  );

  assert.equal(answer.status, 200, `ordinary webhook ${label}: answered ${answer.status}`);
  await eventually(
    async () => (await storedCount(sessionId)) === 1,
    `ordinary webhook ${label}: stored`,
  );
}

/**
 * A raw connection that has sent the preface and a SETTINGS of `settings`
 * (empty by default), collecting what it receives.
 */
async function rawFlight(settings: [number, number][] = []): Promise<{
  socket: Socket;
  write: (bytes: Buffer) => void;
  received: () => ReceivedFrame[];
}> {
  const socket = await rawConnection(port);

  sockets.push(socket);

  const chunks: Buffer[] = [];

  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.write(
    Buffer.concat([HTTP2_PREFACE, frame(FRAME_SETTINGS, 0, 0, settingsPayload(settings))]),
  );

  return {
    socket,
    write: (bytes: Buffer) => socket.write(bytes),
    received: () => receivedFrames(Buffer.concat(chunks)),
  };
}

/** Whether a GOAWAY has been received - a connection error that ended the whole connection. */
function goawaySeen(received: ReceivedFrame[]): boolean {
  return received.some((one) => one.type === FRAME_GOAWAY);
}

/** The error code of the received GOAWAY, or `undefined`. */
function goawayCode(received: ReceivedFrame[]): number | undefined {
  return received.find((one) => one.type === FRAME_GOAWAY)?.payload.readUInt32BE(4);
}

/** A minimal request block for `streamId` to `sessionId` as literal fields (no indexing). */
function requestBlock(sessionId: string, method = 'POST'): Buffer {
  return literalHeaderBlock([
    [':method', method],
    [':scheme', 'http'],
    [':path', `/s/${sessionId}`],
    [':authority', 'hook.qa-tools.test'],
  ]);
}

describe('HTTP/2 hostile series: streams and resets (D266)', () => {
  it('survives a rapid-reset flood (CVE-2023-44487): streams opened and at once reset, nothing stored', async () => {
    const sessionId = await newSession();
    const flight = await rawFlight();
    const resets = 60;

    for (let index = 0; index < resets; index += 1) {
      const streamId = 1 + 2 * index;

      // HEADERS without END_STREAM - the stream stays open - then a reset
      // before its END_STREAM, which stores nothing (D263 point 9).
      flight.write(frame(FRAME_HEADERS, FLAG_END_HEADERS, streamId, requestBlock(sessionId)));
      flight.write(rstStream(streamId, constants.NGHTTP2_CANCEL));
    }

    await ordinaryWebhook('during a rapid-reset flood');
    await delay(200);
    assert.equal(await storedCount(sessionId), 0, 'nothing of the reset streams stored');
    flight.socket.destroy();
    await ordinaryWebhook('after a rapid-reset flood');
  });

  it('refuses a 33rd concurrent stream REFUSED_STREAM before the SETTINGS ACK, answering the 32 (D263)', async () => {
    const sessionId = await newSession({ status: 200, delayMs: 400 });
    const session = client();
    const answers = await Promise.all(
      Array.from({ length: 33 }, (_unused, index) =>
        h2Request(
          session,
          { ':method': 'POST', ':path': `/s/${sessionId}/${index}` },
          { body: 'x' },
        ),
      ),
    );

    assert.equal(answers.filter((answer) => answer.status === 200).length, 32);
    const refused = answers.filter((answer) => answer.status === undefined);

    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.rstCode, constants.NGHTTP2_REFUSED_STREAM);
    await ordinaryWebhook('after a 33-stream burst');
  });

  it('survives a server-provoked reset flood (MadeYouReset, CVE-2025-8671): GETs each followed by a DATA frame, serving during and after', async () => {
    // A GET is answered on its headers; a stream its sender is still sending
    // on is then reset by the server (RFC 9113 §8.1). The sender provokes a
    // reset flood without resetting streams itself - MadeYouReset's shape.
    // The resets are not asserted here; that the backend serves is.
    const sessionId = await newSession();
    const flight = await rawFlight();
    const count = 40;

    for (let index = 0; index < count; index += 1) {
      const streamId = 1 + 2 * index;

      flight.write(
        frame(FRAME_HEADERS, FLAG_END_HEADERS, streamId, requestBlock(sessionId, 'GET')),
      );
      // END_STREAM false already; a stray DATA frame after the headers.
      flight.write(frame(FRAME_DATA, 0, streamId, Buffer.from('x')));
    }

    await ordinaryWebhook('during a server-provoked reset flood');
    flight.socket.destroy();
    await ordinaryWebhook('after a server-provoked reset flood');
  });
});

describe('HTTP/2 hostile series: CONTINUATION and HPACK (D266)', () => {
  it('kills the connection with COMPRESSION_ERROR on one header field over 64 KiB encoded, serving a fresh connection after (comment 5)', async () => {
    // One field whose encoded length passes nghttp2's 64 KiB bound - about
    // 104 KB decoded - is a connection error, GOAWAY(COMPRESSION_ERROR),
    // spanning several CONTINUATION frames, whatever the list's logical size
    // (D263 point 11). The sender's whole connection dies with it.
    const sessionId = await newSession();
    const block = Buffer.concat([
      requestBlock(sessionId),
      literalHeaderBlock([['x-huge', 'a'.repeat(70_000)]]),
    ]);
    const flight = await rawFlight();

    flight.write(headerBlockFrames(block, 1, true));
    await eventually(async () => goawaySeen(flight.received()), 'a GOAWAY ending the connection');
    assert.equal(goawayCode(flight.received()), constants.NGHTTP2_COMPRESSION_ERROR);
    flight.socket.destroy();
    assert.equal(await storedCount(sessionId), 0);
    await ordinaryWebhook('after a huge header field');
  });

  it('kills the connection on a header block over the 8-CONTINUATION bound, serving a fresh connection after', async () => {
    // A header block larger than nghttp2's eight CONTINUATION frames (about
    // 144 KiB compressed) is a connection error whatever its logical size;
    // nghttp2 names the code (COMPRESSION_ERROR or INTERNAL_ERROR), so the
    // invariant asserted is that the connection dies and a fresh one is served.
    const sessionId = await newSession();
    const fields = Array.from({ length: 20_000 }, (_unused, index): [string, string] => [
      `x-pad-${index}`,
      String(index),
    ]);
    const block = Buffer.concat([requestBlock(sessionId), literalHeaderBlock(fields)]);
    const flight = await rawFlight();

    flight.write(headerBlockFrames(block, 1, true));
    await eventually(async () => goawaySeen(flight.received()), 'a GOAWAY ending the connection');
    flight.socket.destroy();
    assert.equal(await storedCount(sessionId), 0);
    await ordinaryWebhook('after a CONTINUATION flood');
  });

  it('holds a HEADERS without END_HEADERS open and serves other connections meanwhile', async () => {
    const sessionId = await newSession();
    const flight = await rawFlight();

    // A HEADERS frame with neither END_HEADERS nor END_STREAM: nghttp2 waits
    // for CONTINUATION that never comes. No request timeout reaches it - Node
    // emits no stream until the block ends; its memory is bounded by the field
    // count and the connection cap (D266 point 2), and what ends it in time is
    // not tested here.
    flight.write(frame(FRAME_HEADERS, 0, 1, requestBlock(sessionId)));
    await ordinaryWebhook('during a dangling HEADERS');
    await delay(200);
    assert.equal(await storedCount(sessionId), 0, 'the incomplete header block stored nothing');
    flight.socket.destroy();
    await ordinaryWebhook('after a dangling HEADERS');
  });

  it('refuses an HPACK bomb before the SETTINGS ACK, builds no request of it, and serves after', async () => {
    const sessionId = await newSession();
    const flight = await rawFlight();
    // One literal value added to the dynamic table, then 2,000 one-byte
    // references to it (`amplifiedFields`): a few kilobytes on the wire, a
    // list over the size bound, refused by the stream hook (D263 point 11).
    const block = Buffer.concat([requestBlock(sessionId), amplifiedFields('x-big', 4_000, 2_000)]);

    flight.write(headerBlockFrames(block, 1, true));
    await eventually(
      async () => resetCode(flight.received(), 1) !== undefined || goawaySeen(flight.received()),
      'the amplified list refused',
    );
    flight.socket.destroy();
    assert.equal(await storedCount(sessionId), 0);
    await ordinaryWebhook('after an HPACK bomb');
  });

  it('survives an oversized dynamic-table-size update, an out-of-range index and an invalid Huffman literal', async () => {
    // Each malformed HPACK block is its own connection; nghttp2 answers a
    // decoding error with a GOAWAY, and a fresh connection is served after.
    for (const [label, block] of [
      // A table size update far over the 4,096 the server announced.
      [
        'an oversized table-size update',
        Buffer.concat([hpackTableSizeUpdate(1_000_000), requestBlock(await newSession())]),
      ],
      // An indexed field referencing dynamic index 62 of an empty table.
      ['an out-of-range index', Buffer.from([0x80 | 62])],
      // A literal with the Huffman bit set and bytes that are not a code.
      [
        'an invalid Huffman literal',
        Buffer.concat([
          requestBlock(await newSession()),
          Buffer.from([0x00, 0x82, 0xff, 0xff]), // new name, Huffman len 2, 0xffff is no valid code
        ]),
      ],
    ] as [string, Buffer][]) {
      const flight = await rawFlight();

      flight.write(headerBlockFrames(block, 1, true));
      await eventually(
        async () => goawaySeen(flight.received()) || resetCode(flight.received(), 1) !== undefined,
        `the connection answered ${label}`,
      );
      flight.socket.destroy();
      await ordinaryWebhook(`after ${label}`);
    }
  });
});

describe('HTTP/2 hostile series: control-frame floods and malformed frames (D266)', () => {
  it('survives SETTINGS, PING and PRIORITY floods (CVE-2019-9512/-9513/-9515)', async () => {
    for (const [label, make] of [
      [
        'a SETTINGS flood',
        () => frame(FRAME_SETTINGS, 0, 0, settingsPayload([[SETTINGS_HEADER_TABLE_SIZE, 0]])),
      ],
      ['a PING flood', () => frame(FRAME_PING, 0, 0, Buffer.alloc(8))],
      [
        'a PRIORITY flood',
        () => frame(FRAME_PRIORITY, 0, 1, Buffer.concat([uint32(0), Buffer.from([0])])),
      ],
    ] as [string, () => Buffer][]) {
      const flight = await rawFlight();
      const burst: Buffer[] = [];

      for (let index = 0; index < 500; index += 1) {
        burst.push(make());
      }

      flight.write(Buffer.concat(burst));
      await ordinaryWebhook(`during ${label}`);
      flight.socket.destroy();
      await ordinaryWebhook(`after ${label}`);
    }
  });

  it('survives an empty-DATA flood on an open stream (CVE-2019-9518)', async () => {
    const sessionId = await newSession();
    const flight = await rawFlight();

    flight.write(frame(FRAME_HEADERS, FLAG_END_HEADERS, 1, requestBlock(sessionId)));

    const burst: Buffer[] = [];

    for (let index = 0; index < 500; index += 1) {
      burst.push(frame(FRAME_DATA, 0, 1, Buffer.alloc(0)));
    }

    flight.write(Buffer.concat(burst));
    await ordinaryWebhook('during an empty-DATA flood');
    flight.socket.destroy();
    await ordinaryWebhook('after an empty-DATA flood');
  });

  it('kills the connection with a GOAWAY on an oversized frame, serving fresh after', async () => {
    const flight = await rawFlight();

    // A frame payload over the 16 KiB SETTINGS_MAX_FRAME_SIZE the server keeps.
    flight.write(frame(FRAME_DATA, 0, 1, Buffer.alloc(16_385, 0x61)));
    await eventually(async () => goawaySeen(flight.received()), 'a GOAWAY on an oversized frame');
    flight.socket.destroy();
    await ordinaryWebhook('after an oversized frame');
  });

  it('survives reused and non-increasing stream ids, serving fresh after', async () => {
    // nghttp2's reaction to a reused or lower-valued stream id is its own - a
    // GOAWAY, a RST_STREAM, or an ignored frame; the invariant is that the
    // backend serves a fresh connection throughout.
    for (const [label, streamIds] of [
      ['a reused stream id', [1, 1]],
      ['a non-increasing stream id', [3, 1]],
    ] as [string, number[]][]) {
      const flight = await rawFlight();

      for (const streamId of streamIds) {
        flight.write(
          frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS | FLAG_END_STREAM,
            streamId,
            requestBlock(await newSession(), 'GET'),
          ),
        );
      }

      await ordinaryWebhook(`during ${label}`);
      flight.socket.destroy();
      await ordinaryWebhook(`after ${label}`);
    }
  });

  it('survives a WINDOW_UPDATE overflow on the connection (a GOAWAY FLOW_CONTROL_ERROR), serving fresh after', async () => {
    const flight = await rawFlight();

    // Two large increments that take the connection window past 2^31 - 1.
    flight.write(windowUpdate(0, 0x7fffffff));
    flight.write(windowUpdate(0, 0x7fffffff));
    await eventually(async () => goawaySeen(flight.received()), 'a GOAWAY on a window overflow');
    flight.socket.destroy();
    await ordinaryWebhook('after a WINDOW_UPDATE overflow');
  });
});

describe('HTTP/2 hostile series: malformed header lists (D266)', () => {
  // Each row is one malformed request; nghttp2 answers a stream error
  // (RST_STREAM) or, for some, a connection error (GOAWAY). Either way nothing
  // is stored and the backend serves a fresh connection after.
  const malformed: [string, [string, string][]][] = [
    ['an uppercase header name', [['X-Upper', 'v']]],
    ['a connection header', [['connection', 'keep-alive']]],
    ['a duplicate :method pseudo-header', [[':method', 'GET']]],
    ['a :path after a regular field', [['x-misplaced', 'v']]],
  ];

  for (const [label, extra] of malformed) {
    it(`stores nothing of ${label} and serves a fresh connection after`, async () => {
      const sessionId = await newSession();
      const flight = await rawFlight();
      const fields: [string, string][] =
        label === 'a :path after a regular field'
          ? [
              [':method', 'GET'],
              [':scheme', 'http'],
              [':authority', 'h'],
              ...extra,
              [':path', `/s/${sessionId}`],
            ]
          : [
              [':method', 'GET'],
              [':scheme', 'http'],
              [':path', `/s/${sessionId}`],
              [':authority', 'h'],
              ...extra,
            ];

      flight.write(headerBlockFrames(literalHeaderBlock(fields), 1, true));
      await eventually(
        async () => resetCode(flight.received(), 1) !== undefined || goawaySeen(flight.received()),
        `the server answered ${label}`,
      );
      await delay(100);
      assert.equal(await storedCount(sessionId), 0, `nothing stored of ${label}`);
      flight.socket.destroy();
      await ordinaryWebhook(`after ${label}`);
    });
  }

  it('handles zero-length header names and values without harm, serving fresh after (CVE-2019-9516)', async () => {
    // HTTP/2 permits an empty header value, and Node does not reject an empty
    // name; whichever way it disposes of them, the backend must keep serving,
    // which is what is checked here. Whether they leak is not, and the memory
    // of a flood of them is not measured (D266 point 3).
    const sessionId = await newSession();
    const flight = await rawFlight();

    flight.write(
      headerBlockFrames(
        literalHeaderBlock([
          [':method', 'GET'],
          [':scheme', 'http'],
          [':path', `/s/${sessionId}`],
          [':authority', 'h'],
          ['', 'value'],
          ['x-empty', ''],
        ]),
        1,
        true,
      ),
    );
    await ordinaryWebhook('during zero-length names and values');
    flight.socket.destroy();
    await ordinaryWebhook('after zero-length names and values');
  });

  it('serves a fresh connection after a :path with control bytes or a bad percent-escape', async () => {
    for (const badPath of ['/s/\u0001\u0002', '/s/%zz', '/s/%']) {
      const flight = await rawFlight();

      flight.write(
        headerBlockFrames(
          literalHeaderBlock([
            [':method', 'GET'],
            [':scheme', 'http'],
            [':path', badPath],
            [':authority', 'h'],
          ]),
          1,
          true,
        ),
      );
      // A bad path is either refused by nghttp2 (stream or connection error)
      // or routed to the not-found answer. It names no session, so there is
      // nothing of it to store; what is checked is that the backend serves.
      await delay(150);
      flight.socket.destroy();
      await ordinaryWebhook(`after a bad :path (${JSON.stringify(badPath)})`);
    }
  });
});

describe('HTTP/2 hostile series: a long :path or :authority is refused (D266, comment 6)', () => {
  const prefix = '/s/';

  it(`stores a :path of exactly ${HTTP2_MAX_PSEUDO_HEADER_BYTES} bytes and refuses one byte more, nothing stored`, async () => {
    const atEdge = await newSession();
    const over = await newSession();
    const padTo = (sessionId: string, total: number): string => {
      const head = `${prefix}${sessionId}?p=`;

      return head + 'a'.repeat(total - head.length);
    };
    const session = client({ maxSendHeaderBlockLength: 4 * 1024 * 1024 });

    const edge = await h2Request(session, {
      ':method': 'GET',
      ':path': padTo(atEdge, HTTP2_MAX_PSEUDO_HEADER_BYTES),
    });
    const beyond = await h2Request(session, {
      ':method': 'GET',
      ':path': padTo(over, HTTP2_MAX_PSEUDO_HEADER_BYTES + 1),
    });

    assert.equal(edge.status, 200, 'the 16 KiB path is served');
    await eventually(async () => (await storedCount(atEdge)) === 1, 'the 16 KiB path stored');
    assert.equal(beyond.status, undefined, 'the over-16 KiB path is refused');
    assert.equal(beyond.rstCode, constants.NGHTTP2_ENHANCE_YOUR_CALM);
    await delay(100);
    assert.equal(await storedCount(over), 0, 'the over-long path stored nothing');
    await ordinaryWebhook('after a long :path');
  });

  it(`refuses an :authority over ${HTTP2_MAX_PSEUDO_HEADER_BYTES} bytes ENHANCE_YOUR_CALM, nothing stored`, async () => {
    const sessionId = await newSession();
    const session = client({ maxSendHeaderBlockLength: 4 * 1024 * 1024 });
    const refused = await h2Request(session, {
      ':method': 'GET',
      ':path': `${prefix}${sessionId}`,
      ':authority': 'h'.repeat(HTTP2_MAX_PSEUDO_HEADER_BYTES + 1),
    });

    assert.equal(refused.status, undefined);
    assert.equal(refused.rstCode, constants.NGHTTP2_ENHANCE_YOUR_CALM);
    await delay(100);
    assert.equal(await storedCount(sessionId), 0);
    // Stays under the whole-list bound, so only the :authority rule refused it.
    assert.ok(HTTP2_MAX_PSEUDO_HEADER_BYTES + 1 < HTTP2_MAX_HEADER_LIST_SIZE);
    await ordinaryWebhook('after a long :authority');
  });
});

describe('HTTP/2 hostile series: flow control and slow streams (D266)', () => {
  it('serves other connections while an answer is held by a zero window (CVE-2019-9517, comment 1)', async () => {
    // The client advertises a zero initial window, so the server cannot send
    // the answer body; its head goes out, the answer is held, and the
    // connection would linger. No WINDOW_UPDATE is ever sent. The request
    // itself completed, so it is stored; ordinary traffic is unaffected.
    const heldSession = await newSession();
    const holder = client({ settings: { initialWindowSize: 0 } });
    const stream = holder.request({ ':method': 'POST', ':path': `/s/${heldSession}` });
    let headDelivered = false;

    stream.on('error', () => undefined);
    stream.on('response', () => {
      headDelivered = true;
    });
    stream.end('body');

    await eventually(async () => headDelivered, 'the answer head delivered under a zero window');
    await ordinaryWebhook('during a flow-control-held answer');
    await eventually(async () => (await storedCount(heldSession)) === 1, 'the held request stored');
    holder.destroy();
    await ordinaryWebhook('after a flow-control-held answer');
  });

  it('dribbles an answer a byte at a time through a one-byte window, after a body trickled a byte at a time, while other connections are served (CVE-2019-9511)', async () => {
    // The sender advertises a one-byte stream window, trickles its body in
    // one-byte DATA frames and then ends the stream, so the server answers.
    // The answer's DATA can then leave one byte for each byte of window the
    // sender grants, and is held between grants: the first byte goes out, the
    // rest waits while ordinary traffic is served on other connections, then
    // each one-byte WINDOW_UPDATE lets one more byte out. Without the one-byte
    // window the answer would leave whole in one frame.
    const answerBody = 'held a byte at a time';
    const trickled = 'trickled';
    const sessionId = await newSession({ status: 200, headers: [], body: answerBody });
    const flight = await rawFlight([[SETTINGS_INITIAL_WINDOW_SIZE, 1]]);
    const answerData = (): ReceivedFrame[] =>
      flight.received().filter((one) => one.type === FRAME_DATA && one.streamId === 1);
    const answered = (): string =>
      Buffer.concat(answerData().map((one) => one.payload)).toString('latin1');
    const ended = (): boolean => answerData().some((one) => (one.flags & FLAG_END_STREAM) !== 0);

    flight.write(frame(FRAME_HEADERS, FLAG_END_HEADERS, 1, requestBlock(sessionId)));

    for (const byte of trickled) {
      flight.write(frame(FRAME_DATA, 0, 1, Buffer.from(byte, 'latin1')));
      await delay(10);
    }

    flight.write(frame(FRAME_DATA, FLAG_END_STREAM, 1, Buffer.alloc(0)));

    await eventually(async () => answered().length > 0, 'the first byte of the answer');
    await ordinaryWebhook('while a one-byte window holds an answer');
    await eventually(
      async () => (await storedCount(sessionId)) === 1,
      'the trickled request stored',
    );

    const stored = await pool.query<{ body: Buffer }>(
      'SELECT body FROM requests WHERE session_id = $1',
      [sessionId],
    );

    assert.equal(stored.rows[0]?.body.toString('latin1'), trickled, 'the trickled body stored');
    assert.equal(answered(), answerBody.slice(0, 1), 'one byte out while the window is spent');
    assert.equal(ended(), false, 'the answer held, not ended');

    for (let sent = 1; sent < answerBody.length; sent += 1) {
      flight.write(windowUpdate(1, 1));
      await eventually(
        async () => answered().length === sent + 1,
        `byte ${sent + 1} of the answer after one more byte of window`,
      );
    }

    await eventually(async () => ended(), 'the answer ended');
    assert.equal(answered(), answerBody);
    assert.ok(
      answerData().every((one) => one.payload.length <= 1),
      `no DATA frame over one byte: ${answerData()
        .map((one) => one.payload.length)
        .join(', ')}`,
    );
    flight.socket.destroy();
    await ordinaryWebhook('after a one-byte window');
  });

  it('serves other connections while eight streams of one connection hold their bodies open (#278)', async () => {
    // Each stream sends part of its body without END_STREAM, so the request
    // never arrives whole and its body is held open. Node's maxSessionMemory,
    // 10 MB a connection, is far from reached: its refusal is reached neither
    // here nor by the measurement's `session-memory` shape, at most 32
    // streams of 8,000 bytes a connection (D266 point 7).
    const sessionId = await newSession({ status: 200, delayMs: 2_000 });
    const flight = await rawFlight();
    // Eight streams, each holding 8,000 bytes of DATA open (no END_STREAM):
    // 64,000 bytes, under one 65,535-byte connection window, so no
    // flow-control error.
    const chunk = 8_000;

    for (let index = 0; index < 8; index += 1) {
      const streamId = 1 + 2 * index;

      flight.write(
        frame(
          FRAME_HEADERS,
          FLAG_END_HEADERS,
          streamId,
          literalHeaderBlock([
            [':method', 'POST'],
            [':scheme', 'http'],
            [':path', `/s/${sessionId}`],
            [':authority', 'h'],
            ['content-length', String(chunk)],
          ]),
        ),
      );
      flight.write(frame(FRAME_DATA, 0, streamId, Buffer.alloc(chunk, 0x61)));
    }

    await ordinaryWebhook('during bodies held open');
    flight.socket.destroy();
    await ordinaryWebhook('after bodies held open');
  });
});

describe('HTTP/2 hostile series: bodies against the budget (D266, comment 3)', () => {
  for (const framing of ['with', 'without'] as const) {
    it(`answers 413 to a body over 1 MiB ${framing} content-length, nothing stored, serving fresh after`, async () => {
      const over = await newSession();
      const answer = await h2Request(
        client(),
        {
          ':method': 'POST',
          ':path': `/s/${over}`,
          ...(framing === 'with' ? { 'content-length': String(MAX_BODY_BYTES + 1) } : {}),
        },
        { body: [Buffer.alloc(MAX_BODY_BYTES, 0x61), Buffer.from('z')] },
      );

      assert.equal(answer.status, 413);
      assert.equal(JSON.parse(answer.body.toString()).errorCode, 1004);
      await delay(100);
      assert.equal(await storedCount(over), 0);
      await ordinaryWebhook(`after an over-1 MiB body ${framing} content-length`);
    });
  }

  it('resets a stream whose body is shorter than a non-zero content-length, storing nothing (comment 3)', async () => {
    // Content-Length lies: 1,024 declared, END_STREAM after 8 bytes. nghttp2
    // answers PROTOCOL_ERROR and stores nothing.
    const sessionId = await newSession();
    const flight = await rawFlight();

    flight.write(
      frame(
        FRAME_HEADERS,
        FLAG_END_HEADERS,
        1,
        literalHeaderBlock([
          [':method', 'POST'],
          [':scheme', 'http'],
          [':path', `/s/${sessionId}`],
          [':authority', 'h'],
          ['content-length', '1024'],
        ]),
      ),
    );
    flight.write(frame(FRAME_DATA, FLAG_END_STREAM, 1, Buffer.from('shortbdy')));
    await eventually(
      async () => resetCode(flight.received(), 1) !== undefined,
      'the lying content-length reset',
    );
    await delay(100);
    assert.equal(await storedCount(sessionId), 0);
    flight.socket.destroy();
    await ordinaryWebhook('after a lying content-length');
  });
});

describe('HTTP/2 hostile series: protocol confusion and the preface (D266)', () => {
  it('answers HTTP/1.1 bytes on the HTTP/2 path as the preface layer decides (not a capture)', async () => {
    // A plain HTTP/1.1 request disagrees with the preface at its first byte
    // and is handed to the HTTP/1.1 parser (D263 point 3). Here it reaches a
    // non-existent session and is answered, not crashing the listener.
    const socket = await rawConnection(port);

    sockets.push(socket);
    socket.write(
      'GET /robots.txt HTTP/1.1\r\nHost: hook.qa-tools.test\r\nConnection: close\r\n\r\n',
    );
    const answer = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];

      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
      setTimeout(() => socket.destroy(), 500).unref();
    });

    assert.match(
      answer,
      /^HTTP\/1\.1 200/,
      'the HTTP/1.1 request is served by the HTTP/1.1 parser',
    );
    await ordinaryWebhook('after HTTP/1.1 bytes on the HTTP/2 path');
  });

  it('handles non-preface garbage bytes without affecting other connections', async () => {
    const socket = await rawConnection(port);

    sockets.push(socket);
    // Bytes that are not the preface: the first disagrees, so they are handed
    // to the HTTP/1.1 parser, which answers 400 and closes (D263 point 3).
    socket.write(Buffer.alloc(24, 0x00));
    await delay(200);
    socket.destroy();
    await ordinaryWebhook('after preface garbage');
  });

  it('serves a fresh connection after a CONNECT over the HTTP/2 path', async () => {
    const flight = await rawFlight();

    flight.write(
      headerBlockFrames(
        literalHeaderBlock([
          [':method', 'CONNECT'],
          [':authority', 'hook.qa-tools.test:443'],
        ]),
        1,
        true,
      ),
    );
    await delay(150);
    flight.socket.destroy();
    await ordinaryWebhook('after a CONNECT');
  });

  it('refuses a pseudo-header in trailers, storing nothing', async () => {
    const sessionId = await newSession();
    const flight = await rawFlight();

    // A valid POST, then a trailer section carrying a pseudo-header, which is
    // forbidden in trailers. Trailers over the header-list size are
    // `receiver-http2.test.ts`'s.
    flight.write(frame(FRAME_HEADERS, FLAG_END_HEADERS, 1, requestBlock(sessionId)));
    flight.write(frame(FRAME_DATA, 0, 1, Buffer.from('body')));
    flight.write(
      headerBlockFrames(
        literalHeaderBlock([
          [':method', 'GET'],
          ['x-trailer', 'v'],
        ]),
        1,
        true,
      ),
    );
    await eventually(
      async () => resetCode(flight.received(), 1) !== undefined || goawaySeen(flight.received()),
      'the bad trailers answered',
    );
    await delay(100);
    assert.equal(await storedCount(sessionId), 0);
    flight.socket.destroy();
    await ordinaryWebhook('after bad trailers');
  });
});
