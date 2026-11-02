import { partCopyText, type BodyPart } from '../lib/detail-view.ts';
import { CopyCodeButton } from './CopyCodeButton.tsx';
import { PairsGrid } from './PairsGrid.tsx';

interface BodyPartsProps {
  /** The parts in recorded order, decided in `lib/detail-view.ts` (D164). */
  parts: readonly BodyPart[];
  /** The accessible name of the body's copy control, `Copy request body`; each part adds its number. */
  copyLabel: string;
}

/**
 * A multipart body as its parts, one box after another, all open: Figma
 * `1 / Parts in sequence` (`431:12`), D164.
 *
 * Every box is the code box's surface - its background, border and corners -
 * and draws a header line, the part's headers in the grid `Headers` uses, a
 * rule, and then the content as stored with its own copy control, or a note
 * in its place. Nothing here decides what a part shows; the model does.
 */
export function BodyParts({ parts, copyLabel }: BodyPartsProps) {
  return (
    <div data-testid="body-parts" className="flex flex-col gap-[10px]">
      {parts.map((part) => (
        <PartBox
          key={part.title}
          part={part}
          copyLabel={`${copyLabel}, ${part.title.toLowerCase()}`}
        />
      ))}
    </div>
  );
}

function PartBox({ part, copyLabel }: { part: BodyPart; copyLabel: string }) {
  const { content } = part;
  const copyText = partCopyText(part);

  return (
    <div
      role="group"
      aria-label={part.name === null ? part.title : `${part.title} ${part.name}`}
      data-testid="body-part"
      className="flex flex-col gap-2 rounded-lg border border-line-panel bg-code px-4 py-3 max-md:px-3"
    >
      {/*
        The header line: `Part N` and the name on the left, what it is and its
        size on the right. Either side wraps inside its share of the line rather
        than leaving the box. On a phone the two sides are two lines, both
        starting at the left edge (D164, derived from D157).
      */}
      <div className="flex items-baseline gap-2 text-[12px] leading-[17px] max-md:flex-col max-md:items-start max-md:gap-1">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-semibold text-ink">{part.title}</span>
          {part.name === null ? null : (
            <span className="min-w-0 font-mono font-medium text-method wrap-anywhere">
              {part.name}
            </span>
          )}
        </p>
        <p className="ml-auto min-w-0 text-right text-ink-muted wrap-anywhere max-md:ml-0 max-md:text-left">
          {part.summary}
        </p>
      </div>

      {part.headers.length === 0 ? null : <PairsGrid pairs={part.headers} />}

      <div className="h-px bg-line-panel" />

      {content.kind === 'text' ? (
        <div className="flex gap-2">
          {/* Wraps flush like every run of text, and is never formatted (D149). */}
          <pre className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-[12px] leading-[20px] text-ink-body wrap-anywhere">
            {content.text}
          </pre>
          {/* A column as tall as the content, so the control stays in view while
              a long part is scrolled past, as the code box's does (D149). */}
          {copyText === null ? null : (
            <div className="-my-1 shrink-0">
              <div className="sticky top-2">
                <CopyCodeButton text={copyText} label={copyLabel} />
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-[12px] leading-[17px] text-ink-muted">{content.note}</p>
      )}
    </div>
  );
}
