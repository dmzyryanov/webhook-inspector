import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ACCESS_KEYS_KEY,
  accessKeyFor,
  accessKeysFor,
  forgetAccessKeys,
  heldOnlyInThisTab,
  holdAccessKey,
  isAccessKey,
  keepAccessKey,
  loadAccessKeys,
  MAX_STORED_ACCESS_KEYS,
  parseAccessKeys,
  privateSessionIds,
  releaseAccessKey,
  releaseAllAccessKeys,
  releaseRemovedAccessKeys,
  removeAccessKeys,
  removedAccessKeys,
  settleOpenedKey,
  storeAccessKey,
  watchAccessKeyRemovals,
  type AccessKeyStorage,
} from './access-keys.ts';

/**
 * The access keys of private sessions this browser holds (issue #228, D259):
 * their shape, the stored format, holding in the tab, forgetting, and storage
 * that is unavailable, blocked, full or holding something else - hostile
 * values at growing sizes included. A key of the wrong shape is never kept
 * and never sent, so it cannot fail the status read of the whole list.
 */

/** A well-formed session id, different for every `n`. */
function id(n: number): string {
  return `S${String(n).padStart(6, '0')}${'k'.repeat(36)}`;
}

/** A well-formed key, different for every `n`. */
function key(n: number): string {
  return `K${String(n).padStart(6, '0')}${'q'.repeat(36)}`;
}

function memoryStorage(initial: Record<string, string> = {}, options: { full?: boolean } = {}) {
  const items = new Map(Object.entries(initial));
  const writes: string[] = [];

  const storage: AccessKeyStorage & { writes: string[]; raw: () => string | undefined } = {
    getItem: (name) => items.get(name) ?? null,
    setItem: (name, value) => {
      if (options.full) {
        throw new DOMException('quota', 'QuotaExceededError');
      }

      writes.push(name);
      items.set(name, value);
    },
    writes,
    raw: () => items.get(ACCESS_KEYS_KEY),
  };

  return storage;
}

const blocked: AccessKeyStorage = {
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

/**
 * The longest nesting these tests read, 2 MiB (#355, F-26 in flakes.md). V8's
 * JSON.parse builds an array for each `[`, its time growing faster than the
 * length: 5 MiB took up to 1.1 s alone and 2.0 s in a loaded suite, failing
 * the 1.5 s a parse was held to. 2 MiB takes 0.2 s alone, and a scan from
 * each `[` for a `]`, quadratic in the depth, 8 s. Every other hostile value
 * goes on to 5 MiB.
 */
const NESTING_MAX = 2 * 1024 * 1024;

/** `[` then as many `]`, `length` characters in all, at most `NESTING_MAX`. */
function nesting(length: number): string {
  const depth = Math.floor(Math.min(length, NESTING_MAX) / 2);

  return '['.repeat(depth) + ']'.repeat(depth);
}

afterEach(() => {
  releaseAllAccessKeys();
});

describe('isAccessKey: the shape of a key (D245 point 2)', () => {
  it('is 43 characters of A-Z a-z 0-9 _ -', () => {
    assert.equal(isAccessKey(key(1)), true);
    assert.equal(isAccessKey(`${'A'.repeat(41)}_-`), true);
  });

  it('is nothing else', () => {
    for (const value of [
      '',
      key(1).slice(1),
      `${key(1)}a`,
      `${key(1).slice(1)}=`,
      `${key(1).slice(1)}.`,
      `${key(1).slice(1)} `,
      ` ${key(1).slice(1)}`,
      `${key(1).slice(1)}\n`,
      `${key(1).slice(1)}é`,
      'a'.repeat(1024 * 1024),
      null,
      undefined,
      43,
      {},
      [key(1)],
    ]) {
      assert.equal(isAccessKey(value), false, String(value).slice(0, 50));
    }
  });
});

describe('the stored format', () => {
  it('is {"v":1,"items":[{"id","key"}]} under qa-tools:access-keys, the most recently stored last', () => {
    const storage = memoryStorage();

    assert.equal(storeAccessKey(storage, id(1), key(1)), true);
    assert.equal(storeAccessKey(storage, id(2), key(2)), true);
    assert.equal(ACCESS_KEYS_KEY, 'qa-tools:access-keys');
    assert.deepEqual(JSON.parse(storage.raw() ?? ''), {
      v: 1,
      items: [
        { id: id(1), key: key(1) },
        { id: id(2), key: key(2) },
      ],
    });
  });

  it('keeps one key per session, the later, moved to the end', () => {
    const storage = memoryStorage();

    storeAccessKey(storage, id(1), key(1));
    storeAccessKey(storage, id(2), key(2));
    storeAccessKey(storage, id(1), key(3));

    assert.deepEqual(
      [...loadAccessKeys(storage)],
      [
        [id(2), key(2)],
        [id(1), key(3)],
      ],
    );
  });

  it('keeps at most 100, twice the list, the least recently stored going first', () => {
    const storage = memoryStorage();

    assert.equal(MAX_STORED_ACCESS_KEYS, 100);

    for (let n = 0; n < 105; n += 1) {
      storeAccessKey(storage, id(n), key(n));
    }

    const keys = loadAccessKeys(storage);

    assert.equal(keys.size, 100);
    assert.equal(keys.has(id(4)), false);
    assert.equal(keys.get(id(5)), key(5));
    assert.equal(keys.get(id(104)), key(104));
  });

  it('stores nothing for an id or a key of the wrong shape', () => {
    const storage = memoryStorage();

    assert.equal(storeAccessKey(storage, 'short', key(1)), false);
    assert.equal(storeAccessKey(storage, id(1), 'short'), false);
    assert.equal(storeAccessKey(storage, id(1), `${key(1)}x`), false);
    assert.deepEqual(storage.writes, []);
  });
});

describe('removing keys', () => {
  it('removes the keys named and keeps the rest', () => {
    const storage = memoryStorage();

    storeAccessKey(storage, id(1), key(1));
    storeAccessKey(storage, id(2), key(2));
    assert.equal(removeAccessKeys(storage, [id(1), id(9)]), true);
    assert.deepEqual([...loadAccessKeys(storage)], [[id(2), key(2)]]);
  });

  it('writes nothing when none of the ids has a key', () => {
    const storage = memoryStorage();

    storeAccessKey(storage, id(1), key(1));
    storage.writes.length = 0;
    removeAccessKeys(storage, [id(2), id(3)]);
    removeAccessKeys(storage, []);
    assert.deepEqual(storage.writes, []);
  });
});

describe('storage that cannot be used', () => {
  it('is no key, with no error, when there is no storage, every access throws, or it is full', () => {
    const full = memoryStorage({}, { full: true });

    for (const storage of [null, undefined, blocked, full]) {
      assert.deepEqual(loadAccessKeys(storage), new Map());
      assert.equal(storeAccessKey(storage, id(1), key(1)), false);
      // Full storage still reads: with nothing to remove, nothing is written.
      assert.equal(removeAccessKeys(storage, [id(1)]), storage === full);
      assert.equal(accessKeyFor(id(1), storage), null);
      assert.equal(accessKeysFor([id(1)], storage), null);
      assert.deepEqual(privateSessionIds([id(1)], storage), new Set());
      assert.doesNotThrow(() => forgetAccessKeys(storage, [id(1)]));
    }
  });

  /** A link with access still opens its session in that tab (#228). */
  it('still holds a kept key in this tab, which every call then presents', () => {
    keepAccessKey(blocked, id(1), key(1));

    assert.equal(accessKeyFor(id(1), blocked), key(1));
    assert.deepEqual(accessKeysFor([id(1), id(2)], blocked), { [id(1)]: key(1) });
    assert.equal(heldOnlyInThisTab(id(1), blocked), true);
  });
});

describe('the keys this tab holds', () => {
  /**
   * A stored key has opened its session; a held one may be a link's not yet
   * checked. Asked first, a held wrong key would hide the right one another
   * tab stored - and a status read sent with it would take that one off.
   */
  it('are asked after a stored one, and let go of leave the stored one', () => {
    const storage = memoryStorage();

    storeAccessKey(storage, id(1), key(1));
    assert.equal(accessKeyFor(id(1), storage), key(1));
    assert.equal(heldOnlyInThisTab(id(1), storage), false);

    assert.equal(holdAccessKey(id(1), key(2)), true);
    assert.equal(accessKeyFor(id(1), storage), key(1));
    assert.deepEqual(accessKeysFor([id(1)], storage), { [id(1)]: key(1) });
    assert.equal(heldOnlyInThisTab(id(1), storage), false);

    assert.equal(holdAccessKey(id(2), key(2)), true);
    assert.equal(accessKeyFor(id(2), storage), key(2));
    assert.equal(heldOnlyInThisTab(id(2), storage), true);

    releaseAccessKey(id(2));
    assert.equal(accessKeyFor(id(2), storage), null);
    releaseAccessKey(id(1));
    assert.equal(accessKeyFor(id(1), storage), key(1));
  });

  it('holds no value of the wrong shape', () => {
    assert.equal(holdAccessKey(id(1), 'short'), false);
    assert.equal(holdAccessKey('short', key(1)), false);
    assert.equal(accessKeyFor(id(1), null), null);
  });

  it('keepAccessKey stores a key and then no longer holds it; forgetAccessKeys lets go of both', () => {
    const storage = memoryStorage();

    // A link's key, held until its session answers, then kept.
    holdAccessKey(id(1), key(1));
    keepAccessKey(storage, id(1), key(1));
    assert.equal(loadAccessKeys(storage).get(id(1)), key(1));
    assert.equal(accessKeyFor(id(1), storage), key(1));
    assert.equal(accessKeyFor(id(1), null), null, 'a stored key is held in the tab too');
    assert.equal(heldOnlyInThisTab(id(1), storage), false);

    forgetAccessKeys(storage, [id(1)]);
    assert.equal(loadAccessKeys(storage).has(id(1)), false);
    assert.equal(accessKeyFor(id(1), storage), null);

    keepAccessKey(storage, id(2), 'short');
    keepAccessKey(storage, 'short', key(2));
    assert.equal(loadAccessKeys(storage).size, 0);
    assert.equal(accessKeyFor(id(2), null), null);
  });

  it('privateSessionIds names the ids with a key, held or stored, among those asked', () => {
    const storage = memoryStorage();

    storeAccessKey(storage, id(1), key(1));
    holdAccessKey(id(2), key(2));
    storeAccessKey(storage, id(9), key(9));

    assert.deepEqual(privateSessionIds([id(1), id(2), id(3)], storage), new Set([id(1), id(2)]));
  });
});

/**
 * What a load that succeeded does with its key (D259): a private session's is
 * kept and listed, a public session's forgotten, and a private session whose
 * key is gone by then - removed in another tab - neither kept nor listed.
 */
describe('settleOpenedKey: the key of a session that has loaded', () => {
  it('keeps a private session’s key, stored and no longer held, and lists it', () => {
    const storage = memoryStorage();

    holdAccessKey(id(1), key(1));
    assert.equal(settleOpenedKey(storage, id(1), true), true);
    assert.equal(loadAccessKeys(storage).get(id(1)), key(1));
    assert.equal(accessKeyFor(id(1), null), null);
  });

  it('holds it in the tab when storage refuses it, and still lists it', () => {
    holdAccessKey(id(1), key(1));
    assert.equal(settleOpenedKey(blocked, id(1), true), true);
    assert.equal(accessKeyFor(id(1), blocked), key(1));
    assert.equal(heldOnlyInThisTab(id(1), blocked), true);
  });

  it('forgets a key held or stored for a public session, and lists it', () => {
    const storage = memoryStorage();

    storeAccessKey(storage, id(1), key(1));
    holdAccessKey(id(2), key(2));
    assert.equal(settleOpenedKey(storage, id(1), false), true);
    assert.equal(settleOpenedKey(storage, id(2), false), true);
    assert.equal(accessKeyFor(id(1), storage), null);
    assert.equal(accessKeyFor(id(2), storage), null);
  });

  it('lists a session whose answer says nothing of private, an older backend’s, and keeps its key as it is', () => {
    const storage = memoryStorage();

    storeAccessKey(storage, id(1), key(1));
    storage.writes.length = 0;
    assert.equal(settleOpenedKey(storage, id(1), undefined), true);
    assert.equal(settleOpenedKey(storage, id(2), undefined), true);
    assert.deepEqual(storage.writes, []);
    assert.equal(accessKeyFor(id(1), storage), key(1));
  });

  it('neither keeps nor lists a private session whose key this browser no longer holds', () => {
    const storage = memoryStorage();

    storage.writes.length = 0;
    assert.equal(settleOpenedKey(storage, id(1), true), false);
    assert.deepEqual(storage.writes, []);
  });
});

/**
 * A key removed in one tab of this browser is removed in every tab (!252).
 * Two tabs share storage and nothing else;
 * here the module is tab A - its held keys, the storage it reads - and tab B
 * is a write to that same storage, as `Remove from list` there makes it, with
 * the `storage` event the browser fires in tab A for it.
 */
describe('a key removed in another tab', () => {
  function storageEvent(
    storageArea: unknown,
    oldValue: string | null,
    newValue: string | null,
    name: string | null = ACCESS_KEYS_KEY,
  ): Event {
    return Object.assign(new Event('storage'), { key: name, oldValue, newValue, storageArea });
  }

  it('is gone from the tab that opened its session with it: going home and Back opens nothing and stores nothing again', () => {
    const storage = memoryStorage();

    // Tab A opens a link with access: held, then kept once the session opened.
    holdAccessKey(id(1), key(1));
    assert.equal(settleOpenedKey(storage, id(1), true), true);

    // Tab B confirms `Remove from list`.
    removeAccessKeys(storage, [id(1)]);

    // Tab A goes home and Back: its new page asks for the key and has none,
    // and a load that began with it and answers now stores nothing back.
    assert.equal(accessKeyFor(id(1), storage), null);
    assert.equal(accessKeysFor([id(1)], storage), null);
    assert.deepEqual(privateSessionIds([id(1)], storage), new Set());
    storage.writes.length = 0;
    assert.equal(settleOpenedKey(storage, id(1), true), false);
    assert.deepEqual(storage.writes, []);
  });

  it('is let go of by a tab holding it unstored, on the storage event the removal fires there', () => {
    const storage = memoryStorage();
    const tab = new EventTarget();
    const stop = watchAccessKeyRemovals(tab, storage);

    // Tab B opened the link and stored its key; tab A has just opened the same
    // link, its session not answered yet, and holds a link's key B never had.
    storeAccessKey(storage, id(1), key(1));
    storeAccessKey(storage, id(2), key(2));
    holdAccessKey(id(1), key(1));
    holdAccessKey(id(3), key(3));

    const before = storage.raw() ?? null;

    removeAccessKeys(storage, [id(1)]);
    tab.dispatchEvent(storageEvent(storage, before, storage.raw() ?? null));

    assert.equal(accessKeyFor(id(1), storage), null);
    assert.equal(settleOpenedKey(storage, id(1), true), false);
    assert.equal(loadAccessKeys(storage).has(id(1)), false, 'the load answering stored it back');
    assert.equal(accessKeyFor(id(2), storage), key(2));
    assert.equal(accessKeyFor(id(3), storage), key(3));

    stop();
  });

  it('lets go of nothing for an event about anything else', () => {
    const storage = memoryStorage();
    const other = memoryStorage();
    const tab = new EventTarget();
    const stop = watchAccessKeyRemovals(tab, storage);
    const held = stored([{ id: id(1), key: key(1) }]);
    const none = stored([]);

    holdAccessKey(id(1), key(1));

    for (const event of [
      storageEvent(storage, held, none, 'qa-tools:sessions'),
      storageEvent(storage, null, null, null),
      storageEvent(other, held, none),
      storageEvent(null, held, none),
      storageEvent(storage, none, held),
      storageEvent(storage, stored([{ id: id(1), key: key(2) }]), none),
      storageEvent(storage, held, held),
      storageEvent(storage, 'not json', none),
      storageEvent(storage, stored([{ id: id(1), key: key(1) }], 2), none),
    ]) {
      tab.dispatchEvent(event);
      assert.equal(accessKeyFor(id(1), storage), key(1));
    }

    const throwing = {
      key: ACCESS_KEYS_KEY,
      oldValue: held,
      newValue: none,
      get storageArea(): unknown {
        throw new DOMException('denied', 'SecurityError');
      },
    };

    assert.deepEqual(releaseRemovedAccessKeys(throwing, storage), []);
    assert.deepEqual(
      releaseRemovedAccessKeys(
        { key: ACCESS_KEYS_KEY, oldValue: held, newValue: none, storageArea: null },
        null,
      ),
      [],
    );
    assert.equal(accessKeyFor(id(1), storage), key(1));

    stop();
    tab.dispatchEvent(storageEvent(storage, held, none));
    assert.equal(accessKeyFor(id(1), storage), key(1), 'a stopped watch still let go');
  });

  it('removedAccessKeys names each id the old value held and the new one does not, or holds another key for', () => {
    assert.deepEqual(
      [
        ...removedAccessKeys(
          stored([
            { id: id(1), key: key(1) },
            { id: id(2), key: key(2) },
            { id: id(3), key: key(3) },
          ]),
          stored([
            { id: id(2), key: key(2) },
            { id: id(3), key: key(9) },
            { id: id(4), key: key(4) },
          ]),
        ),
      ],
      [
        [id(1), key(1)],
        [id(3), key(3)],
      ],
    );
    assert.deepEqual(
      removedAccessKeys(stored([{ id: id(1), key: key(1) }]), null),
      new Map([[id(1), key(1)]]),
    );
    assert.deepEqual(removedAccessKeys(null, stored([{ id: id(1), key: key(1) }])), new Map());
    assert.deepEqual(removedAccessKeys('garbage', 'garbage'), new Map());
  });

  for (const size of [1024, 1024 * 1024, 5 * 1024 * 1024]) {
    const nested = Math.min(size, NESTING_MAX);

    it(`reads full or garbage old and new values of ${size} characters, and ${nested} of nesting, in bounded time`, () => {
      const full = stored(
        Array.from({ length: Math.floor(size / 100) }, (_, n) => ({
          id: id(n % 999_999),
          key: key(n),
        })),
      );
      const deep = nesting(size);
      const garbage = '\u0000'.repeat(size);
      // The time holds the reads, not the building of the values (#355).
      const started = performance.now();

      assert.ok(removedAccessKeys(full, stored([])).size <= MAX_STORED_ACCESS_KEYS);
      assert.deepEqual(removedAccessKeys(full, full), new Map());
      assert.deepEqual(removedAccessKeys(deep, null), new Map());
      assert.deepEqual(removedAccessKeys(garbage, garbage), new Map());
      // The reads took 1.4 s at most in a loaded suite (#355); a quadratic
      // parse takes 8 s on the nesting and 38 s on each full value.
      assert.ok(performance.now() - started < 5000, `${size} characters took too long`);
    });
  }
});

/**
 * D245 point 5: the status read's `accessKeys` names only
 * ids it asks about, and only values of a key's shape, so one bad stored key
 * never fails the read of the rest of the list (`400` / `1014`).
 */
describe('accessKeysFor: the status read’s accessKeys', () => {
  it('is null when the browser holds no key of the ids, so the body stays { ids }', () => {
    assert.equal(accessKeysFor([id(1), id(2)], memoryStorage()), null);
    assert.equal(accessKeysFor([], memoryStorage()), null);
  });

  it('names only the ids asked about, never another session’s key', () => {
    const storage = memoryStorage();

    storeAccessKey(storage, id(1), key(1));
    storeAccessKey(storage, id(5), key(5));

    assert.deepEqual(accessKeysFor([id(1), id(2)], storage), { [id(1)]: key(1) });
  });

  it('never sends a stored key of the wrong shape, nor an id of the wrong shape', () => {
    const storage = memoryStorage({
      [ACCESS_KEYS_KEY]: stored([
        { id: id(1), key: 'too-short' },
        { id: id(2), key: `${key(2)}x` },
        { id: id(3), key: key(3) },
        { id: 'not-an-id', key: key(4) },
        { id: '__proto__', key: key(5) },
      ]),
    });

    const keys = accessKeysFor([id(1), id(2), id(3), 'not-an-id', '__proto__'], storage);

    assert.deepEqual(keys, { [id(3)]: key(3) });
    assert.equal(Object.getPrototypeOf(keys), Object.prototype);

    for (const value of Object.values(keys ?? {})) {
      assert.equal(isAccessKey(value), true);
    }
  });
});

describe('parseAccessKeys: what a stored value is read as', () => {
  it('is no key for nothing stored, or anything this version did not write', () => {
    for (const raw of [
      null,
      '',
      'not json',
      'null',
      '[]',
      '42',
      '"text"',
      stored([{ id: id(1), key: key(1) }], 2),
      stored([{ id: id(1), key: key(1) }], '1'),
      JSON.stringify({ v: 1, items: { id: id(1), key: key(1) } }),
      JSON.stringify({ v: 1 }),
    ]) {
      assert.deepEqual(parseAccessKeys(raw), new Map(), String(raw));
    }
  });

  it('skips an entry without a session id or a key of its shape, and keeps the rest', () => {
    assert.deepEqual(
      [
        ...parseAccessKeys(
          stored([
            null,
            7,
            'x',
            [],
            {},
            { id: id(1) },
            { key: key(1) },
            { id: id(1), key: 43 },
            { id: id(1), key: null },
            { id: 1, key: key(1) },
            { id: id(2), key: key(2) },
          ]),
        ),
      ],
      [[id(2), key(2)]],
    );
  });
});

describe('parseAccessKeys: hostile values at growing sizes', () => {
  const SIZES = [1024, 64 * 1024, 1024 * 1024, 5 * 1024 * 1024];
  /** Nesting stops at 2 MiB, not 5 (`NESTING_MAX`). */
  const NESTING_SIZES = [1024, 64 * 1024, 1024 * 1024, NESTING_MAX];
  /**
   * Generous: in loaded suites the two parses of the 2 MiB nesting test took
   * 1.3 s together at most (#355), while a quadratic parse takes 8 s on 2 MiB
   * of nesting and 38 s on 5 MiB of entries.
   */
  const LIMIT_MS = 3000;

  function timed(raw: string): Map<string, string> {
    const started = performance.now();
    const keys = parseAccessKeys(raw);
    const elapsed = performance.now() - started;

    assert.ok(elapsed < LIMIT_MS, `${elapsed.toFixed(1)} ms for ${raw.length} characters`);
    assert.ok(keys.size <= MAX_STORED_ACCESS_KEYS);

    for (const value of keys.values()) {
      assert.equal(isAccessKey(value), true);
    }

    return keys;
  }

  for (const size of SIZES) {
    it(`reads ${size} characters of entries as at most 100 keys`, () => {
      const count = Math.floor(size / 100);
      const keys = timed(
        stored(Array.from({ length: count }, (_, n) => ({ id: id(n % 999_999), key: key(n) }))),
      );

      assert.equal(keys.size, Math.min(100, count));
    });

    it(`reads ${size} characters of one repeated id as its last key`, () => {
      const count = Math.floor(size / 100);
      const keys = timed(
        stored(Array.from({ length: count }, (_, n) => ({ id: id(1), key: key(n) }))),
      );

      assert.deepEqual([...keys], [[id(1), key(count - 1)]]);
    });

    it(`reads a key or an id of ${size} characters as nothing`, () => {
      assert.deepEqual(timed(stored([{ id: id(1), key: 'a'.repeat(size) }])), new Map());
      assert.deepEqual(timed(stored([{ id: 'a'.repeat(size), key: key(1) }])), new Map());
    });

    it(`reads ${size} characters of garbage or an unclosed value as nothing`, () => {
      assert.deepEqual(timed('\u0000'.repeat(size)), new Map());
      assert.deepEqual(timed(`{"v":1,"items":[{"id":"${'a'.repeat(size)}`), new Map());
    });
  }

  for (const size of NESTING_SIZES) {
    it(`reads ${size} characters of nesting as nothing`, () => {
      assert.deepEqual(timed(nesting(size)), new Map());
      assert.deepEqual(timed(`{"v":1,"items":${nesting(size)}}`), new Map());
    });
  }
});
