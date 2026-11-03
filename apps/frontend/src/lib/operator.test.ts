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
import { nginxConf, STATUS_MARKER, statusLocations } from '../../scripts/nginx-conf.mjs';
import { siteFooter, siteHeader } from '../../scripts/site-chrome.mjs';
import {
  DESCRIPTION_PARAGRAPHS,
  operatorDescription,
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
import { footerText } from './privacy-footer.ts';

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
      const started = performance.now();

      assert.equal(
        parseStatusPageUrl(`https://status.example.com/${path}`),
        `https://status.example.com/${path}`,
      );
      assert.throws(() => parseStatusPageUrl(`https://status.example.com/${path}$`));
      assert.throws(() => parseContactEmail(`${'a.'.repeat(size)}@example.com`));
      assert.throws(() => parseContactEmail(`a@${'a-'.repeat(size)}.com`));
      assert.ok(performance.now() - started < 2_000, `${size} characters took too long`);
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

describe('the pages of a build with no operator settings', () => {
  const header = (lang = 'en') => siteHeader('/about', lang, NO_OPERATOR);
  const footer = (lang = 'en') => siteFooter('/about', lang, NO_OPERATOR);

  it('draw the static header with no Status ↗ and one divider, in both languages', () => {
    for (const lang of ['en', 'ru']) {
      const html = header(lang);

      assert.doesNotMatch(html, /status/i);
      assert.equal(html.split('class="header-divider"').length - 1, 1);
      assert.match(
        html,
        /href="\/changelog"[\s\S]*<span class="header-divider"[^>]*><\/span>\s*<a class="header-link" href="\/docs"/,
      );
    }

    // With production's, the header is as it was: the link and two dividers.
    assert.equal(siteHeader('/about', 'en', PRODUCTION_OPERATOR), siteHeader('/about'));
    assert.match(siteHeader('/about'), /href="https:\/\/status\.qa-tools\.ru\/"/);
  });

  it('draw the static footer with About alone, no dot after it and no contact', () => {
    assert.match(
      footer(),
      /<span class="footer-end"><span class="footer-item"><a class="footer-link" href="\/about" aria-current="page">About<\/a><\/span><\/span><\/p>/,
    );
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

  it('draw the application’s header with no Status ↗ and its footer with no legal links or contact', async () => {
    for (const lang of ['en', 'ru'] as const) {
      const html = await application(NO_OPERATOR, lang);
      const [head, foot] = html.split('<footer');

      assert.ok(foot !== undefined, html);
      const full = (await application(PRODUCTION_OPERATOR, lang)).split('<footer')[0] as string;

      assert.doesNotMatch(head as string, /status|Статус/i);
      // One divider fewer than production's header: the one before Status ↗.
      assert.equal(
        (head as string).split('h-4 w-px bg-line').length,
        full.split('h-4 w-px bg-line').length - 1,
        lang,
      );
      assert.doesNotMatch(foot, /\/terms|\/privacy|mailto|Contact:|Почта:/);
      assert.match(foot, /href="\/(?:ru\/)?about"/);
    }
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

    assert.doesNotMatch(map, /terms|privacy/);
    assert.equal(map.split('<url>').length, sitemap.split('<url>').length - 2);
    assert.match(map, /<loc>https:\/\/qa-tools\.ru\/ru\/about<\/loc>\n {2}<\/url>\n<\/urlset>/);

    const index = operatorLlmsIndex(llms, NO_OPERATOR);

    assert.doesNotMatch(index, /Status page|status\./);
    assert.equal(index.split('\n').length, llms.split('\n').length - 1);

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
      source.info.description.split('\n\n').length - 3,
    );
    assert.doesNotMatch(JSON.stringify(description), PRODUCTION_NAMES);
    assert.doesNotMatch(description.info.description, /\/terms|\/privacy|\/about\b/);
    assert.deepEqual(
      JSON.parse(operatorOpenApi(openapi, NO_OPERATOR)).paths,
      JSON.parse(openapi).paths,
    );
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

  it('is the repository’s, its marker a comment, for a build with no status page', () => {
    assert.equal(nginxConf(source, NO_OPERATOR), source);
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
        source,
      );
    }
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
      const started = performance.now();

      assert.deepEqual(left(textOf), []);
      assert.deepEqual(left(`${textOf}Yandex\n${' '.repeat(size)}Object Storage`), [
        'Yandex Object Storage',
      ]);
      times.push(performance.now() - started);
    }

    // Forty times the text in at most about two hundred times the time: linear
    // with room for a busy runner, nowhere near the 1,600 of a quadratic scan.
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

  // Five Vite builds and five scripts, as the build for another address in
  // site-origin.test.ts, which takes about 6 s on an 8-core machine.
  before(
    () => {
      dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-no-operator-'));
      buildInto(dist, {
        ...withoutOperator(process.env),
        APP_ORIGIN: OTHER_ORIGINS.app,
        RECEIVE_ORIGIN: OTHER_ORIGINS.receive,
        APP_ALIAS_ORIGIN: '',
      });
    },
    { timeout: 180_000 },
  );

  after(() => {
    if (dist !== '') {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  const built = (path: string) => readFileSync(join(dist, path), 'utf8');

  it('names none of production’s operator details in any file but the changelog’s history', () => {
    const files = filesOf(dist);

    assert.ok(files.length > 20);
    for (const path of files) {
      const content = built(path);
      const history =
        check.CHANGELOG_HISTORY_FILES.includes(path) || path === 'changelog/index.html';

      if (!history) {
        assert.doesNotMatch(content, PRODUCTION_NAMES, path);
      }
    }
    // The changelog's own words of 0.49.0 stay: history is not rewritten.
    assert.match(
      built('changelog.md'),
      /QA Tools has a public status page, https:\/\/status\.qa-tools\.ru/,
    );
    // What the build check found, which `buildInto` saw it pass with.
    assert.deepEqual(check.operatorNameProblems(dist, NO_OPERATOR), []);
  });

  it('draws no status link in any header and no legal link or contact in any footer', () => {
    for (const page of ['about/index.html', 'ru/about/index.html', 'changelog/index.html']) {
      const html = built(page);
      const header = /<header class="site-header">[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
      const footer = /<footer class="site-footer">[\s\S]*?<\/footer>/.exec(html)?.[0] ?? '';

      assert.ok(header !== '' && footer !== '', page);
      assert.doesNotMatch(header, /status|Статус/i, page);
      assert.doesNotMatch(footer, /\/terms|\/privacy|mailto|Contact:|Почта:/, page);
    }

    // The application's bundle carries no operator: the header and footer
    // above, rendered, draw none.
    const bundles = filesOf(dist).filter((path) => /^assets\/main-.*\.js$/.test(path));

    assert.equal(bundles.length, 1);
    assert.match(built(bundles[0] as string), /\{statusPageUrl:null,contactEmail:null,texts:!1\}/);
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
    assert.equal(nginxConf(read('../../nginx.conf'), NO_OPERATOR), read('../../nginx.conf'));
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

  it('fails the build check, naming the file, with one of the names left in a source', () => {
    const copy = mkdtempSync(join(tmpdir(), 'webhook-inspector-left-name-'));
    const env = {
      ...withoutOperator(process.env),
      APP_ORIGIN: OTHER_ORIGINS.app,
      RECEIVE_ORIGIN: OTHER_ORIGINS.receive,
      APP_ALIAS_ORIGIN: '',
    };

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
        env,
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
