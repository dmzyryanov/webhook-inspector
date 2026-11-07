import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { MAX_RESPONSE_RULES, type SessionResponseState } from '@webhook-inspector/shared';
import * as api from '../api/client.ts';
import { usePhoneLayout } from '../hooks/useDesktopLayout.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import { draftAfterPlacedRefusal } from '../lib/refused-field.ts';
import type { ResponseForm } from '../lib/response-config.ts';
import { selectionAfterRemoval } from '../lib/response-queue.ts';
import {
  addRule,
  canRemoveRules,
  describeRuleRow,
  describeRulesFailure,
  duplicateRule,
  editRulesDraft,
  evaluateRules,
  formatRulesCount,
  formatRulesFallback,
  heldRules,
  MAX_TYPED_METHOD_LENGTH,
  moveRule,
  placeRulesRefusal,
  OTHER_RULE_METHODS,
  removeRule,
  rowUnderPointer,
  RULE_METHOD_CHIPS,
  rulePathWarning,
  rulesDialogForms,
  rulesErrorsWithRefusal,
  rulesFailureAfterEdit,
  rulesFooterView,
  selectionAfterMove,
  shownRulesFailure,
  type HeldRulesFailure,
  type RuleErrors,
  type RuleForm,
  type RuleMethodChoice,
  type RulesDraft,
} from '../lib/response-rules.ts';
import { staysOpen, type OwnAnswerHandler } from '../lib/session-response.ts';
import { FieldError, ResponseFields } from './ResponseFields.tsx';
import { StepLink } from './ResponseQueueDialog.tsx';
import { DISABLED_ACTION } from './SessionResponseSwitch.tsx';
import { Button } from './ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeading,
  SHEET_ACTION,
  SHEET_ACTIONS,
  SheetSpacer,
} from './ui/dialog.tsx';

interface ResponseRulesDialogProps {
  sessionId: string;
  state: SessionResponseState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The page's response revision, read as a call starts (D152, D205). */
  responseRevision: () => number;
  /** The rules were saved; the answer is the state the session now has, with the revision its call started at. */
  onSaved: OwnAnswerHandler;
  /** Every rule was removed; the answer is the state the session now has, with the revision its call started at. */
  onRemoved: OwnAnswerHandler;
  /** The session is gone: the page moves to `Session not found`. */
  onUnavailable: () => void;
  /** Where focus goes when the dialog closes: the button it was reached from. */
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

/**
 * The Response rules dialog (issue #226, direction A; R4-R6, RT2, RP2, RP3),
 * modelled on the Response queue dialog (D205): the rules in order on the
 * left, each dragged by its `⋮⋮` to another place - or moved with the up and
 * down arrows on it - and the line saying what every other request gets;
 * the selected rule's method, path and response on the right; `Save rules`,
 * which sends the whole list in order (D246).
 *
 * It follows the session while nothing has been edited in it, so rules saved
 * in another tab show; from the first edit on it keeps the viewer's rules
 * (D152). While a save or a removal is in flight nothing closes it, so a
 * failure is shown with every rule still in place, and nothing in it can be
 * edited - no field, no rule added, duplicated, removed or moved - so it
 * shows exactly the list that was sent until a successful save closes it.
 *
 * On a tablet it keeps its two columns at 704 px, the list 236 px (RT2). On a
 * phone it is a full-screen sheet: the list, whose rows open a rule as a
 * screen of its own with `‹` back and `Done` (RP2, RP3), and Cancel and Save
 * rules pinned to the bottom.
 */
export function ResponseRulesDialog({
  sessionId,
  state,
  open,
  onOpenChange,
  responseRevision,
  onSaved,
  onRemoved,
  onUnavailable,
  returnFocusRef,
}: ResponseRulesDialogProps) {
  // Set by the panel while its call is in flight; read, not rendered.
  const busy = useRef(false);

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(staysOpen(next, busy.current))}>
      <DialogContent
        phone="sheet"
        aria-describedby="response-rules-description"
        className="max-h-[calc(100vh-48px)] w-[880px] overflow-y-auto md:max-lg:max-h-[calc(100dvh-48px)] md:max-lg:w-[704px]"
        onCloseAutoFocus={(event) => {
          // Opened from the quick switch, which has closed by then: focus is
          // returned by hand to the button both belong to.
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <RulesPanel
          sessionId={sessionId}
          state={state}
          responseRevision={responseRevision}
          onSaved={onSaved}
          onRemoved={onRemoved}
          onUnavailable={onUnavailable}
          onClose={() => onOpenChange(false)}
          onBusyChange={(value) => {
            busy.current = value;
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

type PanelProps = Pick<
  ResponseRulesDialogProps,
  'sessionId' | 'state' | 'responseRevision' | 'onSaved' | 'onRemoved' | 'onUnavailable'
> & { onClose: () => void; onBusyChange: (busy: boolean) => void };

function RulesPanel({
  sessionId,
  state,
  responseRevision,
  onSaved,
  onRemoved,
  onUnavailable,
  onClose,
  onBusyChange,
}: PanelProps) {
  const m = useMessages();
  // `null` until the viewer edits anything (D152).
  const [draft, setDraft] = useState<RulesDraft | null>(null);
  const [selected, setSelected] = useState<number | null>(() =>
    heldRules(state).length > 0 ? 0 : null,
  );
  // The rule open as a screen of its own on a phone (RP3), or `null` for the list.
  const [opened, setOpened] = useState<number | null>(null);
  const [busy, setBusy] = useState<'saving' | 'removing' | null>(null);
  const [failure, setFailure] = useState<HeldRulesFailure | null>(null);
  const [confirming, setConfirming] = useState(false);
  const phone = usePhoneLayout();

  const rules = rulesDialogForms(draft, state);
  const evaluation = evaluateRules(rules, m);
  // What the list and the editor draw: the dialog's own checks, and a refusal
  // the server placed at a rule (D257). Save reads the own checks alone.
  const errors = rulesErrorsWithRefusal(evaluation.errors, failure?.placed ?? null);
  const current =
    selected !== null && selected < rules.length ? selected : rules.length > 0 ? 0 : null;
  const full = rules.length >= MAX_RESPONSE_RULES;
  const removable = canRemoveRules(state);
  // A save or a removal in flight: the rules wait, read only, for its answer.
  const locked = busy !== null;

  // The rules went while this viewer was asked to confirm their removal: the
  // question goes with them, and a failed removal's message too.
  if (confirming && !removable) {
    setConfirming(false);
  }

  if (!removable && failure?.action === 'remove') {
    setFailure(null);
  }

  const shownFailure = shownRulesFailure(failure, m);
  const footer = rulesFooterView(
    { confirming, state, busy, failure: shownFailure, footerError: evaluation.footerError },
    m,
  );

  function edit(change: (list: RuleForm[]) => RuleForm[]): void {
    if (locked) {
      return;
    }

    // From the draft as it stands when React applies it: a drag moves a rule
    // on every row it passes, faster than the dialog is drawn again.
    setDraft((held) => editRulesDraft(held, state, change));
    setConfirming(false);

    if (rulesFailureAfterEdit(shownFailure) === null) {
      setFailure(null);
    }
  }

  function add(): void {
    if (full || locked) {
      return;
    }

    edit((list) => addRule(list, state.response));
    setSelected(rules.length);

    if (phone) {
      setOpened(rules.length);
    }
  }

  function duplicate(index: number): void {
    if (full || locked) {
      return;
    }

    edit((list) => duplicateRule(list, index));
    setSelected(index + 1);

    if (opened !== null) {
      setOpened(index + 1);
    }
  }

  function remove(index: number): void {
    if (locked) {
      return;
    }

    edit((list) => removeRule(list, index));
    setSelected(selectionAfterRemoval(index, rules.length - 1));
    setOpened(null);
  }

  function move(from: number, to: number): void {
    if (from === to || locked) {
      return;
    }

    edit((list) => moveRule(list, from, to));
    setSelected((held) =>
      selectionAfterMove(
        held !== null && held < rules.length ? held : rules.length > 0 ? 0 : null,
        from,
        to,
        rules.length,
      ),
    );
  }

  function editRule(index: number, change: Partial<RuleForm>): void {
    edit((list) => list.map((form, place) => (place === index ? { ...form, ...change } : form)));
  }

  function editResponse(index: number, change: Partial<ResponseForm>): void {
    edit((list) =>
      list.map((form, place) =>
        place === index ? { ...form, response: { ...form.response, ...change } } : form,
      ),
    );
  }

  async function run(
    kind: 'saving' | 'removing',
    call: () => Promise<SessionResponseState>,
    done: OwnAnswerHandler,
    sent: readonly RuleForm[] = [],
  ): Promise<void> {
    if (busy !== null) {
      return;
    }

    setBusy(kind);
    onBusyChange(true);
    setFailure(null);

    const startedAt = responseRevision();

    try {
      const next = await call();

      onBusyChange(false);
      done(next, startedAt);
    } catch (error) {
      // A refusal of the save placed at the rule its `field` names, among the
      // rules sent, which are the ones on screen: the list was read only
      // while the save was in flight (D257).
      const placed = kind === 'saving' ? placeRulesRefusal(error, sent) : null;
      const described = describeRulesFailure(
        error,
        kind === 'saving' ? 'save' : 'remove',
        m,
        placed,
      );

      if (described.kind === 'unavailable') {
        onUnavailable();

        return;
      }

      if (placed !== null) {
        // The rules sent stay on screen, so a save from another tab cannot
        // move the mark to another rule; on a phone the row is marked and
        // nothing opens (RP2).
        setDraft((held) => draftAfterPlacedRefusal(held, 'rules', sent));
        setSelected(placed.index);
      }

      // Every rule stays exactly as it was.
      setFailure({ action: described.action, error, placed });
    } finally {
      onBusyChange(false);
      setBusy(null);
    }
  }

  function runMain(): void {
    if (footer.main.call === 'remove') {
      void run('removing', () => api.setSessionRules(sessionId, []), onRemoved);

      return;
    }

    const request = evaluation.request;

    // Save rules is disabled until every rule is valid, so there is a request.
    if (request !== null) {
      void run('saving', () => api.setSessionRules(sessionId, request.rules), onSaved, rules);
    }
  }

  function askToRemove(): void {
    setFailure(null);
    setConfirming(true);
  }

  function keepRules(): void {
    setConfirming(false);

    if (failure?.action === 'remove') {
      setFailure(null);
    }
  }

  if (phone && opened !== null && opened < rules.length) {
    return (
      <PhoneRuleScreen
        sessionId={sessionId}
        index={opened}
        count={rules.length}
        form={rules[opened] as RuleForm}
        errors={errors[opened] ?? { response: {} }}
        full={full}
        disabled={locked}
        onEdit={(change) => editRule(opened, change)}
        onEditResponse={(change) => editResponse(opened, change)}
        onBack={() => setOpened(null)}
        onDuplicate={() => duplicate(opened)}
        onRemove={() => remove(opened)}
      />
    );
  }

  const asking = footer.asking;

  return (
    <>
      <div className="relative">
        <DialogHeading className="text-[22px] leading-[27px]" closeDisabled={locked}>
          {m.rules.title}
        </DialogHeading>
        <DialogPrimitive.Close
          aria-label={m.common.close}
          disabled={locked}
          className="absolute -right-1 top-0 flex size-7 items-center justify-center rounded-[7px] text-[20px] leading-none text-ink-mark hover:bg-canvas focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 max-md:hidden"
        >
          ×
        </DialogPrimitive.Close>
      </div>
      <DialogDescription
        id="response-rules-description"
        className="mt-1.5 leading-[19px] max-md:mt-4"
      >
        {m.rules.description}
      </DialogDescription>

      <div className="mt-5 flex items-start gap-6 max-md:flex-1 max-md:flex-col max-md:items-stretch max-md:gap-0">
        <div className="flex w-[300px] shrink-0 flex-col gap-1 md:max-lg:w-[236px] max-md:w-auto">
          {phone && rules.length === 0 ? <EmptyRule /> : null}

          <RuleList
            rules={rules}
            errors={errors}
            selected={phone ? null : current}
            phone={phone}
            disabled={locked}
            onSelect={(index) => {
              setSelected(index);

              if (phone) {
                setOpened(index);
              }
            }}
            onMove={move}
          />

          {/* What every other request gets: a dashed box under the list from
              768 px up (R4-R6, RT2), a row with a dashed dot on a phone (RP2). */}
          <div className="mt-1 rounded-[6px] border border-dashed border-line-strong px-2 py-2.5 text-[12px] leading-[15px] max-md:border-0 max-md:py-2 max-md:pl-[34px] max-md:text-[14px] max-md:leading-[20px]">
            <span
              aria-hidden="true"
              className="mr-2 hidden size-3 rounded-full border-[1.5px] border-dashed border-line-strong align-[-1px] max-md:inline-block"
            />
            <span className="block font-medium text-ink-muted max-md:inline">
              {m.rules.fallbackTitle}
            </span>
            <span className="mt-0.5 block text-placeholder max-md:ml-2 max-md:mt-0 max-md:inline">
              {formatRulesFallback(state, m)}
            </span>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              variant="quiet"
              disabled={full || locked}
              className="h-[38px] border-line py-0 font-medium leading-[18px] max-md:h-11"
              onClick={add}
            >
              {m.rules.addRule}
            </Button>
            <span className="flex-1" />
            <span className="text-[12px] leading-[15px] text-ink-muted">
              {formatRulesCount(rules.length)}
            </span>
          </div>

          {/* On a phone `Remove all rules` is a link under the list (RP2). */}
          {phone && removable && !asking ? (
            <button
              type="button"
              disabled={locked}
              className="mt-4 min-h-8 self-start text-[15px] font-medium text-danger hover:underline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
              onClick={askToRemove}
            >
              {m.rules.removeAll}
            </button>
          ) : null}
        </div>

        {phone ? null : (
          <div className="min-w-0 flex-1">
            {current === null ? (
              <EmptyRule />
            ) : (
              <RuleEditor
                sessionId={sessionId}
                index={current}
                form={rules[current] as RuleForm}
                errors={errors[current] ?? { response: {} }}
                full={full}
                disabled={locked}
                onEdit={(change) => editRule(current, change)}
                onEditResponse={(change) => editResponse(current, change)}
                onDuplicate={() => duplicate(current)}
                onRemove={() => remove(current)}
              />
            )}
          </div>
        )}
      </div>

      <SheetSpacer />
      <div
        className={cn(
          'mt-5 flex items-center gap-3 max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-2.5',
          SHEET_ACTIONS,
        )}
      >
        {footer.text === null ? (
          <p className="min-w-0 flex-1 text-[12px] leading-[17px] text-ink-muted max-md:hidden">
            {rules.length === 0 ? m.rules.savingHint : m.rules.dragHint}
          </p>
        ) : (
          <p
            role={footer.alert ? 'alert' : undefined}
            className={cn(
              'min-w-0 flex-1 text-[12px] leading-[17px] max-md:basis-full',
              footer.alert ? 'text-danger' : 'text-ink',
            )}
          >
            {footer.text}
          </p>
        )}

        {asking ? (
          <>
            <Button
              type="button"
              variant="quiet"
              disabled={locked}
              className={cn('h-[38px] py-0 font-medium leading-[18px]', SHEET_ACTION)}
              onClick={keepRules}
            >
              {m.rules.keep}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={locked}
              className={cn('h-[38px] py-0 leading-[18px]', SHEET_ACTION)}
              onClick={runMain}
            >
              {footer.main.label}
            </Button>
          </>
        ) : (
          <>
            {removable ? (
              <Button
                type="button"
                variant="outlineDanger"
                disabled={locked}
                className="h-[38px] py-0 font-medium leading-[18px] max-md:hidden"
                onClick={askToRemove}
              >
                {m.rules.removeAll}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="quiet"
              disabled={locked}
              className={cn(
                'h-[38px] py-0 font-medium leading-[18px]',
                DISABLED_ACTION,
                SHEET_ACTION,
              )}
              onClick={onClose}
            >
              {m.common.cancel}
            </Button>
            <Button
              type="button"
              disabled={!evaluation.canSave || locked}
              className={cn('h-[38px] py-0 leading-[18px]', DISABLED_ACTION, SHEET_ACTION)}
              onClick={runMain}
            >
              {footer.main.label}
            </Button>
          </>
        )}
      </div>
    </>
  );
}

/** The DOM id of a rule's field, by the field's key. */
function ruleFieldId(index: number, key: string): string {
  return `rule-${index}-${key}`;
}

interface RuleListProps {
  rules: RuleForm[];
  errors: RuleErrors[];
  /** The rule highlighted, `null` for none: a phone's list selects nothing (RP2). */
  selected: number | null;
  phone: boolean;
  /** A call is in flight: the order waits. */
  disabled: boolean;
  onSelect: (index: number) => void;
  onMove: (from: number, to: number) => void;
}

/**
 * The rules in order, without borders (decided on 2026-10-19): `⋮⋮`, the
 * number, the method and the path, and under them `→` the status, its name
 * and the delay; on a phone one line ending in `›`, the answer on a second
 * only where the first is too short for it whole. A row's `⋮⋮` drags it to
 * another place, the row under the pointer giving way as it passes, and moves
 * it a place up or down from the keyboard.
 */
function RuleList({ rules, errors, selected, phone, disabled, onSelect, onMove }: RuleListProps) {
  const m = useMessages();
  const hintId = useId();
  const rows = useRef<(HTMLLIElement | null)[]>([]);
  const handles = useRef<(HTMLButtonElement | null)[]>([]);
  // The rule being dragged, by its place now, and the pointer dragging it.
  const drag = useRef<{ index: number; pointer: number } | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  // The handle that takes focus once a keyboard move has been drawn.
  const focusAfterMove = useRef<number | null>(null);

  useLayoutEffect(() => {
    const index = focusAfterMove.current;

    if (index !== null) {
      focusAfterMove.current = null;
      handles.current[index]?.focus();
    }
  });

  function startDrag(event: PointerEvent<HTMLButtonElement>, index: number): void {
    if (disabled || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { index, pointer: event.pointerId };
    setDragging(index);
  }

  function followDrag(event: PointerEvent<HTMLButtonElement>): void {
    const held = drag.current;

    if (held === null || held.pointer !== event.pointerId) {
      return;
    }

    const bounds = rules.map((_unused, index) => {
      const box = rows.current[index]?.getBoundingClientRect();

      return { top: box?.top ?? 0, bottom: box?.bottom ?? 0 };
    });
    const target = rowUnderPointer(bounds, event.clientY);

    if (target !== held.index) {
      onMove(held.index, target);
      drag.current = { index: target, pointer: held.pointer };
      setDragging(target);
    }
  }

  function endDrag(): void {
    drag.current = null;
    setDragging(null);
  }

  function moveByKey(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null;

    if (to === null || disabled) {
      return;
    }

    event.preventDefault();

    if (to < 0 || to >= rules.length) {
      return;
    }

    focusAfterMove.current = to;
    onMove(index, to);
  }

  if (rules.length === 0) {
    return null;
  }

  return (
    <>
      <p id={hintId} className="sr-only">
        {m.rules.moveHint}
      </p>
      <ol aria-label={m.rules.list} className="flex flex-col gap-1">
        {rules.map((form, index) => {
          const row = describeRuleRow(form, errors[index] ?? { response: {} }, m);

          return (
            <li
              key={index}
              ref={(element) => {
                rows.current[index] = element;
              }}
              className={cn(
                'relative flex items-stretch rounded-[6px]',
                selected === index ? 'bg-row-selected' : 'hover:bg-canvas',
                dragging === index
                  ? 'bg-row-selected shadow-[0_2px_8px_rgba(31,36,46,0.16)]'
                  : null,
              )}
            >
              <button
                ref={(element) => {
                  handles.current[index] = element;
                }}
                type="button"
                aria-label={m.rules.move(index + 1)}
                aria-describedby={hintId}
                disabled={disabled || rules.length < 2}
                onPointerDown={(event) => startDrag(event, index)}
                onPointerMove={followDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onLostPointerCapture={endDrag}
                onKeyDown={(event) => moveByKey(event, index)}
                className={cn(
                  'flex w-6 shrink-0 touch-none select-none items-center justify-center rounded-l-[6px] text-[11px] font-medium leading-none text-placeholder',
                  'cursor-grab focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
                  'disabled:cursor-default max-md:w-8 max-md:text-[13px]',
                  dragging === index ? 'cursor-grabbing' : null,
                )}
              >
                <span aria-hidden="true">⋮⋮</span>
              </button>
              <button
                type="button"
                aria-current={selected === index ? 'true' : undefined}
                aria-label={m.rules.ruleName(
                  index + 1,
                  row.method,
                  row.path,
                  row.code,
                  row.name,
                  row.delay,
                )}
                onClick={() => onSelect(index)}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2.5 py-2 pr-2 text-left',
                  'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
                  'max-md:min-h-[52px] max-md:py-1',
                )}
              >
                <span className="w-3 shrink-0 text-[11px] font-medium leading-[13px] text-placeholder max-md:text-[13px]">
                  {index + 1}
                </span>
                {/* From 768 px up two lines: the method and the path, then
                    the answer. On a phone one line, the answer right after
                    the path (RP2), the path cut where the line is short;
                    where even a few of its characters leave no room for the
                    whole answer, the answer takes a line of its own under
                    them and the path the rest of the first, so the answer is
                    read whole and nothing is drawn over anything (320 px). */}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 max-md:flex-row max-md:flex-wrap max-md:items-baseline max-md:gap-x-1.5 max-md:gap-y-0.5">
                  <span className="flex min-w-0 items-baseline gap-1.5 max-md:contents">
                    <span
                      data-testid="rule-method"
                      className={cn(
                        // A method typed under Other may be anything up to
                        // its field's bound: past 60 % of the row it is cut
                        // rather than pushing the row out of the list.
                        'max-w-[60%] shrink-0 truncate text-[12px] font-semibold leading-[15px] max-md:text-[16px] max-md:leading-[20px]',
                        row.invalid ? 'text-danger' : row.any ? 'text-ink-muted' : 'text-method',
                      )}
                    >
                      {row.method}
                    </span>
                    <span
                      data-testid="rule-path"
                      className={cn(
                        'min-w-[4ch] truncate text-[13px] font-medium leading-[16px] text-ink',
                        // On a phone it starts at a few characters and grows
                        // into whatever the line has left, up to its length.
                        'max-md:min-w-0 max-md:max-w-max max-md:flex-[1_1_4ch] max-md:text-[14px]',
                      )}
                    >
                      {row.path}
                    </span>
                  </span>
                  <span
                    data-testid="rule-answer"
                    className={cn(
                      'min-w-0 truncate text-[12px] leading-[15px] max-md:text-[14px]',
                      row.invalid ? 'text-danger' : 'text-ink-muted',
                    )}
                  >
                    → {row.code}
                    {row.name === null ? '' : ` ${row.name}`}
                    {row.delay === '' ? '' : ` · ${row.delay}`}
                  </span>
                </span>
                {phone ? (
                  <span aria-hidden="true" className="shrink-0 pl-1 text-[16px] text-ink-muted">
                    ›
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** The right column while there are no rules (R4), and the list's lead on a phone. */
function EmptyRule() {
  const m = useMessages();

  return (
    <div className="pt-1 max-md:pb-3">
      <p className="text-[15px] font-semibold leading-[18px] text-ink">{m.rules.noRulesTitle}</p>
      <p className="mt-2 max-w-[420px] text-[13px] leading-[19px] text-ink-muted">
        {m.rules.noRulesText}
      </p>
    </div>
  );
}

interface RuleFieldsProps {
  sessionId: string;
  index: number;
  form: RuleForm;
  errors: RuleErrors;
  onEdit: (change: Partial<RuleForm>) => void;
  onEditResponse: (change: Partial<ResponseForm>) => void;
}

const METHOD_CHOICES: readonly RuleMethodChoice[] = ['any', ...RULE_METHOD_CHIPS, 'other'];

/**
 * What a rule matches (R5): its method, as chips with `Other` for any other
 * method the receiver captures, typed; and its path, typed after the
 * session's URL, which the field draws before it, with the hint that says how
 * it is matched - under the field from 768 px up, over it on a phone (RP3).
 */
function RuleMatchFields({
  sessionId,
  index,
  form,
  errors,
  onEdit,
}: Omit<RuleFieldsProps, 'onEditResponse'>) {
  const m = useMessages();
  const methodsId = useId();
  const methodErrorId = useId();
  const pathHintId = useId();
  const pathErrorId = useId();
  const pathWarningId = useId();
  const pathInvalid = errors.path !== undefined;
  // Said, not refused: a doubled slash is a path a request may carry.
  const pathWarning = rulePathWarning(form.path, m);
  const pathDescribedBy = [
    pathHintId,
    pathInvalid ? pathErrorId : null,
    pathWarning === undefined ? null : pathWarningId,
  ]
    .filter((id) => id !== null)
    .join(' ');

  return (
    <>
      <div role="group" aria-labelledby={`${methodsId}-label`}>
        <p id={`${methodsId}-label`} className="text-[13px] font-medium leading-[18px] text-ink">
          {m.rules.method}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5 max-md:gap-2">
          {METHOD_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={form.method === choice}
              onClick={() => onEdit({ method: choice })}
              className={cn(
                'h-[29px] rounded-[6px] border px-2.5 text-[12px] font-medium leading-[15px] transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                'max-md:h-11 max-md:px-4 max-md:text-[14px] disabled:opacity-60',
                form.method === choice
                  ? 'border-brand bg-brand text-white'
                  : 'border-line bg-white text-ink hover:bg-canvas',
              )}
            >
              {choice === 'any'
                ? m.rules.anyMethod
                : choice === 'other'
                  ? m.rules.otherMethod
                  : choice}
            </button>
          ))}
        </div>
        {form.method === 'other' ? (
          <>
            <input
              id={ruleFieldId(index, 'method')}
              aria-label={m.rules.otherMethodLabel}
              aria-invalid={errors.method !== undefined}
              aria-describedby={errors.method === undefined ? undefined : methodErrorId}
              list={`${methodsId}-list`}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={MAX_TYPED_METHOD_LENGTH}
              placeholder="OPTIONS"
              value={form.otherMethod}
              onChange={(event) => onEdit({ otherMethod: event.target.value })}
              className={cn(
                'mt-2 h-[34px] w-[180px] max-w-full rounded-[6px] border bg-white px-2.5 font-mono text-[13px] text-ink',
                'placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                'disabled:opacity-60 max-md:h-11 max-md:w-full max-md:text-[16px]',
                errors.method === undefined ? 'border-line-strong' : 'border-danger',
              )}
            />
            <datalist id={`${methodsId}-list`}>
              {OTHER_RULE_METHODS.map((method) => (
                <option key={method} value={method} />
              ))}
            </datalist>
          </>
        ) : null}
        {errors.method === undefined ? null : (
          <div id={methodErrorId}>
            <FieldError>{errors.method}</FieldError>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-col">
        <label
          htmlFor={ruleFieldId(index, 'path')}
          className="block text-[13px] font-medium leading-[18px] text-ink"
        >
          {m.rules.path}
        </label>
        {/* Its input disabled while a save is in flight, the box, prefix and
            all, is drawn at 60 % as one field (issue #250). */}
        <div
          className={cn(
            'mt-1.5 flex h-[34px] min-w-0 items-center rounded-[6px] border bg-white px-2.5 text-[13px]',
            'focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent',
            'has-[:disabled]:opacity-60 max-md:order-2 max-md:mt-2 max-md:h-11 max-md:text-[16px]',
            pathInvalid ? 'border-danger' : 'border-line-strong',
          )}
        >
          {/* The session's URL, cut: the path is typed after its slash. */}
          <span
            aria-hidden="true"
            data-testid="rule-path-prefix"
            className="shrink-0 whitespace-nowrap text-placeholder"
          >
            <span className="max-md:hidden">/s/{sessionId.slice(0, 13)}…/</span>
            <span className="hidden max-md:inline">/s/{sessionId.slice(0, 8)}…/</span>
          </span>
          <input
            id={ruleFieldId(index, 'path')}
            aria-invalid={pathInvalid}
            aria-describedby={pathDescribedBy}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={form.path}
            onChange={(event) => onEdit({ path: event.target.value })}
            className="h-full min-w-0 flex-1 bg-transparent text-ink outline-none"
          />
        </div>
        <p
          id={pathHintId}
          className="mt-1.5 text-[12px] leading-[17px] text-ink-muted max-md:order-1"
        >
          {m.rules.pathHint}
        </p>
        {pathInvalid ? (
          <div id={pathErrorId} className="max-md:order-3">
            <FieldError>{errors.path}</FieldError>
          </div>
        ) : null}
        {pathWarning === undefined ? null : (
          <p
            id={pathWarningId}
            data-testid="rule-path-warning"
            className="mt-1.5 text-[12px] leading-[17px] text-notice-text max-md:order-3"
          >
            {pathWarning}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * The selected rule, on the right (R5, R6): its place, Duplicate and Remove
 * rule, then its fields; all of them disabled while a call is in flight, by
 * the fieldset they are in.
 */
function RuleEditor({
  sessionId,
  index,
  form,
  errors,
  full,
  disabled,
  onEdit,
  onEditResponse,
  onDuplicate,
  onRemove,
}: RuleFieldsProps & {
  full: boolean;
  disabled: boolean;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const m = useMessages();
  const headingId = useId();

  return (
    <fieldset disabled={disabled} aria-labelledby={headingId} className="min-w-0">
      <div className="flex items-baseline gap-2.5">
        <h3 id={headingId} className="shrink-0 text-[15px] font-semibold leading-[18px] text-ink">
          {m.rules.rule(index + 1)}
        </h3>
        <p className="min-w-0 truncate text-[12px] leading-[15px] text-ink-muted">
          {m.rules.checked(index + 1)}
        </p>
        <span className="min-w-0 flex-1" />
        <StepLink disabled={full} onClick={onDuplicate}>
          {m.rules.duplicate}
        </StepLink>
        <StepLink danger onClick={onRemove}>
          {m.rules.removeRule}
        </StepLink>
      </div>
      <div className="mt-4">
        <RuleMatchFields
          sessionId={sessionId}
          index={index}
          form={form}
          errors={errors}
          onEdit={onEdit}
        />
      </div>
      <div className="mt-4">
        <ResponseFields
          form={form.response}
          errors={errors.response}
          onEdit={onEditResponse}
          fieldId={(key) => ruleFieldId(index, key)}
          hints="phone"
          compactOnTablet
        />
      </div>
    </fieldset>
  );
}

/**
 * A rule as a screen of its own on a phone (RP3): `‹` back to the list, its
 * place, its fields with their hints, Duplicate rule and Remove rule, and
 * `Done` pinned to the bottom, which returns to the list with the rule kept.
 * While a call is in flight the fields and the two links are disabled, by the
 * fieldset they are in; `‹` and `Done` still go back.
 */
function PhoneRuleScreen({
  sessionId,
  index,
  count,
  form,
  errors,
  full,
  disabled,
  onEdit,
  onEditResponse,
  onBack,
  onDuplicate,
  onRemove,
}: RuleFieldsProps & {
  count: number;
  full: boolean;
  disabled: boolean;
  onBack: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const m = useMessages();
  const headingId = useId();

  return (
    <>
      <DialogPrimitive.Title className="sr-only">{m.rules.title}</DialogPrimitive.Title>
      <DialogDescription id="response-rules-description" className="sr-only">
        {m.rules.ruleOfList(index + 1, count)}
      </DialogDescription>
      <div className="sticky top-0 z-10 -mx-4 flex h-14 shrink-0 items-center gap-1 border-b border-line-header bg-white pl-1 pr-4">
        <button
          type="button"
          aria-label={m.rules.backToRules}
          className="flex size-11 shrink-0 items-center justify-center rounded-[7px] text-[24px] leading-none text-ink focus-visible:outline-2 focus-visible:outline-accent"
          onClick={onBack}
        >
          ‹
        </button>
        <h3 id={headingId} className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink">
          {m.rules.counter(index + 1, count)}
        </h3>
      </div>

      <fieldset disabled={disabled} aria-labelledby={headingId} className="min-w-0">
        <div className="mt-5">
          <RuleMatchFields
            sessionId={sessionId}
            index={index}
            form={form}
            errors={errors}
            onEdit={onEdit}
          />
        </div>
        <div className="mt-5">
          <ResponseFields
            form={form.response}
            errors={errors.response}
            onEdit={onEditResponse}
            fieldId={(key) => ruleFieldId(index, key)}
            hints="phone"
          />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
          <StepLink disabled={full} onClick={onDuplicate}>
            <span className="text-[15px]">{m.rules.duplicateRule}</span>
          </StepLink>
          <StepLink danger onClick={onRemove}>
            <span className="text-[15px]">{m.rules.removeRule}</span>
          </StepLink>
        </div>
      </fieldset>

      <SheetSpacer />
      <div className={cn('mt-5 flex', SHEET_ACTIONS)}>
        <Button type="button" className="h-11 flex-1 py-0 leading-[18px]" onClick={onBack}>
          {m.queue.done}
        </Button>
      </div>
    </>
  );
}
