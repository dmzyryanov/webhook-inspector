/**
 * Response templates (D251, issue #135): a response marked `template: true`
 * has placeholders in its body replaced with values of the captured request it
 * answers. The grammar, its check and the substitution live here, pure and
 * free of Node's APIs, so the server checks a template at save and fills it in
 * at capture by these rules, and an editor can check one by the same rules.
 *
 * The set is fixed, a placeholder is read, never computed, and there is no
 * expression of any kind:
 *
 * - `{{request.id}}` - the stored request's id;
 * - `{{request.method}}` - its method, as stored;
 * - `{{request.path}}` - its path, as stored, without the query string;
 * - `{{request.query.<name>}}` - the first value of a query parameter, the
 *   query string decoded as `URLSearchParams` decodes it;
 * - `{{request.header.<name>}}` - the first value of a header, its name
 *   matched case-insensitively, its bytes read as UTF-8;
 * - `{{request.body.<path>}}` - a field of a JSON body: dot-separated keys,
 *   a key of digits indexing an array, own properties only.
 *
 * With the flag on, every `{{` starts a placeholder: one that is not of the
 * set, or that never closes, is refused at save, and there is no escape for a
 * literal `{{`. Nothing may stand inside the braces but the placeholder - no
 * space, no control character, no further brace.
 */
import { HEADER_NAME_PATTERN, MAX_RESPONSE_BODY_BYTES } from './index.ts';

/** What opens and closes a placeholder. */
export const TEMPLATE_OPEN = '{{';
export const TEMPLATE_CLOSE = '}}';

/** The placeholders a template may hold, as they are written; `<...>` is the user's part. */
export const TEMPLATE_PLACEHOLDERS: readonly string[] = [
  '{{request.id}}',
  '{{request.method}}',
  '{{request.path}}',
  '{{request.query.<name>}}',
  '{{request.header.<name>}}',
  '{{request.body.<path>}}',
];

const QUERY_PREFIX = 'request.query.';
const HEADER_PREFIX = 'request.header.';
const BODY_PREFIX = 'request.body.';

/** One placeholder of the set, as the grammar reads it. */
export type TemplatePlaceholder =
  | { kind: 'id' }
  | { kind: 'method' }
  | { kind: 'path' }
  | { kind: 'query'; name: string }
  /** `name` in lower case: a header is matched case-insensitively. */
  | { kind: 'header'; name: string }
  /** The keys of the path, in order, none empty. */
  | { kind: 'body'; path: string[] };

/** A template read into its parts: literal text, and the placeholders between it. */
export type TemplatePart = string | TemplatePlaceholder;

/**
 * Why a body is not a template (D251), with the place of the offending
 * placeholder - `index` counts the `{{` of the body from 1 - and nothing of
 * what it holds, so a refusal can name it without echoing it (D106):
 *
 * - `unclosed`: a `{{` with no `}}` after it;
 * - `unknown`: the braces hold something that is not a placeholder of the set,
 *   with a space, a control character or a brace inside them among it;
 * - `header`: `{{request.header.<name>}}` whose name is not an HTTP token;
 * - `query`: `{{request.query.}}`, a query placeholder with no name;
 * - `body`: `{{request.body.<path>}}` whose path is empty or holds an empty key.
 */
export interface TemplateProblem {
  kind: 'unclosed' | 'unknown' | 'header' | 'query' | 'body';
  index: number;
}

export type TemplateReading =
  { ok: true; parts: TemplatePart[] } | { ok: false; problem: TemplateProblem };

/** White space - Unicode's included, as JavaScript's `\s` reads it - or a brace. */
const SPACE_OR_BRACE = /[\s{}]/;

/**
 * Whether `text` may stand between the braces: something, and nothing of
 * white space, a control character (C0, DEL or C1) or a brace.
 */
function isPlaceholderText(text: string): boolean {
  if (text === '' || SPACE_OR_BRACE.test(text)) {
    return false;
  }

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return false;
    }
  }

  return true;
}

/**
 * Reads a template into its parts, or names the first placeholder that breaks
 * the grammar. Linear in the template's length: each `{{` is looked for from
 * where the last placeholder ended, its `}}` from just after it, and the first
 * problem ends the reading - so 65,536 `{` or 32,768 `{{` cost one pass.
 */
export function readTemplate(template: string): TemplateReading {
  const parts: TemplatePart[] = [];
  let from = 0;
  let index = 0;

  for (;;) {
    const open = template.indexOf(TEMPLATE_OPEN, from);

    if (open === -1) {
      break;
    }

    index += 1;

    const close = template.indexOf(TEMPLATE_CLOSE, open + TEMPLATE_OPEN.length);

    if (close === -1) {
      return { ok: false, problem: { kind: 'unclosed', index } };
    }

    const placeholder = readPlaceholder(template.slice(open + TEMPLATE_OPEN.length, close));

    if (typeof placeholder === 'string') {
      return { ok: false, problem: { kind: placeholder, index } };
    }

    if (open > from) {
      parts.push(template.slice(from, open));
    }

    parts.push(placeholder);
    from = close + TEMPLATE_CLOSE.length;
  }

  if (from < template.length) {
    parts.push(template.slice(from));
  }

  return { ok: true, parts };
}

/** The problem with a body as a template, or `null` when it is one. */
export function templateProblem(template: string): TemplateProblem | null {
  const reading = readTemplate(template);

  return reading.ok ? null : reading.problem;
}

function readPlaceholder(
  text: string,
): TemplatePlaceholder | Exclude<TemplateProblem['kind'], 'unclosed'> {
  if (!isPlaceholderText(text)) {
    return 'unknown';
  }

  switch (text) {
    case 'request.id':
      return { kind: 'id' };
    case 'request.method':
      return { kind: 'method' };
    case 'request.path':
      return { kind: 'path' };
  }

  if (text.startsWith(QUERY_PREFIX)) {
    const name = text.slice(QUERY_PREFIX.length);

    return name === '' ? 'query' : { kind: 'query', name };
  }

  if (text.startsWith(HEADER_PREFIX)) {
    const name = text.slice(HEADER_PREFIX.length);

    return HEADER_NAME_PATTERN.test(name) ? { kind: 'header', name: name.toLowerCase() } : 'header';
  }

  if (text.startsWith(BODY_PREFIX)) {
    const path = text.slice(BODY_PREFIX.length).split('.');

    return path.some((key) => key === '') ? 'body' : { kind: 'body', path };
  }

  return 'unknown';
}

/**
 * How a value is written into the body (D251), chosen by the answer's
 * effective `Content-Type`:
 *
 * - `json` - inside a JSON string: `"`, `\`, every control character, U+2028,
 *   U+2029 and a lone surrogate escaped, so a quoted placeholder stays one
 *   valid JSON string whatever the value holds;
 * - `markup` - HTML or XML: `&`, `<`, `>`, `"` and `'` written as entities,
 *   so a value is text and never markup;
 * - `raw` - every other type: the value as it is.
 */
export type TemplateEscaping = 'json' | 'markup' | 'raw';

/** The media type an answer without a configured `Content-Type` is sent as (D179). */
const DEFAULT_MEDIA_TYPE = 'application/json';

const MARKUP_TYPES = ['text/html', 'application/xhtml+xml', 'text/xml', 'application/xml'];

/**
 * The escaping of an answer whose configured headers are `headers` (D251):
 * by the media type of the first configured `Content-Type` pair - what comes
 * before any `;`, without white space around it, in lower case - or
 * `application/json` when none is configured, as the head then sends it.
 * `application/json` and every `+json` type are `json`; `text/html`,
 * `application/xhtml+xml`, `text/xml`, `application/xml` and every `+xml`
 * type are `markup`; anything else, an empty or unreadable value included, is
 * `raw`.
 */
export function templateEscaping(
  headers: readonly (readonly [string, string])[],
): TemplateEscaping {
  const pair = headers.find(([name]) => name.toLowerCase() === 'content-type');
  const mediaType =
    pair === undefined ? DEFAULT_MEDIA_TYPE : (pair[1].split(';')[0] ?? '').trim().toLowerCase();
  const slash = mediaType.indexOf('/');

  if (slash <= 0) {
    return 'raw';
  }

  if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
    return 'json';
  }

  if (MARKUP_TYPES.includes(mediaType) || mediaType.endsWith('+xml')) {
    return 'markup';
  }

  return 'raw';
}

/** A value written for `escaping`. */
export function escapeTemplateValue(value: string, escaping: TemplateEscaping): string {
  switch (escaping) {
    case 'json':
      // JSON.stringify escapes `"`, `\`, the control characters and a lone
      // surrogate; U+2028 and U+2029 are valid JSON, and escaped as well so
      // the text stays valid JavaScript too.
      return JSON.stringify(value)
        .slice(1, -1)
        .replaceAll('\u2028', '\\u2028')
        .replaceAll('\u2029', '\\u2029');
    case 'markup':
      return value.replace(/[&<>"']/g, (character) => MARKUP_ENTITIES[character] ?? character);
    case 'raw':
      return value;
  }
}

const MARKUP_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * The bytes of `text` in UTF-8, as it is sent: a lone surrogate is written as
 * U+FFFD, three bytes, as `Buffer.from` and `TextEncoder` write it.
 */
export function utf8Bytes(text: string): number {
  let bytes = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

/**
 * What a template is filled in from: the request as it is stored, the id and
 * method and path as the record holds them, the query string as received after
 * its `?`, the headers as captured - name and value pairs in their order,
 * each value one character a byte, as Node reads it - and the body's bytes.
 */
export interface TemplateRequest {
  id: string;
  method: string;
  path: string;
  queryString: string;
  headers: readonly (readonly [string, string])[];
  body: Uint8Array;
}

/** A value not yet known, known missing, or the text it is. */
type Resolved = string | null;

/**
 * Fills in a template (D251) from `request`, its values written for
 * `escaping`, the whole at most `maxBytes` of UTF-8. Answers `null` when
 * `template` is not a template at all - which only a body saved by a version
 * that did not check it can be - so the caller sends it as configured.
 *
 * - Values are taken in the order the placeholders stand, each written whole
 *   only if it fits in what the literal text and the values before it left of
 *   `maxBytes`; one that does not renders empty, and the ones after it are
 *   still taken if they fit. The literal text is always written.
 * - A missing value renders empty: an absent header or query parameter, a body
 *   that is not valid UTF-8 or not JSON, a path that leads nowhere, and a
 *   `null`, an object or an array. A string is its text, a number its JSON
 *   text, `true` and `false` themselves.
 * - The work is bounded by what is sent, not by what is repeated: a value is
 *   resolved and escaped once per distinct placeholder; one longer, in
 *   characters, than what is left is never escaped, since each character is a
 *   byte at least; and the body is parsed once, and only when a placeholder of
 *   it is reached with room left.
 * - It never throws for a request: a placeholder whose value cannot be read,
 *   for whatever reason, renders empty.
 */
export function renderTemplate(
  template: string,
  request: TemplateRequest,
  escaping: TemplateEscaping,
  maxBytes: number = MAX_RESPONSE_BODY_BYTES,
): string | null {
  const reading = readTemplate(template);

  if (!reading.ok) {
    return null;
  }

  let left = maxBytes;

  for (const part of reading.parts) {
    if (typeof part === 'string') {
      left -= utf8Bytes(part);
    }
  }

  const values = new RequestValues(request);
  const written = new Map<string, { text: string; bytes: number } | null>();
  const out: string[] = [];

  for (const part of reading.parts) {
    if (typeof part === 'string') {
      out.push(part);
      continue;
    }

    if (left <= 0) {
      continue;
    }

    const key = placeholderKey(part);
    let value = written.get(key);

    if (value === undefined) {
      value = writtenValue(values.read(part), escaping, left);
      written.set(key, value);
    }

    if (value !== null && value.bytes <= left) {
      out.push(value.text);
      left -= value.bytes;
    }
  }

  return out.join('');
}

/**
 * One value as written, with its bytes, or `null` when it renders empty
 * wherever it stands: it is missing or empty, or it does not fit in `left`,
 * which only shrinks. Only a value that fits is kept whole.
 */
function writtenValue(
  value: Resolved,
  escaping: TemplateEscaping,
  left: number,
): { text: string; bytes: number } | null {
  if (value === null || value === '' || value.length > left) {
    return null;
  }

  const text = escapeTemplateValue(value, escaping);

  // Escaping at most sextuples a character, so this is bounded by `left`.
  if (text.length > left) {
    return null;
  }

  const bytes = utf8Bytes(text);

  return bytes <= left ? { text, bytes } : null;
}

/** A placeholder's identity: two that read the same value share it. */
function placeholderKey(placeholder: TemplatePlaceholder): string {
  switch (placeholder.kind) {
    case 'id':
    case 'method':
    case 'path':
      return placeholder.kind;
    case 'query':
    case 'header':
      return `${placeholder.kind}:${placeholder.name}`;
    case 'body':
      return `body:${placeholder.path.join('.')}`;
  }
}

/** A key of digits that indexes an array: `0`, or digits not starting with `0`. */
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

/**
 * The values of one request, each source read only when a placeholder first
 * asks for it, and once: the query string into its first values, the headers
 * into theirs, the body into JSON. Nothing is shared between two requests.
 */
class RequestValues {
  readonly #request: TemplateRequest;
  #query: Map<string, string> | undefined;
  #headers: Map<string, string> | undefined;
  #body: { value: unknown } | undefined;

  constructor(request: TemplateRequest) {
    this.#request = request;
  }

  read(placeholder: TemplatePlaceholder): Resolved {
    try {
      switch (placeholder.kind) {
        case 'id':
          return this.#request.id;
        case 'method':
          return this.#request.method;
        case 'path':
          return this.#request.path;
        case 'query':
          return this.#queryValues().get(placeholder.name) ?? null;
        case 'header': {
          const value = this.#headerValues().get(placeholder.name);

          return value === undefined ? null : latin1AsUtf8(value);
        }
        case 'body':
          return bodyValue(this.#bodyValue(), placeholder.path);
      }
    } catch {
      // A value that cannot be read is a missing one: a template never costs
      // a request its answer, let alone its capture.
      return null;
    }
  }

  #queryValues(): Map<string, string> {
    if (this.#query === undefined) {
      this.#query = new Map();

      for (const [name, value] of new URLSearchParams(this.#request.queryString)) {
        if (!this.#query.has(name)) {
          this.#query.set(name, value);
        }
      }
    }

    return this.#query;
  }

  #headerValues(): Map<string, string> {
    if (this.#headers === undefined) {
      this.#headers = new Map();

      for (const [name, value] of this.#request.headers) {
        const lower = name.toLowerCase();

        if (!this.#headers.has(lower)) {
          this.#headers.set(lower, value);
        }
      }
    }

    return this.#headers;
  }

  /** The body as JSON, or `undefined` when it is not valid UTF-8 or not JSON. */
  #bodyValue(): unknown {
    if (this.#body === undefined) {
      this.#body = { value: undefined };

      try {
        // `fatal` refuses a body that is not UTF-8 rather than reading it with
        // replacement characters; a leading byte order mark is skipped.
        const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#request.body);

        this.#body = { value: JSON.parse(text) as unknown };
      } catch {
        // Not UTF-8, not JSON, or nested past what the parser takes: no body
        // placeholder has a value.
      }
    }

    return this.#body.value;
  }
}

/**
 * Header values come one character a byte, as Node reads them; the body is
 * UTF-8, so the bytes are read as UTF-8, a sequence that is not one becoming
 * U+FFFD. A value holding a wider character came from elsewhere and is taken
 * as it is.
 */
function latin1AsUtf8(value: string): string {
  const bytes = new Uint8Array(value.length);

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code > 0xff) {
      return value;
    }

    bytes[index] = code;
  }

  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * The value at `path` in `root`, as text, or `null` when there is none: each
 * key read from an object only as its own property, from an array only as an
 * index of digits within it - `1e20`, `-1` or `01` index nothing - and from
 * anything else not at all. A string is its text, a finite number its JSON
 * text, a boolean `true` or `false`; `null`, an object, an array and a number
 * JSON cannot write render empty.
 */
function bodyValue(root: unknown, path: readonly string[]): Resolved {
  let value = root;

  for (const key of path) {
    if (Array.isArray(value)) {
      if (!ARRAY_INDEX.test(key)) {
        return null;
      }

      const index = Number(key);

      if (!(index < value.length)) {
        return null;
      }

      value = value[index] as unknown;
    } else if (typeof value === 'object' && value !== null && Object.hasOwn(value, key)) {
      value = (value as Record<string, unknown>)[key];
    } else {
      return null;
    }
  }

  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : null;
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      return null;
  }
}
