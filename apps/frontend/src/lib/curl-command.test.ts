/**
 * `Copy as cURL` (D167): each rule of the command, on the command text. That
 * the commands really re-send the request - through sh, bash and zsh, with
 * real curl - is `curl-command.roundtrip.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCurlCommand,
  EXCLUDED_HEADER_NAMES,
  INLINE_BODY_MAX_BYTES,
  isExcludedHeader,
  quote,
  type CurlSource,
} from './curl-command.ts';

const SESSION_ID = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';
const TARGET = { origin: 'https://qa-tools.ru', sessionId: SESSION_ID };
const JSON_BODY = '{"event":"order.paid","id":"evt_1Q2w3E4r5T6y7U8i"}';

/** A captured request with a text body, as the detail endpoint returns it. */
function request(overrides: Partial<CurlSource> = {}): CurlSource {
  const body = overrides.body ?? '';

  return {
    method: 'POST',
    path: `/s/${SESSION_ID}`,
    queryString: '',
    headers: [],
    body,
    bodyBase64: null,
    isBinary: false,
    bodySize: new TextEncoder().encode(body).length,
    ...overrides,
  };
}

/** A captured request whose body is not UTF-8. */
function binaryRequest(bytes: number[], overrides: Partial<CurlSource> = {}): CurlSource {
  return request({
    body: null,
    bodyBase64: Buffer.from(bytes).toString('base64'),
    isBinary: true,
    bodySize: bytes.length,
    ...overrides,
  });
}

function build(overrides: Partial<CurlSource> = {}): string {
  return buildCurlCommand(request(overrides), TARGET);
}

/** The command's lines, less the ` \` that joins them and the indent. */
function lines(command: string): string[] {
  return command.split(' \\\n  ');
}

/** A lower-case header name as written, in capitals and capitalised. */
function spellings(name: string): string[] {
  return [
    name,
    name.toUpperCase(),
    name.replace(/(^|-)(\w)/g, (_, dash: string, first: string) => dash + first.toUpperCase()),
  ];
}

/** A header value as Node would have read it off the wire (D145). */
const wire = (text: string) => Buffer.from(text, 'utf8').toString('latin1');

/**
 * The eleven names the in-cluster proxy managed (D144): left out of the
 * command until #114, kept since, and still dropped by the relay (D202).
 */
const PROXY_HEADER_NAMES = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-forwarded-server',
  'x-forwarded-uri',
  'x-forwarded-method',
  'x-forwarded-prefix',
  'x-forwarded-tls-client-cert',
  'x-forwarded-tls-client-cert-info',
  'x-real-ip',
];

describe('buildCurlCommand', () => {
  it('writes the approved sample: one option per line, joined by " \\"', () => {
    // `Host` and `Content-Length` are curl's; `Accept-Encoding: gzip` is kept
    // since #114, like any other header.
    const command = build({
      queryString: 'source=demo&runId=1842',
      headers: [
        ['Host', 'qa-tools.ru'],
        ['User-Agent', 'Shop-Webhooks/2.4'],
        ['Content-Type', 'application/json'],
        ['Content-Length', '50'],
        ['X-Signature', 't=1790243049,v1=5257a869e7ecebeda32affa62cdca3fa'],
        ['Accept-Encoding', 'gzip'],
      ],
      body: JSON_BODY,
    });

    assert.equal(
      command,
      [
        `curl 'https://qa-tools.ru/s/${SESSION_ID}?source=demo&runId=1842' \\`,
        `  -H 'User-Agent: Shop-Webhooks/2.4' \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -H 'X-Signature: t=1790243049,v1=5257a869e7ecebeda32affa62cdca3fa' \\`,
        `  -H 'Accept-Encoding: gzip' \\`,
        `  -H 'Accept:' \\`,
        `  --data-raw '${JSON_BODY}'`,
      ].join('\n'),
    );
  });

  describe('the URL', () => {
    it('is the origin, the stored path and the query string, single-quoted', () => {
      assert.equal(
        lines(build({ queryString: 'a=1&b=%2B' }))[0],
        `curl 'https://qa-tools.ru/s/${SESSION_ID}?a=1&b=%2B'`,
      );
    });

    it('has no `?` when the query string is empty', () => {
      assert.equal(lines(build())[0], `curl 'https://qa-tools.ru/s/${SESSION_ID}'`);
    });

    it('keeps the path exactly as stored: a trailing slash, a sub-path, percent-encoding', () => {
      for (const path of [
        `/s/${SESSION_ID}/`,
        `/s/${SESSION_ID}/stripe/events`,
        `/s/${SESSION_ID}/a%2Fb/%E2%82%AC`,
      ]) {
        assert.equal(lines(build({ path }))[0], `curl 'https://qa-tools.ru${path}'`);
      }
    });

    it('uses /s/<session-id> for a request captured before its path was stored', () => {
      assert.equal(
        lines(build({ path: null, queryString: 'x=1' }))[0],
        `curl 'https://qa-tools.ru/s/${SESSION_ID}?x=1'`,
      );
    });

    it('escapes a single quote', () => {
      assert.equal(
        lines(build({ queryString: "name=O'Brien" }))[0],
        `curl 'https://qa-tools.ru/s/${SESSION_ID}?name=O'\\''Brien'`,
      );
    });

    it('adds --globoff for each of [ ] { }, and only for them', () => {
      for (const queryString of ['a[]=1', 'a]=1', 'b={x}', 'b=}', 'b={', 'a[0]=1']) {
        assert.ok(lines(build({ queryString })).includes('--globoff'), queryString);
      }

      for (const queryString of ['', 'a=1&b=(2)', 'q=%5B%5D', 'x=*?']) {
        assert.ok(!lines(build({ queryString })).includes('--globoff'), queryString);
      }
    });

    it('adds --path-as-is for a . or .. segment of the path, and only for one', () => {
      for (const path of [
        `/s/${SESSION_ID}/./x`,
        `/s/${SESSION_ID}/a/../b`,
        `/s/${SESSION_ID}/..`,
        `/s/${SESSION_ID}/.`,
      ]) {
        assert.ok(lines(build({ path })).includes('--path-as-is'), path);
      }

      for (const path of [
        `/s/${SESSION_ID}/.well-known/x`,
        `/s/${SESSION_ID}/a.b/c..d`,
        `/s/${SESSION_ID}/...`,
        `/s/${SESSION_ID}/%2e%2e/x`,
      ]) {
        assert.ok(!lines(build({ path })).includes('--path-as-is'), path);
      }

      // A dot segment in the query string is not in the path.
      assert.ok(!lines(build({ queryString: 'next=../x' })).includes('--path-as-is'));
    });
  });

  describe('the method', () => {
    it('writes HEAD as --head, never -X HEAD', () => {
      const command = build({ method: 'HEAD', body: '' });

      assert.ok(lines(command).includes('--head'));
      assert.doesNotMatch(command, /-X/);
    });

    it('never gives a HEAD a body: none is captured for one, and curl refuses --head with data', () => {
      const command = build({ method: 'HEAD', body: 'x', bodySize: 1 });

      assert.doesNotMatch(command, /--data|printf/);
    });

    it('leaves out -X where curl infers the method: GET without a body, POST with one', () => {
      assert.doesNotMatch(build({ method: 'GET' }), /-X|--head/);
      assert.doesNotMatch(build({ method: 'POST', body: 'x' }), /-X|--head/);
    });

    it('writes -X for every other method, GET with a body and POST without one included', () => {
      assert.ok(lines(build({ method: 'GET', body: 'x' })).includes('-X GET'));
      assert.ok(lines(build({ method: 'POST' })).includes('-X POST'));

      for (const method of [
        'PUT',
        'PATCH',
        'DELETE',
        'OPTIONS',
        'TRACE',
        'QUERY',
        'PROPFIND',
        'M-SEARCH',
      ]) {
        assert.ok(lines(build({ method })).includes(`-X ${method}`), method);
        assert.ok(lines(build({ method, body: 'x' })).includes(`-X ${method}`), method);
      }
    });
  });

  describe('the headers', () => {
    it('leaves out exactly these names, pinned', () => {
      assert.deepEqual(
        [...EXCLUDED_HEADER_NAMES].sort(),
        [
          // What curl computes.
          'host',
          'content-length',
          // Hop by hop, and Expect.
          'connection',
          'keep-alive',
          'transfer-encoding',
          'te',
          'trailer',
          'upgrade',
          'proxy-connection',
          'expect',
        ].sort(),
      );
    });

    it('leaves each of them out in any case, and keeps near misses', () => {
      for (const name of EXCLUDED_HEADER_NAMES) {
        for (const spelling of spellings(name)) {
          assert.equal(isExcludedHeader([spelling, 'v']), true, spelling);
          assert.doesNotMatch(build({ headers: [[spelling, 'v']] }), new RegExp(`'${spelling}`));
        }
      }

      for (const name of [
        'X-Forwarded-By',
        'X_Forwarded_For',
        'Forwarded',
        'Hostname',
        'Content-Type',
        'Content-Length-X',
        'X-Host',
        'Expects',
      ]) {
        assert.equal(isExcludedHeader([name, 'v']), false, name);
        assert.ok(lines(build({ headers: [[name, 'v']] })).includes(`-H '${name}: v'`), name);
      }
    });

    it('keeps Accept-Encoding whatever its value, gzip included, in any case of the name', () => {
      for (const name of [
        'Accept-Encoding',
        'accept-encoding',
        'ACCEPT-ENCODING',
        'aCcEpT-eNcOdInG',
      ]) {
        for (const value of [
          'gzip',
          'GZIP',
          ' gzip',
          'gzip, deflate',
          'br',
          'gzip;q=1.0',
          'identity',
          '',
        ]) {
          assert.equal(isExcludedHeader([name, value]), false, `${name}: ${value}`);
          assert.ok(
            lines(build({ headers: [[name, value]] })).includes(
              value === '' ? `-H '${name};'` : `-H '${name}: ${value}'`,
            ),
            `${name}: ${value}`,
          );
        }
      }
    });

    it('keeps the eleven proxy names of D144, in any case, whatever the value', () => {
      for (const name of PROXY_HEADER_NAMES) {
        for (const spelling of spellings(name)) {
          for (const value of ['203.0.113.7', 'gzip', '']) {
            assert.equal(isExcludedHeader([spelling, value]), false, `${spelling}: ${value}`);
          }

          assert.ok(
            lines(build({ headers: [[spelling, '203.0.113.7']] })).includes(
              `-H '${spelling}: 203.0.113.7'`,
            ),
            spelling,
          );
        }
      }
    });

    it('writes forwarding headers in captured order, case and duplicates, interleaved, one -H each', () => {
      const headers: [string, string][] = [
        ['X-Forwarded-For', '203.0.113.7'],
        ['Host', 'qa-tools.ru'],
        ['x-real-ip', '203.0.113.8'],
        ['X-Signature', 'v1=abc'],
        ['x-forwarded-for', '198.51.100.1, 203.0.113.7'],
        ['Accept-Encoding', 'gzip'],
        ['X-FORWARDED-FOR', '192.0.2.1'],
        ['Content-Length', '0'],
        ['X-Forwarded-Proto', 'https'],
        ['X-Forwarded-Host', 'shop.example'],
        ['accept-encoding', 'gzip'],
      ];

      assert.deepEqual(
        lines(build({ headers })).filter((line) => line.startsWith('-H') && !line.endsWith(":'")),
        headers
          .filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase()))
          .map(([name, value]) => `-H '${name}: ${value}'`),
      );
    });

    it('writes hostile forwarding values so that no shell reads them, one -H each', () => {
      // As Node reads them, one character per byte (D145).
      const latin1 = (bytes: number[]) => Buffer.from(bytes).toString('latin1');
      const cases: [string, string][] = [
        // Quoted as text: everything inside single quotes is literal.
        ["it's", `-H 'X-Forwarded-For: it'\\''s'`],
        ['$(id) `id` !! %s %% \\ "', `-H 'X-Forwarded-For: $(id) \`id\` !! %s %% \\ "'`],
        [wire('Иван'), `-H 'X-Forwarded-For: Иван'`],
        ['a\tb', `-H 'X-Forwarded-For: a\tb'`],
        ['', `-H 'X-Forwarded-For;'`],
        // Through printf: not UTF-8, or a control a paste would not keep.
        [latin1([0xe9, 0x27, 0x21]), `-H "$(printf 'X-Forwarded-For: \\351\\047\\041')"`],
        [latin1([0x61, 0x85, 0x62]), `-H "$(printf 'X-Forwarded-For: a\\205b')"`],
        [wire('a\u009bb'), `-H "$(printf 'X-Forwarded-For: a\\302\\233b')"`],
        ['a\u0000\u001b[2J\u007fb', `-H "$(printf 'X-Forwarded-For: a\\000\\033\\1332J\\177b')"`],
      ];

      for (const [value, line] of cases) {
        assert.ok(lines(build({ headers: [['X-Forwarded-For', value]] })).includes(line), line);
      }
    });

    it('grows linearly with X-Forwarded-For lines: 100, 500, the about 1,000 of 16 KiB, 10,000', () => {
      const sizes = [100, 500, 1_000, 10_000];
      const perLine: number[] = [];

      for (const count of sizes) {
        const headers = Array.from({ length: count }, (_, index): [string, string] => [
          'X-Forwarded-For',
          `203.0.113.${index % 256}`,
        ]);
        const started = performance.now();
        const command = build({ headers });
        const elapsed = performance.now() - started;

        assert.ok(elapsed < 1_000, `${count} lines took ${Math.round(elapsed)} ms`);
        assert.equal(
          lines(command).filter((line) => line.startsWith(`-H 'X-Forwarded-For: `)).length,
          count,
        );
        perLine.push(command.length / count);
      }

      // The same few dozen characters per line at every size, never more.
      for (const length of perLine) {
        assert.ok(length < 2 * (perLine.at(-1) ?? 0), `${length} characters a line`);
      }
    });

    it('keeps captured order, case and duplicates, one -H each', () => {
      const command = build({
        headers: [
          ['x-b', '1'],
          ['X-A', '2'],
          ['Host', 'qa-tools.ru'],
          ['x-b', '3'],
          ['X-B', '4'],
        ],
      });

      assert.deepEqual(
        lines(command).filter((line) => line.startsWith('-H') && !line.endsWith(":'")),
        [`-H 'x-b: 1'`, `-H 'X-A: 2'`, `-H 'x-b: 3'`, `-H 'X-B: 4'`],
      );
    });

    it('writes an empty value as Name; because Name: would remove the header', () => {
      const command = build({
        headers: [
          ['X-Empty', ''],
          ['X-Full', 'v'],
        ],
      });

      assert.ok(lines(command).includes(`-H 'X-Empty;'`));
      assert.ok(!lines(command).includes(`-H 'X-Empty:'`));
    });

    it('escapes a single quote in a value', () => {
      assert.ok(
        lines(build({ headers: [['X-Name', "O'Brien"]] })).includes(`-H 'X-Name: O'\\''Brien'`),
      );
    });

    it("removes curl's own User-Agent and Accept when none was captured", () => {
      const command = lines(build());

      assert.ok(command.includes(`-H 'User-Agent:'`));
      assert.ok(command.includes(`-H 'Accept:'`));
    });

    it('keeps a captured User-Agent and Accept, in any case, and removes nothing then', () => {
      const command = lines(
        build({
          headers: [
            ['user-agent', 'Shop/2.4'],
            ['ACCEPT', '*/*'],
          ],
        }),
      );

      assert.ok(command.includes(`-H 'user-agent: Shop/2.4'`));
      assert.ok(command.includes(`-H 'ACCEPT: */*'`));
      assert.ok(!command.includes(`-H 'User-Agent:'`));
      assert.ok(!command.includes(`-H 'Accept:'`));
    });

    it('sends a captured empty User-Agent empty instead of removing it', () => {
      const command = lines(build({ headers: [['User-Agent', '']] }));

      assert.ok(command.includes(`-H 'User-Agent;'`));
      assert.ok(!command.includes(`-H 'User-Agent:'`));
    });

    it("removes curl's form Content-Type when a body is sent without a captured one", () => {
      assert.ok(lines(build({ body: 'a=1' })).includes(`-H 'Content-Type:'`));
      assert.ok(
        lines(buildCurlCommand(binaryRequest([0xff]), TARGET)).includes(`-H 'Content-Type:'`),
      );
      // No body, nothing for curl to label.
      assert.ok(!lines(build({ body: '' })).includes(`-H 'Content-Type:'`));
      // A captured one, in any case, is sent instead.
      assert.ok(
        !lines(build({ body: 'a=1', headers: [['content-type', 'text/plain']] })).includes(
          `-H 'Content-Type:'`,
        ),
      );
    });

    it('writes a UTF-8 value as the text it encodes, so a paste sends the same bytes', () => {
      // Node reads header bytes one character per byte (D145).
      const received = Buffer.from('Иван', 'utf8').toString('latin1');

      assert.ok(lines(build({ headers: [['X-Name', received]] })).includes(`-H 'X-Name: Иван'`));
    });

    it('writes a value that is not UTF-8 through printf, byte for byte', () => {
      // `café`, then every character a shell or `printf` could read: `%`,
      // `\`, `'`, `!`, `"`, a backtick, `$` and `)`.
      const received = `${Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('latin1')} %\\'!"\`$(x)`;

      assert.ok(
        lines(build({ headers: [['X-Name', received]] })).includes(
          `-H "$(printf 'X-Name: caf\\351 \\045\\134\\047\\041\\042\\140\\044\\050x\\051')"`,
        ),
      );
    });

    it('writes no ! in the printf form, where interactive bash 3.2 would expand it', () => {
      const command = build({ headers: [['X-Bang', `${String.fromCharCode(0xe9)}!!`]] });

      assert.ok(lines(command).includes(`-H "$(printf 'X-Bang: \\351\\041\\041')"`));
      assert.doesNotMatch(command, /!/);
    });

    it('escapes a leading - of the printf format, so printf never reads an option', () => {
      const command = build({ headers: [['-X-Odd', String.fromCharCode(0xe9)]] });

      assert.ok(lines(command).includes(`-H "$(printf '\\055X-Odd: \\351')"`));
      // Quoted as text, a leading - is only the argument of -H.
      assert.ok(lines(build({ headers: [['-X-Odd', 'v']] })).includes(`-H '-X-Odd: v'`));
    });
  });

  describe('the body', () => {
    it('has no data option when it is empty', () => {
      for (const body of ['', null]) {
        const command = build({ body, method: 'PUT' });

        assert.doesNotMatch(command, /--data|printf/);
      }
    });

    it('is inline with --data-raw, not --data-binary, even when it starts with @', () => {
      assert.equal(lines(build({ body: '@/etc/passwd' })).at(-1), `--data-raw '@/etc/passwd'`);
    });

    it('escapes a single quote, and keeps tabs and line feeds inline', () => {
      assert.equal(
        lines(build({ body: '{\n\t"it\'s": 1\n}' })).at(-1),
        `--data-raw '{\n\t"it'\\''s": 1\n}'`,
      );
    });

    it('is inline up to 64 KiB of UTF-8, counted in bytes', () => {
      const atLimit = 'é'.repeat(INLINE_BODY_MAX_BYTES / 2);

      assert.equal(INLINE_BODY_MAX_BYTES, 65_536);
      assert.equal(lines(build({ body: atLimit })).at(-1), `--data-raw '${atLimit}'`);
      // Half as many characters as bytes: one byte more no longer fits.
      assert.match(build({ body: `${atLimit}x` }), /^printf '%s' '/);
    });

    it('pipes larger text from printf into --data-binary @-', () => {
      const text = `it's ${'x'.repeat(INLINE_BODY_MAX_BYTES)}`;
      const command = build({ body: text, headers: [['Content-Type', 'text/plain']] });

      assert.equal(
        command,
        [
          `printf '%s' 'it'\\''s ${'x'.repeat(INLINE_BODY_MAX_BYTES)}' | curl 'https://qa-tools.ru/s/${SESSION_ID}' \\`,
          `  -H 'Content-Type: text/plain' \\`,
          `  -H 'User-Agent:' \\`,
          `  -H 'Accept:' \\`,
          `  --data-binary @-`,
        ].join('\n'),
      );
    });

    it('pipes a binary body as Base64 through base64 --decode', () => {
      const bytes = [0x00, 0x01, 0xff, 0xfe, 0x27];
      const command = buildCurlCommand(
        binaryRequest(bytes, { headers: [['Content-Type', 'application/octet-stream']] }),
        TARGET,
      );

      assert.equal(
        command,
        [
          `printf '%s' '${Buffer.from(bytes).toString('base64')}' | base64 --decode | curl 'https://qa-tools.ru/s/${SESSION_ID}' \\`,
          `  -H 'Content-Type: application/octet-stream' \\`,
          `  -H 'User-Agent:' \\`,
          `  -H 'Accept:' \\`,
          `  --data-binary @-`,
        ].join('\n'),
      );
    });

    it('pipes text holding a NUL, a carriage return or another control character as Base64', () => {
      for (const body of ['a\u0000b', 'a=1\r\nb=2', 'x\u001b[201~y', 'del\u007f', 'c1\u0085']) {
        const command = build({ body });
        const base64 = /^printf '%s' '([A-Za-z0-9+/=]*)' \| base64 --decode \| curl /.exec(
          command,
        )?.[1];

        assert.equal(base64, Buffer.from(body, 'utf8').toString('base64'), JSON.stringify(body));
        assert.equal(lines(command).at(-1), '--data-binary @-');
      }
    });

    it('puts back the byte-order mark the backend removed from a text body, through Base64', () => {
      // The stored bytes began with EF BB BF; `body` is three bytes shorter.
      const command = build({ body: '{"a":1}', bodySize: 10 });

      assert.match(
        command,
        new RegExp(
          `^printf '%s' '${Buffer.from('﻿{"a":1}', 'utf8').toString('base64')}' \\| base64 --decode \\| curl `,
        ),
      );
      // A body that was nothing but the mark.
      assert.match(
        build({ body: '', bodySize: 3 }),
        /^printf '%s' '77u\/' \| base64 --decode \| curl /,
      );
    });
  });
});

describe('quote', () => {
  it('single-quotes, writing a single quote as quote, backslash-quote, quote', () => {
    assert.equal(quote(''), "''");
    assert.equal(quote("a'b"), `'a'\\''b'`);
    assert.equal(quote('$HOME `x` "y" \\n !'), `'$HOME \`x\` "y" \\n !'`);
  });
});
