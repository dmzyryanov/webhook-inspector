import { en } from '../i18n/en.ts';
import { OPERATOR } from './operator.ts';

/**
 * The header's link to the public status page (issue #99, D209).
 *
 * The page is the build's `STATUS_PAGE_URL` since issue #369 (`operator.ts`):
 * a page of its own, not part of this site, saying whether the site, the API
 * and webhook receiving are up, as production's Statuser page does at
 * `https://status.qa-tools.ru/`. `/status` redirects to the same address
 * (`scripts/nginx-conf.mjs`). A build that names no status page draws no
 * link, and shows none of the operator's texts, which name it, so its header
 * reads `API docs ↗` alone, with no `Changelog` either (`AppHeader.tsx`).
 *
 * Built like the link to the API reference (`api-docs-link.ts`): a plain
 * `<a>` that opens in a new tab, so a session page stays where it was, with
 * `noopener`, since the page has no business with this window. The visible
 * text is `Status ↗`, the arrow drawn rather than typed, and the accessible
 * name keeps the visible word first (WCAG 2.5.3) and says what the arrow says.
 *
 * Unlike `API docs ↗`, it also carries `noreferrer`, so it sends no `Referer`
 * at all: the status page is a third party's, and a session page's address
 * holds the session's access key (D004), which must not reach it whatever a
 * browser's default referrer policy is. `/docs` is the site's own page, so
 * that link needs no such care.
 */
export interface StatusLink {
  readonly href: string;
  /**
   * The English words, which the English static pages draw; `/ru/about` and the
   * application draw their language's (D222, D255).
   */
  readonly label: string;
  readonly newTabNote: string;
  readonly target: '_blank';
  readonly rel: 'noopener noreferrer';
}

/** The link to the status page at `href`, or `null` for a build with none. */
export function statusLink(href: string | null): StatusLink | null {
  return href === null
    ? null
    : {
        href,
        label: en.header.status,
        newTabNote: en.header.newTab,
        target: '_blank',
        rel: 'noopener noreferrer',
      };
}

/** The link this build draws, or `null` when it names no status page. */
export const STATUS_LINK: StatusLink | null = statusLink(OPERATOR.statusPageUrl);

/** What assistive technology reads for the link: `Status (opens in a new tab)`. */
export const STATUS_ACCESSIBLE_NAME = `${en.header.status} ${en.header.newTab}`;
