import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import test from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL, fileURLToPath } from 'node:url';
import { IMPORTED_VERSION, checkVersion, isRuntimePath } from './check-version.mjs';
import {
  ABOUT_TITLE_TAG,
  ATOM_CONTENT_TYPE,
  ATOM_FEED_ROOT,
  CHANGELOG_FEEDS,
  CERTIFICATE_PENDING_CODES,
  CERTIFICATE_WAIT,
  checkDeployment,
  checkedList,
  LEGAL_PAGE_CHECKS,
  main as checkDeploymentMain,
  notCheckedLine,
  ogImage,
  OPERATOR_NOT_GIVEN,
  operatorSettings,
  parseCommandLine,
  pendingCertificateCode,
  readContactEmail,
  readOperatorTexts,
  readStatusPage,
  RECEIVE_ROBOTS_TXT,
  RUSSIAN_ABOUT_MARKS,
  RUSSIAN_ABOUT_PATH,
  russianHomeMarks,
  RUSSIAN_HOME_PATH,
  securityContact,
  securityTxtIsCurrent,
  sitemapLine,
  STATUS_PATHS,
  USAGE,
  waitForCertificate,
} from './check-deployment.mjs';
// No imports of their own, so Node loads them as TypeScript here with nothing installed.
import {
  mailtoOf,
  parseContactEmail,
  parseOperatorTexts,
  parseStatusPageUrl,
} from '../apps/frontend/src/lib/operator.ts';
// The frontend build's own writers of security.txt and of the /status
// locations, which import nothing installed either.
import { securityTxt } from '../apps/frontend/scripts/build-security-txt.mjs';
import { statusLocations } from '../apps/frontend/scripts/nginx-conf.mjs';
import { SESSION_ID_PATTERN } from '../packages/shared/src/index.ts';
import {
  MAX_LIMIT_SECONDS,
  MAX_LINES,
  MAX_NAME,
  limitSeconds,
  printable,
  tracker,
} from './test-run-limit.mjs';

const { Response, AbortSignal, Headers, DOMException } = globalThis;

test('runtime changes require a new version, including a removed runtime file', () => {
  for (const path of [
    'apps/backend/src/removed.ts',
    'packages/shared/src/index.ts',
    'package-lock.json',
    'deploy/helm/qa-tools/values.yaml',
    '.dockerignore',
  ]) {
    assert.throws(
      () => checkVersion({ previous: '0.5.0', current: '0.5.0', paths: [path], changelog: '' }),
      /require a VERSION bump/,
    );
  }
});

test('docs and delivery tooling may keep the product version', () => {
  checkVersion({
    previous: '0.5.0',
    current: '0.5.0',
    paths: ['docs/ARCHITECTURE.md', '.gitlab-ci.yml', 'scripts/check-deployment.mjs'],
    changelog: '',
  });
});

test('a test file under apps/ or packages/ keeps the version, its neighbours do not', () => {
  checkVersion({
    previous: '0.5.0',
    current: '0.5.0',
    paths: [
      'apps/frontend/src/lib/response-config.test.ts',
      'apps/backend/src/session.test.ts',
      'packages/shared/src/index.test.ts',
    ],
    changelog: '',
  });
  for (const path of [
    'apps/frontend/src/lib/response-config.ts',
    'apps/frontend/src/lib/vite.config.ts',
    'apps/frontend/src/lib/fixtures.ts',
    'packages/shared/src/index.ts',
  ]) {
    assert.throws(
      () =>
        checkVersion({
          previous: '0.5.0',
          current: '0.5.0',
          paths: ['apps/frontend/src/lib/response-config.test.ts', path],
          changelog: '',
        }),
      /require a VERSION bump/,
    );
  }
});

test('next patch and next minor require the matching changelog', () => {
  for (const current of ['0.5.3', '0.6.0']) {
    const input = { previous: '0.5.2', current, paths: ['apps/frontend/src/App.tsx'] };
    assert.throws(() => checkVersion({ ...input, changelog: '## 0.5.2\n' }), /needs an entry/);
    checkVersion({ ...input, changelog: `## ${current}\n` });
  }
});

test('reject version reuse, malformed versions and skipped increments', () => {
  for (const current of ['0.4.0', '0.5.1', '0.7.0', '0.6.1', '0.05.3', '0.5.4', '2.0.0']) {
    assert.throws(() =>
      checkVersion({ previous: '0.5.2', current, paths: [], changelog: `## ${current}\n` }),
    );
  }
});

// The 1.0.0 release and every version after it (D233): the next patch, the
// next minor with patch zero, or the next major with minor and patch zero.
const RUNTIME = ['apps/backend/src/index.ts'];
const bump = (previous, current, changelog = `## ${current}\n\n## ${previous}\n`) =>
  checkVersion({ previous, current, paths: RUNTIME, changelog });

test('1.0.0 follows 0.57.5, and a patch, a minor or a major follows 1.0.0', () => {
  for (const [previous, current] of [
    ['0.57.5', '1.0.0'],
    ['1.0.0', '1.0.1'],
    ['1.0.0', '1.1.0'],
    ['1.0.0', '2.0.0'],
    ['1.4.2', '1.4.3'],
    ['1.4.2', '1.5.0'],
    ['1.4.2', '2.0.0'],
    ['0.5.2', '1.0.0'],
    ['9.9.9', '10.0.0'],
    ['1.9.0', '1.10.0'],
  ]) {
    bump(previous, current);
  }
});

test('a version that skips, goes back or keeps a part it should reset is refused', () => {
  for (const [previous, current] of [
    ['0.57.5', '2.0.0'],
    ['0.57.5', '1.0.1'],
    ['0.57.5', '1.1.0'],
    ['0.57.5', '0.57.4'],
    ['1.0.0', '0.58.0'],
    ['1.0.0', '0.57.6'],
    ['1.0.0', '1.0.2'],
    ['1.0.0', '1.2.0'],
    ['1.0.0', '1.1.1'],
    ['1.0.0', '3.0.0'],
    ['1.0.0', '2.0.1'],
    ['1.0.0', '2.1.0'],
    ['1.4.2', '2.4.2'],
    ['1.4.2', '1.5.2'],
    ['1.4.2', '1.4.1'],
    ['2.0.0', '1.9.9'],
  ]) {
    assert.throws(
      () => bump(previous, current),
      (error) =>
        error.message ===
        'Use the next patch, the next minor (patch zero) or the next major (minor and patch zero); never reuse, skip or decrease a version',
      `${previous} → ${current}`,
    );
  }
});

test('a version part with a leading zero is refused, before or after 1.0.0', () => {
  for (const [previous, current] of [
    ['0.57.5', '01.0.0'],
    ['1.0.0', '1.00.0'],
    ['1.0.0', '1.0.01'],
    ['1.0.0', '1.01.0'],
    ['1.0.0', '02.0.0'],
    ['01.0.0', '1.0.1'],
    ['1.0.00', '1.0.1'],
  ]) {
    assert.throws(
      () => bump(previous, current),
      /^Error: Invalid product version: [0-9.]+$/,
      `${previous} → ${current}`,
    );
  }
});

test('since 1.0.0 an unchanged version still refuses a runtime change and keeps docs alone', () => {
  assert.throws(
    () => checkVersion({ previous: '1.0.0', current: '1.0.0', paths: RUNTIME, changelog: '' }),
    /require a VERSION bump/,
  );
  checkVersion({ previous: '1.0.0', current: '1.0.0', paths: ['docs/API.md'], changelog: '' });
});

test('a 1.x version needs its own changelog heading, exactly', () => {
  for (const changelog of [
    '## 0.57.5\n',
    '### 1.0.0\n',
    '## 1.0.0 \n',
    ' ## 1.0.0\n',
    '## v1.0.0\n',
    '## 1.0.00\n',
    'Text ## 1.0.0\n',
    '',
  ]) {
    assert.throws(
      () => bump('0.57.5', '1.0.0', changelog),
      /CHANGELOG\.md needs an entry for 1\.0\.0/,
    );
  }
  bump('0.57.5', '1.0.0', '# Header\n\n## 1.0.0\n\n2026-10-14\n\n## 0.57.5\n');
});

test('no error of the version check speaks of pre-1.0', () => {
  const messages = [];
  for (const input of [
    { previous: '1.0.0', current: 'one', paths: [], changelog: '' },
    { previous: '1.0.0', current: '1.0.2', paths: [], changelog: '## 1.0.2\n' },
    { previous: '1.0.0', current: '1.0.0', paths: RUNTIME, changelog: '' },
    { previous: '1.0.0', current: '1.0.1', paths: [], changelog: '' },
    { previous: null, current: '1.0.0', paths: [], changelog: '## 1.0.0\n' },
  ]) {
    assert.throws(
      () => checkVersion(input),
      (error) => {
        messages.push(error.message);
        return true;
      },
    );
  }
  assert.equal(messages.length, 5);
  for (const message of messages) {
    assert.doesNotMatch(message, /pre-1\.0|0\.x/, message);
  }
  assert.equal(messages[0], 'Invalid product version: one');
});

// Made-up versions built to break the parser: other notations, other digits,
// white space, control characters, signs, too few or too many parts, values
// that are not strings, and each of them at growing sizes.
test('the version parser refuses every other shape, whatever its size', () => {
  const shapes = [
    '',
    '1',
    '1.0',
    '1.0.0.0',
    '1..0',
    '1.0.',
    '.1.0.0',
    'v1.0.0',
    'V1.0.0',
    '1.0.0-rc.1',
    '1.0.0-0',
    '1.0.0+build.5',
    ' 1.0.0',
    '1.0.0 ',
    '1.0.0\n',
    '\n1.0.0',
    '1.0.0\r',
    '1.0.0\u0000',
    '1.0.0 ',
    '1.0.0 ',
    '-1.0.0',
    '+1.0.0',
    '1.-1.0',
    '1.0.-0',
    '0x1.0.0',
    '1e3.0.0',
    '1_000.0.0',
    '1,0,0',
    '1.0.0 1.0.1',
    '١.٠.٠',
    '１.０.０',
    '1.0.0\ud800',
    'NaN.0.0',
    'Infinity.0.0',
  ];
  for (const size of [1, 1_000, 1_000_000]) {
    const grown = [
      ...shapes,
      '1'.repeat(size),
      `${'1.'.repeat(size)}1`,
      `0${'0'.repeat(size)}.0.0`,
      `1.0.${'0'.repeat(size)}1`,
      `1.0.${'a'.repeat(size)}`,
      `${'9'.repeat(size)}.0.0-${'x'.repeat(size)}`,
      `1.0.0${' '.repeat(size)}`,
      `${'١'.repeat(size)}.0.0`,
    ];
    for (const current of grown) {
      for (const [previous, next] of [
        ['1.0.0', current],
        [current, '1.0.1'],
      ]) {
        assert.throws(
          () => checkVersion({ previous, current: next, paths: [], changelog: `## ${next}\n` }),
          (error) => error.message.startsWith('Invalid product version: '),
          `${JSON.stringify(previous).slice(0, 40)} → ${JSON.stringify(next).slice(0, 40)}`,
        );
      }
    }
  }
  for (const value of [undefined, null, 1, 1n, ['1', '0', '0'], { toString: () => '1.0.0' }]) {
    assert.throws(
      () => checkVersion({ previous: '1.0.0', current: value, paths: [], changelog: '## 1.0.1\n' }),
      (error) => error.message.startsWith('Invalid product version: '),
      String(value),
    );
  }
});

// Each part is read as a whole number of any length, never as a float that
// rounds: 2^53 + 1 is not 2^53, and a part of a million digits still counts.
test('version parts of any length are compared exactly', () => {
  bump('9007199254740992.0.0', '9007199254740993.0.0');
  bump('1.9007199254740992.7', '1.9007199254740993.0');
  bump('1.0.9007199254740992', '1.0.9007199254740993');
  assert.throws(() => bump('9007199254740992.0.0', '9007199254740994.0.0'), /never reuse, skip/);
  assert.throws(() => bump('1.0.9007199254740992', '1.0.9007199254740994'), /never reuse, skip/);
  for (const size of [1_000, 1_000_000]) {
    const nines = '9'.repeat(size);
    const power = `1${'0'.repeat(size)}`;
    bump(`1.0.${nines}`, `1.0.${power}`);
    bump(`1.${nines}.4`, `1.${power}.0`);
    bump(`${nines}.3.4`, `${power}.0.0`);
    bump(`1.0.${power}`, `1.0.${power.slice(0, -1)}1`);
    assert.throws(() => bump(`1.0.${nines}`, `1.0.${nines}`), /require a VERSION bump/);
    assert.throws(() => bump(`1.0.${power}`, `1.0.${nines}`), /never reuse, skip/);
    assert.throws(() => bump(`${nines}.0.0`, `${nines}9.0.0`), /never reuse, skip/);
  }
});

// This repository starts at the import of qa-tools at 1.19.5 (#326): the
// base before it, an empty commit, holds no VERSION, and the import adds
// every runtime file.
test('a base without VERSION takes only the import at 1.19.5, with its changelog entry', () => {
  assert.equal(IMPORTED_VERSION, '1.19.5');
  checkVersion({
    previous: null,
    current: '1.19.5',
    paths: ['VERSION', 'CHANGELOG.md', 'apps/backend/src/index.ts', 'package-lock.json'],
    changelog: '## 1.19.5\n',
  });
  for (const current of ['0.5.0', '1.19.2', '1.19.4', '1.19.6', '1.20.0', '2.0.0']) {
    assert.throws(
      () => checkVersion({ previous: null, current, paths: [], changelog: `## ${current}\n` }),
      /takes only the import, at 1\.19\.5/,
      current,
    );
  }
  assert.throws(
    () => checkVersion({ previous: null, current: '1.19.5', paths: [], changelog: '## 1.19.4\n' }),
    /CHANGELOG\.md needs an entry for 1\.19\.5/,
  );
});

// What the smoke expects of production's site, whose sources the templates are (D274).
const RUSSIAN_HOME_MARKS = russianHomeMarks('https://qa-tools.ru');
const SITEMAP_LINE = sitemapLine('https://qa-tools.ru');

// The home page as index.html writes it: the link preview's image in the head.
const HOME =
  '<html><head><meta property="og:image" content="https://qa-tools.ru/logo-512.png" /></head><body>app</body></html>';
const html = (body = HOME) => new Response(body, { headers: { 'content-type': 'text/html' } });
const missing = () =>
  Response.json({ errorCode: 1001, message: 'Session not found' }, { status: 404 });
const reference = () =>
  new Response('<html><body><div id="api-reference"></div></body></html>', {
    headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' },
  });
const description = () =>
  Response.json({ openapi: '3.1.0' }, { headers: { 'cache-control': 'no-cache' } });
// The about page (D211), as nginx answers it: the static page, revalidated.
const ABOUT_HTML =
  '<!doctype html><html lang="en"><head><title>About QA Tools</title></head><body><main><h1>Made by a tester</h1></main></body></html>';
const aboutPage = (headers = {}, status = 200, text = ABOUT_HTML) =>
  new Response(text, {
    status,
    headers: { 'content-type': 'text/html', 'cache-control': 'no-cache', ...headers },
  });
// The about page in Russian (D255), as nginx answers it: a static page like
// /about, revalidated.
const RUSSIAN_ABOUT_HTML =
  '<!doctype html>\n<html lang="ru">\n  <head>\n    <title>О QA Tools</title>\n  </head>\n  <body><main><h1>От тестировщика — тестировщикам</h1></main></body>\n</html>\n';
const russianAboutPage = (headers = {}, status = 200, text = RUSSIAN_ABOUT_HTML) =>
  aboutPage(headers, status, text);
// The Terms of Use and the Privacy Policy (D217), as nginx answers them: static
// pages like /about, revalidated.
const TERMS_HTML =
  '<!doctype html><html lang="en"><head><title>Terms of Use — QA Tools</title></head><body><main><h1>The rules for using QA Tools</h1></main></body></html>';
const PRIVACY_HTML =
  '<!doctype html><html lang="en"><head><title>Privacy Policy — QA Tools</title></head><body><main><h1>What QA Tools keeps</h1></main></body></html>';
const termsPage = (headers = {}, status = 200, text = TERMS_HTML) =>
  aboutPage(headers, status, text);
const privacyPage = (headers = {}, status = 200, text = PRIVACY_HTML) =>
  aboutPage(headers, status, text);
// The Russian home page (D226), as nginx answers it: the application under a
// Russian head, revalidated.
const RUSSIAN_HTML =
  '<!doctype html>\n<html lang="ru">\n  <head>\n    <title>Webhook Inspector — проверка вебхуков</title>\n    <link rel="canonical" href="https://qa-tools.ru/ru/" />\n  </head>\n  <body><div id="root"></div></body>\n</html>\n';
const russianHome = (headers = {}, status = 200, text = RUSSIAN_HTML) =>
  aboutPage(headers, status, text);
// The changelog's two Atom feeds (D212), as nginx answers them: UTF-8 Atom,
// revalidated; the breaking one may hold no entry.
const FEED_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">\n  <entry>\n    <id>tag:qa-tools.ru,2026:changelog/0.51.0</id>\n  </entry>\n</feed>\n';
const BREAKING_FEED_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">\n</feed>\n';
const atomFeed = (headers = {}, status = 200, text = FEED_XML) =>
  new Response(text, {
    status,
    headers: { 'content-type': ATOM_CONTENT_TYPE, 'cache-control': 'no-cache', ...headers },
  });
const breakingFeed = () => atomFeed({}, 200, BREAKING_FEED_XML);
// The smoke's clock in these tests, and a security.txt built the day before.
const NOW = new Date('2026-09-30T12:00:00Z');
const SECURITY_TXT = [
  'Contact: mailto:contact@qa-tools.ru',
  'Expires: 2027-09-28T10:11:12Z',
  'Preferred-Languages: en, ru',
  'Canonical: https://qa-tools.ru/.well-known/security.txt',
  '',
].join('\n');
const security = (text = SECURITY_TXT, type = 'text/plain; charset=utf-8') =>
  new Response(text, { headers: { 'content-type': type, 'cache-control': 'no-cache' } });
// The made-up deployment's operator settings (#369), which the answers here
// name: production's, as its image is built with them, given to the smoke
// as they are (#381).
const OPERATOR = Object.freeze({
  statusPageUrl: 'https://status.qa-tools.ru/',
  contactEmail: 'contact@qa-tools.ru',
  texts: true,
});
const DEPLOYED = Object.freeze({ operator: OPERATOR });
// /status and /status/ in an image with a status page: nginx's 301 to it.
const statusRedirect = (location = OPERATOR.statusPageUrl, status = 301) =>
  new Response('<html><body><center><h1>301 Moved Permanently</h1></center></body></html>', {
    status,
    headers:
      location === null
        ? { 'content-type': 'text/html' }
        : { 'content-type': 'text/html', location },
  });
// The files for search engines and the two addresses around them (D183), as
// nginx and the backend answer them.
const ROBOTS_TXT = [
  'User-agent: *',
  'Disallow: /s/',
  'Disallow: /api/',
  'Disallow: /ws/',
  'Sitemap: https://qa-tools.ru/sitemap.xml',
  '',
].join('\n');
const robots = (text = ROBOTS_TXT, type = 'text/plain') =>
  new Response(text, { headers: { 'content-type': type } });
const SITEMAP_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://qa-tools.ru/</loc></url></urlset>\n';
const sitemap = (text = SITEMAP_XML, type = 'text/xml') =>
  new Response(text, { headers: { 'content-type': type } });
const logo = (type = 'image/png') =>
  new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'content-type': type } });
const sessionPage = (robotsTag = 'noindex', status = 200) =>
  new Response('<html><body>app</body></html>', {
    status,
    headers:
      robotsTag === null
        ? { 'content-type': 'text/html' }
        : { 'content-type': 'text/html', 'x-robots-tag': robotsTag },
  });
// The frontend's 404, the application as the page (D146).
const notFoundPage = () =>
  new Response('<html><body>app</body></html>', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  });
// The site's Page not found as nginx answers an address the image does not
// serve: the frontend's 404, its page the application, the home page's own
// document, revalidated.
const pageNotFound = (headers = {}, status = 404, text = HOME) =>
  new Response(text, {
    status,
    headers: { 'content-type': 'text/html', 'cache-control': 'no-cache', ...headers },
  });
// nginx's own plain 404, for a file the image lacks in a location of its own.
const plainNotFound = () =>
  new Response('<html><head><title>404 Not Found</title></head></html>', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  });
// Every answer up to and including security.txt, as the checks before D183 expect,
// with the about page (D211) and its Russian twin (D255), the Terms of Use and the
// Privacy Policy (D217), the Russian home page (D226) and the two feeds (D212)
// before security.txt.
const upToAbout = () => [
  html(),
  missing(),
  reference(),
  description(),
  aboutPage(),
  russianAboutPage(),
];
const upToLegal = () => [...upToAbout(), termsPage(), privacyPage()];
const upToRussian = () => [...upToLegal(), russianHome()];
const upToSecurity = () => [...upToRussian(), atomFeed(), breakingFeed(), security()];
// The receive host (D187), and the site's old receive URL, which answers 410 / 1009.
const RECEIVE = 'https://hook.qa-tools.ru';
const moved = () =>
  Response.json(
    { errorCode: 1009, message: `Webhooks are received at ${RECEIVE}/s/<session-id>` },
    { status: 410 },
  );
const receiveNotFound = () =>
  Response.json({ errorCode: 1000, message: 'Not found' }, { status: 404 });
const receiveRobots = (text = RECEIVE_ROBOTS_TXT, type = 'text/plain; charset=utf-8') =>
  new Response(text, { headers: { 'content-type': type } });
// The MCP server's answer to a GET (D203): its JSON-RPC 405 with Allow: POST.
const mcpMethodNotAllowed = (allow = 'POST') =>
  Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: 'Method Not Allowed: this endpoint takes POST alone and opens no stream',
      },
    },
    { status: 405, headers: allow === null ? {} : { allow } },
  );
// Every answer after the session page: the site's old receive URL, /sxyz,
// /mcp, /status and /status/, then the receive host's unknown session, its
// root and its robots.txt.
const fromMoved = () => [
  moved(),
  notFoundPage(),
  mcpMethodNotAllowed(),
  statusRedirect(),
  statusRedirect(),
  missing(),
  receiveNotFound(),
  receiveRobots(),
];

test("smoke checks frontend, a read-only random API lookup, the API reference, the about page in English and in Russian, the Terms of Use and the Privacy Policy, the Russian home page, the changelog feeds, security.txt, the files for search engines, a session page, the old receive URL, a path outside /s/, the MCP endpoint, the status page's redirect and the receive host", async () => {
  const seen = [];
  const signals = [];
  const answers = [];
  await checkDeployment(
    'https://qa-tools.ru',
    async (url, options) => {
      seen.push(url);
      assert.equal(options.method, undefined);
      // A redirect is an error, but where the redirect is the answer checked.
      assert.equal(options.redirect, STATUS_PATHS.includes(url.pathname) ? 'manual' : 'error');
      assert.ok(options.signal instanceof AbortSignal);
      signals.push(options.signal);
      const answer = [
        html,
        missing,
        reference,
        description,
        aboutPage,
        russianAboutPage,
        termsPage,
        privacyPage,
        russianHome,
        atomFeed,
        breakingFeed,
        security,
        robots,
        sitemap,
        logo,
        sessionPage,
        moved,
        notFoundPage,
        mcpMethodNotAllowed,
        statusRedirect,
        statusRedirect,
        missing,
        receiveNotFound,
        receiveRobots,
      ][seen.length - 1]();
      answers.push(answer);
      return answer;
    },
    NOW,
    RECEIVE,
    DEPLOYED,
  );
  // Each request has a timeout of its own, and every answer's body was read,
  // so none is left holding a connection.
  assert.equal(new Set(signals).size, seen.length);
  assert.deepEqual(
    answers.map((answer) => answer.bodyUsed),
    answers.map(() => true),
  );
  const paths = seen.map((url) => url.pathname);
  assert.equal(paths[0], '/');
  // A session id's shape, so the backend reads the database for it (D181).
  const [, id] = /^\/api\/sessions\/(.*)$/.exec(paths[1]);
  assert.match(id, SESSION_ID_PATTERN);
  assert.equal(paths[2], '/docs');
  assert.equal(paths[3], '/openapi.json');
  assert.equal(paths[4], '/about');
  // The about page in Russian (D255), on the site, right after the English.
  assert.equal(seen[5].href, 'https://qa-tools.ru/ru/about');
  // The Terms of Use and the Privacy Policy (D217), on the site.
  assert.equal(seen[6].href, 'https://qa-tools.ru/terms');
  assert.equal(seen[7].href, 'https://qa-tools.ru/privacy');
  // The Russian home page (D226), on the site.
  assert.equal(seen[8].href, 'https://qa-tools.ru/ru/');
  // The changelog's two feeds (D212), on the site.
  assert.equal(seen[9].href, 'https://qa-tools.ru/changelog.xml');
  assert.equal(seen[10].href, 'https://qa-tools.ru/changelog-breaking.xml');
  assert.equal(paths[11], '/.well-known/security.txt');
  assert.equal(paths[12], '/robots.txt');
  assert.equal(paths[13], '/sitemap.xml');
  // The image the home page names, fetched at that address.
  assert.equal(seen[14].href, 'https://qa-tools.ru/logo-512.png');
  // A random session page, the site's old receive URL and the receive host's,
  // each with a fresh id of a session id's shape: nginx serves the page by
  // that shape alone, the site answers 410 without looking, and the receive
  // host looks such an id up and stores nothing (D187).
  const [, viewId] = /^\/v\/(.*)$/.exec(paths[15]);
  const [, movedId] = /^\/s\/(.*)$/.exec(paths[16]);
  const [, receiverId] = /^\/s\/(.*)$/.exec(paths[21]);
  assert.match(viewId, SESSION_ID_PATTERN);
  assert.match(movedId, SESSION_ID_PATTERN);
  assert.match(receiverId, SESSION_ID_PATTERN);
  assert.equal(new Set([id, viewId, movedId, receiverId]).size, 4);
  assert.equal(seen[16].origin, 'https://qa-tools.ru');
  assert.equal(paths[17], '/sxyz');
  // The MCP endpoint, on the site (D203).
  assert.equal(seen[18].href, 'https://qa-tools.ru/mcp');
  // The status page's two addresses, on the site (#381).
  assert.equal(seen[19].href, 'https://qa-tools.ru/status');
  assert.equal(seen[20].href, 'https://qa-tools.ru/status/');
  // The receive host by its own origin, never the site's.
  assert.deepEqual(
    seen.slice(21).map((url) => url.origin),
    [RECEIVE, RECEIVE, RECEIVE],
  );
  assert.equal(paths[22], '/');
  assert.equal(paths[23], '/robots.txt');
  assert.equal(seen.length, 24);
});

// A copy on another address (D274): the same answers, naming its own origins.
const OTHER_SITE = 'https://inspector.example';
const OTHER_RECEIVE = 'https://hook.inspector.example';
async function onOtherSite(response) {
  if (!response.headers.get('content-type')?.match(/text|json|xml/)) {
    return response;
  }
  const text = (await response.text())
    .replaceAll('https://hook.qa-tools.ru', OTHER_RECEIVE)
    .replaceAll('https://qa-tools.ru', OTHER_SITE);
  return new Response(text, { status: response.status, headers: response.headers });
}
const EVERY_ANSWER = [
  html,
  missing,
  reference,
  description,
  aboutPage,
  russianAboutPage,
  termsPage,
  privacyPage,
  russianHome,
  atomFeed,
  breakingFeed,
  security,
  robots,
  sitemap,
  logo,
  sessionPage,
  moved,
  notFoundPage,
  mcpMethodNotAllowed,
  statusRedirect,
  statusRedirect,
  missing,
  receiveNotFound,
  receiveRobots,
];

test('smoke checks a copy on another address against that address, never qa-tools.ru (D274)', async () => {
  const seen = [];
  await checkDeployment(
    OTHER_SITE,
    async (url) => {
      seen.push(url);
      return onOtherSite(EVERY_ANSWER[seen.length - 1]());
    },
    NOW,
    OTHER_RECEIVE,
    DEPLOYED,
  );
  assert.equal(seen.length, EVERY_ANSWER.length);
  assert.deepEqual([...new Set(seen.map((url) => url.origin))].sort(), [OTHER_RECEIVE, OTHER_SITE]);
  // A copy whose pages still name production is not what was built.
  for (const [index, problem] of [
    [8, /^Error: \/ru\/ did not return the Russian home page, uncached and indexable$/],
    [
      12,
      /^Error: \/robots\.txt did not return the robots file with "Sitemap: https:\/\/inspector\.example\/sitemap\.xml"$/,
    ],
    [14, /^Error: The home page names no og:image on this site$/],
  ]) {
    const answers = EVERY_ANSWER.map((answer, at) =>
      at === index || (index === 14 && at === 0) ? answer : () => onOtherSite(answer()),
    );
    const responses = answers.slice(0, index === 14 ? 14 : index + 1);
    await assert.rejects(
      checkDeployment(OTHER_SITE, async () => responses.shift()(), NOW, OTHER_RECEIVE, DEPLOYED),
      problem,
    );
  }
});

test('smoke rejects a home page that asks not to be indexed', async () => {
  const marked = new Response(HOME, {
    headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' },
  });
  await assert.rejects(
    checkDeployment('https://qa-tools.ru', async () => marked, NOW, RECEIVE, DEPLOYED),
    /home page carries X-Robots-Tag/,
  );
});

test('smoke rejects a robots.txt that is missing, not plain text or without the Sitemap line', async () => {
  for (const answer of [
    notFoundPage(),
    robots(ROBOTS_TXT, 'text/html'),
    robots(ROBOTS_TXT.replace(/^Sitemap: .*\n/m, '')),
    robots(
      ROBOTS_TXT.replace('https://qa-tools.ru/sitemap.xml', 'https://example.com/sitemap.xml'),
    ),
  ]) {
    const responses = [...upToSecurity(), answer];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /\/robots\.txt/,
    );
  }
});

// The smoke keeps its own copy of the line, as it does of the security contact.
test('the smoke expects the Sitemap line robots.txt publishes', () => {
  const published = readFileSync(
    new URL('../apps/frontend/public/robots.txt', import.meta.url),
    'utf8',
  );
  assert.ok(published.split('\n').includes(SITEMAP_LINE));
});

test('smoke rejects a sitemap the backend answers, the application page or one without a urlset', async () => {
  for (const answer of [
    // What production answered before the Ingress routed by segment (D183).
    Response.json({ errorCode: 1000, message: 'Not found' }, { status: 404 }),
    notFoundPage(),
    sitemap(SITEMAP_XML, 'text/html'),
    sitemap('<?xml version="1.0"?><sitemapindex></sitemapindex>'),
  ]) {
    const responses = [...upToSecurity(), robots(), answer];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /\/sitemap\.xml/,
    );
  }
  // application/xml is XML too.
  const responses = [
    ...upToSecurity(),
    robots(),
    sitemap(SITEMAP_XML, 'application/xml'),
    logo(),
    sessionPage(),
    ...fromMoved(),
  ];
  await checkDeployment(
    'https://qa-tools.ru',
    async () => responses.shift(),
    NOW,
    RECEIVE,
    DEPLOYED,
  );
});

test('smoke rejects a missing og:image, one on another site, and one that is not a PNG', async () => {
  for (const home of [
    '<html><head></head><body>app</body></html>',
    '<html><head><meta property="og:image" content="https://example.com/logo.png" /></head></html>',
  ]) {
    const seen = [];
    const responses = [...upToSecurity(), robots(), sitemap()];
    responses[0] = html(home);
    await assert.rejects(
      checkDeployment(
        'https://qa-tools.ru',
        async (url) => {
          seen.push(url.href);
          return responses.shift();
        },
        NOW,
        RECEIVE,
        DEPLOYED,
      ),
      /no og:image on this site/,
    );
    // An image on another site is never fetched.
    assert.equal(seen.length, 14);
  }
  for (const answer of [notFoundPage(), logo('text/html'), logo('image/svg+xml')]) {
    const responses = [...upToSecurity(), robots(), sitemap(), answer];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /og:image, did not return a PNG/,
    );
  }
});

test('reads the og:image address from the home page', () => {
  assert.equal(ogImage(HOME), 'https://qa-tools.ru/logo-512.png');
  assert.equal(
    ogImage('<meta content="https://qa-tools.ru/a.png" property="og:image">'),
    'https://qa-tools.ru/a.png',
  );
  assert.equal(
    ogImage('<meta property="og:image:alt" content="Webhook Inspector logo" />'),
    undefined,
  );
  assert.equal(ogImage('<html></html>'), undefined);
});

test('smoke rejects a session page without X-Robots-Tag: noindex, or not the page', async () => {
  for (const answer of [
    sessionPage(null),
    sessionPage('noarchive'),
    sessionPage('noindex', 404),
    missing(),
  ]) {
    const responses = [...upToSecurity(), robots(), sitemap(), logo(), answer];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /X-Robots-Tag: noindex/,
    );
  }
});

test('smoke rejects /s/ on the site unless it answers the JSON 410 (1009) (D187)', async () => {
  for (const answer of [
    // /s/ routed to the frontend.
    notFoundPage(),
    Response.json({ errorCode: 1000, message: 'Not found' }, { status: 404 }),
    // The site still receiving, as before 0.36.0.
    missing(),
    Response.json({ errorCode: 1002, message: 'Session expired' }, { status: 410 }),
  ]) {
    const responses = [...upToSecurity(), robots(), sitemap(), logo(), sessionPage(), answer];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /\/s\/ on the site did not answer the JSON 410 \(1009\)/,
    );
  }
});

test('smoke rejects a receive host that does not receive, serves more than /s/, or lets crawlers in (D187)', async () => {
  const before = () => [
    ...upToSecurity(),
    robots(),
    sitemap(),
    logo(),
    sessionPage(),
    moved(),
    notFoundPage(),
    mcpMethodNotAllowed(),
    statusRedirect(),
    statusRedirect(),
  ];
  for (const [answers, message] of [
    // The receive host's unknown session: the site's 410, the frontend's
    // page, a captured request.
    [[moved()], /receive host did not answer an unknown session/],
    [[notFoundPage()], /receive host did not answer an unknown session/],
    [
      [Response.json({ ok: true }, { status: 200 })],
      /receive host did not answer an unknown session/,
    ],
    // Its root: the site's home page, or the receiver's own answer for a session.
    [[missing(), html()], /receive host did not answer \/ with the JSON 404 \(1000\)/],
    [[missing(), missing()], /receive host did not answer \/ with the JSON 404 \(1000\)/],
    // Its robots.txt: the site's, or none.
    [[missing(), receiveNotFound(), robots()], /receive host did not answer \/robots\.txt/],
    [
      [missing(), receiveNotFound(), receiveNotFound()],
      /receive host did not answer \/robots\.txt/,
    ],
    [
      [missing(), receiveNotFound(), receiveRobots(RECEIVE_ROBOTS_TXT, 'text/html')],
      /receive host did not answer \/robots\.txt/,
    ],
  ]) {
    const responses = [...before(), ...answers];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      message,
    );
  }
});

// The smoke keeps its own copy of the receive host's robots.txt, as it does of
// the site's Sitemap line; this keeps it equal to what the backend serves.
test('the smoke expects the robots.txt the receive host serves', () => {
  const server = readFileSync(new URL('../apps/backend/src/server.ts', import.meta.url), 'utf8');
  const served = /^export const RECEIVE_ROBOTS_TXT = '([^']*)';$/m.exec(server)?.[1];
  assert.equal(served?.replaceAll('\\n', '\n'), RECEIVE_ROBOTS_TXT);
  assert.equal(RECEIVE_ROBOTS_TXT, 'User-agent: *\nDisallow: /\n');
});

test('smoke requires the receive host, over HTTPS', async () => {
  await assert.rejects(
    checkDeployment('https://qa-tools.ru', async () => html(), NOW),
    /requires the receive host/,
  );
  await assert.rejects(
    checkDeployment('https://qa-tools.ru', async () => html(), NOW, 'http://hook.qa-tools.ru'),
    /HTTPS/,
  );
});

test('smoke rejects /sxyz answered by the backend, with 200, or marked noindex', async () => {
  for (const answer of [
    // What production answered before the Ingress routed by segment (D183).
    Response.json({ errorCode: 1000, message: 'Not found' }, { status: 404 }),
    html(),
    new Response('<html><body>app</body></html>', {
      status: 404,
      headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' },
    }),
  ]) {
    const responses = [
      ...upToSecurity(),
      robots(),
      sitemap(),
      logo(),
      sessionPage(),
      moved(),
      answer,
    ];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /\/sxyz did not answer the frontend's 404 page/,
    );
  }
});

test('smoke rejects /mcp answered by the frontend, by a backend without the MCP server, or not as its 405 (D203)', async () => {
  for (const answer of [
    // What production answered with 0.45.0: the proxy sent /mcp to the frontend.
    notFoundPage(),
    // A backend from before 0.45.0: the not-found route.
    Response.json({ errorCode: 1000, message: 'Not found' }, { status: 404 }),
    // A 405 without Allow: POST, or not JSON-RPC.
    mcpMethodNotAllowed(null),
    mcpMethodNotAllowed('GET, POST'),
    new Response('Method Not Allowed', {
      status: 405,
      headers: { allow: 'POST', 'content-type': 'text/plain' },
    }),
    Response.json(
      { errorCode: 1000, message: 'Not found' },
      { status: 405, headers: { allow: 'POST' } },
    ),
    html(),
  ]) {
    const responses = [
      ...upToSecurity(),
      robots(),
      sitemap(),
      logo(),
      sessionPage(),
      moved(),
      notFoundPage(),
      answer,
    ];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /\/mcp did not answer the MCP server's JSON-RPC 405/,
    );
  }
});

test('smoke rejects a security.txt that is missing, not plain text, without the contact given, with another beside it, or expired', async () => {
  const expired = SECURITY_TXT.replace(/^Expires: .*$/m, 'Expires: 2026-09-30T11:59:59Z');
  for (const answer of [
    // The application shell for a file the image lacks, or nginx's plain 404.
    new Response('<html><body>app</body></html>', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    }),
    new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
    plainNotFound(),
    security(SECURITY_TXT, 'text/html'),
    security(SECURITY_TXT, 'application/octet-stream'),
    // Another address, none, or the one given and another, in either case.
    security(SECURITY_TXT.replace('contact@qa-tools.ru', 'someone@example.com')),
    security(SECURITY_TXT.replace('contact@qa-tools.ru', 'CONTACT@qa-tools.ru')),
    security(SECURITY_TXT.replace('contact@qa-tools.ru', 'contact@qa-tools.ru.example')),
    security(SECURITY_TXT.replace(/^Contact: .*\n/m, '')),
    security(`Contact: mailto:someone@example.com\n${SECURITY_TXT}`),
    security(`${SECURITY_TXT}contact: mailto:someone@example.com\n`),
    security(SECURITY_TXT.replace('Contact: mailto:', 'Contact: ')),
    security(expired),
  ]) {
    const responses = [...upToRussian(), atomFeed(), breakingFeed(), answer];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /^Error: \/\.well-known\/security\.txt did not return a current security\.txt giving the contact address given$/,
    );
  }
});

test('smoke rejects /about answered by the application, uncached, kept out of search or not the page (D211)', async () => {
  for (const answer of [
    // A frontend from before 0.50.0: the application's Page not found.
    notFoundPage(),
    // nginx's plain 404 for a page the image lacks.
    new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
    aboutPage({ 'content-type': 'text/plain' }),
    aboutPage({ 'cache-control': 'public, max-age=3600' }),
    aboutPage({ 'x-robots-tag': 'noindex' }),
    // The application shell with 200, or a page with another title.
    aboutPage({}, 200, '<html><head><title>Webhook Inspector — QA Tools</title></head></html>'),
  ]) {
    const responses = [html(), missing(), reference(), description(), answer];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /\/about did not return the about page/,
    );
  }
});

test('smoke rejects /ru/about answered by the application, the English page, uncached, kept out of search or not the page (D255)', async () => {
  for (const answer of [
    // A frontend from before this version: the application's Page not found.
    notFoundPage(),
    // nginx's plain 404 for a page the image lacks.
    new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
    russianAboutPage({ 'content-type': 'text/plain' }),
    russianAboutPage({ 'cache-control': 'public, max-age=3600' }),
    russianAboutPage({ 'x-robots-tag': 'noindex' }),
    // The English page, the application shell with 200, or the Russian home page.
    russianAboutPage({}, 200, ABOUT_HTML),
    russianAboutPage(
      {},
      200,
      '<html><head><title>Webhook Inspector — QA Tools</title></head></html>',
    ),
    russianAboutPage({}, 200, RUSSIAN_HTML),
    // The Russian title under an English page's language, or no title at all.
    russianAboutPage({}, 200, RUSSIAN_ABOUT_HTML.replace('<html lang="ru">', '<html lang="en">')),
    russianAboutPage({}, 200, RUSSIAN_ABOUT_HTML.replace(RUSSIAN_ABOUT_MARKS.titleTag, '')),
  ]) {
    const responses = [html(), missing(), reference(), description(), aboutPage(), answer];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /^Error: \/ru\/about did not return the Russian about page, uncached and indexable$/,
    );
  }
});

test('smoke rejects /terms and /privacy answered by the application, uncached, kept out of search or not the page (D217)', async () => {
  const wrong = (page) => [
    // A frontend from before this version: the application's Page not found.
    notFoundPage(),
    // nginx's plain 404 for a page the image lacks.
    new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
    page({ 'content-type': 'text/plain' }),
    page({ 'cache-control': 'public, max-age=3600' }),
    page({ 'x-robots-tag': 'noindex' }),
    // The application shell with 200, or the other page's title.
    page({}, 200, '<html><head><title>Webhook Inspector — QA Tools</title></head></html>'),
    page({}, 200, page === termsPage ? PRIVACY_HTML : TERMS_HTML),
  ];
  for (const answer of wrong(termsPage)) {
    const responses = [...upToAbout(), answer];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /^Error: \/terms did not return the Terms of Use, uncached and indexable$/,
    );
  }
  for (const answer of wrong(privacyPage)) {
    const responses = [...upToAbout(), termsPage(), answer];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /^Error: \/privacy did not return the Privacy Policy, uncached and indexable$/,
    );
  }
});

test('smoke rejects /ru/ answered by the English shell, uncached, kept out of search or not the page (D226)', async () => {
  const shell =
    '<!doctype html>\n<html lang="en">\n<head><title>Webhook Inspector — QA Tools</title><link rel="canonical" href="https://qa-tools.ru/" /></head></html>';
  for (const answer of [
    // A frontend from before this version: the application's Page not found.
    notFoundPage(),
    // nginx's plain 404 for a page the image lacks.
    new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
    // The English shell with 200, which `location /` would have answered.
    russianHome({}, 200, shell),
    russianHome({ 'content-type': 'text/plain' }),
    russianHome({ 'cache-control': 'public, max-age=3600' }),
    russianHome({ 'x-robots-tag': 'noindex' }),
    // Not the page: another language, no title or two, no canonical, two, or the English one.
    russianHome({}, 200, RUSSIAN_HTML.replace('<html lang="ru">', '<html lang="en">')),
    russianHome({}, 200, RUSSIAN_HTML.replace(RUSSIAN_HOME_MARKS.titleTag, '')),
    russianHome(
      {},
      200,
      RUSSIAN_HTML.replace(
        RUSSIAN_HOME_MARKS.titleTag,
        `${RUSSIAN_HOME_MARKS.titleTag}${RUSSIAN_HOME_MARKS.titleTag}`,
      ),
    ),
    russianHome({}, 200, RUSSIAN_HTML.replace(RUSSIAN_HOME_MARKS.canonical, '')),
    russianHome(
      {},
      200,
      RUSSIAN_HTML.replace(
        RUSSIAN_HOME_MARKS.canonical,
        `${RUSSIAN_HOME_MARKS.canonical}<link rel="canonical" href="https://qa-tools.ru/" />`,
      ),
    ),
    russianHome(
      {},
      200,
      RUSSIAN_HTML.replace('href="https://qa-tools.ru/ru/"', 'href="https://qa-tools.ru/"'),
    ),
  ]) {
    const responses = [...upToLegal(), answer];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /^Error: \/ru\/ did not return the Russian home page, uncached and indexable$/,
    );
  }
});

// The smoke keeps its own copy of the page's marks rather than importing the
// frontend's source; this keeps them equal to the page's template (D226).
test('the smoke expects the language, the title and the canonical address the Russian home page carries', () => {
  const template = readFileSync(new URL('../apps/frontend/ru/index.html', import.meta.url), 'utf8');
  assert.equal(RUSSIAN_HOME_PATH, '/ru/');
  assert.deepEqual(RUSSIAN_HOME_MARKS, {
    lang: '<html lang="ru">',
    titleTag: '<title>Webhook Inspector — проверка вебхуков</title>',
    canonical: '<link rel="canonical" href="https://qa-tools.ru/ru/" />',
  });
  for (const mark of Object.values(RUSSIAN_HOME_MARKS)) {
    assert.equal(template.split(mark).length - 1, 1, mark);
  }
  assert.equal(template.split('rel="canonical"').length - 1, 1);
  // The page the smoke reads is the one the sitemap offers.
  const sitemap = readFileSync(
    new URL('../apps/frontend/public/sitemap.xml', import.meta.url),
    'utf8',
  );
  assert.ok(sitemap.includes(`<loc>https://qa-tools.ru${RUSSIAN_HOME_PATH}</loc>`));
});

test('smoke rejects a changelog feed answered by the application, not as UTF-8 Atom, cached, or not a feed (D212)', async () => {
  const wrong = () => [
    // A frontend from before 0.51.0: the application's Page not found.
    notFoundPage(),
    // nginx's plain 404 for a file the image lacks.
    new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
    // Another type, or Atom without its charset.
    atomFeed({ 'content-type': 'text/xml' }),
    atomFeed({ 'content-type': 'application/atom+xml' }),
    atomFeed({ 'content-type': 'text/html' }),
    // Cached.
    atomFeed({ 'cache-control': 'public, max-age=3600' }),
    // The application shell with 200, or an RSS feed.
    atomFeed({}, 200, '<!doctype html><html><head><title>QA Tools</title></head></html>'),
    atomFeed({}, 200, '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>'),
  ];
  for (const answer of wrong()) {
    const responses = [...upToRussian(), answer];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /\/changelog\.xml did not return the changelog's Atom feed/,
    );
  }
  for (const answer of wrong()) {
    const responses = [...upToRussian(), atomFeed(), answer];
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
      /\/changelog-breaking\.xml did not return the changelog's Atom feed/,
    );
  }
  // The feed of every version holds at least one entry; the breaking one may hold none.
  const empty = [...upToRussian(), breakingFeed()];
  await assert.rejects(
    checkDeployment('https://qa-tools.ru', async () => empty.shift(), NOW, RECEIVE, DEPLOYED),
    /\/changelog\.xml did not return the changelog's Atom feed/,
  );
});

// The smoke keeps its own copy of the feeds' addresses and type rather than
// importing the frontend's source; this keeps them equal to what nginx serves.
test('the smoke asks for the feeds nginx serves, as nginx types them', () => {
  const config = readFileSync(new URL('../apps/frontend/nginx.conf', import.meta.url), 'utf8');
  assert.deepEqual(CHANGELOG_FEEDS, ['/changelog.xml', '/changelog-breaking.xml']);
  for (const path of CHANGELOG_FEEDS) {
    const block = new RegExp(
      `location = ${path.replaceAll('.', '\\.')} \\{\\n([^\\n]*\\n)*?\\s*try_files \\$uri =404;`,
    ).exec(config)?.[0];
    assert.ok(block, `nginx.conf has no exact location for ${path}`);
    assert.match(block, /default_type application\/atom\+xml;/);
    assert.match(block, /charset utf-8;/);
    assert.match(block, /charset_types application\/atom\+xml;/);
    assert.match(block, /add_header Cache-Control 'no-cache' always;/);
  }
  assert.equal(ATOM_CONTENT_TYPE, 'application/atom+xml; charset=utf-8');
  assert.equal(ATOM_FEED_ROOT, '<feed xmlns="http://www.w3.org/2005/Atom"');
});

// The smoke keeps its own copy of the title rather than importing the
// frontend's source; this keeps it equal to the page's template (D211).
test('the smoke expects the title the about page carries', () => {
  const template = readFileSync(
    new URL('../apps/frontend/about/index.html', import.meta.url),
    'utf8',
  );
  assert.equal(ABOUT_TITLE_TAG, '<title>About QA Tools</title>');
  assert.ok(template.includes(ABOUT_TITLE_TAG));
});

// The smoke keeps its own copy of the page's marks rather than importing the
// frontend's source; this keeps them equal to the page's template (D255).
test('the smoke expects the language and the title the Russian about page carries', () => {
  const template = readFileSync(
    new URL('../apps/frontend/ru/about/index.html', import.meta.url),
    'utf8',
  );
  assert.equal(RUSSIAN_ABOUT_PATH, '/ru/about');
  assert.deepEqual(RUSSIAN_ABOUT_MARKS, {
    lang: '<html lang="ru">',
    titleTag: '<title>О QA Tools</title>',
  });
  for (const mark of Object.values(RUSSIAN_ABOUT_MARKS)) {
    assert.equal(template.split(mark).length - 1, 1, mark);
  }
  assert.equal(template.match(/<title>/g)?.length, 1);
  // The page the smoke reads is the one the sitemap offers.
  const sitemap = readFileSync(
    new URL('../apps/frontend/public/sitemap.xml', import.meta.url),
    'utf8',
  );
  assert.ok(sitemap.includes(`<loc>https://qa-tools.ru${RUSSIAN_ABOUT_PATH}</loc>`));
});

// The smoke keeps its own copy of the two pages' titles rather than importing
// the frontend's source; this keeps them equal to the pages' templates (D217).
test('the smoke expects the titles the Terms of Use and the Privacy Policy carry', () => {
  assert.deepEqual(
    LEGAL_PAGE_CHECKS.map(({ path }) => path),
    ['/terms', '/privacy'],
  );
  for (const { path, titleTag } of LEGAL_PAGE_CHECKS) {
    const template = readFileSync(
      new URL(`../apps/frontend${path}/index.html`, import.meta.url),
      'utf8',
    );
    assert.ok(template.includes(titleTag), path);
    assert.equal(template.match(/<title>/g)?.length, 1, path);
  }
});

// The smoke expects of security.txt what the image build writes for the
// contact address it was built with, the deployment's CONTACT_EMAIL, which
// the smoke is given (#381): it names no address of its own any more, and
// this holds its line equal to the build's for any address the build takes.
test("the smoke expects the security.txt the build writes for the contact address it is given, and names no operator's details of its own (#381)", () => {
  const built = new Date('2026-09-29T10:11:12Z');

  for (const address of [
    'contact@qa-tools.ru',
    'hello@inspector.example',
    'first.last+tag_1%x-y@sub-1.example.co',
    `${'a'.repeat(64)}@${'b'.repeat(63)}.example`,
  ]) {
    assert.equal(readContactEmail(` ${address} `), parseContactEmail(` ${address} `));
    const file = securityTxt(built, mailtoOf(parseContactEmail(address)));
    assert.equal(file.split('\n')[0], securityContact(address));
    assert.equal(securityTxtIsCurrent(file, address, NOW), true, address);
    assert.equal(securityTxtIsCurrent(file, `x${address}`, NOW), false, address);
  }
  // The smoke's source names none of production's operator's details: the
  // deployment's settings give them (#381, criterion 5).
  const source = readFileSync(new URL('./check-deployment.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /@qa-tools\.ru|status\.qa-tools\.ru/i);
  // With no setting given, it checks none of the three.
  assert.deepEqual(operatorSettings(), OPERATOR_NOT_GIVEN);
  assert.deepEqual(operatorSettings({}), OPERATOR_NOT_GIVEN);
});

test('a current security.txt gives the contact address alone and one Expires within the coming year', () => {
  const current = (text, address = OPERATOR.contactEmail) =>
    securityTxtIsCurrent(text, address, NOW);
  assert.equal(current(SECURITY_TXT), true);
  const withExpires = (value) => SECURITY_TXT.replace(/^Expires: .*$/m, `Expires: ${value}`);
  assert.equal(current(withExpires('2026-09-30T12:00:00Z')), false);
  assert.equal(current(withExpires('2027-09-30T12:00:00Z')), false);
  assert.equal(current(withExpires('2027-09-30T11:59:59Z')), true);
  assert.equal(current(withExpires('soon')), false);
  assert.equal(current(`${SECURITY_TXT}Expires: 2027-01-01T00:00:00Z\n`), false);
  assert.equal(current(SECURITY_TXT.replaceAll('\n', '\r\n')), true);
  // Another address, the address given twice, or another beside it.
  assert.equal(current(SECURITY_TXT, 'someone@example.com'), false);
  assert.equal(current(SECURITY_TXT, 'contact@qa-tools.r'), false);
  assert.equal(current(`${SECURITY_TXT}Contact: mailto:contact@qa-tools.ru\n`), false);
  assert.equal(current(`${SECURITY_TXT}CONTACT: mailto:someone@example.com\n`), false);
  assert.equal(current(SECURITY_TXT.replace(/^Contact: .*\n/m, '')), false);
});

test('smoke rejects a broken frontend, SPA fallback, incorrect API and network failure', async () => {
  for (const responses of [
    [new Response('unavailable', { status: 503 })],
    [new Response('OK', { headers: { 'content-type': 'text/html' } })],
    [html(), html()],
    [html(), Response.json({ errorCode: 1000, message: 'Not found' }, { status: 404 })],
    [html(), Response.json({ errorCode: 1001, message: 'Session not found' }, { status: 500 })],
    // /docs answered by the application shell, uncached reference, or a 404.
    [html(), missing(), html()],
    [
      html(),
      missing(),
      new Response('<html><body><div id="api-reference"></div></body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
    ],
    [html(), missing(), new Response('Not found', { status: 404 })],
    // /openapi.json answered by the application shell, or cached.
    [html(), missing(), reference(), html()],
    [html(), missing(), reference(), Response.json({ openapi: '3.1.0' })],
  ]) {
    await assert.rejects(
      checkDeployment('https://qa-tools.ru', async () => responses.shift(), NOW, RECEIVE, DEPLOYED),
    );
  }
  await assert.rejects(
    checkDeployment(
      'https://qa-tools.ru',
      async () => {
        throw new Error('network unavailable');
      },
      NOW,
      RECEIVE,
      DEPLOYED,
    ),
  );
  await assert.rejects(
    checkDeployment('http://qa-tools.ru', async () => html(), NOW, RECEIVE, DEPLOYED),
    /HTTPS/,
  );
});

// --- The bounds of the script-test jobs' runs (#122, D190, D241) -------------
//
// scripts/test-run-limit.mjs is a reporter for `node --test` that stops the
// whole run at TEST_RUN_LIMIT_SECONDS and names the tests still running.
// Two jobs of .gitlab/ci/validate.yml run their tests with it:
// delivery-checks and operations-tests. Its three parts are tested on
// made-up input, the whole as those jobs run it on test files that hang, and
// each of the two jobs is read for its three bounds.

const RUN_LIMIT = fileURLToPath(new URL('./test-run-limit.mjs', import.meta.url));
// How long a call on made-up input may take: far more than any takes, even
// on a runner starved of processor time (#220).
const QUICK_MS = 10_000;
const quickly = (what, fn) => {
  const started = performance.now();
  const value = fn();
  assert.ok(performance.now() - started < QUICK_MS, `${what} took over ${QUICK_MS} ms`);
  return value;
};
// Nothing a terminal or a log viewer takes for a line break, a control or an
// escape, and no half of a surrogate pair.
const UNPRINTABLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

test('the run’s limit is a whole number of seconds from 1 to a day; any other value stops the run at its start', () => {
  for (const [text, seconds] of [
    ['1', 1],
    ['60', 60],
    ['1200', 1200],
    [String(MAX_LIMIT_SECONDS), MAX_LIMIT_SECONDS],
  ]) {
    assert.equal(limitSeconds({ TEST_RUN_LIMIT_SECONDS: text }), seconds);
  }
  const shapes = [undefined, '', '0', '00', '01', '-1', '+1', '1.5', '1e3', '0x10', '20m', ' 1'];
  shapes.push(
    '1 ',
    '1\n',
    '\n1',
    '1\u0000',
    '١',
    '１',
    'NaN',
    'Infinity',
    String(MAX_LIMIT_SECONDS + 1),
  );
  shapes.push('999999', '1000000');
  for (const size of [1_000, 100_000, 1_000_000]) {
    shapes.push(
      '9'.repeat(size),
      `1${'0'.repeat(size)}`,
      `${' '.repeat(size)}1`,
      `1${'\n'.repeat(size)}`,
    );
  }
  for (const text of shapes) {
    quickly(`${JSON.stringify(text)?.slice(0, 40)}`, () =>
      assert.throws(
        () => limitSeconds({ TEST_RUN_LIMIT_SECONDS: text }),
        (error) =>
          error.message ===
          `test-run-limit: TEST_RUN_LIMIT_SECONDS must be a whole number of seconds from 1 to ${MAX_LIMIT_SECONDS}`,
        JSON.stringify(text)?.slice(0, 40),
      ),
    );
  }
});

test('a test’s name is printed as one printable line of at most its bound, whatever it holds and however long', () => {
  assert.equal(printable('plain name'), 'plain name');
  assert.equal(printable('a\nb'), 'a\\u000ab');
  assert.equal(printable('\u001b[31mred'), '\\u001b[31mred');
  assert.equal(printable('😀 kept'), '😀 kept');
  assert.equal(printable('\ud800 lone'), '\\ud800 lone');
  assert.equal(printable('lone \udc00'), 'lone \\udc00');
  for (const value of [undefined, null, 42, {}, ['a', 'b']])
    assert.equal(typeof printable(value), 'string');
  const pieces = ['x', '\n', '\u0000', '\u001b', '\u2028', '😀', '\ud800', '\udc00', 'é', '<b>'];
  for (const size of [1_000, 10_000, 100_000, 1_000_000]) {
    for (const name of [
      ...pieces.map((piece) => piece.repeat(size)),
      pieces.join('').repeat(size / 10),
      `${'x'.repeat(MAX_NAME - 2)}😀${'y'.repeat(size)}`,
    ]) {
      const shown = quickly(`a name of ${name.length} characters`, () => printable(name));
      assert.doesNotMatch(shown, UNPRINTABLE, JSON.stringify(shown.slice(0, 60)));
      const kept = /^(.*?)(?:… \(\d+ characters in all\))?$/su.exec(shown);
      assert.ok(kept[1].length <= MAX_NAME, `${kept[1].length} characters kept`);
    }
  }
});

// The events as the runner reports them: a file's own entry at nesting 0,
// named by its path; its tests with the file's path, at their nesting.
const CWD = '/checkout';
const fileEvent = (type, name) => ({ type, data: { nesting: 0, name, file: `${CWD}/${name}` } });
const testEvent = (type, file, nesting, name, line) => ({
  type,
  data: { nesting, name, line, column: 1, file: `${CWD}/${file}` },
});

test('the report names each running file and its running tests, nested, or the last of it to end', () => {
  const track = tracker({ cwd: CWD });
  const events = [
    fileEvent('test:dequeue', 'scripts/a.test.mjs'),
    fileEvent('test:dequeue', 'scripts/b.test.mjs'),
    fileEvent('test:dequeue', 'scripts/c.test.mjs'),
    fileEvent('test:dequeue', 'scripts/done.test.mjs'),
    testEvent('test:dequeue', 'scripts/a.test.mjs', 0, 'passes', 3),
    testEvent('test:complete', 'scripts/a.test.mjs', 0, 'passes', 3),
    testEvent('test:dequeue', 'scripts/a.test.mjs', 0, 'hangs', 7),
    testEvent('test:dequeue', 'scripts/a.test.mjs', 1, 'in a subtest\nof two lines', 9),
    testEvent('test:dequeue', 'scripts/b.test.mjs', 0, 'the last to end in b', 4),
    testEvent('test:pass', 'scripts/b.test.mjs', 0, 'the last to end in b', 4),
    testEvent('test:complete', 'scripts/b.test.mjs', 0, 'the last to end in b', 4),
    testEvent('test:dequeue', 'scripts/done.test.mjs', 0, 'quick', 2),
    testEvent('test:complete', 'scripts/done.test.mjs', 0, 'quick', 2),
    fileEvent('test:complete', 'scripts/done.test.mjs'),
  ];
  for (const event of events) track.see(event);
  assert.equal(
    track.report(1200),
    [
      '',
      "test-run-limit: the run's 1200 s are up; it is stopped with these still running:",
      '  scripts/a.test.mjs',
      '    hangs (line 7)',
      '      in a subtest\\u000aof two lines (line 9)',
      '  scripts/b.test.mjs',
      '    no test of it is reported running; the last to end was: the last to end in b',
      '  scripts/c.test.mjs',
      '    no test of it has reported starting: one may be blocked from its start',
      '',
      '',
    ].join('\n'),
  );
  assert.match(tracker({ cwd: CWD }).report(5), /\n {2}no file is reported running\n/);
});

test('the report stays within its lines however many run, and events of any other shape are passed over', () => {
  for (const size of [1_000, 10_000, 100_000]) {
    const track = tracker({ cwd: CWD });
    quickly(`${size} running tests`, () => {
      for (let file = 0; file < 10; file += 1) {
        track.see(fileEvent('test:dequeue', `scripts/f${file}.test.mjs`));
        for (let at = 0; at < size / 10; at += 1) {
          track.see(testEvent('test:dequeue', `scripts/f${file}.test.mjs`, at % 30, `t${at}`, at));
        }
      }
    });
    const report = quickly(`the report of ${size}`, () => track.report(60));
    const lines = report.trim().split('\n');
    assert.ok(lines.length <= MAX_LINES + 1, `${lines.length} lines`);
    assert.match(lines.at(-1), /^ {2}… and \d+ more lines$/);
    for (const line of lines) assert.ok(line.length <= MAX_NAME + 80, `a line of ${line.length}`);
  }
  const track = tracker({ cwd: CWD });
  for (const event of [
    undefined,
    {},
    { type: 'test:dequeue' },
    { type: 'test:dequeue', data: null },
    { type: 'test:dequeue', data: 'scripts/a.test.mjs' },
    { type: 'test:dequeue', data: { nesting: 'x', name: 1n, file: 7 } },
    { type: 'test:complete', data: { nesting: -1, name: { toString: () => 'n' } } },
    { type: 'test:diagnostic', data: { message: 'x'.repeat(1_000_000) } },
  ]) {
    track.see(event);
  }
  assert.match(track.report(1), /\(no file\)/);
});

// A wrapper such as the backup files' `test` calls `node:test` for every
// top-level test of its file, so the runner reports them all at its own line,
// which names none of them (#220). The runner queues each top-level test as
// the file defines it, before the first through the wrapper can block.
test('the report leaves out a line top-level tests of other names share, and keeps every other', () => {
  const track = tracker({ cwd: CWD });
  const [wrapped, first, own, alone, started] = ['wrapped', 'first', 'own', 'alone', 'started'].map(
    (name) => `scripts/${name}.test.mjs`,
  );
  const events = [wrapped, first, own, alone, started].map((file) =>
    fileEvent('test:dequeue', file),
  );
  events.push(
    // Through the wrapper at line 76: the first ends, the second runs a loop
    // of subtests, which share their own line, at nesting 1.
    testEvent('test:enqueue', wrapped, 0, 'one', 76),
    testEvent('test:dequeue', wrapped, 0, 'one', 76),
    testEvent('test:enqueue', wrapped, 0, 'two', 76),
    testEvent('test:enqueue', wrapped, 0, 'three', 76),
    testEvent('test:complete', wrapped, 0, 'one', 76),
    testEvent('test:dequeue', wrapped, 0, 'two', 76),
    testEvent('test:dequeue', wrapped, 1, 'case a', 90),
    testEvent('test:complete', wrapped, 1, 'case a', 90),
    testEvent('test:dequeue', wrapped, 1, 'case b', 90),
    // The wrapper's first test is the one stuck; the next is only queued.
    testEvent('test:enqueue', first, 0, 'stuck first', 76),
    testEvent('test:dequeue', first, 0, 'stuck first', 76),
    testEvent('test:enqueue', first, 0, 'queued', 76),
    // Lines of their own; one name twice at one line, as a loop repeats it;
    // a subtest at its parent's line.
    testEvent('test:dequeue', own, 0, 'its own', 3),
    testEvent('test:enqueue', own, 0, 'repeated', 9),
    testEvent('test:enqueue', own, 0, 'repeated', 9),
    testEvent('test:dequeue', own, 0, 'repeated', 9),
    testEvent('test:dequeue', own, 1, 'nested at the line', 9),
    testEvent('test:dequeue', own, 1, 'nested twice', 12),
    testEvent('test:dequeue', own, 2, 'nested twice', 12),
    // Only the first test seen, at the line another file's wrapper has: the
    // lines seen so far decide, file by file.
    testEvent('test:dequeue', alone, 0, 'the only one seen', 76),
    // Lines seen only as the tests start.
    testEvent('test:dequeue', started, 0, 'ended', 5),
    testEvent('test:complete', started, 0, 'ended', 5),
    testEvent('test:dequeue', started, 0, 'running', 5),
  );
  for (const event of events) track.see(event);
  assert.deepEqual(track.report(10).split('\n').slice(2, -2), [
    `  ${wrapped}`,
    '    two',
    '      case b (line 90)',
    `  ${first}`,
    '    stuck first',
    `  ${own}`,
    '    its own (line 3)',
    '    repeated (line 9)',
    '      nested at the line (line 9)',
    '      nested twice (line 12)',
    '        nested twice (line 12)',
    `  ${alone}`,
    '    the only one seen (line 76)',
    `  ${started}`,
    '    running',
  ]);
  // Many top-level tests, at one line or each at its own: each queued and
  // started costs the same, and the report stays within its lines.
  for (const size of [1_000, 10_000, 100_000]) {
    for (const [shape, lineOf, shown] of [
      ['one line', () => 76, /^ {4}t\d+$/],
      ['a line each', (at) => at + 1, /^ {4}t\d+ \(line \d+\)$/],
    ]) {
      const many = tracker({ cwd: CWD });
      const file = 'scripts/many.test.mjs';
      quickly(`${size} top-level tests at ${shape}`, () => {
        many.see(fileEvent('test:dequeue', file));
        for (let at = 0; at < size; at += 1) {
          many.see(testEvent('test:enqueue', file, 0, `t${at}`, lineOf(at)));
          many.see(testEvent('test:dequeue', file, 0, `t${at}`, lineOf(at)));
        }
      });
      const lines = quickly(`the report of ${size} at ${shape}`, () => many.report(60))
        .trim()
        .split('\n');
      assert.ok(lines.length <= MAX_LINES + 1, `${lines.length} lines`);
      assert.match(lines[2], shown, `${size} at ${shape}`);
    }
  }
});

// The tracker runs in the runner's process, so what an event costs it slows
// the whole run. 100,000 tests are started and then ended in three orders;
// the ends may take 50 times what the starts took, and never less than
// QUICK_MS: about as long as the starts when an end costs the same however
// many run, and nearly a minute in the order they started when an end looks
// through the running tests, as it once did, so the loop gives up once past
// its time.
test('a test’s end costs the tracker the same however many run and in whatever order they end', () => {
  const size = 100_000;
  const kept = new Set([0, 25_000, 50_000, 75_000]);
  const orders = {
    'the order they started': (at) => at,
    'the reverse order': (at) => size - 1 - at,
    // 7919 is a prime that does not divide 100,000: each test once.
    'a scattered order': (at) => (at * 7919) % size,
  };
  const file = 'scripts/many.test.mjs';
  const event = (type, at) => testEvent(type, file, 1 + (at % 3), `t${at}`, at + 1);
  for (const [order, nth] of Object.entries(orders)) {
    const track = tracker({ cwd: CWD });
    track.see(fileEvent('test:dequeue', file));
    const starting = performance.now();
    for (let at = 0; at < size; at += 1) track.see(event('test:dequeue', at));
    const budgetMs = Math.max(QUICK_MS, 50 * (performance.now() - starting));
    const ending = performance.now();
    let ended = 0;
    while (ended < size) {
      if (!kept.has(nth(ended))) track.see(event('test:complete', nth(ended)));
      ended += 1;
      if (ended % 1_000 === 0 && performance.now() - ending > budgetMs) break;
    }
    assert.equal(
      ended,
      size,
      `${ended} of ${size} ends in ${order} took over ${Math.round(budgetMs)} ms`,
    );
    // What is left is reported as before, in the order it started.
    assert.deepEqual(
      track.report(9).split('\n').slice(2, -2),
      [
        `  ${file}`,
        '      t0 (line 1)',
        '        t25000 (line 25001)',
        '          t50000 (line 50001)',
        '      t75000 (line 75001)',
      ],
      order,
    );
  }
  // An end takes the last of that name and nesting to start, as it did.
  const track = tracker({ cwd: CWD });
  const same = 'scripts/same.test.mjs';
  track.see(fileEvent('test:dequeue', same));
  for (const [nesting, line] of [
    [1, 1],
    [2, 2],
    [1, 3],
  ]) {
    track.see(testEvent('test:dequeue', same, nesting, 'same', line));
  }
  track.see(testEvent('test:complete', same, 1, 'same', 3));
  track.see(testEvent('test:complete', same, 1, 'never started', 4));
  assert.deepEqual(track.report(9).split('\n').slice(2, -2), [
    `  ${same}`,
    '      same (line 1)',
    '        same (line 2)',
  ]);
});

// Test files that never end on their own, run as the two jobs run theirs:
// one waiting in a subtest, one blocked in a synchronous call after a
// moment, one blocked from its first line, one blocked in the first test of
// a wrapper like the backup files' `test`, and one that passes. The blocked
// ones block for a minute at most. They do not outlive the runner, which
// ends their processes as it stops: measured for #220 with a 10 s limit, on
// macOS and in node:24-slim, each was gone by the time the runner had
// exited, 10.05 to 10.19 s after its start. runTests still waits 2 s for any
// left, then ends them, and says so.
const HANGING = {
  'waits.test.mjs': `import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
test('passes first', () => {});
test('waits forever', async (t) => {
  await t.test('in a subtest', async () => { await sleep(600_000); });
});
`,
  'blocked.test.mjs': `import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
test('passes first', () => {});
test('blocked after a moment', async () => {
  await sleep(300);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
});
`,
  'blocked-at-once.test.mjs': `import test from 'node:test';
test('blocked from its start', () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
});
`,
  'wrapped.test.mjs': `import nodeTest from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
const test = (name, fn) => nodeTest(name, async (t) => { await turn(); return fn(t); });
test('blocked through a wrapper', () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
});
test('queued behind it', () => {});
`,
  'passes.test.mjs': `import test from 'node:test';
test('passes', () => {});
`,
};

// `node --test` with the job's flags in a directory of `files`; resolves with
// the exit code, both outputs, how long it took and whether any process of
// the run was left 2 s after the runner's end. Killed if it outlives
// `patienceMs`, a wait many times what the run should take. All the files run
// at once, as they cannot on a runner of two processors, where the runner's
// default is one file at a time and the first to hang would hold the others.
// The runner leads a process group of its own, which the processes it starts
// for the files join, so that what is left of the run is found and ended by
// the group.
function runTests(t, files, limit, patienceMs = 120_000) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-test-run-limit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [
      '--test',
      '--test-timeout=300000',
      `--test-concurrency=${Object.keys(files).length}`,
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      `--test-reporter=${RUN_LIMIT}`,
      '--test-reporter-destination=stderr',
      ...Object.keys(files),
    ],
    {
      cwd: dir,
      env: { PATH: process.env.PATH, TEST_RUN_LIMIT_SECONDS: limit },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  const group = child.pid;
  let ended = false;
  const anyLeft = () => {
    try {
      process.kill(-group, 0);
      return true;
    } catch {
      return false;
    }
  };
  const endAll = () => {
    if (ended) return;
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      // All of them have ended.
    }
  };
  t.after(endAll);
  const killer = setTimeout(endAll, patienceMs);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise((resolve) =>
    child.on('close', async (code, signal) => {
      clearTimeout(killer);
      const ms = Date.now() - started;
      for (const waited = Date.now(); anyLeft() && Date.now() - waited < 2_000;) await sleep(50);
      const left = anyLeft();
      endAll();
      ended = true;
      resolve({ code, signal, stdout, stderr, ms, left });
    }),
  );
}

test('as the script-test jobs run it, the limit stops a run that hangs, names what was running and exits 1', async (t) => {
  const { code, signal, stdout, stderr, ms, left } = await runTests(t, HANGING, '10');
  const both = `${stdout}\n${stderr}`;
  assert.equal(code, 1, both);
  assert.equal(signal, null, both);
  // 10 s and the runner's stop; a minute would be a run left to its own hangs.
  assert.ok(ms < 60_000, `the run took ${ms} ms`);
  assert.equal(left, false, 'processes of the run were left 2 s after the runner ended');
  assert.ok(
    stderr.startsWith(
      'test-run-limit: this run is stopped after 10 s, naming the tests still running\n',
    ),
    stderr,
  );
  const report = stderr.slice(stderr.indexOf("test-run-limit: the run's"));
  assert.match(
    report,
    /^test-run-limit: the run's 10 s are up; it is stopped with these still running:\n/,
  );
  const block = (file) => {
    const at = report.indexOf(`\n  ${file}\n`);
    assert.ok(at >= 0, `${file} is not named\n${report}`);
    const rest = report.slice(at + file.length + 4);
    return rest.slice(0, rest.search(/\n {2}\S|\n\n|$/));
  };
  assert.equal(block('waits.test.mjs'), '    waits forever (line 4)\n      in a subtest (line 5)');
  assert.equal(block('blocked.test.mjs'), '    blocked after a moment (line 4)');
  assert.equal(
    block('blocked-at-once.test.mjs'),
    '    no test of it has reported starting: one may be blocked from its start',
  );
  // Without the wrapper's line, which the test queued behind it shares.
  assert.equal(block('wrapped.test.mjs'), '    blocked through a wrapper');
  assert.doesNotMatch(report, /passes\.test\.mjs/);
  // The runner's own word that it was stopped, with the files.
  assert.match(stdout, /Interrupted while running:/);
});

test('a run within its limit is not touched, and a malformed limit stops one at its start', async (t) => {
  const within = await runTests(t, { 'passes.test.mjs': HANGING['passes.test.mjs'] }, '60');
  assert.equal(within.code, 0, `${within.stdout}\n${within.stderr}`);
  assert.equal(
    within.stderr,
    'test-run-limit: this run is stopped after 60 s, naming the tests still running\n',
  );
  assert.match(within.stdout, /ℹ pass 1\n/);
  for (const limit of ['', '20m', '0']) {
    const refused = await runTests(t, { 'passes.test.mjs': HANGING['passes.test.mjs'] }, limit);
    assert.notEqual(refused.code, 0, `${JSON.stringify(limit)}: ${refused.stdout}`);
    assert.match(refused.stderr, /TEST_RUN_LIMIT_SECONDS must be a whole number of seconds/);
  }
});

// delivery-checks and the group split from it (D241) each run script tests,
// and each keeps the three bounds.
test('every job running the script tests gives every test, the whole run and the job a bound, each above the one inside it', () => {
  const ci = readFileSync(new URL('../.gitlab/ci/validate.yml', import.meta.url), 'utf8');
  const blockOf = (name) => {
    const from = ci.indexOf(`\n${name}:\n`);
    assert.ok(from >= 0, `no ${name} job`);
    const next = ci.slice(from + 1).search(/\n[^\s#]/);
    return next < 0 ? ci.slice(from) : ci.slice(from, from + 1 + next);
  };
  const limits = new Map();
  for (const name of ['delivery-checks', 'operations-tests']) {
    const job = blockOf(name);
    const jobMinutes = Number(/^ {2}timeout: (\d+)m$/m.exec(job)?.[1]);
    const runSeconds = Number(/^ {6}TEST_RUN_LIMIT_SECONDS=(\d+) node --test /m.exec(job)?.[1]);
    const testMs = Number(/ --test-timeout=(\d+) /.exec(job)?.[1]);
    assert.ok(jobMinutes > 0 && runSeconds > 0 && testMs > 0, `${name}: a bound is missing`);
    for (const flag of [
      '--test-reporter=spec --test-reporter-destination=stdout',
      '--test-reporter=./scripts/test-run-limit.mjs --test-reporter-destination=stderr',
    ]) {
      assert.ok(job.includes(flag), `${name}: the run has no ${flag}`);
    }
    assert.doesNotMatch(job, /--test-force-exit/, 'F-02: it drops results with exit 0');
    // The run's limit leaves a test its whole limit; the job's, the run's limit,
    // its 30 s to SIGKILL, and 5 minutes for the image, the installs and the
    // version checks, which took about a minute.
    assert.ok(
      runSeconds * 1000 >= 2 * testMs,
      `${name}: ${runSeconds} s for the run, ${testMs} ms a test`,
    );
    assert.ok(
      jobMinutes * 60 >= runSeconds + 30 + 5 * 60,
      `${name}: ${jobMinutes} min for the job`,
    );
    for (const file of job.match(/scripts\/[\w-]+\.test\.mjs/g) ?? []) limits.set(file, testMs);
  }
  // The two backup files give their tests the same limit as their job's flag.
  for (const file of ['db-backup.test.mjs', 'db-backup-offsite.test.mjs']) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const own = /^const TEST_LIMIT_MS = ([\d_]+);$/m.exec(text)?.[1];
    assert.ok(limits.has(`scripts/${file}`), `no job runs ${file}`);
    assert.equal(
      Number(own?.replace(/_/g, '')),
      limits.get(`scripts/${file}`),
      `${file}'s TEST_LIMIT_MS`,
    );
  }
});

// The site's second host (#319, D275): the same release behind a proxy that
// sets X-Robots-Tag: noindex on every answer of that host, its pages naming
// the first host as theirs.
const ALIAS_SITE = 'https://webhook.qa-tools.ru';
/** `response` as the proxy gives it on the second host: the same, with X-Robots-Tag: noindex set. */
function onAliasSite(response) {
  const headers = new Headers(response.headers);
  headers.set('x-robots-tag', 'noindex');
  return new Response(response.body, { status: response.status, headers });
}
/** A fetcher answering EVERY_ANSWER in turn, the second host's with noindex, recording each URL. */
function aliasFetcher(seen, mark = (url, response) => onAliasSite(response)) {
  return async (url) => {
    seen.push(url);
    const answer = EVERY_ANSWER[seen.length - 1]();
    return url.origin === ALIAS_SITE ? mark(url, answer) : answer;
  };
}
// The made-up deployment's settings as the command line gives them (#381).
const OPERATOR_OPTIONS = [
  `--status-page=${OPERATOR.statusPageUrl}`,
  `--contact-email=${OPERATOR.contactEmail}`,
  '--operator-texts=true',
];
const ALIAS_CHECK = { canonical: 'https://qa-tools.ru', closedToSearch: true, operator: OPERATOR };

test("smoke checks the site's second host as a copy of the first closed to search: every answer of its own noindex, its pages naming the first host (#319, D275)", async () => {
  const seen = [];
  await checkDeployment(ALIAS_SITE, aliasFetcher(seen), NOW, RECEIVE, ALIAS_CHECK);
  assert.equal(seen.length, EVERY_ANSWER.length);
  // The second host itself, never the first: the image the pages name on the
  // first host is fetched at the same path here.
  assert.deepEqual([...new Set(seen.map((url) => url.origin))].sort(), [RECEIVE, ALIAS_SITE]);
  assert.equal(seen[14].href, `${ALIAS_SITE}/logo-512.png`);
  assert.equal(seen[18].href, `${ALIAS_SITE}/mcp`);

  assert.equal(seen[19].href, `${ALIAS_SITE}/status`);

  // Every answer of the second host is checked for the header, the API's,
  // the MCP server's, the image's and the status page's redirect included;
  // the receive host's are not. The session page, 15, carries it from nginx
  // itself, on either host.
  for (let index = 0; index < 21; index += 1) {
    if (index === 15) {
      continue;
    }
    const responses = [];
    await assert.rejects(
      checkDeployment(
        ALIAS_SITE,
        aliasFetcher(responses, (url, response) =>
          responses.length - 1 === index ? response : onAliasSite(response),
        ),
        NOW,
        RECEIVE,
        ALIAS_CHECK,
      ),
      new RegExp(`^Error: /.* on webhook\\.qa-tools\\.ru did not carry X-Robots-Tag: noindex$`),
      `answer ${index}`,
    );
    assert.equal(responses.length, index + 1, `answer ${index}`);
  }
  // Another value is not noindex either.
  await assert.rejects(
    checkDeployment(
      ALIAS_SITE,
      aliasFetcher([], (url, response) => {
        const headers = new Headers(response.headers);
        headers.set('x-robots-tag', 'noindex, nofollow');
        return new Response(response.body, { status: response.status, headers });
      }),
      NOW,
      RECEIVE,
      ALIAS_CHECK,
    ),
    /^Error: \/ on webhook\.qa-tools\.ru did not carry X-Robots-Tag: noindex$/,
  );
});

test("smoke still refuses noindex on the first host's pages, and pages on the second that name it as theirs (#319, D275)", async () => {
  // The first host closed to search would be a fault, not the second host's
  // header leaking there: checked as before, its home page refuses it.
  await assert.rejects(
    checkDeployment('https://qa-tools.ru', async () => onAliasSite(html()), NOW, RECEIVE, DEPLOYED),
    /^Error: The home page carries X-Robots-Tag$/,
  );
  // On the second host the pages name the first; naming the second instead
  // is not the release the first host serves.
  const renamed = async (response) => {
    if (!response.headers.get('content-type')?.match(/text|json|xml/)) return response;
    const text = (await response.text()).replaceAll('https://qa-tools.ru', ALIAS_SITE);
    return new Response(text, { status: response.status, headers: response.headers });
  };
  for (const [path, problem] of [
    ['/ru/', /^Error: \/ru\/ did not return the Russian home page, uncached and indexable$/],
    [
      '/robots.txt',
      /^Error: \/robots\.txt did not return the robots file with "Sitemap: https:\/\/qa-tools\.ru\/sitemap\.xml"$/,
    ],
  ]) {
    await assert.rejects(
      checkDeployment(
        ALIAS_SITE,
        aliasFetcher([], async (url, response) =>
          onAliasSite(url.pathname === path ? await renamed(response) : response),
        ),
        NOW,
        RECEIVE,
        ALIAS_CHECK,
      ),
      problem,
    );
  }
});

/** A fetch failure as Node gives it for a certificate: `fetch failed`, the TLS error as its cause. */
function tlsFailure(code) {
  const cause = Object.assign(new Error(`certificate: ${code}`), { code });
  return new TypeError('fetch failed', { cause });
}

test("smoke waits for the second host's certificate: a pending certificate is tried again 10 s apart, at most 30 times, and anything else ends the wait at once (#319, D275)", async () => {
  assert.deepEqual(CERTIFICATE_WAIT, { tries: 30, intervalMs: 10_000 });

  // The proxy's own certificate twice, then the host's: the wait ends at the
  // first answer, whatever its status, read in full.
  for (const code of CERTIFICATE_PENDING_CODES) {
    const slept = [];
    const logged = [];
    const asked = [];
    let answer;
    const tries = await waitForCertificate(
      ALIAS_SITE,
      async (url, options) => {
        asked.push(url.href);
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        if (asked.length < 3) throw tlsFailure(code);
        answer = new Response('down', { status: 503 });
        return answer;
      },
      CERTIFICATE_WAIT,
      async (ms) => slept.push(ms),
      (line) => logged.push(line),
    );
    assert.equal(tries, 3, code);
    assert.deepEqual(slept, [10_000, 10_000]);
    assert.deepEqual(asked, [`${ALIAS_SITE}/`, `${ALIAS_SITE}/`, `${ALIAS_SITE}/`]);
    assert.equal(answer.bodyUsed, true);
    assert.deepEqual(logged, [
      `webhook.qa-tools.ru has no valid certificate yet (${code}); trying again in 10 s`,
      `webhook.qa-tools.ru has no valid certificate yet (${code}); trying again in 10 s`,
    ]);
  }

  // A certificate there at once costs no wait.
  const none = [];
  assert.equal(
    await waitForCertificate(
      ALIAS_SITE,
      async () => html(),
      CERTIFICATE_WAIT,
      async (ms) => none.push(ms),
      () => {},
    ),
    1,
  );
  assert.deepEqual(none, []);

  // Any other failure is thrown at once, unwaited: a refused connection, a
  // timeout, an expired certificate, an error with no cause.
  for (const error of [
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    }),
    new DOMException('timed out', 'TimeoutError'),
    tlsFailure('CERT_HAS_EXPIRED'),
    new Error('plain'),
  ]) {
    const slept = [];
    await assert.rejects(
      waitForCertificate(
        ALIAS_SITE,
        async () => {
          throw error;
        },
        CERTIFICATE_WAIT,
        async (ms) => slept.push(ms),
        () => {},
      ),
      (thrown) => thrown === error,
    );
    assert.deepEqual(slept, []);
  }

  // The tries spent: 30 asks, 29 waits, and the last error named.
  const slept = [];
  let asked = 0;
  await assert.rejects(
    waitForCertificate(
      ALIAS_SITE,
      async () => {
        asked += 1;
        throw tlsFailure('DEPTH_ZERO_SELF_SIGNED_CERT');
      },
      CERTIFICATE_WAIT,
      async (ms) => slept.push(ms),
      () => {},
    ),
    /^Error: webhook\.qa-tools\.ru still has no valid certificate after 30 tries 10 s apart \(DEPTH_ZERO_SELF_SIGNED_CERT\)$/,
  );
  assert.equal(asked, 30);
  assert.equal(slept.length, 29);
  assert.equal(
    slept.reduce((sum, ms) => sum + ms, 0),
    290_000,
  );
});

test('the certificate code is read a few causes deep, and a cause of any shape, a cycle or a long chain, ends the walk (D275)', () => {
  assert.equal(
    pendingCertificateCode(tlsFailure('ERR_TLS_CERT_ALTNAME_INVALID')),
    'ERR_TLS_CERT_ALTNAME_INVALID',
  );
  assert.equal(
    pendingCertificateCode({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    'DEPTH_ZERO_SELF_SIGNED_CERT',
  );
  for (const shape of [
    undefined,
    null,
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    42,
    {},
    { code: 42 },
    { cause: 'x' },
    tlsFailure('ECONNRESET'),
    { code: 'depth_zero_self_signed_cert' },
  ]) {
    assert.equal(pendingCertificateCode(shape), undefined, String(shape?.code ?? shape));
  }
  // A cycle, and causes deeper than the walk goes.
  const cyclic = new Error('a');
  cyclic.cause = cyclic;
  assert.equal(pendingCertificateCode(cyclic), undefined);
  for (const depth of [10, 1000, 100_000]) {
    let chain = { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' };
    for (let index = 0; index < depth; index += 1) chain = { cause: chain };
    const started = performance.now();
    assert.equal(pendingCertificateCode(chain), undefined);
    assert.ok(performance.now() - started < 100, `depth ${depth}`);
  }
  let shallow = { code: 'SELF_SIGNED_CERT_IN_CHAIN' };
  for (let index = 0; index < 4; index += 1) shallow = { cause: shallow };
  assert.equal(pendingCertificateCode(shallow), 'SELF_SIGNED_CERT_IN_CHAIN');
});

test("the smoke's command line checks the first host, then waits for the second's certificate and checks it closed to search; with no second host it checks the first alone (#319, D275)", async () => {
  // No second host: the first and the receive host, as before.
  const first = [];
  const logged = [];
  await checkDeploymentMain(
    ['https://qa-tools.ru', RECEIVE, '', ...OPERATOR_OPTIONS],
    async (url) => {
      first.push(url);
      return EVERY_ANSWER[first.length - 1]();
    },
    NOW,
    async () => assert.fail('no wait'),
    (line) => logged.push(line),
  );
  assert.equal(first.length, EVERY_ANSWER.length);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^Deployed frontend, .* passed on qa-tools\.ru \(read-only\)$/);

  // With one: the first host in full, then the second's certificate, pending
  // once, then the second host in full.
  const seen = [];
  const slept = [];
  const lines = [];
  let pending = 1;
  let index = 0;
  await checkDeploymentMain(
    ['https://qa-tools.ru', RECEIVE, ALIAS_SITE, ...OPERATOR_OPTIONS],
    async (url) => {
      seen.push(url);
      if (url.origin === ALIAS_SITE && pending > 0) {
        pending -= 1;
        throw tlsFailure('DEPTH_ZERO_SELF_SIGNED_CERT');
      }
      if (seen.length === EVERY_ANSWER.length + 2) {
        // The wait's own answer, after the pending one.
        return onAliasSite(html());
      }
      const answer = EVERY_ANSWER[index % EVERY_ANSWER.length]();
      index += 1;
      return url.origin === ALIAS_SITE ? onAliasSite(answer) : answer;
    },
    NOW,
    async (ms) => slept.push(ms),
    (line) => lines.push(line),
  );
  assert.equal(seen.length, 2 * EVERY_ANSWER.length + 2);
  assert.ok(seen.slice(0, EVERY_ANSWER.length).every((url) => url.origin !== ALIAS_SITE));
  assert.deepEqual(
    seen.slice(EVERY_ANSWER.length, EVERY_ANSWER.length + 2).map((url) => url.href),
    [`${ALIAS_SITE}/`, `${ALIAS_SITE}/`],
  );
  assert.deepEqual(slept, [10_000]);
  assert.equal(lines.length, 3);
  assert.match(
    lines[2],
    /^Deployed frontend, .* passed on webhook\.qa-tools\.ru, every answer of its own with X-Robots-Tag: noindex \(read-only\)$/,
  );

  // A second host given as anything but https:// is refused before any ask of it.
  for (const alias of ['http://webhook.qa-tools.ru', 'https://user:secret@webhook.qa-tools.ru']) {
    const asked = [];
    await assert.rejects(
      checkDeploymentMain(
        ['https://qa-tools.ru', RECEIVE, alias, ...OPERATOR_OPTIONS],
        async (url) => {
          asked.push(url);
          return EVERY_ANSWER[asked.length - 1]();
        },
        NOW,
        async () => {},
        () => {},
      ),
      (error) => !error.message.includes('secret'),
    );
    assert.equal(asked.length, EVERY_ANSWER.length);
  }
  await assert.rejects(checkDeploymentMain(['https://qa-tools.ru']), /^Error: Usage: /);
});

// --- The operator's details the smoke checks (#381) --------------------------
//
// The deployment's image was built with a status page, a contact address and
// the operator's texts, or without each (#369); the smoke is given them as
// options, checks each as it says, and asks for nothing of one not given.

/** A copy's own operator: every detail set, none of them production's. */
const COPY_OPERATOR = Object.freeze({
  statusPageUrl: 'https://status.inspector.example/',
  contactEmail: 'hello@inspector.example',
  texts: true,
});
/** A copy built with none of the three. */
const NO_OPERATOR = Object.freeze({ statusPageUrl: null, contactEmail: null, texts: false });
/** A copy with a contact address and nothing else. */
const CONTACT_ONLY = Object.freeze({
  statusPageUrl: null,
  contactEmail: 'hello@inspector.example',
  texts: false,
});
/** The addresses that answer as the operator's details say, the status page's two among them. */
const OPERATOR_PATHS = ['/terms', '/privacy', '/.well-known/security.txt', ...STATUS_PATHS];

/**
 * A deployment whose image was built with `built`'s details, answering each
 * address as nginx and the backend do, and `answers[path]()` where one is
 * given; what was asked, the URL and the redirect mode, is pushed to `seen`.
 */
function deployment(built, seen = [], answers = {}) {
  const site = {
    '/': html,
    '/docs': reference,
    '/openapi.json': description,
    '/about': aboutPage,
    '/ru/about': russianAboutPage,
    '/terms': () => (built.texts ? termsPage() : pageNotFound()),
    '/privacy': () => (built.texts ? privacyPage() : pageNotFound()),
    '/ru/': russianHome,
    '/changelog.xml': atomFeed,
    '/changelog-breaking.xml': breakingFeed,
    '/.well-known/security.txt': () =>
      built.contactEmail
        ? security(SECURITY_TXT.replace('contact@qa-tools.ru', built.contactEmail))
        : plainNotFound(),
    '/robots.txt': robots,
    '/sitemap.xml': sitemap,
    '/logo-512.png': logo,
    '/sxyz': notFoundPage,
    '/mcp': mcpMethodNotAllowed,
    '/status': () => (built.statusPageUrl ? statusRedirect(built.statusPageUrl) : pageNotFound()),
    '/status/': () => (built.statusPageUrl ? statusRedirect(built.statusPageUrl) : pageNotFound()),
  };

  return async (url, options) => {
    seen.push({ path: url.pathname, origin: url.origin, redirect: options.redirect });
    if (url.origin === RECEIVE) {
      return url.pathname === '/'
        ? receiveNotFound()
        : url.pathname === '/robots.txt'
          ? receiveRobots()
          : missing();
    }
    if (Object.hasOwn(answers, url.pathname)) return answers[url.pathname]();
    if (Object.hasOwn(site, url.pathname)) return site[url.pathname]();
    if (url.pathname.startsWith('/api/sessions/')) return missing();
    if (url.pathname.startsWith('/v/')) return sessionPage();
    if (url.pathname.startsWith('/s/')) return moved();
    return assert.fail(`the smoke asked for ${url.pathname}`);
  };
}

/** The smoke on the site of a deployment built with `built`, given `operator`. */
const smokeOf = (built, operator = built, seen = [], answers = {}) =>
  checkDeployment('https://qa-tools.ru', deployment(built, seen, answers), NOW, RECEIVE, {
    operator,
  });

test("smoke checks the operator's details as the deployment's settings give them: each a value or none, and asked for only when given (#381)", async () => {
  for (const built of [OPERATOR, COPY_OPERATOR, NO_OPERATOR, CONTACT_ONLY]) {
    const seen = [];
    await smokeOf(built, built, seen);
    const asked = seen.map(({ path }) => path);
    for (const path of OPERATOR_PATHS) {
      assert.equal(asked.filter((each) => each === path).length, 1, path);
    }
    // The status page's two addresses are asked without following a
    // redirect, which is their answer; everything else refuses one.
    for (const { path, redirect } of seen) {
      assert.equal(redirect, STATUS_PATHS.includes(path) ? 'manual' : 'error', path);
    }
  }
  // Not given, not asked for: whatever the image was built with, and
  // whatever those addresses would answer.
  const never = Object.fromEntries(
    OPERATOR_PATHS.map((path) => [path, () => assert.fail(`${path} was asked for`)]),
  );
  for (const built of [OPERATOR, NO_OPERATOR]) {
    const seen = [];
    await smokeOf(built, OPERATOR_NOT_GIVEN, seen, never);
    await checkDeployment('https://qa-tools.ru', deployment(built, [], never), NOW, RECEIVE);
    assert.equal(seen.length, 24 - OPERATOR_PATHS.length);
  }
  // Each one alone, given: that one is asked for, the others are not.
  for (const [name, paths] of [
    ['texts', ['/terms', '/privacy']],
    ['contactEmail', ['/.well-known/security.txt']],
    ['statusPageUrl', STATUS_PATHS],
  ]) {
    for (const built of [COPY_OPERATOR, NO_OPERATOR]) {
      const seen = [];
      const others = Object.fromEntries(
        OPERATOR_PATHS.filter((path) => !paths.includes(path)).map((path) => [path, never[path]]),
      );
      await smokeOf(built, { ...OPERATOR_NOT_GIVEN, [name]: built[name] }, seen, others);
      assert.deepEqual(
        seen.map(({ path }) => path).filter((path) => OPERATOR_PATHS.includes(path)),
        paths,
        name,
      );
    }
  }
  // On the second host, closed to search, its Page not found carries the
  // proxy's noindex like every other answer there (#319, D275).
  for (const built of [OPERATOR, NO_OPERATOR]) {
    const fetcher = deployment(built);
    await checkDeployment(
      ALIAS_SITE,
      async (url, options) => {
        const answer = await fetcher(url, options);
        return url.origin === ALIAS_SITE ? onAliasSite(answer) : answer;
      },
      NOW,
      RECEIVE,
      { ...ALIAS_CHECK, operator: built },
    );
  }
});

test("smoke refuses the legal pages unlike OPERATOR_TEXTS: missing with the texts, served or not the site's Page not found without them (#381)", async () => {
  for (const [path, page, name] of [
    ['/terms', termsPage, 'the Terms of Use'],
    ['/privacy', privacyPage, 'the Privacy Policy'],
  ]) {
    const refused = new RegExp(`^Error: ${path} did not return ${name}, uncached and indexable$`);
    for (const answer of [pageNotFound, plainNotFound, notFoundPage]) {
      await assert.rejects(smokeOf(OPERATOR, OPERATOR, [], { [path]: answer }), refused);
    }
    const notFound = new RegExp(
      `^Error: ${path} did not answer the site's Page not found, as an image without the operator's texts does$`,
    );
    for (const answer of [
      // The page itself, or the application shell with 200.
      page,
      () => pageNotFound({}, 200),
      // nginx's plain 404, or a 404 whose page is not the application.
      plainNotFound,
      notFoundPage,
      () => pageNotFound({}, 404, '<html><body>Not found</body></html>'),
      // Not HTML, kept out of search, or another status.
      () => pageNotFound({ 'content-type': 'text/plain' }),
      () => pageNotFound({ 'x-robots-tag': 'noindex' }),
      () => pageNotFound({}, 410),
      () => statusRedirect('https://qa-tools.ru/'),
    ]) {
      await assert.rejects(smokeOf(NO_OPERATOR, NO_OPERATOR, [], { [path]: answer }), notFound);
    }
  }
});

test('smoke refuses security.txt unlike CONTACT_EMAIL: the file of another address with one, any but a 404 without one (#381)', async () => {
  const given =
    /^Error: \/\.well-known\/security\.txt did not return a current security\.txt giving the contact address given$/;
  for (const answer of [
    plainNotFound,
    // Production's file, another copy's, or none, on a copy with its own address.
    () => security(),
    () => security(SECURITY_TXT.replace('contact@qa-tools.ru', 'hello@inspector.examples')),
    () => security(SECURITY_TXT.replace(/^Contact: .*\n/m, '')),
  ]) {
    await assert.rejects(
      smokeOf(COPY_OPERATOR, COPY_OPERATOR, [], { '/.well-known/security.txt': answer }),
      given,
    );
  }
  const none =
    /^Error: \/\.well-known\/security\.txt did not answer 404, as an image without a contact address does$/;
  for (const answer of [
    () => security(),
    () => security(SECURITY_TXT.replace(/^Contact: .*\n/m, '')),
    () => security('', 'text/plain'),
    () => pageNotFound({}, 200),
    () => pageNotFound({}, 410),
    () => new Response('unavailable', { status: 503 }),
  ]) {
    await assert.rejects(
      smokeOf(NO_OPERATOR, NO_OPERATOR, [], { '/.well-known/security.txt': answer }),
      none,
    );
  }
});

test("smoke refuses /status and /status/ unlike STATUS_PAGE_URL: anything but a 301 to it with one, anything but the site's Page not found without one (#381)", async () => {
  for (const path of STATUS_PATHS) {
    const given = new RegExp(
      `^Error: ${path.replaceAll('/', '\\/')} did not answer a 301 to the status page given$`,
    );
    for (const answer of [
      // Another kind of redirect.
      () => statusRedirect(OPERATOR.statusPageUrl, 302),
      () => statusRedirect(OPERATOR.statusPageUrl, 307),
      () => statusRedirect(OPERATOR.statusPageUrl, 308),
      // Another place, the same place written otherwise, or none.
      () => statusRedirect('https://status.example.com/'),
      () => statusRedirect('https://status.qa-tools.ru'),
      () => statusRedirect('http://status.qa-tools.ru/'),
      () => statusRedirect('https://status.qa-tools.ru/?from=qa-tools'),
      () => statusRedirect('/status'),
      () => statusRedirect(null),
      // No redirect at all.
      pageNotFound,
      () => pageNotFound({}, 200),
      html,
    ]) {
      await assert.rejects(smokeOf(OPERATOR, OPERATOR, [], { [path]: answer }), given);
    }
    // A copy's own status page, and not production's.
    await assert.rejects(
      smokeOf(COPY_OPERATOR, COPY_OPERATOR, [], { [path]: () => statusRedirect() }),
      given,
    );
    const none = new RegExp(
      `^Error: ${path.replaceAll('/', '\\/')} did not answer the site's Page not found, as an image without a status page does$`,
    );
    for (const answer of [
      () => statusRedirect(),
      () => statusRedirect('https://status.example.com/', 302),
      plainNotFound,
      notFoundPage,
      () => pageNotFound({}, 200),
      () => pageNotFound({ 'x-robots-tag': 'noindex' }),
      () => pageNotFound({ 'content-type': 'application/json' }),
    ]) {
      await assert.rejects(smokeOf(NO_OPERATOR, NO_OPERATOR, [], { [path]: answer }), none);
    }
  }
});

// The smoke keeps its own copy of the two addresses rather than importing the
// frontend's build script; this keeps them equal to the locations it writes.
test('the smoke asks for the status page at the addresses the image build redirects (#369, #381)', () => {
  const written = statusLocations('https://status.example.com/');
  assert.deepEqual(
    [
      ...written.matchAll(
        /^ {4}location = (\S+) \{\n {8}return 301 https:\/\/status\.example\.com\/;$/gm,
      ),
    ].map(([, path]) => path),
    STATUS_PATHS,
  );
});

const SITE = 'https://qa-tools.ru';

test("the smoke's command line: D187's call as it was, each operator's setting an option of either form anywhere among the hosts, empty for none, not checked when not given (#381)", () => {
  // D187's call, with or without the second host, which may be empty: none
  // of the operator's details given.
  assert.deepEqual(parseCommandLine([SITE, RECEIVE]), {
    base: SITE,
    receiveBase: RECEIVE,
    aliasBase: '',
    operator: OPERATOR_NOT_GIVEN,
  });
  assert.deepEqual(parseCommandLine([SITE, RECEIVE, '']).operator, OPERATOR_NOT_GIVEN);
  assert.equal(parseCommandLine([SITE, RECEIVE, ALIAS_SITE]).aliasBase, ALIAS_SITE);
  // As deployment-smoke runs it, the three after the hosts.
  assert.deepEqual(parseCommandLine([SITE, RECEIVE, ALIAS_SITE, ...OPERATOR_OPTIONS]), {
    base: SITE,
    receiveBase: RECEIVE,
    aliasBase: ALIAS_SITE,
    operator: OPERATOR,
  });
  // Either form, before, between and after the hosts.
  assert.deepEqual(
    parseCommandLine([
      '--status-page',
      OPERATOR.statusPageUrl,
      SITE,
      '--contact-email',
      OPERATOR.contactEmail,
      RECEIVE,
      '--operator-texts',
      'true',
    ]),
    { base: SITE, receiveBase: RECEIVE, aliasBase: '', operator: OPERATOR },
  );
  // Empty or blank is none, as the image build reads it, in either form.
  for (const blank of ['', ' ', '\t', '\n', '  \r\n ']) {
    const none = { statusPageUrl: null, contactEmail: null, texts: false };
    assert.deepEqual(
      parseCommandLine([
        SITE,
        RECEIVE,
        `--status-page=${blank}`,
        `--contact-email=${blank}`,
        `--operator-texts=${blank}`,
      ]).operator,
      none,
    );
    assert.deepEqual(
      parseCommandLine([
        SITE,
        RECEIVE,
        '--status-page',
        blank,
        '--contact-email',
        blank,
        '--operator-texts',
        blank,
      ]).operator,
      none,
    );
  }
  // A value is read as the build reads it: the status page as URL writes it,
  // what nginx redirects to, and the address trimmed.
  assert.deepEqual(
    parseCommandLine([
      SITE,
      RECEIVE,
      '--status-page= HTTPS://Status.Example.COM ',
      '--contact-email= hello@inspector.example ',
      '--operator-texts=false',
    ]).operator,
    {
      statusPageUrl: 'https://status.example.com/',
      contactEmail: 'hello@inspector.example',
      texts: false,
    },
  );
  // The texts need the other two only when one is given as none: not given,
  // it is not checked.
  assert.deepEqual(parseCommandLine([SITE, RECEIVE, '--operator-texts=true']).operator, {
    statusPageUrl: undefined,
    contactEmail: undefined,
    texts: true,
  });
});

test("the smoke's command line refuses an option it does not know, one given twice or without its value, a value the image build refuses, the texts without what they name and a fourth host, quoting nothing it was given (#381)", () => {
  const SECRET = 'secret-value';
  const refused = (argv, message) =>
    assert.throws(
      () => parseCommandLine(argv),
      (error) => message.test(error.message) && !error.message.includes(SECRET),
      argv.join(' ').slice(0, 200),
    );
  for (const option of [
    `--status=${SECRET}`,
    `--status-page-url=${SECRET}`,
    `--STATUS-PAGE=${SECRET}`,
    `--${SECRET}`,
    `-${SECRET}`,
    '--contact',
    '-s',
    '--',
    '-',
    `---status-page=${SECRET}`,
  ]) {
    refused(
      [SITE, RECEIVE, option],
      /^The smoke takes the options --status-page, --contact-email and --operator-texts alone\nUsage: /,
    );
  }
  for (const argv of [
    ['--status-page=', '--status-page=https://status.example.com/'],
    ['--contact-email', SECRET, '--contact-email='],
    ['--operator-texts=true', '--operator-texts', 'true'],
  ]) {
    refused([SITE, RECEIVE, ...argv], /^--[a-z-]+ is given more than once$/);
  }
  for (const argv of [
    ['--status-page'],
    ['--contact-email', '--operator-texts=true'],
    ['--operator-texts', '-1'],
    ['--status-page', `-${SECRET}`],
  ]) {
    refused(
      [SITE, RECEIVE, ...argv],
      /^--[a-z-]+ needs its value: --[a-z-]+=<value>, empty for none$/,
    );
  }
  for (const argv of [
    [],
    [SITE],
    ['', RECEIVE],
    [SITE, ''],
    ['--status-page=', SITE],
    [SITE, RECEIVE, ALIAS_SITE, SECRET],
    [SITE, RECEIVE, '', ''],
  ]) {
    refused(argv, /^Usage: node scripts\/check-deployment\.mjs /);
  }
  assert.ok(USAGE.startsWith('Usage: '));
  for (const value of [
    SECRET,
    `status.example.com/${SECRET}`,
    `ftp://status.example.com/${SECRET}`,
    `javascript:alert('${SECRET}')`,
    `https://user:${SECRET}@status.example.com/`,
    `https://status.example.com/?${SECRET}`,
    `https://status.example.com/#${SECRET}`,
    `https://status.example.com:0/${SECRET}`,
    `https://-${SECRET}.example/`,
    `https://status.example.com/$${SECRET}`,
    `https://status.example.com/;${SECRET}`,
    `https://status.example.com/%zz${SECRET}`,
  ]) {
    refused([SITE, RECEIVE, `--status-page=${value}`], /^--status-page must /);
  }
  for (const value of [
    SECRET,
    `@${SECRET}.example`,
    `${SECRET}@`,
    `${SECRET}@-x.example`,
    `${SECRET}@x..example`,
    `.${SECRET}@x.example`,
    `"${SECRET}"@x.example`,
    `${SECRET} x@x.example`,
    `${SECRET}@x.example\nContact: mailto:evil@x.example`,
    `mailto:${SECRET}@x.example`,
    `${'a'.repeat(65)}${SECRET}@x.example`,
  ]) {
    refused([SITE, RECEIVE, `--contact-email=${value}`], /^--contact-email must /);
  }
  for (const value of ['TRUE', 'True', 'yes', '1', 'on', `${SECRET}`, 'true false', 'truetrue']) {
    refused(
      [SITE, RECEIVE, `--operator-texts=${value}`],
      /^--operator-texts must be true or false/,
    );
  }
  // The texts name the status page and the contact address: an image built
  // with them and either given as none is refused at its build, as here.
  for (const argv of [
    ['--operator-texts=true', '--status-page='],
    ['--operator-texts=true', '--contact-email= '],
    ['--operator-texts=true', '--status-page=', '--contact-email=hello@inspector.example'],
  ]) {
    refused(
      [SITE, RECEIVE, ...argv],
      /^--operator-texts=true needs a status page and a contact address/,
    );
  }
});

/** Whether the smoke's `read` and the build's `build` give the same for `raw`: the same value, or both a refusal. */
function sameReading(read, build, raw, what) {
  let expected;
  let built = true;
  try {
    expected = build(raw);
  } catch {
    built = false;
  }
  if (built) {
    assert.equal(read(raw), expected, what);
  } else {
    assert.throws(() => read(raw), Error, what);
  }
}

/** Runs `fn`, failing if it takes more than 2 s: far more than any of these takes. */
function swiftly(what, fn) {
  const started = performance.now();
  fn();
  assert.ok(performance.now() - started < 2000, `${what} took too long`);
}

// The smoke keeps its own reading of the three settings rather than importing
// the frontend's source; this keeps it equal to the image build's, on made-up
// input at growing sizes, so that the smoke expects what the build made of
// the same value.
test('the smoke reads each operator setting as the image build does, on any input and at any size (#369, #381)', () => {
  const statusPages = [
    '',
    ' ',
    '\t\n',
    'https://status.qa-tools.ru/',
    'https://status.qa-tools.ru',
    ' https://status.qa-tools.ru/ ',
    'HTTPS://STATUS.EXAMPLE.COM/A/B',
    'http://status.example.com:8080/x/',
    'https://status.example.com:0/',
    'https://status.example.com:65536/',
    'https://xn--e1afmkfd.xn--p1ai/',
    'https://пример.рф/',
    'https://status.example.com./',
    'https://status..example.com/',
    'https://-status.example.com/',
    'https://status.example.com/a b',
    'https://status.example.com/a"b',
    'https://status.example.com/%41%zz',
    'https://status.example.com/%41',
    'https://status.example.com/a;b',
    "https://status.example.com/a'b",
    'https://status.example.com/a$b',
    'https://status.example.com/a(b)',
    'https://status.ex\nample.com/',
    'https://status.example.com/\t',
    'https://user@status.example.com/',
    'https://status.example.com/?',
    'https://status.example.com/#',
    'https://1.2.3.4/',
    'https://[::1]/',
    'ftp://status.example.com/',
    'javascript:alert(1)',
    'data:text/html,x',
    'status.example.com',
    '//status.example.com/',
    'https://',
    'https:///x',
    '\u0000https://status.example.com/',
    'https://status.example.com/\u0000',
    'https://status.example.com/é',
  ];
  const contacts = [
    '',
    ' ',
    'contact@qa-tools.ru',
    ' contact@qa-tools.ru\n',
    'Contact@QA-Tools.RU',
    'a@b',
    'a@b.c',
    '@b.c',
    'a@',
    'a@@b.c',
    'a@b@c.d',
    'a.@b.c',
    '.a@b.c',
    'a..b@c.d',
    'a+b_c%d-e@f-g.h',
    'a@-b.c',
    'a@b-.c',
    'a@b_c.d',
    'a b@c.d',
    '"a"@b.c',
    'a@b.c\nContact: mailto:x@y.z',
    'a@[1.2.3.4]',
    'é@b.c',
    'a@é.c',
    `${'a'.repeat(64)}@b.c`,
    `${'a'.repeat(65)}@b.c`,
    `a@${'b'.repeat(63)}.c`,
    `a@${'b'.repeat(64)}.c`,
    `${'a'.repeat(64)}@${'b.'.repeat(94)}cc`,
    `${'a'.repeat(64)}@${'b.'.repeat(95)}cc`,
  ];
  const texts = [
    '',
    ' ',
    'true',
    ' true ',
    'false',
    '\tfalse\n',
    'TRUE',
    'True',
    '1',
    'yes',
    'truefalse',
  ];

  for (const raw of statusPages) {
    sameReading(readStatusPage, parseStatusPageUrl, raw, JSON.stringify(raw));
  }
  for (const raw of contacts) {
    sameReading(readContactEmail, parseContactEmail, raw, JSON.stringify(raw));
  }
  for (const raw of texts) {
    sameReading(readOperatorTexts, parseOperatorTexts, raw, JSON.stringify(raw));
  }

  // At growing sizes, each shape read the same, and quickly.
  for (const size of [10, 1000, 100_000]) {
    const grown = {
      status: [
        ' '.repeat(size),
        `${'\t'.repeat(size)}https://status.example.com/`,
        `https://${'a'.repeat(size)}.example/`,
        `https://${'a.'.repeat(size)}example/`,
        `https://${'a-'.repeat(size)}a.example/`,
        `https://status.example.com/${'a/'.repeat(size)}`,
        `https://status.example.com/${'%41'.repeat(size)}`,
        `https://status.example.com/${'%'.repeat(size)}`,
        `https://status.example.com/${'%4'.repeat(size)}`,
        `https://status.example.com/${'$'.repeat(size)}`,
        `https://status.example.com/${'?'.repeat(size)}`,
        `https://status.example.com:${'1'.repeat(size)}/`,
        `https://${'@'.repeat(size)}status.example.com/`,
        'h'.repeat(size),
      ],
      contact: [
        ' '.repeat(size),
        `${'a'.repeat(size)}@example.com`,
        `a@${'b.'.repeat(size)}com`,
        `${'a.'.repeat(size)}a@x.example`,
        `${'a.'.repeat(size)}@x.example`,
        '@'.repeat(size),
        `${'a@'.repeat(size)}x.example`,
        'a'.repeat(size),
        `a@${'b-'.repeat(size)}b.example`,
      ],
      texts: [
        ' '.repeat(size),
        `${' '.repeat(size)}true${'\n'.repeat(size)}`,
        'true'.repeat(size),
        'x'.repeat(size),
      ],
    };
    swiftly(`size ${size}`, () => {
      for (const raw of grown.status) {
        sameReading(readStatusPage, parseStatusPageUrl, raw, `status, size ${size}`);
      }
      for (const raw of grown.contact) {
        sameReading(readContactEmail, parseContactEmail, raw, `contact, size ${size}`);
      }
      for (const raw of grown.texts) {
        sameReading(readOperatorTexts, parseOperatorTexts, raw, `texts, size ${size}`);
      }
    });
    // And on the command line, refusals quoting none of it.
    swiftly(`command line, size ${size}`, () => {
      for (const argv of [
        [SITE, RECEIVE, `--status-page=https://${'a'.repeat(size)}.example/?${'q'.repeat(size)}`],
        [SITE, RECEIVE, `--contact-email=${'a '.repeat(size)}@example.com`],
        [SITE, RECEIVE, `--operator-texts=${'x'.repeat(size)}`],
        [SITE, RECEIVE, `--${'x'.repeat(size)}=1`],
        [SITE, RECEIVE, ...Array.from({ length: size }, () => '--status-page=')],
        [SITE, RECEIVE, ...Array.from({ length: size }, () => SITE)],
        Array.from({ length: size }, () => '-'),
      ]) {
        assert.throws(
          () => parseCommandLine(argv),
          (error) => error.message.length < 400,
          `size ${size}`,
        );
      }
      assert.deepEqual(
        parseCommandLine([SITE, RECEIVE, `--status-page=${' '.repeat(size)}`]).operator
          .statusPageUrl,
        null,
      );
    });
  }
});

test("the smoke's command line says what it checked of the operator's details, and what it did not check, their setting not given (#381)", async () => {
  const run = async (built, options) => {
    const lines = [];
    await checkDeploymentMain(
      [SITE, RECEIVE, ...options],
      deployment(built),
      NOW,
      async () => assert.fail('no wait'),
      (line) => lines.push(line),
    );
    return lines;
  };
  const common = [
    'frontend, API/database lookup, API reference, the about page in English and in Russian',
    'the Russian home page, the two changelog feeds',
    'the files for search engines, a session page, the old receive URL (410), a path outside /s/, the MCP endpoint (405)',
  ];

  // D187's call: the details are not checked, and the first line says so.
  assert.deepEqual(await run(OPERATOR, []), [
    'Not checked, as their setting is not given: the Terms of Use and the Privacy Policy (--operator-texts), security.txt (--contact-email) and /status (--status-page)',
    `Deployed ${common[0]}, ${common[1]}, ${common[2]} and the receive host passed on qa-tools.ru (read-only)`,
  ]);
  // All three given, as deployment-smoke gives them: no such line.
  assert.deepEqual(await run(OPERATOR, OPERATOR_OPTIONS), [
    `Deployed ${common[0]}, the Terms of Use and the Privacy Policy, ${common[1]}, security.txt with the contact address given, ${common[2]}, the status page's redirect (301) and the receive host passed on qa-tools.ru (read-only)`,
  ]);
  // All three given as none.
  assert.deepEqual(
    await run(NO_OPERATOR, ['--status-page=', '--contact-email=', '--operator-texts=']),
    [
      `Deployed ${common[0]}, no Terms of Use or Privacy Policy (Page not found), ${common[1]}, no security.txt (404), ${common[2]}, no status page (Page not found) and the receive host passed on qa-tools.ru (read-only)`,
    ],
  );
  // One given: the other two are named.
  assert.deepEqual(await run(CONTACT_ONLY, ['--contact-email=hello@inspector.example']), [
    'Not checked, as their setting is not given: the Terms of Use and the Privacy Policy (--operator-texts) and /status (--status-page)',
    `Deployed ${common[0]}, ${common[1]}, security.txt with the contact address given, ${common[2]} and the receive host passed on qa-tools.ru (read-only)`,
  ]);
  assert.equal(
    notCheckedLine({ ...OPERATOR, texts: undefined }),
    'Not checked, as their setting is not given: the Terms of Use and the Privacy Policy (--operator-texts)',
  );
  assert.equal(notCheckedLine(OPERATOR), undefined);
  assert.match(checkedList(OPERATOR_NOT_GIVEN), /^frontend, .* and the receive host$/);
  // A deployment unlike the settings given fails, naming what.
  await assert.rejects(
    run(OPERATOR, ['--status-page=', '--contact-email=', '--operator-texts=']),
    /^Error: \/terms did not answer the site's Page not found, as an image without the operator's texts does$/,
  );
  await assert.rejects(
    run(NO_OPERATOR, OPERATOR_OPTIONS),
    /^Error: \/terms did not return the Terms of Use, uncached and indexable$/,
  );
});

// The runtime paths are the rule check-version.mjs holds, the one qa-tools'
// registry held for this code (D281, #325), and give what the pattern the
// check held before gave, on made-up paths: the prefixes as directories
// only, the whole names as whole paths only, and a test file keeping the
// version wherever it sits.
test('the version rule gives what the old runtime pattern gave', () => {
  const before = (path) =>
    /^(apps\/|packages\/|deploy\/(helm|postgres)\/|package(?:-lock)?\.json$|docker-compose\.yml$|\.dockerignore$|tsconfig\.base\.json$)/.test(
      path,
    ) && !/\.test\.tsx?$/.test(path);
  const paths = [
    'apps/backend/src/app.ts',
    'apps/backend/src/app.test.ts',
    'apps/frontend/src/App.test.tsx',
    'apps/frontend/src/App.tsx',
    'apps',
    'apps.md',
    'xapps/a.ts',
    'packages/shared/openapi.json',
    'deploy/helm/qa-tools/values.yaml',
    'deploy/postgres/Dockerfile',
    'deploy/cluster/README.md',
    'deploy/helmx/a',
    'package.json',
    'package-lock.json',
    'package.json.bak',
    'apps/backend/package.json',
    'docker-compose.yml',
    '.dockerignore',
    'tsconfig.base.json',
    'tsconfig.json',
    'scripts/check-version.mjs',
    '.gitlab/ci/validate.yml',
    'docs/API.md',
    'VERSION',
    'CHANGELOG.md',
    'apps/backend/src/x.test.ts.orig',
    'apps/backend/src/x.test.js',
    '',
  ];
  for (const size of [1, 1_000, 100_000]) {
    paths.push(
      `apps/${'a/'.repeat(size)}x.ts`,
      `${'x'.repeat(size)}package.json`,
      `apps/x${'.test'.repeat(size)}.ts`,
    );
  }
  for (const path of paths) {
    assert.equal(isRuntimePath(path), before(path), path.slice(0, 80));
  }
});

// The check as CI runs it, on a throwaway repository holding a copy of it:
// a test file changed alone keeps the version, a runtime file needs a bump,
// and a base with no VERSION, as this repository's first commit is, takes
// the import's version alone.
test('check-version, as CI runs it, keeps the version for a test file, asks a bump for runtime and starts at the import', (t) => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'qa-check-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('commit', '--quiet', '--allow-empty', '-m', 'the empty start');
  const start = git('rev-parse', 'HEAD');
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'apps', 'backend', 'src'), { recursive: true });
  copyFileSync(join(here, 'check-version.mjs'), join(dir, 'scripts', 'check-version.mjs'));
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.19.5\n');
  writeFileSync(join(dir, 'apps', 'backend', 'src', 'config.ts'), 'export const a = 1;\n');
  const check = (base) =>
    spawnSync(process.execPath, [join('scripts', 'check-version.mjs'), base], {
      cwd: dir,
      encoding: 'utf8',
    });
  const commit = (path, text) => {
    writeFileSync(join(dir, path), text);
    git('add', '-A');
    git('commit', '--quiet', '-m', path);
  };

  // The import onto the empty start: its version alone.
  commit('VERSION', '1.19.6\n');
  let result = check(start);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /takes only the import, at 1\.19\.5/);
  commit('VERSION', '1.19.5\n');
  result = check(start);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Product version and changelog checked\n');
  const base = git('rev-parse', 'HEAD');

  // After it, the rule: a test file keeps the version, a runtime file does not.
  commit('apps/backend/src/config.test.ts', 'x\n');
  result = check(base);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Product version and changelog checked\n');
  commit('apps/backend/src/config.ts', 'export const a = 2;\n');
  result = check(base);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Runtime changes require a VERSION bump/);

  // A base that is not a commit fails; it is never taken for the start.
  result = check('0'.repeat(40));
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /checked/);
});
