/**
 * The bound on the requests one connection to the receive listener has read
 * and not yet answered (#181, D229).
 *
 * Node's HTTP server parses whatever one read of a connection delivers in one
 * go. A sender pipelining minimal `GET`s fills a 64 KiB read with about 736
 * of them, and every one becomes a request and its response before any check
 * of the application's can run - and each is then kept, answered or not,
 * behind the first: a connection's answers go out in order, and a delayed
 * session holds the first for up to 30 s. About 6.6 KiB a request: 256 such
 * connections from one address held some 188,000 of them and ran the 512 MiB
 * backend out of heap (series S4, D228). A check made from a request's own
 * handling - destroying the socket, pausing it, Node's `maxRequestsPerSocket`
 * - comes after the whole read has been parsed, so none bounded it (D228).
 *
 * So the bytes of a connection reach Node's parser here, a slice at a time,
 * and only while fewer than `limit` of its requests are unanswered. Every
 * request head Node's parser counts ends with the same three bytes, `LF CR
 * LF` - the line feed that ends its last line and the CR LF of the empty
 * line after it (`HEAD_END`) - so a slice is cut just before the byte that
 * would end one head more than are still free, and can complete no more than
 * that, whatever else it holds: a body, a header block of any length or a
 * run of the shortest requests. Bytes of a body that happen to read `LF CR
 * LF` only make a slice shorter. A connection therefore never has more than
 * `limit` requests read and unanswered, and a long header block or a body
 * is still parsed in slices as long as the read that carried it, as before.
 * What a sender pipelines beyond them stays unread - the rest of one read in
 * the socket's own buffer, and the kernel's and the sender's buffers behind
 * it - and is read as the earlier ones are answered. Nothing is refused, and
 * the answers keep their order: the bytes are Node's to parse, in the order
 * they came.
 *
 * Bytes dense in `LF CR LF` - a body of nothing else, or of empty CRLF
 * lines, one every two bytes - would be cut into slices of a few bytes each
 * once few requests are free, each a call into Node's parser and each a
 * piece of the body Node keeps apart (#181's round 1: 32 connections each
 * pipelining 30 delayed `GET`s and a 1 MiB body of them left 1.4 million
 * pieces, 280 MiB of heap, unread). So two things hold them to what Node's
 * own parsing costs, or near it:
 *
 * - The pieces of a body Node's parser gives a request while one read is
 *   parsed are pushed into the request's stream as one, once the read has
 *   been parsed or the body has ended: one piece a read, as Node pushed
 *   them, however many slices the read took (`request.push`, through which
 *   Node delivers a body, is wrapped for it).
 * - A slice the cut would make shorter than `MIN_SLICE_BYTES`, short of the
 *   read's end, is not parsed while more than one of the connection's
 *   requests is unanswered: the connection waits for an answer instead, as
 *   at the count. Only the newest unanswered request can still be arriving,
 *   the parser having moved past every other, so an earlier one is always
 *   answered without reading on, and nothing waits for ever. With one
 *   request unanswered, the one still arriving, at least `limit - 1` are
 *   free, and a cut slice holds that many ends of a head, two bytes apart at
 *   the closest: 62 bytes or more at 32, one call into the parser for every
 *   62 bytes at worst rather than for every 3.
 *
 * A request counts from the moment Node's parser has read its head to the
 * moment its whole answer has been handed to the connection - Node's own
 * `http.server.request.start` and `http.server.response.finish` diagnostic
 * channels, which Node publishes for every request it reads, the ones it
 * answers itself (a missing `Host`) included, and not only for those it
 * hands to the application. A client that never reads its answers therefore
 * holds at most `limit` of them: an answer not yet handed to the kernel is
 * not answered.
 *
 * How it is done, and what of Node's own it relies on, each held by
 * `pipelining.test.ts` against the Node the backend runs on:
 *
 * - Every head Node counts ends in `LF CR LF`: Node's parser takes no line
 *   end without its line feed, and no empty line without its CR.
 * - Node's parser makes no request of the HTTP/2 preface's `PRI` line: it
 *   holds the head while it waits for the rest of the preface, and refuses
 *   the connection with `400` whatever follows, a request included, right
 *   after the head or after the rest of the preface (#277, #288).
 * - Node's server reads a connection through the `data` listener its
 *   connection handler adds, and the handler lets its parser read the socket
 *   natively unless another `data` listener is added. That listener is taken
 *   off and called here with each slice instead, and this one added in its
 *   place, which makes the parser read through it. Node's handler also adds a
 *   `pause` and a `resume` listener that stop and start the socket's reads at
 *   once, which adding the listener takes off; they are put back, so that a
 *   socket stopped by anyone is stopped at once, as before.
 * - Node's parser hands a request its body with the request stream's `push`.
 * - The socket's read-ahead is set to nothing (`highWaterMark` 0), so that a
 *   stopped connection reads nothing more, not 64 KiB ahead: what is left of
 *   a read is put back in front of the socket, and nothing more is read
 *   until it has been parsed. A request's body stream, which Node makes with
 *   its socket's read-ahead, is given Node's own back as it starts, so that
 *   a body nobody reads yet stops its socket where it did before.
 * - A read is parsed whole, as Node's parser parses it, unless the bound
 *   stops it or Node stops it for answers it has not written (its own
 *   `_paused`, which its `data` listener asserts is not set, its parser
 *   stopping too). Any other stop - a body nobody reads yet, the capture
 *   budget's guard for a webhook waiting for its place (D210) - takes effect
 *   from the next read. Nothing more is parsed once Node has handed the
 *   connection on: an upgrade, or a `CONNECT`, which the receive listener
 *   refuses by closing the connection.
 * - The bound stops the connection with `pause()` like everyone else, and
 *   starts it again only while the stop is still its own: a `pause` it did
 *   not make - Node's, a body's, the capture budget's guard's - can only
 *   come once the connection has been started since, so the stop is then
 *   that one's, and its maker starts it. A connection started by anyone else
 *   while at the count is stopped again, as Node's own `resume` listener
 *   does for its `_paused`.
 * - A webhook waiting for its place keeps its connection stopped whoever
 *   stopped it: the capture budget's guard holds the connection while any
 *   webhook of it waits (`holdStopped`), and the bound starts a connection it
 *   stopped only once nothing holds it - the answer of a request before the
 *   webhook no longer starts it (D210).
 * - The application's own handling of a request runs once the read that
 *   carried it has been parsed, as it always did for the first read behind a
 *   PROXY header, which Node read through its `data` listener - not between
 *   its head and its body, as on a connection Node's parser read natively,
 *   where Node then started a connection the capture budget's guard had just
 *   stopped once the request had ended. So a webhook that arrived whole and
 *   waits for its place keeps its connection stopped on every connection,
 *   as it did behind a PROXY header: its sender's departure is not seen
 *   while it waits, and it is stored once its place comes (D187).
 *
 * Should a later Node add its `data` listener differently, the connection is
 * left as Node set it up, unbounded as before, and one line is logged at
 * `error`.
 *
 * The same slices carry the bound on header lines in flight (#182, D238,
 * `header-lines.ts`): a slice also ends where a request head or a message
 * ends, and before the first line of a head or a chunked body's trailer
 * section that the sender address's or the process's budget has no room
 * for. The connection then waits, stopped like the bound's own stop, the rest
 * of its read put back, until the budget wakes it; the lines of a head are
 * given back once Node's parser has read its end, and all of a connection's
 * when it closes or is handed on. The body's framing after a head is taken
 * from the request Node's parser has just made of it, and each slice is
 * checked against what Node's parser did. The check relies on Node's
 * parser refusing whatever the framing cannot follow, and on what it does
 * with the head a sender can send that it neither refuses nor makes a
 * request of, the HTTP/2 preface's `PRI` line: it holds the head while it
 * waits for the rest of the preface, then refuses with `400` whatever
 * follows, a request included, as `pipelining.test.ts` holds (#277, #288).
 * Such a head is no disagreement: its lines are given back, nothing is
 * logged, and the connection is read uncounted from there on, as before
 * #182: what follows reaches Node's parser at once, never held for room, so
 * that its answer is the same whatever room the sender's address has, and
 * nothing can hold lines there, Node's parser refusing whatever follows
 * such a head. Any other disagreement is therefore Node's doing, not a
 * sender's: the connection's lines are given back, it is read uncounted, as
 * before #182, and one line is logged at `error`. The bytes Node's parser
 * drops behind a request asking to upgrade, when they reach it in the call
 * that ends that request, would be another head it makes no request of;
 * the slice ends with the request here, so Node's parser reads them as the
 * next one. Of a request only whether it is complete is kept once it is:
 * the bound holds no request, nor its head, that Node's parser and its
 * answer are done with, however long its connection is kept alive
 * afterwards.
 */
import { subscribe } from 'node:diagnostics_channel';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import { MAX_PIPELINED_REQUESTS } from '@webhook-inspector/shared';
import { addressKey } from '../limits/rate-limit.ts';
import {
  createHeaderLineBudget,
  framingAfterHead,
  NEXT_HEAD,
  scanLines,
  type Framing,
  type HeaderLineBudget,
  type LineAccount,
  type Scan,
} from './header-lines.ts';

/**
 * The three bytes every request head Node's parser counts ends with: the
 * line feed ending its last line - the request line's, or a header's - and
 * the CR LF of the empty line that ends the head. `GET /` with them, 8
 * bytes, is the shortest head Node counts, an HTTP/0.9 request.
 */
export const HEAD_END = Buffer.from('\n\r\n', 'latin1');

/**
 * The shortest slice cut short of a read's end that the parser is given
 * while more than one of the connection's requests is unanswered; a shorter
 * one waits for an answer. Two pipelined requests longer than 64 bytes each,
 * 65 or more, pass it with a single request free, the slice being both less
 * one byte, so ordinary pipelining is read as before; bytes dense in
 * `LF CR LF` do not until the connection is down to one unanswered request.
 */
export const MIN_SLICE_BYTES = 128;

const LF = 0x0a;
const CR = 0x0d;

/**
 * How many bytes of `bytes`, from `start`, the parser may be given so that no
 * more than `free` request heads can end in them: up to, not including, the
 * last byte of the `free + 1`-th `LF CR LF`, or all of them when there are
 * not that many. `previous` is the last two bytes given to the parser before
 * `start`, oldest first (`-1` for none), since a head may end in the first
 * two bytes. `free` is at least 1, so the answer is at least 1 when any
 * bytes are left.
 */
export function sliceLength(
  bytes: Buffer,
  start: number,
  free: number,
  previous: readonly [number, number],
): number {
  let ends = 0;
  // Ends that begin before `start`: at `start` (`LF CR` before it) and at
  // `start + 1` (`LF` before it).
  const atStart = previous[0] === LF && previous[1] === CR && bytes[start] === LF;
  const atNext = previous[1] === LF && bytes[start] === CR && bytes[start + 1] === LF;

  for (const [straddles, end] of [
    [atStart, start],
    [atNext, start + 1],
  ] as const) {
    if (straddles) {
      ends += 1;

      if (ends > free) {
        return end - start;
      }
    }
  }

  for (let at = bytes.indexOf(HEAD_END, start); at !== -1; at = bytes.indexOf(HEAD_END, at + 1)) {
    ends += 1;

    if (ends > free) {
      return at + HEAD_END.length - 1 - start;
    }
  }

  return bytes.length - start;
}

/**
 * How many bytes of `bytes`, from `start`, the parser is given now, with
 * `unfinished` of the connection's requests read and not yet answered, or 0
 * for none until one of them has been answered: none at the count; else the
 * slice `sliceLength` allows, unless it is cut short of the read's end,
 * shorter than `MIN_SLICE_BYTES`, while more than one request is unanswered.
 */
export function nextSlice(
  bytes: Buffer,
  start: number,
  unfinished: number,
  limit: number,
  previous: readonly [number, number],
): number {
  if (unfinished >= limit) {
    return 0;
  }

  const length = sliceLength(bytes, start, limit - unfinished, previous);
  const cut = start + length < bytes.length;

  return cut && length < MIN_SLICE_BYTES && unfinished > 1 ? 0 : length;
}

/** A readable stream's read-ahead, which Node keeps in its state. */
interface ServedStream {
  _readableState: { highWaterMark: number };
}

/** What Node's HTTP server keeps on a connection it serves, which the bound reads. */
interface ServedSocket extends Socket, ServedStream {
  /** Node's stop for answers it has not yet written (`_http_server.js`). */
  _paused?: boolean;
  /** The connection's parser; another, or none, once Node has handed it on. */
  parser?: unknown;
}

type Push = IncomingMessage['push'];

/** The pieces of one request's body given to it while the read is parsed. */
interface HeldBody {
  request: IncomingMessage;
  /** The request's own `push`, which delivers them. */
  push: Push;
  pieces: Buffer[];
  length: number;
}

/** One connection's count, and what its slices need to know. */
interface Pipeline {
  /** Requests read and not yet answered. */
  unfinished: number;
  /** The last two bytes given to the parser, oldest first; `-1` for none. */
  previous: [number, number];
  /** The connection's stop is the bound's own, so it starts it again. */
  stopped: boolean;
  /** A start is due on the next turn. */
  starting: boolean;
  /** Holders that keep the bound from starting the connection (`holdStopped`). */
  holds: number;
  /** A read is being parsed. */
  parsing: boolean;
  /** Body pieces given while the read is parsed, not yet pushed. */
  body: HeldBody | null;
  /** Requests Node's parser has read on the connection (#182). */
  requests: number;
  /**
   * The latest of them, kept only while its lines are counted and it is not
   * complete, for the framing to be checked against; let go of at the first
   * look that finds it complete, and whenever the connection stops being
   * counted or closes, so that the bound never keeps a request Node's
   * parser and its answer are done with (#182, D238).
   */
  latest: IncomingMessage | null;
  /** The latest request Node's parser has read is complete. */
  latestComplete: boolean;
  /** The header lines are counted: the bytes' framing is being followed (#182). */
  counting: boolean;
  /** Where the bytes given so far leave the framing of the connection's requests. */
  framing: Framing;
  /** Stopped until the header-line budget has room for its next line (#182). */
  waitingForLines: boolean;
  onRequest(request: IncomingMessage): void;
  onAnswered(): void;
  /** Starts the connection on the next turn if the stop is the bound's and nothing keeps it. */
  startSoon(): void;
}

const pipelines = new WeakMap<Socket, Pipeline>();
let subscribed = false;

/**
 * Node publishes these for every server of the process; only the connections
 * bounded here are counted, the others found in no map.
 */
function subscribeOnce(): void {
  if (subscribed) {
    return;
  }

  subscribed = true;
  subscribe('http.server.request.start', (message) => {
    const { request, socket } = message as { request: IncomingMessage; socket: Socket };

    pipelines.get(socket)?.onRequest(request);
  });
  subscribe('http.server.response.finish', (message) => {
    const { socket } = message as { socket: Socket };

    pipelines.get(socket)?.onAnswered();
  });
}

/**
 * Keeps the bound from starting `socket` again, should it stop it, until the
 * answer is called: an answer to an earlier request then no longer starts
 * it, and once the last holder lets go the bound starts it if it is below its
 * count. The capture budget's guard holds a connection while a webhook
 * pipelined on it waits for its place, so that it is read again only once
 * none waits (D210, D229); a stop that is the guard's own it starts itself.
 * Nothing to hold on a connection the bound does not read.
 */
export function holdStopped(socket: Socket): () => void {
  const pipeline = pipelines.get(socket);

  if (pipeline === undefined) {
    return () => undefined;
  }

  let held = true;

  pipeline.holds += 1;

  return () => {
    if (held) {
      held = false;
      pipeline.holds -= 1;
      pipeline.startSoon();
    }
  };
}

export interface PipelineBoundOptions {
  /**
   * At most this many requests a connection, read and not yet answered; at
   * least 2, since a connection whose only unanswered request is still
   * arriving must be read on for it to be answered.
   */
  limit?: number;
  /**
   * The header lines in flight, per sender address and per process (#182,
   * D238). Absent, the bound keeps its own, of the shared package's numbers;
   * a test passes one to look at it, or one of its own size.
   */
  headerLines?: HeaderLineBudget;
  /**
   * The sender address of a connection, read once its PROXY header, if any,
   * has been: the header's with PROXY protocol on, the socket peer's without.
   * Absent, the socket peer's. Keyed by `addressKey`, an IPv6 address by its
   * `/64` and an IPv4-mapped one as its IPv4.
   */
  addressOf?: (socket: Socket) => string | undefined;
  log: FastifyBaseLogger;
}

/**
 * Puts the bound in front of an HTTP server's own handling of every
 * connection, before the server listens; the PROXY protocol layer, put in
 * front afterwards, hands each connection to it once its header has been
 * read (D187). Every `connection` listener the server has is called first,
 * as before, and the connection then read through the bound.
 */
export function boundPipelinedRequests(server: Server, options: PipelineBoundOptions): void {
  const limit = options.limit ?? MAX_PIPELINED_REQUESTS;
  const handlers = server.listeners('connection') as ((socket: Socket) => void)[];
  const lineBudget = options.headerLines ?? createHeaderLineBudget();
  const addressOf = options.addressOf ?? ((socket: Socket) => socket.remoteAddress);
  let unboundedLogged = false;
  let uncountedLogged = false;

  if (!Number.isInteger(limit) || limit < 2) {
    throw new Error(`The pipelining bound needs a limit of at least 2, not ${limit}`);
  }

  if (handlers.length === 0) {
    throw new Error('The HTTP server has no connection listener to bound the pipelining of');
  }

  subscribeOnce();
  server.removeAllListeners('connection');

  server.on('connection', (raw: Socket) => {
    const socket = raw as ServedSocket;
    const before = {
      data: socket.listeners('data'),
      pause: socket.listeners('pause'),
      resume: socket.listeners('resume'),
    };

    for (const handler of handlers) {
      handler.call(server, socket);
    }

    const added = (event: 'data' | 'pause' | 'resume'): ((...args: unknown[]) => void)[] =>
      (socket.listeners(event) as ((...args: unknown[]) => void)[]).filter(
        (listener) => !before[event].includes(listener),
      );
    const parsers = added('data');
    const parser = socket.parser;

    if (parsers.length !== 1 || parser === undefined || socket.destroyed) {
      if (!socket.destroyed && !unboundedLogged) {
        unboundedLogged = true;
        options.log.error(
          { dataListeners: parsers.length },
          'Receive connections read without the pipelining bound: Node set them up otherwise',
        );
      }

      return;
    }

    const parse = parsers[0] as (chunk: Buffer) => void;
    const stopNow = added('pause');
    const startNow = added('resume');
    // What a request's body stream reads ahead, as Node gives it: its
    // socket's, before the socket's is set to nothing below.
    const bodyReadAhead = socket._readableState.highWaterMark;
    // Set while the bound itself stops the connection, so that its `pause`
    // listener tells its own stop from anyone else's.
    let stopping = false;

    // The body pieces held while the read was parsed, pushed as one. When
    // the push answers false - the body is not being read and holds its
    // read-ahead - the connection is stopped, as Node's parser stops it
    // then: a stop that is not the bound's.
    const pushHeld = (): void => {
      const held = pipeline.body;

      if (held === null) {
        return;
      }

      pipeline.body = null;

      const whole =
        held.pieces.length === 1
          ? (held.pieces[0] as Buffer)
          : Buffer.concat(held.pieces, held.length);

      if (!held.push.call(held.request, whole) && !socket.destroyed) {
        socket.pause();
      }
    };

    const pipeline: Pipeline = {
      unfinished: 0,
      previous: [-1, -1],
      stopped: false,
      starting: false,
      holds: 0,
      parsing: false,
      body: null,
      requests: 0,
      latest: null,
      latestComplete: false,
      counting: true,
      framing: NEXT_HEAD,
      waitingForLines: false,
      onRequest(request) {
        pipeline.requests += 1;
        pipeline.latest = pipeline.counting ? request : null;
        pipeline.latestComplete = false;

        // Node made the body stream from the socket's read-ahead, now
        // nothing; given back Node's own, so that a body nobody reads yet
        // stops its socket where it did before (D210), not at its first part.
        (request as unknown as ServedStream)._readableState.highWaterMark = bodyReadAhead;

        // Node's parser hands a body to its request with `push`, a piece for
        // every slice a read was cut into: held while the read is parsed and
        // pushed as one, as Node pushed a read's piece of a body. The end of
        // the body, and anything outside a parse, goes through at once,
        // after what is held. What a held piece answers is what Node's
        // parser would have heard had it been pushed.
        const push = request.push;

        request.push = function pushPiece(chunk: unknown, encoding?: BufferEncoding): boolean {
          if (pipeline.parsing && Buffer.isBuffer(chunk)) {
            if (pipeline.body !== null && pipeline.body.request !== request) {
              pushHeld();
            }

            const held = (pipeline.body ??= { request, push, pieces: [], length: 0 });

            held.pieces.push(chunk);
            held.length += chunk.length;

            // As `push` answers: true for a body being read, which takes
            // each piece at once, else whether it holds less than its
            // read-ahead.
            return (
              (request.readableFlowing === true &&
                request.readableLength === 0 &&
                request.listenerCount('data') > 0) ||
              request.readableLength + held.length < request.readableHighWaterMark
            );
          }

          pushHeld();

          return push.call(request, chunk, encoding);
        };

        pipeline.unfinished += 1;

        if (pipeline.unfinished >= limit) {
          stop();
        }
      },
      onAnswered() {
        pipeline.unfinished -= 1;
        pipeline.startSoon();
      },
      startSoon() {
        // A turn later: an answer's finish runs inside Node's own handling
        // of it, before it has moved to the next.
        if (
          pipeline.stopped &&
          !pipeline.starting &&
          !pipeline.waitingForLines &&
          pipeline.unfinished < limit &&
          pipeline.holds === 0
        ) {
          pipeline.starting = true;
          process.nextTick(start);
        }
      },
    };

    // The connection's header lines in flight (#182, D238), counted under
    // its sender's address, which the PROXY layer has read by now. Woken when
    // the budget has room for a connection waiting for it.
    const account: LineAccount = lineBudget.open(addressKey(addressOf(socket)), () => {
      pipeline.waitingForLines = false;
      pipeline.startSoon();
    });

    // Stopped by the bound, unless it is stopped already: by somebody else,
    // who starts it, `resume` below stopping it again while at the count.
    const stop = (): void => {
      if (!socket.isPaused()) {
        pipeline.stopped = true;
        stopping = true;

        try {
          socket.pause();
        } finally {
          stopping = false;
        }
      }
    };

    // Started only while the stop is still the bound's - see the `pause`
    // listener below - and nothing holds it.
    const start = (): void => {
      pipeline.starting = false;

      if (
        pipeline.stopped &&
        !pipeline.waitingForLines &&
        pipeline.unfinished < limit &&
        pipeline.holds === 0 &&
        !socket.destroyed
      ) {
        pipeline.stopped = false;
        socket.resume();
      }
    };

    // The lines are no longer counted on this connection, which is read as
    // before #182, its lines given back and its wait for room, if any,
    // ended.
    const readUncounted = (): void => {
      pipeline.counting = false;
      pipeline.waitingForLines = false;
      pipeline.latest = null;
      account.close();
    };

    // Node's parser makes no request of a head it holds - the HTTP/2
    // preface's `PRI` line - and refuses whatever follows it, as it refuses
    // whatever else the framing cannot follow (`pipelining.test.ts`). Such a
    // head, which a sender can send, is no disagreement and never comes
    // here (`settle`, #277). What comes here - what Node's parser made of
    // the bytes is not what the framing followed - is then Node's doing,
    // not a sender's: the connection is read uncounted, and one line is
    // logged at `error`.
    const stopCounting = (reason: string): void => {
      readUncounted();

      if (!uncountedLogged) {
        uncountedLogged = true;
        options.log.error(
          { reason },
          'Receive connection read without the header-line bound: its requests could not be followed',
        );
      }
    };

    // Stopped until the budget has room for the next line, the rest of the
    // read put back in front of the socket. What it has waiting is
    // estimated as the most lines the bytes could begin, one in 4 bytes -
    // `a:` and its CR LF, the shortest line Node's parser takes - so that
    // room freed wakes no more connections than it is enough for.
    const waitForLines = (chunk: Buffer, offset: number): void => {
      pipeline.waitingForLines = true;
      account.wait(Math.ceil((chunk.length - offset) / 4));
      stop();
      socket.unshift(chunk.subarray(offset));
    };

    // After a slice: the lines of a head or trailer section that has ended
    // given back, and the framing taken on - for a head, from the request
    // Node's parser has just made of it - and checked against what Node's
    // parser did: a request begins only when a head ends, and is complete
    // exactly when its message ends. A head may end with no request begun,
    // when Node's parser holds it without making one (#277); one request,
    // and no more, may begin with it. The latest request is looked at here
    // and nowhere else: once it is complete, that fact is all that is kept,
    // and the request is let go of - on a kept-alive connection, which may
    // wait long for its next request, it would otherwise outlive what Node
    // keeps of it, the whole of its head with it (#182, D238).
    const settle = (scanned: Scan, requestsBefore: number): void => {
      const latest = pipeline.latest;

      if (latest !== null && latest.complete) {
        pipeline.latest = null;
        pipeline.latestComplete = true;
      }

      if (socket.destroyed) {
        pipeline.latest = null;

        return;
      }

      if (socket.parser !== parser) {
        account.close();
        pipeline.counting = false;
        pipeline.latest = null;

        return;
      }

      const began = pipeline.requests - requestsBefore;
      const complete = pipeline.latestComplete;

      if (scanned.ends === 'head') {
        account.giveBack();

        // A head Node's parser holds without making a request of it - the
        // HTTP/2 preface's `PRI` line, held while it waits for the rest of
        // the preface and then refused with `400` whatever follows - is a
        // sender's doing, as any malformed request Node's parser refuses
        // is, not a disagreement: nothing is logged (#277). Its lines are
        // given back as every head's, and the connection is read uncounted
        // from here on, as before #182, so that what follows reaches Node's
        // parser at once and is refused as before, whatever room its
        // address has: counted, it would wait for room as the next head's
        // first line, and be answered Node's 408 at its `headersTimeout`
        // instead of the 400 once the address's lines were all in flight.
        // Nothing can hold lines uncounted there: Node's parser refuses
        // whatever follows such a head, a request included.
        if (began === 0) {
          readUncounted();

          return;
        }

        const next = began === 1 && latest !== null ? framingAfterHead(latest) : null;

        if (next === null) {
          stopCounting(
            began === 1
              ? 'a head whose body could not be told'
              : 'a head Node read as more than one request',
          );
        } else {
          pipeline.framing = next;
        }

        return;
      }

      if (scanned.ends === 'message') {
        account.giveBack();

        if (began !== 0 || !complete) {
          stopCounting('a message Node did not end');
        } else {
          pipeline.framing = scanned.framing;
        }

        return;
      }

      const inMessage = scanned.framing.kind !== 'head';

      if (began !== 0 || (inMessage && complete)) {
        stopCounting('a request Node read elsewhere');
      } else {
        pipeline.framing = scanned.framing;
      }
    };

    const onData = (chunk: Buffer): void => {
      let offset = 0;

      pipeline.parsing = true;

      try {
        while (offset < chunk.length) {
          if (socket.destroyed) {
            return;
          }

          // Handed on (an upgrade): the rest is the new owner's, in order.
          if (socket.parser !== parser) {
            socket.removeListener('data', onData);
            pipelines.delete(socket);
            pipeline.latest = null;
            account.close();
            socket.unshift(chunk.subarray(offset));

            return;
          }

          // At the count, a short slice while others are unanswered, or
          // stopped by Node for answers it has not written (its parser stops
          // then too): the rest of the read goes back in front of the
          // socket, which reads nothing more until it is started. Any other
          // stop - a body nobody reads yet, the capture budget's guard -
          // takes effect from the next read, as with Node's own parser,
          // which parses a read whole. The count is looked at itself, not
          // the socket's stop: a parse can start the socket again (a body
          // being read) before its `resume` event has stopped it.
          const nodeStopped = socket._paused === true;
          const length = nodeStopped
            ? 0
            : nextSlice(chunk, offset, pipeline.unfinished, limit, pipeline.previous);

          if (length === 0) {
            if (!nodeStopped) {
              stop();
            }

            socket.unshift(chunk.subarray(offset));

            return;
          }

          // No further than the end of a head or of a message, nor than the
          // first header line the budget has no room for (#182): none of
          // that line is parsed while the connection waits for room.
          const scanned = pipeline.counting
            ? scanLines(chunk, offset, offset + length, pipeline.framing, account.allowance())
            : null;

          if (scanned !== null && scanned.length === 0) {
            if (scanned.waits) {
              waitForLines(chunk, offset);

              return;
            }

            stopCounting('bytes the framing could not place');
            continue;
          }

          const given = scanned === null ? length : scanned.length;
          const slice = chunk.subarray(offset, offset + given);
          const requestsBefore = pipeline.requests;

          offset += given;
          pipeline.previous =
            given >= 2
              ? [slice[given - 2] as number, slice[given - 1] as number]
              : [pipeline.previous[1], slice[0] as number];

          if (scanned !== null) {
            account.take(scanned.lines);
          }

          parse(slice);

          if (scanned !== null && pipeline.counting) {
            settle(scanned, requestsBefore);
          }
        }
      } finally {
        pipeline.parsing = false;
        pushHeld();
      }
    };

    socket.removeListener('data', parse);
    socket._readableState.highWaterMark = 0;
    pipelines.set(socket, pipeline);
    // However it closes - by either side, a reset, a timeout of Node's - its
    // lines are given back, its wait for room ends and its latest request is
    // let go of.
    socket.once('close', () => {
      pipeline.latest = null;
      account.close();
    });
    // Node's wrapper of `on` stops its parser reading the socket natively
    // here, and takes its `pause` and `resume` listeners off with it.
    socket.on('data', onData);

    for (const listener of stopNow) {
      if (!socket.listeners('pause').includes(listener)) {
        socket.on('pause', listener);
      }
    }

    for (const listener of startNow) {
      if (!socket.listeners('resume').includes(listener)) {
        socket.on('resume', listener);
      }
    }

    // A stream emits `pause` only when it was reading, so a stop that is not
    // the bound's means the connection was started since the bound stopped
    // it: the stop is now its maker's, who starts it again, and the bound's
    // start a turn later must not.
    socket.on('pause', () => {
      if (!stopping) {
        pipeline.stopped = false;
      }
    });

    socket.on('resume', () => {
      if (pipeline.unfinished >= limit && !socket.destroyed) {
        stop();
      }
    });
  });
}
