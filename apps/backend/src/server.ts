import { METHODS } from 'node:http';
import type {
  Http2Server,
  Http2ServerResponse,
  Http2Session,
  ServerHttp2Session,
  ServerHttp2Stream,
} from 'node:http2';
import type { Socket } from 'node:net';
import proxyAddr from '@fastify/proxy-addr';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
  type RouteOptions,
} from 'fastify';
import type pg from 'pg';
import {
  ErrorCode,
  MAX_API_HEADER_LINES,
  MAX_RECEIVE_CONNECTIONS_PER_ADDRESS,
  SEARCH_TIMEOUT_MS,
  type ApiError,
} from '@webhook-inspector/shared';
import { AppError, routeNotFound } from './errors/app-error.ts';
import { connectionEndedBeforeBody } from './lib/connection.ts';
import { Drain } from './lib/drain.ts';
import { http2StreamOf } from './lib/http2.ts';
import { ignoreUnusedBodies } from './lib/ignored-body.ts';
import { createRedactingStream } from './lib/redact.ts';
import { RequestLog } from './lib/request-log.ts';
import { createKeyedSlots, type KeyedSlots } from './lib/slots.ts';
import { registerHealthRoutes } from './modules/health/routes.ts';
import {
  addressKey,
  DEFAULT_RATE_LIMITS,
  registerRateLimits,
  type RateLimitSettings,
} from './modules/limits/rate-limit.ts';
import { registerMcpRoutes } from './modules/mcp/routes.ts';
import {
  createRealtimePlaces,
  realtimeConnections,
  type RealtimePlaces,
} from './modules/realtime/connection-places.ts';
import { RealtimeHub } from './modules/realtime/hub.ts';
import { realtimeRoutes } from './modules/realtime/routes.ts';
import type { BodyListPlaces } from './modules/requests/body-lists.ts';
import { registerRequestRoutes } from './modules/requests/routes.ts';
import { createQuerySlots, type QuerySlots } from './modules/requests/search.ts';
import { PendingWaits } from './modules/requests/wait.ts';
import { createAnswerBudget, type AnswerBudget } from './modules/limits/answer-budget.ts';
import { createApiWork, createApiWorkSlots, type ApiWorkSlots } from './modules/limits/api-work.ts';
import { createCallPlaces, type CallPlaces } from './modules/limits/calls-in-flight.ts';
import {
  createLargeBodyPlaces,
  largeBodyHandling,
  type LargeBodyPlaces,
} from './modules/sessions/large-bodies.ts';
import { isBodyArriving } from './modules/sessions/refused-body.ts';
import { registerSessionRoutes } from './modules/sessions/routes.ts';
import { DEFAULT_APP_ORIGIN, type ReceiveHttp2, type ReceiveProxyProtocol } from './config.ts';
import { createCaptureBudget, type CaptureBudget } from './modules/webhook/capture-budget.ts';
import { createHeaderLineBudget, type HeaderLineBudget } from './modules/webhook/header-lines.ts';
import { acceptHttp2Preface, type PrefaceLayer } from './modules/webhook/http2-preface.ts';
import {
  createReceiveHttp2Server,
  HTTP2_MAX_CONNECTIONS_PER_ADDRESS,
  type ReceiveHttp2ServerOptions,
} from './modules/webhook/http2-server.ts';
import { boundPipelinedRequests } from './modules/webhook/pipelining.ts';
import { acceptProxyProtocol, countedRefusals } from './modules/webhook/proxy-protocol.ts';
import { routableUrl } from './modules/webhook/raw-request.ts';
import { receiveUrlMovedRoutes } from './modules/webhook/receive-url.ts';
import {
  CONTENT_SECURITY_POLICY_HEADER,
  CONTENT_TYPE_OPTIONS_HEADER,
  NOSNIFF,
  RECEIVER_CONTENT_SECURITY_POLICY,
} from './modules/webhook/response.ts';
import {
  declaresNoContent,
  PendingWrites,
  webhookRoutes,
  type SourceAddress,
} from './modules/webhook/routes.ts';

function isFastifyErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/**
 * Whether `request` came in as an upgrade: Node's server handed its socket,
 * parser removed, to the `upgrade` event, which only the application
 * listener's `@fastify/websocket` listens to, and which routes the request
 * through Fastify on a response of its own (D227). Node sets `upgrade` on such
 * a request alone; one the server reads as an ordinary request has it
 * `false`, and an injected one none. Node's type declarations leave it out.
 */
function isHandedOver(request: FastifyRequest): boolean {
  return 'upgrade' in request.raw && request.raw.upgrade === true;
}

/**
 * Whether Fastify refuses `request` on its headers alone, before it would
 * choose a parser for its body (`fastify/lib/handle-request.js`): a `QUERY`
 * without a `Content-Type`, or with one and no content framed, `400` / `1008`
 * (D166), and a `Content-Type` that is not a media type, `415` / `1007`
 * (D104). `request.mediaType` is Fastify's own reading of the header, the one
 * it refuses by, and absent for a value that is not a media type. A `GET`,
 * `HEAD` or `TRACE` Fastify checks for neither, and never reads the body of,
 * so a `true` for one changes nothing.
 */
function refusedOnItsHeaders(request: FastifyRequest): boolean {
  const contentType = request.headers['content-type'];

  if (
    request.raw.method === 'QUERY' &&
    (contentType === undefined || declaresNoContent(request.headers))
  ) {
    return true;
  }

  return contentType !== undefined && request.mediaType === undefined;
}

/**
 * A refusal of the router's, written byte for byte as Fastify writes it with
 * no `frameworkErrors`: its status, `{ error, code, message, statusCode }`
 * (`Bad Request` for the `414` too, as Fastify has it), and no hook run, so
 * none of their headers (D173, D201). With one difference: like every other
 * answer it ends its connection when written before its request's body has
 * arrived, while the process drains, or to an upgrade request, whose socket
 * no parser reads again (D213 point 5, D221, D227). Looked at once, at write
 * time: a body sent whole with its headers may still be arriving then, and
 * its connection ends too, which costs a client that sent a bad URL nothing.
 *
 * Over HTTP/2 (D263) nothing ends a connection and no `Connection` field is
 * written, which HTTP/2 forbids: an answer before the body has ended ends its
 * stream once written (`createReceiveHttp2Server`).
 */
function writeRouterRefusal(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
  drain: Drain,
): void {
  const status = error.statusCode ?? 500;
  const body =
    error.code === 'FST_ERR_ASYNC_CONSTRAINT'
      ? '{"error":"Internal Server Error","message":"Unexpected error from async constraint","statusCode":500}'
      : JSON.stringify({
          error: 'Bad Request',
          code: error.code,
          message: error.message,
          statusCode: status,
        });
  const handedOver = isHandedOver(request);
  const close =
    http2StreamOf(request.raw) === undefined &&
    (handedOver || drain.closes(request.raw.socket) || isBodyArriving(request.raw));

  reply.hijack();
  reply.raw.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...(close ? { Connection: 'close' } : {}),
  });
  reply.raw.end(body);

  if (handedOver) {
    request.raw.socket.destroySoon();
  }
}

/**
 * The answer over HTTP/2 to a `:method` no route has (D263): the one every
 * path no route has gets, `404` / `1000`, with the headers every answer of the
 * receive listener carries (`onSend`). Written outside Fastify, whose router
 * has no tree for such a method: it would log a warning that calls it a bug,
 * then its whole routing tree, and answer `500` (`createReceiveHttp2Server`).
 * Over HTTP/1.1 Node's parser refuses such a method `400` before Fastify sees
 * it.
 */
function answerUnroutedMethod(_request: unknown, response: Http2ServerResponse): void {
  const error = routeNotFound();
  const body = JSON.stringify({ errorCode: error.errorCode, message: error.message });

  // In the order Fastify writes them for a path no route has.
  response.writeHead(error.statusCode, {
    'content-type': 'application/json; charset=utf-8',
    [CONTENT_TYPE_OPTIONS_HEADER]: NOSNIFF,
    [CONTENT_SECURITY_POLICY_HEADER]: RECEIVER_CONTENT_SECURITY_POLICY,
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** What both listeners are built with. */
interface CommonOptions {
  /** Where log output goes. Redaction is applied on the way out (D059). */
  logDestination?: NodeJS.WritableStream;
  /**
   * The trust boundary (D111). Absent or empty means none, which is the
   * default and what local development runs; production passes this node's
   * pod network (deploy/helm/qa-tools/values.yaml, D130). On the receive
   * listener it is who may send a PROXY protocol header (D187), on the
   * application listener whose `X-Forwarded-For` decides `request.ip`.
   */
  trustedProxyCidrs?: string[];
  /**
   * Called once for every route the server registers, in every scope. The
   * OpenAPI test uses it to compare the routes with `packages/shared/openapi.json`
   * both ways; the application passes nothing.
   */
  onRoute?: (route: RouteOptions) => void;
  /**
   * The registry of open realtime connections and waits. The process passes
   * one to both listeners, and its listener delivers to it what every process
   * announces (D221). Absent, each server gets its own, which is all a test of
   * one listener needs; nothing is delivered to it without a listener.
   */
  hub?: RealtimeHub;
  /**
   * The process's drain (D221), shared by both listeners: once it has started,
   * every answer over HTTP/1.1 carries `Connection: close`, and every HTTP/2
   * session of the receive listener is sent a GOAWAY, its open streams
   * answered (D263). Absent, the listener keeps its own, which never starts.
   */
  drain?: Drain;
  /**
   * The application's public origin, `APP_ORIGIN` (D203): on the application
   * listener what `/mcp`'s inspector links name and an `Origin` it lets in,
   * beside `appAliasOrigin` (D275), on the receive listener where a default answer's `inspectorUrl`
   * links its request (D223). Defaults to the local dev server's.
   */
  appOrigin?: string;
}

export interface ServerOptions extends CommonOptions {
  /**
   * The application's second public origin, `APP_ALIAS_ORIGIN` (D275): the
   * other `Origin` `/mcp` lets in. It names no link. Absent or `null`, none.
   */
  appAliasOrigin?: string | null;
  /**
   * The receive listener's public origin, which `receiveUrl` and the `410` for
   * `/s/...` name (D187). Defaults to the local receive listener.
   */
  receiveOrigin?: string;
  /**
   * How long one search of raw requests, or one query of requests, may run;
   * 2 s unless a test shortens it (D191, D196).
   */
  searchTimeoutMs?: number;
  /**
   * The request list's waits pending on this listener, `/mcp`'s
   * `wait_for_request` among them, which its close runs out (D200, D203).
   * Absent, the listener keeps its own; a test passes one to look at it.
   */
  waits?: PendingWaits;
  /**
   * The per-address limits of the API (D201). Absent, the production ones:
   * 60 session creations and 1200 other calls per minute. The process passes
   * what its configuration says, which defaults to the same; a test that
   * makes more calls than they allow passes larger ones, and a test of the
   * limits passes its own clock.
   */
  rateLimits?: RateLimitSettings;
  /**
   * The places of list answers with bodies (D201). Absent, the listener keeps
   * its own four; a test passes one to look at it.
   */
  bodyListPlaces?: BodyListPlaces;
  /**
   * The places of searches and queries, shared by the API and `/mcp`: the
   * search's two, which a query with a body condition takes, and the two of
   * queries with none (D191, D250). Absent, the listener keeps its own; a
   * test passes them to hold places or look at them.
   */
  querySlots?: QuerySlots;
  /**
   * The places of large bodies of a queue save, a creation, a response
   * change, a status read, a search, a query and a `POST` to `/mcp` (D205,
   * D213). Absent, the listener keeps its own eight; a test passes one to
   * look at it.
   */
  largeBodyPlaces?: LargeBodyPlaces;
  /**
   * The places of the calls each address has in flight on `/api` and `/mcp`
   * (D213). Absent, the listener keeps its own, 128 an address; a test
   * passes one to look at it, or one of its own size.
   */
  callPlaces?: CallPlaces;
  /**
   * The bytes of the answers of `/api` and `/mcp` not yet written (#184).
   * Absent, the listener keeps its own, 16 MiB an address and 64 MiB in all;
   * a test passes one to look at it, or one of its own size.
   */
  answerBudget?: AnswerBudget;
  /**
   * The places of the realtime connections each address has open (D227).
   * Absent, the listener keeps its own, 16 an address; a test passes one to
   * look at it, or one of its own size.
   */
  realtimePlaces?: RealtimePlaces;
  /**
   * Whether the process's realtime listener has listened once (D221):
   * `/readyz` answers `503` until it has. Absent, it is taken as listening,
   * which is what a test without a listener needs.
   */
  realtimeReady?: () => boolean;
  /**
   * Capture's own pool, the receive listener's, which `/readyz` asks (D244):
   * the pod is ready while capture can reach the database, whatever the
   * API's pool holds. Absent, the listener's own pool, as in most tests.
   */
  capturePool?: pg.Pool;
  /**
   * The slots of the gate in front of the work of `/api` and `/mcp` (D244).
   * Absent, the listener keeps its own, `API_WORK_SLOTS`; a test passes one
   * to look at it, or one of its own size.
   */
  apiWorkSlots?: ApiWorkSlots;
}

export interface ReceiverOptions extends CommonOptions {
  /**
   * `v2` in production: every connection must open with a PROXY protocol v2
   * header from a peer inside `trustedProxyCidrs`, and the address it carries
   * is the stored `sourceIp`. `off`, the default, records the socket peer
   * (D187).
   */
  proxyProtocol?: ReceiveProxyProtocol;
  /** How long a peer has to deliver the PROXY header; 5 s unless a test shortens it. */
  proxyHeaderTimeoutMs?: number;
  /**
   * How many connections one sender address may have open at once, counted
   * by the PROXY layer and so only with `v2` (D227): the next is destroyed
   * right after its header. `0` turns the bound off. Absent, 512
   * (`MAX_RECEIVE_CONNECTIONS_PER_ADDRESS`); production passes
   * `RECEIVE_CONNECTIONS_PER_ADDRESS`, the chart's
   * `receive.connectionsPerAddress`.
   */
  connectionsPerAddress?: number;
  /**
   * How many requests one connection may have read and not yet answered
   * (D229); the rest of what it pipelines waits unread until earlier ones
   * are answered. Absent, 32 (`MAX_PIPELINED_REQUESTS`); a test passes a
   * smaller one, at least 2.
   */
  pipelinedRequests?: number;
  /**
   * The header lines the receive connections may have in flight, per sender
   * address and per process (D238); a connection whose next line does not fit
   * waits, unread, until lines are given back. Absent, the listener keeps its
   * own: 32,768 lines an address and 524,288 for the process
   * (`MAX_HEADER_LINES_IN_FLIGHT_PER_ADDRESS`, `MAX_HEADER_LINES_IN_FLIGHT`).
   * A test passes one to look at it, or one of its own size.
   */
  headerLines?: HeaderLineBudget;
  /**
   * The byte budget webhooks are received by (D210). Absent, the listener
   * keeps its own: 64 MiB, 16 MiB an address, 16 MiB more for light senders
   * (D261), 30 s of waiting. A test passes
   * one to look at it, or one of its own size.
   */
  captureBudget?: CaptureBudget;
  /**
   * The completion writes under way, which a shutdown waits for before it
   * ends the pool (D221). Absent, the listener keeps its own.
   */
  writes?: PendingWrites;
  /**
   * `on` serves a connection that opens with the HTTP/2 connection preface,
   * after its PROXY header with `v2`, as HTTP/2, on a second Fastify instance
   * with the same receive routes (D263). `off`, the default and production's
   * value until #115, leaves every connection to the HTTP/1.1 parser.
   * `RECEIVE_HTTP2`.
   */
  http2?: ReceiveHttp2;
  /** How long the preface layer waits for its decision; 10 s unless a test shortens it. */
  prefaceTimeoutMs?: number;
  /** How long an HTTP/2 request may take to arrive; 90 s unless a test shortens it. */
  http2RequestTimeoutMs?: number;
  /** How long an idle HTTP/2 connection stays open; 72 s unless a test shortens it. */
  http2SessionIdleTimeoutMs?: number;
}

/** The receive listener's HTTP/2 part (D263), for tests and diagnostics. */
export interface ReceiverHttp2Part {
  /** The second Fastify instance, which serves the receive routes over HTTP/2. */
  app: FastifyInstance;
  /** Its Node HTTP/2 server, which listens on nothing. */
  server: Http2Server;
  /** The HTTP/2 sessions open, one a connection. */
  sessions: ReadonlySet<ServerHttp2Session>;
  /** The preface layer. */
  preface: PrefaceLayer;
  /**
   * The places the open HTTP/2 connections hold, per sender address (D266),
   * or `null` when nothing is counted: PROXY protocol off, or D227's bound
   * turned off.
   */
  connections: KeyedSlots | null;
  /** HTTP/2 connections refused over their address's bound since the listener started. */
  readonly refused: number;
}

const http2Parts = new WeakMap<FastifyInstance, ReceiverHttp2Part>();

/** The HTTP/2 part of a receive listener `buildReceiver` built with `http2: 'on'`, or `undefined`. */
export function receiverHttp2(app: FastifyInstance): ReceiverHttp2Part | undefined {
  return http2Parts.get(app);
}

/** The local receive listener, which `receiveUrl` names when nothing is configured. */
export const DEFAULT_RECEIVE_ORIGIN = 'http://127.0.0.1:3001';

/**
 * The request the structured log describes (D117).
 *
 * This is Fastify's own `req` serializer with two fields changed. `url` is
 * `request.originalUrl`, the URL as it arrived, rather than `request.url`, the
 * one the router was given: they differ only for a path under `/s/` that the
 * router could not decode and was given escaped once more (D173), and the log
 * should show what arrived. D059's redaction applies to it as to every line.
 *
 * `remoteAddress` reports `request.socket.remoteAddress` rather than
 * `request.ip`. The two are the same value only while `trustProxy` is off. With
 * it configured, as production has it since 2026-09-21 (D130), `request.ip` is
 * the sender's real public address, and the default serializer would write that
 * into every request log line without anybody having decided to. D059 redacts
 * session ids at the level of the serialised line and does nothing about
 * addresses, so nothing else in the project would catch it.
 *
 * What is emitted instead is the peer the process is actually talking to - in
 * production the Traefik pod. That is byte-for-byte what the log held before the
 * trust boundary was closed, so
 * nothing about diagnosability changes: the question "which peer is talking to
 * me" is still answered, and the question "who is the end user" stays out of a
 * record that is read through Lens, pasted into issues and screenshotted, and
 * that outlives the session TTL bounding everything else about a capture.
 *
 * This is field-level redaction, and D059 argues against field-level redaction
 * for reasons that remain correct: an address arriving inside an error message
 * or in a field added later passes straight through. Stream-level redaction
 * cannot do this job - an IP address has no distinctive textual shape, and a
 * pattern wide enough to catch every address would also eat version numbers,
 * durations and byte counts. The weakness is named rather than answered.
 *
 * Removing this serializer restores Fastify's behaviour - the sender's address,
 * and the routed URL - and changes nothing else, which is how the owner
 * reverses the choice if he wants the sender's address in the logs.
 */
function serializeRequest(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: request.originalUrl,
    version: request.headers['accept-version'],
    host: request.host,
    remoteAddress: request.socket?.remoteAddress,
    remotePort: request.socket?.remotePort,
  };
}

/**
 * The trust boundary, compiled once per server (D111). Fastify compiles an
 * allow-list with this same `@fastify/proxy-addr` function when it is given
 * the list itself, so handing it the compiled function instead changes
 * nothing about `request.ip`; what it adds is that the receive listener can
 * ask the very same question - is this socket peer trusted? - before it reads
 * a PROXY protocol header (D187). `null` is the empty list: nobody is trusted.
 */
function compileTrust(
  cidrs: string[] | undefined,
): ((address: string, hop: number) => boolean) | null {
  return cidrs?.length ? proxyAddr.compile(cidrs) : null;
}

interface AppOptions {
  logDestination?: NodeJS.WritableStream;
  /**
   * The request log, which keeps a call a limit refuses out of it (#189,
   * `lib/request-log.ts`): the application listener's, which its limits
   * decide on. Absent, one that holds nothing, as the receive listener has.
   */
  requestLog?: RequestLog;
  onRoute?: (route: RouteOptions) => void;
  trustProxy: ((address: string, hop: number) => boolean) | false;
  /**
   * Whether the response to a request carries nosniff and the sandbox policy
   * (D101, D179): every `/s/...` URL on the application listener, every
   * response on the receive listener.
   */
  isReceiveUrl: (url: string) => boolean;
  /**
   * The process's drain (D221): once started, every answer over HTTP/1.1 ends
   * its connection, and every HTTP/2 session is sent a GOAWAY, its open
   * streams answered (`installHttp2`, D263).
   */
  drain: Drain;
  /**
   * The receive listener's HTTP/2 instance (D263): Fastify on Node's HTTP/2
   * server, which this builds, with HTTP/2's rules where HTTP/1.1's do not
   * apply. Absent, Fastify on Node's HTTP/1.1 server.
   */
  http2?: ReceiveHttp2ServerOptions;
}

/**
 * What the two listeners share (D187): the structured log, the timeouts, the
 * router's handling of an undecodable path under `/s/`, the methods, the
 * error contract, the receive URL's protective headers, the not-found route's
 * `404` before any body, and the end of a connection whose answer is written
 * before its request's body has arrived (D213, D227). Each listener adds its
 * own routes.
 */
function createApp(options: AppOptions): FastifyInstance {
  const requestLog = options.requestLog ?? new RequestLog();
  const http2 = options.http2;
  const fastifyOptions: FastifyServerOptions = {
    logger: {
      stream: createRedactingStream(options.logDestination ?? process.stdout),
      serializers: { req: serializeRequest },
      // Every line asks the request log first (#189): a call's `incoming
      // request` held for its verdict is written before it, and a call a
      // limit refused writes no line at `info`.
      hooks: {
        logMethod(args, method, level) {
          if (requestLog.writes(this, level)) {
            method.apply(this, args);
          }
        },
      },
    },
    // Fastify's own lines of each request, `incoming request` held for the
    // calls the limits decide on (`lib/request-log.ts`).
    logController: requestLog,
    // The trust boundary (D111), on the application listener: a CIDR
    // allow-list and nothing else, never a hop count and never `true`.
    // `X-Forwarded-For` is evaluated right-to-left by `@fastify/proxy-addr`,
    // so a value forged on the left is skipped. Since 0.36.0 nothing stored
    // reads the `request.ip` it decides: captures arrive on the receive
    // listener, whose `trustProxy` is `false` and whose sender address comes
    // from the PROXY protocol header instead (D187).
    //
    // What a `/24` such as the node's pod network trusts is **every pod on
    // that node**, not one named peer, and the range is **per-node**. The
    // single-node cluster (D083) is what makes the approximation acceptable;
    // the receive listener's PROXY check relies on the same list and the same
    // assumption.
    trustProxy: options.trustProxy,
    // How long a request may take to arrive, headers and body together
    // (D172). Node's HTTP/1.1 server's: the HTTP/2 instance bounds each
    // stream itself, with the same 90 s (`createReceiveHttp2Server`).
    // Fastify's default of 0 switches off Node's own 300 s, and with no bound
    // a client that declares a body and then stalls holds its socket for as
    // long as it likes: on the receiver, on a create, and on the drain of a
    // refused create (D143).
    //
    // On the application listener Traefik bounds the same thing first: its
    // `readTimeout`, pinned at 60 s in `deploy/cluster/traefik-config.yaml`,
    // gives up on such a client after 60 s, and 90 s is longer on purpose, so
    // that its answer is the one a client sees there. On the receive listener
    // Traefik's TCP route passes the bytes through without an HTTP timeout of
    // its own, so this is the bound a sender meets (D187). Node
    // looks for overdue requests once every `connectionsCheckingInterval`,
    // 30 s, so a stalled request is answered `408` outside the error contract
    // (D142) between 90 and 120 s after it began. The clock stops once the
    // request has fully arrived: a response held by a configured delay is not
    // cut, and neither is an idle keep-alive connection or a WebSocket.
    //
    // It must stay at least `headersTimeout`, Node's 60 s. Node refuses a
    // larger `headersTimeout` when it constructs a server, but Fastify assigns
    // this value afterwards, where nothing checks it, and Node's periodic check
    // then swaps the two: the larger becomes the bound on the whole request.
    // `server-timeouts.test.ts` holds the order.
    requestTimeout: 90_000,
    // `connectionTimeout` stays unset, Fastify's 0. It is a socket inactivity
    // timeout, not a bound on the request: a client trickling a byte now and
    // then never trips it, and any value short enough to matter would also cut
    // a response held silent by a configured delay of up to 30 s
    // (`MAX_RESPONSE_DELAY_MS`, D172).
    //
    // A path under the webhook endpoint that the router cannot decode is
    // given to it escaped once more, so it reaches the receiver - and on the
    // application listener its `410` (D187) - instead of being refused before
    // any route; every other URL is given unchanged, and
    // `request.originalUrl` keeps the one received (D173).
    rewriteUrl: (request) => routableUrl(request.url ?? '/'),
    // A request that arrives on a kept-alive connection while the listener
    // closes is served, not answered `503` (D221): the shutdown already
    // waits for what is in flight, and a webhook or a call refused during a
    // rollout is what the rollout must not do. The drain has started by then
    // (`lifecycle.ts`): every answer over HTTP/1.1 ends its connection, and
    // every HTTP/2 session has been sent a GOAWAY, its open streams answered.
    return503OnClosing: false,
    // The router's own refusals, before any route or hook: a path it cannot
    // percent-decode, `400`, and a parameter over its 100 characters, `414`
    // (D173, D201). Written as Fastify writes them, outside the error
    // contract and with none of the hooks' headers, only so that they end
    // their connection as every other answer does (D227).
    // No limit counts them, so their `incoming request` is not held (#189).
    frameworkErrors: (error, request, reply) => {
      requestLog.admit(request);
      writeRouterRefusal(error, request, reply, options.drain);
    },
  };
  // The HTTP/2 instance is typed as the HTTP/1.1 one, on purpose: its routes
  // and hooks read of a request and its answer only what Node's HTTP/2
  // compatibility request and response have too - method, URL, headers,
  // `rawHeaders`, `httpVersion`, the response's events - and every place that
  // reads what only one of them has asks `lib/http2.ts` first (D263).
  // The methods the routes take, filled below once they are all declared: a
  // request over HTTP/2 with any other `:method` is answered `404` / `1000`
  // before it reaches Fastify (`answerUnroutedMethod`).
  const routedMethods = new Set<string>();
  const app = http2
    ? (Fastify({
        ...fastifyOptions,
        http2: true,
        serverFactory: (handler: Parameters<typeof createReceiveHttp2Server>[0]) =>
          createReceiveHttp2Server(handler, {
            ...http2,
            unroutedMethods: { routed: routedMethods, answer: answerUnroutedMethod },
          }),
      } as never) as unknown as FastifyInstance)
    : Fastify(fastifyOptions);

  // Every request in flight counted on its socket, for the drain (D221). The
  // HTTP/2 instance's open sessions, which the drain sends a GOAWAY, are
  // given it by `installHttp2`, which keeps them (D263).
  if (!http2) {
    options.drain.track(app.server);
  }

  // Added before any route, so that it sees every one of them: a hook added
  // later misses the routes already registered on the root instance.
  const { onRoute } = options;

  if (onRoute) {
    app.addHook('onRoute', (route) => {
      onRoute(route);
    });
  }

  // The receiver accepts every method Node's parser can produce (D139), and the
  // application listener's `410` for `/s/...` answers every one of them
  // (D187): Fastify's default set plus the rest of `http.METHODS`. A name
  // outside that list never gets this far: Node's parser rejects it, and it is
  // answered 400 before any route runs - over HTTP/2, which takes any token,
  // the receive listener's HTTP/2 server answers it `404` / `1000` (D263).
  //
  // Declared here, before any route, rather than in the webhook plugin: Fastify
  // keeps one method set per root instance and shares it with every scope, so a
  // declaration inside the plugin would look encapsulated without being so, and
  // `app.all` there takes the set as it stands when the route is added.
  //
  // `CONNECT` is left out. Node hands it to the server's `connect` event, and
  // closes the connection when nothing listens, so no route can ever see it.
  //
  // Every added method may carry a body: the receiver stores bytes without
  // interpreting them (D007), and refusing a body on a method whose
  // specification defines none would discard what the sender actually sent.
  for (const method of METHODS) {
    if (method !== 'CONNECT' && !app.supportedMethods.includes(method)) {
      app.addHttpMethod(method, { hasBody: true });
    }
  }

  // HTTP/2 holds `:method` to no list: its instance answers a name outside
  // this set itself (D263).
  for (const method of app.supportedMethods) {
    routedMethods.add(method);
  }

  // Every response to a receive URL carries nosniff (D101) and the sandbox
  // policy (D179), whichever route answers it: on the receive listener every
  // response, its 404s and its `robots.txt` included, and on the application
  // listener the `410` that every `/s/...` URL answers since 0.36.0 (D187).
  // A request Node's parser refuses is answered by Fastify's client-error
  // handler straight to the socket, where no hook runs, and gets neither header
  // (D142); so is a URL outside `/s/` whose path the router cannot decode,
  // which it refuses before any route (D173).
  //
  // Three properties this hook must keep. It returns nothing: an async hook
  // whose implicit return value is the reply would replace the payload with it
  // and hang the client. It cannot throw, or a captured request would be
  // answered 500 after having been stored. And it never touches the payload, so
  // that a custom body stays byte-identical and its Content-Length stays right.
  app.addHook('onSend', async (request, reply) => {
    if (options.isReceiveUrl(request.url)) {
      reply.header(CONTENT_TYPE_OPTIONS_HEADER, NOSNIFF);
      reply.header(CONTENT_SECURITY_POLICY_HEADER, RECEIVER_CONTENT_SECURITY_POLICY);
    }

    // Over HTTP/2 (D263) no answer controls its connection, and HTTP/2
    // forbids the `Connection` field, which Node's compatibility response
    // would drop with a warning: none is sent - not the full waiting line's
    // (`capturesBusy`), not Fastify's on a body over the limit. The drain
    // sends a GOAWAY instead, and an answer written before its request's
    // body has ended ends its stream, `RST_STREAM(NO_ERROR)`
    // (`createReceiveHttp2Server`).
    if (http2) {
      reply.removeHeader('connection');

      return;
    }

    // Draining (D221): the answer ends its connection, so that a connection
    // kept alive does not carry another request to a process about to stop -
    // unless another request of the same socket is in flight behind it, whose
    // answer would then never be written (`Drain.closes`). Node closes the
    // connection once it has written an answer carrying it. The receiver's
    // reply to a webhook is written outside Fastify and decides it itself
    // (`sendWebhookResponse`).
    if (options.drain.closes(request.raw.socket)) {
      reply.header('connection', 'close');
    }

    // An upgrade request answered here rather than upgraded - one to a path
    // outside `/ws`, or a refused realtime connection - ends its connection,
    // body or none: Node handed its socket to the `upgrade` event, so no
    // parser reads it again and no timeout watches it (D227). The hook below
    // ends it once the answer is written.
    if (isHandedOver(request)) {
      reply.header('connection', 'close');

      return;
    }

    // An answer written before its request's body has all arrived ends its
    // connection, on both listeners and whatever the answer (D213 point 5,
    // extended by D227): `/s/...`'s `410`, the probes, the not-found route,
    // a refused realtime connection, the receiver's `503` / `1018` and `404`,
    // and every answer of `/api` and `/mcp`. Kept alive, Node would keep such
    // a request until the rest of its body came and was discarded - for up to
    // the 90 s of `requestTimeout` from a client that stalls - with nothing
    // counting it, so one address could keep any number. Closed, the request
    // goes with its connection, and the answer can be lost to a reset on a
    // client still sending, as D143 accepts for the bodies it does not drain.
    // A body arrived whole, or none, keeps the connection alive. The reply to
    // a captured webhook is written outside Fastify and follows the same rule
    // itself (`sendWebhookResponse`).
    if (isBodyArriving(request.raw)) {
      // Node's parser reads the rest of what has arrived on the connection
      // only once the hooks woken by the body's first part have run, so a
      // body sent whole with its headers is complete a turn of the event
      // loop later, not yet here. Looked at again then: what has still not
      // arrived is in flight.
      await new Promise((resolve) => setImmediate(resolve));

      if (isBodyArriving(request.raw)) {
        reply.header('connection', 'close');
      }
    }
  });

  // The connection of an upgrade request answered over HTTP ends once its
  // answer is written, flushed first (D227). Node's server ends a connection
  // whose answer says `Connection: close` itself, but not one it handed to
  // the `upgrade` event: `@fastify/websocket` routes such a request on a
  // response of its own, and destroys the socket after an answer only on the
  // routes of its own scope, `/ws`. Every other route would leave it open,
  // unread and untimed, for as long as the client keeps it.
  app.addHook('onResponse', async (request) => {
    if (isHandedOver(request)) {
      request.raw.socket.destroySoon();
    }
  });

  // A path no route has, or a method its path has no route for, is answered
  // `404` / `1000` before a byte of its body is read, whatever its method,
  // media type or framing (D227). Fastify's not-found route otherwise reads a
  // body whenever a parser of its instance takes the media type - the
  // receive listener's root keeps Fastify's own JSON and text parsers, which
  // read up to the listener's 1 MiB into a string counted by no budget, and
  // the application listener's root has `ignoreUnusedBodies`' - and answers
  // only once the body has all arrived, keeping the request, and the
  // connection kept alive, for as long as a client that stalls likes:
  // 1 MiB an unanswered connection on the receive listener, which took the
  // process past its heap with one address's few hundred. Answered here, the
  // close rule above ends a connection whose body is still arriving.
  //
  // `preParsing`, the last hook before Fastify looks at the body: after
  // every `onRequest`, so that a call to an `/api` path no route has is
  // still counted and holds its place among its address's calls in flight
  // (D201, D213), and before Fastify chooses a parser. What Fastify refuses
  // on its headers alone, which reads no body either, is left to it and
  // keeps its answer: a `QUERY` without content, `400` / `1008` (D166), and a
  // `Content-Type` that is not a media type, `415` / `1007` (D104).
  app.addHook('preParsing', async (request) => {
    if (request.is404 && !refusedOnItsHeaders(request)) {
      throw routeNotFound();
    }
  });

  // Every failure the application sees leaves through here, so that clients see
  // the shape documented in D026: an errorCode and a message, and for a `1005`
  // naming a place in the body its `field` (D257), nothing else. A request
  // Node's parser refuses is answered by Fastify outside that shape (D142).
  app.setErrorHandler((error, request, reply) => {
    // A request whose connection ended before its body had arrived (D174): the
    // client abandoned it, Traefik cut it at its 60 s `readTimeout` (#45, D172),
    // Node's parser refused a chunked body mid-read and Fastify closed the
    // connection (D142), or the server's own `requestTimeout` answered it `408`.
    // To this handler the four are one event, and none is a server fault, so it
    // is logged at `info`, where Fastify logs every request's lifecycle, and
    // closes the request's trail: an aborted request never gets its `request
    // completed` line.
    //
    // Checked first, not only before the fall-through, because no answer below
    // could reach anybody: the drain of a refused create also ends when the
    // request goes (D143), and its `415` arrives here like any other.
    //
    // This handler writes nothing further to the dead connection - what
    // Fastify's client-error handler already wrote stands (D142) - and tells
    // Fastify so: a hijacked reply is never sent, runs no `onSend` hook and logs
    // no line of its own, as the receiver's reply to a sender gone mid-delay
    // (D109).
    if (connectionEndedBeforeBody(request.raw)) {
      request.log.info('Request aborted by the client');

      return reply.hijack();
    }

    if (error instanceof AppError) {
      const body: ApiError = {
        errorCode: error.errorCode,
        message: error.message,
        ...(error.field === undefined ? {} : { field: error.field }),
      };

      return reply.status(error.statusCode).headers(error.headers).send(body);
    }

    // Fastify aborts an oversized body before the handler runs, so nothing was
    // stored by the time we get here (D008, D046).
    if (isFastifyErrorCode(error, 'FST_ERR_CTP_BODY_TOO_LARGE')) {
      const body: ApiError = {
        errorCode: ErrorCode.PAYLOAD_TOO_LARGE,
        message: 'Payload too large',
      };

      return reply.status(413).send(body);
    }

    // A body declared as JSON that Fastify's own parser refused: empty, or not
    // parseable. Fastify classifies both as client errors carrying status 400,
    // and they mean precisely what 1006 is defined for, so they are answered as
    // the client mistakes they are rather than widened into a server fault
    // (D104). The create route never reaches this branch: its own parser turns
    // the same inputs into an AppError inside its encapsulated scope.
    if (
      isFastifyErrorCode(error, 'FST_ERR_CTP_EMPTY_JSON_BODY') ||
      isFastifyErrorCode(error, 'FST_ERR_CTP_INVALID_JSON_BODY')
    ) {
      const body: ApiError = {
        errorCode: ErrorCode.MALFORMED_REQUEST_BODY,
        message: 'Request body must be a JSON object',
      };

      return reply.status(400).send(body);
    }

    // A media type no parser on this instance handles, and a `Content-Type`
    // header that is not a media type at all - an empty value, `json`,
    // `application/` and `a/b/c` are four of the shapes that qualify, and
    // `content-type.js` decides the rest - which Fastify refuses before it
    // chooses a parser (`handle-request.js` sends this error on
    // `ContentType.isValid === false`). Both are 415 to Fastify.
    //
    // The webhook receiver does not reach this branch: its plugin replaces such
    // a header on Fastify's parsed view before the check and captures the
    // request (D138). Since D173 that covers every `/s/...` URL, a path under
    // the endpoint included. On the application listener a `/s/...` URL does
    // not reach it either: its `410` is thrown before the check (D187).
    //
    // The message is endpoint-neutral: what the instance can parse
    // decides this, not one route's rules. `unsupportedMediaType()` in
    // `errors/app-error.ts` keeps the create route's specific wording, which
    // that route's own guard produces and `docs/API.md` documents for it.
    if (isFastifyErrorCode(error, 'FST_ERR_CTP_INVALID_MEDIA_TYPE')) {
      const body: ApiError = {
        errorCode: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
        message: 'Unsupported Media Type',
      };

      return reply.status(415).send(body);
    }

    // A `QUERY` without a `Content-Type`, or with one and no content, which
    // Fastify refuses before any parser or handler as RFC 10008 requires, and
    // gives status 400. The webhook receiver never reaches this branch: its
    // plugin carries such a `QUERY` past both refusals and captures it (D166).
    // Every other path does, the not-found route included, so any `/api/...`
    // URL and any unknown URL answer here; a path under `/s/<id>/` is the
    // receiver's since D173 and is captured, and on the application listener
    // it answers `410` first (D187). The message names the missing part.
    const missingContentType = isFastifyErrorCode(error, 'FST_ERR_ROUTE_MISSING_CONTENT_TYPE');

    if (missingContentType || isFastifyErrorCode(error, 'FST_ERR_ROUTE_MISSING_CONTENT')) {
      const body: ApiError = {
        errorCode: ErrorCode.MISSING_REQUEST_CONTENT,
        message: missingContentType
          ? 'Request must have a Content-Type header'
          : 'Request must have content',
      };

      return reply.status(400).send(body);
    }

    // Framing failures - FST_ERR_CTP_INVALID_CONTENT_LENGTH among them - are
    // deliberately not mapped here. They are about the envelope rather than the
    // body's shape, and in practice Node's parser refuses them before a request
    // ever reaches this handler: Fastify's default client-error handler answers
    // them outside the error contract, an exception D142 accepts. A chunked body
    // the parser refuses mid-read does arrive here, but only afterwards, as an
    // aborted body on a connection already answered 400 and closed; the first
    // branch of this handler takes it (D174).
    //
    // A request that had arrived whole never takes that branch, so a failure on
    // it reaches the line below whatever it says - an `ECONNRESET` from the
    // database included - whether or not its client is still there to be
    // answered.

    request.log.error({ err: error }, 'Unhandled error');

    const body: ApiError = {
      errorCode: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    };

    return reply.status(500).send(body);
  });

  // Fastify answers unknown routes in its own error shape by default, which
  // would put a second error contract on the wire (D062).
  app.setNotFoundHandler(() => {
    throw routeNotFound();
  });

  return app;
}

/**
 * The application listener: the API, the realtime endpoint, the MCP endpoint
 * `/mcp` (D203) and the health checks, behind the Ingress of `qa-tools.ru`.
 * `/s/...` answers `410` / `1009` here, naming the receive URL (D187). The API
 * and `/mcp` alone are limited per address, sharing the counts (D201, D203)
 * and the 128 calls an address may have in flight (D213), and an address may
 * have at most 16 realtime connections open (D227); this listener's
 * `request.ip` is the address it counts. Across every address, at most three
 * handlers of the API and `/mcp` work at once, the rest waiting their turn
 * (D244). A request carries at most 100 header lines here (D213).
 *
 * Everything here runs on `pool`, the API's, but `/readyz`, which asks
 * capture's own, `capturePool` (D244).
 */
export function buildServer(pool: pg.Pool, options: ServerOptions = {}): FastifyInstance {
  const trustedProxy = compileTrust(options.trustedProxyCidrs);
  const receiveOrigin = options.receiveOrigin ?? DEFAULT_RECEIVE_ORIGIN;
  // Which the limits keep their refusals out of (#189).
  const requestLog = new RequestLog();
  const app = createApp({
    logDestination: options.logDestination,
    requestLog,
    onRoute: options.onRoute,
    trustProxy: trustedProxy ?? false,
    isReceiveUrl: (url) => url.startsWith('/s/'),
    drain: options.drain ?? new Drain(),
  });

  // At most 100 header lines a request, the `Host` line included (D213). A
  // request with more is refused `431` by Node's parser before it reaches
  // Fastify - outside the error contract, as every request the parser
  // refuses is (D142) - so what a call held open keeps of its header lines is
  // bounded by their number as well as by Node's 16 KiB: a header object of
  // 990 short lines, which 16 KiB allows, held about 100 KiB a pending wait.
  // Traefik adds a few lines of its own in production, within the 100. The
  // receive listener has no such limit (`buildReceiver`).
  app.server.maxHeadersCount = MAX_API_HEADER_LINES;

  // At most 1 KiB of a body a route that takes none is sent, checked and
  // dropped (D213, `lib/ignored-body.ts`): before any route and any scope,
  // which copies the parsers it is created with.
  ignoreUnusedBodies(app);

  // One registry per process, shared by the endpoint that opens connections,
  // the waits, and the listener that delivers what every process announces
  // (D221). It reports the connections it cuts for falling behind to this
  // listener's log, where they were opened (D205).
  const hub = options.hub ?? new RealtimeHub();

  hub.reportTo(app.log);

  // The list's pending waits, the search's slots and the places of
  // header-only queries, one of each per process, shared by the API and
  // `/mcp` (D191, D200, D203, D250).
  const waits = options.waits ?? new PendingWaits();
  const querySlots = options.querySlots ?? createQuerySlots();
  const searchTimeoutMs = options.searchTimeoutMs ?? SEARCH_TIMEOUT_MS;

  // Before any route, so that its hooks reach every one of them: the counts
  // (D201), the place among its address's calls in flight that each call of
  // the API and of `/mcp` holds (D213), the bytes its answer weighs until it
  // has been written (#184), and the gate in front of every handler's work,
  // three at once across every address (D244); and the request log, which a
  // call they refuse writes no line of (#189).
  const limits = registerRateLimits(
    app,
    options.rateLimits ?? DEFAULT_RATE_LIMITS,
    requestLog,
    options.callPlaces ?? createCallPlaces(),
    options.answerBudget ?? createAnswerBudget(),
    createApiWork(options.apiWorkSlots ?? createApiWorkSlots(), (request) =>
      addressKey(request.ip),
    ),
  );

  // The places of large bodies, one count across the seven routes that read
  // a JSON body and `POST /mcp` (D205, D213, D246). A call refused one gives
  // back its place among the calls in flight at once, so that it holds
  // neither - unless its body is drained, which it keeps that place for until
  // its response closes.
  const largeBody = largeBodyHandling(
    options.largeBodyPlaces ?? createLargeBodyPlaces(),
    (request) => limits.giveBackCallPlace(request),
  );

  registerHealthRoutes(app, options.capturePool ?? pool, options.realtimeReady ?? (() => true));
  // A change gives its slot of the gate back before it joins its session's
  // line, so that no call waiting there holds one, nor its turn (D244).
  registerSessionRoutes(app, pool, hub, receiveOrigin, largeBody, (request) =>
    limits.work.waitSlot(request),
  );
  registerRequestRoutes(app, pool, hub, {
    searchTimeoutMs,
    waits,
    bodyListPlaces: options.bodyListPlaces,
    querySlots,
    largeBody,
    waitSlot: (request) => limits.work.waitSlot(request),
    inSlot: (request, read, gone) => limits.work.inSlot(request, read, gone),
  });
  registerMcpRoutes(app, {
    pool,
    hub,
    waits,
    querySlots,
    searchTimeoutMs,
    limits,
    largeBody,
    receiveOrigin,
    appOrigin: options.appOrigin ?? DEFAULT_APP_ORIGIN,
    appAliasOrigin: options.appAliasOrigin ?? null,
  });
  // At most 16 realtime connections an address, refused `429` / `1020`
  // before the upgrade (D227).
  void app.register(
    realtimeRoutes(
      pool,
      hub,
      realtimeConnections(options.realtimePlaces ?? createRealtimePlaces()),
    ),
  );
  void app.register(receiveUrlMovedRoutes(receiveOrigin));

  return app;
}

/** What the receive host answers at `/robots.txt`: keep out (D183, D187). */
export const RECEIVE_ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

/**
 * The receive listener (D187): `/s/*` and nothing else, every method, on a
 * port of its own, which Traefik's TCP route for the receive host reaches with
 * the sender's own bytes. No proxy writes a header on this path, so a capture
 * stores the request exactly as the sender wrote it.
 *
 * A capture's announcement is written in its transaction and reaches the
 * viewers of every process through the outbox (D221). `request.ip` is never
 * believed here (`trustProxy` `false`): the sender's address is the PROXY
 * protocol header's in production and the socket peer's locally.
 *
 * Not limited by a count per minute (D201 point 2), but by bytes: a webhook
 * waits for its place in the capture budget, 64 MiB for the process and
 * 16 MiB for the sender's address, 16 MiB more for a light sender's (D261),
 * and is refused `503` / `1018` only after
 * 30 s of waiting (D210). And by connections: with PROXY protocol on, one
 * sender address may have 512 open at once, the next destroyed right after
 * its header with no answer (D227). And by what one connection pipelines: at
 * most 32 of its requests read and not yet answered, the rest left unread
 * until earlier ones are answered (D229). And by the header lines in flight:
 * 32,768 an address and 524,288 for the process, a connection whose next line
 * does not fit left unread until lines are given back (D238).
 *
 * With `http2: 'on'` a connection that opens with the HTTP/2 connection
 * preface is served by a second Fastify instance on Node's HTTP/2 server,
 * with the same routes, the same capture budget and the same drain, and its
 * requests are captured as HTTP/2 (D263). Every other connection is the
 * HTTP/1.1 server's, as with it off.
 *
 * Its work runs on `pool`, capture's own, which no call of the API uses
 * (D244).
 */
export function buildReceiver(pool: pg.Pool, options: ReceiverOptions = {}): FastifyInstance {
  const trustedProxy = compileTrust(options.trustedProxyCidrs);
  const drain = options.drain ?? new Drain();
  const app = createApp({
    logDestination: options.logDestination,
    onRoute: options.onRoute,
    trustProxy: false,
    isReceiveUrl: () => true,
    drain,
  });
  const hub = options.hub ?? new RealtimeHub();

  // No limit on the number of header lines: a webhook is stored with every
  // header it carries (D187). Node 24's default refuses a request with more
  // than 1000 header lines with `431`, well inside its size limit, which stays
  // the bound: 16 KiB of request target and header names and values, the
  // method, `:` and line breaks not counted, so about 64 KiB on the wire at
  // most. `receiver.test.ts` holds it.
  app.server.maxHeadersCount = 0;

  // `httpAllowHalfOpen` stays at Node's default, `false`, on purpose: a FIN
  // after a request aborts it, so a sender that ends its side before the
  // answer is written gets none. Through Traefik's TCP route every departure
  // of a sender reaches here as a FIN, and this is what cancels the wait of a
  // sender that gives up during a delay and records it `aborted` (D105, D109,
  // D187). `receiver.test.ts` holds it.

  // The sender address of a connection: the socket peer's, or with PROXY
  // protocol on the header's, which the layer below has read by the time it
  // hands the connection on.
  let senderOf: (socket: Socket) => string | undefined = (socket) => socket.remoteAddress;

  // Node's parser is given a connection's bytes only while fewer than 32 of
  // its requests are unanswered, in slices cut so that they cannot complete
  // more than the rest, so that a pipelining sender cannot make it parse
  // hundreds at once (D229); and only as many lines of request heads and
  // trailer sections as the header-line budget of its sender's address and
  // of the process has room for, the rest left unread until lines are given
  // back (D238). Put in front of Node's own handling before the PROXY layer,
  // which hands each connection to it once its header is read, so that it
  // bounds every connection with PROXY protocol on or off.
  boundPipelinedRequests(app.server, {
    limit: options.pipelinedRequests,
    headerLines: options.headerLines ?? createHeaderLineBudget(),
    addressOf: (socket) => senderOf(socket),
    log: app.log,
  });

  // What both instances' receive routes share: one capture budget, one set of
  // completion writes and one drain (D210, D221, D263).
  const captureBudget = options.captureBudget ?? createCaptureBudget();
  const writes = options.writes ?? new PendingWrites();
  const appOrigin = options.appOrigin ?? DEFAULT_APP_ORIGIN;
  const registerReceiveRoutes = (instance: FastifyInstance, source: SourceAddress): void => {
    // The receive host's own robots file. On qa-tools.ru the frontend's
    // keeps crawlers out of `/s/` (D183); on this host only its own can, and
    // the host was found within a minute of its certificate's issue (D187).
    instance.get('/robots.txt', async (_request, reply) => {
      return reply.type('text/plain; charset=utf-8').send(RECEIVE_ROBOTS_TXT);
    });

    void instance.register(
      webhookRoutes(pool, hub, source, captureBudget, writes, drain, appOrigin),
    );
  };

  // The HTTP/2 path (D263), behind the PROXY layer and in front of the
  // pipelining bound: a connection that opens with the preface goes to the
  // HTTP/2 instance, every other one on to the bound and Node's parser, its
  // bytes unchanged.
  if (options.http2 === 'on') {
    installHttp2(app, {
      drain,
      logDestination: options.logDestination,
      prefaceTimeoutMs: options.prefaceTimeoutMs,
      requestTimeoutMs: options.http2RequestTimeoutMs,
      sessionIdleTimeoutMs: options.http2SessionIdleTimeoutMs,
      senderOf: (socket) => senderOf(socket),
      // Counted where D227 counts: with PROXY protocol on, its bound not
      // turned off - its one-line recovery turns this one off with it.
      connectionsPerAddress:
        options.proxyProtocol === 'v2' &&
        (options.connectionsPerAddress ?? MAX_RECEIVE_CONNECTIONS_PER_ADDRESS) > 0
          ? HTTP2_MAX_CONNECTIONS_PER_ADDRESS
          : 0,
      registerReceiveRoutes,
    });
  }

  let sourceAddress: SourceAddress = (request) => request.raw.socket?.remoteAddress;

  if (options.proxyProtocol === 'v2') {
    // `loadConfig` refuses this combination too; a listener nobody may
    // connect to is never built.
    if (trustedProxy === null) {
      throw new Error('PROXY protocol on the receive listener needs a trust boundary (D187)');
    }

    // Hop 0 is the socket peer, as in Fastify's own checks of it; a CIDR
    // allow-list does not look at the hop anyway. The layer also counts the
    // connections each sender address has open (D227): without PROXY
    // protocol every connection comes from the proxy's one address, which no
    // count per address could tell apart, so there is none.
    const layer = acceptProxyProtocol(app.server, {
      isTrustedPeer: (address) => trustedProxy(address, 0),
      timeoutMs: options.proxyHeaderTimeoutMs,
      connectionsPerAddress: options.connectionsPerAddress,
      log: app.log,
    });

    sourceAddress = (request) => layer.sourceOf(request.raw.socket);
    senderOf = (socket) => layer.sourceOf(socket);

    // A connection still waiting for its header is not yet the HTTP server's,
    // so its own close would wait for the header's deadline.
    app.addHook('preClose', (done) => {
      layer.closePending();
      done();
    });
  }

  registerReceiveRoutes(app, sourceAddress);

  return app;
}

interface Http2Install {
  drain: Drain;
  logDestination?: NodeJS.WritableStream;
  prefaceTimeoutMs?: number;
  requestTimeoutMs?: number;
  sessionIdleTimeoutMs?: number;
  /** The sender address of a connection, as the HTTP/1.1 path reads it. */
  senderOf: (socket: Socket) => string | undefined;
  /**
   * How many HTTP/2 connections one sender address may have open at once
   * (`HTTP2_MAX_CONNECTIONS_PER_ADDRESS`, D266); `0` counts nothing.
   */
  connectionsPerAddress: number;
  registerReceiveRoutes: (instance: FastifyInstance, source: SourceAddress) => void;
}

/**
 * Builds the receive listener's HTTP/2 part and puts its preface layer in
 * front of `receiver`'s connection handling (D263).
 *
 * The sender address is kept per session, read from the connection once,
 * when the preface layer hands it over and Node's server opens its session:
 * an HTTP/2 request's socket is a stand-in Node makes for each stream, which
 * the PROXY layer's own record, kept per socket, does not know. Each stream
 * takes its session's address as it opens, so a stream whose session has
 * gone by the time it is stored keeps it.
 *
 * With PROXY protocol on, the HTTP/2 connections of each sender address are
 * counted as they are handed over, keyed as D227 keys them: one beyond
 * `install.connectionsPerAddress` is reset and destroyed before Node's server
 * sees it, nothing written, and only a count logged, at most once a minute -
 * as D227 refuses one over its 512, among which these are counted (D266).
 *
 * The part is ready with `receiver`, and closes with it: SIGTERM's close of
 * the listener closes every session - a GOAWAY, its streams answered, then
 * its connection - and destroys the connections still waiting for the
 * preface's decision.
 */
function installHttp2(receiver: FastifyInstance, install: Http2Install): void {
  const sessionSources = new WeakMap<Http2Session, string | undefined>();
  const streamSources = new WeakMap<ServerHttp2Stream, string | undefined>();
  const sessions = new Set<ServerHttp2Session>();
  const connections =
    install.connectionsPerAddress > 0 ? createKeyedSlots(install.connectionsPerAddress) : null;
  let refused = 0;
  const logOverBound = countedRefusals(
    receiver.log,
    'Receive HTTP/2 connections refused: their sender address had every HTTP/2 connection place taken',
    { http2ConnectionsPerAddress: install.connectionsPerAddress },
  );
  let handing: Socket | null = null;
  let closing = false;

  const app = createApp({
    logDestination: install.logDestination,
    trustProxy: false,
    isReceiveUrl: () => true,
    drain: install.drain,
    http2: {
      requestTimeoutMs: install.requestTimeoutMs,
      sessionIdleTimeoutMs: install.sessionIdleTimeoutMs,
      onStream: (stream) => {
        const session = stream.session;

        streamSources.set(stream, session === undefined ? undefined : sessionSources.get(session));
      },
    },
  });
  const server = app.server as unknown as Http2Server;

  install.drain.trackHttp2(server, sessions);

  // Emitted while the preface layer hands the connection over, before any
  // stream of it.
  server.on('session', (session) => {
    sessionSources.set(session, handing === null ? undefined : install.senderOf(handing));
    sessions.add(session);
    session.once('close', () => {
      sessions.delete(session);
    });

    // A connection handed over while the listener closes is served its
    // first stream, then closed.
    if (closing) {
      session.once('stream', () => session.close());
    }
  });

  // A place among its sender's open HTTP/2 connections, held until the
  // socket closes, however it closes; `false` when none is left, and the
  // connection is refused.
  const placeFor = (socket: Socket): boolean => {
    const sender = connections === null ? undefined : install.senderOf(socket);

    if (connections === null || sender === undefined) {
      return true;
    }

    const release = connections.tryTake(addressKey(sender));

    if (release === null) {
      return false;
    }

    socket.once('close', release);

    return true;
  };

  const preface = acceptHttp2Preface(receiver.server, {
    http2: (socket) => {
      if (!placeFor(socket)) {
        refused += 1;
        logOverBound();
        // Reset, as D227 resets its refusals, so that the proxy ends the
        // sender's connection at once; a reset that fails is emitted as an
        // `error`, which with no listener would be thrown.
        socket.on('error', () => undefined);
        socket.resetAndDestroy();

        return;
      }

      handing = socket;

      try {
        server.emit('connection', socket);
      } finally {
        handing = null;
      }

      // A FIN from the sender ends its connection and every stream on it,
      // as `httpAllowHalfOpen: false` makes it end an HTTP/1.1 request
      // (D105, D109): through Traefik's TCP route every departure of a
      // sender arrives as one. The listener's sockets are half-open ones,
      // and Node's session, which watches for their close alone, would keep
      // answering the streams of a sender that sent a GOAWAY and its FIN.
      socket.once('end', () => socket.destroy());
    },
    timeoutMs: install.prefaceTimeoutMs,
    log: receiver.log,
  });

  install.registerReceiveRoutes(app, (request) => {
    const stream = http2StreamOf(request.raw);

    return stream === undefined ? undefined : streamSources.get(stream);
  });

  receiver.addHook('onReady', async () => {
    await app.ready();
  });
  // Before the listener's own close, which waits for every connection.
  receiver.addHook('preClose', (done) => {
    closing = true;
    preface.closePending();

    for (const session of sessions) {
      session.close();
    }

    done();
  });
  // The listener has closed once every session has: each closes once its
  // streams are answered, and its connection after it.
  receiver.addHook('onClose', async () => {
    await Promise.all(
      [...sessions].map((session) => new Promise((resolve) => session.once('close', resolve))),
    );
    await app.close();
  });

  http2Parts.set(receiver, {
    app,
    server,
    sessions,
    preface,
    connections,
    get refused() {
      return refused;
    },
  });
}
