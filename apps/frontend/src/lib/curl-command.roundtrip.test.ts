/**
 * `Copy as cURL` (D167), end to end: every command below is run by real
 * shells and real curl against a local server, which must receive the request
 * that was captured - the same method, path and query, header list less the
 * excluded names, and body bytes. A sender's own `X-Forwarded-*`, `X-Real-Ip`
 * and `Accept-Encoding: gzip` are among the headers re-sent (#114).
 *
 * `sh` and `curl` are required: without them this test **fails**, it never
 * skips, so CI cannot go green without having run it. CI's `test` job installs
 * curl for it, since `node:24-slim` has none. `dash`, `bash` and `zsh` are run
 * too wherever they are installed, since `sh` is dash on Debian and bash on
 * macOS, and zsh is the macOS default.
 *
 * The command is written to a file and the shell reads it from there, as it
 * would read a paste: passed with `-c` it would be one argument, and a 1 MB
 * body would hit the very argument limit the command is built to avoid.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { buildCurlCommand, isExcludedHeader, type CurlSource } from './curl-command.ts';

const run = promisify(execFile);

const SESSION_ID = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

/** What the local server received. */
interface Received {
  method: string;
  url: string;
  /** As Node reads them: one character per byte, like the capture (D145). */
  headers: [string, string][];
  body: Buffer;
}

interface Capture {
  method: string;
  /** `undefined` is `/s/<session-id>`; `null` is a request captured before paths were stored. */
  path?: string | null;
  query?: string;
  headers?: [string, string][];
  body?: Buffer | string;
  /**
   * The headers the server must receive besides `Host` and `Content-Length`,
   * written out, where a case pins them independently of the implementation's
   * own exclusion list.
   */
  arrives?: [string, string][];
}

/**
 * A request as the detail endpoint returns it, from the bytes that arrived:
 * valid UTF-8 as text - decoded as the backend decodes it, which removes a
 * leading byte-order mark - and anything else as Base64 (D043).
 */
function captured({ method, path, query = '', headers = [], body = '' }: Capture): CurlSource {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  let text: string | null;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = null;
  }

  return {
    method,
    path: path === undefined ? `/s/${SESSION_ID}` : path,
    queryString: query,
    headers,
    body: text,
    bodyBase64: text === null ? bytes.toString('base64') : null,
    isBinary: text === null,
    bodySize: bytes.length,
  };
}

/** A header value as Node would have read it off the wire. */
const wire = (text: string) => Buffer.from(text, 'utf8').toString('latin1');

const JSON_BODY = '{"event":"order.paid","id":"evt_1Q2w3E4r5T6y7U8i","total":"42.00"}';

/** Text that is awkward for a shell in every way `printf '%s'` has to survive. */
const AWKWARD_LINE = `{"it's": "$HOME \`id\` \\n %s %% !! \\\\", "имя": "Иван"}\n`;

/**
 * `café` with the `é` as the single byte `0xE9`, which is not UTF-8, then
 * every character a shell or `printf` could read: `%`, `\`, `'`, `!`, `"`, a
 * backtick, `$`, `(` and `)`.
 */
const NOT_UTF8_VALUE = `${Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('latin1')} %\\'!"\`$(x)`;

const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));

/**
 * All eleven names the proxy managed until 0.36.0 (D144), as a sender writes
 * them now: interleaved with other headers, in mixed case, `X-Forwarded-For`
 * and `X-Real-Ip` repeated, and `Accept-Encoding: gzip` in two spellings.
 */
const FORWARDING_HEADERS: [string, string][] = [
  ['X-Forwarded-For', '203.0.113.7'],
  ['Content-Type', 'application/json'],
  ['x-forwarded-host', 'shop.example'],
  ['X-FORWARDED-PORT', '8443'],
  ['X-Forwarded-Proto', 'https'],
  ['X-Forwarded-Server', 'edge-1'],
  ['X-Forwarded-Uri', '/hooks/a?b=1'],
  ['X-Forwarded-Method', 'POST'],
  ['X-Forwarded-Prefix', '/hooks'],
  ['X-Forwarded-Tls-Client-Cert', 'MIIBszCCAVmgAwIBAgIU%2Bq%3D'],
  ['X-Forwarded-Tls-Client-Cert-Info', 'Subject=%22CN%3Dclient%22'],
  ['Accept-Encoding', 'gzip'],
  ['x-real-ip', '203.0.113.8'],
  ['x-forwarded-for', '198.51.100.1, 203.0.113.7'],
  ['X-Real-IP', '203.0.113.9'],
  ['accept-encoding', 'gzip'],
];

/**
 * Forwarding and `Accept-Encoding` values holding what a shell or `printf`
 * would read, as Node reads them: `'`, `$(…)`, a backtick, `!`, `%`, a
 * backslash, UTF-8, bytes that are not UTF-8, an empty value, a tab, and the
 * C1 controls a paste would not keep - raw and UTF-8 encoded. Node refuses a
 * header holding NUL, ESC, DEL or another C0 control but tab, so no capture
 * holds one; the unit test pins how one would be written.
 */
const HOSTILE_FORWARDING_HEADERS: [string, string][] = [
  ['X-Forwarded-For', "203.0.113.7'; echo pwned '"],
  ['X-Forwarded-Host', '$(echo pwned) `echo pwned` $HOME'],
  ['X-Real-Ip', '!! !$ %s %% %n \\ \\n \\0101'],
  ['X-Forwarded-Server', wire('сервер-1 ✓')],
  ['X-Forwarded-Uri', NOT_UTF8_VALUE],
  ['-X-Forwarded-For', NOT_UTF8_VALUE],
  ['X-Forwarded-Proto', ''],
  ['X-Forwarded-Prefix', 'a\tb'],
  ['X-Forwarded-Method', Buffer.from([0x61, 0x85, 0x9b, 0x62]).toString('latin1')],
  ['X-Forwarded-Port', wire('a\u0085b\u009b[2Jc')],
  ['Accept-Encoding', "gzip'$(id)`id`!%\\"],
  ['Accept-Encoding', NOT_UTF8_VALUE],
  ['Accept-Encoding', ''],
];

/**
 * As many `X-Forwarded-For: <digit>` lines as Node's 16 KiB of request line
 * and headers holds, which is what a capture can hold and the local server
 * receives, with room for the request line and curl's `Host`: about 800.
 */
const X_FORWARDED_FOR_IN_16_KIB = Math.floor(
  (16 * 1024 - 512) / Buffer.byteLength('X-Forwarded-For: 0\r\n'),
);

/** The cases issue #43 lists, then #42's paths, then the rules D167 adds. */
const CASES: [string, Capture][] = [
  [
    "a JSON POST stored before 0.36.0: Host and Content-Length are curl's, the proxy's headers and gzip are re-sent like any other",
    {
      method: 'POST',
      query: 'source=demo&runId=1842',
      headers: [
        ['Host', 'qa-tools.ru'],
        ['User-Agent', 'Shop-Webhooks/2.4'],
        ['Content-Type', 'application/json'],
        ['Content-Length', String(Buffer.byteLength(JSON_BODY))],
        ['X-Signature', 't=1790243049,v1=5257a869e7ecebeda32affa62cdca3fa'],
        ['X-Forwarded-For', '203.0.113.7'],
        ['X-Real-Ip', '203.0.113.7'],
        ['Accept-Encoding', 'gzip'],
      ],
      body: JSON_BODY,
      arrives: [
        ['User-Agent', 'Shop-Webhooks/2.4'],
        ['Content-Type', 'application/json'],
        ['X-Signature', 't=1790243049,v1=5257a869e7ecebeda32affa62cdca3fa'],
        ['X-Forwarded-For', '203.0.113.7'],
        ['X-Real-Ip', '203.0.113.7'],
        ['Accept-Encoding', 'gzip'],
      ],
    },
  ],
  [
    "a sender's own eleven forwarding names and gzip, interleaved, in their order, case and duplicates",
    {
      method: 'POST',
      headers: FORWARDING_HEADERS,
      body: '{}',
      arrives: FORWARDING_HEADERS,
    },
  ],
  [
    "a sender's own forwarding and Accept-Encoding values that a shell or printf would read",
    {
      method: 'GET',
      headers: HOSTILE_FORWARDING_HEADERS,
      arrives: HOSTILE_FORWARDING_HEADERS,
    },
  ],
  ...[100, 500, X_FORWARDED_FOR_IN_16_KIB].map((count): [string, Capture] => {
    const headers = Array.from({ length: count }, (_, index): [string, string] => [
      'X-Forwarded-For',
      String(index % 10),
    ]);

    return [`${count} X-Forwarded-For lines`, { method: 'GET', headers, arrives: headers }];
  }),
  [
    'text above 64 KiB',
    {
      method: 'POST',
      headers: [['Content-Type', 'text/plain; charset=utf-8']],
      body: AWKWARD_LINE.repeat(Math.ceil((70 * 1024) / Buffer.byteLength(AWKWARD_LINE))),
    },
  ],
  [
    'text of about 1 MB',
    {
      method: 'PUT',
      headers: [['Content-Type', 'application/x-ndjson']],
      body: AWKWARD_LINE.repeat(Math.floor(1_000_000 / Buffer.byteLength(AWKWARD_LINE))),
    },
  ],
  [
    'a binary body: every byte value, NUL included',
    {
      method: 'POST',
      headers: [['Content-Type', 'application/octet-stream']],
      body: Buffer.concat([ALL_BYTES, Buffer.from(ALL_BYTES).reverse()]),
    },
  ],
  ['an empty body', { method: 'POST', headers: [['Content-Type', 'application/json']] }],
  ['a body starting with @', { method: 'POST', body: '@/etc/hosts' }],
  [
    'HEAD',
    {
      method: 'HEAD',
      headers: [
        ['User-Agent', 'probe/1.0'],
        ['Accept', '*/*'],
      ],
    },
  ],
  [
    'GET with a body',
    { method: 'GET', headers: [['Content-Type', 'text/plain']], body: 'q=select 1' },
  ],
  [
    'PROPFIND',
    {
      method: 'PROPFIND',
      headers: [
        ['Depth', '1'],
        ['Content-Type', 'application/xml'],
      ],
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>',
    },
  ],
  [
    'duplicate headers, in their order and case',
    {
      method: 'POST',
      headers: [
        ['X-Dup', '1'],
        ['Content-Type', 'text/plain'],
        ['x-dup', '2'],
        ['Content-Type', 'text/csv'],
        ['X-DUP', '3'],
      ],
      body: 'a,b',
    },
  ],
  [
    'an empty header value, User-Agent included',
    {
      method: 'GET',
      headers: [
        ['X-Empty', ''],
        ['User-Agent', ''],
        ['X-After', 'v'],
      ],
    },
  ],
  [
    "' in a header value, the query and the body",
    {
      method: 'POST',
      query: "name=O'Brien",
      headers: [['X-Note', "it's"]],
      body: "{'single': 'quotes'}",
    },
  ],
  ['a[]=1 and braces in the query', { method: 'GET', query: 'a[]=1&a[]=2&b[c]=d&e={f,g}' }],
  [
    'a sub-path under the session, with a trailing slash (#42)',
    { method: 'POST', path: `/s/${SESSION_ID}/stripe/events/`, query: 'x=1', body: '{}' },
  ],
  [
    'a . and a .. segment, and an encoded one (#42)',
    { method: 'DELETE', path: `/s/${SESSION_ID}/./a/../b/%2e%2e/%2Fc` },
  ],
  ['a request captured before its path was stored', { method: 'GET', path: null, query: 'y=2' }],
  [
    'hop-by-hop headers and Expect left out, an Accept-Encoding of more than gzip kept',
    {
      method: 'POST',
      headers: [
        ['Connection', 'keep-alive'],
        ['Keep-Alive', 'timeout=5'],
        ['Transfer-Encoding', 'chunked'],
        ['TE', 'trailers'],
        ['Expect', '100-continue'],
        ['Accept-Encoding', 'gzip, br'],
      ],
      body: 'x',
      arrives: [['Accept-Encoding', 'gzip, br']],
    },
  ],
  [
    'UTF-8 in a header value, a byte that is not UTF-8 among shell characters, and a name starting with -',
    {
      method: 'GET',
      headers: [
        ['X-Name', wire('Иван')],
        ['X-Latin', NOT_UTF8_VALUE],
        ['-X-Odd', NOT_UTF8_VALUE],
        ['-X-Odd', 'plain'],
      ],
      arrives: [
        ['X-Name', wire('Иван')],
        ['X-Latin', NOT_UTF8_VALUE],
        ['-X-Odd', NOT_UTF8_VALUE],
        ['-X-Odd', 'plain'],
      ],
    },
  ],
  [
    'text with CRLF line ends, as multipart is',
    {
      method: 'POST',
      headers: [['Content-Type', 'multipart/form-data; boundary=x']],
      body: '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--\r\n',
    },
  ],
  ['text with escape characters', { method: 'POST', body: 'a\u001b[201~b\u0007c\u007f' }],
  [
    'a text body that began with a byte-order mark',
    { method: 'POST', body: Buffer.from('﻿<?xml version="1.0"?><a/>', 'utf8') },
  ],
  ['QUERY', { method: 'QUERY', headers: [['Content-Type', 'application/json']], body: '{}' }],
  ['M-SEARCH', { method: 'M-SEARCH', headers: [['MAN', '"ssdp:discover"']] }],
];

describe('a copied cURL command re-sends the captured request', () => {
  let server: Server;
  let origin: string;
  let directory: string;
  let shells: string[];
  const received: Received[] = [];

  before(async () => {
    // Required, never skipped (see the file's comment).
    await assert.doesNotReject(run('curl', ['--version']), 'curl must be installed');
    await assert.doesNotReject(run('sh', ['-c', 'exit 0']), 'sh must be installed');

    shells = ['sh'];

    for (const shell of ['dash', 'bash', 'zsh']) {
      const found = await run('sh', ['-c', `command -v ${shell}`]).then(
        () => true,
        () => false,
      );

      if (found) {
        shells.push(shell);
      }
    }

    server = createServer((request, response) => {
      const chunks: Buffer[] = [];

      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const headers: [string, string][] = [];

        for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
          headers.push([request.rawHeaders[index] ?? '', request.rawHeaders[index + 1] ?? '']);
        }

        received.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers,
          body: Buffer.concat(chunks),
        });
        response.writeHead(204).end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    directory = await mkdtemp(join(tmpdir(), 'webhook-inspector-curl-'));
  });

  after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));

    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const [name, capture] of CASES) {
    it(name, { timeout: 120_000 }, async () => {
      const source = captured(capture);
      const command = buildCurlCommand(source, { origin, sessionId: SESSION_ID });
      const script = join(directory, 'command.sh');

      await writeFile(script, `${command}\n`, 'utf8');

      for (const shell of shells) {
        received.length = 0;

        const running = run(shell, [script], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });

        running.child.stdin?.end();
        await running;

        assert.equal(received.length, 1, `${shell}: one request arrives`);

        const [arrived] = received as [Received];
        const bytes =
          source.method === 'HEAD'
            ? Buffer.alloc(0)
            : typeof capture.body === 'string'
              ? Buffer.from(capture.body, 'utf8')
              : (capture.body ?? Buffer.alloc(0));

        assert.equal(arrived.method, capture.method, `${shell}: method`);
        assert.equal(
          arrived.url,
          `${source.path ?? `/s/${SESSION_ID}`}${source.queryString === '' ? '' : `?${source.queryString}`}`,
          `${shell}: path and query`,
        );
        // curl writes `Host` and `Content-Length` itself; every other header
        // that arrives must be one that was captured, in its order.
        const others = arrived.headers.filter(
          ([header]) => !['host', 'content-length'].includes(header.toLowerCase()),
        );

        assert.deepEqual(
          others,
          source.headers.filter((pair) => !isExcludedHeader(pair)),
          `${shell}: headers`,
        );

        // And, where a case writes them out, exactly these: a check that does
        // not lean on the implementation's own list.
        if (capture.arrives !== undefined) {
          assert.deepEqual(others, capture.arrives, `${shell}: headers, written out`);
        }
        assert.deepEqual(
          arrived.headers.filter(([header]) => header.toLowerCase() === 'content-length'),
          bytes.length === 0 ? [] : [['Content-Length', String(bytes.length)]],
          `${shell}: Content-Length`,
        );
        assert.ok(arrived.body.equals(bytes), `${shell}: body bytes`);
      }
    });
  }
});
