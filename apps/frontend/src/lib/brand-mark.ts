/**
 * The Q mark in the header (issue #99, D209, amending D096): below 375 px the
 * wordmark, `Webhook Inspector` since issue #322 (D277), gives way to the
 * product's mark, so that 360 and 320 px keep `Changelog`, `Status ↗` and
 * `API docs ↗`, both dividers and both arrows on one row (Figma page
 * `Webhook Inspector · Status page link (#99)`, frames B′4, `733:53` and
 * `733:431`; frame A-5, `889:805`, of #322's page). It is still the link
 * home, and its accessible name stays `Webhook Inspector`: the wordmark's
 * text is kept for assistive technology, and the image is decoration.
 *
 * The image is the tab icon's PNG, which `public/` copies into every build and
 * nginx serves as a file (D183), drawn 24 × 24.
 *
 * The 375 px breakpoint is not here: Tailwind finds only a complete class, so
 * `AppHeader.tsx` writes `max-[375px]` and `changelog.css` writes
 * `max-width: 374.98px`, and `status-link.test.ts` pins both literals.
 */
export const BRAND_MARK = {
  src: '/favicon-192.png',
  size: 24,
} as const;
