/**
 * The access-key check and how each transport hands it a key (D245, issue
 * #98), without a server: the fingerprint, the constant-time comparison, the
 * `Authorization` header, the socket's subprotocols, and made-up headers at
 * growing sizes; and, over a stand-in pool, which statements each check sends
 * and that the session's read sends nothing more before its key has opened it.
 */
import assert from 'node:assert/strict';
import crypto, { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { describe, it, mock } from 'node:test';
import {
  OLD_REALTIME_ACCESS_KEY_PROTOCOL_PREFIX,
  OLD_REALTIME_PROTOCOL,
  REALTIME_ACCESS_KEY_PROTOCOL_PREFIX,
  REALTIME_PROTOCOL,
} from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import { withinBound } from '../../testing/timing.ts';
import {
  bearerKey,
  chooseProtocol,
  creationKey,
  FINGERPRINT_BYTES,
  fingerprintOf,
  isKeyProtocol,
  KEY_PROTOCOL_PREFIXES,
  MAX_AUTHORIZATION_LENGTH,
  openSessions,
  opens,
  protocolKey,
  requireAccess,
  SESSION_ACCESS_SQL,
  sessionAccess,
} from './access-key.ts';
import { getSessionDetails } from './service.ts';

const KEY = 'Qx7Zv9Kp2Wj4Ym8Hb3Nf6Rt1Lc5Dg0Uw8Ej2Sa7Io4P';
const OTHER = 'Zz7Zv9Kp2Wj4Ym8Hb3Nf6Rt1Lc5Dg0Uw8Ej2Sa7Io4P';
const OLDER_SHAPE = 'Au6JqVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2m_-MKss';

/**
 * Milliseconds the fastest of up to five runs (`withinBound`, D203) of one
 * check of `protocolKey` may take on a made-up header of 1 MiB: 350. Until
 * #419 it was 100, as at the smaller sizes still, and loaded runs of the
 * backend suite took a check over it now and then with nothing wrong
 * (F-32): the header of 1,048,576 commas, whose 1,048,577 empty names take
 * 29 to 41 ms at best of five alone and up to 174 ms beside the full backend
 * suite and eight busy loops. 350 is about twice that. A `protocolKey`
 * quadratic in the names offered took 903 ms and more alone on the 104,858
 * names of `many`, 2.6 times the bound and more - the cheapest form measured
 * takes each name off the front of the list `split` made, with `shift()`:
 * over the bound on every run.
 */
const PROTOCOL_KEY_MIB_BOUND_MS = 350;

/**
 * Milliseconds the fastest of up to five runs of one check of
 * `chooseProtocol` may take on a made-up handshake of 1 MiB, its 32,768 names
 * offered under the service's prefix: 45, the set each check is given built
 * before its runs. Until #419 it was 100, the set of the second built in its
 * runs. They take 3 to 7 ms at best of five alone and up to 22 ms loaded as
 * above: 45 is about twice that. The cheapest quadratic form measured takes
 * each name off the front of a list of them, with `shift()` again, and took
 * 82 ms and more alone, 1.8 times the bound: over it on every run, where
 * neither 100 nor `PROTOCOL_KEY_MIB_BOUND_MS` tells it apart.
 */
const CHOOSE_PROTOCOL_MIB_BOUND_MS = 45;

describe('fingerprintOf', () => {
  it('is the SHA-256 digest of the key, 32 bytes, and not the key', () => {
    const fingerprint = fingerprintOf(KEY);

    assert.equal(fingerprint.length, FINGERPRINT_BYTES);
    assert.deepEqual(fingerprint, createHash('sha256').update(KEY).digest());
    assert.ok(!fingerprint.toString('latin1').includes(KEY.slice(0, 8)));
  });
});

describe('opens: the one check', () => {
  it('opens a public session to every caller, whatever it sends', () => {
    for (const key of [null, KEY, OTHER, OLDER_SHAPE]) {
      assert.equal(opens(null, key), true);
    }
  });

  it('opens a keyed session to its own key alone', () => {
    const fingerprint = fingerprintOf(KEY);

    assert.equal(opens(fingerprint, KEY), true);
    assert.equal(opens(fingerprint, null), false);
    assert.equal(opens(fingerprint, OTHER), false);
    assert.equal(opens(fingerprint, KEY.toLowerCase()), false);
    assert.equal(opens(fingerprintOf(OLDER_SHAPE), OLDER_SHAPE), true);
  });

  it('opens nothing for a value of any shape but a key, even one whose digest it holds', () => {
    for (const value of [
      '',
      'short',
      `${KEY}x`,
      ` ${KEY.slice(1)}`,
      `Bearer ${KEY}`,
      'ж'.repeat(43),
    ]) {
      assert.equal(opens(fingerprintOf(value), value), false, JSON.stringify(value));
    }
  });

  it('opens nothing for a fingerprint of the wrong length, the key itself included', () => {
    assert.equal(opens(Buffer.alloc(0), KEY), false);
    assert.equal(opens(Buffer.from(KEY), KEY), false);
    assert.equal(opens(fingerprintOf(KEY).subarray(0, 31), KEY), false);
    assert.equal(opens(Buffer.concat([fingerprintOf(KEY), Buffer.alloc(1)]), KEY), false);
  });

  it('compares the digests with timingSafeEqual, never with an early exit', () => {
    const compare = mock.method(crypto, 'timingSafeEqual');

    // The check imports the named export, which follows the module object
    // only once the builtin's exports are synced.
    syncBuiltinESMExports();

    try {
      assert.equal(opens(fingerprintOf(KEY), OTHER), false);
      assert.equal(opens(fingerprintOf(KEY), KEY), true);
    } finally {
      compare.mock.restore();
      syncBuiltinESMExports();
    }

    assert.equal(compare.mock.callCount(), 2);

    for (const call of compare.mock.calls) {
      const [a, b] = call.arguments as [Buffer, Buffer];

      assert.equal(a.length, FINGERPRINT_BYTES);
      assert.equal(b.length, FINGERPRINT_BYTES);
    }
  });
});

describe('bearerKey: Authorization on the API and /mcp', () => {
  it('reads Bearer and the key, the scheme in any letter case, one or more spaces', () => {
    assert.equal(bearerKey(`Bearer ${KEY}`), KEY);
    assert.equal(bearerKey(`bearer ${KEY}`), KEY);
    assert.equal(bearerKey(`BEARER ${KEY}`), KEY);
    assert.equal(bearerKey(`Bearer   ${KEY}`), KEY);
    assert.equal(bearerKey(`Bearer ${OLDER_SHAPE}`), OLDER_SHAPE);
  });

  const none: [string, string | string[] | undefined][] = [
    ['no header', undefined],
    ['an array', [`Bearer ${KEY}`]],
    ['an empty value', ''],
    ['an empty Bearer', 'Bearer'],
    ['Bearer and a space', 'Bearer '],
    ['the key alone', KEY],
    ['another scheme', `Basic ${KEY}`],
    ['a scheme run into the key', `Bearer${KEY}`],
    ['a tab for the space', `Bearer\t${KEY}`],
    ['a key of 42 characters', `Bearer ${KEY.slice(1)}`],
    ['a key of 44 characters', `Bearer ${KEY}x`],
    ['a key with padding', `Bearer ${KEY}=`],
    ['a key with a dot', `Bearer ${KEY.slice(1)}.`],
    ['a key with a slash or a plus', `Bearer ${KEY.slice(2)}/+`],
    ['two keys', `Bearer ${KEY} ${OTHER}`],
    ['two keys with a comma', `Bearer ${KEY}, Bearer ${OTHER}`],
    ['a key outside ASCII', `Bearer ${KEY.slice(1)}ж`],
    ['a line break', `Bearer ${KEY}\n`],
    ['a leading space', ` Bearer ${KEY}`],
    ['the key quoted', `Bearer "${KEY}"`],
  ];

  for (const [description, header] of none) {
    it(`carries no key in ${description}`, () => {
      assert.equal(bearerKey(header), null);
    });
  }

  it(`reads nothing of a value over ${MAX_AUTHORIZATION_LENGTH} characters`, () => {
    const spaced = `Bearer${' '.repeat(MAX_AUTHORIZATION_LENGTH - 6 - KEY.length)}${KEY}`;

    assert.equal(spaced.length, MAX_AUTHORIZATION_LENGTH);
    assert.equal(bearerKey(spaced), KEY);
    assert.equal(bearerKey(`Bearer ${' '.repeat(MAX_AUTHORIZATION_LENGTH)}${KEY}`), null);
  });

  for (const size of [1024, 16 * 1024, 64 * 1024, 1024 * 1024]) {
    it(`answers made-up values of ${size} characters at once, with no key`, () => {
      const values = [
        `Bearer ${'a'.repeat(size)}`,
        `Bearer ${' '.repeat(size)}x`,
        `Bearer ${' '.repeat(size)}${KEY}`,
        `${'Bearer '.repeat(size / 7)}${KEY}`,
        `Bearer ${KEY.repeat(size / 43)}`,
        'B'.repeat(size),
        '\u0000'.repeat(size),
        'ж'.repeat(size),
      ];

      for (const value of values) {
        assert.equal(
          withinBound(50, () => bearerKey(value)),
          null,
        );
      }
    });
  }
});

describe('creationKey: what a private creation is asked to be keyed by (D253)', () => {
  it('draws a key when there is no header at all', () => {
    assert.deepEqual(creationKey(undefined), { kind: 'draw' });
  });

  it('takes the key Bearer carries, in any letter case, of either shape, never drawn by the server', () => {
    assert.deepEqual(creationKey(`Bearer ${KEY}`), { kind: 'given', key: KEY });
    assert.deepEqual(creationKey(`bEARER   ${KEY}`), { kind: 'given', key: KEY });
    assert.deepEqual(creationKey(`Bearer ${OLDER_SHAPE}`), { kind: 'given', key: OLDER_SHAPE });
  });

  it('answers none, never a drawn key, for a header that carries no key - an empty one included', () => {
    for (const header of [
      '',
      'Bearer',
      'Bearer ',
      `Basic ${KEY}`,
      `Bearer ${KEY.slice(1)}`,
      `Bearer ${KEY}x`,
      `Bearer ${KEY.slice(1)}ж`,
      `Bearer\t${KEY}`,
      `Bearer ${' '.repeat(MAX_AUTHORIZATION_LENGTH)}${KEY}`,
      [`Bearer ${KEY}`],
    ]) {
      assert.deepEqual(creationKey(header), { kind: 'none' }, JSON.stringify(header));
    }
  });

  for (const size of [1024, 16 * 1024, 64 * 1024, 1024 * 1024]) {
    it(`answers made-up headers of ${size} characters at once, as none`, () => {
      for (const value of [
        `Bearer ${'a'.repeat(size)}`,
        `Bearer ${' '.repeat(size)}${KEY}`,
        `${'Bearer '.repeat(size / 7)}${KEY}`,
        'ж'.repeat(size),
      ]) {
        assert.deepEqual(
          withinBound(50, () => creationKey(value)),
          { kind: 'none' },
        );
      }
    });
  }
});

describe('protocolKey: the subprotocol the socket presents the key in', () => {
  const carrying = (key: string) => `${REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${key}`;

  it('reads the key from the one subprotocol that carries it, wherever it stands', () => {
    assert.equal(protocolKey(carrying(KEY)), KEY);
    assert.equal(protocolKey(`${REALTIME_PROTOCOL}, ${carrying(KEY)}`), KEY);
    assert.equal(protocolKey(`${carrying(KEY)},${REALTIME_PROTOCOL}`), KEY);
    assert.equal(protocolKey(`chat, ${carrying(OLDER_SHAPE)}, ${REALTIME_PROTOCOL}`), OLDER_SHAPE);
  });

  const none: [string, string | string[] | undefined][] = [
    ['no header', undefined],
    ['an array', [carrying(KEY)]],
    ['an empty value', ''],
    ['the protocol alone', REALTIME_PROTOCOL],
    ['the bare key', KEY],
    ['the prefix with no key', REALTIME_ACCESS_KEY_PROTOCOL_PREFIX],
    ['a key of 42 characters', carrying(KEY.slice(1))],
    ['a key of 44 characters', carrying(`${KEY}x`)],
    ['a key with a dot', carrying(`${KEY.slice(1)}.`)],
    ['two keys', `${carrying(KEY)}, ${carrying(OTHER)}`],
    ['the same key twice', `${carrying(KEY)}, ${carrying(KEY)}`],
    ['a prefix in another letter case', `QA-TOOLS.ACCESS-KEY.${KEY}`],
    ['the new prefix in another letter case', `WEBHOOK-INSPECTOR.ACCESS-KEY.${KEY}`],
    ['a prefix without its dot', `qa-tools.access-key${KEY}`],
    ['the new prefix without its dot', `webhook-inspector.access-key${KEY}`],
  ];

  for (const [description, header] of none) {
    it(`carries no key in ${description}`, () => {
      assert.equal(protocolKey(header), null);
    });
  }

  for (const size of [1024, 16 * 1024, 64 * 1024, 1024 * 1024]) {
    it(`answers made-up headers of ${size} characters at once`, () => {
      const many = Array.from({ length: size / 10 }, (_, n) => `p${n}`).join(', ');
      const keys = Array.from({ length: size / 64 }, () => carrying(KEY)).join(',');
      const bound = size === 1024 * 1024 ? PROTOCOL_KEY_MIB_BOUND_MS : 100;

      assert.equal(
        withinBound(bound, () => protocolKey(`${many}, ${carrying(KEY)}`)),
        KEY,
      );
      assert.equal(
        withinBound(bound, () => protocolKey(keys)),
        null,
      );
      assert.equal(
        withinBound(bound, () => protocolKey(','.repeat(size))),
        null,
      );
      assert.equal(
        withinBound(bound, () => protocolKey(carrying('a'.repeat(size)))),
        null,
      );
      assert.equal(
        withinBound(bound, () => protocolKey(' '.repeat(size))),
        null,
      );
    });
  }
});

/**
 * The names under the service's name beside the old ones (#334, D279): a key
 * under either prefix, or under both when they carry the same one, as the
 * page offers it until the old names stop; and made-up handshakes built to
 * break the reading - letter case, both prefixes with different keys,
 * repeated and empty entries, an over-long or malformed key under the new
 * prefix, many protocols offered - at growing sizes.
 */
describe('protocolKey and chooseProtocol under both names (D279)', () => {
  const NEW = REALTIME_ACCESS_KEY_PROTOCOL_PREFIX;
  const OLD = OLD_REALTIME_ACCESS_KEY_PROTOCOL_PREFIX;

  it('are the service’s name, and the old one beside it', () => {
    assert.equal(REALTIME_PROTOCOL, 'webhook-inspector');
    assert.equal(NEW, 'webhook-inspector.access-key.');
    assert.equal(OLD_REALTIME_PROTOCOL, 'qa-tools');
    assert.equal(OLD, 'qa-tools.access-key.');
    assert.deepEqual(KEY_PROTOCOL_PREFIXES, [NEW, OLD]);
  });

  it('read the key under either prefix, or under both carrying the same key, in either order', () => {
    for (const header of [
      `${OLD}${KEY}`,
      `${NEW}${KEY}`,
      `${OLD_REALTIME_PROTOCOL}, ${OLD}${KEY}`,
      `${REALTIME_PROTOCOL}, ${NEW}${KEY}`,
      `${REALTIME_PROTOCOL}, ${NEW}${KEY}, ${OLD}${KEY}`,
      `${OLD}${KEY}, ${NEW}${KEY}`,
      `${OLD}${KEY},${REALTIME_PROTOCOL},${NEW}${KEY}`,
      `chat, ${OLD_REALTIME_PROTOCOL}, ${REALTIME_PROTOCOL}, ${NEW}${KEY}`,
    ]) {
      assert.equal(protocolKey(header), KEY, header);
    }

    assert.equal(protocolKey(`${NEW}${OLDER_SHAPE}, ${OLD}${OLDER_SHAPE}`), OLDER_SHAPE);
  });

  const none: [string, string][] = [
    ['both prefixes with different keys', `${NEW}${KEY}, ${OLD}${OTHER}`],
    ['both prefixes with different keys, the old first', `${OLD}${KEY}, ${NEW}${OTHER}`],
    ['the new prefix twice', `${NEW}${KEY}, ${NEW}${KEY}`],
    ['the new prefix twice with different keys', `${NEW}${KEY}, ${NEW}${OTHER}`],
    ['the new prefix twice beside the old', `${NEW}${KEY}, ${OLD}${KEY}, ${NEW}${KEY}`],
    ['the old prefix twice beside the new', `${OLD}${KEY}, ${NEW}${KEY}, ${OLD}${KEY}`],
    ['a key under the new prefix and a malformed one under the old', `${NEW}${KEY}, ${OLD}${KEY}x`],
    ['a malformed key under the new prefix and a key under the old', `${NEW}${KEY}.,${OLD}${KEY}`],
    ['the new prefix with no key', NEW],
    ['both prefixes with no key', `${NEW}, ${OLD}`],
    ['a key of 42 characters under the new prefix', `${NEW}${KEY.slice(1)}`],
    ['a key of 44 characters under the new prefix', `${NEW}${KEY}x`],
    ['a key with a space under the new prefix', `${NEW}${KEY.slice(1)} x`],
    ['a key of non-ASCII letters under the new prefix', `${NEW}${'ж'.repeat(43)}`],
    ['a key in another letter case beside its prefix in another', `${NEW.toUpperCase()}${KEY}`],
    ['the old prefix nested in the new', `${NEW}${OLD}${KEY}`],
    ['the new prefix nested in the old', `${OLD}${NEW}${KEY}`],
    ['the name of either protocol alone', `${REALTIME_PROTOCOL}, ${OLD_REALTIME_PROTOCOL}`],
    ['empty entries only', ', ,,'],
  ];

  for (const [description, header] of none) {
    it(`carry no key in ${description}`, () => {
      assert.equal(protocolKey(header), null);
    });
  }

  it('read a key beside empty and repeated entries that carry none', () => {
    assert.equal(protocolKey(`,${NEW}${KEY},, ${REALTIME_PROTOCOL},${REALTIME_PROTOCOL},`), KEY);
  });

  it('echo the first name offered that carries no key, under either name, as the client offered it', () => {
    assert.equal(chooseProtocol(new Set([REALTIME_PROTOCOL, `${NEW}${KEY}`])), REALTIME_PROTOCOL);
    assert.equal(
      chooseProtocol(new Set([OLD_REALTIME_PROTOCOL, `${OLD}${KEY}`])),
      OLD_REALTIME_PROTOCOL,
    );
    assert.equal(
      chooseProtocol(new Set([`${NEW}${KEY}`, `${OLD}${KEY}`, OLD_REALTIME_PROTOCOL])),
      OLD_REALTIME_PROTOCOL,
    );
    assert.equal(
      chooseProtocol(new Set([OLD_REALTIME_PROTOCOL, REALTIME_PROTOCOL])),
      OLD_REALTIME_PROTOCOL,
    );
  });

  it('never echo a name under either exact prefix, a key or not', () => {
    for (const offered of [
      [`${NEW}${KEY}`],
      [`${OLD}${KEY}`],
      [`${NEW}${KEY}`, `${OLD}${KEY}`],
      [NEW, OLD],
      [NEW],
      [OLD],
      [`${NEW}x`, `${OLD}x`],
      [`${NEW}${NEW.toUpperCase()}`],
      [`${OLD}${OLD.toUpperCase()}${KEY}`],
      [`${NEW}${'a'.repeat(1000)}`],
    ]) {
      assert.equal(chooseProtocol(new Set(offered)), false, JSON.stringify(offered));
    }

    // A name that only begins like a prefix, without its dot, carries no key
    // and is echoed as any other name is.
    assert.equal(
      chooseProtocol(new Set(['webhook-inspector.access-key'])),
      'webhook-inspector.access-key',
    );
    assert.equal(chooseProtocol(new Set(['qa-tools.access-key'])), 'qa-tools.access-key');
    assert.equal(isKeyProtocol(`${NEW}${KEY}`), true);
    assert.equal(isKeyProtocol(`${OLD}${KEY}`), true);
    assert.equal(isKeyProtocol(NEW), true);
    assert.equal(isKeyProtocol(OLD), true);
  });

  /**
   * Every name that is one of the two prefixes with a single letter's case
   * turned, then a remainder: what a hand-made client mistyping the prefix
   * offers. Each carries no key, since the prefixes are compared exactly
   * (D245), and is answered as before 1.19.0 (#356).
   */
  const turnedOnce = (prefix: string, rest: string): string[] =>
    [...prefix].flatMap((letter, at) =>
      letter.toUpperCase() === letter
        ? []
        : [`${prefix.slice(0, at)}${letter.toUpperCase()}${prefix.slice(at + 1)}${rest}`],
    );

  it('echo a name starting with either prefix in another letter case, which carries no key, as before 1.19.0 (#356)', () => {
    const mistyped = [
      'Webhook-Inspector.Access-Key.x',
      'QA-TOOLS.ACCESS-KEY.x',
      `${NEW.toUpperCase()}${KEY}`,
      `${OLD.toUpperCase()}${KEY}`,
      `Webhook-Inspector.Access-Key.${KEY}`,
      `Qa-Tools.Access-Key.${KEY}`,
      NEW.toUpperCase(),
      'Qa-Tools.Access-Key.',
      `${NEW.toUpperCase()}${NEW}${KEY}`,
      // What the lowering of 1.19.0 read as a prefix: the Kelvin sign, U+212A,
      // lowers to `k`.
      `webhook-inspector.access-\u212Aey.${KEY}`,
      `qa-tools.access-\u212Aey.${KEY}`,
      ...turnedOnce(NEW, KEY),
      ...turnedOnce(OLD, KEY),
      ...turnedOnce(NEW, ''),
      ...turnedOnce(OLD, ''),
    ];

    assert.equal(turnedOnce(NEW, '').length, 25);
    assert.equal(turnedOnce(OLD, '').length, 16);

    for (const name of mistyped) {
      assert.equal(isKeyProtocol(name), false, name);
      assert.equal(protocolKey(name), null, name);
      assert.equal(chooseProtocol(new Set([name])), name, name);
      assert.equal(chooseProtocol(new Set([name, REALTIME_PROTOCOL])), name, name);
      // After a name that carries a key, it is the first that carries none.
      assert.equal(chooseProtocol(new Set([`${NEW}${KEY}`, name])), name, name);
      assert.equal(chooseProtocol(new Set([`${OLD}${KEY}`, `${NEW}${KEY}`, name])), name, name);
    }

    assert.equal(
      chooseProtocol(
        new Set([`Webhook-Inspector.Access-Key.${KEY}`, `QA-Tools.Access-Key.${KEY}`]),
      ),
      `Webhook-Inspector.Access-Key.${KEY}`,
    );
    assert.equal(
      chooseProtocol(new Set([REALTIME_PROTOCOL, `QA-TOOLS.ACCESS-KEY.${KEY}`])),
      REALTIME_PROTOCOL,
    );
    // Such a name beside the key under an exact prefix: the key is read and
    // never echoed, the mistyped name is answered.
    assert.equal(protocolKey(`QA-TOOLS.ACCESS-KEY.x, ${NEW}${KEY}`), KEY);
    assert.equal(
      chooseProtocol(new Set(['QA-TOOLS.ACCESS-KEY.x', `${NEW}${KEY}`])),
      'QA-TOOLS.ACCESS-KEY.x',
    );
  });

  for (const size of [1024, 16 * 1024, 64 * 1024, 1024 * 1024]) {
    it(`answer made-up handshakes of ${size} characters under both prefixes at once`, () => {
      const many = Array.from({ length: size / 10 }, (_, n) => `p${n}`).join(', ');
      const both = `${NEW}${KEY}, ${OLD}${KEY}`;
      const keys = Array.from({ length: size / 64 }, (_, n) =>
        n % 2 === 0 ? `${NEW}${KEY}` : `${OLD}${KEY}`,
      ).join(',');
      const offered = new Set(Array.from({ length: size / 32 }, (_, n) => `${NEW}${n}`));
      const withProtocol = new Set([...offered, REALTIME_PROTOCOL]);
      const keyBound = size === 1024 * 1024 ? PROTOCOL_KEY_MIB_BOUND_MS : 100;
      const choiceBound = size === 1024 * 1024 ? CHOOSE_PROTOCOL_MIB_BOUND_MS : 100;

      assert.equal(
        withinBound(keyBound, () => protocolKey(`${many}, ${both}`)),
        KEY,
      );
      assert.equal(
        withinBound(keyBound, () => protocolKey(keys)),
        null,
      );
      assert.equal(
        withinBound(keyBound, () => protocolKey(`${NEW}${'a'.repeat(size)}, ${OLD}${KEY}`)),
        null,
      );
      assert.equal(
        withinBound(keyBound, () => protocolKey(`${NEW.repeat(size / NEW.length)}${KEY}`)),
        null,
      );
      assert.equal(
        withinBound(keyBound, () => protocolKey(`${','.repeat(size)}${NEW}${KEY}`)),
        KEY,
      );
      assert.equal(
        withinBound(choiceBound, () => chooseProtocol(offered)),
        false,
      );
      assert.equal(
        withinBound(choiceBound, () => chooseProtocol(withProtocol)),
        REALTIME_PROTOCOL,
      );
    });

    it(`answer a name in another letter case among made-up offers of ${size} characters at once (#356)`, () => {
      const offered = new Set(Array.from({ length: size / 32 }, (_, n) => `${NEW}${n}`));
      const long = `${NEW.toUpperCase()}${'a'.repeat(size)}`;
      const turned = new Set(
        Array.from({ length: size / 32 }, (_, n) => `${n % 2 === 0 ? NEW : OLD}${n}`.toUpperCase()),
      );
      // Each input built before its runs, so that a run times the check alone
      // and not the set or the header it is given (#419, F-32).
      const withLong = new Set([...offered, long]);
      const longFirst = new Set([long, ...offered]);
      const withMistyped = new Set([...offered, 'Qa-Tools.Access-Key.x']);
      const twoLong = new Set([`${OLD}${'A'.repeat(size)}`, long]);
      const header = `${long}, ${[...turned].join(', ')}`;

      assert.equal(
        withinBound(100, () => chooseProtocol(withLong)),
        long,
      );
      assert.equal(
        withinBound(100, () => chooseProtocol(longFirst)),
        long,
      );
      assert.equal(
        withinBound(100, () => chooseProtocol(withMistyped)),
        'Qa-Tools.Access-Key.x',
      );
      assert.equal(
        withinBound(100, () => chooseProtocol(turned)),
        `${NEW}0`.toUpperCase(),
      );
      assert.equal(
        withinBound(100, () => chooseProtocol(twoLong)),
        long,
      );
      assert.equal(
        withinBound(100, () => protocolKey(header)),
        null,
      );
    });
  }
});

describe('chooseProtocol: the subprotocol the handshake answers with', () => {
  it('answers none when none was offered, as before keys', () => {
    assert.equal(chooseProtocol(new Set()), false);
  });

  it('answers the first offered, as ws did before keys, when none carries a key', () => {
    assert.equal(chooseProtocol(new Set(['chat', REALTIME_PROTOCOL])), 'chat');
    assert.equal(chooseProtocol(new Set([REALTIME_PROTOCOL])), REALTIME_PROTOCOL);
  });

  it('never answers the subprotocol that carries the key', () => {
    const carrying = `${REALTIME_ACCESS_KEY_PROTOCOL_PREFIX}${KEY}`;

    assert.equal(isKeyProtocol(carrying), true);
    assert.equal(chooseProtocol(new Set([carrying, REALTIME_PROTOCOL])), REALTIME_PROTOCOL);
    assert.equal(chooseProtocol(new Set([REALTIME_PROTOCOL, carrying])), REALTIME_PROTOCOL);
    assert.equal(chooseProtocol(new Set([carrying])), false);
    assert.equal(chooseProtocol(new Set([REALTIME_ACCESS_KEY_PROTOCOL_PREFIX])), false);
  });
});

/** A pool that answers the fingerprint read with `rows`, and records what it was asked. */
function poolAnswering(rows: { id?: string; access_key_hash: Buffer | null; expired?: boolean }[]) {
  const asked: { text: string; values: unknown[] }[] = [];

  return {
    asked,
    pool: {
      query: async (text: string, values: unknown[]) => {
        asked.push({ text, values });

        return { rows };
      },
    },
  };
}

describe('requireAccess: the check before a statement of its own', () => {
  it('lets a public session through with any key or none', async () => {
    for (const key of [null, KEY]) {
      const { pool, asked } = poolAnswering([{ access_key_hash: null }]);

      await requireAccess(pool as never, 'S'.repeat(43), key);
      assert.equal(asked.length, 1);
      assert.deepEqual(asked[0]?.values, ['S'.repeat(43)]);
    }
  });

  it('lets a keyed session through with its key alone', async () => {
    const { pool } = poolAnswering([{ access_key_hash: fingerprintOf(KEY) }]);

    await requireAccess(pool as never, 'S'.repeat(43), KEY);
  });

  it('answers a keyed session refused and a missing one alike, 404 / 1001, after one statement each', async () => {
    const answers: unknown[] = [];

    for (const [rows, key] of [
      [[{ access_key_hash: fingerprintOf(KEY) }], null],
      [[{ access_key_hash: fingerprintOf(KEY) }], OTHER],
      [[], null],
      [[], KEY],
    ] as const) {
      const { pool, asked } = poolAnswering([...rows]);

      await assert.rejects(requireAccess(pool as never, 'S'.repeat(43), key), (error) => {
        assert.ok(error instanceof AppError);
        answers.push({
          status: error.statusCode,
          code: error.errorCode,
          message: error.message,
          headers: error.headers,
        });

        return true;
      });
      assert.equal(asked.length, 1);
    }

    assert.deepEqual(
      answers,
      Array.from({ length: 4 }, () => answers[0]),
    );
    assert.deepEqual(answers[0], {
      status: 404,
      code: 1001,
      message: 'Session not found',
      headers: {},
    });
  });
});

describe('sessionAccess: the check before the session is read, for its read and the socket', () => {
  it('reads the fingerprint and the expiry and nothing else, by the id alone', () => {
    assert.match(
      SESSION_ACCESS_SQL,
      /^SELECT access_key_hash, expires_at <= clock_timestamp\(\) AS expired\s+FROM sessions\s+WHERE id = \$1$/,
    );
    assert.doesNotMatch(SESSION_ACCESS_SQL, /response|queue|\*/);
  });

  it('finds a public session active or expired, whatever key is sent', async () => {
    for (const key of [null, KEY]) {
      for (const expired of [false, true]) {
        const { pool, asked } = poolAnswering([{ access_key_hash: null, expired }]);

        assert.equal(
          await sessionAccess(pool as never, 'S'.repeat(43), key),
          expired ? 'expired' : 'active',
        );
        assert.deepEqual(asked, [{ text: SESSION_ACCESS_SQL, values: ['S'.repeat(43)] }]);
      }
    }
  });

  it('finds a keyed session active or expired with its key alone', async () => {
    for (const expired of [false, true]) {
      const { pool } = poolAnswering([{ access_key_hash: fingerprintOf(KEY), expired }]);

      assert.equal(
        await sessionAccess(pool as never, 'S'.repeat(43), KEY),
        expired ? 'expired' : 'active',
      );
    }
  });

  it('answers a keyed session refused, expired or not, and a missing one alike, after the same one statement', async () => {
    for (const [rows, key] of [
      [[{ access_key_hash: fingerprintOf(KEY), expired: false }], null],
      [[{ access_key_hash: fingerprintOf(KEY), expired: false }], OTHER],
      [[{ access_key_hash: fingerprintOf(KEY), expired: true }], null],
      [[{ access_key_hash: fingerprintOf(KEY), expired: true }], OTHER],
      [[], null],
      [[], KEY],
    ] as const) {
      const { pool, asked } = poolAnswering([...rows]);

      assert.equal(await sessionAccess(pool as never, 'S'.repeat(43), key), 'missing');
      assert.deepEqual(asked, [{ text: SESSION_ACCESS_SQL, values: ['S'.repeat(43)] }]);
    }
  });
});

/**
 * A pool for `getSessionDetails`: `access` answers the check's statement,
 * `whole` the read of the session after it, and any other statement fails,
 * so a test sees how far the call went.
 */
function poolForDetails(
  access: { access_key_hash: Buffer | null; expired: boolean }[],
  whole: unknown[],
) {
  const asked: string[] = [];

  return {
    asked,
    pool: {
      query: async (text: string) => {
        asked.push(text);

        if (text === SESSION_ACCESS_SQL) {
          return { rows: access };
        }

        if (asked.length === 2 && /\bFROM sessions\b/.test(text)) {
          return { rows: whole };
        }

        throw new Error(`Not expected here: ${text}`);
      },
    },
  };
}

/** The status and code `getSessionDetails` was refused with. */
async function detailsRefusal(
  pool: unknown,
  key: string | null,
): Promise<{ status: number; code: number }> {
  try {
    await getSessionDetails(pool as never, 'S'.repeat(43), undefined, key);
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));

    return { status: error.statusCode, code: error.errorCode };
  }

  throw new Error('The session was read');
}

describe('getSessionDetails: the check before the whole read (criterion 8)', () => {
  it('refuses a keyed session without its key, expired or not, as a missing one, before the session is read', async () => {
    for (const [access, key] of [
      [[{ access_key_hash: fingerprintOf(KEY), expired: false }], null],
      [[{ access_key_hash: fingerprintOf(KEY), expired: false }], OTHER],
      [[{ access_key_hash: fingerprintOf(KEY), expired: true }], OTHER],
      [[], KEY],
    ] as const) {
      const { pool, asked } = poolForDetails([...access], []);

      assert.deepEqual(await detailsRefusal(pool, key), { status: 404, code: 1001 });
      assert.deepEqual(asked, [SESSION_ACCESS_SQL]);
    }
  });

  it('answers an expired session its key opens 410, before the session is read', async () => {
    const { pool, asked } = poolForDetails(
      [{ access_key_hash: fingerprintOf(KEY), expired: true }],
      [],
    );

    assert.deepEqual(await detailsRefusal(pool, KEY), { status: 410, code: 1002 });
    assert.deepEqual(asked, [SESSION_ACCESS_SQL]);
  });

  it('answers a session deleted between the check and the read as missing', async () => {
    const { pool, asked } = poolForDetails(
      [{ access_key_hash: fingerprintOf(KEY), expired: false }],
      [],
    );

    assert.deepEqual(await detailsRefusal(pool, KEY), { status: 404, code: 1001 });
    assert.equal(asked.length, 2);
  });
});

describe('openSessions: the check for the status read', () => {
  it('answers the ids found open: public ones, and keyed ones whose own key was given', async () => {
    const { pool, asked } = poolAnswering([
      { id: 'public', access_key_hash: null },
      { id: 'keyed', access_key_hash: fingerprintOf(KEY) },
      { id: 'other', access_key_hash: fingerprintOf(OTHER) },
      { id: 'unasked', access_key_hash: fingerprintOf(KEY) },
    ]);
    const keys = new Map([
      ['public', OTHER],
      ['keyed', KEY],
      ['other', KEY],
    ]);

    const open = await openSessions(
      pool as never,
      ['public', 'keyed', 'other', 'unasked', 'missing'],
      (id) => keys.get(id) ?? null,
    );

    assert.deepEqual([...open].sort(), ['keyed', 'public']);
    assert.equal(asked.length, 1);
  });
});
