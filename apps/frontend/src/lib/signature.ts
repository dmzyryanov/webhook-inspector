/**
 * `Check signature…` (issue #74, D197): whether a header of a captured request
 * holds the HMAC of its body under a secret the tester types.
 *
 * Only the body is signed, exactly as it arrived (`receivedBodyBytes`); the
 * key is the secret's UTF-8 bytes; the HMAC is WebCrypto's. Everything here
 * runs in the browser and nothing is sent anywhere. The header's value is
 * read as the digest in hex (either case) or in Base64, after an optional
 * prefix such as `sha256=`, and the algorithm is preselected from that value.
 * Every rule is a pure function of its arguments but the HMAC itself, which
 * `crypto.subtle` answers asynchronously.
 */
import { en, type Messages } from '../i18n/en.ts';

/** The algorithms offered, in the order the switch shows them. */
export const SIGNATURE_ALGORITHMS = ['SHA-256', 'SHA-1', 'SHA-512'] as const;

export type SignatureAlgorithm = (typeof SIGNATURE_ALGORITHMS)[number];

/** The algorithm a value that tells nothing is checked with. */
export const DEFAULT_ALGORITHM: SignatureAlgorithm = 'SHA-256';

/** How the header wrote the digest that matched. */
export type SignatureEncoding = 'hex' | 'Base64';

/**
 * The text the check shows in fixed places (Figma B1-B5, S1, S2), in English;
 * the check draws the dictionary's `signature` (D222).
 */
export const SIGNATURE_TEXT = {
  warning: en.signature.warning,
  noHeader: en.signature.noHeader,
  noSecret: en.signature.noSecret,
  hint: en.signature.hint,
  unavailable: en.signature.unavailable,
} as const;

/** Digest sizes in bytes. */
const DIGEST_BYTES: Record<SignatureAlgorithm, number> = {
  'SHA-1': 20,
  'SHA-256': 32,
  'SHA-512': 64,
};

/**
 * A prefix that names an algorithm: `sha1=`, `sha256=` or `sha512=`, in any
 * case. A `Map`, not an object, so that a prefix such as `constructor=` or
 * `__proto__=` names nothing.
 */
const ALGORITHM_PREFIX: ReadonlyMap<string, SignatureAlgorithm> = new Map<
  string,
  SignatureAlgorithm
>([
  ['sha1', 'SHA-1'],
  ['sha256', 'SHA-256'],
  ['sha512', 'SHA-512'],
]);

/**
 * A prefix before the digest: a name of letters, digits, `-` and `_` and an
 * `=`, followed by something other than another `=`. That last condition is
 * what keeps a Base64 value whose only `=` is its padding from being read as
 * a prefix.
 */
const PREFIX = /^([A-Za-z][A-Za-z0-9_-]{0,31}=)([^=][\s\S]*)$/;

const HEX = /^[0-9A-Fa-f]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** One header the check can read: its name as first captured, and every value it arrived with. */
export interface SignatureHeader {
  name: string;
  /** The name lower-cased: header names are case-insensitive (RFC 9110). */
  key: string;
  /** In captured order; more than one for a duplicated header (D045). */
  values: string[];
}

/**
 * The request's headers as the check offers them: one entry per name,
 * compared case-insensitively, in the order the names first arrived, each with
 * all of its values.
 */
export function signatureHeaders(
  headers: readonly (readonly [string, string])[],
): SignatureHeader[] {
  const byKey = new Map<string, SignatureHeader>();

  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    const known = byKey.get(key);

    if (known === undefined) {
      byKey.set(key, { name, key, values: [value] });
    } else {
      known.values.push(value);
    }
  }

  return [...byKey.values()];
}

/** How a header is listed: `X-Hub-Signature-256`, or `X-Hub-Signature-256 (2 values)`. */
export function headerOptionLabel(header: SignatureHeader, m: Messages = en): string {
  return header.values.length > 1
    ? m.signature.headerOption(header.name, header.values.length)
    : header.name;
}

/** Whether a header's name says it may hold a signature. */
export function isSignatureHeaderName(name: string): boolean {
  const lower = name.toLowerCase();

  return lower.includes('signature') || lower.includes('hmac');
}

/**
 * The header the check opens on: the one chosen last when this request has a
 * header of that name, else the first whose name contains `signature` or
 * `hmac`, else none.
 */
export function preselectHeader(
  headers: readonly SignatureHeader[],
  remembered: string | null,
): SignatureHeader | null {
  if (remembered !== null) {
    const same = headers.find((header) => header.key === remembered.toLowerCase());

    if (same !== undefined) {
      return same;
    }
  }

  return headers.find((header) => isSignatureHeaderName(header.name)) ?? null;
}

/** A header value split into its optional prefix and the digest after it. */
export interface ParsedSignature {
  /** `sha256=`, or `''` when there is none. */
  prefix: string;
  digest: string;
}

/** Splits a header value, surrounding white space removed, into prefix and digest. */
export function parseSignature(value: string): ParsedSignature {
  const trimmed = value.trim();
  const prefixed = PREFIX.exec(trimmed);

  return prefixed === null
    ? { prefix: '', digest: trimmed }
    : { prefix: prefixed[1] ?? '', digest: prefixed[2] ?? '' };
}

/** The algorithm a prefix names, if it names one. */
function prefixAlgorithm(prefix: string): SignatureAlgorithm | null {
  return ALGORITHM_PREFIX.get(prefix.slice(0, -1).toLowerCase()) ?? null;
}

/** The algorithm a digest's length tells, in hex or in padded Base64, if it tells one. */
function lengthAlgorithm(digest: string): SignatureAlgorithm | null {
  for (const algorithm of SIGNATURE_ALGORITHMS) {
    const bytes = DIGEST_BYTES[algorithm];

    if (HEX.test(digest) && digest.length === bytes * 2) {
      return algorithm;
    }

    if (BASE64.test(digest) && digest.length === base64Length(bytes)) {
      return algorithm;
    }
  }

  return null;
}

/** The length of the padded Base64 of `bytes` bytes: 28, 44 and 88 for the three digests. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * The algorithm the check preselects for a header's values: the one an
 * `sha1=`, `sha256=` or `sha512=` prefix names, else the one whose digest
 * length the value has in hex (40, 64, 128) or Base64 (28, 44, 88), else
 * SHA-256. Of several values, the first that tells decides.
 */
export function detectAlgorithm(values: readonly string[]): SignatureAlgorithm {
  for (const value of values) {
    const { prefix, digest } = parseSignature(value);
    const told = (prefix === '' ? null : prefixAlgorithm(prefix)) ?? lengthAlgorithm(digest);

    if (told !== null) {
      return told;
    }
  }

  return DEFAULT_ALGORITHM;
}

/** Bytes as lower-case hex. */
export function toHex(bytes: Uint8Array): string {
  let hex = '';

  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }

  return hex;
}

/** Bytes as padded, standard Base64. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

/**
 * The HMAC of `message` under `key`, by WebCrypto.
 *
 * WebCrypto refuses an empty key, so the check never passes one: it asks for
 * a secret instead.
 */
export async function hmac(
  algorithm: SignatureAlgorithm,
  key: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  // Copies, so the key and the message are plain `ArrayBuffer`s whatever
  // buffer the bytes were cut from.
  const imported = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(key),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );

  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, new Uint8Array(message)));
}

/** The HMAC of `message` under the secret's UTF-8 bytes. */
export function computeHmac(
  algorithm: SignatureAlgorithm,
  secret: string,
  message: Uint8Array,
): Promise<Uint8Array> {
  return hmac(algorithm, new TextEncoder().encode(secret), message);
}

/** Which value matched, and how it wrote the digest. */
export interface SignatureMatch {
  /** Its index among the header's values. */
  index: number;
  encoding: SignatureEncoding;
}

/**
 * Whether any of the values holds `mac`: the whole value, or what follows its
 * prefix, compared with the hex of `mac` in either case and with its Base64.
 * The first value that holds it is the one reported.
 */
export function matchSignature(mac: Uint8Array, values: readonly string[]): SignatureMatch | null {
  const hex = toHex(mac);
  const base64 = toBase64(mac);

  for (const [index, value] of values.entries()) {
    const trimmed = value.trim();
    const { digest } = parseSignature(trimmed);

    for (const candidate of new Set([trimmed, digest])) {
      if (candidate.toLowerCase() === hex) {
        return { index, encoding: 'hex' };
      }

      if (candidate === base64) {
        return { index, encoding: 'Base64' };
      }
    }
  }

  return null;
}

/**
 * The computed HMAC written the way the header writes its value: its prefix -
 * one that names an algorithm renamed for the one checked, in the prefix's
 * case - and its encoding, hex in the digest's case or Base64. A value whose
 * digest is neither hex nor Base64 - Stripe's `t=…,v1=…`, say - has no form
 * to follow, and gets bare lower-case hex.
 */
export function formatComputed(
  mac: Uint8Array,
  algorithm: SignatureAlgorithm,
  value: string | undefined,
): string {
  const { prefix, digest } = parseSignature(value ?? '');
  const hex = toHex(mac);

  if (HEX.test(digest)) {
    const upper = /[A-F]/.test(digest) && !/[a-f]/.test(digest);

    return `${writtenPrefix(prefix, algorithm)}${upper ? hex.toUpperCase() : hex}`;
  }

  if (BASE64.test(digest)) {
    return `${writtenPrefix(prefix, algorithm)}${toBase64(mac)}`;
  }

  return hex;
}

/** A prefix as the computed value writes it: one naming an algorithm names the one checked. */
function writtenPrefix(prefix: string, algorithm: SignatureAlgorithm): string {
  if (prefixAlgorithm(prefix) === null) {
    return prefix;
  }

  const named = `sha${algorithm.slice('SHA-'.length)}=`;

  return prefix === prefix.toUpperCase() ? named.toUpperCase() : named;
}

/** What the check shows. */
export type SignatureCheck =
  | { kind: 'no-header' }
  | { kind: 'no-secret' }
  | { kind: 'unavailable' }
  | {
      kind: 'match';
      algorithm: SignatureAlgorithm;
      header: string;
      byteCount: number;
      valueCount: number;
      match: SignatureMatch;
    }
  | {
      kind: 'no-match';
      algorithm: SignatureAlgorithm;
      header: string;
      byteCount: number;
      valueCount: number;
      /** The HMAC in the header's form (`formatComputed`). */
      computed: string;
    };

export interface SignatureInput {
  header: SignatureHeader | null;
  secret: string;
  algorithm: SignatureAlgorithm;
  /** The body as it arrived (`receivedBodyBytes`). */
  body: Uint8Array;
}

/**
 * What the check can say before anything is computed: a header to choose, a
 * secret to type, or a browser with no WebCrypto (`crypto.subtle` exists only
 * on a secure origin, which production always is). `null` when it has to
 * compute.
 */
export function checkBeforeComputing({
  header,
  secret,
}: Pick<SignatureInput, 'header' | 'secret'>): SignatureCheck | null {
  if (header === null) {
    return { kind: 'no-header' };
  }

  if (secret === '') {
    return { kind: 'no-secret' };
  }

  if (globalThis.crypto?.subtle === undefined) {
    return { kind: 'unavailable' };
  }

  return null;
}

/** The whole check: what to ask for, or the HMAC and whether the header holds it. */
export async function checkSignature(input: SignatureInput): Promise<SignatureCheck> {
  const early = checkBeforeComputing(input);

  if (early !== null || input.header === null) {
    return early ?? { kind: 'no-header' };
  }

  const { header, secret, algorithm, body } = input;
  const mac = await computeHmac(algorithm, secret, body);
  const match = matchSignature(mac, header.values);
  const common = {
    algorithm,
    header: header.name,
    byteCount: body.length,
    valueCount: header.values.length,
  };

  return match === null
    ? { kind: 'no-match', ...common, computed: formatComputed(mac, algorithm, header.values[0]) }
    : { kind: 'match', ...common, match };
}

/** `HMAC-SHA256`, as the result names the algorithm. */
export function hmacName(algorithm: SignatureAlgorithm): string {
  return `HMAC-${algorithm.replace('-', '')}`;
}

/** `159 bytes`, `2,048 bytes`, `1 byte`. */
export function formatByteCount(count: number, m: Messages = en): string {
  return m.signature.bytes(count);
}

/**
 * The line under `Match` or `No match`: the algorithm, the byte count, on a
 * match the encoding, and the header - with the value that matched when it
 * arrived more than once.
 *
 * `HMAC-SHA256 of the body, 159 bytes · hex · X-Hub-Signature-256`
 */
export function describeCheck(
  check: Extract<SignatureCheck, { kind: 'match' | 'no-match' }>,
  m: Messages = en,
): string {
  const subject = m.signature.subject(
    hmacName(check.algorithm),
    formatByteCount(check.byteCount, m),
  );

  if (check.kind === 'match') {
    const header =
      check.valueCount > 1
        ? m.signature.valueOf(check.header, check.match.index + 1, check.valueCount)
        : check.header;

    return `${subject} · ${check.match.encoding} · ${header}`;
  }

  const header =
    check.valueCount > 1 ? m.signature.values(check.header, check.valueCount) : check.header;

  return `${subject} · ${header}`;
}

/**
 * What the check remembers between openings, in memory only, until the page
 * is reloaded (D197): never in storage, the URL or a request.
 */
export interface SignatureMemory {
  secret: string;
  /** The header chosen by hand last, by name; `null` until one is. */
  headerName: string | null;
  /**
   * The algorithm switched to by hand, for `headerName`; `null` while the
   * preselection stands.
   */
  algorithm: SignatureAlgorithm | null;
}

export const EMPTY_SIGNATURE_MEMORY: SignatureMemory = {
  secret: '',
  headerName: null,
  algorithm: null,
};

/** The header and the algorithm a request's check shows, from what is remembered. */
export function signatureChoice(
  headers: readonly SignatureHeader[],
  memory: SignatureMemory,
): { header: SignatureHeader | null; algorithm: SignatureAlgorithm } {
  const header = preselectHeader(headers, memory.headerName);
  const remembered =
    memory.headerName === null ? header === null : header?.key === memory.headerName.toLowerCase();

  if (memory.algorithm !== null && remembered) {
    return { header, algorithm: memory.algorithm };
  }

  return {
    header,
    algorithm: header === null ? DEFAULT_ALGORITHM : detectAlgorithm(header.values),
  };
}

/** The memory after the tester chooses a header: its algorithm is preselected again. */
export function chooseHeader(memory: SignatureMemory, header: SignatureHeader): SignatureMemory {
  return { ...memory, headerName: header.name, algorithm: null };
}

/** The memory after the tester switches the algorithm, for the header on screen. */
export function chooseAlgorithm(
  memory: SignatureMemory,
  header: SignatureHeader | null,
  algorithm: SignatureAlgorithm,
): SignatureMemory {
  return { ...memory, headerName: header === null ? null : header.name, algorithm };
}
