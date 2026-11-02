/**
 * The transport of `/mcp` (D203): MCP's Streamable HTTP, stateless, every
 * `POST` answered with one JSON object, written by hand rather than with the
 * SDK. What a request is checked for before any tool runs, and how JSON-RPC
 * answers are shaped. Pure, so every rule is tested without a server, and with
 * made-up input at growing sizes.
 *
 * Every check reads its input once, from left to right, and stops at the first
 * thing that decides it: nothing here is worse than linear in what a client
 * sent, and the body itself is bounded by the listener's 1 MiB.
 */
import {
  MCP_ASSUMED_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  MCP_REQUEST_ID_MAX_LENGTH,
  type McpProtocolVersion,
} from '@webhook-inspector/shared/mcp';

/** JSON-RPC 2.0's own error codes, and the one MCP's transport uses for its refusals. */
export const RpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** A refusal of the transport: a foreign `Origin`, a query string, a method, a limit, a version. */
  SERVER_ERROR: -32000,
} as const;

export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

/**
 * A JSON-RPC id: a string of at most `MCP_REQUEST_ID_MAX_LENGTH` characters,
 * or an integer JavaScript represents exactly.
 */
export type RpcId = string | number;

/**
 * What the server reads of a request's `params`: `name` and `arguments` of a
 * `tools/call`, `protocolVersion` of an `initialize`, and nothing of any other
 * method; `_meta` and a key the server does not know are not kept. `arguments`
 * is the parsed object itself, read once by the tool's checks in the handler's
 * synchronous part (`readCall`): no call keeps it, nor anything else of the
 * message, once it starts to run (D203).
 */
export interface RequestParams {
  name?: unknown;
  arguments?: unknown;
  protocolVersion?: unknown;
}

/** One JSON-RPC message, as the body of a `POST /mcp` held it. */
export type ParsedMessage =
  | { kind: 'request'; id: RpcId; method: string; params: RequestParams }
  | { kind: 'notification'; method: string }
  | { kind: 'response' }
  | {
      kind: 'invalid';
      code: typeof RpcErrorCode.PARSE_ERROR | typeof RpcErrorCode.INVALID_REQUEST;
      message: string;
    };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A string with the same UTF-16 code units as `value`, lone surrogates
 * included, made from them anew: whatever `value` is inside V8 - a slice of
 * the text it was read from, a concatenation - the copy shares no memory with
 * it. For the caller's strings a call keeps while it runs (D203).
 */
export function ownCopy(value: string): string {
  return Buffer.from(value, 'utf16le').toString('utf16le');
}

/**
 * Whether a request's `id` is one the server echoes: a string no longer than
 * `MCP_REQUEST_ID_MAX_LENGTH`, or an integer JavaScript represents exactly -
 * so not `1.5`, not `2 ** 53`, never `null`. The answer carries the id, so a
 * call that waits holds it - its own copy - and bounded, it is a few hundred
 * bytes at most (D203).
 */
function isRpcId(value: unknown): value is RpcId {
  return (
    (typeof value === 'string' && value.length <= MCP_REQUEST_ID_MAX_LENGTH) ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  );
}

const INVALID_ID = `Invalid Request: id must be a string of at most ${MCP_REQUEST_ID_MAX_LENGTH} characters or an integer from -${Number.MAX_SAFE_INTEGER} to ${Number.MAX_SAFE_INTEGER}`;

/** The parts of `params` the server reads, by method; any other method reads none. */
const READ_PARAMS = new Map<string, readonly (keyof RequestParams)[]>([
  ['tools/call', ['name', 'arguments']],
  ['initialize', ['protocolVersion']],
]);

/** A new object holding only the parts of `params` the method reads, those present. */
function readParams(method: string, params: Record<string, unknown> | undefined): RequestParams {
  const read: RequestParams = {};

  for (const key of READ_PARAMS.get(method) ?? []) {
    if (params !== undefined && Object.hasOwn(params, key)) {
      read[key] = params[key];
    }
  }

  return read;
}

/**
 * The one JSON-RPC message a body holds.
 *
 * Not UTF-8 or not JSON is a parse error, `-32700`. A batch - a JSON array -
 * is refused as an invalid request, `-32600`: the current protocol has none,
 * and the SDK's client never sends one (D203). So is anything that is not a
 * JSON-RPC 2.0 request, notification or response: a request's `id` must be a
 * string of at most `MCP_REQUEST_ID_MAX_LENGTH` characters or an integer
 * JavaScript represents exactly, and never `null`, as MCP requires; its
 * `params`, when present, an object.
 *
 * Of a request's `params` only what the server reads is kept (`RequestParams`),
 * and the `id` is the server's own copy (`ownCopy`). A call that runs - a
 * `wait_for_request` for up to 30 s - keeps the id and what its tool's checks
 * built (`readCall`), never this message, so nothing it holds is sized by
 * what the caller chose to send besides (D203).
 *
 * Keys are read as own properties only, so a `__proto__` key in the body is a
 * key like any other and nothing is merged anywhere.
 */
export function parseMessage(body: Buffer | undefined): ParsedMessage {
  if (body === undefined || body.length === 0) {
    return { kind: 'invalid', code: RpcErrorCode.PARSE_ERROR, message: 'Parse error: no body' };
  }

  let value: unknown;

  try {
    value = JSON.parse(utf8.decode(body)) as unknown;
  } catch {
    // Bytes that are not UTF-8, a syntax error, or a nesting too deep for the parser.
    return {
      kind: 'invalid',
      code: RpcErrorCode.PARSE_ERROR,
      message: 'Parse error: invalid JSON',
    };
  }

  if (Array.isArray(value)) {
    return {
      kind: 'invalid',
      code: RpcErrorCode.INVALID_REQUEST,
      message: 'Invalid Request: batches are not supported; send one message per request',
    };
  }

  const invalid: ParsedMessage = {
    kind: 'invalid',
    code: RpcErrorCode.INVALID_REQUEST,
    message: 'Invalid Request: not a JSON-RPC 2.0 request, notification or response',
  };

  if (!isPlainObject(value) || value.jsonrpc !== '2.0') {
    return invalid;
  }

  const has = (key: string): boolean => Object.hasOwn(value, key);

  if (has('method')) {
    if (typeof value.method !== 'string') {
      return invalid;
    }

    if (has('params') && !isPlainObject(value.params)) {
      return invalid;
    }

    if (!has('id')) {
      return { kind: 'notification', method: value.method };
    }

    if (!isRpcId(value.id)) {
      return { kind: 'invalid', code: RpcErrorCode.INVALID_REQUEST, message: INVALID_ID };
    }

    return {
      kind: 'request',
      id: typeof value.id === 'string' ? ownCopy(value.id) : value.id,
      method: value.method,
      params: readParams(
        value.method,
        has('params') ? (value.params as Record<string, unknown>) : undefined,
      ),
    };
  }

  // A response to a request this server never sends: accepted, as the
  // transport requires, and nothing is done with it.
  if (has('id') && (has('result') || has('error'))) {
    return { kind: 'response' };
  }

  return invalid;
}

/**
 * Whether a `tools/call` of `create_session`: the one call that counts toward
 * the session creations, every other request toward the API calls (D203).
 */
export function isCreateSessionCall(message: ParsedMessage | null): boolean {
  return (
    message !== null &&
    message.kind === 'request' &&
    message.method === 'tools/call' &&
    message.params.name === 'create_session'
  );
}

/** Longer than any origin the configuration can hold: such a value is never one. */
const MAX_ORIGIN_LENGTH = 2048;

/**
 * Whether the `Origin` headers of a request let it in (D203). The MCP
 * specification asks a server to validate `Origin`, against DNS rebinding:
 * an agent's client sends none, and a browser sends its page's.
 *
 * No `Origin` at all is let in; so is exactly one, equal byte for byte to one
 * of the application's own origins, as a browser on `qa-tools.ru` or, since
 * D275, on `webhook.qa-tools.ru` sends it: `appOrigins` is `APP_ORIGIN` and,
 * when it is set, `APP_ALIAS_ORIGIN`. Anything else is refused: another site,
 * `null`, an own origin in another case, with a path or a trailing slash, two
 * `Origin` headers, an empty one. `values` is every `Origin` header the
 * request carried, read from its raw headers.
 */
export function isAllowedOrigin(values: readonly string[], appOrigins: readonly string[]): boolean {
  if (values.length === 0) {
    return true;
  }

  if (values.length > 1) {
    return false;
  }

  const [origin] = values as [string];

  return origin.length <= MAX_ORIGIN_LENGTH && appOrigins.includes(origin);
}

/**
 * Whether a request target, as it arrived, carries a query string (D203):
 * anything from its first `?` or `#`, an empty `?` or `#` included. Fastify's
 * router ends the path at either, so `/mcp?…` and `/mcp#…` both reach `/mcp`,
 * and a `#` makes what follows it `request.query` as a `?` does. MCP's
 * Streamable HTTP uses none, and a request that carried one would keep it -
 * up to Node's 16 KiB for the request target and the headers together - for
 * as long as the request is held, a `wait_for_request`'s 30 s among them, so
 * `/mcp` refuses it before its body is read. An escaped `%3F` or `%23` is no
 * query string: the router decodes it into the path, which then is not
 * `/mcp`.
 */
export function hasQueryString(url: string): boolean {
  return url.includes('?') || url.includes('#');
}

/** Every value of a header, from a request's raw headers, the name compared in ASCII lower case. */
export function rawHeaderValues(rawHeaders: readonly string[], name: string): string[] {
  const values: string[] = [];

  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const key = rawHeaders[index] as string;

    if (key.length === name.length && key.toLowerCase() === name) {
      values.push(rawHeaders[index + 1] as string);
    }
  }

  return values;
}

/** A quality value as RFC 9110 writes one: `0` to `1` with at most three decimals. */
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * How specifically a media range of an `Accept` header names
 * `application/json`, with its quality: `3` for `application/json` itself,
 * `2` for `application/*`, `1` for `*\/*`, and `0` for a range that does not
 * name it at all. Parameters other than `q` are ignored; a `q` that is not a
 * quality value makes the range name nothing.
 */
function jsonRange(range: string): { specificity: number; quality: number } {
  const semicolon = range.indexOf(';');
  // Longer than `application/json` with room for white space: no such range.
  const type = (semicolon < 0 ? range : range.slice(0, semicolon)).trim();

  if (type.length > 16) {
    return { specificity: 0, quality: 0 };
  }

  const name = type.toLowerCase();
  const specificity =
    name === 'application/json' ? 3 : name === 'application/*' ? 2 : name === '*/*' ? 1 : 0;

  if (specificity === 0 || semicolon < 0) {
    return { specificity, quality: specificity === 0 ? 0 : 1 };
  }

  let quality = 1;

  for (const parameter of range.slice(semicolon + 1).split(';')) {
    const equals = parameter.indexOf('=');
    const key = (equals < 0 ? parameter : parameter.slice(0, equals)).trim().toLowerCase();

    if (key === 'q') {
      const text = equals < 0 ? '' : parameter.slice(equals + 1).trim();

      if (!QVALUE.test(text)) {
        return { specificity: 0, quality: 0 };
      }

      quality = Number(text);
    }
  }

  return { specificity, quality };
}

/**
 * Whether the client takes the one thing `/mcp` answers with, JSON (D203).
 *
 * The specification has a client list both `application/json` and
 * `text/event-stream`. A server that never streams needs only the first, so
 * that is all this asks: a request without `Accept`, or with an empty one,
 * takes anything; otherwise the most specific range naming `application/json`
 * - itself, then `application/*`, then `*\/*` - must have a quality above
 * zero. One that names no such range, or rules JSON out with `q=0`, is
 * answered `406`.
 */
export function acceptsJson(accept: string | undefined): boolean {
  if (accept === undefined || accept.trim() === '') {
    return true;
  }

  let best = { specificity: 0, quality: 0 };

  for (const range of accept.split(',')) {
    const found = jsonRange(range);

    if (found.specificity > best.specificity) {
      best = found;
    } else if (found.specificity === best.specificity && found.quality > best.quality) {
      best = found;
    }
  }

  return best.specificity > 0 && best.quality > 0;
}

function isProtocolVersion(value: unknown): value is McpProtocolVersion {
  return typeof value === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

/**
 * The version `initialize` answers: the one the client asked for when this
 * server speaks it, and the newest it speaks otherwise, which the client may
 * then decline, as the specification's negotiation has it.
 */
export function negotiateProtocolVersion(requested: unknown): McpProtocolVersion {
  return isProtocolVersion(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
}

/**
 * The version a request after `initialize` declares in its
 * `MCP-Protocol-Version` header, or `null` when it declares one this server
 * does not speak, which is answered `400`. A request without the header is
 * taken to speak 2025-03-26, as the specification has it; two headers are
 * one value Node joins with a comma, which is no version.
 */
export function declaredProtocolVersion(header: string | undefined): McpProtocolVersion | null {
  if (header === undefined) {
    return MCP_ASSUMED_PROTOCOL_VERSION;
  }

  return isProtocolVersion(header) ? header : null;
}

/** A JSON-RPC result. */
export function rpcResult(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/**
 * A JSON-RPC error: `id` is the request's when it had one, `null` for a
 * refusal of the transport, a notification or a message whose id cannot be
 * read. The message is the server's own and quotes nothing the request sent.
 */
export function rpcError(
  id: RpcId | null,
  code: RpcErrorCode,
  message: string,
  data?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}
