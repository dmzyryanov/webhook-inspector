/**
 * A count of places held at once in one process, with no queue: the search's
 * slots (D191), the places of list answers with bodies (D201) and those of
 * large bodies (D205) are each one, and the calls in flight of each address
 * are counted by key (D213). And one with a queue, the gate in front of the
 * API's work (D244), whose next take waits rather than being refused. Pure,
 * so the rules can be tested without a server.
 */

export interface Slots {
  /**
   * Takes a place and answers with what gives it back, or with `null` when
   * every place is taken. Giving a place back twice gives it back once.
   */
  tryTake(): (() => void) | null;
  /** Places taken now. Exists for tests and diagnostics. */
  readonly taken: number;
}

/** At most `limit` places at once; one asked for beyond that is refused, never awaited. */
export function createSlots(limit: number): Slots {
  let taken = 0;

  return {
    tryTake() {
      if (taken >= limit) {
        return null;
      }

      taken += 1;

      let released = false;

      return () => {
        if (!released) {
          released = true;
          taken -= 1;
        }
      };
    },
    get taken() {
      return taken;
    },
  };
}

/**
 * A count of places held at once per key, with no queue: the calls in flight
 * of one address (D213). Each key has `limit` places of its own; one asked for
 * beyond them is refused, never awaited. A key is kept only while it holds a
 * place: its entry is deleted as its last place comes back, so the keys seen
 * over time leave nothing behind.
 */
export interface KeyedSlots {
  /**
   * Takes a place of `key` and answers with what gives it back, or with
   * `null` when every place of `key` is taken. Giving a place back twice
   * gives it back once.
   */
  tryTake(key: string): (() => void) | null;
  /** Places taken now by `key`. Exists for tests and diagnostics. */
  takenBy(key: string): number;
  /** Places taken now, every key together. Exists for tests and diagnostics. */
  readonly taken: number;
  /** Keys holding a place now. Exists for tests and diagnostics. */
  readonly keys: number;
  /** The places each key has. */
  readonly limit: number;
}

/** At most `limit` places at once per key; one asked for beyond that is refused, never awaited. */
export function createKeyedSlots(limit: number): KeyedSlots {
  const counts = new Map<string, number>();
  let taken = 0;

  return {
    tryTake(key) {
      const count = counts.get(key) ?? 0;

      if (count >= limit) {
        return null;
      }

      counts.set(key, count + 1);
      taken += 1;

      let released = false;

      return () => {
        if (released) {
          return;
        }

        released = true;
        taken -= 1;

        const left = (counts.get(key) ?? 1) - 1;

        if (left === 0) {
          counts.delete(key);
        } else {
          counts.set(key, left);
        }
      };
    },
    takenBy(key) {
      return counts.get(key) ?? 0;
    },
    get taken() {
      return taken;
    },
    get keys() {
      return counts.size;
    },
    limit,
  };
}

/**
 * A count of places held at once in one process, with a queue: the gate in
 * front of the API's and `/mcp`'s work (D244). One asked for while every
 * place is taken, or while others wait, waits for one, never refused. The
 * waiting are served round robin by key - one of the first key waiting, then
 * one of the next, a key with more going to the back of the round - and in
 * the order they came within a key, so that one key queuing many cannot keep
 * another's one waiting behind them all. A wait whose signal aborts leaves
 * the queue at once, having taken nothing.
 */
export interface WaitingSlots {
  /**
   * Takes a place for `key` and answers with what gives it back, at once
   * when one is free and nobody waits, otherwise once one is given back and
   * the turn is `key`'s; with `null`, taking nothing, when `signal` aborts
   * first. Giving a place back twice gives it back once.
   */
  take(key: string, signal: AbortSignal): Promise<(() => void) | null>;
  /** Places taken now. Exists for tests and diagnostics. */
  readonly taken: number;
  /** Takes waiting now, every key together. Exists for tests and diagnostics. */
  readonly waiting: number;
  /** Keys with a take waiting now. Exists for tests and diagnostics. */
  readonly keys: number;
  /** The places. */
  readonly limit: number;
}

interface Waiter {
  grant: (release: () => void) => void;
  signal: AbortSignal;
  leave: () => void;
}

/** At most `limit` places at once; one asked for beyond that waits its turn, round robin by key. */
export function createWaitingSlots(limit: number): WaitingSlots {
  let taken = 0;
  let waiting = 0;
  // The keys with takes waiting, in the order of their turns: the first key's
  // first take is served next, and the key then goes to the back.
  const queues = new Map<string, Waiter[]>();

  function place(): () => void {
    taken += 1;

    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      taken -= 1;
      serve();
    };
  }

  function serve(): void {
    while (taken < limit) {
      const next = queues.entries().next();

      if (next.done === true) {
        return;
      }

      const [key, waiters] = next.value;
      const waiter = waiters.shift() as Waiter;

      queues.delete(key);

      if (waiters.length > 0) {
        queues.set(key, waiters);
      }

      waiting -= 1;
      waiter.signal.removeEventListener('abort', waiter.leave);
      waiter.grant(place());
    }
  }

  return {
    take(key, signal) {
      if (signal.aborted) {
        return Promise.resolve(null);
      }

      if (taken < limit && waiting === 0) {
        return Promise.resolve(place());
      }

      return new Promise((resolve) => {
        const waiter: Waiter = {
          grant: resolve,
          signal,
          leave: () => {
            const waiters = queues.get(key) ?? [];
            const at = waiters.indexOf(waiter);

            if (at === -1) {
              return;
            }

            waiters.splice(at, 1);
            waiting -= 1;

            if (waiters.length === 0) {
              queues.delete(key);
            }

            resolve(null);
          },
        };
        const waiters = queues.get(key);

        if (waiters === undefined) {
          queues.set(key, [waiter]);
        } else {
          waiters.push(waiter);
        }

        waiting += 1;
        signal.addEventListener('abort', waiter.leave, { once: true });
      });
    },
    get taken() {
      return taken;
    },
    get waiting() {
      return waiting;
    },
    get keys() {
      return queues.size;
    },
    limit,
  };
}
