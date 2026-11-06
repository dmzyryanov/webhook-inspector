/**
 * Everything the client does about a session's lifetime (D133): what the
 * interface says about it, what keeps an open tab's session alive, and how the
 * page reacts to a session that is no longer available.
 *
 * The retention line is composed from `SESSION_IDLE_DAYS`, so the number the
 * backend enforces and the number the page states cannot drift apart; so is the
 * `Session not found` screen's body, which lives with the other not-found
 * wording in `not-found.ts` (D147). The decisions live here, beside the other
 * presentation logic, because that is the part of the frontend that is
 * unit-tested; components are not (D025, D061).
 */
import {
  ErrorCode,
  SESSION_IDLE_DAYS,
  SESSION_IDLE_WINDOW_MAX_SECONDS,
  SESSION_IDLE_WINDOW_MIN_SECONDS,
  type SessionDetails,
} from '@webhook-inspector/shared';
import { ApiError } from '../api/client.ts';
import { en, type Messages } from '../i18n/en.ts';
import { releaseAccessKey } from './access-keys.ts';

/**
 * The session page's standing statement of the rule, in the metadata slot the
 * countdown used to occupy.
 *
 * It replaces the counter rather than removing it: this is a public anonymous
 * service that warns against sending production data, and the only on-screen
 * statement that the data is temporary is worth more than a number which - the
 * page load itself being a use - could never approach zero in front of the
 * person reading it (D133).
 *
 * It names the session as what expires: `KEPT FOR 7 DAYS` did not say what was
 * kept (issue #51, D158). In Russian it is `СЕССИЯ ИСТЕКАЕТ ЧЕРЕЗ 7 ДНЕЙ
 * ПРОСТОЯ`, which fits a phone's card where the literal translation does not
 * (D222).
 */
export function sessionRetentionLine(m: Messages = en): string {
  return m.lifetime.retention(SESSION_IDLE_DAYS);
}

/** The line in English. */
export const SESSION_RETENTION_LINE = sessionRetentionLine(en);

/**
 * What the session read says about the rule a session follows (D242, D243),
 * as it arrived: every field may be missing or of any type, from an older
 * backend or an answer outside the contract, and is read as the contract
 * says only when it is.
 */
export interface SessionRuleFields {
  expiresAfterIdleSeconds?: unknown;
  lifetimeEndsAt?: unknown;
  storeSourceIp?: unknown;
}

/** The moment and the time zone a fixed end is written for; tests pin both. */
export interface LineClock {
  /** Milliseconds since the epoch; `Date.now()` when absent. */
  now?: number;
  /** An IANA zone; the viewer's own when absent (D042). */
  timeZone?: string;
}

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

/**
 * A fixed end as the API writes it (D220): UTC ISO 8601, with a zone. Checked
 * before `Date.parse` reads it, and short, so a megabyte of text costs one
 * length check.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_INSTANT_MAX_LENGTH = 40;

/** Whether the window is one the API can give: an integer from 1 hour to 7 days (D242). */
function isIdleWindow(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= SESSION_IDLE_WINDOW_MIN_SECONDS &&
    value <= SESSION_IDLE_WINDOW_MAX_SECONDS
  );
}

/**
 * A window in whole days, else whole hours, else whole minutes, rounded down,
 * so the line never states a window longer than the real one: 604800 is
 * today's line, 86400 `1 DAY`, 3600 `1 HOUR`, 5400 `90 MINUTES`.
 */
function idleLine(seconds: number, m: Messages): string {
  if (seconds % DAY === 0) {
    return m.lifetime.retention(seconds / DAY);
  }

  if (seconds % HOUR === 0) {
    return m.lifetime.retentionHours(seconds / HOUR);
  }

  return m.lifetime.retentionMinutes(Math.floor(seconds / MINUTE));
}

/**
 * A fixed end in the viewer's time (Decision 5 of #216): `SESSION EXPIRES 26
 * SEP AT 11:50`, the month from the dictionary's own table, upper-cased, the
 * year only when it differs from this one, and never `TODAY` or `TOMORROW`,
 * which would go stale past midnight in an open tab. `Intl` drops the
 * seconds rather than rounding, so the time is never later than the real end.
 * An end already past is written the same way: no timer declares a session
 * gone in an open tab, the server does (D076, D133). `null` for anything that
 * is not an instant, so the caller falls back to today's line.
 */
function fixedEndLine(end: unknown, m: Messages, clock: LineClock): string | null {
  if (typeof end !== 'string' || end.length > ISO_INSTANT_MAX_LENGTH || !ISO_INSTANT.test(end)) {
    return null;
  }

  const instant = Date.parse(end);

  if (Number.isNaN(instant)) {
    return null;
  }

  try {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: clock.timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      // Not `hour12: false`, which some engines render as `24` at midnight.
      hourCycle: 'h23',
    });
    const parts = (at: number) => {
      const list = format.formatToParts(at);

      return (type: Intl.DateTimeFormatPartTypes): string =>
        list.find((part) => part.type === type)?.value ?? '';
    };
    const ends = parts(instant);
    const year = Number(ends('year'));
    const thisYear = Number(parts(clock.now ?? Date.now())('year'));
    const month = m.months[Number(ends('month')) - 1];

    if (month === undefined) {
      return null;
    }

    return m.lifetime.retentionUntil(
      Number(ends('day')),
      month.toUpperCase(),
      year === thisYear ? null : year,
      `${ends('hour')}:${ends('minute')}`,
    );
  } catch {
    return null;
  }
}

/**
 * The session card's line, a pure function of the session read's
 * `expiresAfterIdleSeconds`, `lifetimeEndsAt` and the language (issue #216,
 * D249): the window a session slides by, or the fixed end of one created with
 * a lifetime. Anything else - both absent, both `null`, a value outside the
 * contract, an older backend's answer - gives today's line, which is the
 * default session's and stays byte for byte what it was (D158, D222).
 */
export function sessionExpiryLine(
  session: SessionRuleFields | null | undefined,
  m: Messages = en,
  clock: LineClock = {},
): string {
  const fields: SessionRuleFields = typeof session === 'object' && session !== null ? session : {};
  const window = fields.expiresAfterIdleSeconds;

  if (isIdleWindow(window)) {
    return idleLine(window, m);
  }

  if (window === null) {
    const end = fixedEndLine(fields.lifetimeEndsAt, m, clock);

    if (end !== null) {
      return end;
    }
  }

  return sessionRetentionLine(m);
}

/**
 * `IP NOT STORED` beside the line for a session created to keep no sender
 * address (D243, D249), and nothing for every other: only `false` says so,
 * so an older backend's answer without the field reads as today's session.
 */
export function sessionAddressMarker(
  session: SessionRuleFields | null | undefined,
  m: Messages = en,
): string | null {
  return typeof session === 'object' && session !== null && session.storeSourceIp === false
    ? m.lifetime.ipNotStored
    : null;
}

/**
 * Whether the session's requests read `IP not stored` where an address is
 * missing (D249): only for a session the read says keeps none.
 */
export function keepsNoAddress(session: SessionRuleFields | null | undefined): boolean {
  return typeof session === 'object' && session !== null && session.storeSourceIp === false;
}

/** The states the session page can be in. */
export type SessionPageStatus = 'loading' | 'ready' | 'unavailable' | 'error';

/**
 * The page's status once `next` is asked for while it is in `current`.
 *
 * `unavailable` is final. A session the server has answered `404` or `410`
 * for, or refused or closed a connection to with `4404` or `4410`, does not
 * come back: an expired session cannot be revived and a deleted one is gone
 * (D133, D198). So once the page shows `Session not found`, nothing that
 * resolves later takes it off: not the load on mount, whose answers can
 * arrive after the socket was closed because the session was deleted
 * meanwhile, not a list or session reload, and not an action that failed for
 * another reason and asks for `ready` to keep its requests on screen. The
 * socket is not reopened after a refusal, so nothing would correct a page
 * that went back to the session. Every other change is taken as asked.
 *
 * `SessionPage` changes its status through this and nothing else.
 */
export function settlePageStatus(
  current: SessionPageStatus,
  next: SessionPageStatus,
): SessionPageStatus {
  return current === 'unavailable' ? current : next;
}

/**
 * How a failed API call decides the fate of the page.
 *
 * The two documented session failures share one screen (D133). `410` and `404`
 * are still different answers - the API contract is unchanged - but the client
 * no longer tells them apart: a session is either available or it is not.
 *
 * Everything else - a network failure, a 500, a request that succeeded for the
 * session but failed for its list - is an error rather than a missing session,
 * which would send the viewer looking for the wrong problem. `1003
 * REQUEST_NOT_FOUND` is among them: it says nothing about the session, and the
 * caller that can act on it does so before asking here.
 */
export function classifySessionError(error: unknown): SessionPageStatus {
  if (
    error instanceof ApiError &&
    (error.errorCode === ErrorCode.SESSION_EXPIRED ||
      error.errorCode === ErrorCode.SESSION_NOT_FOUND)
  ) {
    return 'unavailable';
  }

  return 'error';
}

/**
 * The page's status after an action on its session failed - a request
 * opened, or the one chosen to compare with loaded: a session-level failure
 * takes the page over, and anything else is reported in place by `report`,
 * leaving the captured requests on screen (`ready`).
 */
export function classifySessionFailure(error: unknown, report: () => void): SessionPageStatus {
  const classified = classifySessionError(error);

  if (classified === 'error') {
    report();

    return 'ready';
  }

  return classified;
}

/**
 * The page's next status after its first load failed (D133), letting go of
 * the key this tab held for the session when the API refused it (D259): a
 * link's key, unchecked until then, that opened nothing. A stored key stays;
 * the home page's status read decides about it (D199). A failure that says
 * nothing about the session keeps the key, for `Try again`.
 */
export function settleLoadFailure(sessionId: string, error: unknown): SessionPageStatus {
  const next = classifySessionError(error);

  if (next === 'unavailable') {
    releaseAccessKey(sessionId);
  }

  return next;
}

/** What a session reload on a realtime connection leaves the page to do. */
export type SessionReload =
  { outcome: 'loaded'; session: SessionDetails } | { outcome: 'unavailable' } | { outcome: 'kept' };

/**
 * Loads the session again on every realtime connection, including every
 * reconnection.
 *
 * This is what makes an open tab a continuing use of its session (D133): the
 * read endpoint slides the expiry, so a tab someone left open keeps its session
 * alive. The consequence is accepted knowingly - storage per session is bounded
 * by D006 - and it is the behaviour the rule was chosen with, not a side
 * effect. Without it the mount fetch would be the only session read a tab ever
 * makes, and a tab open for a week would watch its own session be deleted.
 *
 * It is also how such a tab finds out that its session is gone. An established
 * connection is not closed when its session expires (D076), so a reconnect is
 * the tab's own opportunity to be told.
 *
 * A transient failure is `kept`: the page keeps what it is showing and tries
 * again on the next connection, exactly as the list reload does (D077). Only a
 * session-level answer takes the page over.
 *
 * `load` is injected rather than imported so this module keeps knowing nothing
 * about React and the decision can be exercised without it.
 */
export async function reloadSessionOnConnection(
  load: () => Promise<SessionDetails>,
): Promise<SessionReload> {
  try {
    return { outcome: 'loaded', session: await load() };
  } catch (error) {
    return classifySessionError(error) === 'unavailable'
      ? { outcome: 'unavailable' }
      : { outcome: 'kept' };
  }
}

/**
 * How often a session page that shows a session reads it besides each
 * realtime connection: every 10 minutes (issue #216, D249).
 */
export const SESSION_READ_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Reads the session every `intervalMs` while the page shows it, so a tab left
 * open is a use whatever the window (Decision 3 of 2026-10-18).
 *
 * A stable connection makes no read after its first, so without this a quiet
 * tab would watch a 1-hour session expire under it. The backend moves a
 * short window's expiry at most once a tenth of the window - 6 minutes for an
 * hour (D242) - so a read every 10 minutes keeps a 1-hour session alive.
 *
 * `read` is the page's own session reload, the one each connection runs:
 * it applies what the read brings and, on `410` or `404`, takes the page to
 * `Session not found`, exactly as a reconnect's does. A read that failed for
 * another reason - offline, a `429`, a `500` - leaves the page as it is and
 * the next tick tries again; nothing here declares a session gone (D133).
 * A tick while the previous read is still in flight starts none, so a slow
 * or hung answer never stacks reads. The read goes on while the tab is
 * hidden: a tab in the background is still open, and the browser may only
 * delay the tick. Answers the function that stops it.
 */
export function readSessionPeriodically(
  read: () => Promise<unknown>,
  intervalMs: number = SESSION_READ_INTERVAL_MS,
): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) {
      return;
    }

    inFlight = true;
    Promise.resolve()
      .then(read)
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);

  return () => clearInterval(timer);
}
