import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { SiteOrigins } from '../../scripts/site-origin.mjs';
import { en } from '../i18n/en.ts';
import { HOME_ADDRESSES } from '../i18n/index.ts';
import { ru } from '../i18n/ru.ts';
import { LANDING_HEADING, LANDING_LEAD, LANDING_STEPS } from './landing-copy.ts';

/**
 * Production's origins, whatever the shell running the tests holds (#354):
 * the files and the heads pinned here are written for production (D274).
 * The build's modules read the origins from the environment as they load,
 * so they are imported once these are set, not with the static imports
 * above, which would load them first.
 */
Object.assign(process.env, {
  APP_ORIGIN: 'https://qa-tools.ru',
  RECEIVE_ORIGIN: 'https://hook.qa-tools.ru',
  APP_ALIAS_ORIGIN: 'https://webhook.qa-tools.ru',
});

// @ts-expect-error -- a plain ES module with no declarations; the build runs it.
const buildCheck = await import('../../scripts/check-build.mjs');
const { siteFiles } = await import('../../scripts/build-site-files.mjs');
const { PRODUCTION_ORIGINS, SITE_ORIGINS, siteOriginPlugin } =
  await import('../../scripts/site-origin.mjs');

/** A copy at another address with no second origin of its own, as `llms.test.ts` has one (#342). */
const ANOTHER: SiteOrigins = {
  app: 'https://inspector.example',
  receive: 'https://hook.inspector.example',
  alias: null,
};

/**
 * What search engines and link previews read (issue #69, D183), without a
 * browser: the files served from `public/`, the check the build runs on them,
 * the head and the `<noscript>` of the pages, the two home pages included
 * (issue #109, D226), the header nginx marks a session page with, and the
 * routing that keeps the backend to its three path segments and `/mcp`, in
 * the order Traefik ranks them (D203). `scripts/check-deployment.mjs` asks the
 * deployed site for the same.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const bytes = (path: string) => readFileSync(new URL(path, import.meta.url));
const publicFile = (name: string) => `../../public/${name}`;

const {
  checkBuild,
  FAVICON_SIZES,
  HOME_PAGES,
  homePageProblems,
  HREFLANG,
  icoSizes,
  LOGO_IMAGES,
  pngSize,
  productionNamesLeft,
  RUSSIAN_HOME_PAGE,
  SEARCH_FILES,
  SITEMAP_ADDRESSES,
  sitemapProblems,
} = buildCheck as {
  checkBuild: (dist: string) => string[];
  FAVICON_SIZES: number[];
  HOME_PAGES: Record<string, { lang: string; title: string; canonical: string }>;
  homePageProblems: (file: string, html: string) => string[];
  HREFLANG: [string, string][];
  icoSizes: (bytes: Buffer) => number[] | undefined;
  LOGO_IMAGES: Record<string, number>;
  pngSize: (bytes: Buffer) => { width: number; height: number } | undefined;
  productionNamesLeft: (text: string, origins?: SiteOrigins) => string[];
  RUSSIAN_HOME_PAGE: string;
  SEARCH_FILES: string[];
  SITEMAP_ADDRESSES: string[];
  sitemapProblems: (text: string, required?: readonly string[]) => string[];
};

const DESCRIPTION =
  'Generate a temporary URL and inspect incoming HTTP requests and webhooks in real time. No registration, no setup.';

/**
 * The Russian home page's title and description, the owner's Decision 4 of
 * issue #109 (D226), the title renamed by Decision 4 of issue #322 (D277).
 */
const RUSSIAN_TITLE = 'Webhook Inspector — проверка вебхуков';
const RUSSIAN_DESCRIPTION =
  'Создайте временный адрес и смотрите входящие вебхуки и HTTP-запросы в реальном времени. Без регистрации и настройки.';

/** The two home pages' templates, where the build writes them (D226). */
const HOME_TEMPLATE = '../../index.html';
const RUSSIAN_TEMPLATE = '../../ru/index.html';

describe('robots.txt', () => {
  it('is checked here against production’s origins, whatever the shell running the tests holds (#354)', () => {
    assert.deepEqual(SITE_ORIGINS, PRODUCTION_ORIGINS);
  });

  it('keeps crawlers off the backend, and names the sitemap', () => {
    assert.equal(
      read(publicFile('robots.txt')),
      [
        'User-agent: *',
        'Disallow: /s/',
        'Disallow: /api/',
        'Disallow: /ws/',
        'Sitemap: https://qa-tools.ru/sitemap.xml',
        '',
      ].join('\n'),
    );
  });

  it('leaves /v/ open, so a crawler reads the noindex a session page answers', () => {
    assert.doesNotMatch(read(publicFile('robots.txt')), /\/v\//);
  });
});

describe('sitemap.xml', () => {
  const sitemap = read(publicFile('sitemap.xml'));

  it('lists the two home pages, the API reference, the changelog, the about page in both languages, the Terms of Use and the Privacy Policy, and nothing else (D184, D211, D217, D226, D255)', () => {
    assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
    assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.deepEqual(
      [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]),
      [
        'https://qa-tools.ru/',
        'https://qa-tools.ru/ru/',
        'https://qa-tools.ru/docs',
        'https://qa-tools.ru/changelog',
        'https://qa-tools.ru/about',
        // Amended by D255: the Russian about page, eight addresses in all.
        'https://qa-tools.ru/ru/about',
        'https://qa-tools.ru/terms',
        'https://qa-tools.ru/privacy',
      ],
    );
    assert.deepEqual(sitemapProblems(sitemap), []);
    assert.deepEqual(
      [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]),
      SITEMAP_ADDRESSES,
    );
    assert.deepEqual(sitemapProblems(sitemap, SITEMAP_ADDRESSES), []);
  });

  it('is refused by the build check when it leaves out a page the site offers (D255)', () => {
    for (const address of SITEMAP_ADDRESSES as string[]) {
      assert.deepEqual(
        sitemapProblems(sitemap.replace(`<loc>${address}</loc>`, ''), SITEMAP_ADDRESSES),
        [`sitemap.xml does not list ${address}`],
        address,
      );
    }

    // An address is listed only as itself: no prefix, slash or case stands in for it.
    for (const near of [
      'https://qa-tools.ru/ru/about/',
      'https://qa-tools.ru/RU/about',
      'https://qa-tools.ru/ru/about?x=1',
      'http://qa-tools.ru/ru/about',
    ]) {
      assert.deepEqual(
        sitemapProblems(
          sitemap.replace('<loc>https://qa-tools.ru/ru/about</loc>', `<loc>${near}</loc>`),
          SITEMAP_ADDRESSES,
        ),
        ['sitemap.xml does not list https://qa-tools.ru/ru/about'],
        near,
      );
    }
  });

  /** The language pair is in each page's head alone, not in the sitemap (D226). */
  it('names no language alternates of its own', () => {
    assert.doesNotMatch(sitemap, /xhtml|hreflang/);
  });

  it('is refused by the build check with a session page or an address robots.txt closes', () => {
    const listing = (address: string) =>
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${address}</loc></url></urlset>`;

    for (const address of [
      'https://qa-tools.ru/v/Au6JqVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2m_-MKss',
      'https://qa-tools.ru/s/Au6JqVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2m_-MKss',
      'https://qa-tools.ru/api/sessions',
      'https://qa-tools.ru/ws/x',
    ]) {
      assert.deepEqual(sitemapProblems(listing(address)), [
        `sitemap.xml lists ${address}, which search engines must not be sent to`,
      ]);
    }

    assert.deepEqual(sitemapProblems(listing('/docs')), [
      'sitemap.xml lists /docs, which is not an absolute URL',
    ]);
    assert.deepEqual(sitemapProblems('<urlset></urlset>'), ['sitemap.xml lists no address']);
  });
});

describe('the logo images', () => {
  it('are the two PNG squares and an ICO of 16, 32 and 48 px', () => {
    assert.deepEqual(LOGO_IMAGES, { 'favicon-192.png': 192, 'logo-512.png': 512 });

    for (const [name, side] of Object.entries(LOGO_IMAGES)) {
      assert.deepEqual(pngSize(bytes(publicFile(name))), { width: side, height: side }, name);
    }

    assert.deepEqual(FAVICON_SIZES, [16, 32, 48]);
    assert.deepEqual(icoSizes(bytes(publicFile('favicon.ico'))), FAVICON_SIZES);
  });

  it('are read as neither kind of image when they are something else', () => {
    assert.equal(pngSize(bytes(publicFile('favicon.ico'))), undefined);
    assert.equal(pngSize(bytes(publicFile('robots.txt'))), undefined);
    assert.equal(icoSizes(bytes(publicFile('favicon-192.png'))), undefined);
  });
});

describe('the build check', () => {
  /** The problems `checkBuild` reports about the files for search engines. */
  function searchProblems(prepare: (dist: string) => void): string[] {
    const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-dist-'));

    try {
      prepare(dist);

      return checkBuild(dist).filter((problem) => /robots|sitemap|favicon|logo/.test(problem));
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  }

  const copyPublic = (dist: string) => {
    for (const name of SEARCH_FILES) {
      copyFileSync(fileURLToPath(new URL(publicFile(name), import.meta.url)), join(dist, name));
    }
  };

  it('requires every file', () => {
    assert.deepEqual(SEARCH_FILES, [
      'robots.txt',
      'sitemap.xml',
      'favicon.ico',
      'favicon-192.png',
      'logo-512.png',
    ]);
    assert.deepEqual(
      searchProblems(() => {}),
      SEARCH_FILES.map((name) => `${name} is not in the build`),
    );
  });

  it('accepts the committed files', () => {
    assert.deepEqual(searchProblems(copyPublic), []);
  });

  it('refuses an image of the wrong size or kind, and a sitemap listing a session', () => {
    assert.deepEqual(
      searchProblems((dist) => {
        copyPublic(dist);
        copyFileSync(join(dist, 'favicon-192.png'), join(dist, 'logo-512.png'));
        copyFileSync(join(dist, 'favicon-192.png'), join(dist, 'favicon.ico'));
        // Amended by D255: the committed sitemap with a session page added,
        // since the build now also refuses one that leaves a page out.
        writeFileSync(
          join(dist, 'sitemap.xml'),
          read(publicFile('sitemap.xml')).replace(
            '</urlset>',
            '<url><loc>https://qa-tools.ru/v/x</loc></url></urlset>',
          ),
        );
      }),
      [
        'logo-512.png is not a 512 × 512 PNG',
        'favicon.ico does not hold 16, 32, 48 px',
        'sitemap.xml lists https://qa-tools.ru/v/x, which search engines must not be sent to',
      ],
    );
  });
});

/** Every `<meta>` and `<link>` of a page's head, as attribute maps. */
function headTags(html: string, tag: 'meta' | 'link'): Record<string, string>[] {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';

  return [...head.matchAll(new RegExp(`<${tag}\\s([^>]*?)\\/?>`, 'g'))].map((match) =>
    Object.fromEntries(
      [...(match[1] as string).matchAll(/([\w:-]+)="([^"]*)"/g)].map((pair) => [pair[1], pair[2]]),
    ),
  );
}

/** The content of the one `<meta>` whose `name` or `property` is `key`. */
function metaContent(html: string, key: string): string | undefined {
  const found = headTags(html, 'meta').filter((tag) => tag.name === key || tag.property === key);

  assert.ok(found.length <= 1, `more than one <meta> for ${key}`);

  return found[0]?.content;
}

describe('the application page head', () => {
  const html = read(HOME_TEMPLATE);

  it('describes the site, as the search result and the link preview show it', () => {
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];

    assert.equal(title, 'Webhook Inspector — QA Tools');
    // The title the application keeps once it has loaded (D226).
    assert.equal(title, en.title.home);
    assert.match(html, /^<!doctype html>\n<html lang="en">\n/);
    assert.equal(metaContent(html, 'og:locale'), 'en_US');
    assert.equal(metaContent(html, 'og:locale:alternate'), 'ru_RU');
    assert.equal(metaContent(html, 'description'), DESCRIPTION);
    assert.equal(metaContent(html, 'og:description'), DESCRIPTION);
    assert.equal(metaContent(html, 'og:title'), title);
    assert.equal(metaContent(html, 'og:type'), 'website');
    assert.equal(metaContent(html, 'og:site_name'), 'Webhook Inspector');
    assert.equal(metaContent(html, 'og:url'), 'https://qa-tools.ru/');

    const canonical = headTags(html, 'link').filter((tag) => tag.rel === 'canonical');

    assert.deepEqual(canonical, [{ rel: 'canonical', href: 'https://qa-tools.ru/' }]);
  });

  it('names the 512 px logo as the preview image, at a stable address', () => {
    assert.equal(metaContent(html, 'og:image'), 'https://qa-tools.ru/logo-512.png');
    assert.equal(metaContent(html, 'og:image:width'), '512');
    assert.equal(metaContent(html, 'og:image:height'), '512');
    assert.equal(metaContent(html, 'og:image:alt'), 'Webhook Inspector logo');
    assert.deepEqual(pngSize(bytes(publicFile('logo-512.png'))), { width: 512, height: 512 });
  });

  it('links the 192 px PNG icon beside the SVG one', () => {
    const icons = headTags(html, 'link').filter((tag) => tag.rel === 'icon');

    assert.deepEqual(icons, [
      { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/favicon-192.png' },
      { rel: 'icon', type: 'image/svg+xml', href: './src/assets/qa-tools-mark.svg' },
    ]);
  });
});

/** Text with its markup removed and its white space collapsed. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

describe('the <noscript> copy', () => {
  const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(read('../../index.html'))?.[1] ?? '';

  it('is the first-visit page, in its own words, then the pointer for agents (D183, D199)', () => {
    // The top-level elements, in order. A reader without JavaScript has no
    // list of sessions, so it is always the first visit (F), whose security
    // note is part of step 01 since the `Temporary and anonymous` block went.
    const blocks = [...noscript.matchAll(/<(h1|p|ol)>([\s\S]*?)<\/\1>/g)].map((match) => ({
      tag: match[1],
      inner: match[2] as string,
    }));

    assert.deepEqual(
      blocks.map((block) => block.tag),
      ['h1', 'p', 'ol', 'p'],
    );
    assert.equal(text(noscript), text(blocks.map((block) => block.inner).join(' ')));

    const [heading, lead, steps, agents] = blocks as [
      (typeof blocks)[0],
      (typeof blocks)[0],
      (typeof blocks)[0],
      (typeof blocks)[0],
    ];

    assert.equal(text(heading.inner), LANDING_HEADING);
    assert.equal(text(lead.inner), LANDING_LEAD);
    assert.deepEqual(
      [...steps.inner.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => text(match[1] as string)),
      LANDING_STEPS.map((step) => `${step.title} — ${step.description}`),
    );
    assert.doesNotMatch(noscript, /Temporary and anonymous/);
    assert.equal(
      text(agents.inner),
      'Agents and scripts: read /llms.txt — the whole guide is /llms-full.txt.',
    );
    assert.match(agents.inner, /<a href="\/llms\.txt">\/llms\.txt<\/a>/);
    assert.match(agents.inner, /<a href="\/llms-full\.txt">\/llms-full\.txt<\/a>/);
  });

  it('holds the approved copy', () => {
    assert.equal(LANDING_HEADING, 'Inspect webhooks instantly.');
    assert.equal(
      LANDING_LEAD,
      'Generate a temporary URL and inspect incoming HTTP requests in real time. No registration, no setup.',
    );
    assert.deepEqual(
      LANDING_STEPS.map((step) => `${step.title} — ${step.description}`),
      [
        'Generate URL — Create a temporary endpoint instantly. Anyone with its URL can see what it receives, so do not send sensitive production data.',
        'Send requests — Use it from Postman, CI, webhooks, or any HTTP client.',
        'Inspect live — See method, headers, query, body, IP, size, and time.',
      ],
    );
  });

  it('is kept in step because the landing page renders the same strings', () => {
    const page = read('../pages/LandingPage.tsx');

    // The page renders the dictionary's words in the interface's language
    // (D222); in English they are the ones the `<noscript>` repeats, which
    // `landing-copy.ts` takes from the same dictionary.
    assert.equal(LANDING_HEADING, en.landing.heading);
    assert.equal(LANDING_LEAD, en.landing.lead);
    assert.equal(LANDING_STEPS, en.landing.steps);

    for (const use of ['{m.landing.heading}', '{m.landing.lead}', 'm.landing.steps.map(']) {
      assert.ok(page.includes(use), `LandingPage.tsx does not render ${use}`);
    }

    // Both states render the heading and the lead; only the first visit has
    // the steps.
    assert.equal(page.match(/\{m\.landing\.heading\}/g)?.length, 2);
    assert.equal(page.match(/\{m\.landing\.lead\}/g)?.length, 2);

    for (const words of [
      'Inspect webhooks',
      'No registration',
      'Generate URL — ',
      'Anyone with',
      'Temporary and anonymous',
      'LANDING_NOTE',
    ]) {
      assert.ok(!page.includes(words), `LandingPage.tsx writes "${words}" itself`);
    }
  });
});

/** The `hreflang` links of a page's head, as `[language, address]` in order. */
function alternates(html: string): [string, string][] {
  return headTags(html, 'link')
    .filter((tag) => tag.rel === 'alternate' && 'hreflang' in tag)
    .map((tag) => [tag.hreflang as string, tag.href as string]);
}

/** Issue #109, D226: a page of its own at /ru/, the application under a Russian head. */
describe('the Russian home page head', () => {
  const html = read(RUSSIAN_TEMPLATE);

  it('is Russian, with the owner’s title and description for the search result and the link preview', () => {
    assert.match(html, /^<!doctype html>\n<html lang="ru">\n/);

    const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((match) => match[1]);

    assert.deepEqual(titles, [RUSSIAN_TITLE]);
    // The title the application keeps once it has loaded, the same as every
    // other Russian screen's tab (D277).
    assert.equal(ru.title.home, RUSSIAN_TITLE);
    assert.equal(ru.title.base, RUSSIAN_TITLE);
    assert.equal(metaContent(html, 'description'), RUSSIAN_DESCRIPTION);
    assert.equal(metaContent(html, 'og:title'), RUSSIAN_TITLE);
    assert.equal(metaContent(html, 'og:description'), RUSSIAN_DESCRIPTION);
    assert.equal(metaContent(html, 'og:type'), 'website');
    assert.equal(metaContent(html, 'og:site_name'), 'Webhook Inspector');
    assert.equal(metaContent(html, 'og:locale'), 'ru_RU');
    assert.equal(metaContent(html, 'og:locale:alternate'), 'en_US');
  });

  it('is its own canonical address, exactly once, and the link preview’s', () => {
    assert.deepEqual(
      headTags(html, 'link').filter((tag) => tag.rel === 'canonical'),
      [{ rel: 'canonical', href: 'https://qa-tools.ru/ru/' }],
    );
    assert.equal(metaContent(html, 'og:url'), 'https://qa-tools.ru/ru/');
    assert.equal(`https://qa-tools.ru${HOME_ADDRESSES.ru}`, 'https://qa-tools.ru/ru/');
  });

  it('names the same preview image and icons as the English page, the image described in Russian', () => {
    const english = read(HOME_TEMPLATE);

    for (const key of ['og:image', 'og:image:width', 'og:image:height']) {
      assert.equal(metaContent(html, key), metaContent(english, key), key);
    }

    assert.equal(metaContent(html, 'og:image:alt'), 'Логотип Webhook Inspector');
    assert.deepEqual(
      headTags(html, 'link').filter((tag) => tag.rel === 'icon'),
      [
        { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/favicon-192.png' },
        // From the site's root: a path relative to /ru/ would not be found.
        { rel: 'icon', type: 'image/svg+xml', href: '/src/assets/qa-tools-mark.svg' },
      ],
    );
  });

  it('loads the application itself, and asks no search engine to leave it out', () => {
    assert.ok(html.includes('<div id="root"></div>'));
    assert.deepEqual(
      [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]),
      [' type="module" src="/src/main.tsx"'],
    );
    assert.doesNotMatch(html, /noindex/i);
    assert.deepEqual(
      headTags(html, 'link').filter((tag) => tag.type === 'text/markdown'),
      [{ rel: 'alternate', type: 'text/markdown', href: '/llms.txt' }],
    );
  });
});

/** Acceptance 3 of issue #109: each home page names both, and itself as it names itself. */
describe('the hreflang links of the two home pages', () => {
  const pages = {
    [HOME_TEMPLATE]: 'https://qa-tools.ru/',
    [RUSSIAN_TEMPLATE]: 'https://qa-tools.ru/ru/',
  };

  it('are the same reciprocal set on both, with absolute addresses', () => {
    for (const template of Object.keys(pages)) {
      assert.deepEqual(
        alternates(read(template)),
        [
          ['en', 'https://qa-tools.ru/'],
          ['ru', 'https://qa-tools.ru/ru/'],
          ['x-default', 'https://qa-tools.ru/'],
        ],
        template,
      );
    }

    assert.deepEqual(HREFLANG, alternates(read(HOME_TEMPLATE)));
  });

  it('name each page by its canonical address, and each language by its home page', () => {
    for (const [template, canonical] of Object.entries(pages)) {
      const html = read(template);
      const own = headTags(html, 'link').find((tag) => tag.rel === 'canonical')?.href;
      const language = /<html lang="(\w+)">/.exec(html)?.[1] as string;

      assert.equal(own, canonical, template);
      assert.ok(
        alternates(html).some(([tag, href]) => tag === language && href === own),
        `${template} does not name itself as ${language}`,
      );
    }

    for (const [language, href] of alternates(read(HOME_TEMPLATE))) {
      if (language !== 'x-default') {
        assert.equal(href, `https://qa-tools.ru${HOME_ADDRESSES[language as 'en' | 'ru']}`);
      }
    }
  });

  it('are what the build check expects of each built home page', () => {
    assert.deepEqual(Object.keys(HOME_PAGES), ['index.html', RUSSIAN_HOME_PAGE]);
    assert.deepEqual(HOME_PAGES['index.html'], {
      lang: 'en',
      title: 'Webhook Inspector — QA Tools',
      canonical: 'https://qa-tools.ru/',
    });
    assert.deepEqual(HOME_PAGES[RUSSIAN_HOME_PAGE], {
      lang: 'ru',
      title: RUSSIAN_TITLE,
      canonical: 'https://qa-tools.ru/ru/',
    });
    assert.deepEqual(homePageProblems('index.html', read(HOME_TEMPLATE)), []);
    assert.deepEqual(homePageProblems(RUSSIAN_HOME_PAGE, read(RUSSIAN_TEMPLATE)), []);
  });
});

/**
 * What a build for another address writes of the same (D274, #354): the
 * files from `public/` as `build-site-files.mjs` names them, and each home
 * page as the last plugin of the build names it.
 */
describe('a build for another address', () => {
  const files = siteFiles(ANOTHER);
  const named = siteOriginPlugin(ANOTHER).transformIndexHtml.handler;

  it('names it in robots.txt and in every address of the sitemap', () => {
    assert.ok(
      (files['robots.txt'] ?? '').split('\n').includes(`Sitemap: ${ANOTHER.app}/sitemap.xml`),
    );
    assert.deepEqual(
      [...(files['sitemap.xml'] ?? '').matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]),
      ['/', '/ru/', '/docs', '/changelog', '/about', '/ru/about', '/terms', '/privacy'].map(
        (path) => `${ANOTHER.app}${path}`,
      ),
    );
  });

  it('names it in the canonical address, og:url, og:image and hreflang links of both home pages', () => {
    for (const [template, address] of [
      [HOME_TEMPLATE, `${ANOTHER.app}/`],
      [RUSSIAN_TEMPLATE, `${ANOTHER.app}/ru/`],
    ] as const) {
      const html = named(read(template));

      assert.deepEqual(
        headTags(html, 'link').filter((tag) => tag.rel === 'canonical'),
        [{ rel: 'canonical', href: address }],
        template,
      );
      assert.equal(metaContent(html, 'og:url'), address, template);
      assert.equal(metaContent(html, 'og:image'), `${ANOTHER.app}/logo-512.png`, template);
      assert.deepEqual(
        alternates(html),
        [
          ['en', `${ANOTHER.app}/`],
          ['ru', `${ANOTHER.app}/ru/`],
          ['x-default', `${ANOTHER.app}/`],
        ],
        template,
      );
      assert.deepEqual(productionNamesLeft(html, ANOTHER), [], template);
    }
  });
});

describe('the build check on the home pages (D226)', () => {
  const russian = read(RUSSIAN_TEMPLATE);
  const problems = (html: string) => homePageProblems(RUSSIAN_HOME_PAGE, html);

  it('refuses a Russian page without lang="ru", its title, its canonical or its og:url', () => {
    assert.deepEqual(problems(russian.replace('<html lang="ru">', '<html lang="en">')), [
      'the home page ru/index.html is not <html lang="ru">',
    ]);
    assert.deepEqual(
      problems(
        russian.replace(
          `<title>${RUSSIAN_TITLE}</title>`,
          '<title>Webhook Inspector — QA Tools</title>',
        ),
      ),
      [`the home page ru/index.html has no <title>${RUSSIAN_TITLE}</title>`],
    );
    assert.deepEqual(
      problems(russian.replace('<link rel="canonical" href="https://qa-tools.ru/ru/" />', '')),
      ['the home page ru/index.html does not have the one canonical https://qa-tools.ru/ru/'],
    );
    assert.deepEqual(
      problems(
        russian.replace(
          '<link rel="canonical" href="https://qa-tools.ru/ru/" />',
          '<link rel="canonical" href="https://qa-tools.ru/" />',
        ),
      ),
      ['the home page ru/index.html does not have the one canonical https://qa-tools.ru/ru/'],
    );
    assert.deepEqual(
      problems(
        russian.replace(
          '<link rel="canonical" href="https://qa-tools.ru/ru/" />',
          '<link rel="canonical" href="https://qa-tools.ru/ru/" /><link rel="canonical" href="https://qa-tools.ru/ru/" />',
        ),
      ),
      ['the home page ru/index.html does not have the one canonical https://qa-tools.ru/ru/'],
    );
    assert.deepEqual(
      problems(
        russian.replace('content="https://qa-tools.ru/ru/"', 'content="https://qa-tools.ru/"'),
      ),
      ['the home page ru/index.html does not have the one og:url https://qa-tools.ru/ru/'],
    );
  });

  it('refuses a home page without the whole hreflang set, or with a noindex', () => {
    for (const html of [
      russian.replace(
        '<link rel="alternate" hreflang="x-default" href="https://qa-tools.ru/" />',
        '',
      ),
      russian.replace('hreflang="ru" href="https://qa-tools.ru/ru/"', 'hreflang="ru" href="/ru/"'),
      russian.replace('hreflang="en"', 'hreflang="en-US"'),
    ]) {
      assert.deepEqual(problems(html), [
        'the home page ru/index.html does not carry the hreflang set of both home pages',
      ]);
    }

    assert.deepEqual(
      problems(russian.replace('<head>', '<head><meta name="robots" content="noindex" />')),
      ['the home page ru/index.html asks search engines not to index it'],
    );
    assert.deepEqual(
      homePageProblems(
        'index.html',
        read(HOME_TEMPLATE).replace(
          '<link rel="alternate" hreflang="ru" href="https://qa-tools.ru/ru/" />',
          '',
        ),
      ),
      ['the home page index.html does not carry the hreflang set of both home pages'],
    );
  });

  it('requires the Russian page in the build, and holds it to the application’s own rules', () => {
    const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-dist-'));

    try {
      assert.ok(checkBuild(dist).includes('the Russian home page ru/index.html was not built'));
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

/** Text of a `<noscript>` block's top-level elements, in order, with their tags. */
function noscriptBlocks(html: string): { tag: string; inner: string }[] {
  const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1] ?? '';

  return [...noscript.matchAll(/<(h1|p|ol)>([\s\S]*?)<\/\1>/g)].map((match) => ({
    tag: match[1] as string,
    inner: match[2] as string,
  }));
}

/** Acceptance 4 of issue #109: the Russian landing's own words, as the English one has its own. */
describe('the Russian <noscript> copy', () => {
  const html = read(RUSSIAN_TEMPLATE);
  const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1] ?? '';

  it('has the English one’s structure: the heading, the lead, the three steps, the pointer for agents', () => {
    const blocks = noscriptBlocks(html);

    assert.deepEqual(
      blocks.map((block) => block.tag),
      noscriptBlocks(read(HOME_TEMPLATE)).map((block) => block.tag),
    );
    assert.deepEqual(
      blocks.map((block) => block.tag),
      ['h1', 'p', 'ol', 'p'],
    );
    assert.equal(text(noscript), text(blocks.map((block) => block.inner).join(' ')));
  });

  it('is the Russian landing page’s words, as #108’s dictionary writes them', () => {
    type Block = ReturnType<typeof noscriptBlocks>[number];
    const [heading, lead, steps, agents] = noscriptBlocks(html) as [Block, Block, Block, Block];

    assert.equal(text(heading.inner), ru.landing.heading);
    assert.equal(text(lead.inner), ru.landing.lead);
    assert.deepEqual(
      [...steps.inner.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => text(match[1] as string)),
      ru.landing.steps.map((step) => `${step.title} — ${step.description}`),
    );
    assert.equal(
      text(agents.inner),
      'Агентам и скриптам: читайте /llms.txt — полное руководство в /llms-full.txt (на английском).',
    );
    assert.match(agents.inner, /<a href="\/llms\.txt">\/llms\.txt<\/a>/);
    assert.match(agents.inner, /<a href="\/llms-full\.txt">\/llms-full\.txt<\/a>/);
    // Nothing of the English page's words.
    for (const words of [en.landing.heading, en.landing.lead, 'Agents and scripts']) {
      assert.ok(!noscript.includes(words), words);
    }
  });

  it('holds the approved Russian copy', () => {
    assert.equal(ru.landing.heading, 'Проверяйте вебхуки мгновенно.');
    assert.equal(
      ru.landing.lead,
      'Создайте временный адрес и смотрите входящие HTTP-запросы в реальном времени. Без регистрации и настройки.',
    );
  });
});

describe('the API reference page head', () => {
  it('is titled with the service, its heading being the description\u2019s title (D277)', () => {
    const titles = [...read('../../docs/index.html').matchAll(/<title>([^<]*)<\/title>/g)];

    assert.deepEqual(
      titles.map((match) => match[1]),
      ['Webhook Inspector — API reference'],
    );
  });

  it('describes the page', () => {
    assert.equal(
      metaContent(read('../../docs/index.html'), 'description'),
      'HTTP API reference for QA Tools Webhook Inspector, rendered from /openapi.json.',
    );
  });
});

/** nginx.conf with its comments and blank lines removed, each line trimmed. */
function nginxDirectives(): string[] {
  return read('../../nginx.conf')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0);
}

/** The directives of the block that opens with `header`. */
function nginxBlock(header: string): string[] {
  const lines = nginxDirectives();
  const start = lines.indexOf(`${header} {`);

  assert.ok(start >= 0, `nginx.conf has no block ${header}`);

  const end = lines.indexOf('}', start);

  return lines.slice(start + 1, end);
}

describe('X-Robots-Tag in nginx.conf', () => {
  const session = 'location ~ "^/v/[A-Za-z0-9_-]{43}/?\\z"';

  it('is set to noindex by the session location, before it hands the page over', () => {
    assert.deepEqual(nginxBlock(session), [
      'set $robots_tag noindex;',
      'rewrite ^ /index.html last;',
    ]);
  });

  it('is sent by the shell’s location, with its Cache-Control, on every status', () => {
    assert.deepEqual(nginxBlock('location = /index.html'), [
      'internal;',
      "add_header Cache-Control 'no-cache' always;",
      'add_header X-Robots-Tag $robots_tag always;',
      'error_page 404 /index.html;',
    ]);
  });

  it('starts empty for every request, so no other address carries it', () => {
    const lines = nginxDirectives();
    const initial = lines.indexOf("set $robots_tag '';");

    assert.ok(initial >= 0, 'nginx.conf does not set $robots_tag to empty');
    // At the server level: before the first location.
    assert.ok(initial < lines.findIndex((line) => line.startsWith('location ')));
    assert.deepEqual(
      lines.filter((line) => line.includes('$robots_tag')),
      [
        "set $robots_tag '';",
        'add_header X-Robots-Tag $robots_tag always;',
        'set $robots_tag noindex;',
      ],
    );
    assert.equal(lines.filter((line) => /x-robots-tag/i.test(line)).length, 1);
  });
});

/** One exact location block of nginx.conf, comments and blank lines removed. */
function exactLocation(target: string): string[] {
  return nginxBlock(`location = ${target}`);
}

/** Issue #109, D226: served like /about, revalidated, never marked, never the shell by name. */
describe('the Russian home page in nginx.conf', () => {
  it('is served for /ru/ and /ru, never through `location /`', () => {
    for (const address of ['/ru', '/ru/']) {
      assert.deepEqual(exactLocation(address), ['rewrite ^ /ru/index.html last;'], address);
    }
  });

  it('is revalidated on every use, carries no X-Robots-Tag, and is an unknown address by its own name', () => {
    assert.deepEqual(exactLocation('/ru/index.html'), [
      'internal;',
      "add_header Cache-Control 'no-cache' always;",
      'error_page 404 /index.html;',
    ]);
  });

  it('is served by the dev server as nginx serves it, and built with the application', () => {
    const config = read('../../vite.config.ts');

    assert.ok(config.includes("path === '/ru' || path === '/ru/'"));
    assert.ok(config.includes("req.url = '/ru/index.html';"));
    assert.match(
      config,
      /input: \{\n\s*index: fileURLToPath\(new URL\('index\.html', import\.meta\.url\)\),\n\s*ru: fileURLToPath\(new URL\('ru\/index\.html', import\.meta\.url\)\),\n\s*\}/,
    );
  });
});

const INGRESS_YAML = read('../../../../deploy/helm/qa-tools/templates/ingress.yaml');

/** The template's Ingresses, each document's text. */
const INGRESS_DOCUMENTS = INGRESS_YAML.split(/^---$/m).filter((document) =>
  /^kind: Ingress$/m.test(document),
);

/** The paths of `documents`, each with its type and the Service it reaches. */
function pathsOf(documents: string[]) {
  return documents.flatMap((document) =>
    [
      ...document.matchAll(
        /- path: (\S+)\n\s+pathType: (\S+)\n\s+backend:\n\s+service:\n\s+name: \{\{ include "qa-tools\.name" \. \}\}-(\w+)/g,
      ),
    ].map(([, path = '', type = '', service = '']) => ({ path, type, service })),
  );
}

/**
 * The Ingresses of the host `value` gives, the site's through the chart's
 * helper that refuses a render without it (#367), or `ingress.aliasHost`.
 */
const ingressesOf = (value: string) =>
  INGRESS_DOCUMENTS.filter((document) => document.includes(`- host: {{ ${value} }}`));
const SITE_HOST = 'include "qa-tools.host" .';
const SECOND_HOST = '.Values.ingress.aliasHost';

/**
 * The paths of the chart's two Ingresses for the site's host, each with its
 * type and the Service it reaches: the API's, which carries the edge rate
 * limit (D264), then the site's. Traefik ranks the routers of both together.
 */
const ingress = pathsOf(ingressesOf(SITE_HOST));

/**
 * The same for the site's second host (#319, D275), whose two Ingresses of
 * their own carry the noindex middleware: their routers are ranked among
 * themselves, a request for one host never matching the other's.
 */
const aliasIngress = pathsOf(ingressesOf(SECOND_HOST));

describe('routing by path segment (D183)', () => {
  it('gives each Ingress one host, the site’s for two and its second’s for two (D275)', () => {
    assert.equal(INGRESS_DOCUMENTS.length, 4);
    assert.equal(ingressesOf(SITE_HOST).length, 2);
    assert.equal(ingressesOf(SECOND_HOST).length, 2);
    for (const document of INGRESS_DOCUMENTS) {
      assert.equal([...document.matchAll(/^\s*- host: /gm)].length, 1);
    }
  });

  it('gives the second host the site’s paths to the same Services, in the same order (D275)', () => {
    assert.deepEqual(aliasIngress, ingress);
  });

  it('sends the backend its three segments, each ending in its slash, and /mcp, and the rest to the frontend', () => {
    assert.deepEqual(ingress, [
      // The API's Ingress, behind the edge rate limit (D264).
      { path: '/api/', type: 'Prefix', service: 'backend' },
      // The MCP endpoint (D203): a Prefix, whose rule outranks the frontend's
      // catch-all; an Exact path's does not (below).
      { path: '/mcp', type: 'Prefix', service: 'backend' },
      // The site's.
      { path: '/ws/', type: 'Prefix', service: 'backend' },
      { path: '/s/', type: 'Prefix', service: 'backend' },
      { path: '/', type: 'Prefix', service: 'frontend' },
    ]);
  });

  it('is what the dev server proxies, so the browser suite sees production’s routing', () => {
    const proxied = [
      ...read('../../vite.config.ts').matchAll(/^\s*'([^']+)': \{ target: backend/gm),
    ].map((match) => match[1]);

    assert.deepEqual(
      [...proxied].sort(),
      ingress
        .filter((route) => route.service === 'backend')
        .map((route) => route.path)
        .sort(),
    );
  });
});

/**
 * Production's `ingress.host`, the host of every rule of the site's two
 * Ingresses, and its second host, `ingress.aliasHost` (D275). Since #367 the
 * deploy job gives the chart both from the project's CI/CD variables, and
 * neither values.yaml nor the pipeline names them; scripts/chart.test.mjs
 * holds the deploy job to these two.
 */
const INGRESS_HOST = 'qa-tools.ru';
const ALIAS_HOST = 'webhook.qa-tools.ru';

interface TraefikRouter {
  path: string;
  service: string;
  rule: string;
  priority: number;
  matches: (requested: string) => boolean;
}

/**
 * The path half of the rule Traefik 3.7's Kubernetes Ingress provider writes
 * for one path (`loadRouter` and `buildRule`,
 * pkg/provider/kubernetes/ingress/kubernetes.go at v3.7.8): `Path("<path>")`
 * for `Exact`, `PathPrefix("<path>")` for `Prefix`, each value written with
 * Go's `%q`. `PathPrefix` is a string prefix, `strings.HasPrefix`, so
 * `PathPrefix("/mcp")` takes `/mcpx` too (pkg/muxer/http/matcher.go). With
 * the provider's `strictPrefixMatching`, which the cluster leaves off (D183),
 * a `Prefix` path other than `/` is matched by path element instead:
 * `(Path("<p>") || PathPrefix("<p>/"))`, its trailing slash trimmed.
 */
function pathRule(
  path: string,
  type: string,
  strict: boolean,
): Pick<TraefikRouter, 'rule' | 'matches'> {
  // Go's %q and JSON write such a value alike.
  assert.match(path, /^\/[\w./-]*$/);

  if (type === 'Exact') {
    return { rule: `Path(${JSON.stringify(path)})`, matches: (requested) => requested === path };
  }

  assert.equal(type, 'Prefix', `${path}: pathType ${type} is not modelled`);

  if (strict && path !== '/') {
    const element = path.replace(/\/$/, '');

    return {
      rule: `(Path(${JSON.stringify(element)}) || PathPrefix(${JSON.stringify(`${element}/`)}))`,
      matches: (requested) => requested === element || requested.startsWith(`${element}/`),
    };
  }

  return {
    rule: `PathPrefix(${JSON.stringify(path)})`,
    matches: (requested) => requested.startsWith(path),
  };
}

/**
 * The routers Traefik 3.7 makes of the Ingresses' paths: `Host("<host>")`, then
 * ` && ` and the path's rule. A router given no priority of its own - the
 * Ingress sets none - takes the length of its rule (`GetRulePriority`,
 * pkg/muxer/http/mux.go, applied in pkg/server/router/router.go), and of the
 * routers that match a request the one with the highest priority serves it.
 */
function traefikRouters(strict = false, paths = ingress, host = INGRESS_HOST): TraefikRouter[] {
  assert.ok(host, 'no host for the routers');
  assert.match(host, /^[\w.-]+$/);

  return paths.map(({ path, type, service }) => {
    const { rule, matches } = pathRule(path, type, strict);
    const full = `Host(${JSON.stringify(host)}) && ${rule}`;

    return { path, service, rule: full, priority: full.length, matches };
  });
}

/** The router that serves a path on the host: the matching one of highest priority. */
function routeOf(
  requested: string,
  strict = false,
  paths = ingress,
  host = INGRESS_HOST,
): TraefikRouter | undefined {
  const [first, second] = traefikRouters(strict, paths, host)
    .filter((router) => router.matches(requested))
    .sort((a, b) => b.priority - a.priority);

  // Two matching routers of one priority are ordered by nothing Traefik promises.
  assert.ok(
    first === undefined || second === undefined || first.priority > second.priority,
    `${requested}: ${first?.rule} and ${second?.rule} tie`,
  );

  return first;
}

describe('the order Traefik 3.7 ranks the Ingresses’ paths in (D203, D264)', () => {
  const SESSION = 'Au6JqVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2m_-MKss';

  it('gives each path the rule and the priority Traefik writes for it', () => {
    assert.deepEqual(
      traefikRouters().map(({ rule, priority }) => [rule, priority]),
      [
        ['Host("qa-tools.ru") && PathPrefix("/api/")', 42],
        ['Host("qa-tools.ru") && PathPrefix("/mcp")', 41],
        ['Host("qa-tools.ru") && PathPrefix("/ws/")', 41],
        ['Host("qa-tools.ru") && PathPrefix("/s/")', 40],
        ['Host("qa-tools.ru") && PathPrefix("/")', 38],
      ],
    );
  });

  it('gives each path on the second host the rule and the priority Traefik writes for it (D275)', () => {
    assert.equal(ALIAS_HOST, 'webhook.qa-tools.ru');
    assert.deepEqual(
      traefikRouters(false, aliasIngress, ALIAS_HOST).map(({ rule, priority }) => [rule, priority]),
      [
        ['Host("webhook.qa-tools.ru") && PathPrefix("/api/")', 50],
        ['Host("webhook.qa-tools.ru") && PathPrefix("/mcp")', 49],
        ['Host("webhook.qa-tools.ru") && PathPrefix("/ws/")', 49],
        ['Host("webhook.qa-tools.ru") && PathPrefix("/s/")', 48],
        ['Host("webhook.qa-tools.ru") && PathPrefix("/")', 46],
      ],
    );
  });

  it('ranks every backend path above the frontend’s catch-all on either host, with strict matching too', () => {
    for (const [paths, host] of [
      [ingress, INGRESS_HOST],
      [aliasIngress, ALIAS_HOST],
    ] as const) {
      for (const strict of [false, true]) {
        const routers = traefikRouters(strict, paths, host);
        const catchAll = routers.find((router) => router.path === '/');

        assert.ok(catchAll);

        for (const router of routers.filter((entry) => entry.service === 'backend')) {
          assert.ok(
            router.priority > catchAll.priority,
            `${router.rule} (${router.priority}) is not above ${catchAll.rule} (${catchAll.priority})`,
          );
        }
      }
    }
  });

  it('would send an Exact /mcp, as 0.45.0 had it, to the frontend', () => {
    const exact = ingress.map((route) =>
      route.path === '/mcp' ? { ...route, type: 'Exact' } : route,
    );
    const mcp = traefikRouters(false, exact).find((router) => router.path === '/mcp');

    assert.ok(mcp);
    assert.equal(mcp.rule, 'Host("qa-tools.ru") && Path("/mcp")');
    assert.equal(mcp.priority, 35);
    assert.equal(routeOf('/mcp', false, exact)?.service, 'frontend');
  });

  it('sends /mcp and every other backend address to the backend, and the rest to the frontend', () => {
    const backend = [
      '/mcp',
      '/api/sessions',
      `/api/sessions/${SESSION}/requests`,
      `/ws/${SESSION}`,
      `/s/${SESSION}`,
      `/s/${SESSION}/a/b`,
    ];
    const frontend = [
      '/',
      '/ru/',
      '/ru',
      `/v/${SESSION}`,
      '/docs',
      '/changelog',
      '/about',
      '/terms',
      '/privacy',
      '/llms.txt',
      '/robots.txt',
      '/sitemap.xml',
      '/qa-tools-relay.mjs',
      '/webhook-inspector-relay.mjs',
      '/api',
      '/ws',
      '/s',
      '/sxyz',
      '/mc',
      '/MCP',
    ];

    // On the site's host and on its second (D275) alike.
    for (const [paths, host] of [
      [ingress, INGRESS_HOST],
      [aliasIngress, ALIAS_HOST],
    ] as const) {
      for (const path of backend) {
        assert.equal(routeOf(path, false, paths, host)?.service, 'backend', `${host} ${path}`);
        // And by path element, were the option turned on.
        assert.equal(routeOf(path, true, paths, host)?.service, 'backend', `${path}, strict`);
      }

      for (const path of frontend) {
        assert.equal(routeOf(path, false, paths, host)?.service, 'frontend', `${host} ${path}`);
      }

      // A string prefix: these reach the backend, which answers them 404 / 1000.
      for (const path of ['/mcp/', '/mcp/x', '/mcpx', `/mcp${'x'.repeat(10_000)}`]) {
        assert.equal(routeOf(path, false, paths, host)?.service, 'backend', path.slice(0, 20));
      }
    }
  });

  it('rests on Traefik’s defaults: no priority or path matcher on either Ingress, no strict matching', () => {
    // Each Ingress pins its entry point, and the API's names the edge rate
    // limit's middleware (D264), and the second host's both name the noindex
    // middleware (D275), which leave their routers' priorities alone.
    assert.deepEqual(
      [...INGRESS_YAML.matchAll(/^\s*traefik\.ingress\.kubernetes\.io\/([\w.]+):/gm)].map(
        ([, key]) => key,
      ),
      [
        'router.entrypoints',
        'router.middlewares',
        'router.entrypoints',
        'router.entrypoints',
        'router.middlewares',
        'router.entrypoints',
        'router.middlewares',
      ],
    );
    assert.doesNotMatch(
      read('../../../../deploy/cluster/traefik-config.yaml'),
      /^\s*strictPrefixMatching:/im,
    );
  });
});
