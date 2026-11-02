/**
 * How a list with content is written (D196).
 *
 * The list statement reads the requests' metadata alone. What `include` adds
 * is read while the answer is written: one request at a time with its body,
 * 50 at a time with headers alone. A body, at most 1 MiB stored (D008), is
 * written as JSON in pieces of 16 Ki characters before escaping, so a piece
 * is about 96 KiB at most even where JSON escapes every character as six
 * (`\u0001`). The answer is a stream read only as fast as the client takes
 * it, so an answer holds about one request's content at a time: its stored
 * body, that body as text or Base64, and the piece being written - not the
 * 20 bodies, their text and a request's whole JSON that reading every body
 * first held, which made eight such answers at once outgrow the backend's
 * 512 MiB (measured in D196).
 *
 * A request the list chose may be gone by the time its content is read:
 * deleted, pushed out by the newest 1000, cleared. It is not written, and
 * when the answer has a `limit` and the requests chosen filled it, the list
 * resumes after the last one it chose - by that request's position, kept at
 * the microsecond, whether it is still there or not - for as many as are
 * missing, under the same conditions and order (`ListMore`), and again if
 * some of those are gone too. So an answer is short of `limit` only where no
 * request follows: a client paging until the answer is empty is never told
 * the list has ended because requests vanished while it was written. It
 * resumes `MAX_RESUMPTIONS` times at most, and is cut off unfinished past
 * that, as when a resumption fails.
 *
 * Once the stream is destroyed - Fastify destroys it when the response closes
 * before the answer ends, a client gone included, and the list route destroys
 * a `HEAD`'s before it is read at all, so that nothing is read for a body no
 * one gets (#210) - nothing more is read and the list is not resumed: the
 * writing ends at the next step, not at the next piece, which a list whose
 * requests keep vanishing would never reach.
 *
 * An answer with content whose client has gone before it is begun - before
 * its list statement or while it ran, its response destroyed by then - is not
 * begun at all: nothing is read or written, and the call is logged once, at
 * `info`, as D174 logs a client that gave up (#212). Sent, its stream would
 * be destroyed at once, and on the query, whose request Node does not count
 * as aborted once its body has arrived, Fastify would pass that to the error
 * handler, which logs a request that arrived whole as an `Unhandled error`.
 *
 * The plain list, with no `include`, is answered as it always was, one JSON
 * body with its `Content-Length`; an answer with content goes out chunked.
 */
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { FastifyReply } from 'fastify';
import type { RequestListEntry } from '@webhook-inspector/shared';
import { NO_PLACE, releaseWhenAnswered } from './body-lists.ts';
import type { ListQuery } from './list-query.ts';
import type { ListedContent, ListPosition } from './repository.ts';
import { transportBytes } from './transport.ts';

/** A request the list chose, with where it stands in receipt order. */
export interface ListedEntry {
  entry: RequestListEntry;
  /** `received_at` as stored, to the microsecond (`ListPosition`). */
  receivedAt: string;
}

/**
 * Reads what `include` asks for of the listed requests `requestIds`, by id. A
 * request gone since the list was read is absent from the map.
 */
export type ReadListedContent = (
  requestIds: readonly string[],
) => Promise<ReadonlyMap<string, ListedContent>>;

/**
 * The requests that follow `beyond` in the list's order, at most `count`,
 * chosen as the list chose its own: same session, conditions, `after`,
 * `since` and order. Metadata alone.
 */
export type ListMore = (beyond: ListPosition, count: number) => Promise<ListedEntry[]>;

/** Requests whose content one read fetches when it holds a body: one. */
const BODY_BATCH = 1;

/**
 * Requests whose content one read fetches when it is headers alone. Node
 * refuses request headers over 16 KiB, so a batch is at most 800 KiB stored.
 */
const HEADERS_BATCH = 50;

/** UTF-16 code units of a body written in one piece, before JSON escapes them. */
export const BODY_PIECE_UNITS = 16 * 1024;

/**
 * Times one answer resumes its list at most (D196 point 7). A resumption
 * takes up beyond the last request chosen, so one fills the places of
 * requests deleted or cleared while the answer was written, and the next few
 * those of the replacements gone too, as when an answer listed oldest first
 * meets a burst of captures that pushes out the oldest. A list that still
 * loses requests after five is losing them as fast as it reads them, and
 * would go on choosing - on the query route each time in a slot and under a
 * fresh timeout - without writing anything. So an answer runs six list
 * statements at most, and reads the content of six times `limit` requests.
 */
export const MAX_RESUMPTIONS = 5;

const EMPTY = Buffer.alloc(0);

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * `text` as the inside of a JSON string, escaped as `JSON.stringify` escapes
 * it, or as it is when `escape` is false, for Base64. The pieces are made of
 * `BODY_PIECE_UNITS` code units, or one more where a piece would otherwise end
 * between the two halves of a surrogate pair: `JSON.stringify` would write
 * each half as an escape, which is the same text but not the bytes it writes
 * for the whole string.
 */
function* jsonStringPieces(text: string, escape: boolean): Generator<string> {
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + BODY_PIECE_UNITS, text.length);

    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
      end += 1;
    }

    const piece = text.slice(start, end);

    // Base64 holds nothing JSON escapes.
    yield escape ? JSON.stringify(piece).slice(1, -1) : piece;
    start = end;
  }
}

/**
 * One request of the answer, as `JSON.stringify` writes the entry with its
 * content added in the order the fields are declared: the metadata, then
 * `headers`, then `body`, `bodyBase64` and `isBinary` under the detail's rule,
 * text when the body is valid UTF-8 and Base64 when it is not (D043).
 */
function* entryPieces(
  entry: RequestListEntry,
  content: ListedContent,
  query: ListQuery,
  separator: string,
): Generator<string> {
  // The metadata without its closing brace, so that the content follows it.
  let head = `${separator}${JSON.stringify(entry).slice(0, -1)}`;

  if (query.includeHeaders) {
    head += `,"headers":${JSON.stringify(content.headers ?? [])}`;
  }

  if (!query.includeBody) {
    yield `${head}}`;

    return;
  }

  const body = transportBytes(content.body ?? EMPTY);

  if (body.text !== null) {
    yield `${head},"body":"`;
    yield* jsonStringPieces(body.text, true);
    yield '","bodyBase64":null,"isBinary":false}';
  } else {
    yield `${head},"body":null,"bodyBase64":"`;
    yield* jsonStringPieces(body.base64 ?? '', false);
    yield '","isBinary":true}';
  }
}

/**
 * The JSON array of `chosen` with what `query` includes, read through
 * `readContent` only when the piece before has been taken. A request whose
 * content is no longer there is not written, and the requests that follow
 * the chosen ones take its place through `more` (module comment).
 *
 * The list resumes only when all of these hold: the answer has a `limit` -
 * without one the list chose every request there was; the requests last
 * chosen were as many as were asked for - fewer means none followed them
 * then; and the answer still holds fewer than `limit`, which after a full
 * choice means some of it was gone. Each resumption starts strictly beyond
 * the last request chosen, so the list only moves forward, and it ends where
 * nothing follows. A resumed choice holds at most what the answer has room
 * for, so the metadata held is the first choice and the current one, each at
 * most `limit` entries. Past `MAX_RESUMPTIONS` the stream fails instead.
 *
 * Before each content read and each resumption the stream is checked: once it
 * is destroyed the generator returns. It must, rather than leave it to the
 * stream: `Readable.from` stops a generator only when it next yields, and one
 * whose requests are all gone reads and resumes without yielding.
 */
export function jsonArrayStream(
  chosen: readonly ListedEntry[],
  query: ListQuery,
  readContent: ReadListedContent,
  more: ListMore,
): Readable {
  const batchSize = query.includeBody ? BODY_BATCH : HEADERS_BATCH;

  async function* pieces(isDestroyed: () => boolean): AsyncGenerator<string> {
    let written = 0;
    let page = chosen;
    let asked = query.limit;
    let resumptions = 0;

    yield '[';

    for (;;) {
      for (let start = 0; start < page.length; start += batchSize) {
        if (isDestroyed()) {
          return;
        }

        const batch = page.slice(start, start + batchSize);
        const content = await readContent(batch.map(({ entry }) => entry.id));

        for (const { entry } of batch) {
          const found = content.get(entry.id);

          if (found !== undefined) {
            for (const piece of entryPieces(entry, found, query, written === 0 ? '' : ',')) {
              yield piece;
              // Back to the event loop after every piece (D201). A socket
              // that takes each write at once calls the stream back within
              // the same turn, so without this an answer could write a whole
              // body, 6 MiB escaped, before any other request was read: four
              // such answers held every capture for a second.
              await nextTurn();
            }

            written += 1;
          }
        }
      }

      const last = page.at(-1);

      if (
        query.limit === null ||
        asked === null ||
        last === undefined ||
        page.length < asked ||
        written >= query.limit
      ) {
        break;
      }

      if (isDestroyed()) {
        return;
      }

      if (resumptions === MAX_RESUMPTIONS) {
        // Thrown, so the answer is cut off rather than closed short.
        throw new Error(
          `the list was resumed ${MAX_RESUMPTIONS} times and requests it chose were still gone`,
        );
      }

      resumptions += 1;
      asked = query.limit - written;
      // Never more than asked for, so the answer never holds more than `limit`.
      page = (await more({ receivedAt: last.receivedAt, id: last.entry.id }, asked)).slice(
        0,
        asked,
      );
    }

    yield ']';
  }

  // Bytes, not objects, with a high-water mark of one byte (`Readable.from`'s
  // own): a piece is made, and the next content read, only once the piece
  // before has been taken. The generator starts at the first read, by when
  // `stream` is assigned.
  const stream: Readable = Readable.from(
    pieces(() => stream.destroyed),
    { objectMode: false },
  );

  return stream;
}

/**
 * Answers a list: as a plain JSON body without `include`, streamed with it,
 * its content read through `readContent` as it is written and the list
 * resumed through `more` where chosen requests are gone.
 *
 * `release` gives back the place an answer with bodies took (D201), once the
 * answer is over (`releaseWhenAnswered`); an answer that took none passes
 * `NO_PLACE`.
 *
 * With its client gone, an answer with content is not begun (module comment):
 * the reply is hijacked, as for a call whose client left while `wait` held
 * it, so that Fastify writes nothing and logs no line of its own.
 */
export function sendList(
  reply: FastifyReply,
  chosen: ListedEntry[],
  query: ListQuery,
  readContent: ReadListedContent,
  more: ListMore,
  release: () => void = NO_PLACE,
): FastifyReply | RequestListEntry[] {
  if (!query.includeHeaders && !query.includeBody) {
    release();

    return chosen.map(({ entry }) => entry);
  }

  if (reply.raw.destroyed) {
    // Given back on the response's close already; giving it back again is a no-op.
    release();
    reply.log.info('Request aborted by the client');

    return reply.hijack();
  }

  const stream = jsonArrayStream(chosen, query, readContent, more);

  releaseWhenAnswered(stream, release);

  return reply.type('application/json; charset=utf-8').send(stream);
}
