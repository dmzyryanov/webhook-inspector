/**
 * Writes the nginx configuration the frontend image runs (issue #369):
 * `nginx.conf` with its `# status-page-locations` line replaced by the
 * `/status` and `/status/` locations, each a 301 to the build's status page,
 * `STATUS_PAGE_URL` (`src/lib/operator.ts`). A build that names no status page
 * keeps the line, a comment, and `/status` is then the application's 404, as
 * every other unknown address is. A build without the operator's texts
 * (issue #396) also has none of the exact locations of the changelog's
 * files, `/changelog.md` and the two feeds, which it does not write, so each
 * is that 404 too; `/changelog` and `/changelog/` are already, through the
 * error page of `/changelog/index.html`, as `/terms` is. The image carries
 * no configuration at run time (D274), so what nginx answers is decided here,
 * when the image is built.
 *
 * The address reaches nginx as it is, so beside the checks `operator.ts`
 * makes when it reads the setting, this refuses anything but the characters
 * of a URL that nginx reads as plain text in a `return`: no space, quote,
 * `;`, brace, `$` or `#`.
 *
 * Runs in the image build, after `npm run build` (`apps/frontend/Dockerfile`),
 * which then runs `nginx -t` on what it wrote. Nothing it writes is
 * committed; the tests read `nginxConf()` itself.
 *
 * Usage: node scripts/nginx-conf.mjs <output file>
 */
import console from 'node:console';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { changelogShown } from '../src/lib/changelog-link.ts';
import { OPERATOR } from '../src/lib/operator.ts';

/** The configuration as the repository writes it, for a build with no status page. */
export const NGINX_CONF_SOURCE = fileURLToPath(new URL('../nginx.conf', import.meta.url));

/** The line the `/status` locations take the place of, its newline included. */
export const STATUS_MARKER = '    # status-page-locations\n';

/** What of a status page's address nginx may be given in a `return`. */
const NGINX_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/(?:[A-Za-z0-9._~/-]|%[0-9A-Fa-f]{2})*$/;

/** The two exact locations that send `/status` and `/status/` to `url` with a 301. */
export function statusLocations(url) {
  if (!NGINX_URL.test(url)) {
    throw new Error('STATUS_PAGE_URL holds characters the nginx configuration cannot carry');
  }

  return [
    '    location = /status {',
    `        return 301 ${url};`,
    '    }',
    '',
    '    location = /status/ {',
    `        return 301 ${url};`,
    '    }',
    '',
  ].join('\n');
}

/**
 * The changelog's files nginx serves from exact locations of their own: its
 * text (D184) and its two Atom feeds (D212), each a missing file's plain 404
 * in a build that has them. A build without the operator's texts writes none
 * (issue #396), and its configuration leaves these locations out.
 */
export const CHANGELOG_FILE_LOCATIONS = Object.freeze([
  '/changelog.md',
  '/changelog.xml',
  '/changelog-breaking.xml',
]);

/** The line that opens the exact location of `path`, as `nginx.conf` indents it. */
function locationLine(path) {
  return `    location = ${path} {`;
}

/** The index of the one line of `lines` that opens the exact location of `path`. */
function locationIndex(lines, path) {
  const found = lines.flatMap((line, index) => (line === locationLine(path) ? [index] : []));

  if (found.length !== 1) {
    throw new Error(`nginx.conf must hold the line "${locationLine(path).trim()}" once`);
  }

  return found[0];
}

/**
 * `source` without the exact location of `path`: its comment, the lines of
 * `#` right above it, its lines to the `}` that closes it, and the blank line
 * after it, so the locations around it stay one blank line apart. Read line
 * by line, in time linear in the source's length. Refused: a source that
 * does not hold the location once, or never closes it.
 */
export function withoutLocation(source, path) {
  const lines = source.split('\n');
  const at = locationIndex(lines, path);
  let start = at;
  let end = at + 1;

  while (start > 0 && lines[start - 1].startsWith('    #')) {
    start -= 1;
  }

  while (end < lines.length && lines[end] !== '    }') {
    end += 1;
  }

  if (end === lines.length) {
    throw new Error(`nginx.conf never closes the location "${locationLine(path).trim()}"`);
  }

  end += lines[end + 1] === '' ? 2 : 1;

  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/** The configuration for `operator`'s build, from `source`, the repository's unless given. */
export function nginxConf(source = readFileSync(NGINX_CONF_SOURCE, 'utf8'), operator = OPERATOR) {
  if (source.split(STATUS_MARKER).length !== 2) {
    throw new Error(`nginx.conf must hold the line "${STATUS_MARKER.trim()}" once`);
  }

  const lines = source.split('\n');

  for (const path of CHANGELOG_FILE_LOCATIONS) {
    locationIndex(lines, path);
  }

  const url = operator.statusPageUrl;
  const status = url === null ? source : source.replace(STATUS_MARKER, () => statusLocations(url));

  return changelogShown(operator)
    ? status
    : CHANGELOG_FILE_LOCATIONS.reduce(withoutLocation, status);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];

  if (output === undefined) {
    console.error('Usage: node scripts/nginx-conf.mjs <output file>');
    process.exitCode = 1;
  } else {
    writeFileSync(resolve(output), nginxConf());
    console.log(
      `nginx configuration: wrote ${output}, /status ${OPERATOR.statusPageUrl === null ? 'the application 404' : 'redirecting to the status page'}, the changelog's files ${changelogShown() ? 'served' : 'the application 404'}`,
    );
  }
}
