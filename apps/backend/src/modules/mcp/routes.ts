/**
 * `/mcp` on the application listener (D203): MCP's Streamable HTTP transport,
 * stateless. Every `POST` carries one JSON-RPC message and is answered with
 * one JSON object, or `202` with no body for a notification or a response;
 * there is no MCP session id and no stream, so every other method is `405`.
 * The transport uses no query string either: a URL that carries one is
 * refused `400` on every method, before the body is read and before the
 * method's `405`. Not on the receive listener, whose `/mcp` is the not-found
 * route's `404` / `1000` like any path outside `/s/`.
 *
 * Every request to `/mcp` takes a place among its address's calls in flight
 * as it arrives, before its query string is looked at and before its body is
 * read, shared with the API: 128 at once, the next refused `429` with
 * `errorCode` `1019` and `id` `null`, `403` for a forbidden `Origin` (D213).
 * A `POST` with a body over 128 KiB, or chunked, takes one of the API's eight
 * places of large bodies too, until its message is read, refused `429` /
 * `1017` in the same form with none free; every other method is `405` before
 * its body is read (D213).
 *
 * Every request to `/mcp` is counted once against the API's per-address
 * limits (D201): a `tools/call` of `create_session` toward the session
 * creations, everything else - any other method, a notification, a request
 * refused for its query string, its size, its `Content-Type`, its `Origin`,
 * its `Accept`, its body or its protocol version - toward the other calls.
 * Which of the two only the body says, so the count is taken once the body,
 * at most 1 MiB, has arrived and the transport's checks have let it through,
 * and before any database work; a request refused before the count is
 * counted toward the other calls as it is answered, whatever its body asks
 * for.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { ErrorCode } from '@webhook-inspector/shared';
import {
  MCP_INSTRUCTIONS,
  MCP_PATH,
  MCP_PROTOCOL_VERSIONS,
  MCP_SERVER_NAME,
  MCP_SERVER_TITLE,
  mcpTools,
  type McpToolDefinition,
} from '@webhook-inspector/shared/mcp';
import { AppError } from '../../errors/app-error.ts';
import { connectionEndedBeforeBody } from '../../lib/connection.ts';
import type { RateLimits } from '../limits/rate-limit.ts';
import type { RealtimeHub } from '../realtime/hub.ts';
import { clientGone } from '../requests/routes.ts';
import type { QuerySlots } from '../requests/search.ts';
import type { PendingWaits } from '../requests/wait.ts';
import { requestKey } from '../sessions/access-key.ts';
import type { LargeBodyHandling } from '../sessions/large-bodies.ts';
import { isJsonDeclared } from '../sessions/media-type.ts';
import { drainRequestBody, shouldDrainRefusedBody } from '../sessions/refused-body.ts';
import { errorResult } from './captured.ts';
import {
  acceptsJson,
  declaredProtocolVersion,
  hasQueryString,
  isAllowedOrigin,
  isCreateSessionCall,
  negotiateProtocolVersion,
  parseMessage,
  rawHeaderValues,
  rpcError,
  RpcErrorCode,
  rpcResult,
  type ParsedMessage,
  type RpcId,
} from './protocol.ts';
import { apiErrorText, isToolName, readCall, runCall, type ToolCall } from './tools.ts';

/**
 * The product version, which `initialize` reports as the server's: the API
 * description's `info.version`, which equals `VERSION` (D154). The backend
 * image copies the description in for this.
 */
export const SERVER_VERSION = (
  JSON.parse(
    readFileSync(new URL('../../../../../packages/shared/openapi.json', import.meta.url), 'utf8'),
  ) as { info: { version: string } }
).info.version;

export interface McpRouteOptions {
  pool: pg.Pool;
  hub: RealtimeHub;
  /** The list's pending waits, shared with the API, which a shutdown runs out (D200). */
  waits: PendingWaits;
  /** The places of searches and queries, shared with the API (D191, D250). */
  querySlots: QuerySlots;
  searchTimeoutMs: number;
  /** The listener's two counters (D201). */
  limits: RateLimits;
  /**
   * The places of large bodies, shared with the seven JSON routes of the API
   * (D205, D213): a `POST` with a body over 128 KiB, or chunked, takes one
   * before it is read.
   */
  largeBody: LargeBodyHandling;
  receiveOrigin: string;
  /** The application's own origin: the inspector links, and an `Origin` let in. */
  appOrigin: string;
  /**
   * The application's second origin, `APP_ALIAS_ORIGIN` (D275): the other
   * `Origin` let in, and nothing more. `null` or absent, none.
   */
  appAliasOrigin?: string | null;
}

/** A refusal of the transport, with no id: the request is not answered as a call. */
function refuse(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.status(status).send(rpcError(null, RpcErrorCode.SERVER_ERROR, message));
}

const FORBIDDEN_ORIGIN = 'Forbidden: the Origin header names a site that may not use this endpoint';

/** The refusal of a URL with a query string: fixed, quoting nothing of the URL. */
export const QUERY_STRING_REFUSED = 'Bad Request: this endpoint takes no query string';

/** The id of a message the server answers, or `null` for one it does not. */
function idOf(message: ParsedMessage | null): string | number | null {
  return message !== null && message.kind === 'request' ? message.id : null;
}

/**
 * The id of each request whose message has been read, kept beside the request
 * and gone with it: an answer the answers' byte budget refuses once it is
 * ready (#184) is refused under its request's id, the call having been read
 * and run.
 */
const requestIds = new WeakMap<FastifyRequest, RpcId>();

/**
 * The message a request's body holds, or `null` for a body not declared JSON.
 * Either way the body is taken off the request first, so nothing that keeps
 * the request - a `wait_for_request` holds it for up to 30 s - keeps the up to
 * 1 MiB it came in (D203).
 */
function readMessage(request: FastifyRequest, declaredJson: boolean): ParsedMessage | null {
  const body = Buffer.isBuffer(request.body) ? request.body : undefined;

  request.body = undefined;

  return declaredJson ? parseMessage(body) : null;
}

/**
 * What the synchronous part of a `POST` comes to: a refusal, answered before
 * the call's turn in the gate (D244) - a reply already sent, or a JSON-RPC
 * object to send; a message the count let through that the server answers
 * itself, in its turn (`accepted`); or a tool call to run in its turn, with
 * the id its answer echoes and whether it is a `wait_for_request`.
 */
type Opened =
  | { answer: FastifyReply | Record<string, unknown> }
  | { accepted: () => FastifyReply | Record<string, unknown> }
  | { id: RpcId; call: ToolCall; waits: boolean };

/**
 * The synchronous part of a `POST`: the transport's checks, the count, the
 * method, and for a `tools/call` its tool, and its arguments read and checked
 * (`readCall`). A function of its own, not in the handler: the handler waits
 * while a call runs, and whatever it held in a local - the parsed message, its
 * `params`, its `arguments` - would be held as long, up to 30 s for a
 * `wait_for_request`. What this answers keeps nothing of the message but the
 * id, the server's own copy, and the call, which keeps only what its checks
 * built (D203).
 */
function openCall(
  request: FastifyRequest,
  reply: FastifyReply,
  limits: RateLimits,
  appOrigin: string,
  appOrigins: readonly string[],
  tools: readonly McpToolDefinition[],
): Opened {
  const rawHeaders = request.raw.rawHeaders;
  const message = readMessage(request, isJsonDeclared(rawHeaders));

  // Every refusal up to the count is counted by `onSend`, toward the other
  // calls (D203).
  if (!isAllowedOrigin(rawHeaderValues(rawHeaders, 'origin'), appOrigins)) {
    return { answer: refuse(reply, 403, FORBIDDEN_ORIGIN) };
  }

  if (!acceptsJson(request.headers.accept)) {
    return {
      answer: refuse(reply, 406, 'Not Acceptable: this endpoint answers application/json'),
    };
  }

  if (message === null) {
    return {
      answer: refuse(reply, 415, 'Unsupported Media Type: Content-Type must be application/json'),
    };
  }

  if (message.kind === 'invalid') {
    return { answer: reply.status(400).send(rpcError(null, message.code, message.message)) };
  }

  if (message.kind === 'request') {
    requestIds.set(request, message.id);
  }

  const isInitialize = message.kind === 'request' && message.method === 'initialize';
  const versionHeader = request.headers['mcp-protocol-version'];

  if (
    !isInitialize &&
    (Array.isArray(versionHeader) || declaredProtocolVersion(versionHeader) === null)
  ) {
    return {
      answer: reply
        .status(400)
        .send(
          rpcError(
            idOf(message),
            RpcErrorCode.SERVER_ERROR,
            `Bad Request: unsupported MCP-Protocol-Version; this server speaks ${MCP_PROTOCOL_VERSIONS.join(', ')}`,
          ),
        ),
    };
  }

  // Counted once the transport has let the message through: a `create_session`
  // call counts toward the creations once nothing of the transport can refuse
  // it. Its own argument checks and the session's state still can, after the
  // count, as for `POST /api/sessions`.
  const verdict = limits.count(
    request,
    reply,
    isCreateSessionCall(message) ? 'sessionCreates' : 'apiCalls',
  );

  if (!verdict.allowed) {
    // Its answer is the count's refusal, which writes no line of the request
    // log, as the API's refusals write none (#189).
    limits.keepOutOfLog(request);

    // A tool call over a limit is the tool's error, naming the limit and the
    // seconds to wait (D203); anything else is refused by the transport.
    if (message.kind === 'request' && message.method === 'tools/call') {
      return { answer: rpcResult(message.id, errorResult(apiErrorText(verdict.error))) };
    }

    return {
      answer: reply
        .status(429)
        .header('retry-after', String(verdict.retryAfter))
        .send(
          rpcError(idOf(message), RpcErrorCode.SERVER_ERROR, verdict.error.message, {
            errorCode: verdict.error.errorCode,
            retryAfter: verdict.retryAfter,
          }),
        ),
    };
  }

  // Everything from here was let through by the transport and the count, and
  // is answered in its turn in the gate (D244): the server's own answers too,
  // `initialize`'s and `tools/list`'s made and written in it, as any call's.
  // Each keeps nothing of the message while it waits but the id and what
  // `params` decided, the negotiated version.

  // A notification, or a response to a request this server never sends:
  // accepted, and nothing to answer.
  if (message.kind !== 'request') {
    return { accepted: () => reply.status(202).send() };
  }

  const { id, method, params } = message;

  switch (method) {
    case 'initialize': {
      const protocolVersion = negotiateProtocolVersion(params.protocolVersion);

      return {
        accepted: () =>
          rpcResult(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: MCP_SERVER_NAME,
              title: MCP_SERVER_TITLE,
              version: SERVER_VERSION,
              websiteUrl: appOrigin,
            },
            instructions: MCP_INSTRUCTIONS,
          }),
      };
    }
    case 'ping':
      return { accepted: () => rpcResult(id, {}) };
    case 'tools/list':
      return { accepted: () => rpcResult(id, { tools }) };
    case 'tools/call':
      break;
    default:
      return { accepted: () => rpcError(id, RpcErrorCode.METHOD_NOT_FOUND, 'Method not found') };
  }

  if (!isToolName(params.name)) {
    return {
      accepted: () =>
        rpcError(
          id,
          RpcErrorCode.INVALID_PARAMS,
          'Invalid params: no such tool; tools/list names the tools',
        ),
    };
  }

  return {
    id,
    call: readCall(params.name, params.arguments),
    waits: params.name === 'wait_for_request',
  };
}

export function registerMcpRoutes(app: FastifyInstance, options: McpRouteOptions): void {
  const { limits, appOrigin } = options;
  // Every `Origin` a browser on the site may send (D203, D275).
  const appOrigins = [appOrigin, ...(options.appAliasOrigin ? [options.appAliasOrigin] : [])];
  // The tool list `tools/list` answers, naming this server's receive host (D274).
  const tools = mcpTools(options.receiveOrigin);
  // Every method the listener knows but `POST`. `HEAD` comes with `GET`.
  const refusedMethods = app.supportedMethods.filter(
    (method) => method !== 'POST' && method !== 'HEAD',
  );

  void app.register(async (scope) => {
    // Every body is taken as bytes, whatever media type it declares: the
    // handler decides what to do with it. The listener's 1 MiB applies, and
    // a `Content-Type` that is no media type never reaches a parser (below).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    // A URL with a query string - anything from a `?` or a `#`, an empty one
    // included (`hasQueryString`) - is refused `400` on every method, before
    // the body is read and before any parser, so a body over 1 MiB or a
    // `Content-Type` that is no media type meets this refusal instead; and
    // before the route's handler, so `GET /mcp?x` is this `400`, not the
    // `405`. The transport uses none, and a request that went on would keep
    // its URL for as long as it is held, up to 30 s for a `wait_for_request`
    // (D203). Only the address's calls in flight are checked before it, by
    // the listener's own `onRequest` (`registerRateLimits`, D213): a call
    // that finds every place taken never reaches this hook and is refused
    // `429` / `1019` by the error handler below, not `400`. A forbidden
    // `Origin` is answered first either way, `403`, as the specification
    // asks. Refused with the body unread, it drains the body first on a
    // connection Node is about to close, as the API's refusals before the
    // body do (D143). Counted toward the other calls by `onSend`, as every
    // refusal before the count.
    scope.addHook('onRequest', async (request, reply) => {
      if (!hasQueryString(request.originalUrl)) {
        return;
      }

      const rawHeaders = request.raw.rawHeaders;

      if (shouldDrainRefusedBody(rawHeaders, reply.raw.shouldKeepAlive)) {
        await drainRequestBody(request.raw);
      }

      if (!isAllowedOrigin(rawHeaderValues(rawHeaders, 'origin'), appOrigins)) {
        return refuse(reply, 403, FORBIDDEN_ORIGIN);
      }

      return refuse(reply, 400, QUERY_STRING_REFUSED);
    });

    // The calls that took the wait path, for the shutdown below.
    const waiting = new WeakSet<FastifyRequest>();

    scope.addHook('onSend', async (request, reply) => {
      // A request answered before it was counted is counted now, toward the
      // other calls: one refused for its query string (above), one Fastify
      // refused before the handler - a body over 1 MiB, a `Content-Type` that
      // is no media type (below) - and one the handler refused before its
      // count, for its `Origin`, its `Accept`, its `Content-Type`, its body or
      // its protocol version. Its answer is a refusal either way, so a
      // `create_session` refused there counts as any other refused request
      // does.
      if (!limits.isCounted(request)) {
        limits.count(request, reply, 'apiCalls');
      }

      // As the list's answer does after a shutdown runs its wait out (D200):
      // a connection kept alive would hold the listener's close.
      if (options.waits.closed && waiting.has(request)) {
        reply.header('connection', 'close');
      }
    });

    // What the router or the body parser refuses before the handler runs,
    // answered as JSON-RPC rather than in the API's shape, so that everything
    // `/mcp` answers is one protocol.
    scope.setErrorHandler((error, request, reply) => {
      if (connectionEndedBeforeBody(request.raw)) {
        request.log.info('Request aborted by the client');

        return reply.hijack();
      }

      // Its address had 128 calls in flight already, on the API and here
      // together (D213): refused before any hook of this scope - so a URL
      // with a query string is this `429`, not its `400` - and before the
      // body was read, so with no `id`, in the over-limit form of D203 point
      // 10. Answered at once, its body never drained, since it holds no
      // place to drain it with. A foreign `Origin` is still answered first,
      // as the specification asks.
      //
      // Or a large body of a `POST` found every place of large bodies taken
      // (D205, D213): refused before its body was read too, so in the same
      // form, `1017`, its body drained first on a connection that closes, as
      // the API's is.
      //
      // Or a call's answer, once ready, found its address's answers not yet
      // written - or the server's - weighing what the answers' byte budget
      // allows (#184, `answer-budget.ts`): `1019` in the same form, but under
      // its request's id, the message having been read and the call run.
      if (
        error instanceof AppError &&
        (error.errorCode === ErrorCode.TOO_MANY_CONCURRENT_CALLS ||
          error.errorCode === ErrorCode.LARGE_BODIES_BUSY)
      ) {
        if (!isAllowedOrigin(rawHeaderValues(request.raw.rawHeaders, 'origin'), appOrigins)) {
          return refuse(reply, 403, FORBIDDEN_ORIGIN);
        }

        const retryAfter = Number(error.headers['retry-after']);

        return reply
          .status(429)
          .header('retry-after', String(retryAfter))
          .send(
            rpcError(requestIds.get(request) ?? null, RpcErrorCode.SERVER_ERROR, error.message, {
              errorCode: error.errorCode,
              retryAfter,
            }),
          );
      }

      const status =
        error instanceof AppError
          ? error.statusCode
          : typeof (error as { statusCode?: unknown }).statusCode === 'number'
            ? (error as { statusCode: number }).statusCode
            : 500;

      if (status === 413) {
        return refuse(reply, 413, 'Payload Too Large: a message is at most 1 MiB');
      }

      // Fastify checks `Content-Type` itself before choosing a parser, the
      // catch-all one included: a value that is no media type - empty, with
      // no `/`, with a character outside a token, such as `json` or `a/b c` -
      // is refused `415` (`FST_ERR_CTP_INVALID_MEDIA_TYPE`, `handleRequest`)
      // before the body is read and before the handler.
      if (status === 415) {
        return refuse(reply, 415, 'Unsupported Media Type: Content-Type must be application/json');
      }

      if (status >= 400 && status < 500) {
        return refuse(reply, status, 'Bad Request');
      }

      request.log.error({ err: error }, 'Unhandled error');

      return reply
        .status(500)
        .send(rpcError(null, RpcErrorCode.INTERNAL_ERROR, 'Internal server error'));
    });

    // A body over 128 KiB, or chunked, takes one of the places of large
    // bodies before it is read, shared with the API's seven JSON routes, and
    // finding none is `429` / `1017` (D205, D213): while it arrives the body
    // is held whole, up to 1 MiB, and one address may have 128 calls in
    // flight. The place goes back once the message is read and checked,
    // which takes the body off the request (`readMessage`): what a call keeps
    // while it runs afterwards - a `wait_for_request` for up to 30 s - is its
    // arguments, at most a response of 64 KiB of body and 8 KiB of headers,
    // so it holds no place it does not need. So not `holding`, as the six
    // are: nothing of the body outlives the handler's first, synchronous
    // step.
    //
    // A message the transport and the count let through then waits for its
    // turn in the gate in front of the API's work (D244), with its message
    // read: a tool call, and `initialize`, `ping`, `tools/list`, a
    // notification's `202` and every other answer the server makes itself.
    // Only the refusals before it is let through - the transport's, and the
    // count's, as the API's per-address limits refuse before its handler -
    // are answered at once; what waits is what the call keeps while it runs.
    scope.post(MCP_PATH, { onRequest: options.largeBody.guard }, async (request, reply) => {
      const opened = openCall(request, reply, limits, appOrigin, appOrigins, tools);

      options.largeBody.release(request);

      if ('answer' in opened) {
        return opened.answer;
      }

      if ('accepted' in opened) {
        return limits.work.inTurn(request, reply, async () => opened.accepted());
      }

      if (opened.waits) {
        waiting.add(request);
      }

      return limits.work.inTurn(request, reply, async () => {
        const gone = clientGone(reply);
        let result;

        try {
          result = await runCall(opened.call, {
            pool: options.pool,
            hub: options.hub,
            waits: options.waits,
            querySlots: options.querySlots,
            searchTimeoutMs: options.searchTimeoutMs,
            receiveOrigin: options.receiveOrigin,
            appOrigin,
            signal: gone.signal,
            // Held by `wait_for_request` while it reads, given back while it waits (D244).
            slot: limits.work.waitSlot(request),
            log: request.log,
            // The access key of the session a tool names (D245), never logged.
            key: requestKey(request),
          });
        } finally {
          gone.dispose();
        }

        if (result === null) {
          // The client left while it waited: nothing is written, as for the list (D200).
          request.log.info('Request aborted by the client');

          return reply.hijack();
        }

        return rpcResult(opened.id, result);
      });
    });

    // No stream to open and no session to end: every other method is `405`
    // (D203). `Origin` is checked first, as on `POST`. A call whose address
    // has every place among its calls in flight taken never reaches it - the
    // error handler above has refused it, `403` for a forbidden `Origin` and
    // `429` / `1019` otherwise - and nor, with a place, does a URL with a
    // query string: the hook above has answered it, `403` or `400`.
    //
    // Answered before its body is read, never parsed: the route has no use
    // for one, and the scope's parser would hold up to 1 MiB of it while it
    // arrives (D213). On a connection Node is about to close the body is
    // drained first, as the query string's refusal drains it (D143), the call
    // keeping its place among the calls in flight meanwhile; kept alive with
    // a body still arriving, the answer ends its connection
    // (`registerRateLimits`).
    const refuseMethod = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const rawHeaders = request.raw.rawHeaders;

      if (shouldDrainRefusedBody(rawHeaders, reply.raw.shouldKeepAlive)) {
        await drainRequestBody(request.raw);
      }

      limits.count(request, reply, 'apiCalls');

      if (!isAllowedOrigin(rawHeaderValues(rawHeaders, 'origin'), appOrigins)) {
        return refuse(reply, 403, FORBIDDEN_ORIGIN);
      }

      reply.header('allow', 'POST');

      return refuse(
        reply,
        405,
        'Method Not Allowed: this endpoint takes POST alone and opens no stream',
      );
    };

    scope.route({
      method: refusedMethods,
      url: MCP_PATH,
      onRequest: refuseMethod,
      // Never reached: the hook has answered every request first.
      handler: refuseMethod,
    });
  });
}
