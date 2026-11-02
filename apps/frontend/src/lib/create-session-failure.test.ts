import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { ErrorCode } from '@webhook-inspector/shared';
import { ApiError, createSession } from '../api/client.ts';
import { createSessionFailureText } from './create-session-failure.ts';
import { formatTooManySessions, SESSION_NOT_CREATED } from './landing-copy.ts';

/**
 * What `Generate URL` says when it creates nothing (issue #128): the two
 * texts as approved on 2026-10-08, no-break spaces included, and which one a
 * failure gets - directly, and through `createSession` with `fetch` answering
 * as the API, a proxy or a dead network would. E2E-14 shows the line on the
 * page, under the tile, and the page clearing it on the next click.
 */

const NBSP = '\u00a0';
const GENERAL = `This session could not be created. Please${NBSP}try${NBSP}again.`;
const LIMIT_40 = `Too many sessions created from your address. Try${NBSP}again${NBSP}in${NBSP}40${NBSP}s.`;

/** A `429` code that is not the address's limit, as #139's will be. */
const ANOTHER_429_CODE = 1019 as ErrorCode;

describe('the texts', () => {
  it('are the approved sentences, the second one joined by no-break spaces', () => {
    assert.equal(SESSION_NOT_CREATED, GENERAL);
    assert.equal(formatTooManySessions(40), LIMIT_40);
    assert.equal(
      formatTooManySessions(1),
      `Too many sessions created from your address. Try${NBSP}again${NBSP}in${NBSP}1${NBSP}s.`,
    );
  });

  it('break only between words of the first sentence and before the second', () => {
    for (const text of [SESSION_NOT_CREATED, formatTooManySessions(40)]) {
      const second = text.indexOf('. ') + 2;

      assert.ok(second > 2, text);
      // The second sentence has no ordinary space, so it never breaks inside…
      assert.ok(!text.slice(second).includes(' '), text);
      // …and the first has no no-break space, so it wraps as words do.
      assert.ok(!text.slice(0, second).includes(NBSP), text);
    }

    assert.equal(
      SESSION_NOT_CREATED.slice(SESSION_NOT_CREATED.indexOf('. ') + 2),
      `Please${NBSP}try${NBSP}again.`,
    );
    assert.equal(
      formatTooManySessions(40).slice(formatTooManySessions(40).indexOf('. ') + 2),
      `Try${NBSP}again${NBSP}in${NBSP}40${NBSP}s.`,
    );
  });
});

describe('createSessionFailureText', () => {
  it('names the seconds for a 429 / 1015 with a usable Retry-After', () => {
    assert.equal(
      createSessionFailureText(
        new ApiError(429, ErrorCode.RATE_LIMIT_EXCEEDED, 'Rate limit exceeded', 40),
      ),
      LIMIT_40,
    );
    assert.equal(
      createSessionFailureText(new ApiError(429, ErrorCode.RATE_LIMIT_EXCEEDED, 'x', 1)),
      formatTooManySessions(1),
    );
  });

  it('asks to try again for every other failure', () => {
    const failures: [string, unknown][] = [
      ['a rejected fetch', new TypeError('Failed to fetch')],
      ['503 with no code', new ApiError(503, undefined, 'Request failed')],
      ['503 with Retry-After', new ApiError(503, undefined, 'Request failed', 5)],
      ['500', new ApiError(500, ErrorCode.INTERNAL_ERROR, 'Internal error')],
      ['502 from a proxy', new ApiError(502, undefined, 'Request failed')],
      ['429 with another code', new ApiError(429, ANOTHER_429_CODE, 'Busy', 1)],
      ['429 / 1016', new ApiError(429, ErrorCode.LIST_BODIES_BUSY, 'Busy', 1)],
      ['429 / 1017', new ApiError(429, ErrorCode.LARGE_BODIES_BUSY, 'Busy', 1)],
      ['429 with no code', new ApiError(429, undefined, 'Request failed', 40)],
      ['1015 without Retry-After', new ApiError(429, ErrorCode.RATE_LIMIT_EXCEEDED, 'x')],
      [
        '1015 on a status other than 429',
        new ApiError(503, ErrorCode.RATE_LIMIT_EXCEEDED, 'x', 40),
      ],
      [
        'an object shaped like the refusal',
        { status: 429, errorCode: ErrorCode.RATE_LIMIT_EXCEEDED, retryAfterSeconds: 40 },
      ],
      ['an Error', new Error('boom')],
      ['undefined', undefined],
      ['null', null],
      ['a string', 'Too many sessions'],
    ];

    for (const [what, failure] of failures) {
      assert.equal(createSessionFailureText(failure), GENERAL, what);
    }
  });

  /** Through the client as the page calls it, `fetch` answering or not. */
  describe('through createSession, with fetch', () => {
    const realFetch = globalThis.fetch;

    function answering(status: number, body: string | null, headers: Record<string, string> = {}) {
      globalThis.fetch = (async () =>
        new Response(body, {
          status,
          headers: { 'Content-Type': 'application/json', ...headers },
        })) as typeof fetch;
    }

    async function textAfterCreation(): Promise<string> {
      const error: unknown = await createSession().then(
        () => assert.fail('the creation did not reject'),
        (reason: unknown) => reason,
      );

      return createSessionFailureText(error);
    }

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    const body = (errorCode: number) => JSON.stringify({ errorCode, message: 'Refused' });

    it('names 40 seconds for 429 / 1015 with Retry-After: 40', async () => {
      answering(429, body(ErrorCode.RATE_LIMIT_EXCEEDED), { 'Retry-After': '40' });

      assert.equal(await textAfterCreation(), LIMIT_40);
    });

    it('asks to try again for no answer, any other status or code, and no usable Retry-After', async () => {
      const cases: [string, () => void][] = [
        [
          'a rejected fetch',
          () => {
            globalThis.fetch = (() =>
              Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
          },
        ],
        [
          '503 with an HTML body',
          () => answering(503, '<html>503</html>', { 'Content-Type': 'text/html' }),
        ],
        ['503 with no body', () => answering(503, null)],
        ['500 / 1500', () => answering(500, body(ErrorCode.INTERNAL_ERROR))],
        [
          '429 with another code',
          () => answering(429, body(ANOTHER_429_CODE), { 'Retry-After': '1' }),
        ],
        ['1015 without Retry-After', () => answering(429, body(ErrorCode.RATE_LIMIT_EXCEEDED))],
        [
          '1015 with Retry-After: 0',
          () => answering(429, body(ErrorCode.RATE_LIMIT_EXCEEDED), { 'Retry-After': '0' }),
        ],
        [
          '1015 with a date',
          () =>
            answering(429, body(ErrorCode.RATE_LIMIT_EXCEEDED), {
              'Retry-After': 'Fri, 09 Oct 2026 10:00:40 GMT',
            }),
        ],
        [
          '1015 as a string',
          () => answering(429, JSON.stringify({ errorCode: '1015' }), { 'Retry-After': '40' }),
        ],
        ['a 201 whose body is not JSON', () => answering(201, '{"id":')],
      ];

      for (const [what, arrange] of cases) {
        arrange();
        assert.equal(await textAfterCreation(), GENERAL, what);
      }
    });
  });
});

/**
 * The page takes its words and its choice from here and draws the line on
 * both of its states (structural guards). E2E-14 checks what a visitor sees.
 */
describe('the home page says it under the tile', () => {
  const landing = readFileSync(new URL('../pages/LandingPage.tsx', import.meta.url), 'utf8');

  it('catches the creation and chooses the text here, in the language shown', () => {
    // The error is kept and its text asked for on every render, so the line
    // follows a change of the interface's language (D222).
    assert.ok(landing.includes('setCreateFailure({ error })'));
    assert.ok(landing.includes('createSessionFailureText(createFailure.error, m)'));
    assert.ok(landing.includes('setCreateFailure(null)'));
  });

  it('draws the line on both states, in the dialog error style, writing no words itself', () => {
    assert.equal(landing.match(/<CreateFailureLine text=\{failureText\} \/>/g)?.length, 2);
    assert.ok(
      landing.includes('<p role="alert" className="mt-3 text-[13px] leading-[1.5] text-danger">'),
    );

    for (const words of ['could not be created', 'Too many sessions', 'Try again']) {
      assert.ok(!landing.includes(words), `LandingPage.tsx writes "${words}" itself`);
    }
  });
});
