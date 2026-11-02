/**
 * The idle window a creation may carry, `expiresAfterIdleSeconds` (D242),
 * without a server: what `parseExpiresAfterIdleSeconds` takes and refuses,
 * that it and `expiresInSeconds` are never taken together, where each refusal
 * stands among the create body's checks, that no message echoes the value
 * (D106), and made-up bodies built to break it at 1 KiB, 64 KiB and 1 MiB -
 * the body limit of the route - each answered within a bound.
 *
 * Modelled on `lifetime-body.test.ts`, which holds the same for
 * `expiresInSeconds` (D220).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_BODY_BYTES,
  SESSION_IDLE_DAYS,
  SESSION_IDLE_WINDOW_MAX_SECONDS,
  SESSION_IDLE_WINDOW_MIN_SECONDS,
} from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import { withinBound } from '../../testing/timing.ts';
import {
  IDLE_WINDOW_RULE,
  LIFETIME_RULE,
  ONE_EXPIRY_RULE,
  parseCreateSessionBody,
  parseExpiresAfterIdleSeconds,
  parseSessionExpiry,
  UNKNOWN_CREATE_KEY_RULE,
  type CreateSessionRequest,
} from './response-config.ts';

const SIZES = [1024, 64 * 1024, MAX_BODY_BYTES];

/** Generous for a body the size of the limit; a regression to quadratic time is seconds. */
const BOUND_MS = 500;

const NULL_RULE = `${IDLE_WINDOW_RULE}; omit it for a session that expires 7 days after its last use`;

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

describe('the bounds (D242)', () => {
  it('are an hour and the default window, 7 days', () => {
    assert.equal(SESSION_IDLE_WINDOW_MIN_SECONDS, 3600);
    assert.equal(SESSION_IDLE_WINDOW_MAX_SECONDS, SESSION_IDLE_DAYS * 86_400);
    assert.equal(SESSION_IDLE_WINDOW_MAX_SECONDS, 604_800);
    assert.equal(
      IDLE_WINDOW_RULE,
      'expiresAfterIdleSeconds must be an integer from 3600 to 604800',
    );
  });

  it('name the new key in the unknown-key message, beside the three before it and the address choice and the rules after it (D243, D246)', () => {
    assert.equal(
      UNKNOWN_CREATE_KEY_RULE,
      'The request body may contain no key other than "response", "queue", "expiresInSeconds", "expiresAfterIdleSeconds", "storeSourceIp", "rules" and "private"',
    );
  });
});

describe('parseExpiresAfterIdleSeconds (D242)', () => {
  it('takes every whole number of seconds from 3600 to 604800', () => {
    for (const value of [3600, 3601, 7200, 36_000, 86_400, 604_799, 604_800]) {
      assert.equal(parseExpiresAfterIdleSeconds(value), value);
    }
  });

  it('takes a JSON number equal to an integer however it is written, as expiresInSeconds does', () => {
    for (const [text, value] of [
      ['36e2', 3600],
      ['3600.0', 3600],
      ['3.6E+3', 3600],
      ['360000e-2', 3600],
      ['8.64e4', 86_400],
      ['6.048e5', 604_800],
      ['604800.000', 604_800],
      // Beyond a double's precision the text reads as the integer itself.
      ['3600.0000000000000001', 3600],
    ] as const) {
      assert.equal(parseExpiresAfterIdleSeconds(JSON.parse(text)), value, text);
    }
  });

  it('refuses anything else with the rule alone, and null with what to do instead', () => {
    for (const value of [
      '3600',
      '',
      true,
      false,
      [],
      [3600],
      {},
      { seconds: 3600 },
      3599,
      604_801,
      60,
      0,
      -0,
      -3600,
      3599.999,
      3600.5,
      604_799.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      Number.MAX_VALUE,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_VALUE,
      JSON.parse('1e400'),
      JSON.parse('-1e400'),
      undefined,
      BigInt(3600),
    ]) {
      const error = refused(() => parseExpiresAfterIdleSeconds(value));

      assert.equal(error.message, IDLE_WINDOW_RULE, String(value));
    }

    assert.equal(refused(() => parseExpiresAfterIdleSeconds(null)).message, NULL_RULE);
  });

  it('never echoes a refused value (D106)', () => {
    for (const text of ['123456789', '"7777"', '-31', '3599.5', '1e400', '"secret-token"', '59']) {
      const error = refused(() => parseCreateSessionBody(`{"expiresAfterIdleSeconds":${text}}`));

      assert.equal(error.message, IDLE_WINDOW_RULE, text);
      assert.equal(error.message.includes(text.replaceAll('"', '')), false, text);
    }
  });
});

describe('a creation with an idle window (D242)', () => {
  it('reads one alone as a default session that slides by it, and beside a response and a queue', () => {
    assert.deepEqual(parseCreateSessionBody('{"expiresAfterIdleSeconds":3600}'), {
      response: null,
      queue: null,
      expiresInSeconds: null,
      expiresAfterIdleSeconds: 3600,
      storeSourceIp: true,
      rules: [],
      private: false,
    });

    const both = parseCreateSessionBody(
      '{"response":{"status":201},"queue":{"steps":[{"status":503}]},"expiresAfterIdleSeconds":86400}',
    );

    assert.equal(both.expiresAfterIdleSeconds, 86_400);
    assert.equal(both.expiresInSeconds, null);
    assert.equal(both.response?.status, 201);
    assert.equal(both.queue?.[0]?.status, 503);
  });

  it('reads no body, {} and the bodies of before as no window and no lifetime', () => {
    for (const body of [
      undefined,
      '{}',
      '{"response":{"status":200}}',
      '{"queue":{"steps":[{"status":503}]}}',
    ]) {
      const read = parseCreateSessionBody(body);

      assert.equal(read.expiresAfterIdleSeconds, null, String(body));
      assert.equal(read.expiresInSeconds, null, String(body));
    }

    assert.deepEqual(parseCreateSessionBody('{"expiresInSeconds":600}'), {
      response: null,
      queue: null,
      expiresInSeconds: 600,
      expiresAfterIdleSeconds: null,
      storeSourceIp: true,
      rules: [],
      private: false,
    });
  });

  it('refuses the two expiry keys together, whatever their order and values', () => {
    for (const body of [
      '{"expiresInSeconds":600,"expiresAfterIdleSeconds":3600}',
      '{"expiresAfterIdleSeconds":3600,"expiresInSeconds":600}',
      '{"expiresInSeconds":604800,"expiresAfterIdleSeconds":604800}',
      '{"response":{"status":200},"expiresInSeconds":60,"expiresAfterIdleSeconds":86400}',
    ]) {
      assert.equal(refused(() => parseCreateSessionBody(body)).message, ONE_EXPIRY_RULE, body);
    }

    assert.equal(
      ONE_EXPIRY_RULE,
      'expiresInSeconds and expiresAfterIdleSeconds cannot be given together: a session either ends a fixed time after its creation or expires a time after its last use',
    );
  });

  it('checks the response, the queue, the lifetime, the window, the two together, then an unknown key', () => {
    for (const [body, message] of [
      [
        '{"expiresAfterIdleSeconds":5,"response":{"status":99}}',
        'response.status is required and must be an integer between 200 and 599',
      ],
      [
        '{"expiresAfterIdleSeconds":5,"queue":{"steps":[]}}',
        'queue.steps must contain 1 to 10 responses',
      ],
      ['{"expiresAfterIdleSeconds":5,"expiresInSeconds":5}', LIFETIME_RULE],
      ['{"expiresAfterIdleSeconds":5,"expiresInSeconds":600}', IDLE_WINDOW_RULE],
      ['{"expiresAfterIdleSeconds":null,"expiresInSeconds":600}', NULL_RULE],
      ['{"other":1,"expiresAfterIdleSeconds":5}', IDLE_WINDOW_RULE],
      ['{"other":1,"expiresInSeconds":600,"expiresAfterIdleSeconds":3600}', ONE_EXPIRY_RULE],
      ['{"expiresAfterIdleSeconds":3600,"other":1}', UNKNOWN_CREATE_KEY_RULE],
      ['{"expiresafteridleseconds":3600}', UNKNOWN_CREATE_KEY_RULE],
      ['{"expiresAfterIdleSecond":3600}', UNKNOWN_CREATE_KEY_RULE],
      ['{"expiresAfterIdleSeconds ":3600}', UNKNOWN_CREATE_KEY_RULE],
      ['{"idleSeconds":3600}', UNKNOWN_CREATE_KEY_RULE],
    ] as const) {
      assert.equal(refused(() => parseCreateSessionBody(body)).message, message, body);
    }
  });

  it('refuses the key nested anywhere it does not belong', () => {
    for (const [body, message] of [
      [
        '{"response":{"status":200,"expiresAfterIdleSeconds":3600}}',
        'response may contain no key other than "status", "headers", "body", "delayMs" and "template"',
      ],
      [
        '{"queue":{"steps":[{"status":503}],"expiresAfterIdleSeconds":3600}}',
        'queue may contain no key other than "steps"',
      ],
      [
        '{"queue":{"steps":[{"status":503,"expiresAfterIdleSeconds":3600}]}}',
        'queue.steps[0] may contain no key other than "status", "headers", "body", "delayMs" and "template"',
      ],
      ['{"session":{"expiresAfterIdleSeconds":3600}}', UNKNOWN_CREATE_KEY_RULE],
    ] as const) {
      assert.equal(refused(() => parseCreateSessionBody(body)).message, message, body);
    }
  });

  it('refuses a __proto__ key as an unknown key, and is not misled by one', () => {
    for (const body of [
      '{"__proto__":{"expiresAfterIdleSeconds":3600}}',
      '{"__proto__":3600}',
      '{"expiresAfterIdleSeconds":3600,"__proto__":{"expiresAfterIdleSeconds":5}}',
      '{"expiresAfterIdleSeconds":3600,"__proto__":{"expiresInSeconds":600}}',
      '{"constructor":{"expiresAfterIdleSeconds":3600}}',
    ]) {
      assert.equal(
        refused(() => parseCreateSessionBody(body)).message,
        UNKNOWN_CREATE_KEY_RULE,
        body,
      );
    }

    // Read off the object itself, never off its prototype.
    const inherited = Object.create({ expiresAfterIdleSeconds: 5, expiresInSeconds: 5 }) as Record<
      string,
      unknown
    >;

    assert.deepEqual(parseSessionExpiry(inherited), {
      expiresInSeconds: null,
      expiresAfterIdleSeconds: null,
    });
  });

  it('takes the last of duplicate keys, as JSON.parse does', () => {
    assert.equal(
      parseCreateSessionBody('{"expiresAfterIdleSeconds":5,"expiresAfterIdleSeconds":3600}')
        .expiresAfterIdleSeconds,
      3600,
    );
    assert.equal(
      refused(() =>
        parseCreateSessionBody('{"expiresAfterIdleSeconds":3600,"expiresAfterIdleSeconds":5}'),
      ).message,
      IDLE_WINDOW_RULE,
    );
  });

  it('leaves a body that is no JSON object to 1006, before any rule', () => {
    for (const body of [
      '',
      '3600',
      '"expiresAfterIdleSeconds"',
      '[{"expiresAfterIdleSeconds":3600}]',
      'null',
      '{"expiresAfterIdleSeconds":3600',
    ]) {
      refused(() => parseCreateSessionBody(body), 1006);
    }
  });
});

/**
 * Made-up creation bodies, each about `size` bytes, and how each must be
 * answered: the window it reads, `1005`, or `either` - `1005` or `1006` -
 * where the parser may give up on the depth first.
 */
const HOSTILE: readonly [string, (size: number) => string, number | 1005 | 'either'][] = [
  [
    'a number of that many digits',
    (size) => `{"expiresAfterIdleSeconds":${filled('9', size)}}`,
    1005,
  ],
  [
    'a number of that many digits after a 1',
    (size) => `{"expiresAfterIdleSeconds":1${filled('0', size)}}`,
    1005,
  ],
  [
    'an integer padded with that many zeros of fraction',
    (size) => `{"expiresAfterIdleSeconds":3600.${filled('0', size)}}`,
    3600,
  ],
  [
    'a fraction past a double’s precision',
    (size) => `{"expiresAfterIdleSeconds":3600.${filled('0', size)}1}`,
    3600,
  ],
  [
    'a fraction just below the minimum',
    (size) => `{"expiresAfterIdleSeconds":3599.${filled('9', size)}}`,
    // Past a double's precision 3599.99… is the double 3600: judged as read.
    3600,
  ],
  [
    'an exponent of that many digits',
    (size) => `{"expiresAfterIdleSeconds":36e${filled('0', size)}2}`,
    3600,
  ],
  ['a huge exponent', (size) => `{"expiresAfterIdleSeconds":1e${filled('9', size)}}`, 1005],
  ['a tiny exponent', (size) => `{"expiresAfterIdleSeconds":36e-${filled('9', size)}}`, 1005],
  ['a negative zero', (size) => `{"expiresAfterIdleSeconds":-0.${filled('0', size)}}`, 1005],
  ['a string of digits', (size) => `{"expiresAfterIdleSeconds":"${filled('6', size)}"}`, 1005],
  [
    'a string of escapes',
    (size) => `{"expiresAfterIdleSeconds":"${whole('\\u0036', size)}"}`,
    1005,
  ],
  [
    'nested arrays',
    (size) => `{"expiresAfterIdleSeconds":${filled('[', size / 2)}${filled(']', size / 2)}}`,
    'either',
  ],
  [
    'nested objects',
    (size) => {
      const depth = Math.floor(size / 6);

      return `{"expiresAfterIdleSeconds":${'{"a":'.repeat(depth)}3600${'}'.repeat(depth)}}`;
    },
    'either',
  ],
  [
    'an array of numbers',
    (size) => `{"expiresAfterIdleSeconds":[${whole('3600,', size)}3600]}`,
    1005,
  ],
  [
    'white space around the value',
    (size) => `{"expiresAfterIdleSeconds":${filled(' ', size / 2)}3600${filled('\n', size / 2)}}`,
    3600,
  ],
  [
    'duplicate keys, the last valid',
    (size) => `{${whole('"expiresAfterIdleSeconds":1,', size)}"expiresAfterIdleSeconds":3600}`,
    3600,
  ],
  [
    'duplicate keys, the last refused',
    (size) => `{${whole('"expiresAfterIdleSeconds":3600,', size)}"expiresAfterIdleSeconds":1}`,
    1005,
  ],
  [
    'both expiry keys, each repeated',
    (size) =>
      `{${whole('"expiresAfterIdleSeconds":3600,"expiresInSeconds":600,', size)}"expiresAfterIdleSeconds":3600}`,
    1005,
  ],
  [
    'unknown keys after a valid window',
    (size) => {
      const keys = Array.from(
        { length: Math.floor(size / 12) },
        (_unused, index) => `"k${index}":1`,
      );

      return `{"expiresAfterIdleSeconds":3600,${keys.join(',')}}`;
    },
    1005,
  ],
  [
    'a key name of that many characters beside a valid window',
    (size) => `{"expiresAfterIdleSeconds":3600,"${filled('expiresAfterIdleSeconds', size)}":1}`,
    1005,
  ],
];

describe('a creation with an idle window, against made-up input up to 1 MiB (D242)', () => {
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
          assert.equal(answer.expiresAfterIdleSeconds, expected, label);
          assert.equal(answer.expiresInSeconds, null, label);
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
