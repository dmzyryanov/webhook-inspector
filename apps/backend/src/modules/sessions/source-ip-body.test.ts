/**
 * Whether a creation's session keeps the sender's address, `storeSourceIp`
 * (D243), without a server: what `parseStoreSourceIp` takes and refuses - the
 * JSON booleans alone - where its refusal stands among the create body's
 * checks, that no message echoes the value (D106), and made-up bodies built to
 * break it at 1 KiB, 64 KiB and 1 MiB - the body limit of the route - each
 * answered within a bound.
 *
 * Modelled on `lifetime-body.test.ts` (D220) and `idle-window-body.test.ts`
 * (D242), which hold the same for the two expiry keys.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_BODY_BYTES } from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import { withinBound } from '../../testing/timing.ts';
import {
  IDLE_WINDOW_RULE,
  LIFETIME_RULE,
  ONE_EXPIRY_RULE,
  parseCreateSessionBody,
  parseStoreSourceIp,
  STORE_SOURCE_IP_RULE,
  UNKNOWN_CREATE_KEY_RULE,
  type CreateSessionRequest,
} from './response-config.ts';

const SIZES = [1024, 64 * 1024, MAX_BODY_BYTES];

/** Generous for a body the size of the limit; a regression to quadratic time is seconds. */
const BOUND_MS = 500;

const NULL_RULE = `${STORE_SOURCE_IP_RULE}; omit it for a session that stores the sender's IP address`;

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

describe('the rule (D243)', () => {
  it('names the field and the two values it takes', () => {
    assert.equal(STORE_SOURCE_IP_RULE, 'storeSourceIp must be true or false');
    assert.equal(
      NULL_RULE,
      "storeSourceIp must be true or false; omit it for a session that stores the sender's IP address",
    );
  });

  it('names the key in the unknown-key message, after the four before it and before the rules (D246)', () => {
    assert.equal(
      UNKNOWN_CREATE_KEY_RULE,
      'The request body may contain no key other than "response", "queue", "expiresInSeconds", "expiresAfterIdleSeconds", "storeSourceIp", "rules" and "private"',
    );
  });
});

describe('parseStoreSourceIp (D243)', () => {
  it('takes the two JSON booleans as they are', () => {
    assert.equal(parseStoreSourceIp(true), true);
    assert.equal(parseStoreSourceIp(false), false);
    assert.equal(parseStoreSourceIp(JSON.parse('false')), false);
    assert.equal(parseStoreSourceIp(JSON.parse('true')), true);
  });

  it('refuses everything else with the rule alone, and null with what to do instead', () => {
    for (const value of [
      'false',
      'true',
      'FALSE',
      'False',
      'no',
      'off',
      '0',
      '',
      ' ',
      0,
      1,
      -0,
      0.0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      [],
      [false],
      [true],
      {},
      { value: false },
      { valueOf: () => false },
      undefined,
      BigInt(0),
      Symbol('false'),
      () => false,
      new Boolean(false),
      Object.create(null) as unknown,
    ]) {
      const error = refused(() => parseStoreSourceIp(value));

      assert.equal(error.message, STORE_SOURCE_IP_RULE, typeof value);
    }

    assert.equal(refused(() => parseStoreSourceIp(null)).message, NULL_RULE);
  });

  it('never echoes a refused value (D106)', () => {
    for (const text of [
      '"secret-token"',
      '"203.0.113.7"',
      '"falsehood"',
      '123456789',
      '-31',
      '1e400',
      '[0]',
      '{"x":"leak"}',
    ]) {
      const error = refused(() => parseCreateSessionBody(`{"storeSourceIp":${text}}`));

      assert.equal(error.message, STORE_SOURCE_IP_RULE, text);

      for (const piece of text.match(/[A-Za-z0-9.-]{2,}/g) ?? []) {
        // The rule's own words are the only ones it may hold.
        if (!STORE_SOURCE_IP_RULE.includes(piece)) {
          assert.equal(error.message.includes(piece), false, `${error.message} echoes ${piece}`);
        }
      }
    }
  });
});

describe('a creation with the address choice (D243)', () => {
  it('reads false alone as a default session that keeps no address, and beside every other key', () => {
    assert.deepEqual(parseCreateSessionBody('{"storeSourceIp":false}'), {
      response: null,
      queue: null,
      expiresInSeconds: null,
      expiresAfterIdleSeconds: null,
      storeSourceIp: false,
      rules: [],
      private: false,
    });

    const all = parseCreateSessionBody(
      '{"response":{"status":201},"queue":{"steps":[{"status":503}]},"expiresAfterIdleSeconds":3600,"storeSourceIp":false}',
    );

    assert.equal(all.storeSourceIp, false);
    assert.equal(all.expiresAfterIdleSeconds, 3600);
    assert.equal(all.response?.status, 201);
    assert.equal(all.queue?.[0]?.status, 503);

    const first = parseCreateSessionBody('{"storeSourceIp":false,"expiresInSeconds":600}');

    assert.equal(first.storeSourceIp, false);
    assert.equal(first.expiresInSeconds, 600);
  });

  it('reads true, no body, {} and the bodies of before as a session that keeps the address', () => {
    for (const body of [
      undefined,
      '{}',
      '{"storeSourceIp":true}',
      '{"response":{"status":200}}',
      '{"queue":{"steps":[{"status":503}]}}',
      '{"expiresInSeconds":600}',
      '{"expiresAfterIdleSeconds":3600}',
    ]) {
      assert.equal(parseCreateSessionBody(body).storeSourceIp, true, String(body));
    }
  });

  it('checks the response, the queue, the lifetime, the window, the two together, the choice, then an unknown key', () => {
    for (const [body, message] of [
      [
        '{"storeSourceIp":"false","response":{"status":99}}',
        'response.status is required and must be an integer between 200 and 599',
      ],
      [
        '{"storeSourceIp":"false","queue":{"steps":[]}}',
        'queue.steps must contain 1 to 10 responses',
      ],
      ['{"storeSourceIp":0,"expiresInSeconds":5}', LIFETIME_RULE],
      ['{"storeSourceIp":0,"expiresAfterIdleSeconds":5}', IDLE_WINDOW_RULE],
      [
        '{"storeSourceIp":0,"expiresInSeconds":600,"expiresAfterIdleSeconds":3600}',
        ONE_EXPIRY_RULE,
      ],
      ['{"other":1,"storeSourceIp":0}', STORE_SOURCE_IP_RULE],
      ['{"other":1,"storeSourceIp":null}', NULL_RULE],
      ['{"storeSourceIp":false,"other":1}', UNKNOWN_CREATE_KEY_RULE],
      ['{"store_source_ip":false}', UNKNOWN_CREATE_KEY_RULE],
      ['{"storesourceip":false}', UNKNOWN_CREATE_KEY_RULE],
      ['{"storeSourceIP":false}', UNKNOWN_CREATE_KEY_RULE],
      ['{"StoreSourceIp":false}', UNKNOWN_CREATE_KEY_RULE],
      ['{"storeSourceIp ":false}', UNKNOWN_CREATE_KEY_RULE],
      ['{"storeIp":false}', UNKNOWN_CREATE_KEY_RULE],
      ['{"sourceIp":false}', UNKNOWN_CREATE_KEY_RULE],
    ] as const) {
      assert.equal(refused(() => parseCreateSessionBody(body)).message, message, body);
    }
  });

  it('refuses the key nested anywhere it does not belong, never reading it there', () => {
    for (const [body, message] of [
      [
        '{"response":{"status":200,"storeSourceIp":false}}',
        'response may contain no key other than "status", "headers", "body", "delayMs" and "template"',
      ],
      [
        '{"queue":{"steps":[{"status":503}],"storeSourceIp":false}}',
        'queue may contain no key other than "steps"',
      ],
      [
        '{"queue":{"steps":[{"status":503,"storeSourceIp":false}]}}',
        'queue.steps[0] may contain no key other than "status", "headers", "body", "delayMs" and "template"',
      ],
      ['{"session":{"storeSourceIp":false}}', UNKNOWN_CREATE_KEY_RULE],
      ['{"options":{"storeSourceIp":false}}', UNKNOWN_CREATE_KEY_RULE],
    ] as const) {
      assert.equal(refused(() => parseCreateSessionBody(body)).message, message, body);
    }
  });

  it('refuses a __proto__ or constructor key as an unknown key, and is not misled by one', () => {
    for (const body of [
      '{"__proto__":{"storeSourceIp":false}}',
      '{"__proto__":false}',
      '{"storeSourceIp":true,"__proto__":{"storeSourceIp":false}}',
      '{"constructor":{"storeSourceIp":false}}',
      '{"constructor":{"prototype":{"storeSourceIp":false}}}',
    ]) {
      assert.equal(
        refused(() => parseCreateSessionBody(body)).message,
        UNKNOWN_CREATE_KEY_RULE,
        body,
      );
    }

    // `JSON.parse` makes `__proto__` an own key, so nothing reaches a prototype:
    // a later object reads no choice it never had.
    assert.equal(({} as Record<string, unknown>).storeSourceIp, undefined);
    assert.equal(parseCreateSessionBody('{}').storeSourceIp, true);
  });

  it('takes the last of duplicate keys, as JSON.parse does', () => {
    assert.equal(
      parseCreateSessionBody('{"storeSourceIp":true,"storeSourceIp":false}').storeSourceIp,
      false,
    );
    assert.equal(
      parseCreateSessionBody('{"storeSourceIp":false,"storeSourceIp":true}').storeSourceIp,
      true,
    );
    assert.equal(
      parseCreateSessionBody('{"storeSourceIp":"no","storeSourceIp":false}').storeSourceIp,
      false,
    );
    assert.equal(
      refused(() => parseCreateSessionBody('{"storeSourceIp":false,"storeSourceIp":0}')).message,
      STORE_SOURCE_IP_RULE,
    );
  });

  it('leaves a body that is no JSON object to 1006, before any rule', () => {
    for (const body of [
      '',
      'false',
      '"storeSourceIp"',
      '[{"storeSourceIp":false}]',
      'null',
      '{"storeSourceIp":false',
      '{"storeSourceIp":False}',
      '{"storeSourceIp":fals}',
    ]) {
      refused(() => parseCreateSessionBody(body), 1006);
    }
  });
});

/**
 * Made-up creation bodies, each about `size` bytes, and how each must be
 * answered: the choice it reads, `1005`, `1006`, or `either` - `1005` or
 * `1006` - where the parser may give up on the depth first.
 */
const HOSTILE: readonly [string, (size: number) => string, boolean | 1005 | 1006 | 'either'][] = [
  ['a string of that many characters', (size) => `{"storeSourceIp":"${filled('f', size)}"}`, 1005],
  [
    'a string of escapes spelling false',
    (size) => `{"storeSourceIp":"${whole('\\u0066\\u0061\\u006c\\u0073\\u0065', size)}"}`,
    1005,
  ],
  ['a number of that many digits', (size) => `{"storeSourceIp":1${filled('0', size)}}`, 1005],
  [
    'a number of that many leading zeros, no JSON',
    (size) => `{"storeSourceIp":${filled('0', size)}1}`,
    1006,
  ],
  [
    'a zero with that many zeros of fraction',
    (size) => `{"storeSourceIp":0.${filled('0', size)}}`,
    1005,
  ],
  ['a huge exponent', (size) => `{"storeSourceIp":1e${filled('9', size)}}`, 1005],
  [
    'nested arrays',
    (size) => `{"storeSourceIp":${filled('[', size / 2)}${filled(']', size / 2)}}`,
    'either',
  ],
  [
    'nested arrays around false',
    (size) => `{"storeSourceIp":${filled('[', size / 2)}false${filled(']', size / 2)}}`,
    'either',
  ],
  [
    'nested objects',
    (size) => {
      const depth = Math.floor(size / 6);

      return `{"storeSourceIp":${'{"a":'.repeat(depth)}false${'}'.repeat(depth)}}`;
    },
    'either',
  ],
  ['an array of booleans', (size) => `{"storeSourceIp":[${whole('false,', size)}false]}`, 1005],
  [
    'white space around the value',
    (size) => `{"storeSourceIp":${filled(' ', size / 2)}false${filled('\n', size / 2)}}`,
    false,
  ],
  [
    'white space runs of every kind between the keys',
    (size) =>
      `{${filled(' \t\r\n', size / 2)}"storeSourceIp"${filled('\t', size / 4)}:${filled('\r\n', size / 4)}false}`,
    false,
  ],
  [
    'duplicate keys, the last false',
    (size) => `{${whole('"storeSourceIp":true,', size)}"storeSourceIp":false}`,
    false,
  ],
  [
    'duplicate keys, the last refused',
    (size) => `{${whole('"storeSourceIp":false,', size)}"storeSourceIp":0}`,
    1005,
  ],
  [
    'duplicate keys alternating, the last true',
    (size) => `{${whole('"storeSourceIp":false,"storeSourceIp":"x",', size)}"storeSourceIp":true}`,
    true,
  ],
  [
    'unknown keys after a valid choice',
    (size) => {
      const keys = Array.from(
        { length: Math.floor(size / 12) },
        (_unused, index) => `"k${index}":1`,
      );

      return `{"storeSourceIp":false,${keys.join(',')}}`;
    },
    1005,
  ],
  [
    'a key name of that many characters beside a valid choice',
    (size) => `{"storeSourceIp":false,"${filled('storeSourceIp', size)}":false}`,
    1005,
  ],
  [
    'the key misspelt that many ways',
    (size) => {
      const keys = Array.from(
        { length: Math.floor(size / 30) },
        (_unused, index) => `"storeSourceIp${index}":false`,
      );

      return `{${keys.join(',')}}`;
    },
    1005,
  ],
];

describe('a creation with the address choice, against made-up input up to 1 MiB (D243)', () => {
  for (const [name, build, expected] of HOSTILE) {
    it(`answers ${name} at 1 KiB, 64 KiB and 1 MiB within a bound`, () => {
      for (const size of SIZES) {
        const body = build(size);
        const label = `${name} at ${size}`;

        // What the route would parse: nothing over the limit reaches it.
        assert.ok(Buffer.byteLength(body) <= MAX_BODY_BYTES + 64, label);

        const answer = withinBound(BOUND_MS, () => outcome(body));

        if (typeof expected === 'boolean') {
          assert.ok(!(answer instanceof AppError), `${label}: ${String(answer)}`);
          assert.equal(answer.storeSourceIp, expected, label);
          continue;
        }

        assert.ok(answer instanceof AppError, `${label} was accepted`);

        if (expected === 'either') {
          assert.ok(answer.errorCode === 1005 || answer.errorCode === 1006, label);
        } else {
          assert.equal(answer.errorCode, expected, label);
        }

        // Whatever the body held, a refusal quotes none of it (D106).
        assert.ok(answer.message.length < 200, label);
      }
    });
  }
});
