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

/** The sitemap's entry of a legal page, under whatever origin: `/terms` or `/privacy`. */
const LEGAL_SITEMAP_ENTRY =
  /^ {2}<url>\n {4}<loc>[^<\n]*\/(?:terms|privacy)<\/loc>\n {2}<\/url>\n/gm;

/**
 * `sitemap.xml` for `operator`: as it is when the build shows the operator's
 * texts, and without the entries of `/terms` and `/privacy` otherwise, which
 * that build does not serve.
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

  return text.replace(LEGAL_SITEMAP_ENTRY, '');
}

/** The agent index's line about the status page, its newline included. */
const STATUS_INDEX_LINE = /^- \[Status page\]\(([^)\n]*)\)[^\n]*\n/gm;

/**
 * `llms.txt` for `operator`: its line pointing at the status page names the
 * operator's, and is left out when there is none.
 */
export function operatorLlmsIndex(text, operator = OPERATOR) {
  const lines = [...text.matchAll(STATUS_INDEX_LINE)];

  if (lines.length !== 1 || lines[0][1] !== WRITTEN_STATUS_PAGE) {
    throw new Error(`llms.txt has no single status page line linking ${WRITTEN_STATUS_PAGE}`);
  }

  const url = operator.statusPageUrl;

  return text.replace(STATUS_INDEX_LINE, (line) =>
    url === null ? '' : line.replace(`(${WRITTEN_STATUS_PAGE})`, () => `(${url})`),
  );
}

/** The API description's paragraphs that are the operator's, by how each begins. */
export const DESCRIPTION_PARAGRAPHS = Object.freeze({
  /** Where to check whether the service is up: the status page's. */
  status: 'To check whether Webhook Inspector is up',
  /** Who runs it, at `/about`: the operator's texts'. */
  about: "QA Tools is a tester's personal project",
  /** The Terms of Use and the Privacy Policy: the operator's texts'. */
  legal: 'By using the API or the MCP server, you agree to the Terms of Use',
});

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
 * The API description's introduction for `operator`: the status sentence
 * naming the operator's status page, or left out with none; the paragraphs
 * on who runs the service and on the Terms and the Privacy Policy left out
 * without the operator's texts.
 */
export function operatorDescription(description, operator = OPERATOR) {
  const paragraphs = description.split('\n\n');
  const status = paragraphIndex(paragraphs, DESCRIPTION_PARAGRAPHS.status);
  const about = paragraphIndex(paragraphs, DESCRIPTION_PARAGRAPHS.about);
  const legal = paragraphIndex(paragraphs, DESCRIPTION_PARAGRAPHS.legal);

  if (!paragraphs[status].includes(WRITTEN_STATUS_PAGE_IN_PROSE)) {
    throw new Error(
      `the API description's status sentence names no ${WRITTEN_STATUS_PAGE_IN_PROSE}`,
    );
  }

  const left = new Set([
    ...(operator.statusPageUrl === null ? [status] : []),
    ...(operator.texts ? [] : [about, legal]),
  ]);
  const url = operator.statusPageUrl;

  return paragraphs
    .flatMap((paragraph, index) => {
      if (left.has(index)) {
        return [];
      }

      return index === status && url !== null
        ? [paragraph.replaceAll(WRITTEN_STATUS_PAGE_IN_PROSE, () => statusPageInProse(url))]
        : [paragraph];
    })
    .join('\n\n');
}

/** `info.contact` of the API description as its source writes it. */
const INFO_CONTACT =
  /\n {4}"contact": \{\n {6}"name": "[^"\n]*",\n {6}"email": ("[^"\n]*")\n {4}\},/g;

/**
 * The API description's text for `operator`: `info.contact` giving the
 * operator's address, or left out with none, and `info.description` as
 * `operatorDescription` writes it. Edited as text, so every other byte is
 * the source's.
 */
export function operatorOpenApi(text, operator = OPERATOR) {
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

  return contact.replace(written, () => JSON.stringify(operatorDescription(description, operator)));
}
