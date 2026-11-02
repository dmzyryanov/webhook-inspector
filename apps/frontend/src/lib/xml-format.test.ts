/**
 * The test table D163 names, in full.
 *
 * D163 accepts a second hand-written tokenizer, as D112 accepted the first,
 * **only** together with this table: mixed content; CDATA containing `<` and
 * `>`; comments and processing instructions; attribute values containing `>`;
 * self-closing and empty elements; namespaces and prefixed names; entity
 * references; a declaration with an encoding; deep nesting; trailing content
 * after the root; malformed input, which must be reported and never indented;
 * `xml:space`; a byte-order mark and leading white space; the DOCTYPE; and the
 * ceiling - with, since #64, the cap on a rendering's length. Every case below
 * is a requirement, not a sample.
 *
 * Control characters and the byte-order mark are assembled with
 * `String.fromCharCode` rather than typed, for the reason `json-format.test.ts`
 * gives: a file whose meaning depends on whether a tool ever resolved an escape
 * is the kind of silent rewrite the module under test exists to prevent.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FORMATTED_MAX_CHARACTERS, JSON_FORMAT_MAX_BYTES } from './json-format.ts';
import { formatXmlForDisplay, isWellFormedXml, XML_MAX_DEPTH } from './xml-format.ts';

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** The indented text, failing loudly where the input was not indented. */
function formatted(source: string): string {
  const result = formatXmlForDisplay(source);

  assert.equal(result.status, 'formatted', `expected indented XML, got ${result.status}`);

  return result.status === 'formatted' ? result.text : '';
}

function statusOf(source: string): string {
  return formatXmlForDisplay(source).status;
}

/** Asserts that a document is rendered exactly as it was stored. */
function keptAsStored(source: string): void {
  assert.equal(formatted(source), source);
}

const lines = (...rows: string[]): string => rows.join('\n');

describe('formatXmlForDisplay: mixed content', () => {
  /** The hazard the issue names: indenting it would change its text. */
  it('keeps an element with text and child elements exactly as stored', () => {
    keptAsStored('<p>Hello <b>world</b>, and <i>more</i>.</p>');
    keptAsStored('<a>text<b/>more</a>');
  });

  it('puts a mixed element on its own line, with its own spacing and line breaks', () => {
    assert.equal(
      formatted('<doc><p>Hello  <b>w</b>\n     again</p>\n<q/></doc>'),
      lines('<doc>', '  <p>Hello  <b>w</b>', '     again</p>', '  <q/>', '</doc>'),
    );
  });

  it('keeps white space between two children of a mixed element, which is text there', () => {
    keptAsStored('<p>x <b>1</b> <i>2</i>  </p>');
  });

  it('keeps an element whose children are separated by one character of text', () => {
    keptAsStored('<a>\n  <b/>x<c/>\n</a>');
  });

  it('keeps an element holding white space and nothing else', () => {
    keptAsStored('<a>   </a>');
    keptAsStored('<a>\n</a>');
    assert.equal(
      formatted('<r><a> </a><b>\t</b></r>'),
      lines('<r>', '  <a> </a>', '  <b>\t</b>', '</r>'),
    );
  });
});

describe('formatXmlForDisplay: CDATA sections', () => {
  it('keeps a CDATA section holding < and > as stored, and its element with it', () => {
    keptAsStored('<a><![CDATA[if (a < b && c > d) </a><b>]]></a>');
  });

  /** Reading `<x>` inside CDATA as markup would indent a structure nobody sent. */
  it('reads no structure inside a CDATA section', () => {
    assert.equal(
      formatted('<r><s><![CDATA[<x><y/></x>]]></s><t/></r>'),
      lines('<r>', '  <s><![CDATA[<x><y/></x>]]></s>', '  <t/>', '</r>'),
    );
  });

  it('counts a CDATA section of white space as text, so its element stays as stored', () => {
    keptAsStored('<a> <![CDATA[ ]]> <b/></a>');
    keptAsStored('<a><![CDATA[]]><b/></a>');
  });

  it('rejects an unterminated CDATA section, and one outside the root', () => {
    assert.equal(statusOf('<a><![CDATA[x</a>'), 'invalid');
    assert.equal(statusOf('<![CDATA[x]]><a/>'), 'invalid');
    assert.equal(statusOf('<a/><![CDATA[x]]>'), 'invalid');
  });

  it('rejects ]]> in character data', () => {
    assert.equal(statusOf('<a>x]]>y</a>'), 'invalid');
    assert.equal(statusOf('<a><![CDATA[x]]>]]></a>'), 'invalid');
  });
});

describe('formatXmlForDisplay: comments and processing instructions', () => {
  it('puts each one around the root on a line of its own', () => {
    assert.equal(
      formatted('<!-- head --><?style href="a.css"?>\n\n<r><a/></r>  <!-- tail --><?done?>\n'),
      lines(
        '<!-- head -->',
        '<?style href="a.css"?>',
        '<r>',
        '  <a/>',
        '</r>',
        '<!-- tail -->',
        '<?done?>',
      ),
    );
  });

  /** A comment or a PI beside element children is not text, as in XML 1.0 §3.2.1. */
  it('indents an element whose children include comments and processing instructions', () => {
    assert.equal(
      formatted('<r>\n<!-- one --><a/>\n  <?pi data?></r>'),
      lines('<r>', '  <!-- one -->', '  <a/>', '  <?pi data?>', '</r>'),
    );
  });

  /**
   * "Elements alone" needs an element: comments and PIs take lines of their
   * own only beside one. Without one, the element is kept as it arrived, as
   * `<a> </a>` is.
   */
  it('keeps an element whose only children are comments or processing instructions', () => {
    keptAsStored('<password><!-- redacted --></password>');
    keptAsStored('<a> <!--x--> </a>');
    keptAsStored('<a>\n  <?pi data?>\n  <!-- c -->\n</a>');
    assert.equal(
      formatted('<r><secret> <!-- redacted --> </secret><b/></r>'),
      lines('<r>', '  <secret> <!-- redacted --> </secret>', '  <b/>', '</r>'),
    );
  });

  it('keeps an element where a comment sits next to text', () => {
    keptAsStored('<r>x<!-- c --></r>');
  });

  it('reads no structure inside either, and keeps their spacing exactly', () => {
    assert.equal(
      formatted('<r><!--  <a> </b>  --><?pi <c> > ??><d/></r>'),
      lines('<r>', '  <!--  <a> </b>  -->', '  <?pi <c> > ??>', '  <d/>', '</r>'),
    );
  });

  it('keeps a processing instruction whose target starts with xml', () => {
    assert.equal(
      formatted('<?xml-stylesheet type="text/xsl" href="s.xsl"?><r/>'),
      lines('<?xml-stylesheet type="text/xsl" href="s.xsl"?>', '<r/>'),
    );
  });

  it('rejects -- inside a comment, a comment ending --->, and one never closed', () => {
    assert.equal(statusOf('<a><!-- a -- b --></a>'), 'invalid');
    assert.equal(statusOf('<a><!-- a ---></a>'), 'invalid');
    assert.equal(statusOf('<a><!-- a </a>'), 'invalid');
  });

  it('rejects the reserved target xml, a missing target and one never closed', () => {
    assert.equal(statusOf('<r><?xml version="1.0"?></r>'), 'invalid');
    assert.equal(statusOf('<?XML x?><r/>'), 'invalid');
    assert.equal(statusOf('<r><? x?></r>'), 'invalid');
    assert.equal(statusOf('<r><?pi"x"?></r>'), 'invalid');
    assert.equal(statusOf('<r><?pi x</r>'), 'invalid');
  });
});

describe('formatXmlForDisplay: attribute values', () => {
  it('keeps a value containing > and quotes of the other kind, as written', () => {
    assert.equal(
      formatted(`<r><a expr="x > 1" note='say "hi"'/></r>`),
      lines('<r>', `  <a expr="x > 1" note='say "hi"'/>`, '</r>'),
    );
  });

  /** A tag is its source substring, line breaks and odd spacing included. */
  it('keeps the spacing, order and line breaks inside a tag', () => {
    assert.equal(
      formatted(`<r><a  b = "1"\n   c='2'  /></r>`),
      lines('<r>', `  <a  b = "1"`, `   c='2'  />`, '</r>'),
    );
  });

  const rejected = [
    '<a b="x<y"/>',
    '<a b=1/>',
    '<a b/>',
    '<input disabled>',
    '<a b="1" b="2"/>',
    '<a b="1"c="2"/>',
    '<a b="&x;"/>',
    '<a b="x & y"/>',
    '<a b="unterminated/>',
    '<a b="1" =/>',
  ];

  for (const source of rejected) {
    it(`rejects ${JSON.stringify(source)}`, () => {
      assert.equal(statusOf(source), 'invalid');
    });
  }
});

describe('formatXmlForDisplay: self-closing and empty elements', () => {
  it('keeps a self-closing root as written, with or without a space', () => {
    keptAsStored('<a/>');
    keptAsStored('<a />');
    keptAsStored('<a></a>');
  });

  it('puts self-closing and empty children on lines of their own, each as written', () => {
    assert.equal(
      formatted('<r><a/><b></b><c> </c><d x="1" /></r>'),
      lines('<r>', '  <a/>', '  <b></b>', '  <c> </c>', '  <d x="1" />', '</r>'),
    );
  });
});

describe('formatXmlForDisplay: namespaces and prefixed names', () => {
  it('indents a SOAP envelope, every prefix and declaration as written', () => {
    assert.equal(
      formatted(
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
          '<soap:Body><m:Ping xmlns:m="urn:x"><m:id>7</m:id></m:Ping></soap:Body></soap:Envelope>',
      ),
      lines(
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
        '  <soap:Body>',
        '    <m:Ping xmlns:m="urn:x">',
        '      <m:id>7</m:id>',
        '    </m:Ping>',
        '  </soap:Body>',
        '</soap:Envelope>',
      ),
    );
  });

  it('keeps a default namespace and prefixed attributes', () => {
    assert.equal(
      formatted('<r xmlns="urn:a" xmlns:x="urn:x" x:attr="1"><x:a x:b="2"/></r>'),
      lines('<r xmlns="urn:a" xmlns:x="urn:x" x:attr="1">', '  <x:a x:b="2"/>', '</r>'),
    );
  });

  it('matches an end tag to its start tag as written, prefix included', () => {
    assert.equal(statusOf('<a:b></c:b>'), 'invalid');
    assert.equal(statusOf('<a:b></b>'), 'invalid');
    assert.equal(statusOf('<b></a:b>'), 'invalid');
  });

  /**
   * Namespaces are not resolved (D163): a prefix is part of the name, and an
   * undeclared one is well-formed XML 1.0.
   */
  it('does not resolve prefixes, so an undeclared one is indented as written', () => {
    assert.equal(formatted('<p:a><p:b/></p:a>'), lines('<p:a>', '  <p:b/>', '</p:a>'));
  });

  /** XML names are not ASCII only: a Cyrillic element name is ordinary input. */
  it('accepts names in any script XML allows, and the punctuation it allows after the start', () => {
    const combining = String.fromCharCode(0x301);

    assert.equal(
      formatted(`<заказ><номер>1</номер><注文/><a.b-c_1${combining}/></заказ>`),
      lines('<заказ>', '  <номер>1</номер>', '  <注文/>', `  <a.b-c_1${combining}/>`, '</заказ>'),
    );
    assert.equal(statusOf('<1a/>'), 'invalid');
    assert.equal(statusOf('<.a/>'), 'invalid');
    assert.equal(statusOf(`<${combining}a/>`), 'invalid');
  });
});

describe('formatXmlForDisplay: entity references', () => {
  it('keeps predefined and numeric references as written, and their element as stored', () => {
    assert.equal(
      formatted('<r><a>&lt;tag&gt; &amp; &quot;&apos;</a><b>&#169; &#x1F600;</b><c/></r>'),
      lines(
        '<r>',
        '  <a>&lt;tag&gt; &amp; &quot;&apos;</a>',
        '  <b>&#169; &#x1F600;</b>',
        '  <c/>',
        '</r>',
      ),
    );
  });

  /** A reference is text even where it stands for white space. */
  it('counts a reference as text, one that stands for white space included', () => {
    keptAsStored('<a>&#32;</a>');
    keptAsStored('<r>&#10;<a/></r>');
  });

  it('keeps references inside an attribute value as written', () => {
    assert.equal(
      formatted('<r><a title="&lt;&#65;&#x42;&amp;"/></r>'),
      lines('<r>', '  <a title="&lt;&#65;&#x42;&amp;"/>', '</r>'),
    );
  });

  const rejected = [
    '<a>&nbsp;</a>',
    '<a>AT&T</a>',
    '<a>& b</a>',
    '<a>&amp</a>',
    '<a>&#;</a>',
    '<a>&#x;</a>',
    '<a>&#12a;</a>',
    '<a>&#0;</a>',
    '<a>&#1;</a>',
    '<a>&#xD800;</a>',
    '<a>&#xFFFE;</a>',
    '<a>&#x110000;</a>',
    '<a>&#99999999999999999999;</a>',
    '&amp;<a/>',
  ];

  for (const source of rejected) {
    it(`rejects ${JSON.stringify(source)}`, () => {
      assert.equal(statusOf(source), 'invalid');
    });
  }
});

describe('formatXmlForDisplay: the XML declaration', () => {
  it('keeps a declaration with an encoding on a line of its own, exactly', () => {
    assert.equal(
      formatted('<?xml version="1.0" encoding="UTF-8"?><order><id>1</id></order>'),
      lines('<?xml version="1.0" encoding="UTF-8"?>', '<order>', '  <id>1</id>', '</order>'),
    );
  });

  it('keeps single quotes, a standalone flag and its own spacing', () => {
    const declaration = `<?xml  version = '1.0'  encoding='windows-1251' standalone="yes" ?>`;

    assert.equal(formatted(`${declaration}\r\n\r\n<a/>`), lines(declaration, '<a/>'));
  });

  const rejected = [
    '<?xml version="2.0"?><a/>',
    '<?xml version="1"?><a/>',
    '<?xml encoding="UTF-8"?><a/>',
    '<?xml version="1.0" standalone="yes" encoding="UTF-8"?><a/>',
    '<?xml version="1.0" encoding=""?><a/>',
    '<?xml version="1.0" standalone="maybe"?><a/>',
    '<?xml version="1.0" foo="bar"?><a/>',
    '<?xml version="1.0"?>',
    '<a/><?xml version="1.0"?>',
    ' <?xml version="1.0"?><a/>',
    '<!-- first --><?xml version="1.0"?><a/>',
  ];

  for (const source of rejected) {
    it(`rejects ${JSON.stringify(source)}`, () => {
      assert.equal(statusOf(source), 'invalid');
    });
  }
});

describe('formatXmlForDisplay: nesting', () => {
  it('indents two spaces per level', () => {
    assert.equal(
      formatted('<a><b><c><d>deep</d><e/></c></b></a>'),
      lines(
        '<a>',
        '  <b>',
        '    <c>',
        '      <d>deep</d>',
        '      <e/>',
        '    </c>',
        '  </b>',
        '</a>',
      ),
    );
  });

  function nested(depth: number): string {
    return `${'<a>'.repeat(depth)}<x/>${'</a>'.repeat(depth)}`;
  }

  it(`indents a line as deep as ${XML_MAX_DEPTH} levels`, () => {
    const text = formatted(nested(XML_MAX_DEPTH));
    const rows = text.split('\n');

    assert.equal(rows.length, XML_MAX_DEPTH * 2 + 1);
    assert.equal(rows[XML_MAX_DEPTH], `${'  '.repeat(XML_MAX_DEPTH)}<x/>`);
  });

  /**
   * The rendering of deep nesting grows with the square of its depth, so past
   * the limit the document is shown as stored rather than failing the panel.
   */
  it('reports deeper nesting as too deep rather than indenting it', () => {
    assert.equal(statusOf(nested(XML_MAX_DEPTH + 1)), 'too-deep');
  });

  /**
   * The pass is iterative: a recursive one would overflow the stack of the tab
   * showing the body rather than say anything about it.
   */
  it('reads 20 000 levels without overflowing the stack', () => {
    assert.equal(statusOf(nested(20_000)), 'too-deep');
    assert.equal(statusOf(`${nested(20_000)}<extra/>`), 'invalid');
  });

  /** Only indented depth counts: inside an element shown as stored nothing is indented. */
  it('keeps 20 000 levels inside an element with text as stored', () => {
    keptAsStored(`<r>text${nested(20_000)}</r>`);
  });
});

describe('formatXmlForDisplay: the root and what follows it', () => {
  const rejected = [
    '<a/>text',
    '<a/><b/>',
    '<a></a><a></a>',
    '<a/>&amp;',
    '<a/></a>',
    '<a/><!DOCTYPE a>',
    'text<a/>',
  ];

  for (const source of rejected) {
    it(`rejects trailing or leading content: ${JSON.stringify(source)}`, () => {
      assert.equal(statusOf(source), 'invalid');
    });
  }

  it('accepts white space, comments and processing instructions after the root', () => {
    assert.equal(
      formatted('<a/>\n<!-- end -->\r\n<?done?>\n\n'),
      lines('<a/>', '<!-- end -->', '<?done?>'),
    );
  });

  it('rejects a document with no root at all', () => {
    assert.equal(statusOf(''), 'invalid');
    assert.equal(statusOf(' \n\t'), 'invalid');
    assert.equal(statusOf('<!-- only a comment -->'), 'invalid');
    assert.equal(statusOf('<?pi only?>'), 'invalid');
  });
});

describe('formatXmlForDisplay: malformed input is never indented', () => {
  /**
   * The property D163 holds the tokenizer to, as D112 held the JSON one:
   * anything a forgiving parser would repair is reported, because the viewer's
   * job is to show what arrived rather than a repaired version of it.
   */
  const rejected = [
    '<br>',
    '<html><body><p>Hi<br></p></body></html>',
    '<p>one<p>two</p>',
    '<a><b></a></b>',
    '<a>',
    '<a><b/>',
    '</a>',
    '<a></A>',
    '< a/>',
    '<a/ >',
    '<a></ a>',
    '<1a/>',
    '<-a/>',
    '<a><!ELEMENT a ANY></a>',
    '<!doctype html><html></html>',
    `<a>${String.fromCharCode(1)}</a>`,
    `<a>${String.fromCharCode(0xffff)}</a>`,
    `<a>${String.fromCharCode(0xd800)}</a>`,
    'hello',
    '{"a":1}',
    '<',
    '<>',
  ];

  for (const source of rejected) {
    it(`rejects ${JSON.stringify(source)}`, () => {
      assert.equal(statusOf(source), 'invalid');
    });
  }
});

describe('formatXmlForDisplay: xml:space', () => {
  it('shows an element with xml:space="preserve" and everything inside it as stored', () => {
    assert.equal(
      formatted('<r><pre xml:space="preserve">\n  <b> x </b>\n</pre><c><d/></c></r>'),
      lines(
        '<r>',
        '  <pre xml:space="preserve">',
        '  <b> x </b>',
        '</pre>',
        '  <c>',
        '    <d/>',
        '  </c>',
        '</r>',
      ),
    );
  });

  /** One-directional, as the owner settled it: `default` does not undo `preserve`. */
  it('does not indent inside a preserved element where a descendant says default', () => {
    keptAsStored(`<r xml:space='preserve'> <a xml:space="default"> <b/> </a> </r>`);
  });

  it('keeps the prolog on its lines where the root itself is preserved', () => {
    assert.equal(
      formatted('<?xml version="1.0"?>\n\n<r xml:space="preserve"> <a/> </r>'),
      lines('<?xml version="1.0"?>', '<r xml:space="preserve"> <a/> </r>'),
    );
  });

  it('changes nothing where xml:space="default" is not inside a preserved element', () => {
    assert.equal(
      formatted('<r xml:space="default"><a/></r>'),
      lines('<r xml:space="default">', '  <a/>', '</r>'),
    );
  });

  /** Only `default` is taken to allow indentation; anything else is not guessed at. */
  it('treats any value but default as preserving', () => {
    assert.equal(
      formatted('<r><a xml:space="Preserve"> <b/> </a><c xml:space=""> <d/> </c></r>'),
      lines('<r>', '  <a xml:space="Preserve"> <b/> </a>', '  <c xml:space=""> <d/> </c>', '</r>'),
    );
  });

  it('reads only xml:space, not an attribute that is merely named space', () => {
    assert.equal(
      formatted('<r><a space="preserve"><b/></a></r>'),
      lines('<r>', '  <a space="preserve">', '    <b/>', '  </a>', '</r>'),
    );
  });
});

describe('formatXmlForDisplay: byte-order mark and leading white space', () => {
  it('drops white space before the root, which is display gap', () => {
    assert.equal(formatted('\n\t <r><a/></r>'), lines('<r>', '  <a/>', '</r>'));
  });

  it('replaces CRLF gaps with the computed line breaks', () => {
    assert.equal(formatted('<r>\r\n  <a/>\r\n</r>\r\n'), lines('<r>', '  <a/>', '</r>'));
  });

  /** XML 1.0 allows nothing before the declaration, white space included. */
  it('rejects white space before the declaration', () => {
    assert.equal(statusOf('\n<?xml version="1.0"?><a/>'), 'invalid');
  });

  /**
   * The backend decodes a body with a `TextDecoder` that removes a leading
   * byte-order mark, so a U+FEFF still at the start of a body is a character
   * before the root, and the document is not well-formed (D163).
   */
  it('rejects a U+FEFF at the start of the text', () => {
    assert.equal(statusOf(`${BYTE_ORDER_MARK}<a/>`), 'invalid');
    assert.equal(statusOf(`${BYTE_ORDER_MARK}<?xml version="1.0"?><a/>`), 'invalid');
  });
});

describe('formatXmlForDisplay: a document type declaration', () => {
  /**
   * A DTD can give an element `xml:space="preserve"` by default, as XHTML's
   * does for `pre`, and nothing here reads one, so no such document is indented.
   */
  it('never indents a well-formed document that has one', () => {
    assert.equal(statusOf('<!DOCTYPE note><note><to>x</to></note>'), 'doctype');
    assert.equal(
      statusOf(
        '<?xml version="1.0"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" ' +
          '"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html><body/></html>',
      ),
      'doctype',
    );
  });

  it('finds the end of an internal subset past brackets in literals, comments and PIs', () => {
    const subset = lines(
      '<!DOCTYPE a [',
      '  <!ENTITY e "]>">',
      "  <!ENTITY f ']'>",
      '  <!-- ] > -->',
      '  <?pi ]>?>',
      ']>',
      '<a>&e;&f;</a>',
    );

    assert.equal(statusOf(subset), 'doctype');
  });

  /** The HTML page most often seen: its DOCTYPE does not excuse a `<br>`. */
  it('still reports the rest of the document when it is not well-formed', () => {
    assert.equal(statusOf('<!DOCTYPE html><html><body>Hi<br></body></html>'), 'invalid');
    assert.equal(statusOf('<!DOCTYPE a><a/><b/>'), 'invalid');
  });

  it('rejects one after the root, a second one, one inside an element and one never closed', () => {
    assert.equal(statusOf('<a/><!DOCTYPE a>'), 'invalid');
    assert.equal(statusOf('<!DOCTYPE a><!DOCTYPE a><a/>'), 'invalid');
    assert.equal(statusOf('<a><!DOCTYPE a></a>'), 'invalid');
    assert.equal(statusOf('<!DOCTYPE a [ <!ENTITY e "x"> <a/>'), 'invalid');
    assert.equal(statusOf('<!DOCTYPE><a/>'), 'invalid');
  });
});

describe('formatXmlForDisplay: the 256 KiB ceiling', () => {
  it('indents a document just under the ceiling', () => {
    const filler = 'x'.repeat(JSON_FORMAT_MAX_BYTES - 100);

    assert.equal(statusOf(`<r><a>${filler}</a></r>`), 'formatted');
  });

  it('reports a document over the ceiling as too large, well-formed or not', () => {
    const filler = 'x'.repeat(JSON_FORMAT_MAX_BYTES);

    assert.equal(statusOf(`<r><a>${filler}</a></r>`), 'too-large');
    assert.equal(statusOf(`<br>${filler}`), 'too-large');
  });

  /** The ceiling counts bytes of UTF-8, as for JSON (D112). */
  it('counts multi-byte characters by their encoded size', () => {
    const twoBytes = String.fromCharCode(0xe9).repeat(JSON_FORMAT_MAX_BYTES / 2);

    assert.equal(statusOf(`<a>${twoBytes}</a>`), 'too-large');
  });
});

/**
 * Issue #64: XML is bounded by depth, like JSON, and not by the size of its
 * rendering, so a document under the ceiling could still be drawn as millions
 * of characters. It gets the same cap as JSON (D163, as amended for #64).
 */
describe('formatXmlForDisplay: the length cap', () => {
  const bytes = (source: string): number => new TextEncoder().encode(source).length;

  /** `unit` repeated inside `depth` elements, as many times as fit in `size` bytes. */
  function filled(depth: number, unit: string, size: number): string {
    const count = Math.floor((size - depth * 7) / unit.length);

    return `${'<a>'.repeat(depth)}${unit.repeat(count)}${'</a>'.repeat(depth)}`;
  }

  /**
   * `count` empty elements inside `depth` elements, the first named `b` and
   * `extra` more characters. Each takes a line of its own, `2 × depth` spaces
   * deep, so the rendering has `3 + (depth - 1)(depth + 4) + depth(depth + 4) +
   * count(2 × depth + 5) + extra` characters, and a tag is written as it
   * arrived: one more character in a name is one more in the rendering.
   */
  function leaves(depth: number, count: number, extra: number): string {
    const first = `<b${'b'.repeat(extra)}/>`;

    return `${'<a>'.repeat(depth)}${first}${'<b/>'.repeat(count - 1)}${'</a>'.repeat(depth)}`;
  }

  it('is the same cap as JSON', () => {
    assert.equal(FORMATTED_MAX_CHARACTERS, 2_000_000);
  });

  /** Measured for #64: indented, it was 14 518 774 characters. */
  it('reports <b><c/></b> repeated inside 99 elements as too long', () => {
    const body = filled(99, '<b><c/></b>', JSON_FORMAT_MAX_BYTES);

    assert.equal(bytes(body), 262_141);
    assert.deepEqual(formatXmlForDisplay(body), { status: 'too-long' });
  });

  it('indents a document that formats to exactly the cap, and not one character more', () => {
    const exact = leaves(99, 9_752, 50);

    assert.equal(formatted(exact).length, FORMATTED_MAX_CHARACTERS);
    assert.deepEqual(formatXmlForDisplay(leaves(99, 9_752, 51)), { status: 'too-long' });
  });

  /** What the boundary test above relies on: one more character in a name, one more drawn. */
  it('renders a name one character longer one character longer', () => {
    assert.equal(formatted(leaves(99, 10, 4)).length, formatted(leaves(99, 10, 3)).length + 1);
    assert.equal(formatted(leaves(2, 1, 0)), lines('<a>', '  <a>', '    <b/>', '  </a>', '</a>'));
  });

  /**
   * Plausible XML measured just under the ceiling for #64 stays well under the
   * cap and keeps its indentation.
   */
  it('keeps indenting <b/> three deep and <item><id>1</id></item> five deep', () => {
    const empties = filled(3, '<b/>', JSON_FORMAT_MAX_BYTES);
    const items = filled(5, '<item><id>1</id></item>', JSON_FORMAT_MAX_BYTES);

    assert.equal(bytes(empties), 262_141);
    assert.equal(formatted(empties).length, 720_868);
    assert.equal(bytes(items), 262_143);
    assert.equal(formatted(items).length, 661_052);
  });

  /** The reasons that were there before keep their place (D163). */
  it('reports a document that is also too deep, has a DOCTYPE or is not well-formed by that reason', () => {
    const long = filled(99, '<b><c/></b>', 200_000);

    assert.equal(statusOf(long), 'too-long');
    assert.equal(statusOf(`<r>${long}</r>`), 'too-deep');
    assert.equal(statusOf(`<!DOCTYPE a>${long}`), 'doctype');
    assert.equal(statusOf(`${long}<extra/>`), 'invalid');
    assert.equal(statusOf(`${long}${'x'.repeat(JSON_FORMAT_MAX_BYTES)}`), 'too-large');
  });
});

/**
 * The acceptance criterion as one property rather than as an enumeration:
 * **removing the indentation from the rendering gives back the stored text,
 * except for the white-space gaps between elements.**
 *
 * Every case above asserts one output exactly, which only catches the mistakes
 * somebody thought of. This catches any dropped, reordered or rewritten
 * character of markup or text in any of these documents.
 */
describe('formatXmlForDisplay: indenting only moves white-space gaps', () => {
  /**
   * White space between one `>` and the next `<`, and around the whole text,
   * removed. Written here rather than reused from the module, so a tokenizer
   * bug cannot hide behind the same bug in the check. It is applied to both
   * sides, so white space it also removes inside text that is kept as stored
   * is compared as removed on both.
   */
  function withoutGaps(text: string): string {
    return text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').replace(/>[ \t\r\n]+</g, '><');
  }

  const documents = [
    '<?xml version="1.0" encoding="UTF-8"?>\n<order id="42">\n  <item sku="A1">Widget</item>\n  <note>Leave at the <b>door</b>, please.</note>\n</order>\n',
    '<doc><p>Hello  <b>w</b>\n     again</p>\n<q/></doc>',
    '<a><![CDATA[if (a < b && c > d) </a><b>]]></a>',
    '<r><s><![CDATA[<x><y/></x>]]></s><t/></r>',
    '<!-- head --><?style href="a.css"?>\n\n<r><a/></r>  <!-- tail --><?done?>\n',
    '<r><!--  <a> </b>  --><?pi <c> > ??><d/></r>',
    `<r><a expr="x > 1" note='say "hi"'/></r>`,
    `<r><a  b = "1"\n   c='2'  /></r>`,
    '<r><a/><b></b><c> </c><d x="1" /></r>',
    '<soap:Envelope xmlns:soap="urn:s"><soap:Body><m:Ping xmlns:m="urn:x"><m:id>7</m:id></m:Ping></soap:Body></soap:Envelope>',
    '<r><a>&lt;tag&gt; &amp; &quot;&apos;</a><b>&#169; &#x1F600;</b><c/></r>',
    `<?xml  version = '1.0'  encoding='windows-1251' standalone="yes" ?>\r\n\r\n<a/>`,
    '<a><b><c><d>deep</d><e/></c></b></a>',
    '<a/>\n<!-- end -->\r\n<?done?>\n\n',
    '<r><pre xml:space="preserve">\n  <b> x </b>\n</pre><c><d/></c></r>',
    `<r xml:space='preserve'> <a xml:space="default"> <b/> </a> </r>`,
    '\n\t <r>\r\n  <a/>\r\n</r>\r\n',
    `<r><e>${String.fromCodePoint(0x1f600)} ${String.fromCharCode(0x4e2d)}</e></r>`,
  ];

  for (const source of documents) {
    it(`loses nothing but gaps from ${JSON.stringify(source)}`, () => {
      assert.equal(withoutGaps(formatted(source)), withoutGaps(source));
    });
  }

  /** The rendering is already in its own form: indenting it again changes nothing. */
  for (const source of documents) {
    it(`renders its own rendering unchanged for ${JSON.stringify(source)}`, () => {
      const once = formatted(source);

      assert.equal(formatted(once), once);
    });
  }
});

/**
 * The same check without the ceiling, which the build check reads the
 * changelog's Atom feeds with (D212): it agrees with `formatXmlForDisplay` on
 * what is well-formed, refuses a DOCTYPE, and reads a document far over
 * 256 KiB. No test reads a clock, which a loaded runner can miss without a
 * defect: the runner's timeout is the only bound on time.
 */
describe('isWellFormedXml', () => {
  it('agrees with the display check on what is well-formed', () => {
    for (const source of [
      '<a/>',
      '<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en"><id>x</id></feed>\n',
      '<r><a>&lt;p&gt;&amp;amp;&lt;/p&gt;</a></r>',
    ]) {
      assert.equal(isWellFormedXml(source), true, source);
      assert.equal(formatXmlForDisplay(source).status, 'formatted', source);
    }

    for (const source of [
      '',
      'text',
      '<a>',
      '<a></b>',
      '<a/><b/>',
      '<a>]]></a>',
      '<a>&nbsp;</a>',
      `<a>${String.fromCharCode(0)}</a>`,
      `<a>${String.fromCharCode(0xd800)}</a>`,
      '<a b="<"/>',
    ]) {
      assert.equal(isWellFormedXml(source), false, JSON.stringify(source));
      assert.equal(formatXmlForDisplay(source).status, 'invalid', JSON.stringify(source));
    }
  });

  it('refuses a document type declaration', () => {
    assert.equal(isWellFormedXml('<!DOCTYPE a><a/>'), false);
  });

  for (const size of [1_000, 10_000_000]) {
    it(`reads ${size.toLocaleString('en')} characters, the display ceiling no limit`, () => {
      const entry =
        '<entry><id>x</id><content type="html">&lt;p&gt;a &amp;amp; b&lt;/p&gt;</content></entry>';
      const document = `<feed>${entry.repeat(Math.ceil(size / entry.length))}</feed>`;

      assert.equal(isWellFormedXml(document), true);
      assert.equal(isWellFormedXml(`${document}<feed/>`), false);
      assert.equal(isWellFormedXml(document.slice(0, -1)), false);
    });
  }
});
