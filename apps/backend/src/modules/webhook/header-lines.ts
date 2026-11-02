/**
 * The bound on the header lines in flight on the receive listener (#182,
 * D238): how many lines of request heads, and of chunked bodies' trailer
 * sections, Node's HTTP parser may have been given and not yet seen end,
 * per sender address and per process.
 *
 * The receive listener keeps every header line a webhook carries
 * (`maxHeadersCount = 0`, D187), and Node's parser keeps every line of a head
 * still arriving, as strings, until the head ends or its connection closes:
 * about 24 bytes a line at the least, 16,320 lines in Node's 16 KiB. 512
 * connections from one address, each stalled after 16,000 one-byte lines,
 * held 182 to 197 MiB of the 512 MiB backend, and two addresses ran it out of
 * memory (D227, D228's S9). A chunked body's trailer section is parsed and
 * kept the same way, up to the same 16 KiB, so its lines count too.
 *
 * Two parts, each pure so that it can be tested without a socket, which
 * `pipelining.ts`, the layer that already gives Node's parser each
 * connection's bytes a slice at a time (D229), puts together:
 *
 * - `scanLines` follows a connection's bytes through the framing of its
 *   requests - a head, a body of declared length, a chunked body and its
 *   trailers - and tells how many of them the parser may be given now: up to
 *   the end of a head, since what follows depends on what Node made of it,
 *   up to the end of a message, and up to the first line there is no room
 *   for. A line is counted from its first byte, so a connection with no room
 *   has none of its next line parsed. The CR LF of the empty line that ends a
 *   head or trailer section is not a line. Bytes of a body, chunk sizes and
 *   the CR LF after a chunk are not lines: a body of newlines counts nothing.
 *   CR and LF before a request line, which Node's parser skips, are not lines
 *   either.
 * - `createHeaderLineBudget` counts the lines each connection holds, per
 *   address and per process, and wakes connections that wait for room, first
 *   come first served.
 *
 * Who is never held: the oldest holder of lines of an address - and a
 * connection of an address holding none - by the address's number, and the
 * oldest holder of the process - and a connection while none holds any - by
 * the process's. So a webhook with the most lines Node allows is never held
 * by its own size, and someone always has room: the oldest holder can always
 * end its head, and when it does the next is the oldest. A connection of an
 * address holding none still waits for the process's room, which only floods
 * from more addresses than the numbers are chosen for fill.
 */
import type { IncomingMessage } from 'node:http';
import {
  MAX_HEADER_LINES_IN_FLIGHT,
  MAX_HEADER_LINES_IN_FLIGHT_PER_ADDRESS,
} from '@webhook-inspector/shared';

const LF = 0x0a;
const CR = 0x0d;

/**
 * Where the bytes stand inside a head or trailer section: at the start of a
 * line; after a CR that began a line, which only the empty line ending the
 * section may (Node's parser refuses any other); or inside a line.
 */
export type LineState = 'start' | 'cr' | 'inside';

/** Where a connection's bytes stand in the framing of its requests. */
export type Framing =
  /** A request head; `started` once its first byte that is not CR or LF has come. */
  | { readonly kind: 'head'; readonly started: boolean; readonly line: LineState }
  /** A head has ended; what follows is known once Node's parser has read it. */
  | { readonly kind: 'after-head' }
  /** A body of declared length, `remaining` bytes of it. */
  | { readonly kind: 'body'; readonly remaining: number }
  /** A chunk's size line: the size so far, and whether its hex digits have ended. */
  | { readonly kind: 'chunk-size'; readonly size: number; readonly sized: boolean }
  /** A chunk's data, `remaining` bytes of it. */
  | { readonly kind: 'chunk-data'; readonly remaining: number }
  /** The CR LF after a chunk's data. */
  | { readonly kind: 'chunk-end' }
  /** The trailer section after the last chunk. */
  | { readonly kind: 'trailers'; readonly line: LineState };

/** Before a request's head: the connection's start, and the end of every message. */
export const NEXT_HEAD: Framing = Object.freeze({ kind: 'head', started: false, line: 'start' });

/** The start of a chunked body. */
const CHUNKED: Framing = Object.freeze({ kind: 'chunk-size', size: 0, sized: false });

export interface Scan {
  /** How many bytes, from `from`, the parser may be given now. */
  length: number;
  /** The header or trailer lines begun in them. */
  lines: number;
  /** What ends with them: a request head, a whole message, or neither. */
  ends: 'head' | 'message' | null;
  /** Where the bytes stand after them. */
  framing: Framing;
  /** Cut before a line `allowance` had no room for: the connection waits. */
  waits: boolean;
}

function hexDigit(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) {
    return byte - 0x30;
  }

  const lower = byte | 0x20;

  return lower >= 0x61 && lower <= 0x66 ? lower - 0x61 + 10 : -1;
}

/**
 * How many of `bytes`, from `from` up to `to`, the parser may be given now,
 * the bytes before `from` having left the connection at `framing`, with room
 * for `allowance` more lines (`Infinity` for no bound): up to the end of the
 * head they finish, the end of the message they finish, or the start of the
 * first line beyond `allowance`, whichever comes first; else all of them.
 * Pure: the caller commits the answer's `framing` once the bytes have been
 * given. In `after-head` nothing may be given until the caller has set the
 * body's framing from the request Node read (`framingAfterHead`).
 */
export function scanLines(
  bytes: Buffer,
  from: number,
  to: number,
  framing: Framing,
  allowance: number,
): Scan {
  let at = from;
  let lines = 0;
  let state = framing;

  const result = (ends: Scan['ends'], waits: boolean): Scan => ({
    length: at - from,
    lines,
    ends,
    framing: state,
    waits,
  });

  // Through a head's or a trailer section's lines from `at`, which stands at
  // `line`: until the LF of the empty line that ends them, the start of a
  // line `allowance` has no room for, or `to`.
  const walk = (start: LineState): { line: LineState; outcome: 'ended' | 'waits' | null } => {
    let line = start;

    for (;;) {
      if (line === 'cr') {
        if (at >= to) {
          return { line, outcome: null };
        }

        if (bytes[at] === LF) {
          at += 1;

          return { line: 'start', outcome: 'ended' };
        }

        // A line that begins with CR and goes on, which Node's parser
        // refuses: read on to its LF like any line's inside.
      } else if (line === 'start') {
        if (at >= to) {
          return { line, outcome: null };
        }

        if (bytes[at] === CR) {
          line = 'cr';
          at += 1;
          continue;
        }

        if (lines >= allowance) {
          return { line, outcome: 'waits' };
        }

        lines += 1;
      }

      // Inside a line: on to its LF.
      const lf = bytes.indexOf(LF, at);

      if (lf === -1 || lf >= to) {
        at = to;

        return { line: 'inside', outcome: null };
      }

      at = lf + 1;
      line = 'start';
    }
  };

  while (at < to) {
    switch (state.kind) {
      case 'head': {
        let line = state.line;

        if (!state.started) {
          while (at < to && (bytes[at] === CR || bytes[at] === LF)) {
            at += 1;
          }

          if (at >= to) {
            return result(null, false);
          }

          if (lines >= allowance) {
            return result(null, true);
          }

          // The request line.
          lines += 1;
          line = 'inside';
        }

        const walked = walk(line);

        if (walked.outcome === 'ended') {
          state = { kind: 'after-head' };

          return result('head', false);
        }

        state = { kind: 'head', started: true, line: walked.line };

        return result(null, walked.outcome === 'waits');
      }
      case 'trailers': {
        const walked = walk(state.line);

        if (walked.outcome === 'ended') {
          state = NEXT_HEAD;

          return result('message', false);
        }

        state = { kind: 'trailers', line: walked.line };

        return result(null, walked.outcome === 'waits');
      }
      case 'body': {
        const taken = Math.min(state.remaining, to - at);

        at += taken;

        if (taken === state.remaining) {
          state = NEXT_HEAD;

          return result('message', false);
        }

        state = { kind: 'body', remaining: state.remaining - taken };
        break;
      }
      case 'chunk-size': {
        let { size, sized } = state;
        let ended = false;

        while (at < to) {
          const byte = bytes[at] as number;

          if (byte === LF) {
            at += 1;
            ended = true;
            break;
          }

          if (!sized) {
            const digit = hexDigit(byte);

            if (digit >= 0) {
              size = size * 16 + digit;
              at += 1;
              continue;
            }

            sized = true;
          }

          // An extension, or the CR: on to the LF.
          const lf = bytes.indexOf(LF, at);

          at = lf === -1 || lf >= to ? to : lf;
        }

        if (!ended) {
          state = { kind: 'chunk-size', size, sized };
        } else if (size === 0) {
          // The last chunk: its trailer section follows.
          state = { kind: 'trailers', line: 'start' };
        } else {
          state = { kind: 'chunk-data', remaining: size };
        }

        break;
      }
      case 'chunk-data': {
        const taken = Math.min(state.remaining, to - at);

        at += taken;
        state =
          taken === state.remaining
            ? { kind: 'chunk-end' }
            : { kind: 'chunk-data', remaining: state.remaining - taken };
        break;
      }
      case 'chunk-end': {
        const lf = bytes.indexOf(LF, at);

        if (lf === -1 || lf >= to) {
          at = to;
        } else {
          at = lf + 1;
          state = CHUNKED;
        }

        break;
      }
      case 'after-head':
        return result(null, false);
    }
  }

  return result(null, false);
}

/**
 * What follows a head Node's parser has just read, from the request it made
 * of it: the next head when the request is already complete, having no body;
 * a chunked body for any `Transfer-Encoding`, which Node's parser takes from
 * a request only when chunked comes last; else a body of the length its one
 * `Content-Length` declares. `null` when none of these fits, which Node's
 * parser would not have let through.
 */
export function framingAfterHead(request: IncomingMessage): Framing | null {
  if (request.complete) {
    return NEXT_HEAD;
  }

  if (request.headers['transfer-encoding'] !== undefined) {
    return CHUNKED;
  }

  const declared = request.headers['content-length'];

  if (declared === undefined || !/^\d+$/.test(declared) || Number(declared) === 0) {
    return null;
  }

  return { kind: 'body', remaining: Number(declared) };
}

/** One connection's account of the lines it has in flight. */
export interface LineAccount {
  /** Lines it has in flight now. */
  readonly lines: number;
  /** How many more lines it may begin now; `Infinity` when it is not bounded. */
  allowance(): number;
  /** Counts `count` more lines, `0` included, and ends its wait, if any. */
  take(count: number): void;
  /** Gives back every line it has: the head or trailer section they were in has ended. */
  giveBack(): void;
  /**
   * Waits for room, `want` being how many lines it has waiting, at least 1;
   * a connection that already waits keeps its place. It is woken, once, when
   * room comes.
   */
  wait(want: number): void;
  /** Its connection has closed or been handed on: everything given back, and no more waiting. */
  close(): void;
}

export interface HeaderLineBudget {
  /** The lines an address's connections may have in flight together. */
  readonly perAddress: number;
  /** The lines all connections may have in flight together. */
  readonly perProcess: number;
  /** Lines in flight now. Exists for tests and diagnostics. */
  readonly lines: number;
  /** Lines in flight now of the address `key`. Exists for tests and diagnostics. */
  linesOf(key: string): number;
  /** Addresses holding lines or waiting now. Exists for tests and diagnostics. */
  readonly addresses: number;
  /** Connections waiting for room now. Exists for tests and diagnostics. */
  readonly waiting: number;
  /** An account for a connection of the address `key`; `wake` is called when it may go on. */
  open(key: string, wake: () => void): LineAccount;
}

export interface HeaderLineBudgetOptions {
  /** Absent, `MAX_HEADER_LINES_IN_FLIGHT_PER_ADDRESS`, 32,768. */
  perAddress?: number;
  /** Absent, `MAX_HEADER_LINES_IN_FLIGHT`, 524,288. */
  perProcess?: number;
}

interface Entry {
  key: string;
  lines: number;
  /** Has `want` lines waiting, in the queue. */
  waiting: boolean;
  /** Woken and not yet gone on: passed over until it goes on or waits again. */
  woken: boolean;
  want: number;
  closed: boolean;
  wake: () => void;
}

interface Address {
  lines: number;
  /** Its holders of lines, oldest first. */
  holders: Set<Entry>;
  /** Its connections waiting. */
  waiting: number;
}

function oldest(holders: Set<Entry>): Entry | undefined {
  return holders.values().next().value;
}

/**
 * The count of header lines in flight, per address and per process, and the
 * connections waiting for room, first come first served. One a receive
 * listener: the process's.
 *
 * Room is looked at whenever lines are given back or a connection waiting
 * leaves: the waiting connections are walked in the order they first waited,
 * and each that has room is woken, as many as the room freed is enough for
 * by what each has waiting - a connection woken goes on before any other
 * connection's next read, Node running what is due on the next turn first.
 * Once those woken have gone on, the room is looked at again, so that room a
 * woken connection did not use - it could not go on, or wanted less - wakes
 * the next. A connection that finds no room once woken waits again in the
 * place it had.
 */
export function createHeaderLineBudget(options: HeaderLineBudgetOptions = {}): HeaderLineBudget {
  const perAddress = options.perAddress ?? MAX_HEADER_LINES_IN_FLIGHT_PER_ADDRESS;
  const perProcess = options.perProcess ?? MAX_HEADER_LINES_IN_FLIGHT;

  for (const [name, value] of [
    ['perAddress', perAddress],
    ['perProcess', perProcess],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`The header-line budget needs ${name} of at least 1, not ${value}`);
    }
  }

  const addresses = new Map<string, Address>();
  const holders = new Set<Entry>();
  const queue = new Set<Entry>();
  let lines = 0;
  let passDue = false;
  let againDue = false;

  const addressOf = (key: string): Address => {
    let address = addresses.get(key);

    if (address === undefined) {
      address = { lines: 0, holders: new Set(), waiting: 0 };
      addresses.set(key, address);
    }

    return address;
  };

  // An address is kept only while it holds lines or has a connection waiting.
  const forget = (key: string): void => {
    const address = addresses.get(key);

    if (address !== undefined && address.holders.size === 0 && address.waiting === 0) {
      addresses.delete(key);
    }
  };

  /**
   * The lines `entry` may begin, with `taken` more already promised in this
   * walk to those woken before it, of its address and of the process, and
   * the free place of an address or the process holding none given already
   * when `firstGiven` says so.
   */
  const room = (
    entry: Entry,
    taken: { address: number; process: number },
    firstGiven: { address: boolean; process: boolean },
  ): { lines: number; addressFirst: boolean; processFirst: boolean } => {
    const address = addresses.get(entry.key);
    const addressHolders = address?.holders.size ?? 0;
    const addressFirst = entry.lines === 0 && addressHolders === 0 && !firstGiven.address;
    const processFirst = entry.lines === 0 && holders.size === 0 && !firstGiven.process;
    const addressFree =
      addressFirst ||
      (entry.lines > 0 && address !== undefined && oldest(address.holders) === entry);
    const processFree = processFirst || (entry.lines > 0 && oldest(holders) === entry);
    const byAddress = addressFree
      ? Number.POSITIVE_INFINITY
      : perAddress - (address?.lines ?? 0) - taken.address;
    const byProcess = processFree ? Number.POSITIVE_INFINITY : perProcess - lines - taken.process;

    return {
      lines: Math.max(0, Math.min(byAddress, byProcess)),
      addressFirst,
      processFirst,
    };
  };

  const pass = (): void => {
    passDue = false;

    if (queue.size === 0) {
      return;
    }

    const takenBy = new Map<string, number>();
    const firstOf = new Set<string>();
    let taken = 0;
    let processFirstGiven = false;
    let woke = false;

    for (const entry of queue) {
      if (entry.woken) {
        continue;
      }

      const allowed = room(
        entry,
        { address: takenBy.get(entry.key) ?? 0, process: taken },
        { address: firstOf.has(entry.key), process: processFirstGiven },
      );

      if (allowed.lines < 1) {
        continue;
      }

      const share = Math.min(allowed.lines, entry.want);

      if (allowed.addressFirst) {
        firstOf.add(entry.key);
      }

      if (allowed.processFirst) {
        processFirstGiven = true;
      }

      takenBy.set(entry.key, (takenBy.get(entry.key) ?? 0) + share);
      taken += share;
      entry.woken = true;
      woke = true;
      entry.wake();
    }

    // Once those woken have gone on, room they did not use wakes the next.
    if (woke && !againDue) {
      againDue = true;
      setImmediate(() => {
        againDue = false;
        pass();
      });
    }
  };

  const schedule = (): void => {
    if (!passDue && queue.size > 0) {
      passDue = true;
      process.nextTick(pass);
    }
  };

  const unqueue = (entry: Entry): void => {
    if (!entry.waiting) {
      return;
    }

    entry.waiting = false;
    entry.woken = false;
    queue.delete(entry);

    const address = addresses.get(entry.key);

    if (address !== undefined) {
      address.waiting -= 1;
    }

    forget(entry.key);
  };

  const giveBack = (entry: Entry): void => {
    if (entry.lines === 0) {
      return;
    }

    const address = addresses.get(entry.key);

    lines -= entry.lines;
    holders.delete(entry);

    if (address !== undefined) {
      address.lines -= entry.lines;
      address.holders.delete(entry);
    }

    entry.lines = 0;
    forget(entry.key);
    schedule();
  };

  return {
    perAddress,
    perProcess,
    get lines() {
      return lines;
    },
    linesOf(key) {
      return addresses.get(key)?.lines ?? 0;
    },
    get addresses() {
      return addresses.size;
    },
    get waiting() {
      return queue.size;
    },
    open(key, wake) {
      const entry: Entry = {
        key,
        lines: 0,
        waiting: false,
        woken: false,
        want: 1,
        closed: false,
        wake,
      };

      return {
        get lines() {
          return entry.lines;
        },
        allowance() {
          return entry.closed
            ? 0
            : room(entry, { address: 0, process: 0 }, { address: false, process: false }).lines;
        },
        take(count) {
          if (entry.closed) {
            return;
          }

          unqueue(entry);

          if (count <= 0) {
            return;
          }

          const address = addressOf(key);

          if (entry.lines === 0) {
            holders.add(entry);
            address.holders.add(entry);
          }

          entry.lines += count;
          address.lines += count;
          lines += count;
        },
        giveBack() {
          giveBack(entry);
        },
        wait(want) {
          if (entry.closed) {
            return;
          }

          entry.want = Math.max(1, want);
          entry.woken = false;

          if (!entry.waiting) {
            entry.waiting = true;
            queue.add(entry);
            addressOf(key).waiting += 1;
          }
        },
        close() {
          if (entry.closed) {
            return;
          }

          const wasWoken = entry.woken;

          entry.closed = true;
          unqueue(entry);
          giveBack(entry);

          // Room promised to it in a walk goes to the next.
          if (wasWoken) {
            schedule();
          }
        },
      };
    },
  };
}
