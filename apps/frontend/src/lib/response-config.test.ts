import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_HEADER_VALUE_BYTES, RESERVED_RESPONSE_HEADERS } from '@webhook-inspector/shared';
import { en } from '../i18n/en.ts';
import { ru } from '../i18n/ru.ts';
import {
  DEFAULT_RESPONSE_FORM,
  firstErrorField,
  utf8ByteLength,
  validateResponseForm,
  type CreateSessionBody,
  type HeaderRow,
  type ResponseForm,
} from './response-config.ts';

/**
 * These mirror the backend's rejection tests one for one
 * (`apps/backend/src/modules/sessions/sessions.test.ts`), because the form is
 * only useful if it complains about exactly what the server would refuse.
 */
function form(overrides: Partial<ResponseForm> = {}): ResponseForm {
  return { ...DEFAULT_RESPONSE_FORM, ...overrides };
}

function headers(...pairs: [string, string][]): HeaderRow[] {
  return pairs.map(([name, value]) => ({ name, value }));
}

function accepted(overrides: Partial<ResponseForm> = {}): CreateSessionBody {
  const { errors, body } = validateResponseForm(form(overrides));

  assert.deepEqual(errors, {}, `expected no errors, got ${JSON.stringify(errors)}`);
  assert.ok(body !== null);

  return body;
}

function rejected(overrides: Partial<ResponseForm> = {}): ReturnType<typeof validateResponseForm> {
  const result = validateResponseForm(form(overrides));

  assert.equal(result.body, null, 'a rejected form must produce no request body');
  assert.notDeepEqual(result.errors, {}, 'expected the form to be rejected');

  return result;
}

describe('the untouched form', () => {
  it('sends exactly {"response":{"status":200}}', () => {
    const body = accepted();

    assert.deepEqual(body, { response: { status: 200 } });
    assert.deepEqual(Object.keys(body.response), ['status']);
    assert.equal(JSON.stringify(body), '{"response":{"status":200}}');
  });

  it('omits every field left at its default', () => {
    const body = accepted({ headers: [], body: '', delayMs: '0' });

    assert.equal('headers' in body.response, false);
    assert.equal('body' in body.response, false);
    assert.equal('delayMs' in body.response, false);
  });

  it('treats an emptied delay field as no delay', () => {
    assert.deepEqual(accepted({ delayMs: '' }), { response: { status: 200 } });
  });

  it('drops a header row the user left blank in both fields', () => {
    const body = accepted({ headers: headers(['', ''], ['', '']) });

    assert.deepEqual(Object.keys(body.response), ['status']);
  });
});

describe('status', () => {
  it('accepts any integer in range, registered or not', () => {
    for (const status of ['200', '201', '204', '299', '404', '500', '512', '599']) {
      assert.deepEqual(accepted({ status }).response.status, Number(status));
    }
  });

  it('rejects anything outside the range or not a whole number', () => {
    for (const status of ['101', '199', '600', '', '200.5', 'abc', '-200']) {
      assert.ok(rejected({ status }).errors.status, `expected ${status} to be rejected`);
    }
  });
});

describe('a status that forbids a body', () => {
  it('rejects a body configured with 204, 205 or 304, on the body, naming the status (D5)', () => {
    for (const status of ['204', '205', '304']) {
      assert.equal(
        rejected({ status, body: '{"a":1}' }).errors.body,
        `Status ${status} requires an empty body. Clear the body or pick another status.`,
      );
    }
  });

  it('accepts those statuses with an empty body', () => {
    for (const status of ['204', '205', '304']) {
      assert.deepEqual(accepted({ status }), { response: { status: Number(status) } });
    }
  });
});

describe('headers', () => {
  it('accepts 20 pairs and rejects 21', () => {
    const pairs = (count: number): HeaderRow[] =>
      Array.from({ length: count }, (_unused, index) => ({
        name: 'x-pad',
        value: String(index),
      }));

    assert.equal(accepted({ headers: pairs(20) }).response.headers?.length, 20);
    assert.ok(rejected({ headers: pairs(21) }).errors.headers);
  });

  it('accepts a 128-byte name and rejects 129', () => {
    assert.ok(accepted({ headers: headers(['x'.repeat(128), 'v']) }));
    assert.ok(rejected({ headers: headers(['x'.repeat(129), 'v']) }).errors.rows?.[0]?.name);
  });

  it('rejects a name outside the token charset', () => {
    for (const name of ['x trace', 'x:trace']) {
      assert.ok(rejected({ headers: headers([name, 'v']) }).errors.rows?.[0]?.name);
    }
  });

  it('rejects a row whose name is empty while its value is not', () => {
    assert.ok(rejected({ headers: headers(['', 'v']) }).errors.rows?.[0]?.name);
  });

  it('accepts a 1024-byte value and rejects 1025', () => {
    assert.ok(accepted({ headers: headers(['x-trace', 'v'.repeat(1024)]) }));
    assert.ok(
      rejected({ headers: headers(['x-trace', 'v'.repeat(1025)]) }).errors.rows?.[0]?.value,
    );
  });

  it('rejects a value carrying CR or LF, which would split the response', () => {
    for (const value of ['a\rb', 'a\nb']) {
      assert.ok(rejected({ headers: headers(['x-trace', value]) }).errors.rows?.[0]?.value);
    }
  });

  it('accepts an empty value, which RFC 9110 permits', () => {
    assert.deepEqual(accepted({ headers: headers(['x-trace', '']) }).response.headers, [
      ['x-trace', ''],
    ]);
  });

  it('counts the block budget over the configured pairs only', () => {
    // `name: value\r\n` is 12 bytes of framing, so eight pairs of a 1012-byte
    // line sit just under the 8192-byte budget and nine sit over it.
    const line = (count: number): HeaderRow[] =>
      Array.from({ length: count }, () => ({ name: 'x-pad-01', value: 'v'.repeat(1000) }));

    assert.equal(utf8ByteLength('x-pad-01: ' + 'v'.repeat(1000) + '\r\n'), 1012);
    assert.ok(accepted({ headers: line(8) }));
    assert.ok(rejected({ headers: line(9) }).errors.headers);
  });

  it('keeps duplicate names in the configured order', () => {
    const body = accepted({ headers: headers(['x-a', '1'], ['X-A', '2'], ['x-b', '3']) });

    assert.deepEqual(body.response.headers, [
      ['x-a', '1'],
      ['X-A', '2'],
      ['x-b', '3'],
    ]);
  });

  it('accepts a Content-Type row with any value the header rules accept (D179)', () => {
    for (const [name, value] of [
      ['Content-Type', 'text/plain'],
      ['content-type', 'text/html; charset=windows-1251'],
      ['CONTENT-TYPE', 'not a media type'],
      ['Content-Type', ''],
    ] as [string, string][]) {
      assert.deepEqual(accepted({ headers: headers([name, value]) }).response.headers, [
        [name, value],
      ]);
    }

    assert.ok(
      accepted({ headers: headers(['Content-Type', 'text/xml'], ['Content-Type', 'text/plain']) }),
    );
  });

  it('refuses Content-Security-Policy, named literally (D179)', () => {
    // The loop below cannot fail if the name leaves RESERVED_RESPONSE_HEADERS;
    // this one can.
    for (const name of ['Content-Security-Policy', 'content-security-policy']) {
      assert.ok(
        rejected({ headers: headers([name, 'sandbox allow-scripts']) }).errors.rows?.[0]?.name,
      );
    }
  });

  it('rejects every reserved name, whatever its case, with a 3xx as with 200', () => {
    for (const status of ['200', '302']) {
      for (const name of [...RESERVED_RESPONSE_HEADERS, 'X-QA-Tools-Anything']) {
        for (const spelling of [name, name.toUpperCase()]) {
          assert.equal(
            rejected({ status, headers: headers([spelling, '/s/x']) }).errors.rows?.[0]?.name,
            en.config.reserved,
            `expected ${spelling} to be reserved with ${status}`,
          );
        }
      }
    }
  });

  it('allows the permitted CORS headers and refuses the credentialed one', () => {
    assert.ok(accepted({ headers: headers(['Access-Control-Allow-Origin', '*']) }));
    assert.ok(
      rejected({ headers: headers(['Access-Control-Allow-Credentials', 'true']) }).errors.rows?.[0]
        ?.name,
    );
  });
});

describe('body', () => {
  it('sends a body that is not JSON, or is broken JSON, as typed (D179)', () => {
    for (const body of ['{"a":', "{'a':1}", 'OK', 'not json', '<html><body>x</body></html>']) {
      const { errors, body: sent } = validateResponseForm(form({ body }));

      assert.deepEqual(errors, {}, `${body} was refused`);
      assert.equal(sent?.response.body, body);
    }
  });

  it('sends a whitespace-only body as typed, but omits an empty one', () => {
    // An untouched textarea is no body at all; anything typed, whitespace
    // included, is a body (D179).
    assert.equal(accepted({ body: '   ' }).response.body, '   ');
    assert.equal(accepted({ body: '\n' }).response.body, '\n');
    assert.equal('body' in accepted({ body: '' }).response, false);
  });

  it('says nothing about JSON in any body error', () => {
    const rawNul = String.fromCharCode(0);

    for (const body of ['a'.repeat(65537), `a${rawNul}b`, 'not json']) {
      const message = validateResponseForm(form({ body })).errors.body ?? '';

      assert.equal(/json/i.test(message), false, message);
    }
  });

  it('passes the text through byte-identically, keeping key order and duplicates', () => {
    const text = '{"b": 1,\n  "a": 2, "a": 3}';

    assert.equal(accepted({ body: text }).response.body, text);
  });

  it('measures the limit in bytes of UTF-8, not in characters', () => {
    // 40002 characters either way; the multi-byte one encodes to 80002 bytes.
    const multiByte = JSON.stringify('é'.repeat(40000));
    const ascii = JSON.stringify('a'.repeat(40000));

    assert.equal(multiByte.length, ascii.length);
    assert.ok(multiByte.length < 65536);
    assert.ok(utf8ByteLength(multiByte) > 65536);

    assert.ok(rejected({ body: multiByte }).errors.body);
    assert.ok(accepted({ body: ascii }));
  });

  it('accepts a body of exactly 65536 bytes', () => {
    const body = JSON.stringify('a'.repeat(65536 - 2));

    assert.equal(utf8ByteLength(body), 65536);
    assert.ok(accepted({ body }));
  });

  it('rejects a raw U+0000, and sends the six characters of an escaped one', () => {
    // Written as an escape rather than as the byte itself, so that this file
    // stays text and its diffs stay reviewable.
    const rawNul = String.fromCharCode(0);

    assert.equal(rejected({ body: `a${rawNul}b` }).errors.body, 'Body must not contain U+0000.');
    assert.equal(
      rejected({ body: `{"a":"${rawNul}"}` }).errors.body,
      'Body must not contain U+0000.',
    );
    // The column holds `\u0000` as text; only jsonb would refuse it, and the
    // body is never cast to jsonb (D179, correcting D101).
    assert.equal(accepted({ body: '{"a":"\\u0000"}' }).response.body, '{"a":"\\u0000"}');
    assert.equal(accepted({ body: '{"\\u0000":1}' }).response.body, '{"\\u0000":1}');
  });
});

describe('delayMs', () => {
  it('accepts the bounds and omits a zero delay', () => {
    assert.equal('delayMs' in accepted({ delayMs: '0' }).response, false);
    assert.equal(accepted({ delayMs: '30000' }).response.delayMs, 30000);
    assert.equal(accepted({ delayMs: '500' }).response.delayMs, 500);
  });

  it('rejects anything outside the range or not a whole number', () => {
    for (const delayMs of ['-1', '30001', '1.5', 'x']) {
      assert.ok(rejected({ delayMs }).errors.delayMs, `expected ${delayMs} to be rejected`);
    }
  });
});

describe('reporting', () => {
  it('reports every broken rule at once', () => {
    const { errors } = rejected({
      status: '900',
      headers: headers(['bad name', 'v'], ['x-trace', 'a\r\nb']),
      body: 'a'.repeat(65537),
      delayMs: '30001',
    });

    assert.ok(errors.status);
    assert.ok(errors.rows?.[0]?.name);
    assert.ok(errors.rows?.[1]?.value);
    assert.ok(errors.body);
    assert.ok(errors.delayMs);
  });

  it('keeps a per-row complaint on the row the user typed', () => {
    const { errors } = rejected({ headers: headers(['x-ok', 'v'], ['bad name', 'v']) });

    assert.equal(errors.rows?.[0], undefined);
    assert.ok(errors.rows?.[1]?.name);
  });
});

describe('the field a failed submit focuses', () => {
  /**
   * The settings editor moves focus to whatever this names, so the order is
   * behaviour rather than a detail — and it is documented only in a doc comment,
   * which a new validation rule can quietly outgrow. The errors below are built
   * by hand instead of through `validateResponseForm`, because what is pinned
   * here is this function's own contract, independent of which combinations the
   * validator happens to produce today.
   */
  it('names the status before anything else', () => {
    const focus = firstErrorField({
      status: 'bad',
      headers: 'bad',
      rows: { 0: { name: 'bad' } },
      body: 'bad',
      delayMs: 'bad',
    });

    assert.equal(focus, 'status');
  });

  it("prefers a row's own complaint to the list-wide header rules", () => {
    // The count and block-budget rules run first in the validator, but they
    // name no field of their own, so the row that does name one wins.
    assert.equal(
      firstErrorField({ headers: 'bad', rows: { 1: { value: 'bad' } } }),
      'header-value-1',
    );
  });

  it('falls back to the first name input when only the list as a whole is at fault', () => {
    assert.equal(firstErrorField({ headers: 'bad' }), 'header-name-0');
  });

  it('takes the lowest row index, whichever of its fields broke', () => {
    assert.equal(
      firstErrorField({ rows: { 2: { value: 'bad' }, 10: { name: 'bad' } } }),
      'header-value-2',
    );
  });

  it('takes the name before the value within one row', () => {
    assert.equal(firstErrorField({ rows: { 0: { name: 'bad', value: 'bad' } } }), 'header-name-0');
  });

  it('reaches the body only after the headers, and the delay only after the body', () => {
    assert.equal(firstErrorField({ headers: 'bad', body: 'bad' }), 'header-name-0');
    assert.equal(firstErrorField({ body: 'bad', delayMs: 'bad' }), 'body');
    assert.equal(firstErrorField({ delayMs: 'bad' }), 'delayMs');
  });

  it('has nothing to focus when nothing is wrong', () => {
    assert.equal(firstErrorField({}), null);
  });
});

/**
 * The `Location` rule (D247), the backend's own predicate: these mirror
 * `apps/backend/src/modules/sessions/location-header.test.ts` and
 * `sessions.test.ts` case for case.
 */
describe('Location on a redirect (D247)', () => {
  const STATUS_ERROR = 'Location can be set only with a status from 300 to 399.';
  const TARGET_ERROR = 'Location must be a path on this host beginning with /s/.';

  it('is sent with 300, 301, 302, 303, 304, 307, 308 and 399, its name in any case', () => {
    for (const status of ['300', '301', '302', '303', '304', '307', '308', '399']) {
      for (const name of ['Location', 'location', 'LOCATION', 'lOcAtIoN']) {
        assert.deepEqual(
          accepted({ status, headers: headers([name, '/s/abc/after']) }).response,
          { status: Number(status), headers: [[name, '/s/abc/after']] },
          `${status} ${name}`,
        );
      }
    }
  });

  it('puts its error on the row with 200, 201, 204, 299, 400, 500 and 599, and sends nothing', () => {
    for (const status of ['200', '201', '204', '299', '400', '500', '599']) {
      const { errors } = rejected({ status, headers: headers(['Location', '/s/abc/after']) });

      assert.deepEqual(errors, { rows: { 0: { name: STATUS_ERROR } } }, status);
      assert.equal(firstErrorField(errors), 'header-name-0');
    }
  });

  it('puts its error on the row when the status is switched to 200 with the row present', () => {
    const saved = form({ status: '302', headers: headers(['x-a', '1'], ['Location', '/s/x']) });

    assert.deepEqual(validateResponseForm(saved).errors, {});

    const switched = validateResponseForm({ ...saved, status: '200' });

    assert.equal(switched.body, null);
    assert.deepEqual(switched.errors, { rows: { 1: { name: STATUS_ERROR } } });
    assert.equal(firstErrorField(switched.errors), 'header-name-1');
  });

  it('puts its error on the value for a target that is not a path under /s/', () => {
    for (const target of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/\t/evil.example',
      ' /s/x',
      '/S/x',
      's/x',
      'javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'https://hook.qa-tools.ru@evil.example/',
      'https://hook.qa-tools.ru/s/x',
      '%2Fs%2Fx',
      '/s',
    ]) {
      const { errors } = rejected({ status: '302', headers: headers(['Location', target]) });

      assert.deepEqual(errors, { rows: { 0: { value: TARGET_ERROR } } }, JSON.stringify(target));
      assert.equal(firstErrorField(errors), 'header-value-0');
    }
  });

  it('refuses an empty target, which a row with only a name is', () => {
    const { errors } = rejected({ status: '302', headers: headers(['Location', '']) });

    assert.deepEqual(errors, { rows: { 0: { value: TARGET_ERROR } } });
  });

  it('says both at once where the backend names the status first', () => {
    const { errors } = rejected({ status: '200', headers: headers(['Location', '//evil']) });

    assert.deepEqual(errors, { rows: { 0: { name: STATUS_ERROR, value: TARGET_ERROR } } });
    assert.equal(firstErrorField(errors), 'header-name-0');
  });

  it('judges only the target while the status field is wrong, which has its own error', () => {
    for (const status of ['', 'abc', '150', '600']) {
      assert.deepEqual(
        rejected({ status, headers: headers(['Location', '/s/x']) }).errors.rows,
        undefined,
        status,
      );
      assert.deepEqual(
        rejected({ status, headers: headers(['Location', '//x']) }).errors.rows,
        { 0: { value: TARGET_ERROR } },
        status,
      );
    }
  });

  it('keeps the value rules first: a raw line break or a value over 1024 bytes says so instead', () => {
    assert.deepEqual(
      rejected({ status: '302', headers: headers(['Location', 'a\r\nb']) }).errors.rows,
      { 0: { value: en.config.valueNotVisible } },
    );
    assert.deepEqual(
      rejected({ status: '302', headers: headers(['Location', `/s/${'a'.repeat(1022)}`]) }).errors
        .rows,
      { 0: { value: en.config.valueTooLong(1024) } },
    );
    assert.equal(
      accepted({ status: '302', headers: headers(['Location', `/s/${'a'.repeat(1021)}`]) }).response
        .headers?.[0]?.[1].length,
      MAX_HEADER_VALUE_BYTES,
    );
  });

  it('sends several Location rows in their order', () => {
    assert.deepEqual(
      accepted({
        status: '302',
        headers: headers(['Location', '/s/a/1'], ['x-mid', 'm'], ['location', '/s/a/2']),
      }).response.headers,
      [
        ['Location', '/s/a/1'],
        ['x-mid', 'm'],
        ['location', '/s/a/2'],
      ],
    );
  });

  it('keeps Refresh refused with 302 and Content-Location allowed with any status', () => {
    assert.equal(
      rejected({ status: '302', headers: headers(['Refresh', '0; url=/s/x']) }).errors.rows?.[0]
        ?.name,
      en.config.reserved,
    );

    for (const status of ['200', '302']) {
      assert.ok(accepted({ status, headers: headers(['Content-Location', 'https://x.example/']) }));
    }
  });

  it('says both rules in Russian, with the numbers and the prefix as given', () => {
    const { errors } = validateResponseForm(
      form({ status: '200', headers: headers(['Location', '//evil']) }),
      ru,
    );

    assert.deepEqual(errors.rows, {
      0: {
        name: 'Location можно задать только со статусом от 300 до 399.',
        value: 'Location должен быть путём на этом хосте, начинающимся с /s/.',
      },
    });
  });

  it('answers made-up targets of 64, 256, 1024 and 1025 bytes, quoting none of them', () => {
    const marker = 'MARKER247';

    for (const size of [64, 256, MAX_HEADER_VALUE_BYTES, MAX_HEADER_VALUE_BYTES + 1]) {
      for (const start of [
        'https://evil.example/',
        '//evil.example/',
        '/\\evil.example/',
        'javascript:',
        '/s/',
        '/s/%0d%0a',
        '/s//',
      ]) {
        const value = `${start}${marker}`.padEnd(size, start.endsWith('/') ? '/' : 'a');

        for (const status of ['302', '200']) {
          const { errors, body } = validateResponseForm(
            form({ status, headers: headers(['Location', value]) }),
          );

          assert.equal(JSON.stringify(errors).includes(marker), false, `${size} ${start}`);

          const keeps =
            size <= MAX_HEADER_VALUE_BYTES && start.startsWith('/s/') && status === '302';

          assert.equal(body !== null, keeps, `${size} ${start} ${status}`);
        }
      }
    }
  });
});
