/** Types for `nginx-conf.mjs`, imported by the tests. */
import type { Operator } from '../src/lib/operator.ts';

export const NGINX_CONF_SOURCE: string;
export const STATUS_MARKER: string;
export function statusLocations(url: string): string;
/** `source` is the repository's `nginx.conf` and `operator` the build's unless given. */
export function nginxConf(source?: string, operator?: Operator): string;
