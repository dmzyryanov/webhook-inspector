import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { describe, it, mock } from 'node:test';
import { CHANGELOG_SOURCE, parseChangelog, readChangelog } from '../../scripts/changelog.mjs';
import { moveDay, moveSetting } from '../../scripts/move-setting.mjs';
import {
  PRODUCTION_ORIGINS,
  SITE_ORIGINS,
  type SiteOrigins,
  siteOrigins,
} from '../../scripts/site-origin.mjs';
import { formatMoveDay, moveBannerShown, parseBuiltMove } from './move-link.ts';
import { en } from '../i18n/en.ts';

/**
 * Where the move banner's origins and day come from (issue #321, D276): the
 * build's origin settings (D274, D275) and day X as `CHANGELOG.md` names it
 * (D275 item 2), handed to the bundle as `__WEBHOOK_INSPECTOR_MOVE__`. The banner
 * shows on the old origin of a build with a second one, and nowhere else.
 */

/** A source of two versions, the newer with the paragraphs given. */
function changelog(...paragraphs: string[]) {
  return parseChangelog(
    `# Header\n\n## 0.2.0\n\n2026-09-21\n\n**It changed.**\n\n${paragraphs.join('\n\n')}\n\n## 0.1.0\n\n2026-09-20\n\n**It started.**\n`,
  );
}

/**
 * The files `fs.readFileSync` reads while `run` runs. `changelog.mjs` reads
 * with the named import, which follows the module's own function only once
 * `syncBuiltinESMExports` is called, after the spy is put in and after it is
 * taken out.
 */
function filesRead(run: () => void): unknown[] {
  const spy = mock.method(fs, 'readFileSync');

  syncBuiltinESMExports();

  try {
    run();

    return spy.mock.calls.map((call) => call.arguments[0]);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
}

/** Day X as the changelog test reads it from the notice of the move (D275). */
const NOTICE_DAY = /\bFrom (\d{4}-\d{2}-\d{2}) they stop answering\b/.exec(
  readFileSync(new URL('../../../../CHANGELOG.md', import.meta.url), 'utf8').replace(/\s+/g, ' '),
)?.[1];

/**
 * The move a build for `origins` carries, from the changelog as that build
 * publishes it (#343): each case names its origins itself, so the ones the
 * shell running the tests holds change nothing here (#354).
 */
const moveOf = (origins: SiteOrigins) =>
  moveSetting(origins, readChangelog(CHANGELOG_SOURCE, origins));

describe('the move a build carries (D276)', () => {
  it('reads day X from the changelog’s notice of the move, the one place that names it', () => {
    assert.ok(NOTICE_DAY, 'CHANGELOG.md names no day X');
    assert.equal(moveDay(readChangelog(CHANGELOG_SOURCE, PRODUCTION_ORIGINS)), NOTICE_DAY);
  });

  it('moves production’s site to its second origin on that day', () => {
    const move = moveOf(PRODUCTION_ORIGINS);

    assert.deepEqual(move, {
      from: 'https://qa-tools.ru',
      to: 'https://webhook.qa-tools.ru',
      day: NOTICE_DAY,
    });
    assert.deepEqual(parseBuiltMove(JSON.parse(JSON.stringify(move))), move);
    // The banner: on the old origin, not on the new one.
    assert.equal(moveBannerShown('https://qa-tools.ru', move), true);
    assert.equal(moveBannerShown('https://webhook.qa-tools.ru', move), false);
    assert.match(formatMoveDay(move?.day ?? '', en), /^\d{1,2}\u00a0[A-Z][a-z]{2}\u00a0\d{4}$/);
  });

  it('is the build’s origins: a copy with a second origin moves to it, one with none has no move', () => {
    const copy = { app: 'https://inspector.example', receive: 'https://hook.inspector.example' };

    assert.deepEqual(moveOf(siteOrigins({}))?.to, PRODUCTION_ORIGINS.alias);
    assert.equal(moveOf({ ...copy, alias: null }), null);
    assert.equal(moveOf(copy), null);
    assert.deepEqual(moveOf({ ...copy, alias: 'https://next.inspector.example' }), {
      from: copy.app,
      to: 'https://next.inspector.example',
      day: NOTICE_DAY,
    });
    // Day X's site, at the second origin with none of its own (#324): no banner anywhere.
    assert.equal(
      moveOf({
        app: 'https://webhook.qa-tools.ru',
        receive: 'https://hook.qa-tools.ru',
        alias: null,
      }),
      null,
    );
  });

  it('takes the newest Deprecated paragraph that names the day, and no other paragraph', () => {
    assert.equal(
      moveDay(
        changelog(
          'From 2027-01-02 they stop answering, says a plain paragraph.',
          '**Notice:** From 2027-01-03 they stop answering.',
          '**Deprecated:** the old addresses. From 2027-01-04 they stop answering on the old host.',
          '**Deprecated:** From 2027-01-05 they stop answering, a second notice.',
        ),
      ),
      '2027-01-04',
    );
    assert.equal(moveDay(changelog('**Deprecated:** something, removed on 2027-01-04.')), null);
  });

  it('fails a build that moves when the changelog names no day X, or no calendar day', () => {
    const origins = { ...PRODUCTION_ORIGINS };

    assert.throws(
      () => moveSetting(origins, changelog('**Deprecated:** something, removed on 2027-01-04.')),
      /names no day X/,
    );
    assert.throws(
      () => moveSetting(origins, changelog('**Deprecated:** From 2027-02-30 they stop answering.')),
      /no calendar day/,
    );
    // A build with no move asks the changelog nothing: one that names no day passes.
    assert.equal(moveSetting({ ...origins, alias: null }, changelog()), null);
  });

  it('reads CHANGELOG.md only once it has found a second origin (#346)', () => {
    const copy = { app: 'https://inspector.example', receive: 'https://hook.inspector.example' };

    for (const origins of [
      copy,
      { ...copy, alias: null },
      { ...PRODUCTION_ORIGINS, alias: null },
    ]) {
      assert.deepEqual(
        filesRead(() => assert.equal(moveSetting(origins), null)),
        [],
        JSON.stringify(origins),
      );
    }

    // The control, that the spy sees the read: a build with a second origin
    // and no entries reads the changelog, once, for the day it gives.
    let move: unknown;

    assert.deepEqual(
      filesRead(() => {
        move = moveSetting(PRODUCTION_ORIGINS);
      }),
      [CHANGELOG_SOURCE],
    );
    assert.deepEqual(move, moveOf(PRODUCTION_ORIGINS));
    // What `vite.config.ts` hands the bundle, both defaults taken, is unchanged.
    assert.deepEqual(moveSetting(), moveSetting(SITE_ORIGINS, readChangelog()));
  });

  it('is what vite.config.ts hands the bundle', () => {
    const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');

    assert.match(config, /__WEBHOOK_INSPECTOR_MOVE__: JSON\.stringify\(moveSetting\(\)\)/);
  });
});
