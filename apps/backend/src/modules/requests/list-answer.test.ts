/**
 * How a list with content is written (D196): the streamed JSON array is,
 * byte for byte, what `JSON.stringify` writes for the entries with their
 * content added; the content is read only as fast as the answer is taken, a
 * body at a time; a body is written in bounded pieces; and requests gone
 * before their content was read are replaced by those that follow, at most
 * `MAX_RESUMPTIONS` times; and once the stream is destroyed, a client gone
 * included, nothing more is read and the list is not resumed.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import type { RequestListEntry } from '@webhook-inspector/shared';
import {
  BODY_PIECE_UNITS,
  jsonArrayStream,
  MAX_RESUMPTIONS,
  type ListedEntry,
  type ListMore,
  type ReadListedContent,
} from './list-answer.ts';
import { PLAIN_LIST, type ListQuery } from './list-query.ts';
import type { ListedContent, ListPosition } from './repository.ts';
import { transportBytes } from './transport.ts';

const HEADERS: ListQuery = { ...PLAIN_LIST, includeHeaders: true };
const BODY: ListQuery = { ...PLAIN_LIST, includeBody: true };
const BOTH: ListQuery = { ...PLAIN_LIST, includeHeaders: true, includeBody: true };

function entry(id: string): RequestListEntry {
  return {
    id,
    method: 'POST',
    receivedAt: '2026-10-04T09:00:00.000Z',
    bodySize: 0,
    sourceIp: '203.0.113.7',
    path: `/s/${id}`,
    response: { state: 'sent', status: 200, queueStep: null, rule: null },
  };
}

/** A reader over `contents` that records the ids of every read. */
function reader(contents: ReadonlyMap<string, ListedContent>): {
  read: ReadListedContent;
  reads: string[][];
} {
  const reads: string[][] = [];

  return {
    reads,
    read: async (requestIds) => {
      reads.push([...requestIds]);

      return new Map(
        requestIds.flatMap((id) => {
          const content = contents.get(id);

          return content === undefined ? [] : [[id, content] as const];
        }),
      );
    },
  };
}

/**
 * The answer as the list wrote it before content was read while writing: the
 * entry, then `headers`, then the body under the detail's rule (D043), built
 * whole and serialised by `JSON.stringify`. A request with no content is gone.
 */
function expected(
  entries: RequestListEntry[],
  contents: ReadonlyMap<string, ListedContent>,
  query: ListQuery,
): string {
  const kept = entries.flatMap((one) => {
    const content = contents.get(one.id);

    if (content === undefined) {
      return [];
    }

    const whole: RequestListEntry = { ...one };

    if (query.includeHeaders) {
      whole.headers = content.headers ?? [];
    }

    if (query.includeBody) {
      const body = transportBytes(content.body ?? Buffer.alloc(0));

      whole.body = body.text;
      whole.bodyBase64 = body.base64;
      whole.isBinary = body.isBinary;
    }

    return [whole];
  });

  return JSON.stringify(kept);
}

/** Where `one` stands: its time to the microsecond, made from its id so that each differs. */
function listed(one: RequestListEntry): ListedEntry {
  return { entry: one, receivedAt: `2026-10-04T09:00:00.000000Z#${one.id}` };
}

/** A list that must not resume: these tests give it no `limit`, or a full answer. */
const noMore: ListMore = async () => {
  throw new Error('the list resumed');
};

async function chunksOf(
  entries: RequestListEntry[],
  query: ListQuery,
  read: ReadListedContent,
  more: ListMore = noMore,
): Promise<Buffer[]> {
  const chunks: Buffer[] = [];

  for await (const chunk of jsonArrayStream(entries.map(listed), query, read, more)) {
    chunks.push(chunk as Buffer);
  }

  return chunks;
}

/** Streams `bodies`, one request each, and checks the answer against `expected`. */
async function assertWritten(bodies: (Buffer | undefined)[], query = BOTH): Promise<Buffer[]> {
  const entries = bodies.map((_, index) => entry(`r${index}`));
  const contents = new Map(
    bodies.map((body, index) => [
      `r${index}`,
      { headers: [['Content-Type', 'text/plain']] as [string, string][], body },
    ]),
  );
  const chunks = await chunksOf(entries, query, reader(contents).read);

  assert.equal(Buffer.concat(chunks).toString('utf8'), expected(entries, contents, query));

  return chunks;
}

const utf8 = (text: string) => Buffer.from(text, 'utf8');

/** The UTF-8 of `text` repeated until it is about `size` bytes. */
function repeated(text: string, size: number): Buffer {
  return utf8(text.repeat(Math.max(1, Math.ceil(size / utf8(text).length))));
}

describe('jsonArrayStream writes what JSON.stringify writes', () => {
  it('for no, one and many requests, with headers, a body or both', async () => {
    const contents = new Map<string, ListedContent>([
      ['a', { headers: [['X-One', '1']], body: utf8('one') }],
      ['b', { headers: [], body: Buffer.alloc(0) }],
      ['c', { headers: [['X-Q', '"quoted"\t\\']], body: utf8('"quoted" \u0001 Иван 😀') }],
      ['d', { headers: [['Content-Type', 'application/octet-stream']], body: randomBytes(64) }],
      ['e', {}],
    ]);

    for (const ids of [[], ['a'], ['a', 'b', 'c', 'd', 'e']]) {
      const entries = ids.map(entry);

      for (const query of [HEADERS, BODY, BOTH]) {
        const chunks = await chunksOf(entries, query, reader(contents).read);

        assert.equal(Buffer.concat(chunks).toString('utf8'), expected(entries, contents, query));
      }
    }
  });

  it('for text, binary, empty and absent bodies, under the detail’s rule (D043)', async () => {
    await assertWritten([
      utf8('{"orderId":42}'),
      Buffer.from([0xff, 0xfe, 0x00, 0x80]),
      Buffer.alloc(0),
      undefined,
      // A byte order mark is dropped by the decoder, as the detail drops it.
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('after the mark')]),
      Buffer.from([0x00, 0x01, 0x1f, 0x7f]),
      utf8('   </script>'),
    ]);
  });

  it('for surrogate pairs at and around every piece boundary', async () => {
    const pair = '😀';

    for (const before of [BODY_PIECE_UNITS - 2, BODY_PIECE_UNITS - 1, BODY_PIECE_UNITS]) {
      for (const filler of ['a', '\u0001']) {
        const text = `${filler.repeat(before)}${pair}${filler.repeat(BODY_PIECE_UNITS)}${pair}`;

        await assertWritten([utf8(text), utf8(pair.repeat(BODY_PIECE_UNITS + 1))], BODY);
      }
    }
  });

  it('for hostile bodies at growing sizes, each within a second', async () => {
    const shapes: [string, (size: number) => Buffer][] = [
      ['random bytes', (size) => randomBytes(size)],
      ['control characters', (size) => Buffer.alloc(size, 0x01)],
      ['quotes and backslashes', (size) => repeated('"\\', size)],
      ['two-byte text', (size) => repeated('Иван', size)],
      ['three-byte text', (size) => repeated('日本', size)],
      ['four-byte text', (size) => repeated('😀𝄞', size)],
      ['mixed text', (size) => repeated('a"\u0000\né€😀\\', size)],
      // Invalid UTF-8, so Base64: a sequence cut short at the very end, an
      // overlong slash, an encoded surrogate and a code point past U+10FFFF.
      [
        'a cut sequence',
        (size) => Buffer.concat([repeated('ab', size), Buffer.from([0xe2, 0x82])]),
      ],
      ['an overlong', (size) => Buffer.concat([repeated('ab', size), Buffer.from([0xc0, 0xaf])])],
      [
        'a surrogate',
        (size) => Buffer.concat([Buffer.from([0xed, 0xa0, 0x80]), repeated('a', size)]),
      ],
      [
        'past U+10FFFF',
        (size) => Buffer.concat([repeated('a', size), Buffer.from([0xf4, 0x90, 0x80, 0x80])]),
      ],
    ];

    for (const size of [1, 1024, 64 * 1024, 1024 * 1024]) {
      for (const [name, make] of shapes) {
        const started = performance.now();

        await assertWritten([make(size)], BODY);

        const elapsed = performance.now() - started;

        assert.ok(elapsed < 1000, `${name} at ${size} bytes took ${Math.round(elapsed)} ms`);
      }
    }
  });
});

describe('jsonArrayStream holds one body at a time', () => {
  it('writes a body in pieces of at most BODY_PIECE_UNITS units escaped', async () => {
    // Six bytes of JSON for each byte stored: the worst escape.
    const chunks = await assertWritten([Buffer.alloc(1024 * 1024, 0x01)], BODY);
    const largest = Math.max(...chunks.map((chunk) => chunk.length));

    assert.ok(chunks.length > 64, `${chunks.length} pieces`);
    assert.ok(largest <= 6 * (BODY_PIECE_UNITS + 1), `a piece of ${largest} bytes`);
  });

  it('reads one request’s content per read with a body, and 50 with headers alone', async () => {
    const entries = Array.from({ length: 120 }, (_, index) => entry(`r${index}`));
    const contents = new Map(entries.map((one) => [one.id, { headers: [], body: utf8('x') }]));

    for (const [query, sizes] of [
      [BODY, Array<number>(120).fill(1)],
      [BOTH, Array<number>(120).fill(1)],
      [HEADERS, [50, 50, 20]],
    ] as const) {
      const { read, reads } = reader(contents);

      await chunksOf(entries, query, read);
      assert.deepEqual(
        reads.map((ids) => ids.length),
        sizes,
      );
      assert.deepEqual(reads.flat(), ids(entries));
    }
  });

  it('reads the next body only once the pieces before have been taken', async () => {
    const entries = Array.from({ length: 5 }, (_, index) => entry(`r${index}`));
    const contents = new Map(
      entries.map((one) => [one.id, { body: Buffer.alloc(BODY_PIECE_UNITS * 2, 0x61) }]),
    );
    const { read, reads } = reader(contents);
    const stream = jsonArrayStream(entries.map(listed), BODY, read, noMore);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50));

    // Nothing is read before anybody reads.
    await pause();
    assert.equal(reads.length, 0);

    // A body is several pieces; a reader that takes one and waits has had
    // the first body read and nothing after it.
    const iterator = stream[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next();
    await pause();
    assert.equal(reads.length, 1, `${reads.length} of 5 bodies read after two pieces`);

    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
      // Drained.
    }

    assert.equal(reads.length, 5);
  });
});

describe('jsonArrayStream leaves the event loop to other requests (D201)', () => {
  it('writes one piece of a body per turn of the event loop, to a reader that takes them all at once', async () => {
    // A reader in flowing mode takes every piece as soon as it is made, as a
    // socket with room in its buffer does. Each piece is stamped with the
    // turn of the event loop it was made in, counted by an immediate that
    // queues itself again on every turn.
    const entries = [entry('a'), entry('b')];
    const contents = new Map(
      entries.map((one) => [one.id, { body: Buffer.alloc(1024 * 1024, 0x01) }] as const),
    );
    const { read } = reader(contents);
    let turn = 0;
    let ticking = true;
    const tick = (): void => {
      turn += 1;

      if (ticking) {
        setImmediate(tick);
      }
    };
    const turns: number[] = [];

    setImmediate(tick);
    await new Promise<void>((resolve, reject) => {
      const stream = jsonArrayStream(entries.map(listed), BODY, read, noMore);

      stream.on('data', () => turns.push(turn));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    ticking = false;

    const perTurn = new Map<number, number>();

    for (const stamp of turns) {
      perTurn.set(stamp, (perTurn.get(stamp) ?? 0) + 1);
    }

    // Two bodies of 64 pieces and more, so the answer spans as many turns:
    // at most the opening, an entry's head and its first body piece share one.
    assert.ok(turns.length > 128, `${turns.length} pieces`);
    assert.ok(perTurn.size >= 128, `${turns.length} pieces in ${perTurn.size} turns`);
    assert.ok(
      Math.max(...perTurn.values()) <= 3,
      `${Math.max(...perTurn.values())} pieces in one turn`,
    );
  });
});

describe('jsonArrayStream and requests gone since the list', () => {
  it('without a limit, writes the requests still there and asks for no more', async () => {
    const entries = ['a', 'b', 'c'].map(entry);

    for (const kept of [['b', 'c'], ['a', 'b'], ['a', 'c'], ['b'], []]) {
      const contents = new Map(kept.map((id) => [id, { headers: [], body: utf8(id) }]));

      for (const query of [HEADERS, BODY, BOTH]) {
        const written = Buffer.concat(await chunksOf(entries, query, reader(contents).read));

        assert.equal(written.toString('utf8'), expected(entries, contents, query));
        assert.deepEqual(ids(JSON.parse(written.toString('utf8')) as RequestListEntry[]), kept);
      }
    }
  });

  it('fails the stream when a read fails, rather than writing a partial array as whole', async () => {
    const entries = ['a', 'b'].map(entry);
    let calls = 0;
    const failing: ReadListedContent = async (requestIds) => {
      calls += 1;

      if (calls === 2) {
        throw new Error('connection lost');
      }

      return new Map(requestIds.map((id) => [id, { body: utf8(id) }]));
    };

    await assert.rejects(chunksOf(entries, BODY, failing), /connection lost/);
  });
});

/**
 * A session of `all`, in the list's order, whose requests in `gone` vanish
 * after they are chosen and before their content is read. `more` chooses as
 * the list statement would: the requests after `beyond`, in that order, gone
 * ones included, since each vanishes only once chosen. It records what it was
 * asked for and checks that `beyond` is where the last chosen request stood.
 */
function vanishing(all: readonly string[], gone: ReadonlySet<string>) {
  const asked: [string, number][] = [];
  const read: ReadListedContent = async (requestIds) =>
    new Map(
      requestIds
        .filter((id) => !gone.has(id))
        .map((id) => [id, { headers: [['X-Id', id]] as [string, string][], body: utf8(id) }]),
    );
  const more: ListMore = async (beyond: ListPosition, count) => {
    asked.push([beyond.id, count]);
    assert.equal(beyond.receivedAt, listed(entry(beyond.id)).receivedAt);

    const from = all.indexOf(beyond.id) + 1;

    assert.ok(from > 0, `resumed after ${beyond.id}, which was never chosen`);

    return all.slice(from, from + count).map((id) => listed(entry(id)));
  };

  return { asked, read, more };
}

/** What the answer holds when the list chose the first `limit` of `all`. */
async function answerOf(
  all: readonly string[],
  gone: ReadonlySet<string>,
  query: ListQuery,
): Promise<{ written: string[]; asked: [string, number][] }> {
  const { asked, read, more } = vanishing(all, gone);
  const chosen = all.slice(0, query.limit ?? all.length).map(entry);
  const text = Buffer.concat(await chunksOf(chosen, query, read, more)).toString('utf8');

  return { written: ids(JSON.parse(text) as RequestListEntry[]), asked };
}

const letters = (text: string): string[] => [...text];

describe('jsonArrayStream resumes the list where chosen requests are gone', () => {
  const limited = (query: ListQuery, limit: number): ListQuery => ({ ...query, limit });

  it('never ends empty while a request follows: limit 1, the chosen one gone', async () => {
    for (const query of [HEADERS, BODY, BOTH]) {
      const { written, asked } = await answerOf(letters('ab'), new Set('a'), limited(query, 1));

      assert.deepEqual(written, ['b']);
      assert.deepEqual(asked, [['a', 1]]);
    }
  });

  it('fills the answer from beyond the last request chosen, gone or not', async () => {
    for (const query of [HEADERS, BODY, BOTH]) {
      // The first and the last chosen are gone: two follow c.
      const both = await answerOf(letters('abcdefgh'), new Set('ac'), limited(query, 3));

      assert.deepEqual(both.written, letters('bde'));
      assert.deepEqual(both.asked, [['c', 2]]);

      // A middle one: one follows c.
      const middle = await answerOf(letters('abcdefgh'), new Set('b'), limited(query, 3));

      assert.deepEqual(middle.written, letters('acd'));
      assert.deepEqual(middle.asked, [['c', 1]]);
    }
  });

  it('resumes again when requests it resumed with are gone too', async () => {
    const { written, asked } = await answerOf(
      letters('abcdefgh'),
      new Set('abcd'),
      limited(BODY, 3),
    );

    assert.deepEqual(written, letters('efg'));
    assert.deepEqual(asked, [
      ['c', 3],
      ['f', 1],
    ]);
  });

  it('ends short only where nothing follows', async () => {
    // d is the last: the list after it is empty.
    const last = await answerOf(letters('abcd'), new Set('bd'), limited(BODY, 3));

    assert.deepEqual(last.written, letters('ac'));
    assert.deepEqual(last.asked, [
      ['c', 1],
      ['d', 1],
    ]);

    // Every request gone: the answer is empty, and the list ran to its end.
    const none = await answerOf(letters('abcde'), new Set('abcde'), limited(HEADERS, 2));

    assert.deepEqual(none.written, []);
    assert.deepEqual(none.asked, [
      ['b', 2],
      ['d', 2],
    ]);
  });

  it('does not resume a list that chose fewer than its limit, nor one with no limit', async () => {
    // Fewer than asked for: nothing followed when the list chose.
    const short = vanishing(letters('ab'), new Set('b'));
    const text = Buffer.concat(
      await chunksOf(['a', 'b'].map(entry), limited(BODY, 5), short.read, short.more),
    ).toString('utf8');

    assert.deepEqual(ids(JSON.parse(text) as RequestListEntry[]), ['a']);
    assert.deepEqual(short.asked, []);

    // No limit: the list chose every request there was.
    const all = await answerOf(letters('abc'), new Set('c'), HEADERS);

    assert.deepEqual(all.written, letters('ab'));
    assert.deepEqual(all.asked, []);
  });

  it('does not resume an answer that is full', async () => {
    const { written, asked } = await answerOf(letters('abcdef'), new Set('ef'), limited(BOTH, 4));

    assert.deepEqual(written, letters('abcd'));
    assert.deepEqual(asked, []);
  });

  it('never writes more than limit, whatever a resumption answers', async () => {
    const generous: ListMore = async () => letters('xyz').map((id) => listed(entry(id)));
    // `a` is gone.
    const { read } = vanishing(letters('abxyz'), new Set('a'));
    const text = Buffer.concat(
      await chunksOf(['a', 'b'].map(entry), limited(BODY, 2), read, generous),
    ).toString('utf8');

    assert.deepEqual(ids(JSON.parse(text) as RequestListEntry[]), ['b', 'x']);
  });

  it('writes, byte for byte, what JSON.stringify writes for the requests it kept', async () => {
    const all = letters('abcdefghij');
    const gone = new Set('adeh');
    const { read, more } = vanishing(all, gone);
    const contents = new Map<string, ListedContent>(
      all
        .filter((id) => !gone.has(id))
        .map((id) => [id, { headers: [['X-Id', id]], body: utf8(id) }]),
    );

    for (const query of [HEADERS, BODY, BOTH]) {
      const capped = limited(query, 4);
      const text = Buffer.concat(
        await chunksOf(all.slice(0, 4).map(entry), capped, read, more),
      ).toString('utf8');

      assert.equal(text, expected(letters('bcfg').map(entry), contents, capped));
    }
  });

  it('fails the stream when a resumption fails, rather than ending the array short', async () => {
    const { read } = vanishing(letters('abc'), new Set('b'));
    const failing: ListMore = async () => {
      throw new Error('every slot taken');
    };

    await assert.rejects(
      chunksOf(['a', 'b'].map(entry), limited(BODY, 2), read, failing),
      /every slot taken/,
    );
  });

  it(`resumes ${MAX_RESUMPTIONS} times at most, then cuts the answer off unfinished`, async () => {
    // limit 1, so that each resumption takes the next request alone.
    const all = Array.from({ length: MAX_RESUMPTIONS + 2 }, (_, index) => `r${index}`);

    for (const query of [HEADERS, BODY]) {
      const capped = limited(query, 1);

      // The first MAX_RESUMPTIONS requests gone: the last resumption allowed
      // finds the one after them.
      const within = await answerOf(all, new Set(all.slice(0, MAX_RESUMPTIONS)), capped);

      assert.deepEqual(within.written, [all[MAX_RESUMPTIONS]]);
      assert.equal(within.asked.length, MAX_RESUMPTIONS);

      // One more gone: the answer would need one more resumption, and fails
      // after the '[' it wrote, never closed as an empty array.
      const { asked, read, more } = vanishing(all, new Set(all.slice(0, MAX_RESUMPTIONS + 1)));
      const chunks: Buffer[] = [];

      await assert.rejects(
        collect(jsonArrayStream([listed(entry('r0'))], capped, read, more), chunks),
        new RegExp(`resumed ${MAX_RESUMPTIONS} times`),
      );
      assert.equal(asked.length, MAX_RESUMPTIONS);
      assert.equal(Buffer.concat(chunks).toString('utf8'), '[');
    }
  });

  it('cuts off, after what it wrote, a list whose requests never stop vanishing', async () => {
    for (const query of [HEADERS, BODY]) {
      // `a` is written; every request after it is gone, and more always follow.
      const list = endless();
      const read: ReadListedContent = async (requestIds) => {
        await list.read(requestIds);

        return new Map(
          requestIds.filter((id) => id === 'a').map((id) => [id, { headers: [], body: utf8(id) }]),
        );
      };
      const chunks: Buffer[] = [];

      await assert.rejects(
        collect(
          jsonArrayStream(letters('ab').map(entry).map(listed), limited(query, 2), read, list.more),
          chunks,
        ),
        new RegExp(`resumed ${MAX_RESUMPTIONS} times`),
      );
      assert.equal(list.counts.resumptions, MAX_RESUMPTIONS);

      const text = Buffer.concat(chunks).toString('utf8');

      assert.ok(text.startsWith('[{"id":"a"'), text);
      assert.ok(!text.endsWith(']'), text);
    }
  });

  it('answers the first limit requests still there, for any requests gone, at growing sizes', async () => {
    // A seeded generator, so that a failure names a case that runs again the same.
    let seed = 0x2f6e2b1;
    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;

      return seed / 2 ** 32;
    };
    let whole = 0;
    let cut = 0;

    for (const size of [1, 10, 100, 1000]) {
      const all = Array.from({ length: size }, (_, index) => `r${index}`);

      for (const share of [0, 0.1, 0.5, 0.9, 1]) {
        for (const query of [HEADERS, BODY]) {
          const cap = query.includeBody ? 20 : 1000;
          const limit = 1 + Math.floor(random() * Math.min(size, cap));
          const gone = new Set(all.filter(() => random() < share));
          const needed = resumptionsNeeded(all, gone, limit);
          const where = `${size} requests, ${gone.size} gone, limit ${limit}, ${needed} resumptions`;
          const started = performance.now();

          if (needed <= MAX_RESUMPTIONS) {
            const { written, asked } = await answerOf(all, gone, limited(query, limit));

            assert.deepEqual(written, all.filter((id) => !gone.has(id)).slice(0, limit), where);
            assert.equal(asked.length, needed, where);
            // Each resumption asks for no more than the answer has room for.
            assert.ok(
              asked.every(([, count]) => count >= 1 && count <= limit),
              where,
            );
            whole += 1;
          } else {
            const { asked, read, more } = vanishing(all, gone);
            const chosen = all.slice(0, limit).map(entry).map(listed);
            const chunks: Buffer[] = [];

            await assert.rejects(
              collect(jsonArrayStream(chosen, limited(query, limit), read, more), chunks),
              new RegExp(`resumed ${MAX_RESUMPTIONS} times`),
              where,
            );
            assert.equal(asked.length, MAX_RESUMPTIONS, where);
            assert.ok(!Buffer.concat(chunks).toString('utf8').endsWith(']'), where);
            cut += 1;
          }

          const elapsed = performance.now() - started;

          assert.ok(elapsed < 1000, `${where} took ${Math.round(elapsed)} ms`);
        }
      }
    }

    // Both outcomes were met.
    assert.ok(whole > 0 && cut > 0, `${whole} whole, ${cut} cut off`);
  });
});

/**
 * How many times a list of `all` with `gone` vanishing resumes before its
 * answer is whole, counted apart from the stream: the first choice is the
 * first `limit`, each resumption the next as many as are missing, and it ends
 * when the answer is full or a choice comes back short.
 */
function resumptionsNeeded(
  all: readonly string[],
  gone: ReadonlySet<string>,
  limit: number,
): number {
  const kept = (page: readonly string[]) => page.filter((id) => !gone.has(id)).length;
  let next = Math.min(limit, all.length);
  let pageLength = next;
  let asked = limit;
  let written = kept(all.slice(0, next));
  let resumptions = 0;

  while (pageLength > 0 && pageLength === asked && written < limit) {
    asked = limit - written;

    const page = all.slice(next, next + asked);

    resumptions += 1;
    written += kept(page);
    next += page.length;
    pageLength = page.length;
  }

  return resumptions;
}

/** Reads `stream` into `chunks`, so that what was written before a failure can be seen. */
async function collect(stream: Readable, chunks: Buffer[]): Promise<void> {
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
}

/**
 * A list whose requests are all gone when their content is read, and which
 * always has more to resume with: each resumption answers as many new
 * requests as it is asked for. It counts reads and resumptions. The `hold`th
 * read or resumption waits, once `held` has settled, until `release` is
 * called. Past `GUARD` resumptions it fails, so that a stream that never
 * stops ends its test instead of hanging it.
 */
function endless(hold: { read?: number; resume?: number } = {}) {
  const GUARD = 50;
  const counts = { reads: 0, resumptions: 0 };
  let reached = (): void => undefined;
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fresh = 0;

  const read: ReadListedContent = async () => {
    counts.reads += 1;

    if (counts.reads === hold.read) {
      reached();
      await released;
    }

    return new Map();
  };
  const more: ListMore = async (_beyond, count) => {
    counts.resumptions += 1;

    if (counts.resumptions > GUARD) {
      throw new Error('the list never stopped');
    }

    if (counts.resumptions === hold.resume) {
      reached();
      await released;
    }

    return Array.from({ length: count }, () => listed(entry(`m${fresh++}`)));
  };

  return { counts, read, more, held, release };
}

/** Waits until `condition` holds, failing past `timeoutMs` instead of hanging. */
async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await delay(5);
  }
}

/** Resolves when `stream` closes, with the error it failed with, if any. */
function closing(stream: Readable): Promise<Error | undefined> {
  let failure: Error | undefined;

  stream.on('error', (error: Error) => {
    failure = error;
  });

  return new Promise((resolve) => {
    stream.once('close', () => resolve(failure));
  });
}

describe('jsonArrayStream stops once the stream is destroyed', () => {
  const chosen = letters('ab').map(entry).map(listed);

  it('reads nothing more and does not resume once destroyed during a content read', async () => {
    for (const query of [HEADERS, BODY]) {
      const list = endless({ read: 1 });
      const stream = jsonArrayStream(chosen, { ...query, limit: 2 }, list.read, list.more);
      const closed = closing(stream);

      stream.resume();
      await list.held;
      stream.destroy();
      list.release();

      const failure = await closed;

      assert.deepEqual(list.counts, { reads: 1, resumptions: 0 });
      assert.equal(failure, undefined);
    }
  });

  it('reads nothing more once destroyed during a resumption', async () => {
    for (const [query, reads] of [
      [HEADERS, 1],
      [BODY, 2],
    ] as const) {
      const list = endless({ resume: 1 });
      const stream = jsonArrayStream(chosen, { ...query, limit: 2 }, list.read, list.more);
      const closed = closing(stream);

      stream.resume();
      await list.held;
      stream.destroy();
      list.release();

      const failure = await closed;

      assert.deepEqual(list.counts, { reads, resumptions: 1 });
      assert.equal(failure, undefined);
    }
  });

  it('reads nothing more once destroyed while a body is written', async () => {
    const contents = new Map(
      letters('ab').map((id) => [id, { body: Buffer.alloc(BODY_PIECE_UNITS * 3, 0x61) }]),
    );
    const { read, reads } = reader(contents);
    const stream = jsonArrayStream(chosen, { ...BODY, limit: 2 }, read, noMore);
    const closed = closing(stream);
    const iterator = stream[Symbol.asyncIterator]();

    // '[', the head of `a`, and the first piece of its body.
    await iterator.next();
    await iterator.next();
    await iterator.next();
    stream.destroy();

    const failure = await closed;

    assert.deepEqual(reads, [['a']]);
    assert.equal(failure, undefined);
  });

  it('reads nothing more and does not resume once the client of a Fastify answer is gone', async () => {
    const list = endless({ read: 1 });
    const sent: { answer: Readable | null } = { answer: null };
    const app = Fastify();

    app.get('/list', (_request, reply) => {
      sent.answer = jsonArrayStream(chosen, { ...HEADERS, limit: 2 }, list.read, list.more);

      return reply.type('application/json; charset=utf-8').send(sent.answer);
    });

    try {
      await app.listen({ host: '127.0.0.1', port: 0 });

      const { port } = app.server.address() as AddressInfo;
      const request = http.get({ host: '127.0.0.1', port, path: '/list' });

      request.on('error', () => undefined);

      const response = await new Promise<http.IncomingMessage>((resolve) => {
        request.once('response', resolve);
      });

      response.on('error', () => undefined);
      response.resume();
      assert.equal(response.statusCode, 200);

      // The answer is waiting on its first content read.
      await list.held;

      const stream = sent.answer;

      assert.ok(stream !== null);

      const closed = closing(stream);

      request.destroy();
      // Fastify destroys the answer once it sees the response close.
      await until(() => stream.destroyed, 'the answer to be destroyed');
      list.release();

      const failure = await closed;

      assert.deepEqual(list.counts, { reads: 1, resumptions: 0 });
      assert.equal(failure, undefined);
    } finally {
      list.release();
      await app.close();
    }
  });
});

function ids(entries: RequestListEntry[]): string[] {
  return entries.map((one) => one.id);
}
