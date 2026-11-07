/** Types for `site-operator.mjs`, imported by the Vite configurations and the tests. */
import type { Operator } from '../src/lib/operator.ts';

export const WRITTEN_STATUS_PAGE: string;
export const WRITTEN_STATUS_PAGE_IN_PROSE: string;
export const WRITTEN_CONTACT: string;
export const WRITTEN_SERVER_ADDRESS: string;
export const NETWORK_HEADING: string;
export const NETWORK_POINTER: string;
export const MOVE_BULLET: string;
export const ADDRESS_BULLET: string;
export const RELAY_HEADING: string;
export const OLD_NAME_BULLET: string;
export const DESCRIPTION_PARAGRAPHS: Readonly<{
  status: string;
  about: string;
  legal: string;
  feeds: string;
}>;
export const DOCS_FEED_COMMENT: string;

/** Each `operator` is the build's unless given; `hasMove`, whether the build has a second origin, is true unless given. */
export function operatorSitemap(text: string, operator?: Operator): string;
export function operatorLlmsIndex(text: string, operator?: Operator): string;
export function operatorDescription(
  description: string,
  operator?: Operator,
  hasMove?: boolean,
): string;
export function operatorOpenApi(text: string, operator?: Operator, hasMove?: boolean): string;
export function operatorDocsPage(html: string, operator?: Operator): string;
export function docsPagePlugin(): import('vite').Plugin;
