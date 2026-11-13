interface PairsGridProps {
  /** Name/value rows in the order they were recorded, duplicates kept (D045). */
  pairs: readonly (readonly [string, string])[];
}

/**
 * Names and values as two columns: `Headers`, `Query`, `Body` of a form (D162)
 * and the headers of each part of a multipart body (D164).
 *
 * The name column is as wide as the widest name, up to 40% of the box, so one
 * very long name cannot squeeze every value to nothing; such a name wraps in
 * its own column. The value column takes the rest, and a long value wraps
 * inside it, so every name keeps its row. `minmax(0, 1fr)` and `wrap-anywhere`
 * both keep a value with no space in it from setting the column's minimum
 * width. `items-start` keeps each cell as tall as its own text rather than its
 * row's (D149).
 *
 * On a phone there is no room for two columns: each name sits above its value,
 * muted, and a rule parts one pair from the next (frames 3C and 3D of the Figma
 * page `Webhook Inspector · Tablet and phone`, D157). The tablet keeps the
 * columns.
 */
export function PairsGrid({ pairs }: PairsGridProps) {
  return (
    <div className="grid grid-cols-[fit-content(40%)_minmax(0,1fr)] items-start gap-x-6 font-mono text-[12px] leading-[20px] max-md:grid-cols-1">
      {pairs.map(([name, value], index) => (
        <div
          key={`${name}-${index}`}
          className="contents max-md:flex max-md:flex-col max-md:gap-0.5 max-md:border-b max-md:border-line-panel max-md:py-2 max-md:last:border-b-0"
        >
          <span className="whitespace-pre-wrap text-ink-strong wrap-anywhere max-md:text-ink-muted">
            {name}
          </span>
          <span className="whitespace-pre-wrap text-ink-body wrap-anywhere">{value}</span>
        </div>
      ))}
    </div>
  );
}
