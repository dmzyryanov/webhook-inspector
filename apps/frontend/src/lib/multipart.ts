/**
 * Splits a multipart body into its parts, from its exact bytes, at the
 * boundary its `Content-Type` declares (D164).
 *
 * It works on binary strings, one character per byte (`bytes.ts`), so the one
 * splitter serves a text body - its UTF-8 bytes, which are the stored bytes
 * but for one leading byte-order mark the backend's decoder removed (D164) -
 * and a binary one - `bodyBase64` - alike, the way `Raw` splits its bytes
 * (D145). Nothing here builds a display: `detail-view.ts` turns a split into
 * the block the Body tab draws, and says why a body was not split.
 *
 * The rules are RFC 2046 §5.1.1's, on bytes:
 *
 * - the boundary is the `boundary` parameter of a `multipart/*` media type,
 *   and nothing else. It is never inferred from a leading `--…` line: a
 *   payload cannot describe itself here, which is what lets the label be read
 *   at all (D162);
 * - a delimiter is CRLF, `--` and the boundary, at the start of a line. The
 *   CRLF belongs to the delimiter, not to the part before it, and the very
 *   first one may stand at the start of the body without it. After it come
 *   transport padding - spaces and tabs - and CRLF, or, for the closing
 *   delimiter, `--`, padding, and CRLF or the end of the body. Anything else
 *   after the boundary means the line is not a delimiter at all;
 * - only CRLF is a line break. A body written with bare LF has no delimiter
 *   line, and is not split;
 * - what comes before the first delimiter is the preamble, and what follows
 *   the closing delimiter's line is the epilogue. Neither is a part;
 * - a part is its headers, up to the first empty line, and its content after
 *   it. A part may have no headers - it then starts with that empty line - and
 *   one with no empty line at all is headers and no content, as the grammar
 *   reads it;
 * - one level only: a part that is itself `multipart/*` is a part like any
 *   other, and its content is not split again.
 */
import { decodeUtf8 } from './bytes.ts';

/** What a `Content-Type` value says about splitting a body. */
export type MultipartLabel =
  /** Not a `multipart/*` media type, or no `Content-Type` at all. */
  | { kind: 'not-multipart' }
  /** `multipart/*` without a `boundary` parameter, or with an empty one. */
  | { kind: 'no-boundary' }
  | { kind: 'boundary'; boundary: string };

/** One part, in the order it was recorded. */
export interface MultipartPart {
  /**
   * Its headers in order, repeated names kept, each value without the white
   * space around it and with folded lines joined. Read as `Raw` reads a head:
   * as UTF-8 where the part's header bytes are valid UTF-8, and otherwise one
   * character per byte (D145).
   */
  headers: [string, string][];
  /** The `name` parameter of its first `Content-Disposition`, or `null`. */
  name: string | null;
  /**
   * The file name its first `Content-Disposition` gives: `filename*` where it
   * is UTF-8 or ISO-8859-1 and decodes, `filename` otherwise, and `null` where
   * there is neither or the one given is empty.
   */
  filename: string | null;
  /**
   * The media type of its first `Content-Type`, as written and without its
   * parameters, or `null` where it declares none.
   */
  contentType: string | null;
  /** The exact number of bytes of its content. */
  size: number;
  /** Its content decoded as UTF-8, or `null` where it is not valid UTF-8. */
  text: string | null;
}

export type MultipartSplit =
  | {
      status: 'split';
      /** At least one. */
      parts: MultipartPart[];
      /** How many bytes precede the first delimiter. */
      preambleBytes: number;
      /** How many bytes follow the closing delimiter's line. */
      epilogueBytes: number;
    }
  /** No delimiter line opens a part: the boundary never occurs as one, or only closes. */
  | { status: 'no-delimiter' }
  /** Parts are opened, and the closing delimiter never comes. */
  | { status: 'no-close' };

const CRLF = '\r\n';

/**
 * Reads the boundary off a `Content-Type` value, whose media type is matched
 * in any case and whose parameters are parsed with their quoting
 * (`parseHeaderValue`), so `Multipart/Form-Data; Boundary="a b"` has the
 * boundary `a b`. The boundary itself is case-sensitive, and kept as written.
 */
export function multipartLabel(contentType: string | null): MultipartLabel {
  if (contentType === null) {
    return { kind: 'not-multipart' };
  }

  const { value, parameters } = parseHeaderValue(contentType);

  if (!value.toLowerCase().startsWith('multipart/')) {
    return { kind: 'not-multipart' };
  }

  const boundary = parameterValue(parameters, 'boundary');

  return boundary === null || boundary === ''
    ? { kind: 'no-boundary' }
    : { kind: 'boundary', boundary };
}

/**
 * The parts of `bytes`, a binary string, split at `boundary` (see the rules
 * above), or why it could not be split.
 */
export function splitMultipart(bytes: string, boundary: string): MultipartSplit {
  const dashBoundary = `--${boundary}`;
  const delimiter = `${CRLF}${dashBoundary}`;

  /*
   * The delimiter line whose `--boundary` starts at `index`: whether it
   * closes, and where what follows its line begins. `null` where the text
   * there is not a delimiter line.
   */
  const lineAt = (index: number): { closes: boolean; next: number } | null => {
    if (!bytes.startsWith(dashBoundary, index)) {
      return null;
    }

    let cursor = index + dashBoundary.length;
    const closes = bytes.startsWith('--', cursor);

    if (closes) {
      cursor += 2;
    }

    while (bytes[cursor] === ' ' || bytes[cursor] === '\t') {
      cursor += 1;
    }

    if (bytes.startsWith(CRLF, cursor)) {
      return { closes, next: cursor + CRLF.length };
    }

    return closes && cursor === bytes.length ? { closes, next: cursor } : null;
  };

  /*
   * The next delimiter at or after `from`, as the index of its CRLF, which
   * ends whatever came before it. An occurrence of the text that is not a
   * delimiter line is skipped.
   */
  const nextDelimiter = (from: number) => {
    for (let index = bytes.indexOf(delimiter, from); index !== -1;) {
      const line = lineAt(index + CRLF.length);

      if (line !== null) {
        return { index, line };
      }

      index = bytes.indexOf(delimiter, index + 1);
    }

    return null;
  };

  const atStart = lineAt(0);
  const first = atStart === null ? nextDelimiter(0) : { index: 0, line: atStart };

  if (first === null || first.line.closes) {
    return { status: 'no-delimiter' };
  }

  const parts: MultipartPart[] = [];
  let start = first.line.next;

  for (;;) {
    const next = nextDelimiter(start);

    if (next === null) {
      return { status: 'no-close' };
    }

    parts.push(readPart(bytes.slice(start, next.index)));

    if (next.line.closes) {
      return {
        status: 'split',
        parts,
        preambleBytes: first.index,
        epilogueBytes: bytes.length - next.line.next,
      };
    }

    start = next.line.next;
  }
}

/**
 * A header value's leading item and its parameters: `form-data; name="a"` is
 * `form-data` with `name` = `a`. The shape `Content-Type` (RFC 9110 §5.6.6)
 * and `Content-Disposition` (RFC 6266) share.
 *
 * Parameter names are lower-cased and values kept as written. A quoted value
 * may hold `;`. Inside it only `\"` and `\\` are escapes, read as `"` and
 * `\`; every other backslash is kept as it stands, so `"a\b.txt"` is
 * `a\b.txt`. Browsers and curl write a `"` in a file name as `%22` and never
 * escape a backslash, so resolving every quoted pair, as RFC 9110 allows, would
 * drop the backslash of a Windows path such senders put there as it is. White
 * space around `;` and `=` is allowed, a parameter with no `=` is skipped, and
 * an unterminated quote runs to the end - a lenient reading, since the header
 * is shown as it arrived in the part's rows either way.
 */
export function parseHeaderValue(text: string): {
  value: string;
  parameters: [string, string][];
} {
  const semicolon = text.indexOf(';');
  const value = (semicolon === -1 ? text : text.slice(0, semicolon)).trim();
  const parameters: [string, string][] = [];
  let index = semicolon === -1 ? text.length : semicolon + 1;

  while (index < text.length) {
    while (index < text.length && ' \t;'.includes(text[index] as string)) {
      index += 1;
    }

    const nameStart = index;

    while (index < text.length && text[index] !== '=' && text[index] !== ';') {
      index += 1;
    }

    const name = text.slice(nameStart, index).trim().toLowerCase();

    if (text[index] !== '=') {
      continue;
    }

    index += 1;

    while (text[index] === ' ' || text[index] === '\t') {
      index += 1;
    }

    let parameter = '';

    if (text[index] === '"') {
      index += 1;

      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\' && (text[index + 1] === '"' || text[index + 1] === '\\')) {
          index += 1;
        }

        parameter += text[index];
        index += 1;
      }

      // Past the closing quote, and past anything after it before the next `;`.
      while (index < text.length && text[index] !== ';') {
        index += 1;
      }
    } else {
      const valueStart = index;

      while (index < text.length && text[index] !== ';') {
        index += 1;
      }

      parameter = text.slice(valueStart, index).trim();
    }

    if (name !== '') {
      parameters.push([name, parameter]);
    }
  }

  return { value, parameters };
}

/** The first parameter of that name, or `null`. */
function parameterValue(parameters: readonly [string, string][], name: string): string | null {
  return parameters.find(([candidate]) => candidate === name)?.[1] ?? null;
}

/** One part's bytes, between its delimiter line and the next delimiter's CRLF. */
function readPart(bytes: string): MultipartPart {
  let head: string;
  let content: string;

  if (bytes.startsWith(CRLF)) {
    // No headers: the part starts with the empty line that ends them.
    head = '';
    content = bytes.slice(CRLF.length);
  } else {
    const end = bytes.indexOf(`${CRLF}${CRLF}`);

    head = end === -1 ? bytes : bytes.slice(0, end);
    content = end === -1 ? '' : bytes.slice(end + 2 * CRLF.length);
  }

  const headers = readHeaders(decodeUtf8(head) ?? head);
  const disposition = firstHeader(headers, 'content-disposition');
  const parameters = disposition === null ? [] : parseHeaderValue(disposition).parameters;
  const type = firstHeader(headers, 'content-type');
  const mediaType = type === null ? '' : parseHeaderValue(type).value;
  const extended = parameterValue(parameters, 'filename*');
  const filename =
    (extended === null ? null : decodeExtendedValue(extended)) ??
    parameterValue(parameters, 'filename');

  return {
    headers,
    name: parameterValue(parameters, 'name'),
    filename: filename === '' ? null : filename,
    contentType: mediaType === '' ? null : mediaType,
    size: content.length,
    text: decodeUtf8(content),
  };
}

/**
 * Header lines as name/value rows. A line that starts with a space or a tab
 * continues the one before it, and is joined to it without the line break
 * (RFC 5322 §2.2.3). A line without a colon is kept as a name with an empty
 * value, so nothing that arrived goes unshown.
 */
function readHeaders(head: string): [string, string][] {
  const rows: [string, string][] = [];

  for (const line of head.split(CRLF)) {
    const last = rows.at(-1);

    if (last !== undefined && (line.startsWith(' ') || line.startsWith('\t'))) {
      last[1] = trimSpace(`${last[1]}${line}`);
      continue;
    }

    if (line === '') {
      continue;
    }

    const colon = line.indexOf(':');

    rows.push(colon === -1 ? [line, ''] : [line.slice(0, colon), trimSpace(line.slice(colon + 1))]);
  }

  return rows;
}

/** Without the spaces and tabs around it: HTTP's optional white space, and nothing else. */
function trimSpace(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/g, '');
}

function firstHeader(headers: readonly [string, string][], name: string): string | null {
  return headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1] ?? null;
}

/**
 * An RFC 8187 value, `charset'language'value`, where the charset is UTF-8 or
 * ISO-8859-1 and every byte outside the plain characters is percent-escaped,
 * or `null` where it is not that simple - and the plain `filename` is used.
 */
function decodeExtendedValue(text: string): string | null {
  const match = /^([^']*)'[^']*'(.*)$/s.exec(text);

  if (match === null) {
    return null;
  }

  const charset = (match[1] ?? '').toLowerCase();
  const encoded = match[2] ?? '';
  let bytes = '';

  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index] as string;

    if (character === '%') {
      const hex = encoded.slice(index + 1, index + 3);

      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
        return null;
      }

      bytes += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
    } else if (character.charCodeAt(0) > 0x7e || character.charCodeAt(0) < 0x21) {
      return null;
    } else {
      bytes += character;
    }
  }

  if (charset === 'utf-8') {
    return decodeUtf8(bytes);
  }

  // A binary string is ISO-8859-1 exactly (`bytes.ts`).
  return charset === 'iso-8859-1' ? bytes : null;
}
