/**
 * The status pill's class and look (issue #138, D207). Which states are drawn
 * as a pill is `response-summary.test.ts`'s; that every code clears AA on its
 * tint is `contrast.test.ts`'s.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RESPONSE_STATUS_MAX, RESPONSE_STATUS_MIN } from '@webhook-inspector/shared';
import {
  STATUS_PILL_COLOURS,
  statusClass,
  statusPillClassName,
  type StatusClass,
} from './status-pill.ts';

describe('statusClass', () => {
  it('is the first digit of the code', () => {
    const cases: Array<[number, StatusClass]> = [
      [200, '2xx'],
      [201, '2xx'],
      [204, '2xx'],
      [299, '2xx'],
      [300, '3xx'],
      [301, '3xx'],
      [304, '3xx'],
      [399, '3xx'],
      [400, '4xx'],
      [401, '4xx'],
      [404, '4xx'],
      [422, '4xx'],
      [429, '4xx'],
      [499, '4xx'],
      [500, '5xx'],
      [503, '5xx'],
      [511, '5xx'],
      [599, '5xx'],
    ];

    for (const [status, expected] of cases) {
      assert.equal(statusClass(status), expected, `${status}`);
    }
  });

  it('gives every status a session can be set to one of the four classes', () => {
    for (let status = RESPONSE_STATUS_MIN; status <= RESPONSE_STATUS_MAX; status += 1) {
      assert.equal(statusClass(status), `${Math.floor(status / 100)}xx`, `${status}`);
    }
  });

  /** Never reachable from a record; drawn in the nearest class rather than throwing. */
  it('takes the nearest class outside the configurable range', () => {
    assert.equal(statusClass(100), '2xx');
    assert.equal(statusClass(600), '5xx');
  });
});

describe('statusPillClassName', () => {
  /** Acceptance criterion 1 of issue #138: 200, 301, 404 and 503. */
  it('tints the pill by class, in the tokens of that class alone', () => {
    const cases: Array<[number, string]> = [
      [200, 'bg-status-2xx text-status-2xx-ink'],
      [301, 'bg-status-3xx text-status-3xx-ink'],
      [404, 'bg-status-4xx text-status-4xx-ink'],
      [503, 'bg-status-5xx text-status-5xx-ink'],
    ];

    for (const [status, colours] of cases) {
      for (const place of ['heading', 'row'] as const) {
        const classes = statusPillClassName(status, place).split(' ');

        for (const colour of colours.split(' ')) {
          assert.ok(classes.includes(colour), `${status} in the ${place} lacks ${colour}`);
        }
        assert.equal(classes.filter((name) => name.startsWith('bg-')).length, 1);
        assert.equal(classes.filter((name) => /^text-(?!\[)/.test(name)).length, 1);
      }
    }
  });

  it('draws no status in the interface green or red', () => {
    for (const colours of Object.values(STATUS_PILL_COLOURS)) {
      assert.doesNotMatch(colours, /\btext-(ok|danger)\b/);
    }

    for (let status = RESPONSE_STATUS_MIN; status <= RESPONSE_STATUS_MAX; status += 1) {
      assert.doesNotMatch(statusPillClassName(status, 'row'), /\btext-(ok|danger)\b/);
    }
  });

  it('is fully rounded, borderless and kept whole, at the heading and row sizes', () => {
    const heading = statusPillClassName(500, 'heading').split(' ');
    const row = statusPillClassName(500, 'row').split(' ');

    for (const classes of [heading, row]) {
      for (const shape of ['rounded-full', 'font-semibold', 'shrink-0', 'whitespace-nowrap']) {
        assert.ok(classes.includes(shape), `missing ${shape}`);
      }
      assert.equal(
        classes.some((name) => name === 'border' || name.startsWith('border-')),
        false,
      );
    }

    // Heading: Semi Bold 14/17, padded 2 × 8. Row: 11/14, padded 0 × 6.
    for (const name of ['text-[14px]', 'leading-[17px]', 'px-2', 'py-0.5']) {
      assert.ok(heading.includes(name), `the heading's pill lacks ${name}`);
    }
    for (const name of ['text-[11px]', 'leading-[14px]', 'px-1.5']) {
      assert.ok(row.includes(name), `the row's pill lacks ${name}`);
    }
    assert.equal(
      row.some((name) => name.startsWith('py-')),
      false,
    );
  });
});
