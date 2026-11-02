import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionResponseState } from '@webhook-inspector/shared';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import { focusLost } from '../lib/quick-switch.ts';
import { rulesSectionMemory } from '../lib/queue-section-open.ts';
import { isHastyRemoveClick } from '../lib/response-queue.ts';
import {
  RULE_EXAMPLE_CHIPS,
  rulesSectionFocusTarget,
  rulesSectionRow,
  rulesSectionView,
  type RulesSectionRemovalView,
} from '../lib/response-rules.ts';
import { Chevron } from './ResponseQueueSection.tsx';
import { TemplateTag } from './TemplateControl.tsx';

interface ResponseRulesSectionProps {
  state: SessionResponseState;
  /** `Set up rules…` and `Edit rules…`: the Response rules dialog. */
  onOpenRules: () => void;
  /** A change of this popover is in flight: its links wait (D152). */
  busy: boolean;
  /** The popover's Apply is in flight: focus it dropped is Apply's to place (issue #143). */
  applying: boolean;
  /** `Remove rules` and the question it asks in place of the links. */
  removal: RulesSectionRemovalView;
  /** `Remove rules`: the row asks once. */
  onAskToRemove: () => void;
  /** `Keep rules`: the question goes, and a failed removal's message with it. */
  onKeepRules: () => void;
  /** `Remove`, and `Try again` after a failed removal: removes every rule. */
  onRemoveRules: () => void;
  /** Said to a screen reader once this viewer removed the rules here, or `null`. */
  removedNote: string | null;
}

const TITLE_ID = 'response-rules-section-title';
const BODY_ID = 'response-rules-section-body';
/** `3 rules`, on the right of the heading row, which its name ends with. */
const STATE_ID = 'response-rules-section-state';

/** A link's shape, as the queue's section draws its own: 12 px, 13 px on a phone, 32 px tall below 1024 px. */
const LINK_SHAPE =
  'relative text-[12px] font-medium leading-[15px] hover:underline ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ' +
  'disabled:pointer-events-none disabled:opacity-60 max-lg:min-h-8 max-md:text-[13px] ' +
  'max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-2';

const LINK = `${LINK_SHAPE} text-link`;
const DANGER_LINK = `${LINK_SHAPE} text-danger`;

/**
 * The Response rules section of the quick switch, under the Response queue
 * section and drawn as it is (issue #226; R2, R3, R7, RT1, RP1, RP5).
 *
 * Its heading row - the title, `3 rules` on the right while the session has
 * rules, the example chips while it has none (not on a phone), and a chevron
 * - is one button that collapses and expands the section, remembered open or
 * closed in this browser apart from the queue's (`queue-section-open.ts`):
 * first collapsed, then as it was left. Expanded with no rules it says what a
 * rule does and offers `Set up rules…`; with rules it lists them in order -
 * number, method, path, `→` status and delay - then what every other request
 * gets, `Edit rules…` and `Remove rules`, which asks once in place of the
 * links, as `Remove queue` does (D206).
 *
 * It follows every change of the rules the page learns of, another tab's
 * included, collapsed or not.
 */
export function ResponseRulesSection({
  state,
  onOpenRules,
  busy,
  applying,
  removal,
  onAskToRemove,
  onKeepRules,
  onRemoveRules,
  removedNote,
}: ResponseRulesSectionProps) {
  const m = useMessages();
  const view = rulesSectionView(state, m);
  const [open, setOpen] = useState(() => rulesSectionMemory.isOpen());
  const section = useRef<HTMLElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const removeLink = useRef<HTMLButtonElement>(null);
  const rememberedOpen = useRef(open);
  // When the question last appeared, for `isHastyRemoveClick` (D206).
  const askedAt = useRef(Number.NEGATIVE_INFINITY);
  const row = rulesSectionRow(view.kind, removal);
  const shownRow = useRef(row);

  // The control that had focus goes with the row it was in: focus lost so
  // moves to the control `rulesSectionFocusTarget` names, as the queue's
  // section moves it (issue #143).
  useLayoutEffect(() => {
    const previous = shownRow.current;

    if (previous === row) {
      return;
    }

    shownRow.current = row;

    if (row === 'asking') {
      askedAt.current = performance.now();
    }

    const target = rulesSectionFocusTarget(previous, row);

    if (target === null || applying || !focusLost(section.current)) {
      return;
    }

    const control =
      target === 'keep'
        ? keepButton.current
        : target === 'remove'
          ? removeLink.current
          : toggleButton.current;

    (control ?? toggleButton.current)?.focus();
  }, [row, applying]);

  // A removal that failed: its button, disabled in flight, may have dropped
  // the focus it held; it goes to `Try again`.
  useLayoutEffect(() => {
    if (removal.alert && focusLost(section.current)) {
      removeButton.current?.focus();
    }
  }, [removal.alert]);

  useEffect(() => {
    if (rememberedOpen.current === open) {
      return;
    }

    rememberedOpen.current = open;
    rulesSectionMemory.remember(open);
  }, [open]);

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
          // Named by the title and the count, never by the example chips:
          // `Response rules`, `Response rules 3 rules`.
          aria-labelledby={view.kind === 'none' ? TITLE_ID : `${TITLE_ID} ${STATE_ID}`}
          onClick={() => setOpen((current) => !current)}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-[4px] text-left',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            'max-lg:min-h-11',
          )}
        >
          <span id={TITLE_ID} className="shrink-0 font-semibold text-ink">
            {m.rules.title}
          </span>
          {view.kind === 'none' ? <ExampleChips /> : null}
          <span className="min-w-0 flex-1" />
          {view.kind === 'rules' ? (
            <span
              id={STATE_ID}
              className="shrink-0 text-[12px] leading-[15px] text-ink-muted max-md:text-[13px]"
            >
              {view.count}
            </span>
          ) : null}
          <Chevron open={open} />
        </button>
      </h3>

      <div id={BODY_ID} hidden={!open}>
        {!open ? null : view.kind === 'none' ? (
          <>
            <p className="mt-1.5 text-[12px] leading-[17px] text-ink-muted max-md:text-[13px] max-md:leading-[19px]">
              {m.rules.noRules}
            </p>
            <div className="mt-1.5 flex items-center gap-3.5 max-md:mt-3">
              <button type="button" className={LINK} disabled={busy} onClick={onOpenRules}>
                {m.rules.setUp}
              </button>
            </div>
          </>
        ) : (
          <>
            <ol
              aria-label={m.rules.list}
              className="mt-1.5 flex flex-col gap-1 text-[12px] leading-[15px] max-md:mt-2.5 max-md:gap-1.5 max-md:text-[13px] max-md:leading-[17px]"
            >
              {view.rows.map((rule) => (
                <li key={rule.place} className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-placeholder">{rule.place}</span>
                  <span
                    className={cn(
                      'shrink-0 font-semibold',
                      rule.any ? 'text-ink-muted' : 'text-method',
                    )}
                  >
                    {rule.method}
                  </span>
                  {/* A path may be 1 KiB long: it alone gives way, cut with
                      an ellipsis, and says itself whole on hover. */}
                  <span
                    data-testid="rule-path"
                    title={rule.path}
                    className="min-w-0 truncate font-mono text-ink"
                  >
                    {rule.path}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-ink-muted">→ {rule.answer}</span>
                  {/* After the answer, as T13 and T14 mark a template (issue #236). */}
                  {rule.template ? <TemplateTag /> : null}
                </li>
              ))}
            </ol>
            <p className="mt-1 text-[12px] leading-[15px] text-placeholder max-md:mt-1.5 max-md:text-[13px] max-md:leading-[17px]">
              {view.fallback}
            </p>
            {/* Keyed apart, so that neither row's buttons are reused for the
                other's, as in the queue's section. */}
            {removal.asking ? (
              <div key="asking" className="mt-2 flex items-center gap-3.5 max-md:mt-3">
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
                  onClick={onKeepRules}
                >
                  {m.rules.keep}
                </button>
                <button
                  ref={removeButton}
                  type="button"
                  className={cn(DANGER_LINK, 'shrink-0 font-semibold')}
                  disabled={busy}
                  onClick={(event) => {
                    // It appears under the pointer that clicked `Remove
                    // rules`: a double-click or a quick second tap has not
                    // read the question (D206).
                    const sinceAsked = event.nativeEvent.timeStamp - askedAt.current;

                    if (isHastyRemoveClick(event.detail, sinceAsked)) {
                      return;
                    }

                    onRemoveRules();
                  }}
                >
                  {removal.label}
                </button>
              </div>
            ) : (
              <div key="links" className="mt-2 flex items-center gap-3.5 max-md:mt-3">
                <button type="button" className={LINK} disabled={busy} onClick={onOpenRules}>
                  {m.rules.edit}
                </button>
                {removal.offered ? (
                  <button
                    ref={removeLink}
                    type="button"
                    className={cn(DANGER_LINK, 'max-md:ml-auto')}
                    disabled={busy}
                    onClick={onAskToRemove}
                  >
                    {m.rules.removeRules}
                  </button>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>

      {/* The section shows no rules once they are removed here; this says so. */}
      <p role="status" className="sr-only">
        {removedNote ?? ''}
      </p>
    </section>
  );
}

/** `POST /orders` `GET /status`, the grey example beside the title (R2); not on a phone (RP1). */
function ExampleChips() {
  return (
    <span aria-hidden="true" className="flex min-w-0 items-center gap-1 max-md:hidden">
      {RULE_EXAMPLE_CHIPS.map((label) => (
        <span
          key={label}
          className="whitespace-nowrap rounded-[4px] border border-line px-1.5 py-px text-[11px] font-medium leading-[13px] text-ink-muted"
        >
          {label}
        </span>
      ))}
    </span>
  );
}
