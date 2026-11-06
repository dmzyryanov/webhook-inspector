import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ErrorCode, SESSION_IDLE_DAYS, type SessionDetails } from '@webhook-inspector/shared';
import { ApiError } from '../api/client.ts';
import {
  accessKeyFor,
  holdAccessKey,
  releaseAllAccessKeys,
  storeAccessKey,
  type AccessKeyStorage,
} from './access-keys.ts';
import { en } from '../i18n/en.ts';
import { ru } from '../i18n/ru.ts';
import {
  classifySessionError,
  keepsNoAddress,
  readSessionPeriodically,
  reloadSessionOnConnection,
  SESSION_READ_INTERVAL_MS,
  SESSION_RETENTION_LINE,
  sessionAddressMarker,
  sessionExpiryLine,
  settleLoadFailure,
  settlePageStatus,
  type SessionPageStatus,
} from './session-lifetime.ts';

/** A well-formed session id: 43 letters and digits, as new ids are (D161). */
const VALID_ID = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

describe('SESSION_RETENTION_LINE', () => {
  /**
   * What the endpoint card now shows in the slot the countdown used to tick in
   * (D133). The component renders this string and nothing else there: no
   * remaining time, so no timer and nothing that can reach zero.
   */
  it('states the rule instead of counting down', () => {
    assert.equal(SESSION_RETENTION_LINE, 'SESSION EXPIRES 7 DAYS AFTER LAST USE');
  });

  /**
   * Issue #51: the line names what expires. The number is still the one the
   * backend enforces, composed rather than typed (D133).
   */
  it('names the session as what expires, with the number the backend enforces', () => {
    assert.ok(SESSION_RETENTION_LINE.startsWith('SESSION EXPIRES '));
    assert.ok(SESSION_RETENTION_LINE.includes(` ${SESSION_IDLE_DAYS} DAYS `));
    assert.doesNotMatch(SESSION_RETENTION_LINE, /KEPT FOR/);
  });
});

// The `Session not found` screen's wording is tested in `not-found.test.ts`.
// It no longer depends on the id's shape: an address that cannot be a session
// never reaches the session page and gets `Page not found` instead (D146, D147).

const SESSION: SessionDetails = {
  id: VALID_ID,
  expiresAt: '2026-10-01T00:00:00.000Z',
  receiveUrl: `https://hook.qa-tools.ru/s/${VALID_ID}`,
  requestsCount: 0,
  expiresAfterIdleSeconds: 604_800,
  lifetimeEndsAt: null,
  storeSourceIp: true,
  private: false,
  response: null,
  customResponse: null,
  queue: null,
  rules: [],
};

describe('classifySessionError', () => {
  /**
   * One screen for both documented session failures (D133). The API still
   * answers them differently; the client stops telling them apart.
   */
  it('reads an expired and an unknown session as the same thing', () => {
    assert.equal(
      classifySessionError(new ApiError(410, ErrorCode.SESSION_EXPIRED, 'Session expired')),
      'unavailable',
    );
    assert.equal(
      classifySessionError(new ApiError(404, ErrorCode.SESSION_NOT_FOUND, 'Session not found')),
      'unavailable',
    );
  });

  it('never dresses another failure up as a missing session', () => {
    const others = [
      new ApiError(404, ErrorCode.REQUEST_NOT_FOUND, 'Request not found'),
      new ApiError(500, ErrorCode.INTERNAL_ERROR, 'Internal error'),
      new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'Payload too large'),
      new TypeError('Failed to fetch'),
      'not an error at all',
    ];

    for (const error of others) {
      assert.equal(classifySessionError(error), 'error', `misread ${String(error)}`);
    }
  });
});

describe('settleLoadFailure', () => {
  /** A link's key: held in this tab by the page before its first load. */
  const LINK_KEY = 'Rk3Xq9Lm2Vb7Nc4Hj8Wt1Pz6Fd0Sg5Ya2Ue7Io4TmNq';
  const STORED_KEY = 'Zz3Xq9Lm2Vb7Nc4Hj8Wt1Pz6Fd0Sg5Ya2Ue7Io4TmNq';

  function memoryStorage(): AccessKeyStorage {
    const items = new Map<string, string>();

    return {
      getItem: (name) => items.get(name) ?? null,
      setItem: (name, value) => {
        items.set(name, value);
      },
    };
  }

  afterEach(() => {
    releaseAllAccessKeys();
  });

  /** D259: a refused load lets the tab's unchecked key go. */
  it('lets go of the key this tab held when the session is refused', () => {
    for (const error of [
      new ApiError(404, ErrorCode.SESSION_NOT_FOUND, 'Session not found'),
      new ApiError(410, ErrorCode.SESSION_EXPIRED, 'Session expired'),
    ]) {
      assert.ok(holdAccessKey(VALID_ID, LINK_KEY));
      assert.equal(settleLoadFailure(VALID_ID, error), 'unavailable');
      assert.equal(accessKeyFor(VALID_ID, null), null, `kept after ${error.status}`);
    }
  });

  it('keeps a stored key, which the status read decides about', () => {
    const storage = memoryStorage();

    storeAccessKey(storage, VALID_ID, STORED_KEY);
    holdAccessKey(VALID_ID, LINK_KEY);

    settleLoadFailure(VALID_ID, new ApiError(404, ErrorCode.SESSION_NOT_FOUND, 'Not found'));
    assert.equal(accessKeyFor(VALID_ID, storage), STORED_KEY);
  });

  it('keeps the key for `Try again` after a failure that says nothing about the session', () => {
    holdAccessKey(VALID_ID, LINK_KEY);

    for (const error of [
      new ApiError(500, ErrorCode.INTERNAL_ERROR, 'Internal error'),
      new ApiError(429, ErrorCode.RATE_LIMIT_EXCEEDED, 'Too many requests'),
      new TypeError('Failed to fetch'),
    ]) {
      assert.equal(settleLoadFailure(VALID_ID, error), 'error');
      assert.equal(accessKeyFor(VALID_ID, null), LINK_KEY, `lost after ${String(error)}`);
    }
  });

  it("lets go of no other session's key", () => {
    const other = 'H4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

    holdAccessKey(other, LINK_KEY);
    settleLoadFailure(VALID_ID, new ApiError(404, ErrorCode.SESSION_NOT_FOUND, 'Not found'));
    assert.equal(accessKeyFor(other, null), LINK_KEY);
  });
});

describe('reloadSessionOnConnection', () => {
  /**
   * The reload is what makes a tab left open a continuing use of its session:
   * the read endpoint slides the expiry, so a forgotten tab keeps its session
   * alive for as long as it stays open (D133).
   */
  it('reports the session it loaded, so the page holds the refreshed expiry', async () => {
    let calls = 0;

    const reloaded = await reloadSessionOnConnection(() => {
      calls += 1;

      return Promise.resolve(SESSION);
    });

    assert.equal(calls, 1, 'the session was not read on this connection');
    assert.deepEqual(reloaded, { outcome: 'loaded', session: SESSION });
  });

  /**
   * And it is how a long-open tab finds out its session is gone: an established
   * socket is not closed when its session expires (D076), so without this the
   * tab would sit on a dead session showing nothing wrong.
   */
  it('takes the page to the unavailable screen on either session answer', async () => {
    for (const error of [
      new ApiError(410, ErrorCode.SESSION_EXPIRED, 'Session expired'),
      new ApiError(404, ErrorCode.SESSION_NOT_FOUND, 'Session not found'),
    ]) {
      assert.deepEqual(await reloadSessionOnConnection(() => Promise.reject(error)), {
        outcome: 'unavailable',
      });
    }
  });

  it('keeps the page as it is when the reload merely failed', async () => {
    for (const error of [new TypeError('Failed to fetch'), new ApiError(500, undefined, 'boom')]) {
      assert.deepEqual(await reloadSessionOnConnection(() => Promise.reject(error)), {
        outcome: 'kept',
      });
    }
  });
});

describe('settlePageStatus', () => {
  const ALL: readonly SessionPageStatus[] = ['loading', 'ready', 'unavailable', 'error'];

  /**
   * A session refused or answered `404` / `410` never comes back (D133, D198),
   * so nothing that resolves later - the load on mount, a reload, an action's
   * answer, a transient failure - takes the page off `Session not found`.
   */
  it('keeps the page unavailable whatever is asked afterwards', () => {
    for (const next of ALL) {
      assert.equal(settlePageStatus('unavailable', next), 'unavailable', `moved to ${next}`);
    }
  });

  it('takes every other change as asked', () => {
    for (const current of ALL.filter((status) => status !== 'unavailable')) {
      for (const next of ALL) {
        assert.equal(settlePageStatus(current, next), next, `${current} to ${next}`);
      }
    }
  });

  // The order of a refusal and then the load on mount answering (!130) is
  // pinned through the socket in `api/realtime.test.ts`.
});

const NBSP = ' ';
const TODAY_EN = 'SESSION EXPIRES 7 DAYS AFTER LAST USE';
const TODAY_RU = `СЕССИЯ ИСТЕКАЕТ ЧЕРЕЗ 7${NBSP}ДНЕЙ ПРОСТОЯ`;

/** A sliding session's fields, as `GET` gives them (D242). */
function sliding(seconds: unknown): Record<string, unknown> {
  return { expiresAfterIdleSeconds: seconds, lifetimeEndsAt: null };
}

/** A session created with a lifetime: no window, its fixed end (D220). */
function fixed(end: unknown): Record<string, unknown> {
  return { expiresAfterIdleSeconds: null, lifetimeEndsAt: end };
}

describe('sessionExpiryLine', () => {
  /** Acceptance 6, and E2E-01 unchanged: a default session's card is today's. */
  it('gives today’s line, byte for byte, for a session that slides by 7 days', () => {
    assert.equal(sessionExpiryLine(sliding(604_800)), TODAY_EN);
    assert.equal(sessionExpiryLine(sliding(604_800), ru), TODAY_RU);
    assert.equal(sessionExpiryLine(SESSION), SESSION_RETENTION_LINE);
  });

  it('states 1 day and 1 hour as the frames do', () => {
    assert.equal(sessionExpiryLine(sliding(86_400)), 'SESSION EXPIRES 1 DAY AFTER LAST USE');
    assert.equal(sessionExpiryLine(sliding(3600)), 'SESSION EXPIRES 1 HOUR AFTER LAST USE');
    assert.equal(
      sessionExpiryLine(sliding(86_400), ru),
      `СЕССИЯ ИСТЕКАЕТ ЧЕРЕЗ 1${NBSP}ДЕНЬ ПРОСТОЯ`,
    );
    assert.equal(sessionExpiryLine(sliding(3600), ru), `СЕССИЯ ИСТЕКАЕТ ЧЕРЕЗ 1${NBSP}ЧАС ПРОСТОЯ`);
  });

  /**
   * A window the API allows but the page does not offer, made through the
   * API: whole days, else whole hours, else whole minutes, rounded down, so
   * never longer than the real window.
   */
  it('states another window in whole days, else hours, else minutes, never longer', () => {
    const cases: [number, string, string][] = [
      [5400, 'SESSION EXPIRES 90 MINUTES AFTER LAST USE', `90${NBSP}МИНУТ`],
      [3601, 'SESSION EXPIRES 60 MINUTES AFTER LAST USE', `60${NBSP}МИНУТ`],
      [3660, 'SESSION EXPIRES 61 MINUTES AFTER LAST USE', `61${NBSP}МИНУТУ`],
      [3719, 'SESSION EXPIRES 61 MINUTES AFTER LAST USE', `61${NBSP}МИНУТУ`],
      [3720, 'SESSION EXPIRES 62 MINUTES AFTER LAST USE', `62${NBSP}МИНУТЫ`],
      [7200, 'SESSION EXPIRES 2 HOURS AFTER LAST USE', `2${NBSP}ЧАСА`],
      [90_000, 'SESSION EXPIRES 25 HOURS AFTER LAST USE', `25${NBSP}ЧАСОВ`],
      [172_800, 'SESSION EXPIRES 2 DAYS AFTER LAST USE', `2${NBSP}ДНЯ`],
      [432_000, 'SESSION EXPIRES 5 DAYS AFTER LAST USE', `5${NBSP}ДНЕЙ`],
      [604_799, 'SESSION EXPIRES 10079 MINUTES AFTER LAST USE', `10079${NBSP}МИНУТ`],
    ];

    for (const [seconds, english, russian] of cases) {
      assert.equal(sessionExpiryLine(sliding(seconds)), english, String(seconds));
      assert.equal(
        sessionExpiryLine(sliding(seconds), ru),
        `СЕССИЯ ИСТЕКАЕТ ЧЕРЕЗ ${russian} ПРОСТОЯ`,
        String(seconds),
      );
    }
  });

  describe('a fixed end (Decision 5)', () => {
    const NOW = Date.parse('2026-09-24T10:00:00Z');
    const END = '2026-09-26T11:50:59.999Z';

    function line(end: string, timeZone: string, now = NOW, m = en): string {
      return sessionExpiryLine(fixed(end), m, { now, timeZone });
    }

    it('is the date and the time, minutes truncated, never TODAY or TOMORROW', () => {
      assert.equal(line(END, 'UTC'), 'SESSION EXPIRES 26 SEP AT 11:50');
      assert.equal(line(END, 'UTC', NOW, ru), 'СЕССИЯ ИСТЕКАЕТ 26 СЕНТ. В 11:50');
      // The same day and the next one are written as dates too.
      assert.equal(line('2026-09-24T10:30:00Z', 'UTC'), 'SESSION EXPIRES 24 SEP AT 10:30');
      assert.equal(line('2026-09-25T00:00:30Z', 'UTC'), 'SESSION EXPIRES 25 SEP AT 00:00');

      for (const m of [en, ru]) {
        for (const end of [END, '2026-09-24T10:30:00Z', '2026-09-25T09:00:00Z']) {
          assert.doesNotMatch(line(end, 'UTC', NOW, m), /TODAY|TOMORROW|СЕГОДНЯ|ЗАВТРА/);
        }
      }
    });

    it('takes the Russian month from the dictionary’s own table, upper-cased', () => {
      ru.months.forEach((month, index) => {
        const end = `2026-${String(index + 1).padStart(2, '0')}-15T12:00:00Z`;

        assert.equal(
          line(end, 'UTC', Date.parse('2026-06-01T00:00:00Z'), ru),
          `СЕССИЯ ИСТЕКАЕТ 15 ${month.toUpperCase()} В 12:00`,
        );
      });
    });

    it('adds the year when the end is in another year than now', () => {
      const newYearsEve = Date.parse('2026-12-30T12:00:00Z');

      assert.equal(
        line('2027-01-02T08:05:00Z', 'UTC', newYearsEve),
        'SESSION EXPIRES 2 JAN 2027 AT 08:05',
      );
      assert.equal(
        line('2027-01-02T08:05:00Z', 'UTC', newYearsEve, ru),
        'СЕССИЯ ИСТЕКАЕТ 2 ЯНВ. 2027 В 08:05',
      );
      assert.equal(
        line('2026-12-31T23:30:00Z', 'UTC', newYearsEve),
        'SESSION EXPIRES 31 DEC AT 23:30',
      );
    });

    it('reads the year in the viewer’s zone, for the end and for now alike', () => {
      const now = Date.parse('2026-12-31T20:00:00Z');
      const end = '2026-12-31T23:30:00Z';

      // UTC+14: both already in 2027 there.
      assert.equal(line(end, 'Pacific/Kiritimati', now), 'SESSION EXPIRES 1 JAN AT 13:30');
      // UTC−12: both still in 2026.
      assert.equal(line(end, 'Etc/GMT+12', now), 'SESSION EXPIRES 31 DEC AT 11:30');
      // UTC: now in 2026, the end in 2026.
      assert.equal(line(end, 'UTC', now), 'SESSION EXPIRES 31 DEC AT 23:30');
      // UTC+14 with now still in 2026 there and the end in 2027.
      assert.equal(
        line(end, 'Pacific/Kiritimati', Date.parse('2026-12-31T09:00:00Z')),
        'SESSION EXPIRES 1 JAN 2027 AT 13:30',
      );
    });

    it('follows the viewer’s zone: UTC+14, UTC−12, +5:30 and +5:45', () => {
      const end = '2026-09-26T11:50:00Z';

      assert.equal(line(end, 'Pacific/Kiritimati'), 'SESSION EXPIRES 27 SEP AT 01:50');
      assert.equal(line(end, 'Etc/GMT+12'), 'SESSION EXPIRES 25 SEP AT 23:50');
      assert.equal(line(end, 'Asia/Kolkata'), 'SESSION EXPIRES 26 SEP AT 17:20');
      assert.equal(line(end, 'Asia/Kathmandu'), 'SESSION EXPIRES 26 SEP AT 17:35');
      assert.equal(line(end, 'Asia/Kathmandu', NOW, ru), 'СЕССИЯ ИСТЕКАЕТ 26 СЕНТ. В 17:35');
    });

    /** Europe/Berlin leaves summer time at 01:00 UTC on 2026-10-25. */
    it('writes the wall clock on a DST day, the repeated hour included', () => {
      const now = Date.parse('2026-10-24T12:00:00Z');

      assert.equal(
        line('2026-10-24T23:59:00Z', 'Europe/Berlin', now),
        'SESSION EXPIRES 25 OCT AT 01:59',
      );
      assert.equal(
        line('2026-10-25T00:30:00Z', 'Europe/Berlin', now),
        'SESSION EXPIRES 25 OCT AT 02:30',
      );
      assert.equal(
        line('2026-10-25T01:30:00Z', 'Europe/Berlin', now),
        'SESSION EXPIRES 25 OCT AT 02:30',
      );
      assert.equal(
        line('2026-10-25T02:15:00Z', 'Europe/Berlin', now),
        'SESSION EXPIRES 25 OCT AT 03:15',
      );
    });

    /** No timer declares a session gone in an open tab: the server does (D076, D133). */
    it('writes an end already past the same way', () => {
      assert.equal(
        line('2026-09-26T11:50:00Z', 'UTC', Date.parse('2026-09-27T00:00:00Z')),
        'SESSION EXPIRES 26 SEP AT 11:50',
      );
      assert.equal(
        line('2025-09-26T11:50:00Z', 'UTC', Date.parse('2026-09-27T00:00:00Z')),
        'SESSION EXPIRES 26 SEP 2025 AT 11:50',
      );
    });

    it('takes an offset other than Z, and a time without seconds', () => {
      assert.equal(line('2026-09-26T14:50:00+03:00', 'UTC'), 'SESSION EXPIRES 26 SEP AT 11:50');
      assert.equal(line('2026-09-26T11:50Z', 'UTC'), 'SESSION EXPIRES 26 SEP AT 11:50');
    });

    it('falls back to today’s line for a zone the browser does not know', () => {
      assert.equal(line(END, 'Mars/Olympus_Mons'), TODAY_EN);
    });
  });

  /** An older backend, or an answer outside the contract: today's line, no error. */
  it('gives today’s line for absent, null or unreadable fields', () => {
    let deep: unknown = [];

    for (let depth = 0; depth < 10_000; depth += 1) {
      deep = [deep];
    }

    const hostile: unknown[] = [
      undefined,
      null,
      '',
      '3600',
      '604800',
      -3600,
      0,
      3599,
      604_801,
      5400.5,
      Number.NaN,
      Infinity,
      JSON.parse('1e400') as number,
      -Infinity,
      true,
      {},
      [],
      [3600],
      { value: 3600 },
      deep,
      'x'.repeat(1_000_000),
    ];

    for (const m of [en, ru]) {
      const today = m === en ? TODAY_EN : TODAY_RU;

      assert.equal(sessionExpiryLine(undefined, m), today);
      assert.equal(sessionExpiryLine(null, m), today);
      assert.equal(sessionExpiryLine({}, m), today);
      assert.equal(sessionExpiryLine(fixed(null), m), today);

      for (const value of hostile) {
        assert.equal(sessionExpiryLine(sliding(value), m), today);
        assert.equal(sessionExpiryLine(fixed(value), m), today);
        assert.equal(
          sessionExpiryLine({ expiresAfterIdleSeconds: value, lifetimeEndsAt: value }, m),
          today,
        );
      }

      for (const end of [
        'tomorrow',
        '2026-13-45T99:99:99Z',
        '2026-09-26',
        '2026-09-26 11:50:00Z',
        '2026-09-26T11:50:00',
        ` 2026-09-26T11:50:00Z`,
        `2026-09-26T11:50:00.${'9'.repeat(1_000_000)}Z`,
      ]) {
        assert.equal(
          sessionExpiryLine(fixed(end), m, { timeZone: 'UTC' }),
          today,
          end.slice(0, 40),
        );
      }
    }
  });

  it('prefers the window when an answer gives both, and reads nothing from a non-object', () => {
    assert.equal(
      sessionExpiryLine({ expiresAfterIdleSeconds: 3600, lifetimeEndsAt: '2026-09-26T11:50:00Z' }),
      'SESSION EXPIRES 1 HOUR AFTER LAST USE',
    );

    for (const value of ['3600', 3600, true, [3600]]) {
      assert.equal(sessionExpiryLine(value as never), TODAY_EN);
    }
  });

  it('answers a megabyte of fields within a bound', () => {
    const started = performance.now();

    for (let round = 0; round < 20; round += 1) {
      sessionExpiryLine(fixed(`2026-09-26T11:50:00Z${'0'.repeat(1_000_000)}`), en);
      sessionExpiryLine(sliding('9'.repeat(1_000_000)), en);
    }

    assert.ok(performance.now() - started < 1000);
  });
});

describe('sessionAddressMarker and keepsNoAddress', () => {
  it('say IP NOT STORED for a session that keeps no address', () => {
    const session = { ...SESSION, storeSourceIp: false };

    assert.equal(sessionAddressMarker(session), 'IP NOT STORED');
    assert.equal(sessionAddressMarker(session, ru), 'IP НЕ СОХРАНЯЕТСЯ');
    assert.equal(keepsNoAddress(session), true);
  });

  /** A default session's card is unchanged; an older backend's answer is a default session's. */
  it('say nothing for any other, an absent or unreadable field included', () => {
    for (const value of [true, undefined, null, 'false', 0, '', {}, []]) {
      const session = { ...SESSION, storeSourceIp: value };

      assert.equal(sessionAddressMarker(session as never), null, String(value));
      assert.equal(keepsNoAddress(session as never), false, String(value));
    }

    assert.equal(sessionAddressMarker(null), null);
    assert.equal(keepsNoAddress(undefined), false);
  });

  it('put the marker after the line from 768 px, one line', () => {
    const session = { expiresAfterIdleSeconds: 3600, lifetimeEndsAt: null, storeSourceIp: false };

    assert.equal(
      `${sessionExpiryLine(session)} · ${sessionAddressMarker(session) ?? ''}`,
      'SESSION EXPIRES 1 HOUR AFTER LAST USE · IP NOT STORED',
    );
  });
});

describe('readSessionPeriodically', () => {
  /** Lets the promise chains a tick started settle. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  it('reads the session every 10 minutes, and stops when asked', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    let reads = 0;
    const stop = readSessionPeriodically(() => {
      reads += 1;

      return Promise.resolve();
    });

    assert.equal(SESSION_READ_INTERVAL_MS, 600_000);
    t.mock.timers.tick(SESSION_READ_INTERVAL_MS - 1);
    await settle();
    assert.equal(reads, 0);

    t.mock.timers.tick(1);
    await settle();
    assert.equal(reads, 1);

    for (let tick = 0; tick < 2; tick += 1) {
      t.mock.timers.tick(SESSION_READ_INTERVAL_MS);
      await settle();
    }

    assert.equal(reads, 3);

    stop();

    for (let tick = 0; tick < 6; tick += 1) {
      t.mock.timers.tick(SESSION_READ_INTERVAL_MS);
      await settle();
    }

    assert.equal(reads, 3);
  });

  /** Acceptance 5: a `410` to that read takes the page over, as a reconnect's does. */
  it('takes the page to Session not found when the read answers 410 or 404', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    for (const error of [
      new ApiError(410, ErrorCode.SESSION_EXPIRED, 'Session expired'),
      new ApiError(404, ErrorCode.SESSION_NOT_FOUND, 'Session not found'),
    ]) {
      let status: SessionPageStatus = 'ready';
      const stop = readSessionPeriodically(async () => {
        const reloaded = await reloadSessionOnConnection(() => Promise.reject(error));

        if (reloaded.outcome === 'unavailable') {
          status = settlePageStatus(status, 'unavailable');
        }
      });

      t.mock.timers.tick(SESSION_READ_INTERVAL_MS);
      await settle();
      assert.equal(status, 'unavailable', String(error.status));
      stop();
    }
  });

  /** Hidden, offline or refused: the page keeps what it shows and tries again. */
  it('keeps the page and reads again after a read that failed: offline, 429, 500', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const failures = [
      new TypeError('Failed to fetch'),
      new ApiError(429, ErrorCode.RATE_LIMIT_EXCEEDED, 'Too many requests', 30),
      new ApiError(500, undefined, 'boom'),
    ];
    let status: SessionPageStatus = 'ready';
    let reads = 0;
    const stop = readSessionPeriodically(async () => {
      const failure = failures[reads % failures.length];

      reads += 1;

      const reloaded = await reloadSessionOnConnection(() => Promise.reject(failure));

      assert.equal(reloaded.outcome, 'kept');
    });

    for (let tick = 0; tick < 3; tick += 1) {
      t.mock.timers.tick(SESSION_READ_INTERVAL_MS);
      await settle();
    }

    assert.equal(reads, 3);
    assert.equal(status, 'ready');

    // A read that throws instead of rejecting stops nothing either.
    stop();

    let thrown = 0;
    const stopThrowing = readSessionPeriodically(() => {
      thrown += 1;
      throw new Error('synchronous');
    });

    for (let tick = 0; tick < 2; tick += 1) {
      t.mock.timers.tick(SESSION_READ_INTERVAL_MS);
      await settle();
    }

    assert.equal(thrown, 2);
    stopThrowing();
    status = settlePageStatus(status, 'ready');
    assert.equal(status, 'ready');
  });

  it('starts no read while the previous one is still in flight', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    let reads = 0;
    let finish: () => void = () => undefined;
    const stop = readSessionPeriodically(() => {
      reads += 1;

      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    for (let tick = 0; tick < 5; tick += 1) {
      t.mock.timers.tick(SESSION_READ_INTERVAL_MS);
      await settle();
    }

    assert.equal(reads, 1);

    finish();
    await settle();
    t.mock.timers.tick(SESSION_READ_INTERVAL_MS);
    await settle();
    assert.equal(reads, 2);
    stop();
  });
});
