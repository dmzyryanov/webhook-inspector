/**
 * Writes the agent-readable documentation into the frontend build (D165):
 *
 * - `llms.txt`, copied as written from `llms/llms.txt`: the llms.txt index
 *   (https://llmstxt.org) that points an agent at the files below;
 * - `llms-full.txt`, assembled from the agent section in
 *   `llms/agent-section.md`, the `info.description` of
 *   `packages/shared/openapi.json` byte for byte, and an endpoint list
 *   generated from its `paths`.
 *
 * Both are written for production and name the configured origins as the
 * build writes them (`site-origin.mjs`, D274): the description is the one the
 * build writes as `openapi.json` (`build-site-files.mjs`), and the agent
 * section and the index pass through `nameSite()`. Built for production, they
 * are what they were.
 *
 * Runs in `npm run build`, and so in the frontend image build, which copies
 * `packages/shared` in before it builds. Nothing it writes is committed: a
 * change to the description reaches `llms-full.txt` at the next build.
 * nginx serves both files from their own locations (nginx.conf); the dev
 * server serves them through `vite.config.ts`, which imports this module.
 *
 * Usage: node scripts/build-llms.mjs [dist directory]
 */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { openApiText } from './build-site-files.mjs';
import { APP_ORIGIN, nameSite, SITE_ORIGINS } from './site-origin.mjs';

export const OPENAPI_FILE = fileURLToPath(
  new URL('../../../packages/shared/openapi.json', import.meta.url),
);
export const LLMS_FILE = fileURLToPath(new URL('../llms/llms.txt', import.meta.url));
export const AGENT_SECTION_FILE = fileURLToPath(
  new URL('../llms/agent-section.md', import.meta.url),
);

/** The HTTP methods an OpenAPI path item can hold, in the order they are listed. */
const METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'trace'];

/**
 * One line per operation: method, path and summary, in the description's
 * order, and the host for a path item that names a server of its own: the
 * webhook operations are served by the webhook host alone (D187).
 */
export function endpointList(openapi) {
  const lines = [];

  for (const [path, item] of Object.entries(openapi.paths ?? {})) {
    const server = item.servers?.[0]?.url;
    const host = server ? ` (on ${server})` : '';

    for (const method of METHODS) {
      const operation = item[method];

      if (operation) {
        const summary = operation.summary ? ` — ${operation.summary}` : '';
        lines.push(`- \`${method.toUpperCase()} ${path}\`${summary}${host}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * The whole of `llms-full.txt`. `info.description` is inserted exactly as it
 * is in the description: no heading is shifted and no line rewritten.
 */
export function llmsFull({ openapi, agentSection, origin = APP_ORIGIN }) {
  const { title, version, description } = openapi.info;

  return [
    `# ${title} — the complete guide for agents`,
    '',
    `> Everything an agent needs to catch and read webhooks with Webhook Inspector at ${origin}, in one file. Generated from the OpenAPI description of version ${version} (${origin}/openapi.json); the same text is shown for people at ${origin}/docs.`,
    '',
    agentSection.trimEnd(),
    '',
    '## The API',
    '',
    description,
    '',
    '## Endpoints',
    '',
    `Every operation in ${origin}/openapi.json, on ${origin} unless another host is named. \`{sessionId}\` is the 43-character session id, \`{requestId}\` a captured request id.`,
    '',
    endpointList(openapi),
    '',
  ].join('\n');
}

/** Reads the sources from the repository and returns both files by name, under `origins`. */
export function buildLlmsFiles(origins = SITE_ORIGINS) {
  const openapi = JSON.parse(openApiText(origins));
  const agentSection = nameSite(readFileSync(AGENT_SECTION_FILE, 'utf8'), origins);

  return {
    'llms.txt': nameSite(readFileSync(LLMS_FILE, 'utf8'), origins),
    'llms-full.txt': llmsFull({ openapi, agentSection, origin: origins.app }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'dist');

  mkdirSync(dist, { recursive: true });

  for (const [name, text] of Object.entries(buildLlmsFiles())) {
    writeFileSync(join(dist, name), text);
    console.log(`agent documentation: wrote ${name} (${Buffer.byteLength(text)} bytes)`);
  }
}
