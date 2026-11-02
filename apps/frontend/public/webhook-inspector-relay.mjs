#!/usr/bin/env node
/**
 * Webhook Inspector relay: sends every webhook a Webhook Inspector session
 * captures on to a service of yours, such as one on http://localhost:3000,
 * while the webhook still appears in the inspector.
 *
 *   node webhook-inspector-relay.mjs <session id or webhook URL> <target base URL> [--from-start] [--api <base URL>]
 *
 * Each request the session captures after the relay starts is sent again, one
 * at a time and in the order it was captured, to the target base URL plus the
 * path after /s/<session id> and the query string: a webhook sent to
 * https://hook.qa-tools.ru/s/<session id>/stripe/events?x=1 reaches
 * http://localhost:3000/stripe/events?x=1. It goes with the captured method,
 * the captured headers in their order and letter case, duplicates kept, and
 * the captured body byte for byte. One line is printed per request: the time,
 * the method, the path and query, and your service's status or the error.
 * Ctrl+C stops it.
 *
 * - It is a relay, not a tunnel. Whoever sent the webhook was answered at once
 *   with the session's own configured response; your service's answer goes
 *   nowhere but the line printed here.
 * - Requests captured before it starts are skipped. With --from-start the
 *   session's requests are sent first, oldest first.
 * - It needs Node.js 22 or later and nothing else. It reads the session through
 *   the public API of https://webhook.qa-tools.ru (--api names another, such
 *   as a local one) and sends each request with Node's own HTTP client.
 * - A private session's access key is read from the environment variable
 *   WEBHOOK_INSPECTOR_ACCESS_KEY, never from an argument, so it stays out of
 *   your shell history and the process list. Its old name,
 *   QA_TOOLS_ACCESS_KEY, is read when WEBHOOK_INSPECTOR_ACCESS_KEY is not set,
 *   until the date the changelog gives, and a line says so. The key is sent as
 *   Authorization: Bearer on every API call, never to your service, and
 *   printed nowhere. Without it the relay reads a public session, whose id
 *   alone opens it; the id, an argument, lands in your shell history.
 * - It does not keep the session alive: only a captured webhook, opening the
 *   session's page and changing its response do. A session expires once its
 *   idle window (7 days unless it was created with a shorter one) or its
 *   lifetime runs out, and the relay then stops with a message.
 * - When your service cannot be reached or does not answer within 30 s, that
 *   request's line says so and the next request is still sent. When the API
 *   cannot be reached, it prints a line and tries again after 1 s, then up to
 *   every 15 s, and keeps running; an API that answers 429 is waited out for
 *   its Retry-After. A session that is not found or has expired ends it with
 *   exit status 1; an invalid argument, or an access-key variable that is set
 *   and is not an access key, prints the usage and exits with status 2 before
 *   any call.
 *
 * Which headers are left out: `Host` and `Content-Length`, which are set for
 * your service and the body actually sent; the connection's own headers; the
 * eleven forwarding headers of a proxy; and an `Accept-Encoding` of exactly
 * `gzip`. The inspector's `Copy as cURL` leaves out `Host`, `Content-Length`
 * and the connection's headers too, but keeps the forwarding headers and
 * `gzip`: a copied command is read before it is run, while this relay sends
 * on unattended, into a service that may trust a proxy on its own machine and
 * take the forwarding headers for that proxy's.
 */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { realpathSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

const { fetch, AbortSignal } = globalThis;

export const USAGE = `Usage: node webhook-inspector-relay.mjs <session id or webhook URL> <target base URL> [--from-start] [--api <base URL>]

Sends every request a Webhook Inspector session captures from now on to a
service of yours, one line each, until you stop it with Ctrl+C.

  <session id or webhook URL>  the session's id, or its webhook URL
                               https://hook.qa-tools.ru/s/<session id>
  <target base URL>            an http: or https: URL, such as http://localhost:3000;
                               the path after /s/<session id> and the query
                               string are added to it
  --from-start                 send the requests the session already holds
                               first, oldest first
  --api <base URL>             the Webhook Inspector API to read the session
                               from (default https://webhook.qa-tools.ru)

Environment:
  WEBHOOK_INSPECTOR_ACCESS_KEY the access key of a private session: 43
                               characters of A-Z, a-z, 0-9, _ and -, sent to
                               the API as Authorization: Bearer; leave it
                               unset for a public session
  QA_TOOLS_ACCESS_KEY          its old name, read when the one above is not
                               set, until the date the changelog gives`;

/** The environment variable a private session's access key is read from. */
export const ACCESS_KEY_VARIABLE = 'WEBHOOK_INSPECTOR_ACCESS_KEY';

/**
 * Its old name, read when `ACCESS_KEY_VARIABLE` is not set, until the date the
 * changelog gives; when both are set, `ACCESS_KEY_VARIABLE` is the one read.
 */
export const OLD_ACCESS_KEY_VARIABLE = 'QA_TOOLS_ACCESS_KEY';

/** The API read when `--api` is not given. */
export const DEFAULT_API = 'https://webhook.qa-tools.ru';

/** How many requests one call of the list asks for. */
export const PAGE_SIZE = 100;

/** How long one call of the list waits for a request, the API's own cap. */
export const WAIT_SECONDS = 30;

/** How long one request to your service may take, its answer included. */
export const FORWARD_TIMEOUT_MS = 30_000;

/** How long an API call without `wait` may take. */
export const API_TIMEOUT_MS = 30_000;

/** The first and the longest delay before an API call is tried again. */
export const RETRY_FIRST_MS = 1_000;
export const RETRY_LAST_MS = 15_000;

/** The longest `Retry-After` of a `429` that is waited out, in seconds. */
export const RETRY_AFTER_MAX_SECONDS = 60;

/**
 * An empty answer of a waiting call that comes back sooner than this is
 * followed by a pause of this length, so that nothing - a clear, a server
 * shutting down - can make the relay call the API in a tight loop.
 */
export const EMPTY_ANSWER_PAUSE_MS = 1_000;

/**
 * How many ids of requests already seen are kept. The session keeps its
 * newest 1000 requests, and ids are kept in the order the requests were
 * captured, so one still in the session is among the newest 1000 kept.
 */
export const SEEN_IDS_KEPT = 2_000;

const USER_AGENT = 'webhook-inspector-relay';
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
const WEBHOOK_PATH = /^\/s\/([A-Za-z0-9_-]{43})(?:\/|$)/;

/**
 * Header names never sent on, lower-cased and compared with a captured name
 * lower-cased: the list the inspector's `Copy as cURL` leaves out, plus the
 * eleven forwarding names it keeps. `Host` and `Content-Length` are set for
 * the target and the body actually sent, and the connection's own headers
 * describe the sender's connection. The forwarding names are those of the
 * proxy that served qa-tools.ru until 0.36.0; since then a capture's are the
 * sender's own, and they are still not sent on, because a local service may
 * trust a proxy on its own machine and take them for that proxy's. An
 * `Accept-Encoding` is left out only with the exact value `gzip`, which that
 * proxy added to a request that had none.
 */
export const DROPPED_HEADER_NAMES = new Set([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-forwarded-server',
  'x-forwarded-uri',
  'x-forwarded-method',
  'x-forwarded-prefix',
  'x-forwarded-tls-client-cert',
  'x-forwarded-tls-client-cert-info',
  'x-real-ip',
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
  'expect',
]);

/** Whether a captured `[name, value]` pair is left out of the request sent on. */
export function isDroppedHeader([name, value]) {
  const lower = name.toLowerCase();

  return DROPPED_HEADER_NAMES.has(lower) || (lower === 'accept-encoding' && value === 'gzip');
}

/** The three bytes a UTF-8 decoder removes from the start of a text body. */
const BYTE_ORDER_MARK = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Text for a console line: control characters and the characters that reorder
 * or hide text written as escapes, and anything past `max` characters cut.
 */
export function printable(text, max = 200) {
  let shown = '';
  let count = 0;

  for (const character of String(text)) {
    if (count === max) {
      return `${shown}...`;
    }

    const code = character.codePointAt(0);
    const hidden =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      code === 0xfeff;

    shown += hidden ? `\\u{${code.toString(16)}}` : character;
    count += 1;
  }

  return shown;
}

/**
 * The session id in the first argument: the id itself, or the webhook URL
 * `http(s)://<host>/s/<id>`, with or without a path, a query or a fragment
 * after the id. `null` for anything else.
 */
export function sessionIdFrom(text) {
  if (SESSION_ID.test(text)) {
    return text;
  }

  let url;

  try {
    url = new URL(text);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  return WEBHOOK_PATH.exec(url.pathname)?.[1] ?? null;
}

/**
 * A base URL given as an argument: `http:` or `https:`, with no user name,
 * password, query string or fragment. A string saying what is wrong otherwise.
 */
export function baseUrlFrom(text) {
  let url;

  try {
    url = new URL(text);
  } catch {
    return 'is not a URL';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'must be an http: or https: URL';
  }

  if (url.username !== '' || url.password !== '') {
    return 'must not carry a user name or a password';
  }

  if (url.search !== '' || url.hash !== '') {
    return 'must not carry a query string or a fragment';
  }

  return url;
}

/**
 * The command line, without `node` and the script: `{ sessionId, target,
 * fromStart, api }`, `{ help: true }`, or `{ error }` naming the rule broken.
 * No value is quoted back.
 *
 * A word that starts with `-` and is not one of the options is refused as an
 * unknown option, except a session id in the first argument's place: an id
 * made before 2026-09-25 can start with `-`. `--` ends the options, so every
 * word after it is an argument.
 */
export function parseArguments(argv) {
  const positional = [];
  let fromStart = false;
  let api;
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];

    if (optionsEnded) {
      positional.push(word);
    } else if (word === '--') {
      optionsEnded = true;
    } else if (word === '--help' || word === '-h') {
      return { help: true };
    } else if (word === '--from-start') {
      if (fromStart) {
        return { error: '--from-start is given twice' };
      }

      fromStart = true;
    } else if (word === '--api' || word.startsWith('--api=')) {
      if (api !== undefined) {
        return { error: '--api is given twice' };
      }

      if (word === '--api') {
        index += 1;
        api = argv[index];

        if (api === undefined) {
          return { error: '--api needs a base URL' };
        }
      } else {
        api = word.slice('--api='.length);
      }
    } else if (word.startsWith('-') && !(positional.length === 0 && SESSION_ID.test(word))) {
      return { error: 'unknown option' };
    } else {
      positional.push(word);
    }
  }

  if (positional.length < 2) {
    return { error: 'a session and a target base URL are both needed' };
  }

  if (positional.length > 2) {
    return { error: 'there are more than two arguments' };
  }

  const sessionId = sessionIdFrom(positional[0]);

  if (sessionId === null) {
    return {
      error:
        'the first argument is neither a session id nor its webhook URL, https://hook.qa-tools.ru/s/<session id>',
    };
  }

  const target = baseUrlFrom(positional[1]);

  if (typeof target === 'string') {
    return { error: `the target base URL ${target}` };
  }

  const apiUrl = baseUrlFrom(api ?? DEFAULT_API);

  if (typeof apiUrl === 'string') {
    return { error: `the --api base URL ${apiUrl}` };
  }

  return { sessionId, target, fromStart, api: apiUrl };
}

/**
 * The variable the access key is read from: `ACCESS_KEY_VARIABLE` when it is
 * set, an empty value included; else `OLD_ACCESS_KEY_VARIABLE` when that is
 * set; else `ACCESS_KEY_VARIABLE`, unset. So with both set the new one wins,
 * whatever the old one holds.
 */
export function accessKeyVariable(env) {
  if (env[ACCESS_KEY_VARIABLE] === undefined && env[OLD_ACCESS_KEY_VARIABLE] !== undefined) {
    return OLD_ACCESS_KEY_VARIABLE;
  }

  return ACCESS_KEY_VARIABLE;
}

/**
 * The access key in `variable`, `value`: `{ accessKey: null }` when it is
 * unset, so a public session is read as before; `{ accessKey }` for a value
 * of a key's shape, a session id's; `{ error }` for any other value, an
 * empty one included, so that a mistyped or missing secret stops the relay
 * at once. The error names the variable and never quotes the value.
 */
export function accessKeyFrom(value, variable = ACCESS_KEY_VARIABLE) {
  if (value === undefined) {
    return { accessKey: null };
  }

  if (typeof value === 'string' && SESSION_ID.test(value)) {
    return { accessKey: value };
  }

  return {
    error: `${variable} is set and is not an access key: 43 characters of A-Z, a-z, 0-9, _ and -`,
  };
}

/**
 * The path and query a captured request is sent to: the target's path, then
 * the stored path after `/s/<session id>` - nothing for `/s/<session id>`
 * itself, `/` for a trailing slash - without doubling the slash between them,
 * then `?` and the query string when there is one. A request captured before
 * paths were stored (`path` `null`) goes to the target's path.
 */
export function targetPath(target, sessionId, storedPath, queryString) {
  const prefix = `/s/${sessionId}`;
  const rest =
    typeof storedPath === 'string' &&
    storedPath.startsWith(prefix) &&
    (storedPath.length === prefix.length || storedPath[prefix.length] === '/')
      ? storedPath.slice(prefix.length)
      : '';
  const base = target.pathname;
  const path = rest === '' ? base : base.endsWith('/') ? base + rest.slice(1) : base + rest;

  return typeof queryString === 'string' && queryString !== '' ? `${path}?${queryString}` : path;
}

/**
 * The body as it arrived: the Base64 of a body that is not UTF-8, else the
 * text as UTF-8 with a byte-order mark the API's decoder removed put back,
 * which `bodySize` shows. A `HEAD` has none.
 */
export function bodyBytes(detail) {
  if (detail.method === 'HEAD') {
    return Buffer.alloc(0);
  }

  if (detail.isBinary) {
    return Buffer.from(detail.bodyBase64 ?? '', 'base64');
  }

  const text = Buffer.from(detail.body ?? '', 'utf8');

  return detail.bodySize === text.length + BYTE_ORDER_MARK.length
    ? Buffer.concat([BYTE_ORDER_MARK, text])
    : text;
}

/**
 * The methods whose requests Node's client sends without a length when it is
 * given none; for every other method it would add `Transfer-Encoding:
 * chunked`, which the sender did not send.
 */
const UNFRAMED_METHODS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE']);

/**
 * The headers sent on, as a flat `[name, value, ...]` list, which Node's
 * client writes exactly in this order and case: `Host` for the target, the
 * captured pairs less `isDroppedHeader`, and `Content-Length` for the body
 * sent - whenever there is one, the sender framed one with `Content-Length`
 * or `Transfer-Encoding`, or the method is not one Node sends unframed.
 */
export function forwardedHeaders(target, method, captured, body) {
  const headers = ['Host', target.host];
  let framed = !UNFRAMED_METHODS.has(method);

  for (const [name, value] of captured) {
    const lower = name.toLowerCase();

    if (lower === 'content-length' || lower === 'transfer-encoding') {
      framed = true;
    }

    if (!isDroppedHeader([name, value])) {
      headers.push(name, value);
    }
  }

  if (body.length > 0 || framed) {
    headers.push('Content-Length', String(body.length));
  }

  return headers;
}

/**
 * Seconds to wait from a `Retry-After` given in seconds, between 1 and
 * `RETRY_AFTER_MAX_SECONDS`; `null` when it is absent or not a number of
 * seconds, so the growing delay applies.
 */
export function retryAfterSeconds(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,10}$/.test(value.trim())) {
    return null;
  }

  return Math.min(Math.max(Number(value.trim()), 1), RETRY_AFTER_MAX_SECONDS);
}

/** What an error says, for a console line. */
export function describeError(error) {
  const reason = error?.cause ?? error;
  const nested = Array.isArray(reason?.errors)
    ? reason.errors
        .map((item) => item?.message)
        .filter(Boolean)
        .join(', ')
    : '';

  return printable(
    reason?.message || nested || reason?.code || error?.message || String(error),
    200,
  );
}

/**
 * Sends one request to the target and settles with `{ status }` once its
 * answer has been read, or `{ error }`; it never rejects. The whole exchange
 * has `timeoutMs`: an answer whose head arrived in time and whose body did not
 * still counts by its status. One connection per request, closed after it.
 */
export function sendToTarget({
  target,
  method,
  path,
  headers,
  body,
  timeoutMs = FORWARD_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    let request;
    let status;
    let settled = false;

    const finish = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };

    const timer = setTimeout(() => {
      finish(
        status === undefined ? { error: `no answer within ${timeoutMs / 1000} s` } : { status },
      );
      request?.destroy();
    }, timeoutMs);

    try {
      request = (target.protocol === 'https:' ? https : http).request({
        hostname: target.hostname.replace(/^\[(.*)\]$/, '$1'),
        port: target.port || undefined,
        method,
        path,
        headers,
        agent: false,
      });
    } catch (error) {
      finish({ error: describeError(error) });
      return;
    }

    request.on('response', (response) => {
      status = response.statusCode;
      response.on('end', () => finish({ status }));
      response.on('error', () => finish({ status }));
      response.on('close', () => finish({ status }));
      response.resume();
    });
    request.on('error', (error) =>
      finish(status === undefined ? { error: describeError(error) } : { status }),
    );
    request.end(body);
  });
}

/** The local time of day, `HH:MM:SS`. */
function clock(date = new Date()) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

/** A session id shortened to its first and last four characters, as the site shows it. */
function shortId(sessionId) {
  return `${sessionId.slice(0, 4)}...${sessionId.slice(-4)}`;
}

/** The session is not found or has expired: the relay stops. */
class SessionGone extends Error {}

/** The request named by `after` or by a detail call is no longer in the session. */
const REQUEST_GONE = Symbol('request gone');

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isListItem(item) {
  return (
    item !== null &&
    typeof item === 'object' &&
    typeof item.id === 'string' &&
    typeof item.method === 'string' &&
    (item.path === null || item.path === undefined || typeof item.path === 'string')
  );
}

function isDetail(detail) {
  return (
    detail !== null &&
    typeof detail === 'object' &&
    typeof detail.method === 'string' &&
    (detail.path === null || detail.path === undefined || typeof detail.path === 'string') &&
    (detail.queryString === undefined || typeof detail.queryString === 'string') &&
    Array.isArray(detail.headers) &&
    detail.headers.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === 'string' &&
        typeof pair[1] === 'string',
    ) &&
    typeof detail.isBinary === 'boolean' &&
    (detail.bodyBase64 === null ||
      detail.bodyBase64 === undefined ||
      typeof detail.bodyBase64 === 'string') &&
    (detail.body === null || detail.body === undefined || typeof detail.body === 'string') &&
    (detail.bodySize === undefined || typeof detail.bodySize === 'number')
  );
}

/**
 * The calls the relay makes, each tried again until it has an answer the
 * relay can act on: a network error, a `5xx` or any other unexpected answer
 * prints a line and waits 1, 2, 4, 8 and then 15 s; a `429` waits its
 * `Retry-After`. A session not found or expired throws `SessionGone`. With
 * `accessKey`, every call carries it as `Authorization: Bearer`; without
 * one, none carries an `Authorization`. `accessKeyVariable` is the variable
 * a missing session's message names.
 */
function apiClient({
  api,
  sessionId,
  accessKey = null,
  accessKeyVariable: variable = ACCESS_KEY_VARIABLE,
  log,
}) {
  const basePath = api.pathname.replace(/\/$/, '');
  const headers = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
    ...(accessKey === null ? {} : { authorization: `Bearer ${accessKey}` }),
  };
  const sessionPath = `${basePath}/api/sessions/${sessionId}/requests`;
  let delayMs = RETRY_FIRST_MS;

  const growingDelay = () => {
    const current = delayMs;

    delayMs = Math.min(delayMs * 2, RETRY_LAST_MS);

    return current;
  };

  async function get(path, query, timeoutMs, accept, requestMayBeGone) {
    const url = new URL(`${path}${query === '' ? '' : `?${query}`}`, api.origin);

    for (;;) {
      let status;
      let retryAfter;
      let json;

      try {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });

        status = response.status;
        retryAfter = response.headers.get('retry-after');
        json = parseJson(await response.text());
      } catch (error) {
        const wait = growingDelay();

        log(
          `${clock()} API not reachable: ${describeError(error)}; trying again in ${wait / 1000} s`,
        );
        await sleep(wait);
        continue;
      }

      const code = json !== null && typeof json === 'object' ? json.errorCode : undefined;

      if (status === 200 && accept(json)) {
        delayMs = RETRY_FIRST_MS;
        return json;
      }

      if (status === 404 && code === 1001) {
        throw new SessionGone(
          `The session was not found (404, errorCode 1001): it was deleted, it expired and was removed, the id is wrong, or it is private and ${variable} does not hold its access key.`,
        );
      }

      if (status === 410 && code === 1002) {
        throw new SessionGone(
          'The session has expired (410, errorCode 1002): its idle window or lifetime ran out. Create a new one.',
        );
      }

      if (status === 404 && code === 1003 && requestMayBeGone) {
        delayMs = RETRY_FIRST_MS;
        return REQUEST_GONE;
      }

      // The API's own 429 names its errorCode, 1015 when this address has made
      // its calls of the minute; one without any came from in front of the API.
      const seconds = status === 429 ? retryAfterSeconds(retryAfter) : null;
      const wait = seconds === null ? growingDelay() : seconds * 1000;
      const errorCode = typeof code === 'number' ? `, errorCode ${code}` : '';
      const what =
        status === 429
          ? `API rate limit reached (429${errorCode})`
          : `API answered ${status}${errorCode}${status === 200 ? ' with an unexpected body' : ''}`;

      log(`${clock()} ${what}; trying again in ${wait / 1000} s`);
      await sleep(wait);
    }
  }

  const isList = (json) => Array.isArray(json) && json.every(isListItem);
  const isObject = (json) => json !== null && typeof json === 'object' && !Array.isArray(json);

  return {
    /** The session's requests, oldest first: `after`, `limit` and `wait` as given. */
    list({ after, limit, wait } = {}) {
      const query = ['order=asc'];

      if (after !== undefined && after !== null) {
        query.push(`after=${encodeURIComponent(after)}`);
      }

      if (limit !== undefined) {
        query.push(`limit=${limit}`);
      }

      if (wait !== undefined) {
        query.push(`wait=${wait}`);
      }

      return get(
        sessionPath,
        query.join('&'),
        wait === undefined ? API_TIMEOUT_MS : wait * 1000 + API_TIMEOUT_MS,
        isList,
        after !== undefined && after !== null,
      );
    },

    /** One request in full, or `REQUEST_GONE`. */
    detail(requestId) {
      return get(
        `${sessionPath}/${encodeURIComponent(requestId)}`,
        '',
        API_TIMEOUT_MS,
        isObject,
        true,
      );
    },
  };
}

/** Ids of requests already seen, the oldest dropped past `limit` (see `SEEN_IDS_KEPT`). */
class SeenIds {
  #ids = new Set();
  #limit;

  constructor(limit) {
    this.#limit = limit;
  }

  has(id) {
    return this.#ids.has(id);
  }

  add(id) {
    if (this.#ids.has(id)) {
      return;
    }

    this.#ids.add(id);

    if (this.#ids.size > this.#limit) {
      this.#ids.delete(this.#ids.values().next().value);
    }
  }
}

/**
 * Runs until the session is gone, which it reports by throwing
 * `SessionGone`. `print` takes a line for each request and the start;
 * `log` a line about the API.
 */
export async function relay({
  sessionId,
  target,
  fromStart,
  api,
  accessKey = null,
  accessKeyVariable,
  print,
  log,
}) {
  const client = apiClient({ api, sessionId, accessKey, accessKeyVariable, log });
  const seen = new SeenIds(SEEN_IDS_KEPT);
  let after = null;

  if (fromStart) {
    print(
      `Sending every request of session ${shortId(sessionId)} to ${printable(target.href)}, oldest first. Ctrl+C stops.`,
    );
  } else {
    // Every request already there is seen, not only the newest: if the
    // newest is deleted, the list is read again (below), and the older ones
    // must not be taken for new.
    const existing = await client.list();

    for (const item of existing) {
      seen.add(item.id);
    }

    after = existing.at(-1)?.id ?? null;
    print(
      `Sending new requests of session ${shortId(sessionId)} to ${printable(target.href)}; ` +
        `${existing.length} captured before now ${existing.length === 1 ? 'is' : 'are'} skipped ` +
        '(--from-start sends them). Ctrl+C stops.',
    );
  }

  const forward = async (item) => {
    seen.add(item.id);

    const detail = await client.detail(item.id);
    const shownMethod = printable(item.method, 20);

    if (detail === REQUEST_GONE || !isDetail(detail)) {
      const why =
        detail === REQUEST_GONE
          ? 'no longer in the session'
          : 'the API did not answer with a request';

      print(
        `${clock()} ${shownMethod} ${printable(targetPath(target, sessionId, item.path ?? null, ''))} -> skipped: ${why}`,
      );
      return;
    }

    const path = targetPath(target, sessionId, detail.path ?? null, detail.queryString ?? '');
    const body = bodyBytes(detail);
    const result = await sendToTarget({
      target,
      method: detail.method,
      path,
      headers: forwardedHeaders(target, detail.method, detail.headers, body),
      body,
    });

    print(
      `${clock()} ${printable(detail.method, 20)} ${printable(path)} -> ${
        result.error === undefined ? result.status : `error: ${result.error}`
      }`,
    );
  };

  for (;;) {
    const started = Date.now();
    const page = await client.list({ after, limit: PAGE_SIZE, wait: WAIT_SECONDS });

    if (page === REQUEST_GONE) {
      // The request `after` named is gone: deleted, cleared, or pushed out by
      // the newest 1000. Read the list once without waiting, send what has
      // not been seen, and go on after the newest listed, so that the next
      // call waits instead of answering old requests again.
      const all = await client.list();

      for (const item of all) {
        if (!seen.has(item.id)) {
          await forward(item);
        }
      }

      after = all.at(-1)?.id ?? null;
      continue;
    }

    if (page.length === 0) {
      const elapsed = Date.now() - started;

      if (elapsed < EMPTY_ANSWER_PAUSE_MS) {
        await sleep(EMPTY_ANSWER_PAUSE_MS - elapsed);
      }

      continue;
    }

    for (const item of page) {
      if (!seen.has(item.id)) {
        await forward(item);
      }

      after = item.id;
    }
  }
}

/** Writes a last line, then ends the process with `code` once it is written. */
function exit(stream, line, code) {
  stream.write(`${line}\n`, () => process.exit(code));
}

export async function main(argv, env = process.env) {
  const options = parseArguments(argv);

  if (options.help) {
    exit(process.stdout, USAGE, 0);
    return;
  }

  // The arguments first, then the key, each before any call.
  const variable = accessKeyVariable(env);
  const { accessKey, error } =
    options.error === undefined ? accessKeyFrom(env[variable], variable) : options;

  if (error !== undefined) {
    exit(process.stderr, `webhook-inspector-relay: ${error}\n\n${USAGE}`, 2);
    return;
  }

  if (variable === OLD_ACCESS_KEY_VARIABLE) {
    console.error(
      `${OLD_ACCESS_KEY_VARIABLE} is the old name of ${ACCESS_KEY_VARIABLE}, read until the date the changelog gives; set ${ACCESS_KEY_VARIABLE} instead.`,
    );
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => exit(process.stdout, 'Stopped.', 0));
  }

  try {
    await relay({
      ...options,
      accessKey,
      accessKeyVariable: variable,
      print: (line) => console.log(line),
      log: (line) => console.error(line),
    });
  } catch (error) {
    if (error instanceof SessionGone) {
      exit(process.stderr, error.message, 1);
      return;
    }

    exit(process.stderr, `webhook-inspector-relay stopped: ${describeError(error)}`, 1);
  }
}

/** Whether this file is the script Node was started with, rather than imported. */
function isEntryPoint() {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2));
}
