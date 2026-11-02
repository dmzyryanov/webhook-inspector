import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { aboutPagePlugin } from './scripts/about.mjs';
import { siteOriginPlugin } from './scripts/site-origin.mjs';

/*
 * The about page at /about (issue #131, D211), built after the application,
 * the API reference and the changelog into the same `dist/` as a build of its
 * own, for the reason `vite.docs.config.ts` gives: built apart, it shares no
 * script with the application or with Scalar; the Inter font files are
 * common.
 *
 * Its Russian twin at /ru/about (issue #170, D255) is a second input of the
 * same build, `ru/about/index.html`, sharing the stylesheet.
 *
 * The page's body is written from `src/lib/about-copy.ts` by
 * `aboutPagePlugin()`, the Russian page's from `src/lib/about-copy-ru.ts`.
 * It loads no script: its stylesheet, the header and the
 * footer band's included (`src/static-pages/site-chrome.css`), and its fonts
 * land under `assets/` with a content hash, where nginx caches them for a
 * year; `about/index.html` is the page nginx serves at /about with
 * `Cache-Control: no-cache`, and `ru/about/index.html` the one at /ru/about.
 * The dev server serves both from the source tree through the same plugin
 * (`vite.config.ts`).
 */
export default defineConfig({
  // The page names this build's origins (D274).
  plugins: [aboutPagePlugin(), siteOriginPlugin()],
  // The application's build already copied public/ into dist/.
  publicDir: false,
  build: {
    // The application's build ran first and owns dist/.
    emptyOutDir: false,
    rolldownOptions: {
      input: {
        about: fileURLToPath(new URL('about/index.html', import.meta.url)),
        'ru-about': fileURLToPath(new URL('ru/about/index.html', import.meta.url)),
      },
    },
  },
});
