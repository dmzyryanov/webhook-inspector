import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { contrastRatio, relativeLuminance } from './contrast.ts';
import { STATUS_PILL_COLOURS, type StatusClass } from './status-pill.ts';

/**
 * The palette is read from `index.css` on disk rather than restated here, so a
 * token edited in one place and not the other fails this test instead of
 * passing it (D131). The ink tier is claimed on every background it is drawn
 * on; beyond it only the pairs the describes below name are, each on its own
 * background: the status pill's codes on their tints (D207), the link, and the
 * search notice. `ok`, `danger`, `method` and `accent` are interface colours
 * outside this test's claim, and so are alpha variants such as
 * `text-ink-mark/40` — they appear only on disabled controls, which WCAG 1.4.3
 * exempts.
 */
const SRC = new URL('..', import.meta.url);
const THEME = /@theme\s*\{([^}]*)\}/;
const TOKEN = /--color-([a-z0-9-]+):\s*(#[0-9a-f]{6});/g;

/** WCAG AA for text below 18.66 px, which is every size these tokens are used at. */
const AA_SMALL_TEXT = 4.5;

/** Cards, dialogs and the landing page sit on plain white, which is not a token. */
const WHITE = '#ffffff';

/**
 * Every background the ink tier is rendered on, beside white. This is a fact
 * about the components rather than about the palette, so it stays a hand list.
 */
const BACKGROUND_TOKENS = ['canvas', 'field', 'code', 'row-unread', 'row-selected', 'panel-note'];

/** The ink tokens this test was written for; the tier itself is read from the file. */
const KNOWN_TEXT_TOKENS = [
  'ink',
  'ink-body',
  'ink-strong',
  'ink-muted',
  'ink-size',
  'ink-id',
  'ink-mark',
];

/** The muted tier D131 collapsed into `--color-ink-muted`. */
const REMOVED_TOKENS = ['ink-soft', 'ink-faint', 'ink-meta'];

/** `text-ink`, `text-ink-muted`, `placeholder:text-ink-muted`, `text-ink-mark/40`. */
const INK_CLASS = /(?:placeholder:)?text-(ink(?:-[a-z0-9]+)*)/g;

function themeTokens(): Map<string, string> {
  const [, block] = THEME.exec(readFileSync(new URL('index.css', SRC), 'utf8')) ?? [];
  if (block === undefined) throw new Error('index.css has no @theme block');
  const tokens = new Map<string, string>();
  for (const [, name, hex] of block.matchAll(TOKEN)) {
    // Both groups are present whenever the pattern matched; this satisfies the types.
    if (name !== undefined && hex !== undefined) tokens.set(name, hex);
  }
  return tokens;
}

const tokens = themeTokens();

/** Every `ink` token the file defines, so one added later is measured too. */
const textTokens = [...tokens.keys()].filter((name) => name === 'ink' || name.startsWith('ink-'));

function colour(name: string): string {
  const hex = tokens.get(name);
  if (hex === undefined) throw new Error(`index.css defines no --color-${name}`);
  return hex;
}

describe('contrastRatio', () => {
  it('spans the WCAG range', () => {
    assert.equal(contrastRatio('#ffffff', '#000000'), 21);
    assert.equal(contrastRatio('#000000', '#ffffff'), 21);
    assert.equal(contrastRatio('#5f697d', '#5f697d'), 1);
    assert.equal(relativeLuminance('#ffffff'), 1);
    assert.equal(relativeLuminance('#000000'), 0);
  });

  it('refuses anything that is not a six-digit hex colour', () => {
    assert.throws(() => relativeLuminance('#fff'), /six-digit/);
    assert.throws(() => relativeLuminance('white'), /six-digit/);
  });
});

describe('the ink tier in index.css', () => {
  const backgrounds: Array<[string, string]> = [
    ['white', WHITE],
    ...BACKGROUND_TOKENS.map((name): [string, string] => [name, colour(name)]),
  ];

  it('defines every ink token this test was written for', () => {
    for (const token of KNOWN_TEXT_TOKENS) {
      assert.ok(
        textTokens.includes(token),
        `--color-${token} is gone from index.css, so nothing above measured it`,
      );
    }
  });

  for (const token of textTokens) {
    it(`keeps ${token} at AA on every background it is rendered on`, () => {
      const foreground = colour(token);
      for (const [name, background] of backgrounds) {
        const ratio = contrastRatio(foreground, background);
        assert.ok(
          ratio >= AA_SMALL_TEXT,
          `${token} ${foreground} on ${name} ${background} is ${ratio.toFixed(2)}:1, ` +
            `below the AA minimum of ${AA_SMALL_TEXT}:1 for small text`,
        );
      }
    });
  }

  it('no longer defines the muted tokens that collapsed into it (D131)', () => {
    for (const token of REMOVED_TOKENS) {
      assert.equal(
        tokens.has(token),
        false,
        `--color-${token} is back in index.css; the muted tier is --color-ink-muted alone (D131)`,
      );
    }
  });
});

describe('the ink classes the components use', () => {
  it('name a token index.css defines', () => {
    // `.ts` as well as `.tsx`: a class string moved into a helper must not
    // escape this check. Test files render nothing and are skipped.
    const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
      (file) => /\.tsx?$/.test(file) && !file.includes('.test.'),
    );
    let checked = 0;
    for (const file of files) {
      for (const [used, name] of readFileSync(new URL(file, SRC), 'utf8').matchAll(INK_CLASS)) {
        if (name === undefined) continue;
        checked += 1;
        assert.ok(
          tokens.has(name),
          `${file} uses ${used} but index.css defines no --color-${name}`,
        );
      }
    }
    assert.ok(checked > 0, 'no text-ink class was found at all, so this scan proves nothing');
  });
});

/**
 * The border of a white secondary control on white (issues #51 and #61, D158).
 * With `--color-line` the endpoint card's response button all but lost its
 * outline beside the filled Copy and read smaller than it; `--color-line-strong`
 * is the value chosen to give it a boundary. Since #61 it is `#9aa2b1`,
 * 2.57:1 on white: below the 3:1 WCAG 1.4.11 asks of a control's boundary, on
 * purpose, since the controls stay known by their label, caret and place, so
 * this test no longer holds it to 3:1. What it holds
 * instead is the value itself, and that a control's line stays darker than a
 * container's.
 */
describe('the control boundary in index.css', () => {
  it('is the owner-approved #9aa2b1', () => {
    assert.equal(colour('line-strong'), '#9aa2b1');
  });

  it('stays darker than the container line, --color-line', () => {
    assert.ok(
      relativeLuminance(colour('line-strong')) < relativeLuminance(colour('line')),
      `line-strong ${colour('line-strong')} is not darker than line ${colour('line')}`,
    );
  });

  it('is what the quiet button, the response button and a typed value draw their border with', () => {
    const button = readFileSync(new URL('components/ui/button.tsx', SRC), 'utf8');
    const responseSwitch = readFileSync(
      new URL('components/SessionResponseSwitch.tsx', SRC),
      'utf8',
    );

    assert.match(button, /quiet: 'border border-line-strong /);
    assert.match(responseSwitch, /rounded-\[7px\] border border-line-strong bg-white px-4/);
    // The quick switch's typed status and delay: a valid value takes the
    // controls' line, untouched the container's, invalid the danger colour (#61).
    assert.match(
      responseSwitch,
      /invalid \? 'border-danger' : typed \? 'border-line-strong' : 'border-line'/,
    );
    assert.doesNotMatch(responseSwitch, /border-ink\b/);
  });

  /** The header's `API docs` link is small text on white, so it is held to AA. */
  it('keeps the link colour at AA on white', () => {
    const ratio = contrastRatio(colour('link'), WHITE);

    assert.ok(ratio >= AA_SMALL_TEXT, `link on white is ${ratio.toFixed(2)}:1`);
  });
});

/**
 * The line above the quick switch's Response queue section (issue #142,
 * D206): #b8bfcc, chosen a little lighter than the darker line first
 * drawn, `--color-line-strong`, and darker than the container line, so the
 * section reads as a feature of its own rather than one more part of the
 * session response, as the soft line it had in 0.46.0 made it read.
 */
describe('the queue section line in index.css', () => {
  it('is the owner-approved #b8bfcc', () => {
    assert.equal(colour('line-section'), '#b8bfcc');
  });

  it('sits between the container line and the control boundary', () => {
    const section = relativeLuminance(colour('line-section'));

    assert.ok(section < relativeLuminance(colour('line')), 'not darker than --color-line');
    assert.ok(section > relativeLuminance(colour('line-strong')), 'not lighter than line-strong');
  });

  it('is what the sections draw their line with, and nothing else is', () => {
    const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
      (file) => /\.tsx?$/.test(file) && !file.includes('.test.'),
    );
    const users = files.filter((file) =>
      /\bborder-line-section\b/.test(readFileSync(new URL(file, SRC), 'utf8')),
    );

    // The Response rules section under the queue's is drawn as it is (issue #226, R2).
    assert.deepEqual(users.sort(), [
      'components/ResponseQueueSection.tsx',
      'components/ResponseRulesSection.tsx',
    ]);

    for (const file of users) {
      const section = readFileSync(new URL(file, SRC), 'utf8');

      assert.match(section, /className="mt-4 border-t border-line-section pt-4"/, file);
      assert.doesNotMatch(section, /border-t border-line-soft/, file);
    }
  });
});

/**
 * The notice that headers and bodies were not searched (issue #78, D191): 12 px
 * text and a 12 px Retry on the notice's own amber, and the same text at 13 px
 * on white where the reason moves into the empty result.
 */
describe('the search notice in index.css', () => {
  it('is drawn in the approved colours', () => {
    assert.equal(colour('notice'), '#fff7e6');
    assert.equal(colour('notice-line'), '#f1dfb4');
    assert.equal(colour('notice-text'), '#5c4813');
  });

  it('keeps its text and its Retry at AA on its background, and its text on white', () => {
    for (const [what, foreground, background] of [
      ['the text on the notice', colour('notice-text'), colour('notice')],
      ['Retry on the notice', colour('link'), colour('notice')],
      ['the text on white', colour('notice-text'), WHITE],
    ] as const) {
      const ratio = contrastRatio(foreground, background);

      assert.ok(ratio >= AA_SMALL_TEXT, `${what} is ${ratio.toFixed(2)}:1`);
    }
  });
});

/**
 * The move banner (issue #321, D276; Figma `Webhook Inspector · Move banner
 * (#321)`, C1): 13 px text in the
 * brand colour and its 13 px action in the link colour on the light-blue
 * bar, `--color-row-selected`, with a 1 px line of its own below it.
 */
describe('the move banner in index.css', () => {
  it('is drawn in the approved colours', () => {
    assert.equal(colour('row-selected'), '#e7f0ff');
    assert.equal(colour('move-line'), '#c9dcfa');
    assert.equal(colour('brand'), '#1f2e52');
    assert.equal(colour('link'), '#1f5ca8');
  });

  it('keeps its text and its action at AA on the bar', () => {
    for (const [what, foreground] of [
      ['the text', colour('brand')],
      ['the action', colour('link')],
    ] as const) {
      const ratio = contrastRatio(foreground, colour('row-selected'));

      assert.ok(ratio >= AA_SMALL_TEXT, `${what} on the bar is ${ratio.toFixed(2)}:1`);
    }
  });

  it('is the one user of its line, and draws its text and action in those colours', () => {
    const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
      (file) => /\.tsx?$/.test(file) && !file.includes('.test.'),
    );
    const users = files.filter((file) =>
      /\bborder-move-line\b/.test(readFileSync(new URL(file, SRC), 'utf8')),
    );

    assert.deepEqual(users, ['components/MoveBanner.tsx']);

    const banner = readFileSync(new URL('components/MoveBanner.tsx', SRC), 'utf8');

    assert.match(banner, /border-b border-move-line bg-row-selected/);
    assert.match(banner, /<p className="text-brand">/);
    assert.match(banner, /font-semibold text-link underline/);
  });
});

/**
 * The status pill (issue #138, D207; Figma page `Webhook Inspector · Response
 * status colour`, sub-variant C1): the code of an answer the session gave, 14
 * px in the Response half's heading and 11 px in a list row, on the tint of its
 * class. Each code is small text on its own tint, and is held at AA there; the
 * tint is what it is drawn on, on a white, selected or unread row alike.
 */
describe('the status pill in index.css', () => {
  const APPROVED: Record<StatusClass, { tint: string; code: string }> = {
    '2xx': { tint: '#e1f2e8', code: '#166b41' },
    '3xx': { tint: '#eaedf2', code: '#475266' },
    '4xx': { tint: '#fcefd2', code: '#5c4813' },
    '5xx': { tint: '#fde6e6', code: '#b82e2e' },
  };

  /** `bg-status-2xx text-status-2xx-ink`: the tint's and the code's tokens. */
  function pillTokens(statusClass: StatusClass): { tint: string; code: string } {
    const classes = STATUS_PILL_COLOURS[statusClass];
    const tint = /(?:^|\s)bg-([a-z0-9-]+)/.exec(classes)?.[1];
    const code = /(?:^|\s)text-([a-z0-9-]+)/.exec(classes)?.[1];

    if (tint === undefined || code === undefined) {
      throw new Error(`the ${statusClass} pill names no tint or no code colour: ${classes}`);
    }

    return { tint, code };
  }

  it('is drawn in the approved colours', () => {
    for (const [statusClass, approved] of Object.entries(APPROVED) as Array<
      [StatusClass, { tint: string; code: string }]
    >) {
      const { tint, code } = pillTokens(statusClass);

      assert.equal(colour(tint), approved.tint, `the ${statusClass} tint, --color-${tint}`);
      assert.equal(colour(code), approved.code, `the ${statusClass} code, --color-${code}`);
    }
  });

  it('gives each class a tint and a code colour of its own', () => {
    for (const statusClass of Object.keys(APPROVED) as StatusClass[]) {
      assert.deepEqual(pillTokens(statusClass), {
        tint: `status-${statusClass}`,
        code: `status-${statusClass}-ink`,
      });
    }
  });

  for (const statusClass of Object.keys(APPROVED) as StatusClass[]) {
    it(`keeps the ${statusClass} code at AA on its own tint`, () => {
      const { tint, code } = pillTokens(statusClass);
      const ratio = contrastRatio(colour(code), colour(tint));

      assert.ok(
        ratio >= AA_SMALL_TEXT,
        `the ${statusClass} code ${colour(code)} on its tint ${colour(tint)} is ` +
          `${ratio.toFixed(2)}:1, below the AA minimum of ${AA_SMALL_TEXT}:1 for small text`,
      );
    });
  }

  /**
   * Why the 2xx code is not `--color-ok`: that green falls below AA on the 2xx
   * tint, as it did on a selected or unread row, which D131 recorded and this
   * pill resolves for the list.
   */
  it('draws the 2xx code darker than --color-ok, which is below AA on the tint', () => {
    const tint = colour('status-2xx');

    assert.ok(contrastRatio(colour('ok'), tint) < AA_SMALL_TEXT);
    assert.ok(contrastRatio(colour('status-2xx-ink'), tint) >= AA_SMALL_TEXT);
    assert.ok(relativeLuminance(colour('status-2xx-ink')) < relativeLuminance(colour('ok')));
  });

  /**
   * Only the code that draws a status is read, from `from` to the closing
   * brace of the function `through` starts, so a `text-ok` elsewhere in the
   * same file — a copy's confirmation, as `CopyCodeButton` draws — is not this
   * test's business.
   */
  const STATUS_PATHS = [
    {
      file: 'components/RequestList.tsx',
      from: 'const STATUS_TEXT_CLASS',
      through: 'function rowStatusClassName(',
    },
    {
      file: 'components/RequestDetail.tsx',
      from: 'function ResponseStatus(',
      through: 'function ResponseStatus(',
    },
  ];

  for (const { file, from, through } of STATUS_PATHS) {
    it(`draws a status in ${file} with the pill, never the interface green`, () => {
      const source = readFileSync(new URL(file, SRC), 'utf8');
      const start = source.indexOf(from);
      const last = start === -1 ? -1 : source.indexOf(through, start);
      const end = last === -1 ? -1 : source.indexOf('\n}\n', last);

      assert.ok(start !== -1 && end !== -1, `${file} no longer has ${from} … ${through}`);

      const path = source.slice(start, end + 2);

      assert.match(path, /statusPillClassName\(/, `${file} draws no status pill`);
      assert.doesNotMatch(path, /\btext-ok\b/, `${file} still draws a status in --color-ok`);
    });
  }
});
