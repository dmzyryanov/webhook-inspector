/**
 * The about page, `/about` (issue #131, D211): who runs QA Tools, how it is
 * made, who pays for it and what happens to the data people send. A static
 * page of its own, built like `/changelog` (D184): the body of
 * `about/index.html` is written here, from the constants of
 * `src/lib/about-copy.ts`, and put in place by `aboutPagePlugin()` when Vite
 * builds that page (`vite.about.config.ts`) or serves it in development
 * (`vite.config.ts`). The page is readable without JavaScript and loads none:
 * its stylesheet and the Inter it draws in are content-hashed files under
 * `/assets/`.
 *
 * Its Russian twin, `/ru/about` (issue #170, D255), is written the same way
 * from `ABOUT_RU` (`src/lib/about-copy-ru.ts`) into `ru/about/index.html`,
 * with the header and the band in Russian; every function here takes the
 * page it writes, English unless told otherwise.
 *
 * Every text is written between tags with `escapeText`, so the page holds it
 * byte for byte, its no-break spaces and no-break hyphen included.
 * `check-build.mjs` fails the build when a page is missing, has not been
 * written, or lacks its title.
 */
import { ABOUT_RU } from '../src/lib/about-copy-ru.ts';
import { ABOUT_DESCRIPTION, ABOUT_EN, ABOUT_TITLE, ABOUT_URL } from '../src/lib/about-copy.ts';
import { escapeHtml, escapeText, keptRuns, siteFooter, siteHeader } from './site-chrome.mjs';

/** Where a page's template holds the body this module writes. */
export const ABOUT_PLACEHOLDER = '<!-- about:page -->';

/**
 * A page's template, relative to the frontend workspace, which is also its
 * built file in `dist/`: `about/index.html` for `/about`,
 * `ru/about/index.html` for `/ru/about`.
 */
export function aboutTemplate(page) {
  return `${page.path.slice(1)}/index.html`;
}

/** The English page's template and its built file in `dist/`. */
export const ABOUT_TEMPLATE = aboutTemplate(ABOUT_EN);
export const ABOUT_PAGE = ABOUT_TEMPLATE;

/** The Russian page's (D255). */
export const RUSSIAN_ABOUT_PAGE = aboutTemplate(ABOUT_RU);

/** Both pages, English first. */
export const ABOUT_PAGES = [ABOUT_EN, ABOUT_RU];

export { ABOUT_DESCRIPTION, ABOUT_EN, ABOUT_RU, ABOUT_TITLE, ABOUT_URL };

/** One run of a story paragraph as HTML. */
function storyPart(part) {
  switch (part.kind) {
    case 'code':
      return `<code>${escapeText(part.text)}</code>`;
    case 'mail':
      return `<a href="${escapeHtml(part.href)}">${escapeText(part.text)}</a>`;
    default:
      return escapeText(part.text);
  }
}

/**
 * A story paragraph as HTML, each address kept on one line with the word
 * before it (`keptRuns` in `site-chrome.mjs`).
 */
function storyParagraph(parts) {
  return `<p>${keptRuns(parts, storyPart)}</p>`;
}

/** A fact: its label, then its lines, each a paragraph of its own. */
function fact(item) {
  return [
    '<div class="fact">',
    `<dt>${escapeText(item.label)}</dt>`,
    `<dd>${item.lines.map((line) => `<p>${escapeText(line)}</p>`).join('')}</dd>`,
    '</div>',
  ].join('');
}

/**
 * Everything inside `<body>` of an about page, `/about` unless `page` is
 * another: the header, in the page's language; the page (D1): the eyebrow,
 * the title, the story and the four facts; and the footer band, the page's
 * own `About` its current page.
 */
export function renderAboutBody(page = ABOUT_EN) {
  return [
    siteHeader(page.path, page.lang),
    '<main>',
    '<div class="container">',
    '<div class="intro">',
    `<p class="eyebrow">${escapeText(page.eyebrow)}</p>`,
    `<h1>${escapeText(page.heading)}</h1>`,
    '</div>',
    `<div class="story">${page.story.map(storyParagraph).join('')}</div>`,
    `<dl class="facts">${page.facts.map(fact).join('')}</dl>`,
    '</div>',
    '</main>',
    siteFooter(page.path, page.lang),
  ].join('\n');
}

/** A page's template with its body in place, `/about`'s unless `page` is another. */
export function renderAboutPage(template, page = ABOUT_EN) {
  if (!template.includes(ABOUT_PLACEHOLDER)) {
    throw new Error(`the about page template has no ${ABOUT_PLACEHOLDER}`);
  }

  return template.replace(ABOUT_PLACEHOLDER, () => renderAboutBody(page));
}

/**
 * The page whose template `path` names, as Vite gives it (`/about/index.html`,
 * `/ru/about/index.html`), or `undefined` for any other: the longest template
 * the path ends with, so `/ru/about/index.html`, which ends with
 * `/about/index.html` too, is the Russian page.
 */
export function aboutPageOf(path) {
  return ABOUT_PAGES.filter((page) => path.endsWith(`/${aboutTemplate(page)}`)).sort(
    (one, other) => other.path.length - one.path.length,
  )[0];
}

/**
 * The Vite plugin that writes the body of `about/index.html` and
 * `ru/about/index.html` when they are built or served. Every other page is
 * left alone.
 */
export function aboutPagePlugin() {
  return {
    name: 'webhook-inspector-about-page',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const page = aboutPageOf(context.path);

        return page === undefined ? html : renderAboutPage(html, page);
      },
    },
  };
}
