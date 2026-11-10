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
  ADDRESS_BULLET,
  DESCRIPTION_PARAGRAPHS,
  DOCS_FEED_COMMENT,
  MOVE_BULLET,
  NETWORK_HEADING,
  NETWORK_POINTER,
  OLD_NAME_BULLET,
  operatorDescription,
  operatorDocsPage,
  operatorLlmsIndex,
  operatorOpenApi,
  operatorSitemap,
  RELAY_HEADING,
  WRITTEN_SERVER_ADDRESS,
  WRITTEN_STATUS_PAGE_IN_PROSE,
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
const { nameSite, parseSiteOrigin, PRODUCTION_ORIGINS, SITE_ORIGINS } =
  await import('../../scripts/site-origin.mjs');

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
  changelogLinkProblems: (dist: string, operator?: Operator, origins?: unknown) => string[];
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

/**
 * A copy's addresses at IPv6 hosts, as `site-origin.mjs` accepts them, with
 * no second origin, as `OTHER_ORIGINS` has none (#426).
 */
const IPV6_ORIGINS = {
  app: 'http://[::1]:43979',
  receive: 'http://[::1]:43978',
  alias: null,
};

/**
 * The names of production's operator a build without its settings carries
 * nowhere: the four issue #369 lists, and the server's address, which the
 * API description's Network section publishes (issue #386).
 */
const PRODUCTION_NAMES =
  /status\.qa-tools\.ru|contact@qa-tools\.ru|firstvds|yandex\s+object\s+storage|80\.87\.198\.166/i;

/**
 * The paragraphs of the Network section of `description` (issue #386): its
 * heading and every paragraph after it up to the next `#` or `##` heading.
 */
function networkParagraphs(description: string): string[] {
  const paragraphs = description.split('\n\n');
  const start = paragraphs.indexOf(NETWORK_HEADING);
  const end = paragraphs.findIndex(
    (paragraph, index) => index > start && /^#{1,2} /.test(paragraph),
  );

  assert.ok(start >= 0 && end > start, 'the description has a Network section');

  return paragraphs.slice(start, end);
}

/**
 * The bullets of the relay section of `text` (#431): the lines from its
 * heading to the next `##` heading that begin one, `- **`.
 */
function relayBullets(text: string): string[] {
  const start = text.indexOf(`\n\n${RELAY_HEADING}\n\n`);

  assert.ok(start >= 0, 'the text has a relay section');

  const end = text.indexOf('\n\n## ', start + 2);

  return text
    .slice(start, end === -1 ? text.length : end)
    .split('\n')
    .filter((line) => line.startsWith('- **'));
}

/** The one line of `text` that begins with `start`, such as a bullet's (#431). */
function lineBeginning(text: string, start: string): string {
  const lines = text.split('\n').filter((line) => line.startsWith(start));

  assert.equal(lines.length, 1, `one line begins "${start}"`);

  return lines[0] as string;
}

/**
 * The one-host wording of the Network section's bullet on the server's
 * address, as a build with no second origin and the operator's texts writes
 * it: the site's host named once, for the site, the API, the WebSocket and
 * the MCP server, and the host that receives webhooks after it (#431).
 */
const oneHostAddress = (site: string, receive: string) =>
  `- **One address: \`${WRITTEN_SERVER_ADDRESS}\`.** \`${site}\` — the site, the API, the WebSocket and the MCP server — and \`${receive}\`, which receives webhooks, all answer on it.`;

/**
 * A made-up relay section, its heading and its bullet on the script's old
 * name, which every description `operatorDescription` reads holds (#431).
 */
const RELAY_PART = `${RELAY_HEADING}\n\n${OLD_NAME_BULLET} It was renamed.`;

/**
 * A made-up bullet on the server's address in the form the build edits,
 * naming one host twice as a build with no second origin names it, which
 * the Network section of every description `operatorDescription` reads with
 * the operator's texts holds; and the bullet as that build writes it, the
 * host named once (#431).
 */
const ADDRESS_LINE =
  '- **One address: `192.0.2.1`.** `x.example` and `x.example` — each the site, the API, the WebSocket and the MCP server, the same on both — and `hook.x.example`, which receives webhooks, all answer on it.';
const ADDRESS_LINE_ONE_HOST =
  '- **One address: `192.0.2.1`.** `x.example` — the site, the API, the WebSocket and the MCP server — and `hook.x.example`, which receives webhooks, all answer on it.';

/**
 * `RELAY_PART`, a made-up Network section, a heading after it and a
 * paragraph ending in the sentence that points at it, which every
 * description `operatorDescription` reads holds (issue #386); and what of
 * them a build without the operator's texts keeps: the relay section, the
 * heading and the paragraph's first sentence.
 */
const SECTIONS_PART = [
  RELAY_PART,
  NETWORK_HEADING,
  `${ADDRESS_LINE}\n${MOVE_BULLET}\`x.example\`.** It moves.`,
  '## Stability',
  `Addresses.${NETWORK_POINTER}`,
].join('\n\n');
const SECTIONS_PART_LEFT = `${RELAY_PART}\n\n## Stability\n\nAddresses.`;

/**
 * A made-up API description that `operatorDescription` reads: the
 * operator's four paragraphs, `SECTIONS_PART` and the paragraphs `rest`. A
 * build without the operator's texts keeps `SECTIONS_PART_LEFT` of it and
 * `rest` less the changelog's links.
 */
function describedWith(...rest: string[]): string {
  return [
    'To check whether Webhook Inspector is up, open https://status.qa-tools.ru.',
    "QA Tools is a tester's personal project.",
    'By using the API or the MCP server, you agree to the Terms of Use.',
    'Subscribe with a feed reader: https://x.example/changelog.xml.',
    SECTIONS_PART,
    ...rest,
  ].join('\n\n');
}

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

      // The second paragraph and the first and third facts: the service's own,
      // the first without its line in the operator's first person (#380).
      assert.deepEqual(story(page), [story(whole)[1]]);
      assert.deepEqual(labels(page), [labels(whole)[0], labels(whole)[2]]);
      assert.deepEqual(page.facts[0]?.lines, [whole.facts[0]?.lines[0], whole.facts[0]?.lines[2]]);
      assert.deepEqual(page.facts[1], whole.facts[2]);
      assert.ok(page.story.flat().every((part) => part.kind !== 'mail'));
      // Its title and description name the service (#380); the rest is the same.
      assert.notEqual(page.title, whole.title);
      assert.notEqual(page.description, whole.description);
      assert.deepEqual(
        { ...page, title: '', description: '', story: [], facts: [] },
        { ...whole, title: '', description: '', story: [], facts: [] },
      );
    }

    for (const page of [aboutEnglish(CONTACT_ONLY), aboutRussian(CONTACT_ONLY)]) {
      const none = page.lang === 'ru' ? aboutRussian(NO_OPERATOR) : aboutEnglish(NO_OPERATOR);

      assert.deepEqual([page.title, page.description], [none.title, none.description]);
      assert.deepEqual(page.facts, none.facts);
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
    // The operator's four paragraphs, and the Network section whole (issue #386).
    assert.equal(
      description.info.description.split('\n\n').length,
      source.info.description.split('\n\n').length -
        4 -
        networkParagraphs(source.info.description).length,
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
        'marked **Breaking** in its entry of the changelog, https://qa-tools.ru/changelog (as text for scripts: https://qa-tools.ru/changelog.md). Entries',
        'marked **Breaking** in its entry of the changelog. Entries',
      ],
    ] as const) {
      assert.ok(source.includes(written), written);
      assert.ok(described.includes(left), left);
    }
    // The Network section's two links go with the section, which is the
    // operator's too since issue #386.
    for (const written of [
      "until the date the changelog's 1.16.0 entry gives, https://qa-tools.ru/changelog, which says what changes then.",
      'and in an entry of the changelog, https://qa-tools.ru/changelog. The one exception',
    ]) {
      assert.ok(networkParagraphs(source).join('\n\n').includes(written), written);
      assert.ok(!described.includes(written.split(', https://')[0] as string), written);
    }
    // Words that name the changelog without linking it stay (Decision 3).
    assert.equal(
      described.match(/until the date the changelog's 1\.19\.0 entry gives/g)?.length,
      source.match(/until the date the changelog's 1\.19\.0 entry gives/g)?.length,
    );
    // Every other paragraph is the source's.
    const network = new Set(networkParagraphs(source));

    assert.deepEqual(
      described.split('\n\n').filter((paragraph) => !/changelog/i.test(paragraph)),
      operatorDescription(source, { ...OTHER_OPERATOR, texts: true })
        .split('\n\n')
        .filter(
          (paragraph) =>
            !/changelog/i.test(paragraph) &&
            !paragraph.startsWith(DESCRIPTION_PARAGRAPHS.about) &&
            !paragraph.startsWith(DESCRIPTION_PARAGRAPHS.legal) &&
            !network.has(paragraph),
        ),
    );
    // With the texts, the links and the sentence are the source's.
    const shown = operatorDescription(source, PRODUCTION_OPERATOR);

    assert.equal(shown, source);
  });

  it('leave a changelog link out on any origin, and refuse one they cannot read, never letting it through (issue #396)', () => {
    const paragraphs = describedWith;

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
      // The four paragraphs before it are the operator's, all left out here,
      // and so is the Network section (issue #386).
      assert.equal(
        operatorDescription(paragraphs(written), NO_OPERATOR),
        `${SECTIONS_PART_LEFT}\n\n${left}`,
        written,
      );
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

  it('leave a changelog link out after an IPv6 origin as after a host name, and refuse one they cannot read (#426)', () => {
    // Origins a build may name, each as `site-origin.mjs` gives it back, and
    // one in capitals, which `URL` would lower but the removal reads anyway.
    for (const origin of [
      IPV6_ORIGINS.app,
      'https://[2001:db8::8a2e:370:7334]',
      'http://[::ffff:102:304]:8080',
      'https://[::]:1',
      'http://[1:2:3:4:5:6:7:8]:65535',
      'http://[FE80::1]:8080',
    ]) {
      assert.equal(parseSiteOrigin('APP_ORIGIN', origin, ''), origin.toLowerCase(), origin);

      for (const [written, left] of [
        [`See it, ${origin}/changelog, now.`, 'See it, now.'],
        [`Read the changelog, ${origin}/changelog.md.`, 'Read the changelog.'],
        [`Feeds, ${origin}/changelog-breaking.xml; and more.`, 'Feeds; and more.'],
        [`End, ${origin}/changelog`, 'End'],
        [`Both (text: ${origin}/changelog.xml) here.`, 'Both here.'],
        [
          `Kept: ${origin}/changelogs and ${origin}/x/changelog.`,
          `Kept: ${origin}/changelogs and ${origin}/x/changelog.`,
        ],
      ] as const) {
        assert.equal(
          operatorDescription(describedWith(written), NO_OPERATOR),
          `${SECTIONS_PART_LEFT}\n\n${left}`,
          written,
        );
        assert.ok(
          operatorDescription(describedWith(written), PRODUCTION_OPERATOR).endsWith(
            `\n\n${written}`,
          ),
          written,
        );
      }
      for (const written of [
        `See ${origin}/changelog for it.`,
        `At ${origin}/changelog.md.`,
        `The page ${origin}/changelog#v1.0.0, once.`,
        `Linked, ${origin}/changelog/ here.`,
      ]) {
        assert.throws(
          () => operatorDescription(describedWith(written), NO_OPERATOR),
          /links the changelog where the build cannot leave the link out/,
          written,
        );
      }
    }
  });

  it('read hostile descriptions at growing sizes in time linear in their length (issue #396)', () => {
    const head = [
      'To check whether Webhook Inspector is up, open https://status.qa-tools.ru.',
      "QA Tools is a tester's personal project.",
      'By using the API or the MCP server, you agree to the Terms of Use.',
      'Subscribe with a feed reader.',
      SECTIONS_PART,
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
          assert.equal(
            operatorDescription(hostile, NO_OPERATOR),
            `${SECTIONS_PART_LEFT}\n\n${body}.`,
          );
        }),
      );
    }

    // Forty times the text in at most about two hundred times the time:
    // linear with room for a busy runner, nowhere near a quadratic scan.
    assert.ok((times[2] as number) < Math.max(200 * (times[0] as number), 3_000), times.join(', '));
  });

  it('read hostile IPv6 hosts at growing sizes in time linear in their length (#426)', () => {
    // Brackets never closed, closed with no path, a port with no digits, a
    // path one letter short, and a parenthesis left open after an address.
    const samples = [
      ', http://[',
      ', https://[::::::::::::',
      ', http://[0:0:0:0:0:0:0:0',
      ', http://[a:http://[a:',
      ', http://[::1]',
      ', http://[::1]:',
      ', http://[::1]:43979/changelo',
      ' (aaaa: http://[::1]:8080',
      ' (a: http://[',
    ];
    const times: number[] = [];

    for (const size of [10_000, 100_000, 400_000]) {
      const body = samples
        .map((sample) => sample.repeat(Math.ceil(size / samples.length / sample.length)))
        .join('');
      const hostile = describedWith(`${body}, ${IPV6_ORIGINS.app}/changelog.`);

      times.push(
        fastestRun(() => {
          // The one link, at the end, is left out; nothing else is a link.
          assert.equal(
            operatorDescription(hostile, NO_OPERATOR),
            `${SECTIONS_PART_LEFT}\n\n${body}.`,
          );
        }),
      );
    }

    // Forty times the text in at most about two hundred times the time:
    // linear with room for a busy runner, nowhere near a quadratic scan.
    assert.ok((times[2] as number) < Math.max(200 * (times[0] as number), 3_000), times.join(', '));
  });

  it('leave the Network section out without the operator’s texts, with the sentence pointing at it, and the move’s bullet alone of it with them and no second origin (issue #386)', () => {
    const source = (JSON.parse(openapi) as { info: { description: string } }).info.description;
    const section = networkParagraphs(source);
    const bullets = (text: string) =>
      networkParagraphs(text)
        .flatMap((paragraph) => paragraph.split('\n'))
        .filter((line) => line.startsWith('- **'));
    const move = bullets(source).find((line) => line.startsWith(MOVE_BULLET)) as string;
    // What else a build with no second origin changes (#431): the relay
    // section's bullet on the old name goes, and the address bullet names
    // the site's host once.
    const oldName = lineBeginning(source, OLD_NAME_BULLET);
    const address = lineBeginning(source, ADDRESS_BULLET);
    const oneHost = oneHostAddress('qa-tools.ru', 'hook.qa-tools.ru');

    // What the source says, which the backend's tests pin to docs/API.md (D204).
    assert.equal(section.length, 3);
    assert.equal(bullets(source).length, 7);
    assert.match(move, /^- \*\*Moving to `webhook\.qa-tools\.ru`\.\*\* Since 1\.16\.0 /);
    assert.ok(section.join('\n\n').includes(`One address: \`${WRITTEN_SERVER_ADDRESS}\``));
    assert.equal(source.split(NETWORK_POINTER).length, 2);

    // Without the texts: no section, no sentence pointing at it, no address,
    // with or without a second origin; the bullet that held the sentence
    // ends where it did, and the next one follows it.
    for (const operator of [NO_OPERATOR, CONTACT_ONLY, OTHER_OPERATOR]) {
      const described = operatorDescription(source, operator);

      assert.equal(
        operatorDescription(source, operator, false),
        described.replace(`${lineBeginning(described, OLD_NAME_BULLET)}\n`, ''),
      );
      for (const paragraph of section) {
        assert.ok(!described.includes(paragraph), paragraph.slice(0, 40));
      }
      assert.doesNotMatch(described, /\bNetwork\b/);
      assert.ok(!described.includes(WRITTEN_SERVER_ADDRESS));
      assert.ok(!described.includes(NETWORK_POINTER.trim()));
      assert.ok(described.includes('the mark was the notice.\n- `info.version`, shown at the top'));
      assert.match(described, /\n\n## Security\n\n\*\*No accounts\.\*\*/);
      assert.equal(described.split('\n\n## ').length, source.split('\n\n## ').length - 1);
    }

    // With the texts and no second origin: the section without the move's
    // bullet, and with #431's two edits, every other byte the source's; with
    // a second origin, the source as it is.
    const oneOrigin = (text: string) =>
      text.replace(`${move}\n`, '').replace(`${oldName}\n`, '').replace(address, oneHost);
    const withoutMove = oneOrigin(source);

    assert.equal(operatorDescription(source, PRODUCTION_OPERATOR, false), withoutMove);
    assert.deepEqual(
      bullets(withoutMove),
      bullets(source)
        .filter((line) => line !== move)
        .map((line) => (line === address ? oneHost : line)),
    );
    assert.equal(operatorDescription(source, PRODUCTION_OPERATOR, true), source);
    assert.equal(operatorDescription(source, PRODUCTION_OPERATOR), source);
    assert.equal(
      operatorDescription(source, { ...OTHER_OPERATOR, texts: true }, false),
      oneOrigin(operatorDescription(source, { ...OTHER_OPERATOR, texts: true })),
    );
    // And so in the file: the bullets' JSON text gone or edited, nothing else.
    const json = (text: string) => JSON.stringify(text).slice(1, -1);

    assert.equal(
      operatorOpenApi(openapi, PRODUCTION_OPERATOR, false),
      openapi
        .replace(json(`${move}\n`), '')
        .replace(json(`${oldName}\n`), '')
        .replace(json(address), json(oneHost)),
    );
    assert.equal(operatorOpenApi(openapi, PRODUCTION_OPERATOR, true), openapi);
  });

  it('leave the move’s bullet out with the lines that go on with it, and a section that ends the description whole (issue #386)', () => {
    const head = [
      'To check whether Webhook Inspector is up, open https://status.qa-tools.ru.',
      "QA Tools is a tester's personal project.",
      'By using the API or the MCP server, you agree to the Terms of Use.',
      'Subscribe with a feed reader.',
    ].join('\n\n');
    // Every description holds the relay section, which a build with no
    // second origin keeps without its bullet on the old name (#431).
    const of = (...rest: string[]) => [head, RELAY_PART, ...rest].join('\n\n');
    const ofOneOrigin = (...rest: string[]) => [head, RELAY_HEADING, ...rest].join('\n\n');

    for (const [network, left] of [
      [`- a\n${MOVE_BULLET}x.** It\n  goes on\n  - and on\n- b`, '- a\n- b'],
      [`- a\n${MOVE_BULLET}x.**\n  last`, '- a'],
      [`${MOVE_BULLET}x.** Alone in its paragraph.`, null],
    ] as const) {
      const written = of(
        'Before.',
        NETWORK_HEADING,
        'Intro:',
        ADDRESS_LINE,
        network,
        '### Inside',
        '## After',
        `Text.${NETWORK_POINTER}`,
      );

      assert.equal(
        operatorDescription(written, PRODUCTION_OPERATOR, false),
        ofOneOrigin(
          'Before.',
          NETWORK_HEADING,
          'Intro:',
          ADDRESS_LINE_ONE_HOST,
          ...(left === null ? [] : [left]),
          '### Inside',
          '## After',
          `Text.${NETWORK_POINTER}`,
        ),
        network,
      );
      assert.equal(operatorDescription(written, PRODUCTION_OPERATOR, true), written);
      // Without the texts, a `###` heading is the section's own, and `##` ends it.
      assert.equal(
        operatorDescription(written, NO_OPERATOR),
        `${RELAY_PART}\n\nBefore.\n\n## After\n\nText.`,
      );
    }

    // A section that ends the description, or a `#` heading that ends it.
    assert.equal(
      operatorDescription(
        of(`Text.${NETWORK_POINTER}`, NETWORK_HEADING, `${MOVE_BULLET}x.**`, '- **Last.**'),
        NO_OPERATOR,
      ),
      `${RELAY_PART}\n\nText.`,
    );
    assert.equal(
      operatorDescription(
        of(NETWORK_HEADING, `${MOVE_BULLET}x.**`, '# Top', `Text.${NETWORK_POINTER}`),
        NO_OPERATOR,
      ),
      `${RELAY_PART}\n\n# Top\n\nText.`,
    );
    // Words that only look like the section's name stay.
    assert.equal(
      operatorDescription(
        of(
          NETWORK_HEADING,
          `${MOVE_BULLET}x.**`,
          '## After',
          `Networks, xNetworkx and a network.${NETWORK_POINTER}`,
        ),
        NO_OPERATOR,
      ),
      `${RELAY_PART}\n\n## After\n\nNetworks, xNetworkx and a network.`,
    );
    // An empty paragraph of the source, as two blank lines in a code block
    // write one, stays in every build, in either section too (#431).
    const blank = of(
      '```text\na\n\n\n\nb\n```',
      NETWORK_HEADING,
      ADDRESS_LINE,
      '',
      `${MOVE_BULLET}x.**`,
      '## After',
      `Text.${NETWORK_POINTER}`,
    ).replace(RELAY_PART, `${RELAY_PART}\n\n`);

    assert.ok(blank.includes(`${OLD_NAME_BULLET} It was renamed.\n\n\n\n`));
    assert.equal(operatorDescription(blank, PRODUCTION_OPERATOR), blank);
    assert.equal(
      operatorDescription(blank, PRODUCTION_OPERATOR, false),
      blank
        .replace(`\n\n${OLD_NAME_BULLET} It was renamed.`, '')
        .replace(ADDRESS_LINE, ADDRESS_LINE_ONE_HOST)
        .replace(`\n\n${MOVE_BULLET}x.**`, ''),
    );
    assert.equal(
      operatorDescription(blank, NO_OPERATOR, false),
      `${RELAY_HEADING}\n\n\n\n\`\`\`text\na\n\n\n\nb\n\`\`\`\n\n## After\n\nText.`,
    );
  });

  it('refuse a description without the Network section, the sentence or the bullet, and one that names the address or the section elsewhere without the texts (issue #386)', () => {
    const source = (JSON.parse(openapi) as { info: { description: string } }).info.description;

    for (const [broken, refusal] of [
      [
        source.replace('\n\n## Network\n\n', '\n\n## Network access\n\n'),
        /0 paragraphs that are "## Network", not one/,
      ],
      [
        source.replace('\n\n## Security\n\n', '\n\n## Network\n\n'),
        /2 paragraphs that are "## Network", not one/,
      ],
      [
        source.replace(NETWORK_POINTER, ' A change of address has a notice of its own.'),
        /does not hold once the sentence/,
      ],
      [
        source.replace('**No accounts.**', `**No accounts.**${NETWORK_POINTER}`),
        /does not hold once the sentence/,
      ],
      [
        source.replace(MOVE_BULLET, '- **Move to '),
        /Network section has 0 bullets beginning "- \*\*Moving to ", not one/,
      ],
      [
        source.replace(MOVE_BULLET, `${MOVE_BULLET}a.**\n${MOVE_BULLET}`),
        /Network section has 2 bullets/,
      ],
      // The bullet outside the section is not the section's.
      [
        source
          .replace(MOVE_BULLET, '- **Move to ')
          .replace('- `info.version`', `${MOVE_BULLET}x.**\n- \`info.version\``),
        /Network section has 0 bullets/,
      ],
    ] as const) {
      assert.notEqual(broken, source);
      for (const operator of [NO_OPERATOR, PRODUCTION_OPERATOR]) {
        assert.throws(() => operatorDescription(broken, operator), refusal);
        assert.throws(() => operatorDescription(broken, operator, false), refusal);
      }
    }

    // The address or the section named outside it: refused without the
    // texts, which would leave it in; the source's own with them.
    for (const named of [
      source.replace(
        '**No accounts.**',
        `**No accounts.** The server is ${WRITTEN_SERVER_ADDRESS}.`,
      ),
      source.replace('**No accounts.**', '**No accounts.** See Network above.'),
      source.replace('the mark was the notice.', 'the mark was the notice (Network).'),
    ]) {
      assert.throws(
        () => operatorDescription(named, NO_OPERATOR),
        /names the server's address or its Network section outside it/,
      );
      assert.doesNotThrow(() => operatorDescription(named, PRODUCTION_OPERATOR, false));
    }
  });

  it('write a status page whose address names Network or the server’s address without the operator’s texts, the Network section left out and the source still refused for naming either (#430)', () => {
    const source = (JSON.parse(openapi) as { info: { description: string } }).info.description;
    const section = networkParagraphs(source);
    const isStatus = (paragraph: string) => paragraph.startsWith(DESCRIPTION_PARAGRAPHS.status);
    const names = (paragraph: string) =>
      /\bNetwork\b/.test(paragraph) || paragraph.includes(WRITTEN_SERVER_ADDRESS);
    // What a build with no status page keeps: the paragraphs besides its sentence.
    const withoutPage = operatorDescription(source, NO_OPERATOR).split('\n\n');

    for (const raw of [
      'https://status.example.com/Network',
      'https://status.example.com/Network/',
      'https://status.example.com/see/Network.html',
      `https://status.example.com/${WRITTEN_SERVER_ADDRESS}`,
      `https://status.example.com/Network/${WRITTEN_SERVER_ADDRESS}/Network`,
    ]) {
      const page = parseStatusPageUrl(raw) as string;

      for (const operator of [
        parseOperator({ STATUS_PAGE_URL: raw }),
        parseOperator({ STATUS_PAGE_URL: raw, CONTACT_EMAIL: 'hello@inspector.example' }),
      ]) {
        assert.equal(operator.texts, false);

        const described = operatorDescription(source, operator);
        const paragraphs = described.split('\n\n');

        // No Network section and no sentence pointing at it.
        for (const paragraph of section) {
          assert.ok(!described.includes(paragraph), paragraph.slice(0, 40));
        }
        assert.ok(!described.includes(NETWORK_POINTER.trim()));
        // The status sentence names the operator's page, and only it names
        // the word or the address; every other paragraph is what a build
        // with no status page keeps.
        assert.deepEqual(paragraphs.filter(isStatus), [
          `To check whether Webhook Inspector is up — say, when a test that uses it fails — open ${statusPageInProse(page)}: the site, the API and webhook receiving, each checked every minute from outside, with its uptime history and reports of outages.`,
        ]);
        assert.deepEqual(paragraphs.filter(names), paragraphs.filter(isStatus));
        assert.deepEqual(
          paragraphs.filter((paragraph) => !isStatus(paragraph)),
          withoutPage,
        );
        // And so in the file the build serves.
        assert.equal(
          (JSON.parse(operatorOpenApi(openapi, operator)) as { info: { description: string } }).info
            .description,
          described,
        );
      }
    }

    // A source that names the address or the section outside it is refused
    // still, whatever the status page.
    const network = parseOperator({ STATUS_PAGE_URL: 'https://status.example.com/Network' });
    const refusal = /names the server's address or its Network section outside it/;

    for (const named of [
      source.replace(
        '**No accounts.**',
        `**No accounts.** The server is ${WRITTEN_SERVER_ADDRESS}.`,
      ),
      source.replace('**No accounts.**', '**No accounts.** See Network above.'),
      source.replace('the mark was the notice.', 'the mark was the notice (Network).'),
    ]) {
      assert.notEqual(named, source);
      for (const operator of [network, OTHER_OPERATOR, NO_OPERATOR]) {
        assert.throws(() => operatorDescription(named, operator), refusal);
      }
    }

    // So is a status sentence of the source that names either, read before
    // the page is written in; with no status page the sentence is left out.
    for (const named of [
      source.replace(
        `open ${WRITTEN_STATUS_PAGE_IN_PROSE}:`,
        `open ${WRITTEN_STATUS_PAGE_IN_PROSE}, or see Network:`,
      ),
      source.replace(
        DESCRIPTION_PARAGRAPHS.status,
        `${DESCRIPTION_PARAGRAPHS.status} on ${WRITTEN_SERVER_ADDRESS}`,
      ),
    ]) {
      assert.notEqual(named, source);
      for (const operator of [network, OTHER_OPERATOR]) {
        assert.throws(() => operatorDescription(named, operator), refusal);
      }
      assert.equal(operatorDescription(named, NO_OPERATOR), withoutPage.join('\n\n'));
    }
  });

  it('write a hostile status page that names Network and the server’s address at growing sizes in time linear in its length (#430)', () => {
    const source = (JSON.parse(openapi) as { info: { description: string } }).info.description;
    const withoutPage = operatorDescription(source, NO_OPERATOR);
    const times: number[] = [];

    for (const size of [10_000, 100_000, 400_000]) {
      const sample = `/Network/${WRITTEN_SERVER_ADDRESS}/xNetworkx/Network.`;
      const raw = `https://status.example.com${sample.repeat(Math.ceil(size / sample.length))}`;
      const operator = parseOperator({ STATUS_PAGE_URL: raw });
      const page = statusPageInProse(operator.statusPageUrl as string);

      assert.ok(page.length >= size);
      times.push(
        fastestRun(() => {
          const paragraphs = operatorDescription(source, operator).split('\n\n');
          const status = paragraphs.filter((paragraph) =>
            paragraph.startsWith(DESCRIPTION_PARAGRAPHS.status),
          );

          assert.equal(status.length, 1);
          assert.ok((status[0] as string).includes(` open ${page}: the site`));
          assert.equal(
            paragraphs.filter((paragraph) => paragraph !== status[0]).join('\n\n'),
            withoutPage,
          );
        }),
      );
    }

    // Forty times the text in at most about two hundred times the time:
    // linear with room for a busy runner, nowhere near a quadratic scan.
    assert.ok((times[2] as number) < Math.max(200 * (times[0] as number), 3_000), times.join(', '));
  });

  it('write a status page whose path is the changelog’s without the operator’s texts, its sentence kept and none of the changelog’s links, the source still refused for a link it cannot leave out (#446)', () => {
    const source = (JSON.parse(openapi) as { info: { description: string } }).info.description;
    const isStatus = (paragraph: string) => paragraph.startsWith(DESCRIPTION_PARAGRAPHS.status);
    // What a build with no status page keeps: the paragraphs besides its
    // sentence, none of them linking the changelog.
    const withoutPage = operatorDescription(source, NO_OPERATOR).split('\n\n');

    assert.deepEqual(check.changelogLinksIn(withoutPage.join('\n\n')), []);

    for (const raw of [
      'https://status.example.com/changelog',
      'https://status.example.com/changelog/',
      'https://status.example.com/changelog.md',
      'https://status.example.com/changelog.xml',
      'https://status.example.com/changelog-breaking.xml',
      'http://status.example.com:8443/changelog',
      'https://status.example.com/changelog/changelog.md',
      `https://status.example.com/changelog/${WRITTEN_SERVER_ADDRESS}/Network`,
    ]) {
      const page = parseStatusPageUrl(raw) as string;

      // Each reads as a link to the changelog where a text names it.
      assert.notDeepEqual(check.changelogLinksIn(` ${statusPageInProse(page)}: `), [], raw);

      for (const operator of [
        parseOperator({ STATUS_PAGE_URL: raw }),
        parseOperator({ STATUS_PAGE_URL: raw, CONTACT_EMAIL: 'hello@inspector.example' }),
      ]) {
        assert.equal(operator.texts, false);

        const described = operatorDescription(source, operator);
        const paragraphs = described.split('\n\n');

        // The status sentence names the operator's page; every other
        // paragraph is what a build with no status page keeps.
        assert.deepEqual(paragraphs.filter(isStatus), [
          `To check whether Webhook Inspector is up — say, when a test that uses it fails — open ${statusPageInProse(page)}: the site, the API and webhook receiving, each checked every minute from outside, with its uptime history and reports of outages.`,
        ]);
        assert.deepEqual(
          paragraphs.filter((paragraph) => !isStatus(paragraph)),
          withoutPage,
        );
        // And so in the file the build serves.
        assert.equal(
          (JSON.parse(operatorOpenApi(openapi, operator)) as { info: { description: string } }).info
            .description,
          described,
        );
      }
    }

    // A source that links the changelog where the build cannot leave the
    // link out is refused still, whatever the status page.
    const changelog = parseOperator({ STATUS_PAGE_URL: 'https://status.example.com/changelog' });
    const refusal = /links the changelog where the build cannot leave the link out/;
    const linked = source.replace(
      '**No accounts.**',
      '**No accounts.** See https://qa-tools.ru/changelog for them.',
    );

    assert.notEqual(linked, source);
    for (const operator of [changelog, OTHER_OPERATOR, NO_OPERATOR]) {
      assert.throws(() => operatorDescription(linked, operator), refusal);
    }

    // So is a status sentence of the source that links it, read before the
    // page is written in; with no status page the sentence is left out.
    for (const named of [
      source.replace(
        `open ${WRITTEN_STATUS_PAGE_IN_PROSE}:`,
        `open ${WRITTEN_STATUS_PAGE_IN_PROSE} or https://qa-tools.ru/changelog:`,
      ),
      source.replace(
        DESCRIPTION_PARAGRAPHS.status,
        `${DESCRIPTION_PARAGRAPHS.status} at https://qa-tools.ru/changelog.md`,
      ),
    ]) {
      assert.notEqual(named, source);
      for (const operator of [changelog, OTHER_OPERATOR]) {
        assert.throws(() => operatorDescription(named, operator), refusal);
      }
      assert.equal(operatorDescription(named, NO_OPERATOR), withoutPage.join('\n\n'));
    }
  });

  it('write a hostile status page that names the changelog’s addresses at growing sizes in time linear in its length (#446)', () => {
    const source = (JSON.parse(openapi) as { info: { description: string } }).info.description;
    const withoutPage = operatorDescription(source, NO_OPERATOR);
    const times: number[] = [];

    for (const size of [10_000, 100_000, 400_000]) {
      const sample = '/changelog/changelog.md/changelog-breaking.xml/changelog.xml/changelogs';
      const raw = `https://status.example.com${sample.repeat(Math.ceil(size / sample.length))}/changelog`;
      const operator = parseOperator({ STATUS_PAGE_URL: raw });
      const page = statusPageInProse(operator.statusPageUrl as string);

      assert.ok(page.length >= size);
      times.push(
        fastestRun(() => {
          const paragraphs = operatorDescription(source, operator).split('\n\n');
          const status = paragraphs.filter((paragraph) =>
            paragraph.startsWith(DESCRIPTION_PARAGRAPHS.status),
          );

          assert.equal(status.length, 1);
          assert.ok((status[0] as string).includes(` open ${page}: the site`));
          assert.equal(
            paragraphs.filter((paragraph) => paragraph !== status[0]).join('\n\n'),
            withoutPage,
          );
        }),
      );
    }

    // Forty times the text in at most about two hundred times the time:
    // linear with room for a busy runner, nowhere near a quadratic scan.
    assert.ok((times[2] as number) < Math.max(200 * (times[0] as number), 3_000), times.join(', '));
  });

  it('read hostile Network sections at growing sizes in time linear in their length (issue #386)', () => {
    const head = [
      'To check whether Webhook Inspector is up, open https://status.qa-tools.ru.',
      "QA Tools is a tester's personal project.",
      'By using the API or the MCP server, you agree to the Terms of Use.',
      'Subscribe with a feed reader.',
    ].join('\n\n');
    const repeat = (sample: string, size: number) =>
      sample.repeat(Math.ceil(size / 3 / sample.length));
    const times: number[] = [];

    for (const size of [10_000, 100_000, 400_000]) {
      // Lines that begin like the bullet, or like a bullet, and are not.
      const lines = repeat('- **Moving t\n- \n  \n#\n', size);
      // Paragraphs inside the section that look like the headings that end it.
      const inside = repeat('### Networ\n\n#\n\n#x\n\n', size);
      // Words like the section's name, and an address one digit short.
      const outside = repeat(' xNetworkx 80.87.198.16 Networks', size);
      const bullets = `${ADDRESS_LINE}\n${lines}${MOVE_BULLET}x.** It moves.\n  on\n- kept`;
      const hostile = [
        head,
        RELAY_PART,
        NETWORK_HEADING,
        bullets,
        `${inside}end`,
        '## Stability',
        `${outside}${NETWORK_POINTER}`,
      ].join('\n\n');

      times.push(
        fastestRun(() => {
          assert.equal(
            operatorDescription(hostile, NO_OPERATOR),
            `${RELAY_PART}\n\n## Stability\n\n${outside}`,
          );
          // With no second origin the relay section's bullet goes and the
          // address bullet names one host too (#431).
          assert.equal(
            operatorDescription(hostile, PRODUCTION_OPERATOR, false),
            hostile
              .replace(RELAY_PART, RELAY_HEADING)
              .replace(`${MOVE_BULLET}x.** It moves.\n  on\n`, '')
              .replace(ADDRESS_LINE, ADDRESS_LINE_ONE_HOST),
          );
        }),
      );
    }

    // Forty times the text in at most about two hundred times the time:
    // linear with room for a busy runner, nowhere near a quadratic scan.
    assert.ok((times[2] as number) < Math.max(200 * (times[0] as number), 3_000), times.join(', '));
  });

  it('leave the relay section’s bullet on the old name out with no second origin, with the operator’s texts or without, and name the site’s host once in the address bullet with them (#431)', () => {
    const source = (JSON.parse(openapi) as { info: { description: string } }).info.description;
    const oldName = lineBeginning(source, OLD_NAME_BULLET);
    const address = lineBeginning(source, ADDRESS_BULLET);

    // What the source says: production's rename and move, and its two hosts.
    assert.match(
      oldName,
      /^- \*\*Its old name\.\*\* Until 1\.16\.0 the script was `qa-tools-relay\.mjs`/,
    );
    assert.ok(oldName.includes('on both hosts'));
    assert.equal(
      address,
      `- **One address: \`${WRITTEN_SERVER_ADDRESS}\`.** \`qa-tools.ru\` and \`webhook.qa-tools.ru\` — each the site, the API, the WebSocket and the MCP server, the same on both — and \`hook.qa-tools.ru\`, which receives webhooks, all answer on it.`,
    );

    for (const operator of [
      NO_OPERATOR,
      CONTACT_ONLY,
      OTHER_OPERATOR,
      PRODUCTION_OPERATOR,
      { ...OTHER_OPERATOR, texts: true },
    ]) {
      const kept = operatorDescription(source, operator);
      const one = operatorDescription(source, operator, false);

      // The relay section loses that bullet alone, with or without the texts.
      assert.ok(kept.includes(OLD_NAME_BULLET));
      assert.ok(!one.includes(OLD_NAME_BULLET));
      assert.ok(!one.includes('qa-tools-relay.mjs'));
      assert.deepEqual(
        relayBullets(one),
        relayBullets(kept).filter((line) => !line.startsWith(OLD_NAME_BULLET)),
      );
      assert.ok(one.includes('mjs` is a script of one file that you run next to that service'));
    }

    // With the texts, named for a copy with no second origin as the build
    // names it: the address bullet in the one-host wording such a build
    // writes, the site's host named once.
    for (const operator of [PRODUCTION_OPERATOR, { ...OTHER_OPERATOR, texts: true }]) {
      const copy = (
        JSON.parse(openApiText(OTHER_ORIGINS, operator)) as { info: { description: string } }
      ).info.description;
      const line = lineBeginning(copy, ADDRESS_BULLET);

      assert.equal(line, oneHostAddress('inspector.example', 'hook.inspector.example'));
      assert.equal(line.split('`inspector.example`').length, 2);
      assert.ok(!copy.includes(OLD_NAME_BULLET));
      assert.ok(!copy.includes('the same on both'));
    }
  });

  it('keep both bullets in a build with a second origin of its own, naming its own hosts (#431)', () => {
    const source = (JSON.parse(openapi) as { info: { description: string } }).info.description;
    const origins = { ...OTHER_ORIGINS, alias: 'https://next.inspector.example' };
    // The source's line as the rename writes it for these origins.
    const renamed = (line: string) =>
      line
        .replaceAll('https://webhook.qa-tools.ru', origins.alias)
        .replaceAll('https://qa-tools.ru', origins.app)
        .replaceAll('`webhook.qa-tools.ru`', '`next.inspector.example`')
        .replaceAll('`hook.qa-tools.ru`', '`hook.inspector.example`')
        .replaceAll('`qa-tools.ru`', '`inspector.example`');

    for (const operator of [PRODUCTION_OPERATOR, { ...OTHER_OPERATOR, texts: true }]) {
      const copy = (JSON.parse(openApiText(origins, operator)) as { info: { description: string } })
        .info.description;

      assert.equal(
        lineBeginning(copy, OLD_NAME_BULLET),
        renamed(lineBeginning(source, OLD_NAME_BULLET)),
      );
      assert.equal(
        lineBeginning(copy, ADDRESS_BULLET),
        `- **One address: \`${WRITTEN_SERVER_ADDRESS}\`.** \`inspector.example\` and \`next.inspector.example\` — each the site, the API, the WebSocket and the MCP server, the same on both — and \`hook.inspector.example\`, which receives webhooks, all answer on it.`,
      );
      assert.ok(copy.includes(MOVE_BULLET));
    }
    // Without the texts the address bullet goes with its section, and the
    // bullet on the old name stays, its link to the changelog left out.
    const bare = (
      JSON.parse(openApiText(origins, NO_OPERATOR)) as { info: { description: string } }
    ).info.description;

    assert.ok(!bare.includes(ADDRESS_BULLET));
    assert.ok(
      lineBeginning(bare, OLD_NAME_BULLET).endsWith(
        `until the date its 1.16.0 entry gives, which says what happens to it then. Before 1.19.0 it served the script as it was, reading \`${origins.app}\` by default.`,
      ),
    );
  });

  it('refuse a description without one bullet on the old name in the relay section, or, with the texts, without one address bullet in the form the edit reads, naming the part (#431)', () => {
    const source = (JSON.parse(openapi) as { info: { description: string } }).info.description;
    const address = lineBeginning(source, ADDRESS_BULLET);
    const withTexts = [PRODUCTION_OPERATOR, { ...OTHER_OPERATOR, texts: true }];

    // The relay section and its bullet, refused for every build.
    for (const [broken, refusal] of [
      [
        source.replace(OLD_NAME_BULLET, '- **Its former name.**'),
        /relay section \("## Forward to a local service"\) has 0 bullets beginning "- \*\*Its old name\.\*\*", not one/,
      ],
      [
        source.replace(OLD_NAME_BULLET, `${OLD_NAME_BULLET} Twice.\n${OLD_NAME_BULLET}`),
        /relay section \("## Forward to a local service"\) has 2 bullets beginning/,
      ],
      // The bullet outside the section is not the section's.
      [
        source
          .replace(OLD_NAME_BULLET, '- **Its former name.**')
          .replace('- `info.version`', `${OLD_NAME_BULLET} Elsewhere.\n- \`info.version\``),
        /relay section \("## Forward to a local service"\) has 0 bullets/,
      ],
      // A heading of the section's own ends nothing; one of its level does.
      [
        source.replace(`\n${OLD_NAME_BULLET}`, `\n\n## Old names\n\n${OLD_NAME_BULLET}`),
        /relay section \("## Forward to a local service"\) has 0 bullets/,
      ],
      [
        source.replace(`\n\n${RELAY_HEADING}\n\n`, '\n\n## Forward to a local server\n\n'),
        /0 paragraphs that are "## Forward to a local service", not one/,
      ],
      [
        source.replace('\n\n## Errors\n\n', `\n\n${RELAY_HEADING}\n\n`),
        /2 paragraphs that are "## Forward to a local service", not one/,
      ],
    ] as const) {
      assert.notEqual(broken, source);
      for (const operator of [NO_OPERATOR, CONTACT_ONLY, ...withTexts]) {
        assert.throws(() => operatorDescription(broken, operator), refusal);
        assert.throws(() => operatorDescription(broken, operator, false), refusal);
      }
    }
    assert.doesNotThrow(() =>
      operatorDescription(
        source.replace(`\n${OLD_NAME_BULLET}`, `\n\n### Old names\n\n${OLD_NAME_BULLET}`),
        NO_OPERATOR,
        false,
      ),
    );

    // The address bullet, refused with the texts; without them the section
    // goes whole, and the build writes what it writes for the source.
    const count = /Network section has (\d) bullets beginning "- \*\*One address", not one/;
    const form =
      /Network section has its bullet beginning "- \*\*One address" in a form the build cannot write for one host/;

    for (const [broken, refusal] of [
      [source.replace(address, address.replace('- **One address', '- **The address')), count],
      [source.replace(address, `${address}\n${address}`), count],
      [source.replace(address, address.replace(' — each the site,', ' — both the site,')), form],
      [source.replace(address, address.replace(', the same on both —', ' —')), form],
      [
        source.replace(address, address.replace('` and `webhook.', '`, `a.example` and `webhook.')),
        form,
      ],
      [source.replace(address, address.replace(' — and `hook.', ' —\n  and `hook.')), form],
      [source.replace(address, `${address} Twice.`), form],
      [source.replace(address, address.replace('`qa-tools.ru`', '``')), form],
      [
        source.replace(address, address.replace('One address: `80.87.198.166`.', 'One address.')),
        form,
      ],
    ] as const) {
      assert.notEqual(broken, source);
      for (const operator of withTexts) {
        assert.throws(() => operatorDescription(broken, operator), refusal);
        assert.throws(() => operatorDescription(broken, operator, false), refusal);
      }
      for (const operator of [NO_OPERATOR, CONTACT_ONLY]) {
        for (const hasMove of [true, false]) {
          assert.equal(
            operatorDescription(broken, operator, hasMove),
            operatorDescription(source, operator, hasMove),
          );
        }
      }
    }

    // One outside the section is not the section's; without the texts that
    // one is refused for naming the server's address outside the section.
    const outside = source
      .replace(address, address.replace('- **One address', '- **The address'))
      .replace('- `info.version`', `${address}\n- \`info.version\``);

    for (const operator of withTexts) {
      assert.throws(
        () => operatorDescription(outside, operator, false),
        /has 0 bullets beginning "- \*\*One address"/,
      );
    }
    assert.throws(
      () => operatorDescription(outside, NO_OPERATOR, false),
      /names the server's address or its Network section outside it/,
    );
  });

  it('read hostile relay sections and address bullets at growing sizes in time linear in their length, refusing the ones the edit cannot read (#431)', () => {
    const head = [
      'To check whether Webhook Inspector is up, open https://status.qa-tools.ru.',
      "QA Tools is a tester's personal project.",
      'By using the API or the MCP server, you agree to the Terms of Use.',
      'Subscribe with a feed reader.',
    ].join('\n\n');
    const repeat = (sample: string, size: number) =>
      sample.repeat(Math.ceil(size / 3 / sample.length));
    const network = (bullet: string) => [
      NETWORK_HEADING,
      `${bullet}\n${MOVE_BULLET}x.**`,
      '## Stability',
      `Text.${NETWORK_POINTER}`,
    ];
    const times: number[] = [];

    for (const size of [10_000, 100_000, 400_000]) {
      // Lines that begin like the old name's bullet, or like a bullet, and are not.
      const lines = repeat('- **Its old nam\n- **Its old\n- \n  \n#\n', size);
      // Paragraphs inside the section that look like the headings that end it.
      const inside = repeat('### Forward\n\n#\n\n#x\n\n', size);
      // Hosts as long as the text, which the edit keeps or drops whole.
      const host = repeat('a-b.', size);
      const relay = `${lines}${OLD_NAME_BULLET} It was\n  renamed.\n- kept`;
      const bullet = `- **One address: \`192.0.2.1\`.** \`${host}x\` and \`${host}x\` — each the site, the API, the WebSocket and the MCP server, the same on both — and \`hook.${host}x\`, which receives webhooks, all answer on it.`;
      const hostile = [head, RELAY_HEADING, relay, `${inside}end`, ...network(bullet)].join('\n\n');
      const expected = [
        head,
        RELAY_HEADING,
        `${lines}- kept`,
        `${inside}end`,
        NETWORK_HEADING,
        `- **One address: \`192.0.2.1\`.** \`${host}x\` — the site, the API, the WebSocket and the MCP server — and \`hook.${host}x\`, which receives webhooks, all answer on it.`,
        '## Stability',
        `Text.${NETWORK_POINTER}`,
      ].join('\n\n');
      // Address bullets the edit cannot read: a backtick never closed, the
      // words that join the hosts over and over, the comparison cut short,
      // and the receive host never closed.
      const unread = [
        `- **One address: \`${host}`,
        `- **One address: \`a\`.** \`${repeat('x and `', size)}`,
        `- **One address: \`a\`.** \`b\` and \`${repeat('c` — each the site, ', size)}`,
        `- **One address: \`a\`.** \`b\` and \`c\` — each the site, the API, the WebSocket and the MCP server, the same on both — and \`${host}`,
      ];

      times.push(
        fastestRun(() => {
          assert.equal(operatorDescription(hostile, PRODUCTION_OPERATOR, false), expected);
          assert.equal(operatorDescription(hostile, PRODUCTION_OPERATOR, true), hostile);
          for (const line of unread) {
            const broken = [head, RELAY_HEADING, relay, ...network(line)].join('\n\n');

            assert.throws(
              () => operatorDescription(broken, PRODUCTION_OPERATOR, false),
              /its bullet beginning "- \*\*One address" in a form the build cannot write/,
            );
          }
          // Bullets of the relay section that only look like the old name's.
          assert.throws(
            () =>
              operatorDescription(
                [head, RELAY_HEADING, `${lines}- kept`, ...network(ADDRESS_LINE)].join('\n\n'),
                NO_OPERATOR,
              ),
            /relay section \("## Forward to a local service"\) has 0 bullets/,
          );
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
    // No Network section, no sentence pointing at it, no server address (issue #386).
    for (const text of [files['openapi.json'] as string, llmsFiles['llms-full.txt']]) {
      assert.ok(!text.includes(NETWORK_HEADING));
      assert.ok(!text.includes(NETWORK_POINTER.trim()));
      assert.ok(!text.includes(WRITTEN_SERVER_ADDRESS));
    }
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

  it('are what the build writes at IPv6 origins: no changelog link, and the description a host name copy’s (#426)', () => {
    const files = siteFiles(IPV6_ORIGINS, NO_OPERATOR);
    const llmsFiles = buildLlmsFiles(IPV6_ORIGINS, NO_OPERATOR);
    const described = (text: string) =>
      (JSON.parse(text) as { info: { description: string } }).info.description;
    const description = described(files['openapi.json'] as string);

    // Named for the IPv6 origins, so the links below were there to leave out.
    assert.ok(description.includes(`${IPV6_ORIGINS.app}/`));
    assert.equal(described(openapi).match(/https:\/\/qa-tools\.ru\/changelog\b/g)?.length, 7);
    // No link to the changelog in the files that carry the description, nor
    // in the others the build writes from the same sources; `/docs`'s head
    // links its feeds relative to any origin.
    for (const [name, text] of [
      ['openapi.json', files['openapi.json'] as string],
      ['llms-full.txt', llmsFiles['llms-full.txt']],
      ['llms.txt', llmsFiles['llms.txt']],
      ['sitemap.xml', files['sitemap.xml'] as string],
      ['docs/index.html', operatorDocsPage(read('../../docs/index.html'), NO_OPERATOR)],
    ] as const) {
      assert.deepEqual(check.changelogLinksIn(text), [], name);
      assert.doesNotMatch(text, /\/changelog|Subscribe with a feed reader/, name);
    }
    // The parenthesis left out with its links. The apposition is in the
    // relay section's bullet on the old name, which only a build with a
    // second origin keeps (#431): one at an IPv6 origin of its own leaves
    // it out with its link too.
    assert.ok(description.includes('marked **Breaking** in its entry of the changelog. Entries'));
    assert.ok(!description.includes(OLD_NAME_BULLET));

    const withSecond = described(
      openApiText({ ...IPV6_ORIGINS, alias: 'http://[::1]:43977' }, NO_OPERATOR),
    );

    assert.ok(withSecond.includes(`${OLD_NAME_BULLET} Until 1.16.0`));
    assert.ok(
      withSecond.includes(
        'until the date its 1.16.0 entry gives, which says what happens to it then.',
      ),
    );
    assert.deepEqual(check.changelogLinksIn(withSecond), []);

    // A copy at host names on the same scheme and ports, whose files differ
    // from these only in the host: read back with its hosts, each file is
    // that copy's, so the build left out at an IPv6 origin what it leaves
    // out at a host name. The relay script's SHA-256 differs, the script
    // naming its own origin.
    const named = {
      app: 'http://inspector.example:43979',
      receive: 'http://hook.inspector.example:43978',
      alias: null,
    };
    const asHostNames = (text: string) =>
      text
        .replaceAll('[::1]:43979', 'inspector.example:43979')
        .replaceAll('[::1]:43978', 'hook.inspector.example:43978');
    const unhashed = (text: string) => text.replace(/\b[0-9a-f]{64}\b/g, '<sha-256>');

    assert.ok(!openapi.includes('[::1]') && !openapi.includes('inspector.example'));
    assert.equal(
      unhashed(asHostNames(description)),
      unhashed(described(openApiText(named, NO_OPERATOR))),
    );
    assert.equal(
      unhashed(asHostNames(llmsFiles['llms-full.txt'])),
      unhashed(buildLlmsFiles(named, NO_OPERATOR)['llms-full.txt']),
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
      [
        'status.qa-tools.ru',
        'contact@qa-tools.ru',
        'FirstVDS',
        'Yandex Object Storage',
        '80.87.198.166',
      ],
    );
    // The address the build check looks for is the one the description
    // written for production publishes (issue #386).
    assert.equal(check.OPERATOR_NAMES[4]?.name, WRITTEN_SERVER_ADDRESS);

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
      ['80.87.198.166', 'Allow outgoing connections to `80.87.198.166` on port 443'],
      ['80.87.198.166', '180.87.198.1666'],
      ['80.87.198.166', '80%2e87%2E198.166'],
      ['80.87.198.166', '80&#46;87&#x2E;198&period;166'],
      ['80.87.198.166', '80\\u002e87\\x2e198.166'],
      ['80.87.198.166', '80.87.\n198.166'],
      ['80.87.198.166', '80 . 87 .\t198 . 166'],
      ['80.87.198.166', '80.87.198.<br />166'],
      ['80.87.198.166', '80.87.198.\\n166'],
      ['80.87.198.166', '80&nbsp;.87.198.166'],
    ]) {
      assert.deepEqual(left(textOf as string), [found], JSON.stringify(textOf));
    }

    assert.deepEqual(
      left('Yandex 360, Object Storage, qa-tools.ru, status: ok, contact@example.com'),
      [],
    );
    assert.deepEqual(left('Yandex Object-Storage'), []);
    assert.deepEqual(
      left('80.87.198.165, 80.87.198, 8.87.198.166, 80,87,198,166, 80-87-198-166, 80.87.198.16'),
      [],
    );
  });

  it('reads what the build’s own settings name as theirs', () => {
    const all =
      'status.qa-tools.ru contact@qa-tools.ru FirstVDS Yandex Object Storage 80.87.198.166';

    assert.deepEqual(left(all, PRODUCTION_OPERATOR), []);
    assert.deepEqual(left(all, OTHER_OPERATOR), [
      'status.qa-tools.ru',
      'contact@qa-tools.ru',
      'FirstVDS',
      'Yandex Object Storage',
      '80.87.198.166',
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

  it('reads the build’s own status page out whole where its path holds the server’s address, and finds the address anywhere else (#446)', () => {
    const page = `https://status.example.com/${WRITTEN_SERVER_ADDRESS}`;

    for (const operator of [
      parseOperator({ STATUS_PAGE_URL: page }),
      parseOperator({ STATUS_PAGE_URL: page, CONTACT_EMAIL: 'hello@inspector.example' }),
    ]) {
      assert.equal(operator.statusPageUrl, page);
      assert.equal(operator.texts, false);

      // The page as a build writes it: a link, the API description's
      // sentence, JSON, Markdown, a script, the end of a sentence; in any case.
      for (const textOf of [
        `<a href="${page}">Status ↗</a>`,
        `open ${page}: the site`,
        `{"description":"open ${page}: the site"}`,
        `- Status: <${page}>\n`,
        `[Status](${page})`,
        `const s="${page}";`,
        `See ${page}.`,
        `${page}`,
        page.toUpperCase(),
        `${page} ${page}`,
      ]) {
        assert.deepEqual(left(textOf, operator), [], textOf);
      }
      // The address anywhere else: beside the page, after its host alone or
      // another scheme, under another path, or where a text goes on with
      // more of the page's path.
      for (const textOf of [
        `${page} on ${WRITTEN_SERVER_ADDRESS}`,
        `${WRITTEN_SERVER_ADDRESS}${page}`,
        `status.example.com/${WRITTEN_SERVER_ADDRESS}`,
        `http://status.example.com/${WRITTEN_SERVER_ADDRESS}`,
        `https://status.example.com/x/${WRITTEN_SERVER_ADDRESS}`,
        `${page}/more`,
        `${page}6`,
        `${page}.html`,
        `${page}-x`,
        `${page}%2e1`,
      ]) {
        assert.deepEqual(left(textOf, operator), ['80.87.198.166'], textOf);
      }
      // Every other name is found beside the page as before.
      assert.deepEqual(left(`${page} FirstVDS status.qa-tools.ru`, operator), [
        'status.qa-tools.ru',
        'FirstVDS',
      ]);
    }

    // A page whose path only begins the address: what goes on with it, in
    // any form a build writes a dot, is no part of the page.
    const begun = parseOperator({ STATUS_PAGE_URL: 'https://status.example.com/80.87.198' });

    for (const rest of ['.166', '.166/', '%2E166', '&#46;166', '&period;166', '\\u002e166']) {
      assert.deepEqual(
        left(`https://status.example.com/80.87.198${rest}`, begun),
        ['80.87.198.166'],
        rest,
      );
    }
    assert.deepEqual(left('open https://status.example.com/80.87.198: up', begun), []);
    assert.deepEqual(left('See https://status.example.com/80.87.198. Then', begun), []);

    // A path holding the address escaped is read out as the build writes it.
    const escaped = parseOperator({
      STATUS_PAGE_URL: 'https://status.example.com/80%2E87%2E198%2E166',
    });

    assert.equal(escaped.statusPageUrl, 'https://status.example.com/80%2E87%2E198%2E166');
    assert.deepEqual(left('open https://status.example.com/80%2E87%2E198%2E166: up', escaped), []);
    assert.deepEqual(
      left('https://status.example.com/80%2E87%2E198%2E166 80%2E87%2E198%2E166', escaped),
      ['80.87.198.166'],
    );

    // A build whose only address is in its status page's path passes; a file
    // holding it anywhere else is named.
    const operator = parseOperator({ STATUS_PAGE_URL: page });
    const dist = treeOf({
      'index.html': `<a class="header-link" href="${page}">Status ↗</a>`,
      'openapi.json': `{"description": "open ${page}: the site"}`,
      'llms.txt': `- Status: ${page}\n`,
      'assets/main-AAAAAAAA.js': `const s={statusPageUrl:"${page}"}`,
    });
    const named = (file: string) =>
      `${file} names 80.87.198.166, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name`;

    try {
      assert.deepEqual(check.operatorNameProblems(dist, operator), []);
      // Read with no status page, each file holds the address.
      assert.deepEqual(check.operatorNameProblems(dist, NO_OPERATOR).sort(), [
        named('assets/main-AAAAAAAA.js'),
        named('index.html'),
        named('llms.txt'),
        named('openapi.json'),
      ]);
      mkdirSync(join(dist, 'about'));
      writeFileSync(
        join(dist, 'about/index.html'),
        `<p>See ${page}.</p><p>Allow 80.87.198.166 on port 443.</p>`,
      );
      writeFileSync(join(dist, 'robots.txt'), `# ${page}/robots\n`);
      assert.deepEqual(check.operatorNameProblems(dist, operator).sort(), [
        named('about/index.html'),
        named('robots.txt'),
      ]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reads a hostile status page out of hostile text at growing sizes in time linear in their length (#446)', () => {
    const times: number[] = [];

    for (const size of [100_000, 1_000_000, 4_000_000]) {
      const sample = `/${WRITTEN_SERVER_ADDRESS}/80.87.198.`;
      const page = `https://status.example.com${sample.repeat(Math.ceil(size / 4 / sample.length))}`;
      const operator = parseOperator({ STATUS_PAGE_URL: page });
      // The page whole, then all of it but its last character, again and
      // again: every start of the page goes nearly to its end.
      const whole = `${page}: `.repeat(3);
      const begun = `${page.slice(0, -1)} `.repeat(3);

      assert.equal(operator.statusPageUrl, page);
      assert.ok(whole.length >= size / 2);
      times.push(
        fastestRun(() => {
          assert.deepEqual(left(whole, operator), []);
          assert.deepEqual(left(begun, operator), ['80.87.198.166']);
          assert.deepEqual(left(`${whole}${page}.166`, operator), ['80.87.198.166']);
        }),
      );
    }

    // Forty times the text in at most about two hundred times the time, each
    // the fastest of five runs: linear with room for a busy runner.
    assert.ok((times[2] as number) < Math.max(200 * (times[0] as number), 3_000), times.join(', '));
  });

  it('names every file holding one, binary and non-UTF-8 files included, and leaves the changelog’s history', () => {
    const dist = treeOf({
      'index.html': '<p>clean</p>',
      'assets/main-AAAAAAAA.js': 'const a="contact@qa-tools.ru"',
      'about/index.html': '<p>Yandex\nObject Storage</p>',
      'openapi.json': '{"description": "One address: `80\\u002e87\\u002e198\\u002e166`."}',
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
      'changelog.md':
        'QA Tools has a public status page, https://status.qa-tools.ru, on 80.87.198.166',
      'changelog.xml': '<feed>contact@qa-tools.ru</feed>',
      'changelog-breaking.xml': '<feed>Yandex Object Storage</feed>',
      'changelog/index.html':
        '<header><a href="https://status.qa-tools.ru/">Status</a></header><main>contact@qa-tools.ru 80.87.198.166</main><footer></footer>',
    });

    try {
      assert.deepEqual(check.operatorNameProblems(dist, NO_OPERATOR).sort(), [
        "about/index.html names Yandex Object Storage, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name",
        "assets/main-AAAAAAAA.js names contact@qa-tools.ru, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name",
        "changelog/index.html names status.qa-tools.ru, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name",
        "latin1.txt names status.qa-tools.ru, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name",
        "logo-512.png names FirstVDS, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name",
        "openapi.json names 80.87.198.166, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name",
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
      '80 . 87 . 198 . 16 ',
      '80&#0000000',
      '80.87\\u002',
      '80.87.198.<br <br ',
    ];
    const times: number[] = [];

    for (const size of [100_000, 1_000_000, 4_000_000]) {
      const textOf = samples
        .map((sample) => sample.repeat(Math.ceil(size / samples.length / sample.length)))
        .join('');
      const split = `${textOf}Yandex\n${' '.repeat(size)}Object Storage`;
      const address = `${textOf}80.87.198.\n${' '.repeat(size)}166`;

      times.push(
        fastestRun(() => {
          assert.deepEqual(left(textOf), []);
          assert.deepEqual(left(split), ['Yandex Object Storage']);
          assert.deepEqual(left(address), ['80.87.198.166']);
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
      // After an IPv6 origin, with a port or without (#426).
      ['<loc>http://[::1]:43979/changelog</loc>', ['http://[::1]:43979/changelog']],
      [
        '- [changelog.md](http://[::1]:43979/changelog.md): what',
        ['http://[::1]:43979/changelog.md'],
      ],
      [
        '"all changes, http://[2001:db8::1]:8080/changelog.xml · "',
        ['http://[2001:db8::1]:8080/changelog.xml'],
      ],
      ['feeds: https://[::1]/changelog-breaking.xml.', ['https://[::1]/changelog-breaking.xml']],
      ['(http://[FE80::1]:1/changelog#v1.0.0)', ['http://[FE80::1]:1/changelog']],
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
      'http://[::1]:43979/changelogs',
      'http://[::1]:43979/x/changelog',
      'http://[::1]:43979/changelog.mdx',
    ]) {
      assert.deepEqual(check.changelogLinksIn(textOf), [], textOf);
    }
  });

  it('reads a bracketed IPv6 host where site-origin.mjs accepts one, in the check and the removal alike, and nothing it refuses (#426)', () => {
    // Origins a build may name, as `parseSiteOrigin` gives them back.
    for (const host of [
      '[::1]',
      '[::]',
      '[2001:db8::8a2e:370:7334]',
      '[::ffff:102:304]',
      '[1:2:3:4:5:6:7:8]',
      '[fe80::1]',
    ]) {
      const origin = `http://${host}:8080`;
      const written = `See it, ${origin}/changelog.xml, now.`;

      assert.equal(parseSiteOrigin('APP_ORIGIN', origin, ''), origin);
      assert.deepEqual(check.changelogLinksIn(written), [`${origin}/changelog.xml`], host);
      assert.equal(
        operatorDescription(describedWith(written), NO_OPERATOR),
        `${SECTIONS_PART_LEFT}\n\nSee it, now.`,
        host,
      );
    }

    // Hosts it refuses, which no build names and no browser opens: not read
    // as an origin, so neither found nor left out.
    for (const host of ['[::1', '[]', '[::g]', '[1.2.3.4]', '[::1%25eth0]', '[ ::1]', '[[::1]]']) {
      const origin = `http://${host}:8080`;
      const written = `See it, ${origin}/changelog.xml, now.`;

      assert.throws(() => parseSiteOrigin('APP_ORIGIN', origin, ''), host);
      assert.deepEqual(check.changelogLinksIn(written), [], host);
      assert.equal(
        operatorDescription(describedWith(written), NO_OPERATOR),
        `${SECTIONS_PART_LEFT}\n\n${written}`,
        host,
      );
    }
  });

  it('refuses a link to each of the changelog’s addresses after an IPv6 origin in a build without the operator’s texts, naming the file and the link (#426)', () => {
    const [page, text, feed, breaking] = [
      '/changelog',
      '/changelog.md',
      '/changelog.xml',
      '/changelog-breaking.xml',
    ].map((path) => `${IPV6_ORIGINS.app}${path}`);
    const dist = treeOf({
      'llms.txt': `- [changelog.md](${text}): what changed`,
      'llms-full.txt': `the changelog, ${page}, which says it`,
      'about/index.html': `<a class="header-link" href="${feed}">Feed</a>`,
      'sitemap.xml': `<urlset><url><loc>${breaking}</loc></url></urlset>`,
    });
    const links = (problems: string[]) =>
      problems.filter((problem) => /^\S+ links /.test(problem)).sort();
    const refusal = (file: string, link: string | undefined) =>
      `${file} links ${link}, though OPERATOR_TEXTS does not show the operator's texts and the build has no changelog`;

    try {
      assert.deepEqual(links(check.checkBuild(dist, new Date(), [], IPV6_ORIGINS, NO_OPERATOR)), [
        refusal('about/index.html', feed),
        refusal('llms-full.txt', page),
        refusal('llms.txt', text),
        refusal('sitemap.xml', breaking),
      ]);
      // With the operator's texts the build links its changelog.
      for (const operator of [PRODUCTION_OPERATOR, { ...OTHER_OPERATOR, texts: true }]) {
        assert.deepEqual(links(check.checkBuild(dist, new Date(), [], IPV6_ORIGINS, operator)), []);
      }
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('scans hostile IPv6 hosts for changelog links at growing sizes in time linear in its length (#426)', () => {
    // Brackets never closed, closed with no path, a port with no digits, and
    // paths one letter short or one letter long.
    const samples = [
      'http://[',
      'https://[::::::::',
      'http://[0:0:0:0:0:0:0:',
      'http://[a:http://[a:',
      'http://[::1]',
      'http://[::1]:',
      'https://[::1]:43979/changelog-breaking.xm',
      'http://[::1]/changelo',
      '[::1]/changelog.m',
    ];
    const times: number[] = [];

    for (const size of [100_000, 1_000_000, 4_000_000]) {
      const textOf = samples
        .map((sample) => sample.repeat(Math.ceil(size / samples.length / sample.length)))
        .join(' ');
      const link = `${IPV6_ORIGINS.app}/changelog.xml`;

      times.push(
        fastestRun(() => {
          assert.deepEqual(check.changelogLinksIn(textOf), []);
          assert.deepEqual(check.changelogLinksIn(`${textOf} ${link}`), [link]);
        }),
      );
    }

    assert.ok((times[2] as number) < Math.max(200 * (times[0] as number), 3_000), times.join(', '));
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

  it('reads the build’s own status page out before it looks for changelog links where none of the site’s origins names its host, and finds every other link (#446)', () => {
    const page = 'https://status.example.com/changelog';
    const operator = parseOperator({ STATUS_PAGE_URL: page });
    const linked = (file: string, links: string) =>
      `${file} links ${links}, though OPERATOR_TEXTS does not show the operator's texts and the build has no changelog`;
    const dist = treeOf({
      'index.html': `<a class="header-link" href="${page}">Status ↗</a>`,
      'openapi.json': `{"description": "open ${page}: the site"}`,
      'llms.txt': `- Status: <${page}>\n`,
      'about/index.html': `<p>See ${page}. Or ${page.toUpperCase()}.</p>`,
    });

    try {
      assert.deepEqual(check.changelogLinkProblems(dist, operator, OTHER_ORIGINS), []);
      // Read with no status page, each file links one.
      assert.deepEqual(check.changelogLinkProblems(dist, NO_OPERATOR, OTHER_ORIGINS).sort(), [
        linked('about/index.html', page),
        linked('index.html', page),
        linked('llms.txt', page),
        linked('openapi.json', page),
      ]);
      // Every other link to one of the changelog's addresses is found beside
      // it: on the site's origin, relative, or where the text goes on with
      // more of the page's path.
      writeFileSync(
        join(dist, 'robots.txt'),
        [
          `# ${page} ${OTHER_ORIGINS.app}/changelog.md`,
          `# ${page}: /changelog.xml`,
          `# ${page}.md ${page}-breaking.xml ${page}/ ${page}.xml`,
        ].join('\n'),
      );
      assert.deepEqual(check.changelogLinkProblems(dist, operator, OTHER_ORIGINS), [
        linked(
          'robots.txt',
          [
            `${OTHER_ORIGINS.app}/changelog.md`,
            '/changelog.xml',
            `${page}.md`,
            'https://status.example.com/changelog-breaking.xml',
            page,
            `${page}.xml`,
          ].join(', '),
        ),
      ]);
      // checkBuild reads the build's settings and origins with it.
      assert.deepEqual(
        check
          .checkBuild(dist, new Date(), [], OTHER_ORIGINS, operator)
          .filter((problem) => / links /.test(problem)),
        [check.changelogLinkProblems(dist, operator, OTHER_ORIGINS)[0]],
      );
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }

    // A status page on a host of the site's is read as any other link: that
    // host may serve this build, which answers /changelog with Page not found.
    for (const own of [
      `${OTHER_ORIGINS.app}/changelog`,
      `${OTHER_ORIGINS.receive}/changelog`,
      'https://inspector.example:8443/changelog',
      'http://inspector.example/changelog',
    ]) {
      const ownDist = treeOf({ 'index.html': `<a href="${own}">Status ↗</a>` });

      try {
        assert.deepEqual(
          check.changelogLinkProblems(
            ownDist,
            parseOperator({ STATUS_PAGE_URL: own }),
            OTHER_ORIGINS,
          ),
          [linked('index.html', own)],
          own,
        );
        assert.deepEqual(
          check.changelogLinkProblems(ownDist, parseOperator({ STATUS_PAGE_URL: own }), {
            app: 'https://other.example',
            receive: 'https://hook.other.example',
            alias: null,
          }),
          [],
          own,
        );
      } finally {
        rmSync(ownDist, { recursive: true, force: true });
      }
    }
    // So with the site's second origin.
    const aliasDist = treeOf({
      'index.html': '<a href="https://old.example/changelog">Status ↗</a>',
    });

    try {
      assert.deepEqual(
        check.changelogLinkProblems(
          aliasDist,
          parseOperator({ STATUS_PAGE_URL: 'https://old.example/changelog' }),
          { ...OTHER_ORIGINS, alias: 'https://old.example' },
        ),
        [linked('index.html', 'https://old.example/changelog')],
      );
    } finally {
      rmSync(aliasDist, { recursive: true, force: true });
    }
  });

  it('reads a hostile status page out of hostile text before it looks for changelog links, at growing sizes in time linear in their length (#446)', () => {
    const times: number[] = [];

    for (const size of [100_000, 1_000_000, 4_000_000]) {
      // A page tens of thousands of characters long and more, beyond what a
      // pattern of its text compiles to.
      const sample = '/changelog/changelog.md/changelog-breaking.xml';
      const page = `https://status.example.com${sample.repeat(Math.ceil(size / 4 / sample.length))}/changelog`;
      const operator = parseOperator({ STATUS_PAGE_URL: page });
      const whole = treeOf({ 'llms.txt': `${page}: `.repeat(3) });
      const begun = treeOf({ 'llms.txt': `${page}.md `.repeat(3) });

      assert.equal(operator.statusPageUrl, page);
      try {
        times.push(
          fastestRun(() => {
            assert.deepEqual(check.changelogLinkProblems(whole, operator, OTHER_ORIGINS), []);
            assert.equal(check.changelogLinkProblems(begun, operator, OTHER_ORIGINS).length, 1);
          }),
        );
      } finally {
        rmSync(whole, { recursive: true, force: true });
        rmSync(begun, { recursive: true, force: true });
      }
    }

    // Forty times the text in at most about two hundred times the time, each
    // the fastest of five runs: linear with room for a busy runner.
    assert.ok((times[2] as number) < Math.max(200 * (times[0] as number), 3_000), times.join(', '));
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

  it('titles and describes both about pages by the service, and draws How it’s built without its first-person line (issue #380)', () => {
    for (const [path, title, description, kept, left] of [
      [
        'about/index.html',
        'About Webhook Inspector',
        'How Webhook Inspector is built and what happens to your data.',
        ['Written entirely by AI agents', 'a small Kubernetes\u00a0cluster\u00a0(k3s).'],
        /I decide what to build|approve every design/,
      ],
      [
        'ru/about/index.html',
        'О Webhook Inspector',
        'Как устроен Webhook Inspector и что происходит с вашими данными.',
        ['Весь код написан ИИ-агентами', 'небольшой кластер\u00a0Kubernetes\u00a0(k3s).'],
        /решаю, что делать|утверждаю каждый экран/,
      ],
    ] as const) {
      const html = built(path);
      const head = /<head>[\s\S]*?<\/head>/.exec(html)?.[0] ?? '';
      const descriptions = [...head.matchAll(/<meta\s+name="description"\s+content="([^"]*)"/g)];
      const fact = /<div class="fact"><dt>[^<]*<\/dt><dd>(.*?)<\/dd><\/div>/.exec(html)?.[1] ?? '';

      assert.equal(head.split('<title>').length - 1, 1, path);
      assert.ok(head.includes(`<title>${title}</title>`), path);
      assert.deepEqual(
        descriptions.map((match) => match[1]),
        [description],
        path,
      );
      assert.doesNotMatch(head, /og:title|og:description/, path);
      // Neither names QA Tools, who runs the service or who pays for it.
      assert.doesNotMatch(head, /QA Tools|Who runs|who pays|Кто и как|платит/, path);
      // How it's built: its first and last lines, not the one in between.
      assert.equal(fact.split('<p>').length - 1, 2, path);
      for (const line of kept) {
        assert.ok(fact.includes(line), `${path}: ${line}`);
      }
      assert.doesNotMatch(html, left, path);
    }
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

  it('serves an API description with no Network section, no sentence pointing at it and the server’s address in no file (issue #386, criterion 1)', () => {
    const source = (
      JSON.parse(read('../../../../packages/shared/openapi.json')) as {
        info: { description: string };
      }
    ).info.description;
    const description = (JSON.parse(built('openapi.json')) as { info: { description: string } })
      .info.description;

    // /docs shows openapi.json as it is served; llms-full.txt carries it.
    for (const [path, text] of [
      ['openapi.json', description],
      ['llms-full.txt', built('llms-full.txt')],
    ] as const) {
      assert.ok(!text.includes(NETWORK_HEADING), path);
      assert.doesNotMatch(text, /\bNetwork\b/, path);
      assert.ok(!text.includes(NETWORK_POINTER.trim()), path);
      for (const paragraph of networkParagraphs(source)) {
        assert.ok(!text.includes(paragraph), `${path}: ${paragraph.slice(0, 40)}`);
      }
      // The sections around it are there, the Errors section before Security.
      assert.match(text, /\n\n## Errors\n\n[\s\S]*\n\n## Security\n\n\*\*No accounts\.\*\*/, path);
      assert.ok(
        text.includes('the mark was the notice.\n- `info.version`, shown at the top'),
        path,
      );
    }

    // In no file of the build, read as the build check reads it, the
    // changelog's history among them, which this build does not have.
    const files = filesOf(dist);

    for (const path of files) {
      assert.ok(!readFileSync(join(dist, path), 'utf8').includes(WRITTEN_SERVER_ADDRESS), path);
    }
    for (const path of check.CHANGELOG_HISTORY_FILES) {
      assert.ok(!files.includes(path), path);
    }
    assert.deepEqual(
      files.flatMap((path) =>
        check.operatorNamesLeft(readFileSync(join(dist, path), 'utf8'), NO_OPERATOR),
      ),
      [],
    );
  });

  it('serves an API description with no bullet on the relay script’s old name, the relay section’s other bullets as written (#431)', () => {
    const unhashed = (text: string) => text.replace(/\b[0-9a-f]{64}\b/g, '<sha-256>');
    // What the build wrote before #431, named for these origins: the
    // description as a build with a second origin writes it, which keeps
    // the bullet, its link to the changelog left out.
    const before = unhashed(
      operatorDescription(
        (
          JSON.parse(nameSite(read('../../../../packages/shared/openapi.json'), OTHER_ORIGINS)) as {
            info: { description: string };
          }
        ).info.description,
        NO_OPERATOR,
        true,
      ),
    );
    const description = (JSON.parse(built('openapi.json')) as { info: { description: string } })
      .info.description;

    assert.equal(relayBullets(before).length, 10);
    assert.ok(lineBeginning(before, OLD_NAME_BULLET).includes('`qa-tools-relay.mjs`'));
    // /docs shows openapi.json as it is served; llms-full.txt carries it.
    for (const [path, text] of [
      ['openapi.json', description],
      ['llms-full.txt', built('llms-full.txt')],
    ] as const) {
      assert.ok(!text.includes(OLD_NAME_BULLET), path);
      assert.ok(!text.includes('that name serves the same file'), path);
      assert.deepEqual(
        relayBullets(unhashed(text)),
        relayBullets(before).filter((line) => !line.startsWith(OLD_NAME_BULLET)),
        path,
      );
    }
    // The description names the old name nowhere; the agent guide, which
    // llms-full.txt also carries, is its own text.
    assert.ok(!description.includes('qa-tools-relay.mjs'));
  });

  it('fails the build check, naming the file, with the server’s address left in a file, split or escaped (issue #386, criterion 3)', () => {
    const refusal = (file: string) =>
      `${file} names 80.87.198.166, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name`;

    for (const [file, write] of [
      [
        'llms-full.txt',
        `${built('llms-full.txt')}\nAllow outgoing connections to \`80.87.198.166\` on port 443.\n`,
      ],
      ['llms.txt', `${built('llms.txt')}- One address: 80.87.198.\n  166\n`],
      ['robots.txt', `${built('robots.txt')}# 80%2E87%2E198%2E166\n`],
      [
        'openapi.json',
        built('openapi.json').replace(
          '\\n\\n## Security\\n\\n',
          '\\n\\nOne address: `80\\u002e87\\u002e198\\u002e166`.\\n\\n## Security\\n\\n',
        ),
      ],
      [
        'about/index.html',
        built('about/index.html').replace('</main>', '<p>80&#46;87&#46;198&#46;166</p></main>'),
      ],
    ] as const) {
      assert.notEqual(write, built(file), file);

      const copy = mkdtempSync(join(tmpdir(), 'webhook-inspector-address-left-'));

      try {
        cpSync(dist, copy, { recursive: true });
        writeFileSync(join(copy, file), write);

        const run = spawnSync(process.execPath, ['scripts/check-build.mjs', copy], {
          cwd: FRONTEND,
          env: environment,
          encoding: 'utf8',
        });

        assert.equal(run.status, 1, run.stdout);
        assert.ok(run.stderr.split('\n').includes(`  - ${refusal(file)}`), run.stderr);
        assert.equal(run.stderr.match(/^ {2}- /gm)?.length, 1, run.stderr);
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }

    // The same file passes a build with the operator's texts, which names the
    // address, as production's does.
    const dist2 = treeOf({ 'llms-full.txt': 'One address: 80.87.198.166' });

    try {
      assert.deepEqual(check.operatorNameProblems(dist2, PRODUCTION_OPERATOR), []);
      assert.deepEqual(check.operatorNameProblems(dist2, { ...OTHER_OPERATOR, texts: true }), []);
      assert.deepEqual(check.operatorNameProblems(dist2, OTHER_OPERATOR), [
        refusal('llms-full.txt'),
      ]);
    } finally {
      rmSync(dist2, { recursive: true, force: true });
    }
  });
});

describe('a build with example origins, no operator texts and a status page whose path holds the changelog’s address and the server’s (#446)', () => {
  let dist = '';
  const page = `https://status.example.com/changelog/${WRITTEN_SERVER_ADDRESS}`;
  const operator = parseOperator({ STATUS_PAGE_URL: page });
  /** The build's environment: a copy's origins and its status page alone. */
  const environment = {
    ...withoutOperator(process.env),
    APP_ORIGIN: OTHER_ORIGINS.app,
    RECEIVE_ORIGIN: OTHER_ORIGINS.receive,
    APP_ALIAS_ORIGIN: '',
    STATUS_PAGE_URL: page,
  };

  // Five Vite builds and five scripts, as the build above.
  before(
    () => {
      dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-status-path-'));
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

  it('passes the build check, naming the page in the API description’s sentence, and fails it, naming the file, with the address or a changelog link anywhere else', () => {
    // `buildInto` saw every step pass, the build check last.
    assert.equal(operator.texts, false);
    assert.ok(
      (
        JSON.parse(built('openapi.json')) as { info: { description: string } }
      ).info.description.includes(` open ${page}: the site`),
    );
    assert.deepEqual(check.operatorNameProblems(dist, operator), []);
    assert.deepEqual(check.changelogLinkProblems(dist, operator, OTHER_ORIGINS), []);
    // Read with no status page, the build's files name both in it.
    assert.ok(
      check
        .operatorNameProblems(dist, NO_OPERATOR)
        .includes(
          "openapi.json names 80.87.198.166, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name",
        ),
    );
    assert.ok(
      check
        .changelogLinkProblems(dist, NO_OPERATOR, OTHER_ORIGINS)
        .includes(
          "openapi.json links https://status.example.com/changelog, though OPERATOR_TEXTS does not show the operator's texts and the build has no changelog",
        ),
    );

    for (const [file, write, refusal] of [
      [
        'llms.txt',
        `${built('llms.txt')}- Server: ${WRITTEN_SERVER_ADDRESS}\n`,
        "llms.txt names 80.87.198.166, which this build's operator settings (STATUS_PAGE_URL, CONTACT_EMAIL, OPERATOR_TEXTS) do not name",
      ],
      [
        'llms.txt',
        `${built('llms.txt')}- Changelog: ${OTHER_ORIGINS.app}/changelog\n`,
        "llms.txt links https://inspector.example/changelog, though OPERATOR_TEXTS does not show the operator's texts and the build has no changelog",
      ],
    ] as const) {
      const copy = mkdtempSync(join(tmpdir(), 'webhook-inspector-status-path-left-'));

      try {
        cpSync(dist, copy, { recursive: true });
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
  });
});
