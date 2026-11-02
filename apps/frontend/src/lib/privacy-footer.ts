import { en, type Messages } from '../i18n/en.ts';
import { ABOUT_LINK, aboutAddress } from './about-link.ts';
import { CONTACT_ADDRESS, CONTACT_MAILTO } from './contact.ts';
import { PRIVACY_LINK, TERMS_LINK } from './legal-links.ts';

/**
 * The footer every page of the application carries (issue #88, D177): what the
 * site stores, for how long, and where to write. The wording is the one the
 * owner approved in Figma on 2026-09-29 (page `Webhook Inspector · Privacy
 * footer`, direction A), its words amended by the owner on 2026-10-25 (issue
 * #274, D265), and `privacy-footer.test.ts` pins it byte for byte.
 *
 * Every claim in it is D177's to keep true: the body and headers are stored
 * as received and the sender's address with them (D008, D130); a session is
 * deleted with everything it captured once it expires, when its idle window
 * runs out, at most `SESSION_IDLE_DAYS` unused and shorter if it was created
 * with a shorter one (D133, D242), or its lifetime does (D220), and `Delete`
 * and `Delete all` remove rows at once; the backups, one dump a night, keep
 * deleted or expired data for up to 3 days (D176), and the line calls them
 * `backups` (D265 dropped `nightly` so that it keeps its height). It says
 * nothing about the backend's log, whose lifetime the repository cannot
 * establish, nor about the usage views, which read the same rows within the
 * same window (D170).
 *
 * The two numbers, 7 and 3, are joined to their unit by no-break spaces, so
 * neither is ever left at the end of a line without it. Below 1024 px the footer's
 * links and the contact end the paragraph, `Contact:` joined to the address by
 * a no-break space; on the desktop they sit on the right of the same line
 * (D211 added `About` before `Contact:`, D217 `Terms` and `Privacy` after
 * it; the line itself is unchanged).
 *
 * These are the English words, which the English static pages draw
 * (`scripts/site-chrome.mjs`); the application's band and `/ru/about`'s draw
 * their language's, the dictionary's `footer` (D222, D255).
 */
export const PRIVACY_FOOTER = {
  line: en.footer.line,
  contactLabel: en.footer.contact,
  address: CONTACT_ADDRESS,
  href: CONTACT_MAILTO,
} as const;

/**
 * The footer's links to the site's own pages, left of `Contact:`: `About`
 * (issue #131, D211), then `Terms` and `Privacy` (issue #112, D217), as the
 * owner approved them in frames F1–F3. From 1024 px they stand 16 px apart,
 * and from `Contact:`; below 1024 px each is followed by ` · ` in the
 * paragraph, so that `About · Terms · Privacy · Contact: contact@qa-tools.ru`
 * is kept whole where it fits and breaks only after a dot where it does not,
 * no link ever on a line of its own. They are drawn in ink, Medium: links to
 * pages of this site, where the address in the link blue is mail.
 */
export const FOOTER_LINKS = [ABOUT_LINK, TERMS_LINK, PRIVACY_LINK] as const;

/** A footer link as drawn: where it leads and its words. */
export interface FooterLink {
  readonly href: string;
  readonly label: string;
}

/**
 * The footer's links in a language, `m` its words (D222): `FOOTER_LINKS` in
 * that order, each in the dictionary's `footer` words, and `About` leading to
 * the about page of that language, `/ru/about` in Russian (issue #170, D255).
 * `Terms` and `Privacy` keep `/terms` and `/privacy`, English pages, until
 * their Russian versions are delivered (#237). In English they are
 * `FOOTER_LINKS` themselves. The application's band (`AppFooter.tsx`) and the
 * static pages' (`scripts/site-chrome.mjs`) both draw these.
 */
export function footerLinks(m: Messages = en): readonly FooterLink[] {
  return [
    { href: aboutAddress(m.lang), label: m.footer.about },
    { href: TERMS_LINK.href, label: m.footer.terms },
    { href: PRIVACY_LINK.href, label: m.footer.privacy },
  ];
}

/** What stands between two of the footer's parts below 1024 px: a middle dot. */
export const FOOTER_SEPARATOR = ' \u00b7 ';

/**
 * The whole footer as one paragraph, the way it reads below 1024 px: the line,
 * then `About · Terms · Privacy · Contact: contact@qa-tools.ru`. Its
 * `textContent` is this from every width from 768 px, since the separator is
 * only hidden from 1024 px, and on every static page; below 768 px the
 * application's band carries `EN | RU` before the contact as well (D222).
 */
export const PRIVACY_FOOTER_TEXT = `${PRIVACY_FOOTER.line} ${FOOTER_LINKS.map((link) => `${link.label}${FOOTER_SEPARATOR}`).join('')}${PRIVACY_FOOTER.contactLabel}\u00a0${PRIVACY_FOOTER.address}`;
