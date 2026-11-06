import { en } from '../i18n/en.ts';
import { OPERATOR, type Operator } from './operator.ts';

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
   * The English words, which the English static pages draw; `/ru/about` and the
   * application draw their language's (D222, D255).
   */
  label: en.header.changelog,
} as const;

/**
 * Whether a build for `operator` publishes the changelog and links it (issue
 * #396): `CHANGELOG.md`'s entries are this site's releases, written for its
 * readers, so they are among the operator's texts (`OPERATOR_TEXTS`,
 * `operator.ts`). Without them the build writes no `/changelog`, no
 * `/changelog.md` and neither feed, and nothing it writes links to them: not
 * the headers, not `llms.txt`, the sitemap, `/docs`'s head or the API
 * description (`scripts/site-operator.mjs`). `operator` is the build's unless
 * a caller gives another.
 */
export function changelogShown(operator: Operator = OPERATOR): boolean {
  return operator.texts;
}
