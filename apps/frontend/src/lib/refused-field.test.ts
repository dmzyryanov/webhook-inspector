import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode } from '@webhook-inspector/shared';
import { ApiError, MAX_REFUSAL_FIELD_LENGTH, refusalField } from '../api/client.ts';
import { DEFAULT_RESPONSE_FORM, type ResponseForm } from './response-config.ts';
import {
  draftAfterPlacedRefusal,
  namesAField,
  placeResponseRefusal,
  refusedListPlace,
  withRefusedErrors,
} from './refused-field.ts';
import { newRuleForm } from './response-rules.ts';

/**
 * Where a server's refusal of a list belongs (issue #232, D257): the `field`
 * the client keeps from an error answer, its place in the list sent, and the
 * field of a response it marks - the k-th header pair sent mapped to its row
 * of the form, blank rows before it. Made-up fields built to break the
 * reading, at growing sizes, place nothing, quickly, and throw nothing.
 */

function refusal(field: unknown, message = 'refused'): ApiError {
  return new ApiError(400, ErrorCode.INVALID_RESPONSE_CONFIG, message, undefined, field as string);
}

function form(headers: ResponseForm['headers']): ResponseForm {
  return { ...DEFAULT_RESPONSE_FORM, headers };
}

/** Two blank rows, a pair, a blank row, a pair, a value without a name. */
const WITH_BLANKS = form([
  { name: '', value: '' },
  { name: '', value: '' },
  { name: 'x-first', value: '1' },
  { name: '', value: '' },
  { name: 'x-second', value: '2' },
  { name: '', value: 'only a value' },
]);

describe('refusalField', () => {
  it('keeps a string of at most 200 characters, and nothing else', () => {
    assert.equal(MAX_REFUSAL_FIELD_LENGTH, 200);
    assert.equal(refusalField({ field: 'rules[1].path' }), 'rules[1].path');
    assert.equal(refusalField({ field: '' }), '');
    assert.equal(refusalField({ field: 'f'.repeat(200) }), 'f'.repeat(200));

    for (const body of [
      null,
      undefined,
      'rules[1].path',
      7,
      [],
      ['rules[1].path'],
      {},
      { errorCode: 1005, message: 'x' },
      { field: 'f'.repeat(201) },
      { field: 'f'.repeat(1024 * 1024) },
      { field: 1 },
      { field: null },
      { field: { path: 'rules[1].path' } },
      { field: ['rules[1].path'] },
      { field: true },
    ]) {
      assert.equal(refusalField(body), undefined, JSON.stringify(body)?.slice(0, 40));
    }
  });

  it('reads no field the body inherits', () => {
    const inherited = Object.create({ field: 'rules[1].path' }) as object;

    assert.equal(refusalField(inherited), undefined);
  });
});

describe('refusedListPlace', () => {
  it('reads a 1005’s place in the list named, and what follows it', () => {
    assert.deepEqual(refusedListPlace(refusal('rules[1].path', 'm'), 'rules', 2), {
      index: 1,
      rest: '.path',
      message: 'm',
    });
    assert.deepEqual(refusedListPlace(refusal('steps[0]'), 'steps', 1), {
      index: 0,
      rest: '',
      message: 'refused',
    });
    assert.deepEqual(refusedListPlace(refusal('steps[9].headers[2][1]'), 'steps', 10), {
      index: 9,
      rest: '.headers[2][1]',
      message: 'refused',
    });
  });

  it('places nothing for another error, another list, a position outside the list sent, or no string', () => {
    const outside: unknown[] = [
      undefined,
      'rules',
      'steps[1].status',
      'queue.steps[1].status',
      'response.status',
      'rules[2]',
      'rules[20].path',
      'rules[-1].path',
      'rules[99999999999999999999].path',
      'rules[1e1].path',
      'rules[01].path',
      'rules[ 1].path',
      'rules[1',
      'rules[]',
      'rules[0x1]',
      'Rules[1].path',
      ' rules[1].path',
      1,
      { field: 'rules[1].path' },
      ['rules[1].path'],
      `rules[1].${'p'.repeat(MAX_REFUSAL_FIELD_LENGTH)}`,
      `rules[1].path${'x'.repeat(1024 * 1024)}`,
    ];

    for (const field of outside) {
      assert.equal(
        refusedListPlace(refusal(field), 'rules', 2),
        null,
        JSON.stringify(field)?.slice(0, 40),
      );
    }

    assert.equal(
      refusedListPlace(
        new ApiError(404, ErrorCode.SESSION_NOT_FOUND, 'x', undefined, 'rules[0]'),
        'rules',
        2,
      ),
      null,
    );
    assert.equal(refusedListPlace(new Error('rules[0]'), 'rules', 2), null);
    assert.equal(refusedListPlace({ errorCode: 1005, field: 'rules[0]' }, 'rules', 2), null);
    assert.equal(refusedListPlace(refusal('rules[0].path'), 'rules', 0), null);
  });

  it('reads made-up fields at growing sizes quickly, placing nothing it cannot', () => {
    for (const size of [10, 1_000, 100_000, 1_000_000]) {
      const fields = [
        `rules[${'9'.repeat(size)}]`,
        `rules[${'0'.repeat(size)}]`,
        `rules[0${']'.repeat(size)}`,
        `rules${'['.repeat(size)}`,
        `rules[0]${'[0]'.repeat(size)}`,
        `${'rules['.repeat(size)}0]`,
      ];

      for (const field of fields) {
        const started = performance.now();
        const place = refusedListPlace(refusal(field), 'rules', 20);

        assert.ok(performance.now() - started < 50, `${size}: too slow`);

        if (field.length > MAX_REFUSAL_FIELD_LENGTH) {
          assert.equal(place, null, `${size}`);
        }
      }
    }
  });
});

describe('placeResponseRefusal', () => {
  it('marks the field named: status, delay, body, the header list', () => {
    const plain = form([]);

    assert.deepEqual(placeResponseRefusal('.status', plain, 'm'), { status: 'm' });
    assert.deepEqual(placeResponseRefusal('.delayMs', plain, 'm'), { delayMs: 'm' });
    assert.deepEqual(placeResponseRefusal('.body', plain, 'm'), { body: 'm' });
    assert.deepEqual(placeResponseRefusal('.headers', plain, 'm'), { headers: 'm' });
  });

  it('marks no field for the response as a whole or its template, which no field shows', () => {
    assert.deepEqual(placeResponseRefusal('', form([]), 'm'), { refused: 'm' });
    assert.deepEqual(placeResponseRefusal('.template', form([]), 'm'), { refused: 'm' });
    assert.equal(namesAField({ refused: 'm' }), false);
    assert.equal(namesAField({ refused: 'm', status: 's' }), true);
    assert.equal(namesAField({ rows: { 0: { name: 'n' } } }), true);
  });

  it('maps the k-th header pair sent to its row of the form, blank rows before it (criterion 6)', () => {
    // The pairs sent are rows 2, 4 and 5: `headers[0]` is row 2, `headers[1]` row 4.
    assert.deepEqual(placeResponseRefusal('.headers[0][0]', WITH_BLANKS, 'm'), {
      rows: { 2: { name: 'm' } },
    });
    assert.deepEqual(placeResponseRefusal('.headers[1][1]', WITH_BLANKS, 'm'), {
      rows: { 4: { value: 'm' } },
    });
    assert.deepEqual(placeResponseRefusal('.headers[1]', WITH_BLANKS, 'm'), {
      rows: { 4: { name: 'm' } },
    });
    assert.deepEqual(placeResponseRefusal('.headers[2][1]', WITH_BLANKS, 'm'), {
      rows: { 5: { value: 'm' } },
    });
  });

  it('places nothing past the pairs sent, or for a key or a shape no field holds', () => {
    for (const rest of [
      '.headers[3]',
      '.headers[3][0]',
      '.headers[-1]',
      '.headers[01]',
      '.headers[0][2]',
      '.headers[0][0][0]',
      '.headers[0].name',
      '.headers.0',
      '.status.code',
      '.statusCode',
      '.Status',
      'status',
      '.response',
      '.method',
      '.path',
      '.unknown',
      `.headers[${'9'.repeat(400)}]`,
      `.body${'.'.repeat(100_000)}`,
    ]) {
      assert.equal(placeResponseRefusal(rest, WITH_BLANKS, 'm'), null, rest.slice(0, 40));
    }
  });
});

describe('withRefusedErrors', () => {
  it('lays a refusal under the form’s own errors, which win where both name a field', () => {
    assert.deepEqual(withRefusedErrors({}, { status: 'server' }), { status: 'server' });
    assert.deepEqual(withRefusedErrors({ status: 'own' }, { status: 'server', body: 'b' }), {
      status: 'own',
      body: 'b',
    });
    assert.deepEqual(
      withRefusedErrors(
        { rows: { 2: { name: 'own' } } },
        { rows: { 2: { value: 'server' }, 4: { name: 'server' } } },
      ),
      { rows: { 2: { name: 'own', value: 'server' }, 4: { name: 'server' } } },
    );
    assert.deepEqual(withRefusedErrors({}, {}), {});
  });
});

describe('draftAfterPlacedRefusal', () => {
  const sentRules = [newRuleForm(null), { ...newRuleForm(null), path: 'orders' }];
  const sentSteps = [form([]), { ...form([]), status: '503' }];

  it('pins an untouched dialog to a copy of the list sent, rules and steps alike', () => {
    const rules = draftAfterPlacedRefusal(null, 'rules', sentRules);
    const steps = draftAfterPlacedRefusal(null, 'steps', sentSteps);

    assert.deepEqual(rules, { rules: sentRules });
    assert.deepEqual(steps, { steps: sentSteps });
    // A copy: an edit of the draft never writes into the list the refusal
    // counts in.
    assert.notEqual(rules.rules, sentRules);
    assert.notEqual(steps.steps, sentSteps);
  });

  it('keeps an edited draft as it is', () => {
    const edited = { rules: [{ ...newRuleForm(null), path: 'edited' }] };
    const editedSteps = { steps: [form([{ name: 'x-edited', value: '1' }])] };

    assert.equal(draftAfterPlacedRefusal(edited, 'rules', sentRules), edited);
    assert.equal(draftAfterPlacedRefusal(editedSteps, 'steps', sentSteps), editedSteps);
    // An edited draft that emptied the list is kept too.
    const emptied = { rules: [] };

    assert.equal(draftAfterPlacedRefusal(emptied, 'rules', sentRules), emptied);
  });
});
