/**
 * What the two controls of `/changelog` do (issue #97, D184), without a DOM,
 * so the frontend suite can hold them; `src/changelog/main.ts` applies them to
 * the page.
 */

/** Which versions `All versions` or `Breaking only` leaves on the page. */
export type ChangelogFilter = 'all' | 'breaking';

/**
 * What the filter shows, day by day: each version stays unless the filter is
 * `breaking` and the version has no Breaking, Deprecated or Notice paragraph
 * (its line's `data-breaking`, D212, D224), and a day stays while one of its
 * versions does.
 */
export function filterDays(
  days: readonly (readonly boolean[])[],
  filter: ChangelogFilter,
): { day: boolean; versions: boolean[] }[] {
  return days.map((breaking) => {
    const versions = breaking.map((isBreaking) => filter === 'all' || isBreaking);

    return { day: versions.some(Boolean), versions };
  });
}

/** `Collapse all` once every line is open, `Expand all` otherwise. */
export function expandLabel(open: readonly boolean[]): 'Expand all' | 'Collapse all' {
  return open.length > 0 && open.every(Boolean) ? 'Collapse all' : 'Expand all';
}

/** What pressing the control does: open every line, or close every line. */
export function expandTarget(open: readonly boolean[]): boolean {
  return expandLabel(open) === 'Expand all';
}
