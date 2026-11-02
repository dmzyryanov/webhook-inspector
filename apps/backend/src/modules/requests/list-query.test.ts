/**
 * The rules of the list's query parameters and of the query body that need no
 * server (D196): every parameter and field, valid and invalid, repeated and
 * unknown ones, `after` with `since`, the cap with bodies, and hostile input
 * at growing sizes, each answered within a time bound and never echoed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_BODY_BYTES,
  REQUEST_LIST_MAX_LIMIT,
  REQUEST_LIST_MAX_WAIT_SECONDS,
  REQUEST_LIST_MAX_WITH_BODIES,
  REQUEST_QUERY_MAX_CONDITIONS,
  REQUEST_QUERY_MAX_HEADER_NAME_BYTES,
  REQUEST_QUERY_MAX_HEADER_VALUE_BYTES,
} from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import {
  asciiLowerCase,
  parseListQueryString,
  parseQueryBody,
  PLAIN_LIST,
  queryStringOf,
  RULES,
  sinceBound,
  type ListQuery,
} from './list-query.ts';

const AFTER = '3f8a1b20-0000-4000-8000-000000000000';

/** The refusal `parse` answers `input` with. */
function refusal<T>(parse: (input: T) => unknown, input: T): AppError {
  try {
    parse(input);
  } catch (error) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);

    return error;
  }

  throw new assert.AssertionError({ message: `accepted: ${String(input).slice(0, 80)}` });
}

function assertRefused<T>(
  parse: (input: T) => unknown,
  input: T,
  message: string,
  errorCode = 1013,
): void {
  const error = refusal(parse, input);

  assert.equal(error.statusCode, 400);
  assert.equal(error.errorCode, errorCode);
  assert.equal(error.message, message);
}

const list = (query: string): ListQuery => parseListQueryString(query);
const body = (value: unknown): ListQuery => parseQueryBody(JSON.stringify(value));

describe('the limits the rules are written with', () => {
  it('are the documented ones', () => {
    assert.equal(REQUEST_LIST_MAX_LIMIT, 1000);
    assert.equal(REQUEST_LIST_MAX_WITH_BODIES, 20);
    assert.equal(REQUEST_QUERY_MAX_CONDITIONS, 8);
    assert.equal(REQUEST_QUERY_MAX_HEADER_NAME_BYTES, 200);
    assert.equal(REQUEST_QUERY_MAX_HEADER_VALUE_BYTES, 200);
    // 20 bodies of at most 1 MiB: at most 20 MiB of stored bodies per answer.
    assert.equal(REQUEST_LIST_MAX_WITH_BODIES * MAX_BODY_BYTES, 20 * 1024 * 1024);
    // 30 s: well under Traefik's 60 s and the backend's 90 s (D172, D200).
    assert.equal(REQUEST_LIST_MAX_WAIT_SECONDS, 30);
  });
});

describe('queryStringOf', () => {
  it('takes everything after the first ?, or nothing', () => {
    assert.equal(queryStringOf('/api/sessions/x/requests'), '');
    assert.equal(queryStringOf('/api/sessions/x/requests?'), '');
    assert.equal(queryStringOf('/api/sessions/x/requests?limit=5'), 'limit=5');
    assert.equal(queryStringOf('/a?b=c?d'), 'b=c?d');
  });
});

describe('parseListQueryString: what it accepts', () => {
  it('answers the plain list for no parameter, an empty query and empty segments', () => {
    for (const query of ['', '&', '&&&']) {
      assert.deepEqual(list(query), PLAIN_LIST, query);
    }
  });

  it('reads every parameter', () => {
    assert.deepEqual(list(`include=headers&limit=5&order=asc&after=${AFTER}`), {
      ...PLAIN_LIST,
      includeHeaders: true,
      limit: 5,
      order: 'asc',
      after: AFTER,
    });
    assert.deepEqual(list('since=2026-10-04T09:00:00Z&order=desc'), {
      ...PLAIN_LIST,
      receivedAfter: '2026-10-04T09:00:00.000000Z',
    });
  });

  it('reads include as headers, body or both, in either order', () => {
    assert.equal(list('include=headers').includeHeaders, true);
    assert.equal(list('include=headers').includeBody, false);
    assert.equal(list('include=body').includeBody, true);
    assert.equal(list('include=body').includeHeaders, false);

    for (const both of ['headers,body', 'body,headers', 'headers%2Cbody']) {
      const query = list(`include=${both}`);

      assert.equal(query.includeHeaders && query.includeBody, true, both);
    }
  });

  it('caps a list with bodies at 20 by default, and takes a limit from 1 to 20 then', () => {
    assert.equal(list('include=body').limit, 20);
    assert.equal(list('include=headers,body').limit, 20);
    assert.equal(list('include=body&limit=1').limit, 1);
    assert.equal(list('limit=20&include=body').limit, 20);
    assert.equal(list('include=headers').limit, null);
  });

  it('takes a limit from 1 to 1000 without bodies', () => {
    assert.equal(list('limit=1').limit, 1);
    assert.equal(list('limit=999').limit, 999);
    assert.equal(list('limit=1000').limit, 1000);
    assert.equal(list('limit=1000&include=headers').limit, 1000);
  });

  it('percent-decodes names and values, and keeps + a plus', () => {
    assert.equal(list('%6Cimit=7').limit, 7);
    assert.equal(list('order=%61sc').order, 'asc');
    // A zone offset written unencoded still means +03:00.
    assert.equal(
      list('since=2026-10-04T12:00:00+03:00').receivedAfter,
      '2026-10-04T09:00:00.000000Z',
    );
    assert.equal(
      list('since=2026-10-04T12:00:00%2B03:00').receivedAfter,
      '2026-10-04T09:00:00.000000Z',
    );
  });

  it('takes after as given: its shape is checked later, as 404 / 1003', () => {
    assert.equal(list('after=not-an-id').after, 'not-an-id');
    assert.equal(list('after=').after, '');
    assert.equal(list('after').after, '');
    assert.equal(list('after=%zz').after, '%zz');
  });

  it('reads wait as whole seconds from 1 to the cap (D200)', () => {
    assert.equal(list('').wait, null);

    for (let seconds = 1; seconds <= REQUEST_LIST_MAX_WAIT_SECONDS; seconds += 1) {
      assert.equal(list(`wait=${seconds}`).wait, seconds);
    }

    assertRefused(list, `wait=${REQUEST_LIST_MAX_WAIT_SECONDS + 1}`, RULES.wait);

    // Percent-decoded, as every name and value is.
    assert.equal(list('wait=%33%30').wait, 30);
    assert.equal(list('%77ait=7').wait, 7);
  });

  it('takes wait with after, limit, order and include, each as without it (D200)', () => {
    assert.deepEqual(list(`wait=10&after=${AFTER}&limit=5&order=asc&include=headers,body`), {
      ...PLAIN_LIST,
      includeHeaders: true,
      includeBody: true,
      limit: 5,
      order: 'asc',
      after: AFTER,
      wait: 10,
    });
    assert.deepEqual(list('include=body&wait=30'), {
      ...PLAIN_LIST,
      includeBody: true,
      limit: REQUEST_LIST_MAX_WITH_BODIES,
      wait: 30,
    });
    assert.deepEqual(list('wait=1'), { ...PLAIN_LIST, wait: 1 });
  });
});

describe('parseListQueryString: 400 / 1013 for a parameter that breaks a rule', () => {
  const invalid: [string, string, string][] = [
    ['an unknown parameter', 'header=X-Merchant-ID:123', RULES.unknownParameter],
    ['an unknown parameter beside valid ones', 'limit=5&body=abc', RULES.unknownParameter],
    ['a parameter in another letter case', 'Limit=5', RULES.unknownParameter],
    ['a parameter name that does not decode', '%zz=1', RULES.unknownParameter],
    ['a name made only of =', '=5', RULES.unknownParameter],
    ['a prototype name', '__proto__=1', RULES.unknownParameter],
    ['a parameter given twice', 'limit=5&limit=6', RULES.repeated('limit')],
    ['the same value twice', 'order=asc&order=asc', RULES.repeated('order')],
    ['include twice', 'include=headers&include=body', RULES.repeated('include')],
    ['after twice', `after=${AFTER}&after=${AFTER}`, RULES.repeated('after')],
    ['an encoded repetition', 'limit=5&%6Cimit=6', RULES.repeated('limit')],
    ['an empty include', 'include=', RULES.includeParameter],
    ['include with no value', 'include', RULES.includeParameter],
    ['include of something else', 'include=raw', RULES.includeParameter],
    ['include in capitals', 'include=HEADERS', RULES.includeParameter],
    ['include with a space', 'include=headers,%20body', RULES.includeParameter],
    ['include with an empty item', 'include=headers,', RULES.includeParameter],
    ['include with a repeated item', 'include=body,body', RULES.includeParameter],
    ['include with three items', 'include=headers,body,headers', RULES.includeParameter],
    ['include joined by +', 'include=headers+body', RULES.includeParameter],
    ['limit=0', 'limit=0', RULES.limit],
    ['limit=-1', 'limit=-1', RULES.limit],
    ['limit=1.5', 'limit=1.5', RULES.limit],
    ['limit=1e3', 'limit=1e3', RULES.limit],
    ['limit=+5', 'limit=+5', RULES.limit],
    ['limit=05', 'limit=05', RULES.limit],
    ['limit=1001', 'limit=1001', RULES.limit],
    ['limit=99999999999999999999', 'limit=99999999999999999999', RULES.limit],
    ['an empty limit', 'limit=', RULES.limit],
    ['a limit in words', 'limit=ten', RULES.limit],
    ['a limit with a space', 'limit=%205', RULES.limit],
    ['limit=21 with bodies', 'include=body&limit=21', RULES.limitWithBody],
    ['limit=1000 with bodies', 'limit=1000&include=headers,body', RULES.limitWithBody],
    ['limit=0 with bodies', 'include=body&limit=0', RULES.limitWithBody],
    ['an order other than asc and desc', 'order=newest', RULES.order],
    ['an order in capitals', 'order=ASC', RULES.order],
    ['an empty order', 'order=', RULES.order],
    ['a since with no zone', 'since=2026-10-04T09:00:00', RULES.since],
    ['a since that is only a date', 'since=2026-10-04', RULES.since],
    ['a since as epoch seconds', 'since=1759568400', RULES.since],
    ['a since whose + became a space', 'since=2026-10-04T12:00:00%2003:00', RULES.since],
    ['a since with a basic offset', 'since=2026-10-04T12:00:00%2B0300', RULES.since],
    ['a since on 31 September', 'since=2026-09-31T09:00:00Z', RULES.since],
    ['a since on 29 February of a common year', 'since=2026-02-29T09:00:00Z', RULES.since],
    ['a since at hour 24', 'since=2026-10-04T24:00:00Z', RULES.since],
    ['a since at a leap second', 'since=2016-12-31T23:59:60Z', RULES.since],
    ['a since in month 13', 'since=2026-13-01T00:00:00Z', RULES.since],
    ['a since with a 24-hour offset', 'since=2026-10-04T09:00:00%2B24:00', RULES.since],
    ['a since with a five-digit year', 'since=+12026-10-04T09:00:00Z', RULES.since],
    ['a since with ten fraction digits', 'since=2026-10-04T09:00:00.1234567890Z', RULES.since],
    ['an empty since', 'since=', RULES.since],
    ['after with since', `after=${AFTER}&since=2026-10-04T09:00:00Z`, RULES.afterWithSince],
    ['since with after', `since=2026-10-04T09:00:00Z&after=${AFTER}`, RULES.afterWithSince],
    ['a malformed after with since', 'after=x&since=2026-10-04T09:00:00Z', RULES.afterWithSince],
    ['wait=0', 'wait=0', RULES.wait],
    ['wait=-1', 'wait=-1', RULES.wait],
    ['wait=1.5', 'wait=1.5', RULES.wait],
    ['wait=1.0', 'wait=1.0', RULES.wait],
    ['wait=1e1', 'wait=1e1', RULES.wait],
    ['wait=+5', 'wait=+5', RULES.wait],
    ['wait=%2B5', 'wait=%2B5', RULES.wait],
    ['wait=05', 'wait=05', RULES.wait],
    ['wait=00', 'wait=00', RULES.wait],
    ['wait=31', 'wait=31', RULES.wait],
    ['wait=99', 'wait=99', RULES.wait],
    ['wait=100', 'wait=100', RULES.wait],
    ['wait=300', 'wait=300', RULES.wait],
    ['wait=99999999999999999999', 'wait=99999999999999999999', RULES.wait],
    ['wait=0x1', 'wait=0x1', RULES.wait],
    ['wait=Infinity', 'wait=Infinity', RULES.wait],
    ['wait=NaN', 'wait=NaN', RULES.wait],
    ['a wait in words', 'wait=ten', RULES.wait],
    ['a wait in full-width digits', 'wait=%EF%BC%95', RULES.wait],
    ['a wait with a leading space', 'wait=%205', RULES.wait],
    ['a wait with a trailing space', 'wait=5%20', RULES.wait],
    ['a wait with a trailing newline', 'wait=5%0A', RULES.wait],
    ['a wait with a unit', 'wait=5s', RULES.wait],
    ['an empty wait', 'wait=', RULES.wait],
    ['wait with no value', 'wait', RULES.wait],
    ['a wait that does not decode', 'wait=%zz', RULES.wait],
    ['wait twice', 'wait=5&wait=5', RULES.repeated('wait')],
    ['wait twice, the second invalid', 'wait=5&wait=0', RULES.repeated('wait')],
    ['an encoded repetition of wait', 'wait=5&%77ait=6', RULES.repeated('wait')],
    ['wait in capitals', 'WAIT=5', RULES.unknownParameter],
    ['wait with since', 'wait=10&since=2026-10-04T09:00:00Z', RULES.waitWithSince],
    ['since with wait', 'since=2026-10-04T09:00:00Z&wait=10', RULES.waitWithSince],
  ];

  for (const [description, query, message] of invalid) {
    it(`refuses ${description}`, () => {
      assertRefused(list, query, message);
    });
  }

  it('checks in a fixed order: names first, then include, limit, order, since, then after with since', () => {
    assertRefused(list, 'limit=0&unknown=1', RULES.unknownParameter);
    assertRefused(list, 'limit=0&limit=0&order=x', RULES.repeated('limit'));
    assertRefused(list, 'order=x&limit=0&include=x', RULES.includeParameter);
    assertRefused(list, 'order=x&limit=0', RULES.limit);
    assertRefused(list, 'since=x&order=x', RULES.order);
    assertRefused(list, `after=${AFTER}&since=x`, RULES.since);
  });

  it('checks wait after since and before the combinations, after with since first (D200)', () => {
    assertRefused(list, 'wait=0&wait=0&order=x', RULES.repeated('wait'));
    assertRefused(list, 'wait=0&order=x', RULES.order);
    assertRefused(list, 'wait=0&since=x', RULES.since);
    assertRefused(list, 'wait=0&since=2026-10-04T09:00:00Z', RULES.wait);
    assertRefused(list, `wait=0&after=${AFTER}`, RULES.wait);
    assertRefused(list, `wait=10&after=${AFTER}&since=2026-10-04T09:00:00Z`, RULES.afterWithSince);
  });

  it('refuses a run of digits of any length with the same message, quoting none of it (D200)', () => {
    // The digits are not counted (list-query.ts): a run of any length is
    // bounded by the cap alone, and one too long for a number is `Infinity`.
    for (const length of [3, 17, 308, 309, 10_000, 100_000]) {
      for (const digits of ['7'.repeat(length), `3${'0'.repeat(length - 1)}`]) {
        const error = refusal(list, `wait=${digits}`);

        assert.equal(error.statusCode, 400);
        assert.equal(error.errorCode, 1013);
        assert.equal(error.message, RULES.wait, `${length} digits`);
        assert.ok(!error.message.includes(digits), `${length} digits quoted`);
      }
    }
  });

  it('never echoes a name or a value in its message (D106)', () => {
    const secret = 'Qx7Zv9Kp2Wj4Ym8';

    for (const query of [
      `${secret}=1`,
      `limit=${secret}`,
      `order=${secret}`,
      `include=${secret}`,
      `since=${secret}`,
      `after=${secret}&since=${secret}`,
      `x-merchant-id=${secret}`,
      `wait=${secret}`,
      `wait=1&since=2026-10-04T09:00:00Z&x=${secret}`,
    ]) {
      assert.ok(!refusal(list, query).message.includes(secret.slice(0, 5)), query);
    }
  });
});

describe('sinceBound', () => {
  it('is the instant since names, in UTC to the microsecond', () => {
    assert.equal(sinceBound('2026-10-04T09:00:00Z'), '2026-10-04T09:00:00.000000Z');
    assert.equal(sinceBound('2026-10-04T09:00:00.123Z'), '2026-10-04T09:00:00.123000Z');
    assert.equal(sinceBound('2026-10-04t09:00:00.5z'), '2026-10-04T09:00:00.500000Z');
    assert.equal(sinceBound('2026-10-04T09:00:00.1231Z'), '2026-10-04T09:00:00.123100Z');
    assert.equal(sinceBound('2026-10-04T09:00:00.123456Z'), '2026-10-04T09:00:00.123456Z');
  });

  it('keeps the microseconds PostgreSQL stores and cuts anything finer', () => {
    // A stored time is a whole number of microseconds, so `t > since` holds
    // exactly when `t > since cut to its microsecond`.
    assert.equal(sinceBound('2026-10-04T09:00:00.123999Z'), '2026-10-04T09:00:00.123999Z');
    assert.equal(sinceBound('2026-10-04T09:00:00.1234567Z'), '2026-10-04T09:00:00.123456Z');
    assert.equal(sinceBound('2026-10-04T09:00:00.123000001Z'), '2026-10-04T09:00:00.123000Z');
    assert.equal(sinceBound('2026-10-04T09:00:00.999999999Z'), '2026-10-04T09:00:00.999999Z');
    assert.equal(sinceBound('2026-10-04T09:00:00.000001Z'), '2026-10-04T09:00:00.000001Z');
  });

  it('applies the offset, either sign, across a day and a year, keeping the microseconds', () => {
    assert.equal(sinceBound('2026-10-04T12:00:00+03:00'), '2026-10-04T09:00:00.000000Z');
    assert.equal(sinceBound('2026-10-04T05:30:00-03:30'), '2026-10-04T09:00:00.000000Z');
    assert.equal(sinceBound('2026-01-01T01:00:00+02:00'), '2025-12-31T23:00:00.000000Z');
    assert.equal(sinceBound('2026-10-04T09:00:00-00:00'), '2026-10-04T09:00:00.000000Z');
    assert.equal(sinceBound('2026-10-04T09:00:00+00:00'), '2026-10-04T09:00:00.000000Z');
    assert.equal(sinceBound('2026-10-04T12:00:00.123456+03:00'), '2026-10-04T09:00:00.123456Z');
    assert.equal(sinceBound('2026-01-01T00:59:59.999999-01:00'), '2026-01-01T01:59:59.999999Z');
  });

  it('knows the calendar: leap years, month lengths', () => {
    assert.equal(sinceBound('2024-02-29T00:00:00Z'), '2024-02-29T00:00:00.000000Z');
    assert.equal(sinceBound('2000-02-29T00:00:00Z'), '2000-02-29T00:00:00.000000Z');
    assert.equal(sinceBound('1900-02-29T00:00:00Z'), null);
    assert.equal(sinceBound('2026-04-31T00:00:00Z'), null);
    assert.equal(sinceBound('2026-12-31T23:59:59.999999Z'), '2026-12-31T23:59:59.999999Z');
  });

  it('reads the years 0 to 99 as themselves, and the edges of the calendar as infinities', () => {
    assert.equal(sinceBound('0099-06-01T00:00:00Z'), '0099-06-01T00:00:00.000000Z');
    assert.equal(sinceBound('0001-01-01T00:00:00Z'), '0001-01-01T00:00:00.000000Z');
    assert.equal(sinceBound('0000-01-01T00:00:00Z'), '-infinity');
    assert.equal(sinceBound('0000-12-31T23:59:59.999999Z'), '-infinity');
    assert.equal(sinceBound('0001-01-01T00:30:00+01:00'), '-infinity');
    assert.equal(sinceBound('9999-12-31T23:59:59.998Z'), '9999-12-31T23:59:59.998000Z');
    assert.equal(sinceBound('9999-12-31T23:59:59.999999999Z'), '9999-12-31T23:59:59.999999Z');
    assert.equal(sinceBound('9999-12-31T23:00:00-01:00'), 'infinity');
  });

  it('refuses a fraction or a value of any length beyond the rule, each within a second', () => {
    for (const size of [10, 1024, 64 * 1024, 1024 * 1024]) {
      for (const value of [
        `2026-10-04T09:00:00.${'1'.repeat(size)}Z`,
        `2026-10-04T09:00:00.${'1'.repeat(size)}`,
        `${'9'.repeat(size)}-10-04T09:00:00Z`,
        `2026-10-04T09:00:00${'+03:00'.repeat(size)}`,
        '2026-10-04T09:00:00Z'.repeat(size),
      ]) {
        const started = performance.now();

        assert.equal(sinceBound(value), null, `${value.length} characters`);

        const elapsed = performance.now() - started;

        assert.ok(elapsed < 1000, `${value.length} characters took ${Math.round(elapsed)} ms`);
      }
    }
  });

  it('refuses anything that is not a date-time with a zone offset', () => {
    for (const value of [
      '',
      'now',
      '2026-10-04',
      '2026-10-04T09:00Z',
      '2026-10-04T09:00:00',
      '2026-10-04 09:00:00Z',
      '2026-10-04T09:00:00+03',
      '2026-10-04T09:00:00+0300',
      '2026-10-04T09:00:00+03:60',
      '2026-10-04T09:00:00.Z',
      '2026-10-04T09:00:00,5Z',
      '2026-00-04T09:00:00Z',
      '2026-10-00T09:00:00Z',
      '2026-10-04T09:60:00Z',
      ' 2026-10-04T09:00:00Z',
      '2026-10-04T09:00:00Z ',
      '２０２６-10-04T09:00:00Z',
    ]) {
      assert.equal(sinceBound(value), null, value);
    }
  });
});

describe('asciiLowerCase', () => {
  it('folds ASCII letters and nothing else', () => {
    assert.equal(asciiLowerCase('X-Merchant-ID'), 'x-merchant-id');
    // U+0130 and U+212A (Kelvin) fold to `i` and `k` under Unicode rules, and not here.
    assert.equal(asciiLowerCase('ÄÖ-İ-K-É'), 'ÄÖ-İ-K-É');
    assert.equal(asciiLowerCase('Content-TYPE: Ä'), 'content-type: Ä');
  });
});

describe('parseQueryBody: what it accepts', () => {
  it('answers the plain list for an empty object', () => {
    assert.deepEqual(body({}), PLAIN_LIST);
    assert.deepEqual(body({ headers: [], body: [], include: [] }), PLAIN_LIST);
  });

  it('reads every field', () => {
    assert.deepEqual(
      body({
        headers: [{ name: 'X-Merchant-ID', value: '123' }],
        body: ['"orderId":42'],
        after: AFTER,
        limit: 5,
        order: 'asc',
        include: ['headers', 'body'],
      }),
      {
        includeHeaders: true,
        includeBody: true,
        limit: 5,
        order: 'asc',
        after: AFTER,
        receivedAfter: null,
        headers: [{ name: 'x-merchant-id', value: '123' }],
        bodies: [Buffer.from('"orderId":42')],
        wait: null,
      },
    );
    assert.equal(
      body({ since: '2026-10-04T12:00:00+03:00' }).receivedAfter,
      '2026-10-04T09:00:00.000000Z',
    );
  });

  it('folds a header name to ASCII lower case and keeps its value exactly', () => {
    assert.deepEqual(body({ headers: [{ name: 'Content-TYPE', value: ' A b ' }] }).headers, [
      { name: 'content-type', value: ' A b ' },
    ]);
    // Unicode is allowed and matched as itself: no stored name can hold it.
    assert.deepEqual(body({ headers: [{ name: 'X-Ünï', value: 'é' }] }).headers, [
      { name: 'x-Ünï', value: 'é' },
    ]);
  });

  it('accepts an empty header value, and header limits at their edges', () => {
    const name = 'n'.repeat(200);
    const value = 'ж'.repeat(100);

    assert.deepEqual(body({ headers: [{ name, value }] }).headers, [{ name, value }]);
    assert.deepEqual(body({ headers: [{ name: 'a', value: '' }] }).headers, [
      { name: 'a', value: '' },
    ]);
  });

  it('measures a body condition in bytes of UTF-8 and keeps a NUL', () => {
    assert.deepEqual(body({ body: ['éa'] }).bodies, [Buffer.from([0xc3, 0xa9, 0x61])]);
    assert.deepEqual(body({ body: ['a\u0000b'] }).bodies, [Buffer.from([0x61, 0x00, 0x62])]);
    assert.equal(body({ body: ['ж'.repeat(100)] }).bodies[0]?.length, 200);
    assert.deepEqual(parseQueryBody('{"body":["\\ud800"]}').bodies, [
      Buffer.from([0xef, 0xbf, 0xbd]),
    ]);
  });

  it('accepts 8 conditions in all, however they are shared', () => {
    const headers = (n: number) => Array.from({ length: n }, () => ({ name: 'a', value: 'b' }));
    const bodies = (n: number) => Array.from({ length: n }, () => 'abc');

    for (const n of [0, 3, 8]) {
      const query = body({ headers: headers(n), body: bodies(8 - n) });

      assert.equal(query.headers.length + query.bodies.length, 8);
    }
  });

  it('caps bodies at 20 by default, takes a limit from 1 to 1000 without them', () => {
    assert.equal(body({ include: ['body'] }).limit, 20);
    assert.equal(body({ include: ['body'], limit: 20 }).limit, 20);
    assert.equal(body({ include: ['headers'] }).limit, null);
    assert.equal(body({ limit: 1000 }).limit, 1000);
    // A JSON number is the number it writes.
    assert.equal(parseQueryBody('{"limit":1e3}').limit, 1000);
    assert.equal(parseQueryBody('{"limit":5.0}').limit, 5);
  });

  it('takes after as given: its shape is checked later, as 404 / 1003', () => {
    assert.equal(body({ after: 'not-an-id' }).after, 'not-an-id');
    assert.equal(body({ after: '' }).after, '');
  });

  it('ignores whitespace around the JSON', () => {
    assert.deepEqual(parseQueryBody(' \n{ "limit" : 3 }\r\n').limit, 3);
  });
});

describe('parseQueryBody: 1006 for a body that is not a JSON object', () => {
  for (const [description, rawBody] of [
    ['no body at all', undefined],
    ['an empty body', ''],
    ['text that is not JSON', 'limit=5'],
    ['truncated JSON', '{"limit":5'],
    ['a JSON array', '[]'],
    ['a JSON string', '"abc"'],
    ['null', 'null'],
  ] as const) {
    it(`refuses ${description}`, () => {
      assertRefused(parseQueryBody, rawBody, 'Request body must be a JSON object', 1006);
    });
  }
});

describe('parseQueryBody: 400 / 1013 for a field that breaks a rule', () => {
  const header = (entry: unknown) => ({ headers: [entry] });
  const invalid: [string, unknown, string][] = [
    ['headers as an object', { headers: { name: 'a', value: 'b' } }, RULES.headers],
    ['headers: null', { headers: null }, RULES.headers],
    ['9 header conditions', { headers: Array(9).fill({ name: 'a', value: 'b' }) }, RULES.headers],
    ['a header condition as a pair', header(['a', 'b']), RULES.header(0)],
    ['a header condition as a string', header('a: b'), RULES.header(0)],
    ['a header condition without a value', header({ name: 'a' }), RULES.header(0)],
    ['a header condition without a name', header({ value: 'b' }), RULES.header(0)],
    [
      'a header condition with another key',
      header({ name: 'a', value: 'b', op: 'eq' }),
      RULES.header(0),
    ],
    ['a header value as a number', header({ name: 'a', value: 123 }), RULES.header(0)],
    ['a header value: null', header({ name: 'a', value: null }), RULES.header(0)],
    ['a header name as an array', header({ name: ['a'], value: 'b' }), RULES.header(0)],
    [
      'the second header condition wrong',
      { headers: [{ name: 'a', value: 'b' }, {}] },
      RULES.header(1),
    ],
    ['an empty header name', header({ name: '', value: 'b' }), RULES.headerName(0)],
    [
      'a header name of 201 bytes',
      header({ name: 'n'.repeat(201), value: 'b' }),
      RULES.headerName(0),
    ],
    [
      'a header name of 101 characters and 202 bytes',
      header({ name: 'ж'.repeat(101), value: 'b' }),
      RULES.headerName(0),
    ],
    ['a header name with a NUL', header({ name: 'a\u0000b', value: 'b' }), RULES.headerName(0)],
    [
      'a header value of 201 bytes',
      header({ name: 'a', value: 'v'.repeat(201) }),
      RULES.headerValue(0),
    ],
    ['a header value with a NUL', header({ name: 'a', value: '\u0000' }), RULES.headerValue(0)],
    ['body as a string', { body: 'abc' }, RULES.body],
    ['body: null', { body: null }, RULES.body],
    ['9 body conditions', { body: Array(9).fill('abc') }, RULES.body],
    ['a body condition as a number', { body: [42] }, RULES.body],
    ['a body condition as an object', { body: [{ contains: 'abc' }] }, RULES.body],
    ['a body condition of 2 bytes', { body: ['ab'] }, RULES.bodyItem(0)],
    ['a body condition of 1 character and 2 bytes', { body: ['é'] }, RULES.bodyItem(0)],
    ['a body condition of 201 bytes', { body: ['abc', 'b'.repeat(201)] }, RULES.bodyItem(1)],
    [
      '9 conditions in all',
      { headers: Array(4).fill({ name: 'a', value: 'b' }), body: Array(5).fill('abc') },
      RULES.conditions,
    ],
    ['include as a string', { include: 'headers' }, RULES.includeField],
    ['include: null', { include: null }, RULES.includeField],
    ['include of something else', { include: ['raw'] }, RULES.includeField],
    ['include twice the same', { include: ['body', 'body'] }, RULES.includeField],
    ['include of three', { include: ['headers', 'body', 'headers'] }, RULES.includeField],
    ['include in capitals', { include: ['Body'] }, RULES.includeField],
    ['include of a number', { include: [1] }, RULES.includeField],
    ['limit: 0', { limit: 0 }, RULES.limit],
    ['limit: -1', { limit: -1 }, RULES.limit],
    ['limit: 1.5', { limit: 1.5 }, RULES.limit],
    ['limit: 1001', { limit: 1001 }, RULES.limit],
    ['limit as a string', { limit: '5' }, RULES.limit],
    ['limit: null', { limit: null }, RULES.limit],
    ['limit: true', { limit: true }, RULES.limit],
    ['limit: 21 with bodies', { include: ['body'], limit: 21 }, RULES.limitWithBody],
    ['order: newest', { order: 'newest' }, RULES.order],
    ['order: null', { order: null }, RULES.order],
    ['order: ["asc"]', { order: ['asc'] }, RULES.order],
    ['after as a number', { after: 42 }, RULES.afterField],
    ['after: null', { after: null }, RULES.afterField],
    ['after as an array', { after: [AFTER] }, RULES.afterField],
    ['since with no zone', { since: '2026-10-04T09:00:00' }, RULES.since],
    ['since as a number', { since: 1759568400 }, RULES.since],
    ['since: null', { since: null }, RULES.since],
    ['after with since', { after: AFTER, since: '2026-10-04T09:00:00Z' }, RULES.afterWithSince],
    ['an unknown key', { limit: 5, caseSensitive: false }, RULES.keys],
    ['a key named words', { words: ['abc'] }, RULES.keys],
    ['a key in another letter case', { Limit: 5 }, RULES.keys],
    ['wait, which only the GET takes (D200)', { wait: 5 }, RULES.keys],
  ];

  for (const [description, value, message] of invalid) {
    it(`refuses ${description}`, () => {
      assertRefused(body, value, message);
    });
  }

  it('refuses a key named __proto__ or constructor', () => {
    assertRefused(parseQueryBody, '{"limit":5,"__proto__":{"limit":6}}', RULES.keys);
    assertRefused(parseQueryBody, '{"constructor":1}', RULES.keys);
    assertRefused(
      parseQueryBody,
      '{"headers":[{"name":"a","value":"b","__proto__":{}}]}',
      RULES.header(0),
    );
  });

  it('checks in a fixed order, an unknown key last', () => {
    assertRefused(body, { other: 1, limit: 0 }, RULES.limit);
    assertRefused(
      body,
      { since: 'x', order: 'x', limit: 0, include: 'x', body: 'x', headers: 'x' },
      RULES.headers,
    );
    assertRefused(body, { since: 'x', order: 'x', limit: 0, include: 'x', body: 'x' }, RULES.body);
    assertRefused(body, { since: 'x', order: 'x', limit: 0, include: 'x' }, RULES.includeField);
    assertRefused(body, { since: 'x', order: 'x', limit: 0 }, RULES.limit);
    assertRefused(body, { since: 'x', after: 1, order: 'x' }, RULES.order);
    assertRefused(body, { since: 'x', after: 1 }, RULES.afterField);
    assertRefused(body, { since: 'x', after: AFTER }, RULES.since);
    assertRefused(
      body,
      { other: 1, after: AFTER, since: '2026-10-04T09:00:00Z' },
      RULES.afterWithSince,
    );
  });

  it('never echoes a condition or a key in its message (D106)', () => {
    const secret = 'Qx7Zv9Kp2Wj4Ym8';

    for (const value of [
      { headers: [{ name: secret.repeat(20), value: secret }] },
      { headers: [{ name: secret, value: secret.repeat(20) }] },
      { headers: [{ name: secret, value: `${secret}\u0000` }] },
      { headers: [{ name: secret, value: secret, [secret]: secret }] },
      { body: [secret.repeat(20)] },
      { body: [secret, 'ab'] },
      { body: Array(9).fill(secret) },
      { body: [secret], [secret]: secret },
      { body: [secret], limit: secret },
      { body: [secret], since: secret },
      { body: [secret], after: AFTER, since: '2026-10-04T09:00:00Z' },
    ]) {
      assert.ok(!refusal(body, value).message.includes(secret.slice(0, 5)), JSON.stringify(value));
    }

    assert.ok(
      !refusal(parseQueryBody, `{"body":["${secret}"`).message.includes(secret.slice(0, 5)),
    );
  });
});

/**
 * Made-up input built to break the parsers, at growing sizes: a query string
 * up to well past the 16 KiB a request line and its headers may hold, and a
 * body up to the 1 MiB Fastify lets through. Each must be answered - accepted,
 * or refused with its code - within a time bound.
 */
describe('hostile input at growing sizes', () => {
  const SIZES = [1024, 64 * 1024, MAX_BODY_BYTES];
  /** Generous for an input the size of the limit; a regression to quadratic time is seconds. */
  const LIMIT_MS = 1000;

  function answered<T>(
    parse: (input: T) => ListQuery,
    input: T,
    codes: number[],
  ): ListQuery | AppError {
    const started = performance.now();
    let outcome: ListQuery | AppError;

    try {
      outcome = parse(input);
    } catch (error) {
      assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);
      assert.ok(codes.includes(error.errorCode), `${error.errorCode}: ${error.message}`);
      outcome = error;
    }

    const elapsed = performance.now() - started;

    assert.ok(
      elapsed < LIMIT_MS,
      `${elapsed.toFixed(1)} ms for ${String(input).length} characters`,
    );

    return outcome;
  }

  function refusedWith<T>(parse: (input: T) => ListQuery, input: T, errorCode: number): void {
    const outcome = answered(parse, input, [errorCode]);

    assert.ok(outcome instanceof AppError, 'the input was accepted');
  }

  for (const size of SIZES) {
    it(`answers query strings of ${size} bytes`, () => {
      refusedWith(list, '&'.repeat(size) + 'x=1', 1013);
      refusedWith(list, `limit=${'9'.repeat(size)}`, 1013);
      refusedWith(list, `include=${'headers,'.repeat(size / 8)}`, 1013);
      refusedWith(list, `include=${','.repeat(size)}`, 1013);
      refusedWith(list, `since=${'2026-10-04T09:00:00Z'.repeat(size / 20)}`, 1013);
      refusedWith(list, `since=2026-10-04T09:00:00.${'1'.repeat(size)}Z`, 1013);
      refusedWith(list, `order=${'%'.repeat(size)}`, 1013);
      refusedWith(list, `${'a'.repeat(size)}=1`, 1013);
      refusedWith(list, 'limit=1&'.repeat(size / 8), 1013);
      refusedWith(list, `limit=${'%E9'.repeat(size / 3)}`, 1013);
      refusedWith(list, `limit=${'%00'.repeat(size / 3)}`, 1013);
      assert.equal(
        (answered(list, `after=${'a'.repeat(size)}`, []) as ListQuery).after?.length,
        size,
      );
      assert.deepEqual(answered(list, `${'&'.repeat(size)}limit=3`, []), {
        ...PLAIN_LIST,
        limit: 3,
      });
    });

    it(`answers a wait of ${size} bytes (D200)`, () => {
      refusedWith(list, `wait=${'9'.repeat(size)}`, 1013);
      refusedWith(list, `wait=${'0'.repeat(size)}1`, 1013);
      refusedWith(list, `wait=1${'0'.repeat(size)}`, 1013);
      refusedWith(list, `wait=${'1'.repeat(size)}`, 1013);
      refusedWith(list, `wait=${'%20'.repeat(size / 3)}5`, 1013);
      refusedWith(list, `wait=5${'%20'.repeat(size / 3)}`, 1013);
      refusedWith(list, `wait=${'+'.repeat(size)}5`, 1013);
      refusedWith(list, `wait=${'-'.repeat(size)}5`, 1013);
      refusedWith(list, `wait=1${'e1'.repeat(size / 2)}`, 1013);
      refusedWith(list, `wait=1.${'0'.repeat(size)}`, 1013);
      refusedWith(list, `wait=${'%'.repeat(size)}`, 1013);
      refusedWith(list, `wait=${'%E9'.repeat(size / 3)}`, 1013);
      refusedWith(list, `wait=${'%00'.repeat(size / 3)}`, 1013);
      refusedWith(list, 'wait=1&'.repeat(size / 7), 1013);
      refusedWith(list, `${'w'.repeat(size)}ait=5`, 1013);
      refusedWith(list, `wait=5&since=2026-10-04T09:00:00.${'1'.repeat(size)}Z`, 1013);
      assert.deepEqual(answered(list, `${'&'.repeat(size)}wait=30`, []), {
        ...PLAIN_LIST,
        wait: 30,
      });
    });

    it(`refuses ${size} bytes of conditions by their number, before reading one`, () => {
      refusedWith(
        parseQueryBody,
        JSON.stringify({ headers: Array(Math.floor(size / 30)).fill({ name: 'a', value: 'b' }) }),
        1013,
      );
      refusedWith(
        parseQueryBody,
        JSON.stringify({ body: Array(Math.floor(size / 6)).fill('abc') }),
        1013,
      );
      refusedWith(parseQueryBody, JSON.stringify({ include: Array(size / 8).fill('body') }), 1013);
      refusedWith(parseQueryBody, `{"headers":[${'[],'.repeat(size / 3)}[]]}`, 1013);
    });

    it(`refuses conditions of ${size} bytes without echoing them`, () => {
      refusedWith(parseQueryBody, JSON.stringify({ body: ['a'.repeat(size)] }), 1013);
      refusedWith(parseQueryBody, JSON.stringify({ body: ['😀'.repeat(size / 4)] }), 1013);
      refusedWith(parseQueryBody, `{"body":["${'\\ud800'.repeat(size / 6)}"]}`, 1013);
      refusedWith(
        parseQueryBody,
        JSON.stringify({ headers: [{ name: 'a'.repeat(size), value: '' }] }),
        1013,
      );
      refusedWith(
        parseQueryBody,
        JSON.stringify({ headers: [{ name: 'a', value: '\u0000'.repeat(size) }] }),
        1013,
      );
      refusedWith(parseQueryBody, JSON.stringify({ since: '9'.repeat(size) }), 1013);
      refusedWith(
        parseQueryBody,
        JSON.stringify({ limit: Number('9'.repeat(Math.min(size, 300))) }),
        1013,
      );
    });

    it(`takes a long after as given, to be refused as 404 / 1003 later (${size} bytes)`, () => {
      const outcome = answered(parseQueryBody, JSON.stringify({ after: 'a'.repeat(size) }), []);

      assert.equal((outcome as ListQuery).after?.length, size);
    });

    it(`answers ${size} bytes of nesting`, () => {
      const depth = size / 2;

      refusedWith(parseQueryBody, '['.repeat(depth) + ']'.repeat(depth), 1006);
      answered(
        parseQueryBody,
        `{"headers":[${'['.repeat(depth)}${']'.repeat(depth)}]}`,
        [1006, 1013],
      );
      answered(
        parseQueryBody,
        `{"body":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}}`,
        [1006, 1013],
      );
      answered(
        parseQueryBody,
        `{"headers":[{"name":${'['.repeat(depth)}${']'.repeat(depth)},"value":"b"}]}`,
        [1006, 1013],
      );
    });

    it(`refuses ${size} bytes of unknown keys beside valid fields`, () => {
      const keys = Array.from({ length: size / 12 }, (_, n) => `"k${n}":1`).join(',');

      refusedWith(parseQueryBody, `{"limit":3,${keys}}`, 1013);
      refusedWith(parseQueryBody, `{${keys},"limit":3}`, 1013);
      refusedWith(parseQueryBody, `{"limit":3,"${'k'.repeat(size)}":1}`, 1013);
    });

    it(`refuses ${size} bytes that never close`, () => {
      refusedWith(parseQueryBody, `{"body":["${'a'.repeat(size)}`, 1006);
      refusedWith(parseQueryBody, '{"headers":['.repeat(size / 12), 1006);
      refusedWith(parseQueryBody, '\u0000'.repeat(size), 1006);
    });
  }

  it('accepts the largest valid body: 8 conditions of 200 bytes, escaped at six bytes a character', () => {
    const value = '\\u0416'.repeat(100);
    const conditions = Array.from(
      { length: 4 },
      () => `{"name":"${'\\u0041'.repeat(200)}","value":"${value}"}`,
    );
    const outcome = answered(
      parseQueryBody,
      `{"headers":[${conditions.join(',')}],"body":[${Array.from({ length: 4 }, () => `"${value}"`).join(',')}]}`,
      [],
    ) as ListQuery;

    assert.equal(outcome.headers.length, 4);
    assert.ok(
      outcome.headers.every((one) => one.name === 'a'.repeat(200) && one.value === 'Ж'.repeat(100)),
    );
    assert.ok(outcome.bodies.every((bytes) => bytes.equals(Buffer.from('Ж'.repeat(100)))));
  });
});
