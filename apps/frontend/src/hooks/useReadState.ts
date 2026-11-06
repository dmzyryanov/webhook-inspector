/**
 * The session page's read state (D014, D078, D156): the requests the viewer
 * has opened, everything else being unread; the ids the session's other tabs
 * in this browser store as opened, taken in as they store them; and the
 * unread count, which the browser tab title shows and nothing else does.
 *
 * The rules are `lib/read-state.ts`'s, which keeps the ids in `localStorage`,
 * and `countUnread`'s. The page marks a request read itself, where it opens
 * one, with the setter this returns and `recordRead`; this holds the set and
 * runs the effects that follow the other tabs and write the title.
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { RequestListItem } from '@webhook-inspector/shared';
import type { Messages } from '../i18n/en.ts';
import { formatDocumentTitle } from '../lib/format.ts';
import {
  addReadIds,
  loadReadIds,
  pruneIdleReadState,
  readIdsFromStorageEvent,
  readStateKey,
  type ReadStateStorage,
} from '../lib/read-state.ts';
import { countUnread } from '../lib/requests.ts';

interface ReadStateOptions {
  /** The page's session, fixed for the page: `App` keys the page by it (D080). */
  sessionId: string;
  /**
   * This browser's `localStorage`, or `null` where it is unavailable, in which
   * case read state stays in this tab, as it did before #46 (D156).
   */
  storage: ReadStateStorage | null;
  /** Every request the list holds: the unread count counts them all, not the filtered rows. */
  requests: readonly RequestListItem[];
  /** Whether the page is showing requests, rather than loading or a notice. */
  showingRequests: boolean;
  /** The words of the language shown, which the tab title is written in (D222). */
  messages: Messages;
}

export interface ReadState {
  /** The ids of the requests opened in this browser; every other request is unread. */
  openedIds: ReadonlySet<string>;
  /**
   * The set's own state setter, the same function for the life of the page,
   * as any `useState` setter is.
   */
  setOpenedIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
}

/** What one session's page has read, and its unread count in the tab title. */
export function useReadState({
  sessionId,
  storage,
  requests,
  showingRequests,
  messages: m,
}: ReadStateOptions): ReadState {
  /**
   * Requests the viewer has opened; everything else is unread (D078). Starts
   * from what this browser's tabs stored for the session and grows by union
   * with what they store later (D156).
   */
  const [openedIds, setOpenedIds] = useState<ReadonlySet<string>>(() =>
    loadReadIds(storage, sessionId),
  );

  /**
   * Read state from the session's other tabs in this browser (D156). Only the
   * read set changes: selection, detail panel and scroll stay as they are. The
   * stored set is read once more after subscribing, so a request opened
   * elsewhere between the first render and this effect is not missed.
   */
  useEffect(() => {
    pruneIdleReadState(storage, sessionId, Date.now());

    if (storage === null) {
      return;
    }

    const key = readStateKey(sessionId);

    // `sessionStorage` fires the same event; only `localStorage` is ours.
    function isThisStorage(event: StorageEvent): boolean {
      try {
        return event.storageArea === storage;
      } catch {
        return false;
      }
    }

    function onStorage(event: StorageEvent): void {
      if (event.key !== key || !isThisStorage(event)) {
        return;
      }

      const ids = readIdsFromStorageEvent(event, sessionId);

      if (ids !== null) {
        setOpenedIds((current) => addReadIds(current, ids));
      }
    }

    window.addEventListener('storage', onStorage);
    setOpenedIds((current) => addReadIds(current, loadReadIds(storage, sessionId)));

    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, [sessionId, storage]);

  // Nothing is waiting to be read on a page that is not showing requests.
  const unreadCount = showingRequests ? countUnread(requests, openedIds) : 0;

  /** The count lives in the browser tab title and nowhere else (D014). */
  useEffect(() => {
    document.title = formatDocumentTitle(unreadCount, m);

    return () => {
      document.title = m.title.base;
    };
  }, [unreadCount, m]);

  return { openedIds, setOpenedIds };
}
