/**
 * The Request half's header: its target (D173) and its facts line (D141).
 *
 * The address used to have a line of its own, `<ip> · Unknown country`. It is
 * now one segment of the facts line, between the size and the time. The target
 * is split into the session part, the path and the query the header draws as
 * one run of text. These are the cases the approved frames draw.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ru } from '../i18n/ru.ts';
import {
  formatRequestFacts,
  splitRequestTarget,
  type RequestFacts,
  type RequestTarget,
} from './request-summary.ts';

const IPV6 = '2001:db8:85a3:0000:0000:8a2e:0370:7334';

function facts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return {
    httpVersion: '1.1',
    bodySize: 61,
    sourceIp: '145.40.74.12',
    receivedAt: '2026-09-17T14:32:06.000Z',
    ...overrides,
  };
}

describe('formatRequestFacts', () => {
  it('puts the address between the size and the time', () => {
    assert.equal(
      formatRequestFacts(facts(), 'UTC'),
      'HTTP/1.1 · 61 B · 145.40.74.12 · 17 Sep 2026, 14:32:06',
    );
  });

  /** The list row shortens this address; the detail panel never does. */
  it('writes a full IPv6 address unshortened', () => {
    const line = formatRequestFacts(facts({ sourceIp: IPV6, bodySize: 0 }), 'UTC');

    assert.equal(line, `HTTP/1.1 · 0 B · ${IPV6} · 17 Sep 2026, 14:32:06`);
    assert.ok(!line.includes('…'));
  });

  it('reads IP unavailable in the same position where there is no address', () => {
    assert.equal(
      formatRequestFacts(facts({ sourceIp: null, bodySize: 64 }), 'UTC'),
      'HTTP/1.1 · 64 B · IP unavailable · 17 Sep 2026, 14:32:06',
    );
  });

  /** A session created to keep no address (D243, D249). */
  it('reads IP not stored in that position for a session that keeps no address', () => {
    assert.equal(
      formatRequestFacts(facts({ sourceIp: null, bodySize: 159 }), 'UTC', undefined, true),
      'HTTP/1.1 · 159 B · IP not stored · 17 Sep 2026, 14:32:06',
    );
    assert.equal(
      formatRequestFacts(facts({ sourceIp: null, bodySize: 159 }), 'UTC', ru, true),
      'HTTP/1.1 · 159 B · IP не сохраняется · 17 сент. 2026, 14:32:06',
    );
    // A default session keeps today's words, and an address is always shown.
    assert.equal(
      formatRequestFacts(facts({ sourceIp: null }), 'UTC', ru, false),
      'HTTP/1.1 · 61 B · IP недоступен · 17 сент. 2026, 14:32:06',
    );
    assert.equal(
      formatRequestFacts(facts(), 'UTC', undefined, true),
      'HTTP/1.1 · 61 B · 145.40.74.12 · 17 Sep 2026, 14:32:06',
    );
  });

  /** A request captured before the column existed has no version (D110). */
  it('drops only the HTTP version segment where there is none', () => {
    assert.equal(
      formatRequestFacts(facts({ httpVersion: null }), 'UTC'),
      '61 B · 145.40.74.12 · 17 Sep 2026, 14:32:06',
    );
    assert.equal(
      formatRequestFacts(facts({ httpVersion: null, sourceIp: null }), 'UTC'),
      '61 B · IP unavailable · 17 Sep 2026, 14:32:06',
    );
  });

  /** Country resolution was removed (D140): nothing on this line names one. */
  it('says nothing about a country', () => {
    for (const sourceIp of ['145.40.74.12', IPV6, null]) {
      assert.doesNotMatch(formatRequestFacts(facts({ sourceIp }), 'UTC'), /country/i);
    }
  });

  /**
   * The detail panel's format, not the list row's `2026-09-18 02:30:00`, and in
   * the viewer's zone, which here moves the date (D042, D148).
   */
  it("writes the time as the detail panel does, in the viewer's zone", () => {
    const line = formatRequestFacts(
      facts({ receivedAt: '2026-09-17T23:30:00.000Z' }),
      'Europe/Moscow',
    );

    assert.equal(line, 'HTTP/1.1 · 61 B · 145.40.74.12 · 18 Sep 2026, 02:30:00');
    assert.doesNotMatch(line, /\d{4}-\d{2}-\d{2}/);
  });
});

/** A session id of the new shape, as the frames draw it. */
const ID = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

function target(path: string | null, queryString = ''): RequestTarget | null {
  return splitRequestTarget({ path, queryString });
}

/** The three parts, joined as the header draws them: no gap, nothing dropped. */
function joined(parts: RequestTarget | null): string | null {
  return parts === null ? null : `${parts.session}${parts.path}${parts.query}`;
}

describe('splitRequestTarget (D173)', () => {
  it('is the session part alone for the endpoint itself, with or without a query', () => {
    assert.deepEqual(target(`/s/${ID}`), { session: `/s/${ID}`, path: '', query: '' });
    assert.deepEqual(target(`/s/${ID}`, 'source=demo&runId=1842'), {
      session: `/s/${ID}`,
      path: '',
      query: '?source=demo&runId=1842',
    });
  });

  it('keeps a trailing slash in the session part: a lone / is not a path', () => {
    assert.deepEqual(target(`/s/${ID}/`), { session: `/s/${ID}/`, path: '', query: '' });
    assert.deepEqual(target(`/s/${ID}/`, 'a=1'), {
      session: `/s/${ID}/`,
      path: '',
      query: '?a=1',
    });
  });

  it('splits a path under the endpoint from the session part, at its slash', () => {
    assert.deepEqual(target(`/s/${ID}/stripe/events`, 'livemode=false'), {
      session: `/s/${ID}`,
      path: '/stripe/events',
      query: '?livemode=false',
    });
    // A one-character path is a path, and a WebDAV folder keeps its slash.
    assert.deepEqual(target(`/s/${ID}/h`), { session: `/s/${ID}`, path: '/h', query: '' });
    assert.deepEqual(target(`/s/${ID}/folder/`), {
      session: `/s/${ID}`,
      path: '/folder/',
      query: '',
    });
    // Two slashes are not one: the second begins a path.
    assert.deepEqual(target(`/s/${ID}//`), { session: `/s/${ID}`, path: '//', query: '' });
  });

  it('shows the path as stored: percent-encoding and dot segments intact', () => {
    const path = '/%D0%BF%D0%BB%D0%B0%D1%82%D0%B5%D0%B6/new/%2f/../x';

    assert.deepEqual(target(`/s/${ID}${path}`, 'q=%41'), {
      session: `/s/${ID}`,
      path,
      query: '?q=%41',
    });
  });

  it('cuts after the segment after /s/, whatever it holds', () => {
    // An id of the older shape, and ids that are no id at all: the receiver
    // never stores those, and the split does not judge them.
    assert.deepEqual(target('/s/abc_-123/x'), { session: '/s/abc_-123', path: '/x', query: '' });
    assert.deepEqual(target('/s//x'), { session: '/s/', path: '/x', query: '' });
    // An absolute-form request line, stored as it arrived.
    assert.deepEqual(target(`http://qa-tools.ru/s/${ID}/x`), {
      session: `http://qa-tools.ru/s/${ID}/x`,
      path: '',
      query: '',
    });
    assert.deepEqual(target('/elsewhere/x', 'a=1'), {
      session: '/elsewhere/x',
      path: '',
      query: '?a=1',
    });
  });

  /** Stored before the column existed: the header shows the method alone (D110). */
  it('is null where no path was stored', () => {
    assert.equal(target(null), null);
    assert.equal(target(null, 'a=1'), null);
  });

  it('joins back to exactly the stored path and query string', () => {
    for (const [path, query] of [
      [`/s/${ID}`, ''],
      [`/s/${ID}/`, 'x=1'],
      [`/s/${ID}/api/v2/integrations/stripe/webhooks/events/charge.succeeded`, 'livemode=false'],
      [`/s/${ID}//a//b/`, ''],
      ['/s/', ''],
    ] as const) {
      assert.equal(joined(target(path, query)), `${path}${query === '' ? '' : `?${query}`}`);
    }
  });
});
