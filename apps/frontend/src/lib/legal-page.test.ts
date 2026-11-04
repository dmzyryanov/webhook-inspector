import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { escapeText, keptRuns, siteFooter, siteHeader } from '../../scripts/site-chrome.mjs';
import type { SiteOrigins } from '../../scripts/site-origin.mjs';
import { CHANGELOG_LINK } from './changelog-link.ts';
import type { LegalPage, LegalPart } from './legal-copy.ts';
import { PRIVACY_LINK, TERMS_LINK } from './legal-links.ts';
import { PRODUCTION_OPERATOR } from '../testing/production-operator.ts';

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
  checkBuild,
  LEGAL_CLAIMS,
  legalPageProblems,
  productionNamesLeft,
  // @ts-expect-error -- a plain ES module with no declarations; the build runs it.
} = await import('../../scripts/check-build.mjs');
const { LEGAL_PLACEHOLDER, legalPagesPlugin, legalTemplate, renderLegalBody, renderLegalPage } =
  await import('../../scripts/legal.mjs');
const { LEGAL_PAGES, legalLineText, privacyPage, STABILITY_POLICY_HREF, termsPage } =
  await import('./legal-copy.ts');
const { PRODUCTION_ORIGINS, SITE_ORIGINS, siteOriginPlugin } =
  await import('../../scripts/site-origin.mjs');

/** A copy at another address with no second origin of its own, as `llms.test.ts` has one (#342). */
const ANOTHER: SiteOrigins = {
  app: 'https://inspector.example',
  receive: 'https://hook.inspector.example',
  alias: null,
};

/** The two pages as production's build writes them (issue #369). */
const TERMS_PAGE = termsPage(PRODUCTION_OPERATOR);
const PRIVACY_PAGE = privacyPage(PRODUCTION_OPERATOR);

/**
 * The Terms of Use at `/terms` and the Privacy Policy at `/privacy` (issue
 * #112, D217), without a browser: the body the build writes from
 * `legal-copy.ts`, the templates' heads, the nginx locations and the dev
 * server that serve them, the build that makes them and the check that fails
 * the build without them. `e2e/legal.spec.ts` opens the pages.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const NBSP = String.fromCharCode(0xa0);

/** What a reader sees of some HTML: tags removed, the three escapes undone, no-break spaces kept. */
const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

/** The one element of a kind in some HTML, whole. */
const element = (tag: string, html: string) =>
  new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`).exec(html)?.[0] ?? '';

/** Each page with its template and its body as the build writes them. */
const PAGES = LEGAL_PAGES.map((page) => {
  const template = read(`../../${legalTemplate(page)}`);

  return { page, template, body: renderLegalBody(page), html: renderLegalPage(page, template) };
});

describe('the pages', () => {
  it('are built here for production’s origins, whatever the shell running the tests holds (#354)', () => {
    assert.deepEqual(SITE_ORIGINS, PRODUCTION_ORIGINS);
  });

  it('are written to terms/index.html and privacy/index.html, each linked from the footer', () => {
    assert.deepEqual(LEGAL_PAGES.map(legalTemplate), ['terms/index.html', 'privacy/index.html']);
    assert.deepEqual(
      LEGAL_PAGES.map((page) => page.path),
      [TERMS_LINK.href, PRIVACY_LINK.href],
    );
  });

  for (const { page, body, html } of PAGES) {
    describe(page.path, () => {
      const main = element('main', body);

      it('holds every text of legal-copy.ts as written, without a script', () => {
        // Byte for byte in the HTML itself, as a curl of the page reads it:
        // nothing in the texts needs an escape.
        for (const text of [
          page.eyebrow,
          page.heading,
          page.introduction,
          page.updated,
          ...page.sections.flatMap((section) => [
            section.label,
            ...section.lines.filter((line) => typeof line === 'string'),
          ]),
        ]) {
          assert.ok(main.includes(text), text);
        }

        assert.doesNotMatch(html, /<script\b/);
      });

      it('draws the eyebrow, the title, the introduction with its date line and the sections, in that order', () => {
        assert.match(
          main,
          new RegExp(
            `^<main>\\n<div class="container">\\n<div class="intro">\\n<p class="eyebrow">[^<]+</p>\\n<h1>[^<]+</h1>\\n</div>\\n<div class="lead"><p>[^<]+</p><p class="updated">[^<]+</p></div>\\n<dl class="facts">(?:<div class="fact"><dt>[^<]+</dt><dd>(?:<p>[\\s\\S]*?</p>)+</dd></div>){${page.sections.length}}</dl>\\n</div>\\n</main>$`,
          ),
        );
        assert.equal(visible(element('h1', body)), page.heading);
        assert.equal(body.split('<h1>').length - 1, 1);
        assert.ok(main.includes(`<p class="updated">${page.updated}</p>`));
        // Each line of a section is a paragraph of its own, reading as written.
        assert.deepEqual(
          [...main.matchAll(/<dd>([\s\S]*?)<\/dd>/g)].map((match) =>
            [...(match[1] as string).matchAll(/<p>([\s\S]*?)<\/p>/g)].map((line) =>
              visible(line[1] as string),
            ),
          ),
          page.sections.map((section) => section.lines.map(legalLineText)),
        );
        assert.deepEqual(
          [...main.matchAll(/<dt>([^<]+)<\/dt>/g)].map((match) => match[1]),
          page.sections.map((section) => section.label),
        );
      });

      it('carries the header every page carries, unchanged, with no current page', () => {
        const header = element('header', body);

        assert.equal(header, siteHeader(page.path));
        assert.equal(header, siteHeader(CHANGELOG_LINK.href).replace(' aria-current="page"', ''));
        assert.doesNotMatch(header, /aria-current/);
      });

      it('closes with the footer band, its own link the current page', () => {
        const footer = element('footer', body);

        assert.equal(footer, siteFooter(page.path));
        assert.deepEqual(
          [...footer.matchAll(/<a class="footer-link" href="([^"]+)" aria-current="page">/g)].map(
            (match) => match[1],
          ),
          [page.path],
        );
        assert.ok(body.endsWith('</footer>'));
      });
    });
  }

  it('links `stability policy` to the Stability section of /docs, in the same tab', () => {
    const main = element('main', renderLegalBody(TERMS_PAGE));

    assert.ok(
      main.includes(
        '<p>API changes follow the <a href="/docs#api-1/description/stability">stability policy</a> in the' +
          `${NBSP}API${NBSP}docs.</p>`,
      ),
    );
    assert.doesNotMatch(main, /target=/);
  });

  it('links every contact address as mail, kept on one line with the word before it', () => {
    const mail = '<a href="mailto:contact@qa-tools.ru">contact@qa-tools.ru</a>';

    assert.deepEqual(
      [
        ...element('main', renderLegalBody(TERMS_PAGE)).matchAll(
          /<span class="keep">(.*?)<\/span>/g,
        ),
      ].map((match) => match[1]),
      [`to ${mail}`],
    );
    assert.deepEqual(
      [
        ...element('main', renderLegalBody(PRIVACY_PAGE)).matchAll(
          /<span class="keep">(.*?)<\/span>/g,
        ),
      ].map((match) => match[1]),
      [`to ${mail}`, `to ${mail},`, `data:${NBSP}${mail}.`],
    );
    // The status page and the MCP server are plain text; nothing else is a link.
    assert.deepEqual(
      PAGES.map(({ body }) =>
        [...element('main', body).matchAll(/<a\b[^>]*>/g)].map((match) => match[0]),
      ),
      [
        [`<a href="${STABILITY_POLICY_HREF}">`, '<a href="mailto:contact@qa-tools.ru">'],
        Array(3).fill('<a href="mailto:contact@qa-tools.ru">'),
      ],
    );
    assert.match(read('../legal/legal.css'), /\.fact dd \.keep \{\n\s*white-space: nowrap;\n\}/);
  });
});

describe('keptRuns, which /about and these pages share', () => {
  const link = (part: LegalPart) =>
    `<a href="${'href' in part ? part.href : ''}">${escapeText(part.text)}</a>`;

  it('keeps an address with the word before it and the text after it up to the next space', () => {
    assert.equal(
      keptRuns(
        [
          { kind: 'text', text: 'Write to ' },
          { kind: 'mail', text: 'a@b.c', href: 'mailto:a@b.c' },
          { kind: 'text', text: ', then wait.' },
        ],
        link,
      ),
      'Write <span class="keep">to <a href="mailto:a@b.c">a@b.c</a>,</span> then wait.',
    );
  });

  it('writes a link to a page where it stands, unkept, and escapes the words', () => {
    assert.equal(
      keptRuns(
        [
          { kind: 'text', text: 'Read <the> ' },
          { kind: 'link', text: 'policy', href: '/docs' },
          { kind: 'text', text: ' & more.' },
        ],
        link,
      ),
      'Read &lt;the&gt; <a href="/docs">policy</a> &amp; more.',
    );
  });

  it('keeps a phrase joined by no-break spaces whole inside the span', () => {
    assert.equal(
      keptRuns(
        [
          { kind: 'text', text: `Questions about your data:${NBSP}` },
          { kind: 'mail', text: 'a@b.c', href: 'mailto:a@b.c' },
          { kind: 'text', text: '.' },
        ],
        link,
      ),
      `Questions about your <span class="keep">data:${NBSP}<a href="mailto:a@b.c">a@b.c</a>.</span>`,
    );
  });

  it('writes hostile runs as text, at growing sizes, whatever they hold', () => {
    const hostile = `<script>alert(1)</script>&amp;"'</a><span class="keep">${NBSP}`;

    for (const size of [1, 1_000, 100_000]) {
      const words = `${hostile} `.repeat(size);
      const parts: LegalPart[] = [
        { kind: 'text', text: words },
        { kind: 'mail', text: hostile, href: 'mailto:x' },
        { kind: 'text', text: words },
      ];
      const html = keptRuns(parts, link);

      assert.doesNotMatch(html, /<script>/, `${size}`);
      // One span of its own, one link; every other tag in the input is text.
      assert.equal(html.split('<span class="keep">').length - 1, 1, `${size}`);
      assert.equal(html.split('<a ').length - 1, 1, `${size}`);
      assert.equal(visible(html), parts.map((part) => part.text).join(''), `${size}`);
    }

    // No space at all before the address, or none after it: nothing is lost.
    for (const parts of [
      [
        { kind: 'text', text: 'x'.repeat(100_000) },
        { kind: 'mail', text: 'a@b.c', href: 'mailto:a@b.c' },
      ],
      [
        { kind: 'mail', text: 'a@b.c', href: 'mailto:a@b.c' },
        { kind: 'text', text: 'y'.repeat(100_000) },
      ],
      [{ kind: 'mail', text: 'a@b.c', href: 'mailto:a@b.c' }],
      [],
    ] as LegalPart[][]) {
      assert.equal(visible(keptRuns(parts, link)), parts.map((part) => part.text).join(''));
    }
  });

  it('writes Cyrillic runs byte for byte at growing sizes, as /ru/about does (D255)', () => {
    const words = `Пишите, что${NBSP}думаете —${NBSP}«ёлка» <b>&amp; `;

    for (const size of [1, 1_000, 100_000]) {
      const parts: LegalPart[] = [
        { kind: 'text', text: words.repeat(size) },
        { kind: 'mail', text: 'почта@qa-tools.ru', href: 'mailto:x' },
        { kind: 'text', text: `.${words.repeat(size)}` },
      ];
      const started = performance.now();
      const html = keptRuns(parts, link);

      assert.ok(performance.now() - started < 2_000, `${size}`);
      assert.doesNotMatch(html, /<b>/, `${size}`);
      assert.equal(html.split('<span class="keep">').length - 1, 1, `${size}`);
      // The span holds the last word before the address, its joined phrase whole.
      assert.ok(html.includes(`<span class="keep">&lt;b&gt;&amp;amp; <a `), `${size}`);
      assert.equal(visible(html), parts.map((part) => part.text).join(''), `${size}`);
    }
  });

  it('draws the header and the band in English or Russian only, whatever page and language it is given (D255)', () => {
    for (const lang of [
      'de',
      'RU',
      'ru ',
      '',
      '__proto__',
      'constructor',
      'toString',
      'ru'.repeat(100_000),
    ]) {
      assert.throws(
        () => siteHeader('/about', lang),
        /a static page cannot be drawn in/,
        lang.slice(0, 9),
      );
      assert.throws(
        () => siteFooter('/about', lang),
        /a static page cannot be drawn in/,
        lang.slice(0, 9),
      );
    }

    // The page is only compared with each link's address: nothing of it is written.
    for (const size of [1, 1_000, 100_000]) {
      const page = `"><script>alert(1)</script>${'/ru/about'.repeat(size)}`;

      for (const lang of ['en', 'ru']) {
        const html = siteHeader(page, lang) + siteFooter(page, lang);

        assert.doesNotMatch(html, /<script>|aria-current/, `${size} ${lang}`);
      }
    }
  });
});

describe('the templates', () => {
  for (const { page, template, html, body } of PAGES) {
    describe(legalTemplate(page), () => {
      /** The template's head, as written. */
      const head = /<head>([\s\S]*?)<\/head>/.exec(template)?.[1] ?? '';

      it('names and describes the page, and points search engines at its address', () => {
        assert.ok(head.includes(`<title>${page.title}</title>`));
        assert.match(
          head,
          new RegExp(`<meta\\s+name="description"\\s+content="${page.description}"\\s*/>`),
        );
        assert.ok(head.includes(`<link rel="canonical" href="${page.url}" />`));
        assert.equal(page.url, `https://qa-tools.ru${page.path}`);
        assert.doesNotMatch(template, /noindex/i);
      });

      it('loads its stylesheet and nothing else: no script, nothing from another origin', () => {
        assert.ok(head.includes('<link rel="stylesheet" href="/src/legal/legal.css" />'));
        assert.doesNotMatch(template, /<script\b/);
        assert.doesNotMatch(template, /src="(?:https?:)?\/\//);
        assert.doesNotMatch(template, /<link rel="(?!canonical")[^"]*"[^>]*href="(?:https?:)?\/\//);
      });

      it('is where the body goes, and nowhere else', () => {
        assert.equal(template.split(LEGAL_PLACEHOLDER).length - 1, 1);
        assert.ok(html.includes(body));
        assert.ok(!html.includes(LEGAL_PLACEHOLDER));
        assert.throws(
          () => renderLegalPage(page, '<body></body>'),
          new RegExp(`the template of ${page.path} has no <!-- legal:page -->`),
        );
      });
    });
  }

  it('styles both pages from /about’s stylesheet, with the introduction, the links and 72 px below on the desktop', () => {
    const css = read('../legal/legal.css');
    const narrow = css.slice(css.indexOf('@media (max-width: 1023.98px) {'));

    assert.ok(css.startsWith('/*'));
    assert.match(css, /^@import '\.\.\/about\/about\.css';$/m);
    assert.match(css, /^main \{\n\s*padding-bottom: 72px;\n\}/m);
    assert.match(narrow, /main \{\n\s*padding-bottom: 40px;\n\s*\}/);
    assert.match(
      css,
      /\.lead \{\n\s*display: flex;\n\s*max-width: 680px;\n\s*flex-direction: column;\n\s*gap: 12px;\n\}/,
    );
    assert.match(
      css,
      /\.lead \.updated \{\n\s*color: #5f697d;\n\s*font-size: 13px;\n\s*line-height: 20px;\n\}/,
    );
  });
});

describe('the Vite plugin', () => {
  const plugin = legalPagesPlugin() as unknown as {
    transformIndexHtml: { handler: (html: string, context: { path: string }) => string };
  };

  it('writes each page into its own template and leaves every other page alone', () => {
    for (const { page, template, html } of PAGES) {
      assert.equal(
        plugin.transformIndexHtml.handler(template, { path: `/${legalTemplate(page)}` }),
        html,
      );
    }

    const about = read('../../about/index.html');

    assert.equal(plugin.transformIndexHtml.handler(about, { path: '/about/index.html' }), about);
    assert.equal(
      plugin.transformIndexHtml.handler('<!-- legal:page -->', { path: '/index.html' }),
      '<!-- legal:page -->',
    );
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

describe('the terms and privacy locations in nginx.conf', () => {
  for (const page of LEGAL_PAGES) {
    it(`serve ${page.path} and ${page.path}/ with the page, never the application shell`, () => {
      for (const address of [page.path, `${page.path}/`]) {
        assert.equal(location(address), `rewrite ^ /${legalTemplate(page)} last;`);
      }
    });

    it(`revalidate ${page.path} on every use, send no X-Robots-Tag, and refuse it by name`, () => {
      assert.equal(
        location(`/${legalTemplate(page)}`),
        [
          'internal;',
          "add_header Cache-Control 'no-cache' always;",
          'error_page 404 /index.html;',
        ].join('\n'),
      );
    });
  }
});

describe('the dev server and the build', () => {
  it('serve both pages at both addresses from the same module as the build', () => {
    const config = read('../../vite.config.ts');

    for (const page of LEGAL_PAGES) {
      assert.ok(config.includes(`path === '${page.path}' || path === '${page.path}/'`));
      assert.ok(config.includes(`req.url = '/${legalTemplate(page)}';`));
    }

    assert.match(config, /plugins: \[[^\]]*legalPagesPlugin\(\)/);
  });

  it('builds both pages in npm run build, as one build of their own, before the build check', () => {
    const build = JSON.parse(read('../../package.json')).scripts.build as string;
    const config = read('../../vite.legal.config.ts');

    assert.ok(build.includes('vite build --config vite.legal.config.ts'));
    assert.ok(build.indexOf('vite.legal.config.ts') < build.indexOf('check-build.mjs'));
    assert.match(config, /terms: fileURLToPath\(new URL\('terms\/index\.html'/);
    assert.match(config, /privacy: fileURLToPath\(new URL\('privacy\/index\.html'/);
    // Amended by D274: and the plugin that names the build's origins, last.
    assert.match(config, /plugins: \[legalPagesPlugin\(\), siteOriginPlugin\(\)\]/);
    assert.match(read('../../tsconfig.json'), /"vite\.legal\.config\.ts"/);
  });

  it('name another address on both pages of a build for it, and no address of production’s (D274)', () => {
    // What that last plugin makes of each page in a build for the copy (#354).
    const named = siteOriginPlugin(ANOTHER).transformIndexHtml.handler;

    for (const { page, html } of PAGES) {
      const built = named(html);

      assert.equal(built.split('rel="canonical"').length - 1, 1, page.path);
      assert.ok(
        built.includes(`<link rel="canonical" href="${ANOTHER.app}${page.path}" />`),
        page.path,
      );
      assert.deepEqual(productionNamesLeft(built, ANOTHER), [], page.path);
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
      return (checkBuild(dist) as string[]).filter((problem) => /terms|privacy/.test(problem));
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  }

  /** A page as the build writes it, its stylesheet a hashed file. */
  const built = (page: LegalPage, html?: string) =>
    (html ?? (PAGES.find((item) => item.page.path === page.path)?.html as string)).replace(
      '<link rel="stylesheet" href="/src/legal/legal.css" />',
      '<link rel="stylesheet" crossorigin href="/assets/legal-EEEEEEEE.css">',
    );

  const both = () => ({
    'terms/index.html': built(TERMS_PAGE),
    'privacy/index.html': built(PRIVACY_PAGE),
    'assets/legal-EEEEEEEE.css': 'body{}',
  });

  it('passes both pages as the build writes them', () => {
    assert.deepEqual(problems(both()), []);
    assert.deepEqual(legalPageProblems(TERMS_PAGE, built(TERMS_PAGE)), []);
    assert.deepEqual(legalPageProblems(PRIVACY_PAGE, built(PRIVACY_PAGE)), []);
  });

  it('fails when either page is missing', () => {
    assert.deepEqual(problems({}), [
      'the terms page terms/index.html was not built',
      'the privacy page privacy/index.html was not built',
    ]);

    assert.deepEqual(
      problems({
        'terms/index.html': built(TERMS_PAGE),
        'assets/legal-EEEEEEEE.css': 'body{}',
      }),
      ['the privacy page privacy/index.html was not built'],
    );
  });

  it('fails when a page lacks its own title, its body, or asks not to be indexed', () => {
    assert.deepEqual(
      problems({
        ...both(),
        // The Terms' title on the privacy page.
        'privacy/index.html': built(PRIVACY_PAGE).replace(
          '<title>Privacy Policy — QA Tools</title>',
          '<title>Terms of Use — QA Tools</title>',
        ),
      }),
      ['the privacy page privacy/index.html has no <title>Privacy Policy — QA Tools</title>'],
    );
    assert.deepEqual(
      legalPageProblems(TERMS_PAGE, built(TERMS_PAGE, PAGES[0]?.template as string)),
      ['the terms page terms/index.html has no body'],
    );
    assert.deepEqual(
      legalPageProblems(
        PRIVACY_PAGE,
        built(PRIVACY_PAGE).replace(/<main>[\s\S]*<\/main>/, '<main></main>'),
      ),
      ['the privacy page privacy/index.html has no body'],
    );
    assert.deepEqual(
      legalPageProblems(
        TERMS_PAGE,
        built(TERMS_PAGE).replace('<head>', '<head><meta name="robots" content="noindex" />'),
      ),
      ['the terms page terms/index.html asks search engines not to index it'],
    );
  });

  // D217 Decision 1, as D224 amends it: the pages name the law that governs
  // the terms and nothing else of the kind, and claim compliance with none.
  const CRITERION = /compl|152|roskomnadzor|gdpr|federal law/i;

  /** A built page with its content-hashed file names left out, which hold no words. */
  const withoutAssets = (html: string) => html.replace(/\/assets\/[^\s"'<>]*/g, '/assets/');

  it('builds both pages with no claim of compliance and no law named but the governing one (D224)', () => {
    for (const page of LEGAL_PAGES) {
      const html = built(page);

      assert.doesNotMatch(withoutAssets(html), CRITERION, page.path);
      assert.doesNotMatch(withoutAssets(html), LEGAL_CLAIMS, page.path);
      assert.deepEqual(legalPageProblems(page, html), [], page.path);
    }

    assert.ok(
      TERMS_PAGE.sections.some((section) =>
        section.lines.some((line) => legalLineText(line).includes('the Russian\u00a0Federation')),
      ),
    );
  });

  it('fails a page that claims compliance or names another law, in its text, its head or a comment (D224)', () => {
    const terms = built(TERMS_PAGE);
    const privacy = built(PRIVACY_PAGE);
    const prefix = (file: string) =>
      `the ${file.split('/')[0]} page ${file} names a law or claims compliance: …`;

    for (const [said, word] of [
      ['They comply with the law.', 'comply'],
      ['QA Tools is GDPR-ready.', 'GDPR'],
      ['Personal data is processed under 152-FZ.', '152-FZ'],
      ['The operator has notified Roskomnadzor.', 'Roskomnadzor'],
      ['Under Federal Law, nothing.', 'Federal Law'],
      [`Under federal${NBSP}law, nothing.`, `federal${NBSP}law`],
      ['In full COMPLIANCE.', 'COMPLIANCE'],
    ] as const) {
      const html = terms.replace('These terms are governed', `${said} These terms are governed`);
      const found = legalPageProblems(TERMS_PAGE, html) as string[];

      assert.equal(found.length, 1, said);
      assert.ok(found[0]?.startsWith(prefix('terms/index.html')), found[0]);
      assert.ok(found[0]?.includes(word), found[0]);
    }

    // In the head and in a comment, where a reader of the source finds it.
    for (const [page, html, word] of [
      [
        PRIVACY_PAGE,
        privacy.replace(
          'where it is kept and when it is deleted."',
          'where it is kept and when it is deleted, under GDPR."',
        ),
        'under GDPR',
      ],
      [TERMS_PAGE, terms.replace('<head>', '<head><!-- after 152-FZ -->'), 'after 152-FZ'],
    ] as const) {
      const found = legalPageProblems(page, html) as string[];

      assert.notEqual(html, built(page), word);
      assert.equal(found.length, 1, word);
      assert.ok(found[0]?.startsWith(prefix(legalTemplate(page))), found[0]);
      assert.ok(found[0]?.includes(word), found[0]);
    }

    // And at build time, in the file the build wrote.
    const atBuild = problems({
      'terms/index.html': terms.replace('<h1>', '<h1>Compliant: '),
      'privacy/index.html': privacy,
      'assets/legal-EEEEEEEE.css': 'body{}',
    });

    assert.equal(atBuild.length, 1);
    assert.ok(atBuild[0]?.startsWith(prefix('terms/index.html')), atBuild[0]);
  });

  it('reads past the content-hashed names, whose hash may hold 152 by chance, and nothing else', () => {
    const terms = built(TERMS_PAGE).replace(
      '/assets/legal-EEEEEEEE.css',
      '/assets/legal-Ab152GDPRcompl.css',
    );

    assert.deepEqual(legalPageProblems(TERMS_PAGE, terms), []);
    // The same name anywhere else is a finding.
    assert.equal(
      legalPageProblems(TERMS_PAGE, terms.replace('<h1>', '<h1>legal-Ab152GDPR ')).length,
      2,
    );
  });

  // Made-up pages built to break the check, at growing sizes: each finding
  // listed once, near misses and asset names never, in one pass.
  for (const size of [1_000, 1_000_000]) {
    it(`lists every finding of a page of ${size.toLocaleString('en')} characters, and only those`, () => {
      const page = (inner: string) => built(TERMS_PAGE).replace('<h1>', `<h1>${inner}`);
      const count = (inner: string) => legalPageProblems(TERMS_PAGE, page(inner)).length;

      const times = (unit: string) => Math.floor(size / unit.length);
      const run = (unit: string) => unit.repeat(times(unit));

      assert.equal(count(run('compl ')), times('compl '));
      assert.equal(count(run('Roskomnadzor')), times('Roskomnadzor'));
      assert.equal(count(run('152')), times('152'));
      assert.equal(count(`federal${' '.repeat(size)}law`), 1);
      assert.equal(count(`federal${NBSP.repeat(size)}law`), 1);
      // Near misses, and the names of the build's files.
      assert.equal(count(run('federal ')), 0);
      assert.equal(count(run('comp l 15 2 gdp r federa law ')), 0);
      assert.equal(count(run('/assets/152gdpr ')), 0);
      assert.equal(count(run('/assets/')), 0);
    });
  }
});
