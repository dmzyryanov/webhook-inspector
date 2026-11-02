/**
 * The response queue in the interface (D205; Figma page `Webhook Inspector ·
 * Response queue (#106) — chosen, review 2`): the section at the bottom of
 * the quick switch, the `· N queued` of the endpoint label, the Response
 * queue dialog and its toasts.
 *
 * Every one of these is a decision about text or about which steps show,
 * rather than about layout, so it lives here, away from the DOM, where a unit
 * test reaches it (D070). Nothing here is worded as a delivery (D103, D113):
 * a step is what the session *answers*, never what a sender received.
 *
 * Every text takes the interface's words, `m`, English by default (D222); the
 * constants are the English ones.
 */
import {
  ErrorCode,
  MAX_QUEUE_STEPS,
  RESPONSE_STATUS_MAX,
  RESPONSE_STATUS_MIN,
  type QueueStep,
  type ResponseConfig,
  type ResponseQueue,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { ApiError } from '../api/client.ts';
import { en, type Messages } from '../i18n/en.ts';
import { formatReasonPhrase } from './format.ts';
import {
  formFromResponse,
  validateResponseForm,
  type CreateSessionBody,
  type FormErrors,
  type ResponseForm,
} from './response-config.ts';
import { isTemplate } from './response-template.ts';
import {
  namesAField,
  placeResponseRefusal,
  refusedListPlace,
  withRefusedErrors,
  type PlacedRefusal,
} from './refused-field.ts';
import { classifySessionError } from './session-lifetime.ts';

/** The separator the design uses between the segments of a label: U+00B7. */
const SEPARATOR = ' · ';

/** What the session response answers when it is the default (D102). */
const DEFAULT_STATUS = 200;

/**
 * The queue a session holds, or `null` for none. A backend from before 0.46.0
 * sends no `queue` at all, which is read as none: that is what keeps this
 * bundle working while it talks to the previous image.
 */
export function heldQueue(state: { queue?: ResponseQueue | null }): ResponseQueue | null {
  return state.queue ?? null;
}

/** How many steps are still to answer: from `next` to the last, none when used up. */
export function stepsLeft(queue: ResponseQueue | null): number {
  return queue === null || queue.next === null ? 0 : queue.total - queue.next + 1;
}

/** The endpoint label's suffix, `6 queued`, or `null` when no step is left (U6, U7). */
export function formatQueuedSuffix(queue: ResponseQueue | null, m: Messages = en): string | null {
  const left = stepsLeft(queue);

  return left === 0 ? null : m.response.queued(left);
}

/**
 * A delay as a chip says it, in seconds: `2 s`, `0.5 s`, `1.25 s`, as the
 * quick switch's delay chips do; the empty string for none.
 */
export function formatDelayShort(delayMs: number, m: Messages = en): string {
  if (delayMs <= 0) {
    return '';
  }

  return m.queue.delay(delayMs);
}

/** A step in a chip: its status and, when it has one, its delay, `503 · 2 s`. */
export function formatStepChip(
  step: Pick<ResponseConfig, 'status' | 'delayMs'>,
  m: Messages = en,
): string {
  const delay = formatDelayShort(step.delayMs, m);

  return delay === '' ? `${step.status}` : `${step.status}${SEPARATOR}${delay}`;
}

/**
 * A step in the quick switch's section: its chip, and a `· Template` part
 * after it when the step is a template, as it shows `· 2 s` (issue #236,
 * T13): `201 · Template`, `503 · 2 s · Template`. The dialog's step list and
 * the endpoint button are unchanged.
 */
export function formatSectionStepChip(
  step: Pick<ResponseConfig, 'status' | 'delayMs'> & { template?: boolean },
  m: Messages = en,
): string {
  const chip = formatStepChip(step, m);

  return isTemplate(step) ? `${chip}${SEPARATOR}${m.template.tag}` : chip;
}

/** The session response as the queue's last chip and row: `Custom 200`, `Default 200`. */
export function formatSessionResponse(response: ResponseConfig | null, m: Messages = en): string {
  if (response === null) {
    return m.queue.sessionDefault(DEFAULT_STATUS);
  }

  return m.queue.sessionCustom(response.status, formatDelayShort(response.delayMs, m));
}

/** What the section shows beside its title while the session has no queue (P1.1, U2). */
export const QUEUE_EXAMPLE_CHIPS: readonly string[] = en.queue.exampleChips;

/** The section's line while the session has no queue (P1.1). */
export const NO_QUEUE_NOTE = en.queue.noQueue;

/**
 * One chip of the section's row:
 * - `answered`: the step that answered last, grey with ✓;
 * - `next`: the step the next request gets, framed;
 * - `ahead`: a step after it, grey;
 * - `session`: the session response after the last step, dashed;
 * - `session-next`: the session response once every step has answered, framed
 *   and dashed (L1).
 */
export type QueueChipKind = 'answered' | 'next' | 'ahead' | 'session' | 'session-next';

export interface QueueChip {
  kind: QueueChipKind;
  label: string;
}

export type QueueSectionView =
  | { kind: 'none' }
  | {
      kind: 'running';
      /** `Step 2 of 7`, on the right of the title. */
      counter: string;
      /** The line over the chips: what they are. */
      lead: string;
      chips: QueueChip[];
      /** How many chips are always shown, the next step included, however narrow the row. */
      kept: number;
    }
  | { kind: 'done'; lead: string; chips: QueueChip[]; kept: number };

/**
 * What the quick switch's Response queue section shows for a session (P1.1 to
 * P1.4, and the section frames `671:370` to `671:772`): example chips while it
 * has no queue; while steps are left, the step answered last from step 2 on,
 * the next step, the rest and the session response; once every step has
 * answered, the last step and the session response as the next (L1).
 */
export function queueSectionView(state: SessionResponseState, m: Messages = en): QueueSectionView {
  const queue = heldQueue(state);

  if (queue === null || queue.steps.length === 0) {
    return { kind: 'none' };
  }

  const session = formatSessionResponse(state.response, m);
  const last = queue.steps[queue.steps.length - 1] as ResponseConfig;

  if (queue.next === null) {
    return {
      kind: 'done',
      lead: m.queue.everyStepAnswered,
      chips: [
        { kind: 'answered', label: formatSectionStepChip(last, m) },
        { kind: 'session-next', label: session },
      ],
      kept: 2,
    };
  }

  const nextIndex = queue.next - 1;
  const answered = nextIndex > 0 ? (queue.steps[nextIndex - 1] as ResponseConfig) : null;
  const chips: QueueChip[] = [
    ...(answered === null
      ? []
      : [{ kind: 'answered' as const, label: formatSectionStepChip(answered, m) }]),
    ...queue.steps.slice(nextIndex).map((step, offset): QueueChip => ({
      kind: offset === 0 ? 'next' : 'ahead',
      label: formatSectionStepChip(step, m),
    })),
    { kind: 'session', label: session },
  ];
  const isLast = queue.next === queue.total;

  return {
    kind: 'running',
    counter: m.queue.counter(queue.next, queue.total),
    lead:
      answered === null
        ? isLast
          ? m.queue.leadNextThenSession
          : m.queue.leadNextThenRest
        : isLast
          ? m.queue.leadLastThenSession
          : m.queue.leadLastThenRest,
    chips,
    kept: answered === null ? 1 : 2,
  };
}

/** The measures of a chip row: a gap between items, the arrow and the ellipsis. */
export interface ChipRowMeasures {
  available: number;
  gap: number;
  arrow: number;
  ellipsis: number;
}

/**
 * How many chips of a row fit on its one line (P1.2: "one line, what does not
 * fit ends with …"). The row is chip, arrow, chip, …, and a row cut short ends
 * with an arrow and the ellipsis after its last chip. The first `kept` chips -
 * the step answered last and the next one - are shown whatever the width.
 */
export function fitQueueChips(
  widths: readonly number[],
  measures: ChipRowMeasures,
  kept: number,
): { shown: number; cut: boolean } {
  const step = measures.arrow + 2 * measures.gap;
  let total = 0;

  for (const [index, width] of widths.entries()) {
    total += width + (index === 0 ? 0 : step);
  }

  if (total <= measures.available) {
    return { shown: widths.length, cut: false };
  }

  let shown = 0;
  let used = 0;

  for (const [index, width] of widths.entries()) {
    const withChip = used + width + (index === 0 ? 0 : step);

    if (index >= kept && withChip + step + measures.ellipsis > measures.available) {
      break;
    }

    used = withChip;
    shown = index + 1;
  }

  return { shown: Math.max(shown, Math.min(kept, widths.length)), cut: true };
}

/**
 * What the chip row says to a screen reader, from which the drawn row - cut to
 * one line, with arrows - is hidden: every step, the whole way.
 */
export function describeQueueChips(chips: readonly QueueChip[], m: Messages = en): string {
  const ahead = chips.filter((chip) => chip.kind === 'ahead').map((chip) => chip.label);
  const parts: string[] = [];

  for (const chip of chips) {
    if (chip.kind === 'answered') {
      parts.push(m.queue.answeredLast(chip.label));
    } else if (chip.kind === 'next') {
      parts.push(m.queue.next(chip.label));

      if (ahead.length > 0) {
        parts.push(m.queue.then(ahead));
      }
    } else if (chip.kind === 'session') {
      parts.push(m.queue.thenSession(chip.label));
    } else if (chip.kind === 'session-next') {
      parts.push(m.queue.nextSession(chip.label));
    }
  }

  return parts.join(' ');
}

/**
 * The statuses of the steps still to answer, from `next` on: none once used
 * up. The dictionary says them once when all are one: `The next 2 requests
 * get 503`, `The next 3 requests get 503, 429 and 200`.
 */
function statusesAhead(queue: ResponseQueue): number[] {
  return queue.next === null ? [] : queue.steps.slice(queue.next - 1).map((step) => step.status);
}

/**
 * The toast after a queue was saved (U6), worded from the state the page
 * hands back for it (`ownChangeState` in `session-response.ts`): the save's
 * answer, or, once the page holds the save's own `session.updated`, what the
 * page shows - a capture may already have taken a step of the saved queue,
 * and the answer, which says step 1, was then set aside (correction round 5,
 * the Reviewer's finding). Usually the two are the same, and the toast is
 * U6's.
 */
export function formatQueueSavedToast(state: SessionResponseState, m: Messages = en): string {
  const queue = heldQueue(state);

  return queue === null
    ? m.queue.saved
    : m.queue.savedAhead(statusesAhead(queue), state.response !== null);
}

/** The toast after `Run again` (U9), from the state the page hands back for it, as a save's is. */
export function formatQueueRestartedToast(state: SessionResponseState, m: Messages = en): string {
  const queue = heldQueue(state);

  if (queue === null) {
    return m.queue.nothingToRestart;
  }

  // Past once a capture has taken a step of the run started again.
  return m.queue.restarted(statusesAhead(queue), state.response !== null, queue.next !== 1);
}

/** The toast after the queue was removed (E3). */
export const QUEUE_REMOVED_TOAST = en.queue.removed;

/** What `Run again` says in the quick switch when it fails. */
export const RESTART_FAILED = en.queue.restartFailed;

/**
 * Whether the section offers `Run again`: while it shows a used-up queue
 * (L1). A failed restart's message is said only then, beside the link it
 * asks to try again: a restart whose answer was lost usually has its own
 * `session.updated` arrive first, and the section already shows `Step 1 of
 * N` when the failure is set (correction round 6, the Reviewer's finding);
 * another viewer's restart, save or removal takes the message away too. A
 * failure after the page took a `session.updated` starting the queue from
 * step 1 is not said at all, the section offering `Run again` again or not
 * (`queueStartedSince`, correction round 7).
 */
export function offersRunAgain(state: SessionResponseState): boolean {
  return queueSectionView(state, en).kind === 'done';
}

// ---------------------------------------------------------------------------
// The Response queue dialog (U3-U5, D1, E1-E3, T2, M3, M4).

/**
 * The dialog's steps as the viewer has edited them, or `null` until the first
 * edit. Selecting a step is not an edit.
 */
export interface QueueDraft {
  steps: ResponseForm[];
}

/**
 * The steps the open dialog shows (D152's rule for an open surface): the
 * session's queue as the page holds it now while nothing has been edited, so
 * a capture, a clear or a change from another tab moves an untouched dialog;
 * from the first edit on, the viewer's own steps, which a change from
 * elsewhere never resets - last write wins.
 */
export function queueDialogSteps(
  draft: QueueDraft | null,
  state: SessionResponseState,
): ResponseForm[] {
  return draft?.steps ?? heldQueue(state)?.steps.map(formFromResponse) ?? [];
}

/** The draft after one edit, starting from what the dialog shows at that moment. */
export function editQueueDraft(
  draft: QueueDraft | null,
  state: SessionResponseState,
  edit: (steps: ResponseForm[]) => ResponseForm[],
): QueueDraft {
  return { steps: edit(queueDialogSteps(draft, state)) };
}

/** `+ Add step`: a copy of the session response, last (owner's note on U4). */
export function addQueueStep(
  steps: readonly ResponseForm[],
  sessionResponse: ResponseConfig | null,
): ResponseForm[] {
  return steps.length >= MAX_QUEUE_STEPS
    ? [...steps]
    : [...steps, formFromResponse(sessionResponse)];
}

/** `Duplicate`: a copy of the step, right after it (U5). */
export function duplicateQueueStep(steps: readonly ResponseForm[], index: number): ResponseForm[] {
  const step = steps[index];

  if (step === undefined || steps.length >= MAX_QUEUE_STEPS) {
    return [...steps];
  }

  const copy: ResponseForm = { ...step, headers: step.headers.map((row) => ({ ...row })) };

  return [...steps.slice(0, index + 1), copy, ...steps.slice(index + 1)];
}

/** `Remove step`. */
export function removeQueueStep(steps: readonly ResponseForm[], index: number): ResponseForm[] {
  return steps.filter((_unused, position) => position !== index);
}

/** The step selected after one is removed: the one that took its place, or the last. */
export function selectionAfterRemoval(index: number, remaining: number): number | null {
  return remaining === 0 ? null : Math.min(index, remaining - 1);
}

/** Which step is selected when the dialog opens: the next one, or the first. */
export function initialQueueSelection(state: SessionResponseState): number | null {
  const queue = heldQueue(state);

  if (queue === null || queue.steps.length === 0) {
    return null;
  }

  return queue.next === null ? 0 : queue.next - 1;
}

/**
 * Where each step stands on the timeline (V1 with K2b): answered, the next one,
 * or ahead. An untouched dialog shows the session's queue as it runs (D1); an
 * edited one shows the queue it will save, which saving starts from step 1.
 */
export type StepMarker = 'answered' | 'next' | 'ahead';

export function queueStepMarkers(
  draft: QueueDraft | null,
  state: SessionResponseState,
  count: number,
): StepMarker[] {
  const queue = heldQueue(state);
  const next = draft === null && queue !== null ? queue.next : 1;

  return Array.from({ length: count }, (_unused, index): StepMarker => {
    const position = index + 1;

    if (next === null || position < next) {
      return 'answered';
    }

    return position === next ? 'next' : 'ahead';
  });
}

/** The line beside `Step N` in the dialog (D1, U4, U5). */
export function describeStepPlace(index: number, marker: StepMarker, m: Messages = en): string {
  switch (marker) {
    case 'answered':
      return m.queue.placeAnswered;

    case 'next':
      return index === 0 ? m.queue.placeNextFirst : m.queue.placeNext;

    case 'ahead':
      return m.queue.placeAhead(index);
  }
}

/** What the timeline row of one step says (D1, T2, E1). */
export interface QueueStepRow {
  /** The status as typed, `—` when the field is empty. */
  code: string;
  /** `Service Unavailable`, `not a status code`, or `null` for an unregistered status. */
  name: string | null;
  /** `2 s`, or the empty string. */
  delay: string;
  invalid: boolean;
}

function wholeNumber(text: string): number | null {
  const trimmed = text.trim();

  return /^\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed)) ? Number(trimmed) : null;
}

export function describeQueueStepRow(
  form: ResponseForm,
  errors: FormErrors,
  m: Messages = en,
): QueueStepRow {
  const status = wholeNumber(form.status);
  const delayMs = wholeNumber(form.delayMs);
  const statusValid =
    status !== null && status >= RESPONSE_STATUS_MIN && status <= RESPONSE_STATUS_MAX;
  const invalid = Object.keys(errors).length > 0;

  return {
    code: form.status.trim() === '' ? '—' : form.status.trim(),
    name: !statusValid
      ? m.queue.notAStatus
      : invalid
        ? m.queue.hasError
        : formatReasonPhrase(status as number),
    delay: errors.delayMs === undefined && delayMs !== null ? formatDelayShort(delayMs, m) : '',
    invalid,
  };
}

/** `7 / 10` under the list. */
export function formatQueueCount(count: number): string {
  return `${count} / ${MAX_QUEUE_STEPS}`;
}

export interface QueueEvaluation {
  /** The errors of each step, in order, as the response editor reports them. */
  errors: FormErrors[];
  /** The positions, 1-based, of the steps in error. */
  broken: number[];
  canSave: boolean;
  /** `Fix step 2 to save the queue.`, or `null` (E1). */
  footerError: string | null;
  /** What Save sends, or `null` while it cannot be sent. */
  request: { steps: CreateSessionBody['response'][] } | null;
}

/**
 * The dialog's steps checked one by one by the response editor's validator,
 * with its messages (D150, D158). Save is unavailable with no steps or with
 * a step in error (E1).
 */
export function evaluateQueue(steps: readonly ResponseForm[], m: Messages = en): QueueEvaluation {
  const validated = steps.map((form) => validateResponseForm(form, m));
  const broken = validated.flatMap((result, index) => (result.body === null ? [index + 1] : []));
  const canSave = steps.length > 0 && broken.length === 0;

  return {
    errors: validated.map((result) => result.errors),
    broken,
    canSave,
    footerError: broken.length === 0 ? null : m.queue.fixSteps(broken),
    request: canSave
      ? {
          steps: validated.map((result) => (result.body as CreateSessionBody).response),
        }
      : null,
  };
}

/**
 * Whether `Remove queue` is offered: only while the session has a saved queue,
 * as the frames draw it (D1, M3) - not for steps added in the dialog and not
 * yet saved (U3, U4), which Cancel discards.
 */
export function canRemoveQueue(state: SessionResponseState): boolean {
  return heldQueue(state) !== null;
}

/**
 * Whether the footer asks `Remove all N steps?` (E3): only while the viewer
 * has asked to remove a queue the session still has. A queue removed
 * meanwhile - by another viewer, say - takes the question with it, so the
 * footer never asks about steps that are gone, nor offers a removal of none.
 */
export function asksToRemoveQueue(confirming: boolean, state: SessionResponseState): boolean {
  return confirming && canRemoveQueue(state);
}

/**
 * The question itself, `Remove all 7 steps?` or `Remove the step?`: what the
 * quick switch's section asks in place of its links (issue #142, D206), and
 * the start of the dialog's question.
 */
export function formatRemoveQueueShortQuestion(count: number, m: Messages = en): string {
  return m.queue.removeShort(count);
}

/** The question `Remove queue` asks once, in the footer (E3). */
export function formatRemoveQueueQuestion(count: number, m: Messages = en): string {
  return m.queue.removeQuestion(count);
}

/** A save refused because the queue, as JSON, is over the 1 MiB limit (D205). */
export const QUEUE_TOO_LARGE = en.queue.tooLarge;

/**
 * A save refused because the server was already handling as many large
 * queues as it takes at once (`429` / `1017`, D205): nothing is wrong with
 * the queue, and the same save goes through a moment later.
 */
export const QUEUE_SERVER_BUSY = en.queue.serverBusy;

/**
 * A failure the dialog shows (E2): the call that failed, its text, and
 * whether the call is offered again as `Try again`. A save the server refused
 * for the queue's size would fail the same way again, so it offers none, and
 * the button keeps reading `Save queue`. `Try again` retries the call that
 * failed and no other: a failed save's is the main button, a failed
 * removal's the removal's own button in the row that asked (correction round
 * 4, the outside review's finding: it was the main button, which saved).
 */
export interface ShownQueueFailure {
  action: QueueCall;
  text: string;
  retry: boolean;
  /** Set when the refusal is placed at a step, whose mark an edit takes away with it (D257). */
  placed?: true;
}

/**
 * A save's `1005` placed at the step its `field` names, among the steps sent
 * (D257): `steps[1]` the step as a whole and its fields
 * (`placeResponseRefusal`); `null` for any other error and for a field the
 * dialog cannot place - a creation's `queue.steps[1]` included - which keeps
 * the refusal's footer as it was before the field existed.
 */
export function placeQueueRefusal(
  error: unknown,
  steps: readonly ResponseForm[],
): PlacedRefusal<FormErrors> | null {
  const place = refusedListPlace(error, 'steps', steps.length);
  const step = place === null ? undefined : steps[place.index];

  if (place === null || step === undefined) {
    return null;
  }

  const errors = placeResponseRefusal(place.rest, step, place.message);

  return errors === null ? null : { index: place.index, errors, marked: namesAField(errors) };
}

/**
 * The errors the dialog draws: its own checks', with a placed refusal's laid
 * under the step it names. Save still reads the dialog's own checks alone, so
 * a mark never holds it back.
 */
export function queueErrorsWithRefusal(
  errors: readonly FormErrors[],
  placed: PlacedRefusal<FormErrors> | null,
): FormErrors[] {
  return errors.map((own, index) =>
    placed === null || index !== placed.index ? own : withRefusedErrors(own, placed.errors),
  );
}

/** The two calls the dialog makes. */
export type QueueCall = 'save' | 'remove';

/** What a failed queue call does to the dialog (E2), as a failed change does (D8). */
export type QueueFailure = { kind: 'unavailable' } | ({ kind: 'shown' } & ShownQueueFailure);

export function describeQueueFailure(
  error: unknown,
  action: QueueCall,
  m: Messages = en,
  placed: PlacedRefusal<FormErrors> | null = null,
): QueueFailure {
  if (classifySessionError(error) === 'unavailable') {
    return { kind: 'unavailable' };
  }

  // Placed at a step by its `field` (D257): the footer names the step counted
  // from 1, and says the message only when no field of the step shows it.
  // Otherwise shown after a fixed lead-in and never parsed: its wording is
  // not a contract (D106). It names the step by its place, `steps[1]`.
  if (error instanceof ApiError && error.errorCode === ErrorCode.INVALID_RESPONSE_CONFIG) {
    if (placed !== null) {
      const step = placed.index + 1;

      return {
        kind: 'shown',
        action,
        text: placed.marked
          ? m.queue.rejectedStep(step)
          : m.queue.rejectedStepWithReason(step, error.message),
        retry: true,
        placed: true,
      };
    }

    return {
      kind: 'shown',
      action,
      text: m.queue.rejected(error.message),
      retry: true,
    };
  }

  // A queue whose JSON is over the 1 MiB every call takes (D205): text the
  // JSON escapes - quotes, control characters - is written larger than it is,
  // and saving it again would be refused the same way.
  if (error instanceof ApiError && error.errorCode === ErrorCode.PAYLOAD_TOO_LARGE) {
    return { kind: 'shown', action, text: m.queue.tooLarge, retry: false };
  }

  // Refused at once because the server is busy with large bodies (D205): the
  // same save succeeds once a place is free, a second or so later.
  if (error instanceof ApiError && error.errorCode === ErrorCode.LARGE_BODIES_BUSY) {
    return { kind: 'shown', action, text: m.queue.serverBusy, retry: true };
  }

  return {
    kind: 'shown',
    action,
    text: action === 'save' ? m.queue.saveFailed : m.queue.removeFailed,
    retry: true,
  };
}

/**
 * A failed queue call as the dialog and the quick switch hold it: the call
 * and its error, not its words, so that what is shown follows the `EN | RU`
 * switch while it stays on screen (D222).
 */
export interface HeldQueueFailure {
  action: QueueCall;
  error: unknown;
  /** Where a save's refusal was placed among the steps it sent (D257), if anywhere. */
  placed?: PlacedRefusal<FormErrors> | null;
}

/**
 * The held failure in the words given, `null` for none: described each time
 * it is shown, in the language shown then. A session gone is never held - it
 * moves the page - and is `null` here too.
 */
export function shownQueueFailure(
  held: HeldQueueFailure | null,
  m: Messages = en,
): ShownQueueFailure | null {
  if (held === null) {
    return null;
  }

  const described = describeQueueFailure(held.error, held.action, m, held.placed ?? null);

  return described.kind === 'shown'
    ? {
        action: described.action,
        text: described.text,
        retry: described.retry,
        ...(described.placed === true ? { placed: true as const } : {}),
      }
    : null;
}

/**
 * The failure still shown once the viewer leaves the row that asked to
 * remove the queue - with `Keep queue`, by editing a step, or because the
 * queue is gone: a failed removal's, which is about that row, goes; a save's
 * stays. It reads the call alone, so it takes a held failure as well as a
 * shown one.
 */
export function failureOutsideRemoval<Failure extends { action: QueueCall }>(
  failure: Failure | null,
): Failure | null {
  return failure?.action === 'remove' ? null : failure;
}

/**
 * The failure still shown once the steps change: one that offers no retry -
 * a queue too large - or a refusal placed at a step (D257) says something
 * about steps that are no longer the ones shown, and goes, as a failed
 * removal does, whose row an edit leaves; any other stays until the next
 * call.
 */
export function failureAfterEdit(failure: ShownQueueFailure | null): ShownQueueFailure | null {
  const outside = failureOutsideRemoval(failure);

  return outside !== null && (!outside.retry || outside.placed === true) ? null : outside;
}

/**
 * The dialog's main button: `Saving…` in flight, `Try again` after a failed
 * save that offers one, and `Save queue` otherwise - after a failed removal
 * too, which this button does not retry.
 */
export function formatSaveQueueLabel(
  busy: 'saving' | 'removing' | null,
  failure: ShownQueueFailure | null,
  m: Messages = en,
): string {
  if (busy === 'saving') {
    return m.queue.saving;
  }

  return failure?.action === 'save' && failure.retry ? m.queue.tryAgain : m.queue.save;
}

/**
 * The removal's own button in the row that asks (E3): `Removing…` in flight,
 * `Try again` after a failed removal, `Remove queue` otherwise. It sends the
 * `DELETE` again; nothing in that row saves.
 */
export function formatRemoveQueueLabel(
  busy: 'saving' | 'removing' | null,
  failure: ShownQueueFailure | null,
  m: Messages = en,
): string {
  if (busy === 'removing') {
    return m.queue.removing;
  }

  return failure?.action === 'remove' && failure.retry ? m.queue.tryAgain : m.queue.removeQueue;
}

/** What the dialog's footer shows (E1-E3). */
export interface QueueFooterView {
  /**
   * The row that asks to remove the queue (E3): `Keep queue` and the
   * removal's button, in place of `Remove queue`, `Cancel` and `Save queue`.
   * It stays after a failed removal, with the failure and `Try again`.
   */
  asking: boolean;
  /** The line beside the buttons, or `null` for the hint about restarts. */
  text: string | null;
  /** Whether the line is an error: red, and announced. */
  alert: boolean;
  /** The main button's label and the call it makes. */
  main: { label: string; call: QueueCall };
}

/**
 * The footer from what the dialog holds: whether the viewer asked to remove
 * the queue, the session's state, the call in flight, the failure shown, the
 * steps shown and the line naming a step in error. A failure is said in
 * place of the question or of that line, and the main button retries the
 * call that failed: in the row that asks, the removal; elsewhere, the save.
 *
 * A failed removal's message belongs to the row that asked, and is said only
 * while that row shows: once the session has no queue, the row goes and the
 * message with it, whether the queue went before the removal's answer failed
 * or after - a removal whose `session.updated` arrived and whose answer was
 * lost removed the queue all the same (correction round 5, the Tester's
 * finding).
 */
export function queueFooterView(
  {
    confirming,
    state,
    busy,
    failure,
    steps,
    footerError,
  }: {
    confirming: boolean;
    state: SessionResponseState;
    busy: 'saving' | 'removing' | null;
    failure: ShownQueueFailure | null;
    steps: number;
    footerError: string | null;
  },
  m: Messages = en,
): QueueFooterView {
  const asking = asksToRemoveQueue(confirming, state);
  const shown = failure?.action === 'remove' && !asking ? null : failure;
  const text =
    shown?.text ??
    (asking
      ? formatRemoveQueueQuestion(Math.max(steps, heldQueue(state)?.total ?? 0), m)
      : footerError);

  return {
    asking,
    text,
    alert: shown !== null || (!asking && footerError !== null),
    main: asking
      ? { label: formatRemoveQueueLabel(busy, shown, m), call: 'remove' }
      : { label: formatSaveQueueLabel(busy, shown, m), call: 'save' },
  };
}

// ---------------------------------------------------------------------------
// `Remove queue` in the quick switch's section (issue #142, D206).

/** What the section's links row shows about removing the queue. */
export interface QueueSectionRemovalView {
  /** Whether `Remove queue` ends the links: only while the session has a saved queue. */
  offered: boolean;
  /**
   * The row that asks, in place of the links: the question, or a failed
   * removal's text in its place, then `Keep queue` and the removal's button.
   */
  asking: boolean;
  /** The question or the failure, or `null` while the row does not ask. */
  text: string | null;
  /** Whether `text` is a failure: red, and announced. */
  alert: boolean;
  /** The removal's button: `Remove`, `Removing…` in flight, `Try again` after a failure. */
  label: string;
}

/**
 * The section's `Remove queue` from what the quick switch holds: whether the
 * viewer asked, the session's state, whether the removal is in flight and
 * the failure of the last one. It asks once in place of the links, as the
 * dialog's footer asks (E3): the question is the dialog's without its second
 * sentence, and a failure is said in its place, `Try again` on the removal's
 * button sending the `DELETE` again. As in the dialog, the question goes
 * with the queue - removed by another viewer, or by this one whose answer
 * was lost - and a failed removal's message with the question, whichever
 * came first (`asksToRemoveQueue`, `queueFooterView`).
 */
export function queueSectionRemoval(
  {
    confirming,
    state,
    removing,
    failure,
  }: {
    confirming: boolean;
    state: SessionResponseState;
    removing: boolean;
    failure: ShownQueueFailure | null;
  },
  m: Messages = en,
): QueueSectionRemovalView {
  const asking = asksToRemoveQueue(confirming, state);
  const shown = asking && failure?.action === 'remove' ? failure : null;

  return {
    offered: canRemoveQueue(state),
    asking,
    text: asking
      ? (shown?.text ?? formatRemoveQueueShortQuestion(heldQueue(state)?.total ?? 0, m))
      : null,
    alert: shown !== null,
    label: removing ? m.queue.removing : shown?.retry === true ? m.queue.tryAgain : m.queue.remove,
  };
}

/**
 * How long after the section's question appears a click on its `Remove` is
 * still taken for the click that asked, in milliseconds (D206).
 */
export const REMOVE_SETTLE_MS = 500;

/**
 * Whether a click on the removal's button of the section's question is one
 * not aimed at it, which does nothing (D206; correction round 2, the Tester's
 * finding). The question appears in place of the links, its `Remove` at the
 * right end of the row, under the pointer that clicked `Remove queue` (as
 * `716:383` draws it), so the second click of a double-click, or a second
 * tap, would remove the queue with the question unread. A click that is part
 * of a multi-click - `detail` over 1 - or that comes within
 * `REMOVE_SETTLE_MS` of the question appearing is set aside, whatever the
 * button reads. Activation from the keyboard, whose click has `detail` 0, is
 * never set aside: focus moves to `Keep queue` as the question appears.
 *
 * `sinceAsked` is the time from the question appearing to the click; a
 * negative one, a click made before the page drew the question, is too soon,
 * and one that cannot be told (`NaN`) is not.
 */
export function isHastyRemoveClick(detail: number, sinceAsked: number): boolean {
  if (detail === 0) {
    return false;
  }

  return detail > 1 || sinceAsked < REMOVE_SETTLE_MS;
}

/**
 * Which row ends the section: `Set up a queue…` with no queue, the question
 * in place of the links, a used-up queue's links, which start with `Run
 * again`, or a running queue's, which do not.
 */
export type QueueSectionRow = 'none' | 'asking' | 'used-up' | 'running';

/** The row the section draws for what it shows and whether it asks. */
export function queueSectionRow(
  view: QueueSectionView['kind'],
  removal: Pick<QueueSectionRemovalView, 'asking'>,
): QueueSectionRow {
  if (view === 'none') {
    return 'none';
  }

  if (removal.asking) {
    return 'asking';
  }

  return view === 'done' ? 'used-up' : 'running';
}

/**
 * The control of the section that takes focus lost as one row takes another's
 * place (D206; issue #143): `Keep queue` as the question appears, `Remove
 * queue` as it goes and the queue stays, and otherwise the heading row - the
 * queue gone, removed here or elsewhere, a queue saved elsewhere in place of
 * `Set up a queue…`, or `Run again` gone as another viewer's restart, save or
 * clear starts a used-up queue from step 1 (D205), during this viewer's own
 * `Run again` too. `null` where no control left: the same row, or a running
 * queue used up, which only adds `Run again`.
 */
export function queueSectionFocusTarget(
  previous: QueueSectionRow,
  row: QueueSectionRow,
): 'keep-queue' | 'remove-queue' | 'heading' | null {
  if (previous === row || (previous === 'running' && row === 'used-up')) {
    return null;
  }

  if (row === 'asking') {
    return 'keep-queue';
  }

  return previous === 'asking' && row !== 'none' ? 'remove-queue' : 'heading';
}

// ---------------------------------------------------------------------------
// Following the queue as requests arrive (D205).

/**
 * The state after a captured request took a step (`request.received` names
 * it): the queue moves to the step after it, or is used up after the last.
 * Nothing changes for a request the session response answered, or for a step
 * of a queue of another length - one replaced since, whose own
 * `session.updated` is the newer word.
 *
 * The server publishes a session's events in the order its calls took the
 * session's lock (D205 point 12), so a step reaches the page before the event
 * of any change after it - a replacement, a restart (`Run again`), a clear -
 * and moves the run it was taken from. Only a step applied on top of a read
 * (`settleSessionRead`) can meet a queue from after it, which the read
 * already holds: one of another length is left alone by the check below, and
 * one of the same length is moved until the change's own event, which
 * follows the step, sets it right (D205, Accepted consequences).
 */
export function applyQueueStep<T extends SessionResponseState>(
  state: T,
  step: QueueStep | null | undefined,
): T {
  const queue = heldQueue(state);

  if (step === null || step === undefined || queue === null || queue.total !== step.total) {
    return state;
  }

  const next = step.index < queue.total ? step.index + 1 : null;

  return queue.next === next ? state : { ...state, queue: { ...queue, next } };
}

/** The state after the requests were cleared, which starts the queue from step 1. */
export function applyQueueCleared<T extends SessionResponseState>(state: T): T {
  const queue = heldQueue(state);

  return queue === null || queue.next === 1 ? state : { ...state, queue: { ...queue, next: 1 } };
}
