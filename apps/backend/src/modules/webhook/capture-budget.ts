/**
 * The byte budget webhooks are received by (D210): 64 MiB for the process
 * and 16 MiB for one sender's address, counted from the moment a webhook's
 * headers have arrived and before a byte of its body is read.
 *
 * A webhook of 1 MiB took about 2.2 MiB of the backend while it was received
 * and stored, and nothing bounded how many were in flight at once: about 180
 * at once from one address killed the 512 MiB process, which also serves the
 * API and every viewer (#139, #144). So each webhook is weighed from its
 * headers - its declared body, at most 1 MiB, or 1 MiB when it is sent
 * chunked or its framing is unclear, plus 16 KiB, 256 bytes a header line and
 * 64 KiB for the answer it will be sent, the most a session's answer body can
 * be - and one that does not fit waits, first come first served, with its body
 * unread: its socket is no longer read once the chunk that carried its
 * headers has been, so a waiting webhook holds its headers, that chunk and
 * the connection's first receive window, not its body (`stopReading`). After
 * 30 s of waiting it is refused `503` / `1018` with
 * `Retry-After: 1`.
 *
 * The waiting line is bounded too (D228): a waiting webhook weighs its header
 * part, 16 KiB and 256 bytes a header line (`waitingWeight`), and at most
 * 64 MiB may wait in the process and 16 MiB from one address. One that must
 * wait and does not fit is refused `503` / `1018` at once, with
 * `Retry-After: 1` and `Connection: close`, nothing stored - unless none of
 * its address is waiting: the first of an address always waits, so that the
 * largest webhook a sender may send, 16,320 header lines, 4 MiB of the line,
 * is never refused for its own size or for other addresses' load. Before it,
 * nothing bounded the line, and 2,000 webhooks of 2,500 header lines each
 * waiting from one address ran the process out of heap (D210 point 12).
 *
 * A light sender keeps a reserve (D261): a webhook whose address holds, with
 * it, at most 12 MiB goes in past the process's 64 MiB, within 16 MiB more,
 * and before any webhook of a heavier address waiting. Four addresses at
 * their 16 MiB each hold the whole 64 MiB, so before it an ordinary sender's
 * small webhooks waited behind a flood from four addresses and were refused
 * `1018` (#242, #262); under that flood at 0.5 CPU such a sender, 10 small
 * webhooks a second, had up to 10.4 MiB of them in flight, as measured. No
 * admission takes the process past 80 MiB, no heavier address's past 64 MiB,
 * and one address takes at most 12 MiB of the reserve: a flooder is light
 * only while it holds no more than a light sender may, and those at their
 * 16 MiB never are.
 *
 * A webhook whose body Fastify reads and that is declared
 * over 1 MiB weighs nothing: it is refused `413` before it is read, as
 * before. A `GET`, `HEAD` or `TRACE`, whose body Fastify never reads, weighs
 * the body it declares all the same, at most 1 MiB, since Node reads it
 * regardless. The webhooks of one connection share its stop: it is read again
 * only once none of them waits any longer.
 *
 * The weight is held by the connection until the reply has closed and by the
 * route's handler until it settles, as D205 holds a large body's place: a
 * handler still stores a webhook whose sender has left after sending it
 * whole. Once the webhook is stored its weight shrinks to 16 KiB, its header
 * part, the reply's body and, for a `GET`, `HEAD` or `TRACE` that declared a
 * body, that body's part, which Node keeps unread until the reply has closed:
 * what a reply held by a configured delay still keeps of it, so a delay of up
 * to 30 s stays counted. It never grows: the answer's 64 KiB were reserved
 * when the webhook was admitted, before its session was known, so a stored
 * webhook never holds more than it was let in for (D210).
 *
 * The count lives in the process: there is one outside a rollout, and two for
 * its seconds, when an address may have up to twice its share in flight
 * (D221).
 */
import type { Socket } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  CAPTURE_BUDGET_BYTES,
  CAPTURE_BUDGET_PER_ADDRESS_BYTES,
  CAPTURE_LIGHT_RESERVE_BYTES,
  CAPTURE_LIGHT_SENDER_BYTES,
  CAPTURE_WAIT_MS,
  CAPTURE_WAITING_BYTES,
  CAPTURE_WAITING_PER_ADDRESS_BYTES,
  MAX_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
} from '@webhook-inspector/shared';
import { capturesBusy } from '../../errors/app-error.ts';
import { connectionEndedBeforeBody } from '../../lib/connection.ts';
import { http2StreamOf, isAnswerGone } from '../../lib/http2.ts';
import type { Slots } from '../../lib/slots.ts';
import { headerValues } from '../sessions/media-type.ts';
import { drainRefusedBody, refusalDrainPlaces } from '../sessions/refused-body.ts';
import { holdStopped } from './pipelining.ts';

/** What every webhook weighs besides its body, its header lines and its answer (D210). */
export const CAPTURE_BASE_WEIGHT_BYTES = 16 * 1024;

/** What each header line of a webhook weighs (D210). */
export const CAPTURE_HEADER_LINE_WEIGHT_BYTES = 256;

/**
 * What every webhook weighs for the answer it will be sent (D210): the
 * largest body a session's response or a step of its response queue can have,
 * `MAX_RESPONSE_BODY_BYTES`, which `parseBody` (`sessions/response-config.ts`)
 * holds both to (D101, D205); the default answer's body, an `ok` and the
 * request's id in JSON, is far smaller. Reserved when the webhook is admitted,
 * before its session is read, so that once stored, when its weight counts the
 * answer's actual body, it never weighs more than it was admitted for: a hold
 * that grew after storing took memory neither budget had granted.
 */
export const CAPTURE_ANSWER_RESERVE_BYTES = MAX_RESPONSE_BODY_BYTES;

/** The line at `info` for a sender that left while its webhook waited (D210). */
export const SENDER_LEFT = 'Webhook sender left while waiting for a place; nothing was stored';

/** The line at `warn` for a webhook refused because its wait ran out (D210). */
export const REFUSED_IN_TIME = 'Webhook refused: no place in the capture budget in time';

/** The line at `warn` for a webhook refused at once because the waiting line was full (D228). */
export const REFUSED_LINE_FULL =
  'Webhook refused at once: the line waiting for a capture place is full';

/** A declared length: digits only, as RFC 9110 defines `Content-Length`. */
const CONTENT_LENGTH = /^\d+$/;

/**
 * The methods whose body Fastify never reads: its own bodyless defaults,
 * which `buildReceiver` leaves as they are when it declares every other
 * method with a body (D139). Fastify 5.12.1 runs a route's handler for them
 * without reading the body or comparing its declared length with the route's
 * limit (`handleRequest`, `fastify/lib/handle-request.js`), so a length they
 * declare is neither read nor refused `413`. Node reads such a body all the
 * same, into the request's stream - about 128 KiB of a body of 1 MiB,
 * measured on Node 24 - and keeps it there unread until the reply has closed,
 * when it reads and discards the rest (`_dump`, `node:_http_server`). `webhook.test.ts` checks over real
 * sockets that exactly these store no body, and every other method the body
 * it carried. Node's parser hands on only the upper-case names of
 * `http.METHODS`, so no other spelling reaches the weight.
 */
export const METHODS_WITHOUT_BODY: ReadonlySet<string> = new Set(['GET', 'HEAD', 'TRACE']);

/**
 * What an HTTP/2 webhook's weight needs besides its method and headers
 * (D263), absent for an HTTP/1.1 one: whether its stream ended with its
 * headers. HTTP/2 frames a body by its stream, not by `Content-Length` or
 * `Transfer-Encoding`, so one with neither and a stream still open may carry
 * a body of any length.
 */
export interface Http2Framing {
  endedWithHeaders: boolean;
}

/** The framing of `request` when it came over HTTP/2, or `undefined` for HTTP/1.1. */
export function http2FramingOf(request: FastifyRequest): Http2Framing | undefined {
  const stream = http2StreamOf(request.raw);

  return stream === undefined ? undefined : { endedWithHeaders: stream.endAfterHeaders };
}

/**
 * The bytes of header names and values past the 16 KiB a weight counts for
 * them, which an HTTP/1.1 request never has - Node's parser refuses it `431`
 * (D210 point 3) - and an HTTP/2 one may, up to its header list size (D263).
 */
function headerBytesOverBase(rawHeaders: string[]): number {
  let bytes = 0;

  for (const text of rawHeaders) {
    bytes += text.length;
  }

  return Math.max(0, bytes - CAPTURE_BASE_WEIGHT_BYTES);
}

/**
 * The 16 KiB and the header lines' part of a weight; over HTTP/2, the header
 * bytes past the 16 KiB too.
 */
function fixedWeight(rawHeaders: string[], http2?: Http2Framing): number {
  const weight =
    CAPTURE_BASE_WEIGHT_BYTES +
    Math.floor(rawHeaders.length / 2) * CAPTURE_HEADER_LINE_WEIGHT_BYTES;

  return http2 === undefined ? weight : weight + headerBytesOverBase(rawHeaders);
}

/**
 * What a webhook weighs while it waits for its place (D228): its header part,
 * 16 KiB and 256 bytes a header line, D210's own weight of what a webhook
 * keeps besides its body and its answer - while it waits, its parsed headers,
 * the chunk that carried them and its connection's first window. Pure.
 *
 * The largest a sender can send, 16,320 header lines under Node's 16 KiB of
 * header names and values (D210 point 3), weighs exactly 4 MiB; a webhook of
 * 2,500 lines 641 KiB; one of four lines 17 KiB.
 */
export function waitingWeight(rawHeaders: string[], http2?: Http2Framing): number {
  return fixedWeight(rawHeaders, http2);
}

/**
 * What the headers declare of a body: its length, for one `Content-Length`
 * of plain digits - over 1 MiB too - or none; `'open'` for any
 * `Transfer-Encoding`, chunked or anything else, and for framing the headers
 * do not settle - a repeated `Content-Length`, even with equal values, or one
 * that is not plain digits, which Node's parser normally refuses before it
 * gets here. Over HTTP/2 no `Content-Length` declares no body only when the
 * stream ended with its headers; otherwise it is `'open'` (D263).
 */
function declaredBody(rawHeaders: string[], http2?: Http2Framing): number | 'open' {
  if (headerValues(rawHeaders, 'transfer-encoding').length > 0) {
    return 'open';
  }

  const lengths = headerValues(rawHeaders, 'content-length');

  if (lengths.length === 0) {
    return http2 === undefined || http2.endedWithHeaders ? 0 : 'open';
  }

  const declared = lengths.length === 1 ? (lengths[0] as string).trim() : '';

  return CONTENT_LENGTH.test(declared) ? Number(declared) : 'open';
}

/** A declared body's part of a weight: at most 1 MiB, and 1 MiB when it is open. */
function bodyWeight(declared: number | 'open'): number {
  return declared === 'open' ? MAX_BODY_BYTES : Math.min(declared, MAX_BODY_BYTES);
}

function bodyNeverRead(method: string | undefined): boolean {
  return method !== undefined && METHODS_WITHOUT_BODY.has(method);
}

/**
 * What a webhook weighs before its body is read, from its method and headers
 * alone. Pure, so the rule can be tested without a server.
 *
 * The body's part:
 *
 * - no `Content-Length` and no `Transfer-Encoding`, or `Content-Length: 0`:
 *   no body, none;
 * - one `Content-Length` of plain digits: its value, when it is at most 1 MiB.
 *   One over that weighs **nothing at all**, `0`, on a method whose body
 *   Fastify reads: Fastify refuses it `413` before reading a byte of it, so it
 *   never waits;
 * - `Transfer-Encoding`, or framing the headers do not settle: 1 MiB, the
 *   most it can be.
 *
 * A `GET`, `HEAD` or `TRACE` (`METHODS_WITHOUT_BODY`) that declares a body
 * weighs it by the same rule, except that a length over 1 MiB weighs 1 MiB:
 * Fastify never refuses it `413`, and Node reads it into the request's stream
 * while nobody reads it (`unreadBodyWeight`).
 *
 * Plus `CAPTURE_BASE_WEIGHT_BYTES`, `CAPTURE_HEADER_LINE_WEIGHT_BYTES` a
 * header line and `CAPTURE_ANSWER_RESERVE_BYTES` for the answer.
 *
 * Over HTTP/2, `http2` (D263): no `Content-Length` on a stream still open is
 * an open body, 1 MiB, and header bytes past 16 KiB weigh as well.
 */
export function captureWeight(
  method: string | undefined,
  rawHeaders: string[],
  http2?: Http2Framing,
): number {
  const declared = declaredBody(rawHeaders, http2);

  if (declared !== 'open' && declared > MAX_BODY_BYTES && !bodyNeverRead(method)) {
    return 0;
  }

  return bodyWeight(declared) + fixedWeight(rawHeaders, http2) + CAPTURE_ANSWER_RESERVE_BYTES;
}

/**
 * The part of a webhook's weight that stays counted once it is stored, until
 * its reply has closed: for a `GET`, `HEAD` or `TRACE` that declares a body,
 * its body's part, since Node keeps what it read of that body unread in the
 * request's stream until then, up to 128 KiB measured (D210); for any other
 * method, none, since Fastify read the body and the handler lets go of it.
 */
export function unreadBodyWeight(
  method: string | undefined,
  rawHeaders: string[],
  http2?: Http2Framing,
): number {
  return bodyNeverRead(method) ? bodyWeight(declaredBody(rawHeaders, http2)) : 0;
}

/**
 * What a stored webhook still weighs while its reply is held or written: the
 * 16 KiB, its header part, the body Node keeps unread (`unreadBodyWeight`)
 * and the reply's body (D210). With a reply's body of at most
 * `CAPTURE_ANSWER_RESERVE_BYTES`, never more than its `captureWeight`.
 */
export function storedWeight(
  method: string | undefined,
  rawHeaders: string[],
  replyBodyBytes: number,
  http2?: Http2Framing,
): number {
  return (
    fixedWeight(rawHeaders, http2) + unreadBodyWeight(method, rawHeaders, http2) + replyBodyBytes
  );
}

/** A weight held in the budget. */
export interface CaptureHold {
  /**
   * Holds `weight` from now on instead, when it is less than what is held,
   * and wakes the webhooks waiting. A larger weight changes nothing: a hold
   * never grows past what was admitted (D210). Nothing once the hold has been
   * released.
   */
  shrink(weight: number): void;
  /** Gives the weight back and wakes the webhooks waiting. Once only. */
  release(): void;
}

/** How a wait for a place ended. */
export type Admission =
  | { outcome: 'admitted'; hold: CaptureHold }
  /** No place within the wait: the webhook is refused `503` / `1018`. */
  | { outcome: 'timed-out' }
  /** The signal fired first: its sender left. */
  | { outcome: 'cancelled' }
  /**
   * It had to wait and the line had no room for it: refused `503` / `1018`
   * at once, having waited for nothing (D228).
   */
  | { outcome: 'line-full' };

export interface CaptureBudgetSettings {
  /** What the process may hold at once; `CAPTURE_BUDGET_BYTES` in production. */
  totalBytes: number;
  /** What one address may hold at once; `CAPTURE_BUDGET_PER_ADDRESS_BYTES`. */
  perAddressBytes: number;
  /** How long a webhook waits for a place; `CAPTURE_WAIT_MS`. */
  waitMs: number;
  /**
   * What the webhooks waiting may weigh at once in the process, by their
   * waiting weight; `CAPTURE_WAITING_BYTES` in production (D228).
   */
  waitingBytes: number;
  /** What the webhooks waiting from one address may weigh; `CAPTURE_WAITING_PER_ADDRESS_BYTES`. */
  waitingPerAddressBytes: number;
  /**
   * What an address may hold, the webhook being admitted included, and still
   * be a light sender; `CAPTURE_LIGHT_SENDER_BYTES` in production (D261).
   */
  lightSenderBytes: number;
  /**
   * What light senders may hold past `totalBytes`; `CAPTURE_LIGHT_RESERVE_BYTES`
   * in production (D261).
   */
  lightReserveBytes: number;
}

/**
 * The most the webhooks admitted to a budget of `settings` hold at once
 * (D261): its process's budget and the light senders' reserve, 80 MiB in
 * production. Only `take`, which holds again what was admitted once, goes
 * past it.
 */
export function inFlightBound(
  settings: Pick<CaptureBudgetSettings, 'totalBytes' | 'lightReserveBytes'>,
): number {
  return settings.totalBytes + settings.lightReserveBytes;
}

export interface CaptureBudget {
  /**
   * Waits until `weight` fits both the process's budget and that of `key`,
   * the sender's address, and answers with its hold; or answers `timed-out`
   * after `waitMs`, or `cancelled` once `signal` fires, holding nothing.
   *
   * First come first served. Among the webhooks waiting, the one that came
   * first and whose address has room goes in first, and while it does not fit
   * the process's budget nobody behind it goes in. A webhook whose own address
   * is full keeps nobody else out, and nobody of its address overtakes it.
   * A weight larger than a budget alone goes in once that budget holds
   * nothing, rather than never.
   *
   * A light sender's goes in before all of them (D261): one whose address
   * holds, `weight` included, at most `lightSenderBytes` fits whenever the
   * total stays within `inFlightBound`, past the process's budget, and no
   * heavier webhook waiting ahead of it keeps it out. Whether a webhook is
   * light is read each time it is weighed, from what its address holds then.
   *
   * One that cannot go in at once joins the line weighing `waitWeight`, its
   * `waitingWeight` (D228): when none of `key` is waiting, always; otherwise
   * only if the line of `key` and the process's line both have room for it,
   * and when not it is answered `line-full` at once, holding nothing and
   * having waited for nothing. A `waitWeight` of `0`, the default, always
   * fits.
   */
  admit(key: string, weight: number, signal?: AbortSignal, waitWeight?: number): Promise<Admission>;
  /**
   * Holds `weight` for `key` at once, whatever is held already: for a handler
   * whose webhook was admitted, and whose hold went with its connection
   * before the handler began. Those waiting go in once the total is under
   * the budgets again.
   */
  take(key: string, weight: number): CaptureHold;
  /** What is held now. Exists for tests and diagnostics. */
  readonly used: number;
  /** What `key` holds now. */
  usedBy(key: string): number;
  /** How many webhooks are waiting now. */
  readonly waiting: number;
  /** What the webhooks waiting weigh now, by their waiting weight (D228). */
  readonly lineUsed: number;
  /** What the webhooks of `key` waiting weigh now. */
  lineUsedBy(key: string): number;
  readonly settings: Readonly<CaptureBudgetSettings>;
}

interface Waiter {
  /** The order of arrival. */
  readonly sequence: number;
  readonly key: string;
  readonly weight: number;
  /** What it weighs in the line while it waits (D228). */
  readonly waitWeight: number;
  settled: boolean;
  /** Ends the wait at `waitMs`; set once the waiter is in the line. */
  timer?: ReturnType<typeof setTimeout>;
  settle(admission: Admission): void;
}

export function createCaptureBudget(settings: Partial<CaptureBudgetSettings> = {}): CaptureBudget {
  const {
    totalBytes = CAPTURE_BUDGET_BYTES,
    perAddressBytes = CAPTURE_BUDGET_PER_ADDRESS_BYTES,
    waitMs = CAPTURE_WAIT_MS,
    waitingBytes = CAPTURE_WAITING_BYTES,
    waitingPerAddressBytes = CAPTURE_WAITING_PER_ADDRESS_BYTES,
    lightSenderBytes = CAPTURE_LIGHT_SENDER_BYTES,
    lightReserveBytes = CAPTURE_LIGHT_RESERVE_BYTES,
  } = settings;
  const bound = inFlightBound({ totalBytes, lightReserveBytes });
  // An address is light while it holds no more than this, the webhook being
  // weighed included, and never past its own budget (D261).
  const lightBytes = Math.min(lightSenderBytes, perAddressBytes);
  let used = 0;
  const usedBy = new Map<string, number>();
  // Each address's webhooks in their order of arrival, and only addresses
  // with one waiting, so that choosing the next costs one look per address.
  const queues = new Map<string, Waiter[]>();
  let waiting = 0;
  let sequence = 0;
  // What the line holds, by the waiters' waiting weights (D228): kept beside
  // the queues, so that weighing one more costs nothing per waiter.
  let lineUsed = 0;
  const lineUsedBy = new Map<string, number>();

  const addToLine = (key: string, delta: number): void => {
    lineUsed += delta;

    const held = (lineUsedBy.get(key) ?? 0) + delta;

    if (held === 0) {
      lineUsedBy.delete(key);
    } else {
      lineUsedBy.set(key, held);
    }
  };

  const add = (key: string, delta: number): void => {
    used += delta;

    const held = (usedBy.get(key) ?? 0) + delta;

    if (held === 0) {
      usedBy.delete(key);
    } else {
      usedBy.set(key, held);
    }
  };

  const addressHasRoom = (waiter: Waiter): boolean => {
    const held = usedBy.get(waiter.key) ?? 0;

    return held === 0 || held + waiter.weight <= perAddressBytes;
  };

  const processHasRoom = (waiter: Waiter): boolean =>
    used === 0 || used + waiter.weight <= totalBytes;

  // A light sender's webhook that fits the reserve (D261): its address holds
  // no more than `lightBytes` with it, so that one address never holds more
  // than that of what lies past the process's budget, however many
  // connections it sends on; and the total stays within the bound.
  const lightWithRoom = (waiter: Waiter): boolean =>
    (usedBy.get(waiter.key) ?? 0) + waiter.weight <= lightBytes && used + waiter.weight <= bound;

  const remove = (waiter: Waiter): boolean => {
    const queue = queues.get(waiter.key);
    // The last first: a webhook the line has no room for leaves from there,
    // and a flood of them must not cost a search of the line each.
    const index =
      queue === undefined ? -1 : queue.at(-1) === waiter ? queue.length - 1 : queue.indexOf(waiter);

    if (queue === undefined || index === -1) {
      return false;
    }

    queue.splice(index, 1);
    waiting -= 1;
    addToLine(waiter.key, -waiter.waitWeight);

    if (queue.length === 0) {
      queues.delete(waiter.key);
    }

    return true;
  };

  const hold = (key: string, weight: number): CaptureHold => {
    let held: number | null = weight;

    add(key, weight);

    return {
      shrink(next) {
        if (held === null || next >= held) {
          return;
        }

        add(key, next - held);
        held = next;
        admitWaiting();
      },
      release() {
        if (held === null) {
          return;
        }

        add(key, -held);
        held = null;
        admitWaiting();
      },
    };
  };

  // Lets in every webhook that may go in now: a light sender's that fits the
  // reserve first, the earliest of them (D261); then, first come first
  // served, the earliest whose address has room, while it fits the process's
  // budget. Only an address's first is looked at, so nobody overtakes the
  // first of their own address.
  function admitWaiting(): void {
    for (;;) {
      let light: Waiter | undefined;
      let next: Waiter | undefined;

      for (const queue of queues.values()) {
        const head = queue[0] as Waiter;

        if (!addressHasRoom(head)) {
          continue;
        }

        if (next === undefined || head.sequence < next.sequence) {
          next = head;
        }

        if (lightWithRoom(head) && (light === undefined || head.sequence < light.sequence)) {
          light = head;
        }
      }

      const chosen = light ?? (next !== undefined && processHasRoom(next) ? next : undefined);

      if (chosen === undefined) {
        return;
      }

      remove(chosen);
      chosen.settle({ outcome: 'admitted', hold: hold(chosen.key, chosen.weight) });
    }
  }

  return {
    admit(key, weight, signal, waitWeight = 0) {
      return new Promise<Admission>((resolve) => {
        if (signal?.aborted === true) {
          resolve({ outcome: 'cancelled' });

          return;
        }

        // A waiter that leaves the line may let in those behind it.
        const leave = (outcome: 'timed-out' | 'cancelled'): void => {
          if (remove(waiter)) {
            waiter.settle({ outcome });
            admitWaiting();
          }
        };
        const onAbort = (): void => leave('cancelled');
        const waiter: Waiter = {
          sequence: sequence++,
          key,
          weight,
          waitWeight,
          settled: false,
          settle(admission) {
            waiter.settled = true;
            clearTimeout(waiter.timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(admission);
          },
        };
        const queue = queues.get(key);
        // None of its address waits: it is the first in its address's line,
        // and always waits, whatever either line holds (D228).
        const first = queue === undefined;

        if (queue === undefined) {
          queues.set(key, [waiter]);
        } else {
          queue.push(waiter);
        }

        waiting += 1;
        addToLine(key, waitWeight);
        admitWaiting();

        if (waiter.settled) {
          return;
        }

        // It must wait. Behind others of its address, only if both lines have
        // room for it, itself counted; otherwise it leaves the line at once.
        // Last of its address's queue and not its head, so leaving lets
        // nobody in: nobody waited behind it.
        if (
          !first &&
          ((lineUsedBy.get(key) ?? 0) > waitingPerAddressBytes || lineUsed > waitingBytes)
        ) {
          remove(waiter);
          waiter.settle({ outcome: 'line-full' });

          return;
        }

        waiter.timer = setTimeout(() => leave('timed-out'), waitMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    take: hold,
    get used() {
      return used;
    },
    usedBy: (key) => usedBy.get(key) ?? 0,
    get waiting() {
      return waiting;
    },
    get lineUsed() {
      return lineUsed;
    },
    lineUsedBy: (key) => lineUsedBy.get(key) ?? 0,
    settings: {
      totalBytes,
      perAddressBytes,
      waitMs,
      waitingBytes,
      waitingPerAddressBytes,
      lightSenderBytes,
      lightReserveBytes,
    },
  };
}

type Handler<Request extends FastifyRequest, Result> = (
  request: Request,
  reply: FastifyReply,
) => Promise<Result>;

export interface CaptureAdmission {
  /**
   * The webhook plugin's `onRequest` hook: weighs the webhook and waits for
   * its place, the body unread. A sender whose connection Node sees end
   * meanwhile is dropped with a line at `info`, and nothing is stored - with
   * the socket not read Node generally sees none, and under the PROXY
   * protocol none was seen (D210 point 6); a wait of `waitMs` is refused
   * `503` / `1018` with `Retry-After: 1`, its body read and discarded first
   * on a connection Node is about to close, as D143 drains a refused body,
   * when one of the process's drain places is free (D228), with a line at
   * `warn` - unless the connection turns out gone by then, which is a sender
   * that left, at `info`. One the waiting line has no room for is refused
   * the same way at once, its answer carrying `Connection: close` (D228).
   */
  guard: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /**
   * The route's handler, holding its webhook's weight from the moment it
   * starts until it settles, whatever the connection does meanwhile. A
   * handler whose connection went after the body was read and before it
   * began takes the weight again at once: the webhook is stored all the same.
   */
  holding: <Request extends FastifyRequest, Result>(
    handler: Handler<Request, Result>,
  ) => Handler<Request, Result>;
  /**
   * The webhook is stored: its weight shrinks to `storedWeight`, which keeps
   * the body Node holds unread for a `GET`, `HEAD` or `TRACE`, and never
   * grows (`CAPTURE_ANSWER_RESERVE_BYTES`).
   */
  stored: (request: FastifyRequest, replyBodyBytes: number) => void;
}

/**
 * What holds one webhook's weight: the connection, until its reply closes,
 * and the route's handler, while it runs. Given back when neither does any
 * longer, exactly once.
 */
interface Held {
  key: string;
  weight: number;
  /** `null` once given back. */
  hold: CaptureHold | null;
  /** The reply has closed: the answer is written, or the connection gone. */
  closed: boolean;
  /** The handler is running, with the body read. */
  working: boolean;
}

function giveBack(held: Held): void {
  const hold = held.hold;

  held.hold = null;
  hold?.release();
}

/** The guard's stop of one connection, shared by the webhooks waiting on it. */
interface Stop {
  /** How many webhooks of the connection are waiting, or deciding to. */
  waiting: number;
  /** The guard stopped the connection, so it starts it again; not Node's stop. */
  ours: boolean;
  /** Lets the pipelining bound start the connection again, should it have stopped it (D229). */
  release: () => void;
}

/**
 * Answers `stopReading(socket)`, which stops reading `socket` now and answers
 * what lets it be read again, once for each webhook.
 *
 * Node reads a socket ahead of its request: the chunk that carried the
 * headers, then more of the body, up to 64 KiB into the request's buffer
 * before it stops. And every read of a connection lets the kernel grow the
 * connection's receive buffer for a reader this fast: a webhook of 1 MiB left
 * waiting after two reads had most of its body queued in the kernel, charged
 * to the backend's memory like its own - 500 at once from one address took
 * 374 MiB of socket buffers and killed the 512 MiB process (D210). Stopped
 * here, at the chunk that carried the headers, a waiting webhook holds that
 * chunk, at most 64 KiB, and the kernel the connection's first window, about
 * 125 KiB.
 *
 * The stop belongs to the connection, not to one request: a pipelined
 * request - a `GET` followed on its connection by a `POST` of 1 MiB - shares
 * the socket with the next, and a `GET` admitted at once must not start a
 * socket a `POST` behind it still waits on (D210). So the webhooks of a
 * connection are counted while they wait, the first that finds it read stops
 * it, and it is started again once the last of them is admitted, refused or
 * gone, and only if the guard stopped it.
 *
 * Started again by the guard itself, not left to the body's reading: Node
 * starts a socket again when a request's body is read, but a request with no
 * body has ended already, and its kept-alive connection would never be read
 * again. A socket Node had stopped itself - for answers to pipelined
 * requests it has not written yet - stays Node's to start. One the
 * pipelining bound stopped at its count stays stopped too: the guard holds
 * the connection against the bound while any of its webhooks waits, and the
 * bound starts it once the guard lets go (D229).
 */
export function connectionStops(): (socket: Socket | null | undefined) => () => void {
  const stops = new WeakMap<Socket, Stop>();

  return (socket) => {
    if (
      socket === null ||
      socket === undefined ||
      typeof socket.pause !== 'function' ||
      socket.destroyed
    ) {
      return () => undefined;
    }

    let stop = stops.get(socket);

    if (stop === undefined) {
      // Held against the pipelining bound too, which would otherwise start
      // a connection it stopped at its count as soon as an earlier request
      // of it is answered, with a webhook still waiting (D229).
      stop = { waiting: 0, ours: false, release: holdStopped(socket) };
      stops.set(socket, stop);
    }

    if (!socket.isPaused()) {
      socket.pause();
      stop.ours = true;
    }

    stop.waiting += 1;

    const shared = stop;
    let settled = false;

    return () => {
      if (settled) {
        return;
      }

      settled = true;
      shared.waiting -= 1;

      if (shared.waiting > 0) {
        return;
      }

      // Decided a turn later, so that a webhook of the same connection whose
      // guard starts in this turn - its headers came in the same chunk -
      // finds the connection still stopped and keeps it so: `resume` takes
      // effect only on the next turn, where a `pause` in between would leave
      // Node reading a socket it reports stopped.
      process.nextTick(() => {
        if (shared.waiting > 0 || stops.get(socket) !== shared) {
          return;
        }

        stops.delete(socket);
        shared.release();

        if (shared.ours && !socket.destroyed && socket.isPaused()) {
          socket.resume();
        }
      });
    };
  };
}

/**
 * What stops reading an HTTP/2 webhook while it waits (D263): nothing more
 * than not reading it. Its connection carries other streams, which go on, and
 * Node refuses to stop the socket of a session
 * (`ERR_HTTP2_NO_SOCKET_MANIPULATION`). Its stream is not read until Fastify
 * reads the body, once the webhook is admitted: Node takes what arrives into
 * the stream's buffer, and gives the stream's flow-control window back only
 * as it is read, so HTTP/2's flow control holds the rest of the body at the
 * sender - a stream not read holds no more than its receive window, 64 KiB
 * (`initialWindowSize`, Node's default). The connection's window is not held
 * with it: Node gives it back as each DATA frame arrives, whatever its stream
 * does, so a waiting stream that has sent its whole window stalls none of its
 * sender's other streams (`receiver-http2.test.ts`). It is not paused
 * besides: a stream paused and then reset with `NO_ERROR` - a refusal before
 * the body, a `GET` that sent one (`createReceiveHttp2Server`) - waits for
 * its readable side to end before Node lets it go, which a paused stream
 * never does, and its connection stayed open with it in a test. Each stream
 * is its own, so no stop is shared.
 */
function notReadingStream(): () => void {
  return () => undefined;
}

/**
 * The guard and the handler wrapper of the receiver's routes, sharing
 * `budget`. `keyOf` is the sender's address as the budget counts it;
 * `drainPlaces` are the places a refusal's drain takes, the process's own
 * unless a test passes others (D228).
 */
export function captureAdmission(
  budget: CaptureBudget,
  keyOf: (request: FastifyRequest) => string,
  drainPlaces: Slots = refusalDrainPlaces,
): CaptureAdmission {
  const holds = new WeakMap<FastifyRequest, Held>();
  const stopReading = connectionStops();

  return {
    async guard(request, reply) {
      const http2 = http2FramingOf(request);
      const stream = http2StreamOf(request.raw);
      const weight = captureWeight(request.raw.method, request.raw.rawHeaders, http2);

      // A body Fastify reads, declared over 1 MiB: refused `413` unread, so
      // it never waits.
      if (weight === 0) {
        return;
      }

      const key = keyOf(request);
      // Nothing has been written yet, so the reply closing means the
      // connection has gone.
      const left = new AbortController();
      const onClose = (): void => left.abort();

      if (isAnswerGone(reply.raw)) {
        left.abort();
      } else {
        reply.raw.once('close', onClose);
      }

      const readAgain = stream === undefined ? stopReading(request.raw.socket) : notReadingStream();
      const waitWeight = waitingWeight(request.raw.rawHeaders, http2);
      let admission: Admission;

      try {
        admission = await budget.admit(key, weight, left.signal, waitWeight);
      } finally {
        reply.raw.off('close', onClose);
        // Admitted, refused or gone, this webhook no longer waits: once no
        // other of its connection does, the connection is read again - for
        // the body, or for what comes after the refusal.
        readAgain();
      }

      if (admission.outcome === 'cancelled') {
        request.log.info(SENDER_LEFT);
        reply.hijack();

        return;
      }

      if (admission.outcome === 'timed-out' || admission.outcome === 'line-full') {
        // Drained first on a connection Node is about to close, when a drain
        // place is free; with none free answered at once, the connection
        // ending with it (D143, D228). Over HTTP/2 nothing is drained: the
        // refusal ends its stream alone, with `RST_STREAM(NO_ERROR)` after
        // it, which costs the sender no answer (D263).
        await drainRefusedBody(
          request.raw,
          stream === undefined ? reply.raw.shouldKeepAlive : true,
          drainPlaces,
        );

        // A sender that left in the middle of its body while it waited is
        // seen only now, its socket read again: the drain ends on the
        // connection's close. It was not refused, it left, and is logged as
        // one that left, so that the lines at `warn` count refusals alone.
        if (isAnswerGone(reply.raw) || connectionEndedBeforeBody(request.raw)) {
          request.log.info(SENDER_LEFT);
          reply.hijack();

          return;
        }

        // The address is never logged because of a limit (D201 point 7).
        if (admission.outcome === 'line-full') {
          request.log.warn({ weight, waitWeight, lineUsed: budget.lineUsed }, REFUSED_LINE_FULL);

          // Refused at once, and its connection ends with the answer
          // (D228): a connection kept alive would carry the next of a
          // sender's pipelined requests, each parsed and refused in turn.
          throw capturesBusy(true);
        }

        request.log.warn({ weight, waitedMs: budget.settings.waitMs }, REFUSED_IN_TIME);

        throw capturesBusy();
      }

      const held: Held = { key, weight, hold: admission.hold, closed: false, working: false };
      const closed = (): void => {
        held.closed = true;

        if (!held.working) {
          giveBack(held);
        }
      };

      holds.set(request, held);

      if (isAnswerGone(reply.raw)) {
        closed();
      } else {
        reply.raw.once('close', closed);
      }
    },

    holding(handler) {
      return async (request, reply) => {
        const held = holds.get(request);

        if (held === undefined) {
          return handler(request, reply);
        }

        if (held.hold === null) {
          held.hold = budget.take(held.key, held.weight);
        }

        held.working = true;

        try {
          return await handler(request, reply);
        } finally {
          held.working = false;

          if (held.closed) {
            giveBack(held);
          }
        }
      };
    },

    stored(request, replyBodyBytes) {
      holds
        .get(request)
        ?.hold?.shrink(
          storedWeight(
            request.raw.method,
            request.raw.rawHeaders,
            replyBodyBytes,
            http2FramingOf(request),
          ),
        );
    },
  };
}
