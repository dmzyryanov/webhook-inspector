/**
 * Writes the nginx configuration the frontend image runs (issue #369):
 * `nginx.conf` with its `# status-page-locations` line replaced by the
 * `/status` and `/status/` locations, each a 301 to the build's status page,
 * `STATUS_PAGE_URL` (`src/lib/operator.ts`). A build that names no status page
 * keeps the line, a comment, and `/status` is then the application's 404, as
 * every other unknown address is. The image carries no configuration at run
 * time (D274), so what nginx answers is decided here, when the image is built.
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

/** The configuration for `operator`'s build, from `source`, the repository's unless given. */
export function nginxConf(source = readFileSync(NGINX_CONF_SOURCE, 'utf8'), operator = OPERATOR) {
  if (source.split(STATUS_MARKER).length !== 2) {
    throw new Error(`nginx.conf must hold the line "${STATUS_MARKER.trim()}" once`);
  }

  const url = operator.statusPageUrl;

  return url === null ? source : source.replace(STATUS_MARKER, () => statusLocations(url));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];

  if (output === undefined) {
    console.error('Usage: node scripts/nginx-conf.mjs <output file>');
    process.exitCode = 1;
  } else {
    writeFileSync(resolve(output), nginxConf());
    console.log(
      `nginx configuration: wrote ${output}, /status ${OPERATOR.statusPageUrl === null ? 'the application 404' : 'redirecting to the status page'}`,
    );
  }
}
