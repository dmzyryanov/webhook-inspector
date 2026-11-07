import { changelogShown } from '../src/lib/changelog-link.ts';
import { OPERATOR, statusPageInProse } from '../src/lib/operator.ts';

/**
 * The operator's details in the files the build writes from sources written
 * for production (issue #369), as `site-origin.mjs` names the origins in them
 * (D274): `public/sitemap.xml`, the agent index `llms/llms.txt` and
 * `packages/shared/openapi.json`, whose prose the backend's tests also pin.
 * Each names production's status page, contact address or legal pages; the
 * build names the operator's instead, from the settings `src/lib/operator.ts`
 * reads, or leaves the part out when the setting is unset. Nothing here
 * falls back to the names below: they are what the sources say, which the
 * build replaces.
 *
 * The changelog is among the operator's texts since issue #396
 * (`changelogShown`): a build without them publishes none of its four
 * addresses, so these files, and `/docs`'s head (`docs/index.html`), link
 * none of them either — the sitemap's `/changelog`, the agent index's
 * `changelog.md` line, the feeds' links and the API description's links to
 * the changelog, a sentence that is only such a link left out whole. Words
 * that name the changelog without linking it stay: they refer to the
 * repository's `CHANGELOG.md`, which a copy's operator has.
 *
 * The API description's `## Network` section is among them too since issue
 * #386: every bullet of it is this site's server — its address, which the
 * rename does not touch, its IPv4 and its lack of a CDN — or this site's
 * promise about it, the 14 days' notice of a new address (D204). A build
 * without the texts leaves the section out whole, and with it the Stability
 * sentence that points at it, `… under Network above.`; one with them and
 * no second origin leaves out the section's bullet on production's move to
 * its second origin, `**Moving to …**`, which such a build would name as a
 * move from the site's origin to the same one, as the changelog leaves out
 * the move's notices (#343).
 *
 * Built with production's settings, every file is its source byte for byte.
 * Each function refuses a source that no longer has the part it expects, so
 * a rewording cannot let production's name through unnoticed.
 *
 * Read by the build and its tests only.
 */

/** The status page the sources written for production name, as a link and in a sentence. */
export const WRITTEN_STATUS_PAGE = 'https://status.qa-tools.ru/';
export const WRITTEN_STATUS_PAGE_IN_PROSE = 'https://status.qa-tools.ru';

/** The contact address the API description written for production gives. */
export const WRITTEN_CONTACT = 'contact@qa-tools.ru';

/**
 * The server's address the API description written for production publishes
 * in its Network section (D204), which `docs/API.md` publishes too and the
 * backend's tests hold the two to.
 */
export const WRITTEN_SERVER_ADDRESS = '80.87.198.166';

/** The sitemap's entry of a legal page, under whatever origin: `/terms` or `/privacy`. */
const LEGAL_SITEMAP_ENTRY =
  /^ {2}<url>\n {4}<loc>[^<\n]*\/(?:terms|privacy)<\/loc>\n {2}<\/url>\n/gm;

/** The sitemap's entry of the changelog, under whatever origin: `/changelog`. */
const CHANGELOG_SITEMAP_ENTRY = /^ {2}<url>\n {4}<loc>[^<\n]*\/changelog<\/loc>\n {2}<\/url>\n/gm;

/**
 * `sitemap.xml` for `operator`: as it is when the build shows the operator's
 * texts, and without the entries of `/terms`, `/privacy` and `/changelog`
 * otherwise, which that build does not serve.
 */
export function operatorSitemap(text, operator = OPERATOR) {
  if (operator.texts) {
    return text;
  }

  const entries = text.match(LEGAL_SITEMAP_ENTRY) ?? [];

  if (entries.length !== 2) {
    throw new Error(
      `sitemap.xml has ${entries.length} entries for /terms and /privacy, not one each`,
    );
  }

  const changelog = text.match(CHANGELOG_SITEMAP_ENTRY) ?? [];

  if (changelog.length !== 1) {
    throw new Error(`sitemap.xml has ${changelog.length} entries for /changelog, not one`);
  }

  return text.replace(LEGAL_SITEMAP_ENTRY, '').replace(CHANGELOG_SITEMAP_ENTRY, '');
}

/** The agent index's line about the status page, its newline included. */
const STATUS_INDEX_LINE = /^- \[Status page\]\(([^)\n]*)\)[^\n]*\n/gm;

/** The agent index's line about the changelog's text, its newline included. */
const CHANGELOG_INDEX_LINE = /^- \[changelog\.md\]\(([^)\n]*)\)[^\n]*\n/gm;

/**
 * `llms.txt` for `operator`: its line pointing at the status page names the
 * operator's, and is left out when there is none; its line pointing at
 * `changelog.md` is left out without the operator's texts (issue #396).
 */
export function operatorLlmsIndex(text, operator = OPERATOR) {
  const lines = [...text.matchAll(STATUS_INDEX_LINE)];

  if (lines.length !== 1 || lines[0][1] !== WRITTEN_STATUS_PAGE) {
    throw new Error(`llms.txt has no single status page line linking ${WRITTEN_STATUS_PAGE}`);
  }

  const changelog = [...text.matchAll(CHANGELOG_INDEX_LINE)];

  if (changelog.length !== 1 || !changelog[0][1].endsWith('/changelog.md')) {
    throw new Error('llms.txt has no single changelog.md line linking /changelog.md');
  }

  const url = operator.statusPageUrl;
  const status = text.replace(STATUS_INDEX_LINE, (line) =>
    url === null ? '' : line.replace(`(${WRITTEN_STATUS_PAGE})`, () => `(${url})`),
  );

  return changelogShown(operator) ? status : status.replace(CHANGELOG_INDEX_LINE, '');
}

/** The API description's paragraphs that are the operator's, by how each begins. */
export const DESCRIPTION_PARAGRAPHS = Object.freeze({
  /** Where to check whether the service is up: the status page's. */
  status: 'To check whether Webhook Inspector is up',
  /** Who runs it, at `/about`: the operator's texts'. */
  about: "QA Tools is a tester's personal project",
  /** The Terms of Use and the Privacy Policy: the operator's texts'. */
  legal: 'By using the API or the MCP server, you agree to the Terms of Use',
  /** The changelog's two feeds, a sentence that is only their links: the operator's texts' (issue #396). */
  feeds: 'Subscribe with a feed reader',
});

/**
 * An address of the changelog's (D184, D212) on any origin, as the API
 * description writes one: `/changelog`, `/changelog.md`, `/changelog.xml` or
 * `/changelog-breaking.xml`. The origin's host is a host name or an IPv6
 * address in brackets, such as `http://[::1]:43979`: the hex digits and
 * colons `site-origin.mjs` accepts there (`SITE_IPV6_HOST`), their letters
 * in either case as a host name's are, so the removal is no narrower than
 * the origins a build may name. Each part is a run of one class or fixed
 * text, and no character begins both of the host's two runs, so a scan is
 * linear in the text's length.
 */
const CHANGELOG_ADDRESS = String.raw`https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d+)?\/changelog(?:\.md|\.xml|-breaking\.xml)?`;

/** Where such an address ends in a sentence: before a comma, a parenthesis, a space, or a full stop that ends it. */
const ADDRESS_END = String.raw`(?=[,;)\s]|\.(?![\w-])|$)`;

/**
 * A parenthesis whose only content is a changelog address after a few
 * words, such as ` (as text for scripts: https://qa-tools.ru/changelog.md)`,
 * which is left out whole, its space before it included.
 */
const CHANGELOG_PARENTHESIS = new RegExp(String.raw` \([^()\n]*?: ${CHANGELOG_ADDRESS}\)`, 'g');

/**
 * A changelog address set off by a comma, as in `the changelog's 1.16.0
 * entry gives, https://qa-tools.ru/changelog, which says`: left out with its
 * comma, so the sentence reads `… entry gives, which says`.
 */
const CHANGELOG_APPOSITION = new RegExp(`, ${CHANGELOG_ADDRESS}${ADDRESS_END}`, 'g');

/** Any link to one of the changelog's addresses left in a text, its path ending there. */
const CHANGELOG_LINK_LEFT = new RegExp(`${CHANGELOG_ADDRESS}(?![\\w-])`);

/**
 * The paragraphs of the API description for a build that publishes no
 * changelog (issue #396): the sentence of the feeds left out, and every link
 * to the changelog with the words that only introduce it. Refused: a
 * paragraph still linking the changelog in a way none of these reads, so a
 * rewording cannot leave a link to a `Page not found` unnoticed.
 */
function withoutChangelogLinks(paragraphs) {
  return paragraphs.map((paragraph) => {
    const left = paragraph.replace(CHANGELOG_PARENTHESIS, '').replace(CHANGELOG_APPOSITION, '');

    if (CHANGELOG_LINK_LEFT.test(left)) {
      throw new Error(
        `the API description links the changelog where the build cannot leave the link out: "${left.slice(0, 60)}…"`,
      );
    }

    return left;
  });
}

/** The one paragraph of `paragraphs` that begins with `start`, by its index. */
function paragraphIndex(paragraphs, start) {
  const found = paragraphs.flatMap((paragraph, index) =>
    paragraph.startsWith(start) ? [index] : [],
  );

  if (found.length !== 1) {
    throw new Error(
      `the API description has ${found.length} paragraphs beginning "${start}", not one`,
    );
  }

  return found[0];
}

/**
 * The heading of the API description's section on this site's server
 * (D204), a paragraph of its own: the section is it and every paragraph
 * after it up to the next heading of its level or above (issue #386).
 */
export const NETWORK_HEADING = '## Network';

/**
 * The Stability section's sentence that points at the Network section, its
 * space before it included: left out with the section.
 */
export const NETWORK_POINTER =
  ' A change of the address Webhook Inspector answers on has a notice of its own, under Network above.';

/** How the Network section's bullet on production's move begins, at the start of its line. */
export const MOVE_BULLET = '- **Moving to ';

/** A heading that ends a `##` section: `#` or `##` and a space, opening a paragraph. */
const SECTION_END = /^#{1,2} /;

/** The section's title as a word, as a pointer to it names it: `under Network above`. */
const NETWORK_NAMED = /\bNetwork\b/;

/**
 * Where the Network section is among `paragraphs`: its heading's index and
 * the index after its last paragraph. Refused: a description with no
 * paragraph that is exactly the heading, or several.
 */
function networkSection(paragraphs) {
  const found = paragraphs.flatMap((paragraph, index) =>
    paragraph === NETWORK_HEADING ? [index] : [],
  );

  if (found.length !== 1) {
    throw new Error(
      `the API description has ${found.length} paragraphs that are "${NETWORK_HEADING}", not one`,
    );
  }

  const start = found[0];
  const next = paragraphs.findIndex(
    (paragraph, index) => index > start && SECTION_END.test(paragraph),
  );

  return { start, end: next === -1 ? paragraphs.length : next };
}

/** Whether `line` begins the move's bullet. */
const isMoveBullet = (line) => line.startsWith(MOVE_BULLET);

/**
 * `paragraph` without the move's bullet: its line and the lines that go on
 * with it, up to the next line that begins a bullet of its own.
 */
function withoutMoveBullet(paragraph) {
  const lines = paragraph.split('\n');
  const start = lines.findIndex(isMoveBullet);

  if (start === -1) {
    return paragraph;
  }

  let end = start + 1;

  while (end < lines.length && !lines[end].startsWith('- ')) {
    end += 1;
  }

  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/**
 * The API description's introduction for `operator`: the status sentence
 * naming the operator's status page, or left out with none; the paragraphs
 * on who runs the service and on the Terms and the Privacy Policy left out
 * without the operator's texts, and with them the changelog's links and the
 * sentence of its feeds (issue #396, `withoutChangelogLinks`), the Network
 * section and the Stability sentence that points at it (issue #386). With
 * the texts, a build with no move — no second origin, `hasMove` false —
 * leaves out the Network section's bullet on production's move (#386).
 * Refused: a description without the section, the sentence or the bullet,
 * and one without the texts that still names the server's address or the
 * section once they are left out, so a rewording cannot keep either. That
 * check reads what is kept of the source before the operator's status page
 * is written into its sentence: the page's address is the operator's own
 * setting, whose path may hold the word `Network` or digits like the
 * server's address, and names nothing of this site's server (#430).
 */
export function operatorDescription(description, operator = OPERATOR, hasMove = true) {
  const paragraphs = description.split('\n\n');
  const status = paragraphIndex(paragraphs, DESCRIPTION_PARAGRAPHS.status);
  const about = paragraphIndex(paragraphs, DESCRIPTION_PARAGRAPHS.about);
  const legal = paragraphIndex(paragraphs, DESCRIPTION_PARAGRAPHS.legal);
  const feeds = paragraphIndex(paragraphs, DESCRIPTION_PARAGRAPHS.feeds);
  const network = networkSection(paragraphs);
  const inNetwork = (index) => index > network.start && index < network.end;

  if (!paragraphs[status].includes(WRITTEN_STATUS_PAGE_IN_PROSE)) {
    throw new Error(
      `the API description's status sentence names no ${WRITTEN_STATUS_PAGE_IN_PROSE}`,
    );
  }

  if (description.split(NETWORK_POINTER).length !== 2) {
    throw new Error(
      `the API description does not hold once the sentence "${NETWORK_POINTER.trim()}"`,
    );
  }

  const moves = paragraphs
    .filter((_paragraph, index) => inNetwork(index))
    .flatMap((paragraph) => paragraph.split('\n').filter(isMoveBullet));

  if (moves.length !== 1) {
    throw new Error(
      `the API description's Network section has ${moves.length} bullets beginning "${MOVE_BULLET}", not one`,
    );
  }

  const left = new Set([
    ...(operator.statusPageUrl === null ? [status] : []),
    ...(operator.texts ? [] : [about, legal]),
    ...(changelogShown(operator) ? [] : [feeds]),
    ...(operator.texts
      ? []
      : Array.from({ length: network.end - network.start }, (_, offset) => network.start + offset)),
  ]);
  // What the build keeps of each source paragraph, by its index, `null` for
  // one it leaves out; the status sentence is still the source's here.
  const cut = paragraphs.map((paragraph, index) => {
    if (left.has(index)) {
      return null;
    }

    if (index === status) {
      return paragraph;
    }

    if (!operator.texts) {
      return paragraph.replace(NETWORK_POINTER, '');
    }

    if (!hasMove && inNetwork(index)) {
      const rest = withoutMoveBullet(paragraph);

      return rest === '' ? null : rest;
    }

    return paragraph;
  });

  if (!operator.texts) {
    // The source alone is read, so a status page whose address holds the
    // word `Network` is not taken for this site's server (#430).
    const named = cut.find(
      (paragraph) =>
        paragraph !== null &&
        (paragraph.includes(WRITTEN_SERVER_ADDRESS) || NETWORK_NAMED.test(paragraph)),
    );

    if (named !== undefined) {
      throw new Error(
        `the API description names the server's address or its Network section outside it: "${named.slice(0, 60)}…"`,
      );
    }
  }

  const url = operator.statusPageUrl;
  const kept = cut.flatMap((paragraph, index) => {
    if (paragraph === null) {
      return [];
    }

    // The status sentence is kept only with a status page, so `url` is one here.
    return index === status
      ? [paragraph.replaceAll(WRITTEN_STATUS_PAGE_IN_PROSE, () => statusPageInProse(url))]
      : [paragraph];
  });

  return (changelogShown(operator) ? kept : withoutChangelogLinks(kept)).join('\n\n');
}

/** `info.contact` of the API description as its source writes it. */
const INFO_CONTACT =
  /\n {4}"contact": \{\n {6}"name": "[^"\n]*",\n {6}"email": ("[^"\n]*")\n {4}\},/g;

/**
 * The API description's text for `operator`: `info.contact` giving the
 * operator's address, or left out with none, and `info.description` as
 * `operatorDescription` writes it, for a build with a second origin unless
 * `hasMove` is false (issue #386). Edited as text, so every other byte is
 * the source's.
 */
export function operatorOpenApi(text, operator = OPERATOR, hasMove = true) {
  const contacts = [...text.matchAll(INFO_CONTACT)];

  if (contacts.length !== 1 || JSON.parse(contacts[0][1]) !== WRITTEN_CONTACT) {
    throw new Error(`the API description has no single info.contact giving ${WRITTEN_CONTACT}`);
  }

  const description = JSON.parse(text).info.description;
  const written = JSON.stringify(description);

  if (text.split(written).length !== 2) {
    throw new Error('the API description does not hold its introduction once as JSON writes it');
  }

  const address = operator.contactEmail;
  const contact = text.replace(INFO_CONTACT, (block, email) =>
    address === null ? '' : block.replace(email, () => JSON.stringify(address)),
  );

  return contact.replace(written, () =>
    JSON.stringify(operatorDescription(description, operator, hasMove)),
  );
}

/**
 * The comment and the two links of `/docs`'s head that point a feed reader
 * at the changelog's feeds (D212), as `docs/index.html` writes them.
 */
export const DOCS_FEED_COMMENT =
  "    <!-- The changelog's two Atom feeds, which a feed reader finds here. -->\n";

/** A `<link>` element on lines of its own, its indentation and its newline included. */
const HEAD_LINK = /^[ \t]*<link\b[^<>]*>[ \t]*\n/gm;

/** Whether a `<link>` element is one of the feeds' alternates. */
function isFeedLink(element) {
  return (
    /\srel="alternate"/.test(element) && /\shref="\/changelog(?:-breaking)?\.xml"/.test(element)
  );
}

/**
 * `docs/index.html` for `operator`: as it is with the operator's texts, and
 * without the comment and the two feed links of its head otherwise (issue
 * #396), which would point a feed reader at addresses that build does not
 * serve. Refused: a page without the comment or both links, so a reworded
 * head cannot keep a link unnoticed.
 */
export function operatorDocsPage(html, operator = OPERATOR) {
  if (changelogShown(operator)) {
    return html;
  }

  const feeds = (html.match(HEAD_LINK) ?? []).filter(isFeedLink);

  if (html.split(DOCS_FEED_COMMENT).length !== 2 || feeds.length !== 2) {
    throw new Error(
      "docs/index.html has no single comment and two links for the changelog's feeds",
    );
  }

  return html
    .replace(DOCS_FEED_COMMENT, '')
    .replace(HEAD_LINK, (element) => (isFeedLink(element) ? '' : element));
}

/**
 * The Vite plugin that writes `/docs`'s head for the build's operator
 * (`operatorDocsPage`) when `docs/index.html` is built or served. Every other
 * page is left alone.
 */
export function docsPagePlugin() {
  return {
    name: 'webhook-inspector-docs-operator',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        return context.path.endsWith('/docs/index.html') ? operatorDocsPage(html) : html;
      },
    },
  };
}
