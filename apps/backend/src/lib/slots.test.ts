/**
 * The places counted per key, without a server (D213): what the calls in
 * flight of each address are counted with. Each key has its own places; one
 * asked for beyond them is refused; a place is given back once however often
 * it is given back; and a key is kept only while it holds a place, so keys
 * seen over time leave nothing behind.
 *
 * And the places with a queue (D244), the gate in front of the API's work:
 * one asked for beyond them waits, never refused; the waiting are served
 * round robin by key and in order within one; one whose signal aborts leaves
 * the queue having taken nothing; a place is given back once.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createKeyedSlots, createSlots, createWaitingSlots } from './slots.ts';

describe('places counted per key (D213)', () => {
  it('gives each key its own places and refuses the next of a key that has them all', () => {
    const slots = createKeyedSlots(3);

    assert.equal(slots.limit, 3);

    const first = [slots.tryTake('a'), slots.tryTake('a'), slots.tryTake('a')];

    assert.ok(first.every((release) => release !== null));
    assert.equal(slots.tryTake('a'), null);
    assert.equal(slots.takenBy('a'), 3);

    // Another key is unaffected.
    const other = slots.tryTake('b');

    assert.notEqual(other, null);
    assert.equal(slots.takenBy('b'), 1);
    assert.equal(slots.taken, 4);
    assert.equal(slots.keys, 2);

    // One given back lets the next of that key in.
    first[0]?.();
    assert.equal(slots.takenBy('a'), 2);
    assert.notEqual(slots.tryTake('a'), null);
    assert.equal(slots.tryTake('a'), null);
  });

  it('gives a place back once, however often it is given back', () => {
    const slots = createKeyedSlots(2);
    const release = slots.tryTake('a');
    const kept = slots.tryTake('a');

    assert.ok(release !== null && kept !== null);

    release();
    release();
    release();

    assert.equal(slots.takenBy('a'), 1);
    assert.equal(slots.taken, 1);

    kept();
    kept();

    assert.equal(slots.taken, 0);
    assert.equal(slots.takenBy('a'), 0);
  });

  it('keeps a key only while it holds a place', () => {
    const slots = createKeyedSlots(2);
    const release = slots.tryTake('a');

    assert.equal(slots.keys, 1);
    release?.();
    assert.equal(slots.keys, 0);

    // A refused key is never kept.
    const none = createKeyedSlots(0);

    assert.equal(none.tryTake('a'), null);
    assert.equal(none.keys, 0);
    assert.equal(none.taken, 0);
  });

  it('leaves no key behind after 100,000 keys have taken and given back their places', () => {
    const slots = createKeyedSlots(128);
    const releases: (() => void)[] = [];

    for (let index = 0; index < 100_000; index += 1) {
      const release = slots.tryTake(`key-${index}`);

      assert.ok(release !== null);
      releases.push(release);
    }

    assert.equal(slots.keys, 100_000);
    assert.equal(slots.taken, 100_000);

    for (const release of releases) {
      release();
    }

    assert.equal(slots.keys, 0);
    assert.equal(slots.taken, 0);
  });

  it('counts apart from the places of the process, which are not keyed', () => {
    const process = createSlots(1);
    const keyed = createKeyedSlots(1);

    assert.notEqual(process.tryTake(), null);
    assert.equal(process.tryTake(), null);
    assert.notEqual(keyed.tryTake('a'), null);
    assert.notEqual(keyed.tryTake('b'), null);
  });
});

/** Lets every promise job queued so far run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Takes of `slots`, recording the order in which they are granted and what gives each back. */
function recorder(slots: ReturnType<typeof createWaitingSlots>): {
  take(name: string, key: string, signal?: AbortSignal): Promise<(() => void) | null>;
  granted: string[];
  /** Gives back the place of the take granted last. */
  releaseLast(): void;
} {
  const granted: string[] = [];
  const releases: (() => void)[] = [];

  return {
    granted,
    take: async (name, key, signal = new AbortController().signal) => {
      const release = await slots.take(key, signal);

      if (release !== null) {
        granted.push(name);
        releases.push(release);
      }

      return release;
    },
    releaseLast: () => releases.at(-1)?.(),
  };
}

describe('places with a queue, served round robin by key (D244)', () => {
  it('grants at once while a place is free, and makes the next wait, never refusing it', async () => {
    const slots = createWaitingSlots(2);
    const first = await slots.take('a', new AbortController().signal);
    const second = await slots.take('b', new AbortController().signal);

    assert.ok(first !== null && second !== null);
    assert.equal(slots.taken, 2);

    let third: (() => void) | null | undefined;

    void slots.take('c', new AbortController().signal).then((release) => {
      third = release;
    });
    await settle();
    assert.equal(third, undefined, 'the third was granted with both places taken');
    assert.equal(slots.waiting, 1);

    first();
    await settle();
    assert.equal(typeof third, 'function');
    assert.equal(slots.taken, 2);
    assert.equal(slots.waiting, 0);
  });

  it('serves the waiting in order within a key and round robin across keys', async () => {
    const slots = createWaitingSlots(1);
    const calls = recorder(slots);
    const holder = await slots.take('x', new AbortController().signal);

    assert.ok(holder !== null);

    // Key a queues four, then b two, then c one: a's four do not keep b and c
    // waiting behind them all.
    const pending = [
      calls.take('a1', 'a'),
      calls.take('a2', 'a'),
      calls.take('a3', 'a'),
      calls.take('a4', 'a'),
      calls.take('b1', 'b'),
      calls.take('b2', 'b'),
      calls.take('c1', 'c'),
    ];

    await settle();
    assert.equal(slots.waiting, 7);
    assert.equal(slots.keys, 3);

    // One place: each release grants exactly the next in turn.
    holder();

    for (let index = 1; index < pending.length; index += 1) {
      await settle();
      assert.equal(calls.granted.length, index);
      calls.releaseLast();
    }

    await Promise.all(pending);
    calls.releaseLast();
    assert.deepEqual(calls.granted, ['a1', 'b1', 'c1', 'a2', 'b2', 'a3', 'a4']);
    assert.equal(slots.taken, 0);
    assert.equal(slots.waiting, 0);
    assert.equal(slots.keys, 0);
  });

  it('puts a key that comes back after its queue emptied at the back of the round', async () => {
    const slots = createWaitingSlots(1);
    const calls = recorder(slots);
    const holder = await slots.take('x', new AbortController().signal);

    assert.ok(holder !== null);

    const a1 = calls.take('a1', 'a');
    const b1 = calls.take('b1', 'b');

    holder();

    const first = await a1;

    // a's queue is empty now; its next take comes after b's waiting one.
    const a2 = calls.take('a2', 'a');

    first?.();

    const second = await b1;

    second?.();
    (await a2)?.();
    assert.deepEqual(calls.granted, ['a1', 'b1', 'a2']);
  });

  it('drops a waiting take whose signal aborts, which takes nothing and keeps nobody waiting', async () => {
    const slots = createWaitingSlots(1);
    const calls = recorder(slots);
    const holder = await slots.take('x', new AbortController().signal);

    assert.ok(holder !== null);

    const gone = new AbortController();
    const dropped = calls.take('gone', 'a', gone.signal);
    const kept = calls.take('kept', 'a');
    const other = calls.take('other', 'b');

    await settle();
    assert.equal(slots.waiting, 3);

    gone.abort();
    assert.equal(await dropped, null);
    assert.equal(slots.waiting, 2);

    holder();

    const next = await kept;

    next?.();

    const last = await other;

    last?.();
    assert.deepEqual(calls.granted, ['kept', 'other']);
    assert.equal(slots.taken, 0);
    assert.equal(slots.waiting, 0);
    assert.equal(slots.keys, 0);

    // A signal aborted before the take takes nothing either, place free or not.
    const before = new AbortController();

    before.abort();
    assert.equal(await slots.take('a', before.signal), null);
    assert.equal(slots.taken, 0);
  });

  it('gives a place back once, however often, and a release after the take is granted does not abort it', async () => {
    const slots = createWaitingSlots(2);
    const signal = new AbortController();
    const release = await slots.take('a', signal.signal);
    const kept = await slots.take('b', new AbortController().signal);

    assert.ok(release !== null && kept !== null);

    // Aborting the signal once the place is held changes nothing.
    signal.abort();
    assert.equal(slots.taken, 2);

    release();
    release();
    release();
    assert.equal(slots.taken, 1);

    // One waiting is granted by a release, and only one by it.
    const waiting = [
      slots.take('c', new AbortController().signal),
      slots.take('d', new AbortController().signal),
      slots.take('e', new AbortController().signal),
    ];
    const granted = await waiting[0];

    await settle();
    assert.equal(slots.taken, 2);
    assert.equal(slots.waiting, 2);

    kept();
    kept();
    await settle();
    assert.equal(slots.taken, 2);
    assert.equal(slots.waiting, 1);

    granted?.();
    (await waiting[1])?.();
    (await waiting[2])?.();
    assert.equal(slots.taken, 0);
  });

  it('serves 10,000 waiting from 100 keys round robin, leaving nothing behind', async () => {
    const slots = createWaitingSlots(6);
    const held = await Promise.all(
      Array.from({ length: 6 }, () => slots.take('x', new AbortController().signal)),
    );
    const order: string[] = [];
    const pending: Promise<void>[] = [];

    for (let key = 0; key < 100; key += 1) {
      for (let index = 0; index < 100; index += 1) {
        pending.push(
          slots.take(`k${key}`, new AbortController().signal).then((release) => {
            order.push(`k${key}`);
            release?.();
          }),
        );
      }
    }

    assert.equal(slots.waiting, 10_000);

    for (const release of held) {
      release?.();
    }

    await Promise.all(pending);

    // Every round serves each key once: the first 100 grants are 100 keys.
    assert.equal(new Set(order.slice(0, 100)).size, 100);
    assert.equal(order.length, 10_000);
    assert.equal(slots.taken, 0);
    assert.equal(slots.waiting, 0);
    assert.equal(slots.keys, 0);
  });
});
