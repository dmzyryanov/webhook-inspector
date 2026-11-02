import { en } from '../i18n/en.ts';

/**
 * The footer's link to the about page (issue #131, D211).
 *
 * `/about` is a static page of its own, built like `/changelog` (D184,
 * D211), not a route of this application, so the link is a plain `<a>` rather
 * than a router `Link`, which would draw `Page not found` for it. It opens in
 * the same tab, as `Changelog` in the header does: the page is part of the
 * site, read and left. It is the first of the footer's links
 * (`FOOTER_LINKS` in `privacy-footer.ts`); `Terms` and `Privacy` follow it the
 * same way (`legal-links.ts`, D217). On `/about` itself the static footer marks
 * it as the current page, `aria-current="page"` (`scripts/site-chrome.mjs`).
 */
export const ABOUT_LINK = {
  href: '/about',
  /**
   * The English word, which the English static pages draw; `/ru/about` and the
   * application draw their language's (D222, D255).
   */
  label: en.footer.about,
} as const;

/**
 * Each language's about page (issue #170, D255): English at `/about`, Russian
 * at `/ru/about`, D226's `/ru/` convention. The footer's `About` leads to the
 * page in the language shown, in the application (`AppFooter.tsx`) and on the
 * static pages (`scripts/site-chrome.mjs`) alike.
 */
export const ABOUT_ADDRESSES = { en: ABOUT_LINK.href, ru: '/ru/about' } as const;

/** The about page of a language, by its tag (`Messages['lang']`); English's for anything else. */
export function aboutAddress(language: string): string {
  return language === 'ru' ? ABOUT_ADDRESSES.ru : ABOUT_ADDRESSES.en;
}
