/**
 * The bodies of a response queue and of a creation with one (D205), without a
 * server: the parsers against made-up input built to break them, at 1 KiB,
 * 64 KiB and 1 MiB - the body limit of both routes, as of every JSON route -
 * and a full queue of ordinary text read whole within that limit.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_BODY_BYTES,
  MAX_QUEUE_STEPS,
  MAX_RESPONSE_BODY_BYTES,
} from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import { ordinaryFullQueue, ordinaryFullResponse } from '../../testing/full-queue.ts';
import { INVALID_RESPONSES } from '../../testing/invalid-responses.ts';
import { assertFieldLeadsMessage } from '../../testing/refusal-field.ts';
import { withinBound } from '../../testing/timing.ts';
import { parseCreateSessionBody, parseQueueBody } from './response-config.ts';

const SIZES = [1024, 64 * 1024, MAX_BODY_BYTES];

/** Generous for a body the size of the limit; a regression to quadratic time is seconds. */
const BOUND_MS = 500;

/** `unit` repeated to `size` characters, cut at the end. */
function filled(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

/** `unit` repeated as many whole times as fit in `size` characters. */
function whole(unit: string, size: number): string {
  return unit.repeat(Math.floor(size / unit.length));
}

/** The refusal `parse` throws, or a failure when it throws none. */
function refusal(parse: () => unknown): AppError {
  try {
    parse();
  } catch (error) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);

    return error;
  }

  assert.fail('nothing was refused');
}

function assertRefused(parse: () => unknown, statusCode: number, errorCode: number): AppError {
  const error = refusal(parse);

  assert.equal(error.statusCode, statusCode, error.message);
  assert.equal(error.errorCode, errorCode, error.message);

  if (errorCode === 1005) {
    assertFieldLeadsMessage(error, error.message);
  } else {
    assert.equal(error.field, undefined, error.message);
  }

  return error;
}

/**
 * What a parser answers: what it read, or its refusal. Anything else it
 * throws - a `TypeError`, a `RangeError` - fails the test, since the route
 * would answer it `500`.
 */
function outcome(parse: () => unknown): unknown {
  try {
    return parse();
  } catch (error) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);
    assert.equal(error.statusCode, 400, error.message);

    if (error.errorCode === 1005) {
      assertFieldLeadsMessage(error, error.message);
      assert.ok((error.field?.length ?? 0) <= 40, error.field);
    } else {
      assert.equal(error.field, undefined, error.message);
    }

    return error;
  }
}

/**
 * How a made-up body must be answered: `1005` when it breaks a rule, either
 * `1005` or `1006` where the parser may give up on the depth first, and
 * `read` for a step it may accept while its body is within 64 KiB and must
 * refuse by that rule beyond it.
 */
type Verdict = 1005 | 'either' | 'read';

/** `{"steps":…}` bodies; a creation is sent the same as `{"queue":{"steps":…}}`. */
const STEPS: readonly [string, (size: number) => string, Verdict][] = [
  ['steps of 1', (size) => `{"steps":[${whole('1,', size - 12)}1]}`, 1005],
  ['steps of empty objects', (size) => `{"steps":[${whole('{},', size - 13)}{}]}`, 1005],
  [
    'nested arrays as a step',
    (size) => `{"steps":[${filled('[', size / 2)}${filled(']', size / 2)}]}`,
    'either',
  ],
  [
    'nested objects as the steps',
    (size) => {
      const depth = Math.floor(size / 6);

      return `{"steps":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}}`;
    },
    'either',
  ],
  ['duplicate keys', (size) => `{${whole('"steps":[],', size - 8)}"a":1}`, 1005],
  [
    'header pairs in one step',
    (size) => `{"steps":[{"status":200,"headers":[${whole('["a","b"],', size - 40)}["a","b"]]}]}`,
    1005,
  ],
  [
    'unknown keys in one step',
    (size) => {
      const keys = Array.from(
        { length: Math.floor(size / 12) },
        (_unused, index) => `"k${index}":1`,
      );

      return `{"steps":[{"status":200,${keys.join(',')}}]}`;
    },
    1005,
  ],
  [
    'brackets in a body',
    (size) => `{"steps":[{"status":200,"body":"${filled('[{,}]', size)}"}]}`,
    'read',
  ],
  [
    'escaped quotes in a body',
    (size) => `{"steps":[{"status":200,"body":"${whole('\\"', size)}"}]}`,
    'read',
  ],
  [
    'two-byte letters in a body',
    (size) => `{"steps":[{"status":200,"body":"${filled('é', size / 2)}"}]}`,
    'read',
  ],
  [
    'emoji in a body',
    (size) => `{"steps":[{"status":200,"body":"${filled('😀', size / 4)}"}]}`,
    'read',
  ],
  [
    'lone surrogates in a body',
    (size) => `{"steps":[{"status":200,"body":"${whole('\\ud800', size)}"}]}`,
    'read',
  ],
];

/** Text that is no JSON object, sent as it is to both routes. */
const MALFORMED: readonly [string, (size: number) => string][] = [
  ['opening brackets', (size) => filled('[', size)],
  ['empty arrays in an array', (size) => `[${filled('[],', size - 2)}]`],
  ['commas', (size) => filled(',', size)],
  ['quotes', (size) => filled('"', size)],
  ['backslashes', (size) => filled('\\', size)],
  ['an unterminated string', (size) => `{"steps":"${filled('a', size)}`],
  ['digits', (size) => filled('9', size)],
];

function assertVerdict(label: string, size: number, answer: unknown, verdict: Verdict): void {
  if (verdict === 'read') {
    if (answer instanceof AppError) {
      assert.equal(answer.errorCode, 1005, label);
      assert.match(answer.message, /body must be at most 65536 bytes/, label);
    } else {
      assert.ok(Array.isArray(answer), label);
    }

    if (size > 2 * MAX_RESPONSE_BODY_BYTES) {
      assert.ok(answer instanceof AppError, `${label} was accepted`);
    }

    return;
  }

  assert.ok(answer instanceof AppError, `${label} was accepted`);

  if (verdict === 'either') {
    assert.ok(answer.errorCode === 1005 || answer.errorCode === 1006, label);
  } else {
    assert.equal(answer.errorCode, verdict, label);
  }
}

describe('a queue body and a creation, against made-up input up to 1 MiB (D205)', () => {
  for (const [name, build, verdict] of STEPS) {
    it(`answers ${name} at 1 KiB, 64 KiB and 1 MiB within a bound, on both routes`, () => {
      for (const size of SIZES) {
        const text = build(size);
        const create = `{"queue":${text}}`;

        // What the routes would parse: nothing over the limit reaches them.
        assert.ok(Buffer.byteLength(create) <= MAX_BODY_BYTES + 64, `${name} at ${size}`);

        const read = withinBound(BOUND_MS, () => outcome(() => parseQueueBody(text)));
        const created = withinBound(BOUND_MS, () => outcome(() => parseCreateSessionBody(create)));

        assertVerdict(`${name} at ${size}`, size, read, verdict);
        assertVerdict(
          `${name} at ${size}, created`,
          size,
          created instanceof AppError ? created : (created as { queue: unknown }).queue,
          verdict,
        );
      }
    });
  }

  for (const [name, build] of MALFORMED) {
    it(`refuses ${name} at 1 KiB, 64 KiB and 1 MiB as 1006 within a bound, on both routes`, () => {
      for (const size of SIZES) {
        const text = build(size);

        for (const parse of [() => parseQueueBody(text), () => parseCreateSessionBody(text)]) {
          withinBound(BOUND_MS, () => assertRefused(parse, 400, 1006));
        }
      }
    });
  }

  it('reads ten steps of ordinary text at every limit whole, and a creation with a response beside them', () => {
    const steps = ordinaryFullQueue();
    const response = ordinaryFullResponse();
    const queueBody = JSON.stringify({ steps });
    const createBody = JSON.stringify({ response, queue: { steps } });

    // About 721 KiB and 794 KiB: within the 1 MiB, with room for some escaping.
    assert.ok(Buffer.byteLength(createBody) < MAX_BODY_BYTES, `${createBody.length} characters`);

    const read = parseQueueBody(queueBody);
    const created = parseCreateSessionBody(createBody);

    assert.equal(read.length, MAX_QUEUE_STEPS);
    assert.deepEqual(read[9], response);
    assert.deepEqual(created.response, response);
    assert.deepEqual(created.queue?.[9], response);
  });
});

describe('the steps of a queue, against made-up shapes (D205)', () => {
  it('refuses a step count over 10 before it reads any step', () => {
    const steps = Array.from({ length: 50_000 }, () => 'not a response');
    const error = withinBound(150, () =>
      assertRefused(() => parseQueueBody(JSON.stringify({ steps })), 400, 1005),
    );

    assert.equal(error.message, 'steps must contain 1 to 10 responses');
  });

  it('refuses a __proto__ key as an unknown key, beside the steps and inside a step', () => {
    const beside = assertRefused(
      () => parseQueueBody('{"steps":[{"status":200}],"__proto__":{"steps":[]}}'),
      400,
      1005,
    );
    const inside = assertRefused(
      () => parseQueueBody('{"steps":[{"status":200,"__proto__":{"delayMs":1}}]}'),
      400,
      1005,
    );
    const inQueue = assertRefused(
      () => parseCreateSessionBody('{"queue":{"steps":[{"status":200}],"__proto__":{}}}'),
      400,
      1005,
    );

    assert.equal(beside.message, 'The request body may contain no key other than "steps"');
    assert.match(inside.message, /^steps\[0\] may contain no key other than/);
    assert.equal(inQueue.message, 'queue may contain no key other than "steps"');
  });

  it('refuses steps that only look like an array', () => {
    for (const steps of ['{"length":2,"0":{"status":200}}', '"[]"', '2', 'true']) {
      const error = assertRefused(() => parseQueueBody(`{"steps":${steps}}`), 400, 1005);

      assert.equal(error.message, 'steps is required and must be an array of 1 to 10 responses');
    }
  });

  it('names the first broken step by its position, whatever follows it', () => {
    const error = assertRefused(
      () =>
        parseQueueBody(
          JSON.stringify({ steps: [{ status: 200 }, { status: 200 }, { status: 99 }, null] }),
        ),
      400,
      1005,
    );

    assert.equal(
      error.message,
      'steps[2].status is required and must be an integer between 200 and 599',
    );
  });

  it('never echoes a refused value (D106)', () => {
    const secret = 'v'.repeat(1025);
    const error = assertRefused(
      () => parseQueueBody(JSON.stringify({ steps: [{ status: 200, headers: [['x', secret]] }] })),
      400,
      1005,
    );

    assert.equal(error.message.includes(secret), false);
    assert.match(error.message, /^steps\[0\]\.headers\[0\] value/);
  });
});

describe('the field of a refused step (D257, criterion 1)', () => {
  /** The `field` of the `1005` refusal of `parse`. */
  function fieldOf(parse: () => unknown): string | undefined {
    return assertRefused(parse, 400, 1005).field;
  }

  it('names every check of a step by the step’s place, in a save and in a creation', () => {
    for (const [name, response, place] of INVALID_RESPONSES) {
      const steps = [{ status: 200 }, response];

      assert.equal(
        fieldOf(() => parseQueueBody(JSON.stringify({ steps }))),
        `steps[1]${place}`,
        name,
      );
      assert.equal(
        fieldOf(() => parseCreateSessionBody(JSON.stringify({ queue: { steps } }))),
        `queue.steps[1]${place}`,
        name,
      );
    }
  });

  it('names the list for its count or its type, and the queue of a creation', () => {
    for (const steps of [[], Array.from({ length: 50_000 }, () => 1), 'steps', null]) {
      assert.equal(
        fieldOf(() => parseQueueBody(JSON.stringify({ steps }))),
        'steps',
      );
    }

    assert.equal(
      fieldOf(() => parseQueueBody('{}')),
      'steps',
    );
    assert.equal(
      fieldOf(() => parseCreateSessionBody('{"queue":null}')),
      'queue',
    );
    assert.equal(
      fieldOf(() => parseCreateSessionBody('{"queue":[]}')),
      'queue',
    );
    assert.equal(
      fieldOf(() => parseCreateSessionBody('{"queue":{"steps":[]}}')),
      'queue.steps',
    );
    assert.equal(
      fieldOf(() => parseCreateSessionBody('{"queue":{"steps":[{"status":200}],"x":1}}')),
      'queue',
    );
  });

  it('names a step holding an unknown key by the step, and gives a key of the body none, never the key', () => {
    for (const key of ['k'.repeat(10_000), 'a\nb', 'a"b', 'steps[0].status']) {
      const inStep = assertRefused(
        () => parseQueueBody(`{"steps":[{"status":200,${JSON.stringify(key)}:1}]}`),
        400,
        1005,
      );
      const beside = assertRefused(
        () => parseQueueBody(`{"steps":[{"status":200}],${JSON.stringify(key)}:1}`),
        400,
        1005,
      );

      assert.equal(inStep.field, 'steps[0]', key.slice(0, 20));
      assert.equal(inStep.message.includes(key), false, key.slice(0, 20));
      assert.equal(beside.field, undefined, key.slice(0, 20));
      assert.equal(beside.message, 'The request body may contain no key other than "steps"');
    }
  });
});
