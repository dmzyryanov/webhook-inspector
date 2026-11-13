import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { SessionResponseState } from '@webhook-inspector/shared';
import * as api from '../api/client.ts';
import { usePhoneLayout } from '../hooks/useDesktopLayout.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import {
  DELAY_CHIPS,
  STATUS_CHIPS,
  carryQuickDraft,
  quickSwitchPageInert,
  quickSwitchReturnsFocus,
  chooseInQuickSwitch,
  describeUntouched,
  evaluateQuickDraft,
  focusLost,
  quickSwitchView,
  statusUnavailableReason,
  type Choice,
  type QuickCarry,
  type QuickDraft,
} from '../lib/quick-switch.ts';
import {
  describeChangeFailure,
  shownChangeFailure,
  type HeldChangeFailure,
} from '../lib/response-editor.ts';
import {
  canRemoveQueue,
  describeQueueFailure,
  heldQueue,
  offersRunAgain,
  queueSectionRemoval,
  shownQueueFailure,
  type HeldQueueFailure,
} from '../lib/response-queue.ts';
import {
  canRemoveRules,
  describeRulesFailure,
  heldRules,
  rulesSectionRemoval,
  shownRulesFailure,
  type HeldRulesFailure,
} from '../lib/response-rules.ts';
import { isTemplate } from '../lib/response-template.ts';
import { classifySessionError } from '../lib/session-lifetime.ts';
import {
  formatKeptNote,
  formatResponseButtonLabel,
  formatResponseButtonName,
  keptCustomResponse,
  staysOpen,
  type OwnAnswerHandler,
  type ResponseMode,
} from '../lib/session-response.ts';
import { isLanguageSwitch } from './LanguageSwitch.tsx';
import { ResponseQueueSection } from './ResponseQueueSection.tsx';
import { ResponseRulesSection } from './ResponseRulesSection.tsx';
import { TemplateTag } from './TemplateControl.tsx';
import { Button } from './ui/button.tsx';
import { Dialog, DialogTrigger } from './ui/dialog.tsx';
import { SegmentedControl } from './ui/segmented.tsx';

/**
 * The disabled look the design gives Apply and Save (frames C1, C7, D4 and D7
 * of the Figma page `Webhook Inspector · Editable response settings`).
 */
export const DISABLED_ACTION =
  'disabled:border disabled:border-disabled-line disabled:bg-disabled disabled:text-disabled-ink disabled:opacity-100';

/** The two modes the switch offers, named in the interface's language. */
const MODES = ['default', 'custom'] as const satisfies readonly ResponseMode[];

interface SessionResponseSwitchProps {
  sessionId: string;
  state: SessionResponseState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The page's response revision, read as a call starts (D152, D205). */
  responseRevision: () => number;
  /**
   * The change was saved; the answer is the state the session now has, with
   * the revision its call started at.
   */
  onApplied: OwnAnswerHandler;
  /** The session is gone: the page moves to `Session not found`. */
  onUnavailable: () => void;
  /** `Edit headers and body…`, carrying whatever was chosen here, if anything. */
  onOpenEditor: (carry: QuickCarry | undefined) => void;
  /** `Set up a queue…` and `Edit queue…`: the Response queue dialog (D205). */
  onOpenQueue: () => void;
  /**
   * `Run again` started the queue from step 1; the answer is the state the
   * session now has, with the revision its call started at.
   */
  onQueueRestarted: OwnAnswerHandler;
  /**
   * The section's `Remove queue` removed the queue; the answer is the state
   * the session now has, with the revision its call started at. The quick
   * switch stays open and its section shows no queue (D206).
   */
  onQueueRemoved: OwnAnswerHandler;
  /** `Set up rules…` and `Edit rules…`: the Response rules dialog (issue #226). */
  onOpenRules: () => void;
  /**
   * The section's `Remove rules` removed every rule; the answer is the state
   * the session now has, with the revision its call started at. The quick
   * switch stays open and its section shows no rules, as after `Remove queue`.
   */
  onRulesRemoved: OwnAnswerHandler;
  /**
   * Whether the page has taken a `session.updated` with the queue at step 1
   * since a call started at that revision (`queueStartedSince`, D205).
   */
  queueStartedSince: (startedAt: number) => boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

/**
 * The endpoint-card button and the quick switch it opens (frames C1-C8 of the
 * Figma page `Webhook Inspector · Editable response settings`, D150): the
 * frequent change - Default or Custom, a status, a delay - in one popover, with
 * the full editor one link away.
 *
 * A non-modal Radix dialog anchored under the button: Escape and a click
 * outside close it, focus returns to the button, and the rest of the page stays
 * usable while it is open. Its content unmounts when it closes, so every
 * opening starts from the session as it is then. While a change is being
 * applied nothing closes it, so the answer - a failure included, with the
 * choice it keeps (frame C8) - always has a surface to be shown on.
 *
 * On a phone the button spans the card and the popover is a bottom sheet over
 * a scrim; a tap on the scrim is a click outside and closes it. The sheet is
 * rendered outside the page there, and the page under the scrim is made inert
 * while it is open, so it is neither tabbable nor read out behind the sheet.
 * On a tablet it stays the desktop's popover, with 44 px touch targets (frames
 * 5B and 7B of the Figma page `Webhook Inspector · Tablet and phone`, D157).
 */
export function SessionResponseSwitch({
  sessionId,
  state,
  open,
  onOpenChange,
  responseRevision,
  onApplied,
  onUnavailable,
  onOpenEditor,
  onOpenQueue,
  onQueueRestarted,
  onQueueRemoved,
  onOpenRules,
  onRulesRemoved,
  queueStartedSince,
  triggerRef,
}: SessionResponseSwitchProps) {
  const m = useMessages();
  // Set while the link hands over to the full editor, so that closing this
  // popover does not pull focus back to the button under the modal that is
  // opening at the same moment.
  const handingOver = useRef(false);
  // Set by the panel while its change is in flight; read, not rendered.
  const applying = useRef(false);
  const phone = usePhoneLayout();

  // The page under a phone's bottom sheet, which lives outside it, is inert
  // while the sheet is open.
  useEffect(() => {
    const page = document.getElementById('root');

    if (!quickSwitchPageInert({ open, phone }) || page === null) {
      return undefined;
    }

    page.inert = true;

    return () => {
      page.inert = false;
    };
  }, [open, phone]);

  const surface = (
    <DialogPrimitive.Content
      aria-describedby={undefined}
      // Changing the language changes the words, not what is open (D222).
      onInteractOutside={(event) => {
        if (isLanguageSwitch(event.target)) {
          event.preventDefault();
        }
      }}
      onCloseAutoFocus={(event) => {
        const returnFocus = quickSwitchReturnsFocus({ phone, handingOver: handingOver.current });

        if (handingOver.current) {
          handingOver.current = false;
          event.preventDefault();
        }

        // A tap on a phone's scrim is a click outside to Radix, which then
        // leaves focus on the page body; the sheet puts it back on the button.
        if (returnFocus) {
          event.preventDefault();
          triggerRef.current?.focus();
        }
      }}
      className={cn(
        'absolute right-0 top-[calc(100%+8px)] z-30 w-[400px] rounded-[10px] border border-line bg-white p-4',
        'shadow-[0_18px_48px_rgba(31,36,46,0.18)]',
        'max-md:fixed max-md:inset-x-0 max-md:top-auto max-md:bottom-0 max-md:z-50 max-md:max-h-[calc(100dvh-24px)]',
        'max-md:w-auto max-md:overflow-y-auto max-md:overscroll-contain max-md:rounded-none max-md:rounded-t-2xl',
        'max-md:border-0 max-md:px-4 max-md:pb-6 max-md:pt-0 max-md:shadow-[0_-4px_12px_rgba(31,36,46,0.18)]',
      )}
    >
      <div aria-hidden="true" className="hidden justify-center pb-3.5 pt-2 max-md:flex">
        <span className="h-1 w-9 rounded-[2px] bg-line" />
      </div>
      <QuickSwitchPanel
        sessionId={sessionId}
        state={state}
        responseRevision={responseRevision}
        onApplied={onApplied}
        onUnavailable={onUnavailable}
        onApplyingChange={(busy) => {
          applying.current = busy;
        }}
        onOpenEditor={(carry) => {
          handingOver.current = true;
          onOpenEditor(carry);
        }}
        onOpenQueue={() => {
          handingOver.current = true;
          onOpenQueue();
        }}
        onQueueRestarted={onQueueRestarted}
        onQueueRemoved={onQueueRemoved}
        onOpenRules={() => {
          handingOver.current = true;
          onOpenRules();
        }}
        onRulesRemoved={onRulesRemoved}
        queueStartedSince={queueStartedSince}
      />
    </DialogPrimitive.Content>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => onOpenChange(staysOpen(next, applying.current))}
      modal={false}
    >
      <div className="relative shrink-0 max-md:w-full">
        <DialogTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={formatResponseButtonName(
              state.response,
              heldQueue(state),
              m,
              heldRules(state),
            )}
            // `line-strong`, as the `quiet` Button: with `line` on white it
            // read smaller than the filled Copy beside it (D158).
            className={cn(
              'inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-[7px] border border-line-strong bg-white px-4',
              'text-[13px] font-medium leading-[18px] text-ink transition-colors hover:bg-canvas',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              'data-[state=open]:bg-pressed',
              'max-lg:h-11 max-md:w-full max-md:justify-center',
              // A phone's full-width button wraps a long label rather than
              // run past the card: `Свой · 201 · 30000 ms · 10 в очереди ·
              // 20 правил` is wider than 320 px (issue #226).
              'max-md:h-auto max-md:min-h-11 max-md:whitespace-normal max-md:py-3 max-md:text-center',
            )}
          >
            {formatResponseButtonLabel(state.response, heldQueue(state), m, heldRules(state))}
            <svg aria-hidden="true" width="7" height="4" viewBox="0 0 7 4" className="shrink-0">
              <path d="M0 0h7L3.5 4z" fill="currentColor" />
            </svg>
          </button>
        </DialogTrigger>

        {phone ? (
          <DialogPrimitive.Portal>
            <div aria-hidden="true" className="fixed inset-0 z-40 bg-ink/45" />
            {surface}
          </DialogPrimitive.Portal>
        ) : (
          surface
        )}
      </div>
    </Dialog>
  );
}

type PanelProps = Pick<
  SessionResponseSwitchProps,
  | 'sessionId'
  | 'state'
  | 'responseRevision'
  | 'onApplied'
  | 'onUnavailable'
  | 'onOpenEditor'
  | 'onOpenQueue'
  | 'onQueueRestarted'
  | 'onQueueRemoved'
  | 'onOpenRules'
  | 'onRulesRemoved'
  | 'queueStartedSince'
> & { onApplyingChange: (applying: boolean) => void };

function QuickSwitchPanel({
  sessionId,
  state,
  responseRevision,
  onApplied,
  onUnavailable,
  onOpenEditor,
  onOpenQueue,
  onQueueRestarted,
  onQueueRemoved,
  onOpenRules,
  onRulesRemoved,
  queueStartedSince,
  onApplyingChange,
}: PanelProps) {
  const m = useMessages();
  // `null` until the viewer chooses anything; `quickSwitchView` decides what
  // is shown meanwhile and after (D152).
  const [draft, setDraft] = useState<QuickDraft | null>(null);
  const [applying, setApplying] = useState(false);
  // A failure is held, not its words, and described on render: in the
  // language shown then, which the `EN | RU` switch may change while this
  // non-modal popover stays open (D222).
  const [failure, setFailure] = useState<HeldChangeFailure | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
  // The section's `Remove queue` (D206): whether its row asks, the removal in
  // flight, its failure, and whether this viewer removed the queue here.
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeFailure, setRemoveFailure] = useState<HeldQueueFailure | null>(null);
  const [removedHere, setRemovedHere] = useState(false);
  // The rules section's `Remove rules` (issue #226), as the queue's above.
  const [confirmingRulesRemoval, setConfirmingRulesRemoval] = useState(false);
  const [removingRules, setRemovingRules] = useState(false);
  const [rulesRemoveFailure, setRulesRemoveFailure] = useState<HeldRulesFailure | null>(null);
  const [rulesRemovedHere, setRulesRemovedHere] = useState(false);
  const statusErrorId = useId();
  const delayErrorId = useId();
  const tooltipId = useId();
  const [tooltipShown, setTooltipShown] = useState(false);
  // Whether the reason on screen was brought up by a tap, where no hover or
  // blur will take it away again (D157).
  const hintByTap = useRef(false);
  const applyButton = useRef<HTMLButtonElement>(null);

  // A change that failed: Apply, disabled while it was in flight, may have
  // dropped the focus it held to the page's body, where a click outside
  // during the call leaves it too; it goes back to Apply, which now reads
  // `Try again` (frame C8 of the Figma page `Webhook Inspector · Editable
  // response settings`; issue #143, D206). Focus the viewer put on a control
  // meanwhile stays.
  useLayoutEffect(() => {
    if (failure !== null && focusLost(applyButton.current)) {
      applyButton.current?.focus();
    }
  }, [failure]);

  function hint(visible: boolean, byTap: boolean): void {
    hintByTap.current = visible && byTap;
    setTooltipShown(visible);
  }

  const shown = quickSwitchView(draft, state);
  const kept = keptCustomResponse(state);
  const evaluation = evaluateQuickDraft(shown, state, m);

  // A failed restart's message goes once the section no longer shows a
  // used-up queue, whichever came first: a restart whose answer was lost
  // usually has its own event arrive before the failure, so the message
  // would otherwise stay beside a queue that started again.
  if (restartFailed && !offersRunAgain(state)) {
    setRestartFailed(false);
  }

  // The queue went while the section asked to remove it - removed by another
  // viewer, or by this one whose answer was lost: the question goes with it
  // and does not come back with a queue saved later, and a failed removal's
  // message with it, whichever came first (frame E3 of the Figma page
  // `Webhook Inspector · Response queue (#106) — chosen, review 2`, as the
  // dialog's footer).
  const removable = canRemoveQueue(state);

  if (confirmingRemoval && !removable) {
    setConfirmingRemoval(false);
  }

  if (removeFailure !== null && !removable) {
    setRemoveFailure(null);
  }

  // A queue saved again since: there is no removal to tell of.
  if (removedHere && removable) {
    setRemovedHere(false);
  }

  // The rules went while the section asked to remove them - removed by
  // another viewer, or by this one whose answer was lost: the question goes
  // with them, and a failed removal's message with it.
  const rulesRemovable = canRemoveRules(state);

  if (confirmingRulesRemoval && !rulesRemovable) {
    setConfirmingRulesRemoval(false);
  }

  if (rulesRemoveFailure !== null && !rulesRemovable) {
    setRulesRemoveFailure(null);
  }

  if (rulesRemovedHere && rulesRemovable) {
    setRulesRemovedHere(false);
  }

  // Anything the popover sends is in flight: its other actions wait (D152).
  const busy = applying || restarting || removing || removingRules;
  const removal = queueSectionRemoval(
    {
      confirming: confirmingRemoval,
      state,
      removing,
      failure: shownQueueFailure(removeFailure, m),
    },
    m,
  );
  const rulesRemoval = rulesSectionRemoval(
    {
      confirming: confirmingRulesRemoval,
      state,
      removing: removingRules,
      failure: shownRulesFailure(rulesRemoveFailure, m),
    },
    m,
  );
  const shownFailure = shownChangeFailure(failure, 'quick switch', m);

  function choose(next: Partial<QuickDraft>): void {
    setDraft(chooseInQuickSwitch(draft, state, next));

    // A reason a tap brought up goes when something else is chosen. One that
    // hover or focus brought up follows the pointer and the focus, as before.
    if (hintByTap.current) {
      hint(false, false);
    }
  }

  async function apply(): Promise<void> {
    const request = evaluation.request;

    if (request === null || busy) {
      return;
    }

    setApplying(true);
    onApplyingChange(true);
    setFailure(null);

    // What the page held as the call started: its answer yields to anything
    // newer that arrives before it (D152, D205).
    const startedAt = responseRevision();

    try {
      const next = await api.changeSessionResponse(sessionId, request);

      onApplyingChange(false);
      onApplied(next, startedAt);
    } catch (error) {
      const described = describeChangeFailure(error, 'quick switch', m);

      if (described.kind === 'unavailable') {
        onUnavailable();

        return;
      }

      // The choice stays exactly as it was made (frame C8 of the Figma page
      // `Webhook Inspector · Editable response settings`).
      setFailure({ error });
    } finally {
      onApplyingChange(false);
      setApplying(false);
    }
  }

  /**
   * `Run again` (frame U8 of the Figma page `Webhook Inspector · Response
   * queue (#106) — chosen, review 2`): starts the saved queue from step 1
   * without sending it.
   * In flight it holds the popover open as Apply does, and a failure is said
   * under the section's links, the queue left as it was - unless the page has
   * taken a `session.updated` starting the queue from step 1 since the call
   * started: its own, whose answer was then lost, or another viewer's. A
   * capture may since have used up a one-step queue again, and the section
   * offers `Run again` once more, so saying the restart failed would be untrue.
   */
  async function runAgain(): Promise<void> {
    if (busy) {
      return;
    }

    setRestarting(true);
    onApplyingChange(true);
    setRestartFailed(false);

    const startedAt = responseRevision();

    try {
      const next = await api.restartSessionQueue(sessionId);

      onApplyingChange(false);
      onQueueRestarted(next, startedAt);
    } catch (error) {
      if (classifySessionError(error) === 'unavailable') {
        onUnavailable();

        return;
      }

      if (!queueStartedSince(startedAt)) {
        setRestartFailed(true);
      }
    } finally {
      onApplyingChange(false);
      setRestarting(false);
    }
  }

  /**
   * `Remove queue`: the section asks once, with no earlier failure shown
   * (frame E3 of the Figma page `Webhook Inspector · Response queue (#106) —
   * chosen, review 2`).
   */
  function askToRemove(): void {
    setRemoveFailure(null);
    setRestartFailed(false);
    setConfirmingRemoval(true);
  }

  /** `Keep queue`: the question goes, and a failed removal's message with it. */
  function keepQueue(): void {
    setConfirmingRemoval(false);
    setRemoveFailure(null);
  }

  /**
   * `Remove` (D206): removes the queue as the dialog's `Remove queue` does,
   * with the same call and the same rules for its answer (D205). In flight it
   * holds the popover open as Apply does. Removed, the popover stays open and
   * its section shows no queue; a failure keeps the question's row, says so
   * in place of the question and offers `Try again`, which removes again.
   */
  async function removeQueue(): Promise<void> {
    if (busy) {
      return;
    }

    setRemoving(true);
    onApplyingChange(true);
    setRemoveFailure(null);

    const startedAt = responseRevision();

    try {
      const next = await api.removeSessionQueue(sessionId);

      onApplyingChange(false);
      onQueueRemoved(next, startedAt);
      setConfirmingRemoval(false);
      setRemovedHere(true);
    } catch (error) {
      const described = describeQueueFailure(error, 'remove', m);

      if (described.kind === 'unavailable') {
        onUnavailable();

        return;
      }

      setRemoveFailure({ action: described.action, error });
    } finally {
      onApplyingChange(false);
      setRemoving(false);
    }
  }

  /**
   * `Remove` under `Remove rules` (issue #226): saves no rules, `[]`, with
   * the dialog's call and the same rules for its answer (D152). In flight it
   * holds the popover open as Apply does; removed, the popover stays open and
   * its section shows no rules; a failure keeps the question's row and says
   * so in its place, with `Try again`.
   */
  async function removeRules(): Promise<void> {
    if (busy) {
      return;
    }

    setRemovingRules(true);
    onApplyingChange(true);
    setRulesRemoveFailure(null);

    const startedAt = responseRevision();

    try {
      const next = await api.setSessionRules(sessionId, []);

      onApplyingChange(false);
      onRulesRemoved(next, startedAt);
      setConfirmingRulesRemoval(false);
      setRulesRemovedHere(true);
    } catch (error) {
      const described = describeRulesFailure(error, 'remove', m);

      if (described.kind === 'unavailable') {
        onUnavailable();

        return;
      }

      setRulesRemoveFailure({ action: described.action, error });
    } finally {
      onApplyingChange(false);
      setRemovingRules(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <DialogPrimitive.Title className="text-[15px] font-semibold leading-[20px] text-ink max-md:text-[17px]">
          {m.quick.title}
        </DialogPrimitive.Title>
        <SegmentedControl
          label={m.quick.modeLabel}
          options={MODES.map((mode) => ({
            value: mode,
            label: mode === 'default' ? m.response.default : m.response.custom,
          }))}
          value={shown.mode}
          onChange={(mode) => choose({ mode })}
          size="sm"
        />
      </div>

      {shown.mode === 'default' ? (
        <div className="mt-4 rounded-[7px] bg-field px-3 py-2.5">
          <p className="text-[13px] font-medium leading-[18px] text-ink">
            {m.quick.defaultResponse}
          </p>
          <p className="mt-1 text-[12px] leading-[17px] text-ink-muted">
            {m.response.defaultSummary}
            {kept === null ? null : (
              <>
                <br />
                {formatKeptNote(kept, m)}
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          <Section title={m.quick.httpStatus}>
            <div className="relative flex flex-wrap gap-1.5 max-lg:gap-2">
              {STATUS_CHIPS.map((status) => {
                const reason = statusUnavailableReason(status, kept, m);
                const selected = shown.status.kind === 'chip' && shown.status.value === status;

                return reason === null ? (
                  <Chip
                    key={status}
                    selected={selected}
                    onClick={() => choose({ status: { kind: 'chip', value: status } })}
                  >
                    {status}
                  </Chip>
                ) : (
                  // Unavailable rather than disabled, so that it still takes
                  // hover and focus and can say why (frame C6 of the Figma
                  // page `Webhook Inspector · Editable response settings`:
                  // 204, 205 and 304 are refused while a body is set).
                  <Chip
                    key={status}
                    selected={false}
                    unavailable
                    describedBy={tooltipId}
                    onHint={hint}
                  >
                    {status}
                  </Chip>
                );
              })}
              <TypedField
                label={m.quick.otherStatus}
                placeholder={m.quick.other}
                choice={shown.status}
                invalid={evaluation.statusError !== null && shown.status.kind === 'typed'}
                describedBy={evaluation.statusError === null ? undefined : statusErrorId}
                onChange={(text) => choose({ status: { kind: 'typed', text } })}
              />
              {STATUS_CHIPS.some((status) => statusUnavailableReason(status, kept, m) !== null) ? (
                <p
                  id={tooltipId}
                  role="tooltip"
                  className={cn(
                    'pointer-events-none absolute left-[-15px] top-[38px] z-10 whitespace-nowrap rounded-[6px] bg-ink px-2.5 py-2',
                    'text-[12px] leading-[17px] text-white',
                    // Under the 44 px chips, and never wider than the sheet.
                    'max-lg:top-[50px] max-md:left-0 max-md:right-0 max-md:whitespace-normal',
                    tooltipShown ? 'block' : 'hidden',
                  )}
                >
                  {STATUS_CHIPS.map((status) => statusUnavailableReason(status, kept, m)).find(
                    (reason) => reason !== null,
                  )}
                </p>
              ) : null}
            </div>
            {evaluation.statusError === null ? null : (
              <p id={statusErrorId} className="mt-2 text-[12px] leading-[17px] text-danger">
                {evaluation.statusError}
              </p>
            )}
          </Section>

          <Section title={m.quick.delay}>
            <div className="flex flex-wrap gap-1.5 max-lg:gap-2">
              {DELAY_CHIPS.map((chip) => (
                <Chip
                  key={chip.ms}
                  selected={shown.delay.kind === 'chip' && shown.delay.value === chip.ms}
                  onClick={() => choose({ delay: { kind: 'chip', value: chip.ms } })}
                >
                  {m.quick.delayChip(chip.ms)}
                </Chip>
              ))}
              <TypedField
                label={m.quick.delayLabel}
                placeholder="ms"
                choice={shown.delay}
                invalid={evaluation.delayError !== null && shown.delay.kind === 'typed'}
                describedBy={evaluation.delayError === null ? undefined : delayErrorId}
                onChange={(text) => choose({ delay: { kind: 'typed', text } })}
              />
            </div>
            {evaluation.delayError === null ? null : (
              <p id={delayErrorId} className="mt-2 text-[12px] leading-[17px] text-danger">
                {evaluation.delayError}
              </p>
            )}
          </Section>

          <div className="mt-4 rounded-[7px] bg-field px-3 py-2.5">
            <p className="text-[12px] leading-[17px] text-ink-muted">
              {describeUntouched(kept, m)}
            </p>
            {/* A template is marked right of the link, at no extra height,
                white on this grey box (issue #236, frames T13 and T14 of the
                Figma page `Webhook Inspector · Response body templates (#236)
                — approved A`). */}
            <div className="mt-1 flex items-center justify-between gap-2">
              <button
                type="button"
                // Not while a change is being applied: its answer belongs to this
                // popover, which must still be open to show it.
                disabled={busy}
                className="group inline-flex items-center gap-1 text-[12px] font-medium leading-[17px] text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-60 max-lg:relative max-lg:min-h-8 max-md:text-[13px] max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-1.5"
                onClick={() => onOpenEditor(draft === null ? undefined : carryQuickDraft(shown))}
              >
                {m.quick.editHeadersAndBody}
                <span aria-hidden="true" className="hidden group-hover:inline">
                  →
                </span>
              </button>
              {isTemplate(kept) ? <TemplateTag onGrey /> : null}
            </div>
          </div>
        </>
      )}

      {shownFailure === null ? null : (
        <div role="alert" className="mt-4 rounded-[7px] bg-danger-soft px-3 py-2.5">
          <p className="text-[13px] font-medium leading-[18px] text-danger">{shownFailure.title}</p>
          <p className="mt-1 text-[12px] leading-[17px] text-danger">{shownFailure.text}</p>
        </div>
      )}

      {/* On a phone the line sits over a full-width Apply (frame 5B of the
          Figma page `Webhook Inspector · Tablet and phone`). */}
      <div className="mt-4 flex items-center justify-between gap-3 max-md:flex-col max-md:items-stretch">
        <p
          className={cn(
            'min-w-0 text-[12px] leading-[17px]',
            evaluation.footerIsChange ? 'text-ink' : 'text-ink-muted',
          )}
        >
          {evaluation.footer}
        </p>
        <Button
          ref={applyButton}
          className={cn('h-[38px] shrink-0 py-0 leading-[18px]', DISABLED_ACTION, 'max-lg:h-11')}
          disabled={!evaluation.canApply || busy}
          onClick={() => void apply()}
        >
          {applying ? m.quick.applying : failure === null ? m.quick.apply : m.queue.tryAgain}
        </Button>
      </div>

      {/* After the session response and its Apply, below a line, in Default
          and Custom alike (placement P1 of the Figma page `Webhook Inspector
          · Response queue (#106) — chosen, review 2`, D205); it collapses to
          its heading row (D206). */}
      <ResponseQueueSection
        state={state}
        busy={busy}
        applying={applying}
        restarting={restarting}
        failure={restartFailed ? m.queue.restartFailed : null}
        onOpenQueue={onOpenQueue}
        onRunAgain={() => void runAgain()}
        removal={removal}
        onAskToRemove={askToRemove}
        onKeepQueue={keepQueue}
        onRemoveQueue={() => void removeQueue()}
        removedNote={removedHere ? m.queue.removed : null}
      />

      {/* Under the queue's, drawn as it is (issue #226, frames R2, R3 and R7
          of the Figma page `Webhook Inspector · Response rules (#134) — A
          APPROVED 2026-10-19`). */}
      <ResponseRulesSection
        state={state}
        busy={busy}
        applying={applying}
        onOpenRules={onOpenRules}
        removal={rulesRemoval}
        onAskToRemove={() => {
          setRulesRemoveFailure(null);
          setConfirmingRulesRemoval(true);
        }}
        onKeepRules={() => {
          setConfirmingRulesRemoval(false);
          setRulesRemoveFailure(null);
        }}
        onRemoveRules={() => void removeRules()}
        removedNote={rulesRemovedHere ? m.rules.removed : null}
      />
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <p className="mb-2 text-[12px] font-medium leading-[17px] text-ink-muted max-md:text-[13px] max-md:font-semibold max-md:text-ink">
        {title}
      </p>
      {children}
    </div>
  );
}

interface ChipProps {
  selected: boolean;
  children: ReactNode;
  onClick?: () => void;
  unavailable?: boolean;
  describedBy?: string;
  onHint?: (shown: boolean, byTap: boolean) => void;
}

function Chip({ selected, children, onClick, unavailable, describedBy, onHint }: ChipProps) {
  // The kind of pointer that pressed the chip last, which tells a tap's click
  // from a mouse's.
  const pointer = useRef('mouse');

  return (
    <button
      type="button"
      aria-pressed={unavailable ? undefined : selected}
      aria-disabled={unavailable ? true : undefined}
      aria-describedby={describedBy}
      // An unavailable chip says why on a tap too, where there is no hover and
      // a tap may not focus it. Hover is a pointer's that can hover: after a
      // tap a browser reports the finger leaving, which must not take the
      // reason away again (D157).
      onPointerDown={(event) => {
        pointer.current = event.pointerType;
      }}
      onClick={unavailable ? () => onHint?.(true, pointer.current === 'touch') : onClick}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') {
          onHint?.(true, false);
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'touch') {
          onHint?.(false, false);
        }
      }}
      onFocus={() => onHint?.(true, false)}
      onBlur={() => onHint?.(false, false)}
      className={cn(
        'h-8 rounded-[7px] border px-3 text-[13px] font-medium leading-[18px] transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        'max-lg:h-11 max-lg:px-4',
        unavailable
          ? 'cursor-not-allowed border-line-soft bg-white text-disabled-ink'
          : selected
            ? 'border-brand bg-brand text-white'
            : 'border-line bg-white text-ink hover:bg-canvas',
      )}
    >
      {children}
    </button>
  );
}

interface TypedFieldProps {
  label: string;
  placeholder: string;
  choice: Choice;
  invalid: boolean;
  describedBy: string | undefined;
  onChange: (text: string) => void;
}

/**
 * The free field beside the chips. Typing in it is the choice: it reads as
 * chosen while it holds the value, and picking a chip afterwards empties it.
 *
 * Its text, the placeholder included, is centred as the chips' labels are, and
 * a valid value is outlined in `line-strong`, the secondary controls' border,
 * rather than as the darkest line in the popover; untouched - empty, or
 * emptied by picking a chip - it keeps `line`, invalid `danger` (issue #61,
 * D158). A field typed into and then cleared is invalid, so one that is typed
 * and not invalid always holds a value.
 */
function TypedField({
  label,
  placeholder,
  choice,
  invalid,
  describedBy,
  onChange,
}: TypedFieldProps) {
  const typed = choice.kind === 'typed';

  return (
    <input
      aria-label={label}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      inputMode="numeric"
      placeholder={placeholder}
      value={typed ? choice.text : ''}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        'h-8 w-[60px] rounded-[7px] border bg-white px-[10px] text-center text-[13px] leading-[18px] text-ink',
        // 16 px on a phone, so iOS Safari does not zoom into it, and wide
        // enough there for a five-digit delay at that size (D157).
        'max-lg:h-11 max-lg:px-3 max-md:w-20 max-md:text-[16px] md:max-lg:w-[72px]',
        'placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        invalid ? 'border-danger' : typed ? 'border-line-strong' : 'border-line',
      )}
    />
  );
}
