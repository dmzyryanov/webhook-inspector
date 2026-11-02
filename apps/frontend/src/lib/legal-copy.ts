import { APP_ORIGIN } from '../../scripts/site-origin.mjs';
import { CONTACT_ADDRESS, CONTACT_MAILTO } from './contact.ts';

/**
 * The texts of the Terms of Use, `/terms`, and the Privacy Policy, `/privacy`
 * (issue #112, D217): what QA Tools is and is not, what may not be done with
 * it, what it stores, for how long, who can see it, where it is, which law
 * governs the terms, how a change is announced and whom to write to. The
 * wording is the owner's, approved with the frames of the Figma page `Webhook
 * Inspector · Terms and Privacy (#112)` on 2026-10-09, with the Privacy
 * Policy's `In your browser` (#108) and `Logs` (#155) lines amended by the
 * owner on 2026-10-10 and, for the governing law, the 14 days' notice of a
 * change and the data processing agreement, on 2026-10-11 (issue #163, D224),
 * the `Logs` line on limits, which the connection limits keep true, on
 * 2026-10-11 as a correction rather than an announced change (issue #145,
 * D227), and the `Logs` line on the proxy's error log, added by the owner's
 * decision of 2026-10-12 as a correction too (issue #185, D231), and the
 * first dated announcement in `Changes to this policy`, the owner's words of
 * 2026-10-18 with the day the change applies (issue #214, D224), and the
 * response rules among what a session keeps, by the owner's decision 7 of
 * issue #134 of 2026-10-19, published at once: session configuration, not
 * data about people (D246, amending D224), and who can see a private session
 * and the fingerprint of its key it keeps, the owner's words of 2026-10-20,
 * published at once with no notice: fewer people can see a session, and the
 * fingerprint says nothing about a person (issue #227, D253), and the 90 days
 * a day's sender networks are kept, option (b) of the owner's word of
 * 2026-10-20, published at once: it keeps less (issue #165, D254), and the
 * access keys of private sessions in `In your browser`, the owner's decision 4
 * of issue #228 of 2026-10-19, published at once: what only the browser keeps
 * applies when published (D224, D259), and the second dated announcement in
 * `Changes to this policy`, the owner's words of 2026-10-24 with the day the
 * contact address's mail moves to Yandex 360, a new provider (issue #275,
 * D224); each page
 * is one constant, and `legal-copy.test.ts` pins both byte for byte;
 * `legal-facts.test.ts` holds every number in them, and the facts of the
 * proxy's line, to their sources.
 *
 * `\u00a0` is a no-break space and `\u2011` a no-break hyphen: they join the
 * last words of a line, so that no line of a page ends with a single word
 * (D211's rule). An ordinary space never stands beside either.
 *
 * `scripts/legal.mjs` writes both pages from these constants at build time,
 * so they are readable without JavaScript. The module has no imports but
 * `contact.ts`, which has none, and `scripts/site-origin.mjs`, the build's
 * origin (D274), so Node loads both as TypeScript there. The browser never
 * loads it.
 */

/** One run of a line: words, the contact address as mail, or a link to a page. */
export type LegalPart =
  | { readonly kind: 'text'; readonly text: string }
  /** The project's contact address (`contact.ts`), a `mailto:` link kept whole on one line. */
  | { readonly kind: 'mail'; readonly text: string; readonly href: string }
  /** A link to a page of the site. */
  | { readonly kind: 'link'; readonly text: string; readonly href: string };

/** A line of a section: plain text, or runs when it holds a link. */
export type LegalLine = string | readonly LegalPart[];

/** A section: its label, and its lines, each a line of text of its own. */
export interface LegalSection {
  readonly label: string;
  readonly lines: readonly LegalLine[];
}

/** Everything one page says, its head included. */
export interface LegalPage {
  /** Where the site serves it, and its footer link points. */
  readonly path: string;
  /** Its `<title>`, meta description and canonical address. */
  readonly title: string;
  readonly description: string;
  readonly url: string;
  /** The eyebrow above the title, in capitals as the home page's is. */
  readonly eyebrow: string;
  readonly heading: string;
  readonly introduction: string;
  /** `Last updated <day> <Month> <year>`: the day the current text shipped. */
  readonly updated: string;
  readonly sections: readonly LegalSection[];
}

/**
 * Where `stability policy` leads: the Stability section of the API reference
 * (D212). Scalar names a heading of the description `api-1/description/<slug>`
 * (`e2e/legal.spec.ts` follows the link there).
 */
export const STABILITY_POLICY_HREF = '/docs#api-1/description/stability';

/** The contact address as a run of a line. */
const mail: LegalPart = { kind: 'mail', text: CONTACT_ADDRESS, href: CONTACT_MAILTO };

/** The last line of both pages' `Contact` section. */
const OPERATOR_DETAILS =
  "Companies can ask for the operator's details, or for a data processing agreement, by\u00a0email.";

/** The Terms of Use, `/terms`. */
export const TERMS_PAGE: LegalPage = {
  path: '/terms',
  title: 'Terms of Use — QA Tools',
  description:
    'The rules for using QA Tools: your sessions, the limits, what is not allowed, and whom to write to.',
  url: `${APP_ORIGIN}/terms`,
  eyebrow: 'TERMS OF USE',
  heading: 'The rules for using QA\u00a0Tools',
  introduction:
    'QA\u00a0Tools is a free tool for testing and debugging webhooks. By using its site, API or MCP server, you agree to these terms. They are short and in plain\u00a0words.',
  updated: 'Last updated 11 October 2026',
  sections: [
    {
      label: 'Your sessions',
      lines: [
        "A session's address is its key: 43\u00a0random letters and digits, far too many to\u00a0guess.",
        'Anyone who has it can see, change and delete the\u00a0session.',
        'Keep it safe, and give it only to people and systems you\u00a0trust.',
      ],
    },
    {
      label: 'Limits',
      lines: [
        'A request body can be up\u00a0to\u00a01\u00a0MB; larger requests are\u00a0refused.',
        'A session keeps its newest 1,000\u00a0requests and is deleted 7\u00a0days after its last\u00a0use.',
        'The API allows 60 new sessions and 1,200 other calls a minute from one\u00a0address.',
      ],
    },
    {
      label: 'Not allowed',
      lines: [
        "Serving phishing pages, malware or other harmful content through a session's\u00a0response.",
        'Using QA\u00a0Tools to attack, scan or flood other\u00a0systems.',
        'Deliberately overloading QA\u00a0Tools, or using it for anything\u00a0unlawful.',
      ],
    },
    {
      label: 'If the rules are broken',
      lines: [
        'I may delete a session or block traffic from an address, without\u00a0notice.',
        'I do so when these terms are broken or the service is at\u00a0risk.',
      ],
    },
    {
      label: 'Changes to the service',
      lines: [
        [
          { kind: 'text', text: 'API changes follow the ' },
          { kind: 'link', text: 'stability policy', href: STABILITY_POLICY_HREF },
          { kind: 'text', text: ' in the\u00a0API\u00a0docs.' },
        ],
        "If QA\u00a0Tools is ever shut down, I'll announce it here at least 30\u00a0days ahead, unless an emergency leaves no\u00a0time.",
      ],
    },
    {
      label: 'Liability',
      lines: [
        "As far as the law allows, I'm not liable for any loss caused by using QA\u00a0Tools.",
      ],
    },
    {
      label: 'Changes to the terms',
      lines: [
        'The date at the top shows the current version. A new version is announced here at least 14\u00a0days before it applies. Changes the law requires, changes needed to protect the service, and changes that only add to your rights apply when\u00a0published.',
      ],
    },
    {
      label: 'Governing law',
      lines: ['These terms are governed by the law of the Russian\u00a0Federation.'],
    },
    {
      label: 'Contact',
      lines: [
        [
          { kind: 'text', text: 'Write to ' },
          mail,
          {
            kind: 'text',
            text: ' with questions, abuse reports and requests to delete\u00a0data.',
          },
        ],
        OPERATOR_DETAILS,
      ],
    },
  ],
};

/** The Privacy Policy, `/privacy`. */
export const PRIVACY_PAGE: LegalPage = {
  path: '/privacy',
  title: 'Privacy Policy — QA Tools',
  description:
    'Everything QA Tools stores, who can see it, where it is kept and when it is deleted.',
  url: `${APP_ORIGIN}/privacy`,
  eyebrow: 'PRIVACY POLICY',
  heading: 'What QA\u00a0Tools keeps, and for how\u00a0long',
  introduction:
    'Everything QA\u00a0Tools stores, who can see it, where it is kept and when it is deleted. This page describes the service as it works today, and changes when it\u00a0does.',
  updated: 'Last updated 25 October 2026',
  sections: [
    {
      label: 'What a session keeps',
      lines: [
        'Every request it captures, exactly as received: method, path, query\u00a0string, headers and body up\u00a0to\u00a01\u00a0MB.',
        "With each one, its size, time and the sender's IP\u00a0address.",
        "A session created with the sender's IP turned off keeps no sender IP\u00a0address; the headers the sender sent are kept as\u00a0sent.",
        'The answer the session sent back, and the response, response queue and response rules you set\u00a0up.',
        'A private session keeps a fingerprint of its access key, never the key\u00a0itself.',
      ],
    },
    {
      label: 'Who can see it',
      lines: [
        "Anyone with the session's URL — on its page, through the API or through the MCP\u00a0server — unless the session is\u00a0private.",
        'A private session: only someone with its access key. Its URL only sends requests to\u00a0it.',
        'I can, as the operator. Nobody else: captured requests are never sold or\u00a0shared.',
        'Session pages are hidden from search\u00a0engines.',
      ],
    },
    {
      label: 'How long',
      lines: [
        'Until you delete it, or until the session goes unused for 7\u00a0days; it is then removed within 10\u00a0minutes.',
        'Nightly backups keep it up to 3\u00a0days\u00a0longer.',
      ],
    },
    {
      label: 'Usage statistics',
      lines: [
        'Each night the server records daily totals, kept indefinitely: numbers of sessions, requests and\u00a0deletions.',
        "Also each day's 20 most frequent User-Agent values, content types and\u00a0methods.",
        'And its 20 most frequent sender networks: an IPv4\u00a0/24 or an IPv6\u00a0/48, never a full address, kept 90\u00a0days and up to 3\u00a0days longer in nightly\u00a0backups.',
        'No session ids, bodies, paths or query\u00a0strings.',
      ],
    },
    {
      label: 'Logs',
      lines: [
        "The server's log records each request's method, URL and time, but not the sender's IP\u00a0address.",
        'The URL includes the first eight characters of the session id and any query\u00a0string.',
        "The proxy in front of the server records a sender's IP\u00a0address in its error log when a connection fails, for example when the sender drops it mid-request. That log stays on the server until the proxy restarts; it is not backed up or sent\u00a0anywhere.",
        'Limits keep an IP\u00a0address in memory for up to a minute, or while its connection stays open, and write it\u00a0nowhere.',
      ],
    },
    {
      label: 'In your browser',
      lines: [
        'No cookies, no ads, and no analytics or other third\u2011party\u00a0scripts.',
        "Local storage keeps the sessions you opened, the access keys of your private sessions, which requests you have read, your filters, one panel's state and the interface language you\u00a0chose.",
        'Only session ids and the access keys of private sessions leave your browser, to open those sessions and check that they still\u00a0exist.',
      ],
    },
    {
      label: 'Where it is stored',
      lines: [
        'On a server in Moscow, Russia (FirstVDS), with encrypted backup copies in Yandex Object Storage, also in\u00a0Russia.',
        [
          { kind: 'text', text: 'Mail to ' },
          mail,
          { kind: 'text', text: ' is received by Apple iCloud\u00a0Mail.' },
        ],
        'The status page, status.qa-tools.ru, is run by Statuser, a separate\u00a0service.',
      ],
    },
    {
      label: 'Deleting your data',
      lines: [
        'Delete a request, all requests or the whole session on its page or through the\u00a0API.',
        [
          { kind: 'text', text: 'Or write to ' },
          mail,
          { kind: 'text', text: ", and I'll delete a session for\u00a0you." },
        ],
      ],
    },
    {
      label: 'Changes to this policy',
      lines: [
        'Changes that make QA\u00a0Tools keep more data, keep it longer or share it with anyone new are announced here at least 14\u00a0days before they apply, unless the law requires them sooner. Other changes apply when\u00a0published.',
        "From 2 November 2026, the server's log records the IP\u00a0address of a sender that sends far more requests than the limits allow, at most once a\u00a0minute.",
        'From 8 November 2026, mail to the contact address is received by Yandex\u00a0360, in Russia, instead of Apple iCloud\u00a0Mail.',
      ],
    },
    {
      label: 'Contact',
      lines: [
        [
          { kind: 'text', text: 'Questions about your data:\u00a0' },
          mail,
          { kind: 'text', text: '.' },
        ],
        OPERATOR_DETAILS,
      ],
    },
  ],
};

/** Both pages, in the order the footer links them. */
export const LEGAL_PAGES: readonly LegalPage[] = [TERMS_PAGE, PRIVACY_PAGE];

/** A line as plain text, the way it reads. */
export function legalLineText(line: LegalLine): string {
  return typeof line === 'string' ? line : line.map((part) => part.text).join('');
}
