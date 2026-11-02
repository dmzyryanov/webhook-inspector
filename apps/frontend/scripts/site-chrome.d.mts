/** Types for `site-chrome.mjs`, imported by `changelog.mjs`, `about.mjs`, `legal.mjs` and the tests. */
export function escapeHtml(text: string): string;
export function escapeText(text: string): string;
/** `lang` is the page's language, English unless given; anything but `en` and `ru` throws. */
export function siteHeader(page: string, lang?: string): string;
export function siteFooter(page: string, lang?: string): string;
export function keptRuns<Part extends { readonly kind: string; readonly text: string }>(
  parts: readonly Part[],
  renderPart: (part: Part) => string,
): string;
