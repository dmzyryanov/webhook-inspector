import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { changelogPagePlugin } from './scripts/changelog.mjs';
import { siteOriginPlugin } from './scripts/site-origin.mjs';

/*
 * The changelog at /changelog (issue #97, D184), built after the application
 * and the API reference into the same `dist/` as a build of its own, for the
 * reason `vite.docs.config.ts` gives: built apart, it shares no script with the
 * application or with Scalar; the Inter font files are common.
 *
 * The page's body is written from `CHANGELOG.md` by `changelogPagePlugin()`,
 * so every build carries the entries as they are; a version with no date or
 * no bold headline fails it. Its script, stylesheet and fonts land under
 * `assets/` with a content hash, where nginx caches them for a year;
 * `changelog/index.html` is the page nginx serves at /changelog with
 * `Cache-Control: no-cache`. The dev server serves the page from the source
 * tree through the same plugin (`vite.config.ts`).
 */
export default defineConfig({
  // The page names this build's origins (D274).
  plugins: [changelogPagePlugin(), siteOriginPlugin()],
  // The application's build already copied public/ into dist/.
  publicDir: false,
  build: {
    // The application's build ran first and owns dist/.
    emptyOutDir: false,
    rolldownOptions: {
      input: { changelog: fileURLToPath(new URL('changelog/index.html', import.meta.url)) },
    },
  },
});
