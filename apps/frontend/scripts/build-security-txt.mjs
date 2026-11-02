/**
 * Writes `/.well-known/security.txt` (RFC 9116) into the frontend build
 * (issue #88, D177):
 *
 * - `Contact:` the project's contact address as a `mailto:` link, from
 *   `src/lib/contact.ts`, the module the footer reads it from;
 * - `Expires:` the build time plus 364 days, in UTC. RFC 9116 says it SHOULD be
 *   less than a year ahead; every deployment builds the file again, so it stays
 *   current with no one having to remember it;
 * - `Preferred-Languages: en, ru`;
 * - `Canonical:` the address it is served at.
 *
 * Runs in `npm run build`, and so in the frontend image build, after the two
 * Vite builds and before `check-build.mjs`, which checks the file it wrote.
 * Nothing it writes is committed. nginx serves it from a location of its own
 * as `text/plain; charset=utf-8` (nginx.conf); the dev server does not serve it.
 *
 * Usage: node scripts/build-security-txt.mjs [dist directory]
 */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CONTACT_MAILTO } from '../src/lib/contact.ts';
import { APP_ORIGIN } from './site-origin.mjs';

/** Where the file goes in the build, and so the path it is served at. */
export const SECURITY_TXT_FILE = '.well-known/security.txt';

/**
 * The `Canonical` field: the one address the file is meant to be read at, on
 * the site this build names (D274).
 */
export const SECURITY_TXT_URL = `${APP_ORIGIN}/${SECURITY_TXT_FILE}`;

/** How far ahead of the build `Expires` lies: under a year, as RFC 9116 asks. */
export const EXPIRES_AFTER_DAYS = 364;

const DAY_MS = 24 * 60 * 60 * 1000;

/** An RFC 3339 UTC time to the second, the form RFC 9116's examples use. */
function utcSeconds(time) {
  return time.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The whole file for a build made at `builtAt`, one field per line. */
export function securityTxt(builtAt = new Date()) {
  const expires = new Date(builtAt.getTime() + EXPIRES_AFTER_DAYS * DAY_MS);

  return [
    `Contact: ${CONTACT_MAILTO}`,
    `Expires: ${utcSeconds(expires)}`,
    'Preferred-Languages: en, ru',
    `Canonical: ${SECURITY_TXT_URL}`,
    '',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'dist');
  const path = join(dist, SECURITY_TXT_FILE);
  const text = securityTxt();

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`security.txt: wrote ${SECURITY_TXT_FILE} (${Buffer.byteLength(text)} bytes)`);
}
