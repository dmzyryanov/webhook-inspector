import { en, type Messages } from '../i18n/en.ts';
import { ABOUT_LINK, aboutAddress } from './about-link.ts';
import { CONTACT_ADDRESS, CONTACT_MAILTO } from './contact.ts';
import { PRIVACY_LINK, TERMS_LINK } from './legal-links.ts';
import { OPERATOR, type Operator } from './operator.ts';

/**
 * The footer every page of the application carries (issue #88, D177): what the
 * site stores, for how long, and where to write. The wording is the one
 * approved in Figma on 2026-09-29 (page `Webhook Inspector · Privacy
 * footer`, direction A), its words amended on 2026-10-25 (issue
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
 *
 * The address is the build's `CONTACT_EMAIL` (issue #369, `contact.ts`). A
 * build that names none has no `Contact:` at all: `address` and `href` are
 * `null`, and the band ends with its last link, with no dot after it.
 *
 * The line's last clause, on the backups, is the operator's (issue #396):
 * the 3 days are this site's, its chart's `backup.keep`, and a copy run with
 * `npm run dev` has no backup at all, so a build without the operator's
 * texts ends the line after the session's 7 days (`footerLine`).
 */
export const PRIVACY_FOOTER = {
  line: footerLine(),
  contactLabel: en.footer.contact,
  address: CONTACT_ADDRESS,
  href: CONTACT_MAILTO,
} as const;

/**
 * The footer's links to the site's own pages, left of `Contact:`: `About`
 * (issue #131, D211), then `Terms` and `Privacy` (issue #112, D217), as
 * approved in frames F1–F3 of the Figma page `Webhook Inspector · About page
 * (#131)`. From 1024 px they stand 16 px apart,
 * and from `Contact:`; below 1024 px each is followed by ` · ` in the
 * paragraph, so that `About · Terms · Privacy · Contact: contact@qa-tools.ru`
 * is kept whole where it fits and breaks only after a dot where it does not,
 * no link ever on a line of its own. They are drawn in ink, Medium: links to
 * pages of this site, where the address in the link blue is mail.
 *
 * `Terms` and `Privacy` are the operator's texts (issue #369): a build that
 * does not show them (`OPERATOR_TEXTS`, `operator.ts`) links `About` alone.
 */
export const FOOTER_LINKS: readonly FooterLink[] = OPERATOR.texts
  ? [ABOUT_LINK, TERMS_LINK, PRIVACY_LINK]
  : [ABOUT_LINK];

/**
 * The footer's line in a language, `m` its words, for `operator`'s build
 * (issue #396): D265's, its clause on the backups included, with the
 * operator's texts; without them the same words ending after the session's
 * 7 days, `footer.lineWithoutBackups`, which the application's band, the
 * static pages and `/ru/about` all draw.
 */
export function footerLine(m: Messages = en, operator: Operator = OPERATOR): string {
  return operator.texts ? m.footer.line : m.footer.lineWithoutBackups;
}

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
 * static pages' (`scripts/site-chrome.mjs`) both draw these. `operator` is
 * the build's (issue #369): without its texts, `About` alone.
 */
export function footerLinks(
  m: Messages = en,
  operator: Operator = OPERATOR,
): readonly FooterLink[] {
  return [
    { href: aboutAddress(m.lang), label: m.footer.about },
    ...(operator.texts
      ? [
          { href: TERMS_LINK.href, label: m.footer.terms },
          { href: PRIVACY_LINK.href, label: m.footer.privacy },
        ]
      : []),
  ];
}

/** What stands between two of the footer's parts below 1024 px: a middle dot. */
export const FOOTER_SEPARATOR = ' \u00b7 ';

/**
 * The whole footer as one paragraph, the way it reads below 1024 px, in a
 * language, `m` its words: the line `operator`'s build draws (`footerLine`),
 * then `About · Terms · Privacy · Contact: contact@qa-tools.ru`, the parts
 * that build has, a dot between each two (issue #369). Its `textContent` is this from every width from 768 px,
 * since the separator is only hidden from 1024 px, and on every static page;
 * below 768 px the application's band carries `EN | RU` before the contact as
 * well (D222).
 */
export function footerText(m: Messages = en, operator: Operator = OPERATOR): string {
  const contact =
    operator.contactEmail === null ? [] : [`${m.footer.contact}\u00a0${operator.contactEmail}`];

  return `${footerLine(m, operator)} ${[...footerLinks(m, operator).map((link) => link.label), ...contact].join(FOOTER_SEPARATOR)}`;
}

/** The English footer of this build as one paragraph (`footerText`). */
export const PRIVACY_FOOTER_TEXT = footerText();
