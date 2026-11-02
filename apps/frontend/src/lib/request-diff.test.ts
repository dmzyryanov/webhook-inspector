/**
 * `Compare with…` (issue #75, D186): the line model of each view, the open
 * `−` / chosen `+` order, duplicate header pairs, the fold rule, the changed
 * characters, identical requests, the whole-body limits and the edit-limit
 * fallback. Picking in the list and the comparison on screen are E2E-11's.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RequestDetails } from '@webhook-inspector/shared';
import {
  compareRequests,
  compareText,
  CONTEXT_LINES,
  foldLines,
  inlineRanges,
  isIdentical,
  lineTokens,
  MAX_EDIT_LENGTH,
  noDifferencesLine,
  openingView,
  splitByInlineRanges,
  viewLines,
  wholeHeadline,
  wholeNote,
  type DiffLine,
  type DiffRow,
  type ViewComparison,
} from './request-diff.ts';
import { formatBytesCompact } from './format.ts';

const SESSION = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

interface Shape {
  id?: string;
  body?: string | null;
  bodyBase64?: string | null;
  headers?: [string, string][];
  query?: string;
  contentType?: string;
}

/** A captured request as the detail endpoint returns it, with its Raw built from its parts. */
function request({
  id = '2b906b8e-9d4a-4e7b-a1c6-5e8f0d2b7a94',
  body = '{"id":"evt_1","data":{"amount":4200,"currency":"eur","status":"succeeded"}}',
  bodyBase64 = null,
  headers,
  query = 'livemode=false&attempt=3',
  contentType = 'application/json',
}: Shape = {}): RequestDetails {
  const allHeaders: [string, string][] = headers ?? [
    ['Host', 'qa-tools.ru'],
    ['Content-Type', contentType],
    ['Content-Length', String((body ?? '').length)],
  ];
  const head = `POST /s/${SESSION}/hook${query === '' ? '' : `?${query}`} HTTP/1.1\r\n${allHeaders
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('')}\r\n`;

  return {
    id,
    method: 'POST',
    receivedAt: '2026-09-26T08:41:55.000Z',
    bodySize: bodyBase64 === null ? new TextEncoder().encode(body ?? '').length : 9,
    sourceIp: '54.187.174.169',
    path: `/s/${SESSION}/hook`,
    queryString: query,
    headers: allHeaders,
    body: bodyBase64 === null ? body : null,
    bodyBase64,
    isBinary: bodyBase64 !== null,
    raw: bodyBase64 === null ? `${head}${body ?? ''}` : null,
    rawBase64: bodyBase64 === null ? null : btoa(head) + bodyBase64,
    isRawBinary: bodyBase64 !== null,
    httpVersion: '1.1',
    response: null,
  };
}

function lines(comparison: ViewComparison): readonly DiffRow[] {
  assert.equal(comparison.kind, 'lines');

  return comparison.kind === 'lines' ? comparison.rows : [];
}

/** The rows as `  text`, `- text`, `+ text` and `~N` for a fold. */
function picture(rows: readonly DiffRow[]): string[] {
  return rows.map((row) =>
    row.kind === 'fold'
      ? `~${row.lines.length}`
      : `${row.kind === 'same' ? ' ' : row.kind === 'removed' ? '-' : '+'} ${row.text}`,
  );
}

function marked(row: DiffRow): string[] {
  if (row.kind !== 'removed' && row.kind !== 'added') {
    return [];
  }

  return row.marks.map((range) => row.text.slice(range.start, range.end));
}

describe('compareRequests: the line model of each view', () => {
  const open = request();
  const chosen = request({
    id: '9b14d3a0-0000-4000-8000-000000000000',
    body: '{"id":"evt_1","data":{"amount":"42.00","currency":"eur","status":"succeeded"}}',
    headers: [
      ['Host', 'qa-tools.ru'],
      ['Content-Type', 'application/json'],
      ['Content-Length', '80'],
    ],
    query: 'livemode=false&attempt=2',
  });
  const comparison = compareRequests(open, chosen);

  it('compares Body as the view draws it, JSON re-indented, with exactly the changed line', () => {
    assert.deepEqual(picture(lines(comparison.body)), [
      '  {',
      '    "id": "evt_1",',
      '    "data": {',
      '-     "amount": 4200,',
      '+     "amount": "42.00",',
      '      "currency": "eur",',
      '      "status": "succeeded"',
      '    }',
      '  }',
    ]);
  });

  it('underlines the changed value in both lines of the pair', () => {
    const rows = lines(comparison.body);

    assert.deepEqual(marked(rows[3] as DiffRow), ['4200']);
    assert.deepEqual(marked(rows[4] as DiffRow), ['"42.00"']);
  });

  it('compares Headers one `Name: value` line per pair', () => {
    assert.deepEqual(picture(lines(comparison.headers)), [
      '  Host: qa-tools.ru',
      '  Content-Type: application/json',
      '- Content-Length: 75',
      '+ Content-Length: 80',
    ]);
  });

  it('compares Query one decoded `name=value` line per pair', () => {
    assert.deepEqual(picture(lines(comparison.query)), [
      '  livemode=false',
      '- attempt=3',
      '+ attempt=2',
    ]);
    assert.deepEqual(marked(lines(comparison.query)[1] as DiffRow), ['3']);
  });

  it('compares Raw as stored, its request line, headers and body each a line, CR not drawn', () => {
    const rows = picture(lines(comparison.raw));

    assert.equal(rows[0], `- POST /s/${SESSION}/hook?livemode=false&attempt=3 HTTP/1.1`);
    assert.equal(rows[1], `+ POST /s/${SESSION}/hook?livemode=false&attempt=2 HTTP/1.1`);
    assert.ok(rows.includes('- Content-Length: 75'));
    assert.ok(rows.every((row) => !row.includes('\r')));
  });

  it('marks every view as differing, and opens on Body', () => {
    assert.deepEqual(
      Object.values(comparison).map((view) => view.differs),
      [true, true, true, true],
    );
    assert.equal(isIdentical(comparison), false);
    assert.equal(openingView(comparison), 'body');
  });

  it('keeps the open request `−` and the chosen one `+` whichever is newer', () => {
    const reversed = compareRequests(chosen, open);

    assert.deepEqual(picture(lines(reversed.query)), [
      '  livemode=false',
      '- attempt=2',
      '+ attempt=3',
    ]);
  });
});

describe('compareRequests: headers pair by pair', () => {
  it('compares duplicate headers in their recorded order', () => {
    const open = request({
      headers: [
        ['X-Dup', 'a'],
        ['X-Dup', 'b'],
        ['Host', 'qa-tools.ru'],
      ],
    });
    const chosen = request({
      headers: [
        ['X-Dup', 'b'],
        ['X-Dup', 'a'],
        ['Host', 'qa-tools.ru'],
      ],
    });

    assert.deepEqual(picture(lines(compareRequests(open, chosen).headers)), [
      '- X-Dup: a',
      '  X-Dup: b',
      '+ X-Dup: a',
      '  Host: qa-tools.ru',
    ]);
  });

  it('shows a repeated header added as one added line', () => {
    const open = request({ headers: [['X-Dup', 'a']] });
    const chosen = request({
      headers: [
        ['X-Dup', 'a'],
        ['X-Dup', 'a'],
      ],
    });

    assert.deepEqual(picture(lines(compareRequests(open, chosen).headers)), [
      '  X-Dup: a',
      '+ X-Dup: a',
    ]);
  });
});

describe('the opening view', () => {
  it('is the first differing of Raw, Headers, Query when the bodies are equal', () => {
    const comparison = compareRequests(request(), request({ query: 'livemode=false&attempt=4' }));

    assert.equal(comparison.body.differs, false);
    assert.equal(comparison.headers.differs, false);
    assert.equal(openingView(comparison), 'raw');
  });

  it('is Body for identical requests', () => {
    const comparison = compareRequests(request(), request({ id: 'other' }));

    assert.equal(isIdentical(comparison), true);
    assert.equal(openingView(comparison), 'body');
  });
});

describe('identical requests (D1)', () => {
  const comparison = compareRequests(request(), request({ id: 'other' }));

  it('differ in no view, each folded whole', () => {
    for (const view of Object.values(comparison)) {
      assert.equal(view.differs, false);
      assert.equal(view.kind, 'lines');

      if (view.kind === 'lines') {
        assert.equal(view.rows.length, 1);
        assert.equal(view.rows[0]?.kind, 'fold');
      }
    }

    assert.deepEqual(picture(lines(comparison.body)), ['~8']);
    assert.equal(noDifferencesLine('headers'), 'No differences in Headers.');
  });

  it('draw nothing for two views that are both empty', () => {
    const empty = compareRequests(request({ query: '' }), request({ query: '' }));

    assert.deepEqual(lines(empty.query), []);
    assert.equal(empty.query.differs, false);
  });
});

describe('the fold rule', () => {
  const same = (text: string): DiffLine => ({ kind: 'same', text });
  const removed = (text: string): DiffLine => ({ kind: 'removed', text, marks: [] });

  it('keeps three lines of context each side and folds a longer run', () => {
    const input = [
      ...Array.from({ length: 8 }, (_, index) => same(`a${index}`)),
      removed('x'),
      ...Array.from({ length: 10 }, (_, index) => same(`b${index}`)),
      removed('y'),
      ...Array.from({ length: 4 }, (_, index) => same(`c${index}`)),
    ];

    assert.equal(CONTEXT_LINES, 3);
    assert.deepEqual(picture(foldLines(input)), [
      '~5',
      '  a5',
      '  a6',
      '  a7',
      '- x',
      '  b0',
      '  b1',
      '  b2',
      '~4',
      '  b7',
      '  b8',
      '  b9',
      '- y',
      '  c0',
      '  c1',
      '  c2',
      '  c3',
    ]);
  });

  it('does not fold three lines or fewer beyond the context', () => {
    const input = [
      removed('x'),
      ...Array.from({ length: 9 }, (_, index) => same(`b${index}`)),
      removed('y'),
    ];

    assert.deepEqual(
      picture(foldLines(input)).filter((row) => row.startsWith('~')),
      [],
    );
    assert.equal(foldLines(input).length, 11);
  });

  it('folds the hidden lines themselves, so Show can draw them', () => {
    const rows = foldLines([
      ...Array.from({ length: 7 }, (_, index) => same(`a${index}`)),
      removed('x'),
    ]);

    assert.deepEqual(rows[0], { kind: 'fold', lines: ['a0', 'a1', 'a2', 'a3'] });
  });
});

describe('changed lines in a hunk', () => {
  it('draws as many removed as added in pairs, each `−` over its `+`', () => {
    assert.deepEqual(picture(lines(compareText(['a: 1', 'b: 1'], ['a: 2', 'b: 2']))), [
      '- a: 1',
      '+ a: 2',
      '- b: 1',
      '+ b: 2',
    ]);
  });

  it('draws every `−` before every `+` otherwise, pairing the first lines', () => {
    const rows = lines(
      compareText(['"amount": 4200,', '"currency": "eur",'], ['"amount": "42.00",']),
    );

    assert.deepEqual(picture(rows), [
      '- "amount": 4200,',
      '- "currency": "eur",',
      '+ "amount": "42.00",',
    ]);
    assert.deepEqual(marked(rows[0] as DiffRow), ['4200']);
    assert.deepEqual(marked(rows[1] as DiffRow), []);
    assert.deepEqual(marked(rows[2] as DiffRow), ['"42.00"']);
  });
});

describe('inlineRanges: the changed characters', () => {
  it('tokenizes words, white space and single punctuation', () => {
    assert.deepEqual(lineTokens('"a_1": 42.00,'), [
      '"',
      'a_1',
      '"',
      ':',
      ' ',
      '42',
      '.',
      '00',
      ',',
    ]);
  });

  it('underlines only the differing middle of one word replacing another', () => {
    const [before, after] = inlineRanges(
      'Stripe-Signature: t=1790412115,v1=5257a8',
      'Stripe-Signature: t=1790412001,v1=9f0c2b',
    );
    const pieces = (text: string, ranges: typeof before) =>
      splitByInlineRanges(text, ranges)
        .filter((piece) => piece.changed)
        .map((piece) => piece.text);

    assert.deepEqual(pieces('Stripe-Signature: t=1790412115,v1=5257a8', before), ['115', '5257a8']);
    assert.deepEqual(pieces('Stripe-Signature: t=1790412001,v1=9f0c2b', after), ['001', '9f0c2b']);
  });

  it('joins touching changes into one range', () => {
    const [before, after] = inlineRanges('x = 4200,', 'x = "42.00",');

    assert.deepEqual(before, [{ start: 4, end: 8 }]);
    assert.deepEqual(after, [{ start: 4, end: 11 }]);
  });

  it('joins changes one or two punctuation characters apart, not across a word', () => {
    const before = '{"amount":4200,"currency":"eur","status":"ok"}';
    const after = '{"amount":"42.00","status":"ok"}';
    const [removed] = inlineRanges(before, after);

    assert.deepEqual(
      removed.map((range) => before.slice(range.start, range.end)),
      ['4200,"currency":"eur"'],
    );
  });

  it('underlines nothing in a line past the inline length limit', () => {
    assert.deepEqual(inlineRanges('a'.repeat(10_001), 'b'), [[], []]);
  });

  it('splits a line with no ranges into one plain piece', () => {
    assert.deepEqual(splitByInlineRanges('', []), [{ text: '', changed: false }]);
    assert.deepEqual(splitByInlineRanges('abc', [{ start: 1, end: 2 }]), [
      { text: 'a', changed: false },
      { text: 'b', changed: true },
      { text: 'c', changed: false },
    ]);
  });
});

describe('the whole-body limits (D2, D3)', () => {
  it('compares binary bodies and a non-UTF-8 Raw only as a whole, with both sizes', () => {
    const open = request({ bodyBase64: btoa('\x89PNG\x00\xff\xfe\r\n') });
    const chosen = request({ bodyBase64: btoa('\x89PNG\x00\xff\xfe\r\n') });
    const comparison = compareRequests(open, chosen);

    assert.deepEqual(comparison.body, {
      kind: 'whole',
      reason: 'binary',
      differs: false,
      sizes: [9, 9],
    });
    assert.equal(comparison.raw.kind, 'whole');
    assert.equal(comparison.raw.kind === 'whole' && comparison.raw.reason, 'not-utf8');
    assert.equal(
      wholeHeadline(
        'body',
        comparison.body as Extract<ViewComparison, { kind: 'whole' }>,
        formatBytesCompact,
      ),
      'The bodies are binary and identical: 9 B each.',
    );
    assert.equal(
      wholeNote('binary'),
      'Binary bodies, multipart bodies and a Raw that is not UTF-8 are compared as a whole.',
    );
  });

  it('compares a binary body against a text one as a whole that differs', () => {
    const comparison = compareRequests(request({ bodyBase64: btoa('\xff') }), request());

    assert.equal(comparison.body.kind, 'whole');
    assert.equal(comparison.body.differs, true);
    assert.equal(
      wholeHeadline(
        'body',
        comparison.body as Extract<ViewComparison, { kind: 'whole' }>,
        formatBytesCompact,
      ),
      'The bodies differ.',
    );
  });

  it('compares a body above 256 KiB, and its Raw, only as a whole', () => {
    const big = `{"a":"${'x'.repeat(256 * 1024)}"}`;
    const comparison = compareRequests(request({ body: big }), request({ body: `${big} ` }));

    assert.equal(comparison.body.kind, 'whole');
    assert.equal(comparison.body.kind === 'whole' && comparison.body.reason, 'too-large');
    assert.deepEqual(comparison.body.kind === 'whole' && comparison.body.sizes, [
      big.length,
      big.length + 1,
    ]);
    assert.equal(comparison.body.differs, true);
    assert.equal(comparison.raw.kind, 'whole');
  });

  it('compares a multipart body drawn as parts only as a whole', () => {
    const body = '--b\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--b--\r\n';
    const comparison = compareRequests(
      request({ body, contentType: 'multipart/form-data; boundary=b' }),
      request({
        body: body.replace('\r\n1\r\n', '\r\n2\r\n'),
        contentType: 'multipart/form-data; boundary=b',
      }),
    );

    assert.equal(comparison.body.kind, 'whole');
    assert.equal(comparison.body.kind === 'whole' && comparison.body.reason, 'multipart');
    assert.equal(comparison.body.differs, true);
    // Raw is text, so it is still compared line by line.
    assert.equal(comparison.raw.kind, 'lines');
  });
});

describe('the edit limit', () => {
  it('gives up on two unrelated bodies just under 256 KiB, quickly, with both sizes', () => {
    const body = (seed: string): string => {
      const items: string[] = [];
      let length = 0;

      while (length < 250 * 1024) {
        const item = `{"id":"${seed}${items.length}","value":${items.length * 7}}`;

        items.push(item);
        length += item.length + 1;
      }

      return `[${items.join(',')}]`;
    };
    const open = request({ body: body('a') });
    const chosen = request({ body: body('b') });
    const started = performance.now();
    const comparison = compareRequests(open, chosen);
    const elapsed = performance.now() - started;

    assert.equal(comparison.body.kind, 'too-many-changes');
    assert.equal(comparison.body.differs, true);
    assert.ok(open.bodySize < 256 * 1024 && chosen.bodySize < 256 * 1024);
    assert.deepEqual(comparison.body.kind === 'too-many-changes' && comparison.body.sizes, [
      open.bodySize,
      chosen.bodySize,
    ]);
    // Generous for a loaded CI runner; the limit itself costs some 60 ms.
    assert.ok(elapsed < 5000, `took ${elapsed} ms`);
  });

  it('is jsdiff edit length, lines removed and added together', () => {
    const a = Array.from({ length: MAX_EDIT_LENGTH }, (_, index) => `a${index}`);

    assert.equal(compareText(a, []).kind, 'lines');
    assert.equal(compareText([...a, 'extra'], []).kind, 'too-many-changes');
  });
});

describe('viewLines', () => {
  it('draws no lines for a placeholder', () => {
    assert.deepEqual(viewLines({ kind: 'empty', placeholder: 'No request body' }), []);
  });
});
