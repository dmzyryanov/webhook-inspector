/**
 * Unit tests of how a route that takes no body reads one sent anyway (D213): at
 * most 1 KiB, `413` past it, the rest never kept. No server and no database:
 * the reading is exercised on a stream standing in for the request, with
 * made-up bodies built to make it keep more, call back twice or never, at
 * growing sizes. The routes' answers are tested in
 * `modules/requests/requests.test.ts`, what a call keeps in
 * `modules/limits/calls-memory.test.ts`.
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { MAX_IGNORED_BODY_BYTES } from '@webhook-inspector/shared';
import { readAtMost } from './ignored-body.ts';

const LIMIT = MAX_IGNORED_BODY_BYTES;

interface Outcome {
  /** Every call of `done`, in order: an error's code, or the bytes' length. */
  calls: (string | number)[];
  /** The bytes of the last call, when it gave any. */
  bytes?: Buffer;
}

/**
 * `readAtMost` on a fresh stream declared `declared` bytes long, fed `chunks`
 * and then ended - or destroyed with `failure` - and its outcome once the
 * stream's events have run.
 */
async function read(
  declared: string | undefined,
  chunks: Iterable<Buffer>,
  { failure }: { failure?: Error } = {},
): Promise<Outcome & { stream: PassThrough }> {
  const stream = new PassThrough();
  const outcome: Outcome = { calls: [] };

  readAtMost(stream, declared, LIMIT, (error, bytes) => {
    outcome.calls.push(
      error === null
        ? (bytes?.length ?? -1)
        : String((error as { code?: string }).code ?? error.message),
    );
    outcome.bytes = bytes;
  });

  for (const chunk of chunks) {
    stream.write(chunk);
  }

  if (failure === undefined) {
    stream.end();
  } else {
    stream.destroy(failure);
  }

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  return { ...outcome, stream };
}

/** `total` bytes of `a`, in chunks of `size`. */
function* pieces(total: number, size: number): Generator<Buffer> {
  for (let sent = 0; sent < total; sent += size) {
    yield Buffer.alloc(Math.min(size, total - sent), 0x61);
  }
}

describe('readAtMost', () => {
  it('is 1 KiB for the routes that take no body', () => {
    assert.equal(LIMIT, 1024);
  });

  it('answers the bytes of a body within the limit, declared or chunked, in one piece or byte by byte', async () => {
    for (const [declared, chunks] of [
      ['0', []],
      [undefined, []],
      ['2', [Buffer.from('{}')]],
      [String(LIMIT), [Buffer.alloc(LIMIT, 0x20)]],
      [String(LIMIT), pieces(LIMIT, 1)],
      [undefined, pieces(LIMIT, 7)],
    ] as const) {
      const outcome = await read(declared, chunks);

      assert.deepEqual(outcome.calls, [outcome.bytes?.length], String(declared));
      assert.equal(
        outcome.bytes?.length,
        declared === undefined ? outcome.bytes?.length : Number(declared),
      );
    }
  });

  it('refuses a declared length over the limit at once, before reading a byte', async () => {
    for (const declared of [String(LIMIT + 1), String(1024 * 1024), '9'.repeat(30), '1e400']) {
      const stream = new PassThrough();
      const calls: string[] = [];

      readAtMost(stream, declared, LIMIT, (error) => {
        calls.push(String((error as { code?: string } | null)?.code));
      });

      assert.deepEqual(calls, ['FST_ERR_CTP_BODY_TOO_LARGE'], declared.slice(0, 12));
      // Not read: no listener, not flowing.
      assert.equal(stream.listenerCount('data'), 0);
      assert.equal(stream.readableFlowing, null);
    }
  });

  // Bodies built to be kept: more than the limit, sent whole, byte by byte,
  // in chunks of 64 KiB, declared shorter than they are or not at all, at
  // growing sizes. Each is refused once, as soon as the limit is passed, and
  // nothing past it is kept: the stream flows on with no listener of this.
  for (const total of [LIMIT + 1, 64 * 1024, 1024 * 1024, 16 * 1024 * 1024]) {
    for (const size of [1, 4_096, 65_536]) {
      if (total / size > 100_000) {
        continue;
      }

      it(`refuses ${total.toLocaleString('en')} bytes in chunks of ${size.toLocaleString('en')} once, past the limit, keeping none`, async () => {
        for (const declared of [undefined, String(LIMIT)]) {
          const outcome = await read(declared, pieces(total, size));

          assert.deepEqual(outcome.calls, ['FST_ERR_CTP_BODY_TOO_LARGE'], String(declared));
          assert.equal(outcome.bytes, undefined);
          assert.equal(outcome.stream.listenerCount('data'), 0);
          assert.equal(outcome.stream.listenerCount('end'), 0);
          assert.equal(outcome.stream.readableEnded, true, 'the rest was not read to its end');
        }
      });
    }
  }

  it('answers a request gone before its end with its error, given 400, once', async () => {
    const aborted = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    const outcome = await read('100', [Buffer.from('{"a":')], { failure: aborted });

    assert.deepEqual(outcome.calls, ['ECONNRESET']);
    assert.equal((aborted as { statusCode?: number }).statusCode, 400);

    // An error that carries a client status keeps it.
    const tooLarge = Object.assign(new Error('too large'), { code: 'X', statusCode: 413 });

    await read(undefined, [], { failure: tooLarge });
    assert.equal(tooLarge.statusCode, 413);
  });

  it('refuses a body that ends at another length than it declared, as Fastify does', async () => {
    for (const [declared, body] of [
      ['10', 'short'],
      ['-1', 'x'],
      ['1e3', 'x'],
    ] as const) {
      const outcome = await read(declared, [Buffer.from(body)]);

      assert.deepEqual(outcome.calls, ['FST_ERR_CTP_INVALID_CONTENT_LENGTH'], declared);
    }

    // A length that is no number is read as an undeclared one.
    const outcome = await read('abc', [Buffer.from('{}')]);

    assert.deepEqual(outcome.calls, [2]);
  });
});
