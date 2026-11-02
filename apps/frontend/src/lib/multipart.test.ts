/**
 * The multipart splitter on its own (D164): the label it reads, the delimiter
 * rules of RFC 2046 on bytes, and what it reads off each part. What the Body
 * tab draws from a split is in `detail-view.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  multipartLabel,
  parseHeaderValue,
  splitMultipart,
  type MultipartPart,
  type MultipartSplit,
} from './multipart.ts';

const BOUNDARY = '------------------------d74496d66958873e';

/** Text as its UTF-8 bytes, one character per byte. */
function utf8Bytes(text: string): string {
  return String.fromCharCode(...new TextEncoder().encode(text));
}

/** The parts of a split that must have succeeded. */
function partsOf(split: MultipartSplit): MultipartPart[] {
  assert.equal(split.status, 'split');

  return split.status === 'split' ? split.parts : [];
}

describe('multipartLabel', () => {
  it('reads nothing off a Content-Type that is not multipart, or off none', () => {
    for (const value of [null, 'text/plain', 'application/json; boundary=x', 'multipartx/y']) {
      assert.deepEqual(multipartLabel(value), { kind: 'not-multipart' }, String(value));
    }
  });

  it('matches the media type and the parameter name in any case, and keeps the boundary as written', () => {
    assert.deepEqual(multipartLabel('Multipart/Form-Data; BOUNDARY=AbC'), {
      kind: 'boundary',
      boundary: 'AbC',
    });
    assert.deepEqual(multipartLabel('multipart/mixed;boundary=x'), {
      kind: 'boundary',
      boundary: 'x',
    });
  });

  it('reads a quoted boundary with its spaces and separators, and white space around it', () => {
    assert.deepEqual(
      multipartLabel('multipart/form-data ;  boundary = "a b;c=d" ; charset=utf-8'),
      {
        kind: 'boundary',
        boundary: 'a b;c=d',
      },
    );
  });

  it('takes the first boundary parameter where there are several', () => {
    assert.deepEqual(multipartLabel('multipart/form-data; boundary=one; boundary=two'), {
      kind: 'boundary',
      boundary: 'one',
    });
  });

  it('says a multipart type without a boundary, or with an empty one, has none', () => {
    for (const value of [
      'multipart/form-data',
      'multipart/form-data; charset=utf-8',
      'multipart/form-data; boundary=',
      'multipart/form-data; boundary=""',
      'multipart/form-data; boundary',
    ]) {
      assert.deepEqual(multipartLabel(value), { kind: 'no-boundary' }, value);
    }
  });
});

describe('parseHeaderValue', () => {
  it('resolves quoted pairs, keeps ; inside quotes, and skips a parameter with no value', () => {
    assert.deepEqual(parseHeaderValue('form-data; flag; name="a\\"b;c"; filename=x.txt'), {
      value: 'form-data',
      parameters: [
        ['name', 'a"b;c'],
        ['filename', 'x.txt'],
      ],
    });
  });

  /** Browsers and curl write `"` as `%22` and never escape a backslash (D164). */
  it('unescapes only \\" and \\\\ inside quotes, and keeps every other backslash', () => {
    const quoted = (header: string) => parseHeaderValue(`form-data; name=${header}`).parameters;

    assert.deepEqual(quoted('"a\\b.txt"'), [['name', 'a\\b.txt']]);
    assert.deepEqual(quoted('"a\\"b"'), [['name', 'a"b']]);
    assert.deepEqual(quoted('"a\\\\b"'), [['name', 'a\\b']]);
    assert.deepEqual(quoted('"C:\\fakepath\\n.txt"; x=1'), [
      ['name', 'C:\\fakepath\\n.txt'],
      ['x', '1'],
    ]);
  });

  it('runs an unterminated quote to the end rather than failing', () => {
    assert.deepEqual(parseHeaderValue('form-data; name="abc'), {
      value: 'form-data',
      parameters: [['name', 'abc']],
    });
  });
});

describe('splitMultipart', () => {
  /** What `curl -F from=… -F subject=…` sends. */
  const CURL = [
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="from"',
    '',
    'ivan@example.com',
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="subject"',
    '',
    utf8Bytes('Счёт за сентябрь'),
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n');

  it('splits at the boundary, in order, with each part exactly as it arrived', () => {
    const split = splitMultipart(CURL, BOUNDARY);

    assert.deepEqual(split, {
      status: 'split',
      parts: [
        {
          headers: [['Content-Disposition', 'form-data; name="from"']],
          name: 'from',
          filename: null,
          contentType: null,
          size: 16,
          text: 'ivan@example.com',
        },
        {
          headers: [['Content-Disposition', 'form-data; name="subject"']],
          name: 'subject',
          filename: null,
          contentType: null,
          size: 30,
          text: 'Счёт за сентябрь',
        },
      ],
      preambleBytes: 0,
      epilogueBytes: 0,
    });
  });

  it('keeps line breaks inside a part and gives the CRLF before a delimiter to the delimiter', () => {
    const body = ['--b', '', 'line 1', 'line 2', '', '--b--'].join('\r\n');
    const [part] = partsOf(splitMultipart(body, 'b'));

    assert.equal(part?.text, 'line 1\r\nline 2\r\n');
    assert.equal(part?.size, 16);
  });

  it('counts a preamble, and not the CRLF that belongs to the first delimiter', () => {
    const withText = splitMultipart('This is a preamble.\r\n--b\r\n\r\nx\r\n--b--', 'b');
    const withLineBreak = splitMultipart('\r\n--b\r\n\r\nx\r\n--b--', 'b');

    assert.equal(withText.status === 'split' && withText.preambleBytes, 19);
    assert.equal(withLineBreak.status === 'split' && withLineBreak.preambleBytes, 0);
  });

  it('counts an epilogue after the closing line, and not the CRLF that ends it', () => {
    const trailing = splitMultipart('--b\r\n\r\nx\r\n--b--\r\n', 'b');
    const epilogue = splitMultipart('--b\r\n\r\nx\r\n--b--\r\nThe end.\r\n', 'b');
    const unterminated = splitMultipart('--b\r\n\r\nx\r\n--b--', 'b');

    assert.equal(trailing.status === 'split' && trailing.epilogueBytes, 0);
    assert.equal(epilogue.status === 'split' && epilogue.epilogueBytes, 10);
    assert.equal(unterminated.status === 'split' && unterminated.epilogueBytes, 0);
  });

  it('allows transport padding after a delimiter and after the closing one', () => {
    const parts = partsOf(
      splitMultipart('--b \t\r\n\r\none\r\n--b  \r\n\r\ntwo\r\n--b-- \r\n', 'b'),
    );

    assert.deepEqual(
      parts.map((part) => part.text),
      ['one', 'two'],
    );
  });

  it('does not take the boundary followed by anything else for a delimiter', () => {
    const body = '--b\r\n\r\n--bx\r\n--b-x\r\n--b x\r\n--b--x\r\n--b--\r\n';
    const parts = partsOf(splitMultipart(body, 'b'));

    assert.equal(parts.length, 1);
    assert.equal(parts[0]?.text, '--bx\r\n--b-x\r\n--b x\r\n--b--x');
    assert.deepEqual(parts[0]?.headers, []);
  });

  it('never infers the boundary: the declared one alone splits', () => {
    const body = '--other\r\n\r\nx\r\n--other--\r\n';

    assert.deepEqual(splitMultipart(body, 'b'), { status: 'no-delimiter' });
  });

  it('says the boundary never starts a part where it never occurs, or only closes', () => {
    assert.deepEqual(splitMultipart('hello', 'b'), { status: 'no-delimiter' });
    assert.deepEqual(splitMultipart('--b--\r\n', 'b'), { status: 'no-delimiter' });
    assert.deepEqual(splitMultipart('preamble\r\n--b--', 'b'), { status: 'no-delimiter' });
  });

  it('splits CRLF only: a body written with bare LF has no delimiter line', () => {
    const body = ['--b', 'Content-Disposition: form-data; name="a"', '', '1', '--b--', ''].join(
      '\n',
    );

    assert.deepEqual(splitMultipart(body, 'b'), { status: 'no-delimiter' });
  });

  it('says the closing delimiter is missing where parts open and never close', () => {
    assert.deepEqual(splitMultipart('--b\r\n\r\none\r\n--b\r\n\r\ntwo', 'b'), {
      status: 'no-close',
    });
    assert.deepEqual(splitMultipart('--b\r\n\r\none\r\n--b--x', 'b'), { status: 'no-close' });
  });

  it('reads a part with no headers, and one with no empty line as headers and no content', () => {
    const parts = partsOf(
      splitMultipart('--b\r\n\r\nbare content\r\n--b\r\nX-Only: header\r\n--b\r\n\r\n--b--', 'b'),
    );

    assert.deepEqual(
      parts.map(({ headers, text, size }) => ({ headers, text, size })),
      [
        { headers: [], text: 'bare content', size: 12 },
        { headers: [['X-Only', 'header']], text: '', size: 0 },
        { headers: [], text: '', size: 0 },
      ],
    );
  });

  it('keeps content that is not UTF-8 as bytes, counted exactly, and reads none of it', () => {
    const png = '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\xff\xfe';
    const body = `--b\r\nContent-Type: image/png\r\n\r\n${png}\r\n--b--\r\n`;
    const [part] = partsOf(splitMultipart(body, 'b'));

    assert.equal(part?.text, null);
    assert.equal(part?.size, png.length);
    assert.equal(part?.contentType, 'image/png');
  });

  it('keeps a byte-order mark at the start of a part as a character', () => {
    const [part] = partsOf(splitMultipart(`--b\r\n\r\n${utf8Bytes('﻿hi')}\r\n--b--`, 'b'));

    assert.equal(part?.text, '﻿hi');
    assert.equal(part?.size, 5);
  });

  it('reads part headers as UTF-8 where they are, and one character per byte where not', () => {
    const utf8 = utf8Bytes('Content-Disposition: form-data; name="файл"; filename="счёт.pdf"');
    const latin1 = 'Content-Disposition: form-data; name="caf\xe9"';
    const parts = partsOf(
      splitMultipart(`--b\r\n${utf8}\r\n\r\nx\r\n--b\r\n${latin1}\r\n\r\ny\r\n--b--`, 'b'),
    );

    assert.equal(parts[0]?.name, 'файл');
    assert.equal(parts[0]?.filename, 'счёт.pdf');
    assert.equal(parts[1]?.name, 'café');
    assert.deepEqual(parts[1]?.headers, [['Content-Disposition', 'form-data; name="café"']]);
  });

  it('joins a folded header line, and keeps a line without a colon as a name', () => {
    const head = 'Content-Disposition: form-data;\r\n name="a"\r\nstray line\r\nX-Empty:';
    const [part] = partsOf(splitMultipart(`--b\r\n${head}\r\n\r\nx\r\n--b--`, 'b'));

    assert.deepEqual(part?.headers, [
      ['Content-Disposition', 'form-data; name="a"'],
      ['stray line', ''],
      ['X-Empty', ''],
    ]);
    assert.equal(part?.name, 'a');
  });

  it('reads the first Content-Disposition and Content-Type, in any case of their names', () => {
    const head = [
      'content-disposition: form-data; name="first"',
      'CONTENT-TYPE: Text/Plain; charset=UTF-8',
      'Content-Disposition: form-data; name="second"',
      'Content-Type: image/png',
    ].join('\r\n');
    const [part] = partsOf(splitMultipart(`--b\r\n${head}\r\n\r\nx\r\n--b--`, 'b'));

    assert.equal(part?.name, 'first');
    assert.equal(part?.contentType, 'Text/Plain');
  });

  it('prefers a filename* that decodes, and falls back to filename where it does not', () => {
    const filename = (disposition: string) =>
      partsOf(
        splitMultipart(`--b\r\nContent-Disposition: ${disposition}\r\n\r\nx\r\n--b--`, 'b'),
      )[0]?.filename;

    assert.equal(
      filename(`form-data; name="f"; filename="plain.txt"; filename*=UTF-8''na%C3%AFve.txt`),
      'naïve.txt',
    );
    assert.equal(filename(`form-data; filename*=iso-8859-1'en'caf%E9.txt`), 'café.txt');
    assert.equal(
      filename(`form-data; filename="plain.txt"; filename*=UTF-8''%E9.txt`),
      'plain.txt',
    );
    assert.equal(
      filename(`form-data; filename="plain.txt"; filename*=KOI8-R''%E9.txt`),
      'plain.txt',
    );
    assert.equal(filename(`form-data; filename="plain.txt"; filename*=UTF-8''%zz`), 'plain.txt');
    assert.equal(filename('form-data; name="f"; filename="a\\b.txt"'), 'a\\b.txt');
    assert.equal(filename('form-data; name="f"; filename=""'), null);
    assert.equal(filename('form-data; name="f"'), null);
  });

  it('keeps a part that is itself multipart as one part, its inner delimiters in its content', () => {
    const inner = [
      '--inner',
      'Content-Type: text/plain',
      '',
      'plain',
      '--inner',
      'Content-Type: text/html',
      '',
      '<p>html</p>',
      '--inner--',
    ].join('\r\n');
    const body = `--outer\r\nContent-Type: multipart/alternative; boundary=inner\r\n\r\n${inner}\r\n--outer--\r\n`;
    const parts = partsOf(splitMultipart(body, 'outer'));

    assert.equal(parts.length, 1);
    assert.equal(parts[0]?.contentType, 'multipart/alternative');
    assert.equal(parts[0]?.text, inner);
  });

  it('splits a boundary that holds spaces and separators, as a quoted parameter gives it', () => {
    const boundary = 'a b;c=d';
    const parts = partsOf(splitMultipart(`--${boundary}\r\n\r\nx\r\n--${boundary}--`, boundary));

    assert.equal(parts[0]?.text, 'x');
  });
});
