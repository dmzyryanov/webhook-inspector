/** Types for `site-chrome.mjs`, imported by `changelog.mjs`, `about.mjs`, `legal.mjs` and the tests. */
import type { Operator } from '../src/lib/operator.ts';

export function escapeHtml(text: string): string;
export function escapeText(text: string): string;
/**
 * `lang` is the page's language, English unless given; anything but `en` and
 * `ru` throws. `operator` is the build's unless given (issue #369).
 */
export function siteHeader(page: string, lang?: string, operator?: Operator): string;
export function siteFooter(page: string, lang?: string, operator?: Operator): string;
export function keptRuns<Part extends { readonly kind: string; readonly text: string }>(
  parts: readonly Part[],
  renderPart: (part: Part) => string,
): string;
