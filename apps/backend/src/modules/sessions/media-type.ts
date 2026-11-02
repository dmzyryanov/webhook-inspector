/**
 * The media-type rule of `POST /api/sessions` (D104).
 *
 * A create request is accepted only when it is unambiguously declared
 * `application/json`, with one exemption: the conjunction of no body and no
 * `Content-Type` header, which is the one-click bodyless create. Anything else
 * is `415` / `1007 UNSUPPORTED_MEDIA_TYPE`.
 *
 * The check reads the raw header list rather than `request.headers`, which has
 * already collapsed repeated `Content-Type` headers to the first value: a
 * declaration a reader has to choose between is not an unambiguous one.
 *
 * It runs before the body is read, so "no body" can only be read from the
 * framing headers: `Content-Length: 0`, or no `Content-Length` and no
 * `Transfer-Encoding`. A request announcing a transfer encoding carries a body
 * whatever the encoding names, so it is never exempt.
 */

const JSON_MEDIA_TYPE = 'application/json';

/**
 * Every value sent under `name`, which is given in lower case and compared
 * case-insensitively. Shared with the rule for a refused body
 * (`refused-body.ts`), which reads the framing headers the same way.
 */
export function headerValues(rawHeaders: string[], name: string): string[] {
  const values: string[] = [];

  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if ((rawHeaders[index] as string).toLowerCase() === name) {
      values.push(rawHeaders[index + 1] as string);
    }
  }

  return values;
}

/** Type and subtype only, compared case-insensitively as RFC 9110 requires. */
function isJsonMediaType(value: string): boolean {
  const [type] = value.split(';');

  return (type ?? '').trim().toLowerCase() === JSON_MEDIA_TYPE;
}

/**
 * Whether the framing headers announce no body at all. Shared with the rule
 * that ends a connection whose body is still arriving when it is answered
 * (`refused-body.ts`, D213).
 */
export function framesNoBody(rawHeaders: string[]): boolean {
  if (headerValues(rawHeaders, 'transfer-encoding').length > 0) {
    return false;
  }

  const lengths = headerValues(rawHeaders, 'content-length');

  return lengths.length === 0 || lengths.every((value) => value.trim() === '0');
}

/**
 * Whether a request is declared `application/json` by exactly one
 * `Content-Type` header, which is all the response change accepts (D150). It
 * has no bodyless form, so the exemption creation grants does not apply here.
 */
export function isJsonDeclared(rawHeaders: string[]): boolean {
  const declarations = headerValues(rawHeaders, 'content-type');

  return declarations.length === 1 && isJsonMediaType(declarations[0] as string);
}

/**
 * Whether the create endpoint may read this request at all. Pure, so the rule
 * can be tested without a server.
 */
export function isAcceptableCreateMediaType(rawHeaders: string[]): boolean {
  const declarations = headerValues(rawHeaders, 'content-type');

  if (declarations.length === 0) {
    return framesNoBody(rawHeaders);
  }

  if (declarations.length > 1) {
    return false;
  }

  return isJsonMediaType(declarations[0] as string);
}
