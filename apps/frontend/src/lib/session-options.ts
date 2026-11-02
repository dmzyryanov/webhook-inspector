/**
 * The new session's options on the home page (issue #216, D249; Figma page
 * `Webhook Inspector · New session options`, direction A): how long the
 * session lives after its last use, whether it keeps the sender's IP, and
 * whether it is private, opening only with its key (issue #228, D259).
 *
 * The choice is the page's state and nothing else: it is never stored, so
 * every visit starts at the defaults and a reload returns to them. What a
 * creation sends, and what the trigger and the tile say, are decided here,
 * away from React, so they are unit-tested (D025, D061).
 */
import { SESSION_IDLE_WINDOW_MAX_SECONDS } from '@webhook-inspector/shared';
import { en, type Messages } from '../i18n/en.ts';

const DAY = 86_400;
const HOUR = 3_600;

/**
 * The three windows the page offers, in the menu's order: 7 days, 1 day and
 * 1 hour (the owner's decision 2 of 2026-10-18). Every one counts from the
 * last use; a fixed lifetime stays the API's (D220, D242).
 */
export const SESSION_WINDOWS = [SESSION_IDLE_WINDOW_MAX_SECONDS, DAY, HOUR] as const;

export type SessionWindow = (typeof SESSION_WINDOWS)[number];

/** What a session is created with. */
export interface NewSessionOptions {
  /** Its idle window in seconds, one of `SESSION_WINDOWS`. */
  idleSeconds: SessionWindow;
  /** Whether its captures keep the sender's address (D243). */
  storeSourceIp: boolean;
  /**
   * Whether it opens only with its access key (D245, D253), which the
   * creation answers once and the browser keeps (D259).
   */
  private: boolean;
}

/**
 * Today's session: 7 days after its last use, the address kept (the owner's
 * decision 4 of #216), public (decision 6 of #228: never remembered).
 */
export const DEFAULT_SESSION_OPTIONS: NewSessionOptions = {
  idleSeconds: SESSION_IDLE_WINDOW_MAX_SECONDS,
  storeSourceIp: true,
  private: false,
};

/** Whether `seconds` is one of the windows the page offers. */
export function isSessionWindow(seconds: unknown): seconds is SessionWindow {
  return SESSION_WINDOWS.some((window) => window === seconds);
}

/** Whether every option is its default. */
export function isDefaultOptions(options: NewSessionOptions): boolean {
  return (
    options.idleSeconds === DEFAULT_SESSION_OPTIONS.idleSeconds &&
    options.storeSourceIp === DEFAULT_SESSION_OPTIONS.storeSourceIp &&
    options.private === DEFAULT_SESSION_OPTIONS.private
  );
}

/** The keys of `POST /api/sessions` a choice sends (D242, D243, D253). */
export interface SessionOptionsBody {
  expiresAfterIdleSeconds?: number;
  storeSourceIp?: false;
  private?: true;
}

/**
 * The keys that differ from the default, and only those: a window other than
 * 7 days as `expiresAfterIdleSeconds`, the address turned off as
 * `storeSourceIp: false`, a private session as `private: true`, with no
 * `Authorization`, so the server draws the key and answers it once (D253).
 * `null` when nothing differs, which sends no body.
 */
export function sessionOptionsBody(options: NewSessionOptions): SessionOptionsBody | null {
  const body: SessionOptionsBody = {};

  if (options.idleSeconds !== DEFAULT_SESSION_OPTIONS.idleSeconds) {
    body.expiresAfterIdleSeconds = options.idleSeconds;
  }

  if (!options.storeSourceIp) {
    body.storeSourceIp = false;
  }

  if (options.private) {
    body.private = true;
  }

  return Object.keys(body).length === 0 ? null : body;
}

/**
 * The request `createSession` sends. The defaults send exactly
 * `{ method: 'POST' }`, with no body and no `Content-Type` at all: that
 * conjunction is the one exemption from the media-type rule, so an empty body
 * or a stray header would turn the `201` into a `415` / `1007` (D104). A
 * choice sends its differing keys as JSON, with `Content-Type:
 * application/json`, which D104 allows.
 */
export function createSessionInit(
  options: NewSessionOptions = DEFAULT_SESSION_OPTIONS,
): RequestInit {
  const body = sessionOptionsBody(options);

  return body === null
    ? { method: 'POST' }
    : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      };
}

/** A window as the trigger and the menu write it: `7 days`, `1 day`, `1 hour`. */
export function windowLabel(seconds: SessionWindow, m: Messages = en): string {
  return seconds % DAY === 0
    ? m.newSession.days(seconds / DAY)
    : m.newSession.hours(seconds / HOUR);
}

/**
 * What the trigger shows: both values always, the lock after them once the
 * session is to be private (D259), and whether the window or the address
 * differs from the default.
 */
export interface TriggerValues {
  window: string;
  address: string;
  /** Ink and Medium once the window or the address differs; muted otherwise (D249). */
  chosen: boolean;
  /** The lock after the values, for a private session (R1). */
  private: boolean;
}

export function triggerValues(options: NewSessionOptions, m: Messages = en): TriggerValues {
  return {
    window: windowLabel(options.idleSeconds, m),
    address: options.storeSourceIp ? m.newSession.ipStored : m.newSession.ipNotStored,
    chosen:
      options.idleSeconds !== DEFAULT_SESSION_OPTIONS.idleSeconds ||
      options.storeSourceIp !== DEFAULT_SESSION_OPTIONS.storeSourceIp,
    private: options.private,
  };
}

/**
 * The trigger's name, which holds its visible values: `New session options: 7
 * days · IP stored`, and `· Private session` after them once the lock shows.
 */
export function triggerName(options: NewSessionOptions, m: Messages = en): string {
  const values = triggerValues(options, m);
  const named = `${m.newSession.options}: ${values.window} · ${values.address}`;

  return values.private ? `${named} · ${m.newSession.privateSession}` : named;
}

/**
 * The hint beside `Generate URL` from 768 px: the page's own while the window
 * is 7 days, and `— expires 1 hour after last use` once another is chosen.
 * The address choice alone leaves it as it is: the trigger says that.
 */
export function tileHint(
  options: NewSessionOptions,
  firstVisit: boolean,
  m: Messages = en,
): string {
  const seconds = options.idleSeconds;

  if (seconds === DEFAULT_SESSION_OPTIONS.idleSeconds) {
    return firstVisit ? m.landing.hintFirstVisit : m.landing.hintReturning;
  }

  return seconds % DAY === 0
    ? m.newSession.hintDays(seconds / DAY)
    : m.newSession.hintHours(seconds / HOUR);
}
