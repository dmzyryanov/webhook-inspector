/**
 * The relay script (D202), its name since #319 (D275), and its old name
 * serving the same file since #334 (D279).
 *
 * - `webhook-inspector-relay.mjs`, `RELAY_SCRIPT_NAME`, is the script `/docs`
 *   offers and its source, `public/webhook-inspector-relay.mjs`, written for
 *   production: it reads `https://webhook.qa-tools.ru`, the site's second
 *   origin, by default, and the build writes it to `dist/` under the build's
 *   origins, the second one's or the site's where there is none
 *   (`build-site-files.mjs`, D274).
 * - `qa-tools-relay.mjs`, `OLD_RELAY_SCRIPT_NAME`, its old name, is the same
 *   file byte for byte until the dates the changelog's 1.16.0 and 1.19.0
 *   entries give (D275, D279), so that a command copied before still
 *   downloads the script the hash `/docs` gives is for. nginx serves both on
 *   both hosts.
 *
 * `/docs` gives the SHA-256 of the script in `info.description` of the
 * OpenAPI description, `packages/shared/openapi.json`'s for production's
 * bytes and the build's `dist/openapi.json`'s for the built ones. People
 * download the file and check it against that hash before running it, so the
 * two must not drift: `check-build.mjs` compares both built files with the
 * built description, and `src/lib/relay-script.test.ts` production's with
 * the source.
 */
import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';

/** The script `/docs` offers: its name in `public/`, in the build and in its address (D275). */
export const RELAY_SCRIPT_NAME = 'webhook-inspector-relay.mjs';

/** Its old name, which the build writes the same file under until the date the changelog gives (D279). */
export const OLD_RELAY_SCRIPT_NAME = 'qa-tools-relay.mjs';

export const RELAY_SCRIPT_FILE = fileURLToPath(
  new URL(`../public/${RELAY_SCRIPT_NAME}`, import.meta.url),
);

/**
 * The API the script reads by default, written for production: the site's
 * second origin, which the build names in its place (`nameSite()`).
 */
export const RELAY_SCRIPT_API = 'https://webhook.qa-tools.ru';

/** The section of `info.description` that offers the script. */
export const RELAY_SECTION_HEADING = '## Forward to a local service';

/** The SHA-256 of `bytes`, as 64 lower-case hex digits. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The relay section of a description, from its heading to the next `## `; `undefined` without one. */
export function relaySection(description) {
  const start = description.indexOf(`\n${RELAY_SECTION_HEADING}\n`);

  if (start < 0) {
    return undefined;
  }

  const end = description.indexOf('\n## ', start + 1);

  return description.slice(start, end < 0 ? undefined : end);
}

/** Every SHA-256 the relay section names, once each, in order. */
export function documentedRelayHashes(description) {
  const section = relaySection(description) ?? '';

  return [...new Set(section.match(/\b[0-9a-f]{64}\b/g) ?? [])];
}
