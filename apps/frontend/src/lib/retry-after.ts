/** `delay-seconds` of RFC 9110: digits only, at most ten of them. */
const DELAY_SECONDS = /^[0-9]{1,10}$/;

/**
 * The `Retry-After` of a refused API call as whole seconds, as `request()` in
 * `api/client.ts` puts it on an `ApiError` (issue #128): a number of seconds
 * of at least 1, and `undefined` for anything else - no header, `0`, a
 * fraction, a sign, an exponent, a list, more than ten digits, or the
 * HTTP-date form, which the API never sends and which would need the
 * browser's clock to read.
 *
 * `fetch` already strips the whitespace around a header's value; it is
 * trimmed here too, so the function means the same wherever its value came
 * from. Both steps are a single pass, so a value of any size is read quickly.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();

  if (!DELAY_SECONDS.test(trimmed)) {
    return undefined;
  }

  const seconds = Number(trimmed);

  return seconds >= 1 ? seconds : undefined;
}
