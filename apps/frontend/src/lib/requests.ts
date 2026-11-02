import {
  MAX_REQUESTS_PER_SESSION,
  type RequestDetails,
  type RequestListItem,
  type ResponseState,
  type ResponseSummary,
} from '@webhook-inspector/shared';

/**
 * A request as this client holds it, its `sourceIp` read once where it enters
 * the page, so the row, the filter, the detail panel and the compare view can
 * trust the `string | null` the contract gives it (issue #245). A string is
 * kept as it is, however long; anything else - a number, an object, an array,
 * a boolean, a missing field - is read as `null`, an address the page does not
 * have, which reads `IP unavailable` or `IP not stored` as a missing one does.
 * The server sends `string | null`; this keeps an answer outside that contract
 * from blanking the page in a formatter that slices the address. The same
 * object comes back when the address needs no fix.
 */
export function withSourceIp<T extends { sourceIp: string | null }>(item: T): T {
  const sent: unknown = item.sourceIp;

  return typeof sent === 'string' || sent === null ? item : { ...item, sourceIp: null };
}

/**
 * A list row as this client holds it: `path` is `null` where the backend sent
 * none, which a backend still on the image before 0.30.0 does during a
 * rollout (D180), and `sourceIp` is read as `withSourceIp` reads it (issue
 * #245). The list answer and each `request.received` event both pass through
 * here. Such a row is never matched by its path and shows as before. The same
 * object comes back when nothing needs a fix, which the filter's per-row cache
 * keys on.
 */
export function withListPath(item: RequestListItem): RequestListItem {
  return withSourceIp(item.path === undefined ? { ...item, path: null } : item);
}

/**
 * Newest first, with the id breaking ties, which is the order the list API uses
 * (D056). Applying it here too keeps a realtime insertion in the same place the
 * next reload would put it.
 */
function newestFirst(left: RequestListItem, right: RequestListItem): number {
  if (left.receivedAt !== right.receivedAt) {
    return left.receivedAt < right.receivedAt ? 1 : -1;
  }

  return left.id < right.id ? 1 : -1;
}

/**
 * Writes the responses `response.recorded` delivered during a list load onto
 * the rows its result holds (#174). The load's answer may have been read
 * before those responses were recorded, so its copy says `pending` - or
 * `unknown` - where the event already said how the exchange ended. The event
 * wins whatever that copy holds: the backend moves a record out of `pending`
 * once and never again (D109), so writing it again is always right.
 *
 * An id the list does not hold changes nothing: like `applyResponseRecorded`,
 * this never creates a row (D110). Only the rows it changes are copied, and
 * with nothing recorded it returns the array it was given.
 */
function withRecordedResponses(
  list: RequestListItem[],
  responses: ReadonlyMap<string, ResponseSummary>,
): RequestListItem[] {
  if (responses.size === 0) {
    return list;
  }

  return list.map((item) => {
    const response = responses.get(item.id);

    return response === undefined ? item : { ...item, response };
  });
}

/**
 * Combines what the viewer already shows with requests it has just learned
 * about, whether from a `request.received` event or from the load on mount
 * (D077).
 *
 * Both sources can describe the same request - an event can arrive while the
 * load is in flight - so ids decide identity and the incoming copy wins, but
 * for the responses `response.recorded` delivered during that load
 * (`recorded`), which are written onto the rows the result holds (#174). The
 * result is capped at the retention limit the backend enforces (D006), so a
 * long-lived tab cannot drift into showing rows the server no longer keeps.
 */
export function mergeRequests(
  current: readonly RequestListItem[],
  incoming: readonly RequestListItem[],
  recorded: ReadonlyMap<string, ResponseSummary> = new Map(),
): RequestListItem[] {
  const byId = new Map(current.map((item) => [item.id, item]));

  for (const item of incoming) {
    byId.set(item.id, item);
  }

  return withRecordedResponses(
    [...byId.values()].sort(newestFirst).slice(0, MAX_REQUESTS_PER_SESSION),
    recorded,
  );
}

/** What the socket delivered during one list load, kept for its answer. */
export interface SettledListLoad {
  /** The ids `request.received` delivered since the load began (#39). */
  receivedIds: ReadonlySet<string>;
  /**
   * The responses `response.recorded` delivered since the load began, by id,
   * the last one winning (#174).
   */
  responses: ReadonlyMap<string, ResponseSummary>;
}

/** One list load in flight, from `ListLoads.begin()`. */
export interface ListLoad {
  /**
   * Ends a load that answered. Answers with what the socket delivered since
   * it began, or `null` when the answer must be discarded: a deletion or a
   * clear arrived meanwhile (D136), or a load that began later has already
   * been applied, so this answer is older than the list on screen (#39). A
   * non-null answer counts as applied.
   */
  settle(): SettledListLoad | null;
  /** Ends a load whose answer will not be used: it failed, or its page left. */
  abandon(): void;
}

/** The list loads of one page: their generation and what arrived during them. */
export interface ListLoads {
  begin(): ListLoad;
  /** A `request.received` event: recorded by every load in flight. */
  received(id: string): void;
  /** A `response.recorded` event: recorded by every load in flight (#174). */
  recorded(id: string, response: ResponseSummary): void;
  /**
   * A deletion or a clear, by this viewer or another: every load in flight is
   * discarded, so it cannot put the deleted row back (D136).
   */
  invalidate(): void;
}

/**
 * Tracks the page's list loads. It is the list generation that has guarded
 * loads against deletions since D136, plus the ids received during each load
 * that `replaceWithReloaded` keeps, plus the responses recorded during each
 * load that both load paths write onto their rows (#174), plus the order the
 * loads began in, so a slow load answering after a later one cannot replace
 * that fresher list. A plain object with no React in it, held by the page, so
 * the rule can be tested on its own.
 */
export function createListLoads(): ListLoads {
  let generation = 0;
  let begun = 0;
  let newestApplied = 0;
  const inFlight = new Set<{ receivedIds: Set<string>; responses: Map<string, ResponseSummary> }>();

  return {
    begin() {
      const token = generation;
      const order = (begun += 1);
      const delivered = {
        receivedIds: new Set<string>(),
        responses: new Map<string, ResponseSummary>(),
      };

      inFlight.add(delivered);

      return {
        settle() {
          inFlight.delete(delivered);

          if (generation !== token || order < newestApplied) {
            return null;
          }

          newestApplied = order;

          return delivered;
        },
        abandon() {
          inFlight.delete(delivered);
        },
      };
    },
    received(id) {
      for (const load of inFlight) {
        load.receivedIds.add(id);
      }
    },
    recorded(id, response) {
      for (const load of inFlight) {
        load.responses.set(id, response);
      }
    },
    invalidate() {
      generation += 1;
    },
  };
}

/**
 * The list after the reload that follows every socket connection (D077): the
 * loaded list **replaces** the one on screen rather than being merged into it,
 * so a request deleted - singly or by `Delete all` - while the socket was down
 * does not survive the reconnection (issue #39, D136).
 *
 * The one thing the screen adds is what `request.received` delivered after the
 * reload began (`receivedIds`) and the loaded list lacks: the load may have
 * been answered before those requests were captured. Their copy is taken from
 * `current`, which already carries any `response.recorded` update. A row on
 * screen only because it was there before the gap is dropped. For the same
 * reason the responses `response.recorded` delivered during the reload
 * (`responses`) are written onto the rows the result holds, so a stale
 * `pending` copy cannot overwrite them (#174). Newest first and capped at the
 * retention limit, like `mergeRequests`.
 */
export function replaceWithReloaded(
  current: readonly RequestListItem[],
  loaded: readonly RequestListItem[],
  receivedIds: ReadonlySet<string>,
  responses: ReadonlyMap<string, ResponseSummary>,
): RequestListItem[] {
  const loadedIds = new Set(loaded.map((item) => item.id));
  const arrived = current.filter((item) => receivedIds.has(item.id) && !loadedIds.has(item.id));

  return withRecordedResponses(
    [...loaded, ...arrived].sort(newestFirst).slice(0, MAX_REQUESTS_PER_SESSION),
    responses,
  );
}

/**
 * Whether that reload closes the open detail panel: when the request it shows
 * is one of the rows `replaceWithReloaded` drops. That is a deletion the viewer
 * missed while disconnected, and it closes the panel the way a received
 * deletion does (D137).
 */
export function reloadClosesDetails(
  selectedId: string | null,
  loaded: readonly RequestListItem[],
  receivedIds: ReadonlySet<string>,
): boolean {
  return (
    selectedId !== null &&
    !receivedIds.has(selectedId) &&
    !loaded.some((item) => item.id === selectedId)
  );
}

/**
 * Folds a `response.recorded` summary into the row the list already holds
 * (D110).
 *
 * Deliberately **not** a widening of `mergeRequests`. That function is
 * incoming-wins-wholesale by design, and that semantic is exactly what makes
 * the overwrite D110 describes possible: a `{ id, response }` payload merged by
 * id would replace a real row with one that has no method, no timestamp and no
 * size. This one updates a field of a held row and can do nothing else.
 *
 * An id the list does not hold leaves the list **unchanged and never creates a
 * row**. That is reachable without any defect - after `Delete all`, after the
 * row aged past the retention limit, and on a connection opened between a
 * request being captured and its response completing - and `request.received`
 * stays the only event that may add a row. It returns the array it was given,
 * identity and all: a fresh copy would re-render the page, the list and both
 * halves of the detail panel for an event that changed nothing.
 */
export function applyResponseRecorded(
  current: RequestListItem[],
  update: { id: string; response: ResponseSummary },
): RequestListItem[] {
  const index = current.findIndex((item) => item.id === update.id);

  if (index === -1) {
    return current;
  }

  const next = [...current];

  next[index] = { ...current[index], response: update.response } as RequestListItem;

  return next;
}

/**
 * Drops one request from the list, for a `request.deleted` event (D136).
 *
 * The viewer that performed the deletion has already dropped the row when its
 * own event arrives, and another viewer may never have held it. Both are the
 * no-op case: an id the list does not hold returns the array it was given,
 * identity and all, so the event re-renders nothing and cannot flicker.
 */
export function applyRequestDeleted(current: RequestListItem[], id: string): RequestListItem[] {
  return current.some((item) => item.id === id)
    ? current.filter((item) => item.id !== id)
    : current;
}

/**
 * Whether a deletion closes the open detail panel: only when it names the
 * request the panel is showing (D137).
 */
export function deletionClosesDetails(deletedId: string, selectedId: string | null): boolean {
  return selectedId !== null && deletedId === selectedId;
}

/**
 * How many of the listed requests have never been opened.
 *
 * Unread means exactly that - not opened - so requests already captured when
 * the page loaded start unread too (D078). Only the count is derived here: the
 * number is shown in the browser tab title and nowhere in the page (D014).
 */
export function countUnread(
  requests: readonly RequestListItem[],
  openedIds: ReadonlySet<string>,
): number {
  return requests.reduce((count, item) => (openedIds.has(item.id) ? count : count + 1), 0);
}

/**
 * Whether a `response.recorded` event obliges the open detail panel to be
 * reloaded.
 *
 * The event carries the light summary (D110), and the panel header needs the
 * whole record - `bodySuppressed`, `isBinary`, `body`, `bodySize`, `delayMs`,
 * `completedAt`. So the summary cannot be folded into the panel the way it is
 * folded into the row, and the only honest way to move the open panel to the
 * recorded response is to fetch the detail again (D125).
 *
 * It is worth doing for the selected request and for nothing else: a refetch
 * for a row nobody is looking at is a request whose answer would be thrown
 * away.
 */
export function shouldRefreshDetails(eventId: string, selectedId: string | null): boolean {
  return selectedId !== null && eventId === selectedId;
}

/**
 * Whether a `ready` obliges the open detail panel to be reloaded: whenever a
 * request is open, whatever its response state (#204).
 *
 * A `response.recorded` sent while the socket was down never arrives, so
 * `shouldRefreshDetails` never runs for it; the reload on `ready` brings the
 * row's final state, and nothing else would bring the panel's. The panel's own
 * state is not consulted: one detail read per `ready` with a panel open is
 * simpler than reasoning about an opening answer that may still be in flight
 * across the reconnection, and a refresh never moves the panel back to
 * `pending` (`detailToShow`).
 */
export function shouldRefreshDetailsOnReady(selectedId: string | null): selectedId is string {
  return selectedId !== null;
}

/** What a finished detail refresh has to be checked against before it is used. */
export interface RefreshedDetails {
  /** The request the answer describes. */
  loadedId: string;
  /** The request selected now, which may no longer be the one above. */
  selectedId: string | null;
  /** The detail-request token held when the refresh started. */
  token: number;
  /** The detail-request token now. */
  currentToken: number;
}

/**
 * Whether a refreshed detail may be shown.
 *
 * A refresh is not a new selection, so it never moves the token - incrementing
 * it would invalidate a `select()` already in flight. That makes it the late
 * answer in two races, and each guard below closes one of them:
 *
 * - **the token** rejects a refresh that a newer selection has overtaken. The
 *   viewer has A open, the event for A starts a refresh, the viewer clicks B,
 *   and A's answer lands afterwards. `select()` moved the token, so this answer
 *   is stale and would put A's response into B's panel;
 * - **the selected id** rejects an answer for a request that is no longer the
 *   selected one even though the token did not move. That is reachable: the
 *   `REQUEST_NOT_FOUND` branch of `select()` drops the row and clears the
 *   selection **without** touching the token, so a refresh started before it
 *   would otherwise repopulate a panel that is showing nothing.
 *
 * Both are required for the answer to be applied.
 */
export function canApplyRefreshedDetails(refresh: RefreshedDetails): boolean {
  return refresh.token === refresh.currentToken && refresh.loadedId === refresh.selectedId;
}

/**
 * A refresh that has been started, and everything needed to decide what to do
 * with its answer.
 *
 * `load` and `currentState` are injected rather than imported so that this
 * module keeps knowing nothing about the API client or about React, and so the
 * decision can be exercised without either.
 */
export interface DetailRefresh {
  /** The request to reload: the one the event named, which is the open one. */
  id: string;
  /**
   * The detail-request token held when the refresh started. It is captured and
   * **never incremented**: a refresh is not a new selection, and incrementing
   * would invalidate a `select()` already in flight.
   */
  token: number;
  /** Loads the request's detail. */
  load: (id: string) => Promise<RequestDetails>;
  /**
   * The selection and the token as they are **after** the answer arrives. Both
   * may have moved while it was on its way, which is the whole point.
   */
  currentState: () => { selectedId: string | null; token: number };
}

/**
 * Runs a detail refresh and answers with the detail the panel should show, or
 * `null` when it should keep what it already has.
 *
 * `null` is returned for a stale answer **and for a refresh that failed**, and
 * the two are deliberately indistinguishable to the caller: in both cases the
 * panel is holding valid data, and there is nothing it should do. A failure is
 * swallowed here rather than reported, because replacing a good panel with a
 * loading or an error state would be a worse outcome than showing the response
 * the panel was opened with until the next selection or reload (D125).
 */
export async function loadRefreshedDetails(refresh: DetailRefresh): Promise<RequestDetails | null> {
  let loaded: RequestDetails;

  try {
    loaded = await refresh.load(refresh.id);
  } catch {
    return null;
  }

  const current = refresh.currentState();

  return canApplyRefreshedDetails({
    loadedId: loaded.id,
    selectedId: current.selectedId,
    token: refresh.token,
    currentToken: current.token,
  })
    ? loaded
    : null;
}

/**
 * How far along a response record a reading of it is: `pending` first, then
 * `unknown`, then a recorded state - `sent`, `aborted` or `failed` (#204).
 *
 * Successive reads of one record never go back down this order. A record is
 * stored `pending` and leaves it once, for a recorded state, and never returns
 * (its update is guarded by `state = 'pending'`); `unknown` is never stored, it
 * is read from a record still stored `pending` once that record has aged past
 * its delay plus the grace (D109). So a read giving `pending` came before one
 * giving `unknown`, and a read giving either came before one giving a recorded
 * state.
 */
function readingOrder(state: ResponseState): number {
  switch (state) {
    case 'pending':
      return 0;
    case 'unknown':
      return 1;
    case 'sent':
    case 'aborted':
    case 'failed':
      return 2;
  }
}

/**
 * The detail the panel shows once an answer it may apply arrives: the answer,
 * unless it was read before what the panel already shows (#204).
 *
 * Two answers can be on their way for the open request at once - the opening
 * one from `select()` and a refresh, started by `response.recorded` or by a
 * `ready` - and they hold the same token, since a refresh never moves it. So
 * neither the token nor the order they land in tells which was read last: a
 * refresh that answers first with the recorded response would otherwise be
 * overwritten by the opening answer, read before the record and still
 * `pending` or, for an overdue record, `unknown`.
 *
 * What orders them is the backend, through `readingOrder`: an answer for the
 * request whose panel shows a response further along was read before it, and
 * the panel keeps what it has. That holds back an answer reading `pending`
 * over any other state, `unknown` included, and an answer reading `unknown`
 * over a recorded state. Every other answer is shown as it came: another
 * request's detail, `unknown` over `pending` or over `unknown`, a recorded
 * response over anything, `pending` over `pending`, and a `null` response -
 * nothing recorded - on either side.
 */
export function detailToShow(
  current: RequestDetails | null,
  loaded: RequestDetails,
): RequestDetails {
  const heldBack =
    current !== null &&
    current.id === loaded.id &&
    current.response !== null &&
    loaded.response !== null &&
    readingOrder(loaded.response.state) < readingOrder(current.response.state);

  return heldBack ? current : loaded;
}
