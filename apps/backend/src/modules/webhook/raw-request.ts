import type { FastifyRequest } from 'fastify';
import { http2StreamOf } from '../../lib/http2.ts';

/** Whether a header name is an HTTP/2 pseudo-header field's, `:method` and the rest. */
function isPseudoHeader(name: string): boolean {
  return name.startsWith(':');
}

/**
 * Header names and values exactly as received: original order, original case,
 * duplicates intact (D045). Fastify's own `headers` object lowercases names and
 * joins repeats, which would lose information the inspector exists to show.
 *
 * For an HTTP/2 request, `withoutPseudoHeaders`: its pseudo-header fields,
 * `:method`, `:path`, `:scheme` and `:authority`, are left out, so that they
 * appear in its raw request alone and never among its headers, which the
 * relay script hands to Node's HTTP/1.1 client (D202, D263). Its regular
 * fields are kept as for HTTP/1.1, in their order, each `cookie` apart.
 */
export function collectHeaderPairs(
  rawHeaders: string[],
  withoutPseudoHeaders = false,
): [string, string][] {
  const pairs: [string, string][] = [];

  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] as string;

    if (withoutPseudoHeaders && isPseudoHeader(name)) {
      continue;
    }

    pairs.push([name, rawHeaders[index + 1] as string]);
  }

  return pairs;
}

/**
 * The header pairs an HTTP/2 request is stored with, or HTTP/1.1's for an
 * HTTP/1.1 request: what `capture` stores and composes the raw request from.
 */
export function capturedHeaderPairs(request: FastifyRequest): [string, string][] {
  return collectHeaderPairs(request.raw.rawHeaders, http2StreamOf(request.raw) !== undefined);
}

/** The part of the URL after the first `?`, or an empty string. */
export function extractQueryString(url: string): string {
  const separator = url.indexOf('?');

  return separator === -1 ? '' : url.slice(separator + 1);
}

/**
 * The part of the URL before the first `?`.
 *
 * Stored separately from the query string, which is already its own column, so
 * the detail panel can show the path the sender actually used - a trailing
 * slash (D063) or a path under the endpoint (D173) included - rather than the
 * route pattern that matched it (D110). The caller passes the URL as it was
 * received (`request.originalUrl`), so the percent-encoding stays exactly as
 * it reached the application.
 */
export function extractPath(url: string): string {
  const separator = url.indexOf('?');

  return separator === -1 ? url : url.slice(0, separator);
}

/**
 * The URL Fastify's router is given for a request (D173); the URL itself is
 * kept, as `request.originalUrl`, for everything the capture stores.
 *
 * The router decodes a path before it matches it, and refuses one it cannot
 * decode - the escape of a byte that is not UTF-8, such as a Latin-1 `%E9`, or
 * a `%` without two hex digits - with its own `400`, outside the error contract
 * and before any route or hook. Under the webhook endpoint that would lose a
 * request the receiver exists to capture, whatever path it was sent to. So for
 * such a path under `/s/`, and only for one, every `%` is escaped once more:
 * the router decodes it back to the text that arrived, compares the segment
 * after `/s/` with the session id pattern as sent, and never reads the rest.
 * Every other URL reaches the router unchanged, and so does the query string,
 * which the router does not decode.
 */
export function routableUrl(url: string): string {
  if (!url.startsWith('/s/')) {
    return url;
  }

  const path = extractPath(url);

  try {
    decodeURI(path);

    return url;
  } catch {
    return `${path.replaceAll('%', '%25')}${url.slice(path.length)}`;
  }
}

/**
 * The head of the request as it appeared on the wire: request line, headers
 * and the blank line after them (D049). An HTTP/2 request has no request
 * line: its head is its header list as received, the pseudo-header fields
 * first as they arrived - `:method`, `:path`, `:scheme` and `:authority` as
 * sent - then the regular fields, each line `name: value`, then the blank
 * line (D263, the owner's decision 2 of 2026-10-18, Figma direction B). HTTP/2
 * puts every pseudo-header field before the regular ones, so this is the
 * header list in its wire order. The stored raw request is this head
 * followed by the body, joined by the insert itself (`$head || $body`), so
 * the process never builds a second full copy of a body of up to 1 MiB
 * (D210). Composed here rather than on the frontend so that what the Raw tab
 * shows is what the backend actually received.
 *
 * The headers are the pairs that are stored, passed in rather than collected
 * again, so that the header list and the raw request cannot disagree.
 *
 * Header bytes are treated as latin1, which is how Node decodes them, so any
 * byte that arrived is written back unchanged.
 */
export function composeRawRequestHead(
  request: FastifyRequest,
  headers: [string, string][],
): Buffer {
  const { method, httpVersion } = request.raw;
  const lines: string[] = [];

  if (http2StreamOf(request.raw) === undefined) {
    // The URL as received, which is what the router was given in every case
    // but one path it could not decode (`routableUrl`).
    lines.push(`${method} ${request.originalUrl} HTTP/${httpVersion}`);
  } else {
    const { rawHeaders } = request.raw;

    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      const name = rawHeaders[index] as string;

      if (isPseudoHeader(name)) {
        lines.push(`${name}: ${rawHeaders[index + 1] as string}`);
      }
    }
  }

  for (const [name, value] of headers) {
    lines.push(`${name}: ${value}`);
  }

  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
}
