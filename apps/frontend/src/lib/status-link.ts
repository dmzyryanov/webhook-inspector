import { en } from '../i18n/en.ts';

/**
 * The header's link to the public status page (issue #99, D209).
 *
 * `https://status.qa-tools.ru/` is a Statuser page of its own, not part of
 * this site: whether the site, the API and webhook receiving are up, each
 * checked every minute from outside, with its uptime history and reports of
 * outages. `https://qa-tools.ru/status` redirects to the same address
 * (`nginx.conf`).
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
export const STATUS_LINK = {
  href: 'https://status.qa-tools.ru/',
  /**
   * The English words, which the English static pages draw; `/ru/about` and the
   * application draw their language's (D222, D255).
   */
  label: en.header.status,
  newTabNote: en.header.newTab,
  target: '_blank',
  rel: 'noopener noreferrer',
} as const;

/** What assistive technology reads for the link: `Status (opens in a new tab)`. */
export const STATUS_ACCESSIBLE_NAME = `${STATUS_LINK.label} ${STATUS_LINK.newTabNote}`;
