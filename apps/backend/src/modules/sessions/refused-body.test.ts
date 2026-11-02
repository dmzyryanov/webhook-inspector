/**
 * Unit tests of the rule deciding how a connection ends after the create route
 * refuses a request before reading its body (D143). No server and no database:
 * the decision is made from the headers alone, and the drain is exercised on a
 * stream standing in for the request. The raw-socket test that shows the
 * refusal reaching a client is in `sessions.test.ts`.
 */
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { MAX_BODY_BYTES } from '@webhook-inspector/shared';
import { MAX_CONCURRENT_REFUSAL_DRAINS } from '@webhook-inspector/shared';
import {
  createRefusalDrainPlaces,
  drainRefusedBody,
  drainRequestBody,
  isBodyArriving,
  MAX_REFUSAL_DRAIN_BYTES,
  shouldDrainRefusedBody,
} from './refused-body.ts';

const HOST = ['Host', 'qa-tools.ru'];

function withLength(value: string): string[] {
  return [...HOST, 'Content-Length', value];
}

describe('MAX_REFUSAL_DRAIN_BYTES', () => {
  it('is four times the body limit, 4 MiB', () => {
    assert.equal(MAX_REFUSAL_DRAIN_BYTES, 4 * MAX_BODY_BYTES);
    assert.equal(MAX_REFUSAL_DRAIN_BYTES, 4 * 1024 * 1024);
  });
});

describe('shouldDrainRefusedBody', () => {
  it('leaves a kept-alive connection alone, whatever the body: Node drains it', () => {
    for (const rawHeaders of [
      withLength('1'),
      withLength(String(MAX_REFUSAL_DRAIN_BYTES)),
      withLength(String(MAX_REFUSAL_DRAIN_BYTES + 1)),
      [...HOST, 'Transfer-Encoding', 'chunked'],
      HOST,
    ]) {
      assert.equal(shouldDrainRefusedBody(rawHeaders, true), false, JSON.stringify(rawHeaders));
    }
  });

  it('does nothing when no body is framed', () => {
    for (const rawHeaders of [[], HOST, withLength('0'), withLength(' 0 ')]) {
      assert.equal(shouldDrainRefusedBody(rawHeaders, false), false, JSON.stringify(rawHeaders));
    }
  });

  it('drains a declared length up to and including the limit', () => {
    for (const rawHeaders of [
      withLength('1'),
      // The body of the raw-socket test in sessions.test.ts: just over the
      // body limit, which is why the limit is not MAX_BODY_BYTES itself.
      withLength(String(MAX_BODY_BYTES + 37)),
      withLength(String(MAX_REFUSAL_DRAIN_BYTES)),
      [...HOST, 'content-length', '27'],
      [...HOST, 'CONTENT-LENGTH', '27'],
    ]) {
      assert.equal(shouldDrainRefusedBody(rawHeaders, false), true, JSON.stringify(rawHeaders));
    }
  });

  it('answers at once past the limit', () => {
    assert.equal(
      shouldDrainRefusedBody(withLength(String(MAX_REFUSAL_DRAIN_BYTES + 1)), false),
      false,
    );
    assert.equal(shouldDrainRefusedBody(withLength('9'.repeat(30)), false), false);
  });

  it('answers at once when a transfer encoding is announced, chunked included', () => {
    for (const rawHeaders of [
      [...HOST, 'Transfer-Encoding', 'chunked'],
      [...HOST, 'transfer-encoding', 'gzip, chunked'],
      // Node's parser refuses both together; the rule does not rely on it.
      [...HOST, 'Transfer-Encoding', 'chunked', 'Content-Length', '27'],
    ]) {
      assert.equal(shouldDrainRefusedBody(rawHeaders, false), false, JSON.stringify(rawHeaders));
    }
  });

  it('answers at once when the declared length is not beyond doubt', () => {
    for (const rawHeaders of [
      [...HOST, 'Content-Length', '27', 'Content-Length', '27'],
      [...HOST, 'Content-Length', '27', 'content-length', '28'],
      withLength(''),
      withLength('abc'),
      withLength('-1'),
      withLength('+27'),
      withLength('1.5'),
      withLength('1e3'),
      withLength('0x10'),
      withLength('27, 27'),
      withLength('2 7'),
    ]) {
      assert.equal(shouldDrainRefusedBody(rawHeaders, false), false, JSON.stringify(rawHeaders));
    }
  });
});

/**
 * The rule that ends a connection answered while its body is still arriving
 * (D213, the second outside review's finding 1): Node's `complete` says the
 * body has not all arrived, and the framing headers say there is one. The
 * raw-socket tests that show the connection ending are in
 * `modules/limits/calls-in-flight-routes.test.ts`.
 */
describe('isBodyArriving', () => {
  function message(rawHeaders: string[], complete: boolean | undefined) {
    return { rawHeaders, complete } as Pick<IncomingMessage, 'complete' | 'rawHeaders'>;
  }

  const FRAMED = [
    withLength('1'),
    withLength(String(MAX_BODY_BYTES)),
    withLength('9'.repeat(30)),
    withLength('00'),
    withLength('abc'),
    [...HOST, 'Transfer-Encoding', 'chunked'],
    [...HOST, 'transfer-encoding', 'gzip'],
    [...HOST, 'CONTENT-LENGTH', '27'],
    [...HOST, 'Content-Length', '0', 'Content-Length', '5'],
  ];

  it('is true for a body framed and not all arrived', () => {
    for (const rawHeaders of FRAMED) {
      assert.equal(isBodyArriving(message(rawHeaders, false)), true, JSON.stringify(rawHeaders));
    }
  });

  it('is false once the whole body has arrived', () => {
    for (const rawHeaders of FRAMED) {
      assert.equal(isBodyArriving(message(rawHeaders, true)), false, JSON.stringify(rawHeaders));
    }
  });

  it('is false for a request that is not Node’s, whose completeness nobody tells', () => {
    for (const rawHeaders of FRAMED) {
      assert.equal(
        isBodyArriving(message(rawHeaders, undefined)),
        false,
        JSON.stringify(rawHeaders),
      );
    }
  });

  it('is false when no body is framed, whenever it is asked', () => {
    for (const rawHeaders of [
      [],
      HOST,
      withLength('0'),
      withLength(' 0 '),
      [...HOST, 'Content-Length', '0', 'content-length', '0'],
    ]) {
      assert.equal(isBodyArriving(message(rawHeaders, false)), false, JSON.stringify(rawHeaders));
    }
  });

  // Made-up header lists built to make the rule slow or wrong, at growing
  // sizes: every line a `Content-Length` of `0` but the last, the framing
  // line after thousands of others, and values of a megabyte.
  for (const lines of [10, 1_000, 100_000, 1_000_000]) {
    it(`reads ${lines.toLocaleString('en')} header lines to the last one`, () => {
      const zeros: string[] = [];
      const others: string[] = [];

      for (let line = 0; line < lines; line += 1) {
        zeros.push('Content-Length', '0');
        others.push(`x-${line}`, 'y');
      }

      assert.equal(isBodyArriving(message(zeros, false)), false);
      assert.equal(isBodyArriving(message([...zeros, 'content-length', '1'], false)), true);
      assert.equal(
        isBodyArriving(message([...others, 'Transfer-Encoding', 'chunked'], false)),
        true,
      );
      assert.equal(isBodyArriving(message(others, false)), false);
      assert.equal(isBodyArriving(message([...others, 'Content-Length', '7'], true)), false);
    });
  }

  for (const bytes of [1_024, 1_048_576, 16_777_216]) {
    it(`reads a value of ${bytes.toLocaleString('en')} bytes`, () => {
      assert.equal(isBodyArriving(message(withLength('0'.repeat(bytes)), false)), true);
      assert.equal(isBodyArriving(message(withLength(' '.repeat(bytes) + '0'), false)), false);
      assert.equal(isBodyArriving(message(withLength('9'.repeat(bytes)), false)), true);
      assert.equal(isBodyArriving(message([...HOST, 'x'.repeat(bytes), '1'], false)), false);
    });
  }
});

describe('drainRequestBody', () => {
  function request(): PassThrough & IncomingMessage {
    return new PassThrough() as PassThrough & IncomingMessage;
  }

  /** Whether `promise` has settled once pending events have run. */
  async function hasSettled(promise: Promise<void>): Promise<boolean> {
    let settled = false;

    void promise.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    return settled;
  }

  it('reads the body to its end and not before, and keeps none of it', async () => {
    const body = request();
    const drained = drainRequestBody(body);

    body.write(Buffer.alloc(64 * 1024, 'a'));
    assert.equal(await hasSettled(drained), false, 'settled with the body still arriving');

    body.end(Buffer.alloc(64 * 1024, 'a'));
    await drained;

    assert.equal(body.readableEnded, true);
    assert.equal(body.readableLength, 0);
  });

  it('settles when the request goes away before its end', async () => {
    const body = request();
    const drained = drainRequestBody(body);

    body.write('partial');
    body.destroy(new Error('aborted'));

    await drained;
  });

  it('settles at once for a body that has already ended', async () => {
    const body = request();

    body.end();
    body.resume();
    await new Promise((resolve) => body.once('end', resolve));

    await drainRequestBody(body);
  });
});

describe('drainRefusedBody, the process’s drain places (D228)', () => {
  function request(rawHeaders: string[]): PassThrough & IncomingMessage {
    const body = new PassThrough() as PassThrough & IncomingMessage;

    body.rawHeaders = rawHeaders;

    return body;
  }

  /** A request framing a body of `length`, which a drain reads to its end. */
  function arriving(length = 27): PassThrough & IncomingMessage {
    return request([...HOST, 'Content-Length', String(length)]);
  }

  async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;

    void promise.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    return settled;
  }

  it('is eight at once, process-wide', () => {
    assert.equal(MAX_CONCURRENT_REFUSAL_DRAINS, 8);
  });

  it('drains a body D143 would, holding one place until it ends', async () => {
    const places = createRefusalDrainPlaces();
    const body = arriving();
    const result = drainRefusedBody(body, false, places);

    assert.equal(places.taken, 1, 'a place is held while the body is read');
    assert.equal(await hasSettled(result), false, 'settled before the body ended');

    body.end(Buffer.alloc(27, 'a'));
    assert.equal(await result, 'drained');
    assert.equal(places.taken, 0, 'the place is given back');
  });

  it('takes no place and drains nothing for a body D143 leaves alone', async () => {
    const places = createRefusalDrainPlaces();

    assert.equal(await drainRefusedBody(arriving(), true, places), 'none', 'kept-alive');
    assert.equal(await drainRefusedBody(request(HOST), false, places), 'none', 'no body framed');
    assert.equal(
      await drainRefusedBody(request([...HOST, 'Transfer-Encoding', 'chunked']), false, places),
      'none',
      'chunked',
    );
    assert.equal(places.taken, 0);
  });

  it('drains at most eight at once, and answers the ninth at once without a place', async () => {
    const places = createRefusalDrainPlaces();
    const bodies = Array.from({ length: MAX_CONCURRENT_REFUSAL_DRAINS }, () => arriving());
    const draining = bodies.map((body) => drainRefusedBody(body, false, places));

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(places.taken, MAX_CONCURRENT_REFUSAL_DRAINS, 'all eight places held');

    // The ninth, with every place taken, is answered at once: its body
    // undrained and its connection to be ended by the caller (D228).
    const ninth = arriving();

    assert.equal(await drainRefusedBody(ninth, false, places), 'no-place');
    assert.equal(ninth.readableEnded, false, 'the ninth body was not read');

    // A place frees as a drain ends, and the next body may take it.
    bodies[0]?.end(Buffer.alloc(27, 'a'));
    assert.equal(await draining[0], 'drained');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(places.taken, MAX_CONCURRENT_REFUSAL_DRAINS - 1);

    const afterOneFreed = arriving();
    const last = drainRefusedBody(afterOneFreed, false, places);

    assert.equal(places.taken, MAX_CONCURRENT_REFUSAL_DRAINS, 'the freed place is taken');
    afterOneFreed.end(Buffer.alloc(27, 'a'));
    assert.equal(await last, 'drained');

    for (const body of bodies.slice(1)) {
      body.end(Buffer.alloc(27, 'a'));
    }

    await Promise.all(draining);
    assert.equal(places.taken, 0, 'every place is given back');
  });

  it('gives a place back even when the drained request goes away mid-body', async () => {
    const places = createRefusalDrainPlaces(1);
    const body = arriving();
    const result = drainRefusedBody(body, false, places);

    assert.equal(places.taken, 1);
    body.write('partial');
    body.destroy(new Error('aborted'));
    assert.equal(await result, 'drained');
    assert.equal(places.taken, 0, 'the place is back after a client left mid-drain');
    // With the one place free again the next drain takes it.
    const next = arriving();
    const draining = drainRefusedBody(next, false, places);

    assert.equal(places.taken, 1);
    next.end(Buffer.alloc(27, 'a'));
    assert.equal(await draining, 'drained');
  });
});
