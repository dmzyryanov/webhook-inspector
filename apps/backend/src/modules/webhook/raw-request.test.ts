import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { collectHeaderPairs, composeRawRequestHead, routableUrl } from './raw-request.ts';

describe('composeRawRequestHead', () => {
  it('writes exactly the header pairs it is given, so Raw and the header list agree', () => {
    const request = {
      originalUrl: '/s/abc?x=1',
      raw: { method: 'POST', httpVersion: '1.1', url: '/s/abc?x=1' },
    } as unknown as FastifyRequest;

    const head = composeRawRequestHead(request, [
      ['Host', 'qa-tools.ru'],
      ['X-Webhook-Id', 'first'],
      ['X-Webhook-Id', 'second'],
    ]);

    // The head alone, up to and with the blank line: the insert appends the
    // body (D210).
    assert.equal(
      head.toString('latin1'),
      'POST /s/abc?x=1 HTTP/1.1\r\n' +
        'Host: qa-tools.ru\r\n' +
        'X-Webhook-Id: first\r\n' +
        'X-Webhook-Id: second\r\n' +
        '\r\n',
    );
  });

  it('writes every byte of a latin1 header back unchanged', () => {
    const request = {
      originalUrl: '/s/abc/caf%E9',
      raw: { method: 'QUERY', httpVersion: '1.0', url: '/s/abc/caf%E9' },
    } as unknown as FastifyRequest;
    const value = Array.from({ length: 224 }, (_, index) => String.fromCharCode(index + 32))
      .join('')
      .replace('\x7f', '');

    const head = composeRawRequestHead(request, [['X-Bytes', value]]);

    assert.deepEqual(
      head,
      Buffer.concat([
        Buffer.from('QUERY /s/abc/caf%E9 HTTP/1.0\r\nX-Bytes: ', 'latin1'),
        Buffer.from(value, 'latin1'),
        Buffer.from('\r\n\r\n', 'latin1'),
      ]),
    );
  });
});

describe('collectHeaderPairs (D045, D263)', () => {
  it('keeps every pair in order, case and repeats', () => {
    assert.deepEqual(
      collectHeaderPairs(['Host', 'h', 'X-Dup', '1', 'x-dup', '2', 'cookie', 'a=1']),
      [
        ['Host', 'h'],
        ['X-Dup', '1'],
        ['x-dup', '2'],
        ['cookie', 'a=1'],
      ],
    );
  });

  it('leaves the pseudo-header fields of an HTTP/2 request out, and only when asked', () => {
    const raw = [
      ':method',
      'POST',
      ':path',
      '/s/x',
      ':scheme',
      'https',
      ':authority',
      'h',
      'cookie',
      'a=1',
      'x-z',
      'v',
      'cookie',
      'b=2',
    ];

    assert.deepEqual(collectHeaderPairs(raw, true), [
      ['cookie', 'a=1'],
      ['x-z', 'v'],
      ['cookie', 'b=2'],
    ]);
    assert.equal(collectHeaderPairs(raw).length, 7);
  });

  it('composes an HTTP/1.1 request that says HTTP/2.0 with its request line: the request decides, not its version', () => {
    const request = {
      originalUrl: '/s/abc',
      raw: { method: 'POST', httpVersion: '2.0', url: '/s/abc', rawHeaders: ['Host', 'h'] },
    } as unknown as FastifyRequest;

    assert.equal(
      composeRawRequestHead(request, [['Host', 'h']]).toString('latin1'),
      'POST /s/abc HTTP/2.0\r\nHost: h\r\n\r\n',
    );
  });
});

describe('routableUrl (D173)', () => {
  it('leaves every URL the router can decode as it is', () => {
    for (const url of [
      '/s/abc',
      '/s/abc/',
      '/s/abc/stripe/events?livemode=false',
      '/s/abc/%D0%BF%D0%BB/new%20x?q=%E9',
      '/s/abc/a%2Fb/%25',
      '/api/sessions/abc',
      '/',
    ]) {
      assert.equal(routableUrl(url), url);
    }
  });

  it('escapes every % once more in a path under /s/ the router cannot decode, and not its query', () => {
    assert.equal(routableUrl('/s/abc/caf%E9'), '/s/abc/caf%25E9');
    assert.equal(routableUrl('/s/abc/100%?x=%E9'), '/s/abc/100%25?x=%E9');
    assert.equal(routableUrl('/s/abc/%zz/%D0%BF'), '/s/abc/%25zz/%25D0%25BF');
    assert.equal(routableUrl('/s/%zz'), '/s/%25zz');
  });

  it('leaves a URL outside /s/ to the router, decodable or not', () => {
    for (const url of ['/api/sessions/%zz', '/nowhere/caf%E9', '/s', '/sx/%zz']) {
      assert.equal(routableUrl(url), url);
    }
  });
});
