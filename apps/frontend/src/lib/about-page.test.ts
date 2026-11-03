import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { siteFooter, siteHeader } from '../../scripts/site-chrome.mjs';
import type { SiteOrigins } from '../../scripts/site-origin.mjs';
import { en } from '../i18n/en.ts';
import { ru } from '../i18n/ru.ts';
import { ABOUT_LINK } from './about-link.ts';
import { CHANGELOG_LINK } from './changelog-link.ts';
import { PRIVACY_LINK, TERMS_LINK } from './legal-links.ts';

/**
 * Production's origins, whatever the shell running the tests holds (#354):
 * the templates and the pages pinned here are written for production
 * (D274). The build's modules read the origins from the environment as they
 * load, so they are imported once these are set, not with the static imports
 * above, which would load them first.
 */
Object.assign(process.env, {
  APP_ORIGIN: 'https://qa-tools.ru',
  RECEIVE_ORIGIN: 'https://hook.qa-tools.ru',
  APP_ALIAS_ORIGIN: 'https://webhook.qa-tools.ru',
});

const {
  ABOUT_PAGE,
  ABOUT_PAGES,
  ABOUT_PLACEHOLDER,
  aboutPageOf,
  aboutPagePlugin,
  aboutTemplate,
  renderAboutBody,
  renderAboutPage,
  RUSSIAN_ABOUT_PAGE,
} = await import('../../scripts/about.mjs');
const {
  ABOUT_HREFLANG,
  aboutPageProblems,
  checkBuild,
  productionNamesLeft,
  // @ts-expect-error -- a plain ES module with no declarations; the build runs it.
} = await import('../../scripts/check-build.mjs');
const { ABOUT_RU } = await import('./about-copy-ru.ts');
const {
  ABOUT_DESCRIPTION,
  ABOUT_EN,
  ABOUT_EYEBROW,
  ABOUT_FACTS,
  ABOUT_HEADING,
  ABOUT_STORY,
  ABOUT_TITLE,
  ABOUT_URL,
  aboutParagraphText,
  MCP_SERVER_URL,
} = await import('./about-copy.ts');
const { PRODUCTION_ORIGINS, SITE_ORIGINS, siteOriginPlugin } =
  await import('../../scripts/site-origin.mjs');

/** A copy at another address with no second origin of its own, as `llms.test.ts` has one (#342). */
const ANOTHER: SiteOrigins = {
  app: 'https://inspector.example',
  receive: 'https://hook.inspector.example',
  alias: null,
};

/**
 * The about page at `/about` (issue #131, D211), without a browser: the body
 * the build writes from `about-copy.ts`, its template's head, the nginx
 * locations and the dev server that serve it, the build that makes it and the
 * check that fails the build without it; and its Russian twin at
 * `/ru/about` (issue #170, D255), written from `about-copy-ru.ts` with the
 * header and the band in Russian. `e2e/about.spec.ts` opens both pages.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const body = renderAboutBody();
const template = read('../../about/index.html');
const page = renderAboutPage(template);

const russianBody = renderAboutBody(ABOUT_RU);
const russianTemplate = read('../../ru/about/index.html');
const russianPage = renderAboutPage(russianTemplate, ABOUT_RU);

const NBSP = String.fromCharCode(0xa0);

/** What a reader sees of some HTML: tags removed, the three escapes undone, no-break spaces kept. */
const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

/** The one element of a kind in the body, whole. */
const element = (tag: string, html = body) =>
  new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`).exec(html)?.[0] ?? '';

/** The `hreflang` links of a page, as `[language, address]` in order. */
const hreflang = (html: string) =>
  [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)" \/>/g)].map(
    (match) => [match[1], match[2]],
  );

/** What the Vite plugin makes of a page's HTML at a path, as a build or the dev server asks. */
function aboutPagePluginHandler(): (html: string, path: string) => string {
  const hook = aboutPagePlugin().transformIndexHtml as unknown as {
    handler: (html: string, context: { path: string }) => string;
  };

  return (html, path) => hook.handler(html, { path });
}

/** The footer line 1.12.1 drew, before the owner's words of 1.15.16 (D265). */
const FOOTER_LINE_BEFORE =
  "Captured requests \u2014 headers, body and the sender's IP \u2014 are kept until you delete them or the session goes unused for 7\u00a0days; nightly backups keep them up to 3\u00a0days longer.";

/** The wordmark 1.12.1 drew, and the one since 1.18.0, the service's name (D277). */
const WORDMARK_BEFORE = '<span class="brand-name">QA Tools</span>';
const WORDMARK = '<span class="brand-name">Webhook Inspector</span>';

/** The SHA-256 of `about/index.html` as 1.12.1 had it, before the hreflang links. */
const ENGLISH_TEMPLATE_BEFORE = '387899c60ab4ba2e788cfb7525f4de986617d288c0752ee65ae88346f307575f';

describe('the page', () => {
  it('is built here for production’s origins, whatever the shell running the tests holds (#354)', () => {
    assert.deepEqual(SITE_ORIGINS, PRODUCTION_ORIGINS);
  });

  it('is written byte for byte as before its Russian twin came (D255), but for the footer line and the wordmark', () => {
    // The SHA-256 of the body 1.12.1 wrote: the page object, the language the
    // header and the band take, and the Russian page change nothing here. The
    // footer's words, amended in 1.15.16 (D265), and the wordmark, the
    // service's name since 1.18.0 (D277), are the two differences since, and
    // are put back for the comparison.
    assert.equal(body.split(en.footer.line).length, 2, 'the band does not draw the line once');
    assert.equal(body.split(WORDMARK).length, 2, 'the header does not draw the wordmark once');
    assert.equal(
      createHash('sha256')
        .update(body.replace(en.footer.line, FOOTER_LINE_BEFORE).replace(WORDMARK, WORDMARK_BEFORE))
        .digest('hex'),
      'fb32106fbebc376eb0a201819cf18bbbdc211d4354b9e7f8b6700c6f3782c066',
    );
    assert.equal(renderAboutBody(ABOUT_EN), body);
    assert.equal(renderAboutPage(template, ABOUT_EN), page);
  });

  it('holds every text of about-copy.ts as written, without a script', () => {
    const main = element('main');

    // Byte for byte in the HTML itself, as a curl of the page reads it:
    // nothing in the texts needs an escape.
    for (const text of [
      ABOUT_EYEBROW,
      ABOUT_HEADING,
      ...ABOUT_FACTS.flatMap((fact) => [fact.label, ...fact.lines]),
    ]) {
      assert.ok(main.includes(text), text);
    }

    for (const paragraph of ABOUT_STORY) {
      assert.ok(visible(main).includes(aboutParagraphText(paragraph)));
    }

    assert.doesNotMatch(page, /<script\b/);
  });

  it('draws the eyebrow, the title, the story and the facts, in that order', () => {
    const main = element('main');

    assert.match(
      main,
      /^<main>\n<div class="container">\n<div class="intro">\n<p class="eyebrow">[^<]+<\/p>\n<h1>[^<]+<\/h1>\n<\/div>\n<div class="story">(?:<p>[\s\S]*?<\/p>){3}<\/div>\n<dl class="facts">(?:<div class="fact"><dt>[^<]+<\/dt><dd>(?:<p>[^<]+<\/p>)+<\/dd><\/div>){4}<\/dl>\n<\/div>\n<\/main>$/,
    );
    assert.equal(visible(element('h1')), ABOUT_HEADING);
    assert.equal(body.split('<h1>').length - 1, 1);
    // Each line of a fact is a line of its own.
    assert.deepEqual(
      [...main.matchAll(/<dd>([\s\S]*?)<\/dd>/g)].map((match) =>
        [...(match[1] as string).matchAll(/<p>([^<]+)<\/p>/g)].map((line) => line[1]),
      ),
      ABOUT_FACTS.map((fact) => fact.lines),
    );
    assert.deepEqual(
      [...main.matchAll(/<dt>([^<]+)<\/dt>/g)].map((match) => match[1]),
      ABOUT_FACTS.map((fact) => fact.label),
    );
  });

  it('shows the MCP address as code, never a link, and the contact address as mail', () => {
    assert.ok(
      body.includes(
        `through its MCP <span class="keep">server, <code>${MCP_SERVER_URL}</code>.</span></p>`,
      ),
    );
    assert.doesNotMatch(body, /href="https:\/\/qa-tools\.ru\/mcp"/);
    assert.ok(
      body.includes(
        `glad to hear <span class="keep">what${NBSP}you${NBSP}think: <a href="mailto:contact@qa-tools.ru">contact@qa-tools.ru</a>.</span></p>`,
      ),
    );
  });

  it('keeps each address on one line with the word before it, so it never stands alone', () => {
    // The first paragraph has no address and no such span; each of the others one.
    assert.deepEqual(
      [...element('main').matchAll(/<p>([\s\S]*?)<\/p>/g)]
        .slice(0, 3)
        .map((match) => (match[1] as string).split('<span class="keep">').length - 1),
      [0, 1, 1],
    );
    assert.match(read('../about/about.css'), /\.story \.keep \{\n\s*white-space: nowrap;\n\}/);
  });

  it('carries the header every page carries, unchanged, with no current page', () => {
    const header = element('header');

    assert.equal(header, siteHeader(ABOUT_LINK.href));
    assert.equal(
      header,
      siteHeader(CHANGELOG_LINK.href).replace(' aria-current="page"', ''),
      'the header is not the changelog page’s with Changelog no longer current',
    );
    assert.doesNotMatch(header, /aria-current/);
    assert.doesNotMatch(header, /About/);
  });

  it('closes with the footer band, About its current page', () => {
    assert.equal(element('footer'), siteFooter(ABOUT_LINK.href));
    assert.match(
      element('footer'),
      /<a class="footer-link" href="\/about" aria-current="page">About<\/a>/,
    );
    assert.ok(body.endsWith('</footer>'));
  });
});

describe('the Russian page (D255)', () => {
  const main = element('main', russianBody);

  it('holds every text of about-copy-ru.ts as written, without a script', () => {
    for (const text of [
      ABOUT_RU.eyebrow,
      ABOUT_RU.heading,
      ...ABOUT_RU.facts.flatMap((fact) => [fact.label, ...fact.lines]),
    ]) {
      assert.ok(main.includes(text), text);
    }

    assert.deepEqual(
      [...main.matchAll(/<p>([\s\S]*?)<\/p>/g)].slice(0, 3).map((match) => visible(match[1] ?? '')),
      ABOUT_RU.story.map(aboutParagraphText),
    );
    assert.doesNotMatch(russianPage, /<script\b/);
  });

  it('draws the page as /about does: the eyebrow, the title, the story and the facts', () => {
    // The same markup as the English page, its words aside.
    const markup = (html: string) => html.replace(/>[^<]+</g, '><');

    assert.equal(markup(main), markup(element('main')));
    assert.equal(visible(element('h1', russianBody)), ABOUT_RU.heading);
    assert.deepEqual(
      [...main.matchAll(/<dd>([\s\S]*?)<\/dd>/g)].map((match) =>
        [...(match[1] as string).matchAll(/<p>([^<]+)<\/p>/g)].map((line) => line[1]),
      ),
      ABOUT_RU.facts.map((fact) => fact.lines),
    );
    assert.deepEqual(
      [...main.matchAll(/<dt>([^<]+)<\/dt>/g)].map((match) => match[1]),
      ABOUT_RU.facts.map((fact) => fact.label),
    );
  });

  it('keeps each address with the word before it, the MCP address code and the mail address a link', () => {
    assert.ok(
      russianBody.includes(
        `через <span class="keep">MCP-сервер <code>${MCP_SERVER_URL}</code>.</span></p>`,
      ),
    );
    assert.ok(
      russianBody.includes(
        `и${NBSP}пишите, <span class="keep">что${NBSP}думаете: <a href="mailto:contact@qa-tools.ru">contact@qa-tools.ru</a>.</span></p>`,
      ),
    );
    assert.doesNotMatch(russianBody, /href="https:\/\/qa-tools\.ru\/mcp"/);
  });

  it('carries the header in Russian, its words ru.ts\u2019s, Webhook Inspector leading to /ru/ and no current page', () => {
    const header = element('header', russianBody);

    assert.equal(header, siteHeader(ABOUT_RU.path, 'ru'));
    assert.match(
      header,
      /<a class="brand" href="\/ru\/"><span class="brand-name">Webhook Inspector<\/span>/,
    );
    assert.ok(
      header.includes(`<a class="header-link" href="/changelog">${ru.header.changelog}</a>`),
    );
    assert.ok(header.includes(`rel="noopener noreferrer">${ru.header.status}<svg`));
    assert.ok(header.includes(`rel="noopener">${ru.header.apiDocs}<svg`));
    assert.equal(header.split(`<span class="sr-only"> ${ru.header.newTab}</span>`).length - 1, 2);
    assert.doesNotMatch(header, /aria-current/);
    // The English header, every address the same, the words aside.
    assert.equal(
      header.replace('href="/ru/"', 'href="/"').replace(/>[^<]+</g, '><'),
      element('header').replace(/>[^<]+</g, '><'),
    );
  });

  it('closes with the band in Russian, О сервисе its current page at /ru/about', () => {
    const footer = element('footer', russianBody);

    assert.equal(footer, siteFooter(ABOUT_RU.path, 'ru'));
    assert.ok(footer.includes(`<span>${ru.footer.line}</span>`));
    assert.deepEqual(
      [
        ...footer.matchAll(
          /<a class="footer-link" href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g,
        ),
      ].map(([, href, current, label]) => [href, label, current !== undefined]),
      [
        ['/ru/about', ru.footer.about, true],
        // The legal pages stay English until their own issue (#237).
        [TERMS_LINK.href, ru.footer.terms, false],
        [PRIVACY_LINK.href, ru.footer.privacy, false],
      ],
    );
    assert.ok(
      footer.includes(
        `<span class="contact">${ru.footer.contact}${NBSP}<a href="mailto:contact@qa-tools.ru">contact@qa-tools.ru</a></span>`,
      ),
    );
    assert.ok(russianBody.endsWith('</footer>'));
  });
});

describe('the template', () => {
  /** The template's head, as written. */
  const head = /<head>([\s\S]*?)<\/head>/.exec(template)?.[1] ?? '';

  it('names and describes the page, and points search engines at its address', () => {
    assert.match(head, new RegExp(`<title>${ABOUT_TITLE}</title>`));
    assert.match(
      head,
      new RegExp(`<meta\\s+name="description"\\s+content="${ABOUT_DESCRIPTION}"\\s*/>`),
    );
    assert.ok(head.includes(`<link rel="canonical" href="${ABOUT_URL}" />`));
    assert.doesNotMatch(template, /noindex/i);
  });

  it('loads its stylesheet and nothing else: no script, nothing from another origin', () => {
    assert.ok(head.includes('<link rel="stylesheet" href="/src/about/about.css" />'));
    assert.doesNotMatch(template, /<script\b/);
    assert.doesNotMatch(template, /src="(?:https?:)?\/\//);
    // Amended by D255: besides the canonical address, only the hreflang links
    // name an absolute address, and only on this site.
    assert.doesNotMatch(
      template,
      /<link rel="(?!canonical"|alternate" hreflang="[^"]+" href="https:\/\/qa-tools\.ru\/)[^"]*"[^>]*href="(?:https?:)?\/\//,
    );
  });

  it('names its Russian twin for search engines, and itself as the default (D255)', () => {
    assert.deepEqual(hreflang(template), ABOUT_HREFLANG);
    assert.deepEqual(ABOUT_HREFLANG, [
      ['en', 'https://qa-tools.ru/about'],
      ['ru', 'https://qa-tools.ru/ru/about'],
      ['x-default', 'https://qa-tools.ru/about'],
    ]);
    assert.match(template, /^<!doctype html>\n<html lang="en">\n/);
    // Nothing else of the template changed: it is 1.12.1's with the three links.
    assert.equal(
      createHash('sha256')
        .update(
          template.replace(/ {4}<link rel="alternate" hreflang="[^"]+" href="[^"]+" \/>\n/g, ''),
        )
        .digest('hex'),
      ENGLISH_TEMPLATE_BEFORE,
    );
  });

  it('is where the body goes, and nowhere else', () => {
    assert.equal(template.split(ABOUT_PLACEHOLDER).length - 1, 1);
    assert.ok(page.includes(body));
    assert.ok(!page.includes(ABOUT_PLACEHOLDER));
    assert.throws(() => renderAboutPage('<body></body>'), /no <!-- about:page -->/);
  });

  it('brings Inter and the shared header and footer styles, and puts each label above its lines on a phone', () => {
    const css = read('../about/about.css');
    const phone = css.slice(css.indexOf('@media (max-width: 767.98px) {'));

    for (const weight of [400, 500, 600]) {
      assert.ok(css.includes(`@import '@fontsource/inter/${weight}.css';`), `${weight}`);
    }

    assert.ok(css.includes("@import '../static-pages/site-chrome.css';"));
    assert.match(phone, /\.fact \{\n\s*display: block;\n\s*\}/);
    assert.match(css, /\.story \{\n\s*display: flex;\n\s*max-width: 680px;/);
    assert.match(css, /\.fact dt \{\n\s*width: 160px;/);
  });

  it('gives the Russian labels a 180 px rail from 768 px, and the English its 160 px (D255)', () => {
    const css = read('../about/about.css');

    assert.match(
      css,
      /@media \(min-width: 768px\) \{\n\s*:lang\(ru\) \.fact dt \{\n\s*width: 180px;\n\s*\}\n\}/,
    );
    // The one rule that reads the language; the phone's labels stay above their lines.
    assert.equal(css.split(':lang(').length - 1, 1);
    assert.ok(css.indexOf(':lang(ru)') < css.indexOf('@media (max-width: 767.98px) {'));
  });
});

describe('the Russian template (D255)', () => {
  const head = /<head>([\s\S]*?)<\/head>/.exec(russianTemplate)?.[1] ?? '';

  it('is in Russian, names and describes the page, and points search engines at its address', () => {
    assert.match(russianTemplate, /^<!doctype html>\n<html lang="ru">\n/);
    assert.ok(head.includes(`<title>${ABOUT_RU.title}</title>`));
    assert.match(
      head,
      new RegExp(`<meta\\s+name="description"\\s+content="${ABOUT_RU.description}"\\s*/>`),
    );
    assert.equal(head.split('rel="canonical"').length - 1, 1);
    assert.ok(head.includes(`<link rel="canonical" href="${ABOUT_RU.url}" />`));
    assert.doesNotMatch(russianTemplate, /noindex/i);
  });

  it('names the English page and itself for search engines, the English the default', () => {
    assert.deepEqual(hreflang(russianTemplate), ABOUT_HREFLANG);
    assert.deepEqual(hreflang(russianTemplate), hreflang(template));
  });

  it('loads the English page\u2019s stylesheet and nothing else: no script, nothing from another origin', () => {
    assert.ok(head.includes('<link rel="stylesheet" href="/src/about/about.css" />'));
    assert.doesNotMatch(russianTemplate, /<script\b/);
    assert.doesNotMatch(russianTemplate, /src="(?:https?:)?\/\//);
    assert.doesNotMatch(
      russianTemplate,
      /<link rel="(?!canonical"|alternate" hreflang="[^"]+" href="https:\/\/qa-tools\.ru\/)[^"]*"[^>]*href="(?:https?:)?\/\//,
    );
  });

  it('is the English template in all but its language, its words and its address', () => {
    assert.equal(
      russianTemplate
        .replace('<html lang="ru">', '<html lang="en">')
        .replace(`<title>${ABOUT_RU.title}</title>`, `<title>${ABOUT_TITLE}</title>`)
        .replace(`content="${ABOUT_RU.description}"`, `content="${ABOUT_DESCRIPTION}"`)
        .replace(
          `<link rel="canonical" href="${ABOUT_RU.url}" />`,
          `<link rel="canonical" href="${ABOUT_URL}" />`,
        ),
      template,
    );
  });

  it('is where the body goes, and nowhere else', () => {
    assert.equal(russianTemplate.split(ABOUT_PLACEHOLDER).length - 1, 1);
    assert.ok(russianPage.includes(russianBody));
    assert.ok(!russianPage.includes(ABOUT_PLACEHOLDER));
  });
});

describe('which page a template is', () => {
  it('writes /about into about/index.html and /ru/about into ru/about/index.html', () => {
    assert.deepEqual(ABOUT_PAGES, [ABOUT_EN, ABOUT_RU]);
    assert.equal(aboutTemplate(ABOUT_EN), ABOUT_PAGE);
    assert.equal(aboutTemplate(ABOUT_RU), RUSSIAN_ABOUT_PAGE);
    assert.equal(RUSSIAN_ABOUT_PAGE, 'ru/about/index.html');
  });

  it('tells the two apart though one name ends the other, and leaves every other page alone', () => {
    assert.equal(aboutPageOf('/about/index.html'), ABOUT_EN);
    assert.equal(aboutPageOf('/ru/about/index.html'), ABOUT_RU);
    // A build may give the path under a longer root; the end decides.
    assert.equal(aboutPageOf('/x/ru/about/index.html'), ABOUT_RU);

    for (const path of [
      '/index.html',
      '/ru/index.html',
      '/terms/index.html',
      '/about',
      '/ru/about',
      '/ru/about/index.htm',
      '/RU/about/index.html',
      '/xru/about/index.html',
      '',
    ]) {
      assert.notEqual(aboutPageOf(path), ABOUT_RU, path);
    }

    for (const path of [
      '/index.html',
      '/ru/index.html',
      '/terms/index.html',
      '/about',
      '',
      '/ru/about',
    ]) {
      assert.equal(aboutPageOf(path), undefined, path);
    }
  });

  it('reads hostile paths at growing sizes in time, and writes nothing for them', () => {
    for (const size of [1, 1_000, 100_000]) {
      const started = performance.now();

      assert.equal(aboutPageOf(`${'/ru'.repeat(size)}/about/index.html`), ABOUT_RU, `${size}`);
      assert.equal(aboutPageOf(`/about/index.html${'/'.repeat(size)}`), undefined, `${size}`);
      assert.equal(aboutPageOf(`${'/ru/about/index.html'.repeat(size)}x`), undefined, `${size}`);
      assert.equal(aboutPageOf(`<script>${'\u00a0'.repeat(size)}/about/index.html`), ABOUT_EN);
      assert.ok(performance.now() - started < 1_000, `${size}`);
    }

    // The plugin writes a page only for its own templates.
    const plugin = aboutPagePluginHandler();

    assert.equal(plugin(template, '/about/index.html'), page);
    assert.equal(plugin(russianTemplate, '/ru/about/index.html'), russianPage);
    assert.equal(plugin(russianTemplate, '/ru/index.html'), russianTemplate);
    assert.equal(plugin('<!-- about:page -->', '/terms/index.html'), '<!-- about:page -->');
  });
});

/** One exact location block of nginx.conf, comments and blank lines removed. */
function location(target: string): string {
  const config = read('../../nginx.conf');
  const escaped = target.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const block = new RegExp(`^\\s*location = ${escaped} \\{\\n([\\s\\S]*?)^\\s*\\}$`, 'm').exec(
    config,
  )?.[1];

  assert.ok(block !== undefined, `nginx.conf has no exact location for ${target}`);

  return block
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

const BLOCK_PUNCTUATION = new Set(['{', '}', ';']);

/**
 * The argument of every `location` directive in an nginx config, in order:
 * its words between `location` and the `{` that opens its block, joined by
 * one space, a quoted pattern kept whole with its quotes. The config is read
 * as nginx reads it: `#` at the start of a word comments out the rest of the
 * line; a quoted word ends only at its closing quote, so the braces inside
 * `"^/v/[A-Za-z0-9_-]{43}/?\z"` open no block; any other word ends at a space,
 * `;` or a `{` that does not follow `$`, a backslash escaping the character
 * after it, so `}` inside a word is part of it; a directive starts after `{`,
 * `}` or `;`, wherever the lines break.
 */
function locationArguments(config: string): string[] {
  const words: string[] = [];
  let index = 0;

  while (index < config.length) {
    const char = config.charAt(index);

    if (/\s/.test(char)) {
      index += 1;
    } else if (char === '#') {
      const end = config.indexOf('\n', index);
      index = end === -1 ? config.length : end;
    } else if (BLOCK_PUNCTUATION.has(char)) {
      words.push(char);
      index += 1;
    } else {
      const quote = char === '"' || char === "'" ? char : undefined;
      let end = quote === undefined ? index : index + 1;

      while (end < config.length) {
        const next = config.charAt(end);
        const ends =
          quote === undefined
            ? /\s/.test(next) || next === ';' || (next === '{' && config.charAt(end - 1) !== '$')
            : next === quote;
        if (ends) {
          break;
        }
        end += next === '\\' ? 2 : 1;
      }

      end = Math.min(config.length, quote === undefined ? end : end + 1);
      words.push(config.slice(index, end));
      index = end;
    }
  }

  const found: string[] = [];

  words.forEach((word, at) => {
    if (word !== 'location' || (at > 0 && !BLOCK_PUNCTUATION.has(words[at - 1] ?? ''))) {
      return;
    }

    let end = at + 1;
    while (end < words.length && !BLOCK_PUNCTUATION.has(words[end] ?? '{')) {
      end += 1;
    }
    found.push(words.slice(at + 1, end).join(' '));
  });

  return found;
}

/** The location arguments of a config that name the about page, in any case. */
const aboutLocations = (config: string) =>
  locationArguments(config).filter((argument) => /about/i.test(argument));

/** The only locations that may name the page: the two addresses and the file, in each language. */
const ABOUT_LOCATIONS = [
  '= /about',
  '= /about/',
  '= /about/index.html',
  '= /ru/about',
  '= /ru/about/',
  '= /ru/about/index.html',
];

/**
 * Locations each of which would serve the page for more than its exact
 * addresses - `/ru/about.html`, `/ru/aboutX`, `/ru/about/x` - and none of
 * which the check may let through: a prefix, a prefix that stops the regex
 * search, a regex either way of case, an anchored regex and a quoted one.
 */
const LOOSER_ABOUT_LOCATIONS = ['/ru/about', '/about'].flatMap((address) => [
  address,
  `^~ ${address}`,
  `~* ${address}`,
  `~ ^${address}`,
  `~ "^${address}"`,
]);

describe('the reading of nginx.conf the about check rests on', () => {
  it('reads a quoted pattern whole, the braces inside it included, in either quote', () => {
    assert.deepEqual(
      locationArguments(
        [
          'location ~ "^/v/[A-Za-z0-9_-]{43}/?\\z" {',
          '}',
          'location ~ "^/[a-z]{2}/about" { }',
          "location ~* '^/ru/about{1}$' { }",
          'location ~ "^/a\\"{1}/about" { }',
          'location ~ "^/ru/about;#}" { }',
        ].join('\n'),
      ),
      [
        '~ "^/v/[A-Za-z0-9_-]{43}/?\\z"',
        '~ "^/[a-z]{2}/about"',
        "~* '^/ru/about{1}$'",
        '~ "^/a\\"{1}/about"',
        '~ "^/ru/about;#}"',
      ],
    );
  });

  it('finds a location wherever its lines break and however its words are spaced', () => {
    assert.deepEqual(
      locationArguments(
        [
          'location /ru/about',
          '{ }',
          'location /ru/about{ }',
          'location\t^~\t/RU/About\t{ }',
          'location   ~   ^/ru/about   { }',
          'location /x { location /ru/about { } } location = /about { }',
          'server { listen 80; location ~ ^/ru/about\\{ { } }',
          'location /x}about { }',
          'location ~ ^/x${y}/about { }',
        ].join('\n'),
      ),
      [
        '/ru/about',
        '/ru/about',
        '^~ /RU/About',
        '~ ^/ru/about',
        '/x',
        '/ru/about',
        '= /about',
        '~ ^/ru/about\\{',
        '/x}about',
        '~ ^/x${y}/about',
      ],
    );
  });

  it('skips comments and words that only look like a location', () => {
    assert.deepEqual(
      locationArguments(
        [
          '# location /ru/about {',
          '#location /ru/about {',
          '    # the old location /about { rewrite ^ /x; }',
          'location = /terms { # like /about {',
          '}',
          'add_header X-Note "location /ru/about {";',
          "return 200 'location /about { ';",
          'set $where location;',
          'location_about /about { }',
          'map $uri $page { /about location; }',
        ].join('\n'),
      ),
      ['= /terms'],
    );
  });

  it('reads configs of growing size, many locations, long words and an unclosed quote', () => {
    for (const size of [1, 100, 10_000]) {
      const many = Array.from(
        { length: size },
        (_, i) => `    # page ${i}\n    location = /p${i} {\n        return 204;\n    }\n`,
      ).join('');
      const found = locationArguments(`server {\n${many}    location ~ "^/ru/about" { }\n}\n`);

      assert.equal(found.length, size + 1);
      assert.equal(found[size - 1], `= /p${size - 1}`);
      assert.deepEqual(aboutLocations(`server {\n${many}}\n`), []);
      assert.equal(found.at(-1), '~ "^/ru/about"');

      const long = `~ "^/${'{'.repeat(size * 10)}${'a'.repeat(size * 10)}/about"`;
      assert.deepEqual(locationArguments(`location ${long} { }`), [long]);
      assert.deepEqual(locationArguments(`location ~ "${'x\\'.repeat(size * 10)}`), [
        `~ "${'x\\'.repeat(size * 10)}`,
      ]);
      assert.deepEqual(locationArguments(`${'#'.repeat(size * 10)} location /about {\n`), []);
      assert.deepEqual(locationArguments(`location ${'/about'.repeat(size * 10)}`), [
        '/about'.repeat(size * 10),
      ]);
    }
  });
});

describe('the about locations in nginx.conf', () => {
  it('serve the page for /about and /about/, never the application shell', () => {
    for (const address of ['/about', '/about/']) {
      assert.equal(location(address), 'rewrite ^ /about/index.html last;');
    }
  });

  it('revalidate the page on every use, send no X-Robots-Tag, and refuse it by name', () => {
    assert.equal(
      location('/about/index.html'),
      [
        'internal;',
        "add_header Cache-Control 'no-cache' always;",
        'error_page 404 /index.html;',
      ].join('\n'),
    );
  });

  it('serve the Russian page for /ru/about and /ru/about/ the same way, and refuse it by name (D255)', () => {
    for (const address of ['/ru/about', '/ru/about/']) {
      assert.equal(location(address), 'rewrite ^ /ru/about/index.html last;');
    }

    assert.equal(location('/ru/about/index.html'), location('/about/index.html'));
  });

  it('leave every other shape of the address to `location /`, which answers 404 with the application', () => {
    const config = read('../../nginx.conf');

    // Every location that names the page, in any case and of any kind, is
    // one of the two exact addresses or the internal file of a language:
    // /RU/about, /ru/about.html, /ru/aboutX and /ru/about/x match none of
    // them. nginx merges slashes and decodes the path before it matches, so
    // /ru//about and /r%75/about are /ru/about.
    assert.deepEqual(aboutLocations(config), ABOUT_LOCATIONS);
    assert.doesNotMatch(config, /merge_slashes off/);
    assert.match(
      config,
      /location \/ \{\n\s*try_files \$uri =404;\n\s*error_page 404 \/index\.html;/,
    );
    // No negotiation by language anywhere: /about is English whatever is asked.
    assert.doesNotMatch(config.replace(/#.*$/gm, ''), /accept_language|accept-language|\$lang/i);
  });

  it('fail that check on a config with any other location naming the page, or an exact one loosened', () => {
    const config = read('../../nginx.conf');
    const fallback = '    location / {\n';

    assert.equal(config.split(fallback).length, 2, 'nginx.conf has one `location /`');

    for (const argument of LOOSER_ABOUT_LOCATIONS) {
      // After the session's quoted pattern, whose braces must not hide it.
      const added = config.replace(
        fallback,
        `    location ${argument} {\n        rewrite ^ /about/index.html last;\n    }\n\n${fallback}`,
      );

      assert.ok(added.includes(`\n    location ${argument} {\n`), argument);
      assert.notDeepEqual(aboutLocations(added), ABOUT_LOCATIONS, argument);
      assert.ok(aboutLocations(added).includes(argument), argument);
    }

    for (const exact of ABOUT_LOCATIONS) {
      const target = exact.slice('= '.length);
      const loosened = config.replace(`location ${exact} {`, `location ${target} {`);

      assert.notEqual(loosened, config, exact);
      assert.notDeepEqual(aboutLocations(loosened), ABOUT_LOCATIONS, exact);
    }
  });
});

describe('the dev server and the build', () => {
  it('serve /about and /about/ from the same module as the build', () => {
    const config = read('../../vite.config.ts');

    assert.ok(config.includes("path === '/about' || path === '/about/'"));
    assert.ok(config.includes("req.url = '/about/index.html';"));
    assert.match(config, /plugins: \[[^\]]*aboutPagePlugin\(\)/);
  });

  it('serve /ru/about and /ru/about/ the same way, before /ru/ is looked at (D255)', () => {
    const config = read('../../vite.config.ts');

    assert.match(
      config,
      /if \(path === '\/ru\/about' \|\| path === '\/ru\/about\/'\) \{\n\s*req\.url = '\/ru\/about\/index\.html';\n\s*res\.setHeader\('Cache-Control', 'no-cache'\);\n\s*next\(\);\n\s*return;\n\s*\}/,
    );
  });

  it('builds the page in npm run build, as a build of its own, before the build check', () => {
    const build = JSON.parse(read('../../package.json')).scripts.build as string;
    const config = read('../../vite.about.config.ts');

    assert.ok(build.includes('vite build --config vite.about.config.ts'));
    assert.ok(build.indexOf('vite.about.config.ts') < build.indexOf('check-build.mjs'));
    // Amended by D255: the Russian page is a second input of the same build.
    assert.match(
      config,
      /input: \{\n\s*about: fileURLToPath\(new URL\('about\/index\.html', import\.meta\.url\)\),\n\s*'ru-about': fileURLToPath\(new URL\('ru\/about\/index\.html', import\.meta\.url\)\),\n\s*\}/,
    );
    // Amended by D274: and the plugin that names the build's origins, last.
    assert.match(config, /plugins: \[aboutPagePlugin\(\), siteOriginPlugin\(\)\]/);
    assert.equal(ABOUT_PAGE, 'about/index.html');
  });

  it('name another address throughout both pages of a build for it, and no address of production’s (D274)', () => {
    // What that last plugin makes of each page in a build for the copy (#354).
    const named = siteOriginPlugin(ANOTHER).transformIndexHtml.handler;

    for (const [html, address] of [
      [named(page), `${ANOTHER.app}/about`],
      [named(russianPage), `${ANOTHER.app}/ru/about`],
    ] as const) {
      assert.equal(html.split('rel="canonical"').length - 1, 1, address);
      assert.ok(html.includes(`<link rel="canonical" href="${address}" />`), address);
      assert.deepEqual(
        hreflang(html),
        [
          ['en', `${ANOTHER.app}/about`],
          ['ru', `${ANOTHER.app}/ru/about`],
          ['x-default', `${ANOTHER.app}/about`],
        ],
        address,
      );
      assert.ok(html.includes(`<code>${ANOTHER.app}/mcp</code>`), address);
      assert.deepEqual(productionNamesLeft(html, ANOTHER), [], address);
    }
  });
});

describe('the build check', () => {
  function problems(files: Record<string, string>): string[] {
    const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-dist-'));

    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dist, name)), { recursive: true });
      writeFileSync(join(dist, name), text);
    }

    try {
      return (checkBuild(dist) as string[]).filter((problem) => /about/.test(problem));
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  }

  /** The page as the build writes it, its stylesheet a hashed file. */
  const built = (html = page) =>
    html.replace(
      '<link rel="stylesheet" href="/src/about/about.css" />',
      '<link rel="stylesheet" crossorigin href="/assets/about-EEEEEEEE.css">',
    );

  /**
   * Both pages as the build writes them (amended by D255: a build without
   * the Russian page is refused, so each case below carries it).
   */
  const both = (files: Record<string, string> = {}) => ({
    'about/index.html': built(),
    'ru/about/index.html': built(russianPage),
    'assets/about-EEEEEEEE.css': 'body{}',
    ...files,
  });

  it('passes the page as the build writes it', () => {
    assert.deepEqual(problems(both()), []);
    assert.deepEqual(aboutPageProblems(built()), []);
    assert.deepEqual(aboutPageProblems(built(russianPage), ABOUT_RU), []);
  });

  it('fails when the page is missing', () => {
    /** Both pages but the one named. */
    const without = (file: string) =>
      Object.fromEntries(Object.entries(both()).filter(([name]) => name !== file));
    const russianOnly = without('about/index.html');
    const englishOnly = without('ru/about/index.html');

    assert.deepEqual(problems(russianOnly), ['the about page about/index.html was not built']);
    assert.deepEqual(problems(englishOnly), [
      'the Russian about page ru/about/index.html was not built',
    ]);
    assert.deepEqual(problems({}), [
      'the about page about/index.html was not built',
      'the Russian about page ru/about/index.html was not built',
    ]);
  });

  it('fails when the page lacks its title, its body, or asks not to be indexed', () => {
    assert.deepEqual(
      problems(
        both({
          'about/index.html': built().replace('<title>About QA Tools</title>', '<title>QA</title>'),
        }),
      ),
      ['the about page about/index.html has no <title>About QA Tools</title>'],
    );
    assert.deepEqual(aboutPageProblems(built(template)), [
      'the about page about/index.html has no body',
    ]);
    assert.deepEqual(
      aboutPageProblems(
        built().replace('<head>', '<head><meta name="robots" content="noindex" />'),
      ),
      ['the about page about/index.html asks search engines not to index it'],
    );
  });

  it('fails a page in the wrong language, under another address, or without the hreflang pair (D255)', () => {
    const russian = built(russianPage);
    const named = 'the Russian about page ru/about/index.html';

    for (const [html, problem] of [
      [
        russian.replace('<title>О QA Tools</title>', ''),
        `${named} has no <title>О QA Tools</title>`,
      ],
      [russian.replace('<html lang="ru">', '<html lang="en">'), `${named} is not <html lang="ru">`],
      // The English page answered at the Russian address.
      [built(), `${named} has no <title>О QA Tools</title>`],
      [
        russian.replace(
          '<link rel="canonical" href="https://qa-tools.ru/ru/about" />',
          '<link rel="canonical" href="https://qa-tools.ru/about" />',
        ),
        `${named} does not have the one canonical https://qa-tools.ru/ru/about`,
      ],
      [
        russian.replace(
          '<link rel="canonical" href="https://qa-tools.ru/ru/about" />',
          '<link rel="canonical" href="https://qa-tools.ru/ru/about" /><link rel="canonical" href="https://qa-tools.ru/ru/about" />',
        ),
        `${named} does not have the one canonical https://qa-tools.ru/ru/about`,
      ],
      [
        russian.replace(
          '<link rel="alternate" hreflang="x-default" href="https://qa-tools.ru/about" />',
          '',
        ),
        `${named} does not carry the hreflang set of both about pages`,
      ],
      [
        russian.replace(
          'hreflang="ru" href="https://qa-tools.ru/ru/about"',
          'hreflang="ru" href="/ru/about"',
        ),
        `${named} does not carry the hreflang set of both about pages`,
      ],
      [
        russian.replace('<head>', '<head><meta name="robots" content="noindex" />'),
        `${named} asks search engines not to index it`,
      ],
    ] as const) {
      assert.ok(aboutPageProblems(html, ABOUT_RU).includes(problem), problem);
      assert.ok(problems(both({ 'ru/about/index.html': html })).includes(problem), problem);
    }

    // The English page without its pair, or with the Russian address as its own.
    assert.deepEqual(
      aboutPageProblems(built().replace(/<link rel="alternate" hreflang="ru"[^>]*>/, '')),
      ['the about page about/index.html does not carry the hreflang set of both about pages'],
    );
    assert.deepEqual(
      aboutPageProblems(
        built().replace(
          '<link rel="canonical" href="https://qa-tools.ru/about" />',
          '<link rel="canonical" href="https://qa-tools.ru/ru/about" />',
        ),
      ),
      ['the about page about/index.html does not have the one canonical https://qa-tools.ru/about'],
    );
  });
});
