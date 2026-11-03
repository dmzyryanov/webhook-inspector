/** Types for `build-site-files.mjs`, imported by `vite.config.ts` and the tests. */
import type { Operator } from '../src/lib/operator.ts';
import type { SiteOrigins } from './site-origin.mjs';

export const OPENAPI_SOURCE: string;
export const NAMED_PUBLIC_FILES: string[];
export function productionRelayScriptText(): string;
export function relayScriptText(origins?: SiteOrigins): string;
/** `operator` is the build's unless given (issue #369). */
export function openApiText(origins?: SiteOrigins, operator?: Operator): string;
export function siteFiles(origins?: SiteOrigins, operator?: Operator): Record<string, string>;
