/**
 * `Check signature…` (issue #74, D197): the HMAC against published test
 * vectors, how a header value is read - prefix, hex in either case, Base64 -
 * which header and algorithm are preselected, the bytes that are signed, and
 * what the result says. The HMAC is WebCrypto's, as in the browser; Node 24
 * has the same `crypto.subtle`.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { receivedBodyBytes, type BodySource } from './received-body.ts';
import {
  chooseAlgorithm,
  chooseHeader,
  checkBeforeComputing,
  checkSignature,
  computeHmac,
  describeCheck,
  detectAlgorithm,
  EMPTY_SIGNATURE_MEMORY,
  formatByteCount,
  formatComputed,
  headerOptionLabel,
  hmac,
  hmacName,
  matchSignature,
  parseSignature,
  preselectHeader,
  SIGNATURE_TEXT,
  signatureChoice,
  signatureHeaders,
  toBase64,
  toHex,
  type SignatureAlgorithm,
  type SignatureCheck,
  type SignatureHeader,
} from './signature.ts';

const utf8 = (text: string) => new TextEncoder().encode(text);
const repeat = (byte: number, count: number) => new Uint8Array(count).fill(byte);
const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

/** HMAC by Node's OpenSSL, an implementation independent of the one under test. */
function reference(algorithm: SignatureAlgorithm, secret: string | Uint8Array, body: Uint8Array) {
  const name = algorithm.replace('-', '').toLowerCase();

  return createHmac(name, secret).update(body).digest();
}

const SECRET = 'test-secret-42';
const GITHUB_BODY = '{"ref":"refs/heads/main","repository":{"full_name":"acme/payments"}}';

function header(name: string, ...values: string[]): SignatureHeader {
  return { name, key: name.toLowerCase(), values };
}

async function check(
  values: string[],
  {
    secret = SECRET,
    algorithm = detectAlgorithm(values),
    body = utf8(GITHUB_BODY),
    name = 'X-Hub-Signature-256',
  }: { secret?: string; algorithm?: SignatureAlgorithm; body?: Uint8Array; name?: string } = {},
): Promise<SignatureCheck> {
  return checkSignature({ header: header(name, ...values), secret, algorithm, body });
}

describe('hmac against published test vectors', () => {
  const k4 = fromHex('0102030405060708090a0b0c0d0e0f10111213141516171819');
  const larger = 'Test Using Larger Than Block-Size Key - Hash Key First';
  const largerData =
    'This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.';

  // RFC 4231, test cases 1-4, 6 and 7 (5 is a truncated output).
  const rfc4231: [string, Uint8Array, Uint8Array, string, string][] = [
    [
      '1',
      repeat(0x0b, 20),
      utf8('Hi There'),
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
      '87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854',
    ],
    [
      '2',
      utf8('Jefe'),
      utf8('what do ya want for nothing?'),
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
      '164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737',
    ],
    [
      '3',
      repeat(0xaa, 20),
      repeat(0xdd, 50),
      '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
      'fa73b0089d56a284efb0f0756c890be9b1b5dbdd8ee81a3655f83e33b2279d39bf3e848279a722c806b485a47e67c807b946a337bee8942674278859e13292fb',
    ],
    [
      '4',
      k4,
      repeat(0xcd, 50),
      '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b',
      'b0ba465637458c6990e5a8c5f61d4af7e576d97ff94b872de76f8050361ee3dba91ca5c11aa25eb4d679275cc5788063a5f19741120c4f2de2adebeb10a298dd',
    ],
    [
      '6',
      repeat(0xaa, 131),
      utf8(larger),
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
      '80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f3526b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598',
    ],
    [
      '7',
      repeat(0xaa, 131),
      utf8(largerData),
      '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
      'e37b6a775dc87dbaa4dfa9f96e5e3ffddebd71f8867289865df5a32d20cdc944b6022cac3c4982b10d5eeb55c3e4de15134676fb6de0446065c97440fa8c6a58',
    ],
  ];

  for (const [name, key, data, sha256, sha512] of rfc4231) {
    it(`RFC 4231 test case ${name}: HMAC-SHA-256 and HMAC-SHA-512`, async () => {
      assert.equal(toHex(await hmac('SHA-256', key, data)), sha256);
      assert.equal(toHex(await hmac('SHA-512', key, data)), sha512);
    });
  }

  // RFC 2202, test cases 1-7 for HMAC-SHA-1 (5's full digest).
  const rfc2202: [string, Uint8Array, Uint8Array, string][] = [
    ['1', repeat(0x0b, 20), utf8('Hi There'), 'b617318655057264e28bc0b6fb378c8ef146be00'],
    [
      '2',
      utf8('Jefe'),
      utf8('what do ya want for nothing?'),
      'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79',
    ],
    ['3', repeat(0xaa, 20), repeat(0xdd, 50), '125d7342b9ac11cd91a39af48aa17b4f63f175d3'],
    ['4', k4, repeat(0xcd, 50), '4c9007f4026250c6bc8414f9bf50c86c2d7235da'],
    [
      '5',
      repeat(0x0c, 20),
      utf8('Test With Truncation'),
      '4c1a03424b55e07fe7f27be1d58bb9324a9a5a04',
    ],
    ['6', repeat(0xaa, 80), utf8(larger), 'aa4ae5e15272d00e95705637ce8a3b55ed402112'],
    [
      '7',
      repeat(0xaa, 80),
      utf8('Test Using Larger Than Block-Size Key and Larger Than One Block-Size Data'),
      'e8e99d0f45237d786d6bbaa7965c7808bbff1a91',
    ],
  ];

  for (const [name, key, data, sha1] of rfc2202) {
    it(`RFC 2202 test case ${name}: HMAC-SHA-1`, async () => {
      assert.equal(toHex(await hmac('SHA-1', key, data)), sha1);
    });
  }

  it("takes the secret's UTF-8 bytes as the key", async () => {
    // RFC 4231 case 2, whose key is the text `Jefe`.
    assert.equal(
      toHex(await computeHmac('SHA-256', 'Jefe', utf8('what do ya want for nothing?'))),
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    // A secret beyond ASCII is its UTF-8, not its UTF-16 or Latin-1.
    assert.deepEqual(
      [...(await computeHmac('SHA-256', 'пароль-🔑', utf8('x')))],
      [...reference('SHA-256', Buffer.from('пароль-🔑', 'utf8'), utf8('x'))],
    );
  });
});

describe('parseSignature', () => {
  it('splits a prefix such as sha256= from the digest after it', () => {
    assert.deepEqual(parseSignature('sha256=abcdef'), { prefix: 'sha256=', digest: 'abcdef' });
    assert.deepEqual(parseSignature('sha1=00ff'), { prefix: 'sha1=', digest: '00ff' });
    assert.deepEqual(parseSignature('v1=00ff'), { prefix: 'v1=', digest: '00ff' });
    assert.deepEqual(parseSignature('  SHA512=AB  '), { prefix: 'SHA512=', digest: 'AB' });
  });

  it('reads a bare value as the digest, a Base64 value with padding included', () => {
    assert.deepEqual(parseSignature('abcdef0123'), { prefix: '', digest: 'abcdef0123' });
    // The only `=` is padding: no prefix.
    assert.deepEqual(parseSignature('qUiU7/zfhTMBNw=='), {
      prefix: '',
      digest: 'qUiU7/zfhTMBNw==',
    });
    assert.deepEqual(parseSignature('abcdEFGH12=='), { prefix: '', digest: 'abcdEFGH12==' });
    assert.deepEqual(parseSignature('abcd='), { prefix: '', digest: 'abcd=' });
    assert.deepEqual(parseSignature(''), { prefix: '', digest: '' });
    assert.deepEqual(parseSignature('='), { prefix: '', digest: '=' });
  });
});

describe('detectAlgorithm', () => {
  const hex = (bytes: number) => 'ab'.repeat(bytes);
  const base64 = (bytes: number) => Buffer.alloc(bytes, 0xab).toString('base64');

  it('takes the algorithm a sha1=, sha256= or sha512= prefix names, in any case', () => {
    assert.equal(detectAlgorithm(['sha1=xyz']), 'SHA-1');
    assert.equal(detectAlgorithm(['sha256=xyz']), 'SHA-256');
    assert.equal(detectAlgorithm(['sha512=xyz']), 'SHA-512');
    assert.equal(detectAlgorithm(['SHA1=xyz']), 'SHA-1');
    // The prefix wins over a length that says otherwise.
    assert.equal(detectAlgorithm([`sha1=${hex(64)}`]), 'SHA-1');
  });

  it('else the digest length: 40 hex or 28 Base64 is SHA-1, 128 hex or 88 Base64 SHA-512', () => {
    assert.equal(base64(20).length, 28);
    assert.equal(base64(32).length, 44);
    assert.equal(base64(64).length, 88);
    assert.equal(detectAlgorithm([hex(20)]), 'SHA-1');
    assert.equal(detectAlgorithm([hex(20).toUpperCase()]), 'SHA-1');
    assert.equal(detectAlgorithm([base64(20)]), 'SHA-1');
    assert.equal(detectAlgorithm([hex(32)]), 'SHA-256');
    assert.equal(detectAlgorithm([base64(32)]), 'SHA-256');
    assert.equal(detectAlgorithm([hex(64)]), 'SHA-512');
    assert.equal(detectAlgorithm([base64(64)]), 'SHA-512');
    assert.equal(detectAlgorithm([`v1=${hex(20)}`]), 'SHA-1');
  });

  it('else SHA-256', () => {
    assert.equal(detectAlgorithm(['']), 'SHA-256');
    assert.equal(detectAlgorithm(['not a digest']), 'SHA-256');
    assert.equal(detectAlgorithm([hex(21)]), 'SHA-256');
    assert.equal(detectAlgorithm(['t=1700000000,v1=abc']), 'SHA-256');
    assert.equal(detectAlgorithm([]), 'SHA-256');
  });

  it('takes the first of several values that tells', () => {
    assert.equal(detectAlgorithm(['junk', hex(64), hex(20)]), 'SHA-512');
  });

  it('is not fooled by prefixes that are names on an object', () => {
    for (const prefix of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'CONSTRUCTOR']) {
      assert.equal(detectAlgorithm([`${prefix}=${hex(20)}`]), 'SHA-1', prefix);
      assert.equal(detectAlgorithm([`${prefix}=x`]), 'SHA-256', prefix);
    }

    // Not a prefix at all - it starts with `_` - so the whole value is read.
    assert.equal(detectAlgorithm([`__proto__=${hex(20)}`]), 'SHA-256');
    assert.equal(parseSignature(`__proto__=${hex(20)}`).prefix, '');
  });
});

describe('signatureHeaders and preselectHeader', () => {
  const headers: [string, string][] = [
    ['Host', 'hook.qa-tools.ru'],
    ['Content-Type', 'application/json'],
    ['X-Shopify-Hmac-Sha256', 'b64'],
    ['X-Hub-Signature', 'sha1=aa'],
    ['x-hub-signature', 'sha1=bb'],
    ['X-Hub-Signature-256', 'sha256=cc'],
  ];

  it('offers each name once, in arrival order, with all of its values', () => {
    const offered = signatureHeaders(headers);

    assert.deepEqual(
      offered.map((entry) => [entry.name, entry.values]),
      [
        ['Host', ['hook.qa-tools.ru']],
        ['Content-Type', ['application/json']],
        ['X-Shopify-Hmac-Sha256', ['b64']],
        ['X-Hub-Signature', ['sha1=aa', 'sha1=bb']],
        ['X-Hub-Signature-256', ['sha256=cc']],
      ],
    );
    assert.equal(headerOptionLabel(offered[3] as SignatureHeader), 'X-Hub-Signature (2 values)');
    assert.equal(headerOptionLabel(offered[4] as SignatureHeader), 'X-Hub-Signature-256');
  });

  it('preselects the first header whose name contains signature or hmac, in any case', () => {
    assert.equal(preselectHeader(signatureHeaders(headers), null)?.name, 'X-Shopify-Hmac-Sha256');
    assert.equal(
      preselectHeader(
        signatureHeaders([
          ['A', '1'],
          ['X-SIGNATURE', '2'],
          ['Hmac', '3'],
        ]),
        null,
      )?.name,
      'X-SIGNATURE',
    );
  });

  it('preselects nothing when no name says so', () => {
    assert.equal(
      preselectHeader(
        signatureHeaders([
          ['Content-Type', 'text/plain'],
          ['X-Sig', 'aa'],
        ]),
        null,
      ),
      null,
    );
    assert.equal(preselectHeader([], null), null);
  });

  it('opens on the header chosen last when this request has it, else on the rule', () => {
    const offered = signatureHeaders(headers);

    assert.equal(preselectHeader(offered, 'x-hub-signature-256')?.name, 'X-Hub-Signature-256');
    assert.equal(preselectHeader(offered, 'Content-Type')?.name, 'Content-Type');
    assert.equal(preselectHeader(offered, 'X-Missing')?.name, 'X-Shopify-Hmac-Sha256');
  });
});

describe('checkSignature', () => {
  const body = utf8(GITHUB_BODY);
  const mac = reference('SHA-256', SECRET, body);
  const hex = mac.toString('hex');
  const base64 = mac.toString('base64');

  it('matches sha256=<hex>, bare hex, upper-case hex and Base64, and names the encoding', async () => {
    const forms: [string, string][] = [
      [`sha256=${hex}`, 'hex'],
      [hex, 'hex'],
      [hex.toUpperCase(), 'hex'],
      [`sha256=${hex.toUpperCase()}`, 'hex'],
      [base64, 'Base64'],
      [`sha256=${base64}`, 'Base64'],
      [`  ${hex}  `, 'hex'],
    ];

    for (const [value, encoding] of forms) {
      const result = await check([value]);

      assert.equal(result.kind, 'match', value);
      assert.equal(result.kind === 'match' && result.match.encoding, encoding, value);
      assert.equal(result.kind === 'match' && result.byteCount, body.length);
    }
  });

  it('does not match another secret, and gives the computed value in the header form', async () => {
    const result = await check([`sha256=${hex}`], { secret: 'another-secret' });
    const other = reference('SHA-256', 'another-secret', body).toString('hex');

    assert.equal(result.kind, 'no-match');
    assert.equal(result.kind === 'no-match' && result.computed, `sha256=${other}`);
  });

  it('does not match a body one byte different from what was signed', async () => {
    const changed = utf8(GITHUB_BODY.replace('main', 'mair'));
    const result = await check([`sha256=${hex}`], { body: changed });

    assert.equal(changed.length, body.length);
    assert.equal(result.kind, 'no-match');
    assert.equal(
      result.kind === 'no-match' && result.computed,
      `sha256=${reference('SHA-256', SECRET, changed).toString('hex')}`,
    );
  });

  it('matches SHA-1 and SHA-512 likewise, preselected from the prefix or the length', async () => {
    for (const algorithm of ['SHA-1', 'SHA-512'] as const) {
      const digest = reference(algorithm, SECRET, body);
      const prefix = algorithm === 'SHA-1' ? 'sha1=' : 'sha512=';

      for (const value of [
        `${prefix}${digest.toString('hex')}`,
        digest.toString('hex'),
        digest.toString('base64'),
      ]) {
        assert.equal(detectAlgorithm([value]), algorithm, value);

        const result = await check([value]);

        assert.equal(result.kind, 'match', value);
        assert.equal(result.kind === 'match' && result.algorithm, algorithm);
      }
    }
  });

  it("matches GitHub's X-Hub-Signature and X-Hub-Signature-256 whichever comes first", async () => {
    const sha1 = `sha1=${reference('SHA-1', SECRET, body).toString('hex')}`;
    const sha256 = `sha256=${hex}`;

    for (const order of [
      [
        ['X-Hub-Signature', sha1],
        ['X-Hub-Signature-256', sha256],
      ],
      [
        ['X-Hub-Signature-256', sha256],
        ['X-Hub-Signature', sha1],
      ],
    ] as [string, string][][]) {
      const offered = signatureHeaders(order);
      const { header: chosen, algorithm } = signatureChoice(offered, EMPTY_SIGNATURE_MEMORY);

      assert.equal(chosen?.name, order[0]?.[0]);

      const result = await checkSignature({ header: chosen, secret: SECRET, algorithm, body });

      assert.equal(result.kind, 'match', order[0]?.[0]);
    }
  });

  it('matches a duplicated header when any of its values matches, and says which', async () => {
    const result = await check([`sha256=${'0'.repeat(64)}`, `sha256=${hex}`]);

    assert.equal(result.kind, 'match');
    assert.equal(result.kind === 'match' && result.match.index, 1);
    assert.equal(
      result.kind === 'match' && describeCheck(result),
      `HMAC-SHA256 of the body, ${body.length} bytes · hex · X-Hub-Signature-256, value 2 of 2`,
    );

    const neither = await check([`sha256=${'0'.repeat(64)}`, `sha256=${'1'.repeat(64)}`]);

    assert.equal(neither.kind, 'no-match');
    assert.equal(
      neither.kind === 'no-match' && describeCheck(neither),
      `HMAC-SHA256 of the body, ${body.length} bytes · X-Hub-Signature-256, 2 values`,
    );
  });

  it('asks for a header, then for a secret, before computing anything', async () => {
    assert.deepEqual(
      await checkSignature({ header: null, secret: SECRET, algorithm: 'SHA-256', body }),
      { kind: 'no-header' },
    );
    assert.deepEqual(
      await checkSignature({ header: null, secret: '', algorithm: 'SHA-256', body }),
      { kind: 'no-header' },
    );
    assert.deepEqual(await check([hex], { secret: '' }), { kind: 'no-secret' });
    assert.deepEqual(checkBeforeComputing({ header: header('X', hex), secret: '' }), {
      kind: 'no-secret',
    });
    assert.equal(checkBeforeComputing({ header: header('X', hex), secret: 's' }), null);
    assert.equal(SIGNATURE_TEXT.noHeader, 'Choose the header that holds the signature.');
    assert.equal(SIGNATURE_TEXT.noSecret, 'Type the secret to check.');
  });

  it('names Stripe, Slack and Standard Webhooks in the hint', () => {
    for (const provider of ['Stripe', 'Slack', 'Standard Webhooks']) {
      assert.ok(SIGNATURE_TEXT.hint.includes(provider), provider);
    }
  });
});

describe('the bytes that are signed', () => {
  function source(overrides: Partial<BodySource>): BodySource {
    return {
      method: 'POST',
      body: '',
      bodyBase64: null,
      isBinary: false,
      bodySize: 0,
      ...overrides,
    };
  }

  async function matches(request: BodySource, signed: Uint8Array): Promise<boolean> {
    const value = `sha256=${reference('SHA-256', SECRET, signed).toString('hex')}`;
    const result = await check([value], { body: receivedBodyBytes(request) });

    return result.kind === 'match' && result.byteCount === signed.length;
  }

  it('signs a body with a leading BOM with the mark the backend removed put back', async () => {
    const sent = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]);
    const request = source({ body: '{"a":1}', bodySize: sent.length });

    assert.equal(await matches(request, sent), true);
    // Signed without the mark, it is a different HMAC, and the check says so.
    assert.equal(await matches(request, Buffer.from('{"a":1}')), false);
  });

  it('signs a binary body as its decoded bytes', async () => {
    const sent = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a]);
    const request = source({
      body: null,
      bodyBase64: sent.toString('base64'),
      isBinary: true,
      bodySize: sent.length,
    });

    assert.equal(await matches(request, sent), true);
  });

  it('signs an empty body, and a HEAD, as zero bytes', async () => {
    assert.equal(await matches(source({}), new Uint8Array(0)), true);
    assert.equal(
      await matches(source({ method: 'HEAD', body: 'ignored', bodySize: 7 }), new Uint8Array(0)),
      true,
    );

    const empty = await check(
      [`sha256=${reference('SHA-256', SECRET, utf8('')).toString('hex')}`],
      {
        body: new Uint8Array(0),
      },
    );

    assert.equal(empty.kind === 'match' && describeCheck(empty).includes('0 bytes'), true);
  });

  it('signs a 1 MiB body quickly', async () => {
    const big = new Uint8Array(1024 * 1024).fill(0x61);
    const started = performance.now();

    assert.equal(
      await matches(source({ body: 'a'.repeat(big.length), bodySize: big.length }), big),
      true,
    );
    assert.ok(performance.now() - started < 2000, 'took too long');
  });
});

describe('formatComputed', () => {
  const mac = fromHex('8ea3ccaee07204d2bf975f63d9d2ba07cf2323f4aa50926d18df79e8bd3e0de7');
  const hex = toHex(mac);

  it("writes the header's prefix and its encoding", () => {
    assert.equal(formatComputed(mac, 'SHA-256', `sha256=${'a'.repeat(64)}`), `sha256=${hex}`);
    assert.equal(formatComputed(mac, 'SHA-256', 'a'.repeat(64)), hex);
    assert.equal(formatComputed(mac, 'SHA-256', 'A'.repeat(64)), hex.toUpperCase());
    assert.equal(formatComputed(mac, 'SHA-256', `sha256=${'0'.repeat(64)}`), `sha256=${hex}`);
    assert.equal(formatComputed(mac, 'SHA-256', 'qUiU7/zfhTMBNw=='), toBase64(mac));
    assert.equal(formatComputed(mac, 'SHA-256', `v1=${'a'.repeat(64)}`), `v1=${hex}`);
  });

  it('renames a prefix naming another algorithm for the one checked, in its case', () => {
    assert.equal(formatComputed(mac, 'SHA-256', `sha1=${'a'.repeat(40)}`), `sha256=${hex}`);
    assert.equal(
      formatComputed(mac, 'SHA-256', `SHA1=${'A'.repeat(40)}`),
      `SHA256=${hex.toUpperCase()}`,
    );
  });

  it('gives bare lower-case hex for a value it cannot read a form from', () => {
    assert.equal(formatComputed(mac, 'SHA-256', 't=1700000000,v1=abc'), hex);
    assert.equal(formatComputed(mac, 'SHA-256', 'v1,abc def'), hex);
    assert.equal(formatComputed(mac, 'SHA-256', ''), hex);
    assert.equal(formatComputed(mac, 'SHA-256', undefined), hex);
  });
});

describe('matchSignature', () => {
  const mac = fromHex('00ff10');

  it('compares hex in either case and Base64 exactly', () => {
    assert.deepEqual(matchSignature(mac, ['00ff10']), { index: 0, encoding: 'hex' });
    assert.deepEqual(matchSignature(mac, ['00FF10']), { index: 0, encoding: 'hex' });
    assert.deepEqual(matchSignature(mac, ['AP8Q']), { index: 0, encoding: 'Base64' });
    assert.equal(matchSignature(mac, ['ap8q']), null);
    assert.equal(matchSignature(mac, ['00ff1']), null);
    assert.equal(matchSignature(mac, ['00ff100']), null);
    assert.equal(matchSignature(mac, ['']), null);
    assert.equal(matchSignature(mac, []), null);
  });
});

describe('what the result says', () => {
  it('names the algorithm, the byte count, the encoding on a match, and the header', () => {
    const base = {
      algorithm: 'SHA-256' as const,
      header: 'X-Hub-Signature-256',
      byteCount: 159,
      valueCount: 1,
    };

    assert.equal(
      describeCheck({ kind: 'match', ...base, match: { index: 0, encoding: 'hex' } }),
      'HMAC-SHA256 of the body, 159 bytes · hex · X-Hub-Signature-256',
    );
    assert.equal(
      describeCheck({ kind: 'no-match', ...base, computed: 'x' }),
      'HMAC-SHA256 of the body, 159 bytes · X-Hub-Signature-256',
    );
    assert.equal(
      describeCheck({
        kind: 'match',
        ...base,
        header: 'X-Signature',
        byteCount: 2048,
        match: { index: 0, encoding: 'Base64' },
      }),
      'HMAC-SHA256 of the body, 2,048 bytes · Base64 · X-Signature',
    );
    assert.equal(hmacName('SHA-1'), 'HMAC-SHA1');
    assert.equal(hmacName('SHA-512'), 'HMAC-SHA512');
    assert.equal(formatByteCount(0), '0 bytes');
    assert.equal(formatByteCount(1), '1 byte');
    assert.equal(formatByteCount(1048576), '1,048,576 bytes');
  });
});

describe('what is remembered between requests', () => {
  const hub = signatureHeaders([
    ['X-Hub-Signature', `sha1=${'a'.repeat(40)}`],
    ['X-Hub-Signature-256', `sha256=${'a'.repeat(64)}`],
  ]);
  const other = signatureHeaders([['X-Signature', 'b'.repeat(128)]]);

  it('preselects the algorithm from the chosen header until the tester switches it', () => {
    let memory = EMPTY_SIGNATURE_MEMORY;

    assert.deepEqual(
      signatureChoice(hub, memory).algorithm,
      'SHA-1',
      'X-Hub-Signature first, sha1=',
    );

    memory = chooseHeader(memory, hub[1] as SignatureHeader);
    assert.equal(signatureChoice(hub, memory).header?.name, 'X-Hub-Signature-256');
    assert.equal(signatureChoice(hub, memory).algorithm, 'SHA-256');

    memory = chooseAlgorithm(memory, hub[1] as SignatureHeader, 'SHA-512');
    assert.equal(signatureChoice(hub, memory).algorithm, 'SHA-512');

    // Another request with the same header: the same header and algorithm.
    assert.deepEqual(
      signatureChoice(signatureHeaders([['x-hub-signature-256', 'zz']]), memory).algorithm,
      'SHA-512',
    );

    // A request without it: the preselection rule, the algorithm from its value.
    assert.equal(signatureChoice(other, memory).header?.name, 'X-Signature');
    assert.equal(signatureChoice(other, memory).algorithm, 'SHA-512');
    assert.equal(
      signatureChoice(signatureHeaders([['X-Signature', 'a'.repeat(40)]]), memory).algorithm,
      'SHA-1',
    );

    // Choosing a header by hand preselects its algorithm again.
    memory = chooseHeader(memory, hub[0] as SignatureHeader);
    assert.equal(signatureChoice(hub, memory).algorithm, 'SHA-1');
  });

  it('keeps the algorithm switched with no header chosen while there is none', () => {
    const memory = chooseAlgorithm(EMPTY_SIGNATURE_MEMORY, null, 'SHA-1');

    assert.deepEqual(signatureChoice([], memory), { header: null, algorithm: 'SHA-1' });
    assert.equal(signatureChoice(other, memory).algorithm, 'SHA-512');
  });

  it('keeps the secret as typed', () => {
    const memory = { ...EMPTY_SIGNATURE_MEMORY, secret: ' spaced secret ' };

    assert.equal(chooseHeader(memory, hub[0] as SignatureHeader).secret, ' spaced secret ');
    assert.equal(chooseAlgorithm(memory, null, 'SHA-1').secret, ' spaced secret ');
  });
});

describe('hostile header values at growing sizes', () => {
  // Built to make the prefix, hex and Base64 patterns backtrack, and to be
  // as large as a header line ever gets and far beyond.
  const shapes: [string, (size: number) => string][] = [
    ['letters then a stray character', (size) => `${'a'.repeat(size)}!`],
    ['a long prefix name', (size) => `${'a'.repeat(size)}=b`],
    ['equals signs', (size) => '='.repeat(size)],
    ['Base64 alphabet then too much padding', (size) => `${'A'.repeat(size)}===`],
    ['hex then a space', (size) => `${'f'.repeat(size)} `],
    ['a prefix then equals signs', (size) => `sha256=${'='.repeat(size)}`],
    ['alternating = and letters', (size) => 'a='.repeat(size / 2)],
    ['white space', (size) => ' \t'.repeat(size / 2)],
  ];
  const mac = fromHex('00ff10');

  for (const size of [1_000, 100_000, 1_000_000]) {
    it(`parses, detects, matches and formats ${size.toLocaleString('en-US')}-character values in time`, () => {
      for (const [name, make] of shapes) {
        const value = make(size);
        const started = performance.now();

        parseSignature(value);
        assert.equal(typeof detectAlgorithm([value]), 'string', name);
        assert.equal(matchSignature(mac, [value]), null, name);
        assert.equal(typeof formatComputed(mac, 'SHA-256', value), 'string', name);

        const took = performance.now() - started;

        assert.ok(took < 1000, `${name} at ${size} took ${Math.round(took)} ms`);
      }
    });
  }
});
