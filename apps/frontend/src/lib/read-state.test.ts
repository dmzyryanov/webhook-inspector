import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addReadIds,
  filterKey,
  loadFilter,
  loadReadIds,
  MAX_STORED_READ_IDS,
  pruneIdleReadState,
  pruneReadState,
  READ_STATE_IDLE_MS,
  readIdsFromStorageEvent,
  readStateKey,
  recordRead,
  saveFilter,
  type ReadStateStorage,
} from './read-state.ts';

const SESSION = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';
const OTHER_SESSION = 'x'.repeat(43);
const T0 = Date.UTC(2026, 8, 25, 8, 0, 0);

interface StorageEventLike {
  key: string | null;
  newValue: string | null;
}

/**
 * A `localStorage` of one browser. `events` records what a `storage` event in
 * the *other* tabs would carry for each write, the way a browser dispatches it.
 */
class FakeStorage implements ReadStateStorage {
  readonly items = new Map<string, string>();
  readonly events: StorageEventLike[] = [];
  failWrites = false;

  get length(): number {
    return this.items.size;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new DOMException('quota', 'QuotaExceededError');
    }

    this.items.set(key, value);
    this.events.push({ key, newValue: value });
  }

  removeItem(key: string): void {
    this.items.delete(key);
    this.events.push({ key, newValue: null });
  }
}

/** Storage that throws on every access, as a blocked one does. */
const THROWING: ReadStateStorage = {
  get length(): number {
    throw new DOMException('blocked', 'SecurityError');
  },
  key() {
    throw new DOMException('blocked', 'SecurityError');
  },
  getItem() {
    throw new DOMException('blocked', 'SecurityError');
  },
  setItem() {
    throw new DOMException('blocked', 'SecurityError');
  },
  removeItem() {
    throw new DOMException('blocked', 'SecurityError');
  },
};

describe('recordRead and loadReadIds', () => {
  it('stores opened ids per session under a key naming the session', () => {
    const storage = new FakeStorage();

    recordRead(storage, SESSION, 'r1', T0);
    recordRead(storage, SESSION, 'r2', T0 + 1);

    assert.deepEqual([...loadReadIds(storage, SESSION)].sort(), ['r1', 'r2']);
    assert.equal(readStateKey(SESSION), `qa-tools:read:${SESSION}`);
    assert.ok(storage.getItem(`qa-tools:read:${SESSION}`));
  });

  it('keeps sessions apart (criterion 3)', () => {
    const storage = new FakeStorage();

    recordRead(storage, SESSION, 'r1', T0);

    assert.equal(loadReadIds(storage, OTHER_SESSION).size, 0);
  });

  it('merges by union: ids another tab stored meanwhile are kept', () => {
    const storage = new FakeStorage();

    recordRead(storage, SESSION, 'from-a', T0);
    recordRead(storage, SESSION, 'from-b', T0 + 1);
    recordRead(storage, SESSION, 'from-a', T0 + 2);

    assert.deepEqual([...loadReadIds(storage, SESSION)].sort(), ['from-a', 'from-b']);
  });

  it('reads an unreadable or foreign value as nothing opened', () => {
    const storage = new FakeStorage();

    storage.items.set(readStateKey(SESSION), 'not json');
    assert.equal(loadReadIds(storage, SESSION).size, 0);

    storage.items.set(readStateKey(SESSION), JSON.stringify({ v: 2, usedAt: T0, opened: {} }));
    assert.equal(loadReadIds(storage, SESSION).size, 0);

    // A later write replaces it with a valid entry.
    recordRead(storage, SESSION, 'r1', T0);
    assert.deepEqual([...loadReadIds(storage, SESSION)], ['r1']);
  });

  it('keeps at most 1000 ids, the most recently opened (D006)', () => {
    const storage = new FakeStorage();

    for (let index = 0; index < MAX_STORED_READ_IDS + 5; index += 1) {
      recordRead(storage, SESSION, `r${index}`, T0 + index);
    }

    const ids = loadReadIds(storage, SESSION);

    assert.equal(MAX_STORED_READ_IDS, 1000);
    assert.equal(ids.size, MAX_STORED_READ_IDS);
    assert.equal(ids.has('r0'), false);
    assert.equal(ids.has('r4'), false);
    assert.equal(ids.has('r5'), true);
    assert.equal(ids.has(`r${MAX_STORED_READ_IDS + 4}`), true);
  });
});

describe('pruneReadState', () => {
  it('drops an id opened before the load started that the list no longer holds', () => {
    const storage = new FakeStorage();

    recordRead(storage, SESSION, 'deleted', T0);
    recordRead(storage, SESSION, 'kept', T0);

    pruneReadState(storage, SESSION, ['kept', 'unopened'], T0 + 10, T0 + 20);

    assert.deepEqual([...loadReadIds(storage, SESSION)], ['kept']);
  });

  it('keeps an id opened after the load started, though the list lacks it (criterion 2)', () => {
    const storage = new FakeStorage();

    // Tab B starts its list load; the request arrives and tab A opens it before
    // B's answer, which does not contain it, comes back.
    const loadStartedAt = T0;

    recordRead(storage, SESSION, 'new', T0 + 5);
    pruneReadState(storage, SESSION, [], loadStartedAt, T0 + 10);

    assert.deepEqual([...loadReadIds(storage, SESSION)], ['new']);
  });

  it('creates no entry for a session never opened', () => {
    const storage = new FakeStorage();

    pruneReadState(storage, SESSION, ['r1'], T0, T0);

    assert.equal(storage.length, 0);
  });
});

describe('pruneIdleReadState', () => {
  it('removes entries unused for longer than a session lives, and unreadable ones', () => {
    const storage = new FakeStorage();

    recordRead(storage, OTHER_SESSION, 'old', T0);
    recordRead(storage, 'y'.repeat(43), 'recent', T0 + READ_STATE_IDLE_MS);
    storage.items.set(readStateKey('z'.repeat(43)), 'broken');
    storage.items.set('unrelated', 'left alone');

    pruneIdleReadState(storage, SESSION, T0 + READ_STATE_IDLE_MS + 1);

    assert.equal(storage.getItem(readStateKey(OTHER_SESSION)), null);
    assert.equal(storage.getItem(readStateKey('z'.repeat(43))), null);
    assert.ok(storage.getItem(readStateKey('y'.repeat(43))));
    assert.equal(storage.getItem('unrelated'), 'left alone');
  });

  it('leaves the session the page shows alone', () => {
    const storage = new FakeStorage();

    recordRead(storage, SESSION, 'r1', T0);

    pruneIdleReadState(storage, SESSION, T0 + 2 * READ_STATE_IDLE_MS);

    assert.deepEqual([...loadReadIds(storage, SESSION)], ['r1']);
  });

  it('counts a list load as use', () => {
    const storage = new FakeStorage();

    recordRead(storage, OTHER_SESSION, 'r1', T0);
    pruneReadState(storage, OTHER_SESSION, ['r1'], T0, T0 + READ_STATE_IDLE_MS);

    pruneIdleReadState(storage, SESSION, T0 + READ_STATE_IDLE_MS + 1);

    assert.deepEqual([...loadReadIds(storage, OTHER_SESSION)], ['r1']);
  });
});

describe('the list filter (D180)', () => {
  it('is kept per session and restored', () => {
    const storage = new FakeStorage();

    saveFilter(storage, SESSION, 'POST stripe', T0);

    assert.equal(loadFilter(storage, SESSION), 'POST stripe');
    assert.equal(loadFilter(storage, OTHER_SESSION), '');
    assert.equal(filterKey(SESSION), `qa-tools:filter:${SESSION}`);
  });

  it('is removed when cleared or blank', () => {
    const storage = new FakeStorage();

    saveFilter(storage, SESSION, 'stripe', T0);
    saveFilter(storage, SESSION, '  ', T0 + 1);

    assert.equal(storage.getItem(filterKey(SESSION)), null);
    assert.equal(loadFilter(storage, SESSION), '');
  });

  it('reads an unreadable entry as no filter', () => {
    const storage = new FakeStorage();

    storage.items.set(filterKey(SESSION), 'broken');
    assert.equal(loadFilter(storage, SESSION), '');
    storage.items.set(filterKey(SESSION), JSON.stringify({ v: 2, usedAt: T0, query: 'x' }));
    assert.equal(loadFilter(storage, SESSION), '');
  });

  it('is dropped when unused for longer than a session lives', () => {
    const storage = new FakeStorage();

    saveFilter(storage, OTHER_SESSION, 'old', T0);
    saveFilter(storage, 'y'.repeat(43), 'recent', T0 + READ_STATE_IDLE_MS);
    saveFilter(storage, SESSION, 'current', T0);

    pruneIdleReadState(storage, SESSION, T0 + READ_STATE_IDLE_MS + 1);

    assert.equal(loadFilter(storage, OTHER_SESSION), '');
    assert.equal(loadFilter(storage, 'y'.repeat(43)), 'recent');
    assert.equal(loadFilter(storage, SESSION), 'current');
  });

  it('is dropped together with the session read state', () => {
    const storage = new FakeStorage();

    recordRead(storage, OTHER_SESSION, 'r1', T0);
    saveFilter(storage, OTHER_SESSION, 'stripe', T0 + READ_STATE_IDLE_MS);

    pruneIdleReadState(storage, SESSION, T0 + READ_STATE_IDLE_MS + 1);

    assert.deepEqual([...loadReadIds(storage, OTHER_SESSION)], []);
    assert.equal(loadFilter(storage, OTHER_SESSION), '');
  });

  it('belongs to the tab alone where storage is missing, blocked or full', () => {
    const full = new FakeStorage();

    full.failWrites = true;

    assert.doesNotThrow(() => saveFilter(null, SESSION, 'x', T0));
    assert.doesNotThrow(() => saveFilter(THROWING, SESSION, 'x', T0));
    assert.doesNotThrow(() => saveFilter(full, SESSION, 'x', T0));
    assert.equal(loadFilter(null, SESSION), '');
    assert.equal(loadFilter(THROWING, SESSION), '');
    assert.equal(loadFilter(full, SESSION), '');
  });
});

describe('guarded storage (criterion 6)', () => {
  it('never throws when storage is missing or blocked', () => {
    for (const storage of [null, THROWING]) {
      assert.equal(loadReadIds(storage, SESSION).size, 0);
      assert.doesNotThrow(() => recordRead(storage, SESSION, 'r1', T0));
      assert.doesNotThrow(() => pruneReadState(storage, SESSION, [], T0, T0));
      assert.doesNotThrow(() => pruneIdleReadState(storage, SESSION, T0));
    }
  });

  it('never throws when storage is full, and keeps what was stored', () => {
    const storage = new FakeStorage();

    recordRead(storage, SESSION, 'r1', T0);
    storage.failWrites = true;

    assert.doesNotThrow(() => recordRead(storage, SESSION, 'r2', T0 + 1));
    assert.deepEqual([...loadReadIds(storage, SESSION)], ['r1']);
  });
});

describe('addReadIds', () => {
  it('adds new ids and returns the same set when nothing is new', () => {
    const current = new Set(['a']);

    assert.equal(addReadIds(current, ['a']), current);
    assert.deepEqual([...addReadIds(current, ['a', 'b'])].sort(), ['a', 'b']);
    assert.deepEqual([...current], ['a']);
  });
});

describe('two tabs of one browser', () => {
  /** A tab's read set, fed by the storage events other tabs cause. */
  function openTab(storage: FakeStorage, sessionId: string) {
    let openedIds: ReadonlySet<string> = loadReadIds(storage, sessionId);

    return {
      get openedIds() {
        return openedIds;
      },
      open(id: string, now: number) {
        openedIds = addReadIds(openedIds, [id]);
        recordRead(storage, sessionId, id, now);
      },
      receive(event: StorageEventLike) {
        const ids = readIdsFromStorageEvent(event, sessionId);

        if (ids !== null) {
          openedIds = addReadIds(openedIds, ids);
        }
      },
    };
  }

  it('a request opened in A becomes read in B on the storage event (criteria 1, 2)', () => {
    const storage = new FakeStorage();
    const a = openTab(storage, SESSION);
    const b = openTab(storage, SESSION);

    a.open('r1', T0);
    // 'r2' has not reached B's list; it is read there as soon as it does.
    a.open('r2', T0 + 1);

    const before = b.openedIds;

    for (const event of storage.events) {
      b.receive(event);
    }

    assert.deepEqual([...b.openedIds].sort(), ['r1', 'r2']);
    assert.deepEqual([...before], []);
  });

  it('A receiving its own write back changes nothing', () => {
    const storage = new FakeStorage();
    const a = openTab(storage, SESSION);

    a.open('r1', T0);

    const before = a.openedIds;

    a.receive(storage.events[0] as StorageEventLike);
    assert.equal(a.openedIds, before);
  });

  it('a tab on another session is unaffected (criterion 3)', () => {
    const storage = new FakeStorage();
    const a = openTab(storage, SESSION);
    const other = openTab(storage, OTHER_SESSION);

    a.open('r1', T0);

    for (const event of storage.events) {
      other.receive(event);
    }

    assert.equal(other.openedIds.size, 0);
  });

  it('a tab opened later, or a reload, starts from what was opened (criterion 4)', () => {
    const storage = new FakeStorage();

    openTab(storage, SESSION).open('r1', T0);

    assert.deepEqual([...openTab(storage, SESSION).openedIds], ['r1']);
  });

  it('a removal event, or a key of another kind, is ignored', () => {
    const storage = new FakeStorage();
    const b = openTab(storage, SESSION);

    b.receive({ key: readStateKey(SESSION), newValue: null });
    b.receive({ key: null, newValue: null });
    b.receive({ key: 'unrelated', newValue: '{}' });

    assert.equal(b.openedIds.size, 0);
  });
});
