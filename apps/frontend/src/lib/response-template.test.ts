import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  ErrorCode,
  MAX_RESPONSE_BODY_BYTES,
  type ResponseConfig,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import {
  TEMPLATE_PLACEHOLDERS,
  templateProblem,
} from '@webhook-inspector/shared/response-template';
import { ApiError } from '../api/client.ts';
import { en } from '../i18n/en.ts';
import { ru } from '../i18n/ru.ts';
import {
  DEFAULT_RESPONSE_FORM,
  firstErrorField,
  formFromResponse,
  validateResponseForm,
  type ResponseForm,
} from './response-config.ts';
import { describeChangeFailure, evaluateEditorDraft } from './response-editor.ts';
import {
  describeQueueChips,
  describeQueueFailure,
  evaluateQueue,
  formatSectionStepChip,
  queueSectionView,
} from './response-queue.ts';
import {
  describeRulesFailure,
  evaluateRules,
  newRuleForm,
  rulesSectionView,
} from './response-rules.ts';
import {
  HINT_EXAMPLE,
  PLACEHOLDER_CHOICES,
  SHOWN_PLACEHOLDER_MAX,
  insertPlaceholder,
  isTemplate,
  placeholderAt,
  shownPlaceholder,
  templateError,
  textParts,
  type PlaceholderChoice,
} from './response-template.ts';

function choice(key: PlaceholderChoice['key']): PlaceholderChoice {
  const found = PLACEHOLDER_CHOICES.find((candidate) => candidate.key === key);

  assert.ok(found, key);

  return found;
}

function form(body: string, template = true, status = '200'): ResponseForm {
  return { ...DEFAULT_RESPONSE_FORM, status, body, template };
}

const RESPONSE: ResponseConfig = {
  status: 201,
  headers: [],
  body: '{"id":"{{request.id}}"}',
  delayMs: 0,
  template: true,
};

/** Milliseconds `run` takes. */
function timed(run: () => void): number {
  const started = performance.now();

  run();

  return performance.now() - started;
}

describe('the placeholder list (#236, criterion 2)', () => {
  it('offers each placeholder of the server’s set, in its order, the three to finish last', () => {
    assert.deepEqual(
      PLACEHOLDER_CHOICES.map((item) => item.key),
      ['requestId', 'method', 'path', 'query', 'header', 'body'],
    );
    // The set is the shared module's, the very one the server checks with
    // (D251): what is inserted is each placeholder with its `<...>` left for
    // the user to type.
    assert.deepEqual(
      PLACEHOLDER_CHOICES.map((item) => item.text),
      TEMPLATE_PLACEHOLDERS.map((placeholder) => placeholder.replace(/<[a-z]+>/, '')),
    );
    assert.deepEqual(
      PLACEHOLDER_CHOICES.map((item) => item.stub),
      [false, false, false, true, true, true],
    );
    assert.deepEqual(
      PLACEHOLDER_CHOICES.map((item) => item.shown),
      [
        '{{request.id}}',
        '{{request.method}}',
        '{{request.path}}',
        '{{request.query.…}}',
        '{{request.header.…}}',
        '{{request.body.…}}',
      ],
    );
    assert.equal(HINT_EXAMPLE, '{{request.id}}');
  });

  it('names each item in both languages, as the strings list gives them', () => {
    assert.deepEqual(
      PLACEHOLDER_CHOICES.map((item) => en.template[item.key]),
      ['Request id', 'Method', 'Path', 'Query parameter…', 'Header…', 'JSON body field…'],
    );
    assert.deepEqual(
      PLACEHOLDER_CHOICES.map((item) => ru.template[item.key]),
      [
        'Идентификатор запроса',
        'Метод',
        'Путь',
        'Параметр запроса…',
        'Заголовок…',
        'Поле JSON-тела…',
      ],
    );
  });

  it('inserts a whole placeholder at the caret, the caret after it, and it reads as a template', () => {
    for (const key of ['requestId', 'method', 'path'] as const) {
      const item = choice(key);
      const body = '{"id": "", "ok": true}';
      const at = body.indexOf('""') + 1;
      const inserted = insertPlaceholder(body, at, at, item);

      assert.equal(inserted.body, `{"id": "${item.text}", "ok": true}`);
      assert.equal(inserted.caret, at + item.text.length);
      assert.equal(templateProblem(inserted.body), null, key);
      assert.equal(templateError(inserted.body), undefined, key);
    }
  });

  it('inserts a stub with the caret before }}, where a typed name or path finishes it', () => {
    for (const [key, typed] of [
      ['query', 'page'],
      ['header', 'X-Trace-Id'],
      ['body', 'order.items.0.id'],
    ] as const) {
      const item = choice(key);
      const inserted = insertPlaceholder('', 0, 0, item);

      assert.equal(inserted.body, item.text);
      assert.equal(inserted.body.slice(inserted.caret), '}}', key);
      // Unfinished, the editor asks for the rest, as the server refuses it.
      assert.notEqual(templateProblem(inserted.body), null, key);
      assert.match(templateError(inserted.body) ?? '', /^Finish /, key);

      const finished = `${inserted.body.slice(0, inserted.caret)}${typed}${inserted.body.slice(inserted.caret)}`;

      assert.equal(templateProblem(finished), null, key);
      assert.equal(templateError(finished), undefined, key);
    }
  });

  it('replaces a selection, given either way round', () => {
    const body = 'id=XXXX;';
    const item = choice('requestId');

    for (const [start, end] of [
      [3, 7],
      [7, 3],
    ]) {
      const inserted = insertPlaceholder(body, start as number, end as number, item);

      assert.equal(inserted.body, 'id={{request.id}};');
      assert.equal(inserted.caret, 3 + item.text.length);
    }
  });

  it('inserts at the start and the end, and keeps a stale range inside the body', () => {
    const item = choice('method');

    assert.deepEqual(insertPlaceholder('ab', 0, 0, item), {
      body: '{{request.method}}ab',
      caret: 18,
    });
    assert.deepEqual(insertPlaceholder('ab', 2, 2, item), {
      body: 'ab{{request.method}}',
      caret: 20,
    });
    assert.deepEqual(insertPlaceholder('ab', 99, 120, item), {
      body: 'ab{{request.method}}',
      caret: 20,
    });
    assert.deepEqual(insertPlaceholder('ab', -5, 1, item), {
      body: '{{request.method}}b',
      caret: 18,
    });
    for (const [start, end] of [
      [Number.NaN, Number.NaN],
      [Number.NaN, 1],
      [0, Number.POSITIVE_INFINITY],
    ]) {
      assert.deepEqual(insertPlaceholder('ab', start as number, end as number, item), {
        body: 'ab{{request.method}}',
        caret: 20,
      });
    }
  });

  it('keeps a multi-byte body whole around the caret', () => {
    const body = 'дом 🏠 ok';
    const at = body.indexOf(' ok');
    const inserted = insertPlaceholder(body, at, at, choice('path'));

    assert.equal(inserted.body, 'дом 🏠{{request.path}} ok');
  });
});

describe('the editor’s check of a template (#236, criterion 3)', () => {
  it('names an unknown placeholder as it was typed, in both languages (T12)', () => {
    assert.equal(
      templateError('{"id": "{{request.foo}}", "received": true}'),
      'Unknown placeholder {{request.foo}}.',
    );
    assert.equal(
      templateError('{"id": "{{request.foo}}"}', ru),
      'Неизвестная подстановка {{request.foo}}.',
    );
  });

  it('asks for a stub’s name or path, and says an unclosed {{ is one', () => {
    assert.equal(
      templateError('{{request.header.}}'),
      'Finish {{request.header.}}: type the name before }}.',
    );
    assert.equal(
      templateError('{{request.query.}}'),
      'Finish {{request.query.}}: type the name before }}.',
    );
    assert.equal(
      templateError('{{request.body.}}'),
      'Finish {{request.body.}}: type the field path before }}.',
    );
    assert.equal(
      templateError('{{request.header.}}', ru),
      'Допишите {{request.header.}}: имя перед }}.',
    );
    assert.equal(
      templateError('{{request.body.}}', ru),
      'Допишите {{request.body.}}: путь к полю перед }}.',
    );
    assert.equal(
      templateError('{"id": "{{request.id"}'),
      'A placeholder is not closed: {{ without }}.',
    );
    assert.equal(templateError('{{', ru), 'Подстановка не закрыта: {{ без }}.');
  });

  it('reads a path still being typed as unfinished, and a broken one or a bad header as unknown', () => {
    assert.equal(
      templateError('{{request.body.order.}}'),
      'Finish {{request.body.order.}}: type the field path before }}.',
    );
    assert.equal(
      templateError('{{request.body.a..b}}'),
      'Unknown placeholder {{request.body.a..b}}.',
    );
    assert.equal(
      templateError('{{request.header.a(b}}'),
      'Unknown placeholder {{request.header.a(b}}.',
    );
    assert.equal(
      templateError('{{request.header.é}}'),
      'Unknown placeholder {{request.header.é}}.',
    );
    assert.equal(templateError('{{ request.id }}'), 'Unknown placeholder {{ request.id }}.');
    assert.equal(templateError('{{}}'), 'Unknown placeholder {{}}.');
    assert.equal(templateError('{{{request.id}}'), 'Unknown placeholder {{{request.id}}.');
  });

  it('names the placeholder the server counts, after the good ones before it', () => {
    const body = '{{request.id}} {{request.method}} {{request.nope}} {{request.foo}}';

    assert.deepEqual(templateProblem(body), { kind: 'unknown', index: 3 });
    assert.equal(templateError(body), 'Unknown placeholder {{request.nope}}.');
    assert.deepEqual(placeholderAt(body, 3), {
      open: body.indexOf('{{request.nope'),
      close: body.indexOf('}}', body.indexOf('{{request.nope')),
    });
    assert.equal(placeholderAt(body, 9), null);
    assert.deepEqual(placeholderAt('a {{b', 1), { open: 2, close: -1 });
  });

  it('refuses exactly what the server’s module refuses', () => {
    const bodies = [
      '',
      'plain',
      '{',
      '}',
      '}}{{request.id}}',
      '{{request.id}}',
      '{{request.method}}{{request.path}}',
      '{{request.query.a b}}',
      '{{request.query.page}}',
      '{{request.header.X-Trace-Id}}',
      '{{request.body.0}}',
      '{{request.body.__proto__}}',
      '{{request.id}}}',
      '{"a":{"b":1}}',
      '{"a":{{"b":1}}}',
      '{{\nrequest.id}}',
      '{{request.id\u0000}}',
      '{{request.id\u0085}}',
      '{{request.id }}',
      '{{REQUEST.ID}}',
      '{{request.Id}}',
      '{{request.body}}',
      '{{request.header}}',
      'a {{request.id}} b {{',
    ];

    for (const body of bodies) {
      assert.equal(
        templateError(body) === undefined,
        templateProblem(body) === null,
        JSON.stringify(body),
      );
    }
  });

  it('shows a placeholder’s inside as typed, its spaces and controls as one space, cut long', () => {
    assert.equal(shownPlaceholder('request.foo'), '{{request.foo}}');
    assert.equal(shownPlaceholder(' a \n\t b\u0000c '), '{{ a b c }}');
    assert.equal(shownPlaceholder('x'.repeat(SHOWN_PLACEHOLDER_MAX)), `{{${'x'.repeat(48)}}}`);
    assert.equal(shownPlaceholder('x'.repeat(SHOWN_PLACEHOLDER_MAX + 1)), `{{${'x'.repeat(48)}…}}`);
    // Cut by characters, never inside a pair.
    assert.equal(shownPlaceholder('🏠'.repeat(60)), `{{${'🏠'.repeat(48)}…}}`);
    assert.equal(shownPlaceholder(' '.repeat(10_000)), '{{ …}}');
    assert.equal(shownPlaceholder(`${' '.repeat(191)}🏠tail`), '{{ …}}');
    assert.equal(
      templateError(`{{${'q'.repeat(5000)}}}`),
      `Unknown placeholder {{${'q'.repeat(48)}…}}.`,
    );
  });

  it('stands hostile bodies at growing sizes in one pass, its message a line', () => {
    for (const size of [1024, 16 * 1024, MAX_RESPONSE_BODY_BYTES, 1024 * 1024]) {
      const shapes = [
        '{'.repeat(size),
        '{{'.repeat(size / 2),
        '}}'.repeat(size / 2),
        `{{${'a'.repeat(size)}`,
        `{{${'a'.repeat(size)}}}`,
        `{{${' '.repeat(size)}}}`,
        '{{request.id}}'.repeat(Math.ceil(size / 14)),
        `${'{{request.id}}'.repeat(Math.ceil(size / 28))}{{request.foo}}`,
        `${'{{request.id}}'.repeat(Math.ceil(size / 28))}{{`,
        '{{}}'.repeat(size / 4),
        '\u0000{{ }}'.repeat(size / 6),
        '🏠{{'.repeat(size / 4),
      ];

      for (const body of shapes) {
        let message: string | undefined;
        const took = timed(() => {
          message = templateError(body);
        });

        assert.ok(took < 500, `${size}: ${took} ms for ${JSON.stringify(body.slice(0, 20))}`);
        assert.equal(message === undefined, templateProblem(body) === null);
        assert.ok((message ?? '').length < 160, `${size}: ${message?.length}`);
      }
    }
  });
});

describe('the line cut for monospace placeholders', () => {
  it('draws a placeholder, and a lone {{ or }}, in monospace', () => {
    assert.deepEqual(textParts(en.template.hint(HINT_EXAMPLE)), [
      { text: 'Placeholders like ', code: false },
      { text: '{{request.id}}', code: true },
      { text: ' are replaced with values of the captured request.', code: false },
    ]);
    assert.deepEqual(textParts(en.template.unclosed), [
      { text: 'A placeholder is not closed: ', code: false },
      { text: '{{', code: true },
      { text: ' without ', code: false },
      { text: '}}', code: true },
      { text: '.', code: false },
    ]);
    assert.deepEqual(textParts(ru.template.finish('{{request.header.}}', 'name')), [
      { text: 'Допишите ', code: false },
      { text: '{{request.header.}}', code: true },
      { text: ': имя перед ', code: false },
      { text: '}}', code: true },
      { text: '.', code: false },
    ]);
    assert.deepEqual(textParts('Unknown placeholder {{ request.id }}.'), [
      { text: 'Unknown placeholder ', code: false },
      { text: '{{', code: true },
      { text: ' request.id ', code: false },
      { text: '}}', code: true },
      { text: '.', code: false },
    ]);
    assert.deepEqual(textParts('Body must not contain U+0000.'), [
      { text: 'Body must not contain U+0000.', code: false },
    ]);
    assert.deepEqual(textParts(''), []);
  });

  /**
   * Each size 4 times the last: a cut whose time grows with the square of
   * the line, under its bound at one size, takes about 16 times as long at
   * the next and fails there, not after minutes.
   */
  const LINE_SIZES = [1024, 4 * 1024, 16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024];
  /**
   * 4000 ms (#388): 3.4 times the slowest cut of a megabyte in loaded suites,
   * 1182 ms, and 7 times under a cut that looks from every `{{` to the end of
   * the line again, 29 s alone on 64 KiB of `{` (1.8 s on 16 KiB).
   */
  const LINE_LIMIT_MS = 4000;

  it('loses nothing of the line, and stands hostile lines at growing sizes in one pass', () => {
    for (const size of LINE_SIZES) {
      const shapes = [
        '{'.repeat(size),
        '{{'.repeat(size / 2),
        '}}'.repeat(size / 2),
        `{{${'x'.repeat(size)}`,
        `${'{{x'.repeat(size / 3)} `,
        '{{ '.repeat(size / 3),
        'a{{b}}'.repeat(size / 6),
        '{{{'.repeat(size / 3),
        '}{'.repeat(size / 2),
      ];

      for (const line of shapes) {
        let parts: ReturnType<typeof textParts> = [];
        const took = timed(() => {
          parts = textParts(line);
        });

        assert.ok(
          took < LINE_LIMIT_MS,
          `${size}: ${took} ms for ${JSON.stringify(line.slice(0, 12))}`,
        );
        assert.equal(parts.map((part) => part.text).join(''), line);
      }
    }
  });
});

describe('the opt-in in the form (#236, criteria 1 and 3)', () => {
  it('sends template only while the box is ticked, and opens as saved', () => {
    assert.equal(formFromResponse(RESPONSE).template, true);
    assert.equal(formFromResponse({ ...RESPONSE, template: false }).template, false);
    assert.equal(DEFAULT_RESPONSE_FORM.template, false);
    assert.deepEqual(validateResponseForm(form('{{request.id}}')).body, {
      response: { status: 200, body: '{{request.id}}', template: true },
    });
    assert.deepEqual(validateResponseForm(form('{{request.id}}', false)).body, {
      response: { status: 200, body: '{{request.id}}' },
    });
  });

  it('checks the placeholders only while the box is ticked, on the body, and holds Save', () => {
    const bad = form('{"id": "{{request.foo}}"}');
    const checked = validateResponseForm(bad);

    assert.equal(checked.body, null);
    assert.deepEqual(checked.errors, { body: 'Unknown placeholder {{request.foo}}.' });
    assert.equal(firstErrorField(checked.errors), 'body');
    assert.equal(
      validateResponseForm(bad, ru).errors.body,
      'Неизвестная подстановка {{request.foo}}.',
    );
    // Unticked, `{{` stays plain text (T1).
    assert.deepEqual(validateResponseForm({ ...bad, template: false }).errors, {});

    const draft = evaluateEditorDraft({ mode: 'custom', form: bad });

    assert.equal(draft.canSave, false);
    assert.equal(draft.request, null);
    assert.deepEqual(
      evaluateEditorDraft({ mode: 'custom', form: form('{{request.id}}') }).request,
      {
        mode: 'custom',
        response: { status: 200, body: '{{request.id}}', template: true },
      },
    );
  });

  it('reads a body as a template only once it is within its size and free of U+0000, as the server does', () => {
    const tooLarge = `{{${'a'.repeat(MAX_RESPONSE_BODY_BYTES)}`;

    assert.equal(validateResponseForm(form(tooLarge)).errors.body, en.config.bodyTooLarge(65536));
    assert.equal(validateResponseForm(form('{{\u0000')).errors.body, en.config.bodyNul);
    // A body on 204 is refused for the status, as before.
    assert.equal(
      validateResponseForm(form('{{request.foo}}', true, '204')).errors.body,
      en.config.bodyForbidden(204),
    );
    // A template with no body is taken: it has nothing to fill in.
    assert.deepEqual(validateResponseForm(form('', true, '204')).body, {
      response: { status: 204, template: true },
    });
  });

  it('holds a queue step and a rule in error, and sends the flag of each', () => {
    const queue = evaluateQueue([form('{{request.id}}'), form('{{request.header.}}')]);

    assert.equal(queue.canSave, false);
    assert.deepEqual(queue.broken, [2]);
    assert.equal(queue.errors[1]?.body, 'Finish {{request.header.}}: type the name before }}.');
    assert.deepEqual(evaluateQueue([form('{{request.id}}'), form('{{', false)]).request, {
      steps: [
        { status: 200, body: '{{request.id}}', template: true },
        { status: 200, body: '{{' },
      ],
    });

    const rule = { ...newRuleForm(null), path: 'orders', response: form('{{request.body.}}') };
    const rules = evaluateRules([rule]);

    assert.equal(rules.canSave, false);
    assert.equal(
      rules.errors[0]?.response.body,
      'Finish {{request.body.}}: type the field path before }}.',
    );
    assert.deepEqual(
      evaluateRules([{ ...rule, response: form('{{request.body.order.id}}') }]).request?.rules[0]
        ?.response,
      { status: 200, body: '{{request.body.order.id}}', template: true },
    );
  });

  it('shows the server’s refusal of a template as it shows every other 1005', () => {
    const message =
      'response.body placeholder 1 must be one of {{request.id}}, {{request.method}}, {{request.path}}, {{request.query.<name>}}, {{request.header.<name>}} or {{request.body.<path>}}, with nothing else inside the braces';
    const refusal = new ApiError(400, ErrorCode.INVALID_RESPONSE_CONFIG, message);

    assert.deepEqual(describeChangeFailure(refusal, 'editor'), {
      kind: 'shown',
      title: 'Could not save the response',
      text: `The server rejected this configuration: ${message}`,
    });
    assert.deepEqual(describeChangeFailure(refusal, 'editor', ru), {
      kind: 'shown',
      title: ru.editor.saveFailed,
      text: ru.editor.rejected(message),
    });

    const stepRefusal = new ApiError(
      400,
      ErrorCode.INVALID_RESPONSE_CONFIG,
      'steps[1].body placeholder 2 has no closing }}: with steps[1].template true every {{ starts a placeholder',
    );

    assert.deepEqual(describeQueueFailure(stepRefusal, 'save'), {
      kind: 'shown',
      action: 'save',
      text: en.queue.rejected(stepRefusal.message),
      retry: true,
    });

    const ruleRefusal = new ApiError(
      400,
      ErrorCode.INVALID_RESPONSE_CONFIG,
      'rules[0].response.body placeholder 1 must name a query parameter',
    );

    assert.deepEqual(describeRulesFailure(ruleRefusal, 'save'), {
      kind: 'shown',
      action: 'save',
      text: en.rules.rejected(ruleRefusal.message),
      retry: true,
    });
  });
});

describe('the marks of a template (#236, criterion 4)', () => {
  function stateWith(partial: Partial<SessionResponseState>): SessionResponseState {
    return { response: RESPONSE, customResponse: RESPONSE, queue: null, rules: [], ...partial };
  }

  it('reads the flag, and a response from before 1.9.0 as none', () => {
    assert.equal(isTemplate(RESPONSE), true);
    assert.equal(isTemplate({ ...RESPONSE, template: false }), false);
    assert.equal(isTemplate({}), false);
    assert.equal(isTemplate(null), false);
    assert.equal(isTemplate(undefined), false);
  });

  it('gives a queue step’s chip a · Template part, after its delay, in both languages (T13)', () => {
    assert.equal(
      formatSectionStepChip({ status: 201, delayMs: 0, template: true }),
      '201 · Template',
    );
    assert.equal(
      formatSectionStepChip({ status: 503, delayMs: 2000, template: true }),
      '503 · 2 s · Template',
    );
    assert.equal(
      formatSectionStepChip({ status: 503, delayMs: 2000, template: false }),
      '503 · 2 s',
    );
    assert.equal(formatSectionStepChip({ status: 201, delayMs: 0 }), '201');
    assert.equal(
      formatSectionStepChip({ status: 201, delayMs: 0, template: true }, ru),
      '201 · Шаблон',
    );

    const steps: ResponseConfig[] = [
      { ...RESPONSE, status: 201 },
      { ...RESPONSE, status: 503, template: false },
      { ...RESPONSE, status: 200, delayMs: 500 },
    ];
    const view = queueSectionView(
      stateWith({
        response: { ...RESPONSE, template: false },
        queue: { steps, next: 1, total: 3 },
      }),
    );

    assert.equal(view.kind, 'running');
    assert.deepEqual(view.kind === 'running' ? view.chips.map((chip) => chip.label) : [], [
      '201 · Template',
      '503',
      '200 · 0.5 s · Template',
      'Custom 201',
    ]);
    assert.equal(
      view.kind === 'running' ? describeQueueChips(view.chips) : '',
      describeQueueChips([
        { kind: 'next', label: '201 · Template' },
        { kind: 'ahead', label: '503' },
        { kind: 'ahead', label: '200 · 0.5 s · Template' },
        { kind: 'session', label: 'Custom 201' },
      ]),
    );

    const done = queueSectionView(stateWith({ queue: { steps, next: null, total: 3 } }));

    assert.deepEqual(done.kind === 'done' ? done.chips.map((chip) => chip.label) : [], [
      '200 · 0.5 s · Template',
      'Custom 201',
    ]);
  });

  it('marks a rule whose response is a template, its answer as before (T13)', () => {
    const view = rulesSectionView(
      stateWith({
        rules: [
          { method: 'POST', path: '/orders', response: { ...RESPONSE, status: 201 } },
          {
            method: 'GET',
            path: '/status',
            response: { ...RESPONSE, status: 200, template: false },
          },
        ],
      }),
    );

    assert.deepEqual(
      view.kind === 'rules'
        ? view.rows.map((row) => [row.method, row.path, row.answer, row.template])
        : [],
      [
        ['POST', '/orders', '201', true],
        ['GET', '/status', '200', false],
      ],
    );
  });
});

describe('the control in the three editors (#236, structural guards)', () => {
  const source = (name: string) =>
    readFileSync(new URL(`../components/${name}`, import.meta.url), 'utf8');

  it('is one control under the body of ResponseFields, which the three editors share', () => {
    const fields = source('ResponseFields.tsx');

    for (const editor of [
      'SessionResponseEditor.tsx',
      'ResponseQueueDialog.tsx',
      'ResponseRulesDialog.tsx',
    ]) {
      assert.match(source(editor), /<ResponseFields\b/, editor);
      assert.doesNotMatch(source(editor), /<TemplateControl\b/, editor);
    }

    assert.match(fields, /<TemplateControl\b/);
    assert.match(fields, /onTemplateChange=\{\(template\) => onEdit\(\{ template \}\)\}/);
    assert.match(fields, /fieldId\('template'\)/);
    // The body stays a plain text area: nothing highlights a placeholder.
    assert.match(fields, /<Textarea\b/);
    assert.equal(fields.indexOf('<FieldError>') < fields.indexOf('<TemplateControl'), true);
  });

  it('lists the placeholders in the Actions menu’s dropdown and sheet, and marks the summaries', () => {
    const control = source('TemplateControl.tsx');

    assert.match(control, /DropdownMenu\.Content/);
    assert.match(control, /w-\[320px\]/);
    assert.match(control, /DialogPrimitive\.Content/);
    assert.match(control, /usePhoneLayout\(\)/);
    assert.match(control, /onCloseAutoFocus/);
    assert.match(
      source('SessionResponseSwitch.tsx'),
      /isTemplate\(kept\) \? <TemplateTag onGrey \/>/,
    );
    assert.match(source('ResponseRulesSection.tsx'), /rule\.template \? <TemplateTag \/>/);
  });
});
