import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { expandLabel, expandTarget, filterDays } from './changelog-controls.ts';

/**
 * The two controls of `/changelog` (issue #97, D184): the filter and
 * `Expand all`. `src/changelog/main.ts` applies these to the page;
 * `e2e/changelog.spec.ts` presses them in a browser.
 */
describe('the Breaking filter', () => {
  // Three days: one mixed, one with no breaking version, one all breaking.
  const days = [[false, true, false], [false, false], [true]];

  it('shows everything under All versions', () => {
    assert.deepEqual(filterDays(days, 'all'), [
      { day: true, versions: [true, true, true] },
      { day: true, versions: [true, true] },
      { day: true, versions: [true] },
    ]);
  });

  it('leaves only breaking versions, and hides the days left empty', () => {
    assert.deepEqual(filterDays(days, 'breaking'), [
      { day: true, versions: [false, true, false] },
      { day: false, versions: [false, false] },
      { day: true, versions: [true] },
    ]);
  });
});

describe('Expand all', () => {
  it('reads Collapse all once every line is open, and Expand all otherwise', () => {
    assert.equal(expandLabel([true, false, false]), 'Expand all');
    assert.equal(expandLabel([true, true, true]), 'Collapse all');
    assert.equal(expandLabel([false]), 'Expand all');
    assert.equal(expandLabel([]), 'Expand all');
  });

  it('opens every line, or, when every one is open, closes them', () => {
    assert.equal(expandTarget([true, false]), true);
    assert.equal(expandTarget([true, true]), false);
  });
});
