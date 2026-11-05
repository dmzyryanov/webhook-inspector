import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ChangelogEntry } from '../../scripts/changelog.mjs';
import type { SiteOrigins } from '../../scripts/site-origin.mjs';
import { API_DOCS_LINK } from './api-docs-link.ts';
import { filterDays } from './changelog-controls.ts';
import { CHANGELOG_LINK } from './changelog-link.ts';
import { isWellFormedXml } from './xml-format.ts';

/**
 * Production's origins, whatever the shell running the tests holds (#354):
 * `CHANGELOG.md` and everything pinned here are written for production
 * (D274). The build's modules read the origins from the environment as they
 * load, so they are imported once these are set, not with the static imports
 * above, which would load them first; the scripts this file runs inherit
 * them.
 */
Object.assign(process.env, {
  APP_ORIGIN: 'https://qa-tools.ru',
  RECEIVE_ORIGIN: 'https://hook.qa-tools.ru',
  APP_ALIAS_ORIGIN: 'https://webhook.qa-tools.ru',
});

const {
  changelogFeedProblems,
  checkBuild,
  COMMENTED_PAGES,
  pageCommentProblems,
  pageComments,
  productionNamesLeft,
  // @ts-expect-error -- a plain ES module with no declarations; the build runs it.
} = await import('../../scripts/check-build.mjs');
const {
  BREAKING_FEED_PATH,
  CHANGELOG_SOURCE,
  CHANGELOG_URL,
  changelogFeed,
  changelogMarkdown,
  entryHtml,
  escapeHtml,
  escapeXml,
  FEED_PATH,
  feedEntryId,
  formatDay,
  groupByDay,
  hasNotice,
  NOTICE_PREFIX,
  noticeBadge,
  pageText,
  parseChangelog,
  plainText,
  publishedTextProblems,
  readChangelog,
  readFeedEntries,
  renderChangelogBody,
  renderChangelogPage,
  renderInline,
  stripReferences,
  unescapeXml,
  versionCount,
} = await import('../../scripts/changelog.mjs');
const { PRODUCTION_ORIGINS, SITE_ORIGINS } = await import('../../scripts/site-origin.mjs');

/** A copy at another address with no second origin of its own, as `llms.test.ts` has one (#342). */
const ANOTHER: SiteOrigins = {
  app: 'https://inspector.example',
  receive: 'https://hook.inspector.example',
  alias: null,
};

/**
 * The public changelog (issue #97, D184), without a browser: the parser and
 * renderers the build runs on `CHANGELOG.md`, the check that nothing internal
 * is published, the nginx locations, the sitemap, the image's build context
 * and the header every page carries. `e2e/changelog.spec.ts` opens the page.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const source = readFileSync(CHANGELOG_SOURCE, 'utf8');
const entries = readChangelog();
const markdown = changelogMarkdown(entries);
const body = renderChangelogBody(entries);

/**
 * The changes announced ahead, each its entry's Notice paragraph after
 * `**Notice:** `, references removed (D224): issue #214's server log line,
 * carried by 1.0.11, and issue #275's move of the contact address's mail.
 */
const LOG_LINE_NOTICE =
  "from 2026-11-02, the server's log records the IP address of a sender that sends far more requests than the limits allow, at most once a minute.";

/**
 * The day the contact address's mail moves to Yandex 360 (issue #275): its
 * entry's day plus 14, the day `/privacy`'s line names, which
 * `legal-copy.test.ts` pins and `legal-facts.test.ts` holds to the entry. A
 * merge on a later UTC day moves it, with the entry's date.
 */
const MAIL_MOVE_DAY = '2026-11-08';

const MAIL_MOVE_NOTICE = `from ${MAIL_MOVE_DAY}, mail to the contact address is received by Yandex 360, in Russia, instead of Apple iCloud Mail. The address, \`contact@qa-tools.ru\`, stays the same.`;

/** The entry announcing the mail's move, found by its paragraph: its version is set at the merge. */
const mailMove = entries.find((entry) =>
  entry.paragraphs.includes(`${NOTICE_PREFIX} ${MAIL_MOVE_NOTICE}`),
);

/**
 * The opening of the Deprecated paragraph announcing the move of the
 * inspector's addresses to `webhook.qa-tools.ru` (#319, D275).
 */
const HOST_MOVE_OPENING =
  "**Deprecated:** Webhook Inspector's addresses on https://qa-tools.ru — the API under `/api/`, the MCP server at `/mcp`, the WebSocket at `/ws/`, the old webhook path `/s/`, the relay script `qa-tools-relay.mjs` and the changelog feeds `/changelog.xml` and `/changelog-breaking.xml`.";

/** The entry announcing that move, found by its paragraph: its version and day are set at the merge. */
const hostMove = entries.find((entry) =>
  entry.paragraphs.some((paragraph) => paragraph.startsWith(HOST_MOVE_OPENING)),
);

/**
 * The opening of the Deprecated paragraph announcing the end of the old
 * stable names - the request-id header, the subprotocols, the relay script's
 * name and variable - and of the default answer's message (#334, D279).
 */
const OLD_NAMES_OPENING =
  "**Deprecated:** the old names — the header `X-QA-Tools-Request-Id`, the subprotocols `qa-tools` and `qa-tools.access-key.<key>`, the relay script's name `qa-tools-relay.mjs` and its variable `QA_TOOLS_ACCESS_KEY` — and the default answer's `message`, `Captured by QA Tools`.";

/** The entry announcing it, found by its paragraph: its version and day are set at the merge. */
const oldNames = entries.find((entry) =>
  entry.paragraphs.some((paragraph) => paragraph.startsWith(OLD_NAMES_OPENING)),
);

/** A source of two versions, with whatever the test puts in them. */
function sample(newer: string, older = '2026-09-20\n\n**It started.**') {
  return `# Header\n\nRules, not published: ## not a version.\n\n## 0.2.0\n\n${newer}\n\n## 0.1.0\n\n${older}\n`;
}

describe('the parser', () => {
  it('reads the changelog here for production’s origins, whatever the shell running the tests holds (#354)', () => {
    assert.deepEqual(SITE_ORIGINS, PRODUCTION_ORIGINS);
  });

  it('reads every version of CHANGELOG.md, newest first, with its date and headline', () => {
    const headings = [...source.matchAll(/^## (\d+\.\d+\.\d+)$/gm)].map((match) => match[1]);
    const version = read('../../../../VERSION').trim();

    assert.deepEqual(
      entries.map((entry) => entry.version),
      headings,
    );
    assert.equal(entries[0]?.version, version, 'the newest entry is not VERSION');
    assert.equal(entries.at(-1)?.version, '0.5.0');

    for (const entry of entries) {
      assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, entry.version);
      assert.ok(entry.headline.length > 0, entry.version);
      assert.match(entry.headline, /[.!?]$/, `${entry.version}'s headline is not a sentence`);
    }
  });

  it('dates past versions by the UTC day of their tags', () => {
    const dates = Object.fromEntries(entries.map((entry) => [entry.version, entry.date]));

    assert.equal(dates['0.5.0'], '2026-09-20');
    assert.equal(dates['0.7.0'], '2026-09-22');
    assert.equal(dates['0.24.1'], '2026-09-25');
    // No tag: the day of its merge commit.
    assert.equal(dates['0.25.3'], '2026-09-26');
    assert.equal(dates['0.30.0'], '2026-09-29');
    assert.equal(dates['0.32.0'], '2026-09-30');
  });

  it('marks as breaking exactly the entries with a Breaking paragraph, none before 0.16.0', () => {
    assert.deepEqual(
      entries.filter((entry) => entry.breaking).map((entry) => entry.version),
      [
        '1.0.8',
        '0.57.3',
        '0.57.1',
        '0.52.1',
        '0.49.1',
        '0.46.0',
        '0.43.0',
        '0.38.0',
        '0.36.0',
        '0.32.0',
        '0.29.0',
        '0.26.0',
        '0.24.2',
      ],
    );

    const published = entries.findIndex((entry) => entry.version === '0.16.0');

    assert.ok(entries.slice(published + 1).every((entry) => !entry.breaking));
  });

  it('drops the source header and keeps the text after the headline', () => {
    const [entry] = parseChangelog(
      sample('2026-09-21\n\n**It changed.** More\nwords.\n\n**Breaking:** it broke.'),
    );

    assert.deepEqual(entry, {
      version: '0.2.0',
      date: '2026-09-21',
      headline: 'It changed.',
      lead: 'More words.',
      paragraphs: ['**Breaking:** it broke.'],
      breaking: true,
      deprecated: false,
      notice: false,
    });
  });

  it('reads a Deprecated paragraph, first carried by the entry announcing new enum values (D212, D248)', () => {
    // Found by its paragraph, not its version, which is set at the merge; the
    // second announces the move of the inspector's addresses (D275).
    const deprecated = entries.filter((entry) => entry.deprecated);

    assert.ok(hostMove, 'no entry announces the move to webhook.qa-tools.ru');
    assert.ok(oldNames, 'no entry announces the end of the old names');
    assert.equal(deprecated.length, 3);
    assert.equal(deprecated[0], oldNames);
    assert.equal(deprecated[1], hostMove);
    assert.ok(
      deprecated[2]?.paragraphs.some((paragraph) =>
        paragraph.startsWith(
          '**Deprecated:** the fixed list of values of each enum in an answer or an event',
        ),
      ),
    );

    const [entry] = parseChangelog(
      sample(
        '2026-09-21\n\n**It changed.**\n\n**Deprecated:** `GET /api/old` is removed on 2026-11-01; use `GET /api/new`.',
      ),
    );

    assert.equal(entry?.deprecated, true);
    assert.equal(entry?.breaking, false);
    assert.ok(entry && hasNotice(entry));

    // Only a paragraph that starts with it: not one that names it later, nor
    // one whose colon sits outside the bold.
    for (const paragraph of [
      'It names **Deprecated:** in the middle.',
      '**Deprecated**: the colon outside.',
      'Deprecated: without bold.',
    ]) {
      const [other] = parseChangelog(sample(`2026-09-21\n\n**It changed.**\n\n${paragraph}`));

      assert.equal(other?.deprecated, false, paragraph);
      assert.equal(other && hasNotice(other), false, paragraph);
    }
  });

  it('reads a Notice paragraph, first carried by 1.0.11, as it reads a Deprecated one (D224)', () => {
    assert.equal(NOTICE_PREFIX, '**Notice:**');
    // The second, the contact address's mail moving (issue #275), is found by
    // its paragraph, not its version, which is set at the merge.
    assert.ok(mailMove, 'no entry announces the move of the mail');
    assert.deepEqual(
      entries.filter((entry) => entry.notice).map((entry) => entry.version),
      [mailMove.version, '1.0.11'],
    );

    const [entry] = parseChangelog(
      sample(
        '2026-09-21\n\n**It changed.**\n\n**Notice:** from 2026-10-05 the Privacy Policy keeps the logs 30 days.',
      ),
    );

    assert.equal(entry?.notice, true);
    assert.equal(entry?.breaking, false);
    assert.equal(entry?.deprecated, false);
    assert.ok(entry && hasNotice(entry));

    // Only a paragraph that starts with it: not one that names it later, nor
    // one whose colon sits outside the bold, nor the lead after the headline.
    for (const text of [
      '**It changed.**\n\nIt names **Notice:** in the middle.',
      '**It changed.**\n\n**Notice**: the colon outside.',
      '**It changed.**\n\nNotice: without bold.',
      '**It changed.**\n\n**notice:** in lower case.',
      '**It changed.** **Notice:** in the lead.',
    ]) {
      const [other] = parseChangelog(sample(`2026-09-21\n\n${text}`));

      assert.equal(other?.notice, false, text);
      assert.equal(other && hasNotice(other), false, text);
    }
  });

  it('requires a date under every version', () => {
    assert.throws(() => parseChangelog(sample('**It changed.**')), /0\.2\.0 has no date/);
    assert.throws(
      () => parseChangelog(sample('2026-02-30\n\n**It changed.**')),
      /0\.2\.0 has no date/,
    );
    assert.throws(
      () => parseChangelog(sample('2026-09-21\n\n**It changed.**', '**It started.**')),
      /0\.1\.0 has no date/,
    );
  });

  it('requires every entry to open with a bold headline', () => {
    assert.throws(
      () => parseChangelog(sample('2026-09-21\n\nIt changed, **quietly**.')),
      /0\.2\.0 does not open with a bold headline/,
    );
    assert.throws(
      () => parseChangelog(sample('2026-09-21')),
      /0\.2\.0 does not open with a bold headline/,
    );
    assert.throws(
      () => parseChangelog(sample('2026-09-21\n\n**Breaking:** it broke.')),
      /0\.2\.0 does not open with a bold headline/,
    );
    assert.throws(
      () => parseChangelog(sample('2026-09-21\n\n**Deprecated:** it goes on 2026-11-01.')),
      /0\.2\.0 does not open with a bold headline/,
    );
    assert.throws(
      () => parseChangelog(sample('2026-09-21\n\n**Notice:** the terms change on 2026-10-05.')),
      /0\.2\.0 does not open with a bold headline/,
    );
  });

  it('refuses versions out of order, a later version dated earlier, and no version at all', () => {
    assert.throws(
      () => parseChangelog(sample('2026-09-19\n\n**It changed.**')),
      /0\.2\.0 is dated 2026-09-19, before 0\.1\.0/,
    );
    assert.throws(
      () =>
        parseChangelog('## 0.1.0\n\n2026-09-20\n\n**A.**\n\n## 0.2.0\n\n2026-09-20\n\n**B.**\n'),
      /0\.2\.0 is listed after 0\.1\.0/,
    );
    assert.throws(() => parseChangelog('# Nothing yet\n'), /no version heading/);
  });
});

describe('reference stripping', () => {
  it('removes a trailing parenthesis of issue and decision references, ranges included', () => {
    assert.equal(stripReferences('as before (#69, D183).'), 'as before.');
    assert.equal(stripReferences('changed (D150–D153).'), 'changed.');
    assert.equal(stripReferences('three (#68, #93, D181).'), 'three.');
  });

  it('leaves any other parenthesis alone', () => {
    assert.equal(
      stripReferences('a row (`2 of 4`) and (RFC 9116)'),
      'a row (`2 of 4`) and (RFC 9116)',
    );
  });

  it('is applied to every paragraph, a reference wrapped over two lines included', () => {
    const [entry] = parseChangelog(
      sample('2026-09-21\n\n**It changed (#1).** Then (#2,\nD003).\n\n**Breaking:** so (D004).'),
    );

    assert.equal(entry?.headline, 'It changed.');
    assert.equal(entry?.lead, 'Then.');
    assert.deepEqual(entry?.paragraphs, ['**Breaking:** so.']);
  });
});

describe('what may be published', () => {
  const leaks = [
    'Fixed in #97.',
    'See D184.',
    'Read docs/API.md first.',
    'In apps/frontend/src.',
    'Run scripts/check-version.mjs.',
    'The chart in deploy/helm.',
    'An agent in .claude/agents.',
    'The runbook says so.',
    'A Secret holds it.',
    'A CronJob runs it.',
    'Traefik cut it.',
    'k3s restarted.',
    'Helm upgraded it.',
    'Ask kubectl.',
    'The job qa-tools-delete-expired-sessions.',
    'The Deployment qa-tools-relay restarted.',
    'A file named qa-tools-relay.mjsx.',
    // The relay's old User-Agent is taken right after `User-Agent ` alone (D279).
    'The User-Agent qa-tools-relay-api restarted.',
    'The User-Agent `qa-tools-relay.x` is gone.',
    'The User-Agent qa-tools-api is gone.',
    'The agent qa-tools-relay is gone.',
    'User-Agent: qa-tools-relay.',
    'Kubernetes restarted it.',
    'The Ingress routes it.',
    'A pod restarted.',
    'Two pods run it.',
    'A new namespace holds it.',
    'Both namespaces were renamed.',
  ];

  for (const text of leaks) {
    it(`refuses "${text}"`, () => {
      assert.equal(publishedTextProblems(text).length, 1, publishedTextProblems(text).join('\n'));
    });
  }

  it('accepts site addresses, headers and ordinary words that only look alike', () => {
    assert.deepEqual(
      publishedTextProblems(
        [
          'Open https://qa-tools.ru/docs or `/docs/`, `/changelog.md` and contact@qa-tools.ru.',
          '`X-QA-Tools-Request-Id`, `<origin>/v/<session-id>#<request-id>` and `qa-tools`.',
          'Scripts and agents read it; do not send production secrets. 2,000,000 characters.',
          'An iPod, a tripod, the podcast and a namespaced tag, ingress and egress of data.',
          // The relay script is a public file and its name a public address (D202).
          'Run `node qa-tools-relay.mjs`, downloaded from https://qa-tools.ru/qa-tools-relay.mjs.',
          // Its old User-Agent, in the published Markdown and in a page's text (D279).
          'It sent the User-Agent `qa-tools-relay`: nothing reads it. It sent the User-Agent qa-tools-relay.',
        ].join('\n'),
      ),
      [],
    );
  });

  it('passes the published text, and fails the source it came from', () => {
    assert.deepEqual(publishedTextProblems(markdown), []);
    assert.deepEqual(publishedTextProblems(pageText(body)), []);
    assert.ok(publishedTextProblems(source).length > 0, 'the source carries references');
  });
});

describe('/changelog.md', () => {
  it('opens with the public header, which says the API was not public before 0.16.0', () => {
    assert.match(markdown, /^# Webhook Inspector — Changelog\n/);
    // The service's name, not the platform's (D277).
    assert.ok(
      markdown.includes(
        '\nWhat changed in each version of Webhook Inspector (https://qa-tools.ru), newest first.',
      ),
    );
    assert.ok(markdown.includes('The API was not public before 0.16.0'));
    assert.ok(markdown.includes('https://qa-tools.ru/changelog'));
    assert.ok(!markdown.includes('How to write an entry'), 'the source header is published');
  });

  it('holds every version with its date and whole entry, newest first', () => {
    const headings = [...markdown.matchAll(/^## (\S+)\n\n(\S+)\n\n\*\*/gm)].map((match) => [
      match[1],
      match[2],
    ]);

    assert.deepEqual(
      headings,
      entries.map((entry) => [entry.version, entry.date]),
    );

    const entry = entries.find((candidate) => candidate.version === '0.29.0');

    assert.ok(entry);
    assert.ok(markdown.includes(`**${entry.headline}** ${entry.lead}`));

    for (const paragraph of entry.paragraphs) {
      assert.ok(markdown.includes(`\n\n${paragraph}\n`));
    }
  });

  it('tells a reader what a Notice paragraph is, and the source header the writer when one is needed (D224)', () => {
    assert.ok(
      markdown.includes(
        'A change to the Terms of Use or the Privacy Policy announced before it applies has a paragraph that starts **Notice:**, naming the change and the day it applies.',
      ),
    );

    const header = source.slice(0, source.search(/^## \d/m)).replace(/\s+/g, ' ');

    for (const phrase of [
      '`https://webhook.qa-tools.ru/changelog-breaking.xml` with the versions whose entry has a Breaking, a Deprecated or a Notice paragraph',
      '- **Notice.** A paragraph inside the entry that starts `**Notice:**` announces a change to the Terms of Use or the Privacy Policy',
      "It is required for a new version of the Terms of Use, except one the law requires, one needed to protect the service or one that only adds to the user's rights,",
      'keeps more data on the server, keeps it longer or shares it with anyone new — a move to another provider included — unless the law requires it sooner.',
      'Such a change ships in two steps:',
      'needs no Notice paragraph.',
      'labels an entry that has only a Notice paragraph `Notice`, and shows it under `Breaking only`; the breaking feed carries it.',
      'Like Breaking, it is never the headline: the build refuses an entry that opens with it.',
    ]) {
      assert.ok(header.includes(phrase), phrase);
    }
  });

  it("names in the source header the one address its opening gives the site's changelog (#409)", () => {
    const header = source.slice(0, source.search(/^## \d/m)).replace(/\s+/g, ' ');

    assert.ok(header.includes('The site renders it at https://webhook.qa-tools.ru/changelog,'));

    for (const path of [
      '/changelog',
      '/changelog.md',
      '/changelog.xml',
      '/changelog-breaking.xml',
    ]) {
      assert.ok(header.includes(`\`https://webhook.qa-tools.ru${path}\``), path);
    }

    assert.ok(
      !header.includes('https://qa-tools.ru/changelog'),
      'the source header names a second origin for the changelog',
    );
  });

  it('follows the source: a changed entry changes the text', () => {
    const changed = parseChangelog(sample('2026-09-21\n\n**Something new.** Said here.'));

    assert.match(
      changelogMarkdown(changed),
      /## 0\.2\.0\n\n2026-09-21\n\n\*\*Something new\.\*\* Said here\./,
    );
  });
});

describe('the page', () => {
  it('escapes the source, rendering only code and bold', () => {
    assert.equal(
      escapeHtml(`<a href="x">'&'</a>`),
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
    assert.equal(
      renderInline('`/v/<session-id>` and <b>**bold**</b>'),
      '<code>/v/&lt;session-id&gt;</code> and &lt;b&gt;<strong>bold</strong>&lt;/b&gt;',
    );
    assert.equal(renderInline('an `unmatched and **half'), 'an `unmatched and **half');
    assert.ok(body.includes('<code>/v/&lt;id&gt;</code>'));
    // `img` is the header's Q mark (D209), the one image the page draws;
    // `wbr` where the footer's links may break below 1024 px (D217).
    assert.ok(
      !/<(?!\/?(?:header|a|div|span|svg|path|img|main|h1|p|strong|code|button|section|time|details|summary|footer|wbr)\b)[a-z]/.test(
        body,
      ),
    );
    assert.equal(body.split('<img ').length - 1, 1);
  });

  it('groups versions by UTC day, newest first, with the day’s count', () => {
    const days = groupByDay(entries);

    assert.equal(
      days.reduce((sum, day) => sum + day.entries.length, 0),
      entries.length,
    );
    assert.deepEqual(
      days.find((day) => day.date === '2026-09-29')?.entries.map((entry) => entry.version),
      ['0.30.0', '0.29.0', '0.28.1', '0.28.0', '0.27.0'],
    );
    assert.equal(formatDay('2026-09-29'), '29 Sep 2026');
    assert.equal(formatDay('2026-10-01'), '1 Oct 2026');
    assert.equal(versionCount(1), '1 version');
    assert.equal(versionCount(5), '5 versions');
    assert.ok(
      body.includes(
        '<time datetime="2026-09-29">29 Sep 2026</time>\n<span class="count"><span class="count-separator">· </span>5 versions</span>',
      ),
    );
  });

  it('draws each version as a details element, only the newest open', () => {
    const details = [...body.matchAll(/<details class="version" id="v([^"]+)"([^>]*)>/g)];

    assert.deepEqual(
      details.map((match) => match[1]),
      entries.map((entry) => entry.version),
    );
    assert.deepEqual(
      details.filter((match) => / open$/.test(match[2] as string)).map((match) => match[1]),
      [entries[0]?.version],
    );

    // Every version with a Breaking, a Deprecated or a Notice paragraph, and
    // no other, carries data-breaking, which `Breaking only` keeps (D224).
    for (const entry of entries) {
      const breaking = new RegExp(`id="v${entry.version.replaceAll('.', '\\.')}" data-breaking=""`);

      assert.equal(breaking.test(body), hasNotice(entry), entry.version);
    }

    for (const [label, count] of [
      ['Breaking', entries.filter((entry) => entry.breaking).length],
      ['Deprecated', entries.filter((entry) => entry.deprecated && !entry.breaking).length],
      [
        'Notice',
        entries.filter((entry) => entry.notice && !entry.deprecated && !entry.breaking).length,
      ],
    ] as const) {
      assert.equal(body.split(`<span class="badge">${label}</span>`).length - 1, count, label);
    }

    for (const [mark, count] of [
      ['Breaking:', entries.filter((entry) => entry.breaking).length],
      ['Deprecated:', entries.filter((entry) => entry.deprecated).length],
      ['Notice:', entries.filter((entry) => entry.notice).length],
    ] as const) {
      assert.equal(
        body.split(`<p class="breaking"><strong>${mark}</strong>`).length - 1,
        count,
        mark,
      );
    }
  });

  // Issue #214's announcement, the Notice paragraph of 1.0.11 (D224), the
  // version the parser's test names, taken by that version so a later
  // Notice entry leaves it be, and issue #275's, the contact address's mail
  // moving, taken by its paragraph: each labelled Notice, its paragraph on
  // the red edge, kept by `Breaking only`.
  for (const [what, notice, said] of [
    ["1.0.11's notice", entries.find((entry) => entry.version === '1.0.11'), LOG_LINE_NOTICE],
    ["the mail move's notice", mailMove, MAIL_MOVE_NOTICE],
  ] as const) {
    it(`draws ${what} labelled Notice, under Breaking only, and the breaking feed and the text carry it`, () => {
      const version = notice?.version ?? '';

      assert.ok(notice);
      assert.equal(noticeBadge(notice), 'Notice');

      const start = body.indexOf(`<details class="version" id="v${version}"`);
      const line = body.slice(start, body.indexOf('</details>', start));

      assert.ok(start >= 0, version);
      assert.ok(line.startsWith(`<details class="version" id="v${version}" data-breaking=""`));
      assert.equal(line.split('<span class="badge">').length - 1, 1);
      assert.ok(line.includes('<span class="badge">Notice</span>'));
      assert.ok(
        line.includes(`<p class="breaking"><strong>Notice:</strong> ${renderInline(said)}</p>`),
      );

      // What the page's script hands the filter, day by day, as for the samples.
      const days = [...body.matchAll(/<section class="day"[\s\S]*?<\/section>/g)].map((day) =>
        [...day[0].matchAll(/<details class="version" id="v[^"]+"([^>]*)>/g)].map((item) =>
          (item[1] as string).includes('data-breaking'),
        ),
      );
      const shown = filterDays(days, 'breaking').flatMap((day) => day.versions);
      const versions = [...body.matchAll(/<details class="version" id="v([^"]+)"/g)].map(
        (match) => match[1],
      );
      const kept = versions.filter((_, index) => shown[index]);

      assert.ok(kept.includes(version));
      assert.deepEqual(
        kept,
        entries.filter(hasNotice).map((entry) => entry.version),
      );

      // `/changelog-breaking.xml` carries it with its paragraph, and
      // `/changelog.md` keeps the mark, both without the references.
      const carried = readFeedEntries(changelogFeed(entries, 'breaking')).find(
        (item) => item.id === feedEntryId(version),
      );

      assert.ok(
        carried?.content?.includes(`<p><strong>Notice:</strong> ${renderInline(said)}</p>`),
      );
      assert.ok(markdown.includes(`\n\n**Notice:** ${said}\n`));
    });
  }

  it('carries the header with Changelog as the current page, then Status and API docs, and the name only in the wordmark', () => {
    const header = /<header class="site-header">([\s\S]*?)<\/header>/.exec(body)?.[1] ?? '';

    // The Status link and the Q mark are pinned in status-link.test.ts (D209).
    assert.match(
      header,
      /<a class="header-link" href="\/changelog" aria-current="page">Changelog<\/a>\s*<span class="header-divider" aria-hidden="true"><\/span>\s*<a class="header-link" href="https:\/\/status\.qa-tools\.ru\/" target="_blank" rel="noopener noreferrer">Status<svg[\s\S]*?<\/a>\s*<span class="header-divider" aria-hidden="true"><\/span>\s*<a class="header-link" href="\/docs" target="_blank" rel="noopener">API docs<svg/,
    );
    assert.equal(header.split('<span class="sr-only"> (opens in a new tab)</span>').length - 1, 2);
    // D184's tool name and its divider stay gone: since D277 the service's
    // name is the wordmark itself, and nothing else in the header says it.
    assert.equal(header.split('Webhook Inspector').length - 1, 1);
    assert.match(
      header,
      /^\s*<a class="brand" href="\/"><span class="brand-name">Webhook Inspector<\/span>/,
    );
  });

  it('names the service in its lead, not the platform (D277)', () => {
    assert.ok(
      body.includes(
        '<p class="lead">What changed in each version of Webhook Inspector, newest first.',
      ),
    );
    assert.ok(!pageText(body).includes('each version of QA Tools'));
  });

  it('has the filter, Expand all and the link to the text, and the footer band', () => {
    assert.ok(body.includes('data-filter="all" aria-pressed="true">All versions</button>'));
    assert.ok(body.includes('data-filter="breaking" aria-pressed="false">Breaking only</button>'));
    assert.ok(body.includes('data-expand="">Expand all</button>'));
    assert.ok(body.includes('<a href="/changelog.md"><code>/changelog.md</code></a>'));
    assert.match(body, /<footer class="site-footer">[\s\S]*mailto:contact@qa-tools\.ru/);
  });

  it('offers the two feeds in a line of its own under the link to the text (D212)', () => {
    const line =
      '<p class="plain">Subscribe with a feed reader, Slack or a Telegram bot: all changes, <a href="/changelog.xml"><code>/changelog.xml</code></a> · breaking changes and deprecations only, <a href="/changelog-breaking.xml"><code>/changelog-breaking.xml</code></a></p>';

    assert.ok(body.includes(line));
    assert.ok(body.indexOf('<code>/changelog.md</code>') < body.indexOf(line));
    assert.ok(body.indexOf(line) < body.indexOf('<div class="list">'));
    // No control and no layout of its own: the intro's plain style.
    assert.equal(body.split('<p class="plain">').length - 1, 2);
  });

  it('draws a Deprecated entry like a Breaking one, labelled Deprecated, under Breaking only (D212)', () => {
    const source = sample(
      '2026-09-21\n\n**It changed.** More.\n\n**Deprecated:** `GET /api/old` is removed on or after 2026-11-01; use `GET /api/new`.',
      '2026-09-20\n\n**It started.**\n\n**Breaking:** it broke.',
    ).replace('## 0.1.0', '## 0.1.1\n\n2026-09-20\n\n**Nothing for clients.**\n\n## 0.1.0');
    const sampleEntries = parseChangelog(source);
    const page = renderChangelogBody(sampleEntries);

    assert.deepEqual(
      sampleEntries.map((entry) => [entry.version, noticeBadge(entry)]),
      [
        ['0.2.0', 'Deprecated'],
        ['0.1.1', null],
        ['0.1.0', 'Breaking'],
      ],
    );
    assert.match(page, /<details class="version" id="v0\.2\.0" data-breaking="" open>/);
    assert.match(page, /<details class="version" id="v0\.1\.1">/);
    assert.ok(page.includes('<span class="badge">Deprecated</span>'));
    assert.ok(
      page.includes(
        '<p class="breaking"><strong>Deprecated:</strong> <code>GET /api/old</code> is removed on or after 2026-11-01; use <code>GET /api/new</code>.</p>',
      ),
    );

    // What the page's script hands the filter: whether each line carries
    // data-breaking, day by day. Breaking only keeps 0.2.0 and 0.1.0.
    const days = [...page.matchAll(/<section class="day"[\s\S]*?<\/section>/g)].map((day) =>
      [...day[0].matchAll(/<details class="version" id="v[^"]+"([^>]*)>/g)].map((line) =>
        (line[1] as string).includes('data-breaking'),
      ),
    );
    const shown = filterDays(days, 'breaking');
    const versions = [...page.matchAll(/<details class="version" id="v([^"]+)"/g)].map(
      (match) => match[1],
    );

    assert.deepEqual(
      versions.filter((_, index) => shown.flatMap((day) => day.versions)[index]),
      ['0.2.0', '0.1.0'],
    );
  });

  it('draws a Notice entry as a Deprecated one, labelled Notice, under Breaking only (D224)', () => {
    const notice = '**Notice:** from 2026-10-05 the Privacy Policy says the logs are kept 30 days.';
    const source = [
      '# Header',
      '## 0.5.0\n\n2026-09-21\n\n**Only a notice.** More.\n\n' + notice,
      '## 0.4.0\n\n2026-09-21\n\n**A notice and a deprecation.**\n\n**Deprecated:** `GET /api/old`, on or after 2026-11-01.\n\n' +
        notice,
      '## 0.3.0\n\n2026-09-20\n\n**A notice and a break.**\n\n' +
        notice +
        '\n\n**Breaking:** it broke.',
      '## 0.2.0\n\n2026-09-20\n\n**Nothing for clients.**',
      '## 0.1.0\n\n2026-09-19\n\n**It started.** It names **Notice:** inside.',
    ].join('\n\n');
    const sampleEntries = parseChangelog(source);
    const page = renderChangelogBody(sampleEntries);

    // Breaking first, then Deprecated, then Notice: one label per line.
    assert.deepEqual(
      sampleEntries.map((entry) => [entry.version, noticeBadge(entry)]),
      [
        ['0.5.0', 'Notice'],
        ['0.4.0', 'Deprecated'],
        ['0.3.0', 'Breaking'],
        ['0.2.0', null],
        ['0.1.0', null],
      ],
    );
    assert.match(page, /<details class="version" id="v0\.5\.0" data-breaking="" open>/);
    assert.match(page, /<details class="version" id="v0\.4\.0" data-breaking="">/);
    assert.match(page, /<details class="version" id="v0\.3\.0" data-breaking="">/);
    assert.match(page, /<details class="version" id="v0\.2\.0">/);
    assert.match(page, /<details class="version" id="v0\.1\.0">/);
    assert.equal(page.split('<span class="badge">Notice</span>').length - 1, 1);
    // Its paragraph has the red edge Breaking and Deprecated have, in every entry.
    assert.equal(
      page.split(
        '<p class="breaking"><strong>Notice:</strong> from 2026-10-05 the Privacy Policy says the logs are kept 30 days.</p>',
      ).length - 1,
      3,
    );
    // Named inside a lead it is text, not a mark.
    assert.ok(page.includes('<p>It names <strong>Notice:</strong> inside.</p>'));

    const days = [...page.matchAll(/<section class="day"[\s\S]*?<\/section>/g)].map((day) =>
      [...day[0].matchAll(/<details class="version" id="v[^"]+"([^>]*)>/g)].map((line) =>
        (line[1] as string).includes('data-breaking'),
      ),
    );
    const shown = filterDays(days, 'breaking');
    const versions = [...page.matchAll(/<details class="version" id="v([^"]+)"/g)].map(
      (match) => match[1],
    );

    assert.deepEqual(
      versions.filter((_, index) => shown.flatMap((day) => day.versions)[index]),
      ['0.5.0', '0.4.0', '0.3.0'],
    );
    // The day of 2026-09-19 is left empty under Breaking only, and hidden.
    assert.deepEqual(
      shown.map((day) => day.day),
      [true, true, false],
    );
  });

  it('names both feeds in its head, as /docs does (D212)', () => {
    for (const template of [read('../../changelog/index.html'), read('../../docs/index.html')]) {
      const head = /<head>([\s\S]*)<\/head>/.exec(template)?.[1] ?? '';
      const feeds = [
        ...head.matchAll(
          /<link\s+rel="alternate"\s+type="application\/atom\+xml"\s+title="([^"]+)"\s+href="([^"]+)"\s*\/>/g,
        ),
      ].map((match) => [match[1], match[2]]);

      assert.deepEqual(feeds, [
        ['Webhook Inspector — Changelog', FEED_PATH],
        ['Webhook Inspector — Breaking changes and deprecations', BREAKING_FEED_PATH],
      ]);
    }
  });

  it('serves no issue or decision reference in a comment of the template of any page', () => {
    // The page templates sit where the build writes the pages, under apps/frontend.
    assert.deepEqual(COMMENTED_PAGES, [
      'index.html',
      'ru/index.html',
      'docs/index.html',
      'changelog/index.html',
      'about/index.html',
      // Amended by D255: the about page's Russian twin.
      'ru/about/index.html',
      'terms/index.html',
      'privacy/index.html',
    ]);

    for (const file of COMMENTED_PAGES as string[]) {
      const template = read(`../../${file}`);

      // The application's two templates, the English and the Russian home
      // page, have no comment; the others are read.
      assert.equal(
        pageComments(template).length > 0,
        !['index.html', 'ru/index.html'].includes(file),
        file,
      );
      assert.deepEqual(pageCommentProblems(file, template), [], file);
    }
  });

  it('is put in its template, whose head names the page and loads nothing from elsewhere', () => {
    const template = read('../../changelog/index.html');
    const page = renderChangelogPage(template, entries);

    assert.match(page, /<title>Changelog — Webhook Inspector<\/title>/);
    assert.match(page, /<meta\s+name="description"\s+content="[^"]{40,}"/);
    assert.ok(page.includes('<link rel="canonical" href="https://qa-tools.ru/changelog" />'));
    // Without a script the toolbar, whose controls would do nothing, is hidden.
    assert.match(
      page,
      /<noscript\s*>\s*<style>\s*\[data-toolbar\]\s*\{\s*display: none;\s*\}\s*<\/style>\s*<\/noscript\s*>/,
    );
    // Only the canonical address names the site; nothing is loaded from any.
    assert.doesNotMatch(template, /src="(?:https?:)?\/\//);
    assert.doesNotMatch(template, /<link rel="(?!canonical")[^"]*"[^>]*href="(?:https?:)?\/\//);
    assert.ok(page.includes(body));
    assert.throws(
      () => renderChangelogPage('<body></body>', entries),
      /no <!-- changelog:page -->/,
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

describe('the changelog locations in nginx.conf', () => {
  it('serve the page for /changelog and /changelog/, never the application shell', () => {
    for (const address of ['/changelog', '/changelog/']) {
      assert.equal(location(address), 'rewrite ^ /changelog/index.html last;');
    }
  });

  it('revalidate the page on every use, send no X-Robots-Tag, and refuse it by name', () => {
    assert.equal(
      location('/changelog/index.html'),
      [
        'internal;',
        "add_header Cache-Control 'no-cache' always;",
        'error_page 404 /index.html;',
      ].join('\n'),
    );
  });

  it('serve /changelog.md as UTF-8 Markdown, revalidated, a missing file a plain 404', () => {
    assert.equal(
      location('/changelog.md'),
      [
        'types { }',
        'default_type text/markdown;',
        'charset utf-8;',
        'charset_types text/markdown;',
        "add_header Cache-Control 'no-cache' always;",
        'try_files $uri =404;',
      ].join('\n'),
    );
  });

  it('serve both feeds as UTF-8 Atom, revalidated, a missing file a plain 404 (D212)', () => {
    for (const address of [FEED_PATH, BREAKING_FEED_PATH]) {
      assert.equal(
        location(address),
        [
          'types { }',
          'default_type application/atom+xml;',
          'charset utf-8;',
          'charset_types application/atom+xml;',
          "add_header Cache-Control 'no-cache' always;",
          'try_files $uri =404;',
        ].join('\n'),
      );
    }

    // Compressed like the text; a neighbour such as /changelog.xmll has no
    // location of its own and is an unknown address (D146).
    assert.match(read('../../nginx.conf'), /gzip_types [^;]*application\/atom\+xml/);
    assert.doesNotMatch(read('../../nginx.conf'), /location (?:~|\^~|=)?\s*\/changelog\.xml[^ ]/);
  });
});

describe('the dev server', () => {
  it('serves the same five addresses, from the same module', () => {
    const config = read('../../vite.config.ts');

    assert.ok(config.includes("path === '/changelog' || path === '/changelog/'"));
    assert.ok(config.includes("req.url = '/changelog/index.html';"));
    assert.ok(config.includes("path === '/changelog.md'"));
    assert.ok(config.includes('path === FEED_PATH || path === BREAKING_FEED_PATH'));
    assert.ok(
      config.includes("changelogFeed(readChangelog(), path === FEED_PATH ? 'all' : 'breaking')"),
    );
    assert.ok(
      config.includes("res.setHeader('Content-Type', 'application/atom+xml; charset=utf-8');"),
    );
    assert.match(config, /plugins: \[[^\]]*changelogPagePlugin\(\)/);
  });
});

describe('the frontend image', () => {
  it('builds from a context that holds CHANGELOG.md, and copies it before the build', () => {
    const ignored = read('../../../../.dockerignore')
      .split('\n')
      .map((line) => line.trim());
    const dockerfile = read('../../Dockerfile');

    assert.ok(ignored.indexOf('!CHANGELOG.md') > ignored.indexOf('*.md'));
    assert.ok(dockerfile.indexOf('COPY CHANGELOG.md ./') >= 0);
    assert.ok(dockerfile.indexOf('COPY CHANGELOG.md ./') < dockerfile.indexOf('RUN npm run build'));
  });

  it('builds the page, the text and the feeds in npm run build, before the build check', () => {
    const build = JSON.parse(read('../../package.json')).scripts.build as string;

    assert.ok(build.includes('vite build --config vite.changelog.config.ts'));
    assert.ok(build.includes('node scripts/build-changelog.mjs'));
    assert.ok(build.indexOf('build-changelog.mjs') < build.indexOf('check-build.mjs'));
  });
});

describe('the build check', () => {
  function problems(
    files: Record<string, string>,
    changelog: ChangelogEntry[] = entries,
  ): string[] {
    const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-dist-'));

    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dist, name)), { recursive: true });
      writeFileSync(join(dist, name), text);
    }

    try {
      return (checkBuild(dist, new Date(), changelog) as string[]).filter((problem) =>
        /changelog/.test(problem),
      );
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  }

  const page = (inner: string) =>
    `<html><head><script src="/assets/changelog-AAAAAAAA.js"></script></head><body>${inner}</body></html>`;

  /** The two feeds as the build writes them from `changelog`. */
  const feeds = (changelog: ChangelogEntry[] = entries) => ({
    'changelog.xml': changelogFeed(changelog, 'all'),
    'changelog-breaking.xml': changelogFeed(changelog, 'breaking'),
  });

  it('passes the page, the text and the feeds as the build writes them', () => {
    assert.deepEqual(
      problems({
        'changelog/index.html': page(body),
        'assets/changelog-AAAAAAAA.js': '',
        'changelog.md': markdown,
        ...feeds(),
      }),
      [],
    );
  });

  it('fails when any of them is missing or empty', () => {
    assert.deepEqual(problems({ 'changelog.md': '', 'changelog.xml': '' }), [
      'the changelog page changelog/index.html was not built',
      'the changelog text changelog.md was not built',
      'the changelog feed changelog.xml was not built',
      'the changelog feed changelog-breaking.xml was not built',
    ]);
  });

  it('fails when the page lists no version, or either publishes a reference', () => {
    assert.deepEqual(
      problems({
        'changelog/index.html': page('<p>See #97.</p>'),
        'assets/changelog-AAAAAAAA.js': '',
        'changelog.md': '# QA Tools — Changelog\n\nAs D184 says.\n',
        ...feeds(),
      }),
      [
        'changelog.md publishes a decision reference: …# QA Tools — Changelog\n\nAs D184 says.\n…',
        'the changelog page changelog/index.html lists no version',
        'changelog/index.html publishes an issue reference: …See #97.…',
      ],
    );
  });

  it('fails the page when a comment in its source names a decision or an issue', () => {
    // The page text leaves comments out; the source a reader can open does not.
    assert.deepEqual(
      problems({
        'changelog/index.html': page(
          `<!-- The two Atom feeds (D212), which a feed reader finds here. -->${body}<!--\n  as #133\n  asked -->`,
        ),
        'assets/changelog-AAAAAAAA.js': '',
        'changelog.md': markdown,
        ...feeds(),
      }),
      [
        'changelog/index.html publishes in a comment a decision reference: …The two Atom feeds (D212), which a feed reader finds h…',
        'changelog/index.html publishes in a comment an issue reference: …as #133 asked…',
      ],
    );
  });

  it('fails a comment that names an issue in the source of any page the build writes', () => {
    const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-dist-'));

    for (const file of COMMENTED_PAGES as string[]) {
      mkdirSync(dirname(join(dist, file)), { recursive: true });
      writeFileSync(
        join(dist, file),
        '<html><head><!-- as #1 asked --></head><body></body></html>',
      );
    }

    try {
      assert.deepEqual(
        (checkBuild(dist, new Date(), []) as string[]).filter((problem) =>
          problem.includes(' in a comment '),
        ),
        (COMMENTED_PAGES as string[]).map(
          (file) => `${file} publishes in a comment an issue reference: …as #1 asked…`,
        ),
      );
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  /** As many problems as a page or a feed gives here: one `push(...list)` of them overflows the stack. */
  const MANY = 200_000;
  const MANY_COMMENTS = '<!-- #1 -->'.repeat(MANY);
  const COMMENT_PROBLEM = 'changelog/index.html publishes in a comment an issue reference: …#1…';

  it(`lists all ${MANY.toLocaleString('en')} problems of a page's comments and of a feed's entries`, () => {
    const found = problems(
      {
        'changelog/index.html': MANY_COMMENTS,
        'changelog.xml': `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">${'<entry><id>x</id></entry>'.repeat(MANY)}</feed>\n`,
      },
      [],
    );
    const counted = (problem: string) => found.filter((item) => item === problem).length;

    assert.equal(counted(COMMENT_PROBLEM), MANY);
    assert.equal(counted('the changelog feed changelog.xml has an incomplete entry x'), MANY);
  });

  it(`prints all ${MANY.toLocaleString('en')} from the command line and exits 1`, () => {
    const script = fileURLToPath(new URL('../../scripts/check-build.mjs', import.meta.url));
    const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-dist-'));

    mkdirSync(join(dist, 'changelog'));
    writeFileSync(join(dist, 'changelog', 'index.html'), MANY_COMMENTS);

    try {
      const run = spawnSync(process.execPath, [script, dist], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });

      assert.equal(run.status, 1, run.stderr.slice(-2_000));
      assert.doesNotMatch(run.stderr, /RangeError|\n {4}at /);
      assert.equal(
        run.stderr.split('\n').filter((line) => line === `  - ${COMMENT_PROBLEM}`).length,
        MANY,
      );
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }

    // Exiting at once would drop what a pipe has not taken yet and cut the
    // list off, which spawnSync, reading as fast as it is written, cannot see.
    const source = readFileSync(script, 'utf8');

    assert.ok(source.includes('process.exitCode = 1;'));
    assert.ok(!source.includes('process.exit('));
  });

  it('fails a feed that is not well-formed, not Atom, or carries other versions (D212)', () => {
    const all = changelogFeed(entries, 'all');
    const versions = entries.map((entry) => entry.version);
    assert.deepEqual(changelogFeedProblems('changelog.xml', all, versions), []);
    assert.deepEqual(changelogFeedProblems('changelog.xml', all.replace('</feed>', ''), versions), [
      'the changelog feed changelog.xml is not well-formed XML',
    ]);
    assert.deepEqual(
      changelogFeedProblems(
        'changelog.xml',
        '<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0"><channel/></rss>\n',
        versions,
      ),
      ['the changelog feed changelog.xml is not an Atom feed'],
    );
    // One version short, and two versions the other way round.
    for (const expected of [
      versions.slice(1),
      [versions[1], versions[0], ...versions.slice(2)] as string[],
    ]) {
      assert.equal(
        changelogFeedProblems('changelog.xml', all, expected)[0],
        `the changelog feed changelog.xml carries ${versions.length} entries, not the ${expected.length} versions it should, newest first`,
      );
    }
  });

  it('fails a feed entry without its link, or one that publishes a reference (D212)', () => {
    const all = changelogFeed(entries, 'all');
    const versions = entries.map((entry) => entry.version);
    const newest = versions[0] as string;

    assert.deepEqual(
      changelogFeedProblems(
        'changelog.xml',
        all.replace(`href="${CHANGELOG_URL}#v${newest}"`, `href="${CHANGELOG_URL}"`),
        versions,
      ),
      [`the changelog feed changelog.xml has an incomplete entry ${feedEntryId(newest)}`],
    );

    const leaking = parseChangelog(sample('2026-09-21\n\n**It changed.** As #97 asked.'));
    const leakingProblems = changelogFeedProblems(
      'changelog.xml',
      changelogFeed(leaking, 'all'),
      leaking.map((entry) => entry.version),
    );

    assert.equal(leakingProblems.length, 1);
    assert.match(
      leakingProblems[0] as string,
      /^changelog\.xml publishes an issue reference: …[\s\S]*As #97 asked\.…$/,
    );
  });

  it('checks a test build of a sample entry with a Deprecated paragraph into the breaking feed (D212)', () => {
    const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-dist-'));
    const source = join(dist, 'CHANGELOG.md');

    writeFileSync(
      source,
      sample(
        '2026-09-21\n\n**It changed.**\n\n**Deprecated:** `GET /api/old` is removed on or after 2026-11-01; use `GET /api/new` (#1).',
        '2026-09-20\n\n**It started.**',
      ),
    );

    try {
      const output = execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL('../../scripts/build-changelog.mjs', import.meta.url)),
          dist,
          source,
        ],
        { encoding: 'utf8' },
      );
      const breaking = readFileSync(join(dist, 'changelog-breaking.xml'), 'utf8');
      const sampleEntries = parseChangelog(readFileSync(source, 'utf8'));

      assert.match(output, /wrote changelog-breaking\.xml, 1 entries/);
      assert.deepEqual(
        readFeedEntries(breaking).map((entry) => entry.id),
        [feedEntryId('0.2.0')],
      );
      assert.ok(readFeedEntries(breaking)[0]?.content?.includes('<strong>Deprecated:</strong>'));
      assert.deepEqual(
        readFeedEntries(readFileSync(join(dist, 'changelog.xml'), 'utf8')).map((entry) => entry.id),
        [feedEntryId('0.2.0'), feedEntryId('0.1.0')],
      );
      assert.deepEqual(changelogFeedProblems('changelog-breaking.xml', breaking, ['0.2.0']), []);
      assert.ok(sampleEntries[0] && hasNotice(sampleEntries[0]));
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('checks a test build of a sample entry with a Notice paragraph into the breaking feed (D224)', () => {
    const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-dist-'));
    const source = join(dist, 'CHANGELOG.md');

    writeFileSync(
      source,
      sample(
        '2026-09-21\n\n**The terms are announced.**\n\n**Notice:** from 2026-10-05 a new version of the Terms of Use applies (#1, D224).',
        '2026-09-20\n\n**It started.**',
      ),
    );

    try {
      const output = execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL('../../scripts/build-changelog.mjs', import.meta.url)),
          dist,
          source,
        ],
        { encoding: 'utf8' },
      );
      const breaking = readFileSync(join(dist, 'changelog-breaking.xml'), 'utf8');
      const sampleEntries = parseChangelog(readFileSync(source, 'utf8'));
      const [carried] = readFeedEntries(breaking);

      assert.match(output, /wrote changelog-breaking\.xml, 1 entries/);
      assert.deepEqual(
        readFeedEntries(breaking).map((entry) => entry.id),
        [feedEntryId('0.2.0')],
      );
      assert.equal(
        carried?.content,
        '<p><strong>The terms are announced.</strong></p><p><strong>Notice:</strong> from 2026-10-05 a new version of the Terms of Use applies.</p>',
      );
      assert.deepEqual(
        readFeedEntries(readFileSync(join(dist, 'changelog.xml'), 'utf8')).map((entry) => entry.id),
        [feedEntryId('0.2.0'), feedEntryId('0.1.0')],
      );
      assert.deepEqual(changelogFeedProblems('changelog-breaking.xml', breaking, ['0.2.0']), []);
      assert.deepEqual(
        sampleEntries.map((entry) => [entry.notice, entry.deprecated, entry.breaking]),
        [
          [true, false, false],
          [false, false, false],
        ],
      );
      // The published text keeps the mark and drops the reference.
      assert.ok(
        readFileSync(join(dist, 'changelog.md'), 'utf8').includes(
          '\n\n**Notice:** from 2026-10-05 a new version of the Terms of Use applies.\n',
        ),
      );
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe('the sitemap', () => {
  it('offers the changelog to search engines', () => {
    assert.ok(
      read('../../public/sitemap.xml').includes('<loc>https://qa-tools.ru/changelog</loc>'),
    );
  });
});

/** L2′, with `Status ↗` between `Changelog` and `API docs ↗` since D209 (status-link.test.ts). */
describe('the header on every page (L2′)', () => {
  const header = read('../components/AppHeader.tsx');

  it('points Changelog at the page nginx serves, in the same tab', () => {
    assert.equal(CHANGELOG_LINK.href, '/changelog');
    assert.equal(CHANGELOG_LINK.label, 'Changelog');
    assert.ok(!('target' in CHANGELOG_LINK));
  });

  it('shows Changelog, a divider and API docs, in that order, at every width', () => {
    const changelog = header.indexOf('href={CHANGELOG_LINK.href}');
    const divider = header.indexOf('<span aria-hidden="true" className="h-4 w-px bg-line" />');
    const apiDocs = header.indexOf('href={API_DOCS_LINK.href}');

    assert.ok(changelog > 0 && changelog < divider && divider < apiDocs);
    // The interface's word for it; the constant's is the English one (D222).
    assert.ok(header.includes('{m.header.changelog}'));
    assert.equal(CHANGELOG_LINK.label, 'Changelog');
    // A plain link: `/changelog` is not a route of the application.
    assert.doesNotMatch(header, /<Link\s[^>]*CHANGELOG_LINK/);
    // Nothing on the right is hidden on a phone any more but the language
    // switch and its divider, which are in the footer band there (D222).
    assert.deepEqual(header.match(/max-md:hidden/g), ['max-md:hidden', 'max-md:hidden']);
    assert.match(header, /<LanguageSwitch place="header" className="max-md:hidden" \/>/);
    assert.equal(API_DOCS_LINK.href, '/docs');
  });

  it('no longer names the tool beside the wordmark, which is the service\u2019s name since D277', () => {
    const code = header.replace(/\/\*[\s\S]*?\*\//g, '');

    // Once, as the wordmark's words; no tool name and divider after it (D184).
    assert.equal(code.split('Webhook Inspector').length - 1, 1);
    assert.match(code, /<span className="[^"]*">\s*Webhook Inspector\s*<\/span>\s*<img\s/);
  });

  it('is the one header every page renders', () => {
    for (const file of [
      '../pages/LandingPage.tsx',
      '../pages/SessionPage.tsx',
      '../components/NotFound.tsx',
      '../components/SessionUnavailable.tsx',
    ]) {
      assert.match(read(file), /<AppHeader \/>/, file);
    }
  });
});

/** The two Atom feeds (RFC 4287, D212), as the build writes them from `CHANGELOG.md`. */
describe('the feeds', () => {
  const all = changelogFeed(entries, 'all');
  const breaking = changelogFeed(entries, 'breaking');

  it('are well-formed Atom documents, in Atom’s namespace, naming themselves and the page', () => {
    for (const [feed, path, id, title, subtitle] of [
      [
        all,
        FEED_PATH,
        'tag:qa-tools.ru,2026:changelog',
        'Webhook Inspector — Changelog',
        'What changed in each version of Webhook Inspector, newest first.',
      ],
      [
        breaking,
        BREAKING_FEED_PATH,
        'tag:qa-tools.ru,2026:changelog-breaking',
        'Webhook Inspector — Breaking changes and deprecations',
        // It names the notices of a change to the terms it carries too (D224).
        'The versions of Webhook Inspector with a change that can break an API client, a deprecation, or a notice of a change to the Terms of Use or the Privacy Policy, newest first.',
      ],
    ] as const) {
      assert.ok(isWellFormedXml(feed), path);
      assert.ok(
        feed.startsWith(
          '<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">\n',
        ),
      );
      assert.ok(feed.endsWith('</feed>\n'));
      // RFC 4287 4.1.1: a feed has an id, a title, an updated and an author.
      const head = feed.slice(0, feed.indexOf('<entry>'));

      assert.ok(head.includes(`  <id>${id}</id>\n`));
      assert.ok(head.includes(`  <title>${title}</title>\n`));
      assert.ok(head.includes(`  <subtitle>${subtitle}</subtitle>\n`), path);
      assert.ok(
        head.includes(`  <author><name>QA Tools</name><uri>https://qa-tools.ru/</uri></author>\n`),
      );
      assert.ok(
        head.includes(
          `  <link rel="self" type="application/atom+xml" href="https://qa-tools.ru${path}"/>\n`,
        ),
      );
      assert.ok(
        head.includes(
          '  <link rel="alternate" type="text/html" href="https://qa-tools.ru/changelog"/>\n',
        ),
      );
    }
  });

  it('carry one entry per version, newest first: every version, or only those with a Breaking, Deprecated or Notice paragraph', () => {
    assert.deepEqual(
      readFeedEntries(all).map((entry) => entry.id),
      entries.map((entry) => feedEntryId(entry.version)),
    );
    // The Deprecated entries, the move of the inspector's addresses (D275)
    // and the one announcing new enum values (D248), taken as found: their
    // versions are set at the merge.
    const announcing = entries.filter((entry) => entry.deprecated).at(-1)?.version as string;

    assert.ok(announcing);
    assert.ok(mailMove);
    assert.ok(hostMove);
    assert.ok(oldNames);
    assert.deepEqual(
      readFeedEntries(breaking).map((entry) => entry.id),
      [
        oldNames.version,
        hostMove.version,
        mailMove.version,
        announcing,
        '1.0.11',
        '1.0.8',
        '0.57.3',
        '0.57.1',
        '0.52.1',
        '0.49.1',
        '0.46.0',
        '0.43.0',
        '0.38.0',
        '0.36.0',
        '0.32.0',
        '0.29.0',
        '0.26.0',
        '0.24.2',
      ].map(feedEntryId),
    );
    assert.deepEqual(
      readFeedEntries(breaking).map((entry) => entry.id),
      entries.filter(hasNotice).map((entry) => feedEntryId(entry.version)),
    );
    // The feed's updated is its newest entry's day.
    assert.ok(all.includes(`  <updated>${entries[0]?.date}T00:00:00Z</updated>\n  <author>`));
    assert.ok(
      breaking.includes(
        `  <updated>${entries.find(hasNotice)?.date}T00:00:00Z</updated>\n  <author>`,
      ),
    );
  });

  it('give each entry its version’s id, the version and headline, its day, its line on the page and its text', () => {
    for (const [index, item] of readFeedEntries(all).entries()) {
      const entry = entries[index] as ChangelogEntry;

      assert.equal(item.id, `tag:qa-tools.ru,2026:changelog/${entry.version}`);
      assert.equal(item.title, `${entry.version} — ${plainText(entry.headline)}`);
      assert.equal(item.updated, `${entry.date}T00:00:00Z`);
      assert.equal(item.link, `https://qa-tools.ru/changelog#v${entry.version}`);
      assert.ok(body.includes(`<details class="version" id="v${entry.version}"`));
      assert.equal(item.content, entryHtml(entry));
    }

    // The headline's code reads as text in the title, and the content is the
    // page's HTML: `/about` in 0.50.0, `<session-id>` escaped where it occurs.
    const about = readFeedEntries(all).find((item) => item.id === feedEntryId('0.50.0'));

    assert.match(about?.title ?? '', /^0\.50\.0 — A new page, \/about, says who runs QA Tools/);
    assert.ok(about?.content?.startsWith('<p><strong>A new page, <code>/about</code>, says'));
    assert.equal(plainText('A `<id>` and **bold** `a`, `b`.'), 'A <id> and bold a, b.');
  });

  it('name another address in a build for it, every link but the ids, which are kept (D274)', () => {
    // The text and the feeds as build-changelog.mjs writes them for the copy
    // (#354), in a process of its own whose environment names it.
    const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-dist-'));
    const built = (file: string) => readFileSync(join(dist, file), 'utf8');

    try {
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('../../scripts/build-changelog.mjs', import.meta.url)), dist],
        {
          env: {
            ...process.env,
            APP_ORIGIN: ANOTHER.app,
            RECEIVE_ORIGIN: ANOTHER.receive,
            APP_ALIAS_ORIGIN: '',
          },
          encoding: 'utf8',
        },
      );

      // The changelog as that build publishes it (#343), which the feeds carry.
      const published = readChangelog(CHANGELOG_SOURCE, ANOTHER);

      for (const [path, carried] of [
        [FEED_PATH, published],
        [BREAKING_FEED_PATH, published.filter(hasNotice)],
      ] as const) {
        const feed = built(path.slice(1));
        const head = feed.slice(0, feed.indexOf('<entry>'));
        const items = readFeedEntries(feed);

        assert.ok(isWellFormedXml(feed), path);
        assert.ok(
          head.includes(
            `  <link rel="self" type="application/atom+xml" href="${ANOTHER.app}${path}"/>\n`,
          ),
          path,
        );
        assert.ok(
          head.includes(
            `  <link rel="alternate" type="text/html" href="${ANOTHER.app}/changelog"/>\n`,
          ),
          path,
        );
        assert.ok(head.includes(`<uri>${ANOTHER.app}/</uri>`), path);
        assert.ok(head.includes(`  <icon>${ANOTHER.app}/favicon-192.png</icon>\n`), path);
        assert.ok(items.length > 0, path);
        // Each entry's id is production's, the permanent one; its link is the copy's.
        assert.deepEqual(
          items.map((item) => item.id),
          carried.map((entry) => feedEntryId(entry.version)),
          path,
        );
        for (const [index, item] of items.entries()) {
          assert.equal(item.link, `${ANOTHER.app}/changelog#v${carried[index]?.version}`, item.id);
        }
        assert.deepEqual(productionNamesLeft(feed, ANOTHER), [], path);
      }

      assert.deepEqual(
        readFeedEntries(built('changelog.xml')).map((item) => item.id),
        readFeedEntries(all).map((item) => item.id),
      );

      assert.ok(
        built('changelog.md').includes(`The same text is a page at ${ANOTHER.app}/changelog.`),
      );
      assert.deepEqual(productionNamesLeft(built('changelog.md'), ANOTHER), []);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('keep every id across builds, a new version only adding one', () => {
    const later = parseChangelog(
      source.replace(
        /\n## /,
        `\n## 9.0.1\n\n2099-01-02\n\n**A later notice.**\n\n**Notice:** the terms change on 2099-02-01.\n\n## 9.0.0\n\n2099-01-01\n\n**A later version.**\n\n**Deprecated:** something, on or after 2099-02-01.\n\n## `,
      ),
    );
    const ids = (feed: string) => readFeedEntries(feed).map((entry) => entry.id);

    assert.equal(changelogFeed(readChangelog(), 'all'), all, 'the same source gave other bytes');
    assert.deepEqual(ids(changelogFeed(later, 'all')), [
      feedEntryId('9.0.1'),
      feedEntryId('9.0.0'),
      ...ids(all),
    ]);
    assert.deepEqual(ids(changelogFeed(later, 'breaking')), [
      feedEntryId('9.0.1'),
      feedEntryId('9.0.0'),
      ...ids(breaking),
    ]);
  });

  it('publish no issue or decision reference, no path and no infrastructure name', () => {
    for (const feed of [all, breaking]) {
      for (const item of readFeedEntries(feed)) {
        assert.deepEqual(
          publishedTextProblems(`${item.title}\n${pageText(item.content ?? '')}`),
          [],
          item.id,
        );
      }
    }

    assert.ok(!/\(#\d+|D\d{3}\)/.test(all), 'a reference parenthesis reached the feed');
  });

  it('refuse an unknown kind and an empty changelog', () => {
    // @ts-expect-error -- not a feed this module writes.
    assert.throws(() => changelogFeed(entries, 'rss'), /no changelog feed "rss"/);
    assert.throws(() => changelogFeed([], 'all'), /at least one version/);
    // A breaking feed of a changelog with nothing breaking is still a feed,
    // dated by the newest version.
    const quiet = parseChangelog(sample('2026-09-21\n\n**It changed.**'));
    const feed = changelogFeed(quiet, 'breaking');

    assert.ok(isWellFormedXml(feed));
    assert.deepEqual(readFeedEntries(feed), []);
    assert.ok(feed.includes('<updated>2026-09-21T00:00:00Z</updated>'));
  });
});

/**
 * Made-up input built to break the feed writer and its reader, small and
 * large: the markup characters, a CDATA end, closing tags, references and
 * characters XML 1.0 cannot carry, in every text an entry has, and changelogs
 * of thousands of versions. Each must still give a well-formed feed whose
 * entries read back as written. No test reads a clock, which a loaded runner
 * can miss without a defect: the runner's timeout is the only bound on time.
 */
describe('the feeds against hostile input', () => {
  const HOSTILE = [
    '<',
    '>',
    '&',
    '"',
    "'",
    ']]>',
    '<![CDATA[x]]>',
    '</content></entry><entry>',
    '</feed>',
    '<?xml version="1.0"?>',
    '<!DOCTYPE feed>',
    '&amp;',
    '&lt;',
    '&#0;',
    '&#x110000;',
    '&unknown;',
    '\u0000',
    '\u0001',
    '\u0008',
    '\u000B',
    '\u000C',
    '\u001F',
    '￾',
    '￿',
    '\uD800',
    '\uDFFF',
    '􏿿',
    '😀',
    ' ',
    '\t\r\n',
    'é',
    '`',
    '**',
    '<script>alert(1)</script>',
  ];

  /** What XML can carry of a text: every character it cannot replaced by U+FFFD. */
  const carried = (text: string) => text.replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '�');

  it('escapes text so that it reads back as written, but for what XML cannot carry', () => {
    for (const text of [...HOSTILE, HOSTILE.join(''), HOSTILE.join(' ')]) {
      const escaped = escapeXml(text);

      assert.doesNotMatch(escaped, /[<>"]|&(?!(?:amp|lt|gt|quot);)/, JSON.stringify(text));
      assert.equal(unescapeXml(escaped), carried(text), JSON.stringify(text));
      assert.ok(isWellFormedXml(`<a b="${escaped}">${escaped}</a>`), JSON.stringify(text));
    }
  });

  it('gives a well-formed feed of hostile entries, each read back as written', () => {
    // Built directly, so that what the parser would refuse reaches the writer too.
    const hostile: ChangelogEntry[] = HOSTILE.map((text, index) => ({
      version: `0.${HOSTILE.length - index}.0`,
      date: '2026-09-21',
      headline: `Headline ${text} here.`,
      lead: `Lead ${text}.`,
      paragraphs: [`**Breaking:** ${text} broke.`, `**Notice:** ${text} applies.`, `More ${text}.`],
      breaking: true,
      deprecated: index % 2 === 0,
      notice: true,
    }));

    for (const kind of ['all', 'breaking'] as const) {
      const feed = changelogFeed(hostile, kind);
      const read = readFeedEntries(feed);

      assert.ok(isWellFormedXml(feed), kind);
      assert.equal(read.length, hostile.length, kind);

      for (const [index, item] of read.entries()) {
        const entry = hostile[index] as ChangelogEntry;

        assert.equal(item.id, feedEntryId(entry.version));
        assert.equal(item.content, carried(entryHtml(entry)));
        assert.equal(item.title, carried(`${entry.version} — ${plainText(entry.headline)}`));
      }
    }
  });

  for (const size of [1_000, 1_000_000]) {
    it(`escapes, writes and reads ${size.toLocaleString('en')} characters of each`, () => {
      for (const unit of ['<&>"', ']]>', '\u0000\uD800', '😀', '&amp;']) {
        const text = unit.repeat(Math.ceil(size / unit.length));
        const escaped = escapeXml(text);

        assert.equal(unescapeXml(escaped), carried(text), `${unit} × ${size}`);
        assert.ok(isWellFormedXml(`<a>${escaped}</a>`), `${unit} × ${size}`);
      }

      const long = parseChangelog(
        sample(`2026-09-21\n\n**Long.** ${'<b>&amp;</b> ]]> '.repeat(size / 20)}`),
      );
      const feed = changelogFeed(long, 'all');

      assert.ok(isWellFormedXml(feed), `an entry of ${size}`);
      assert.equal(readFeedEntries(feed)[0]?.content, entryHtml(long[0] as ChangelogEntry));
    });

    it(`reads a broken feed of ${size.toLocaleString('en')} characters`, () => {
      for (const [broken, count] of [
        ['<entry>'.repeat(size / 7), 0],
        [`<entry>${'<id>'.repeat(size / 4)}`, 0],
        [`${'<entry><id>x</id></entry>'.repeat(size / 25)}<entry>`, size / 25],
        ['&'.repeat(size), 0],
        ['&#x'.repeat(size / 3), 0],
      ] as const) {
        assert.equal(readFeedEntries(broken).length, count, broken.slice(0, 20));
        assert.equal(unescapeXml(broken), broken, broken.slice(0, 20));
      }
    });
  }

  for (const count of [10, 5_000]) {
    it(`writes and reads a changelog of ${count.toLocaleString('en')} versions`, () => {
      const versions = Array.from(
        { length: count },
        (_, index) =>
          `## 1.${count - index}.0\n\n2026-09-21\n\n**Version ${count - index} & <more>.**${index % 2 === 0 ? '\n\n**Deprecated:** a part, on or after 2026-12-01.' : ''}${index % 10 === 1 ? '\n\n**Notice:** the terms <change> & more on 2026-12-01.' : ''}`,
      );
      const many = parseChangelog(`# Header\n\n${versions.join('\n\n')}\n`);
      // Every other version is deprecating, from the first, and every tenth a
      // notice, from the second; those are odd, so none is both.
      const notices = Math.floor((count + 8) / 10);
      const carried = Math.ceil(count / 2) + notices;

      assert.equal(many.filter((entry) => entry.notice).length, notices);
      assert.equal(many.filter((entry) => entry.notice && entry.deprecated).length, 0);

      for (const [kind, expected] of [
        ['all', count],
        ['breaking', carried],
      ] as const) {
        const feed = changelogFeed(many, kind);

        assert.ok(isWellFormedXml(feed));
        assert.equal(readFeedEntries(feed).length, expected);
        assert.equal(
          changelogFeedProblems(
            `${kind}.xml`,
            feed,
            many.filter(kind === 'all' ? () => true : hasNotice).map((entry) => entry.version),
          ).length,
          0,
        );
      }
    });
  }

  it('decodes only the five entities and character references, once', () => {
    assert.equal(
      unescapeXml('&amp;lt; &lt;&gt;&quot;&apos; &#65;&#x42; &unknown; &#x110000; &#;'),
      '&lt; <>"\' AB &unknown; &#x110000; &#;',
    );
  });
});

/**
 * Made-up pages built to break the build check's comment reader, small and
 * large: comments closed, empty, closed at once, nested, never closed, and
 * stray closings. Each is read as a browser reads it; as above, no test reads
 * a clock.
 */
describe('the comment reader against hostile input', () => {
  it('reads the comments of a page as a browser does, the broken ones too', () => {
    for (const [html, comments] of [
      ['', []],
      ['<p>no comment</p>', []],
      ['-->', []],
      ['<!---->', ['']],
      ['<!-->x', ['']],
      ['<!--->x', ['']],
      ['<!-- a -->b<!-- c -->', [' a ', ' c ']],
      ['<!-- a <!-- b --> c -->', [' a <!-- b ']],
      ['<!-- a -- b --->', [' a -- b -']],
      ['<!-- D212', [' D212']],
      ['x<!--', ['']],
    ] as const) {
      assert.deepEqual(pageComments(html), comments, html);
    }

    assert.deepEqual(
      pageCommentProblems('docs/index.html', '<!-- D212 --><!-- #1 --><!-- D21 -->'),
      [
        'docs/index.html publishes in a comment a decision reference: …D212…',
        'docs/index.html publishes in a comment an issue reference: …#1…',
      ],
    );
  });

  for (const size of [1_000, 1_000_000]) {
    it(`reads the comments of a page of ${size.toLocaleString('en')} characters`, () => {
      for (const [html, count] of [
        ['<!--'.repeat(size / 4), 1],
        [`<!--${'-'.repeat(size)}`, 1],
        ['<!-->'.repeat(size / 5), size / 5],
        ['<!---->'.repeat(Math.floor(size / 7)), Math.floor(size / 7)],
        ['-->'.repeat(Math.floor(size / 3)), 0],
        [`${'<!-- '.repeat(size / 5)}-->`, 1],
        ['<!-- #1 D212 -->'.repeat(Math.floor(size / 16)), Math.floor(size / 16)],
      ] as const) {
        assert.equal(pageComments(html).length, count, `${html.slice(0, 20)} × ${size}`);
        pageCommentProblems('changelog/index.html', html);
      }
    });
  }
});

/**
 * The notice of the end of the old stable names (#334, D279): one Deprecated
 * paragraph naming each old name and its replacement and one stop day, 30
 * days after the entry's day - 31 when the deployment completes after the
 * Moscow day has turned - since #319's day X falls sooner. The stop day is
 * named there and in the decision alone: `/docs`, the agent guide, the relay
 * script and `docs/API.md` point to the entry.
 */
describe('the notice of the end of the old names (#334, D279)', () => {
  const paragraph = () =>
    oldNames?.paragraphs.find((each) => each.startsWith(OLD_NAMES_OPENING)) ?? '';
  const stopDay = () =>
    /\bFrom (\d{4}-\d{2}-\d{2}) the old header is no longer sent\b/.exec(paragraph())?.[1];

  it('names one stop day, at least 30 days after the entry’s and at most 31, in one Deprecated paragraph', () => {
    assert.ok(oldNames, 'no entry announces the end of the old names');
    assert.equal(
      oldNames.paragraphs.filter((each) => each.startsWith('**Deprecated:**')).length,
      1,
    );
    assert.equal(oldNames.breaking, false);

    const day = stopDay();

    assert.ok(day, 'the paragraph names no stop day');

    const days =
      (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${oldNames.date}T00:00:00Z`)) / 86_400_000;

    assert.ok(
      days >= 30 && days <= 31,
      `the stop day ${day} is ${days} days after ${oldNames.date}`,
    );
    assert.deepEqual(paragraph().match(/\b\d{4}-\d{2}-\d{2}\b/g), [day]);
  });

  it('names each old name, its replacement, what happens on the day, and the relay’s User-Agent', () => {
    const text = paragraph();

    for (const part of [
      '`X-Webhook-Inspector-Request-Id`, `webhook-inspector` and `webhook-inspector.access-key.<key>`, `webhook-inspector-relay.mjs` and `WEBHOOK_INSPECTOR_ACCESS_KEY`, and `Captured by Webhook Inspector`',
      'the old header is no longer sent',
      'the old subprotocols are no longer taken',
      'the relay script is served only as `webhook-inspector-relay.mjs` and reads only `WEBHOOK_INSPECTOR_ACCESS_KEY`',
      "the default answer's `message` reads `Captured by Webhook Inspector`",
      'User-Agent `webhook-inspector-relay` from this release, where it sent the User-Agent `qa-tools-relay`',
    ]) {
      assert.ok(text.includes(part), part);
    }
  });

  it('is the one place outside the decisions that names the stop day', () => {
    const day = stopDay();

    assert.ok(day);

    const changelog = readFileSync(new URL('../../../../CHANGELOG.md', import.meta.url), 'utf8');

    assert.equal(changelog.split(day).length - 1, 1, 'CHANGELOG.md names the stop day once');
    for (const path of [
      '../../../../packages/shared/openapi.json',
      '../../../../packages/shared/src/index.ts',
      '../../../../docs/API.md',
      '../../../../docs/ARCHITECTURE.md',
      '../../../../docs/PRODUCT.md',
      '../../../../README.md',
      '../../llms/agent-section.md',
      '../../llms/llms.txt',
      '../../public/webhook-inspector-relay.mjs',
    ]) {
      assert.ok(
        !readFileSync(new URL(path, import.meta.url), 'utf8').includes(day),
        `${path} names the stop day`,
      );
    }
    // D279, in the decision log kept outside this repository, names it too.
  });
});

/**
 * The notice of the move of Webhook Inspector's addresses to
 * `https://webhook.qa-tools.ru` (#319, D275): one Deprecated paragraph naming
 * day X, at least 30 days after the entry's day - 30 by the merge day, 31 when
 * the deployment completes after the Moscow day has turned - and what happens
 * then. Its date is named there and in the decision alone: `/docs`, the agent
 * guide and `docs/API.md` point to the entry.
 */
describe('the notice of the move to webhook.qa-tools.ru (#319, D275)', () => {
  const paragraph = () =>
    hostMove?.paragraphs.find((each) => each.startsWith(HOST_MOVE_OPENING)) ?? '';
  const dayX = () => /\bFrom (\d{4}-\d{2}-\d{2}) they stop answering\b/.exec(paragraph())?.[1];

  it('names day X as a date at least 30 days after the entry’s, and at most 31', () => {
    assert.ok(hostMove, 'no entry announces the move');
    assert.equal(
      hostMove.paragraphs.filter((each) => each.startsWith('**Deprecated:**')).length,
      1,
    );

    const day = dayX();

    assert.ok(day, 'the paragraph names no day X');

    const days =
      (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${hostMove.date}T00:00:00Z`)) / 86_400_000;

    assert.ok(days >= 30 && days <= 31, `day X ${day} is ${days} days after ${hostMove.date}`);
    // One date in the paragraph: day X.
    assert.deepEqual(paragraph().match(/\b\d{4}-\d{2}-\d{2}\b/g), [day]);
  });

  it('says what stops answering and redirects, what replaces it, and what follows later', () => {
    const text = paragraph();

    for (const part of [
      'the API under `/api/`',
      'the MCP server at `/mcp`',
      'the WebSocket at `/ws/`',
      'the old webhook path `/s/`',
      'the relay script `qa-tools-relay.mjs`',
      'the changelog feeds `/changelog.xml` and `/changelog-breaking.xml`',
      'the same addresses on https://webhook.qa-tools.ru',
      '`webhook-inspector-relay.mjs` for the relay script',
      'they stop answering on https://qa-tools.ru and redirect to https://webhook.qa-tools.ru',
      "the inspector's pages redirect there for good",
      "the `inspectorUrl` of a webhook's default answer",
      'Webhooks stay on https://hook.qa-tools.ru',
      'Later, https://qa-tools.ru itself will serve the QA Tools platform from another server, at another IP address',
      'announced here at least 14 days ahead, once its date is known',
    ]) {
      assert.ok(text.includes(part), part);
    }
  });

  it('is the one place outside the decisions that names day X', () => {
    const day = dayX();

    assert.ok(day);

    const changelog = readFileSync(new URL('../../../../CHANGELOG.md', import.meta.url), 'utf8');

    assert.equal(changelog.split(day).length - 1, 1, 'CHANGELOG.md names day X once');
    for (const path of [
      '../../../../packages/shared/openapi.json',
      '../../../../docs/API.md',
      '../../../../docs/ARCHITECTURE.md',
      '../../../../docs/PRODUCT.md',
      '../../../../README.md',
      '../../llms/agent-section.md',
      '../../llms/llms.txt',
      '../../public/webhook-inspector-relay.mjs',
    ]) {
      assert.ok(
        !readFileSync(new URL(path, import.meta.url), 'utf8').includes(day),
        `${path} names day X`,
      );
    }
    // D275, in the decision log kept outside this repository, names it too.
  });
});
