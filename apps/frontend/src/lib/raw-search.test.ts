import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode, type RequestSearchResult } from '@webhook-inspector/shared';
import { ApiError } from '../api/client.ts';
import {
  ARRIVAL_DELAY_MS,
  canRetrySearch,
  classifySearchFailure,
  createRawSearch,
  FILTER_PLACEHOLDER,
  FILTER_PLACEHOLDER_PHONE,
  NOT_SEARCHED_LEAD,
  notSearchedReasonText,
  RAW_SEARCH_OFF,
  SEARCHED_TOO_TEXT,
  SEARCHING_TEXT,
  SPINNER_DELAY_MS,
  TYPING_PAUSE_MS,
  type NotSearchedReason,
  type RawSearchState,
  type SearchTimers,
} from './raw-search.ts';

/** Timers the test moves by hand. */
function fakeTimers() {
  let now = 0;
  let last = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: SearchTimers = {
    set(run, ms) {
      last += 1;
      pending.set(last, { at: now + ms, run });

      return last;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };

  return {
    timers,
    /** Moves time on, running what falls due, in order. */
    advance(ms: number): void {
      const until = now + ms;

      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort(([, left], [, right]) => left.at - right.at)[0];

        if (due === undefined) {
          break;
        }

        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }

      now = until;
    },
    pending: () => pending.size,
  };
}

interface Call {
  words: string[];
  answer(matches: string[][]): Promise<void>;
  fail(error: unknown): Promise<void>;
}

/** Lets the promise callbacks of an answer run. */
function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness() {
  const clock = fakeTimers();
  const calls: Call[] = [];
  const states: RawSearchState[] = [];
  const search = createRawSearch({
    timers: clock.timers,
    onChange: (state) => states.push(state),
    search: (words) =>
      new Promise<RequestSearchResult>((resolve, reject) => {
        calls.push({
          words,
          answer: (matches) => {
            resolve({ matches });

            return settled();
          },
          fail: (error) => {
            reject(error);

            return settled();
          },
        });
      }),
  });

  return {
    clock,
    calls,
    states,
    search,
    state: (): RawSearchState => states.at(-1) ?? RAW_SEARCH_OFF,
    call: (index: number): Call => {
      const call = calls[index];

      assert.ok(call !== undefined, `there is no search number ${index + 1}`);

      return call;
    },
  };
}

function ids(state: RawSearchState, word: string): string[] | undefined {
  const found = state.matches.get(word);

  return found === undefined ? undefined : [...found];
}

describe('when the search starts', () => {
  it('starts by itself 400 ms after typing stops', () => {
    const { search, clock, calls } = harness();

    assert.equal(TYPING_PAUSE_MS, 400);
    search.setQuery('abc');
    assert.equal(calls.length, 0);
    clock.advance(399);
    assert.equal(calls.length, 0);
    clock.advance(1);
    assert.deepEqual(
      calls.map((call) => call.words),
      [['abc']],
    );
  });

  it('counts the pause from the last keystroke that changed a searchable word', () => {
    const { search, clock, calls } = harness();

    search.setQuery('abc');
    clock.advance(300);
    search.setQuery('abcd');
    clock.advance(399);
    assert.equal(calls.length, 0);
    clock.advance(1);
    assert.deepEqual(
      calls.map((call) => call.words),
      [['abcd']],
    );
  });

  it('searches a filter restored on reload at once', () => {
    const { search, clock, calls } = harness();

    search.setQuery('POST 48213', { immediate: true });
    assert.deepEqual(
      calls.map((call) => call.words),
      [['POST', '48213']],
    );
    assert.equal(clock.pending(), 1, 'only the spinner timer is running');
  });

  it('sends nothing for words under 3 bytes, alone or beside a searched word', async () => {
    const { search, clock, calls, state, call } = harness();

    search.setQuery('ab');
    search.setQuery('ab cd');
    clock.advance(10_000);
    assert.equal(calls.length, 0);
    assert.equal(state().status, 'off');

    search.setQuery('ab cd abc');
    clock.advance(TYPING_PAUSE_MS);
    assert.deepEqual(call(0).words, ['abc']);
    await call(0).answer([['id-1']]);

    // A short word more, a space, a repeat: the same search, not asked again.
    search.setQuery('ab cd abc e');
    search.setQuery(' abc  abc ');
    clock.advance(10_000);
    assert.equal(calls.length, 1);
    assert.equal(state().status, 'searched');
  });

  it('sends nothing for more than 8 words or a word over 200 bytes, and says why', () => {
    const { search, clock, calls, state } = harness();

    search.setQuery('w01 w02 w03 w04 w05 w06 w07 w08 w09');
    clock.advance(10_000);
    assert.equal(calls.length, 0);
    assert.deepEqual([state().status, state().reason], ['not-searched', 'too-many-words'] as const);

    search.setQuery(`abc ${'a'.repeat(201)}`);
    clock.advance(10_000);
    assert.equal(calls.length, 0);
    assert.deepEqual([state().status, state().reason], ['not-searched', 'word-too-long'] as const);

    // Back inside the limits, it is searched.
    search.setQuery('abc');
    assert.deepEqual([state().status, state().reason], ['pending', null]);
    clock.advance(TYPING_PAUSE_MS);
    assert.equal(calls.length, 1);
  });

  it('stops searching once the filter is cleared', async () => {
    const { search, clock, calls, state, call } = harness();

    search.setQuery('abc', { immediate: true });
    await call(0).answer([['id-1']]);
    search.setQuery('');

    assert.deepEqual(state(), RAW_SEARCH_OFF);
    search.requestsArrived();
    search.listReloaded();
    search.retry();
    clock.advance(10_000);
    assert.equal(calls.length, 1);
  });
});

describe('what an answer does', () => {
  it('keeps, per word as typed, the ids the server found', async () => {
    const { search, state, call } = harness();

    search.setQuery('POST 48213', { immediate: true });
    assert.equal(state().status, 'pending');
    await call(0).answer([['id-1', 'id-2'], ['id-2']]);

    assert.equal(state().status, 'searched');
    assert.equal(state().reason, null);
    assert.deepEqual(ids(state(), 'POST'), ['id-1', 'id-2']);
    assert.deepEqual(ids(state(), '48213'), ['id-2']);
    assert.equal(ids(state(), 'post'), undefined);
  });

  it('shows no spinner for a search that answers within 300 ms', async () => {
    const { search, clock, states, call } = harness();

    assert.equal(SPINNER_DELAY_MS, 300);
    search.setQuery('abc', { immediate: true });
    clock.advance(299);
    await call(0).answer([[]]);
    clock.advance(10_000);

    assert.ok(states.every((state) => !state.slow));
    assert.equal(clock.pending(), 0);
  });

  it('shows the spinner once a search has run for 300 ms, until it answers', async () => {
    const { search, clock, state, call } = harness();

    search.setQuery('abc', { immediate: true });
    clock.advance(299);
    assert.equal(state().slow, false);
    clock.advance(1);
    assert.equal(state().slow, true);
    assert.equal(state().status, 'pending');
    await call(0).answer([['id-1']]);
    assert.equal(state().slow, false);
    assert.equal(state().status, 'searched');
  });

  it('keeps what is known about a word still in the query while another is typed', async () => {
    const { search, clock, state, call } = harness();

    search.setQuery('48213', { immediate: true });
    await call(0).answer([['id-1']]);

    search.setQuery('48213 order');
    // The row found for 48213 stays; `order` is still to come.
    assert.deepEqual(ids(state(), '48213'), ['id-1']);
    assert.equal(state().status, 'pending');
    clock.advance(TYPING_PAUSE_MS);
    assert.deepEqual(call(1).words, ['48213', 'order']);
    await call(1).answer([['id-1'], []]);
    assert.equal(state().status, 'searched');

    // A word taken away: everything left is known already, and asked again.
    search.setQuery('48213');
    assert.equal(state().status, 'searched');
    assert.deepEqual([...state().matches.keys()], ['48213']);
    clock.advance(TYPING_PAUSE_MS);
    assert.deepEqual(call(2).words, ['48213']);
  });

  it('drops what was known about a word that left the query', async () => {
    const { search, state, call } = harness();

    search.setQuery('48213', { immediate: true });
    await call(0).answer([['id-1']]);
    search.setQuery('48214');

    assert.equal(state().matches.size, 0);
    assert.equal(state().status, 'pending');
  });
});

describe('one search at a time', () => {
  it('waits for the search in flight, then asks for the newest words only', async () => {
    const { search, clock, calls, state, call } = harness();

    search.setQuery('abc', { immediate: true });
    search.setQuery('abcd');
    clock.advance(TYPING_PAUSE_MS);
    search.setQuery('abcde');
    clock.advance(TYPING_PAUSE_MS);
    // Two newer queries, and still one search in flight.
    assert.equal(calls.length, 1);

    // The older answer is dropped: its word is no longer in the query.
    await call(0).answer([['id-1']]);
    assert.equal(state().matches.size, 0);
    assert.equal(state().status, 'pending');
    assert.deepEqual(
      calls.map((one) => one.words),
      [['abc'], ['abcde']],
    );

    await call(1).answer([['id-2']]);
    assert.deepEqual(ids(state(), 'abcde'), ['id-2']);
    assert.equal(calls.length, 2);
  });

  it('drops a failure of superseded words too, with no notice', async () => {
    const { search, clock, state, call } = harness();

    search.setQuery('abc', { immediate: true });
    search.setQuery('abcd');
    await call(0).fail(new ApiError(503, ErrorCode.SEARCH_TIMED_OUT, 'slow'));

    assert.equal(state().status, 'pending');
    assert.equal(state().reason, null);
    clock.advance(TYPING_PAUSE_MS);
    assert.deepEqual(call(1).words, ['abcd']);
  });

  it('does not ask twice for the same words when the query returns to them in flight', async () => {
    const { search, clock, calls, state, call } = harness();

    search.setQuery('abc', { immediate: true });
    search.setQuery('abcd');
    search.setQuery('abc');
    clock.advance(TYPING_PAUSE_MS);
    assert.equal(calls.length, 1);
    await call(0).answer([['id-1']]);

    assert.deepEqual(ids(state(), 'abc'), ['id-1']);
    clock.advance(10_000);
    assert.equal(calls.length, 1);
  });
});

describe('new requests and reloads', () => {
  it('searches again 1 s after a request arrives, once for a burst', async () => {
    const { search, clock, calls, state, call } = harness();

    assert.equal(ARRIVAL_DELAY_MS, 1000);
    search.setQuery('abc', { immediate: true });
    await call(0).answer([['id-1']]);

    search.requestsArrived();
    clock.advance(400);
    search.requestsArrived();
    clock.advance(400);
    search.requestsArrived();
    clock.advance(199);
    assert.equal(calls.length, 1);
    clock.advance(1);
    assert.equal(calls.length, 2);
    // What was found stays on screen while it is asked again.
    assert.equal(state().status, 'searched');
    assert.deepEqual(ids(state(), 'abc'), ['id-1']);

    await call(1).answer([['id-2', 'id-1']]);
    assert.deepEqual(ids(state(), 'abc'), ['id-2', 'id-1']);

    // The next arrival starts a new second.
    search.requestsArrived();
    clock.advance(ARRIVAL_DELAY_MS);
    assert.equal(calls.length, 3);
  });

  it('searches again after an arrival during a search, once that one has answered', async () => {
    const { search, clock, calls, call } = harness();

    search.setQuery('abc', { immediate: true });
    search.requestsArrived();
    clock.advance(ARRIVAL_DELAY_MS);
    // Still one in flight.
    assert.equal(calls.length, 1);
    await call(0).answer([[]]);
    assert.equal(calls.length, 2);
    assert.deepEqual(call(1).words, ['abc']);
  });

  it('leaves an arrival to the search about to start after typing', () => {
    const { search, clock, calls } = harness();

    search.setQuery('abc');
    search.requestsArrived();
    clock.advance(TYPING_PAUSE_MS);
    assert.equal(calls.length, 1);
    clock.advance(10_000);
    assert.equal(calls.length, 1);
  });

  for (const [what, happen] of [
    [
      'a request arrives',
      (search: ReturnType<typeof harness>['search']) => search.requestsArrived(),
    ],
    [
      'the list is reloaded',
      (search: ReturnType<typeof harness>['search']) => search.listReloaded(),
    ],
  ] as const) {
    it(`searches again when ${what} during a pause in typing and the query returns to the words in flight`, async () => {
      const { search, clock, calls, state, call } = harness();

      // A slow search for `abc` is in flight.
      search.setQuery('abc', { immediate: true });
      // The query moves on, and during the pause something happens that the
      // search in flight, started before it, has not seen.
      search.setQuery('abcd');
      happen(search);
      // Back to the words in flight before the pause is over.
      search.setQuery('abc');
      clock.advance(TYPING_PAUSE_MS);
      assert.equal(calls.length, 1);

      // Its answer is shown, and the same words are searched once more.
      await call(0).answer([['id-1']]);
      assert.deepEqual(ids(state(), 'abc'), ['id-1']);
      assert.equal(calls.length, 2);
      assert.deepEqual(call(1).words, ['abc']);

      await call(1).answer([['id-2', 'id-1']]);
      assert.deepEqual(ids(state(), 'abc'), ['id-2', 'id-1']);
      clock.advance(10_000);
      assert.equal(calls.length, 2);
    });
  }

  it('searches again for an arrival noted during a search, though the query left and came back', async () => {
    const { search, clock, calls, call } = harness();

    search.setQuery('abc', { immediate: true });
    await call(0).answer([['id-1']]);

    // A second search in flight, and an arrival it has not seen.
    search.listReloaded();
    search.requestsArrived();
    clock.advance(ARRIVAL_DELAY_MS);
    assert.equal(calls.length, 2);

    search.setQuery('abcd');
    search.setQuery('abc');
    clock.advance(TYPING_PAUSE_MS);
    assert.equal(calls.length, 2);

    await call(1).answer([['id-1']]);
    assert.equal(calls.length, 3);
    assert.deepEqual(call(2).words, ['abc']);
  });

  it('searches the new words once for an arrival during the pause in typing them', async () => {
    const { search, clock, calls, call } = harness();

    search.setQuery('abc', { immediate: true });
    search.setQuery('abcd');
    search.requestsArrived();
    search.listReloaded();
    clock.advance(TYPING_PAUSE_MS);
    await call(0).answer([['id-1']]);

    // One search for the new words; it started after the arrival.
    assert.deepEqual(
      calls.map((one) => one.words),
      [['abc'], ['abcd']],
    );
    await call(1).answer([[]]);
    clock.advance(10_000);
    assert.equal(calls.length, 2);
  });

  it('does not search on an arrival without a searchable word, or after a failure', async () => {
    const { search, clock, calls, call } = harness();

    search.requestsArrived();
    search.setQuery('ab');
    search.requestsArrived();
    clock.advance(10_000);
    assert.equal(calls.length, 0);

    search.setQuery('abc', { immediate: true });
    await call(0).fail(new ApiError(503, ErrorCode.SEARCH_TIMED_OUT, 'slow'));
    search.requestsArrived();
    clock.advance(10_000);
    assert.equal(calls.length, 1);
  });

  it('searches again at once after the list reload of a reconnection', async () => {
    const { search, calls, call } = harness();

    search.listReloaded();
    assert.equal(calls.length, 0);

    search.setQuery('abc', { immediate: true });
    await call(0).answer([[]]);
    search.listReloaded();
    assert.equal(calls.length, 2);

    // During a search: once more when it has answered, and only once.
    search.listReloaded();
    search.listReloaded();
    assert.equal(calls.length, 2);
    await call(1).answer([[]]);
    assert.equal(calls.length, 3);
    await call(2).answer([[]]);
    assert.equal(calls.length, 3);
  });

  it('searches again on a reload after a failure, and takes the notice away for it', async () => {
    const { search, calls, state, call } = harness();

    search.setQuery('abc', { immediate: true });
    await call(0).fail(new Error('offline'));
    assert.equal(state().status, 'not-searched');
    search.listReloaded();
    assert.equal(calls.length, 2);
    assert.deepEqual([state().status, state().reason], ['pending', null]);
  });
});

describe('a search that was not made', () => {
  const failures: [string, unknown, NotSearchedReason][] = [
    ['503 / 1011', new ApiError(503, ErrorCode.SEARCH_TIMED_OUT, 'x'), 'timeout'],
    ['429 / 1012', new ApiError(429, ErrorCode.SEARCH_BUSY, 'x'), 'busy'],
    // A backend still on the image before the route existed.
    ['404 / 1000', new ApiError(404, ErrorCode.ROUTE_NOT_FOUND, 'Not found'), 'failed'],
    ['400 / 1010', new ApiError(400, ErrorCode.INVALID_SEARCH_WORDS, 'x'), 'failed'],
    ['500 / 1500', new ApiError(500, ErrorCode.INTERNAL_ERROR, 'x'), 'failed'],
    ['an answer with no errorCode', new ApiError(502, undefined, 'Request failed'), 'failed'],
    ['a network failure', new TypeError('Failed to fetch'), 'failed'],
  ];

  for (const [description, error, reason] of failures) {
    it(`reads ${description} as ${reason}`, async () => {
      const { search, state, call } = harness();

      assert.equal(classifySearchFailure(error), reason);
      search.setQuery('abc', { immediate: true });
      await call(0).fail(error);
      assert.deepEqual(
        [state().status, state().reason, state().slow],
        ['not-searched', reason, false],
      );
    });
  }

  it('reads an answer that is not one list of ids per word as failed', async () => {
    for (const answer of [
      {},
      { matches: 'none' },
      { matches: [] },
      { matches: [['id-1'], ['id-2']] },
      { matches: [[1]] },
      { matches: ['id-1'] },
      null,
    ]) {
      const states: RawSearchState[] = [];
      const search = createRawSearch({
        timers: fakeTimers().timers,
        onChange: (next) => states.push(next),
        search: () => Promise.resolve(answer as unknown as RequestSearchResult),
      });

      search.setQuery('abc', { immediate: true });
      await settled();
      assert.deepEqual(
        [states.at(-1)?.status, states.at(-1)?.reason, states.at(-1)?.matches.size],
        ['not-searched', 'failed', 0],
        JSON.stringify(answer),
      );
    }
  });

  it('shows only the list-field matches under the notice: what Raw held is dropped', async () => {
    const { search, state, call } = harness();

    search.setQuery('abc', { immediate: true });
    await call(0).answer([['id-1']]);
    search.listReloaded();
    await call(1).fail(new ApiError(429, ErrorCode.SEARCH_BUSY, 'x'));

    assert.equal(state().matches.size, 0);
    assert.deepEqual([state().status, state().reason], ['not-searched', 'busy']);
  });

  it('retries at once, takes the notice away, and puts it back if it fails again', async () => {
    const { search, calls, state, call } = harness();

    search.setQuery('abc', { immediate: true });
    await call(0).fail(new ApiError(503, ErrorCode.SEARCH_TIMED_OUT, 'x'));

    search.retry();
    assert.equal(calls.length, 2);
    assert.deepEqual([state().status, state().reason], ['pending', null]);
    await call(1).fail(new ApiError(429, ErrorCode.SEARCH_BUSY, 'x'));
    assert.deepEqual([state().status, state().reason], ['not-searched', 'busy']);

    search.retry();
    await call(2).answer([['id-1']]);
    assert.deepEqual([state().status, state().reason], ['searched', null]);
    assert.deepEqual(ids(state(), 'abc'), ['id-1']);
  });

  it('has nothing to retry for a query the browser did not send', () => {
    const { search, calls } = harness();

    search.setQuery('a'.repeat(201));
    search.retry();
    search.listReloaded();
    assert.equal(calls.length, 0);
  });

  it('takes the notice away when the query changes', async () => {
    const { search, state, call } = harness();

    search.setQuery('abc', { immediate: true });
    await call(0).fail(new Error('offline'));
    search.setQuery('abcd');
    assert.deepEqual([state().status, state().reason], ['pending', null]);
  });
});

describe('leaving the page', () => {
  it('leaves no timer running and reports nothing more', async () => {
    const { search, clock, states, call } = harness();

    search.setQuery('abc', { immediate: true });
    await call(0).answer([['id-1']]);
    search.requestsArrived();
    search.setQuery('abcd');

    const reported = states.length;

    search.stop();
    assert.equal(clock.pending(), 0);
    clock.advance(10_000);
    search.requestsArrived();
    search.listReloaded();
    search.retry();
    assert.equal(clock.pending(), 0);
    assert.equal(states.length, reported);
  });

  it('reports nothing when a search answers after the page left', async () => {
    const { search, clock, states, call } = harness();

    search.setQuery('abc', { immediate: true });

    const reported = states.length;

    search.stop();
    await call(0).answer([['id-1']]);
    assert.equal(states.length, reported);
    assert.equal(clock.pending(), 0);
  });

  it('starts again with the next query: an effect run twice searches once', async () => {
    const { search, calls, state, call } = harness();

    // React runs a mount effect, its cleanup and the effect again in
    // development: the same query, stopped in between.
    search.setQuery('abc', { immediate: true });
    search.stop();
    search.setQuery('abc', { immediate: true });
    assert.equal(calls.length, 1);

    await call(0).answer([['id-1']]);
    assert.equal(state().status, 'searched');
    assert.deepEqual(ids(state(), 'abc'), ['id-1']);
    assert.equal(calls.length, 1);
  });

  it('searches again when it starts again with nothing in flight', async () => {
    const { search, calls, call } = harness();

    search.setQuery('abc', { immediate: true });
    await call(0).answer([['id-1']]);
    search.stop();
    search.setQuery('abc', { immediate: true });
    assert.equal(calls.length, 2);
  });
});

describe('the texts of the list pane', () => {
  it('are the approved ones', () => {
    assert.equal(FILTER_PLACEHOLDER, 'Search the list, headers and bodies');
    assert.equal(FILTER_PLACEHOLDER_PHONE, 'Search, bodies too');
    assert.equal(SEARCHING_TEXT, 'Searching headers and bodies…');
    assert.equal(SEARCHED_TOO_TEXT, 'Headers and bodies were searched too.');
    assert.equal(NOT_SEARCHED_LEAD, 'Headers and bodies not searched:');
    assert.equal(notSearchedReasonText('timeout'), 'it took over 2 s.');
    assert.equal(notSearchedReasonText('busy'), 'the server is busy.');
    assert.equal(notSearchedReasonText('failed'), 'the search failed.');
    assert.equal(notSearchedReasonText('word-too-long'), 'a word is over 200 bytes.');
    assert.equal(notSearchedReasonText('too-many-words'), 'more than 8 words.');
  });

  it('offer Retry for what another attempt can change, and not for the query’s own limits', () => {
    assert.deepEqual(
      (['timeout', 'busy', 'failed', 'word-too-long', 'too-many-words'] as const).map(
        canRetrySearch,
      ),
      [true, true, true, false, false],
    );
  });
});
