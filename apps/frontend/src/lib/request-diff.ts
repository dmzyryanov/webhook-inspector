/**
 * What `Compare with…` shows (issue #75, D186): the line model of each request
 * view for two captured requests, the open one first.
 *
 * **What is compared is what the views display**, so what the user reads is
 * what is compared, and nothing stored changes (D007):
 *
 * - `Raw`: the stored text as the `Raw` view draws it (`textOnScreen`);
 * - `Body`: the text `requestBodyBlock` draws - JSON re-indented (D112), XML
 *   indented (D163), a form as `name=value` rows (D162);
 * - `Headers` and `Query`: one line per pair, as the views copy them -
 *   `Name: value` and `name=value` - with their order and duplicates kept
 *   (D045).
 *
 * **The open request is always `−` and the chosen one `+`**, whatever their
 * times (decided on 2026-09-30): `compareRequests(open, chosen)`.
 *
 * The line diff is jsdiff's (`diffArrays`), never a hand-written one, run with
 * an edit limit (`MAX_EDIT_LENGTH`): two unrelated bodies give up quickly
 * instead of freezing the tab, and the view says so with both sizes.
 *
 * Pure: no DOM, no React. `CompareView.tsx` renders this model.
 *
 * The frames cited below, A2, A3 and A6, are frames of the Figma page
 * `Webhook Inspector · Compare requests`, which draws the comparison.
 */
import { diffArrays } from 'diff';
import type { RequestDetails } from '@webhook-inspector/shared';
import {
  requestBodyBlock,
  requestHeadersBlock,
  requestQueryBlock,
  requestRawBlock,
  textOnScreen,
  type BlockContent,
} from './detail-view.ts';
import { en, type Messages } from '../i18n/en.ts';
import { exceedsFormatCeiling } from './json-format.ts';

/** The request views a comparison has, in the strip's order. */
export const COMPARE_VIEWS = ['raw', 'body', 'headers', 'query'] as const;

export type CompareViewName = (typeof COMPARE_VIEWS)[number];

/** The views' names as the strip writes them: English in every language (D222). */
export const COMPARE_VIEW_LABELS: Record<CompareViewName, string> = {
  raw: 'Raw',
  body: 'Body',
  headers: 'Headers',
  query: 'Query',
};

/**
 * The most lines jsdiff may remove and add, together, before it gives up on a
 * view. Two unrelated 250 KiB JSON bodies, some 29 000 lines each once
 * re-indented, reach it in about 60 ms in Node 24; 2 000 took four times that,
 * and 4 000 nearly a second. A real retry or fix changes far fewer lines.
 */
export const MAX_EDIT_LENGTH = 1000;

/**
 * The same limit inside one changed line, counted in tokens, and the longest
 * line whose characters are compared at all. A line past either is still
 * marked removed or added; only the underline inside it is left out.
 */
export const MAX_INLINE_EDIT_LENGTH = 200;
export const MAX_INLINE_LINE_LENGTH = 10_000;

/** Unchanged lines kept next to each change (Figma notes, `554:107`). */
export const CONTEXT_LINES = 3;

/**
 * An unchanged run folds only where more than this many lines would be hidden
 * beyond its context: folding one, two or three lines would replace them with
 * a row as tall as they are (Figma frame A2 keeps the four closing lines after
 * its change, and folds five before it).
 */
export const MIN_FOLDED_LINES = 4;

/** A run of characters in one line, `[start, end)`, underlined as changed. */
export interface InlineRange {
  start: number;
  end: number;
}

/** One line of a comparison as the box draws it. */
export type DiffLine =
  | { kind: 'same'; text: string }
  | { kind: 'removed'; text: string; marks: readonly InlineRange[] }
  | { kind: 'added'; text: string; marks: readonly InlineRange[] };

/** A row of the box: a line, or unchanged lines folded under `N unchanged lines · Show`. */
export type DiffRow = DiffLine | { kind: 'fold'; lines: readonly string[] };

/** Why a view is compared only as a whole (D2, D3). */
export type WholeReason = 'binary' | 'multipart' | 'too-large' | 'not-utf8';

/** One view of a comparison. */
export type ViewComparison =
  /** Line by line: `rows` hold the changes, their context and the folds. */
  | { kind: 'lines'; differs: boolean; rows: readonly DiffRow[] }
  /** Only as a whole, with both sizes in bytes (open first). */
  | {
      kind: 'whole';
      differs: boolean;
      reason: WholeReason;
      sizes: readonly [number, number];
    }
  /** The edit limit was reached: too many changes to show line by line. */
  | { kind: 'too-many-changes'; differs: true; sizes: readonly [number, number] };

export type RequestComparison = Record<CompareViewName, ViewComparison>;

/** Compares every view of two requests, the open one (`−`) first. */
export function compareRequests(open: RequestDetails, chosen: RequestDetails): RequestComparison {
  return {
    raw: compareRaw(open, chosen),
    body: compareBody(open, chosen),
    headers: compareText(
      viewLines(requestHeadersBlock(open).content),
      viewLines(requestHeadersBlock(chosen).content),
    ),
    query: compareText(
      viewLines(requestQueryBlock(open).content),
      viewLines(requestQueryBlock(chosen).content),
    ),
  };
}

/** Whether no view differs: D1's `The two requests are identical in every view.` */
export function isIdentical(comparison: RequestComparison): boolean {
  return COMPARE_VIEWS.every((view) => !comparison[view].differs);
}

/**
 * The view a comparison opens on: `Body` when the bodies differ, else the
 * first view that differs in the order `Raw`, `Headers`, `Query`, else `Body`.
 */
export function openingView(comparison: RequestComparison): CompareViewName {
  if (comparison.body.differs) {
    return 'body';
  }

  return (['raw', 'headers', 'query'] as const).find((view) => comparison[view].differs) ?? 'body';
}

/** Above the box of a view with no differences while others differ. */
export function noDifferencesLine(view: CompareViewName, m: Messages = en): string {
  return m.compare.noDifferences(COMPARE_VIEW_LABELS[view]);
}

/** The two lines in English; the view draws the dictionary's `compare`. */
export const IDENTICAL_LINE = en.compare.identical;
export const TOO_MANY_CHANGES_LINE = en.compare.tooManyChanges;

/**
 * The first line of a view compared as a whole (D2, D3): `The bodies differ.`,
 * or that they are identical with their one size.
 */
export function wholeHeadline(
  view: CompareViewName,
  comparison: Extract<ViewComparison, { kind: 'whole' }>,
  formatSize: (bytes: number) => string,
  m: Messages = en,
): string {
  if (comparison.differs) {
    return m.compare.wholeDiffer(view === 'raw');
  }

  return m.compare.wholeSame(
    view === 'raw',
    comparison.reason === 'binary',
    formatSize(comparison.sizes[0]),
  );
}

/** The muted line under it, saying why the view is compared as a whole. */
export function wholeNote(reason: WholeReason, m: Messages = en): string {
  return reason === 'too-large' ? m.compare.wholeTooLarge : m.compare.wholeOther;
}

// --- The views --------------------------------------------------------------

function compareRaw(open: RequestDetails, chosen: RequestDetails): ViewComparison {
  const whole = rawWhole(open) ?? rawWhole(chosen);

  if (whole !== null) {
    return {
      kind: 'whole',
      reason: whole,
      differs: rawIdentity(open) !== rawIdentity(chosen),
      sizes: [rawSize(open), rawSize(chosen)],
    };
  }

  const a = viewLines(requestRawBlock(open).content);
  const b = viewLines(requestRawBlock(chosen).content);

  return compareText(a, b, [rawSize(open), rawSize(chosen)]);
}

/** Why a request's `Raw` is compared as a whole, or `null` where it is not. */
function rawWhole(details: RequestDetails): WholeReason | null {
  if (details.isRawBinary) {
    return 'not-utf8';
  }

  return details.raw !== null && exceedsFormatCeiling(details.raw) ? 'too-large' : null;
}

function rawIdentity(details: RequestDetails): string {
  return details.isRawBinary ? `b:${details.rawBase64 ?? ''}` : `t:${details.raw ?? ''}`;
}

function rawSize(details: RequestDetails): number {
  return details.isRawBinary ? base64Size(details.rawBase64 ?? '') : utf8Size(details.raw ?? '');
}

function compareBody(open: RequestDetails, chosen: RequestDetails): ViewComparison {
  const openBlock = requestBodyBlock(open).content;
  const chosenBlock = requestBodyBlock(chosen).content;
  const whole = bodyWhole(open, openBlock) ?? bodyWhole(chosen, chosenBlock);
  const sizes = [open.bodySize, chosen.bodySize] as const;

  if (whole !== null) {
    return {
      kind: 'whole',
      reason: whole,
      differs: bodyIdentity(open) !== bodyIdentity(chosen),
      sizes,
    };
  }

  return compareText(viewLines(openBlock), viewLines(chosenBlock), sizes);
}

/** Why a request's `Body` is compared as a whole, or `null` where it is not. */
function bodyWhole(details: RequestDetails, block: BlockContent): WholeReason | null {
  if (block.kind === 'parts') {
    return 'multipart';
  }

  if (details.isBinary) {
    return 'binary';
  }

  return details.body !== null && exceedsFormatCeiling(details.body) ? 'too-large' : null;
}

function bodyIdentity(details: RequestDetails): string {
  return details.isBinary ? `b:${details.bodyBase64 ?? ''}` : `t:${details.body ?? ''}`;
}

/**
 * The lines a view draws: a text block's lines, a pair per line, and none for
 * a placeholder. A carriage return ending a line is not drawn, so it is not
 * compared either.
 */
export function viewLines(content: BlockContent): string[] {
  switch (content.kind) {
    case 'text':
      return textOnScreen(content)
        .split('\n')
        .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

    case 'pairs':
      return content.pairs.map(([name, value]) => `${name}${content.separator}${value}`);

    case 'parts':
    case 'empty':
      return [];
  }
}

// --- The line diff ----------------------------------------------------------

/**
 * Two views' lines compared by jsdiff under `MAX_EDIT_LENGTH`. `sizes` are
 * shown if the limit is reached; by default, the lines' own UTF-8 sizes.
 */
export function compareText(
  a: readonly string[],
  b: readonly string[],
  sizes: readonly [number, number] = [utf8Size(a.join('\n')), utf8Size(b.join('\n'))],
): ViewComparison {
  const changes = diffArrays([...a], [...b], { maxEditLength: MAX_EDIT_LENGTH });

  if (changes === undefined) {
    return { kind: 'too-many-changes', differs: true, sizes };
  }

  const lines: DiffLine[] = [];
  let removed: string[] = [];
  let added: string[] = [];

  const flush = (): void => {
    lines.push(...changedLines(removed, added));
    removed = [];
    added = [];
  };

  for (const change of changes) {
    if (change.removed) {
      removed.push(...change.value);
    } else if (change.added) {
      added.push(...change.value);
    } else {
      flush();
      lines.push(...change.value.map((text) => ({ kind: 'same', text }) as const));
    }
  }

  flush();

  const differs = lines.some((line) => line.kind !== 'same');

  return { kind: 'lines', differs, rows: foldLines(lines) };
}

/**
 * One change: the lines removed and the lines added in its place. The i-th
 * removed line is paired with the i-th added one, and inside each pair the
 * changed characters are underlined. As many removed as added are drawn in
 * pairs, `−` over its `+` (Figma frame A6); otherwise every `−` comes before
 * every `+` (Figma frame A2).
 */
function changedLines(removed: readonly string[], added: readonly string[]): DiffLine[] {
  const pairs = Math.min(removed.length, added.length);
  const removedLines: DiffLine[] = removed.map((text) => ({ kind: 'removed', text, marks: [] }));
  const addedLines: DiffLine[] = added.map((text) => ({ kind: 'added', text, marks: [] }));

  for (let index = 0; index < pairs; index += 1) {
    const [before, after] = inlineRanges(removed[index] as string, added[index] as string);

    removedLines[index] = { kind: 'removed', text: removed[index] as string, marks: before };
    addedLines[index] = { kind: 'added', text: added[index] as string, marks: after };
  }

  if (removed.length === added.length) {
    return removedLines.flatMap((line, index) => [line, addedLines[index] as DiffLine]);
  }

  return [...removedLines, ...addedLines];
}

/**
 * The unchanged runs folded: `CONTEXT_LINES` are kept next to each change, and
 * the rest of a run folds when it is `MIN_FOLDED_LINES` or more. A view with
 * no change at all folds whole, whatever its length (D1).
 */
export function foldLines(lines: readonly DiffLine[]): DiffRow[] {
  if (lines.every((line) => line.kind === 'same')) {
    return lines.length === 0 ? [] : [{ kind: 'fold', lines: lines.map((line) => line.text) }];
  }

  const rows: DiffRow[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] as DiffLine;

    if (line.kind !== 'same') {
      rows.push(line);
      index += 1;
      continue;
    }

    let end = index;

    while (end < lines.length && (lines[end] as DiffLine).kind === 'same') {
      end += 1;
    }

    const run = lines.slice(index, end);
    const keepBefore = index === 0 ? 0 : CONTEXT_LINES;
    const keepAfter = end === lines.length ? 0 : CONTEXT_LINES;
    const hidden = run.length - keepBefore - keepAfter;

    if (hidden >= MIN_FOLDED_LINES) {
      rows.push(...run.slice(0, keepBefore));
      rows.push({
        kind: 'fold',
        lines: run.slice(keepBefore, run.length - keepAfter).map((same) => same.text),
      });
      rows.push(...run.slice(run.length - keepAfter));
    } else {
      rows.push(...run);
    }

    index = end;
  }

  return rows;
}

// --- Inside a changed line --------------------------------------------------

/**
 * A line as tokens: a run of letters and digits, a run of white space, or any
 * other single character. Words rather than characters, so `4200` against
 * `"42.00"` underlines both values whole rather than the odd `.` (Figma
 * frame A2).
 */
export function lineTokens(line: string): string[] {
  return line.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

/**
 * The changed characters of a pair of lines, removed line first. Tokens are
 * compared by jsdiff; where one word replaced one word, only their differing
 * middle is underlined, so `1790412115` against `1790412001` marks `115` and
 * `001` (Figma frame A6). Past the inline limits nothing is underlined.
 */
export function inlineRanges(
  before: string,
  after: string,
): [readonly InlineRange[], readonly InlineRange[]] {
  if (before.length > MAX_INLINE_LINE_LENGTH || after.length > MAX_INLINE_LINE_LENGTH) {
    return [[], []];
  }

  const changes = diffArrays(lineTokens(before), lineTokens(after), {
    maxEditLength: MAX_INLINE_EDIT_LENGTH,
  });

  if (changes === undefined) {
    return [[], []];
  }

  const removed: InlineRange[] = [];
  const added: InlineRange[] = [];
  let positionBefore = 0;
  let positionAfter = 0;
  let index = 0;

  while (index < changes.length) {
    const change = changes[index] as (typeof changes)[number];

    if (!change.added && !change.removed) {
      const length = change.value.join('').length;

      positionBefore += length;
      positionAfter += length;
      index += 1;
      continue;
    }

    // A change is the removed and added tokens next to each other, in either order.
    let gone: string[] = [];
    let come: string[] = [];

    while (
      index < changes.length &&
      ((changes[index]?.added ?? false) || (changes[index]?.removed ?? false))
    ) {
      const part = changes[index] as (typeof changes)[number];

      if (part.removed) {
        gone = gone.concat(part.value);
      } else {
        come = come.concat(part.value);
      }

      index += 1;
    }

    const goneText = gone.join('');
    const comeText = come.join('');
    let trimStart = 0;
    let trimEnd = 0;

    if (gone.length === 1 && come.length === 1 && isWord(goneText) && isWord(comeText)) {
      trimStart = commonPrefix(goneText, comeText);
      trimEnd = commonSuffix(goneText.slice(trimStart), comeText.slice(trimStart));
    }

    pushRange(removed, positionBefore + trimStart, positionBefore + goneText.length - trimEnd);
    pushRange(added, positionAfter + trimStart, positionAfter + comeText.length - trimEnd);
    positionBefore += goneText.length;
    positionAfter += comeText.length;
  }

  return [joinAcrossPunctuation(before, removed), joinAcrossPunctuation(after, added)];
}

/**
 * Two changed runs with only one or two punctuation characters between them
 * are underlined as one: `4200,"currency":"eur",` reads as the one change it
 * is, not as five fragments around unchanged quotes (Figma frame A3).
 */
function joinAcrossPunctuation(text: string, ranges: readonly InlineRange[]): InlineRange[] {
  const joined: InlineRange[] = [];

  for (const range of ranges) {
    const last = joined[joined.length - 1];

    if (last !== undefined && /^[^\p{L}\p{N}_\s]{1,2}$/u.test(text.slice(last.end, range.start))) {
      last.end = range.end;
    } else {
      joined.push({ ...range });
    }
  }

  return joined;
}

function isWord(token: string): boolean {
  return /^[\p{L}\p{N}_]+$/u.test(token);
}

function commonPrefix(a: string, b: string): number {
  let length = 0;

  while (length < a.length && length < b.length && a[length] === b[length]) {
    length += 1;
  }

  return length;
}

function commonSuffix(a: string, b: string): number {
  let length = 0;

  while (
    length < a.length &&
    length < b.length &&
    a[a.length - 1 - length] === b[b.length - 1 - length]
  ) {
    length += 1;
  }

  return length;
}

/** Adds `[start, end)`, joined to the previous range where they touch; nothing when empty. */
function pushRange(ranges: InlineRange[], start: number, end: number): void {
  if (end <= start) {
    return;
  }

  const last = ranges[ranges.length - 1];

  if (last !== undefined && last.end === start) {
    last.end = end;

    return;
  }

  ranges.push({ start, end });
}

/** A line cut into its plain and underlined pieces, for drawing. */
export function splitByInlineRanges(
  text: string,
  ranges: readonly InlineRange[],
): { text: string; changed: boolean }[] {
  const pieces: { text: string; changed: boolean }[] = [];
  let position = 0;

  for (const range of ranges) {
    if (range.start > position) {
      pieces.push({ text: text.slice(position, range.start), changed: false });
    }

    pieces.push({ text: text.slice(range.start, range.end), changed: true });
    position = range.end;
  }

  if (position < text.length || pieces.length === 0) {
    pieces.push({ text: text.slice(position), changed: false });
  }

  return pieces;
}

// --- Sizes ------------------------------------------------------------------

function utf8Size(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The bytes a Base64 text decodes to, counted without decoding it. */
function base64Size(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;

  return Math.floor((base64.length * 3) / 4) - padding;
}
