/**
 * Where a server's refusal of a list belongs (issue #232, D257): the `field`
 * of a `400` / `1005` - `rules[1].path`, `steps[0].headers[2][1]` - read
 * against the list the dialog sent, as the rule or the step it names and the
 * field of it, in the errors the editors draw for their own checks.
 *
 * Only `field` is read. The message is shown at the field, or in the footer,
 * and never parsed (D106): a message naming `rules[0]` beside the field
 * `rules[1]` marks rule 2. A field the dialog cannot place - another list, a
 * position outside the list sent, a key no field of the dialog holds, no
 * string, longer than `MAX_REFUSAL_FIELD_LENGTH` - places nothing, and the
 * dialog says the refusal as it did before the field existed.
 */
import { ErrorCode } from '@webhook-inspector/shared';
import { ApiError, MAX_REFUSAL_FIELD_LENGTH } from '../api/client.ts';
import { configuredHeaders, type FormErrors, type ResponseForm } from './response-config.ts';

/** A refusal placed in the list sent. */
export interface PlacedRefusal<Errors> {
  /** The refused rule's or step's index in the list sent, from 0. */
  index: number;
  /** What its editor and its row draw: the server's message at the field named. */
  errors: Errors;
  /**
   * Whether a field of it shows the message. When none does - the rule or
   * the step as a whole, its `template` - only its row is marked, and the
   * footer says the message.
   */
  marked: boolean;
}

/** A position as the API writes one, counted from 0: `0`, or no leading zero. */
const POSITION = /^(?:0|[1-9][0-9]*)$/;

/** A header pair's place after a response's: `.headers[3]`, `.headers[3][0]`, `.headers[3][1]`. */
const HEADER_PAIR = /^\.headers\[(0|[1-9][0-9]*)\](?:\[([01])\])?$/;

/**
 * A `1005` refusal's place in a list of `count` items named `list`: the
 * index it names and what follows it, `.path` for `rules[1].path`, with the
 * server's message; `null` for any other error, or a field outside that list.
 */
export function refusedListPlace(
  error: unknown,
  list: 'rules' | 'steps',
  count: number,
): { index: number; rest: string; message: string } | null {
  if (!(error instanceof ApiError) || error.errorCode !== ErrorCode.INVALID_RESPONSE_CONFIG) {
    return null;
  }

  // Typed a string, but only as the client kept it: held to it again here.
  const field: unknown = error.field;

  if (typeof field !== 'string' || field.length > MAX_REFUSAL_FIELD_LENGTH) {
    return null;
  }

  const prefix = `${list}[`;

  if (!field.startsWith(prefix)) {
    return null;
  }

  const close = field.indexOf(']', prefix.length);

  if (close === -1) {
    return null;
  }

  const position = field.slice(prefix.length, close);

  if (!POSITION.test(position)) {
    return null;
  }

  const index = Number(position);

  return index < count ? { index, rest: field.slice(close + 1), message: error.message } : null;
}

/**
 * The errors a refusal places in one response's form, from what follows the
 * response's own place: nothing, the response as a whole; `.status`,
 * `.delayMs`, `.body`; `.headers`, the list; `.headers[k]` and `.headers[k][0]`
 * the k-th filled row's name, `.headers[k][1]` its value - the k-th row the
 * save sent, whatever blank rows sit before it (`configuredHeaders`);
 * `.template`, which no field shows. `null` for anything else, a pair past
 * the rows sent included.
 */
export function placeResponseRefusal(
  rest: string,
  form: ResponseForm,
  message: string,
): FormErrors | null {
  switch (rest) {
    case '':
    case '.template':
      return { refused: message };
    case '.status':
      return { status: message };
    case '.delayMs':
      return { delayMs: message };
    case '.body':
      return { body: message };
    case '.headers':
      return { headers: message };
  }

  const pair = HEADER_PAIR.exec(rest);

  if (pair === null) {
    return null;
  }

  const row = configuredHeaders(form.headers)[Number(pair[1])];

  if (row === undefined) {
    return null;
  }

  return { rows: { [row.index]: pair[2] === '1' ? { value: message } : { name: message } } };
}

/** Whether a form's errors name a field of it, beyond the response refused as a whole. */
export function namesAField(errors: FormErrors): boolean {
  return Object.keys(errors).some((key) => key !== 'refused');
}

/**
 * A form's own errors with a refusal's laid under them: the form's own check
 * wins where both name a field, since it describes what is on screen now.
 */
export function withRefusedErrors(own: FormErrors, refused: FormErrors): FormErrors {
  const merged: FormErrors = { ...refused, ...own };
  const rows = { ...refused.rows };

  for (const [index, row] of Object.entries(own.rows ?? {})) {
    rows[Number(index)] = { ...rows[Number(index)], ...row };
  }

  if (Object.keys(rows).length > 0) {
    merged.rows = rows;
  }

  return merged;
}

/**
 * The draft a dialog holds once it has placed a refusal of its save (D257).
 * A draft already edited is kept as it is: it is the list sent. An untouched
 * dialog, which shows the stored list, is pinned to a copy of the list sent -
 * the one the refusal's position counts in - so a change from another tab
 * cannot move the mark to another rule or step, and the timeline reads the
 * list as edited from then on.
 */
export function draftAfterPlacedRefusal<Key extends 'rules' | 'steps', Item>(
  held: Record<Key, Item[]> | null,
  key: Key,
  sent: readonly Item[],
): Record<Key, Item[]> {
  return held ?? ({ [key]: [...sent] } as Record<Key, Item[]>);
}
