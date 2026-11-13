/**
 * Client-side validation of the response configuration the Session response
 * settings editor sends (D150). It was written for the landing page's create
 * form, which shared it with the editor until that form was removed (D158);
 * the rules are creation's, because the backend checks a change with the very
 * function it checks a creation with.
 *
 * This mirrors `apps/backend/src/modules/sessions/response-config.ts`, which is
 * the authority: the backend validates every rule again and its `1005` message
 * is what the user sees when the two disagree (D101, D106). The limits
 * themselves are never retyped here — every bound is imported from
 * `@webhook-inspector/shared`, which is where the backend reads them from too.
 *
 * The checks run in the backend's order — status, a body on a status that
 * forbids one, the header count, each pair, the header block, reserved names
 * and the `Location` rule, the body, then the delay — so that the rule the
 * user is told about first is
 * the rule the server would have named. A template's placeholders, which the
 * backend reads after the delay, are said on the body, as one more rule of it
 * (D251, issue #236). Unlike the backend, which can return only one message,
 * the form reports every broken rule at once.
 *
 * The English messages mirror the backend's wording; in another language the
 * form says the same rules in that language's words (`m`, D222), and the
 * backend's own message, shown after a lead-in when the two disagree, stays
 * English (D106).
 */
import {
  HEADER_NAME_PATTERN,
  HEADER_VALUE_MAX_CODE,
  HEADER_VALUE_MIN_CODE,
  HEADER_VALUE_TAB_CODE,
  LOCATION_STATUS_MAX,
  LOCATION_STATUS_MIN,
  LOCATION_TARGET_PREFIX,
  locationHeaderProblem,
  MAX_HEADER_BLOCK_BYTES,
  MAX_HEADER_NAME_BYTES,
  MAX_HEADER_VALUE_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  MAX_RESPONSE_DELAY_MS,
  MAX_RESPONSE_HEADERS,
  RESERVED_RESPONSE_HEADERS,
  RESERVED_RESPONSE_HEADER_PREFIX,
  RESPONSE_STATUS_MAX,
  RESPONSE_STATUS_MIN,
  STATUSES_WITHOUT_BODY,
  type ResponseConfig,
} from '@webhook-inspector/shared';
import { en, type Messages } from '../i18n/en.ts';
import { templateError } from './response-template.ts';

/** One configured header pair, as the form holds it while it is being edited. */
export interface HeaderRow {
  name: string;
  value: string;
}

/**
 * Every field the form shows is text: it holds what the user typed, not a
 * parse of it - but for `template`, the box under the body (D251, issue
 * #236): whether the body is a template, opened as saved and kept through
 * every save, so a save turns one off only when the box is cleared.
 */
export interface ResponseForm {
  status: string;
  headers: HeaderRow[];
  body: string;
  delayMs: string;
  template: boolean;
}

/**
 * The documented defaults, which the form opens on for a session that has never
 * had a custom response: saved untouched, it is a custom response answering
 * `200` with no body and no delay.
 */
export const DEFAULT_RESPONSE_FORM: ResponseForm = {
  status: '200',
  headers: [],
  body: '',
  delayMs: '0',
  template: false,
};

/**
 * The body of `POST /api/sessions` for a custom session. The interface no
 * longer creates one (D158), but its `response` is exactly what a change sends,
 * so the shape stays named for the call it describes. Declared here rather than
 * in `@webhook-inspector/shared`: the backend validates the raw request text and never
 * consumes a request type.
 *
 * Every field that is at its default is omitted rather than sent explicitly.
 */
export interface CreateSessionBody {
  response: {
    status: number;
    headers?: [string, string][];
    body?: string | null;
    delayMs?: number;
    template?: boolean;
  };
}

/**
 * The body of `PUT /api/sessions/:sessionId/response` (D150). Declared here for
 * the same reason as `CreateSessionBody`.
 *
 * `default` answers the default and keeps the saved custom response untouched
 * (D151); `custom` answers with this response and saves it, checked by the
 * very rules a creation is checked by.
 */
export type ResponseChangeBody =
  { mode: 'default' } | { mode: 'custom'; response: CreateSessionBody['response'] };

/**
 * The form opened on a configuration: the saved custom response, or the
 * documented defaults when the session has never had one. The inverse of what
 * `validateResponseForm` sends, so an untouched form saves what it was opened
 * on.
 */
export function formFromResponse(response: ResponseConfig | null): ResponseForm {
  if (response === null) {
    return DEFAULT_RESPONSE_FORM;
  }

  return {
    status: String(response.status),
    headers: response.headers.map(([name, value]) => ({ name, value })),
    body: response.body ?? '',
    delayMs: String(response.delayMs),
    // A state from a backend before 1.9.0 carries no flag, and is no template.
    template: response.template === true,
  };
}

/** A per-row complaint, so a bad pair is reported on the field that broke. */
export interface HeaderRowErrors {
  name?: string;
  value?: string;
}

/**
 * Everything the form got wrong, reported together. `rows` is keyed by the
 * row's index in `ResponseForm.headers`, so a message stays attached to the
 * pair the user typed even when blank rows sit between the filled ones.
 */
export interface FormErrors {
  status?: string;
  /** Rules about the header list as a whole: the count and the block budget. */
  headers?: string;
  rows?: Record<number, HeaderRowErrors>;
  body?: string;
  delayMs?: string;
  /**
   * The server's refusal of the response as a whole, or of a part no field
   * shows - its `template` (D257): no field draws it, it marks the step's or
   * the rule's row in error, and the dialog's footer says it. The form's own
   * checks never set it.
   */
  refused?: string;
}

const NUL = '\x00';

const encoder = new TextEncoder();

/**
 * Bytes of UTF-8, which is what every size limit counts. `TextEncoder` is used
 * deliberately: `Buffer.byteLength` types cleanly through `@types/node` and
 * then does not exist in a browser.
 */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

export function hasErrors(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The header rows a save sends, each with its index in the form: a row left
 * blank in both fields is something the user never filled in, so it is
 * dropped; a row with a value but no name is not blank, and is reported
 * rather than silently discarded. The server's `headers[k]` is the k-th of
 * these, whatever blank rows sit before it (D257).
 */
export function configuredHeaders(
  headers: readonly HeaderRow[],
): (HeaderRow & { index: number })[] {
  return headers
    .map((row, index) => ({ index, ...row }))
    .filter((row) => row.name !== '' || row.value !== '');
}

/**
 * Checks the form and, when nothing is wrong, builds the body whose `response`
 * a change sends.
 *
 * `body` is `null` whenever `errors` is not empty: there is no half-valid
 * configuration to send.
 */
export function validateResponseForm(
  form: ResponseForm,
  m: Messages = en,
): {
  errors: FormErrors;
  body: CreateSessionBody | null;
} {
  const errors: FormErrors = {};
  const rows: Record<number, HeaderRowErrors> = {};

  const status = parseInteger(form.status);

  if (status === null || status < RESPONSE_STATUS_MIN || status > RESPONSE_STATUS_MAX) {
    errors.status = m.config.status(RESPONSE_STATUS_MIN, RESPONSE_STATUS_MAX);
  }

  // The body text is kept exactly as typed, and only an untouched textarea
  // counts as no body. A textarea holding nothing but whitespace is a body the
  // user did type, and is sent as it stands rather than dropped in silence
  // (D179).
  const bodyText = form.body;
  const hasBody = bodyText !== '';

  // Refused rather than dropped later: the reply would not carry the body the
  // session was configured with (D101). Stated on the body and naming the
  // status that forbids it, in the words frame D5 of the Figma page `Webhook
  // Inspector · Editable response settings` gives the settings editor (D150).
  if (status !== null && STATUSES_WITHOUT_BODY.includes(status) && hasBody) {
    errors.body = m.config.bodyForbidden(status);
  }

  const configured = configuredHeaders(form.headers);

  if (configured.length > MAX_RESPONSE_HEADERS) {
    errors.headers = m.config.tooManyHeaders(MAX_RESPONSE_HEADERS);
  }

  for (const row of configured) {
    const rowErrors: HeaderRowErrors = {};

    if (utf8ByteLength(row.name) > MAX_HEADER_NAME_BYTES) {
      rowErrors.name = m.config.nameTooLong(MAX_HEADER_NAME_BYTES);
    } else if (!HEADER_NAME_PATTERN.test(row.name)) {
      rowErrors.name = m.config.nameNotToken;
    }

    if (utf8ByteLength(row.value) > MAX_HEADER_VALUE_BYTES) {
      rowErrors.value = m.config.valueTooLong(MAX_HEADER_VALUE_BYTES);
    } else if (!isAllowedHeaderValue(row.value)) {
      rowErrors.value = m.config.valueNotVisible;
    }

    if (rowErrors.name !== undefined || rowErrors.value !== undefined) {
      rows[row.index] = rowErrors;
    }
  }

  // Only the configured pairs are counted: the receiver's own Content-Type,
  // X-Content-Type-Options, Content-Security-Policy, X-Webhook-Inspector-Request-Id
  // and X-QA-Tools-Request-Id sit outside this budget (D279).
  const blockBytes = configured.reduce(
    (total, row) => total + utf8ByteLength(`${row.name}: ${row.value}\r\n`),
    0,
  );

  if (errors.headers === undefined && blockBytes > MAX_HEADER_BLOCK_BYTES) {
    errors.headers = m.config.blockTooLarge(MAX_HEADER_BLOCK_BYTES);
  }

  // The `Location` rule is the backend's own predicate (D247). A wrong status
  // is the row's name's complaint and a wrong target its value's, each in the
  // slot under the row and only where that field has no complaint of its own
  // yet; the backend names the status first, the form says both at once. A
  // status the form cannot read is not held against the row, which the status
  // field's own error already covers: only the target is judged then.
  const validStatus = errors.status === undefined ? status : null;

  for (const row of configured) {
    const rowErrors: HeaderRowErrors = { ...rows[row.index] };

    if (rowErrors.name !== undefined) {
      continue;
    }

    if (isReservedHeaderName(row.name)) {
      rows[row.index] = { ...rowErrors, name: m.config.reserved };

      continue;
    }

    if (locationHeaderProblem(row.name, row.value, validStatus) === 'status') {
      rowErrors.name = m.config.locationStatus(LOCATION_STATUS_MIN, LOCATION_STATUS_MAX);
    }

    if (
      rowErrors.value === undefined &&
      locationHeaderProblem(row.name, row.value, null) === 'target'
    ) {
      rowErrors.value = m.config.locationTarget(LOCATION_TARGET_PREFIX);
    }

    if (rowErrors.name !== undefined || rowErrors.value !== undefined) {
      rows[row.index] = rowErrors;
    }
  }

  // A template is read last, as the backend reads it: only a body within its
  // size and free of U+0000 is a template at all, and only while the box is
  // ticked (D251). Read by the server's own module, so the editor refuses
  // what the server would, naming the placeholder the server only counts.
  if (hasBody && errors.body === undefined) {
    const bodyError =
      checkBody(bodyText, m) ?? (form.template ? templateError(bodyText, m) : undefined);

    if (bodyError !== undefined) {
      errors.body = bodyError;
    }
  }

  const delayMs = form.delayMs.trim() === '' ? 0 : parseInteger(form.delayMs);

  if (delayMs === null || delayMs < 0 || delayMs > MAX_RESPONSE_DELAY_MS) {
    errors.delayMs = m.config.delay(MAX_RESPONSE_DELAY_MS);
  }

  if (Object.keys(rows).length > 0) {
    errors.rows = rows;
  }

  if (hasErrors(errors) || status === null || delayMs === null) {
    return { errors, body: null };
  }

  const response: CreateSessionBody['response'] = { status };

  if (configured.length > 0) {
    response.headers = configured.map((row): [string, string] => [row.name, row.value]);
  }

  if (hasBody) {
    response.body = bodyText;
  }

  if (delayMs !== 0) {
    response.delayMs = delayMs;
  }

  // Sent only when on, as the other fields are only when not at their
  // default: the backend reads an absent flag as off (D251).
  if (form.template) {
    response.template = true;
  }

  return { errors, body: { response } };
}

/**
 * The field a failed submit should move focus to.
 *
 * This is the order of the checks with one exception: a row's own complaint is
 * preferred to the list-wide header rules, which run first but name no field of
 * their own and can only fall back to the first name input. A body rejected for
 * the status it accompanies is reported on the body, because that is the field
 * naming the rule.
 */
export function firstErrorField(errors: FormErrors): string | null {
  if (errors.status !== undefined) {
    return 'status';
  }

  if (errors.rows !== undefined) {
    const indexes = Object.keys(errors.rows)
      .map(Number)
      .sort((left, right) => left - right);

    for (const index of indexes) {
      const row = errors.rows[index];

      if (row?.name !== undefined) {
        return `header-name-${index}`;
      }

      if (row?.value !== undefined) {
        return `header-value-${index}`;
      }
    }
  }

  if (errors.headers !== undefined) {
    return 'header-name-0';
  }

  if (errors.body !== undefined) {
    return 'body';
  }

  if (errors.delayMs !== undefined) {
    return 'delayMs';
  }

  return null;
}

/** Whole numbers only: `200.5`, `abc` and an empty field are all not a number. */
function parseInteger(value: string): number | null {
  const trimmed = value.trim();

  if (!/^[+-]?\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);

  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Visible ASCII plus space and tab, so that CR and LF cannot appear (D101). */
function isAllowedHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code === HEADER_VALUE_TAB_CODE) {
      continue;
    }

    if (code < HEADER_VALUE_MIN_CODE || code > HEADER_VALUE_MAX_CODE) {
      return false;
    }
  }

  return true;
}

function isReservedHeaderName(name: string): boolean {
  const lowered = name.toLowerCase();

  return (
    RESERVED_RESPONSE_HEADERS.includes(lowered) ||
    lowered.startsWith(RESERVED_RESPONSE_HEADER_PREFIX)
  );
}

/**
 * The body is only checked, never rewritten: it is sent as the exact text that
 * was typed, so key order, duplicate keys and whitespace survive (D101). Any
 * text is a body, JSON or not (D179).
 */
function checkBody(text: string, m: Messages): string | undefined {
  if (utf8ByteLength(text) > MAX_RESPONSE_BODY_BYTES) {
    return m.config.bodyTooLarge(MAX_RESPONSE_BODY_BYTES);
  }

  // The column storing the body cannot hold a NUL byte, so the backend rejects
  // one rather than failing at insert. A typed `\u0000` escape is six ordinary
  // characters and is not refused (D179).
  if (text.includes(NUL)) {
    return m.config.bodyNul;
  }

  return undefined;
}
