/**
 * The request log: Fastify's `incoming request` and `request completed`
 * lines, with D117's serializer and D059's redaction, but none for a call a
 * per-address limit refuses (issue #189, D201's note).
 *
 * Fastify writes `incoming request` before any hook runs, and a refusal is
 * decided after it: by the limits' `onRequest` hook for the API, and for
 * `/mcp` once its body has said which count the call goes to (D203). So the
 * line of a call the limits count waits, held, until the call's verdict. It
 * is written as soon as the call is let through, or as soon as anything else
 * is logged of it, before that line - its `request completed`, an abort, an
 * error - and dropped if the call is refused. A refused call's lines at
 * `info` are dropped too: its `request completed`, and the abort line of one
 * whose client left while its body was drained (D143). A line at `warn` or
 * above is written whatever the verdict: it reports a fault, not traffic.
 *
 * Why: a refusal should cost the backend as little as it can. One address
 * sending session creations far over its limit had the backend write two
 * lines for each of hundreds of refusals a second, its 0.5 CPU used up and
 * its liveness probe unanswered (the incident of 2026-10-15); the lines were
 * measured at about a tenth of a refusal's CPU (D201's note). No line of
 * the request log names the client's address either way: it names the peer
 * the process talks to (D117), and the one line that names an address is
 * the limits' own, written once a window for an address refused past the
 * limit itself (#215, `modules/limits/rate-limit.ts`).
 *
 * Every line of a listener passes `writes` first, from the logger's
 * `logMethod` hook (`createApp`), keyed by the request's own logger, which
 * Fastify makes for each request. Both maps are weak, so a request leaves
 * nothing behind, whatever its end.
 */
import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';

/** Pino's level of `warn`: a line at it or above is written for a refused call too. */
const WARN = 40;

export class RequestLog extends LogController {
  /** The calls whose `incoming request` waits for their verdict, by their logger. */
  readonly #held = new WeakMap<object, { request: FastifyRequest; reply: FastifyReply }>();
  /** The loggers of the calls a limit refused. */
  readonly #refused = new WeakSet<object>();
  /** Which requests a limit decides on; none until the limits say (`holdFor`). */
  #holds: (request: FastifyRequest) => boolean = () => false;

  /**
   * From now on, the `incoming request` of a request `holds` names waits for
   * `admit` or `refuse`: those of the calls the per-address limits count
   * (`registerRateLimits`). The receive listener's log holds none.
   */
  holdFor(holds: (request: FastifyRequest) => boolean): void {
    this.#holds = holds;
  }

  override incomingRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    metadata?: Record<string, unknown>,
  ): void {
    if (this.#holds(request)) {
      this.#held.set(request.log, { request, reply });

      return;
    }

    super.incomingRequest(request, reply, metadata);
  }

  /**
   * The call was let through, or will be answered without a verdict - a URL
   * the router refuses runs no hook: its `incoming request`, if held, is
   * written now.
   */
  admit(request: FastifyRequest): void {
    this.#release(request.log);
  }

  /** The call's answer is its refusal by a limit: no line at `info` is written of it. */
  refuse(request: FastifyRequest): void {
    this.#held.delete(request.log);
    this.#refused.add(request.log);
  }

  /**
   * Whether a line at `level` on `logger` is written, asked before each one:
   * a held `incoming request` of the same request is written first, and a
   * refused call's lines below `warn` are not.
   */
  writes(logger: object, level: number): boolean {
    this.#release(logger);

    return level >= WARN || !this.#refused.has(logger);
  }

  #release(logger: object): void {
    const held = this.#held.get(logger);

    if (held !== undefined) {
      this.#held.delete(logger);
      super.incomingRequest(held.request, held.reply);
    }
  }
}
