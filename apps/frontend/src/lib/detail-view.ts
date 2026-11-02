/**
 * What each code block in the inspector shows, and what copying it yields
 * (D112, D122).
 *
 * Every tab on both halves of the panel is described here as data, so that the
 * component renders a model rather than deciding one. That seam is what makes
 * the two claims the release makes about these blocks testable without a DOM
 * (D070, D114):
 *
 * - the Body view re-indents valid JSON and indents well-formed XML under the
 *   ceiling, draws a body labelled as a form as decoded name/value rows and
 *   one labelled multipart as its parts, and shows everything else as stored,
 *   **always with a reason line** - there is no Formatted/Original toggle to
 *   explain an unformatted render (D112, D162, D163, D164);
 * - copying yields the **whole** content of the block, never the fragment that
 *   happens to be on screen or the breaks the browser drew. Layout is invisible
 *   to a test, so a later refactor toward "copy what is visible" would pass
 *   everything else;
 * - **every block wraps** (D134, D149), and how a wrapped line continues - flush
 *   with the block's edge, or hanging two columns deeper than its own line in
 *   indented JSON or XML - is decided here and carried in the model, so it is an
 *   assertion rather than a class read out of a component. So is the caption
 *   that says a line was folded.
 */
import {
  STATUSES_WITHOUT_BODY,
  type RequestDetails,
  type ResponseRecord,
} from '@webhook-inspector/shared';
import {
  exceedsFormatCeiling,
  formatJsonForDisplay,
  FORMATTED_MAX_CHARACTERS,
  JSON_FORMAT_MAX_BYTES,
  JSON_MAX_DEPTH,
} from './json-format.ts';
import { formatXmlForDisplay, XML_MAX_DEPTH } from './xml-format.ts';
import { decodeFormUrlencoded } from './form-urlencoded.ts';
import { multipartLabel, splitMultipart, type MultipartPart } from './multipart.ts';
import { binaryString, decodeUtf8 } from './bytes.ts';
import { formatBytesCompact } from './format.ts';
import { isAddressShortened } from './address.ts';
import { en, type Messages } from '../i18n/en.ts';

/** What a block puts on the screen. */
export type BlockContent =
  /**
   * One run of text: a body, a raw representation, a Base64 rendering.
   *
   * Every one of them wraps, and nothing in the panel scrolls sideways (D134,
   * D149). `wrap` says where a wrapped line continues:
   *
   * - `hanging` for re-indented JSON and indented XML (D163), where the
   *   indentation of a line is its depth: a continuation starts two columns
   *   deeper than its own line, so it can never be read as a sibling key or
   *   element (see `hangingRuns`);
   * - `flush` everywhere else, at the block's left edge, because a run with no
   *   structure to preserve has no column to keep.
   *
   * `text` is the whole content, and it is what the copy control yields.
   * `display`, where it is present, is what the screen draws instead - see
   * `textOnScreen`.
   */
  | { kind: 'text'; text: string; wrap: TextWrap; display?: string }
  /**
   * Name/value rows, in the order they were recorded, duplicates kept (D045):
   * `Headers`, `Query`, and `Body` of a form (D162). A long value wraps inside
   * the value column and its name keeps its row.
   */
  | { kind: 'pairs'; pairs: readonly (readonly [string, string])[]; separator: string }
  /**
   * A multipart body as its parts, in recorded order, one box each (D164).
   * The block has no copy control of its own: each part whose content is
   * shown carries one for exactly that content (`BodyPart`).
   */
  | { kind: 'parts'; parts: readonly BodyPart[] }
  /** There is nothing to show, and the block says so instead of being blank. */
  | { kind: 'empty'; placeholder: string };

/** One part of a multipart body, as its box draws it (D164). */
export interface BodyPart {
  /** `Part 1`: its place in the recorded order, counted from one. */
  title: string;
  /** The `name` from its `Content-Disposition`, or `null` where it has none. */
  name: string | null;
  /**
   * What it is and how large its content is, in the one size format:
   * `text · 16 B`, `invoice.pdf · application/pdf · 47.1 KB` (see `partSummary`).
   */
  summary: string;
  /** Its own headers, in order, repeated names kept. */
  headers: readonly (readonly [string, string])[];
  /**
   * Its content exactly as stored where that is UTF-8 - never formatted, and
   * exactly what its copy control yields - or, in its place, a note with no
   * copy control: for content that is not UTF-8, whose bytes stay in `Raw`,
   * and for a part with no content at all.
   */
  content: { kind: 'text'; text: string } | { kind: 'note'; note: string };
}

/** Where the continuation of a wrapped line starts. */
export type TextWrap = 'flush' | 'hanging';

export interface BlockModel {
  content: BlockContent;
  /**
   * The line above the block, read before its content (D149). Mandatory
   * wherever a body is shown as stored rather than re-indented or decoded into
   * rows (D112, D162), and it says so wherever a line wraps.
   */
  caption: string | null;
}

/** A block showing one run of text, so that its `wrap` can be read back. */
interface TextBlockModel extends BlockModel {
  content: Extract<BlockContent, { kind: 'text' }>;
}

/** Separates a header name from its value when the rows are copied. */
const HEADER_SEPARATOR = ': ';
/**
 * Separates a query parameter from its value when the rows are copied, and a
 * field of a form body from its value: the two are the same data (D162).
 */
const QUERY_SEPARATOR = '=';

/*
 * What a block says about itself - every caption, placeholder and note - is
 * the dictionary's `blocks` (D222), English by default: `m` below. Each says
 * what the renderer did, never what the sender claimed (D112, D145, D162-D164).
 */

/**
 * A media type the Body view reads off `Content-Type`, because the payload
 * cannot describe itself (D162). The other is `multipart/*`, whose boundary
 * only the label carries (D164, `multipart.ts`).
 */
const FORM_URLENCODED = 'application/x-www-form-urlencoded';

/** Ends the head of a stored representation in both composers (D049, D109). */
const HEAD_END = '\r\n\r\n';

/**
 * A rendered line wider than this is taken not to fit the block, so it wraps,
 * and the caption says so.
 *
 * The caption is decided here, without a layout, so whether a line wraps is
 * estimated rather than measured, and the estimate is calibrated for a 1440 px
 * window: there the box's text column is about 830 px, about 114.7 columns of
 * the code face at 12/20, and the margin covers the tab area's own scrollbar
 * where the platform draws one and the spread between monospace faces (D071).
 * At 1440 px it therefore errs towards saying so: a line of 111 to 114 columns
 * gets the sentence and does not wrap. In a narrower window it errs the other
 * way. About 105 columns fit at 1366 px and about 93 at 1280 px, so a line
 * between those and 110 columns wraps there without the sentence (D149).
 */
const MAX_FITTING_COLUMNS = 110;

/**
 * Where a continuation of re-indented JSON starts, relative to its own line
 * (D149): two columns deeper, which is one level of the formatter's indent, so
 * the rest of a long value sits under its key's content and never under a key
 * of its own. Indented XML uses the same indent and the same rule (D163).
 */
export const HANGING_INDENT_COLUMNS = 2;

/**
 * The fewest columns a hanging continuation keeps to wrap in.
 *
 * A line's hanging indent is padding inside the box, and padding as wide as
 * the box would leave the line no room at all, so it would run out of the box
 * sideways - the one thing this layout exists to stop. So a continuation never
 * starts closer than this to the box's right edge. In a box 114 columns wide
 * (a 1440 px window) the hang stays two columns deeper than its line to 48
 * levels of nesting; in one 57 wide (1024 px) to 19. Deeper than that, a
 * continuation starts one column deeper than its line, level with it or
 * shallower - the one departure from "two characters deeper" (D149).
 *
 * It is applied twice: to `HangingRun.hang` from the box as last measured, and
 * in CSS against the box as it is now (`hangingIndentStyle`), so a measurement
 * that is a frame old cannot push a line out of a box that has just narrowed.
 */
export const MIN_CONTINUATION_COLUMNS = 16;

/**
 * The widest start of a member - indentation, key, `: ` and the value's first
 * character - kept on one row with its value (see `HangingRun.keep`).
 *
 * The start is drawn unbreakable, so it must never be wider than the box. A
 * fixed width rather than a share of the box as measured makes that true
 * whatever the measurement: `CodeBlock` draws the start breakable again in any
 * box narrower than this many characters, through a container query written
 * with the same number (`@max-[56ch]`), which the unit tests hold together.
 */
export const KEPT_KEY_COLUMNS = 56;

/**
 * The name column of a `Headers` or `Query` block is capped at this share of
 * the box, so a very long name cannot squeeze its value to nothing; such a
 * name wraps in its own column (D149).
 */
const NAME_COLUMN_SHARE = 0.4;

/** The gap between the name and the value columns, 24 px, in columns. */
const PAIR_GAP_COLUMNS = 3;

/*
 * `blocks.wrapped` is added to a block's caption where a line is in fact too
 * wide to fit.
 *
 * A wrapped line looks exactly like several stored lines, and these blocks
 * exist to show what arrived - so where the view has folded a line, it says so
 * rather than letting the reader count breaks that are not in the data. It is
 * added only where a line actually wraps, so a short raw request or a small
 * Base64 body says nothing new (D134, D149).
 */

/**
 * The whole text of the block, which is exactly what the copy control puts on
 * the clipboard (D122). The breaks the browser draws where a line wraps are
 * layout, never content, and are not in it (D149).
 *
 * It is the text the block displays, with one exception: `Raw` of a
 * representation with no body draws its head without the blank line that ends
 * it, and copying still yields that blank line (`textOnScreen`, D158).
 *
 * `Body` yields the re-indented text as displayed, because formatting is the
 * point of that view and handing back the unformatted original would give the
 * user something other than what they were looking at. `Raw` yields the stored
 * representation as displayed: where it is not UTF-8, the head as text and the
 * body part as Base64, exactly as on screen (D145). A binary body yields its
 * Base64 block. `Headers`, `Query` and `Body` of a form yield their full
 * rendered content: a grid has no literal separator between a name and its
 * value, so each row is yielded with one written in. For a header that
 * reproduces the `Raw` block's own `name: value` line; for a query parameter
 * or a form field it reproduces what the rows display, `name=value`, which is
 * the **decoded** value - the encoded query string or body stays in `Raw` (see
 * `requestQueryBlock`, D162).
 *
 * An empty block yields nothing, and the control renders disabled rather than
 * writing an empty string to the clipboard.
 *
 * A multipart body drawn as its parts yields nothing either, because it has no
 * copy control of its own (D164). Each part whose content is shown carries
 * one, which yields exactly that content (`BodyPart.content`); the whole body,
 * delimiters and all, is copied from `Raw`.
 */
export function blockCopyText(content: BlockContent): string {
  switch (content.kind) {
    case 'text':
      return content.text;

    case 'pairs':
      return content.pairs.map(([name, value]) => `${name}${content.separator}${value}`).join('\n');

    case 'parts':
    case 'empty':
      return '';
  }
}

/** Whether the copy control on this block is offered at all (D122). */
export function isCopyable(content: BlockContent): boolean {
  return blockCopyText(content).length > 0;
}

/**
 * What the copy control on one part of a multipart body yields: exactly its
 * content as stored, never formatted. `null` where the part shows a note in
 * place of its content - content that is not UTF-8, or none at all - and then
 * the part carries no copy control (D164).
 */
export function partCopyText(part: BodyPart): string | null {
  return part.content.kind === 'text' ? part.content.text : null;
}

/**
 * What a text block draws on the screen: its `text`, or `display` where the
 * model set one.
 *
 * The model sets one in exactly one case (issue #51, D158): `Raw`, on either
 * half, of a representation that is a head and nothing after it - a `GET`, a
 * `204`, a custom response with no body, a `HEAD` response, and a head that
 * is not UTF-8 (D145) alike. A head ends with an empty line, CRLF CRLF. With a
 * body that line parts the head from it and stays; with none it is only a gap
 * after the last header, so the block ends at the last header line instead.
 *
 * Copying still yields `text`, the stored representation exactly, CRLF CRLF
 * included, so a copied request replays with `nc` or Burp as it arrived. That
 * is a named exception to D122's "copy yields what is shown", and the only
 * difference between the two is that invisible line ending.
 */
export function textOnScreen(content: Extract<BlockContent, { kind: 'text' }>): string {
  return content.display ?? content.text;
}

/**
 * A piece of re-indented JSON or indented XML as `CodeBlock` draws it: one
 * stored line that may wrap, or several consecutive lines that cannot.
 */
export interface HangingRun {
  /** The text exactly as it is in the block, leading spaces and `\n` included. */
  text: string;
  /**
   * What `CodeBlock` draws for the run: `text`, and for lines that fit and are
   * followed by a line that wraps, `text` and one more `\n`.
   *
   * A line that wraps is drawn as a block of its own, which starts on a row of
   * its own, so the break before it is never drawn as text. But a break at the
   * very end of a run of text makes no row of its own either, so a run ending
   * in an empty line - or a run that is one empty line, between two lines that
   * wrap - would draw one row too few. Stored XML can hold empty lines, and the
   * block exists to show it as stored (D163), so the break before the next line
   * is drawn after all: `x` still draws one row, `x` and an empty line two, and
   * an empty line one. Copying is unaffected; it yields the text, not the runs.
   */
  drawn: string;
  /**
   * The index of the run's first stored line. It names the run across a
   * redraw for another width, so the elements of lines that stay the same
   * are kept - which is what the browser's scroll anchoring holds the reading
   * position by.
   */
  line: number;
  /**
   * The column a wrapped continuation starts at: the line's own indentation
   * plus `HANGING_INDENT_COLUMNS`, never closer than
   * `MIN_CONTINUATION_COLUMNS` to the box's right edge. `null` for a run of
   * lines that fit the box, which never wrap and need none.
   */
  hang: number | null;
  /**
   * How many characters at the start of the line are drawn without a break
   * between them: the indentation, the key, `: ` and the value's first
   * character, so a value too long for its row starts beside its key and is
   * cut there, as the design draws it, rather than leaving the key alone on a
   * row of its own. `0` where the line has no key, or where that start is wider
   * than `KEPT_KEY_COLUMNS`: then the key may end its row alone and the value
   * start on the continuation.
   */
  keep: number;
}

/**
 * The hanging indent of one line as CSS: padded to `hang` columns and pulled
 * back by the same amount on its first row (D149).
 *
 * Both are clamped against the box itself, so that a continuation keeps at
 * least `MIN_CONTINUATION_COLUMNS` to wrap in whatever `hang` was computed
 * from. The measurement `hang` comes from can be a frame old - the window has
 * just been narrowed and the box not yet measured again - and without the
 * clamp that frame drew deep lines out of the box. `cqi` is the width of the
 * `pre` the line is in, which is a size container, and is used rather than a
 * percentage because Chromium resolves a percentage `text-indent` against the
 * line's own width after its padding, not against the box: the first row would
 * no longer start at the edge.
 */
export function hangingIndentStyle(hang: number): { paddingLeft: string; textIndent: string } {
  const column = `min(${hang}ch, max(0px, calc(100cqi - ${MIN_CONTINUATION_COLUMNS}ch)))`;

  return { paddingLeft: column, textIndent: `calc(-1 * ${column})` };
}

/**
 * Re-indented JSON or indented XML cut into the runs `CodeBlock` draws for a
 * box `columns` wide, each line that wraps on its own with the column its
 * continuations start at (D149, D163).
 *
 * Every line keeps its leading spaces. The component draws a line from column
 * zero and moves only its continuations in, so the text on screen is still the
 * text itself: a selection copied by hand keeps its indentation, and joining
 * the runs with `\n` gives back exactly what the copy control yields.
 *
 * `columns` is how many characters of the code face the box holds, which the
 * component measures. A line that fits never wraps, so consecutive ones are
 * drawn together as one run of plain text, and only a line that really wraps
 * becomes an element of its own. That is what keeps a body of a hundred
 * thousand lines under the 256 KiB ceiling - an array of numbers, or short
 * members nested deep enough to be long only by their indentation - a few
 * text nodes rather than tens of thousands of elements.
 *
 * Both formatters indent with spaces only, and neither writes an empty line of
 * its own. An XML element shown as stored keeps its lines as they arrived,
 * empty ones and tabs included; each is a line like any other here, and hangs
 * from its own leading spaces. An empty line keeps its row (see
 * `HangingRun.drawn`), and a tab is measured as the widest it can draw
 * (`columnsUpTo`).
 */
export function hangingRuns(text: string, columns: number): HangingRun[] {
  const runs: HangingRun[] = [];
  const deepest = Math.max(0, columns - MIN_CONTINUATION_COLUMNS);
  const lines = text.split('\n');
  let fitting = 0;

  // `beforeWrap`: whether a line that wraps follows, drawn as a block of its own.
  const flush = (end: number, beforeWrap: boolean) => {
    if (fitting < end) {
      const text = lines.slice(fitting, end).join('\n');

      runs.push({
        text,
        drawn: beforeWrap ? `${text}\n` : text,
        line: fitting,
        hang: null,
        keep: 0,
      });
    }
  };

  lines.forEach((line, index) => {
    // A code unit other than a tab is never drawn wider than two columns, so
    // a line without one of at most half the box fits without counting it.
    if (
      (line.length * 2 <= columns && !line.includes('\t')) ||
      columnsUpTo(line, columns) <= columns
    ) {
      return;
    }

    flush(index, true);
    runs.push({
      text: line,
      drawn: line,
      line: index,
      hang: Math.min(leadingSpaces(line) + HANGING_INDENT_COLUMNS, deepest),
      keep: keyPrefixLength(line),
    });
    fitting = index + 1;
  });

  flush(lines.length, false);

  return runs;
}

/**
 * The length of a re-indented `"key": value` line's start, up to and including
 * the value's first character, or `0` where there is no key or the start is
 * wider than `KEPT_KEY_COLUMNS` (see `HangingRun.keep`).
 *
 * The formatter writes a member as the key's source string, `: `, and the
 * value, so the key ends at its first unescaped quote. The value's first
 * character is always ASCII: a quote, a digit, a minus sign, a bracket or the
 * first letter of `true`, `false` or `null`.
 *
 * A line of indented XML starts with `<` and keeps nothing. A line of text
 * inside an XML element shown as stored may happen to look like a member; its
 * start is then kept together too, which moves where the line may break and
 * changes nothing it shows.
 */
function keyPrefixLength(line: string): number {
  const start = leadingSpaces(line);

  if (line[start] !== '"') {
    return 0;
  }

  let index = start + 1;

  while (index < line.length && line[index] !== '"') {
    index += line[index] === '\\' ? 2 : 1;
  }

  // `index` is the key's closing quote: keep it, `: ` and one character more.
  const keep = index + 4;

  if (line.slice(index + 1, index + 3) !== ': ' || keep > line.length) {
    return 0;
  }

  return columnsUpTo(line.slice(0, keep), KEPT_KEY_COLUMNS) <= KEPT_KEY_COLUMNS ? keep : 0;
}

function leadingSpaces(line: string): number {
  let count = 0;

  while (line.charCodeAt(count) === 0x20) {
    count += 1;
  }

  return count;
}

// --- Request side -----------------------------------------------------------

/**
 * The request's stored representation, never re-indented on either half (D112).
 * It is the permanent home of the original text now that no toggle reaches it.
 *
 * A representation that is not UTF-8 still shows its request line and headers
 * as text, and only the part that is not text as Base64 (D145).
 */
export function requestRawBlock(details: RequestDetails, m: Messages = en): BlockModel {
  // Said only where a row actually had to shorten the address, which is the
  // one situation in which the two surfaces disagree about what they show.
  const caption = isAddressShortened(details.sourceIp) ? m.blocks.addressShortened : null;

  if (details.isRawBinary) {
    return binaryRawBlock(details.rawBase64 ?? '', caption, m.blocks.rawRequestBase64, m);
  }

  if (details.raw === null || details.raw === '') {
    return { content: { kind: 'empty', placeholder: m.blocks.noRawRequest }, caption: null };
  }

  return rawTextBlock(details.raw, caption, m);
}

export function requestBodyBlock(details: RequestDetails, m: Messages = en): BlockModel {
  if (details.isBinary) {
    return binaryBodyBlock(details.bodyBase64 ?? '', details.headers, m);
  }

  // Before any detection, so an empty body labelled as a form is still no body.
  if (details.body === null || details.body === '') {
    return {
      content: { kind: 'empty', placeholder: m.blocks.noRequestBody },
      caption: m.blocks.noRequestBodyCaption,
    };
  }

  return textBodyBlock(details.body, details.headers, m);
}

export function requestHeadersBlock(details: RequestDetails, m: Messages = en): BlockModel {
  // No longer "including proxy-added fields": the proxy's forwarding headers
  // have not been stored since v0.11.0 (D144, D149).
  return pairsBlock(
    details.headers,
    HEADER_SEPARATOR,
    m.blocks.noHeaders,
    m.blocks.headersCaption,
    m,
  );
}

export function requestQueryBlock(details: RequestDetails, m: Messages = en): BlockModel {
  /*
   * The rows keep repeated names and their order, which is what the captured
   * query string means.
   *
   * They are also decoded: percent-escapes are resolved and `+` becomes a
   * space, so `?sig=abc%2Bdef` renders - and copies - as `sig=abc+def`. That
   * is the one named exception to "the tool shows what arrived", and it is
   * deliberate. Two columns of decoded names and values are what the design
   * draws for this tab, decoded values are what a reader is comparing against,
   * and nothing is lost: `Raw` carries the query string exactly as it was
   * received.
   *
   * The exception covers `Body` of a form too, which is the same data in the
   * same shape, decoded by the same function, drawn as the same rows and copied
   * with the same separator; `Raw` carries that body encoded (D162).
   *
   * Decoding is strict UTF-8, where `URLSearchParams` substituted U+FFFD. A
   * query string with an escape that is not UTF-8 is shown as stored, with a
   * reason line, rather than as rows that show something other than what
   * arrived.
   */
  const pairs = decodeFormUrlencoded(details.queryString);

  if (pairs === null) {
    return wrappedTextBlock(
      details.queryString,
      joinCaptions([m.blocks.queryCaption, m.blocks.queryNotUtf8]),
      m,
    );
  }

  return pairsBlock(pairs, QUERY_SEPARATOR, m.blocks.noQuery, m.blocks.queryCaption, m);
}

// --- Response side ----------------------------------------------------------

/**
 * The response the backend formed: its status line, its headers and its body.
 *
 * Not a wire capture, and the caption says so rather than leaving the reader to
 * assume otherwise (D049, the observation boundary).
 *
 * The branch for a representation that is not UTF-8 follows the API contract,
 * which allows one on this half too, and is drawn by the same rule as the
 * request's (D145). No response the backend records today reaches it: a
 * configured body is encoded from a string as UTF-8, and a configured header
 * value is visible ASCII.
 */
export function responseRawBlock(record: ResponseRecord, m: Messages = en): BlockModel {
  const caption = hasNoBody(record) ? m.blocks.responseHeadersOnly : m.blocks.responseRecorded;

  if (record.isRawBinary) {
    return binaryRawBlock(record.rawBase64 ?? '', caption, m.blocks.rawResponseBase64, m);
  }

  if (record.raw === null || record.raw === '') {
    return { content: { kind: 'empty', placeholder: m.blocks.noRawResponse }, caption: null };
  }

  return rawTextBlock(record.raw, caption, m);
}

export function responseBodyBlock(record: ResponseRecord, m: Messages = en): BlockModel {
  if (record.isBinary) {
    return binaryBodyBlock(record.bodyBase64 ?? '', record.headers, m);
  }

  if (record.body === null) {
    return {
      content: { kind: 'empty', placeholder: m.blocks.noResponseBody },
      caption:
        record.status !== null && STATUSES_WITHOUT_BODY.includes(record.status)
          ? m.blocks.statusWithoutBody(record.status)
          : m.blocks.customWithoutBody,
    };
  }

  // The record's own recorded headers, so a Body tab behaves the same on both
  // halves (D162).
  const block = textBodyBlock(record.body, record.headers, m);

  if (!record.bodySuppressed) {
    return block;
  }

  // A stored representation that never reached the wire is the one thing about
  // this block a reader cannot see from its contents (D064). It replaces the
  // formatting reason and keeps the wrapping line, which is about the same
  // block's rendering rather than about why it is not formatted - re-indented,
  // as rows or as stored, since every block wraps (D149, D162). Above parts it
  // comes first and the parts' own caption stays, since that says how many
  // there are and where the rest of the bytes went rather than why the body is
  // not formatted (D164).
  return {
    content: block.content,
    caption:
      block.content.kind === 'parts'
        ? joinCaptions([m.blocks.bodyNotSent, block.caption])
        : withWrapNotice(block.content, m.blocks.bodyNotSent, m),
  };
}

export function responseHeadersBlock(record: ResponseRecord, m: Messages = en): BlockModel {
  return pairsBlock(
    record.headers,
    HEADER_SEPARATOR,
    m.blocks.noResponseHeaders,
    m.blocks.responseHeadersCaption,
    m,
  );
}

// --- Shared -----------------------------------------------------------------

/**
 * A body that is text and not empty, drawn by the first of these steps that
 * applies, on both halves alike (D112, as amended by D162, D163 and D169; the
 * cap on a rendering's length is #64's amendment to D163 and D169):
 *
 * 1. **Above the ceiling nothing is inspected**, whatever the payload is: the
 *    stored text, and why.
 * 2. **Formats that describe themselves are sniffed from the text**, and a
 *    successful sniff wins whatever `Content-Type` says: senders lie, and the
 *    tool exists to show what arrived. Valid JSON is re-indented - or, where
 *    it is nested too deep to indent, or its rendering would pass
 *    `FORMATTED_MAX_CHARACTERS`, shown as stored with that reason (D169) -
 *    and well-formed XML is indented - or, where it has a DOCTYPE, is nested
 *    too deep to indent or its rendering would pass the same cap, shown as
 *    stored with that reason (D163). Either way it was recognised, so the
 *    label is not consulted.
 * 3. **Formats that cannot describe themselves are taken from the label.**
 *    Only here is `Content-Type` consulted, because `hello` is a valid
 *    one-pair form and a sniff would either fire on ordinary text or never
 *    fire at all. A body labelled as a form is decoded into rows, or shown as
 *    stored with the reason it was not. A body labelled `multipart/*` is
 *    split into its parts at the boundary the label declares, which the
 *    payload cannot supply (D164); where it cannot be, it goes on to step 4
 *    and the reason it was not split is added to that step's line.
 * 4. Anything else: the stored text, and a reason chosen by what the text
 *    looks like (`unformattedReason`).
 *
 * A sniffed format belongs after XML in step 2, a labelled one in step 3.
 *
 * The caption says what the renderer did, never what the sender claimed, so
 * there is no `Content-Type` caption above this block - the real header is in
 * `Headers` and in `Raw`, where it is a fact rather than a claim about the
 * rendering.
 */
function textBodyBlock(
  body: string,
  headers: readonly (readonly [string, string])[],
  m: Messages,
): BlockModel {
  if (exceedsFormatCeiling(body)) {
    return wrappedTextBlock(body, m.blocks.bodyTooLarge, m);
  }

  const json = formatJsonForDisplay(body);

  if (json.status === 'formatted') {
    return reindentedBlock(json.text, m);
  }

  if (json.status === 'too-deep') {
    return wrappedTextBlock(body, m.blocks.jsonTooDeep(JSON_MAX_DEPTH), m);
  }

  if (json.status === 'too-long') {
    return wrappedTextBlock(body, m.blocks.jsonTooLong(FORMATTED_MAX_CHARACTERS), m);
  }

  const xml = formatXmlForDisplay(body);

  if (xml.status === 'formatted') {
    return reindentedBlock(xml.text, m);
  }

  if (xml.status === 'doctype') {
    return wrappedTextBlock(body, m.blocks.xmlDoctype, m);
  }

  if (xml.status === 'too-deep') {
    return wrappedTextBlock(body, m.blocks.xmlTooDeep(XML_MAX_DEPTH), m);
  }

  if (xml.status === 'too-long') {
    return wrappedTextBlock(body, m.blocks.xmlTooLong(FORMATTED_MAX_CHARACTERS), m);
  }

  const contentType = firstContentType(headers);

  if (contentType !== null && mediaTypeOf(contentType) === FORM_URLENCODED) {
    return formBodyBlock(body, m);
  }

  // Its UTF-8 bytes, which are the stored bytes, with one exception: the
  // backend's decoder removed a byte-order mark at the very start (D043, D163),
  // so a body that began with one is split as if it began after it (D164).
  const multipart = multipartOutcome(
    contentType,
    () => binaryString(new TextEncoder().encode(body)),
    m,
  );

  if (multipart !== null && 'block' in multipart) {
    return multipart.block;
  }

  return wrappedTextBlock(
    body,
    joinCaptions([unformattedReason(body, m), multipart?.reason ?? null]),
    m,
  );
}

/**
 * A body that is not UTF-8: its Base64, as since D112 - or, where it is
 * labelled `multipart/*`, its parts, split from exactly the bytes `bodyBase64`
 * carries (D164). A file upload is almost never UTF-8, so this is where most
 * multipart bodies arrive. One that cannot be split keeps the Base64 block,
 * and the reason is added to its line.
 */
function binaryBodyBlock(
  bodyBase64: string,
  headers: readonly (readonly [string, string])[],
  m: Messages,
): BlockModel {
  const multipart = multipartOutcome(
    firstContentType(headers),
    () => {
      try {
        return atob(bodyBase64);
      } catch {
        // Not Base64 at all. The API never sends that, and the block still renders.
        return null;
      }
    },
    m,
  );

  if (multipart !== null && 'block' in multipart) {
    return multipart.block;
  }

  return wrappedTextBlock(
    bodyBase64,
    joinCaptions([m.blocks.binaryBody, multipart?.reason ?? null]),
    m,
  );
}

/**
 * What a body labelled `multipart/*` is drawn as (D164): its parts, or the
 * reason it was not split. `null` where the label is not `multipart/*` at all,
 * or the bytes cannot be read, and the body is drawn as it always was.
 *
 * `bytes` is the body as a binary string, asked for only once the label has a
 * boundary.
 *
 * **The ceiling.** Splitting is one pass over at most the 1 MiB body limit,
 * and the parts view never draws the content of a part that is not UTF-8, so
 * a file upload of any size is split. What is drawn is bounded as every other
 * Body rendering is, by the 256 KiB ceiling (`JSON_FORMAT_MAX_BYTES`): the
 * body's bytes less the content of its parts that are not UTF-8 - headers,
 * text and the delimiters that make each box - may not exceed it. For a text
 * body every part is UTF-8, so that is the whole body, and a text body above
 * the ceiling never gets here: it keeps its ceiling line (step 1). A binary
 * body over it keeps its Base64 with `blocks.multipartTooLarge`. Without that
 * bound, 1 MiB of empty parts would be over a hundred thousand boxes.
 */
function multipartOutcome(
  contentType: string | null,
  bytes: () => string | null,
  m: Messages,
): { block: BlockModel } | { reason: string } | null {
  const label = multipartLabel(contentType);

  if (label.kind === 'not-multipart') {
    return null;
  }

  if (label.kind === 'no-boundary') {
    return { reason: m.blocks.multipartNoBoundary };
  }

  const body = bytes();

  if (body === null) {
    return null;
  }

  const split = splitMultipart(body, label.boundary);

  if (split.status === 'no-delimiter') {
    return { reason: m.blocks.multipartNoDelimiter };
  }

  if (split.status === 'no-close') {
    return { reason: m.blocks.multipartNoClose };
  }

  const undrawn = split.parts.reduce((sum, part) => sum + (part.text === null ? part.size : 0), 0);

  if (body.length - undrawn > JSON_FORMAT_MAX_BYTES) {
    return { reason: m.blocks.multipartTooLarge };
  }

  const content: BlockContent = {
    kind: 'parts',
    parts: split.parts.map((part, index) => bodyPart(part, index, m)),
  };
  const outside =
    split.preambleBytes > 0 && split.epilogueBytes > 0
      ? m.blocks.multipartBoth
      : split.preambleBytes > 0
        ? m.blocks.multipartPreamble
        : split.epilogueBytes > 0
          ? m.blocks.multipartEpilogue
          : null;

  return {
    block: {
      content,
      caption: withWrapNotice(
        content,
        joinCaptions([m.blocks.multipartSplit(split.parts.length), outside]),
        m,
      ),
    },
  };
}

/** One part as its box draws it. */
function bodyPart(part: MultipartPart, index: number, m: Messages): BodyPart {
  let content: BodyPart['content'];

  if (part.text === null) {
    content = { kind: 'note', note: m.blocks.partBinaryNote };
  } else if (part.text === '') {
    content = { kind: 'note', note: m.blocks.partEmpty };
  } else {
    content = { kind: 'text', text: part.text };
  }

  return {
    title: m.blocks.partTitle(index + 1),
    name: part.name === '' ? null : part.name,
    summary: partSummary(part, m),
    headers: part.headers,
    content,
  };
}

/**
 * The right-hand side of a part's header line (D164): its file name where it
 * has one, then what it is, then the size of its content in the application's
 * one size format (`formatBytesCompact`).
 *
 * What it is: the media type its own `Content-Type` declares, as written and
 * without parameters, wherever it declares one - so a file reads
 * `invoice.pdf · application/pdf · 47.1 KB` and a nested `multipart/mixed`
 * says so - and otherwise `text` or `binary`, by whether its content is UTF-8:
 * a form field reads `text · 16 B`.
 */
function partSummary(part: MultipartPart, m: Messages): string {
  const kind = part.contentType ?? (part.text === null ? m.blocks.partBinary : m.blocks.partText);

  return [part.filename, kind, formatBytesCompact(part.size)]
    .filter((segment) => segment !== null)
    .join(' · ');
}

/**
 * Re-indented JSON or indented XML. Here a run of horizontal space is the
 * indentation that was computed for it, so a folded line continues two columns
 * deeper than its own line rather than at the edge, where it would read as a
 * member or a child of something further out (D149, D163). It has no caption
 * of its own, and says only where a line wraps.
 */
function reindentedBlock(text: string, m: Messages): TextBlockModel {
  const content = { kind: 'text', text, wrap: 'hanging' } as const;

  return { content, caption: withWrapNotice(content, null, m) };
}

/**
 * Why a body that no step recognised is shown as stored, chosen by its first
 * character after a byte-order mark and white space (D163): `{` or `[` claims
 * to be JSON, `<` claims to be XML, and anything else claims nothing - `hello`
 * is not invalid JSON, it is plain text.
 */
function unformattedReason(body: string, m: Messages): string {
  let index = body.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (index < body.length && ' \t\r\n'.includes(body[index] as string)) {
    index += 1;
  }

  const first = body[index];

  if (first === '{' || first === '[') {
    return m.blocks.notJson;
  }

  return first === '<' ? m.blocks.notXml : m.blocks.notRecognised;
}

/**
 * A body labelled as a form, as `Query` draws a query string: decoded rows
 * with no caption of their own, copied one `name=value` per line (D162).
 *
 * The rows are drawn only where the whole body decodes as UTF-8 and yields at
 * least one pair. Otherwise the block shows the stored text with the reason,
 * as invalid JSON does: `&&&` is not drawn as an empty grid, and an escape
 * that is not UTF-8 is not drawn as U+FFFD.
 */
function formBodyBlock(body: string, m: Messages): BlockModel {
  const pairs = decodeFormUrlencoded(body);

  if (pairs === null) {
    return wrappedTextBlock(body, m.blocks.formNotUtf8, m);
  }

  if (pairs.length === 0) {
    return wrappedTextBlock(body, m.blocks.formNoPairs, m);
  }

  return rowsBlock(pairs, QUERY_SEPARATOR, null, m);
}

/**
 * The value of a message's first `Content-Type` header, its name matched in
 * any case, or `null` where there is none (D162).
 */
function firstContentType(headers: readonly (readonly [string, string])[]): string | null {
  return headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? null;
}

/**
 * A `Content-Type` value's media type, without parameters, trimmed and
 * lower-cased, so `Application/X-WWW-Form-Urlencoded; charset=UTF-8` is a form.
 */
function mediaTypeOf(contentType: string): string {
  return (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
}

/**
 * A run of text with no structure worth preserving across a line: a stored
 * representation, a body that could not be re-indented or decoded, a query
 * string that could not be decoded, a Base64 rendering.
 *
 * Everything the inspector shows as text but indented JSON or XML comes
 * through here, which is what makes the rule one line of code rather than a
 * property seven functions have to remember (D134).
 */
function wrappedTextBlock(text: string, caption: string | null, m: Messages): TextBlockModel {
  const content = { kind: 'text', text, wrap: 'flush' } as const;

  return { content, caption: withWrapNotice(content, caption, m) };
}

/**
 * A stored representation as `Raw` shows it: wrapped like every other run of
 * text, and drawn without its closing CRLF CRLF where nothing follows the head
 * (`textOnScreen`, D158). The caption is decided on the stored text, which the
 * trimmed line ending cannot change.
 */
function rawTextBlock(text: string, caption: string | null, m: Messages): TextBlockModel {
  const block = wrappedTextBlock(text, caption, m);
  const head = headWithoutBody(text);

  return head === null ? block : { ...block, content: { ...block.content, display: head } };
}

/**
 * The head of a representation that has no body, without the CRLF CRLF that
 * ends it, or `null` where anything follows the head.
 *
 * Neither a request line, a status line nor a header value can hold CRLF, so
 * the first CRLF CRLF is where the head ends, in both composers (D049, D109);
 * a body that happens to end with one of its own is still a body. Read off the
 * text, not off a size or a flag, so the rule is the same for a request, a
 * response and a head read one character per byte (D145).
 */
function headWithoutBody(text: string): string | null {
  const end = text.indexOf(HEAD_END);

  return end > 0 && end + HEAD_END.length === text.length ? text.slice(0, end) : null;
}

/**
 * Adds `blocks.wrapped` to a caption where the block wraps a line in fact: a
 * line of text, or a row of a name/value grid.
 */
function withWrapNotice(content: BlockContent, caption: string | null, m: Messages): string | null {
  return wrapsALine(content) ? joinCaptions([caption, m.blocks.wrapped]) : caption;
}

function wrapsALine(content: BlockContent): boolean {
  switch (content.kind) {
    case 'text':
      return hasOverlongLine(content.text);

    case 'pairs':
      return pairsWrap(content.pairs);

    // A part's headers are the same grid, and its content the same run of text.
    case 'parts':
      return content.parts.some(
        (part) =>
          pairsWrap(part.headers) ||
          (part.content.kind === 'text' && hasOverlongLine(part.content.text)),
      );

    case 'empty':
      return false;
  }
}

/**
 * `Raw` for a stored representation that is not valid UTF-8 (D145).
 *
 * The bytes are split after the first blank line. Both composers end the head
 * with it, and neither a request line nor a header value can contain CRLF, so
 * the first one is the boundary. The head is shown as text: as UTF-8 where it
 * is valid UTF-8, which is how a representation that is text is shown, and
 * otherwise one character per byte, which is how the backend wrote those bytes
 * and how Node decoded them for `Headers`. The body part is shown as text
 * where it is valid UTF-8, and otherwise as the Base64 of exactly its bytes -
 * the same string as `bodyBase64` on the same half of the panel.
 *
 * CR and LF are ASCII, so the split never cuts a UTF-8 sequence in two, and a
 * representation that is not UTF-8 as a whole therefore has a head or a body
 * part that is not UTF-8 either. At least one of the two added lines is always
 * said.
 *
 * `caption` is what the block says about a representation that is text, and it
 * stays. Bytes with no blank line to split at fall back to the whole
 * representation as Base64 under `wholeCaption`, as before the split existed.
 * Nothing is re-indented, and what is displayed is what is copied (D112, D122),
 * but for the closing blank line of a head with no body after it (D158).
 */
function binaryRawBlock(
  rawBase64: string,
  caption: string | null,
  wholeCaption: string,
  m: Messages,
): TextBlockModel {
  const split = splitAfterHead(rawBase64);

  if (split === null) {
    return wrappedTextBlock(rawBase64, wholeCaption, m);
  }

  const head = decodeUtf8(split.head);
  const body = decodeUtf8(split.body);

  // A head with nothing after it is drawn as a text head is (D158).
  return rawTextBlock(
    (head ?? split.head) + (body ?? btoa(split.body)),
    joinCaptions([
      caption,
      head === null ? m.blocks.rawHeadLatin1 : null,
      body === null ? m.blocks.rawBodyBase64 : null,
    ]),
    m,
  );
}

/**
 * The stored bytes as binary strings - one character per byte, U+0000 to
 * U+00FF - cut after the first blank line, or `null` where there is none.
 *
 * A binary string is what `atob` returns, and it already is the head read one
 * character per byte: ISO-8859-1 exactly. `new TextDecoder('latin1')` is not
 * that. The Encoding standard maps `latin1` and `iso-8859-1` to windows-1252,
 * which draws 0x80-0x9F as other characters than the ones Node puts in
 * `Headers` (`\x85` becomes an ellipsis), in browsers and in Node alike.
 */
function splitAfterHead(rawBase64: string): { head: string; body: string } | null {
  let bytes: string;

  try {
    bytes = atob(rawBase64);
  } catch {
    // Not Base64 at all. The API never sends that, and the block still renders.
    return null;
  }

  const end = bytes.indexOf(HEAD_END);

  if (end === -1) {
    return null;
  }

  const bodyStart = end + HEAD_END.length;

  return { head: bytes.slice(0, bodyStart), body: bytes.slice(bodyStart) };
}

/** Caption sentences in order, the ones that do not apply left out. */
function joinCaptions(sentences: readonly (string | null)[]): string | null {
  const said = sentences.filter((sentence) => sentence !== null);

  return said.length === 0 ? null : said.join(' ');
}

/**
 * Name/value rows, or `placeholder` where there are none.
 *
 * The block keeps its own caption, and is followed by the wrapping line where
 * a row wraps: `Headers`, `Query` and the response's `Headers` alike (D149).
 */
function pairsBlock(
  pairs: readonly (readonly [string, string])[],
  separator: string,
  placeholder: string,
  caption: string,
  m: Messages,
): BlockModel {
  if (pairs.length === 0) {
    return { content: { kind: 'empty', placeholder }, caption };
  }

  return rowsBlock(pairs, separator, caption, m);
}

/**
 * At least one name/value row: `pairsBlock`'s, and `Body` of a form, which has
 * no caption of its own and so says only where a row wraps (D162).
 */
function rowsBlock(
  pairs: readonly (readonly [string, string])[],
  separator: string,
  caption: string | null,
  m: Messages,
): BlockModel {
  const content: BlockContent = { kind: 'pairs', pairs, separator };

  return { content, caption: withWrapNotice(content, caption, m) };
}

/**
 * Whether any row of a name/value grid wraps.
 *
 * The rows share their columns: the name column is as wide as the widest name,
 * up to `NAME_COLUMN_SHARE` of the box, and the value column is what is left
 * after the gap. So a short name beside a long one gets the narrower value
 * column too, which a measure of `name: value` alone would miss. A name longer
 * than its column wraps in it, and counts as a wrapped row.
 */
function pairsWrap(pairs: readonly (readonly [string, string])[]): boolean {
  const nameLimit = Math.floor(MAX_FITTING_COLUMNS * NAME_COLUMN_SHARE);
  let nameColumn = 0;

  for (const [name] of pairs) {
    const columns = columnsUpTo(name, nameLimit);

    if (columns > nameLimit) {
      return true;
    }

    nameColumn = Math.max(nameColumn, columns);
  }

  const valueLimit = MAX_FITTING_COLUMNS - nameColumn - PAIR_GAP_COLUMNS;

  return pairs.some(([, value]) => hasOverlongLine(value, valueLimit));
}

function hasOverlongLine(text: string, limit = MAX_FITTING_COLUMNS): boolean {
  return text.split('\n').some((line) => columnsUpTo(line, limit) > limit);
}

/**
 * Characters the code face draws about twice as wide as a Latin one: the CJK
 * and Hangul blocks, the fullwidth forms, the pictographic planes, and the
 * symbols and dingbats at U+2600-U+27BF - where the status marks that turn up
 * in captured payloads live, and most code faces draw them two columns wide.
 *
 * The list is an estimate rather than the East Asian Width table - JavaScript's
 * regular expressions cannot query that property - and it only has to be right
 * enough to decide a caption.
 */
const WIDE_CHARACTER =
  /[\u1100-\u115F\u2600-\u27BF\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/**
 * The most columns a tab is drawn across: the distance to the next tab stop,
 * which is at most CSS's default `tab-size` of 8. Stored XML and header values
 * can hold tabs, and counting one as a single column judged a line of tabs to
 * fit where it wraps (D163).
 */
const TAB_COLUMNS = 8;

/**
 * How wide a line is drawn, in columns, counted no further than `limit`.
 *
 * Not `line.length`: that counts UTF-16 code units, which is wrong in both
 * directions for captured payloads. An emoji is two units and draws as one wide
 * glyph, and a CJK ideograph is one unit and draws two columns wide - so a line
 * of Chinese is about twice as wide as its length suggests, and the caption
 * saying the block scrolls was dropped exactly where it was most needed.
 *
 * Counting stops one column past `limit`, because every caller only asks
 * whether the line fits. A `Raw` block can hold a megabyte on a single line,
 * and this is measured on every selected request: without the bound the
 * question would cost a regular-expression test per character of the body.
 */
function columnsUpTo(line: string, limit: number): number {
  let columns = 0;

  // Iterating a string yields code points, so an astral character is one step.
  for (const character of line) {
    if (character === '\t') {
      columns += TAB_COLUMNS;
    } else {
      columns += WIDE_CHARACTER.test(character) ? 2 : 1;
    }

    if (columns > limit) {
      return columns;
    }
  }

  return columns;
}

/** A recorded response that carried no body at all, as `204` and `HEAD` do. */
function hasNoBody(record: ResponseRecord): boolean {
  return record.body === null && record.bodySize === 0;
}
