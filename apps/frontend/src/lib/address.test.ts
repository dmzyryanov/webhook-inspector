import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ru } from '../i18n/ru.ts';
import {
  formatListAddress,
  isAddressShortened,
  missingAddressText,
  NO_ADDRESS,
} from './address.ts';

const IPV4 = '145.40.74.12';
const IPV6 = '2001:db8:85a3:0000:0000:8a2e:0370:7334';

describe('formatListAddress', () => {
  it('shows the widest IPv4 address in full', () => {
    assert.equal(formatListAddress('255.255.255.255'), '255.255.255.255');
    assert.equal(formatListAddress(IPV4), IPV4);
    assert.equal(isAddressShortened(IPV4), false);
  });

  it('shortens a long IPv6 address and says so', () => {
    assert.equal(formatListAddress(IPV6), '2001:db8:85a3:…');
    assert.equal(isAddressShortened(IPV6), true);
  });

  /** The detail panel's facts line uses the same constant (D120b). */
  it('reads IP unavailable where there is no address', () => {
    assert.equal(formatListAddress(null), 'IP unavailable');
    assert.equal(formatListAddress(null), NO_ADDRESS);
    assert.equal(isAddressShortened(null), false);
  });
});

/**
 * A session created to keep no sender address (D243): its rows read `IP not
 * stored`, so the missing address does not look like a failure (#216, D249).
 * Every other session keeps `IP unavailable`, D120's address that did not
 * parse.
 */
describe('missingAddressText', () => {
  it('reads IP not stored for a session that keeps no address, in both languages', () => {
    assert.equal(formatListAddress(null, undefined, true), 'IP not stored');
    assert.equal(formatListAddress(null, ru, true), 'IP не сохраняется');
    assert.equal(missingAddressText(true), 'IP not stored');
  });

  it('keeps IP unavailable for a default session whose address did not parse', () => {
    assert.equal(formatListAddress(null, undefined, false), 'IP unavailable');
    assert.equal(formatListAddress(null, ru, false), 'IP недоступен');
    assert.equal(formatListAddress(null, ru), 'IP недоступен');
    assert.equal(missingAddressText(false), NO_ADDRESS);
  });

  /** A row that does carry an address shows it, whatever the session says. */
  it('never hides an address the row carries', () => {
    assert.equal(formatListAddress(IPV4, undefined, true), IPV4);
    assert.equal(formatListAddress(IPV6, ru, true), '2001:db8:85a3:…');
  });
});
