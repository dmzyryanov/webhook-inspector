/** Types for `nginx-conf.mjs`, imported by the tests. */
import type { Operator } from '../src/lib/operator.ts';

export const NGINX_CONF_SOURCE: string;
export const STATUS_MARKER: string;
export function statusLocations(url: string): string;
export const CHANGELOG_FILE_LOCATIONS: readonly string[];
/** `source` without the exact location of `path`, its comment and the blank line after it. */
export function withoutLocation(source: string, path: string): string;
/** `source` is the repository's `nginx.conf` and `operator` the build's unless given. */
export function nginxConf(source?: string, operator?: Operator): string;
