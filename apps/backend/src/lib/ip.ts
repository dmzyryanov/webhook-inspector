import ipaddr from 'ipaddr.js';

/**
 * Strict address parsing, shared by the trust boundary and by the sender
 * address that gets stored (D111).
 *
 * `ipaddr.parse` on its own is too permissive for either use. It accepts the
 * historical "long" IPv4 spellings - `1` is `0.0.0.1`, `127.1` is `127.0.0.1`,
 * `0x7f.1.1.1` is `127.1.1.1` - so a mistyped allow-list entry of `1`, or a
 * `TRUSTED_PROXY_CIDRS` somebody filled in with a hop count out of habit, would
 * be silently accepted as an address nobody meant. In a tool whose first
 * priority is the correctness of what it records, quietly inventing an address
 * is worse than refusing the input.
 *
 * So IPv4 must be a four-part decimal quad and IPv6 must be IPv6. Everything
 * else is `null`.
 */
export function parseAddress(text: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  if (ipaddr.IPv4.isValidFourPartDecimal(text)) {
    return ipaddr.IPv4.parse(text);
  }

  if (ipaddr.IPv6.isValid(text)) {
    return ipaddr.IPv6.parse(text);
  }

  return null;
}

/**
 * Whether one allow-list entry is a literal address or a CIDR range under the
 * same strict rule.
 *
 * Deliberately has no form for a hop count and no form for "everyone" (D111).
 * A `/0` prefix is the one spelling of "everyone" the CIDR grammar does allow,
 * so it is refused here by name: it is `trustProxy: true` under another syntax,
 * and it is worth failing at configuration load with a message that says so
 * rather than deep inside the server constructor.
 *
 * Two further spellings are refused so that the entry form and the storage form
 * agree on what "strict" means:
 *
 * - a zone suffix (`fe80::1%eth0/64`). `@fastify/proxy-addr` compiles it, so it
 *   would never surface as a failure, but a zone names an interface on the host
 *   holding the allow-list rather than a peer that can talk to it, and the
 *   storage path already strips zones before writing an address down.
 * - a leading-zero prefix length (`10.0.0.0/024`), which `Number` would read as
 *   24. Leading zeros are the exact ambiguity this parser exists to reject, and
 *   rejecting them in an address while accepting them in a prefix would be the
 *   same mistake in a smaller place.
 */
export function isAddressOrCidr(entry: string): boolean {
  const slash = entry.indexOf('/');

  if (slash === -1) {
    return parseEntryAddress(entry) !== null;
  }

  const address = parseEntryAddress(entry.slice(0, slash));
  const prefix = parsePrefixLength(entry.slice(slash + 1));

  if (address === null || prefix === null) {
    return false;
  }

  return prefix >= 1 && prefix <= (address.kind() === 'ipv4' ? 32 : 128);
}

/**
 * Whether an entry is a well-formed CIDR range whose prefix length is zero.
 *
 * Separated from `isAddressOrCidr` only so that configuration can say why this
 * particular entry is refused. `0.0.0.0/0` *is* a CIDR range, and telling an
 * operator who typed it that it is not one would be false (D111).
 */
export function isEveryAddressCidr(entry: string): boolean {
  const slash = entry.indexOf('/');

  if (slash === -1) {
    return false;
  }

  return parseEntryAddress(entry.slice(0, slash)) !== null && entry.slice(slash + 1) === '0';
}

/**
 * An address as it may be written in an allow-list entry: the strict rule, minus
 * the zone suffix that `parseAddress` still lets through.
 *
 * That tolerance in `parseAddress` is unused rather than needed. The storage
 * path splits the zone off before it parses (`modules/webhook/source-ip.ts`),
 * and it is the only caller of `parseAddress` outside this file, so a `%` never
 * reaches the shared parser from there - tightening it would break nothing
 * today. This function exists to state the entry rule where the entry form is
 * defined, not because the shared parser could not be tightened instead.
 */
function parseEntryAddress(text: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  if (text.includes('%')) {
    return null;
  }

  return parseAddress(text);
}

/** A prefix length in its one unambiguous spelling, or `null`. */
function parsePrefixLength(bits: string): number | null {
  if (!/^(0|[1-9]\d{0,2})$/.test(bits)) {
    return null;
  }

  return Number(bits);
}
