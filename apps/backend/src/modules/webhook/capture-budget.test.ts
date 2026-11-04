/**
 * The byte budget webhooks are received by (D210), without a server: the
 * numbers, the weight read from a method and made-up headers at growing
 * sizes, a stored weight never more than the one admitted, first come first
 * served, an address held to its 16 MiB while another goes in, a shrink or a
 * release waking the next, a hold that never grows, a weight given back
 * once only, a waiter removed when its sender leaves, a wait of 30 s
 * ending it, the stop a connection's waiting webhooks share, and the line
 * waiting for a place held to 16 MiB an address and 64 MiB in all, the first
 * of an address always let in (D228); and the light senders' reserve (D261):
 * a light sender let in past the 64 MiB and before heavier waiters, never past
 * 80 MiB in all, the heavier addresses never past 64 MiB, under hostile shapes
 * and random interleavings.
 * `capture-admission.test.ts` holds the same over real sockets.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { maxHeaderSize, METHODS } from 'node:http';
import type { Socket } from 'node:net';
import { describe, it } from 'node:test';
import {
  buildInspectorUrl,
  CAPTURE_BUDGET_BYTES,
  CAPTURE_BUDGET_PER_ADDRESS_BYTES,
  CAPTURE_LIGHT_RESERVE_BYTES,
  CAPTURE_LIGHT_SENDER_BYTES,
  CAPTURE_WAIT_MS,
  CAPTURE_WAITING_BYTES,
  CAPTURE_WAITING_PER_ADDRESS_BYTES,
  CAPTURES_BUSY_RETRY_AFTER_SECONDS,
  ErrorCode,
  MAX_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
} from '@webhook-inspector/shared';
import { TIMED_RUNS, withinBound } from '../../testing/timing.ts';
import {
  CAPTURE_BASE_WEIGHT_BYTES,
  CAPTURE_HEADER_LINE_WEIGHT_BYTES,
  CAPTURE_ANSWER_RESERVE_BYTES,
  captureWeight,
  connectionStops,
  createCaptureBudget,
  inFlightBound,
  METHODS_WITHOUT_BODY,
  storedWeight,
  unreadBodyWeight,
  waitingWeight,
  type Admission,
  type CaptureBudget,
  type CaptureBudgetSettings,
  type CaptureHold,
} from './capture-budget.ts';
import { NOTHING_CARRIED, webhookResponseBody } from './response.ts';
import { normaliseSourceIp } from './source-ip.ts';

const MIB = 1024 * 1024;

/**
 * Milliseconds the admissions of a flood of 100,000 webhooks may take, the
 * fastest of up to five runs (`withinBound`, D203): 1500. `admit` decides
 * each webhook - admitted, waiting or refused - before it returns, so a run
 * times that and not the reading of the 100,000 answers, a promise and a
 * turn each, which the one run these checks held to 5 s until #378 timed
 * too: 1.1 to 5.4 s alone, up to 14 s beside the full backend suite and
 * eight busy loops (F-27). The admissions take 138 to 227 ms alone and up to
 * 589 ms under that load. Choosing the next by looking at every waiter of
 * the line rather than each address's first takes 3.4 s or more on the
 * 4,033 waiters of #242's flood, and weighing the line by summing its
 * waiters 8.5 s: over the bound on every run. On one address's line of
 * 1,008 waiters the same take 1.0 and 0.4 s, and searching that line for
 * each one refused 0.2 s: under it, given up there.
 */
const FLOOD_BOUND_MS = 1_500;

/** The longest method a stored request can have: Node's longest, or the fallback for none. */
const LONGEST_METHOD = [...METHODS, 'UNKNOWN'].reduce((longest, method) =>
  method.length > longest.length ? method : longest,
);

/**
 * The largest default answer a stored request can be given (D223): a path as
 * long as Node's 16 KiB of request target and headers allows, every character
 * after `/s/<id>/` a `"`, which JSON writes as two; the longest method; an IPv6
 * address in the longest spelling normalisation stores; the largest body
 * accepted; and the longest time a `Date` writes.
 */
function largestDefaultAnswer(): string {
  const sessionId = 'A'.repeat(43);
  const requestId = randomUUID();
  const prefix = `/s/${sessionId}/`;
  const sourceIp = normaliseSourceIp('FFFF:ffff:ffff:ffff:ffff:ffff:ffff:ffff');

  assert.equal(sourceIp?.length, 39);

  return (
    webhookResponseBody(
      null,
      {
        requestId,
        inspectorUrl: buildInspectorUrl('https://qa-tools.ru', sessionId, requestId),
        receivedAt: new Date(8.64e15).toISOString(),
        method: LONGEST_METHOD,
        path: `${prefix}${'"'.repeat(maxHeaderSize - prefix.length)}`,
        bodySize: MAX_BODY_BYTES,
        sourceIp,
      },
      NOTHING_CARRIED,
    ) ?? ''
  );
}

/** `Content-Length: value` and one other line. */
function length(value: number | string): string[] {
  return ['Host', 'hook.qa-tools.ru', 'Content-Length', String(value)];
}

/** `count` header lines of `a:`, as raw headers: the most a sender may send is 16,320 (D210 point 3). */
function lines(count: number): string[] {
  return Array.from({ length: count }, () => ['a', '']).flat();
}

/** The weight of `lines` header lines and nothing else: the 16 KiB and their part. */
function fixed(lines: number): number {
  return CAPTURE_BASE_WEIGHT_BYTES + lines * CAPTURE_HEADER_LINE_WEIGHT_BYTES;
}

/** What a webhook of `lines` header lines is admitted for besides its body: with the answer's reserve. */
function weighed(lines: number): number {
  return fixed(lines) + CAPTURE_ANSWER_RESERVE_BYTES;
}

/** What an admission resolved to, read without waiting longer than a turn. */
async function settledOrPending(admission: Promise<Admission>): Promise<Admission | 'pending'> {
  return Promise.race([
    admission,
    new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
  ]);
}

/** The hold of an admission that must have gone in. */
async function admitted(admission: Promise<Admission>): Promise<CaptureHold> {
  const result = await settledOrPending(admission);

  assert.ok(result !== 'pending' && result.outcome === 'admitted', JSON.stringify(result));

  return result.hold;
}

async function stillWaiting(admission: Promise<Admission>): Promise<void> {
  assert.equal(await settledOrPending(admission), 'pending');
}

describe('the capture budget’s numbers (D210)', () => {
  it('are 64 MiB for the process, 16 MiB an address and 30 s of waiting, refused 503 / 1018 with Retry-After: 1', () => {
    assert.equal(CAPTURE_BUDGET_BYTES, 64 * MIB);
    assert.equal(CAPTURE_BUDGET_PER_ADDRESS_BYTES, 16 * MIB);
    assert.equal(CAPTURE_WAIT_MS, 30_000);
    assert.equal(CAPTURES_BUSY_RETRY_AFTER_SECONDS, 1);
    assert.equal(ErrorCode.CAPTURES_BUSY, 1018);
    assert.equal(CAPTURE_BASE_WEIGHT_BYTES, 16 * 1024);
    assert.equal(CAPTURE_HEADER_LINE_WEIGHT_BYTES, 256);
    assert.equal(CAPTURE_ANSWER_RESERVE_BYTES, 64 * 1024);
    assert.equal(CAPTURE_ANSWER_RESERVE_BYTES, MAX_RESPONSE_BODY_BYTES);
    assert.deepEqual(createCaptureBudget().settings, {
      totalBytes: 64 * MIB,
      perAddressBytes: 16 * MIB,
      waitMs: 30_000,
      waitingBytes: 64 * MIB,
      waitingPerAddressBytes: 16 * MIB,
      lightSenderBytes: 12 * MIB,
      lightReserveBytes: 16 * MIB,
    });
  });

  it('keep 16 MiB past the 64 MiB for light senders, an address holding at most 12 MiB, so that 80 MiB is the most in flight (D261)', () => {
    assert.equal(CAPTURE_LIGHT_SENDER_BYTES, 12 * MIB);
    assert.equal(CAPTURE_LIGHT_RESERVE_BYTES, 16 * MIB);
    assert.equal(inFlightBound(createCaptureBudget().settings), 80 * MIB);
    assert.equal(inFlightBound({ totalBytes: 10, lightReserveBytes: 0 }), 10);
  });

  it('let 64 MiB wait in the process and 16 MiB from one address, each waiting webhook weighing its header part (D228)', () => {
    assert.equal(CAPTURE_WAITING_BYTES, 64 * MIB);
    assert.equal(CAPTURE_WAITING_PER_ADDRESS_BYTES, 16 * MIB);
    assert.equal(waitingWeight([]), CAPTURE_BASE_WEIGHT_BYTES);
    assert.equal(waitingWeight(length(MAX_BODY_BYTES)), fixed(2));
    // The largest webhook a sender may send weighs exactly 4 MiB waiting,
    // whatever its body; 2,500 lines 641 KiB.
    assert.equal(waitingWeight(lines(16_320)), 4 * MIB);
    assert.equal(waitingWeight(lines(2_500)), 641 * 1024);
    // The same header part as D210's weight, without the body or the answer.
    assert.equal(
      waitingWeight(length(MAX_BODY_BYTES)),
      captureWeight('POST', length(MAX_BODY_BYTES)) - MAX_BODY_BYTES - CAPTURE_ANSWER_RESERVE_BYTES,
    );
  });
});

describe('what a webhook weighs, from its method and headers alone (D210)', () => {
  it('its declared body, 16 KiB, 256 bytes a header line and 64 KiB for the answer', () => {
    assert.equal(captureWeight('POST', []), weighed(0));
    assert.equal(captureWeight('POST', ['Host', 'h']), weighed(1));
    assert.equal(captureWeight('POST', length(0)), weighed(2));
    assert.equal(captureWeight('POST', length(1)), 1 + weighed(2));
    assert.equal(captureWeight('POST', length(MAX_BODY_BYTES)), MAX_BODY_BYTES + weighed(2));
    assert.equal(
      captureWeight('POST', length(` ${MAX_BODY_BYTES}\t`)),
      MAX_BODY_BYTES + weighed(2),
    );
    assert.equal(captureWeight('POST', ['CONTENT-LENGTH', '000123']), 123 + weighed(1));
  });

  it('nothing at all for a body declared over 1 MiB, which is refused 413 unread', () => {
    assert.equal(captureWeight('POST', length(MAX_BODY_BYTES + 1)), 0);
    assert.equal(captureWeight('POST', length(4 * MAX_BODY_BYTES)), 0);
    assert.equal(captureWeight('POST', length('9'.repeat(400))), 0);
  });

  it('1 MiB for a chunked body, or any Transfer-Encoding', () => {
    assert.equal(
      captureWeight('POST', ['Transfer-Encoding', 'chunked']),
      MAX_BODY_BYTES + weighed(1),
    );
    assert.equal(
      captureWeight('POST', ['transfer-encoding', 'gzip, chunked']),
      MAX_BODY_BYTES + weighed(1),
    );
    assert.equal(captureWeight('POST', ['Transfer-Encoding', '']), MAX_BODY_BYTES + weighed(1));
    assert.equal(
      captureWeight('POST', ['Transfer-Encoding', 'chunked', 'Content-Length', String(4 * MIB)]),
      MAX_BODY_BYTES + weighed(2),
    );
  });

  it('1 MiB for framing the headers do not settle', () => {
    for (const declared of ['', ' ', '+5', '-1', '0x20000', '1e6', '5.0', '1 2', '５', 'abc']) {
      assert.equal(captureWeight('POST', length(declared)), MAX_BODY_BYTES + weighed(2), declared);
    }

    assert.equal(
      captureWeight('POST', ['Content-Length', '5', 'Content-Length', '5']),
      MAX_BODY_BYTES + weighed(2),
    );
  });

  it('the body a GET, HEAD or TRACE declares, which Node reads although Fastify never does, at most 1 MiB and never nothing', () => {
    assert.deepEqual([...METHODS_WITHOUT_BODY].sort(), ['GET', 'HEAD', 'TRACE']);

    for (const method of METHODS_WITHOUT_BODY) {
      // Declaring none, it weighs its headers and the answer alone.
      assert.equal(captureWeight(method, ['Host', 'h']), weighed(1), method);
      assert.equal(captureWeight(method, length(0)), weighed(2), method);
      assert.equal(captureWeight(method, length('000')), weighed(2), method);
      assert.equal(captureWeight(method, length(5)), 5 + weighed(2), method);
      assert.equal(
        captureWeight(method, length(MAX_BODY_BYTES)),
        MAX_BODY_BYTES + weighed(2),
        method,
      );
      // Not refused `413`, so a length over 1 MiB weighs 1 MiB, not nothing.
      assert.equal(captureWeight(method, length(MAX_BODY_BYTES + 1)), MAX_BODY_BYTES + weighed(2));
      assert.equal(captureWeight(method, length(2_000_000)), MAX_BODY_BYTES + weighed(2), method);
      assert.equal(
        captureWeight(method, length('9'.repeat(400))),
        MAX_BODY_BYTES + weighed(2),
        method,
      );
      assert.equal(captureWeight(method, length('abc')), MAX_BODY_BYTES + weighed(2), method);
      assert.equal(
        captureWeight(method, ['Transfer-Encoding', 'chunked']),
        MAX_BODY_BYTES + weighed(1),
        method,
      );
      assert.equal(
        captureWeight(method, ['Content-Length', '5', 'Content-Length', '5']),
        MAX_BODY_BYTES + weighed(2),
        method,
      );
    }

    // Every other method the receiver takes has its body read, and refused
    // `413` unread when it is declared over 1 MiB.
    for (const method of METHODS.filter(
      (name) => name !== 'CONNECT' && !METHODS_WITHOUT_BODY.has(name),
    )) {
      assert.equal(captureWeight(method, length(5)), 5 + weighed(2), method);
      assert.equal(captureWeight(method, length(2_000_000)), 0, method);
      assert.equal(
        captureWeight(method, ['Transfer-Encoding', 'chunked']),
        MAX_BODY_BYTES + weighed(1),
        method,
      );
    }

    assert.equal(captureWeight(undefined, length(5)), 5 + weighed(2));
    assert.equal(captureWeight(undefined, length(2_000_000)), 0);
  });

  it('weighs 2,500 header lines at 625 KiB besides the body and the answer', () => {
    const headers = Array.from({ length: 2_500 }, (_, index) => [`x-${index}`, 'v']).flat();

    assert.equal(captureWeight('POST', headers), weighed(2_500));
    assert.equal(fixed(2_500) - CAPTURE_BASE_WEIGHT_BYTES, 640_000);
  });

  it('shrinks, once stored, to 16 KiB, the header part and the reply’s body', () => {
    assert.equal(storedWeight('POST', length(MAX_BODY_BYTES), 0), fixed(2));
    assert.equal(storedWeight('POST', length(MAX_BODY_BYTES), 65_536), fixed(2) + 65_536);
    assert.equal(storedWeight('PUT', ['Transfer-Encoding', 'chunked'], 13), fixed(1) + 13);
    assert.equal(storedWeight(undefined, length(5), 0), fixed(2));
    assert.equal(unreadBodyWeight('POST', length(MAX_BODY_BYTES)), 0);
  });

  it('keeps, once stored, the body a GET, HEAD or TRACE declared, which Node holds unread until the reply has closed', () => {
    for (const method of METHODS_WITHOUT_BODY) {
      assert.equal(storedWeight(method, length(0), 13), fixed(2) + 13, method);
      assert.equal(storedWeight(method, ['Host', 'h'], 0), fixed(1), method);
      assert.equal(storedWeight(method, length(5), 0), 5 + fixed(2), method);
      assert.equal(
        storedWeight(method, length(MAX_BODY_BYTES), 13),
        MAX_BODY_BYTES + fixed(2) + 13,
        method,
      );
      assert.equal(storedWeight(method, length(2_000_000), 0), MAX_BODY_BYTES + fixed(2), method);
      assert.equal(
        storedWeight(method, ['Transfer-Encoding', 'chunked'], 65_536),
        MAX_BODY_BYTES + fixed(1) + 65_536,
        method,
      );
      assert.equal(unreadBodyWeight(method, length(2_000_000)), MAX_BODY_BYTES, method);
      // Never more than it was admitted for: with the answer at its bound,
      // exactly that.
      assert.equal(
        storedWeight(method, length(MAX_BODY_BYTES), CAPTURE_ANSWER_RESERVE_BYTES),
        captureWeight(method, length(MAX_BODY_BYTES)),
        method,
      );
    }
  });

  it('holds the default answer under the 64 KiB reserve at its worst: a 16 KiB path of quotes, an IPv6 address, the longest method, the largest body (D223)', () => {
    const answer = largestDefaultAnswer();
    const bytes = Buffer.byteLength(answer);

    // The bound the answer's size rests on: Node's 16 KiB of request target
    // and headers, which nothing on the receive listener raises (D187).
    assert.equal(maxHeaderSize, 16 * 1024);
    assert.equal(LONGEST_METHOD, 'UNSUBSCRIBE');
    // Every quote escaped: the answer really is the doubled path.
    assert.ok(bytes > 2 * (maxHeaderSize - 48), `${bytes} bytes`);
    assert.equal(JSON.parse(answer).bodySize, MAX_BODY_BYTES);
    assert.ok(bytes < CAPTURE_ANSWER_RESERVE_BYTES, `${bytes} bytes`);
    // So a stored webhook so answered never holds more than it was let in for.
    for (const method of [...METHODS, undefined]) {
      for (const headers of [length(0), length(MAX_BODY_BYTES), ['Transfer-Encoding', 'chunked']]) {
        if (captureWeight(method, headers) > 0) {
          assert.ok(storedWeight(method, headers, bytes) <= captureWeight(method, headers));
        }
      }
    }
  });

  it('never weighs more once stored than it was admitted for, whatever its method, its framing and its answer up to the bound', () => {
    // The default answer, at its largest, is within the reserve too (D223),
    // and a session's response or a queue step is held to it.
    assert.ok(Buffer.byteLength(largestDefaultAnswer()) < CAPTURE_ANSWER_RESERVE_BYTES);

    const framings: [string, string[]][] = [
      ['no header', []],
      ['no body', ['Host', 'h']],
      ['Content-Length: 0', length(0)],
      ['5 bytes', length(5)],
      ['1 MiB', length(MAX_BODY_BYTES)],
      ['1 MiB and 1 byte', length(MAX_BODY_BYTES + 1)],
      ['2,000,000 bytes', length(2_000_000)],
      ['a length that is not digits', length('abc')],
      ['chunked', ['Transfer-Encoding', 'chunked']],
      ['two lengths', ['Content-Length', '5', 'Content-Length', '5']],
      [
        '2,500 header lines',
        Array.from({ length: 2_500 }, (_, index) => [`x-${index}`, 'v']).flat(),
      ],
    ];
    const answers = [
      0,
      1,
      13,
      4_096,
      CAPTURE_ANSWER_RESERVE_BYTES - 1,
      CAPTURE_ANSWER_RESERVE_BYTES,
    ];

    for (const method of [...METHODS, undefined]) {
      for (const [framing, headers] of framings) {
        const admittedFor = captureWeight(method, headers);

        // Refused `413` unread, never held: only a body Fastify reads, declared over 1 MiB.
        if (admittedFor === 0) {
          assert.ok(
            method === undefined || !METHODS_WITHOUT_BODY.has(method),
            `${method} ${framing}`,
          );
          assert.ok(/1 MiB and|2,000,000/.test(framing), `${method} ${framing}`);
          continue;
        }

        for (const answer of answers) {
          const kept = storedWeight(method, headers, answer);

          assert.ok(
            kept <= admittedFor,
            `${method} ${framing} answered ${answer} bytes: ${kept} stored for ${admittedFor} admitted`,
          );
        }
      }
    }

    // The bound is reached, not merely kept: a GET with no body answered at
    // the bound holds, stored, all it was admitted for.
    assert.equal(
      storedWeight('GET', ['Host', 'h'], CAPTURE_ANSWER_RESERVE_BYTES),
      captureWeight('GET', ['Host', 'h']),
    );
  });

  it('answers made-up headers of 1 KiB, 64 KiB and 1 MiB within 100 ms each, as it deserves, weighed and stored', () => {
    for (const size of [1024, 64 * 1024, 1024 * 1024]) {
      const manyLengths = Array.from({ length: size / 16 }, () => ['Content-Length', '5']).flat();
      const cases: [string, string, string[], number][] = [
        ['digits', 'POST', length('9'.repeat(size)), 0],
        ['zeros then a length', 'POST', length('0'.repeat(size) + '5'), 5 + weighed(2)],
        [
          'digits then a letter',
          'POST',
          length('1'.repeat(size) + 'a'),
          MAX_BODY_BYTES + weighed(2),
        ],
        ['spaces', 'POST', length(' '.repeat(size)), MAX_BODY_BYTES + weighed(2)],
        [
          'a long Transfer-Encoding',
          'POST',
          ['Transfer-Encoding', 'chunked,'.repeat(size / 8)],
          MAX_BODY_BYTES + weighed(1),
        ],
        [
          'many headers before the length',
          'POST',
          [...Array.from({ length: size / 16 }, (_, i) => [`x-${i}`, 'v']).flat(), ...length(5)],
          5 + weighed(size / 16 + 2),
        ],
        ['many lengths', 'POST', manyLengths, MAX_BODY_BYTES + weighed(size / 16)],
        ['a long header name', 'POST', ['c'.repeat(size), '5', ...length(5)], 5 + weighed(3)],
        ['an odd count of entries', 'POST', [...length(5), 'dangling'], 5 + weighed(2)],
        // A method whose body Fastify never reads weighs the body it
        // declares, at most 1 MiB and never nothing (D210).
        ['a GET declaring digits', 'GET', length('9'.repeat(size)), MAX_BODY_BYTES + weighed(2)],
        [
          'a GET declaring over 1 MiB',
          'GET',
          length(String(size * size)),
          MAX_BODY_BYTES + weighed(2),
        ],
        ['a GET declaring zeros', 'GET', length('0'.repeat(size)), weighed(2)],
        [
          'a HEAD with a long Transfer-Encoding',
          'HEAD',
          ['Transfer-Encoding', 'chunked,'.repeat(size / 8)],
          MAX_BODY_BYTES + weighed(1),
        ],
        ['a TRACE with many lengths', 'TRACE', manyLengths, MAX_BODY_BYTES + weighed(size / 16)],
        ['a long method', 'G'.repeat(size), length(5), 5 + weighed(2)],
      ];

      for (const [what, method, headers, expected] of cases) {
        // The fastest of up to five runs, so that another file on the same
        // cores cannot fail a linear check (D203, `testing/timing.ts`).
        const answer = withinBound(100, () => captureWeight(method, headers));
        const kept = withinBound(100, () => storedWeight(method, headers, 0));

        assert.equal(answer, expected, `${what} at ${size} bytes`);
        // Stored, a GET, HEAD or TRACE keeps its body's part, any other none.
        assert.equal(
          kept,
          METHODS_WITHOUT_BODY.has(method)
            ? expected - CAPTURE_ANSWER_RESERVE_BYTES
            : fixed(Math.floor(headers.length / 2)),
          `${what} stored at ${size} bytes`,
        );
      }
    }
  });
});

/**
 * D210's budget alone: nobody is a light sender, so that first come first
 * served is read without D261's reserve, which `the light senders' reserve`
 * below holds.
 */
function d210Budget(settings: Partial<CaptureBudgetSettings>): CaptureBudget {
  return createCaptureBudget({ lightSenderBytes: 0, ...settings });
}

describe('the budget (D210)', () => {
  it('lets in what fits at once, and holds what is admitted until it is given back', async () => {
    const budget = d210Budget({ totalBytes: 10, perAddressBytes: 10 });
    const first = await admitted(budget.admit('a', 4));
    const second = await admitted(budget.admit('b', 6));

    assert.equal(budget.used, 10);
    assert.equal(budget.usedBy('a'), 4);
    assert.equal(budget.usedBy('b'), 6);
    assert.equal(budget.waiting, 0);

    first.release();
    second.release();
    assert.equal(budget.used, 0);
    assert.equal(budget.usedBy('a'), 0);
  });

  it('is first come first served: nobody overtakes a webhook the process has no room for', async () => {
    const budget = d210Budget({ totalBytes: 10, perAddressBytes: 10 });
    const full = await admitted(budget.admit('a', 10));
    const big = budget.admit('b', 6);
    const small = budget.admit('c', 1);
    const later = budget.admit('d', 3);

    await stillWaiting(big);
    await stillWaiting(small);
    assert.equal(budget.waiting, 3);

    // Room for the small one alone would not let it pass the big one.
    full.shrink(9);
    await stillWaiting(big);
    await stillWaiting(small);

    // Room for the big one lets it in, then the small one and the later one
    // behind it, in their order, as far as the room goes.
    full.shrink(0);

    const order: string[] = [];

    await Promise.all(
      [
        ['b', big],
        ['c', small],
        ['d', later],
      ].map(async ([name, admission]) => {
        const result = await (admission as Promise<Admission>);

        assert.equal(result.outcome, 'admitted');
        order.push(name as string);
      }),
    );

    assert.deepEqual(order, ['b', 'c', 'd']);
    assert.equal(budget.used, 10);
    assert.equal(budget.waiting, 0);
  });

  it('holds an address to its 16 MiB while another address is admitted', async () => {
    const budget = createCaptureBudget();
    const weight = captureWeight('POST', length(MAX_BODY_BYTES));
    const holds: CaptureHold[] = [];

    // 1 MiB, 16.5 KiB and the answer's 64 KiB each: fourteen fit an
    // address's 16 MiB.
    for (let index = 0; index < 14; index += 1) {
      holds.push(await admitted(budget.admit('203.0.113.7', weight)));
    }

    const fifteenth = budget.admit('203.0.113.7', weight);

    await stillWaiting(fifteenth);
    assert.equal(budget.usedBy('203.0.113.7'), 14 * weight);

    // Another address goes in at once, past the one waiting.
    const other = await admitted(budget.admit('198.51.100.1', weight));
    const otherNetwork = await admitted(budget.admit('2001:db8:1:2::/64', weight));

    assert.equal(budget.waiting, 1);
    await stillWaiting(fifteenth);

    holds[0]?.release();
    holds.push(await admitted(fifteenth));
    assert.equal(budget.usedBy('203.0.113.7'), 14 * weight);

    for (const hold of [...holds, other, otherNetwork]) {
      hold.release();
    }

    assert.equal(budget.used, 0);
  });

  it('lets nobody of a full address overtake its first, whatever their weight', async () => {
    const budget = d210Budget({ totalBytes: 100, perAddressBytes: 10 });
    const held = await admitted(budget.admit('a', 8));
    const large = budget.admit('a', 5);
    const tiny = budget.admit('a', 1);

    // The tiny one would fit the address's 2 left, but the large one came first.
    await stillWaiting(large);
    await stillWaiting(tiny);

    held.release();
    assert.equal((await large).outcome, 'admitted');
    assert.equal((await tiny).outcome, 'admitted');
    assert.equal(budget.usedBy('a'), 6);
  });

  it('wakes the next waiter on a shrink and on a release', async () => {
    const budget = d210Budget({ totalBytes: 10, perAddressBytes: 10 });
    const stored = await admitted(budget.admit('a', 10));
    const next = budget.admit('a', 5);

    await stillWaiting(next);

    // Stored: the weight shrinks to what a reply held by a delay keeps.
    stored.shrink(5);

    const nextHold = await admitted(next);
    const last = budget.admit('b', 5);

    await stillWaiting(last);
    nextHold.release();
    await admitted(last);
    assert.equal(budget.used, 10);
  });

  it('never grows a hold past what was admitted: a larger weight keeps the one held', async () => {
    const budget = d210Budget({ totalBytes: 10, perAddressBytes: 10 });
    const hold = await admitted(budget.admit('a', 4));
    const waiter = budget.admit('a', 9);

    await stillWaiting(waiter);
    hold.shrink(6);
    hold.shrink(4);
    assert.equal(budget.used, 4);
    assert.equal(budget.usedBy('a'), 4);
    hold.shrink(2);
    assert.equal(budget.used, 2);
    hold.shrink(4);
    assert.equal(budget.used, 2);
    await stillWaiting(waiter);
    hold.release();
    await admitted(waiter);
    assert.equal(budget.used, 9);
  });

  it('gives a weight back once only, and a released hold no longer shrinks', async () => {
    const budget = d210Budget({ totalBytes: 10, perAddressBytes: 10 });
    const kept = await admitted(budget.admit('a', 3));
    const hold = await admitted(budget.admit('a', 4));

    hold.release();
    hold.release();
    hold.shrink(2);
    hold.release();
    assert.equal(budget.used, 3);
    assert.equal(budget.usedBy('a'), 3);

    kept.release();
    assert.equal(budget.used, 0);
  });

  it('removes a waiter whose sender leaves, and lets in those it held up', async () => {
    const budget = d210Budget({ totalBytes: 10, perAddressBytes: 10 });
    const held = await admitted(budget.admit('a', 6));
    const gone = new AbortController();
    const leaving = budget.admit('b', 8, gone.signal);
    const behind = budget.admit('c', 4);

    await stillWaiting(leaving);
    await stillWaiting(behind);
    assert.equal(budget.waiting, 2);

    gone.abort();
    assert.deepEqual(await leaving, { outcome: 'cancelled' });
    // The one that left held the line: the one behind it fits, and goes in.
    await admitted(behind);
    assert.equal(budget.waiting, 0);
    assert.equal(budget.used, 10);

    // Leaving after the wait has ended changes nothing.
    held.release();
    gone.abort();
    assert.equal(budget.used, 4);
  });

  it('answers a sender already gone at once, holding nothing', async () => {
    const budget = d210Budget({ totalBytes: 10, perAddressBytes: 10 });
    const gone = new AbortController();

    gone.abort();
    assert.deepEqual(await budget.admit('a', 1, gone.signal), { outcome: 'cancelled' });
    assert.equal(budget.used, 0);
    assert.equal(budget.waiting, 0);
  });

  it('ends a wait of 30 s, and only then, without a place', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const budget = d210Budget({ totalBytes: 10, perAddressBytes: 10 });
    const held = await admitted(budget.admit('a', 10));
    const waiting = budget.admit('b', 1);

    t.mock.timers.tick(1_000);

    const behind = budget.admit('b', 1);

    t.mock.timers.tick(CAPTURE_WAIT_MS - 1_000 - 1);
    await stillWaiting(waiting);
    t.mock.timers.tick(1);
    assert.deepEqual(await waiting, { outcome: 'timed-out' });
    assert.equal(budget.waiting, 1);

    // The one behind it still has its own 30 s, which began a moment later.
    await stillWaiting(behind);
    held.release();
    await admitted(behind);
    assert.equal(budget.waiting, 0);
  });

  it('clears the timer of a waiter that goes in, so its 30 s never refuses it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const budget = d210Budget({ totalBytes: 10, perAddressBytes: 10 });
    const held = await admitted(budget.admit('a', 10));
    const waiting = budget.admit('a', 10);

    t.mock.timers.tick(10_000);
    held.release();

    const hold = await admitted(waiting);

    t.mock.timers.tick(CAPTURE_WAIT_MS);
    assert.equal(budget.used, 10);
    hold.release();
  });

  it('lets in a weight larger than a budget once that budget holds nothing, rather than never', async () => {
    const budget = d210Budget({ totalBytes: 10, perAddressBytes: 5 });
    const small = await admitted(budget.admit('a', 1));
    const huge = budget.admit('a', 7);

    await stillWaiting(huge);
    small.release();

    const hold = await admitted(huge);

    assert.equal(budget.usedBy('a'), 7);
    hold.release();
  });

  it('takes a weight at once, whatever is held, and makes others wait until it is back under', async () => {
    const budget = d210Budget({ totalBytes: 10, perAddressBytes: 10 });
    const full = await admitted(budget.admit('a', 10));
    const taken = budget.take('b', 5);

    assert.equal(budget.used, 15);

    const waiting = budget.admit('c', 1);

    await stillWaiting(waiting);
    full.release();
    await admitted(waiting);
    taken.release();
    assert.equal(budget.used, 1);
  });

  it('chooses among 10,000 waiters of one address and 100 others quickly', async () => {
    const budget: CaptureBudget = createCaptureBudget({
      totalBytes: 200 * MIB,
      perAddressBytes: MIB,
    });
    const flood = await admitted(budget.admit('flood', MIB));
    const waiters = Array.from({ length: 10_000 }, () => budget.admit('flood', MIB));
    const started = performance.now();
    const others = await Promise.all(
      Array.from({ length: 100 }, (_, index) => admitted(budget.admit(`other-${index}`, MIB))),
    );

    assert.ok(performance.now() - started < 1_000, 'the others waited behind the flood');
    assert.equal(budget.waiting, 10_000);

    // Every waiter of the flood goes in, one after another.
    let hold = flood;

    for (const waiter of waiters) {
      hold.release();
      hold = await admitted(waiter);
    }

    hold.release();

    for (const other of others) {
      other.release();
    }

    assert.equal(budget.used, 0);
    assert.equal(budget.waiting, 0);
  });
});

describe('the line waiting for a place (D228)', () => {
  /**
   * A budget whose places are all taken, the light senders' reserve too, so
   * that every webhook admitted must wait.
   */
  function full(settings: Parameters<typeof createCaptureBudget>[0] = {}): {
    budget: CaptureBudget;
    filler: CaptureHold;
  } {
    const budget = createCaptureBudget(settings);

    return { budget, filler: budget.take('filler', inFlightBound(budget.settings)) };
  }

  it('refuses at once the next of an address whose waiting webhooks weigh its 16 MiB, while another address waits', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const { budget, filler } = full();
    const each = waitingWeight(lines(16_320));
    // Four of the largest webhooks a sender may send are an address's 16 MiB.
    const waiters = Array.from({ length: 4 }, () => budget.admit('a', 1, undefined, each));

    for (const waiter of waiters) {
      await stillWaiting(waiter);
    }

    assert.equal(budget.lineUsedBy('a'), 16 * MIB);

    // The next, however small its headers, is answered at once: no wait.
    const refused = budget.admit('a', 1, undefined, waitingWeight([]));

    assert.deepEqual(await settledOrPending(refused), { outcome: 'line-full' });
    assert.equal(budget.waiting, 4);
    assert.equal(budget.lineUsedBy('a'), 16 * MIB);

    // Another address's webhook waits while the process's line has room.
    const other = budget.admit('b', 1, undefined, each);
    const otherSecond = budget.admit('b', 1, undefined, each);

    await stillWaiting(other);
    await stillWaiting(otherSecond);
    assert.equal(budget.lineUsed, 24 * MIB);

    // Room again once the first goes in: the next of the address waits.
    filler.release();

    for (const waiter of [...waiters, other, otherSecond]) {
      (await admitted(waiter)).release();
    }

    assert.equal(budget.lineUsed, 0);

    const later = await settledOrPending(budget.admit('a', 1, undefined, each));

    assert.equal(later !== 'pending' && later.outcome, 'admitted');
  });

  it('refuses at once the next of an address already waiting once the process’s line holds its 64 MiB', async () => {
    const { budget, filler } = full();
    const each = waitingWeight(lines(16_320));

    // Four addresses of four of the largest each: 64 MiB in all.
    const waiters = ['a', 'b', 'c', 'd'].flatMap((key) =>
      Array.from({ length: 4 }, () => budget.admit(key, 1, undefined, each)),
    );

    await stillWaiting(waiters[15] as Promise<Admission>);
    assert.equal(budget.lineUsed, 64 * MIB);

    // A fifth address's first waits, the line full or not; its second is
    // refused at once, as is one more of an address already waiting.
    const fifth = budget.admit('e', 1, undefined, each);

    await stillWaiting(fifth);
    assert.deepEqual(
      await settledOrPending(budget.admit('e', 1, undefined, CAPTURE_BASE_WEIGHT_BYTES)),
      {
        outcome: 'line-full',
      },
    );
    assert.deepEqual(
      await settledOrPending(budget.admit('a', 1, undefined, CAPTURE_BASE_WEIGHT_BYTES)),
      { outcome: 'line-full' },
    );
    assert.equal(budget.waiting, 17);

    filler.release();

    for (const waiter of [...waiters, fifth]) {
      (await admitted(waiter)).release();
    }

    assert.equal(budget.lineUsed, 0);
    assert.equal(budget.used, 0);
  });

  it('always lets the first of an address wait, even with 16,320 header lines and a line smaller than its weight', async () => {
    const { budget, filler } = full({ waitingBytes: MIB, waitingPerAddressBytes: MIB });
    const largest = waitingWeight(lines(16_320));
    const first = budget.admit('a', 1, undefined, largest);

    await stillWaiting(first);
    assert.equal(budget.lineUsed, 4 * MIB);

    // Another address's first too, past the process's line.
    const other = budget.admit('b', 1, undefined, largest);

    await stillWaiting(other);

    // Behind its address's first, even the smallest is refused.
    assert.deepEqual(
      await settledOrPending(budget.admit('a', 1, undefined, CAPTURE_BASE_WEIGHT_BYTES)),
      {
        outcome: 'line-full',
      },
    );

    filler.release();
    (await admitted(first)).release();
    (await admitted(other)).release();
  });

  it('weighs nothing and waits for nothing for a webhook that goes in at once', async () => {
    const budget = createCaptureBudget({ waitingBytes: 1, waitingPerAddressBytes: 1 });
    const holds = await Promise.all(
      Array.from({ length: 3 }, () => admitted(budget.admit('a', 1, undefined, 4 * MIB))),
    );

    assert.equal(budget.lineUsed, 0);

    for (const hold of holds) {
      hold.release();
    }
  });

  it('gives the line back when a waiter goes in, leaves or runs out of time', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const { budget, filler } = full({ waitingPerAddressBytes: 3 * CAPTURE_BASE_WEIGHT_BYTES });
    const gone = new AbortController();
    const oldest = budget.admit('a', 1, undefined, CAPTURE_BASE_WEIGHT_BYTES);
    const leaving = budget.admit('a', 1, gone.signal, CAPTURE_BASE_WEIGHT_BYTES);
    const timing = budget.admit('a', 1, undefined, CAPTURE_BASE_WEIGHT_BYTES);

    assert.equal(budget.lineUsedBy('a'), 3 * CAPTURE_BASE_WEIGHT_BYTES);
    assert.deepEqual(await settledOrPending(budget.admit('a', 1, undefined, 1)), {
      outcome: 'line-full',
    });

    gone.abort();
    assert.deepEqual(await leaving, { outcome: 'cancelled' });
    assert.equal(budget.lineUsedBy('a'), 2 * CAPTURE_BASE_WEIGHT_BYTES);

    // The room it left takes one more.
    const another = budget.admit('a', 1, undefined, CAPTURE_BASE_WEIGHT_BYTES);

    await stillWaiting(another);

    t.mock.timers.tick(CAPTURE_WAIT_MS);
    assert.deepEqual(await timing, { outcome: 'timed-out' });
    assert.deepEqual(await oldest, { outcome: 'timed-out' });
    assert.deepEqual(await another, { outcome: 'timed-out' });
    assert.equal(budget.lineUsed, 0);
    assert.equal(budget.waiting, 0);

    const next = budget.admit('a', 1, undefined, CAPTURE_BASE_WEIGHT_BYTES);

    await stillWaiting(next);
    filler.release();
    (await admitted(next)).release();
    assert.equal(budget.lineUsed, 0);
  });

  it('refuses 100,000 webhooks of one address at once quickly once its line is full, and lets the others in', async () => {
    const { budget, filler } = full();
    const each = waitingWeight(['Host', 'h']);
    const room = Math.floor(CAPTURE_WAITING_PER_ADDRESS_BYTES / each);
    const waiters = Array.from({ length: room }, () => budget.admit('flood', 1, undefined, each));
    // Each refused leaves the line before `admit` returns, so a run leaves the
    // budget as it found it, and the next is made on the same one.
    const sent = withinBound(FLOOD_BOUND_MS, () =>
      Array.from({ length: 100_000 }, () => budget.admit('flood', 1, undefined, each)),
    );
    const refused = await Promise.all(sent.map((each) => settledOrPending(each)));

    assert.ok(refused.every((each) => each !== 'pending' && each.outcome === 'line-full'));
    assert.equal(budget.waiting, room);

    const other = budget.admit('other', 1, undefined, each);

    await stillWaiting(other);
    filler.release();

    for (const waiter of [...waiters, other]) {
      (await admitted(waiter)).release();
    }

    assert.equal(budget.lineUsed, 0);
  });
});

/** S4's request (D229): a `GET` with one header line, what each webhook of the flood weighs. */
const FLOOD_HEADERS = ['Host', 'hook.qa-tools.ru'];

/**
 * An ordinary sender's small webhook, as the measurement's small captures
 * send one: four header lines and a body of 17 bytes, about 81 KiB weighed.
 */
const SMALL_HEADERS = [
  'Host',
  'hook.qa-tools.ru',
  'Connection',
  'close',
  'Content-Type',
  'application/json',
  'Content-Length',
  '17',
];

/** The four addresses of #242's flood, each at its 16 MiB with its line full. */
const FLOODERS = ['10.145.1.10', '10.145.2.10', '10.145.3.10', '10.145.4.10'];

/** A seeded generator of numbers in [0, 1), so that a random interleaving can be run again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let mixed = Math.imul(state ^ (state >>> 15), state | 1);

    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** What the addresses holding more than a light sender may hold together (D261). */
function heavyHeld(budget: CaptureBudget, keys: Iterable<string>): number {
  let held = 0;

  for (const key of new Set(keys)) {
    const used = budget.usedBy(key);

    if (used > budget.settings.lightSenderBytes) {
      held += used;
    }
  }

  return held;
}

describe('the light senders’ reserve (D261)', () => {
  /**
   * #242's flood sent to a budget of its own: four addresses at their 16 MiB
   * of S4's webhooks, which is the process's 64 MiB, and each address's line
   * full. `admit` decides each webhook before it returns: admitted, waiting
   * or refused.
   */
  function floodSent(): { budget: CaptureBudget; sent: Promise<Admission>[] } {
    const budget = createCaptureBudget();
    const weight = captureWeight('GET', FLOOD_HEADERS);
    const waitWeight = waitingWeight(FLOOD_HEADERS);
    const sent = FLOODERS.flatMap((key) =>
      Array.from({ length: 1_300 }, () => budget.admit(key, weight, undefined, waitWeight)),
    );

    // 204 of 80.25 KiB fit an address's 16 MiB, and the four the process's
    // 64 MiB; 1,008 of 16.25 KiB fill an address's line.
    for (const key of FLOODERS) {
      assert.equal(budget.usedBy(key), 204 * weight);
      assert.equal(budget.lineUsedBy(key), 1_008 * waitWeight);
    }

    assert.ok(budget.used + weight > budget.settings.totalBytes, 'the process has room left');
    assert.ok(
      budget.lineUsed + waitWeight > budget.settings.waitingBytes,
      'the process’s line has room left',
    );

    return { budget, sent };
  }

  /** #242's flood in the budget, its webhooks sorted into those holding a place and those waiting. */
  async function flooded(): Promise<{
    budget: CaptureBudget;
    holds: CaptureHold[];
    waiters: Promise<Admission>[];
  }> {
    const { budget, sent } = floodSent();
    const holds: CaptureHold[] = [];
    const waiters: Promise<Admission>[] = [];
    const results = await Promise.all(sent.map((each) => settledOrPending(each)));

    results.forEach((result, index) => {
      if (result === 'pending') {
        waiters.push(sent[index] as Promise<Admission>);
      } else if (result.outcome === 'admitted') {
        holds.push(result.hold);
      } else {
        assert.equal(result.outcome, 'line-full');
      }
    });

    return { budget, holds, waiters };
  }

  it('admits a fifth address’s 81 KiB webhooks at once while it holds no more than a light sender, four addresses at 16 MiB each with their lines full: never waiting, never refused', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const { budget, waiters } = await flooded();
    const small = captureWeight('POST', SMALL_HEADERS);
    const waitSmall = waitingWeight(SMALL_HEADERS);
    const waitingBefore = budget.waiting;
    const floodHeld = budget.used;
    const ninth = '198.51.100.77';
    const held: CaptureHold[] = [];

    assert.equal(Math.round(small / 1024), 81);

    // As many as a light sender may hold, at once.
    const light = Math.floor(CAPTURE_LIGHT_SENDER_BYTES / small);

    for (let index = 0; index < light; index += 1) {
      held.push(await admitted(budget.admit(ninth, small, undefined, waitSmall)));
    }

    assert.equal(budget.usedBy(ninth), light * small);
    assert.ok(budget.usedBy(ninth) <= CAPTURE_LIGHT_SENDER_BYTES);
    assert.ok(budget.usedBy(ninth) + small > CAPTURE_LIGHT_SENDER_BYTES);

    // Ten a second, each answered as the next arrives: 1,000 in turn, every
    // one admitted at once, the flood's places and lines untouched.
    for (let index = 0; index < 1_000; index += 1) {
      const answered = held.shift() as CaptureHold;

      answered.shrink(storedWeight('POST', SMALL_HEADERS, 200));
      answered.release();
      held.push(await admitted(budget.admit(ninth, small, undefined, waitSmall)));
      assert.ok(budget.used <= inFlightBound(budget.settings));
    }

    assert.equal(budget.waiting, waitingBefore);
    assert.equal(budget.used, floodHeld + light * small);
    assert.equal(budget.lineUsedBy(ninth), 0);

    // The next, past a light sender's bytes, is a heavy sender's: the first
    // of its address waits, as before, and goes in once its address is light
    // again.
    const fiftyFirst = budget.admit(ninth, small, undefined, waitSmall);

    await stillWaiting(fiftyFirst);
    (held.shift() as CaptureHold).release();
    held.push(await admitted(fiftyFirst));

    for (const hold of held) {
      hold.release();
    }

    assert.equal(budget.usedBy(ninth), 0);
    t.mock.timers.tick(CAPTURE_WAIT_MS);

    for (const waiter of waiters) {
      assert.deepEqual(await waiter, { outcome: 'timed-out' });
    }

    assert.equal(budget.waiting, 0);
  });

  it('lets light senders fill the reserve and no more: the next light webhook waits, and goes in once one of them is answered or leaves', async () => {
    const budget = createCaptureBudget({
      totalBytes: 100,
      perAddressBytes: 100,
      lightSenderBytes: 10,
      lightReserveBytes: 20,
    });
    const heavy = budget.take('heavy', 100);
    const a = [await admitted(budget.admit('a', 5)), await admitted(budget.admit('a', 5))];
    const b = await admitted(budget.admit('b', 10));

    assert.equal(budget.used, 120);

    const c = budget.admit('c', 5);
    const gone = new AbortController();
    const d = budget.admit('d', 5, gone.signal);

    await stillWaiting(c);
    await stillWaiting(d);

    // Answered: shrunk once stored, then given back once the reply has closed.
    (a[0] as CaptureHold).shrink(1);
    await stillWaiting(c);
    (a[0] as CaptureHold).release();

    const cHold = await admitted(c);

    assert.equal(budget.used, 120);
    await stillWaiting(d);

    // A light sender that left while it waited held nothing, and its place in
    // the line is given back.
    gone.abort();
    assert.deepEqual(await d, { outcome: 'cancelled' });
    assert.equal(budget.used, 120);
    assert.equal(budget.waiting, 0);

    // A light sender that leaves after going in gives its place back too.
    const e = budget.admit('e', 10);

    await stillWaiting(e);
    b.release();

    const eHold = await admitted(e);

    for (const hold of [heavy, a[1] as CaptureHold, cHold, eHold]) {
      hold.release();
    }

    assert.equal(budget.used, 0);
  });

  it('holds nothing of the reserve for a light webhook refused, after its wait or at once, and leaves it whole for the next', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const budget = createCaptureBudget({
      totalBytes: 100,
      perAddressBytes: 100,
      lightSenderBytes: 10,
      lightReserveBytes: 20,
      waitingBytes: 1,
      waitingPerAddressBytes: 1,
    });
    const filler = budget.take('filler', 120);
    // The first of its address waits; the next has no room in the line.
    const first = budget.admit('light', 5, undefined, 1);
    const second = budget.admit('light', 5, undefined, 1);

    assert.deepEqual(await settledOrPending(second), { outcome: 'line-full' });
    await stillWaiting(first);
    t.mock.timers.tick(CAPTURE_WAIT_MS);
    assert.deepEqual(await first, { outcome: 'timed-out' });
    assert.equal(budget.used, 120);
    assert.equal(budget.usedBy('light'), 0);
    assert.equal(budget.lineUsed, 0);
    assert.equal(budget.waiting, 0);

    // The whole reserve is there for the next light sender.
    filler.shrink(100);

    const next = await admitted(budget.admit('next', 10));

    assert.equal(budget.used, 110);
    next.release();
    filler.release();
  });

  it('holds a heavy address to its 16 MiB and the heavy addresses together to 64 MiB, while light ones go in past it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const budget = createCaptureBudget();
    const large = captureWeight('POST', length(MAX_BODY_BYTES));
    const small = captureWeight('POST', SMALL_HEADERS);
    const keys = ['h1', 'h2', 'h3', 'h4', 'h5'];
    const lights = Array.from({ length: 4 }, (_, index) => `light-${index}`);
    const holds: CaptureHold[] = [];
    // Twenty of 1 MiB from each of five addresses: 100 MiB asked for.
    const sent = keys.flatMap((key) =>
      Array.from({ length: 20 }, () =>
        budget.admit(key, large).then((result) => {
          assert.equal(result.outcome, 'admitted');

          if (result.outcome === 'admitted') {
            holds.push(result.hold);
          }
        }),
      ),
    );
    const check = (): void => {
      for (const key of keys) {
        assert.ok(budget.usedBy(key) <= CAPTURE_BUDGET_PER_ADDRESS_BYTES, key);
      }

      assert.ok(heavyHeld(budget, [...keys, ...lights]) <= CAPTURE_BUDGET_BYTES);
      assert.ok(budget.used <= inFlightBound(budget.settings));
    };

    await new Promise((resolve) => setImmediate(resolve));
    check();
    // The fifth, light while it holds no more than a light sender may, takes
    // no more of the reserve than that.
    assert.ok(budget.used - CAPTURE_BUDGET_BYTES <= CAPTURE_LIGHT_SENDER_BYTES);
    assert.ok(budget.waiting > 0);

    // Light senders go in past the 64 MiB; the heavy ones stay under it.
    for (const key of lights) {
      while (
        budget.usedBy(key) + small <= CAPTURE_LIGHT_SENDER_BYTES &&
        budget.used + small <= inFlightBound(budget.settings)
      ) {
        holds.push(await admitted(budget.admit(key, small)));
      }
    }

    assert.ok(budget.used > CAPTURE_BUDGET_BYTES, 'the reserve was not used');
    check();

    // Every place given back lets the heavy waiters in, each address to its
    // 16 MiB and all of them to 64 MiB at most.
    while (holds.length > 0) {
      (holds.shift() as CaptureHold).release();
      check();
      await new Promise((resolve) => setImmediate(resolve));
      check();
    }

    await Promise.all(sent);
    assert.equal(budget.used, 0);
  });

  it('never takes the total past 64 MiB and the reserve, nor heavy addresses past 64 MiB, under 3 × 4,000 random steps of admissions, answers, leaving and waits running out', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const large = captureWeight('POST', length(MAX_BODY_BYTES));
    const flood = captureWeight('GET', FLOOD_HEADERS);
    const small = captureWeight('POST', SMALL_HEADERS);
    const largest = captureWeight('POST', [...length(MAX_BODY_BYTES), ...lines(16_318)]);
    // Flooders of 1 MiB and of S4's GETs, ten light senders - together far
    // more than the reserve - one alternating between the two, and one
    // sending the largest webhook there is.
    const senders: Record<string, readonly number[]> = {
      f1: [large],
      f2: [large],
      f3: [flood],
      f4: [flood],
      f5: [large, flood],
      l1: [small],
      l2: [small],
      l3: [small],
      l4: [small],
      l5: [small],
      l6: [small],
      l7: [small],
      l8: [small],
      l9: [small],
      l10: [small],
      alternating: [small, large],
      largest: [largest],
    };
    const keys = Object.keys(senders);

    for (const seed of [262, 2_026, 80]) {
      const random = seeded(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
      const budget = createCaptureBudget();
      const bound = inFlightBound(budget.settings);
      const holds: CaptureHold[] = [];
      const leaving: AbortController[] = [];
      let pending = 0;
      // The most in flight at once, so that the run is known to have filled
      // the reserve rather than stayed under the 64 MiB.
      let peak = 0;

      const check = (): void => {
        let sum = 0;

        for (const key of keys) {
          assert.ok(budget.usedBy(key) <= CAPTURE_BUDGET_PER_ADDRESS_BYTES, `${key}, seed ${seed}`);
          sum += budget.usedBy(key);
        }

        assert.equal(sum, budget.used);
        assert.ok(budget.used <= bound, `seed ${seed}: ${budget.used} in flight`);
        assert.ok(heavyHeld(budget, keys) <= CAPTURE_BUDGET_BYTES, `seed ${seed}`);

        peak = Math.max(peak, budget.used);
      };

      for (let step = 0; step < 4_000; step += 1) {
        const roll = random();

        if (roll < 0.55) {
          // One webhook, or a burst of 1 to 60 from one address at once.
          const key = pick(keys);
          const count = roll < 0.15 ? 1 + Math.floor(random() * 60) : 1;

          for (let index = 0; index < count; index += 1) {
            const weight = pick(senders[key] as readonly number[]);
            const gone = new AbortController();

            leaving.push(gone);
            pending += 1;
            void budget
              .admit(key, weight, gone.signal, CAPTURE_BASE_WEIGHT_BYTES)
              .then((result) => {
                pending -= 1;

                if (result.outcome === 'admitted') {
                  holds.push(result.hold);
                }
              });
          }
        } else if (roll < 0.8 && holds.length > 0) {
          holds.splice(Math.floor(random() * holds.length), 1)[0]?.release();
        } else if (roll < 0.9 && holds.length > 0) {
          pick(holds).shrink(Math.floor(random() * 32 * 1024));
        } else if (roll < 0.95 && leaving.length > 0) {
          leaving.splice(Math.floor(random() * leaving.length), 1)[0]?.abort();
        } else {
          t.mock.timers.tick(Math.floor(random() * 5_000));
        }

        check();
        await new Promise((resolve) => setImmediate(resolve));
        check();
      }

      assert.ok(peak > bound - MIB, `seed ${seed}: the reserve was never filled, ${peak} at most`);

      // Everything answered and every wait run out: nothing is left held.
      while (pending > 0 || holds.length > 0) {
        for (const hold of holds.splice(0)) {
          hold.release();
        }

        t.mock.timers.tick(CAPTURE_WAIT_MS);
        await new Promise((resolve) => setImmediate(resolve));
        check();
      }

      assert.equal(budget.used, 0);
      assert.equal(budget.waiting, 0);
      assert.equal(budget.lineUsed, 0);
    }
  });

  it('keeps heavy waiters first come first served among themselves, while a light one goes in past them', async () => {
    const budget = createCaptureBudget({
      totalBytes: 100,
      perAddressBytes: 100,
      lightSenderBytes: 10,
      lightReserveBytes: 20,
    });
    const filler = budget.take('filler', 120);
    const order: string[] = [];
    const watch = (name: string, admission: Promise<Admission>): Promise<Admission> =>
      admission.then((result) => {
        order.push(name);

        return result;
      });
    const first = watch('h1', budget.admit('h1', 30));
    const light = watch('l1', budget.admit('l1', 3));
    const second = watch('h2', budget.admit('h2', 15));
    const third = watch('h3', budget.admit('h3', 20));

    // Room for the light one in the reserve alone.
    filler.shrink(117);
    await admitted(light);

    // Room for the second heavy one, not the first: neither goes in.
    filler.shrink(80);
    await stillWaiting(first);
    await stillWaiting(second);

    // Room for the first: it goes in, and the others after it, in order, as
    // the room comes.
    filler.shrink(67);
    await admitted(first);
    await stillWaiting(second);
    filler.release();
    await admitted(second);
    await admitted(third);
    assert.deepEqual(order, ['l1', 'h1', 'h2', 'h3']);
  });

  it('never lets a heavy head that does not fit keep a light waiter behind it out', async () => {
    const budget = createCaptureBudget({
      totalBytes: 100,
      perAddressBytes: 100,
      lightSenderBytes: 10,
      lightReserveBytes: 20,
    });
    const filler = budget.take('filler', 120);
    const heavy = budget.admit('heavy', 40);
    const light = budget.admit('light', 4);
    const later = budget.admit('later', 4);

    await stillWaiting(heavy);
    await stillWaiting(light);

    // Room for the two light ones past the process's budget, never for the
    // heavy one ahead of them.
    filler.shrink(112);
    await admitted(light);
    await admitted(later);
    await stillWaiting(heavy);

    // And a light sender arriving now goes in at once, past the heavy head.
    filler.shrink(104);

    const arriving = await admitted(budget.admit('arriving', 4));

    await stillWaiting(heavy);
    filler.release();
    await admitted(heavy);
    arriving.release();
  });

  it('gives a flooder of 81 KiB webhooks on any number of connections no more of the reserve than a light sender may hold, and leaves the rest to another sender', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const small = captureWeight('POST', SMALL_HEADERS);
    // A run takes a light sender's bytes of its budget, so each is given a
    // budget of its own, flooded before the run is timed.
    const floods = Array.from({ length: TIMED_RUNS }, () => floodSent());
    let runs = 0;
    const { budget, flood, sent } = withinBound(FLOOD_BOUND_MS, () => {
      const { budget, sent: flood } = floods[runs] as ReturnType<typeof floodSent>;

      runs += 1;

      // 100,000 webhooks of 81 KiB at once, each on a connection of its own.
      return {
        budget,
        flood,
        sent: Array.from({ length: 100_000 }, () =>
          budget.admit('under', small, undefined, CAPTURE_BASE_WEIGHT_BYTES),
        ),
      };
    });
    const results = await Promise.all(sent.map((each) => settledOrPending(each)));
    const admittedCount = results.filter(
      (result) => result !== 'pending' && result.outcome === 'admitted',
    ).length;

    assert.equal(admittedCount, Math.floor(CAPTURE_LIGHT_SENDER_BYTES / small));
    assert.ok(budget.usedBy('under') <= CAPTURE_LIGHT_SENDER_BYTES);
    // The rest wait, its first, or are refused at once.
    assert.equal(results.filter((result) => result === 'pending').length, 1);

    // Another light sender still goes in at once.
    const other = await admitted(budget.admit('other', small));

    assert.ok(budget.used <= inFlightBound(budget.settings));
    other.release();
    t.mock.timers.tick(CAPTURE_WAIT_MS);

    for (const waiter of [...flood, ...sent]) {
      const result = await waiter;

      if (result.outcome === 'admitted') {
        result.hold.release();
      }
    }
  });

  it('lets a flooder alternate between light and heavy without taking more of the reserve than a light sender may hold', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const { budget, holds, waiters } = await flooded();
    const large = captureWeight('POST', length(MAX_BODY_BYTES));
    const small = captureWeight('POST', SMALL_HEADERS);
    const keys = [...FLOODERS, 'alternating'];
    const mine: CaptureHold[] = [];

    // Light: as many of 1 MiB as a light sender may hold go in past the
    // 64 MiB; the next would pass that.
    const fit = Math.floor(CAPTURE_LIGHT_SENDER_BYTES / large);
    const flood = captureWeight('GET', FLOOD_HEADERS);

    for (let index = 0; index < fit; index += 1) {
      mine.push(await admitted(budget.admit('alternating', large)));
    }

    const next = budget.admit('alternating', large);

    await stillWaiting(next);
    assert.ok(budget.used > CAPTURE_BUDGET_BYTES);
    assert.ok(budget.usedBy('alternating') <= CAPTURE_LIGHT_SENDER_BYTES);

    // Heavy now, it waits its turn behind the flood: the room that comes in
    // the 64 MiB goes to the flood's waiters, which came first.
    const released = Math.ceil((budget.used - CAPTURE_BUDGET_BYTES) / flood) + 10;

    for (const hold of holds.splice(0, released)) {
      hold.release();
    }

    assert.ok(budget.used <= CAPTURE_BUDGET_BYTES + CAPTURE_LIGHT_SENDER_BYTES);
    await stillWaiting(next);
    assert.ok(heavyHeld(budget, keys) <= CAPTURE_BUDGET_BYTES);

    // Light again once two of its own are answered: it goes in, and small
    // ones behind it too, to a light sender's bytes and no further.
    mine.shift()?.release();
    mine.shift()?.release();
    mine.push(await admitted(next));

    while (budget.usedBy('alternating') + small <= CAPTURE_LIGHT_SENDER_BYTES) {
      mine.push(await admitted(budget.admit('alternating', small)));
    }

    const past = budget.admit('alternating', small);

    await stillWaiting(past);
    assert.ok(budget.usedBy('alternating') <= CAPTURE_LIGHT_SENDER_BYTES);
    assert.ok(budget.used <= inFlightBound(budget.settings));
    assert.ok(heavyHeld(budget, keys) <= CAPTURE_BUDGET_BYTES);

    for (const hold of mine) {
      hold.release();
    }

    t.mock.timers.tick(CAPTURE_WAIT_MS);

    for (const waiter of [...waiters, past]) {
      const result = await waiter;

      if (result.outcome === 'admitted') {
        result.hold.release();
      }
    }
  });

  it('reads light or heavy when a waiter is weighed, not when it came: one that becomes heavy waits for the 64 MiB, one that becomes light goes in past it', async () => {
    const budget = createCaptureBudget({
      totalBytes: 100,
      perAddressBytes: 100,
      lightSenderBytes: 10,
      lightReserveBytes: 20,
    });
    const filler = budget.take('filler', 120);
    const held = budget.take('a', 2);

    // Light while it waits for room in the reserve...
    const waiting = budget.admit('a', 4);

    await stillWaiting(waiting);

    // ...and heavy once its address holds more: a handler taking its weight
    // again (`take`). Room in the reserve alone no longer lets it in.
    const taken = budget.take('a', 6);

    filler.shrink(90);
    await stillWaiting(waiting);

    // Room in the process's budget does.
    filler.shrink(80);

    const aHold = await admitted(waiting);

    assert.equal(budget.used, 92);

    // Heavy while it waits, its address holding 8 already; light once that
    // is given back, and in past the process's budget.
    const more = budget.take('more', 20);
    const cHeld = budget.take('c', 8);
    const cWaiting = budget.admit('c', 4);

    await stillWaiting(cWaiting);
    cHeld.release();

    const cHold = await admitted(cWaiting);

    assert.equal(budget.used, 116);

    for (const hold of [filler, held, taken, aHold, more, cHold]) {
      hold.release();
    }

    assert.equal(budget.used, 0);
  });
});

/** A socket that records whether it is paused and every pause and resume. */
function fakeSocket(paused = false): { socket: Socket; calls: string[] } {
  const calls: string[] = [];
  let isPaused = paused;
  const socket = {
    destroyed: false,
    pause() {
      calls.push('pause');
      isPaused = true;

      return socket;
    },
    resume() {
      calls.push('resume');
      isPaused = false;

      return socket;
    },
    isPaused: () => isPaused,
  };

  return { socket: socket as unknown as Socket, calls };
}

/** One turn later, when a stop's last release decides. */
const nextTurn = (): Promise<void> => new Promise((resolve) => process.nextTick(resolve));

describe('the stop of a connection, shared by its waiting webhooks (D210)', () => {
  it('is taken by the first, and the connection read again only once the last is released', async () => {
    const stopReading = connectionStops();
    const { socket, calls } = fakeSocket();
    const first = stopReading(socket);
    const second = stopReading(socket);

    assert.deepEqual(calls, ['pause']);
    first();
    await nextTurn();
    assert.deepEqual(calls, ['pause'], 'read again while the second still waits');
    second();
    assert.deepEqual(calls, ['pause'], 'read again before the next turn');
    await nextTurn();
    assert.deepEqual(calls, ['pause', 'resume']);
    assert.equal(socket.isPaused(), false);
  });

  it('stays stopped when another of its webhooks starts waiting in the same turn as the last is released', async () => {
    const stopReading = connectionStops();
    const { socket, calls } = fakeSocket();

    stopReading(socket)();

    const next = stopReading(socket);

    await nextTurn();
    assert.deepEqual(calls, ['pause'], 'resumed then paused in one turn');
    assert.equal(socket.isPaused(), true);
    next();
    await nextTurn();
    assert.deepEqual(calls, ['pause', 'resume']);
  });

  it('leaves a connection Node stopped itself to Node, and stops one Node started again for the next', async () => {
    const stopReading = connectionStops();
    const { socket, calls } = fakeSocket(true);
    const nodes = stopReading(socket);

    nodes();
    await nextTurn();
    assert.deepEqual(calls, [], 'touched a connection Node had stopped');

    socket.resume();
    stopReading(socket)();
    await nextTurn();
    assert.deepEqual(calls, ['resume', 'pause', 'resume']);
  });

  it('counts a release once, and never starts a connection that has gone', async () => {
    const stopReading = connectionStops();
    const { socket, calls } = fakeSocket();
    const first = stopReading(socket);
    const second = stopReading(socket);

    first();
    first();
    await nextTurn();
    assert.deepEqual(calls, ['pause'], 'a repeated release counted twice');

    (socket as { destroyed: boolean }).destroyed = true;
    second();
    await nextTurn();
    assert.deepEqual(calls, ['pause']);

    // Nor stops one, or a request with none.
    stopReading(socket)();
    stopReading(null)();
    await nextTurn();
    assert.deepEqual(calls, ['pause']);
  });
});

describe('the weight of an HTTP/2 webhook (D263)', () => {
  const pseudo = [':method', 'POST', ':path', '/s/x', ':scheme', 'https', ':authority', 'h'];
  const fixed = (lines: number): number =>
    CAPTURE_BASE_WEIGHT_BYTES + lines * CAPTURE_HEADER_LINE_WEIGHT_BYTES;

  it('weighs a body with no content-length as open on a stream still open, and as none on one that ended with its headers', () => {
    const open = { endedWithHeaders: false };
    const ended = { endedWithHeaders: true };

    assert.equal(
      captureWeight('POST', pseudo, open),
      MAX_BODY_BYTES + fixed(4) + CAPTURE_ANSWER_RESERVE_BYTES,
    );
    assert.equal(captureWeight('POST', pseudo, ended), fixed(4) + CAPTURE_ANSWER_RESERVE_BYTES);
    // HTTP/1.1, no framing: no body, as before.
    assert.equal(captureWeight('POST', pseudo), fixed(4) + CAPTURE_ANSWER_RESERVE_BYTES);
    // A content-length decides as over HTTP/1.1, over 1 MiB weighing nothing.
    assert.equal(
      captureWeight('POST', [...pseudo, 'content-length', '10'], open),
      10 + fixed(5) + CAPTURE_ANSWER_RESERVE_BYTES,
    );
    assert.equal(
      captureWeight('POST', [...pseudo, 'content-length', String(MAX_BODY_BYTES + 1)], open),
      0,
    );
    // A GET, HEAD or TRACE keeps what it sends unread, at most 1 MiB.
    assert.equal(unreadBodyWeight('GET', pseudo, open), MAX_BODY_BYTES);
    assert.equal(unreadBodyWeight('GET', pseudo, ended), 0);
    assert.equal(storedWeight('GET', pseudo, 100, open), fixed(4) + MAX_BODY_BYTES + 100);
    assert.equal(waitingWeight(pseudo, open), fixed(4));
  });

  it('weighs header bytes past 16 KiB, which only an HTTP/2 list can carry', () => {
    const framing = { endedWithHeaders: true };
    const big = [...pseudo, 'x-big', 'v'.repeat(100_000)];
    const bytes = big.reduce((sum, text) => sum + text.length, 0);

    assert.equal(waitingWeight(big, framing), fixed(5) + bytes - CAPTURE_BASE_WEIGHT_BYTES);
    assert.equal(
      captureWeight('POST', big, framing),
      fixed(5) + bytes - CAPTURE_BASE_WEIGHT_BYTES + CAPTURE_ANSWER_RESERVE_BYTES,
    );
    // Within 16 KiB, nothing more; and HTTP/1.1 never counts it.
    assert.equal(waitingWeight(pseudo, framing), fixed(4));
    assert.equal(waitingWeight(big), fixed(5));
  });
});
