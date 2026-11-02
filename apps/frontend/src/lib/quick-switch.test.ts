import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ResponseConfig, SessionResponseState } from '@webhook-inspector/shared';
import {
  DELAY_CHIPS,
  STATUS_CHIPS,
  carryQuickDraft,
  chooseInQuickSwitch,
  describeUntouched,
  evaluateQuickDraft,
  focusLost,
  initialQuickDraft,
  quickSwitchView,
  statusUnavailableReason,
  type QuickDraft,
  quickSwitchPageInert,
  quickSwitchReturnsFocus,
  type FocusHolder,
} from './quick-switch.ts';

function custom(overrides: Partial<ResponseConfig> = {}): ResponseConfig {
  return {
    status: 201,
    headers: [['x-trace-id', 'abc']],
    body: '{"ok":true}',
    delayMs: 500,
    template: false,
    ...overrides,
  };
}

/** A session answering its custom response. */
function answering(response: ResponseConfig): SessionResponseState {
  return { response, customResponse: response, queue: null, rules: [] };
}

/** A session answering the default, keeping `kept`. */
function keeping(kept: ResponseConfig | null): SessionResponseState {
  return { response: null, customResponse: kept, queue: null, rules: [] };
}

describe('the chips (C1)', () => {
  it('offers the design status and delay chips, in order', () => {
    assert.deepEqual(STATUS_CHIPS, [200, 201, 204, 400, 404, 500, 503]);
    assert.deepEqual(
      DELAY_CHIPS.map((chip) => [chip.ms, chip.label]),
      [
        [0, 'None'],
        [500, '0.5 s'],
        [2000, '2 s'],
        [10000, '10 s'],
        [30000, '30 s'],
      ],
    );
  });
});

describe('initialQuickDraft', () => {
  it('opens on the session as it is: mode, status chip and delay chip (C1)', () => {
    assert.deepEqual(initialQuickDraft(answering(custom())), {
      mode: 'custom',
      status: { kind: 'chip', value: 201 },
      delay: { kind: 'chip', value: 500 },
    });
  });

  it('opens a value that is not a chip in the free field', () => {
    assert.deepEqual(initialQuickDraft(answering(custom({ status: 299, delayMs: 1500 }))), {
      mode: 'custom',
      status: { kind: 'typed', text: '299' },
      delay: { kind: 'typed', text: '1500' },
    });
  });

  it('opens a default session on Default, with the kept status and delay behind Custom (C4)', () => {
    assert.deepEqual(initialQuickDraft(keeping(custom())), {
      mode: 'default',
      status: { kind: 'chip', value: 201 },
      delay: { kind: 'chip', value: 500 },
    });
  });

  it('opens a session that never had a custom response on 200 and no delay', () => {
    assert.deepEqual(initialQuickDraft(keeping(null)), {
      mode: 'default',
      status: { kind: 'chip', value: 200 },
      delay: { kind: 'chip', value: 0 },
    });
  });
});

describe('evaluateQuickDraft', () => {
  it('has nothing to apply while nothing is chosen (C1)', () => {
    const state = answering(custom());
    const evaluation = evaluateQuickDraft(initialQuickDraft(state), state);

    assert.equal(evaluation.changed, false);
    assert.equal(evaluation.canApply, false);
    assert.equal(evaluation.footer, 'Applies to requests captured from now on.');
    assert.equal(evaluation.footerIsChange, false);
    assert.equal(evaluation.request, null);
  });

  it('describes 500 and no delay picked, and sends the kept headers and body (C2)', () => {
    const state = answering(custom());
    const draft: QuickDraft = {
      mode: 'custom',
      status: { kind: 'chip', value: 500 },
      delay: { kind: 'chip', value: 0 },
    };
    const evaluation = evaluateQuickDraft(draft, state);

    assert.equal(evaluation.footer, '201 → 500 · 500 ms → none');
    assert.equal(evaluation.footerIsChange, true);
    assert.equal(evaluation.canApply, true);
    assert.deepEqual(evaluation.request, {
      mode: 'custom',
      response: {
        status: 500,
        headers: [['x-trace-id', 'abc']],
        body: '{"ok":true}',
        delayMs: 0,
      },
    });
  });

  it('names only what changed', () => {
    const state = answering(custom());

    assert.equal(
      evaluateQuickDraft(
        {
          mode: 'custom',
          status: { kind: 'chip', value: 404 },
          delay: { kind: 'chip', value: 500 },
        },
        state,
      ).footer,
      '201 → 404',
    );
    assert.equal(
      evaluateQuickDraft(
        {
          mode: 'custom',
          status: { kind: 'chip', value: 201 },
          delay: { kind: 'typed', text: '1500' },
        },
        state,
      ).footer,
      '500 ms → 1500 ms',
    );
  });

  it('sends the mode alone when Default is picked, keeping the custom response (C4)', () => {
    const state = answering(custom());
    const evaluation = evaluateQuickDraft({ ...initialQuickDraft(state), mode: 'default' }, state);

    assert.equal(evaluation.footer, 'Custom 201 → Default');
    assert.equal(evaluation.canApply, true);
    assert.deepEqual(evaluation.request, { mode: 'default' });
  });

  it('restores the kept response when Custom is picked on a session answering the default', () => {
    const state = keeping(custom());
    const evaluation = evaluateQuickDraft({ ...initialQuickDraft(state), mode: 'custom' }, state);

    assert.equal(evaluation.footer, 'Default → Custom 201');
    assert.deepEqual(evaluation.request, {
      mode: 'custom',
      response: {
        status: 201,
        headers: [['x-trace-id', 'abc']],
        body: '{"ok":true}',
        delayMs: 500,
      },
    });
  });

  it('has nothing to apply when Default is picked on a session answering the default', () => {
    const state = keeping(custom());
    const evaluation = evaluateQuickDraft(initialQuickDraft(state), state);

    assert.equal(evaluation.canApply, false);
    assert.equal(evaluation.request, null);
  });

  it('refuses a typed status out of range, and accepts a typed delay (C5)', () => {
    const state = answering(custom());
    const evaluation = evaluateQuickDraft(
      {
        mode: 'custom',
        status: { kind: 'typed', text: '700' },
        delay: { kind: 'typed', text: '1500' },
      },
      state,
    );

    assert.equal(evaluation.statusError, 'Enter an integer from 200 to 599.');
    assert.equal(evaluation.delayError, null);
    assert.equal(evaluation.footer, 'Fix the status to apply.');
    assert.equal(evaluation.canApply, false);
    assert.equal(evaluation.request, null);
  });

  it('refuses what is not a whole number, in either field', () => {
    const state = answering(custom());

    for (const text of ['', ' ', 'abc', '200.5', '-1', '1e3', '199', '600']) {
      assert.notEqual(
        evaluateQuickDraft(
          { mode: 'custom', status: { kind: 'typed', text }, delay: { kind: 'chip', value: 0 } },
          state,
        ).statusError,
        null,
        text,
      );
    }

    const delay = evaluateQuickDraft(
      {
        mode: 'custom',
        status: { kind: 'chip', value: 200 },
        delay: { kind: 'typed', text: '30001' },
      },
      state,
    );

    assert.equal(delay.delayError, 'Enter an integer from 0 to 30000.');
    assert.equal(delay.footer, 'Fix the delay to apply.');

    const both = evaluateQuickDraft(
      { mode: 'custom', status: { kind: 'typed', text: 'x' }, delay: { kind: 'typed', text: 'y' } },
      state,
    );

    assert.equal(both.footer, 'Fix the status and delay to apply.');
  });

  it('accepts a typed status anywhere in 200-599, and the delay bounds', () => {
    const state = answering(custom());

    for (const [status, delay] of [
      ['200', '0'],
      ['599', '30000'],
      [' 299 ', '1'],
    ]) {
      const evaluation = evaluateQuickDraft(
        {
          mode: 'custom',
          status: { kind: 'typed', text: status as string },
          delay: { kind: 'typed', text: delay as string },
        },
        state,
      );

      assert.equal(evaluation.statusError, null, status);
      assert.equal(evaluation.delayError, null, delay);
    }
  });

  /** Owner's rule 2: 204, 205 and 304 while a body is set are an error. */
  it('refuses a typed 205 or 304 while a body is set, under its field (C6)', () => {
    const state = answering(custom());

    for (const status of ['204', '205', '304']) {
      const evaluation = evaluateQuickDraft(
        {
          mode: 'custom',
          status: { kind: 'typed', text: status },
          delay: { kind: 'chip', value: 0 },
        },
        state,
      );

      assert.equal(evaluation.statusError, `${status} needs an empty body — clear the body first.`);
      assert.equal(evaluation.canApply, false);
    }
  });

  it('accepts those statuses when the kept response has no body', () => {
    const state = answering(custom({ body: null }));

    for (const status of ['204', '205', '304']) {
      const evaluation = evaluateQuickDraft(
        {
          mode: 'custom',
          status: { kind: 'typed', text: status },
          delay: { kind: 'chip', value: 0 },
        },
        state,
      );

      assert.equal(evaluation.statusError, null, status);
      assert.equal(evaluation.canApply, true);
    }
  });

  it('keeps a template one through a status or a delay change, and back to Custom (D251, criterion 10)', () => {
    const template = custom({ body: '{"id":"{{request.id}}"}', template: true });
    const draft: QuickDraft = {
      mode: 'custom',
      status: { kind: 'chip', value: 500 },
      delay: { kind: 'chip', value: 2000 },
    };

    for (const state of [answering(template), keeping(template)]) {
      assert.deepEqual(evaluateQuickDraft(draft, state).request, {
        mode: 'custom',
        response: { ...template, status: 500, delayMs: 2000 },
      });
    }

    const back = keeping(template);

    assert.deepEqual(
      evaluateQuickDraft({ ...initialQuickDraft(back), mode: 'custom' }, back).request,
      { mode: 'custom', response: template },
    );
    // Default leaves the kept response, flag and all, where it is.
    assert.deepEqual(
      evaluateQuickDraft(
        { ...initialQuickDraft(answering(template)), mode: 'default' },
        answering(template),
      ).request,
      { mode: 'default' },
    );
  });

  it('sends a response from a backend before 1.9.0, with no flag, as no template', () => {
    const older: Partial<ResponseConfig> = { ...custom() };

    delete older.template;
    const state = keeping(older as ResponseConfig);

    assert.deepEqual(
      evaluateQuickDraft({ ...initialQuickDraft(state), mode: 'custom' }, state).request,
      { mode: 'custom', response: older },
    );
  });

  it('sends no template key unless the kept response is one, which the previous image would refuse (D251)', () => {
    const older: Partial<ResponseConfig> = { ...custom() };

    delete older.template;
    const changes: QuickDraft[] = [
      { mode: 'custom', status: { kind: 'chip', value: 500 }, delay: { kind: 'chip', value: 0 } },
      {
        mode: 'custom',
        status: { kind: 'typed', text: '299' },
        delay: { kind: 'typed', text: '1500' },
      },
    ];

    for (const state of [
      answering(custom()),
      keeping(custom()),
      keeping(null),
      keeping(older as ResponseConfig),
    ]) {
      // Back to Custom is no change on a session answering it already.
      const drafts: QuickDraft[] = [
        ...(state.response === null
          ? [{ ...initialQuickDraft(state), mode: 'custom' as const }]
          : []),
        ...changes,
      ];

      for (const draft of drafts) {
        const { request } = evaluateQuickDraft(draft, state);

        if (request?.mode !== 'custom') {
          assert.fail(`no custom change: ${JSON.stringify(request)}`);
        }

        assert.equal(Object.hasOwn(request.response, 'template'), false, JSON.stringify(request));
      }
    }

    const template = answering(custom({ body: '{"id":"{{request.id}}"}', template: true }));
    const { request } = evaluateQuickDraft(
      { mode: 'custom', status: { kind: 'chip', value: 500 }, delay: { kind: 'chip', value: 0 } },
      template,
    );

    if (request?.mode !== 'custom') {
      assert.fail(`no custom change: ${JSON.stringify(request)}`);
    }

    assert.equal(request.response.template, true);
  });

  it('measures a change against the session as it is now, not as it was opened (D152)', () => {
    const draft: QuickDraft = {
      mode: 'custom',
      status: { kind: 'chip', value: 500 },
      delay: { kind: 'chip', value: 0 },
    };

    // Another tab has meanwhile applied exactly this choice.
    const evaluation = evaluateQuickDraft(draft, answering(custom({ status: 500, delayMs: 0 })));

    assert.equal(evaluation.changed, false);
    assert.equal(evaluation.canApply, false);
  });
});

describe('statusUnavailableReason', () => {
  it('makes 204 unavailable while a body is kept, with the reason C6 shows on hover', () => {
    assert.equal(
      statusUnavailableReason(204, custom()),
      '204 needs an empty body — clear the body first.',
    );
  });

  it('leaves every status available without a body', () => {
    for (const status of STATUS_CHIPS) {
      assert.equal(statusUnavailableReason(status, custom({ body: null })), null);
      assert.equal(statusUnavailableReason(status, null), null);
    }
  });

  it('leaves every other chip available with a body', () => {
    for (const status of STATUS_CHIPS.filter((value) => value !== 204)) {
      assert.equal(statusUnavailableReason(status, custom()), null);
    }
  });
});

describe('describeUntouched', () => {
  it('says headers and body stay, and why 204 is unavailable, as C1 does', () => {
    assert.equal(
      describeUntouched(custom()),
      'Headers (1) and body stay as they are. 204 needs an empty body.',
    );
  });

  it('says there is no body when there is none', () => {
    assert.equal(
      describeUntouched(custom({ body: null, headers: [] })),
      'Headers (0) stay as they are, with no body.',
    );
    assert.equal(describeUntouched(null), 'Headers (0) stay as they are, with no body.');
  });
});

describe('carryQuickDraft', () => {
  it('hands the full editor the mode and both fields as text (D2)', () => {
    assert.deepEqual(
      carryQuickDraft({
        mode: 'custom',
        status: { kind: 'chip', value: 500 },
        delay: { kind: 'typed', text: '1500' },
      }),
      { mode: 'custom', statusText: '500', delayText: '1500' },
    );
  });
});

/**
 * The rule for an open switch while another tab changes the response (D152):
 * follow the session until the first choice, then keep the viewer's draft.
 */
describe('quickSwitchView and chooseInQuickSwitch', () => {
  const before = answering(custom());
  const elsewhere = answering(custom({ status: 404, delayMs: 2000 }));

  it('follows the session while nothing has been chosen', () => {
    assert.deepEqual(quickSwitchView(null, before), initialQuickDraft(before));
    assert.deepEqual(quickSwitchView(null, elsewhere), {
      mode: 'custom',
      status: { kind: 'chip', value: 404 },
      delay: { kind: 'chip', value: 2000 },
    });
  });

  it('keeps the viewer draft once anything has been chosen, whatever arrives next', () => {
    const chosen = chooseInQuickSwitch(null, before, { status: { kind: 'chip', value: 500 } });

    assert.deepEqual(quickSwitchView(chosen, elsewhere), chosen);
    assert.deepEqual(quickSwitchView(chosen, keeping(null)), chosen);
  });

  it('starts the first choice from the session as it is at that moment', () => {
    // Another tab changed status and delay before anything was chosen here;
    // choosing only the delay keeps that tab's status.
    const chosen = chooseInQuickSwitch(null, elsewhere, { delay: { kind: 'chip', value: 0 } });

    assert.deepEqual(chosen, {
      mode: 'custom',
      status: { kind: 'chip', value: 404 },
      delay: { kind: 'chip', value: 0 },
    });
  });

  it('builds every later choice on the draft, not on the session', () => {
    const first = chooseInQuickSwitch(null, before, { status: { kind: 'chip', value: 500 } });
    const second = chooseInQuickSwitch(first, elsewhere, { delay: { kind: 'chip', value: 0 } });

    assert.deepEqual(second, {
      mode: 'custom',
      status: { kind: 'chip', value: 500 },
      delay: { kind: 'chip', value: 0 },
    });
  });
});

describe('the quick switch on a phone (D157)', () => {
  it('makes the page inert only under an open bottom sheet', () => {
    assert.equal(quickSwitchPageInert({ open: true, phone: true }), true);
    assert.equal(quickSwitchPageInert({ open: false, phone: true }), false);
    assert.equal(quickSwitchPageInert({ open: true, phone: false }), false);
    assert.equal(quickSwitchPageInert({ open: false, phone: false }), false);
  });

  it('puts focus back on the button however the sheet closed, a scrim tap included', () => {
    assert.equal(quickSwitchReturnsFocus({ phone: true, handingOver: false }), true);
  });

  it('leaves focus alone when it hands over to the full editor', () => {
    assert.equal(quickSwitchReturnsFocus({ phone: true, handingOver: true }), false);
  });

  it("leaves the popover's focus to Radix from 768 px up, as before", () => {
    assert.equal(quickSwitchReturnsFocus({ phone: false, handingOver: false }), false);
    assert.equal(quickSwitchReturnsFocus({ phone: false, handingOver: true }), false);
  });
});

describe('focus lost in the quick switch (D206; issue #143)', () => {
  /** A node of a fake tree: it contains itself and every node under it. */
  interface Fake extends FocusHolder {
    parent: Fake | null;
  }

  function node(parent: Fake | null): Fake {
    const self: Fake = {
      parent,
      contains(other) {
        for (let at = other as Fake | null; at !== null; at = at.parent) {
          if (at === self) {
            return true;
          }
        }

        return false;
      },
    };

    return self;
  }

  // body > page > copy, and body > popover > section > button.
  const body = node(null);
  const page = node(body);
  const copy = node(page);
  const popover = node(body);
  const section = node(popover);
  const button = node(section);

  it('is lost on nothing and on the page body, where Chromium drops a disabled or removed button', () => {
    assert.equal(focusLost(section, null, body), true);
    assert.equal(focusLost(section, body, body), true);
    assert.equal(focusLost(null, body, body), true);
  });

  it('is lost on the popover itself, which a click on its background focuses', () => {
    assert.equal(focusLost(section, popover, body), true);
    assert.equal(focusLost(button, popover, body), true);
  });

  it('stays on a control the viewer put it on, in the popover or out of it', () => {
    // The heading row or another of the section's controls.
    assert.equal(focusLost(section, button, body), false);
    // Copy, or the EN | RU switch, beside the popover.
    assert.equal(focusLost(section, copy, body), false);
    assert.equal(focusLost(button, copy, body), false);
    // Apply itself, seen from Apply: still there, not lost.
    assert.equal(focusLost(button, button, body), false);
    // Nothing to hold where the element is not drawn: only nothing or the body.
    assert.equal(focusLost(null, popover, body), false);
  });
});
