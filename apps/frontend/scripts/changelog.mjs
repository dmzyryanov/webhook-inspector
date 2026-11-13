/**
 * The public changelog (issue #97, D184), generated from the repository's
 * `CHANGELOG.md` at every frontend build, as `llms-full.txt` is (D165):
 *
 * - `/changelog.md`, the text for scripts and agents: a public header, then
 *   every version, newest first, with its date and whole entry;
 * - `/changelog`, a static page of its own like `/docs` (D155): the body of
 *   `changelog/index.html` is written here and put in place by
 *   `changelogPagePlugin()` when Vite builds that page (`vite.changelog.config.ts`),
 *   or serves it in development (`vite.config.ts`);
 * - `/changelog.xml` and `/changelog-breaking.xml`, two Atom feeds (RFC 4287,
 *   D212): every version, and only the versions whose entry has a
 *   `**Breaking:**`, a `**Deprecated:**` or a `**Notice:**` paragraph (D224),
 *   one `<entry>` per version, newest first.
 *
 * The source's own header, everything above the first `## <version>`, holds an
 * opening for readers of the file and the writers' rules, and is never
 * published. Issue and decision references, which the source keeps only as a
 * trailing parenthesis such as `(#69, D183)`, are removed from everything
 * published. A version with no date line, or whose entry does not open with a
 * bold headline, stops the build. The source is written for production: a
 * build for another address names its own origins in every output, and one
 * with no second origin leaves out of all of them the notices that name
 * production's (`siteEntries()`, #343).
 *
 * Nothing it writes is committed. `scripts/build-changelog.mjs` writes
 * `changelog.md` and the two feeds into the build; `check-build.mjs` checks
 * every output.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { CHANGELOG_LINK } from '../src/lib/changelog-link.ts';
import { escapeHtml, siteFooter, siteHeader } from './site-chrome.mjs';
import {
  APP_ORIGIN,
  isProduction,
  nameSite,
  namesSecondOrigin,
  SITE_ORIGINS,
} from './site-origin.mjs';

export { escapeHtml };

/** The repository's changelog: `CHANGELOG.md` at the root, copied into the image build. */
export const CHANGELOG_SOURCE = fileURLToPath(new URL('../../../CHANGELOG.md', import.meta.url));

/** Where the page's template holds the body this module writes. */
export const PAGE_PLACEHOLDER = '<!-- changelog:page -->';

/** The site every published address is on: the one this build names (D274). */
export const SITE_URL = APP_ORIGIN;

/** The address the page is served at, and the one its text points scripts to. */
export const CHANGELOG_URL = `${SITE_URL}/changelog`;
export const CHANGELOG_MD_PATH = '/changelog.md';

/** The two Atom feeds (D212): every version, and the breaking or deprecating ones. */
export const FEED_PATH = '/changelog.xml';
export const BREAKING_FEED_PATH = '/changelog-breaking.xml';

const VERSION_HEADING = /^## (\S+)\s*$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const DATE_LINE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** One reference inside the trailing parenthesis: `#97`, `D184`, or a range `D150–D153`. */
const REFERENCE = '(?:#\\d+|D\\d{3}(?:[–-]D\\d{3})?)';

/** A parenthesis holding references only, with the space before it. */
const REFERENCES = new RegExp(`\\s*\\(${REFERENCE}(?:,\\s*${REFERENCE})*\\)`, 'g');

/** A bold headline at the start of a paragraph: `**…**`, code spans allowed inside. */
const HEADLINE = /^\*\*((?:[^*`]|`[^`]*`|\*(?!\*))+?)\*\*(?=\s|$)/;

/** The paragraph that says what can break an API client. */
export const BREAKING_PREFIX = '**Breaking:**';

/**
 * The paragraph that announces a deprecation (D212): what is deprecated, its
 * replacement and the date it is removed or changed on.
 */
export const DEPRECATED_PREFIX = '**Deprecated:**';

/**
 * The paragraph that announces a change to the Terms of Use or the Privacy
 * Policy ahead of the day it applies (D224): what changes and that day,
 * treated as a Deprecated paragraph is.
 */
export const NOTICE_PREFIX = '**Notice:**';

/** The paragraphs a reader is warned by: the page marks them, the breaking feed carries them. */
const NOTICE_PREFIXES = [BREAKING_PREFIX, DEPRECATED_PREFIX, NOTICE_PREFIX];

/** Whether a paragraph is a Breaking, a Deprecated or a Notice paragraph. */
export function isNoticeParagraph(paragraph) {
  return NOTICE_PREFIXES.some((prefix) => paragraph.startsWith(prefix));
}

/**
 * Whether an entry has a Breaking, a Deprecated or a Notice paragraph: the
 * versions the page's `Breaking only` filter shows and
 * `/changelog-breaking.xml` carries.
 */
export function hasNotice(entry) {
  return entry.breaking || entry.deprecated || entry.notice;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Removes every `(#69, D183)`-style parenthesis from a text. */
export function stripReferences(text) {
  return text.replace(REFERENCES, '');
}

function compareVersions(a, b) {
  const [, ...left] = VERSION.exec(a).map(Number);
  const [, ...right] = VERSION.exec(b).map(Number);

  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }

  return 0;
}

function validDay(text) {
  const match = DATE_LINE.exec(text);

  if (!match) {
    return false;
  }

  const date = new Date(`${text}T00:00:00Z`);

  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * An entry's three marks: whether one of its `paragraphs` is a Breaking, a
 * Deprecated or a Notice paragraph.
 */
function noticeMarks(paragraphs) {
  return {
    breaking: paragraphs.some((paragraph) => paragraph.startsWith(BREAKING_PREFIX)),
    deprecated: paragraphs.some((paragraph) => paragraph.startsWith(DEPRECATED_PREFIX)),
    notice: paragraphs.some((paragraph) => paragraph.startsWith(NOTICE_PREFIX)),
  };
}

/**
 * Reads the source into entries, newest first as written:
 * `{ version, date, headline, lead, paragraphs, breaking, deprecated, notice }`.
 * `headline` is the bold sentence without its asterisks, `lead` the rest of
 * the first paragraph, `paragraphs` the paragraphs after it; every text is one
 * line of Markdown with its references removed. `breaking`, `deprecated` and
 * `notice` say whether a paragraph after the first starts `**Breaking:**`,
 * `**Deprecated:**` or `**Notice:**`. Throws on anything the build must not
 * publish, a headline that is one of those three paragraphs included.
 */
export function parseChangelog(source) {
  const sections = [];

  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = VERSION_HEADING.exec(line);

    if (heading) {
      sections.push({ version: heading[1], lines: [] });
    } else if (sections.length > 0) {
      sections.at(-1).lines.push(line);
    }
  }

  if (sections.length === 0) {
    throw new Error('CHANGELOG.md has no version heading "## <version>"');
  }

  const entries = sections.map(({ version, lines }) => {
    if (!VERSION.test(version)) {
      throw new Error(`CHANGELOG.md: "## ${version}" is not a version`);
    }

    const blocks = lines
      .join('\n')
      .split(/\n\s*\n/)
      .map((block) =>
        block
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .join(' '),
      )
      .filter((block) => block.length > 0);
    const [date, first, ...rest] = blocks;

    if (date === undefined || !validDay(date)) {
      throw new Error(
        `CHANGELOG.md: ${version} has no date; the line after its heading must be the UTC day it reached production, YYYY-MM-DD`,
      );
    }

    const opening = first === undefined ? null : HEADLINE.exec(stripReferences(first));

    if (!opening || /^(?:Breaking|Deprecated|Notice):/.test(opening[1])) {
      throw new Error(`CHANGELOG.md: ${version} does not open with a bold headline, **…**`);
    }

    const paragraphs = rest.map(stripReferences);

    return {
      version,
      date,
      headline: opening[1].trim(),
      lead: stripReferences(first).slice(opening[0].length).trim(),
      paragraphs,
      ...noticeMarks(paragraphs),
    };
  });

  for (let index = 1; index < entries.length; index += 1) {
    const newer = entries[index - 1];
    const older = entries[index];

    if (compareVersions(newer.version, older.version) <= 0) {
      throw new Error(`CHANGELOG.md: ${older.version} is listed after ${newer.version}`);
    }

    if (newer.date < older.date) {
      throw new Error(
        `CHANGELOG.md: ${newer.version} is dated ${newer.date}, before ${older.version} (${older.date})`,
      );
    }
  }

  return entries;
}

/** The first paragraph of an entry: the bold headline, then the rest. */
function firstParagraph(entry) {
  return entry.lead ? `**${entry.headline}** ${entry.lead}` : `**${entry.headline}**`;
}

/**
 * The header `/changelog.md` carries instead of the repository's: what the
 * file is, the two feeds, how an entry reads — its Breaking, Deprecated and
 * Notice paragraphs included (D224) — and the stability policy, in force
 * since 1.0.0 (D154, D184, D212, D233). The policy is stated in the same words
 * in `/docs`, the Stability section of `info.description` in
 * `packages/shared/openapi.json`, and in `docs/API.md`, Conventions;
 * `src/lib/stability-policy.test.ts` fails when one of the three drops a
 * point. No line starts `## `, which a reader of the file takes for a version.
 */
export const PUBLIC_HEADER = [
  '# Webhook Inspector — Changelog',
  '',
  `What changed in each version of Webhook Inspector (${SITE_URL}), newest first. The same text is a page at ${CHANGELOG_URL}.`,
  '',
  `Subscribe with a feed reader, Slack or a Telegram bot: all changes, ${SITE_URL}${FEED_PATH} · breaking changes and deprecations only, ${SITE_URL}${BREAKING_FEED_PATH}.`,
  '',
  'Under each version is the UTC day it reached production, and its entry opens with a one-sentence headline in bold. A change that can break an API client has a paragraph that starts **Breaking:**, and a deprecation one that starts **Deprecated:**, naming what is deprecated, its replacement and its removal date. The API was not public before 0.16.0, the version that published it, so no earlier entry is marked. A change to the Terms of Use or the Privacy Policy announced before it applies has a paragraph that starts **Notice:**, naming the change and the day it applies.',
  '',
  'Entries before 1.0.0 marked a breaking change with no fixed notice period: the mark was the notice. Since 1.0.0 the API is under this policy:',
  '',
  "- **Version 1, no prefix.** The API's paths stay `/api/…` and are version 1; no `/v1` prefix is added. If one endpoint ever needs an incompatible redesign, a `/api/v2/…` path appears beside it for that endpoint alone.",
  '- **What it binds.** The promise covers the HTTP API, the webhook URLs and what they answer, the MCP server and the relay script. The web interface, its design and its texts are not bound.',
  "- **Additions need no notice.** Fields, endpoints, optional parameters, `errorCode`s and looser limits ship at once; a client ignores fields it does not know. From 2026-11-24, a new value of an enum in an answer or an event, such as a response's `state`, ships at once too; a client accepts a value it does not know.",
  '- **Changing what exists.** The new ships beside the old, and the old is marked deprecated with a removal date at least 30 days after the announcement and its replacement; it is removed on or after that date, or never when keeping it costs nothing. Every breaking change to a stable part gets this notice, however little it is used.',
  '- **What cannot sit side by side**, such as a stricter limit or a changed meaning, is announced at least 30 days ahead and ships after, preferably gathered into a major release.',
  '- **Emergencies.** A change needed for security, against abuse or overload, or to recover from an outage may ship at once; it is announced when it ships, in its changelog entry, with the reason.',
  '- **Experimental parts.** A new part of the API may be marked experimental and change without notice until it is declared stable; a path of the OpenAPI description marked so carries `x-stability-level: experimental`. The MCP server is experimental; everything else is stable.',
].join('\n');

/** The whole of `/changelog.md`. */
export function changelogMarkdown(entries) {
  const parts = [PUBLIC_HEADER];

  for (const entry of entries) {
    parts.push(
      [`## ${entry.version}`, entry.date, firstParagraph(entry), ...entry.paragraphs].join('\n\n'),
    );
  }

  return `${parts.join('\n\n')}\n`;
}

/**
 * Everything XML 1.0 cannot carry, even as a reference: the C0 controls but
 * tab, line feed and carriage return, a lone surrogate, U+FFFE and U+FFFF.
 */
const XML_ILLEGAL = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

/**
 * Text made safe for XML content and attribute values: `&`, `<`, `>` and `"`
 * escaped, and every character XML 1.0 cannot carry replaced by U+FFFD, so
 * the document stays well-formed whatever the text holds.
 */
export function escapeXml(text) {
  return text
    .replace(XML_ILLEGAL, '�')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The feeds' ids are tag URIs (RFC 4151) of the site's own name, so they stay
 * the same whatever address the page or the feed moves to. An entry's id is
 * its version's, the same in both feeds, so a reader subscribed to both shows
 * it once.
 */
const TAG = 'tag:qa-tools.ru,2026:';

/** The id of a version's entry: `tag:qa-tools.ru,2026:changelog/0.51.0`. */
export function feedEntryId(version) {
  return `${TAG}changelog/${version}`;
}

/** The two feeds: which versions each carries, and what it calls itself. */
export const FEEDS = {
  all: {
    path: FEED_PATH,
    id: `${TAG}changelog`,
    title: 'Webhook Inspector — Changelog',
    subtitle: 'What changed in each version of Webhook Inspector, newest first.',
    includes: () => true,
  },
  breaking: {
    path: BREAKING_FEED_PATH,
    id: `${TAG}changelog-breaking`,
    title: 'Webhook Inspector — Breaking changes and deprecations',
    subtitle:
      'The versions of Webhook Inspector with a change that can break an API client, a deprecation, or a notice of a change to the Terms of Use or the Privacy Policy, newest first.',
    includes: hasNotice,
  },
};

/** A UTC day as an RFC 3339 time, its first moment: `2026-10-09T00:00:00Z`. */
function atomTime(day) {
  return `${day}T00:00:00Z`;
}

/**
 * The text of a line of the source's Markdown, as the page shows it: its
 * `code` and `**bold**` marks dropped, its entities decoded, so the feed's
 * titles read `/about`, not `` `/about` `` or `&lt;id&gt;`.
 */
export function plainText(markdown) {
  return pageText(renderInline(markdown).replace(/<\/?(?:code|strong)>/g, ''));
}

/**
 * An entry's published text as HTML, as `/changelog.md` gives it: the bold
 * headline and the rest of the first paragraph, then every other paragraph.
 */
export function entryHtml(entry) {
  return [firstParagraph(entry), ...entry.paragraphs]
    .map((paragraph) => `<p>${renderInline(paragraph)}</p>`)
    .join('');
}

/**
 * One of the two Atom feeds (RFC 4287, D212), `kind` `all` or `breaking`:
 * one `<entry>` per version it carries, newest first, each with its version's
 * id, the version and its headline as title, its UTC day as `updated`, a link
 * to its line on `/changelog`, and its published text as HTML content, with
 * the references already removed by the parser. Nothing in it depends on the
 * time of the build, so the same source always gives the same bytes. The
 * feed's own `updated` is the day of its newest entry, or of the newest
 * version when it carries none.
 */
export function changelogFeed(entries, kind = 'all') {
  const feed = FEEDS[kind];

  if (feed === undefined) {
    throw new Error(`no changelog feed "${kind}"`);
  }

  if (entries.length === 0) {
    throw new Error('a changelog feed needs at least one version');
  }

  const carried = entries.filter(feed.includes);
  const updated = (carried[0] ?? entries[0]).date;
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">',
    `  <id>${escapeXml(feed.id)}</id>`,
    `  <title>${escapeXml(feed.title)}</title>`,
    `  <subtitle>${escapeXml(feed.subtitle)}</subtitle>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(`${SITE_URL}${feed.path}`)}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(CHANGELOG_URL)}"/>`,
    `  <updated>${atomTime(updated)}</updated>`,
    `  <author><name>QA Tools</name><uri>${escapeXml(`${SITE_URL}/`)}</uri></author>`,
    `  <icon>${escapeXml(`${SITE_URL}/favicon-192.png`)}</icon>`,
  ];

  for (const entry of carried) {
    lines.push(
      '  <entry>',
      `    <id>${escapeXml(feedEntryId(entry.version))}</id>`,
      `    <title>${escapeXml(`${entry.version} — ${plainText(entry.headline)}`)}</title>`,
      `    <updated>${atomTime(entry.date)}</updated>`,
      `    <link rel="alternate" type="text/html" href="${escapeXml(`${CHANGELOG_URL}#v${entry.version}`)}"/>`,
      `    <content type="html">${escapeXml(entryHtml(entry))}</content>`,
      '  </entry>',
    );
  }

  lines.push('</feed>');

  return `${lines.join('\n')}\n`;
}

/** The five entities XML predefines, and character references. */
const XML_REFERENCE = /&(?:(lt|gt|amp|quot|apos)|#x([0-9A-Fa-f]{1,6})|#([0-9]{1,7}));/g;
const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** XML character data as text: every predefined entity and character reference decoded. */
export function unescapeXml(text) {
  return text.replace(XML_REFERENCE, (whole, name, hex, decimal) => {
    if (name !== undefined) {
      return XML_ENTITIES[name];
    }

    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(decimal);

    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * The text between `<name …>` and `</name>` in a piece of a feed this module
 * wrote, unescaped; `undefined` without one. Found with `indexOf`, never a
 * backtracking pattern, so a broken piece costs one pass.
 */
function elementText(piece, name) {
  const open = piece.indexOf(`<${name}`);

  if (open < 0) {
    return undefined;
  }

  const start = piece.indexOf('>', open);
  const end = start < 0 ? -1 : piece.indexOf(`</${name}>`, start);

  return end < 0 ? undefined : unescapeXml(piece.slice(start + 1, end));
}

/**
 * The entries of a feed `changelogFeed` wrote, in order:
 * `{ id, title, updated, link, content }`, each unescaped, `undefined` where
 * the entry lacks it. It reads this module's own output, not any Atom: the
 * build check reads the built feeds with it after `isWellFormedXml` has
 * passed them. Each `<entry>` is found with `indexOf`, so a feed cut short
 * still costs one pass.
 */
export function readFeedEntries(xml) {
  const entries = [];
  let index = 0;

  for (;;) {
    const start = xml.indexOf('<entry>', index);

    if (start < 0) {
      break;
    }

    const end = xml.indexOf('</entry>', start);

    if (end < 0) {
      break;
    }

    const piece = xml.slice(start + '<entry>'.length, end);
    const link = /<link rel="alternate" type="text\/html" href="([^"<>]*)"\/>/.exec(piece)?.[1];

    entries.push({
      id: elementText(piece, 'id'),
      title: elementText(piece, 'title'),
      updated: elementText(piece, 'updated'),
      link: link === undefined ? undefined : unescapeXml(link),
      content: elementText(piece, 'content'),
    });
    index = end + '</entry>'.length;
  }

  return entries;
}

/**
 * One line of the source's Markdown as HTML: `code` and `**bold**`, and
 * everything else escaped, so `<session-id>` shows as written. An unmatched
 * backtick or pair of asterisks stays as typed.
 */
export function renderInline(markdown) {
  const codes = [];
  const withoutCode = markdown.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);

    return `\uE000${codes.length - 1}\uE001`;
  });

  return escapeHtml(withoutCode)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\uE000(\d+)\uE001/g, (_, index) => codes[Number(index)]);
}

/** `2026-09-05` as the page writes it: `5 Sep 2026`. */
export function formatDay(day) {
  const [year, month, date] = day.split('-').map(Number);

  return `${date} ${MONTHS[month - 1]} ${year}`;
}

/** `1 version`, `3 versions`. */
export function versionCount(count) {
  return `${count} ${count === 1 ? 'version' : 'versions'}`;
}

/** The entries grouped by their UTC day, in their order: `[{ date, entries }]`. */
export function groupByDay(entries) {
  const days = [];

  for (const entry of entries) {
    if (days.at(-1)?.date === entry.date) {
      days.at(-1).entries.push(entry);
    } else {
      days.push({ date: entry.date, entries: [entry] });
    }
  }

  return days;
}

const CHEVRON =
  '<svg class="chevron" aria-hidden="true" width="16" height="20" viewBox="0 0 16 20"><path d="M4 8l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * The label a version line carries: `Breaking` for an entry with a Breaking
 * paragraph, `Deprecated` for one with a Deprecated paragraph and no Breaking
 * one (D212), `Notice` for one with only a Notice paragraph (D224), and none
 * otherwise.
 */
export function noticeBadge(entry) {
  if (entry.breaking) {
    return 'Breaking';
  }

  if (entry.deprecated) {
    return 'Deprecated';
  }

  return entry.notice ? 'Notice' : null;
}

/**
 * One version as a `<details>`. A Breaking, a Deprecated or a Notice paragraph
 * is drawn with the red edge, and an entry with any of them carries
 * `data-breaking`, which the `Breaking only` filter shows (D212, D224).
 */
function versionDetails(entry, open) {
  const body = [
    ...(entry.lead ? [`<p>${renderInline(entry.lead)}</p>`] : []),
    ...entry.paragraphs.map((paragraph) =>
      isNoticeParagraph(paragraph)
        ? `<p class="breaking">${renderInline(paragraph)}</p>`
        : `<p>${renderInline(paragraph)}</p>`,
    ),
  ];
  const badge = noticeBadge(entry);

  return [
    `<details class="version" id="v${entry.version}"${hasNotice(entry) ? ' data-breaking=""' : ''}${open ? ' open' : ''}>`,
    '<summary>',
    `<span class="number">${entry.version}</span>`,
    `<span class="title"><span class="headline">${renderInline(entry.headline)}</span>${badge ? `<span class="badge">${badge}</span>` : ''}</span>`,
    CHEVRON,
    '</summary>',
    ...(body.length > 0 ? [`<div class="entry">${body.join('')}</div>`] : []),
    '</details>',
  ].join('');
}

/**
 * Everything inside `<body>` of `/changelog`: the header, the page (row C′ of
 * the Figma page `Webhook Inspector · Changelog`) and the footer. Each version
 * is a `<details>`, the newest open, so every line opens without JavaScript;
 * the toolbar needs the page's script and is hidden without it.
 */
export function renderChangelogBody(entries) {
  const days = groupByDay(entries).map((day) =>
    [
      `<section class="day" aria-label="${formatDay(day.date)}">`,
      '<div class="day-label">',
      `<time datetime="${day.date}">${formatDay(day.date)}</time>`,
      `<span class="count"><span class="count-separator">· </span>${versionCount(day.entries.length)}</span>`,
      '</div>',
      `<div class="versions">${day.entries
        .map((entry) => versionDetails(entry, entry === entries[0]))
        .join('\n')}</div>`,
      '</section>',
    ].join('\n'),
  );

  return [
    siteHeader(CHANGELOG_LINK.href),
    '<main>',
    '<div class="container">',
    '<div class="intro">',
    '<h1>Changelog</h1>',
    '<p class="lead">What changed in each version of Webhook Inspector, newest first. A change that can break an API client is marked <strong>Breaking</strong>.</p>',
    `<p class="plain">Plain text for scripts: <a href="${CHANGELOG_MD_PATH}"><code>${CHANGELOG_MD_PATH}</code></a></p>`,
    `<p class="plain">Subscribe with a feed reader, Slack or a Telegram bot: all changes, <a href="${FEED_PATH}"><code>${FEED_PATH}</code></a> · breaking changes and deprecations only, <a href="${BREAKING_FEED_PATH}"><code>${BREAKING_FEED_PATH}</code></a></p>`,
    '</div>',
    '<div class="list">',
    '<div class="toolbar" data-toolbar="">',
    '<div class="filter" role="group" aria-label="Versions shown">',
    '<button type="button" class="chip" data-filter="all" aria-pressed="true">All versions</button>',
    '<button type="button" class="chip" data-filter="breaking" aria-pressed="false">Breaking only</button>',
    '</div>',
    '<button type="button" class="expand" data-expand="">Expand all</button>',
    '</div>',
    `<div class="days">\n${days.join('\n')}\n</div>`,
    '</div>',
    '</div>',
    '</main>',
    siteFooter(CHANGELOG_LINK.href),
  ].join('\n');
}

/**
 * `entries`, read from the source as written, for production, as a build for
 * `origins` publishes them: every text naming the configured origins in
 * place of production's (`nameSite()`, D274), and, in a build with no second
 * origin, without the Breaking, Deprecated and Notice paragraphs that name
 * production's second origin, `webhook.qa-tools.ru` (#343). Such a build
 * names the site's own origin in that one's place (D275), so 1.16.0's notice
 * of the move would say that the site's addresses stop answering on its
 * origin and redirect to the same one: the move is production's, and a build
 * with no second origin has none, as it has no move banner (D276). An entry
 * left with none of the three paragraphs is no longer marked, so the page's
 * `Breaking only` and the breaking feed leave it out. Day X's site, whose
 * second origin is its own (#324), is such a build too. Production's origins
 * give `entries` back as they are.
 */
export function siteEntries(entries, origins = SITE_ORIGINS) {
  if (isProduction(origins)) {
    return entries;
  }

  const hasMove = (origins.alias ?? null) !== null;
  const published = (paragraph) =>
    hasMove || !isNoticeParagraph(paragraph) || !namesSecondOrigin(paragraph);

  return entries.map((entry) => {
    const paragraphs = entry.paragraphs
      .filter(published)
      .map((paragraph) => nameSite(paragraph, origins));

    return {
      ...entry,
      headline: nameSite(entry.headline, origins),
      lead: nameSite(entry.lead, origins),
      paragraphs,
      ...noticeMarks(paragraphs),
    };
  });
}

/**
 * Reads `CHANGELOG.md` and returns its entries as a build for `origins`
 * publishes them, this build's unless a test gives its own. The text is
 * written for production; the addresses it names are the build's
 * (`siteEntries()`).
 */
export function readChangelog(file = CHANGELOG_SOURCE, origins = SITE_ORIGINS) {
  return siteEntries(parseChangelog(readFileSync(file, 'utf8')), origins);
}

/** The page's template with its body in place. */
export function renderChangelogPage(template, entries) {
  if (!template.includes(PAGE_PLACEHOLDER)) {
    throw new Error(`the changelog page template has no ${PAGE_PLACEHOLDER}`);
  }

  return template.replace(PAGE_PLACEHOLDER, () => renderChangelogBody(entries));
}

/**
 * The Vite plugin that writes the body of `changelog/index.html` from
 * `CHANGELOG.md` when the page is built or served. Every other page is left
 * alone. The source is read each time, so the dev server shows an edit on
 * reload.
 */
export function changelogPagePlugin() {
  return {
    name: 'webhook-inspector-changelog-page',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        if (!context.path.endsWith('/changelog/index.html')) {
          return html;
        }

        return renderChangelogPage(html, readChangelog());
      },
    },
  };
}

/**
 * Words and shapes the published text must never carry: issue and decision
 * references, repository paths, and the names of infrastructure (D184). Each
 * is `[what it is, pattern]`.
 *
 * `qa-tools-relay.mjs` is a `qa-tools-` name that is public: it is the file
 * the site serves for download at that address, and its entry names it
 * (D202). The other is the relay script's old User-Agent, `qa-tools-relay`,
 * which 1.19.0's notice names (D279): taken only right after `User-Agent `,
 * in backticks or not, and not followed by more of a name, so the same word
 * as an object's name is still refused.
 */
export const UNPUBLISHABLE = [
  ['an issue reference', /#\d+/],
  ['a decision reference', /\bD\d{3}\b/],
  ['a repository path', /(?<![\w./-])(?:docs|apps|scripts|deploy|\.claude)\/(?=\S)/],
  ['a runbook', /runbook/i],
  ['a Secret', /\bSecrets?\b/],
  ['a CronJob', /\bCronJobs?\b/i],
  ['Traefik', /traefik/i],
  ['k3s', /\bk3s\b/i],
  ['Helm', /\bHelm\b/],
  ['kubectl', /kubectl/i],
  [
    'a qa-tools- object name',
    /\bqa-tools-(?!relay\.mjs\b|relay(?![\w-]|\.\w)(?<=User-Agent `?qa-tools-relay))[a-z0-9]/,
  ],
  ['Kubernetes', /\bKubernetes\b/i],
  ['an Ingress', /\bIngress(?:es)?\b/],
  ['a pod', /\bpods?\b/i],
  ['a namespace', /\bnamespaces?\b/i],
];

/** What in a published text must not be published, one line per finding. */
export function publishedTextProblems(text) {
  const problems = [];

  for (const [what, pattern] of UNPUBLISHABLE) {
    const match = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);

    for (const found of text.matchAll(match)) {
      const start = Math.max(0, found.index - 30);

      problems.push(`${what}: …${text.slice(start, found.index + found[0].length + 30)}…`);
    }
  }

  return problems;
}

/** The text a reader sees on the page: markup removed, entities decoded. */
export function pageText(html) {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();
}
