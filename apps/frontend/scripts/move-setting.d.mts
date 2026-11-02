/** Types for `move-setting.mjs`, imported by `vite.config.ts` and the tests. */
import type { ChangelogEntry } from './changelog.mjs';
import type { SiteOrigins } from './site-origin.mjs';

/** The move a build carries (D276): the old origin, the new one and day X, `YYYY-MM-DD`. */
export interface BuiltMove {
  readonly from: string;
  readonly to: string;
  readonly day: string;
}

export const MOVE_DAY_SENTENCE: RegExp;
export function moveDay(entries: readonly ChangelogEntry[]): string | null;
export function moveSetting(
  origins?: SiteOrigins,
  entries?: readonly ChangelogEntry[],
): BuiltMove | null;
