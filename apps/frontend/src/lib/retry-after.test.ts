import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ErrorCode } from '@webhook-inspector/shared';
import { ApiError, createSession } from '../api/client.ts';
import { parseRetryAfter } from './retry-after.ts';

/**
 * `Retry-After` as whole seconds on an `ApiError` (issue #128): what is read
 * and what is not, hostile values at growing sizes, and the value `request()`
 * puts on the error it throws for a refused answer.
 */

const SIZES = [1024, 64 * 1024, 1024 * 1024];

/** How long one hostile value may take; a linear pass over 1 MiB takes milliseconds. */
const HOSTILE_MS = 1_000;

function timed<T>(what: string, run: () => T): T {
  const started = performance.now();
  const result = run();
  const elapsed = performance.now() - started;

  assert.ok(elapsed < HOSTILE_MS, `${what} took ${Math.round(elapsed)} ms`);

  return result;
}

describe('parseRetryAfter', () => {
  it('reads a whole number of seconds of at least 1', () => {
    const cases: [string, number][] = [
      ['40', 40],
      ['1', 1],
      ['60', 60],
      ['040', 40],
      ['3600', 3600],
      ['9999999999', 9_999_999_999],
      [' 40 ', 40],
      ['\t40\t', 40],
    ];

    for (const [value, seconds] of cases) {
      assert.equal(parseRetryAfter(value), seconds, JSON.stringify(value));
    }
  });

  it('gives undefined for anything else', () => {
    const cases: (string | null | undefined)[] = [
      undefined,
      null,
      '',
      ' ',
      '0',
      '00',
      'abc',
      '40s',
      '40 s',
      '1.5',
      '40.0',
      '-1',
      '+40',
      '1e3',
      '0x10',
      'Infinity',
      'NaN',
      '４０',
      '٤٠',
      '40, 50',
      '40,40',
      '4 0',
      '99999999999',
      'Wed, 21 Oct 2015 07:28:00 GMT',
      'Fri, 09 Oct 2026 10:00:40 GMT',
      '40\u0000',
    ];

    for (const value of cases) {
      assert.equal(parseRetryAfter(value), undefined, JSON.stringify(value));
    }
  });

  it('reads a hostile value of any size quickly', () => {
    for (const size of SIZES) {
      const cases: [string, number | undefined][] = [
        ['9'.repeat(size), undefined],
        ['0'.repeat(size), undefined],
        [`${'0'.repeat(size)}5`, undefined],
        [`${'1'.repeat(size)}x`, undefined],
        [' '.repeat(size), undefined],
        ['\t'.repeat(size), undefined],
        [`${' '.repeat(size)}x`, undefined],
        [`${' '.repeat(size)}5${' '.repeat(size)}`, 5],
        [`${' '.repeat(size)}5${' '.repeat(size)}x`, undefined],
        ['Wed, 21 Oct 2015 07:28:00 GMT, '.repeat(Math.ceil(size / 31)), undefined],
        [`${'40, '.repeat(Math.ceil(size / 4))}40`, undefined],
      ];

      for (const [value, seconds] of cases) {
        assert.equal(
          timed(`a Retry-After of ${value.length} characters`, () => parseRetryAfter(value)),
          seconds,
        );
      }
    }
  });
});

/**
 * Through `createSession`, the call `Generate URL` makes, with `fetch`
 * answering: every refused answer carries its `Retry-After` on the `ApiError`,
 * whatever its status, and a successful one is untouched.
 */
describe('request() puts Retry-After on the ApiError', () => {
  const realFetch = globalThis.fetch;

  function answering(status: number, body: string | null, headers: Record<string, string> = {}) {
    globalThis.fetch = (async () =>
      new Response(body, {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      })) as typeof fetch;
  }

  async function refusal(): Promise<ApiError> {
    const error: unknown = await createSession().then(
      () => assert.fail('the creation did not reject'),
      (reason: unknown) => reason,
    );

    assert.ok(error instanceof ApiError);

    return error;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const LIMIT_BODY = JSON.stringify({
    errorCode: ErrorCode.RATE_LIMIT_EXCEEDED,
    message: 'Rate limit exceeded',
  });

  it('reads a 429 / 1015 with Retry-After: 40 as 40 seconds', async () => {
    answering(429, LIMIT_BODY, { 'Retry-After': '40' });

    const error = await refusal();

    assert.equal(error.status, 429);
    assert.equal(error.errorCode, ErrorCode.RATE_LIMIT_EXCEEDED);
    assert.equal(error.message, 'Rate limit exceeded');
    assert.equal(error.retryAfterSeconds, 40);
  });

  it('reads the header of any refused answer, a body that is not JSON included', async () => {
    answering(503, '<html>Service Unavailable</html>', {
      'Content-Type': 'text/html',
      'Retry-After': '5',
    });

    const error = await refusal();

    assert.equal(error.status, 503);
    assert.equal(error.errorCode, undefined);
    assert.equal(error.retryAfterSeconds, 5);
  });

  it('leaves it undefined without a usable header', async () => {
    const cases: Record<string, string>[] = [
      {},
      { 'Retry-After': '0' },
      { 'Retry-After': 'abc' },
      { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' },
      { 'Retry-After': '9'.repeat(64 * 1024) },
    ];

    for (const headers of cases) {
      answering(429, LIMIT_BODY, headers);

      assert.equal((await refusal()).retryAfterSeconds, undefined, JSON.stringify(headers));
    }
  });

  it('is undefined on an ApiError made without it', () => {
    assert.equal(new ApiError(500, ErrorCode.INTERNAL_ERROR, 'x').retryAfterSeconds, undefined);
  });
});
