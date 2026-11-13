import { Fragment, memo, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  REQUEST_ID_DISPLAY_LENGTH,
  type RequestDetails,
  type RequestListItem,
} from '@webhook-inspector/shared';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import { formatBytesCompact, formatTimestamp } from '../lib/format.ts';
import {
  COMPARE_VIEW_LABELS,
  COMPARE_VIEWS,
  compareRequests,
  isIdentical,
  noDifferencesLine,
  openingView,
  splitByInlineRanges,
  wholeHeadline,
  wholeNote,
  type CompareViewName,
  type DiffRow,
  type ViewComparison,
} from '../lib/request-diff.ts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.tsx';

/** The chosen request's details, as far as they have come (D186). */
export type ChosenDetails =
  | { status: 'loading' }
  | { status: 'loaded'; details: RequestDetails }
  /** Deleted, evicted by the 1000 limit (D006) or not found: D4. */
  | { status: 'gone' }
  | { status: 'failed' };

interface CompareViewProps {
  /** The open request: always `−`. */
  open: RequestDetails;
  /** The chosen request's row as it was chosen: always `+`. */
  chosenItem: RequestListItem;
  chosen: ChosenDetails;
  /** The view the user picked, or `null` for the comparison's opening view. */
  view: CompareViewName | null;
  onViewChange: (view: CompareViewName) => void;
  /** `Change` and `Choose another`: picking again for the same open request. */
  onChange: () => void;
  /** `Close ×`: back to the open request. */
  onClose: () => void;
  /** Loads the chosen request again after a failure. */
  onRetry: () => void;
}

/** A phone's and a tablet's sides, as the request half's (3A, 7C). */
const SIDES = 'px-5 max-md:px-4 md:max-lg:px-6';

/**
 * The comparison of the open request with one chosen in the list (issue #75,
 * D186; frames A2, A3, A5-A7 and D1-D4 of the Figma page `Webhook Inspector ·
 * Compare requests`): `Comparing` · `Change` · `Close ×` in place of the
 * `Request` · `Response` row, the two requests marked `−` and `+`, the views
 * with a dot on each that differs, and one column of lines.
 *
 * Rendered inside the detail panel's `RenderBoundary` (D169): a comparison
 * that cannot be drawn costs the panel, not the page.
 */
export function CompareView({
  open,
  chosenItem,
  chosen,
  view: picked,
  onViewChange,
  onChange,
  onClose,
  onRetry,
}: CompareViewProps) {
  const m = useMessages();
  const chosenDetails = chosen.status === 'loaded' ? chosen.details : null;
  // Computed once per pair: the panel re-renders on every realtime event.
  const comparison = useMemo(
    () => (chosenDetails === null ? null : compareRequests(open, chosenDetails)),
    [open, chosenDetails],
  );
  const view = picked ?? (comparison === null ? 'body' : openingView(comparison));
  const identical = comparison !== null && isIdentical(comparison);
  const area = useRef<HTMLDivElement>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="compare-view">
      <div
        data-testid="compare-bar"
        className={cn(
          'flex h-10 shrink-0 items-center gap-5 border-b border-line-tabs max-lg:h-11 max-lg:gap-2',
          SIDES,
          'max-lg:pr-1 md:max-lg:pr-3',
        )}
      >
        <p className="min-w-0 flex-1 text-[13px] font-semibold leading-4 text-ink max-lg:text-[14px]">
          {m.compare.comparing}
        </p>
        <BarButton onClick={onChange}>{m.compare.change}</BarButton>
        <BarButton onClick={onClose} aria-label={m.compare.closeComparison}>
          {m.common.close}
          <span aria-hidden="true" className="text-[16px] font-normal">
            ×
          </span>
        </BarButton>
      </div>

      <div
        data-testid="compare-header"
        className={cn('flex shrink-0 flex-col gap-2 pt-3 max-lg:gap-1', SIDES)}
      >
        <ComparedLine mark="removed" item={open} open />
        <ComparedLine mark="added" item={chosenItem} />
      </div>

      <Tabs
        value={view}
        onValueChange={(next) => {
          onViewChange(next as CompareViewName);
          area.current?.scrollTo({ top: 0 });
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="border-t-0 max-md:px-4 md:max-lg:px-6">
          {COMPARE_VIEWS.map((name) => {
            const differs = comparison?.[name].differs ?? false;

            return (
              <TabsTrigger key={name} value={name} className="flex items-center gap-[5px]">
                {COMPARE_VIEW_LABELS[name]}
                {differs ? (
                  <>
                    <span
                      data-testid="differs-dot"
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full bg-accent"
                    />
                    <span className="sr-only">{m.compare.differs}</span>
                  </>
                ) : null}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {/* The one scroll of the panel, down only, as the request half's (D149). */}
        <div ref={area} data-testid="tab-area" className="min-h-0 flex-1 overflow-y-auto">
          {comparison === null ? (
            <div className={cn('pb-5 pt-[18px] max-md:pb-4 max-md:pt-3', SIDES)}>
              <Pending item={chosenItem} chosen={chosen} onChange={onChange} onRetry={onRetry} />
            </div>
          ) : (
            COMPARE_VIEWS.map((name) => (
              <TabsContent
                key={name}
                value={name}
                className="max-md:px-4 max-md:pb-4 max-md:pt-3 md:max-lg:px-6 md:max-lg:pt-4"
              >
                <ViewBody
                  name={name}
                  comparison={comparison[name]}
                  identical={identical}
                  open={open}
                  chosenItem={chosenItem}
                />
              </TabsContent>
            ))
          )}
        </div>
      </Tabs>
    </div>
  );
}

function BarButton({
  children,
  ...props
}: {
  children: ReactNode;
  onClick: () => void;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      {...props}
      className="flex shrink-0 items-center gap-1.5 rounded-[4px] text-[13px] font-medium leading-4 text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:h-11 max-lg:px-2 max-lg:text-[15px]"
    >
      {children}
    </button>
  );
}

function shortId(id: string): string {
  return id.slice(0, REQUEST_ID_DISPLAY_LENGTH);
}

/** `−` or `+`, the 16 px pill drawn in the header, in the list and beside both sizes. */
export function DiffMark({ mark, className }: { mark: 'removed' | 'added'; className?: string }) {
  const m = useMessages();

  return (
    <span
      data-testid={mark === 'removed' ? 'mark-removed' : 'mark-added'}
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[12px] font-semibold leading-4',
        mark === 'removed' ? 'bg-diff-removed-mark text-danger' : 'bg-diff-added-mark text-ok',
        className,
      )}
    >
      <span aria-hidden="true">{mark === 'removed' ? '−' : '+'}</span>
      <span className="sr-only">
        {mark === 'removed' ? m.compare.openMinus : m.compare.chosenPlus}
      </span>
    </span>
  );
}

interface ComparedLineProps {
  mark: 'removed' | 'added';
  item: RequestListItem;
  /** The open request says so. */
  open?: boolean;
}

/** One request of the pair: its mark, method, short id, full time and body size. */
function ComparedLine({ mark, item, open = false }: ComparedLineProps) {
  const m = useMessages();

  return (
    <p
      data-testid={mark === 'removed' ? 'compared-open' : 'compared-chosen'}
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] leading-4"
    >
      <DiffMark mark={mark} />
      <span className="font-semibold text-method">{item.method}</span>
      <span className="text-[13px] font-semibold text-ink-id">{shortId(item.id)}</span>
      <span className="flex flex-wrap items-center gap-x-2 text-ink-muted max-md:gap-x-1">
        <span>{formatTimestamp(item.receivedAt)}</span>
        <span aria-hidden="true">·</span>
        <span>{formatBytesCompact(item.bodySize)}</span>
        {open ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{m.list.open}</span>
          </>
        ) : null}
      </span>
    </p>
  );
}

interface PendingProps {
  item: RequestListItem;
  /** `loaded` only for the render before the comparison is computed: drawn as loading. */
  chosen: ChosenDetails;
  onChange: () => void;
  onRetry: () => void;
}

/** The chosen request while it loads, once it is gone (D4), or when it could not be loaded. */
function Pending({ item, chosen, onChange, onRetry }: PendingProps) {
  const m = useMessages();
  const name = `${item.method} ${shortId(item.id)}`;

  if (chosen.status === 'loading' || chosen.status === 'loaded') {
    return <p className="text-[13px] text-ink-muted">{m.compare.loading(name)}</p>;
  }

  const gone = chosen.status === 'gone';

  return (
    <p data-testid={gone ? 'compare-gone' : 'compare-failed'} className="text-[13px] text-ink">
      {gone ? m.compare.gone(name) : m.compare.notLoaded(name)}
      <button
        type="button"
        onClick={gone ? onChange : onRetry}
        className="ml-3 rounded-[4px] font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:py-3"
      >
        {gone ? m.compare.chooseAnother : m.list.retry}
      </button>
    </p>
  );
}

interface ViewBodyProps {
  name: CompareViewName;
  comparison: ViewComparison;
  /** No view differs: D1's line above every view. */
  identical: boolean;
  open: RequestDetails;
  chosenItem: RequestListItem;
}

function ViewBody({ name, comparison, identical, open, chosenItem }: ViewBodyProps) {
  const m = useMessages();

  if (comparison.kind === 'lines') {
    const headline = identical
      ? m.compare.identical
      : comparison.differs
        ? null
        : noDifferencesLine(name, m);

    return (
      <div className="flex flex-col gap-3">
        {headline === null ? null : (
          <p data-testid="compare-headline" className="text-[13px] text-ink">
            {headline}
          </p>
        )}
        {comparison.rows.length === 0 ? null : <DiffBox rows={comparison.rows} />}
      </div>
    );
  }

  return (
    <div data-testid="compare-whole" className="flex flex-col gap-2">
      <p data-testid="compare-headline" className="text-[13px] font-medium text-ink">
        {comparison.kind === 'whole'
          ? wholeHeadline(name, comparison, formatBytesCompact, m)
          : m.compare.tooManyChanges}
      </p>
      {comparison.differs ? (
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] leading-4">
          <SizeOf mark="removed" item={open} size={comparison.sizes[0]} />
          <SizeOf mark="added" item={chosenItem} size={comparison.sizes[1]} />
        </p>
      ) : null}
      {comparison.kind === 'whole' ? (
        <p className="text-[12px] text-ink-muted">{wholeNote(comparison.reason, m)}</p>
      ) : null}
    </div>
  );
}

function SizeOf({
  mark,
  item,
  size,
}: {
  mark: 'removed' | 'added';
  item: RequestListItem;
  size: number;
}) {
  return (
    <span className="flex items-center gap-2">
      <DiffMark mark={mark} />
      <span className="font-semibold text-ink-strong">
        {item.method} {shortId(item.id)}
      </span>
      <span className="text-ink-muted">{formatBytesCompact(size)}</span>
    </span>
  );
}

/**
 * The one column of lines (Figma frame A2): unchanged lines plain, removed
 * lines on `#fcecec` with `−`, added lines on `#e8f5ee` with `+`, the changed
 * characters underlined in a darker tone, and folded runs as
 * `N unchanged lines · Show`. Every line wraps; the box never scrolls (D149).
 * `Show` opens that fold in place, for as long as the view is shown.
 */
const DiffBox = memo(function DiffBox({ rows }: { rows: readonly DiffRow[] }) {
  const m = useMessages();
  const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set());

  return (
    <div
      data-testid="diff-box"
      className="flex flex-col overflow-hidden rounded-lg border border-line-panel bg-code py-2"
    >
      {rows.map((row, index) => {
        if (row.kind !== 'fold') {
          return <DiffLineRow key={index} row={row} />;
        }

        if (shown.has(index)) {
          return (
            <Fragment key={index}>
              {row.lines.map((text, line) => (
                <DiffLineRow key={line} row={{ kind: 'same', text }} />
              ))}
            </Fragment>
          );
        }

        return (
          <div
            key={index}
            data-diff="fold"
            className="flex items-center gap-[10px] bg-panel-note py-1 pl-[31px] pr-4 text-[12px] leading-[18px] max-md:pl-[27px]"
          >
            <span className="text-ink-muted">{m.compare.unchangedLines(row.lines.length)}</span>
            <button
              type="button"
              onClick={() => setShown((current) => new Set(current).add(index))}
              className="rounded-[4px] font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {m.compare.show}
            </button>
          </div>
        );
      })}
    </div>
  );
});

function DiffLineRow({ row }: { row: Exclude<DiffRow, { kind: 'fold' }> }) {
  const m = useMessages();
  const removed = row.kind === 'removed';
  const added = row.kind === 'added';

  return (
    <div
      data-diff={row.kind}
      className={cn(
        'flex gap-3 pl-3 pr-4 font-mono text-[12px] leading-5 max-md:gap-2 max-md:pr-3',
        removed && 'bg-diff-removed',
        added && 'bg-diff-added',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('w-2 shrink-0 font-medium', removed ? 'text-danger' : 'text-ok')}
      >
        {removed ? '−' : added ? '+' : ' '}
      </span>
      {/* At least one line tall, so an empty line - the blank line between a
          raw request's head and its body, an empty line in a body - keeps its
          row, as the plain views draw it and as Figma frame A3 draws the Raw
          comparison. */}
      <span
        data-testid="diff-text"
        className="min-h-5 min-w-0 flex-1 whitespace-pre-wrap text-ink-body wrap-anywhere"
      >
        {removed ? (
          <span className="sr-only">{m.compare.removed}</span>
        ) : added ? (
          <span className="sr-only">{m.compare.added}</span>
        ) : null}
        {row.kind === 'same'
          ? row.text
          : splitByInlineRanges(row.text, row.marks).map((piece, index) =>
              piece.changed ? (
                <span
                  key={index}
                  data-testid="diff-changed"
                  className={cn(
                    'font-medium underline',
                    removed ? 'text-diff-removed-ink' : 'text-diff-added-ink',
                  )}
                >
                  {piece.text}
                </span>
              ) : (
                piece.text
              ),
            )}
      </span>
    </div>
  );
}
