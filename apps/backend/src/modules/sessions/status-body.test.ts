/**
 * The rules of the status read's body that need no server (D199): what it
 * accepts, what it refuses and with which message, in the order of the
 * checks, and hostile bodies up to the body limit - `accessKeys` (D245)
 * included.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_BODY_BYTES, MAX_SESSION_STATUS_IDS } from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import {
  ACCESS_KEYS_RULE,
  ID_RULE,
  IDS_RULE,
  KEYS_RULE,
  parseStatusBody,
  REPEATED_ID_RULE,
  type StatusBody,
} from './status-body.ts';

/** A well-formed id, different for every `n`. */
function id(n: number): string {
  return `S${String(n).padStart(6, '0')}${'x'.repeat(36)}`;
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, n) => id(n));
}

function body(value: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ids: value, ...extra });
}

/** The ids `parseStatusBody` answers `rawBody` with. */
function idsOf(rawBody: string): string[] {
  return parseStatusBody(rawBody).ids;
}

/** A key of a key's shape, different for every `n`. */
function key(n: number): string {
  return `K${String(n).padStart(6, '0')}${'k'.repeat(36)}`;
}

/** The refusal `parseStatusBody` answers `rawBody` with. */
function refusal(rawBody: string | undefined): AppError {
  try {
    parseStatusBody(rawBody);
  } catch (error) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);

    return error;
  }

  throw new assert.AssertionError({ message: 'the body was accepted' });
}

function assertRefused(rawBody: string | undefined, errorCode: number, message: string): void {
  const error = refusal(rawBody);

  assert.equal(error.statusCode, 400);
  assert.equal(error.errorCode, errorCode);
  assert.equal(error.message, message);
}

describe('the limits the rules are written with', () => {
  it('are the documented ones', () => {
    assert.equal(MAX_SESSION_STATUS_IDS, 50);
    assert.equal(IDS_RULE, 'ids must be an array of 1 to 50 session ids');
    assert.equal(ID_RULE, 'Each id must be a session id: 43 characters of A-Z, a-z, 0-9, _ and -');
  });
});

describe('parseStatusBody: what it accepts', () => {
  it('answers with the ids in the order given', () => {
    const given = [id(3), id(1), id(2)];

    assert.deepEqual(idsOf(body(given)), given);
  });

  it('accepts 1 id and 50 ids', () => {
    assert.deepEqual(idsOf(body([id(0)])), [id(0)]);
    assert.deepEqual(idsOf(body(ids(50))), ids(50));
  });

  it('accepts an id of the older Base64URL shape, with _ and -', () => {
    const older = `Au6JqVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2m_-MKss`;

    assert.equal(older.length, 43);
    assert.deepEqual(idsOf(body([older])), [older]);
  });

  it('takes the last `ids` when the key is repeated, as JSON.parse does', () => {
    assert.deepEqual(idsOf(`{"ids":["nope"],"ids":["${id(7)}"]}`), [id(7)]);
  });

  it('ignores whitespace around the JSON', () => {
    assert.deepEqual(idsOf(` \n{"ids":["${id(1)}"]}\t `), [id(1)]);
  });

  it('sends no key when accessKeys is absent, as every body before D245', () => {
    assert.deepEqual(parseStatusBody(body([id(1)])).accessKeys, new Map());
  });
});

describe('parseStatusBody: accessKeys (D245)', () => {
  it('answers the key sent beside each id it names, and none for the others', () => {
    const parsed = parseStatusBody(
      body([id(1), id(2), id(3)], { accessKeys: { [id(2)]: key(2) } }),
    );

    assert.deepEqual(parsed.ids, [id(1), id(2), id(3)]);
    assert.deepEqual([...parsed.accessKeys], [[id(2), key(2)]]);
  });

  it('accepts an empty object, a key beside every one of 50 ids, and a key of the older shape', () => {
    assert.deepEqual(parseStatusBody(body([id(1)], { accessKeys: {} })).accessKeys, new Map());

    const all = Object.fromEntries(ids(50).map((one, n) => [one, key(n)]));

    assert.equal(parseStatusBody(body(ids(50), { accessKeys: all })).accessKeys.size, 50);

    const older = 'Au6JqVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2m_-MKss';

    assert.equal(
      parseStatusBody(body([id(1)], { accessKeys: { [id(1)]: older } })).accessKeys.get(id(1)),
      older,
    );
  });

  it('takes the last value of a name repeated, as JSON.parse does', () => {
    const parsed = parseStatusBody(
      `{"ids":["${id(1)}"],"accessKeys":{"${id(1)}":"${key(1)}","${id(1)}":"${key(2)}"}}`,
    );

    assert.equal(parsed.accessKeys.get(id(1)), key(2));
  });

  const cases: [string, unknown][] = [
    ['null', null],
    ['a string', key(1)],
    ['an array', [key(1)]],
    ['an array of pairs', [[id(1), key(1)]]],
    ['a number', 1],
    ['true', true],
    ['a name not among ids', { [id(9)]: key(1) }],
    ['a name that is no id', { other: key(1) }],
    ['a key that is not a string', { [id(1)]: 42 }],
    ['a key that is null', { [id(1)]: null }],
    ['a key that is an object', { [id(1)]: { key: key(1) } }],
    ['an empty key', { [id(1)]: '' }],
    ['a key of 42 characters', { [id(1)]: key(1).slice(1) }],
    ['a key of 44 characters', { [id(1)]: `${key(1)}x` }],
    ['a key with a space', { [id(1)]: ` ${key(1).slice(1)}` }],
    ['a key with a dot', { [id(1)]: `${key(1).slice(1)}.` }],
    ['a key with a line break', { [id(1)]: `${key(1)}\n` }],
    ['a key with a letter outside ASCII', { [id(1)]: `${key(1).slice(1)}ж` }],
    ['a Bearer value', { [id(1)]: `Bearer ${key(1)}` }],
  ];

  for (const [description, value] of cases) {
    it(`refuses ${description} with 1014`, () => {
      assertRefused(body([id(1)], { accessKeys: value }), 1014, ACCESS_KEYS_RULE);
    });
  }

  it('refuses a __proto__ name, a constructor name and more names than ids', () => {
    assertRefused(
      `{"ids":["${id(1)}"],"accessKeys":{"__proto__":"${key(1)}"}}`,
      1014,
      ACCESS_KEYS_RULE,
    );
    assertRefused(body([id(1)], { accessKeys: { constructor: key(1) } }), 1014, ACCESS_KEYS_RULE);
    assertRefused(
      body([id(1)], { accessKeys: { [id(1)]: key(1), [id(2)]: key(2) } }),
      1014,
      ACCESS_KEYS_RULE,
    );
  });

  it('names both keys a body may hold in the refusal of any other (D253, #227 criterion 7)', () => {
    assert.equal(
      KEYS_RULE,
      'The request body may contain no key other than "ids" and "accessKeys"',
    );
    assert.equal(
      ACCESS_KEYS_RULE,
      'accessKeys must map ids from ids to access keys: 43 characters of A-Z, a-z, 0-9, _ and -',
    );
  });

  it('is checked after every rule of ids, and before an unknown key', () => {
    assertRefused(body([], { accessKeys: 1 }), 1014, IDS_RULE);
    assertRefused(body(['bad'], { accessKeys: 1 }), 1014, ID_RULE);
    assertRefused(body([id(1), id(1)], { accessKeys: 1 }), 1014, REPEATED_ID_RULE);
    assertRefused(body([id(1)], { accessKeys: 1, other: 1 }), 1014, ACCESS_KEYS_RULE);
    assertRefused(body([id(1)], { accessKeys: {}, other: 1 }), 1014, KEYS_RULE);
  });

  it('never quotes an id or a key in its message (D106)', () => {
    const secret = 'Qx7Zv9Kp2Wj4Ym8Hb3Nf6Rt1Lc5Dg0Uw8Ej2Sa7Io4P';

    for (const rawBody of [
      body([id(1)], { accessKeys: { [id(1)]: `${secret}x` } }),
      body([id(1)], { accessKeys: { [secret]: key(1) } }),
      body([id(1)], { accessKeys: { [id(1)]: secret.slice(0, 20) } }),
      body([secret], { accessKeys: { [secret]: secret, [id(1)]: secret } }),
    ]) {
      const message = refusal(rawBody).message;

      assert.ok(!message.includes(secret.slice(0, 8)), message);
      assert.ok(!message.includes(secret.slice(-8)), message);
    }
  });
});

describe('parseStatusBody: 1006 for a body that is not a JSON object', () => {
  const MESSAGE = 'Request body must be a JSON object';

  for (const [description, rawBody] of [
    ['no body at all', undefined],
    ['an empty body', ''],
    ['a body that does not parse', '{"ids":'],
    ['a JSON array', `["${id(1)}"]`],
    ['a JSON string', `"${id(1)}"`],
    ['a JSON number', '50'],
    ['JSON null', 'null'],
    ['a byte order mark before the object', `\ufeff{"ids":["${id(1)}"]}`],
  ] as const) {
    it(`refuses ${description}`, () => {
      assertRefused(rawBody, 1006, MESSAGE);
    });
  }
});

describe('parseStatusBody: 1014 for ids that break a rule', () => {
  const cases: [string, string, string][] = [
    ['a missing ids key', '{}', IDS_RULE],
    ['ids that is not an array', body(id(1)), IDS_RULE],
    ['ids that is an object', body({ 0: id(1) }), IDS_RULE],
    ['ids that is null', body(null), IDS_RULE],
    ['no ids at all', body([]), IDS_RULE],
    ['51 ids', body(ids(51)), IDS_RULE],
    ['an id that is not a string', body([42]), ID_RULE],
    ['an id that is null', body([null]), ID_RULE],
    ['an id that is an array', body([[id(1)]]), ID_RULE],
    ['an id of 42 characters', body([id(1).slice(1)]), ID_RULE],
    ['an id of 44 characters', body([`${id(1)}x`]), ID_RULE],
    ['an id with a dot', body([`${id(1).slice(1)}.`]), ID_RULE],
    ['an id with a space', body([` ${id(1).slice(1)}`]), ID_RULE],
    ['an id with a trailing line break', body([`${id(1)}\n`]), ID_RULE],
    ['an id with a letter outside ASCII', body([`${id(1).slice(1)}ж`]), ID_RULE],
    ['an id with a percent escape', body([`%41${id(1).slice(3)}`]), ID_RULE],
    ['an empty string', body(['']), ID_RULE],
    ['the same id twice', body([id(1), id(2), id(1)]), REPEATED_ID_RULE],
    ['a key other than ids', body([id(1)], { state: 'active' }), KEYS_RULE],
    ['a __proto__ key', `{"ids":["${id(1)}"],"__proto__":{}}`, KEYS_RULE],
  ];

  for (const [description, rawBody, message] of cases) {
    it(`refuses ${description}`, () => {
      assertRefused(rawBody, 1014, message);
    });
  }

  it('reports the number of ids before an entry, an entry before a repeat, and a repeat before an unknown key', () => {
    assertRefused(body([...ids(50), 'bad']), 1014, IDS_RULE);
    assertRefused(body([id(1), id(1), 'bad']), 1014, ID_RULE);
    assertRefused(body([id(1), id(1)], { other: 1 }), 1014, REPEATED_ID_RULE);
    assertRefused(body(['bad'], { other: 1 }), 1014, ID_RULE);
  });

  it('never quotes an id, a key or a value in its message (D106)', () => {
    const secret = 'Qx7Zv9Kp2Wj4Ym8Hb3Nf6Rt1Lc5Dg0Uw8Ej2Sa7Io4P';

    assert.equal(secret.length, 43);

    for (const rawBody of [
      body([`${secret}x`]),
      body([secret, secret]),
      body([secret], { [secret]: secret }),
      body([...Array.from({ length: 51 }, () => secret)]),
      body([secret.slice(0, 20)]),
    ]) {
      const message = refusal(rawBody).message;

      assert.ok(!message.includes(secret.slice(0, 8)), message);
      assert.ok(!message.includes(secret.slice(-8)), message);
    }
  });
});

describe('parseStatusBody: hostile bodies up to the body limit', () => {
  const SIZES = [1024, 64 * 1024, MAX_BODY_BYTES];
  /** Generous for a body the size of the limit; a regression to quadratic time is seconds. */
  const LIMIT_MS = 1000;

  function answered(rawBody: string): AppError | StatusBody {
    const started = performance.now();
    let outcome: AppError | StatusBody;

    try {
      outcome = parseStatusBody(rawBody);
    } catch (error) {
      assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);
      assert.ok(error.errorCode === 1006 || error.errorCode === 1014);
      outcome = error;
    }

    const elapsed = performance.now() - started;

    assert.ok(elapsed < LIMIT_MS, `${elapsed.toFixed(1)} ms for ${rawBody.length} characters`);

    return outcome;
  }

  function refusedWith(rawBody: string, errorCode: number): void {
    const outcome = answered(rawBody);

    assert.ok(outcome instanceof AppError, 'the body was accepted');
    assert.equal(outcome.errorCode, errorCode);
  }

  for (const size of SIZES) {
    it(`refuses one id of ${size} characters without quoting it`, () => {
      refusedWith(body(['a'.repeat(size)]), 1014);
      refusedWith(body([`${id(1)}${'a'.repeat(size)}`]), 1014);
      refusedWith(body(['ж'.repeat(size / 2)]), 1014);
      refusedWith(body(['😀'.repeat(size / 4)]), 1014);
      refusedWith(`{"ids":["${'\\ud800'.repeat(size / 6)}"]}`, 1014);
    });

    it(`refuses ${size} bytes of ids by their number, before reading one`, () => {
      refusedWith(
        body(Array.from({ length: Math.max(51, Math.floor(size / 46)) }, (_, n) => id(n))),
        1014,
      );
      refusedWith(body(Array.from({ length: size / 2 }, () => 0)), 1014);
      refusedWith(`{"ids":[${'[],'.repeat(size / 3)}[]]}`, 1014);
    });

    it(`refuses 50 copies of one id inside ${size} bytes of padding`, () => {
      const padding = ' '.repeat(size / 2);

      refusedWith(
        `{"ids":[${padding}${Array.from({ length: 50 }, () => `"${id(1)}"`).join(',')}]}`,
        1014,
      );
    });

    it(`answers ${size} bytes of nesting`, () => {
      const depth = size / 2;

      // An array is not an object, however deep; the parser may also give up.
      refusedWith('['.repeat(depth) + ']'.repeat(depth), 1006);
      // Nested inside `ids`, it is one entry that is not an id, unless the
      // parser gives up on the depth first.
      answered(`{"ids":[${'['.repeat(depth)}${']'.repeat(depth)}]}`);
      answered(`{"ids":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}}`);
    });

    it(`refuses ${size} bytes of unknown keys beside valid ids`, () => {
      const keys = Array.from({ length: size / 12 }, (_, n) => `"k${n}":1`).join(',');

      refusedWith(`{"ids":["${id(1)}"],${keys}}`, 1014);
      refusedWith(`{${keys},"ids":["${id(1)}"]}`, 1014);
      refusedWith(`{"ids":["${id(1)}"],"${'k'.repeat(size)}":1}`, 1014);
    });

    it(`accepts valid ids inside ${size} bytes of whitespace`, () => {
      const outcome = answered(
        `${' '.repeat(size / 2)}{"ids":["${id(1)}"]}${'\n'.repeat(size / 2)}`,
      );

      assert.ok(!(outcome instanceof AppError));
      assert.deepEqual(outcome.ids, [id(1)]);
    });

    it(`refuses ${size} bytes of accessKeys beside valid ids`, () => {
      const names = Array.from({ length: size / 60 }, (_, n) => `"${id(n)}":"${key(n)}"`).join(',');

      // More names than ids: refused at the second, whatever follows.
      refusedWith(`{"ids":["${id(0)}"],"accessKeys":{${names}}}`, 1014);
      refusedWith(`{"ids":["${id(0)}"],"accessKeys":{"${id(0)}":"${'a'.repeat(size)}"}}`, 1014);
      refusedWith(`{"ids":["${id(0)}"],"accessKeys":{"${'n'.repeat(size)}":"${key(0)}"}}`, 1014);
      refusedWith(`{"ids":["${id(0)}"],"accessKeys":[${'"x",'.repeat(size / 4)}"x"]}`, 1014);
      refusedWith(
        `{"ids":["${id(0)}"],"accessKeys":{"${id(0)}":"${'\\ud800'.repeat(size / 6)}"}}`,
        1014,
      );
      answered(
        `{"ids":["${id(0)}"],"accessKeys":${'{"a":'.repeat(size / 5)}1${'}'.repeat(size / 5)}}`,
      );
    });

    it(`accepts a key beside its id inside ${size} bytes of whitespace`, () => {
      const outcome = answered(
        `{"ids":["${id(1)}"],"accessKeys":{${' '.repeat(size / 2)}"${id(1)}":"${key(1)}"}}`,
      );

      assert.ok(!(outcome instanceof AppError));
      assert.equal(outcome.accessKeys.get(id(1)), key(1));
    });

    it(`refuses ${size} bytes that never close`, () => {
      refusedWith(`{"ids":["${'a'.repeat(size)}`, 1006);
      refusedWith('{"ids":['.repeat(size / 8), 1006);
      refusedWith(`{"ids":["${id(1)}"]}${'x'.repeat(size)}`, 1006);
      refusedWith('\u0000'.repeat(size), 1006);
    });
  }

  it('accepts the largest valid body: 50 ids, each escaped at six bytes a character', () => {
    const escaped = (value: string) =>
      [...value]
        .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .join('');
    const outcome = answered(
      `{"ids":[${ids(50)
        .map((one) => `"${escaped(one)}"`)
        .join(',')}]}`,
    );

    assert.ok(!(outcome instanceof AppError));
    assert.deepEqual(outcome.ids, ids(50));
  });

  it('accepts the largest valid body with keys: 50 ids and 50 keys, escaped at six bytes a character', () => {
    const escaped = (value: string) =>
      [...value]
        .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .join('');
    const outcome = answered(
      `{"ids":[${ids(50)
        .map((one) => `"${escaped(one)}"`)
        .join(',')}],"accessKeys":{${ids(50)
        .map((one, n) => `"${escaped(one)}":"${escaped(key(n))}"`)
        .join(',')}}}`,
    );

    assert.ok(!(outcome instanceof AppError));
    assert.equal(outcome.accessKeys.size, 50);
    assert.equal(outcome.accessKeys.get(id(49)), key(49));
  });
});
