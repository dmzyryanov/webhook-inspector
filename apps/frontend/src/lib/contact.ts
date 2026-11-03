import { mailtoOf, OPERATOR } from './operator.ts';

/**
 * The operator's contact address (issue #88, D177), the build's
 * `CONTACT_EMAIL` since issue #369 (`operator.ts`): `null` for a build that
 * names none, which then shows no address anywhere and serves no
 * `security.txt`.
 *
 * Published in the places that read this module or are checked against it:
 * the footer every page of the application carries, the about pages and the
 * legal pages, `/.well-known/security.txt`, which
 * `scripts/build-security-txt.mjs` writes into the build, and `info.contact`
 * of the `openapi.json` the build writes (`scripts/build-site-files.mjs`),
 * which `/docs` shows. Its one import, `operator.ts`, has none, so the
 * build's scripts load it with Node's own TypeScript support.
 */
export const CONTACT_ADDRESS: string | null = OPERATOR.contactEmail;

/** The address as a link, what the footer's address and `security.txt`'s `Contact` point at; `null` for none. */
export const CONTACT_MAILTO: string | null =
  CONTACT_ADDRESS === null ? null : mailtoOf(CONTACT_ADDRESS);
