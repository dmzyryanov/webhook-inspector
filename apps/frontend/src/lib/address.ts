/**
 * The sender's address, as text (D111, D120, D141).
 *
 * The detail panel writes it in full, as one segment of the Request half's
 * facts line (`request-summary.ts`); a list row writes it compact. Nothing
 * stands beside it on either surface: country resolution was removed (D140),
 * and there is no flag, no country code and no `Globe` glyph anywhere (D123).
 */

import { en, type Messages } from '../i18n/en.ts';

/**
 * Said where there is no address at all, in the list and in the panel alike
 * (D120b), in English; the interface says the dictionary's `record.noAddress`.
 */
export const NO_ADDRESS = en.record.noAddress;

/**
 * The widest address that must never be shortened: `255.255.255.255`.
 *
 * The list row is a narrow slot beside the status and the size, and a full IPv6
 * address is more than twice as wide as the widest IPv4 one. The full address
 * always stays available one click away, in the detail panel's facts line, and
 * the `Raw` caption says so where a row has been shortened.
 */
const COMPACT_ADDRESS_LENGTH = 15;

/**
 * What stands where the address is missing: `IP not stored` for a request of
 * a session created to keep none (D243, D249), so it does not look like a
 * failure, and `IP unavailable` for any other, an address that did not parse
 * (D120). `keepsNoAddress` is the session's `storeSourceIp === false`.
 */
export function missingAddressText(keepsNoAddress: boolean, m: Messages = en): string {
  return keepsNoAddress ? m.record.ipNotStored : m.record.noAddress;
}

/** The address as a list row shows it: compact, with nothing beside it (D118, D140). */
export function formatListAddress(
  sourceIp: string | null,
  m: Messages = en,
  keepsNoAddress = false,
): string {
  if (sourceIp === null) {
    return missingAddressText(keepsNoAddress, m);
  }

  return sourceIp.length <= COMPACT_ADDRESS_LENGTH
    ? sourceIp
    : `${sourceIp.slice(0, COMPACT_ADDRESS_LENGTH - 1)}…`;
}

/** Whether a row had to shorten this address, which is what the caption explains. */
export function isAddressShortened(sourceIp: string | null): boolean {
  return sourceIp !== null && formatListAddress(sourceIp) !== sourceIp;
}
