import { en } from '../i18n/en.ts';

/**
 * The header's link to the API reference (issue #51, D158).
 *
 * `/docs` is a page of its own (D155), not a route of this application, so the
 * link is a plain `<a>` rather than a router `Link`. It opens in a new tab: a
 * reader who follows it from an open session keeps the session page, its
 * selection and its socket where they were. `noopener` because the reference
 * has no business with this window, same origin or not.
 *
 * The visible text is `API docs ↗`; the arrow is drawn, not typed - the Inter
 * subsets the page loads have no U+2197, so a typed one would fall back to
 * whatever symbol face the platform has. The accessible name keeps the visible
 * words first (WCAG 2.5.3) and says what the arrow says: that it opens a new
 * tab.
 */
export const API_DOCS_LINK = {
  href: '/docs',
  /**
   * The English words, which the English static pages draw; `/ru/about` and the
   * application draw their language's (D222, D255).
   */
  label: en.header.apiDocs,
  newTabNote: en.header.newTab,
  target: '_blank',
  rel: 'noopener',
} as const;

/** What assistive technology reads for the link: `API docs (opens in a new tab)`. */
export const API_DOCS_ACCESSIBLE_NAME = `${API_DOCS_LINK.label} ${API_DOCS_LINK.newTabNote}`;
