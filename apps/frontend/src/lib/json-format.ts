/**
 * Re-indents JSON for display without ever re-serialising it (D112).
 *
 * The rule the whole module exists for: **every scalar keeps the exact source
 * substring it arrived as, and only the whitespace between tokens changes.**
 * `JSON.parse` followed by `JSON.stringify` would push every number through a
 * double - `12345678901234567890` becomes `12345678901234567000`, `1e5` becomes
 * `100000`, `1.50` becomes `1.5` - drop duplicate keys and normalise escape
 * sequences. For a tool whose first priority is correctness of capture, showing
 * a different number than the one that arrived is the worst available failure,
 * so this file never calls `JSON.parse` and never builds a value at all.
 *
 * It is the least conventional piece of frontend code in the project, and D112
 * accepts it only together with its test table in `json-format.test.ts`.
 * Shrinking that table removes the only thing that justifies the tokenizer.
 *
 * Validation is strict RFC 8259: no comments, no trailing commas, no unquoted
 * keys. Text that a lenient parser would accept must be reported invalid, or
 * the viewer would render something that is not what arrived. Valid JSON
 * nested deeper than `JSON_MAX_DEPTH` is not re-indented either (D169), nor is
 * JSON whose rendering would be longer than `FORMATTED_MAX_CHARACTERS` (#64).
 */

/**
 * Above this, the body is shown as stored rather than re-indented (D112) - or
 * decoded into rows, for a form body (D162). A multipart body is split into
 * its parts up to this many bytes, not counting the content of its parts that
 * are not UTF-8, which the parts view never draws (D164).
 */
export const JSON_FORMAT_MAX_BYTES = 256 * 1024;

/**
 * The deepest nesting that is re-indented: at most this many objects and
 * arrays open around any token (D169). The same number as `XML_MAX_DEPTH`
 * (D163), for the same reason.
 *
 * Every line is indented two spaces per level, so the rendering of deep
 * nesting grows with the square of its depth: 5 000 nested arrays, a 10 KB
 * body, would be drawn as 50 million characters, and 20 000, 40 KB, as more
 * than a JavaScript string can hold, which failed the panel rather than showing
 * the body. Past 57 levels the indentation alone is wider than the box in a
 * 1440 px window (D149), so nothing readable is lost by showing deeper JSON as
 * stored. At this limit no line is indented deeper than 100 levels, as for XML.
 */
export const JSON_MAX_DEPTH = 100;

/**
 * The longest rendering that is drawn, in characters; the same cap for JSON
 * and XML (D169, D163, as amended for #64).
 *
 * The depth limit bounds how deep a line is indented, not how large the whole
 * rendering is: at most about 202 characters per body byte, some 53 million
 * just under the ceiling, and a body built for it reaches 47.9 million. The
 * time goes on drawing that text, not on formatting it: 26 million characters
 * froze a production build for about 22 s. Ordinary JSON and XML under the
 * ceiling format to a small multiple of their size - the densest plausible
 * JSON measured, 130 000 single digits three levels deep, to 1 170 032
 * characters - so this cap only turns away bodies built to be drawn large.
 *
 * Counted before anything is built, so a rendering over the cap is never
 * built at all.
 */
export const FORMATTED_MAX_CHARACTERS = 2_000_000;

/** Two spaces, the same indent `JSON.stringify(value, null, 2)` produces. */
const INDENT = '  ';

export type JsonFormatResult =
  /** Valid JSON under the ceiling: `text` is the re-indented rendering. */
  | { status: 'formatted'; text: string }
  /** Not valid JSON. The caller shows the stored text and says why. */
  | { status: 'invalid' }
  /** Valid JSON nested deeper than `JSON_MAX_DEPTH`. The caller shows the stored text and says why. */
  | { status: 'too-deep' }
  /**
   * Valid JSON within the depth limit whose rendering would be longer than
   * `FORMATTED_MAX_CHARACTERS`. The caller shows the stored text and says why.
   */
  | { status: 'too-long' }
  /** Valid or not, it is too large to re-indent. Never inspected further. */
  | { status: 'too-large' };

/**
 * The display form of one body.
 *
 * JSON describes itself, so this decides from the text alone and never from
 * `Content-Type`: senders lie, and the tool exists to show what arrived. A
 * body that is valid JSON is re-indented whatever its header claims (D112,
 * D162).
 */
export function formatJsonForDisplay(source: string): JsonFormatResult {
  if (exceedsFormatCeiling(source)) {
    return { status: 'too-large' };
  }

  const tokens = tokenize(source);

  if (tokens === null) {
    return { status: 'invalid' };
  }

  // Checked first, with nothing built: indenting deep nesting is what costs the
  // square of its depth, and this pass costs no more than reading the tokens.
  // It also counts the rendering's length, so one over the cap is never built.
  const measure = reindent(tokens, null);

  if (measure === null) {
    return { status: 'invalid' };
  }

  if (measure.deepest > JSON_MAX_DEPTH) {
    return { status: 'too-deep' };
  }

  if (measure.length > FORMATTED_MAX_CHARACTERS) {
    return { status: 'too-long' };
  }

  const out: string[] = [];

  reindent(tokens, out);

  return { status: 'formatted', text: out.join('') };
}

/**
 * Whether a body is above `JSON_FORMAT_MAX_BYTES`, the ceiling above which the
 * Body view inspects nothing at all (D112, D162).
 *
 * Bytes of UTF-8, which is what every documented limit in this project counts.
 * A UTF-8 encoding is never shorter than the string's UTF-16 length, so the
 * cheap comparison decides the large cases without allocating a copy of a
 * megabyte-sized body on every render.
 *
 * `xml-format.ts` applies the same ceiling through this function (D163).
 */
export function exceedsFormatCeiling(source: string): boolean {
  if (source.length > JSON_FORMAT_MAX_BYTES) {
    return true;
  }

  return new TextEncoder().encode(source).length > JSON_FORMAT_MAX_BYTES;
}

type Token =
  | { type: 'punct'; text: '{' | '}' | '[' | ']' | ',' | ':' }
  /** A number or one of `true`, `false`, `null`, kept as its source substring. */
  | { type: 'scalar'; text: string }
  /** A string, kept as its source substring including the quotes and escapes. */
  | { type: 'string'; text: string };

type Punctuation = '{' | '}' | '[' | ']' | ',' | ':';

const PUNCTUATION = new Set<string>(['{', '}', '[', ']', ',', ':']);
const LITERALS = ['true', 'false', 'null'];

/** The four characters JSON allows between tokens, and no others. */
function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

/** Splits the source into tokens, or `null` where it is not lexical JSON. */
function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index] as string;

    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    if (PUNCTUATION.has(char)) {
      tokens.push({ type: 'punct', text: char as Punctuation });
      index += 1;
      continue;
    }

    if (char === '"') {
      const end = scanString(source, index);

      if (end === -1) {
        return null;
      }

      tokens.push({ type: 'string', text: source.slice(index, end) });
      index = end;
      continue;
    }

    if (char === '-' || isDigit(char)) {
      const end = scanNumber(source, index);

      if (end === -1) {
        return null;
      }

      tokens.push({ type: 'scalar', text: source.slice(index, end) });
      index = end;
      continue;
    }

    const literal = LITERALS.find((candidate) => source.startsWith(candidate, index));

    if (literal === undefined) {
      return null;
    }

    tokens.push({ type: 'scalar', text: literal });
    index += literal.length;
  }

  return tokens;
}

/**
 * The index just past a string's closing quote, or `-1`.
 *
 * Escapes are validated but never decoded: a surrogate pair written as two
 * `\uXXXX` escapes stays written that way, because re-encoding it is exactly
 * the kind of silent rewrite this module exists to avoid. An unescaped control
 * character is invalid JSON, so it is reported rather than passed through.
 */
function scanString(source: string, start: number): number {
  let index = start + 1;

  while (index < source.length) {
    const char = source[index] as string;

    if (char === '"') {
      return index + 1;
    }

    if (char === '\\') {
      const escaped = source[index + 1];

      if (escaped === undefined) {
        return -1;
      }

      if (escaped === 'u') {
        const hex = source.slice(index + 2, index + 6);

        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return -1;
        }

        index += 6;
        continue;
      }

      if (!'"\\/bfnrt'.includes(escaped)) {
        return -1;
      }

      index += 2;
      continue;
    }

    if (char.charCodeAt(0) < 0x20) {
      return -1;
    }

    index += 1;
  }

  return -1;
}

/**
 * The index just past a number, or `-1`.
 *
 * The grammar only decides where the number ends; the digits themselves are
 * never converted. `1e5`, `1.50` and `-0` all survive as typed, and an integer
 * beyond `Number.MAX_SAFE_INTEGER` is never at risk because no `Number` is ever
 * produced from it.
 */
function scanNumber(source: string, start: number): number {
  let index = start;

  if (source[index] === '-') {
    index += 1;
  }

  if (source[index] === '0') {
    index += 1;
  } else if (isDigit(source[index])) {
    while (isDigit(source[index])) {
      index += 1;
    }
  } else {
    return -1;
  }

  if (source[index] === '.') {
    index += 1;

    if (!isDigit(source[index])) {
      return -1;
    }

    while (isDigit(source[index])) {
      index += 1;
    }
  }

  if (source[index] === 'e' || source[index] === 'E') {
    index += 1;

    if (source[index] === '+' || source[index] === '-') {
      index += 1;
    }

    if (!isDigit(source[index])) {
      return -1;
    }

    while (isDigit(source[index])) {
      index += 1;
    }
  }

  return index;
}

type Expect = 'value' | 'key' | 'colon' | 'comma-or-close' | 'done';

interface Frame {
  kind: '{' | '[';
  /** Nothing has been written inside it yet, so `{}` and `[]` stay on one line. */
  empty: boolean;
}

/** What a walk over the tokens found, where they are JSON. */
interface Walk {
  /** The deepest nesting met: the most objects and arrays open at once. */
  deepest: number;
  /** How many characters the indented rendering has, built or not. */
  length: number;
}

/**
 * Checks the token sequence against the JSON grammar and, where `out` is given,
 * emits the indented text into it in the same pass. Answers the deepest
 * nesting it met and the length of the rendering, or `null` where the tokens
 * are not JSON.
 *
 * `formatJsonForDisplay` runs it twice: first with no `out`, which builds
 * nothing and so costs the same at any depth and any length, and a second
 * time, to build the rendering, only for JSON no deeper than `JSON_MAX_DEPTH`
 * (D169) whose rendering is no longer than `FORMATTED_MAX_CHARACTERS` (#64).
 *
 * Iterative rather than recursive on purpose: a deeply nested captured payload
 * is ordinary input for a webhook inspector, and it must not be able to
 * overflow the stack of the tab showing it.
 *
 * Nothing here looks at what a key *is*, so duplicate keys are emitted as many
 * times as they arrived and in the order they arrived.
 */
function reindent(tokens: Token[], out: string[] | null): Walk | null {
  const stack: Frame[] = [];
  let expect: Expect = 'value';
  let deepest = 0;
  let length = 0;

  /** Appends to the rendering, where one is being built, and counts it. */
  const write = (text: string): void => {
    length += text.length;

    if (out !== null) {
      out.push(text);
    }
  };

  /**
   * A line break indented to the current depth. The indentation is only built
   * where a rendering is: it is the part that grows with the square of the
   * depth. Elsewhere it is only counted.
   */
  const breakLine = (): void => {
    length += 1 + INDENT.length * stack.length;

    if (out !== null) {
      out.push(`\n${INDENT.repeat(stack.length)}`);
    }
  };

  for (const token of tokens) {
    if (expect === 'done') {
      // A complete value followed by anything else: trailing garbage.
      return null;
    }

    const frame = stack.at(-1);

    if (token.type === 'punct') {
      if (token.text === '{' || token.text === '[') {
        if (expect !== 'value') {
          return null;
        }

        openContainer(frame, breakLine);
        write(token.text);
        stack.push({ kind: token.text, empty: true });
        deepest = Math.max(deepest, stack.length);
        expect = token.text === '{' ? 'key' : 'value';
        continue;
      }

      if (token.text === '}' || token.text === ']') {
        const opener = token.text === '}' ? '{' : '[';
        const emptyExpect: Expect = token.text === '}' ? 'key' : 'value';

        if (frame === undefined || frame.kind !== opener) {
          return null;
        }

        if (expect !== 'comma-or-close' && !(expect === emptyExpect && frame.empty)) {
          return null;
        }

        stack.pop();

        if (!frame.empty) {
          breakLine();
        }

        write(token.text);
        expect = stack.length === 0 ? 'done' : 'comma-or-close';
        continue;
      }

      if (token.text === ',') {
        if (expect !== 'comma-or-close' || frame === undefined) {
          return null;
        }

        write(',');
        breakLine();
        expect = frame.kind === '{' ? 'key' : 'value';
        continue;
      }

      if (expect !== 'colon') {
        return null;
      }

      write(': ');
      expect = 'value';
      continue;
    }

    if (expect === 'key') {
      if (token.type !== 'string') {
        return null;
      }

      openContainer(frame, breakLine);
      write(token.text);
      expect = 'colon';
      continue;
    }

    if (expect !== 'value') {
      return null;
    }

    openContainer(frame, breakLine);
    write(token.text);
    expect = stack.length === 0 ? 'done' : 'comma-or-close';
  }

  return expect === 'done' && stack.length === 0 ? { deepest, length } : null;
}

/** Breaks the line before a container's first entry, once. */
function openContainer(frame: Frame | undefined, breakLine: () => void): void {
  if (frame === undefined || !frame.empty) {
    return;
  }

  frame.empty = false;
  breakLine();
}
