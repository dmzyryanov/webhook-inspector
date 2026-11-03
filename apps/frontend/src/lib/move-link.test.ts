import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { en } from '../i18n/en.ts';
import { LANGUAGE_KEY } from '../i18n/index.ts';
import { ru } from '../i18n/ru.ts';
import {
  ACCESS_KEYS_KEY,
  accessKeyFor,
  loadAccessKeys,
  MAX_STORED_ACCESS_KEYS,
  mergeMovedAccessKeys,
  releaseAllAccessKeys,
} from './access-keys.ts';
import {
  BUILT_MOVE,
  buildMoveLink,
  collectMove,
  encodeMove,
  formatMoveDay,
  holdsMoveFragment,
  MAX_MOVE_FRAGMENT_LENGTH,
  mergeMove,
  moveArrivedToast,
  moveBannerShown,
  moveNoticePieces,
  MOVE_FORMAT_VERSION,
  originHost,
  parseBuiltMove,
  parseMoveValue,
  readMoveFragment,
  takeKeyUnlessMove,
  takeMoveFromAddress,
  type BuiltMove,
  type MoveData,
  type MoveStorage,
} from './move-link.ts';
import { QUEUE_SECTION_KEY, RULES_SECTION_KEY } from './queue-section-open.ts';
import { buildAccessLink, takeKeyFromAddress } from './request-link.ts';
import {
  loadSessionList,
  MAX_LISTED_SESSIONS,
  mergeMovedSessions,
  SESSION_LIST_KEY,
  type ListedSession,
} from './session-list.ts';
// Loads `.tsx` for the banner rendered below, which is imported once this has run.
import '../testing/render-in-node.ts';

/**
 * The move of the inspector to its new address (issue #321, D276): the move
 * link's format both ways, its strict reading - hostile input at growing
 * sizes included - the add-only merge within the stores' limits, the address
 * left with no fragment, the toast's counts and the banner's visibility by
 * origin. `move-render.test.ts` renders the banner and the toast of a bundle
 * built with the move; the banner of one built with none is rendered here.
 */

/** A well-formed session id, different for every `n`. */
function id(n: number): string {
  return `S${String(n).padStart(6, '0')}${'k'.repeat(36)}`;
}

/** A well-formed access key, different for every `n`. */
function key(n: number): string {
  return `K${String(n).padStart(6, '0')}${'q'.repeat(36)}`;
}

/** An in-memory `localStorage`, optionally refusing writes as a full one does. */
function memoryStorage(initial: Record<string, string> = {}, options: { full?: boolean } = {}) {
  const items = new Map(Object.entries(initial));

  return {
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => {
      if (options.full) {
        throw new DOMException('quota', 'QuotaExceededError');
      }

      items.set(name, value);
    },
    /** Every stored value, for comparing before and after. */
    snapshot: () => Object.fromEntries([...items].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Storage whose every access throws, as a blocked one does. */
const blocked: MoveStorage = {
  getItem: () => {
    throw new DOMException('blocked', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('blocked', 'SecurityError');
  },
};

/** The stored list's value for these entries, as `session-list.ts` writes it. */
function storedList(entries: ListedSession[]): string {
  return JSON.stringify({ v: 1, items: entries });
}

/** The key store's value for these pairs, as `access-keys.ts` writes it. */
function storedKeys(pairs: [string, string][]): string {
  return JSON.stringify({
    v: 1,
    items: pairs.map(([sessionId, value]) => ({ id: sessionId, key: value })),
  });
}

/** A link's data with nothing in it but what is given. */
function data(partial: Partial<MoveData> = {}): MoveData {
  return {
    sessions: [],
    keys: [],
    language: null,
    queueSection: null,
    rulesSection: null,
    ...partial,
  };
}

/** The fragment of a JSON value as a link would carry it, encoded as given. */
function fragmentOf(value: unknown): string {
  return `https://webhook.example/#move=${btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

/** A valid link value, whose parts a test then breaks one at a time. */
function validValue(): Record<string, unknown> {
  return {
    v: 1,
    sessions: [{ id: id(1), openedAt: 1_700_000_000_000 }],
    keys: [{ id: id(1), key: key(1) }],
    language: 'ru',
    queueSection: false,
    rulesSection: true,
  };
}

/** An address bar over a fixed address, recording what replaces it. */
function addressBar(href: string) {
  const replaced: string[] = [];

  return { href, replace: (next: string) => replaced.push(next), replaced };
}

/** The production move, as the build gives it; its day is a sample. */
const PRODUCTION: BuiltMove = {
  from: 'https://qa-tools.ru',
  to: 'https://webhook.qa-tools.ru',
  day: '2027-03-09',
};

describe('the move link’s format (D276)', () => {
  it('is base64url of versioned JSON with the stores’ items, and omits what is not stored', () => {
    const move = data({
      sessions: [{ id: id(1), openedAt: 1_700_000_000_000 }],
      keys: [[id(1), key(1)]],
    });
    const encoded = encodeMove(move);

    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(JSON.parse(atob(encoded.replaceAll('-', '+').replaceAll('_', '/'))), {
      v: MOVE_FORMAT_VERSION,
      sessions: [{ id: id(1), openedAt: 1_700_000_000_000 }],
      keys: [{ id: id(1), key: key(1) }],
    });
    assert.equal(MOVE_FORMAT_VERSION, 1);
  });

  it('is the new origin’s home page with the one parameter, and reads back to what it carried', () => {
    for (const move of [
      data(),
      data({ language: 'en', queueSection: true, rulesSection: false }),
      data({
        sessions: [
          { id: id(1), openedAt: 1_700_000_000_000 },
          { id: id(2), openedAt: -5 },
          { id: 'abc_DEF-123'.padEnd(43, 'x'), openedAt: 0 },
        ],
        keys: [
          [id(2), key(2)],
          [id(1), key(1)],
        ],
        language: 'ru',
        queueSection: false,
        rulesSection: true,
      }),
    ]) {
      const link = buildMoveLink('https://webhook.qa-tools.ru', move);

      assert.ok(link.startsWith('https://webhook.qa-tools.ru/#move='), link);
      assert.deepEqual(readMoveFragment(link), { kind: 'move', move });
    }
  });

  it('carries the most the stores keep, 50 sessions and 100 keys, well within its bound', () => {
    const move = data({
      sessions: Array.from({ length: MAX_LISTED_SESSIONS }, (_, n) => ({
        id: id(n),
        openedAt: -8.64e15 + n,
      })),
      keys: Array.from({ length: MAX_STORED_ACCESS_KEYS }, (_, n): [string, string] => [
        id(n),
        key(n),
      ]),
      language: 'ru',
      queueSection: true,
      rulesSection: true,
    });
    const encoded = encodeMove(move);

    assert.ok(encoded.length < 20_000, `${encoded.length} characters`);
    assert.ok(encoded.length < MAX_MOVE_FRAGMENT_LENGTH);
    assert.deepEqual(readMoveFragment(buildMoveLink('https://webhook.qa-tools.ru', move)), {
      kind: 'move',
      move,
    });
  });

  it('is built from what each store reads, and nothing where storage holds nothing of its own', () => {
    const storage = memoryStorage({
      [SESSION_LIST_KEY]: storedList([
        { id: id(1), openedAt: 2 },
        { id: id(2), openedAt: 3 },
      ]),
      [ACCESS_KEYS_KEY]: storedKeys([[id(2), key(2)]]),
      [LANGUAGE_KEY]: '{"v":1,"lang":"ru"}',
      [QUEUE_SECTION_KEY]: '{"v":1,"open":false}',
      [RULES_SECTION_KEY]: '{"v":1,"open":true}',
      'qa-tools:read:abc': '{"v":1}',
      'qa-tools:filter:abc': 'POST',
    });

    assert.deepEqual(collectMove(storage), {
      sessions: [
        { id: id(2), openedAt: 3 },
        { id: id(1), openedAt: 2 },
      ],
      keys: [[id(2), key(2)]],
      language: 'ru',
      queueSection: false,
      rulesSection: true,
    });

    // Read marks and filters stay behind: the link names no other key.
    const encoded = encodeMove(collectMove(storage));

    assert.doesNotMatch(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), /read|filter/);

    for (const empty of [
      null,
      blocked,
      memoryStorage(),
      memoryStorage({
        [SESSION_LIST_KEY]: 'not json',
        [ACCESS_KEYS_KEY]: '{"v":2,"items":[]}',
        [LANGUAGE_KEY]: '{"v":1,"lang":"de"}',
        [QUEUE_SECTION_KEY]: 'true',
        [RULES_SECTION_KEY]: '{"v":1,"open":"yes"}',
      }),
    ]) {
      assert.deepEqual(collectMove(empty), data());
    }
  });
});

describe('reading a move link', () => {
  it('leaves every other fragment to the page that reads it', () => {
    for (const href of [
      'https://webhook.qa-tools.ru/',
      'https://webhook.qa-tools.ru/#',
      `https://webhook.qa-tools.ru/v/${id(1)}#key=${key(1)}`,
      `https://webhook.qa-tools.ru/v/${id(1)}#3f2a1b4c-0000-4000-8000-000000000000`,
      'https://webhook.qa-tools.ru/#Move=e30',
      'https://webhook.qa-tools.ru/#xmove=e30',
      'https://webhook.qa-tools.ru/#move',
      'https://webhook.qa-tools.ru/?move=e30',
    ]) {
      assert.deepEqual(readMoveFragment(href), { kind: 'none' }, href);
      assert.equal(holdsMoveFragment(href), false, href);
    }
  });

  it('refuses a value that is no base64url, or no JSON, or longer than any link writes', () => {
    for (const encoded of [
      '',
      'e30=',
      'e3+0',
      'e3/0',
      'e3 0',
      'e3%200',
      'e30&key=abc',
      'e30.e30',
      'A',
      'AAAAA',
      btoa('not json').replace(/=+$/, ''),
      btoa('{"v":1,').replace(/=+$/, ''),
      btoa('ÿþ').replace(/=+$/, ''),
      'A'.repeat(MAX_MOVE_FRAGMENT_LENGTH + 1),
    ]) {
      const href = `https://webhook.qa-tools.ru/#move=${encoded}`;

      assert.deepEqual(readMoveFragment(href), { kind: 'refused' }, encoded.slice(0, 40));
      assert.equal(holdsMoveFragment(href), true);
    }
  });

  it('refuses JSON of another shape, another version, or a field of another type', () => {
    const broken: [string, unknown][] = [
      ['an array', [validValue()]],
      ['null', null],
      ['a number', 1],
      ['a string', 'move'],
      ['no version', { ...validValue(), v: undefined }],
      ['version 2', { ...validValue(), v: 2 }],
      ['version 0', { ...validValue(), v: 0 }],
      ['version as text', { ...validValue(), v: '1' }],
      ['no sessions', { ...validValue(), sessions: undefined }],
      ['sessions not a list', { ...validValue(), sessions: { 0: { id: id(1), openedAt: 1 } } }],
      ['no keys', { ...validValue(), keys: undefined }],
      ['keys not a list', { ...validValue(), keys: 'none' }],
      ['a session that is no object', { ...validValue(), sessions: [[id(1), 1]] }],
      ['a session that is null', { ...validValue(), sessions: [null] }],
      ['an id too short', { ...validValue(), sessions: [{ id: id(1).slice(1), openedAt: 1 }] }],
      ['an id too long', { ...validValue(), sessions: [{ id: `${id(1)}x`, openedAt: 1 }] }],
      [
        'an id of other characters',
        { ...validValue(), sessions: [{ id: `${id(1).slice(1)}.`, openedAt: 1 }] },
      ],
      ['an id as a number', { ...validValue(), sessions: [{ id: 7, openedAt: 1 }] }],
      ['a time as text', { ...validValue(), sessions: [{ id: id(1), openedAt: '1' }] }],
      ['a fractional time', { ...validValue(), sessions: [{ id: id(1), openedAt: 1.5 }] }],
      ['a time no date holds', { ...validValue(), sessions: [{ id: id(1), openedAt: 1e20 }] }],
      ['no time', { ...validValue(), sessions: [{ id: id(1) }] }],
      [
        'a session twice',
        {
          ...validValue(),
          sessions: [
            { id: id(1), openedAt: 1 },
            { id: id(1), openedAt: 2 },
          ],
        },
      ],
      [
        'more sessions than the list keeps',
        {
          ...validValue(),
          sessions: Array.from({ length: MAX_LISTED_SESSIONS + 1 }, (_, n) => ({
            id: id(n),
            openedAt: n,
          })),
        },
      ],
      ['a key that is no object', { ...validValue(), keys: [[id(1), key(1)]] }],
      ['a key too short', { ...validValue(), keys: [{ id: id(1), key: key(1).slice(1) }] }],
      [
        'a key of other characters',
        { ...validValue(), keys: [{ id: id(1), key: `${key(1).slice(1)}=` }] },
      ],
      ['a key for no session id', { ...validValue(), keys: [{ id: 'abc', key: key(1) }] }],
      ['a key as a number', { ...validValue(), keys: [{ id: id(1), key: 5 }] }],
      [
        'a session’s key twice',
        {
          ...validValue(),
          keys: [
            { id: id(1), key: key(1) },
            { id: id(1), key: key(2) },
          ],
        },
      ],
      [
        'more keys than the store keeps',
        {
          ...validValue(),
          keys: Array.from({ length: MAX_STORED_ACCESS_KEYS + 1 }, (_, n) => ({
            id: id(n),
            key: key(n),
          })),
        },
      ],
      ['another language', { ...validValue(), language: 'de' }],
      ['a language as null', { ...validValue(), language: null }],
      ['a language in capitals', { ...validValue(), language: 'RU' }],
      ['a queue state as text', { ...validValue(), queueSection: 'true' }],
      ['a queue state as a number', { ...validValue(), queueSection: 1 }],
      ['a rules state as null', { ...validValue(), rulesSection: null }],
    ];

    for (const [what, value] of broken) {
      assert.deepEqual(readMoveFragment(fragmentOf(value)), { kind: 'refused' }, what);
    }

    // The version, the lists and the fields are read as its own properties.
    assert.deepEqual(
      readMoveFragment(
        `https://webhook.qa-tools.ru/#move=${btoa('{"__proto__":{"v":1},"sessions":[],"keys":[]}').replace(/=+$/, '')}`,
      ),
      { kind: 'refused' },
    );
    assert.equal(parseMoveValue(Object.create({ v: 1, sessions: [], keys: [] })), null);
  });

  it('reads a valid link, passing over a field this version does not know', () => {
    assert.deepEqual(readMoveFragment(fragmentOf({ ...validValue(), later: [1, 2, 3] })), {
      kind: 'move',
      move: {
        sessions: [{ id: id(1), openedAt: 1_700_000_000_000 }],
        keys: [[id(1), key(1)]],
        language: 'ru',
        queueSection: false,
        rulesSection: true,
      },
    });
    assert.deepEqual(readMoveFragment(fragmentOf({ v: 1, sessions: [], keys: [] })), {
      kind: 'move',
      move: data(),
    });
  });

  for (const size of [1_000, 100_000, 1_000_000]) {
    it(`refuses a hostile value of ${size.toLocaleString('en-US')} characters, in bounded time`, () => {
      const started = performance.now();
      const hostile = [
        'A'.repeat(size),
        `${'-'.repeat(size - 1)}%`,
        '%'.repeat(size),
        // A valid link whose JSON is padded past the bound by a field it does not know.
        encodeMove(data()).slice(0, -2) + 'A'.repeat(size),
        btoa(JSON.stringify({ ...validValue(), later: 'x'.repeat(size) })).replace(/=+$/, ''),
        btoa(`${'['.repeat(Math.floor(size / 2))}${']'.repeat(Math.floor(size / 2))}`).replace(
          /=+$/,
          '',
        ),
      ];

      for (const encoded of hostile) {
        const read = readMoveFragment(`https://webhook.qa-tools.ru/#move=${encoded}`);

        if (encoded.length > MAX_MOVE_FRAGMENT_LENGTH) {
          assert.deepEqual(read, { kind: 'refused' });
        } else {
          // Small enough to be read: refused all the same, or the padded valid one passed over.
          assert.ok(read.kind === 'refused' || read.kind === 'move');
        }
      }

      // Too many sessions or keys, at growing counts, whatever their size.
      for (const count of [MAX_LISTED_SESSIONS + 1, Math.min(size, 20_000)]) {
        const sessions = Array.from({ length: count }, (_, n) => ({ id: id(n), openedAt: n }));

        assert.equal(parseMoveValue({ v: 1, sessions, keys: [] }), null);
        assert.equal(
          parseMoveValue({
            v: 1,
            sessions: [],
            keys: Array.from({ length: Math.max(count, MAX_STORED_ACCESS_KEYS + 1) }, (_, n) => ({
              id: id(n),
              key: key(n),
            })),
          }),
          null,
        );
      }

      assert.ok(performance.now() - started < 3000, `${size} characters took too long`);
    });
  }
});

describe('the arrival only adds (Decision 4 of #321)', () => {
  it('fills an empty address with the sessions, keys, language and section states', () => {
    const storage = memoryStorage();
    const arrival = mergeMove(
      storage,
      data({
        sessions: [
          { id: id(1), openedAt: 10 },
          { id: id(2), openedAt: 20 },
          { id: id(3), openedAt: 30 },
        ],
        keys: [[id(2), key(2)]],
        language: 'ru',
        queueSection: false,
        rulesSection: true,
      }),
    );

    assert.deepEqual(arrival, { sessions: 3, privateSessions: 1 });
    assert.deepEqual(loadSessionList(storage), [
      { id: id(3), openedAt: 30 },
      { id: id(2), openedAt: 20 },
      { id: id(1), openedAt: 10 },
    ]);
    assert.deepEqual([...loadAccessKeys(storage)], [[id(2), key(2)]]);
    assert.equal(storage.getItem(LANGUAGE_KEY), '{"v":1,"lang":"ru"}');
    assert.equal(storage.getItem(QUEUE_SECTION_KEY), '{"v":1,"open":false}');
    assert.equal(storage.getItem(RULES_SECTION_KEY), '{"v":1,"open":true}');
  });

  it('adds to the sessions already here, removes none, and lists none twice, keeping the later opening', () => {
    const storage = memoryStorage({
      [SESSION_LIST_KEY]: storedList([
        { id: id(1), openedAt: 100 },
        { id: id(2), openedAt: 5 },
        { id: id(9), openedAt: 50 },
      ]),
    });
    const arrival = mergeMove(
      storage,
      data({
        sessions: [
          { id: id(1), openedAt: 40 },
          { id: id(2), openedAt: 80 },
          { id: id(3), openedAt: 60 },
        ],
      }),
    );

    assert.deepEqual(arrival, { sessions: 3, privateSessions: 0 });
    assert.deepEqual(loadSessionList(storage), [
      { id: id(1), openedAt: 100 },
      { id: id(2), openedAt: 80 },
      { id: id(3), openedAt: 60 },
      { id: id(9), openedAt: 50 },
    ]);
  });

  it('keeps a key already here: a link’s other key neither replaces it nor joins it', () => {
    const storage = memoryStorage({
      [SESSION_LIST_KEY]: storedList([{ id: id(1), openedAt: 1 }]),
      [ACCESS_KEYS_KEY]: storedKeys([[id(1), key(1)]]),
    });
    const arrival = mergeMove(
      storage,
      data({
        sessions: [
          { id: id(1), openedAt: 1 },
          { id: id(2), openedAt: 2 },
        ],
        keys: [
          [id(1), key(91)],
          [id(2), key(2)],
        ],
      }),
    );

    assert.deepEqual(arrival, { sessions: 2, privateSessions: 2 });
    assert.deepEqual(
      [...loadAccessKeys(storage)],
      [
        [id(2), key(2)],
        [id(1), key(1)],
      ],
    );
    assert.equal(JSON.parse(storage.getItem(ACCESS_KEYS_KEY) ?? '{}').items.length, 2);
  });

  it('keeps the list within 50: new sessions take the room left, private ones first, then the latest', () => {
    const here = Array.from({ length: 46 }, (_, n) => ({ id: id(100 + n), openedAt: 1 + n }));
    const storage = memoryStorage({ [SESSION_LIST_KEY]: storedList(here) });
    const moved = [
      { id: id(1), openedAt: 10_000 },
      { id: id(2), openedAt: 9_000 },
      { id: id(3), openedAt: 8_000 },
      { id: id(4), openedAt: 5 },
      { id: id(5), openedAt: 4 },
      { id: id(6), openedAt: 7_000 },
      // Listed here already: no room needed, and it counts as come.
      { id: id(100), openedAt: 2 },
    ];
    const arrival = mergeMove(
      storage,
      data({
        sessions: moved,
        keys: [
          [id(4), key(4)],
          [id(5), key(5)],
        ],
      }),
    );
    const listed = loadSessionList(storage);

    assert.equal(listed.length, MAX_LISTED_SESSIONS);
    // Every session that was here is still here.
    for (const entry of here) {
      assert.ok(
        listed.some((each) => each.id === entry.id),
        entry.id,
      );
    }
    // The four free places: the two private ones, then the two most recently opened.
    assert.deepEqual(
      listed
        .map((entry) => entry.id)
        .filter((each) => [id(1), id(2), id(3), id(4), id(5), id(6)].includes(each))
        .sort(),
      [id(1), id(2), id(4), id(5)].sort(),
    );
    assert.deepEqual(arrival, { sessions: 5, privateSessions: 2 });
  });

  it('adds no session to a full list, and still counts the ones it holds already', () => {
    const here = Array.from({ length: MAX_LISTED_SESSIONS }, (_, n) => ({
      id: id(n),
      openedAt: n,
    }));
    const storage = memoryStorage({ [SESSION_LIST_KEY]: storedList(here) });
    const before = storage.getItem(SESSION_LIST_KEY);
    const arrival = mergeMove(
      storage,
      data({
        sessions: [
          { id: id(0), openedAt: 0 },
          { id: id(999), openedAt: 1e12 },
        ],
      }),
    );

    assert.deepEqual(arrival, { sessions: 1, privateSessions: 0 });
    assert.equal(storage.getItem(SESSION_LIST_KEY), before);
  });

  it('keeps the keys within 100: new keys take the room left, the listed sessions’ first, none pushed out', () => {
    const here = Array.from({ length: 98 }, (_, n): [string, string] => [
      id(500 + n),
      key(500 + n),
    ]);
    const storage = memoryStorage({ [ACCESS_KEYS_KEY]: storedKeys(here) });

    mergeMove(
      storage,
      data({
        sessions: [{ id: id(3), openedAt: 1 }],
        keys: [
          [id(1), key(1)],
          [id(2), key(2)],
          [id(3), key(3)],
          [id(4), key(4)],
        ],
      }),
    );

    const keys = loadAccessKeys(storage);

    assert.equal(keys.size, MAX_STORED_ACCESS_KEYS);
    for (const [sessionId, value] of here) {
      assert.equal(keys.get(sessionId), value);
    }
    // The listed session's key, then the most recently stored of the rest.
    assert.equal(keys.get(id(3)), key(3));
    assert.equal(keys.get(id(4)), key(4));
    assert.equal(keys.has(id(1)), false);
    assert.equal(keys.has(id(2)), false);
    // Stored as less recent than every key held here, so a later one pushes them out first.
    assert.deepEqual([...keys.keys()].slice(0, 2), [id(3), id(4)]);
  });

  it('stores a key whose session the link does not list, without counting it as a session', () => {
    const storage = memoryStorage();

    assert.deepEqual(mergeMove(storage, data({ keys: [[id(7), key(7)]] })), {
      sessions: 0,
      privateSessions: 0,
    });
    assert.deepEqual([...loadAccessKeys(storage)], [[id(7), key(7)]]);
    assert.deepEqual(loadSessionList(storage), []);
  });

  it('takes the language and each section state only where none is stored', () => {
    const storage = memoryStorage({
      [LANGUAGE_KEY]: '{"v":1,"lang":"en"}',
      [QUEUE_SECTION_KEY]: '{"v":1,"open":true}',
    });

    mergeMove(storage, data({ language: 'ru', queueSection: false, rulesSection: false }));

    assert.equal(storage.getItem(LANGUAGE_KEY), '{"v":1,"lang":"en"}');
    assert.equal(storage.getItem(QUEUE_SECTION_KEY), '{"v":1,"open":true}');
    assert.equal(storage.getItem(RULES_SECTION_KEY), '{"v":1,"open":false}');

    // A value this version did not write is no choice, as the readers say.
    const garbled = memoryStorage({
      [LANGUAGE_KEY]: '{"v":1,"lang":"de"}',
      [RULES_SECTION_KEY]: 'open',
    });

    mergeMove(garbled, data({ language: 'ru', rulesSection: true }));

    assert.equal(garbled.getItem(LANGUAGE_KEY), '{"v":1,"lang":"ru"}');
    assert.equal(garbled.getItem(RULES_SECTION_KEY), '{"v":1,"open":true}');

    // Nothing carried, nothing written.
    const untouched = memoryStorage();

    mergeMove(untouched, data());
    assert.deepEqual(untouched.snapshot(), {});
  });

  it('changes nothing and throws nothing where storage is missing, blocked or full', () => {
    const move = data({
      sessions: [{ id: id(1), openedAt: 1 }],
      keys: [[id(1), key(1)]],
      language: 'ru',
      queueSection: true,
      rulesSection: true,
    });
    const full = memoryStorage(
      { [SESSION_LIST_KEY]: storedList([{ id: id(9), openedAt: 9 }]) },
      { full: true },
    );
    const before = full.snapshot();

    assert.deepEqual(mergeMove(null, move), { sessions: 0, privateSessions: 0 });
    assert.deepEqual(mergeMove(blocked, move), { sessions: 0, privateSessions: 0 });
    assert.deepEqual(mergeMove(full, move), { sessions: 0, privateSessions: 0 });
    assert.deepEqual(full.snapshot(), before);
  });

  it('skips in the stores’ own merges an entry of another shape, whoever calls them', () => {
    const storage = memoryStorage();

    assert.deepEqual(
      mergeMovedSessions(
        storage,
        [
          { id: 'short', openedAt: 1 },
          { id: id(1), openedAt: 1.5 },
          { id: id(2), openedAt: 2 },
          { id: id(2), openedAt: 3 },
        ],
        () => false,
      ),
      new Set([id(2)]),
    );
    assert.deepEqual(loadSessionList(storage), [{ id: id(2), openedAt: 3 }]);
    assert.equal(
      mergeMovedAccessKeys(
        storage,
        [
          ['short', key(1)],
          [id(1), 'short'],
          [id(3), key(3)],
        ],
        () => true,
      ),
      true,
    );
    assert.deepEqual([...loadAccessKeys(storage)], [[id(3), key(3)]]);
    assert.equal(
      mergeMovedSessions(null, [], () => false),
      null,
    );
    assert.equal(
      mergeMovedAccessKeys(undefined, [], () => false),
      false,
    );
  });
});

describe('the address after a move link', () => {
  it('holds no fragment once a link is read, its path and query kept, and adds no history entry', () => {
    const storage = memoryStorage();
    const link = buildMoveLink(
      'https://webhook.qa-tools.ru',
      data({ sessions: [{ id: id(1), openedAt: 1 }], keys: [[id(1), key(1)]] }),
    );
    const bar = addressBar(link);

    assert.deepEqual(takeMoveFromAddress(storage, bar), { sessions: 1, privateSessions: 1 });
    assert.deepEqual(bar.replaced, ['https://webhook.qa-tools.ru/']);

    const elsewhere = addressBar(`https://webhook.qa-tools.ru/ru/?a=1#move=${encodeMove(data())}`);

    takeMoveFromAddress(memoryStorage(), elsewhere);
    assert.deepEqual(elsewhere.replaced, ['https://webhook.qa-tools.ru/ru/?a=1']);
  });

  it('takes a refused link out of the address too, changing no stored value', () => {
    const initial = {
      [SESSION_LIST_KEY]: storedList([{ id: id(9), openedAt: 9 }]),
      [ACCESS_KEYS_KEY]: storedKeys([[id(9), key(9)]]),
      [LANGUAGE_KEY]: '{"v":1,"lang":"en"}',
    };

    for (const encoded of [
      '',
      '%%%',
      btoa('nope').replace(/=+$/, ''),
      fragmentOf({ ...validValue(), v: 2 }).split('#move=')[1] ?? '',
      fragmentOf({ ...validValue(), language: 'de' }).split('#move=')[1] ?? '',
      'A'.repeat(1_000_000),
    ]) {
      const storage = memoryStorage(initial);
      const before = storage.snapshot();
      const bar = addressBar(`https://webhook.qa-tools.ru/#move=${encoded}`);

      assert.equal(takeMoveFromAddress(storage, bar), null);
      assert.deepEqual(bar.replaced, ['https://webhook.qa-tools.ru/']);
      assert.deepEqual(storage.snapshot(), before);
    }
  });

  it('leaves the address alone when it holds no move link', () => {
    for (const href of [
      'https://webhook.qa-tools.ru/',
      `https://webhook.qa-tools.ru/v/${id(1)}#key=${key(1)}`,
    ]) {
      const bar = addressBar(href);

      assert.equal(takeMoveFromAddress(memoryStorage(), bar), null);
      assert.deepEqual(bar.replaced, []);
    }
  });

  it('is never logged: nothing in the module or its banner writes to the console', () => {
    for (const path of ['./move-link.ts', '../components/MoveBanner.tsx', '../main.tsx']) {
      assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), 'utf8'), /console\./, path);
    }
  });
});

/**
 * Issue #345: a move link opened over a session page already shown, only the
 * fragment changing, is `main.tsx`'s to read, by loading the page again. The
 * session page's own `hashchange` reading leaves it in the address for that
 * load (`takeKeyUnlessMove`) rather than taking it out as a fragment it does
 * not know, and reads every other fragment as `takeKeyFromAddress` always has.
 * The address bar here keeps what it was given, as the address is when that
 * load comes, so the two readings run one after the other on it.
 */
describe('a move link opened over a session page (#345)', () => {
  const PAGE = `https://webhook.qa-tools.ru/v/${id(1)}`;
  const REQUEST = '3f2a1b4c-0000-4000-8000-000000000000';

  afterEach(() => {
    releaseAllAccessKeys();
  });

  /** A link's data: two sessions, the first private, a language and a section state. */
  const carried = data({
    sessions: [
      { id: id(1), openedAt: 1_700_000_000_000 },
      { id: id(2), openedAt: 1_700_000_000_001 },
    ],
    keys: [[id(1), key(1)]],
    language: 'ru',
    queueSection: true,
  });

  it('leaves the link in the address, holding and storing nothing, for the reading on arrival', () => {
    const storage = memoryStorage();
    const bar = addressBar(`${PAGE}#move=${encodeMove(carried)}`);

    assert.deepEqual(takeKeyUnlessMove(id(1), storage, bar), { kind: 'move' });
    assert.deepEqual(bar.replaced, []);
    assert.deepEqual(storage.snapshot(), {});
    assert.equal(accessKeyFor(id(1), null), null);
  });

  it('is then read as on a fresh load: the same stores, the same toast, and no fragment left', () => {
    const storage = memoryStorage();
    const bar = addressBar(`${PAGE}#move=${encodeMove(carried)}`);

    takeKeyUnlessMove(id(1), storage, bar);

    // The page loaded again: `main.tsx` reads the address it finds.
    const arrival = takeMoveFromAddress(storage, bar);

    assert.ok(arrival !== null);
    assert.deepEqual(arrival, { sessions: 2, privateSessions: 1 });
    assert.deepEqual(bar.replaced, [PAGE]);

    // The same link followed from the old address, onto the home page.
    const fresh = memoryStorage();
    const home = addressBar(buildMoveLink('https://webhook.qa-tools.ru', carried));

    assert.deepEqual(takeMoveFromAddress(fresh, home), arrival);
    assert.deepEqual(home.replaced, ['https://webhook.qa-tools.ru/']);
    assert.deepEqual(storage.snapshot(), fresh.snapshot());
    assert.deepEqual(loadAccessKeys(storage), new Map([[id(1), key(1)]]));
    assert.deepEqual(
      loadSessionList(storage)
        .map((entry) => entry.id)
        .sort(),
      [id(1), id(2)],
    );
    assert.equal(
      moveArrivedToast(arrival, PRODUCTION)(en),
      'Moved 2 sessions from qa-tools.ru, 1 of them private',
    );
  });

  it('leaves a refused link too, hostile ones at growing sizes, which the reading on arrival takes out changing nothing', () => {
    const initial = {
      [SESSION_LIST_KEY]: storedList([{ id: id(9), openedAt: 9 }]),
      [ACCESS_KEYS_KEY]: storedKeys([[id(9), key(9)]]),
    };

    for (const value of [
      '',
      '%%%',
      `e30&key=${key(1)}`,
      `e30#key=${key(1)}`,
      `${encodeMove(carried)}&key=${key(1)}`,
      'move='.repeat(200_000),
      'A'.repeat(MAX_MOVE_FRAGMENT_LENGTH + 1),
      'A'.repeat(5 * 1024 * 1024),
    ]) {
      const storage = memoryStorage(initial);
      const before = storage.snapshot();
      const bar = addressBar(`${PAGE}#move=${value}`);
      const started = performance.now();

      assert.deepEqual(takeKeyUnlessMove(id(1), storage, bar), { kind: 'move' });
      assert.ok(performance.now() - started < 500, value.slice(0, 40));
      assert.deepEqual(bar.replaced, []);
      assert.equal(accessKeyFor(id(1), null), null);

      assert.equal(takeMoveFromAddress(storage, bar), null);
      assert.deepEqual(bar.replaced, [PAGE]);
      assert.deepEqual(storage.snapshot(), before);
      assert.equal(accessKeyFor(id(1), null), null);
    }
  });

  /** Criterion 3: `#key=` and `#request=` are read as before #345. */
  it('reads every other fragment exactly as takeKeyFromAddress does: the key held, the request id left', () => {
    for (const href of [
      PAGE,
      `${PAGE}#`,
      `${PAGE}#${REQUEST}`,
      buildAccessLink('https://webhook.qa-tools.ru', id(1), key(1)),
      buildAccessLink('https://webhook.qa-tools.ru', id(1), key(1), REQUEST),
      `${PAGE}#key=${key(1)}&request=no-request`,
      `${PAGE}#key=${key(1)}&move=e30`,
      `${PAGE}#request=${REQUEST}&move=e30`,
      `${PAGE}#Move=e30`,
      `${PAGE}#xmove=e30`,
      `${PAGE}#move`,
      `${PAGE}#%6Dove=e30`,
      `${PAGE}?move=e30`,
      `${PAGE}#x`,
    ]) {
      const bar = addressBar(href);
      const outcome = takeKeyUnlessMove(id(1), null, bar);
      const held = accessKeyFor(id(1), null);

      releaseAllAccessKeys();

      const before = addressBar(href);

      assert.deepEqual(outcome, takeKeyFromAddress(id(1), null, before), href);
      assert.deepEqual(bar.replaced, before.replaced, href);
      assert.equal(held, accessKeyFor(id(1), null), href);
      releaseAllAccessKeys();
    }

    const access = addressBar(
      buildAccessLink('https://webhook.qa-tools.ru', id(1), key(1), REQUEST),
    );

    assert.deepEqual(takeKeyUnlessMove(id(1), null, access), {
      kind: 'access',
      key: key(1),
      requestId: REQUEST,
    });
    assert.deepEqual(access.replaced, [`${PAGE}#${REQUEST}`]);
    assert.equal(accessKeyFor(id(1), null), key(1));
  });

  for (const size of [1024, 1024 * 1024, 5 * 1024 * 1024]) {
    it(`takes a key fragment of ${size} characters out as malformed, as before, in bounded time`, () => {
      const bar = addressBar(`${PAGE}#key=${key(1)}${'&'.repeat(size)}`);
      const started = performance.now();

      assert.equal(takeKeyUnlessMove(id(1), null, bar).kind, 'malformed');
      assert.ok(performance.now() - started < 500);
      assert.deepEqual(bar.replaced, [PAGE]);
      assert.equal(accessKeyFor(id(1), null), null);
    });
  }

  it('is wired so (structural guard): the page’s hashchange leaves it, main.tsx reloads for it', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const page = read('../pages/SessionPage.tsx');
    const main = read('../main.tsx');

    // On hashchange the page leaves a move link; before its first load it
    // reads as before - `main.tsx` has taken any move link out by then.
    assert.match(
      page,
      /function onHashChange\(\): void \{\s*if \(takeKeyUnlessMove\(sessionId, browserStorage\(\), addressBar\)\.kind === 'access'\) \{\s*reopen\(\);/,
    );
    assert.match(
      page,
      /useLayoutEffect\(\(\) => \{\s*takeKeyFromAddress\(sessionId, storage, addressBar\);/,
    );
    assert.match(
      main,
      /addEventListener\('hashchange', \(\) => \{\s*if \(holdsMoveFragment\(window\.location\.href\)\) \{\s*window\.location\.reload\(\);/,
    );
    // The arrival's reading runs before the first render, so before any page's.
    assert.ok(main.indexOf('takeMoveFromAddress(storage') < main.indexOf('createRoot(container)'));
  });
});

describe('the arrival toast (T)', () => {
  it('says how many sessions came and how many of them are private, in both languages', () => {
    const toast = (
      sessions: number,
      privateSessions: number,
      move: BuiltMove | null = PRODUCTION,
    ) => moveArrivedToast({ sessions, privateSessions }, move);

    assert.equal(toast(5, 2)(en), 'Moved 5 sessions from qa-tools.ru, 2 of them private');
    assert.equal(toast(5, 2)(ru), 'Перенесено 5 сессий с qa-tools.ru, из них 2 приватные');
    assert.equal(toast(3, 0)(en), 'Moved 3 sessions from qa-tools.ru');
    assert.equal(toast(1, 0)(en), 'Moved 1 session from qa-tools.ru');
    assert.equal(toast(1, 0)(ru), 'Перенесена 1 сессия с qa-tools.ru');
    assert.equal(toast(1, 1)(en), 'Moved 1 private session from qa-tools.ru');
    assert.equal(toast(1, 1)(ru), 'Перенесена 1 приватная сессия с qa-tools.ru');
    assert.equal(toast(2, 1)(ru), 'Перенесено 2 сессии с qa-tools.ru, из них 1 приватная');
    assert.equal(toast(21, 5)(ru), 'Перенесена 21 сессия с qa-tools.ru, из них 5 приватных');
    assert.equal(toast(0, 0)(en), 'Moved 0 sessions from qa-tools.ru');
    assert.equal(toast(0, 0)(ru), 'Перенесено 0 сессий с qa-tools.ru');
    // A build with no move names no old address.
    assert.equal(toast(5, 2, null)(en), 'Moved 5 sessions, 2 of them private');
    assert.equal(toast(5, 2, null)(ru), 'Перенесено 5 сессий, из них 2 приватные');
  });

  it('names the old origin’s host, its port included', () => {
    assert.equal(originHost('https://qa-tools.ru'), 'qa-tools.ru');
    assert.equal(originHost('http://localhost:5173'), 'localhost:5173');
    assert.equal(originHost('not an origin'), 'not an origin');
  });
});

describe('the banner’s visibility by origin', () => {
  it('shows on the old origin of a build that moves, and on no other origin', () => {
    assert.equal(moveBannerShown('https://qa-tools.ru', PRODUCTION), true);

    for (const origin of [
      'https://webhook.qa-tools.ru',
      'https://hook.qa-tools.ru',
      'http://qa-tools.ru',
      'https://qa-tools.ru:8443',
      'https://www.qa-tools.ru',
      'https://qa-tools.ru.example',
      'http://localhost:5173',
      'null',
      '',
    ]) {
      assert.equal(moveBannerShown(origin, PRODUCTION), false, origin);
    }

    // A build with no second origin shows it nowhere, the old origin included.
    assert.equal(moveBannerShown('https://qa-tools.ru', null), false);
  });

  it('has no move outside a Vite build, so the banner shows nowhere in the tests', () => {
    assert.equal(BUILT_MOVE, null);
  });

  it('is drawn on no origin, the old one included, by a bundle built with no move (#346)', async () => {
    const { MoveBanner } = await import('../components/MoveBanner.tsx');

    for (const origin of [PRODUCTION.from, PRODUCTION.to, 'http://localhost:5173']) {
      // The page's origin, for this render only: the rest of the file runs with no window.
      Object.assign(globalThis, { window: { location: { origin } } });

      try {
        assert.equal(renderToStaticMarkup(createElement(MoveBanner)), '', origin);
      } finally {
        delete (globalThis as { window?: unknown }).window;
      }
    }
  });

  it('reads the build’s move as given and refuses anything of another shape', () => {
    assert.deepEqual(parseBuiltMove({ ...PRODUCTION }), PRODUCTION);

    for (const value of [
      null,
      undefined,
      'https://qa-tools.ru',
      [],
      { ...PRODUCTION, from: 1 },
      { ...PRODUCTION, to: null },
      { ...PRODUCTION, day: '1 Dec' },
      { from: PRODUCTION.from, to: PRODUCTION.to },
      Object.create({ ...PRODUCTION }),
    ]) {
      assert.equal(parseBuiltMove(value), null, JSON.stringify(value));
    }
  });

  it('writes day X with the interface’s months, never broken across lines', () => {
    assert.equal(formatMoveDay('2027-03-09', en), '9\u00a0Mar\u00a02027');
    assert.equal(formatMoveDay('2027-03-09', ru), '9\u00a0мар.\u00a02027');
    assert.equal(formatMoveDay('2026-11-30', en), '30\u00a0Nov\u00a02026');
    assert.equal(formatMoveDay('no day', en), 'no day');
  });

  it('cuts the banner’s text around the host, a piece of its own, in both languages (#347)', () => {
    const host = 'webhook.qa-tools.ru';

    for (const [m, day, before, after] of [
      [en, '9\u00a0Mar\u00a02027', 'Webhook Inspector is moving to ', ' on 9\u00a0Mar\u00a02027'],
      [ru, '9\u00a0мар.\u00a02027', 'Webhook Inspector переезжает на ', ' 9\u00a0мар.\u00a02027'],
    ] as const) {
      assert.deepEqual(
        moveNoticePieces(host, (place) => m.move.notice(place, day)),
        [
          { text: before, host: false },
          { text: host, host: true },
          { text: after, host: false },
        ],
        m.lang,
      );
    }
  });

  it('puts the host where the sentence does, whatever it holds, hostile ones at growing sizes (#347)', () => {
    const day = '9\u00a0Mar\u00a02027';
    const notice = (place: string) => en.move.notice(place, day);
    const hosts = [
      // The same letters as the words around it, which a search would find first.
      'e',
      'on',
      'Webhook',
      'is moving to',
      '9',
      ' ',
      '',
      // What a string replacement, a pattern or markup would read as its own.
      '$&',
      "$1$`$'",
      '.*+?^${}()|[]\\',
      '<b>&amp;</b>',
      // The mark itself, which a host never holds: the host is never in the
      // text that is cut, so it stays whole.
      '\u0000',
      'a\u0000\u0000b',
      ...[100, 10_000, 1_000_000].flatMap((size) => [
        'webhook.qa-tools.ru'.repeat(Math.ceil(size / 19)).slice(0, size),
        '\u0000'.repeat(size),
        'on '.repeat(Math.ceil(size / 3)).slice(0, size),
      ]),
    ];

    for (const host of hosts) {
      const pieces = moveNoticePieces(host, notice);
      const label = JSON.stringify(host.slice(0, 20)) + ` (${host.length})`;

      assert.deepEqual(
        pieces.map((piece) => piece.host),
        [false, true, false],
        label,
      );
      assert.equal(pieces[0]?.text, 'Webhook Inspector is moving to ', label);
      assert.equal(pieces[1]?.text, host, label);
      assert.equal(pieces[2]?.text, ` on ${day}`, label);
      assert.equal(pieces.map((piece) => piece.text).join(''), notice(host), label);
    }
  });

  it('gives a sentence that names the host twice, first, last or never, each piece in place, no empty one (#347)', () => {
    const host = 'webhook.qa-tools.ru';
    const text = (words: string) => ({ text: words, host: false });
    const named = { text: host, host: true };

    assert.deepEqual(
      moveNoticePieces(host, (place) => `${place} or ${place}`),
      [named, text(' or '), named],
    );
    assert.deepEqual(
      moveNoticePieces(host, (place) => `${place}${place}`),
      [named, named],
    );
    assert.deepEqual(
      moveNoticePieces(host, (place) => `to ${place}`),
      [text('to '), named],
    );
    assert.deepEqual(
      moveNoticePieces(host, (place) => place),
      [named],
    );
    assert.deepEqual(
      moveNoticePieces(host, () => 'no host here'),
      [text('no host here')],
    );
    assert.deepEqual(
      moveNoticePieces(host, () => ''),
      [],
    );
  });

  it('is drawn by the header every inspector page draws, above it, its link built as it is clicked', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const header = read('../components/AppHeader.tsx');
    const banner = read('../components/MoveBanner.tsx');

    assert.match(header, /<>\s*<MoveBanner \/>\s*<header/);
    for (const page of [
      '../pages/LandingPage.tsx',
      '../pages/SessionPage.tsx',
      '../components/NotFound.tsx',
      '../components/SessionUnavailable.tsx',
    ]) {
      assert.match(read(page), /<AppHeader \/>/, page);
    }

    // Where it shows and what it draws, the action's address included, are
    // rendered: here with no move, in `move-render.test.ts` with one. The
    // link is built as the action is clicked and followed at once, never put
    // in the page.
    assert.match(
      banner,
      /window\.location\.assign\(buildMoveLink\(to, collectMove\(browserStorage\(\)\)\)\)/,
    );
  });
});
