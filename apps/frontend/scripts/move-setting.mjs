import { DEPRECATED_PREFIX, readChangelog } from './changelog.mjs';
import { SITE_ORIGINS } from './site-origin.mjs';

/**
 * The move of the inspector's pages to the site's second origin as the
 * application is built for it (issue #321, D276): the old origin, the new one
 * and day X, which `vite.config.ts` hands the bundle as `__WEBHOOK_INSPECTOR_MOVE__`.
 * The move banner shows on the old origin's pages only, and names the new
 * host and the day; its action leads to the new origin with the move link.
 *
 * The two origins are the build's own settings (D274, D275): the site's,
 * `APP_ORIGIN`, is the old one, and its second, `APP_ALIAS_ORIGIN`, the new
 * one. A build with no second origin - a copy at another address, or the site
 * once day X has passed and the second origin is its own - has no move, and
 * no page shows the banner.
 *
 * Day X is read from `CHANGELOG.md`, from the sentence of the move's
 * Deprecated paragraph that names it (`From <day> they stop answering`,
 * D275 item 2), which with D275 itself is the one place that names it: when
 * the Coordinator corrects that date, the banner follows with the next build.
 * A build with a move whose changelog names no such day fails, rather than
 * drawing a banner without its date. A build with no second origin needs no
 * day, and does not read the changelog for one (issue #346).
 *
 * Read by `vite.config.ts` and its tests only: it reads `CHANGELOG.md` and
 * `process.env`, and nothing the browser loads imports it.
 */

/** The sentence that names day X, as `changelog.test.ts` reads it. */
export const MOVE_DAY_SENTENCE = /\bFrom (\d{4}-\d{2}-\d{2}) they stop answering\b/;

/** Whether `text` is a calendar day, `YYYY-MM-DD`: `2026-02-30` is not. */
function isCalendarDay(text) {
  const time = Date.parse(`${text}T00:00:00Z`);

  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text;
}

/**
 * Day X as the changelog names it: the day of the newest Deprecated
 * paragraph with the sentence `From <day> they stop answering`, or `null`
 * when none has it. A day that is no calendar day is refused.
 */
export function moveDay(entries) {
  for (const entry of entries) {
    for (const paragraph of entry.paragraphs) {
      if (!paragraph.startsWith(DEPRECATED_PREFIX)) {
        continue;
      }

      const found = MOVE_DAY_SENTENCE.exec(paragraph);

      if (found === null) {
        continue;
      }

      if (!isCalendarDay(found[1])) {
        throw new Error(
          `CHANGELOG.md: ${entry.version} names day X as ${found[1]}, no calendar day`,
        );
      }

      return found[1];
    }
  }

  return null;
}

/**
 * The move this build carries: `{ from, to, day }`, the site's origin, its
 * second and day X, or `null` for a build with no second origin. `entries`
 * are the changelog's, read from `CHANGELOG.md` when not given - and only
 * once a second origin is found, so a build with none reads nothing.
 */
export function moveSetting(origins = SITE_ORIGINS, entries) {
  if (origins.alias === null || origins.alias === undefined) {
    return null;
  }

  const day = moveDay(entries ?? readChangelog());

  if (day === null) {
    throw new Error(
      'CHANGELOG.md names no day X: the move banner needs the Deprecated paragraph that says "From <YYYY-MM-DD> they stop answering"',
    );
  }

  return Object.freeze({ from: origins.app, to: origins.alias, day });
}
