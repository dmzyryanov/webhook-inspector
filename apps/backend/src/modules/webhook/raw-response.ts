import { STATUS_CODES } from 'node:http';

/**
 * Builds the stored representation of the response the backend formed: status
 * line, the headers the backend set, blank line, body (D109).
 *
 * It is **not** a wire capture, and the difference is not cosmetic. Node adds
 * `Date`, `Connection` and `Keep-Alive` of its own when the head is serialised,
 * and this runs before the configured delay, when `Date` is not knowable yet;
 * those headers are therefore absent here by construction, and this
 * representation will not match `curl -i` byte for byte. On the other side of
 * the record, a response that aborted or is still pending had part of this, or
 * none of it, actually written. Every surface that shows it is worded
 * accordingly.
 *
 * Composed here and stored, rather than reconstructed when the detail panel
 * asks for it, for the same two reasons the raw request is: symmetry with
 * `composeRawRequest`, and the fact that an aborted write leaves nothing to
 * compose from afterwards.
 *
 * The version in the status line is fixed at `HTTP/1.1` because that is what
 * Node writes: `ServerResponse` emits an `HTTP/1.1` status line for every
 * HTTP/1.x request, whatever version the request itself arrived on. The reason
 * phrase follows the same rule as `writeHead`, which falls back to `unknown`
 * for a status it does not recognise - and an unregistered status is something
 * a session may configure (D101).
 *
 * An answer over HTTP/2, `http2`, has no status line: its head reads as the
 * raw request of an HTTP/2 capture does, the `:status` pseudo-header field
 * first, then the fields the backend set, each `name: value` (D263). Node
 * adds `date` there too, absent here by construction.
 *
 * Header bytes are written as latin1, which is how Node decodes them, so any
 * byte the backend set is written back unchanged.
 */
export function composeRawResponse(
  status: number,
  headers: [string, string][],
  body: Buffer | null,
  http2 = false,
): Buffer {
  const lines = [
    http2 ? `:status: ${status}` : `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'unknown'}`,
  ];

  for (const [name, value] of headers) {
    lines.push(`${name}: ${value}`);
  }

  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');

  return body === null ? head : Buffer.concat([head, body]);
}
