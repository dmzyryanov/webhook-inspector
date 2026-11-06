import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { MAX_QUEUE_STEPS, type SessionResponseState } from '@webhook-inspector/shared';
import * as api from '../api/client.ts';
import { usePhoneLayout } from '../hooks/useDesktopLayout.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import { draftAfterPlacedRefusal } from '../lib/refused-field.ts';
import type { FormErrors, ResponseForm } from '../lib/response-config.ts';
import {
  addQueueStep,
  canRemoveQueue,
  describeQueueFailure,
  describeQueueStepRow,
  describeStepPlace,
  duplicateQueueStep,
  editQueueDraft,
  evaluateQueue,
  failureAfterEdit,
  failureOutsideRemoval,
  formatQueueCount,
  formatSessionResponse,
  initialQueueSelection,
  placeQueueRefusal,
  queueDialogSteps,
  queueErrorsWithRefusal,
  queueFooterView,
  queueStepMarkers,
  removeQueueStep,
  selectionAfterRemoval,
  shownQueueFailure,
  type HeldQueueFailure,
  type QueueDraft,
  type StepMarker,
} from '../lib/response-queue.ts';
import { staysOpen, type OwnAnswerHandler } from '../lib/session-response.ts';
import { ResponseFields } from './ResponseFields.tsx';
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

interface ResponseQueueDialogProps {
  sessionId: string;
  state: SessionResponseState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The page's response revision, read as a call starts (D152, D205). */
  responseRevision: () => number;
  /**
   * The queue was saved; the answer is the state the session now has, with
   * the revision its call started at.
   */
  onSaved: OwnAnswerHandler;
  /**
   * The queue was removed; the answer is the state the session now has, with
   * the revision its call started at.
   */
  onRemoved: OwnAnswerHandler;
  /** The session is gone: the page moves to `Session not found`. */
  onUnavailable: () => void;
  /** Where focus goes when the dialog closes: the button it was reached from. */
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

/**
 * The Response queue dialog (direction C, D205; frames U3-U5, D1, E1-E3, T2,
 * M3, M4): the steps as a timeline on the left, the selected step's fields on
 * the right - the response editor's own (`ResponseFields`) - and Save, which
 * starts the queue from step 1.
 *
 * It follows the session while nothing has been edited in it, so a request
 * that takes a step moves the timeline; from the first edit on it keeps the
 * viewer's steps (D152). While a save or a removal is in flight nothing
 * closes it - Escape, a click on the overlay and Cancel wait - so a failure is
 * shown with every step still in place (E2) - and nothing in it changes: the
 * step editor is read only until the answer, so what it shows is what was
 * sent (issue #234, as the Response rules dialog since #226). Another step can
 * still be selected, and on a phone opened and left again.
 *
 * On a tablet it keeps its two columns at 704 px, the list without status
 * names (T2). On a phone it is a full-screen sheet: the list, whose rows open
 * a step as a screen of its own with `‹` back and `Done` (M3, M4), and Cancel
 * and Save queue pinned to the bottom of the list.
 */
export function ResponseQueueDialog({
  sessionId,
  state,
  open,
  onOpenChange,
  responseRevision,
  onSaved,
  onRemoved,
  onUnavailable,
  returnFocusRef,
}: ResponseQueueDialogProps) {
  // Set by the panel while its call is in flight; read, not rendered.
  const busy = useRef(false);

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(staysOpen(next, busy.current))}>
      <DialogContent
        phone="sheet"
        aria-describedby="response-queue-description"
        className="max-h-[calc(100vh-48px)] w-[880px] overflow-y-auto md:max-lg:max-h-[calc(100dvh-48px)] md:max-lg:w-[704px]"
        onCloseAutoFocus={(event) => {
          // Opened from the quick switch, which has closed by then: focus is
          // returned by hand to the button both belong to.
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <QueuePanel
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
  ResponseQueueDialogProps,
  'sessionId' | 'state' | 'responseRevision' | 'onSaved' | 'onRemoved' | 'onUnavailable'
> & { onClose: () => void; onBusyChange: (busy: boolean) => void };

function QueuePanel({
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
  // `null` until the viewer edits anything; `queueDialogSteps` decides what
  // is shown meanwhile and after (D152).
  const [draft, setDraft] = useState<QueueDraft | null>(null);
  const [selected, setSelected] = useState<number | null>(() => initialQueueSelection(state));
  // The step open as a screen of its own on a phone (M4), or `null` for the list.
  const [opened, setOpened] = useState<number | null>(null);
  const [busy, setBusy] = useState<'saving' | 'removing' | null>(null);
  // A failure is held, not its words, and described on render in the
  // language shown then (D222).
  const [failure, setFailure] = useState<HeldQueueFailure | null>(null);
  const [confirming, setConfirming] = useState(false);
  const phone = usePhoneLayout();

  const steps = queueDialogSteps(draft, state);
  const evaluation = evaluateQueue(steps, m);
  // What the timeline and the editor draw: the dialog's own checks, and a
  // refusal the server placed at a step (D257). Save reads the own checks alone.
  const errors = queueErrorsWithRefusal(evaluation.errors, failure?.placed ?? null);
  const markers = queueStepMarkers(draft, state, steps.length);
  const current =
    selected !== null && selected < steps.length ? selected : steps.length > 0 ? 0 : null;
  const full = steps.length >= MAX_QUEUE_STEPS;
  const removable = canRemoveQueue(state);
  // A save or a removal in flight: the steps wait, read only, for its answer.
  const locked = busy !== null;

  // The queue was removed while this viewer was asked to confirm its removal
  // - by another viewer, say, or by this one's removal whose answer was lost:
  // the question goes with it and does not come back if a queue is saved
  // again (E3). A failed removal's message goes too, whichever came first,
  // the queue's going or the failure: a removal's event can arrive before
  // its lost answer fails, and its message would then be said about a queue
  // no longer there.
  if (confirming && !removable) {
    setConfirming(false);
  }

  if (!removable && failure?.action === 'remove') {
    setFailure(failureOutsideRemoval(failure));
  }

  const shownFailure = shownQueueFailure(failure, m);
  const footer = queueFooterView(
    {
      confirming,
      state,
      busy,
      failure: shownFailure,
      steps: steps.length,
      footerError: evaluation.footerError,
    },
    m,
  );
  const asking = footer.asking;

  function edit(change: (steps: ResponseForm[]) => ResponseForm[]): void {
    if (locked) {
      return;
    }

    setDraft(editQueueDraft(draft, state, change));
    setConfirming(false);

    // A queue too large, or a refusal placed at a step, says nothing once
    // its steps have changed.
    if (failureAfterEdit(shownFailure) === null) {
      setFailure(null);
    }
  }

  function addStep(): void {
    if (full || locked) {
      return;
    }

    edit((list) => addQueueStep(list, state.response));
    setSelected(steps.length);

    if (phone) {
      setOpened(steps.length);
    }
  }

  function duplicate(index: number): void {
    if (full || locked) {
      return;
    }

    edit((list) => duplicateQueueStep(list, index));
    setSelected(index + 1);

    if (opened !== null) {
      setOpened(index + 1);
    }
  }

  function removeStep(index: number): void {
    if (locked) {
      return;
    }

    edit((list) => removeQueueStep(list, index));
    setSelected(selectionAfterRemoval(index, steps.length - 1));
    setOpened(null);
  }

  function editStep(index: number, change: Partial<ResponseForm>): void {
    edit((list) =>
      list.map((form, position) => (position === index ? { ...form, ...change } : form)),
    );
  }

  async function run(
    kind: 'saving' | 'removing',
    call: () => Promise<SessionResponseState>,
    done: OwnAnswerHandler,
    sent: readonly ResponseForm[] = [],
  ): Promise<void> {
    if (busy !== null) {
      return;
    }

    setBusy(kind);
    onBusyChange(true);
    setFailure(null);

    // What the page held as the call started: its answer yields to anything
    // newer that arrives before it (D152, D205).
    const startedAt = responseRevision();

    try {
      const next = await call();

      onBusyChange(false);
      done(next, startedAt);
    } catch (error) {
      // A refusal of the save placed at the step its `field` names, among the
      // steps sent, which are the ones on screen: the steps were read only
      // while the save was in flight (D257).
      const placed = kind === 'saving' ? placeQueueRefusal(error, sent) : null;
      const described = describeQueueFailure(
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
        // The steps sent stay on screen, so a change from another tab cannot
        // move the mark to another step; on a phone the row is marked and
        // nothing opens (M3).
        setDraft((held) => draftAfterPlacedRefusal(held, 'steps', sent));
        setSelected(placed.index);
      }

      // Every step stays exactly as it was (E2), and a failed removal's row
      // stays with its `Try again`, which removes (E3).
      setFailure({ action: described.action, error, placed });
    } finally {
      onBusyChange(false);
      setBusy(null);
    }
  }

  function save(): void {
    const request = evaluation.request;

    // Save queue is disabled until every step is valid, so there is a request.
    if (request !== null) {
      void run('saving', () => api.setSessionQueue(sessionId, request.steps), onSaved, steps);
    }
  }

  function removeQueue(): void {
    void run('removing', () => api.removeSessionQueue(sessionId), onRemoved);
  }

  /** The footer's main button: the call it makes is the footer's to say. */
  function runMain(): void {
    if (footer.main.call === 'remove') {
      removeQueue();
    } else {
      save();
    }
  }

  /** `Remove queue`: the footer asks once (E3), with no earlier failure shown. */
  function askToRemove(): void {
    setFailure(null);
    setConfirming(true);
  }

  /** `Keep queue`: the question goes, and a failed removal's message with it. */
  function keepQueue(): void {
    setConfirming(false);
    setFailure(failureOutsideRemoval(failure));
  }

  if (phone && opened !== null && opened < steps.length) {
    return (
      <PhoneStepScreen
        index={opened}
        count={steps.length}
        form={steps[opened] as ResponseForm}
        errors={errors[opened] ?? {}}
        marker={markers[opened] ?? 'ahead'}
        full={full}
        disabled={locked}
        onEdit={(change) => editStep(opened, change)}
        onBack={() => setOpened(null)}
        onDuplicate={() => duplicate(opened)}
        onRemove={() => removeStep(opened)}
      />
    );
  }

  const footerText = footer.text;
  const footerTone = footer.alert;

  return (
    <>
      <div className="relative">
        <DialogHeading className="text-[22px] leading-[27px]" closeDisabled={locked}>
          {m.queue.title}
        </DialogHeading>
        {/* From 768 px up the close control sits at the right of the title
            (D1); on a phone the sheet's title bar carries its own. */}
        <DialogPrimitive.Close
          aria-label={m.common.close}
          disabled={locked}
          className="absolute -right-1 top-0 flex size-7 items-center justify-center rounded-[7px] text-[20px] leading-none text-ink-mark hover:bg-canvas focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 max-md:hidden"
        >
          ×
        </DialogPrimitive.Close>
      </div>
      <DialogDescription
        id="response-queue-description"
        className="mt-1.5 leading-[19px] max-md:mt-4"
      >
        {m.queue.description}
      </DialogDescription>

      <div className="mt-5 flex items-start gap-6 max-md:flex-1 max-md:flex-col max-md:items-stretch max-md:gap-0">
        <div className="flex w-[300px] shrink-0 flex-col gap-2.5 md:max-lg:w-[208px] max-md:w-auto">
          {steps.length === 0 ? (
            <div className="rounded-[8px] border border-dashed border-line px-3.5 py-3.5">
              <p className="text-[13px] font-medium leading-[18px] text-ink">
                {m.queue.noStepsTitle}
              </p>
              <p className="mt-1 text-[12px] leading-[17px] text-ink-muted">
                {m.queue.noStepsText}
              </p>
            </div>
          ) : null}

          <StepTimeline
            steps={steps}
            errors={errors}
            markers={markers}
            selected={phone ? null : current}
            phone={phone}
            sessionLabel={formatSessionResponse(state.response, m)}
            onSelect={(index) => {
              setSelected(index);

              if (phone) {
                setOpened(index);
              }
            }}
          />

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="quiet"
              disabled={full || locked}
              className="h-[38px] border-line py-0 font-medium leading-[18px] max-md:h-11"
              onClick={addStep}
            >
              {m.queue.addStep}
            </Button>
            <span className="flex-1" />
            <span className="text-[12px] leading-[15px] text-ink-muted">
              {formatQueueCount(steps.length)}
            </span>
          </div>

          {/* On a phone `Remove queue` is a link under the list (M3); from
              768 px up it is a footer action (D1). */}
          {phone && removable && !asking ? (
            <button
              type="button"
              disabled={locked}
              className="mt-4 min-h-8 self-start text-[15px] font-medium text-danger hover:underline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
              onClick={askToRemove}
            >
              {m.queue.removeQueue}
            </button>
          ) : null}
        </div>

        {phone ? null : (
          <div className="min-w-0 flex-1">
            {current === null ? (
              <EmptyStep />
            ) : (
              <StepEditor
                index={current}
                form={steps[current] as ResponseForm}
                errors={errors[current] ?? {}}
                marker={markers[current] ?? 'ahead'}
                full={full}
                disabled={locked}
                onEdit={(change) => editStep(current, change)}
                onDuplicate={() => duplicate(current)}
                onRemove={() => removeStep(current)}
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
        {footerText === null ? (
          <p className="min-w-0 flex-1 text-[12px] leading-[17px] text-ink-muted max-md:hidden">
            {m.queue.restartHint}
            <span className="md:max-lg:hidden"> {m.queue.waitingKeep}</span>
          </p>
        ) : (
          <p
            role={footerTone ? 'alert' : undefined}
            className={cn(
              'min-w-0 flex-1 text-[12px] leading-[17px] max-md:basis-full',
              footerTone ? 'text-danger' : 'text-ink',
            )}
          >
            {footerText}
          </p>
        )}

        {asking ? (
          <>
            <Button
              type="button"
              variant="quiet"
              disabled={locked}
              className={cn('h-[38px] py-0 font-medium leading-[18px]', SHEET_ACTION)}
              onClick={keepQueue}
            >
              {m.queue.keep}
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
                {m.queue.removeQueue}
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

/** The DOM id of a step's field, by the field's key in the form. */
function stepFieldId(index: number, key: string): string {
  return `queue-step-${index}-${key}`;
}

interface StepTimelineProps {
  steps: ResponseForm[];
  errors: FormErrors[];
  markers: StepMarker[];
  /** The step highlighted, `null` for none: a phone's list selects nothing (M3). */
  selected: number | null;
  phone: boolean;
  /** `Default 200`, `Custom 200`: the last row. */
  sessionLabel: string;
}

/**
 * The step list as a timeline (V1 with K2b markers): the number right-aligned
 * left of a line; on the line a grey dot with ✓ for an answered step, a dark
 * ring for the next one, small hollow dots ahead, a red one for a step in
 * error, and a dashed dot for the session response as the last row.
 */
function StepTimeline({
  steps,
  errors,
  markers,
  selected,
  phone,
  sessionLabel,
  onSelect,
}: StepTimelineProps & { onSelect: (index: number) => void }) {
  const m = useMessages();

  return (
    <ol className="relative flex flex-col" aria-label={m.queue.steps}>
      {/* The line through the markers, from the first row's to the last's. */}
      <span
        aria-hidden="true"
        className="absolute bottom-5 left-[38px] top-5 w-0.5 bg-line max-md:top-[26px] max-md:bottom-[26px]"
      />
      {steps.map((form, index) => {
        const row = describeQueueStepRow(form, errors[index] ?? {}, m);
        const marker: StepMarker | 'invalid' = row.invalid
          ? 'invalid'
          : (markers[index] ?? 'ahead');
        const answered = marker === 'answered';

        return (
          <li key={index} className="relative">
            <button
              type="button"
              aria-current={selected === index ? 'true' : undefined}
              aria-label={m.queue.stepName(index + 1, row.code, row.name, row.delay, marker)}
              className={cn(
                'flex h-10 w-full items-center gap-2 rounded-[6px] pl-1.5 pr-2 text-left',
                'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
                'max-md:h-[52px]',
                selected === index ? 'bg-row-selected' : 'hover:bg-canvas',
              )}
              onClick={() => onSelect(index)}
            >
              <span
                className={cn(
                  'w-3.5 shrink-0 text-right text-[11px] font-medium leading-[13px] max-md:text-[13px]',
                  answered ? 'text-queue-done' : 'text-placeholder',
                )}
              >
                {index + 1}
              </span>
              <Marker kind={marker} />
              <span
                className={cn(
                  'shrink-0 text-[14px] font-semibold leading-[17px] max-md:text-[16px]',
                  row.invalid ? 'text-danger' : answered ? 'text-disabled-ink' : 'text-ink',
                )}
              >
                {row.code}
              </span>
              <span
                className={cn(
                  'min-w-0 truncate text-[12px] leading-[15px] max-md:text-[14px]',
                  row.invalid ? 'text-danger' : answered ? 'text-disabled-ink' : 'text-ink-muted',
                )}
              >
                {/* A tablet names no status (T2): the code and the delay. */}
                <span className="md:max-lg:hidden">
                  {[row.name, row.delay].filter((part) => part !== null && part !== '').join(' · ')}
                </span>
                <span className="hidden md:max-lg:inline">
                  {row.invalid ? row.name : row.delay}
                </span>
              </span>
              <span className="min-w-0 flex-1" />
              {marker === 'next' ? (
                <span className="shrink-0 text-[11px] font-medium leading-[13px] text-link max-md:text-[13px]">
                  {m.queue.nextTag}
                </span>
              ) : null}
              {phone ? (
                <span aria-hidden="true" className="shrink-0 pl-1 text-[16px] text-ink-muted">
                  ›
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
      <li className="relative flex h-10 items-center gap-2 pl-1.5 pr-2 max-md:h-[52px]">
        <span className="w-3.5 shrink-0" />
        <Marker kind="session" />
        <span className="shrink-0 text-[13px] font-medium leading-[16px] text-ink-muted max-md:text-[15px]">
          {sessionLabel}
        </span>
        {/* A tablet's narrower list names the session response alone (T2). */}
        <span className="min-w-0 truncate text-[12px] leading-[15px] text-placeholder max-md:text-[13px] md:max-lg:hidden">
          {m.queue.thenEveryLater}
        </span>
      </li>
    </ol>
  );
}

function Marker({ kind }: { kind: StepMarker | 'invalid' | 'session' }) {
  return (
    <span
      aria-hidden="true"
      className="relative flex size-[22px] shrink-0 items-center justify-center"
    >
      {kind === 'answered' ? (
        <span className="flex size-3.5 items-center justify-center rounded-full bg-queue-mark text-[9px] font-semibold leading-none text-white">
          ✓
        </span>
      ) : kind === 'next' ? (
        <span className="size-3.5 rounded-full border-[3px] border-brand bg-white" />
      ) : kind === 'invalid' ? (
        <span className="flex size-3.5 items-center justify-center rounded-full bg-danger text-[9px] font-bold leading-none text-white">
          !
        </span>
      ) : kind === 'session' ? (
        <span className="size-3 rounded-full border-[1.5px] border-dashed border-line-strong bg-white" />
      ) : (
        <span className="size-2.5 rounded-full border-[1.5px] border-queue-mark bg-white" />
      )}
    </span>
  );
}

/** The right column while there are no steps (U3). */
function EmptyStep() {
  const m = useMessages();

  return (
    <div className="flex min-h-[198px] flex-col items-center justify-center gap-2.5 rounded-[8px] border border-dashed border-line px-6 py-8 text-center">
      <span aria-hidden="true" className="flex items-center gap-1">
        {m.queue.exampleChips.map((label, index) => (
          <span key={label} className="flex items-center gap-1">
            {index === 0 ? null : (
              <span className="text-[11px] leading-[13px] text-placeholder">→</span>
            )}
            <span className="whitespace-nowrap rounded-[4px] border border-line px-1.5 py-px text-[11px] font-medium leading-[13px] text-ink-muted">
              {label}
            </span>
          </span>
        ))}
      </span>
      <p className="text-[13px] leading-[18px] text-ink-muted">{m.queue.addStepHint}</p>
    </div>
  );
}

interface StepEditorProps {
  index: number;
  form: ResponseForm;
  errors: FormErrors;
  marker: StepMarker;
  full: boolean;
  /** A save or a removal is in flight: the fields and the links wait for it. */
  disabled: boolean;
  onEdit: (change: Partial<ResponseForm>) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

/**
 * The selected step, on the right (U4, D1): its place, Duplicate and Remove
 * step, its fields; all of them disabled while a call is in flight, by the
 * fieldset they are in.
 */
function StepEditor({
  index,
  form,
  errors,
  marker,
  full,
  disabled,
  onEdit,
  onDuplicate,
  onRemove,
}: StepEditorProps) {
  const m = useMessages();
  const headingId = useId();

  return (
    <fieldset disabled={disabled} aria-labelledby={headingId} className="min-w-0">
      <div className="flex items-baseline gap-3">
        <h3 id={headingId} className="shrink-0 text-[15px] font-semibold leading-[18px] text-ink">
          {m.queue.step(index + 1)}
        </h3>
        <p className="min-w-0 truncate text-[12px] leading-[15px] text-ink-muted md:max-lg:hidden">
          {describeStepPlace(index, marker, m)}
        </p>
        <span className="min-w-0 flex-1" />
        <StepLink disabled={full} onClick={onDuplicate}>
          {m.queue.duplicate}
        </StepLink>
        <StepLink danger onClick={onRemove}>
          {m.queue.removeStep}
        </StepLink>
      </div>
      <div className="mt-4">
        <ResponseFields
          form={form}
          errors={errors}
          onEdit={onEdit}
          fieldId={(key) => stepFieldId(index, key)}
          hints="phone"
          compactOnTablet
        />
      </div>
    </fieldset>
  );
}

export function StepLink({
  children,
  danger = false,
  disabled = false,
  onClick,
}: {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'relative shrink-0 text-[12px] font-medium leading-[15px] hover:underline',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-60',
        'max-lg:min-h-8 max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-2',
        danger ? 'text-danger' : 'text-link',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface PhoneStepScreenProps {
  index: number;
  count: number;
  form: ResponseForm;
  errors: FormErrors;
  marker: StepMarker;
  full: boolean;
  /** A save or a removal is in flight: the fields and the links wait for it. */
  disabled: boolean;
  onEdit: (change: Partial<ResponseForm>) => void;
  onBack: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

/**
 * A step as a screen of its own on a phone (M4): `‹` back to the list, its
 * place, the fields with their hints, Duplicate step and Remove step, and
 * `Done` pinned to the bottom, which returns to the list with the step kept.
 * While a call is in flight the fields and the two links are disabled, by the
 * fieldset they are in; `‹` and `Done` still go back.
 */
function PhoneStepScreen({
  index,
  count,
  form,
  errors,
  marker,
  full,
  disabled,
  onEdit,
  onBack,
  onDuplicate,
  onRemove,
}: PhoneStepScreenProps) {
  const m = useMessages();
  const headingId = useId();

  return (
    <>
      {/* The dialog keeps its title for assistive technology; the bar names the step. */}
      <DialogPrimitive.Title className="sr-only">{m.queue.title}</DialogPrimitive.Title>
      <DialogDescription id="response-queue-description" className="sr-only">
        {m.queue.stepOfQueue(index + 1, count)}
      </DialogDescription>
      <div className="sticky top-0 z-10 -mx-4 flex h-14 shrink-0 items-center gap-1 border-b border-line-header bg-white pl-1 pr-4">
        <button
          type="button"
          aria-label={m.queue.backToSteps}
          className="flex size-11 shrink-0 items-center justify-center rounded-[7px] text-[24px] leading-none text-ink focus-visible:outline-2 focus-visible:outline-accent"
          onClick={onBack}
        >
          ‹
        </button>
        <h3 id={headingId} className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink">
          {m.queue.counter(index + 1, count)}
        </h3>
        {marker === 'next' ? (
          <span className="shrink-0 rounded-[4px] bg-row-selected px-1.5 py-0.5 text-[12px] font-medium text-link">
            {m.queue.nextTag}
          </span>
        ) : null}
      </div>

      <fieldset disabled={disabled} aria-labelledby={headingId} className="min-w-0">
        <div className="mt-5">
          <ResponseFields
            form={form}
            errors={errors}
            onEdit={onEdit}
            fieldId={(key) => stepFieldId(index, key)}
            hints="phone"
          />
        </div>

        <div className="mt-5 flex items-center gap-6">
          <StepLink disabled={full} onClick={onDuplicate}>
            <span className="text-[15px]">{m.queue.duplicateStep}</span>
          </StepLink>
          <StepLink danger onClick={onRemove}>
            <span className="text-[15px]">{m.queue.removeStep}</span>
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
