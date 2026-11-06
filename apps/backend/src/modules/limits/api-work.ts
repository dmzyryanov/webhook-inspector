/**
 * The gate in front of the work of `/api` and `/mcp` (D244): at most
 * `API_WORK_SLOTS`, 3, pieces of their work at once in the process, across
 * every address - a handler, or a read of a list answer streamed after its
 * head. Work past them waits for a slot - never refused, so no answer
 * changes, only when it comes - and the waiting are served round robin by
 * address (`addressKey`, as the limits key one), in the order they came
 * within an address (`createWaitingSlots`).
 *
 * The per-address limits bound one address (D201, D213); nothing bounded
 * many together, and eight addresses within theirs kept up to 1,024
 * handlers at work on one event loop and one pool, holding captures for
 * tens of seconds (#213). Capture now has a pool of its own (`db/pool.ts`);
 * the gate bounds what the API's work does to the event loop, which capture
 * shares, and to the API's pool.
 *
 * A call takes its slot once its place among its address's calls in flight
 * is held (`calls-in-flight.ts`, which wraps this wrapper), its body read,
 * as its handler would start, and holds it until its answer begins - in
 * `onSend`, once the answer is made and before it is written - or until its
 * handler settles having answered by itself (a hijack, or nothing for a
 * client gone). A client that goes while its handler works does not give the
 * slot back before the handler settles: the work goes on, a statement and its
 * rows, so it keeps the slot it is done in. The slot goes back once.
 *
 * Nor before a read the call started settles, whatever ends the call
 * meanwhile: a wait's read, which its client leaving, a clear or the
 * session's deletion ends the wait - and its handler - before, or a read of a
 * streamed answer (`WaitSlot.read`, `inSlot`). Given back while such a read
 * is at work, the slot goes back once the last of them settles, its
 * statement having ended; the handler settling, the answer beginning and the
 * response closing never free it before (#243).
 *
 * Work is what holds a slot, never waiting for a client: a list answer with
 * content, streamed as its client reads it (`list-answer.ts`), takes a slot
 * for each read of content and each resumption, in turn, and none while it
 * waits for its client to take what was written (`inSlot`); once its
 * response has closed, nothing more is read. And a wait - `GET
 * .../requests?wait=N` and `wait_for_request` - holds a slot for each of its
 * reads and the answer that follows its last, and none while it waits
 * (`waitSlot`, `waitForList`).
 *
 * Nor waiting in a session's line: a call that changes a session - its
 * response, queue or rules, or a clear - gives its slot back before it joins
 * the session's line, behind the session's captures, and runs its turn
 * without one (`inSessionLine`).
 *
 * A call whose client goes while it waits leaves the queue and runs
 * nothing: no statement, no answer, as a wait whose client leaves (D200).
 *
 * The gate lives in the process: there is one outside a rollout, and two
 * for its seconds (D221).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { createWaitingSlots, type WaitingSlots } from '../../lib/slots.ts';

/**
 * The pieces of work of `/api` and `/mcp` at once in one process (D244):
 * three, the fewest that still let a third search find both search places
 * taken and be refused `1012` (D191) - with two it would wait behind them -
 * and fewer than #213's six, under which more of the API's work shares
 * the event loop with capture (D244 point 9).
 */
export const API_WORK_SLOTS = 3;

/** The gate's slots in one process. */
export type ApiWorkSlots = WaitingSlots;

export function createApiWorkSlots(limit: number = API_WORK_SLOTS): ApiWorkSlots {
  return createWaitingSlots(limit);
}

/**
 * What a wait holds while it reads and gives back while it waits (D244):
 * its call's slot in the gate, which a change gives back too before it joins
 * its session's line (`inSessionLine`). A call outside the gate gets
 * `NO_WAIT_SLOT`.
 */
export interface WaitSlot {
  /** Whether the slot is held now, so that a read may start at once. */
  readonly held: boolean;
  /**
   * Gives the slot back, if it is held: at once, or, while a read of the
   * call is at work (`read`), once the last of them settles.
   */
  leave(): void;
  /**
   * Holds a slot - at once when one is held already, otherwise waiting its
   * turn as a new call does - and answers `true`; `false` once the call's
   * response has closed, its client gone.
   */
  enter(): Promise<boolean>;
  /**
   * Runs `read`, a statement of the call's, in the slot held, and answers
   * what it answers: the slot is not given back before it settles, whatever
   * ends the call meanwhile - its client leaving, its handler settling, its
   * answer beginning (D244 point 4).
   */
  read<T>(read: () => Promise<T>): Promise<T>;
}

export const NO_WAIT_SLOT: WaitSlot = {
  held: true,
  leave: () => undefined,
  enter: async () => true,
  read: (read) => read(),
};

/** A session's line of calls (`RealtimeHub.inOrder`, D205). */
export interface SessionLine {
  inOrder<T>(sessionId: string, change: () => Promise<T>): Promise<T>;
}

/**
 * Runs `change` in `sessionId`'s line (`RealtimeHub.inOrder`, D205) holding
 * no slot of the gate (D244): `slot`, the call's, goes back before the call
 * joins the line, and its turn runs without one.
 *
 * A call waits in the line behind the session's captures and changes, as
 * long as a burst of webhooks to the session takes; holding its slot
 * meanwhile, three such calls held every slot and stalled every other call
 * of the API from every address. And a turn that waited for a slot at the
 * head of the line would hold the session's captures behind it for the
 * API's other work. What bounds the turns run without a slot is the line
 * itself, one call of a session at a time, the 128 calls an address may
 * have in flight (D213), and the API's pool they run on, waiting in its
 * order for a connection; captures run on a pool of their own.
 */
export function inSessionLine<T>(
  line: SessionLine,
  sessionId: string,
  slot: WaitSlot,
  change: () => Promise<T>,
): Promise<T> {
  slot.leave();

  return line.inOrder(sessionId, change);
}

export interface ApiWork {
  /** The slots, which a test reads `taken` and `waiting` of. */
  readonly slots: ApiWorkSlots;
  /**
   * Runs `run` once `request` holds a slot, waiting its turn; a call whose
   * client went meanwhile is answered nothing and never runs it. What `run`
   * answers is the call's.
   */
  inTurn(
    request: FastifyRequest,
    reply: FastifyReply,
    run: () => Promise<unknown>,
  ): Promise<unknown>;
  /** A route's handler behind the gate, run `inTurn`. */
  gated(handler: RouteHandlerMethod): RouteHandlerMethod;
  /** `request`'s answer has begun: its slot goes back (`onSend`). */
  answerBegins(request: FastifyRequest): void;
  /**
   * What a wait of `request` holds while it reads, and a change gives back
   * before it joins its session's line (`NO_WAIT_SLOT` for a call outside
   * the gate).
   */
  waitSlot(request: FastifyRequest): WaitSlot;
  /**
   * Runs `read` for `request` in a slot of its own, waiting its turn, and
   * gives the slot back once it settles, never before, the response closing
   * meanwhile: a read of a list answer's content, or a resumption, after its
   * head is written. Answers `gone` without running it once the call's
   * response has closed. A call outside the gate runs it at once.
   */
  inSlot<T>(request: FastifyRequest, read: () => Promise<T>, gone: T): Promise<T>;
}

/** One call's part in the gate. */
interface Work {
  key: string;
  /** Gives the slot back; `null` while none is held. */
  release: (() => void) | null;
  /** Aborted once the call's response has closed: its answer written, or its client gone. */
  closed: AbortController;
  /** The handler is at work. */
  working: boolean;
  /** The reads of the call at work in its slot now: a wait's, or a streamed answer's. */
  reads: number;
  /** The slot was given back while reads were at work: it goes back once the last settles. */
  leaving: boolean;
}

/**
 * Gives `work`'s slot back, once: at once, or, while a read of the call is at
 * work, once the last of them settles (`reading`) - its statement goes on,
 * whatever gave the slot back.
 */
function leave(work: Work): void {
  if (work.reads > 0) {
    work.leaving = true;

    return;
  }

  const release = work.release;

  work.leaving = false;
  work.release = null;
  release?.();
}

/** Runs `read` as work of the call in its slot, which goes back no sooner than it settles. */
async function reading<T>(work: Work, read: () => Promise<T>): Promise<T> {
  work.reads += 1;

  try {
    return await read();
  } finally {
    work.reads -= 1;

    if (work.reads === 0 && work.leaving) {
      leave(work);
    }
  }
}

/**
 * The reason every call's signal is aborted with once its response has
 * closed. Nothing reads it; one made once spares the `DOMException`, and its
 * stack, that `abort()` with none makes for every call - the gate's largest
 * cost in a profile of 400 ordinary users (D244 point 12).
 */
const RESPONSE_CLOSED = new Error('The response has closed');

/**
 * The response has closed: nothing more waits for a slot, and the slot goes
 * back unless the handler is at work, whose settling gives it back - and in
 * either case no sooner than the call's reads at work settle.
 */
function close(work: Work): void {
  work.closed.abort(RESPONSE_CLOSED);

  if (!work.working) {
    leave(work);
  }
}

/** The gate of one listener on `slots`, keying each call by `keyOf`. */
export function createApiWork(
  slots: ApiWorkSlots,
  keyOf: (request: FastifyRequest) => string,
): ApiWork {
  const works = new WeakMap<FastifyRequest, Work>();

  async function enter(work: Work): Promise<boolean> {
    // Its response closed, nothing more is read, in a slot held or not.
    if (work.closed.signal.aborted) {
      return false;
    }

    if (work.release !== null) {
      return true;
    }

    const release = await slots.take(work.key, work.closed.signal);

    if (release === null) {
      return false;
    }

    // Closed between the slot's grant and this step: given back at once.
    if (work.closed.signal.aborted) {
      release();

      return false;
    }

    work.release = release;

    return true;
  }

  async function inTurn(
    request: FastifyRequest,
    reply: FastifyReply,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    const work: Work = {
      key: keyOf(request),
      release: null,
      closed: new AbortController(),
      working: false,
      reads: 0,
      leaving: false,
    };

    works.set(request, work);

    if (reply.raw.destroyed) {
      close(work);
    } else {
      reply.raw.once('close', () => close(work));
    }

    if (!(await enter(work))) {
      // Nothing is written to a connection that is gone, as for a wait
      // whose client left (D200), and nothing of the call is run.
      request.log.info('Request aborted by the client');

      return reply.hijack();
    }

    work.working = true;

    try {
      return await run();
    } finally {
      work.working = false;

      // Closed already - its client gone while it worked - or answered by
      // the handler itself, past `onSend`: a hijack. A read it started and
      // left at work - a wait's, its client gone - keeps the slot until it
      // settles (`leave`).
      if (work.closed.signal.aborted || reply.sent) {
        leave(work);
      }
    }
  }

  return {
    slots,
    inTurn,

    gated(handler) {
      return async function gatedHandler(
        this: FastifyInstance,
        request: FastifyRequest,
        reply: FastifyReply,
      ): Promise<unknown> {
        return inTurn(request, reply, () => Promise.resolve(handler.call(this, request, reply)));
      } as RouteHandlerMethod;
    },

    answerBegins(request) {
      const work = works.get(request);

      if (work !== undefined) {
        leave(work);
      }
    },

    waitSlot(request) {
      const work = works.get(request);

      if (work === undefined) {
        return NO_WAIT_SLOT;
      }

      return {
        get held() {
          return work.release !== null;
        },
        leave: () => leave(work),
        enter: () => enter(work),
        read: (read) => reading(work, read),
      };
    },

    async inSlot(request, read, gone) {
      const work = works.get(request);

      if (work === undefined) {
        return read();
      }

      // A slot held already - in the handler - is the handler's to give back,
      // no sooner than this read settles (`leave`).
      const own = work.release === null;

      if (!(await enter(work))) {
        return gone;
      }

      try {
        return await reading(work, read);
      } finally {
        if (own) {
          leave(work);
        }
      }
    },
  };
}
