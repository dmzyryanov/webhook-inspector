/**
 * The counter of the per-address limits and the key an address counts under
 * (D201), without a server: windows, separate limits, IPv6 `/64`, bounded
 * memory, and hostile addresses at growing sizes.
 */
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import {
  API_CALL_LIMIT,
  RATE_LIMIT_WINDOW_SECONDS,
  SESSION_CREATE_LIMIT,
} from '@webhook-inspector/shared';
import { withinBound } from '../../testing/timing.ts';
import {
  addressKey,
  DEFAULT_RATE_LIMITS,
  SWEEP_SPACING_MS,
  UNREADABLE_ADDRESS,
  WindowCounter,
} from './rate-limit.ts';

const MINUTE = RATE_LIMIT_WINDOW_SECONDS * 1000;

/**
 * Milliseconds a counter may take for 100,000 calls of distinct addresses,
 * the fastest of up to five runs (`withinBound`, D203): 1000. The calls take
 * 59 to 74 ms alone and up to 184 ms beside the full backend suite and eight
 * busy loops (F-07, After #378). Their keys are made before the counter is
 * timed: with `addressKey` on the same addresses, as until #378, a run took
 * 2.7 to 2.9 s alone and 3.6 to 7.1 s under that load, over the 5000 ms of
 * then in 10 of 15 rounds. A counter that walks its whole map on every
 * call, F-07's mutation, takes 8.4 s for 40,000 calls and 63 s for the
 * 100,000: over the bound on every run.
 */
const COUNTER_BOUND_MS = 1_000;

/** A clock a test moves by hand, starting at an arbitrary instant. */
function manualClock(start = 5_000.25): { now: () => number; advance: (ms: number) => void } {
  let time = start;

  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

/**
 * A clock moved by hand together with the timers, which `context` mocks: what
 * passes for the counter passes for its timer too, as in production, where
 * both are the process's monotonic time.
 */
function timedClock(context: TestContext): { now: () => number; pass: (ms: number) => void } {
  const clock = manualClock();

  context.mock.timers.enable({ apis: ['setTimeout'] });

  return {
    now: clock.now,
    pass: (ms) => {
      clock.advance(ms);
      context.mock.timers.tick(ms);
    },
  };
}

/** The key of the `index`-th of up to 2^24 IPv4 addresses. */
function ipv4(index: number): string {
  return addressKey(`10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`);
}

describe('the production limits (D201)', () => {
  it('are 60 session creations and 1200 other calls per address per minute', () => {
    assert.equal(RATE_LIMIT_WINDOW_SECONDS, 60);
    assert.equal(SESSION_CREATE_LIMIT, 60);
    assert.equal(API_CALL_LIMIT, 1200);
    assert.deepEqual(DEFAULT_RATE_LIMITS, { sessionCreates: 60, apiCalls: 1200 });
  });
});

describe('a window counter', () => {
  it('allows the limit, counting down by one, and refuses the next with nothing remaining', () => {
    const clock = manualClock();
    const counter = new WindowCounter(60, { now: clock.now });

    for (let call = 1; call <= 60; call += 1) {
      const verdict = counter.hit('203.0.113.7');

      assert.deepEqual(verdict, {
        allowed: true,
        limit: 60,
        remaining: 60 - call,
        resetSeconds: 60,
        windowStart: 5_000.25,
      });
    }

    assert.deepEqual(counter.hit('203.0.113.7'), {
      allowed: false,
      limit: 60,
      remaining: 0,
      resetSeconds: 60,
      windowStart: 5_000.25,
    });
  });

  it('reports the whole seconds left in the window, never less than 1', () => {
    const clock = manualClock();
    const counter = new WindowCounter(5, { now: clock.now });

    assert.equal(counter.hit('a').resetSeconds, 60);
    clock.advance(1);
    assert.equal(counter.hit('a').resetSeconds, 60);
    clock.advance(999);
    assert.equal(counter.hit('a').resetSeconds, 59);
    clock.advance(MINUTE - 1000 - 1);
    // One millisecond is left: a client told 0 would come back too early.
    assert.equal(counter.hit('a').resetSeconds, 1);
  });

  it('reads the seconds left again later, as an answer sent after its call does, 1 once the window has ended', () => {
    const clock = manualClock();
    const counter = new WindowCounter(5, { now: clock.now });
    const { windowStart, resetSeconds } = counter.hit('a');

    assert.equal(resetSeconds, 60);
    assert.equal(counter.secondsLeft(windowStart), 60);
    clock.advance(30_000);
    assert.equal(counter.secondsLeft(windowStart), 30);
    clock.advance(29_999.5);
    assert.equal(counter.secondsLeft(windowStart), 1);
    clock.advance(0.5);
    assert.equal(counter.secondsLeft(windowStart), 1, 'the window has ended');
    clock.advance(45_000);
    assert.equal(counter.secondsLeft(windowStart), 1);

    // Measured as the verdict is, so a fresh window reads 60 here too.
    const start = 71_072.7;
    const fresh = new WindowCounter(60, { now: () => start });

    assert.equal(fresh.secondsLeft(fresh.hit('a').windowStart), 60);
  });

  it('reads 60 for a fresh window and never more, wherever the clock stands', () => {
    // A window started at 71072.7 ms ends at 131072, two to the 17th, where
    // the sum rounds: its end minus now was 60000.00000000001 and read 61.
    assert.equal(new WindowCounter(60, { now: () => 71_072.7 }).hit('a').resetSeconds, 60);

    // Starts with fractions, as `performance.now()` gives, whose windows end
    // just past a power of two, at uptimes from two minutes to 35 years; and
    // each window's refusals across its life, the first in the same instant
    // as its first call, `Retry-After` being the same number.
    const fresh: number[] = [];
    const refused: string[] = [];

    for (const exponent of [17, 18, 20, 24, 30, 40]) {
      for (let step = 1; step <= 1_000; step += 1) {
        const start = 2 ** exponent - MINUTE + step / 7;
        let time = start;
        const counter = new WindowCounter(1, { now: () => time });

        if (counter.hit('a').resetSeconds !== 60) {
          fresh.push(start);
        }

        for (const elapsed of [0, 0.001, 999.999, 1_000, 30_000.5, MINUTE - 1, MINUTE - 0.001]) {
          time = start + elapsed;

          const verdict = counter.hit('a');

          if (verdict.allowed || verdict.resetSeconds < 1 || verdict.resetSeconds > 60) {
            refused.push(`${start} + ${elapsed}: ${JSON.stringify(verdict)}`);
          }
        }
      }
    }

    assert.equal(
      fresh.length,
      0,
      `${fresh.length} fresh windows read other than 60, as ${fresh[0]}`,
    );
    assert.equal(refused.length, 0, `${refused.length} refusals out of 1 to 60, as ${refused[0]}`);
  });

  it('starts a fresh window once the last one has ended, whatever was refused in it', () => {
    const clock = manualClock();
    const counter = new WindowCounter(2, { now: clock.now });

    counter.hit('a');
    counter.hit('a');

    for (let refused = 0; refused < 10; refused += 1) {
      assert.equal(counter.hit('a').allowed, false);
    }

    clock.advance(MINUTE - 1);
    assert.equal(counter.hit('a').allowed, false, 'the window has a millisecond left');
    clock.advance(1);

    // A refused call was not counted: the new window allows the whole limit.
    assert.deepEqual(counter.hit('a'), {
      allowed: true,
      limit: 2,
      remaining: 1,
      resetSeconds: 60,
      windowStart: 5_000.25 + MINUTE,
    });
    assert.equal(counter.hit('a').allowed, true);
    assert.equal(counter.hit('a').allowed, false);
  });

  it("starts each key's window with that key's first call", () => {
    const clock = manualClock();
    const counter = new WindowCounter(1, { now: clock.now });

    counter.hit('early');
    clock.advance(30_000);
    counter.hit('late');
    clock.advance(30_000);

    assert.equal(counter.hit('early').allowed, true, "early's window has ended");
    assert.deepEqual(counter.hit('late'), {
      allowed: false,
      limit: 1,
      remaining: 0,
      resetSeconds: 30,
      windowStart: 5_000.25 + 30_000,
    });
  });

  it('counts each key on its own', () => {
    const clock = manualClock();
    const counter = new WindowCounter(1, { now: clock.now });

    assert.equal(counter.hit('198.51.100.1').allowed, true);
    assert.equal(counter.hit('198.51.100.1').allowed, false);
    assert.equal(counter.hit('198.51.100.2').allowed, true);
  });

  it('keeps two limits apart: exhausting one leaves the other untouched', () => {
    const clock = manualClock();
    const creates = new WindowCounter(SESSION_CREATE_LIMIT, { now: clock.now });
    const calls = new WindowCounter(API_CALL_LIMIT, { now: clock.now });

    for (let call = 0; call < SESSION_CREATE_LIMIT; call += 1) {
      creates.hit('a');
    }

    assert.equal(creates.hit('a').allowed, false);
    assert.equal(calls.hit('a').remaining, API_CALL_LIMIT - 1);

    for (let call = 1; call < API_CALL_LIMIT; call += 1) {
      calls.hit('b');
    }

    assert.equal(calls.hit('b').remaining, 0);
    assert.equal(calls.hit('b').allowed, false);
    assert.equal(creates.hit('b').remaining, SESSION_CREATE_LIMIT - 1);
  });

  it('refuses a limit that is not a positive whole number', () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => new WindowCounter(limit), /positive integer/, String(limit));
    }
  });
});

describe('the memory a window counter holds (D201)', () => {
  // `size` reads the counter's `Map` and removes nothing: what these tests see
  // is what the calls and the timer removed, as they remove it in production,
  // where nothing reads `size`.

  it('holds no entry for 100,000 addresses once their windows have ended and a call comes', () => {
    const clock = manualClock();
    const counter = new WindowCounter(API_CALL_LIMIT, { now: clock.now });

    for (let index = 0; index < 100_000; index += 1) {
      counter.hit(ipv4(index));
    }

    assert.equal(counter.size, 100_000);
    clock.advance(MINUTE - 1);
    counter.hit('fresh');
    assert.equal(counter.size, 100_001, 'their windows have a millisecond left');
    clock.advance(1);
    counter.hit('fresh');
    assert.equal(counter.size, 1);
    counter.close();
  });

  it('holds no entry for 100,000 addresses once their windows have ended, with no call at all', (t) => {
    const clock = timedClock(t);
    const counter = new WindowCounter(API_CALL_LIMIT, { now: clock.now });

    for (let index = 0; index < 100_000; index += 1) {
      counter.hit(ipv4(index));
    }

    clock.pass(MINUTE - 1);
    assert.equal(counter.size, 100_000, 'their windows have a millisecond left');
    clock.pass(1);
    assert.equal(counter.size, 0);
  });

  it('drops the ended windows of a counter while only another counter is called', (t) => {
    const clock = timedClock(t);
    const creates = new WindowCounter(SESSION_CREATE_LIMIT, { now: clock.now });
    const calls = new WindowCounter(API_CALL_LIMIT, { now: clock.now });

    for (let index = 0; index < 100_000; index += 1) {
      creates.hit(ipv4(index));
    }

    // A minute and more of calls of the other kind, one a second.
    for (let second = 0; second <= 60; second += 1) {
      calls.hit('203.0.113.7');
      clock.pass(1_000);
    }

    assert.equal(creates.size, 0);
    assert.equal(calls.size, 1);
  });

  it('drops each window within a second of its end when no call comes', (t) => {
    const clock = timedClock(t);
    const counter = new WindowCounter(1, { now: clock.now });

    counter.hit('first');
    clock.pass(1);
    counter.hit('a millisecond later');
    clock.pass(29_999);
    counter.hit('half a window later');
    clock.pass(30_000 - 1);
    assert.equal(counter.size, 3, 'the first window has a millisecond left');
    clock.pass(1);
    assert.equal(counter.size, 2);

    // The next ends a millisecond later, and the timer runs a second later:
    // windows ending together cost one sweep, never one each.
    clock.pass(SWEEP_SPACING_MS - 1);
    assert.equal(counter.size, 2);
    clock.pass(1);
    assert.equal(counter.size, 1);

    // The last, on the timer set for its end.
    clock.pass(30_000 - SWEEP_SPACING_MS - 1);
    assert.equal(counter.size, 1);
    clock.pass(1);
    assert.equal(counter.size, 0);

    // A window counted once it is empty is swept too: the timer is set again.
    clock.pass(5 * MINUTE);
    counter.hit('much later');
    clock.pass(MINUTE);
    assert.equal(counter.size, 0);
  });

  it('drops ended windows on every call, so it holds the addresses of the last window alone', () => {
    const clock = manualClock();
    const counter = new WindowCounter(10, { now: clock.now });

    // One new address every 10 ms for five minutes: 30,000 addresses, of
    // which at most a window's 6,000 are running at any moment.
    for (let index = 0; index < 30_000; index += 1) {
      counter.hit(`key-${index}`);
      assert.ok(counter.size <= 6_000, `${counter.size} held after ${index + 1} addresses`);
      clock.advance(10);
    }

    // The window of the address counted 60 s ago has just ended: the next
    // call drops it, and 5,999 are still running beside the new one.
    counter.hit('fresh');
    assert.equal(counter.size, 6_000);
    counter.close();
  });

  it('puts a key whose window ended back at the end, so later windows still end in order', () => {
    const clock = manualClock();
    const counter = new WindowCounter(1, { now: clock.now });

    counter.hit('a');
    clock.advance(10);
    counter.hit('b');
    clock.advance(MINUTE);
    // `a` and `b` have both ended; `a` starts again and `c` after it.
    counter.hit('a');
    clock.advance(10);
    counter.hit('c');
    assert.equal(counter.size, 2);
    clock.advance(MINUTE - 10);
    // `a`'s new window has ended and `c`'s has not: the call drops the
    // first, and is refused in the second.
    assert.equal(counter.hit('c').allowed, false);
    assert.equal(counter.size, 1);
    assert.equal(counter.hit('a').allowed, true);
    counter.close();
  });

  it('counts 100,000 distinct addresses quickly', () => {
    // The keys are made before the counter is timed: `addressKey` on 100,000
    // addresses is most of the time, and is not what this holds (F-07).
    const keys = Array.from({ length: 100_000 }, (_, index) =>
      addressKey(`2001:db8:${(index >> 16).toString(16)}:${(index & 0xffff).toString(16)}::1`),
    );
    // Held to the bound by `withinBound` (F-07): a run that a loaded machine
    // stops is made again, with a fresh counter, while a counter that walks
    // its whole map on every call is over the bound on every run.
    const run = (): number => {
      const counter = new WindowCounter(API_CALL_LIMIT);

      try {
        for (const key of keys) {
          counter.hit(key);
        }

        return counter.size;
      } finally {
        counter.close();
      }
    };

    assert.equal(withinBound(COUNTER_BOUND_MS, run), 100_000);
  });
});

describe('the key an address counts under (D201)', () => {
  it('is an IPv4 address itself', () => {
    assert.equal(addressKey('203.0.113.7'), '203.0.113.7');
    assert.equal(addressKey('127.0.0.1'), '127.0.0.1');
    assert.notEqual(addressKey('203.0.113.7'), addressKey('203.0.113.8'));
  });

  it('unwraps IPv4-mapped IPv6 to the IPv4 address, in either spelling', () => {
    assert.equal(addressKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(addressKey('::ffff:cb00:7107'), '203.0.113.7');
    assert.equal(addressKey('::FFFF:203.0.113.7'), '203.0.113.7');
  });

  it('is the /64 of any other IPv6 address, however it is spelled', () => {
    const key = addressKey('2001:db8:1:2::1');

    assert.equal(key, '2001:db8:1:2::/64');

    for (const sameNetwork of [
      '2001:db8:1:2:ffff:ffff:ffff:ffff',
      '2001:0DB8:0001:0002:0000:0000:0000:0001',
      '2001:db8:1:2:a:b:c:d',
      '2001:db8:1:2::9%eth0',
    ]) {
      assert.equal(addressKey(sameNetwork), key, sameNetwork);
    }

    for (const otherNetwork of ['2001:db8:1:3::1', '2001:db8:2:2::1', '2001:db9:1:2::1']) {
      assert.notEqual(addressKey(otherNetwork), key, otherNetwork);
    }

    assert.equal(addressKey('::1'), '::/64');
    assert.equal(addressKey('fe80::1%en0'), 'fe80::/64');
  });

  it('is one shared key for whatever does not parse, under the strict rule', () => {
    for (const value of [
      undefined,
      '',
      ' ',
      'unknown',
      '1',
      '127.1',
      '0x7f.0.0.1',
      '203.0.113.7, 198.51.100.1',
      '256.0.0.1',
      '2001:db8::1::2',
      '203.0.113.7:443',
      '[2001:db8::1]',
    ]) {
      assert.equal(addressKey(value), UNREADABLE_ADDRESS, String(value));
    }
  });

  it('answers hostile values of 1 KiB, 64 KiB and 1 MiB within 100 ms, as unreadable', () => {
    const shapes = [
      (size: number) => '1'.repeat(size),
      (size: number) => '1.'.repeat(size / 2),
      (size: number) => ':'.repeat(size),
      (size: number) => 'f:'.repeat(size / 2),
      (size: number) => `2001:db8::1%${'z'.repeat(size)}`,
      (size: number) => `${'%'.repeat(size)}1.2.3.4`,
      (size: number) => '\u0000'.repeat(size),
      (size: number) => `::ffff:${'9'.repeat(size)}`,
      (size: number) => Array.from({ length: size }, (_, index) => (index * 7919) % 10).join(''),
    ];

    for (const size of [1024, 64 * 1024, 1024 * 1024]) {
      for (const shape of shapes) {
        const value = shape(size);
        const started = performance.now();

        assert.equal(addressKey(value), UNREADABLE_ADDRESS);
        assert.ok(performance.now() - started < 100, `${size} bytes took over 100 ms`);
      }
    }
  });
});
