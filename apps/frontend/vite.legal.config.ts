import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { legalPagesPlugin } from './scripts/legal.mjs';
import { siteOriginPlugin } from './scripts/site-origin.mjs';

/*
 * The Terms of Use at /terms and the Privacy Policy at /privacy (issue #112,
 * D217), built after the application, the API reference, the changelog and
 * the about page into the same `dist/` as one build of their own, for the
 * reason `vite.docs.config.ts` gives: built apart, they share no script with
 * the application or with Scalar; the Inter font files are common.
 *
 * Each page's body is written from `src/lib/legal-copy.ts` by
 * `legalPagesPlugin()`. They load no script: their one stylesheet, the header
 * and the footer band's included (`src/static-pages/site-chrome.css`), and its
 * fonts land under `assets/` with a content hash, where nginx caches them for
 * a year; `terms/index.html` and `privacy/index.html` are the pages nginx
 * serves at /terms and /privacy with `Cache-Control: no-cache`. The dev server
 * serves them from the source tree through the same plugin (`vite.config.ts`).
 */
export default defineConfig({
  // The page names this build's origins (D274).
  plugins: [legalPagesPlugin(), siteOriginPlugin()],
  // The application's build already copied public/ into dist/.
  publicDir: false,
  build: {
    // The application's build ran first and owns dist/.
    emptyOutDir: false,
    rolldownOptions: {
      input: {
        terms: fileURLToPath(new URL('terms/index.html', import.meta.url)),
        privacy: fileURLToPath(new URL('privacy/index.html', import.meta.url)),
      },
    },
  },
});
