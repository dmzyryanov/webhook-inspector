/** Types for `build-llms.mjs`, imported by `vite.config.ts` and the tests. */
import type { Operator } from '../src/lib/operator.ts';
import type { SiteOrigins } from './site-origin.mjs';

export interface OpenApiDescription {
  info: { title: string; version: string; description: string };
  paths?: Record<string, Record<string, unknown>>;
}

export const OPENAPI_FILE: string;
export const LLMS_FILE: string;
export const AGENT_SECTION_FILE: string;

export function endpointList(openapi: OpenApiDescription): string;
export function llmsFull(sources: {
  openapi: OpenApiDescription;
  agentSection: string;
  /** The site's origin the header names; the build's `APP_ORIGIN` unless given. */
  origin?: string;
}): string;
/** `operator` is the build's unless given (issue #369). */
export function buildLlmsFiles(
  origins?: SiteOrigins,
  operator?: Operator,
): {
  'llms.txt': string;
  'llms-full.txt': string;
};
