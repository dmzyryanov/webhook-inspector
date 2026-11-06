import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { changelogPagePlugin } from './scripts/changelog.mjs';
import { siteOriginPlugin } from './scripts/site-origin.mjs';
import { changelogShown } from './src/lib/changelog-link.ts';

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
 *
 * The changelog's entries are the operator's texts (issue #396): a build that
 * does not show them (`OPERATOR_TEXTS`, `src/lib/operator.ts`) writes
 * nothing here, neither the page nor its script and stylesheet, as
 * `vite.legal.config.ts` writes no legal page, so `/changelog` answers the
 * application's 404 (`nginx.conf`). It still runs, on the same inputs, so
 * that the build's steps are the same either way.
 */
export default defineConfig({
  // The page names this build's origins (D274).
  plugins: [changelogPagePlugin(), siteOriginPlugin()],
  // The application's build already copied public/ into dist/.
  publicDir: false,
  build: {
    // The application's build ran first and owns dist/.
    emptyOutDir: false,
    write: changelogShown(),
    rolldownOptions: {
      input: { changelog: fileURLToPath(new URL('changelog/index.html', import.meta.url)) },
    },
  },
});
