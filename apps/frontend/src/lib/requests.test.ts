import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_REQUESTS_PER_SESSION,
  type RequestDetails,
  type RequestListItem,
  type ResponseState,
  type ResponseSummary,
} from '@webhook-inspector/shared';
import {
  applyRequestDeleted,
  applyResponseRecorded,
  canApplyRefreshedDetails,
  countUnread,
  createListLoads,
  deletionClosesDetails,
  detailToShow,
  type ListLoad,
  loadRefreshedDetails,
  mergeRequests,
  reloadClosesDetails,
  replaceWithReloaded,
  shouldRefreshDetails,
  shouldRefreshDetailsOnReady,
  withListPath,
  withSourceIp,
} from './requests.ts';
import { formatListAddress, isAddressShortened } from './address.ts';
import { matchesRequest, queryWords, rowHighlights } from './request-filter.ts';
import { routeServerMessage } from '../api/realtime.ts';

function item(id: string, receivedAt: string): RequestListItem {
  return {
    id,
    method: 'POST',
    receivedAt,
    bodySize: 0,
    sourceIp: null,
    path: null,
    response: null,
  };
}

const pending: ResponseSummary = { state: 'pending', status: 200, queueStep: null, rule: null };

describe('mergeRequests', () => {
  it('puts a newly received request at the top', () => {
    const existing = [item('a', '2026-08-24T10:00:00.000Z')];

    const merged = mergeRequests(existing, [item('b', '2026-08-24T10:00:01.000Z')]);

    assert.deepEqual(
      merged.map((entry) => entry.id),
      ['b', 'a'],
    );
  });

  it('orders a reconnection’s catch-up by time, not by arrival', () => {
    const existing = [item('c', '2026-08-24T10:00:02.000Z')];

    const merged = mergeRequests(existing, [
      item('a', '2026-08-24T10:00:00.000Z'),
      item('b', '2026-08-24T10:00:01.000Z'),
    ]);

    assert.deepEqual(
      merged.map((entry) => entry.id),
      ['c', 'b', 'a'],
    );
  });

  /** The event and the reload after a reconnect can describe the same request. */
  it('keeps one row when both sources carry the same request', () => {
    const shared = item('a', '2026-08-24T10:00:00.000Z');

    const merged = mergeRequests([shared], [shared]);

    assert.equal(merged.length, 1);
  });

  it('breaks a tie on the id, as the list API does', () => {
    const merged = mergeRequests(
      [item('a', '2026-08-24T10:00:00.000Z')],
      [item('b', '2026-08-24T10:00:00.000Z')],
    );

    assert.deepEqual(
      merged.map((entry) => entry.id),
      ['b', 'a'],
    );
  });

  it('never grows past the retention limit the backend enforces', () => {
    const existing = Array.from({ length: MAX_REQUESTS_PER_SESSION }, (_unused, index) =>
      item(`old-${index}`, new Date(Date.UTC(2026, 7, 24, 10, 0, index)).toISOString()),
    );

    const merged = mergeRequests(existing, [item('new', '2026-08-24T23:00:00.000Z')]);

    assert.equal(merged.length, MAX_REQUESTS_PER_SESSION);
    assert.equal(merged[0]?.id, 'new');
    // The oldest row is the one that dropped out.
    assert.ok(!merged.some((entry) => entry.id === 'old-0'));
  });

  it('leaves the list untouched when there is nothing new', () => {
    const existing = [item('a', '2026-08-24T10:00:00.000Z')];

    assert.deepEqual(mergeRequests(existing, []), existing);
  });

  /*
   * The load on mount merges its answer (D077) and, like the reload on
   * `ready`, writes what `response.recorded` delivered meanwhile onto the rows
   * it brings (#174).
   */
  describe('the load on mount, with a response recorded during it (#174)', () => {
    const sent: ResponseSummary = { state: 'sent', status: 201, queueStep: null, rule: null };
    const stale = { ...item('a', '2026-08-24T10:00:00.000Z'), response: pending };

    it('order (a): request.received, response.recorded, then a stale answer', () => {
      let current = mergeRequests([], [stale]);

      current = applyResponseRecorded(current, { id: 'a', response: sent });

      const merged = mergeRequests(current, [stale], new Map([['a', sent]]));

      assert.equal(merged.length, 1);
      assert.deepEqual(merged[0]?.response, sent);
    });

    it('order (c): the page had no row yet when the event arrived', () => {
      const current = applyResponseRecorded([], { id: 'a', response: sent });

      const merged = mergeRequests(current, [stale], new Map([['a', sent]]));

      assert.deepEqual(
        merged.map((entry) => entry.response),
        [sent],
      );
    });

    it('never creates a row for an id the result lacks', () => {
      const merged = mergeRequests([], [stale], new Map([['gone', sent]]));

      assert.deepEqual(
        merged.map((entry) => entry.id),
        ['a'],
      );
      assert.deepEqual(merged[0]?.response, pending);
    });

    it('takes the loaded copy when nothing was recorded during the load', () => {
      const current = [{ ...item('a', '2026-08-24T10:00:00.000Z'), response: sent }];

      assert.deepEqual(mergeRequests(current, [stale], new Map())[0]?.response, pending);
      assert.deepEqual(mergeRequests(current, [stale])[0]?.response, pending);
    });
  });
});

/**
 * The reload on every socket connection replaces the list (issue #39): a row
 * deleted while the socket was down must not survive the reconnection.
 */
describe('replaceWithReloaded', () => {
  it('drops a row on screen that the loaded list lacks', () => {
    const current = [
      item('deleted', '2026-08-24T10:00:01.000Z'),
      item('kept', '2026-08-24T10:00:00.000Z'),
    ];

    const replaced = replaceWithReloaded(
      current,
      [item('kept', '2026-08-24T10:00:00.000Z')],
      new Set(),
      new Map(),
    );

    assert.deepEqual(
      replaced.map((entry) => entry.id),
      ['kept'],
    );
  });

  it('empties the list after a Delete all missed while disconnected', () => {
    const current = [item('a', '2026-08-24T10:00:01.000Z'), item('b', '2026-08-24T10:00:00.000Z')];

    assert.deepEqual(replaceWithReloaded(current, [], new Set(), new Map()), []);
  });

  it('keeps a row request.received delivered during the load and the load lacks', () => {
    const current = [
      { ...item('late', '2026-08-24T10:00:05.000Z'), response: pending },
      item('stale', '2026-08-24T10:00:01.000Z'),
    ];
    const loaded = [
      item('old', '2026-08-24T10:00:00.000Z'),
      item('new', '2026-08-24T10:00:03.000Z'),
    ];

    const replaced = replaceWithReloaded(current, loaded, new Set(['late']), new Map());

    assert.deepEqual(
      replaced.map((entry) => entry.id),
      ['late', 'new', 'old'],
    );
    // The screen's copy, which carries any response recorded meanwhile.
    assert.deepEqual(replaced[0]?.response, pending);
  });

  it('takes the loaded copy of a row both sources hold', () => {
    const sent: ResponseSummary = { state: 'sent', status: 200, queueStep: null, rule: null };
    const current = [item('a', '2026-08-24T10:00:00.000Z')];
    const loaded = [{ ...item('a', '2026-08-24T10:00:00.000Z'), response: sent }];

    const replaced = replaceWithReloaded(current, loaded, new Set(['a']), new Map());

    assert.equal(replaced.length, 1);
    assert.deepEqual(replaced[0]?.response, sent);
  });

  it('never grows past the retention limit the backend enforces', () => {
    const loaded = Array.from({ length: MAX_REQUESTS_PER_SESSION }, (_unused, index) =>
      item(`old-${index}`, new Date(Date.UTC(2026, 7, 24, 10, 0, index)).toISOString()),
    );
    const current = [item('new', '2026-08-24T23:00:00.000Z')];

    const replaced = replaceWithReloaded(current, loaded, new Set(['new']), new Map());

    assert.equal(replaced.length, MAX_REQUESTS_PER_SESSION);
    assert.equal(replaced[0]?.id, 'new');
    assert.ok(!replaced.some((entry) => entry.id === 'old-0'));
  });

  /*
   * #174: the answer can be older than a `response.recorded` that arrived while
   * the load was in flight. What the event delivered is written onto the row
   * the answer brings back, whatever state that copy holds.
   */
  describe('with a response recorded during the load (#174)', () => {
    const sent: ResponseSummary = { state: 'sent', status: 201, queueStep: null, rule: null };
    const stale = { ...item('a', '2026-08-24T10:00:00.000Z'), response: pending };

    it('order (a): request.received, response.recorded, then a stale answer', () => {
      // The screen as the page's two handlers leave it.
      let current = mergeRequests([], [stale]);

      current = applyResponseRecorded(current, { id: 'a', response: sent });

      const replaced = replaceWithReloaded(
        current,
        [stale],
        new Set(['a']),
        new Map([['a', sent]]),
      );

      assert.equal(replaced.length, 1);
      assert.deepEqual(replaced[0]?.response, sent);
    });

    it('order (b): a row from an earlier load, recorded during this one', () => {
      // On screen since before the reconnect, so the load did not receive it.
      const current = applyResponseRecorded([stale], { id: 'a', response: sent });

      const replaced = replaceWithReloaded(current, [stale], new Set(), new Map([['a', sent]]));

      assert.deepEqual(replaced[0]?.response, sent);
    });

    it('order (c): a row not on screen when the event arrived', () => {
      // The event changed nothing: the list did not hold the row yet.
      const current = applyResponseRecorded([], { id: 'a', response: sent });

      const replaced = replaceWithReloaded(current, [stale], new Set(), new Map([['a', sent]]));

      assert.deepEqual(
        replaced.map((entry) => entry.response),
        [sent],
      );
    });

    it('wins over an `unknown` copy too, and keeps the event’s queue step', () => {
      const stepped: ResponseSummary = {
        state: 'aborted',
        status: 202,
        queueStep: { index: 2, total: 3 },
        rule: null,
      };
      const unknown: ResponseSummary = {
        state: 'unknown',
        status: 202,
        queueStep: { index: 2, total: 3 },
        rule: null,
      };
      const loaded = [{ ...item('a', '2026-08-24T10:00:00.000Z'), response: unknown }];

      const replaced = replaceWithReloaded([], loaded, new Set(), new Map([['a', stepped]]));

      assert.deepEqual(replaced[0]?.response, stepped);
    });

    it('leaves the other rows of the answer as they are, the same objects', () => {
      const other = { ...item('b', '2026-08-24T10:00:01.000Z'), response: pending };

      const replaced = replaceWithReloaded([], [other, stale], new Set(), new Map([['a', sent]]));

      assert.strictEqual(replaced[0], other);
      assert.deepEqual(
        replaced.map((entry) => entry.response),
        [pending, sent],
      );
    });

    it('never creates a row for an id the result lacks', () => {
      const replaced = replaceWithReloaded(
        [],
        [stale],
        new Set(['gone']),
        new Map([
          ['gone', sent],
          ['deleted', sent],
        ]),
      );

      assert.deepEqual(
        replaced.map((entry) => entry.id),
        ['a'],
      );
      assert.deepEqual(replaced[0]?.response, pending);
    });

    it('does not bring back a row the retention limit pushed out', () => {
      const loaded = Array.from({ length: MAX_REQUESTS_PER_SESSION }, (_unused, index) => ({
        ...item(`old-${index}`, new Date(Date.UTC(2026, 7, 24, 10, 0, index)).toISOString()),
        response: pending,
      }));
      const current = [item('new', '2026-08-24T23:00:00.000Z')];

      const replaced = replaceWithReloaded(
        current,
        loaded,
        new Set(['new']),
        new Map([
          ['old-0', sent],
          ['old-1', sent],
        ]),
      );

      assert.equal(replaced.length, MAX_REQUESTS_PER_SESSION);
      assert.ok(!replaced.some((entry) => entry.id === 'old-0'));
      assert.equal(replaced.at(-1)?.id, 'old-1');
      assert.deepEqual(replaced.at(-1)?.response, sent);
    });
  });
});

describe('reloadClosesDetails', () => {
  const loaded = [item('a', '2026-08-24T10:00:00.000Z')];

  it('closes the panel when the open request is one of the dropped rows', () => {
    assert.equal(reloadClosesDetails('deleted', loaded, new Set()), true);
  });

  it('keeps the panel when the open request is still listed', () => {
    assert.equal(reloadClosesDetails('a', loaded, new Set()), false);
  });

  it('keeps the panel when the open request arrived during the load', () => {
    assert.equal(reloadClosesDetails('late', loaded, new Set(['late'])), false);
  });

  it('has nothing to close when nothing is open', () => {
    assert.equal(reloadClosesDetails(null, loaded, new Set()), false);
  });
});

describe('createListLoads', () => {
  /** What a load that answered and saw no event during it settles with. */
  const nothing = { receivedIds: new Set(), responses: new Map() };

  it('answers with the ids received after the load began', () => {
    const loads = createListLoads();

    loads.received('before');

    const load = loads.begin();

    loads.received('during');

    assert.deepEqual([...(load.settle()?.receivedIds ?? [])], ['during']);
  });

  it('discards a load when a deletion arrives while it is in flight', () => {
    const loads = createListLoads();
    const load = loads.begin();

    loads.received('during');
    loads.invalidate();

    assert.equal(load.settle(), null);
  });

  it('does not discard a load that began after the deletion', () => {
    const loads = createListLoads();

    loads.invalidate();

    const load = loads.begin();

    assert.deepEqual(load.settle(), nothing);
  });

  it('discards an older load that answers after a later one was applied', () => {
    const loads = createListLoads();
    const older = loads.begin();
    const newer = loads.begin();

    assert.deepEqual(newer.settle(), nothing);
    assert.equal(older.settle(), null);
  });

  it('applies both loads when they answer in the order they began', () => {
    const loads = createListLoads();
    const older = loads.begin();
    const newer = loads.begin();

    assert.deepEqual(older.settle(), nothing);
    assert.deepEqual(newer.settle(), nothing);
  });

  it('keeps an older load when the later one failed', () => {
    const loads = createListLoads();
    const older = loads.begin();
    const newer = loads.begin();

    newer.abandon();

    assert.deepEqual(older.settle(), nothing);
  });

  it('stops recording for an abandoned load', () => {
    const loads = createListLoads();
    const abandoned = loads.begin();
    const other = loads.begin();

    abandoned.abandon();
    loads.received('after');

    assert.deepEqual([...(other.settle()?.receivedIds ?? [])], ['after']);
  });

  it('stops recording for a load once it has settled', () => {
    const loads = createListLoads();
    const first = loads.begin();
    const second = loads.begin();

    loads.received('both');

    const settled = first.settle();

    loads.received('second-only');

    assert.deepEqual([...(settled?.receivedIds ?? [])], ['both']);
    assert.deepEqual([...(second.settle()?.receivedIds ?? [])], ['both', 'second-only']);
  });

  /** The responses `response.recorded` delivered during each load (#174). */
  describe('responses recorded during a load', () => {
    const sent: ResponseSummary = { state: 'sent', status: 200, queueStep: null, rule: null };
    const failed: ResponseSummary = { state: 'failed', status: null, queueStep: null, rule: null };

    it('keeps them by id, the last one winning, and none from before the load', () => {
      const loads = createListLoads();

      loads.recorded('before', sent);

      const load = loads.begin();

      loads.recorded('a', pending);
      loads.recorded('b', failed);
      loads.recorded('a', sent);

      assert.deepEqual(
        load.settle()?.responses,
        new Map([
          ['a', sent],
          ['b', failed],
        ]),
      );
    });

    it('keeps them apart from the ids received', () => {
      const loads = createListLoads();
      const load = loads.begin();

      loads.recorded('a', sent);

      assert.deepEqual(load.settle(), {
        receivedIds: new Set(),
        responses: new Map([['a', sent]]),
      });
    });

    it('records one in every load in flight, until each settles', () => {
      const loads = createListLoads();
      const first = loads.begin();
      const second = loads.begin();

      loads.recorded('both', sent);

      const settled = first.settle();

      loads.recorded('second-only', failed);

      assert.deepEqual(settled?.responses, new Map([['both', sent]]));
      assert.deepEqual(
        second.settle()?.responses,
        new Map([
          ['both', sent],
          ['second-only', failed],
        ]),
      );
    });

    it('stops recording for an abandoned load, which hands what it held to no other', () => {
      const loads = createListLoads();
      const abandoned = loads.begin();

      loads.recorded('a', sent);
      abandoned.abandon();
      loads.recorded('after', failed);

      const later = loads.begin();

      assert.deepEqual(later.settle(), nothing);
    });

    it('still discards a load a deletion or a newer applied load overtook', () => {
      const loads = createListLoads();
      const deleted = loads.begin();

      loads.recorded('a', sent);
      loads.invalidate();

      assert.equal(deleted.settle(), null);

      const older = loads.begin();
      const newer = loads.begin();

      loads.recorded('b', sent);

      assert.deepEqual(newer.settle()?.responses, new Map([['b', sent]]));
      assert.equal(older.settle(), null);
    });
  });
});

/**
 * The page's own steps put together the way `hooks/useSessionSocket.ts` and
 * `hooks/useSessionData.ts` do - `onRequest`, `onResponse`, `onDeleted` and
 * the reload on `ready` in the first, the load on mount (`useFirstLoad`) in
 * the second - so the orders #174 names are followed from the event to the
 * row. The page's wiring itself was checked once in a browser during delivery.
 */
function sessionPage() {
  const loads = createListLoads();
  let screen: RequestListItem[] = [];

  return {
    loads,
    screen: (): RequestListItem[] => screen,
    received(row: RequestListItem): void {
      loads.received(row.id);
      screen = mergeRequests(screen, [row]);
    },
    recorded(id: string, response: ResponseSummary): void {
      loads.recorded(id, response);
      screen = applyResponseRecorded(screen, { id, response });
    },
    deleted(id: string): void {
      loads.invalidate();
      screen = applyRequestDeleted(screen, id);
    },
    mounted(load: ListLoad, answer: RequestListItem[]): void {
      const settled = load.settle();

      if (settled !== null) {
        screen = mergeRequests(screen, answer, settled.responses);
      }
    },
    reloaded(load: ListLoad, answer: RequestListItem[]): void {
      const settled = load.settle();

      if (settled !== null) {
        screen = replaceWithReloaded(screen, answer, settled.receivedIds, settled.responses);
      }
    },
  };
}

describe('a response recorded while the list loads (#174)', () => {
  const sent: ResponseSummary = { state: 'sent', status: 200, queueStep: null, rule: null };
  const stale = { ...item('a', '2026-08-24T10:00:00.000Z'), response: pending };

  it('order (a) on the reload on `ready`', () => {
    const page = sessionPage();
    const load = page.loads.begin();

    page.received(stale);
    page.recorded('a', sent);
    page.reloaded(load, [stale]);

    assert.deepEqual(
      page.screen().map((entry) => entry.response),
      [sent],
    );
  });

  it('order (a) on the load on mount', () => {
    const page = sessionPage();
    const load = page.loads.begin();

    page.received(stale);
    page.recorded('a', sent);
    page.mounted(load, [stale]);

    assert.deepEqual(
      page.screen().map((entry) => entry.response),
      [sent],
    );
  });

  it('order (b): a reconnect’s reload over a row the earlier load brought', () => {
    const page = sessionPage();

    page.mounted(page.loads.begin(), [stale]);

    const reload = page.loads.begin();

    page.recorded('a', sent);
    page.reloaded(reload, [stale]);

    assert.deepEqual(
      page.screen().map((entry) => entry.response),
      [sent],
    );
  });

  it('order (c) on the load on mount and on the reload on `ready`', () => {
    for (const settle of ['mounted', 'reloaded'] as const) {
      const page = sessionPage();
      const load = page.loads.begin();

      page.recorded('a', sent);
      assert.deepEqual(page.screen(), []);

      page[settle](load, [stale]);

      assert.deepEqual(
        page.screen().map((entry) => entry.response),
        [sent],
        settle,
      );
    }
  });

  it('two loads in flight, mount and `ready`, each keep it, whichever answers first', () => {
    for (const first of ['mount', 'ready'] as const) {
      const page = sessionPage();
      const mount = page.loads.begin();
      const ready = page.loads.begin();

      page.recorded('a', sent);

      if (first === 'mount') {
        page.mounted(mount, [stale]);
        assert.deepEqual(page.screen()[0]?.response, sent, 'mount');
        page.reloaded(ready, [stale]);
      } else {
        page.reloaded(ready, [stale]);
        // The mount load began first, so its answer is discarded (#39).
        page.mounted(mount, [stale]);
      }

      assert.deepEqual(
        page.screen().map((entry) => entry.response),
        [sent],
        first,
      );
    }
  });

  it('a deletion during the load still discards it, recorded response and all', () => {
    const page = sessionPage();

    page.mounted(page.loads.begin(), [stale]);

    const reload = page.loads.begin();

    page.recorded('a', sent);
    page.deleted('a');
    page.reloaded(reload, [stale]);

    assert.deepEqual(page.screen(), []);
  });

  it('an event after the load settled applies to the row as before', () => {
    const page = sessionPage();
    const load = page.loads.begin();

    page.reloaded(load, [stale]);
    page.recorded('a', sent);

    assert.deepEqual(
      page.screen().map((entry) => entry.response),
      [sent],
    );
  });
});

describe('withListPath', () => {
  it('reads a row without `path` as `path: null` and leaves a full row as it is (D180)', () => {
    const old: Partial<RequestListItem> = item('a', '2026-08-24T10:00:00.000Z');

    delete old.path;
    const full = { ...item('b', '2026-08-24T10:00:00.000Z'), path: '/s/x/y' };

    assert.equal(withListPath(old as RequestListItem).path, null);
    assert.equal(withListPath(full), full);
  });

  /**
   * Issue #245: a `sourceIp` the contract does not allow is read as `null`
   * once, here, so the row, the filter and the panel never meet it. Each of
   * these used to blank the page in `formatListAddress` or in the filter's
   * row texts. The large ones show the check costs the same at any size.
   */
  const NOT_AN_ADDRESS: [string, unknown][] = [
    ['a number', 123],
    ['zero', 0],
    ['a negative number', -1],
    ['NaN', Number.NaN],
    ['an empty object', {}],
    ['an object with a length', { length: 3 }],
    ['an object with a slice', { length: 3, slice: () => 'x' }],
    ['an empty array', []],
    ['an array holding an address', ['1.2.3.4']],
    ['an array of a million entries', new Array<string>(1_000_000).fill('1')],
    ['true', true],
    ['false', false],
  ];

  for (const [name, sourceIp] of NOT_AN_ADDRESS) {
    it(`reads ${name} as sourceIp: null, keeping every other field`, () => {
      const sent = { ...item('a', '2026-08-24T10:00:00.000Z'), path: '/s/x/y', sourceIp };
      const read = withListPath(sent as unknown as RequestListItem);

      assert.deepEqual(read, { ...sent, sourceIp: null });
      assert.notEqual(read, sent);
      // The answer itself is left as it came.
      assert.equal(sent.sourceIp, sourceIp);
    });
  }

  it('reads a missing sourceIp as null, and a row missing both fields as both null', () => {
    const noAddress: Partial<RequestListItem> = { ...item('a', '2026-08-24T10:00:00.000Z') };

    delete noAddress.sourceIp;
    const neither: Partial<RequestListItem> = { ...noAddress };

    delete neither.path;

    assert.equal(withListPath(noAddress as RequestListItem).sourceIp, null);
    assert.ok('sourceIp' in withListPath(noAddress as RequestListItem));
    assert.deepEqual(withListPath(neither as RequestListItem), {
      ...item('a', '2026-08-24T10:00:00.000Z'),
      sourceIp: null,
      path: null,
    });
  });

  it('keeps a string and null as they are, in the same object, a 1 MB string included', () => {
    const kept = [
      null,
      '',
      '203.0.113.7',
      '2001:db8:85a3:8d3:1319:8a2e:370:7348',
      'not an address at all',
      'f'.repeat(1_048_576),
    ];

    for (const sourceIp of kept) {
      const row = { ...item('a', '2026-08-24T10:00:00.000Z'), path: '/s/x/y', sourceIp };

      assert.equal(withListPath(row), row);
    }
  });

  it('gives what it read to the row, the filter and the panel without a throw', () => {
    for (const [, sourceIp] of NOT_AN_ADDRESS) {
      const read = withListPath({
        ...item('a', '2026-08-24T10:00:00.000Z'),
        path: '/s/x/y',
        sourceIp,
      } as unknown as RequestListItem);

      assert.equal(formatListAddress(read.sourceIp), 'IP unavailable');
      assert.equal(formatListAddress(read.sourceIp, undefined, true), 'IP not stored');
      assert.equal(isAddressShortened(read.sourceIp), false);
      assert.equal(matchesRequest(read, queryWords('unavailable'), 'UTC'), true);
      assert.equal(matchesRequest(read, queryWords('1.2.3.4'), 'UTC'), false);
      assert.equal(rowHighlights(read, ['ip'], 'UTC').texts.address, 'IP unavailable');
    }
  });
});

/**
 * The `request.received` event reaches the list through `routeServerMessage`
 * in `api/realtime.ts`, which passes the row through `withListPath`. This is
 * the one guard on that path for #245; it lives here, next to the read it
 * checks, so the change stays out of the `realtime` delivery area.
 */
describe('a request.received frame through routeServerMessage', () => {
  function routedSourceIp(data: string): unknown {
    const routed = routeServerMessage(`{"type":"request.received","data":${data}}`);

    return routed.kind === 'request' ? routed.event.data.sourceIp : undefined;
  }

  it('reads a sourceIp that is not a string as `sourceIp: null` (#245)', () => {
    const sent = [
      '123',
      '0',
      '-1',
      '{}',
      '{"length":3}',
      '[]',
      '["1.2.3.4"]',
      'true',
      'false',
      JSON.stringify(new Array<string>(100_000).fill('1.2.3.4')),
    ];

    for (const sourceIp of sent) {
      assert.equal(
        routedSourceIp(`{"id":"a","method":"POST","path":"/s/x","sourceIp":${sourceIp}}`),
        null,
        sourceIp.slice(0, 40),
      );
    }
  });

  it('reads a missing sourceIp as null and keeps a real address', () => {
    assert.equal(routedSourceIp('{"id":"a","method":"POST","path":"/s/x"}'), null);
    assert.equal(
      routedSourceIp('{"id":"a","method":"POST","path":"/s/x","sourceIp":"::1"}'),
      '::1',
    );
  });
});

describe('withSourceIp', () => {
  it('reads a detail answer the same way, and returns it as it is when it needs no fix', () => {
    const details = {
      ...item('a', '2026-08-24T10:00:00.000Z'),
      sourceIp: '203.0.113.7',
    } as unknown as RequestDetails;
    const broken = { ...details, sourceIp: { ip: '203.0.113.7' } } as unknown as RequestDetails;

    assert.equal(withSourceIp(details), details);
    assert.deepEqual(withSourceIp(broken), { ...details, sourceIp: null });
  });
});

/**
 * The consumer of `response.recorded` (D110, D114).
 *
 * It is a separate function rather than a widening of `mergeRequests` on
 * purpose: that one is incoming-wins-wholesale, and merging a `{ id, response }`
 * payload through it is exactly the overwrite this release exists to prevent.
 */
describe('applyResponseRecorded', () => {
  it('updates the held row in place, leaving its other fields intact', () => {
    const existing = [
      {
        ...item('a', '2026-08-24T10:00:00.000Z'),
        method: 'PUT',
        bodySize: 61,
        sourceIp: '8.8.8.8',
        path: '/s/x/stripe',
      },
      item('b', '2026-08-24T10:00:01.000Z'),
    ];

    const updated = applyResponseRecorded(existing, {
      id: 'a',
      response: { state: 'sent', status: 200, queueStep: null, rule: null },
    });

    assert.deepEqual(updated[0], {
      id: 'a',
      method: 'PUT',
      receivedAt: '2026-08-24T10:00:00.000Z',
      bodySize: 61,
      sourceIp: '8.8.8.8',
      path: '/s/x/stripe',
      response: { state: 'sent', status: 200, queueStep: null, rule: null },
    });
    assert.deepEqual(updated[1], existing[1]);
  });

  it('replaces an earlier summary on the same row', () => {
    const existing = [{ ...item('a', '2026-08-24T10:00:00.000Z'), response: pending }];

    const updated = applyResponseRecorded(existing, {
      id: 'a',
      response: { state: 'aborted', status: 201, queueStep: null, rule: null },
    });

    assert.deepEqual(updated[0]?.response, {
      state: 'aborted',
      status: 201,
      queueStep: null,
      rule: null,
    });
  });

  it('keeps the order of the list', () => {
    const existing = [
      item('a', '2026-08-24T10:00:02.000Z'),
      item('b', '2026-08-24T10:00:01.000Z'),
      item('c', '2026-08-24T10:00:00.000Z'),
    ];

    const updated = applyResponseRecorded(existing, {
      id: 'c',
      response: { state: 'sent', status: 200, queueStep: null, rule: null },
    });

    assert.deepEqual(
      updated.map((entry) => entry.id),
      ['a', 'b', 'c'],
    );
  });

  /**
   * Reachable with no defect at all: after `Delete all`, after the row aged out
   * of the retention limit, and on a connection opened between a request being
   * captured and its response completing. The event carries a summary rather
   * than a row, so materialising one would invent a request.
   */
  it('leaves the list unchanged for an id it does not hold, and never creates a row', () => {
    const existing = [item('a', '2026-08-24T10:00:00.000Z')];

    const updated = applyResponseRecorded(existing, {
      id: 'gone',
      response: { state: 'sent', status: 200, queueStep: null, rule: null },
    });

    assert.deepEqual(updated, existing);
    assert.equal(updated.length, 1);
    // The same array, not an equal one: an ignored event must not re-render the
    // page, the list and both halves of the detail panel.
    assert.strictEqual(updated, existing);
  });

  it('leaves an empty list empty, and returns the same array', () => {
    const existing: RequestListItem[] = [];

    assert.strictEqual(applyResponseRecorded(existing, { id: 'a', response: pending }), existing);
  });
});

/** A detail answer, with only the fields these tests look at filled in. */
function details(id: string): RequestDetails {
  return {
    ...item(id, '2026-08-24T10:00:00.000Z'),
    // The detail's `response` is the whole record, not the list row's summary -
    // which is the reason the panel cannot be patched from the event (D125).
    response: null,
    queryString: '',
    headers: [],
    body: null,
    bodyBase64: null,
    isBinary: false,
    raw: null,
    rawBase64: null,
    isRawBinary: false,
    path: null,
    httpVersion: null,
  };
}

/**
 * The open panel follows a recorded response too, and it can only follow it by
 * fetching the detail again: the event carries `{ state, status }` while the
 * panel header reads the whole record (D110, D125).
 */
describe('shouldRefreshDetails', () => {
  it('refreshes when the event names the request currently on screen', () => {
    assert.equal(shouldRefreshDetails('a', 'a'), true);
  });

  it('ignores an event for a request that is not selected', () => {
    assert.equal(shouldRefreshDetails('b', 'a'), false);
  });

  it('ignores every event while nothing is selected', () => {
    assert.equal(shouldRefreshDetails('a', null), false);
  });
});

describe('canApplyRefreshedDetails', () => {
  it('applies the answer while the selection and the token are both unchanged', () => {
    assert.equal(
      canApplyRefreshedDetails({ loadedId: 'a', selectedId: 'a', token: 3, currentToken: 3 }),
      true,
    );
  });

  /**
   * The switch mid-update: A is open, its `response.recorded` starts a refresh,
   * the viewer clicks B, and A's answer comes back afterwards. `select(B)` moved
   * both the token and the selection, so both guards refuse it - and they have
   * to, because applying it would show A's response under B's heading.
   */
  it('refuses an answer overtaken by a selection made while it was in flight', () => {
    assert.equal(
      canApplyRefreshedDetails({ loadedId: 'a', selectedId: 'b', token: 3, currentToken: 4 }),
      false,
    );
  });

  /**
   * The token alone is not enough. `select()`'s `REQUEST_NOT_FOUND` branch drops
   * the row and clears the selection **without** incrementing the token, so a
   * refresh started before it arrives with a token that still matches. Without
   * the id guard it would repopulate a panel that is showing nothing.
   */
  it('refuses an answer whose request is no longer selected, token or no token', () => {
    assert.equal(
      canApplyRefreshedDetails({ loadedId: 'a', selectedId: null, token: 3, currentToken: 3 }),
      false,
    );
    assert.equal(
      canApplyRefreshedDetails({ loadedId: 'a', selectedId: 'b', token: 3, currentToken: 3 }),
      false,
    );
  });

  it('refuses a stale token even where the same request is still selected', () => {
    assert.equal(
      canApplyRefreshedDetails({ loadedId: 'a', selectedId: 'a', token: 3, currentToken: 4 }),
      false,
    );
  });
});

describe('loadRefreshedDetails', () => {
  it('answers with the loaded detail when nothing moved under it', async () => {
    const loaded = await loadRefreshedDetails({
      id: 'a',
      token: 1,
      load: (id) => Promise.resolve(details(id)),
      currentState: () => ({ selectedId: 'a', token: 1 }),
    });

    assert.equal(loaded?.id, 'a');
  });

  /** The same race as above, driven through the routine that runs it. */
  it('answers with nothing when the viewer switched while the answer was in flight', async () => {
    let selectedId = 'a';
    let token = 1;

    const loaded = await loadRefreshedDetails({
      id: 'a',
      token,
      load: (id) => {
        // What `select('b')` does, and it does it while the refresh started
        // above is still waiting for this answer.
        selectedId = 'b';
        token += 1;

        return Promise.resolve(details(id));
      },
      currentState: () => ({ selectedId, token }),
    });

    assert.equal(loaded, null);
  });

  /**
   * A refresh is a second opinion on a panel that already holds one, so a
   * failure is nothing to report: the answer is `null`, exactly as for a stale
   * one, and the caller leaves what is on screen alone rather than clearing it
   * or showing a failure.
   */
  it('answers with nothing when the refresh itself fails, and does not throw', async () => {
    const loaded = await loadRefreshedDetails({
      id: 'a',
      token: 1,
      load: () => Promise.reject(new Error('network is gone')),
      currentState: () => ({ selectedId: 'a', token: 1 }),
    });

    assert.equal(loaded, null);
  });

  it('reads the selection only after the answer has arrived', async () => {
    let reads = 0;

    await loadRefreshedDetails({
      id: 'a',
      token: 1,
      load: (id) => {
        assert.equal(reads, 0);

        return Promise.resolve(details(id));
      },
      currentState: () => {
        reads += 1;

        return { selectedId: 'a', token: 1 };
      },
    });

    assert.equal(reads, 1);
  });
});

/**
 * A `response.recorded` sent while the socket was down reaches no one, so the
 * open panel is fetched again on every `ready` while a request is open,
 * whatever its response state (#204).
 */
describe('shouldRefreshDetailsOnReady', () => {
  it('refreshes the open request on a `ready`', () => {
    assert.equal(shouldRefreshDetailsOnReady('a'), true);
  });

  it('has nothing to refresh while nothing is open', () => {
    assert.equal(shouldRefreshDetailsOnReady(null), false);
  });
});

/**
 * A detail answer whose response record reads `state`, or has none. An
 * `unknown` record is still stored `pending`, so like a pending one it has no
 * body and no completion yet.
 */
function detailsWith(id: string, state: ResponseState | null, status = 200): RequestDetails {
  const unfinished = state === 'pending' || state === 'unknown';

  return {
    ...details(id),
    response:
      state === null
        ? null
        : {
            state,
            status,
            queueStep: null,
            rule: null,
            headers: [['Content-Type', 'application/json']],
            body: unfinished ? null : '{}',
            bodyBase64: null,
            isBinary: false,
            bodySize: unfinished ? 0 : 2,
            bodySuppressed: false,
            raw: null,
            rawBase64: null,
            isRawBinary: false,
            delayMs: 5_000,
            startedAt: '2026-08-24T10:00:00.000Z',
            completedAt: unfinished ? null : '2026-08-24T10:00:05.000Z',
            durationMs: unfinished ? null : 5_000,
          },
  };
}

/**
 * The opening answer and a refresh hold the same token, so neither the token
 * nor the order they land in says which was read last; the backend does: a
 * record leaves `pending` once and never returns to it, and `unknown` is read
 * from a record still stored `pending`, so reads go `pending`, `unknown`, a
 * recorded state, and never back (#204).
 */
describe('detailToShow', () => {
  it('keeps the recorded response when a pending answer for the same request lands after it', () => {
    const recorded = detailsWith('a', 'sent');

    assert.equal(detailToShow(recorded, detailsWith('a', 'pending')), recorded);
  });

  /**
   * Race (1) of #204 in both orders: `select()` cleared the panel, then the
   * refresh `response.recorded` started and the opening answer, read before
   * the record, land in either order. The panel ends on the recorded response.
   */
  it('ends on the recorded response whichever of the two answers lands first', () => {
    const opening = detailsWith('a', 'pending');
    const refresh = detailsWith('a', 'sent');

    assert.equal(detailToShow(detailToShow(null, refresh), opening), refresh);
    assert.equal(detailToShow(detailToShow(null, opening), refresh), refresh);
  });

  it('keeps every state but `pending` over a pending answer', () => {
    for (const state of ['sent', 'aborted', 'failed', 'unknown'] as const) {
      const shown = detailsWith('a', state, 502);

      assert.equal(detailToShow(shown, detailsWith('a', 'pending')), shown, state);
    }
  });

  /**
   * `unknown` is read from a pending record aged past its delay and the grace,
   * so an answer still reading `pending` was read before it.
   */
  it('keeps `unknown` over a pending answer', () => {
    const unknown = detailsWith('a', 'unknown');

    assert.equal(detailToShow(unknown, detailsWith('a', 'pending')), unknown);
  });

  /**
   * `unknown` is read from a record still stored `pending`, so an answer
   * reading it was read before the record was recorded: a reconnect fetch
   * that read an overdue record does not undo the recorded response a
   * `response.recorded` refresh already put on screen.
   */
  it('keeps every recorded state over an unknown answer', () => {
    for (const state of ['sent', 'aborted', 'failed'] as const) {
      const recorded = detailsWith('a', state, 502);

      assert.equal(detailToShow(recorded, detailsWith('a', 'unknown')), recorded, state);
    }
  });

  /**
   * A race, in both orders: the opening answer, or the
   * fetch a `ready` started, read the overdue record as `unknown`; the refresh
   * `response.recorded` started read it recorded. The panel ends on the
   * recorded response whichever lands first.
   */
  it('ends on the recorded response whichever of an unknown answer and a recorded one lands first', () => {
    const overdue = detailsWith('a', 'unknown');
    const refresh = detailsWith('a', 'sent');

    // The opening answer, on the panel `select()` cleared.
    assert.equal(detailToShow(detailToShow(null, refresh), overdue), refresh);
    assert.equal(detailToShow(detailToShow(null, overdue), refresh), refresh);

    // The fetch on `ready`, on a panel opened while the record was pending.
    const opened = detailsWith('a', 'pending');

    assert.equal(detailToShow(detailToShow(opened, refresh), overdue), refresh);
    assert.equal(detailToShow(detailToShow(opened, overdue), refresh), refresh);
  });

  it('applies an unknown answer over a pending panel', () => {
    const overdue = detailsWith('a', 'unknown');

    assert.equal(detailToShow(detailsWith('a', 'pending'), overdue), overdue);
  });

  it('applies an unknown answer over an unknown panel', () => {
    const later = detailsWith('a', 'unknown', 201);

    assert.equal(detailToShow(detailsWith('a', 'unknown'), later), later);
  });

  it('replaces a pending panel with a recorded answer', () => {
    const recorded = detailsWith('a', 'sent');

    assert.equal(detailToShow(detailsWith('a', 'pending'), recorded), recorded);
  });

  it('applies a recorded answer over a recorded panel', () => {
    const later = detailsWith('a', 'sent', 201);

    assert.equal(detailToShow(detailsWith('a', 'sent'), later), later);
    // A response that was overdue and then recorded after all.
    assert.equal(detailToShow(detailsWith('a', 'unknown'), later), later);
  });

  it('applies a pending answer over a pending panel', () => {
    const later = detailsWith('a', 'pending');

    assert.equal(detailToShow(detailsWith('a', 'pending'), later), later);
  });

  it('never holds back another request’s answer', () => {
    const shown = detailsWith('a', 'sent');

    for (const state of ['pending', 'sent', 'unknown', null] as const) {
      const other = detailsWith('b', state);

      assert.equal(detailToShow(shown, other), other, String(state));
    }
  });

  it('shows an answer on an empty panel as it came', () => {
    const opening = detailsWith('a', 'pending');

    assert.equal(detailToShow(null, opening), opening);
  });

  it('passes a `null` response through as the answer gives it', () => {
    const none = detailsWith('a', null);

    assert.equal(detailToShow(detailsWith('a', 'sent'), none), none);
    assert.equal(detailToShow(detailsWith('a', 'pending'), none), none);

    const opening = detailsWith('a', 'pending');

    assert.equal(detailToShow(detailsWith('a', null), opening), opening);
  });
});

describe('countUnread', () => {
  it('counts every request the viewer has not opened, including older ones (D078)', () => {
    const requests = [
      item('a', '2026-08-24T10:00:00.000Z'),
      item('b', '2026-08-24T10:00:01.000Z'),
      item('c', '2026-08-24T10:00:02.000Z'),
    ];

    assert.equal(countUnread(requests, new Set()), 3);
    assert.equal(countUnread(requests, new Set(['b'])), 2);
    assert.equal(countUnread(requests, new Set(['a', 'b', 'c'])), 0);
  });

  it('ignores opened requests that are no longer listed', () => {
    const requests = [item('a', '2026-08-24T10:00:00.000Z')];

    assert.equal(countUnread(requests, new Set(['deleted', 'a'])), 0);
  });
});

/**
 * The consumer of `request.deleted` (D136). The viewer that deleted a request
 * receives its own event after it has already dropped the row, so the no-op
 * case is the common one and must not produce a new array.
 */
describe('applyRequestDeleted', () => {
  const a = item('a', '2026-08-24T10:00:00.000Z');
  const b = item('b', '2026-08-24T10:00:01.000Z');

  it('drops the row the event names and keeps the rest in order', () => {
    assert.deepEqual(applyRequestDeleted([b, a], 'b'), [a]);
  });

  it('returns the same array for an id the list does not hold', () => {
    const current = [b, a];

    assert.equal(applyRequestDeleted(current, 'gone'), current);
  });

  it('is idempotent: applying the event twice equals applying it once', () => {
    const once = applyRequestDeleted([b, a], 'a');

    assert.equal(applyRequestDeleted(once, 'a'), once);
    assert.deepEqual(once, [b]);
  });

  it('leaves an empty list as it is', () => {
    const empty: RequestListItem[] = [];

    assert.equal(applyRequestDeleted(empty, 'a'), empty);
  });
});

describe('deletionClosesDetails', () => {
  it('closes the panel showing the deleted request (D137)', () => {
    assert.equal(deletionClosesDetails('a', 'a'), true);
  });

  it('leaves a panel showing another request alone', () => {
    assert.equal(deletionClosesDetails('a', 'b'), false);
  });

  it('has nothing to close when nothing is selected', () => {
    assert.equal(deletionClosesDetails('a', null), false);
  });
});
