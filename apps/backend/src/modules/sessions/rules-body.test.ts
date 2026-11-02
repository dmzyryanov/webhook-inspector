/**
 * The bodies of the response rules and of a creation with them (D246), without
 * a server: the parsers against made-up input built to break them, at 1 KiB,
 * 64 KiB and 1 MiB - the body limit of both routes, as of every JSON route -
 * every refusal named by its field and quoting nothing the rule held, the
 * order of the checks, and rules at the limits read whole within that limit.
 */
import assert from 'node:assert/strict';
import { METHODS } from 'node:http';
import { describe, it } from 'node:test';
import {
  MAX_BODY_BYTES,
  MAX_RESPONSE_RULES,
  MAX_RULE_PATH_BYTES,
  RESPONSE_RULE_METHODS,
} from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import {
  FULL_RULES_IN_A_BODY,
  largestRulesBody,
  ordinaryFullRules,
  ordinaryRules,
} from '../../testing/full-rules.ts';
import { ordinaryFullQueue, ordinaryFullResponse } from '../../testing/full-queue.ts';
import { INVALID_RESPONSES } from '../../testing/invalid-responses.ts';
import { assertFieldLeadsMessage } from '../../testing/refusal-field.ts';
import { withinBound } from '../../testing/timing.ts';
import {
  parseCreateSessionBody,
  parseRules,
  parseRulesBody,
  UNKNOWN_CREATE_KEY_RULE,
} from './response-config.ts';

const SIZES = [1024, 64 * 1024, MAX_BODY_BYTES];

/** Generous for a body the size of the limit; a regression to quadratic time is seconds. */
const BOUND_MS = 500;

/** Longer than any message: a refusal that quotes what it refused grows past it. */
const SHORT_MESSAGE = 240;

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

/**
 * A `1005` refusal of `parse`, its message returned, which begins with its
 * `field` unless it refuses a key of the body itself (D257).
 */
function refused(parse: () => unknown): string {
  return refusedWithField(parse).message;
}

/** A `1005` refusal of `parse`: its message and its `field`. */
function refusedWithField(parse: () => unknown): { message: string; field: string | undefined } {
  const error = refusal(parse);

  assert.equal(error.statusCode, 400, error.message);
  assert.equal(error.errorCode, 1005, error.message);
  assert.ok(error.message.length <= SHORT_MESSAGE, error.message);
  assertFieldLeadsMessage(error, error.message);

  return { message: error.message, field: error.field };
}

/**
 * What a parser answers: what it read, or its refusal, `1005` or `1006`.
 * Anything else it throws - a `TypeError`, a `RangeError` - fails the test,
 * since the route would answer it `500`.
 */
function outcome(parse: () => unknown): unknown {
  try {
    return parse();
  } catch (error) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);
    assert.equal(error.statusCode, 400, error.message);
    assert.ok([1005, 1006].includes(error.errorCode), error.message);
    assert.ok(error.message.length <= SHORT_MESSAGE, error.message);
    assert.ok((error.field?.length ?? 0) <= SHORT_MESSAGE, error.field);

    if (error.errorCode === 1005) {
      assertFieldLeadsMessage(error, error.message);
    } else {
      assert.equal(error.field, undefined, error.message);
    }

    return error;
  }
}

/** A rules body of `rules`. */
function body(rules: unknown): string {
  return JSON.stringify({ rules });
}

/** One rule of `method` and `path` answered `200`. */
function rule(method: unknown, path: unknown): Record<string, unknown> {
  return { method, path, response: { status: 200 } };
}

/**
 * Made-up `{"rules":…}` bodies. Each is answered `1005` or `1006` and none
 * echoes its marker; a pattern of LIKE and regular-expression syntax at the
 * bound is read as the text it is.
 */
const HOSTILE: readonly [string, (size: number) => string][] = [
  ['rules of 1', (size) => `{"rules":[${whole('1,', size - 12)}1]}`],
  ['rules of empty objects', (size) => `{"rules":[${whole('{},', size - 13)}{}]}`],
  ['50,000 rules', () => body(Array.from({ length: 50_000 }, () => rule(null, '/')))],
  [
    'nested arrays as a rule',
    (size) => `{"rules":[${filled('[', size / 2)}${filled(']', size / 2)}]}`,
  ],
  [
    'nested objects as the rules',
    (size) => {
      const depth = Math.floor(size / 6);

      return `{"rules":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}}`;
    },
  ],
  ['unclosed rules', (size) => `{"rules":[{"method":null,"path":"/${filled('a', size)}`],
  ['duplicate keys', (size) => `{${whole('"rules":[],', size - 8)}"a":1}`],
  ['a pattern of stars', (size) => body([rule(null, `/${filled('*', size)}`)])],
  ['a pattern of slashes', (size) => body([rule(null, filled('/', size + 1))])],
  ['a pattern of percent signs', (size) => body([rule(null, `/${filled('%', size)}`)])],
  ['a pattern of underscores', (size) => body([rule(null, `/${filled('_', size)}`)])],
  [
    'a pattern of regular-expression syntax',
    (size) => body([rule(null, `/${filled('.*+?^$()[]{}|\\', size)}`)]),
  ],
  ['a pattern of NUL', (size) => body([rule(null, `/${filled('\u0000', size)}`)])],
  [
    'a pattern of escaped quotes',
    (size) => `{"rules":[{"method":null,"path":"/${whole('\\"', size)}"}]}`,
  ],
  [
    'a pattern of lone surrogates',
    (size) => `{"rules":[{"method":null,"path":"/${whole('\\ud800', size)}"}]}`,
  ],
  ['a method as long as the body', (size) => body([rule(filled('P', size), '/')])],
  [
    'unknown keys in one rule',
    (size) => {
      const keys = Array.from(
        { length: Math.floor(size / 12) },
        (_unused, index) => `"k${index}":1`,
      );

      return `{"rules":[{"method":null,"path":"/","response":{"status":200},${keys.join(',')}}]}`;
    },
  ],
  [
    'header pairs in one rule',
    (size) =>
      `{"rules":[{"method":null,"path":"/","response":{"status":200,"headers":[${whole('["a","b"],', size - 80)}["a","b"]]}}]}`,
  ],
];

describe('made-up rules bodies (D246)', () => {
  for (const [name, make] of HOSTILE) {
    for (const size of SIZES) {
      it(`answers ${name} at ${size} bytes with a refusal, quickly, quoting nothing`, () => {
        const text = make(size);

        for (const parse of [() => parseRulesBody(text), () => parseCreateSessionBody(text)]) {
          const answer = withinBound(BOUND_MS, () => outcome(parse));

          assert.ok(answer instanceof AppError, `${name} was read`);
          assert.ok(!answer.message.includes('PPPP'), answer.message);
          assert.ok(!answer.message.includes('%%%%'), answer.message);
          assert.ok(!answer.message.includes('____'), answer.message);
        }
      });
    }
  }

  it('reads LIKE and regular-expression syntax at the bound as a pattern of its own text', () => {
    for (const unit of ['%', '_', '.+', '[a]', '^$', '(a|b)', '\\', '%_\\', '\\d{2}']) {
      const path = `/${filled(unit, MAX_RULE_PATH_BYTES - 1)}`;

      assert.deepEqual(parseRulesBody(body([rule(null, path)])), [
        {
          method: null,
          path,
          response: { status: 200, headers: [], body: null, delayMs: 0, template: false },
        },
      ]);
    }
  });

  it('answers malformed text 1006 on both routes', () => {
    for (const text of ['', ' ', 'null', '[]', '"rules"', '{', '{"rules":[}', '1']) {
      for (const parse of [() => parseRulesBody(text), () => parseCreateSessionBody(text)]) {
        const error = refusal(parse);

        assert.equal(error.errorCode, 1006, `${JSON.stringify(text)}: ${error.message}`);
      }
    }

    assert.equal(refusal(() => parseRulesBody(undefined)).errorCode, 1006);
  });
});

describe('the rules of a body (D246, criterion 6)', () => {
  it('takes up to twenty rules in their order, every field at its effective value', () => {
    const rules = Array.from({ length: MAX_RESPONSE_RULES }, (_unused, index) =>
      rule(index % 2 === 0 ? null : 'POST', `/r/${index}`),
    );

    assert.deepEqual(
      parseRulesBody(body(rules)),
      rules.map((sent) => ({
        method: sent.method,
        path: sent.path,
        response: { status: 200, headers: [], body: null, delayMs: 0, template: false },
      })),
    );
    assert.deepEqual(parseRulesBody(body([])), []);
  });

  it('refuses more than twenty for their number, whatever they hold', () => {
    for (const count of [MAX_RESPONSE_RULES + 1, 50_000]) {
      const message = refused(() =>
        parseRulesBody(body(Array.from({ length: count }, () => 'not a rule'))),
      );

      assert.equal(message, 'rules must contain at most 20 rules');
    }
  });

  it('refuses rules that are no array', () => {
    for (const value of [null, {}, 'rules', 3, true]) {
      assert.equal(
        refused(() => parseRulesBody(body(value))),
        'rules is required and must be an array of at most 20 rules',
      );
    }

    assert.equal(
      refused(() => parseRulesBody('{}')),
      'rules is required and must be an array of at most 20 rules',
    );
  });

  it('refuses a rule that is no object, by its place', () => {
    for (const value of [null, 1, 'rule', [], [1, 2]]) {
      assert.equal(
        refused(() => parseRulesBody(body([rule(null, '/'), value]))),
        'rules[1] must be an object with "method", "path" and "response"',
      );
    }
  });

  it('takes every method the receiver captures, and null for any', () => {
    // The receiver's own set (D139): Node's methods but CONNECT, which no
    // route ever sees; `webhook.test.ts` pins the receiver to the same list.
    assert.deepEqual(
      [...RESPONSE_RULE_METHODS],
      METHODS.filter((method) => method !== 'CONNECT').sort(),
    );

    for (const method of [...RESPONSE_RULE_METHODS, null]) {
      assert.equal(parseRulesBody(body([rule(method, '/')]))[0]?.method, method);
    }
  });

  it('refuses a method in lower case, unknown, CONNECT, absent or no string, quoting none', () => {
    const methods: unknown[] = [
      'post',
      'Post',
      'CONNECT',
      'FOO',
      ' POST',
      'POST ',
      '',
      'GET\r\n',
      'P'.repeat(10_000),
      1,
      true,
      [],
      {},
    ];

    for (const method of methods) {
      const message = refused(() => parseRulesBody(body([rule(method, '/')])));

      assert.equal(
        message,
        'rules[0].method is required: null for any method, or a method the receiver captures, in upper case, CONNECT excepted',
      );
    }

    const absent = { path: '/', response: { status: 200 } };

    assert.match(
      refused(() => parseRulesBody(body([absent]))),
      /^rules\[0\]\.method is required/,
    );
  });

  it('takes a path that is exact or ends in a star, as typed', () => {
    for (const path of [
      '/',
      '/*',
      '/orders',
      '/orders/',
      '/items/*',
      '//orders',
      '/a/../orders',
      '/orders%3Fx',
      '/orders;v=1',
      '/%6Frders',
      '/caf%C3%A9',
      '/#frag',
      '/!$&\'()+,;=:@-._~[]{}|^`\\"<>',
      `/${'a'.repeat(MAX_RULE_PATH_BYTES - 1)}`,
      `/${'b'.repeat(MAX_RULE_PATH_BYTES - 2)}*`,
    ]) {
      assert.equal(parseRulesBody(body([rule('GET', path)]))[0]?.path, path);
    }
  });

  it('refuses a path not starting with /, holding * but last, ?, anything but visible ASCII, or over the bound', () => {
    const cases: [unknown, string][] = [
      ['', 'rules[0].path is required and must be a string starting with /'],
      ['orders', 'rules[0].path is required and must be a string starting with /'],
      ['*', 'rules[0].path is required and must be a string starting with /'],
      ['http://x/orders', 'rules[0].path is required and must be a string starting with /'],
      [null, 'rules[0].path is required and must be a string starting with /'],
      [7, 'rules[0].path is required and must be a string starting with /'],
      [['/'], 'rules[0].path is required and must be a string starting with /'],
      [
        '/a*b',
        'rules[0].path may contain * only as its last character, where it matches any rest of the path',
      ],
      [
        '/**',
        'rules[0].path may contain * only as its last character, where it matches any rest of the path',
      ],
      [
        '/*/x',
        'rules[0].path may contain * only as its last character, where it matches any rest of the path',
      ],
      ['/orders?x=1', 'rules[0].path must contain no ?: the query of a request is never matched'],
      ['/?', 'rules[0].path must contain no ?: the query of a request is never matched'],
      [
        '/a b',
        'rules[0].path must contain only visible ASCII: write a space or any other character percent-encoded, as a request sends it',
      ],
      [
        '/a\tb',
        'rules[0].path must contain only visible ASCII: write a space or any other character percent-encoded, as a request sends it',
      ],
      [
        '/a\r\nb',
        'rules[0].path must contain only visible ASCII: write a space or any other character percent-encoded, as a request sends it',
      ],
      [
        '/a\u0000',
        'rules[0].path must contain only visible ASCII: write a space or any other character percent-encoded, as a request sends it',
      ],
      [
        '/a\u007f',
        'rules[0].path must contain only visible ASCII: write a space or any other character percent-encoded, as a request sends it',
      ],
      [
        '/café',
        'rules[0].path must contain only visible ASCII: write a space or any other character percent-encoded, as a request sends it',
      ],
      [
        '/я',
        'rules[0].path must contain only visible ASCII: write a space or any other character percent-encoded, as a request sends it',
      ],
      [
        '/😀',
        'rules[0].path must contain only visible ASCII: write a space or any other character percent-encoded, as a request sends it',
      ],
      [
        '/\ud800',
        'rules[0].path must contain only visible ASCII: write a space or any other character percent-encoded, as a request sends it',
      ],
      [
        '/a\u00a0b',
        'rules[0].path must contain only visible ASCII: write a space or any other character percent-encoded, as a request sends it',
      ],
      [`/${'a'.repeat(MAX_RULE_PATH_BYTES)}`, 'rules[0].path must be at most 1024 characters'],
      [`/${'я'.repeat(MAX_RULE_PATH_BYTES)}`, 'rules[0].path must be at most 1024 characters'],
    ];

    for (const [path, message] of cases) {
      assert.equal(
        refused(() => parseRulesBody(body([rule('GET', path)]))),
        message,
        String(path),
      );
    }
  });

  it('refuses an invalid response by the response rules, under the rule’s place', () => {
    for (const [name, response, place] of INVALID_RESPONSES) {
      const { message, field } = refusedWithField(() =>
        parseRulesBody(body([rule(null, '/'), { method: null, path: '/x', response }])),
      );

      assert.ok(message.startsWith('rules[1].response'), `${name}: ${message}`);
      assert.equal(field, `rules[1].response${place}`, name);
    }

    assert.equal(
      refused(() => parseRulesBody(body([{ method: null, path: '/' }]))),
      'rules[0].response must be an object',
    );
    assert.equal(
      refused(() => parseRulesBody(body([{ method: null, path: '/', response: null }]))),
      'rules[0].response must be an object',
    );
  });

  it('checks a rule’s fields in their order, then its unknown keys', () => {
    assert.match(
      refused(() => parseRulesBody(body([{ method: 'x', path: 'x', response: null, extra: 1 }]))),
      /^rules\[0\]\.method/,
    );
    assert.match(
      refused(() => parseRulesBody(body([{ method: null, path: 'x', response: null, extra: 1 }]))),
      /^rules\[0\]\.path/,
    );
    assert.match(
      refused(() => parseRulesBody(body([{ method: null, path: '/', response: null, extra: 1 }]))),
      /^rules\[0\]\.response/,
    );
    assert.equal(
      refused(() =>
        parseRulesBody(body([{ method: null, path: '/', response: { status: 200 }, extra: 1 }])),
      ),
      'rules[0] may contain no key other than "method", "path" and "response"',
    );
    assert.equal(
      refused(() =>
        parseRulesBody(
          '{"rules":[{"method":null,"path":"/","response":{"status":200},"__proto__":1}]}',
        ),
      ),
      'rules[0] may contain no key other than "method", "path" and "response"',
    );
  });

  it('names the first broken rule, after the count', () => {
    const rules = [rule(null, '/a'), rule(null, '/b'), rule('get', '/c'), rule(null, 'd')];

    assert.match(
      refused(() => parseRulesBody(body(rules))),
      /^rules\[2\]\.method/,
    );
  });

  it('refuses any key beside rules, once the rules hold', () => {
    assert.equal(
      refused(() => parseRulesBody('{"rules":[],"steps":[]}')),
      'The request body may contain no key other than "rules"',
    );
    assert.match(
      refused(() => parseRulesBody('{"rules":7,"steps":[]}')),
      /^rules is required/,
    );
  });

  it('refuses a lone surrogate in a path, escaped in the JSON, as no visible ASCII', () => {
    assert.match(
      refused(() =>
        parseRulesBody('{"rules":[{"method":null,"path":"/\\ud800","response":{"status":200}}]}'),
      ),
      /^rules\[0\]\.path must contain only visible ASCII/,
    );
  });
});

describe('the field of a refused rule (D257, criterion 1)', () => {
  /** The `field` of the refusal of `parse`. */
  function fieldOf(parse: () => unknown): string | undefined {
    return refusedWithField(parse).field;
  }

  it('names the rule’s method, its path and each check of its response by their place', () => {
    const first = rule(null, '/');

    assert.equal(
      fieldOf(() => parseRulesBody(body([first, rule('get', '/')]))),
      'rules[1].method',
    );
    assert.equal(
      fieldOf(() => parseRulesBody(body([first, { path: '/', response: { status: 200 } }]))),
      'rules[1].method',
    );

    for (const path of [
      '',
      'x',
      null,
      '/a b',
      '/?',
      '/a*b',
      `/${'a'.repeat(MAX_RULE_PATH_BYTES)}`,
    ]) {
      assert.equal(
        fieldOf(() => parseRulesBody(body([first, rule('GET', path)]))),
        'rules[1].path',
      );
    }

    assert.equal(
      fieldOf(() => parseRulesBody(body([first, { method: null, path: '/' }]))),
      'rules[1].response',
    );
    assert.equal(
      fieldOf(() => parseRulesBody(body([first, 7]))),
      'rules[1]',
    );
  });

  it('names the list for its count or its type, whatever the rules hold', () => {
    assert.equal(
      fieldOf(() => parseRulesBody(body(Array.from({ length: MAX_RESPONSE_RULES + 1 }, () => 1)))),
      'rules',
    );
    assert.equal(
      fieldOf(() => parseRulesBody(body('rules'))),
      'rules',
    );
    assert.equal(
      fieldOf(() => parseRulesBody('{}')),
      'rules',
    );
  });

  it('names a 1 MiB body of 50,000 rules by the list, quickly', () => {
    // Twenty bytes a rule: all but 5 % of the body limit.
    const text = body(Array.from({ length: 50_000 }, () => ({ path: '/abcdefg' })));

    assert.ok(
      text.length <= MAX_BODY_BYTES && text.length > 0.95 * MAX_BODY_BYTES,
      `${text.length}`,
    );
    withinBound(BOUND_MS, () => {
      assert.equal(
        fieldOf(() => parseRulesBody(text)),
        'rules',
      );
    });
  });

  it('names a rule holding an unknown key by the rule, never by the key', () => {
    const keys = ['k'.repeat(10_000), 'a\nb', 'a"b', '__proto__', 'rules[0].path', 'response'];

    for (const key of keys) {
      const text = `{"rules":[{"method":null,"path":"/","response":{"status":200}},{"method":null,"path":"/","response":{"status":200},${JSON.stringify(key)}:1}]}`;
      const { message, field } = refusedWithField(() => parseRulesBody(text));

      if (key === 'response') {
        // A duplicate key of JSON: the last one is read, and it is no response.
        assert.equal(field, 'rules[1].response', key);
        continue;
      }

      assert.equal(field, 'rules[1]', key.slice(0, 20));
      assert.ok(!message.includes(key), key.slice(0, 20));
    }
  });

  it('gives a key of the body itself no field, never the key', () => {
    for (const key of ['k'.repeat(10_000), 'a\nb', 'a"b', 'rules[0].path', 'steps']) {
      const text = `{"rules":[],${JSON.stringify(key)}:1}`;
      const { message, field } = refusedWithField(() => parseRulesBody(text));

      assert.equal(field, undefined, key.slice(0, 20));
      assert.equal(message, 'The request body may contain no key other than "rules"');
    }

    const created = refusedWithField(() =>
      parseCreateSessionBody(`{"rules":[],${JSON.stringify('k'.repeat(10_000))}:1}`),
    );

    assert.equal(created.field, undefined);
    assert.equal(created.message, UNKNOWN_CREATE_KEY_RULE);
  });

  it('names the same place for the same body every time, the first broken in the order of the checks', () => {
    const text = body([rule(null, '/'), rule(null, 'x'), rule('get', '/'), 'no rule']);

    for (let run = 0; run < 3; run += 1) {
      assert.equal(
        fieldOf(() => parseRulesBody(text)),
        'rules[1].path',
      );
    }

    assert.equal(
      fieldOf(() =>
        parseRulesBody(body([{ method: 'x', path: 'x', response: { status: 1 }, other: 1 }])),
      ),
      'rules[0].method',
    );
  });

  it('names a creation’s rules by the same places', () => {
    assert.equal(
      fieldOf(() => parseCreateSessionBody('{"rules":null}')),
      'rules',
    );
    assert.equal(
      fieldOf(() =>
        parseCreateSessionBody(JSON.stringify({ rules: [rule(null, '/'), rule(null, '/x?')] })),
      ),
      'rules[1].path',
    );

    for (const [name, response, place] of INVALID_RESPONSES) {
      assert.equal(
        fieldOf(() =>
          parseCreateSessionBody(
            JSON.stringify({ rules: [rule(null, '/'), { method: null, path: '/', response }] }),
          ),
        ),
        `rules[1].response${place}`,
        name,
      );
    }
  });
});

describe('rules at the limits, within 1 MiB (D246, the owner’s decision 3)', () => {
  it('reads fourteen rules at every limit of D101 in ordinary text, and refuses a fifteenth as too large', () => {
    const fourteen = body(ordinaryFullRules(FULL_RULES_IN_A_BODY));
    const fifteen = body(ordinaryFullRules(FULL_RULES_IN_A_BODY + 1));

    assert.ok(Buffer.byteLength(fourteen) <= MAX_BODY_BYTES, `${Buffer.byteLength(fourteen)}`);
    assert.ok(Buffer.byteLength(fifteen) > MAX_BODY_BYTES, `${Buffer.byteLength(fifteen)}`);
    assert.deepEqual(parseRulesBody(fourteen), ordinaryFullRules(FULL_RULES_IN_A_BODY));
  });

  it('reads twenty rules of ordinary responses', () => {
    const text = body(ordinaryRules());

    assert.ok(Buffer.byteLength(text) < 64 * 1024);
    assert.deepEqual(parseRulesBody(text), ordinaryRules());
  });

  it('reads rules as large as 1 MiB admits, written with text JSON escapes', () => {
    const text = largestRulesBody();

    assert.ok(Buffer.byteLength(text) <= MAX_BODY_BYTES);
    assert.ok(Buffer.byteLength(text) > MAX_BODY_BYTES - 1024);
    assert.equal(withinBound(BOUND_MS, () => parseRulesBody(text)).length, MAX_RESPONSE_RULES);
  });

  it('reads a creation with a full response, a full queue and three full rules, which is about all 1 MiB holds', () => {
    const creation = (count: number) =>
      JSON.stringify({
        response: ordinaryFullResponse(),
        queue: { steps: ordinaryFullQueue() },
        rules: ordinaryFullRules(count),
      });

    assert.ok(Buffer.byteLength(creation(3)) <= MAX_BODY_BYTES);
    assert.ok(Buffer.byteLength(creation(4)) > MAX_BODY_BYTES);
    assert.deepEqual(parseCreateSessionBody(creation(3)).rules, ordinaryFullRules(3));
  });
});

describe('rules at creation (D246, criterion 2)', () => {
  it('takes rules, and none when the key is absent or empty', () => {
    const rules = [rule('POST', '/orders'), rule(null, '/items/*')];

    assert.deepEqual(parseCreateSessionBody(JSON.stringify({ rules })).rules, parseRules(rules));
    assert.deepEqual(parseCreateSessionBody(JSON.stringify({ rules: [] })).rules, []);
    assert.deepEqual(parseCreateSessionBody('{}').rules, []);
    assert.deepEqual(parseCreateSessionBody(undefined).rules, []);
  });

  it('refuses rules: null with what to do instead', () => {
    assert.equal(
      refused(() => parseCreateSessionBody('{"rules":null}')),
      'rules must be an array; omit the key entirely to create a session without rules',
    );
  });

  it('checks rules after every key before them, and before unknown keys', () => {
    const badRules = [rule('get', '/')];

    // Each earlier key's refusal comes first.
    assert.match(
      refused(() => parseCreateSessionBody(JSON.stringify({ response: null, rules: badRules }))),
      /^response must be an object/,
    );
    assert.match(
      refused(() =>
        parseCreateSessionBody(JSON.stringify({ queue: { steps: [] }, rules: badRules })),
      ),
      /^queue\.steps/,
    );
    assert.match(
      refused(() =>
        parseCreateSessionBody(JSON.stringify({ expiresInSeconds: 1, rules: badRules })),
      ),
      /^expiresInSeconds/,
    );
    assert.match(
      refused(() =>
        parseCreateSessionBody(JSON.stringify({ expiresAfterIdleSeconds: 1, rules: badRules })),
      ),
      /^expiresAfterIdleSeconds/,
    );
    assert.match(
      refused(() => parseCreateSessionBody(JSON.stringify({ storeSourceIp: 1, rules: badRules }))),
      /^storeSourceIp/,
    );
    // Then the rules, before an unknown key.
    assert.match(
      refused(() => parseCreateSessionBody(JSON.stringify({ rules: badRules, extra: 1 }))),
      /^rules\[0\]\.method/,
    );
    assert.equal(
      refused(() => parseCreateSessionBody(JSON.stringify({ rules: [], extra: 1 }))),
      UNKNOWN_CREATE_KEY_RULE,
    );
    assert.equal(
      UNKNOWN_CREATE_KEY_RULE,
      'The request body may contain no key other than "response", "queue", "expiresInSeconds", "expiresAfterIdleSeconds", "storeSourceIp", "rules" and "private"',
    );
  });
});
