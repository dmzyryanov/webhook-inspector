/** Types for `site-operator.mjs`, imported by the Vite configurations and the tests. */
import type { Operator } from '../src/lib/operator.ts';

export const WRITTEN_STATUS_PAGE: string;
export const WRITTEN_STATUS_PAGE_IN_PROSE: string;
export const WRITTEN_CONTACT: string;
export const DESCRIPTION_PARAGRAPHS: Readonly<{
  status: string;
  about: string;
  legal: string;
  feeds: string;
}>;
export const DOCS_FEED_COMMENT: string;

/** Each `operator` is the build's unless given. */
export function operatorSitemap(text: string, operator?: Operator): string;
export function operatorLlmsIndex(text: string, operator?: Operator): string;
export function operatorDescription(description: string, operator?: Operator): string;
export function operatorOpenApi(text: string, operator?: Operator): string;
export function operatorDocsPage(html: string, operator?: Operator): string;
export function docsPagePlugin(): import('vite').Plugin;
