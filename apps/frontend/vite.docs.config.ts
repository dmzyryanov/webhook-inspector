import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/*
 * The API reference at /docs (D155), built after the application into the
 * same `dist/` as a build of its own. A second build rather than a second
 * entry of `vite.config.ts`: two entries of one build share chunks, and the
 * application would then load a chunk the reference page also uses. Built
 * apart, the application's output is exactly what it was before the page
 * existed, and Scalar cannot reach it.
 *
 * Every file lands under `assets/` with a content hash in its name, where
 * nginx caches it for a year; `docs/index.html` is the page nginx serves at
 * /docs with `Cache-Control: no-cache`. The dev server needs none of this: it
 * serves `docs/index.html` from the source tree (`vite.config.ts`).
 */
export default defineConfig({
  // Scalar is built on Vue's esm-bundler build, which expects its bundler to
  // set these. Options API on as Vue's default; the devtools hooks off.
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  // The application's build already copied public/ - robots.txt, sitemap.xml
  // and the logo images (D183) - into dist/; copying it again would change
  // nothing.
  publicDir: false,
  build: {
    // The application's build ran first and owns dist/.
    emptyOutDir: false,
    rolldownOptions: {
      input: { docs: fileURLToPath(new URL('docs/index.html', import.meta.url)) },
    },
    // Scalar is one large page by design, and is loaded only on /docs.
    chunkSizeWarningLimit: 2048,
  },
});
