import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode, type SessionDetails } from '@webhook-inspector/shared';
import { ApiError } from '../api/client.ts';
import { createAccessPaste, type ReadSession } from './open-with-access.ts';
import type { PastedAccess } from './request-link.ts';

/**
 * The check behind `Open` on `Session not found` (issue #228, D259 point 6):
 * the sentence of frame R7 of the Figma page `Webhook Inspector · Private
 * sessions (#228)` only for a value that is no key or link and for a session
 * the server says is missing or gone; another failure told apart, since the key
 * may be right; one check at a time; and no answer heeded once the field has
 * left the page.
 */

const SESSION_ID = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';
const KEY = 'Rk3Xq9Lm2Vb7Nc4Hj8Wt1Pz6Fd0Sg5Ya2Ue7Io4TmNq';
const REQUEST_ID = '3f8a1b20-0000-4000-8000-000000000000';

function session(isPrivate: boolean): SessionDetails {
  return {
    id: SESSION_ID,
    expiresAt: '2026-10-01T00:00:00.000Z',
    receiveUrl: `https://hook.qa-tools.ru/s/${SESSION_ID}`,
    requestsCount: 0,
    expiresAfterIdleSeconds: 604_800,
    lifetimeEndsAt: null,
    storeSourceIp: true,
    private: isPrivate,
    response: null,
    customResponse: null,
    queue: null,
    rules: [],
  };
}

const OPEN: PastedAccess = { kind: 'open', sessionId: SESSION_ID, key: KEY, requestId: null };

/** A read that answers when the test says so, counting its calls. */
function heldRead(): {
  read: ReadSession;
  calls: Array<[string, string]>;
  answer: (value: SessionDetails) => void;
  fail: (error: unknown) => void;
} {
  const calls: Array<[string, string]> = [];
  let answer: (value: SessionDetails) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;

  return {
    read: (sessionId, key) => {
      calls.push([sessionId, key]);

      return new Promise<SessionDetails>((resolve, reject) => {
        answer = resolve;
        fail = reject;
      });
    },
    calls,
    answer: (value) => answer(value),
    fail: (error) => fail(error),
  };
}

describe('createAccessPaste', () => {
  it('does nothing but refocus for an empty value, asking no one', async () => {
    const held = heldRead();
    const paste = createAccessPaste(held.read);

    assert.deepEqual(await paste.check({ kind: 'empty' }), { kind: 'empty' });
    assert.equal(held.calls.length, 0);
  });

  it("says R7's sentence for a value that is no key or link, asking no one", async () => {
    const held = heldRead();
    const paste = createAccessPaste(held.read);

    assert.deepEqual(await paste.check({ kind: 'invalid' }), { kind: 'refused' });
    assert.equal(held.calls.length, 0);
  });

  it('opens a private session with the key it was asked with, at the request named', async () => {
    const paste = createAccessPaste(() => Promise.resolve(session(true)));

    assert.deepEqual(await paste.check({ ...OPEN, requestId: REQUEST_ID }), {
      kind: 'opened',
      sessionId: SESSION_ID,
      key: KEY,
      requestId: REQUEST_ID,
      private: true,
    });
  });

  it('opens a public session without asking to keep the key', async () => {
    const paste = createAccessPaste(() => Promise.resolve(session(false)));
    const outcome = await paste.check(OPEN);

    assert.equal(outcome?.kind, 'opened');
    assert.equal(outcome.kind === 'opened' && outcome.private, false);
  });

  it('asks the server once, for the session and with the key pasted', async () => {
    const held = heldRead();
    const paste = createAccessPaste(held.read);
    const checking = paste.check(OPEN);

    held.answer(session(true));
    await checking;
    assert.deepEqual(held.calls, [[SESSION_ID, KEY]]);
  });

  /** A wrong key is answered as a missing session (D245 point 6), and an expired one as `Session not found` (D133). */
  it("says R7's sentence only when the server says the session is missing or gone", async () => {
    for (const error of [
      new ApiError(404, ErrorCode.SESSION_NOT_FOUND, 'Session not found'),
      new ApiError(410, ErrorCode.SESSION_EXPIRED, 'Session expired'),
    ]) {
      const paste = createAccessPaste(() => Promise.reject(error));

      assert.deepEqual(await paste.check(OPEN), { kind: 'refused' }, `misread ${error.status}`);
    }
  });

  it('tells any other failure apart, since the key may be right', async () => {
    const others: unknown[] = [
      new ApiError(429, ErrorCode.RATE_LIMIT_EXCEEDED, 'Too many requests', 30),
      new ApiError(500, ErrorCode.INTERNAL_ERROR, 'Internal error'),
      new ApiError(502, undefined, 'Request failed'),
      new ApiError(503, undefined, 'Request failed'),
      new ApiError(404, undefined, 'Request failed'),
      new ApiError(404, ErrorCode.REQUEST_NOT_FOUND, 'Request not found'),
      new TypeError('Failed to fetch'),
      new DOMException('The operation was aborted.', 'AbortError'),
      new SyntaxError('Unexpected token < in JSON'),
      'not an error at all',
      null,
      undefined,
    ];

    for (const error of others) {
      const paste = createAccessPaste(() => Promise.reject(error));

      assert.deepEqual(
        await paste.check(OPEN),
        { kind: 'unreachable' },
        `misread ${String(error)}`,
      );
    }
  });

  it('ignores every submit while a check is in flight, at growing counts', async () => {
    for (const count of [1, 10, 100, 1_000]) {
      const held = heldRead();
      const paste = createAccessPaste(held.read);
      const first = paste.check(OPEN);
      const later: Array<Promise<unknown>> = [];

      for (let n = 0; n < count; n += 1) {
        later.push(
          paste.check(n % 3 === 0 ? OPEN : n % 3 === 1 ? { kind: 'empty' } : { kind: 'invalid' }),
        );
      }

      assert.deepEqual(
        await Promise.all(later),
        later.map(() => null),
      );
      assert.equal(held.calls.length, 1, `${count} submits`);

      held.fail(new ApiError(404, ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
      assert.deepEqual(await first, { kind: 'refused' });
    }
  });

  it('takes the next submit once a check has failed', async () => {
    const held = heldRead();
    const paste = createAccessPaste(held.read);
    const first = paste.check(OPEN);

    held.fail(new TypeError('Failed to fetch'));
    assert.deepEqual(await first, { kind: 'unreachable' });

    const second = paste.check(OPEN);

    held.answer(session(true));
    assert.equal((await second)?.kind, 'opened');
    assert.equal(held.calls.length, 2);
  });

  it('ignores every submit once a session has opened', async () => {
    const held = heldRead();
    const paste = createAccessPaste(held.read);
    const first = paste.check(OPEN);

    held.answer(session(true));
    assert.equal((await first)?.kind, 'opened');
    assert.equal(await paste.check(OPEN), null);
    assert.equal(await paste.check({ kind: 'invalid' }), null);
    assert.equal(held.calls.length, 1);
  });

  /** `Go to home page` clicked while the read was in flight stays on the home page. */
  it('ignores an answer that comes once the field has left the page', async () => {
    const answers: Array<(held: ReturnType<typeof heldRead>) => void> = [
      (held) => held.answer(session(true)),
      (held) => held.fail(new ApiError(404, ErrorCode.SESSION_NOT_FOUND, 'Session not found')),
      (held) => held.fail(new TypeError('Failed to fetch')),
    ];

    for (const settle of answers) {
      const held = heldRead();
      const paste = createAccessPaste(held.read);
      const checking = paste.check(OPEN);

      paste.dispose();
      settle(held);
      assert.equal(await checking, null);
    }
  });

  it('asks no one once the field has left the page', async () => {
    const held = heldRead();
    const paste = createAccessPaste(held.read);

    paste.dispose();
    assert.equal(await paste.check(OPEN), null);
    assert.equal(await paste.check({ kind: 'empty' }), null);
    assert.equal(held.calls.length, 0);
  });
});
