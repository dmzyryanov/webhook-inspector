/** Types for `site-origin.mjs`, imported by the Vite configs, the copy modules and the tests. */
export interface SiteOrigins {
  readonly app: string;
  readonly receive: string;
  /** The site's second origin (D275); absent or `null`, none. */
  readonly alias?: string | null;
}

export const PRODUCTION_ORIGINS: SiteOrigins & { readonly alias: string };
export function parseSiteOrigin<T extends string | null>(
  name: string,
  raw: string | undefined,
  fallback: T,
  example?: string,
): string | T;
export function siteOrigins(env?: Record<string, string | undefined>): SiteOrigins;
export const SITE_ORIGINS: SiteOrigins;
export const APP_ORIGIN: string;
export const RECEIVE_ORIGIN: string;
export function relayApiOrigin(origins?: SiteOrigins): string;
export function isProduction(origins: SiteOrigins): boolean;
export function renameProduction(text: string, origins: SiteOrigins): string;
export function namesSecondOrigin(text: string): boolean;
export function nameSite(text: string, origins?: SiteOrigins): string;
export function siteOriginPlugin(origins?: SiteOrigins): {
  name: string;
  transformIndexHtml: { order: 'post'; handler: (html: string) => string };
};
