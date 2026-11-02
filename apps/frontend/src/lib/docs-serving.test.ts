import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GROUPED_CLIENTS } from '@scalar/types/snippetz';
import { renderAboutPage } from '../../scripts/about.mjs';
import {
  BUILT_PAGES,
  checkBuild,
  COMMENTED_PAGES,
  SCALAR_FREE_PAGES,
  // @ts-expect-error -- a plain ES module with no declarations; the build runs it.
} from '../../scripts/check-build.mjs';
import { SECURITY_TXT_FILE, securityTxt } from '../../scripts/build-security-txt.mjs';
import { productionRelayScriptText } from '../../scripts/build-site-files.mjs';
import { changelogFeed, readChangelog } from '../../scripts/changelog.mjs';
import {
  CODE_SAMPLE_CLIENTS,
  HIDDEN_CLIENTS,
  OPENAPI_PATH,
  referenceConfiguration,
} from '../docs/reference-config.ts';
import { ABOUT_RU } from '../lib/about-copy-ru.ts';

/**
 * The API reference at `/docs` (D155), without a browser: the nginx locations
 * that serve it, the application's own imports, the Scalar configuration and
 * the check the build runs on its output. `e2e/api-docs.spec.ts` renders the
 * page and watches its network traffic.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

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

describe('the /docs locations in nginx.conf', () => {
  it('serve the reference page for /docs and /docs/, never the application shell', () => {
    for (const address of ['/docs', '/docs/']) {
      assert.equal(location(address), 'rewrite ^ /docs/index.html last;');
    }
  });

  it('revalidate the page on every use, and refuse it by its own name', () => {
    const page = location('/docs/index.html');

    assert.match(page, /^internal;$/m);
    assert.match(page, /^add_header Cache-Control 'no-cache' always;$/m);
    // By its own name it is an unknown address: 404 with the application (D146).
    assert.match(page, /^error_page 404 \/index\.html;$/m);
  });

  it('leave the reference bundle to the long-cached /assets/ location', () => {
    assert.match(
      read('../../nginx.conf'),
      /location \/assets\/ \{\n\s*add_header Cache-Control 'public, max-age=31536000, immutable';/,
    );
  });
});

/** Every module the application loads from `src/main.tsx`, by relative import. */
function applicationModules(): Map<string, string> {
  const root = fileURLToPath(new URL('../main.tsx', import.meta.url));
  const modules = new Map<string, string>();
  const queue = [root];

  while (queue.length > 0) {
    const file = queue.shift() as string;

    if (modules.has(file)) {
      continue;
    }

    const source = readFileSync(file, 'utf8');

    modules.set(file, source);

    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g)) {
      const target = join(dirname(file), match[1] as string);

      if (/\.tsx?$/.test(target)) {
        queue.push(target);
      }
    }
  }

  return modules;
}

describe('the application', () => {
  it('imports neither Scalar nor the reference page', () => {
    const modules = applicationModules();

    assert.ok(modules.size > 10, `only ${modules.size} modules were found from main.tsx`);

    for (const [file, source] of modules) {
      assert.doesNotMatch(source, /['"]@scalar\//, `${file} imports Scalar`);
      assert.ok(!file.includes(`${join('src', 'docs')}`), `${file} is part of the reference page`);
    }
  });
});

describe('the Scalar configuration', () => {
  const configuration = referenceConfiguration('https://example.test') as Record<string, unknown>;

  it('reads the description from the page origin and calls only that origin', () => {
    assert.equal(configuration.url, OPENAPI_PATH);
    assert.equal(OPENAPI_PATH, '/openapi.json');
    assert.deepEqual(configuration.servers, [{ url: 'https://example.test' }]);
    assert.ok(!('proxyUrl' in configuration), 'Test Request must not go through a proxy');
    assert.equal(configuration.withDefaultFonts, false);
    assert.equal(configuration.telemetry, false);
  });

  it('turns off every hosted-service entry point', () => {
    assert.equal(configuration.showDeveloperTools, 'never');
    assert.deepEqual(configuration.agent, { disabled: true });
    assert.deepEqual(configuration.mcp, { disabled: true });
    assert.equal(configuration.hideClientButton, true);
  });

  it('is light only, with no toggle, and keeps Test Request', () => {
    assert.equal(configuration.darkMode, false);
    assert.equal(configuration.forceDarkModeState, 'light');
    assert.equal(configuration.hideDarkModeToggle, true);
    assert.equal(configuration.hideTestRequestButton, false);
  });

  it('offers curl, JavaScript fetch and Python requests, curl selected', () => {
    // Scalar's own client list, filtered the way Scalar filters it.
    const visible = Object.entries(GROUPED_CLIENTS).flatMap(([target, clients]) => {
      const hidden = (HIDDEN_CLIENTS as Record<string, true | string[]>)[target];

      return (clients as readonly string[])
        .filter((client) => hidden !== true && !(hidden ?? []).includes(client))
        .map((client) => `${target}/${client}`);
    });

    assert.deepEqual(visible.sort(), [...CODE_SAMPLE_CLIENTS].sort());
    assert.deepEqual(configuration.defaultHttpClient, { targetKey: 'shell', clientKey: 'curl' });
    assert.equal(CODE_SAMPLE_CLIENTS[0], 'shell/curl');
  });
});

describe('the build check', () => {
  const page = (assets: string[]) =>
    `<html><head>${assets.map((name) => `<script src="/assets/${name}"></script>`).join('')}</head></html>`;

  /**
   * The files `public/` puts in every build: for search engines (D183), and
   * the relay script (D202), whose SHA-256 under both its names the build
   * checks against the description's.
   */
  const publicFiles = () =>
    Object.fromEntries(
      [
        'robots.txt',
        'sitemap.xml',
        'favicon.ico',
        'favicon-192.png',
        'logo-512.png',
        'webhook-inspector-relay.mjs',
      ]
        .map((name) => [name, readFileSync(new URL(`../../public/${name}`, import.meta.url))])
        // The description as the build writes it beside them (D274), and the
        // relay script under its old name, which the build writes from the
        // same source in public/ (D275, D279).
        .concat([
          [
            'openapi.json',
            readFileSync(new URL('../../../../packages/shared/openapi.json', import.meta.url)),
          ],
          ['qa-tools-relay.mjs', Buffer.from(productionRelayScriptText())],
        ]),
    );

  function build(files: Record<string, string | Buffer>) {
    const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-dist-'));

    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dist, name)), { recursive: true });
      writeFileSync(join(dist, name), text);
    }

    try {
      return checkBuild(dist) as string[];
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  }

  /**
   * A home page as the build writes it from its template (D226): the source
   * script replaced by the application's hashed one, which the English and
   * the Russian home page share by design.
   */
  const homePage = (template: string) =>
    read(template).replace(
      '<script type="module" src="/src/main.tsx"></script>',
      '<script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script>',
    );

  /**
   * An about page as the build writes it from its template (D211, D255), its
   * stylesheet a hashed file the two pages share.
   */
  const aboutPage = (template: string, copy?: typeof ABOUT_RU) =>
    renderAboutPage(read(template), copy).replace(
      '<link rel="stylesheet" href="/src/about/about.css" />',
      '<link rel="stylesheet" crossorigin href="/assets/about-EEEEEEEE.css">',
    );

  // Amended by D255: eight pages, the about page in both languages, each as
  // the build writes it, since the check now reads its language, its
  // canonical address and its hreflang pair.
  it('passes eight pages, the two home pages sharing the application and the others nothing, Scalar only on /docs', () => {
    assert.deepEqual(
      build({
        'index.html': homePage('../../index.html'),
        'ru/index.html': homePage('../../ru/index.html'),
        'docs/index.html': page(['docs-BBBBBBBB.js']),
        'changelog/index.html': page(['changelog-DDDDDDDD.js']).replace(
          '</html>',
          '<details class="version" id="v0.1.0"></details></html>',
        ),
        'assets/changelog-DDDDDDDD.js': 'console.log("changelog")',
        // The about page and its Russian twin load a stylesheet and no script (D211, D255).
        'about/index.html': aboutPage('../../about/index.html'),
        'ru/about/index.html': aboutPage('../../ru/about/index.html', ABOUT_RU),
        'assets/about-EEEEEEEE.css': 'body { margin: 0; }',
        // The Terms of Use and the Privacy Policy share a stylesheet and load no script (D217).
        'terms/index.html':
          '<html><head><title>Terms of Use — QA Tools</title><link rel="stylesheet" href="/assets/legal-FFFFFFFF.css"></head><body><main><h1>The rules</h1></main></body></html>',
        'privacy/index.html':
          '<html><head><title>Privacy Policy — QA Tools</title><link rel="stylesheet" href="/assets/legal-FFFFFFFF.css"></head><body><main><h1>What QA Tools keeps</h1></main></body></html>',
        'assets/legal-FFFFFFFF.css': 'body { margin: 0; }',
        'changelog.md': '# Webhook Inspector — Changelog\n',
        // The two feeds the build writes from CHANGELOG.md (D212).
        'changelog.xml': changelogFeed(readChangelog(), 'all'),
        'changelog-breaking.xml': changelogFeed(readChangelog(), 'breaking'),
        'assets/index-AAAAAAAA.js': 'console.log("app")',
        'assets/docs-BBBBBBBB.js': 'import("./chunk-CCCCCCCC.js")',
        'assets/chunk-CCCCCCCC.js': 'const c = "scalar-app";',
        'llms.txt': '# Webhook Inspector',
        'llms-full.txt': '# Webhook Inspector API — the complete guide for agents',
        [SECURITY_TXT_FILE]: securityTxt(),
        ...publicFiles(),
      }),
      [],
    );
  });

  it('fails when the Russian home page reaches Scalar or loads a file of the API reference (D226)', () => {
    const problems = build({
      'index.html': page(['index-AAAAAAAA.js']),
      'ru/index.html': page(['index-AAAAAAAA.js', 'chunk-CCCCCCCC.js']),
      'docs/index.html': page(['docs-BBBBBBBB.js']),
      'assets/index-AAAAAAAA.js': 'console.log("app")',
      'assets/docs-BBBBBBBB.js': 'import "./chunk-CCCCCCCC.js"',
      'assets/chunk-CCCCCCCC.js': 'const c = "scalar-app";',
    });

    assert.ok(
      problems.includes(
        'the Russian home page loads chunk-CCCCCCCC.js, which carries Scalar ("scalar-app")',
      ),
    );
    assert.ok(
      problems.includes('the Russian home page and the API reference both load chunk-CCCCCCCC.js'),
    );
    assert.ok(!problems.some((problem) => problem.includes('index-AAAAAAAA.js')));
  });

  it('fails when the agent documentation is missing or empty (D165)', () => {
    const problems = build({
      'index.html': page(['index-AAAAAAAA.js']),
      'docs/index.html': page(['docs-BBBBBBBB.js']),
      'assets/index-AAAAAAAA.js': '',
      'assets/docs-BBBBBBBB.js': '"scalar-app"',
      'llms.txt': '',
    });

    assert.ok(problems.includes('the agent documentation llms.txt was not built'));
    assert.ok(problems.includes('the agent documentation llms-full.txt was not built'));
  });

  it('fails when the application reaches Scalar through a chunk', () => {
    const problems = build({
      'index.html': page(['index-AAAAAAAA.js']),
      'docs/index.html': page(['docs-BBBBBBBB.js']),
      'assets/index-AAAAAAAA.js': 'import "./chunk-CCCCCCCC.js"',
      'assets/docs-BBBBBBBB.js': 'import "./chunk-CCCCCCCC.js"',
      'assets/chunk-CCCCCCCC.js': 'const c = "scalar-app";',
    });

    assert.ok(problems.some((problem) => problem.includes('carries Scalar')));
    assert.ok(problems.some((problem) => problem.includes('both load chunk-CCCCCCCC.js')));
  });

  it('fails when the about page reaches Scalar, or loads a file without a hash (D211)', () => {
    const problems = build({
      'about/index.html':
        '<html><head><title>About QA Tools</title><script src="/assets/about-EEEEEEEE.js"></script><link rel="stylesheet" href="/assets/about.css"></head><body><main><h1>About</h1></main></body></html>',
      'assets/about-EEEEEEEE.js': 'import "./chunk-CCCCCCCC.js"',
      'assets/chunk-CCCCCCCC.js': 'const c = "scalar-app";',
      'assets/about.css': '',
    });

    assert.ok(
      problems.includes(
        'the about page loads chunk-CCCCCCCC.js, which carries Scalar ("scalar-app")',
      ),
    );
    assert.ok(problems.includes('the about page loads about.css, which has no content hash'));
  });

  it('fails when the Russian about page reaches Scalar, or loads a file without a hash (D255)', () => {
    const problems = build({
      'ru/about/index.html':
        '<html lang="ru"><head><title>О QA Tools</title><script src="/assets/ru-about-EEEEEEEE.js"></script><link rel="stylesheet" href="/assets/about.css"></head><body><main><h1>О</h1></main></body></html>',
      'assets/ru-about-EEEEEEEE.js': 'import "./chunk-CCCCCCCC.js"',
      'assets/chunk-CCCCCCCC.js': 'const c = "scalar-app";',
      'assets/about.css': '',
    });

    assert.ok(
      problems.includes(
        'the Russian about page loads chunk-CCCCCCCC.js, which carries Scalar ("scalar-app")',
      ),
    );
    assert.ok(
      problems.includes('the Russian about page loads about.css, which has no content hash'),
    );
  });

  it('checks every page it builds but the API reference for Scalar, and the source of every one', () => {
    // A page added to the build and not to the Scalar check would never be
    // checked for Scalar: the two lists are held to each other here.
    assert.deepEqual(
      Object.keys(SCALAR_FREE_PAGES),
      Object.keys(BUILT_PAGES).filter((page) => page !== 'API reference'),
    );
    assert.deepEqual([...COMMENTED_PAGES].sort(), Object.values(BUILT_PAGES).sort());
    assert.equal(BUILT_PAGES['Russian about'], 'ru/about/index.html');
    assert.equal(SCALAR_FREE_PAGES['Russian about'], 'the Russian about page');

    // And each page's name in a Scalar problem is the one the check gives it.
    const dist = Object.fromEntries(
      Object.entries(BUILT_PAGES as Record<string, string>).map(([name, file]) => [
        file,
        page([`${name.replaceAll(' ', '-')}-AAAAAAAA.js`]),
      ]),
    );
    const scripts = Object.fromEntries(
      Object.keys(BUILT_PAGES).map((name) => [
        `assets/${name.replaceAll(' ', '-')}-AAAAAAAA.js`,
        'const c = "scalar-app";',
      ]),
    );
    const problems = build({ ...dist, ...scripts });

    for (const [name, named] of Object.entries(SCALAR_FREE_PAGES as Record<string, string>)) {
      assert.ok(
        problems.includes(
          `${named} loads ${name.replaceAll(' ', '-')}-AAAAAAAA.js, which carries Scalar ("scalar-app")`,
        ),
        name,
      );
    }
  });

  it('fails when the terms or the privacy page reaches Scalar, or loads a file without a hash (D217)', () => {
    const problems = build({
      'terms/index.html':
        '<html><head><title>Terms of Use — QA Tools</title><script src="/assets/terms-EEEEEEEE.js"></script></head><body><main><h1>Terms</h1></main></body></html>',
      'privacy/index.html':
        '<html><head><title>Privacy Policy — QA Tools</title><link rel="stylesheet" href="/assets/legal.css"></head><body><main><h1>Privacy</h1></main></body></html>',
      'assets/terms-EEEEEEEE.js': 'import "./chunk-CCCCCCCC.js"',
      'assets/chunk-CCCCCCCC.js': 'const c = "scalar-app";',
      'assets/legal.css': '',
    });

    assert.ok(
      problems.includes(
        'the terms page loads chunk-CCCCCCCC.js, which carries Scalar ("scalar-app")',
      ),
    );
    assert.ok(problems.includes('the privacy page loads legal.css, which has no content hash'));
  });

  it('fails when the changelog page reaches Scalar (D184)', () => {
    const problems = build({
      'changelog/index.html': page(['changelog-DDDDDDDD.js']),
      'assets/changelog-DDDDDDDD.js': 'import "./chunk-CCCCCCCC.js"',
      'assets/chunk-CCCCCCCC.js': 'const c = "scalar-app";',
    });

    assert.ok(
      problems.includes(
        'the changelog loads chunk-CCCCCCCC.js, which carries Scalar ("scalar-app")',
      ),
    );
  });

  it('fails when a comment in the reference page names an issue or a decision', () => {
    const problems = build({
      'docs/index.html': page(['docs-BBBBBBBB.js']).replace(
        '<head>',
        "<head><!-- The changelog's two Atom feeds (D212), as #133 asked. -->",
      ),
      'assets/docs-BBBBBBBB.js': '"scalar-app"',
    });

    assert.deepEqual(
      problems.filter((problem) => problem.includes('in a comment')),
      [
        "docs/index.html publishes in a comment an issue reference: …g's two Atom feeds (D212), as #133 asked.…",
        "docs/index.html publishes in a comment a decision reference: …e changelog's two Atom feeds (D212), as #133 asked.…",
      ],
    );
  });

  it('fails when the reference page is missing or its bundle has no hash', () => {
    assert.ok(
      build({
        'index.html': page(['index-AAAAAAAA.js']),
        'assets/index-AAAAAAAA.js': '',
      }).some((problem) => problem.includes('docs/index.html was not built')),
    );
    assert.ok(
      build({
        'index.html': page(['index-AAAAAAAA.js']),
        'docs/index.html': page(['scalar.js']),
        'assets/index-AAAAAAAA.js': '',
        'assets/scalar.js': '"scalar-app"',
      }).some((problem) => problem.includes('has no content hash')),
    );
  });
});
