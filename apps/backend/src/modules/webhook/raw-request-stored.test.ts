/**
 * The stored raw request is byte for byte what it was before 0.49.1 (D049,
 * D210). It is now the head composed in the process and the body joined by
 * the insert (`$head || $body`), where it was one buffer composed in the
 * process; for every shape below, sent over a real socket, the row must hold
 * exactly what the code of `main` at b8b9fe7 would have stored for the same
 * request: its `composeRawRequest`, copied below unchanged, applied to the
 * request and the body as its handler received them.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import net, { type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { MAX_BODY_BYTES } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import { collectHeaderPairs } from './raw-request.ts';
import { REQUEST_ID_HEADER } from './response.ts';

/**
 * `composeRawRequest` of `apps/backend/src/modules/webhook/raw-request.ts` at
 * b8b9fe7 (0.49.0), unchanged: what was stored as `raw_request` until 0.49.1.
 */
function composeRawRequestOnMain(
  request: FastifyRequest,
  headers: [string, string][],
  body: Buffer,
): Buffer {
  const { method, httpVersion } = request.raw;

  // The URL as received, which is what the router was given in every case but
  // one path it could not decode (`routableUrl`).
  const lines = [`${method} ${request.originalUrl} HTTP/${httpVersion}`];

  for (const [name, value] of headers) {
    lines.push(`${name}: ${value}`);
  }

  return Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), body]);
}

const EMPTY_BODY = Buffer.alloc(0);

let pool: pg.Pool;
let servers: TestServers;
let receiver: FastifyInstance;
let port: number;
let sessionId: string;
/** What `main` would have stored, by the `X-Case` each request carries. */
const expected = new Map<string, Buffer>();

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    servers = buildTestServers(pool);
    receiver = servers.receiver;
    servers.api.log.level = 'silent';
    receiver.log.level = 'silent';
    // On the root, before the listener is ready, so the webhook scope has it
    // too: the request and the body exactly as the handler receives them,
    // composed as `main` composed them, with the pairs as `main` collected
    // them (`collectHeaderPairs` is unchanged).
    receiver.addHook('preHandler', async (request) => {
      const label = request.headers['x-case'];

      if (typeof label === 'string') {
        expected.set(
          label,
          composeRawRequestOnMain(
            request,
            collectHeaderPairs(request.raw.rawHeaders),
            Buffer.isBuffer(request.body) ? request.body : EMPTY_BODY,
          ),
        );
      }
    });
    await servers.api.ready();
    await receiver.listen({ host: '127.0.0.1', port: 0 });
    port = (receiver.server.address() as AddressInfo).port;

    const created = await servers.api.inject({ method: 'POST', url: '/api/sessions' });

    sessionId = created.json<{ id: string }>().id;
  })();
  await startup;
});

after(async () => {
  await startup;

  if (sessionId !== undefined) {
    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  }

  await servers?.close();
  await pool?.end();
});

/** Writes `bytes` and resolves with the request id the answer carries. */
function send(bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(bytes));
    let received = '';

    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const id = new RegExp(`\\r\\n${REQUEST_ID_HEADER}: ([0-9a-f-]{36})\\r\\n`, 'i').exec(
        received,
      )?.[1];

      if (id === undefined) {
        reject(new Error(`no request id in ${JSON.stringify(received.slice(0, 300))}`));
      } else {
        resolve(id);
      }
    });
  });
}

/** A request's head, latin1, ending with the blank line. */
function head(requestLine: string, lines: string[]): Buffer {
  return Buffer.from(`${[requestLine, ...lines].join('\r\n')}\r\n\r\n`, 'latin1');
}

/** Every byte value, over and over, `length` bytes. */
function binary(length: number): Buffer {
  return Buffer.from(Array.from({ length }, (_, index) => (index * 7 + 3) % 256));
}

interface Case {
  name: string;
  bytes: (label: string) => Buffer;
}

const LATIN1_VALUE = Array.from({ length: 96 }, (_, index) =>
  String.fromCharCode(0xa0 + index),
).join('');
const symbols = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const CASES: Case[] = [
  {
    name: 'a binary body, every byte value',
    bytes: (label) => {
      const body = binary(70_000);

      return Buffer.concat([
        head(`POST /s/${sessionId} HTTP/1.1`, [
          'Host: hook.qa-tools.ru',
          'Connection: close',
          `X-Case: ${label}`,
          'Content-Type: application/octet-stream',
          `Content-Length: ${body.length}`,
        ]),
        body,
      ]);
    },
  },
  {
    name: 'a binary body of exactly 1 MiB',
    bytes: (label) => {
      const body = binary(MAX_BODY_BYTES);

      return Buffer.concat([
        head(`PUT /s/${sessionId}/deep/path?x=1 HTTP/1.1`, [
          'Host: hook.qa-tools.ru',
          'Connection: close',
          `X-Case: ${label}`,
          `Content-Length: ${body.length}`,
        ]),
        body,
      ]);
    },
  },
  {
    name: 'a HEAD',
    bytes: (label) =>
      head(`HEAD /s/${sessionId} HTTP/1.1`, [
        'Host: hook.qa-tools.ru',
        'Connection: close',
        `X-Case: ${label}`,
      ]),
  },
  {
    name: 'a HEAD carrying a body',
    bytes: (label) =>
      Buffer.concat([
        head(`HEAD /s/${sessionId}/ HTTP/1.1`, [
          'Host: hook.qa-tools.ru',
          'Connection: close',
          `X-Case: ${label}`,
          'Content-Length: 5',
        ]),
        Buffer.from([0, 1, 0xfe, 0xff, 0x0a]),
      ]),
  },
  {
    name: 'an empty body declared with Content-Length: 0',
    bytes: (label) =>
      head(`POST /s/${sessionId} HTTP/1.1`, [
        'Host: hook.qa-tools.ru',
        'Connection: close',
        `X-Case: ${label}`,
        'Content-Type: application/json',
        'Content-Length: 0',
      ]),
  },
  {
    name: 'a GET with no body at all',
    bytes: (label) =>
      head(`GET /s/${sessionId}?a=1&b=%E9 HTTP/1.1`, [
        'Host: hook.qa-tools.ru',
        'Connection: close',
        `X-Case: ${label}`,
      ]),
  },
  {
    name: 'a QUERY with no Content-Type and no content',
    bytes: (label) =>
      head(`QUERY /s/${sessionId} HTTP/1.1`, [
        'Host: hook.qa-tools.ru',
        'Connection: close',
        `X-Case: ${label}`,
      ]),
  },
  {
    name: 'a chunked body',
    bytes: (label) =>
      Buffer.concat([
        head(`POST /s/${sessionId} HTTP/1.1`, [
          'Host: hook.qa-tools.ru',
          'Connection: close',
          `X-Case: ${label}`,
          'Transfer-Encoding: chunked',
        ]),
        Buffer.from('4\r\n\x00\x01\x02\x03\r\n3\r\nabc\r\n0\r\n\r\n', 'latin1'),
      ]),
  },
  {
    name: 'HTTP/1.0 to a path the router cannot decode',
    bytes: (label) =>
      Buffer.concat([
        head(`POST /s/${sessionId}/caf%E9/%zz?q=%E9 HTTP/1.0`, [
          'Host: hook.qa-tools.ru',
          `X-Case: ${label}`,
          'Content-Length: 2',
        ]),
        Buffer.from('{}'),
      ]),
  },
  {
    name: 'unusual header lines',
    bytes: (label) =>
      Buffer.concat([
        head(`POST /s/${sessionId} HTTP/1.1`, [
          'host: hook.qa-tools.ru',
          'Connection: close',
          `X-Case: ${label}`,
          `X-Latin1: ${LATIN1_VALUE}`,
          'X-Empty:',
          'X-Spaces:    padded value   ',
          'X-Colons: a:b::c: d',
          'X-Tab: one\ttwo',
          'x-dup: first',
          'X-DUP: second',
          'X-Dup: third',
          "!#$%&'*+-.^_`|~: token characters",
          'Set-Cookie: a=1',
          'Set-Cookie: b=2',
          'Content-Type: not a media type',
          `X-Long: ${'v'.repeat(8_000)}`,
          'Content-Length: 3',
        ]),
        Buffer.from([0xc3, 0xa9, 0x00]),
      ]),
  },
  {
    name: '2,500 header lines',
    bytes: (label) =>
      Buffer.concat([
        head(`POST /s/${sessionId} HTTP/1.1`, [
          'Host: hook.qa-tools.ru',
          'Connection: close',
          `X-Case: ${label}`,
          ...Array.from(
            { length: 2_500 },
            (_, index) =>
              `${symbols[Math.floor(index / symbols.length)] as string}:${symbols[index % symbols.length] as string}`,
          ),
          'Content-Length: 1',
        ]),
        Buffer.from('x'),
      ]),
  },
];

describe('the stored raw request (D049, D210)', () => {
  for (const [index, { name, bytes }] of CASES.entries()) {
    it(`is byte for byte what main stored, for ${name}`, async () => {
      const label = `case-${index}`;
      const id = await send(bytes(label));
      const result = await pool.query<{ raw_request: Buffer; body: Buffer }>(
        'SELECT raw_request, body FROM requests WHERE id = $1',
        [id],
      );
      const row = result.rows[0];
      const wanted = expected.get(label);

      assert.ok(row !== undefined, 'not stored');
      assert.ok(wanted !== undefined, 'the handler was not reached');
      assert.ok(
        row.raw_request.equals(wanted),
        `differs: ${row.raw_request.length} bytes stored, ${wanted.length} expected`,
      );
      // And the body is its tail, as it always was.
      assert.ok(
        row.raw_request.subarray(row.raw_request.length - row.body.length).equals(row.body),
      );
    });
  }
});
