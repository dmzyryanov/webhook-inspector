import { en } from '../i18n/en.ts';

/**
 * The footer's links to the Terms of Use and the Privacy Policy (issue #112,
 * D217), which follow `About` (`about-link.ts`) in `FOOTER_LINKS`.
 *
 * Both are static pages of their own, built like `/about` (D184, D211), not
 * routes of this application, so the links are plain `<a>`s in the same tab,
 * as `About` is. On each page the static footer marks its own link as the
 * current page, `aria-current="page"` (`scripts/site-chrome.mjs`). The pages'
 * texts are in `legal-copy.ts`; these two modules stay apart so that the
 * application, which draws the footer, never carries the texts.
 */
export const TERMS_LINK = {
  href: '/terms',
  /**
   * The English words, which the English static pages draw; `/ru/about` and the
   * application draw their language's (D222, D255).
   */
  label: en.footer.terms,
} as const;

export const PRIVACY_LINK = {
  href: '/privacy',
  label: en.footer.privacy,
} as const;
