/**
 * The per-address limits of the API (D201): `POST /api/sessions` 60 times and
 * every other call under `/api` 1200 times per minute per address, counted
 * in this process's memory and reported in every answer of a limited route.
 *
 * Counted on the application listener only. The receive listener is not
 * limited per minute - it admits webhooks by a byte budget (D210) - and
 * neither are the realtime connection, the probes and anything outside
 * `/api` (D201 point 2) but `/mcp`, whose calls share these two counters
 * (D203).
 *
 * The address is `request.ip`: the client's own, decided by the trust
 * boundary from the proxy's `X-Forwarded-For` (D111, D130), so a header a
 * client sends itself changes nothing. An IPv6 address counts by its `/64`,
 * the block one subscriber is usually given. It is held only as a key of the
 * counter, in memory, until its window ends: no log line and no stored row
 * carries it because of a limit. And a call either count refuses writes no
 * line of the request log at all, neither `incoming request` nor `request
 * completed`, on the API and on `/mcp` (#189, `lib/request-log.ts`).
 *
 * The count lives in the process, so a new process starts with none: there
 * is one outside a rollout, and two for its seconds, when an address may get
 * up to twice its limit (D221).
 *
 * Beside the two counts, the calls an address has in flight at once on `/api`
 * and `/mcp` together are bounded, 128, waits included (D213,
 * `calls-in-flight.ts`): the place is taken here, after an API call is
 * counted and let through and as a `/mcp` call arrives, before its count and
 * before anything `/mcp` itself checks, and held until its answer is written
 * and its handler has settled. A refusal here whose body is drained (D143)
 * holds one too while it is, and one that cannot is answered at once. Every
 * answer written while its request's body is still arriving ends its
 * connection, so that Node does not keep the request once its place has gone
 * back (D213): since D227 for every answer of both listeners, in `createApp`
 * (`server.ts`), not only for those of `/api` and `/mcp`.
 *
 * And the answers of those calls weigh their bytes until they have been
 * written, 16 MiB an address and 64 MiB the process, an answer that does not
 * fit refused `429` / `1019` once it is ready (#184, `answer-budget.ts`).
 *
 * And across every address, at most three of their handlers are at work at
 * once (D244, `api-work.ts`): a call past them waits for a slot, never
 * refused, served round robin by address, holding its place among its
 * address's calls in flight meanwhile, so that an address flooding the
 * API meets its `1019` sooner.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import ipaddr from 'ipaddr.js';
import {
  API_CALL_LIMIT,
  RATE_LIMIT_WINDOW_SECONDS,
  SESSION_CREATE_LIMIT,
} from '@webhook-inspector/shared';
import { MCP_PATH } from '@webhook-inspector/shared/mcp';
import {
  rateLimitExceeded,
  tooManyConcurrentCalls,
  type AppError,
} from '../../errors/app-error.ts';
import { parseAddress } from '../../lib/ip.ts';
import type { RequestLog } from '../../lib/request-log.ts';
import { drainRequestBody, shouldDrainRefusedBody } from '../sessions/refused-body.ts';
import { callsInFlight, createCallPlaces, type CallPlaces } from './calls-in-flight.ts';
import { countAnswers, createAnswerBudget, type AnswerBudget } from './answer-budget.ts';
import { createApiWork, createApiWorkSlots, type ApiWork } from './api-work.ts';

/** The headers every answer of a limited route carries, in lower case as Node writes them. */
export const RATE_LIMIT_LIMIT_HEADER = 'x-ratelimit-limit';
export const RATE_LIMIT_REMAINING_HEADER = 'x-ratelimit-remaining';
export const RATE_LIMIT_RESET_HEADER = 'x-ratelimit-reset';

/**
 * The key of every address that does not parse. One key for all of them, so
 * that nothing a peer could vary makes a new entry; `request.ip` is the
 * socket's peer or what the trusted proxy wrote, so in practice this is a
 * socket already gone.
 */
export const UNREADABLE_ADDRESS = '?';

/**
 * Longer than any address with a zone suffix. Anything longer cannot be one
 * and is not parsed at all, so a long value costs the length check alone.
 */
const MAX_ADDRESS_LENGTH = 64;

/**
 * The key an address is counted under: an IPv4 address itself, IPv4-mapped
 * IPv6 unwrapped to it, and any other IPv6 address its `/64`, written as the
 * network, such as `2001:db8:1:2::/64`, whatever the spelling and the zone of
 * the address. Under the strict rule of `lib/ip.ts`; anything else is
 * `UNREADABLE_ADDRESS`.
 */
export function addressKey(address: string | undefined): string {
  if (address === undefined || address.length > MAX_ADDRESS_LENGTH) {
    return UNREADABLE_ADDRESS;
  }

  const parsed = parseAddress(address.trim().split('%')[0] ?? '');

  if (parsed === null) {
    return UNREADABLE_ADDRESS;
  }

  if (parsed.kind() === 'ipv4') {
    return parsed.toString();
  }

  const v6 = parsed as ipaddr.IPv6;

  if (v6.isIPv4MappedAddress()) {
    return v6.toIPv4Address().toString();
  }

  return `${new ipaddr.IPv6([...v6.parts.slice(0, 4), 0, 0, 0, 0]).toString()}/64`;
}

/** What one counted call is told. */
export interface Verdict {
  /** Whether the call may go on; a refused call is not counted. */
  allowed: boolean;
  limit: number;
  /** Calls left in the window after this one; `0` on a refusal. */
  remaining: number;
  /** Whole seconds until the window ends, at least 1: `X-RateLimit-Reset`, and `Retry-After` on a refusal. */
  resetSeconds: number;
  /**
   * When the window the call was counted in began, on the counter's clock:
   * what `secondsLeft` reads the seconds from again when the answer is sent.
   */
  windowStart: number;
}

/**
 * The least time between two sweeps by a counter's timer, so that windows
 * ending a millisecond apart do not each wake the process: an ended window
 * no call removes is gone within about a second of its end.
 */
export const SWEEP_SPACING_MS = 1_000;

/**
 * Whole seconds, at least 1, left of a window of `windowMs` of which
 * `elapsed` milliseconds have passed; 1 once it has ended.
 *
 * From the time elapsed, not from the window's end: `start + windowMs`
 * rounds where it crosses a power of two of milliseconds, so a fresh
 * window's end minus now could be 60000.00000000001 and read 61. What has
 * elapsed is never below 0, so this is never above the window.
 */
function wholeSecondsLeft(windowMs: number, elapsed: number): number {
  return Math.max(1, Math.ceil((windowMs - elapsed) / 1000));
}

export interface WindowCounterOptions {
  /** The window's length in milliseconds; `RATE_LIMIT_WINDOW_SECONDS` unless a test shortens it. */
  windowMs?: number;
  /**
   * The clock, in milliseconds. `performance.now()`, which never steps back
   * when the wall clock is set; a test passes its own.
   */
  now?: () => number;
}

/**
 * At most `limit` calls per key in a fixed window that starts with the key's
 * first call counted in it and lasts `windowMs`.
 *
 * Each window is kept in a `Map` in the order the windows started: a key
 * whose window has ended is removed before it is counted again and so goes
 * back in at the end. Every window has the same length, so the windows that
 * have ended are always the first ones, and they are removed from the front
 * until one still running is met. Each entry is removed once, so this costs
 * nothing per call on average.
 *
 * Two things remove them. Every call does, first; and while the counter holds
 * any window, one timer does, set for when the oldest ends - at least
 * `SWEEP_SPACING_MS` after the last time it ran - and set again for the next
 * oldest, until none is left. So ended windows go whether or not any call
 * comes: a counter no call reaches, or a process no call reaches at all,
 * holds the addresses seen in the last `windowMs` and those of windows ended
 * within about the last second, never more. The timer is `unref`'d: it never
 * keeps the process alive, and an empty counter has none.
 */
export class WindowCounter {
  readonly limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, { start: number; count: number }>();
  #sweep: NodeJS.Timeout | null = null;

  constructor(limit: number, options: WindowCounterOptions = {}) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`A rate limit must be a positive integer, received ${limit}.`);
    }

    this.limit = limit;
    this.#windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_SECONDS * 1000;
    this.#now = options.now ?? (() => performance.now());
  }

  /** Counts one call of `key`, unless its window's limit is reached. */
  hit(key: string): Verdict {
    const now = this.#now();

    this.#dropEnded(now);

    let window = this.#windows.get(key);

    if (window === undefined) {
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
      this.#scheduleSweep(now);
    }

    const resetSeconds = wholeSecondsLeft(this.#windowMs, now - window.start);
    const windowStart = window.start;

    if (window.count >= this.limit) {
      return { allowed: false, limit: this.limit, remaining: 0, resetSeconds, windowStart };
    }

    window.count += 1;

    return {
      allowed: true,
      limit: this.limit,
      remaining: this.limit - window.count,
      resetSeconds,
      windowStart,
    };
  }

  /**
   * Whole seconds, at least 1, until the window that began at `windowStart`
   * ends, read now: a verdict's `resetSeconds` again, later. 1 once that
   * window has ended.
   */
  secondsLeft(windowStart: number): number {
    return wholeSecondsLeft(this.#windowMs, this.#now() - windowStart);
  }

  /**
   * Keys held: those whose window is running, and those of windows ended
   * since the last call or sweep. Reads the `Map` alone and removes nothing,
   * so a test sees what production holds. Exists for tests and diagnostics.
   */
  get size(): number {
    return this.#windows.size;
  }

  /** Stops the timer, for a listener that closes; the next window counted sets it again. */
  close(): void {
    if (this.#sweep !== null) {
      clearTimeout(this.#sweep);
      this.#sweep = null;
    }
  }

  #dropEnded(now: number): void {
    for (const [key, window] of this.#windows) {
      // Ended once what has elapsed reaches the window, measured as the reset is.
      if (now - window.start < this.#windowMs) {
        return;
      }

      this.#windows.delete(key);
    }
  }

  /** Sets the timer for when the oldest window ends, unless it is set or nothing is held. */
  #scheduleSweep(now: number): void {
    if (this.#sweep !== null) {
      return;
    }

    const oldest = this.#windows.values().next();

    if (oldest.done === true) {
      return;
    }

    const left = this.#windowMs - (now - oldest.value.start);

    this.#sweep = setTimeout(
      () => {
        this.#sweep = null;

        const at = this.#now();

        this.#dropEnded(at);
        this.#scheduleSweep(at);
      },
      Math.max(SWEEP_SPACING_MS, Math.ceil(left)),
    );
    this.#sweep.unref();
  }
}

/** The two limits, per address per window. */
export interface RateLimitSettings {
  /** `POST /api/sessions`. */
  sessionCreates: number;
  /** Every other call under `/api`. */
  apiCalls: number;
  /** The counters' clock, in milliseconds; a test passes its own. */
  now?: () => number;
}

/** The production limits, which every listener has unless it is given others (D201). */
export const DEFAULT_RATE_LIMITS: RateLimitSettings = {
  sessionCreates: SESSION_CREATE_LIMIT,
  apiCalls: API_CALL_LIMIT,
};

/** One of the two limits: its counter, and how a refusal names it. */
interface Limit {
  counter: WindowCounter;
  name: string;
}

/** The two limits by name: session creations, and every other call. */
export type LimitKind = 'sessionCreates' | 'apiCalls';

/** What one call counted by `RateLimits.count` is told. */
export type CallVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** Whole seconds until the window ends, at least 1: what `Retry-After` says. */
      retryAfter: number;
      /** `429` / `1015`, naming the limit and the seconds. */
      error: AppError;
    };

/**
 * The listener's two counters, for a route that decides which limit a call
 * counts toward only once its body is read: `/mcp`, where a `create_session`
 * counts toward the session creations and anything else toward the other
 * calls (D203). The routes under `/api` are counted by the hook alone.
 */
export interface RateLimits {
  /**
   * Counts `request` toward `kind` now, and writes the three headers on
   * `reply`; the answer's `onSend` reads `X-RateLimit-Reset` again as it is
   * sent, as for the API. A refused call is not counted (D201 point 4).
   */
  count(request: FastifyRequest, reply: FastifyReply, kind: LimitKind): CallVerdict;
  /** Whether `request` has met a limit already, counted or refused. */
  isCounted(request: FastifyRequest): boolean;
  /**
   * Keeps `request` out of the request log (#189): its answer is the refusal
   * `count` gave it, a `429` / `1015` or a tool's error naming the limit
   * (D203), and like the API's refusals it writes no line. A call `count`
   * refused that is answered for another reason - a `405`, a foreign
   * `Origin` - is logged as every answer is.
   */
  keepOutOfLog(request: FastifyRequest): void;
  /**
   * Gives back the place among its address's calls in flight that `request`
   * took, at once: for a call refused after it took one, with nothing left
   * to read of its body - read already, or left to Node on a connection kept
   * alive, which the answer ends if the body is still arriving (D213). A
   * refusal whose body is drained keeps its place until its response closes
   * instead. `count` does it itself for a call it refuses.
   */
  giveBackCallPlace(request: FastifyRequest): void;
  /** The places of the calls in flight, which a test reads. */
  readonly callPlaces: CallPlaces;
  /** The bytes of the answers not yet written, which a test reads (#184). */
  readonly answerBudget: AnswerBudget;
  /** The gate in front of the handlers' work (D244), which the waits give their slot back to. */
  readonly work: ApiWork;
}

/** Whether a path is the API's: `/api` and everything under it. */
function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * Whether a route's calls take a place among their address's calls in flight
 * (D213): every route of the API, and `/mcp` itself - not a path under it or
 * after it, `/mcp/` or `/mcpx`, which only the not-found route answers.
 */
function holdsCallPlaces(route: string): boolean {
  return isApiPath(route) || route === MCP_PATH;
}

/**
 * Whether `request` is a call D213 counts among its address's calls in
 * flight: one of a route of the API or of `/mcp` itself, or of a path under
 * `/api` that no route has. Its answer weighs in the answers' byte budget
 * (#184).
 */
function isCall(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;

  return route === undefined ? isApiPath(pathOf(request.url)) : holdsCallPlaces(route);
}

/** The path of a URL as it arrived, without its query string. */
function pathOf(url: string): string {
  const query = url.indexOf('?');

  return query === -1 ? url : url.slice(0, query);
}

/**
 * Counts every call of a limited route on `app` and refuses one over its
 * limit, before its body is read and before any database work.
 *
 * `X-RateLimit-Reset` is the seconds left as the answer is sent, not as the
 * call arrived: a call held by `wait` is answered up to 30 s after it was
 * counted (D200), and a refusal after its body is drained. `Retry-After` and
 * the refusal's message are read with it, after the drain. What remains is
 * what was left once the call was counted.
 *
 * A route is told by the route the router matched, not by the URL as
 * written: the router decodes a path before matching it, so `/%61pi/...` is
 * the API too and counts. A URL no route matches counts when its path as
 * received is under `/api`: its answer is `404` / `1000` without any database
 * work either way. A URL the router refuses before any route - a path that
 * cannot be percent-decoded, a parameter over 100 characters - is answered
 * before any hook, outside the error contract (D142), with no limit's
 * headers.
 *
 * Must be called before any route is registered, so that the hook reaches
 * every route, the ones in encapsulated scopes included.
 *
 * Answers the two counters, which `/mcp` counts its calls with itself, once
 * its body tells which limit a call counts toward (D203): the hook here
 * counts no path outside `/api`.
 *
 * A call counted and let through then takes a place among its address's
 * calls in flight (D213), `callPlaces`, 128 unless a test passes its own; the
 * 129th is refused `429` / `1019` with `Retry-After: 1` at once, its body
 * never drained. A call to `/mcp` takes its place here too, before the hooks
 * of `/mcp`'s own scope - its query string's `400` among them - and before
 * its body is read, since a body that arrives slowly holds its request as
 * long as a wait does, and gives it back at once if its count then refuses
 * it. Every handler of the API and of `/mcp` is wrapped as its route is
 * registered, so that it holds its call's place while it runs.
 *
 * The rule (D213, the Coordinator's decision answering the outside review's
 * finding 1): a request whose body the server reads or drains holds a place
 * among its address's calls in flight for as long as it does, and a refusal
 * that cannot hold one is answered at once, without draining. A drain lasts
 * as long as its client takes to send the body, keeping the request - its URL
 * and header lines - all that time, so drains with no place would let one
 * address keep any number of requests. So a call refused `1015` on a
 * connection Node is about to close, whose body D143 drains, takes a place
 * for the drain, held until the refusal's response closes, and with none free
 * is answered at once; a `1015` that needs no drain takes none. The answer of
 * a refusal not drained can be lost to a reset on a client still sending its
 * body, as D143 accepts for the bodies it does not drain.
 *
 * And every answer of a route of `/api` or of `/mcp` written while its
 * request's body has not all arrived - a refusal before the body above all -
 * carries `Connection: close` (D213, the Coordinator's decision answering the
 * second outside review's finding 1): since D227 by `createApp`'s `onSend`
 * (`server.ts`), which every answer of both listeners passes, rather than by
 * this one, which ended only those of `/api` and `/mcp`.
 *
 * A call refused `1015` here, or by `count` with `keepOutOfLog`, writes no
 * line of `requestLog`, the listener's request log, whose `incoming request`
 * waits for the verdict of every call these limits decide on (#189).
 *
 * Inside its place among the calls in flight, every handler of the API and
 * of `/mcp` waits for a slot of the gate in front of their work, `work`, three
 * unless a test passes its own, and gives it back once its answer begins
 * (D244, `api-work.ts`).
 */
export function registerRateLimits(
  app: FastifyInstance,
  settings: RateLimitSettings,
  requestLog: RequestLog,
  callPlaces: CallPlaces = createCallPlaces(),
  answerBudget: AnswerBudget = createAnswerBudget(),
  work: ApiWork = createApiWork(createApiWorkSlots(), (request) => addressKey(request.ip)),
): RateLimits {
  const sessionCreates: Limit = {
    counter: new WindowCounter(settings.sessionCreates, { now: settings.now }),
    name: `${settings.sessionCreates} session creations per minute`,
  };
  const apiCalls: Limit = {
    counter: new WindowCounter(settings.apiCalls, { now: settings.now }),
    name: `${settings.apiCalls} API calls per minute`,
  };

  function limitOf(request: FastifyRequest): Limit | null {
    const route = request.routeOptions.url;

    if (route === undefined) {
      return isApiPath(pathOf(request.url)) ? apiCalls : null;
    }

    if (!isApiPath(route)) {
      return null;
    }

    return route === '/api/sessions' && request.method === 'POST' ? sessionCreates : apiCalls;
  }

  // The calls counted and let through, with the window each was counted in,
  // so that their answers read the seconds left again as they are sent.
  const counted = new WeakMap<FastifyRequest, { counter: WindowCounter; windowStart: number }>();
  // Every call that has met a limit, counted or refused, so that none is
  // counted twice.
  const met = new WeakSet<FastifyRequest>();

  const inFlight = callsInFlight(callPlaces);

  // The `incoming request` of every call counted here, on `/api` and `/mcp`,
  // waits for the call's verdict, so that a refusal writes no line (#189).
  requestLog.holdFor(isCall);

  /** Counts one call of `key` toward `limit` and writes the three headers. */
  function hit(request: FastifyRequest, reply: FastifyReply, limit: Limit, key: string): Verdict {
    const verdict = limit.counter.hit(key);

    met.add(request);
    reply.header(RATE_LIMIT_LIMIT_HEADER, String(verdict.limit));
    reply.header(RATE_LIMIT_REMAINING_HEADER, String(verdict.remaining));
    reply.header(RATE_LIMIT_RESET_HEADER, String(verdict.resetSeconds));

    if (verdict.allowed) {
      counted.set(request, { counter: limit.counter, windowStart: verdict.windowStart });
    }

    return verdict;
  }

  /**
   * Takes a place among the calls in flight of `key` for `request`, or
   * refuses it `429` / `1019` at once, with the body unread and never
   * drained, even on a connection Node is about to close: a drain holds the
   * request for as long as its client takes to send the body, and this call
   * has no place to hold it with (D213, the outside review's finding 1). The
   * answer can then be lost to a reset on a client still sending, the case
   * D143 accepts for the bodies it does not drain.
   */
  function takeCallPlace(request: FastifyRequest, reply: FastifyReply, key: string): void {
    if (!inFlight.take(request, reply, key)) {
      throw tooManyConcurrentCalls(callPlaces.limit);
    }
  }

  // Every handler of a route whose calls take a place holds it while it runs,
  // and inside it waits for its slot of the gate (D244) - but `/mcp`'s, which
  // reads its message first and takes its turn itself (`mcp/routes.ts`). A
  // HEAD route Fastify adds for a GET is registered with the GET's own
  // options, so it is wrapped once too.
  app.addHook('onRoute', (route) => {
    if (holdsCallPlaces(route.url)) {
      route.handler = inFlight.holding(
        route.url === MCP_PATH ? route.handler : work.gated(route.handler),
      );
    }
  });

  // An answer begins: its call's slot of the gate goes back (D244), before
  // any other hook here, the answers' byte budget among them.
  app.addHook('onSend', (request, _reply, payload, done) => {
    work.answerBegins(request);
    done(null, payload);
  });

  app.addHook('onRequest', async (request, reply) => {
    const limit = limitOf(request);

    if (limit === null) {
      // `/mcp` is counted once its body has arrived (D203), but it holds its
      // request from now on.
      if (request.routeOptions.url === MCP_PATH) {
        takeCallPlace(request, reply, addressKey(request.ip));
      }

      return;
    }

    const key = addressKey(request.ip);
    const verdict = hit(request, reply, limit, key);

    if (verdict.allowed) {
      requestLog.admit(request);
      takeCallPlace(request, reply, key);

      return;
    }

    // From here on nothing is logged of it at `info`, the abort of a client
    // that leaves during the drain below included (#189).
    requestLog.refuse(request);

    // Refused with the body unread, as the media-type guard refuses: on a
    // connection Node is about to close, the body is read and discarded
    // first, within a bound, or the close would be a reset that loses the
    // answer (D143). The drain holds the request for as long as its client
    // takes, so it holds a place among the address's calls in flight while
    // it does, given back when the refusal's response closes; with none
    // free the refusal is answered at once, undrained (D213, the outside
    // review's finding 1). A refusal that needs no drain takes no place.
    if (
      shouldDrainRefusedBody(request.raw.rawHeaders, reply.raw.shouldKeepAlive) &&
      inFlight.take(request, reply, key)
    ) {
      await drainRequestBody(request.raw);
    }

    // Read again once the body is drained, which lasts as long as the client
    // takes to send it.
    const retryAfter = limit.counter.secondsLeft(verdict.windowStart);

    reply.header(RATE_LIMIT_RESET_HEADER, String(retryAfter));

    throw rateLimitExceeded(limit.name, retryAfter);
  });

  // Every answer of a call let through passes here, the error handler's too.
  //
  // An answer on `/api` and `/mcp` written before its request's body has all
  // arrived ends its connection (D213, the Coordinator's decision answering
  // the second outside review's finding 1): Node keeps such a request until
  // the rest of its body has come, while its place among the calls in flight
  // goes back once the answer is written - or was never taken, by a `1019`, a
  // `1015` with no drain, a `1017` kept alive - so on connections kept alive
  // one address could keep any number of them. That rule is `createApp`'s
  // since D227 (`server.ts`), for every answer of both listeners: the same
  // holds for every answer written before its body, wherever it is written.
  app.addHook('onSend', async (request, reply) => {
    const call = counted.get(request);

    if (call !== undefined) {
      reply.header(RATE_LIMIT_RESET_HEADER, String(call.counter.secondsLeft(call.windowStart)));
    }
  });

  // The bytes of every answer of a call counted here, from the moment it is
  // serialized until its response closes, 16 MiB an address and 64 MiB the
  // process, the next that does not fit refused `429` / `1019` (#184,
  // `answer-budget.ts`): after the hook above, so that a refusal's answer
  // carries the headers too, and keyed as the calls in flight are.
  countAnswers(app, answerBudget, isCall, (request) => addressKey(request.ip));

  app.addHook('onClose', async () => {
    sessionCreates.counter.close();
    apiCalls.counter.close();
  });

  return {
    count(request, reply, kind) {
      const limit = kind === 'sessionCreates' ? sessionCreates : apiCalls;
      const verdict = hit(request, reply, limit, addressKey(request.ip));

      if (verdict.allowed) {
        requestLog.admit(request);

        return { allowed: true };
      }

      // A call refused by its count does nothing more: its place among the
      // calls in flight, taken before its body, goes back now (D213).
      inFlight.giveBack(request);

      // Read again as the API's refusal reads it: the call is answered now.
      const retryAfter = limit.counter.secondsLeft(verdict.windowStart);

      reply.header(RATE_LIMIT_RESET_HEADER, String(retryAfter));

      return { allowed: false, retryAfter, error: rateLimitExceeded(limit.name, retryAfter) };
    },
    isCounted(request) {
      return met.has(request);
    },
    keepOutOfLog(request) {
      requestLog.refuse(request);
    },
    giveBackCallPlace(request) {
      inFlight.giveBack(request);
    },
    callPlaces,
    answerBudget,
    work,
  };
}
