/**
 * Indents XML for display without ever re-serialising it (D163).
 *
 * JSON can be re-indented because the whitespace between its tokens means
 * nothing (D112). XML is not like that: whitespace inside an element is part of
 * the document, and indenting `<a>text<b/>more</a>` would change its text. So
 * this module moves only whitespace that is provably a gap, and leaves
 * everything else exactly as it arrived:
 *
 * - **An element whose content is elements alone** - at least one child
 *   element, and beside it only comments, processing instructions and white
 *   space - is drawn one child per line, two spaces deeper per level. The white
 *   space it stored between its children is display gap, like the gaps
 *   `json-format.ts` rewrites, and the computed indentation replaces it.
 * - **Any other element is its stored substring, character for character**: one
 *   with text in it (character data that is not white space, a CDATA section or
 *   a reference), one with no child element - empty, white space only, or
 *   holding only comments and processing instructions, such as
 *   `<password><!-- redacted --></password>` - and one whose `xml:space` is
 *   anything but `default`, together with everything inside it - an
 *   `xml:space="default"` deeper down does not undo that.
 * - **Around the root**, the XML declaration, comments and processing
 *   instructions each take a line of their own, and the white space between
 *   them is display gap too.
 *
 * Nothing is ever built from a parsed value: every tag, attribute, CDATA
 * section, comment, processing instruction, reference and the declaration is
 * emitted as the exact source substring it arrived as. Removing the added line
 * breaks and indentation gives back the stored text less its white-space gaps,
 * which `xml-format.test.ts` checks as a property rather than by example.
 *
 * Only well-formed XML 1.0 is indented, and the check is strict: text that a
 * forgiving parser would repair - HTML's `<br>`, an unquoted attribute, a
 * second root - is reported not well-formed and shown as stored. Misjudging
 * well-formed XML as malformed only costs the indentation; indenting malformed
 * XML would show a structure the sender never sent. Namespaces are not
 * resolved: a prefix is part of the name it is written in, and names are
 * matched as written. A document with a DOCTYPE, one that would be indented
 * deeper than `XML_MAX_DEPTH`, and one whose rendering would be longer than
 * `FORMATTED_MAX_CHARACTERS` are never indented (`XmlFormatResult`).
 *
 * `DOMParser` is not used, and nothing here needs a DOM: `detail-view.ts` is
 * tested without one (D070, D114). D163 accepts this second hand-written
 * tokenizer only together with its test table in `xml-format.test.ts`.
 */
import { exceedsFormatCeiling, FORMATTED_MAX_CHARACTERS } from './json-format.ts';

/** Two spaces per level, as `json-format.ts` indents. */
const INDENT = '  ';

/**
 * The deepest level a line of the rendering is indented to.
 *
 * Indentation grows with depth on every line, so the rendering of deep nesting
 * grows with the square of it: 20 000 nested elements, 140 KB stored, would
 * need more characters than a JavaScript string can hold, and the panel would
 * fail rather than show the body. Past 57 levels the indentation alone is
 * wider than the box in a 1440 px window (D149), so nothing readable is lost
 * by showing such a document as stored instead.
 */
export const XML_MAX_DEPTH = 100;

export type XmlFormatResult =
  /** Well-formed XML under the ceiling: `text` is the indented rendering. */
  | { status: 'formatted'; text: string }
  /** Not well-formed XML, or not XML at all. The caller shows the stored text. */
  | { status: 'invalid' }
  /**
   * Well-formed as far as this module checks, but it has a document type
   * declaration. A DTD can give an element `xml:space="preserve"` without the
   * element saying so, and this module reads no DTD, so it never indents such
   * a document. The caller shows the stored text and says why.
   */
  | { status: 'doctype' }
  /** Well-formed, but a line would be indented deeper than `XML_MAX_DEPTH`. */
  | { status: 'too-deep' }
  /**
   * Well-formed and within the depth limit, but the rendering would be longer
   * than `FORMATTED_MAX_CHARACTERS`, the same cap as JSON's (#64).
   */
  | { status: 'too-long' }
  /** Over the same 256 KiB ceiling as JSON (D112). Never inspected further. */
  | { status: 'too-large' };

/**
 * The display form of one body.
 *
 * Callers decide from the text itself and never from `Content-Type`, as for
 * JSON: senders lie, and the tool exists to show what arrived (D112, D163).
 */
export function formatXmlForDisplay(source: string): XmlFormatResult {
  if (exceedsFormatCeiling(source)) {
    return { status: 'too-large' };
  }

  const document = parse(source);

  if (document === null) {
    return { status: 'invalid' };
  }

  if (document.doctype) {
    return { status: 'doctype' };
  }

  // Measured first, with nothing built, as `json-format.ts` decides its depth:
  // a rendering too deep or too long is never built at all.
  const length = indent(source, document.items, null);

  if (length === null) {
    return { status: 'too-deep' };
  }

  if (length > FORMATTED_MAX_CHARACTERS) {
    return { status: 'too-long' };
  }

  const out: string[] = [];

  indent(source, document.items, out);

  return { status: 'formatted', text: out.join('') };
}

/**
 * Whether a text is well-formed XML 1.0 with no document type declaration, by
 * the same strict check `formatXmlForDisplay` makes, at any size: no ceiling
 * applies, since nothing is rendered. The build check reads the changelog's
 * Atom feeds with it (D212).
 */
export function isWellFormedXml(source: string): boolean {
  const document = parse(source);

  return document !== null && !document.doctype;
}

/**
 * A piece of markup the rendering puts on a line of its own, as a range of the
 * source. Text, CDATA sections and references are never items: they only ever
 * appear inside an element that is emitted whole.
 */
type Item =
  /** An empty-element tag, a comment, a processing instruction or the declaration. */
  | { kind: 'leaf'; start: number; end: number }
  | { kind: 'end'; start: number; end: number }
  | {
      kind: 'start';
      start: number;
      end: number;
      /** The index in `items` of the matching end tag. */
      close: number;
      /** Whether its content is elements alone, so its children get lines of their own. */
      indented: boolean;
    };

type StartItem = Extract<Item, { kind: 'start' }>;

interface OpenElement {
  name: string;
  item: StartItem;
  /** It holds character data that is not white space, a CDATA section or a reference. */
  text: boolean;
  /**
   * It holds a child element. Comments and processing instructions do not
   * count: they sit on lines of their own only beside a child element.
   */
  elements: boolean;
  /** Its `xml:space` is anything but `default`. */
  preserve: boolean;
}

interface ParsedDocument {
  items: Item[];
  doctype: boolean;
}

/** The only characters XML allows between markup: space, tab, CR and LF. */
function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function skipSpace(source: string, index: number): number {
  let cursor = index;

  while (isSpace(source[cursor])) {
    cursor += 1;
  }

  return cursor;
}

/**
 * A character XML 1.0 does not allow anywhere in a document: C0 controls other
 * than tab, LF and CR, a lone surrogate, U+FFFE and U+FFFF.
 */
const ILLEGAL_CHARACTER = /[^\t\n\r\x20-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/u;

/**
 * XML 1.0's `NameStartChar`, as ranges of code points. Kept as numbers rather
 * than a regular-expression class, where the combining marks and the zero-width
 * joiner the production lists would read as characters combined with their
 * neighbours.
 */
const NAME_START_RANGES: readonly (readonly [number, number])[] = [
  [0x3a, 0x3a],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
  [0xc0, 0xd6],
  [0xd8, 0xf6],
  [0xf8, 0x2ff],
  [0x370, 0x37d],
  [0x37f, 0x1fff],
  [0x200c, 0x200d],
  [0x2070, 0x218f],
  [0x2c00, 0x2fef],
  [0x3001, 0xd7ff],
  [0xf900, 0xfdcf],
  [0xfdf0, 0xfffd],
  [0x10000, 0xeffff],
];

/** XML 1.0's `NameChar`: a start character, or one of these. */
const NAME_RANGES: readonly (readonly [number, number])[] = [
  ...NAME_START_RANGES,
  [0x2d, 0x2e],
  [0x30, 0x39],
  [0xb7, 0xb7],
  [0x300, 0x36f],
  [0x203f, 0x2040],
];

function inRanges(code: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([first, last]) => code >= first && code <= last);
}

/** `&#x` hex digits `;` or `&#` decimal digits `;`, matched from `lastIndex`. */
const CHARACTER_REFERENCE = /&#(?:x([0-9a-fA-F]+)|([0-9]+));/y;

/** The entities XML defines without a DTD (XML 1.0 §4.6). */
const PREDEFINED_ENTITIES = new Set(['lt', 'gt', 'amp', 'apos', 'quot']);

const S = '[ \\t\\r\\n]';
const EQ = `${S}*=${S}*`;

/**
 * XML 1.0's `XMLDecl`, whole: version, then an optional encoding, then an
 * optional standalone flag, in that order and nothing else. The encoding is
 * shown as it was declared and never compared with how the body was decoded.
 */
const XML_DECLARATION = new RegExp(
  `<\\?xml${S}+version${EQ}(?:"1\\.[0-9]+"|'1\\.[0-9]+')` +
    `(?:${S}+encoding${EQ}(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?` +
    `(?:${S}+standalone${EQ}(?:"(?:yes|no)"|'(?:yes|no)'))?${S}*\\?>`,
  'y',
);

/** The index just past a name starting at `index`, or `-1` (XML 1.0's `Name`). */
function scanName(source: string, index: number): number {
  let cursor = index;

  while (cursor < source.length) {
    const code = source.codePointAt(cursor) as number;

    if (!inRanges(code, cursor === index ? NAME_START_RANGES : NAME_RANGES)) {
      break;
    }

    cursor += code > 0xffff ? 2 : 1;
  }

  return cursor === index ? -1 : cursor;
}

/** Whether a character reference names a character XML allows (XML 1.0 §4.1). */
function isLegalCharacter(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/**
 * The index just past a reference starting at `index`, or `-1`.
 *
 * Without a DTD only the five predefined entities are declared, so any other
 * name is an undefined entity and the document is not well-formed. After a
 * document type declaration any name is accepted, because the DTD may declare
 * it; such a document is never indented, so the leniency only decides which
 * reason the viewer gives.
 */
function scanReference(source: string, index: number, anyEntity: boolean): number {
  if (source[index + 1] === '#') {
    CHARACTER_REFERENCE.lastIndex = index;

    const match = CHARACTER_REFERENCE.exec(source);

    if (match === null) {
      return -1;
    }

    const [whole, hex, decimal] = match;
    const code = hex !== undefined ? parseInt(hex, 16) : parseInt(decimal as string, 10);

    return isLegalCharacter(code) ? index + whole.length : -1;
  }

  const nameEnd = scanName(source, index + 1);

  if (nameEnd === -1 || source[nameEnd] !== ';') {
    return -1;
  }

  return anyEntity || PREDEFINED_ENTITIES.has(source.slice(index + 1, nameEnd)) ? nameEnd + 1 : -1;
}

/** The index just past a comment starting at `index` (at `<!--`), or `-1`. */
function scanComment(source: string, index: number): number {
  // `--` may not appear inside a comment, so the first one must be its end.
  const close = source.indexOf('--', index + 4);

  return close !== -1 && source[close + 2] === '>' ? close + 3 : -1;
}

/**
 * The index just past a processing instruction starting at `index` (at `<?`),
 * or `-1`. Its target may not be `xml` in any case: that name is the
 * declaration's, and the declaration is only ever the first thing in the text.
 */
function scanProcessingInstruction(source: string, index: number): number {
  const targetEnd = scanName(source, index + 2);

  if (targetEnd === -1 || /^xml$/i.test(source.slice(index + 2, targetEnd))) {
    return -1;
  }

  if (source.startsWith('?>', targetEnd)) {
    return targetEnd + 2;
  }

  if (!isSpace(source[targetEnd])) {
    return -1;
  }

  const close = source.indexOf('?>', targetEnd);

  return close === -1 ? -1 : close + 2;
}

/**
 * The index just past a quoted literal starting at `index`, or `-1`.
 */
function scanQuoted(source: string, index: number): number {
  const close = source.indexOf(source[index] as string, index + 1);

  return close === -1 ? -1 : close + 1;
}

/**
 * The index just past a document type declaration starting at `index` (at
 * `<!DOCTYPE`), or `-1`.
 *
 * Read as an opaque token: its name, then anything up to the `>` that ends it,
 * past quoted literals and an internal subset in brackets, and within that
 * subset past comments and processing instructions, which may hold a `]` or a
 * `>` of their own. Its declarations are never interpreted. A document with
 * one is never indented, so this only has to find where it ends for the rest
 * of the document to be checked.
 */
function scanDoctype(source: string, index: number): number {
  let cursor = index + '<!DOCTYPE'.length;

  if (!isSpace(source[cursor])) {
    return -1;
  }

  cursor = scanName(source, skipSpace(source, cursor));

  let subsetRead = false;

  while (cursor !== -1 && cursor < source.length) {
    const char = source[cursor];

    if (char === '>') {
      return cursor + 1;
    }

    if (char === '"' || char === "'") {
      cursor = scanQuoted(source, cursor);
    } else if (char === '[' && !subsetRead) {
      cursor = scanInternalSubset(source, cursor + 1);
      subsetRead = true;
    } else if (char === '<' || char === '[' || char === ']') {
      return -1;
    } else {
      cursor += 1;
    }
  }

  return -1;
}

/** The index just past the `]` that ends an internal subset, or `-1`. */
function scanInternalSubset(source: string, index: number): number {
  let cursor = index;

  while (cursor !== -1 && cursor < source.length) {
    const char = source[cursor];

    if (char === ']') {
      return cursor + 1;
    }

    if (source.startsWith('<!--', cursor)) {
      cursor = scanComment(source, cursor);
    } else if (source.startsWith('<?', cursor)) {
      cursor = scanProcessingInstruction(source, cursor);
    } else if (char === '"' || char === "'") {
      cursor = scanQuoted(source, cursor);
    } else {
      cursor += 1;
    }
  }

  return -1;
}

/**
 * The index of the quote that closes an attribute value starting at `index`,
 * or `-1`. A value may not contain `<`, and every `&` in it must begin a
 * reference.
 */
function scanAttributeValue(
  source: string,
  index: number,
  quote: string,
  anyEntity: boolean,
): number {
  let cursor = index;

  while (cursor < source.length) {
    const char = source[cursor];

    if (char === quote) {
      return cursor;
    }

    if (char === '<') {
      return -1;
    }

    if (char === '&') {
      cursor = scanReference(source, cursor, anyEntity);

      if (cursor === -1) {
        return -1;
      }

      continue;
    }

    cursor += 1;
  }

  return -1;
}

interface StartTag {
  name: string;
  /** Just past its `>`. */
  end: number;
  /** `<name/>`, which opens nothing. */
  empty: boolean;
  preserve: boolean;
}

/**
 * A start tag or an empty-element tag starting at `index`, or `null`.
 *
 * Every attribute needs white space before it, `=` and a quoted value, and a
 * name may appear once per tag. `xml:space` with any value but `default` keeps
 * the element and everything in it as stored: `preserve` is the only other
 * value the specification names, and anything unexpected is shown as stored
 * rather than guessed at.
 */
function scanStartTag(source: string, index: number, anyEntity: boolean): StartTag | null {
  const nameEnd = scanName(source, index + 1);

  if (nameEnd === -1) {
    return null;
  }

  const name = source.slice(index + 1, nameEnd);
  const attributes = new Set<string>();
  let preserve = false;
  let cursor = nameEnd;

  for (;;) {
    const next = skipSpace(source, cursor);

    if (source[next] === '>') {
      return { name, end: next + 1, empty: false, preserve };
    }

    if (source.startsWith('/>', next)) {
      return { name, end: next + 2, empty: true, preserve };
    }

    if (next === cursor) {
      return null;
    }

    const attributeEnd = scanName(source, next);

    if (attributeEnd === -1) {
      return null;
    }

    const attribute = source.slice(next, attributeEnd);

    if (attributes.has(attribute)) {
      return null;
    }

    attributes.add(attribute);

    let valueStart = skipSpace(source, attributeEnd);

    if (source[valueStart] !== '=') {
      return null;
    }

    valueStart = skipSpace(source, valueStart + 1);

    const quote = source[valueStart];

    if (quote !== '"' && quote !== "'") {
      return null;
    }

    const valueEnd = scanAttributeValue(source, valueStart + 1, quote, anyEntity);

    if (valueEnd === -1) {
      return null;
    }

    if (attribute === 'xml:space') {
      preserve = source.slice(valueStart + 1, valueEnd) !== 'default';
    }

    cursor = valueEnd + 1;
  }
}

/**
 * Checks the whole text against XML 1.0's well-formedness rules and records
 * the markup the rendering will place, or returns `null`.
 *
 * Iterative, with an explicit stack of open elements, for the reason
 * `json-format.ts` gives: deep nesting is ordinary input for a webhook
 * inspector, and it must not overflow the stack of the tab showing it.
 */
function parse(source: string): ParsedDocument | null {
  if (ILLEGAL_CHARACTER.test(source)) {
    return null;
  }

  const items: Item[] = [];
  const open: OpenElement[] = [];
  let root: 'before' | 'inside' | 'after' = 'before';
  let doctype = false;
  let index = 0;

  // The declaration is only ever the very first thing: not after white space,
  // and not after a byte-order mark either, because the backend's decoder has
  // already removed the one a body can carry (see D163).
  if (source.startsWith('<?xml') && isSpace(source[5])) {
    XML_DECLARATION.lastIndex = 0;

    const declaration = XML_DECLARATION.exec(source);

    if (declaration === null) {
      return null;
    }

    items.push({ kind: 'leaf', start: 0, end: declaration[0].length });
    index = declaration[0].length;
  }

  while (index < source.length) {
    const parent = open.at(-1);
    const char = source[index];

    if (char !== '<' && char !== '&') {
      // Character data, up to the next markup or reference.
      let end = index;
      let blank = true;

      while (end < source.length && source[end] !== '<' && source[end] !== '&') {
        const current = source[end] as string;

        if (!isSpace(current)) {
          blank = false;
        }

        // `]]>` may not appear in character data.
        if (current === '>' && end - index >= 2 && source.startsWith(']]', end - 2)) {
          return null;
        }

        end += 1;
      }

      // Outside the root only white space may appear, and it is display gap.
      if (!blank) {
        if (parent === undefined) {
          return null;
        }

        parent.text = true;
      }

      index = end;
      continue;
    }

    if (char === '&') {
      if (parent === undefined) {
        return null;
      }

      index = scanReference(source, index, doctype);

      if (index === -1) {
        return null;
      }

      parent.text = true;
      continue;
    }

    if (source.startsWith('<!--', index) || source.startsWith('<?', index)) {
      const end =
        source[index + 1] === '!'
          ? scanComment(source, index)
          : scanProcessingInstruction(source, index);

      if (end === -1) {
        return null;
      }

      items.push({ kind: 'leaf', start: index, end });
      index = end;
      continue;
    }

    if (source.startsWith('<![CDATA[', index)) {
      const close = source.indexOf(']]>', index + '<![CDATA['.length);

      if (parent === undefined || close === -1) {
        return null;
      }

      parent.text = true;
      index = close + 3;
      continue;
    }

    if (source.startsWith('<!DOCTYPE', index)) {
      // Once, and before the root.
      if (root !== 'before' || doctype) {
        return null;
      }

      index = scanDoctype(source, index);

      if (index === -1) {
        return null;
      }

      doctype = true;
      continue;
    }

    if (source[index + 1] === '/') {
      if (parent === undefined) {
        return null;
      }

      const nameEnd = scanName(source, index + 2);

      if (nameEnd === -1 || source.slice(index + 2, nameEnd) !== parent.name) {
        return null;
      }

      const end = skipSpace(source, nameEnd);

      if (source[end] !== '>') {
        return null;
      }

      open.pop();
      parent.item.close = items.length;
      parent.item.indented = parent.elements && !parent.text && !parent.preserve;
      items.push({ kind: 'end', start: index, end: end + 1 });
      index = end + 1;

      if (open.length === 0) {
        root = 'after';
      }

      continue;
    }

    // A start tag or an empty-element tag. Only one element may be the root.
    if (root === 'after') {
      return null;
    }

    const tag = scanStartTag(source, index, doctype);

    if (tag === null) {
      return null;
    }

    if (parent !== undefined) {
      parent.elements = true;
    }

    if (tag.empty) {
      items.push({ kind: 'leaf', start: index, end: tag.end });

      if (parent === undefined) {
        root = 'after';
      }
    } else {
      const item: StartItem = {
        kind: 'start',
        start: index,
        end: tag.end,
        close: -1,
        indented: false,
      };

      items.push(item);
      open.push({ name: tag.name, item, text: false, elements: false, preserve: tag.preserve });
      root = 'inside';
    }

    index = tag.end;
  }

  return root === 'after' && open.length === 0 ? { items, doctype } : null;
}

/**
 * The rendering: each item on a line of its own at its depth, and an element
 * that is not indented as its stored substring, whole, with nothing inside it
 * visited.
 *
 * The gaps the stored text had between these items are simply not emitted, and
 * everything that is emitted is a slice of the source. Where `out` is given
 * the rendering is built into it; without, nothing is built and it is only
 * measured. Answers its length in characters, or `null` where a line would be
 * indented deeper than `XML_MAX_DEPTH`.
 */
function indent(source: string, items: Item[], out: string[] | null): number | null {
  let length = 0;
  let depth = 0;
  let index = 0;

  /** Appends a range of the source to the rendering, where one is being built, and counts it. */
  const emit = (start: number, end: number): void => {
    length += end - start;
    out?.push(source.slice(start, end));
  };

  while (index < items.length) {
    const item = items[index] as Item;

    if (item.kind === 'end') {
      depth -= 1;
    }

    if (depth > XML_MAX_DEPTH) {
      return null;
    }

    // Every item is at least two characters of markup, so only the first one
    // starts where nothing has been counted yet.
    if (length > 0) {
      length += 1 + INDENT.length * depth;
      out?.push(`\n${INDENT.repeat(depth)}`);
    }

    if (item.kind === 'start' && !item.indented) {
      emit(item.start, (items[item.close] as Item).end);
      index = item.close + 1;
      continue;
    }

    emit(item.start, item.end);

    if (item.kind === 'start') {
      depth += 1;
    }

    index += 1;
  }

  return length;
}
