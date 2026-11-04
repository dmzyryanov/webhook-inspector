import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { describe, it } from 'node:test';
import type { SiteOrigins } from '../../scripts/site-origin.mjs';
import type { AboutCopy, AboutPart } from './about-copy.ts';
import { ABOUT_ADDRESSES, ABOUT_LINK, aboutAddress } from './about-link.ts';

/**
 * Production's origins, whatever the shell running the tests holds (#354):
 * the pages' texts are written for production (D274), and the hash below is
 * of production's English. The copy modules read the origins from the
 * environment as they load, so they are imported once these are set, not
 * with the static imports above, which would load them first.
 */
Object.assign(process.env, {
  APP_ORIGIN: 'https://qa-tools.ru',
  RECEIVE_ORIGIN: 'https://hook.qa-tools.ru',
  APP_ALIAS_ORIGIN: 'https://webhook.qa-tools.ru',
});

const { ABOUT_RU, ABOUT_RU_APPROVED_AGAINST } = await import('./about-copy-ru.ts');
const {
  ABOUT_DESCRIPTION,
  ABOUT_EN,
  ABOUT_EYEBROW,
  ABOUT_FACTS,
  ABOUT_HEADING,
  ABOUT_STORY,
  ABOUT_TITLE,
  ABOUT_URL,
  aboutCopyText,
} = await import('./about-copy.ts');
const { nameSite, PRODUCTION_ORIGINS, SITE_ORIGINS } =
  await import('../../scripts/site-origin.mjs');

/** A copy at another address with no second origin of its own, as `llms.test.ts` has one (#342). */
const ANOTHER: SiteOrigins = {
  app: 'https://inspector.example',
  receive: 'https://hook.inspector.example',
  alias: null,
};

/**
 * The two pages as a build for `origins` composes them: read in a Node
 * process of its own, whose environment names them, since this one's names
 * production's.
 */
function pagesBuiltFor(origins: SiteOrigins): [AboutCopy, AboutCopy] {
  const module = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const run = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const { ABOUT_EN } = await import(${module('./about-copy.ts')});
const { ABOUT_RU } = await import(${module('./about-copy-ru.ts')});
process.stdout.write(JSON.stringify([ABOUT_EN, ABOUT_RU]));`,
    ],
    {
      env: {
        ...process.env,
        APP_ORIGIN: origins.app,
        RECEIVE_ORIGIN: origins.receive,
        APP_ALIAS_ORIGIN: origins.alias ?? '',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(run.status, 0, run.stderr);

  return JSON.parse(run.stdout) as [AboutCopy, AboutCopy];
}

/**
 * `/about` and `/ru/about` held in step (issue #170, D255). The Russian page
 * is the English one's twin, approved by the owner word for word against the
 * English of 2026-10-20: the same three paragraphs with the same parts, the
 * same four facts with as many lines each, the MCP address and the mail
 * address in the same places. And because a reworded English sentence keeps
 * every one of those, the hash of the English text the Russian was approved
 * against is recorded beside it (`ABOUT_RU_APPROVED_AGAINST`): any change to
 * an English text fails here until the Russian is changed with it, approved
 * by the owner, and the hash recorded again — the lasting rule D255 states.
 */

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A run of a paragraph as the pair compares it: words by kind only, an address whole. */
const partShape = (part: AboutPart) =>
  part.kind === 'text' ? 'text' : `${part.kind} ${part.text} ${'href' in part ? part.href : ''}`;

/** What two twins must share: the parts of each paragraph and the number of lines of each fact. */
const shape = (page: AboutCopy) => ({
  story: page.story.map((paragraph) => paragraph.map(partShape)),
  facts: page.facts.map((fact) => fact.lines.length),
});

describe('the two about pages', () => {
  it('are loaded for production’s origins, whatever the shell running the tests holds (#354)', () => {
    assert.deepEqual(SITE_ORIGINS, PRODUCTION_ORIGINS);
  });

  it('has the English page gather the constants /about is written from', () => {
    assert.deepEqual(ABOUT_EN, {
      lang: 'en',
      path: '/about',
      title: ABOUT_TITLE,
      description: ABOUT_DESCRIPTION,
      url: ABOUT_URL,
      eyebrow: ABOUT_EYEBROW,
      heading: ABOUT_HEADING,
      story: ABOUT_STORY,
      facts: ABOUT_FACTS,
    });
    assert.equal(ABOUT_EN.path, ABOUT_LINK.href);
  });

  it('serves each language at its own address, the footer leading to the one shown', () => {
    assert.deepEqual(ABOUT_ADDRESSES, { en: '/about', ru: '/ru/about' });
    assert.equal(aboutAddress(ABOUT_EN.lang), ABOUT_EN.path);
    assert.equal(aboutAddress(ABOUT_RU.lang), ABOUT_RU.path);
    assert.equal(ABOUT_EN.url, `${PRODUCTION_ORIGINS.app}${ABOUT_EN.path}`);
    assert.equal(ABOUT_RU.url, `${PRODUCTION_ORIGINS.app}${ABOUT_RU.path}`);
    // Anything else is English's, as `homeAddress` reads a tag.
    for (const tag of ['', 'de', 'RU', 'ru-RU', 'toString', '__proto__']) {
      assert.equal(aboutAddress(tag), '/about', tag);
    }
  });

  it('tells the same story: three paragraphs, the same parts in the same places', () => {
    assert.equal(ABOUT_RU.story.length, 3);
    assert.deepEqual(shape(ABOUT_RU).story, shape(ABOUT_EN).story);
    assert.deepEqual(shape(ABOUT_EN).story, [
      ['text'],
      ['text', `code ${PRODUCTION_ORIGINS.app}/mcp `, 'text'],
      ['text', 'mail contact@qa-tools.ru mailto:contact@qa-tools.ru', 'text'],
    ]);
    // Each address ends its paragraph with a full stop after it, in both.
    for (const page of [ABOUT_EN, ABOUT_RU]) {
      assert.deepEqual(
        page.story.slice(1).map((paragraph) => paragraph.at(-1)),
        [
          { kind: 'text', text: '.' },
          { kind: 'text', text: '.' },
        ],
        page.lang,
      );
    }
  });

  it('states the same facts, as many and each with as many lines', () => {
    assert.equal(ABOUT_RU.facts.length, 4);
    assert.deepEqual(shape(ABOUT_RU).facts, shape(ABOUT_EN).facts);
    assert.deepEqual(shape(ABOUT_EN).facts, [3, 2, 2, 1]);
  });

  it('follows the English text the Russian was approved against', () => {
    assert.equal(
      sha256(aboutCopyText(ABOUT_EN)),
      ABOUT_RU_APPROVED_AGAINST,
      'the English about text changed: change its Russian twin in about-copy-ru.ts in the same ' +
        'merge request, have the owner approve it, and record the new hash (D255)',
    );
  });

  it('would fail on any English rewording, a moved joint or a line added', () => {
    const reworded: AboutCopy[] = [
      { ...ABOUT_EN, heading: ABOUT_EN.heading.replace('tester', 'QA engineer') },
      { ...ABOUT_EN, heading: ABOUT_EN.heading.replace('\u00a0', ' ') },
      { ...ABOUT_EN, description: `${ABOUT_EN.description} ` },
      { ...ABOUT_EN, title: 'About' },
      {
        ...ABOUT_EN,
        facts: ABOUT_EN.facts.map((fact, index) =>
          index === 3 ? { ...fact, lines: [...fact.lines, 'And one more.'] } : fact,
        ),
      },
      {
        ...ABOUT_EN,
        story: [
          ABOUT_EN.story[0] ?? [],
          ABOUT_EN.story[1] ?? [],
          [{ kind: 'text', text: 'Write to ' }, ...(ABOUT_EN.story[2] ?? []).slice(1)],
        ],
      },
    ];

    for (const page of reworded) {
      assert.notEqual(sha256(aboutCopyText(page)), ABOUT_RU_APPROVED_AGAINST);
    }

    // Moving the page or naming its language is not a rewording.
    assert.equal(
      sha256(aboutCopyText({ ...ABOUT_EN, lang: 'ru', path: '/x', url: 'https://example.com/' })),
      ABOUT_RU_APPROVED_AGAINST,
    );
  });

  it('are composed for another address as for production, but for the address, in both (D274)', () => {
    const [english, russian] = pagesBuiltFor(ANOTHER);

    // Each page's address and the MCP server's name the copy's site, and
    // nothing else of either page changes; the mail address is kept.
    assert.deepEqual(english, JSON.parse(nameSite(JSON.stringify(ABOUT_EN), ANOTHER)));
    assert.deepEqual(russian, JSON.parse(nameSite(JSON.stringify(ABOUT_RU), ANOTHER)));
    assert.equal(english.url, `${ANOTHER.app}/about`);
    assert.equal(russian.url, `${ANOTHER.app}/ru/about`);
    assert.deepEqual(shape(russian).story, shape(english).story);
    assert.deepEqual(shape(english).story[1], ['text', `code ${ANOTHER.app}/mcp `, 'text']);
  });
});
