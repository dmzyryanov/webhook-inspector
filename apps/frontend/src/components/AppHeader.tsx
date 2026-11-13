import { Link } from 'react-router-dom';
import { usePhoneLayout } from '../hooks/useDesktopLayout.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { homeAddress } from '../i18n/index.ts';
import { API_DOCS_LINK } from '../lib/api-docs-link.ts';
import { BRAND_MARK } from '../lib/brand-mark.ts';
import { CHANGELOG_LINK, changelogShown } from '../lib/changelog-link.ts';
import { OPERATOR, type Operator } from '../lib/operator.ts';
import { statusLink } from '../lib/status-link.ts';
import { LanguageSwitch } from './LanguageSwitch.tsx';
import { MoveBanner } from './MoveBanner.tsx';

/**
 * Shared across every page, so a future QA Tools utility can slot in (D001).
 *
 * The wordmark on the left, the service's own name, `Webhook Inspector`
 * (issue #322, D277): on one line from 768 px, on two at 15/17 px from 375 to
 * 767 px, the header still 56 px high there (direction A of the Figma page
 * `Webhook Inspector · Header name (#322)`). On the right the links the
 * build draws, at most `Changelog`, `Status ↗` and the link to the API
 * reference (see the last paragraph), a 1 × 16 px divider between each pair,
 * at every width, a phone included (direction B′ of the Figma page `Webhook
 * Inspector · Status page link (#99)`, D209, amending D184's header, row L2′ of
 * the Figma page `Webhook Inspector · Changelog`).
 * The links are 16 px apart from 768 px and 12 px below. Below 375 px the
 * wordmark gives way to the 24 px Q mark, so the row fits: at 320 px it is
 * 24 + 244.5 px of the 288 the padding leaves. `/changelog`, a static page, draws the same header in
 * its own HTML, with `Changelog` as the current page (`scripts/changelog.mjs`).
 *
 * From 768 px the `EN | RU` switch closes the links, after one more divider,
 * 16 px apart as they are (issue #108, D222). Below 768 px the header has no
 * room for it - the wordmark and the three links take 315 of 343 px at 375 -
 * so it is in the footer band's links there, and the header is as it was. The
 * links are the interface's language's words but `API docs ↗`, which stays
 * English with `/docs`. The static pages draw the header with no switch: the
 * English static pages in English, and `/ru/about` in Russian, its wordmark
 * leading to `/ru/` (D255).
 *
 * On the inspector's old address the move banner comes first, above the
 * header, on every page that draws the header: the home page, a session's
 * and `Page not found` (issue #321, D276). Elsewhere it draws nothing.
 *
 * Which links are drawn is the build's (`operator.ts`). `Status ↗` leads to
 * the build's status page (issue #369, `status-link.ts`), and `Changelog` is
 * among the operator's texts (issue #396, `changelogShown`), which a build
 * shows only when it names a status page and a contact address; each is left
 * out, with the divider after it, when its setting is not given. The links
 * therefore read one of three ways, and no other:
 * `Changelog | Status ↗ | API docs ↗` with the operator's texts, as
 * production's do; `Status ↗ | API docs ↗` with a status page and no texts;
 * and `API docs ↗` alone with no status page. `operator` is the build's
 * unless a test gives another.
 */
export function AppHeader({ operator = OPERATOR }: { operator?: Operator }) {
  const m = useMessages();
  const phone = usePhoneLayout();
  const status = statusLink(operator.statusPageUrl);
  const changelog = changelogShown(operator);

  return (
    <>
      <MoveBanner />
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-line-header bg-white px-7 max-lg:h-14 max-md:px-4 md:max-lg:px-6">
        {/*
         * The wordmark is the way back to session creation (D107): the home
         * page of the language shown, `/` in English and `/ru/` in Russian, so
         * a visitor who came from `/ru/` goes back to it (D226). It is a plain
         * link, so it works with the mouse, the keyboard and a middle click, and
         * it neither creates nor deletes a session by itself. Below 1024 px its
         * tap area is 44 px high, drawn no differently (D157). Below 375 px the
         * Q mark is drawn in its place and the words stay for assistive
         * technology only, so the link is named `Webhook Inspector` at every
         * width (D209, D277). From 375 to 767 px the name stands on two lines,
         * `Webhook` over `Inspector`, 15 px on a 17 px line, as frames A-3 and
         * A-4 draw it: a block no wider than its longest word, so one text
         * keeps the one name and the header its 56 px.
         */}
        <Link
          to={homeAddress(m.lang)}
          className="rounded-[7px] text-[17px] font-semibold text-ink transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:relative max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-[10px]"
        >
          <span className="max-md:block max-md:max-w-min max-md:text-[15px] max-md:leading-[17px] max-[375px]:sr-only">
            Webhook Inspector
          </span>
          <img
            src={BRAND_MARK.src}
            alt=""
            width={BRAND_MARK.size}
            height={BRAND_MARK.size}
            className="hidden size-6 max-[375px]:block"
          />
        </Link>
        <div className="flex items-center gap-4 max-md:gap-3">
          {/* A page of its own, so a plain link in the same tab; below 1024 px
            its tap area is 44 px high, drawn no differently (D157). None for
            a build without the operator's texts (issue #396). */}
          {changelog ? (
            <>
              <a
                href={CHANGELOG_LINK.href}
                className="rounded-[4px] text-[13px] font-medium leading-4 whitespace-nowrap text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:relative max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-[14px]"
              >
                {m.header.changelog}
              </a>
              <span aria-hidden="true" className="h-4 w-px bg-line" />
            </>
          ) : null}
          {/* The public status page, another site: a new tab, as API docs ↗
            (D209). Below 1024 px its tap area is 45 px high. None for a
            build that names no status page (issue #369). */}
          {status === null ? null : (
            <>
              <a
                href={status.href}
                target={status.target}
                rel={status.rel}
                className="inline-flex items-center gap-1.5 rounded-[4px] text-[13px] font-medium leading-[17px] whitespace-nowrap text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:relative max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-[14px]"
              >
                {m.header.status}
                <NewTabArrow />
                <span className="sr-only">{` ${m.header.newTab}`}</span>
              </a>
              <span aria-hidden="true" className="h-4 w-px bg-line" />
            </>
          )}
          {/* Below 1024 px its tap area is 45 px high, as the wordmark's is. */}
          <a
            href={API_DOCS_LINK.href}
            target={API_DOCS_LINK.target}
            rel={API_DOCS_LINK.rel}
            className="inline-flex items-center gap-1.5 rounded-[4px] text-[13px] font-medium leading-[17px] whitespace-nowrap text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:relative max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-[14px]"
          >
            {m.header.apiDocs}
            <NewTabArrow />
            <span className="sr-only">{` ${m.header.newTab}`}</span>
          </a>
          {/* Drawn from 768 px only; hidden below it by CSS as well, so the
            frame a narrowing window paints before the page re-renders has
            no switch to push the row wider. */}
          {phone ? null : (
            <>
              <span aria-hidden="true" className="h-4 w-px bg-line max-md:hidden" />
              <LanguageSwitch place="header" className="max-md:hidden" />
            </>
          )}
        </div>
      </header>
    </>
  );
}

/**
 * The drawn `↗` after a link that opens a new tab: the Inter subsets the page
 * loads have no U+2197 (D158). A 10 px box, as wide as the glyph it stands
 * for, so `API docs ↗` keeps the 71 px it has in frames A1 (`418:12`,
 * `418:44`) of the Figma page `Webhook Inspector · Polish and API docs link`,
 * and `Status ↗` the 56 px it has in direction B′ of the Figma page
 * `Webhook Inspector · Status page link (#99)`.
 */
function NewTabArrow() {
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
      <path
        d="M1.5 8.5 8.5 1.5M3 1.5h5.5V7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
