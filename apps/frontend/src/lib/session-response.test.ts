import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ResponseConfig,
  ResponseQueue,
  SessionDetails,
  SessionResponseState,
} from '@webhook-inspector/shared';
import {
  abandonSessionRead,
  applyResponseEvent,
  applyResponseState,
  beginSessionRead,
  DEFAULT_RESPONSE_SUMMARY,
  describeKeptResponse,
  eventsOf,
  formatAppliedToast,
  formatKeptNote,
  formatResponseButtonLabel,
  formatResponseButtonName,
  keptCustomResponse,
  NO_RESPONSE_STATE,
  ownChangeState,
  queueStartedSince,
  recordOwnAnswer,
  recordResponseEvent,
  responseMode,
  responseStateOf,
  sameResponseState,
  SAVED_TOAST,
  settleSessionRead,
  staysOpen,
  type HeldResponseState,
  type ResponseEvent,
} from './session-response.ts';
import { formatQueueRestartedToast, formatQueueSavedToast } from './response-queue.ts';
import { ru } from '../i18n/ru.ts';

function custom(overrides: Partial<ResponseConfig> = {}): ResponseConfig {
  return { status: 200, headers: [], body: null, delayMs: 0, template: false, ...overrides };
}

describe('the Default panel’s summary (D223)', () => {
  it('says the default answers with JSON describing the request, on a line no longer than before', () => {
    assert.equal(DEFAULT_RESPONSE_SUMMARY, '200 OK · JSON describing the request · no delay.');
    assert.equal(ru.response.defaultSummary, '200 OK · JSON с описанием запроса · без задержки.');
    // The panel keeps its one line, drawn for the earlier wording (Decision 3).
    assert.ok(
      DEFAULT_RESPONSE_SUMMARY.length <=
        '200 OK · JSON body with the request ID · no delay.'.length,
    );
    assert.ok(
      ru.response.defaultSummary.length <=
        '200 OK · JSON-тело с идентификатором запроса · без задержки.'.length,
    );
  });
});

describe('formatResponseButtonLabel', () => {
  it('names the default session by its mode and its status', () => {
    assert.equal(formatResponseButtonLabel(null), 'Default · 200');
  });

  it('names a custom session without a delay by its configured status', () => {
    assert.equal(formatResponseButtonLabel(custom({ status: 200 })), 'Custom · 200');
    assert.equal(formatResponseButtonLabel(custom({ status: 204 })), 'Custom · 204');
  });

  it('adds the delay segment only when there is a delay (C1, C3)', () => {
    assert.equal(
      formatResponseButtonLabel(custom({ status: 201, delayMs: 500 })),
      'Custom · 201 · 500 ms',
    );
    assert.equal(formatResponseButtonLabel(custom({ status: 500, delayMs: 0 })), 'Custom · 500');
  });

  it('never presents a custom 200 as the default response', () => {
    const label = formatResponseButtonLabel(custom({ status: 200 }));

    assert.notEqual(label, formatResponseButtonLabel(null));
    assert.ok(label.startsWith('Custom · '));
  });

  it('shows the bare status number rather than its reason phrase', () => {
    for (const label of [
      formatResponseButtonLabel(null),
      formatResponseButtonLabel(custom({ status: 201 })),
    ]) {
      assert.ok(!label.includes('OK'));
      assert.ok(!label.includes('Created'));
    }
  });

  it('gives the button a name that starts with what it shows and says what it opens', () => {
    const response = custom({ status: 201, delayMs: 500 });

    assert.equal(formatResponseButtonName(response), 'Custom · 201 · 500 ms · Response settings');
    assert.ok(formatResponseButtonName(null).startsWith(formatResponseButtonLabel(null)));
  });
});

describe('the mode and the kept custom response (D151)', () => {
  const kept = custom({ status: 201, delayMs: 500 });

  it('reads the mode from the active response alone', () => {
    assert.equal(responseMode({ response: null }), 'default');
    assert.equal(responseMode({ response: kept }), 'custom');
  });

  it('keeps the custom response of a session switched to the default', () => {
    assert.equal(keptCustomResponse({ response: null, customResponse: kept }), kept);
    assert.equal(keptCustomResponse({ response: null, customResponse: null }), null);
  });

  it('reads the active response when a backend from before D151 sends no customResponse', () => {
    assert.equal(keptCustomResponse({ response: kept }), kept);
    assert.equal(keptCustomResponse({ response: null }), null);
  });
});

describe('describeKeptResponse', () => {
  it('says every part of the kept response, as C4 draws it', () => {
    assert.equal(
      describeKeptResponse(
        custom({ status: 201, delayMs: 500, headers: [['x-trace-id', 'abc']], body: '{}' }),
      ),
      '201 · 500 ms · 1 header · body',
    );
  });

  it('names what is absent rather than leaving it out', () => {
    assert.equal(
      describeKeptResponse(custom({ status: 503 })),
      '503 · no delay · no headers · no body',
    );
    assert.equal(
      describeKeptResponse(
        custom({
          headers: [
            ['a', '1'],
            ['b', '2'],
          ],
        }),
      ),
      '200 · no delay · 2 headers · no body',
    );
  });

  it('puts it in the sentence that says it comes back (C4)', () => {
    assert.equal(
      formatKeptNote(custom({ status: 201, delayMs: 500, headers: [['a', '1']], body: '{}' })),
      'Your custom response stays saved — 201 · 500 ms · 1 header · body — and comes back when you switch to Custom.',
    );
  });
});

describe('the toasts', () => {
  it('states what a quick change configured, as C3 words it', () => {
    assert.equal(
      formatAppliedToast(custom({ status: 500 })),
      'Response is now 500, no delay. Requests captured from now on get it.',
    );
    assert.equal(
      formatAppliedToast(custom({ status: 201, delayMs: 2000 })),
      'Response is now 201, a 2000 ms delay. Requests captured from now on get it.',
    );
    assert.equal(
      formatAppliedToast(null),
      'Response is now the default 200, no delay. Requests captured from now on get it.',
    );
  });

  it('never words a change as something a sender received (D103)', () => {
    for (const text of [
      formatAppliedToast(null),
      formatAppliedToast(custom({ status: 201, delayMs: 500 })),
      SAVED_TOAST,
    ]) {
      assert.doesNotMatch(text, /deliver|received|sent/i, text);
    }
  });
});

describe('applyResponseState', () => {
  const session: SessionDetails = {
    id: 'a'.repeat(43),
    expiresAt: '2026-10-01T00:00:00.000Z',
    receiveUrl: `https://hook.qa-tools.ru/s/${'a'.repeat(43)}`,
    requestsCount: 3,
    expiresAfterIdleSeconds: 604_800,
    lifetimeEndsAt: null,
    storeSourceIp: true,
    private: false,
    response: custom({ status: 201 }),
    customResponse: custom({ status: 201 }),
    queue: null,
    rules: [],
  };

  it('replaces both fields and leaves everything else as it was', () => {
    const next = applyResponseState(session, {
      response: null,
      customResponse: custom({ status: 201 }),
      queue: null,
      rules: [],
    });

    assert.deepEqual(next, { ...session, response: null });
  });

  it('changes nothing when the same state arrives twice (D136, D152)', () => {
    const state = {
      response: custom({ status: 500 }),
      customResponse: custom({ status: 500 }),
      queue: null,
      rules: [],
    };
    const once = applyResponseState(session, state);

    assert.deepEqual(applyResponseState(once, state), once);
  });

  it('holds no session where the page held none', () => {
    assert.equal(
      applyResponseState(null, { response: null, customResponse: null, queue: null, rules: [] }),
      null,
    );
  });

  it('replaces the rules with the state’s, none included (D246)', () => {
    const held = { ...session, rules: [RULE] };

    assert.deepEqual(
      applyResponseState(session, { ...responseStateOf(session), rules: [RULE] }),
      held,
    );
    assert.deepEqual(applyResponseState(held, { ...responseStateOf(held), rules: [] }), session);
  });

  it('keeps the rules it holds for a state without them, from a backend before 1.3.0 (D246)', () => {
    const held = { ...session, rules: [RULE] };
    const older = {
      response: null,
      customResponse: null,
      queue: null,
    } as unknown as SessionResponseState;

    assert.deepEqual(applyResponseState(held, older), {
      ...held,
      response: null,
      customResponse: null,
    });
    // Unknown, not none: the state carries no `rules` at all (#226).
    assert.equal('rules' in responseStateOf(older), false);
    assert.deepEqual(responseStateOf({ ...older, rules: [] }).rules, []);
  });
});

/** A response rule, as a session holds it (D246). */
const RULE = {
  method: 'POST',
  path: '/orders',
  response: { status: 201, headers: [], body: '{"id":42}', delayMs: 0, template: false },
};

const PAGE: SessionDetails = {
  id: 'a'.repeat(43),
  expiresAt: '2026-10-01T00:00:00.000Z',
  receiveUrl: `https://hook.qa-tools.ru/s/${'a'.repeat(43)}`,
  requestsCount: 3,
  expiresAfterIdleSeconds: 604_800,
  lifetimeEndsAt: null,
  storeSourceIp: true,
  private: false,
  response: null,
  customResponse: null,
  queue: null,
  rules: [],
};

function steps(...statuses: number[]): ResponseConfig[] {
  return statuses.map((status) => custom({ status }));
}

function queueOf(list: ResponseConfig[], next: number | null): ResponseQueue {
  return { steps: list, next, total: list.length };
}

/** The page once it has applied a first read of `session`, with no read in flight. */
function showing(session: SessionDetails): HeldResponseState {
  const begun = beginSessionRead(NO_RESPONSE_STATE);

  return settleSessionRead(begun.held, begun.order, session).held;
}

/** `request.received` naming the step a capture took. */
function stepOf(index: number, total: number): ResponseEvent {
  return { type: 'step', step: { index, total } };
}

const CLEARED: ResponseEvent = { type: 'cleared' };

function updated(state: SessionResponseState): ResponseEvent {
  return { type: 'updated', state };
}

/** Events taken one after another, as the socket brings them. */
function taking(held: HeldResponseState, ...events: ResponseEvent[]): HeldResponseState {
  return events.reduce(recordResponseEvent, held);
}

/**
 * A session read and what the socket brings while it is in flight (D152,
 * D205). The page reads its session on mount and on every `ready`, and the
 * read may have been taken by the server before or after any event that
 * arrives meanwhile; it is applied with those events on top, in the order
 * they arrived. It is not set aside because a capture or a clear moved the
 * page's queue meanwhile: that would keep state another client had replaced
 * while the socket was down.
 */
describe('a session read and the events taken while it was in flight', () => {
  const OLD = steps(503, 503, 503);
  const NEW = steps(429, 418, 451);

  it('takes a read whole when nothing arrived while it was in flight', () => {
    const begun = beginSessionRead(NO_RESPONSE_STATE);
    const read = { ...PAGE, response: custom({ status: 201 }) };
    const settled = settleSessionRead(begun.held, begun.order, read);

    assert.equal(settled.shown, read);
    assert.deepEqual(settled.held, {
      state: responseStateOf(read),
      revision: 1,
      reads: [],
      begun: 1,
      newestApplied: 1,
      lastUpdated: null,
      queueStartedAt: null,
    });
    // Only the response state is held, never the rest of the session; a
    // backend from before 0.46.0 sends no queue, held as none.
    const older = { ...PAGE, queue: undefined } as unknown as SessionDetails;

    assert.equal(showing(older).state?.queue, null);
  });

  it('brings a read forward by a session.updated taken meanwhile, and leaves one that holds it as it is', () => {
    const page = showing(PAGE);
    const begun = beginSessionRead(page);
    const changed = {
      response: custom({ status: 500 }),
      customResponse: custom({ status: 500 }),
      queue: null,
      rules: [],
    };
    const during = taking(begun.held, updated(changed));

    // Shown at once, before the read answers.
    assert.deepEqual(during.state, changed);

    // Taken by the server before the change.
    const before = settleSessionRead(during, begun.order, PAGE);

    assert.deepEqual(before.shown, { ...PAGE, ...changed });
    // Taken after: it already holds it.
    const after = settleSessionRead(during, begun.order, { ...PAGE, ...changed, requestsCount: 4 });

    assert.deepEqual(after.shown, { ...PAGE, ...changed, requestsCount: 4 });
    assert.deepEqual(after.held.state, changed);
  });

  /** R1: the page holds a queue; another client saves one of the same length while its socket is down. */
  it('takes a queue saved elsewhere with the step a capture took during the read, the read answered before the capture or after', () => {
    const page = showing({ ...PAGE, queue: queueOf(OLD, 1) });
    const begun = beginSessionRead(page);
    const during = taking(begun.held, stepOf(1, 3));

    // Meanwhile the capture moves the queue the page shows.
    assert.deepEqual(during.state?.queue, queueOf(OLD, 2));

    const early = settleSessionRead(during, begun.order, { ...PAGE, queue: queueOf(NEW, 1) });
    const late = settleSessionRead(during, begun.order, { ...PAGE, queue: queueOf(NEW, 2) });

    for (const settled of [early, late]) {
      assert.deepEqual(settled.shown?.queue, queueOf(NEW, 2));
      assert.deepEqual(settled.held.state?.queue, queueOf(NEW, 2));
    }

    // Later captures move the queue the read brought.
    assert.deepEqual(taking(early.held, stepOf(2, 3)).state?.queue, queueOf(NEW, 3));
    assert.deepEqual(
      taking(early.held, stepOf(2, 3), stepOf(3, 3)).state?.queue,
      queueOf(NEW, null),
    );
  });

  /** R1b: the page holds a queue; another client changes the session response while its socket is down. */
  it('takes a response changed elsewhere when a capture moved the page’s queue during the read', () => {
    const page = showing({ ...PAGE, queue: queueOf(OLD, 1) });
    const begun = beginSessionRead(page);
    const during = taking(begun.held, stepOf(1, 3));
    const changed = {
      ...PAGE,
      response: custom({ status: 201 }),
      customResponse: custom({ status: 201 }),
    };
    const settled = settleSessionRead(during, begun.order, { ...changed, queue: queueOf(OLD, 2) });

    assert.equal(settled.shown?.response?.status, 201);
    assert.equal(
      formatResponseButtonLabel(settled.shown?.response ?? null, settled.shown?.queue),
      'Custom · 201 · 2 queued',
    );
  });

  /** R1c: a clear during the read, the page's queue not at step 1, the response changed elsewhere. */
  it('takes a response changed elsewhere when a clear moved the page’s queue during the read, and starts the queue from step 1', () => {
    const page = showing({ ...PAGE, queue: queueOf(OLD, 2) });
    const begun = beginSessionRead(page);
    const during = taking(begun.held, CLEARED);
    const changed = {
      ...PAGE,
      response: custom({ status: 202 }),
      customResponse: custom({ status: 202 }),
    };

    assert.deepEqual(during.state?.queue, queueOf(OLD, 1));

    // Read after the clear, and before it.
    for (const next of [1, 2]) {
      const settled = settleSessionRead(during, begun.order, {
        ...changed,
        queue: queueOf(OLD, next),
        rules: [],
      });

      assert.equal(settled.shown?.response?.status, 202);
      assert.equal(settled.shown?.queue?.next, 1);
    }
  });

  /** The page holds no queue; another client saves one. */
  it('takes a queue the page did not hold with the step a capture took during the read, one step queue included', () => {
    const page = showing(PAGE);
    const begun = beginSessionRead(page);
    const during = taking(begun.held, stepOf(1, 3));

    // Nothing on the page to move.
    assert.equal(during.state, page.state);
    assert.equal(during.revision, page.revision);

    assert.deepEqual(
      settleSessionRead(during, begun.order, { ...PAGE, queue: queueOf(NEW, 1) }).shown?.queue,
      queueOf(NEW, 2),
    );
    assert.deepEqual(
      settleSessionRead(during, begun.order, { ...PAGE, queue: queueOf(NEW, 2) }).shown?.queue,
      queueOf(NEW, 2),
    );

    // R2: a one-step queue whose only step the capture took.
    const one = beginSessionRead(page);
    const settled = settleSessionRead(taking(one.held, stepOf(1, 1)), one.order, {
      ...PAGE,
      queue: queueOf(steps(503), 1),
      rules: [],
    });

    assert.equal(settled.shown?.queue?.next, null);
    assert.equal(formatResponseButtonLabel(null, settled.shown?.queue), 'Default · 200');
  });

  it('applies the events in the order they arrived: a step of the old queue, its replacement, a step of the new one', () => {
    const page = showing({ ...PAGE, queue: queueOf(OLD, 1) });
    const begun = beginSessionRead(page);
    const replaced = { ...responseStateOf(PAGE), queue: queueOf(NEW, 1) };
    const during = taking(
      begun.held,
      stepOf(1, 3),
      updated(replaced),
      stepOf(1, 3),
      CLEARED,
      stepOf(1, 3),
    );
    const settled = settleSessionRead(during, begun.order, { ...PAGE, queue: queueOf(OLD, 2) });

    assert.deepEqual(settled.shown?.queue, queueOf(NEW, 2));
    assert.deepEqual(during.state?.queue, queueOf(NEW, 2));
  });

  it('keeps a session.updated alone in a read’s log, the events before it no longer mattering', () => {
    const page = showing({ ...PAGE, queue: queueOf(OLD, 1) });
    const begun = beginSessionRead(page);
    const replaced = { ...responseStateOf(PAGE), queue: queueOf(NEW, 1) };
    const during = taking(begun.held, stepOf(1, 3), CLEARED, updated(replaced), stepOf(1, 3));

    assert.deepEqual(
      during.reads.map((read) => ({ order: read.order, events: eventsOf(read.log) })),
      [{ order: begun.order, events: [updated(replaced), stepOf(1, 3)] }],
    );
  });

  it('applies an event that arrives after the read was applied as it arrives, and records nothing that changes nothing', () => {
    const page = showing({ ...PAGE, queue: queueOf(OLD, 1) });

    // No read in flight: a step of another queue, a request the session
    // response answered, a clear of a queue at step 1.
    assert.equal(recordResponseEvent(page, stepOf(1, 2)), page);
    assert.equal(recordResponseEvent(page, CLEARED), page);

    const moved = recordResponseEvent(page, stepOf(1, 3));

    assert.equal(moved.state?.queue?.next, 2);
    assert.equal(moved.revision, page.revision + 1);
    // A session.updated always counts, the same state included.
    assert.equal(
      recordResponseEvent(moved, updated(moved.state as SessionResponseState)).revision,
      moved.revision + 1,
    );
  });

  it('keeps the events taken before the page holds any state for the read on mount', () => {
    const begun = beginSessionRead(NO_RESPONSE_STATE);
    const changed = { ...responseStateOf(PAGE), queue: queueOf(NEW, 1) };
    const during = taking(begun.held, updated(changed), stepOf(1, 3));

    assert.equal(during.state, null);

    const settled = settleSessionRead(during, begun.order, PAGE);

    assert.deepEqual(settled.shown, { ...PAGE, queue: queueOf(NEW, 2) });
  });

  /** On mount the page reads its session and the socket's first `ready` reads it again. */
  it('does not let one of two reads in flight undo the other', () => {
    const page = showing(PAGE);
    const first = beginSessionRead(page);
    const second = beginSessionRead(first.held);
    const during = taking(
      second.held,
      updated({ ...responseStateOf(PAGE), queue: queueOf(NEW, 1) }),
    );
    const newer = { ...PAGE, requestsCount: 5, queue: queueOf(NEW, 1) };

    // The later one answers first; the earlier one, answering after, is
    // older than what the page shows and is not applied at all.
    const later = settleSessionRead(during, second.order, newer);
    const earlier = settleSessionRead(taking(later.held, stepOf(1, 3)), first.order, PAGE);

    assert.deepEqual(later.shown, newer);
    assert.equal(earlier.shown, null);
    assert.deepEqual(earlier.held.state?.queue, queueOf(NEW, 2));
    assert.deepEqual(earlier.held.reads, []);

    // The earlier one answers first, then the later one, each with what
    // arrived since it began.
    const a = settleSessionRead(during, first.order, PAGE);
    const b = settleSessionRead(taking(a.held, stepOf(1, 3)), second.order, newer);

    assert.deepEqual(a.shown?.queue, queueOf(NEW, 1));
    assert.deepEqual(b.shown, { ...newer, queue: queueOf(NEW, 2) });
    assert.equal(b.held.newestApplied, second.order);
  });

  it('forgets a read abandoned, and applies no read it was not given', () => {
    const page = showing(PAGE);
    const begun = beginSessionRead(page);
    const abandoned = abandonSessionRead(taking(begun.held, stepOf(1, 3)), begun.order);

    assert.deepEqual(abandoned.reads, []);
    assert.equal(settleSessionRead(abandoned, begun.order, PAGE).shown, null);
    assert.equal(settleSessionRead(page, 99, PAGE).shown, null);
  });
});

/**
 * The answer to this viewer's own call against what the socket brought while
 * it was in flight. The change's `session.updated` is published before its
 * answer is written, on another connection, and a capture can follow it.
 */
describe('recordOwnAnswer', () => {
  const page: SessionDetails = {
    id: 'b'.repeat(43),
    expiresAt: '2026-10-01T00:00:00.000Z',
    receiveUrl: `https://hook.qa-tools.ru/s/${'b'.repeat(43)}`,
    requestsCount: 0,
    expiresAfterIdleSeconds: 604_800,
    lifetimeEndsAt: null,
    storeSourceIp: true,
    private: false,
    response: custom({ status: 200 }),
    customResponse: custom({ status: 200 }),
    queue: null,
    rules: [],
  };
  const step = custom({ status: 503 });
  const oneStep = { ...responseStateOf(page), queue: { steps: [step], next: 1, total: 1 } };

  it('takes an answer that arrives before anything newer, and the event after it changes nothing', () => {
    const shown = showing(page);
    const startedAt = shown.revision;
    const answered = recordOwnAnswer(shown, oneStep, startedAt);

    assert.deepEqual(answered, { ...shown, revision: shown.revision + 1, state: oneStep });
    assert.deepEqual(recordResponseEvent(answered, updated(oneStep)).state, oneStep);
  });

  it('sets aside a save’s answer that arrives after its event and a capture taking the step: Done stays Done', () => {
    const shown = showing(page);
    const startedAt = shown.revision;
    const event = taking(shown, updated(oneStep));
    const captured = taking(event, stepOf(1, 1));

    assert.equal(captured.state?.queue?.next, null);
    assert.equal(recordOwnAnswer(captured, oneStep, startedAt), captured);
    assert.equal(recordOwnAnswer(event, oneStep, startedAt), event);
  });

  it('sets aside a restart’s answer that arrives after its event and a capture', () => {
    const usedUp = { ...oneStep, queue: { ...oneStep.queue, next: null } };
    const shown = showing({ ...page, ...usedUp });
    const startedAt = shown.revision;
    const captured = taking(shown, updated(oneStep), stepOf(1, 1));

    assert.equal(recordOwnAnswer(captured, oneStep, startedAt).state?.queue?.next, null);
  });

  it('sets aside a response change’s answer, which carries the queue too, after its event and a capture', () => {
    const twoSteps = { ...oneStep, queue: { steps: [step, step], next: 1, total: 2 } };
    const shown = showing({ ...page, ...twoSteps });
    const startedAt = shown.revision;
    const changed = { ...twoSteps, response: custom({ status: 201 }) };
    const captured = taking(shown, updated(changed), stepOf(1, 2));
    const held = recordOwnAnswer(captured, changed, startedAt);

    assert.equal(held, captured);
    assert.equal(held.state?.response?.status, 201);
    assert.equal(held.state?.queue?.next, 2);
  });

  it('sets aside a removal’s answer after its event, and another viewer’s later save stays', () => {
    const shown = showing({ ...page, ...oneStep });
    const startedAt = shown.revision;
    const removed = responseStateOf(page);
    const savedElsewhere = { ...oneStep, queue: { steps: [step, step], next: 1, total: 2 } };
    const later = taking(shown, updated(removed), updated(savedElsewhere));

    assert.equal(recordOwnAnswer(later, removed, startedAt), later);
    assert.equal(later.state?.queue?.total, 2);
  });

  it('takes an answer when nothing arrived meanwhile, a capture that changed nothing included', () => {
    const shown = showing(page);
    const startedAt = shown.revision;
    // A step of a queue the page does not hold: nothing taken.
    const ignored = taking(shown, stepOf(1, 3));

    assert.deepEqual(recordOwnAnswer(ignored, oneStep, startedAt), {
      ...shown,
      revision: shown.revision + 1,
      state: oneStep,
    });
  });

  /**
   * A read taken while the call is in flight may already hold the change and
   * a capture after it: a page whose socket dropped and came back reads the
   * session on its `ready`, and the change's event was published before the
   * socket returned.
   */
  it('sets aside an answer that arrives after a read taken meanwhile, which already holds the change and a capture', () => {
    const shown = showing(page);
    const startedAt = shown.revision;
    const usedUp = { ...page, ...oneStep, queue: { ...oneStep.queue, next: null } };
    const begun = beginSessionRead(shown);
    const read = settleSessionRead(begun.held, begun.order, usedUp).held;

    assert.equal(read.revision, shown.revision + 1);
    assert.equal(recordOwnAnswer(read, oneStep, startedAt), read);
    assert.equal(read.state?.queue?.next, null);
  });

  /**
   * An answer taken while a read is in flight is not kept by the read: the
   * change's own event, which the read keeps, says the same in its place
   * among the events, so a capture after it is not undone by a replay.
   */
  it('keeps no answer for a read in flight; the change’s event and a capture after it are replayed on the read', () => {
    const shown = showing(page);
    const begun = beginSessionRead(shown);
    const startedAt = begun.held.revision;
    const answered = recordOwnAnswer(begun.held, oneStep, startedAt);

    assert.deepEqual(answered.state, oneStep);
    assert.deepEqual(answered.reads, [{ order: begun.order, log: null, rules: undefined }]);

    const after = taking(answered, updated(oneStep), stepOf(1, 1));
    // Read by the server before the save committed.
    const settled = settleSessionRead(after, begun.order, page);

    assert.equal(settled.shown?.queue?.next, null);
    assert.equal(
      formatResponseButtonLabel(settled.shown?.response ?? null, settled.shown?.queue),
      'Custom · 200',
    );
  });
});

/**
 * The state the toast about the viewer's own save or `Run again` is worded from
 * (frames U6 and U9 of the Figma page `Webhook Inspector · Response queue
 * (#106) — chosen, review 2`). A capture can take step 1 after the change's
 * event and before its answer, which is then set aside, and a toast worded from
 * the answer would promise both steps beside `Step 2 of 2`. An answer set aside
 * for an event from before the change, whose own event then arrives after it,
 * must not have the toast describe the state before the change - G9, G10.
 */
describe('ownChangeState', () => {
  const OLD = steps(500, 501, 502);
  const SAVED = steps(418, 501, 502);
  const TWO = steps(503, 503);
  const defaultWith = (queue: ResponseQueue | null): SessionResponseState => ({
    ...responseStateOf(PAGE),
    queue,
  });

  /** G9: a capture of the queue being replaced arrives before the save commits; its answer before its event. */
  it('words a save from its answer when a capture of the old queue set the answer aside and its own event comes after it', () => {
    const shown = showing({ ...PAGE, queue: queueOf(OLD, 1) });
    const startedAt = shown.revision;
    const captured = taking(shown, stepOf(1, 3));
    const answer = defaultWith(queueOf(SAVED, 1));

    assert.equal(recordOwnAnswer(captured, answer, startedAt), captured);
    assert.deepEqual(ownChangeState(captured, answer, startedAt), answer);
    assert.equal(
      formatQueueSavedToast(ownChangeState(captured, answer, startedAt)),
      'Queue saved. The next 3 requests get 418, 501 and 502, then the default response.',
    );
    // The page meanwhile shows the old queue, until the save's own event.
    assert.equal(
      formatResponseButtonLabel(null, captured.state?.queue),
      'Default · 200 · 2 queued',
    );
    assert.equal(
      formatResponseButtonLabel(null, taking(captured, updated(answer)).state?.queue),
      'Default · 200 · 3 queued',
    );
  });

  /** G10: another viewer's response change arrives during Run again; the answer before its own event. */
  it('words a restart from its answer when another viewer’s change set the answer aside and its own event comes after it', () => {
    const usedUp = defaultWith(queueOf(TWO, null));
    const shown = showing({ ...PAGE, ...usedUp });
    const startedAt = shown.revision;
    const custom201 = custom({ status: 201 });
    const elsewhere = { ...usedUp, response: custom201, customResponse: custom201 };
    const changed = taking(shown, updated(elsewhere));
    const answer = { ...elsewhere, queue: queueOf(TWO, 1) };

    assert.equal(recordOwnAnswer(changed, answer, startedAt), changed);
    assert.equal(
      formatQueueRestartedToast(ownChangeState(changed, answer, startedAt)),
      'The queue starts again from step 1. The next 2 requests get 503.',
    );
    assert.equal(
      formatResponseButtonLabel(custom201, taking(changed, updated(answer)).state?.queue),
      'Custom · 201 · 2 queued',
    );
    // The other viewer's change, then the restart's own event, then its
    // answer: the page holds the restart, and says what it shows.
    const both = taking(changed, updated(answer));

    assert.equal(
      formatQueueRestartedToast(ownChangeState(both, answer, startedAt)),
      'The queue starts again from step 1. The next 2 requests get 503.',
    );
    assert.equal(
      formatQueueRestartedToast(ownChangeState(taking(both, stepOf(1, 2)), answer, startedAt)),
      'The queue started again from step 1. The next request gets 503.',
    );
  });

  it('words an answer taken from itself: nothing arrived during the call (G1, G5)', () => {
    const shown = showing(PAGE);
    const startedAt = shown.revision;
    const answer = defaultWith(queueOf(TWO, 1));

    assert.deepEqual(ownChangeState(shown, answer, startedAt), answer);
    assert.equal(
      formatQueueSavedToast(ownChangeState(shown, answer, startedAt)),
      'Queue saved. The next 2 requests get 503, then the default response.',
    );
    // A step of a queue the page does not hold is nothing taken.
    assert.deepEqual(ownChangeState(taking(shown, stepOf(1, 3)), answer, startedAt), answer);
  });

  it('words an answer set aside after its own event from what the page shows, with the captures after it (G2, G3, G4, G7, G8)', () => {
    const shown = showing(PAGE);
    const startedAt = shown.revision;
    const answer = defaultWith(queueOf(TWO, 1));
    const event = taking(shown, updated(answer));

    // The usual order: the event, then the answer.
    assert.equal(
      formatQueueSavedToast(ownChangeState(event, answer, startedAt)),
      'Queue saved. The next 2 requests get 503, then the default response.',
    );
    assert.equal(
      formatQueueSavedToast(ownChangeState(taking(event, stepOf(1, 2)), answer, startedAt)),
      'Queue saved. The next request gets 503, then the default response.',
    );
    assert.equal(
      formatQueueSavedToast(
        ownChangeState(taking(event, stepOf(1, 2), stepOf(2, 2)), answer, startedAt),
      ),
      'Queue saved, and every step has already answered a request; the next requests get the default response.',
    );

    // Run again of a used-up one-step queue, its event and a capture first.
    const one = defaultWith(queueOf(steps(503), null));
    const usedUp = showing({ ...PAGE, ...one });
    const restarted = defaultWith(queueOf(steps(503), 1));

    assert.equal(
      formatQueueRestartedToast(
        ownChangeState(
          taking(usedUp, updated(restarted), stepOf(1, 1)),
          restarted,
          usedUp.revision,
        ),
      ),
      'The queue started again from step 1, and every step has already answered a request; the next requests get the default response.',
    );
  });

  it('keeps the page’s state through a read applied after the own event', () => {
    const shown = showing(PAGE);
    const startedAt = shown.revision;
    const answer = defaultWith(queueOf(TWO, 1));
    const begun = beginSessionRead(shown);
    const during = taking(begun.held, updated(answer), stepOf(1, 2));
    const settled = settleSessionRead(during, begun.order, PAGE).held;

    assert.equal(
      formatQueueSavedToast(ownChangeState(settled, answer, startedAt)),
      'Queue saved. The next request gets 503, then the default response.',
    );
  });

  it('does not take an event from before the call that says the same for the call’s own', () => {
    // The same queue saved again: its earlier save's event was taken before
    // this call started, and a capture of it arrives during the call.
    const answer = defaultWith(queueOf(TWO, 1));
    const before = taking(showing(PAGE), updated(answer));
    const startedAt = before.revision;
    const captured = taking(before, stepOf(1, 2));

    assert.deepEqual(ownChangeState(captured, answer, startedAt), answer);
  });

  it('words the answer when another viewer’s change came after the own event: what this viewer’s call did', () => {
    const shown = showing(PAGE);
    const startedAt = shown.revision;
    const answer = defaultWith(queueOf(TWO, 1));
    const removedElsewhere = taking(shown, updated(answer), updated(defaultWith(null)));

    assert.equal(removedElsewhere.state?.queue, null);
    assert.equal(
      formatQueueSavedToast(ownChangeState(removedElsewhere, answer, startedAt)),
      'Queue saved. The next 2 requests get 503, then the default response.',
    );
  });
});

/**
 * Whether the queue was started from step 1 since a call started (D205): what
 * a failed `Run again` asks before it says so.
 */
describe('queueStartedSince', () => {
  const usedUp = { ...PAGE, queue: queueOf(steps(503), null) };
  const restarted = { ...responseStateOf(usedUp), queue: queueOf(steps(503), 1) };

  it('is true once a Run again’s own event arrived, though a capture then used the one step up again (N1, L3)', () => {
    const shown = showing(usedUp);
    const startedAt = shown.revision;
    const held = taking(shown, updated(restarted), stepOf(1, 1));

    // Done again: the section offers Run again once more.
    assert.equal(held.state?.queue?.next, null);
    assert.equal(queueStartedSince(held, startedAt), true);
  });

  it('is false when nothing arrived during the call: a refused restart, or one whose answer was lost before its event (R, L2)', () => {
    const shown = showing(usedUp);

    assert.equal(queueStartedSince(shown, shown.revision), false);
  });

  it('is false for a change during the call that leaves the queue used up, and for a capture or a clear', () => {
    const shown = showing({ ...usedUp, queue: queueOf(steps(503, 504), null) });
    const startedAt = shown.revision;
    const changed = { ...responseStateOf(usedUp), response: custom({ status: 201 }) };

    assert.equal(queueStartedSince(taking(shown, updated(changed)), startedAt), false);
    // A clear starts the queue from step 1 as well, but publishes no state:
    // the section then shows Step 1 and offers no Run again to fail beside.
    assert.equal(queueStartedSince(taking(shown, CLEARED, stepOf(1, 2)), startedAt), false);
  });

  it('is true for another viewer’s save or restart during the call', () => {
    const shown = showing(usedUp);
    const startedAt = shown.revision;
    const saved = { ...responseStateOf(usedUp), queue: queueOf(steps(418), 1) };

    assert.equal(queueStartedSince(taking(shown, updated(saved)), startedAt), true);
    assert.equal(queueStartedSince(taking(shown, updated(restarted)), startedAt), true);
  });

  it('counts only what arrived after the call started, and keeps it through a read applied after it', () => {
    const before = taking(showing(usedUp), updated(restarted), stepOf(1, 1));

    assert.equal(queueStartedSince(before, before.revision), false);

    const startedAt = before.revision;
    const during = taking(before, updated(restarted), stepOf(1, 1));
    const begun = beginSessionRead(during);
    const read = settleSessionRead(begun.held, begun.order, usedUp).held;

    assert.equal(queueStartedSince(read, startedAt), true);
  });
});

describe('sameResponseState', () => {
  it('tells rules apart by their method, path and response, and not when a state lacks them (D246)', () => {
    const held = { ...responseStateOf(PAGE), rules: [RULE] };

    for (const rule of [
      { ...RULE, method: null },
      { ...RULE, method: 'PUT' },
      { ...RULE, path: '/orders/*' },
      { ...RULE, response: { ...RULE.response, status: 202 } },
      { ...RULE, response: { ...RULE.response, body: null } },
    ]) {
      assert.equal(
        sameResponseState(held, { ...held, rules: [rule] }),
        false,
        JSON.stringify(rule),
      );
    }

    assert.equal(sameResponseState(held, structuredClone(held)), true);
    assert.equal(
      sameResponseState(held, {
        ...held,
        rules: undefined,
      } as unknown as SessionResponseState),
      true,
    );
  });

  const base: SessionResponseState = {
    response: custom({ status: 201, headers: [['X-A', '1']], body: 'x', delayMs: 5 }),
    customResponse: custom({ status: 201, headers: [['X-A', '1']], body: 'x', delayMs: 5 }),
    queue: queueOf(steps(503, 429), 1),
    rules: [],
  };

  it('says two states that carry the same values are the same, whatever objects carry them', () => {
    assert.equal(sameResponseState(base, structuredClone(base)), true);
    assert.equal(
      sameResponseState(
        { ...responseStateOf(PAGE), queue: undefined } as unknown as SessionResponseState,
        responseStateOf(PAGE),
      ),
      true,
    );
  });

  it('tells apart every field: status, delay, body, a header, the kept response, a step, next, none', () => {
    const differing: SessionResponseState[] = [
      { ...base, response: custom({ ...base.response, status: 202 }) },
      { ...base, response: custom({ ...base.response, delayMs: 6 }) },
      { ...base, response: custom({ ...base.response, body: null }) },
      { ...base, response: custom({ ...base.response, headers: [['X-A', '2']] }) },
      { ...base, response: custom({ ...base.response, headers: [['X-B', '1']] }) },
      { ...base, response: custom({ ...base.response, headers: [] }) },
      { ...base, response: null },
      { ...base, customResponse: null },
      { ...base, queue: queueOf(steps(503, 418), 1) },
      { ...base, queue: queueOf(steps(503, 429), 2) },
      { ...base, queue: queueOf(steps(503, 429), null) },
      { ...base, queue: queueOf(steps(503, 429, 200), 1) },
      { ...base, queue: null },
      // The rules (D246): one more, its method, its path, its response.
      { ...base, rules: [RULE] },
      { ...base, rules: [RULE, RULE] },
    ];

    for (const other of differing) {
      assert.equal(sameResponseState(base, other), false, JSON.stringify(other));
      assert.equal(sameResponseState(other, base), false, JSON.stringify(other));
    }
  });

  it('tells apart a template from the same body sent as configured, wherever it is held (D251)', () => {
    const template = (config: ResponseConfig | null): ResponseConfig | null =>
      config === null ? null : { ...config, template: true };
    const held: SessionResponseState = { ...base, rules: [RULE] };
    const differing: SessionResponseState[] = [
      { ...held, response: template(held.response) },
      { ...held, customResponse: template(held.customResponse) },
      {
        ...held,
        queue: queueOf(
          steps(503, 429).map((step, index) => (index === 1 ? { ...step, template: true } : step)),
          1,
        ),
      },
      { ...held, rules: [{ ...RULE, response: { ...RULE.response, template: true } }] },
    ];

    for (const other of differing) {
      assert.equal(sameResponseState(held, other), false, JSON.stringify(other));
      assert.equal(sameResponseState(other, held), false, JSON.stringify(other));
    }

    // A response from a backend before 1.9.0 carries no flag: no template.
    const older: Partial<ResponseConfig> = { ...(held.response as ResponseConfig) };

    delete older.template;

    assert.equal(sameResponseState(held, { ...held, response: older as ResponseConfig }), true);
  });
});

/**
 * A read's log at growing sizes: every event taken while a read is in flight
 * was appended to a copy of the whole log, so a burst of 16,000 took about
 * 90 ms where 1,000 took 1. Now each event shares the log before it: none is
 * copied, at any size, and a `session.updated` still starts the log afresh.
 */
describe('a read’s log at growing sizes', () => {
  const QUEUE = queueOf(steps(503, 429, 418), 1);
  const REPLACED = updated({ ...responseStateOf(PAGE), queue: QUEUE });
  const cycle: ResponseEvent[] = [stepOf(1, 3), stepOf(2, 3), CLEARED, stepOf(9, 9)];

  for (const size of [1_000, 4_000, 16_000]) {
    it(`appends each of ${size} events without copying the log before it`, () => {
      const begun = beginSessionRead(showing({ ...PAGE, queue: queueOf(steps(503, 429, 418), 2) }));
      let held = begun.held;
      let copied = 0;

      for (let index = 0; index < size; index += 1) {
        const before = held.reads[0]?.log ?? null;

        held = recordResponseEvent(held, cycle[index % cycle.length] as ResponseEvent);

        if (held.reads[0]?.log?.earlier !== before) {
          copied += 1;
        }
      }

      assert.equal(copied, 0);
      assert.equal(eventsOf(held.reads[0]?.log ?? null).length, size);

      // The replay ends where the events say: the last of each cycle is a
      // step of a queue of another length, which changes nothing.
      const settled = settleSessionRead(held, begun.order, { ...PAGE, queue: QUEUE });

      assert.equal(settled.shown?.queue?.next, 1);

      // A session.updated starts the log afresh, and what follows it is kept.
      const replaced = taking(held, REPLACED, stepOf(1, 3));

      assert.deepEqual(eventsOf(replaced.reads[0]?.log ?? null), [REPLACED, stepOf(1, 3)]);
    });
  }
});

/**
 * A `session.updated`, a read and an answer from a backend before 1.3.0 -
 * the previous image during a rolling update or after a rollback - carry no
 * `rules` (D221, D246). Each is taken here as the page takes it, so the
 * rules shown stay as they are, and one that carries `rules: []` clears them
 * (issue #226, after #134: `responseStateOf` read an absent
 * `rules` as `[]`, and `applyResponseEvent` cleared the rules the page held
 * though they stayed saved; the test of #134 called `applyResponseState`
 * alone and missed it).
 */
describe('a state without rules, through every path the page takes it by (D246)', () => {
  const WITH_RULES: SessionDetails = { ...PAGE, rules: [RULE] };
  const OLDER = {
    response: custom({ status: 500 }),
    customResponse: custom({ status: 500 }),
    queue: null,
  } as unknown as SessionResponseState;

  /** What `takeResponseEvent` in `hooks/useSessionData.ts` does with an event: the held state, then the session shown. */
  function pageTakes(
    held: HeldResponseState,
    session: SessionDetails,
    event: ResponseEvent,
  ): { held: HeldResponseState; session: SessionDetails } {
    const next = recordResponseEvent(held, event);
    const shown =
      next.state !== held.state && next.state !== null
        ? applyResponseState(session, next.state)
        : session;

    return { held: next, session: shown ?? session };
  }

  it('keeps the rules through applyResponseEvent, the response changing', () => {
    const after = applyResponseEvent(responseStateOf(WITH_RULES), updated(OLDER));

    assert.deepEqual(after.rules, [RULE]);
    assert.deepEqual(after.response, custom({ status: 500 }));
  });

  it('keeps the rules shown through session.updated as the page takes it, and [] clears them', () => {
    const first = pageTakes(showing(WITH_RULES), WITH_RULES, updated(OLDER));

    assert.deepEqual(first.session.rules, [RULE]);
    assert.deepEqual(first.session.response, custom({ status: 500 }));
    assert.deepEqual(first.held.state?.rules, [RULE]);
    assert.equal(
      formatResponseButtonLabel(
        first.session.response,
        first.session.queue,
        undefined,
        first.session.rules,
      ),
      'Custom · 500 · 1 rule',
    );

    // Two in a row, then a step and a clear: still kept.
    const second = pageTakes(first.held, first.session, updated(OLDER));
    const cleared = pageTakes(second.held, second.session, CLEARED);

    assert.deepEqual(cleared.session.rules, [RULE]);

    // This version's `[]` does say none.
    const none = pageTakes(cleared.held, cleared.session, updated({ ...OLDER, rules: [] }));

    assert.deepEqual(none.session.rules, []);
    assert.deepEqual(none.held.state?.rules, []);
    assert.equal(formatResponseButtonLabel(none.session.response), 'Custom · 500');
  });

  it('keeps the rules a read in flight did not say, the event it kept applied on top', () => {
    const shown = showing(WITH_RULES);
    const begun = beginSessionRead(shown);
    const kept = recordResponseEvent(begun.held, updated(OLDER));
    const older = { ...WITH_RULES, rules: undefined } as unknown as SessionDetails;
    const settled = settleSessionRead(kept, begun.order, older);

    assert.deepEqual(settled.shown?.rules, [RULE]);
    assert.deepEqual(settled.held.state?.rules, [RULE]);
    assert.deepEqual(settled.shown?.response, custom({ status: 500 }));
  });

  /**
   * A `session.updated` starts a read's log afresh, so one without `rules`
   * must not drop the rules an earlier event in the read's window had said:
   * the stale read's own rules would come back from under it - rules just
   * saved shown as none, rules just removed shown again.
   */
  it('does not let a stale read undo rules saved during it, though a later event says none', () => {
    const shown = showing(PAGE);
    const begun = beginSessionRead(shown);
    const saved = pageTakes(begun.held, PAGE, updated({ ...responseStateOf(PAGE), rules: [RULE] }));
    const older = pageTakes(saved.held, saved.session, updated(OLDER));

    assert.deepEqual(older.session.rules, [RULE]);

    // The read was taken before the save: it says no rules.
    const settled = settleSessionRead(older.held, begun.order, PAGE);

    assert.deepEqual(settled.shown?.rules, [RULE]);
    assert.deepEqual(settled.held.state?.rules, [RULE]);
    assert.deepEqual(settled.shown?.response, custom({ status: 500 }));
    assert.equal(
      formatResponseButtonLabel(
        settled.shown?.response ?? null,
        settled.shown?.queue ?? null,
        undefined,
        settled.shown?.rules,
      ),
      'Custom · 500 · 1 rule',
    );
  });

  it('does not let a stale read bring back rules removed during it, though a later event says none', () => {
    const shown = showing(WITH_RULES);
    const begun = beginSessionRead(shown);
    const removed = pageTakes(
      begun.held,
      WITH_RULES,
      updated({ ...responseStateOf(WITH_RULES), rules: [] }),
    );
    const older = pageTakes(removed.held, removed.session, updated(OLDER));

    assert.deepEqual(older.session.rules, []);

    // The read was taken before the removal: it says the rule.
    const settled = settleSessionRead(older.held, begun.order, WITH_RULES);

    assert.deepEqual(settled.shown?.rules, []);
    assert.deepEqual(settled.held.state?.rules, []);
    assert.equal(
      formatResponseButtonLabel(
        settled.shown?.response ?? null,
        settled.shown?.queue ?? null,
        undefined,
        settled.shown?.rules,
      ),
      'Custom · 500',
    );
  });

  it('settles a read on the newest rules its window said, through steps, clears and older events, each read its own', () => {
    const other = { ...RULE, method: null, path: '/items/*' };
    const shown = showing({ ...PAGE, queue: queueOf(steps(503, 429), 1) });
    const first = beginSessionRead(shown);
    const one = taking(first.held, updated({ ...responseStateOf(PAGE), rules: [RULE] }));
    // A second read begins after the first rules were said.
    const second = beginSessionRead(one);
    const later = taking(
      second.held,
      stepOf(1, 2),
      updated(OLDER),
      updated({ ...responseStateOf(PAGE), rules: [other] }),
      CLEARED,
      updated(OLDER),
      stepOf(1, 2),
    );

    assert.deepEqual(later.state?.rules, [other]);

    const a = settleSessionRead(later, first.order, { ...PAGE, rules: [] });
    const b = settleSessionRead(a.held, second.order, { ...PAGE, rules: [RULE] });

    assert.deepEqual(a.shown?.rules, [other]);
    assert.deepEqual(b.shown?.rules, [other]);
    assert.deepEqual(b.held.state?.rules, [other]);
  });

  it('settles a read on its own rules when nothing in its window said any, and keeps the shown ones when neither does', () => {
    const shown = showing(PAGE);
    const begun = beginSessionRead(shown);
    const during = taking(begun.held, updated(OLDER), CLEARED, updated(OLDER));

    // A read taken after a save this page has not heard of yet brings it.
    assert.deepEqual(
      settleSessionRead(during, begun.order, { ...PAGE, rules: [RULE] }).shown?.rules,
      [RULE],
    );

    // A read without rules either, from an older image: the page's own stay.
    const held = showing(WITH_RULES);
    const again = beginSessionRead(held);
    const quiet = taking(again.held, updated(OLDER));
    const older = { ...WITH_RULES, rules: undefined } as unknown as SessionDetails;

    assert.deepEqual(settleSessionRead(quiet, again.order, older).shown?.rules, [RULE]);
  });

  it('reads a first read without rules as none known, and a later state with rules brings them', () => {
    const older = { ...PAGE, rules: undefined } as unknown as SessionDetails;
    const held = showing(older);

    assert.equal(held.state === null ? null : 'rules' in held.state, false);

    const next = recordResponseEvent(held, updated({ ...responseStateOf(PAGE), rules: [RULE] }));

    assert.deepEqual(next.state?.rules, [RULE]);
  });

  it('keeps the rules through an own answer from an older image', () => {
    const shown = showing(WITH_RULES);
    const answered = recordOwnAnswer(shown, OLDER, shown.revision);

    assert.deepEqual(answered.state?.rules, [RULE]);
    assert.deepEqual(answered.state?.response, custom({ status: 500 }));
    assert.deepEqual(applyResponseState(WITH_RULES, OLDER)?.rules, [RULE]);
  });

  it('still tells a change of the rules apart when both states say them', () => {
    const said = { ...responseStateOf(PAGE), rules: [RULE] };

    assert.equal(sameResponseState(said, { ...said, rules: [] }), false);
    assert.equal(sameResponseState(said, OLDER), false);
    assert.equal(
      sameResponseState(
        { ...said, response: OLDER.response, customResponse: OLDER.customResponse },
        OLDER,
      ),
      true,
    );
  });
});

describe('the endpoint label with response rules (issue #226, criterion 5)', () => {
  const rules = [RULE, { ...RULE, method: null, path: '/items/*' }, { ...RULE, path: '/x' }];

  it('adds the count after the status, the delay and the queue’s part, and nothing for none', () => {
    assert.equal(
      formatResponseButtonLabel(custom({ status: 200 }), null, undefined, rules),
      'Custom · 200 · 3 rules',
    );
    assert.equal(
      formatResponseButtonLabel(custom({ status: 200 }), null, undefined, [RULE]),
      'Custom · 200 · 1 rule',
    );
    assert.equal(
      formatResponseButtonLabel(null, null, undefined, rules),
      'Default · 200 · 3 rules',
    );
    assert.equal(
      formatResponseButtonLabel(
        custom({ status: 201, delayMs: 500 }),
        queueOf(steps(503, 503), 1),
        undefined,
        rules,
      ),
      'Custom · 201 · 500 ms · 2 queued · 3 rules',
    );
    assert.equal(
      formatResponseButtonLabel(custom({ status: 200 }), null, undefined, []),
      'Custom · 200',
    );
    assert.equal(
      formatResponseButtonName(custom({ status: 200 }), null, undefined, rules),
      'Custom · 200 · 3 rules · Response settings',
    );
  });

  it('says the count in Russian, joined by a no-break space', () => {
    assert.equal(
      formatResponseButtonLabel(custom({ status: 200 }), null, ru, rules),
      'Свой · 200 · 3\u00a0правила',
    );
  });
});

describe('staysOpen', () => {
  it('closes a surface on request while nothing is being saved', () => {
    assert.equal(staysOpen(false, false), false);
    assert.equal(staysOpen(true, false), true);
  });

  it('ignores a request to close while a change is being saved (C8, D8)', () => {
    assert.equal(staysOpen(false, true), true);
    assert.equal(staysOpen(true, true), true);
  });
});
