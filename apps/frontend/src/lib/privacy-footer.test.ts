import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { SESSION_IDLE_DAYS } from '@webhook-inspector/shared';
import { renderAboutBody } from '../../scripts/about.mjs';
import { readChangelog, renderChangelogBody } from '../../scripts/changelog.mjs';
import { renderLegalBody } from '../../scripts/legal.mjs';
import { siteFooter } from '../../scripts/site-chrome.mjs';
import { en } from '../i18n/en.ts';
import { ru } from '../i18n/ru.ts';
import { ABOUT_RU } from './about-copy-ru.ts';
import { ABOUT_LINK } from './about-link.ts';
import { CHANGELOG_LINK } from './changelog-link.ts';
import { CONTACT_ADDRESS, CONTACT_MAILTO } from './contact.ts';
import { privacyPage, termsPage } from './legal-copy.ts';
import { PRIVACY_LINK, TERMS_LINK } from './legal-links.ts';
import { NO_OPERATOR, parseOperator } from './operator.ts';
import {
  FOOTER_LINKS,
  FOOTER_SEPARATOR,
  footerLine,
  footerLinks,
  footerText,
  PRIVACY_FOOTER,
  PRIVACY_FOOTER_TEXT,
} from './privacy-footer.ts';
import { PRODUCTION_OPERATOR } from '../testing/production-operator.ts';

/** The two pages as production's build writes them (issue #369). */
const TERMS_PAGE = termsPage(PRODUCTION_OPERATOR);
const PRIVACY_PAGE = privacyPage(PRODUCTION_OPERATOR);

/**
 * The footer every page carries (issue #88, D177), with `About` before
 * `Contact:` since issue #131 (D211) and `Terms` and `Privacy` after it since
 * issue #112 (D217). The wording was approved in Figma, so it is
 * pinned byte for byte, no-break spaces and dashes included; its two numbers
 * are held to the rules that make them true; and both footers - the
 * application's component and the static pages' HTML - are read to show that
 * each page renders it, that each link leads to its page and that the address
 * is a `mailto:` link. `e2e/standard-session.spec.ts`, `e2e/about.spec.ts`
 * and `e2e/legal.spec.ts` check it rendered.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const NBSP = '\u00a0';

/** The footer's line as `AppFooter.tsx` draws it: the build's operator's (issue #396). */
const FOOTER_LINE_ELEMENT = '<span>{footerLine(m, operator)}</span>';

describe('the privacy footer', () => {
  it('says what the owner approved, byte for byte', () => {
    // The line itself, D177's, its words amended on 2026-10-25
    // (Decision 1, variant B; issue #274, D265).
    assert.equal(
      PRIVACY_FOOTER.line,
      'Captured requests \u2014 headers, body and the sender\u0027s IP \u2014 are kept until you ' +
        'delete them or the session expires, at most 7\u00a0days unused; backups keep them up ' +
        'to 3\u00a0days longer.',
    );
    // The Russian line, D222's, amended with it: the application's band in
    // Russian and /ru/about draw it.
    assert.equal(
      ru.footer.line,
      'Запросы \u2014 заголовки, тело и IP отправителя \u2014 хранятся, пока вы их не удалите ' +
        'или сессия не истечёт (до 7\u00a0дней простоя); в копиях \u2014 ещё до 3\u00a0дней.',
    );
    // The whole footer as it reads below 1024 px, `About · Terms · Privacy`
    // before `Contact:` (D211, D217; frames F1–F3).
    assert.equal(
      PRIVACY_FOOTER_TEXT,
      'Captured requests \u2014 headers, body and the sender\u0027s IP \u2014 are kept until you ' +
        'delete them or the session expires, at most 7\u00a0days unused; backups keep them up ' +
        'to 3\u00a0days longer. About \u00b7 Terms \u00b7 Privacy \u00b7 Contact:\u00a0contact@qa-tools.ru',
    );
    assert.equal(PRIVACY_FOOTER.contactLabel, 'Contact:');
    assert.equal(PRIVACY_FOOTER.address, 'contact@qa-tools.ru');
    assert.equal(FOOTER_SEPARATOR, ' \u00b7 ');
    assert.equal(
      PRIVACY_FOOTER_TEXT,
      `${PRIVACY_FOOTER.line} About${FOOTER_SEPARATOR}Terms${FOOTER_SEPARATOR}Privacy${FOOTER_SEPARATOR}${PRIVACY_FOOTER.contactLabel}${NBSP}${PRIVACY_FOOTER.address}`,
    );
  });

  it('ends after the session’s 7 days without the operator’s texts, in both languages, and is D265’s with production’s (issue #396)', () => {
    // A copy built without OPERATOR_TEXTS: D265's words to the semicolon,
    // then a full stop (Decision 2), byte for byte.
    const english =
      'Captured requests \u2014 headers, body and the sender\u0027s IP \u2014 are kept until you ' +
      'delete them or the session expires, at most 7\u00a0days unused.';
    const russian =
      'Запросы \u2014 заголовки, тело и IP отправителя \u2014 хранятся, пока вы их не удалите ' +
      'или сессия не истечёт (до 7\u00a0дней простоя).';
    // A copy with every other detail of its own still has no texts.
    const copyWithDetails = parseOperator({
      STATUS_PAGE_URL: 'https://status.inspector.example/',
      CONTACT_EMAIL: 'hello@inspector.example',
    });

    for (const operator of [NO_OPERATOR, copyWithDetails]) {
      assert.equal(footerLine(en, operator), english);
      assert.equal(footerLine(ru, operator), russian);
      assert.equal(footerLine(undefined, operator), english);
      assert.ok(footerText(en, operator).startsWith(`${english} About`));
      assert.ok(footerText(ru, operator).startsWith(`${russian} О сервисе`));
    }
    assert.equal(en.footer.lineWithoutBackups, english);
    assert.equal(ru.footer.lineWithoutBackups, russian);

    // Production's settings: D265's lines, byte for byte, as the build draws them.
    assert.equal(
      footerLine(en, PRODUCTION_OPERATOR),
      'Captured requests \u2014 headers, body and the sender\u0027s IP \u2014 are kept until you ' +
        'delete them or the session expires, at most 7\u00a0days unused; backups keep them up ' +
        'to 3\u00a0days longer.',
    );
    assert.equal(
      footerLine(ru, PRODUCTION_OPERATOR),
      'Запросы \u2014 заголовки, тело и IP отправителя \u2014 хранятся, пока вы их не удалите ' +
        'или сессия не истечёт (до 7\u00a0дней простоя); в копиях \u2014 ещё до 3\u00a0дней.',
    );
    assert.equal(footerLine(), PRIVACY_FOOTER.line);
    assert.equal(PRIVACY_FOOTER.line, en.footer.line);

    // No other word changes: the approved line cut at its semicolon.
    for (const m of [en, ru]) {
      assert.equal(
        m.footer.lineWithoutBackups,
        `${m.footer.line.slice(0, m.footer.line.indexOf(';'))}.`,
        m.lang,
      );
      assert.equal(m.footer.line.split(';').length, 2, m.lang);
    }
    // The number keeps its no-break space, and no other is added.
    assert.deepEqual(
      [...english.matchAll(/\S+\u00a0\S+/g)].map((match) => match[0]),
      ['7\u00a0days'],
    );
    assert.deepEqual(
      [...russian.matchAll(/\S+\u00a0\S+/g)].map((match) => match[0]),
      ['7\u00a0дней'],
    );
  });

  it('draws the copy’s line on every static page, in English and on /ru/about, with the band otherwise as the copy’s (issue #396)', () => {
    const lineOf = (footer: string) =>
      /<footer class="site-footer">\n {2}<p><span>([^<]*)<\/span>/.exec(footer)?.[1];

    for (const page of [CHANGELOG_LINK.href, ABOUT_LINK.href, TERMS_LINK.href, PRIVACY_LINK.href]) {
      assert.equal(lineOf(siteFooter(page, 'en', NO_OPERATOR)), en.footer.lineWithoutBackups, page);
      assert.equal(lineOf(siteFooter(page)), en.footer.line, page);
    }
    assert.equal(
      lineOf(siteFooter(ABOUT_RU.path, 'ru', NO_OPERATOR)),
      ru.footer.lineWithoutBackups,
    );
    assert.equal(lineOf(siteFooter(ABOUT_RU.path, 'ru')), ru.footer.line);
    // The application's band draws the build's line, read from its source
    // here and rendered for both operators in operator.test.ts.
    assert.ok(read('../components/AppFooter.tsx').includes(FOOTER_LINE_ELEMENT));
  });

  it('links About, Terms and Privacy to their pages, in that order, before Contact: (D211, D217)', () => {
    assert.deepEqual(FOOTER_LINKS, [ABOUT_LINK, TERMS_LINK, PRIVACY_LINK]);
    assert.deepEqual(ABOUT_LINK, { href: '/about', label: 'About' });
    assert.deepEqual(TERMS_LINK, { href: '/terms', label: 'Terms' });
    assert.deepEqual(PRIVACY_LINK, { href: '/privacy', label: 'Privacy' });
    // Each leads to the page that names itself so.
    assert.equal(TERMS_LINK.href, TERMS_PAGE.path);
    assert.equal(PRIVACY_LINK.href, PRIVACY_PAGE.path);

    // Pages of this site in the same tab, as Changelog in the header.
    for (const link of FOOTER_LINKS) {
      assert.ok(!('target' in link), link.label);
    }
  });

  it('leads About to the about page of the language shown, and Terms and Privacy to the English pages (D255)', () => {
    // English: the links themselves, so nothing English changes.
    assert.deepEqual(
      footerLinks(en),
      [...FOOTER_LINKS].map((link) => ({ ...link })),
    );
    assert.deepEqual(footerLinks(), footerLinks(en));
    // Russian: the band's words, О сервисе to /ru/about; Условия and
    // Конфиденциальность keep /terms and /privacy until their issue (#237).
    assert.deepEqual(footerLinks(ru), [
      { href: '/ru/about', label: 'О сервисе' },
      { href: '/terms', label: 'Условия' },
      { href: '/privacy', label: 'Конфиденциальность' },
    ]);
    assert.equal(footerLinks(ru)[0]?.href, ABOUT_RU.path);
    // A dictionary of another language would lead to the English page.
    assert.equal(footerLinks({ ...en, lang: 'de' })[0]?.href, '/about');
  });

  it('keeps each number with its unit and the address with `Contact:`, and nothing else', () => {
    assert.deepEqual(
      [...PRIVACY_FOOTER_TEXT.matchAll(/\S+\u00a0\S+/g)].map((match) => match[0]),
      ['7\u00a0days', '3\u00a0days', 'Contact:\u00a0contact@qa-tools.ru'],
    );
    assert.doesNotMatch(PRIVACY_FOOTER_TEXT, /\d days/, 'a number is joined by a plain space');
    assert.deepEqual(
      [...ru.footer.line.matchAll(/\S+\u00a0\S+/g)].map((match) => match[0]),
      ['7\u00a0дней', '3\u00a0дней.'],
    );
    assert.doesNotMatch(ru.footer.line, /\d дн/, 'a number is joined by a plain space');
  });

  it('links the address as mail', () => {
    assert.equal(PRIVACY_FOOTER.href, 'mailto:contact@qa-tools.ru');
    assert.equal(PRIVACY_FOOTER.href, CONTACT_MAILTO);
    assert.equal(PRIVACY_FOOTER.address, CONTACT_ADDRESS);
  });

  it('states the longest idle window the backend enforces, as the most a session lives unused (D133, D242, D265)', () => {
    assert.ok(
      PRIVACY_FOOTER.line.includes(`at most ${SESSION_IDLE_DAYS}${NBSP}days unused;`),
      `the line does not say ${SESSION_IDLE_DAYS} days`,
    );
    assert.ok(
      ru.footer.line.includes(`(до ${SESSION_IDLE_DAYS}${NBSP}дней простоя);`),
      `the Russian line does not say ${SESSION_IDLE_DAYS} days`,
    );
    // And so does a copy's, which ends there (issue #396).
    assert.ok(
      en.footer.lineWithoutBackups.endsWith(`at most ${SESSION_IDLE_DAYS}${NBSP}days unused.`),
      `the copy's line does not say ${SESSION_IDLE_DAYS} days`,
    );
    assert.ok(
      ru.footer.lineWithoutBackups.endsWith(`(до ${SESSION_IDLE_DAYS}${NBSP}дней простоя).`),
      `the copy's Russian line does not say ${SESSION_IDLE_DAYS} days`,
    );
  });

  it('states the number of nightly dumps the chart keeps (D176)', () => {
    const values = read('../../../../deploy/helm/qa-tools/values.yaml');
    const keep = /^backup:\n[\s\S]*?^ {2}keep: (\d+)$/m.exec(values)?.[1];

    assert.ok(keep !== undefined, 'values.yaml has no backup.keep');
    assert.ok(
      PRIVACY_FOOTER.line.includes(`backups keep them up to ${keep}${NBSP}days longer.`),
      `backup.keep is ${keep}, and the line says otherwise`,
    );
    assert.ok(
      ru.footer.line.endsWith(`в копиях — ещё до ${keep}${NBSP}дней.`),
      `backup.keep is ${keep}, and the Russian line says otherwise`,
    );
  });

  it('is the contact the API description publishes, which /docs shows', () => {
    const openapi = JSON.parse(read('../../../../packages/shared/openapi.json')) as {
      info: { contact?: unknown };
    };

    assert.deepEqual(openapi.info.contact, { name: 'QA Tools', email: CONTACT_ADDRESS });
  });

  it('is what the shared footer renders, the address a link to it', () => {
    const footer = read('../components/AppFooter.tsx');

    assert.ok(footer.includes('<footer'));
    // The words are the interface's language's, `m.footer` (D222), whose
    // English the constants hold: the line the build's operator draws (issue
    // #396).
    assert.ok(footer.includes(FOOTER_LINE_ELEMENT));
    assert.ok(footer.includes('{m.footer.contact}'));
    assert.equal(PRIVACY_FOOTER.line, en.footer.line);
    assert.equal(PRIVACY_FOOTER.contactLabel, en.footer.contact);
    assert.ok(footer.includes("{'\\u00a0'}"), 'Contact: is not joined to the address');
    // The build's address (issue #369), the one `PRIVACY_FOOTER` holds.
    assert.ok(footer.includes('const contact = operator.contactEmail;'));
    assert.ok(footer.includes('operator = OPERATOR,'));
    assert.match(footer, /<a\n\s*href=\{mailtoOf\(contact\)\}\n[^>]*>\n\s*\{contact\}\n\s*<\/a>/);
    // The address breaks at its hyphen, and the links would part from
    // Contact:, unless they are kept whole: on the right, 16 px apart, from
    // 1024 px; below it one inline block at the end of the paragraph, whole
    // where it fits, broken only after a dot where it does not (D217).
    assert.match(
      footer,
      /<span className="flex shrink-0 items-center gap-4 whitespace-nowrap max-lg:inline-block max-lg:whitespace-normal">/,
    );
    assert.match(
      footer,
      /<span className="whitespace-nowrap">\n\s*\{m\.footer\.contact\}\n\s*\{'\\u00a0'\}/,
    );
  });

  it('renders the links before Contact:, in ink, each with a dot after it and a break after that below 1024 px only (D211, D217)', () => {
    const footer = read('../components/AppFooter.tsx');
    // Amended by D255: the links are the language's, `footerLinks(m)`, and by
    // issue #369 the build's operator's.
    assert.ok(footer.includes('const links = footerLinks(m, operator);'));
    // The line the component draws, then the links, then the contact; each
    // searched as written, so a part the search cannot find fails here
    // rather than passing as -1.
    const assertOrder = (source: string) => {
      const line = source.indexOf(FOOTER_LINE_ELEMENT);
      const about = source.indexOf('{links.map(');
      const contact = source.indexOf('{m.footer.contact}');

      assert.ok(line > 0, 'the line is not drawn');
      assert.ok(about > line, 'About is not after the line');
      assert.ok(contact > about, 'About is not before Contact:');
    };

    assertOrder(footer);
    // A copy with the links before the line, and one with them after the
    // contact, are refused.
    const linksStart = footer.indexOf('{links.map(');
    const linksEnd = footer.indexOf('))}', linksStart) + '))}'.length;
    const linksBlock = footer.slice(linksStart, linksEnd);
    const withoutLinks = footer.slice(0, linksStart) + footer.slice(linksEnd);
    const linksFirst = withoutLinks.replace(
      FOOTER_LINE_ELEMENT,
      `${linksBlock}${FOOTER_LINE_ELEMENT}`,
    );
    const contactFirst = withoutLinks.replace(
      '        </span>\n      </p>',
      `${linksBlock}\n        </span>\n      </p>`,
    );

    assert.notEqual(linksFirst, withoutLinks);
    assert.notEqual(contactFirst, withoutLinks);
    assert.throws(() => assertOrder(linksFirst), /About is not after the line/);
    assert.throws(() => assertOrder(contactFirst), /About is not before Contact:/);
    assert.throws(() => assertOrder(footer.replace(FOOTER_LINE_ELEMENT, '')), /line is not drawn/);
    // A plain link: /about is not a route of the application.
    assert.match(
      footer,
      /<a\n\s*href=\{link\.href\}\n\s*className="[^"]*\bfont-medium text-ink\b[^"]*"\n\s*>\n\s*\{link\.label\}\n\s*<\/a>/,
    );
    assert.doesNotMatch(footer, /<Link\b/);
    assert.match(
      footer,
      /<span aria-hidden="true" className="hidden max-lg:inline">\n\s*\{FOOTER_SEPARATOR\}\n\s*<\/span>/,
    );
    // A link and its dot are never parted; the line may end after the dot,
    // where the `<wbr>` is, below 1024 px only (D217).
    assert.match(
      footer,
      /<Fragment key=\{link\.href\}>\n\s*<span className="whitespace-nowrap">\n[\s\S]*?\{FOOTER_SEPARATOR\}\n\s*<\/span>\n(?:\s*\) : null\}\n)?\s*<\/span>\n(?:\s*\{\/\*[\s\S]*?\*\/\}\n)?\s*<wbr className="hidden max-lg:inline" \/>\n\s*<\/Fragment>/,
    );
  });

  it('is what the static pages draw, each page its own link the current one (D211, D217)', () => {
    const text = (html: string) =>
      html
        .replace(/<[^>]+>/g, '')
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replace(/\n\s*/g, '');
    const footerOf = (body: string) =>
      /<footer class="site-footer">[\s\S]*?<\/footer>/.exec(body)?.[0] ?? '';

    for (const [page, footer] of [
      [CHANGELOG_LINK.href, footerOf(renderChangelogBody(readChangelog()))],
      [ABOUT_LINK.href, footerOf(renderAboutBody())],
      [TERMS_LINK.href, footerOf(renderLegalBody(TERMS_PAGE))],
      [PRIVACY_LINK.href, footerOf(renderLegalBody(PRIVACY_PAGE))],
    ] as const) {
      assert.equal(footer, siteFooter(page), page);
      // The words as the application's footer reads them, byte for byte.
      assert.equal(text(footer), PRIVACY_FOOTER_TEXT, page);

      const about = footer.indexOf('<a class="footer-link" href="/about"');
      const contact = footer.indexOf(
        '<span class="contact">Contact:\u00a0<a href="mailto:contact@qa-tools.ru">contact@qa-tools.ru</a></span>',
      );

      assert.ok(
        about > footer.indexOf(PRIVACY_FOOTER.line),
        `${page}: About is not after the line`,
      );
      assert.ok(about > 0 && about < contact, `${page}: About is not before Contact:`);
      // About, Terms and Privacy in that order, each with its dot in an item
      // that does not wrap and a `<wbr>` after it, then the contact.
      assert.match(
        footer,
        /<span class="footer-end">(?:<span class="footer-item"><a class="footer-link" href="\/(?:about|terms|privacy)"[^>]*>(?:About|Terms|Privacy)<\/a><span class="footer-separator" aria-hidden="true"> \u00b7 <\/span><\/span><wbr \/>){3}<span class="contact">/,
      );
      assert.deepEqual(
        [...footer.matchAll(/<a class="footer-link" href="([^"]+)"( aria-current="page")?>/g)].map(
          ([, href, current]) => [href, current !== undefined],
        ),
        FOOTER_LINKS.map((link) => [link.href, link.href === page]),
        `${page}: its own link, and only that one, is the current page`,
      );
    }
  });

  it('is drawn in Russian on /ru/about, as the application draws it in Russian, О сервисе the current page (D255)', () => {
    const footer = /<footer class="site-footer">[\s\S]*?<\/footer>/.exec(
      renderAboutBody(ABOUT_RU),
    )?.[0];
    const text = (html: string) =>
      html
        .replace(/<[^>]+>/g, '')
        .replaceAll('&amp;', '&')
        .replace(/\n\s*/g, '');

    assert.equal(footer, siteFooter(ABOUT_RU.path, 'ru'));
    // The words of the application's Russian band below 1024 px, byte for byte.
    assert.equal(
      text(footer ?? ''),
      `${ru.footer.line} О сервисе${FOOTER_SEPARATOR}Условия${FOOTER_SEPARATOR}Конфиденциальность${FOOTER_SEPARATOR}${ru.footer.contact}${NBSP}${PRIVACY_FOOTER.address}`,
    );
    // The same markup as every English band, the words and the one address aside.
    assert.equal(
      (footer ?? '').replace('href="/ru/about"', 'href="/about"').replace(/>[^<]+</g, '><'),
      siteFooter(ABOUT_LINK.href).replace(/>[^<]+</g, '><'),
    );
  });

  it('keeps the static footer whole as the application does: 16 px apart, the dot and the break below 1024 px', () => {
    const css = read('../static-pages/site-chrome.css');
    const narrow = css.slice(css.indexOf('@media (max-width: 1023.98px) {'));
    const wide = css.slice(0, css.indexOf('@media (max-width: 1023.98px) {'));

    assert.match(
      wide,
      /\.site-footer \.footer-end \{\n\s*display: flex;\n\s*flex-shrink: 0;\n\s*align-items: center;\n\s*gap: 16px;\n\s*white-space: nowrap;\n\}/,
    );
    assert.match(wide, /\.site-footer \.footer-item \{\n\s*white-space: nowrap;\n\}/);
    assert.match(wide, /\.site-footer \.footer-end wbr \{\n\s*display: none;\n\}/);
    assert.match(
      wide,
      /\.site-footer \.contact \{\n\s*flex-shrink: 0;\n\s*white-space: nowrap;\n\}/,
    );
    assert.match(wide, /\.site-footer \.footer-separator \{\n\s*display: none;\n\}/);
    assert.match(wide, /\.site-footer \.footer-link \{\n\s*color: #1f242e;\n\}/);
    assert.match(
      narrow,
      /\.site-footer \.footer-end \{\n\s*display: inline-block;\n\s*white-space: normal;\n\s*\}/,
    );
    assert.match(narrow, /\.site-footer \.footer-end wbr \{\n\s*display: inline;\n\s*\}/);
    assert.match(narrow, /\.site-footer \.footer-separator \{\n\s*display: inline;\n\s*\}/);
  });

  it('closes every page the application renders, and not the API reference', () => {
    // The static pages draw it in their own HTML (above).
    for (const page of [
      '../pages/LandingPage.tsx',
      '../components/NotFound.tsx',
      '../components/SessionUnavailable.tsx',
    ]) {
      assert.equal(read(page).match(/<AppFooter \/>/g)?.length, 1, `${page} has no footer`);
    }

    // The session page's loading frame and the page itself.
    assert.equal(read('../pages/SessionPage.tsx').match(/<AppFooter\b/g)?.length, 2);
    assert.doesNotMatch(read('../docs/main.ts'), /AppFooter|privacy-footer/);
  });
});
