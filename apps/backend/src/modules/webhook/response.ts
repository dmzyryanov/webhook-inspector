/**
 * Writing the webhook reply: the default `{"ok":true,...}` answer, or the
 * session's configured response (D099, D101, D223).
 *
 * Both write paths take their head from one assembly and write it the same way,
 * so that the head of a body-less response cannot drift from the head of a
 * bodied one and the configured order survives on both.
 */
import type { FastifyReply } from 'fastify';
import {
  OLD_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  STATUSES_WITHOUT_BODY,
  type ResponseConfig,
  type WebhookDefaultAnswer,
} from '@webhook-inspector/shared';
import { renderTemplate, templateEscaping } from '@webhook-inspector/shared/response-template';
import type { ServerHttp2Stream } from 'node:http2';
import { http2ResponseStreamOf } from '../../lib/http2.ts';
import { composeRawResponse } from './raw-response.ts';

/**
 * Carry the id of the stored request back to the sender (D100): the header
 * under the service's name, and beside it, with the same value, its old name
 * until the day the changelog's 1.19.0 entry gives (D279).
 */
export { OLD_REQUEST_ID_HEADER, REQUEST_ID_HEADER };

/**
 * Set on every webhook response, so that a browser cannot reach its own
 * conclusion about what a body is (D101).
 */
export const CONTENT_TYPE_OPTIONS_HEADER = 'x-content-type-options';
export const NOSNIFF = 'nosniff';

/**
 * Set wherever `nosniff` is (D179). A configured `Content-Type` can make an
 * answer HTML, SVG or XML on the product's own origin, so every answer to a
 * `/s/…` URL is a sandboxed document: `sandbox` without `allow-scripts` runs no
 * script and submits no form, and gives the document an opaque origin, away
 * from the origin's cookies and `localStorage`; `default-src 'none'` loads no
 * subresource and applies no inline style. Webhook senders are servers and
 * ignore it. `Content-Security-Policy` stays reserved, so no configuration can
 * weaken it.
 */
export const CONTENT_SECURITY_POLICY_HEADER = 'content-security-policy';
export const RECEIVER_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'";

/**
 * Sent when a response has a body and its configuration names no
 * `Content-Type` of its own, which the default response never does (D101,
 * D179).
 */
const CONTENT_TYPE_HEADER = 'content-type';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Written by the receiver, from the body it is about to send. */
const CONTENT_LENGTH_HEADER = 'content-length';

const DEFAULT_STATUS = 200;

/**
 * The default answer's `message` (D223). Announced to read
 * `Captured by Webhook Inspector` from the day the changelog's 1.19.0 entry
 * gives, with the change that removes the old names (D279); until then it
 * stays as it is, since a client may compare it.
 */
export const DEFAULT_REPLY_MESSAGE = 'Captured by QA Tools';

/**
 * What is known of a request once it is stored, for its answer (D223): its id,
 * its page in the inspector and what the list and the detail say of it, each
 * value as they give it. `storeRequest` builds it in the capture's
 * transaction, after the insert, which is where the id and the time come from.
 * Nothing the request carried - body, headers, query string - is in it: a
 * template takes those from `CarriedRequest`, and its id, method and path from
 * here (D251).
 */
export interface RequestFacts {
  requestId: string;
  /** `<APP_ORIGIN>/v/<session-id>#<request-id>` (D182, D203). */
  inspectorUrl: string;
  /** The stored receipt time, `toISOString()`. */
  receivedAt: string;
  method: string;
  /** The stored path: as received, without the query string (D173). */
  path: string;
  /** The stored body's size, in bytes as received. */
  bodySize: number;
  /** The stored, normalised sender address, or `null` (D111, D187). */
  sourceIp: string | null;
}

/**
 * What a request carried, which only a template reads (D251): the query
 * string as received after its `?`, the headers as captured, in their order,
 * and the body's bytes as stored. `storeRequest` hands in the capture's own,
 * shared with nothing else, so no two captures read each other's.
 */
export interface CarriedRequest {
  queryString: string;
  headers: readonly (readonly [string, string])[];
  body: Uint8Array;
}

/**
 * A request that carried nothing, for a composition no template reads - the
 * tests' default answers and fixed bodies. `carried` is required everywhere,
 * so a caller that forgets the capture's own is a compile error, not a
 * template filled in from nothing.
 */
export const NOTHING_CARRIED: CarriedRequest = {
  queryString: '',
  headers: [],
  body: new Uint8Array(0),
};

/**
 * The exact bytes the response carries, or `null` when it carries none.
 *
 * The default answer is compact JSON with nine keys in a fixed order, `ok`
 * first and `requestId` second, as D100 allows it to be extended (D223).
 * They are named one by one, so nothing a later fact adds reaches the sender
 * unasked. Its size varies with the path, which JSON escaping at most
 * doubles. Over HTTP/1.1 Node's 16 KiB of request target and headers bounds
 * the path: well inside the 64 KiB the capture budget reserves for an answer
 * (D210). Over HTTP/2 (D263) the receive listener refuses a stream whose
 * `:path` is longer than the same 16 KiB before a request is built of it
 * (`HTTP2_MAX_PSEUDO_HEADER_BYTES`, D266), so the answer, the stored rows and
 * the realtime events see no longer path over either protocol.
 *
 * A custom body is returned as the user typed it, with no `requestId` injected:
 * the header is the only channel for the id on a custom session (D100) -
 * unless the response is a template, which the user marked it to be (D251):
 * then its placeholders are filled in by `templateBody`. A body not marked
 * never reaches that code.
 */
export function webhookResponseBody(
  response: ResponseConfig | null,
  facts: RequestFacts,
  carried: CarriedRequest,
): string | null {
  if (!response) {
    const answer: WebhookDefaultAnswer = {
      ok: true,
      requestId: facts.requestId,
      message: DEFAULT_REPLY_MESSAGE,
      inspectorUrl: facts.inspectorUrl,
      receivedAt: facts.receivedAt,
      method: facts.method,
      path: facts.path,
      bodySize: facts.bodySize,
      sourceIp: facts.sourceIp,
    };

    return JSON.stringify(answer);
  }

  if (STATUSES_WITHOUT_BODY.includes(response.status)) {
    return null;
  }

  if (response.template && response.body !== null) {
    return templateBody(response, response.body, facts, carried);
  }

  return response.body;
}

/**
 * A template's body filled in from the request it answers (D251): the id,
 * method and path from `facts`, as stored, the rest from `carried`, each
 * value escaped for the answer's effective `Content-Type` - the first
 * configured one, or the `application/json` the head sends without one - and
 * the whole at most `MAX_RESPONSE_BODY_BYTES`, a value that does not fit
 * rendering empty.
 *
 * It runs inside the capture's transaction, under the session's row lock,
 * where a throw would lose the webhook (D105, D109), so nothing may escape
 * it: a value that cannot be read renders empty in `renderTemplate` itself,
 * and anything else sends the body as configured, which is also what a body
 * that does not read as a template is sent as - saved by a version that did
 * not check it.
 */
function templateBody(
  response: ResponseConfig,
  body: string,
  facts: RequestFacts,
  carried: CarriedRequest,
): string {
  try {
    return (
      renderTemplate(
        body,
        {
          id: facts.requestId,
          method: facts.method,
          path: facts.path,
          queryString: carried.queryString,
          headers: carried.headers,
          body: carried.body,
        },
        templateEscaping(response.headers),
      ) ?? body
    );
  } catch {
    return body;
  }
}

/**
 * The complete head of a webhook response, in the order it is sent: the
 * configured pairs first, duplicates preserved, then the four headers the
 * receiver always adds - the request's id under its new name and its old one
 * (D279), `nosniff` and the sandbox - then `application/json; charset=utf-8`
 * - only when there is a body to describe and no `Content-Type` was
 * configured.
 *
 * A configured `Content-Type` is one of the configured pairs: sent as it was
 * configured, in its place, duplicates included, with no `charset` added, and
 * also when there is no body - the tester asked for it (D179).
 *
 * Names are emitted in lower case, which is what Fastify has always put on the
 * wire; HTTP field names are case-insensitive, and the configured case is not
 * promised anywhere.
 */
export function webhookResponseHeaders(
  response: ResponseConfig | null,
  requestId: string,
  hasBody: boolean,
): [string, string][] {
  const headers: [string, string][] = (response?.headers ?? []).map(([name, value]) => [
    name.toLowerCase(),
    value,
  ]);

  const configuresContentType = headers.some(([name]) => name === CONTENT_TYPE_HEADER);

  headers.push([REQUEST_ID_HEADER, requestId]);
  headers.push([OLD_REQUEST_ID_HEADER, requestId]);
  headers.push([CONTENT_TYPE_OPTIONS_HEADER, NOSNIFF]);
  headers.push([CONTENT_SECURITY_POLICY_HEADER, RECEIVER_CONTENT_SECURITY_POLICY]);

  if (hasBody && !configuresContentType) {
    headers.push([CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE]);
  }

  return headers;
}

/**
 * The connection-specific fields, which HTTP/2 forbids in a message (RFC 9113
 * §8.2.2) and Node refuses to send, `ERR_HTTP2_INVALID_CONNECTION_HEADERS`:
 * Node's own list, `te` taken whatever its value. Every one is reserved
 * (D101) but `proxy-connection` and `http2-settings`.
 */
export const HTTP2_CONNECTION_FIELDS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
  'te',
]);

/**
 * The fields Node sends at most once on an HTTP/2 response, refusing a second
 * one with `ERR_HTTP2_HEADER_SINGLE_VALUE` (`kSingleValueFields` of
 * `node:internal/http2/util`, Node 24.19.0), less its pseudo-header fields.
 * A configuration may repeat several of them - `content-type`, `location` on
 * a redirect (D247), `etag`, `retry-after` and more.
 */
export const HTTP2_SINGLE_VALUE_FIELDS: ReadonlySet<string> = new Set([
  'access-control-allow-credentials',
  'access-control-max-age',
  'access-control-request-method',
  'age',
  'authorization',
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-md5',
  'content-range',
  'content-type',
  'date',
  'dnt',
  'etag',
  'expires',
  'from',
  'host',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'last-modified',
  'location',
  'max-forwards',
  'proxy-authorization',
  'range',
  'referer',
  'retry-after',
  'tk',
  'upgrade-insecure-requests',
  'user-agent',
  'x-content-type-options',
]);

/** Spaces and tabs at either end of a value, which HTTP/2 forbids there (RFC 9113 §8.2.1). */
const EDGE_WHITESPACE = /^[ \t]+|[ \t]+$/g;

/**
 * The head of an answer as HTTP/2 sends it, from the head HTTP/1.1 would send
 * (D263): every field the validator accepts goes out but those HTTP/2 refuses,
 * by one rule, and the answer's record holds what was sent, never `failed`.
 *
 * - A connection-specific field (`HTTP2_CONNECTION_FIELDS`), which HTTP/2
 *   forbids - of a configuration, `proxy-connection` and `http2-settings` -
 *   is dropped.
 * - A field HTTP/2 sends once (`HTTP2_SINGLE_VALUE_FIELDS`) keeps its first
 *   occurrence and drops the repeats: a configured `content-type` twice is
 *   sent once, the first, which is also the one a template escapes for
 *   (D251).
 * - A value loses the spaces and tabs at its ends, which HTTP/2 forbids there
 *   and an HTTP/2 client drops the field for - as an HTTP/1.1 client reads
 *   them, optional whitespace (RFC 9110 §5.5).
 *
 * Everything else is kept, in order, duplicates included. Pure.
 */
export function http2AnswerHeaders(headers: [string, string][]): [string, string][] {
  const once = new Set<string>();
  const sent: [string, string][] = [];

  for (const [name, value] of headers) {
    if (HTTP2_CONNECTION_FIELDS.has(name)) {
      continue;
    }

    if (HTTP2_SINGLE_VALUE_FIELDS.has(name)) {
      if (once.has(name)) {
        continue;
      }

      once.add(name);
    }

    sent.push([name, value.replace(EDGE_WHITESPACE, '')]);
  }

  return sent;
}

/** The flat name/value list Node's `writeHead` takes, order and all. */
function toRawHeaders(headers: [string, string][]): string[] {
  return headers.flat();
}

/**
 * Everything one answer is made of, and everything the response record stores
 * about its content (D109).
 *
 * `body` is the bytes the representation is made of, `null` when the response
 * carries none at all; `bodySuppressed` says those bytes were produced and not
 * sent, which is only ever `HEAD`.
 */
export interface ComposedResponse {
  status: number;
  /** The exact final ordered list, `content-length` included. */
  headers: [string, string][];
  body: Buffer | null;
  bodySuppressed: boolean;
  /** The composed head, plus the body unless it was suppressed. */
  raw: Buffer;
}

/**
 * What writing an answer needs of it, and all a reply held by a configured
 * delay keeps: not `raw`, which the response record already holds (D210).
 */
export type WebhookAnswer = Pick<ComposedResponse, 'status' | 'headers' | 'body'>;

/** How writing one composed response ended. `unknown` is never one of these. */
export type SendOutcome = 'sent' | 'aborted' | 'failed';

/**
 * Builds one answer without touching the connection.
 *
 * Separate from writing it because the composition happens **before** the
 * configured delay, so a sender that disconnects mid-delay still leaves a
 * record of real content rather than an empty shell (D109). The invariant that
 * makes the split safe is not "no byte is written" but "nothing that can flush
 * the head": this function does neither, and `reply.hijack()` stays at write
 * time.
 *
 * `content-length` is appended here rather than at write time, so the stored
 * header list is the exact list `writeHead` is given. Composing it anywhere
 * later would make every bodied response store a head that differs from the one
 * `writeHead` was given, and the `Raw` and `Headers` views would quietly
 * disagree.
 *
 * `facts` is the request just stored: its id is the header's, its method
 * decides `HEAD`, and the default answer says all of it (D223). `carried` is
 * what it carried, which a template reads (D251); `content-length` is that
 * of the body as this request fills it in, which for a template naming
 * `{{request.method}}` is not the body a `GET` would be sent.
 *
 * `http2` is an answer over HTTP/2 (D263): its head is HTTP/2's
 * (`http2AnswerHeaders`), stored as sent, and its raw form reads `:status`
 * first (`composeRawResponse`).
 */
export function composeWebhookResponse(
  response: ResponseConfig | null,
  facts: RequestFacts,
  carried: CarriedRequest,
  http2 = false,
): ComposedResponse {
  const { method } = facts;
  const status = response?.status ?? DEFAULT_STATUS;
  const text = webhookResponseBody(response, facts, carried);
  const configured = webhookResponseHeaders(response, facts.requestId, text !== null);
  const headers = http2 ? http2AnswerHeaders(configured) : configured;
  const body = text === null ? null : Buffer.from(text, 'utf8');

  if (body !== null) {
    headers.push([CONTENT_LENGTH_HEADER, String(body.byteLength)]);
  }

  // `HEAD` announces the representation and sends none of it, which is the
  // whole HEAD contract; the raw record therefore holds the head alone (D064,
  // D109).
  const bodySuppressed = method === 'HEAD' && body !== null;

  return {
    status,
    headers,
    body,
    bodySuppressed,
    raw: composeRawResponse(status, headers, bodySuppressed ? null : body, http2),
  };
}

/**
 * Answers one stored request with an already composed response, and reports how
 * the write ended.
 *
 * The head is written with `writeHead` and a flat name/value list, which is the
 * only representation Node puts on the wire verbatim: collapsing the pairs into
 * an object would hoist a digit-only name - a valid HTTP token the validator
 * accepts - to the front, contradicting the promise that configured headers are
 * sent in the configured order (D101).
 *
 * Writing the head ourselves also settles the framing. Fastify stamps
 * `content-length: 0` on a body-less response of every status that permits a
 * body, which contradicts the rule that a response with no body announces no
 * representation at all (D101); here the header is simply not written. A
 * hijacked reply runs no onSend hook, so this path carries the request id,
 * `nosniff` and the sandbox policy from the same assembly rather than from the hook that covers the
 * error responses.
 *
 * `HEAD` is deliberately not special-cased on the wire either: the body is
 * handed to `end` as it would be for any other method and Node suppresses the
 * bytes itself.
 *
 * `onSettled` is what the outcome is recorded from, and the three cases are
 * distinguished deliberately (D109):
 *
 * - `sent` is reported from the `finish` event, which is emitted once the
 *   writable side has ended - `writableFinished`, which is what D109 defines
 *   the state as. Reporting it on the line after `end` would assert something
 *   that has not happened: `end` queues the write. The event is used rather
 *   than `end`'s callback because `end`'s own signature is the one thing here
 *   that must not change: it carries the body, and a `HEAD` response depends on
 *   Node receiving that body and suppressing it itself.
 * - `aborted` is the connection closing before the write finished. It is the
 *   client going away.
 * - `failed` is our own write call throwing. It is our fault, not the
 *   sender's, and no valid input reaches it (D101). The reply is hijacked and
 *   the throw left the socket with nothing to end it, so this path destroys it
 *   rather than leaving the sender to wait indefinitely: `requestTimeout`
 *   covers only a request still arriving (D172).
 *
 * Only the first outcome is reported: a socket that closes after a `failed`
 * write must not restate the answer.
 *
 * `closeConnection` is the process's drain (D221), for an answer to its
 * socket's only request in flight (`Drain.closes`), or an answer written
 * before its request's body has all arrived (D227): the answer then ends its
 * connection. Node writes `Connection: close` itself, as it writes
 * `Connection: keep-alive` otherwise - framing, beside the composed head, not
 * part of it, so the stored record is unchanged - and closes the connection
 * once the answer is written. A configured response cannot name
 * `Connection`: it is reserved (D101).
 *
 * An answer over HTTP/2 is written to its stream instead
 * (`sendOverHttp2`), and never closes anything: `closeConnection` is
 * HTTP/1.1's.
 */
export function sendWebhookResponse(
  reply: FastifyReply,
  composed: WebhookAnswer,
  onSettled: (outcome: SendOutcome) => void,
  closeConnection = false,
): FastifyReply {
  let settled = false;
  const settle = (outcome: SendOutcome): void => {
    if (settled) {
      return;
    }

    settled = true;
    onSettled(outcome);
  };

  reply.hijack();

  const stream = http2ResponseStreamOf(reply.raw);

  if (stream !== undefined) {
    sendOverHttp2(stream, composed, settle);

    return reply;
  }

  // Both registered before the write, so a connection that dies during it is
  // still observed. A normally completed response emits `close` too, which is
  // why the abort guard is `writableFinished` rather than the event itself.
  reply.raw.once('finish', () => settle('sent'));
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) {
      settle('aborted');
    }
  });

  if (closeConnection) {
    reply.raw.shouldKeepAlive = false;
  }

  try {
    reply.raw.writeHead(composed.status, toRawHeaders(composed.headers));

    if (composed.body === null) {
      reply.raw.end();
    } else {
      reply.raw.end(composed.body);
    }
  } catch {
    settle('failed');
    reply.raw.destroy();
  }

  return reply;
}

/**
 * Writes a composed answer to its HTTP/2 stream (D263): the head with
 * `respond` and a flat list, `:status` first, which Node sends in that order,
 * duplicates in place, as HTTP/1.1's `writeHead` does - Node's compatibility
 * response would gather it into an object and send a repeated name's values
 * together and a digit-only name first - then the body. The head is
 * `http2AnswerHeaders`', which Node refuses nothing of. A `HEAD` is not
 * special-cased here either: `respond` ends a `HEAD`'s stream with the head,
 * as it ends a `204`, `205` or `304`'s, and the body is never written.
 *
 * The outcomes are HTTP/1.1's (D109): `sent` once the answer is written
 * whole to the session - the stream's `finish`; for a `HEAD`, the return of
 * `respond`, which finishes it; or, for a stream Node destroys first,
 * nghttp2's own word that the stream's local side was closed, which only the
 * frame carrying END_STREAM does. Node closes a stream whose request it has
 * read as soon as that frame is out, before `finish`, and its destroy is the
 * last moment the stream's state can be read (`stream.state.localClose`).
 * `aborted` when the stream closes otherwise - a reset by the sender, with
 * whatever code, before that frame left, a GOAWAY, the connection gone, or a
 * destroy with an error - or has already, and `failed` when the write throws,
 * the stream then reset.
 *
 * The body's write callback is not read: Node 24.19.0 calls it back
 * `ECANCELED` for a body flow control still holds when the sender resets the
 * stream, Node 24.22.1 calls it back without an error as it destroys the
 * stream - for a reset with `NO_ERROR` or `CANCEL` - whether the body went out
 * or not. nghttp2's state is the same in both.
 */
function sendOverHttp2(
  stream: ServerHttp2Stream,
  composed: WebhookAnswer,
  settle: (outcome: SendOutcome) => void,
): void {
  if (stream.destroyed || stream.closed) {
    settle('aborted');

    return;
  }

  // Read as Node destroys the stream, the first time, while its handle is
  // there: a destroy with an error is never taken for an answer out.
  let endStreamSent = false;
  const destroy = stream.destroy;

  stream.destroy = ((...args: Parameters<ServerHttp2Stream['destroy']>) => {
    if (!stream.destroyed) {
      endStreamSent = (args[0] === undefined || args[0] === null) && endStreamOut(stream);
    }

    return destroy.apply(stream, args);
  }) as ServerHttp2Stream['destroy'];

  stream.once('finish', () => settle('sent'));
  stream.once('close', () => settle(endStreamSent || stream.writableFinished ? 'sent' : 'aborted'));

  try {
    stream.respond([':status', String(composed.status), ...toRawHeaders(composed.headers)]);

    if (!stream.writableEnded) {
      if (composed.body !== null) {
        stream.write(composed.body);
      }

      stream.end();
    }
  } catch {
    settle('failed');
    stream.destroy();

    return;
  }

  // A `HEAD`'s writable side has finished inside `respond`, and Node emits no
  // `finish` for it (Node 24.19.0).
  if (stream.writableFinished) {
    settle('sent');
  }
}

/**
 * Whether nghttp2 has sent the frame with the stream's END_STREAM, the only
 * frame that closes the stream's local side (D263 point 8). Node reads the
 * stream's state from nghttp2 while the stream is not destroyed; a stream
 * whose session is going, or whose state cannot be read, is not taken for one
 * whose answer is out.
 */
function endStreamOut(stream: ServerHttp2Stream): boolean {
  const session = stream.session;

  if (session === undefined || session.destroyed) {
    return false;
  }

  try {
    return stream.state.localClose === 1;
  } catch {
    return false;
  }
}
