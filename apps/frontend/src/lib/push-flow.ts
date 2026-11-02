/**
 * The session page below 1024 px: the push flow, and the one history entry it
 * adds so that Back returns from an open request to the list (D157).
 *
 * At 1024 px and wider the page is the split layout it has always been: the
 * list beside the open request, and no history entry for a selection. Below
 * that, the list is the page's home screen and an open request covers it,
 * under a Back bar. Which of the two a narrow page shows needs nothing but the
 * selection, so the selection stays component state and the address never
 * changes with it. A request link's fragment is read once on load and then
 * removed, and a request it opens opens here as a tapped row does (D182).
 *
 * Everything here is pure. `SessionPage` owns the state, and
 * `usePushFlowHistory` is the only code that touches `window.history`.
 */
import { en, type Messages } from '../i18n/en.ts';

/** Which layout the page is in: side by side at 1024 px and up, pushed below. */
export type SessionLayout = 'split' | 'push';

/** What the push flow shows: the list, or the request that is open. */
export type PushView = 'list' | 'detail';

/**
 * The list when nothing is open and the request when something is.
 *
 * "Nothing is open" is the same state as the desktop's `No request selected`:
 * closing the request by Back, and the request going away on its own - deleted
 * here or in another tab, `Delete all`, a request the server no longer has -
 * all clear the selection, so all of them land on the list.
 */
export function pushView(selectedId: string | null): PushView {
  return selectedId === null ? 'list' : 'detail';
}

/**
 * The key this page sets in `history.state` on the entry it pushes for an open
 * request. The entry has the page's own address: only this marker tells it
 * from the list's entry beneath it.
 */
export const OPEN_REQUEST_ENTRY = 'webhookInspectorOpenRequest';

/**
 * The key a page before 1.18.2 set instead (D278). A tab opened before the
 * deployment keeps its history: an entry pushed then still carries this one,
 * and it is still this page's, so Back still closes the request.
 */
export const OPEN_REQUEST_ENTRY_BEFORE_RENAME = 'qaToolsOpenRequest';

/** Whether a `history.state` is the entry this page pushed for an open request. */
export function isOpenRequestEntry(state: unknown): boolean {
  return (
    isRecord(state) &&
    (state[OPEN_REQUEST_ENTRY] === true || state[OPEN_REQUEST_ENTRY_BEFORE_RENAME] === true)
  );
}

/**
 * The state for the pushed entry: the current one, with the marker added.
 *
 * The router's own fields (`usr`, `key`, `idx`) are carried over unchanged, so
 * a Back onto the list's entry is, to the router, a return to the address it
 * already shows, and it re-renders nothing but the same page.
 */
export function openRequestEntryState(current: unknown): Record<string, unknown> {
  return { ...(isRecord(current) ? current : {}), [OPEN_REQUEST_ENTRY]: true };
}

/** What the page knows when it decides whether history has to change. */
export interface HistoryInput {
  layout: SessionLayout;
  /**
   * The request that is open, or `null`. A page that is not showing requests
   * - loading, `Session not found`, the error screen - has nothing open.
   */
  openId: string | null;
  /** Whether the entry on top of the tab's history is this page's pushed one. */
  entryOnTop: boolean;
  /** A `history.back()` this page asked for has not arrived yet. */
  backPending: boolean;
}

/**
 * - `push`: add the open request's entry, so the next Back comes back here;
 * - `back`: take this page's entry off again, with nothing open to return from;
 * - `none`: history is as it should be.
 */
export type HistoryStep = 'push' | 'back' | 'none';

/**
 * The one rule the history follows: **the pushed entry is on top exactly while
 * a request is open in the push flow**, with two allowances the browser forces.
 *
 * - A request opened in the push layout, or open when the page crosses into it
 *   (a tablet rotated to portrait), gets the entry, so Back closes it.
 * - An entry with nothing open is taken off at once. That is what leaves no
 *   dead Back press behind when the request closes on its own - deleted, here
 *   or elsewhere, `Delete all`, not found - and it also clears an entry the
 *   page finds on top when it starts: after a reload, which shows the list
 *   (the selection is not stored), or on a Forward onto it.
 * - An entry is **never** added in the split layout: the desktop keeps today's
 *   Back, which leaves the session. One pushed earlier stays when the page
 *   crosses into the split layout (a tablet rotated to landscape), because an
 *   entry can only be removed by going back to the one beneath it. Back then
 *   closes the request, and the next leaves.
 * - Nothing is decided while a Back this page asked for is in flight, so it is
 *   never asked for twice.
 */
export function historyStep({
  layout,
  openId,
  entryOnTop,
  backPending,
}: HistoryInput): HistoryStep {
  if (backPending) {
    return 'none';
  }

  if (entryOnTop && openId === null) {
    return 'back';
  }

  if (!entryOnTop && openId !== null && layout === 'push') {
    return 'push';
  }

  return 'none';
}

/**
 * Whether a history traversal is the viewer's Back out of an open request: the
 * page's entry was on top, it no longer is, and a request is still open. The
 * page then closes the request - it does not ask for another Back.
 *
 * A traversal the page asked for itself (`ownBack`) closes nothing: it took
 * the entry off because nothing was open, and a request opened while it was on
 * its way is a new opening, which gets an entry of its own.
 */
export function closesOnTraversal({
  wasOnTop,
  isOnTop,
  openId,
  ownBack,
}: {
  wasOnTop: boolean;
  isOnTop: boolean;
  openId: string | null;
  ownBack: boolean;
}): boolean {
  return !ownBack && wasOnTop && !isOnTop && openId !== null;
}

/**
 * `2 of 4`: where the open request stands in the list as it is ordered now,
 * counted from 1, and how many the list holds. `null` when the list does not
 * hold the request: for the moment between its deletion and the page closing
 * it, and for good when newer requests push it out of the newest 1000 while it
 * is open. Nothing closes it then - the panel keeps showing what it loaded, as
 * the desktop's does - and the Back bar shows no position.
 */
export function formatOpenPosition(
  requests: readonly { id: string }[],
  openId: string | null,
  m: Messages = en,
): string | null {
  if (openId === null) {
    return null;
  }

  const index = requests.findIndex((item) => item.id === openId);

  return index === -1 ? null : m.push.position(index + 1, requests.length);
}

/**
 * How many requests in the list arrived after the open request was opened:
 * those the list did not hold at that moment. A request that arrived and was
 * deleted again is no longer counted, and neither is one the list already held,
 * however new it is.
 */
export function countArrivedSince(
  requests: readonly { id: string }[],
  knownWhenOpened: ReadonlySet<string>,
): number {
  return requests.filter((item) => !knownWhenOpened.has(item.id)).length;
}

/** `1 new`, the Back bar's badge, or `null` for none. */
export function formatArrivedBadge(count: number, m: Messages = en): string | null {
  return count > 0 ? m.push.arrived(count) : null;
}

/** What the page knows when the push flow moves between its two screens. */
export interface ViewChange {
  layout: SessionLayout;
  from: PushView;
  to: PushView;
}

/**
 * Where the page scrolls when the push flow changes screen: an opened request
 * starts at its top, and the list returns to where it was left. `null` when
 * nothing scrolls - the desktop, whose page does not scroll, or no change.
 */
export function scrollOnViewChange({
  layout,
  from,
  to,
  listScroll,
}: ViewChange & { listScroll: number }): number | null {
  if (layout !== 'push' || from === to) {
    return null;
  }

  return to === 'detail' ? 0 : listScroll;
}

/**
 * Where focus goes when the push flow changes screen (WCAG 2.4.3):
 *
 * - `back-button`: a request opened, and the row that had focus is hidden with
 *   the list, so focus moves to `‹ Requests`;
 * - `open-row`: the request closed and took the Back bar with it, so focus
 *   returns to the row it was opened from;
 * - `list-heading`: the same, when that row has gone too - deleted, cleared or
 *   pushed out of the list;
 * - `none`: a close that left focus on something still shown, and every
 *   change on the desktop, whose focus is never moved.
 */
export type ViewChangeFocus = 'back-button' | 'open-row' | 'list-heading' | 'none';

export function focusOnViewChange({
  layout,
  from,
  to,
  focusLost,
  openRowListed,
}: ViewChange & {
  /** Focus is on the page body or on an element no longer shown. */
  focusLost: boolean;
  /** The list still holds the row of the request that was open. */
  openRowListed: boolean;
}): ViewChangeFocus {
  if (layout !== 'push' || from === to) {
    return 'none';
  }

  if (to === 'detail') {
    return 'back-button';
  }

  if (!focusLost) {
    return 'none';
  }

  return openRowListed ? 'open-row' : 'list-heading';
}

/**
 * The browser's own scroll restoration while the session page is up. Off while
 * it shows requests, because the page puts the list back itself and a
 * restoration of the browser's would race it. `auto` otherwise - on loading
 * and notice screens, and on every other page - since the setting belongs to
 * the history entry that is current, and the entries the application pushes
 * inherit it (D157).
 */
export function scrollRestorationFor(showingRequests: boolean): 'auto' | 'manual' {
  return showingRequests ? 'manual' : 'auto';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
