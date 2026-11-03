import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ChangelogEntry } from '../../scripts/changelog.mjs';
import type { SiteOrigins } from '../../scripts/site-origin.mjs';

/**
 * Production's origins, whatever the shell running the tests holds (#354):
 * the policy's feed addresses pinned here are production's (D274). The
 * build's modules read the origins from the environment as they load, so
 * they are imported once these are set, not with the static imports above,
 * which would load them first; the scripts this file runs inherit them.
 */
Object.assign(process.env, {
  APP_ORIGIN: 'https://qa-tools.ru',
  RECEIVE_ORIGIN: 'https://hook.qa-tools.ru',
  APP_ALIAS_ORIGIN: 'https://webhook.qa-tools.ru',
});

const { buildLlmsFiles } = await import('../../scripts/build-llms.mjs');
const {
  BREAKING_FEED_PATH,
  changelogFeed,
  changelogMarkdown,
  FEED_PATH,
  PUBLIC_HEADER,
  readChangelog,
  readFeedEntries,
  renderChangelogBody,
  SITE_URL,
} = await import('../../scripts/changelog.mjs');
const { PRODUCTION_ORIGINS, SITE_ORIGINS } = await import('../../scripts/site-origin.mjs');

/** A copy at another address with no second origin of its own, as `llms.test.ts` has one (#342). */
const ANOTHER: SiteOrigins = {
  app: 'https://inspector.example',
  receive: 'https://hook.inspector.example',
  alias: null,
};

/**
 * The stability policy (D154, D184, D212), in force since 1.0.0 (D233), is
 * written three times, for three readers: in `docs/API.md`, Conventions, the
 * contract; in the Stability section of `info.description` of
 * `packages/shared/openapi.json`, which `/docs` renders; and in the
 * changelog's public header, `PUBLIC_HEADER` of `scripts/changelog.mjs`, which
 * opens `/changelog.md`. They say the same thing in the same words: each point
 * below is an exact phrase, pinned rather than read out of the prose, and a
 * place that drops or rewords one fails here, naming the point. Line breaks
 * and indentation are not words: API.md wraps its lines and the others do not,
 * so white space is compared as one space.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The sentence every place carried during 0.x, removed by 1.0.0 (D233). */
const BETA_SENTENCE =
  'QA Tools is in beta (0.x): the API may change, every breaking change is marked in the changelog, and the stability policy below applies from 1.0.';

/** Each point of the policy, `[what it is, the phrase that states it]`. */
const POLICY_POINTS: readonly (readonly [string, string])[] = [
  [
    'the rule before 1.0.0',
    'Entries before 1.0.0 marked a breaking change with no fixed notice period: the mark was the notice.',
  ],
  ['that the policy is in force since 1.0.0', 'Since 1.0.0 the API is under this policy:'],
  [
    'version 1 without a prefix',
    "The API's paths stay `/api/…` and are version 1; no `/v1` prefix is added.",
  ],
  [
    'a /api/v2/ path for one endpoint alone',
    'If one endpoint ever needs an incompatible redesign, a `/api/v2/…` path appears beside it for that endpoint alone.',
  ],
  [
    'the bound surfaces',
    'The promise covers the HTTP API, the webhook URLs and what they answer, the MCP server and the relay script.',
  ],
  ['the free interface', 'The web interface, its design and its texts are not bound.'],
  [
    'additions without notice',
    'Fields, endpoints, optional parameters, `errorCode`s and looser limits ship at once; a client ignores fields it does not know.',
  ],
  [
    'new enum values without notice from the announced date',
    "From 2026-11-24, a new value of an enum in an answer or an event, such as a response's `state`, ships at once too; a client accepts a value it does not know.",
  ],
  [
    'deprecation with a removal date at least 30 days ahead',
    'The new ships beside the old, and the old is marked deprecated with a removal date at least 30 days after the announcement and its replacement; it is removed on or after that date, or never when keeping it costs nothing.',
  ],
  [
    'notice for every breaking change to a stable part',
    'Every breaking change to a stable part gets this notice, however little it is used.',
  ],
  [
    'announce, then ship, what cannot sit side by side',
    '**What cannot sit side by side**, such as a stricter limit or a changed meaning, is announced at least 30 days ahead and ships after, preferably gathered into a major release.',
  ],
  [
    'the emergency exception',
    'A change needed for security, against abuse or overload, or to recover from an outage may ship at once; it is announced when it ships, in its changelog entry, with the reason.',
  ],
  [
    'experimental parts',
    'A new part of the API may be marked experimental and change without notice until it is declared stable; a path of the OpenAPI description marked so carries `x-stability-level: experimental`.',
  ],
  ['the MCP server experimental', 'The MCP server is experimental; everything else is stable.'],
  [
    'the two feeds',
    'Subscribe with a feed reader, Slack or a Telegram bot: all changes, https://qa-tools.ru/changelog.xml · breaking changes and deprecations only, https://qa-tools.ru/changelog-breaking.xml.',
  ],
];

/**
 * What says the API is still before 1.0, `[what it is, pattern]`: the beta
 * sentence and its words, 0.x as a state, and the policy's 0.x-era tenses.
 * Changelog entries before 1.0.0 keep their words, so they are not read.
 */
const STALE: readonly (readonly [string, RegExp])[] = [
  ['"in beta"', /\bin beta\b/i],
  ['"0.x"', /\b0\.x\b/],
  ['the policy as applying from 1.0', /\bapplies from 1\.0\b/],
  ['"From 1.0.0 the API is under this policy"', /\bFrom 1\.0\.0 the API is under this policy\b/],
  ['"At 1.0 the MCP server"', /\bAt 1\.0 the MCP server\b/i],
];

/** White space compared as one space. */
const flat = (text: string) => text.replace(/\s+/g, ' ');

/** The points a text does not state, by name. */
function missingPoints(text: string): string[] {
  const words = flat(text);

  return POLICY_POINTS.filter(([, phrase]) => !words.includes(phrase)).map(([what]) => what);
}

/** What a text still says of the time before 1.0, by name. */
function staleWords(text: string): string[] {
  const words = flat(text);

  return STALE.filter(([, pattern]) => pattern.test(words)).map(([what]) => what);
}

/** One `## ` section of a Markdown text, up to the next `## `; empty without one. */
function markdownSection(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);

  if (start < 0) {
    return '';
  }

  const end = text.indexOf('\n## ', start + 1);

  return text.slice(start, end < 0 ? undefined : end);
}

const description = (
  JSON.parse(read('../../../../packages/shared/openapi.json')) as {
    info: { description: string };
  }
).info.description;
const apiContract = read('../../../../docs/API.md');
const product = read('../../../../docs/PRODUCT.md');

/** The three places, and the part of each that states the policy. */
const PLACES: readonly (readonly [string, string])[] = [
  ['docs/API.md, Conventions', markdownSection(apiContract, '## Conventions')],
  [
    "/docs: the introduction's top and its Stability section",
    `${description.slice(0, description.indexOf('\n## Quickstart\n'))}\n${markdownSection(description, '## Stability')}`,
  ],
  ["the changelog's public header", PUBLIC_HEADER],
];

/** The changelog's entries from 1.0.0 on; the older ones keep their words. */
const entries = readChangelog();
const sinceOne = entries.filter((entry) => !entry.version.startsWith('0.'));

/**
 * Every published output that states the policy or the version's state, and
 * the two documents that describe them: whole, but for changelog entries
 * before 1.0.0.
 */
const PUBLISHED: readonly (readonly [string, string])[] = [
  ['/docs and /openapi.json: info.description', description],
  ['llms-full.txt', buildLlmsFiles()['llms-full.txt']],
  ['/changelog.md', changelogMarkdown(sinceOne)],
  ['/changelog', renderChangelogBody(sinceOne)],
  ['/changelog.xml', changelogFeed(sinceOne, 'all')],
  ['/changelog-breaking.xml', changelogFeed(sinceOne, 'breaking')],
  ['docs/API.md', apiContract],
  ['docs/PRODUCT.md', product],
];

describe('the stability policy, in the three places that state it (D212, D233)', () => {
  it('is read here for production’s origins, whatever the shell running the tests holds (#354)', () => {
    assert.deepEqual(SITE_ORIGINS, PRODUCTION_ORIGINS);
  });

  for (const [place, text] of PLACES) {
    it(`${place} states every point`, () => {
      assert.ok(text.length > 0, `${place} was not found`);
      assert.deepEqual(missingPoints(text), [], `${place} does not state these points`);
    });
  }

  it('fails a place that drops any one point, naming that point', () => {
    for (const [place, text] of PLACES) {
      for (const [what, phrase] of POLICY_POINTS) {
        const dropped = flat(text).replace(phrase, '');

        assert.deepEqual(missingPoints(dropped), [what], `${place} without ${what}`);
      }
    }
  });

  it('fails a place that rewords a point', () => {
    const [, text] = PLACES[2] as readonly [string, string];

    assert.deepEqual(
      missingPoints(text.replace('at least 30 days ahead', 'at least 14 days ahead')),
      ['announce, then ship, what cannot sit side by side'],
    );
    assert.deepEqual(missingPoints(text.replace('and are version 1', 'and are version 2')), [
      'version 1 without a prefix',
    ]);
    // Another date, or a client told to reject a value it does not know.
    for (const [from, to] of [
      ['From 2026-11-24, a new value', 'From 2026-11-01, a new value'],
      ['too; a client accepts a value', 'too; a client rejects a value'],
    ] as const) {
      assert.deepEqual(missingPoints(text.replace(from, to)), [
        'new enum values without notice from the announced date',
      ]);
    }
    // The policy's 0.x-era tenses are not its points any more.
    assert.deepEqual(
      missingPoints(
        text
          .replace(
            'Since 1.0.0 the API is under this policy:',
            'From 1.0.0 the API is under this policy:',
          )
          .replace(
            'The MCP server is experimental; everything else is stable.',
            'At 1.0 the MCP server is experimental; everything else is stable.',
          ),
      ),
      ['that the policy is in force since 1.0.0', 'the MCP server experimental'],
    );
  });

  it('opens /docs with the first paragraph and then the download link, no beta sentence between', () => {
    const [first, second] = description.split('\n\n');

    assert.ok(first?.startsWith('The public HTTP API of Webhook Inspector:'));
    assert.ok(second?.startsWith('**[Download openapi.json](/openapi.json)**'), second);
    assert.ok(!description.includes(BETA_SENTENCE));
  });

  it('names the Stability section without its old 0.x title, and no old wording survives', () => {
    assert.ok(description.includes('\n## Stability\n'));
    assert.ok(!description.includes('## Stability (0.x)'));

    for (const [place, text] of PLACES) {
      assert.ok(!flat(text).includes('no fixed notice period before one'), place);
      assert.ok(!flat(text).includes('There is no `/v1` prefix during 0.x'), place);
      assert.ok(!flat(text).includes(BETA_SENTENCE), place);
      assert.ok(!flat(text).includes('During 0.x there is no fixed notice period'), place);
    }
  });

  it('names the feeds the build writes, at the addresses nginx serves', () => {
    assert.equal(`${SITE_URL}${FEED_PATH}`, 'https://qa-tools.ru/changelog.xml');
    assert.equal(`${SITE_URL}${BREAKING_FEED_PATH}`, 'https://qa-tools.ru/changelog-breaking.xml');
  });

  it('names the feeds of a build for another address at that address, and every other point as written (D274)', () => {
    // The changelog's text as build-changelog.mjs writes it for the copy
    // (#354), in a process of its own whose environment names it.
    const dist = mkdtempSync(join(tmpdir(), 'qa-stability-build-'));

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

      const text = readFileSync(join(dist, 'changelog.md'), 'utf8');

      assert.deepEqual(missingPoints(text), ['the two feeds']);
      assert.ok(
        flat(text).includes(
          `Subscribe with a feed reader, Slack or a Telegram bot: all changes, ${ANOTHER.app}/changelog.xml · breaking changes and deprecations only, ${ANOTHER.app}/changelog-breaking.xml.`,
        ),
      );
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('says in the MCP section of docs/API.md that the MCP server is experimental', () => {
    const section = flat(markdownSection(apiContract, '## MCP server'));

    assert.ok(
      section.includes('**Experimental.** The MCP server is an experimental part of the API'),
    );
    assert.ok(section.includes('the MCP server is experimental, while everything else is stable'));
    assert.ok(!/\bat 1\.0\b/i.test(section), 'the MCP section still speaks of "at 1.0"');
  });

  it('adds no x-stability-level while openapi.json describes no /mcp path', () => {
    const spec = JSON.parse(read('../../../../packages/shared/openapi.json')) as {
      paths: Record<string, unknown>;
    };

    assert.ok(!Object.keys(spec.paths).some((path) => path.startsWith('/mcp')));
    assert.ok(!JSON.stringify(spec.paths).includes('x-stability-level'));
  });
});

describe('since 1.0.0 nothing published says the API is in beta (D233)', () => {
  it('reads the changelog from 1.0.0 on', () => {
    assert.ok(sinceOne.some((entry) => entry.version === '1.0.0'));
    assert.ok(sinceOne.every((entry) => /^[1-9]\d*\./.test(entry.version)));
  });

  for (const [place, text] of PUBLISHED) {
    it(`${place} has no beta sentence and no 0.x as the current state`, () => {
      assert.ok(text.length > 0, `${place} is empty`);
      assert.ok(!flat(text).includes(BETA_SENTENCE), `${place} carries the beta sentence`);
      assert.deepEqual(staleWords(text), [], `${place} still says`);
    });
  }

  it('finds each old wording when it comes back, in any of them', () => {
    const old = [
      [BETA_SENTENCE, ['"in beta"', '"0.x"', 'the policy as applying from 1.0']],
      [
        'During 0.x there is no fixed notice period before a breaking change: the mark in its entry is the notice.',
        ['"0.x"'],
      ],
      ['From 1.0.0 the API is under this policy:', ['"From 1.0.0 the API is under this policy"']],
      [
        'At 1.0 the MCP server is experimental; everything else is stable.',
        ['"At 1.0 the MCP server"'],
      ],
      ['## Stability (0.x)', ['"0.x"']],
    ] as const;

    for (const [place, text] of PUBLISHED) {
      for (const [wording, found] of old) {
        assert.deepEqual(staleWords(`${text}\n\n${wording}\n`), found, `${place} with ${wording}`);
      }
    }
  });

  it('reads 10.x, 0.xml and a word containing "beta" as nothing stale', () => {
    assert.deepEqual(
      staleWords('Version 10.x, the file changelog.0.xml, an alphabetal betamax'),
      [],
    );
  });
});

describe('the 1.0.0 entry of the changelog (D233)', () => {
  const entry = entries.find((candidate) => candidate.version === '1.0.0');

  it('says 1.0 is out under the policy, what that means for a client, and that nothing else changes', () => {
    assert.ok(entry, 'CHANGELOG.md has no 1.0.0 entry');
    assert.equal(
      entry.headline,
      'QA Tools 1.0 is out, and its API is now under the stability policy.',
    );

    const lead = flat(entry.lead);

    for (const phrase of [
      'is announced at least 30 days before it ships, in a Deprecated paragraph of the changelog that the breaking-changes feed carries',
      'additions ship at once',
      'the MCP server stays experimental',
      'Nothing else in the service changes with this version',
    ]) {
      assert.ok(lead.includes(phrase), `the 1.0.0 entry does not say "${phrase}"`);
    }
  });

  it('has no Breaking, Deprecated or Notice paragraph, so only the feed of every change carries it', () => {
    assert.ok(entry);
    assert.deepEqual(
      [entry.breaking, entry.deprecated, entry.notice, entry.paragraphs],
      [false, false, false, []],
    );

    const all = readFeedEntries(changelogFeed(entries, 'all'));
    const breaking = readFeedEntries(changelogFeed(entries, 'breaking'));
    const id = 'tag:qa-tools.ru,2026:changelog/1.0.0';
    const position = all.findIndex((feedEntry) => feedEntry.id === id);

    assert.ok(position >= 0, '/changelog.xml does not carry 1.0.0');
    // Every entry above it is a newer version.
    assert.ok(all.slice(0, position).every((feedEntry) => !feedEntry.id?.includes('/0.')));
    assert.equal(all[position + 1]?.id, 'tag:qa-tools.ru,2026:changelog/0.57.5');
    assert.equal(
      all[position]?.title,
      '1.0.0 — QA Tools 1.0 is out, and its API is now under the stability policy.',
    );
    assert.ok(
      !breaking.some((feedEntry) => feedEntry.id === id),
      '/changelog-breaking.xml carries 1.0.0',
    );
  });

  it('is on /changelog with its headline, under its day, above 0.57.5', () => {
    assert.ok(entry);

    const page = renderChangelogBody(entries);
    const at = page.indexOf('<details class="version" id="v1.0.0"');

    assert.ok(at >= 0, '/changelog has no 1.0.0');
    assert.ok(at < page.indexOf('<details class="version" id="v0.57.5"'));
    assert.ok(
      page
        .slice(at, page.indexOf('</details>', at))
        .includes(
          '<span class="headline">QA Tools 1.0 is out, and its API is now under the stability policy.</span></span>',
        ),
      'its headline is not shown, or shown with a label',
    );
    // The day it sits under is its own.
    const day = page.slice(page.lastIndexOf('<section class="day"', at), at);

    assert.ok(day.includes(`<time datetime="${entry.date}">`), `1.0.0 is not under ${entry.date}`);
  });
});

/** The point that says when a new value of an answer's enum ships at once (D248). */
const ENUM_POINT = POLICY_POINTS.find(
  ([what]) => what === 'new enum values without notice from the announced date',
)?.[1] as string;

/** The opening of the Deprecated paragraph that announces it. */
const ENUM_ANNOUNCEMENT =
  '**Deprecated:** the fixed list of values of each enum in an answer or an event';

const DAY = 24 * 60 * 60 * 1000;

/**
 * What is wrong with the announcement of the point, by name: the date the
 * point names must be the one the announcing entry's Deprecated paragraph
 * names, and at least 30 days after that entry's date (D212).
 */
function announcementProblems(point: string, list: readonly ChangelogEntry[]): string[] {
  const date = /^From (\d{4}-\d{2}-\d{2}), /.exec(point)?.[1];

  if (!date) {
    return ['the point names no date'];
  }

  const announcing = list.filter((entry) =>
    entry.paragraphs.some((paragraph) => paragraph.startsWith(ENUM_ANNOUNCEMENT)),
  );

  if (announcing.length !== 1) {
    return [`${announcing.length} entries announce it`];
  }

  const [entry] = announcing as [ChangelogEntry];
  const paragraph = entry.paragraphs.find((candidate) =>
    candidate.startsWith(ENUM_ANNOUNCEMENT),
  ) as string;
  const problems: string[] = [];
  const named = [...paragraph.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((match) => match[0]);

  if (named.length !== 1 || named[0] !== date) {
    problems.push('the Deprecated paragraph names another date');
  }

  if (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${entry.date}T00:00:00Z`) < 30 * DAY) {
    problems.push('the date is under 30 days after its entry');
  }

  return problems;
}

describe('a new value of an enum in an answer ships at once from the announced date (D248)', () => {
  const announcing = entries.find((entry) =>
    entry.paragraphs.some((paragraph) => paragraph.startsWith(ENUM_ANNOUNCEMENT)),
  );

  it('names in the point the date the announcing Deprecated paragraph names, at least 30 days after its entry', () => {
    assert.ok(ENUM_POINT, 'the point is not pinned');
    assert.deepEqual(announcementProblems(ENUM_POINT, entries), []);
  });

  it('fails a date under 30 days after the entry, another date in the paragraph, and no or two announcing entries', () => {
    assert.ok(announcing);

    const moved = (date: string) => ENUM_POINT.replace('2026-11-24', date);
    const withParagraph = (paragraph: string) =>
      entries.map((entry) =>
        entry === announcing
          ? {
              ...entry,
              paragraphs: entry.paragraphs.map((candidate) =>
                candidate.startsWith(ENUM_ANNOUNCEMENT) ? paragraph : candidate,
              ),
            }
          : entry,
      );
    const paragraph = announcing.paragraphs.find((candidate) =>
      candidate.startsWith(ENUM_ANNOUNCEMENT),
    ) as string;
    const tooSoon = new Date(Date.parse(`${announcing.date}T00:00:00Z`) + 29 * DAY)
      .toISOString()
      .slice(0, 10);

    assert.deepEqual(
      announcementProblems(moved(tooSoon), withParagraph(paragraph.replace('2026-11-24', tooSoon))),
      ['the date is under 30 days after its entry'],
    );
    assert.deepEqual(announcementProblems(moved('2026-12-01'), entries), [
      'the Deprecated paragraph names another date',
    ]);
    assert.deepEqual(
      announcementProblems(ENUM_POINT, withParagraph(`${paragraph} Or from 2026-12-01.`)),
      ['the Deprecated paragraph names another date'],
    );
    assert.deepEqual(announcementProblems(ENUM_POINT, withParagraph('**Deprecated:** else.')), [
      '0 entries announce it',
    ]);
    assert.deepEqual(announcementProblems(ENUM_POINT, [...entries, announcing]), [
      '2 entries announce it',
    ]);
    assert.deepEqual(announcementProblems('Additions ship at once.', entries), [
      'the point names no date',
    ]);
  });

  it('is an entry read as deprecated, carried by the breaking feed and labelled Deprecated on /changelog', () => {
    assert.ok(announcing, 'no entry announces new enum values');
    assert.deepEqual([announcing.deprecated, announcing.breaking], [true, false]);

    const id = `tag:qa-tools.ru,2026:changelog/${announcing.version}`;

    assert.ok(
      readFeedEntries(changelogFeed(entries, 'breaking')).some((entry) => entry.id === id),
      '/changelog-breaking.xml does not carry it',
    );

    // The file the build writes, from the repository's CHANGELOG.md.
    const dist = mkdtempSync(join(tmpdir(), 'qa-stability-build-'));

    try {
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('../../scripts/build-changelog.mjs', import.meta.url)), dist],
        { encoding: 'utf8' },
      );

      const built = readFeedEntries(readFileSync(join(dist, 'changelog-breaking.xml'), 'utf8'));
      const item = built.find((entry) => entry.id === id);

      assert.ok(item, 'the built /changelog-breaking.xml does not carry it');
      assert.ok(item.content?.includes('<strong>Deprecated:</strong> the fixed list'));
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }

    const page = renderChangelogBody(entries);
    const at = page.indexOf(
      `<details class="version" id="v${announcing.version}" data-breaking=""`,
    );

    assert.ok(at >= 0, '/changelog does not mark it');

    const details = page.slice(at, page.indexOf('</details>', at));

    assert.ok(details.includes('<span class="badge">Deprecated</span>'));
    assert.ok(details.includes('<p class="breaking"><strong>Deprecated:</strong> the fixed list'));
  });

  it("says in ResponseState and in API.md's states table, without the date, that new values may be added", () => {
    const spec = JSON.parse(read('../../../../packages/shared/openapi.json')) as {
      components: { schemas: { ResponseState: { description: string } } };
    };
    const state = spec.components.schemas.ResponseState.description;

    assert.ok(
      state.includes(
        'New values may be added (see Stability); a client accepts a value it does not know.',
      ),
    );
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(state), 'ResponseState names a date');
    assert.ok(
      flat(markdownSection(apiContract, '## Get request details')).includes(
        '| *(no record)* | `response` is `null`. There is nothing stored for this request; its request data is unaffected. | New values may be added (see Conventions); a client accepts a value it does not know.',
      ),
      "API.md's states table is not followed by the sentence",
    );
  });

  it('is in PRODUCT.md, which no longer says no Deprecated paragraph exists', () => {
    const words = flat(product);

    assert.ok(!words.includes('its replacement and its removal date; none exists yet'));
    assert.ok(words.includes('and from 2026-11-24 so does a new value of an enum in an answer'));
  });
});
