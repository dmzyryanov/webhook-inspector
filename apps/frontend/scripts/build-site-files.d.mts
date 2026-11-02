/** Types for `build-site-files.mjs`, imported by `vite.config.ts` and the tests. */
import type { SiteOrigins } from './site-origin.mjs';

export const OPENAPI_SOURCE: string;
export const NAMED_PUBLIC_FILES: string[];
export function productionRelayScriptText(): string;
export function relayScriptText(origins?: SiteOrigins): string;
export function openApiText(origins?: SiteOrigins): string;
export function siteFiles(origins?: SiteOrigins): Record<string, string>;
