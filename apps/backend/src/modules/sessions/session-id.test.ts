/**
 * How a new session id is generated (D161, amending D004): 43 letters and
 * digits, drawn without modulo bias. Pure unit tests; no database.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  SESSION_ID_ALPHABET,
  SESSION_ID_LENGTH,
  SESSION_ID_PATTERN,
} from '@webhook-inspector/shared';
import { generateSessionId, SESSION_ID_BYTE_LIMIT, sessionIdSymbol } from './repository.ts';

/** A new id, spelled out rather than built from the constants it checks. */
const NEW_ID = /^[A-Za-z0-9]{43}$/;

const GENERATED_IDS = 10_000;

/**
 * The chi-square statistic's upper bound for 62 equally likely symbols: the
 * 1 - 10^-9 quantile of the chi-square distribution with 61 degrees of freedom,
 * 152.016, computed from the regularised incomplete gamma function (its 0.95
 * quantile, 80.232, matches the published tables). A correct generator exceeds
 * it about once in a billion runs, so the test does not flake; modulo bias over
 * the same sample scores about 2900 and cannot pass (see the last test).
 */
const CHI_SQUARE_LIMIT = 152.016;

/** Pearson's statistic of `symbols` against a uniform draw from the alphabet. */
function chiSquare(symbols: Iterable<string>): number {
  const counts = new Map<string, number>([...SESSION_ID_ALPHABET].map((symbol) => [symbol, 0]));
  let total = 0;

  for (const symbol of symbols) {
    const count = counts.get(symbol);

    assert.notEqual(count, undefined, `${JSON.stringify(symbol)} is not in the alphabet`);
    counts.set(symbol, (count ?? 0) + 1);
    total += 1;
  }

  const expected = total / SESSION_ID_ALPHABET.length;
  let statistic = 0;

  for (const count of counts.values()) {
    statistic += (count - expected) ** 2 / expected;
  }

  return statistic;
}

/** A byte source that hands out the given batches in order, and records the sizes asked for. */
function scriptedBytes(batches: number[][]): {
  random: (size: number) => Uint8Array;
  sizes: number[];
} {
  const sizes: number[] = [];

  return {
    sizes,
    random: (size) => {
      const batch = batches.shift();

      assert.ok(batch, 'the generator asked for more bytes than the script holds');
      assert.equal(batch.length, size, 'a scripted batch must be exactly the size asked for');
      sizes.push(size);

      return Uint8Array.from(batch);
    },
  };
}

describe('the session id alphabet and length (D161)', () => {
  it('is A-Z, a-z and 0-9, 62 distinct symbols, with no _ and no -', () => {
    assert.equal(
      SESSION_ID_ALPHABET,
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    );
    assert.equal(new Set(SESSION_ID_ALPHABET).size, 62);
    assert.doesNotMatch(SESSION_ID_ALPHABET, /[_-]/);
  });

  it('keeps 43 symbols, which is at least the 256 bits D004 asks for', () => {
    assert.equal(SESSION_ID_LENGTH, 43);
    assert.ok(SESSION_ID_LENGTH * Math.log2(SESSION_ID_ALPHABET.length) >= 256);
  });

  it('stays inside SESSION_ID_PATTERN, so validation did not have to change', () => {
    for (const symbol of SESSION_ID_ALPHABET) {
      assert.match(symbol.repeat(SESSION_ID_LENGTH), SESSION_ID_PATTERN);
    }
  });
});

describe('sessionIdSymbol', () => {
  it('uses bytes below 248, four times 62, and discards 248 to 255', () => {
    assert.equal(SESSION_ID_BYTE_LIMIT, 248);

    for (let byte = 248; byte <= 255; byte += 1) {
      assert.equal(sessionIdSymbol(byte), undefined, `byte ${byte} must be discarded`);
    }

    assert.equal(sessionIdSymbol(0), 'A');
    assert.equal(sessionIdSymbol(61), '9');
    assert.equal(sessionIdSymbol(62), 'A');
    assert.equal(sessionIdSymbol(247), '9');
  });

  /**
   * Unbiased by construction: over every possible byte, each symbol comes out
   * exactly four times, so a uniformly random byte that is kept yields each
   * symbol with probability 4/248 = 1/62.
   */
  it('reaches every symbol from exactly four of the 256 byte values', () => {
    const counts = new Map<string, number>();

    for (let byte = 0; byte <= 255; byte += 1) {
      const symbol = sessionIdSymbol(byte);

      if (symbol !== undefined) {
        counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
      }
    }

    assert.deepEqual(
      [...counts.keys()].sort(),
      [...SESSION_ID_ALPHABET].sort(),
      'every symbol, and nothing else',
    );
    assert.deepEqual(new Set(counts.values()), new Set([4]));
  });
});

describe('generateSessionId', () => {
  it('skips discarded bytes and draws again for exactly the symbols still missing', () => {
    const firstBatch = [255, 248, ...Array.from({ length: 41 }, (_, index) => index)];
    const { random, sizes } = scriptedBytes([firstBatch, [250, 61], [63]]);

    const id = generateSessionId(random);

    assert.deepEqual(sizes, [43, 2, 1]);
    assert.equal(id, `${SESSION_ID_ALPHABET.slice(0, 41)}9B`);
  });

  it('draws once when no byte is discarded', () => {
    const { random, sizes } = scriptedBytes([Array.from({ length: 43 }, () => 247)]);

    assert.equal(generateSessionId(random), '9'.repeat(43));
    assert.deepEqual(sizes, [43]);
  });

  describe(`over ${GENERATED_IDS} generated ids`, () => {
    const ids = Array.from({ length: GENERATED_IDS }, () => generateSessionId());

    it('each is 43 letters and digits, with no _ and no -, and still matches SESSION_ID_PATTERN', () => {
      for (const id of ids) {
        assert.match(id, NEW_ID);
        assert.doesNotMatch(id, /[_-]/);
        assert.match(id, SESSION_ID_PATTERN);
      }
    });

    it('none repeats', () => {
      assert.equal(new Set(ids).size, GENERATED_IDS);
    });

    it('every symbol occurs about equally often (chi-square, 61 degrees of freedom)', (t) => {
      const statistic = chiSquare(ids.join(''));

      t.diagnostic(
        `chi-square ${statistic.toFixed(2)} over ${GENERATED_IDS * SESSION_ID_LENGTH} symbols, limit ${CHI_SQUARE_LIMIT}`,
      );
      assert.ok(
        statistic < CHI_SQUARE_LIMIT,
        `chi-square ${statistic.toFixed(2)} is at or above ${CHI_SQUARE_LIMIT}: the symbols are not uniform`,
      );
    });

    /**
     * The same statistic over the same number of symbols, drawn the way D161
     * forbids - every byte folded with `% 62` - is expected near 2900, some 25
     * standard deviations above the limit. The test above can therefore see
     * modulo bias, and this one cannot flake either.
     */
    it('would catch modulo bias: byte % 62 over as many symbols fails the same limit', (t) => {
      const biased = [...randomBytes(GENERATED_IDS * SESSION_ID_LENGTH)].map(
        (byte) => SESSION_ID_ALPHABET[byte % SESSION_ID_ALPHABET.length] as string,
      );
      const statistic = chiSquare(biased);

      t.diagnostic(`chi-square of byte % 62: ${statistic.toFixed(2)}`);
      assert.ok(statistic > CHI_SQUARE_LIMIT, `modulo bias scored only ${statistic.toFixed(2)}`);
    });
  });
});
