/**
 * The places of large queue-bearing bodies (D205), without a server: which
 * framing makes a body large, made-up framing headers at growing sizes, the
 * refusal when every place is taken, and the place held by the connection
 * until the response closes and by the handler while it runs, given back
 * once when neither holds it. `large-body-places.test.ts` holds the same over
 * real sockets, on both routes and on every way a call ends.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  ErrorCode,
  LARGE_BODIES_RETRY_AFTER_SECONDS,
  LARGE_BODY_THRESHOLD_BYTES,
  MAX_BODY_BYTES,
  MAX_CONCURRENT_LARGE_BODIES,
} from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import { ordinaryFullQueue, ordinaryFullResponse } from '../../testing/full-queue.ts';
import { withinBound } from '../../testing/timing.ts';
import { createLargeBodyPlaces, isLargeBody, largeBodyHandling } from './large-bodies.ts';

const JSON_TYPE = ['Content-Type', 'application/json'];

function length(value: number | string): string[] {
  return [...JSON_TYPE, 'Content-Length', String(value)];
}

describe('the places of large bodies (D205)', () => {
  it('are eight per process, for bodies over 128 KiB, refused with Retry-After: 1', () => {
    assert.equal(MAX_CONCURRENT_LARGE_BODIES, 8);
    assert.equal(LARGE_BODY_THRESHOLD_BYTES, 128 * 1024);
    assert.equal(LARGE_BODIES_RETRY_AFTER_SECONDS, 1);
    assert.equal(ErrorCode.LARGE_BODIES_BUSY, 1017);

    const places = createLargeBodyPlaces();

    for (let taken = 0; taken < 8; taken += 1) {
      assert.notEqual(places.tryTake(), null);
    }

    assert.equal(places.tryTake(), null);
  });

  it('leave a creation with a response alone, and a queue of one full step, under the threshold', () => {
    const response = Buffer.byteLength(JSON.stringify({ response: ordinaryFullResponse() }));
    const oneStep = Buffer.byteLength(JSON.stringify({ steps: [ordinaryFullResponse()] }));
    const fullQueue = Buffer.byteLength(JSON.stringify({ steps: ordinaryFullQueue() }));

    assert.ok(response < LARGE_BODY_THRESHOLD_BYTES, `${response} bytes`);
    assert.ok(oneStep < LARGE_BODY_THRESHOLD_BYTES, `${oneStep} bytes`);
    assert.ok(fullQueue > LARGE_BODY_THRESHOLD_BYTES && fullQueue <= MAX_BODY_BYTES);
  });
});

describe('which body is large, from its framing alone (D205)', () => {
  it('none without a body, and none at or under the threshold', () => {
    assert.equal(isLargeBody([]), false);
    assert.equal(isLargeBody(JSON_TYPE), false);
    assert.equal(isLargeBody(length(0)), false);
    assert.equal(isLargeBody(length(1)), false);
    assert.equal(isLargeBody(length(LARGE_BODY_THRESHOLD_BYTES)), false);
    assert.equal(isLargeBody(length(`000${LARGE_BODY_THRESHOLD_BYTES}`)), false);
  });

  it('one over the threshold up to the 1 MiB limit, whatever the header name’s case', () => {
    assert.equal(isLargeBody(length(LARGE_BODY_THRESHOLD_BYTES + 1)), true);
    assert.equal(isLargeBody(length(MAX_BODY_BYTES)), true);
    assert.equal(isLargeBody(length(` ${MAX_BODY_BYTES}\t`)), true);
    assert.equal(isLargeBody(['CONTENT-LENGTH', String(MAX_BODY_BYTES)]), true);
    assert.equal(isLargeBody(['content-length', `0000${LARGE_BODY_THRESHOLD_BYTES + 1}`]), true);
  });

  it('none over the 1 MiB limit, which is refused 413 before it is read', () => {
    assert.equal(isLargeBody(length(MAX_BODY_BYTES + 1)), false);
    assert.equal(isLargeBody(length(4 * MAX_BODY_BYTES)), false);
    assert.equal(isLargeBody(length('9'.repeat(400))), false);
  });

  it('one for a chunked body, or any Transfer-Encoding, whose length is not known yet', () => {
    assert.equal(isLargeBody([...JSON_TYPE, 'Transfer-Encoding', 'chunked']), true);
    assert.equal(isLargeBody(['transfer-encoding', 'gzip, chunked']), true);
    assert.equal(isLargeBody(['Transfer-Encoding', '']), true);
    assert.equal(isLargeBody(['Transfer-Encoding', 'chunked', 'Content-Length', '5']), true);
  });

  it('one for framing the headers do not settle', () => {
    for (const declared of ['', ' ', '+5', '-1', '0x20000', '1e6', '5.0', '1 2', '５', 'abc']) {
      assert.equal(isLargeBody(length(declared)), true, JSON.stringify(declared));
    }

    assert.equal(isLargeBody(['Content-Length', '5', 'Content-Length', '5']), true);
    assert.equal(isLargeBody(['Content-Length', '5', 'content-length', '200000']), true);
  });

  it('answers made-up framing of 1 KiB, 64 KiB and 1 MiB within 100 ms each, as it deserves', () => {
    for (const size of [1024, 64 * 1024, 1024 * 1024]) {
      const cases: [string, string[], boolean][] = [
        ['digits', length('9'.repeat(size)), false],
        ['zeros then a large length', length('0'.repeat(size) + '200000'), true],
        ['zeros then a small length', length('0'.repeat(size) + '5'), false],
        ['digits then a letter', length('1'.repeat(size) + 'a'), true],
        ['spaces', length(' '.repeat(size)), true],
        ['a long Transfer-Encoding', ['Transfer-Encoding', 'chunked,'.repeat(size / 8)], true],
        [
          'many headers before the length',
          [...Array.from({ length: size / 16 }, (_, i) => [`x-${i}`, 'v']).flat(), ...length(5)],
          false,
        ],
        [
          'many lengths',
          Array.from({ length: size / 16 }, () => ['Content-Length', '200000']).flat(),
          true,
        ],
        ['a long header name', ['c'.repeat(size), '200000', ...length(5)], false],
      ];

      for (const [what, headers, expected] of cases) {
        // The fastest of up to five runs, so that another file on the same
        // cores cannot fail a linear check (D203, `testing/timing.ts`).
        const answer = withinBound(100, () => isLargeBody(headers));

        assert.equal(answer, expected, `${what} at ${size} bytes`);
      }
    }
  });
});

/**
 * What the guard reads of a request and a reply: the headers, `close`, whether
 * destroyed, whether kept alive, and the body a refusal may drain - a stream
 * the test ends.
 */
function fakeCall(
  rawHeaders: string[],
  keepAlive = true,
): {
  request: FastifyRequest;
  reply: FastifyReply;
  response: EventEmitter & { destroyed: boolean };
  body: PassThrough;
} {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    shouldKeepAlive: keepAlive,
  });
  const body = Object.assign(new PassThrough(), { rawHeaders });

  return {
    request: { raw: body } as unknown as FastifyRequest,
    reply: { raw: response } as unknown as FastifyReply,
    response,
    body,
  };
}

describe('the guard of the routes that read a large body (D205, D213)', () => {
  it('takes a place for a large body, none for a small one, and gives it back when the response closes', async () => {
    const places = createLargeBodyPlaces(2);
    const { guard } = largeBodyHandling(places);
    const small = fakeCall(length(1024));
    const large = fakeCall(length(200_000));

    await guard(small.request, small.reply);
    assert.equal(places.taken, 0);
    assert.equal(small.response.listenerCount('close'), 0);

    await guard(large.request, large.reply);
    assert.equal(places.taken, 1);
    large.response.emit('close');
    assert.equal(places.taken, 0);
    large.response.emit('close');
    assert.equal(places.taken, 0);
  });

  it('gives the place back at once for a response already destroyed', async () => {
    const places = createLargeBodyPlaces(1);
    const gone = fakeCall(length(200_000));

    gone.response.destroyed = true;
    await largeBodyHandling(places).guard(gone.request, gone.reply);
    assert.equal(places.taken, 0);
  });

  it('refuses the one after the last place at once: 429 / 1017 with Retry-After: 1', async () => {
    const places = createLargeBodyPlaces(1);
    const { guard } = largeBodyHandling(places);
    const first = fakeCall(length(200_000));

    await guard(first.request, first.reply);

    for (const headers of [length(200_000), [...JSON_TYPE, 'Transfer-Encoding', 'chunked']]) {
      const refused = fakeCall(headers);

      await assert.rejects(
        guard(refused.request, refused.reply),
        (error: unknown) =>
          error instanceof AppError &&
          error.statusCode === 429 &&
          error.errorCode === 1017 &&
          error.headers['retry-after'] === '1' &&
          error.message === 'Too many large bodies are being saved; try again in a moment',
      );
      assert.equal(refused.response.listenerCount('close'), 0);
    }

    // A small body still passes, with every place taken.
    const small = fakeCall(length(LARGE_BODY_THRESHOLD_BYTES));

    await guard(small.request, small.reply);
    assert.equal(places.taken, 1);
    first.response.emit('close');
    assert.equal(places.taken, 0);
  });

  it('tells the listener of each call it refuses, before the refusal, and of no other (D213)', async () => {
    const places = createLargeBodyPlaces(1);
    const told: FastifyRequest[] = [];
    const { guard } = largeBodyHandling(places, (request) => {
      told.push(request);
    });
    const first = fakeCall(length(200_000));
    const small = fakeCall(length(1024));
    const refused = fakeCall(length(200_000));

    await guard(first.request, first.reply);
    await guard(small.request, small.reply);
    assert.deepEqual(told, []);

    await assert.rejects(guard(refused.request, refused.reply), AppError);
    assert.deepEqual(told, [refused.request]);
  });

  it('tells it of no call whose body it drains on a connection that closes, which keeps its place in flight (D213)', async () => {
    const places = createLargeBodyPlaces(1);
    const told: FastifyRequest[] = [];
    const { guard } = largeBodyHandling(places, (request) => {
      told.push(request);
    });
    const first = fakeCall(length(200_000));

    await guard(first.request, first.reply);

    // Declared and on a connection that closes: drained before the refusal,
    // and the listener is not told, so the call keeps its place among the
    // calls in flight until its response closes.
    const drained = fakeCall(length(200_000), false);
    const refusing = guard(drained.request, drained.reply);
    let settled = false;

    refusing.then(
      () => (settled = true),
      () => (settled = true),
    );
    drained.body.write('{"mode":');
    await nextTurn();
    assert.equal(settled, false, 'refused before its body ended');
    drained.body.end(' "default"}');
    await assert.rejects(
      refusing,
      (error: unknown) =>
        error instanceof AppError && error.errorCode === ErrorCode.LARGE_BODIES_BUSY,
    );
    assert.deepEqual(told, []);

    // Chunked on a connection that closes, which is never drained (D143): the
    // listener is told, before the refusal.
    const chunked = fakeCall([...JSON_TYPE, 'Transfer-Encoding', 'chunked'], false);

    await assert.rejects(guard(chunked.request, chunked.reply), AppError);
    assert.deepEqual(told, [chunked.request]);
    assert.equal(places.taken, 1);
  });
});

/** A promise settled from outside, as a handler waiting for the database is. */
function deferred(): {
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/**
 * The handler's hold (correction round 4, the outside review's finding): a
 * handler can wait for the pool or the session's lock with the parsed body in
 * hand after its client has gone, so the place is kept until it settles.
 */
describe('the place held by the handler while it runs (D205)', () => {
  it('outlasts a close while the handler runs, and goes once when the handler settles', async () => {
    const places = createLargeBodyPlaces(1);
    const { guard, holding } = largeBodyHandling(places);
    const call = fakeCall(length(200_000));
    const work = deferred();
    const handled = holding(() => work.promise);

    await guard(call.request, call.reply);

    const answer = handled(call.request, call.reply);

    call.response.emit('close');
    assert.equal(places.taken, 1, 'the place went with the connection while the handler ran');
    assert.equal(places.tryTake(), null);

    work.resolve('saved');
    assert.equal(await answer, 'saved');
    assert.equal(places.taken, 0);
    call.response.emit('close');
    assert.equal(places.taken, 0);
  });

  it('outlasts a close while the handler runs when the handler fails, and goes once', async () => {
    const places = createLargeBodyPlaces(1);
    const { guard, holding } = largeBodyHandling(places);
    const call = fakeCall(length(200_000));
    const work = deferred();

    await guard(call.request, call.reply);

    const answer = holding(() => work.promise)(call.request, call.reply);

    call.response.emit('close');
    assert.equal(places.taken, 1);
    work.reject(new Error('the database went away'));
    await assert.rejects(answer, /the database went away/);
    assert.equal(places.taken, 0);
  });

  it('is kept after the handler settles until the answer’s response closes', async () => {
    const places = createLargeBodyPlaces(1);
    const { guard, holding } = largeBodyHandling(places);
    const call = fakeCall(length(200_000));

    await guard(call.request, call.reply);
    assert.equal(await holding(async () => 'saved')(call.request, call.reply), 'saved');
    assert.equal(places.taken, 1, 'the place went before the answer was written');

    call.response.emit('close');
    assert.equal(places.taken, 0);
    call.response.emit('close');
    assert.equal(places.taken, 0);
  });

  it('is taken again by a handler whose connection went before it started, and refused with none free', async () => {
    const places = createLargeBodyPlaces(1);
    const { guard, holding } = largeBodyHandling(places);
    const call = fakeCall(length(200_000));
    let ran = 0;
    const handled = holding(async () => {
      ran += 1;
      assert.equal(places.taken, 1, 'the handler ran without a place');

      return 'saved';
    });

    await guard(call.request, call.reply);
    call.response.emit('close');
    assert.equal(places.taken, 0);

    // Another body took the place meanwhile: refused as the ninth is, unrun.
    const other = places.tryTake();

    await assert.rejects(
      handled(call.request, call.reply),
      (error: unknown) =>
        error instanceof AppError && error.statusCode === 429 && error.errorCode === 1017,
    );
    assert.equal(ran, 0);
    other?.();

    // A place free: taken for the handler and given back once it settles.
    assert.equal(await handled(call.request, call.reply), 'saved');
    assert.equal(ran, 1);
    assert.equal(places.taken, 0);
  });

  it('passes a small body’s handler through, holding nothing', async () => {
    const places = createLargeBodyPlaces(1);
    const { guard, holding } = largeBodyHandling(places);
    const small = fakeCall(length(1024));

    await guard(small.request, small.reply);
    assert.equal(
      await holding(async () => {
        assert.equal(places.taken, 0);

        return 'saved';
      })(small.request, small.reply),
      'saved',
    );
    assert.equal(places.taken, 0);
  });
});

describe('the place given back by the route itself (D213)', () => {
  it('goes at once and once, whatever the connection does afterwards, and nothing for a call that took none', async () => {
    const places = createLargeBodyPlaces(2);
    const { guard, release } = largeBodyHandling(places);
    const large = fakeCall(length(200_000));
    const small = fakeCall(length(1024));

    await guard(large.request, large.reply);
    await guard(small.request, small.reply);
    assert.equal(places.taken, 1);

    // `POST /mcp` once its message is read and checked: what it keeps
    // afterwards is not the body.
    release(large.request);
    assert.equal(places.taken, 0);

    // Another call takes the place freed; the first's close gives back nothing.
    const next = fakeCall(length(200_000));

    await guard(next.request, next.reply);
    assert.equal(places.taken, 1);
    release(large.request);
    large.response.emit('close');
    assert.equal(places.taken, 1);

    release(small.request);
    assert.equal(places.taken, 1);
    next.response.emit('close');
    assert.equal(places.taken, 0);
  });
});
