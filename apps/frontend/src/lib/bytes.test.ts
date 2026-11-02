/**
 * The byte helpers `Raw` and the multipart splitter share (D145, D164).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { binaryString, decodeUtf8 } from './bytes.ts';

describe('binaryString', () => {
  it('is one character per byte, every byte value, across several chunks', () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, index) => (index * 7) % 256);
    const text = binaryString(bytes);

    assert.equal(text.length, bytes.length);
    assert.ok(bytes.every((byte, index) => text.charCodeAt(index) === byte));
  });

  it('turns no bytes into an empty string', () => {
    assert.equal(binaryString(new Uint8Array(0)), '');
  });
});

describe('decodeUtf8', () => {
  it('decodes UTF-8 and refuses anything else rather than substituting U+FFFD', () => {
    assert.equal(decodeUtf8('caf\xc3\xa9'), 'café');
    assert.equal(decodeUtf8('caf\xe9'), null);
    assert.equal(decodeUtf8('\x89PNG'), null);
  });

  it('keeps a byte-order mark at the start as a character', () => {
    assert.equal(decodeUtf8('\xef\xbb\xbfhi'), '﻿hi');
  });
});
