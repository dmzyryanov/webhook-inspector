import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { pageText, readChangelog, renderChangelogBody } from '../../scripts/changelog.mjs';
import { API_DOCS_LINK } from './api-docs-link.ts';
import { BRAND_MARK } from './brand-mark.ts';
import { CHANGELOG_LINK } from './changelog-link.ts';
import { STATUS_ACCESSIBLE_NAME, STATUS_LINK } from './status-link.ts';

/**
 * The public status page (issue #99, D209), without a browser: the header's
 * `Status ↗` link in both places that draw the header, the Q mark below
 * 375 px, and the nginx locations that send `/status` to the page.
 * `e2e/standard-session.spec.ts` and `e2e/changelog.spec.ts` lay the header
 * out at 320, 360, 375 and 768 px.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const STATUS_PAGE = 'https://status.qa-tools.ru/';

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

/** Every `location` line of nginx.conf, comments removed. */
function locationLines(): string[] {
  return read('../../nginx.conf')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.startsWith('location '));
}

describe('the Status link', () => {
  it('points at the status page, at its own host, with nothing after the slash', () => {
    assert.equal(STATUS_LINK.href, STATUS_PAGE);

    const url = new URL(STATUS_LINK.href);

    assert.equal(url.protocol, 'https:');
    assert.equal(url.host, 'status.qa-tools.ru');
    assert.equal(`${url.pathname}${url.search}${url.hash}`, '/');
  });

  it('opens in a new tab with noopener, as API docs does', () => {
    assert.equal(STATUS_LINK.target, '_blank');
    assert.equal(STATUS_LINK.target, API_DOCS_LINK.target);
    assert.match(STATUS_LINK.rel, /(?:^| )noopener(?: |$)/);
  });

  /** A third party's page: a session page's address, the access key, never reaches it (D004). */
  it('sends no Referer, where same-origin API docs does not need to', () => {
    assert.equal(STATUS_LINK.rel, 'noopener noreferrer');
    assert.equal(API_DOCS_LINK.rel, 'noopener');
  });

  /** WCAG 2.5.3: the visible word comes first in the name; the rest says what ↗ says. */
  it('is named Status, then says it opens a new tab', () => {
    assert.equal(STATUS_LINK.label, 'Status');
    assert.equal(STATUS_ACCESSIBLE_NAME, 'Status (opens in a new tab)');
    assert.equal(STATUS_LINK.newTabNote, API_DOCS_LINK.newTabNote);
  });
});

describe('the application header (AppHeader.tsx)', () => {
  const header = read('../components/AppHeader.tsx');
  /** The source without comments, so a word in a comment proves nothing. */
  const code = header.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

  it('renders the link from the shared constant, with the new-tab note for screen readers only', () => {
    assert.ok(code.includes('href={STATUS_LINK.href}'));
    assert.ok(code.includes('target={STATUS_LINK.target}'));
    assert.ok(code.includes('rel={STATUS_LINK.rel}'));
    // The words are the interface's language's (D222); the English ones are the constant's.
    assert.ok(code.includes('{m.header.status}'));
    assert.match(code, /<span className="sr-only">\{` \$\{m\.header\.newTab\}`\}<\/span>/);
    // No address typed in the component: the constant is the one source.
    assert.ok(!code.includes('status.qa-tools.ru'));
  });

  it('reads Changelog | Status ↗ | API docs ↗, a divider between each pair, then | EN | RU from 768 px', () => {
    const divider = '<span aria-hidden="true" className="h-4 w-px bg-line" />';
    const changelog = code.indexOf('href={CHANGELOG_LINK.href}');
    const first = code.indexOf(divider);
    const status = code.indexOf('href={STATUS_LINK.href}');
    const second = code.indexOf(divider, first + 1);
    const apiDocs = code.indexOf('href={API_DOCS_LINK.href}');
    // The language switch closes the links from 768 px, after a third divider;
    // neither is drawn on a phone, where the switch is in the footer (D222).
    const third = code.indexOf(
      '<span aria-hidden="true" className="h-4 w-px bg-line max-md:hidden" />',
    );
    const language = code.indexOf('<LanguageSwitch place="header" className="max-md:hidden" />');

    assert.ok(changelog > 0, 'no Changelog link');
    assert.ok(changelog < first && first < status, 'Status does not follow the first divider');
    assert.ok(status < second && second < apiDocs, 'API docs does not follow the second divider');
    assert.ok(apiDocs < third && third < language, 'the switch does not follow a third divider');
    assert.match(code, /\{phone \? null : \(/);
    assert.equal(code.split(divider).length - 1, 2);
  });

  it('draws the arrow after both new-tab links, and after nothing else', () => {
    const arrows = [...code.matchAll(/<NewTabArrow \/>/g)].map((match) => match.index);
    const status = code.indexOf('{m.header.status}');
    const apiDocs = code.indexOf('{m.header.apiDocs}');

    assert.equal(arrows.length, 2);
    assert.ok(status < (arrows[0] as number) && (arrows[0] as number) < apiDocs);
    assert.ok(apiDocs < (arrows[1] as number));
    assert.ok(!code.includes('↗'), 'a typed U+2197 instead of the drawn arrow');
  });

  it('puts the links 16 px apart from 768 px and 12 px below', () => {
    assert.match(code, /className="flex items-center gap-4 max-md:gap-3"/);
  });

  it('keeps aria-current off every link: no page of the application is one of them', () => {
    assert.doesNotMatch(code, /aria-current/);
  });

  /** The wordmark's span inside the link home: its classes and its words. */
  const wordmark =
    /<span className="([^"]*)">\s*([^<]*?)\s*<\/span>\s*<img\s+src=\{BRAND_MARK\.src\}/.exec(code);
  const wordmarkClasses = (wordmark?.[1] ?? '').split(' ');

  it('draws the Q mark in place of the wordmark below 375 px, the name kept as Webhook Inspector', () => {
    assert.equal(wordmark?.[2], 'Webhook Inspector');
    // Tailwind's max-[375px] is `@media (width < 375px)`: 375 itself keeps the wordmark.
    assert.equal(wordmarkClasses.at(-1), 'max-[375px]:sr-only');
    assert.match(
      code,
      /<img\s+src=\{BRAND_MARK\.src\}\s+alt=""\s+width=\{BRAND_MARK\.size\}\s+height=\{BRAND_MARK\.size\}\s+className="hidden size-6 max-\[375px\]:block"\s*\/>/,
    );
    // Both inside the one link home, to the language's home page (D226).
    const link = /<Link\s+to=\{homeAddress\(m\.lang\)\}[\s\S]*?<\/Link>/.exec(code)?.[0] ?? '';

    assert.ok(link.includes('Webhook Inspector') && link.includes('BRAND_MARK.src'));
    assert.ok(!code.includes('QA Tools</'), 'the old wordmark is still drawn');
  });

  it('puts the name on two lines at 15/17 px from 375 to 767 px, one line from 768 px (D277)', () => {
    // A block no wider than its longest word, so `Webhook` stands over
    // `Inspector`; max-width rather than width, so .sr-only's 1 px still wins
    // below 375 px whichever of the two rules Tailwind writes last.
    assert.deepEqual(wordmarkClasses, [
      'max-md:block',
      'max-md:max-w-min',
      'max-md:text-[15px]',
      'max-md:leading-[17px]',
      'max-[375px]:sr-only',
    ]);
    assert.ok(
      !wordmarkClasses.some((name) => /(?:^|:)w-/.test(name)),
      'a width that .sr-only could lose to',
    );
    // From 768 px it is the link's own 17 px, Semi Bold, on one line.
    assert.match(
      code,
      /<Link\s+to=\{homeAddress\(m\.lang\)\}\s+className="rounded-\[7px\] text-\[17px\] font-semibold /,
    );
  });
});

describe('the changelog page header (scripts/changelog.mjs)', () => {
  const body = renderChangelogBody(readChangelog());
  const header = /<header class="site-header">([\s\S]*?)<\/header>/.exec(body)?.[1] ?? '';
  const links = [...header.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => ({
    attributes: match[1] as string,
    html: match[0],
    name: pageText(match[2] as string),
  }));
  const attribute = (attributes: string, name: string) =>
    new RegExp(`\\s${name}="([^"]*)"`).exec(attributes)?.[1];

  it('names the four links in order: home, Changelog, Status, API docs', () => {
    assert.deepEqual(
      links.map((link) => link.name),
      ['Webhook Inspector', 'Changelog', STATUS_ACCESSIBLE_NAME, 'API docs (opens in a new tab)'],
    );
  });

  it('points Status at the status page in a new tab with noopener and noreferrer', () => {
    const status = links[2] as (typeof links)[number];

    assert.equal(attribute(status.attributes, 'href'), STATUS_PAGE);
    assert.equal(attribute(status.attributes, 'target'), '_blank');
    assert.equal(attribute(status.attributes, 'rel'), 'noopener noreferrer');
    assert.equal(attribute((links[3] as (typeof links)[number]).attributes, 'rel'), 'noopener');
    assert.equal(attribute(status.attributes, 'aria-current'), undefined);
    assert.match(
      status.html,
      /^<a [^>]*>Status<svg aria-hidden="true"[^>]*>[\s\S]*<\/svg><span class="sr-only"> \(opens in a new tab\)<\/span><\/a>$/,
    );
  });

  it('keeps Changelog the current page, and only Changelog', () => {
    assert.deepEqual(
      links.map((link) => attribute(link.attributes, 'aria-current')),
      [undefined, 'page', undefined, undefined],
    );
    assert.equal(
      attribute((links[1] as (typeof links)[number]).attributes, 'href'),
      CHANGELOG_LINK.href,
    );
  });

  it('puts a divider between each pair of links, and an arrow after both new-tab links', () => {
    assert.match(
      header,
      /<\/a>\s*<span class="header-divider" aria-hidden="true"><\/span>\s*<a class="header-link" href="https:\/\/status\.qa-tools\.ru\/"[\s\S]*?<\/a>\s*<span class="header-divider" aria-hidden="true"><\/span>\s*<a class="header-link" href="\/docs"/,
    );
    assert.equal(header.split('class="header-divider"').length - 1, 2);
    assert.equal(header.split('<svg aria-hidden="true"').length - 1, 2);
    assert.ok(!header.includes('↗'), 'a typed U+2197 instead of the drawn arrow');
  });

  it('draws the Q mark inside the link home, with the words kept for assistive technology', () => {
    const home = links[0] as (typeof links)[number];

    assert.equal(attribute(home.attributes, 'href'), '/');
    assert.equal(
      home.html,
      `<a class="brand" href="/"><span class="brand-name">Webhook Inspector</span><img class="brand-mark" src="${BRAND_MARK.src}" alt="" width="24" height="24" /></a>`,
    );
  });

  it('switches to the Q mark below 375 px, and to two lines and 12 px between links below 768 px', () => {
    // The header of /changelog and /about is styled once, for both (D211).
    const css = read('../static-pages/site-chrome.css');
    const block = (query: string) => {
      const start = css.indexOf(`@media (${query}) {`);

      assert.ok(start >= 0, `site-chrome.css has no @media (${query})`);

      return css.slice(start, css.indexOf('\n}\n', start));
    };

    assert.match(css, /\.brand-mark \{\n\s*display: none;\n\s*width: 24px;\n\s*height: 24px;\n\}/);
    assert.match(
      css,
      /\.header-links \{\n\s*display: flex;\n\s*align-items: center;\n\s*gap: 16px;\n\}/,
    );
    assert.match(block('max-width: 767.98px'), /\.header-links \{\n\s*gap: 12px;\n\s*\}/);
    // The wordmark on two lines, 15 px on a 17 px line (D277); max-width, so
    // the 1 px of the rule below 375 px is never overridden.
    assert.match(
      block('max-width: 767.98px'),
      /\.brand-name \{\n\s*display: block;\n\s*max-width: min-content;\n\s*font-size: 15px;\n\s*line-height: 17px;\n\s*\}/,
    );
    assert.doesNotMatch(css, /\.brand-name \{[^}]*(?<!-)width: (?!1px)/);

    const narrow = block('max-width: 374.98px');

    assert.match(narrow, /\.brand-mark \{\n\s*display: block;\n\s*\}/);
    // The words are hidden as .sr-only hides them, never with display: none.
    assert.match(narrow, /\.brand-name \{[^}]*clip: rect\(0, 0, 0, 0\);[^}]*\}/);
    assert.doesNotMatch(narrow, /\.brand-name \{[^}]*display: none/);
  });
});

describe('the Q mark', () => {
  it('is the tab icon PNG, 192 × 192, which public/ copies into the build', () => {
    const png = readFileSync(new URL(`../../public${BRAND_MARK.src}`, import.meta.url));

    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 192);
    assert.equal(png.readUInt32BE(20), 192);
    assert.equal(BRAND_MARK.size, 24);
  });
});

describe('the /status locations in nginx.conf', () => {
  it('send /status and /status/ to the status page with a 301, and nothing else', () => {
    for (const address of ['/status', '/status/']) {
      assert.equal(location(address), `return 301 ${STATUS_PAGE};`);
    }
  });

  it('redirect to a fixed absolute https URL, so the request cannot shape the Location', () => {
    for (const address of ['/status', '/status/']) {
      const target = /^return 301 (\S+);$/.exec(location(address))?.[1] ?? '';

      // An absolute target: absolute_redirect, port_in_redirect and
      // server_name_in_redirect rewrite only one that starts with `/`.
      assert.ok(target.startsWith('https://'), target);
      // No variable: not $host, $http_host, $scheme, $request_uri or $args.
      assert.ok(!target.includes('$'), target);
      assert.equal(target, STATUS_LINK.href);
    }
  });

  it('are exact locations only: /status/anything and /statusx stay the application 404', () => {
    const status = locationLines().filter((line) => /status/i.test(line));

    assert.deepEqual(status, ['location = /status {', 'location = /status/ {']);
  });
});
