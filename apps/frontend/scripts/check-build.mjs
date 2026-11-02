/**
 * Runs at the end of `npm run build` in this workspace, and so inside the
 * frontend image build (D155): proves on the real output that the two pages
 * the build produced stayed apart.
 *
 * - `dist/index.html` is the application and `dist/docs/index.html` the API
 *   reference at /docs; both exist.
 * - `dist/ru/index.html` is the Russian home page at /ru/ (D226), the
 *   application under a head of its own. Each home page has its language's
 *   `lang`, its `<title>` - the one the application keeps once loaded -
 *   exactly one canonical address and the same `og:url`, the reciprocal
 *   hreflang set (`en` and `x-default` to /, `ru` to /ru/), and no
 *   `noindex`. The Russian page loads the application's own files by
 *   design; like it, it reaches no Scalar and shares nothing with /docs.
 * - Every script and stylesheet either page loads, followed through the static
 *   and dynamic imports between chunks, is a content-hashed file under
 *   `/assets/`, which nginx caches for a year.
 * - Nothing the application loads carries Scalar, and the application and
 *   the reference page share no script or stylesheet. The reference page does carry Scalar, which is what
 *   makes the first check mean something.
 * - The agent documentation `llms.txt` and `llms-full.txt` (D165), written by
 *   `scripts/build-llms.mjs`, is there and not empty.
 * - `.well-known/security.txt` (RFC 9116, D177), written by
 *   `scripts/build-security-txt.mjs`, is there with the project's `Contact`
 *   and an `Expires` in the future and less than a year ahead.
 * - The changelog (D184): `dist/changelog/index.html`, the page at
 *   /changelog, loads only content-hashed files and no Scalar, and lists
 *   versions; `changelog.md`, written by `scripts/build-changelog.mjs`, is
 *   there and not empty; and the text of neither names an issue, a decision,
 *   a repository path or an infrastructure object. Nor does a comment in the
 *   source of any page the build writes — the application, the Russian home
 *   page, the API reference, the changelog, the about page and its Russian
 *   twin, the Terms of Use and the Privacy Policy — which every reader can
 *   open though the text leaves it out.
 * - The changelog's two Atom feeds (D212), written by the same script:
 *   `changelog.xml` and `changelog-breaking.xml` are there, each well-formed
 *   XML whose root is an Atom `<feed>`, with one entry per version it
 *   carries — every version of `CHANGELOG.md`, or only those with a Breaking,
 *   Deprecated or Notice paragraph — newest first, each with its version's id, a
 *   title naming its version, an RFC 3339 `updated`, a link to its line on
 *   /changelog and content; and no text in either names what the page may
 *   not.
 * - The about page (D211): `dist/about/index.html`, the page at /about, loads
 *   only content-hashed files and no Scalar, has the title `About QA Tools`,
 *   has had its body written, and asks no search engine to leave it out; and
 *   its Russian twin (D255), `dist/ru/about/index.html` at /ru/about, the
 *   same way with the title `О QA Tools`. Each is `<html lang>` of its
 *   language, has exactly one canonical address, its own, and carries the
 *   pair's reciprocal hreflang set (`en` and `x-default` to /about, `ru` to
 *   /ru/about).
 * - The Terms of Use and the Privacy Policy (D217): `dist/terms/index.html`
 *   and `dist/privacy/index.html`, the pages at /terms and /privacy, the same
 *   way, each with its own title; and neither claims compliance with a law
 *   nor names one but the law that governs the terms (D224).
 * - The files for search engines and link previews (D183), copied from
 *   `public/`, are there: `robots.txt`; `sitemap.xml`, which lists every page
 *   the site offers search engines and no session page or address
 *   `robots.txt` closes; `favicon.ico`, holding 16, 32 and
 *   48 px; and the two PNG logo images at their sizes.
 * - The relay script (D202) under its name, `webhook-inspector-relay.mjs`
 *   (D275), written from `public/`, is there, and its SHA-256 is the one
 *   `/docs` gives for it, the only one the relay section of the built
 *   `openapi.json` names; and under its old name, `qa-tools-relay.mjs`, it is
 *   there too, the same bytes with that same SHA-256 (D279).
 * - Every address above is on the origin the build names (D274), and a build
 *   for origins other than production's names `qa-tools.ru` nowhere but in
 *   the names kept, `contact@qa-tools.ru`, `status.qa-tools.ru` and the
 *   feeds' `tag:qa-tools.ru` ids, and in its own hosts; and no text file
 *   names a configured host that has a port with a second port after it
 *   (#339).
 *
 * Usage: node scripts/check-build.mjs [dist directory]
 */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { en } from '../src/i18n/en.ts';
import { ru } from '../src/i18n/ru.ts';
import { CONTACT_MAILTO } from '../src/lib/contact.ts';
import { LEGAL_PAGES } from '../src/lib/legal-copy.ts';
import { isWellFormedXml } from '../src/lib/xml-format.ts';
import {
  ABOUT_EN,
  ABOUT_PAGE,
  ABOUT_PAGES,
  ABOUT_PLACEHOLDER,
  ABOUT_RU,
  aboutTemplate,
  RUSSIAN_ABOUT_PAGE,
} from './about.mjs';
import { SECURITY_TXT_FILE, SECURITY_TXT_URL } from './build-security-txt.mjs';
import {
  CHANGELOG_URL,
  feedEntryId,
  FEEDS,
  pageText,
  publishedTextProblems,
  readChangelog,
  readFeedEntries,
} from './changelog.mjs';
import { LEGAL_PLACEHOLDER, legalTemplate } from './legal.mjs';
import {
  documentedRelayHashes,
  OLD_RELAY_SCRIPT_NAME,
  RELAY_SCRIPT_NAME,
  sha256Hex,
} from './relay-script.mjs';
import { APP_ORIGIN, isProduction, SITE_ORIGINS } from './site-origin.mjs';

/** Strings only Scalar's build contains: its root class, its entry, its hosts. */
export const SCALAR_MARKERS = ['scalar-app', 'createApiReference', 'scalar.com'];

/** Served by their own nginx locations as Markdown (D165). */
export const AGENT_FILES = ['llms.txt', 'llms-full.txt'];

/**
 * The public OpenAPI description as the build writes it, which the image
 * serves at /openapi.json and whose relay section gives the relay script's
 * SHA-256 (D202): `packages/shared/openapi.json` under the build's origins
 * (`build-site-files.mjs`, D274).
 */
export const OPENAPI_FILE = 'openapi.json';

/** Whether `name` is a file of the build that is not empty. */
function builtFile(dist, name) {
  const path = join(dist, name);

  return existsSync(path) && statSync(path).size > 0;
}

/**
 * What is wrong with the relay script in the build (D202): missing under
 * either name (D275), or either with a SHA-256 other than the single one
 * `description` gives for it - the same file under both names (D279).
 */
export function relayScriptProblems(dist, description) {
  const documented = documentedRelayHashes(description);

  return [RELAY_SCRIPT_NAME, OLD_RELAY_SCRIPT_NAME].flatMap((name) => {
    if (!builtFile(dist, name)) {
      return [`${name} is not in the build`];
    }

    const hash = sha256Hex(readFileSync(join(dist, name)));

    return documented.length === 1 && documented[0] === hash
      ? []
      : [
          `${name} has the SHA-256 ${hash}, and the API description gives ${documented.join(', ') || 'none'}`,
        ];
  });
}

/** The Russian home page (D226), at /ru/: the application under a Russian head. */
export const RUSSIAN_HOME_PAGE = 'ru/index.html';

/** The reciprocal hreflang set both home pages carry (D226), language and address. */
export const HREFLANG = [
  ['en', `${APP_ORIGIN}/`],
  ['ru', `${APP_ORIGIN}/ru/`],
  ['x-default', `${APP_ORIGIN}/`],
];

/**
 * The two home pages (D183, D226), by their built file: the `lang` of each,
 * the `<title>` the application keeps once it has loaded (`title.home` of its
 * language's dictionary), and its canonical address.
 */
export const HOME_PAGES = {
  'index.html': { lang: 'en', title: en.title.home, canonical: `${APP_ORIGIN}/` },
  [RUSSIAN_HOME_PAGE]: { lang: 'ru', title: ru.title.home, canonical: `${APP_ORIGIN}/ru/` },
};

/** Every `<link>` or `<meta>` of a page as a map of its attributes. */
function tagAttributes(html, tag) {
  return [...html.matchAll(new RegExp(`<${tag}\\s([^>]*)>`, 'g'))].map((match) =>
    Object.fromEntries(
      [...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((pair) => [pair[1], pair[2]]),
    ),
  );
}

/**
 * What is wrong with a built home page, `file` its name in the build (D183,
 * D226): not its language's `lang`, not its title, other than exactly one
 * canonical address and one `og:url` with it, not the hreflang set, or a
 * `noindex` that would keep it out of search.
 */
export function homePageProblems(file, html) {
  const expected = HOME_PAGES[file];
  const problems = [];

  if (!new RegExp(`<html lang="${expected.lang}">`).test(html)) {
    problems.push(`the home page ${file} is not <html lang="${expected.lang}">`);
  }

  if (!html.includes(`<title>${expected.title}</title>`)) {
    problems.push(`the home page ${file} has no <title>${expected.title}</title>`);
  }

  const links = tagAttributes(html, 'link');
  const canonical = links.filter((link) => link.rel === 'canonical').map((link) => link.href);
  const urls = tagAttributes(html, 'meta')
    .filter((meta) => meta.property === 'og:url')
    .map((meta) => meta.content);

  if (canonical.length !== 1 || canonical[0] !== expected.canonical) {
    problems.push(`the home page ${file} does not have the one canonical ${expected.canonical}`);
  }

  if (urls.length !== 1 || urls[0] !== expected.canonical) {
    problems.push(`the home page ${file} does not have the one og:url ${expected.canonical}`);
  }

  const alternates = links
    .filter((link) => link.rel === 'alternate' && 'hreflang' in link)
    .map((link) => [link.hreflang, link.href]);

  if (JSON.stringify(alternates) !== JSON.stringify(HREFLANG)) {
    problems.push(`the home page ${file} does not carry the hreflang set of both home pages`);
  }

  if (/noindex/i.test(html)) {
    problems.push(`the home page ${file} asks search engines not to index it`);
  }

  return problems;
}

/** The changelog's two outputs (D184): the page at /changelog and its text. */
export const CHANGELOG_PAGE = 'changelog/index.html';
export const CHANGELOG_TEXT = 'changelog.md';

/**
 * The Terms of Use and the Privacy Policy (D217), by the name each is called
 * in a problem, `terms` and `privacy`, with its built file.
 */
export const LEGAL_PAGE_FILES = Object.fromEntries(
  LEGAL_PAGES.map((page) => [page.path.slice(1), legalTemplate(page)]),
);

/**
 * Every page the build writes — the application, the Russian home page, the
 * API reference, the changelog, the about page and its Russian twin, the
 * Terms of Use and the Privacy Policy — whose comments, served in their
 * source, are held to the changelog's rules.
 */
export const COMMENTED_PAGES = [
  'index.html',
  RUSSIAN_HOME_PAGE,
  'docs/index.html',
  CHANGELOG_PAGE,
  ABOUT_PAGE,
  RUSSIAN_ABOUT_PAGE,
  ...Object.values(LEGAL_PAGE_FILES),
];

/**
 * Every page the build writes, by the name a problem calls it, with its built
 * file: each must be there and load only content-hashed files.
 */
export const BUILT_PAGES = {
  application: 'index.html',
  'Russian home': RUSSIAN_HOME_PAGE,
  'API reference': 'docs/index.html',
  changelog: CHANGELOG_PAGE,
  about: ABOUT_PAGE,
  'Russian about': RUSSIAN_ABOUT_PAGE,
  ...LEGAL_PAGE_FILES,
};

/**
 * Every page of `BUILT_PAGES` but the API reference, as its problems name it:
 * none may reach Scalar. A page built but missing here would never be
 * checked, so `docs-serving.test.ts` holds the two lists to each other.
 */
export const SCALAR_FREE_PAGES = {
  application: 'the application',
  'Russian home': 'the Russian home page',
  changelog: 'the changelog',
  about: 'the about page',
  'Russian about': 'the Russian about page',
  terms: 'the terms page',
  privacy: 'the privacy page',
};

/**
 * The text of every comment in `html`, in order, as a browser reads it: from
 * each `<!--` to the next `-->`, `<!-->` and `<!--->` closing at once, and an
 * unclosed one running to the end of the page. Each search starts where the
 * last ended, so a page costs one pass however its comments are broken.
 */
export function pageComments(html) {
  const comments = [];
  let start = html.indexOf('<!--');

  while (start !== -1) {
    const end = html.indexOf('-->', start + 2);

    if (end === -1) {
      comments.push(html.slice(start + 4));
      break;
    }

    comments.push(html.slice(start + 4, Math.max(start + 4, end)));
    start = html.indexOf('<!--', end + 3);
  }

  return comments;
}

/**
 * What the comments of a built page, `file` its name in the build, publish
 * that the changelog may not: `pageText` leaves a comment out, but the page's
 * source carries it to every reader.
 */
export function pageCommentProblems(file, html) {
  const problems = [];

  for (const comment of pageComments(html)) {
    for (const problem of publishedTextProblems(comment.replace(/\s+/g, ' ').trim())) {
      problems.push(`${file} publishes in a comment ${problem}`);
    }
  }

  return problems;
}

/** What an Atom feed of the build opens with: the declaration, then the root in Atom's namespace. */
const ATOM_OPENING =
  '<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"';

const RFC_3339_DAY = /^\d{4}-\d{2}-\d{2}T00:00:00Z$/;

/**
 * What is wrong with one of the changelog's built feeds (D212), `file` its
 * name in the build and `versions` the versions it must carry, newest first:
 * not well-formed XML, not an Atom feed, other entries than those versions or
 * in another order, an entry without its version's id, a title naming its
 * version, an RFC 3339 `updated`, its link on /changelog or content, or text
 * that names what the changelog may not publish.
 */
export function changelogFeedProblems(file, xml, versions) {
  if (!isWellFormedXml(xml)) {
    return [`the changelog feed ${file} is not well-formed XML`];
  }

  if (!xml.startsWith(ATOM_OPENING)) {
    return [`the changelog feed ${file} is not an Atom feed`];
  }

  const problems = [];
  const entries = readFeedEntries(xml);
  const carried = entries.map((entry) => entry.id);
  const expected = versions.map(feedEntryId);

  if (carried.join('\n') !== expected.join('\n')) {
    problems.push(
      `the changelog feed ${file} carries ${entries.length} entries, not the ${versions.length} versions it should, newest first`,
    );
  }

  entries.forEach((entry, index) => {
    const version = versions[index];

    if (
      version === undefined ||
      !entry.title?.startsWith(`${version} — `) ||
      !RFC_3339_DAY.test(entry.updated ?? '') ||
      entry.link !== `${CHANGELOG_URL}#v${version}` ||
      !entry.content
    ) {
      problems.push(`the changelog feed ${file} has an incomplete entry ${entry.id ?? index}`);
    }

    for (const problem of publishedTextProblems(
      `${entry.title ?? ''}\n${pageText(entry.content ?? '')}`,
    )) {
      problems.push(`${file} publishes ${problem}`);
    }
  });

  return problems;
}

/** The reciprocal hreflang set both about pages carry (D255), language and address. */
export const ABOUT_HREFLANG = [
  ['en', ABOUT_EN.url],
  ['ru', ABOUT_RU.url],
  ['x-default', ABOUT_EN.url],
];

/**
 * What is wrong with a built about page (D211, D255), `/about`'s unless
 * `page` is the Russian one: not its title, not its language's `lang`, a
 * body never written, other than exactly one canonical address, its own, not
 * the pair's hreflang set, or a `noindex` that would keep it out of search.
 */
export function aboutPageProblems(html, page = ABOUT_EN) {
  const named = `${page.lang === 'ru' ? 'the Russian about page' : 'the about page'} ${aboutTemplate(page)}`;
  const problems = [];

  if (!html.includes(`<title>${page.title}</title>`)) {
    problems.push(`${named} has no <title>${page.title}</title>`);
  }

  if (!new RegExp(`<html lang="${page.lang}">`).test(html)) {
    problems.push(`${named} is not <html lang="${page.lang}">`);
  }

  if (html.includes(ABOUT_PLACEHOLDER) || !/<main>[\s\S]*<h1>[\s\S]*<\/main>/.test(html)) {
    problems.push(`${named} has no body`);
  }

  const links = tagAttributes(html, 'link');
  const canonical = links.filter((link) => link.rel === 'canonical').map((link) => link.href);
  const alternates = links
    .filter((link) => link.rel === 'alternate' && 'hreflang' in link)
    .map((link) => [link.hreflang, link.href]);

  if (canonical.length !== 1 || canonical[0] !== page.url) {
    problems.push(`${named} does not have the one canonical ${page.url}`);
  }

  if (JSON.stringify(alternates) !== JSON.stringify(ABOUT_HREFLANG)) {
    problems.push(`${named} does not carry the hreflang set of both about pages`);
  }

  if (/noindex/i.test(html)) {
    problems.push(`${named} asks search engines not to index it`);
  }

  return problems;
}

/**
 * What the Terms of Use and the Privacy Policy never say (D217 Decision 1,
 * D224): they claim compliance with no law, and name none but the law that
 * governs the terms — no 152-FZ, no Roskomnadzor, no GDPR, no federal law,
 * its two words apart by any space, the no-break one included. Matched
 * case-insensitively against the whole built page but its content-hashed
 * asset names, whose hash could hold `152` by chance.
 */
export const LEGAL_CLAIMS = /compl|152|roskomnadzor|gdpr|federal\s+law/i;

/** A content-hashed file of the build, `/assets/<name>-<hash>.<ext>`, as a page links it. */
const ASSET_REFERENCE = /\/assets\/[^\s"'<>]*/g;

/**
 * What is wrong with the built Terms of Use or Privacy Policy, `page` its
 * constant in `legal-copy.ts` (D217): not its own title, a body never written,
 * a `noindex` that would keep it out of search, or a word of `LEGAL_CLAIMS`
 * anywhere in it, a comment or the head included (D224).
 */
export function legalPageProblems(page, html) {
  const name = page.path.slice(1);
  const file = legalTemplate(page);
  const problems = [];

  if (!html.includes(`<title>${page.title}</title>`)) {
    problems.push(`the ${name} page ${file} has no <title>${page.title}</title>`);
  }

  if (html.includes(LEGAL_PLACEHOLDER) || !/<main>[\s\S]*<h1>[\s\S]*<\/main>/.test(html)) {
    problems.push(`the ${name} page ${file} has no body`);
  }

  if (/noindex/i.test(html)) {
    problems.push(`the ${name} page ${file} asks search engines not to index it`);
  }

  const text = html.replace(ASSET_REFERENCE, '/assets/');

  for (const found of text.matchAll(new RegExp(LEGAL_CLAIMS.source, 'gi'))) {
    const start = Math.max(0, found.index - 30);

    problems.push(
      `the ${name} page ${file} names a law or claims compliance: …${text.slice(start, found.index + found[0].length + 30)}…`,
    );
  }

  return problems;
}

/** Copied from `public/` and served as files, for search engines and link previews (D183). */
export const SEARCH_FILES = [
  'robots.txt',
  'sitemap.xml',
  'favicon.ico',
  'favicon-192.png',
  'logo-512.png',
];

/** The two PNG logo images, each a square of this many pixels. */
export const LOGO_IMAGES = { 'favicon-192.png': 192, 'logo-512.png': 512 };

/** The images `favicon.ico` holds, in pixels. */
export const FAVICON_SIZES = [16, 32, 48];

/**
 * Every address the site offers search engines (D183, D184, D211, D217,
 * D226, D255), in the sitemap's order: a build whose sitemap lacks one is
 * refused, so a page cannot drop out of search unnoticed.
 */
export const SITEMAP_ADDRESSES = [
  '/',
  '/ru/',
  '/docs',
  '/changelog',
  '/about',
  '/ru/about',
  '/terms',
  '/privacy',
].map((path) => `${APP_ORIGIN}${path}`);

/**
 * Paths no sitemap address may lie under: session pages (`/v/`, whose id is
 * the key to a session, D004) and the three `robots.txt` closes to crawlers.
 */
export const UNLISTED_PATHS = ['/v/', '/s/', '/api/', '/ws/'];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const HASHED_ASSET = /^[\w.-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;

/** The `/assets/…` scripts and stylesheets an HTML page names. */
export function pageAssets(html) {
  return [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.(?:js|css))"/g)].map(
    (match) => match[1],
  );
}

/** A chunk's references to other chunks: `./name.js`, or `assets/name.js`. */
export function chunkReferences(code) {
  return [...code.matchAll(/["'`](?:\.\/|\/?assets\/)([\w.-]+\.(?:js|css))["'`]/g)].map(
    (match) => match[1],
  );
}

/** Every script and stylesheet a page loads, directly or through a chunk. */
export function pageGraph(dist, html) {
  const seen = new Set();
  const queue = pageAssets(html);

  while (queue.length > 0) {
    const name = queue.shift();

    if (seen.has(name)) {
      continue;
    }

    seen.add(name);

    if (name.endsWith('.js')) {
      queue.push(...chunkReferences(readFileSync(join(dist, 'assets', name), 'utf8')));
    }
  }

  return seen;
}

/** A PNG's width and height, read from its header; `undefined` for anything else. */
export function pngSize(bytes) {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.toString('latin1', 12, 16) !== 'IHDR'
  ) {
    return undefined;
  }

  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The square sizes an ICO file's directory lists; `undefined` for anything else. */
export function icoSizes(bytes) {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
    return undefined;
  }

  const count = bytes.readUInt16LE(4);

  if (bytes.length < 6 + 16 * count) {
    return undefined;
  }

  const sizes = [];

  for (let index = 0; index < count; index += 1) {
    // 0 stands for 256 in the one byte the format gives each dimension.
    const width = bytes[6 + 16 * index] || 256;
    const height = bytes[7 + 16 * index] || 256;

    if (width !== height) {
      return undefined;
    }

    sizes.push(width);
  }

  return sizes;
}

/**
 * What is wrong with a `sitemap.xml`: no address, one it must not list, or
 * the lack of one of `required`, the addresses it must list; the build check
 * requires `SITEMAP_ADDRESSES`.
 */
export function sitemapProblems(text, required = []) {
  const problems = [];
  const addresses = [...text.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/g)].map((match) => match[1]);

  if (!/<urlset[\s>]/.test(text) || addresses.length === 0) {
    problems.push('sitemap.xml lists no address');
  }

  const listed = new Set(addresses);

  for (const address of required) {
    if (!listed.has(address)) {
      problems.push(`sitemap.xml does not list ${address}`);
    }
  }

  for (const address of addresses) {
    let path;

    try {
      path = new URL(address).pathname;
    } catch {
      problems.push(`sitemap.xml lists ${address}, which is not an absolute URL`);
      continue;
    }

    if (UNLISTED_PATHS.some((prefix) => path.startsWith(prefix))) {
      problems.push(`sitemap.xml lists ${address}, which search engines must not be sent to`);
    }
  }

  return problems;
}

/**
 * What is wrong with a `security.txt` at `now`: RFC 9116's two required
 * fields, `Contact` with the project's address and exactly one `Expires`, an
 * RFC 3339 UTC time later than `now` and less than a year after it, plus the
 * two fields D177 adds.
 */
export function securityTxtProblems(text, now = new Date()) {
  const problems = [];
  const lines = text.split(/\r?\n/);

  for (const field of [
    `Contact: ${CONTACT_MAILTO}`,
    'Preferred-Languages: en, ru',
    `Canonical: ${SECURITY_TXT_URL}`,
  ]) {
    if (!lines.includes(field)) {
      problems.push(`${SECURITY_TXT_FILE} has no line "${field}"`);
    }
  }

  const expires = lines.filter((line) => line.startsWith('Expires:'));

  if (expires.length !== 1) {
    problems.push(`${SECURITY_TXT_FILE} has ${expires.length} Expires fields, not one`);

    return problems;
  }

  const value = expires[0].slice('Expires:'.length).trim();
  const time = Date.parse(value);
  const yearAhead = new Date(now);

  yearAhead.setUTCFullYear(yearAhead.getUTCFullYear() + 1);

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || Number.isNaN(time)) {
    problems.push(`${SECURITY_TXT_FILE} has Expires "${value}", not an RFC 3339 UTC time`);
  } else if (time <= now.getTime()) {
    problems.push(`${SECURITY_TXT_FILE} expired at ${value}`);
  } else if (time >= yearAhead.getTime()) {
    problems.push(`${SECURITY_TXT_FILE} expires at ${value}, a year or more ahead`);
  }

  return problems;
}

/**
 * The names of production the build keeps whatever its origins (D274): the
 * platform's contact address and status page, and the feeds' entry ids, which
 * are permanent.
 */
export const KEPT_PRODUCTION_NAMES = /(?:contact@|status\.|tag:)qa-tools\.ru/gi;

/** The files a build may name an address in: every text file, by its extension. */
const TEXT_FILE = /\.(?:html|txt|xml|md|json|mjs|js|css|svg|webmanifest)$/;

/** Every file under `directory`, by its path relative to it. */
function filesUnder(directory, prefix = '') {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

    return entry.isDirectory() ? filesUnder(directory, path) : [path];
  });
}

/** The hosts a build for `origins` names, a port with each that has one. */
function configuredHosts(origins) {
  return [origins.app, origins.receive, origins.alias ?? null]
    .filter((origin) => origin !== null)
    .map((origin) => new URL(origin).host);
}

/** `text` as a pattern that matches it and nothing else. */
function literally(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The names a build for `origins` may carry that hold `qa-tools.ru`: the
 * names kept, and the configured hosts themselves, the site's second among
 * them (D275), which may end in production's, as `webhook.qa-tools.ru` does
 * (#324). A host counts only as a whole name, read as `nameSite()` reads a
 * production name, so a build whose site is `qa-tools.ru` still shows a
 * `hook.qa-tools.ru` it left unrenamed, and a host followed by a port, a
 * second one among them (#339), is not the configured host. Every part is
 * fixed text, so a scan is linear in the text's length.
 */
function allowedNames(origins) {
  const hosts = configuredHosts(origins).map(
    (host) => `(?<![\\w@.:-])${literally(host)}(?![\\w-]|\\.[\\w-]|:\\d)`,
  );

  return new RegExp([KEPT_PRODUCTION_NAMES.source, ...hosts].join('|'), 'gi');
}

/**
 * What of `text` names production in a build for `origins`: every
 * `qa-tools.ru` outside the names kept and the configured hosts.
 */
export function productionNamesLeft(text, origins = SITE_ORIGINS) {
  // A space for each, so what is left cannot join into a name it did not hold.
  return text.replace(allowedNames(origins), ' ').match(/qa-tools\.ru/gi) ?? [];
}

/**
 * The text files of a build for another origin that still name production,
 * outside the names kept and the configured hosts (issue #320, criterion 2):
 * each would send a reader of the copy to qa-tools.ru.
 */
export function productionNameProblems(dist, origins = SITE_ORIGINS) {
  return filesUnder(dist)
    .filter((path) => TEXT_FILE.test(path))
    .filter(
      (path) => productionNamesLeft(readFileSync(join(dist, path), 'utf8'), origins).length > 0,
    )
    .map((path) => `${path} names qa-tools.ru, though the build is for ${origins.app}`);
}

/**
 * The configured hosts with a port of their own that `text` names with a
 * second port after it (#339), such as `https://qa-tools.ru:8443:8443/about`,
 * an address no browser opens: what a rename writes when it names a
 * configured origin again rather than leaving it as it is. Each host is read
 * as a whole name, as `allowedNames()` reads it. A host with no port is not
 * read: what follows it may be a port of its own. Every part is fixed text,
 * so a scan is linear in the text's length.
 */
export function doubledPorts(text, origins = SITE_ORIGINS) {
  return configuredHosts(origins)
    .filter((host) => /:\d+$/.test(host))
    .filter((host) => new RegExp(`(?<![\\w@.:-])${literally(host)}:\\d`, 'i').test(text));
}

/**
 * The text files of a build that name a configured host with a second port
 * (#339). Production's origins have no port, so its build has none to find.
 */
export function doubledPortProblems(dist, origins = SITE_ORIGINS) {
  if (!configuredHosts(origins).some((host) => /:\d+$/.test(host))) {
    return [];
  }

  return filesUnder(dist)
    .filter((path) => TEXT_FILE.test(path))
    .flatMap((path) =>
      doubledPorts(readFileSync(join(dist, path), 'utf8'), origins).map(
        (host) => `${path} names ${host} with a second port after it`,
      ),
    );
}

/**
 * Adds each of `found` to `problems`, one at a time: spread into a single
 * `push`, a list past about 120,000 overflows the call stack, and a page's
 * comments or a feed's entries can hold that many.
 */
function addEach(problems, found) {
  for (const problem of found) {
    problems.push(problem);
  }
}

/**
 * Everything wrong with the build in `dist`. `now` is the time `security.txt`
 * must not have expired at, and `entries` the changelog the feeds must carry,
 * `CHANGELOG.md`'s unless a test gives its own.
 */
export function checkBuild(
  dist,
  now = new Date(),
  entries = readChangelog(),
  origins = SITE_ORIGINS,
) {
  const problems = [];
  const graphs = {};

  for (const [page, file] of Object.entries(BUILT_PAGES)) {
    const path = join(dist, file);

    if (!existsSync(path)) {
      problems.push(`the ${page} page ${file} was not built`);
      continue;
    }

    const graph = pageGraph(dist, readFileSync(path, 'utf8'));

    if (graph.size === 0) {
      problems.push(`the ${page} page loads no script or stylesheet from /assets/`);
    }

    for (const name of graph) {
      if (!HASHED_ASSET.test(name)) {
        problems.push(`the ${page} page loads ${name}, which has no content hash`);
      }
    }

    graphs[page] = graph;
  }

  for (const file of AGENT_FILES) {
    const path = join(dist, file);

    if (!existsSync(path) || statSync(path).size === 0) {
      problems.push(`the agent documentation ${file} was not built`);
    }
  }

  const changelogText = join(dist, CHANGELOG_TEXT);

  if (!existsSync(changelogText) || statSync(changelogText).size === 0) {
    problems.push(`the changelog text ${CHANGELOG_TEXT} was not built`);
  } else {
    for (const problem of publishedTextProblems(readFileSync(changelogText, 'utf8'))) {
      problems.push(`${CHANGELOG_TEXT} publishes ${problem}`);
    }
  }

  for (const feed of Object.values(FEEDS)) {
    const file = feed.path.slice(1);
    const path = join(dist, file);

    if (!existsSync(path) || statSync(path).size === 0) {
      problems.push(`the changelog feed ${file} was not built`);
    } else {
      addEach(
        problems,
        changelogFeedProblems(
          file,
          readFileSync(path, 'utf8'),
          entries.filter(feed.includes).map((entry) => entry.version),
        ),
      );
    }
  }

  const changelogPage = join(dist, CHANGELOG_PAGE);

  if (existsSync(changelogPage)) {
    const html = readFileSync(changelogPage, 'utf8');

    if (!/<details class="version"/.test(html)) {
      problems.push(`the changelog page ${CHANGELOG_PAGE} lists no version`);
    }

    for (const problem of publishedTextProblems(pageText(html))) {
      problems.push(`${CHANGELOG_PAGE} publishes ${problem}`);
    }
  }

  for (const file of COMMENTED_PAGES) {
    const path = join(dist, file);

    if (existsSync(path)) {
      addEach(problems, pageCommentProblems(file, readFileSync(path, 'utf8')));
    }
  }

  for (const file of Object.keys(HOME_PAGES)) {
    const path = join(dist, file);

    if (existsSync(path)) {
      problems.push(...homePageProblems(file, readFileSync(path, 'utf8')));
    }
  }

  for (const page of ABOUT_PAGES) {
    const path = join(dist, aboutTemplate(page));

    if (existsSync(path)) {
      addEach(problems, aboutPageProblems(readFileSync(path, 'utf8'), page));
    }
  }

  for (const page of LEGAL_PAGES) {
    const path = join(dist, legalTemplate(page));

    if (existsSync(path)) {
      // One at a time: a page of many findings would overflow one push(...list).
      for (const problem of legalPageProblems(page, readFileSync(path, 'utf8'))) {
        problems.push(problem);
      }
    }
  }

  for (const file of SEARCH_FILES) {
    const path = join(dist, file);

    if (!existsSync(path) || statSync(path).size === 0) {
      problems.push(`${file} is not in the build`);
    }
  }

  for (const [file, side] of Object.entries(LOGO_IMAGES)) {
    const path = join(dist, file);
    const size = existsSync(path) ? pngSize(readFileSync(path)) : undefined;

    if (existsSync(path) && (size?.width !== side || size?.height !== side)) {
      problems.push(`${file} is not a ${side} × ${side} PNG`);
    }
  }

  const favicon = join(dist, 'favicon.ico');

  if (existsSync(favicon)) {
    const sizes = icoSizes(readFileSync(favicon));

    if (sizes?.join() !== FAVICON_SIZES.join()) {
      problems.push(`favicon.ico does not hold ${FAVICON_SIZES.join(', ')} px`);
    }
  }

  const sitemap = join(dist, 'sitemap.xml');

  if (existsSync(sitemap)) {
    addEach(problems, sitemapProblems(readFileSync(sitemap, 'utf8'), SITEMAP_ADDRESSES));
  }

  const openapi = join(dist, OPENAPI_FILE);

  if (existsSync(openapi)) {
    problems.push(
      ...relayScriptProblems(
        dist,
        JSON.parse(readFileSync(openapi, 'utf8')).info?.description ?? '',
      ),
    );
  } else {
    problems.push(`${OPENAPI_FILE} is not in the build`);
  }

  if (!isProduction(origins)) {
    problems.push(...productionNameProblems(dist, origins));
  }

  problems.push(...doubledPortProblems(dist, origins));

  const securityTxt = join(dist, SECURITY_TXT_FILE);

  if (existsSync(securityTxt)) {
    problems.push(...securityTxtProblems(readFileSync(securityTxt, 'utf8'), now));
  } else {
    problems.push(`${SECURITY_TXT_FILE} was not built`);
  }

  const contents = (graph) =>
    [...graph].map((name) => [name, readFileSync(join(dist, 'assets', name), 'utf8')]);

  for (const [page, named] of Object.entries(SCALAR_FREE_PAGES)) {
    for (const [name, text] of graphs[page] ? contents(graphs[page]) : []) {
      for (const marker of SCALAR_MARKERS) {
        if (text.includes(marker)) {
          problems.push(`${named} loads ${name}, which carries Scalar ("${marker}")`);
        }
      }
    }
  }

  if (graphs['API reference']) {
    const carriesScalar = contents(graphs['API reference']).some(([, text]) =>
      text.includes(SCALAR_MARKERS[0]),
    );

    if (!carriesScalar) {
      problems.push('the API reference page loads no Scalar, so the check above proves nothing');
    }
  }

  // The Russian home page loads the application's own files, by design.
  for (const [page, named] of [
    ['application', 'the application'],
    ['Russian home', 'the Russian home page'],
  ]) {
    if (graphs[page] && graphs['API reference']) {
      for (const name of graphs[page]) {
        if (graphs['API reference'].has(name)) {
          problems.push(`${named} and the API reference both load ${name}`);
        }
      }
    }
  }

  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'dist');
  const problems = checkBuild(dist);

  if (problems.length > 0) {
    console.error(`The frontend build in ${dist} is not what nginx expects:`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    // An exit code, not an exit at once, which would drop what a pipe has not
    // taken yet (Node writes to one asynchronously on macOS) and cut a long
    // list off.
    process.exitCode = 1;
  } else {
    console.log(
      'frontend build: the application and its Russian home page, the API reference, the changelog, the about page and its Russian twin and the terms and privacy pages are separate; the changelog text and its two Atom feeds, the agent documentation, security.txt, the files for search engines and the relay script with its documented SHA-256 are there',
    );
  }
}
