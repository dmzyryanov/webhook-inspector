/**
 * The rules of the search of raw requests that need no server (D191): what
 * its body must be, hostile bodies up to the body limit included, how many
 * searches run at once, and which count a query of requests takes its place
 * in (D250).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_BODY_BYTES,
  MAX_CONCURRENT_HEADER_QUERIES,
  MAX_CONCURRENT_SEARCHES,
  SEARCH_MAX_WORD_BYTES,
  SEARCH_MAX_WORDS,
  SEARCH_MIN_WORD_BYTES,
} from '@webhook-inspector/shared';
import { AppError, searchBusy } from '../../errors/app-error.ts';
import { parseQueryBody } from './list-query.ts';
import { createQuerySlots, createSearchSlots, parseSearchBody, slotsForQuery } from './search.ts';

const WORDS_RULE = 'words must be an array of 1 to 8 strings';
const WORD_RULE = 'Each word must be 3 to 200 bytes of UTF-8';
const KEYS_RULE = 'The request body may contain no key other than "words"';

function body(words: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ words, ...extra });
}

/** The refusal `parseSearchBody` answers `rawBody` with. */
function refusal(rawBody: string | undefined): AppError {
  try {
    parseSearchBody(rawBody);
  } catch (error) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);

    return error;
  }

  throw new assert.AssertionError({ message: 'the body was accepted' });
}

function assertRefused(rawBody: string | undefined, errorCode: number, message: string): void {
  const error = refusal(rawBody);

  assert.equal(error.statusCode, 400);
  assert.equal(error.errorCode, errorCode);
  assert.equal(error.message, message);
}

describe('the limits the rules are written with', () => {
  it('are the documented ones', () => {
    assert.equal(SEARCH_MIN_WORD_BYTES, 3);
    assert.equal(SEARCH_MAX_WORD_BYTES, 200);
    assert.equal(SEARCH_MAX_WORDS, 8);
    assert.equal(MAX_CONCURRENT_SEARCHES, 2);
  });
});

describe('parseSearchBody: what it accepts', () => {
  it('answers with the UTF-8 bytes of each word, in the order given', () => {
    assert.deepEqual(parseSearchBody(body(['48213', 'POST'])), [
      Buffer.from('48213'),
      Buffer.from('POST'),
    ]);
  });

  it('accepts 1 word and 8 words', () => {
    assert.equal(parseSearchBody(body(['abc'])).length, 1);
    assert.equal(parseSearchBody(body(Array.from({ length: 8 }, (_, n) => `word${n}`))).length, 8);
  });

  it('keeps a repeated word, so the answer has one list per word sent', () => {
    assert.deepEqual(parseSearchBody(body(['abc', 'abc'])), [
      Buffer.from('abc'),
      Buffer.from('abc'),
    ]);
  });

  it('measures a word in bytes of UTF-8, not in characters', () => {
    // Two characters, three bytes.
    assert.deepEqual(parseSearchBody(body(['éa'])), [Buffer.from([0xc3, 0xa9, 0x61])]);
    // One character, four bytes.
    assert.deepEqual(parseSearchBody(body(['😀'])), [Buffer.from([0xf0, 0x9f, 0x98, 0x80])]);
    // 100 characters, exactly 200 bytes.
    assert.equal(parseSearchBody(body(['ж'.repeat(100)]))[0]?.length, 200);
    // 200 characters and 200 bytes.
    assert.equal(parseSearchBody(body(['a'.repeat(200)]))[0]?.length, 200);
  });

  it('does not split, trim or change a word: spaces, a colon, a NUL and a line break stay', () => {
    const word = ' X-Signature: a\u0000\r\nb ';

    assert.deepEqual(parseSearchBody(body([word])), [Buffer.from(word, 'utf8')]);
  });

  it('encodes an unpaired surrogate as U+FFFD, as TextEncoder does', () => {
    const [bytes] = parseSearchBody('{"words":["\\ud800"]}');

    assert.deepEqual(bytes, Buffer.from([0xef, 0xbf, 0xbd]));
    assert.deepEqual(bytes, Buffer.from(new TextEncoder().encode('\ud800')));
  });

  it('takes the last `words` when the key is repeated, as JSON.parse does', () => {
    assert.deepEqual(parseSearchBody('{"words":["first"],"words":["second"]}'), [
      Buffer.from('second'),
    ]);
  });

  it('ignores whitespace around the JSON', () => {
    assert.deepEqual(parseSearchBody(' \n\t{ "words" : [ "abc" ] }\r\n'), [Buffer.from('abc')]);
  });
});

describe('parseSearchBody: 1006 for a body that is not a JSON object', () => {
  const malformed: [string, string | undefined][] = [
    ['no body at all', undefined],
    ['an empty body', ''],
    ['whitespace', '  '],
    ['text that is not JSON', 'words=abc'],
    ['truncated JSON', '{"words":["abc"'],
    ['a JSON array', '["abc"]'],
    ['a JSON string', '"abc"'],
    ['a JSON number', '123'],
    ['null', 'null'],
    ['true', 'true'],
  ];

  for (const [description, rawBody] of malformed) {
    it(`refuses ${description}`, () => {
      assertRefused(rawBody, 1006, 'Request body must be a JSON object');
    });
  }
});

describe('parseSearchBody: 1010 for words that break a rule', () => {
  const invalid: [string, string, string][] = [
    ['an object without words', '{}', WORDS_RULE],
    ['words: null', body(null), WORDS_RULE],
    ['words as one string', body('abc'), WORDS_RULE],
    ['words as an object', body({ 0: 'abc', length: 1 }), WORDS_RULE],
    ['words as a number', body(3), WORDS_RULE],
    ['no word', body([]), WORDS_RULE],
    ['9 words', body(Array.from({ length: 9 }, (_, n) => `word${n}`)), WORDS_RULE],
    ['a number among the words', body(['abc', 48213]), WORDS_RULE],
    ['null among the words', body(['abc', null]), WORDS_RULE],
    ['an array among the words', body([['abc']]), WORDS_RULE],
    ['an object among the words', body([{ word: 'abc' }]), WORDS_RULE],
    ['a boolean among the words', body([true]), WORDS_RULE],
    ['an empty word', body(['']), WORD_RULE],
    ['a word of 2 bytes', body(['ab']), WORD_RULE],
    ['a word of 1 character and 2 bytes', body(['é']), WORD_RULE],
    ['a word of 201 bytes', body(['a'.repeat(201)]), WORD_RULE],
    ['a word of 101 characters and 202 bytes', body(['ж'.repeat(101)]), WORD_RULE],
    // 102 UTF-16 units, so it passes the cheap length check and is measured.
    ['a word of 51 characters and 204 bytes', body(['😀'.repeat(51)]), WORD_RULE],
    ['a valid word after an invalid one', body(['ab', 'abc']), WORD_RULE],
    ['an invalid word after a valid one', body(['abc', 'ab']), WORD_RULE],
    ['an unknown key', body(['abc'], { caseSensitive: false }), KEYS_RULE],
    ['a key named __proto__', '{"words":["abc"],"__proto__":{"words":["zzz"]}}', KEYS_RULE],
    ['a key named constructor', '{"constructor":1,"words":["abc"]}', KEYS_RULE],
    ['only a prototype key', '{"__proto__":{"words":["abc"]}}', WORDS_RULE],
  ];

  for (const [description, rawBody, message] of invalid) {
    it(`refuses ${description}`, () => {
      assertRefused(rawBody, 1010, message);
    });
  }

  it('reports the words before an unknown key, as the order of the checks has it', () => {
    assertRefused(body(['ab'], { other: 1 }), 1010, WORD_RULE);
    assertRefused(body([], { other: 1 }), 1010, WORDS_RULE);
  });

  it('never echoes a word in its message (D106)', () => {
    const secret = 'Qx7Zv9Kp2Wj4Ym8';

    for (const rawBody of [
      body([secret.repeat(20)]),
      body([secret, 'ab']),
      body(Array.from({ length: 9 }, () => secret)),
      body([secret], { [secret]: secret }),
      `{"words":["${secret}"`,
    ]) {
      assert.ok(!refusal(rawBody).message.includes(secret.slice(0, 5)));
    }
  });
});

/**
 * Made-up bodies built to break the parser, at growing sizes up to the body
 * limit Fastify lets through. Each must be answered - accepted, or refused
 * with one of the two codes - within a time bound: `JSON.parse` reads the body
 * once, and nothing after it grows with the body.
 */
describe('parseSearchBody: hostile bodies up to the body limit', () => {
  const SIZES = [1024, 64 * 1024, MAX_BODY_BYTES];
  /** Generous for a body the size of the limit; a regression to quadratic time is seconds. */
  const LIMIT_MS = 1000;

  function answered(rawBody: string): AppError | Buffer[] {
    const started = performance.now();
    let outcome: AppError | Buffer[];

    try {
      outcome = parseSearchBody(rawBody);
    } catch (error) {
      assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);
      assert.ok(error.errorCode === 1006 || error.errorCode === 1010);
      outcome = error;
    }

    const elapsed = performance.now() - started;

    assert.ok(elapsed < LIMIT_MS, `${elapsed.toFixed(1)} ms for ${rawBody.length} characters`);

    return outcome;
  }

  function refusedWith(rawBody: string, errorCode: number): void {
    const outcome = answered(rawBody);

    assert.ok(outcome instanceof AppError, 'the body was accepted');
    assert.equal(outcome.errorCode, errorCode);
  }

  for (const size of SIZES) {
    it(`refuses one word of ${size} bytes without echoing it`, () => {
      refusedWith(body(['a'.repeat(size)]), 1010);
      refusedWith(body(['ж'.repeat(size / 2)]), 1010);
      refusedWith(body(['😀'.repeat(size / 4)]), 1010);
      refusedWith(`{"words":["${'\\ud800'.repeat(size / 6)}"]}`, 1010);
    });

    it(`refuses ${size} bytes of words by their number, before reading one`, () => {
      refusedWith(body(Array.from({ length: size / 6 }, () => 'abc')), 1010);
      refusedWith(body(Array.from({ length: size / 2 }, () => 0)), 1010);
      refusedWith(`{"words":[${'[],'.repeat(size / 3)}[]]}`, 1010);
    });

    it(`answers ${size} bytes of nesting`, () => {
      const depth = size / 2;

      // An array is not an object, however deep; the parser may also give up.
      refusedWith('['.repeat(depth) + ']'.repeat(depth), 1006);
      // Nested inside `words`, it is one entry that is not a string, unless the
      // parser gives up on the depth first.
      answered(`{"words":[${'['.repeat(depth)}${']'.repeat(depth)}]}`);
      answered(`{"words":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}}`);
    });

    it(`refuses ${size} bytes of unknown keys beside valid words`, () => {
      const keys = Array.from({ length: size / 12 }, (_, n) => `"k${n}":1`).join(',');

      refusedWith(`{"words":["abc"],${keys}}`, 1010);
      refusedWith(`{${keys},"words":["abc"]}`, 1010);
      refusedWith(`{"words":["abc"],"${'k'.repeat(size)}":1}`, 1010);
    });

    it(`accepts valid words inside ${size} bytes of whitespace`, () => {
      const outcome = answered(`${' '.repeat(size / 2)}{"words":["abc"]}${'\n'.repeat(size / 2)}`);

      assert.deepEqual(outcome, [Buffer.from('abc')]);
    });

    it(`refuses ${size} bytes that never close`, () => {
      refusedWith(`{"words":["${'a'.repeat(size)}`, 1006);
      refusedWith('{"words":['.repeat(size / 10), 1006);
      refusedWith(`{"words":["abc"]}${'x'.repeat(size)}`, 1006);
      refusedWith('\u0000'.repeat(size), 1006);
    });
  }

  it('accepts the largest valid body: 8 words of 200 bytes, escaped at six bytes a character', () => {
    const word = '\\u0416'.repeat(100);
    const outcome = answered(
      `{"words":[${Array.from({ length: 8 }, () => `"${word}"`).join(',')}]}`,
    );

    assert.ok(Array.isArray(outcome));
    assert.equal(outcome.length, 8);
    assert.ok(outcome.every((bytes) => bytes.equals(Buffer.from('Ж'.repeat(100)))));
  });
});

describe('createSearchSlots', () => {
  it('gives out as many slots as its limit, and no more', () => {
    const slots = createSearchSlots(2);

    assert.notEqual(slots.tryTake(), null);
    assert.notEqual(slots.tryTake(), null);
    assert.equal(slots.tryTake(), null);
    assert.equal(slots.tryTake(), null);
  });

  it('allows 2 at once by default', () => {
    const slots = createSearchSlots();

    slots.tryTake();
    slots.tryTake();

    assert.equal(slots.tryTake(), null);
  });

  it('gives a slot out again once it is given back', () => {
    const slots = createSearchSlots(1);
    const release = slots.tryTake();

    assert.equal(slots.tryTake(), null);
    release?.();
    assert.notEqual(slots.tryTake(), null);
  });

  it('gives a slot back once, however often it is released', () => {
    const slots = createSearchSlots(2);
    const first = slots.tryTake();

    slots.tryTake();
    first?.();
    first?.();
    first?.();

    // One slot came back, not three.
    assert.notEqual(slots.tryTake(), null);
    assert.equal(slots.tryTake(), null);
  });

  it('refuses everything with a limit of 0', () => {
    assert.equal(createSearchSlots(0).tryTake(), null);
  });

  it('keeps the count of one set of slots apart from another', () => {
    const one = createSearchSlots(1);
    const other = createSearchSlots(1);

    one.tryTake();

    assert.notEqual(other.tryTake(), null);
  });
});

describe('the places of queries (D250)', () => {
  it('allows 2 searches and 2 header-only queries at once by default, each count apart', () => {
    assert.equal(MAX_CONCURRENT_SEARCHES, 2);
    assert.equal(MAX_CONCURRENT_HEADER_QUERIES, 2);

    const slots = createQuerySlots();

    for (let place = 0; place < MAX_CONCURRENT_HEADER_QUERIES; place += 1) {
      assert.notEqual(slots.headerOnly.tryTake(), null, `header-only place ${place}`);
    }

    assert.equal(slots.headerOnly.tryTake(), null);
    // Every header-only place taken leaves both of the search's.
    assert.notEqual(slots.search.tryTake(), null);
    assert.notEqual(slots.search.tryTake(), null);
    assert.equal(slots.search.tryTake(), null);
    assert.equal(slots.headerOnly.taken, MAX_CONCURRENT_HEADER_QUERIES);
    assert.equal(slots.search.taken, MAX_CONCURRENT_SEARCHES);
  });

  it('shares the search count it is given, and sizes its own', () => {
    const search = createSearchSlots(1);
    const slots = createQuerySlots(search, 3);

    assert.equal(slots.search, search);
    search.tryTake();
    assert.equal(slots.search.tryTake(), null);
    assert.notEqual(slots.headerOnly.tryTake(), null);
    assert.notEqual(slots.headerOnly.tryTake(), null);
    assert.notEqual(slots.headerOnly.tryTake(), null);
    assert.equal(slots.headerOnly.tryTake(), null);
  });

  it('puts a query with a body condition in the search’s count, and one with none in its own', () => {
    const slots = createQuerySlots();
    const headerOnly = [
      '{}',
      '{"headers":[]}',
      '{"headers":[],"body":[]}',
      '{"body":[]}',
      '{"headers":[{"name":"X-Merchant-ID","value":"123"}]}',
      JSON.stringify({
        headers: Array.from({ length: 8 }, () => ({ name: 'x-same', value: 'same' })),
        include: ['headers', 'body'],
        limit: 5,
        order: 'asc',
      }),
    ];
    const withBody = [
      '{"body":["order"]}',
      '{"headers":[{"name":"x-a","value":"b"}],"body":["order"]}',
      JSON.stringify({ body: Array.from({ length: 8 }, () => 'same') }),
    ];

    for (const raw of headerOnly) {
      assert.equal(slotsForQuery(parseQueryBody(raw), slots), slots.headerOnly, raw);
    }

    for (const raw of withBody) {
      assert.equal(slotsForQuery(parseQueryBody(raw), slots), slots.search, raw);
    }
  });

  it('refuses 1012 with Retry-After: 1 and the search’s message, from either count', () => {
    const refusal = searchBusy();

    assert.equal(refusal.statusCode, 429);
    assert.equal(refusal.errorCode, 1012);
    assert.equal(refusal.message, 'Too many searches are running; try again in a moment');
    assert.deepEqual(refusal.headers, { 'retry-after': '1' });
  });
});
