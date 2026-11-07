import { Buffer } from 'node:buffer';
import console from 'node:console';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import {
  OLD_RELAY_SCRIPT_NAME,
  RELAY_SCRIPT_FILE,
  RELAY_SCRIPT_NAME,
  sha256Hex,
} from './relay-script.mjs';
import { OPERATOR } from '../src/lib/operator.ts';
import { nameSite, SITE_ORIGINS } from './site-origin.mjs';
import { operatorOpenApi, operatorSitemap } from './site-operator.mjs';

/**
 * The files the build writes into `dist/` under the configured origins
 * (issue #320, D274), each from a source written for production:
 *
 * - `robots.txt` and `sitemap.xml`, from `public/`, which Vite has copied as
 *   they are;
 * - the relay script, `webhook-inspector-relay.mjs` (D202, D275), from
 *   `public/` too: its `DEFAULT_API` names the site's second origin, or the
 *   site's where there is none, and its help text the receive host; and the
 *   same text under its old name, `qa-tools-relay.mjs`, byte for byte (D279);
 * - `openapi.json`, from `packages/shared/openapi.json` (D154): its `servers`,
 *   its examples and its prose name the hosts, and its relay section gives
 *   the script's SHA-256, which is the built script's.
 *
 * Since issue #369 the sitemap and the description also name the build's
 * operator (`site-operator.mjs`): the sitemap lists `/terms` and `/privacy`
 * only for a build with the operator's texts, and the description gives the
 * operator's contact address and status page, or leaves them out. Since
 * #386 the description's Network section, this site's server, is left out
 * without the texts, and its bullet on production's move in a build with no
 * second origin; since #431 such a build also leaves out the relay
 * section's bullet on the script's old name, and names its one host once in
 * the Network section's bullet on the server's address.
 *
 * Built for production, each is its source byte for byte, and the old name
 * the script's source. nginx serves them all from the image's copy of
 * `dist/`.
 */

export const OPENAPI_SOURCE = fileURLToPath(
  new URL('../../../packages/shared/openapi.json', import.meta.url),
);

/** The `public/` files that name the site, which Vite copies into `dist/` as they are. */
export const NAMED_PUBLIC_FILES = ['robots.txt', 'sitemap.xml', RELAY_SCRIPT_NAME];

function publicFile(name) {
  return fileURLToPath(new URL(`../public/${name}`, import.meta.url));
}

/** The relay script, `webhook-inspector-relay.mjs`, written for production (D275): its source. */
export function productionRelayScriptText() {
  return readFileSync(RELAY_SCRIPT_FILE, 'utf8');
}

/**
 * The relay script as the build writes it, the one `/docs` offers, under its
 * name and under its old one alike (D279).
 */
export function relayScriptText(origins = SITE_ORIGINS) {
  return nameSite(productionRelayScriptText(), origins);
}

/**
 * The OpenAPI description as the build writes it: named, with the
 * operator's details (`operatorOpenApi`), told whether the build has a
 * second origin to move to (#386), and with the SHA-256 of the script
 * written for production replaced by the built one's, which differs
 * whenever the script names another origin.
 */
export function openApiText(origins = SITE_ORIGINS, operator = OPERATOR) {
  const named = operatorOpenApi(
    nameSite(readFileSync(OPENAPI_SOURCE, 'utf8'), origins),
    operator,
    (origins.alias ?? null) !== null,
  );
  const sourceHash = sha256Hex(productionRelayScriptText());
  const builtHash = sha256Hex(relayScriptText(origins));

  return named.replaceAll(sourceHash, builtHash);
}

/** Every file this module writes, by its name in `dist/`. */
export function siteFiles(origins = SITE_ORIGINS, operator = OPERATOR) {
  return {
    'robots.txt': nameSite(readFileSync(publicFile('robots.txt'), 'utf8'), origins),
    'sitemap.xml': operatorSitemap(
      nameSite(readFileSync(publicFile('sitemap.xml'), 'utf8'), origins),
      operator,
    ),
    [RELAY_SCRIPT_NAME]: relayScriptText(origins),
    [OLD_RELAY_SCRIPT_NAME]: relayScriptText(origins),
    'openapi.json': openApiText(origins, operator),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'dist');

  mkdirSync(dist, { recursive: true });

  for (const [name, text] of Object.entries(siteFiles())) {
    writeFileSync(join(dist, name), text);
    console.log(`site files: wrote ${name} (${Buffer.byteLength(text)} bytes)`);
  }

  console.log(
    `site files: named ${SITE_ORIGINS.app}, ${SITE_ORIGINS.receive} and ${SITE_ORIGINS.alias ?? 'no second origin'}`,
  );
}
