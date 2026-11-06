import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createQueueSectionMemory,
  parseQueueSectionOpen,
  QUEUE_SECTION_KEY,
  queueSectionMemory,
  RULES_SECTION_KEY,
  serializeQueueSectionOpen,
  type QueueSectionStorage,
} from './queue-section-open.ts';

/**
 * The open or closed state of the quick switch's Response queue section
 * (issue #142, D206): collapsed the first time, kept browser-wide in
 * `localStorage`, and kept in memory while the page stays open where storage
 * is unavailable, blocked or full - hostile stored values at growing sizes
 * included.
 */

/** An in-memory `localStorage`, optionally refusing writes as a full one does. */
function memoryStorage(initial: Record<string, string> = {}, options: { full?: boolean } = {}) {
  const items = new Map(Object.entries(initial));
  const writes: string[] = [];

  const storage: QueueSectionStorage & { writes: string[]; raw: () => string | undefined } = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      if (options.full) {
        throw new DOMException('quota', 'QuotaExceededError');
      }

      writes.push(key);
      items.set(key, value);
    },
    writes,
    raw: () => items.get(QUEUE_SECTION_KEY),
  };

  return storage;
}

/** Storage whose every access throws, as a blocked one does. */
const blocked: QueueSectionStorage = {
  getItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
};

describe('the stored format', () => {
  it('is {"v":1,"open":true|false} under qa-tools:queue-section', () => {
    const storage = memoryStorage();
    const memory = createQueueSectionMemory(() => storage);

    assert.equal(QUEUE_SECTION_KEY, 'qa-tools:queue-section');

    memory.remember(true);
    assert.deepEqual(JSON.parse(storage.raw() ?? ''), { v: 1, open: true });

    memory.remember(false);
    assert.deepEqual(JSON.parse(storage.raw() ?? ''), { v: 1, open: false });
    assert.deepEqual(storage.writes, [QUEUE_SECTION_KEY, QUEUE_SECTION_KEY]);
  });

  it('reads back exactly what it writes, and nothing else', () => {
    assert.equal(parseQueueSectionOpen(serializeQueueSectionOpen(true)), true);
    assert.equal(parseQueueSectionOpen(serializeQueueSectionOpen(false)), false);

    for (const raw of [
      null,
      '',
      'true',
      'open',
      '1',
      '{"v":1,"open":"true"}',
      '{"v":2,"open":true}',
      '{"open":true}',
      '{"v":1}',
      '{ "v": 1, "open": true }',
      '{"open":true,"v":1}',
      '[true]',
      '{"v":1,"open":true}garbage',
      ' {"v":1,"open":true}',
    ]) {
      assert.equal(parseQueueSectionOpen(raw), null, String(raw));
    }
  });
});

describe('with storage', () => {
  it('starts collapsed the first time', () => {
    assert.equal(createQueueSectionMemory(() => memoryStorage()).isOpen(), false);
  });

  it('opens as it was last left, in this page and after a reload', () => {
    const storage = memoryStorage();
    const page = createQueueSectionMemory(() => storage);

    page.remember(true);
    // Closing the quick switch, switching Default and Custom, another session:
    // every opening reads the one state again.
    assert.equal(page.isOpen(), true);
    assert.equal(page.isOpen(), true);

    // A reload: a new page over the same storage.
    assert.equal(createQueueSectionMemory(() => storage).isOpen(), true);

    page.remember(false);
    assert.equal(createQueueSectionMemory(() => storage).isOpen(), false);
  });

  it('takes the state another tab left at the next opening', () => {
    const storage = memoryStorage();
    const first = createQueueSectionMemory(() => storage);
    const second = createQueueSectionMemory(() => storage);

    first.remember(true);
    assert.equal(second.isOpen(), true);

    second.remember(false);
    assert.equal(first.isOpen(), false);
  });

  it('reads anything it did not write as collapsed, and replaces it with the next change', () => {
    const storage = memoryStorage({ [QUEUE_SECTION_KEY]: 'open' });
    const memory = createQueueSectionMemory(() => storage);

    assert.equal(memory.isOpen(), false);

    memory.remember(true);
    assert.equal(memory.isOpen(), true);
    assert.equal(storage.raw(), '{"v":1,"open":true}');
  });

  it('keeps no other key', () => {
    const storage = memoryStorage({ 'qa-tools:sessions': 'kept' });

    createQueueSectionMemory(() => storage).remember(true);

    assert.equal(storage.getItem('qa-tools:sessions'), 'kept');
    assert.deepEqual(storage.writes, [QUEUE_SECTION_KEY]);
  });
});

describe('without storage', () => {
  it('is collapsed the first time and kept in memory while the page stays open', () => {
    const page = createQueueSectionMemory(() => null);

    assert.equal(page.isOpen(), false);

    page.remember(true);
    assert.equal(page.isOpen(), true);

    page.remember(false);
    assert.equal(page.isOpen(), false);

    // A reload keeps nothing: collapsed again.
    page.remember(true);
    assert.equal(createQueueSectionMemory(() => null).isOpen(), false);
  });

  it('keeps it in memory where every storage access throws', () => {
    const page = createQueueSectionMemory(() => blocked);

    assert.equal(page.isOpen(), false);
    assert.doesNotThrow(() => page.remember(true));
    assert.equal(page.isOpen(), true);
    assert.equal(createQueueSectionMemory(() => blocked).isOpen(), false);
  });

  it('opens collapsed, with no error, where storage can be written but not read (issue #143)', () => {
    // An artificial case, left unhandled on purpose on 2026-10-18: the state is
    // stored, so it is read back from storage, whose read answers collapsed.
    const items = new Map<string, string>();
    const writeOnly: QueueSectionStorage = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: (key, value) => {
        items.set(key, value);
      },
    };
    const page = createQueueSectionMemory(() => writeOnly);

    assert.doesNotThrow(() => page.remember(true));
    assert.equal(items.get(QUEUE_SECTION_KEY), '{"v":1,"open":true}');
    assert.equal(page.isOpen(), false);
    // A reload: a new page over the same storage.
    assert.equal(createQueueSectionMemory(() => writeOnly).isOpen(), false);
  });

  it('keeps the page own state where storage is full, over the older stored one', () => {
    const storage = memoryStorage(
      { [QUEUE_SECTION_KEY]: serializeQueueSectionOpen(true) },
      { full: true },
    );
    const page = createQueueSectionMemory(() => storage);

    assert.equal(page.isOpen(), true);

    page.remember(false);
    assert.equal(page.isOpen(), false);
    assert.equal(storage.raw(), serializeQueueSectionOpen(true));
  });

  it('goes back to storage once a later state is stored', () => {
    let full = true;
    const items = new Map<string, string>();
    const storage: QueueSectionStorage = {
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        if (full) {
          throw new DOMException('quota', 'QuotaExceededError');
        }

        items.set(key, value);
      },
    };
    const page = createQueueSectionMemory(() => storage);
    const other = createQueueSectionMemory(() => storage);

    page.remember(true);
    assert.equal(page.isOpen(), true);

    full = false;
    page.remember(true);
    other.remember(false);
    // Stored this time, so the state another tab left is read again.
    assert.equal(page.isOpen(), false);
  });

  it('is what the page uses where there is no window, as under Node', () => {
    assert.equal(typeof window, 'undefined');
    assert.equal(queueSectionMemory.isOpen(), false);
    queueSectionMemory.remember(true);
    assert.equal(queueSectionMemory.isOpen(), true);
    queueSectionMemory.remember(false);
    assert.equal(queueSectionMemory.isOpen(), false);
  });
});

describe('hostile stored values', () => {
  // Generous: nothing stored is parsed, so this is a comparison of strings;
  // the bound only catches a parser added later. One shape a parser chokes
  // on and one large near miss of the stored value stand for the rest.
  const LIMIT_MS = 500;

  function readsCollapsedAtOnce(raw: string): void {
    const storage = memoryStorage({ [QUEUE_SECTION_KEY]: raw });
    const started = performance.now();

    assert.equal(createQueueSectionMemory(() => storage).isOpen(), false);
    assert.equal(parseQueueSectionOpen(raw), null);

    const elapsed = performance.now() - started;

    assert.ok(elapsed < LIMIT_MS, `${elapsed.toFixed(1)} ms for ${raw.length} characters`);
  }

  it('reads 64 KiB of nested arrays as collapsed, at once', () => {
    readsCollapsedAtOnce('['.repeat(32 * 1024) + ']'.repeat(32 * 1024));
  });

  it('reads the stored value padded to 4 MiB as collapsed, at once', () => {
    readsCollapsedAtOnce(`{"v":1,"open":true${' '.repeat(4 * 1024 * 1024)}}`);
  });
});

describe('the Response rules section, remembered apart (issue #226)', () => {
  it('keeps its state under qa-tools:rules-section, in the same two values, apart from the queue', () => {
    const storage = memoryStorage();
    const queue = createQueueSectionMemory(() => storage);
    const rules = createQueueSectionMemory(() => storage, RULES_SECTION_KEY);

    assert.equal(RULES_SECTION_KEY, 'qa-tools:rules-section');
    assert.equal(rules.isOpen(), false);

    rules.remember(true);
    assert.equal(storage.getItem(RULES_SECTION_KEY), '{"v":1,"open":true}');
    assert.deepEqual(storage.writes, [RULES_SECTION_KEY]);
    // The queue's section is not opened by the rules' own.
    assert.equal(queue.isOpen(), false);
    assert.equal(createQueueSectionMemory(() => storage, RULES_SECTION_KEY).isOpen(), true);

    queue.remember(true);
    rules.remember(false);
    assert.equal(queue.isOpen(), true);
    assert.equal(rules.isOpen(), false);
    assert.equal(storage.getItem(QUEUE_SECTION_KEY), '{"v":1,"open":true}');
    assert.equal(storage.getItem(RULES_SECTION_KEY), '{"v":1,"open":false}');
  });

  it('reads a hostile value under its key as collapsed, at once', () => {
    const raw = `{"v":1,"open":true${' '.repeat(4 * 1024 * 1024)}}`;
    const storage = memoryStorage({ [RULES_SECTION_KEY]: raw });
    const started = performance.now();

    assert.equal(createQueueSectionMemory(() => storage, RULES_SECTION_KEY).isOpen(), false);
    assert.ok(performance.now() - started < 500);
  });
});
