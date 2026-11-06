/**
 * The quick switch under the endpoint-card button: Default or Custom, a status
 * and a delay, and Apply (frames C1-C8 of the Figma page `Webhook Inspector ·
 * Editable response settings`, D150).
 *
 * Headers and body are not edited here - they "stay as they are", and the link
 * beside that sentence opens the full editor. So a custom change sent from here
 * carries the kept headers and body unchanged - a template stays one (D251) -
 * and the one rule that ties the status to the body is checked against them:
 * 204, 205 and 304 are refused while a body is set (D101).
 *
 * Everything the popover shows is decided here, as data, so the rules are
 * unit-tested without a DOM (D070).
 */
import {
  MAX_RESPONSE_DELAY_MS,
  RESPONSE_STATUS_MAX,
  RESPONSE_STATUS_MIN,
  STATUSES_WITHOUT_BODY,
  type ResponseConfig,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { en, type Messages } from '../i18n/en.ts';
import type { ResponseChangeBody } from './response-config.ts';
import {
  DEFAULT_STATUS,
  formatDelaySummary,
  keptCustomResponse,
  responseMode,
  type ResponseMode,
} from './session-response.ts';

/** The status chips, in the design's order; anything else is typed (C1). */
export const STATUS_CHIPS: readonly number[] = [200, 201, 204, 400, 404, 500, 503];

/**
 * The delay chips, in the design's order; anything else is typed in ms (C1).
 * `label` is the English one; the switch draws the dictionary's
 * `quick.delayChip` (D222).
 */
export const DELAY_CHIPS: readonly { ms: number; label: string }[] = [
  0, 500, 2000, 10000, 30000,
].map((ms) => ({ ms, label: en.quick.delayChip(ms) }));

/** A picked chip, or whatever was typed in the free field beside the chips. */
export type Choice = { kind: 'chip'; value: number } | { kind: 'typed'; text: string };

export interface QuickDraft {
  mode: ResponseMode;
  status: Choice;
  delay: Choice;
}

function choiceFor(value: number, chips: readonly number[]): Choice {
  return chips.includes(value) ? { kind: 'chip', value } : { kind: 'typed', text: String(value) };
}

/**
 * The switch as it opens: the session's mode, and the kept custom status and
 * delay - so picking Custom on a session answering the default restores what it
 * keeps (C4). A value that is not a chip opens in the free field.
 */
export function initialQuickDraft(state: SessionResponseState): QuickDraft {
  const kept = keptCustomResponse(state);

  return {
    mode: responseMode(state),
    status: choiceFor(kept?.status ?? DEFAULT_STATUS, STATUS_CHIPS),
    delay: choiceFor(
      kept?.delayMs ?? 0,
      DELAY_CHIPS.map((chip) => chip.ms),
    ),
  };
}

/**
 * What the open switch shows (D152). `chosen` is `null` until the viewer picks
 * anything; until then the switch shows the session as the page holds it now,
 * so a change applied in another tab moves an untouched switch. From the first
 * choice on it shows the viewer's own draft, which a change from elsewhere
 * never resets - last write wins.
 */
export function quickSwitchView(
  chosen: QuickDraft | null,
  state: SessionResponseState,
): QuickDraft {
  return chosen ?? initialQuickDraft(state);
}

/**
 * The draft after one choice. It starts from what the switch shows at that
 * moment, so a first choice made after another tab's change keeps the rest of
 * that change rather than what the switch opened on.
 */
export function chooseInQuickSwitch(
  chosen: QuickDraft | null,
  state: SessionResponseState,
  change: Partial<QuickDraft>,
): QuickDraft {
  return { ...quickSwitchView(chosen, state), ...change };
}

function hasBody(kept: ResponseConfig | null): boolean {
  return kept !== null && kept.body !== null && kept.body !== '';
}

/**
 * Why a status cannot be picked here, or `null` when it can: a status that
 * forbids a body, while the kept body is set (C6). The body is changed in the
 * full editor, which is what the reason sends the reader to.
 */
export function statusUnavailableReason(
  status: number,
  kept: ResponseConfig | null,
  m: Messages = en,
): string | null {
  return STATUSES_WITHOUT_BODY.includes(status) && hasBody(kept)
    ? m.quick.needsEmptyBody(status)
    : null;
}

/**
 * The sentence about what the switch does not touch, above the link to the
 * full editor (C1).
 */
export function describeUntouched(kept: ResponseConfig | null, m: Messages = en): string {
  const headers = kept?.headers.length ?? 0;

  return hasBody(kept) ? m.quick.untouchedWithBody(headers) : m.quick.untouchedNoBody(headers);
}

/** Whole numbers only: `200.5`, `abc` and an empty field are all not a number. */
function parseWhole(text: string): number | null {
  const trimmed = text.trim();

  return /^\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed)) ? Number(trimmed) : null;
}

function resolve(choice: Choice): number | null {
  return choice.kind === 'chip' ? choice.value : parseWhole(choice.text);
}

export interface QuickEvaluation {
  /** Said under the status field (C5), or `null`. */
  statusError: string | null;
  /** Said under the delay field, or `null`. */
  delayError: string | null;
  /** Whether Apply would change anything at all. */
  changed: boolean;
  canApply: boolean;
  /**
   * The footer line: what Apply would change (`201 → 500 · 500 ms → none`,
   * `Custom 201 → Default`), what to fix first, or - when nothing is chosen
   * yet - that a change applies from now on.
   */
  footer: string;
  /** The change is described, so the line is set in the stronger ink (C2). */
  footerIsChange: boolean;
  /** What Apply sends, or `null` when it cannot be sent. */
  request: ResponseChangeBody | null;
}

/**
 * Everything the popover says about a draft, against the state it would change.
 *
 * `state` is the session as this viewer currently holds it, which a change made
 * in another tab replaces (D152): the footer and `changed` are always measured
 * against what the session answers now, never against what it answered when
 * the popover opened.
 */
export function evaluateQuickDraft(
  draft: QuickDraft,
  state: SessionResponseState,
  m: Messages = en,
): QuickEvaluation {
  const current = state.response;
  const kept = keptCustomResponse(state);

  if (draft.mode === 'default') {
    const changed = current !== null;

    return {
      statusError: null,
      delayError: null,
      changed,
      canApply: changed,
      // The custom side of a mode change, as the footer names it (C4): `Custom 201`.
      footer: changed
        ? `${m.quick.customStatus(current.status)} → ${m.response.default}`
        : m.quick.fromNowOn,
      footerIsChange: changed,
      request: changed ? { mode: 'default' } : null,
    };
  }

  const status = resolve(draft.status);
  const delayMs = resolve(draft.delay);

  const statusError =
    status === null || status < RESPONSE_STATUS_MIN || status > RESPONSE_STATUS_MAX
      ? m.quick.statusRange(RESPONSE_STATUS_MIN, RESPONSE_STATUS_MAX)
      : statusUnavailableReason(status, kept, m);

  const delayError =
    delayMs === null || delayMs > MAX_RESPONSE_DELAY_MS
      ? m.quick.delayRange(MAX_RESPONSE_DELAY_MS)
      : null;

  if (statusError !== null || delayError !== null || status === null || delayMs === null) {
    return {
      statusError,
      delayError,
      changed: true,
      canApply: false,
      footer: m.quick.fix(statusError !== null, delayError !== null),
      footerIsChange: false,
      request: null,
    };
  }

  // The kept body goes back as it is, a template still one (D251): the
  // switch changes the status and the delay alone. The flag is sent only when
  // on, as the editor sends it: absent is off, and the previous image - during
  // a rolling update or after a rollback - refuses the key as unknown.
  const request: ResponseChangeBody = {
    mode: 'custom',
    response: {
      status,
      headers: kept?.headers ?? [],
      body: kept?.body ?? null,
      delayMs,
      ...(kept?.template === true ? { template: true } : {}),
    },
  };

  if (current === null) {
    return {
      statusError,
      delayError,
      changed: true,
      canApply: true,
      footer: `${m.response.default} → ${m.quick.customStatus(status)}`,
      footerIsChange: true,
      request,
    };
  }

  const parts: string[] = [];

  if (status !== current.status) {
    parts.push(`${current.status} → ${status}`);
  }

  if (delayMs !== current.delayMs) {
    parts.push(`${formatDelaySummary(current.delayMs, m)} → ${formatDelaySummary(delayMs, m)}`);
  }

  const changed = parts.length > 0;

  return {
    statusError,
    delayError,
    changed,
    canApply: changed,
    footer: changed ? parts.join(' · ') : m.quick.fromNowOn,
    footerIsChange: changed,
    request: changed ? request : null,
  };
}

/**
 * What the full editor opens on when it is reached from the switch with a
 * choice made (D2): the switch's mode and whatever its status and delay fields
 * say, typed or picked, so nothing chosen here is lost on the way.
 */
export interface QuickCarry {
  mode: ResponseMode;
  statusText: string;
  delayText: string;
}

export function carryQuickDraft(draft: QuickDraft): QuickCarry {
  const text = (choice: Choice): string =>
    choice.kind === 'chip' ? String(choice.value) : choice.text;

  return { mode: draft.mode, statusText: text(draft.status), delayText: text(draft.delay) };
}

/**
 * Whether the page under the quick switch is inert: only under a phone's
 * bottom sheet, which is drawn outside the page. From 768 px up the switch is a
 * popover and the page around it stays live, as it always has (D157).
 */
export function quickSwitchPageInert({ open, phone }: { open: boolean; phone: boolean }): boolean {
  return open && phone;
}

/**
 * Whether closing the quick switch puts focus back on its button by hand.
 *
 * On a phone, yes, however it closed - a tap on the scrim included, after
 * which Radix, treating it as a click outside, would leave focus on the page
 * body - except when it hands over to the full editor, which returns focus to
 * the button itself when it closes. From 768 px up Radix decides, as it always
 * has: back to the button after Escape or Apply, where the click landed after
 * a click outside (D157).
 */
export function quickSwitchReturnsFocus({
  phone,
  handingOver,
}: {
  phone: boolean;
  handingOver: boolean;
}): boolean {
  return phone && !handingOver;
}

/** The part of a DOM node `focusLost` reads; a fake in the tests. */
export interface FocusHolder {
  contains(other: FocusHolder | null): boolean;
}

/**
 * Whether the focus the quick switch had went with a control that left or
 * was disabled, seen from `within`, an element of the quick switch (D206):
 * it is on nothing, on the page's body, where Chromium drops the focus of a
 * button it disables or removes, or on something that holds `within` - the
 * popover itself, which a click on its background focuses, its content
 * carrying `tabindex="-1"`. The quick switch is a non-modal dialog and sets
 * no trap that would put focus anywhere. Focus the viewer put on a control,
 * in the popover or out of it - `Copy`, the `EN | RU` switch - stays.
 */
export function focusLost(
  within: FocusHolder | null,
  active: FocusHolder | null = document.activeElement,
  body: FocusHolder | null = document.body,
): boolean {
  return (
    active === null ||
    active === body ||
    (within !== null && active !== within && active.contains(within))
  );
}
