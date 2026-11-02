/**
 * The lifetime a creation may carry, `expiresInSeconds` (D220), without a
 * server: what `parseExpiresInSeconds` takes and refuses, where its refusal
 * stands among the create body's checks, that no message echoes the value
 * (D106), and made-up bodies built to break it at 1 KiB, 64 KiB and 1 MiB -
 * the body limit of the route - each answered within a bound.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_BODY_BYTES,
  SESSION_IDLE_DAYS,
  SESSION_LIFETIME_MAX_SECONDS,
  SESSION_LIFETIME_MIN_SECONDS,
} from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import { withinBound } from '../../testing/timing.ts';
import {
  LIFETIME_RULE,
  parseCreateSessionBody,
  parseExpiresInSeconds,
  type CreateSessionRequest,
} from './response-config.ts';

const SIZES = [1024, 64 * 1024, MAX_BODY_BYTES];

/** Generous for a body the size of the limit; a regression to quadratic time is seconds. */
const BOUND_MS = 500;

const NULL_RULE = `${LIFETIME_RULE}; omit it for a session that expires 7 days after its last use`;

/**
 * Names the idle window too since 1.1.0 (D242, `idle-window-body.test.ts`), and
 * the address choice since 1.2.0 (D243, `source-ip-body.test.ts`).
 */
const UNKNOWN_KEY_RULE =
  'The request body may contain no key other than "response", "queue", "expiresInSeconds", "expiresAfterIdleSeconds", "storeSourceIp", "rules" and "private"';

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

function refused(parse: () => unknown, errorCode = 1005): AppError {
  const error = refusal(parse);

  assert.equal(error.statusCode, 400, error.message);
  assert.equal(error.errorCode, errorCode, error.message);

  return error;
}

/**
 * What the create parser answers for `body`: what it read, or its refusal.
 * Anything else it throws - a `TypeError`, a `RangeError` - fails the test,
 * since the route would answer it `500`.
 */
function outcome(body: string): CreateSessionRequest | AppError {
  try {
    return parseCreateSessionBody(body);
  } catch (error) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);
    assert.equal(error.statusCode, 400, error.message);

    return error;
  }
}

describe('the bounds (D220)', () => {
  it('are 60 seconds and the idle window, 7 days', () => {
    assert.equal(SESSION_LIFETIME_MIN_SECONDS, 60);
    assert.equal(SESSION_LIFETIME_MAX_SECONDS, SESSION_IDLE_DAYS * 86_400);
    assert.equal(SESSION_LIFETIME_MAX_SECONDS, 604_800);
    assert.equal(LIFETIME_RULE, 'expiresInSeconds must be an integer from 60 to 604800');
  });
});

describe('parseExpiresInSeconds (D220)', () => {
  it('takes every whole number of seconds from 60 to 604800', () => {
    for (const value of [60, 61, 600, 3600, 86_400, 604_799, 604_800]) {
      assert.equal(parseExpiresInSeconds(value), value);
    }
  });

  it('takes a JSON number equal to an integer however it is written', () => {
    for (const [text, value] of [
      ['6e2', 600],
      ['600.0', 600],
      ['6.0E+2', 600],
      ['60000e-2', 600],
      ['6.048e5', 604_800],
      ['60.000', 60],
      // Beyond a double's precision the text reads as the integer itself: the
      // value is judged as JSON.parse reads it, as status and delayMs are.
      ['60.0000000000000001', 60],
    ] as const) {
      assert.equal(parseExpiresInSeconds(JSON.parse(text)), value, text);
    }
  });

  it('refuses anything else with the rule alone, and null with what to do instead', () => {
    for (const value of [
      '600',
      true,
      false,
      [],
      [600],
      {},
      { seconds: 600 },
      59,
      604_801,
      0,
      -0,
      -60,
      59.999,
      60.5,
      604_800.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      Number.MAX_VALUE,
      Number.MAX_SAFE_INTEGER,
      JSON.parse('1e400'),
      JSON.parse('-1e400'),
      undefined,
    ]) {
      const error = refused(() => parseExpiresInSeconds(value));

      assert.equal(error.message, LIFETIME_RULE, String(value));
    }

    assert.equal(refused(() => parseExpiresInSeconds(null)).message, NULL_RULE);
  });

  it('never echoes a refused value (D106)', () => {
    for (const text of ['123456789', '"7777"', '-31', '59.5', '1e400', '"secret-token"']) {
      const error = refused(() => parseCreateSessionBody(`{"expiresInSeconds":${text}}`));

      assert.equal(error.message, LIFETIME_RULE, text);
      assert.equal(error.message.includes(text.replaceAll('"', '')), false, text);
    }
  });
});

describe('a creation with a lifetime (D220)', () => {
  it('reads one alone as a default session, and beside a response and a queue', () => {
    assert.deepEqual(parseCreateSessionBody('{"expiresInSeconds":600}'), {
      response: null,
      queue: null,
      expiresInSeconds: 600,
      expiresAfterIdleSeconds: null,
      storeSourceIp: true,
      rules: [],
      private: false,
    });

    const both = parseCreateSessionBody(
      '{"response":{"status":201},"queue":{"steps":[{"status":503}]},"expiresInSeconds":60}',
    );

    assert.equal(both.expiresInSeconds, 60);
    assert.equal(both.response?.status, 201);
    assert.equal(both.queue?.[0]?.status, 503);
    assert.equal(
      parseCreateSessionBody('{"expiresInSeconds":604800,"queue":{"steps":[{"status":502}]}}')
        .expiresInSeconds,
      604_800,
    );
  });

  it('reads no body, {} and a body without the key as no lifetime', () => {
    for (const body of [undefined, '{}', '{"response":{"status":200}}']) {
      assert.equal(parseCreateSessionBody(body).expiresInSeconds, null, String(body));
    }
  });

  it('checks the response, then the queue, then the lifetime, then an unknown key', () => {
    assert.equal(
      refused(() => parseCreateSessionBody('{"expiresInSeconds":5,"response":{"status":99}}'))
        .message,
      'response.status is required and must be an integer between 200 and 599',
    );
    assert.equal(
      refused(() => parseCreateSessionBody('{"expiresInSeconds":5,"queue":{"steps":[]}}')).message,
      'queue.steps must contain 1 to 10 responses',
    );
    assert.equal(
      refused(() => parseCreateSessionBody('{"other":1,"expiresInSeconds":5}')).message,
      LIFETIME_RULE,
    );
    assert.equal(
      refused(() => parseCreateSessionBody('{"other":1,"expiresInSeconds":null}')).message,
      NULL_RULE,
    );
    assert.equal(
      refused(() => parseCreateSessionBody('{"expiresInSeconds":600,"other":1}')).message,
      UNKNOWN_KEY_RULE,
    );
    assert.equal(
      refused(() => parseCreateSessionBody('{"expiresinseconds":600}')).message,
      UNKNOWN_KEY_RULE,
    );
  });

  it('refuses a __proto__ key as an unknown key, and is not misled by one', () => {
    for (const body of [
      '{"__proto__":{"expiresInSeconds":600}}',
      '{"__proto__":600}',
      '{"expiresInSeconds":600,"__proto__":{"expiresInSeconds":5}}',
    ]) {
      assert.equal(refused(() => parseCreateSessionBody(body)).message, UNKNOWN_KEY_RULE, body);
    }
  });

  it('takes the last of duplicate keys, as JSON.parse does', () => {
    assert.equal(
      parseCreateSessionBody('{"expiresInSeconds":5,"expiresInSeconds":600}').expiresInSeconds,
      600,
    );
    assert.equal(
      refused(() => parseCreateSessionBody('{"expiresInSeconds":600,"expiresInSeconds":5}'))
        .message,
      LIFETIME_RULE,
    );
  });

  it('leaves a body that is no JSON object to 1006, before any rule', () => {
    for (const body of ['', '600', '"expiresInSeconds"', '[{"expiresInSeconds":600}]', 'null']) {
      refused(() => parseCreateSessionBody(body), 1006);
    }
  });
});

/**
 * Made-up creation bodies, each about `size` bytes, and how each must be
 * answered: the number it reads, `1005`, or `either` - `1005` or `1006` -
 * where the parser may give up on the depth first.
 */
const HOSTILE: readonly [string, (size: number) => string, number | 1005 | 'either'][] = [
  ['a number of that many digits', (size) => `{"expiresInSeconds":${filled('9', size)}}`, 1005],
  [
    'a number of that many digits after a 1',
    (size) => `{"expiresInSeconds":1${filled('0', size)}}`,
    1005,
  ],
  [
    'an integer padded with that many zeros of fraction',
    (size) => `{"expiresInSeconds":600.${filled('0', size)}}`,
    600,
  ],
  [
    'a fraction past a double’s precision',
    (size) => `{"expiresInSeconds":600.${filled('0', size)}1}`,
    600,
  ],
  [
    'a fraction just below the minimum',
    (size) => `{"expiresInSeconds":59.${filled('9', size)}}`,
    // Past a double's precision 59.99… is the double 60: judged as read.
    60,
  ],
  [
    'an exponent of that many digits',
    (size) => `{"expiresInSeconds":6e${filled('0', size)}2}`,
    600,
  ],
  ['a huge exponent', (size) => `{"expiresInSeconds":1e${filled('9', size)}}`, 1005],
  ['a tiny exponent', (size) => `{"expiresInSeconds":6e-${filled('9', size)}}`, 1005],
  ['a negative zero', (size) => `{"expiresInSeconds":-0.${filled('0', size)}}`, 1005],
  ['a string of digits', (size) => `{"expiresInSeconds":"${filled('6', size)}"}`, 1005],
  ['a string of escapes', (size) => `{"expiresInSeconds":"${whole('\\u0036', size)}"}`, 1005],
  [
    'nested arrays',
    (size) => `{"expiresInSeconds":${filled('[', size / 2)}${filled(']', size / 2)}}`,
    'either',
  ],
  [
    'nested objects',
    (size) => {
      const depth = Math.floor(size / 6);

      return `{"expiresInSeconds":${'{"a":'.repeat(depth)}600${'}'.repeat(depth)}}`;
    },
    'either',
  ],
  ['an array of numbers', (size) => `{"expiresInSeconds":[${whole('600,', size)}600]}`, 1005],
  [
    'white space around the value',
    (size) => `{"expiresInSeconds":${filled(' ', size / 2)}600${filled('\n', size / 2)}}`,
    600,
  ],
  [
    'duplicate keys, the last valid',
    (size) => `{${whole('"expiresInSeconds":1,', size)}"expiresInSeconds":600}`,
    600,
  ],
  [
    'duplicate keys, the last refused',
    (size) => `{${whole('"expiresInSeconds":600,', size)}"expiresInSeconds":1}`,
    1005,
  ],
  [
    'unknown keys after a valid lifetime',
    (size) => {
      const keys = Array.from(
        { length: Math.floor(size / 12) },
        (_unused, index) => `"k${index}":1`,
      );

      return `{"expiresInSeconds":600,${keys.join(',')}}`;
    },
    1005,
  ],
];

describe('a creation with a lifetime, against made-up input up to 1 MiB (D220)', () => {
  for (const [name, build, expected] of HOSTILE) {
    it(`answers ${name} at 1 KiB, 64 KiB and 1 MiB within a bound`, () => {
      for (const size of SIZES) {
        const body = build(size);
        const label = `${name} at ${size}`;

        // What the route would parse: nothing over the limit reaches it.
        assert.ok(Buffer.byteLength(body) <= MAX_BODY_BYTES + 64, label);

        const answer = withinBound(BOUND_MS, () => outcome(body));

        if (typeof expected === 'number' && expected !== 1005) {
          assert.ok(!(answer instanceof AppError), `${label}: ${String(answer)}`);
          assert.equal(answer.expiresInSeconds, expected, label);
          continue;
        }

        assert.ok(answer instanceof AppError, `${label} was accepted`);

        if (expected === 'either') {
          assert.ok(answer.errorCode === 1005 || answer.errorCode === 1006, label);
        } else {
          assert.equal(answer.errorCode, 1005, label);
        }

        // Whatever the body held, a refusal quotes none of it (D106).
        assert.ok(answer.message.length < 200, label);
      }
    });
  }
});
