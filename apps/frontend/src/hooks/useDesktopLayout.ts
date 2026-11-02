import { useCallback, useSyncExternalStore } from 'react';

/**
 * The width the layout switches at: 1024 px, Tailwind's `lg` (`64rem`), which
 * is what every `lg:` and `max-lg:` class in the application answers to, so
 * the script and the stylesheet always agree on which layout is showing (D157).
 */
export const DESKTOP_QUERY = '(min-width: 64rem)';

/**
 * Narrower than 768 px: the range Tailwind's `max-md:` variant covers, in the
 * form Tailwind's own stylesheet writes it.
 */
export const PHONE_QUERY = 'not all and (min-width: 48rem)';

/**
 * One `MediaQueryList` per query for the life of the page, so reading the
 * snapshot on every render allocates nothing.
 */
const queries = new Map<string, MediaQueryList>();

function mediaQuery(query: string): MediaQueryList {
  let list = queries.get(query);

  if (list === undefined) {
    list = window.matchMedia(query);
    queries.set(query, list);
  }

  return list;
}

/**
 * Whether a media query matches, following it as the window is resized or a
 * device is rotated. Read synchronously on the first render, so a narrow page
 * never draws a desktop frame first.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = mediaQuery(query);

      list.addEventListener('change', onChange);

      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );

  return useSyncExternalStore(subscribe, () => mediaQuery(query).matches);
}

/**
 * Whether the window is at least 1024 px wide.
 *
 * The layout itself is CSS; this is for the few decisions a stylesheet cannot
 * make: whether a selection gets a history entry, and whether the receive URL
 * is drawn as one text or cut for a middle ellipsis.
 */
export function useDesktopLayout(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}

/** Whether the window is narrower than 768 px: the phone layout. */
export function usePhoneLayout(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
