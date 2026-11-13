import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import type { SessionStatus } from '@webhook-inspector/shared';
import { readSessionStatuses } from '../api/client.ts';
import {
  DELETE_FAILED,
  DELETE_SESSION_TITLE,
  formatCount,
  formatDeleteDescription,
  formatDeletedToast,
  formatExpiredToast,
  formatListCount,
  formatRowMeta,
  formatRowTime,
  groupByDay,
  homeState,
  LOADING_SESSIONS,
  parseSessionStatuses,
  SESSION_DETAILS_FAILED,
  sessionRows,
  SESSIONS_SHOWN_FIRST,
  settleStatusRead,
  shortSessionId,
  splitReceiveUrl,
  splitStatuses,
  visibleRows,
  type ActiveSession,
  type StatusRead,
} from './home-view.ts';
import { loadSessionList, SESSION_LIST_KEY, type ListedSession } from './session-list.ts';

/**
 * What the home page shows (issue #92, D199): row F or row G3′ of the Figma
 * page `Webhook Inspector · My sessions`, the rows and their order, the days,
 * the cut after five and `Show all`, the loading and failure states, and every
 * string the list writes.
 */

const ID = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

/** A well-formed session id, different for every `n`. */
function id(n: number): string {
  return `S${String(n).padStart(6, '0')}${'k'.repeat(36)}`;
}

function listed(n: number, openedAt: number): ListedSession {
  return { id: id(n), openedAt };
}

function active(n: number, lastUsedAt: string, extra: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: id(n),
    state: 'active',
    receiveUrl: `https://hook.qa-tools.ru/s/${id(n)}`,
    requestsCount: 0,
    lastRequestAt: null,
    lastUsedAt,
    ...extra,
  };
}

function loaded(...sessions: ActiveSession[]): StatusRead {
  return { state: 'loaded', sessions: new Map(sessions.map((session) => [session.id, session])) };
}

describe('which page the home page is', () => {
  it('is the first visit while nothing is listed, whatever the read', () => {
    for (const read of [
      { state: 'loading' },
      { state: 'failed' },
      loaded(),
    ] satisfies StatusRead[]) {
      assert.equal(homeState([], read), 'first-visit');
    }
  });

  it('is the returning visitor’s at once while the read is pending, and when it failed', () => {
    assert.equal(homeState([listed(1, 1)], { state: 'loading' }), 'returning');
    assert.equal(homeState([listed(1, 1)], { state: 'failed' }), 'returning');
  });

  it('is the returning visitor’s once the read describes a listed session as active', () => {
    assert.equal(
      homeState([listed(1, 1), listed(2, 2)], loaded(active(2, '2026-10-03T10:00:00Z'))),
      'returning',
    );
  });

  it('is the first visit again once the read leaves no listed session active', () => {
    assert.equal(homeState([listed(1, 1)], loaded()), 'first-visit');
    assert.equal(
      homeState([listed(1, 1)], loaded(active(9, '2026-10-03T10:00:00Z'))),
      'first-visit',
    );
  });
});

describe('what the status read decides', () => {
  it('drops expired and not found sessions and keeps the active ones by id', () => {
    const statuses: SessionStatus[] = [
      { id: id(1), state: 'expired' },
      active(2, '2026-10-03T10:00:00Z'),
      { id: id(3), state: 'not_found' },
    ];
    const { gone, active: kept } = splitStatuses(statuses);

    assert.deepEqual(gone, [id(1), id(3)]);
    assert.deepEqual([...kept.keys()], [id(2)]);
  });
});

/** An array nested `depth` deep: `[[[…]]]`. Converting it to a string recurses once per level. */
function nested(depth: number): unknown[] {
  let value: unknown[] = [];

  for (let level = 0; level < depth; level++) {
    value = [value];
  }

  return value;
}

describe('the status read’s answer, checked against its contract', () => {
  const IDS = [id(1), id(2), id(3)];

  /** The documented answer for `IDS`: one entry per id, in order, each state once. */
  function answer(): { sessions: Record<string, unknown>[] } {
    return {
      sessions: [
        { ...active(1, '2026-10-03T10:00:00.000Z') },
        { id: id(2), state: 'expired' },
        { id: id(3), state: 'not_found' },
      ],
    };
  }

  /** `answer()` with its active entry's fields changed; `undefined` removes one. */
  function withActive(fields: Record<string, unknown>): unknown {
    const body = answer();
    const entry = { ...body.sessions[0], ...fields };

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) {
        delete entry[key];
      }
    }

    body.sessions[0] = entry;

    return body;
  }

  it('takes the documented answer, entry by entry, in the order the ids were sent', () => {
    assert.deepEqual(parseSessionStatuses(answer(), IDS), [
      active(1, '2026-10-03T10:00:00.000Z'),
      { id: id(2), state: 'expired' },
      { id: id(3), state: 'not_found' },
    ]);
    assert.deepEqual(
      parseSessionStatuses(
        withActive({ requestsCount: 14, lastRequestAt: '2026-10-03T11:40:00.000Z' }),
        IDS,
      )?.[0],
      active(1, '2026-10-03T10:00:00.000Z', {
        requestsCount: 14,
        lastRequestAt: '2026-10-03T11:40:00.000Z',
      }),
    );
  });

  it('keeps only the documented fields of an entry', () => {
    const body = answer();

    body.sessions[0] = { ...body.sessions[0], expiresAt: 'x', extra: [1] };
    body.sessions[1] = { ...body.sessions[1], receiveUrl: 'https://elsewhere/' };

    assert.deepEqual(parseSessionStatuses(body, IDS)?.slice(0, 2), [
      active(1, '2026-10-03T10:00:00.000Z'),
      { id: id(2), state: 'expired' },
    ]);
  });

  it('leaves a time string that reads as no time to the rows, which show it without one', () => {
    const statuses = parseSessionStatuses(
      withActive({ lastUsedAt: 'yesterday', lastRequestAt: '' }),
      IDS,
    );

    assert.equal(statuses?.[0]?.state, 'active');
  });

  it('refuses an answer that is not an object', () => {
    for (const value of [null, undefined, [], [answer()], 'sessions', 0, true]) {
      assert.equal(parseSessionStatuses(value, IDS), null, JSON.stringify(value));
    }
  });

  it('refuses sessions missing, null, not an array or holding null', () => {
    for (const sessions of [undefined, null, {}, { 0: answer().sessions[0] }, 'abc', 3]) {
      assert.equal(parseSessionStatuses({ sessions }, IDS), null, JSON.stringify(sessions));
    }

    assert.equal(parseSessionStatuses({}, IDS), null);
    assert.equal(parseSessionStatuses({ sessions: [null] }, [id(1)]), null);
    assert.equal(parseSessionStatuses({ sessions: [null, null, null] }, IDS), null);

    const body = answer();

    body.sessions[2] = null as unknown as Record<string, unknown>;
    assert.equal(parseSessionStatuses(body, IDS), null);
  });

  it('refuses a number of entries other than the ids sent', () => {
    const body = answer();

    assert.equal(parseSessionStatuses({ sessions: [] }, IDS), null);
    assert.equal(parseSessionStatuses({ sessions: body.sessions.slice(0, 2) }, IDS), null);
    assert.equal(
      parseSessionStatuses({ sessions: [...body.sessions, body.sessions[2]] }, IDS),
      null,
    );
    assert.equal(parseSessionStatuses(body, IDS.slice(0, 2)), null);
  });

  it('refuses an entry that is not an object, or names another id or the ids in another order', () => {
    for (const entry of [[], 'x', 1, true, [answer().sessions[1]]]) {
      const body = answer();

      body.sessions[1] = entry as unknown as Record<string, unknown>;
      assert.equal(parseSessionStatuses(body, IDS), null, JSON.stringify(entry));
    }

    for (const entryId of [undefined, null, 7, [id(2)], id(9), id(2).toLowerCase(), '']) {
      const body = answer();

      body.sessions[1] = { ...body.sessions[1], id: entryId };
      assert.equal(parseSessionStatuses(body, IDS), null, String(entryId));
    }

    const swapped = answer();

    swapped.sessions.reverse();
    assert.equal(parseSessionStatuses(swapped, IDS), null);
  });

  it('refuses an unknown state, so a fourth state drops no entry from the list', () => {
    for (const state of ['deleted', 'Active', 'EXPIRED', '', null, undefined, 1, ['active']]) {
      const body = answer();

      body.sessions[1] = { id: id(2), state };
      assert.equal(parseSessionStatuses(body, IDS), null, String(state));
    }
  });

  it('refuses an active entry with any field of another type, or missing', () => {
    const wrong: Record<string, unknown[]> = {
      receiveUrl: [undefined, null, 1, [], {}, true],
      requestsCount: [undefined, null, -1, 1.5, '3', 1e20, Number.NaN, Infinity, [], true],
      lastRequestAt: [undefined, 0, 1_700_000_000_000, [], {}, false],
      lastUsedAt: [undefined, null, 0, 1_700_000_000_000, [], {}, true],
    };

    for (const [field, values] of Object.entries(wrong)) {
      for (const value of values) {
        assert.equal(
          parseSessionStatuses(withActive({ [field]: value }), IDS),
          null,
          `${field}: ${String(value)}`,
        );
      }
    }
  });

  it('refuses a key spelled __proto__ in place of sessions', () => {
    assert.equal(parseSessionStatuses(JSON.parse('{"__proto__":{"sessions":[]}}'), []), null);
    assert.deepEqual(parseSessionStatuses({ sessions: [] }, []), []);
  });

  describe('hostile answers at growing sizes', () => {
    /** Generous; a regression to quadratic time is seconds. */
    const LIMIT_MS = 1500;

    function timed(value: unknown, ids: readonly string[] = IDS): SessionStatus[] | null {
      const started = performance.now();
      const statuses = parseSessionStatuses(value, ids);
      const elapsed = performance.now() - started;

      assert.ok(elapsed < LIMIT_MS, `${elapsed.toFixed(1)} ms`);

      return statuses;
    }

    for (const depth of [10_000, 100_000, 1_000_000]) {
      it(`refuses an array nested ${depth} deep in a time field, which Date.parse overflows on`, () => {
        const deep = nested(depth);

        // The value really is hostile: turning it into a string, as
        // `Date.parse` does, overflows the stack.
        assert.throws(() => Date.parse(deep as unknown as string), RangeError);

        assert.equal(timed(withActive({ lastUsedAt: deep })), null);
        assert.equal(timed(withActive({ lastRequestAt: deep })), null);
        assert.equal(timed(withActive({ receiveUrl: deep })), null);
        assert.equal(timed(withActive({ requestsCount: deep })), null);
        assert.equal(timed({ sessions: deep }), null);
        assert.equal(timed(deep), null);
      });
    }

    // 65,536 already shows quadratic growth; a larger step only adds cost.
    for (const count of [1024, 65_536]) {
      it(`refuses ${count} entries for three ids, and reads ${count} entries for as many ids in linear time`, () => {
        const body = answer();

        assert.equal(
          timed({ sessions: Array.from({ length: count }, () => body.sessions[1]) }),
          null,
        );

        // More than the route ever answers: only the cost of reading them is checked.
        const ids = Array.from({ length: count }, (_, n) => id(n % 999_999));
        const sessions = ids.map((entryId) => ({ id: entryId, state: 'expired' }));

        assert.equal(timed({ sessions }, ids)?.length, count);

        // The last entry wrong fails the whole answer.
        sessions[count - 1] = { id: ids[count - 1] as string, state: 'archived' };
        assert.equal(timed({ sessions }, ids), null);
      });
    }

    for (const size of [1024, 64 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
      it(`takes strings of ${size} characters, and the rows write them without a time or a throw`, () => {
        for (const filler of ['9', 'a', ' ', '[', '2026-10-03T']) {
          const long = filler.repeat(Math.ceil(size / filler.length));
          const statuses = timed(
            withActive({ receiveUrl: long, lastUsedAt: long, lastRequestAt: long }),
          );
          const details = statuses?.[0];

          assert.equal(details?.state, 'active', filler);

          if (details?.state !== 'active') {
            continue;
          }

          const started = performance.now();
          const rows = sessionRows(
            [listed(1, Date.parse('2026-10-02T09:00:00Z'))],
            loaded(details),
          );

          assert.deepEqual(
            groupByDay(rows, 'UTC').map((group) => group.label),
            ['2 Oct 2026'],
          );
          assert.equal(formatRowMeta(details, 'UTC').last, 'last request');
          assert.equal(splitReceiveUrl(details.receiveUrl, details.id).id, '');
          assert.ok(performance.now() - started < LIMIT_MS, filler);
        }
      });
    }
  });
});

describe('settling the status read', () => {
  const IDS = [id(1), id(2)];

  /** Fails the test rather than waiting for ever on a promise that never settles. */
  async function settled<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('still pending after 2 s')), 2000);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  it('is loaded with the active sessions and the ids that are gone', async () => {
    const outcome = await settled(
      settleStatusRead(IDS, async (ids) => {
        assert.deepEqual(ids, IDS);

        return [active(1, '2026-10-03T10:00:00Z'), { id: id(2), state: 'not_found' }];
      }),
    );

    assert.equal(outcome.read.state, 'loaded');
    assert.deepEqual(outcome.read.state === 'loaded' ? [...outcome.read.sessions.keys()] : null, [
      id(1),
    ]);
    assert.deepEqual(outcome.gone, [id(2)]);
  });

  it('is failed, with nothing gone, when the read rejects or throws', async () => {
    const failing: ((ids: string[]) => Promise<SessionStatus[]>)[] = [
      () => Promise.reject(new Error('offline')),
      () => {
        throw new TypeError('thrown before a promise exists');
      },
      async () => {
        throw new RangeError('Maximum call stack size exceeded');
      },
      // A reader that resolves with no array: splitting it throws.
      async () => null as unknown as SessionStatus[],
    ];

    for (const read of failing) {
      assert.deepEqual(await settled(settleStatusRead(IDS, read)), {
        read: { state: 'failed' },
        gone: [],
      });
    }
  });

  /**
   * Through the client as the page calls it, `fetch` answering with each body
   * the contract does not allow: every one ends as `failed`, with nothing
   * taken off the list, rather than leaving `Loading sessions…` on screen.
   */
  describe('through readSessionStatuses, with fetch answering', () => {
    const realFetch = globalThis.fetch;

    function answering(status: number, body: string | null, contentType = 'application/json') {
      globalThis.fetch = (async () =>
        new Response(body, { status, headers: { 'Content-Type': contentType } })) as typeof fetch;
    }

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    const activeEntry = (n: number, fields: Record<string, unknown> = {}) => ({
      ...active(n, '2026-10-03T10:00:00.000Z'),
      ...fields,
    });
    const deep = `${'['.repeat(10_000)}${']'.repeat(10_000)}`;
    const MALFORMED: [string, string | null][] = [
      ['a body of []', '[]'],
      ['a body of null', 'null'],
      ['sessions null', '{"sessions":null}'],
      ['sessions [null]', '{"sessions":[null]}'],
      ['sessions of another length', JSON.stringify({ sessions: [activeEntry(1)] })],
      ['no body', null],
      ['a body that is not JSON', '{"sessions":['],
      [
        'receiveUrl a number',
        JSON.stringify({ sessions: [activeEntry(1, { receiveUrl: 1 }), activeEntry(2)] }),
      ],
      [
        'receiveUrl null',
        JSON.stringify({ sessions: [activeEntry(1), activeEntry(2, { receiveUrl: null })] }),
      ],
      [
        'an unknown state',
        JSON.stringify({ sessions: [activeEntry(1), { id: id(2), state: 'archived' }] }),
      ],
      [
        'lastUsedAt nested 10,000 deep',
        `{"sessions":[${JSON.stringify(activeEntry(1)).replace('"2026-10-03T10:00:00.000Z"', deep)},${JSON.stringify(activeEntry(2))}]}`,
      ],
      [
        'lastRequestAt nested 10,000 deep',
        `{"sessions":[${JSON.stringify(activeEntry(1)).replace('null', deep)},${JSON.stringify(activeEntry(2))}]}`,
      ],
    ];

    for (const [name, body] of MALFORMED) {
      it(`${name}: failed, with nothing gone`, async () => {
        answering(200, body);
        assert.deepEqual(await settled(settleStatusRead(IDS, readSessionStatuses)), {
          read: { state: 'failed' },
          gone: [],
        });
      });
    }

    it('a 204 with no body, and a refusal: failed, with nothing gone', async () => {
      answering(204, null);
      assert.deepEqual(await settled(settleStatusRead(IDS, readSessionStatuses)), {
        read: { state: 'failed' },
        gone: [],
      });

      answering(404, '{"errorCode":1000,"message":"Route not found"}');
      assert.deepEqual(await settled(settleStatusRead(IDS, readSessionStatuses)), {
        read: { state: 'failed' },
        gone: [],
      });
    });

    it('the documented answer: loaded, with the gone ids', async () => {
      answering(
        200,
        JSON.stringify({ sessions: [activeEntry(1), { id: id(2), state: 'expired' }] }),
      );

      const outcome = await settled(settleStatusRead(IDS, readSessionStatuses));

      assert.deepEqual(outcome.gone, [id(2)]);
      assert.deepEqual(
        outcome.read.state === 'loaded' ? [...outcome.read.sessions.values()] : null,
        [active(1, '2026-10-03T10:00:00.000Z')],
      );
    });
  });
});

describe('the rows', () => {
  const list = [listed(1, 300), listed(2, 200), listed(3, 100)];

  it('are none while the read is pending: the page says Loading sessions…', () => {
    assert.deepEqual(sessionRows(list, { state: 'loading' }), []);
    assert.equal(LOADING_SESSIONS, 'Loading sessions…');
  });

  it('are the described sessions, the most recently used first, by lastUsedAt', () => {
    const rows = sessionRows(
      list,
      loaded(
        active(1, '2026-10-01T09:00:00Z'),
        active(2, '2026-10-03T09:00:00Z'),
        active(3, '2026-10-02T09:00:00Z'),
      ),
    );

    assert.deepEqual(
      rows.map((row) => row.id),
      [id(2), id(3), id(1)],
    );
    assert.equal(rows[0]?.at, Date.parse('2026-10-03T09:00:00Z'));
    assert.equal(rows[0]?.details?.receiveUrl, `https://hook.qa-tools.ru/s/${id(2)}`);
  });

  it('leave out a listed session the read did not describe', () => {
    const rows = sessionRows(list, loaded(active(2, '2026-10-03T09:00:00Z')));

    assert.deepEqual(
      rows.map((row) => row.id),
      [id(2)],
    );
  });

  it('keep the list’s order, the most recently opened first, for the same last use', () => {
    const at = '2026-10-03T09:00:00Z';
    const rows = sessionRows(list, loaded(active(3, at), active(1, at), active(2, at)));

    assert.deepEqual(
      rows.map((row) => row.id),
      [id(1), id(2), id(3)],
    );
  });

  it('when the read failed, are every listed session, by the day last opened here, without details', () => {
    const rows = sessionRows([listed(1, 100), listed(2, 300), listed(3, 200)], { state: 'failed' });

    assert.deepEqual(
      rows.map((row) => [row.id, row.at, row.details]),
      [
        [id(2), 300, null],
        [id(3), 200, null],
        [id(1), 100, null],
      ],
    );
    assert.equal(SESSION_DETAILS_FAILED, 'Session details could not be loaded.');
  });
});

describe('values no Date can hold, from storage or from the status read', () => {
  /** Out of the Date range, or not an integer: each would make an Invalid Date. */
  const UNREADABLE = [1e20, -1e20, 8.64e15 + 1, -8.64e15 - 1, 1.5];

  it('the failed read’s fallback draws a stored list holding them, without throwing', () => {
    const raw = JSON.stringify({
      v: 1,
      items: [
        ...UNREADABLE.map((openedAt, n) => ({ id: id(n + 10), openedAt })),
        { id: id(1), openedAt: Date.parse('2026-10-03T09:00:00Z') },
      ],
    });
    const list = loadSessionList({
      getItem: (key) => (key === SESSION_LIST_KEY ? raw : null),
      setItem: () => undefined,
    });
    const read: StatusRead = { state: 'failed' };

    // What LandingPage and SessionDays do with them, in that order.
    assert.equal(homeState(list, read), 'returning');

    const rows = sessionRows(list, read);
    const groups = groupByDay(visibleRows(rows, false), 'UTC');

    assert.deepEqual(
      groups.map((group) => [group.label, group.count, group.rows.map((row) => row.id)]),
      [['3 Oct 2026', '1 session', [id(1)]]],
    );
  });

  it('a row handed one anyway goes under a heading with no date, without throwing', () => {
    // A fraction is left out: `new Date(1.5)` is the instant 1 ms, which formats.
    for (const openedAt of [
      1e20,
      -1e20,
      8.64e15 + 1,
      -8.64e15 - 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const rows = sessionRows([listed(1, openedAt)], { state: 'failed' });

      assert.deepEqual(
        groupByDay(rows, 'UTC').map((group) => [group.key, group.label, group.count]),
        [['', '', '1 session']],
        String(openedAt),
      );
    }

    // Rows on either side keep their own days.
    assert.deepEqual(
      groupByDay(
        [{ at: Date.parse('2026-10-03T09:00:00Z') }, { at: 1e20 }, { at: 1e20 }, { at: 0 }],
        'UTC',
      ).map((group) => [group.label, group.count]),
      [
        ['3 Oct 2026', '1 session'],
        ['', '2 sessions'],
        ['1 Jan 1970', '1 session'],
      ],
    );
  });

  it('a lastUsedAt that is no time sorts and groups the row by its last opening here', () => {
    const openedAt = Date.parse('2026-10-02T09:00:00Z');

    for (const lastUsedAt of [
      '',
      'yesterday',
      '+275760-09-13T00:00:00.001Z',
      '2026-13-45T99:00:00Z',
    ]) {
      const rows = sessionRows([listed(1, openedAt)], loaded(active(1, lastUsedAt)));

      assert.equal(rows[0]?.at, openedAt, lastUsedAt);
      assert.deepEqual(
        groupByDay(rows, 'UTC').map((group) => group.label),
        ['2 Oct 2026'],
      );
    }
  });

  it('a lastRequestAt that is no time leaves last request without one, without throwing', () => {
    for (const lastRequestAt of [
      '',
      'yesterday',
      '+275760-09-13T00:00:00.001Z',
      '2026-13-45T99:00:00Z',
    ]) {
      assert.equal(formatRowTime(lastRequestAt, 'UTC'), null, lastRequestAt);
      assert.deepEqual(formatRowMeta({ requestsCount: 3, lastRequestAt }, 'UTC'), {
        count: '3 requests',
        last: 'last request',
      });
    }

    // The latest instant a Date holds is still written.
    assert.equal(formatRowTime('+275760-09-13T00:00:00.000Z', 'UTC'), '275760-09-13 00:00');
  });
});

describe('the cut after five and Show all', () => {
  const rows = Array.from({ length: 12 }, (_, n) => n);

  it('shows the first five, then every row once Show all was chosen', () => {
    assert.equal(SESSIONS_SHOWN_FIRST, 5);
    assert.deepEqual(visibleRows(rows, false), [0, 1, 2, 3, 4]);
    assert.deepEqual(visibleRows(rows, true), rows);
    assert.deepEqual(visibleRows([0, 1, 2], false), [0, 1, 2]);
  });

  it('says how many of how many, with Show all only while some are hidden', () => {
    assert.deepEqual(formatListCount(5, 12), {
      text: '5 of 12 sessions in this browser',
      showAll: true,
    });
    assert.deepEqual(formatListCount(12, 12), {
      text: '12 sessions in this browser',
      showAll: false,
    });
    assert.deepEqual(formatListCount(5, 5), { text: '5 sessions in this browser', showAll: false });
    assert.deepEqual(formatListCount(3, 3), { text: '3 sessions in this browser', showAll: false });
    assert.deepEqual(formatListCount(1, 1), { text: '1 session in this browser', showAll: false });
  });
});

describe('the days', () => {
  const row = (iso: string) => ({ at: Date.parse(iso) });

  it('group consecutive rows of one local day under its date and count, newest first', () => {
    const groups = groupByDay(
      [
        row('2026-10-03T11:40:00Z'),
        row('2026-10-03T09:20:00Z'),
        row('2026-10-03T08:02:00Z'),
        row('2026-10-02T18:30:00Z'),
        row('2026-09-30T10:23:00Z'),
      ],
      'UTC',
    );

    assert.deepEqual(
      groups.map((group) => [group.key, group.label, group.count, group.rows.length]),
      [
        ['2026-10-03', '3 Oct 2026', '3 sessions', 3],
        ['2026-10-02', '2 Oct 2026', '1 session', 1],
        ['2026-09-30', '30 Sep 2026', '1 session', 1],
      ],
    );
  });

  it('are the viewer’s own days: midnight is local, not UTC', () => {
    const instants = [row('2026-10-02T22:30:00Z'), row('2026-10-02T20:30:00Z')];

    // 01:30 and 23:30 in Moscow, on two days; one day in UTC.
    assert.deepEqual(
      groupByDay(instants, 'Europe/Moscow').map((group) => group.label),
      ['3 Oct 2026', '2 Oct 2026'],
    );
    assert.deepEqual(
      groupByDay(instants, 'UTC').map((group) => group.label),
      ['2 Oct 2026'],
    );
  });

  it('write the day without a leading zero and the month in three letters', () => {
    const labels = groupByDay(
      [row('2026-01-05T12:00:00Z'), row('2025-12-31T12:00:00Z')],
      'UTC',
    ).map((group) => group.label);

    assert.deepEqual(labels, ['5 Jan 2026', '31 Dec 2025']);
  });

  it('are none for no rows', () => {
    assert.deepEqual(groupByDay([], 'UTC'), []);
  });
});

describe('a row', () => {
  it('writes the count and the last request, in the viewer’s timezone, to the minute', () => {
    assert.deepEqual(
      formatRowMeta(
        { requestsCount: 14, lastRequestAt: '2026-10-03T08:40:59.999Z' },
        'Europe/Moscow',
      ),
      { count: '14 requests', last: 'last request 2026-10-03 11:40' },
    );
    assert.deepEqual(
      formatRowMeta({ requestsCount: 1, lastRequestAt: '2026-09-30T10:23:00Z' }, 'UTC'),
      {
        count: '1 request',
        last: 'last request 2026-09-30 10:23',
      },
    );
  });

  it('says no requests yet for a session with none', () => {
    assert.deepEqual(formatRowMeta({ requestsCount: 0, lastRequestAt: null }), {
      count: '0 requests',
      last: 'no requests yet',
    });
  });

  it('writes midnight as 00, never 24', () => {
    assert.equal(formatRowTime('2026-10-03T00:05:00Z', 'UTC'), '2026-10-03 00:05');
  });

  it('shows the whole receive URL, the prefix muted and the id bold', () => {
    assert.deepEqual(splitReceiveUrl(`https://hook.qa-tools.ru/s/${ID}`, ID), {
      prefix: 'https://hook.qa-tools.ru/s/',
      id: ID,
    });
    assert.deepEqual(splitReceiveUrl(`http://127.0.0.1:3001/s/${ID}`, ID), {
      prefix: 'http://127.0.0.1:3001/s/',
      id: ID,
    });
  });

  it('shows a URL that does not end with the id whole, as its prefix', () => {
    assert.deepEqual(splitReceiveUrl('https://hook.qa-tools.ru/s/other', ID), {
      prefix: 'https://hook.qa-tools.ru/s/other',
      id: '',
    });
    assert.deepEqual(splitReceiveUrl('https://x/', ''), { prefix: 'https://x/', id: '' });
  });

  it('counts in the singular for one', () => {
    assert.equal(formatCount(0, 'request'), '0 requests');
    assert.equal(formatCount(1, 'request'), '1 request');
    assert.equal(formatCount(2, 'session'), '2 sessions');
  });
});

describe('deleting a session', () => {
  it('names the session by its first 7 characters', () => {
    assert.equal(shortSessionId(ID), 'G4t2kM8');
  });

  it('asks as drawn, with the count the status read gave', () => {
    assert.equal(DELETE_SESSION_TITLE, 'Delete this session?');
    assert.equal(
      formatDeleteDescription(ID, 14),
      'This will permanently delete the session G4t2kM8 with its 14 requests and response settings. Its receive URL will answer 404 to every sender. This action cannot be undone.',
    );
    assert.match(formatDeleteDescription(ID, 1), /with its 1 request and response settings\./);
    assert.match(formatDeleteDescription(ID, 0), /with its response settings\./);
  });

  it('names no count when the status read failed', () => {
    assert.match(
      formatDeleteDescription(ID, null),
      /session G4t2kM8 with its requests and response settings\./,
    );
  });

  it('says a failure in the dialog, and a deletion in the toast', () => {
    assert.equal(DELETE_FAILED, 'The session could not be deleted. Try again.');
    assert.equal(formatDeletedToast(ID), 'Session G4t2kM8 deleted');
    assert.equal(formatExpiredToast(ID), 'Session G4t2kM8 had already expired');
  });
});

/**
 * Structural guards over the source text of `LandingPage.tsx` and
 * `SessionList.tsx`, not tests of behaviour: they fail on a harmless rename,
 * and they are kept only where no browser test has a counterpart - that the
 * page takes its decisions and its words from this module, whose tests above
 * are the behaviour's, and that the row's controls carry no z-index. E2E-13
 * walks the status read and the ids in its body, the joining, the loading
 * state before any first visit, sessions reported gone leaving storage, and a
 * row's link with the copy icon and `⋯` opening nothing, so none of that is
 * asserted here. No browser test sees which keys a reported session is judged
 * by, or whether a created private session's key is stored before the list
 * records it, so those two call sites are pinned here (#264).
 */
describe('the page draws what this module decides (structural guards)', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const landing = read('../pages/LandingPage.tsx');
  const list = read('../components/SessionList.tsx');

  it('chooses its state, its rows and its cut here, and writes none of the list’s words itself', () => {
    for (const use of [
      'settleStatusRead(readIds, (ids) => api.readSessionStatuses(ids, sentKeys))',
      'homeState(list, read)',
      'sessionRows(list, read)',
      'visibleRows(rows, showAll)',
      // The words are the dictionary's in the language shown (D222).
      '{m.home.loading}',
      '{m.home.detailsFailed}',
      'formatListCount(shown, total, m)',
    ]) {
      assert.ok(landing.includes(use), `LandingPage.tsx does not use ${use}`);
    }

    for (const words of [
      'Loading sessions',
      'could not be loaded',
      'in this browser',
      ' deleted',
    ]) {
      assert.ok(!landing.includes(`'${words}`) && !landing.includes(`>${words}`), words);
    }

    assert.ok(list.includes('groupByDay(rows, undefined, m)'));
    assert.ok(list.includes('formatRowMeta(details, undefined, m)'));
    assert.ok(list.includes('splitReceiveUrl(details.receiveUrl, row.id)'));
  });

  it('takes the sessions a status read reports gone off by the keys the read was sent with', () => {
    // Judged against the keys sent (D259): `removeListedSessions` would also
    // take off a session whose right key another tab stored meanwhile.
    assert.equal(
      landing.split('removeReportedSessions(storage, outcome.gone, sentKeys)').length - 1,
      1,
      'LandingPage.tsx does not take reported sessions off with removeReportedSessions(storage, outcome.gone, sentKeys)',
    );
    assert.equal(
      landing.match(/\boutcome\.gone\b(?!\.length)/g)?.length,
      1,
      'LandingPage.tsx uses the reported sessions elsewhere',
    );
    // `Remove from list`, of the one session asked about, is its only other removal.
    assert.deepEqual(landing.match(/\bremoveListedSessions\([^)]*\)/g), [
      'removeListedSessions(storage, [id])',
    ]);
  });

  it('keeps a created private session’s key before generate() lists the session', () => {
    // So a full list pushes out a public session first (D259).
    const start = landing.indexOf('async function generate(): Promise<void> {');
    const end = landing.indexOf('\n  }\n', start);
    const generate = landing.slice(start, end);
    const kept = generate.indexOf('keepAccessKey(storage, session.id, session.accessKey);');
    const recorded = generate.indexOf('recordSessionOpened(storage, session.id, Date.now());');

    assert.ok(start > 0 && end > start, 'LandingPage.tsx has no generate()');
    assert.ok(kept > 0, 'generate() does not keep the created session’s key');
    assert.ok(recorded > kept, 'generate() lists the session before it keeps its key');
    assert.equal(landing.match(/\brecordSessionOpened\(/g)?.length, 1);
  });

  it('gives the row’s copy icon and ⋯ no z-index, which would lift them over a dialog’s overlay', () => {
    // They paint above the link's stretched area by coming after it; the
    // dialog's overlay has no z-index of its own.
    assert.doesNotMatch(list, /z-10/);
  });
});
