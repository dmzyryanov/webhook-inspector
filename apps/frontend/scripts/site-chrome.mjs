/**
 * The header and the footer band of the static pages, `/changelog` (D184),
 * `/about` (D211), `/terms` and `/privacy` (D217), written as HTML at build
 * time. They draw what the application draws in `AppHeader.tsx` (B′ of D209)
 * and `AppFooter.tsx` (D177, D211, D217), from the same constants, so the two
 * cannot drift apart in their words or addresses;
 * `src/static-pages/site-chrome.css` styles them as the application's
 * Tailwind classes do.
 *
 * The header is unchanged on every page: `Webhook Inspector` (D277),
 * `Changelog`, `Status ↗` and `API docs ↗`; on `/changelog`, `Changelog` is
 * the current page. The
 * footer is the privacy line, `About · Terms · Privacy` and the contact
 * address; on `/about`, `/terms` and `/privacy` that page's link is the
 * current page.
 *
 * Both are drawn in a language, English unless a page asks for Russian
 * (issue #170, D255): `/ru/about` draws the words the application draws in
 * Russian, `ru.ts`'s `header` and `footer` (D222) — `Изменения`, `Статус ↗`,
 * `API docs ↗`, the Russian privacy line, `О сервисе · Условия ·
 * Конфиденциальность` and `Почта:` — with `Webhook Inspector` leading to
 * `/ru/` and `О сервисе` to `/ru/about`. The English pages are drawn as they
 * were before it.
 */
import { en } from '../src/i18n/en.ts';
import { HOME_ADDRESSES } from '../src/i18n/index.ts';
import { ru } from '../src/i18n/ru.ts';
import { API_DOCS_LINK } from '../src/lib/api-docs-link.ts';
import { BRAND_MARK } from '../src/lib/brand-mark.ts';
import { CHANGELOG_LINK } from '../src/lib/changelog-link.ts';
import { FOOTER_SEPARATOR, footerLinks, PRIVACY_FOOTER } from '../src/lib/privacy-footer.ts';
import { STATUS_LINK } from '../src/lib/status-link.ts';

/** The languages a static page is drawn in (D255), each with its words. */
const MESSAGES = { en, ru };

/**
 * The words of `lang`, a static page's language; anything but `en` and `ru`
 * fails the build rather than drawing a page in a language nobody wrote.
 */
function messagesOf(lang) {
  if (!Object.hasOwn(MESSAGES, lang)) {
    throw new Error(`a static page cannot be drawn in ${JSON.stringify(lang)}`);
  }

  return MESSAGES[lang];
}

/** Text made safe for HTML content and attribute values. */
export function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Text made safe for HTML content only: `&`, `<` and `>`. Quotes and
 * apostrophes need no escape between tags, so a text written this way stays
 * in the page byte for byte, `I'm` and every no-break space included, and a
 * `curl` of the page finds it as written.
 */
export function escapeText(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Whether a run of a static page's text is an address: the MCP server's, shown as code, or mail. */
function isAddress(part) {
  return part.kind === 'code' || part.kind === 'mail';
}

/**
 * Runs of a static page's text as HTML (D211, D217), `renderPart` writing
 * each run that is not plain words. An address is kept on one line with the
 * word before it and the text after it up to the next space, in a `.keep`
 * span that does not wrap: neither address can then end up alone on a line,
 * as the MCP address would at 320 px on `/about`, and the mail address never
 * breaks at its hyphen. The words are the approved ones, byte for byte; only
 * where a line may end changes. The span starts at the last ordinary space
 * before the address, so a phrase joined by no-break spaces stays whole
 * inside it. A link to a page is not an address and is written where it
 * stands.
 */
export function keptRuns(parts, renderPart) {
  const html = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const next = parts[index + 1];

    if (part.kind === 'text' && next !== undefined && isAddress(next)) {
      // From the last ordinary space before the address to the first after it.
      const cut = part.text.lastIndexOf(' ', part.text.length - 2) + 1;
      const after = parts[index + 2]?.kind === 'text' ? parts[index + 2].text : '';
      const end = after.includes(' ') ? after.indexOf(' ') : after.length;

      html.push(
        escapeText(part.text.slice(0, cut)),
        `<span class="keep">${escapeText(part.text.slice(cut))}${renderPart(next)}${escapeText(after.slice(0, end))}</span>`,
        escapeText(after.slice(end)),
      );
      index += parts[index + 2]?.kind === 'text' ? 2 : 1;
    } else {
      html.push(part.kind === 'text' ? escapeText(part.text) : renderPart(part));
    }
  }

  return html.join('');
}

const NEW_TAB_ARROW =
  '<svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 8.5 8.5 1.5M3 1.5h5.5V7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** A header link that opens a new tab: its label, the drawn arrow, and what the arrow says. */
function newTabLink(link) {
  return `<a class="header-link" href="${link.href}" target="${link.target}" rel="${link.rel}">${escapeText(link.label)}${NEW_TAB_ARROW}<span class="sr-only"> ${escapeText(link.newTabNote)}</span></a>`;
}

/** ` aria-current="page"` for the link to the page being drawn, nothing for the others. */
function current(link, page) {
  return link.href === page ? ' aria-current="page"' : '';
}

/**
 * The header every page carries (B′, D209). `page` is the path of the page
 * drawn, so that `Changelog` is its current page on `/changelog`, and `lang`
 * its language (D255): in Russian the links read as the application's do and
 * `Webhook Inspector` leads to `/ru/`, while every link keeps its address.
 * From 375 to 767 px the wordmark stands on two lines, and below 375 px the
 * Q mark is drawn in its place, its words kept for assistive technology
 * (`site-chrome.css`, D277).
 */
export function siteHeader(page, lang = 'en') {
  const m = messagesOf(lang);
  const changelog = { ...CHANGELOG_LINK, label: m.header.changelog };
  const status = { ...STATUS_LINK, label: m.header.status, newTabNote: m.header.newTab };
  const apiDocs = { ...API_DOCS_LINK, label: m.header.apiDocs, newTabNote: m.header.newTab };

  return [
    '<header class="site-header">',
    `  <a class="brand" href="${HOME_ADDRESSES[lang]}"><span class="brand-name">Webhook Inspector</span><img class="brand-mark" src="${BRAND_MARK.src}" alt="" width="${BRAND_MARK.size}" height="${BRAND_MARK.size}" /></a>`,
    '  <div class="header-links">',
    `    <a class="header-link" href="${changelog.href}"${current(changelog, page)}>${escapeText(changelog.label)}</a>`,
    '    <span class="header-divider" aria-hidden="true"></span>',
    `    ${newTabLink(status)}`,
    '    <span class="header-divider" aria-hidden="true"></span>',
    `    ${newTabLink(apiDocs)}`,
    '  </div>',
    '</header>',
  ].join('\n');
}

/**
 * The footer band every page closes with (D177, D211, D217): the privacy
 * line, then `About`, `Terms`, `Privacy` and the contact. From 1024 px the
 * two sit apart on one line, the links 16 px apart and 16 px left of
 * `Contact:`; below it they are one paragraph, ending
 * `About · Terms · Privacy · Contact: contact@qa-tools.ru`, kept whole on a
 * line of its own where it fits and broken only after a dot where it does
 * not: each link with the dot after it is a `.footer-item` that does not
 * wrap, and the `<wbr>` after it is where a line may end, since a space
 * inside an item that does not wrap is no place for a break. `page` is the
 * path of the page drawn, so that its own link is its current page, and
 * `lang` its language (D255): in Russian the line, the links and `Почта:` are
 * the application's Russian band's, `О сервисе` leading to `/ru/about`
 * (`footerLinks` in `privacy-footer.ts`).
 */
export function siteFooter(page, lang = 'en') {
  const m = messagesOf(lang);
  const links = footerLinks(m)
    .map(
      (link) =>
        `<span class="footer-item"><a class="footer-link" href="${escapeHtml(link.href)}"${current(link, page)}>${escapeText(link.label)}</a><span class="footer-separator" aria-hidden="true">${FOOTER_SEPARATOR}</span></span><wbr />`,
    )
    .join('');

  return [
    '<footer class="site-footer">',
    `  <p><span>${escapeText(m.footer.line)}</span> <span class="footer-end">${links}<span class="contact">${escapeText(m.footer.contact)}\u00a0<a href="${escapeHtml(PRIVACY_FOOTER.href)}">${escapeText(PRIVACY_FOOTER.address)}</a></span></span></p>`,
    '</footer>',
  ].join('\n');
}
