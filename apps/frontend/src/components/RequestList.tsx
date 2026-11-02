import { useEffect, useRef, useState, type Ref } from 'react';
import { Search } from 'lucide-react';
import type { RequestListItem, ResponseSummary } from '@webhook-inspector/shared';
import { MAX_REQUESTS_PER_SESSION, REQUEST_ID_DISPLAY_LENGTH } from '@webhook-inspector/shared';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import type { Phrase } from '../i18n/en.ts';
import { formatBytesCompact } from '../lib/format.ts';
import { listRuleMarker, listStatusTone, type ListStatusTone } from '../lib/response-summary.ts';
import { statusPillClassName } from '../lib/status-pill.ts';
import {
  formatFilterCount,
  isBlankQuery,
  queryWords,
  rowHighlights,
  splitByRanges,
  type HighlightRange,
} from '../lib/request-filter.ts';
import {
  canRetrySearch,
  notSearchedReasonText,
  type NotSearchedReason,
  type RawSearchState,
} from '../lib/raw-search.ts';
import { usePhoneLayout } from '../hooks/useDesktopLayout.ts';
import { cn } from '../lib/cn.ts';
import { DiffMark } from './CompareView.tsx';
import { DeleteAllDialog } from './DeleteAllDialog.tsx';

/**
 * The colour of a status cell drawn as text, decided by `listStatusTone`: red
 * for `Failed`, our own write's failure, and muted for the rest that are not
 * an answer the session gave. An answer is drawn in the pill of its class
 * instead, and no status is green or red text for its class any more (D207).
 */
const STATUS_TEXT_CLASS: Record<Exclude<ListStatusTone, 'answered'>, string> = {
  failure: 'text-danger',
  neutral: 'text-ink-muted',
};

/** The classes of a row's status cell: the pill, or text in its tone (D207). */
function rowStatusClassName(response: ResponseSummary | null): string {
  const tone = listStatusTone(response);

  if (tone !== 'answered') {
    return cn('font-semibold', STATUS_TEXT_CLASS[tone]);
  }

  // `answered` is said only of a record with a status.
  return response === null || response.status === null
    ? cn('font-semibold', STATUS_TEXT_CLASS.neutral)
    : statusPillClassName(response.status, 'row');
}

/**
 * The classes of a row's rule marker (issue #233, approved direction A): the
 * Response tab's rule tag shrunk to the row pill's 14 px, so no row grows. On
 * an unread row's shading `--color-panel-note` all but vanishes, so the tag is
 * white there; a plain or a selected row keeps the note's fill.
 */
function rowRuleClassName(onUnreadShading: boolean): string {
  return cn(
    'shrink-0 whitespace-nowrap rounded-[4px] px-1.5 text-[11px] leading-[14px] font-medium text-ink-id',
    onUnreadShading ? 'bg-white' : 'bg-panel-note',
  );
}

/**
 * What the list pane says about the server's search of headers and bodies
 * for the filter's words (issue #78, D191), and how to ask for it again.
 */
export interface ListSearch extends Pick<RawSearchState, 'status' | 'reason' | 'slow'> {
  onRetry: () => void;
}

interface RequestListProps {
  /**
   * The rows to show: the session's requests the filter keeps, by their list
   * fields (D180) or by their raw request, searched on the server (D191).
   */
  requests: RequestListItem[];
  /** How many requests the session holds, filtered or not. */
  total: number;
  /** The list filter as typed; `''` for none (D180). */
  query: string;
  onQueryChange: (query: string) => void;
  search: ListSearch;
  selectedId: string | null;
  /** Requests the viewer has opened. The rest are shown as unread (D078). */
  openedIds: ReadonlySet<string>;
  /**
   * The session keeps no sender address (`storeSourceIp: false`): a row
   * without one reads `IP not stored` rather than `IP unavailable` (D249).
   */
  keepsNoAddress: boolean;
  /** A failed action, reported in place so the captured requests stay visible. */
  error: Phrase | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  /**
   * Picking a request to compare the open one with (A1, A4, D186), or `null`.
   * The header says so and offers `Cancel` in place of Delete all, no row
   * shows `×`, and the open row says `open` and cannot be chosen; a click on
   * any other row is `onSelect`, which chooses it.
   */
  picking: ListPicking | null;
  /** The open (`−`) and chosen (`+`) rows while a comparison is shown, or `null`. */
  compared: { open: string; chosen: string } | null;
  /**
   * The list's section. Where focus returns when the open request closes in
   * the push flow: its row, found by `data-request-id`, or the heading (D157).
   */
  listRef?: Ref<HTMLElement>;
  className?: string;
}

/** What the list header says while picking (A1, A4). */
export interface ListPicking {
  /** The open request, which cannot be chosen. */
  openId: string;
  /** `POST 2b906b8` on the desktop and the tablet. */
  openMethod: string;
  onCancel: () => void;
}

/**
 * The captured requests: a 430 px column beside the open request on the
 * desktop, and below 1024 px the whole width, as the session's home screen
 * (D157). There it grows with its rows and the page scrolls, rather than
 * scrolling inside a box that a phone in landscape would leave no room for.
 */
export function RequestList({
  requests,
  total,
  query,
  onQueryChange,
  search,
  selectedId,
  openedIds,
  keepsNoAddress,
  error,
  onSelect,
  onDelete,
  onClear,
  picking,
  compared,
  listRef,
  className,
}: RequestListProps) {
  const m = useMessages();
  const words = queryWords(query);
  const filtered = words.length > 0;
  /** Why headers and bodies were not searched for this filter, or `null`. */
  const notSearched = filtered && search.status === 'not-searched' ? search.reason : null;
  const [open, setOpen] = useState(query !== '');
  const showField = open || query !== '';
  const input = useRef<HTMLInputElement>(null);
  const iconButton = useRef<HTMLButtonElement>(null);
  /** Where focus goes once the header has re-rendered: set only by the viewer's action. */
  const focusNext = useRef<'field' | 'icon' | null>(null);

  useEffect(() => {
    if (focusNext.current === 'field' && showField) {
      input.current?.focus();
    } else if (focusNext.current === 'icon' && !showField) {
      iconButton.current?.focus();
    }

    focusNext.current = null;
  });

  /** `×`, Escape and Clear filter: no filter, the heading back, focus on the icon. */
  function closeFilter(): void {
    onQueryChange('');
    setOpen(false);
    focusNext.current = 'icon';
  }

  return (
    <section
      ref={listRef}
      className={cn(
        'flex h-full w-[430px] shrink-0 flex-col rounded-[10px] border border-line bg-white',
        'max-lg:h-auto max-lg:w-auto max-lg:min-w-0 max-lg:flex-1',
        className,
      )}
    >
      <ListHeader
        shown={requests.length}
        total={total}
        query={query}
        searching={search.slow}
        showField={showField}
        inputRef={input}
        iconButtonRef={iconButton}
        onQueryChange={onQueryChange}
        onOpen={() => {
          setOpen(true);
          focusNext.current = 'field';
        }}
        onLeaveEmpty={() => {
          // Whitespace alone is no filter: dropped with the field.
          onQueryChange('');
          setOpen(false);
        }}
        onClose={closeFilter}
        onClear={onClear}
        picking={picking}
      />

      {error ? (
        <p className="border-b border-line-soft px-4 py-2 text-[12px] text-danger md:max-lg:px-5">
          {error(m)}
        </p>
      ) : null}

      {/* Shown only when headers and bodies were not searched, and gone with
          the next search that succeeds; the rows under it are the list-field
          matches (A4.3, A4.4, A4.8). With no such row the reason is in the
          empty result instead (A4.6). */}
      {notSearched !== null && requests.length > 0 ? (
        <SearchNotice reason={notSearched} onRetry={search.onRetry} />
      ) : null}

      {requests.length === 0 && filtered && search.status === 'pending' ? (
        // No list field matches, and what the headers and bodies hold is
        // still to come: not yet `No requests match` (A4.2).
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <p role="status" className="text-[13px] text-ink-muted">
            {m.filter.searching}
          </p>
        </div>
      ) : requests.length === 0 && filtered ? (
        // Never `Waiting for the first request` under a filter: the session
        // may well hold requests, and none of them match (2G, 2H, D180).
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="max-w-full text-[15px] font-semibold text-ink [overflow-wrap:anywhere]">
            {m.list.noMatch(query.trim())}
          </p>
          {/* One line more than #70's empty result, and only when a word was
              searchable: that headers and bodies were searched too (A4.5,
              A4.9), or why they were not (A4.6). */}
          {notSearched !== null ? (
            <p role="status" className="max-w-[300px] text-[13px] text-notice-text">
              <NotSearchedText reason={notSearched} />
            </p>
          ) : search.status === 'searched' ? (
            <p className="text-[13px] text-ink-muted">{m.filter.searchedToo}</p>
          ) : null}
          {/* 20 px between the two labels, inside their 44 px targets (A4.6). */}
          <div className="flex items-center justify-center -space-x-1">
            {notSearched !== null && canRetrySearch(notSearched) ? (
              <EmptyResultAction onClick={search.onRetry}>{m.list.retry}</EmptyResultAction>
            ) : null}
            <EmptyResultAction onClick={closeFilter}>{m.list.clearFilter}</EmptyResultAction>
          </div>
        </div>
      ) : requests.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <p className="text-[15px] font-semibold text-ink">{m.list.waitingTitle}</p>
          <p className="mt-2 text-[13px] text-ink-muted">{m.list.waitingText}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto max-lg:overflow-visible">
          {requests.map((item) => (
            <RequestRow
              key={item.id}
              request={item}
              words={words}
              keepsNoAddress={keepsNoAddress}
              selected={item.id === selectedId}
              unread={!openedIds.has(item.id)}
              picking={picking === null ? null : item.id === picking.openId ? 'open' : 'candidate'}
              mark={
                compared === null
                  ? null
                  : item.id === compared.open
                    ? 'removed'
                    : item.id === compared.chosen
                      ? 'added'
                      : null
              }
              onSelect={() => onSelect(item.id)}
              onDelete={() => onDelete(item.id)}
            />
          ))}
          {/* 8 px under the last row, so it reads as the list's own note
              rather than something apart from it (B2, E2, F2, D158). */}
          <p className="px-4 pt-2 text-[12px] text-ink-muted max-lg:pb-4 md:max-lg:px-5">
            {m.list.newestOnTop}
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * `Headers and bodies not searched:` and its reason. The reason is a whole
 * part: it continues the line where it fits there whole, and otherwise starts
 * a new one (A4.6, A4.8).
 */
function NotSearchedText({ reason }: { reason: NotSearchedReason }) {
  const m = useMessages();

  return (
    <>
      {m.filter.notSearchedLead}{' '}
      <span className="inline-block">{notSearchedReasonText(reason, m)}</span>
    </>
  );
}

/**
 * The notice at the top of the list, under the header: amber, with an `!`
 * disc, the reason, and Retry where another attempt can change it (A4.3, A4.4,
 * A4.8). Announced politely, as a status and not an alert: the list-field
 * filter still works. Retry's target is the notice's whole height and reaches
 * its right edge, while its text stays where the frames draw it.
 */
function SearchNotice({ reason, onRetry }: { reason: NotSearchedReason; onRetry: () => void }) {
  const m = useMessages();

  return (
    <div
      role="status"
      data-testid="search-notice"
      className="flex items-start gap-2 border-b border-notice-line bg-notice px-4 py-2 md:max-lg:px-5"
    >
      <span
        aria-hidden="true"
        className="flex size-[14px] shrink-0 items-center justify-center rounded-full bg-notice-mark text-[10px] leading-[12px] font-bold text-white"
      >
        !
      </span>
      <p className="min-w-0 flex-1 text-[12px] leading-[15px] text-notice-text">
        <NotSearchedText reason={reason} />
      </p>
      {canRetrySearch(reason) ? (
        <button
          type="button"
          onClick={onRetry}
          className="-my-2 -mr-4 -ml-3 flex shrink-0 items-start self-stretch py-2 pr-4 pl-3 text-[12px] leading-[15px] font-semibold text-link focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent md:max-lg:-mr-5 md:max-lg:pr-5"
        >
          {m.list.retry}
        </button>
      ) : null}
    </div>
  );
}

/** An action under the empty result: Retry, Clear filter (2G, A4.5, A4.6). */
function EmptyResultAction({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-11 items-center rounded-[7px] px-3 text-[14px] font-semibold text-link focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}

interface ListHeaderProps {
  shown: number;
  total: number;
  query: string;
  /** A search of headers and bodies has run for over 300 ms: the spinner. */
  searching: boolean;
  /** The field in place of the heading and the count. */
  showField: boolean;
  inputRef: Ref<HTMLInputElement>;
  iconButtonRef: Ref<HTMLButtonElement>;
  onQueryChange: (query: string) => void;
  /** The search icon was activated. */
  onOpen: () => void;
  /** Focus left the field while it was empty or held only whitespace. */
  onLeaveEmpty: () => void;
  /** `×` or Escape. */
  onClose: () => void;
  onClear: () => void;
  picking: ListPicking | null;
}

/**
 * The list's header: `Requests`, the count, the filter's search icon and
 * Delete all (2A, 2D), or, once the icon is activated or while the filter has
 * a value, the filter field in place of the heading and the count, which stay
 * for assistive technology (2B, 2F, D180). The field keeps 8 px from Delete
 * all at every width. Below 1024 px the controls are 40 px touch targets and
 * Delete all follows the count (7B, D157).
 *
 * The field also searches headers and bodies, on the server (D191), and its
 * placeholder says so, in the words a phone has room for (A4.1, A4.7). While
 * such a search has run for over 300 ms, a 12 px spinner takes the count's
 * place (A4.2); it is announced as the count is, politely.
 */
function ListHeader({
  shown,
  total,
  query,
  searching,
  showField,
  inputRef,
  iconButtonRef,
  onQueryChange,
  onOpen,
  onLeaveEmpty,
  onClose,
  onClear,
  picking,
}: ListHeaderProps) {
  const m = useMessages();
  const blank = isBlankQuery(query);
  const phone = usePhoneLayout();
  const pickingTitle = picking !== null && !showField;
  const openShortId = picking?.openId.slice(0, REQUEST_ID_DISPLAY_LENGTH) ?? '';

  return (
    <div
      data-testid={picking === null ? undefined : 'list-picking'}
      className={cn(
        'flex items-center justify-between gap-2 border-b border-line-panel px-4 py-[14px] max-lg:justify-start max-lg:py-2 max-lg:pr-3 md:max-lg:pl-5',
        picking !== null && 'bg-row-selected',
        pickingTitle && 'py-3',
      )}
    >
      {/* While picking, the heading and the count give way to what the list
          is for now (A1, A4); the filter field still takes their place. */}
      {pickingTitle ? (
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-[15px] font-semibold leading-[18px] text-ink">{m.list.compareWith}</p>
          {/* Each width's wording is a whole phrase, and the other one is
              `display: none`, so the page's text and assistive technology
              read one sentence, never the two interleaved. */}
          <p className="truncate text-[12px] leading-[15px] text-ink-muted max-md:hidden">
            {m.list.chooseFor(picking.openMethod, openShortId)}
          </p>
          <p className="truncate text-[12px] leading-[15px] text-ink-muted md:hidden">
            {m.list.tapFor(openShortId)}
          </p>
        </div>
      ) : null}
      {/* Focusable from script only: where focus lands when the open request
          closed and its row is gone while the field is not shown (D157). */}
      <h2
        tabIndex={-1}
        className={cn(
          'rounded-[4px] text-[15px] font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:shrink-0',
          (showField || picking !== null) && 'sr-only',
        )}
      >
        {m.list.heading}
      </h2>
      {/* On a phone `3 / 1000`: `340 / 1000 requests` needs 115 px and has 101 (2D). */}
      <p
        className={cn(
          'text-[12px] text-ink-muted max-lg:min-w-0 max-lg:flex-1 max-lg:truncate',
          (showField || picking !== null) && 'sr-only',
        )}
      >
        {total} / {MAX_REQUESTS_PER_SESSION}
        <span className="max-md:hidden">{m.list.limitSuffix(MAX_REQUESTS_PER_SESSION)}</span>
      </p>

      {showField ? (
        <div
          className="flex h-[31px] min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-[7px] border border-line-strong bg-white pl-[10px] focus-within:border-accent focus-within:shadow-[inset_0_0_0_1px_var(--color-accent)] max-lg:h-10"
          onBlur={(event) => {
            // Leaving the field while it is empty brings the heading back.
            if (blank && !event.currentTarget.contains(event.relatedTarget)) {
              onLeaveEmpty();
            }
          }}
        >
          <Search
            aria-hidden="true"
            className="size-[14px] shrink-0 text-ink-mark"
            strokeWidth={2}
          />
          <input
            ref={inputRef}
            type="text"
            role="searchbox"
            data-list-filter
            aria-label={m.list.filterLabel}
            placeholder={phone ? m.filter.placeholderPhone : m.filter.placeholder}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && blank) {
                event.preventDefault();
                onClose();
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-placeholder"
          />
          {blank ? null : (
            // One live region for both, so the spinner is announced where the
            // count was.
            <p
              data-testid="filter-count"
              aria-live="polite"
              className="flex shrink-0 items-center text-[12px] whitespace-nowrap text-ink-muted"
            >
              {searching ? (
                <>
                  <span className="sr-only">{m.filter.searching}</span>
                  <span
                    aria-hidden="true"
                    data-testid="filter-spinner"
                    className="block size-3 animate-spin rounded-full border-[1.68px] border-spinner-track border-t-ink-muted border-r-ink-muted"
                  />
                </>
              ) : (
                <span>
                  {formatFilterCount(shown, total, m)}
                  <span className="max-md:hidden"> / {MAX_REQUESTS_PER_SESSION}</span>
                </span>
              )}
            </p>
          )}
          <button
            type="button"
            aria-label={blank ? m.list.closeFilter : m.list.clearFilter}
            // Keeps focus in the field, so an empty field's blur does not
            // close it under the pointer before the click lands.
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClose}
            className="flex size-[30px] shrink-0 items-center justify-center text-[16px] text-ink-mark hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent max-lg:h-10 max-lg:w-11 max-lg:text-[18px]"
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-2">
        {showField ? null : (
          <button
            ref={iconButtonRef}
            type="button"
            aria-label={m.list.filterLabel}
            onClick={onOpen}
            className="flex size-[31px] shrink-0 items-center justify-center rounded-[7px] border border-line-strong bg-white text-ink-mark hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:size-10"
          >
            <Search aria-hidden="true" className="size-[14px] max-lg:size-4" strokeWidth={2} />
          </button>
        )}
        {picking === null ? (
          <DeleteAllDialog count={total} hidden={total - shown} onConfirm={onClear} />
        ) : (
          <button
            type="button"
            onClick={picking.onCancel}
            className="flex h-[33px] shrink-0 items-center rounded-[7px] border border-line-strong bg-white px-3 text-[12px] font-semibold text-ink hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:h-10 max-lg:text-[14px]"
          >
            {m.common.cancel}
          </button>
        )}
      </div>
    </div>
  );
}

/** A shown text with the filter's matches in it highlighted (2C, 2E). */
function Marked({ text, ranges }: { text: string; ranges: readonly HighlightRange[] }) {
  if (ranges.length === 0) {
    return text;
  }

  return splitByRanges(text, ranges).map((piece, index) =>
    piece.match ? (
      <mark
        key={index}
        className="-mx-[3px] rounded-[3px] bg-match px-[3px] text-inherit [box-decoration-break:clone]"
      >
        {piece.text}
      </mark>
    ) : (
      piece.text
    ),
  );
}

interface RequestRowProps {
  request: RequestListItem;
  /** The filter's words, whose matches the row highlights; none without one. */
  words: readonly string[];
  /** `IP not stored` where the address is missing (D249). */
  keepsNoAddress: boolean;
  selected: boolean;
  unread: boolean;
  /**
   * While picking: `open` for the open request, which says so and cannot be
   * chosen, `candidate` for every other row; `null` otherwise.
   */
  picking: 'open' | 'candidate' | null;
  /** `−` or `+` after the short id while a comparison is shown. */
  mark: 'removed' | 'added' | null;
  onSelect: () => void;
  onDelete: () => void;
}

/**
 * One row. On the desktop it is 57 px with the time and a 30 px delete mark
 * laid over its right edge. Below 1024 px the time moves into the first line
 * and the delete control becomes a 44 px target. On a tablet the row is 64 px
 * and the `×` has a column of its own (7B). On a phone the row is 76 px with
 * the full time ending line 1 and the `×` in the row's bottom-right corner, on
 * line 2, its glyph ending where the time ends: its target starts below line 1,
 * so it never covers the time, and a tap anywhere else opens the request
 * (2A″, #55, D157).
 */
function RequestRow({
  request,
  words,
  keepsNoAddress,
  selected,
  unread,
  picking,
  mark,
  onSelect,
  onDelete,
}: RequestRowProps) {
  const m = useMessages();
  const { texts, ranges } = rowHighlights(request, words, undefined, m, keepsNoAddress);
  const time = <Marked text={texts.time} ranges={ranges.time} />;
  const rule = listRuleMarker(request.response, m);

  return (
    <div
      className={cn(
        'group relative border-b border-line-soft',
        'max-lg:flex max-lg:items-center md:max-lg:gap-1 md:max-lg:pr-2',
        // A selected row is by definition one the viewer has opened, so the two
        // backgrounds cannot collide. An unread row keeps its shading on hover;
        // the design's hover belongs to the plain row. While picking, a hovered
        // candidate is tinted, unread or not (A1).
        selected ? 'bg-row-selected' : unread ? 'bg-row-unread' : 'bg-white hover:bg-canvas',
        picking === 'candidate' && 'lg:hover:bg-row-pick-hover',
      )}
    >
      {selected ? <span className="absolute inset-y-0 left-0 w-[5px] bg-accent" /> : null}

      <button
        type="button"
        data-request-id={request.id}
        // The open row cannot be chosen while picking; it stays focusable and
        // says why, rather than vanishing from the keyboard's path (A1).
        aria-disabled={picking === 'open' ? true : undefined}
        onClick={picking === 'open' ? undefined : onSelect}
        className="flex h-[57px] w-full flex-col justify-center px-4 text-left max-lg:min-w-0 max-lg:flex-1 max-lg:overflow-hidden max-md:h-[75px] md:max-lg:h-16 md:max-lg:pr-0 md:max-lg:pl-5"
      >
        <span className="flex items-baseline gap-[9px] text-[14px] font-semibold max-md:leading-[normal]">
          <span className="text-method max-lg:shrink-0">
            <Marked text={texts.method} ranges={ranges.method} />
          </span>
          <span className="text-ink-id max-lg:min-w-0 max-lg:truncate">
            <Marked text={texts.shortId} ranges={ranges.shortId} />
          </span>
          {mark === null ? null : <DiffMark mark={mark} className="self-center" />}
          {/* The visible `open` is drawn outside the button; this says why the
              row is disabled while picking (D186). */}
          {picking === 'open' ? <span className="sr-only">{m.list.openCannotChoose}</span> : null}
          {/* The same instant as the desktop's time below, placed in the
              line on a touch row. Hidden from assistive technology, which
              already reads that one. */}
          <span
            aria-hidden="true"
            className="ml-auto hidden shrink-0 pl-2 text-[11px] font-semibold text-ink-muted max-lg:inline"
          >
            {time}
          </span>
        </span>
        {/* On a phone line 2 stops 32 px short of the row's content edge,
            clear of the `×` laid over its end (2A″). */}
        <span className="mt-[3px] flex items-baseline gap-2 text-[11px] max-md:mt-4 max-md:pr-8 max-md:leading-[normal] md:max-lg:mt-1.5">
          {/* The status the backend recorded for this request, and never one
              derived from the session configuration: a derived status sitting
              beside real ones reads as an observation nobody made (D119). The
              configured status stays on the endpoint card. An answer the
              session gave is the code in the pill of its class, which never
              wraps or shrinks; a match of the filter is highlighted inside it
              (D207). After it, 4 px apart, the marker of the response rule
              that answered, `R2`, whose title and accessible name say so;
              the two are one group that never shrinks, so only the address
              truncates (issue #233). */}
          <span className="flex shrink-0 items-baseline gap-1">
            <span
              data-testid="row-status"
              title={request.response === null ? m.list.noResponseTitle : m.list.statusTitle}
              className={rowStatusClassName(request.response)}
            >
              <Marked text={texts.status} ranges={ranges.status} />
            </span>
            {rule === null ? null : (
              <>
                <span
                  data-testid="row-rule"
                  aria-hidden="true"
                  title={rule.title}
                  className={rowRuleClassName(!selected && unread)}
                >
                  {rule.text}
                </span>
                <span className="sr-only">{rule.title}</span>
              </>
            )}
          </span>
          {/* The address only, compacted: the detail panel's facts line writes
              it in full. No country, flag or country code anywhere (D123,
              D140). */}
          <span
            data-testid="row-address"
            className="text-ink-muted max-lg:min-w-0 max-lg:truncate"
            title={request.sourceIp ?? undefined}
          >
            <Marked text={texts.address} ranges={ranges.address} />
          </span>
          <span className="font-semibold text-ink-size max-lg:shrink-0">
            {formatBytesCompact(request.bodySize)}
          </span>
        </span>
      </button>

      {/* The compact form; the detail panel writes the same instant as
          `17 Sep 2026, 14:32:06` (D148). */}
      <span
        data-testid="row-time"
        className="pointer-events-none absolute right-[10px] top-[33px] text-[10px] font-semibold text-ink-muted max-lg:sr-only"
      >
        {time}
      </span>

      {picking === null ? null : (
        /* While picking there is no `×` (A1, A4). The open row says `open`
           where the desktop's `×` was, at the end of a phone's line 2, and in
           the tablet's `×` column; a hovered or focused candidate shows
           `Compare` there on the desktop. */
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute right-4 top-3 text-[11px] leading-[13px]',
            'max-md:top-auto max-md:bottom-[14px] md:max-lg:static md:max-lg:flex md:max-lg:w-11 md:max-lg:shrink-0 md:max-lg:justify-center',
            picking === 'open'
              ? 'font-medium text-ink-muted'
              : 'top-[7px] hidden rounded-[6px] border border-accent bg-white px-[10px] py-[3px] text-[12px] leading-[15px] font-semibold text-link md:max-lg:invisible lg:group-hover:block lg:group-focus-within:block',
          )}
        >
          {picking === 'open' ? m.list.open : m.list.compare}
        </span>
      )}

      {/* Small mark, 30 by 30 hit area (D030), and 44 by 44 below 1024 px
          (D157). On a phone it sits over the bottom-right corner, reaching
          down over the row's 1 px rule as 2A″ draws it, so its box starts
          32 px down, below line 1. Deletion is immediate (D029). */}
      <button
        type="button"
        aria-label={m.list.deleteRequest}
        onClick={onDelete}
        hidden={picking !== null}
        className="absolute right-0 top-0 flex size-[30px] items-center justify-center text-[16px] text-ink-mark hover:text-danger max-lg:size-11 max-lg:shrink-0 max-lg:text-[18px] max-md:top-auto max-md:-bottom-px md:max-lg:static"
      >
        ×
      </button>
    </div>
  );
}
