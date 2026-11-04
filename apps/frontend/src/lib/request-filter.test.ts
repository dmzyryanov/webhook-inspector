import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RequestListItem } from '@webhook-inspector/shared';
import {
  filterRequests,
  findRanges,
  formatDeleteAllDescription,
  formatFilterCount,
  isBlankQuery,
  matchesRequest,
  pathAfterSession,
  planRawSearch,
  queryWords,
  rowHighlights,
  sameRawSearchPlan,
  splitByRanges,
  typedWords,
  utf8Length,
  type RawMatches,
} from './request-filter.ts';

const SESSION = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';
const UTC = 'UTC';

function row(overrides: Partial<RequestListItem> = {}): RequestListItem {
  return {
    id: '2b906b8e-1f2a-4c3d-8e9f-0a1b2c3d4e5f',
    method: 'POST',
    receivedAt: '2026-09-17T14:32:06.000Z',
    bodySize: 19148,
    sourceIp: '145.40.74.12',
    path: `/s/${SESSION}/stripe/events`,
    response: { state: 'sent', status: 200, queueStep: null, rule: null },
    ...overrides,
  };
}

function matches(item: RequestListItem, query: string): boolean {
  return matchesRequest(item, queryWords(query), UTC);
}

describe('isBlankQuery', () => {
  it('treats an empty or whitespace-only query as no filter, like the matcher', () => {
    for (const query of ['', ' ', '  \t\n ']) {
      assert.equal(isBlankQuery(query), true, JSON.stringify(query));
      assert.deepEqual(queryWords(query), []);
    }

    assert.equal(isBlankQuery(' a '), false);
  });
});

describe('queryWords', () => {
  it('trims, lower-cases and splits on any whitespace', () => {
    assert.deepEqual(queryWords('  POST\t500 \n Stripe '), ['post', '500', 'stripe']);
  });

  it('has no words for an empty or blank query', () => {
    assert.deepEqual(queryWords(''), []);
    assert.deepEqual(queryWords('   '), []);
  });
});

describe('matchesRequest, per field', () => {
  it('matches the method, case-insensitively', () => {
    assert.equal(matches(row(), 'post'), true);
    assert.equal(matches(row(), 'PO'), true);
    assert.equal(matches(row(), 'GET'), false);
  });

  it('matches the status text the row shows', () => {
    assert.equal(matches(row(), '200'), true);
    assert.equal(
      matches(
        row({ response: { state: 'pending', status: 200, queueStep: null, rule: null } }),
        'pending',
      ),
      true,
    );
    assert.equal(
      matches(
        row({ response: { state: 'failed', status: null, queueStep: null, rule: null } }),
        'failed',
      ),
      true,
    );
    assert.equal(matches(row({ response: null }), 'not recorded'), true);
    // The status a row shows for a pending request is not its number.
    assert.equal(
      matches(
        row({ response: { state: 'pending', status: 500, queueStep: null, rule: null } }),
        '500',
      ),
      false,
    );
  });

  it('matches the full address and the address as the row shows it', () => {
    const ipv6 = '2001:db8:85a3:0000:0000:8a2e:0370:7334';

    assert.equal(matches(row(), '145.40'), true);
    // Beyond what the row's compacted address shows.
    assert.equal(matches(row({ sourceIp: ipv6 }), '0370:7334'), true);
    assert.equal(matches(row({ sourceIp: null }), 'IP unavailable'), true);
  });

  /** The row's words for a session that keeps no address (D249). */
  it('matches IP not stored on the rows of a session that keeps no address, and only there', () => {
    const item = row({ sourceIp: null });
    const words = queryWords('not stored');

    assert.equal(matchesRequest(item, words, UTC, undefined, undefined, true), true);
    assert.equal(
      matchesRequest(item, queryWords('IP unavailable'), UTC, undefined, undefined, true),
      false,
    );
    // The same row object, matched for a default session afterwards: no
    // words cached for the other kept.
    assert.equal(matchesRequest(item, words, UTC), false);
    assert.equal(matchesRequest(item, queryWords('IP unavailable'), UTC), true);
    assert.deepEqual(filterRequests([item, row()], 'not stored', UTC, undefined, undefined, true), [
      item,
    ]);
    assert.equal(
      rowHighlights(item, ['stored'], UTC, undefined, true).texts.address,
      'IP not stored',
    );
    assert.equal(rowHighlights(item, ['stored'], UTC).texts.address, 'IP unavailable');
  });

  it('keeps the two wordings apart in the viewer’s own zone, where rows are cached', () => {
    const item = row({ sourceIp: null });

    assert.equal(rowHighlights(item, []).texts.address, 'IP unavailable');
    assert.equal(
      rowHighlights(item, [], undefined, undefined, true).texts.address,
      'IP not stored',
    );
    assert.equal(rowHighlights(item, []).texts.address, 'IP unavailable');
    assert.deepEqual(filterRequests([item], 'not stored', undefined, undefined, undefined, true), [
      item,
    ]);
    assert.deepEqual(filterRequests([item], 'not stored'), []);
  });

  it('matches the time as the row shows it, in the viewer timezone', () => {
    assert.equal(matches(row(), '2026-09-17 14:32'), true);
    assert.equal(matchesRequest(row(), queryWords('17:32:06'), 'Europe/Moscow'), true);
    assert.equal(matchesRequest(row(), queryWords('17:32:06'), UTC), false);
  });

  it('matches any fragment of the full id, and a pasted whole id', () => {
    const item = row();

    assert.equal(matches(item, '2b906b8'), true);
    assert.equal(matches(item, '0a1b2c3d4e5f'), true);
    assert.equal(matches(item, item.id.toUpperCase()), true);
  });

  it('matches the path after /s/<id>, as stored', () => {
    assert.equal(matches(row(), 'stripe'), true);
    assert.equal(matches(row(), '/events'), true);
    assert.equal(matches(row({ path: `/s/${SESSION}/caf%C3%A9` }), '%c3%a9'), true);
    // The session part is not the path.
    assert.equal(matches(row({ path: `/s/${SESSION}` }), SESSION.slice(0, 10)), false);
  });

  it('does not match body size, and nothing else outside the fields', () => {
    assert.equal(matches(row(), '18.7'), false);
    assert.equal(matches(row(), 'KB'), false);
  });
});

describe('matchesRequest, words', () => {
  it('needs every word to match some field', () => {
    assert.equal(matches(row(), 'POST 200'), true);
    assert.equal(matches(row(), 'post stripe 145.40'), true);
    assert.equal(matches(row(), 'POST 500'), false);
  });

  it('matches every row for an empty query', () => {
    assert.equal(matches(row(), ''), true);
    assert.equal(matches(row(), '   '), true);
  });
});

describe('a row with no path', () => {
  it('is never matched by a path-only query', () => {
    assert.equal(matches(row({ path: null }), 'stripe'), false);
  });

  it('is treated as null when the backend sent no path', () => {
    const withoutPath: Partial<RequestListItem> = { ...row() };

    delete withoutPath.path;

    assert.equal(matches(withoutPath as RequestListItem, 'stripe'), false);
    assert.equal(matches(withoutPath as RequestListItem, 'POST'), true);
  });

  it('still matches by everything else', () => {
    assert.equal(matches(row({ path: null }), 'POST 200'), true);
  });
});

describe('pathAfterSession', () => {
  it('cuts the path after the session as the detail header does', () => {
    assert.equal(pathAfterSession({ path: `/s/${SESSION}/stripe/events` }), '/stripe/events');
    assert.equal(pathAfterSession({ path: `/s/${SESSION}/` }), '');
    assert.equal(pathAfterSession({ path: `/s/${SESSION}` }), '');
    assert.equal(pathAfterSession({ path: null }), '');
  });
});

describe('filterRequests', () => {
  const post = row({ id: 'a0000000-0000-4000-8000-000000000000' });
  const get = row({ id: 'b0000000-0000-4000-8000-000000000000', method: 'GET', path: null });

  it('keeps the matching rows in order', () => {
    assert.deepEqual(filterRequests([post, get], 'get', UTC), [get]);
    assert.deepEqual(filterRequests([post, get], '200', UTC), [post, get]);
  });

  it('returns the same array for no filter', () => {
    const items = [post, get];

    assert.equal(filterRequests(items, ' ', UTC), items);
  });
});

describe('highlights', () => {
  it('finds each occurrence of each word, case-insensitively, merged', () => {
    assert.deepEqual(findRanges('POST', ['po']), [[0, 2]]);
    assert.deepEqual(findRanges('2026-09-17 14:32:06', ['2']), [
      [0, 1],
      [2, 3],
      [15, 16],
    ]);
    assert.deepEqual(findRanges('abcdef', ['bc', 'cd']), [[1, 4]]);
    assert.deepEqual(findRanges('abc', ['x']), []);
  });

  it('highlights method, short id, status, address and time where the words occur', () => {
    const { texts, ranges } = rowHighlights(row(), queryWords('post 2b9 200 74.12 14:32'), UTC);

    assert.equal(texts.shortId, '2b906b8');
    assert.deepEqual(ranges.method, [[0, 4]]);
    assert.deepEqual(ranges.shortId, [[0, 3]]);
    assert.deepEqual(ranges.status, [[0, 3]]);
    assert.deepEqual(ranges.address, [[7, 12]]);
    assert.deepEqual(ranges.time, [[11, 16]]);
  });

  it('highlights nothing for a path-only match', () => {
    const { ranges } = rowHighlights(row(), queryWords('stripe'), UTC);

    assert.deepEqual(Object.values(ranges).flat(), []);
  });

  it('highlights nothing for an id fragment beyond the shown 7 characters', () => {
    const { ranges } = rowHighlights(row(), queryWords('0a1b2c'), UTC);

    assert.deepEqual(ranges.shortId, []);
  });

  it('cuts a text into plain and highlighted pieces', () => {
    assert.deepEqual(splitByRanges('POST', [[0, 2]]), [
      { text: 'PO', match: true },
      { text: 'ST', match: false },
    ]);
    assert.deepEqual(splitByRanges('a-b', [[1, 2]]), [
      { text: 'a', match: false },
      { text: '-', match: true },
      { text: 'b', match: false },
    ]);
  });
});

describe('texts', () => {
  it('counts the filtered list against the whole', () => {
    assert.equal(formatFilterCount(3, 8), '3 of 8');
  });

  it('names the hidden requests in the Delete all dialog only when there are some', () => {
    assert.equal(
      formatDeleteAllDescription(3, 1),
      'This will permanently delete all 3 requests from this session, including 1 hidden by the filter. This action cannot be undone.',
    );
    assert.equal(
      formatDeleteAllDescription(3, 0),
      'This will permanently delete all 3 requests from this session. This action cannot be undone.',
    );
  });
});

/** What the server found: for each word, the ids whose Raw holds it. */
function found(entries: Record<string, string[]>): RawMatches {
  return new Map(Object.entries(entries).map(([word, ids]) => [word, new Set(ids)]));
}

describe('a repeated word', () => {
  it('is one word, in either form, and letter cases stay apart as typed', () => {
    assert.deepEqual(queryWords('POST post 500 Post'), ['post', '500']);
    assert.deepEqual(typedWords('POST post 500 POST'), ['POST', 'post', '500']);
  });

  /**
   * Up to a megabyte, each size 4 times the last: a filter whose time grows
   * with the square of the query, under its bound at one size, takes about
   * 16 times as long at the next and fails there, not after minutes at the
   * megabyte.
   */
  const SIZES = [16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024];
  /**
   * 4000 ms (#388): 3.3 times the slowest call of loaded suites, 1222 ms,
   * most of a call under load being the 1000 rows' texts, built anew at
   * every size; 3.3 times under matching every repeat of the word against
   * every row, 13.3 s alone at a megabyte.
   */
  const LIMIT_MS = 4000;

  it('costs the list nothing: a megabyte of one word over 1000 rows', () => {
    const items = Array.from({ length: 1000 }, (_, n) =>
      row({ id: `${String(n).padStart(8, '0')}-1f2a-4c3d-8e9f-0a1b2c3d4e5f` }),
    );

    for (const size of SIZES) {
      for (const query of ['p '.repeat(size / 2), 'post 200 '.repeat(Math.floor(size / 9))]) {
        const started = performance.now();
        const kept = filterRequests(items, query, UTC);
        const first = items[0] as RequestListItem;
        const { ranges } = rowHighlights(first, queryWords(query), UTC);
        const elapsed = performance.now() - started;

        assert.equal(kept.length, 1000);
        assert.equal(ranges.method.length, 1);
        assert.ok(elapsed < LIMIT_MS, `${elapsed.toFixed(1)} ms for ${query.length} characters`);
      }
    }
  });
});

describe('typedWords', () => {
  it('splits as queryWords does and keeps the letter case', () => {
    assert.deepEqual(typedWords('  POST\t500 \n Stripe '), ['POST', '500', 'Stripe']);
    assert.deepEqual(typedWords(''), []);
    assert.deepEqual(typedWords(' \u00a0 '), []);

    for (const query of ['POST 48213', ' x-Signature\u00a0sha256= ', 'Иван\n\tЖ', 'İ ǅ ß']) {
      assert.deepEqual(
        typedWords(query).map((word) => word.toLowerCase()),
        queryWords(query),
        query,
      );
    }
  });
});

describe('matchesRequest, with what the server found in Raw (D191)', () => {
  const ID = '2b906b8e-1f2a-4c3d-8e9f-0a1b2c3d4e5f';
  const OTHER = '9b14d3a0-0000-4000-8000-000000000000';

  it('keeps a row no list field matches when its Raw holds the word', () => {
    const raw = found({ 'order-77': [ID] });

    assert.equal(matchesRequest(row(), ['order-77'], UTC), false);
    assert.equal(matchesRequest(row(), ['order-77'], UTC, raw), true);
    assert.equal(matchesRequest(row({ id: OTHER }), ['order-77'], UTC, raw), false);
  });

  it('looks a word up in Raw as typed: the same word in another case is not found there', () => {
    const raw = found({ 'Order-77': [ID] });

    assert.equal(matchesRequest(row(), ['Order-77'], UTC, raw), true);
    assert.equal(matchesRequest(row(), ['order-77'], UTC, raw), false);
    assert.equal(matchesRequest(row(), ['ORDER-77'], UTC, raw), false);
    // List fields stay case-insensitive beside it.
    assert.equal(matchesRequest(row(), ['post'], UTC, raw), true);
    assert.equal(matchesRequest(row(), ['POST'], UTC, raw), true);
  });

  it('needs every word in a list field or in Raw, each on its own', () => {
    // `POST order-77`: a POST whose body holds order-77.
    const raw = found({ POST: [ID, OTHER], 'order-77': [ID, OTHER] });
    const post = row();
    const postWithout = row({ id: 'aaaaaaaa-0000-4000-8000-000000000000' });
    const get = row({ id: OTHER, method: 'GET' });

    assert.equal(matchesRequest(post, ['POST', 'order-77'], UTC, raw), true);
    assert.equal(matchesRequest(postWithout, ['POST', 'order-77'], UTC, raw), false);
    // A GET the server found `POST` in - in its body, say - matches too.
    assert.equal(matchesRequest(get, ['POST', 'order-77'], UTC, raw), true);
    assert.equal(
      matchesRequest(get, ['POST', 'order-77'], UTC, found({ 'order-77': [OTHER] })),
      false,
    );
  });

  it('lets one word match by a list field and another by Raw', () => {
    const raw = found({ 'order-77': [ID] });

    assert.equal(matchesRequest(row(), ['200', 'order-77', 'stripe'], UTC, raw), true);
    assert.equal(matchesRequest(row(), ['500', 'order-77'], UTC, raw), false);
  });

  it('matches list fields only for a word the server was not asked about', () => {
    const raw = found({ 'order-77': [ID] });

    assert.equal(matchesRequest(row(), ['zz'], UTC, raw), false);
    assert.equal(matchesRequest(row(), ['po'], UTC, raw), true);
    assert.equal(matchesRequest(row(), ['order-7'], UTC, raw), false);
  });

  it('ignores an id the list does not hold, and an empty answer', () => {
    assert.equal(matchesRequest(row(), ['order-77'], UTC, found({ 'order-77': [] })), false);
    assert.equal(matchesRequest(row(), ['order-77'], UTC, found({})), false);
    assert.equal(matchesRequest(row(), [], UTC, found({ 'order-77': [OTHER] })), true);
  });

  it('filters the list by list fields and Raw together, in order, and counts both', () => {
    const items = [
      row({ id: 'a0000000-0000-4000-8000-000000000000', method: 'GET' }),
      row({ id: 'b0000000-0000-4000-8000-000000000000' }),
      row({ id: 'c0000000-0000-4000-8000-000000000000', method: 'PUT' }),
      row({ id: 'd0000000-0000-4000-8000-000000000000', method: 'GET', path: `/s/${SESSION}` }),
    ];
    const raw = found({
      'order-77': ['c0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000000'],
    });

    assert.deepEqual(
      filterRequests(items, 'order-77', UTC, raw).map((item) => item.method),
      ['GET', 'PUT'],
    );
    assert.deepEqual(filterRequests(items, 'order-77', UTC), []);
    // Without a filter the same array, whatever the server found earlier.
    assert.equal(filterRequests(items, '  ', UTC, raw), items);
    // `GET order-77`: the method from the list, the order from Raw.
    assert.deepEqual(
      filterRequests(items, 'get order-77', UTC, raw).map((item) => item.id[0]),
      ['a'],
    );
    // A word matching a list field of one row and the Raw of another keeps both.
    assert.deepEqual(
      filterRequests(items, 'stripe', UTC, found({ stripe: [items[3]?.id as string] })).length,
      4,
    );
  });

  it('highlights nothing in a row found only in Raw', () => {
    const { ranges } = rowHighlights(row(), queryWords('order-77'), UTC);

    assert.deepEqual(ranges, { method: [], shortId: [], status: [], address: [], time: [] });

    // Beside a list-field match, only that match is highlighted.
    const mixed = rowHighlights(row(), queryWords('POST order-77'), UTC).ranges;

    assert.deepEqual(mixed.method, [[0, 4]]);
    assert.deepEqual([mixed.shortId, mixed.status, mixed.address, mixed.time], [[], [], [], []]);
  });
});

describe('planRawSearch: the searchable-word rules (D191)', () => {
  const search = (words: string[]) => ({ kind: 'search', words });
  const NONE = { kind: 'none' };

  it('sends nothing for a query with no word of 3 bytes or more', () => {
    for (const query of ['', '   ', 'a', 'ab', 'a b cd', 'ab\tcd\nef', 'é', 'ж']) {
      assert.deepEqual(planRawSearch(query), NONE, JSON.stringify(query));
    }
  });

  it('searches the words of 3 bytes or more, as typed, and leaves the shorter to the list', () => {
    assert.deepEqual(planRawSearch('abc'), search(['abc']));
    assert.deepEqual(planRawSearch('  POST 48213 '), search(['POST', '48213']));
    assert.deepEqual(planRawSearch('ab POST x 48213 cd'), search(['POST', '48213']));
    assert.deepEqual(planRawSearch('X-Signature sha256='), search(['X-Signature', 'sha256=']));
  });

  it('measures a word in bytes of UTF-8, not in characters', () => {
    assert.equal(utf8Length('abc'), 3);
    assert.equal(utf8Length('é'), 2);
    assert.equal(utf8Length('ж'), 2);
    assert.equal(utf8Length('€'), 3);
    assert.equal(utf8Length('😀'), 4);

    // Two characters, three bytes; one character, three bytes; one, four.
    assert.deepEqual(planRawSearch('éa'), search(['éa']));
    assert.deepEqual(planRawSearch('€'), search(['€']));
    assert.deepEqual(planRawSearch('😀'), search(['😀']));
    // Two characters, four bytes.
    assert.deepEqual(planRawSearch('жж'), search(['жж']));
  });

  it('counts an unpaired surrogate as the three bytes of U+FFFD, as the server does', () => {
    assert.equal(utf8Length('\ud800'), 3);
    assert.deepEqual(planRawSearch('\ud800'), search(['\ud800']));
  });

  it('searches a repeated word once, and tells letter cases apart', () => {
    assert.deepEqual(planRawSearch('abc abc abc'), search(['abc']));
    assert.deepEqual(planRawSearch('abc ABC Abc abc'), search(['abc', 'ABC', 'Abc']));
  });

  it('allows 8 searchable words and refuses a ninth', () => {
    const eight = 'w01 w02 w03 w04 w05 w06 w07 w08';

    assert.deepEqual(planRawSearch(eight), search(eight.split(' ')));
    assert.deepEqual(planRawSearch(`${eight} w09`), { kind: 'refused', reason: 'too-many-words' });
    // Shorter words and repeats are not counted.
    assert.deepEqual(planRawSearch(`a b ${eight} cd w01 w08 e`), search(eight.split(' ')));
  });

  it('allows a word of 200 bytes and refuses one of 201', () => {
    assert.deepEqual(planRawSearch('a'.repeat(200)), search(['a'.repeat(200)]));
    assert.deepEqual(planRawSearch('ж'.repeat(100)), search(['ж'.repeat(100)]));
    assert.deepEqual(planRawSearch('a'.repeat(201)), { kind: 'refused', reason: 'word-too-long' });
    assert.deepEqual(planRawSearch(`abc ${'ж'.repeat(101)}`), {
      kind: 'refused',
      reason: 'word-too-long',
    });
    // 51 characters, 102 UTF-16 units, 204 bytes.
    assert.deepEqual(planRawSearch('😀'.repeat(51)), { kind: 'refused', reason: 'word-too-long' });
  });

  it('names the long word when a query breaks both limits, wherever the word is', () => {
    const nine = 'w01 w02 w03 w04 w05 w06 w07 w08 w09';

    for (const query of [`${'a'.repeat(201)} ${nine}`, `${nine} ${'a'.repeat(201)}`]) {
      assert.deepEqual(planRawSearch(query), { kind: 'refused', reason: 'word-too-long' });
    }
  });

  it('never plans a search the backend would refuse', () => {
    for (const query of ['abc', 'POST 48213', 'ab cd', 'a'.repeat(200), 'ж'.repeat(100)]) {
      const plan = planRawSearch(query);

      if (plan.kind === 'search') {
        assert.ok(plan.words.length >= 1 && plan.words.length <= 8);

        for (const word of plan.words) {
          assert.ok(Buffer.byteLength(word, 'utf8') >= 3 && Buffer.byteLength(word, 'utf8') <= 200);
        }
      }
    }
  });

  it('tells whether two plans ask the server the same thing', () => {
    assert.equal(sameRawSearchPlan(planRawSearch('abc'), planRawSearch(' abc  ')), true);
    assert.equal(sameRawSearchPlan(planRawSearch('abc'), planRawSearch('abc de')), true);
    assert.equal(sameRawSearchPlan(planRawSearch('abc def'), planRawSearch('def abc')), false);
    assert.equal(sameRawSearchPlan(planRawSearch('abc'), planRawSearch('Abc')), false);
    assert.equal(sameRawSearchPlan(planRawSearch('abc'), planRawSearch('abcd')), false);
    assert.equal(sameRawSearchPlan(planRawSearch(''), planRawSearch('ab')), true);
    assert.equal(sameRawSearchPlan(planRawSearch(''), planRawSearch('abc')), false);
    assert.equal(
      sameRawSearchPlan(planRawSearch('a'.repeat(201)), planRawSearch('b'.repeat(300))),
      true,
    );
    assert.equal(
      sameRawSearchPlan(
        planRawSearch('a'.repeat(201)),
        planRawSearch('w01 w02 w03 w04 w05 w06 w07 w08 w09'),
      ),
      false,
    );
  });
});

/**
 * What a viewer can paste into the field, built to break the rules, at growing
 * sizes: every query gets a plan, in a time that grows no faster than it does.
 */
describe('planRawSearch: hostile queries', () => {
  const SIZES = [1024, 64 * 1024, 1024 * 1024];
  /** Generous for a megabyte; quadratic time on it is minutes. */
  const LIMIT_MS = 1000;

  function planned(query: string): ReturnType<typeof planRawSearch> {
    const started = performance.now();
    const plan = planRawSearch(query);
    const elapsed = performance.now() - started;

    assert.ok(elapsed < LIMIT_MS, `${elapsed.toFixed(1)} ms for ${query.length} characters`);

    return plan;
  }

  for (const size of SIZES) {
    it(`plans ${size} characters of one word, of many words and of whitespace`, () => {
      const tooLong = { kind: 'refused', reason: 'word-too-long' };
      const tooMany = { kind: 'refused', reason: 'too-many-words' };

      assert.deepEqual(planned('a'.repeat(size)), tooLong);
      assert.deepEqual(planned('😀'.repeat(size / 2)), tooLong);
      assert.deepEqual(planned('\ud800'.repeat(size)), tooLong);
      // Distinct words, all searchable: more than 8, and never compared pairwise.
      assert.deepEqual(
        planned(Array.from({ length: size / 8 }, (_, n) => `w${n}`.padEnd(7, 'x')).join(' ')),
        tooMany,
      );
      // The same, with one word over the byte limit at the very end.
      assert.deepEqual(
        planned(
          `${Array.from({ length: size / 8 }, (_, n) => `w${n}`.padEnd(7, 'x')).join(' ')} ${'a'.repeat(201)}`,
        ),
        tooLong,
      );
      // One word repeated: searched once.
      assert.deepEqual(planned('abc '.repeat(size / 4)), { kind: 'search', words: ['abc'] });
      // Only short words, only whitespace, and whitespace around one word.
      assert.deepEqual(planned('ab '.repeat(size / 3)), { kind: 'none' });
      assert.deepEqual(planned(' \t\n\u00a0'.repeat(size / 4)), { kind: 'none' });
      assert.deepEqual(planned(`${' '.repeat(size / 2)}abc${'\n'.repeat(size / 2)}`), {
        kind: 'search',
        words: ['abc'],
      });
    });
  }
});
