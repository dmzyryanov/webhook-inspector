import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { ABOUT_RU, ABOUT_RU_APPROVED_AGAINST } from './about-copy-ru.ts';
import {
  ABOUT_DESCRIPTION,
  ABOUT_EN,
  ABOUT_EYEBROW,
  ABOUT_FACTS,
  ABOUT_HEADING,
  ABOUT_STORY,
  ABOUT_TITLE,
  ABOUT_URL,
  aboutCopyText,
  type AboutCopy,
  type AboutPart,
} from './about-copy.ts';
import { ABOUT_ADDRESSES, ABOUT_LINK, aboutAddress } from './about-link.ts';
import { APP_ORIGIN } from '../../scripts/site-origin.mjs';

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
    assert.equal(ABOUT_EN.url, `${APP_ORIGIN}${ABOUT_EN.path}`);
    assert.equal(ABOUT_RU.url, `${APP_ORIGIN}${ABOUT_RU.path}`);
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
      ['text', `code ${APP_ORIGIN}/mcp `, 'text'],
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
});
