/**
 * A response as a template in the response editor (issue #236, D251; Figma
 * page `Webhook Inspector · Response body templates (#236) — approved A`):
 * what `Insert placeholder ▾` offers and inserts, the editor's check of a
 * template, and the words that check says.
 *
 * The grammar is not restated here: a body is read by
 * `@webhook-inspector/shared/response-template`, the very module the server checks a
 * template with at save (D251 point 3), so the editor refuses exactly what the
 * server would. What this adds is what the server never says - the
 * placeholder itself. The server's refusal names a placeholder by its place
 * and never echoes it (D106); the editor shows the user their own text, as it
 * was typed, so `Unknown placeholder {{request.foo}}.` says which one.
 *
 * Everything here is pure, so the rules are unit-tested without a DOM (D070).
 */
import {
  TEMPLATE_CLOSE,
  TEMPLATE_OPEN,
  templateProblem,
  type TemplateProblem,
} from '@webhook-inspector/shared/response-template';
import { en, type Messages } from '../i18n/en.ts';

/**
 * Whether a response is a template (D251), which the quick switch's summary
 * and its queue and rules sections mark (T13, T14). A response from a backend
 * before 1.9.0 carries no flag, and is none.
 */
export function isTemplate(response: { template?: boolean } | null | undefined): boolean {
  return response?.template === true;
}

/** The menu's items, by the dictionary key that names each. */
export type PlaceholderChoiceKey = 'requestId' | 'method' | 'path' | 'query' | 'header' | 'body';

/** One item of `Insert placeholder ▾`. */
export interface PlaceholderChoice {
  key: PlaceholderChoiceKey;
  /** What is inserted at the caret. */
  text: string;
  /**
   * Where the caret is left, counted from the start of `text`: after a whole
   * placeholder, and before the `}}` of a stub, where the user types the name
   * or the path.
   */
  caret: number;
  /** What the item shows on its right, `…` where the user types. */
  shown: string;
  /** A stub, which the user finishes: drawn after the line under the whole ones. */
  stub: boolean;
}

function whole(key: PlaceholderChoiceKey, inner: string): PlaceholderChoice {
  const text = `${TEMPLATE_OPEN}${inner}${TEMPLATE_CLOSE}`;

  return { key, text, caret: text.length, shown: text, stub: false };
}

function stub(key: PlaceholderChoiceKey, prefix: string): PlaceholderChoice {
  const text = `${TEMPLATE_OPEN}${prefix}${TEMPLATE_CLOSE}`;

  return {
    key,
    text,
    caret: text.length - TEMPLATE_CLOSE.length,
    shown: `${TEMPLATE_OPEN}${prefix}…${TEMPLATE_CLOSE}`,
    stub: true,
  };
}

/**
 * The menu, in the frames' order (T6, T7): the three whole placeholders of
 * D251's set, a line, and the three the user finishes - a query parameter's
 * name, a header's name, a JSON body field's path.
 */
export const PLACEHOLDER_CHOICES: readonly PlaceholderChoice[] = [
  whole('requestId', 'request.id'),
  whole('method', 'request.method'),
  whole('path', 'request.path'),
  stub('query', 'request.query.'),
  stub('header', 'request.header.'),
  stub('body', 'request.body.'),
];

/** The placeholder the hint gives as its example. */
export const HINT_EXAMPLE = PLACEHOLDER_CHOICES[0]?.text ?? '';

/**
 * The body with `choice` inserted in place of the selection from `start` to
 * `end` - at the caret when they are one - and where the caret then goes.
 * A selection outside the body, or given backwards, is brought into it: the
 * textarea's own range is always inside its value, but a stale one is not
 * trusted.
 */
export function insertPlaceholder(
  body: string,
  start: number,
  end: number,
  choice: PlaceholderChoice,
): { body: string; caret: number } {
  // A range that is no range at all is no caret: the end of the body.
  const known = Number.isFinite(start) && Number.isFinite(end);
  const clamp = (value: number) =>
    known ? Math.min(Math.max(Math.trunc(value), 0), body.length) : body.length;
  const from = Math.min(clamp(start), clamp(end));
  const to = Math.max(clamp(start), clamp(end));

  return {
    body: `${body.slice(0, from)}${choice.text}${body.slice(to)}`,
    caret: from + choice.caret,
  };
}

/**
 * The most of a placeholder's inside a message shows: past it the text is
 * cut with `…`. A placeholder of the set is far shorter; what is longer is
 * text the user did not mean as one, and the line under the body stays a line.
 */
export const SHOWN_PLACEHOLDER_MAX = 48;

/** White space - Unicode's included - or a control character of C0, DEL or C1. */
function isSpaceOrControl(character: string): boolean {
  const code = character.charCodeAt(0);

  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || /\s/.test(character);
}

/**
 * Where the `index`-th placeholder of a body stands, counted from 1 as
 * `TemplateProblem.index` counts it - each `{{` looked for from where the
 * last placeholder ended, its `}}` from just after it - with the offset of
 * its closing `}}`, or `-1` when it never closes. `null` when the body has
 * fewer. One pass, however many there are.
 */
export function placeholderAt(body: string, index: number): { open: number; close: number } | null {
  let from = 0;

  for (let place = 1; place <= index; place += 1) {
    const open = body.indexOf(TEMPLATE_OPEN, from);

    if (open === -1) {
      return null;
    }

    const close = body.indexOf(TEMPLATE_CLOSE, open + TEMPLATE_OPEN.length);

    if (place === index) {
      return { open, close };
    }

    if (close === -1) {
      return null;
    }

    from = close + TEMPLATE_CLOSE.length;
  }

  return null;
}

/**
 * A placeholder as a message shows it: `{{`, its inside as typed - each run
 * of white space and control characters as one space, cut at
 * `SHOWN_PLACEHOLDER_MAX` characters with `…` - and `}}`. Only the head of
 * the inside is read, however long it is.
 */
export function shownPlaceholder(inside: string): string {
  let looked = inside.slice(0, 4 * SHOWN_PLACEHOLDER_MAX);
  const longer = looked.length < inside.length;

  // A pair the slice cut in two leaves no half behind.
  if (longer && /[\uD800-\uDBFF]$/.test(looked)) {
    looked = looked.slice(0, -1);
  }

  const characters: string[] = [];

  for (const character of looked) {
    if (!isSpaceOrControl(character)) {
      characters.push(character);
    } else if (characters.at(-1) !== ' ') {
      characters.push(' ');
    }
  }

  const cut = longer || characters.length > SHOWN_PLACEHOLDER_MAX;
  const head = characters.slice(0, SHOWN_PLACEHOLDER_MAX).join('');

  return `${TEMPLATE_OPEN}${head}${cut ? '…' : ''}${TEMPLATE_CLOSE}`;
}

/** What the editor says of a problem, and the placeholder it names. */
export function describeTemplateProblem(
  body: string,
  problem: TemplateProblem,
  m: Messages = en,
): string {
  const place = placeholderAt(body, problem.index);

  if (problem.kind === 'unclosed' || place === null || place.close === -1) {
    return m.template.unclosed;
  }

  const inside = body.slice(place.open + TEMPLATE_OPEN.length, place.close);
  const shown = shownPlaceholder(inside);

  switch (problem.kind) {
    // A query placeholder is refused only for having no name at all.
    case 'query':
      return m.template.finish(shown, 'name');
    // A header's name is empty, or no HTTP token: only the first is unfinished.
    case 'header':
      return inside === 'request.header.'
        ? m.template.finish(shown, 'name')
        : m.template.unknown(shown);
    // A path with an empty key: one that ends in `.` is still being typed.
    case 'body':
      return inside.endsWith('.') ? m.template.finish(shown, 'path') : m.template.unknown(shown);
    case 'unknown':
      return m.template.unknown(shown);
  }
}

/**
 * The editor's check of a body that is a template (D251): what is wrong with
 * its placeholders, in the interface's words, or `undefined` when nothing is.
 * Read by the server's own module, so it refuses what the server refuses and
 * nothing else; linear in the body's length.
 */
export function templateError(body: string, m: Messages = en): string | undefined {
  const problem = templateProblem(body);

  return problem === null ? undefined : describeTemplateProblem(body, problem, m);
}

/** One run of a line: plain text, or a placeholder or a brace pair drawn in monospace. */
export interface TextPart {
  text: string;
  code: boolean;
}

const SPACE = /\s/;

/**
 * A line cut where it names placeholders, so they are drawn in monospace, as
 * the frames draw the hint and the errors (T2, T12): `{{` up to the first
 * `}}` with no white space between them is one placeholder, `{{request.id}}`;
 * a `{{` or a `}}` standing alone, as in `{{ without }}`, is one too. Linear:
 * once a `{{` finds no `}}` before white space or the end, no `{{` before that
 * point is looked at again.
 */
export function textParts(line: string): TextPart[] {
  const parts: TextPart[] = [];
  let plainFrom = 0;
  let index = 0;
  // A `{{` before this offset has no `}}` before the white space or end that stopped an earlier look.
  let noCloseBefore = 0;

  function push(text: string, code: boolean): void {
    if (text === '') {
      return;
    }

    const last = parts.at(-1);

    if (last !== undefined && last.code === code && !code) {
      last.text += text;
    } else {
      parts.push({ text, code });
    }
  }

  while (index < line.length) {
    const opens = line.startsWith(TEMPLATE_OPEN, index);
    const closes = !opens && line.startsWith(TEMPLATE_CLOSE, index);

    if (!opens && !closes) {
      index += 1;
      continue;
    }

    push(line.slice(plainFrom, index), false);

    let end = index + TEMPLATE_OPEN.length;

    if (opens && index >= noCloseBefore) {
      let look = end;

      while (
        look < line.length &&
        !line.startsWith(TEMPLATE_CLOSE, look) &&
        !SPACE.test(line.charAt(look))
      ) {
        look += 1;
      }

      if (line.startsWith(TEMPLATE_CLOSE, look)) {
        end = look + TEMPLATE_CLOSE.length;
      } else {
        noCloseBefore = look;
      }
    }

    push(line.slice(index, end), true);
    index = end;
    plainFrom = end;
  }

  push(line.slice(plainFrom), false);

  return parts;
}
