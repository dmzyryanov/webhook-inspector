import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONTACT_ADDRESS, CONTACT_MAILTO } from './contact.ts';
import {
  LEGAL_PAGES,
  type LegalPage,
  legalLineText,
  privacyPage,
  STABILITY_POLICY_HREF,
  termsPage,
} from './legal-copy.ts';
import { APP_ORIGIN } from '../../scripts/site-origin.mjs';
import { PRODUCTION_OPERATOR } from '../testing/production-operator.ts';

/** The two pages as production's build writes them (issue #369). */
const TERMS_PAGE = termsPage(PRODUCTION_OPERATOR);
const PRIVACY_PAGE = privacyPage(PRODUCTION_OPERATOR);

/**
 * The texts of `/terms` and `/privacy` (issue #112, D217), exactly as
 * approved on 2026-10-09: every text of the issue's Scope 3, byte
 * for byte, its no-break spaces and its no-break hyphen included, the date
 * line the day each page's text ships. The Privacy Policy's `In your browser`
 * (#108, D222) and `Logs` (#155) lines are the wording as amended on
 * 2026-10-10. Since issue #163 (D224) with the lines approved on
 * 2026-10-11: the governing law, the 14 days' notice of a change on each page
 * and the data processing agreement in `Contact`. Since issue #145 (D227),
 * the `Logs` line on limits as worded on 2026-10-11, a correction
 * with no notice: limits keep an address while its connection stays open
 * too. Since issue #185 (D231), the `Logs` line on the proxy's error log,
 * decided on 2026-10-12, a correction with no notice too: the proxy
 * always recorded a sender's address when a connection failed, and the page
 * did not say so. Since issue #214 (D224), the first dated line of
 * `Changes to this policy`, announcing a change 14 days before it applies, as
 * worded on 2026-10-18, beside the section's rule. Since issue
 * #166 (D243), the line of `What a session keeps` on a session created with
 * the sender's IP turned off, by Decision 7 of 2026-10-18, published
 * at once: it keeps less. Since issue #165 (D254), the `Usage statistics` line
 * on sender networks says they are kept 90 days, option (b) of
 * 2026-10-20, published at once for the same reason. Since issue #275 (D224),
 * the second dated line of `Changes to this policy`, as worded on
 * 2026-10-24: mail to the contact address moves to Yandex 360, a new provider,
 * so the move is announced 14 days before it applies. Since issue #215
 * (D224), the change the first dated line announced, made on or after its
 * day: the first and the last line of `Logs` as worded on 2026-10-18, the
 * server's log recording an address that sends far more requests than the
 * limits allow, and the dated line gone from `Changes to this policy`, the
 * page saying the change as it now is.
 * `legal-page.test.ts` shows the pages write these constants
 * as they are; `legal-facts.test.ts` holds their numbers, and the facts of the
 * proxy's line, to their sources.
 */

const NBSP = String.fromCharCode(0xa0);
const NBH = String.fromCharCode(0x2011);

/**
 * A text as the issue writes it: ` NBSP ` is one no-break space (U+00A0) and
 * ` NBH ` one no-break hyphen (U+2011), each with no ordinary space beside it.
 */
const approved = (text: string) => text.replaceAll(' NBSP ', NBSP).replaceAll(' NBH ', NBH);

/**
 * The day 1.0.11's announcement named for the server's log to record a
 * flooding address (issue #214, D224): the change it announced is made on or
 * after it, on the page's date (issue #215).
 */
const ANNOUNCED_DAY = '2 November 2026';

/**
 * The day the contact address's mail moves to Yandex 360 (issue #275, D224):
 * the delivery's UTC day plus 14, the day 1.15.14's Notice paragraph names as
 * `YYYY-MM-DD`. A merge on a later UTC day moves it, with the page's date, the
 * page's line and the changelog entry.
 */
const MAIL_MOVE_DAY = '8 November 2026';

/** The months as `Last updated` writes them. */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A day as the pages write it, `8 November 2026`, as milliseconds at its UTC midnight. */
const utcDay = (day: string) => {
  const [date = '', month = '', year = ''] = day.split(' ');

  assert.ok(MONTHS.includes(month), day);

  return Date.UTC(Number(year), MONTHS.indexOf(month), Number(date));
};

/** The date line, `Last updated <day> <Month> <year>`: the pages' one form of a day. */
const DATE_LINE =
  /^Last updated (?:[1-9]|[12]\d|3[01]) (?:January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d$/;

/** A page's sections as the issue lists them: each label with its lines as text. */
const sectionsAsText = (page: LegalPage) =>
  page.sections.map((section) => ({
    label: section.label,
    lines: section.lines.map(legalLineText),
  }));

/** Every visible text of a page: eyebrow, title, introduction, date line, labels and lines. */
const everyText = (page: LegalPage) => [
  page.eyebrow,
  page.heading,
  page.introduction,
  page.updated,
  ...sectionsAsText(page).flatMap((section) => [section.label, ...section.lines]),
];

/** The phrases a page joins with no-break spaces or hyphens, `_` a space and `~` a hyphen. */
const joined = (page: LegalPage) =>
  everyText(page)
    .flatMap((text) => [
      ...text.matchAll(/[^\s\u00a0\u2011]+(?:[\u00a0\u2011][^\s\u00a0\u2011]+)+/g),
    ])
    .map((match) => match[0].replaceAll(NBSP, '_').replaceAll(NBH, '~'));

describe('the Terms of Use text (Scope 3)', () => {
  it('has the eyebrow, the title, the introduction and the date line the owner approved', () => {
    assert.equal(TERMS_PAGE.eyebrow, 'TERMS OF USE');
    assert.equal(TERMS_PAGE.heading, approved('The rules for using QA NBSP Tools'));
    assert.equal(TERMS_PAGE.heading, `The rules for using QA${NBSP}Tools`);
    assert.equal(
      TERMS_PAGE.introduction,
      approved(
        'QA NBSP Tools is a free tool for testing and debugging webhooks. By using its site, API or MCP server, you agree to these terms. They are short and in plain NBSP words.',
      ),
    );
    // The day the current text ships, in the approved form: the governing
    // law and the notice of a change moved it from 10 October (D224).
    assert.equal(TERMS_PAGE.updated, 'Last updated 11 October 2026');
  });

  it('states the nine sections, each line its own, byte for byte', () => {
    assert.equal(TERMS_PAGE.sections.length, 9);
    assert.deepEqual(sectionsAsText(TERMS_PAGE), [
      {
        label: 'Your sessions',
        lines: [
          approved(
            "A session's address is its key: 43 NBSP random letters and digits, far too many to NBSP guess.",
          ),
          approved('Anyone who has it can see, change and delete the NBSP session.'),
          approved('Keep it safe, and give it only to people and systems you NBSP trust.'),
        ],
      },
      {
        label: 'Limits',
        lines: [
          approved(
            'A request body can be up NBSP to NBSP 1 NBSP MB; larger requests are NBSP refused.',
          ),
          approved(
            'A session keeps its newest 1,000 NBSP requests and is deleted 7 NBSP days after its last NBSP use.',
          ),
          approved(
            'The API allows 60 new sessions and 1,200 other calls a minute from one NBSP address.',
          ),
        ],
      },
      {
        label: 'Not allowed',
        lines: [
          approved(
            "Serving phishing pages, malware or other harmful content through a session's NBSP response.",
          ),
          approved('Using QA NBSP Tools to attack, scan or flood other NBSP systems.'),
          approved(
            'Deliberately overloading QA NBSP Tools, or using it for anything NBSP unlawful.',
          ),
        ],
      },
      {
        label: 'If the rules are broken',
        lines: [
          approved('I may delete a session or block traffic from an address, without NBSP notice.'),
          approved('I do so when these terms are broken or the service is at NBSP risk.'),
        ],
      },
      {
        label: 'Changes to the service',
        lines: [
          approved('API changes follow the stability policy in the NBSP API NBSP docs.'),
          approved(
            "If QA NBSP Tools is ever shut down, I'll announce it here at least 30 NBSP days ahead, unless an emergency leaves no NBSP time.",
          ),
        ],
      },
      {
        label: 'Liability',
        lines: [
          approved(
            "As far as the law allows, I'm not liable for any loss caused by using QA NBSP Tools.",
          ),
        ],
      },
      {
        label: 'Changes to the terms',
        lines: [
          approved(
            'The date at the top shows the current version. A new version is announced here at least 14 NBSP days before it applies. Changes the law requires, changes needed to protect the service, and changes that only add to your rights apply when NBSP published.',
          ),
        ],
      },
      {
        label: 'Governing law',
        lines: [approved('These terms are governed by the law of the Russian NBSP Federation.')],
      },
      {
        label: 'Contact',
        lines: [
          approved(
            'Write to contact@qa-tools.ru with questions, abuse reports and requests to delete NBSP data.',
          ),
          approved(
            "Companies can ask for the operator's details, or for a data processing agreement, by NBSP email.",
          ),
        ],
      },
    ]);
  });

  it('links `stability policy` to the Stability section of /docs and the address as mail', () => {
    const links = TERMS_PAGE.sections.flatMap((section) =>
      section.lines.flatMap((line) =>
        typeof line === 'string' ? [] : line.filter((part) => part.kind !== 'text'),
      ),
    );

    assert.deepEqual(links, [
      { kind: 'link', text: 'stability policy', href: '/docs#api-1/description/stability' },
      { kind: 'mail', text: CONTACT_ADDRESS, href: CONTACT_MAILTO },
    ]);
    assert.equal(STABILITY_POLICY_HREF, '/docs#api-1/description/stability');
  });

  it('joins exactly the approved phrases', () => {
    assert.deepEqual(joined(TERMS_PAGE), [
      'QA_Tools',
      'QA_Tools',
      'plain_words.',
      '43_random',
      'to_guess.',
      'the_session.',
      'you_trust.',
      'up_to_1_MB;',
      'are_refused.',
      '1,000_requests',
      '7_days',
      'last_use.',
      'one_address.',
      "session's_response.",
      'QA_Tools',
      'other_systems.',
      'QA_Tools,',
      'anything_unlawful.',
      'without_notice.',
      'at_risk.',
      'the_API_docs.',
      'QA_Tools',
      '30_days',
      'no_time.',
      'QA_Tools.',
      '14_days',
      'when_published.',
      'Russian_Federation.',
      'delete_data.',
      'by_email.',
    ]);
  });

  it('describes the page for search results and link previews', () => {
    assert.equal(TERMS_PAGE.path, '/terms');
    assert.equal(TERMS_PAGE.title, 'Terms of Use — QA Tools');
    assert.equal(
      TERMS_PAGE.description,
      'The rules for using QA Tools: your sessions, the limits, what is not allowed, and whom to write to.',
    );
    assert.equal(TERMS_PAGE.url, `${APP_ORIGIN}/terms`);
  });
});

describe('the Privacy Policy text (Scope 3)', () => {
  it('has the eyebrow, the title, the introduction and the date line the owner approved', () => {
    assert.equal(PRIVACY_PAGE.eyebrow, 'PRIVACY POLICY');
    assert.equal(PRIVACY_PAGE.heading, approved('What QA NBSP Tools keeps, and for how NBSP long'));
    assert.equal(
      PRIVACY_PAGE.introduction,
      approved(
        'Everything QA NBSP Tools stores, who can see it, where it is kept and when it is deleted. This page describes the service as it works today, and changes when it NBSP does.',
      ),
    );
    // The day the current text ships: the announcement of issue #214 moved it
    // from 12 October, the day of the proxy's line (D231, D224), and the line
    // of a session that keeps no sender address (issue #166, D243) shipped
    // the same day, published at once: it keeps less. The response rules
    // joined what a session keeps on 20 October (issue #134, D246), published
    // at once too: they are configuration the user types, not data about
    // people, which #134's Decision 7 reads D224's notice as being for.
    // A private session's lines shipped on 21 October (issue #227, D253),
    // published at once as well: fewer people can see a session, and the
    // fingerprint of its key says nothing about a person. The 90 days of the
    // sender networks shipped the same day (issue #165, D254), published at
    // once: it keeps less. The access keys of private sessions joined `In
    // your browser` on 22 October (issue #228, D259), published at once:
    // what only the browser keeps applies when published (D224). The
    // announcement of the contact address's mail moving to Yandex 360 moved
    // it to 25 October (issue #275, D224), and the log line on a flooding
    // address, the change 1.0.11 announced, to 12 November (issue #215, D224).
    assert.equal(PRIVACY_PAGE.updated, 'Last updated 12 November 2026');
  });

  it('states the ten sections, each line its own, byte for byte', () => {
    assert.equal(PRIVACY_PAGE.sections.length, 10);
    assert.deepEqual(sectionsAsText(PRIVACY_PAGE), [
      {
        label: 'What a session keeps',
        lines: [
          approved(
            'Every request it captures, exactly as received: method, path, query NBSP string, headers and body up NBSP to NBSP 1 NBSP MB.',
          ),
          approved("With each one, its size, time and the sender's IP NBSP address."),
          approved(
            "A session created with the sender's IP turned off keeps no sender IP NBSP address; the headers the sender sent are kept as NBSP sent.",
          ),
          approved(
            'The answer the session sent back, and the response, response queue and response rules you set NBSP up.',
          ),
          // The line as worded on 2026-10-20 (issue #227, D253).
          approved(
            'A private session keeps a fingerprint of its access key, never the key NBSP itself.',
          ),
        ],
      },
      {
        label: 'Who can see it',
        lines: [
          approved(
            "Anyone with the session's URL — on its page, through the API or through the MCP NBSP server — unless the session is NBSP private.",
          ),
          approved(
            'A private session: only someone with its access key. Its URL only sends requests to NBSP it.',
          ),
          approved(
            'I can, as the operator. Nobody else: captured requests are never sold or NBSP shared.',
          ),
          approved('Session pages are hidden from search NBSP engines.'),
        ],
      },
      {
        label: 'How long',
        lines: [
          approved(
            'Until you delete it, or until the session goes unused for 7 NBSP days; it is then removed within 10 NBSP minutes.',
          ),
          approved('Nightly backups keep it up to 3 NBSP days NBSP longer.'),
        ],
      },
      {
        label: 'Usage statistics',
        lines: [
          approved(
            'Each night the server records daily totals, kept indefinitely: numbers of sessions, requests and NBSP deletions.',
          ),
          approved(
            "Also each day's 20 most frequent User-Agent values, content types and NBSP methods.",
          ),
          // Option (b) of 2026-10-20 (issue #165, D254): the
          // numbers joined to their days, as `How long` joins them, and the
          // last two words; `full address` is no longer the line's end.
          approved(
            'And its 20 most frequent sender networks: an IPv4 NBSP /24 or an IPv6 NBSP /48, never a full address, kept 90 NBSP days and up to 3 NBSP days longer in nightly NBSP backups.',
          ),
          approved('No session ids, bodies, paths or query NBSP strings.'),
        ],
      },
      {
        label: 'Logs',
        lines: [
          // The first and the last line as worded on 2026-10-18 (issue #215,
          // Decision 2), made on or after the day 1.0.11 announced.
          approved(
            "The server's log records each request's method, URL and time, but not the sender's IP NBSP address, except as the last line below NBSP says.",
          ),
          approved(
            'The URL includes the first eight characters of the session id and any query NBSP string.',
          ),
          approved(
            "The proxy in front of the server records a sender's IP NBSP address in its error log when a connection fails, for example when the sender drops it mid-request. That log stays on the server until the proxy restarts; it is not backed up or sent NBSP anywhere.",
          ),
          approved(
            "Limits keep an IP NBSP address in memory for up to a minute, or while its connection stays open. When an address sends far more requests than the limits allow, the server's log records that address, at most once a minute. That log stays on the server until the server is next updated and is not backed up or sent NBSP anywhere.",
          ),
        ],
      },
      {
        label: 'In your browser',
        lines: [
          approved('No cookies, no ads, and no analytics or other third NBH party NBSP scripts.'),
          approved(
            "Local storage keeps the sessions you opened, the access keys of your private sessions, which requests you have read, your filters, one panel's state and the interface language you NBSP chose.",
          ),
          approved(
            'Only session ids and the access keys of private sessions leave your browser, to open those sessions and check that they still NBSP exist.',
          ),
        ],
      },
      {
        label: 'Where it is stored',
        lines: [
          approved(
            'On a server in Moscow, Russia (FirstVDS), with encrypted backup copies in Yandex Object Storage, also in NBSP Russia.',
          ),
          approved('Mail to contact@qa-tools.ru is received by Apple iCloud NBSP Mail.'),
          approved(
            'The status page, status.qa-tools.ru, is run by Statuser, a separate NBSP service.',
          ),
        ],
      },
      {
        label: 'Deleting your data',
        lines: [
          approved(
            'Delete a request, all requests or the whole session on its page or through the NBSP API.',
          ),
          approved("Or write to contact@qa-tools.ru, and I'll delete a session for NBSP you."),
        ],
      },
      {
        label: 'Changes to this policy',
        lines: [
          approved(
            'Changes that make QA NBSP Tools keep more data, keep it longer or share it with anyone new are announced here at least 14 NBSP days before they apply, unless the law requires them sooner. Other changes apply when NBSP published.',
          ),
          // The line as worded on 2026-10-24 (issue #275, Decision 3).
          approved(
            `From ${MAIL_MOVE_DAY}, mail to the contact address is received by Yandex NBSP 360, in Russia, instead of Apple iCloud NBSP Mail.`,
          ),
        ],
      },
      {
        label: 'Contact',
        lines: [
          approved('Questions about your data: NBSP contact@qa-tools.ru.'),
          approved(
            "Companies can ask for the operator's details, or for a data processing agreement, by NBSP email.",
          ),
        ],
      },
    ]);
  });

  it('links every contact address as mail from contact.ts, and nothing else: the status page and the MCP server are text', () => {
    const links = PRIVACY_PAGE.sections.flatMap((section) =>
      section.lines.flatMap((line) =>
        typeof line === 'string' ? [] : line.filter((part) => part.kind !== 'text'),
      ),
    );
    const mail = { kind: 'mail', text: CONTACT_ADDRESS, href: CONTACT_MAILTO };

    assert.deepEqual(links, [mail, mail, mail]);
    assert.equal(CONTACT_MAILTO, 'mailto:contact@qa-tools.ru');

    // Every line that names the address carries it as a run of its own.
    for (const page of LEGAL_PAGES) {
      for (const section of page.sections) {
        for (const line of section.lines) {
          assert.equal(
            typeof line === 'string' && line.includes(PRODUCTION_OPERATOR.contactEmail),
            false,
            legalLineText(line),
          );
        }
      }
    }
  });

  it('joins exactly the approved phrases', () => {
    assert.deepEqual(joined(PRIVACY_PAGE), [
      'QA_Tools',
      'how_long',
      'QA_Tools',
      'it_does.',
      'query_string,',
      'up_to_1_MB.',
      'IP_address.',
      'IP_address;',
      'as_sent.',
      'set_up.',
      'key_itself.',
      'MCP_server',
      'is_private.',
      'to_it.',
      'or_shared.',
      'search_engines.',
      '7_days;',
      '10_minutes.',
      '3_days_longer.',
      'and_deletions.',
      'and_methods.',
      'IPv4_/24',
      'IPv6_/48,',
      '90_days',
      '3_days',
      'nightly_backups.',
      'query_strings.',
      'IP_address,',
      'below_says.',
      'query_string.',
      'IP_address',
      'sent_anywhere.',
      'IP_address',
      'sent_anywhere.',
      'third~party_scripts.',
      'you_chose.',
      'still_exist.',
      'in_Russia.',
      'iCloud_Mail.',
      'separate_service.',
      'the_API.',
      'for_you.',
      'QA_Tools',
      '14_days',
      'when_published.',
      'Yandex_360,',
      'iCloud_Mail.',
      'data:_contact@qa-tools.ru.',
      'by_email.',
    ]);
  });

  // The first change announced ahead (issue #214, D224), made on or after
  // the day it named (issue #215): Decision 2's two lines of `Logs`, the first
  // and the last, the two between unchanged; the dated line that announced
  // it leaves `Changes to this policy`, whose rule stays.
  it("states the server log's line on a flooding address in the owner's words, on or after the announced day, and announces it no longer", () => {
    const FIRST_LINE =
      "The server's log records each request's method, URL and time, but not the sender's IP address, except as the last line below says.";
    const LAST_LINE =
      "Limits keep an IP address in memory for up to a minute, or while its connection stays open. When an address sends far more requests than the limits allow, the server's log records that address, at most once a minute. That log stays on the server until the server is next updated and is not backed up or sent anywhere.";
    const lines =
      PRIVACY_PAGE.sections.find((section) => section.label === 'Logs')?.lines.map(legalLineText) ??
      [];

    assert.equal(lines.length, 4);

    const first = lines[0] ?? '';
    const last = lines[3] ?? '';

    assert.equal(first.replaceAll(NBSP, ' '), FIRST_LINE);
    assert.equal(last.replaceAll(NBSP, ' '), LAST_LINE);
    // D211's joints, as the page joins them elsewhere: `IP address`, and the
    // last two words of each line.
    assert.equal(
      first,
      `The server's log records each request's method, URL and time, but not the sender's IP${NBSP}address, except as the last line below${NBSP}says.`,
    );
    assert.equal(
      last,
      `Limits keep an IP${NBSP}address in memory for up to a minute, or while its connection stays open. When an address sends far more requests than the limits allow, the server's log records that address, at most once a minute. That log stays on the server until the server is next updated and is not backed up or sent${NBSP}anywhere.`,
    );
    assert.equal(first.split(NBSP).length - 1, 2);
    assert.equal(last.split(NBSP).length - 1, 2);

    // Made on or after the day the announcement named, the page's date that
    // of the change.
    const updated = PRIVACY_PAGE.updated.replace(/^Last updated /, '');

    assert.ok(
      utcDay(updated) >= utcDay(ANNOUNCED_DAY),
      `${updated} is before ${ANNOUNCED_DAY}, the day announced`,
    );

    // The announcement leaves with the change: the section keeps its rule and
    // the change still to come, and names the server's log nowhere.
    const changes =
      PRIVACY_PAGE.sections
        .find((section) => section.label === 'Changes to this policy')
        ?.lines.map(legalLineText) ?? [];

    assert.equal(changes.length, 2);
    assert.match(changes[0] ?? '', /^Changes that make QA\u00a0Tools keep more data/);
    assert.ok(
      changes.every((line) => !line.includes("server's log") && !line.includes(ANNOUNCED_DAY)),
      changes.join('\n'),
    );
  });

  // The second change announced ahead (issue #275, D224): Decision 3's words
  // with the day it applies, after the section's rule. Until that day the
  // mail stays where `Where it is stored` says it is, which the section's pin
  // above holds.
  it("announces the contact address's mail moving to Yandex 360 in the owner's words, on its day, after the section's rule", () => {
    const OWNER_WORDS =
      'From <D>, mail to the contact address is received by Yandex 360, in Russia, instead of Apple iCloud Mail.';
    const changes = PRIVACY_PAGE.sections.find(
      (section) => section.label === 'Changes to this policy',
    );
    const lines = changes?.lines.map(legalLineText);

    assert.equal(lines?.length, 2);
    // Plain text, not a mail link: it names the address in words.
    assert.equal(typeof changes?.lines[1], 'string');

    const line = lines?.[1] ?? '';
    const day = /^From ([^,]+), /.exec(line)?.[1] ?? '';

    assert.equal(day, MAIL_MOVE_DAY);
    // The day in the page's own date format, that of `Last updated`, and after
    // the day the first announcement named: the section listed its changes in
    // their order. Its 14 days' notice is held in `legal-facts.test.ts`,
    // against the entry whose Notice paragraph names it, not against the
    // page's date, which moves with every later edit of the page.
    assert.match(`Last updated ${day}`, DATE_LINE);
    assert.ok(utcDay(day) > utcDay(ANNOUNCED_DAY), `${day} is not after ${ANNOUNCED_DAY}`);
    assert.equal(line.replaceAll(NBSP, ' '), OWNER_WORDS.replace('<D>', day));
    // D211's joints: a name with its number, `Yandex 360`, and the last two
    // words, as `Where it is stored` joins them; none in the day.
    assert.equal(
      line,
      `From ${day}, mail to the contact address is received by Yandex${NBSP}360, in Russia, instead of Apple iCloud${NBSP}Mail.`,
    );
    assert.equal(line.split(NBSP).length - 1, 2);
  });

  // Issue #165 (D254): option (b) of 2026-10-20, the third of the
  // section's four lines, read with its joints as spaces; the joints are the
  // five the section's pin above gives it.
  it("states the sender networks' 90 days in the owner's words", () => {
    const OWNER_WORDS =
      'And its 20 most frequent sender networks: an IPv4 /24 or an IPv6 /48, never a full address, kept 90 days and up to 3 days longer in nightly backups.';
    const lines = PRIVACY_PAGE.sections
      .find((section) => section.label === 'Usage statistics')
      ?.lines.map(legalLineText);

    assert.equal(lines?.length, 4);

    const line = lines?.[2] ?? '';

    assert.equal(line.replaceAll(NBSP, ' '), OWNER_WORDS);
    assert.equal(line.split(NBSP).length - 1, 5);
  });

  it('describes the page for search results and link previews', () => {
    assert.equal(PRIVACY_PAGE.path, '/privacy');
    assert.equal(PRIVACY_PAGE.title, 'Privacy Policy — QA Tools');
    assert.equal(
      PRIVACY_PAGE.description,
      'Everything QA Tools stores, who can see it, where it is kept and when it is deleted.',
    );
    assert.equal(PRIVACY_PAGE.url, `${APP_ORIGIN}/privacy`);
  });
});

describe('both pages', () => {
  it('are the Terms of Use, then the Privacy Policy', () => {
    assert.deepEqual(LEGAL_PAGES, [TERMS_PAGE, PRIVACY_PAGE]);
  });

  it('put no ordinary space beside a joint, and nothing outside ASCII but the joints and the dashes', () => {
    for (const page of LEGAL_PAGES) {
      for (const text of [...everyText(page), page.title, page.description]) {
        assert.doesNotMatch(text, / [\u00a0\u2011]|[\u00a0\u2011] /, text);
        // The apostrophes are U+0027, as written; the one dash is the
        // Privacy Policy's em dash, and the titles'.
        assert.doesNotMatch(text, /[^\x20-\x7e\u00a0\u2011—]/, text);
      }

      // The head is plain: no joint in a title or a description.
      assert.doesNotMatch(`${page.title}${page.description}`, /[\u00a0\u2011]/);
    }

    assert.equal(everyText(PRIVACY_PAGE).join('').split(NBH).length - 1, 1);
    assert.equal(everyText(TERMS_PAGE).join('').split(NBH).length - 1, 0);
    // Both in the line of who can see a session, the second since a private
    // session's clause joined it (issue #227).
    assert.equal(everyText(PRIVACY_PAGE).join('').split('—').length - 1, 2);
    assert.equal(everyText(TERMS_PAGE).join('').split('—').length - 1, 0);
  });

  it('end every line of more than one word with two words joined, so none ends on a word of its own', () => {
    for (const page of LEGAL_PAGES) {
      for (const text of [
        page.heading,
        page.introduction,
        ...sectionsAsText(page).flatMap((section) => section.lines),
      ]) {
        const words = text.split(' ');

        assert.ok(/[\u00a0\u2011]/.test(words.at(-1) ?? ''), text);
      }
    }
  });

  // Each page carries the day its own current text shipped: the Privacy
  // Policy's change with 0.54.0 moved its date and left the Terms' (D222).
  it('date the current text in the approved form, each page its own day', () => {
    for (const page of LEGAL_PAGES) {
      assert.match(page.updated, DATE_LINE);
    }
  });
});
