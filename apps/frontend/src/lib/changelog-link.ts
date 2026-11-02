import { en } from '../i18n/en.ts';

/**
 * The header's link to the changelog (issue #97, D184).
 *
 * `/changelog` is a static page of its own (D155, D184), not a route of this
 * application, so the link is a plain `<a>` rather than a router `Link`, which
 * would draw `Page not found` for it. It opens in the same tab: the changelog
 * is a page of the site, read and left, where `API docs ↗` opens a tool.
 * The page itself draws the same header with this link as the current page,
 * `aria-current="page"` (`scripts/changelog.mjs`).
 */
export const CHANGELOG_LINK = {
  href: '/changelog',
  /**
   * The English word, which the English static pages draw; `/ru/about` and the
   * application draw their language's (D222, D255).
   */
  label: en.header.changelog,
} as const;
