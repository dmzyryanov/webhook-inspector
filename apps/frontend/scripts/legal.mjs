/**
 * The Terms of Use, `/terms`, and the Privacy Policy, `/privacy` (issue #112,
 * D217): two static pages built like `/about` (D184, D211). The body of
 * `terms/index.html` and of `privacy/index.html` is written here, from
 * `LEGAL_PAGES` of `src/lib/legal-copy.ts`, and put in place by
 * `legalPagesPlugin()` when Vite builds them (`vite.legal.config.ts`) or
 * serves them in development (`vite.config.ts`). A build that does not show
 * the operator's texts (issue #369) has no page in `LEGAL_PAGES`, and writes
 * neither (`vite.legal.config.ts`). The pages are readable
 * without JavaScript and load none: their stylesheet and the Inter it draws
 * in are content-hashed files under `/assets/`.
 *
 * Every text is written between tags with `escapeText`, so a page holds it
 * byte for byte, its no-break spaces and no-break hyphen included.
 * `check-build.mjs` fails the build when a page is missing, has not been
 * written, lacks its title or asks not to be indexed.
 */
import { LEGAL_PAGES } from '../src/lib/legal-copy.ts';
import { escapeHtml, escapeText, keptRuns, siteFooter, siteHeader } from './site-chrome.mjs';

export { LEGAL_PAGES };

/** Where a page's template holds the body this module writes. */
export const LEGAL_PLACEHOLDER = '<!-- legal:page -->';

/**
 * A page's template, relative to the frontend workspace, which is also its
 * built file in `dist/`: `terms/index.html` for `/terms`.
 */
export function legalTemplate(page) {
  return `${page.path.slice(1)}/index.html`;
}

/** One run of a line that is not plain words: the contact address or a link, each an `<a>`. */
function linePart(part) {
  return `<a href="${escapeHtml(part.href)}">${escapeText(part.text)}</a>`;
}

/** A line of a section as a paragraph, the contact address kept whole with the word before it. */
function line(item) {
  return `<p>${typeof item === 'string' ? escapeText(item) : keptRuns(item, linePart)}</p>`;
}

/** A section: its label, then its lines, each a paragraph of its own, as `/about` draws its facts. */
function section(item) {
  return [
    '<div class="fact">',
    `<dt>${escapeText(item.label)}</dt>`,
    `<dd>${item.lines.map(line).join('')}</dd>`,
    '</div>',
  ].join('');
}

/**
 * Everything inside `<body>` of a page: the header, unchanged; the page: the
 * eyebrow, the title, the introduction with the date line under it, and the
 * sections; and the footer band, the page's own link its current page.
 */
export function renderLegalBody(page) {
  return [
    siteHeader(page.path),
    '<main>',
    '<div class="container">',
    '<div class="intro">',
    `<p class="eyebrow">${escapeText(page.eyebrow)}</p>`,
    `<h1>${escapeText(page.heading)}</h1>`,
    '</div>',
    `<div class="lead"><p>${escapeText(page.introduction)}</p><p class="updated">${escapeText(page.updated)}</p></div>`,
    `<dl class="facts">${page.sections.map(section).join('')}</dl>`,
    '</div>',
    '</main>',
    siteFooter(page.path),
  ].join('\n');
}

/** A page's template with its body in place. */
export function renderLegalPage(page, template) {
  if (!template.includes(LEGAL_PLACEHOLDER)) {
    throw new Error(`the template of ${page.path} has no ${LEGAL_PLACEHOLDER}`);
  }

  return template.replace(LEGAL_PLACEHOLDER, () => renderLegalBody(page));
}

/**
 * The Vite plugin that writes the body of `terms/index.html` and
 * `privacy/index.html` when they are built or served. Every other page is
 * left alone.
 */
export function legalPagesPlugin() {
  return {
    name: 'webhook-inspector-legal-pages',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const page = LEGAL_PAGES.find((item) => context.path.endsWith(`/${legalTemplate(item)}`));

        return page === undefined ? html : renderLegalPage(page, html);
      },
    },
  };
}
