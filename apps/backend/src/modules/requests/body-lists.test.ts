/**
 * The places of list answers with bodies (D201), without a server: which
 * answers take one, the refusal when none is free, and the place given back
 * when the answer ends, fails or its stream is destroyed, and when its
 * response closes first - before the answer is begun included.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import {
  ErrorCode,
  MAX_CONCURRENT_BODY_LISTS,
  type RequestListEntry,
} from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import {
  createBodyListPlaces,
  NO_PLACE,
  releaseWhenAnswered,
  takeBodyListPlace,
} from './body-lists.ts';
import { jsonArrayStream, type ListedEntry, type ReadListedContent } from './list-answer.ts';
import { PLAIN_LIST, type ListQuery } from './list-query.ts';

const HEADERS: ListQuery = { ...PLAIN_LIST, includeHeaders: true };
const BODY: ListQuery = { ...PLAIN_LIST, includeBody: true };
const BOTH: ListQuery = { ...PLAIN_LIST, includeHeaders: true, includeBody: true };

/** What `takeBodyListPlace` reads of a response: its `close` and whether it is destroyed. */
function fakeResponse(): ServerResponse & EventEmitter {
  const response = new EventEmitter() as ServerResponse & EventEmitter;

  Object.defineProperty(response, 'destroyed', { value: false, writable: true });

  return response;
}

/** A place taken from `places`, and whether it has been given back. */
function counted(): { places: ReturnType<typeof createBodyListPlaces>; release: () => void } {
  const places = createBodyListPlaces(1);
  const release = places.tryTake();

  assert.ok(release !== null);

  return { places, release };
}

function chosen(id: string): ListedEntry {
  const entry: RequestListEntry = {
    id,
    method: 'POST',
    receivedAt: '2026-10-04T09:00:00.000Z',
    bodySize: 1,
    sourceIp: null,
    path: null,
    response: null,
  };

  return { entry, receivedAt: '2026-10-04 09:00:00.000000+00' };
}

const NO_MORE = async (): Promise<ListedEntry[]> => [];

describe('which list answers take a place (D201)', () => {
  it('is four per process by default', () => {
    const places = createBodyListPlaces();

    assert.equal(MAX_CONCURRENT_BODY_LISTS, 4);

    for (let answer = 0; answer < 4; answer += 1) {
      takeBodyListPlace(places, BODY, fakeResponse());
    }

    assert.equal(places.taken, 4);
  });

  it('takes one for an answer with bodies, with or without headers', () => {
    const places = createBodyListPlaces(2);
    const first = takeBodyListPlace(places, BODY, fakeResponse());
    const second = takeBodyListPlace(places, BOTH, fakeResponse());

    assert.notEqual(first, NO_PLACE);
    assert.notEqual(second, NO_PLACE);
    assert.equal(places.taken, 2);
    first();
    second();
    assert.equal(places.taken, 0);
  });

  it('takes none for an answer without include or with headers alone, however many', () => {
    const places = createBodyListPlaces(1);
    const response = fakeResponse();

    takeBodyListPlace(places, BODY, fakeResponse());

    for (let answer = 0; answer < 100; answer += 1) {
      assert.equal(takeBodyListPlace(places, PLAIN_LIST, response), NO_PLACE);
      assert.equal(takeBodyListPlace(places, HEADERS, response), NO_PLACE);
    }

    assert.equal(places.taken, 1);
    assert.equal(response.listenerCount('close'), 0, 'an answer without a place listens');
  });

  it('refuses the answer after the last place at once: 429 / 1016 with Retry-After: 1', () => {
    const places = createBodyListPlaces(4);

    for (let answer = 0; answer < 4; answer += 1) {
      takeBodyListPlace(places, BODY, fakeResponse());
    }

    const refused = fakeResponse();

    assert.throws(
      () => takeBodyListPlace(places, BOTH, refused),
      (error) =>
        error instanceof AppError &&
        error.statusCode === 429 &&
        error.errorCode === ErrorCode.LIST_BODIES_BUSY &&
        error.errorCode === 1016 &&
        error.headers['retry-after'] === '1',
    );
    assert.equal(places.taken, 4);
    assert.equal(refused.listenerCount('close'), 0);
  });

  it('gives a place back once however often it is given back', () => {
    const places = createBodyListPlaces(2);
    const response = fakeResponse();
    const release = takeBodyListPlace(places, BODY, response);

    takeBodyListPlace(places, BODY, fakeResponse());
    release();
    release();
    response.emit('close');
    assert.equal(places.taken, 1);
  });
});

describe('a place given back when the answer is over (D201)', () => {
  it('when the stream has been read to its end', async () => {
    const { places, release } = counted();
    const stream = Readable.from(['[', ']']);

    releaseWhenAnswered(stream, release);
    assert.equal(places.taken, 1);

    const read: string[] = [];

    for await (const piece of stream) {
      read.push(String(piece));
      assert.equal(places.taken, 1, 'given back before the end');
    }

    await tick();
    assert.equal(read.join(''), '[]');
    assert.equal(places.taken, 0);
  });

  it('when the stream fails', async () => {
    const { places, release } = counted();
    const stream = Readable.from(
      (async function* failing() {
        yield '[';
        throw new Error('a content read failed');
      })(),
    );

    releaseWhenAnswered(stream, release);
    await assert.rejects(async () => {
      await stream.toArray();
    }, /a content read failed/);
    await tick();
    assert.equal(places.taken, 0);
  });

  it('when the stream is destroyed, as when its client has gone', async () => {
    const { places, release } = counted();
    const stream = Readable.from(['[', '{}', ']']);

    releaseWhenAnswered(stream, release);
    stream.destroy();
    await tick();
    assert.equal(places.taken, 0);
  });

  it('when the response closes before the answer is begun, as when its client goes during the list statement', () => {
    const places = createBodyListPlaces(1);
    const response = fakeResponse();

    takeBodyListPlace(places, BODY, response);
    assert.equal(places.taken, 1);
    // No stream yet: the list statement is still running.
    response.emit('close');
    assert.equal(places.taken, 0);
  });

  it('when the response closes first, though the stream was never read', () => {
    const places = createBodyListPlaces(1);
    const response = fakeResponse();
    const release = takeBodyListPlace(places, BODY, response);
    const stream = Readable.from(['[', ']']);

    releaseWhenAnswered(stream, release);
    response.emit('close');
    assert.equal(places.taken, 0);
    stream.destroy();
  });

  it('once, when the response closes before the answer is begun and its stream closes later', async () => {
    const places = createBodyListPlaces(2);
    const response = fakeResponse();
    const release = takeBodyListPlace(places, BODY, response);

    response.emit('close');
    takeBodyListPlace(places, BODY, fakeResponse());
    assert.equal(places.taken, 1);

    // The statement settles, and the answer to no one is begun and destroyed.
    const stream = Readable.from(['[', ']']);

    releaseWhenAnswered(stream, release);
    stream.destroy();
    await tick();
    assert.equal(places.taken, 1, "the other answer's place was given back");
  });

  it('at once for a stream or a response already destroyed', () => {
    const first = counted();
    const destroyedStream = Readable.from(['[]']);

    destroyedStream.destroy();
    releaseWhenAnswered(destroyedStream, first.release);
    assert.equal(first.places.taken, 0);

    const places = createBodyListPlaces(1);
    const gone = fakeResponse();

    Object.assign(gone, { destroyed: true });
    takeBodyListPlace(places, BODY, gone);
    assert.equal(places.taken, 0);
  });

  it('listens to nothing for an answer that took no place', () => {
    const stream = Readable.from(['[]']);
    const response = fakeResponse();

    assert.equal(takeBodyListPlace(createBodyListPlaces(1), HEADERS, response), NO_PLACE);
    releaseWhenAnswered(stream, NO_PLACE);
    assert.equal(stream.listenerCount('close'), 0);
    assert.equal(response.listenerCount('close'), 0);
  });

  it('when a list answer with bodies fails at a content read', async () => {
    const { places, release } = counted();
    const failingRead: ReadListedContent = async () => {
      throw new Error('the database went away');
    };
    const stream = jsonArrayStream([chosen('a'), chosen('b')], BODY, failingRead, NO_MORE);

    releaseWhenAnswered(stream, release);
    await assert.rejects(async () => {
      await stream.toArray();
    }, /the database went away/);
    await tick();
    assert.equal(places.taken, 0);
  });

  it('when a list answer with bodies is written to its end', async () => {
    const { places, release } = counted();
    const read: ReadListedContent = async (ids) =>
      new Map(ids.map((id) => [id, { body: Buffer.from(`body of ${id}`) }]));
    const stream = jsonArrayStream([chosen('a'), chosen('b')], BODY, read, NO_MORE);

    releaseWhenAnswered(stream, release);

    let text = '';

    for await (const piece of stream) {
      text += String(piece);
    }

    await tick();
    assert.equal(
      (JSON.parse(text) as { body: string }[]).map((item) => item.body).join(),
      'body of a,body of b',
    );
    assert.equal(places.taken, 0);
  });
});
