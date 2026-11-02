/**
 * The one decoder behind `Body` of a form and `Query` (D162), so that "Body
 * behaves as Query" stays true by construction rather than by care.
 *
 * It is the WHATWG `application/x-www-form-urlencoded` parser - the one
 * `URLSearchParams` runs - with a single difference: a percent-escape that
 * does not decode as UTF-8 is refused rather than replaced with U+FFFD. The
 * name/value rows exist to show what arrived, and `name=%C8%E2%E0%ED` ("Иван"
 * in windows-1251) drawn as `name = ����` shows something else and says
 * nothing about it. A refusal lets the caller show the stored text with a
 * reason line instead.
 *
 * `charset` is never consulted. Decoding by a sender's claim would show
 * garbage as fact whenever the claim is wrong, and the media type defines no
 * `charset` parameter.
 */

/**
 * Refuses what is not UTF-8 rather than substituting U+FFFD. `ignoreBOM` keeps
 * a byte-order mark as the character it is, as the WHATWG parser ("UTF-8
 * decode without BOM") and `URLSearchParams` do.
 */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const encoder = new TextEncoder();

const PERCENT = 0x25;

/**
 * The name/value pairs of a form-urlencoded payload, in order, repeated names
 * kept - or `null` where any escape sequence does not decode as UTF-8, and
 * then for the whole payload: a table with some rows missing, or with the rows
 * that failed shown encoded, would be a table of what did not arrive.
 *
 * - The payload is split on `&`, and empty sequences (`&&`) are skipped, so
 *   `&&&` yields no pairs at all. Deciding what that means is the caller's.
 * - A sequence is split at its first `=`: `a=b=c` is `a` and `b=c`. One with
 *   no `=` is a name with an empty value, so `a` and `=` are one pair each.
 * - `+` is a space, and is replaced before percent-decoding, so `%2B` stays a
 *   plus sign.
 * - A `%` not followed by two hexadecimal digits - `100%`, `%zz` - is kept
 *   literally, as `URLSearchParams` keeps it. That is what arrived, not a
 *   failure.
 * - Text that is not escaped at all is taken as it stands: a stored body is
 *   already text, and its UTF-8 bytes are what percent-decoding runs over.
 */
export function decodeFormUrlencoded(payload: string): [string, string][] | null {
  const pairs: [string, string][] = [];

  for (const sequence of payload.split('&')) {
    if (sequence === '') {
      continue;
    }

    const separator = sequence.indexOf('=');
    const name = decodeComponent(separator === -1 ? sequence : sequence.slice(0, separator));
    const value = decodeComponent(separator === -1 ? '' : sequence.slice(separator + 1));

    if (name === null || value === null) {
      return null;
    }

    pairs.push([name, value]);
  }

  return pairs;
}

/** One name or value: `+` as a space, escapes resolved, strictly UTF-8. */
function decodeComponent(component: string): string | null {
  const spaced = component.replaceAll('+', ' ');

  // Nothing to resolve, and a stored string is already well-formed text.
  if (!spaced.includes('%')) {
    return spaced;
  }

  try {
    return utf8.decode(percentDecode(encoder.encode(spaced)));
  } catch {
    return null;
  }
}

/** WHATWG percent-decoding: a `%` without two hex digits after it stays. */
function percentDecode(input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.length);
  let length = 0;

  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index] as number;
    const high = hexValue(input[index + 1]);
    const low = hexValue(input[index + 2]);

    if (byte === PERCENT && high !== -1 && low !== -1) {
      output[length] = high * 16 + low;
      index += 2;
    } else {
      output[length] = byte;
    }

    length += 1;
  }

  return output.subarray(0, length);
}

/** The value of one ASCII hexadecimal digit, or `-1` for any other byte. */
function hexValue(byte: number | undefined): number {
  if (byte === undefined) {
    return -1;
  }

  if (byte >= 0x30 && byte <= 0x39) {
    return byte - 0x30;
  }

  // Either case: `| 0x20` folds `A`-`F` onto `a`-`f`.
  const lower = byte | 0x20;

  return lower >= 0x61 && lower <= 0x66 ? lower - 0x61 + 10 : -1;
}
