import type { RequestDetails } from '@webhook-inspector/shared';

/**
 * The body of a captured request as the bytes that arrived, rebuilt from the
 * detail response (D007, D043). `Copy as cURL` (D167) re-sends these bytes and
 * `Check signature…` (D197) signs them, so both read them here and cannot
 * drift apart.
 */

/** The fields of the detail response that say what body arrived. */
export type BodySource = Pick<
  RequestDetails,
  'method' | 'body' | 'bodyBase64' | 'isBinary' | 'bodySize'
>;

/** The three bytes the backend's UTF-8 decoder removes from the start of a text body (D043). */
export const BYTE_ORDER_MARK: readonly number[] = [0xef, 0xbb, 0xbf];

/**
 * What arrived, in the form the detail response carries it.
 *
 * - `empty`: no bytes at all - an empty body, or a `HEAD`, for which the
 *   receiver stores none (D139).
 * - `binary`: bytes that are not UTF-8, as the response's Base64 (D043).
 * - `text`: valid UTF-8. `bytes` are the bytes that arrived, a byte-order mark
 *   the backend removed put back in front (`byteOrderMark`), so `text` is
 *   what the response carries and `bytes` what was stored.
 */
export type ReceivedBody =
  | { kind: 'empty' }
  | { kind: 'binary'; base64: string }
  | { kind: 'text'; text: string; bytes: Uint8Array; byteOrderMark: boolean };

/**
 * The body as it arrived.
 *
 * The backend decodes a text body with a decoder that removes one leading
 * byte-order mark (D043), so `body` is then three bytes shorter than what was
 * stored, and `bodySize` is the only place the difference shows. The mark is
 * put back from that difference: a body of nothing but the mark is `text`
 * with an empty `text` and three `bytes`, not `empty`.
 */
export function receivedBody(request: BodySource): ReceivedBody {
  if (request.method === 'HEAD') {
    return { kind: 'empty' };
  }

  if (request.isBinary) {
    return request.bodyBase64 === null || request.bodyBase64 === ''
      ? { kind: 'empty' }
      : { kind: 'binary', base64: request.bodyBase64 };
  }

  const text = request.body ?? '';
  const encoded = new TextEncoder().encode(text);

  if (request.bodySize === encoded.length + BYTE_ORDER_MARK.length) {
    const bytes = new Uint8Array(BYTE_ORDER_MARK.length + encoded.length);

    bytes.set(BYTE_ORDER_MARK);
    bytes.set(encoded, BYTE_ORDER_MARK.length);

    return { kind: 'text', text, bytes, byteOrderMark: true };
  }

  if (text === '') {
    return { kind: 'empty' };
  }

  return { kind: 'text', text, bytes: encoded, byteOrderMark: false };
}

/** The bytes that arrived, whichever form the response carries them in. */
export function receivedBodyBytes(request: BodySource): Uint8Array {
  const body = receivedBody(request);

  switch (body.kind) {
    case 'empty':
      return new Uint8Array(0);
    case 'binary':
      return Uint8Array.from(atob(body.base64), (character) => character.charCodeAt(0));
    case 'text':
      return body.bytes;
  }
}
