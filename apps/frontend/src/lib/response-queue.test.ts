import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ErrorCode,
  type ResponseConfig,
  type ResponseQueue,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { ApiError } from '../api/client.ts';
import { en } from '../i18n/en.ts';
import { ru } from '../i18n/ru.ts';
import { DEFAULT_RESPONSE_FORM, formFromResponse, type ResponseForm } from './response-config.ts';
import {
  addQueueStep,
  applyQueueCleared,
  applyQueueStep,
  asksToRemoveQueue,
  canRemoveQueue,
  describeQueueChips,
  describeQueueFailure,
  describeQueueStepRow,
  describeStepPlace,
  duplicateQueueStep,
  editQueueDraft,
  evaluateQueue,
  failureAfterEdit,
  failureOutsideRemoval,
  fitQueueChips,
  formatDelayShort,
  formatQueueCount,
  formatQueueRestartedToast,
  formatQueueSavedToast,
  formatQueuedSuffix,
  formatRemoveQueueQuestion,
  formatRemoveQueueLabel,
  formatRemoveQueueShortQuestion,
  formatSaveQueueLabel,
  formatSessionResponse,
  formatStepChip,
  heldQueue,
  initialQueueSelection,
  isHastyRemoveClick,
  offersRunAgain,
  placeQueueRefusal,
  QUEUE_REMOVED_TOAST,
  QUEUE_SERVER_BUSY,
  QUEUE_TOO_LARGE,
  queueDialogSteps,
  queueErrorsWithRefusal,
  queueSectionRemoval,
  queueSectionView,
  queueFooterView,
  queueSectionFocusTarget,
  queueSectionRow,
  queueStepMarkers,
  removeQueueStep,
  REMOVE_SETTLE_MS,
  selectionAfterRemoval,
  shownQueueFailure,
  stepsLeft,
} from './response-queue.ts';
import { formatResponseButtonLabel, formatResponseButtonName } from './session-response.ts';

function response(overrides: Partial<ResponseConfig> = {}): ResponseConfig {
  return { status: 200, headers: [], body: null, delayMs: 0, template: false, ...overrides };
}

/** The seven steps the frames draw: 500, 503 · 2 s, 503 · 2 s, 429 · 10 s, 500, 502, 200. */
const SEVEN: ResponseConfig[] = [
  response({ status: 500 }),
  response({ status: 503, delayMs: 2000 }),
  response({ status: 503, delayMs: 2000 }),
  response({ status: 429, delayMs: 10_000 }),
  response({ status: 500 }),
  response({ status: 502 }),
  response({ status: 200 }),
];

const CUSTOM_200 = response({ status: 200, headers: [['x-trace', 'abc']] });

function queue(steps: ResponseConfig[], next: number | null): ResponseQueue {
  return { steps, next, total: steps.length };
}

function state(
  queueValue: ResponseQueue | null,
  sessionResponse: ResponseConfig | null = CUSTOM_200,
): SessionResponseState {
  return {
    response: sessionResponse,
    customResponse: sessionResponse,
    queue: queueValue,
    rules: [],
  };
}

describe('the quick switch section (P1, 671:370-671:772)', () => {
  it('shows the example and nothing of a queue while the session has none (P1.1)', () => {
    assert.deepEqual(queueSectionView(state(null)), { kind: 'none' });
    // A backend from before 0.46.0 sends no queue at all.
    assert.deepEqual(queueSectionView({ response: null, customResponse: null } as never), {
      kind: 'none',
    });
  });

  it('frames step 1, the rest grey and the session response dashed (P1.2, 671:370)', () => {
    assert.deepEqual(queueSectionView(state(queue(SEVEN, 1))), {
      kind: 'running',
      counter: 'Step 1 of 7',
      lead: 'Next response, then the rest',
      chips: [
        { kind: 'next', label: '500' },
        { kind: 'ahead', label: '503 · 2 s' },
        { kind: 'ahead', label: '503 · 2 s' },
        { kind: 'ahead', label: '429 · 10 s' },
        { kind: 'ahead', label: '500' },
        { kind: 'ahead', label: '502' },
        { kind: 'ahead', label: '200' },
        { kind: 'session', label: 'Custom 200' },
      ],
      kept: 1,
    });
  });

  it('puts the step answered last, with ✓, before the next one from step 2 on (P1.4, 671:476)', () => {
    const view = queueSectionView(state(queue(SEVEN, 2)));

    assert.equal(view.kind, 'running');
    assert.ok(view.kind === 'running');
    assert.equal(view.counter, 'Step 2 of 7');
    assert.equal(view.lead, 'Last answered, next response, then the rest');
    assert.deepEqual(view.chips.slice(0, 3), [
      { kind: 'answered', label: '500' },
      { kind: 'next', label: '503 · 2 s' },
      { kind: 'ahead', label: '503 · 2 s' },
    ]);
    assert.equal(view.kept, 2);
  });

  it('names a middle step the same way (671:582)', () => {
    const view = queueSectionView(state(queue(SEVEN, 4)));

    assert.ok(view.kind === 'running');
    assert.equal(view.counter, 'Step 4 of 7');
    assert.deepEqual(
      view.chips.map((chip) => chip.label),
      ['503 · 2 s', '429 · 10 s', '500', '502', '200', 'Custom 200'],
    );
    assert.equal(view.chips[0]?.kind, 'answered');
  });

  it('says the last step is the last, before the session response (671:683)', () => {
    assert.deepEqual(queueSectionView(state(queue(SEVEN, 7))), {
      kind: 'running',
      counter: 'Step 7 of 7',
      lead: 'Last answered, the last step, then the session response',
      chips: [
        { kind: 'answered', label: '502' },
        { kind: 'next', label: '200' },
        { kind: 'session', label: 'Custom 200' },
      ],
      kept: 2,
    });
  });

  it('frames the session response as the next once every step has answered (L1, 671:772)', () => {
    assert.deepEqual(queueSectionView(state(queue(SEVEN, null))), {
      kind: 'done',
      lead: 'Every step answered — the session response comes next',
      chips: [
        { kind: 'answered', label: '200' },
        { kind: 'session-next', label: 'Custom 200' },
      ],
      kept: 2,
    });
    // A default session (frame U8 of the Figma page `Webhook Inspector ·
    // Response queue (#106) — chosen, review 2`).
    const view = queueSectionView(state(queue([response({ status: 503 })], null), null));

    assert.ok(view.kind === 'done');
    assert.equal(view.chips[1]?.label, 'Default 200');
  });

  it('says a queue of one step is followed by the session response', () => {
    const view = queueSectionView(state(queue([response({ status: 503 })], 1)));

    assert.ok(view.kind === 'running');
    assert.equal(view.lead, 'Next response, then the session response');
    assert.equal(view.counter, 'Step 1 of 1');
  });

  it('reads the whole row to a screen reader, from which the drawn row is hidden', () => {
    const view = queueSectionView(state(queue(SEVEN, 2)));

    assert.ok(view.kind === 'running');
    assert.equal(
      describeQueueChips(view.chips),
      'Answered last: 500. Next: 503 · 2 s. Then 503 · 2 s, 429 · 10 s, 500, 502, 200. Then the session response, Custom 200.',
    );
  });
});

/**
 * The one line of chips (the chips N5 of the Figma page `Webhook Inspector ·
 * Response queue (#106) — chosen, review 2`): what does not fit ends with `→ …`
 * (frame P1.2 of that page). The widths are the frames' own: the 366 px row of
 * the 400 px popover, 4 px gaps, an 11 px arrow and a 10 px ellipsis.
 */
describe('the "…" overflow', () => {
  const ROW = { available: 366, gap: 4, arrow: 11, ellipsis: 10 };

  it('keeps every chip of a row that fits (671:683: ✓ 502 → 200 → Custom 200, 209 px)', () => {
    assert.deepEqual(fitQueueChips([48, 44, 79], ROW, 2), { shown: 3, cut: false });
  });

  it('cuts after the last chip that leaves room for the arrow and the ellipsis (671:476)', () => {
    // ✓ 500, 503 · 2 s framed, 503 · 2 s, 429 · 10 s, then 500, 502, 200, Custom 200.
    assert.deepEqual(fitQueueChips([48, 73, 60, 65, 36, 36, 36, 79], ROW, 2), {
      shown: 4,
      cut: true,
    });
  });

  it('cuts exactly at the boundary: a row of exactly the width fits, one pixel more is cut', () => {
    // Three chips of 100 and two arrows with their gaps: 300 + 2 × 19 = 338.
    assert.deepEqual(fitQueueChips([100, 100, 100], { ...ROW, available: 338 }, 1), {
      shown: 3,
      cut: false,
    });
    // 100 + 19 + 100 + 19 + 10 = 248 for two and the ellipsis.
    assert.deepEqual(fitQueueChips([100, 100, 100], { ...ROW, available: 337 }, 1), {
      shown: 2,
      cut: true,
    });
  });

  it('always shows the step answered last and the next one, however narrow the row', () => {
    assert.deepEqual(fitQueueChips([48, 73, 60, 65], { ...ROW, available: 40 }, 2), {
      shown: 2,
      cut: true,
    });
    assert.deepEqual(fitQueueChips([73, 60], { ...ROW, available: 10 }, 1), {
      shown: 1,
      cut: true,
    });
  });
});

describe('the endpoint label (U6, U7, U9)', () => {
  it('adds the steps left and drops the suffix when none is left', () => {
    assert.equal(formatResponseButtonLabel(CUSTOM_200, queue(SEVEN, 2)), 'Custom · 200 · 6 queued');
    assert.equal(
      formatResponseButtonLabel(null, queue(SEVEN.slice(0, 2), 1)),
      'Default · 200 · 2 queued',
    );
    assert.equal(formatResponseButtonLabel(CUSTOM_200, queue(SEVEN, 7)), 'Custom · 200 · 1 queued');
    assert.equal(formatResponseButtonLabel(CUSTOM_200, queue(SEVEN, null)), 'Custom · 200');
    assert.equal(formatResponseButtonLabel(CUSTOM_200, null), 'Custom · 200');
    assert.equal(
      formatResponseButtonLabel(response({ status: 201, delayMs: 500 }), queue(SEVEN, 6)),
      'Custom · 201 · 500 ms · 2 queued',
    );
  });

  it('keeps the suffix in the accessible name, before what the button opens', () => {
    assert.equal(
      formatResponseButtonName(CUSTOM_200, queue(SEVEN, 2)),
      'Custom · 200 · 6 queued · Response settings',
    );
  });

  it('counts the steps left from the next one to the last', () => {
    assert.equal(stepsLeft(queue(SEVEN, 1)), 7);
    assert.equal(stepsLeft(queue(SEVEN, 7)), 1);
    assert.equal(stepsLeft(queue(SEVEN, null)), 0);
    assert.equal(stepsLeft(null), 0);
    assert.equal(formatQueuedSuffix(queue(SEVEN, null)), null);
  });
});

describe('chip and row labels', () => {
  it('writes a delay in seconds, as the delay chips do, and nothing for none', () => {
    assert.equal(formatDelayShort(0), '');
    assert.equal(formatDelayShort(500), '0.5 s');
    assert.equal(formatDelayShort(2000), '2 s');
    assert.equal(formatDelayShort(1234), '1.234 s');
    assert.equal(formatDelayShort(30_000), '30 s');
    assert.equal(formatStepChip(response({ status: 503, delayMs: 2000 })), '503 · 2 s');
    assert.equal(formatStepChip(response({ status: 299 })), '299');
  });

  it('names the session response by its mode and status', () => {
    assert.equal(formatSessionResponse(null), 'Default 200');
    assert.equal(formatSessionResponse(response({ status: 201 })), 'Custom 201');
    assert.equal(
      formatSessionResponse(response({ status: 201, delayMs: 500 })),
      'Custom 201 · 0.5 s',
    );
  });

  it('describes a timeline row by its code, its status name and its delay (D1, T2)', () => {
    const form = formFromResponse(response({ status: 503, delayMs: 2000 }));

    assert.deepEqual(describeQueueStepRow(form, {}), {
      code: '503',
      name: 'Service Unavailable',
      delay: '2 s',
      invalid: false,
    });
    assert.equal(describeQueueStepRow(formFromResponse(response({ status: 299 })), {}).name, null);
  });

  it('marks a step in error in the list (E1)', () => {
    const form: ResponseForm = { ...DEFAULT_RESPONSE_FORM, status: '600' };

    assert.deepEqual(describeQueueStepRow(form, { status: 'x' }), {
      code: '600',
      name: 'not a status code',
      delay: '',
      invalid: true,
    });
    assert.equal(
      describeQueueStepRow({ ...DEFAULT_RESPONSE_FORM, body: 'x' }, { body: 'x' }).name,
      'has an error',
    );
    assert.equal(describeQueueStepRow({ ...DEFAULT_RESPONSE_FORM, status: ' ' }, {}).code, '—');
  });

  it('counts the steps against the limit', () => {
    assert.equal(formatQueueCount(7), '7 / 10');
    assert.equal(formatQueueCount(0), '0 / 10');
  });
});

describe('the dialog: add, duplicate, remove (U4, U5)', () => {
  const FORM_503 = formFromResponse(response({ status: 503, headers: [['Retry-After', '2']] }));

  it('adds a step as a copy of the session response, custom or default', () => {
    assert.deepEqual(addQueueStep([], CUSTOM_200), [formFromResponse(CUSTOM_200)]);
    assert.deepEqual(addQueueStep([FORM_503], null), [FORM_503, DEFAULT_RESPONSE_FORM]);
  });

  it('adds nothing past 10 steps', () => {
    const ten = Array.from({ length: 10 }, () => FORM_503);

    assert.equal(addQueueStep(ten, CUSTOM_200).length, 10);
    assert.equal(duplicateQueueStep(ten, 0).length, 10);
  });

  it('duplicates the selected step right after it, its headers copied rather than shared', () => {
    const steps = duplicateQueueStep([FORM_503, DEFAULT_RESPONSE_FORM], 0);

    assert.deepEqual(steps, [FORM_503, FORM_503, DEFAULT_RESPONSE_FORM]);
    assert.notEqual(steps[1], steps[0]);
    assert.notEqual(steps[1]?.headers, steps[0]?.headers);
    assert.notEqual(steps[1]?.headers[0], steps[0]?.headers[0]);
  });

  it('removes a step and selects the one that took its place, or the last', () => {
    assert.deepEqual(removeQueueStep([FORM_503, DEFAULT_RESPONSE_FORM], 0), [
      DEFAULT_RESPONSE_FORM,
    ]);
    assert.equal(selectionAfterRemoval(0, 1), 0);
    assert.equal(selectionAfterRemoval(2, 2), 1);
    assert.equal(selectionAfterRemoval(0, 0), null);
  });

  it('follows the session until the first edit, and keeps the viewer’s steps after it (D152)', () => {
    const before = state(queue(SEVEN.slice(0, 2), 1));
    const after = state(queue([response({ status: 418 })], 1));

    assert.deepEqual(queueDialogSteps(null, before), SEVEN.slice(0, 2).map(formFromResponse));
    assert.deepEqual(queueDialogSteps(null, after), [formFromResponse(response({ status: 418 }))]);

    const draft = editQueueDraft(null, before, (steps) => removeQueueStep(steps, 1));

    assert.deepEqual(queueDialogSteps(draft, after), [
      formFromResponse(SEVEN[0] as ResponseConfig),
    ]);
  });

  it('opens on the next step, the first of a used-up queue, or none', () => {
    assert.equal(initialQueueSelection(state(queue(SEVEN, 2))), 1);
    assert.equal(initialQueueSelection(state(queue(SEVEN, null))), 0);
    assert.equal(initialQueueSelection(state(null)), null);
  });

  it('offers Remove queue only while the session has a saved queue, not for unsaved steps (U3, U4)', () => {
    assert.equal(canRemoveQueue(state(null)), false);
    assert.equal(canRemoveQueue(state(queue(SEVEN, 1))), true);
    assert.equal(canRemoveQueue(state(queue(SEVEN, null))), true);
    assert.equal(
      formatRemoveQueueQuestion(2),
      'Remove all 2 steps? Requests will get the session response only.',
    );
    assert.equal(
      formatRemoveQueueQuestion(1),
      'Remove the step? Requests will get the session response only.',
    );
  });

  it('stops asking to remove the queue once the queue is gone, removed by another viewer meanwhile (E3)', () => {
    assert.equal(asksToRemoveQueue(true, state(queue(SEVEN, 3))), true);
    assert.equal(asksToRemoveQueue(true, state(queue(SEVEN, null))), true);
    assert.equal(asksToRemoveQueue(false, state(queue(SEVEN, 3))), false);
    // The `session.updated` of the removal arrives while the footer asks: no
    // question about steps that are gone, and no `Remove queue` to send.
    assert.equal(asksToRemoveQueue(true, state(null)), false);
    assert.equal(asksToRemoveQueue(true, { response: null, customResponse: null } as never), false);
  });
});

describe('a template kept through the queue dialog (D251, criterion 10)', () => {
  const TEMPLATE_STEP = response({
    status: 201,
    headers: [['Content-Type', 'application/json']],
    body: '{"id":"{{request.id}}"}',
    template: true,
  });

  it('saves the steps it opened on with their flags, a template step and a plain one', () => {
    const steps = queueDialogSteps(
      null,
      state(queue([TEMPLATE_STEP, response({ status: 503 })], 1)),
    );

    assert.deepEqual(evaluateQueue(steps).request, {
      steps: [
        {
          status: 201,
          headers: [['Content-Type', 'application/json']],
          body: '{"id":"{{request.id}}"}',
          template: true,
        },
        { status: 503 },
      ],
    });
  });

  it('adds a step copying a templated session response, flag included', () => {
    const steps = addQueueStep([], TEMPLATE_STEP);

    assert.equal(steps[0]?.template, true);
    assert.equal(evaluateQueue(steps).request?.steps[0]?.template, true);
  });

  it('duplicates a template step as a template, and the original stays one', () => {
    const steps = duplicateQueueStep([formFromResponse(TEMPLATE_STEP)], 0);

    assert.deepEqual(
      evaluateQueue(steps).request?.steps.map((step) => step.template),
      [true, true],
    );
  });

  it('keeps a step’s flag after another step is removed', () => {
    const steps = removeQueueStep(
      [formFromResponse(response({ status: 503 })), formFromResponse(TEMPLATE_STEP)],
      0,
    );

    assert.equal(evaluateQueue(steps).request?.steps[0]?.template, true);
  });
});

describe('the dialog: Save (E1)', () => {
  it('is unavailable with no steps, and says nothing then (U3)', () => {
    assert.deepEqual(evaluateQueue([]), {
      errors: [],
      broken: [],
      canSave: false,
      footerError: null,
      request: null,
    });
  });

  it('is unavailable with a step in error, which the footer names', () => {
    const evaluation = evaluateQueue([
      formFromResponse(response({ status: 503 })),
      { ...DEFAULT_RESPONSE_FORM, status: '600' },
    ]);

    assert.equal(evaluation.canSave, false);
    assert.deepEqual(evaluation.broken, [2]);
    assert.equal(evaluation.footerError, 'Fix step 2 to save the queue.');
    // The response editor's own message (D150).
    assert.equal(
      evaluation.errors[1]?.status,
      'Status is required and must be a whole number between 200 and 599.',
    );
    assert.equal(evaluation.request, null);
  });

  it('names every step in error', () => {
    const bad = { ...DEFAULT_RESPONSE_FORM, delayMs: '-1' };

    assert.equal(evaluateQueue([bad, bad]).footerError, 'Fix steps 1 and 2 to save the queue.');
    assert.equal(
      evaluateQueue([bad, DEFAULT_RESPONSE_FORM, bad, bad]).footerError,
      'Fix steps 1, 3 and 4 to save the queue.',
    );
  });

  it('sends every step as the response editor would send it', () => {
    const evaluation = evaluateQueue([
      formFromResponse(response({ status: 503, headers: [['Retry-After', '2']], delayMs: 2000 })),
      DEFAULT_RESPONSE_FORM,
    ]);

    assert.equal(evaluation.canSave, true);
    assert.equal(evaluation.footerError, null);
    assert.deepEqual(evaluation.request, {
      steps: [{ status: 503, headers: [['Retry-After', '2']], delayMs: 2000 }, { status: 200 }],
    });
  });
});

describe('the timeline markers (V1, K2b)', () => {
  it('shows an untouched queue as it runs: answered, next, ahead (D1)', () => {
    assert.deepEqual(queueStepMarkers(null, state(queue(SEVEN, 2)), 7), [
      'answered',
      'next',
      'ahead',
      'ahead',
      'ahead',
      'ahead',
      'ahead',
    ]);
    assert.deepEqual(queueStepMarkers(null, state(queue(SEVEN.slice(0, 2), null)), 2), [
      'answered',
      'answered',
    ]);
  });

  it('shows an edited queue as it will be saved, from step 1', () => {
    const draft = { steps: SEVEN.slice(0, 3).map(formFromResponse) };

    assert.deepEqual(queueStepMarkers(draft, state(queue(SEVEN, 5)), 3), [
      'next',
      'ahead',
      'ahead',
    ]);
    assert.deepEqual(queueStepMarkers(null, state(null), 0), []);
  });

  it('says where a step stands beside its number (U4, U5, D1)', () => {
    assert.equal(describeStepPlace(0, 'next'), 'answers the next request');
    assert.equal(describeStepPlace(1, 'next'), 'next — answers the next request');
    assert.equal(describeStepPlace(1, 'ahead'), 'answers the request after step 1');
    assert.equal(describeStepPlace(0, 'answered'), 'answered a request in this run');
  });
});

describe('the toasts (U6, U9, E3)', () => {
  it('says what the next requests get after a save, then which session response', () => {
    const twoOf503 = queue([response({ status: 503 }), response({ status: 503 })], 1);

    assert.equal(
      formatQueueSavedToast(state(twoOf503, null)),
      'Queue saved. The next 2 requests get 503, then the default response.',
    );
    assert.equal(
      formatQueueSavedToast(
        state(queue([response({ status: 503 }), response({ status: 429 }), response()], 1)),
      ),
      'Queue saved. The next 3 requests get 503, 429 and 200, then the custom response.',
    );
    assert.equal(
      formatQueueSavedToast(state(queue([response({ status: 503 })], 1))),
      'Queue saved. The next request gets 503, then the custom response.',
    );
  });

  it('says the queue starts again after Run again', () => {
    assert.equal(
      formatQueueRestartedToast(
        state(queue([response({ status: 503 }), response({ status: 503 })], 1)),
      ),
      'The queue starts again from step 1. The next 2 requests get 503.',
    );
  });

  /**
   * The toast is worded from the state the page shows once it has taken the
   * answer. A capture can take step 1 before the answer arrives, which is
   * then set aside, and the page shows step 2: a toast worded from the answer
   * would promise the next two requests beside `Step 2 of 2`.
   */
  it('words a save’s and a restart’s toast from the steps still to answer, none once used up', () => {
    const twoSteps = [response({ status: 503 }), response({ status: 429 })];

    assert.equal(
      formatQueueSavedToast(state(queue(twoSteps, 2), null)),
      'Queue saved. The next request gets 429, then the default response.',
    );
    assert.equal(
      formatQueueSavedToast(state(queue(twoSteps, null))),
      'Queue saved, and every step has already answered a request; the next requests get the custom response.',
    );
    assert.equal(
      formatQueueRestartedToast(state(queue(twoSteps, 2))),
      'The queue started again from step 1. The next request gets 429.',
    );
    assert.equal(
      formatQueueRestartedToast(state(queue(twoSteps, null), null)),
      'The queue started again from step 1, and every step has already answered a request; the next requests get the default response.',
    );
    // The queue gone meanwhile - removed by another viewer.
    assert.equal(formatQueueSavedToast(state(null)), 'Queue saved.');
    assert.equal(
      formatQueueRestartedToast(state(null)),
      'The session has no queue to start again.',
    );
  });

  it('never words a toast as a delivery (D103)', () => {
    for (const text of [
      formatQueueSavedToast(state(queue(SEVEN, 1))),
      formatQueueSavedToast(state(queue(SEVEN, 4))),
      formatQueueSavedToast(state(queue(SEVEN, null))),
      formatQueueRestartedToast(state(queue(SEVEN, 1))),
      formatQueueRestartedToast(state(queue(SEVEN, 4))),
      formatQueueRestartedToast(state(queue(SEVEN, null))),
      QUEUE_REMOVED_TOAST,
    ]) {
      assert.doesNotMatch(text, /deliver|received|sent/i, text);
    }
  });
});

/**
 * `Run again` and its failure (frame U8 and the ending L1 of the Figma page
 * `Webhook Inspector · Response queue (#106) — chosen, review 2`). The message
 * is said only while the section offers `Run again`: otherwise a restart whose
 * answer was lost while its own `session.updated` arrived would leave `Could
 * not start the queue again. Try again.` beside `Step 1 of N` until the next
 * `Run again`.
 */
describe('offersRunAgain', () => {
  it('offers Run again, and keeps its failure, only while the queue is used up', () => {
    assert.equal(offersRunAgain(state(queue(SEVEN, null))), true);
    assert.equal(offersRunAgain(state(queue([response({ status: 503 })], null), null)), true);
  });

  it('takes the failure away once the queue runs again, is replaced or is gone', () => {
    // The restart's own event, before its answer was lost.
    assert.equal(offersRunAgain(state(queue(SEVEN, 1))), false);
    // A capture took a step of it meanwhile, or another viewer saved one.
    assert.equal(offersRunAgain(state(queue(SEVEN, 2))), false);
    assert.equal(offersRunAgain(state(queue(SEVEN, 7))), false);
    // Removed, or a backend from before 0.46.0, which sends no queue.
    assert.equal(offersRunAgain(state(null)), false);
    assert.equal(offersRunAgain({ response: null, customResponse: null } as never), false);
  });
});

describe('following the queue as requests arrive (D205)', () => {
  const running = state(queue(SEVEN, 2));

  it('moves to the step after the one a request took, and is used up after the last', () => {
    assert.equal(heldQueue(applyQueueStep(running, { index: 2, total: 7 }))?.next, 3);
    assert.equal(heldQueue(applyQueueStep(running, { index: 7, total: 7 }))?.next, null);
  });

  it('changes nothing for a request the session response answered, or for another queue', () => {
    assert.equal(applyQueueStep(running, null), running);
    assert.equal(applyQueueStep(running, undefined), running);
    assert.equal(applyQueueStep(running, { index: 1, total: 3 }), running);

    const none = state(null);

    assert.equal(applyQueueStep(none, { index: 1, total: 3 }), none);
  });

  it('keeps everything else of the session it is applied to', () => {
    const session = { ...running, id: 'x', requestsCount: 3 };
    const moved = applyQueueStep(session, { index: 2, total: 7 });

    assert.equal(moved.id, 'x');
    assert.equal(moved.requestsCount, 3);
    assert.deepEqual(moved.queue?.steps, SEVEN);
  });

  it('starts the queue from step 1 on a clear, used up or not, and leaves no queue alone', () => {
    assert.equal(heldQueue(applyQueueCleared(state(queue(SEVEN, null))))?.next, 1);
    assert.equal(heldQueue(applyQueueCleared(running))?.next, 1);

    const none = state(null);

    assert.equal(applyQueueCleared(none), none);
  });
});

describe('a failed save or removal (E2)', () => {
  it('keeps the steps and asks for another try', () => {
    assert.deepEqual(describeQueueFailure(new Error('network'), 'save'), {
      kind: 'shown',
      action: 'save',
      text: 'Could not save the queue. Your steps are kept — try again.',
      retry: true,
    });
    assert.deepEqual(
      describeQueueFailure(new ApiError(500, ErrorCode.INTERNAL_ERROR, 'x'), 'remove'),
      {
        kind: 'shown',
        action: 'remove',
        text: 'Could not remove the queue. Try again.',
        retry: true,
      },
    );
  });

  it('says the server is busy on 429 / 1017 and offers Try again, the steps kept (D205)', () => {
    const busy = describeQueueFailure(
      new ApiError(
        429,
        ErrorCode.LARGE_BODIES_BUSY,
        'Too many large bodies are being saved; try again in a moment',
      ),
      'save',
    );

    assert.deepEqual(busy, {
      kind: 'shown',
      action: 'save',
      text: QUEUE_SERVER_BUSY,
      retry: true,
    });
    assert.equal(
      QUEUE_SERVER_BUSY,
      'The server is busy saving other large queues. Your steps are kept — try again in a moment.',
    );
    assert.equal(ErrorCode.LARGE_BODIES_BUSY, 1017);

    const shown = { action: 'save', text: QUEUE_SERVER_BUSY, retry: true } as const;

    assert.equal(formatSaveQueueLabel(null, shown), 'Try again');
    assert.equal(formatSaveQueueLabel('saving', shown), 'Saving…');
    // An edit leaves it: the server was busy, whatever the steps.
    assert.equal(failureAfterEdit(shown), shown);
  });

  it('shows a refused step with the server\u2019s message, which names it', () => {
    const refused = new ApiError(
      400,
      ErrorCode.INVALID_RESPONSE_CONFIG,
      'steps[1].status is required and must be an integer between 200 and 599',
    );

    assert.deepEqual(describeQueueFailure(refused, 'save'), {
      kind: 'shown',
      action: 'save',
      text: 'The server rejected this queue: steps[1].status is required and must be an integer between 200 and 599',
      retry: true,
    });
  });

  it('says a queue over 1 MiB is too large, since saving it again would fail the same way', () => {
    assert.deepEqual(
      describeQueueFailure(
        new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'Payload too large'),
        'save',
      ),
      { kind: 'shown', action: 'save', text: QUEUE_TOO_LARGE, retry: false },
    );
    assert.equal(
      QUEUE_TOO_LARGE,
      'This queue is over 1 MiB as JSON, too large to save. Shorten a body or remove a step.',
    );
  });

  it('offers no retry after a queue too large: the button reads Save queue, and an edit clears the message', () => {
    const tooLarge = { action: 'save', text: QUEUE_TOO_LARGE, retry: false } as const;

    assert.equal(formatSaveQueueLabel(null, tooLarge), 'Save queue');
    assert.equal(formatSaveQueueLabel('saving', tooLarge), 'Saving…');
    assert.equal(failureAfterEdit(tooLarge), null);

    // Any other failure offers it, and stays until the next call.
    const failed = {
      action: 'save',
      text: 'Could not save the queue. Your steps are kept — try again.',
      retry: true,
    } as const;

    assert.equal(formatSaveQueueLabel(null, failed), 'Try again');
    assert.equal(failureAfterEdit(failed), failed);
    assert.equal(formatSaveQueueLabel(null, null), 'Save queue');
    assert.equal(failureAfterEdit(null), null);
  });

  /**
   * A failed removal is retried by the removal, in the row that asked, never
   * by the main button, whose `Try again` would save the queue, starting it from
   * step 1 - or, when the removal had succeeded and only its answer was lost,
   * put the removed queue back.
   */
  it('retries a failed removal with the removal, in the row that asked, and never with a save', () => {
    const removal = describeQueueFailure(
      new ApiError(500, ErrorCode.INTERNAL_ERROR, 'x'),
      'remove',
    );

    assert.equal(removal.kind, 'shown');

    const failure = {
      action: 'remove',
      text: 'Could not remove the queue. Try again.',
      retry: true,
    } as const;
    const held = state(queue(SEVEN, 3));
    const after = queueFooterView({
      confirming: true,
      state: held,
      busy: null,
      failure,
      steps: 7,
      footerError: null,
    });

    // The row that asked stays, with the failure in place of the question and
    // `Try again` on the removal's button, which removes.
    assert.deepEqual(after, {
      asking: true,
      text: 'Could not remove the queue. Try again.',
      alert: true,
      main: { label: 'Try again', call: 'remove' },
    });
    assert.deepEqual(
      queueFooterView({
        confirming: true,
        state: held,
        busy: 'removing',
        failure: null,
        steps: 7,
        footerError: null,
      }).main,
      { label: 'Removing…', call: 'remove' },
    );

    // Out of that row, the main button saves, and never says Try again for a
    // removal: the failure goes with the row.
    assert.equal(formatSaveQueueLabel(null, failure), 'Save queue');
    assert.equal(failureOutsideRemoval(failure), null);
    assert.equal(failureAfterEdit(failure), null);
    assert.deepEqual(
      queueFooterView({
        confirming: false,
        state: held,
        busy: null,
        failure: failureOutsideRemoval(failure),
        steps: 7,
        footerError: null,
      }),
      { asking: false, text: null, alert: false, main: { label: 'Save queue', call: 'save' } },
    );

    // The removal's own button says Try again for a removal only.
    assert.equal(formatRemoveQueueLabel(null, failure), 'Try again');
    assert.equal(formatRemoveQueueLabel('removing', failure), 'Removing…');
    assert.equal(formatRemoveQueueLabel(null, null), 'Remove queue');
  });

  it('retries a failed save with the save, and keeps it out of the row that asks', () => {
    const failure = {
      action: 'save',
      text: 'Could not save the queue. Your steps are kept — try again.',
      retry: true,
    } as const;
    const held = state(queue(SEVEN, 3));

    assert.deepEqual(
      queueFooterView({
        confirming: false,
        state: held,
        busy: null,
        failure,
        steps: 7,
        footerError: null,
      }),
      {
        asking: false,
        text: 'Could not save the queue. Your steps are kept — try again.',
        alert: true,
        main: { label: 'Try again', call: 'save' },
      },
    );
    assert.equal(formatRemoveQueueLabel(null, failure), 'Remove queue');
    assert.equal(failureOutsideRemoval(failure), failure);
    assert.equal(failureAfterEdit(failure), failure);
  });

  it('asks once in the footer, says a step in error outside it, and drops the row with the queue gone (E1, E3)', () => {
    const held = state(queue(SEVEN, 3));

    assert.deepEqual(
      queueFooterView({
        confirming: true,
        state: held,
        busy: null,
        failure: null,
        steps: 7,
        footerError: 'Step 2 has an error.',
      }),
      {
        asking: true,
        text: 'Remove all 7 steps? Requests will get the session response only.',
        alert: false,
        main: { label: 'Remove queue', call: 'remove' },
      },
    );
    assert.deepEqual(
      queueFooterView({
        confirming: false,
        state: held,
        busy: null,
        failure: null,
        steps: 7,
        footerError: 'Step 2 has an error.',
      }),
      {
        asking: false,
        text: 'Step 2 has an error.',
        alert: true,
        main: { label: 'Save queue', call: 'save' },
      },
    );
    // Removed meanwhile: no question about steps that are gone, and a save.
    assert.deepEqual(
      queueFooterView({
        confirming: true,
        state: state(null),
        busy: null,
        failure: null,
        steps: 0,
        footerError: null,
      }).main,
      { label: 'Save queue', call: 'save' },
    );
  });

  /**
   * A removal's own `session.updated` usually arrives before its lost answer
   * fails. The queue is gone, so the row that asked has gone, and the failure,
   * set after it, must not be said beside a disabled Save queue when nothing
   * is left to remove.
   */
  it('says a failed removal only in the row that asked, never once the queue is gone, in either order', () => {
    const failure = {
      action: 'remove',
      text: 'Could not remove the queue. Try again.',
      retry: true,
    } as const;
    const quiet = {
      asking: false,
      text: null,
      alert: false,
      main: { label: 'Save queue', call: 'save' },
    };

    // The queue went first, and the question with it; then the answer failed.
    assert.deepEqual(
      queueFooterView({
        confirming: false,
        state: state(null),
        busy: null,
        failure,
        steps: 0,
        footerError: null,
      }),
      quiet,
    );
    // The answer failed first, in the row; then the queue went.
    assert.deepEqual(
      queueFooterView({
        confirming: true,
        state: state(null),
        busy: null,
        failure,
        steps: 0,
        footerError: null,
      }),
      quiet,
    );
    // A step in error is still said once the queue is gone.
    assert.deepEqual(
      queueFooterView({
        confirming: false,
        state: state(null),
        busy: null,
        failure,
        steps: 1,
        footerError: 'Step 1 has an error.',
      }),
      { ...quiet, text: 'Step 1 has an error.', alert: true },
    );
    // A failed save stays, the queue gone or not.
    const saveFailure = {
      action: 'save',
      text: 'Could not save the queue. Your steps are kept — try again.',
      retry: true,
    } as const;

    assert.deepEqual(
      queueFooterView({
        confirming: false,
        state: state(null),
        busy: null,
        failure: saveFailure,
        steps: 1,
        footerError: null,
      }),
      {
        asking: false,
        text: 'Could not save the queue. Your steps are kept — try again.',
        alert: true,
        main: { label: 'Try again', call: 'save' },
      },
    );
  });

  it('moves the page to Session not found when the session is gone', () => {
    for (const code of [ErrorCode.SESSION_NOT_FOUND, ErrorCode.SESSION_EXPIRED]) {
      assert.deepEqual(describeQueueFailure(new ApiError(404, code, 'gone'), 'save'), {
        kind: 'unavailable',
      });
    }
  });
});

/**
 * A failure is held as its call and error and put into words each time it is
 * shown, so one on screen in the non-modal quick switch follows the
 * `EN | RU` switch (D222).
 */
describe('shownQueueFailure', () => {
  const refused = new ApiError(
    400,
    ErrorCode.INVALID_RESPONSE_CONFIG,
    'steps[1].status is required and must be an integer between 200 and 599',
  );
  const tooLarge = new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'Payload too large');
  const busy = new ApiError(429, ErrorCode.LARGE_BODIES_BUSY, 'Too many large bodies');
  const failed = new ApiError(500, ErrorCode.INTERNAL_ERROR, 'Internal server error');

  it('says the same held failure in the language it is shown in, with the same call and retry', () => {
    for (const m of [en, ru]) {
      assert.deepEqual(shownQueueFailure({ action: 'save', error: refused }, m), {
        action: 'save',
        text: m.queue.rejected(
          'steps[1].status is required and must be an integer between 200 and 599',
        ),
        retry: true,
      });
      assert.deepEqual(shownQueueFailure({ action: 'save', error: tooLarge }, m), {
        action: 'save',
        text: m.queue.tooLarge,
        retry: false,
      });
      assert.deepEqual(shownQueueFailure({ action: 'save', error: busy }, m), {
        action: 'save',
        text: m.queue.serverBusy,
        retry: true,
      });
      assert.deepEqual(shownQueueFailure({ action: 'save', error: failed }, m), {
        action: 'save',
        text: m.queue.saveFailed,
        retry: true,
      });
      assert.deepEqual(shownQueueFailure({ action: 'remove', error: failed }, m), {
        action: 'remove',
        text: m.queue.removeFailed,
        retry: true,
      });
    }

    // Held once, written twice: nothing of the first language is left in the second.
    const held = { action: 'remove', error: new Error('network') } as const;

    assert.equal(shownQueueFailure(held, en)?.text, 'Could not remove the queue. Try again.');
    assert.equal(shownQueueFailure(held, ru)?.text, ru.queue.removeFailed);
    assert.doesNotMatch(shownQueueFailure(held, ru)?.text ?? '', /[A-Za-z]/);
  });

  it('shows nothing for none, and for a session gone, which moves the page instead', () => {
    assert.equal(shownQueueFailure(null, ru), null);
    assert.equal(
      shownQueueFailure(
        { action: 'remove', error: new ApiError(410, ErrorCode.SESSION_EXPIRED, 'x') },
        ru,
      ),
      null,
    );
  });

  it('leaves the held failure to the same rules as the shown one: a removal’s goes outside its row', () => {
    const save = { action: 'save', error: failed } as const;
    const removal = { action: 'remove', error: failed } as const;

    assert.equal(failureOutsideRemoval(save), save);
    assert.equal(failureOutsideRemoval(removal), null);
    assert.equal(
      failureAfterEdit(shownQueueFailure({ action: 'save', error: tooLarge }, ru)),
      null,
    );
  });
});

describe("the section's Remove queue (issue #142, D206)", () => {
  const removeFailure = {
    action: 'remove',
    text: 'Could not remove the queue. Try again.',
    retry: true,
  } as const;
  const links = { offered: true, asking: false, text: null, alert: false, label: 'Remove' };
  const none = { ...links, offered: false };

  it("asks the dialog's question without its second sentence", () => {
    assert.equal(formatRemoveQueueShortQuestion(7), 'Remove all 7 steps?');
    assert.equal(formatRemoveQueueShortQuestion(2), 'Remove all 2 steps?');
    assert.equal(formatRemoveQueueShortQuestion(1), 'Remove the step?');
    // The dialog's question still starts with it.
    for (const count of [1, 2, 7, 10]) {
      assert.ok(
        formatRemoveQueueQuestion(count).startsWith(`${formatRemoveQueueShortQuestion(count)} `),
      );
    }
  });

  it('offers Remove queue only while the session has a saved queue: running or used up, never with none', () => {
    const offered = (held: SessionResponseState) =>
      queueSectionRemoval({ confirming: false, state: held, removing: false, failure: null });

    assert.deepEqual(offered(state(queue(SEVEN, 2))), links);
    assert.deepEqual(offered(state(queue(SEVEN, null))), links);
    assert.deepEqual(offered(state(queue([response({ status: 503 })], 1), null)), links);
    assert.deepEqual(offered(state(null)), none);
    // A backend from before 0.46.0 sends no queue at all.
    assert.deepEqual(offered({ response: null, customResponse: null } as never), none);
  });

  it('asks once in place of the links: Remove all N steps?, Keep queue and Remove (716:383)', () => {
    assert.deepEqual(
      queueSectionRemoval({
        confirming: true,
        state: state(queue(SEVEN, 2)),
        removing: false,
        failure: null,
      }),
      { offered: true, asking: true, text: 'Remove all 7 steps?', alert: false, label: 'Remove' },
    );
    // A used-up one-step queue, as seen on the deployed site.
    assert.deepEqual(
      queueSectionRemoval({
        confirming: true,
        state: state(queue([response()], null)),
        removing: false,
        failure: null,
      }),
      { offered: true, asking: true, text: 'Remove the step?', alert: false, label: 'Remove' },
    );
  });

  it('says Removing… while the removal is in flight', () => {
    assert.equal(
      queueSectionRemoval({
        confirming: true,
        state: state(queue(SEVEN, null)),
        removing: true,
        failure: null,
      }).label,
      'Removing…',
    );
  });

  it('says a failure in place of the question, with Try again on the removal, which removes', () => {
    const described = describeQueueFailure(
      new ApiError(500, ErrorCode.INTERNAL_ERROR, 'x'),
      'remove',
    );

    assert.equal(described.kind, 'shown');
    assert.equal(
      described.kind === 'shown' ? described.text : null,
      'Could not remove the queue. Try again.',
    );
    assert.deepEqual(
      queueSectionRemoval({
        confirming: true,
        state: state(queue(SEVEN, 3)),
        removing: false,
        failure: removeFailure,
      }),
      {
        offered: true,
        asking: true,
        text: 'Could not remove the queue. Try again.',
        alert: true,
        label: 'Try again',
      },
    );
    // A failure that offers no retry keeps the button reading Remove.
    assert.equal(
      queueSectionRemoval({
        confirming: true,
        state: state(queue(SEVEN, 3)),
        removing: false,
        failure: { ...removeFailure, retry: false },
      }).label,
      'Remove',
    );
    // Keep queue takes the row away, and the failure with it.
    assert.deepEqual(
      queueSectionRemoval({
        confirming: false,
        state: state(queue(SEVEN, 3)),
        removing: false,
        failure: removeFailure,
      }),
      links,
    );
  });

  it("never says a failed save, which is the dialog's, in the section", () => {
    assert.deepEqual(
      queueSectionRemoval({
        confirming: true,
        state: state(queue(SEVEN, 3)),
        removing: false,
        failure: { action: 'save', text: 'Could not save the queue.', retry: true },
      }),
      { offered: true, asking: true, text: 'Remove all 7 steps?', alert: false, label: 'Remove' },
    );
  });

  it('stops asking once the queue is gone, removed by another viewer meanwhile, and its failure with it, in either order', () => {
    // The question was asked; another viewer's removal arrives.
    assert.deepEqual(
      queueSectionRemoval({ confirming: true, state: state(null), removing: false, failure: null }),
      none,
    );
    // The removal's own event arrived, then its lost answer failed.
    assert.deepEqual(
      queueSectionRemoval({
        confirming: true,
        state: state(null),
        removing: false,
        failure: removeFailure,
      }),
      none,
    );
    assert.deepEqual(
      queueSectionRemoval({
        confirming: false,
        state: state(null),
        removing: false,
        failure: removeFailure,
      }),
      none,
    );
  });

  it('counts the steps of the queue as the section shows it now, live', () => {
    const asked = (held: SessionResponseState) =>
      queueSectionRemoval({ confirming: true, state: held, removing: false, failure: null }).text;

    // Another viewer saved a shorter queue while this one was asked.
    assert.equal(asked(state(queue(SEVEN, 1))), 'Remove all 7 steps?');
    assert.equal(asked(state(queue(SEVEN.slice(0, 2), 1))), 'Remove all 2 steps?');
    assert.equal(asked(state(queue(SEVEN.slice(0, 1), null))), 'Remove the step?');
  });

  it('sets aside a click on Remove that is part of a double-click or comes within 500 ms of the question, never one from the keyboard (correction round 2)', () => {
    assert.equal(REMOVE_SETTLE_MS, 500);
    // The second click of a double-click on Remove queue, and a third.
    assert.equal(isHastyRemoveClick(2, 120), true);
    assert.equal(isHastyRemoveClick(3, 250), true);
    assert.equal(isHastyRemoveClick(2, 5_000), true);
    // A second tap or click of its own, at 0, 120, 250 and 400 ms and just
    // under the bound.
    for (const since of [0, 120, 250, 400, 499.9]) {
      assert.equal(isHastyRemoveClick(1, since), true, `${since} ms`);
    }
    // A click made before the page drew the question.
    assert.equal(isHastyRemoveClick(1, -3), true);
    // A deliberate click, once the question has been there for 500 ms.
    for (const since of [500, 501, 60_000, Number.POSITIVE_INFINITY]) {
      assert.equal(isHastyRemoveClick(1, since), false, `${since} ms`);
    }
    // A time that cannot be told is no reason to refuse the click.
    assert.equal(isHastyRemoveClick(1, Number.NaN), false);
    // Enter or Space on Remove: never set aside, however soon.
    for (const since of [-3, 0, 120, 400, 500, Number.NaN]) {
      assert.equal(isHastyRemoveClick(0, since), false, `${since} ms`);
    }
  });
});

describe('where focus the section lost goes (D206; issue #143)', () => {
  /** The row a session's state draws, the viewer asking or not. */
  const rowFor = (held: SessionResponseState, asking = false) =>
    queueSectionRow(
      queueSectionView(held).kind,
      queueSectionRemoval({ confirming: asking, state: held, removing: false, failure: null }),
    );

  it('tells a used-up queue, whose links start with Run again, from a running one', () => {
    assert.equal(rowFor(state(null)), 'none');
    assert.equal(rowFor(state(queue(SEVEN, 1))), 'running');
    assert.equal(rowFor(state(queue(SEVEN, 7))), 'running');
    assert.equal(rowFor(state(queue(SEVEN.slice(0, 1), null))), 'used-up');
    assert.equal(rowFor(state(queue(SEVEN, null))), 'used-up');
    // The question in place of either: one row, used up or running.
    assert.equal(rowFor(state(queue(SEVEN, 1)), true), 'asking');
    assert.equal(rowFor(state(queue(SEVEN, null)), true), 'asking');
    // Asked with no queue: the question went with it.
    assert.equal(rowFor(state(null), true), 'none');
    assert.equal(queueSectionRow('none', { asking: true }), 'none');
  });

  it('gives it to Keep queue as the question appears, over either queue', () => {
    assert.equal(queueSectionFocusTarget('used-up', 'asking'), 'keep-queue');
    assert.equal(queueSectionFocusTarget('running', 'asking'), 'keep-queue');
  });

  it('gives it back to Remove queue as the question goes and the queue stays, used up or running', () => {
    assert.equal(queueSectionFocusTarget('asking', 'used-up'), 'remove-queue');
    // Another viewer restarted the used-up queue while this one was asked.
    assert.equal(queueSectionFocusTarget('asking', 'running'), 'remove-queue');
  });

  it('gives it to the heading row as Run again goes: a used-up queue started from step 1 (6c, 6d)', () => {
    // Another viewer's restart, save or clear (D205), during this viewer's
    // own Run again too, whose message is then not said.
    assert.equal(queueSectionFocusTarget('used-up', 'running'), 'heading');
  });

  it('gives it to the heading row as the queue goes or comes', () => {
    for (const previous of ['asking', 'used-up', 'running'] as const) {
      assert.equal(queueSectionFocusTarget(previous, 'none'), 'heading', previous);
    }

    // A queue saved elsewhere in place of Set up a queue….
    assert.equal(queueSectionFocusTarget('none', 'running'), 'heading');
    assert.equal(queueSectionFocusTarget('none', 'used-up'), 'heading');
  });

  it('moves none where no control left: the same row, or a running queue used up', () => {
    for (const row of ['none', 'asking', 'used-up', 'running'] as const) {
      assert.equal(queueSectionFocusTarget(row, row), null, row);
    }

    // A capture used up the queue: Run again comes, nothing goes.
    assert.equal(queueSectionFocusTarget('running', 'used-up'), null);
  });
});

describe('a refusal placed at the step its field names (issue #232, D257)', () => {
  /** The steps sent: two, the second with a blank header row before its pairs. */
  const SENT: ResponseForm[] = [
    formFromResponse(response({ status: 500 })),
    {
      ...formFromResponse(response({ status: 503, delayMs: 2000 })),
      headers: [
        { name: '', value: '' },
        { name: 'retry-after', value: '2' },
        { name: 'x-b', value: '2' },
      ],
    },
  ];
  const MESSAGE = 'steps[1].delayMs must be an integer between 0 and 30000';

  function refusal(field: unknown, message = MESSAGE): ApiError {
    return new ApiError(
      400,
      ErrorCode.INVALID_RESPONSE_CONFIG,
      message,
      undefined,
      field as string,
    );
  }

  it('marks the delay of step 2 and names it in the footer, counted from 1 (criterion 5)', () => {
    const error = refusal('steps[1].delayMs');
    const placed = placeQueueRefusal(error, SENT);

    assert.deepEqual(placed, { index: 1, errors: { delayMs: MESSAGE }, marked: true });
    assert.deepEqual(describeQueueFailure(error, 'save', en, placed), {
      kind: 'shown',
      action: 'save',
      text: 'The server rejected step 2. Fix the marked field and save again.',
      retry: true,
      placed: true,
    });
    assert.deepEqual(shownQueueFailure({ action: 'save', error, placed }, ru), {
      action: 'save',
      text: 'Сервер отклонил шаг 2. Исправьте отмеченное поле и сохраните снова.',
      retry: true,
      placed: true,
    });
  });

  it('marks the status, the body, the header list and the k-th pair sent at its row (criterion 6)', () => {
    const cases: [string, unknown][] = [
      ['steps[0].status', { status: 'm' }],
      ['steps[1].body', { body: 'm' }],
      ['steps[1].headers', { headers: 'm' }],
      ['steps[1].headers[0]', { rows: { 1: { name: 'm' } } }],
      ['steps[1].headers[0][0]', { rows: { 1: { name: 'm' } } }],
      ['steps[1].headers[1][1]', { rows: { 2: { value: 'm' } } }],
    ];

    for (const [field, errors] of cases) {
      const placed = placeQueueRefusal(refusal(field, 'm'), SENT);

      assert.deepEqual(placed?.errors, errors, field);
      assert.equal(placed?.marked, true, field);
    }

    assert.equal(placeQueueRefusal(refusal('steps[1].headers[2][0]'), SENT), null);
  });

  it('marks the row of a step refused as a whole or for its template, and says the message', () => {
    for (const field of ['steps[1]', 'steps[1].template']) {
      const message = `${field} must be an object`;
      const error = refusal(field, message);
      const placed = placeQueueRefusal(error, SENT);

      assert.deepEqual(placed, { index: 1, errors: { refused: message }, marked: false });
      assert.equal(
        shownQueueFailure({ action: 'save', error, placed }, en)?.text,
        `The server rejected step 2: ${message}`,
      );
      assert.equal(
        shownQueueFailure({ action: 'save', error, placed }, ru)?.text,
        `Сервер отклонил шаг 2: ${message}`,
      );

      const errors = queueErrorsWithRefusal(evaluateQueue(SENT).errors, placed);

      assert.equal(describeQueueStepRow(SENT[1] as ResponseForm, errors[1] ?? {}).invalid, true);
      assert.equal(
        describeQueueStepRow(SENT[1] as ResponseForm, errors[1] ?? {}).name,
        'has an error',
      );
      assert.equal(describeQueueStepRow(SENT[0] as ResponseForm, errors[0] ?? {}).invalid, false);
    }
  });

  it('keeps today’s footer and marks nothing for a field it cannot place (criterion 7)', () => {
    const fallbacks: unknown[] = [
      undefined,
      'rules[1].path',
      'queue.steps[1].delayMs',
      'steps',
      'steps[20].status',
      'steps[2]',
      'steps[-1]',
      'steps[99999999999999999999]',
      'steps[1].unknown',
      'steps[1].response.status',
      1,
      { field: 'steps[1].delayMs' },
      `steps[1].delayMs${'x'.repeat(1024 * 1024)}`,
    ];

    for (const field of fallbacks) {
      const error = refusal(field);
      const placed = placeQueueRefusal(error, SENT);

      assert.equal(placed, null, JSON.stringify(field)?.slice(0, 40));
      assert.deepEqual(describeQueueFailure(error, 'save', en, placed), {
        kind: 'shown',
        action: 'save',
        text: `The server rejected this queue: ${MESSAGE}`,
        retry: true,
      });
      assert.deepEqual(
        queueErrorsWithRefusal(evaluateQueue(SENT).errors, placed),
        evaluateQueue(SENT).errors,
      );
    }
  });

  it('reads the field and never the message: steps[0] in the message beside steps[1] marks step 2', () => {
    const message = 'steps[0].delayMs must be an integer between 0 and 30000';

    assert.equal(placeQueueRefusal(refusal('steps[1].delayMs', message), SENT)?.index, 1);
    assert.equal(placeQueueRefusal(refusal(undefined, message), SENT), null);
  });

  it('marks the step refused without holding Save back, and goes with the first edit', () => {
    const error = refusal('steps[1].delayMs');
    const placed = placeQueueRefusal(error, SENT);
    const evaluation = evaluateQueue(SENT);

    assert.equal(evaluation.canSave, true);
    assert.deepEqual(queueErrorsWithRefusal(evaluation.errors, placed)[1], { delayMs: MESSAGE });

    const shown = shownQueueFailure({ action: 'save', error, placed });

    assert.equal(failureAfterEdit(shown), null);
    // A refusal the dialog could not place stays until the next call, as before.
    const unplaced = shownQueueFailure({ action: 'save', error, placed: null });

    assert.equal(failureAfterEdit(unplaced), unplaced);
  });
});
