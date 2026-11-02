/**
 * Stored bytes as the Body and Raw views split them: binary strings, one
 * character per byte, U+0000 to U+00FF (D145, D164).
 *
 * A binary string is what `atob` returns, and it already is the bytes read one
 * character per byte: ISO-8859-1 exactly. `new TextDecoder('latin1')` is not
 * that. The Encoding standard maps `latin1` and `iso-8859-1` to windows-1252,
 * which draws 0x80-0x9F as other characters than the ones Node puts in
 * `Headers` (`\x85` becomes an ellipsis), in browsers and in Node alike.
 */

/**
 * Decodes bytes that are valid UTF-8, and refuses anything else rather than
 * substituting U+FFFD, as the backend does for the whole body (D043).
 *
 * `ignoreBOM` keeps a byte-order mark at the start of the bytes as the
 * character it is: they sat in the middle of a representation or a body, where
 * the backend's decoder would have kept it too.
 */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** How many bytes are turned into characters at once, well under any engine's argument limit. */
const CHUNK = 0x8000;

/** Bytes as a binary string. */
export function binaryString(bytes: Uint8Array): string {
  let text = '';

  for (let start = 0; start < bytes.length; start += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  }

  return text;
}

/** A binary string read as UTF-8, or `null` where it is not valid UTF-8. */
export function decodeUtf8(binary: string): string | null {
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}
