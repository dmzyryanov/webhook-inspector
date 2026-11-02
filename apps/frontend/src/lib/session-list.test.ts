import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import {
  accessKeyFor,
  accessKeysFor,
  holdAccessKey,
  loadAccessKeys,
  releaseAllAccessKeys,
  storeAccessKey,
} from './access-keys.ts';
import {
  isTimeValue,
  loadSessionList,
  MAX_LISTED_SESSIONS,
  parseSessionList,
  pushOut,
  recordSessionOpened,
  removeListedSessions,
  removeReportedSessions,
  SESSION_LIST_KEY,
  type ListedSession,
  type SessionListStorage,
} from './session-list.ts';

/**
 * The list of the sessions used in this browser (issue #92, D199): joining,
 * reopening, leaving, the cap of 50, and storage that is unavailable, blocked,
 * full or holding something else - hostile values at growing sizes included.
 */

/** A well-formed session id, different for every `n`. */
function id(n: number): string {
  return `S${String(n).padStart(6, '0')}${'k'.repeat(36)}`;
}

/** An in-memory `localStorage`, optionally refusing writes as a full one does. */
function memoryStorage(initial: Record<string, string> = {}, options: { full?: boolean } = {}) {
  const items = new Map(Object.entries(initial));
  const writes: string[] = [];

  const storage: SessionListStorage & { writes: string[]; raw: () => string | undefined } = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      if (options.full) {
        throw new DOMException('quota', 'QuotaExceededError');
      }

      writes.push(key);
      items.set(key, value);
    },
    writes,
    raw: () => items.get(SESSION_LIST_KEY),
  };

  return storage;
}

/** Storage whose every access throws, as a blocked one does. */
const blocked: SessionListStorage = {
  getItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
};

function stored(items: unknown, v: unknown = 1): string {
  return JSON.stringify({ v, items });
}

describe('the stored format', () => {
  it('is {"v":1,"items":[{"id","openedAt"}]} under qa-tools:sessions, the most recently opened first', () => {
    const storage = memoryStorage();

    recordSessionOpened(storage, id(1), 1_000);
    recordSessionOpened(storage, id(2), 2_000);

    assert.equal(SESSION_LIST_KEY, 'qa-tools:sessions');
    assert.deepEqual(JSON.parse(storage.raw() ?? ''), {
      v: 1,
      items: [
        { id: id(2), openedAt: 2_000 },
        { id: id(1), openedAt: 1_000 },
      ],
    });
  });

  it('keeps at most 50 sessions, as many as one status read takes', () => {
    assert.equal(MAX_LISTED_SESSIONS, 50);
  });
});

describe('joining and reopening', () => {
  it('adds a session opened now at the top', () => {
    const storage = memoryStorage();

    assert.deepEqual(recordSessionOpened(storage, id(1), 10), [{ id: id(1), openedAt: 10 }]);
    assert.deepEqual(loadSessionList(storage), [{ id: id(1), openedAt: 10 }]);
  });

  it('moves a session opened again to the top, with its new openedAt, once', () => {
    const storage = memoryStorage();

    recordSessionOpened(storage, id(1), 10);
    recordSessionOpened(storage, id(2), 20);
    recordSessionOpened(storage, id(1), 30);

    assert.deepEqual(loadSessionList(storage), [
      { id: id(1), openedAt: 30 },
      { id: id(2), openedAt: 20 },
    ]);
  });

  it('keeps what another tab stored meanwhile: each change reads the list again', () => {
    const storage = memoryStorage();

    recordSessionOpened(storage, id(1), 10);
    // Another tab writes straight to storage.
    storage.setItem(
      SESSION_LIST_KEY,
      stored([
        { id: id(2), openedAt: 20 },
        { id: id(1), openedAt: 10 },
      ]),
    );
    recordSessionOpened(storage, id(3), 30);

    assert.deepEqual(
      loadSessionList(storage).map((entry) => entry.id),
      [id(3), id(2), id(1)],
    );
  });

  it('drops the least recently opened when a 51st session is opened', () => {
    const storage = memoryStorage();

    for (let n = 0; n < 50; n += 1) {
      recordSessionOpened(storage, id(n), 1_000 + n);
    }

    assert.equal(loadSessionList(storage).length, 50);

    recordSessionOpened(storage, id(50), 5_000);

    const list = loadSessionList(storage);

    assert.equal(list.length, 50);
    assert.equal(list[0]?.id, id(50));
    assert.ok(!list.some((entry) => entry.id === id(0)), 'the least recently opened stayed');
    assert.ok(list.some((entry) => entry.id === id(1)));
  });

  it('reopening a listed session at the cap drops nothing', () => {
    const storage = memoryStorage();

    for (let n = 0; n < 50; n += 1) {
      recordSessionOpened(storage, id(n), 1_000 + n);
    }

    recordSessionOpened(storage, id(0), 9_000);

    const list = loadSessionList(storage);

    assert.equal(list.length, 50);
    assert.equal(list[0]?.id, id(0));
    assert.equal(list.at(-1)?.id, id(1));
  });

  it('lists nothing for an id that cannot be a session', () => {
    const storage = memoryStorage();

    assert.equal(recordSessionOpened(storage, 'not-a-session', 10), null);
    assert.equal(recordSessionOpened(storage, `${id(1)}x`, 10), null);
    assert.deepEqual(storage.writes, []);
  });

  it('writes nothing for an opening at a time no Date can hold', () => {
    const storage = memoryStorage();

    for (const now of [1e20, -1e20, 8.64e15 + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(recordSessionOpened(storage, id(1), now), null, String(now));
    }

    assert.deepEqual(storage.writes, []);
  });
});

describe('leaving the list', () => {
  it('removes the sessions named, and survives a reload', () => {
    const storage = memoryStorage();

    recordSessionOpened(storage, id(1), 10);
    recordSessionOpened(storage, id(2), 20);
    recordSessionOpened(storage, id(3), 30);

    assert.deepEqual(
      removeListedSessions(storage, [id(2)])?.map((entry) => entry.id),
      [id(3), id(1)],
    );
    // A new page reads the same list.
    assert.deepEqual(
      loadSessionList(storage).map((entry) => entry.id),
      [id(3), id(1)],
    );
  });

  it('drops every session a status read reports expired or not found, at once', () => {
    const storage = memoryStorage();

    for (let n = 0; n < 5; n += 1) {
      recordSessionOpened(storage, id(n), n);
    }

    removeListedSessions(storage, new Set([id(0), id(3), id(4)]));

    assert.deepEqual(
      loadSessionList(storage).map((entry) => entry.id),
      [id(2), id(1)],
    );
  });

  it('writes nothing when none of the ids is listed', () => {
    const storage = memoryStorage();

    recordSessionOpened(storage, id(1), 10);
    storage.writes.length = 0;

    assert.deepEqual(removeListedSessions(storage, [id(9)]), [{ id: id(1), openedAt: 10 }]);
    assert.deepEqual(storage.writes, []);
  });

  it('leaves an empty list when the last session goes', () => {
    const storage = memoryStorage();

    recordSessionOpened(storage, id(1), 10);
    removeListedSessions(storage, [id(1)]);

    assert.deepEqual(loadSessionList(storage), []);
    assert.deepEqual(JSON.parse(storage.raw() ?? ''), { v: 1, items: [] });
  });
});

/** A well-formed access key, different for every `n`. */
function key(n: number): string {
  return `K${String(n).padStart(6, '0')}${'q'.repeat(36)}`;
}

/**
 * Criterion 9 of #228 (D259, amending D199): a full list pushes out its
 * least recently opened public session first, and a private one only when
 * every listed session is private, its key with it.
 */
describe('a full list with private sessions', () => {
  afterEach(() => {
    releaseAllAccessKeys();
  });

  /** 50 sessions, `id(0)` the least recently opened; those in `privates` hold keys. */
  function fullList(privates: (n: number) => boolean) {
    const storage = memoryStorage();

    for (let n = 0; n < 50; n += 1) {
      if (privates(n)) {
        storeAccessKey(storage, id(n), key(n));
      }

      recordSessionOpened(storage, id(n), 1_000 + n);
    }

    return storage;
  }

  it('pushes out the least recently opened public session, not an older private one', () => {
    const storage = fullList((n) => n < 3);

    recordSessionOpened(storage, id(50), 5_000);

    const ids = loadSessionList(storage).map((entry) => entry.id);

    assert.equal(ids.length, 50);
    assert.equal(ids[0], id(50));
    assert.ok(ids.includes(id(0)) && ids.includes(id(1)) && ids.includes(id(2)));
    assert.equal(ids.includes(id(3)), false, 'the oldest public session stayed');
    assert.deepEqual(
      [0, 1, 2].map((n) => loadAccessKeys(storage).get(id(n))),
      [key(0), key(1), key(2)],
    );
  });

  it('pushes out the least recently opened private session, and its key, when all are private', () => {
    const storage = fullList(() => true);

    storeAccessKey(storage, id(50), key(50));
    recordSessionOpened(storage, id(50), 5_000);

    const ids = loadSessionList(storage).map((entry) => entry.id);

    assert.equal(ids.length, 50);
    assert.equal(ids.includes(id(0)), false);
    assert.equal(loadAccessKeys(storage).has(id(0)), false, 'the pushed-out key stayed');
    assert.equal(accessKeyFor(id(0), storage), null);
    assert.equal(loadAccessKeys(storage).get(id(1)), key(1));
    assert.equal(loadAccessKeys(storage).get(id(50)), key(50));
  });

  it('keeps every private session over a public one just opened, which is then not listed', () => {
    const storage = fullList(() => true);

    recordSessionOpened(storage, id(50), 5_000);

    const ids = loadSessionList(storage).map((entry) => entry.id);

    assert.equal(ids.length, 50);
    assert.equal(ids.includes(id(50)), false);
    assert.equal(loadAccessKeys(storage).size, 50);
  });

  it('counts a key this tab holds, which storage does not, as private', () => {
    const storage = fullList(() => false);

    holdAccessKey(id(0), key(0));
    recordSessionOpened(storage, id(50), 5_000);

    const ids = loadSessionList(storage).map((entry) => entry.id);

    assert.ok(ids.includes(id(0)));
    assert.equal(ids.includes(id(1)), false);
  });

  it('pushOut keeps a list that fits whole, the most recently opened first', () => {
    const entries = [
      { id: id(1), openedAt: 1 },
      { id: id(2), openedAt: 2 },
    ];

    assert.deepEqual(
      pushOut(entries, () => false),
      {
        kept: [entries[1], entries[0]],
        pushedOut: [],
      },
    );
  });
});

/**
 * Criterion 8 of #228: a session's key leaves with its entry, however it
 * leaves - removed by hand, deleted, or reported gone by the status read.
 */
describe('a private session leaving the list', () => {
  afterEach(() => {
    releaseAllAccessKeys();
  });

  it('takes its key with it, from storage and from this tab, and leaves the others', () => {
    const storage = memoryStorage();

    for (const n of [1, 2, 3]) {
      recordSessionOpened(storage, id(n), n);
      storeAccessKey(storage, id(n), key(n));
    }

    holdAccessKey(id(1), key(1));
    removeListedSessions(storage, [id(1), id(2)]);

    assert.deepEqual(
      loadSessionList(storage).map((entry) => entry.id),
      [id(3)],
    );
    assert.deepEqual([...loadAccessKeys(storage)], [[id(3), key(3)]]);
    assert.equal(accessKeyFor(id(1), storage), null);
  });

  it('forgets a key whose id is not listed, and still writes nothing for an unknown id', () => {
    const storage = memoryStorage();

    storeAccessKey(storage, id(7), key(7));
    removeListedSessions(storage, [id(7)]);
    assert.equal(loadAccessKeys(storage).has(id(7)), false);

    storage.writes.length = 0;
    removeListedSessions(storage, [id(8)]);
    assert.deepEqual(storage.writes, []);
  });

  it('lets go of the key this tab holds even when storage cannot be used', () => {
    holdAccessKey(id(1), key(1));
    removeListedSessions(null, [id(1)]);
    assert.equal(accessKeyFor(id(1), null), null);

    holdAccessKey(id(2), key(2));
    removeListedSessions(blocked, [id(2)]);
    assert.equal(accessKeyFor(id(2), null), null);
  });
});

/**
 * Finding 3 of the outside review of !252: a status read's `not_found` is a
 * verdict on the key it was sent with - a private session read with no key or
 * a wrong one answers `not_found` too (D245 point 6). An answer that arrives
 * after another tab stored the session's right key says nothing of it, and
 * takes neither the entry nor that key off.
 */
describe('removeReportedSessions: a status read judged by the keys it was sent with', () => {
  afterEach(() => {
    releaseAllAccessKeys();
  });

  it('keeps a session whose right key another tab stored after a read sent without one', () => {
    const storage = memoryStorage();

    recordSessionOpened(storage, id(1), 1);
    recordSessionOpened(storage, id(2), 2);

    // The home page sends its read: no key for either.
    const sent = accessKeysFor([id(1), id(2)], storage);

    // Meanwhile another tab opens id(1) by its link with access: its writes
    // reach the storage both tabs share, and nothing of this tab's memory.
    storeAccessKey(storage, id(1), key(1));
    recordSessionOpened(storage, id(1), 3);

    // The read answers both `not_found`.
    assert.deepEqual(removeReportedSessions(storage, [id(1), id(2)], sent), [id(2)]);
    assert.deepEqual(
      loadSessionList(storage).map((entry) => entry.id),
      [id(1)],
    );
    assert.equal(loadAccessKeys(storage).get(id(1)), key(1));
    assert.equal(accessKeyFor(id(1), storage), key(1));
  });

  it('keeps it too when the read was sent with a wrong key this tab held', () => {
    const storage = memoryStorage();

    recordSessionOpened(storage, id(1), 1);
    // A link's wrong key, its page left before the session answered.
    holdAccessKey(id(1), key(9));

    const sent = accessKeysFor([id(1)], storage);

    assert.deepEqual(sent, { [id(1)]: key(9) });

    // Another tab opens it by its right link with access, and stores the key.
    storeAccessKey(storage, id(1), key(1));
    recordSessionOpened(storage, id(1), 3);

    assert.deepEqual(removeReportedSessions(storage, [id(1)], sent), []);
    assert.equal(loadAccessKeys(storage).get(id(1)), key(1));
    assert.equal(accessKeyFor(id(1), storage), key(1));
  });

  it('takes off a session reported with the key it still holds, or with none and holding none, its key with it', () => {
    const storage = memoryStorage();

    for (const n of [1, 2, 3, 4]) {
      recordSessionOpened(storage, id(n), n);
    }

    storeAccessKey(storage, id(1), key(1));
    holdAccessKey(id(3), key(3));

    const sent = accessKeysFor([id(1), id(2), id(3), id(4)], storage);

    // Another tab removed id(4) and its key meanwhile: nothing left to keep.
    removeListedSessions(storage, [id(4)]);

    assert.deepEqual(removeReportedSessions(storage, [id(1), id(2), id(3), id(4)], sent), [
      id(1),
      id(2),
      id(3),
      id(4),
    ]);
    assert.deepEqual(loadSessionList(storage), []);
    assert.equal(loadAccessKeys(storage).size, 0);
    assert.equal(accessKeyFor(id(3), storage), null);
  });

  it('reads a repeated id once, writes nothing for none, and never reads an inherited property as a key', () => {
    const storage = memoryStorage();

    recordSessionOpened(storage, id(1), 1);
    storage.writes.length = 0;
    assert.deepEqual(removeReportedSessions(storage, [], null), []);
    assert.deepEqual(storage.writes, []);
    assert.deepEqual(removeReportedSessions(storage, [id(1), id(1)], null), [id(1)]);
    assert.deepEqual(removeReportedSessions(storage, ['constructor'], {}), ['constructor']);
  });
});

describe('storage that cannot be used', () => {
  it('is no list, with no error, when there is no storage at all', () => {
    assert.deepEqual(loadSessionList(null), []);
    assert.equal(recordSessionOpened(null, id(1), 10), null);
    assert.equal(removeListedSessions(null, [id(1)]), null);
  });

  it('is no list, with no error, when every access throws', () => {
    assert.deepEqual(loadSessionList(blocked), []);
    assert.equal(recordSessionOpened(blocked, id(1), 10), null);
    assert.equal(removeListedSessions(blocked, [id(1)]), null);
  });

  it('keeps the list it has when storage is full, with no error', () => {
    const list = stored([{ id: id(1), openedAt: 10 }]);
    const full = memoryStorage({ [SESSION_LIST_KEY]: list }, { full: true });

    assert.equal(recordSessionOpened(full, id(2), 20), null);
    assert.equal(removeListedSessions(full, [id(1)]), null);
    assert.deepEqual(loadSessionList(full), [{ id: id(1), openedAt: 10 }]);
  });
});

describe('parseSessionList: what a stored value is read as', () => {
  it('is no list for nothing stored, or anything this version did not write', () => {
    for (const raw of [
      null,
      '',
      'not json',
      'null',
      '42',
      '"qa"',
      '[]',
      '{}',
      stored([{ id: id(1), openedAt: 1 }], 2),
      stored([{ id: id(1), openedAt: 1 }], '1'),
      JSON.stringify({ v: 1 }),
      JSON.stringify({ v: 1, items: { 0: { id: id(1), openedAt: 1 } } }),
      JSON.stringify({ v: 1, items: null }),
    ]) {
      assert.deepEqual(parseSessionList(raw), [], String(raw));
    }
  });

  it('skips an entry without a session id or a finite openedAt, and keeps the rest', () => {
    const good: ListedSession = { id: id(1), openedAt: 5 };
    const raw = stored([
      null,
      42,
      'S',
      [id(2), 1],
      { id: id(3) },
      { openedAt: 1 },
      { id: 42, openedAt: 1 },
      { id: 'short', openedAt: 1 },
      { id: `${id(4)} `, openedAt: 1 },
      { id: id(5), openedAt: '1' },
      { id: id(6), openedAt: null },
      { id: id(7), openedAt: Number.POSITIVE_INFINITY },
      good,
    ]);

    assert.deepEqual(parseSessionList(raw), [good]);
    assert.deepEqual(
      parseSessionList(`{"v":1,"items":[{"id":"${id(8)}","openedAt":NaN}]}`),
      [],
      'NaN is not JSON',
    );
  });

  it('skips an openedAt no Date can hold - out of range or a fraction - and keeps the range’s edges', () => {
    const edges: ListedSession[] = [
      { id: id(1), openedAt: 8.64e15 },
      { id: id(2), openedAt: 0 },
      { id: id(3), openedAt: -8.64e15 },
    ];
    const raw = stored([
      { id: id(4), openedAt: 1e20 },
      { id: id(5), openedAt: -1e20 },
      { id: id(6), openedAt: 8.64e15 + 1 },
      { id: id(7), openedAt: -8.64e15 - 1 },
      { id: id(8), openedAt: 1.5 },
      { id: id(9), openedAt: Number.MAX_SAFE_INTEGER },
      { id: id(10), openedAt: 1.7976931348623157e308 },
      ...edges,
    ]);

    assert.deepEqual(parseSessionList(raw), edges);
    // `1e400` is valid JSON and parses to Infinity.
    assert.deepEqual(parseSessionList(`{"v":1,"items":[{"id":"${id(11)}","openedAt":1e400}]}`), []);
  });

  it('isTimeValue: an integer a Date can hold, and nothing else', () => {
    for (const value of [0, 1, -1, 1_759_500_000_000, 8.64e15, -8.64e15]) {
      assert.equal(isTimeValue(value), true, String(value));
      assert.equal(Number.isNaN(new Date(value).getTime()), false);
    }

    for (const value of [
      1e20,
      -1e20,
      8.64e15 + 1,
      -8.64e15 - 1,
      1.5,
      -0.5,
      Number.MAX_SAFE_INTEGER,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '1',
      null,
      undefined,
      10n,
    ]) {
      assert.equal(isTimeValue(value), false, String(value));
    }
  });

  it('keeps one entry per id, its latest opening, and sorts the most recent first', () => {
    const raw = stored([
      { id: id(1), openedAt: 10 },
      { id: id(2), openedAt: 30 },
      { id: id(1), openedAt: 20 },
      { id: id(1), openedAt: 5 },
    ]);

    assert.deepEqual(parseSessionList(raw), [
      { id: id(2), openedAt: 30 },
      { id: id(1), openedAt: 20 },
    ]);
  });

  it('reads no more than 50, the most recently opened', () => {
    const raw = stored(Array.from({ length: 60 }, (_, n) => ({ id: id(n), openedAt: n })));
    const list = parseSessionList(raw);

    assert.equal(list.length, 50);
    assert.equal(list[0]?.id, id(59));
    assert.equal(list.at(-1)?.id, id(10));
  });

  it('ignores keys it does not know, and a __proto__ entry key changes nothing', () => {
    const raw = `{"v":1,"extra":true,"items":[{"id":"${id(1)}","openedAt":1,"__proto__":{"id":"x"},"name":"n"}]}`;

    assert.deepEqual(parseSessionList(raw), [{ id: id(1), openedAt: 1 }]);
    assert.equal(({} as Record<string, unknown>).id, undefined);
  });

  it('accepts an id of the older Base64URL shape, with _ and -', () => {
    const older = 'Au6JqVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2m_-MKss';

    assert.deepEqual(parseSessionList(stored([{ id: older, openedAt: 1 }])), [
      { id: older, openedAt: 1 },
    ]);
  });
});

describe('parseSessionList: hostile values at growing sizes', () => {
  /** localStorage holds about 5 MB per origin; the largest size is more than one key can be. */
  const SIZES = [1024, 64 * 1024, 1024 * 1024, 5 * 1024 * 1024];
  /** Generous; a regression to quadratic time is seconds. */
  const LIMIT_MS = 1500;

  function timed(raw: string): ListedSession[] {
    const started = performance.now();
    const list = parseSessionList(raw);
    const elapsed = performance.now() - started;

    assert.ok(elapsed < LIMIT_MS, `${elapsed.toFixed(1)} ms for ${raw.length} characters`);
    assert.ok(list.length <= MAX_LISTED_SESSIONS);

    return list;
  }

  for (const size of SIZES) {
    it(`reads ${size} characters of entries as at most 50 sessions`, () => {
      const count = Math.floor(size / 64);
      const list = timed(
        stored(Array.from({ length: count }, (_, n) => ({ id: id(n % 999_999), openedAt: n }))),
      );

      assert.equal(list.length, Math.min(50, count));
    });

    it(`reads ${size} characters of one repeated id as one session`, () => {
      const count = Math.floor(size / 64);
      const list = timed(
        stored(Array.from({ length: count }, (_, n) => ({ id: id(1), openedAt: n }))),
      );

      assert.deepEqual(list, [{ id: id(1), openedAt: count - 1 }]);
    });

    it(`reads an id of ${size} characters as nothing`, () => {
      assert.deepEqual(timed(stored([{ id: 'a'.repeat(size), openedAt: 1 }])), []);
      assert.deepEqual(timed(stored([{ id: `${id(1)}${'a'.repeat(size)}`, openedAt: 1 }])), []);
    });

    it(`reads ${size} characters of nesting, garbage or an unclosed value as nothing`, () => {
      const depth = Math.floor(size / 2);

      assert.deepEqual(timed('['.repeat(depth) + ']'.repeat(depth)), []);
      assert.deepEqual(timed(`{"v":1,"items":${'['.repeat(depth)}${']'.repeat(depth)}}`), []);
      assert.deepEqual(timed('\u0000'.repeat(size)), []);
      assert.deepEqual(timed(`{"v":1,"items":[{"id":"${'a'.repeat(size)}`), []);
      assert.deepEqual(timed(stored(Array.from({ length: size / 8 }, () => null))), []);
    });
  }
});

/**
 * A structural guard over the source text of `SessionPage.tsx`, not a test of
 * behaviour: it fails on a harmless rename, and it is kept only because no
 * browser test has a counterpart. E2E-13 shows a session created on the home
 * page and one opened by its link joining the list, and the returning
 * visitor's page drawn before the status read answers, so those are not
 * asserted here; it never opens the page of a session that fails to load,
 * nor one whose key another tab removed while it loaded, which
 * `settleOpenedKey` keeps off the list (D259, #264).
 */
describe('where the list is written (structural guard)', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('the session page records its session in one place, after its load has succeeded', () => {
    const sessionPage = read('../pages/SessionPage.tsx');
    const ready = sessionPage.indexOf("setStatus('ready');\n");
    const recorded = sessionPage.indexOf('recordSessionOpened(storage, sessionId, Date.now());');
    const settled = sessionPage.indexOf(
      'if (settleOpenedKey(storage, sessionId, loadedSession.private)) {',
    );

    assert.ok(
      ready > 0 && recorded > ready,
      'the session page records the session before it has loaded',
    );
    assert.equal(sessionPage.match(/recordSessionOpened\(/g)?.length, 1);
    // Only when the key it opened with is settled: a private session whose key
    // went meanwhile is not listed again.
    assert.ok(settled > ready, 'the session page settles no key after its load');
    assert.match(
      sessionPage,
      /if \(settleOpenedKey\(storage, sessionId, loadedSession\.private\)\) \{\s*recordSessionOpened\(storage, sessionId, Date\.now\(\)\);\s*\}/,
      'the session page records the session outside if (settleOpenedKey(…)) {',
    );
  });
});
