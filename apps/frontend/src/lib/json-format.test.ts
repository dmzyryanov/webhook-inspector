/**
 * The test table D112 names, in full.
 *
 * D112 accepts a hand-written tokenizer against the project's rule that the
 * frontend be "conventional and simple" **only** together with this table, and
 * says so in as many words: shrinking it leaves unconventional code without
 * the one thing that justifies it. Every case below is therefore a requirement, not a sample.
 *
 * Escape sequences and control characters are assembled from `BACKSLASH` and
 * `String.fromCharCode` rather than typed as literals. Typing them would make
 * the file's meaning depend on whether an editor, a formatter or a patch tool
 * ever resolved an escape into the character it denotes - which is the same
 * class of silent rewrite the module under test exists to prevent.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FORMATTED_MAX_CHARACTERS,
  JSON_FORMAT_MAX_BYTES,
  JSON_MAX_DEPTH,
  formatJsonForDisplay,
} from './json-format.ts';
import { XML_MAX_DEPTH } from './xml-format.ts';

/** One literal backslash, never written as an escape in this file. */
const BACKSLASH = String.fromCharCode(92);

/** The re-indented text, failing loudly where the input was rejected. */
function formatted(source: string): string {
  const result = formatJsonForDisplay(source);

  assert.equal(result.status, 'formatted', `expected valid JSON, got ${result.status}`);

  return result.status === 'formatted' ? result.text : '';
}

function statusOf(source: string): string {
  return formatJsonForDisplay(source).status;
}

describe('formatJsonForDisplay: numbers survive character for character', () => {
  /**
   * The case the whole module exists for. `JSON.parse`/`JSON.stringify` renders
   * this as `12345678901234567000`, which is a different number than the one
   * the sender sent.
   */
  it('keeps an integer beyond Number.MAX_SAFE_INTEGER exactly as it arrived', () => {
    const digits = '12345678901234567890';

    assert.ok(Number(digits) > Number.MAX_SAFE_INTEGER);
    assert.notEqual(String(Number(digits)), digits);

    assert.equal(formatted(`{"runId":${digits}}`), `{\n  "runId": ${digits}\n}`);
  });

  it('keeps 1e5, 1.50 and -0 in their literal form', () => {
    assert.equal(formatted('[1e5,1.50,-0]'), ['[', '  1e5,', '  1.50,', '  -0', ']'].join('\n'));
  });

  it('keeps exponent and sign spellings', () => {
    assert.equal(
      formatted('[1E+5,-2.5e-3,0]'),
      ['[', '  1E+5,', '  -2.5e-3,', '  0', ']'].join('\n'),
    );
  });
});

describe('formatJsonForDisplay: duplicate keys', () => {
  it('keeps every duplicate key, in the order it arrived', () => {
    assert.equal(
      formatted('{"a":1,"b":2,"a":3}'),
      ['{', '  "a": 1,', '  "b": 2,', '  "a": 3', '}'].join('\n'),
    );
  });

  it('keeps duplicates that differ only in value type', () => {
    assert.equal(
      formatted('{"a":null,"a":"null"}'),
      ['{', '  "a": null,', '  "a": "null"', '}'].join('\n'),
    );
  });
});

describe('formatJsonForDisplay: strings', () => {
  it('keeps escape sequences exactly as written, never re-encoding them', () => {
    const escapes = ['"', BACKSLASH, '/', 'b', 'f', 'n', 'r', 't']
      .map((character) => BACKSLASH + character)
      .join('');
    const value = `"a${escapes}z"`;

    assert.equal(formatted(`{"s":${value}}`), `{\n  "s": ${value}\n}`);
  });

  it('keeps a surrogate pair written as two escapes written that way', () => {
    const pair = `${BACKSLASH}ud83d${BACKSLASH}ude00`;

    assert.equal(formatted(`{"emoji":"${pair}"}`), `{\n  "emoji": "${pair}"\n}`);
  });

  it('keeps a literal astral character literal', () => {
    const emoji = String.fromCodePoint(0x1f600);

    assert.equal(formatted(`{"emoji":"${emoji}"}`), `{\n  "emoji": "${emoji}"\n}`);
  });

  /**
   * The one tokenizer bug class that would mangle output instead of rejecting
   * it: a string's contents are not structure. Everything else the tokenizer
   * can get wrong produces `invalid`, which is visible; reading `}` inside a
   * string as a closing brace would silently re-indent the body around a
   * structure the sender never sent.
   */
  it('never reads JSON punctuation inside a string as structure', () => {
    const nested = `"{${BACKSLASH}"b${BACKSLASH}": 3}"`;

    assert.equal(formatted('{"a":"}{,:"}'), '{\n  "a": "}{,:"\n}');
    assert.equal(
      formatted(`["[1,2]",${nested}]`),
      ['[', '  "[1,2]",', `  ${nested}`, ']'].join('\n'),
    );
  });

  /** The same point from the other side: an escaped quote does not end it. */
  it('keeps scanning past an escaped quote', () => {
    const value = `"a${BACKSLASH}"},{z"`;

    assert.equal(formatted(`{"s":${value}}`), `{\n  "s": ${value}\n}`);
  });

  it('rejects an unescaped control character inside a string', () => {
    assert.equal(statusOf(`{"s":"a${String.fromCharCode(1)}b"}`), 'invalid');
    assert.equal(statusOf(`{"s":"a${String.fromCharCode(10)}b"}`), 'invalid');
    assert.equal(statusOf(`{"s":"a${String.fromCharCode(9)}b"}`), 'invalid');
  });

  it('accepts the same control character when it is escaped', () => {
    const escaped = `${BACKSLASH}u0001`;

    assert.equal(formatted(`{"s":"a${escaped}b"}`), `{\n  "s": "a${escaped}b"\n}`);
  });

  it('rejects an unknown escape and a truncated hex escape', () => {
    assert.equal(statusOf(`{"s":"${BACKSLASH}x41"}`), 'invalid');
    assert.equal(statusOf(`{"s":"${BACKSLASH}u12"}`), 'invalid');
    assert.equal(statusOf(`{"s":"${BACKSLASH}uZZZZ"}`), 'invalid');
    assert.equal(statusOf('{"s":"unterminated}'), 'invalid');
  });
});

describe('formatJsonForDisplay: structure', () => {
  it('indents nested objects and arrays two spaces per level', () => {
    assert.equal(
      formatted('{"a":{"b":[1,{"c":true}]}}'),
      [
        '{',
        '  "a": {',
        '    "b": [',
        '      1,',
        '      {',
        '        "c": true',
        '      }',
        '    ]',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('keeps an empty object and an empty array on one line', () => {
    assert.equal(formatted('{"a":{},"b":[]}'), ['{', '  "a": {},', '  "b": []', '}'].join('\n'));
  });

  /**
   * Deep nesting is ordinary input for a webhook inspector, so the pass over
   * the tokens is iterative: a recursive one would overflow the stack of the
   * tab showing the payload rather than reporting anything about it. Past
   * `JSON_MAX_DEPTH` it is reported rather than re-indented (D169), and the
   * grammar is still checked all the way down.
   */
  it('handles deep nesting without overflowing the stack', () => {
    const depth = 20_000;

    assert.equal(statusOf(`${'['.repeat(depth)}1${']'.repeat(depth)}`), 'too-deep');
    assert.equal(statusOf(`${'['.repeat(depth)}1${']'.repeat(depth - 1)}`), 'invalid');
    assert.equal(statusOf(`${'['.repeat(depth)}1,${']'.repeat(depth)}`), 'invalid');
    assert.equal(statusOf(`${'['.repeat(depth)}1${']'.repeat(depth)} 2`), 'invalid');
  });
});

/**
 * Issue #59. Indentation grows with depth on every line, so the rendering of
 * deep nesting grows with the square of it: on `main` at `5c6722a` these bodies
 * were re-indented to 2 000 000 and 50 000 000 characters and, the last one,
 * threw `RangeError: Invalid string length`, which took the page down. Past
 * `JSON_MAX_DEPTH` the body is shown as stored instead (D169).
 */
describe('formatJsonForDisplay: the depth limit', () => {
  function arrays(depth: number, inner = ''): string {
    return `${'['.repeat(depth)}${inner}${']'.repeat(depth)}`;
  }

  function objects(depth: number, inner = '{}'): string {
    return `${'{"a":'.repeat(depth - 1)}${inner}${'}'.repeat(depth - 1)}`;
  }

  it('is the same limit as XML (D163)', () => {
    assert.equal(JSON_MAX_DEPTH, 100);
    assert.equal(JSON_MAX_DEPTH, XML_MAX_DEPTH);
  });

  for (const [depth, size] of [
    [1_000, '2 KB'],
    [5_000, '10 KB'],
    [20_000, '40 KB'],
  ] as const) {
    it(`reports ${depth} nested arrays (${size}) as too deep, without an exception`, () => {
      assert.deepEqual(formatJsonForDisplay(arrays(depth)), { status: 'too-deep' });
      assert.deepEqual(formatJsonForDisplay(objects(depth)), { status: 'too-deep' });
    });
  }

  it(`re-indents ${JSON_MAX_DEPTH} nested arrays, and not ${JSON_MAX_DEPTH + 1}`, () => {
    const text = formatted(arrays(JSON_MAX_DEPTH));
    const rows = text.split('\n');

    // The innermost array is empty, so it stays on one line (see above).
    assert.equal(rows.length, JSON_MAX_DEPTH * 2 - 1);
    assert.equal(rows[JSON_MAX_DEPTH - 1], `${'  '.repeat(JSON_MAX_DEPTH - 1)}[]`);
    assert.equal(statusOf(arrays(JSON_MAX_DEPTH + 1)), 'too-deep');
  });

  it(`re-indents ${JSON_MAX_DEPTH} nested objects, and not ${JSON_MAX_DEPTH + 1}`, () => {
    const text = formatted(objects(JSON_MAX_DEPTH));
    const rows = text.split('\n');

    assert.equal(rows.length, JSON_MAX_DEPTH * 2 - 1);
    assert.equal(rows[JSON_MAX_DEPTH - 1], `${'  '.repeat(JSON_MAX_DEPTH - 1)}"a": {}`);
    assert.equal(statusOf(objects(JSON_MAX_DEPTH + 1)), 'too-deep');
  });

  /** The deepest line of a rendering is indented at most `JSON_MAX_DEPTH` levels. */
  it(`indents a value inside ${JSON_MAX_DEPTH} containers ${JSON_MAX_DEPTH} levels deep`, () => {
    const rows = formatted(arrays(JSON_MAX_DEPTH, '1')).split('\n');

    assert.equal(rows.length, JSON_MAX_DEPTH * 2 + 1);
    assert.equal(rows[JSON_MAX_DEPTH], `${'  '.repeat(JSON_MAX_DEPTH)}1`);
    assert.equal(statusOf(arrays(JSON_MAX_DEPTH + 1, '1')), 'too-deep');
  });

  /** A bracket inside a string is text, not structure, and does not count. */
  it('does not count brackets inside a string', () => {
    const brackets = '['.repeat(200);

    assert.equal(statusOf(`{"a":"${brackets}"}`), 'formatted');
    assert.equal(statusOf(`["${brackets}","${'{'.repeat(200)}"]`), 'formatted');
    assert.equal(statusOf(arrays(JSON_MAX_DEPTH, `"${brackets}"`)), 'formatted');
    assert.equal(statusOf(arrays(JSON_MAX_DEPTH + 1, `"${brackets}"`)), 'too-deep');
  });

  /** Depth is how many containers are open at once, not how many there are. */
  it('counts the deepest point, not the number of containers', () => {
    const wide = `[${Array.from({ length: 100 }, () => arrays(JSON_MAX_DEPTH - 1)).join(',')}]`;

    assert.equal(statusOf(wide), 'formatted');
    assert.equal(statusOf(`[${arrays(JSON_MAX_DEPTH - 1)},${arrays(JSON_MAX_DEPTH)}]`), 'too-deep');
  });

  it('mixes objects and arrays in one count', () => {
    const mixed = (depth: number) => `${'{"a":['.repeat(depth / 2)}0${']}'.repeat(depth / 2)}`;

    assert.equal(statusOf(mixed(JSON_MAX_DEPTH)), 'formatted');
    assert.equal(statusOf(mixed(JSON_MAX_DEPTH + 2)), 'too-deep');
  });

  /** "Too deep" is said of JSON only: the reason line calls the body JSON. */
  it('reports deep text that is not JSON as invalid, not as too deep', () => {
    assert.equal(statusOf('['.repeat(20_000)), 'invalid');
    assert.equal(statusOf(`${'['.repeat(20_000)}${'}'.repeat(20_000)}`), 'invalid');
    assert.equal(statusOf(`${arrays(20_000)},`), 'invalid');
  });

  /**
   * The depth is decided before any indentation is built, so the cost is
   * linear in the size of the body. The deepest body the ceiling lets in is
   * 131 072 nested arrays, whose re-indenting would be some 34 billion
   * characters: built first, it would exhaust the tab's memory.
   */
  it('reports the deepest body the ceiling lets in as too deep', () => {
    const depth = JSON_FORMAT_MAX_BYTES / 2;

    assert.equal(arrays(depth).length, JSON_FORMAT_MAX_BYTES);
    assert.equal(statusOf(arrays(depth)), 'too-deep');
  });
});

/**
 * Issue #64. The depth limit bounds how deep a line is indented, not how long
 * the rendering is, and a body under the ceiling could still be drawn as tens
 * of millions of characters, freezing the page for 22 s and more. A rendering
 * longer than `FORMATTED_MAX_CHARACTERS` is not built, and the body is shown as
 * stored (D169, as amended for #64).
 */
describe('formatJsonForDisplay: the length cap', () => {
  const bytes = (source: string): number => new TextEncoder().encode(source).length;

  /** `unit` repeated inside `depth` arrays, as many times as fit in `size` bytes. */
  function filled(depth: number, unit: string, size: number): string {
    const room = size - depth * 2;
    const count = Math.floor((room + 1) / (unit.length + 1));

    return `${'['.repeat(depth)}${Array.from({ length: count }, () => unit).join(',')}${']'.repeat(depth)}`;
  }

  /**
   * `count` values inside `depth` arrays: the first has `digits` digits and the
   * others one. Each value takes a line of its own, `2 × depth` spaces deep, so
   * the rendering has `(depth - 1)(depth + 2) + depth(depth + 1) +
   * count(2 × depth + 3) + digits - 1` characters, and a number is written as
   * it arrived: one more digit is one more character (D112).
   */
  function values(depth: number, count: number, digits: number): string {
    const first = `1${'0'.repeat(digits - 1)}`;
    const rest = Array.from({ length: count - 1 }, () => '1');

    return `${'['.repeat(depth)}${[first, ...rest].join(',')}${']'.repeat(depth)}`;
  }

  it('is 2 000 000 characters', () => {
    assert.equal(FORMATTED_MAX_CHARACTERS, 2_000_000);
  });

  /**
   * The bodies the issue measured, each well under the ceiling: 26 337 368,
   * 39 507 856 and 47 942 324 characters re-indented before this change.
   */
  it('reports the bodies measured for #64 as too long', () => {
    const sideBySide = `[${Array.from({ length: 1_317 }, () => `${'['.repeat(99)}${']'.repeat(99)}`).join(',')}]`;
    const ones = filled(99, '[1]', JSON_FORMAT_MAX_BYTES);
    const nines = filled(91, '[[[[[[[[[1]]]]]]]]]', JSON_FORMAT_MAX_BYTES);

    assert.equal(bytes(sideBySide), 262_084);
    assert.equal(bytes(ones), 262_141);
    assert.equal(bytes(nines), 262_141);

    for (const source of [sideBySide, ones, nines]) {
      assert.deepEqual(formatJsonForDisplay(source), { status: 'too-long' });
    }
  });

  it('re-indents a body that formats to exactly the cap, and not one character more', () => {
    const exact = values(99, 9_851, 152);

    assert.equal(formatted(exact).length, FORMATTED_MAX_CHARACTERS);
    assert.deepEqual(formatJsonForDisplay(values(99, 9_851, 153)), { status: 'too-long' });
  });

  /** What the boundary test above relies on: one more digit, one more character. */
  it('renders a value one digit longer one character longer', () => {
    assert.equal(formatted(values(99, 10, 4)).length, formatted(values(99, 10, 3)).length + 1);
    assert.equal(formatted(values(2, 1, 1)), ['[', '  [', '    1', '  ]', ']'].join('\n'));
  });

  /**
   * The densest plausible JSON measured for #64: 130 000 single digits in an
   * array three levels deep, 260 013 bytes, re-indented to 1 170 032
   * characters. Ordinary JSON keeps its formatting.
   */
  it('keeps re-indenting 130 000 numbers three levels deep', () => {
    const digits = Array.from({ length: 130_000 }, (_, index) => String(index % 10));
    const dense = `{"a":{"b":[${digits.join(',')}]}}`;

    assert.equal(bytes(dense), 260_013);
    assert.equal(formatted(dense).length, 1_170_032);
  });

  /** The reasons that were there before keep their place (D169). */
  it('reports a body that is also too deep, invalid or over the ceiling by that reason', () => {
    const long = filled(91, '[[[[[[[[[1]]]]]]]]]', 200_000);

    assert.equal(statusOf(long), 'too-long');
    assert.equal(statusOf(`[${long}]`), 'too-deep');
    assert.equal(statusOf(`${long},`), 'invalid');
    assert.equal(statusOf(long.slice(0, -1)), 'invalid');
    assert.equal(statusOf(`[${long},"${'x'.repeat(JSON_FORMAT_MAX_BYTES)}"]`), 'too-large');
  });
});

describe('formatJsonForDisplay: whole documents', () => {
  it('formats a bare scalar document as itself', () => {
    assert.equal(formatted('42'), '42');
    assert.equal(formatted('  "hello"  '), '"hello"');
    assert.equal(formatted('true'), 'true');
    assert.equal(formatted('null'), 'null');
  });

  it('reports an empty string as invalid rather than as empty output', () => {
    assert.equal(statusOf(''), 'invalid');
    assert.equal(statusOf('   \n\t '), 'invalid');
  });

  it('rejects trailing garbage after a complete value', () => {
    assert.equal(statusOf('{"a":1} trailing'), 'invalid');
    assert.equal(statusOf('{"a":1}{"b":2}'), 'invalid');
    assert.equal(statusOf('1 2'), 'invalid');
    assert.equal(statusOf('[1,2] ]'), 'invalid');
  });
});

describe('formatJsonForDisplay: invalid JSON is never rendered formatted', () => {
  /**
   * The property `jsonc-parser` was rejected for (D112): anything a lenient
   * parser would accept must be reported invalid, because the viewer's job is
   * to show what arrived rather than a repaired version of it.
   */
  const rejected = [
    '{a:1}',
    "{'a':1}",
    '{"a":1,}',
    '[1,2,]',
    '{"a":1} // a comment',
    '/* comment */ {"a":1}',
    '{"a":01}',
    '{"a":+1}',
    '{"a":.5}',
    '{"a":1.}',
    '{"a":1e}',
    '{"a":NaN}',
    '{"a":Infinity}',
    '{"a":undefined}',
    '{"a":True}',
    '{"a" 1}',
    '{"a":1',
    '[1,2',
    '}',
    '{"a":1]',
    '<html></html>',
  ];

  for (const source of rejected) {
    it(`rejects ${JSON.stringify(source)}`, () => {
      assert.equal(statusOf(source), 'invalid');
    });
  }
});

describe('formatJsonForDisplay: the 256 KiB ceiling', () => {
  it('formats a payload just under the ceiling', () => {
    const filler = 'x'.repeat(JSON_FORMAT_MAX_BYTES - 100);

    assert.equal(statusOf(`{"a":"${filler}"}`), 'formatted');
  });

  it('reports a payload over the ceiling as too large, valid or not', () => {
    const filler = 'x'.repeat(JSON_FORMAT_MAX_BYTES);

    assert.equal(statusOf(`{"a":"${filler}"}`), 'too-large');
    assert.equal(statusOf(`not json at all ${filler}`), 'too-large');
  });

  /** The ceiling counts bytes of UTF-8, not UTF-16 code units. */
  it('counts multi-byte characters by their encoded size', () => {
    const twoBytes = String.fromCharCode(0xe9).repeat(JSON_FORMAT_MAX_BYTES / 2);

    assert.equal(statusOf(`"${twoBytes}"`), 'too-large');
  });
});

/**
 * The strongest statement of what D112 requires, as one property rather than as
 * an enumeration: **re-indenting changes the whitespace between tokens and
 * nothing else.**
 *
 * Every case in the table above asserts one output exactly, which only catches
 * the mistakes somebody thought of. This catches any dropped, reordered or
 * rewritten token in any of them - a digit lost from a long integer, a
 * duplicate key collapsed, an escape re-encoded - because removing the
 * inter-token whitespace from the output must give back the input with the same
 * removed.
 */
describe('formatJsonForDisplay: re-indenting is whitespace-only', () => {
  /**
   * Whitespace that is not inside a string, removed.
   *
   * Written here rather than reused from the module, so that a tokenizer bug
   * cannot hide behind the same bug in the check. A literal space is legal
   * inside a JSON string, so a blanket `replace(/\s/g, '')` would be wrong.
   */
  function withoutInterTokenWhitespace(text: string): string {
    let out = '';
    let inString = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index] as string;

      if (inString) {
        out += char;

        if (char === BACKSLASH) {
          // The next character is escaped, whatever it is, and cannot end the string.
          out += text[index + 1] ?? '';
          index += 1;
        } else if (char === '"') {
          inString = false;
        }

        continue;
      }

      if (char === '"') {
        inString = true;
        out += char;
        continue;
      }

      if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') {
        out += char;
      }
    }

    return out;
  }

  const documents = [
    '{"runId":12345678901234567890}',
    '[1e5,1.50,-0,1E+5,-2.5e-3,0]',
    '{"a":1,"b":2,"a":3}',
    '{"a":null,"a":"null"}',
    `{"s":"a${BACKSLASH}"${BACKSLASH}${BACKSLASH}${BACKSLASH}/${BACKSLASH}b${BACKSLASH}f${BACKSLASH}n${BACKSLASH}r${BACKSLASH}tz"}`,
    `{"emoji":"${BACKSLASH}ud83d${BACKSLASH}ude00"}`,
    `{"emoji":"${String.fromCodePoint(0x1f600)}"}`,
    '{"a":{"b":[1,{"c":true}]}}',
    '{"a":{},"b":[]}',
    '{"a":"}{,:","b":"  spaced  ","c":"[1,2]"}',
    '  {  "a" : [ 1 , 2 ]  }  ',
    '\n\t{"a":\n1}\n',
    '42',
    '  "hello"  ',
    'true',
    'null',
  ];

  for (const source of documents) {
    it(`loses nothing but whitespace from ${JSON.stringify(source)}`, () => {
      assert.equal(
        withoutInterTokenWhitespace(formatted(source)),
        withoutInterTokenWhitespace(source),
      );
    });
  }
});
