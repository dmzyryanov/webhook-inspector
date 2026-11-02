import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { aboutPagePlugin } from './scripts/about.mjs';
import { buildLlmsFiles } from './scripts/build-llms.mjs';
import { NAMED_PUBLIC_FILES, openApiText, siteFiles } from './scripts/build-site-files.mjs';
import {
  BREAKING_FEED_PATH,
  changelogFeed,
  changelogMarkdown,
  changelogPagePlugin,
  FEED_PATH,
  readChangelog,
} from './scripts/changelog.mjs';
import { legalPagesPlugin } from './scripts/legal.mjs';
import { moveSetting } from './scripts/move-setting.mjs';
import { OLD_RELAY_SCRIPT_NAME } from './scripts/relay-script.mjs';
import { isProduction, SITE_ORIGINS, siteOriginPlugin } from './scripts/site-origin.mjs';

/*
 * The dev server's two addresses, from the environment with today's values as
 * defaults: `npm run dev:frontend` behaves exactly as it did before they
 * existed, and nothing else has to set them.
 *
 * They are read rather than hardcoded because the browser smoke suite starts
 * its own backend and its own dev server, and this proxy target used to be a
 * second, independent copy of that backend's port. Overriding one and not the
 * other put the browser into a different backend - a developer's, with a
 * developer's database - while the suite health-checked its own, which passes
 * and has tested the wrong system. The suite now supplies both from one value
 * (`e2e/app-address.ts`).
 *
 * This file deliberately does **not** import that module: the frontend
 * workspace builds in its own Docker context and must not reach outside it. The
 * environment is the seam.
 */
const backend = process.env.WEBHOOK_INSPECTOR_BACKEND_ORIGIN ?? 'http://127.0.0.1:3000';
const port = Number(process.env.WEBHOOK_INSPECTOR_FRONTEND_PORT ?? 5173);

/**
 * The two addresses production's nginx serves around the API reference (D155),
 * reproduced for the dev server and so for the browser suite that runs on it:
 *
 * - `/docs` and `/docs/` answer the reference page, `docs/index.html`, with
 *   `Cache-Control: no-cache`. Left alone, Vite answers `/docs` with the
 *   application shell;
 * - `/openapi.json` answers `packages/shared/openapi.json` as JSON with
 *   `Cache-Control: no-cache`, as the image does (D154), under the origins
 *   the build names (`scripts/build-site-files.mjs`, D274). Left alone, Vite
 *   answers it with the application shell too.
 * - `/robots.txt`, `/sitemap.xml` and `/webhook-inspector-relay.mjs` answer
 *   the files the build writes from `public/` when `APP_ORIGIN`,
 *   `RECEIVE_ORIGIN` or `APP_ALIAS_ORIGIN` names another site. Under
 *   production's, Vite serves them from `public/` as it always has: they are
 *   the same bytes. `/qa-tools-relay.mjs`, the relay script under its old
 *   name (D279), which is in no `public/` file, answers the file the build
 *   writes whatever the origins.
 * - `/llms.txt` and `/llms-full.txt` answer the agent documentation as
 *   Markdown with `Cache-Control: no-cache` (D165), generated on each request
 *   by `scripts/build-llms.mjs`, the module the build writes them with.
 * - `/changelog` and `/changelog/` answer the changelog page,
 *   `changelog/index.html`, whose body `changelogPagePlugin()` writes from
 *   `CHANGELOG.md`, and `/changelog.md` its text as Markdown, both with
 *   `Cache-Control: no-cache` (D184), generated on each request by
 *   `scripts/changelog.mjs`, the module the build writes them with;
 *   `/changelog.xml` and `/changelog-breaking.xml` its two Atom feeds as
 *   `application/atom+xml; charset=utf-8`, the same way (D212).
 * - `/about` and `/about/` answer the about page, `about/index.html`, whose
 *   body `aboutPagePlugin()` writes from `src/lib/about-copy.ts`, with
 *   `Cache-Control: no-cache` (D211), as the build writes it; `/ru/about`
 *   and `/ru/about/` its Russian twin, `ru/about/index.html`, the same way
 *   from `src/lib/about-copy-ru.ts` (D255).
 * - `/terms`, `/terms/`, `/privacy` and `/privacy/` answer the Terms of Use,
 *   `terms/index.html`, and the Privacy Policy, `privacy/index.html`, whose
 *   bodies `legalPagesPlugin()` writes from `src/lib/legal-copy.ts`, with
 *   `Cache-Control: no-cache` (D217), as the build writes them.
 * - `/ru` and `/ru/` answer the Russian home page, `ru/index.html`, the
 *   application with a Russian head, with `Cache-Control: no-cache` (D226).
 *   Left alone, Vite answers `/ru/` with it too but `/ru` with the English
 *   shell, whose address the application would still read as Russian.
 *
 * `apps/frontend/nginx.conf` is the production side and
 * `src/lib/docs-serving.test.ts` reads it. The page itself is built by
 * `vite.docs.config.ts`, as a second build. This runs in the dev server only;
 * the description is read when it is asked for, never at build time, so the
 * image build does not depend on it.
 */
function apiReferencePages(): Plugin {
  return {
    name: 'webhook-inspector-api-reference-pages',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          next();
          return;
        }

        if (path === '/docs' || path === '/docs/') {
          req.url = '/docs/index.html';
          res.setHeader('Cache-Control', 'no-cache');
          next();
          return;
        }

        if (path === '/changelog' || path === '/changelog/') {
          req.url = '/changelog/index.html';
          res.setHeader('Cache-Control', 'no-cache');
          next();
          return;
        }

        if (path === '/about' || path === '/about/') {
          req.url = '/about/index.html';
          res.setHeader('Cache-Control', 'no-cache');
          next();
          return;
        }

        if (path === '/ru/about' || path === '/ru/about/') {
          req.url = '/ru/about/index.html';
          res.setHeader('Cache-Control', 'no-cache');
          next();
          return;
        }

        if (path === '/ru' || path === '/ru/') {
          req.url = '/ru/index.html';
          res.setHeader('Cache-Control', 'no-cache');
          next();
          return;
        }

        if (path === '/terms' || path === '/terms/') {
          req.url = '/terms/index.html';
          res.setHeader('Cache-Control', 'no-cache');
          next();
          return;
        }

        if (path === '/privacy' || path === '/privacy/') {
          req.url = '/privacy/index.html';
          res.setHeader('Cache-Control', 'no-cache');
          next();
          return;
        }

        if (path === '/changelog.md') {
          const body = changelogMarkdown(readChangelog());

          res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }

        if (path === FEED_PATH || path === BREAKING_FEED_PATH) {
          const body = changelogFeed(readChangelog(), path === FEED_PATH ? 'all' : 'breaking');

          res.setHeader('Content-Type', 'application/atom+xml; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }

        if (path === '/openapi.json') {
          const body = openApiText();

          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }

        const named = (path ?? '').slice(1);

        if (
          named === OLD_RELAY_SCRIPT_NAME ||
          (!isProduction(SITE_ORIGINS) && NAMED_PUBLIC_FILES.includes(named))
        ) {
          const type = named.endsWith('.txt')
            ? 'text/plain; charset=utf-8'
            : named.endsWith('.xml')
              ? 'application/xml'
              : 'text/javascript';

          res.setHeader('Content-Type', type);
          res.end(req.method === 'HEAD' ? undefined : siteFiles()[named]);
          return;
        }

        if (path === '/llms.txt' || path === '/llms-full.txt') {
          const body = buildLlmsFiles()[path === '/llms.txt' ? 'llms.txt' : 'llms-full.txt'];

          res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    apiReferencePages(),
    changelogPagePlugin(),
    aboutPagePlugin(),
    legalPagesPlugin(),
    siteOriginPlugin(),
  ],
  // The move of the inspector's pages to the site's second origin (D276): the
  // old origin, the new one and day X from CHANGELOG.md, or null for a build
  // with no second origin. `src/lib/move-link.ts` reads it; the banner shows
  // on the old origin only.
  define: {
    __WEBHOOK_INSPECTOR_MOVE__: JSON.stringify(moveSetting()),
  },
  build: {
    // Two pages of one application (D226): the English home page and every
    // other address the shell serves, and the Russian home page at /ru/, the
    // same script under a head of its own. One build, so the two share every
    // chunk; the pages that must share nothing with it are built apart.
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        ru: fileURLToPath(new URL('ru/index.html', import.meta.url)),
      },
    },
  },
  server: {
    port,
    // The browser must see one origin, exactly as in production where the
    // Ingress serves the frontend and the API from qa-tools.ru (D060). The
    // prefixes proxied here are the four the Ingress sends to the backend,
    // each a string prefix as there: three ending in their slash (D047, D183),
    // so a bare '/api', '/ws' or '/s' stays the frontend's, and '/mcp'
    // (D203). The slash also keeps '/s/' off the dev server's own '/src/...'
    // modules, which a plain '/s' prefix would swallow.
    //
    // '/s/' reaches the application listener, which answers 410 / 1009 there
    // as production's qa-tools.ru does (D187). Webhooks are not proxied: the
    // receive URL the page shows is the backend's receive listener itself,
    // http://127.0.0.1:3001 unless RECEIVE_ORIGIN says otherwise, because a
    // proxy in front of a capture would rewrite the headers it exists to show.
    proxy: {
      '/api/': { target: backend },
      '/ws/': { target: backend, ws: true },
      '/s/': { target: backend },
      // The MCP endpoint (D203). Like the Ingress's Prefix path, it also
      // sends /mcp/ and /mcpx to the backend, which answers them 404 / 1000.
      '/mcp': { target: backend },
    },
  },
});
