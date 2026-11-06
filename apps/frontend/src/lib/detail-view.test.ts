/**
 * What each block shows, and what copying it yields (D114, D122).
 *
 * The property worth the file is that copying yields the **whole** content of a
 * block rather than the fragment on screen. Layout is invisible to a test, so a
 * later refactor toward "copy what is visible" would pass every other
 * assertion in the suite; this is the one that would not.
 *
 * Wrapping is here for the same reason: `content.wrap` is what the block says
 * about itself, so "every block wraps, and re-indented JSON with a hanging
 * indent" (D134, D149) is asserted rather than read off a class in a
 * component - and so is the caption that says a line was folded.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { RequestDetails, ResponseRecord } from '@webhook-inspector/shared';
import {
  type BlockModel,
  blockCopyText,
  type BodyPart,
  HANGING_INDENT_COLUMNS,
  hangingIndentStyle,
  type HangingRun,
  hangingRuns,
  isCopyable,
  KEPT_KEY_COLUMNS,
  MIN_CONTINUATION_COLUMNS,
  partCopyText,
  requestBodyBlock,
  requestHeadersBlock,
  requestQueryBlock,
  requestRawBlock,
  responseBodyBlock,
  responseHeadersBlock,
  responseRawBlock,
  textOnScreen,
  type TextWrap,
} from './detail-view.ts';
import { formatJsonForDisplay, JSON_FORMAT_MAX_BYTES, JSON_MAX_DEPTH } from './json-format.ts';
import { XML_MAX_DEPTH } from './xml-format.ts';

/** Said wherever a line actually wraps (D134, D149). */
const WRAPPED = 'Long lines wrap; the breaks on screen are not in the content.';

/** The request `Headers` caption since v0.14.0 (D144, D149). */
const REQUEST_HEADERS = 'Headers as received by the server.';

/** Why a text body is shown as stored, by what it looks like (D112, D163). */
const OVER_CEILING = 'Formatting unavailable above 256 KiB. Original content remains accessible.';
const NOT_JSON = 'Formatting unavailable: this body is not valid JSON.';
/** Written out, not built from `JSON_MAX_DEPTH`, so the settled wording is pinned (#59, D169). */
const JSON_TOO_DEEP =
  'Formatting unavailable: JSON nested more than 100 levels deep is shown as stored.';
const NOT_XML = 'Formatting unavailable: this body is not well-formed XML.';
const XML_WITH_DOCTYPE = 'Formatting unavailable: XML with a DOCTYPE is shown as stored.';
const XML_TOO_DEEP = `Formatting unavailable: XML nested more than ${XML_MAX_DEPTH} levels deep is shown as stored.`;
/** Written out rather than built from the cap, so the settled wording is pinned (#64). */
const JSON_TOO_LONG =
  'Formatting unavailable: JSON that formats to more than 2,000,000 characters is shown as stored.';
const XML_TOO_LONG =
  'Formatting unavailable: XML that formats to more than 2,000,000 characters is shown as stored.';
const NOT_RECOGNISED = 'Shown as stored: no JSON or XML structure was recognised.';

const RAW_REQUEST = [
  'POST /s/session?source=demo HTTP/1.1',
  'Host: qa-tools.ru',
  'Content-Type: application/json',
  '',
  '{"runId":9007199254740993}',
].join('\n');

function details(overrides: Partial<RequestDetails> = {}): RequestDetails {
  return {
    id: '2b906b89-6a58-4b3e-a9ec-7860faf986f3',
    method: 'POST',
    receivedAt: '2026-09-17T14:32:06.000Z',
    bodySize: 26,
    sourceIp: '145.40.74.12',
    response: null,
    queryString: 'source=demo&runId=1842',
    headers: [
      ['Host', 'qa-tools.ru'],
      ['Content-Type', 'application/json'],
    ],
    body: '{"runId":9007199254740993}',
    bodyBase64: null,
    isBinary: false,
    raw: RAW_REQUEST,
    rawBase64: null,
    isRawBinary: false,
    path: '/s/session',
    httpVersion: '1.1',
    ...overrides,
  };
}

/**
 * The head the receiver records for a custom response with its own
 * `Content-Type`: the configured pair first, then the receiver's own headers,
 * and no `application/json` (D179).
 */
function configuredHead(contentType: string, body: string): [string, string][] {
  return [
    ['content-type', contentType],
    ['x-qa-tools-request-id', '2b906b89-6a58-4b3e-a9ec-7860faf986f3'],
    ['x-content-type-options', 'nosniff'],
    ['content-security-policy', "sandbox; default-src 'none'"],
    ['content-length', String(new TextEncoder().encode(body).length)],
  ];
}

function record(overrides: Partial<ResponseRecord> = {}): ResponseRecord {
  return {
    state: 'sent',
    status: 200,
    queueStep: null,
    rule: null,
    headers: [['Content-Type', 'application/json; charset=utf-8']],
    body: '{"ok":true,"requestId":"2b906b89"}',
    bodyBase64: null,
    isBinary: false,
    bodySize: 34,
    bodySuppressed: false,
    raw: 'HTTP/1.1 200 OK\nContent-Type: application/json; charset=utf-8\n\n{"ok":true}',
    rawBase64: null,
    isRawBinary: false,
    delayMs: 0,
    startedAt: '2026-09-17T14:32:06.000Z',
    completedAt: '2026-09-17T14:32:06.000Z',
    durationMs: 1,
    ...overrides,
  };
}

describe('the request Body block', () => {
  /**
   * The acceptance criterion in one assertion: the digits of an integer beyond
   * `Number.MAX_SAFE_INTEGER` are unchanged, and there is no toggle that could
   * have been in the wrong position (D112).
   */
  it('re-indents valid JSON and leaves a large integer character for character', () => {
    const block = requestBodyBlock(details());

    assert.deepEqual(block.content, {
      kind: 'text',
      text: '{\n  "runId": 9007199254740993\n}',
      wrap: 'hanging',
    });
    assert.equal(block.caption, null);
    assert.ok(blockCopyText(block.content).includes('9007199254740993'));
  });

  it('shows invalid JSON as stored and says why it is not formatted', () => {
    const block = requestBodyBlock(details({ body: '{"event":"test.completed",}' }));

    assert.deepEqual(block.content, {
      kind: 'text',
      text: '{"event":"test.completed",}',
      wrap: 'flush',
    });
    assert.equal(block.caption, 'Formatting unavailable: this body is not valid JSON.');
  });

  it('shows a body over the ceiling as stored and says why', () => {
    const body = `{"a":"${'x'.repeat(JSON_FORMAT_MAX_BYTES)}"}`;
    const block = requestBodyBlock(details({ body }));

    assert.deepEqual(block.content, { kind: 'text', text: body, wrap: 'flush' });
    assert.equal(
      block.caption,
      'Formatting unavailable above 256 KiB. Original content remains accessible.' +
        ' Long lines wrap; the breaks on screen are not in the content.',
    );
  });

  /**
   * Issue #59: 20 000 nested arrays, a 40 KB body, took the page down. The
   * body is shown as stored under its own line, and copying yields it whole.
   */
  it('shows JSON nested past the limit as stored, and says that is why', () => {
    for (const depth of [JSON_MAX_DEPTH + 1, 20_000]) {
      const body = `${'['.repeat(depth)}${']'.repeat(depth)}`;
      const block = requestBodyBlock(details({ body }));

      assert.deepEqual(block.content, { kind: 'text', text: body, wrap: 'flush' });
      assert.equal(block.caption, `${JSON_TOO_DEEP} ${WRAPPED}`);
      assert.equal(blockCopyText(block.content), body);
    }
  });

  it(`still re-indents JSON nested exactly ${JSON_MAX_DEPTH} levels deep`, () => {
    const body = `${'{"a":'.repeat(JSON_MAX_DEPTH - 1)}{}${'}'.repeat(JSON_MAX_DEPTH - 1)}`;
    const block = requestBodyBlock(details({ body }));
    const reindented = formatJsonForDisplay(body);

    assert.equal(reindented.status, 'formatted');
    assert.equal(wrapOf(block), 'hanging');
    assert.equal(
      blockCopyText(block.content),
      reindented.status === 'formatted' ? reindented.text : '',
    );
    // Its deepest rows are wider than the box, and nothing else is said.
    assert.equal(block.caption, WRAPPED);
  });

  it('shows a binary body as Base64 and copies that block', () => {
    const block = requestBodyBlock(details({ isBinary: true, body: null, bodyBase64: 'AAECA/8=' }));

    assert.equal(blockCopyText(block.content), 'AAECA/8=');
    assert.equal(block.caption, 'Binary body shown as Base64. JSON formatting is unavailable.');
  });

  it('says a request was captured without a body, and offers nothing to copy', () => {
    const block = requestBodyBlock(details({ body: null, bodySize: 0 }));

    assert.deepEqual(block.content, { kind: 'empty', placeholder: 'No request body' });
    assert.equal(block.caption, 'This request was captured without a body.');
    assert.equal(blockCopyText(block.content), '');
    assert.equal(isCopyable(block.content), false);
  });

  /**
   * The sideways caption is retired with the sideways scroll (D149): a long
   * value wraps, the block says so, and the value is still all there.
   */
  it('says a long value wraps rather than scrolling, and does not shorten it', () => {
    const long = 'a'.repeat(200);
    const block = requestBodyBlock(details({ body: `{"callback":"${long}"}` }));

    assert.equal(block.caption, WRAPPED);
    assert.ok(blockCopyText(block.content).includes(long));
  });
});

/**
 * Issue #28: XML is recognised from the text, never from `Content-Type`, and
 * drawn by the same block as re-indented JSON. Where a body is not indented,
 * its reason says what the text looks like (D163).
 */
describe('the Body block and XML', () => {
  const XML =
    '<?xml version="1.0" encoding="UTF-8"?>\n<order id="42"><item sku="A1">Widget</item>' +
    '<note>Leave it at the <b>door</b>.</note><pre xml:space="preserve"> kept  <x/> </pre></order>';
  const INDENTED = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<order id="42">',
    '  <item sku="A1">Widget</item>',
    '  <note>Leave it at the <b>door</b>.</note>',
    '  <pre xml:space="preserve"> kept  <x/> </pre>',
    '</order>',
  ].join('\n');
  const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

  function labelled(body: string, contentType: string): RequestDetails {
    return details({
      body,
      headers: [
        ['Host', 'qa-tools.ru'],
        ['Content-Type', contentType],
      ],
    });
  }

  it('indents XML labelled text/plain, in the same hanging block as JSON', () => {
    const block = requestBodyBlock(labelled(XML, 'text/plain'));

    assert.deepEqual(block.content, { kind: 'text', text: INDENTED, wrap: 'hanging' });
    assert.equal(block.caption, null);
  });

  it('indents it the same whatever the label says, and with no label at all', () => {
    for (const type of ['application/xml', 'application/json', 'application/octet-stream']) {
      assert.equal(displayedAndCopied(requestBodyBlock(labelled(XML, type))), INDENTED);
    }

    assert.equal(
      displayedAndCopied(requestBodyBlock(details({ body: XML, headers: [] }))),
      INDENTED,
    );
  });

  it('shows a body labelled application/xml that is not XML as stored, with the neutral reason', () => {
    const block = requestBodyBlock(labelled('hello', 'application/xml'));

    assert.deepEqual(block.content, { kind: 'text', text: 'hello', wrap: 'flush' });
    assert.equal(block.caption, NOT_RECOGNISED);
  });

  /**
   * One reason per claim the text makes: `{` or `[` claims JSON, `<` claims
   * XML, anything else claims nothing. Malformed XML, HTML that is not
   * well-formed and trailing content after the root are never indented.
   */
  it('says why by what the text looks like, after a byte-order mark and white space', () => {
    const cases: [string, string][] = [
      ['hello', NOT_RECOGNISED],
      ['OK 200', NOT_RECOGNISED],
      [' \n', NOT_RECOGNISED],
      ['{', NOT_JSON],
      ['{"event":"test.completed",}', NOT_JSON],
      ['[1,2', NOT_JSON],
      [`${BYTE_ORDER_MARK}\n  {"a":}`, NOT_JSON],
      ['<br>', NOT_XML],
      ['<html><body><p>Hi<br></p></body></html>', NOT_XML],
      ['<order><id>1</order>', NOT_XML],
      ['<a/><b/>', NOT_XML],
      ['<a/>trailing', NOT_XML],
      ['\r\n\t <p>unclosed', NOT_XML],
      [`${BYTE_ORDER_MARK}<br>`, NOT_XML],
      [`${BYTE_ORDER_MARK}<a/>`, NOT_XML],
    ];

    for (const [body, reason] of cases) {
      const block = requestBodyBlock(details({ body }));

      assert.deepEqual(block.content, { kind: 'text', text: body, wrap: 'flush' }, body);
      assert.equal(block.caption, reason, body);
    }
  });

  it('shows XML with a DOCTYPE as stored, and says that is why', () => {
    const body = '<!DOCTYPE note><note><to>x</to></note>';
    const block = requestBodyBlock(details({ body }));

    assert.deepEqual(block.content, { kind: 'text', text: body, wrap: 'flush' });
    assert.equal(block.caption, XML_WITH_DOCTYPE);
  });

  it('shows XML nested past the limit as stored, and says that is why', () => {
    const depth = XML_MAX_DEPTH + 1;
    const body = `${'<a>'.repeat(depth)}<x/>${'</a>'.repeat(depth)}`;
    const block = requestBodyBlock(details({ body }));

    assert.deepEqual(block.content, { kind: 'text', text: body, wrap: 'flush' });
    assert.equal(block.caption, `${XML_TOO_DEEP} ${WRAPPED}`);
  });

  it('shows an XML body over the ceiling as stored, with the ceiling reason', () => {
    const body = `<r><a>${'x'.repeat(JSON_FORMAT_MAX_BYTES)}</a></r>`;
    const block = requestBodyBlock(details({ body }));

    assert.deepEqual(block.content, { kind: 'text', text: body, wrap: 'flush' });
    assert.equal(block.caption, `${OVER_CEILING} ${WRAPPED}`);
  });

  /** D149's hanging indent, unchanged: a continuation two columns deeper than its line. */
  it('wraps a long indented line with a hanging indent, and says so', () => {
    const long = 'v'.repeat(200);
    const block = requestBodyBlock(details({ body: `<r><s><item>${long}</item></s></r>` }));
    const text = displayedAndCopied(block);

    assert.equal(wrapOf(block), 'hanging');
    assert.equal(block.caption, WRAPPED);
    assert.equal(text, ['<r>', '  <s>', `    <item>${long}</item>`, '  </s>', '</r>'].join('\n'));

    const runs = hangingRuns(text, 114);
    const wrapped = runs.find((run) => run.hang !== null);

    assert.equal(runs.map((run) => run.text).join('\n'), text);
    assert.equal(wrapped?.hang, 4 + HANGING_INDENT_COLUMNS);
    assert.equal(wrapped?.keep, 0);
  });

  it('applies the same rules to the response body, a HEAD body included', () => {
    const indented = responseBodyBlock(record({ body: XML }));
    const suppressed = responseBodyBlock(record({ body: XML, bodySuppressed: true }));
    const malformed = responseBodyBlock(record({ body: '<br>' }));

    assert.deepEqual(indented.content, { kind: 'text', text: INDENTED, wrap: 'hanging' });
    assert.equal(indented.caption, null);
    assert.equal(displayedAndCopied(suppressed), INDENTED);
    assert.equal(suppressed.caption, 'Body not sent (HEAD).');
    assert.equal(malformed.caption, NOT_XML);
    assert.equal(
      responseBodyBlock(record({ body: 'hello', bodySuppressed: true })).caption,
      'Body not sent (HEAD).',
    );
  });
});

/**
 * Issue #64: JSON and XML whose rendering would be longer than 2 000 000
 * characters are shown as stored under their own line, as a body too deep or
 * over the ceiling is, and every reason that was there before keeps its place
 * (D163, D169, as amended for #64).
 */
describe('the Body block and the length cap', () => {
  /** `unit` repeated inside `depth` arrays, as many times as fit in `size` bytes. */
  function arrays(depth: number, unit: string, size: number): string {
    const count = Math.floor((size - depth * 2 + 1) / (unit.length + 1));

    return `${'['.repeat(depth)}${Array.from({ length: count }, () => unit).join(',')}${']'.repeat(depth)}`;
  }

  /** `unit` repeated inside `depth` elements, as many times as fit in `size` bytes. */
  function elements(depth: number, unit: string, size: number): string {
    const count = Math.floor((size - depth * 7) / unit.length);

    return `${'<a>'.repeat(depth)}${unit.repeat(count)}${'</a>'.repeat(depth)}`;
  }

  const LONG_JSON = arrays(91, '[[[[[[[[[1]]]]]]]]]', JSON_FORMAT_MAX_BYTES);
  const LONG_XML = elements(99, '<b><c/></b>', JSON_FORMAT_MAX_BYTES);

  function expectStoredUnder(block: BlockModel, body: string, reason: string): void {
    assert.deepEqual(block.content, { kind: 'text', text: body, wrap: 'flush' });
    assert.equal(block.caption, `${reason} ${WRAPPED}`);
    assert.equal(blockCopyText(block.content), body);
  }

  it('shows the JSON bodies measured for #64 as stored, and says that is why', () => {
    const sideBySide = `[${Array.from({ length: 1_317 }, () => `${'['.repeat(99)}${']'.repeat(99)}`).join(',')}]`;

    for (const body of [sideBySide, arrays(99, '[1]', JSON_FORMAT_MAX_BYTES), LONG_JSON]) {
      expectStoredUnder(requestBodyBlock(details({ body })), body, JSON_TOO_LONG);
    }
  });

  it('shows the XML body measured for #64 as stored, and says that is why', () => {
    expectStoredUnder(requestBodyBlock(details({ body: LONG_XML })), LONG_XML, XML_TOO_LONG);
  });

  /** 130 000 numbers three levels deep: 1 170 032 characters, under the cap. */
  it('still re-indents dense JSON that formats under the cap', () => {
    const digits = Array.from({ length: 130_000 }, (_, index) => String(index % 10));
    const block = requestBodyBlock(details({ body: `{"a":{"b":[${digits.join(',')}]}}` }));

    assert.equal(wrapOf(block), 'hanging');
    assert.equal(block.caption, null);
    assert.equal(blockCopyText(block.content).length, 1_170_032);
  });

  it('keeps the line a body had before where it is also too long', () => {
    // Room under the ceiling for what each case adds, and still too long alone.
    const json = arrays(91, '[[[[[[[[[1]]]]]]]]]', 200_000);
    const xml = elements(99, '<b><c/></b>', 200_000);

    expectStoredUnder(requestBodyBlock(details({ body: json })), json, JSON_TOO_LONG);
    expectStoredUnder(requestBodyBlock(details({ body: xml })), xml, XML_TOO_LONG);

    const cases: [string, string][] = [
      [`[${json}]`, JSON_TOO_DEEP],
      [`${json},`, NOT_JSON],
      [`<r>${xml}</r>`, XML_TOO_DEEP],
      [`<!DOCTYPE a>${xml}`, XML_WITH_DOCTYPE],
      [`${xml}<extra/>`, NOT_XML],
      [`${LONG_JSON}${' '.repeat(10)}`, OVER_CEILING],
      [`${LONG_XML}${' '.repeat(10)}`, OVER_CEILING],
    ];

    for (const [body, reason] of cases) {
      expectStoredUnder(requestBodyBlock(details({ body })), body, reason);
    }
  });

  /**
   * Recognised, so the label is not consulted: the line alone, never rows or
   * parts, and no reason it was not split (D162, D164, D169).
   */
  it('shows form- and multipart-labelled JSON and XML that are too long with their line alone', () => {
    for (const contentType of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ]) {
      for (const [body, reason] of [
        [LONG_JSON, JSON_TOO_LONG],
        [LONG_XML, XML_TOO_LONG],
      ] as const) {
        const block = requestBodyBlock(
          details({
            body,
            headers: [
              ['Host', 'qa-tools.ru'],
              ['Content-Type', contentType],
            ],
          }),
        );

        expectStoredUnder(block, body, reason);
      }
    }
  });

  it('applies the same cap to the response body', () => {
    expectStoredUnder(
      responseBodyBlock(record({ body: LONG_JSON, bodySize: LONG_JSON.length })),
      LONG_JSON,
      JSON_TOO_LONG,
    );
    expectStoredUnder(
      responseBodyBlock(record({ body: LONG_XML, bodySize: LONG_XML.length })),
      LONG_XML,
      XML_TOO_LONG,
    );
  });
});

describe('the Raw blocks', () => {
  /** `Raw` is the stored representation and is never re-indented (D112). */
  it('shows the request exactly as stored, with no re-indenting', () => {
    const block = requestRawBlock(details());

    assert.deepEqual(block.content, { kind: 'text', text: RAW_REQUEST, wrap: 'flush' });
    assert.equal(blockCopyText(block.content), RAW_REQUEST);
    assert.equal(block.caption, null);
  });

  it('explains the compact list address only where a row had to shorten one', () => {
    const long = requestRawBlock(details({ sourceIp: '2001:db8:85a3:0000:0000:8a2e:0370:7334' }));

    assert.equal(
      long.caption,
      'The full sender address is shown above. List rows keep a compact address.',
    );
    assert.equal(requestRawBlock(details({ sourceIp: null })).caption, null);
  });

  it('says the recorded response is not a wire capture', () => {
    const block = responseRawBlock(record());

    assert.equal(block.caption, 'Recorded HTTP representation · proxy changes are not included.');
  });

  it('says a 204 representation is headers and no body', () => {
    const block = responseRawBlock(
      record({ status: 204, body: null, bodySize: 0, raw: 'HTTP/1.1 204 No Content' }),
    );

    assert.equal(block.caption, 'This response contains headers and no body.');
  });

  it('renders a valid UTF-8 representation unchanged, non-ASCII text included', () => {
    const raw = 'POST /s/session HTTP/1.1\r\nX-Note: caf\u00e9\r\n\r\n{"note":"h\u00e9llo \u6587"}';
    const request = requestRawBlock(details({ raw }));
    const response = responseRawBlock(record());

    assert.deepEqual(request, {
      content: { kind: 'text', text: raw, wrap: 'flush' },
      caption: null,
    });
    assert.deepEqual(response.content, { kind: 'text', text: record().raw, wrap: 'flush' });
    assert.equal(displayedAndCopied(request), raw);
    assert.equal(displayedAndCopied(response), record().raw);
  });
});

/**
 * `Raw` of a representation with no body (issue #51, D158): the block ends at
 * the last header line on screen, and copying still yields the stored text,
 * CRLF CRLF included, so a copied request replays as it arrived. Each fixture
 * is composed as the backend composes one (`composeHead`): a head that ends in
 * CRLF CRLF, then the body bytes, if any.
 */
describe('Raw of a representation with no body', () => {
  const GET_HEAD = composeHead('GET /s/session?source=demo HTTP/1.1', [
    ['Host', 'qa-tools.ru'],
    ['User-Agent', 'curl/8.7.1'],
    ['Accept', '*/*'],
  ]);

  it('draws a GET without the blank line after its last header, and copies it with it', () => {
    const block = requestRawBlock(
      details({ method: 'GET', body: null, bodySize: 0, raw: GET_HEAD }),
    );
    const { shown, copied } = shownAndCopied(block);

    assert.ok(copied.endsWith('\r\nAccept: */*\r\n\r\n'));
    assert.equal(copied, GET_HEAD);
    assert.equal(shown, GET_HEAD.slice(0, -4));
    assert.ok(shown.endsWith('Accept: */*'));
    // One line per header and the request line: no empty line anywhere.
    assert.deepEqual(shown.split('\r\n'), [
      'GET /s/session?source=demo HTTP/1.1',
      'Host: qa-tools.ru',
      'User-Agent: curl/8.7.1',
      'Accept: */*',
    ]);
    assert.equal(block.caption, null);
  });

  it('draws a request line with no headers at all as that line alone', () => {
    const raw = 'GET /s/session HTTP/1.0\r\n\r\n';
    const { shown, copied } = shownAndCopied(requestRawBlock(details({ raw })));

    assert.equal(shown, 'GET /s/session HTTP/1.0');
    assert.equal(copied, raw);
  });

  it('draws a 204, a custom response with no body and a HEAD response the same way', () => {
    const noContent = composeHead('HTTP/1.1 204 No Content', [
      ['x-qa-tools-request-id', '2b906b89-6a58-4b3e-a9ec-7860faf986f3'],
      ['x-content-type-options', 'nosniff'],
    ]);
    const customWithoutBody = composeHead('HTTP/1.1 201 Created', [
      ['x-e2e-test', 'custom-response'],
      ['x-qa-tools-request-id', '2b906b89-6a58-4b3e-a9ec-7860faf986f3'],
    ]);
    // A HEAD response stores its head alone; the prepared body is in `Body`.
    const head = composeHead('HTTP/1.1 200 OK', [
      ['content-type', 'application/json; charset=utf-8'],
      ['content-length', '34'],
    ]);
    const cases: [ResponseRecord, string][] = [
      [record({ status: 204, body: null, bodySize: 0, raw: noContent }), noContent],
      [record({ status: 201, body: null, bodySize: 0, raw: customWithoutBody }), customWithoutBody],
      [record({ bodySuppressed: true, raw: head }), head],
    ];

    for (const [response, raw] of cases) {
      const { shown, copied } = shownAndCopied(responseRawBlock(response));

      assert.equal(copied, raw);
      assert.equal(shown, raw.slice(0, -4));
      assert.ok(!shown.endsWith('\r\n'), `${raw.split('\r\n')[0]} still ends in a line break`);
    }

    assert.equal(
      responseRawBlock(cases[0]![0]).caption,
      'This response contains headers and no body.',
    );
  });

  /** With a body the blank line parts head from body, and stays (#51). */
  it('draws a representation with a body exactly as stored, blank line included', () => {
    const withBody = `${GET_HEAD.replace('GET', 'POST')}{"runId":1842}`;
    const request = requestRawBlock(details({ raw: withBody }));
    const response = responseRawBlock(
      record({ raw: `${composeHead('HTTP/1.1 200 OK', [['content-length', '11']])}{"ok":true}` }),
    );

    assert.equal(displayedAndCopied(request), withBody);
    assert.ok(displayedAndCopied(request).includes('Accept: */*\r\n\r\n{"runId":1842}'));
    assert.ok(displayedAndCopied(response).endsWith('\r\n\r\n{"ok":true}'));
    assert.equal(request.content.kind === 'text' ? request.content.display : 'no', undefined);
  });

  /**
   * A body is free to end with CRLF CRLF of its own - or to be nothing but
   * one. The head still ends at the first, so that is a body, and it is shown.
   */
  it('keeps a body that is itself a blank line, or ends with one', () => {
    for (const body of ['\r\n\r\n', '\r\n', 'a\r\n\r\n']) {
      const raw = GET_HEAD + body;

      assert.equal(displayedAndCopied(requestRawBlock(details({ raw }))), raw);
    }
  });

  /** Not UTF-8 in the head (D145), no body: the same rule, on the same text. */
  it('draws a head that is not UTF-8 and has no body without its blank line', () => {
    const head = composeHead('GET /s/session HTTP/1.1', [['X-Note', 'café \u0085']]);
    const block = requestRawBlock(details({ raw: null, rawBase64: btoa(head), isRawBinary: true }));
    const { shown, copied } = shownAndCopied(block);

    assert.equal(copied, head);
    assert.equal(shown, head.slice(0, -4));
    assert.ok(shown.endsWith('X-Note: café \u0085'));
    assert.equal(block.caption, 'Headers shown as Latin-1 because they contain non-UTF-8 bytes.');
  });

  /** Bytes with no blank line fall back to Base64, which is never trimmed. */
  it('leaves the whole-representation Base64 fallback as it is', () => {
    const rawBase64 = btoa('SFR\xff\r\n');

    assert.equal(
      displayedAndCopied(requestRawBlock(details({ raw: null, rawBase64, isRawBinary: true }))),
      rawBase64,
    );
  });

  /** The line ending is invisible, so it cannot decide a caption either way. */
  it('decides the wrapping line on the stored text, which trimming cannot change', () => {
    const long = composeHead('GET /s/session HTTP/1.1', [['X-Long', 'v'.repeat(200)]]);
    const block = requestRawBlock(details({ raw: long }));

    assert.equal(block.caption, WRAPPED);
    assert.equal(wrapOf(block), 'flush');
    assert.equal(shownAndCopied(block).shown, long.slice(0, -4));
  });

  /** Nothing but `Raw` is ever trimmed: every other text block draws its text. */
  it('trims no other block', () => {
    const blocks = [
      requestBodyBlock(details({ body: '{"a":1}\r\n\r\n' })),
      requestBodyBlock(details({ body: 'plain\r\n\r\n' })),
      responseBodyBlock(record({ body: 'x\r\n\r\n' })),
    ];

    for (const block of blocks) {
      assert.equal(block.content.kind === 'text' ? block.content.display : 'no', undefined);
    }
  });
});

/**
 * `Raw` of a representation that is not UTF-8 (D145): the head as text, and
 * only the part that is not text as Base64. Each fixture is composed the way
 * the backend composes one - a CRLF head written one byte per character, a
 * blank line, the body bytes - and travels as the API sends it: `raw: null`,
 * the exact bytes in `rawBase64`.
 */
describe('Raw of a representation that is not UTF-8', () => {
  const BODY_BASE64_CAPTION = 'Body shown as Base64 because it contains non-UTF-8 bytes.';
  const HEAD_LATIN1_CAPTION = 'Headers shown as Latin-1 because they contain non-UTF-8 bytes.';
  const RECORDED = 'Recorded HTTP representation · proxy changes are not included.';

  /** 64 random bytes that are not UTF-8, as the backend's `bodyBase64` carries them. */
  const RANDOM_BODY_BASE64 =
    'IOyS+cpz/F3cAppN74wrYOff2QkmbkAfoGNwVZoSE6MSsjf8C6xTg9zeIY+BMs+FQqCMQg6d9sHAxemL0BgqIw==';

  const OCTET_HEADERS: [string, string][] = [
    ['Host', 'qa-tools.ru'],
    ['User-Agent', 'curl/8.7.1'],
    ['Accept', '*/*'],
    ['Content-Type', 'application/octet-stream'],
    ['Content-Length', '64'],
  ];

  function octetRequest(): RequestDetails {
    return details({
      headers: OCTET_HEADERS,
      bodySize: 64,
      body: null,
      bodyBase64: RANDOM_BODY_BASE64,
      isBinary: true,
      raw: null,
      rawBase64: btoa(
        composeHead('POST /s/session HTTP/1.1', OCTET_HEADERS) + atob(RANDOM_BODY_BASE64),
      ),
      isRawBinary: true,
    });
  }

  it('shows the request line and every header as text, then the body as its bodyBase64', () => {
    const request = octetRequest();
    const block = requestRawBlock(request);
    const lines = displayedAndCopied(block).split('\r\n');

    assert.equal(lines[0], 'POST /s/session HTTP/1.1');
    assert.deepEqual(
      lines.slice(1, 1 + OCTET_HEADERS.length),
      blockCopyText(requestHeadersBlock(request).content).split('\n'),
    );
    assert.equal(lines[1 + OCTET_HEADERS.length], '');
    assert.equal(lines[2 + OCTET_HEADERS.length], request.bodyBase64);
    assert.equal(lines.length, 3 + OCTET_HEADERS.length);
    assert.equal(block.caption, BODY_BASE64_CAPTION);
  });

  /** The caption is about the body; nothing says the headers are encoded. */
  it('names the body alone in its caption, and keeps the address line', () => {
    const block = requestRawBlock({
      ...octetRequest(),
      sourceIp: '2001:db8:85a3:0000:0000:8a2e:0370:7334',
    });

    assert.equal(
      block.caption,
      'The full sender address is shown above. List rows keep a compact address. ' +
        BODY_BASE64_CAPTION,
    );
    assert.doesNotMatch(block.caption ?? '', /Raw request|header/i);
  });

  /**
   * A body is free to contain a blank line of its own - twice, here, around
   * something that looks like a request line. The head ends at the first one,
   * which is the only place either composer writes it; splitting at a later
   * one would pull body bytes into the head.
   */
  it('ends the head at the first blank line, however many the body carries', () => {
    // 0xFF 0x00, CRLF CRLF, `POST / HTTP/1.1`, CRLF CRLF, 0xFE 0x80.
    const bodyBase64 = '/wANCg0KUE9TVCAvIEhUVFAvMS4xDQoNCv6A';
    const head = composeHead('POST /s/session HTTP/1.1', [
      ['Content-Type', 'application/octet-stream'],
      ['Content-Length', '27'],
    ]);
    const request = details({
      body: null,
      bodyBase64,
      isBinary: true,
      bodySize: 27,
      raw: null,
      rawBase64: btoa(head + atob(bodyBase64)),
      isRawBinary: true,
    });
    const block = requestRawBlock(request);

    assert.ok(atob(bodyBase64).includes('\r\n\r\n'));
    assert.equal(displayedAndCopied(block), head + request.bodyBase64);
    assert.equal(block.caption, BODY_BASE64_CAPTION);
  });

  /**
   * A header sent as UTF-8 - `café` as `C3 A9` - over a binary body. The head
   * is valid UTF-8 and is read as UTF-8, as it would be in a text
   * representation, so the only line added is the body's. `Headers` shows
   * Node's one-character-per-byte reading of the same bytes, which predates
   * this view and is recorded in D145 rather than changed.
   */
  it('reads a head that is valid UTF-8 as UTF-8, non-ASCII header included', () => {
    const headers: [string, string][] = [
      ['Host', 'qa-tools.ru'],
      // What Node hands the backend for the bytes `C3 A9`, and what it stores.
      ['X-Note', 'caf\u00c3\u00a9'],
      ['Content-Type', 'application/octet-stream'],
    ];
    const request = details({
      headers,
      body: null,
      bodyBase64: RANDOM_BODY_BASE64,
      isBinary: true,
      bodySize: 64,
      raw: null,
      rawBase64: btoa(composeHead('POST /s/session HTTP/1.1', headers) + atob(RANDOM_BODY_BASE64)),
      isRawBinary: true,
    });
    const block = requestRawBlock(request);
    const text = displayedAndCopied(block);

    assert.ok(text.includes('\r\nX-Note: caf\u00e9\r\n'));
    assert.ok(text.endsWith(`\r\n\r\n${RANDOM_BODY_BASE64}`));
    assert.equal(block.caption, BODY_BASE64_CAPTION);
    assert.ok(
      blockCopyText(requestHeadersBlock(request).content).includes('X-Note: caf\u00c3\u00a9'),
    );
  });

  /**
   * The Response half runs the same code on the same contract. No response the
   * backend records today is binary - a configured body is a UTF-8 string and
   * a configured header value is visible ASCII - so this pins the branch that
   * exists for symmetry with the API rather than a case a user can reach (D145).
   */
  it('renders a response representation that is not UTF-8 the same way, under its recorded caption', () => {
    const head = composeHead('HTTP/1.1 200 OK', [
      ['content-type', 'application/octet-stream'],
      ['content-length', '64'],
    ]);
    const block = responseRawBlock(
      record({
        body: null,
        bodyBase64: RANDOM_BODY_BASE64,
        isBinary: true,
        bodySize: 64,
        raw: null,
        rawBase64: btoa(head + atob(RANDOM_BODY_BASE64)),
        isRawBinary: true,
      }),
    );

    assert.equal(displayedAndCopied(block), head + RANDOM_BODY_BASE64);
    assert.equal(block.caption, `${RECORDED} ${BODY_BASE64_CAPTION}`);
  });

  /**
   * A header value carrying 0xE9 and bytes in 0x80-0x9F, with a text body. The
   * head is read one character per byte, which is what Node gave `Headers`, and
   * the body is still read as UTF-8 on its own.
   */
  it('reads a head that is not UTF-8 one character per byte, as Headers shows it', () => {
    const headers: [string, string][] = [
      ['Host', 'qa-tools.ru'],
      ['X-Note', 'caf\u00e9 \u0085 \u0080\u009f'],
      ['Content-Type', 'application/json'],
    ];
    const body = '{"note":"h\u00e9llo"}';
    const head = composeHead('POST /s/session HTTP/1.1', headers);
    const request = details({
      headers,
      body,
      raw: null,
      rawBase64: btoa(head + utf8Bytes(body)),
      isRawBinary: true,
    });
    const block = requestRawBlock(request);
    const text = displayedAndCopied(block);

    assert.equal(text, head + body);
    assert.ok(
      text.includes(blockCopyText(requestHeadersBlock(request).content).split('\n').join('\r\n')),
    );
    // What windows-1252 - `TextDecoder('latin1')` - would have drawn instead.
    assert.doesNotMatch(text, /[…€Ÿ]/);
    assert.equal(block.caption, HEAD_LATIN1_CAPTION);
  });

  /**
   * Every byte in 0x80-0x9F comes back as the code point of the same number.
   * That is where ISO-8859-1 and windows-1252 part, and Node's `TextDecoder`
   * maps `latin1` to windows-1252 as a browser does - the last assertion checks
   * that it still does, since that is what lets this test catch that decoder.
   */
  it('reads every byte in 0x80-0x9F as the code point of the same number', () => {
    const value = String.fromCharCode(...Array.from({ length: 0x20 }, (_unused, i) => 0x80 + i));
    const head = composeHead('GET /s/session HTTP/1.1', [['X-Controls', value]]);
    const block = requestRawBlock(details({ raw: null, rawBase64: btoa(head), isRawBinary: true }));
    const { shown, copied } = shownAndCopied(block);

    // No body, so the screen stops at the header line (D158); the copy does not.
    assert.equal(copied, head);
    assert.equal(shown, head.slice(0, -4));
    assert.equal(block.caption, HEAD_LATIN1_CAPTION);
    assert.notEqual(new TextDecoder('latin1').decode(Uint8Array.of(0x85)), '\u0085');
  });

  it('applies both rules together where the head and the body are both not UTF-8', () => {
    const head = composeHead('POST /s/session HTTP/1.1', [
      ['X-Note', 'caf\u00e9'],
      ['Content-Type', 'application/octet-stream'],
    ]);
    const block = requestRawBlock(
      details({
        raw: null,
        rawBase64: btoa(head + atob(RANDOM_BODY_BASE64)),
        isRawBinary: true,
      }),
    );

    assert.equal(displayedAndCopied(block), head + RANDOM_BODY_BASE64);
    assert.equal(block.caption, `${HEAD_LATIN1_CAPTION} ${BODY_BASE64_CAPTION}`);
  });

  /** A body part that opens with a byte-order mark keeps it, as the text case would. */
  it('keeps a byte-order mark at the start of a body part that is text', () => {
    const head = composeHead('POST /s/session HTTP/1.1', [['X-Note', 'caf\u00e9']]);
    const body = '\ufeff{"a":1}';
    const block = requestRawBlock(
      details({ raw: null, rawBase64: btoa(head + utf8Bytes(body)), isRawBinary: true }),
    );

    assert.equal(displayedAndCopied(block), head + body);
  });

  /** The wrapping line follows the others, exactly as it does on a text block. */
  it('adds the wrapping line after its own where the Base64 line does not fit', () => {
    const head = composeHead('POST /s/session HTTP/1.1', [
      ['Content-Type', 'application/octet-stream'],
      ['Content-Length', '1024'],
    ]);
    const block = requestRawBlock(
      details({ raw: null, rawBase64: btoa(head + '\xff'.repeat(1024)), isRawBinary: true }),
    );

    assert.equal(wrapOf(block), 'flush');
    assert.equal(block.caption, `${BODY_BASE64_CAPTION} ${WRAPPED}`);
  });

  /**
   * Bytes with no blank line are nothing either composer writes. The view shows
   * them as it did before the split: whole, as Base64, under the old caption.
   */
  it('falls back to the whole representation as Base64 where there is no blank line', () => {
    const rawBase64 = btoa('SFR\xff\r\n');
    const request = requestRawBlock(details({ raw: null, rawBase64, isRawBinary: true }));
    const response = responseRawBlock(record({ raw: null, rawBase64: 'U0ZS', isRawBinary: true }));

    assert.equal(displayedAndCopied(request), rawBase64);
    assert.equal(
      request.caption,
      'Raw request shown as Base64 because it contains non-UTF-8 bytes.',
    );
    assert.equal(displayedAndCopied(response), 'U0ZS');
    assert.equal(
      response.caption,
      'Raw response shown as Base64 because it contains non-UTF-8 bytes.',
    );
  });

  it('shows a value that is not Base64 at all as it arrived, without throwing', () => {
    const block = requestRawBlock(
      details({ raw: null, rawBase64: 'not base64!', isRawBinary: true }),
    );

    assert.equal(displayedAndCopied(block), 'not base64!');
    assert.equal(block.caption, 'Raw request shown as Base64 because it contains non-UTF-8 bytes.');
  });
});

describe('the Headers and Query blocks', () => {
  it('copies every header row in full, in order, duplicates kept', () => {
    const block = requestHeadersBlock(
      details({
        headers: [
          ['Set-Cookie', 'a=1'],
          ['Set-Cookie', 'b=2'],
        ],
      }),
    );

    assert.equal(blockCopyText(block.content), 'Set-Cookie: a=1\nSet-Cookie: b=2');
    assert.equal(block.caption, REQUEST_HEADERS);
  });

  /**
   * The proxy's forwarding headers have not been stored since v0.11.0 (D144),
   * so the caption no longer claims the block includes them (D149).
   */
  it('no longer says the request headers include proxy-added fields', () => {
    assert.doesNotMatch(requestHeadersBlock(details()).caption ?? '', /proxy/i);
  });

  it('keeps describing the block where a header value wraps, and adds the wrapping line', () => {
    const block = responseHeadersBlock(
      record({ headers: [['Location', `https://example.com/callback?state=${'v'.repeat(200)}`]] }),
    );

    assert.equal(
      block.caption,
      `Recorded headers retain their order and repeated names. ${WRAPPED}`,
    );
  });

  /**
   * A configured redirect's target is recorded like any header (D247) and
   * drawn as text, never as a link (D113): the pairs and the raw head hold it
   * as the string it is, and neither component that draws them makes an
   * anchor of anything.
   */
  it('draws a recorded Location as text in Headers and Raw, never as a link', () => {
    const target = '/s/G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA/after';
    const raw = `HTTP/1.1 302 Found\r\nlocation: ${target}\r\nx-qa-tools-request-id: 2b906b89\r\n\r\n`;
    const recorded = record({
      status: 302,
      headers: [
        ['location', target],
        ['x-qa-tools-request-id', '2b906b89'],
      ],
      body: null,
      bodySize: 0,
      raw,
    });

    assert.deepEqual(responseHeadersBlock(recorded).content, {
      kind: 'pairs',
      pairs: recorded.headers,
      separator: ': ',
    });
    // A head with no body is shown without its closing blank line, and copied whole (D158).
    const { shown, copied } = shownAndCopied(responseRawBlock(recorded));

    assert.equal(copied, raw);
    assert.equal(shown, raw.trimEnd());
    assert.ok(shown.includes(`\r\nlocation: ${target}\r\n`));

    for (const component of ['PairsGrid.tsx', 'CodeBlock.tsx']) {
      const source = readFileSync(new URL(`../components/${component}`, import.meta.url), 'utf8');

      assert.doesNotMatch(source, /<a[\s>]|href|<Link\b/, component);
    }
  });

  it('keeps recorded response headers in their recorded order', () => {
    const block = responseHeadersBlock(record());

    assert.equal(blockCopyText(block.content), 'Content-Type: application/json; charset=utf-8');
    assert.equal(block.caption, 'Recorded headers retain their order and repeated names.');
  });

  it('parses the query string into rows, keeping repeated names', () => {
    const block = requestQueryBlock(details({ queryString: 'x=1&x=2&empty=' }));

    assert.equal(blockCopyText(block.content), 'x=1\nx=2\nempty=');
    assert.equal(block.caption, 'Query parameters belong to the incoming request.');
  });

  /**
   * The one named exception to "the tool shows what arrived", asserted so that
   * it stays a decision rather than becoming a surprise: the rows show decoded
   * values, and the encoded query string stays in `Raw`.
   */
  it('shows query values decoded, with the encoded form left to Raw', () => {
    const queryString = 'sig=abc%2Bdef&note=a+b&path=%2Fv%2F1';
    const block = requestQueryBlock(details({ queryString, raw: `GET /s/x?${queryString}` }));

    assert.equal(blockCopyText(block.content), 'sig=abc+def\nnote=a b\npath=/v/1');
    assert.ok(
      blockCopyText(requestRawBlock(details({ raw: `GET /s/x?${queryString}` })).content).includes(
        'sig=abc%2Bdef',
      ),
    );
  });

  /**
   * The caption is decided by how wide the line is drawn, not by how many
   * UTF-16 code units it holds: a line of CJK is about twice as wide as its
   * `length`, which is where the caption was being dropped.
   */
  it('counts a wide character as two columns when deciding the wrapping line', () => {
    const wide = '\u6587'.repeat(60);

    assert.ok(`X: ${wide}`.length < 110);
    assert.equal(
      requestHeadersBlock(details({ headers: [['X', wide]] })).caption,
      `${REQUEST_HEADERS} ${WRAPPED}`,
    );
  });

  /** The status marks payloads actually carry, drawn two columns wide as well. */
  it('counts a status mark as two columns when deciding the wrapping line', () => {
    const marks = '\u2705\u274C\u26A0\u279C'.repeat(15);

    assert.ok(`X: ${marks}`.length < 110);
    assert.equal(
      requestHeadersBlock(details({ headers: [['X', marks]] })).caption,
      `${REQUEST_HEADERS} ${WRAPPED}`,
    );
  });

  it('leaves a narrow line alone at the same character count', () => {
    const narrow = 'v'.repeat(60);

    assert.equal(
      requestHeadersBlock(details({ headers: [['X', narrow]] })).caption,
      REQUEST_HEADERS,
    );
  });

  it('offers nothing to copy where a request carried no query string', () => {
    const block = requestQueryBlock(details({ queryString: '' }));

    assert.deepEqual(block.content, { kind: 'empty', placeholder: 'No query parameters' });
    assert.equal(isCopyable(block.content), false);
  });

  /**
   * Issue #27 (D162): `URLSearchParams` drew `name = ����` for "Иван" sent as
   * windows-1251. Decoding is strict UTF-8 now, and a query string that is not
   * is shown as stored, with a reason line, instead of as rows.
   */
  it('shows a query string that is not UTF-8 as stored, with a reason line and no rows', () => {
    const queryString = 'id=7&name=%C8%E2%E0%ED';
    const block = requestQueryBlock(details({ queryString }));

    assert.deepEqual(block.content, { kind: 'text', text: queryString, wrap: 'flush' });
    assert.equal(
      block.caption,
      'Query parameters belong to the incoming request. Not decoded: this query string is not UTF-8.',
    );
    assert.equal(blockCopyText(block.content), queryString);
    assert.doesNotMatch(blockCopyText(block.content), /�/);
  });

  it('wraps a long query string that is not UTF-8 like every other text block', () => {
    const block = requestQueryBlock(details({ queryString: `name=%C8&pad=${'p'.repeat(200)}` }));

    assert.equal(wrapOf(block), 'flush');
    assert.equal(
      block.caption,
      'Query parameters belong to the incoming request. Not decoded: this query string is not UTF-8.' +
        ` ${WRAPPED}`,
    );
  });

  it('still draws a UTF-8 query string as rows, and keeps a malformed escape literally', () => {
    const block = requestQueryBlock(
      details({ queryString: 'name=%D0%98%D0%B2%D0%B0%D0%BD&rate=100%&bad=%zz' }),
    );

    assert.deepEqual(block.content, {
      kind: 'pairs',
      pairs: [
        ['name', 'Иван'],
        ['rate', '100%'],
        ['bad', '%zz'],
      ],
      separator: '=',
    });
    assert.equal(block.caption, 'Query parameters belong to the incoming request.');
  });
});

/**
 * Issue #27 (D162): a body labelled `application/x-www-form-urlencoded` is the
 * same data as a query string in the same shape, so `Body` draws and copies it
 * exactly as `Query` does - decoded rows, one `name=value` per line - and the
 * encoded body stays in `Raw`. The label is consulted only because a form
 * cannot describe itself, and never against a successful sniff.
 */
describe('the Body block of a form', () => {
  const FORM = 'application/x-www-form-urlencoded';
  const NOT_UTF8 = 'Not decoded: this form body is not UTF-8.';
  const NO_PAIRS = 'Not decoded: this form body has no name/value pairs.';

  /** A request with this body under a `Content-Type` of `contentType`. */
  function form(body: string | null, contentType: string | null = FORM): RequestDetails {
    const headers: [string, string][] = [['Host', 'qa-tools.ru']];

    if (contentType !== null) {
      headers.push(['Content-Type', contentType]);
    }

    return details({ headers, body, bodySize: body === null ? 0 : body.length });
  }

  it('draws decoded rows in recorded order, repeated names kept, + and escapes resolved', () => {
    const body =
      'name=%D0%98%D0%B2%D0%B0%D0%BD+%D0%9F%D0%B5%D1%82%D1%80%D0%BE%D0%B2&tag=a&tag=b&sig=abc%2Bdef&note=a+b';
    const block = requestBodyBlock(form(body));

    assert.deepEqual(block, {
      content: {
        kind: 'pairs',
        pairs: [
          ['name', 'Иван Петров'],
          ['tag', 'a'],
          ['tag', 'b'],
          ['sig', 'abc+def'],
          ['note', 'a b'],
        ],
        separator: '=',
      },
      caption: null,
    });
  });

  it('reads the label in any case, with parameters and surrounding space', () => {
    const labels = [
      FORM,
      'Application/X-WWW-Form-URLEncoded',
      'application/x-www-form-urlencoded; charset=UTF-8',
      ' APPLICATION/X-WWW-FORM-URLENCODED ;charset=windows-1251',
    ];

    for (const label of labels) {
      assert.deepEqual(
        requestBodyBlock(form('a=1&b=2', label)).content,
        {
          kind: 'pairs',
          pairs: [
            ['a', '1'],
            ['b', '2'],
          ],
          separator: '=',
        },
        label,
      );
    }
  });

  it('finds the header whatever the case of its name, and reads the first of several', () => {
    const lower = details({ headers: [['content-type', FORM]], body: 'a=1' });
    const formFirst = details({
      headers: [
        ['Content-Type', FORM],
        ['Content-Type', 'text/plain'],
      ],
      body: 'a=1',
    });
    const textFirst = details({
      headers: [
        ['Content-Type', 'text/plain'],
        ['Content-Type', FORM],
      ],
      body: 'a=1',
    });

    assert.equal(requestBodyBlock(lower).content.kind, 'pairs');
    assert.equal(requestBodyBlock(formFirst).content.kind, 'pairs');
    assert.equal(requestBodyBlock(textFirst).content.kind, 'text');
  });

  /** The decoded rows as `Query` copies them; `Raw` stays encoded. */
  it('copies the decoded rows, one name=value per line, and leaves Raw encoded', () => {
    const body = 'name=%D0%98%D0%B2%D0%B0%D0%BD&tag=a&tag=b&note=a+b';
    const raw = composeHead('POST /s/session HTTP/1.1', [['Content-Type', FORM]]) + body;
    const request = { ...form(body), raw };
    const block = requestBodyBlock(request);

    assert.equal(blockCopyText(block.content), 'name=Иван\ntag=a\ntag=b\nnote=a b');
    assert.equal(isCopyable(block.content), true);
    assert.equal(displayedAndCopied(requestRawBlock(request)), raw);
    assert.ok(raw.endsWith(`\r\n\r\n${body}`));
    // The same separator and the same rows as the same data in `Query`.
    assert.equal(
      blockCopyText(block.content),
      blockCopyText(requestQueryBlock(details({ queryString: body })).content),
    );
  });

  /** A header never overrides a successful sniff. */
  it('re-indents a valid JSON body labelled as a form', () => {
    const block = requestBodyBlock(form('{"a":"b=c&d=e","n":12345678901234567890}'));

    assert.deepEqual(block, {
      content: {
        kind: 'text',
        text: '{\n  "a": "b=c&d=e",\n  "n": 12345678901234567890\n}',
        wrap: 'hanging',
      },
      caption: null,
    });
  });

  /**
   * Without the label, a form-shaped body is not sniffed as one.
   * It claims no format, so it gets the neutral line since #28 (D163) - and,
   * under a multipart label without a boundary, the reason it was not split
   * after it (D164).
   */
  it('draws no rows for a form-shaped body that is not labelled as a form', () => {
    for (const contentType of [null, 'text/plain', 'application/json']) {
      const block = requestBodyBlock(form('a=1&b=2', contentType));

      assert.deepEqual(block, {
        content: { kind: 'text', text: 'a=1&b=2', wrap: 'flush' },
        caption: NOT_RECOGNISED,
      });
    }

    assert.deepEqual(requestBodyBlock(form('a=1&b=2', 'multipart/form-data')), {
      content: { kind: 'text', text: 'a=1&b=2', wrap: 'flush' },
      caption: `${NOT_RECOGNISED} Not split into parts: Content-Type declares no boundary.`,
    });
  });

  /** A successful sniff wins over the label, for XML as for JSON (D162, D163). */
  it('indents well-formed XML labelled as a form', () => {
    const block = requestBodyBlock(form('<order><id>7</id><note>a=1&amp;b=2</note></order>'));

    assert.deepEqual(block, {
      content: {
        kind: 'text',
        text: ['<order>', '  <id>7</id>', '  <note>a=1&amp;b=2</note>', '</order>'].join('\n'),
        wrap: 'hanging',
      },
      caption: null,
    });
  });

  /** A failed sniff falls through to the label (D162 item 1), `<` or not. */
  it('draws rows for a form-labelled body that starts with < and is not well-formed XML', () => {
    const block = requestBodyBlock(form('<a=1&b=%3Cx%3E'));

    assert.deepEqual(block, {
      content: {
        kind: 'pairs',
        pairs: [
          ['<a', '1'],
          ['b', '<x>'],
        ],
        separator: '=',
      },
      caption: null,
    });
  });

  /**
   * Recognising well-formed XML is a successful sniff even where it is not
   * indented, so the label is not consulted and the block gives the XML's own
   * reason (D162 item 1, D163): the DOCTYPE document below is not two rows.
   */
  it('shows form-labelled XML with a DOCTYPE as stored, with its own line and no rows', () => {
    const body = '<!DOCTYPE a><a>x&amp;y</a>';

    assert.deepEqual(requestBodyBlock(form(body)), {
      content: { kind: 'text', text: body, wrap: 'flush' },
      caption: XML_WITH_DOCTYPE,
    });
  });

  /** Deep JSON was recognised too, so the label is not consulted either (D169). */
  it('shows form-labelled JSON nested past the limit as stored, with its own line and no rows', () => {
    const depth = JSON_MAX_DEPTH + 1;
    const body = `${'{"a=1&b":'.repeat(depth)}0${'}'.repeat(depth)}`;

    assert.deepEqual(requestBodyBlock(form(body)), {
      content: { kind: 'text', text: body, wrap: 'flush' },
      caption: `${JSON_TOO_DEEP} ${WRAPPED}`,
    });
  });

  it('shows form-labelled XML nested past the limit as stored, with its own line and no rows', () => {
    const depth = XML_MAX_DEPTH + 1;
    const body = `${'<a>'.repeat(depth)}<x/>${'</a>'.repeat(depth)}`;

    assert.deepEqual(requestBodyBlock(form(body)), {
      content: { kind: 'text', text: body, wrap: 'flush' },
      caption: `${XML_TOO_DEEP} ${WRAPPED}`,
    });
  });

  /** Issue #27's example: "Иван" in windows-1251, an escape that is not UTF-8. */
  it('shows a body with an escape that is not UTF-8 as stored, with a reason line and no rows', () => {
    const body = 'name=%C8%E2%E0%ED';
    const block = requestBodyBlock(form(body));

    assert.deepEqual(block, {
      content: { kind: 'text', text: body, wrap: 'flush' },
      caption: NOT_UTF8,
    });
    assert.equal(blockCopyText(block.content), body);
  });

  it('refuses the whole body for one escape that is not UTF-8, however many pairs decode', () => {
    const body = 'id=7&city=%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0&name=%C8%E2%E0%ED&tag=a';

    assert.deepEqual(requestBodyBlock(form(body)), {
      content: { kind: 'text', text: body, wrap: 'flush' },
      caption: NOT_UTF8,
    });
  });

  it('keeps %zz and 100% literally in their cells', () => {
    const block = requestBodyBlock(form('discount=100%&code=%zz&ok=%41'));

    assert.deepEqual(block.content, {
      kind: 'pairs',
      pairs: [
        ['discount', '100%'],
        ['code', '%zz'],
        ['ok', 'A'],
      ],
      separator: '=',
    });
    assert.equal(block.caption, null);
  });

  /** No empty grid, and an empty body is still no body. */
  it('shows a body with no pairs at all as stored, with a reason line', () => {
    for (const body of ['&&&', '&']) {
      assert.deepEqual(requestBodyBlock(form(body)), {
        content: { kind: 'text', text: body, wrap: 'flush' },
        caption: NO_PAIRS,
      });
    }
  });

  it('draws = and a bare name as one-pair forms', () => {
    assert.deepEqual(requestBodyBlock(form('=')).content, {
      kind: 'pairs',
      pairs: [['', '']],
      separator: '=',
    });
    assert.deepEqual(requestBodyBlock(form('a')).content, {
      kind: 'pairs',
      pairs: [['a', '']],
      separator: '=',
    });
    assert.equal(blockCopyText(requestBodyBlock(form('hello')).content), 'hello=');
  });

  it('keeps No request body for an empty body labelled as a form', () => {
    for (const body of [null, '']) {
      const block = requestBodyBlock(form(body));

      assert.deepEqual(block.content, { kind: 'empty', placeholder: 'No request body' });
      assert.equal(block.caption, 'This request was captured without a body.');
    }
  });

  /** The JSON ceiling, by the same UTF-8 byte measure. */
  it('shows a form body above 256 KiB as stored, with the ceiling reason line', () => {
    const body = `a=${'x'.repeat(JSON_FORMAT_MAX_BYTES)}`;
    const block = requestBodyBlock(form(body));

    assert.equal(wrapOf(block), 'flush');
    assert.equal(blockCopyText(block.content), body);
    assert.equal(
      block.caption,
      `Formatting unavailable above 256 KiB. Original content remains accessible. ${WRAPPED}`,
    );
  });

  it('measures the ceiling in UTF-8 bytes, not in characters', () => {
    const atCeiling = `a=${'x'.repeat(JSON_FORMAT_MAX_BYTES - 2)}`;
    // Two bytes each in UTF-8: half as many characters, over the ceiling.
    const overInBytes = `a=${'é'.repeat(JSON_FORMAT_MAX_BYTES / 2)}`;

    assert.equal(requestBodyBlock(form(atCeiling)).content.kind, 'pairs');
    assert.ok(overInBytes.length < JSON_FORMAT_MAX_BYTES);
    assert.equal(requestBodyBlock(form(overInBytes)).content.kind, 'text');
  });

  it('says where a row wraps, as Query does, and says nothing else', () => {
    const block = requestBodyBlock(form(`state=${'q'.repeat(200)}&x=1`));

    assert.equal(block.content.kind, 'pairs');
    assert.equal(block.caption, WRAPPED);
  });

  it('wraps a stored form body that could not be decoded, and says so where a line does', () => {
    const block = requestBodyBlock(form(`name=%C8&pad=${'p'.repeat(200)}`));

    assert.equal(wrapOf(block), 'flush');
    assert.equal(block.caption, `${NOT_UTF8} ${WRAPPED}`);
  });

  /** One body path for both halves: the record carries its own headers. */
  it('draws a recorded response body labelled as a form the same way', () => {
    const response = responseBodyBlock(
      record({ headers: [['content-type', `${FORM}; charset=utf-8`]], body: 'ok=1&tag=a&tag=b' }),
    );
    const notUtf8 = responseBodyBlock(
      record({ headers: [['content-type', FORM]], body: 'name=%C8%E2%E0%ED' }),
    );

    assert.deepEqual(response, {
      content: {
        kind: 'pairs',
        pairs: [
          ['ok', '1'],
          ['tag', 'a'],
          ['tag', 'b'],
        ],
        separator: '=',
      },
      caption: null,
    });
    assert.equal(notUtf8.caption, NOT_UTF8);
  });

  /**
   * A configured `Content-Type` is recorded where the receiver sent it: first,
   * among the configured pairs, with no `application/json` after it (D179).
   */
  it('draws a form body a custom response configured its own Content-Type for', () => {
    const block = responseBodyBlock(
      record({
        headers: configuredHead(FORM, 'status=failed&code=42'),
        body: 'status=failed&code=42',
      }),
    );

    assert.deepEqual(block, {
      content: {
        kind: 'pairs',
        pairs: [
          ['status', 'failed'],
          ['code', '42'],
        ],
        separator: '=',
      },
      caption: null,
    });
  });

  /** `Body not sent (HEAD).` over rows as over text, with the wrapping line where a row wraps. */
  it('says a HEAD body drawn as rows was not sent', () => {
    const headers: [string, string][] = [['content-type', FORM]];
    const short = responseBodyBlock(record({ headers, bodySuppressed: true, body: 'ok=1' }));
    const long = responseBodyBlock(
      record({ headers, bodySuppressed: true, body: `ok=${'y'.repeat(200)}` }),
    );

    assert.equal(short.content.kind, 'pairs');
    assert.equal(short.caption, 'Body not sent (HEAD).');
    assert.equal(blockCopyText(short.content), 'ok=1');
    assert.equal(long.content.kind, 'pairs');
    assert.equal(long.caption, `Body not sent (HEAD). ${WRAPPED}`);
  });
});

/**
 * Issue #29: a body labelled `multipart/*` with a boundary is drawn as its
 * parts, split from its exact bytes whether it arrived as text or as Base64,
 * and a body that cannot be split is drawn as before with the reason (D164).
 * One test per acceptance point, named after it.
 */
describe('the Body block of a multipart body', () => {
  const BOUNDARY = '------------------------d74496d66958873e';
  const LABEL = `multipart/form-data; boundary=${BOUNDARY}`;
  const BINARY_BODY = 'Binary body shown as Base64. JSON formatting is unavailable.';
  const BODY_BASE64 = 'Body shown as Base64 because it contains non-UTF-8 bytes.';
  const NO_BOUNDARY = 'Not split into parts: Content-Type declares no boundary.';
  const NO_DELIMITER =
    'Not split into parts: the boundary declared in Content-Type never starts a part.';
  const NO_CLOSE = 'Not split into parts: the closing boundary is missing.';
  const TOO_LARGE = 'Not split into parts above 256 KiB, binary content not counted.';
  const BINARY_NOTE = 'Binary content, not shown. Its bytes are in Raw.';

  /** A PNG's signature and header chunk: not UTF-8 from its first byte. */
  const PNG =
    '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89';

  interface Part {
    /** As text; written as UTF-8. */
    headers: [string, string][];
    /** Bytes, one character per byte. */
    content: string;
  }

  function field(name: string, text: string): Part {
    return {
      headers: [['Content-Disposition', `form-data; name="${name}"`]],
      content: utf8Bytes(text),
    };
  }

  function file(name: string, filename: string, type: string | null, bytes: string): Part {
    const headers: [string, string][] = [
      ['Content-Disposition', `form-data; name="${name}"; filename="${filename}"`],
    ];

    if (type !== null) {
      headers.push(['Content-Type', type]);
    }

    return { headers, content: bytes };
  }

  /**
   * A body as `curl -F` writes one, CRLF throughout: each part after a
   * delimiter line, then the closing line. `preamble` goes before the first
   * delimiter and `epilogue` after the closing line.
   */
  function multipartBytes(
    parts: readonly Part[],
    { boundary = BOUNDARY, preamble = '', epilogue = '' } = {},
  ): string {
    let bytes = preamble === '' ? '' : `${preamble}\r\n`;

    for (const part of parts) {
      bytes += `--${boundary}\r\n`;

      for (const [name, value] of part.headers) {
        bytes += utf8Bytes(`${name}: ${value}\r\n`);
      }

      bytes += `\r\n${part.content}\r\n`;
    }

    return `${bytes}--${boundary}--\r\n${epilogue}`;
  }

  const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  /**
   * A request carrying these bytes as the API sends it (D043): as text where
   * they are UTF-8 and as Base64 where not, with `Raw` composed as the backend
   * composes it.
   */
  function multipartRequest(
    bytes: string,
    contentType: string | null = LABEL,
  ): RequestDetails & { head: string } {
    const headers: [string, string][] = [['Host', 'qa-tools.ru']];

    if (contentType !== null) {
      headers.push(['Content-Type', contentType]);
    }

    const head = composeHead('POST /s/session HTTP/1.1', headers);
    let text: string | null;

    try {
      text = strictUtf8.decode(Uint8Array.from(bytes, (character) => character.charCodeAt(0)));
    } catch {
      text = null;
    }

    const request =
      text === null
        ? details({
            headers,
            bodySize: bytes.length,
            body: null,
            bodyBase64: btoa(bytes),
            isBinary: true,
            raw: null,
            rawBase64: btoa(head + bytes),
            isRawBinary: true,
          })
        : details({
            headers,
            bodySize: bytes.length,
            body: text,
            bodyBase64: null,
            isBinary: false,
            raw: head + text,
            rawBase64: null,
            isRawBinary: false,
          });

    return { ...request, head };
  }

  /** The parts a block draws, once it is checked that it draws parts. */
  function partsOf(block: BlockModel): readonly BodyPart[] {
    assert.equal(block.content.kind, 'parts');

    return block.content.kind === 'parts' ? block.content.parts : [];
  }

  /** The three text fields of Figma `431:12`. */
  const EMAIL_FIELDS = [
    field('from', 'ivan@example.com'),
    field('subject', 'Счёт за сентябрь'),
    field('text', 'Добрый день, счёт во вложении.'),
  ];

  /** The frame's `invoice.pdf`, 47.1 KB of bytes that are not UTF-8. */
  const INVOICE = `%PDF-1.7\n%\xe2\xe3\xcf\xd3\n${'\xff'.repeat(48_230 - 15)}`;

  it('draws a text body as its parts, in recorded order, under the caption', () => {
    const request = multipartRequest(multipartBytes(EMAIL_FIELDS));

    assert.equal(request.isBinary, false);
    assert.deepEqual(requestBodyBlock(request), {
      content: {
        kind: 'parts',
        parts: [
          {
            title: 'Part 1',
            name: 'from',
            summary: 'text · 16 B',
            headers: [['Content-Disposition', 'form-data; name="from"']],
            content: { kind: 'text', text: 'ivan@example.com' },
          },
          {
            title: 'Part 2',
            name: 'subject',
            summary: 'text · 30 B',
            headers: [['Content-Disposition', 'form-data; name="subject"']],
            content: { kind: 'text', text: 'Счёт за сентябрь' },
          },
          {
            title: 'Part 3',
            name: 'text',
            summary: 'text · 54 B',
            headers: [['Content-Disposition', 'form-data; name="text"']],
            content: { kind: 'text', text: 'Добрый день, счёт во вложении.' },
          },
        ],
      },
      caption: '3 parts, split at the boundary declared in Content-Type.',
    });
  });

  it('draws a binary body as its parts, split from the exact bytes of bodyBase64', () => {
    const request = multipartRequest(
      multipartBytes([
        ...EMAIL_FIELDS,
        file('attachment1', 'invoice.pdf', 'application/pdf', INVOICE),
      ]),
    );
    const block = requestBodyBlock(request);
    const parts = partsOf(block);

    assert.equal(request.isBinary, true);
    assert.equal(block.caption, '4 parts, split at the boundary declared in Content-Type.');
    assert.deepEqual(
      parts.map((part) => part.name),
      ['from', 'subject', 'text', 'attachment1'],
    );
    assert.deepEqual(parts[3], {
      title: 'Part 4',
      name: 'attachment1',
      summary: 'invoice.pdf · application/pdf · 47.1 KB',
      headers: [
        ['Content-Disposition', 'form-data; name="attachment1"; filename="invoice.pdf"'],
        ['Content-Type', 'application/pdf'],
      ],
      content: { kind: 'note', note: BINARY_NOTE },
    });
    // No copy control for the block: each part with content has its own.
    assert.equal(blockCopyText(block.content), '');
    assert.equal(isCopyable(block.content), false);
  });

  it('starts each box with Part N and its name, or Part N alone, and sizes its content in bytes', () => {
    const parts = partsOf(
      requestBodyBlock(
        multipartRequest(
          multipartBytes([
            { headers: [['Content-Type', 'text/plain']], content: 'x' },
            { headers: [['Content-Disposition', 'form-data; name=""']], content: 'y' },
            field('lines', 'a\r\nb\r\n'),
            field('kib', 'k'.repeat(1024)),
            field('almost', 'k'.repeat(1023)),
            field('multibyte', '✓'),
          ]),
        ),
      ),
    );

    assert.deepEqual(
      parts.map(({ title, name, summary }) => [title, name, summary]),
      [
        ['Part 1', null, 'text/plain · 1 B'],
        ['Part 2', null, 'text · 1 B'],
        ['Part 3', 'lines', 'text · 6 B'],
        ['Part 4', 'kib', 'text · 1.0 KB'],
        ['Part 5', 'almost', 'text · 1023 B'],
        ['Part 6', 'multibyte', 'text · 3 B'],
      ],
    );
  });

  it('says what each part is: its file name, its declared type, or text or binary', () => {
    const inner = `--inner\r\nContent-Type: text/plain\r\n\r\nplain\r\n--inner--`;
    const parts = partsOf(
      requestBodyBlock(
        multipartRequest(
          multipartBytes([
            field('from', 'ivan@example.com'),
            file('notes', 'notes.txt', 'text/plain', 'hello'),
            { headers: [['Content-Disposition', 'form-data; name="raw"']], content: '\xff\xfe' },
            { headers: [['Content-Type', 'image/png']], content: PNG },
            file('photo', 'photo.png', null, PNG),
            {
              headers: [['Content-Type', 'multipart/alternative; boundary=inner']],
              content: inner,
            },
            {
              headers: [['Content-Type', 'text/plain; charset=UTF-8']],
              content: 'typed',
            },
          ]),
        ),
      ),
    );

    assert.deepEqual(
      parts.map((part) => part.summary),
      [
        'text · 16 B',
        'notes.txt · text/plain · 5 B',
        'binary · 2 B',
        `image/png · ${PNG.length} B`,
        `photo.png · binary · ${PNG.length} B`,
        `multipart/alternative · ${inner.length} B`,
        'text/plain · 5 B',
      ],
    );
    // A file whose content is UTF-8 is shown, and copied, like any text part.
    assert.equal(partCopyText(parts[1] as BodyPart), 'hello');
  });

  /** Browsers and curl write `"` as `%22` and never escape a backslash (D164). */
  it('keeps a backslash in a file name, and reads \\" as a quote', () => {
    const summaries = partsOf(
      requestBodyBlock(
        multipartRequest(
          multipartBytes([
            file('f', 'a\\b.txt', 'text/plain', 'x'),
            file('g', 'say \\"hi\\".txt', 'text/plain', 'y'),
          ]),
        ),
      ),
    ).map((part) => part.summary);

    assert.deepEqual(summaries, ['a\\b.txt · text/plain · 1 B', 'say "hi".txt · text/plain · 1 B']);
  });

  it('shows UTF-8 content exactly as stored, JSON, XML and forms unformatted, and copies exactly that', () => {
    const stored = [
      '{"event":"paid","amount":12345678901234567890}',
      '<order><id>7</id></order>',
      'a=1&b=%D0%98+x',
      'line 1\r\n  line 2\r\n',
      '﻿with a byte-order mark',
    ];
    const parts = partsOf(
      requestBodyBlock(
        multipartRequest(multipartBytes(stored.map((text, index) => field(`p${index}`, text)))),
      ),
    );

    assert.deepEqual(
      parts.map((part) => part.content),
      stored.map((text) => ({ kind: 'text', text })),
    );
    assert.deepEqual(parts.map(partCopyText), stored);
  });

  it('describes a part that is not UTF-8 in place of its content, with no copy control', () => {
    const request = multipartRequest(
      multipartBytes([
        field('from', 'ivan@example.com'),
        file('logo', 'logo.png', 'image/png', PNG),
      ]),
    );
    const [text, png] = partsOf(requestBodyBlock(request));

    assert.equal(request.isBinary, true);
    assert.deepEqual(png?.content, { kind: 'note', note: BINARY_NOTE });
    assert.equal(partCopyText(png as BodyPart), null);
    assert.equal(png?.summary, `logo.png · image/png · ${PNG.length} B`);
    assert.equal(partCopyText(text as BodyPart), 'ivan@example.com');
  });

  it('draws a part with no content as a note, with no copy control', () => {
    const [empty] = partsOf(requestBodyBlock(multipartRequest(multipartBytes([field('e', '')]))));

    assert.equal(empty?.summary, 'text · 0 B');
    assert.deepEqual(empty?.content, { kind: 'note', note: 'No content.' });
    assert.equal(partCopyText(empty as BodyPart), null);
  });

  it('draws a text body it cannot split as before, and says why after the reason line', () => {
    const bytes = multipartBytes(EMAIL_FIELDS);
    const truncated = bytes.slice(0, bytes.lastIndexOf(`\r\n--${BOUNDARY}--`));
    const bareLf = bytes.replaceAll('\r\n', '\n');
    const cases: [RequestDetails, string][] = [
      [multipartRequest(bytes, 'multipart/form-data'), NO_BOUNDARY],
      [multipartRequest(bytes, 'multipart/form-data; boundary=""'), NO_BOUNDARY],
      [multipartRequest(bytes, 'multipart/form-data; boundary=other'), NO_DELIMITER],
      [multipartRequest(bareLf), NO_DELIMITER],
      [multipartRequest(truncated), NO_CLOSE],
    ];

    for (const [request, reason] of cases) {
      assert.deepEqual(
        requestBodyBlock(request),
        {
          content: { kind: 'text', text: request.body, wrap: 'flush' },
          caption: `${NOT_RECOGNISED} ${reason}`,
        },
        reason,
      );
    }
  });

  it('draws a binary body it cannot split as Base64, and says why after the Base64 line', () => {
    const bytes = multipartBytes([file('logo', 'logo.png', 'image/png', PNG)]);
    const cases: [RequestDetails, string][] = [
      [multipartRequest(bytes, 'multipart/form-data'), NO_BOUNDARY],
      [multipartRequest(bytes, 'multipart/form-data; boundary=other'), NO_DELIMITER],
      [multipartRequest(bytes.slice(0, bytes.lastIndexOf(`\r\n--${BOUNDARY}--`))), NO_CLOSE],
    ];

    for (const [request, reason] of cases) {
      assert.equal(request.isBinary, true);
      assert.deepEqual(
        requestBodyBlock(request),
        {
          content: { kind: 'text', text: request.bodyBase64, wrap: 'flush' },
          caption: `${BINARY_BODY} ${reason} ${WRAPPED}`,
        },
        reason,
      );
    }

    // Under another label, a binary body is exactly what it was.
    assert.deepEqual(requestBodyBlock(multipartRequest(bytes, 'application/octet-stream')), {
      content: { kind: 'text', text: btoa(bytes), wrap: 'flush' },
      caption: `${BINARY_BODY} ${WRAPPED}`,
    });
  });

  it('shows a part that is itself multipart as one part, not expanded', () => {
    const inner = [
      '--inner',
      'Content-Type: text/plain',
      '',
      'Plain text.',
      '--inner',
      'Content-Type: text/html',
      '',
      '<p>HTML.</p>',
      '--inner--',
    ].join('\r\n');
    const parts = partsOf(
      requestBodyBlock(
        multipartRequest(
          multipartBytes(
            [
              {
                headers: [['Content-Type', 'multipart/alternative; boundary=inner']],
                content: inner,
              },
              file('logo', 'logo.png', 'image/png', PNG),
            ],
            { boundary: 'outer' },
          ),
          'multipart/mixed; boundary=outer',
        ),
      ),
    );

    assert.equal(parts.length, 2);
    assert.deepEqual(parts[0]?.content, { kind: 'text', text: inner });
    assert.equal(parts[0]?.summary, `multipart/alternative · ${inner.length} B`);
  });

  it('mentions content before the first boundary or after the closing one in the caption', () => {
    const caption = (options: { preamble?: string; epilogue?: string }) =>
      requestBodyBlock(multipartRequest(multipartBytes([field('a', '1')], options))).caption;
    const split = '1 part, split at the boundary declared in Content-Type.';

    assert.equal(caption({}), split);
    assert.equal(
      caption({ preamble: 'This is a multi-part message in MIME format.' }),
      `${split} Content before the first boundary is in Raw, not in a part.`,
    );
    assert.equal(
      caption({ epilogue: 'Trailing text.' }),
      `${split} Content after the closing boundary is in Raw, not in a part.`,
    );
    assert.equal(
      caption({ preamble: 'Before.', epilogue: 'After.' }),
      `${split} Content before the first boundary and after the closing one is in Raw, not in a part.`,
    );
    // The CRLF before the first delimiter and after the closing one belong to them.
    assert.equal(
      requestBodyBlock(multipartRequest(`\r\n${multipartBytes([field('a', '1')])}`)).caption,
      split,
    );
  });

  it('splits at a quoted boundary, from a label in any case, and reads only the first Content-Type', () => {
    const boundary = "simple boundary'(1)";
    const bytes = multipartBytes([field('a', '1'), field('b', '2')], { boundary });
    const quoted = multipartRequest(bytes, `Multipart/Form-Data ; Boundary="${boundary}"`);
    const second = {
      ...quoted,
      headers: [
        ['Content-Type', 'text/plain'],
        ['Content-Type', `multipart/form-data; boundary="${boundary}"`],
      ] as [string, string][],
    };

    assert.equal(partsOf(requestBodyBlock(quoted)).length, 2);
    assert.deepEqual(requestBodyBlock(second), {
      content: { kind: 'text', text: quoted.body, wrap: 'flush' },
      caption: NOT_RECOGNISED,
    });
  });

  /** A header never overrides a successful sniff (D162), even where the body could be split. */
  it('renders a valid JSON body labelled multipart as JSON, and well-formed XML as XML', () => {
    const json = requestBodyBlock(multipartRequest('{"parts":[1,2]}'));
    // Well-formed XML whose text happens to be a multipart body at this boundary.
    const xml = requestBodyBlock(
      multipartRequest(`<a>\r\n--${BOUNDARY}\r\n\r\nx\r\n--${BOUNDARY}--\r\n</a>`),
    );

    assert.deepEqual(json, {
      content: { kind: 'text', text: '{\n  "parts": [\n    1,\n    2\n  ]\n}', wrap: 'hanging' },
      caption: null,
    });
    assert.equal(xml.content.kind, 'text');
    assert.equal(wrapOf(xml), 'hanging');
    assert.equal(xml.caption, null);
  });

  /**
   * Deep JSON was recognised too, so the label is not consulted (D169): the
   * body gets the JSON line alone, not the not-valid-JSON line with the reason
   * it was not split.
   */
  it('shows a body labelled multipart that is JSON nested past the limit with the JSON line', () => {
    const depth = JSON_MAX_DEPTH + 1;
    const body = `${'['.repeat(depth)}"--${BOUNDARY}"${']'.repeat(depth)}`;

    assert.deepEqual(requestBodyBlock(multipartRequest(body)), {
      content: { kind: 'text', text: body, wrap: 'flush' },
      caption: `${JSON_TOO_DEEP} ${WRAPPED}`,
    });
  });

  it('leaves Raw exactly as it was, for a text body and a binary one', () => {
    const text = multipartRequest(multipartBytes(EMAIL_FIELDS));
    const binary = multipartRequest(
      multipartBytes([...EMAIL_FIELDS, file('logo', 'logo.png', 'image/png', PNG)]),
    );
    const binaryRaw = requestRawBlock(binary);

    assert.equal(displayedAndCopied(requestRawBlock(text)), text.raw);
    assert.equal(displayedAndCopied(binaryRaw), `${binary.head}${binary.bodyBase64}`);
    assert.equal(binaryRaw.caption, `${BODY_BASE64} ${WRAPPED}`);
  });

  /**
   * The ceiling bounds what the parts view draws, not the files it does not
   * draw (D164). The large text is ASCII, so it is its own bytes.
   */
  it('splits a file upload of any size, and applies the ceiling to what it would draw', () => {
    const bigFile = multipartRequest(
      multipartBytes([
        field('from', 'ivan@example.com'),
        file('photo', 'photo.png', 'image/png', PNG + '\xff'.repeat(300 * 1024 - PNG.length)),
      ]),
    );
    const bigText = multipartRequest(
      multipartBytes([
        { ...field('text', ''), content: 'y'.repeat(JSON_FORMAT_MAX_BYTES) },
        file('logo', 'logo.png', 'image/png', PNG),
      ]),
    );
    const textOverCeiling = multipartRequest(
      multipartBytes([{ ...field('text', ''), content: 'y'.repeat(JSON_FORMAT_MAX_BYTES) }]),
    );

    assert.equal(
      partsOf(requestBodyBlock(bigFile))[1]?.summary,
      'photo.png · image/png · 300.0 KB',
    );
    assert.deepEqual(requestBodyBlock(bigText), {
      content: { kind: 'text', text: bigText.bodyBase64, wrap: 'flush' },
      caption: `${BINARY_BODY} ${TOO_LARGE} ${WRAPPED}`,
    });
    // A text body above the ceiling is never inspected, whatever its label (D162).
    assert.equal(textOverCeiling.isBinary, false);
    assert.deepEqual(requestBodyBlock(textOverCeiling), {
      content: { kind: 'text', text: textOverCeiling.body, wrap: 'flush' },
      caption: `${OVER_CEILING} ${WRAPPED}`,
    });
  });

  it('says where a line in a part wraps, in its content or its headers', () => {
    const content = requestBodyBlock(
      multipartRequest(multipartBytes([field('a', 'z'.repeat(200))])),
    );
    const header = requestBodyBlock(
      multipartRequest(multipartBytes([field(`n${'z'.repeat(200)}`, 'short')])),
    );

    assert.equal(
      content.caption,
      `1 part, split at the boundary declared in Content-Type. ${WRAPPED}`,
    );
    assert.equal(
      header.caption,
      `1 part, split at the boundary declared in Content-Type. ${WRAPPED}`,
    );
  });

  it('splits a multipart body a custom response configured its own Content-Type for (D179)', () => {
    const bytes = multipartBytes([field('status', 'failed'), field('code', '42')]);
    const block = responseBodyBlock(record({ headers: configuredHead(LABEL, bytes), body: bytes }));

    assert.deepEqual(partsOf(block).map(partCopyText), ['failed', '42']);
    assert.equal(block.caption, '2 parts, split at the boundary declared in Content-Type.');
  });

  it('draws a recorded response body labelled multipart the same way, HEAD included', () => {
    const bytes = multipartBytes([field('ok', '1'), field('id', '7')]);
    const headers: [string, string][] = [['Content-Type', LABEL]];
    const text = responseBodyBlock(record({ headers, body: bytes }));
    const head = responseBodyBlock(record({ headers, body: bytes, bodySuppressed: true }));
    const binaryBytes = multipartBytes([file('logo', 'logo.png', 'image/png', PNG)]);
    const binary = responseBodyBlock(
      record({ headers, body: null, bodyBase64: btoa(binaryBytes), isBinary: true }),
    );

    assert.deepEqual(partsOf(text).map(partCopyText), ['1', '7']);
    assert.equal(text.caption, '2 parts, split at the boundary declared in Content-Type.');
    assert.equal(
      head.caption,
      'Body not sent (HEAD). 2 parts, split at the boundary declared in Content-Type.',
    );
    assert.deepEqual(partsOf(binary)[0]?.content, { kind: 'note', note: BINARY_NOTE });
  });
});

describe('the response Body block of any configured Content-Type (D179)', () => {
  it('shows a body that is not JSON under the reason its text gives, whatever the label', () => {
    for (const [contentType, body, caption] of [
      ['application/json', '{"a":', NOT_JSON],
      [null, '{"a":', NOT_JSON],
      ['text/plain', "{'a':1}", NOT_JSON],
      ['text/plain', 'OK', NOT_RECOGNISED],
      ['text/html', '<h1>502 Bad Gateway', NOT_XML],
    ] as const) {
      const headers: [string, string][] =
        contentType === null
          ? [
              ['content-type', 'application/json; charset=utf-8'],
              ['content-length', String(body.length)],
            ]
          : configuredHead(contentType, body);
      const block = responseBodyBlock(record({ headers, body, bodySize: body.length }));

      assert.deepEqual(block.content, { kind: 'text', text: body, wrap: 'flush' }, body);
      assert.equal(block.caption, caption, body);
    }
  });

  it('indents XML and JSON whatever Content-Type was configured', () => {
    const soap = '<Envelope><Body><ok/></Body></Envelope>';
    const xml = responseBodyBlock(
      record({ headers: configuredHead('text/xml', soap), body: soap }),
    );
    const json = responseBodyBlock(
      record({ headers: configuredHead('text/plain', '{"a":1}'), body: '{"a":1}' }),
    );

    assert.equal(xml.content.kind, 'text');
    assert.equal(xml.caption, null);
    assert.deepEqual(json.content, { kind: 'text', text: '{\n  "a": 1\n}', wrap: 'hanging' });
  });
});

describe('the response Body block', () => {
  it('re-indents the recorded body on exactly the request side rules', () => {
    const block = responseBodyBlock(record());

    assert.deepEqual(block.content, {
      kind: 'text',
      text: '{\n  "ok": true,\n  "requestId": "2b906b89"\n}',
      wrap: 'hanging',
    });
    assert.equal(block.caption, null);
  });

  it('shows a recorded body nested past the limit as stored, on the request side rules', () => {
    const depth = JSON_MAX_DEPTH + 1;
    const body = `${'['.repeat(depth)}1${']'.repeat(depth)}`;
    const block = responseBodyBlock(record({ body, bodySize: body.length }));

    assert.deepEqual(block.content, { kind: 'text', text: body, wrap: 'flush' });
    assert.equal(block.caption, `${JSON_TOO_DEEP} ${WRAPPED}`);
  });

  it('says a 204 carries no response body', () => {
    const block = responseBodyBlock(record({ status: 204, body: null, bodySize: 0 }));

    assert.deepEqual(block.content, { kind: 'empty', placeholder: 'No response body' });
    assert.equal(block.caption, 'HTTP 204 does not include a response body.');
    assert.equal(isCopyable(block.content), false);
  });

  it('says a custom response was configured without a body', () => {
    const block = responseBodyBlock(record({ status: 200, body: null, bodySize: 0 }));

    assert.deepEqual(block.content, { kind: 'empty', placeholder: 'No response body' });
    assert.equal(block.caption, 'This custom response was configured without a body.');
  });

  it('shows a stored HEAD body and says it was not sent', () => {
    const block = responseBodyBlock(record({ bodySuppressed: true }));

    assert.equal(block.caption, 'Body not sent (HEAD).');
    assert.ok(blockCopyText(block.content).includes('"ok": true'));
  });
});

describe('what the copy control yields', () => {
  /**
   * `Body` copies the text as displayed, not the stored original: formatting is
   * the point of that view, and copying the unformatted original from a
   * formatted view would hand back something other than what was on screen.
   */
  it('copies the formatted Body text rather than the stored original', () => {
    const stored = '{"runId":9007199254740993}';
    const body = requestBodyBlock(details({ body: stored }));
    const raw = requestRawBlock(details());

    assert.notEqual(blockCopyText(body.content), stored);
    assert.equal(blockCopyText(body.content), '{\n  "runId": 9007199254740993\n}');
    assert.equal(blockCopyText(raw.content), RAW_REQUEST);
  });

  /**
   * The whole block, never the visible fragment and never the breaks drawn on
   * screen. A body hundreds of lines long, every line of it wrapped several
   * times over, yields every stored line and every column of it.
   */
  it('yields the whole block, however long it is and however it wraps', () => {
    const entries = Array.from(
      { length: 400 },
      (_unused, index) => `"k${index}":"${'v'.repeat(300)}"`,
    );
    const block = requestBodyBlock(details({ body: `{${entries.join(',')}}` }));
    const copied = blockCopyText(block.content);
    const lines = copied.split('\n');

    assert.equal(lines.length, 402);
    assert.ok(lines.some((line) => line.length > 300));
    assert.ok(copied.includes('"k0"'));
    assert.ok(copied.includes('"k399"'));
  });

  it('marks an empty block as not copyable rather than copying an empty string', () => {
    assert.equal(isCopyable({ kind: 'empty', placeholder: 'No request body' }), false);
    assert.equal(isCopyable({ kind: 'text', text: '', wrap: 'flush' }), false);
    assert.equal(isCopyable({ kind: 'pairs', pairs: [], separator: ': ' }), false);
    assert.equal(isCopyable({ kind: 'text', text: 'x', wrap: 'flush' }), true);
  });
});

describe('how every block wraps', () => {
  /**
   * The rule, once: every block wraps, and nothing in the panel scrolls
   * sideways (D134, D149). `wrap` says where a continuation starts - hanging
   * under re-indented JSON, flush everywhere else - and is asserted rather
   * than a class in `CodeBlock`, which is the seam that makes this checkable
   * without a DOM (D070, D114).
   */

  it('wraps a body too large to be re-indented, and still copies all of it', () => {
    const body = `{"a":"${'x'.repeat(JSON_FORMAT_MAX_BYTES)}"}`;
    const block = requestBodyBlock(details({ body }));

    assert.equal(wrapOf(block), 'flush');
    assert.equal(blockCopyText(block.content), body);
  });

  it('wraps every Base64 rendering, including one far below the ceiling', () => {
    const small = requestBodyBlock(details({ isBinary: true, body: null, bodyBase64: 'AAECA/8=' }));
    const large = responseBodyBlock(
      record({ isBinary: true, body: null, bodyBase64: 'QUFB'.repeat(4096) }),
    );

    assert.equal(wrapOf(small), 'flush');
    assert.equal(wrapOf(large), 'flush');
    // Nothing is wider than the block, so the small one has nothing to add.
    assert.equal(small.caption, 'Binary body shown as Base64. JSON formatting is unavailable.');
    assert.equal(
      large.caption,
      `Binary body shown as Base64. JSON formatting is unavailable. ${WRAPPED}`,
    );
  });

  /** `Raw` on both halves, a Base64 body part (D145) and the fallback included. */
  it('wraps Raw on both halves, text and Base64 alike, flush with the edge', () => {
    const request = btoa(
      composeHead('POST /s/session HTTP/1.1', [['Host', 'qa-tools.ru']]) + '\xff',
    );
    const response = btoa(composeHead('HTTP/1.1 200 OK', [['content-length', '1']]) + '\xff');

    assert.equal(wrapOf(requestRawBlock(details())), 'flush');
    assert.equal(wrapOf(responseRawBlock(record())), 'flush');
    assert.equal(
      wrapOf(requestRawBlock(details({ isRawBinary: true, raw: null, rawBase64: request }))),
      'flush',
    );
    assert.equal(
      wrapOf(responseRawBlock(record({ isRawBinary: true, raw: null, rawBase64: response }))),
      'flush',
    );
    assert.equal(
      wrapOf(requestRawBlock(details({ isRawBinary: true, raw: null, rawBase64: 'U0ZS' }))),
      'flush',
    );
  });

  it('wraps a body that is not JSON at all, flush with the edge', () => {
    assert.equal(
      wrapOf(requestBodyBlock(details({ body: 'event=test.completed&run=9' }))),
      'flush',
    );
  });

  /**
   * Issue #26: re-indented JSON wraps too, with its
   * continuation hanging under the line's own content, and its text - numbers,
   * duplicate keys, escapes - is exactly what it was (D112).
   */
  it('wraps a re-indented body with a hanging indent, its text unchanged', () => {
    const long = 'a'.repeat(200);
    const stored = `{"callback":"${long}","n":1.50,"n":12345678901234567890,"e":"\\u00e9\\n"}`;
    const block = requestBodyBlock(details({ body: stored }));

    assert.equal(wrapOf(block), 'hanging');
    assert.equal(block.caption, WRAPPED);
    assert.equal(
      blockCopyText(block.content),
      [
        '{',
        `  "callback": "${long}",`,
        '  "n": 1.50,',
        '  "n": 12345678901234567890,',
        '  "e": "\\u00e9\\n"',
        '}',
      ].join('\n'),
    );
  });

  /** A name/value grid keeps its rows; a long value wraps in its own column. */
  it('keeps Headers and Query as rows, and says so where a value wraps', () => {
    const headers: [string, string][] = [['X-Signature', `v1=${'0'.repeat(200)}`]];
    const block = requestHeadersBlock(details({ headers }));

    assert.deepEqual(block, {
      content: { kind: 'pairs', pairs: headers, separator: ': ' },
      caption: `${REQUEST_HEADERS} ${WRAPPED}`,
    });

    const query = requestQueryBlock(
      details({ queryString: `source=demo&state=${'q'.repeat(3700)}` }),
    );

    assert.equal(query.content.kind, 'pairs');
    assert.equal(query.caption, `Query parameters belong to the incoming request. ${WRAPPED}`);
    assert.equal(
      requestQueryBlock(details()).caption,
      'Query parameters belong to the incoming request.',
    );
  });

  /**
   * The rows share their columns. A short name beside a long one gets the
   * narrower value column too, so its value wraps where `name: value` alone
   * would still fit - and the caption has to say so.
   */
  it('measures a value against the widest name in the block, not its own', () => {
    const value = 'v'.repeat(80);
    const alone = requestHeadersBlock(details({ headers: [['Host', value]] }));
    const beside = requestHeadersBlock(
      details({
        headers: [
          ['Host', value],
          ['X-A-Rather-Long-Header-Name-Here', '1'],
        ],
      }),
    );

    assert.ok(`Host: ${value}`.length < 110);
    assert.equal(alone.caption, REQUEST_HEADERS);
    assert.equal(beside.caption, `${REQUEST_HEADERS} ${WRAPPED}`);
  });

  /** A name past 40% of the box wraps in its own column, and that is a wrap too. */
  it('says a name too long for its column wraps', () => {
    const name = `X-${'N'.repeat(50)}`;

    assert.equal(
      requestHeadersBlock(details({ headers: [[name, '1']] })).caption,
      `${REQUEST_HEADERS} ${WRAPPED}`,
    );
  });

  /**
   * The two sideways captions are retired everywhere (D149): nothing in the
   * panel scrolls sideways, whatever the block holds.
   */
  it('never says anything scrolls, on any block, however long its lines', () => {
    const long = 'w'.repeat(400);
    const blocks = [
      requestRawBlock(details({ raw: `POST / HTTP/1.1\nX: ${long}` })),
      requestBodyBlock(details({ body: `{"a":"${long}"}` })),
      requestBodyBlock(details({ body: long })),
      requestHeadersBlock(details({ headers: [['X', long]] })),
      requestQueryBlock(details({ queryString: `a=${long}` })),
      responseRawBlock(record({ raw: `HTTP/1.1 200 OK\nX: ${long}` })),
      responseBodyBlock(record({ body: `{"a":"${long}"}` })),
      responseHeadersBlock(record({ headers: [['X', long]] })),
    ];

    for (const block of blocks) {
      assert.ok(block.caption?.endsWith(WRAPPED), block.caption ?? 'no caption');
      assert.doesNotMatch(block.caption ?? '', /scroll/i);
    }
  });

  /**
   * The wrapping line is not a permanent label: it appears where a line really
   * is too wide for the block.
   */
  it('mentions wrapping only where a line does not fit, and keeps the block reason', () => {
    const short = requestBodyBlock(details({ body: 'not json' }));
    const wide = requestBodyBlock(details({ body: `not json ${'x'.repeat(200)}` }));

    // Plain text claims no format, so its reason is the neutral one (D163).
    assert.equal(short.caption, NOT_RECOGNISED);
    assert.equal(wide.caption, `${NOT_RECOGNISED} ${WRAPPED}`);
  });

  /**
   * The wrapping line stands alone where the block had nothing else to say: an
   * ordinary large captured request, whose `Raw` has no caption of its own, and
   * a re-indented body with a long value.
   */
  it('gives a block with nothing else to say the wrapping line on its own', () => {
    const raw = `POST /s/session HTTP/1.1\nHost: qa-tools.ru\n\n{"payload":"${'z'.repeat(200)}"}`;
    const block = requestRawBlock(details({ raw, sourceIp: '145.40.74.12' }));

    assert.equal(wrapOf(block), 'flush');
    assert.equal(block.caption, WRAPPED);
    // The control: the same block says nothing where every line fits.
    assert.equal(requestRawBlock(details({ sourceIp: '145.40.74.12' })).caption, null);
  });

  /** The HEAD line replaces the formatting reason and keeps the wrapping one. */
  it('keeps the wrapping line under a stored HEAD body that wraps, re-indented or not', () => {
    const suppressed = responseBodyBlock(
      record({ bodySuppressed: true, body: `plain text ${'y'.repeat(200)}` }),
    );
    const reindented = responseBodyBlock(
      record({ bodySuppressed: true, body: `{"note":"${'y'.repeat(200)}"}` }),
    );

    assert.equal(wrapOf(suppressed), 'flush');
    assert.equal(suppressed.caption, `Body not sent (HEAD). ${WRAPPED}`);
    assert.equal(wrapOf(reindented), 'hanging');
    assert.equal(reindented.caption, `Body not sent (HEAD). ${WRAPPED}`);
    // A re-indented HEAD body of short lines says only that it was not sent.
    assert.equal(
      responseBodyBlock(record({ bodySuppressed: true })).caption,
      'Body not sent (HEAD).',
    );
  });
});

/**
 * How `CodeBlock` draws re-indented JSON (D149). The component only turns
 * these runs into elements, so the hanging indent itself - where a
 * continuation starts - is decided and asserted here.
 */
describe('the hanging indent of re-indented JSON', () => {
  /** A box 114 columns wide: the text column of a 1440 px window. */
  const WIDE = 114;
  /** A box 57 columns wide: the text column of a 1024 px window. */
  const NARROW = 57;

  function formatted(stored: string): string {
    const result = formatJsonForDisplay(stored);

    assert.equal(result.status, 'formatted');

    return result.status === 'formatted' ? result.text : '';
  }

  /** Nothing is added or dropped: the copy text is what the runs draw (D122). */
  it('draws exactly the text the copy control yields, indentation included', () => {
    const text = formatted(
      `{"a":{"b":["${'x'.repeat(120)}",1,2,{"c":"${'short '.repeat(30)}"}]},"d":true}`,
    );

    for (const columns of [WIDE, NARROW, 20]) {
      assert.equal(
        hangingRuns(text, columns)
          .map((run) => run.text)
          .join('\n'),
        text,
      );
    }

    assert.equal(blockCopyText(requestBodyBlock(details({ body: text })).content), text);
  });

  /**
   * A run is named by its first stored line, whatever the width, so a redraw
   * for another width keeps the elements of the lines it does not change - the
   * browser's scroll anchoring keeps the reader's place by them (D149).
   */
  it('names each run by the index of its first stored line, at any width', () => {
    const text = formatted(
      `{"a":{"b":["${'x'.repeat(120)}",1,2,{"c":"${'short '.repeat(30)}"}]},"d":true}`,
    );
    const lines = text.split('\n');

    for (const columns of [WIDE, NARROW, 20]) {
      for (const run of hangingRuns(text, columns)) {
        assert.equal(run.text.split('\n')[0], lines[run.line]);
      }
    }

    const long = hangingRuns(text, WIDE).find((run) => run.text.includes('xxx'));

    assert.equal(
      long?.line,
      hangingRuns(text, NARROW).find((run) => run.text.includes('xxx'))?.line,
    );
  });

  it('starts a continuation two columns deeper than its own line', () => {
    const text = formatted(`{"a":{"b":{"note":"${'n'.repeat(120)}"}}}`);
    const long = hangingRuns(text, WIDE).find((run) => run.hang !== null);

    assert.equal(HANGING_INDENT_COLUMNS, 2);
    assert.ok(long);
    assert.ok(long.text.startsWith(`      "note": "`));
    assert.equal(long.hang, 6 + HANGING_INDENT_COLUMNS);
  });

  /**
   * The documented departure from "two characters deeper" (D149): a hang may
   * not leave its continuation fewer than 16 columns, or the line would run
   * out of the box sideways. In a 1440 px window that is past 48 levels, in a
   * 1024 px one past 19.
   */
  it('keeps two columns deeper while the box has room, and stops short of its edge after', () => {
    const nested = (depth: number) => {
      let stored = `"${'d'.repeat(200)}"`;

      for (let level = 0; level < depth; level += 1) {
        stored = `[${stored}]`;
      }

      return formatted(stored);
    };
    const hangAt = (depth: number, columns: number) =>
      hangingRuns(nested(depth), columns).find((run) => run.text.includes('ddd'))?.hang;

    assert.equal(hangAt(48, WIDE), 96 + HANGING_INDENT_COLUMNS);
    assert.equal(hangAt(49, WIDE), WIDE - MIN_CONTINUATION_COLUMNS);
    assert.equal(hangAt(60, WIDE), WIDE - MIN_CONTINUATION_COLUMNS);
    assert.equal(hangAt(19, NARROW), 38 + HANGING_INDENT_COLUMNS);
    assert.equal(hangAt(20, NARROW), NARROW - MIN_CONTINUATION_COLUMNS);
  });

  /**
   * Lines that fit the box are drawn together as plain text: an array of
   * numbers just under the ceiling is one run, not a hundred thousand elements.
   */
  it('draws consecutive lines that fit as one run with no hanging indent', () => {
    const text = formatted(`[${'1,'.repeat(50_000)}1]`);
    const runs = hangingRuns(text, NARROW);

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.hang, null);
    assert.equal(runs[0]?.text, text);
  });

  /**
   * Which lines fit is decided by the box, not by a fixed width: short members
   * nested seventeen levels deep are 42 columns long by their indentation
   * alone, and fit a wide box as one run.
   */
  it('decides by the box which lines are drawn on their own', () => {
    const text = formatted(`${'['.repeat(17)}${'{"a":1},'.repeat(200)}{"a":1}${']'.repeat(17)}`);

    assert.equal(hangingRuns(text, WIDE).length, 1);
    assert.equal(hangingRuns(text, 40).filter((run) => run.hang !== null).length, 201);
  });

  it('gives a line exactly as wide as the box no run of its own, and one column more one', () => {
    const fits = `{"k":"${'s'.repeat(NARROW - '  "k": "",'.length)}","z":1}`;
    const over = `{"k":"${'s'.repeat(NARROW - '  "k": "",'.length + 1)}","z":1}`;

    assert.equal(hangingRuns(formatted(fits), NARROW).length, 1);
    assert.equal(hangingRuns(formatted(over), NARROW).length, 3);
  });

  /** A wide character is two columns, so the count is not the line's length. */
  it('counts a wide character as two columns when deciding a line fits', () => {
    const text = formatted(`{"k":"${'\u6587'.repeat(30)}"}`);

    assert.ok(text.split('\n')[1]!.length < NARROW);
    assert.equal(hangingRuns(text, NARROW).length, 3);
  });

  /**
   * A value too long for its row starts beside its key, as the design draws
   * it, rather than on the row below: the key, `: ` and the value's first
   * character are kept together.
   */
  it('keeps a key with the first character of its value', () => {
    const run = hangingRuns(formatted(`{"signature":"t=${'f'.repeat(200)}"}`), WIDE)[1];

    assert.ok(run);
    assert.equal(run.text.slice(0, run.keep), '  "signature": "');
    assert.equal(run.hang, 4);
  });

  it('reads a key with an escaped quote in it to its real end', () => {
    const run = hangingRuns(formatted(`{"say \\"hi\\"":${'9'.repeat(120)}}`), WIDE)[1];

    assert.ok(run);
    assert.equal(run.text.slice(0, run.keep), '  "say \\"hi\\"": 9');
  });

  /**
   * An element has no key, and a start wider than `KEPT_KEY_COLUMNS` is not
   * kept: then the key may end its row alone and the value start on the next.
   */
  it('keeps nothing together on an array element, or where the key is too long to keep', () => {
    const element = hangingRuns(formatted(`["${'e'.repeat(120)}"]`), WIDE)[1];
    const longKey = hangingRuns(formatted(`{"${'k'.repeat(60)}":${'1'.repeat(80)}}`), WIDE)[1];
    const keptKey = hangingRuns(formatted(`{"${'k'.repeat(40)}":${'1'.repeat(80)}}`), WIDE)[1];

    assert.equal(element?.keep, 0);
    assert.equal(longKey?.keep, 0);
    assert.equal(keptKey?.keep, 2 + 42 + 3);
  });

  /**
   * How many stored lines the runs draw, given how a browser lays them out: a
   * line that wraps is a block of its own, one stored line however many rows it
   * takes, and a run of text draws a row for every line in it except after a
   * break at its very end, which makes no row of its own. `HangingText` in
   * `CodeBlock` draws exactly `drawn` for a run of text.
   */
  function storedLinesDrawn(runs: readonly HangingRun[]): number {
    return runs.reduce((total, run) => {
      if (run.hang !== null) {
        return total + 1;
      }

      const rows = run.drawn.split('\n').length;

      return total + (run.drawn === '' ? 0 : run.drawn.endsWith('\n') ? rows - 1 : rows);
    }, 0);
  }

  /**
   * Issue #28: XML shown as stored can hold empty lines, and one
   * between two lines that wrap, or after a short line before one that does,
   * was drawn as no row at all. `drawn` keeps it; the copy text is unchanged.
   */
  it('keeps an empty line on screen between two lines that wrap', () => {
    const long = 'x'.repeat(200);
    const text = ['<note>', `  <p xml:space="preserve">${long}`, '', `${long}</p>`, '</note>'].join(
      '\n',
    );
    const runs = hangingRuns(text, WIDE);

    assert.deepEqual(
      runs.map((run) => [run.text, run.drawn, run.hang === null]),
      [
        ['<note>', '<note>\n', true],
        [`  <p xml:space="preserve">${long}`, `  <p xml:space="preserve">${long}`, false],
        ['', '\n', true],
        [`${long}</p>`, `${long}</p>`, false],
        ['</note>', '</note>', true],
      ],
    );
    assert.equal(runs.map((run) => run.text).join('\n'), text);
    assert.equal(storedLinesDrawn(runs), 5);
  });

  it('keeps an empty line after a short line, before a line that wraps', () => {
    const text = ['<a>short', '', `${'y'.repeat(200)}</a>`].join('\n');
    const runs = hangingRuns(text, WIDE);

    assert.equal(runs[0]?.text, '<a>short\n');
    assert.equal(runs[0]?.drawn, '<a>short\n\n');
    assert.equal(storedLinesDrawn(runs), 3);
  });

  it('keeps empty lines stored with CRLF, and every count of them, on screen', () => {
    const long = 'z'.repeat(200);

    for (const text of [
      `<a>${long}\r\n\r\n${long}</a>`,
      `<a>${long}\n\n\n${long}</a>`,
      `<a>one\n\n\n${long}\n\ntwo</a>`,
      `<a>${long}\n${long}\nthree\n${long}</a>`,
    ]) {
      for (const columns of [WIDE, NARROW]) {
        const runs = hangingRuns(text, columns);

        assert.equal(runs.map((run) => run.text).join('\n'), text);
        assert.equal(storedLinesDrawn(runs), text.split('\n').length, JSON.stringify(text));
      }
    }
  });

  /**
   * A tab draws up to eight columns wide, so a line of tabs that is short in
   * characters can still be too wide for the box: it gets its hanging indent
   * and the wrapping line, like any other line that wraps.
   */
  it('counts a tab as up to eight columns when deciding a line fits', () => {
    const tabbed = `${'\t'.repeat(10)}x`;
    const text = ['<a>', tabbed, '</a>'].join('\n');

    assert.ok(tabbed.length * 2 <= NARROW);
    assert.equal(hangingRuns(text, NARROW)[1]?.hang, HANGING_INDENT_COLUMNS);
    assert.equal(
      requestBodyBlock(details({ body: `<a>${'\t'.repeat(20)}x</a>` })).caption,
      WRAPPED,
    );
  });

  it('keeps no key together whose start is wide only by its tabs', () => {
    const line = `"${'\t'.repeat(30)}": ${'9'.repeat(200)}`;
    const run = hangingRuns(['<a>', line, '</a>'].join('\n'), WIDE)[1];

    assert.equal(run?.hang, HANGING_INDENT_COLUMNS);
    assert.equal(run?.keep, 0);
  });

  /**
   * The CSS clamps the hang against the box as it is now, not as it was last
   * measured: a frame after the window narrows, the runs are the old ones, and
   * without the clamp a deep line was drawn out of the box (D149). Both halves
   * are the same length, so the first row still starts at the edge.
   */
  it('clamps the hanging indent in CSS against the box itself', () => {
    const column = 'min(12ch, max(0px, calc(100cqi - 16ch)))';

    assert.equal(MIN_CONTINUATION_COLUMNS, 16);
    assert.deepEqual(hangingIndentStyle(12), {
      paddingLeft: column,
      textIndent: `calc(-1 * ${column})`,
    });
  });

  /**
   * A key's unbroken start may be at most `KEPT_KEY_COLUMNS` wide, and
   * `CodeBlock` lets it break in any box narrower than that through a container
   * query that has to name the same number. A class name cannot be built from
   * the constant - Tailwind reads it from the source - so the source is read.
   */
  it('names the same width in the model and in the container query that lets a key break', () => {
    const component = readFileSync(new URL('../components/CodeBlock.tsx', import.meta.url), 'utf8');

    assert.equal(KEPT_KEY_COLUMNS, 56);
    assert.ok(component.includes(`@max-[${KEPT_KEY_COLUMNS}ch]:whitespace-pre-wrap`));
    assert.ok(component.includes('@container'));
  });
});

/** Reads `wrap` off a block that has to be one run of text to have one. */
function wrapOf(block: BlockModel): TextWrap | null {
  assert.equal(block.content.kind, 'text');

  return block.content.kind === 'text' ? block.content.wrap : null;
}

/**
 * The text a block displays, once it is checked that copying yields exactly
 * that text (D122) - which is every text block but `Raw` of a head with no
 * body (D158), read with `shownAndCopied`.
 */
function displayedAndCopied(block: BlockModel): string {
  const { shown, copied } = shownAndCopied(block);

  assert.equal(copied, shown);

  return shown;
}

/** What a text block draws on the screen, and what its copy control yields. */
function shownAndCopied(block: BlockModel): { shown: string; copied: string } {
  assert.equal(block.content.kind, 'text');

  return block.content.kind === 'text'
    ? { shown: textOnScreen(block.content), copied: blockCopyText(block.content) }
    : { shown: '', copied: '' };
}

/**
 * A head as `composeRawRequest` and `composeRawResponse` write one: the first
 * line and a `name: value` line per header, each ending in CRLF, then a blank
 * line. The backend writes it one byte per character, so the string is already
 * the bytes as `btoa` takes them.
 */
function composeHead(firstLine: string, headers: readonly (readonly [string, string])[]): string {
  const lines = [firstLine, ...headers.map(([name, value]) => `${name}: ${value}`)];

  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** Text as its UTF-8 bytes, one character per byte, as `btoa` takes them. */
function utf8Bytes(text: string): string {
  return String.fromCharCode(...new TextEncoder().encode(text));
}
