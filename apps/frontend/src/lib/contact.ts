/**
 * The project's one public contact address (issue #88, D177): mail on the
 * product's own domain, received through iCloud+ Custom Email Domain (#95).
 *
 * Published in three places, all from this module or checked against it: the
 * footer every page of the application carries, `/.well-known/security.txt`,
 * which `scripts/build-security-txt.mjs` writes into the build, and `info.contact`
 * of `packages/shared/openapi.json`, which `/docs` shows. It has no imports, so
 * the build script can load it with Node's own TypeScript support.
 */
export const CONTACT_ADDRESS = 'contact@qa-tools.ru';

/** The address as a link: what the footer's address and `security.txt`'s `Contact` point at. */
export const CONTACT_MAILTO = `mailto:${CONTACT_ADDRESS}`;
