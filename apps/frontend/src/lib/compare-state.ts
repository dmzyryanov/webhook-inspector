/**
 * Where `Compare with…` stands for the open request (#75, D186): picking a
 * request in the list, or comparing with the one chosen. Pure transitions,
 * so that "`Cancel` leaves picking with nothing changed" is a test rather
 * than a hope: picking started by `Change` or `Choose another` remembers the
 * comparison it came from, and `Cancel`, Escape or a phone's Back put that
 * comparison back, on the view it showed; picking started from the request
 * actions returns to the open request.
 */
import type { CompareViewName } from './request-diff.ts';

/** A comparison on screen: the chosen request's row as chosen, and the view picked, if any. */
export interface Compared<Item> {
  chosen: Item;
  /** `null` until the tester picks a view: the comparison's opening view is shown. */
  view: CompareViewName | null;
}

export type ComparisonState<Item> =
  { phase: 'picking'; previous: Compared<Item> | null } | ({ phase: 'comparing' } & Compared<Item>);

/** `Compare with…`, `Change` or `Choose another`. */
export function startPicking<Item>(current: ComparisonState<Item> | null): ComparisonState<Item> {
  if (current === null) {
    return { phase: 'picking', previous: null };
  }

  if (current.phase === 'picking') {
    return current;
  }

  return { phase: 'picking', previous: { chosen: current.chosen, view: current.view } };
}

/** `Cancel`, Escape or Back while picking: the state picking started from. */
export function cancelPicking<Item>(
  current: ComparisonState<Item> | null,
): ComparisonState<Item> | null {
  if (current === null || current.phase === 'comparing') {
    return current;
  }

  return current.previous === null ? null : { phase: 'comparing', ...current.previous };
}

/** A row chosen while picking: a new comparison, on its opening view. */
export function chooseRequest<Item>(item: Item): ComparisonState<Item> {
  return { phase: 'comparing', chosen: item, view: null };
}

/** The tester picked a view of the comparison on screen. */
export function withView<Item>(
  current: ComparisonState<Item> | null,
  view: CompareViewName,
): ComparisonState<Item> | null {
  return current?.phase === 'comparing' ? { ...current, view } : current;
}
