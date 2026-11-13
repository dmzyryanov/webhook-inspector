import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import {
  blockCopyText,
  hangingIndentStyle,
  hangingRuns,
  textOnScreen,
  type BlockModel,
} from '../lib/detail-view.ts';
import { BodyParts } from './BodyParts.tsx';
import { CopyCodeButton } from './CopyCodeButton.tsx';
import { PairsGrid } from './PairsGrid.tsx';

interface CodeBlockProps {
  /** What to show and what to say above it, decided in `lib/detail-view.ts`. */
  block: BlockModel;
  /** The accessible name of the copy control: `Copy raw request`. */
  copyLabel: string;
}

/**
 * One code block: its caption, then a box that hugs its content (D149).
 *
 * **The box never scrolls.** It has no height limit and no overflow of its own:
 * it is as wide as the tab area and exactly as tall as its lines, and every line
 * in it wraps, so the tab area around it is the one scroll in the panel and
 * that scroll is vertical only. A short block ends under its last row.
 *
 * **The caption is above the box**, so it is read before the content rather
 * than after the last line of a long body.
 *
 * Monospace at 12/20, which is the binding half of the design's code type. The
 * `IBM Plex Mono` in the file is a mockup artefact and no web font is added for
 * it (D071).
 *
 * Memoised: the page re-renders on every realtime event, and a large body is
 * costly to draw again for nothing. The block model is memoised by the panel,
 * so an unchanged block is not drawn again.
 */
export const CodeBlock = memo(function CodeBlock({ block, copyLabel }: CodeBlockProps) {
  const { content, caption } = block;

  return (
    <div className="flex flex-col gap-3">
      {caption === null ? null : (
        <p className="text-[12px] leading-[17px] text-ink-muted">{caption}</p>
      )}

      {content.kind === 'parts' ? (
        /* A multipart body is a box per part rather than one box, and has no
           copy control of its own: each part with content shown carries one
           (D164). */
        <BodyParts parts={content.parts} copyLabel={copyLabel} />
      ) : (
        <div className="flex rounded-lg border border-line-panel bg-code">
          {/* Named for the browser suite, which measures this element: that it
              neither scrolls nor overflows is a question only a laid-out box can
              answer (D134, D149). `pr-3` and the control's column below add up
              to the design's 48 px on the right. */}
          {/* On a phone the box is 12 px in, and a list of pairs 4 px, each
              pair adding 8 px of its own (frames 3A and 3C of the Figma page
              `Webhook Inspector · Tablet and phone`). */}
          <div
            data-testid="block-content"
            className={cn(
              'min-w-0 flex-1 py-[14px] pl-4 pr-3 font-mono text-[12px] leading-[20px]',
              'max-md:pl-3 max-md:pr-[7px]',
              content.kind === 'pairs' ? 'max-md:py-1' : 'max-md:py-3',
            )}
          >
            {content.kind === 'pairs' ? (
              <PairsGrid pairs={content.pairs} />
            ) : content.kind === 'empty' ? (
              <pre className="whitespace-pre-wrap text-ink-muted wrap-anywhere">
                {content.placeholder}
              </pre>
            ) : content.wrap === 'hanging' ? (
              <HangingText text={textOnScreen(content)} />
            ) : (
              /*
                Every run of text wraps (D134, D149). `wrap-anywhere` and not
                `whitespace-pre-wrap` alone, because a Base64 rendering and a
                megabyte of minified JSON contain no space to break at: without
                it such a line would not end where the reserved column beside
                the text begins, and would run on under the copy control that
                column keeps clear (D122, D149). A line is still broken at a
                space where it has one; only a run without one is cut mid-token.

                Where a continuation starts is read from the model, never
                decided here: at the edge, as here, or hanging under indented
                JSON or XML. So is the text drawn, which for `Raw` of a head
                with no body is the stored text less its closing blank line; the
                copy control below still yields all of it (D158).
              */
              <pre className="whitespace-pre-wrap text-ink-body wrap-anywhere">
                {textOnScreen(content)}
              </pre>
            )}
          </div>

          {/*
            A reserved column rather than an overlay, as tall as the box, so no
            line ever runs under the control: a wrapped line ends where this
            column begins (D122).

            The control is sticky inside it. While a box taller than the tab
            area is scrolled past, the control stays at the top of the part of
            the box that is still visible, and it leaves with the box's bottom
            edge, because a sticky element never leaves its own container (D149).
          */}
          <div className="shrink-0 py-2 pr-2 max-md:py-[5px] max-md:pr-[5px]">
            <div className="sticky top-2">
              <CopyCodeButton text={blockCopyText(content)} label={copyLabel} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

/**
 * The code face's character width and the box's width in characters, as last
 * measured by any block. Every code box in the panel is as wide as every other,
 * so a block mounted inside a half that is not on screen - which cannot measure
 * anything - draws with these and is right on the frame it is first shown.
 * `columns` is `0` until the first measurement.
 */
const lastMeasured = { characterWidth: 0, columns: 0 };

/**
 * Re-indented JSON or indented XML with a hanging indent (D149, D163).
 *
 * A line that wraps is a block of its own, padded to the column its
 * continuations start at and pulled back by the same amount on its first row:
 * the line itself starts at the edge and draws its own leading spaces, so the
 * text on screen is the text, indentation included, and a selection copied by
 * hand keeps it. Only the continuations sit deeper. A member's indentation,
 * key, `: ` and the first character of its value are one unbroken piece, so a
 * value too long for its row starts beside its key.
 *
 * **Every other line is plain text.** A line that fits the box never wraps and
 * needs no element, so runs of them are text nodes between the lines that do.
 * Which lines fit depends on how many characters the box holds, so this
 * measures that, with the face's width read off the text's own first character.
 *
 * **Nothing it draws can leave the box, whenever it was measured.** The box is
 * measured on its first layout, before anything is painted, and again by a
 * `ResizeObserver` whenever its width changes; that redraw comes on the next
 * frame, never inside the observer's callback, which would change the size it
 * observes and which Chromium reports as an error. For that one frame the runs
 * are the old ones, so the CSS does not trust them: the hanging padding is
 * clamped against the box itself (`hangingIndentStyle`, through the `pre`'s
 * `@container`), and a key's unbroken start is let break again in a box
 * narrower than it can be (`@max-[56ch]`, `KEPT_KEY_COLUMNS`). A line that
 * fitted the old width and not the new one wraps flush for that frame.
 *
 * **It never shows an empty box.** Before the first measurement it draws the
 * text's first line, which is what the face is measured on and is replaced
 * before the frame is painted. A block mounted in a half that is not on screen
 * cannot be measured; it draws with the last measurement any block made, or,
 * before there has been one, the whole text flush, so the frame on which the
 * half is first shown already has the text in it.
 */
function HangingText({ text }: { text: string }) {
  const pre = useRef<HTMLPreElement>(null);
  const [columns, setColumns] = useState<number | null>(
    lastMeasured.columns === 0 ? null : lastMeasured.columns,
  );
  const [unmeasured, setUnmeasured] = useState(false);

  useLayoutEffect(() => {
    const element = pre.current;

    if (element === null) {
      return undefined;
    }

    let width = element.getBoundingClientRect().width;

    // Whether the box could be measured: it has no layout while its half is
    // hidden. The rectangle's width, not `clientWidth`, which is rounded to a
    // whole pixel and would miscount the columns by one under zoom.
    const measure = (): boolean => {
      if (width === 0) {
        return false;
      }

      if (lastMeasured.characterWidth === 0) {
        const first = element.firstChild;

        if (!(first instanceof Text) || first.length === 0) {
          return false;
        }

        const range = document.createRange();

        range.setStart(first, 0);
        range.setEnd(first, 1);
        lastMeasured.characterWidth = range.getBoundingClientRect().width;
      }

      lastMeasured.columns = Math.floor(width / lastMeasured.characterWidth);
      setColumns(lastMeasured.columns);

      return true;
    };

    if (!measure()) {
      setUnmeasured(true);
    }

    const observer = new ResizeObserver(() => {
      const next = element.getBoundingClientRect().width;

      // The height changes whenever the text is drawn; only the width matters.
      if (next !== width) {
        width = next;
        measure();
      }
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const runs = useMemo(
    () => (columns === null ? null : hangingRuns(text, columns)),
    [text, columns],
  );

  let content: ReactNode;

  if (runs !== null) {
    // Keyed by their first stored line, so a redraw for another width keeps
    // the elements of the lines it does not change, and the browser's scroll
    // anchoring keeps the reader's place through it. A run of text is drawn as
    // `drawn`, which keeps an empty line before a line that wraps on screen.
    content = runs.map((run) =>
      run.hang === null ? (
        <Fragment key={`text-${run.line}`}>{run.drawn}</Fragment>
      ) : (
        <span key={`line-${run.line}`} className="block" style={hangingIndentStyle(run.hang)}>
          {run.keep === 0 ? (
            run.text
          ) : (
            <>
              <span className="whitespace-pre @max-[56ch]:whitespace-pre-wrap">
                {run.text.slice(0, run.keep)}
              </span>
              {run.text.slice(run.keep)}
            </>
          )}
        </span>
      ),
    );
  } else if (unmeasured) {
    content = text;
  } else {
    const end = text.indexOf('\n');

    content = end === -1 ? text : text.slice(0, end);
  }

  return (
    <pre ref={pre} className="whitespace-pre-wrap text-ink-body wrap-anywhere @container">
      {content}
    </pre>
  );
}
