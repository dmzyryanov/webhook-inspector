import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { SESSION_IDLE_WINDOW_MAX_SECONDS } from '@webhook-inspector/shared';
import { createSession } from '../api/client.ts';
import { en } from '../i18n/en.ts';
import { ru } from '../i18n/ru.ts';
import {
  createSessionInit,
  DEFAULT_SESSION_OPTIONS,
  isDefaultOptions,
  isSessionWindow,
  SESSION_WINDOWS,
  sessionOptionsBody,
  tileHint,
  triggerName,
  triggerValues,
  windowLabel,
  type NewSessionOptions,
} from './session-options.ts';

/**
 * The new session's options (issue #216, D249; `Private session`, issue #228,
 * D259): what a creation sends with each choice, and what the trigger and the
 * tile's hint say. E2E-20 and E2E-21 check the same requests leaving the page.
 */

const NBSP = ' ';
const HOUR = 3600;
const DAY = 86_400;
const WEEK = SESSION_IDLE_WINDOW_MAX_SECONDS;

function options(
  idleSeconds: number,
  storeSourceIp: boolean,
  isPrivate = false,
): NewSessionOptions {
  return { idleSeconds, storeSourceIp, private: isPrivate };
}

describe('the windows', () => {
  it('are 7 days, 1 day and 1 hour, in that order, 7 days the default', () => {
    assert.deepEqual([...SESSION_WINDOWS], [604_800, 86_400, 3600]);
    assert.equal(WEEK, 604_800);
    assert.deepEqual(DEFAULT_SESSION_OPTIONS, {
      idleSeconds: 604_800,
      storeSourceIp: true,
      private: false,
    });
    assert.equal(isDefaultOptions(DEFAULT_SESSION_OPTIONS), true);
  });

  it('take none of another number, a string or nothing', () => {
    for (const value of [604_800, 86_400, 3600]) {
      assert.equal(isSessionWindow(value), true);
    }

    for (const value of [0, 60, 5400, 604_801, '3600', null, undefined, Number.NaN]) {
      assert.equal(isSessionWindow(value), false, String(value));
    }
  });
});

describe('createSessionInit', () => {
  /** Acceptance 1: no body and no `Content-Type` at all, as before (D104). */
  it('sends exactly { method: "POST" } with the defaults, given or not', () => {
    assert.deepEqual(createSessionInit(), { method: 'POST' });
    assert.deepEqual(createSessionInit(DEFAULT_SESSION_OPTIONS), { method: 'POST' });
    assert.deepEqual(createSessionInit(options(WEEK, true)), { method: 'POST' });
    assert.deepEqual(Object.keys(createSessionInit()), ['method']);
  });

  /** Acceptance 2: only the keys that differ, as JSON. */
  it('sends only the keys that differ from the default, with Content-Type: application/json', () => {
    const cases: [NewSessionOptions, string][] = [
      [options(HOUR, true), '{"expiresAfterIdleSeconds":3600}'],
      [options(DAY, true), '{"expiresAfterIdleSeconds":86400}'],
      [options(WEEK, false), '{"storeSourceIp":false}'],
      [options(HOUR, false), '{"expiresAfterIdleSeconds":3600,"storeSourceIp":false}'],
      [options(DAY, false), '{"expiresAfterIdleSeconds":86400,"storeSourceIp":false}'],
    ];

    for (const [chosen, body] of cases) {
      assert.deepEqual(createSessionInit(chosen), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    }
  });

  /** #228's criterion 1: `"private": true` beside #216's other chosen keys. */
  it('sends "private": true for a private session, beside the other chosen keys', () => {
    const cases: [NewSessionOptions, string][] = [
      [options(WEEK, true, true), '{"private":true}'],
      [options(HOUR, true, true), '{"expiresAfterIdleSeconds":3600,"private":true}'],
      [options(WEEK, false, true), '{"storeSourceIp":false,"private":true}'],
      [
        options(DAY, false, true),
        '{"expiresAfterIdleSeconds":86400,"storeSourceIp":false,"private":true}',
      ],
    ];

    for (const [chosen, body] of cases) {
      assert.equal(isDefaultOptions(chosen), false);
      assert.deepEqual(createSessionInit(chosen), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    }
  });

  /** #228's decision 6: unticked by default, and no `private` key sent then. */
  it('is public by default and never sends private: false', () => {
    assert.equal(DEFAULT_SESSION_OPTIONS.private, false);
    assert.deepEqual(createSessionInit(options(WEEK, true, false)), { method: 'POST' });
    assert.equal(sessionOptionsBody(options(HOUR, true, false))?.private, undefined);
  });

  it('never sends a key at its default value, nor an empty object', () => {
    assert.equal(sessionOptionsBody(DEFAULT_SESSION_OPTIONS), null);
    assert.deepEqual(sessionOptionsBody(options(HOUR, true)), { expiresAfterIdleSeconds: 3600 });
    assert.deepEqual(sessionOptionsBody(options(WEEK, false)), { storeSourceIp: false });
  });
});

describe('createSession', () => {
  const realFetch = globalThis.fetch;
  const CREATED = { id: 'x', receiveUrl: 'https://hook.qa-tools.ru/s/x', expiresAt: '' };

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Every request `createSession` made, as `fetch` received it. */
  function stubFetch(): { input: unknown; init: RequestInit | undefined }[] {
    const calls: { input: unknown; init: RequestInit | undefined }[] = [];

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init });

      return new Response(JSON.stringify(CREATED), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    return calls;
  }

  it('posts to /api/sessions with no body and no headers by default', async () => {
    const calls = stubFetch();

    await createSession();
    await createSession(DEFAULT_SESSION_OPTIONS);

    assert.equal(calls.length, 2);

    for (const call of calls) {
      assert.equal(call.input, '/api/sessions');
      assert.deepEqual(call.init, { method: 'POST' });
      assert.deepEqual(Object.keys(call.init ?? {}), ['method']);
    }
  });

  it('posts a choice as its differing keys, JSON-typed', async () => {
    const calls = stubFetch();

    assert.deepEqual(await createSession(options(HOUR, false)), CREATED);
    assert.deepEqual(calls[0]?.init, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"expiresAfterIdleSeconds":3600,"storeSourceIp":false}',
    });
  });

  /** 7 days and IP on again after another choice: back to no body. */
  it('sends no body once a choice is turned back to the defaults', async () => {
    const calls = stubFetch();
    let chosen = options(HOUR, false);

    chosen = { ...chosen, idleSeconds: WEEK };
    chosen = { ...chosen, storeSourceIp: true };
    await createSession(chosen);

    assert.deepEqual(calls[0]?.init, { method: 'POST' });
  });

  it('posts "private": true with no Authorization, so the server draws the key', async () => {
    const calls = stubFetch();

    await createSession(options(WEEK, true, true));

    assert.deepEqual(calls[0]?.init, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"private":true}',
    });

    let chosen = options(WEEK, true, true);

    chosen = { ...chosen, private: false };
    await createSession(chosen);

    assert.deepEqual(calls[1]?.init, { method: 'POST' });
  });
});

describe('the trigger', () => {
  it('shows both values, muted at the defaults', () => {
    assert.deepEqual(triggerValues(DEFAULT_SESSION_OPTIONS), {
      window: '7 days',
      address: 'IP stored',
      chosen: false,
      private: false,
    });
    assert.deepEqual(triggerValues(DEFAULT_SESSION_OPTIONS, ru), {
      window: `7${NBSP}дней`,
      address: 'IP сохраняется',
      chosen: false,
      private: false,
    });
  });

  it('is in ink once either value differs', () => {
    assert.deepEqual(triggerValues(options(HOUR, false)), {
      window: '1 hour',
      address: 'IP not stored',
      chosen: true,
      private: false,
    });
    assert.equal(triggerValues(options(DAY, true)).chosen, true);
    assert.equal(triggerValues(options(WEEK, false)).chosen, true);
    assert.deepEqual(triggerValues(options(HOUR, false), ru), {
      window: `1${NBSP}час`,
      address: 'IP не сохраняется',
      chosen: true,
      private: false,
    });
  });

  /** R1: the values keep their tone, and the lock follows them. */
  it('shows the lock after the values for a private session, the values keeping their tone', () => {
    assert.deepEqual(triggerValues(options(WEEK, true, true)), {
      window: '7 days',
      address: 'IP stored',
      chosen: false,
      private: true,
    });
    assert.equal(triggerValues(options(HOUR, true, true)).chosen, true);
  });

  it('is named by its visible values, Private session last once ticked', () => {
    assert.equal(triggerName(DEFAULT_SESSION_OPTIONS), 'New session options: 7 days · IP stored');
    assert.equal(
      triggerName(options(WEEK, true, true)),
      'New session options: 7 days · IP stored · Private session',
    );
    assert.equal(
      triggerName(options(HOUR, false, true), ru),
      `Параметры новой сессии: 1${NBSP}час · IP не сохраняется · Приватная сессия`,
    );
  });

  it('names the windows as the menu and the sheet do', () => {
    assert.deepEqual(
      SESSION_WINDOWS.map((seconds) => windowLabel(seconds, en)),
      ['7 days', '1 day', '1 hour'],
    );
    assert.deepEqual(
      SESSION_WINDOWS.map((seconds) => windowLabel(seconds, ru)),
      [`7${NBSP}дней`, `1${NBSP}день`, `1${NBSP}час`],
    );
  });
});

describe('the tile hint', () => {
  it('stays the page’s own while the window is 7 days, IP on or off, private or not', () => {
    assert.equal(
      tileHint(options(WEEK, true, true), true),
      '— your temporary endpoint, ready in a second',
    );

    for (const storeSourceIp of [true, false]) {
      assert.equal(
        tileHint(options(WEEK, storeSourceIp), true),
        '— your temporary endpoint, ready in a second',
      );
      assert.equal(tileHint(options(WEEK, storeSourceIp), false), '— a new temporary endpoint');
    }
  });

  it('states another window on both states of the page', () => {
    for (const firstVisit of [true, false]) {
      assert.equal(tileHint(options(HOUR, true), firstVisit), '— expires 1 hour after last use');
      assert.equal(tileHint(options(DAY, false), firstVisit), '— expires 1 day after last use');
      assert.equal(
        tileHint(options(HOUR, true), firstVisit, ru),
        `— истекает через 1${NBSP}час простоя`,
      );
      assert.equal(
        tileHint(options(DAY, true), firstVisit, ru),
        `— истекает через 1${NBSP}день простоя`,
      );
    }
  });

  it('keeps “IP not stored” whole in the checkbox hint', () => {
    assert.equal(en.newSession.storeIpHint, `Off: requests show “IP${NBSP}not${NBSP}stored”`);
    assert.equal(
      ru.newSession.storeIpHint,
      `Без галочки в запросах будет «IP${NBSP}не${NBSP}сохраняется»`,
    );
  });
});
