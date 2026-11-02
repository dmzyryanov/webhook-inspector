/**
 * HTTP/2 clients for the receive listener's HTTP/2 path (D263), over real
 * sockets: Node's own client, h2c with prior knowledge, behind a PROXY
 * protocol v2 header or not, and a writer of raw frames for what Node's client
 * will not send - a preface in single bytes, say.
 *
 * Not a test file itself: only `*.test.ts` files import it.
 */
import http2, {
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http2';
import net, { type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { PROXY_V2_SIGNATURE } from '../modules/webhook/proxy-protocol.ts';

/** A PROXY protocol v2 header for TCP over IPv4 from `source`, to 10.42.0.24:8443. */
export function proxyV2Header(source: string, sourcePort = 50_000): Buffer {
  const octets = source.split('.').map(Number);

  return Buffer.from([
    ...PROXY_V2_SIGNATURE,
    0x21,
    0x11,
    0x00,
    12,
    ...octets,
    10,
    42,
    0,
    24,
    sourcePort >> 8,
    sourcePort & 0xff,
    0x20,
    0xfb,
  ]);
}

/**
 * Node's HTTP/2 client on a connection of its own to `port` on 127.0.0.1,
 * which writes `proxyHeader` first when one is given.
 */
export function connectH2(
  port: number,
  proxyHeader?: Buffer,
  options: http2.ClientSessionOptions = {},
): ClientHttp2Session {
  const session = http2.connect(`http://127.0.0.1:${port}`, {
    ...options,
    createConnection: () => {
      const socket = net.connect(port, '127.0.0.1');

      if (proxyHeader !== undefined) {
        socket.write(proxyHeader);
      }

      return socket;
    },
  });

  // A session the server ends is the test's to look at, never a throw.
  session.on('error', () => undefined);

  return session;
}

/** What one HTTP/2 request was answered. */
export interface H2Answer {
  /** `undefined` when no answer came: the stream was reset or refused. */
  status: number | undefined;
  headers: IncomingHttpHeaders;
  /** The answer's fields as received, `:status` first. */
  rawHeaders: string[];
  body: Buffer;
  /** The code the stream closed with: 0 for none, `NGHTTP2_REFUSED_STREAM`, ... */
  rstCode: number;
}

export interface H2Send {
  /** The body, written in pieces when it is an array; `null` ends the stream with the headers. */
  body?: string | Buffer | (string | Buffer)[] | null;
  /** Leaves the stream open after the body, as a sender still sending. */
  keepOpen?: boolean;
  /** Called with the stream once it is opened. */
  opened?: (stream: ClientHttp2Stream) => void;
}

/** Sends one request on `session` and resolves with its answer once the stream has closed. */
export function h2Request(
  session: ClientHttp2Session,
  headers: OutgoingHttpHeaders,
  send: H2Send = {},
): Promise<H2Answer> {
  const body = send.body === undefined ? null : send.body;
  const stream = session.request(headers, { endStream: body === null && !send.keepOpen });
  const answer: H2Answer = {
    status: undefined,
    headers: {},
    rawHeaders: [],
    body: Buffer.alloc(0),
    rstCode: 0,
  };
  const chunks: Buffer[] = [];

  send.opened?.(stream);

  return new Promise((resolve) => {
    stream.on('response', (received, _flags, rawHeaders: string[]) => {
      answer.status = received[':status'];
      answer.headers = received;
      answer.rawHeaders = rawHeaders;
    });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', () => undefined);
    stream.on('close', () => {
      answer.body = Buffer.concat(chunks);
      answer.rstCode = stream.rstCode ?? 0;
      resolve(answer);
    });

    if (body !== null) {
      for (const piece of Array.isArray(body) ? body : [body]) {
        stream.write(piece);
      }

      if (!send.keepOpen) {
        stream.end();
      }
    }
  });
}

/** Closes `session` and resolves once it has. */
export async function closeH2(session: ClientHttp2Session): Promise<void> {
  if (session.destroyed) {
    return;
  }

  await new Promise<void>((resolve) => {
    session.close(() => resolve());
  });
}

/** A raw socket to `port` on 127.0.0.1, connected. */
export async function rawConnection(port: number): Promise<Socket> {
  const socket = net.connect(port, '127.0.0.1');

  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));

  return socket;
}

/** What a raw connection received, and when it closed, from `start`. */
export interface Received {
  bytes: Buffer;
  closedAfterMs: number;
}

/** Collects what `socket` receives until it closes. */
export function receiveUntilClosed(socket: Socket, start = Date.now()): Promise<Received> {
  const chunks: Buffer[] = [];

  socket.on('data', (chunk: Buffer) => chunks.push(chunk));

  return new Promise((resolve) => {
    socket.once('close', () => {
      resolve({ bytes: Buffer.concat(chunks), closedAfterMs: Date.now() - start });
    });
  });
}

/** Writes `bytes` one at a time, `gapMs` apart, so that each reaches the server in a read of its own. */
export async function writeByteByByte(socket: Socket, bytes: Buffer, gapMs = 5): Promise<void> {
  for (const byte of bytes) {
    socket.write(Buffer.from([byte]));
    await delay(gapMs);
  }
}

/** One HTTP/2 frame: its 9-byte header and its payload (RFC 9113 §4.1). */
export function frame(type: number, flags: number, streamId: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(9);

  header.writeUIntBE(payload.length, 0, 3);
  header[3] = type;
  header[4] = flags;
  header.writeUInt32BE(streamId & 0x7fffffff, 5);

  return Buffer.concat([header, payload]);
}

export const FRAME_DATA = 0x0;
export const FRAME_HEADERS = 0x1;
export const FRAME_PRIORITY = 0x2;
export const FRAME_RST_STREAM = 0x3;
export const FRAME_SETTINGS = 0x4;
export const FRAME_PING = 0x6;
export const FRAME_GOAWAY = 0x7;
export const FRAME_WINDOW_UPDATE = 0x8;
export const FRAME_CONTINUATION = 0x9;
export const FLAG_END_STREAM = 0x1;
export const FLAG_END_HEADERS = 0x4;

/** A 4-byte big-endian unsigned integer, for a WINDOW_UPDATE increment or an error code. */
export function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);

  bytes.writeUInt32BE(value >>> 0);

  return bytes;
}

/** A SETTINGS frame's payload from `[id, value]` pairs (RFC 9113 §6.5), each six bytes. */
export function settingsPayload(entries: [number, number][]): Buffer {
  const payload = Buffer.alloc(entries.length * 6);

  entries.forEach(([id, value], index) => {
    payload.writeUInt16BE(id, index * 6);
    payload.writeUInt32BE(value >>> 0, index * 6 + 2);
  });

  return payload;
}

/** A WINDOW_UPDATE frame for `streamId` (0 for the connection) adding `increment` (RFC 9113 §6.9). */
export function windowUpdate(streamId: number, increment: number): Buffer {
  return frame(FRAME_WINDOW_UPDATE, 0, streamId, uint32(increment));
}

/** A RST_STREAM frame for `streamId` with error code `code` (RFC 9113 §6.4). */
export function rstStream(streamId: number, code: number): Buffer {
  return frame(FRAME_RST_STREAM, 0, streamId, uint32(code));
}

/** A dynamic-table size update (RFC 7541 §6.3): the `001` pattern, `size` in a five-bit prefix. */
export function hpackTableSizeUpdate(size: number): Buffer {
  const bytes = hpackInteger(size, 5);

  bytes[0] = (bytes[0] as number) | 0x20;

  return Buffer.from(bytes);
}

/** HTTP/2's default largest frame payload, which the receive listener keeps (RFC 9113 §6.5.2). */
const MAX_FRAME_PAYLOAD = 16_384;

/**
 * A header block as frames: one `HEADERS`, then as many `CONTINUATION`
 * frames as its size needs, the last one `END_HEADERS`; `END_STREAM` on the
 * `HEADERS` when `endStream`.
 */
export function headerBlockFrames(block: Buffer, streamId: number, endStream: boolean): Buffer {
  const frames: Buffer[] = [];

  for (let offset = 0; offset === 0 || offset < block.length; offset += MAX_FRAME_PAYLOAD) {
    const first = offset === 0;
    const last = offset + MAX_FRAME_PAYLOAD >= block.length;
    const flags = (last ? FLAG_END_HEADERS : 0) | (first && endStream ? FLAG_END_STREAM : 0);

    frames.push(
      frame(
        first ? FRAME_HEADERS : FRAME_CONTINUATION,
        flags,
        streamId,
        block.subarray(offset, offset + MAX_FRAME_PAYLOAD),
      ),
    );
  }

  return Buffer.concat(frames);
}

/** One frame a raw connection received. */
export interface ReceivedFrame {
  type: number;
  flags: number;
  streamId: number;
  payload: Buffer;
}

/** The frames a raw connection received, in order, as far as they are whole. */
export function receivedFrames(bytes: Buffer): ReceivedFrame[] {
  const frames: ReceivedFrame[] = [];
  let offset = 0;

  while (offset + 9 <= bytes.length) {
    const length = bytes.readUIntBE(offset, 3);

    if (offset + 9 + length > bytes.length) {
      break;
    }

    frames.push({
      type: bytes[offset + 3] as number,
      flags: bytes[offset + 4] as number,
      streamId: bytes.readUInt32BE(offset + 5) & 0x7fffffff,
      payload: bytes.subarray(offset + 9, offset + 9 + length),
    });
    offset += 9 + length;
  }

  return frames;
}

/** The error code of a `RST_STREAM` the connection received for `streamId`, or `undefined`. */
export function resetCode(frames: ReceivedFrame[], streamId: number): number | undefined {
  const reset = frames.find(
    (received) => received.type === FRAME_RST_STREAM && received.streamId === streamId,
  );

  return reset?.payload.readUInt32BE(0);
}

/** An HPACK integer with an `prefixBits`-bit prefix (RFC 7541 §5.1), the first byte's high bits 0. */
function hpackInteger(value: number, prefixBits: number): number[] {
  const limit = (1 << prefixBits) - 1;

  if (value < limit) {
    return [value];
  }

  const bytes = [limit];
  let rest = value - limit;

  while (rest >= 128) {
    bytes.push((rest % 128) + 128);
    rest = Math.floor(rest / 128);
  }

  bytes.push(rest);

  return bytes;
}

/**
 * A header block of literal fields without indexing, new names, no Huffman
 * (RFC 7541 §6.2.2): each field exactly as given, in order.
 */
export function literalHeaderBlock(fields: [string, string][]): Buffer {
  const bytes: number[] = [];

  for (const [name, value] of fields) {
    const nameBytes = Buffer.from(name, 'latin1');
    const valueBytes = Buffer.from(value, 'latin1');

    bytes.push(0x00, ...hpackInteger(nameBytes.length, 7), ...nameBytes);
    bytes.push(...hpackInteger(valueBytes.length, 7), ...valueBytes);
  }

  return Buffer.from(bytes);
}

/**
 * Header fields that HPACK amplifies (RFC 7541 §6.1, §6.2.1): `name` with a
 * value of `valueBytes` octets as a literal added to the dynamic table, then
 * `references - 1` one-byte references to that entry, index 62 - the entry
 * just added, whatever the table held. A few kilobytes on the wire, a list of
 * `references` times the field as HTTP/2 counts it. The value fits the
 * dynamic table's 4,096 bytes up to 4,059 octets with a five-byte name.
 */
export function amplifiedFields(name: string, valueBytes: number, references: number): Buffer {
  const nameBytes = Buffer.from(name, 'latin1');

  return Buffer.concat([
    Buffer.from([0x40, ...hpackInteger(nameBytes.length, 7)]),
    nameBytes,
    Buffer.from(hpackInteger(valueBytes, 7)),
    Buffer.alloc(valueBytes, 0x42),
    Buffer.alloc(references - 1, 0x80 | 62),
  ]);
}

/** The frames' types a raw connection received, in order, as far as they are whole. */
export function frameTypes(bytes: Buffer): number[] {
  const types: number[] = [];
  let offset = 0;

  while (offset + 9 <= bytes.length) {
    const length = bytes.readUIntBE(offset, 3);

    types.push(bytes[offset + 3] as number);
    offset += 9 + length;
  }

  return types;
}
