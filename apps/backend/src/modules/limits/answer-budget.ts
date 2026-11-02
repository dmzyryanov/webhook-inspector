/**
 * The bytes of the answers of `/api` and `/mcp` not yet written (#184, D228's
 * amendment): at most `API_ANSWER_PER_ADDRESS_BYTES`, 16 MiB, for one address
 * and `API_ANSWER_BYTES`, 64 MiB, for the process, beside the 128 calls an
 * address may have in flight (D213), in the shape of the capture's waiting
 * line (D228).
 *
 * The calls in flight bound how many calls an address holds, not what their
 * answers weigh, and a place goes back once its answer has been handed to the
 * connection: a client that reads only the head of each answer leaves the
 * rest in the server, about 1 MiB a session with a full queue, and two such
 * addresses with 128 each ran the 512 MiB backend out of memory (D228's S8).
 * So an answer is counted by its body's bytes, as serialized, from that
 * moment until its response closes - the moment D213 gives its call's place
 * back: once the answer has been written whole, or its connection has gone,
 * however it went. An answer that would take its address past 16 MiB, or the
 * process past 64 MiB, while its address already has another answer counted
 * is not sent: the call is answered `429` / `1019` with `Retry-After: 1`
 * instead, by the route's own error handler - the API's error body, `/mcp`'s
 * JSON-RPC error - and nothing else of it changes: what the call did is done.
 * The address's first answer counted is always sent, whatever its size, so no
 * answer is refused for its own size; so the process's bound is soft, by at
 * most one answer of each address holding exactly one.
 *
 * What is counted, and what is not:
 * - every answer of a call that D213 counts - a route of `/api`, an unmatched
 *   path under `/api`, `/mcp` itself - whose body is a string or bytes, as
 *   Fastify serialized it: the size is known there, so 128 calls admitted at
 *   once on an empty budget do not all pass;
 * - an answer with an error status, `400` and above - the replacement `1019`
 *   among them - is counted too but never refused: replacing one refusal with
 *   another frees nothing, and a refusal could otherwise be refused itself;
 * - a `HEAD`'s answer counts nothing: it writes no body;
 * - a streamed answer - a list or a query with `include` - counts nothing: its
 *   size is not known before it is written, it is produced only as fast as its
 *   client reads it, and those with bodies are bounded by the four places of
 *   lists with bodies (D201);
 * - a call held by `wait` holds nothing until its answer is serialized;
 * - an answer counted is handed on as bytes, so that the server keeps of it
 *   while it is unwritten what is counted, not a string's worst-case copy;
 * - the receive host, the realtime connection, the probes and every path
 *   outside `/api` and `/mcp` are never counted.
 *
 * The count lives in the process, as the calls in flight do (D221). An
 * address is kept only while it has an answer counted.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_ANSWER_BYTES, API_ANSWER_PER_ADDRESS_BYTES } from '@webhook-inspector/shared';
import { answersNotWritten } from '../../errors/app-error.ts';

/** Which bound an answer would have passed. */
export type AnswerLimit = 'address' | 'server';

/** What an answer offered to the budget is told. */
export type AnswerAdmission =
  | {
      sent: true;
      /** Gives the answer's bytes back; giving them back twice gives them back once. */
      release: () => void;
    }
  | { sent: false; limit: AnswerLimit };

/** The answers not yet written of one process, per address and in all. Pure, so it is tested without a server. */
export interface AnswerBudget {
  /**
   * Counts an answer of `bytes` for `key`, unless `key` already has an answer
   * counted and this one would take `key` past `perAddress` or the process
   * past `total`: then it counts nothing and says which. The first answer of
   * a key is always counted.
   */
  admit(key: string, bytes: number): AnswerAdmission;
  /**
   * Counts an answer of `bytes` for `key` whatever the budget holds, and
   * answers with what gives it back: a refusal, which is never refused.
   */
  count(key: string, bytes: number): () => void;
  /** Bytes counted now for `key`. Exists for tests and diagnostics. */
  bytesOf(key: string): number;
  /** Answers counted now for `key`. Exists for tests and diagnostics. */
  answersOf(key: string): number;
  /** Bytes counted now, every key together. Exists for tests and diagnostics. */
  readonly bytes: number;
  /** Answers counted now, every key together. Exists for tests and diagnostics. */
  readonly answers: number;
  /** Keys with an answer counted now. Exists for tests and diagnostics. */
  readonly keys: number;
  readonly perAddress: number;
  readonly total: number;
}

interface Held {
  bytes: number;
  answers: number;
}

/** A budget of `perAddress` bytes a key and `total` in all; production's unless a test passes its own. */
export function createAnswerBudget(
  perAddress: number = API_ANSWER_PER_ADDRESS_BYTES,
  total: number = API_ANSWER_BYTES,
): AnswerBudget {
  const held = new Map<string, Held>();
  let bytes = 0;
  let answers = 0;

  function take(key: string, size: number): () => void {
    const entry = held.get(key);

    if (entry === undefined) {
      held.set(key, { bytes: size, answers: 1 });
    } else {
      entry.bytes += size;
      entry.answers += 1;
    }

    bytes += size;
    answers += 1;

    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      bytes -= size;
      answers -= 1;

      const own = held.get(key);

      if (own === undefined) {
        return;
      }

      own.bytes -= size;
      own.answers -= 1;

      if (own.answers === 0) {
        held.delete(key);
      }
    };
  }

  function checked(size: number): number {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new RangeError(`an answer weighs a whole number of bytes, not ${size}`);
    }

    return size;
  }

  return {
    admit(key, size) {
      checked(size);

      const entry = held.get(key);

      if (entry !== undefined) {
        if (entry.bytes + size > perAddress) {
          return { sent: false, limit: 'address' };
        }

        if (bytes + size > total) {
          return { sent: false, limit: 'server' };
        }
      }

      return { sent: true, release: take(key, size) };
    },
    count(key, size) {
      return take(key, checked(size));
    },
    bytesOf(key) {
      return held.get(key)?.bytes ?? 0;
    },
    answersOf(key) {
      return held.get(key)?.answers ?? 0;
    },
    get bytes() {
      return bytes;
    },
    get answers() {
      return answers;
    },
    get keys() {
      return held.size;
    },
    perAddress,
    total,
  };
}

/** The bytes of an answer's body as Fastify serialized it; `null` for a stream or anything else not yet bytes. */
function bodyBytes(payload: unknown): number | null {
  if (typeof payload === 'string') {
    return Buffer.byteLength(payload);
  }

  if (Buffer.isBuffer(payload)) {
    return payload.length;
  }

  return payload === undefined || payload === null ? 0 : null;
}

/**
 * Counts the answers of `app`'s calls that `isCall` names in `budget`, under
 * the address `keyOf` gives - the one their calls in flight count under - and
 * refuses one that does not fit: `onSend`, after the answer is serialized and
 * before a byte of it is written, throwing `answersNotWritten` for the route's
 * error handler to answer, whose answer then passes here again, counted and
 * never refused (an error status). Registered on the root before any route,
 * after which no hook changes an answer's body but a `HEAD`'s, which writes
 * none. An answer counted and then replaced - a later `onSend` hook threw -
 * gives its bytes back as its replacement comes here. A string answer counted
 * goes on as its UTF-8 bytes, which the connection keeps as they are while it
 * cannot take them, where it would keep a string as a copy of three bytes a
 * character.
 */
export function countAnswers(
  app: FastifyInstance,
  budget: AnswerBudget,
  isCall: (request: FastifyRequest) => boolean,
  keyOf: (request: FastifyRequest) => string,
): void {
  const counted = new WeakMap<FastifyRequest, () => void>();

  app.addHook('onSend', async (request, reply, payload) => {
    const earlier = counted.get(request);

    if (earlier !== undefined) {
      counted.delete(request);
      reply.raw.removeListener('close', earlier);
      earlier();
    }

    if (request.method === 'HEAD' || !isCall(request)) {
      return;
    }

    const size = bodyBytes(payload);

    // Nothing to count, a stream, or a response already closed - its client
    // gone - to which nothing will be written.
    if (size === null || size === 0 || reply.raw.destroyed) {
      return;
    }

    const key = keyOf(request);
    let release: () => void;

    if (reply.statusCode >= 400) {
      release = budget.count(key, size);
    } else {
      const admission = budget.admit(key, size);

      if (!admission.sent) {
        throw answersNotWritten(
          admission.limit,
          admission.limit === 'address' ? budget.perAddress : budget.total,
        );
      }

      release = admission.release;
    }

    counted.set(request, release);
    reply.raw.once('close', release);

    // Handed to the connection as its bytes, so that what the server keeps
    // of it while it is unwritten is what is counted. A string the socket
    // cannot take at once is kept as a copy sized for the worst case of its
    // encoding, three bytes a character: measured with S8 from 4 addresses,
    // 56 answers counted at 56 MiB held about 170 MiB of the process's
    // memory until their clients went (#184). Bytes are kept as they are.
    return typeof payload === 'string' ? Buffer.from(payload, 'utf8') : undefined;
  });
}
