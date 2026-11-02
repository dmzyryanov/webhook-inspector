/**
 * Whether an HTTP/2 request's END_STREAM came before its stream closed
 * (`watchHttp2Request`, `http2BodyUnproven`, D263), on a connection that is
 * not a socket: Node reads what such a connection is given in one batch, a
 * reset after an END_STREAM in the same batch included - as it reads the
 * bytes the preface layer puts back on a socket - and emits the stream's
 * `end` only after the reset.
 *
 * Needs no database and no listener: the receive listener's HTTP/2 server is
 * given an in-memory connection, and a handler that reads the body to its
 * end, as Fastify does, then asks what the receive routes ask. The same
 * shapes over real sockets, stored or not, are in `receiver-http2.test.ts`.
 */
import assert from 'node:assert/strict';
import { constants } from 'node:http2';
import { Duplex } from 'node:stream';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { http2BodyUnproven } from '../../lib/http2.ts';
import {
  FLAG_END_HEADERS,
  FLAG_END_STREAM,
  frame,
  FRAME_DATA,
  FRAME_HEADERS,
  FRAME_RST_STREAM,
  FRAME_SETTINGS,
  literalHeaderBlock,
} from '../../testing/http2.ts';
import { HTTP2_PREFACE } from './http2-preface.ts';
import { createReceiveHttp2Server } from './http2-server.ts';

/** What the handler read of a request, and what it would decide of it. */
interface Read {
  body: Buffer;
  unproven: boolean;
}

/** An in-memory connection to the receive listener's HTTP/2 server. */
interface Connection {
  /** Gives the server `bytes`, read in one batch. */
  push: (bytes: Buffer) => void;
  /** Resolves once the handler reads the request's body. */
  reading: Promise<void>;
  /** Resolves once the body has ended. */
  read: Promise<Read>;
  close: () => void;
}

function connect(): Connection {
  let started = (): void => undefined;
  let ended = (_read: Read): void => undefined;
  const reading = new Promise<void>((resolve) => (started = resolve));
  const read = new Promise<Read>((resolve) => (ended = resolve));
  const server = createReceiveHttp2Server((request) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () =>
      ended({ body: Buffer.concat(chunks), unproven: http2BodyUnproven(request.stream) }),
    );
    started();
  });
  const connection = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  connection.on('error', () => undefined);
  server.emit('connection', connection);

  return {
    push: (bytes) => connection.push(bytes),
    reading,
    read,
    close: () => connection.destroy(),
  };
}

const OPENING = Buffer.concat([HTTP2_PREFACE, frame(FRAME_SETTINGS, 0, 0, Buffer.alloc(0))]);
const BODY = Buffer.from('abcde');

function postHeaders(contentLength?: string): Buffer {
  return frame(
    FRAME_HEADERS,
    FLAG_END_HEADERS,
    1,
    literalHeaderBlock([
      [':method', 'POST'],
      [':scheme', 'http'],
      [':path', '/s/x'],
      [':authority', 'h'],
      ...(contentLength === undefined
        ? []
        : ([['content-length', contentLength]] as [string, string][])),
    ]),
  );
}

function reset(code: number): Buffer {
  const payload = Buffer.alloc(4);

  payload.writeUInt32BE(code);

  return frame(FRAME_RST_STREAM, 0, 1, payload);
}

const dataFrame = (endStream: boolean): Buffer =>
  frame(FRAME_DATA, endStream ? FLAG_END_STREAM : 0, 1, BODY);

/**
 * Opens a connection, sends a `POST`'s `HEADERS`, and once the handler reads
 * its body - Node has emitted its stream - gives the server `batch` in one
 * read. Resolves with what the handler read.
 */
async function afterHeaders(batch: Buffer, contentLength?: string): Promise<Read> {
  const connection = connect();

  try {
    connection.push(Buffer.concat([OPENING, postHeaders(contentLength)]));
    await connection.reading;
    await delay(20);
    connection.push(batch);

    return await connection.read;
  } finally {
    connection.close();
  }
}

describe('an HTTP/2 request read in one batch with its reset (D263)', () => {
  for (const [name, code] of [
    ['CANCEL', constants.NGHTTP2_CANCEL],
    ['NO_ERROR', constants.NGHTTP2_NO_ERROR],
  ] as const) {
    it(`is whole when its END_STREAM came before RST_STREAM(${name}) in the same batch`, async () => {
      const read = await afterHeaders(Buffer.concat([dataFrame(true), reset(code)]));

      assert.deepEqual(read.body, BODY);
      assert.equal(read.unproven, false);
    });

    it(`is not whole when RST_STREAM(${name}) came in the batch of its body with no END_STREAM, with a Content-Length met or without one`, async () => {
      for (const contentLength of [String(BODY.length), undefined]) {
        const read = await afterHeaders(
          Buffer.concat([dataFrame(false), reset(code)]),
          contentLength,
        );

        assert.deepEqual(read.body, BODY, `content-length ${contentLength}`);
        assert.equal(read.unproven, true, `content-length ${contentLength}`);
      }
    });
  }

  it('is whole when its END_STREAM came on its trailers, a reset after them in the same batch', async () => {
    const trailers = frame(
      FRAME_HEADERS,
      FLAG_END_HEADERS | FLAG_END_STREAM,
      1,
      literalHeaderBlock([['x-trailer', 't']]),
    );
    const read = await afterHeaders(
      Buffer.concat([dataFrame(false), trailers, reset(constants.NGHTTP2_CANCEL)]),
    );

    assert.deepEqual(read.body, BODY);
    assert.equal(read.unproven, false);
  });

  it('is whole when its END_STREAM came with no reset', async () => {
    const read = await afterHeaders(dataFrame(true));

    assert.deepEqual(read.body, BODY);
    assert.equal(read.unproven, false);
  });

  it('is not whole when its HEADERS, END_STREAM and reset came in one batch: Node discards its body before it emits the stream', async () => {
    const connection = connect();

    try {
      connection.push(
        Buffer.concat([OPENING, postHeaders(), dataFrame(true), reset(constants.NGHTTP2_CANCEL)]),
      );

      const read = await connection.read;

      assert.equal(read.body.length, 0);
      assert.equal(read.unproven, true);
    } finally {
      connection.close();
    }
  });
});
