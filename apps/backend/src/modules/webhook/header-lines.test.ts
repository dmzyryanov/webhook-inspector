/**
 * The header lines in flight (#182, D238), without a socket: `scanLines`,
 * which follows a connection's bytes through the framing of its requests and
 * says how many the parser may be given, and `createHeaderLineBudget`, which
 * counts the lines per address and per process and wakes those waiting.
 *
 * The scanner is a parser of sorts, so it is held against hostile input of
 * growing sizes - every slice it allows is at least a byte unless it waits,
 * and the lines it counts do not depend on where the bytes are cut - and
 * against a model: random pipelines of well-formed requests, heads of up to
 * 300 lines, bodies of declared length and chunked full of the bytes that
 * end lines and heads, trailer sections, CR LF between messages, cut at
 * random points and scanned with random room, count exactly their request
 * lines, header lines and trailer lines, end each head and each message at
 * its last byte, and never count a byte of a body (`testing/pipelines.ts`).
 * That Node's parser reads the same pipelines the same way is
 * `header-lines-bound.test.ts`'s.
 */
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { describe, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  MAX_HEADER_LINES_IN_FLIGHT,
  MAX_HEADER_LINES_IN_FLIGHT_PER_ADDRESS,
} from '@webhook-inspector/shared';
import { modelPipeline, nastyBytes, random, type Modelled } from '../../testing/pipelines.ts';
import { withinBound } from '../../testing/timing.ts';
import {
  createHeaderLineBudget,
  framingAfterHead,
  NEXT_HEAD,
  scanLines,
  type Framing,
  type LineAccount,
} from './header-lines.ts';

const CHUNKED: Framing = { kind: 'chunk-size', size: 0, sized: false };

/**
 * Scans `bytes` as the bound would, in reads cut at `cuts` and slices of at
 * most `room()` lines, the lines of a section given back at its end, and
 * the body's framing after each head taken from `afterHead`. Answers the
 * lines of each section, where each head and message ended, and how many
 * times it waited for room.
 */
function scanAll(
  bytes: Buffer,
  cuts: number[],
  room: () => number,
  afterHead: (head: number) => Framing,
): {
  sections: number[];
  headEnds: number[];
  messageEnds: number[];
  waits: number;
  slices: number;
} {
  let framing: Framing = NEXT_HEAD;
  let held = 0;
  let heads = 0;
  let waits = 0;
  let slices = 0;
  const sections: number[] = [];
  const headEnds: number[] = [];
  const messageEnds: number[] = [];
  const reads = [...cuts, bytes.length];
  let from = 0;

  for (const readEnd of reads) {
    while (from < readEnd) {
      const allowance = room();
      const scanned = scanLines(bytes, from, readEnd, framing, allowance);

      assert.ok(scanned.lines <= allowance, `${scanned.lines} lines with room for ${allowance}`);

      if (scanned.length === 0) {
        assert.ok(scanned.waits, `nothing given at ${from} without waiting`);
        waits += 1;
        assert.ok(waits < 10_000_000, 'waits for ever');
        continue;
      }

      slices += 1;
      from += scanned.length;
      held += scanned.lines;
      framing = scanned.framing;

      if (scanned.ends === 'head') {
        sections.push(held);
        held = 0;
        headEnds.push(from);
        framing = afterHead(heads);
        heads += 1;

        if (framing === NEXT_HEAD) {
          messageEnds.push(from);
        }
      } else if (scanned.ends === 'message') {
        sections.push(held);
        held = 0;
        messageEnds.push(from);
      }
    }
  }

  return { sections, headEnds, messageEnds, waits, slices };
}

function framingOf(request: Modelled): Framing {
  return request.body === 'none'
    ? NEXT_HEAD
    : request.body === 'length'
      ? { kind: 'body', remaining: request.length }
      : CHUNKED;
}

describe('the lines Node’s parser is given (#182)', () => {
  it('counts a head’s request line and header lines, and ends it at the empty line, before its body', () => {
    const text = 'POST /s/x HTTP/1.1\r\nHost: h\r\na:\r\nContent-Length: 9\r\n\r\na:\r\n\n\r\n\nb';
    const bytes = Buffer.from(text, 'latin1');
    const scanned = scanLines(bytes, 0, bytes.length, NEXT_HEAD, Number.POSITIVE_INFINITY);

    assert.deepEqual(
      { length: scanned.length, lines: scanned.lines, ends: scanned.ends, waits: scanned.waits },
      { length: text.indexOf('\r\n\r\n') + 4, lines: 4, ends: 'head', waits: false },
    );
    assert.deepEqual(scanned.framing, { kind: 'after-head' });

    // The body: nine bytes of lines and head ends, none of them a line.
    const body = scanLines(bytes, scanned.length, bytes.length, { kind: 'body', remaining: 9 }, 0);

    assert.deepEqual(
      { length: body.length, lines: body.lines, ends: body.ends },
      { length: 9, lines: 0, ends: 'message' },
    );
    assert.equal(body.framing, NEXT_HEAD);
  });

  it('counts a line from its first byte, so that a connection with no room has none of its next line parsed', () => {
    const bytes = Buffer.from('GET / HTTP/1.1\r\nHost: h\r\na: 1\r\nb: 2\r\n\r\n', 'latin1');

    assert.deepEqual(
      { ...scanLines(bytes, 0, bytes.length, NEXT_HEAD, 0), framing: undefined },
      { length: 0, lines: 0, ends: null, framing: undefined, waits: true },
    );

    const two = scanLines(bytes, 0, bytes.length, NEXT_HEAD, 2);

    assert.equal(two.length, 'GET / HTTP/1.1\r\nHost: h\r\n'.length);
    assert.equal(two.lines, 2);
    assert.equal(two.waits, true);
    assert.deepEqual(two.framing, { kind: 'head', started: true, line: 'start' });

    // Inside a line with no room: on to its LF, and no further.
    const inside = scanLines(
      bytes,
      3,
      bytes.length,
      { kind: 'head', started: true, line: 'inside' },
      0,
    );

    assert.equal(inside.length, 'GET / HTTP/1.1\r\n'.length - 3);
    assert.equal(inside.waits, true);
  });

  it('needs no room for the empty line that ends a head or a trailer section', () => {
    const bytes = Buffer.from('\r\nGET', 'latin1');
    const end = scanLines(
      bytes,
      0,
      bytes.length,
      { kind: 'head', started: true, line: 'start' },
      0,
    );

    assert.deepEqual([end.length, end.lines, end.ends], [2, 0, 'head']);

    const trailers = scanLines(bytes, 0, bytes.length, { kind: 'trailers', line: 'start' }, 0);

    assert.deepEqual([trailers.length, trailers.lines, trailers.ends], [2, 0, 'message']);
    assert.equal(trailers.framing, NEXT_HEAD);

    // Its CR and LF in two reads.
    const cr = scanLines(bytes, 0, 1, { kind: 'head', started: true, line: 'start' }, 0);

    assert.deepEqual([cr.length, cr.lines, cr.ends], [1, 0, null]);
    assert.deepEqual(cr.framing, { kind: 'head', started: true, line: 'cr' });

    const lf = scanLines(bytes, 1, bytes.length, cr.framing, 0);

    assert.deepEqual([lf.length, lf.ends], [1, 'head']);
  });

  it('skips the CR and LF Node’s parser skips before a request line, counting none', () => {
    const bytes = Buffer.from('\r\n\n\r\n\r\r\nGET /\n\r\n', 'latin1');
    const scanned = scanLines(bytes, 0, bytes.length, NEXT_HEAD, Number.POSITIVE_INFINITY);

    assert.deepEqual([scanned.length, scanned.lines, scanned.ends], [bytes.length, 1, 'head']);

    const junk = scanLines(bytes, 0, bytes.length, NEXT_HEAD, 0);

    assert.deepEqual([junk.length, junk.lines, junk.ends, junk.waits], [8, 0, null, true]);
    assert.equal(junk.framing, NEXT_HEAD);
  });

  it('counts a line ended by a bare LF as one, the HTTP/0.9 request line among them', () => {
    const bytes = Buffer.from('GET /\na:\nb:\r\n\r\n', 'latin1');
    const scanned = scanLines(bytes, 0, bytes.length, NEXT_HEAD, Number.POSITIVE_INFINITY);

    assert.deepEqual([scanned.length, scanned.lines, scanned.ends], [bytes.length, 3, 'head']);
  });

  it('follows a chunked body through its sizes, extensions and data without counting them, and counts its trailer lines', () => {
    const data = '\n\r\na:\r\n0\r\n\r\n';
    const text =
      `${data.length.toString(16)};a="b c"\r\n${data}\r\n` +
      `00${data.length.toString(16).toUpperCase()}\r\n${data}\r\n` +
      '0;x=y\r\nx-a: 1\r\na:\r\n\r\nGET';
    const bytes = Buffer.from(text, 'latin1');
    const scanned = scanLines(bytes, 0, bytes.length, CHUNKED, Number.POSITIVE_INFINITY);

    assert.deepEqual(
      [scanned.length, scanned.lines, scanned.ends],
      [text.length - 3, 2, 'message'],
    );
    assert.equal(scanned.framing, NEXT_HEAD);

    // With room for one trailer line: cut before the second, and waits.
    const one = scanLines(bytes, 0, bytes.length, CHUNKED, 1);

    assert.equal(one.length, text.indexOf('a:\r\n\r\nGET'));
    assert.deepEqual([one.lines, one.waits], [1, true]);
    assert.deepEqual(one.framing, { kind: 'trailers', line: 'start' });

    // An empty trailer section.
    const none = Buffer.from('0\r\n\r\n', 'latin1');

    assert.deepEqual(
      [
        scanLines(none, 0, none.length, CHUNKED, 0).ends,
        scanLines(none, 0, none.length, CHUNKED, 0).lines,
      ],
      ['message', 0],
    );
  });

  it('takes a chunk size of every length a sender may write, past what a number holds exactly, as data to its end', () => {
    const bytes = Buffer.from(`${'f'.repeat(40)}\r\n${'\r\n'.repeat(100)}`, 'latin1');
    const scanned = scanLines(bytes, 0, bytes.length, CHUNKED, 0);

    assert.deepEqual([scanned.length, scanned.lines, scanned.ends], [bytes.length, 0, null]);
    assert.equal(scanned.framing.kind, 'chunk-data');
  });

  it('takes a body’s framing from the request Node read: none once complete, chunked for any Transfer-Encoding, else its declared length', () => {
    const request = (
      complete: boolean,
      headers: Record<string, string | undefined>,
    ): IncomingMessage => ({ complete, headers }) as unknown as IncomingMessage;

    assert.equal(framingAfterHead(request(true, { 'content-length': '5' })), NEXT_HEAD);
    assert.deepEqual(
      framingAfterHead(request(false, { 'transfer-encoding': 'gzip, chunked' })),
      CHUNKED,
    );
    assert.deepEqual(
      framingAfterHead(request(false, { 'transfer-encoding': 'chunked', 'content-length': '3' })),
      CHUNKED,
    );
    assert.deepEqual(framingAfterHead(request(false, { 'content-length': '007' })), {
      kind: 'body',
      remaining: 7,
    });

    // None Node's parser lets through: the bound stops counting the connection.
    for (const headers of [
      {},
      { 'content-length': '0' },
      { 'content-length': '1, 1' },
      { 'content-length': '-1' },
    ]) {
      assert.equal(framingAfterHead(request(false, headers)), null, JSON.stringify(headers));
    }
  });

  it('gives nothing after a head until the body’s framing is known', () => {
    const bytes = Buffer.from('abc', 'latin1');

    assert.deepEqual(
      { ...scanLines(bytes, 0, 3, { kind: 'after-head' }, 10) },
      { length: 0, lines: 0, ends: null, framing: { kind: 'after-head' }, waits: false },
    );
  });

  for (const size of [1_024, 65_536, 1_048_576]) {
    it(`scans hostile input of ${size} bytes in any framing in linear time, every slice at least a byte unless it waits, the lines the same however it is cut`, () => {
      const draw = random(size + 182);
      const shapes: Buffer[] = [
        Buffer.from('\n\r\n'.repeat(Math.ceil(size / 3)), 'latin1').subarray(0, size),
        Buffer.from('\r\n'.repeat(size / 2), 'latin1'),
        Buffer.alloc(size, 0x0a),
        Buffer.alloc(size, 0x0d),
        Buffer.from('a:\r\n'.repeat(size / 4), 'latin1'),
        Buffer.from('1\r\nx\r\n'.repeat(Math.ceil(size / 6)), 'latin1').subarray(0, size),
        Buffer.from(nastyBytes(draw, size), 'latin1'),
        Buffer.from(Array.from({ length: size }, () => Math.floor(draw() * 256))),
      ];
      const framings: Framing[] = [
        NEXT_HEAD,
        { kind: 'head', started: true, line: 'inside' },
        { kind: 'trailers', line: 'start' },
        CHUNKED,
        { kind: 'body', remaining: size * 2 },
      ];
      for (const shape of shapes) {
        for (const framing of framings) {
          // Whole, with no bound: the lines it holds.
          const whole = scanLines(shape, 0, shape.length, framing, Number.POSITIVE_INFINITY);

          // In random reads, and slices of random room: the same lines to
          // the same point, never an empty slice that does not wait.
          const cuts = Array.from({ length: 20 }, () => Math.floor(draw() * whole.length)).sort(
            (a, b) => a - b,
          );
          let state = framing;
          let from = 0;
          let lines = 0;

          for (const readEnd of [...cuts, whole.length]) {
            while (from < readEnd) {
              const allowance = Math.floor(draw() * 50);
              const scanned = scanLines(shape, from, readEnd, state, allowance);

              assert.ok(scanned.lines <= allowance);

              if (scanned.length === 0) {
                assert.ok(scanned.waits, `nothing given at ${from} without waiting`);

                const more = scanLines(shape, from, readEnd, state, allowance + 1);

                assert.ok(
                  more.length > 0 && more.lines === 1,
                  'one line more of room gives one line',
                );
                continue;
              }

              from += scanned.length;
              lines += scanned.lines;
              state = scanned.framing;

              if (scanned.ends !== null) {
                break;
              }
            }

            if (from >= whole.length) {
              break;
            }
          }

          assert.equal(from, whole.length);
          assert.equal(
            lines,
            whole.lines,
            `${framing.kind}: ${lines} lines cut, ${whole.lines} whole`,
          );
        }

        // Linear: a whole scan of the largest, in the most lines it can
        // hold, well within a bound a quadratic one would be over.
        withinBound(2_000, () =>
          scanLines(
            shape,
            0,
            shape.length,
            { kind: 'head', started: true, line: 'inside' },
            Number.POSITIVE_INFINITY,
          ),
        );
      }
    });
  }

  for (const [count, maxLines] of [
    [40, 30],
    [20, 300],
    [3, 16_000],
  ] as const) {
    it(`follows ${count} well-formed pipelined requests of up to ${maxLines} header lines in random reads and room: every head’s and trailer section’s lines exactly, no byte of a body, every end where it is`, () => {
      for (let round = 0; round < 30; round += 1) {
        const draw = random(round * 7_919 + maxLines);
        const { text, requests } = modelPipeline(draw, count, maxLines);
        const bytes = Buffer.from(text, 'latin1');
        const cuts = Array.from({ length: 1 + Math.floor(draw() * 30) }, () =>
          Math.floor(draw() * bytes.length),
        ).sort((a, b) => a - b);
        const tight = round % 3 === 0;
        const scanned = scanAll(
          bytes,
          cuts,
          () => (tight ? Math.floor(draw() * 3) : Number.POSITIVE_INFINITY),
          (head) => framingOf(requests[head] as Modelled),
        );
        const expected: number[] = [];

        // A head's lines, and a body's end: a chunked one's trailer lines,
        // none for one of declared length.
        for (const request of requests) {
          expected.push(request.headLines);

          if (request.body !== 'none') {
            expected.push(request.trailerLines);
          }
        }

        assert.deepEqual(scanned.sections, expected);
        assert.deepEqual(
          scanned.headEnds,
          requests.map((request) => request.headEnd),
        );
        assert.deepEqual(
          scanned.messageEnds,
          requests.map((request) => request.end),
        );
      }
    });
  }
});

describe('the budget of header lines in flight (#182)', () => {
  /** An account that records how often it was woken. */
  function account(
    budget: ReturnType<typeof createHeaderLineBudget>,
    key: string,
  ): LineAccount & { readonly woken: number } {
    let woken = 0;
    const opened = budget.open(key, () => {
      woken += 1;
    });

    Object.defineProperty(opened, 'woken', { get: () => woken });

    return opened as LineAccount & { readonly woken: number };
  }

  it('holds 32,768 lines an address and 524,288 a process by default, and refuses a size below 1', () => {
    const budget = createHeaderLineBudget();

    assert.equal(MAX_HEADER_LINES_IN_FLIGHT_PER_ADDRESS, 32_768);
    assert.equal(MAX_HEADER_LINES_IN_FLIGHT, 524_288);
    assert.equal(budget.perAddress, MAX_HEADER_LINES_IN_FLIGHT_PER_ADDRESS);
    assert.equal(budget.perProcess, MAX_HEADER_LINES_IN_FLIGHT);

    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => createHeaderLineBudget({ perAddress: bad }), /perAddress of at least 1/);
      assert.throws(() => createHeaderLineBudget({ perProcess: bad }), /perProcess of at least 1/);
    }
  });

  it('lets the first connection of an address holding none, and the address’s oldest holder, go on whatever the address’s number', () => {
    const budget = createHeaderLineBudget({ perAddress: 10, perProcess: 1_000 });
    const first = account(budget, 'a');
    const second = account(budget, 'a');

    assert.equal(first.allowance(), Number.POSITIVE_INFINITY);
    first.take(16_320);
    assert.equal(budget.linesOf('a'), 16_320);
    // The oldest holder, still past the address's number: it may end its head.
    assert.equal(first.allowance(), Number.POSITIVE_INFINITY);
    // The next is held by the address's number.
    assert.equal(second.allowance(), 0);
    first.giveBack();
    assert.equal(second.allowance(), Number.POSITIVE_INFINITY);
    second.take(4);
    assert.equal(first.allowance(), 6, 'no longer the oldest');
  });

  it('bounds the others of an address by its number, counting each line once, whatever order they come and go in', () => {
    const budget = createHeaderLineBudget({ perAddress: 100, perProcess: 1_000 });
    const [a, b, c] = [account(budget, 'x'), account(budget, 'x'), account(budget, 'x')];

    a.take(30);
    assert.equal(b.allowance(), 70);
    b.take(50);
    assert.equal(c.allowance(), 20);
    c.take(20);
    assert.equal(budget.linesOf('x'), 100);
    assert.equal(budget.lines, 100);
    // Taken in steps, as a connection sends more: each step counted.
    b.giveBack();
    b.giveBack();
    assert.equal(budget.linesOf('x'), 50);
    b.take(10);
    b.take(10);
    assert.equal(budget.linesOf('x'), 70);
    assert.equal(c.allowance(), 30);
    a.close();
    a.close();
    a.giveBack();
    b.close();
    c.close();
    assert.equal(budget.lines, 0);
    assert.equal(budget.addresses, 0);
  });

  it('keys addresses apart: another address has its own number while one is full', () => {
    const budget = createHeaderLineBudget({ perAddress: 10, perProcess: 1_000 });
    const full = account(budget, 'a');

    full.take(10);
    account(budget, 'a').take(0);
    assert.equal(account(budget, 'a').allowance(), 0);
    // Its own number, untouched; the process's room the only bound.
    assert.equal(account(budget, 'b').allowance(), 990);
  });

  it('holds the first connection of an address holding none by the process’s number once it is full, and lets the process’s oldest holder go on', async () => {
    const budget = createHeaderLineBudget({ perAddress: 100, perProcess: 50 });
    const a = account(budget, 'a');
    const b = account(budget, 'b');
    const c = account(budget, 'c');

    a.take(30);
    b.take(20);
    assert.equal(c.allowance(), 0, 'the process is full');
    assert.equal(a.allowance(), Number.POSITIVE_INFINITY, 'the process’s oldest holder');
    assert.equal(b.allowance(), 0);
    c.wait(5);
    assert.equal(budget.waiting, 1);
    a.giveBack();
    await nextTurn();
    assert.equal(c.woken, 1);
    assert.equal(c.allowance(), 30);
    c.take(5);
    assert.equal(budget.waiting, 0);
  });

  /**
   * A connection waiting for `want` lines that, a turn after it is woken -
   * as the bound's connection reads on - takes what room it has, up to what
   * it wants, and waits again for the rest; or, `stuck`, does not go on.
   */
  function waiter(
    budget: ReturnType<typeof createHeaderLineBudget>,
    key: string,
    want: number,
    stuck = false,
  ): { account: LineAccount; woken: number; want: number; stuck: boolean } {
    const state = { account: undefined as unknown as LineAccount, woken: 0, want, stuck };

    state.account = budget.open(key, () => {
      state.woken += 1;
      process.nextTick(() => {
        if (state.stuck) {
          return;
        }

        const taken = Math.min(state.account.allowance(), state.want);

        if (taken > 0) {
          state.account.take(taken);
          state.want -= taken;
        }

        if (state.want > 0) {
          state.account.wait(state.want);
        }
      });
    });
    state.account.wait(want);

    return state;
  }

  it('wakes those waiting in the order they waited, as many as the room freed is enough for by what each has waiting', async () => {
    const budget = createHeaderLineBudget({ perAddress: 100, perProcess: 10_000 });
    const holder = account(budget, 'a');

    holder.take(100);

    const waiting = Array.from({ length: 5 }, () => waiter(budget, 'a', 40));

    assert.equal(budget.waiting, 5);
    holder.giveBack();
    await nextTurn();
    await nextTurn();
    // 100 lines free: the first two all they wanted, the third the 20 left,
    // which then waits again for the rest, behind those still waiting.
    assert.deepEqual(
      waiting.map((each) => each.woken),
      [1, 1, 1, 0, 0],
    );
    assert.equal(budget.linesOf('a'), 100);
    assert.equal(budget.waiting, 3);

    waiting[0]?.account.giveBack();
    await nextTurn();
    await nextTurn();
    // 40 free: the fourth, first in line, and nobody behind it.
    assert.deepEqual(
      waiting.map((each) => each.woken),
      [1, 1, 1, 1, 0],
    );
    assert.equal(budget.linesOf('a'), 100);

    for (const each of [holder, ...waiting.map((one) => one.account)]) {
      each.close();
    }

    assert.equal(budget.lines, 0);
    assert.equal(budget.waiting, 0);
    assert.equal(budget.addresses, 0);
  });

  it('gives the room of a woken connection that does not go on to the next once those woken have had their turn, and keeps the first its place', async () => {
    const budget = createHeaderLineBudget({ perAddress: 10, perProcess: 10_000 });
    const holder = account(budget, 'a');

    holder.take(10);

    const first = waiter(budget, 'a', 10, true);
    const second = waiter(budget, 'a', 10);

    holder.giveBack();
    await nextTurn();
    await nextTurn();
    await nextTurn();
    // The first was woken and did not go on - held by something else, say
    // - so the room went to the second.
    assert.deepEqual([first.woken, second.woken], [1, 1]);
    assert.equal(budget.linesOf('a'), 10);

    // The first goes on at last, finds no room and waits again: in its
    // place, first in line, ahead of a third that waited since.
    assert.equal(first.account.allowance(), 0);
    first.account.wait(10);
    first.stuck = false;

    const third = waiter(budget, 'a', 10);

    second.account.giveBack();
    await nextTurn();
    await nextTurn();
    assert.deepEqual([first.woken, third.woken], [2, 0]);

    for (const each of [holder, first.account, second.account, third.account]) {
      each.close();
    }

    assert.equal(budget.lines, 0);
    assert.equal(budget.waiting, 0);
    assert.equal(budget.addresses, 0);
  });

  for (const steps of [1_000, 20_000, 200_000]) {
    it(`never loses a wake-up nor counts a line twice over ${steps} random steps of 200 connections from 10 addresses, and ends at zero`, async () => {
      const draw = random(steps);
      const budget = createHeaderLineBudget({ perAddress: 60, perProcess: 300 });
      const connections = Array.from({ length: 200 }, (_, index) => {
        const key = `k${index % 10}`;
        const connection = {
          key,
          lines: 0,
          waiting: false,
          woken: false,
          closed: false,
          account: undefined as unknown as LineAccount,
        };

        connection.account = budget.open(key, () => {
          assert.ok(connection.waiting, 'woken while not waiting');
          connection.woken = true;
        });

        return connection;
      });
      const started = Date.now();

      for (let step = 0; step < steps; step += 1) {
        const connection = connections[Math.floor(draw() * connections.length)];

        if (connection === undefined || connection.closed) {
          continue;
        }

        const action = draw();

        if (connection.woken || (!connection.waiting && action < 0.5)) {
          // Goes on: takes what it may, up to 10 lines, or waits again.
          const allowance = connection.account.allowance();
          const want = 1 + Math.floor(draw() * 10);

          connection.woken = false;

          if (allowance >= 1) {
            const taken = Math.min(allowance, want);

            connection.account.take(taken);
            connection.lines += taken;
            connection.waiting = false;
          } else {
            connection.account.wait(want);
            connection.waiting = true;
          }
        } else if (!connection.waiting && action < 0.8) {
          connection.account.giveBack();
          connection.lines = 0;
        } else if (action > 0.995) {
          connection.account.close();
          connection.closed = true;
          connection.lines = 0;
          connection.waiting = false;
        }

        // Every line counted once; the address and the process within their
        // numbers but for their oldest holders, whose lines are at most the
        // most any one connection holds.
        const expected = connections.reduce((sum, each) => sum + each.lines, 0);
        const most = Math.max(...connections.map((each) => each.lines));

        assert.equal(budget.lines, expected);
        assert.ok(budget.lines <= budget.perProcess + most, `${budget.lines} in the process`);
        assert.ok(
          budget.linesOf(connection.key) <= budget.perAddress + most,
          `${budget.linesOf(connection.key)} of an address`,
        );

        if (step % 64 === 0) {
          await nextTurn();
        }
      }

      // Everything given back: whoever still waits is woken, goes on, ends.
      for (let round = 0; round < 1_000; round += 1) {
        for (const connection of connections) {
          if (!connection.closed && !connection.waiting) {
            connection.account.giveBack();
            connection.lines = 0;
          }

          if (connection.woken) {
            connection.woken = false;
            connection.account.take(1);
            connection.lines += 1;
            connection.waiting = false;
          }
        }

        await nextTurn();
        await nextTurn();

        if (connections.every((connection) => !connection.waiting || connection.closed)) {
          break;
        }
      }

      assert.ok(
        connections.every((connection) => !connection.waiting || connection.closed),
        `${connections.filter((connection) => connection.waiting && !connection.closed).length} never woken`,
      );

      for (const connection of connections) {
        connection.account.close();
      }

      assert.equal(budget.lines, 0);
      assert.equal(budget.waiting, 0);
      assert.equal(budget.addresses, 0);
      assert.ok(Date.now() - started < 60_000, `${Date.now() - started} ms`);
    });
  }
});
