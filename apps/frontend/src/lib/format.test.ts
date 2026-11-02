import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BASE_DOCUMENT_TITLE,
  formatBytesCompact,
  formatDetailTimestamp,
  formatDocumentTitle,
  formatResponseStatus,
  formatTimestamp,
  isFailureStatus,
  RECEIVE_URL_TAIL,
  splitForMiddleEllipsis,
} from './format.ts';

describe('formatBytesCompact', () => {
  /**
   * One spelling everywhere: the list rows, the detail summary line and the
   * session response settings dialog all print a size through this (D014,
   * D071). There is no singular case to keep any more - `1 byte` went with the
   * long form.
   */
  it('uses the compact unit the whole application shows', () => {
    assert.equal(formatBytesCompact(0), '0 B');
    assert.equal(formatBytesCompact(1), '1 B');
    assert.equal(formatBytesCompact(61), '61 B');
    assert.equal(formatBytesCompact(172), '172 B');
    assert.equal(formatBytesCompact(742), '742 B');
    assert.equal(formatBytesCompact(1023), '1023 B');
  });

  it('switches units above a kilobyte', () => {
    assert.equal(formatBytesCompact(1024), '1.0 KB');
    assert.equal(formatBytesCompact(1024 * 1024), '1.0 MB');
  });
});

describe('formatTimestamp', () => {
  it('renders a UTC timestamp in the requested timezone (D042)', () => {
    const iso = '2026-08-22T00:14:32Z';

    assert.equal(formatTimestamp(iso, 'UTC'), '2026-08-22 00:14:32');
    assert.equal(formatTimestamp(iso, 'Europe/Moscow'), '2026-08-22 03:14:32');
    // A zone behind UTC moves the date back, not only the clock.
    assert.equal(formatTimestamp(iso, 'America/New_York'), '2026-08-21 20:14:32');
  });

  it('keeps midnight readable rather than printing 24', () => {
    assert.equal(formatTimestamp('2026-08-22T00:00:00Z', 'UTC'), '2026-08-22 00:00:00');
  });
});

/**
 * The detail panel's time, as the approved frames draw it (D148). Each row is
 * one rule of the format, with the zone pinned so the machine running the test
 * does not decide the answer.
 */
describe('formatDetailTimestamp', () => {
  const cases: { rule: string; iso: string; timeZone: string; expected: string }[] = [
    {
      rule: 'a two-digit day',
      iso: '2026-09-17T14:32:06Z',
      timeZone: 'UTC',
      expected: '17 Sep 2026, 14:32:06',
    },
    {
      rule: 'a one-digit day without a leading zero, over a padded clock',
      iso: '2026-09-05T09:04:05Z',
      timeZone: 'UTC',
      expected: '5 Sep 2026, 09:04:05',
    },
    {
      rule: 'midnight as 00, never 24',
      iso: '2026-09-05T00:02:06Z',
      timeZone: 'UTC',
      expected: '5 Sep 2026, 00:02:06',
    },
    {
      rule: 'midnight to the second',
      iso: '2026-08-22T00:00:00Z',
      timeZone: 'UTC',
      expected: '22 Aug 2026, 00:00:00',
    },
    {
      rule: 'a zone ahead of UTC moving the date forward',
      iso: '2026-09-17T23:30:00Z',
      timeZone: 'Europe/Moscow',
      expected: '18 Sep 2026, 02:30:00',
    },
    {
      rule: 'a zone behind UTC moving the date, and the month, back',
      iso: '2026-09-01T02:00:00Z',
      timeZone: 'America/New_York',
      expected: '31 Aug 2026, 22:00:00',
    },
    {
      rule: 'a zone moving the year, landing on its midnight',
      iso: '2026-12-31T21:00:00Z',
      timeZone: 'Europe/Moscow',
      expected: '1 Jan 2027, 00:00:00',
    },
  ];

  for (const { rule, iso, timeZone, expected } of cases) {
    it(`writes ${rule}: ${expected}`, () => {
      assert.equal(formatDetailTimestamp(iso, timeZone), expected);
    });
  }

  /** `en-GB` writes `Sept` in current ICU; the design writes `Sep`. */
  it('spells September Sep, not Sept', () => {
    const line = formatDetailTimestamp('2026-09-17T14:32:06Z', 'UTC');

    assert.match(line, / Sep 2026,/);
    assert.doesNotMatch(line, /Sept/);
  });

  it('names every month by its three-letter English abbreviation', () => {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];

    months.forEach((month, index) => {
      const iso = `2026-${String(index + 1).padStart(2, '0')}-15T12:00:00Z`;

      assert.equal(formatDetailTimestamp(iso, 'UTC'), `15 ${month} 2026, 12:00:00`);
    });
  });

  /** The list row and the panel write one instant, in one zone, differently. */
  it('writes the same instant the list row does', () => {
    const iso = '2026-09-17T23:30:00Z';

    assert.equal(formatTimestamp(iso, 'Europe/Moscow'), '2026-09-18 02:30:00');
    assert.equal(formatDetailTimestamp(iso, 'Europe/Moscow'), '18 Sep 2026, 02:30:00');
  });
});

describe('formatDocumentTitle', () => {
  it('prefixes the unread count, which appears nowhere else (D014)', () => {
    assert.equal(formatDocumentTitle(5), '(5) Webhook Inspector');
  });

  it('leaves the title alone when everything has been read', () => {
    assert.equal(formatDocumentTitle(0), 'Webhook Inspector');
    assert.equal(formatDocumentTitle(0), BASE_DOCUMENT_TITLE);
  });
});

describe('formatResponseStatus', () => {
  it('names the registered codes a session is likely to be configured with', () => {
    assert.equal(formatResponseStatus(200), '200 OK');
    assert.equal(formatResponseStatus(201), '201 Created');
    assert.equal(formatResponseStatus(204), '204 No Content');
    assert.equal(formatResponseStatus(301), '301 Moved Permanently');
    assert.equal(formatResponseStatus(404), '404 Not Found');
    assert.equal(formatResponseStatus(422), '422 Unprocessable Content');
    assert.equal(formatResponseStatus(500), '500 Internal Server Error');
    assert.equal(formatResponseStatus(503), '503 Service Unavailable');
  });

  it('shows an unregistered code in range as the bare number (D101)', () => {
    assert.equal(formatResponseStatus(299), '299');
    assert.equal(formatResponseStatus(512), '512');
    assert.equal(formatResponseStatus(240), '240');
    assert.equal(formatResponseStatus(599), '599');
  });
});

/**
 * Since D207 only a pending or failed write's prepared status is drawn red by
 * this rule, in the Response half's heading; an answer the session gave is the
 * pill of its class (`status-pill.test.ts`, `response-summary.test.ts`).
 */
describe('isFailureStatus', () => {
  it('reads 2xx and 3xx as not a failure and 4xx and 5xx as one', () => {
    assert.equal(isFailureStatus(200), false);
    assert.equal(isFailureStatus(299), false);
    assert.equal(isFailureStatus(304), false);
    assert.equal(isFailureStatus(399), false);
    assert.equal(isFailureStatus(400), true);
    assert.equal(isFailureStatus(500), true);
  });
});

describe('splitForMiddleEllipsis', () => {
  const url = 'https://qa-tools.ru/s/G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

  it('keeps the end of the receive URL whole, after the part that truncates (D157)', () => {
    const { head, tail } = splitForMiddleEllipsis(url, RECEIVE_URL_TAIL);

    assert.equal(tail, 'mQxA');
    assert.equal(head, 'https://qa-tools.ru/s/G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2');
  });

  it('loses nothing: the two halves are the text, so Copy and a selection get it all', () => {
    const { head, tail } = splitForMiddleEllipsis(url, RECEIVE_URL_TAIL);

    assert.equal(`${head}${tail}`, url);
  });

  it('makes a text no longer than the tail all tail, and never a negative cut', () => {
    assert.deepEqual(splitForMiddleEllipsis('abc', 4), { head: '', tail: 'abc' });
    assert.deepEqual(splitForMiddleEllipsis('', 4), { head: '', tail: '' });
    assert.deepEqual(splitForMiddleEllipsis('abc', -1), { head: 'abc', tail: '' });
  });

  it('never cuts a character outside the Basic Multilingual Plane in half', () => {
    assert.deepEqual(splitForMiddleEllipsis('ab😀c', 2), { head: 'ab', tail: '😀c' });
  });
});
