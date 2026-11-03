import { APP_ORIGIN } from '../../scripts/site-origin.mjs';
import { mailtoOf, OPERATOR, type Operator } from './operator.ts';

/**
 * The text of `/about` (issue #131, D211): who runs QA Tools, how it is made,
 * who pays for it and what happens to the data people send. The wording is
 * the owner's, approved with direction D1 of the Figma page `Webhook Inspector
 * · About page (#131)` on 2026-10-08, the `Security reviews` line as the legal
 * pages' `Contact` line on 2026-10-11 (issue #163, D224), and
 * `about-copy.test.ts` pins every text byte for byte.
 *
 * `\u00a0` is a no-break space and `\u2011` a no-break hyphen: they keep a
 * phrase whole, so that no line of the page ends with a single word (the
 * handoff note `748:580`). An ordinary space never stands beside either.
 *
 * `scripts/about.mjs` writes the page from these constants at build time, so
 * the page is readable without JavaScript. The module has no imports but
 * `operator.ts`, which has none, and `scripts/site-origin.mjs`, the build's
 * origin (D274), so Node loads both as TypeScript there. The browser never
 * loads it.
 *
 * Some of it is the operator's (issue #369, `operator.ts`): the first
 * paragraph, who runs the service, and the facts `Who pays for it` and
 * `Security reviews` are there only when the build shows the operator's
 * texts, and the third paragraph, which ends in the contact address, only
 * when it names one. The rest describes the service itself and is always
 * there. `composeAbout()` makes that choice for both languages, from the
 * parts each writes (`AboutText`), so the two pages leave out the same
 * places.
 *
 * `ABOUT_EN` gathers them into the page's object, of the type its Russian
 * twin `ABOUT_RU` (`about-copy-ru.ts`, issue #170, D255) shares, so one
 * renderer writes both pages. A change to any English text here changes the
 * Russian twin in the same merge request, approved by the owner (D255):
 * `about-pair.test.ts` holds the two in step and fails on any English
 * rewording until the Russian is updated.
 */

/** One run of text in a story paragraph: words, the MCP address, or the mail address. */
export type AboutPart =
  | { readonly kind: 'text'; readonly text: string }
  /** Shown in the monospace face and never linked: the address answers `POST` only (D203). */
  | { readonly kind: 'code'; readonly text: string }
  /** The operator's contact address (`contact.ts`), a `mailto:` link. */
  | { readonly kind: 'mail'; readonly text: string; readonly href: string };

/** A fact: its label, and its lines, each a line of text of its own. */
export interface AboutFact {
  readonly label: string;
  readonly lines: readonly string[];
}

/** The languages the about page is written in (D211, D255). */
export type AboutLanguage = 'en' | 'ru';

/** Everything one language's about page says, its head included (D255). */
export interface AboutCopy {
  /** Its `<html lang>`, and the language of the header and the band it draws. */
  readonly lang: AboutLanguage;
  /** Where the site serves it, and where its footer link points. */
  readonly path: string;
  /** Its `<title>`, meta description and canonical address. */
  readonly title: string;
  readonly description: string;
  readonly url: string;
  /** The eyebrow above the title, in capitals as the home page's is. */
  readonly eyebrow: string;
  readonly heading: string;
  /** The story: three paragraphs, those the build has (`composeAbout`). */
  readonly story: readonly (readonly AboutPart[])[];
  /** The four facts, in the order the page lists them, those the build has. */
  readonly facts: readonly AboutFact[];
}

/** The MCP server's address (D203), which the second paragraph names, on this build's site (D274). */
export const MCP_SERVER_URL = `${APP_ORIGIN}/mcp`;

/** The page's `<title>`, its meta description, and where it is served. */
export const ABOUT_TITLE = 'About QA Tools';
export const ABOUT_DESCRIPTION =
  'Who runs QA Tools, how it is built, who pays for it and what happens to your data.';
export const ABOUT_URL = `${APP_ORIGIN}/about`;

/** The eyebrow above the title, written in capitals as the home page's is. */
export const ABOUT_EYEBROW = 'ABOUT QA TOOLS';

export const ABOUT_HEADING = 'Made by a tester, for\u00a0testers';

/**
 * One language's story and facts, by part, as `composeAbout()` puts them
 * together for a build's operator (issue #369).
 */
export interface AboutText {
  /** The first paragraph, who runs the service: the operator's text. */
  readonly whoRunsIt: readonly AboutPart[];
  /** The second, how it is made and for whom, ending in the MCP address: always there. */
  readonly madeForAgents: readonly AboutPart[];
  /** The third, around the contact address, there when the build names one. */
  readonly writeTo: (mail: AboutPart) => readonly AboutPart[];
  /** The four facts, in the order the page lists them: the second and the fourth are the operator's. */
  readonly howItIsBuilt: AboutFact;
  readonly whoPays: AboutFact;
  readonly yourData: AboutFact;
  readonly securityReviews: AboutFact;
}

/**
 * A page's story and facts for `operator`: every part when it shows its
 * texts and names its contact address, as production's build does, and the
 * parts about the service alone when it does neither.
 */
export function composeAbout(
  text: AboutText,
  operator: Operator,
): Pick<AboutCopy, 'story' | 'facts'> {
  const contact = operator.contactEmail;

  return {
    story: [
      ...(operator.texts ? [text.whoRunsIt] : []),
      text.madeForAgents,
      ...(contact === null
        ? []
        : [text.writeTo({ kind: 'mail', text: contact, href: mailtoOf(contact) })]),
    ],
    facts: operator.texts
      ? [text.howItIsBuilt, text.whoPays, text.yourData, text.securityReviews]
      : [text.howItIsBuilt, text.yourData],
  };
}

/** The English story and facts, in the owner's words. */
export const ABOUT_TEXT_EN: AboutText = {
  whoRunsIt: [
    {
      kind: 'text',
      text: "I'm a software tester, and I build tools for testers. QA Tools is my personal project and a research one too: I use it to learn and\u00a0to\u00a0grow.",
    },
  ],
  madeForAgents: [
    {
      kind: 'text',
      text: 'It is written by AI agents and made for them too: an AI agent can work with QA Tools through its MCP server, ',
    },
    { kind: 'code', text: MCP_SERVER_URL },
    { kind: 'text', text: '.' },
  ],
  writeTo: (mail) => [
    {
      kind: 'text',
      text: "I'll be glad if you use it, and glad to hear what\u00a0you\u00a0think: ",
    },
    mail,
    { kind: 'text', text: '.' },
  ],
  howItIsBuilt: {
    label: "How it's built",
    lines: [
      'Written entirely by AI agents: Claude Code writes, tests and\u00a0reviews\u00a0the\u00a0code.',
      'I decide what to build and approve every design, drawn\u00a0in\u00a0Figma\u00a0first.',
      'TypeScript, React and Fastify, PostgreSQL, a small Kubernetes\u00a0cluster\u00a0(k3s).',
    ],
  },
  whoPays: {
    label: 'Who pays for it',
    lines: [
      'I do, and using QA Tools is free.',
      'What is free today stays free; if paid plans ever come, they will be\u00a0extras\u00a0for\u00a0teams.',
    ],
  },
  yourData: {
    label: 'Your data',
    lines: [
      'No ads, no cookies and\u00a0no\u00a0third\u2011party\u00a0analytics.',
      'Captured requests are\u00a0never\u00a0sold\u00a0or\u00a0shared.',
    ],
  },
  securityReviews: {
    label: 'Security reviews',
    lines: [
      "Companies can ask for the operator's details, or for a data processing agreement, by\u00a0email.",
    ],
  },
};

/** The English page, `/about`, for `operator`'s build (issue #369). */
export function aboutEnglish(operator: Operator = OPERATOR): AboutCopy {
  return {
    lang: 'en',
    path: '/about',
    title: ABOUT_TITLE,
    description: ABOUT_DESCRIPTION,
    url: ABOUT_URL,
    eyebrow: ABOUT_EYEBROW,
    heading: ABOUT_HEADING,
    ...composeAbout(ABOUT_TEXT_EN, operator),
  };
}

/** The English page, `/about`, from the constants above: this build's. */
export const ABOUT_EN: AboutCopy = aboutEnglish();

/** The story of this build's English page: three paragraphs in the owner's words, those it has. */
export const ABOUT_STORY: readonly (readonly AboutPart[])[] = ABOUT_EN.story;

/** The facts of this build's English page, in the order it lists them. */
export const ABOUT_FACTS: readonly AboutFact[] = ABOUT_EN.facts;

/** A story paragraph as plain text, the way it reads. */
export function aboutParagraphText(paragraph: readonly AboutPart[]): string {
  return paragraph.map((part) => part.text).join('');
}

/**
 * Every text a reader meets on a page, its head's included, in order, as one
 * string: what `ABOUT_RU_APPROVED_AGAINST` records the hash of (D255). Its
 * address and language are left out: moving the page is no rewording.
 */
export function aboutCopyText(page: AboutCopy): string {
  return JSON.stringify([
    page.title,
    page.description,
    page.eyebrow,
    page.heading,
    page.story,
    page.facts,
  ]);
}
