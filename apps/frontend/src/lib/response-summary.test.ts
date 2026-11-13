/**
 * Every response state, and the list row's status cell (D114).
 *
 * This file is the **only** place `failed` can be proven anywhere in the
 * project's frontend coverage: no valid input reaches that state, so neither
 * production nor the browser suite can (D109). Its two headlines (D120c) and
 * its explanatory line (D124) are asserted here or nowhere.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_REQUESTS_PER_SESSION,
  MAX_RESPONSE_RULES,
  type ResponseRecord,
  type ResponseState,
  type ResponseSummary,
} from '@webhook-inspector/shared';
import { ru } from '../i18n/ru.ts';
import {
  describeResponse,
  formatListStatus,
  headingStatusTone,
  listRuleMarker,
  listStatusTone,
  LIST_ROW_NOT_RECORDED,
  formatQueueStep,
} from './response-summary.ts';

const STARTED_AT = '2026-09-17T14:32:06.000Z';

function record(overrides: Partial<ResponseRecord> = {}): ResponseRecord {
  return {
    state: 'sent',
    status: 200,
    queueStep: null,
    rule: null,
    headers: [['Content-Type', 'application/json; charset=utf-8']],
    body: '{"ok":true}',
    bodyBase64: null,
    isBinary: false,
    bodySize: 11,
    bodySuppressed: false,
    raw: 'HTTP/1.1 200 OK',
    rawBase64: null,
    isRawBinary: false,
    delayMs: 0,
    startedAt: STARTED_AT,
    completedAt: STARTED_AT,
    durationMs: 1,
    ...overrides,
  };
}

function summary(state: ResponseState, status: number | null): ResponseSummary {
  return { state, status, queueStep: null, rule: null };
}

describe('describeResponse: sent', () => {
  /**
   * Two lines, not three (issue #51, D158): `Sent by server · …` states the
   * observation boundary itself, and the sentence that repeated it on nearly
   * every response is gone. Nothing here is worded as a delivery.
   */
  it('reports the size and the time on two lines, and never a delivery confirmation', () => {
    const lines = describeResponse(record(), 'UTC');

    assert.equal(lines.statusLabel, '200 OK');
    assert.equal(lines.stateLine, 'Sent by server · 11 B · 17 Sep 2026, 14:32:06');
    assert.equal(lines.note, null);
  });

  it('adds no third line to any finished write that sent what it prepared', () => {
    const sent = [
      record(),
      record({ status: 204, body: null, bodySize: 0 }),
      record({ status: 201, body: null, bodySize: 0 }),
      record({ isBinary: true, bodyBase64: 'AAEC' }),
      record({ status: 500 }),
    ];

    for (const each of sent) {
      assert.equal(describeResponse(each, 'UTC').note, null, JSON.stringify(each));
    }
  });

  /** The retired sentence is said by no state at all. */
  it('never says the retired delivery sentence, in any state', () => {
    const states: ResponseState[] = ['pending', 'aborted', 'unknown', 'failed', 'sent'];

    for (const state of states) {
      for (const bodySuppressed of [false, true]) {
        const lines = describeResponse(record({ state, bodySuppressed }), 'UTC');
        const said = [lines.statusLabel, lines.stateLine, lines.note].join('\n');

        assert.doesNotMatch(said, /Client delivery is not confirmed/);
      }
    }
  });

  /**
   * The only state line that carries a time writes it the way the detail panel
   * does, in the viewer's zone, and from the moment the write completed (D148).
   */
  it("writes the completion time as the detail panel does, in the viewer's zone", () => {
    const lines = describeResponse(
      record({ startedAt: '2026-09-17T23:29:59.900Z', completedAt: '2026-09-17T23:30:00.062Z' }),
      'Europe/Moscow',
    );

    assert.equal(lines.stateLine, 'Sent by server · 11 B · 18 Sep 2026, 02:30:00');
  });

  it('reports a 204 as zero bytes', () => {
    const lines = describeResponse(record({ status: 204, body: null, bodySize: 0 }));

    assert.equal(lines.statusLabel, '204 No Content');
    assert.equal(lines.stateLine, 'Sent by server · 0 B');
  });

  it('reports a custom response configured without a body', () => {
    const lines = describeResponse(record({ status: 201, body: null, bodySize: 0 }));

    assert.equal(lines.stateLine, 'Sent by server · custom response');
  });

  it('reports a binary record without claiming a readable size', () => {
    const lines = describeResponse(record({ isBinary: true, bodyBase64: 'AAEC' }));

    assert.equal(lines.stateLine, 'Sent by server · binary response record');
  });

  /** The one case where "formed" and "reached the wire" visibly diverge (D064). */
  it('reports a HEAD response as stored but not sent', () => {
    const lines = describeResponse(record({ status: 201, bodySuppressed: true }));

    assert.equal(lines.stateLine, 'Sent by server · HEAD · body not sent');
    assert.equal(
      lines.note,
      'The prepared body is stored for inspection. HEAD responses do not send it.',
    );
  });
});

describe('describeResponse: the states that are not sent', () => {
  it('reports pending with the delay the session configured', () => {
    const lines = describeResponse(
      record({ state: 'pending', status: 201, delayMs: 500, completedAt: null }),
    );

    assert.equal(lines.stateLine, 'Pending · configured delay: 500 ms');
    assert.equal(lines.note, 'Waiting to send. The prepared response is shown below.');
  });

  it('reports aborted as the connection closing, not as a lost request', () => {
    const lines = describeResponse(record({ state: 'aborted', status: 201, completedAt: null }));

    assert.equal(lines.stateLine, 'Send aborted · 201 prepared');
    assert.equal(
      lines.note,
      'The connection closed before the server finished writing the response.',
    );
  });

  it('reports an aged-out pending record as an unknown outcome', () => {
    const lines = describeResponse(record({ state: 'unknown', status: 201, completedAt: null }));

    assert.equal(lines.stateLine, 'Send outcome unknown · 201 prepared');
    assert.equal(
      lines.note,
      'The prepared response was saved; its final send outcome is unavailable.',
    );
  });

  /**
   * Not `Recording failed · 201 prepared` over `The final send outcome could not
   * be recorded.`, which is what the design frame `275:269` draws and what D071
   * records as non-binding. D109 defines `failed` as the response having been
   * formed while our own write threw; saying the recording failed would tell a
   * user of an inspector that the tool lost their data.
   */
  it('reports failed with the prepared status, and never as a failed recording', () => {
    const lines = describeResponse(record({ state: 'failed', status: 201, completedAt: null }));

    assert.equal(lines.stateLine, 'Sending failed · 201 prepared');
    assert.equal(
      lines.note,
      'The server failed while writing the response. The prepared response is shown below.',
    );
    assert.ok(!lines.stateLine.includes('Recording'));
    assert.doesNotMatch(lines.note ?? '', /recorded/);
  });

  it('reports failed with no status composed where the write threw first', () => {
    const lines = describeResponse(
      record({ state: 'failed', status: null, completedAt: null, raw: null }),
    );

    assert.equal(lines.statusLabel, null);
    assert.equal(lines.stateLine, 'Sending failed · no status composed');
    assert.equal(
      lines.note,
      'The server failed while writing the response. The prepared response is shown below.',
    );
  });
});

describe('formatListStatus', () => {
  /**
   * The release's point: a row never shows a status derived from the session
   * configuration, because that would assert an outcome the backend did not
   * observe (D119). The configured status stays on the endpoint card.
   */
  it('reads Not recorded where there is no response record', () => {
    assert.equal(formatListStatus(null), 'Not recorded');
    assert.equal(formatListStatus(null), LIST_ROW_NOT_RECORDED);
  });

  it('reads the recorded status where there is a record', () => {
    assert.equal(formatListStatus(summary('sent', 200)), '200');
    assert.equal(formatListStatus(summary('sent', 201)), '201');
    assert.equal(formatListStatus(summary('aborted', 201)), '201');
    assert.equal(formatListStatus(summary('unknown', 503)), '503');
  });

  /** Visible for up to 30 seconds while a configured delay holds the reply. */
  it('reads Pending while nothing has been written yet', () => {
    assert.equal(formatListStatus(summary('pending', 201)), 'Pending');
  });

  it('reads Failed where the write threw before a status was composed', () => {
    assert.equal(formatListStatus(summary('failed', null)), 'Failed');
  });
});

/**
 * The look of the cell, state by state (D207). Until 0.48.0 a sent `200` was
 * green text and a `400` to `599` red, so a `500` the user configured on
 * purpose read as an error of ours; now an answer the session gave is its code
 * in the pill of its class. The cell was once toned from the status alone,
 * which painted `Pending` and a statusless `Failed` in the success green - and
 * `Pending` is on screen in production for as long as a configured delay holds
 * the reply - so the look still follows the state first.
 */
describe('listStatusTone', () => {
  it('is neutral where there is no response record', () => {
    assert.equal(listStatusTone(null), 'neutral');
  });

  it('draws a completed write as an answer, the pill, whatever its class', () => {
    for (const status of [200, 201, 204, 299, 301, 304, 400, 404, 422, 429, 500, 503, 599]) {
      assert.equal(listStatusTone(summary('sent', status)), 'answered', `${status}`);
    }
  });

  /** The case that is reachable in production, and the one that mattered. */
  it('never draws pending as an answer, whatever status was prepared', () => {
    assert.equal(listStatusTone(summary('pending', 200)), 'neutral');
    assert.equal(listStatusTone(summary('pending', 201)), 'neutral');
    assert.equal(listStatusTone(summary('pending', 500)), 'neutral');
  });

  it('tones failed as a failure, including where no status was composed', () => {
    assert.equal(listStatusTone(summary('failed', null)), 'failure');
    assert.equal(listStatusTone(summary('failed', 201)), 'failure');
    assert.equal(listStatusTone(summary('failed', 500)), 'failure');
  });

  /**
   * Neither settled, so neither is an answer the sender surely received: the
   * bare code, muted, and no longer red for a 4xx or 5xx (D207, Decision 1 of
   * issue #138).
   */
  it('shows an unsettled send as the bare code, muted, whatever its class', () => {
    for (const state of ['aborted', 'unknown'] as const) {
      for (const status of [201, 302, 404, 503]) {
        assert.equal(listStatusTone(summary(state, status)), 'neutral', `${state} ${status}`);
      }
    }
  });

  it('draws no state but a completed write as an answer', () => {
    /*
     * Keyed by the type rather than listed as an array literal: widening
     * `ResponseState` does not invalidate a literal, so a sixth state would
     * compile here and leave this test quietly no longer exhaustive. As a
     * `Record` of every state but `sent`, a new one is a missing key and a
     * compile error, which is the guarantee this test is making.
     */
    const unsent: Record<Exclude<ResponseState, 'sent'>, true> = {
      pending: true,
      aborted: true,
      unknown: true,
      failed: true,
    };

    for (const state of Object.keys(unsent) as Exclude<ResponseState, 'sent'>[]) {
      for (const status of [200, 201, 404, 500, null]) {
        assert.notEqual(listStatusTone(summary(state, status)), 'answered');
      }
    }
  });

  it('is red for our own failed write alone', () => {
    const states: ResponseState[] = ['pending', 'aborted', 'unknown', 'sent'];

    for (const state of states) {
      for (const status of [200, 201, 404, 500, 503]) {
        assert.notEqual(listStatusTone(summary(state, status)), 'failure', `${state} ${status}`);
      }
    }
  });
});

/**
 * The heading's status, state by state (D207): the pill for an answer the
 * session gave; the label in ink for an unsettled send; and, as before the
 * pill, red for a pending or failed write of a 4xx or 5xx, ink otherwise.
 */
describe('headingStatusTone', () => {
  it('draws a completed write as an answer, the pill, whatever its class', () => {
    for (const status of [200, 201, 204, 299, 301, 404, 429, 500, 503, 599]) {
      assert.equal(headingStatusTone({ state: 'sent', status }), 'answered', `${status}`);
    }
  });

  /** The reported case: a configured `500` is no longer red text. */
  it('never draws a sent, aborted or unknown status in red', () => {
    for (const state of ['sent', 'aborted', 'unknown'] as const) {
      for (const status of [200, 301, 400, 404, 500, 503]) {
        assert.notEqual(headingStatusTone({ state, status }), 'failure', `${state} ${status}`);
      }
    }
  });

  it('keeps an unsettled send in ink, uncoloured', () => {
    for (const state of ['aborted', 'unknown'] as const) {
      for (const status of [201, 302, 404, 503]) {
        assert.equal(headingStatusTone({ state, status }), 'ink', `${state} ${status}`);
      }
    }
  });

  /** Unchanged from 0.47.0: neither is an answer the session gave. */
  it('draws pending and failed as before the pill: red for 400 and up, ink below', () => {
    for (const state of ['pending', 'failed'] as const) {
      assert.equal(headingStatusTone({ state, status: 200 }), 'ink');
      assert.equal(headingStatusTone({ state, status: 399 }), 'ink');
      assert.equal(headingStatusTone({ state, status: 400 }), 'failure');
      assert.equal(headingStatusTone({ state, status: 503 }), 'failure');
    }
    assert.equal(headingStatusTone({ state: 'failed', status: null }), 'ink');
  });

  it('draws no state but a completed write as an answer', () => {
    const unsent: Record<Exclude<ResponseState, 'sent'>, true> = {
      pending: true,
      aborted: true,
      unknown: true,
      failed: true,
    };

    for (const state of Object.keys(unsent) as Exclude<ResponseState, 'sent'>[]) {
      for (const status of [200, 201, 404, 500, null]) {
        assert.notEqual(headingStatusTone({ state, status }), 'answered');
      }
    }
  });
});

/** The pill's code and the phrase beside it (D207). */
describe('describeResponse: the status in the heading', () => {
  it('splits a sent status into the pill and the reason phrase beside it', () => {
    const lines = describeResponse(record({ status: 500 }), 'UTC');

    assert.equal(lines.statusTone, 'answered');
    assert.equal(lines.statusLabel, '500 Internal Server Error');
    assert.equal(lines.reasonPhrase, 'Internal Server Error');
  });

  /** Issue #138: the pill alone. */
  it('has no phrase for a code without one, which shows the pill alone', () => {
    for (const status of [299, 599]) {
      const lines = describeResponse(record({ status }), 'UTC');

      assert.equal(lines.statusTone, 'answered');
      assert.equal(lines.statusLabel, `${status}`);
      assert.equal(lines.reasonPhrase, null);
    }
  });

  it('keeps the phrase of the longest status the 320 px heading wraps', () => {
    const lines = describeResponse(record({ status: 511 }), 'UTC');

    assert.equal(lines.reasonPhrase, 'Network Authentication Required');
  });

  it('gives each state its tone', () => {
    assert.equal(describeResponse(record({ state: 'sent', status: 404 })).statusTone, 'answered');
    assert.equal(
      describeResponse(record({ state: 'aborted', status: 503, completedAt: null })).statusTone,
      'ink',
    );
    assert.equal(
      describeResponse(record({ state: 'unknown', status: 503, completedAt: null })).statusTone,
      'ink',
    );
    assert.equal(
      describeResponse(record({ state: 'pending', status: 500, completedAt: null })).statusTone,
      'failure',
    );
    assert.equal(
      describeResponse(record({ state: 'failed', status: 201, completedAt: null })).statusTone,
      'ink',
    );
  });

  it('has no phrase where no status was composed', () => {
    const lines = describeResponse(
      record({ state: 'failed', status: null, completedAt: null, raw: null }),
    );

    assert.equal(lines.statusLabel, null);
    assert.equal(lines.reasonPhrase, null);
  });
});

/**
 * The step of the response queue that answered, as the Response tab names it
 * (frames U7 and M5 of the Figma page `Webhook Inspector · Response queue
 * (#106) — chosen, review 2`, D205).
 */
describe('describeResponse: the queue step', () => {
  it('names the step, and cuts the state line before its time for the tag', () => {
    const lines = describeResponse(
      record({ status: 503, queueStep: { index: 2, total: 7 }, body: '{"e":1}', bodySize: 35 }),
      'UTC',
    );

    assert.equal(lines.queueStep, 'Queue step 2 of 7');
    assert.deepEqual(lines.stateParts, {
      lead: 'Sent by server · 35 B',
      time: '17 Sep 2026, 14:32:06',
    });
    assert.equal(lines.stateLine, `${lines.stateParts.lead} · ${lines.stateParts.time}`);
  });

  it('names none when the session response answered, and keeps the line as it was', () => {
    const lines = describeResponse(record(), 'UTC');

    assert.equal(lines.queueStep, null);
    assert.equal(lines.stateLine, 'Sent by server · 11 B · 17 Sep 2026, 14:32:06');
  });

  it('puts the tag at the end of a line without a time', () => {
    const lines = describeResponse(
      record({ state: 'pending', delayMs: 2000, queueStep: { index: 1, total: 2 }, rule: null }),
      'UTC',
    );

    assert.deepEqual(lines.stateParts, { lead: lines.stateLine, time: null });
    assert.equal(lines.queueStep, 'Queue step 1 of 2');
  });

  it('reads a record from an older backend, with no step at all, as none', () => {
    assert.equal(formatQueueStep(undefined), null);
    assert.equal(formatQueueStep(null), null);
  });
});

/**
 * The list row's marker of the rule that answered (issue #233): the rule's
 * place from the summary, which is all the summary carries (D246 point 8),
 * and nothing where no rule answered.
 */
describe('listRuleMarker', () => {
  it('marks a request a rule answered with that rule’s place, R2, and says so in full', () => {
    assert.deepEqual(listRuleMarker({ ...summary('sent', 201), rule: { index: 2 } }), {
      text: 'R2',
      title: 'Answered by rule 2',
    });
    assert.deepEqual(listRuleMarker({ ...summary('sent', 200), rule: { index: 1 } }, ru), {
      text: 'П1',
      title: 'Ответило правило 1',
    });
  });

  it('marks the rule whatever state its answer is in, a delay held or a send cut short', () => {
    for (const state of ['pending', 'aborted', 'unknown', 'failed'] as const) {
      assert.equal(
        listRuleMarker({ ...summary(state, 404), rule: { index: 3 } })?.text,
        'R3',
        state,
      );
    }
    assert.equal(listRuleMarker({ ...summary('failed', null), rule: { index: 4 } })?.text, 'R4');
  });

  it('shows nothing new for no record, the queue or the session response, and an older backend', () => {
    assert.equal(listRuleMarker(null), null);
    assert.equal(listRuleMarker(summary('sent', 200)), null);
    assert.equal(
      listRuleMarker({ ...summary('sent', 503), queueStep: { index: 2, total: 7 } }),
      null,
    );

    // A record from before 1.3.0, or from the previous image, has no `rule`.
    const older: Partial<ResponseSummary> = summary('sent', 200);

    delete older.rule;
    assert.equal('rule' in older, false);
    assert.equal(listRuleMarker(older as ResponseSummary), null);
  });

  it('writes the place as given, up to the 20 a session holds and past it', () => {
    for (const index of [1, 9, 10, 20, MAX_RESPONSE_RULES]) {
      assert.deepEqual(listRuleMarker({ ...summary('sent', 200), rule: { index } }), {
        text: `R${index}`,
        title: `Answered by rule ${index}`,
      });
    }
    assert.equal(listRuleMarker({ ...summary('sent', 200), rule: { index: 1000 } })?.text, 'R1000');
  });

  /** The attack list's 1000 rows, each with a marker: no work per row but the text. */
  it('marks a full list of 1000 rows, each by its own rule', () => {
    const texts = Array.from(
      { length: MAX_REQUESTS_PER_SESSION },
      (_, row) =>
        listRuleMarker({ ...summary('sent', 200), rule: { index: (row % 20) + 1 } }, ru)?.text,
    );

    assert.equal(texts.length, MAX_REQUESTS_PER_SESSION);
    assert.equal(texts[0], 'П1');
    assert.equal(texts[19], 'П20');
    assert.equal(texts[999], 'П20');
  });
});
