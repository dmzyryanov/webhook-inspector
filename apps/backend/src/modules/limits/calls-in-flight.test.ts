/**
 * The calls in flight of each address (D213), without a server: 128 by
 * default, refused `429` / `1019` with `Retry-After: 1`; the place held by
 * the connection until the response closes and by the handler while it runs,
 * given back once when neither holds it; given back at once, for good, for a
 * call refused after it took one; taken again by a handler whose connection
 * went before it started. `calls-in-flight-routes.test.ts` holds the same
 * over real sockets.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS,
  ErrorCode,
  MAX_CALLS_IN_FLIGHT,
} from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import { callsInFlight, createCallPlaces } from './calls-in-flight.ts';

/** What the hold reads of a call: its response's `close`, and whether it is destroyed. */
function fakeCall(): {
  request: FastifyRequest;
  reply: FastifyReply;
  response: EventEmitter & { destroyed: boolean };
} {
  const response = Object.assign(new EventEmitter(), { destroyed: false });

  return {
    request: {} as FastifyRequest,
    reply: { raw: response } as unknown as FastifyReply,
    response,
  };
}

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

/** Runs a wrapped handler as Fastify runs a route's, with the instance as `this`. */
function run(
  handler: RouteHandlerMethod,
  call: { request: FastifyRequest; reply: FastifyReply },
): Promise<unknown> {
  return (
    handler as unknown as (
      this: FastifyInstance,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<unknown>
  ).call({} as FastifyInstance, call.request, call.reply);
}

function isTooManyCalls(limit: number) {
  return (error: unknown) =>
    error instanceof AppError &&
    error.statusCode === 429 &&
    error.errorCode === 1019 &&
    error.headers['retry-after'] === '1' &&
    error.message ===
      `Too many calls in flight: ${limit} at once per address; try again in a moment`;
}

describe('the calls in flight of an address (D213)', () => {
  it('are 128 by default, refused 429 / 1019 with Retry-After: 1', () => {
    assert.equal(MAX_CALLS_IN_FLIGHT, 128);
    assert.equal(CALLS_IN_FLIGHT_RETRY_AFTER_SECONDS, 1);
    assert.equal(ErrorCode.TOO_MANY_CONCURRENT_CALLS, 1019);

    const inFlight = callsInFlight(createCallPlaces());

    for (let index = 0; index < 128; index += 1) {
      const call = fakeCall();

      assert.equal(inFlight.take(call.request, call.reply, 'a'), true);
    }

    const refused = fakeCall();

    assert.equal(inFlight.take(refused.request, refused.reply, 'a'), false);
    assert.equal(refused.response.listenerCount('close'), 0);
    assert.equal(inFlight.places.takenBy('a'), 128);

    // Another address has its own 128.
    const other = fakeCall();

    assert.equal(inFlight.take(other.request, other.reply, 'b'), true);
  });

  it('give a place back when the response closes, once, and the address goes with its last', () => {
    const inFlight = callsInFlight(createCallPlaces(2));
    const call = fakeCall();

    assert.equal(inFlight.take(call.request, call.reply, 'a'), true);
    assert.equal(inFlight.places.taken, 1);
    call.response.emit('close');
    assert.equal(inFlight.places.taken, 0);
    assert.equal(inFlight.places.keys, 0);
    call.response.emit('close');
    assert.equal(inFlight.places.taken, 0);
  });

  it('give the place back at once for a response already destroyed', () => {
    const inFlight = callsInFlight(createCallPlaces(1));
    const gone = fakeCall();

    gone.response.destroyed = true;
    assert.equal(inFlight.take(gone.request, gone.reply, 'a'), true);
    assert.equal(inFlight.places.taken, 0);
  });

  it('give a refused call’s place back at once and for good, whatever holds it', async () => {
    const inFlight = callsInFlight(createCallPlaces(1));
    const call = fakeCall();
    const work = deferred();

    assert.equal(inFlight.take(call.request, call.reply, 'a'), true);

    const answer = run(
      inFlight.holding(() => work.promise),
      call,
    );

    // Refused while the handler runs and its response is open, as `/mcp`'s
    // count refuses a call once its body has arrived.
    inFlight.giveBack(call.request);
    assert.equal(inFlight.places.taken, 0);

    call.response.emit('close');
    work.resolve('answered');
    assert.equal(await answer, 'answered');
    assert.equal(inFlight.places.taken, 0);

    // A call that holds none gives nothing back.
    const none = fakeCall();
    const kept = fakeCall();

    assert.equal(inFlight.take(kept.request, kept.reply, 'a'), true);
    inFlight.giveBack(none.request);
    assert.equal(inFlight.places.taken, 1);
  });
});

/**
 * The handler's hold, as D205's: a handler can wait for the pool or a
 * session's row lock with the request in hand after its client has gone, so
 * the place is kept until it settles.
 */
describe('the place held by the handler while it runs (D213)', () => {
  it('outlasts a close while the handler runs, and goes once when the handler settles', async () => {
    const inFlight = callsInFlight(createCallPlaces(1));
    const call = fakeCall();
    const work = deferred();

    inFlight.take(call.request, call.reply, 'a');

    const answer = run(
      inFlight.holding(() => work.promise),
      call,
    );

    call.response.emit('close');
    assert.equal(
      inFlight.places.taken,
      1,
      'the place went with the connection while the handler ran',
    );

    const next = fakeCall();

    assert.equal(inFlight.take(next.request, next.reply, 'a'), false);

    work.resolve('saved');
    assert.equal(await answer, 'saved');
    assert.equal(inFlight.places.taken, 0);
    call.response.emit('close');
    assert.equal(inFlight.places.taken, 0);
  });

  it('outlasts a close when the handler fails, and goes once', async () => {
    const inFlight = callsInFlight(createCallPlaces(1));
    const call = fakeCall();
    const work = deferred();

    inFlight.take(call.request, call.reply, 'a');

    const answer = run(
      inFlight.holding(() => work.promise),
      call,
    );

    call.response.emit('close');
    work.reject(new Error('the database went away'));
    await assert.rejects(answer, /the database went away/);
    assert.equal(inFlight.places.taken, 0);
  });

  it('is kept after the handler settles until the answer’s response closes', async () => {
    const inFlight = callsInFlight(createCallPlaces(1));
    const call = fakeCall();

    inFlight.take(call.request, call.reply, 'a');
    assert.equal(
      await run(
        inFlight.holding(async () => 'saved'),
        call,
      ),
      'saved',
    );
    assert.equal(inFlight.places.taken, 1, 'the place went before the answer was written');
    call.response.emit('close');
    assert.equal(inFlight.places.taken, 0);
  });

  it('is taken again by a handler whose connection went before it started, and refused with none free', async () => {
    const inFlight = callsInFlight(createCallPlaces(1));
    const call = fakeCall();
    let ran = 0;
    const handler = inFlight.holding(async () => {
      ran += 1;
      assert.equal(inFlight.places.taken, 1, 'the handler ran without a place');

      return 'saved';
    });

    inFlight.take(call.request, call.reply, 'a');
    call.response.emit('close');
    assert.equal(inFlight.places.taken, 0);

    // Another call of the address took the place meanwhile: refused as the
    // 129th is, unrun.
    const other = fakeCall();

    inFlight.take(other.request, other.reply, 'a');
    await assert.rejects(run(handler, call), isTooManyCalls(1));
    assert.equal(ran, 0);
    other.response.emit('close');

    // A place free: taken for the handler and given back once it settles.
    assert.equal(await run(handler, call), 'saved');
    assert.equal(ran, 1);
    assert.equal(inFlight.places.taken, 0);
  });

  it('passes the handler of a call that took no place through, holding nothing', async () => {
    const inFlight = callsInFlight(createCallPlaces(1));
    const call = fakeCall();

    assert.equal(
      await run(
        inFlight.holding(async () => {
          assert.equal(inFlight.places.taken, 0);

          return 'answered';
        }),
        call,
      ),
      'answered',
    );
  });

  it('runs the handler with the instance it was given as this', async () => {
    const inFlight = callsInFlight(createCallPlaces(1));
    const call = fakeCall();
    const instance = { name: 'the instance' } as unknown as FastifyInstance;

    inFlight.take(call.request, call.reply, 'a');

    const seen = await (
      inFlight.holding(function (this: FastifyInstance) {
        return Promise.resolve(this);
      }) as unknown as (this: FastifyInstance, ...args: unknown[]) => Promise<unknown>
    ).call(instance, call.request, call.reply);

    assert.equal(seen, instance);
  });

  it('gives back nothing a refused call no longer holds', async () => {
    const inFlight = callsInFlight(createCallPlaces(1));
    const call = fakeCall();

    inFlight.take(call.request, call.reply, 'a');
    inFlight.giveBack(call.request);
    call.response.emit('close');

    // A handler of a refused call takes no place again.
    const answered = await run(
      inFlight.holding(async () => inFlight.places.taken),
      call,
    );

    assert.equal(answered, 0);
    assert.equal(inFlight.places.taken, 0);
  });
});
