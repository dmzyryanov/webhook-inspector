import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import {
  CHANGELOG_FILE_LOCATIONS,
  nginxConf,
  STATUS_MARKER,
  statusLocations,
  withoutLocation,
} from '../../scripts/nginx-conf.mjs';
import { siteFooter, siteHeader } from '../../scripts/site-chrome.mjs';
import {
  DESCRIPTION_PARAGRAPHS,
  DOCS_FEED_COMMENT,
  operatorDescription,
  operatorDocsPage,
  operatorLlmsIndex,
  operatorOpenApi,
  operatorSitemap,
} from '../../scripts/site-operator.mjs';
import {
  FakeElement,
  type FakeNode,
  FakeText,
  installFakeBrowser,
} from '../testing/render-in-node.ts';
import {
  operatorEnv,
  PRODUCTION_OPERATOR,
  withoutOperator,
} from '../testing/production-operator.ts';
import type { AboutCopy } from './about-copy.ts';
import { en } from '../i18n/en.ts';
import { ru } from '../i18n/ru.ts';
import {
  NO_OPERATOR,
  OPERATOR,
  parseBuiltOperator,
  parseContactEmail,
  parseOperator,
  parseOperatorTexts,
  parseStatusPageUrl,
  statusPageInProse,
  type Operator,
  type OperatorWithTexts,
} from './operator.ts';
import { footerLine, footerText } from './privacy-footer.ts';

/**
 * Production's origins, whatever the shell running the tests holds (#354):
 * the pages this file builds in this process are production's but for the
 * operator, and a build for a copy's origins is made in a process of its
 * own. The build's modules read the origins from the environment as they
 * load, so they are imported once these are set, not with the static
 * imports above, which would load them first.
 */
Object.assign(process.env, {
  APP_ORIGIN: 'https://qa-tools.ru',
  RECEIVE_ORIGIN: 'https://hook.qa-tools.ru',
  APP_ALIAS_ORIGIN: 'https://webhook.qa-tools.ru',
});

const { renderAboutBody } = await import('../../scripts/about.mjs');
const { openApiText, siteFiles } = await import('../../scripts/build-site-files.mjs');
const { buildLlmsFiles } = await import('../../scripts/build-llms.mjs');
const { aboutRussian } = await import('./about-copy-ru.ts');
const { aboutEnglish, aboutParagraphText } = await import('./about-copy.ts');
const { legalPages } = await import('./legal-copy.ts');
// @ts-expect-error -- a plain ES module with no declarations; the build runs it.
const buildCheck = await import('../../scripts/check-build.mjs');
const { PRODUCTION_ORIGINS, SITE_ORIGINS } = await import('../../scripts/site-origin.mjs');

const { MemoryRouter } = await import('react-router-dom');
const { LanguageProvider } = await import('../i18n/LanguageProvider.tsx');
const { AppHeader } = await import('../components/AppHeader.tsx');
const { AppFooter } = await import('../components/AppFooter.tsx');

/**
 * The operator's details as build settings (issue #369): `STATUS_PAGE_URL`,
 * `CONTACT_EMAIL` and `OPERATOR_TEXTS`, read by `operator.ts`, each left out
 * when unset with no fallback to production's. A build with production's
 * settings is production's site as it was, which the suite tests everywhere
 * else (`src/testing/production-operator-env.ts` supplies them); this file
 * holds the rest: how the settings are read and refused, what a build with
 * none of them, or with another operator's, writes and serves, and the build
 * check that refuses production's names left in a copy.
 */
const FRONTEND = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** `check-build.mjs`, typed as far as these tests use it. */
const check = buildCheck as {
  checkBuild: (
    dist: string,
    now?: Date,
    entries?: unknown,
    origins?: unknown,
    operator?: Operator,
  ) => string[];
  operatorNameProblems: (dist: string, operator?: Operator) => string[];
  operatorNamesLeft: (text: string, operator?: Operator) => string[];
  OPERATOR_NAMES: readonly { name: string }[];
  CHANGELOG_HISTORY_FILES: readonly string[];
  CHANGELOG_FILES: readonly string[];
  changelogLinksIn: (text: string) => string[];
  changelogLinkProblems: (dist: string) => string[];
  sitemapAddresses: (operator?: Operator) => string[];
  unservedAddresses: (operator?: Operator) => string[];
  sitemapProblems: (text: string, required?: string[], unserved?: string[]) => string[];
};

/** A copy's own operator: every detail set, none of them production's. */
const OTHER_OPERATOR: Operator = parseOperator({
  STATUS_PAGE_URL: 'https://status.inspector.example/',
  CONTACT_EMAIL: 'hello@inspector.example',
});

/** A copy with a contact address and nothing else. */
const CONTACT_ONLY: Operator = parseOperator({ CONTACT_EMAIL: 'hello@inspector.example' });

/** A copy's addresses, none of them production's. */
const OTHER_ORIGINS = {
  app: 'https://inspector.example',
  receive: 'https://hook.inspector.example',
  alias: null,
};

/** The four names of production's operator the issue lists. */
const PRODUCTION_NAMES =
  /status\.qa-tools\.ru|contact@qa-tools\.ru|firstvds|yandex\s+object\s+storage/i;

/** What a page's markup reads as, its tags left out. */
const text = (markup: string) => markup.replace(/<[^>]*>/g, '');

/** Runs of a timed check, of which the fastest is read. */
const TIMED_RUNS = 5;

/**
 * The fastest of `TIMED_RUNS` runs of `run`, in milliseconds, as the suites
 * read a bound on time elsewhere (docs/testing/flakes.md, D203): a collection,
 * or another test file on the same cores, can stop one run for longer than
 * the check takes, but not all five, while a check worse than linear is slow
 * on every run. `run` asserts what it checks each time.
 */
function fastestRun(run: () => void, now: () => number = () => performance.now()): number {
  let fastest = Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < TIMED_RUNS; attempt += 1) {
    const started = now();

    run();
    fastest = Math.min(fastest, now() - started);
  }

  return fastest;
}

describe('a timed check', () => {
  it('is read as the fastest of five runs, so one stalled run does not decide it', () => {
    // A made-up clock, read as each run starts and as it ends: the runs take
    // these, in milliseconds, two of them stalled.
    const durations = [5_000, 3, 9_000, 2, 4];
    let clock = 0;
    let reads = 0;
    let runs = 0;
    const now = () => {
      reads += 1;
      if (reads % 2 === 0) {
        clock += durations[reads / 2 - 1] as number;
      }

      return clock;
    };

    assert.equal(
      fastestRun(() => {
        runs += 1;
      }, now),
      2,
    );
    assert.equal(runs, TIMED_RUNS);
  });
});

describe('the operator settings', () => {
  it('are read here beside production’s origins, whatever the shell running the tests holds (#354)', () => {
    assert.deepEqual(SITE_ORIGINS, PRODUCTION_ORIGINS);
  });

  it('are none when unset or blank, and production’s exactly as the image build gives them', () => {
    assert.deepEqual(parseOperator({}), NO_OPERATOR);
    assert.deepEqual(
      parseOperator({ STATUS_PAGE_URL: ' ', CONTACT_EMAIL: '\t', OPERATOR_TEXTS: '' }),
      NO_OPERATOR,
    );
    assert.deepEqual(PRODUCTION_OPERATOR, {
      statusPageUrl: 'https://status.qa-tools.ru/',
      contactEmail: 'contact@qa-tools.ru',
      texts: true,
    });
    // The suite's own: its preload supplies production's (src/testing/).
    assert.deepEqual(OPERATOR, PRODUCTION_OPERATOR);
    assert.deepEqual(parseOperator(operatorEnv(NO_OPERATOR)), NO_OPERATOR);
    assert.deepEqual(parseOperator(operatorEnv(OTHER_OPERATOR)), OTHER_OPERATOR);
  });

  it('read the status page as URL writes it, with no slash after its host when a sentence names it', () => {
    assert.equal(parseStatusPageUrl('https://Status.Example.com'), 'https://status.example.com/');
    assert.equal(parseStatusPageUrl(' http://localhost:8080/up/ '), 'http://localhost:8080/up/');
    assert.equal(
      parseStatusPageUrl('https://stats.example.com/a b/%7E'),
      'https://stats.example.com/a%20b/%7E',
    );
    assert.equal(statusPageInProse('https://status.qa-tools.ru/'), 'https://status.qa-tools.ru');
    assert.equal(
      statusPageInProse('https://stats.example.com/page'),
      'https://stats.example.com/page',
    );
  });

  it('refuse a status page that is no plain http or https address, never quoting it', () => {
    for (const value of [
      'status.example.com',
      'javascript:alert(1)',
      'ftp://status.example.com/',
      'https://user:secret@status.example.com/',
      'https://status.example.com/?secret=1',
      'https://status.example.com/#secret',
      'https://status.example.com/$host',
      'https://status.example.com/;return',
      "https://status.example.com/it's",
      'https://status.example.com/(x)',
      'https://status.example.com/a|b',
      'https://status.example.com/%zzsecret',
      'https://-secret.example.com/',
      'https://secret..example.com/',
      'https://secret.example.com:0/',
      'https://[::1]/secret',
      `https://${'a'.repeat(64)}.example.com/secret`,
      'https://secret.example.com/\nreturn 302 https://evil.example/;',
    ]) {
      assert.throws(
        () => parseStatusPageUrl(value),
        (error: Error) =>
          error.message.startsWith('STATUS_PAGE_URL ') && !error.message.includes('secret'),
        JSON.stringify(value),
      );
    }
  });

  it('read a contact address as given and refuse anything else, never quoting it', () => {
    assert.equal(
      parseContactEmail(' Hello.Team+ci@Inspector.Example '),
      'Hello.Team+ci@Inspector.Example',
    );

    for (const value of [
      'secret',
      '@example.com',
      'secret@',
      'secret@@example.com',
      'se cret@example.com',
      'secret.@example.com',
      '.secret@example.com',
      'se..cret@example.com',
      '"secret"@example.com',
      'secret<x>@example.com',
      "secret'@example.com",
      'secret@example.com, other@example.com',
      'secret@-example.com',
      'secret@example..com',
      'mailto:secret@example.com',
      `${'s'.repeat(65)}@example.com`,
      `secret@${'a.'.repeat(130)}com`,
    ]) {
      assert.throws(
        () => parseContactEmail(value),
        (error: Error) =>
          error.message.startsWith('CONTACT_EMAIL ') && !error.message.includes('secret'),
        JSON.stringify(value),
      );
    }
  });

  it('read OPERATOR_TEXTS as true or false only, and refuse the texts without both details they name', () => {
    assert.equal(parseOperatorTexts(undefined), false);
    assert.equal(parseOperatorTexts('false'), false);
    assert.equal(parseOperatorTexts(' true '), true);

    for (const value of ['1', 'yes', 'TRUE', 'True', 'on', 'flase']) {
      assert.throws(
        () => parseOperatorTexts(value),
        /^Error: OPERATOR_TEXTS must be true or false$/,
      );
    }

    for (const env of [
      { OPERATOR_TEXTS: 'true' },
      { OPERATOR_TEXTS: 'true', CONTACT_EMAIL: 'hello@inspector.example' },
      { OPERATOR_TEXTS: 'true', STATUS_PAGE_URL: 'https://status.inspector.example/' },
    ]) {
      assert.throws(() => parseOperator(env), /^Error: OPERATOR_TEXTS=true needs CONTACT_EMAIL/);
    }
  });

  it('read values at growing sizes in time linear in their length', () => {
    for (const size of [1_000, 10_000, 100_000, 1_000_000]) {
      const path = 'a'.repeat(size);
      const ms = fastestRun(() => {
        assert.equal(
          parseStatusPageUrl(`https://status.example.com/${path}`),
          `https://status.example.com/${path}`,
        );
        assert.throws(() => parseStatusPageUrl(`https://status.example.com/${path}$`));
        assert.throws(() => parseContactEmail(`${'a.'.repeat(size)}@example.com`));
        assert.throws(() => parseContactEmail(`a@${'a-'.repeat(size)}.com`));
      });

      assert.ok(ms < 2_000, `${size} characters took ${ms.toFixed(1)} ms at best of ${TIMED_RUNS}`);
    }
  });

  it('are handed to the bundle as Vite defines them, and read back as given', () => {
    assert.match(
      read('../../vite.config.ts'),
      /__WEBHOOK_INSPECTOR_OPERATOR__: JSON\.stringify\(OPERATOR\),/,
    );
    assert.deepEqual(
      parseBuiltOperator(JSON.parse(JSON.stringify(PRODUCTION_OPERATOR))),
      PRODUCTION_OPERATOR,
    );
    assert.deepEqual(parseBuiltOperator(JSON.parse(JSON.stringify(NO_OPERATOR))), NO_OPERATOR);
    assert.deepEqual(parseBuiltOperator(undefined), NO_OPERATOR);
    assert.deepEqual(parseBuiltOperator('true'), NO_OPERATOR);
    // Texts without the two details they name are no texts.
    assert.deepEqual(parseBuiltOperator({ texts: true }), NO_OPERATOR);
  });
});

/** A rendered node as HTML: its tag in lower case, its attributes in the order React set them. */
const markup = (node: FakeNode): string => {
  if (node instanceof FakeText) {
    return node.nodeValue;
  }

  if (!(node instanceof FakeElement)) {
    return node.childNodes.map(markup).join('');
  }

  const tag = node.tagName.toLowerCase();
  const attributes = [...node.attributes].map(([name, value]) => ` ${name}="${value}"`).join('');

  return `<${tag}${attributes}>${node.childNodes.map(markup).join('')}</${tag}>`;
};

/**
 * The application's header and footer as React draws them in `lang` for
 * `operator`, into a fake browser at a desktop width, as `main.tsx` would.
 */
const application = async (operator: Operator, lang: 'en' | 'ru' = 'en') => {
  const browser = installFakeBrowser('https://inspector.example/');
  const { createRoot } = await import('react-dom/client');
  const container = browser.document.createElement('div');

  browser.document.body.appendChild(container);

  const root = createRoot(container as unknown as HTMLElement);

  await act(async () => {
    root.render(
      createElement(LanguageProvider, {
        initial: lang,
        storage: null,
        children: createElement(
          MemoryRouter,
          null,
          createElement(AppHeader, { operator }),
          createElement(AppFooter, { operator }),
        ),
      }),
    );
  });

  const html = markup(container);

  await act(async () => root.unmount());

  return html;
};

describe('the pages of a build with no operator settings', () => {
  const header = (lang = 'en') => siteHeader('/about', lang, NO_OPERATOR);
  const footer = (lang = 'en') => siteFooter('/about', lang, NO_OPERATOR);

  it('draw the static header with API docs ↗ alone: no Changelog, no Status ↗ and no divider, in both languages', () => {
    for (const lang of ['en', 'ru']) {
      const html = header(lang);

      assert.doesNotMatch(html, /status|changelog|Изменения/i);
      assert.equal(html.split('class="header-divider"').length - 1, 0);
      assert.match(
        html,
        /<div class="header-links">\n {4}<a class="header-link" href="\/docs"[^\n]*<\/a>\n {2}<\/div>/,
      );
    }

    // A copy with a status page and no texts (issue #396): Status ↗ | API docs ↗.
    const status = siteHeader('/about', 'en', OTHER_OPERATOR);

    assert.doesNotMatch(status, /changelog/i);
    assert.equal(status.split('class="header-divider"').length - 1, 1);
    assert.match(
      status,
      /<div class="header-links">\n {4}<a class="header-link" href="https:\/\/status\.inspector\.example\/"[^\n]*<\/a>\n {4}<span class="header-divider" aria-hidden="true"><\/span>\n {4}<a class="header-link" href="\/docs"/,
    );

    // With production's, the header is as it was: both links and two dividers.
    assert.equal(siteHeader('/about', 'en', PRODUCTION_OPERATOR), siteHeader('/about'));
    assert.match(siteHeader('/about'), /href="https:\/\/status\.qa-tools\.ru\/"/);
    assert.match(
      siteHeader('/about'),
      /<div class="header-links">\n {4}<a class="header-link" href="\/changelog">Changelog<\/a>\n {4}<span class="header-divider" aria-hidden="true"><\/span>\n {4}<a class="header-link" href="https:\/\/status\.qa-tools\.ru\/"/,
    );
    assert.equal(siteHeader('/about').split('class="header-divider"').length - 1, 2);
  });

  it('draw the static footer with About alone, no dot after it and no contact', () => {
    assert.match(
      footer(),
      /<span class="footer-end"><span class="footer-item"><a class="footer-link" href="\/about" aria-current="page">About<\/a><\/span><\/span><\/p>/,
    );
    // The line ends after the session's 7 days (issue #396).
    assert.ok(footer().includes(`<p><span>${en.footer.lineWithoutBackups}</span> `));
    assert.ok(footer('ru').includes(`<p><span>${ru.footer.lineWithoutBackups}</span> `));
    assert.doesNotMatch(footer(), /backups/);
    assert.doesNotMatch(footer('ru'), /в копиях/);
    assert.doesNotMatch(footer(), /terms|privacy|mailto|Contact:|footer-separator/);
    assert.doesNotMatch(footer('ru'), /terms|privacy|mailto|Почта|footer-separator/);
    assert.equal(text(footer()).trim(), `${footerText(undefined, NO_OPERATOR)}`);
  });

  it('draw the static footer of a copy with a contact and no texts: About, a dot, the copy’s address', () => {
    const html = siteFooter('/changelog', 'en', CONTACT_ONLY);

    assert.match(
      html,
      /href="\/about">About<\/a><span class="footer-separator" aria-hidden="true"> · <\/span><\/span><wbr \/><span class="contact">Contact:\u00a0<a href="mailto:hello@inspector\.example">hello@inspector\.example<\/a><\/span>/,
    );
    assert.doesNotMatch(html, /terms|privacy/);
    assert.equal(
      footerText(undefined, CONTACT_ONLY).endsWith('About · Contact:\u00a0hello@inspector.example'),
      true,
    );
  });

  it('draw the application’s header with no Changelog and no Status ↗, and its footer with no legal links, contact or backups', async () => {
    for (const lang of ['en', 'ru'] as const) {
      const m = lang === 'en' ? en : ru;
      const html = await application(NO_OPERATOR, lang);
      const [head, foot] = html.split('<footer');

      assert.ok(foot !== undefined, html);
      const full = await application(PRODUCTION_OPERATOR, lang);
      const [fullHead, fullFoot] = full.split('<footer') as [string, string];

      assert.doesNotMatch(head as string, /status|Статус|changelog|Изменения/i);
      // Two dividers fewer than production's header: the ones after
      // Changelog (issue #396) and after Status ↗.
      assert.equal(
        (head as string).split('h-4 w-px bg-line').length,
        fullHead.split('h-4 w-px bg-line').length - 2,
        lang,
      );
      assert.match(fullHead, /<a href="\/changelog"[^>]*>(?:Changelog|Изменения)<\/a>/);
      assert.doesNotMatch(foot, /\/terms|\/privacy|mailto|Contact:|Почта:/);
      assert.match(foot, /href="\/(?:ru\/)?about"/);
      // The line ends after the session's 7 days (issue #396); production's
      // is D265's.
      assert.ok(foot.includes(`<span>${m.footer.lineWithoutBackups}</span>`), lang);
      assert.ok(!foot.includes(m.footer.line), lang);
      assert.ok(fullFoot.includes(`<span>${m.footer.line}</span>`), lang);
    }

    // A copy with a status page and no texts: Status ↗ | API docs ↗.
    const status = (await application(OTHER_OPERATOR)).split('<footer')[0] as string;

    assert.doesNotMatch(status, /changelog/i);
    assert.match(status, /href="https:\/\/status\.inspector\.example\/"/);
  });

  it('draw the application’s header and footer with every detail for production’s settings', async () => {
    const html = await application(PRODUCTION_OPERATOR);

    assert.match(
      html,
      /href="https:\/\/status\.qa-tools\.ru\/" target="_blank" rel="noopener noreferrer"/,
    );
    assert.match(html, /href="\/terms"/);
    assert.match(html, /href="\/privacy"/);
    assert.match(html, /<a href="mailto:contact@qa-tools\.ru"[^>]*>contact@qa-tools\.ru<\/a>/);
    assert.equal(html, await application(OPERATOR));
  });

  it('leave the about pages’ operator lines out without the texts, and the paragraph of the address without one', () => {
    const story = (page: AboutCopy) => page.story.map(aboutParagraphText);
    const labels = (page: AboutCopy) => page.facts.map((fact) => fact.label);
    const full = [aboutEnglish(PRODUCTION_OPERATOR), aboutRussian(PRODUCTION_OPERATOR)];

    for (const [index, page] of [aboutEnglish(NO_OPERATOR), aboutRussian(NO_OPERATOR)].entries()) {
      const whole = full[index] as AboutCopy;

      // The second paragraph and the first and third facts: the service's own.
      assert.deepEqual(story(page), [story(whole)[1]]);
      assert.deepEqual(labels(page), [labels(whole)[0], labels(whole)[2]]);
      assert.ok(page.story.flat().every((part) => part.kind !== 'mail'));
      assert.deepEqual({ ...page, story: [], facts: [] }, { ...whole, story: [], facts: [] });
    }

    for (const page of [aboutEnglish(CONTACT_ONLY), aboutRussian(CONTACT_ONLY)]) {
      assert.equal(page.story.length, 2);
      assert.deepEqual(
        page.story[1]?.find((part) => part.kind === 'mail'),
        {
          kind: 'mail',
          text: 'hello@inspector.example',
          href: 'mailto:hello@inspector.example',
        },
      );
      assert.equal(page.facts.length, 2);
    }

    assert.deepEqual(labels(aboutEnglish(PRODUCTION_OPERATOR)), [
      "How it's built",
      'Who pays for it',
      'Your data',
      'Security reviews',
    ]);
  });

  it('name the operator’s own contact address and status page where production’s texts name production’s', () => {
    const operator = parseOperator({
      ...operatorEnv(OTHER_OPERATOR),
      OPERATOR_TEXTS: 'true',
    }) as OperatorWithTexts;
    const [terms, privacy] = legalPages(operator);
    const lines = (page: typeof terms) => JSON.stringify(page?.sections ?? []);

    assert.match(lines(privacy), /The status page, status\.inspector\.example, is run by Statuser/);
    assert.doesNotMatch(lines(privacy), /qa-tools/);
    assert.doesNotMatch(lines(terms), /qa-tools/);
    assert.match(lines(terms), /mailto:hello@inspector\.example/);
  });
});

describe('the files a build writes for its operator (scripts/site-operator.mjs)', () => {
  const sitemap = read('../../public/sitemap.xml');
  const llms = read('../../llms/llms.txt');
  const openapi = read('../../../../packages/shared/openapi.json');

  it('are their sources byte for byte for production’s settings', () => {
    assert.equal(operatorSitemap(sitemap, PRODUCTION_OPERATOR), sitemap);
    assert.equal(operatorLlmsIndex(llms, PRODUCTION_OPERATOR), llms);
    assert.equal(operatorOpenApi(openapi, PRODUCTION_OPERATOR), openapi);
  });

  it('leave out the legal pages, the status line, info.contact and the operator’s paragraphs with none', () => {
    const map = operatorSitemap(sitemap, NO_OPERATOR);

    assert.doesNotMatch(map, /terms|privacy|changelog/);
    assert.equal(map.split('<url>').length, sitemap.split('<url>').length - 3);
    assert.match(map, /<loc>https:\/\/qa-tools\.ru\/ru\/about<\/loc>\n {2}<\/url>\n<\/urlset>/);
    assert.match(
      map,
      /<loc>https:\/\/qa-tools\.ru\/docs<\/loc>\n {2}<\/url>\n {2}<url>\n {4}<loc>https:\/\/qa-tools\.ru\/about<\/loc>/,
    );

    const index = operatorLlmsIndex(llms, NO_OPERATOR);

    assert.doesNotMatch(index, /Status page|status\.|changelog/);
    assert.equal(index.split('\n').length, llms.split('\n').length - 2);

    const description = JSON.parse(operatorOpenApi(openapi, NO_OPERATOR)) as {
      info: { contact?: unknown; description: string; version: string };
    };
    const source = JSON.parse(openapi) as typeof description;

    assert.equal(description.info.contact, undefined);
    assert.equal(description.info.version, source.info.version);
    for (const start of Object.values(DESCRIPTION_PARAGRAPHS)) {
      assert.ok(!description.info.description.includes(start), start);
    }
    assert.equal(
      description.info.description.split('\n\n').length,
      source.info.description.split('\n\n').length - 4,
    );
    assert.doesNotMatch(JSON.stringify(description), PRODUCTION_NAMES);
    assert.doesNotMatch(description.info.description, /\/terms|\/privacy|\/about\b|\/changelog/);
    assert.deepEqual(
      JSON.parse(operatorOpenApi(openapi, NO_OPERATOR)).paths,
      JSON.parse(openapi).paths,
    );
  });

  it('leave the changelog’s links out without the operator’s texts, the words around them as written (issue #396)', () => {
    const source = (JSON.parse(openapi) as { info: { description: string } }).info.description;
    const described = (
      JSON.parse(operatorOpenApi(openapi, OTHER_OPERATOR)) as { info: { description: string } }
    ).info.description;

    // The source links the changelog five times, the feeds' sentence twice,
    // and the build leaves each link out with the words that only introduce it.
    assert.equal(source.match(/https:\/\/qa-tools\.ru\/changelog\b/g)?.length, 7);
    assert.doesNotMatch(described, /\/changelog/);
    assert.ok(
      source.split('\n\n').some((paragraph) => paragraph.startsWith(DESCRIPTION_PARAGRAPHS.feeds)),
    );
    assert.ok(!described.includes(DESCRIPTION_PARAGRAPHS.feeds));
    for (const [written, left] of [
      [
        'until the date its 1.16.0 entry gives, https://qa-tools.ru/changelog, which says what happens to it then.',
        'until the date its 1.16.0 entry gives, which says what happens to it then.',
      ],
      [
        "until the date the changelog's 1.16.0 entry gives, https://qa-tools.ru/changelog, which says what changes then.",
        "until the date the changelog's 1.16.0 entry gives, which says what changes then.",
      ],
      [
        'and in an entry of the changelog, https://qa-tools.ru/changelog. The one exception',
        'and in an entry of the changelog. The one exception',
      ],
      [
        'marked **Breaking** in its entry of the changelog, https://qa-tools.ru/changelog (as text for scripts: https://qa-tools.ru/changelog.md). Entries',
        'marked **Breaking** in its entry of the changelog. Entries',
      ],
    ] as const) {
      assert.ok(source.includes(written), written);
      assert.ok(described.includes(left), left);
    }
    // Words that name the changelog without linking it stay (Decision 3).
    assert.equal(
      described.match(/until the date the changelog's 1\.19\.0 entry gives/g)?.length,
      source.match(/until the date the changelog's 1\.19\.0 entry gives/g)?.length,
    );
    // Every other paragraph is the source's.
    assert.deepEqual(
      described.split('\n\n').filter((paragraph) => !/changelog/i.test(paragraph)),
      operatorDescription(source, { ...OTHER_OPERATOR, texts: true })
        .split('\n\n')
        .filter(
          (paragraph) =>
            !/changelog/i.test(paragraph) &&
            !paragraph.startsWith(DESCRIPTION_PARAGRAPHS.about) &&
            !paragraph.startsWith(DESCRIPTION_PARAGRAPHS.legal),
        ),
    );
    // With the texts, the links and the sentence are the source's.
    const shown = operatorDescription(source, PRODUCTION_OPERATOR);

    assert.equal(shown, source);
  });

  it('leave a changelog link out on any origin, and refuse one they cannot read, never letting it through (issue #396)', () => {
    const paragraphs = (...rest: string[]) =>
      [
        'To check whether Webhook Inspector is up, open https://status.qa-tools.ru.',
        "QA Tools is a tester's personal project.",
        'By using the API or the MCP server, you agree to the Terms of Use.',
        'Subscribe with a feed reader: https://x.example/changelog.xml.',
        ...rest,
      ].join('\n\n');

    for (const [written, left] of [
      ['See it, http://inspector.example:8080/changelog, now.', 'See it, now.'],
      ['Read the changelog, https://a.example/changelog.md.', 'Read the changelog.'],
      ['Feeds, https://a.example/changelog-breaking.xml; and more.', 'Feeds; and more.'],
      ['End, https://a.example/changelog', 'End'],
      ['Both (text: https://a.example/changelog.md) here.', 'Both here.'],
      [
        'Kept: https://a.example/changelogs and https://a.example/x/changelog.',
        'Kept: https://a.example/changelogs and https://a.example/x/changelog.',
      ],
    ] as const) {
      // The four paragraphs before it are the operator's, all left out here.
      assert.equal(operatorDescription(paragraphs(written), NO_OPERATOR), left, written);
      assert.ok(
        operatorDescription(paragraphs(written), PRODUCTION_OPERATOR).endsWith(`\n\n${written}`),
      );
    }
    for (const written of [
      'See https://a.example/changelog for it.',
      'At https://a.example/changelog.md.',
      'The page https://a.example/changelog#v1.0.0, once.',
      'Linked, https://a.example/changelog/ here.',
    ]) {
      assert.throws(
        () => operatorDescription(paragraphs(written), NO_OPERATOR),
        /links the changelog where the build cannot leave the link out/,
        written,
      );
    }
    // Without the feeds' sentence the source is refused, as for the others.
    assert.throws(
      () =>
        operatorDescription(
          paragraphs().replace('Subscribe with a feed reader', 'Follow'),
          NO_OPERATOR,
        ),
      /paragraphs beginning "Subscribe with a feed reader"/,
    );
  });

  it('read hostile descriptions at growing sizes in time linear in their length (issue #396)', () => {
    const head = [
      'To check whether Webhook Inspector is up, open https://status.qa-tools.ru.',
      "QA Tools is a tester's personal project.",
      'By using the API or the MCP server, you agree to the Terms of Use.',
      'Subscribe with a feed reader.',
    ].join('\n\n');
    const samples = [
      ', https://',
      ', http://a.a.a.a.a.a',
      ' (aaaa aaaa aaaa: ',
      ' ((((',
      ', https://x.example:',
      ', https://x.example/changelo',
    ];
    const times: number[] = [];

    for (const size of [10_000, 100_000, 400_000]) {
      const body = samples
        .map((sample) => sample.repeat(Math.ceil(size / samples.length / sample.length)))
        .join('');
      const hostile = `${head}\n\n${body}, https://x.example/changelog.`;

      times.push(
        fastestRun(() => {
          // The one link, at the end, is left out; nothing else is a link.
          assert.equal(operatorDescription(hostile, NO_OPERATOR), `${body}.`);
        }),
      );
    }

    // Forty times the text in at most about two hundred times the time:
    // linear with room for a busy runner, nowhere near a quadratic scan.
    assert.ok((times[2] as number) < Math.max(200 * (times[0] as number), 3_000), times.join(', '));
  });

  it('leave the feeds’ links out of /docs’s head without the operator’s texts, and refuse a head without them (issue #396)', () => {
    const page = read('../../docs/index.html');
    const copy = operatorDocsPage(page, NO_OPERATOR);

    assert.equal(operatorDocsPage(page, PRODUCTION_OPERATOR), page);
    assert.ok(page.includes(DOCS_FEED_COMMENT));
    assert.equal(page.match(/rel="alternate"/g)?.length, 2);
    assert.doesNotMatch(copy, /changelog|alternate|Atom/i);
    // Nothing else of the page changes.
    assert.equal(
      copy,
      page
        .replace(DOCS_FEED_COMMENT, '')
        .replace(/ {4}<link\n {6}rel="alternate"\n[\s\S]*?\/>\n/g, ''),
    );
    assert.match(
      copy,
      /<link rel="icon" type="image\/svg\+xml" href="\/src\/assets\/qa-tools-mark\.svg" \/>/,
    );
    assert.match(
      copy,
      /content="HTTP API reference for QA Tools Webhook Inspector, rendered from \/openapi\.json\."\n {4}\/>\n {2}<\/head>/,
    );

    for (const broken of [
      page.replace(DOCS_FEED_COMMENT, ''),
      page.replace('href="/changelog-breaking.xml"', 'href="/feed.xml"'),
      page.replace('rel="alternate"', 'rel="feed"'),
    ]) {
      assert.throws(() => operatorDocsPage(broken, NO_OPERATOR), /docs\/index\.html has no single/);
    }
    // Hostile heads at growing sizes, in time linear in their length.
    const times = [10_000, 100_000, 400_000].map((size) =>
      fastestRun(() => {
        const hostile = `${'<link '.repeat(Math.ceil(size / 6))}\n${' <link a\n'.repeat(Math.ceil(size / 9))}${page}`;

        assert.doesNotMatch(operatorDocsPage(hostile, NO_OPERATOR), /changelog\.xml/);
      }),
    );

    assert.ok((times[2] as number) < Math.max(200 * (times[0] as number), 3_000), times.join(', '));
  });

  it('name another operator’s status page and contact address in their place', () => {
    const index = operatorLlmsIndex(llms, OTHER_OPERATOR);
    const described = JSON.parse(operatorOpenApi(openapi, OTHER_OPERATOR)) as {
      info: { contact: unknown; description: string };
    };

    assert.match(index, /^- \[Status page\]\(https:\/\/status\.inspector\.example\/\): whether/m);
    assert.deepEqual(described.info.contact, {
      name: 'QA Tools',
      email: 'hello@inspector.example',
    });
    assert.match(
      described.info.description,
      /open https:\/\/status\.inspector\.example: the site, the API and webhook receiving/,
    );
    assert.doesNotMatch(JSON.stringify(described), PRODUCTION_NAMES);
    // No texts: the paragraphs on who runs it and on the terms are out.
    assert.ok(!described.info.description.includes(DESCRIPTION_PARAGRAPHS.legal));
  });

  it('refuse a source that lost the part they edit, so production’s name cannot slip through', () => {
    assert.throws(() => operatorSitemap('<urlset></urlset>', NO_OPERATOR), /sitemap\.xml has 0/);
    assert.equal(operatorSitemap('<urlset></urlset>', PRODUCTION_OPERATOR), '<urlset></urlset>');
    assert.throws(
      () => operatorSitemap(sitemap.replace('/changelog</loc>', '/changes</loc>'), NO_OPERATOR),
      /sitemap\.xml has 0 entries for \/changelog, not one/,
    );
    assert.throws(
      () => operatorLlmsIndex(llms.replace('[changelog.md]', '[changes.md]'), NO_OPERATOR),
      /llms\.txt has no single changelog\.md line/,
    );
    assert.throws(
      () => operatorLlmsIndex('# Webhook Inspector\n', NO_OPERATOR),
      /llms\.txt has no/,
    );
    assert.throws(
      () =>
        operatorLlmsIndex(llms.replace('status.qa-tools.ru', 'status.example.com'), NO_OPERATOR),
      /llms\.txt has no/,
    );
    assert.throws(
      () =>
        operatorOpenApi(
          openapi.replace('"email": "contact@qa-tools.ru"', '"email": "x@y.z"'),
          NO_OPERATOR,
        ),
      /info\.contact/,
    );
    assert.throws(
      () =>
        operatorDescription(
          'To check whether Webhook Inspector is up, open https://status.example.com.',
          NO_OPERATOR,
        ),
      /paragraphs beginning/,
    );
  });

  it('are what the build writes, the sitemap, the description and the agent documentation', () => {
    const files = siteFiles(OTHER_ORIGINS, NO_OPERATOR);

    assert.doesNotMatch(files['sitemap.xml'] as string, /terms|privacy/);
    assert.equal(files['openapi.json'], openApiText(OTHER_ORIGINS, NO_OPERATOR));
    assert.equal(
      (JSON.parse(files['openapi.json'] as string) as { info: { contact?: unknown } }).info.contact,
      undefined,
    );

    const llmsFiles = buildLlmsFiles(OTHER_ORIGINS, NO_OPERATOR);

    assert.doesNotMatch(llmsFiles['llms.txt'], PRODUCTION_NAMES);
    assert.doesNotMatch(llmsFiles['llms-full.txt'], PRODUCTION_NAMES);
    assert.doesNotMatch(llmsFiles['llms-full.txt'], /\/terms|\/privacy/);
    // No link to the changelog (issue #396), in any of them.
    for (const text of [
      files['sitemap.xml'] as string,
      files['openapi.json'] as string,
      llmsFiles['llms.txt'],
      llmsFiles['llms-full.txt'],
    ]) {
      assert.deepEqual(check.changelogLinksIn(text), []);
    }
    // With the operator's texts, each links it as production's does.
    const shown = siteFiles(OTHER_ORIGINS, { ...OTHER_OPERATOR, texts: true });

    assert.deepEqual(check.changelogLinksIn(shown['sitemap.xml'] as string), [
      'https://inspector.example/changelog',
    ]);
    assert.equal(
      check.changelogLinksIn(buildLlmsFiles(OTHER_ORIGINS, PRODUCTION_OPERATOR)['llms.txt']).length,
      1,
    );
  });
});

/** One exact location block of `config`, comments and blank lines removed; `undefined` for none. */
function location(config: string, target: string): string | undefined {
  const escaped = target.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

  return new RegExp(`^\\s*location = ${escaped} \\{\\n([\\s\\S]*?)^\\s*\\}$`, 'm')
    .exec(config)?.[1]
    ?.split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** The prefix location `location / { … }`, as it is. */
function rootLocation(config: string): string | undefined {
  return /^ {4}location \/ \{\n([\s\S]*?)^ {4}\}$/m
    .exec(config)?.[1]
    ?.split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

describe('the nginx configuration a build writes (scripts/nginx-conf.mjs)', () => {
  const source = read('../../nginx.conf');

  it('is the repository’s, its marker a comment, for a build with no status page, less the changelog’s files without the operator’s texts', () => {
    assert.equal(
      nginxConf(source, NO_OPERATOR),
      CHANGELOG_FILE_LOCATIONS.reduce(withoutLocation, source),
    );
    assert.equal(source.split(STATUS_MARKER).length, 2);
    assert.match(STATUS_MARKER, /^ {4}#/);
    assert.doesNotMatch(
      source
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n'),
      /status|return 30/,
    );
    // So /status, like any address no location names, is the application's
    // 404: no file, and the shell as its body.
    assert.equal(location(source, '/status'), undefined);
    assert.equal(location(source, '/status/'), undefined);
    assert.equal(rootLocation(source), 'try_files $uri =404;\nerror_page 404 /index.html;');
  });

  it('answers /terms and /privacy with the application’s 404 when their pages are not built', () => {
    for (const page of ['terms', 'privacy']) {
      for (const address of [`/${page}`, `/${page}/`]) {
        assert.equal(location(source, address), `rewrite ^ /${page}/index.html last;`);
      }
      // No try_files: a missing file is the static module's 404, which the
      // error page answers with the application.
      assert.equal(
        location(source, `/${page}/index.html`),
        "internal;\nadd_header Cache-Control 'no-cache' always;\nerror_page 404 /index.html;",
      );
    }
    // /ru/terms and /ru/privacy have no location of their own: location /.
    assert.equal(location(source, '/ru/terms'), undefined);
    assert.equal(location(source, '/ru/privacy'), undefined);
  });

  it('sends /status and /status/ to the operator’s status page with a 301 when there is one', () => {
    for (const operator of [PRODUCTION_OPERATOR, OTHER_OPERATOR]) {
      const config = nginxConf(source, operator);

      for (const address of ['/status', '/status/']) {
        assert.equal(location(config, address), `return 301 ${operator.statusPageUrl};`);
      }
      assert.ok(!config.includes(STATUS_MARKER));
      assert.equal(
        config.replace(statusLocations(operator.statusPageUrl as string), STATUS_MARKER),
        operator.texts ? source : CHANGELOG_FILE_LOCATIONS.reduce(withoutLocation, source),
      );
    }
  });

  it('answers the changelog’s addresses with the application’s 404 in a build without the operator’s texts, and serves them as before with them (issue #396)', () => {
    assert.deepEqual(CHANGELOG_FILE_LOCATIONS, [
      '/changelog.md',
      '/changelog.xml',
      '/changelog-breaking.xml',
    ]);

    for (const operator of [NO_OPERATOR, OTHER_OPERATOR, CONTACT_ONLY]) {
      const config = nginxConf(source, operator);

      // No location of their own: location /'s 404, the application its page.
      for (const path of CHANGELOG_FILE_LOCATIONS) {
        assert.equal(location(config, path), undefined, path);
        assert.ok(!config.includes(path), path);
      }
      assert.equal(rootLocation(config), 'try_files $uri =404;\nerror_page 404 /index.html;');
      // /changelog and /changelog/ find no page, and the error page answers.
      for (const address of ['/changelog', '/changelog/']) {
        assert.equal(location(config, address), 'rewrite ^ /changelog/index.html last;');
      }
      assert.equal(
        location(config, '/changelog/index.html'),
        "internal;\nadd_header Cache-Control 'no-cache' always;\nerror_page 404 /index.html;",
      );
      // Only the three locations and their comments are gone: the 39 lines
      // of their blocks, the comments above them and a blank line after each.
      const kept = new Set(config.split('\n'));

      for (const line of source.split('\n').filter((each) => !kept.has(each))) {
        assert.match(
          line,
          /^ {4}#|^ {8}\S|^ {4}location = \/changelog(?:\.md|\.xml|-breaking\.xml) \{$/,
          line,
        );
      }
      if (operator.statusPageUrl === null) {
        assert.equal(source.split('\n').length - config.split('\n').length, 39);
      }
    }

    // With the texts, each file's location is the source's: a missing file
    // is nginx's plain 404, never the application.
    const config = nginxConf(source, PRODUCTION_OPERATOR);

    assert.equal(
      location(config, '/changelog.md'),
      "types { }\ndefault_type text/markdown;\ncharset utf-8;\ncharset_types text/markdown;\nadd_header Cache-Control 'no-cache' always;\ntry_files $uri =404;",
    );
    for (const path of ['/changelog.xml', '/changelog-breaking.xml']) {
      assert.equal(
        location(config, path),
        "types { }\ndefault_type application/atom+xml;\ncharset utf-8;\ncharset_types application/atom+xml;\nadd_header Cache-Control 'no-cache' always;\ntry_files $uri =404;",
        path,
      );
    }
  });

  it('leaves a location out with its comment and the blank line after it, refusing one missing, doubled or unclosed, in time linear in the source (issue #396)', () => {
    const conf = [
      'server {',
      '    # a',
      '    location = /a {',
      '        a;',
      '    }',
      '',
      '    # b, one',
      '    # b, two',
      '    location = /b {',
      '        types { }',
      '        b;',
      '    }',
      '',
      '    location = /c {',
      '        c;',
      '    }',
      '}',
      '',
    ].join('\n');

    assert.equal(
      withoutLocation(conf, '/b'),
      [
        'server {',
        '    # a',
        '    location = /a {',
        '        a;',
        '    }',
        '',
        '    location = /c {',
        '        c;',
        '    }',
        '}',
        '',
      ].join('\n'),
    );
    assert.equal(
      withoutLocation(conf, '/a'),
      conf.replace('    # a\n    location = /a {\n        a;\n    }\n\n', ''),
    );
    assert.equal(
      withoutLocation(conf, '/c'),
      conf.replace('    location = /c {\n        c;\n    }\n', ''),
    );
    // Only the whole opening line names the location.
    assert.throws(() => withoutLocation(conf, '/'), /must hold the line "location = \/ \{" once/);
    assert.throws(() => withoutLocation(conf, '/d'), /must hold the line "location = \/d \{" once/);
    assert.throws(
      () => withoutLocation(conf.replace('/c', '/b'), '/b'),
      /must hold the line "location = \/b \{" once/,
    );
    assert.throws(
      () => withoutLocation(conf.replace(/ {4}\}\n\}\n$/, '}\n'), '/c'),
      /never closes the location "location = \/c \{"/,
    );
    // Each of the changelog's locations is required, whatever the operator.
    for (const path of CHANGELOG_FILE_LOCATIONS) {
      const broken = source.replace(`    location = ${path} {`, `    location = ${path}x {`);

      for (const operator of [PRODUCTION_OPERATOR, NO_OPERATOR]) {
        assert.throws(() => nginxConf(broken, operator), /must hold the line/, path);
      }
    }

    // Hostile sources at growing sizes: long runs of comments above it, of
    // lines inside it, and of near-miss openings.
    const times = [2_000, 20_000, 80_000].map((size) =>
      fastestRun(() => {
        const hostile = [
          '    #'.repeat(1),
          ...Array.from({ length: size }, () => '    # x'),
          '    location = /b {',
          ...Array.from({ length: size }, () => '        b;'),
          '    }',
          ...Array.from({ length: size }, () => '    location = /b  {'),
          '',
        ].join('\n');

        assert.equal(withoutLocation(hostile, '/b').split('\n').length, size + 1);
      }),
    );

    assert.ok((times[2] as number) < Math.max(200 * (times[0] as number), 3_000), times.join(', '));
  });

  it('refuses an address nginx would read as more than a URL, and a source without its marker', () => {
    for (const url of [
      'https://status.example.com/ ;return 200',
      'https://status.example.com/$host',
      'https://status.example.com/{}',
      'https://status.example.com/"',
      "https://status.example.com/'",
      'https://status.example.com/#x',
      'https://status.example.com/\n',
      'https://status.example.com',
      '/status-page',
    ]) {
      assert.throws(() => statusLocations(url), /cannot carry/, JSON.stringify(url));
    }
    assert.throws(
      () => nginxConf(source.replace(STATUS_MARKER, ''), PRODUCTION_OPERATOR),
      /must hold/,
    );
    assert.throws(() => nginxConf(`${source}${STATUS_MARKER}`, NO_OPERATOR), /must hold/);
  });

  it('is what the image runs, after the build that reads the same settings', () => {
    const dockerfile = read('../../Dockerfile');
    const build = dockerfile.indexOf('RUN npm run build');
    const conf = dockerfile.indexOf(
      'RUN node apps/frontend/scripts/nginx-conf.mjs /app/nginx.conf',
    );

    for (const name of ['STATUS_PAGE_URL', 'CONTACT_EMAIL', 'OPERATOR_TEXTS']) {
      const at = dockerfile.indexOf(`\nARG ${name}\n`);

      assert.ok(at > dockerfile.indexOf('RUN npm ci') && at < build, name);
    }
    assert.ok(build < conf && conf < dockerfile.indexOf('FROM nginx'));
    assert.ok(
      dockerfile.includes('COPY --from=build /app/nginx.conf /etc/nginx/conf.d/default.conf'),
    );
    assert.ok(!dockerfile.includes('COPY apps/frontend/nginx.conf'));
    assert.ok(
      dockerfile.indexOf('RUN nginx -t') > dockerfile.indexOf('COPY --from=build /app/nginx.conf'),
    );
  });
});

/** A build's files, by their path in it, as `check-build.mjs` reads a tree. */
function treeOf(files: Record<string, string | Buffer>): string {
  const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-operator-'));

  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, name)), { recursive: true });
    writeFileSync(join(dist, name), content);
  }

  return dist;
}

describe('the build check of production’s operator names (issue #369, criterion 2)', () => {
  const left = (textOf: string, operator: Operator = NO_OPERATOR) =>
    check.operatorNamesLeft(textOf, operator);

  it('finds each name in any case, inside a longer word, split across lines and escaped', () => {
    assert.deepEqual(
      check.OPERATOR_NAMES.map((item) => item.name),
      ['status.qa-tools.ru', 'contact@qa-tools.ru', 'FirstVDS', 'Yandex Object Storage'],
    );

    for (const [found, textOf] of [
      ['status.qa-tools.ru', 'see https://status.qa-tools.ru/ now'],
      ['status.qa-tools.ru', 'STATUS.QA-TOOLS.RU'],
      ['status.qa-tools.ru', 'mystatus.qa-tools.ru.example'],
      ['status.qa-tools.ru', 'status%2Eqa-tools%2eru'],
      ['status.qa-tools.ru', 'status&#46;qa-tools&#x2E;ru'],
      ['status.qa-tools.ru', 'status\\u002eqa-tools.ru'],
      ['contact@qa-tools.ru', 'mailto:Contact@QA-Tools.Ru'],
      ['contact@qa-tools.ru', 'nocontact@qa-tools.ruby'],
      ['contact@qa-tools.ru', 'contact%40qa-tools.ru'],
      ['contact@qa-tools.ru', 'contact&#64;qa-tools.ru'],
      ['contact@qa-tools.ru', 'contact&commat;qa-tools&period;ru'],
      ['contact@qa-tools.ru', 'contact\\x40qa-tools.ru'],
      ['FirstVDS', 'Moscow (FirstVDS)'],
      ['FirstVDS', 'firstvds.ru'],
      ['FirstVDS', 'myFIRSTVDSx'],
      ['FirstVDS', 'First\nVDS'],
      ['Yandex Object Storage', 'Yandex Object Storage'],
      ['Yandex Object Storage', 'yandex\nobject   STORAGE'],
      ['Yandex Object Storage', 'Yandex\r\n  Object\tStorage'],
      ['Yandex Object Storage', 'Yandex\u00a0Object\u00a0Storage'],
      ['Yandex Object Storage', 'Yandex&nbsp;Object&#160;Storage'],
      ['Yandex Object Storage', 'Yandex\\nObject\\u00a0Storage'],
      ['Yandex Object Storage', 'Yandex<br />Object<br>Storage'],
      ['Yandex Object Storage', 'xYandex Object Storagex'],
    ]) {
      assert.deepEqual(left(textOf as string), [found], JSON.stringify(textOf));
    }

    assert.deepEqual(
      left('Yandex 360, Object Storage, qa-tools.ru, status: ok, contact@example.com'),
      [],
    );
    assert.deepEqual(left('Yandex Object-Storage'), []);
  });

  it('reads what the build’s own settings name as theirs', () => {
    const all = 'status.qa-tools.ru contact@qa-tools.ru FirstVDS Yandex Object Storage';

    assert.deepEqual(left(all, PRODUCTION_OPERATOR), []);
    assert.deepEqual(left(all, OTHER_OPERATOR), [
      'status.qa-tools.ru',
      'contact@qa-tools.ru',
      'FirstVDS',
      'Yandex Object Storage',
    ]);
    assert.deepEqual(left(all, { ...OTHER_OPERATOR, texts: true }), [
      'status.qa-tools.ru',
      'contact@qa-tools.ru',
    ]);
    // An operator's own host or address that holds one of the names inside it.
    const near = parseOperator({
      STATUS_PAGE_URL: 'https://mystatus.qa-tools.ru/',
      CONTACT_EMAIL: 'mycontact@qa-tools.ru',
    });

    assert.deepEqual(left('https://mystatus.qa-tools.ru/ mailto:mycontact@qa-tools.ru', near), []);
    assert.deepEqual(left('https://status.qa-tools.ru/', near), ['status.qa-tools.ru']);
  });

  it('names every file holding one, binary and non-UTF-8 files included, and leaves the changelog’s history', () => {
    const dist = treeOf({
      'index.html': '<p>clean</p>',
      'assets/main-AAAAAAAA.js': 'const a="contact@qa-tools.ru"',
      'about/index.html': '<p>Yandex\nObject Storage</p>',
      'logo-512.png': Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]),
        Buffer.from('FirstVDS'),
        Buffer.from([0xfe, 0]),
      ]),
      'latin1.txt': Buffer.concat([
        Buffer.from([0xe9, 0xe8]),
        Buffer.from('status.qa-tools.ru'),
        Buffer.from([0xc3]),
      ]),
      'changelog.md': 'QA Tools has a public status page, https://status.qa-tools.ru',
      'changelog.xml': '<feed>contact@qa-tools.ru</feed>',
      'changelog-breaking.xml': '<feed>Yandex Object Storage</feed>',
      'changelog/index.html':
        '<header><a href="https://status.qa-tools.ru/">Status</a></header><main>contact@qa-tools.ru</main><footer></footer>',
    });

    try {
      assert.deepEqual(check.operatorNameProblems(dist, NO_OPERATOR).sort(), [
        "about/index.html names Yandex Object Storage, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name",
        "assets/main-AAAAAAAA.js names contact@qa-tools.ru, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name",
        "changelog/index.html names status.qa-tools.ru, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name",
        "latin1.txt names status.qa-tools.ru, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name",
        "logo-512.png names FirstVDS, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name",
      ]);
      assert.deepEqual(check.operatorNameProblems(dist, PRODUCTION_OPERATOR), []);
      assert.deepEqual(check.CHANGELOG_HISTORY_FILES, [
        'changelog.md',
        'changelog.xml',
        'changelog-breaking.xml',
      ]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('scans hostile text at growing sizes in time linear in its length', () => {
    const samples = [
      'yandex '.repeat(1),
      'Yandex\u00a0Object\u00a0',
      'first&#0000000000',
      'status&#x00000000',
      'contact%4',
      'Yandex<br <br <br ',
    ];
    const times: number[] = [];

    for (const size of [100_000, 1_000_000, 4_000_000]) {
      const textOf = samples
        .map((sample) => sample.repeat(Math.ceil(size / samples.length / sample.length)))
        .join('');
      const split = `${textOf}Yandex\n${' '.repeat(size)}Object Storage`;

      times.push(
        fastestRun(() => {
          assert.deepEqual(left(textOf), []);
          assert.deepEqual(left(split), ['Yandex Object Storage']);
        }),
      );
    }

    // Forty times the text in at most about two hundred times the time, each
    // the fastest of five runs: linear with room for a busy runner, nowhere
    // near the 1,600 of a quadratic scan.
    assert.ok((times[2] as number) < Math.max(200 * (times[0] as number), 3_000), times.join(', '));
  });

  it('is what checkBuild runs, refusing security.txt, the legal pages and their sitemap entries in a build that names none', () => {
    const dist = treeOf({
      '.well-known/security.txt': 'Contact: mailto:someone@example.com\n',
      'terms/index.html': '<title>Terms</title>',
      'privacy/index.html': '<title>Privacy</title>',
    });

    try {
      const problems = check.checkBuild(dist, new Date(), [], OTHER_ORIGINS, NO_OPERATOR);

      assert.ok(
        problems.includes(
          '.well-known/security.txt is in the build, though it names no contact address',
        ),
      );
      assert.ok(
        problems.includes(
          "terms/index.html is in the build, though OPERATOR_TEXTS does not show the operator's texts",
        ),
      );
      assert.ok(
        problems.includes(
          "privacy/index.html is in the build, though OPERATOR_TEXTS does not show the operator's texts",
        ),
      );
      assert.ok(
        !problems.some((problem) => problem.startsWith('the terms page')),
        problems.join('\n'),
      );
      assert.ok(!problems.includes('.well-known/security.txt was not built'));
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }

    assert.deepEqual(
      check.sitemapProblems(
        '<urlset><url><loc>https://inspector.example/terms</loc></url></urlset>',
        [],
        ['https://inspector.example/terms'],
      ),
      ['sitemap.xml lists https://inspector.example/terms, which this build does not serve'],
    );
  });

  it('finds a link to each of the changelog’s addresses, relative or on any origin, and nothing that only looks like one (issue #396)', () => {
    for (const [textOf, found] of [
      ['<a class="header-link" href="/changelog">Changelog</a>', ['/changelog']],
      ['<a href="/changelog/">', ['/changelog']],
      ['<a href="/changelog#v1.0.0">', ['/changelog']],
      ['<loc>https://inspector.example/changelog</loc>', ['https://inspector.example/changelog']],
      [
        '- [changelog.md](https://inspector.example/changelog.md): what',
        ['https://inspector.example/changelog.md'],
      ],
      ['[text](/changelog.md)', ['/changelog.md']],
      [
        'href="/changelog.xml" href="/changelog-breaking.xml"',
        ['/changelog.xml', '/changelog-breaking.xml'],
      ],
      [
        '"all changes, http://localhost:5173/changelog.xml · "',
        ['http://localhost:5173/changelog.xml'],
      ],
      ['the changelog, https://a.example/changelog. The', ['https://a.example/changelog']],
      ['(https://a.example/changelog)', ['https://a.example/changelog']],
      ['/changelog /changelog', ['/changelog']],
    ] as const) {
      assert.deepEqual(check.changelogLinksIn(textOf), found, textOf);
    }

    for (const textOf of [
      'until the date the changelog gives',
      "the changelog's 1.19.0 entry",
      'CHANGELOG.md',
      '/CHANGELOG.md',
      'apps/frontend/changelog/index.html',
      'https://a.example/x/changelog',
      '/changelogs',
      '/changelog-feed',
      '/changelog.mdx',
      '/changelog.xmll',
      '/changelog.markdown',
      '//changelog',
      '%2Fchangelog',
      'ftp://a.example/changelog',
    ]) {
      assert.deepEqual(check.changelogLinksIn(textOf), [], textOf);
    }
  });

  it('scans hostile text for changelog links at growing sizes in time linear in its length (issue #396)', () => {
    const samples = [
      'https://',
      'http://aaaaaaaaaaaa',
      'https://a.a.a.a.a:',
      '/changelo',
      'https://x.example/changelog-breaking.xm',
      '/changelog.m',
    ];
    const times: number[] = [];

    for (const size of [100_000, 1_000_000, 4_000_000]) {
      const textOf = samples
        .map((sample) => sample.repeat(Math.ceil(size / samples.length / sample.length)))
        .join(' ');

      times.push(
        fastestRun(() => {
          assert.deepEqual(check.changelogLinksIn(textOf), []);
          assert.deepEqual(check.changelogLinksIn(`${textOf} /changelog.xml`), ['/changelog.xml']);
        }),
      );
    }

    assert.ok((times[2] as number) < Math.max(200 * (times[0] as number), 3_000), times.join(', '));
  });

  it('is what checkBuild runs, refusing the changelog’s files and every link to them in a build without the operator’s texts, and none of them with (issue #396, criterion 4)', () => {
    const dist = treeOf({
      'changelog/index.html': '<h1>Changelog</h1>',
      'changelog.md': '# Changelog',
      'changelog.xml': '<feed />',
      'changelog-breaking.xml': '<feed />',
      'about/index.html': '<a class="header-link" href="/changelog">Changelog</a>',
      'llms.txt': '- [changelog.md](https://inspector.example/changelog.md): what changed',
      'docs/index.html': '<link rel="alternate" href="/changelog.xml" />',
      'sitemap.xml': '<urlset><url><loc>https://inspector.example/changelog</loc></url></urlset>',
      // A script keeps the address as a constant; what it draws is tested apart.
      'assets/main-AAAAAAAA.js': 'const a={href:`/changelog`}',
      'webhook-inspector-relay.mjs': '// until the date the changelog gives',
    });
    const refusals = (problems: string[]) =>
      problems.filter(
        (problem) =>
          /changelog/.test(problem) &&
          !/was not built|lists no version|publishes|feed changelog/.test(problem),
      );

    try {
      assert.deepEqual(check.CHANGELOG_FILES, [
        'changelog/index.html',
        'changelog.md',
        'changelog.xml',
        'changelog-breaking.xml',
      ]);
      assert.deepEqual(
        refusals(check.checkBuild(dist, new Date(), [], OTHER_ORIGINS, NO_OPERATOR)).sort(),
        [
          "about/index.html links /changelog, though OPERATOR_TEXTS does not show the operator's texts and the build has no changelog",
          "changelog-breaking.xml is in the build, though OPERATOR_TEXTS does not show the operator's texts",
          "changelog.md is in the build, though OPERATOR_TEXTS does not show the operator's texts",
          "changelog.xml is in the build, though OPERATOR_TEXTS does not show the operator's texts",
          "changelog/index.html is in the build, though OPERATOR_TEXTS does not show the operator's texts",
          "docs/index.html links /changelog.xml, though OPERATOR_TEXTS does not show the operator's texts and the build has no changelog",
          "llms.txt links https://inspector.example/changelog.md, though OPERATOR_TEXTS does not show the operator's texts and the build has no changelog",
          "sitemap.xml links https://inspector.example/changelog, though OPERATOR_TEXTS does not show the operator's texts and the build has no changelog",
        ],
      );
      // With the operator's texts nothing of it is refused: the changelog is
      // checked as it always was instead.
      for (const operator of [PRODUCTION_OPERATOR, { ...OTHER_OPERATOR, texts: true }]) {
        const problems = check.checkBuild(dist, new Date(), [], OTHER_ORIGINS, operator);

        assert.deepEqual(
          problems.filter((problem) =>
            / links |is in the build, though OPERATOR_TEXTS/.test(problem),
          ),
          [],
        );
        assert.ok(problems.includes('the changelog page changelog/index.html lists no version'));
      }
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }

    // What the sitemap must list, and must not.
    assert.ok(
      check.sitemapAddresses(PRODUCTION_OPERATOR).some((address) => address.endsWith('/changelog')),
    );
    assert.ok(
      !check.sitemapAddresses(NO_OPERATOR).some((address) => address.endsWith('/changelog')),
    );
    assert.deepEqual(
      check.unservedAddresses(NO_OPERATOR).map((address) => new URL(address).pathname),
      ['/terms', '/privacy', '/changelog'],
    );
    assert.deepEqual(check.unservedAddresses(PRODUCTION_OPERATOR), []);
    // The sitemap is refused for listing it, as for the legal pages.
    assert.deepEqual(
      check.sitemapProblems(
        '<urlset><url><loc>https://qa-tools.ru/changelog</loc></url></urlset>',
        [],
        check.unservedAddresses(NO_OPERATOR),
      ),
      ['sitemap.xml lists https://qa-tools.ru/changelog, which this build does not serve'],
    );
  });
});

/**
 * The frontend built as `npm run build` builds it, into `dist`, with `env`
 * as its whole environment but `PATH`: each step of the build script, the
 * Vite builds given that directory, the scripts given it as their argument,
 * the build check last among them. The type check is the suite's own job.
 */
function buildInto(dist: string, env: Record<string, string | undefined>) {
  const script = (JSON.parse(read('../../package.json')) as { scripts: { build: string } }).scripts
    .build;
  const environment = {
    ...env,
    PATH: [
      join(FRONTEND, 'node_modules/.bin'),
      join(ROOT, 'node_modules/.bin'),
      process.env.PATH,
    ].join(delimiter),
  };

  for (const step of script.split(' && ')) {
    const [command, ...rest] = step.split(' ');
    let args: string[];

    if (command === 'tsc') {
      continue;
    } else if (command === 'vite') {
      args = [...rest, '--outDir', dist, '--logLevel', 'warn'];
    } else {
      assert.equal(command, 'node', step);
      args = [...rest, dist];
    }

    const run = spawnSync(command, args, { cwd: FRONTEND, env: environment, encoding: 'utf8' });

    assert.equal(run.status, 0, `${step}\n${run.stdout}\n${run.stderr}`);
  }
}

/** Every file under `dist`, by its path in it. */
function filesOf(dist: string, prefix = ''): string[] {
  return readdirSync(join(dist, prefix), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesOf(dist, prefix === '' ? entry.name : `${prefix}/${entry.name}`)
      : [prefix === '' ? entry.name : `${prefix}/${entry.name}`],
  );
}

describe('a build with example origins and no operator settings (issue #369, criterion 1)', () => {
  let dist = '';
  /** The build's environment: a copy's origins and none of the operator settings. */
  const environment = {
    ...withoutOperator(process.env),
    APP_ORIGIN: OTHER_ORIGINS.app,
    RECEIVE_ORIGIN: OTHER_ORIGINS.receive,
    APP_ALIAS_ORIGIN: '',
  };

  // Five Vite builds and five scripts, as the build for another address in
  // site-origin.test.ts, which takes about 6 s on an 8-core machine.
  before(
    () => {
      dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-no-operator-'));
      buildInto(dist, environment);
    },
    { timeout: 180_000 },
  );

  after(() => {
    if (dist !== '') {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  const built = (path: string) => readFileSync(join(dist, path), 'utf8');

  it('names none of production’s operator details in any file, the changelog’s history being no file of it', () => {
    const files = filesOf(dist);

    assert.ok(files.length > 20);
    for (const path of files) {
      assert.doesNotMatch(built(path), PRODUCTION_NAMES, path);
    }
    // The changelog, whose words of 0.49.0 name the status page, is the
    // operator's texts since issue #396, and not in this build.
    for (const path of check.CHANGELOG_HISTORY_FILES) {
      assert.ok(!files.includes(path), path);
    }
    // What the build check found, which `buildInto` saw it pass with.
    assert.deepEqual(check.operatorNameProblems(dist, NO_OPERATOR), []);
  });

  it('draws no status link in any header and no legal link or contact in any footer', async () => {
    for (const page of ['about/index.html', 'ru/about/index.html']) {
      const html = built(page);
      const header = /<header class="site-header">[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
      const footer = /<footer class="site-footer">[\s\S]*?<\/footer>/.exec(html)?.[0] ?? '';

      assert.ok(header !== '' && footer !== '', page);
      assert.doesNotMatch(header, /status|Статус/i, page);
      assert.doesNotMatch(footer, /\/terms|\/privacy|mailto|Contact:|Почта:/, page);
    }

    // The application's: its bundle is handed the operator this build's
    // environment gives, as vite.config.ts defines it and operator.ts reads
    // it back (the settings' own tests above), and its header and footer,
    // rendered for that one, draw no status link, no legal link and no
    // contact. Read from what React draws, not from the minified bundle,
    // whose text a bundler or a minifier may change with no defect.
    const operator = parseBuiltOperator(JSON.parse(JSON.stringify(parseOperator(environment))));

    assert.deepEqual(operator, NO_OPERATOR);
    for (const lang of ['en', 'ru'] as const) {
      const [head, foot] = (await application(operator, lang)).split('<footer');

      assert.ok(head !== undefined && foot !== undefined, lang);
      assert.match(head, /<header/, lang);
      assert.doesNotMatch(head, /status|Статус/i, lang);
      assert.doesNotMatch(foot, /\/terms|\/privacy|mailto|Contact:|Почта:/, lang);
      assert.match(foot, /href="\/(?:ru\/)?about"/, lang);
    }
  });

  it('serves no /terms, /privacy, /ru/terms, /ru/privacy, /status or security.txt', () => {
    for (const path of [
      'terms',
      'privacy',
      'ru/terms',
      'ru/privacy',
      'status',
      'status/index.html',
      '.well-known/security.txt',
      '.well-known',
    ]) {
      assert.ok(!existsSync(join(dist, path)), path);
    }
    assert.doesNotMatch(built('sitemap.xml'), /terms|privacy/);
    // The repository's configuration, its status marker a comment, less the
    // changelog's files (issue #396, below).
    assert.equal(
      nginxConf(read('../../nginx.conf'), NO_OPERATOR),
      CHANGELOG_FILE_LOCATIONS.reduce(withoutLocation, read('../../nginx.conf')),
    );
  });

  it('writes no changelog and links none: no page, text or feed, no Changelog in any header, and nginx answers its addresses with the application’s 404 (issue #396, criterion 1)', async () => {
    const files = filesOf(dist);

    // None of its four files, nor the page's own script and stylesheet.
    for (const path of [...check.CHANGELOG_FILES, 'changelog']) {
      assert.ok(!existsSync(join(dist, path)), path);
    }
    assert.deepEqual(
      files.filter((path) => /changelog/i.test(path)),
      [],
    );

    // No file links /changelog, /changelog.md or a feed, but a script, whose
    // text is the bundler's: what the application draws is read below.
    for (const path of files.filter((each) => !/\.(?:js|mjs|png|ico|woff2?)$/.test(each))) {
      assert.deepEqual(check.changelogLinksIn(built(path)), [], path);
    }
    assert.deepEqual(check.changelogLinkProblems(dist), []);
    assert.doesNotMatch(built('sitemap.xml'), /changelog/);
    assert.doesNotMatch(built('llms.txt'), /changelog/i);
    assert.doesNotMatch(built('docs/index.html'), /changelog|application\/atom\+xml/i);
    for (const path of ['openapi.json', 'llms-full.txt']) {
      assert.doesNotMatch(built(path), /\/changelog|Subscribe with a feed reader/, path);
      // Words naming the changelog without a link stay (Decision 3).
      assert.match(built(path), /until the date the changelog's 1\.19\.0 entry gives/, path);
    }

    // The static pages' headers draw no Changelog, in either language.
    for (const page of ['about/index.html', 'ru/about/index.html']) {
      const header = /<header class="site-header">[\s\S]*?<\/header>/.exec(built(page))?.[0] ?? '';

      assert.match(header, /href="\/docs"/, page);
      assert.doesNotMatch(header, /changelog|Изменения|header-divider/i, page);
    }

    // Nor does the application's, rendered for the operator this build's
    // environment gives, in either language.
    const operator = parseBuiltOperator(JSON.parse(JSON.stringify(parseOperator(environment))));

    for (const lang of ['en', 'ru'] as const) {
      const [head] = (await application(operator, lang)).split('<footer');

      assert.doesNotMatch(head as string, /changelog|Изменения/i, lang);
      assert.match(head as string, /href="\/docs"/, lang);
    }

    // nginx: /changelog and /changelog/ find no page and the error page
    // answers; the text and the feeds have no location of their own, so
    // location / answers them the same way.
    const config = nginxConf(read('../../nginx.conf'), operator);

    for (const address of ['/changelog', '/changelog/']) {
      assert.equal(location(config, address), 'rewrite ^ /changelog/index.html last;');
    }
    assert.match(
      location(config, '/changelog/index.html') as string,
      /error_page 404 \/index\.html;$/,
    );
    for (const address of ['/changelog.md', '/changelog.xml', '/changelog-breaking.xml']) {
      assert.equal(location(config, address), undefined, address);
      assert.ok(!existsSync(join(dist, address.slice(1))), address);
    }
    assert.equal(rootLocation(config), 'try_files $uri =404;\nerror_page 404 /index.html;');
  });

  it('ends the footer line after the session’s 7 days, in the application’s band, the static pages and /ru/about (issue #396, criterion 2)', async () => {
    const lineOf = (html: string) =>
      /<footer class="site-footer">\n {2}<p><span>([^<]*)<\/span>/.exec(html)?.[1];

    assert.equal(lineOf(built('about/index.html')), en.footer.lineWithoutBackups);
    assert.equal(lineOf(built('ru/about/index.html')), ru.footer.lineWithoutBackups);

    const operator = parseBuiltOperator(JSON.parse(JSON.stringify(parseOperator(environment))));

    for (const [lang, m] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const [, foot] = (await application(operator, lang)).split('<footer');

      assert.ok((foot as string).includes(`<span>${m.footer.lineWithoutBackups}</span>`), lang);
      assert.equal(footerLine(m, operator), m.footer.lineWithoutBackups, lang);
    }
    assert.doesNotMatch(built('about/index.html'), /backups keep them/);
    assert.doesNotMatch(built('ru/about/index.html'), /в копиях — ещё/);
  });

  it('leaves the about pages’ operator lines out, in both languages', () => {
    assert.equal(
      /<main>[\s\S]*<\/main>/.exec(built('about/index.html'))?.[0],
      /<main>[\s\S]*<\/main>/.exec(
        renderAboutBody(aboutEnglish(NO_OPERATOR)).replace(
          /https:\/\/qa-tools\.ru/g,
          OTHER_ORIGINS.app,
        ),
      )?.[0],
    );
    assert.doesNotMatch(
      built('about/index.html'),
      /Who pays for it|Security reviews|personal project/,
    );
    assert.doesNotMatch(
      built('ru/about/index.html'),
      /Кто платит|Проверка безопасности|личный проект/,
    );
  });

  it('fails the build check, naming the file, with a changelog file or a link to one left in it (issue #396, criterion 4)', () => {
    for (const [file, write, refusal] of [
      [
        'changelog.xml',
        '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
        "changelog.xml is in the build, though OPERATOR_TEXTS does not show the operator's texts",
      ],
      [
        'changelog/index.html',
        '<h1>Changelog</h1>',
        "changelog/index.html is in the build, though OPERATOR_TEXTS does not show the operator's texts",
      ],
      [
        'llms.txt',
        `${built('llms.txt')}- [changelog.md](https://inspector.example/changelog.md): what changed\n`,
        "llms.txt links https://inspector.example/changelog.md, though OPERATOR_TEXTS does not show the operator's texts and the build has no changelog",
      ],
      [
        'about/index.html',
        built('about/index.html').replace(
          '<div class="header-links">',
          '<div class="header-links"><a class="header-link" href="/changelog">Changelog</a>',
        ),
        "about/index.html links /changelog, though OPERATOR_TEXTS does not show the operator's texts and the build has no changelog",
      ],
    ] as const) {
      const copy = mkdtempSync(join(tmpdir(), 'webhook-inspector-changelog-left-'));

      try {
        cpSync(dist, copy, { recursive: true });
        mkdirSync(dirname(join(copy, file)), { recursive: true });
        writeFileSync(join(copy, file), write);

        const run = spawnSync(process.execPath, ['scripts/check-build.mjs', copy], {
          cwd: FRONTEND,
          env: environment,
          encoding: 'utf8',
        });

        assert.equal(run.status, 1, run.stdout);
        assert.ok(run.stderr.split('\n').includes(`  - ${refusal}`), run.stderr);
        assert.equal(run.stderr.match(/^ {2}- /gm)?.length, 1, run.stderr);
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }

    // The build itself passed, saying so.
    const run = spawnSync(process.execPath, ['scripts/check-build.mjs', dist], {
      cwd: FRONTEND,
      env: environment,
      encoding: 'utf8',
    });

    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout,
      /the operator's texts are left out, the changelog among them, and nothing links it/,
    );
    assert.doesNotMatch(run.stdout, /the changelog,|Atom feeds/);
  });

  it('fails the build check, naming the file, with one of the names left in a source', () => {
    const copy = mkdtempSync(join(tmpdir(), 'webhook-inspector-left-name-'));

    try {
      cpSync(dist, copy, { recursive: true });
      // A line the build would have copied from a source that still names
      // production's status page: llms/llms.txt's, as it was before #369.
      writeFileSync(
        join(copy, 'llms.txt'),
        `${built('llms.txt')}- [Status page](https://status.qa-tools.ru/): whether it is up\n`,
      );

      const run = spawnSync(process.execPath, ['scripts/check-build.mjs', copy], {
        cwd: FRONTEND,
        env: environment,
        encoding: 'utf8',
      });

      assert.equal(run.status, 1, run.stdout);
      assert.match(
        run.stderr,
        /^ {2}- llms\.txt names status\.qa-tools\.ru, which this build's operator settings \(STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS\) do not name$/m,
      );
      assert.equal(run.stderr.match(/^ {2}- /gm)?.length, 1, run.stderr);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
