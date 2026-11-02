/**
 * Whether the quick switch's Response queue section is open (issue #142,
 * D206): the section collapses to its heading row, and stays open or closed
 * as the viewer left it.
 *
 * One state for the whole browser, not one per session: closing the quick
 * switch, switching Default and Custom, a reload and another session all keep
 * it. The first time it is collapsed. Kept in `localStorage` under
 * `qa-tools:queue-section` as `{"v":1,"open":true}` or `{"v":1,"open":false}`;
 * nothing here goes through the server, and another browser, profile or
 * private window keeps a state of its own. The move link carries both
 * sections' states from the inspector's old address to its new one, in the
 * fragment no server receives, and the new address takes each only where it
 * stores none (issue #321, D276, `move-link.ts`).
 *
 * **Every storage access is guarded**, as `session-list.ts` guards its own.
 * Where storage is unavailable, blocked or full, the state is kept in memory
 * while the page stays open - across openings of the quick switch and other
 * sessions of the same page - and a reload starts collapsed again. Storage
 * that can be written but not read, an artificial case left unhandled (issue
 * #143), opens the section collapsed, with no error: the state is stored, so
 * it is read back from storage, whose read answers collapsed. A stored
 * value this version did not write reads as collapsed, and the next change
 * replaces it. The state is read as the quick switch opens; a change made in
 * another tab meanwhile is taken at the next opening.
 */
import { browserStorage } from './read-state.ts';

/** The key the Response queue section's state is kept under. */
export const QUEUE_SECTION_KEY = 'qa-tools:queue-section';

/**
 * The key the Response rules section's state is kept under (issue #226): the
 * section under the queue's collapses and is remembered in the same way, on
 * its own, in the same two values. Both are the quick switch's state, the
 * one panel the Privacy Policy says local storage keeps the state of.
 */
export const RULES_SECTION_KEY = 'qa-tools:rules-section';

/** The part of `Storage` this module uses; a fake in the tests. */
export type QueueSectionStorage = Pick<Storage, 'getItem' | 'setItem'>;

const OPEN = JSON.stringify({ v: 1, open: true });
const CLOSED = JSON.stringify({ v: 1, open: false });

/** The stored value for a state. */
export function serializeQueueSectionOpen(open: boolean): string {
  return open ? OPEN : CLOSED;
}

/**
 * The state a stored value holds, or `null` for anything this version did not
 * write. Only the two values `serializeQueueSectionOpen` writes are read, so
 * nothing stored is parsed, whatever its size.
 */
export function parseQueueSectionOpen(raw: string | null): boolean | null {
  if (raw === OPEN) {
    return true;
  }

  return raw === CLOSED ? false : null;
}

/** Where the open state is remembered. */
export interface QueueSectionMemory {
  /** Whether the section opens expanded: as it was last left, collapsed the first time. */
  isOpen(): boolean;
  /** Remembers the state the viewer left the section in. */
  remember(open: boolean): void;
}

/**
 * The memory over a storage, which `storage` hands at each use, `null` where
 * there is none. A state this page could not store is kept here and is what
 * the page reads from then on, until a later one is stored; one it stored is
 * read back from storage, so the state another tab left is what the next
 * opening shows.
 */
export function createQueueSectionMemory(
  storage: () => QueueSectionStorage | null,
  key: string = QUEUE_SECTION_KEY,
): QueueSectionMemory {
  // The state this page set and storage did not keep, or `null`.
  let unstored: boolean | null = null;

  return {
    isOpen() {
      if (unstored !== null) {
        return unstored;
      }

      const store = storage();

      if (store === null) {
        return false;
      }

      try {
        return parseQueueSectionOpen(store.getItem(key)) ?? false;
      } catch {
        // Blocked: collapsed, as the first time.
        return false;
      }
    },

    remember(open) {
      const store = storage();

      if (store !== null) {
        try {
          store.setItem(key, serializeQueueSectionOpen(open));
          unstored = null;

          return;
        } catch {
          // Full or blocked: kept below while the page stays open.
        }
      }

      unstored = open;
    },
  };
}

/** This page's memory of the queue's section, over the browser's `localStorage`. */
export const queueSectionMemory: QueueSectionMemory = createQueueSectionMemory(browserStorage);

/** This page's memory of the rules' section, apart from the queue's (issue #226). */
export const rulesSectionMemory: QueueSectionMemory = createQueueSectionMemory(
  browserStorage,
  RULES_SECTION_KEY,
);
