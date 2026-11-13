/**
 * Session response settings as a form (frames D1-D8 of the Figma page
 * `Webhook Inspector · Editable response settings`, D150).
 *
 * The custom fields are checked by `validateResponseForm`, with its wording -
 * the validator the landing page's create form used until it was removed
 * (D158) - which agrees with the backend, and the backend checks a change with
 * the very function it checks a creation with.
 *
 * Picking Default hides the custom fields and keeps what they hold, so
 * switching back shows them again. Saving the default sends
 * the mode alone: the custom response the session keeps is left exactly as it
 * was saved (D151).
 */
import {
  ErrorCode,
  MAX_RESPONSE_BODY_BYTES,
  MAX_RESPONSE_HEADERS,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { ApiError } from '../api/client.ts';
import { en, type Messages } from '../i18n/en.ts';
import type { QuickCarry } from './quick-switch.ts';
import {
  formFromResponse,
  utf8ByteLength,
  validateResponseForm,
  type FormErrors,
  type ResponseChangeBody,
  type ResponseForm,
} from './response-config.ts';
import { classifySessionError } from './session-lifetime.ts';
import { keptCustomResponse, responseMode, type ResponseMode } from './session-response.ts';

export interface EditorDraft {
  mode: ResponseMode;
  form: ResponseForm;
}

/**
 * The form as it opens: on the session's mode and on the custom response it
 * keeps - or on the documented defaults when it has never had one - with
 * whatever the quick switch had chosen carried over (D2).
 */
export function initialEditorDraft(state: SessionResponseState, carry?: QuickCarry): EditorDraft {
  const form = formFromResponse(keptCustomResponse(state));

  if (carry === undefined) {
    return { mode: responseMode(state), form };
  }

  return {
    mode: carry.mode,
    form: { ...form, status: carry.statusText, delayMs: carry.delayText },
  };
}

/**
 * What the open editor shows (D152), by the quick switch's rule: `chosen` is
 * `null` until the viewer edits anything, and until then the form shows the
 * session as the page holds it now, so a change saved in another tab moves an
 * untouched form. From the first edit on it shows the viewer's own draft, which
 * a change from elsewhere never resets - last write wins. A choice carried in
 * from the quick switch counts as an edit.
 */
export function editorView(chosen: EditorDraft | null, state: SessionResponseState): EditorDraft {
  return chosen ?? initialEditorDraft(state);
}

/** The draft after one edit, starting from what the form shows at that moment. */
export function editInEditor(
  chosen: EditorDraft | null,
  state: SessionResponseState,
  change: { mode?: ResponseMode; form?: Partial<ResponseForm> },
): EditorDraft {
  const shown = editorView(chosen, state);

  return { mode: change.mode ?? shown.mode, form: { ...shown.form, ...change.form } };
}

export interface EditorEvaluation {
  /** Empty while the default is picked: the custom fields are hidden then. */
  errors: FormErrors;
  canSave: boolean;
  /** What Save sends, or `null` while the form cannot be sent. */
  request: ResponseChangeBody | null;
}

export function evaluateEditorDraft(draft: EditorDraft, m: Messages = en): EditorEvaluation {
  if (draft.mode === 'default') {
    return { errors: {}, canSave: true, request: { mode: 'default' } };
  }

  const { errors, body } = validateResponseForm(draft.form, m);

  return body === null
    ? { errors, canSave: false, request: null }
    : { errors, canSave: true, request: { mode: 'custom', response: body.response } };
}

/** `16 / 65,536 bytes`: the body's UTF-8 size against its limit (D101). */
export function formatBodyCounter(body: string, m: Messages = en): string {
  return m.editor.bodyCounter(m.number(utf8ByteLength(body)), m.number(MAX_RESPONSE_BODY_BYTES));
}

/** `2 / 20`: header rows against the limit. */
export function formatHeaderCounter(form: ResponseForm): string {
  return `${form.headers.length} / ${MAX_RESPONSE_HEADERS}`;
}

/**
 * The body field's label. It names no format: any text is a body, sent as
 * typed (D179), and the user says what it is with a `Content-Type` header
 * row. The hint `Returned exactly as entered` that stood under it is gone:
 * the unticked `Fill in placeholders from the request` says it now, on that
 * line (issue #236, D251).
 */
export const BODY_FIELD_LABEL = en.editor.bodyLabel;

/**
 * The headers the receiver adds itself, listed under the header fields (D2).
 * `Content-Type` is added only to a response with a body and no configured
 * `Content-Type` of its own (D179).
 */
export const AUTOMATIC_HEADERS_NOTE = en.editor.automaticHeaders;

/**
 * What a failed change does to the surface that sent it (frames C8 and D8 of
 * the Figma page `Webhook Inspector · Editable response settings`).
 *
 * A session that is gone takes the page to `Session not found`, as every other
 * session-scoped failure does (D133). A configuration the backend refused is
 * reported with its message, which names the field and never echoes a value
 * (D106). Anything else keeps what was chosen and asks for another try.
 */
export type ChangeFailure =
  { kind: 'unavailable' } | { kind: 'shown'; title: string; text: string };

export function describeChangeFailure(
  error: unknown,
  surface: 'quick switch' | 'editor',
  m: Messages = en,
): ChangeFailure {
  if (classifySessionError(error) === 'unavailable') {
    return { kind: 'unavailable' };
  }

  const title = surface === 'editor' ? m.editor.saveFailed : m.editor.applyFailed;

  // The message is shown verbatim after a fixed lead-in, as the create form
  // showed it, and never parsed: its wording is not a contract (D106).
  if (error instanceof ApiError && error.errorCode === ErrorCode.INVALID_RESPONSE_CONFIG) {
    return {
      kind: 'shown',
      title,
      text: m.editor.rejected(error.message),
    };
  }

  return {
    kind: 'shown',
    title,
    text: surface === 'editor' ? m.editor.changesKept : m.editor.choiceKept,
  };
}

/**
 * A failed change as the quick switch and the editor hold it: the error
 * itself, not its words, so that what is shown follows the `EN | RU` switch
 * while it stays on screen (D222).
 */
export interface HeldChangeFailure {
  error: unknown;
}

/**
 * The held failure in the words given, `null` for none: described each time
 * it is shown, in the language shown then. A session gone is never held - it
 * moves the page - and is `null` here too.
 */
export function shownChangeFailure(
  held: HeldChangeFailure | null,
  surface: 'quick switch' | 'editor',
  m: Messages = en,
): { title: string; text: string } | null {
  if (held === null) {
    return null;
  }

  const described = describeChangeFailure(held.error, surface, m);

  return described.kind === 'shown' ? { title: described.title, text: described.text } : null;
}
