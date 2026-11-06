import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionResponseState } from '@webhook-inspector/shared';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import { focusLost } from '../lib/quick-switch.ts';
import { queueSectionMemory } from '../lib/queue-section-open.ts';
import {
  describeQueueChips,
  fitQueueChips,
  isHastyRemoveClick,
  queueSectionFocusTarget,
  queueSectionRow,
  queueSectionView,
  type QueueChip,
  type QueueSectionRemovalView,
} from '../lib/response-queue.ts';

interface ResponseQueueSectionProps {
  state: SessionResponseState;
  /** `Set up a queue…` and `Edit queue…`: the Response queue dialog. */
  onOpenQueue: () => void;
  /** `Run again`. */
  onRunAgain: () => void;
  /** A change of this popover is in flight: its links wait (D152). */
  busy: boolean;
  /**
   * The popover's Apply is in flight: focus it dropped is Apply's to place
   * once it answers, so the section moves none meanwhile (issue #143).
   */
  applying: boolean;
  /** `Run again` itself is in flight. */
  restarting: boolean;
  /** Why `Run again` failed, or `null`. */
  failure: string | null;
  /** `Remove queue` and the question it asks in place of the links (D206). */
  removal: QueueSectionRemovalView;
  /** `Remove queue`: the row asks once. */
  onAskToRemove: () => void;
  /** `Keep queue`: the question goes, and a failed removal's message with it. */
  onKeepQueue: () => void;
  /** `Remove`, and `Try again` after a failed removal: removes the queue. */
  onRemoveQueue: () => void;
  /** Said to a screen reader once this viewer removed the queue here, or `null`. */
  removedNote: string | null;
}

/** The title, which names the section, and the part the heading row shows and hides. */
const TITLE_ID = 'response-queue-section-title';
const BODY_ID = 'response-queue-section-body';
/** The state on the right of the heading row, `Step N of M` or `Done`, which its name ends with. */
const STATE_ID = 'response-queue-section-state';

/** A link's shape, at 12 px, 13 px on a phone, and a 32 px touch target below 1024 px. */
const LINK_SHAPE =
  'relative text-[12px] font-medium leading-[15px] hover:underline ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ' +
  'disabled:pointer-events-none disabled:opacity-60 max-lg:min-h-8 max-md:text-[13px] ' +
  'max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-2';

/** A link of the section. */
const LINK = `${LINK_SHAPE} text-link`;

/** `Remove queue`, and the question's `Remove`: the removal's red (D206). */
const DANGER_LINK = `${LINK_SHAPE} text-danger`;

/**
 * The Response queue section at the bottom of the quick switch, below its
 * own line, in Default and Custom alike (P1, D205; collapsible since issue
 * #142, D206).
 *
 * Its heading row - the title, the state on the right and a chevron - is one
 * button that collapses and expands the section. Collapsed, only that row
 * shows, and its right side tells the state: the example chips while the
 * session has no queue (on a phone, where they sit under the title, the title
 * alone), `Step N of M` while a queue runs, `Done` once every step has
 * answered. Expanded, the section shows as before: example chips with no
 * queue; the next response in chips while it runs; `Done` with `Run again`
 * once used up (L1); and, with a queue, `Remove queue` at the end of the
 * links, which asks once in their place. Open or closed is remembered in this
 * browser (`queue-section-open.ts`): first collapsed, then as it was left.
 *
 * It follows every capture, clear and queue change the page learns of, so it
 * moves while it is open, collapsed or not.
 */
export function ResponseQueueSection({
  state,
  onOpenQueue,
  onRunAgain,
  busy,
  applying,
  restarting,
  failure,
  removal,
  onAskToRemove,
  onKeepQueue,
  onRemoveQueue,
  removedNote,
}: ResponseQueueSectionProps) {
  const m = useMessages();
  const view = queueSectionView(state, m);
  const [open, setOpen] = useState(() => queueSectionMemory.isOpen());
  const section = useRef<HTMLElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const removeLink = useRef<HTMLButtonElement>(null);
  const runAgainButton = useRef<HTMLButtonElement>(null);
  // The state last remembered: each toggle the page draws is written once,
  // and two toggles in one task, which flip it twice, leave it as it was.
  const rememberedOpen = useRef(open);
  // When the question last appeared, for `isHastyRemoveClick` (D206).
  const askedAt = useRef(Number.NEGATIVE_INFINITY);
  // The row that asks replaces the links, the links come back in its place,
  // a queue's links and `Set up a queue…` give way to each other as a queue
  // comes and goes, and `Run again` goes as a used-up queue starts from step
  // 1 again, so the control that had focus goes with the row it was in.
  // Focus lost so moves to the control `queueSectionFocusTarget` names, the
  // heading row where that one is not drawn - the section collapsed. Focus
  // the viewer put elsewhere stays, and so does focus Apply dropped while it
  // is in flight, which its own answer places (issue #143).
  const row = queueSectionRow(view.kind, removal);
  const shownRow = useRef(row);

  useLayoutEffect(() => {
    const previous = shownRow.current;

    if (previous === row) {
      return;
    }

    shownRow.current = row;

    if (row === 'asking') {
      askedAt.current = performance.now();
    }

    const target = queueSectionFocusTarget(previous, row);

    if (target === null || applying || !focusLost(section.current)) {
      return;
    }

    const control =
      target === 'keep-queue'
        ? keepButton.current
        : target === 'remove-queue'
          ? removeLink.current
          : toggleButton.current;

    (control ?? toggleButton.current)?.focus();
  }, [row, applying]);

  // A removal that failed: the removal's button, now `Try again`, was
  // disabled while the call was in flight, so the focus it held may have
  // fallen to the page's body or the popover itself; it goes to `Try again`,
  // the control that now retries.
  useLayoutEffect(() => {
    if (removal.alert && focusLost(section.current)) {
      removeButton.current?.focus();
    }
  }, [removal.alert]);

  // A `Run again` that failed, said under the links: disabled in flight, it
  // may have dropped its focus the same way; it goes back to `Run again`,
  // beside the message, or to the heading row where the section was
  // collapsed meanwhile (issue #143).
  const restartFailed = failure !== null;

  useLayoutEffect(() => {
    if (restartFailed && focusLost(section.current)) {
      (runAgainButton.current ?? toggleButton.current)?.focus();
    }
  }, [restartFailed]);

  useEffect(() => {
    if (rememberedOpen.current === open) {
      return;
    }

    rememberedOpen.current = open;
    queueSectionMemory.remember(open);
  }, [open]);

  function toggle(): void {
    setOpen((current) => !current);
  }

  return (
    <section
      ref={section}
      aria-labelledby={TITLE_ID}
      className="mt-4 border-t border-line-section pt-4"
    >
      <h3 className="text-[13px] leading-[16px] max-md:text-[15px]">
        <button
          ref={toggleButton}
          type="button"
          aria-expanded={open}
          aria-controls={BODY_ID}
          // Named by the title and the state, never by the example chips,
          // which only illustrate: `Response queue`,
          // `Response queue Step 2 of 7`, `Response queue Done`.
          aria-labelledby={view.kind === 'none' ? TITLE_ID : `${TITLE_ID} ${STATE_ID}`}
          onClick={toggle}
          // A 44 px touch target below 1024 px (D157).
          className={cn(
            'flex w-full items-center gap-2.5 rounded-[4px] text-left',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            'max-lg:min-h-11',
          )}
        >
          <span id={TITLE_ID} className="shrink-0 font-semibold text-ink">
            {m.queue.title}
          </span>
          {view.kind === 'none' ? <ExampleChips className="max-md:hidden" /> : null}
          <span className="min-w-0 flex-1" />
          {view.kind === 'running' ? (
            <span
              id={STATE_ID}
              className="shrink-0 text-[12px] font-medium leading-[15px] text-ink-muted max-md:text-[13px]"
            >
              {view.counter}
            </span>
          ) : view.kind === 'done' ? (
            <span
              id={STATE_ID}
              className="shrink-0 rounded-[4px] bg-panel-note px-1.5 py-0.5 text-[11px] font-medium leading-[13px] text-ink-muted"
            >
              {m.queue.done}
            </span>
          ) : null}
          <Chevron open={open} />
        </button>
      </h3>

      <div id={BODY_ID} hidden={!open}>
        {!open ? null : view.kind === 'none' ? (
          <>
            {/* On a phone the chips sit under the title (M1). */}
            <ExampleChips className="mt-2 hidden max-md:flex" />
            <p className="mt-1.5 text-[12px] leading-[17px] text-ink-muted max-md:text-[13px] max-md:leading-[19px]">
              {m.queue.noQueue}
            </p>
            <div className="mt-1.5 flex items-center gap-3.5 max-md:mt-3">
              <button type="button" className={LINK} disabled={busy} onClick={onOpenQueue}>
                {m.queue.setUp}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-[12px] leading-[15px] text-ink-muted max-md:text-[13px] max-md:leading-[17px]">
              {view.lead}
            </p>
            <p className="sr-only">{describeQueueChips(view.chips, m)}</p>
            <ChipRow chips={view.chips} kept={view.kept} />
            {/* Keyed apart, so that neither row's buttons are reused for the
                other's: `Remove queue` would become the question's `Remove`
                with focus still on it. */}
            {removal.asking ? (
              // The question in place of the links, as the dialog's footer
              // asks it (E3); a failed removal says so in its place.
              <div key="asking" className="mt-2 flex items-center gap-3.5 max-md:mt-3">
                {/* `text-pretty`: a failure that wraps keeps `Try again.`
                    together rather than leave `again.` alone on a line. */}
                <p
                  role={removal.alert ? 'alert' : undefined}
                  className={cn(
                    'min-w-0 flex-1 text-pretty text-[12px] font-medium leading-[15px] max-md:text-[13px] max-md:leading-[17px]',
                    removal.alert ? 'text-danger' : 'text-ink',
                  )}
                >
                  {removal.text}
                </p>
                <button
                  ref={keepButton}
                  type="button"
                  className={cn(LINK, 'shrink-0')}
                  disabled={busy}
                  onClick={onKeepQueue}
                >
                  {m.queue.keep}
                </button>
                <button
                  ref={removeButton}
                  type="button"
                  className={cn(DANGER_LINK, 'shrink-0 font-semibold')}
                  disabled={busy}
                  onClick={(event) => {
                    // It appears under the pointer that clicked `Remove
                    // queue`: the second click of a double-click, or a tap
                    // right after, has not read the question (D206).
                    const sinceAsked = event.nativeEvent.timeStamp - askedAt.current;

                    if (isHastyRemoveClick(event.detail, sinceAsked)) {
                      return;
                    }

                    onRemoveQueue();
                  }}
                >
                  {removal.label}
                </button>
              </div>
            ) : (
              <div key="links" className="mt-2 flex items-center gap-3.5 max-md:mt-3">
                {view.kind === 'done' ? (
                  <button
                    ref={runAgainButton}
                    type="button"
                    className={LINK}
                    disabled={busy}
                    onClick={onRunAgain}
                  >
                    {restarting ? m.queue.starting : m.queue.runAgain}
                  </button>
                ) : null}
                <button type="button" className={LINK} disabled={busy} onClick={onOpenQueue}>
                  {m.queue.edit}
                </button>
                {removal.offered ? (
                  <button
                    ref={removeLink}
                    type="button"
                    className={cn(DANGER_LINK, 'ml-auto')}
                    disabled={busy}
                    onClick={onAskToRemove}
                  >
                    {m.queue.removeQueue}
                  </button>
                ) : null}
              </div>
            )}
          </>
        )}

        {!open || failure === null ? null : (
          <p role="alert" className="mt-2 text-[12px] leading-[17px] text-danger">
            {failure}
          </p>
        )}
      </div>

      {/* The section shows no queue once it is removed here; this says so. */}
      <p role="status" className="sr-only">
        {removedNote ?? ''}
      </p>
    </section>
  );
}

/** Down while collapsed, up while expanded: 12 px, 14 px below 1024 px. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      fill="none"
      className="size-3 shrink-0 text-ink-muted max-lg:size-3.5"
    >
      <path
        d={open ? 'M2.5 7.5 6 4l3.5 3.5' : 'M2.5 4.5 6 8l3.5-3.5'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** `201 → 404 · 2 s → 503`, the grey example beside the title (P1.1, U2). */
function ExampleChips({ className }: { className?: string }) {
  const m = useMessages();

  return (
    <span aria-hidden="true" className={cn('flex min-w-0 items-center gap-1', className)}>
      {m.queue.exampleChips.map((label, index) => (
        <span key={label} className="flex items-center gap-1">
          {index === 0 ? null : <Arrow />}
          <span className="whitespace-nowrap rounded-[4px] border border-line px-1.5 py-px text-[11px] font-medium leading-[13px] text-ink-muted">
            {label}
          </span>
        </span>
      ))}
    </span>
  );
}

function Arrow() {
  return (
    <span data-arrow="" className="shrink-0 text-[11px] leading-[13px] text-placeholder">
      →
    </span>
  );
}

/** The chip's look by what it stands for (`671:476`, `671:772`). */
const CHIP: Record<QueueChip['kind'], string> = {
  answered:
    'border border-line-soft bg-field px-1.5 py-px text-[11px] leading-[13px] text-disabled-ink',
  next: 'border-[1.5px] border-ink px-2 py-[3px] text-[13px] leading-[16px] text-ink',
  ahead: 'border border-line px-1.5 py-px text-[11px] leading-[13px] text-placeholder',
  session:
    'border border-dashed border-line-strong px-1.5 py-px text-[11px] leading-[13px] text-ink-muted',
  'session-next':
    'border-[1.5px] border-dashed border-ink px-2 py-[3px] text-[13px] leading-[16px] text-ink',
};

function Chip({ chip }: { chip: QueueChip }) {
  return (
    <span
      data-chip=""
      className={cn('shrink-0 whitespace-nowrap rounded-[4px] font-medium', CHIP[chip.kind])}
    >
      {chip.kind === 'answered' ? `✓ ${chip.label}` : chip.label}
    </span>
  );
}

/** The space between the items of the row, as the frames draw it. */
const GAP = 4;

/**
 * The chips on one line (N5): as many as fit, and an arrow and `…` after the
 * last one when the rest does not (P1.2). The chips are measured in a hidden
 * copy of the row and the decision is `fitQueueChips`, so a narrower popover,
 * a phone's sheet or a larger font cuts the row where it would overflow. It
 * is mounted only while the section is expanded, so it measures a row that
 * is drawn.
 */
function ChipRow({ chips, kept }: { chips: QueueChip[]; kept: number }) {
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ shown: chips.length, cut: false });
  const signature = chips.map((chip) => `${chip.kind}:${chip.label}`).join('|');

  useLayoutEffect(() => {
    const container = row.current;
    const copy = measure.current;

    if (container === null || copy === null) {
      return undefined;
    }

    const width = (element: Element | null | undefined): number =>
      element?.getBoundingClientRect().width ?? 0;

    function update(): void {
      if (container === null || copy === null) {
        return;
      }

      setFit(
        fitQueueChips(
          [...copy.querySelectorAll('[data-chip]')].map(width),
          {
            available: container.clientWidth,
            gap: GAP,
            arrow: width(copy.querySelector('[data-arrow]')),
            ellipsis: width(copy.querySelector('[data-ellipsis]')),
          },
          kept,
        ),
      );
    }

    update();

    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver(update);

    observer.observe(container);

    return () => observer.disconnect();
  }, [signature, kept]);

  const shown = chips.slice(0, fit.shown);

  return (
    <div ref={row} aria-hidden="true" className="relative mt-2 w-full overflow-hidden">
      <div className="flex items-center gap-1">
        {shown.map((chip, index) => (
          <span key={`${index}-${chip.label}`} className="flex shrink-0 items-center gap-1">
            {index === 0 ? null : <Arrow />}
            <Chip chip={chip} />
          </span>
        ))}
        {fit.cut ? (
          <>
            <Arrow />
            <span className="shrink-0 text-[12px] font-medium leading-[15px] text-placeholder">
              …
            </span>
          </>
        ) : null}
      </div>
      {/* The copy the chips are measured in: never seen, never read. */}
      <div
        ref={measure}
        className="invisible absolute left-0 top-0 flex items-center gap-1 whitespace-nowrap"
      >
        {chips.map((chip, index) => (
          <Chip key={`${index}-${chip.label}`} chip={chip} />
        ))}
        <Arrow />
        <span data-ellipsis="" className="text-[12px] font-medium leading-[15px]">
          …
        </span>
      </div>
    </div>
  );
}
