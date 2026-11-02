/**
 * The response templates' grammar, check and substitution (D251, issue
 * #135), `@webhook-inspector/shared/response-template`, as pure functions: what a
 * template is, what it is refused for, which value each placeholder takes,
 * how a value is escaped, the cap on what is sent - and the made-up input
 * built to break each of them, at growing sizes, held to a time bound.
 *
 * `template.test.ts` holds the same over real sockets and the database.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_BODY_BYTES, MAX_RESPONSE_BODY_BYTES } from '@webhook-inspector/shared';
import {
  escapeTemplateValue,
  readTemplate,
  renderTemplate,
  templateEscaping,
  templateProblem,
  utf8Bytes,
  type TemplateEscaping,
  type TemplateRequest,
} from '@webhook-inspector/shared/response-template';
import { withinBound } from '../../testing/timing.ts';

/** A request with nothing in it but what `rest` gives. */
function request(rest: Partial<TemplateRequest> = {}): TemplateRequest {
  return {
    id: '0b6f2c1e-7d2a-4c8e-9a51-3f0d7c9e2b14',
    method: 'POST',
    path: '/s/abc/orders',
    queryString: '',
    headers: [],
    body: new Uint8Array(0),
    ...rest,
  };
}

/** A request whose body is `text`, as UTF-8. */
function withBody(text: string, rest: Partial<TemplateRequest> = {}): TemplateRequest {
  return request({ body: Buffer.from(text, 'utf8'), ...rest });
}

/** Renders `template` for `given`, which must read as one. */
function render(
  template: string,
  given: TemplateRequest = request(),
  escaping: TemplateEscaping = 'raw',
  maxBytes?: number,
): string {
  const text = renderTemplate(template, given, escaping, maxBytes);

  assert.notEqual(text, null, `not a template: ${template.slice(0, 80)}`);

  return text as string;
}

/** Whether `text` holds no lone surrogate: it comes back from UTF-8 as it went. */
function wellFormed(text: string): boolean {
  return Buffer.from(text, 'utf8').toString('utf8') === text;
}

/** Generous for 64 KiB of template or a 1 MiB body; quadratic time is seconds. */
const BOUND_MS = 500;

describe('the grammar (D251)', () => {
  it('reads each placeholder of the set, and the text around them as it stands', () => {
    assert.deepEqual(
      readTemplate(
        'a{{request.id}}b{{request.method}}{{request.path}}{{request.query.q}}' +
          '{{request.header.X-Trace}}{{request.body.order.items.0.sku}}c',
      ),
      {
        ok: true,
        parts: [
          'a',
          { kind: 'id' },
          'b',
          { kind: 'method' },
          { kind: 'path' },
          { kind: 'query', name: 'q' },
          { kind: 'header', name: 'x-trace' },
          { kind: 'body', path: ['order', 'items', '0', 'sku'] },
          'c',
        ],
      },
    );
    assert.deepEqual(readTemplate(''), { ok: true, parts: [] });
    assert.deepEqual(readTemplate('plain'), { ok: true, parts: ['plain'] });
  });

  it('takes every other brace as text: }}, a lone {, ${x} and JSON objects', () => {
    for (const text of [
      '}}',
      '{"a":{"b":1}}',
      '${x}',
      '{ {request.id} }',
      '{request.id}}',
      '{{request.id}}}',
      '[{{request.id}}]',
      '{"a":{{request.body.n}}}',
    ]) {
      assert.equal(templateProblem(text), null, text);
    }
  });

  it('takes a query name, a header name and a body key with dots or any other visible character', () => {
    assert.deepEqual(readTemplate('{{request.query.user.id}}').ok, true);
    assert.deepEqual(readTemplate('{{request.query.имя}}'), {
      ok: true,
      parts: [{ kind: 'query', name: 'имя' }],
    });
    assert.deepEqual(readTemplate('{{request.header.x.y}}'), {
      ok: true,
      parts: [{ kind: 'header', name: 'x.y' }],
    });
    // Keys an object can have, which resolve only as its own properties.
    for (const key of ['__proto__', 'constructor', 'prototype', '1e20', '-1', '01', 'é']) {
      assert.deepEqual(readTemplate(`{{request.body.${key}}}`), {
        ok: true,
        parts: [{ kind: 'body', path: [key] }],
      });
    }
  });

  it('refuses what is not a placeholder of the set, naming the {{ by its place and the rule', () => {
    const cases: [string, string, number][] = [
      ['{{', 'unclosed', 1],
      ['{{request.id', 'unclosed', 1],
      ['{{request.id}} and {{request.method', 'unclosed', 2],
      ['{{}}', 'unknown', 1],
      ['{{ request.id }}', 'unknown', 1],
      ['{{request.id }}', 'unknown', 1],
      ['{{request.id\t}}', 'unknown', 1],
      ['{{request.\u00a0id}}', 'unknown', 1],
      ['{{request.query.a\u0085}}', 'unknown', 1],
      ['{{request.query.a\u0000}}', 'unknown', 1],
      ['{{request.query.a\u007f}}', 'unknown', 1],
      ['{{request.ID}}', 'unknown', 1],
      ['{{Request.id}}', 'unknown', 1],
      ['{{request}}', 'unknown', 1],
      ['{{request.ip}}', 'unknown', 1],
      ['{{1+1}}', 'unknown', 1],
      ['{{request.id|upper}}', 'unknown', 1],
      ['{{{request.id}}', 'unknown', 1],
      ['{{request.query.a}b}}', 'unknown', 1],
      ['{{request.query}}', 'unknown', 1],
      ['{{request.header}}', 'unknown', 1],
      ['{{request.body}}', 'unknown', 1],
      ['{{request.query.}}', 'query', 1],
      ['{{request.header.}}', 'header', 1],
      ['{{request.header.a:b}}', 'header', 1],
      ['{{request.header.é}}', 'header', 1],
      ['{{request.body.}}', 'body', 1],
      ['{{request.body..a}}', 'body', 1],
      ['{{request.body.a.}}', 'body', 1],
      ['{{request.body.a..b}}', 'body', 1],
      ['{{request.id}}{{request.path}}{{request.nope}}', 'unknown', 3],
    ];

    for (const [template, kind, index] of cases) {
      assert.deepEqual(templateProblem(template), { kind, index }, JSON.stringify(template));
      assert.equal(renderTemplate(template, request(), 'raw'), null);
    }
  });

  it('reads made-up templates at growing sizes in one pass: braces, unclosed {{, placeholders', () => {
    const sizes = [1024, 16 * 1024, MAX_RESPONSE_BODY_BYTES];
    const shapes: [string, (bytes: number) => string, string | null][] = [
      ['{ alone', (bytes) => '{'.repeat(bytes), 'unclosed'],
      ['{{ unclosed', (bytes) => '{{'.repeat(bytes / 2), 'unclosed'],
      ['} alone', (bytes) => '}'.repeat(bytes), null],
      ['a placeholder repeated', (bytes) => '{{request.id}}'.repeat(bytes / 14), null],
      [
        'placeholders, then an unclosed one',
        (bytes) => `${'{{request.id}}'.repeat(bytes / 14 - 1)}{{request.i`,
        'unclosed',
      ],
      [
        'a body path of one-letter keys',
        (bytes) => `{{request.body.${'a.'.repeat(bytes / 2 - 12)}a}}`,
        null,
      ],
      ['{{ then spaces', (bytes) => `{{${' '.repeat(bytes - 4)}}}`, 'unknown'],
      ['{{{ repeated with closes', (bytes) => '{{{}}'.repeat(bytes / 5), 'unknown'],
    ];

    for (const bytes of sizes) {
      for (const [name, make, kind] of shapes) {
        const template = make(bytes);

        assert.ok(template.length <= MAX_RESPONSE_BODY_BYTES, name);

        const problem = withinBound(BOUND_MS, () => templateProblem(template));

        assert.equal(problem?.kind ?? null, kind, `${name} at ${bytes}`);
      }
    }
  });
});

describe('the escaping by the answer’s effective Content-Type (D251)', () => {
  it('reads the media type of the first Content-Type pair, application/json without one', () => {
    const cases: [[string, string][], TemplateEscaping][] = [
      [[], 'json'],
      [[['X-Other', 'text/html']], 'json'],
      [[['Content-Type', 'application/json']], 'json'],
      [[['content-type', 'Application/JSON; charset=utf-8']], 'json'],
      [[['CONTENT-TYPE', '  application/problem+json ;x=1']], 'json'],
      [[['Content-Type', 'application/vnd.api+json']], 'json'],
      [[['Content-Type', 'text/html']], 'markup'],
      [[['Content-Type', 'text/html; charset=utf-8']], 'markup'],
      [[['Content-Type', 'application/xhtml+xml']], 'markup'],
      [[['Content-Type', 'text/xml']], 'markup'],
      [[['Content-Type', 'application/xml']], 'markup'],
      [[['Content-Type', 'image/svg+xml']], 'markup'],
      [[['Content-Type', 'application/atom+xml']], 'markup'],
      [[['Content-Type', 'text/plain']], 'raw'],
      [[['Content-Type', 'text/json']], 'raw'],
      [[['Content-Type', 'application/x-www-form-urlencoded']], 'raw'],
      [[['Content-Type', 'text/csv']], 'raw'],
      [[['Content-Type', '']], 'raw'],
      [[['Content-Type', 'json']], 'raw'],
      [[['Content-Type', '/json']], 'raw'],
      [
        [
          ['Content-Type', 'text/plain'],
          ['Content-Type', 'application/json'],
        ],
        'raw',
      ],
      [
        [
          ['X-A', '1'],
          ['Content-Type', 'text/html'],
          ['Content-Type', 'application/json'],
        ],
        'markup',
      ],
    ];

    for (const [headers, escaping] of cases) {
      assert.equal(templateEscaping(headers), escaping, JSON.stringify(headers));
    }
  });

  it('keeps a JSON string valid whatever the value holds: quotes, backslashes, controls, U+2028, lone surrogates', () => {
    const hostile = 'a"b\\c\nd\re\tf\u0000g\u001fh\u007fi\u2028j\u2029k\ud800l\udc00m😀n</script>';
    const escaped = escapeTemplateValue(hostile, 'json');

    assert.equal(JSON.parse(`"${escaped}"`), hostile);
    assert.ok(wellFormed(escaped), 'a lone surrogate is escaped, not written');
    assert.ok(
      [...escaped].every((character) => {
        const code = character.charCodeAt(0);

        return code >= 0x20 && code !== 0x2028 && code !== 0x2029;
      }),
    );
    assert.ok(escaped.includes('\\u2028') && escaped.includes('\\u2029'));
    assert.ok(escaped.includes('\\ud800') && escaped.includes('\\udc00'));
    assert.ok(escaped.includes('😀'), 'a pair stays itself');
  });

  it('keeps every code unit valid inside a JSON string, made-up strings of all of them', () => {
    let all = '';

    for (let code = 0; code <= 0xffff; code += 1) {
      all += String.fromCharCode(code);
    }

    const escaped = withinBound(BOUND_MS, () => escapeTemplateValue(all, 'json'));
    const parsed = JSON.parse(`{"v":"${escaped}"}`) as { v: string };

    assert.equal(parsed.v, all);
    assert.ok(wellFormed(escaped));
  });

  it('writes & < > " and \' as entities in markup, and nothing else differently', () => {
    assert.equal(
      escapeTemplateValue(`<a href="x" title='y'>&amp; é</a>`, 'markup'),
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp; é&lt;/a&gt;',
    );
  });

  it('writes a value raw for any other type', () => {
    const value = '<"\\\u0000\u2028>';

    assert.equal(escapeTemplateValue(value, 'raw'), value);
  });

  it('escapes the path as any value: " \\ < > & and \' under json, markup and raw', () => {
    // The sender's path, stored as received (D173): Node's parser takes each
    // of these characters in a request target.
    const path = `/s/abc/a"b\\<c>&'d`;
    const given = request({ path });
    const json = render('{"path":"{{request.path}}"}', given, 'json');

    assert.equal(json, `{"path":"/s/abc/a\\"b\\\\<c>&'d"}`);
    assert.deepEqual(JSON.parse(json), { path });
    assert.equal(
      render('<p>{{request.path}}</p>', given, 'markup'),
      '<p>/s/abc/a&quot;b\\&lt;c&gt;&amp;&#39;d</p>',
    );
    assert.equal(render('{{request.path}}', given, 'raw'), path);
  });

  it('counts bytes as UTF-8 sends them, a lone surrogate as U+FFFD', () => {
    for (const text of ['', 'a', 'é', '€', '😀', '\ud800', '\udc00', 'a\ud800b', '😀\ud83d']) {
      assert.equal(utf8Bytes(text), Buffer.byteLength(text, 'utf8'), JSON.stringify(text));
    }

    let random = '';

    for (let index = 0; index < 50_000; index += 1) {
      random += String.fromCharCode((index * 7919) % 0x10000);
    }

    assert.equal(utf8Bytes(random), Buffer.byteLength(random, 'utf8'));
  });
});

describe('the values (D251)', () => {
  it('fills in the id, the method and the path as stored', () => {
    assert.equal(
      render('{{request.id}} {{request.method}} {{request.path}}', request()),
      '0b6f2c1e-7d2a-4c8e-9a51-3f0d7c9e2b14 POST /s/abc/orders',
    );
  });

  it('writes a value as it is, never read again for placeholders: one pass, whatever the sender wrote', () => {
    // Each value the sender writes names the id, itself and the other three,
    // so a renderer that substituted again, in whatever order, would expand
    // one of them; braces pass every escaping as they are.
    const injected =
      '{{request.id}}{{request.path}}{{request.query.q}}{{request.header.x-t}}{{request.body.s}}';
    const given = withBody(JSON.stringify({ s: injected }), {
      path: `/s/abc/${injected}`,
      queryString: `q=${encodeURIComponent(injected)}`,
      headers: [['X-T', injected]],
    });
    const { id } = given;
    const template =
      '{{request.id}}|{{request.path}}|{{request.query.q}}|{{request.header.x-t}}|{{request.body.s}}';

    for (const escaping of ['json', 'markup', 'raw'] as const) {
      const text = render(template, given, escaping);

      assert.equal(text, `${id}|/s/abc/${injected}|${injected}|${injected}|${injected}`, escaping);
      // The id only where the template names it, never where a value does.
      assert.equal(text.split(id).length, 2, escaping);
    }
  });

  it('takes a query parameter’s first value, decoded as URLSearchParams decodes it', () => {
    const given = request({
      queryString: 'a=1&a=2&b=x+y&c=%zz&d=%E9&e=%C3%A9&f&g=&user.id=7&q%20r=s',
    });

    assert.equal(render('{{request.query.a}}', given), '1');
    assert.equal(render('{{request.query.b}}', given), 'x y');
    assert.equal(render('{{request.query.c}}', given), '%zz');
    assert.equal(render('{{request.query.d}}', given), '\ufffd');
    assert.equal(render('{{request.query.e}}', given), 'é');
    assert.equal(render('[{{request.query.f}}][{{request.query.g}}]', given), '[][]');
    assert.equal(render('{{request.query.user.id}}', given), '7');
    assert.equal(render('[{{request.query.missing}}]', given), '[]');
    // A name is compared after decoding; one holding a space cannot be written.
    assert.equal(render('[{{request.query.q%20r}}]', given), '[]');
  });

  it('takes a header’s first value, its name in any case, its bytes read as UTF-8', () => {
    const given = request({
      headers: [
        ['X-Trace', 'first'],
        ['x-trace', 'second'],
        // `é` as UTF-8, one character a byte, as Node reads a header.
        ['X-Name', 'Ã©'],
        ['X-Bad', 'é'],
        ['X-Empty', ''],
      ],
    });

    assert.equal(render('{{request.header.x-trace}}', given), 'first');
    assert.equal(render('{{request.header.X-TRACE}}', given), 'first');
    assert.equal(render('{{request.header.x-name}}', given), 'é');
    assert.equal(render('{{request.header.x-bad}}', given), '\ufffd');
    assert.equal(render('[{{request.header.x-empty}}][{{request.header.x-none}}]', given), '[][]');
  });

  it('takes a JSON body’s field by its path: keys, array indexes, strings, numbers, booleans', () => {
    const given = withBody(
      JSON.stringify({
        order: { id: 'ord_1', items: [{ sku: 'A' }, { sku: 'B' }], total: 12.5, paid: true },
        n: 1.5,
        big: 1e21,
        zero: -0,
        f: false,
        s: '',
        '0': 'zero key',
        'a.b': 'dotted',
      }),
    );

    assert.equal(render('{{request.body.order.id}}', given), 'ord_1');
    assert.equal(render('{{request.body.order.items.1.sku}}', given), 'B');
    assert.equal(render('{{request.body.order.total}}', given), '12.5');
    assert.equal(render('{{request.body.order.paid}}', given), 'true');
    assert.equal(render('{{request.body.f}}', given), 'false');
    assert.equal(render('{{request.body.big}}', given), '1e+21');
    assert.equal(render('{{request.body.zero}}', given), '0');
    assert.equal(render('{{request.body.0}}', given), 'zero key');
    assert.equal(render('[{{request.body.s}}]', given), '[]');
    // A key holding a dot cannot be named.
    assert.equal(render('[{{request.body.a.b}}]', given), '[]');
  });

  it('writes a number as JSON writes what it parses to', () => {
    const given = withBody('{"a":1.50,"b":1e2,"c":12345678901234567890,"d":1e400,"e":-1e-7}');

    assert.equal(render('{{request.body.a}}', given), '1.5');
    assert.equal(render('{{request.body.b}}', given), '100');
    assert.equal(render('{{request.body.c}}', given), '12345678901234567000');
    assert.equal(render('[{{request.body.d}}]', given), '[]');
    assert.equal(render('{{request.body.e}}', given), '-1e-7');
  });

  it('renders empty a null, an object, an array, a path that leads nowhere and an index outside', () => {
    const given = withBody('{"n":null,"o":{"a":1},"l":[1,2],"s":"text","items":[{"a":"x"}]}');

    for (const path of [
      'n',
      'o',
      'l',
      'missing',
      'o.missing',
      's.0',
      's.length',
      'l.length',
      'l.2',
      'l.01',
      'l.-1',
      'l.1e0',
      'l.1e20',
      'l.99999999999999999999',
      'items.0.a.b',
      'n.a',
    ]) {
      assert.equal(render(`[{{request.body.${path}}}]`, given), '[]', path);
    }
  });

  it('reads own properties only: __proto__ when the body has it, never what objects inherit', () => {
    const own = withBody(
      '{"__proto__":"own proto","constructor":"own ctor","prototype":{"x":"p"}}',
    );

    assert.equal(render('{{request.body.__proto__}}', own), 'own proto');
    assert.equal(render('{{request.body.constructor}}', own), 'own ctor');
    assert.equal(render('{{request.body.prototype.x}}', own), 'p');

    const plain = withBody('{"a":{}, "l":[]}');

    for (const path of [
      '__proto__',
      'constructor',
      'constructor.name',
      'prototype',
      'toString',
      'hasOwnProperty',
      'a.__proto__',
      'a.constructor',
      'a.valueOf',
      'l.length',
      'l.constructor',
      'l.map',
    ]) {
      assert.equal(render(`[{{request.body.${path}}}]`, plain), '[]', path);
    }
  });

  it('takes the last of duplicate keys, as JSON.parse does', () => {
    assert.equal(render('{{request.body.a}}', withBody('{"a":"first","a":"last"}')), 'last');
  });

  it('reads a body with a byte order mark, and none that is not UTF-8 or not JSON', () => {
    assert.equal(
      render('{{request.body.a}}', request({ body: Buffer.from('\ufeff{"a":"bom"}', 'utf8') })),
      'bom',
    );

    for (const body of [
      Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe9, 0x22, 0x7d]),
      Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]),
      Buffer.from('{"a":"x"', 'utf8'),
      Buffer.from('a=x&b=y', 'utf8'),
      Buffer.from('', 'utf8'),
      Buffer.from('"just a string"', 'utf8'),
      Buffer.from('[1,2,3]', 'utf8'),
    ]) {
      assert.equal(render('[{{request.body.a}}]', request({ body })), '[]', body.toString('hex'));
    }

    assert.equal(render('{{request.body.0}}', withBody('[7]')), '7');
  });

  it('writes U+0000 and every other character of a decoded value as the escaping says', () => {
    const given = withBody('{"a":"x\\u0000y"}');

    assert.equal(render('{{request.body.a}}', given, 'raw'), 'x\u0000y');
    assert.equal(render('{{request.body.a}}', given, 'json'), 'x\\u0000y');
  });

  it('reads nothing at all of a body no placeholder names', () => {
    let reads = 0;
    const body = new Proxy(Buffer.from('{"a":1}'), {
      get(target, key, receiver) {
        reads += 1;

        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const given = request({ body, queryString: 'a=1', headers: [['x-a', '1']] });

    assert.equal(
      render('{{request.id}}{{request.query.a}}{{request.header.x-a}}', given),
      `${given.id}11`,
    );
    assert.equal(reads, 0);
  });

  it('never throws for a request: a value that cannot be read renders empty', () => {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error('unreadable');
        },
      },
    ) as never;

    assert.equal(
      render(
        '[{{request.query.a}}][{{request.header.a}}][{{request.body.a}}]',
        request({ queryString: throwing, headers: throwing, body: throwing }),
      ),
      '[][][]',
    );
    assert.equal(
      render('{{request.header.a}}', request({ headers: [['a', 'wide \u0100 character']] })),
      'wide \u0100 character',
    );
  });

  it('survives a body nested 100,000 levels deep and a path of 30,000 keys', () => {
    const depth = 100_000;
    const arrays = withBody(`${'['.repeat(depth)}"deep"${']'.repeat(depth)}`);
    const objects = withBody(`${'{"a":'.repeat(depth)}"deep"${'}'.repeat(depth)}`);

    assert.equal(render(`[{{request.body.${'0.'.repeat(5)}0}}]`, arrays), '[]');
    assert.equal(render(`[{{request.body.a.a}}]`, objects), '[]');

    const keys = 30_000;
    const path = Array.from({ length: keys }, () => 'a').join('.');
    const nested = withBody(`${'{"a":'.repeat(keys)}"found"${'}'.repeat(keys)}`);
    const template = `{{request.body.${path}}}`;

    assert.ok(template.length <= MAX_RESPONSE_BODY_BYTES);
    assert.equal(
      withinBound(BOUND_MS, () => render(template, nested)),
      'found',
    );
    assert.equal(render(`[{{request.body.${'0.'.repeat(depth / 10 - 1)}0}}]`, arrays), '[]');
  });

  it('shares nothing between two requests rendered at once', async () => {
    const template = '{"id":"{{request.id}}","q":"{{request.query.n}}","b":"{{request.body.n}}"}';
    const renders = await Promise.all(
      Array.from({ length: 50 }, async (_unused, index) => {
        await Promise.resolve();

        return render(
          template,
          withBody(`{"n":"body ${index}"}`, { id: `id-${index}`, queryString: `n=q${index}` }),
          'json',
        );
      }),
    );

    renders.forEach((text, index) => {
      assert.deepEqual(JSON.parse(text), { id: `id-${index}`, q: `q${index}`, b: `body ${index}` });
    });
  });
});

describe('the cap on what is sent (D251)', () => {
  it('writes a value only if it fits in what is left, and the values after it still if they fit', () => {
    const given = request({
      queryString: `big=${'b'.repeat(100)}&small=s`,
    });

    assert.equal(
      render('<{{request.query.big}}|{{request.query.small}}>', given, 'raw', 10),
      '<|s>',
    );
    assert.equal(
      render('<{{request.query.small}}{{request.query.small}}>', given, 'raw', 4),
      '<ss>',
    );
    assert.equal(
      render('<{{request.query.small}}{{request.query.small}}>', given, 'raw', 3),
      '<s>',
    );
    assert.equal(render('{{request.query.small}}', given, 'raw', 1), 's');
    assert.equal(render('{{request.query.small}}', given, 'raw', 0), '');
  });

  it('counts a value after escaping, in bytes', () => {
    const given = withBody(JSON.stringify({ q: '"'.repeat(10), e: 'é'.repeat(5) }));

    // Ten quotes are twenty bytes once escaped.
    assert.equal(render('{{request.body.q}}', given, 'json', 19), '');
    assert.equal(render('{{request.body.q}}', given, 'json', 20), '\\"'.repeat(10));
    // Five `é` are ten bytes.
    assert.equal(render('{{request.body.e}}', given, 'raw', 9), '');
    assert.equal(render('{{request.body.e}}', given, 'raw', 10), 'é'.repeat(5));
  });

  it('keeps the literal text whatever is left, and writes it whole', () => {
    assert.equal(render('literal {{request.id}}', request(), 'raw', 3), 'literal ');
  });

  it(`never sends more than ${MAX_RESPONSE_BODY_BYTES} bytes: as many placeholders of a 1 MiB value as 64 KiB holds, in bounded time`, () => {
    const value = 'v'.repeat(MAX_BODY_BYTES - 16);
    const given = withBody(JSON.stringify({ a: value }), {
      headers: [['x-big', 'h'.repeat(16 * 1024)]],
      queryString: `q=${'q'.repeat(16 * 1024)}`,
    });
    const shapes = [
      '{{request.body.a}}'.repeat(3640),
      '{{request.header.x-big}}'.repeat(2730),
      '{{request.query.q}}'.repeat(3449),
      // Each a key of its own: 3,000 distinct paths, none of them there.
      Array.from({ length: 3000 }, (_unused, index) => `{{request.body.k${index}}}`).join(''),
      `${'{{request.id}}'.repeat(4600)}`,
    ];

    for (const template of shapes) {
      assert.ok(Buffer.byteLength(template) <= MAX_RESPONSE_BODY_BYTES);

      for (const escaping of ['json', 'markup', 'raw'] as const) {
        const text = withinBound(BOUND_MS, () => render(template, given, escaping));

        assert.ok(Buffer.byteLength(text) <= MAX_RESPONSE_BODY_BYTES, `${Buffer.byteLength(text)}`);
      }
    }

    // The 16 KiB header fits four times, and the rest is empty.
    assert.equal(
      Buffer.byteLength(render('{{request.header.x-big}}'.repeat(2730), given)),
      4 * 16 * 1024,
    );
  });

  it('bounds the escaping of a value that grows six times, repeated', () => {
    const given = withBody(JSON.stringify({ c: '\u0001'.repeat(20_000) }));
    const text = withinBound(BOUND_MS, () =>
      render('{{request.body.c}}'.repeat(3600), given, 'json'),
    );

    // 120,000 bytes escaped: it never fits, and is never escaped twice.
    assert.equal(text, '');
  });

  it('renders the same template the same way for a request at every size', () => {
    const template = '{"id":"{{request.id}}","echo":"{{request.body.echo}}"}';

    for (const bytes of [1024, 64 * 1024, 256 * 1024, MAX_BODY_BYTES - 64]) {
      const given = withBody(JSON.stringify({ items: 'x'.repeat(bytes - 40), echo: 'yes' }));
      const text = withinBound(BOUND_MS, () => render(template, given, 'json'));

      assert.deepEqual(JSON.parse(text), { id: given.id, echo: 'yes' });
    }
  });

  it('parses a 1 MiB body of tiny objects once, in bounded time', () => {
    const parts: string[] = [];
    let bytes = 2;

    for (let index = 0; bytes < MAX_BODY_BYTES - 32; index += 1) {
      const part = `{"a":${index}}`;

      parts.push(part);
      bytes += part.length + 1;
    }

    const given = withBody(`[${parts.join(',')}]`);
    const template = Array.from(
      { length: 1000 },
      (_unused, index) => `{{request.body.${index}.a}}`,
    ).join(',');

    const text = withinBound(BOUND_MS, () => render(template, given, 'json'));

    assert.equal(text, Array.from({ length: 1000 }, (_unused, index) => index).join(','));
  });
});
