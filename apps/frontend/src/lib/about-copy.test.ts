import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ABOUT_DESCRIPTION,
  ABOUT_DESCRIPTION_WITHOUT_TEXTS,
  ABOUT_EYEBROW,
  ABOUT_FACTS,
  ABOUT_HEADING,
  ABOUT_STORY,
  ABOUT_TEXT_EN,
  ABOUT_TITLE,
  ABOUT_TITLE_WITHOUT_TEXTS,
  ABOUT_URL,
  aboutEnglish,
  aboutParagraphText,
  MCP_SERVER_URL,
} from './about-copy.ts';
import { CONTACT_ADDRESS, CONTACT_MAILTO } from './contact.ts';
import { LEGAL_PAGES } from './legal-copy.ts';
import { NO_OPERATOR, parseOperator } from './operator.ts';
import { APP_ORIGIN } from '../../scripts/site-origin.mjs';

/**
 * The text of `/about` (issue #131, D211), exactly as approved on
 * 2026-10-08: every text of the issue's Scope 2, byte for byte, its no-break
 * spaces and its no-break hyphen included, and the `Security reviews` line as
 * approved for the legal pages' `Contact` on 2026-10-11 (issue #163, D224).
 * `about-page.test.ts` shows the page writes these constants as they are.
 */

const NBSP = String.fromCharCode(0xa0);
const NBH = String.fromCharCode(0x2011);

/**
 * A text as the issue writes it: ` NBSP ` is one no-break space (U+00A0) and
 * ` NBH ` one no-break hyphen (U+2011), each with no ordinary space beside it.
 */
const approved = (text: string) => text.replaceAll(' NBSP ', NBSP).replaceAll(' NBH ', NBH);

/** Every text of the page, label by label. */
const everyText = () => [
  ABOUT_EYEBROW,
  ABOUT_HEADING,
  ...ABOUT_STORY.map(aboutParagraphText),
  ...ABOUT_FACTS.flatMap((fact) => [fact.label, ...fact.lines]),
];

describe('the about page text (Scope 2)', () => {
  it('has the eyebrow and the title the owner approved', () => {
    assert.equal(ABOUT_EYEBROW, 'ABOUT QA TOOLS');
    assert.equal(ABOUT_HEADING, approved('Made by a tester, for NBSP testers'));
    assert.equal(ABOUT_HEADING, `Made by a tester, for${NBSP}testers`);
  });

  it('tells the story in three paragraphs, byte for byte', () => {
    assert.deepEqual(ABOUT_STORY.map(aboutParagraphText), [
      approved(
        "I'm a software tester, and I build tools for testers. QA Tools is my personal project and a research one too: I use it to learn and NBSP to NBSP grow.",
      ),
      `It is written by AI agents and made for them too: an AI agent can work with QA Tools through its MCP server, ${APP_ORIGIN}/mcp.`,
      approved(
        "I'll be glad if you use it, and glad to hear what NBSP you NBSP think: contact@qa-tools.ru.",
      ),
    ]);
  });

  it('shows the MCP address as code, not a link, and the contact address as mail from contact.ts', () => {
    assert.equal(MCP_SERVER_URL, `${APP_ORIGIN}/mcp`);
    assert.deepEqual(
      ABOUT_STORY.map((paragraph) => paragraph.map((part) => part.kind)),
      [['text'], ['text', 'code', 'text'], ['text', 'mail', 'text']],
    );
    assert.deepEqual(ABOUT_STORY[1]?.[1], { kind: 'code', text: MCP_SERVER_URL });
    assert.deepEqual(ABOUT_STORY[2]?.[1], {
      kind: 'mail',
      text: CONTACT_ADDRESS,
      href: CONTACT_MAILTO,
    });
    assert.equal(CONTACT_MAILTO, 'mailto:contact@qa-tools.ru');
  });

  it('states the four facts, each line its own, byte for byte', () => {
    assert.deepEqual(ABOUT_FACTS, [
      {
        label: "How it's built",
        lines: [
          approved(
            'Written entirely by AI agents: Claude Code writes, tests and NBSP reviews NBSP the NBSP code.',
          ),
          approved(
            'I decide what to build and approve every design, drawn NBSP in NBSP Figma NBSP first.',
          ),
          approved(
            'TypeScript, React and Fastify, PostgreSQL, a small Kubernetes NBSP cluster NBSP (k3s).',
          ),
        ],
      },
      {
        label: 'Who pays for it',
        lines: [
          'I do, and using QA Tools is free.',
          approved(
            'What is free today stays free; if paid plans ever come, they will be NBSP extras NBSP for NBSP teams.',
          ),
        ],
      },
      {
        label: 'Your data',
        lines: [
          approved('No ads, no cookies and NBSP no NBSP third NBH party NBSP analytics.'),
          approved('Captured requests are NBSP never NBSP sold NBSP or NBSP shared.'),
        ],
      },
      {
        label: 'Security reviews',
        lines: [
          approved(
            "Companies can ask for the operator's details, or for a data processing agreement, by NBSP email.",
          ),
        ],
      },
    ]);
  });

  it('offers in Security reviews what the Terms and the Privacy Policy offer in Contact (D224)', () => {
    const security = ABOUT_FACTS.find((fact) => fact.label === 'Security reviews');

    assert.equal(security?.lines.length, 1);

    for (const page of LEGAL_PAGES) {
      const contact = page.sections.find((section) => section.label === 'Contact');

      assert.equal(contact?.lines.at(-1), security?.lines[0], page.path);
    }
  });

  it('joins exactly the approved phrases, with no ordinary space beside a joint', () => {
    const joined = everyText()
      .flatMap((text) => [
        ...text.matchAll(/[^\s\u00a0\u2011]+(?:[\u00a0\u2011][^\s\u00a0\u2011]+)+/g),
      ])
      .map((match) => match[0].replaceAll(NBSP, '_').replaceAll(NBH, '~'));

    assert.deepEqual(joined, [
      'for_testers',
      'and_to_grow.',
      'what_you_think:',
      'and_reviews_the_code.',
      'drawn_in_Figma_first.',
      'Kubernetes_cluster_(k3s).',
      'be_extras_for_teams.',
      'and_no_third~party_analytics.',
      'are_never_sold_or_shared.',
      'by_email.',
    ]);

    for (const text of everyText()) {
      assert.doesNotMatch(text, / [\u00a0\u2011]|[\u00a0\u2011] /, text);
      // Nothing else outside ASCII: the apostrophes are U+0027, as written.
      assert.doesNotMatch(text, /[^\x20-\x7e\u00a0\u2011]/, text);
    }

    assert.equal(everyText().join('').split(NBH).length - 1, 1);
  });

  it('describes the page for search results and link previews', () => {
    assert.equal(ABOUT_TITLE, 'About QA Tools');
    assert.equal(
      ABOUT_DESCRIPTION,
      'Who runs QA Tools, how it is built, who pays for it and what happens to your data.',
    );
    assert.equal(ABOUT_URL, `${APP_ORIGIN}/about`);
  });
});

/**
 * The words of a page built without the operator's texts (issue #380), as
 * agreed on 2026-11-10: the service's own name in the title
 * and the meta description, which promises only the two facts such a page
 * keeps, and `How it's built` without its line in the operator's first
 * person, its other two lines as they are.
 */
describe('the about page text of a build without the operator’s texts (issue #380)', () => {
  /** A copy with a contact address and no texts, which keeps the third paragraph. */
  const CONTACT_ONLY = parseOperator({ CONTACT_EMAIL: 'hello@inspector.example' });

  it('names the service in the title and promises only the facts the page keeps', () => {
    assert.equal(ABOUT_TITLE_WITHOUT_TEXTS, 'About Webhook Inspector');
    assert.equal(
      ABOUT_DESCRIPTION_WITHOUT_TEXTS,
      'How Webhook Inspector is built and what happens to your data.',
    );

    for (const operator of [NO_OPERATOR, CONTACT_ONLY]) {
      const page = aboutEnglish(operator);

      assert.equal(page.title, ABOUT_TITLE_WITHOUT_TEXTS);
      assert.equal(page.description, ABOUT_DESCRIPTION_WITHOUT_TEXTS);
      // Neither QA Tools nor who runs or pays for it.
      for (const text of [page.title, page.description]) {
        assert.doesNotMatch(text, /QA Tools|runs|pays|\bI\b/, text);
        assert.doesNotMatch(text, /[^\x20-\x7e]/, text);
      }
      assert.deepEqual(
        page.facts.map((fact) => fact.label),
        ["How it's built", 'Your data'],
      );
    }
  });

  it('leaves out the first-person line of How it’s built and keeps its other two as they are', () => {
    assert.equal(
      ABOUT_TEXT_EN.howItIsBuilt.decidedBy,
      approved(
        'I decide what to build and approve every design, drawn NBSP in NBSP Figma NBSP first.',
      ),
    );

    for (const operator of [NO_OPERATOR, CONTACT_ONLY]) {
      assert.deepEqual(aboutEnglish(operator).facts[0], {
        label: "How it's built",
        lines: [
          approved(
            'Written entirely by AI agents: Claude Code writes, tests and NBSP reviews NBSP the NBSP code.',
          ),
          approved(
            'TypeScript, React and Fastify, PostgreSQL, a small Kubernetes NBSP cluster NBSP (k3s).',
          ),
        ],
      });
      assert.ok(
        aboutEnglish(operator).facts.every((fact) =>
          fact.lines.every((line) => !/\bI\b|\bI'/.test(line)),
        ),
      );
    }

    // With the texts, the fact has its three lines in order, the line on who
    // decides between the other two, as `ABOUT_FACTS` pins them above.
    assert.deepEqual(ABOUT_FACTS[0]?.lines, [
      ABOUT_TEXT_EN.howItIsBuilt.writtenBy,
      ABOUT_TEXT_EN.howItIsBuilt.decidedBy,
      ABOUT_TEXT_EN.howItIsBuilt.madeOf,
    ]);
  });

  it('keeps production’s title and description in a build with the operator’s texts', () => {
    assert.deepEqual(ABOUT_TEXT_EN.head, { title: ABOUT_TITLE, description: ABOUT_DESCRIPTION });
    assert.deepEqual(ABOUT_TEXT_EN.headWithoutTexts, {
      title: ABOUT_TITLE_WITHOUT_TEXTS,
      description: ABOUT_DESCRIPTION_WITHOUT_TEXTS,
    });
  });
});
