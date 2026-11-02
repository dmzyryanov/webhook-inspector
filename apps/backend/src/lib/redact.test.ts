import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { SESSION_ID_ALPHABET, SESSION_ID_PATTERN } from '@webhook-inspector/shared';
import { generateSessionId } from '../modules/sessions/repository.ts';
import { withinBound } from '../testing/timing.ts';
import { createRedactingStream, redactSessionIds } from './redact.ts';

/** An id of the older, Base64URL shape, with `_` and `-` (D004). */
const ID = 'Q_oXWuKbz84pCqWskPOSoZlQuhK3KOuKy-8zID_JSmw';

/** A made-up id of the newer shape, letters and digits only (D161). */
const LETTERS_ID = 'Rk3vQ8mXw2LpT7nBz4YcH9sJd6FgN1qWx5VbK0rMtP2';

/** A request id, which is not an access key, of the shape the API gives one. */
const REQUEST_ID = '0b6b7c1e-3f4a-4d6e-9c1b-2a5f8e7d6c4b';

/** Asserts that no part of the segment beyond its first 8 characters survived. */
function assertOnlyPrefixLeft(output: string, segment: string): void {
  for (let start = 0; start + 9 <= segment.length; start += 1) {
    const piece = segment.slice(start, start + 9);

    assert.equal(output.includes(piece), false, `"${piece}" reached the output: ${output}`);
  }
}

describe('redactSessionIds', () => {
  it('keeps only the first 8 characters of a session id', () => {
    assert.equal(redactSessionIds(`/api/sessions/${ID}`), '/api/sessions/Q_oXWuKb...');
  });

  it('leaves text without a session id untouched', () => {
    assert.equal(redactSessionIds('/api/sessions'), '/api/sessions');
    assert.equal(redactSessionIds('/api/sessions/hello'), '/api/sessions/hello');
  });

  it('redacts every occurrence', () => {
    const other = 'AAAAAAAAbbbbbbbbccccccccddddddddeeeeeeeeFFF';

    assert.equal(redactSessionIds(`/s/${ID}/x/${other}`), '/s/Q_oXWuKb.../x/AAAAAAAA...');
  });

  it('redacts an id embedded in prose, not only in a path', () => {
    assert.equal(
      redactSessionIds(`no row for ${ID} in sessions`),
      'no row for Q_oXWuKb... in sessions',
    );
  });

  it('does not leak the remainder of the id', () => {
    assert.equal(redactSessionIds(`/api/sessions/${ID}`).includes(ID.slice(8)), false);
  });

  it('redacts a new id, letters and digits only, as it does an older one (D161)', () => {
    const id = generateSessionId();

    assert.equal(redactSessionIds(`/s/${id}`), `/s/${id.slice(0, 8)}...`);
  });
});

describe('redactSessionIds, in a session-id position of a URL (D168)', () => {
  const NEAR = ID.slice(0, 42);
  const REDACTED = 'Q_oXWuKb...';

  it('shortens a segment of 42 and of 44 id characters', () => {
    for (const segment of [NEAR, `${ID}x`]) {
      const output = redactSessionIds(`/api/sessions/${segment}`);

      assert.equal(output, `/api/sessions/${REDACTED}`);
      assertOnlyPrefixLeft(output, segment);
    }
  });

  it('shortens a segment with a stray character in its middle or at its end', () => {
    for (const segment of [`${ID.slice(0, 21)}.${ID.slice(21)}`, `${NEAR}.`]) {
      const output = redactSessionIds(`/api/sessions/${segment}`);

      assert.equal(output, `/api/sessions/${REDACTED}`);
      assertOnlyPrefixLeft(output, segment);
    }
  });

  it('shortens a segment holding a percent-encoded character', () => {
    // The 21st character, `o`, written as `%6F`.
    const segment = 'Q_oXWuKbz84pCqWskPOS%6FZlQuhK3KOuKy-8zID_JSmw';
    const output = redactSessionIds(`/s/${segment}`);

    assert.equal(output, `/s/${REDACTED}`);
    assertOnlyPrefixLeft(output, segment);
  });

  it('applies after each of the four prefixes', () => {
    for (const prefix of ['/s/', '/v/', '/api/sessions/', '/ws/']) {
      assert.equal(redactSessionIds(`${prefix}${NEAR}`), `${prefix}${REDACTED}`);
    }
  });

  it('shortens the path inside a JSON url field and keeps the line valid JSON', () => {
    const line = JSON.stringify({
      level: 30,
      req: { method: 'GET', url: `/api/sessions/${NEAR}` },
      msg: `request "/s/${NEAR}" answered 404`,
    });
    const output = redactSessionIds(line);

    assert.deepEqual(JSON.parse(output), {
      level: 30,
      req: { method: 'GET', url: `/api/sessions/${REDACTED}` },
      msg: `request "/s/${REDACTED}" answered 404`,
    });
    assertOnlyPrefixLeft(output, NEAR);
  });

  it('shortens the path inside a free-text message', () => {
    assert.equal(
      redactSessionIds(`no session for GET https://qa-tools.ru/s/${NEAR} from a scanner`),
      `no session for GET https://qa-tools.ru/s/${REDACTED} from a scanner`,
    );
  });

  it('keeps a query string or a fragment after the segment intact', () => {
    assert.equal(
      redactSessionIds(`/s/${NEAR}?token=abc&page=2`),
      `/s/${REDACTED}?token=abc&page=2`,
    );
    assert.equal(redactSessionIds(`/v/${NEAR}#top`), `/v/${REDACTED}#top`);
  });

  it('leaves a request id after /requests/ unchanged', () => {
    assert.equal(
      redactSessionIds(`/api/sessions/${NEAR}/requests/${REQUEST_ID}`),
      `/api/sessions/${REDACTED}/requests/${REQUEST_ID}`,
    );
    assert.equal(
      redactSessionIds(`/api/sessions/${ID}/requests/${REQUEST_ID}`),
      `/api/sessions/${REDACTED}/requests/${REQUEST_ID}`,
    );
  });

  it('still shortens a valid 43-character id outside any URL', () => {
    assert.equal(
      redactSessionIds(JSON.stringify({ session: ID, msg: `lookup of ${ID} failed` })),
      JSON.stringify({ session: REDACTED, msg: `lookup of ${REDACTED} failed` }),
    );
  });

  it('leaves a segment of 8 characters or fewer unchanged', () => {
    for (const text of ['/s/abcdefgh', '/api/sessions/x', '/ws/', '/v/12345678?x=1']) {
      assert.equal(redactSessionIds(text), text);
    }

    assert.equal(redactSessionIds('/s/abcdefghi'), '/s/abcdefgh...');
  });

  it("does not end the segment at `'`, so a key split by one is not logged", () => {
    for (const segment of [
      `${ID.slice(0, 8)}'${ID.slice(8)}`,
      `${ID.slice(0, 21)}'${ID.slice(21)}`,
    ]) {
      const raw = redactSessionIds(`/s/${segment}`);

      assert.equal(raw, `/s/${REDACTED}`);
      assertOnlyPrefixLeft(raw, segment);
      assertOnlyPrefixLeft(raw, ID);

      const line = redactSessionIds(JSON.stringify({ req: { url: `/s/${segment}` } }));

      assert.equal(line, JSON.stringify({ req: { url: `/s/${REDACTED}` } }));
      assertOnlyPrefixLeft(line, segment);
      assertOnlyPrefixLeft(line, ID);
    }
  });

  it('shortens the segment after a prefix that is itself a segment', () => {
    for (const text of [`/s/s/${NEAR}`, `/v/s/${NEAR}`, `/api/sessions/s/${NEAR}`]) {
      const output = redactSessionIds(text);

      assert.equal(output, text.replace(NEAR, REDACTED));
      assertOnlyPrefixLeft(output, NEAR);
    }
  });

  it('reads /api/sessions/ as one prefix and /news/ as none', () => {
    assert.equal(
      redactSessionIds(`/api/sessions/${NEAR}/response`),
      `/api/sessions/${REDACTED}/response`,
    );
    assert.equal(redactSessionIds(`/news/${NEAR}`), `/news/${NEAR}`);
    assert.equal(redactSessionIds(`/api/news/${NEAR}`), `/api/news/${NEAR}`);
  });

  it('looks past a doubled slash after the prefix', () => {
    for (const prefix of ['/api/sessions//', '/s//', '/ws///']) {
      const output = redactSessionIds(`${prefix}${NEAR}`);

      assert.equal(output, `${prefix}${REDACTED}`);
      assertOnlyPrefixLeft(output, NEAR);
    }
  });

  it('counts characters in code points, never splitting one outside the BMP', () => {
    // U+1F600 is two UTF-16 units: 8 units would end inside it, or one short.
    assert.equal(redactSessionIds('/s/abcdefg\u{1F600}hijk'), '/s/abcdefg\u{1F600}...');
    assert.equal(redactSessionIds('/s/ab\u{1F600}cdefghijk'), '/s/ab\u{1F600}cdefg...');
    assert.equal(redactSessionIds('/s/abcdefg\u{1F600}'), '/s/abcdefg\u{1F600}');
  });

  it('gives the same line when applied to a line already redacted', () => {
    const once = redactSessionIds(`/api/sessions/${NEAR}/requests/${REQUEST_ID} ${ID}`);

    assert.equal(redactSessionIds(once), once);
  });
});

describe('redactSessionIds, a session id glued to other id characters (D059, issue #176)', () => {
  /**
   * Letters and digits in neither id, so that in the output every character
   * of an id can be told from the padding around it.
   */
  const ABSENT = [...SESSION_ID_ALPHABET]
    .filter((character) => !ID.includes(character) && !LETTERS_ID.includes(character))
    .join('');

  /** `length` characters of `characters`, taken in turn. */
  function padding(characters: string, length: number): string {
    return Array.from({ length }, (_, index) => characters[index % characters.length]).join('');
  }

  /**
   * What is left of the id in the output: every character that is neither
   * padding, nor the `...` the rule writes, nor the brackets around the run.
   * The padding holds no character of the id, so whatever is left came from
   * the id.
   */
  function leftOfId(output: string, paddingCharacters: string): string {
    return [...output]
      .filter((character) => !`${paddingCharacters}.()`.includes(character))
      .join('');
  }

  it('uses two made-up ids and padding that holds none of their characters', () => {
    assert.match(ID, SESSION_ID_PATTERN);
    assert.match(LETTERS_ID, SESSION_ID_PATTERN);
    assert.match(LETTERS_ID, /^[A-Za-z0-9]+$/);
    assert.ok(ABSENT.length >= 4, ABSENT);
  });

  it('keeps no more than the first 8 of an id after one id character or after 42', () => {
    const before42 = 'a'.repeat(42);

    for (const id of [ID, LETTERS_ID]) {
      const one = redactSessionIds(`x${id}`);
      const many = redactSessionIds(`${before42}${id}`);

      assert.equal(one, `x${id.slice(0, 7)}...`);
      assert.equal(many, 'aaaaaaaa...');
      assertOnlyPrefixLeft(one, id);
      assertOnlyPrefixLeft(many, id);
      assert.equal(leftOfId(many, 'a'), '');
    }
  });

  it('leaves of an id with 0 to 129 id characters on either side at most its first 8', () => {
    for (const [id, characters] of [
      [ID, ABSENT],
      [LETTERS_ID, ABSENT],
      [LETTERS_ID, '-'],
      [LETTERS_ID, '_'],
      [LETTERS_ID, `${ABSENT}-_`],
    ] as const) {
      for (let before = 0; before <= 129; before += 1) {
        for (let after = 0; after <= 129; after += 1) {
          const run = `${padding(characters, before)}${id}${padding(characters, after)}`;
          const output = redactSessionIds(`(${run})`);
          const left = leftOfId(output, characters);
          const label = `${before} before and ${after} after, of ${JSON.stringify(characters)}`;

          // The whole run is one token: its first 8 characters and `...`.
          assert.equal(output, `(${run.slice(0, 8)}...)`, label);
          // So what is left of the id is a prefix of it, of 8 characters at
          // most, and as many as the padding before it leaves room for.
          assert.ok(id.startsWith(left) && left.length <= 8, `${label}: "${left}" is left`);
          assert.equal(left, id.slice(0, Math.max(0, 8 - before)), label);
          assert.equal(redactSessionIds(output), output, label);
        }
      }
    }
  });

  it('keeps the first 8 of an id that starts the run, alone or with a suffix', () => {
    for (const text of [ID, `${ID}x`, `${ID}-extra_suffix`, `${ID}${'z'.repeat(100)}`]) {
      assert.equal(redactSessionIds(text), 'Q_oXWuKb...', text);
      assert.equal(redactSessionIds(`lookup of ${text} failed`), 'lookup of Q_oXWuKb... failed');
    }
  });

  it('leaves no more than the first 8 of an id glued to an id, a UUID, a word or dashes', () => {
    for (const [text, expected] of [
      [`${ID}${LETTERS_ID}`, 'Q_oXWuKb...'],
      [`${LETTERS_ID}${ID}`, 'Rk3vQ8mX...'],
      [`${REQUEST_ID}_${ID}`, '0b6b7c1e...'],
      [`${REQUEST_ID}-${ID}`, '0b6b7c1e...'],
      [`session-${ID}`, 'session-...'],
      [`session_${ID}`, 'session_...'],
      [`--${ID}`, '--Q_oXWu...'],
      [`__${LETTERS_ID}`, '__Rk3vQ8...'],
    ] as const) {
      const output = redactSessionIds(`id=${text};`);

      assert.equal(output, `id=${expected};`, text);
      assertOnlyPrefixLeft(output, ID);
      assertOnlyPrefixLeft(output, LETTERS_ID);
      assert.equal(redactSessionIds(output), output, text);
    }
  });

  it('leaves nothing of the second of two ids, whatever stands between them', () => {
    for (let between = 0; between <= 86; between += 1) {
      const output = redactSessionIds(`${LETTERS_ID}${padding(ABSENT, between)}${ID}`);

      assert.equal(output, 'Rk3vQ8mX...', String(between));
      assertOnlyPrefixLeft(output, LETTERS_ID);
      assertOnlyPrefixLeft(output, ID);
      assert.equal(output.includes(ID.slice(0, 4)), false, String(between));
    }
  });

  it('leaves no more than the first 8 after what JSON writes before a control character', () => {
    const value = {
      newline: `line\n${ID}`,
      tab: `\t${ID}`,
      return: `\r${LETTERS_ID}`,
      escape: `\u001b${ID}`,
    };
    const output = redactSessionIds(JSON.stringify(value));

    // `\n` leaves `n` before the id, `\u001b` leaves `u001b`: one run each,
    // whose first 8 characters keep the escape whole.
    assert.deepEqual(JSON.parse(output), {
      newline: 'line\nQ_oXWuK...',
      tab: '\tQ_oXWuK...',
      return: '\rRk3vQ8m...',
      escape: '\u001bQ_o...',
    });
    assertOnlyPrefixLeft(output, ID);
    assertOnlyPrefixLeft(output, LETTERS_ID);
    assert.equal(redactSessionIds(output), output);
  });

  it('catches a glued id in a sub-path, a query string or a fragment, or after no prefix', () => {
    const near = ID.slice(0, 42);

    for (const [text, expected] of [
      [`/api/sessions/${near}/requests/x${ID}`, '/api/sessions/Q_oXWuKb.../requests/xQ_oXWuK...'],
      [`/s/abc?ref=session-${ID}&page=2`, '/s/abc?ref=session-...&page=2'],
      [`/v/abc#${'a'.repeat(42)}${ID}`, '/v/abc#aaaaaaaa...'],
      [`/news/x${ID}`, '/news/xQ_oXWuK...'],
      [`/s/x${ID}`, '/s/xQ_oXWuK...'],
      [
        `/api/sessions/${ID}/requests/${REQUEST_ID}_${ID}`,
        '/api/sessions/Q_oXWuKb.../requests/0b6b7c1e...',
      ],
    ] as const) {
      const output = redactSessionIds(text);

      assert.equal(output, expected, text);
      assertOnlyPrefixLeft(output, ID);
      assert.equal(redactSessionIds(output), output, text);
    }
  });
});

describe('redactSessionIds, in time linear in what a client sends (D168)', () => {
  const LENGTH = 64 * 1024;
  const SLASHES = '/'.repeat(LENGTH);
  const NEAR = ID.slice(0, 42);

  /**
   * A linear pattern takes well under a millisecond on these lines; the
   * quadratic one this replaced took from one to seven seconds. A node:test
   * timeout cannot interrupt a synchronous regular expression, so the time is
   * measured instead.
   */
  const LIMIT_MS = 250;

  function assertRedactsQuickly(input: string, expected: string): void {
    const started = performance.now();
    const output = redactSessionIds(input);
    const elapsed = performance.now() - started;

    assert.equal(output, expected);
    assert.ok(elapsed < LIMIT_MS, `${elapsed.toFixed(1)} ms for ${input.length} characters`);
  }

  it('handles 64 KiB of slashes after a prefix, after none, in a query and in version', () => {
    for (const input of [
      `/s${SLASHES}`,
      `/x/${SLASHES}`,
      `${SLASHES}s`,
      `/s/abc?q=${SLASHES}`,
      JSON.stringify({ req: { method: 'GET', url: `/s/abc?q=${SLASHES}`, version: SLASHES } }),
    ]) {
      assertRedactsQuickly(input, input);
    }
  });

  it('handles 64 KiB of slashes between a prefix and a near miss', () => {
    assertRedactsQuickly(`/s${SLASHES}${NEAR}`, `/s${SLASHES}Q_oXWuKb...`);
    assertRedactsQuickly(
      JSON.stringify({ req: { url: `/api/sessions${SLASHES}${NEAR}`, version: SLASHES } }),
      JSON.stringify({ req: { url: `/api/sessions${SLASHES}Q_oXWuKb...`, version: SLASHES } }),
    );
  });

  it('handles 64 KiB of what the other shapes are made of', () => {
    const idCharacters = 'a'.repeat(LENGTH);
    const nearMisses = `${NEAR}.`.repeat(Math.ceil(LENGTH / 43));
    const prefixes = '/s'.repeat(LENGTH / 2);
    const sessions = '/api/sessions/'.repeat(Math.ceil(LENGTH / 14));

    // The free-text rule: runs one short of an id at every offset, and one
    // run it takes whole.
    assertRedactsQuickly(nearMisses, nearMisses);
    assertRedactsQuickly(idCharacters, 'aaaaaaaa...');
    // The positional rule: one long segment, and a prefix at every other
    // character.
    assertRedactsQuickly(`/s/${idCharacters}`, '/s/aaaaaaaa...');
    assertRedactsQuickly(prefixes, prefixes);
    assertRedactsQuickly(sessions, sessions);
  });

  /**
   * Lines of `length` characters or a little more, built of the runs an id
   * may be glued into (issue #176), each with what the free-text rule writes.
   */
  function gluedShapes(length: number): [string, string, string][] {
    const times = (unit: string): number => Math.ceil(length / unit.length);
    const nearMiss = `${'b'.repeat(42)}.`;
    const spaced = `x${ID} `;

    return [
      ['one run of a letter', 'a'.repeat(length), 'aaaaaaaa...'],
      ['one run of `-`', '-'.repeat(length), '--------...'],
      ['`a-` in turn', 'a-'.repeat(times('a-')), 'a-a-a-a-...'],
      [
        '42 id characters and `.`, repeated',
        nearMiss.repeat(times(nearMiss)),
        nearMiss.repeat(times(nearMiss)),
      ],
      [
        '42 id characters and an id, repeated',
        `${'a'.repeat(42)}${ID}`.repeat(times(`${'a'.repeat(42)}${ID}`)),
        'aaaaaaaa...',
      ],
      ['`x` and an id, repeated', `x${ID}`.repeat(times(`x${ID}`)), 'xQ_oXWuK...'],
      [
        '`x`, an id and a space, repeated',
        spaced.repeat(times(spaced)),
        'xQ_oXWuK... '.repeat(times(spaced)),
      ],
      ['a run of that length, then an id', `${'a'.repeat(length)}${ID}`, 'aaaaaaaa...'],
    ];
  }

  it('handles 16 KiB and 64 KiB of the runs an id may be glued into (issue #176)', () => {
    for (const length of [16 * 1024, LENGTH]) {
      for (const [, input, expected] of gluedShapes(length)) {
        assertRedactsQuickly(input, expected);
      }
    }
  });

  it('handles 1 MiB of them in linear time (issue #176)', () => {
    // Sixteen times the length of the lines above, with four times their bound
    // and the fastest of five runs held to it (`withinBound`). Linear, the
    // slowest of these shapes takes under 100 ms; quadratic, minutes.
    for (const [name, input, expected] of gluedShapes(1024 * 1024)) {
      assert.equal(
        withinBound(4 * LIMIT_MS, () => redactSessionIds(input)),
        expected,
        name,
      );
    }
  });
});

describe('createRedactingStream', () => {
  function capture(): { stream: Writable; written: () => string } {
    let output = '';

    const destination = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });

    return { stream: createRedactingStream(destination), written: () => output };
  }

  it('redacts whatever passes through it, whatever its shape', () => {
    const { stream, written } = capture();

    stream.write(JSON.stringify({ msg: `failed for ${ID}`, stack: `at load (${ID})` }));

    assert.equal(written().includes(ID), false);
    assert.equal(written().includes('Q_oXWuKb...'), true);
  });

  it('shortens a near miss of an id in a URL as it passes (D168)', () => {
    const { stream, written } = capture();
    const near = ID.slice(0, 42);

    stream.write(`${JSON.stringify({ req: { url: `/api/sessions/${near}.` } })}\n`);

    assert.equal(written(), `${JSON.stringify({ req: { url: '/api/sessions/Q_oXWuKb...' } })}\n`);
  });

  it('leaves no more than the first 8 of an id glued to other id characters (issue #176)', () => {
    const { stream, written } = capture();

    stream.write(
      `${JSON.stringify({
        req: { url: `/x/${'a'.repeat(42)}${ID}?ref=session-${ID}` },
        msg: `no row for x${ID}`,
        err: { stack: `Error: ${REQUEST_ID}_${ID}\n    at load (${ID}${ID})` },
      })}\n`,
    );

    assert.equal(
      written(),
      `${JSON.stringify({
        req: { url: '/x/aaaaaaaa...?ref=session-...' },
        msg: 'no row for xQ_oXWuK...',
        err: { stack: 'Error: 0b6b7c1e...\n    at load (Q_oXWuKb...)' },
      })}\n`,
    );
    assertOnlyPrefixLeft(written(), ID);
  });
});
