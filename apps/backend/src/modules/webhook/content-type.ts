/**
 * The receiver's handling of a `Content-Type` header that is not a media type
 * at all - an empty value, `json`, `application/`, `a/b/c` (D138).
 *
 * Fastify validates a declared `Content-Type` before it selects a parser and
 * refuses one that does not parse with `415`, so the webhook plugin's `*`
 * parser (D007) would never see the request and nothing would be captured.
 * Inside the plugin's scope such a value is therefore replaced on
 * `request.headers`, which is Fastify's parsed view, before that check runs.
 * The capture is composed from `request.raw.rawHeaders` (`raw-request.ts`),
 * which the replacement never touches, so the stored headers and the raw
 * request still show the header exactly as it was sent.
 */

/**
 * What an unparseable value is replaced with: RFC 9110's name for bytes of no
 * declared kind, which is what the `*` parser treats every body as anyway.
 */
export const CONTENT_TYPE_PLACEHOLDER = 'application/octet-stream';

/**
 * A `type/subtype` pair of RFC 9110 token characters, up to the first `;` or
 * the end of the value. Parameters never matter: Fastify never refuses a header
 * over them.
 *
 * Deliberately at least as strict as Fastify's own check
 * (`fastify/lib/content-type.js`): every value this accepts, Fastify accepts
 * too, so no value this lets through can still be refused. The converse is not
 * promised - a value Fastify would have accepted and this does not is replaced
 * as well, which changes nothing, because the only parser in the scope reads
 * every body as bytes whatever it declares and nothing stored comes from
 * `request.headers`.
 */
const MEDIA_TYPE = /^[\t ]*[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+[\t ]*(?:;|$)/;

/** Whether a `Content-Type` value can reach the receiver's parser as it is. */
export function isParseableContentType(value: string): boolean {
  return MEDIA_TYPE.test(value);
}
