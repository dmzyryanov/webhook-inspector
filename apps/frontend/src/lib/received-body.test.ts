/**
 * The body as it arrived (D007, D043), which `Copy as cURL` re-sends (D167)
 * and `Check signature…` signs (D197). What each command does with these bytes
 * is `curl-command.test.ts`; what a signature over them is, `signature.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BYTE_ORDER_MARK,
  receivedBody,
  receivedBodyBytes,
  type BodySource,
} from './received-body.ts';

/** A text body as the detail endpoint returns it, its size the bytes stored. */
function text(body: string, overrides: Partial<BodySource> = {}): BodySource {
  return {
    method: 'POST',
    body,
    bodyBase64: null,
    isBinary: false,
    bodySize: new TextEncoder().encode(body).length,
    ...overrides,
  };
}

/** A body that is not UTF-8, as Base64 (D043). */
function binary(bytes: number[], overrides: Partial<BodySource> = {}): BodySource {
  return {
    method: 'POST',
    body: null,
    bodyBase64: Buffer.from(bytes).toString('base64'),
    isBinary: true,
    bodySize: bytes.length,
    ...overrides,
  };
}

function bytesOf(source: BodySource): number[] {
  return [...receivedBodyBytes(source)];
}

describe('receivedBody', () => {
  it('reads a text body as its UTF-8 bytes', () => {
    const body = receivedBody(text('{"name":"Иван"}'));

    assert.equal(body.kind, 'text');
    assert.equal(body.kind === 'text' && body.text, '{"name":"Иван"}');
    assert.equal(body.kind === 'text' && body.byteOrderMark, false);
    assert.deepEqual(bytesOf(text('{"name":"Иван"}')), [...Buffer.from('{"name":"Иван"}', 'utf8')]);
  });

  it('puts back the byte-order mark the backend removed, from bodySize', () => {
    const source = text('{"a":1}', { bodySize: 10 });
    const body = receivedBody(source);

    assert.equal(body.kind === 'text' && body.byteOrderMark, true);
    assert.deepEqual(bytesOf(source), [...BYTE_ORDER_MARK, ...Buffer.from('{"a":1}')]);
  });

  it('keeps a second mark, which the decoder left in the text, and puts the first back', () => {
    const source = text('﻿hi', { bodySize: 8 });

    assert.deepEqual(bytesOf(source), [...BYTE_ORDER_MARK, ...BYTE_ORDER_MARK, 0x68, 0x69]);
  });

  it('reads a body of nothing but the mark as those three bytes, not as empty', () => {
    const source = text('', { bodySize: 3 });

    assert.equal(receivedBody(source).kind, 'text');
    assert.deepEqual(bytesOf(source), BYTE_ORDER_MARK);
  });

  it('puts nothing back when bodySize is anything but three bytes more', () => {
    assert.deepEqual(bytesOf(text('ab', { bodySize: 4 })), [0x61, 0x62]);
    assert.deepEqual(bytesOf(text('ab', { bodySize: 6 })), [0x61, 0x62]);
  });

  it('decodes a binary body from its Base64, byte for byte', () => {
    const all = Array.from({ length: 256 }, (_, index) => index);

    assert.equal(receivedBody(binary(all)).kind, 'binary');
    assert.deepEqual(bytesOf(binary(all)), all);
    assert.deepEqual(bytesOf(binary([0xff, 0xfe, 0x00, 0x80])), [0xff, 0xfe, 0x00, 0x80]);
  });

  it('reads an empty body, an absent one and a HEAD as no bytes at all', () => {
    assert.equal(receivedBody(text('')).kind, 'empty');
    assert.equal(receivedBody(text('', { body: null })).kind, 'empty');
    assert.equal(receivedBody(binary([], { bodyBase64: '' })).kind, 'empty');
    assert.equal(receivedBody(binary([], { bodyBase64: null })).kind, 'empty');
    // The receiver stores none for a HEAD (D139), whatever else the detail says.
    assert.equal(receivedBody(text('x', { method: 'HEAD' })).kind, 'empty');
    assert.equal(receivedBody(binary([0xff], { method: 'HEAD' })).kind, 'empty');
    assert.deepEqual(bytesOf(text('')), []);
    assert.deepEqual(bytesOf(text('x', { method: 'HEAD' })), []);
  });

  it('rebuilds a 1 MiB binary body and a 1 MiB text body with a mark quickly', () => {
    const size = 1024 * 1024;
    const big = Buffer.alloc(size, 0xff);
    const started = performance.now();

    assert.equal(
      receivedBodyBytes({
        method: 'POST',
        body: null,
        bodyBase64: big.toString('base64'),
        isBinary: true,
        bodySize: size,
      }).length,
      size,
    );
    assert.equal(
      receivedBodyBytes(text('a'.repeat(size), { bodySize: size + 3 })).length,
      size + 3,
    );
    assert.ok(performance.now() - started < 2000, 'took too long');
  });
});
