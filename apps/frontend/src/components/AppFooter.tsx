import { Fragment } from 'react';
import { usePhoneLayout } from '../hooks/useDesktopLayout.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import { mailtoOf, OPERATOR, type Operator } from '../lib/operator.ts';
import { FOOTER_SEPARATOR, footerLine, footerLinks } from '../lib/privacy-footer.ts';
import { LanguageSwitch } from './LanguageSwitch.tsx';

/**
 * The privacy line, the footer's links and the contact address, closing every
 * page of the application as the header opens it (issue #88, D177): direction
 * A of the Figma page `Webhook Inspector · Privacy footer`, frames A1–A12,
 * with `About` before `Contact:` since issue #131 (D211) and `Terms` and
 * `Privacy` after it since issue #112 (D217), frames F1–F3 of `Webhook
 * Inspector · About page (#131)`.
 *
 * A white band under a 1 px line, 8 px above and below the text and the
 * header's side padding: 28 px on the desktop, 24 on a tablet, 16 on a phone.
 * From 1024 px the line is on the left and the links and the contact on the
 * right, 16 px apart, one line and 34 px where the width allows; a narrower
 * desktop wraps the line and keeps the right side whole. Below 1024 px the
 * two are one paragraph, ending `About · Terms · Privacy · Contact:
 * contact@qa-tools.ru`, one inline block kept whole where it fits; narrower
 * than itself, as at 320 px, it breaks only after a dot, at the `<wbr>` after
 * each link, each link with its dot and the contact never broken, so no link
 * is on a line of its own. The
 * address never breaks: `Contact:` is joined to it by a no-break space, and
 * it would otherwise break at its hyphen.
 *
 * The links are plain links to static pages of their own (D211, D217), in the
 * same tab, drawn in ink, Medium.
 *
 * The band sits in each page's column after `main`: at the bottom of the
 * window while the page is shorter than it, after the content when the page
 * scrolls. `/docs` is not this application and has no band; it shows
 * `info.contact` instead. `/changelog`, `/about`, `/terms` and `/privacy` draw
 * the same band in their own HTML (`scripts/site-chrome.mjs`), in English, and
 * `/ru/about` in Russian.
 *
 * Below 768 px the `EN | RU` switch is the last of the links, before the
 * contact, an item kept whole with its dot like the others, since the header
 * has no room for it there (issue #108, D222; close-ups `792:51`, `792:54`).
 * From 768 px it is in the header and not here. The application's band is in
 * the interface's language: `О сервисе · Условия · Конфиденциальность ·
 * Почта:` in Russian, `О сервисе` leading to the Russian about page,
 * `/ru/about`, and `Условия` and `Конфиденциальность` to the English pages
 * until their Russian versions are delivered (issue #170, D255).
 *
 * What the band holds is the build's (issue #369, `operator.ts`): without the
 * operator's texts `Terms` and `Privacy` are not there, and without a contact
 * address neither is `Contact:`; a dot then follows every part but the last.
 * Without the operator's texts the line also ends after the session's 7 days,
 * with no clause on the backups (issue #396, `footerLine`). `operator` is the
 * build's unless a test gives another.
 */
export function AppFooter({
  className,
  operator = OPERATOR,
}: {
  className?: string;
  operator?: Operator;
}) {
  const m = useMessages();
  const phone = usePhoneLayout();
  const links = footerLinks(m, operator);
  const contact = operator.contactEmail;

  return (
    <footer
      className={cn(
        'shrink-0 border-t border-line-header bg-white px-7 py-2 max-md:px-4 md:max-lg:px-6',
        className,
      )}
    >
      <p className="flex items-center justify-between gap-6 text-[12px] leading-[17px] text-ink-muted max-lg:block">
        <span>{footerLine(m, operator)}</span>{' '}
        <span className="flex shrink-0 items-center gap-4 whitespace-nowrap max-lg:inline-block max-lg:whitespace-normal">
          {links.map((link, index) => (
            <Fragment key={link.href}>
              <span className="whitespace-nowrap">
                {/* Below 1024 px its tap area reaches the band's edges, drawn
                    no differently, as the header's links do (D157). */}
                <a
                  href={link.href}
                  className="rounded-[4px] font-medium text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:relative max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-2"
                >
                  {link.label}
                </a>
                {index < links.length - 1 || phone || contact !== null ? (
                  <span aria-hidden="true" className="hidden max-lg:inline">
                    {FOOTER_SEPARATOR}
                  </span>
                ) : null}
              </span>
              {/* Where a line may end below 1024 px, after the dot: a space
                  inside the item, which does not wrap, is no place for a
                  break. From 1024 px it is no part of the flex row. */}
              <wbr className="hidden max-lg:inline" />
            </Fragment>
          ))}
          {/* Below 768 px only, and hidden from it by CSS as well, for the
              frame a widening window paints before the page re-renders. */}
          {phone ? (
            <>
              <span className="whitespace-nowrap md:hidden">
                <LanguageSwitch place="footer" />
                {contact === null ? null : <span aria-hidden="true">{FOOTER_SEPARATOR}</span>}
              </span>
              <wbr />
            </>
          ) : null}
          {contact === null ? null : (
            <span className="whitespace-nowrap">
              {m.footer.contact}
              {'\u00a0'}
              {/* Below 1024 px its tap area reaches the band's edges, drawn no
                  differently, as the header's links do (D157). */}
              <a
                href={mailtoOf(contact)}
                className="rounded-[4px] font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:relative max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-2"
              >
                {contact}
              </a>
            </span>
          )}
        </span>
      </p>
    </footer>
  );
}
