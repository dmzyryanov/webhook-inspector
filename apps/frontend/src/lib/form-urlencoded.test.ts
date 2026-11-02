/**
 * The decoder behind `Body` of a form and `Query` (D162).
 *
 * It is the WHATWG parser `URLSearchParams` runs, with one difference: an
 * escape that is not UTF-8 refuses the whole payload instead of becoming
 * U+FFFD. Both halves of that sentence are asserted - the agreement wherever
 * every escape is UTF-8, and the refusal where one is not - so the decoder can
 * neither drift from the parser the `Query` tab used before nor quietly go
 * back to it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFormUrlencoded } from './form-urlencoded.ts';

/** "Иван" in windows-1251: four bytes, not one of them a UTF-8 sequence. */
const WINDOWS_1251 = 'name=%C8%E2%E0%ED';

describe('decodeFormUrlencoded', () => {
  it('keeps every pair in its order, repeated names included', () => {
    assert.deepEqual(decodeFormUrlencoded('tag=a&name=x&tag=b&tag=a'), [
      ['tag', 'a'],
      ['name', 'x'],
      ['tag', 'b'],
      ['tag', 'a'],
    ]);
  });

  it('reads + as a space and resolves percent-escapes, so %2B stays a plus sign', () => {
    assert.deepEqual(decodeFormUrlencoded('note=a+b&sig=abc%2Bdef&path=%2Fv%2F1&sp=%20'), [
      ['note', 'a b'],
      ['sig', 'abc+def'],
      ['path', '/v/1'],
      ['sp', ' '],
    ]);
  });

  it('decodes UTF-8 escapes in either case, in names and values alike', () => {
    assert.deepEqual(
      decodeFormUrlencoded('name=%D0%98%D0%B2%D0%B0%D0%BD+%D0%9F%D0%B5%D1%82%D1%80%D0%BE%D0%B2'),
      [['name', 'Иван Петров']],
    );
    assert.deepEqual(decodeFormUrlencoded('caf%c3%A9=%E6%96%87'), [['café', '文']]);
    assert.deepEqual(decodeFormUrlencoded('emoji=%F0%9F%98%80'), [['emoji', '\u{1F600}']]);
  });

  it('takes text that is not escaped as it stands, non-ASCII included', () => {
    assert.deepEqual(decodeFormUrlencoded('name=Иван&note=é+%C3%A9'), [
      ['name', 'Иван'],
      ['note', 'é é'],
    ]);
  });

  /** The owner's rule of 2026-09-25: no U+FFFD, and no partial table either. */
  it('refuses the whole payload where any escape is not UTF-8', () => {
    assert.equal(decodeFormUrlencoded(WINDOWS_1251), null);
    assert.equal(decodeFormUrlencoded(`a=1&${WINDOWS_1251}&b=2`), null);
    // In a name, too, and a sequence cut short or not a sequence at all.
    assert.equal(decodeFormUrlencoded('%FF=1'), null);
    assert.equal(decodeFormUrlencoded('a=%C3'), null);
    assert.equal(decodeFormUrlencoded('a=%C3%'), null);
    assert.equal(decodeFormUrlencoded('a=%80'), null);
    // An encoded surrogate and an overlong encoding are not UTF-8 either.
    assert.equal(decodeFormUrlencoded('a=%ED%A0%80'), null);
    assert.equal(decodeFormUrlencoded('a=%C0%AF'), null);
    // What URLSearchParams did instead, and what the rows no longer show.
    assert.deepEqual([...new URLSearchParams(WINDOWS_1251)], [['name', '�'.repeat(4)]]);
  });

  it('keeps a malformed escape literally, because that is what arrived', () => {
    assert.deepEqual(decodeFormUrlencoded('rate=100%&bad=%zz&half=%4&pct=%&mix=%4g%41'), [
      ['rate', '100%'],
      ['bad', '%zz'],
      ['half', '%4'],
      ['pct', '%'],
      ['mix', '%4gA'],
    ]);
  });

  it('splits at the first = only, and reads a sequence without one as a name', () => {
    assert.deepEqual(decodeFormUrlencoded('a=b=c&flag&=v&k='), [
      ['a', 'b=c'],
      ['flag', ''],
      ['', 'v'],
      ['k', ''],
    ]);
    assert.deepEqual(decodeFormUrlencoded('='), [['', '']]);
    assert.deepEqual(decodeFormUrlencoded('a'), [['a', '']]);
    assert.deepEqual(decodeFormUrlencoded('hello'), [['hello', '']]);
  });

  it('skips empty sequences, so a payload of separators has no pairs at all', () => {
    assert.deepEqual(decodeFormUrlencoded('&&&'), []);
    assert.deepEqual(decodeFormUrlencoded('&'), []);
    assert.deepEqual(decodeFormUrlencoded(''), []);
    assert.deepEqual(decodeFormUrlencoded('&a=1&&b=2&'), [
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  /** "UTF-8 decode without BOM": a byte-order mark is a character like any other. */
  it('keeps a byte-order mark as the character it is', () => {
    assert.deepEqual(decodeFormUrlencoded('%EF%BB%BFa=%EF%BB%BF'), [['﻿a', '﻿']]);
  });

  it('keeps line breaks and other decoded controls in the value', () => {
    assert.deepEqual(decodeFormUrlencoded('text=line+1%0D%0Aline+2%00'), [
      ['text', 'line 1\r\nline 2\u0000'],
    ]);
  });

  /**
   * Wherever every escape is UTF-8, the rows are exactly what `URLSearchParams`
   * gave the `Query` tab before (a leading `?` aside, which its constructor
   * strips and which, in a stored query string, is a character that arrived).
   */
  it('agrees with URLSearchParams wherever every escape is UTF-8', () => {
    const payloads = [
      'source=demo&runId=1842',
      'x=1&x=2&empty=',
      'sig=abc%2Bdef&note=a+b&path=%2Fv%2F1',
      'a=b=c&&flag&=v&+=+&%3D=%26',
      'rate=100%&bad=%zz&half=%4&pct=%',
      'name=%D0%98%D0%B2%D0%B0%D0%BD&tag=a&tag=b',
      '%EF%BB%BF=%F0%9F%98%80&c=%c3%a9',
      'k=Иван+é&%E2%82%AC=%e2%82%ac',
      '&&&',
      '=',
    ];

    for (const payload of payloads) {
      assert.deepEqual(decodeFormUrlencoded(payload), [...new URLSearchParams(payload)], payload);
    }
  });

  it('reads a leading ? as part of the first name, as a URL query does', () => {
    assert.deepEqual(decodeFormUrlencoded('?a=1'), [['?a', '1']]);
    assert.deepEqual([...new URL('https://qa-tools.ru/s/x??a=1').searchParams], [['?a', '1']]);
  });
});
