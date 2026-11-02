/**
 * The long-poll of the request list, `GET .../requests?wait=N` (D200): an
 * answer that would be empty is held until a request arrives for it, the
 * session's requests are cleared, the session is deleted, the client leaves,
 * the process shuts down or `N` seconds pass.
 *
 * A pending wait is a subscriber of the realtime hub, as a viewer's socket is,
 * registered **before** the first read of the database. A capture publishes
 * `request.received` only once it has committed (D075), so a capture that
 * commits after that read has begun is announced to the wait, and one that
 * committed before is seen by the read: none is missed between the two. On
 * every announcement the list is read again; an answer still empty keeps the
 * wait going. Announcements that arrive while a read is under way are folded
 * into one more read after it, so a burst of captures costs a few reads, never
 * one per capture, and nothing is answered twice: the first outcome settles
 * the wait, and whatever comes after it - a read that returns late, another
 * event, the timer - finds it settled and does nothing.
 *
 * It holds for a capture on any process: the capture's announcement is
 * written in its transaction and delivered to this process's hub by its
 * listener once it has committed (D221). A wait that starts while the process
 * is not listening, or is waiting when the listening stops, is answered as at
 * shutdown, after one last read: nothing would announce a capture to it.
 *
 * Waiting ends with the list chosen; writing it is the route's, afterwards
 * (`sendList`). The two are kept apart so that a cap on answers being written
 * (#100) can apply to the writing alone, and a call held here takes no place
 * in it while it waits.
 *
 * Nor in the gate in front of the API's work (D244) while it waits: each read
 * holds its call's slot, waiting its turn for one first, and gives it back
 * once its list is empty and the wait goes on; the read that ends the wait
 * keeps it for the answer. A read under way when something else ends the
 * wait keeps the slot until it settles, its statement going on.
 */
import { NO_WAIT_SLOT, type WaitSlot } from '../limits/api-work.ts';
import { RELOAD_CLOSE_CODE, type RealtimeHub, type Subscriber } from '../realtime/hub.ts';
import { sessionNotFound } from '../../errors/app-error.ts';

/**
 * The optional event a wait declares (D115): a clear ends it. `request.received`
 * is not optional and reaches every subscriber; nothing else concerns a wait,
 * and a deleted request does not end one (D200).
 */
const WAIT_EVENTS: ReadonlySet<string> = new Set(['requests.cleared']);

/**
 * The waits pending in one process, so that a shutdown ends them at once
 * rather than holding a rollout for up to 30 s (D200). Each wait is kept by
 * the function that runs its time out, from the moment it starts until it is
 * settled, together with its timer: a wait that is no longer here has no
 * timer either.
 */
export class PendingWaits {
  readonly #waits = new Set<() => void>();
  #closed = false;

  /**
   * Keeps a wait until `delete`, and answers whether its time may run: `false`
   * once the process is shutting down, when a wait that starts anyway has run
   * out already and its first read is its answer.
   */
  add(runOut: () => void): boolean {
    this.#waits.add(runOut);

    return !this.#closed;
  }

  delete(runOut: () => void): void {
    this.#waits.delete(runOut);
  }

  /**
   * Runs every pending wait's time out now, as on shutdown, and every wait
   * that starts afterwards at once: each reads the list a last time and
   * answers what its time running out would have answered.
   */
  close(): void {
    this.#closed = true;

    for (const runOut of [...this.#waits]) {
      runOut();
    }
  }

  /** Whether `close` has run: the process is shutting down. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Waits pending. Exists for tests and diagnostics. */
  get size(): number {
    return this.#waits.size;
  }
}

export interface WaitOptions<T> {
  hub: RealtimeHub;
  waits: PendingWaits;
  sessionId: string;
  /** How long an empty answer is held, in milliseconds. */
  waitMs: number;
  /** Aborted when the client has gone: the wait ends at once, with no answer. */
  signal: AbortSignal;
  /** The read when the call arrives. What it refuses, the call answers. */
  first: () => Promise<T[]>;
  /** Every read after the first: on an announced capture, and when the time runs out. */
  again: () => Promise<T[]>;
  /**
   * The call's slot in the gate in front of the API's work (D244), held for
   * each read and given back while the wait goes on. Absent, none.
   */
  slot?: WaitSlot;
}

/** The type of a published event, or `null` for a payload that is not one. */
function eventType(payload: string): string | null {
  try {
    const event = JSON.parse(payload) as unknown;

    return typeof event === 'object' && event !== null && 'type' in event
      ? String(event.type)
      : null;
  } catch {
    return null;
  }
}

/**
 * Reads the list with `first`, and while it is empty, again with `again`
 * whenever a capture is announced for the session, until it is not.
 *
 * Resolves with the first list that is not empty; with an empty one when the
 * session's requests are cleared (at once, without a read), and when the time
 * runs out, `PendingWaits.close` ends it or the hub asks it to read again
 * (`RealtimeHub.reload`, D221) (after one last read, which may
 * still find a request, and whose refusal - the session expired or gone - is
 * the answer instead); and with `null` once `signal` is aborted, the client
 * having left. Rejects with what a read rejects with, and with `404` / `1001`
 * at once when the session is deleted (`RealtimeHub.closeSession`, D198).
 *
 * However it ends, the wait leaves at once, before anything else runs: its
 * subscription, its timer, its place among the pending waits and its
 * listener on `signal`. A read still under way then is left to finish, and
 * its result is dropped.
 *
 * Each read first holds `slot` (D244), waiting its turn when it is not held,
 * and nothing is read once the call is over for the gate. A read whose list
 * is empty, the wait going on, gives the slot back; one that ends the wait
 * keeps it for the answer, and one that finds the wait settled gives it back.
 * Each runs as the call's work (`slot.read`): a read under way when the
 * client leaves, a clear or the deletion ends the wait keeps the slot until it
 * settles, however the call's handler and answer end meanwhile.
 */
export function waitForList<T>(options: WaitOptions<T>): Promise<T[] | null> {
  const { hub, waits, sessionId, waitMs, signal, first, again } = options;
  const slot = options.slot ?? NO_WAIT_SLOT;

  return new Promise<T[] | null>((resolve, reject) => {
    let settled = false;
    let reading = false;
    /** A capture was announced since the read under way began. */
    let announced = false;
    /** The time has run out: the next read is the last. */
    let timeUp = false;

    function leave(): void {
      settled = true;
      clearTimeout(timer);
      hub.remove(sessionId, subscriber);
      waits.delete(runOut);
      signal.removeEventListener('abort', onAbort);
    }

    function answer(list: T[] | null): void {
      if (!settled) {
        leave();
        resolve(list);
      }
    }

    function fail(error: unknown): void {
      if (!settled) {
        leave();
        reject(error);
      }
    }

    async function read(reader: () => Promise<T[]>): Promise<void> {
      reading = true;

      // Its turn in the gate first, unless its slot is held; a call over for
      // the gate - its client gone, which settles the wait too - reads
      // nothing more.
      if (!slot.held && (!(await slot.enter()) || settled)) {
        reading = false;
        slot.leave();

        return;
      }

      // Read from here, after the turn: what was announced before it, and
      // the time running out, are what this read sees.
      announced = false;

      const last = timeUp;
      let list: T[];

      // As the call's work: whatever ends the wait meanwhile - its client
      // leaving, a clear, the session's deletion - and its handler with it,
      // the slot is not given back before this read settles (`slot.read`).
      try {
        list = await slot.read(reader);
      } catch (error) {
        reading = false;

        if (settled) {
          slot.leave();
        } else {
          fail(error);
        }

        return;
      }

      reading = false;

      if (settled) {
        slot.leave();

        return;
      }

      if (list.length > 0 || last) {
        answer(list);

        return;
      }

      slot.leave();

      if (announced || timeUp) {
        void read(again);
      }
    }

    const subscriber: Subscriber = {
      send(payload) {
        if (settled) {
          return;
        }

        const type = eventType(payload);

        if (type === 'requests.cleared') {
          answer([]);
        } else if (type === 'request.received') {
          announced = true;

          if (!reading) {
            void read(again);
          }
        }
      },
      close(code) {
        // Asked to read the session again (D221): answered as when its time
        // runs out, after one last read. Any other close is the deletion's.
        if (code === RELOAD_CLOSE_CODE) {
          runOut();
        } else {
          fail(sessionNotFound());
        }
      },
      // Nothing is ever buffered: an event is read here as it is delivered,
      // so the hub never finds a wait behind (D205). Cut all the same, by an
      // event larger than the hub's bound or because the process stopped
      // listening (D221), the wait answers as when its time runs out, after
      // one last read.
      bufferedAmount: 0,
      terminate() {
        runOut();
      },
    };

    function runOut(): void {
      if (settled) {
        return;
      }

      timeUp = true;

      if (!reading) {
        void read(again);
      }
    }

    function onAbort(): void {
      answer(null);
    }

    if (signal.aborted) {
      resolve(null);

      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
    // Subscribed before the first read, so that no capture falls between the two.
    hub.add(sessionId, subscriber, WAIT_EVENTS);
    // Declared here, after everything that reads it, and set before any of it can run.
    const timer = setTimeout(runOut, waitMs);
    // Shutting down, or not listening (D221): the first read is the answer.
    timeUp = !waits.add(runOut) || hub.deaf;
    void read(first);
  });
}
