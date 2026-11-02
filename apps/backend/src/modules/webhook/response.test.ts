/**
 * The webhook reply as it is composed, without a server (D100, D101, D223):
 * the default answer's nine keys in their order and nothing else, made-up
 * paths built to break its JSON at growing sizes up to Node's 16 KiB, its
 * size and `HEAD` framing, and a custom response or a queue step byte for
 * byte as before, whatever the request it answers - and a template filled in
 * from it only with the opt-in (D251).
 * `capture-budget.test.ts` holds its worst case against the reserve, and
 * `webhook.test.ts` the same answer over real sockets.
 */
import assert from 'node:assert/strict';
import { maxHeaderSize, METHODS } from 'node:http';
import { describe, it } from 'node:test';
import { buildInspectorUrl, type ResponseConfig } from '@webhook-inspector/shared';
import { DEFAULT_ANSWER_KEYS } from '../../testing/default-answer.ts';
import { composeRawResponse } from './raw-response.ts';
import {
  composeWebhookResponse,
  DEFAULT_REPLY_MESSAGE,
  http2AnswerHeaders,
  NOTHING_CARRIED,
  webhookResponseBody,
  type CarriedRequest,
  type RequestFacts,
} from './response.ts';

const SESSION = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';
const REQUEST = '3f8a1b20-0000-4000-8000-000000000000';
const ORIGIN = 'https://qa-tools.ru';

function facts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return {
    requestId: REQUEST,
    inspectorUrl: buildInspectorUrl(ORIGIN, SESSION, REQUEST),
    receivedAt: '2026-10-10T12:34:56.789Z',
    method: 'POST',
    path: `/s/${SESSION}/stripe/events`,
    bodySize: 1284,
    sourceIp: '203.0.113.7',
    ...overrides,
  };
}

/** The default answer's text for `given`, which a default session always has. */
function defaultBody(given: RequestFacts): string {
  const body = webhookResponseBody(null, given, NOTHING_CARRIED);

  assert.ok(body !== null);

  return body;
}

/**
 * Characters a request target may hold that JSON has to escape, or that a
 * reader of the answer could take for something else. Node's parser refuses
 * control characters, spaces and any byte over 0x7E in a request target (400),
 * so a path is printable ASCII, and of that only `"` and `\` grow in JSON.
 */
const HOSTILE_FRAGMENTS = [
  '"',
  '\\',
  '\\"',
  '","ok":false,"requestId":"x',
  '"}{"ok":false}',
  '</script><script>alert(1)</script>',
  '%zz',
  '%00',
  '%E9',
  '#fragment',
  '{}[]|^`<>',
  '/../..//',
  '\\u0000',
];

describe('the default answer (D223)', () => {
  it('is compact JSON of nine keys in their order, ok first and requestId second', () => {
    assert.equal(
      defaultBody(facts()),
      `{"ok":true,"requestId":"${REQUEST}","message":"Captured by QA Tools",` +
        `"inspectorUrl":"https://qa-tools.ru/v/${SESSION}#${REQUEST}",` +
        `"receivedAt":"2026-10-10T12:34:56.789Z","method":"POST",` +
        `"path":"/s/${SESSION}/stripe/events","bodySize":1284,"sourceIp":"203.0.113.7"}`,
    );
    assert.deepEqual(Object.keys(JSON.parse(defaultBody(facts()))), [...DEFAULT_ANSWER_KEYS]);
    assert.equal(DEFAULT_REPLY_MESSAGE, 'Captured by QA Tools');
  });

  it('says only the nine, whatever else a facts object is given', () => {
    // A later fact - #135's templates may add some - reaches no sender unasked.
    const widened = {
      ...facts(),
      body: 'SECRET-BODY',
      headers: [['authorization', 'SECRET-HEADER']],
      queryString: 'token=SECRET-QUERY',
    } as RequestFacts;
    const body = defaultBody(widened);

    assert.deepEqual(Object.keys(JSON.parse(body)), [...DEFAULT_ANSWER_KEYS]);
    assert.equal(body.includes('SECRET'), false);
  });

  it('keeps an unknown address null, an empty body 0 and the method as given', () => {
    for (const method of [...METHODS.filter((name) => name !== 'CONNECT'), 'UNKNOWN']) {
      const answer = JSON.parse(defaultBody(facts({ method, bodySize: 0, sourceIp: null })));

      assert.equal(answer.method, method);
      assert.equal(answer.bodySize, 0);
      assert.equal(answer.sourceIp, null);
    }

    assert.equal(
      JSON.parse(defaultBody(facts({ sourceIp: '2001:db8::7' }))).sourceIp,
      '2001:db8::7',
    );
  });

  it('writes made-up paths that would break it as JSON that reads back as the same path, at growing sizes up to 16 KiB', () => {
    const prefix = `/s/${SESSION}/`;

    for (const fragment of HOSTILE_FRAGMENTS) {
      for (const size of [1, 16, 256, 4_096, maxHeaderSize]) {
        const fill = fragment.repeat(Math.ceil(size / fragment.length));
        const path = `${prefix}${fill}`.slice(0, Math.max(size, prefix.length + 1));
        const body = defaultBody(facts({ path }));
        const answer = JSON.parse(body) as Record<string, unknown>;

        assert.deepEqual(Object.keys(answer), [...DEFAULT_ANSWER_KEYS], `${fragment} × ${size}`);
        assert.equal(answer.ok, true, `${fragment} × ${size}`);
        assert.equal(answer.requestId, REQUEST, `${fragment} × ${size}`);
        assert.equal(answer.path, path, `${fragment} × ${size}`);
        // JSON at most doubles a printable ASCII path: `"` and `\` alone grow.
        assert.ok(
          Buffer.byteLength(body) <=
            Buffer.byteLength(defaultBody(facts({ path: '' }))) + 2 * path.length,
          `${fragment} × ${size}: ${Buffer.byteLength(body)} bytes`,
        );
      }
    }
  });

  it('announces its own size, and a HEAD announces it and sends none of it', () => {
    for (const path of [`/s/${SESSION}`, `/s/${SESSION}/${'"'.repeat(8_000)}`]) {
      const get = composeWebhookResponse(
        null,
        facts({ method: 'GET', path, bodySize: 0 }),
        NOTHING_CARRIED,
      );
      const head = composeWebhookResponse(
        null,
        facts({ method: 'HEAD', path, bodySize: 0 }),
        NOTHING_CARRIED,
      );
      const text = defaultBody(facts({ method: 'HEAD', path, bodySize: 0 }));
      const length = String(Buffer.byteLength(text));

      assert.equal(head.status, 200);
      assert.deepEqual(head.headers.at(-1), ['content-length', length]);
      assert.equal(head.body?.toString('utf8'), text);
      assert.equal(head.bodySuppressed, true);
      assert.ok(head.raw.toString('latin1').endsWith(`content-length: ${length}\r\n\r\n`));
      assert.equal(get.bodySuppressed, false);
      assert.ok(get.raw.toString('utf8').endsWith(`\r\n\r\n${get.body?.toString('utf8')}`));
      assert.deepEqual(
        get.headers.map(([name]) => name),
        [
          'x-webhook-inspector-request-id',
          'x-qa-tools-request-id',
          'x-content-type-options',
          'content-security-policy',
          'content-type',
          'content-length',
        ],
      );
      assert.deepEqual(get.headers[0], ['x-webhook-inspector-request-id', REQUEST]);
      assert.deepEqual(get.headers[1], ['x-qa-tools-request-id', REQUEST]);
    }
  });
});

describe('a custom response or a queue step (D101, D205, D223)', () => {
  /**
   * What each answered before 0.55.0, byte for byte, for request `REQUEST`,
   * with the request-id header under its new name before the old since
   * 1.19.0 (D279).
   */
  const BEFORE: [string, ResponseConfig, string | null, string][] = [
    [
      'a JSON body and a header',
      {
        status: 201,
        headers: [['x-trace-id', 'abc']],
        body: '{"received":true}',
        delayMs: 0,
        template: false,
      },
      '{"received":true}',
      'HTTP/1.1 201 Created\r\nx-trace-id: abc\r\n' +
        `x-webhook-inspector-request-id: ${REQUEST}\r\n` +
        `x-qa-tools-request-id: ${REQUEST}\r\nx-content-type-options: nosniff\r\n` +
        "content-security-policy: sandbox; default-src 'none'\r\n" +
        'content-type: application/json; charset=utf-8\r\ncontent-length: 17\r\n\r\n' +
        '{"received":true}',
    ],
    [
      'a 200 that looks like the old default',
      { status: 200, headers: [], body: '{"ok":true}', delayMs: 250, template: false },
      '{"ok":true}',
      'HTTP/1.1 200 OK\r\n' +
        `x-webhook-inspector-request-id: ${REQUEST}\r\n` +
        `x-qa-tools-request-id: ${REQUEST}\r\nx-content-type-options: nosniff\r\n` +
        "content-security-policy: sandbox; default-src 'none'\r\n" +
        'content-type: application/json; charset=utf-8\r\ncontent-length: 11\r\n\r\n' +
        '{"ok":true}',
    ],
    [
      'no body',
      { status: 503, headers: [['Retry-After', '2']], body: null, delayMs: 0, template: false },
      null,
      'HTTP/1.1 503 Service Unavailable\r\nretry-after: 2\r\n' +
        `x-webhook-inspector-request-id: ${REQUEST}\r\n` +
        `x-qa-tools-request-id: ${REQUEST}\r\nx-content-type-options: nosniff\r\n` +
        "content-security-policy: sandbox; default-src 'none'\r\n\r\n",
    ],
    [
      '204 with a configured Content-Type',
      {
        status: 204,
        headers: [['Content-Type', 'text/plain']],
        body: null,
        delayMs: 0,
        template: false,
      },
      null,
      'HTTP/1.1 204 No Content\r\ncontent-type: text/plain\r\n' +
        `x-webhook-inspector-request-id: ${REQUEST}\r\n` +
        `x-qa-tools-request-id: ${REQUEST}\r\nx-content-type-options: nosniff\r\n` +
        "content-security-policy: sandbox; default-src 'none'\r\n\r\n",
    ],
  ];

  for (const [description, response, body, raw] of BEFORE) {
    it(`answers ${description} byte for byte as before, whatever the request`, () => {
      for (const given of [
        facts(),
        facts({ method: 'PUT', path: `/s/${SESSION}/${'"'.repeat(4_096)}`, bodySize: 0 }),
        facts({ sourceIp: null, receivedAt: '2030-01-01T00:00:00.000Z' }),
      ]) {
        const composed = composeWebhookResponse(response, given, NOTHING_CARRIED);

        assert.equal(webhookResponseBody(response, given, NOTHING_CARRIED), body);
        assert.equal(composed.raw.toString('latin1'), raw);
        assert.equal(composed.status, response.status);
      }
    });
  }
});

describe('a template (D251)', () => {
  const CARRIED: CarriedRequest = {
    queryString: 'q=from+query',
    headers: [['X-Trace', 'abc']],
    body: Buffer.from('{"order":{"id":"ord_1"}}'),
  };
  const BODY =
    '{"id":"{{request.id}}","q":"{{request.query.q}}","t":"{{request.header.x-trace}}","o":"{{request.body.order.id}}","m":"{{request.method}}"}';

  function answer(template: boolean, body: string | null = BODY): ResponseConfig {
    return { status: 200, headers: [], body, delayMs: 0, template };
  }

  it('fills in the request’s values only with the opt-in, the body sent as configured without it', () => {
    assert.equal(webhookResponseBody(answer(false), facts(), CARRIED), BODY);
    assert.deepEqual(JSON.parse(webhookResponseBody(answer(true), facts(), CARRIED) ?? ''), {
      id: REQUEST,
      q: 'from query',
      t: 'abc',
      o: 'ord_1',
      m: 'POST',
    });
    // Composed without what the request carried, the values it carried are empty.
    assert.deepEqual(
      JSON.parse(webhookResponseBody(answer(true), facts(), NOTHING_CARRIED) ?? ''),
      {
        id: REQUEST,
        q: '',
        t: '',
        o: '',
        m: 'POST',
      },
    );
  });

  it('announces on a HEAD the length of its filled-in body, and sends none of it', () => {
    const head = composeWebhookResponse(answer(true), facts({ method: 'HEAD' }), CARRIED);
    const length = head.headers.find(([name]) => name === 'content-length')?.[1];

    assert.equal(JSON.parse(head.body?.toString('utf8') ?? '').m, 'HEAD');
    assert.equal(length, String(head.body?.byteLength));
    assert.notEqual(length, String(Buffer.byteLength(BODY)));
    assert.equal(head.bodySuppressed, true);
    assert.equal(head.raw.toString('latin1').endsWith('\r\n\r\n'), true);
  });

  it('sends no body on 204, 205 and 304, and none for a template without one', () => {
    for (const status of [204, 205, 304]) {
      assert.equal(webhookResponseBody({ ...answer(true, null), status }, facts(), CARRIED), null);
    }

    assert.equal(webhookResponseBody(answer(true, null), facts(), CARRIED), null);
  });

  it('sends as configured a body that does not read as a template, and one whose filling-in throws', () => {
    const broken = '{"id":"{{request.id"}';

    assert.equal(webhookResponseBody(answer(true, broken), facts(), CARRIED), broken);

    const throwing = new Proxy(answer(true), {
      get(target, key, receiver) {
        if (key === 'headers') {
          throw new Error('unreadable');
        }

        return Reflect.get(target, key, receiver) as unknown;
      },
    });

    assert.equal(webhookResponseBody(throwing, facts(), CARRIED), BODY);
  });
});

describe('an answer over HTTP/2 (D263)', () => {
  it('drops the connection-specific fields and the repeats of a field sent once, keeps the rest in order, and trims a value’s ends', () => {
    assert.deepEqual(
      http2AnswerHeaders([
        ['content-type', 'text/plain'],
        ['x-dup', '1'],
        ['123', 'digits'],
        ['proxy-connection', 'keep-alive'],
        ['x-dup', '2'],
        ['content-type', 'text/html'],
        ['http2-settings', 'AAMA'],
        ['location', '/s/a'],
        ['location', '/s/b'],
        ['x-pad', ' \t both ends \t'],
        ['x-inner', 'a  b'],
        ['x-empty', ''],
        ['x-blank', '   '],
        ['connection', 'close'],
        ['keep-alive', 'timeout=5'],
        ['transfer-encoding', 'chunked'],
        ['upgrade', 'h2c'],
        ['te', 'trailers'],
      ]),
      [
        ['content-type', 'text/plain'],
        ['x-dup', '1'],
        ['123', 'digits'],
        ['x-dup', '2'],
        ['location', '/s/a'],
        ['x-pad', 'both ends'],
        ['x-inner', 'a  b'],
        ['x-empty', ''],
        ['x-blank', ''],
      ],
    );
  });

  it('composes the answer as HTTP/2 sends it: the record holds the head sent, the raw form `:status` first', () => {
    const response: ResponseConfig = {
      status: 201,
      headers: [
        ['Content-Type', 'text/plain'],
        ['content-type', 'text/html'],
        ['Proxy-Connection', 'x'],
      ],
      body: 'made',
      delayMs: 0,
      template: false,
    };
    const http1 = composeWebhookResponse(response, facts(), NOTHING_CARRIED);
    const http2 = composeWebhookResponse(response, facts(), NOTHING_CARRIED, true);

    // HTTP/1.1 as before: every configured pair, a status line.
    assert.deepEqual(
      http1.headers.map(([name]) => name),
      [
        'content-type',
        'content-type',
        'proxy-connection',
        'x-webhook-inspector-request-id',
        'x-qa-tools-request-id',
        'x-content-type-options',
        'content-security-policy',
        'content-length',
      ],
    );
    assert.ok(http1.raw.toString('latin1').startsWith('HTTP/1.1 201 Created\r\n'));

    assert.deepEqual(
      http2.headers.map(([name]) => name),
      [
        'content-type',
        'x-webhook-inspector-request-id',
        'x-qa-tools-request-id',
        'x-content-type-options',
        'content-security-policy',
        'content-length',
      ],
    );
    assert.equal(
      http2.raw.toString('latin1'),
      [':status: 201', ...http2.headers.map(([name, value]) => `${name}: ${value}`)].join('\r\n') +
        '\r\n\r\nmade',
    );
  });

  it('writes `:status` first in the raw form of any status, and the head alone for a HEAD', () => {
    assert.equal(
      composeRawResponse(599, [['x-a', '1']], Buffer.from('b'), true).toString('latin1'),
      ':status: 599\r\nx-a: 1\r\n\r\nb',
    );
    assert.equal(
      composeRawResponse(204, [], null, true).toString('latin1'),
      ':status: 204\r\n\r\n',
    );

    const head = composeWebhookResponse(null, facts({ method: 'HEAD' }), NOTHING_CARRIED, true);

    assert.equal(head.bodySuppressed, true);
    assert.ok(
      head.raw.toString('latin1').endsWith(`content-length: ${head.body?.byteLength}\r\n\r\n`),
    );
  });
});
