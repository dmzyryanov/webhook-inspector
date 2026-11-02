const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface TransportedBytes {
  text: string | null;
  base64: string | null;
  isBinary: boolean;
}

/**
 * Prepares captured bytes for JSON transport.
 *
 * Valid UTF-8 travels as text, anything else as Base64 (D043). Decoding with
 * replacement characters is deliberately avoided: the inspector exists to show
 * what arrived, and a payload quietly rewritten into U+FFFD is no longer that.
 */
export function transportBytes(bytes: Buffer): TransportedBytes {
  try {
    return { text: utf8.decode(bytes), base64: null, isBinary: false };
  } catch {
    return { text: null, base64: bytes.toString('base64'), isBinary: true };
  }
}
