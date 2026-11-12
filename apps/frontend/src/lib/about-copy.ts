import { APP_ORIGIN } from '../../scripts/site-origin.mjs';
import { mailtoOf, OPERATOR, type Operator } from './operator.ts';

/**
 * The text of `/about` (issue #131, D211): who runs QA Tools, how it is made,
 * who pays for it and what happens to the data people send. The wording was
 * approved with direction D1 of the Figma page `Webhook Inspector
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
 * when it names one. So is, since issue #380, the line of `How it's built`
 * in the operator's first person, and the page's title and meta
 * description, which name QA Tools: a build without the texts keeps the
 * fact's other two lines, and its head names the service, Webhook
 * Inspector, and the two facts the page keeps. So are, since issue #464,
 * the eyebrow and the second paragraph's name of the service, QA Tools
 * with the texts and Webhook Inspector without them, so that a copy's page
 * names the copy from its tab to its body. The rest describes the service
 * itself and is always there. `composeAbout()` makes that choice for both
 * languages, from the parts each writes (`AboutText`), so the two pages
 * leave out the same places.
 *
 * `ABOUT_EN` gathers them into the page's object, of the type its Russian
 * twin `ABOUT_RU` (`about-copy-ru.ts`, issue #170, D255) shares, so one
 * renderer writes both pages. A change to any English text here changes the
 * Russian twin in the same merge request, approved with it (D255):
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

/** A page's `<title>` and its meta description, which the build writes into its template's head. */
export interface AboutHead {
  readonly title: string;
  readonly description: string;
}

/** The fact `How it's built`, line by line, as `composeAbout()` puts its lines together. */
export interface AboutHowItIsBuilt {
  readonly label: string;
  /** Who writes, tests and reviews the code: AI agents. Always there. */
  readonly writtenBy: string;
  /**
   * Who decides what to build and approves every design: the operator, in
   * the first person, so there only with the operator's texts (issue #380).
   */
  readonly decidedBy: string;
  /** What it is made of and runs on. Always there. */
  readonly madeOf: string;
}

/** The languages the about page is written in (D211, D255). */
export type AboutLanguage = 'en' | 'ru';

/** Everything one language's about page says, its head included (D255). */
export interface AboutCopy {
  /** Its `<html lang>`, and the language of the header and the band it draws. */
  readonly lang: AboutLanguage;
  /** Where the site serves it, and where its footer link points. */
  readonly path: string;
  /** Its `<title>`, meta description and canonical address; the first two the build's operator's (`composeAbout`). */
  readonly title: string;
  readonly description: string;
  readonly url: string;
  /** The eyebrow above the title, in capitals as the home page's is; the build's operator's (`composeAbout`). */
  readonly eyebrow: string;
  readonly heading: string;
  /** The story: three paragraphs, those the build has (`composeAbout`). */
  readonly story: readonly (readonly AboutPart[])[];
  /** The four facts, in the order the page lists them, those the build has. */
  readonly facts: readonly AboutFact[];
}

/** The MCP server's address (D203), which the second paragraph names, on this build's site (D274). */
export const MCP_SERVER_URL = `${APP_ORIGIN}/mcp`;

/**
 * The page's `<title>` and its meta description with the operator's texts,
 * production's, which `about/index.html` is written with, and where it is
 * served.
 */
export const ABOUT_TITLE = 'About QA Tools';
export const ABOUT_DESCRIPTION =
  'Who runs QA Tools, how it is built, who pays for it and what happens to your data.';
export const ABOUT_URL = `${APP_ORIGIN}/about`;

/**
 * The page's `<title>` and its meta description without the operator's
 * texts (issue #380): the service's own name, and the two facts such a page
 * keeps, so that a search result promises nothing the page leaves out.
 */
export const ABOUT_TITLE_WITHOUT_TEXTS = 'About Webhook Inspector';
export const ABOUT_DESCRIPTION_WITHOUT_TEXTS =
  'How Webhook Inspector is built and what happens to your data.';

/**
 * The eyebrow above the title, written in capitals as the home page's is:
 * with the operator's texts, production's, naming QA Tools, and without
 * them naming the service, as the page's title then does (issue #464).
 */
export const ABOUT_EYEBROW = 'ABOUT QA TOOLS';
export const ABOUT_EYEBROW_WITHOUT_TEXTS = 'ABOUT WEBHOOK INSPECTOR';

export const ABOUT_HEADING = 'Made by a tester, for\u00a0testers';

/**
 * One language's head, eyebrow, story and facts, by part, as
 * `composeAbout()` puts them together for a build's operator (issues #369,
 * #380, #464).
 */
export interface AboutText {
  /** The head with the operator's texts, naming QA Tools: the one the page's template is written with. */
  readonly head: AboutHead;
  /** The head without them, naming the service (issue #380). */
  readonly headWithoutTexts: AboutHead;
  /** The eyebrow with the operator's texts, naming QA Tools. */
  readonly eyebrow: string;
  /** The eyebrow without them, naming the service (issue #464). */
  readonly eyebrowWithoutTexts: string;
  /** The first paragraph, who runs the service: the operator's text. */
  readonly whoRunsIt: readonly AboutPart[];
  /**
   * The second, how it is made and for whom, ending in the MCP address:
   * always there, naming QA Tools with the operator's texts.
   */
  readonly madeForAgents: readonly AboutPart[];
  /** The second paragraph without them, the service's name in place of QA Tools and every other word kept (issue #464). */
  readonly madeForAgentsWithoutTexts: readonly AboutPart[];
  /** The third, around the contact address, there when the build names one. */
  readonly writeTo: (mail: AboutPart) => readonly AboutPart[];
  /**
   * The four facts, in the order the page lists them: the second and the
   * fourth are the operator's, and so is the first's `decidedBy` line.
   */
  readonly howItIsBuilt: AboutHowItIsBuilt;
  readonly whoPays: AboutFact;
  readonly yourData: AboutFact;
  readonly securityReviews: AboutFact;
}

/**
 * A page's head, eyebrow, story and facts for `operator`: every part when it
 * shows its texts and names its contact address, as production's build
 * does, and the parts about the service alone, under the head and the
 * eyebrow that name it, when it does neither.
 */
export function composeAbout(
  text: AboutText,
  operator: Operator,
): Pick<AboutCopy, 'title' | 'description' | 'eyebrow' | 'story' | 'facts'> {
  const contact = operator.contactEmail;
  const built = text.howItIsBuilt;
  const howItIsBuilt: AboutFact = {
    label: built.label,
    lines: operator.texts
      ? [built.writtenBy, built.decidedBy, built.madeOf]
      : [built.writtenBy, built.madeOf],
  };
  const head = operator.texts ? text.head : text.headWithoutTexts;

  return {
    title: head.title,
    description: head.description,
    eyebrow: operator.texts ? text.eyebrow : text.eyebrowWithoutTexts,
    story: [
      ...(operator.texts ? [text.whoRunsIt] : []),
      operator.texts ? text.madeForAgents : text.madeForAgentsWithoutTexts,
      ...(contact === null
        ? []
        : [text.writeTo({ kind: 'mail', text: contact, href: mailtoOf(contact) })]),
    ],
    facts: operator.texts
      ? [howItIsBuilt, text.whoPays, text.yourData, text.securityReviews]
      : [howItIsBuilt, text.yourData],
  };
}

/** The English head, eyebrow, story and facts, word for word as approved. */
export const ABOUT_TEXT_EN: AboutText = {
  head: { title: ABOUT_TITLE, description: ABOUT_DESCRIPTION },
  headWithoutTexts: {
    title: ABOUT_TITLE_WITHOUT_TEXTS,
    description: ABOUT_DESCRIPTION_WITHOUT_TEXTS,
  },
  eyebrow: ABOUT_EYEBROW,
  eyebrowWithoutTexts: ABOUT_EYEBROW_WITHOUT_TEXTS,
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
  madeForAgentsWithoutTexts: [
    {
      kind: 'text',
      text: 'It is written by AI agents and made for them too: an AI agent can work with Webhook Inspector through its MCP server, ',
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
    writtenBy:
      'Written entirely by AI agents: Claude Code writes, tests and\u00a0reviews\u00a0the\u00a0code.',
    decidedBy:
      'I decide what to build and approve every design, drawn\u00a0in\u00a0Figma\u00a0first.',
    madeOf:
      'TypeScript, React and Fastify, PostgreSQL, a small Kubernetes\u00a0cluster\u00a0(k3s).',
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

/** The English page, `/about`, for `operator`'s build (issues #369, #380, #464). */
export function aboutEnglish(operator: Operator = OPERATOR): AboutCopy {
  const { title, description, eyebrow, story, facts } = composeAbout(ABOUT_TEXT_EN, operator);

  return {
    lang: 'en',
    path: '/about',
    title,
    description,
    url: ABOUT_URL,
    eyebrow,
    heading: ABOUT_HEADING,
    story,
    facts,
  };
}

/** The English page, `/about`, from the constants above: this build's. */
export const ABOUT_EN: AboutCopy = aboutEnglish();

/** The story of this build's English page: three paragraphs as approved, those it has. */
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
