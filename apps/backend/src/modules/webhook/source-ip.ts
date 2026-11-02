import type ipaddr from 'ipaddr.js';
import { parseAddress } from '../../lib/ip.ts';

/**
 * Normalises and validates the sender address before it is stored (D111).
 *
 * `source_ip` stays `TEXT` (D057): validation belongs here, in the application,
 * which can answer `null`, and not in the column, which would fail the capture
 * of an otherwise perfectly valid webhook. The inspector records what arrived
 * (D007), so an address it cannot read costs the request nothing.
 *
 * Four things are normalised, so that the same peer never produces two spellings
 * of itself in the list:
 *
 * - an IPv6 zone suffix (`fe80::1%eth0`) is dropped. It names an interface on
 *   this host, not the sender, and it is meaningless to whoever reads the row.
 * - IPv4-mapped IPv6 is unwrapped to plain IPv4, in both the `::ffff:1.2.3.4`
 *   spelling and the hex `::ffff:102:304` one. Node hands out the first form on
 *   a dual-stack listener, and both denote the same IPv4 sender.
 * - IPv6 text is lower-cased and compressed to its RFC 5952 form.
 * - anything that does not parse becomes `null`, under the strict rule in
 *   `lib/ip.ts`: the historical short IPv4 spellings are refused rather than
 *   expanded, because an inspector inventing `0.0.0.1` out of `1` records
 *   something that never arrived.
 */
export function normaliseSourceIp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  // Split rather than parse-then-strip: ipaddr.js carries the zone through to
  // its own output, and the zone must not reach the column.
  const zoneless = value.trim().split('%')[0] ?? '';

  if (zoneless.length === 0) {
    return null;
  }

  const parsed = parseAddress(zoneless);

  if (parsed === null) {
    return null;
  }

  if (parsed.kind() === 'ipv6') {
    const address = parsed as ipaddr.IPv6;

    if (address.isIPv4MappedAddress()) {
      return address.toIPv4Address().toString();
    }
  }

  return parsed.toString();
}
