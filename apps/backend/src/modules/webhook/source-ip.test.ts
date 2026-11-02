import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normaliseSourceIp } from './source-ip.ts';

describe('normaliseSourceIp', () => {
  it('leaves an IPv4 address exactly as it arrived', () => {
    assert.equal(normaliseSourceIp('198.51.100.7'), '198.51.100.7');
    assert.equal(normaliseSourceIp('10.42.0.28'), '10.42.0.28');
    assert.equal(normaliseSourceIp('127.0.0.1'), '127.0.0.1');
  });

  it('unwraps IPv4-mapped IPv6 in the dotted form Node hands out', () => {
    // What a dual-stack listener reports for an IPv4 peer. Storing it as
    // written would show the same sender under two different addresses.
    assert.equal(normaliseSourceIp('::ffff:198.51.100.7'), '198.51.100.7');
    assert.equal(normaliseSourceIp('::ffff:127.0.0.1'), '127.0.0.1');
  });

  it('unwraps IPv4-mapped IPv6 in the hex form too', () => {
    // The same address, spelled the other legal way.
    assert.equal(normaliseSourceIp('::ffff:c633:6407'), '198.51.100.7');
    assert.equal(normaliseSourceIp('::FFFF:7F00:1'), '127.0.0.1');
  });

  it('drops an IPv6 zone suffix', () => {
    // The zone names an interface on this host, not the sender.
    assert.equal(normaliseSourceIp('fe80::1%eth0'), 'fe80::1');
    assert.equal(normaliseSourceIp('fe80::1%25'), 'fe80::1');
  });

  it('lower-cases and compresses IPv6 text', () => {
    assert.equal(normaliseSourceIp('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
    assert.equal(normaliseSourceIp('2001:DB8::AB'), '2001:db8::ab');
  });

  it('trims surrounding whitespace before parsing', () => {
    assert.equal(normaliseSourceIp('  203.0.113.9  '), '203.0.113.9');
  });

  it('answers null for anything that does not parse', () => {
    // Validation lives here rather than in the column (D057): an address the
    // application cannot read must cost the capture nothing (D007).
    assert.equal(normaliseSourceIp('not-an-address'), null);
    assert.equal(normaliseSourceIp('999.1.1.1'), null);
    assert.equal(normaliseSourceIp('198.51.100.7:443'), null);
    assert.equal(normaliseSourceIp('2001:db8::gggg'), null);
    assert.equal(normaliseSourceIp('%eth0'), null);
    assert.equal(normaliseSourceIp(''), null);
    assert.equal(normaliseSourceIp('   '), null);
    assert.equal(normaliseSourceIp(null), null);
    assert.equal(normaliseSourceIp(undefined), null);
  });

  it('refuses the historical short IPv4 spellings rather than expanding them', () => {
    // The reason lib/ip.ts exists, pinned on the storage path and not only on
    // the configuration path: ipaddr.parse would read every one of these as an
    // address nobody sent, and storing an address that never arrived is the
    // worst available failure for an inspector (D111).
    assert.equal(normaliseSourceIp('1'), null); // ipaddr.parse: 0.0.0.1
    assert.equal(normaliseSourceIp('127.1'), null); // ipaddr.parse: 127.0.0.1
    assert.equal(normaliseSourceIp('0x7f.1.1.1'), null); // ipaddr.parse: 127.1.1.1
    // The octal one is the worst of the set: a leading zero silently changes
    // which address the text denotes, with nothing about it looking wrong.
    assert.equal(normaliseSourceIp('010.1.1.1'), null); // ipaddr.parse: 8.1.1.1
  });
});
