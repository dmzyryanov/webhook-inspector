/**
 * The seven tools of `/mcp` (D203), each a thin layer over the service
 * functions the API's routes call, with the API's rules, answers and uses of a
 * session (D133): only `set_response` moves a session's expiry, as only the
 * response change does among these calls. Whatever a route publishes to the
 * session's viewers, the tool publishes too, so a viewer, and a list call
 * waiting on the session, cannot tell an agent's call from the API's.
 *
 * A refusal is a tool error naming the API's `errorCode` and the rule, never a
 * value the call sent (D106). Arguments are checked in the API's order: the
 * ids the call needs, then the API's rules for the rest, an unknown argument
 * last, then the session.
 *
 * Every tool that takes a `sessionId` hands its service the access key the
 * call presented, `Authorization: Bearer <key>` on the `POST` (`context.key`),
 * which the service checks where it would find the session missing (D245): a
 * keyed session the key does not open is the not-found tool error, `1001`.
 * `create_session` with `private: true` creates its session under that key,
 * and is refused `1005` when the call presented none (D253): the tools never
 * draw a key, which the agent could not present on its next call.
 *
 * Every tool is two steps (D203): `read` checks the parsed arguments in the
 * handler's synchronous part and builds what the call needs anew; `run` gets
 * only that, so no call that runs - a `wait_for_request` for up to 30 s -
 * holds the arguments object, whose size inside V8 the caller decides:
 * 100,000 duplicate keys are two keys to `Object.keys` and megabytes of
 * property table behind them.
 */
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import {
  buildInspectorUrl,
  ErrorCode,
  REQUEST_LIST_MAX_WAIT_SECONDS,
  REQUEST_QUERY_MAX_CONDITIONS,
} from '@webhook-inspector/shared';
import {
  MCP_LIST_DEFAULT_LIMIT,
  MCP_LIST_MAX_LIMIT,
  MCP_TOOL_NAMES,
  type McpToolName,
} from '@webhook-inspector/shared/mcp';
import { AppError, invalidListQuery, invalidResponseConfig } from '../../errors/app-error.ts';
import { inSessionLine, NO_WAIT_SLOT, type WaitSlot } from '../limits/api-work.ts';
import type { RealtimeHub } from '../realtime/hub.ts';
import type { ListedEntry } from '../requests/list-answer.ts';
import {
  isOrder,
  parseBodyConditions,
  parseHeaderConditions,
  RULES,
  sinceBound,
  type ListQuery,
} from '../requests/list-query.ts';
import type { QuerySlots } from '../requests/search.ts';
import {
  clearRequests,
  getRequestDetails,
  listedContentReader,
  listRequests,
  queryRequests,
  waitForRequests,
} from '../requests/service.ts';
import type { PendingWaits } from '../requests/wait.ts';
import {
  parsePrivate,
  parseResponse,
  parseResponseChange,
  parseSessionExpiry,
  parseStoreSourceIp,
} from '../sessions/response-config.ts';
import type { PresentedKey } from '../sessions/access-key.ts';
import { changeSessionResponse, createSession, deleteSession } from '../sessions/service.ts';
import { receiveUrlFor } from '../webhook/receive-url.ts';
import {
  agentBody,
  capturedResult,
  contentTypeOf,
  errorResult,
  plainResult,
  UNTRUSTED,
  type CallToolResult,
} from './captured.ts';
import { ownCopy } from './protocol.ts';

/** What a tool needs of the listener it runs on. */
export interface ToolContext {
  pool: pg.Pool;
  hub: RealtimeHub;
  /** The request list's pending waits, which a shutdown runs out (D200). */
  waits: PendingWaits;
  /**
   * The places of searches and queries: a list with a body condition takes
   * one of the search's, a list with header conditions alone one of the
   * header-only queries' (D191, D196, D250).
   */
  querySlots: QuerySlots;
  searchTimeoutMs: number;
  /** The receive host's origin, which `receiveUrl` names (D187). */
  receiveOrigin: string;
  /** The application's origin, which the inspector links name. */
  appOrigin: string;
  /** Aborted once the client has gone: a wait ends with no answer. */
  signal: AbortSignal;
  /**
   * The call's slot in the gate in front of the API's work, which
   * `wait_for_request` holds while it reads and gives back while it waits,
   * and `set_response` and `clear_requests` give back before they join the
   * session's line (D244). Absent, none.
   */
  slot?: WaitSlot;
  log: FastifyBaseLogger;
  /**
   * The access key the call presented, `Authorization: Bearer <key>`, or
   * `null` (D245). Checked by the services against the session a tool names;
   * a public session ignores it.
   */
  key: PresentedKey;
}

/** A call whose arguments break a rule of the tool's own, not one of the API's. */
class ArgumentError extends Error {}

const ERROR_NAMES = new Map<number, string>(
  Object.entries(ErrorCode).map(([name, code]) => [code, name]),
);

/**
 * What an agent can do about a refusal, for the codes a tool can meet. None
 * for `1012` and `1015`, whose API message ends with it already - `try again
 * in a moment`, `try again in <n> s` - so that it is said once. `1001`'s
 * names the private case too, the same for every session, so that it says
 * nothing about whether this one exists or is private (D245).
 */
const HINTS: Partial<Record<number, string>> = {
  [ErrorCode.SESSION_NOT_FOUND]:
    'The session does not exist or was deleted, or it is private and this call did not present its access key: for a private session, check the Authorization header your MCP client sends to this server; otherwise create a new one with create_session.',
  [ErrorCode.SESSION_EXPIRED]: 'The session has expired: create a new one with create_session.',
  [ErrorCode.REQUEST_NOT_FOUND]:
    "The session holds no such request: the id is not one of this session's request ids, or the request was deleted, cleared or pushed out by the newest 1000.",
  [ErrorCode.INVALID_RESPONSE_CONFIG]: 'Fix that rule and call again.',
  [ErrorCode.INVALID_LIST_QUERY]: 'Fix that argument and call again.',
  [ErrorCode.SEARCH_TIMED_OUT]: 'Narrow the conditions, or try again.',
  [ErrorCode.INTERNAL_ERROR]: 'Try again later.',
};

/**
 * The text of a tool error for an API refusal: the `errorCode`, its name, the
 * API's message - which names the rule and never a value (D106) - and what to
 * do about it, unless the message has said it.
 */
export function apiErrorText(error: AppError): string {
  const name = ERROR_NAMES.get(error.errorCode) ?? 'ERROR';
  const hint = HINTS[error.errorCode];

  return `errorCode ${error.errorCode} ${name}: ${error.message}.${hint === undefined ? '' : ` ${hint}`}`;
}

const INTERNAL_ERROR = new AppError(ErrorCode.INTERNAL_ERROR, 500, 'Internal server error');

/**
 * The refusal of `create_session` with `private: true` on a call that
 * presented no key (D253). Names the rule, never a value (D106).
 */
export const MCP_PRIVATE_KEY_RULE =
  'private: true needs an access key in the Authorization header of /mcp: Bearer and 43 characters of A-Z, a-z, 0-9, _ and -; the tools never draw one';

/** The keys a tool takes, in the order its refusal names them. */
const ARGUMENTS: Record<McpToolName, readonly string[]> = {
  create_session: [
    'response',
    'expiresInSeconds',
    'expiresAfterIdleSeconds',
    'storeSourceIp',
    'private',
  ],
  set_response: ['sessionId', 'mode', 'response'],
  wait_for_request: ['sessionId', 'wait', 'after', 'limit', 'order'],
  list_requests: ['sessionId', 'limit', 'order', 'after', 'since', 'headers', 'body'],
  get_request: ['sessionId', 'requestId'],
  clear_requests: ['sessionId'],
  delete_session: ['sessionId'],
};

function listed(keys: readonly string[]): string {
  return keys.length === 1
    ? (keys[0] as string)
    : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1) as string}`;
}

/** Refuses any argument the tool does not take, without naming it: a name is the caller's text. */
function rejectUnknownArguments(tool: McpToolName, args: Record<string, unknown>): void {
  const known = ARGUMENTS[tool];

  for (const key of Object.keys(args)) {
    if (!known.includes(key)) {
      throw new ArgumentError(
        `Invalid arguments: ${tool} takes no argument other than ${listed(known)}`,
      );
    }
  }
}

/**
 * A required id argument: present and a string, answered as the server's own
 * copy. Its shape is the service's to check (D058, D066), before any database
 * work and before a wait begins.
 */
function requiredId(args: Record<string, unknown>, key: 'sessionId' | 'requestId'): string {
  const value = Object.hasOwn(args, key) ? args[key] : undefined;

  if (typeof value !== 'string') {
    throw new ArgumentError(`Invalid arguments: ${key} is required and must be a string`);
  }

  return ownCopy(value);
}

function has(args: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(args, key);
}

const LIMIT_RULE = `limit must be an integer from 1 to ${MCP_LIST_MAX_LIMIT}`;

/** `limit`: 1 to `MCP_LIST_MAX_LIMIT`, `MCP_LIST_DEFAULT_LIMIT` when absent; `400` / `1013` otherwise. */
function limitOf(args: Record<string, unknown>): number {
  if (!has(args, 'limit')) {
    return MCP_LIST_DEFAULT_LIMIT;
  }

  const value = args.limit;

  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MCP_LIST_MAX_LIMIT
  ) {
    throw invalidListQuery(LIMIT_RULE);
  }

  return value;
}

/** `order`, `desc` when absent, answered as the server's own literal. */
function orderOf(args: Record<string, unknown>): ListQuery['order'] {
  const order = has(args, 'order') ? args.order : 'desc';

  if (!isOrder(order)) {
    throw invalidListQuery(RULES.order);
  }

  return order === 'asc' ? 'asc' : 'desc';
}

/** `after`, a string, answered as the server's own copy; its shape is the service's to check. */
function afterOf(args: Record<string, unknown>): string | null {
  if (!has(args, 'after')) {
    return null;
  }

  if (typeof args.after !== 'string') {
    throw invalidListQuery(RULES.afterField);
  }

  return ownCopy(args.after);
}

/** A list with no `include`, as the plain list is asked for (D196). */
function listQuery(fields: Partial<ListQuery>): ListQuery {
  return {
    includeHeaders: false,
    includeBody: false,
    limit: MCP_LIST_DEFAULT_LIMIT,
    order: 'desc',
    after: null,
    receivedAfter: null,
    headers: [],
    bodies: [],
    wait: null,
    ...fields,
  };
}

/**
 * The listed requests as `list_requests` and `wait_for_request` return them:
 * the list's metadata, and in `untrustedCapturedContent` the path and the
 * `Content-Type` the sender wrote. The headers are read by the list's own
 * content reader once the list is chosen (D196); a request gone in between has
 * no `Content-Type` to give, and keeps the metadata it was listed with.
 */
async function listedRequests(
  context: ToolContext,
  sessionId: string,
  query: ListQuery,
  chosen: readonly ListedEntry[],
): Promise<CallToolResult> {
  const read = listedContentReader(context.pool, sessionId, {
    ...query,
    includeHeaders: true,
    includeBody: false,
  });
  const content = chosen.length === 0 ? new Map() : await read(chosen.map(({ entry }) => entry.id));

  return capturedResult({
    requests: chosen.map(({ entry }) => ({
      id: entry.id,
      method: entry.method,
      receivedAt: entry.receivedAt,
      bodySize: entry.bodySize,
      sourceIp: entry.sourceIp,
      // Its state and status alone, as `get_request` gives them: the queue's
      // step a list row carries since 0.46.0 is not part of these tools'
      // answers (D203, D205).
      response:
        entry.response === null
          ? null
          : { state: entry.response.state, status: entry.response.status },
      [UNTRUSTED]: {
        path: entry.path,
        contentType: contentTypeOf(content.get(entry.id)?.headers),
      },
    })),
  });
}

/**
 * A tool call whose arguments are read and checked, ready to run: it holds
 * what its tool's `read` built and nothing of the message (D203).
 */
export type ToolCall = (context: ToolContext) => Promise<CallToolResult | null>;

/** Reads and checks a tool's parsed arguments, and answers the call they come to. */
type Tool = (args: Record<string, unknown>) => ToolCall;

/**
 * A tool of two steps (D203). `read` checks every argument and answers what
 * the call needs, built anew from what the checks let through: new objects,
 * numbers, the server's own strings, and the caller's strings it keeps - an
 * id as the server's own copy (`ownCopy`), a header condition or a configured
 * response as JSON.parse's copy, which shares nothing with the text it was
 * read from either (`mcp-memory.test.ts`). `run` takes only that.
 */
function tool<V>(
  read: (args: Record<string, unknown>) => V,
  run: (values: V, context: ToolContext) => Promise<CallToolResult | null>,
): Tool {
  return (args) => bound(run, read(args));
}

/**
 * `run` with `values`, as a call. A function of its own, so that the call
 * closes over these two alone and never over the arguments `read` was given.
 */
function bound<V>(
  run: (values: V, context: ToolContext) => Promise<CallToolResult | null>,
  values: V,
): ToolCall {
  return (context) => run(values, context);
}

const TOOLS: Record<McpToolName, Tool> = {
  // `POST /api/sessions` with a body of `{ response, expiresInSeconds }` or
  // `{ response, expiresAfterIdleSeconds }`, and `storeSourceIp` and
  // `private`, any of them, or none; checked in the API's order by its own
  // functions, the response first, then the two expiry keys and the two
  // together, then the address choice, then `private` (D220, D242, D243,
  // D253). A private session is created under the call's key, and without
  // one the call is refused `1005` before anything is written: the tools
  // never draw a key (D253).
  create_session: tool(
    (args) => {
      const response = has(args, 'response') ? parseResponse(args.response) : null;
      const expiry = parseSessionExpiry(args);
      const storeSourceIp = has(args, 'storeSourceIp')
        ? parseStoreSourceIp(args.storeSourceIp)
        : true;
      const isPrivate = has(args, 'private') ? parsePrivate(args.private) : false;

      rejectUnknownArguments('create_session', args);

      return { response, expiry, storeSourceIp, isPrivate };
    },
    async ({ response, expiry, storeSourceIp, isPrivate }, context) => {
      if (isPrivate && context.key === null) {
        throw invalidResponseConfig(MCP_PRIVATE_KEY_RULE);
      }

      const session = await createSession(
        context.pool,
        response,
        null,
        expiry.expiresInSeconds,
        expiry.expiresAfterIdleSeconds,
        storeSourceIp,
        [],
        isPrivate && context.key !== null ? { kind: 'given', key: context.key } : null,
      );

      return plainResult({
        sessionId: session.id,
        receiveUrl: receiveUrlFor(context.receiveOrigin, session.id),
        inspectorUrl: buildInspectorUrl(context.appOrigin, session.id),
        expiresAt: session.expiresAt,
        response,
      });
    },
  ),

  // `PUT /api/sessions/:sessionId/response`: a use of the session (D133,
  // D150), announced to its viewers as the route announces it (D152).
  set_response: tool(
    (args) => {
      const sessionId = requiredId(args, 'sessionId');
      const change = parseResponseChange(args);

      rejectUnknownArguments('set_response', args);

      return { sessionId, change };
    },
    async ({ sessionId, change }, context) => {
      // In the session's line, as the route's change is (`inOrder`, D205),
      // holding no slot of the gate there (`inSessionLine`, D244), and
      // announced in its transaction as the route's is (D221).
      const state = await inSessionLine(context.hub, sessionId, context.slot ?? NO_WAIT_SLOT, () =>
        changeSessionResponse(context.pool, sessionId, change, context.log, context.key),
      );

      return plainResult({ sessionId, mode: change.mode, response: state.response });
    },
  ),

  // `GET .../requests?wait=N` (D200), with `after`, `limit` and `order`.
  wait_for_request: tool(
    (args) => {
      const sessionId = requiredId(args, 'sessionId');
      let wait = REQUEST_LIST_MAX_WAIT_SECONDS;

      if (has(args, 'wait')) {
        const value = args.wait;

        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 1 ||
          value > REQUEST_LIST_MAX_WAIT_SECONDS
        ) {
          throw invalidListQuery(RULES.wait);
        }

        wait = value;
      }

      const limit = limitOf(args);
      const order = orderOf(args);
      const after = afterOf(args);

      rejectUnknownArguments('wait_for_request', args);

      // What the call holds while it waits, up to 30 s: two ids of its own,
      // three numbers and a literal. The ids' shapes are checked by
      // `waitForRequests` before it subscribes.
      return { sessionId, query: listQuery({ limit, order, after, wait }) };
    },
    async ({ sessionId, query }, context) => {
      const waited = await waitForRequests(
        context.pool,
        context.hub,
        context.waits,
        sessionId,
        query,
        context.signal,
        context.key,
        context.slot,
      );

      if (waited === null) {
        return null;
      }

      return listedRequests(context, sessionId, query, waited.chosen);
    },
  ),

  // `GET .../requests` without `include`, or, with a condition,
  // `POST .../requests/query` under the search's timeout, in a slot of the
  // search with a body condition and of the header-only queries without (D250).
  list_requests: tool(
    (args) => {
      const sessionId = requiredId(args, 'sessionId');
      const headers = has(args, 'headers') ? parseHeaderConditions(args.headers) : [];
      const bodies = has(args, 'body') ? parseBodyConditions(args.body) : [];

      if (headers.length + bodies.length > REQUEST_QUERY_MAX_CONDITIONS) {
        throw invalidListQuery(RULES.conditions);
      }

      const limit = limitOf(args);
      const order = orderOf(args);
      const after = afterOf(args);
      let receivedAfter: string | null = null;

      if (has(args, 'since')) {
        receivedAfter = typeof args.since === 'string' ? sinceBound(args.since) : null;

        if (receivedAfter === null) {
          throw invalidListQuery(RULES.since);
        }
      }

      if (after !== null && has(args, 'since')) {
        throw invalidListQuery(RULES.afterWithSince);
      }

      rejectUnknownArguments('list_requests', args);

      return {
        sessionId,
        query: listQuery({ limit, order, after, receivedAfter, headers, bodies }),
      };
    },
    async ({ sessionId, query }, context) => {
      const chosen =
        query.headers.length + query.bodies.length === 0
          ? await listRequests(context.pool, sessionId, query, context.key)
          : await queryRequests(
              context.pool,
              sessionId,
              query,
              context.querySlots,
              context.searchTimeoutMs,
              context.key,
            );

      return listedRequests(context, sessionId, query, chosen.chosen);
    },
  ),

  // `GET .../requests/:requestId`, its body cut to 64 KiB.
  get_request: tool(
    (args) => {
      const sessionId = requiredId(args, 'sessionId');
      const requestId = requiredId(args, 'requestId');

      rejectUnknownArguments('get_request', args);

      return { sessionId, requestId };
    },
    async ({ sessionId, requestId }, context) => {
      const details = await getRequestDetails(context.pool, sessionId, requestId, context.key);
      // The API's own reading of the body (D043), cut: its text as the API
      // gives it, or its bytes again from the Base64.
      const body = agentBody(details);

      return capturedResult({
        id: details.id,
        method: details.method,
        receivedAt: details.receivedAt,
        sourceIp: details.sourceIp,
        httpVersion: details.httpVersion,
        bodySize: details.bodySize,
        bodyEncoding: body.bodyEncoding,
        truncated: body.truncated,
        response:
          details.response === null
            ? null
            : { state: details.response.state, status: details.response.status },
        inspectorUrl: buildInspectorUrl(context.appOrigin, sessionId, details.id),
        [UNTRUSTED]: {
          path: details.path,
          queryString: details.queryString,
          headers: details.headers,
          body: body.body,
        },
      });
    },
  ),

  // `DELETE .../requests`, announced as the route announces it, which ends
  // every list call waiting on the session with `[]` (D200).
  clear_requests: tool(
    (args) => {
      const sessionId = requiredId(args, 'sessionId');

      rejectUnknownArguments('clear_requests', args);

      return { sessionId };
    },
    async ({ sessionId }, context) => {
      // In the session's line, as the route's clear is (`inOrder`, D205),
      // holding no slot of the gate there (`inSessionLine`, D244).
      await inSessionLine(context.hub, sessionId, context.slot ?? NO_WAIT_SLOT, () =>
        clearRequests(context.pool, sessionId, context.key),
      );

      return plainResult({ sessionId, cleared: true });
    },
  ),

  // `DELETE /api/sessions/:sessionId`, closing its viewers as the route does (D198).
  delete_session: tool(
    (args) => {
      const sessionId = requiredId(args, 'sessionId');

      rejectUnknownArguments('delete_session', args);

      return { sessionId };
    },
    async ({ sessionId }, context) => {
      await deleteSession(context.pool, sessionId, context.key);

      return plainResult({ sessionId, deleted: true });
    },
  ),
};

export function isToolName(name: unknown): name is McpToolName {
  return typeof name === 'string' && (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * The tool error a refusal or a failure comes to. A failure the API would
 * answer `500` / `1500` is logged as the error handler logs it and answered
 * as that code.
 */
function failureResult(error: unknown, log: FastifyBaseLogger): CallToolResult {
  if (error instanceof ArgumentError) {
    return errorResult(error.message);
  }

  if (error instanceof AppError) {
    return errorResult(apiErrorText(error));
  }

  log.error({ err: error }, 'Unhandled error');

  return errorResult(apiErrorText(INTERNAL_ERROR));
}

/** A call refused by its checks: it answers the tool error at once. */
function refusedCall(error: unknown): ToolCall {
  return (context) => Promise.resolve(failureResult(error, context.log));
}

/**
 * Reads and checks a call's arguments now, synchronously, and answers the
 * call to run (D203). Nothing here waits, so the parsed arguments are let go
 * when it returns: the call keeps only what its tool's `read` built. A call
 * whose arguments are refused answers its tool error when it is run.
 */
export function readCall(name: McpToolName, args: unknown): ToolCall {
  try {
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      throw new ArgumentError('Invalid arguments: arguments must be an object');
    }

    return TOOLS[name]((args ?? {}) as Record<string, unknown>);
  } catch (error) {
    return refusedCall(error);
  }
}

/**
 * Runs a call `readCall` answered. Answers its result, a tool error for any
 * refusal, or `null` when the client left while `wait_for_request` waited:
 * nothing is written then, as for the list (D200).
 */
export async function runCall(
  call: ToolCall,
  context: ToolContext,
): Promise<CallToolResult | null> {
  try {
    return await call(context);
  } catch (error) {
    return failureResult(error, context.log);
  }
}

/**
 * `readCall`, then `runCall`. Not `async` itself, so the arguments it is
 * given are let go once they are read, before the call runs.
 */
export function callTool(
  name: McpToolName,
  args: unknown,
  context: ToolContext,
): Promise<CallToolResult | null> {
  return runCall(readCall(name, args), context);
}
