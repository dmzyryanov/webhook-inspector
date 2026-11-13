import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  ErrorCode,
  type ResponseConfig,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { ApiError } from '../api/client.ts';
import { en } from '../i18n/en.ts';
import { ru } from '../i18n/ru.ts';
import {
  DEFAULT_RESPONSE_FORM,
  formFromResponse,
  validateResponseForm,
} from './response-config.ts';
import {
  AUTOMATIC_HEADERS_NOTE,
  BODY_FIELD_LABEL,
  describeChangeFailure,
  editInEditor,
  editorView,
  evaluateEditorDraft,
  formatBodyCounter,
  formatHeaderCounter,
  initialEditorDraft,
  shownChangeFailure,
} from './response-editor.ts';

const KEPT: ResponseConfig = {
  status: 201,
  headers: [
    ['X-Trace-Id', 'abc'],
    ['Retry-After', '30'],
  ],
  body: '{"error":"boom"}',
  delayMs: 500,
  template: false,
};

function answering(response: ResponseConfig): SessionResponseState {
  return { response, customResponse: response, queue: null, rules: [] };
}

describe('formFromResponse', () => {
  it('opens on every field of a saved response, as text', () => {
    assert.deepEqual(formFromResponse(KEPT), {
      status: '201',
      headers: [
        { name: 'X-Trace-Id', value: 'abc' },
        { name: 'Retry-After', value: '30' },
      ],
      body: '{"error":"boom"}',
      delayMs: '500',
      template: false,
    });
  });

  it('opens on the documented defaults when there is nothing saved', () => {
    assert.deepEqual(formFromResponse(null), DEFAULT_RESPONSE_FORM);
  });

  it('shows a response with no body as an empty body field', () => {
    assert.equal(formFromResponse({ ...KEPT, body: null }).body, '');
  });

  it('saves exactly what it was opened on when nothing is touched', () => {
    const { body } = validateResponseForm(formFromResponse(KEPT));

    assert.deepEqual(body, {
      response: { status: 201, headers: KEPT.headers, body: KEPT.body, delayMs: 500 },
    });
  });
});

describe('a template kept through the editor (D251, criterion 10)', () => {
  const TEMPLATE: ResponseConfig = {
    ...KEPT,
    body: '{"id":"{{request.id}}","order":"{{request.body.order.id}}"}',
    template: true,
  };

  it('opens on the flag and saves it again, untouched or with the body edited', () => {
    assert.equal(formFromResponse(TEMPLATE).template, true);
    assert.deepEqual(validateResponseForm(formFromResponse(TEMPLATE)).body, {
      response: {
        status: 201,
        headers: TEMPLATE.headers,
        body: TEMPLATE.body,
        delayMs: 500,
        template: true,
      },
    });

    const edited = evaluateEditorDraft(
      editInEditor(null, answering(TEMPLATE), { form: { body: '{"echo":"{{request.method}}"}' } }),
    );

    assert.deepEqual(edited.request, {
      mode: 'custom',
      response: {
        status: 201,
        headers: TEMPLATE.headers,
        body: '{"echo":"{{request.method}}"}',
        delayMs: 500,
        template: true,
      },
    });
  });

  it('keeps it through a choice carried from the quick switch, and behind Default', () => {
    const carried = initialEditorDraft(answering(TEMPLATE), {
      mode: 'custom',
      statusText: '500',
      delayText: '0',
    });

    assert.deepEqual(evaluateEditorDraft(carried).request, {
      mode: 'custom',
      response: { status: 500, headers: TEMPLATE.headers, body: TEMPLATE.body, template: true },
    });

    const behind = initialEditorDraft({
      response: null,
      customResponse: TEMPLATE,
      queue: null,
      rules: [],
    });

    assert.equal(behind.form.template, true);
    assert.deepEqual(evaluateEditorDraft(behind).request, { mode: 'default' });
    assert.deepEqual(evaluateEditorDraft({ ...behind, mode: 'custom' }).request, {
      mode: 'custom',
      response: {
        status: 201,
        headers: TEMPLATE.headers,
        body: TEMPLATE.body,
        delayMs: 500,
        template: true,
      },
    });
  });

  it('sends no flag for a response that is not one, nor for one from a backend before 1.9.0', () => {
    const older: Partial<ResponseConfig> = { ...KEPT };

    delete older.template;

    for (const response of [KEPT, older as ResponseConfig]) {
      assert.equal(formFromResponse(response).template, false);
      assert.equal(
        'template' in (validateResponseForm(formFromResponse(response)).body?.response ?? {}),
        false,
      );
    }

    assert.equal(DEFAULT_RESPONSE_FORM.template, false);
  });
});

describe('initialEditorDraft', () => {
  it('opens a custom session straight into its form (D2)', () => {
    assert.deepEqual(initialEditorDraft(answering(KEPT)), {
      mode: 'custom',
      form: formFromResponse(KEPT),
    });
  });

  it('opens a session answering the default on Default, with the kept response behind Custom', () => {
    assert.deepEqual(
      initialEditorDraft({ response: null, customResponse: KEPT, queue: null, rules: [] }),
      {
        mode: 'default',
        form: formFromResponse(KEPT),
      },
    );
  });

  it('carries over what the quick switch had chosen (D2)', () => {
    const draft = initialEditorDraft(answering(KEPT), {
      mode: 'custom',
      statusText: '500',
      delayText: '0',
    });

    assert.equal(draft.mode, 'custom');
    assert.equal(draft.form.status, '500');
    assert.equal(draft.form.delayMs, '0');
    // Headers and body are the kept ones: the switch never touches them.
    assert.deepEqual(draft.form.headers, formFromResponse(KEPT).headers);
    assert.equal(draft.form.body, KEPT.body);
  });
});

describe('evaluateEditorDraft', () => {
  it('sends the whole custom response the form holds', () => {
    const evaluation = evaluateEditorDraft({
      mode: 'custom',
      form: { ...formFromResponse(KEPT), status: '500', delayMs: '0' },
    });

    assert.equal(evaluation.canSave, true);
    assert.deepEqual(evaluation.request, {
      mode: 'custom',
      response: { status: 500, headers: KEPT.headers, body: KEPT.body },
    });
  });

  it("reports the validator's errors, in its wording, and cannot save (D4)", () => {
    const form = {
      ...formFromResponse(KEPT),
      status: '99',
      headers: [{ name: 'Set-Cookie', value: 'abc' }],
      body: 'a'.repeat(65537),
    };
    const evaluation = evaluateEditorDraft({ mode: 'custom', form });

    assert.equal(evaluation.canSave, false);
    assert.equal(evaluation.request, null);
    assert.deepEqual(evaluation.errors, validateResponseForm(form).errors);
    assert.ok(evaluation.errors.status);
    assert.ok(evaluation.errors.rows?.[0]?.name);
    assert.ok(evaluation.errors.body);
  });

  it('saves a body that is not valid JSON and a Content-Type row, with no error (D179)', () => {
    for (const [contentType, body] of [
      ['application/json', '{"error":"boom",}'],
      ['text/plain', 'OK'],
      ['text/xml', '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"/>'],
      ['text/html', '<h1>502 Bad Gateway</h1>'],
    ] as const) {
      const evaluation = evaluateEditorDraft({
        mode: 'custom',
        form: {
          ...formFromResponse(KEPT),
          headers: [{ name: 'Content-Type', value: contentType }],
          body,
        },
      });

      assert.deepEqual(evaluation.errors, {}, body);
      assert.equal(evaluation.canSave, true, body);
      assert.deepEqual(evaluation.request, {
        mode: 'custom',
        response: {
          status: 201,
          headers: [['Content-Type', contentType]],
          body,
          delayMs: 500,
        },
      });
    }
  });

  /**
   * 204, 205 and 304 take no body: the refusal is reported on the body field
   * (frame D5 of the Figma page `Webhook Inspector · Editable response settings`).
   */
  it('refuses 204, 205 and 304 while a body is set, on the body', () => {
    for (const status of ['204', '205', '304']) {
      const evaluation = evaluateEditorDraft({
        mode: 'custom',
        form: { ...formFromResponse(KEPT), status },
      });

      assert.equal(evaluation.canSave, false, status);
      assert.equal(evaluation.errors.status, undefined, status);
      assert.ok(evaluation.errors.body, status);
    }
  });

  /**
   * Picking Default hides the custom fields and keeps them (frame D6 of the
   * Figma page `Webhook Inspector · Editable response settings`).
   */
  it('sends the mode alone for Default, whatever the hidden fields hold', () => {
    for (const form of [
      formFromResponse(KEPT),
      { ...formFromResponse(KEPT), status: 'nonsense' },
    ]) {
      const evaluation = evaluateEditorDraft({ mode: 'default', form });

      assert.equal(evaluation.canSave, true);
      assert.deepEqual(evaluation.errors, {});
      assert.deepEqual(evaluation.request, { mode: 'default' });
    }
  });
});

describe('the body field and the automatic headers note (D179)', () => {
  it('names no format in the label, and the template box took the hint’s line (#236)', () => {
    assert.equal(BODY_FIELD_LABEL, 'Body · Optional');
    // `Returned exactly as entered` is gone from both languages: the unticked
    // `Fill in placeholders from the request` says it now, on that line (frame
    // T1 of the Figma page `Webhook Inspector · Response body templates (#236)
    // — approved A`).
    for (const m of [en, ru]) {
      assert.equal('bodyHint' in m.editor, false, m.lang);
    }
  });

  it('renders them in the editor, where nothing about JSON is left', () => {
    // The fields are the editor's and the queue's both (D205): one component.
    const editor = readFileSync(
      new URL('../components/SessionResponseEditor.tsx', import.meta.url),
      'utf8',
    );
    const fields = readFileSync(
      new URL('../components/ResponseFields.tsx', import.meta.url),
      'utf8',
    );

    assert.match(editor, /<ResponseFields /);
    // The interface's words (D222); the constants hold the English ones.
    assert.match(fields, /\{m\.editor\.bodyLabel\}/);
    assert.equal(fields.includes('bodyHint'), false);
    assert.equal(BODY_FIELD_LABEL, en.editor.bodyLabel);

    for (const gone of ['JSON body · Optional', 'Valid JSON or empty', 'must be valid JSON']) {
      assert.equal(editor.includes(gone), false, gone);
      assert.equal(fields.includes(gone), false, gone);
    }
  });

  it('adds Content-Type only when there is a body and none is set, and names the CSP', () => {
    assert.equal(
      AUTOMATIC_HEADERS_NOTE,
      'Added automatically: X-Webhook-Inspector-Request-Id, X-QA-Tools-Request-Id, X-Content-Type-Options, Content-Security-Policy; Content-Type too, when there is a body and none is set here. Reserved headers cannot be added.',
    );
  });
});

describe('the counters (D2)', () => {
  it('counts the body in UTF-8 bytes against the limit, grouped as the design writes it', () => {
    assert.equal(formatBodyCounter('{"error":"boom"}'), '16 / 65,536 bytes');
    // Five characters, eight bytes.
    assert.equal(formatBodyCounter('"дом"'), '8 / 65,536 bytes');
    assert.equal(formatBodyCounter(''), '0 / 65,536 bytes');
  });

  it('counts header rows against the limit', () => {
    assert.equal(formatHeaderCounter(formFromResponse(KEPT)), '2 / 20');
    assert.equal(formatHeaderCounter(DEFAULT_RESPONSE_FORM), '0 / 20');
  });
});

describe('describeChangeFailure', () => {
  it('moves the page to Session not found when the session is gone', () => {
    for (const errorCode of [ErrorCode.SESSION_NOT_FOUND, ErrorCode.SESSION_EXPIRED]) {
      const error = new ApiError(
        errorCode === ErrorCode.SESSION_EXPIRED ? 410 : 404,
        errorCode,
        'x',
      );

      assert.deepEqual(describeChangeFailure(error, 'editor'), { kind: 'unavailable' });
      assert.deepEqual(describeChangeFailure(error, 'quick switch'), { kind: 'unavailable' });
    }
  });

  it('shows a refused configuration with the server message', () => {
    const error = new ApiError(
      400,
      ErrorCode.INVALID_RESPONSE_CONFIG,
      'response.body must be at most 65536 bytes of UTF-8',
    );

    assert.deepEqual(describeChangeFailure(error, 'editor'), {
      kind: 'shown',
      title: 'Could not save the response',
      text: 'The server rejected this configuration: response.body must be at most 65536 bytes of UTF-8',
    });
  });

  it('keeps the choice and asks for another try on anything else (C8, D8)', () => {
    for (const error of [
      new TypeError('Failed to fetch'),
      new ApiError(500, ErrorCode.INTERNAL_ERROR, 'x'),
    ]) {
      assert.deepEqual(describeChangeFailure(error, 'quick switch'), {
        kind: 'shown',
        title: 'Could not apply the change',
        text: 'Something went wrong. Your choice is kept. Please try again.',
      });
      assert.deepEqual(describeChangeFailure(error, 'editor'), {
        kind: 'shown',
        title: 'Could not save the response',
        text: 'Something went wrong. Your changes are kept. Please try again.',
      });
    }
  });
});

/**
 * A failure is held as its error and put into words each time it is shown,
 * so one on screen in the non-modal quick switch follows the `EN | RU`
 * switch (D222).
 */
describe('shownChangeFailure', () => {
  const refused = new ApiError(
    400,
    ErrorCode.INVALID_RESPONSE_CONFIG,
    'response.status must be an integer from 100 to 599',
  );
  const failed = new ApiError(500, ErrorCode.INTERNAL_ERROR, 'Internal server error');

  it('says the same held failure in the language it is shown in', () => {
    for (const surface of ['quick switch', 'editor'] as const) {
      for (const m of [en, ru]) {
        const title = surface === 'editor' ? m.editor.saveFailed : m.editor.applyFailed;

        assert.deepEqual(shownChangeFailure({ error: refused }, surface, m), {
          title,
          text: m.editor.rejected('response.status must be an integer from 100 to 599'),
        });
        assert.deepEqual(shownChangeFailure({ error: failed }, surface, m), {
          title,
          text: surface === 'editor' ? m.editor.changesKept : m.editor.choiceKept,
        });
      }

      // Held once, written twice: nothing of the first language is left in the second.
      const held = { error: failed };
      const english = shownChangeFailure(held, surface, en);
      const russian = shownChangeFailure(held, surface, ru);

      assert.notEqual(english?.title, russian?.title);
      assert.notEqual(english?.text, russian?.text);
      assert.doesNotMatch(`${russian?.title} ${russian?.text}`, /[A-Za-z]/);
    }
  });

  it('shows nothing for none, and for a session gone, which moves the page instead', () => {
    assert.equal(shownChangeFailure(null, 'quick switch', ru), null);
    assert.equal(
      shownChangeFailure(
        { error: new ApiError(404, ErrorCode.SESSION_NOT_FOUND, 'x') },
        'editor',
        ru,
      ),
      null,
    );
  });
});

/** The editor follows the quick switch's rule for other tabs' changes (D152). */
describe('editorView and editInEditor', () => {
  const elsewhere = answering({ ...KEPT, status: 503, body: null });

  it('follows the session while nothing has been edited', () => {
    assert.deepEqual(editorView(null, answering(KEPT)), initialEditorDraft(answering(KEPT)));
    assert.deepEqual(editorView(null, elsewhere).form.status, '503');
    assert.deepEqual(
      editorView(null, { response: null, customResponse: KEPT, queue: null, rules: [] }).mode,
      'default',
    );
  });

  it('keeps the viewer draft once anything has been edited, whatever arrives next', () => {
    const edited = editInEditor(null, answering(KEPT), { form: { body: '{"mine":true}' } });

    assert.deepEqual(editorView(edited, elsewhere), edited);
    assert.equal(editorView(edited, elsewhere).form.body, '{"mine":true}');
  });

  it('counts a choice carried in from the quick switch as an edit', () => {
    const carried = initialEditorDraft(answering(KEPT), {
      mode: 'custom',
      statusText: '500',
      delayText: '0',
    });

    assert.deepEqual(editorView(carried, elsewhere), carried);
  });

  it('starts the first edit from the session as it is at that moment', () => {
    const edited = editInEditor(null, elsewhere, { form: { delayMs: '100' } });

    assert.equal(edited.form.status, '503');
    assert.equal(edited.form.body, '');
    assert.equal(edited.form.delayMs, '100');
  });

  it('changes the mode alone and leaves the form as it was', () => {
    const first = editInEditor(null, answering(KEPT), { form: { status: '500' } });
    const toDefault = editInEditor(first, elsewhere, { mode: 'default' });

    assert.equal(toDefault.mode, 'default');
    assert.deepEqual(toDefault.form, first.form);
  });
});
